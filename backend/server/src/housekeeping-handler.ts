/** D-123 Phase 5 + D-132 Phase 4 — `housekeeping.*` rpc handlers.
 *
 *  Settings → Server → Housekeeping panel reads + writes. Methods:
 *    config.read              — current preset / budget / interval / window /
 *                               D-132 ai-control fields (allow_byok_background,
 *                               pause_background_ai_until).
 *    config.write             — apply a preset; validates clamp + custom-only
 *                               fields. D-132 P4 widens to accept ai-control
 *                               fields too — orthogonal to preset, pass-through.
 *    status.read              — denormalized join of registered task meta +
 *                               persisted state, plus per-record token estimate
 *                               + source-collection size for `kind: 'enrichment'`
 *                               tasks (for the *Run now* dialog preview).
 *    task.run_now             — fire one cycle scoped to a single task. Bypasses
 *                               idle-gating but honours cycle budget. D-132 P4
 *                               wires the manual_run_count bump + promotion-
 *                               suggestion event for AI-surface manual producers.
 *    trust.read               — D-132 P4. Per-topic trust state + pool policy.
 *                               Returns persisted rows; absent topics fall back
 *                               to registry defaults at render time.
 *    trust.write              — D-132 P4. Upsert trust_state + pool_policy on a
 *                               topic. Validates topic + enum values.
 *    trust.dismiss_promotion  — D-132 P4. Marks the promotion-banner dismissed
 *                               for a topic ("Don't ask again").
 *
 *  The scheduler instance itself stays server-internal; bin.ts owns
 *  the lifecycle. The handler asks `deps.runOnce` for run_now — so
 *  tests can drive the rpc without standing up a full bin.ts.
 *
 *  Spec: `docs/d-123-spec.md` §5.1 + `docs/d-132-spec.md` §A.7-A.9. */

import {
  ALL_ENRICHMENT_POOL_POLICIES,
  ALL_ENRICHMENT_TRUST_STATES,
  HOUSEKEEPING_CYCLE_BUDGET_MAX_MS,
  HOUSEKEEPING_CYCLE_BUDGET_MIN_MS,
  MANUAL_RUN_THRESHOLD,
  RpcError,
  isEnrichmentTopic,
  type EnrichmentPoolPolicy,
  type EnrichmentTopic,
  type EnrichmentTrustRow,
  type EnrichmentTrustState,
  type HandlerSlice,
  type HousekeepingConfigRow,
  type HousekeepingCycleResult,
  type HousekeepingEnrichmentInfo,
  type HousekeepingPreset,
  type HousekeepingTaskStatus,
  type ServerRpcRegistry,
} from '@recued/contracts';

import type { WsClient } from './ws-server.js';
import type { EventBus } from './events/bus.js';
import type { HousekeepingConfigStore } from './housekeeping/config-store.js';
import type { HousekeepingStateStore } from './housekeeping/state-store.js';
import type { HousekeepingTaskInstance } from './housekeeping/registry.js';
import type { TrustStore } from './housekeeping/trust-store.js';
import type { LlmResultCacheStore } from './housekeeping/llm-result-cache-store.js';
import type { EnrichmentStore } from './storage/enrichment-store.js';
import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';
import { createGrantEntryResolver } from './contract-grant-resolve.js';
import { createReadGrantChecker } from './read-grant-checker.js';
import type { AuditLogStore } from '@recued/storage';
import {
  ENRICHMENT_REGISTRY,
  LLM_RESULT_CACHE_GC_TASK_ID,
  OWNER_CONTRACT_ID,
} from '@recued/contracts';

