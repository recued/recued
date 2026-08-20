/** D-122 Phase 4.5 — `data.enrichment.*` cascade engine.
 *
 *  Three application-level hooks fire from existing source-write paths:
 *
 *    - `cascadeForSourceDelete(scope, source_id)` — a mail / calendar /
 *      contact / file row was hard-deleted. Per-topic policy decides
 *      whether the enrichment row goes too:
 *        * `dependent`    → cascade-delete (FK CASCADE drops sidecars)
 *        * `members_list` → trim member from list; delete row when empty
 *        * `aggregate`    → cascade-delete (D-145 § A.7.9 — universal
 *                            cleanup; aggregate rows carry current_state
 *                            semantics like dependent rows do)
 *        * `independent`  → no-op (no source linkage by definition)
 *
 *    - `cascadeForSourceUpdate(scope, source_id, new_hash)` — a source
 *      record's content changed. `dependent` topics mark stale + drop
 *      sidecars (consumer reads return null until producer reruns);
 *      other policies are no-ops (cursors advance the natural way).
 *
 *    - `cascadeForRecipeUpgrade(recipe_id)` — a recipe shipped a new
 *      version. Every row authored by the recipe is marked stale + has
 *      its sidecars dropped. Producers reruns repopulate; consumers
 *      see the stale flag in the meantime via `fresh_only` filter.
 *
 *  The engine iterates the static registry once per call; per-call
 *  cost is O(topics) which is fine for the registry size. The store
 *  layer carries the index narrowing for the actual SQL hits.
 *
 *  D-123 Phase 6 — every cascade hook also fires
 *  `notifyHousekeepingInvalidation(hint)` after the enrichment-side
 *  work completes. The notifier walks the housekeeping task registry
 *  + flips `last_status: 'complete' → 'pending'` for tasks that
 *  opted into invalidation via `onInvalidate`. The notifier is
 *  optional — db-less harnesses + the existing
 *  `createEnrichmentCascade(store)` test calls work unchanged.
 *
 *  Spec: D-122 §"Enrichment substrate" — Cascade engine.
 *  D-123 wiring: D-123 §6.1. */

import {
  CONNECTION_VENDOR_ENTITIES,
  ENRICHMENT_REGISTRY,
  composeConnectionTargetIdPrefix,
  vendorHasEngagement,
  type ConnectionVendorEntity,
  type EnrichmentDefinition,
  type EnrichmentScope,
  type EnrichmentTopic,
} from '@recued/contracts';
import type { EnrichmentStore } from './enrichment-store.js';
import {
  NO_OP_CASCADE_BUDGET_GOVERNOR,
  type CascadeBudgetGovernor,
} from './cascade-budget.js';
import type { ExternalContextDependencyRegistry } from './external-context-pulse.js';

/** Hint shape carried over from the housekeeping registry — the
 *  cascade engine constructs hints itself but never imports the
 *  housekeeping module, so the hint is duck-typed via the optional
 *  callback signature. The runtime contract matches
 *  `HousekeepingInvalidateHint` exactly. */
export interface CascadeInvalidationHint {
  scope?: string;
  topic?: string;
  source_id?: string;
  /** D-136 §A.5 P5 — cascade primitives widen the reason set so
   *  housekeeping tasks can opt into invalidation per-cascade-shape.
   *  Existing readers (`thread_signals`, audit-compaction) ignore
   *  unknown reasons; new tasks (queue drain at P5b, walk-cap
   *  budgeting) consume them. */
  reason:
    | 'source_update'
    | 'source_delete'
    | 'recipe_upgrade'
    | 'config_change'
    | 'producer_upgrade'
    | 'upstream_enrichment'
    | 'identity_change'
    | 'connection_delete'
    /** D-136 §A.14.1 P5b — external context pulse changed. Source_id
     *  carries the `context_id`. Drain consumer reads the topic's
     *  `consumes_external_context` declarations to choose the
     *  appropriate recompute path. */
    | 'external_context_pulse_change'
    /** D-139 P3 § A.10 — engagement event delivery (created /
     *  updated / deleted / association-changed). The engagement
     *  substrate (D-139 P1a.1+) holds engagement rows + edges
     *  outside the enrichment table; this cascade reason walks
     *  engagement_edges → affected deal/contact/account targets +
     *  invalidates aggregate enrichment rows whose
     *  `aggregates_from` references the engagement's per-type
     *  source scope. Source_id carries the engagement's
     *  `target_id`. */
    | 'engagement_event';
}

export type CascadeInvalidationNotifier = (hint: CascadeInvalidationHint) => void;

/** Round-12 audit fix (T1 § 8.1) — result of an all-or-nothing per-topic
 *  queue-depth reservation (`reserveTopicRecomputeAdmission`). `dropped`
 *  carries the governor's declined count so callers fold it into
 *  `rows_queue_depth_capped` (or a skip log) instead of losing it. */
export interface TopicRecomputeAdmission {
  admitted: boolean;
  candidates: number;
  dropped: number;
}

/** Aggregate result of a single cascade call. Returned for audit /
 *  test visibility; recipe surface ignores it. */
export interface CascadeResult {
  rows_deleted: number;
  rows_marked_stale: number;
  members_trimmed: number;
  members_emptied_deleted: number;
  /** D-136 §A.5 P5 — count of rows whose `lifecycle_action_pending`
   *  flipped to `'recompute'` (or another action) by this cascade
   *  call. Drives the queue drain consumer (P5 follow-up) + the
   *  Settings → Housekeeping observability counters. */
  rows_lifecycle_action_enqueued: number;
  /** D-136 §A.5 P5 — count of rows tombstoned by this cascade call
   *  (`tombstoned_at` set + `staleness_class = 'expired'` + reason
   *  recorded). Today populated only by `cascadeForConnectionDelete`. */
  rows_tombstoned: number;
  /** D-136 §A.5 P5b — count of rows whose enqueue was skipped because
   *  the per-identity rate ceiling
   *  (`cascade_budget_per_second_per_identity`) was already saturated
   *  for this 1-second window. The cascade primitive returns success
   *  but reports the dropped count for Settings → Housekeeping
   *  observability + the per-cycle cycle-budget rendering. */
  rows_rate_limited: number;
  /** D-136 §A.5 P5b — count of rows whose enqueue was skipped because
   *  the topic's pending queue depth was already at
   *  `cascade_queue_depth_max_per_topic`. Mirrors `rows_rate_limited`
   *  for the per-topic ceiling — the cascade primitive returns
   *  success but reports the dropped count for observability. */
  rows_queue_depth_capped: number;
}

