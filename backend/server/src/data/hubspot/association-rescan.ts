/** D-139 Phase 1a.2 — per-cycle association-rescan substrate.
 *
 *  Pre-Pass-4 spec assumed association changes ride the same
 *  `vendor_modified_at` cursor as property changes. That assumption is
 *  wrong for HubSpot — associating a new contact to an existing email
 *  engagement does NOT bump `hs_lastmodifieddate`. The webhook funnel
 *  handles this in the streaming case via `associationChange` events
 *  (per-object capability-driven per Pass-5 R5.5); the reconciler-only
 *  fallback path AND any (connection, vendor, entity) tuple where
 *  `association_rescan_required = true` need explicit per-cycle
 *  association re-read for engagements within the cursor window.
 *
 *  This module implements the secondary sweep:
 *
 *    1. Enumerate engagements written/last-touched within
 *       `ASSOCIATION_RESCAN_WINDOW_MS = 7d` AND `lifecycle_state IN
 *       ('point_in_time', 'completed', 'scheduled')` (skip cancelled
 *       + tombstoned).
 *    2. For each engagement, re-fetch the current association list
 *       per association type (HubSpot
 *       `GET /crm/v3/objects/{type}/{id}/associations/{toObjectType}`).
 *    3. Diff against the persisted `engagement_edges` rows; emit
 *       edge-create + edge-tombstone writes.
 *    4. Edge-only changes do NOT touch the engagement-row meta or
 *       `vendor_modstamp`; the cascade engine fires
 *       `cascadeForUpstreamEnrichment` on the engagement→contact /
 *       engagement→deal links.
 *
 *  Quota-aware — re-fetches count against the per-connection daily
 *  token budget (§ A.6.2). Page-cap respected. Suspended budget
 *  collapses the sweep to a no-op for the connection.
 *
 *  Spec: D-139 § A.6.3. */

import {
  ENGAGEMENT_ASSOCIATION_RESCAN_WINDOW_MS,
  RECONCILER_PAGE_CAP_PER_INVOCATION,
  resolveContactIdentity,
  type ConnectionRecord,
  type EngagementEdge,
  type EngagementVendor,
} from '@recued/contracts';

import type { EngagementCapabilityStore } from '../../storage/engagement-capability-store.js';
import type {
  ContactRedirectLookup,
  EngagementStore,
  UpsertEdgeInput,
} from '../../storage/engagement-store.js';
import type { EngagementRateControlStore } from '../../storage/engagement-rate-control-store.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** Vendor-side association fetcher. Returns the current association
 *  set for the engagement keyed by `(vendor, entity, target_id)`.
 *  Each emitted `EngagementEdgeProjection` carries the edge_type +
 *  target_kind + target_id; the rescan substrate runs the diff
 *  against the persisted `engagement_edges` rows + writes the
 *  difference. */
export interface EngagementEdgeProjection {
  edge_type: 'contact' | 'deal' | 'account' | 'mail_twin' | 'calendar_twin' | 'owner';
  target_kind: 'data.contact' | 'data.calendar' | 'data.mail' | 'connection.api' | 'user';
  target_id: string;
}

export interface AssociationFetcherInput {
  connection: ConnectionRecord;
  connection_id: string;
  vendor: EngagementVendor;
  entity: string;
  target_id: string;
}

export type AssociationFetcher = (
  input: AssociationFetcherInput,
) => Promise<{
  edges: ReadonlyArray<EngagementEdgeProjection>;
  api_calls_consumed: number;
}> | {
  edges: ReadonlyArray<EngagementEdgeProjection>;
  api_calls_consumed: number;
};