export interface HousekeepingRpcDeps {
  config: HousekeepingConfigStore;
  state: HousekeepingStateStore;
  /** Snapshot of the registry — re-read each rpc so installs /
   *  uninstalls between cycles take effect. */
  registry: () => ReadonlyArray<HousekeepingTaskInstance>;
  /** Drive one synchronous cycle for `task.run_now`. The scheduler's
   *  `runOnce` honours cycle budget but bypasses idle-gating. */
  runOnce: (opts: {
    task_id?: string;
    budget_ms?: number;
  }) => Promise<HousekeepingCycleResult>;
  /** Per-task enrichment info for `kind: 'enrichment'` tasks. Drives
   *  the *Run now* token-cost preview + AI-availability pre-confirm.
   *  Async so the implementation can call `buildAvailability` (which
   *  is `async` because of its tab-probe seam) without forcing a
   *  synchronous shortcut. Returns undefined when the task is not an
   *  enrichment producer (or when bin.ts hasn't populated the
   *  producer registry yet — pre-P7 startup). */
  getEnrichmentInfo?: (task_id: string) => Promise<HousekeepingEnrichmentInfo | undefined>;
  /** D-132 P4 — per-topic trust state store. Drives trust.read /
   *  trust.write / trust.dismiss_promotion + the promotion-suggest
   *  hook on successful manual fires. Optional so tests that don't
   *  exercise the trust surface keep working without supplying one. */
  trustStore?: TrustStore;
  /** D-132 P4 — realtime fan-out for `enrichment_promotion_suggested`
   *  events. Optional — when omitted the promotion logic still runs
   *  (state still flips), just no event lands on paired clients. */
  eventBus?: EventBus;
  /** D-136 §A.12 P7 — store reference for `housekeeping.topic.reset`.
   *  Optional so test setups exercising only the trust / status surfaces
   *  keep working; absent → topic-reset rpc rejects with `unsupported`. */
  enrichmentStore?: EnrichmentStore;
  /** D-136 §A.12 P7 — audit-log emitter for the reset confirm path
   *  (`auditLog.logActivity({action: 'housekeeping.topic.reset', …})`).
   *  Optional; absent → reset proceeds but no audit row lands. */
  auditLog?: AuditLogStore;
  /** D-187 AMENDMENT — the unified per-contract grant store. Threaded into
   *  `housekeeping.registry.describe` so the Settings UI capstone surfaces the effective
   *  `mcp_exposed` policy per topic, resolved against the OWNER contract's
   *  `enrichment.<topic>` grant rows (`OWNER_CONTRACT_ID`) ahead of the registry author
   *  default. Optional; absent → registry author defaults apply. */
  grantEntryStore?: ContractGrantEntryStore;
  /** D-145 PA11 — per-pair LLM result cache store. Drives the
   *  `housekeeping.cache.stats` / `housekeeping.cache.clear` rpcs +
   *  the Settings card. Optional; absent → both rpcs return
   *  `unsupported`. */
  llmResultCache?: LlmResultCacheStore;
  /** D-136 §A.13.1 P7.G — raw SQLite handle for the registry-describe
   *  pinned-row + private-topic-row count subtractions on
   *  `total_rows_visible`. Optional; absent → those subtractions skip
   *  (over-reports by at most the count of pinned/private rows). */
  db?: import('better-sqlite3').Database;
  now?: () => number;
}

const VALID_PRESETS: ReadonlySet<HousekeepingPreset> = new Set([
  'off',
  'light',
  'balanced',
  'aggressive',
  'custom',
]);

const VALID_TRUST_STATES: ReadonlySet<EnrichmentTrustState> = new Set(
  ALL_ENRICHMENT_TRUST_STATES,
);
const VALID_POOL_POLICIES: ReadonlySet<EnrichmentPoolPolicy> = new Set(
  ALL_ENRICHMENT_POOL_POLICIES,
);

const isPreset = (v: unknown): v is HousekeepingPreset =>
  typeof v === 'string' && VALID_PRESETS.has(v as HousekeepingPreset);

const isTrustState = (v: unknown): v is EnrichmentTrustState =>
  typeof v === 'string' && VALID_TRUST_STATES.has(v as EnrichmentTrustState);

const isPoolPolicy = (v: unknown): v is EnrichmentPoolPolicy =>
  typeof v === 'string' && VALID_POOL_POLICIES.has(v as EnrichmentPoolPolicy);

const requireTopic = (v: unknown): EnrichmentTopic => {
  if (typeof v !== 'string' || v.length === 0 || !isEnrichmentTopic(v)) {
    throw new RpcError(
      'bad_request',
      `housekeeping.trust.*: topic '${String(v)}' is not a registered enrichment topic`,
    );
  }
  return v as EnrichmentTopic;
};

export const handleHousekeepingConfigRead = async (
  deps: HousekeepingRpcDeps,
): Promise<HousekeepingConfigRow> => deps.config.read();

