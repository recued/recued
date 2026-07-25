/** D-139 Phase 1b — Salesforce describeSObjects() capability probe.
 *
 *  Spec § A.2.1 + Pass-5 R5.10 + R5.11. At connection enrollment, the
 *  substrate probes which engagement SObjects + relationship objects
 *  the org actually exposes. The probe answers three orthogonal
 *  questions per object:
 *
 *    1. **Object availability** — does `GET /services/data/<v>/sobjects/
 *       <Name>/describe` return 200 with `queryable: true`? Returns
 *       false on 404 (org doesn't have CallHistory installed) or 200
 *       with `queryable: false` (license-gated).
 *
 *    2. **CDC support** — does the SObject participate in the org's
 *       Change Data Capture stream? CDC selected-entities is admin-
 *       configurable; the probe checks `EntityDefinition.IsChangeData
 *       CaptureSelected` per object via SOQL. CDC presence is also
 *       Edition-gated (Enterprise+) — the SOQL probe surfaces the
 *       constraint cleanly.
 *
 *    3. **PushTopic streamability** — even when CDC is unavailable,
 *       the substrate can fall back to PushTopic for the parent SObject
 *       (Task / Event / EmailMessage). Junction objects (TaskRelation /
 *       EventRelation / EmailMessageRelation) can be PushTopic-backed
 *       too but Salesforce historically restricts which fields PushTopic
 *       can SELECT — the probe verifies the canonical-field projection
 *       passes via a dry-run SOQL `LIMIT 0` query before committing
 *       to PushTopic creation. Streamability is a per-channel flag
 *       per Pass-5 R5.10.
 *
 *  Result rows feed `EngagementCapabilityFlags` directly per § A.6.
 *  `last_probed_at` stamps every probe; `last_probe_error` records the
 *  failing-leg error string surfaced via Settings → Connections →
 *  Salesforce → "Re-probe capabilities".
 *
 *  CallHistory vs VoiceCall (Pass-5 R5.11): the dual-schema probe
 *  picks `voice_call` when both are queryable + `call_history` only
 *  when VoiceCall is missing. The result row picks the winner; the
 *  loser is registered with `available: false` so the capability
 *  surface can show "this org runs VoiceCall, not CallHistory".
 *
 *  Spec: `docs/d-139-spec.md` § A.2.1, § A.6, Pass-5 R5.10, R5.11. */

