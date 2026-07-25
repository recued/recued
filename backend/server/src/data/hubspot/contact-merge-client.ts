/** D-138 P5 — HubSpot contact-merge client.
 *
 *  Implements `VendorMergeClient` for `hubspot:contact`. Fires `POST
 *  /crm/v3/objects/contacts/merge` per the HubSpot Merge API docs:
 *
 *    request body : { primaryObjectId: <survivor>, objectIdToMerge: <loser> }
 *    on success   : 200 + merged record body (we keep the body for the
 *                   audit trail but don't act on it)
 *    on failure   : 4xx with categorized error code (`OBJECT_NOT_FOUND`,
 *                   `INVALID_INPUT`, …) — terminal failures shouldn't
 *                   retry; 5xx is retryable
 *
 *  Idempotency: HubSpot honors the `Idempotency-Key` header on the
 *  merge endpoint per their docs; we send the outbox row's
 *  idempotency_key so duplicate dispatches collapse onto the same
 *  upstream operation.
 *
 *  Auth: same `oauth2_refresh` shape as the search helper — single-
 *  shot 401 refresh through the connection adapter's refresh hook.
 *  401 after refresh surfaces as a terminal failure (vendor auth
 *  expired; user needs to reconnect).
 *
 *  Spec: D-138 § A.7 + § Phase 5. */

import {
  HUBSPOT_API_BASE,
  resolveBearerAccessToken,
  type ConnectionAuth,
  type ConnectionRecord,
  type UpstreamMergeError,
  type UpstreamMergeFieldOutcome,
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

export interface HubSpotMergeDeps {
  fetcher?: typeof fetch;
  refreshAuth: (connection: ConnectionRecord) => Promise<ConnectionAuth>;
  now?: () => number;
}

/** HubSpot-documented per-field merge rule: most-recent value wins
 *  (where the timestamp comes from `lastmodifieddate` / `hs_lastmodifieddate`
 *  per property). This client returns `winner: 'unknown'` when both
 *  records have null/missing values + when the per-field timestamps
 *  aren't available; the modal renders an honest "vendor decides" hint
 *  in those cases. */
const FIELDS_TO_PREVIEW = ['email', 'firstname', 'lastname', 'phone', 'company'];

// ────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────

const HUBSPOT_CONTACT_MERGE_URL = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/merge`;

const HUBSPOT_VENDOR_SEMANTICS_SUMMARY =
  'HubSpot will absorb contact A into contact B. All deals, engagements, notes, and custom properties from A move to B. A is deleted in HubSpot. This cannot be undone. Per-field rule: HubSpot keeps the most-recently modified value of each property.';

// Auth-type-agnostic (see `_hubspot-search.ts`): the connection layer's
// resolver yields the bearer token for both `oauth2_refresh` and a static
// `bearer` (HubSpot Service Key). Absent ⇒ null (this client's no-token path).
const readAccessToken = (auth: ConnectionAuth): string | null =>
  resolveBearerAccessToken(auth) ?? null;

const safeReadJson = async (response: Response): Promise<Record<string, unknown> | null> => {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
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

const fetchHubSpotContact = async (
  fetcher: typeof fetch,
  authRefreshed: { value: boolean },
  connection: ConnectionRecord,
  contactId: string,
  refreshAuth: HubSpotMergeDeps['refreshAuth'],
): Promise<{ ok: true; record: Record<string, unknown> } | { ok: false; error: UpstreamMergeError }> => {
  let auth = connection.auth;
  for (;;) {
    const accessToken = readAccessToken(auth);
    if (accessToken === null) {
      return {
        ok: false,
        error: {
          code: 'vendor_auth_expired',
          message: `HubSpot connection '${connection.name}' is missing a current access token`,
        },
      };
    }
    const url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${FIELDS_TO_PREVIEW.join(',')}`;
    const response = await fetcher(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      const body = (await safeReadJson(response)) ?? {};
      return { ok: true, record: body };
    }
    if (response.status === 401 && !authRefreshed.value) {
      authRefreshed.value = true;
      auth = await refreshAuth(connection);
      continue;
    }
    if (response.status === 404) {
      return {
        ok: false,
        error: {
          code: 'vendor_record_not_found',
          message: `HubSpot contact ${contactId} not found`,
          http_status: 404,
        },
      };
    }
    const body = await safeReadText(response);
    return {
      ok: false,
      error: {
        code: response.status === 401 ? 'vendor_auth_expired' : 'vendor_http_error',
        message: `HubSpot fetch failed: ${response.status}`,
        http_status: response.status,
        vendor_detail: truncate(body, 512),
      },
    };
  }
};

/** Per-field rule application — picks `'survivor'` when survivor's
 *  `hs_lastmodifieddate >= loser's`, `'loser'` otherwise. Returns
 *  `'unknown'` when the timestamp comparison can't run (missing
 *  property on either side). */