export const handleHousekeepingConfigWrite = async (
  deps: HousekeepingRpcDeps,
  args: {
    preset: HousekeepingPreset;
    cycle_budget_ms?: number;
    cycle_interval_minutes?: number;
    custom_window_start_hour?: number;
    custom_window_end_hour?: number;
    allow_byok_background?: boolean;
    pause_background_ai_until?: number | null;
  },
): Promise<{ ok: true; effective: HousekeepingConfigRow }> => {
  if (!isPreset(args.preset)) {
    throw new RpcError(
      'bad_request',
      `housekeeping.config.write: invalid preset '${String(args.preset)}'`,
    );
  }
  // The config store applies preset defaults + custom-window
  // validation + clamp; surface its errors as `bad_request` so the
  // dialog can render the message. Out-of-range custom budgets are
  // the most common case — the inline copy below renders clamp
  // bounds for the user.
  if (
    args.preset === 'custom' &&
    typeof args.cycle_budget_ms === 'number' &&
    Number.isFinite(args.cycle_budget_ms) &&
    (args.cycle_budget_ms < HOUSEKEEPING_CYCLE_BUDGET_MIN_MS ||
      args.cycle_budget_ms > HOUSEKEEPING_CYCLE_BUDGET_MAX_MS)
  ) {
    throw new RpcError(
      'bad_request',
      `housekeeping.config.write: cycle_budget_ms ${args.cycle_budget_ms} out of range [${HOUSEKEEPING_CYCLE_BUDGET_MIN_MS}, ${HOUSEKEEPING_CYCLE_BUDGET_MAX_MS}]`,
    );
  }
  // D-132 P4 — caller-supplied pause window must be a positive epoch
  // ms or null. Reject NaN / Infinity / negative explicitly so the UI
  // gets a clean error instead of a corrupt persisted value.
  if (args.pause_background_ai_until !== undefined && args.pause_background_ai_until !== null) {
    const v = args.pause_background_ai_until;
    if (!Number.isFinite(v) || v < 0) {
      throw new RpcError(
        'bad_request',
        `housekeeping.config.write: pause_background_ai_until ${v} is not a valid epoch ms (or null)`,
      );
    }
  }
  try {
    const now = deps.now?.() ?? Date.now();
    const effective = deps.config.write(
      {
        preset: args.preset,
        ...(args.cycle_budget_ms !== undefined
          ? { cycle_budget_ms: args.cycle_budget_ms }
          : {}),
        ...(args.cycle_interval_minutes !== undefined
          ? { cycle_interval_minutes: args.cycle_interval_minutes }
          : {}),
        ...(args.custom_window_start_hour !== undefined
          ? { custom_window_start_hour: args.custom_window_start_hour }
          : {}),
        ...(args.custom_window_end_hour !== undefined
          ? { custom_window_end_hour: args.custom_window_end_hour }
          : {}),
        ...(args.allow_byok_background !== undefined
          ? { allow_byok_background: args.allow_byok_background }
          : {}),
        ...(args.pause_background_ai_until !== undefined
          ? { pause_background_ai_until: args.pause_background_ai_until }
          : {}),
      },
      now,
    );
    return { ok: true, effective };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RpcError('bad_request', `housekeeping.config.write: ${msg}`);
  }
};

export const handleHousekeepingStatusRead = async (
  deps: HousekeepingRpcDeps,
): Promise<{ tasks: ReadonlyArray<HousekeepingTaskStatus> }> => {
  const tasks: HousekeepingTaskStatus[] = [];
  for (const task of deps.registry()) {
    const stateRow = deps.state.get(task.meta.id);
    const enrichment =
      task.meta.kind === 'enrichment' && deps.getEnrichmentInfo
        ? await deps.getEnrichmentInfo(task.meta.id)
        : undefined;
    tasks.push({
      meta: task.meta,
      ...(stateRow !== null ? { state: stateRow } : {}),
      ...(enrichment !== undefined ? { enrichment } : {}),
    });
  }
  return { tasks };
};

export const handleHousekeepingTaskRunNow = async (
  deps: HousekeepingRpcDeps,
  args: { task_id: string },
): Promise<{ ok: true; cycle_result: HousekeepingCycleResult }> => {
  if (typeof args.task_id !== 'string' || args.task_id.length === 0) {
    throw new RpcError(
      'bad_request',
      'housekeeping.task.run_now: task_id is required',
    );
  }
  const target = deps.registry().find((t) => t.meta.id === args.task_id);
  if (!target) {
    throw new RpcError(
      'bad_request',
      `housekeeping.task.run_now: task '${args.task_id}' not registered`,
    );
  }
  const cycle_result = await deps.runOnce({ task_id: args.task_id });

  // D-132 P4 — manual_run_count bump + promotion-suggestion fire. Only
  // applies when (a) the task ran to completion, (b) the task is an
  // AI-surface enrichment producer, (c) the trust store is wired, and
  // (d) the topic's current trust_state is 'manual' (auto producers
  // are already running on idle cycles; off producers shouldn't be
  // promoted). Errors / yields don't count toward the threshold —
  // only successful manual fires demonstrate user intent.
  await maybeBumpManualRun(deps, target, cycle_result);

  return { ok: true, cycle_result };
};