export interface AssociationRescanInput {
  connection: ConnectionRecord;
  connection_id: string;
  vendor: EngagementVendor;
  entity: string;
  fetcher: AssociationFetcher;
  /** Wall-clock — drives window eligibility + edge tombstones. */
  now: number;
  /** Optional override of the 7d window. */
  window_ms?: number;
  /** Page-cap per invocation (defaults to
   *  `RECONCILER_PAGE_CAP_PER_INVOCATION = 10` per § A.6.2). */
  page_cap?: number;
  /** D-138 redirect lookup — required for contact-edge writes
   *  (substrate routes through `resolveContactIdentity` per § A.5). */
  resolveContactRedirect: ContactRedirectLookup;
  /** Codex review fold (P1 #2) — cursor advancement. Last-processed
   *  `target_id` from the previous invocation. The sweep walks
   *  `WHERE target_id > cursor` so the tail resumes next cycle.
   *  When the cursor exhausts (no more eligible rows), callers reset
   *  to `undefined` for the next full pass. */
  cursor?: string;
  /** Codex review fold (P1 #4) — edge_types this rescan covers. The
   *  fetcher returns CRM-side associations only; non-CRM local edges
   *  (`owner` / `mail_twin` / `calendar_twin`) MUST be excluded from
   *  the diff to avoid spurious tombstones. Defaults to `['contact',
   *  'deal', 'account']` per § A.6.3 (CRM association lists). */
  edge_types_in_scope?: ReadonlyArray<EngagementEdge['edge_type']>;
  /** D-139 P1a.1.1 — bypass the capability-gate skip. Used by
   *  diagnostic / manual-rescan flows (Settings → Connections → Run
   *  rescan now) and by tests that want to verify behavior on
   *  healthy-streaming connections. Default: false. */
  force_run?: boolean;
  /** D-139 P1a.1.1 (Codex P1 #2 fold-back) — caller-asserted streaming
   *  health signal. The capability-gate skip ONLY fires when the
   *  caller passes `streaming_active: true` alongside a capability
   *  map declaring `association_rescan_required: false`. The caller
   *  computes this from: (1) per-(connection, vendor, entity)
   *  applyAssociationChange wiring, (2) recent successful webhook
   *  ledger evidence, (3) capability probe result. When omitted /
   *  false, the rescan ALWAYS runs (P1a.2 conservative posture);
   *  the gate's "skip when capability says so" is gated by this
   *  affirmative streaming-active assertion. */
  streaming_active?: boolean;
}

export interface AssociationRescanOutput {
  /** Engagements scanned (post-eligibility filter). */
  engagements_scanned: number;
  /** Engagements actually re-fetched (post page-cap). Tail resumes
   *  next cycle. */
  engagements_fetched: number;
  /** Edges newly created or resurrected. */
  edges_created: number;
  /** Edges tombstoned (disappeared between cycles). */
  edges_tombstoned: number;
  /** Total API calls consumed across the sweep — counts against
   *  daily-token-budget. */
  api_calls_consumed: number;
  /** True when the budget hit `'suspended'` mid-sweep + the rescan
   *  short-circuited. */
  suspended: boolean;
  /** True when the per-(connection, vendor, entity) tuple is
   *  currently in a 429 backoff window — sweep skipped this cycle. */
  backoff_active: boolean;
  /** When `engagements_fetched < engagements_scanned`, the ids of the
   *  engagements that did NOT get fetched (page-cap or suspended).
   *  Coverage metadata population uses this list. */
  pending_target_ids: ReadonlyArray<string>;
  /** Codex review fold (P1 #2) — the cursor to feed back into the
   *  next invocation. When the sweep exhausts every eligible row,
   *  this is null + callers reset to start a fresh pass; when the
   *  page cap interrupts a sweep, this is the last fetched
   *  `target_id` so the tail resumes from there. */
  next_cursor: string | null;
}

// ────────────────────────────────────────────────────────────────
// Eligibility filter
// ────────────────────────────────────────────────────────────────

/** § A.6.3 — engagements eligible for the secondary sweep. */
export const RESCAN_ELIGIBLE_LIFECYCLE_STATES: ReadonlyArray<string> = [
  'point_in_time',
  'completed',
  'scheduled',
];

// ────────────────────────────────────────────────────────────────
// Sweep
// ────────────────────────────────────────────────────────────────

export interface AssociationRescanDeps {
  engagementStore: EngagementStore;
  capabilityStore: EngagementCapabilityStore;
  rateControlStore: EngagementRateControlStore;
}

