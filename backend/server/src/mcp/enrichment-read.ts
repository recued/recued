/** D-136 §A.13.2 + §A.13.3 P7.D + §A.14.5 P7.F — `mcp.enrichment.read` handler.
 *
 *  Single-row enrichment read with three time-axis filters:
 *    - `as_of` — point-in-time read via P7.C `getRowAsOf`. Walks the
 *      supersede chain to find the row whose `[event_at,
 *      superseded_event_at)` covers the timestamp.
 *    - `coherent_at` — single-topic coherent read. Returns the row
 *      whose `computed_at <= coherent_at` (today, derived from
 *      `last_evaluated_at` or `authored_at`).
 *    - `include_historical` — full supersede chain via P7.C `getChain`.
 *      Mutually exclusive with `coherent_at`.
 *
 *  Every result row carries the bistemporal-metadata bundle
 *  (`MCPEnrichmentReadResult`) per §A.13.2 — the contract that makes
 *  agent citations real. Bundle assembly composes:
 *    - storage row fields (id / topic / scope / target_id / event_at /
 *      ingested_at / staleness / hashes)
 *    - `computed_at` derived from `last_evaluated_at` (P3) falling
 *      back to `authored_at` for legacy rows
 *    - `confidence` extracted from the row value when the topic is
 *      flagged `emits_confidence` (D-133)
 *    - `drift_severity` from the latest `confidence_drift_signal` row
 *      keyed on the row's topic (when the topic emits confidence)
 *    - `user_pinned` from `is_pinned` flag (P7.A)
 *    - `staleness_reason` mapped from the row's
 *      `lifecycle_action_pending` (cascade_pending / producer_failed /
 *      cadence_due — best-effort label per spec §A.13.2)
 *
 *  P7.F — freshness-budget gate (§A.14.5). When `freshness_budget_ms`
 *  is supplied, the substrate dispatches the staleness axis by the
 *  topic's `temporal_class`:
 *    - stable_truth → `now - computed_at`
 *    - time_bound → `now - as_of`
 *    - aggregate_window → `now - as_of`, with `staleness_axis:
 *      'window_drift'` when `(now - as_of) > recompute_cadence`
 *
 *  Out-of-budget reads return `result: null` plus a
 *  `fall_through_hint` describing where the agent should fall through
 *  to raw. Reasons: `'no_row'` (warehouse empty), `'freshness_budget_exceeded'`
 *  (row too old on dispatched axis), `'topic_private'` (out-of-band agent
 *  plan hit a private topic; budget opts into graceful degradation
 *  instead of the §A.13.5 hard-throw).
 *
 *  Read-cost-zero invariant (§A.13.6): handler signature carries no
 *  LLM dep; `EnrichmentStore` reads are pure SQL. Test ratchet at
 *  P7.D close enforces structurally.
 *
 *  Spec: docs/d-136-spec.md §A.13.3 + §A.13.2 + §A.14.5. */

import {
  RpcError,
  cadenceToMs,
  getEnrichmentDefinition,
  isEnrichmentTopic,
  isGrantedReadAdmissible,
  isPlatformReferenceScope,
  parseVendorEntityScope,
  ENRICHMENT_PINNED_AUTHOR_PREFIX,
  type EnrichmentReadFallThroughHint,
  type EnrichmentReadRpcInput,
  type EnrichmentReadRpcOutput,
  type EnrichmentScope,
  type EnrichmentTopic,
  type MCPEnrichmentReadResult,
} from '@recued/contracts';
import type {
  EnrichmentRecord,
  EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  AUTHOR_DEFAULT_READ_GRANT_CHECKER,
  type ReadGrantChecker,
} from '../read-grant-checker.js';

/** D-187 slice-3 read gate — the VERB-OP that gates the `enrichmentRead` native
 *  tool ("may this contract use enrichmentRead at all"). Composed with the topic's
 *  read-grant via {@link isReadAdmissible}: a topic grant does NOT imply the verb. */
const ENRICHMENT_READ_VERB_OP = 'core.data.enrichment.read';

/** D-187 slice-3 read gate composition for this tool — `verb-op grant ∧ topic grant`
 *  ({@link isGrantedReadAdmissible}). The two reject sites (the hard throw + the
 *  freshness-budget fall-through hint) share this so they can't drift: a contract
 *  denied EITHER the verb-op OR the topic is not admitted to read the topic. */
