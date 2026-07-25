/** D-138 P5 — Salesforce SOAP merge() client.
 *
 *  Implements `VendorMergeClient` for `salesforce:lead` and
 *  `salesforce:account`. Salesforce exposes `merge()` only via SOAP
 *  Partner WSDL (no REST equivalent at API v60.0). One client backs
 *  both entity types; the `entity` config selects the SObject xsi:type
 *  in the envelope.
 *
 *  Envelope shape (Partner WSDL):
 *
 *    <urn:merge>
 *      <urn:request>
 *        <urn:masterRecord xsi:type="<Entity>">
 *          <Id>{master_id}</Id>
 *        </urn:masterRecord>
 *        <urn:recordToMergeIds>{victim_id}</urn:recordToMergeIds>
 *      </urn:request>
 *    </urn:merge>
 *
 *  Response shape: `<mergeResponse><result><success>true</success>
 *  <id>{master_id}</id></result></mergeResponse>` on success;
 *  `<success>false</success>` + `<errors><statusCode>...` on failure.
 *
 *  Idempotency: SOAP doesn't have an idempotency-key header; we send
 *  it in a custom `<urn:CallOptions><urn:client>recued:<key></urn:client>`
 *  header for log-trail purposes. Salesforce's merge() is idempotent
 *  on the master + victim pair by construction (a record already
 *  merged returns `INVALID_FIELD_FOR_INSERT_UPDATE` we recognize as
 *  terminal-success-equivalent — already-merged is fine).
 *
 *  Spec: `docs/d-138-spec.md` § A.7 + § Phase 5. */

import {
  SALESFORCE_SOAP_PARTNER_PATH,
  resolveBearerAccessToken,
  type ConnectionAuth,
  type ConnectionRecord,
  type UpstreamMergeError,
  type UpstreamMergeFieldOutcome,
  type UpstreamMergeObjectType,
  type UpstreamMergeVendorPair,
} from '@recued/contracts';

import type {
  VendorMergeClient,
  VendorMergePreview,
  VendorMergeResult,
} from '../vendor-merge.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export interface SalesforceMergeDeps {
  fetcher?: typeof fetch;
  refreshAuth: (connection: ConnectionRecord) => Promise<ConnectionAuth>;
  now?: () => number;
}

/** Salesforce sObject names per object_type. Salesforce SOAP wants
 *  the case-correct WSDL name. */
const SOBJECT_NAME: Record<'salesforce:lead' | 'salesforce:account', string> = {
  'salesforce:lead': 'Lead',
  'salesforce:account': 'Account',
};

const SF_SEMANTICS_SUMMARY: Record<'salesforce:lead' | 'salesforce:account', string> = {
  'salesforce:lead':
    'Salesforce will merge the loser Lead into the survivor. All activities, attachments, notes, and child records move to the survivor. The loser Lead is deleted. Field-level merge rules vary by Salesforce configuration; per-field winning value is decided by Salesforce at merge time.',
  'salesforce:account':
    'Salesforce will merge the loser Account into the survivor. All child Contacts, Opportunities, Cases, and notes move to the survivor. The loser Account is deleted. Field-level merge rules vary by Salesforce configuration; per-field winning value is decided by Salesforce at merge time.',
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// Auth-type-agnostic (see `_salesforce-search.ts`): the connection-layer seam
// yields the bearer token for both `oauth2_refresh` and a static `bearer`.
const readAccessToken = (auth: ConnectionAuth): string | null =>
  resolveBearerAccessToken(auth) ?? null;

const readBaseUrl = (connection: ConnectionRecord): string | null => {
  const base = connection.config.base_url;
  if (typeof base !== 'string' || base.length === 0) return null;
  return base.replace(/\/$/, '');
};

const safeReadText = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return '';
  }
};

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