const emptyResult = (): CascadeResult => ({
  rows_deleted: 0,
  rows_marked_stale: 0,
  members_trimmed: 0,
  members_emptied_deleted: 0,
  rows_lifecycle_action_enqueued: 0,
  rows_tombstoned: 0,
  rows_rate_limited: 0,
  rows_queue_depth_capped: 0,
});

/** Walk every registered topic. Caller-supplied `cb` decides what to
 *  do per `(topic, def)`. Centralising the iteration shape lets the
 *  three hooks share the registry walk + result aggregation. */
const forEachTopic = (cb: (topic: EnrichmentTopic, def: EnrichmentDefinition) => void): void => {
  for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
    cb(topic, ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition);
  }
};

/** D-139 P3 — derive `(target_scope, target_id)` from an engagement
 *  edge. Returns null for edges that don't participate in the
 *  cascade (`'owner'` / `'mail_twin'` / `'calendar_twin'`). The
 *  edge's `target_kind` discriminates the family; the `target_id`
 *  prefix discriminates the vendor + entity within the
 *  `connection.api` family.
 *
 *  Vendor + entity parsing reads the leading two segments of the
 *  `<vendor>_<entity>_<connection>_<raw>` shape (D-190 per-connection
 *  scoping; was `<vendor>_<entity>_<raw>` pre-D-190) — `hubspot_deal_-
 *  acme_47291` / `salesforce_opportunity_acme_006A...`. Only `parts[0]`
 *  (vendor) + `parts[1]` (entity) are read — both unchanged by the
 *  connection segment — and the FULL `target_id` is returned verbatim, so
 *  the derived `(scope, target_id)` matches the record reconciler's
 *  connection-qualified row exactly (the cascade invalidates the right
 *  enrichment). Unrecognised prefixes return null so an edge for a
 *  future-vendor or future-entity doesn't blow up the cascade
 *  (forward-compat with vendor-extension Ds). */
const deriveScopeFromEdge = (
  edge: EngagementEdgeForCascade,
  registry: ReadonlyArray<ConnectionVendorEntity>,
): { scope: EnrichmentScope; target_id: string } | null => {
  if (edge.edge_type === 'contact' && edge.target_kind === 'data.contact') {
    // Canonical email — the substrate-side resolver routes the
    // engagement → contact edge through `resolveContactIdentity`
    // BEFORE writing the edge, so the target_id is already the
    // survivor canonical email per § A.5.
    return { scope: 'contact' as EnrichmentScope, target_id: edge.target_id };
  }
  if (
    (edge.edge_type === 'deal' || edge.edge_type === 'account')
    && edge.target_kind === 'connection.api'
  ) {
    // <vendor>_<entity>_<connection>_<raw_id> (D-190) — closed list at v1.
    // Read only the leading vendor + entity; the connection + raw segments
    // ride along inside the verbatim target_id returned below.
    const parts = edge.target_id.split('_');
    if (parts.length < 3) return null;
    const vendor = parts[0]!;
    const entity = parts[1]!;
    if (vendor.length === 0 || entity.length === 0) return null;
    // D-192 — registry engagement-membership replaces the hardcoded
    // `hubspot`/`salesforce` pair (which WAS exactly the engagement-vendor set):
    // an engagement vendor's edge forms a scope (built-in or pack CRM). Precise
    // vs a bare "is registered" check — a pure-CRM vendor emits no engagement
    // edges, so this reaches the same set the old literal did. An unrecognised /
    // non-engagement prefix still returns null (forward-compat, unchanged).
    if (!vendorHasEngagement(vendor, registry)) return null;
    return {
      scope: `connection.api.${vendor}.${entity}` as EnrichmentScope,
      target_id: edge.target_id,
    };
  }
  // owner / mail_twin / calendar_twin → not aggregate-cascade
  // targets at v1. P4 cross-entity producers consume mail_twin /
  // calendar_twin edges via different fan-out paths (separate
  // primitive will land at P4 if needed).
  return null;
};

/** D-139 P3 — narrow a list of chain-head row ids to those
 *  belonging to a single topic. Reuses the store's `list` helper
 *  per row; the registry is small + cascade enumeration is rare so
 *  we tolerate the per-row hop rather than adding a new SQL helper.
 *  Codex review pre-bake: the alternative of adding a
 *  `listChainHeadRowIdsByTopicScopeAndTarget` SQL helper is
 *  preserved as a P3 follow-up — this implementation is correct
 *  but pays one prepared-statement-call per id; if benchmarks
 *  surface the path as hot, fold the topic into the WHERE clause. */
const filterRowIdsByTopic = (
  store: EnrichmentStore,
  ids: ReadonlyArray<string>,
  topic: EnrichmentTopic,
): string[] => {
  if (ids.length === 0) return [];
  const filtered: string[] = [];
  for (const id of ids) {
    const row = store.getById(id);
    if (row === null) continue;
    if (row.topic === topic) filtered.push(id);
  }
  return filtered;
};