const maybeBumpManualRun = async (
  deps: HousekeepingRpcDeps,
  task: HousekeepingTaskInstance,
  cycle_result: HousekeepingCycleResult,
): Promise<void> => {
  if (!deps.trustStore) return;
  if (task.meta.kind !== 'enrichment') return;
  if (!task.is_ai_surface) return;
  if (!task.topic) return;

  // The single per_task entry corresponds to this task — `runOnce`
  // scoped the cycle to one task. Defensive lookup keeps the future
  // multi-task run-now (post-launch) clean.
  const outcome = cycle_result.per_task.find((r) => r.task_id === task.meta.id);
  if (!outcome || outcome.status !== 'complete') return;

  const trustBefore = deps.trustStore.read(task.topic, true);
  // Only count manual fires while the producer is held in 'manual'.
  // Auto already runs on idle; off shouldn't accumulate toward
  // promotion (the user has explicitly disabled it).
  if (trustBefore.trust_state !== 'manual') return;
  // User already dismissed the banner — never re-arm it from a count
  // bump alone (per spec §A.8: re-entry is via the trust radios).
  if (trustBefore.promotion_dismissed_at !== null) return;

  const now = deps.now?.() ?? Date.now();
  const newCount = deps.trustStore.bumpManualRunCount(task.topic, true, now);

  // Fire iff the bump moves count across the threshold AND the banner
  // hasn't already been suggested for this milestone.
  const justCrossed =
    trustBefore.manual_run_count < MANUAL_RUN_THRESHOLD &&
    newCount >= MANUAL_RUN_THRESHOLD;
  if (!justCrossed) return;
  if (trustBefore.promotion_suggested_at !== null) return;

  deps.trustStore.markPromotionSuggested(task.topic, now);

  // Estimate cycle cost for the banner copy. Best-effort — undefined
  // info just emits zero, which the UI renders as "no estimate
  // available" inline.
  const info = deps.getEnrichmentInfo
    ? await deps.getEnrichmentInfo(task.meta.id)
    : undefined;
  const estimated = info
    ? info.token_estimate_per_record * info.source_collection_count
    : 0;

  try {
    deps.eventBus?.emit({
      kind: 'enrichment_promotion_suggested',
      topic: task.topic,
      manual_run_count: newCount,
      estimated_idle_cycle_cost_tokens: estimated,
    });
  } catch {
    // Best-effort fan-out — failure to emit doesn't undo the state
    // flip. The banner re-arms naturally once paired clients reconnect
    // and replay events from the bus ring.
  }
};

// ────────────────────────────────────────────────────────────────
// D-132 P4 — trust rpc surface
// ────────────────────────────────────────────────────────────────

export const handleHousekeepingTrustRead = async (
  deps: HousekeepingRpcDeps,
): Promise<{ rows: ReadonlyArray<EnrichmentTrustRow> }> => {
  if (!deps.trustStore) {
    throw new RpcError(
      'unsupported',
      'housekeeping.trust.read: trust store not wired on this server',
    );
  }
  return { rows: deps.trustStore.list() };
};

export const handleHousekeepingTrustWrite = async (
  deps: HousekeepingRpcDeps,
  args: {
    topic?: unknown;
    trust_state?: unknown;
    pool_policy?: unknown;
  },
): Promise<{ ok: true; effective: EnrichmentTrustRow }> => {
  if (!deps.trustStore) {
    throw new RpcError(
      'unsupported',
      'housekeeping.trust.write: trust store not wired on this server',
    );
  }
  const topic = requireTopic(args.topic);
  const patch: Partial<Pick<EnrichmentTrustRow, 'trust_state' | 'pool_policy'>> = {};
  if (args.trust_state !== undefined) {
    if (!isTrustState(args.trust_state)) {
      throw new RpcError(
        'bad_request',
        `housekeeping.trust.write: invalid trust_state '${String(args.trust_state)}'`,
      );
    }
    patch.trust_state = args.trust_state;
  }
  if (args.pool_policy !== undefined) {
    if (!isPoolPolicy(args.pool_policy)) {
      throw new RpcError(
        'bad_request',
        `housekeeping.trust.write: invalid pool_policy '${String(args.pool_policy)}'`,
      );
    }
    patch.pool_policy = args.pool_policy;
  }
  if (patch.trust_state === undefined && patch.pool_policy === undefined) {
    throw new RpcError(
      'bad_request',
      'housekeeping.trust.write: at least one of trust_state / pool_policy is required',
    );
  }
  const now = deps.now?.() ?? Date.now();
  deps.trustStore.write(topic, patch, now);
  // Read back so the caller sees the persisted shape including
  // unchanged fields (manual_run_count, promotion timestamps).
  const effective = deps.trustStore.read(topic, true);
  return { ok: true, effective };
};