import {
  SALESFORCE_API_VERSION,
  SALESFORCE_ALL_ENGAGEMENT_ENTITIES,
  SALESFORCE_ENGAGEMENT_SOBJECT_NAMES,
  resolveBearerAccessToken,
  type ConnectionAuth,
  type ConnectionRecord,
  type EngagementCapabilityFlags,
  type SalesforceEngagementEntityName,
  type SalesforceRelationshipEntityName,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export type SalesforceEngagementProbeEntity =
  | SalesforceEngagementEntityName
  | SalesforceRelationshipEntityName;

export interface SalesforceProbeDeps {
  /** HTTP fetcher. Defaults to `globalThis.fetch`. */
  fetcher?: typeof fetch;
  /** OAuth refresh hook — fired on 401 from the describe call. The
   *  boot wire wires this to the connection adapter's existing
   *  single-flight refresh path. */
  refreshAuth: (connection: ConnectionRecord) => Promise<ConnectionAuth>;
}

/** Per-object probe outcome. */
export interface ProbeOutcome {
  entity: SalesforceEngagementProbeEntity;
  available: boolean;
  cdc_supported: boolean;
  push_topic_streamable: boolean;
  /** Failing-leg error string when any probe leg surfaced a
   *  non-recoverable error. Empty when every leg succeeded. */
  last_probe_error?: string;
}

/** Aggregate probe result. The dual-schema VoiceCall vs CallHistory
 *  pick happens here per Pass-5 R5.11 — `winning_call_entity` declares
 *  which one the substrate registers; the loser appears in `outcomes`
 *  with `available: false`. */
export interface SalesforceProbeResult {
  outcomes: ReadonlyArray<ProbeOutcome>;
  /** `'voice_call'` when VoiceCall is queryable (preferred per
   *  R5.11); `'call_history'` when only CallHistory is queryable;
   *  `null` when neither is available. */
  winning_call_entity: 'voice_call' | 'call_history' | null;
}

// ────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────

export class SalesforceProbeAuthExpiredError extends Error {
  readonly code = 'SALESFORCE_PROBE_AUTH_EXPIRED';
  constructor(connectionName: string) {
    super(
      `Salesforce probe auth expired for connection '${connectionName}' — refresh single-flight did not yield a working access token`,
    );
    this.name = 'SalesforceProbeAuthExpiredError';
  }
}

// ────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────

/** Run the engagement-substrate probe across every engagement +
 *  relationship object. Idempotent — safe to call repeatedly (every
 *  call talks to Salesforce; the result is cheap to compute). The
 *  caller persists the resulting `EngagementCapabilityFlags` rows via
 *  `EngagementCapabilityStore.upsert`. */
export const probeSalesforceEngagementCapabilities = async (
  connection: ConnectionRecord,
  deps: SalesforceProbeDeps,
  now: number = Date.now(),
): Promise<SalesforceProbeResult> => {
  const outcomes: ProbeOutcome[] = [];
  // Run object probes serially so one connection's probe doesn't fan
  // out to 8 concurrent requests against Salesforce. Production
  // enrollment is a one-time hit; serial is plenty.
  for (const entity of SALESFORCE_ALL_ENGAGEMENT_ENTITIES) {
    const outcome = await probeOneEntity(connection, entity, deps);
    outcomes.push(outcome);
  }
  void now;

  // Pass-5 R5.11 dual-schema pick — VoiceCall preferred when both
  // are queryable; CallHistory fallback when only CallHistory is
  // queryable; both unavailable → null.
  const voiceCallOutcome = outcomes.find((o) => o.entity === 'voice_call');
  const callHistoryOutcome = outcomes.find((o) => o.entity === 'call_history');
  let winning_call_entity: SalesforceProbeResult['winning_call_entity'] = null;
  if (voiceCallOutcome?.available === true) {
    winning_call_entity = 'voice_call';
    if (callHistoryOutcome) {
      // Demote the loser regardless of its own availability flag so
      // downstream wiring picks one entity per connection.
      callHistoryOutcome.available = false;
      callHistoryOutcome.cdc_supported = false;
      callHistoryOutcome.push_topic_streamable = false;
    }
  } else if (callHistoryOutcome?.available === true) {
    winning_call_entity = 'call_history';
  }

  return { outcomes, winning_call_entity };
};

/** Translate a `ProbeOutcome` into the `EngagementCapabilityFlags`
 *  shape the capability store persists. Pure transform — caller
 *  supplies `connection_id` + `last_probed_at` + the per-vendor scope
 *  context.
 *
 *  D-139 P1b Codex review fold #3 — CDC subscription path is NOT yet
 *  implemented in the substrate (cometd-subscriber.ts only builds
 *  `/topic/*` PushTopic channels; there's no `/data/*ChangeEvent`
 *  CDC subscription). Until CDC delivery lands, the substrate honors
 *  `cdc_supported = true` as a probe-result fact (so re-probe + UI
 *  surfaces stay accurate) BUT keeps `reconciler_only = true` +
 *  `association_rescan_required = true` whenever the live streaming
 *  path is PushTopic-only. PushTopic-supported objects can claim
 *  streaming coverage; CDC-supported-but-PushTopic-unsupported
 *  objects fall back to reconciler-only since the substrate has no
 *  active CDC consumer. This is spec-compliant per the streaming
 *  preference order in § A.4 (CDC > PushTopic > reconciler-only)
 *  collapsed to (PushTopic > reconciler-only) at this substrate
 *  shipping milestone. Carry-forward: D-139 follow-up sub-phase
 *  ships CDC subscription support; until then this function pins
 *  reconciler-only-when-no-pushtopic regardless of CDC. */
export const probeOutcomeToCapabilityFlags = (input: {
  outcome: ProbeOutcome;
  connection_id: string;
  last_probed_at: number;
}): EngagementCapabilityFlags => {
  // PushTopic is the only live streaming path at this substrate
  // milestone. CDC-only entities flow through reconciler-only +
  // association-rescan until CDC subscription support lands.
  const has_active_streaming = input.outcome.push_topic_streamable === true;
  const flags: EngagementCapabilityFlags = {
    connection_id: input.connection_id,
    vendor: 'salesforce',
    entity: input.outcome.entity,
    available: input.outcome.available,
    cdc_supported: input.outcome.cdc_supported,
    push_topic_supported: input.outcome.push_topic_streamable,
    reconciler_only:
      input.outcome.available === true && has_active_streaming === false,
    // Salesforce does not have HubSpot's per-object associationChange
    // capability flag — the relationship-object probes themselves are
    // the capability surface. Default: rescan required when no live
    // streaming path is consuming for this entity.
    association_rescan_required:
      input.outcome.available === true && has_active_streaming === false,
    last_probed_at: input.last_probed_at,
  };
  if (input.outcome.last_probe_error !== undefined) {
    flags.last_probe_error = input.outcome.last_probe_error;
  }
  return flags;
};

// ────────────────────────────────────────────────────────────────
// Per-entity probe legs
// ────────────────────────────────────────────────────────────────

/** Probe one entity across all three legs (object availability + CDC +
 *  PushTopic streamability). Captures the first failing-leg error in
 *  `last_probe_error` — the rest of the legs run regardless so the
 *  result is a clean snapshot of every flag. */
const probeOneEntity = async (
  connection: ConnectionRecord,
  entity: SalesforceEngagementProbeEntity,
  deps: SalesforceProbeDeps,
): Promise<ProbeOutcome> => {
  const sobjectName = SALESFORCE_ENGAGEMENT_SOBJECT_NAMES[entity];
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);

  const errors: string[] = [];

  let available = false;
  try {
    available = await probeObjectAvailable(connection, sobjectName, fetcher, deps.refreshAuth);
  } catch (e) {
    errors.push(`describe: ${errorMessage(e)}`);
  }

  let cdc_supported = false;
  if (available) {
    try {
      cdc_supported = await probeCdcSupported(connection, sobjectName, fetcher, deps.refreshAuth);
    } catch (e) {
      errors.push(`cdc: ${errorMessage(e)}`);
    }
  }

  let push_topic_streamable = false;
  if (available) {
    try {
      push_topic_streamable = await probePushTopicStreamable(
        connection,
        entity,
        fetcher,
        deps.refreshAuth,
      );
    } catch (e) {
      errors.push(`pushtopic: ${errorMessage(e)}`);
    }
  }

  const outcome: ProbeOutcome = {
    entity,
    available,
    cdc_supported,
    push_topic_streamable,
  };
  if (errors.length > 0) outcome.last_probe_error = errors.join('; ');
  return outcome;
};