const isReadAdmissible = (checker: ReadGrantChecker, topic: EnrichmentTopic): boolean =>
  isGrantedReadAdmissible(checker.isVerbOpGranted(ENRICHMENT_READ_VERB_OP), checker.isTopicReadGranted(topic));

/** Required deps. The store is the only one — bundle assembly reads
 *  registry metadata from the static `ENRICHMENT_REGISTRY`. D-187 AMENDMENT
 *  threads the bound door contract's per-dispatch read-grant checker
 *  (`readGrantChecker`, resolved at the dispatch boundary) so the read reject keys on
 *  the contract's unified `enrichment.<topic>` grant (folding the former scope-fence +
 *  `mcp_exposed` visibility); absent ⇒ {@link AUTHOR_DEFAULT_READ_GRANT_CHECKER} (every
 *  topic at its registry author default). */
export interface EnrichmentReadDeps {
  enrichmentStore: EnrichmentStore;
  readGrantChecker?: ReadGrantChecker;
}

/** Map a row's `lifecycle_action_pending` to the spec's
 *  `staleness_reason` enum. P5/P6's lifecycle queue persists
 *  `'recompute' | 'discard' | 'permanently_failed'` plus
 *  `retry_at_<ts>` tokens; the bundle exposes the spec-promised
 *  vocabulary instead of the raw column.
 *
 *  Mapping:
 *    - `'recompute'` → `'cascade_pending'` (cascade engine queued
 *      a refresh but the producer hasn't executed yet).
 *    - `'permanently_failed'` → `'producer_failed'`.
 *    - `'retry_at_*'` token → `'producer_failed'` (retry loop is
 *      a graduated form of the same condition).
 *    - `'discard'` → `'cascade_pending'` (queue drain will tombstone
 *      next cycle; agent reads should treat as in-flight).
 *    - null → no reason emitted; the row is steady-state.
 *
 *  When `staleness_class === 'expired'` and no LAP is set, the row is
 *  TTL-aged + due for cleanup — surface `'cadence_due'`. P7.E +
 *  follow-ups can refine these mappings as the producer telemetry
 *  surfaces sharper signals; the spec's enum is forward-stable. */
const deriveStalenessReason = (
  row: EnrichmentRecord,
): MCPEnrichmentReadResult['staleness_reason'] | undefined => {
  const lap = row.lifecycle_action_pending;
  if (lap === 'recompute' || lap === 'discard') return 'cascade_pending';
  if (lap === 'permanently_failed') return 'producer_failed';
  if (typeof lap === 'string' && lap.startsWith('retry_at_')) return 'producer_failed';
  if (row.staleness_class === 'expired') return 'cadence_due';
  return undefined;
};

/** Pull `confidence` out of a row's value when the topic flags
 *  `emits_confidence: true`. Returns `undefined` when the row's value
 *  doesn't carry a numeric `confidence` field — defensive, since
 *  legacy rows (pre-P3 retrofit) may lack it even on flagged topics. */
const extractConfidence = (
  row: EnrichmentRecord,
): number | undefined => {
  const def = getEnrichmentDefinition(row.topic);
  if (def.emits_confidence !== true) return undefined;
  const v = row.value;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const c = (v as Record<string, unknown>).confidence;
  return typeof c === 'number' && Number.isFinite(c) ? c : undefined;
};

/** Look up the latest `confidence_drift_signal` row keyed on the
 *  topic name. Drift signals are shape-B (derived_entity) keyed on
 *  the source topic name (`extractDriftSignalSourceTopic`). When the
 *  topic doesn't emit confidence, no drift signal exists by
 *  definition — skip the lookup.
 *
 *  Today returns the *latest* drift signal (head of the historical
 *  chain). The drift signal's value carries `severity:
 *  'none' | 'moderate' | 'significant'`; surfaces unchanged on the
 *  bundle. Returns undefined when there's no drift signal yet (PSI
 *  hasn't run for the topic). */
const lookupDriftSeverity = (
  store: EnrichmentStore,
  topic: EnrichmentTopic,
): MCPEnrichmentReadResult['drift_severity'] | undefined => {
  const def = getEnrichmentDefinition(topic);
  if (def.emits_confidence !== true) return undefined;
  const driftRow = store.getDerived('confidence_drift_signal', topic);
  if (!driftRow) return undefined;
  const v = driftRow.value;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const sev = (v as Record<string, unknown>).severity;
  if (sev === 'none' || sev === 'moderate' || sev === 'significant') return sev;
  return undefined;
};