export interface CascadeEngine {
  cascadeForSourceDelete(scope: EnrichmentScope, source_id: string): CascadeResult;
  cascadeForSourceUpdate(scope: EnrichmentScope, source_id: string, new_hash?: string): CascadeResult;
  cascadeForRecipeUpgrade(recipe_id: string): CascadeResult;
  /** D-136 §A.5 P5 — fired when a kernel housekeeping producer's
   *  composed `producer_version_hash` changes (code revision, prompt
   *  edit, model substitution, manifest version bump). Marks every
   *  chain-head row authored under the prior hash stale + enqueues
   *  recompute. Pinned rows skip per spec §A.11. Idempotent on the
   *  steady-state set: re-firing after every row is already
   *  enqueued is a no-op (the SQL filter covers
   *  `lifecycle_action_pending IS NULL`). */
  cascadeForProducerUpgrade(
    producer_kind: string,
    producer_name: string,
    old_version_hash: string,
  ): CascadeResult;
  /** D-136 §A.5 P5 — fired when an enrichment row updates +
   *  downstream rows declared it via `input_enrichment_row_ids`.
   *  Walks the JSON-array column to find consumers; marks them
   *  stale + enqueues recompute. Idempotent. */
  cascadeForUpstreamEnrichment(upstream_row_id: string): CascadeResult;
  /** D-136 §A.5 P5 — fired when a perspective-aggregating source
   *  (mail / calendar / contact / CRM webhook) lands a write that
   *  touches an identity. Resolves the canonical identity_key(s)
   *  via the source's identity_extractor in registry walk; for every
   *  perspective topic with `valid_scopes.includes(scope)`, marks
   *  rows keyed on those identities stale + enqueues recompute.
   *  Idempotent. */
  cascadeForIdentityChange(
    scope: EnrichmentScope,
    source_id: string,
    identity_keys: ReadonlyArray<string>,
  ): CascadeResult;
  /** D-136 §A.5 P5 — fired when a connection record is deleted
   *  (user-disconnect or vendor-revoke; same path). Tombstones the
   *  scenario rows scoped directly to the connection (`scope ===
   *  connection.<kind>` AND `target_id === connection_name`); fans
   *  out perspective topics whose `aggregates_from` list includes a
   *  `connection.<kind>` entry by enqueuing recompute.
   *
   *  D-136 P6 — when `vendor` is supplied (the connection's
   *  `subtype` field, e.g. `'hubspot'` / `'salesforce'`) and
   *  `connection_kind === 'api'`, ALSO tombstones every chain-head
   *  row whose scope matches `connection.api.<vendor>.<entity>` for
   *  any entity registered in `CONNECTION_VENDOR_ENTITIES`. Today
   *  the warehouse keeps one connection per vendor, so vendor-scope
   *  cleanup tombstones the entire vendor's enrichment surface.
   *  When the warehouse adds multi-connection-per-vendor (sandbox +
   *  prod accounts side-by-side), this widens to filter by
   *  target_id-prefix or per-row `connection_name` membership; the
   *  cascade primitive's signature stays the same. */
  cascadeForConnectionDelete(
    connection_kind: 'api' | 'mcp' | 'notification',
    connection_name: string,
    vendor?: string,
  ): CascadeResult;
  /** Round-12 audit fix (T1 § 8.1) — the ONE all-or-nothing per-topic
   *  queue-depth admission for a topic-wide recompute enqueue: count the
   *  REAL fan-out, read the current pending depth, reserve against the
   *  budget governor, and admit only when the FULL fan-out fits (the P5b
   *  all-or-nothing semantic — partial admission would let any topic with
   *  headroom bypass the cap). The engine's own topic-wide sites consult
   *  it, and the D-136 P4 drift producer consults it through the
   *  housekeeping ctx BEFORE its signal+enqueue transaction — the third
   *  writer previously enqueued bare, which is exactly the two-copies
   *  shape where one path keeps admitting after another stops.
   *  `admitted: true` with `candidates: 0` means "nothing to reserve —
   *  proceed" (the enqueue will write zero rows). */
  reserveTopicRecomputeAdmission(topic: string): TopicRecomputeAdmission;
  /** D-136 §A.14.1 P5b — fired when an external context pulse
   *  (vendor API state, MCP tool result, periodic-check signal)
   *  changes. The cascade walks the producer-context dependency
   *  registry passed to the engine; for every producer topic whose
   *  manifest declares `(context_id, invalidates_on_pulse_change:
   *  true)`, marks the topic's chain-head rows stale + enqueues
   *  recompute. Honours the per-topic queue-depth ceiling. Idempotent
   *  on the steady-state set. */
  cascadeForExternalContextPulseChange(
    context_id: string,
  ): CascadeResult;
  /** D-139 P3 § A.10 — fired when an engagement event lands
   *  (created / updated / deleted / association-changed via webhook,
   *  CometD, or the reconciler cycle). The
   *  engagement substrate stores rows + edges in dedicated tables
   *  outside the enrichment table; this primitive walks the
   *  engagement_edges set for the engagement (via the supplied
   *  edge lookup) → for each (target_scope, target_id) tuple
   *  derived from the edge → walks aggregate-policy topics whose
   *  `aggregates_from` references the engagement's per-type source
   *  scope AND whose `valid_scopes` includes the target scope →
   *  enumerates the per-target rows + flips them to
   *  `lifecycle_action_pending = 'recompute'` per the standard
   *  P5/P5b discipline.
   *
   *  The cascade is connection-scoped per § A.4 — the edge lookup
   *  filters by `connection_id` so two HubSpot portals on the same
   *  server invalidate independently.
   *
   *  Codex P1 #2 fold — `opts.extra_edge_targets` carries edges
   *  that were JUST tombstoned in the same write transaction so
   *  the cascade also invalidates aggregates scoped to the dropped
   *  deal/account/contact (the lookup callback returns only LIVE
   *  edges; without this passthrough removed targets miss cascade).
   *
   *  Idempotent on the steady-state set: pinned + already-stale
   *  rows skip in the SQL filter. The notifier fires once per
   *  cascade with `reason: 'engagement_event'`. */
  cascadeForEngagementEvent(
    engagement_scope: EnrichmentScope,
    engagement_target_id: string,
    connection_id: string,
    opts?: {
      extra_edge_targets?: ReadonlyArray<EngagementEdgeForCascade>;
    },
  ): CascadeResult;
}

/** D-139 P3 — `cascadeForEngagementEvent` callback shape for the
 *  edge lookup. Bin.ts wires this to `engagementStore.listEdges`
 *  with the `(connection_id, engagement_target_id)` pair; tests
 *  inject inline arrays. The cascade is engine-internal; the
 *  callback's job is just to surface the substrate's edges to the
 *  cascade engine without enrichment-cascade.ts taking a direct
 *  dependency on the engagement-store module. */