/** Default edge_types the rescan diff considers per § A.6.3 (Codex
 *  review fold P1 #4). The fetcher returns CRM-side associations
 *  only; local edges (`owner` / `mail_twin` / `calendar_twin`) are
 *  written by the reconciler at row-ingest and MUST stay invisible
 *  to the diff or they'll be tombstoned every sweep. */
export const DEFAULT_RESCAN_EDGE_TYPES: ReadonlyArray<
  EngagementEdge['edge_type']
> = ['contact', 'deal', 'account'];

/** Runs one cycle of the per-(connection, vendor, entity) association-
 *  rescan sweep. Idempotent under the modstamp-edge contract — edges
 *  upsert at the SQL ON CONFLICT path; tombstones land via the diff.
 *
 *  Skipping conditions:
 *    - per-tuple capability gate `association_rescan_required = false`
 *      AND no `force_run` override → skip (P1a.1.1 — once the
 *      edge-only webhook write path landed, healthy-streaming
 *      connections can skip the per-cycle sweep entirely; degraded
 *      streaming flips the flag back to `true` so the sweep covers
 *      the gap)
 *    - per-tuple backoff active → skip
 *    - daily budget suspended → skip + populate
 *      `coverage.sources_degraded` reason `'quota_suspended'`
 *      downstream
 *    - daily budget within `degraded_30m` / `degraded_1h` → still
 *      runs, page-cap still respected
 *
 *  Codex review fold (P1 #1) — P1a.2 left the capability gate
 *  disabled because webhook processors dropped `*.associationChange`
 *  unledgered. P1a.1.1 wires the edge-only write path; the gate now
 *  honors `association_rescan_required = false` for healthy-streaming
 *  connections + falls back to per-cycle sweep when streaming
 *  degrades. */