const buildMergeEnvelope = (
  sessionId: string,
  sObjectType: string,
  masterId: string,
  victimId: string,
  idempotency_key: string,
): string => {
  const xmlSession = escapeXml(sessionId);
  const xmlMaster = escapeXml(masterId);
  const xmlVictim = escapeXml(victimId);
  const xmlClient = escapeXml(`recued:${idempotency_key}`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '  xmlns:urn="urn:partner.soap.sforce.com">',
    '  <soapenv:Header>',
    '    <urn:SessionHeader>',
    `      <urn:sessionId>${xmlSession}</urn:sessionId>`,
    '    </urn:SessionHeader>',
    '    <urn:CallOptions>',
    `      <urn:client>${xmlClient}</urn:client>`,
    '    </urn:CallOptions>',
    '  </soapenv:Header>',
    '  <soapenv:Body>',
    '    <urn:merge>',
    '      <urn:request>',
    `        <urn:masterRecord xsi:type="urn1:${escapeXml(sObjectType)}" xmlns:urn1="urn:sobject.partner.soap.sforce.com">`,
    `          <Id xmlns="urn:sobject.partner.soap.sforce.com">${xmlMaster}</Id>`,
    '        </urn:masterRecord>',
    `        <urn:recordToMergeIds>${xmlVictim}</urn:recordToMergeIds>`,
    '      </urn:request>',
    '    </urn:merge>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
};

/** Detect SOAP Fault — Salesforce returns 200 with a Fault element on
 *  some app-level errors. */
const isSoapFault = (body: string): boolean =>
  /<soapenv:Fault\b/i.test(body) || /<faultstring\b/i.test(body);

/** Parse the merge response. Returns null on no result element. */
const parseMergeResult = (
  body: string,
): { success: boolean; status_code?: string; message?: string } | null => {
  const successMatch = body.match(/<success>(true|false)<\/success>/i);
  if (!successMatch) return null;
  const success = successMatch[1] === 'true';
  if (success) return { success: true };
  const statusCode = body.match(/<statusCode>([^<]*)<\/statusCode>/i)?.[1];
  const message = body.match(/<message>([^<]*)<\/message>/i)?.[1];
  return {
    success: false,
    ...(statusCode !== undefined ? { status_code: statusCode } : {}),
    ...(message !== undefined ? { message } : {}),
  };
};

const SF_TERMINAL_STATUS_CODES = new Set([
  'INVALID_TYPE',
  'INVALID_ID_FIELD',
  'INVALID_CROSS_REFERENCE_KEY',
  'MALFORMED_ID',
  'ENTITY_IS_DELETED',
  'INSUFFICIENT_ACCESS',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'FIELD_INTEGRITY_EXCEPTION',
]);

/** Salesforce returns `success: false` + `INVALID_CROSS_REFERENCE_KEY`
 *  when a victim id is already merged elsewhere. We treat that as a
 *  terminal "vendor already in expected post-merge state" rather than
 *  a retryable error — the user surface explains "this pair is already
 *  merged in Salesforce". */

// ────────────────────────────────────────────────────────────────
// Client factory
// ────────────────────────────────────────────────────────────────

export const createSalesforceMergeClient = (
  object_type: 'salesforce:lead' | 'salesforce:account',
  deps: SalesforceMergeDeps,
): VendorMergeClient => {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);
  const refreshAuth = deps.refreshAuth;
  const sObjectType = SOBJECT_NAME[object_type];

  const buildSemanticsSummary = (): string => SF_SEMANTICS_SUMMARY[object_type];

  return {
    object_type: object_type as UpstreamMergeObjectType,
    describe: async (
      _connection: ConnectionRecord,
      _pair: UpstreamMergeVendorPair,
    ): Promise<VendorMergePreview> => {
      // Salesforce per-field merge semantics aren't documented as a
      // stable contract — the safest preview is "vendor decides" with
      // empty per-field outcomes. The modal still surfaces the
      // semantics summary so the user knows what's happening.
      const field_outcomes: UpstreamMergeFieldOutcome[] = [];
      return {
        field_outcomes,
        vendor_semantics_summary: buildSemanticsSummary(),
        dispatchable: true,
      };
    },

    merge: async (
      connection: ConnectionRecord,
      pair: UpstreamMergeVendorPair,
      idempotency_key: string,
    ): Promise<VendorMergeResult> => {
      const baseUrl = readBaseUrl(connection);
      if (baseUrl === null) {
        return {
          ok: false,
          retryable: false,
          error: {
            code: 'vendor_config_invalid',
            message: `Salesforce connection '${connection.name}' is missing a base_url (instance_url not propagated)`,
          },
        };
      }
      const url = `${baseUrl}${SALESFORCE_SOAP_PARTNER_PATH}`;

      let auth = connection.auth;
      let authRefreshed = false;

      for (;;) {
        const accessToken = readAccessToken(auth);
        if (accessToken === null) {
          return {
            ok: false,
            retryable: false,
            error: {
              code: 'vendor_auth_expired',
              message: `Salesforce connection '${connection.name}' is missing a current access token`,
            },
          };
        }
        const envelope = buildMergeEnvelope(
          accessToken,
          sObjectType,
          pair.survivor_platform_id,
          pair.loser_platform_id,
          idempotency_key,
        );
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: '""',
            Accept: 'text/xml',
          },
          body: envelope,
        });

        const body = await safeReadText(response);

        // 401 Auth refresh — single shot.
        if (response.status === 401 && !authRefreshed) {
          authRefreshed = true;
          auth = await refreshAuth(connection);
          continue;
        }

        if (response.ok && !isSoapFault(body)) {
          const result = parseMergeResult(body);
          if (result === null) {
            // No result element + no Fault — surface as retryable
            // (transient parser miss; the call may have succeeded but
            // we can't confirm).
            return {
              ok: false,
              retryable: true,
              error: {
                code: 'vendor_response_unparseable',
                message: 'Salesforce SOAP merge response carried no <result> element',
                http_status: response.status,
                vendor_detail: truncate(body, 512),
              },
            };
          }
          if (result.success) {
            return {
              ok: true,
              vendor_response: { success: true, master_id: pair.survivor_platform_id },
            };
          }
          // App-level failure — terminal vs retryable based on status code.
          const status_code = result.status_code ?? 'UNKNOWN';
          const retryable =
            !SF_TERMINAL_STATUS_CODES.has(status_code) &&
            status_code !== 'INVALID_FIELD_FOR_INSERT_UPDATE';
          const error: UpstreamMergeError = {
            code: `salesforce_merge_${status_code.toLowerCase()}`,
            message: result.message ?? `Salesforce merge() returned ${status_code}`,
            http_status: response.status,
            vendor_detail: truncate(body, 512),
          };
          return retryable
            ? { ok: false, retryable: true, error }
            : { ok: false, retryable: false, error };
        }

        // Fault / non-2xx.
        const retryable = response.status >= 500 || response.status === 429;
        return {
          ok: false,
          retryable,
          error: {
            code: response.status === 401
              ? 'vendor_auth_expired'
              : retryable
                ? 'vendor_http_5xx'
                : 'vendor_http_error',
            message: `Salesforce SOAP merge failed: ${response.status}`,
            http_status: response.status,
            vendor_detail: truncate(body, 512),
          },
        };
      }
    },
  };
};
