/** D-130 Phase 5.2 — Salesforce PushTopic SOAP auto-creation.
 *
 *  Salesforce's CometD Streaming API delivers events on `/topic/<Name>`
 *  channels backed by per-org PushTopic SObjects. Each PushTopic
 *  carries a `Query` (the SOQL projection events deliver), an
 *  `ApiVersion` pin, and four `NotifyForOperation*` flags
 *  (Create / Update / Delete / Undelete) plus a `NotifyForFields`
 *  policy. PushTopics are per-org metadata Recued installs once at
 *  first connection enrollment.
 *
 *  This module owns the one-time PushTopic provisioning step:
 *
 *    1. SOQL the org's existing PushTopics by canonical name (cheap —
 *       one REST call regardless of trio cardinality).
 *    2. For every Recued PushTopic name that's missing, SOAP-create
 *       it via the Partner endpoint. The SOAP envelope carries a
 *       single `<sObjects xsi:type="PushTopic">` block with the
 *       canonical Query + Notify-flag set.
 *    3. Surface `{ created: string[]; existed: string[] }` so the
 *       caller (bin.ts boot wire) can log the divergence cheaply.
 *
 *  Idempotency invariants:
 *    - Existing PushTopics are NEVER updated. Salesforce permits
 *      `update()` against PushTopic, but every Recued field is
 *      stable across releases (the Query is derived from the
 *      canonical-fields constant, the API version is the hard pin,
 *      the Notify-flag set is uniform). If the user manually edits
 *      a PushTopic Recued created, Recued's posture is "trust the
 *      user's edit until they delete + re-enroll" — same precedent
 *      as the connection-delete-leaves-PushTopics decision (P5
 *      close memo § decision 5).
 *    - Re-enrollment under the same connection name finds the
 *      PushTopics still present and short-circuits the SOAP path.
 *      Documented in internal design notes (P5.2).
 *
 *  Spec: D-130 § A.4 + § Phase 5. */