export const handleHousekeepingTrustDismissPromotion = async (
  deps: HousekeepingRpcDeps,
  args: { topic?: unknown },
): Promise<{ ok: true; effective: EnrichmentTrustRow }> => {
  if (!deps.trustStore) {
    throw new RpcError(
      'unsupported',
      'housekeeping.trust.dismiss_promotion: trust store not wired on this server',
    );
  }
  const topic = requireTopic(args.topic);
  const now = deps.now?.() ?? Date.now();
  deps.trustStore.markPromotionDismissed(topic, now);
  const effective = deps.trustStore.read(topic, true);
  return { ok: true, effective };
};

// ────────────────────────────────────────────────────────────────
// D-136 §A.12 P7 — housekeeping.topic.reset (dry-run then confirm)
// ────────────────────────────────────────────────────────────────

/** D-136 §A.12 narrow scope union — topic-reset only operates on
 *  the four data-collection scopes, not the wider `EnrichmentScope`
 *  set (no `connection.api.*` / `connection.mcp` etc — those flow
 *  through D-129/130 connection-delete cascades, not topic reset). */
type TopicResetScope = 'mail' | 'contact' | 'calendar' | 'file';

/** Server-side state for the dry-run → confirm round-trip. Tokens are
 *  single-use + TTL-bound; the args + voted-by-client identity are
 *  stamped at mint time so the confirm path can detect arg-tampering
 *  + scope reset to the originating paired-client. */
interface TopicResetTokenRecord {
  token: string;
  topic: string;
  scope_filter: TopicResetScope | null;
  reset_psi_baselines: boolean;
  voted_by_client_id: string;
  expires_at: number;
}

const TOPIC_RESET_TOKEN_TTL_MS = 5 * 60_000; // 5 minutes
const TOPIC_RESET_TOKEN_BYTES = 24;

const TOKEN_STORE: Map<string, TopicResetTokenRecord> = new Map();

const evictExpiredTokens = (now: number): void => {
  for (const [k, v] of TOKEN_STORE) {
    if (v.expires_at <= now) TOKEN_STORE.delete(k);
  }
};

const RECOMPUTE_TOKEN_DEFAULT_PER_RECORD = 200;
const isEnrichmentScopeForReset = (v: unknown): v is TopicResetScope =>
  v === 'mail' || v === 'contact' || v === 'calendar' || v === 'file';

const requireTopicForReset = (v: unknown): string => {
  if (typeof v !== 'string' || v.length === 0 || !isEnrichmentTopic(v)) {
    throw new RpcError(
      'bad_request',
      `housekeeping.topic.reset: topic '${String(v)}' is not a registered enrichment topic`,
    );
  }
  return v;
};

const computeImpact = (
  store: EnrichmentStore,
  topic: string,
  scope_filter: TopicResetScope | undefined,
  reset_psi_baselines: boolean,
): {
  rows_to_tombstone: number;
  pinned_protected: number;
  psi_baselines_to_drop: number;
  estimated_recompute_tokens: number;
} => {
  const counts = store.countMatchingForReset({
    topic,
    ...(scope_filter !== undefined ? { scope_filter } : {}),
  });
  const psi = reset_psi_baselines
    ? store.countConfidenceDriftBaselinesForTopic(topic)
    : 0;
  // Estimate per-record recompute token cost for the planner preview.
  // We use the default until P3 wraps every producer with a richer
  // `estimate_per_record_tokens()` shape — the planner's stamp on
  // `HousekeepingTaskInstance.token_estimate_per_record` is the
  // canonical source post-P6, but the housekeeping handler doesn't
  // hold a stamped registry view. Until that wires through, the
  // default constant is the right preview floor.
  const estimated_recompute_tokens =
    counts.rows_to_tombstone * RECOMPUTE_TOKEN_DEFAULT_PER_RECORD;
  return {
    rows_to_tombstone: counts.rows_to_tombstone,
    pinned_protected: counts.pinned_protected,
    psi_baselines_to_drop: psi,
    estimated_recompute_tokens,
  };
};