/** Leg 1 — `GET /services/data/<v>/sobjects/<Name>/describe`. 404
 *  means the SObject isn't installed in this org (legacy CallHistory
 *  on a fresh Service Cloud org); 200 with `queryable: false` means
 *  license-gated. */
const probeObjectAvailable = async (
  connection: ConnectionRecord,
  sobjectName: string,
  fetcher: typeof fetch,
  refreshAuth: (c: ConnectionRecord) => Promise<ConnectionAuth>,
): Promise<boolean> => {
  const baseUrl = readBaseUrl(connection);
  const url = `${baseUrl}/services/data/${SALESFORCE_API_VERSION}/sobjects/${sobjectName}/describe`;
  const response = await fetchWithAuthRetry(connection, url, fetcher, refreshAuth, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body = (await response.json()) as { queryable?: boolean };
  return body.queryable === true;
};

/** Leg 2 — `EntityDefinition.IsChangeDataCaptureSelected` SOQL probe.
 *  Returns true when the org's CDC selected-entities admin setting
 *  includes this SObject. P1b Codex review fold #7 — non-OK responses
 *  surface as a thrown error so the caller's per-leg try/catch
 *  populates `last_probe_error` with the failing-leg detail. */
const probeCdcSupported = async (
  connection: ConnectionRecord,
  sobjectName: string,
  fetcher: typeof fetch,
  refreshAuth: (c: ConnectionRecord) => Promise<ConnectionAuth>,
): Promise<boolean> => {
  const baseUrl = readBaseUrl(connection);
  const soql = `SELECT IsChangeDataCaptureSelected FROM EntityDefinition WHERE QualifiedApiName = '${escapeSoqlString(sobjectName)}'`;
  const url = `${baseUrl}/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const response = await fetchWithAuthRetry(connection, url, fetcher, refreshAuth, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    // EntityDefinition probe failed — could be permissions, could be
    // edition-gated. Surface the status so `last_probe_error`
    // captures the reason. The caller treats the throw as
    // "cdc_supported defaults to false" while still logging the
    // probe error.
    throw new Error(`HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    records?: ReadonlyArray<{ IsChangeDataCaptureSelected?: boolean }>;
  };
  for (const r of body.records ?? []) {
    if (r.IsChangeDataCaptureSelected === true) return true;
  }
  return false;
};