import {
  SALESFORCE_ACCOUNT_FIELDS,
  SALESFORCE_API_VERSION,
  SALESFORCE_CONTACT_FIELDS,
  SALESFORCE_ENTITY_NAMES,
  SALESFORCE_OPPORTUNITY_FIELDS,
  SALESFORCE_PUSHTOPIC_API_VERSION,
  SALESFORCE_PUSHTOPIC_NAMES,
  SALESFORCE_SOAP_PARTNER_PATH,
  // D-139 P1b — engagement PushTopic constants
  SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES,
  SALESFORCE_ENGAGEMENT_SOBJECT_NAMES,
  SALESFORCE_TASK_FIELDS,
  SALESFORCE_EVENT_FIELDS,
  SALESFORCE_EMAIL_MESSAGE_FIELDS,
  SALESFORCE_VOICE_CALL_FIELDS,
  SALESFORCE_CALL_HISTORY_FIELDS,
  SALESFORCE_TASK_RELATION_FIELDS,
  SALESFORCE_EVENT_RELATION_FIELDS,
  SALESFORCE_EMAIL_MESSAGE_RELATION_FIELDS,
  type ConnectionAuth,
  type ConnectionRecord,
  type SalesforceEntityName,
  type SalesforceEngagementEntityName,
  type SalesforceRelationshipEntityName,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────

/** Thrown when SOQL listing of existing PushTopics returns a non-OK
 *  status the caller can't recover from (anything other than 401 →
 *  refresh, which the helper handles internally). */
export class SalesforcePushTopicListError extends Error {
  readonly code = 'SALESFORCE_PUSHTOPIC_LIST_ERROR';
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Salesforce PushTopic list failed: ${status} ${truncate(body, 200)}`);
    this.name = 'SalesforcePushTopicListError';
    this.status = status;
  }
}

/** Thrown when SOAP create fails with a non-OK status or with a SOAP
 *  Fault envelope. Salesforce's SOAP layer returns 500 with a Fault
 *  body for application errors (e.g. permission denied, duplicate
 *  name), and the helper inspects the body to surface the error
 *  code via the message. */
export class SalesforcePushTopicCreateError extends Error {
  readonly code = 'SALESFORCE_PUSHTOPIC_CREATE_ERROR';
  readonly status: number;
  readonly pushTopicName: string;
  constructor(pushTopicName: string, status: number, body: string) {
    super(
      `Salesforce PushTopic create failed for '${pushTopicName}': ${status} ${truncate(body, 200)}`,
    );
    this.name = 'SalesforcePushTopicCreateError';
    this.status = status;
    this.pushTopicName = pushTopicName;
  }
}

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** Result of an `ensurePushTopics` call. */
export interface EnsurePushTopicsResult {
  /** PushTopic names that already existed in the org and were
   *  short-circuited. */
  existed: ReadonlyArray<string>;
  /** PushTopic names that were SOAP-created in this call. */
  created: ReadonlyArray<string>;
}

/** Caller-supplied dependencies — pluggable for tests. */
export interface SalesforcePushTopicDeps {
  /** HTTP fetcher. Defaults to `globalThis.fetch`. Tests inject a
   *  per-call stub that records URLs + method + body for assertions. */
  fetcher?: typeof fetch;
  /** OAuth2 single-flight refresh hook — invoked on 401 from either
   *  the SOQL list or the SOAP create. Mirrors the search-helper
   *  contract; the boot wire passes the same `refreshApiConnectionAuth`
   *  callback used elsewhere. */
  refreshAuth: (connection: ConnectionRecord) => Promise<ConnectionAuth>;
}

// ────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────

/** Ensure the canonical Recued PushTopics exist on the user's org.
 *  Idempotent — re-running the call after the first enrollment
 *  short-circuits via the SOQL existence check. Surfaces the
 *  created / existed split so the caller can log without
 *  recomputing. */
export const ensurePushTopics = async (
  connection: ConnectionRecord,
  deps: SalesforcePushTopicDeps,
): Promise<EnsurePushTopicsResult> => {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);
  const baseUrl = readBaseUrl(connection);
  const wantedNames = SALESFORCE_ENTITY_NAMES.map(
    (entity) => SALESFORCE_PUSHTOPIC_NAMES[entity],
  );

  // Step 1 — SOQL the org's existing PushTopics.
  const existing = await listExistingPushTopicNames(
    connection,
    baseUrl,
    wantedNames,
    fetcher,
    deps.refreshAuth,
  );

  // Step 2 — SOAP-create the missing ones.
  const missing = wantedNames.filter((name) => !existing.has(name));
  const created: string[] = [];
  for (const name of missing) {
    const entity = entityForPushTopicName(name);
    if (entity === null) continue; // Defensive — wantedNames is a closed list.
    await soapCreatePushTopic(connection, baseUrl, entity, fetcher, deps.refreshAuth);
    created.push(name);
  }

  return {
    existed: wantedNames.filter((name) => existing.has(name)),
    created,
  };
};

/** D-139 P1b — ensure engagement PushTopics exist for the given
 *  per-(connection, entity) capability set. Caller passes the closed
 *  list of entities the probe found queryable + PushTopic-streamable;
 *  the helper SOQL-list checks existing + SOAP-creates the missing.
 *  Same idempotency invariants as the CRM-trio variant — re-running
 *  short-circuits cleanly. */
export const ensureEngagementPushTopics = async (
  connection: ConnectionRecord,
  entities: ReadonlyArray<
    SalesforceEngagementEntityName | SalesforceRelationshipEntityName
  >,
  deps: SalesforcePushTopicDeps,
): Promise<EnsurePushTopicsResult> => {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);
  const baseUrl = readBaseUrl(connection);
  const wantedNames = entities.map(
    (entity) => SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES[entity],
  );

  const existing = await listExistingPushTopicNames(
    connection,
    baseUrl,
    wantedNames,
    fetcher,
    deps.refreshAuth,
  );

  const missing = wantedNames.filter((name) => !existing.has(name));
  const created: string[] = [];
  for (const name of missing) {
    const entity = engagementEntityForPushTopicName(name);
    if (entity === null) continue;
    await soapCreateEngagementPushTopic(
      connection,
      baseUrl,
      entity,
      fetcher,
      deps.refreshAuth,
    );
    created.push(name);
  }

  return {
    existed: wantedNames.filter((name) => existing.has(name)),
    created,
  };
};

// ────────────────────────────────────────────────────────────────
// Step 1 — SOQL existence check
// ────────────────────────────────────────────────────────────────

const listExistingPushTopicNames = async (
  connection: ConnectionRecord,
  baseUrl: string,
  wantedNames: ReadonlyArray<string>,
  fetcher: typeof fetch,
  refreshAuth: (c: ConnectionRecord) => Promise<ConnectionAuth>,
): Promise<Set<string>> => {
  const inList = wantedNames.map((n) => `'${escapeSoqlString(n)}'`).join(',');
  const soql = `SELECT Id, Name FROM PushTopic WHERE Name IN (${inList})`;
  const path = `/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const url = `${baseUrl}${path}`;

  let auth = connection.auth;
  let refreshed = false;

  while (true) {
    const accessToken = readAccessToken(auth, connection.name);
    const response = await fetcher(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (response.ok) {
      const body = (await response.json()) as {
        records?: ReadonlyArray<{ Name?: unknown }>;
      };
      const out = new Set<string>();
      for (const r of body.records ?? []) {
        if (typeof r.Name === 'string') out.add(r.Name);
      }
      return out;
    }

    if (response.status === 401 && !refreshed) {
      refreshed = true;
      auth = await refreshAuth({ ...connection, auth });
      continue;
    }

    const errBody = await safeReadText(response);
    throw new SalesforcePushTopicListError(response.status, errBody);
  }
};

// ────────────────────────────────────────────────────────────────
// Step 2 — SOAP create
// ────────────────────────────────────────────────────────────────

const soapCreatePushTopic = async (
  connection: ConnectionRecord,
  baseUrl: string,
  entity: SalesforceEntityName,
  fetcher: typeof fetch,
  refreshAuth: (c: ConnectionRecord) => Promise<ConnectionAuth>,
): Promise<void> => {
  const url = `${baseUrl}${SALESFORCE_SOAP_PARTNER_PATH}`;
  const pushTopicName = SALESFORCE_PUSHTOPIC_NAMES[entity];

  let auth = connection.auth;
  let refreshed = false;

  while (true) {
    const accessToken = readAccessToken(auth, connection.name);
    const envelope = buildCreateEnvelope(accessToken, entity);
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '""',
        Accept: 'text/xml',
      },
      body: envelope,
    });

    if (response.status === 401 && !refreshed) {
      refreshed = true;
      auth = await refreshAuth({ ...connection, auth });
      continue;
    }

    const body = await safeReadText(response);

    // Salesforce SOAP returns 200 + Fault envelope for app-level
    // errors; surface a Fault even on 200.
    if (response.ok && !isSoapFault(body) && isCreateSuccess(body)) {
      return;
    }

    throw new SalesforcePushTopicCreateError(
      pushTopicName,
      response.status,
      body,
    );
  }
};