/** Build the bistemporal-metadata bundle from a storage row. Pure
 *  function (modulo the optional drift-severity lookup the caller
 *  passes in for vector-search batching). The drift lookup defaults
 *  to a per-row store query; vector-search batches via a topic-level
 *  preload to avoid N+1 fan-out on result lists.
 *
 *  Tombstoned rows surface with `value: null` (passthrough — the
 *  storage row's `value` is already null after tombstone). The bundle
 *  shape doesn't distinguish tombstoned from never-written;
 *  `staleness_class === 'expired'` + `value === null` is the
 *  canonical agent-side check. */
export const assembleBundle = (
  row: EnrichmentRecord,
  driftSeverity?: MCPEnrichmentReadResult['drift_severity'],
): MCPEnrichmentReadResult => {
  const computed_at = row.last_evaluated_at ?? row.authored_at;
  const stalenessReason = deriveStalenessReason(row);
  const confidence = extractConfidence(row);
  const userPinned =
    row.is_pinned === true
    || row.authored_by.startsWith(ENRICHMENT_PINNED_AUTHOR_PREFIX);
  const result: MCPEnrichmentReadResult = {
    value: row.value,
    _id: row._id,
    topic: row.topic,
    scope: row.scope,
    target_id: row.target_id,
    event_at: row.event_at,
    as_of: row.as_of,
    ingested_at: row.ingested_at,
    computed_at,
    source_record_hash: row.source_record_hash,
    producer_version_hash: row.producer_version_hash,
    staleness_class: row.staleness_class,
  };
  if (stalenessReason !== undefined) result.staleness_reason = stalenessReason;
  if (confidence !== undefined) result.confidence = confidence;
  if (driftSeverity !== undefined) result.drift_severity = driftSeverity;
  if (userPinned) result.user_pinned = true;
  return result;
};

/** Convenience wrapper that pulls drift severity from the store. Used
 *  by single-row read paths; vector-search uses
 *  `assembleBundle` directly with a pre-fetched drift severity to
 *  avoid N store calls. */
export const assembleBundleWithDriftLookup = (
  store: EnrichmentStore,
  row: EnrichmentRecord,
): MCPEnrichmentReadResult =>
  assembleBundle(row, lookupDriftSeverity(store, row.topic));

/** Validate the input shape's identity tuple. Throws an `RpcError` so
 *  the MCP transport layer can convert to a structured error
 *  response. Mirrors the storage-layer `validateChainArgs` semantics
 *  but raises at the rpc boundary.
 *
 *  D-187 AMENDMENT — `checker` is the bound door contract's per-dispatch read-grant
 *  checker (resolved at the dispatch boundary); the read reject keys on the contract's
 *  unified `enrichment.<topic>` grant (the former scope-fence + `mcp_exposed` visibility,
 *  folded). Callers pass {@link AUTHOR_DEFAULT_READ_GRANT_CHECKER} for the author-default
 *  (the handler defaults to it when no checker is wired). */