export const handleHousekeepingTopicReset = async (
  deps: HousekeepingRpcDeps,
  args: {
    topic?: unknown;
    scope_filter?: unknown;
    reset_psi_baselines?: unknown;
    confirmation_token?: unknown;
  },
  caller: { instance_id: string | null } | undefined,
): Promise<{
  applied: boolean;
  confirmation_token: string | null;
  expires_at: number | null;
  topic: string;
  scope_filter: TopicResetScope | null;
  reset_psi_baselines: boolean;
  impact: {
    rows_to_tombstone: number;
    pinned_protected: number;
    psi_baselines_to_drop: number;
    estimated_recompute_tokens: number;
  };
  applied_summary: {
    rows_tombstoned: number;
    rows_recompute_enqueued: number;
    psi_baselines_dropped: number;
    pinned_skipped: number;
  };
}> => {
  // ── §A.12 P7.B Codex review #1 — paired-client gate ──
  //
  // Topic-reset is destructive (tombstones + sidecar drop on every
  // matching row) — the spec calls it the "catastrophic-recovery
  // panic-button". Reject any caller that isn't a registered paired
  // client (D-121 `instance_id`); unregistered connections (anonymous
  // / pre-register handshake) are rejected outright.
  //
  // The gate fires BEFORE topic resolution + store-availability
  // checks so an unregistered call doesn't leak the topic-validation
  // error code (or surface the "no store wired" hint).
  if (!caller?.instance_id) {
    throw new RpcError(
      'permission_denied',
      'housekeeping.topic.reset: requires a paired client (D-121); rpc dispatched from an unregistered connection',
    );
  }
  const voted_by_client_id = caller.instance_id;

  if (!deps.enrichmentStore) {
    throw new RpcError(
      'unsupported',
      'housekeeping.topic.reset: enrichment store not wired on this server',
    );
  }

  const topic = requireTopicForReset(args.topic);

  let scope_filter: TopicResetScope | undefined;
  if (args.scope_filter !== undefined && args.scope_filter !== null) {
    if (!isEnrichmentScopeForReset(args.scope_filter)) {
      throw new RpcError(
        'bad_request',
        `housekeeping.topic.reset: invalid scope_filter '${String(args.scope_filter)}'`,
      );
    }
    scope_filter = args.scope_filter;
  }

  // Default `reset_psi_baselines` from the registry: true if the topic
  // emits confidence (D-133 PSI is meaningful), false otherwise.
  const def = ENRICHMENT_REGISTRY[topic as keyof typeof ENRICHMENT_REGISTRY];
  const emits_confidence =
    (def as { emits_confidence?: boolean })?.emits_confidence === true;
  const reset_psi_baselines =
    typeof args.reset_psi_baselines === 'boolean'
      ? args.reset_psi_baselines
      : emits_confidence;

  const ts = deps.now?.() ?? Date.now();
  evictExpiredTokens(ts);

  // ── Confirm path ────────────────────────────────────────────
  if (
    typeof args.confirmation_token === 'string' &&
    args.confirmation_token.length > 0
  ) {
    const tokenRecord = TOKEN_STORE.get(args.confirmation_token);
    if (!tokenRecord) {
      throw new RpcError(
        'bad_request',
        'housekeeping.topic.reset: confirmation_token unknown or expired',
      );
    }
    // Defensive: arg-tamper detection (caller can't change reset
    // params between dry-run and confirm). The token is bound to one
    // exact request shape.
    if (
      tokenRecord.topic !== topic ||
      tokenRecord.scope_filter !== (scope_filter ?? null) ||
      tokenRecord.reset_psi_baselines !== reset_psi_baselines
    ) {
      throw new RpcError(
        'bad_request',
        'housekeeping.topic.reset: confirmation_token arg mismatch — re-run dry-run with the new args',
      );
    }
    if (tokenRecord.voted_by_client_id !== voted_by_client_id) {
      throw new RpcError(
        'bad_request',
        'housekeeping.topic.reset: confirmation_token bound to a different paired client',
      );
    }

    // Single-use: drop before applying so a parallel retry can't
    // double-apply.
    TOKEN_STORE.delete(args.confirmation_token);

    const applied_summary = deps.enrichmentStore.tombstoneAndEnqueueRecomputeByTopic({
      topic,
      ...(scope_filter !== undefined ? { scope_filter } : {}),
    });
    let psi_baselines_dropped = 0;
    if (reset_psi_baselines) {
      psi_baselines_dropped =
        deps.enrichmentStore.dropConfidenceDriftBaselinesForTopic(topic);
    }

    if (deps.auditLog) {
      try {
        await deps.auditLog.logActivity({
          activity_id: '',
          timestamp: ts,
          action: 'housekeeping_topic_reset',
          target: topic,
          detail:
            `scope_filter=${scope_filter ?? '*'},psi=${reset_psi_baselines},` +
            `tombstoned=${applied_summary.rows_tombstoned},` +
            `enqueued=${applied_summary.rows_recompute_enqueued},` +
            `psi_dropped=${psi_baselines_dropped},` +
            `pinned_skipped=${applied_summary.pinned_skipped},` +
            `by=${voted_by_client_id}`,
        });
      } catch {
        // Best-effort — audit failure must not unwind the reset.
      }
    }

    // Compute the impact echo from the post-state (zeroed counts since
    // matching rows were just tombstoned). The caller cares about
    // `applied_summary`; the impact echo lets a UI re-render the
    // panel uniformly across dry-run + confirm.
    return {
      applied: true,
      confirmation_token: null,
      expires_at: null,
      topic,
      scope_filter: scope_filter ?? null,
      reset_psi_baselines,
      impact: {
        rows_to_tombstone: 0,
        pinned_protected: applied_summary.pinned_skipped,
        psi_baselines_to_drop: 0,
        estimated_recompute_tokens: 0,
      },
      applied_summary: {
        ...applied_summary,
        psi_baselines_dropped,
      },
    };
  }

  // ── Dry-run path ────────────────────────────────────────────
  const impact = computeImpact(
    deps.enrichmentStore,
    topic,
    scope_filter,
    reset_psi_baselines,
  );

  // Mint a fresh single-use token bound to the (topic, scope, psi,
  // client) tuple. UUID-shaped — `randomUUID()` is plenty of entropy
  // for a 5-minute single-use confirmation.
  const tokenBytes = new Uint8Array(TOPIC_RESET_TOKEN_BYTES);
  // Using Math.random sentinel-only seed is unsafe; require crypto.
  // Node's `globalThis.crypto.getRandomValues` is built-in on 18+.
  globalThis.crypto.getRandomValues(tokenBytes);
  const token = `reset_${Buffer.from(tokenBytes).toString('hex')}`;
  const expires_at = ts + TOPIC_RESET_TOKEN_TTL_MS;
  TOKEN_STORE.set(token, {
    token,
    topic,
    scope_filter: scope_filter ?? null,
    reset_psi_baselines,
    voted_by_client_id,
    expires_at,
  });

  return {
    applied: false,
    confirmation_token: token,
    expires_at,
    topic,
    scope_filter: scope_filter ?? null,
    reset_psi_baselines,
    impact,
    applied_summary: {
      rows_tombstoned: 0,
      rows_recompute_enqueued: 0,
      psi_baselines_dropped: 0,
      pinned_skipped: 0,
    },
  };
};