/** Construct the Partner-API SOAP envelope for a `create()` call
 *  against a single PushTopic SObject. Format mirrors Salesforce
 *  Partner WSDL specification:
 *
 *    <soapenv:Envelope ...>
 *      <soapenv:Header>
 *        <urn:SessionHeader><urn:sessionId>...</urn:sessionId></urn:SessionHeader>
 *      </soapenv:Header>
 *      <soapenv:Body>
 *        <urn:create>
 *          <urn:sObjects xsi:type="PushTopic">
 *            <Name>...</Name>
 *            <Query>SELECT ... FROM ...</Query>
 *            <ApiVersion>60.0</ApiVersion>
 *            <NotifyForOperationCreate>true</NotifyForOperationCreate>
 *            <NotifyForOperationUpdate>true</NotifyForOperationUpdate>
 *            <NotifyForOperationDelete>true</NotifyForOperationDelete>
 *            <NotifyForOperationUndelete>true</NotifyForOperationUndelete>
 *            <NotifyForFields>Referenced</NotifyForFields>
 *          </urn:sObjects>
 *        </urn:create>
 *      </soapenv:Body>
 *    </soapenv:Envelope>
 *
 *  `NotifyForFields=Referenced` fires events when any field
 *  referenced in the Query changes — exactly the projection set,
 *  giving the cycle full coverage without unrelated-field churn. */