export interface EngagementEdgeLookupForCascade {
  edges(
    connection_id: string,
    engagement_target_id: string,
  ): ReadonlyArray<EngagementEdgeForCascade>;
}

/** D-139 P3 — minimal projection of an engagement edge required by
 *  the cascade engine. Maps to a subset of the substrate's
 *  `EngagementEdge` columns; scope-derivation parses the
 *  `<vendor>_<entity>_<raw_id>` target_id shape per § A.4. */
export interface EngagementEdgeForCascade {
  edge_type: 'contact' | 'deal' | 'account' | 'owner' | 'mail_twin' | 'calendar_twin';
  target_kind: 'data.contact' | 'connection.api' | 'data.mail' | 'data.calendar' | 'user';
  target_id: string;
  /** Tombstoned edges (CRM-side disassociation observed) MUST be
   *  pre-filtered by the supplier — cascade walks live edges only.
   *  The lookup callback in production passes
   *  `include_deleted: false` (the default) on listEdges. */
}

export interface CreateEnrichmentCascadeOptions {
  notifier?: CascadeInvalidationNotifier;
  /** D-136 §A.5 P5b — fan-out governor enforcing the per-identity rate
   *  ceiling + per-topic queue-depth ceiling. Optional — absent
   *  collapses to `NO_OP_CASCADE_BUDGET_GOVERNOR` (pre-P5b cascade
   *  behavior, no caps). Production wires from the
   *  `housekeeping_config.cascade_*` columns; tests inject inline. */
  governor?: CascadeBudgetGovernor;
  /** D-136 §A.5 P5b — clock for the rate window. Defaults to
   *  `Date.now`; tests inject for determinism. */
  now?: () => number;
  /** D-136 §A.14.1 P5b — producer → external context dependency
   *  registry. Drives `cascadeForExternalContextPulseChange`. Optional
   *  — absent means the primitive is a no-op (no producer has
   *  declared a context dependency). Production wires from the
   *  enrichment-producer registration pass in `bin.ts`; tests inject
   *  inline. */
  externalContextRegistry?: ExternalContextDependencyRegistry;
  /** D-139 P3 § A.10 — engagement edge lookup for
   *  `cascadeForEngagementEvent`. Optional — absent means the
   *  primitive is a no-op (no engagement substrate enrolled).
   *  Production wires from `engagementStore.listEdges` in
   *  `bin.ts`; tests inject inline arrays. */
  engagementEdgeLookup?: EngagementEdgeLookupForCascade;
  /** D-192 — live merged vendor-entity registry accessor. `deriveScopeFromEdge`
   *  consults it to confirm a deal/account edge's parsed vendor prefix is a
   *  registered vendor before forming its mirror scope (the registry replacement
   *  for the hardcoded `vendor === 'hubspot' || 'salesforce'` guard), so a
   *  pack-declared CRM's edges cascade with no code edit. Optional — absent
   *  falls back to the shipped built-ins (`CONNECTION_VENDOR_ENTITIES`). */
  resolveVendorRegistry?: () => ReadonlyArray<ConnectionVendorEntity>;
}