/** Test-only helper: clear the in-memory token store between cases.
 *  Exported under a `_test_` prefix to mark it as not part of the
 *  public surface; production code never imports it. */
export const _test_clearTopicResetTokenStore = (): void => {
  TOKEN_STORE.clear();
};

// ────────────────────────────────────────────────────────────────
// D-145 PA11 — LLM result cache stats + Clear-cache
// ────────────────────────────────────────────────────────────────

export const handleHousekeepingCacheStats = async (
  deps: HousekeepingRpcDeps,
): Promise<{
  total_entries: number;
  total_hits: number;
  per_topic: ReadonlyArray<{ topic: string; entry_count: number; hit_count: number }>;
  last_gc_at: number | null;
}> => {
  if (!deps.llmResultCache) {
    throw new RpcError(
      'unsupported',
      'housekeeping.cache.stats: LLM result cache not wired on this server',
    );
  }
  const stats = deps.llmResultCache.stats();
  const gcRow = deps.state.get(LLM_RESULT_CACHE_GC_TASK_ID);
  return {
    total_entries: stats.total_entries,
    total_hits: stats.total_hits,
    per_topic: stats.per_topic,
    last_gc_at: gcRow?.last_run_at ?? null,
  };
};

export const handleHousekeepingCacheClear = async (
  deps: HousekeepingRpcDeps,
  caller: { instance_id: string | null } | undefined,
): Promise<{ ok: true; rows_deleted: number }> => {
  // Mirror `housekeeping.topic.reset`'s paired-client gate. Clear-cache
  // is reversible (cache will refill naturally on the next producer
  // run) but still a deliberate user action — gating on a registered
  // paired client keeps drive-by clears (anonymous handshakes,
  // pre-register connections) off the surface.
  if (!caller?.instance_id) {
    throw new RpcError(
      'permission_denied',
      'housekeeping.cache.clear: requires a paired client (D-121); rpc dispatched from an unregistered connection',
    );
  }
  if (!deps.llmResultCache) {
    throw new RpcError(
      'unsupported',
      'housekeeping.cache.clear: LLM result cache not wired on this server',
    );
  }
  const { rows_deleted } = deps.llmResultCache.clearAll();
  if (deps.auditLog) {
    try {
      const ts = deps.now?.() ?? Date.now();
      await deps.auditLog.logActivity({
        activity_id: '',
        timestamp: ts,
        action: 'housekeeping_cache_clear',
        target: '',
        detail: `rows_deleted=${rows_deleted},by=${caller.instance_id}`,
      });
    } catch {
      // Best-effort — audit failure must not unwind the clear (the
      // rows are already gone; reporting failure would mislead the UI
      // about the persisted state).
    }
  }
  return { ok: true, rows_deleted };
};

type HousekeepingMethods =
  | 'housekeeping.config.read'
  | 'housekeeping.config.write'
  | 'housekeeping.status.read'
  | 'housekeeping.task.run_now'
  | 'housekeeping.trust.read'
  | 'housekeeping.trust.write'
  | 'housekeeping.trust.dismiss_promotion'
  | 'housekeeping.topic.reset'
  | 'housekeeping.registry.describe'
  | 'housekeeping.cache.stats'
  | 'housekeeping.cache.clear';