export const runAssociationRescan = async (
  input: AssociationRescanInput,
  deps: AssociationRescanDeps,
): Promise<AssociationRescanOutput> => {
  // P1a.1.1 — capability gate. When the per-(connection, vendor,
  // entity) capability map declares `association_rescan_required:
  // false` AND the caller asserts streaming is active (Codex P1 #2
  // fold-back: applier wired + recent successful ledger evidence +
  // capability probe green), the per-cycle sweep is unnecessary.
  // Without `streaming_active: true`, the capability flag alone is
  // NOT sufficient to skip — the caller might not have an applier
  // wired, in which case the webhook drops associationChange
  // unledgered and the rescan is the only path that covers the gap.
  // Callers can override via `force_run: true` for diagnostic /
  // manual-rescan flows (force_run takes precedence over both gates).
  const capability = deps.capabilityStore.get(
    input.connection_id,
    input.vendor,
    input.entity,
  );
  const forceRun = input.force_run === true;
  const streamingActive = input.streaming_active === true;
  if (
    !forceRun &&
    streamingActive &&
    capability !== null &&
    capability.association_rescan_required === false
  ) {
    return emptyOutput(false, false);
  }

  const backoff = deps.rateControlStore.readBackoff({
    connection_id: input.connection_id,
    vendor: input.vendor,
    entity: input.entity,
  });
  if (
    backoff.consecutive_429s > 0 &&
    backoff.next_attempt_at > input.now
  ) {
    return emptyOutput(false, true);
  }

  const usage = deps.rateControlStore.readUsage({
    connection_id: input.connection_id,
    vendor: input.vendor,
    now: input.now,
  });
  if (usage.rate_control_state === 'suspended') {
    return emptyOutput(true);
  }

  const window_ms = input.window_ms ?? ENGAGEMENT_ASSOCIATION_RESCAN_WINDOW_MS;
  const page_cap = input.page_cap ?? RECONCILER_PAGE_CAP_PER_INVOCATION;
  const edge_types_in_scope =
    input.edge_types_in_scope ?? DEFAULT_RESCAN_EDGE_TYPES;
  const inScopeSet = new Set(edge_types_in_scope);

  // Enumerate eligible engagements via the engagement store. Codex
  // review fold (P1 #2) — accept a `cursor` (last-processed target_id)
  // so the page-capped tail resumes next cycle. The store enumerator
  // returns ascending target_id order; the rescan walks `target_id >
  // cursor` to advance.
  const allEligible = enumerateRescanEligible(
    deps,
    input.connection_id,
    input.vendor,
    input.entity,
    input.now,
    window_ms,
  );
  const engagements = input.cursor
    ? allEligible.filter((id) => id > input.cursor!)
    : allEligible;

  let engagements_fetched = 0;
  let edges_created = 0;
  let edges_tombstoned = 0;
  let api_calls_consumed = 0;
  let suspended = false;
  let next_cursor: string | null = null;
  const pending_target_ids: string[] = [];

  for (const engagementId of engagements) {
    if (engagements_fetched >= page_cap) {
      pending_target_ids.push(engagementId);
      continue;
    }
    // Codex review fold (P2 #7) — tighten the mid-loop check to
    // `degraded_1h` so paginated fetches can't push the daily budget
    // over the 100% threshold mid-sweep before usage is recorded.
    const midCheck = deps.rateControlStore.readUsage({
      connection_id: input.connection_id,
      vendor: input.vendor,
      now: input.now,
    });
    if (
      midCheck.rate_control_state === 'suspended' ||
      midCheck.rate_control_state === 'degraded_1h'
    ) {
      if (midCheck.rate_control_state === 'suspended') suspended = true;
      pending_target_ids.push(engagementId);
      continue;
    }
    let fetched: {
      edges: ReadonlyArray<EngagementEdgeProjection>;
      api_calls_consumed: number;
    };
    try {
      fetched = await Promise.resolve(
        input.fetcher({
          connection: input.connection,
          connection_id: input.connection_id,
          vendor: input.vendor,
          entity: input.entity,
          target_id: engagementId,
        }),
      );
    } catch {
      // Fetcher failed — leave pending, continue sweep so other
      // engagements can advance. The fetcher is responsible for
      // recording 429s + permission errors via rateControlStore.
      pending_target_ids.push(engagementId);
      continue;
    }
    api_calls_consumed += fetched.api_calls_consumed;
    deps.rateControlStore.recordUsage({
      connection_id: input.connection_id,
      vendor: input.vendor,
      n: fetched.api_calls_consumed,
      now: input.now,
    });
    engagements_fetched += 1;
    next_cursor = engagementId;

    const diff = diffEdges(
      deps.engagementStore,
      input.connection_id,
      engagementId,
      fetched.edges,
      input.vendor,
      input.now,
      input.resolveContactRedirect,
      inScopeSet,
    );
    edges_created += diff.edges_created;
    edges_tombstoned += diff.edges_tombstoned;
  }

  return {
    engagements_scanned: engagements.length,
    engagements_fetched,
    edges_created,
    edges_tombstoned,
    api_calls_consumed,
    suspended,
    backoff_active: false,
    pending_target_ids,
    // When the sweep exhausted every eligible row (no pending tail),
    // signal `null` so callers reset for the next full pass. When
    // page-capped, return the last successfully fetched target_id.
    next_cursor: pending_target_ids.length > 0 ? next_cursor : null,
  };
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const emptyOutput = (
  suspended: boolean,
  backoff_active = false,
): AssociationRescanOutput => ({
  engagements_scanned: 0,
  engagements_fetched: 0,
  edges_created: 0,
  edges_tombstoned: 0,
  api_calls_consumed: 0,
  suspended,
  backoff_active,
  pending_target_ids: [],
  next_cursor: null,
});

/** Enumerate engagements eligible for the secondary sweep —
 *  written/last-touched within `window_ms` AND lifecycle in the
 *  eligible state set AND not tombstoned. Routes through the store's
 *  `listRescanEligible` helper which uses a single windowed SELECT
 *  against the engagements table (covering index on
 *  `(connection_id, vendor, vendor_modified_at)`). */
const enumerateRescanEligible = (
  deps: AssociationRescanDeps,
  connection_id: string,
  vendor: EngagementVendor,
  entity: string,
  now: number,
  window_ms: number,
): ReadonlyArray<string> => {
  const cutoff = now - window_ms;
  return deps.engagementStore.listRescanEligible({
    connection_id,
    vendor,
    entity,
    cutoff,
    eligible_states: RESCAN_ELIGIBLE_LIFECYCLE_STATES as ReadonlyArray<
      ReturnType<typeof asLifecycleState>
    >,
  });
};

const asLifecycleState = (s: string): import('@recued/contracts').EngagementLifecycleState =>
  s as import('@recued/contracts').EngagementLifecycleState;

interface DiffResult {
  edges_created: number;
  edges_tombstoned: number;
}

/** § A.6.3 — diff the fetched edge set against the persisted edges +
 *  emit creates / tombstones. Edge-only writes; no engagement-row
 *  meta refresh.
 *
 *  Codex review fold (P1 #3) — for `edge_type='contact'`, the
 *  fetcher returns raw vendor email (potentially a loser email);
 *  persisted contact edges store the D-138 survivor canonical. Pre-
 *  resolve incoming edges through `resolveContactRedirect` BEFORE
 *  building `incomingKeys` so the diff matches against persisted
 *  survivor ids, not the loser the vendor still sees.
 *
 *  Codex review fold (P1 #4) — restrict the diff to
 *  `edge_types_in_scope` (default CRM-side: contact / deal / account).
 *  Local-only edges (`owner` / `mail_twin` / `calendar_twin`) are
 *  written by the reconciler at row-ingest and aren't covered by the
 *  vendor association API; they MUST stay invisible to the diff or
 *  every sweep tombstones them. */
const diffEdges = (
  store: EngagementStore,
  connection_id: string,
  engagement_target_id: string,
  fetched: ReadonlyArray<EngagementEdgeProjection>,
  vendor: EngagementVendor,
  now: number,
  resolveContactRedirect: ContactRedirectLookup,
  edge_types_in_scope: ReadonlySet<EngagementEdge['edge_type']>,
): DiffResult => {
  let edges_created = 0;
  let edges_tombstoned = 0;

  const existing = store.listEdges({
    connection_id,
    engagement_target_id,
  });
  // Restrict existing-edge view to in-scope types only. Local-only
  // edges stay alone.
  const existingScoped = existing.filter((e: EngagementEdge) =>
    edge_types_in_scope.has(e.edge_type),
  );
  const existingKeys = new Set(
    existingScoped.map((e: EngagementEdge) => `${e.edge_type}|${e.target_id}`),
  );
  const incomingKeys = new Set<string>();

  for (const e of fetched) {
    if (!edge_types_in_scope.has(e.edge_type)) continue;
    // D-139 P1b Codex review fold #5 — only canonical-email contact
    // edges (target_kind 'data.contact') run through D-138 redirect.
    // Salesforce-Id-shaped contact edges (target_kind 'connection.api')
    // store the platform-id verbatim; mirrors the engagement-store
    // upsertEdge gate widening so the rescan diff doesn't throw on
    // non-email Salesforce IDs (Task/Event relationship contact rows).
    const isCanonicalEmailContact =
      e.edge_type === 'contact' && e.target_kind === 'data.contact';
    let resolvedTargetId = e.target_id;
    if (isCanonicalEmailContact) {
      const { canonical_email } = resolveContactIdentity(
        e.target_id,
        resolveContactRedirect,
      );
      resolvedTargetId = canonical_email;
    }
    const key = `${e.edge_type}|${resolvedTargetId}`;
    incomingKeys.add(key);
    if (existingKeys.has(key)) continue;
    const upsert: UpsertEdgeInput = {
      connection_id,
      engagement_target_id,
      edge_type: e.edge_type,
      target_kind: e.target_kind,
      target_id: e.target_id,
      vendor,
      created_at: now,
      ...(isCanonicalEmailContact ? { resolveContactRedirect } : {}),
    };
    store.upsertEdge(upsert);
    edges_created += 1;
  }

  for (const e of existingScoped) {
    const key = `${e.edge_type}|${e.target_id}`;
    if (incomingKeys.has(key)) continue;
    const removed = store.tombstoneEdge({
      connection_id,
      engagement_target_id,
      edge_type: e.edge_type,
      target_id: e.target_id,
      deleted_at: now,
    });
    if (removed) edges_tombstoned += 1;
  }

  return { edges_created, edges_tombstoned };
};