export const createEnrichmentCascade = (
  store: EnrichmentStore,
  notifierOrOpts?: CascadeInvalidationNotifier | CreateEnrichmentCascadeOptions,
): CascadeEngine => {
  // Back-compat: prior signature accepted a notifier function as the
  // second arg. Detect by typeof — `function` → legacy callsite,
  // `object` → new options bag.
  const opts: CreateEnrichmentCascadeOptions =
    typeof notifierOrOpts === 'function'
      ? { notifier: notifierOrOpts }
      : (notifierOrOpts ?? {});
  const notifier = opts.notifier;
  const governor: CascadeBudgetGovernor =
    opts.governor ?? NO_OP_CASCADE_BUDGET_GOVERNOR;
  const now = opts.now ?? ((): number => Date.now());
  const externalContextRegistry = opts.externalContextRegistry;
  const engagementEdgeLookup = opts.engagementEdgeLookup;
  const resolveVendorRegistry = opts.resolveVendorRegistry;

  // P5b — per-topic pending-depth lookup. The store returns an array
  // of `{topic, count}`; we collapse per call into a quick map for
  // O(1) lookup. Recomputed each cascade fire to stay current with
  // concurrent enqueues from sibling primitives. Returns 0 for
  // topics absent from the result (no pending rows yet).
  const pendingDepthForTopic = (topic: string): number => {
    const counts = store.countLifecycleActionPendingByTopic();
    const hit = counts.find((c) => c.topic === topic);
    return hit ? hit.count : 0;
  };

  // Round-12 audit fix (T1 § 8.1) — the ONE all-or-nothing topic-wide
  // admission predicate. Extracted from the two P5b sites below (which had
  // the identical shape hand-copied) so the drift producer's third write
  // path consults the SAME governor instead of enqueuing bare.
  const reserveTopicRecomputeAdmission = (topic: string): TopicRecomputeAdmission => {
    const candidates = store.countTopicEnqueueCandidates(topic);
    if (candidates === 0) return { admitted: true, candidates: 0, dropped: 0 };
    const currentDepth = pendingDepthForTopic(topic);
    const queueRes = governor.reserveForTopic(topic, candidates, currentDepth);
    if (queueRes.admitted < candidates) {
      return { admitted: false, candidates, dropped: queueRes.dropped };
    }
    return { admitted: true, candidates, dropped: 0 };
  };

  const fireNotifier = (hint: CascadeInvalidationHint): void => {
    if (!notifier) return;
    try {
      notifier(hint);
    } catch {
      // Best-effort. Cascade callers (record delete, recipe upgrade)
      // must not abort because of a downstream housekeeping fault.
    }
  };

  const cascadeForSourceDelete = (
    scope: EnrichmentScope,
    source_id: string,
  ): CascadeResult => {
    const result = emptyResult();

    // D-145 § A.7.9 — universal source-delete cascade. Iterate every
    // per-record topic whose `valid_scopes` includes the deleted
    // source's scope and drop rows where `target_id === source_id`.
    // Previously the gate fired for `dependent` only; the audit of all
    // 41 PA9 producers confirmed every per-record topic carries
    // current-state semantics, so preserving an aggregate row whose
    // source is gone reads as a leak, not preservation. `independent`
    // stays excluded by design: no source linkage by definition (and
    // all current `independent` topics are derived_entity, already
    // filtered out by the shape check above). `members_list` is
    // handled by the trim loop below.
    const deletedTopics: Set<EnrichmentTopic> = new Set();
    forEachTopic((topic, def) => {
      if (def.shape !== 'per_record') return;
      if (def.policy === 'independent') return;
      if (def.policy === 'members_list') return;
      if (!def.valid_scopes!.includes(scope)) return;
      deletedTopics.add(topic);
    });
    if (deletedTopics.size > 0) {
      for (const topic of deletedTopics) {
        const rows = store.list({
          topic,
          scope,
          target_id: source_id,
          fresh_only: false,
        });
        for (const row of rows) {
          if (store.deleteById(row._id)) result.rows_deleted += 1;
        }
      }
    }

    // members_list cascade — trim source_id from every owning row.
    forEachTopic((topic, def) => {
      if (def.policy !== 'members_list') return;
      if (def.members_scope !== scope) return;
      const counts = store.trimMember(topic, source_id);
      result.members_trimmed += counts.trimmed;
      result.members_emptied_deleted += counts.deleted;
      result.rows_deleted += counts.deleted;
    });

    // `independent` policy — no-op by definition (no source linkage;
    // producer owns row lifecycle).

    // D-123 P6 — notify housekeeping tasks. Fired unconditionally
    // even when no enrichment row was touched: a producer's stale-
    // sweep / cursor-bound task may still need to revisit the
    // source-side change (the harness's onInvalidate is a no-op,
    // but the wrapper flips status so the next cycle re-walks).
    fireNotifier({ scope, source_id, reason: 'source_delete' });
    return result;
  };

  const cascadeForSourceUpdate = (
    scope: EnrichmentScope,
    source_id: string,
    _new_hash?: string,
  ): CascadeResult => {
    const result = emptyResult();
    // Mark dependent rows stale; drop their sidecars. We don't know
    // if the producer will rerun synchronously, so the stale flag
    // gates `fresh_only` reads until then.
    forEachTopic((topic, def) => {
      if (def.shape !== 'per_record') return;
      if (def.policy !== 'dependent') return;
      if (!def.valid_scopes!.includes(scope)) return;
      const rows = store.list({ topic, scope, target_id: source_id, fresh_only: false });
      for (const _row of rows) {
        // Use store.markStaleForSource which scopes to the (scope,
        // target_id) — narrower than per-row, fewer prepared-statement
        // round trips. We still need to gate by topic since shape A
        // aggregate topics share the same (scope, target_id) — but
        // those are no-op per policy. We narrow by querying the
        // matching dependent rows explicitly.
        // (We track by counting list().length; the actual SQL marks
        // every shape-A row at `(scope, target_id)`.)
      }
      // The single markStaleForSource call is cheap and idempotent;
      // aggregate rows at the same (scope, target_id) get marked too,
      // and post-D-145 § A.7.9 the stale-row sweep re-derives them on
      // the next cycle (was: aggregate producers ignored stale and
      // relied on recompute cadence). The narrower "dependent only"
      // count tracked in result.rows_marked_stale still reflects the
      // 1:1-source-tied set the cascade is primarily responsible for;
      // overshoot onto same-keyed aggregate rows is correct, not a
      // bug.
      if (rows.length > 0) {
        result.rows_marked_stale += rows.length;
      }
    });
    // Single SQL pass marks every shape-A row at `(scope, source_id)`
    // stale + drops sidecars in one go. The per-topic count above
    // tracks the dependent subset for the result audit.
    if (result.rows_marked_stale > 0) {
      store.markStaleForSource(scope, source_id);
    }
    fireNotifier({ scope, source_id, reason: 'source_update' });
    return result;
  };

  const cascadeForRecipeUpgrade = (recipe_id: string): CascadeResult => {
    const result = emptyResult();
    result.rows_marked_stale = store.markStaleByAuthor(recipe_id);
    // P6 — `source_id` carries the recipe_id for `recipe_upgrade`
    // hints. `deterministic-risk-patterns.onInvalidate` reads it
    // verbatim to clear the matching risk annotation.
    fireNotifier({ source_id: recipe_id, reason: 'recipe_upgrade' });
    return result;
  };

  // ── D-136 §A.5 P5 cascade primitives ──────────────────────────────
  //
  // Idempotency contract (audit §24.1 A1): every primitive is
  // column-state-driven. The store layer's `markStaleAndEnqueueByRowIds`
  // SQL filters `WHERE lifecycle_action_pending IS NULL` so a second
  // call against the same row (out-of-order webhook, bundle-restore
  // replay) flips zero rows; the result count reflects this. The
  // tombstone path's `WHERE tombstoned_at IS NULL` filter has the
  // same shape. Pinned rows (`is_pinned = 1`) skip per §A.11 —
  // user-correction writes are protected from cascade-driven
  // recompute / tombstone.

  const cascadeForProducerUpgrade = (
    producer_kind: string,
    producer_name: string,
    old_version_hash: string,
  ): CascadeResult => {
    const result = emptyResult();
    if (typeof old_version_hash !== 'string' || old_version_hash.length === 0) {
      // No-op — guards against an undefined hash from a producer
      // wrapper that never stamped a row before being upgraded.
      return result;
    }
    const ids = store.listChainHeadRowIdsByProducerVersion(old_version_hash);
    if (ids.length > 0) {
      const enqueued = store.markStaleAndEnqueueByRowIds(ids, 'recompute');
      // Report only rows actually flipped — pinned + already-pending
      // rows skip in the SQL filter, so a re-fire over the same set
      // returns 0 here even though `ids.length` is positive. Without
      // this, no-op cascades would falsely advertise stale work for
      // observability + idempotency assertions.
      result.rows_marked_stale = enqueued;
      result.rows_lifecycle_action_enqueued = enqueued;
    }
    fireNotifier({
      source_id: `${producer_kind}:${producer_name}@${old_version_hash}`,
      reason: 'producer_upgrade',
    });
    return result;
  };

  const cascadeForUpstreamEnrichment = (upstream_row_id: string): CascadeResult => {
    const result = emptyResult();
    if (typeof upstream_row_id !== 'string' || upstream_row_id.length === 0) {
      return result;
    }
    const ids = store.listConsumerRowIdsOfUpstream(upstream_row_id);
    if (ids.length > 0) {
      const enqueued = store.markStaleAndEnqueueByRowIds(ids, 'recompute');
      result.rows_marked_stale = enqueued;
      result.rows_lifecycle_action_enqueued = enqueued;
    }
    fireNotifier({ source_id: upstream_row_id, reason: 'upstream_enrichment' });
    return result;
  };

  const cascadeForIdentityChange = (
    scope: EnrichmentScope,
    source_id: string,
    identity_keys: ReadonlyArray<string>,
  ): CascadeResult => {
    const result = emptyResult();
    if (identity_keys.length === 0) return result;
    // P5b — per-identity rate ceiling. Each identity_key reserves
    // its own slot in the governor's 1-second window; a hot identity
    // (a contact with many mail events arriving in quick succession)
    // is bounded so cascade fan-out can't multiply the work without
    // adding signal. Per-topic queue-depth check below adds the
    // second ceiling.
    const tNow = now();
    const allowedKeys: string[] = [];
    let rateDropped = 0;
    for (const key of identity_keys) {
      const reservation = governor.reserveForIdentity(key, 1, tNow);
      if (reservation.admitted > 0) {
        allowedKeys.push(key);
      }
      rateDropped += reservation.dropped;
    }
    result.rows_rate_limited += rateDropped;
    if (allowedKeys.length === 0) {
      // All identities were rate-limited — still fire the notifier so
      // observability sees the cascade attempt.
      fireNotifier({ scope, source_id, reason: 'identity_change' });
      return result;
    }
    // Walk the registry to find perspective topics that AGGREGATE
    // from this scope (i.e. their `aggregates_from` declares the
    // source-side scope as a contributor). The cascade fans into
    // per-identity rows of each matching topic. Per audit §23.5,
    // this is the missing primitive that closes the perspective
    // fan-in gap — pre-D-136 a new mail arriving never invalidated
    // `behavioral_signature` for the contact's identity, because
    // `behavioral_signature.valid_scopes = ['contact']` (the
    // perspective row's scope) and `cascadeForSourceUpdate` walks
    // by `valid_scopes`, not by `aggregates_from`. D-136 closes
    // the gap with this primitive.
    forEachTopic((topic, def) => {
      if (def.identity_aggregation !== 'perspective') return;
      if (!def.aggregates_from || !def.aggregates_from.includes(scope)) return;
      const ids = store.listChainHeadRowIdsByTopicAndTargets(
        topic,
        allowedKeys,
      );
      if (ids.length === 0) return;
      // P5b — per-topic queue-depth ceiling. Read current pending
      // count via the store + ask the governor what fits. Capped
      // overflow is dropped at SQL time (we hand the truncated id
      // list to the store).
      const currentDepth = pendingDepthForTopic(topic);
      const queueRes = governor.reserveForTopic(topic, ids.length, currentDepth);
      const accepted = ids.slice(0, queueRes.admitted);
      result.rows_queue_depth_capped += queueRes.dropped;
      if (accepted.length === 0) return;
      const enqueued = store.markStaleAndEnqueueByRowIds(accepted, 'recompute');
      result.rows_marked_stale += enqueued;
      result.rows_lifecycle_action_enqueued += enqueued;
    });
    fireNotifier({ scope, source_id, reason: 'identity_change' });
    return result;
  };

  const cascadeForConnectionDelete = (
    connection_kind: 'api' | 'mcp' | 'notification',
    connection_name: string,
    vendor?: string,
  ): CascadeResult => {
    const result = emptyResult();
    if (typeof connection_name !== 'string' || connection_name.length === 0) {
      return result;
    }
    // `directScope` narrows to the closed-list connection-segment
    // strings. Typed as `EnrichmentScope` so the registry-side
    // `aggregates_from.includes(directScope)` check below typechecks
    // against the registry's closed-list element type.
    const directScope: EnrichmentScope =
      connection_kind === 'api'
        ? 'connection.api'
        : connection_kind === 'mcp'
          ? 'connection.mcp'
          : 'connection.notification';
    // Tombstone scenario rows scoped to `(connection.<kind>,
    // connection_name)`. Per spec §A.5, scenario rows always
    // tombstone-with-id (preserves D-120 link graph); recompute is
    // not meaningful since the source is gone.
    const directIds = store.listChainHeadRowIdsByScopeAndTarget(
      directScope,
      connection_name,
    );
    if (directIds.length > 0) {
      result.rows_tombstoned = store.tombstoneRowIds(directIds, 'cascade_delete');
      // Tombstone flips `staleness_class = 'expired'`; the same SQL
      // filter (pinned + already-tombstoned) discards no-op rows.
      // Report only rows actually changed.
      result.rows_marked_stale += result.rows_tombstoned;
    }
    // P6 — vendor-entity scope cleanup. When the deleted connection
    // is an api connection AND the caller passed the vendor
    // identifier (the connection row's `subtype`), tombstone the
    // platform-reference enrichment rows for THIS connection under
    // `connection.api.<vendor>.<entity>`. The scope is shared across a
    // vendor's connections (the per-connection discriminator lives in
    // `target_id`, D-190), so we filter by the connection's
    // `<vendor>_<entity>_<connection_name>_` prefix — tombstoning the
    // whole scope would wipe a SIBLING same-vendor connection's
    // enrichment surface (D-192 fix). `meta_fields` aren't touched —
    // only the enrichment values + sidecars cleared per audit §10.2
    // tombstone-with-id semantics.
    //
    // Every platform-reference `data_enrichment` row IS connection-
    // qualified (D-190 — every CRM reconciler / webhook composes the id
    // via `composePlatformRecordTargetId`), so the prefix cut is exact
    // for every entry that can carry rows. The loop still walks the full
    // `CONNECTION_VENDOR_ENTITIES` list including ENGAGEMENT entities
    // (email / meeting / call / note / task) — harmless: no topic lists
    // an engagement scope in `valid_scopes` (they appear only as an
    // aggregate's `aggregates_from`), so `enrichment.upsert` REJECTS any
    // write there — `data_enrichment` can hold ZERO rows under an
    // engagement scope. Engagement DATA lives in the engagement store,
    // torn down by the D-129/130 `tombstoneEngagementRowsForConnection`
    // hook (connection_id-keyed), never here.
    if (connection_kind === 'api' && typeof vendor === 'string' && vendor.length > 0) {
      for (const entry of CONNECTION_VENDOR_ENTITIES) {
        if (entry.vendor !== vendor) continue;
        const ids = store.listChainHeadRowIdsByScopeAndTargetPrefix(
          entry.scope,
          composeConnectionTargetIdPrefix(vendor, entry.entity, connection_name),
        );
        if (ids.length === 0) continue;
        const tombstoned = store.tombstoneRowIds(ids, 'cascade_delete');
        result.rows_tombstoned += tombstoned;
        result.rows_marked_stale += tombstoned;
      }
    }
    // Fan out perspective topics whose `aggregates_from` includes
    // a `connection.<kind>` entry. They lose one contributing
    // source; recompute drops the connection's contribution from
    // the perspective fold. Without a vendor → identity reverse-map
    // (lands at P6 with the per-vendor connection-delete hook), we
    // can't narrow to just identities the connection touched —
    // every chain head of the perspective topic is in scope.
    // `enqueueLifecycleActionForTopic` filters chain head + non-pinned
    // for free.
    //
    // P5b — per-topic queue-depth ceiling. The store-side
    // `enqueueLifecycleActionForTopic` doesn't know about the cap;
    // we pre-check via `countTopicEnqueueCandidates` to size the
    // governor reservation against the REAL fan-out (not 1), then
    // skip if the full fan-out doesn't fit (all-or-nothing
    // semantic). Codex P5b review fix — earlier code reserved 1
    // slot per topic, which let topics with any headroom bypass the
    // cap when their actual fan-out was thousands of rows.
    forEachTopic((topic, def) => {
      if (def.identity_aggregation !== 'perspective') return;
      if (!def.aggregates_from || !def.aggregates_from.includes(directScope)) {
        return;
      }
      const admission = reserveTopicRecomputeAdmission(topic);
      if (admission.candidates === 0) return;
      if (!admission.admitted) {
        // All-or-nothing — skip the topic entirely. The governor's
        // dropped count records what we passed up; the next cascade
        // fire (or operator pruning the queue) will pick the work
        // back up under fresh headroom.
        result.rows_queue_depth_capped += admission.dropped;
        return;
      }
      const enqueued = store.enqueueLifecycleActionForTopic(topic, 'recompute');
      result.rows_lifecycle_action_enqueued += enqueued;
    });
    fireNotifier({
      scope: directScope,
      source_id: connection_name,
      reason: 'connection_delete',
    });
    return result;
  };

  // ── §A.14.1 P5b — external context pulse cascade ─────────────────
  //
  // Walks the producer-context dependency registry passed at
  // construction; for every topic that consumes the changed
  // context_id WITH `invalidates_on_pulse_change: true`, marks the
  // topic's chain-head rows stale + enqueues recompute. Each topic
  // gets an independent per-topic queue-depth check from the budget
  // governor. Notifier fires once with `reason:
  // 'external_context_pulse_change'` carrying `source_id =
  // context_id`.
  //
  // The dependency-registry stores BOTH consumers + the invalidates
  // flag; `invalidatingConsumersOf` returns only topics whose
  // declaration carried `invalidates_on_pulse_change: true`.
  // Advisory-only consumers (`invalidates_on_pulse_change: false`)
  // are skipped so their rows aren't pointlessly recomputed on every
  // pulse change.

  const cascadeForExternalContextPulseChange = (
    context_id: string,
  ): CascadeResult => {
    const result = emptyResult();
    if (typeof context_id !== 'string' || context_id.length === 0) {
      return result;
    }
    if (!externalContextRegistry) return result;
    const consumers = externalContextRegistry.invalidatingConsumersOf(context_id);
    for (const topic of consumers) {
      // Per-topic queue-depth governor — same shape as
      // `cascadeForConnectionDelete`. Reserve against the REAL
      // fan-out (Codex P5b review fix) so the per-topic queue-depth
      // ceiling can't be bypassed by a topic with any headroom.
      // All-or-nothing semantic: skip if the full fan-out doesn't
      // fit.
      const admission = reserveTopicRecomputeAdmission(topic);
      if (admission.candidates === 0) continue;
      if (!admission.admitted) {
        result.rows_queue_depth_capped += admission.dropped;
        continue;
      }
      const enqueued = store.enqueueLifecycleActionForTopic(topic, 'recompute');
      result.rows_lifecycle_action_enqueued += enqueued;
    }
    fireNotifier({
      source_id: context_id,
      reason: 'external_context_pulse_change',
    });
    return result;
  };

  // ── §A.10 (D-139 P3) — engagement-event cascade ─────────────────
  //
  // Walks the engagement_edges set (via the supplied edge lookup
  // callback) for the engagement; for each (target_scope, target_id)
  // tuple derived from an edge, walks aggregate-policy topics whose
  // `aggregates_from` references the engagement's per-type source
  // scope AND whose `valid_scopes` includes the target scope, and
  // marks per-target rows stale + enqueues recompute. Connection-
  // scoped per § A.4 — the lookup callback enforces the
  // `connection_id` filter.
  //
  // Edge → (target_scope, target_id) derivation:
  //   - edge_type='deal'      → target_scope = `connection.api.<vendor>.deal`
  //                              | `connection.api.<vendor>.opportunity`
  //                              (Salesforce); target_id = edge.target_id
  //                              verbatim (e.g. `hubspot_deal_47291`)
  //   - edge_type='account'   → target_scope = `connection.api.<vendor>.company`
  //                              (HubSpot) | `connection.api.<vendor>.account`
  //                              (Salesforce); target_id = edge.target_id
  //   - edge_type='contact'   → target_scope = `'contact'` (D-121
  //                              canonical-email keyed); target_id = edge
  //                              .target_id (canonical email post-
  //                              D-138 redirect)
  //   - edge_type='owner'     → SKIP — owners aren't aggregate-
  //                              enrichment targets (D-139 v1 has no
  //                              per-owner enrichments in `aggregates_from`)
  //   - edge_type='mail_twin' /
  //              'calendar_twin' → SKIP — those edges drive cross-
  //                              source producer wiring (P4 cross-entity)
  //                              not aggregate cascade.
  //
  // Pinned + already-stale rows skip per the SQL filter discipline
  // documented above. Idempotent on the steady-state set.

  const cascadeForEngagementEvent = (
    engagement_scope: EnrichmentScope,
    engagement_target_id: string,
    connection_id: string,
    opts?: { extra_edge_targets?: ReadonlyArray<EngagementEdgeForCascade> },
  ): CascadeResult => {
    const result = emptyResult();
    if (
      typeof engagement_scope !== 'string'
      || engagement_scope.length === 0
      || typeof engagement_target_id !== 'string'
      || engagement_target_id.length === 0
      || typeof connection_id !== 'string'
      || connection_id.length === 0
    ) {
      return result;
    }
    const extraEdges = opts?.extra_edge_targets ?? [];
    if (!engagementEdgeLookup && extraEdges.length === 0) return result;

    // Resolve aggregate topics whose `aggregates_from` references the
    // engagement's per-type scope. Pre-walk the registry once per
    // call — registry is small, walking is cheap.
    type CandidateTopic = {
      topic: EnrichmentTopic;
      def: EnrichmentDefinition;
    };
    const candidateTopics: CandidateTopic[] = [];
    forEachTopic((topic, def) => {
      if (def.policy !== 'aggregate') return;
      if (!def.aggregates_from || !def.aggregates_from.includes(engagement_scope)) {
        return;
      }
      candidateTopics.push({ topic, def });
    });
    if (candidateTopics.length === 0) {
      // No aggregate topic consumes this engagement scope — nothing
      // to invalidate. Notifier still fires for observability.
      fireNotifier({
        scope: engagement_scope,
        source_id: engagement_target_id,
        reason: 'engagement_event',
      });
      return result;
    }

    const liveEdges = engagementEdgeLookup
      ? engagementEdgeLookup.edges(connection_id, engagement_target_id)
      : [];

    // Aggregate per-(target_scope, target_id) tuples from edges. A
    // single engagement may have multiple edges of the same kind
    // (multi-deal email engagement); dedupe before per-topic
    // enumeration to avoid double-flipping the same row. Codex P1 #2
    // fold — fold extra_edge_targets (just-tombstoned edges) into the
    // same set so removed targets get invalidated alongside live ones.
    type EdgeTuple = { scope: EnrichmentScope; target_id: string };
    const seenTuples = new Set<string>();
    const tuples: EdgeTuple[] = [];
    const allEdges: ReadonlyArray<EngagementEdgeForCascade> = [
      ...liveEdges,
      ...extraEdges,
    ];
    // D-192 — live merged registry (built-ins + installed packs), read once per
    // event; falls back to the shipped built-ins when unwired.
    const vendorRegistry = resolveVendorRegistry?.() ?? CONNECTION_VENDOR_ENTITIES;
    for (const edge of allEdges) {
      const tuple = deriveScopeFromEdge(edge, vendorRegistry);
      if (tuple === null) continue;
      const key = `${tuple.scope}\x1f${tuple.target_id}`;
      if (seenTuples.has(key)) continue;
      seenTuples.add(key);
      tuples.push(tuple);
    }
    if (tuples.length === 0) {
      fireNotifier({
        scope: engagement_scope,
        source_id: engagement_target_id,
        reason: 'engagement_event',
      });
      return result;
    }

    // Per-topic per-tuple enumeration + flip. The store.list call
    // narrows by (topic, scope, target_id); the result is the
    // chain-head row(s) at that key. Per-topic queue-depth governor
    // gates each topic's fan-out.
    for (const { topic, def } of candidateTopics) {
      // Filter tuples to scopes this topic's `valid_scopes` accepts.
      const acceptedTuples = tuples.filter((t) =>
        def.valid_scopes !== undefined && def.valid_scopes.includes(t.scope),
      );
      if (acceptedTuples.length === 0) continue;

      const idsToFlip: string[] = [];
      for (const tuple of acceptedTuples) {
        const ids = store.listChainHeadRowIdsByScopeAndTarget(
          tuple.scope,
          tuple.target_id,
        );
        // listChainHeadRowIdsByScopeAndTarget returns rows for ANY
        // topic at that (scope, target_id); filter to this topic.
        const filtered = filterRowIdsByTopic(store, ids, topic);
        for (const id of filtered) idsToFlip.push(id);
      }
      if (idsToFlip.length === 0) continue;

      // Per-topic queue-depth governor — same shape as
      // `cascadeForConnectionDelete`. All-or-nothing semantic
      // (consistent with §A.14.1 P5b path); per-tuple partial
      // admission would surface as flaky cascade fan-out.
      const currentDepth = pendingDepthForTopic(topic);
      const queueRes = governor.reserveForTopic(
        topic,
        idsToFlip.length,
        currentDepth,
      );
      if (queueRes.admitted < idsToFlip.length) {
        result.rows_queue_depth_capped += queueRes.dropped;
        continue;
      }
      const enqueued = store.markStaleAndEnqueueByRowIds(idsToFlip, 'recompute');
      result.rows_marked_stale += enqueued;
      result.rows_lifecycle_action_enqueued += enqueued;
    }

    fireNotifier({
      scope: engagement_scope,
      source_id: engagement_target_id,
      reason: 'engagement_event',
    });
    return result;
  };

  return {
    cascadeForSourceDelete,
    cascadeForSourceUpdate,
    cascadeForRecipeUpgrade,
    cascadeForProducerUpgrade,
    cascadeForUpstreamEnrichment,
    cascadeForIdentityChange,
    cascadeForConnectionDelete,
    cascadeForExternalContextPulseChange,
    cascadeForEngagementEvent,
    reserveTopicRecomputeAdmission,
  };
};