const validateInput = (
  input: EnrichmentReadRpcInput,
  checker: ReadGrantChecker,
  isScopeSupported: (topic: string, scope: string) => boolean,
): void => {
  if (typeof input.topic !== 'string' || input.topic.length === 0) {
    throw new RpcError('bad_request', 'mcp.enrichment.read: topic is required', 400);
  }
  if (!isEnrichmentTopic(input.topic)) {
    throw new RpcError(
      'bad_request',
      `mcp.enrichment.read: unknown topic '${input.topic}'`,
      400,
    );
  }
  // P7.E §A.13.5 — reject reads on topics declared `mcp_exposed:
  // 'private'`. The error mirrors the registry-describe filter — agents
  // are told the topic isn't exposed, not that it doesn't exist; the
  // exposure metadata is part of the published contract via the
  // registry's public field.
  //
  // P7.F §A.14.5 — when `freshness_budget_ms` is set, the agent has
  // opted into graceful degradation via `fall_through_hint`. Skip the
  // throw here; `handleEnrichmentRead` builds a `topic_private`
  // fall-through-hint instead so the agent's out-of-band plan stays
  // composable. Without the budget, current hard-throw behavior holds.
  //
  // D-187 AMENDMENT — the read-grant lookup. A topic the bound contract is not
  // read-granted (the unified `enrichment.<topic>` entry — folding the former
  // per-topic scope-fence AND `mcp_exposed` visibility) is rejected BEFORE any store
  // read, so timing can't leak whether matching rows exist. Settings → MCP grant
  // toggles take effect immediately.
  // D-187 slice 3 — the gate is now `verb-op grant ∧ topic grant` (`isReadAdmissible`):
  // a contract not granted the `core.data.enrichment.read` verb-op is rejected even for
  // a topic it WOULD otherwise be granted (a topic grant does not imply the verb).
  if (
    !isReadAdmissible(checker, input.topic as EnrichmentTopic)
    && input.freshness_budget_ms === undefined
  ) {
    throw new RpcError(
      'bad_request',
      `mcp.enrichment.read: topic '${input.topic}' is not read-granted to this contract (read rejected)`,
      400,
    );
  }
  // P7.D Codex review fix [P1] — block direct probes for substrate-private
  // pinned-author rows. Pinned correction chains never surface to MCP per
  // spec §A.13.5; rejecting the parameter at the rpc boundary surfaces a
  // clear error rather than a silent empty result.
  if (
    typeof input.authored_by === 'string'
    && input.authored_by.startsWith(ENRICHMENT_PINNED_AUTHOR_PREFIX)
  ) {
    throw new RpcError(
      'bad_request',
      `mcp.enrichment.read: authored_by may not target the substrate-private '${ENRICHMENT_PINNED_AUTHOR_PREFIX}' prefix`,
      400,
    );
  }
  const def = getEnrichmentDefinition(input.topic);
  if (def.shape === 'per_record') {
    if (typeof input.scope !== 'string' || typeof input.target_id !== 'string') {
      throw new RpcError(
        'bad_request',
        `mcp.enrichment.read: per-record topic '${input.topic}' requires scope + target_id`,
        400,
      );
    }
    if (input.derived_entity_id !== undefined) {
      throw new RpcError(
        'bad_request',
        `mcp.enrichment.read: per-record topic '${input.topic}' must not pass derived_entity_id`,
        400,
      );
    }
    // D-192 S4b — delegate to the store's WIDENED scope-support gate (static
    // valid_scopes OR a live-registry pack CRM scope of the topic's crm_alias
    // family), NOT a bare `valid_scopes.includes`: a pack scope written via the
    // widened upsert must be READABLE via MCP, else the row is unreachable by the
    // AI-facing surface. The store is the single source of truth all gates share.
    if (!isScopeSupported(input.topic, input.scope)) {
      throw new RpcError(
        'bad_request',
        `mcp.enrichment.read: topic '${input.topic}' does not support scope '${input.scope}'`,
        400,
      );
    }
  } else {
    if (typeof input.derived_entity_id !== 'string' || input.derived_entity_id.length === 0) {
      throw new RpcError(
        'bad_request',
        `mcp.enrichment.read: derived-entity topic '${input.topic}' requires derived_entity_id`,
        400,
      );
    }
    if (input.scope !== undefined || input.target_id !== undefined) {
      throw new RpcError(
        'bad_request',
        `mcp.enrichment.read: derived-entity topic '${input.topic}' must not pass scope/target_id`,
        400,
      );
    }
  }

  if (input.coherent_at !== undefined && input.include_historical === true) {
    throw new RpcError(
      'bad_request',
      'mcp.enrichment.read: coherent_at and include_historical are mutually exclusive',
      400,
    );
  }
  if (input.coherent_at !== undefined && input.as_of !== undefined) {
    throw new RpcError(
      'bad_request',
      'mcp.enrichment.read: coherent_at and as_of are mutually exclusive (use one or the other)',
      400,
    );
  }
};

/** Apply the include_stale gate on a row. Default `true` matches the
 *  P7.C resolver default — stale + expired rows surface alongside
 *  fresh. When `include_stale: false`, only `'fresh'` rows pass. */
const passesStalenessGate = (
  row: EnrichmentRecord,
  include_stale: boolean,
): boolean => {
  if (include_stale) return true;
  return row.staleness_class === 'fresh';
};

/** Apply the coherent_at gate on a row. The row's `computed_at`
 *  (derived) must be `<= coherent_at`. */
const passesCoherentAt = (
  row: EnrichmentRecord,
  coherent_at: number | undefined,
): boolean => {
  if (coherent_at === undefined) return true;
  const computed_at = row.last_evaluated_at ?? row.authored_at;
  return computed_at <= coherent_at;
};

/** Sentinel `as_of` for "current head" reads. `getRowAsOf` interval
 *  semantics walk the supersede chain and return the row with
 *  `superseded_by_id IS NULL` (the chain head's interval extends to
 *  `+∞`). Critical for non-monotonic backfill chains where the chain
 *  head can have an OLDER `event_at` than its predecessor — a plain
 *  `getChain(... limit: 1)` would return the predecessor in that case
 *  because `getChain` orders DESC by effective time. P7.C Codex review
 *  caught the symmetric bug in `getRowAsOf`; this constant + the
 *  explicit dispatch below applies the fix to the head-read path. */