/** D-136 §A.13.1 P7.G — Settings UI capstone proxy over the existing
 *  MCP-side `handleRegistryDescribe`. Wired on the WS surface so the
 *  per-topic detail drawer can render coverage_quality + drift +
 *  privacy state without re-implementing the handler. The
 *  `includePrivateTopics: true` flag bypasses the MCP-channel filter
 *  so the UI sees every topic; the per-topic `mcp_exposed` field still
 *  reflects the effective policy (override > registry default). */
export const handleHousekeepingRegistryDescribe = async (
  deps: HousekeepingRpcDeps,
): Promise<import('@recued/contracts').RegistryDescribeRpcOutput> => {
  // Lazy import — keeps the housekeeping handler decoupled from the
  // MCP layer at module-load time + matches the pattern used by the
  // enrichment-handler dispatchers in bin.ts.
  const { handleRegistryDescribe } = await import('./mcp/registry-describe.js');
  // D-187 AMENDMENT — surface every topic's effective grant resolved against the OWNER
  // contract's `enrichment.<topic>` grant rows (`contract.contract_grant.<OWNER>.*`)
  // ahead of the registry author default. Built per-call (not cached) so a write through
  // `mcp.visibility.write` is reflected without restart. The owner reads unconditionally
  // (no liveness gate — it is the owner configuring their own warehouse). Absent store ⇒
  // undefined ⇒ registry author defaults.
  const ownerReadGrantChecker = deps.grantEntryStore
    ? createReadGrantChecker(
        createGrantEntryResolver(deps.grantEntryStore),
        OWNER_CONTRACT_ID,
      )
    : undefined;
  return handleRegistryDescribe(
    {
      ...(deps.enrichmentStore ? { enrichmentStore: deps.enrichmentStore } : {}),
      ...(deps.state ? { housekeepingStateStore: deps.state } : {}),
      ...(deps.db ? { db: deps.db } : {}),
      ...(ownerReadGrantChecker ? { readGrantChecker: ownerReadGrantChecker } : {}),
      // The owner panel shows EVERY topic (granted + not) so the owner can toggle the
      // grant; production MCP-channel callers leave this absent.
      includePrivateTopics: true,
    },
    deps.now ? { now: deps.now } : {},
  );
};

export const makeHousekeepingHandlers = (
  deps: HousekeepingRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, HousekeepingMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'housekeeping.config.read',
      'housekeeping.config.write',
      'housekeeping.status.read',
      'housekeeping.task.run_now',
      'housekeeping.trust.read',
      'housekeeping.trust.write',
      'housekeeping.trust.dismiss_promotion',
      'housekeeping.topic.reset',
      'housekeeping.registry.describe',
      'housekeeping.cache.stats',
      'housekeeping.cache.clear',
    ],
    handlers: {
      'housekeeping.config.read': async () => handleHousekeepingConfigRead(deps),
      'housekeeping.config.write': async (args) =>
        handleHousekeepingConfigWrite(
          deps,
          args as Parameters<typeof handleHousekeepingConfigWrite>[1],
        ),
      'housekeeping.status.read': async () => handleHousekeepingStatusRead(deps),
      'housekeeping.task.run_now': async (args) =>
        handleHousekeepingTaskRunNow(
          deps,
          args as Parameters<typeof handleHousekeepingTaskRunNow>[1],
        ),
      'housekeeping.trust.read': async () => handleHousekeepingTrustRead(deps),
      'housekeeping.trust.write': async (args) =>
        handleHousekeepingTrustWrite(
          deps,
          args as Parameters<typeof handleHousekeepingTrustWrite>[1],
        ),
      'housekeeping.trust.dismiss_promotion': async (args) =>
        handleHousekeepingTrustDismissPromotion(
          deps,
          args as Parameters<typeof handleHousekeepingTrustDismissPromotion>[1],
        ),
      'housekeeping.topic.reset': async (args, client) =>
        handleHousekeepingTopicReset(
          deps,
          args as Parameters<typeof handleHousekeepingTopicReset>[1],
          client ? { instance_id: client.instance_id } : undefined,
        ),
      'housekeeping.registry.describe': async () =>
        handleHousekeepingRegistryDescribe(deps),
      'housekeeping.cache.stats': async () => handleHousekeepingCacheStats(deps),
      'housekeeping.cache.clear': async (_args, client) =>
        handleHousekeepingCacheClear(
          deps,
          client ? { instance_id: client.instance_id } : undefined,
        ),
    },
  };
};