const buildCreateEnvelope = (
  sessionId: string,
  entity: SalesforceEntityName,
): string => {
  const name = SALESFORCE_PUSHTOPIC_NAMES[entity];
  const query = pushTopicQueryFor(entity);
  const xmlSession = escapeXml(sessionId);
  const xmlName = escapeXml(name);
  const xmlQuery = escapeXml(query);
  const xmlApiVersion = escapeXml(SALESFORCE_PUSHTOPIC_API_VERSION);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '  xmlns:urn="urn:partner.soap.sforce.com">',
    '  <soapenv:Header>',
    '    <urn:SessionHeader>',
    `      <urn:sessionId>${xmlSession}</urn:sessionId>`,
    '    </urn:SessionHeader>',
    '  </soapenv:Header>',
    '  <soapenv:Body>',
    '    <urn:create>',
    '      <urn:sObjects xsi:type="PushTopic">',
    `        <Name>${xmlName}</Name>`,
    `        <Query>${xmlQuery}</Query>`,
    `        <ApiVersion>${xmlApiVersion}</ApiVersion>`,
    '        <NotifyForOperationCreate>true</NotifyForOperationCreate>',
    '        <NotifyForOperationUpdate>true</NotifyForOperationUpdate>',
    '        <NotifyForOperationDelete>true</NotifyForOperationDelete>',
    '        <NotifyForOperationUndelete>true</NotifyForOperationUndelete>',
    '        <NotifyForFields>Referenced</NotifyForFields>',
    '      </urn:sObjects>',
    '    </urn:create>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
};

/** PushTopic Query SOQL — `SELECT <fields> FROM <Entity>`. SOQL
 *  constraints PushTopic Queries to flat field projections (no
 *  ORDER BY / LIMIT / aggregate functions); Recued's canonical
 *  field lists comply by construction. The reconciler's own
 *  cursor-paged search uses the same projection — keeps the
 *  webhook payload fields aligned with the search projection so
 *  the cascade-engine cycle + the streaming path stay symmetric. */
export const pushTopicQueryFor = (entity: SalesforceEntityName): string => {
  switch (entity) {
    case 'opportunity':
      return `SELECT ${SALESFORCE_OPPORTUNITY_FIELDS.join(', ')} FROM Opportunity`;
    case 'contact':
      return `SELECT ${SALESFORCE_CONTACT_FIELDS.join(', ')} FROM Contact`;
    case 'account':
      return `SELECT ${SALESFORCE_ACCOUNT_FIELDS.join(', ')} FROM Account`;
  }
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const entityForPushTopicName = (
  name: string,
): SalesforceEntityName | null => {
  for (const entity of SALESFORCE_ENTITY_NAMES) {
    if (SALESFORCE_PUSHTOPIC_NAMES[entity] === name) return entity;
  }
  return null;
};

/** D-139 P1b — reverse lookup for engagement PushTopic names. */
const engagementEntityForPushTopicName = (
  name: string,
):
  | SalesforceEngagementEntityName
  | SalesforceRelationshipEntityName
  | null => {
  for (const entity of Object.keys(SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES) as Array<
    SalesforceEngagementEntityName | SalesforceRelationshipEntityName
  >) {
    if (SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES[entity] === name) return entity;
  }
  return null;
};

/** D-139 P1b — SOAP-create a PushTopic for an engagement entity.
 *  Mirrors `soapCreatePushTopic` for the CRM trio but uses the
 *  engagement-entity field projections + PushTopic names. */
const soapCreateEngagementPushTopic = async (
  connection: ConnectionRecord,
  baseUrl: string,
  entity: SalesforceEngagementEntityName | SalesforceRelationshipEntityName,
  fetcher: typeof fetch,
  refreshAuth: (c: ConnectionRecord) => Promise<ConnectionAuth>,
): Promise<void> => {
  const url = `${baseUrl}${SALESFORCE_SOAP_PARTNER_PATH}`;
  const pushTopicName = SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES[entity];

  let auth = connection.auth;
  let refreshed = false;

  while (true) {
    const accessToken = readAccessToken(auth, connection.name);
    const envelope = buildEngagementCreateEnvelope(accessToken, entity);
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '""',
        Accept: 'text/xml',
      },
      body: envelope,
    });

    if (response.status === 401 && !refreshed) {
      refreshed = true;
      auth = await refreshAuth({ ...connection, auth });
      continue;
    }

    const body = await safeReadText(response);
    if (response.ok && !isSoapFault(body) && isCreateSuccess(body)) {
      return;
    }
    throw new SalesforcePushTopicCreateError(
      pushTopicName,
      response.status,
      body,
    );
  }
};

/** D-139 P1b — engagement PushTopic Query. Uses
 *  `engagementPushTopicQueryFor`'s field projection. */