const HEAD_AS_OF_SENTINEL = Number.MAX_SAFE_INTEGER;

/** Resolve the historical chain for the input. Used by
 *  `include_historical: true`. P7.C's `getChain` produces the chain
 *  ordered DESC by effective time; this layer applies the optional
 *  `as_of` truncation + the `include_stale` filter on each row.
 *
 *  P7.D Codex review fix [P1] — `exclude_pinned: true` so substrate-
 *  private pinned correction rows never enter the chain visible to MCP. */
const resolveHistorical = (
  store: EnrichmentStore,
  input: EnrichmentReadRpcInput,
): EnrichmentRecord[] => {
  const def = getEnrichmentDefinition(input.topic);
  const chain = def.shape === 'per_record'
    ? store.getChain({
        topic: input.topic,
        scope: input.scope as EnrichmentScope,
        target_id: input.target_id!,
        exclude_pinned: true,
        ...(input.authored_by !== undefined ? { authored_by: input.authored_by } : {}),
      })
    : store.getChain({
        topic: input.topic,
        derived_entity_id: input.derived_entity_id!,
        exclude_pinned: true,
      });
  const include_stale = input.include_stale ?? true;
  return chain.filter((row) => {
    // as_of truncation: drop rows whose effective time is strictly
    // greater than as_of (the chain at as_of is everything <=).
    if (input.as_of !== undefined) {
      const effective = row.event_at ?? row.ingested_at;
      if (effective > input.as_of) return false;
    }
    return passesStalenessGate(row, include_stale);
  });
};

/** Pick the supersede chain head from a chain. The head is the row
 *  with `superseded_by_id === null`; for multi-author shape A there
 *  may be multiple, in which case the freshest by `ingested_at` wins
 *  (matches `getRowAsOf`'s tiebreaker). Returns null when no row in
 *  the chain is unsuperseded (every row has been superseded; should
 *  not happen in well-formed chains but defensive).
 *
 *  Used by `include_historical` to identify the result-field head
 *  separately from the full chain ordering. P7.C review fix [P2]:
 *  do NOT use `chain[0]` (effective-time-first) — under non-monotonic
 *  backfill that's a superseded predecessor, not the chain head. */
const pickChainHead = (chain: ReadonlyArray<EnrichmentRecord>): EnrichmentRecord | null => {
  let head: EnrichmentRecord | null = null;
  for (const row of chain) {
    if (row.superseded_by_id !== null) continue;
    if (head === null || row.ingested_at > head.ingested_at) {
      head = row;
    }
  }
  return head;
};

/** Resolve a single point-in-time row for the input. Used by the
 *  default + `as_of` + `coherent_at` paths.
 *
 *  P7.D Codex review fix:
 *  - [P1] All `getRowAsOf` / `getChain` calls pass `exclude_pinned: true`
 *    so substrate-private pinned correction rows never reach MCP.
 *  - [P2] Bare-head reads use `getRowAsOf({as_of: HEAD_AS_OF_SENTINEL})`
 *    instead of `getChain(... limit: 1)`. The former honors P7.C's
 *    interval semantic (head wins via `superseded_by_id IS NULL`); the
 *    latter returned the row with the largest `event_at`, which is a
 *    superseded predecessor under non-monotonic backfill chains. */