const projectFieldOutcomes = (
  survivor: Record<string, unknown>,
  loser: Record<string, unknown>,
): UpstreamMergeFieldOutcome[] => {
  const survivorProps =
    (survivor.properties as Record<string, unknown> | undefined) ?? {};
  const loserProps = (loser.properties as Record<string, unknown> | undefined) ?? {};
  const survivorMod = Number(survivorProps.hs_lastmodifieddate ?? 0);
  const loserMod = Number(loserProps.hs_lastmodifieddate ?? 0);
  const winner: UpstreamMergeFieldOutcome['winner'] = !Number.isFinite(survivorMod) || !Number.isFinite(loserMod) || (survivorMod === 0 && loserMod === 0)
    ? 'unknown'
    : survivorMod >= loserMod
      ? 'survivor'
      : 'loser';
  const out: UpstreamMergeFieldOutcome[] = [];
  for (const field of FIELDS_TO_PREVIEW) {
    const sValue = survivorProps[field];
    const lValue = loserProps[field];
    if (sValue === undefined && lValue === undefined) continue;
    out.push({
      field,
      survivor_value: sValue,
      loser_value: lValue,
      winner,
      reason: winner === 'unknown'
        ? 'HubSpot decides at merge time (most-recent property update wins)'
        : 'HubSpot keeps the value from the more recently modified record',
    });
  }
  return out;
};

export const createHubSpotContactMergeClient = (
  deps: HubSpotMergeDeps,
): VendorMergeClient => {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);
  const refreshAuth = deps.refreshAuth;

  return {
    object_type: 'hubspot:contact',
    describe: async (
      connection: ConnectionRecord,
      pair: UpstreamMergeVendorPair,
    ): Promise<VendorMergePreview> => {
      const authRefreshed = { value: false };
      const survivor = await fetchHubSpotContact(
        fetcher,
        authRefreshed,
        connection,
        pair.survivor_platform_id,
        refreshAuth,
      );
      const loser = await fetchHubSpotContact(
        fetcher,
        authRefreshed,
        connection,
        pair.loser_platform_id,
        refreshAuth,
      );

      // Best-effort preview — describe never fails the request; if the
      // fetch errored we surface an empty field-outcomes list + the
      // semantics summary so the modal still renders something useful.
      const field_outcomes =
        survivor.ok && loser.ok
          ? projectFieldOutcomes(survivor.record, loser.record)
          : [];
      const survivor_last_modified =
        survivor.ok
          ? String(
              (survivor.record.properties as Record<string, unknown> | undefined)?.[
                'hs_lastmodifieddate'
              ] ?? '',
            ) || undefined
          : undefined;
      const loser_last_modified =
        loser.ok
          ? String(
              (loser.record.properties as Record<string, unknown> | undefined)?.[
                'hs_lastmodifieddate'
              ] ?? '',
            ) || undefined
          : undefined;
      return {
        field_outcomes,
        vendor_semantics_summary: HUBSPOT_VENDOR_SEMANTICS_SUMMARY,
        dispatchable: true,
        ...(survivor_last_modified !== undefined ? { survivor_last_modified } : {}),
        ...(loser_last_modified !== undefined ? { loser_last_modified } : {}),
      };
    },

    merge: async (
      connection: ConnectionRecord,
      pair: UpstreamMergeVendorPair,
      idempotency_key: string,
    ): Promise<VendorMergeResult> => {
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
              message: `HubSpot connection '${connection.name}' is missing a current access token`,
            },
          };
        }
        const response = await fetcher(HUBSPOT_CONTACT_MERGE_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotency_key,
          },
          body: JSON.stringify({
            primaryObjectId: pair.survivor_platform_id,
            objectIdToMerge: pair.loser_platform_id,
          }),
        });

        if (response.ok) {
          const vendor_response = (await safeReadJson(response)) ?? {};
          return { ok: true, vendor_response };
        }

        if (response.status === 401 && !authRefreshed) {
          authRefreshed = true;
          auth = await refreshAuth(connection);
          continue;
        }

        const body = await safeReadText(response);
        // 4xx other than 429 — terminal (HubSpot's documented merge
        // endpoint failures: bad input, missing record, permission).
        // 5xx + 429 — retryable.
        const retryable =
          response.status >= 500 || response.status === 429 || response.status === 408;
        const code = response.status === 401
          ? 'vendor_auth_expired'
          : response.status === 404
            ? 'vendor_record_not_found'
            : response.status === 429
              ? 'vendor_rate_limited'
              : retryable
                ? 'vendor_http_5xx'
                : 'vendor_invalid_request';
        return {
          ok: false,
          retryable,
          error: {
            code,
            message: `HubSpot merge failed: ${response.status}`,
            http_status: response.status,
            vendor_detail: truncate(body, 512),
          },
        };
      }
    },
  };
};