const buildEngagementCreateEnvelope = (
  sessionId: string,
  entity: SalesforceEngagementEntityName | SalesforceRelationshipEntityName,
): string => {
  const name = SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES[entity];
  const query = engagementPushTopicQueryFor(entity);
  const xmlSession = escapeXml(sessionId);
  const xmlName = escapeXml(name);
  const xmlQuery = escapeXml(query);
  const xmlApiVersion = escapeXml(SALESFORCE_PUSHTOPIC_API_VERSION);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '  xmlns:urn="urn:partner.soap.sforce.com">',
    '  <soapenv:Header>',
    '    <urn:SessionHeader>',
    `      <urn:sessionId>${xmlSession}</urn:sessionId>`,
    '    </urn:SessionHeader>',
    '  </soapenv:Header>',
    '  <soapenv:Body>',
    '    <urn:create>',
    '      <urn:sObjects xsi:type="PushTopic">',
    `        <Name>${xmlName}</Name>`,
    `        <Query>${xmlQuery}</Query>`,
    `        <ApiVersion>${xmlApiVersion}</ApiVersion>`,
    '        <NotifyForOperationCreate>true</NotifyForOperationCreate>',
    '        <NotifyForOperationUpdate>true</NotifyForOperationUpdate>',
    '        <NotifyForOperationDelete>true</NotifyForOperationDelete>',
    '        <NotifyForOperationUndelete>true</NotifyForOperationUndelete>',
    '        <NotifyForFields>Referenced</NotifyForFields>',
    '      </urn:sObjects>',
    '    </urn:create>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
};

/** D-139 P1b — SOQL Query for an engagement PushTopic. Same shape as
 *  `pushTopicQueryFor` for the CRM trio. */
export const engagementPushTopicQueryFor = (
  entity: SalesforceEngagementEntityName | SalesforceRelationshipEntityName,
): string => {
  const sobjectName = SALESFORCE_ENGAGEMENT_SOBJECT_NAMES[entity];
  switch (entity) {
    case 'task':
      return `SELECT ${SALESFORCE_TASK_FIELDS.join(', ')} FROM ${sobjectName}`;
    case 'event':
      return `SELECT ${SALESFORCE_EVENT_FIELDS.join(', ')} FROM ${sobjectName}`;
    case 'email_message':
      return `SELECT ${SALESFORCE_EMAIL_MESSAGE_FIELDS.join(', ')} FROM ${sobjectName}`;
    case 'voice_call':
      return `SELECT ${SALESFORCE_VOICE_CALL_FIELDS.join(', ')} FROM ${sobjectName}`;
    case 'call_history':
      return `SELECT ${SALESFORCE_CALL_HISTORY_FIELDS.join(', ')} FROM ${sobjectName}`;
    case 'task_relation':
      return `SELECT ${SALESFORCE_TASK_RELATION_FIELDS.join(', ')} FROM ${sobjectName}`;
    case 'event_relation':
      return `SELECT ${SALESFORCE_EVENT_RELATION_FIELDS.join(', ')} FROM ${sobjectName}`;
    case 'email_message_relation':
      return `SELECT ${SALESFORCE_EMAIL_MESSAGE_RELATION_FIELDS.join(', ')} FROM ${sobjectName}`;
  }
};

const readBaseUrl = (connection: ConnectionRecord): string => {
  const base = connection.config.base_url;
  if (typeof base !== 'string' || base.length === 0) {
    throw new Error(
      `Salesforce connection '${connection.name}' has no config.base_url — re-enroll to capture the instance_url`,
    );
  }
  return base.endsWith('/') ? base.slice(0, -1) : base;
};

const readAccessToken = (auth: ConnectionAuth, connectionName: string): string => {
  if (auth.type !== 'oauth2_refresh') {
    throw new Error(
      `Salesforce connection '${connectionName}' is not oauth2_refresh — cannot bind PushTopic SOAP session`,
    );
  }
  if (typeof auth.current_access_token !== 'string' || auth.current_access_token === '') {
    throw new Error(
      `Salesforce connection '${connectionName}' has no current_access_token — refresh single-flight required`,
    );
  }
  return auth.current_access_token;
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

const isSoapFault = (body: string): boolean =>
  /<soapenv:Fault\b|<faultcode\b/i.test(body);

const isCreateSuccess = (body: string): boolean => {
  const successMatch = body.match(/<success>(true|false)<\/success>/i);
  if (!successMatch) return true;
  return successMatch[1].toLowerCase() === 'true';
};

const escapeSoqlString = (s: string): string => s.replace(/'/g, "\\'");

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