const resolveSingleRow = (
  store: EnrichmentStore,
  input: EnrichmentReadRpcInput,
): EnrichmentRecord | null => {
  const def = getEnrichmentDefinition(input.topic);
  const include_stale = input.include_stale ?? true;

  // as_of dispatch — P7.C historical resolver.
  if (input.as_of !== undefined) {
    const row = def.shape === 'per_record'
      ? store.getRowAsOf({
          topic: input.topic,
          scope: input.scope as EnrichmentScope,
          target_id: input.target_id!,
          as_of: input.as_of,
          exclude_pinned: true,
          ...(input.authored_by !== undefined ? { authored_by: input.authored_by } : {}),
        })
      : store.getRowAsOf({
          topic: input.topic,
          derived_entity_id: input.derived_entity_id!,
          as_of: input.as_of,
          exclude_pinned: true,
        });
    if (row === null) return null;
    if (!passesStalenessGate(row, include_stale)) return null;
    return row;
  }

  // coherent_at: walk the chain and pick the freshest row that
  // satisfies `computed_at <= coherent_at`. Chain is DESC by effective
  // time, but `coherent_at` filters on `computed_at`, not effective
  // time — so any row in the chain may match; first-match-wins
  // (DESC ordering still favors more recent producer runs).
  if (input.coherent_at !== undefined) {
    const chain = def.shape === 'per_record'
      ? store.getChain({
          topic: input.topic,
          scope: input.scope as EnrichmentScope,
          target_id: input.target_id!,
          exclude_pinned: true,
          ...(input.authored_by !== undefined ? { authored_by: input.authored_by } : {}),
        })
      : store.getChain({
          topic: input.topic,
          derived_entity_id: input.derived_entity_id!,
          exclude_pinned: true,
        });
    for (const row of chain) {
      if (!passesCoherentAt(row, input.coherent_at)) continue;
      if (!passesStalenessGate(row, include_stale)) continue;
      return row;
    }
    return null;
  }

  // Bare head read — `getRowAsOf({as_of: +∞-sentinel})` returns the
  // supersede chain head correctly under both monotonic and non-
  // monotonic backfill cases. P7.C review fix [P2]: this replaces a
  // prior `getChain(... limit: 1)` that returned the freshest-by-
  // event_at row — a superseded predecessor under non-monotonic chains.
  const head = def.shape === 'per_record'
    ? store.getRowAsOf({
        topic: input.topic,
        scope: input.scope as EnrichmentScope,
        target_id: input.target_id!,
        as_of: HEAD_AS_OF_SENTINEL,
        exclude_pinned: true,
        ...(input.authored_by !== undefined ? { authored_by: input.authored_by } : {}),
      })
    : store.getRowAsOf({
        topic: input.topic,
        derived_entity_id: input.derived_entity_id!,
        as_of: HEAD_AS_OF_SENTINEL,
        exclude_pinned: true,
      });
  if (head === null) return null;
  if (!passesStalenessGate(head, include_stale)) return null;
  return head;
};

// ────────────────────────────────────────────────────────────────
// P7.F §A.14.5 — freshness-budget gate + fall-through-hint composition
// ────────────────────────────────────────────────────────────────

/** Compute the staleness measurement on the spec's per-temporal-class
 *  axis. Returns `{ staleness_ms, axis }` so the caller can compare
 *  against the budget AND surface the axis in the fall-through hint
 *  when the budget is exceeded.
 *
 *  Spec §A.14.5 dispatch table:
 *    - stable_truth → `now - computed_at` (axis: 'computed_at')
 *    - time_bound → `now - as_of` (axis: 'as_of')
 *    - aggregate_window → `now - as_of`, with axis 'window_drift' when
 *      `(now - as_of) > recompute_cadence`; else axis: 'as_of'
 *
 *  `event_at` is intentionally never used as the staleness measure —
 *  it's real-world event time, not a freshness signal. A summary of a
 *  2-year-old email computed yesterday is *fresh*; using `event_at`
 *  would falsely reject it.
 *
 *  Falls back to `axis: 'computed_at'` when the row's `as_of` is null
 *  on a non-stable_truth topic (legacy / pre-P3-retrofit rows). */
const measureStaleness = (
  row: MCPEnrichmentReadResult,
  topic: EnrichmentTopic,
  now: number,
): { staleness_ms: number; axis: 'computed_at' | 'as_of' | 'window_drift' } => {
  const def = getEnrichmentDefinition(topic);
  if (def.temporal_class === 'stable_truth') {
    return { staleness_ms: now - row.computed_at, axis: 'computed_at' };
  }
  // time_bound + aggregate_window — both anchor on `as_of`. Fall back
  // to `computed_at` when as_of is missing on a legacy row.
  const as_of = row.as_of ?? row.computed_at;
  const staleness_ms = now - as_of;
  if (def.temporal_class === 'aggregate_window') {
    const cadenceMs = cadenceToMs(def.recompute_cadence);
    if (cadenceMs !== null && staleness_ms > cadenceMs) {
      return { staleness_ms, axis: 'window_drift' };
    }
    return { staleness_ms, axis: 'as_of' };
  }
  // time_bound
  return { staleness_ms, axis: 'as_of' };
};