/** Leg 3 — PushTopic Query dry-run via `LIMIT 0`. Salesforce restricts
 *  PushTopic Queries to flat field projections (no aggregates / no
 *  joins / no ORDER BY beyond `LastModifiedDate ASC`). Per Pass-5
 *  R5.10, the probe issues a `SELECT <fields> FROM <SObject> LIMIT 0`
 *  query and treats success as "PushTopic-eligible."
 *
 *  D-139 P1b Codex review fold #8 — the probe now uses the EXACT
 *  `engagementPushTopicQueryFor(entity)` projection that
 *  `pushtopic-soap.ts` will use at SOAP `create()` time. This closes
 *  the gap where the probe's hardcoded subset (`Id`, `Subject`,
 *  `Status`, `LastModifiedDate`) passed but the broader SOAP create
 *  failed on a field that wasn't dry-run (e.g. `Priority` exposed
 *  but not granted to the Connected App's profile). The probe is
 *  now a faithful "would-creation-succeed" check.
 *
 *  P1b Codex fold #7 — non-OK responses throw so `last_probe_error`
 *  captures the failing-leg reason; the per-entity outcome object
 *  records the detail in its `last_probe_error` field while the
 *  remaining legs continue to probe.
 *
 *  The probe doesn't actually create the PushTopic — the boot wire
 *  drives create() through `pushtopic-soap.ts`. This is a "would-it-
 *  work" check. */
const probePushTopicStreamable = async (
  connection: ConnectionRecord,
  entity: SalesforceEngagementProbeEntity,
  fetcher: typeof fetch,
  refreshAuth: (c: ConnectionRecord) => Promise<ConnectionAuth>,
): Promise<boolean> => {
  const baseUrl = readBaseUrl(connection);
  // Codex fold #8: dry-run the EXACT projection SOAP create() will
  // use, with `LIMIT 0` appended. Imports the helper lazily inside
  // the function to keep the module-load graph clean.
  const { engagementPushTopicQueryFor } = await import('./pushtopic-soap.js');
  const baseQuery = engagementPushTopicQueryFor(entity);
  const soql = `${baseQuery} LIMIT 0`;
  const url = `${baseUrl}/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const response = await fetchWithAuthRetry(connection, url, fetcher, refreshAuth, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return true;
};

// ────────────────────────────────────────────────────────────────
// HTTP helpers
// ────────────────────────────────────────────────────────────────

const fetchWithAuthRetry = async (
  connection: ConnectionRecord,
  url: string,
  fetcher: typeof fetch,
  refreshAuth: (c: ConnectionRecord) => Promise<ConnectionAuth>,
  init: RequestInit,
): Promise<Response> => {
  let auth = connection.auth;
  let refreshed = false;
  while (true) {
    const accessToken = readAccessToken(auth, connection.name);
    const response = await fetcher(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      auth = await refreshAuth(connection);
      continue;
    }
    if (response.status === 401 && refreshed) {
      throw new SalesforceProbeAuthExpiredError(connection.name);
    }
    return response;
  }
};

const readBaseUrl = (connection: ConnectionRecord): string => {
  const base = connection.config.base_url;
  if (typeof base !== 'string' || base.length === 0) {
    throw new Error(
      `Salesforce connection '${connection.name}' has no config.base_url — re-enroll to capture instance_url`,
    );
  }
  return base.endsWith('/') ? base.slice(0, -1) : base;
};

// Auth-type-agnostic (see `_salesforce-search.ts`): the connection-layer seam
// yields the bearer token for both `oauth2_refresh` and a static `bearer`.
const readAccessToken = (auth: ConnectionAuth, connectionName: string): string => {
  const token = resolveBearerAccessToken(auth);
  if (token === undefined) throw new SalesforceProbeAuthExpiredError(connectionName);
  return token;
};

const escapeSoqlString = (s: string): string => s.replace(/'/g, "\\'");

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