/** Build the substrate-suggested raw adapter + filter for a fall-
 *  through hint. Per-scope mapping per spec §A.14.5 example.
 *
 *  Per-record (Shape A) inputs dispatch by scope:
 *    - mail → `mail.search` with `{ message_id?, since }`
 *    - calendar → `calendar.list` with `{ event_id?, since }`
 *    - contact → `contact.list` with `{ email?, since }`
 *    - file → `file.list` with `{ path?, since }`
 *    - connection.api.<vendor>.<entity> → `connection.api.<vendor>.<entity>.fetch`
 *      with `{ id }` (per-record fetch by platform-native id)
 *    - connection.mcp / connection.notification → fall back to
 *      `enrichment.list` (no raw analogue for connection-records'
 *      enrichments)
 *
 *  Derived-entity (Shape B) inputs suggest `enrichment.list` with
 *  `{ topic, derived_entity_id }` so the agent can re-read the same
 *  entity later — derived entities are warehouse-only by construction
 *  (no raw source to fall through to).
 *
 *  Discriminates Shape A vs Shape B on `derived_entity_id` presence
 *  instead of registry lookup — `validateInput` has already enforced
 *  the shape constraint, and this keeps `suggestRawAdapter` pure (no
 *  registry dependency, no exception path on unknown topics).
 *
 *  `since_ms` is the floor the agent should use on time-anchored raw
 *  adapters. Computed as `now - freshness_budget_ms`: the agent reads
 *  raw events newer than its declared budget. */
const suggestRawAdapter = (
  input: Pick<EnrichmentReadRpcInput, 'topic' | 'scope' | 'target_id' | 'derived_entity_id'>,
  since_ms: number,
): { suggested_raw_adapter: string; suggested_filter: Record<string, unknown> } => {
  if (input.derived_entity_id !== undefined) {
    return {
      suggested_raw_adapter: 'enrichment.list',
      suggested_filter: {
        topic: input.topic,
        derived_entity_id: input.derived_entity_id,
      },
    };
  }
  const scope = input.scope ?? '';
  const target = input.target_id ?? '';
  if (isPlatformReferenceScope(scope)) {
    const parsed = parseVendorEntityScope(scope);
    if (parsed !== null) {
      return {
        suggested_raw_adapter: `connection.api.${parsed.vendor}.${parsed.entity}.fetch`,
        suggested_filter: { id: target },
      };
    }
  }
  switch (scope) {
    case 'mail':
      return {
        suggested_raw_adapter: 'mail.search',
        suggested_filter: { message_id: target, since: since_ms },
      };
    case 'calendar':
      return {
        suggested_raw_adapter: 'calendar.list',
        suggested_filter: { event_id: target, since: since_ms },
      };
    case 'contact':
      return {
        suggested_raw_adapter: 'contact.list',
        suggested_filter: { email: target, since: since_ms },
      };
    case 'file':
      return {
        suggested_raw_adapter: 'file.list',
        suggested_filter: { path: target, since: since_ms },
      };
    default:
      // connection.mcp / connection.notification / unknown scope —
      // no raw adapter; warehouse re-read is the only path.
      return {
        suggested_raw_adapter: 'enrichment.list',
        suggested_filter: {
          topic: input.topic,
          scope,
          target_id: target,
        },
      };
  }
};

/** Build a fall-through hint for a given reason. The reason
 *  discriminates the path; the suggested adapter + filter mirror what
 *  the agent should call in place of the warehouse read. */
const buildFallThroughHint = (
  input: EnrichmentReadRpcInput,
  reason: EnrichmentReadFallThroughHint['reason'],
  staleness_axis: EnrichmentReadFallThroughHint['staleness_axis'] | undefined,
  now: number,
  budget_ms: number,
): EnrichmentReadFallThroughHint => {
  const since_ms = Math.max(0, now - budget_ms);
  const { suggested_raw_adapter, suggested_filter } = suggestRawAdapter(input, since_ms);
  const hint: EnrichmentReadFallThroughHint = {
    reason,
    suggested_raw_adapter,
    suggested_filter,
  };
  if (staleness_axis !== undefined) hint.staleness_axis = staleness_axis;
  return hint;
};

/** P7.D + P7.F entry point. Validates input, dispatches by mode,
 *  returns `{ result, chain?, fall_through_hint? }`.
 *
 *  Read-cost-zero: this handler invokes only `EnrichmentStore` SQL
 *  methods. Bundle assembly is a pure projection. The deps shape
 *  intentionally lacks any LLM hook; the test ratchet at P7.D close
 *  enforces structurally.
 *
 *  P7.F threading: when `freshness_budget_ms` is set, the read goes
 *  through three short-circuits before the normal resolve:
 *    1. private-topic → `topic_private` hint, result null
 *    2. resolved row missing → `no_row` hint, result null
 *    3. row staler than budget → `freshness_budget_exceeded` hint with
 *       the dispatched axis, result null
 *  Otherwise the row surfaces normally. The `include_historical` path
 *  is unaffected (chains are bulk reads; agents wanting per-row
 *  freshness re-issue per-row reads with the budget).
 *
 *  `now` is parameterized via the optional second argument so tests
 *  can pin the staleness boundary; production callers omit it and the
 *  handler falls back to `Date.now()`. */
export const handleEnrichmentRead = (
  deps: EnrichmentReadDeps,
  input: EnrichmentReadRpcInput,
  options?: { now?: () => number },
): EnrichmentReadRpcOutput => {
  const checker = deps.readGrantChecker ?? AUTHOR_DEFAULT_READ_GRANT_CHECKER;
  validateInput(input, checker, deps.enrichmentStore.isScopeSupported);
  const { enrichmentStore: store } = deps;
  const now = options?.now ? options.now() : Date.now();

  // P7.F §A.14.5 — not-read-granted short-circuit. `validateInput` skipped
  // the throw when `freshness_budget_ms` is set; we surface the hint
  // here instead. A read the contract isn't granted returns result: null with
  // reason `'topic_private'` so the agent's plan stays composable.
  // D-187 AMENDMENT — same read-grant checker here so a grant toggle short-
  // circuits the read without touching the registry.
  // D-187 slice 3 — `verb-op ∧ topic` (`isReadAdmissible`): a denied verb-op also
  // takes the composable fall-through path (not a hard error) when a budget is set.
  if (
    input.freshness_budget_ms !== undefined
    && !isReadAdmissible(checker, input.topic as EnrichmentTopic)
  ) {
    return {
      result: null,
      fall_through_hint: buildFallThroughHint(
        input,
        'topic_private',
        undefined,
        now,
        input.freshness_budget_ms,
      ),
    };
  }

  if (input.include_historical === true) {
    const rows = resolveHistorical(store, input);
    // Pre-fetch drift severity once for the topic — the chain is one
    // topic so a single lookup batches all entries.
    const driftSeverity = lookupDriftSeverity(store, input.topic as EnrichmentTopic);
    const chain = rows.map((row) => assembleBundle(row, driftSeverity));
    // P7.D Codex review fix [P2] — `result` is the supersede chain
    // head (`superseded_by_id IS NULL`), NOT chain[0]. Under non-
    // monotonic backfill the effective-time-DESC `chain[0]` is a
    // superseded predecessor, not the canonical current row.
    const headRow = pickChainHead(rows);
    const head = headRow !== null ? assembleBundle(headRow, driftSeverity) : null;
    return { result: head, chain };
  }

  const row = resolveSingleRow(store, input);

  // P7.F §A.14.5 — no-row short-circuit. Surfaces a fall-through hint
  // when the budget was set; otherwise the legacy `result: null`
  // behavior holds (no hint).
  if (row === null) {
    if (input.freshness_budget_ms !== undefined) {
      return {
        result: null,
        fall_through_hint: buildFallThroughHint(
          input,
          'no_row',
          undefined,
          now,
          input.freshness_budget_ms,
        ),
      };
    }
    return { result: null };
  }

  const bundle = assembleBundleWithDriftLookup(store, row);

  // P7.F §A.14.5 — staleness gate. Only fires when the agent declared
  // a budget. The dispatched axis comes from the topic's
  // `temporal_class`; `event_at` is never used (real-world event time
  // is not a freshness signal — see spec §A.14.5).
  if (input.freshness_budget_ms !== undefined) {
    const { staleness_ms, axis } = measureStaleness(
      bundle,
      input.topic as EnrichmentTopic,
      now,
    );
    if (staleness_ms > input.freshness_budget_ms) {
      return {
        result: null,
        fall_through_hint: buildFallThroughHint(
          input,
          'freshness_budget_exceeded',
          axis,
          now,
          input.freshness_budget_ms,
        ),
      };
    }
  }

  return { result: bundle };
};

/** Test-only export — bare bundle assembler + helpers, so unit tests
 *  can exercise the projection without running through the full rpc. */
export const _testing = {
  assembleBundle,
  assembleBundleWithDriftLookup,
  deriveStalenessReason,
  extractConfidence,
  lookupDriftSeverity,
  passesCoherentAt,
  passesStalenessGate,
  pickChainHead,
  HEAD_AS_OF_SENTINEL,
  // P7.F
  measureStaleness,
  suggestRawAdapter,
  buildFallThroughHint,
};
