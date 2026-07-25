/** D-136 §A.7 P5b — Walk-cap budget mechanism.
 *
 *  Replaces D-122/D-123's fixed cycle-counts (`LIFECYCLE_STAGE_MAX_
 *  CONTACTS_PER_CYCLE = 1000` etc.) with token-budget-gated planning.
 *  Composes with D-132 trust state + Pause-AI window so the
 *  walk-cap planner respects the same per-topic trust gate the
 *  scheduler's idle-eligibility filter does.
 *
 *  Algorithm at the start of a housekeeping cycle:
 *
 *    1. Read every chain-head row whose lifecycle action is pending
 *       (`store.listLifecycleActionPending`). Filter to AI-surface
 *       topics — deterministic producers don't burn tokens, so
 *       budgeting them is moot.
 *    2. Walk each row's topic through the trust gate: skip when
 *       `trust_state !== 'auto'` (manual / off topics never enter
 *       walk-cap planning). When `is_ai_surface` and the global
 *       Pause-AI window is active, skip too.
 *    3. Per-topic pool routing: read the trust-store's `pool_policy`,
 *       fold the global `allow_byok_background` master in, and route
 *       the per-row token estimate to the free or BYOK pool.
 *    4. Compute remaining budget per pool from the daily-window
 *       counters (`tokens_consumed_today_*` on `housekeeping_state`).
 *       The window itself is daily-rolling — a `now > budget_window_start
 *       + 24h` invocation reads as if the counters had been zeroed.
 *    5. Return a `CyclePlan` carrying the topo-sorted leaves +
 *       dedup-bypass / will-compute partition + the remaining /
 *       estimated token totals + the over-budget flag. The drain
 *       consumer (P5b.D) consumes this shape and short-circuits when
 *       `over_budget` is true.
 *
 *  Composition with the existing per-record harness (D-136 P3): the
 *  harness's skip rule already implements dedup at execute time
 *  (source_record_hash + producer_version_hash match). The planner's
 *  pre-flight dedup probe is OPPORTUNISTIC — when a producer-version
 *  hash callback is wired and an existing fresh chain-head row already
 *  carries the matching hash, we mark the leaf as `dedup_hit` so the
 *  budget estimate excludes its tokens. Wireless callsites (tests +
 *  the initial drain consumer integration) get conservative budgeting:
 *  every leaf treated as `will_compute`. Either path is correct; the
 *  dedup probe just tightens the estimate.
 *
 *  Spec: D-136 §A.7 (walk-cap planner) + §A.8 (D-132
 *  trust composition) + §A.6 (storage schema for the budget counters). */

import type Database from 'better-sqlite3';

import type { EnrichmentRecord, EnrichmentStore } from '../storage/enrichment-store.js';
import { isAiPaused, isByokAllowedForBackground, type TrustStore } from './trust-store.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Per-topic planner-side metadata. The planner needs to know which
 *  topics are AI-surface (to budget their tokens) and what the
 *  per-record token estimate is (to multiply by pending row count).
 *  Caller assembles this from the housekeeping registry's
 *  `HousekeepingTaskInstance.topic` + `is_ai_surface` + the producer's
 *  `estimate_per_record_tokens()` so the planner stays decoupled
 *  from the registry shape.
 *
 *  Deterministic / non-AI topics may pass `is_ai_surface: false` and
 *  `token_estimate_per_record: 0`. The planner ignores them in the
 *  budget pass since they consume no tokens. */
export interface PlannerProducerInfo {
  topic: string;
  is_ai_surface: boolean;
  token_estimate_per_record: number;
}

/** Subset of `HousekeepingConfigRow` the planner reads. Splitting
 *  it out keeps the planner testable without dragging the full config
 *  shape (preset / window hours / cycle budget) into scope. */
export interface PlannerConfig {
  daily_token_budget_free: number;
  daily_token_budget_byok: number;
  /** D-132 — when false, every effective `pool_policy` collapses to
   *  free for the budget routing pass (matches `resolveEffectiveLayer`
   *  in the per-record harness). */
  allow_byok_background: boolean;
  /** D-132 — global pause-AI window. When set + `now <
   *  pause_background_ai_until`, AI-surface topics are skipped from
   *  the plan. */
  pause_background_ai_until: number | null;
}

/** Subset of `housekeeping_state` the planner reads. The drain
 *  consumer (P5b.D) updates these counters as it spends tokens; the
 *  planner snapshots them at cycle start. */
export interface PlannerBudgetState {
  tokens_consumed_today_free: number;
  tokens_consumed_today_byok: number;
  /** Epoch ms when the current daily window began. NULL on first
   *  call → callers should treat as "freshly opened". The planner's
   *  rollover helper folds this in. */
  budget_window_start: number | null;
}

/** Budget pool a row's tokens land in. Resolved from the trust-store's
 *  `pool_policy` + the global `allow_byok_background` master per the
 *  same logic as `resolveEffectiveLayer` in the per-record harness:
 *
 *    - `!allow_byok_background`           → `'free'`
 *    - `pool_policy: 'free_only'`         → `'free'`
 *    - `pool_policy: 'byok_only'`         → `'byok'`
 *    - `pool_policy: 'free_then_byok'`    → `'free'`  (the match
 *      resolver picks the free pool first; only spills to BYOK on
 *      free-pool exhaustion. The planner accounts the optimistic
 *      common case + lets the executor's reject-set advance any
 *      true spillage.) */
export type PlannerPool = 'free' | 'byok';

/** One row in the plan. Carries the source row's `_id`, the
 *  per-row token estimate (post pool-routing), and the action it's
 *  enqueued for. The drain consumer iterates these directly. */
export interface PlannerLeaf {
  row_id: string;
  topic: string;
  scope: string | null;
  target_id: string | null;
  lifecycle_action_pending: string;
  pool: PlannerPool;
  /** Per-row token estimate as folded into the plan. Equal to the
   *  producer's `estimate_per_record_tokens()` value for non-dedup-hit
   *  leaves; `0` when the pre-flight dedup probe matched (the row will
   *  short-circuit at execute time without spending tokens). */
  estimated_tokens: number;
}

/** Reasons a pending row was excluded from the plan, surfaced for
 *  observability + Settings-side rendering. Closed-list so callers can
 *  render to user-facing copy without an open-vocab string drift.
 *
 *  - `'topic_unknown_to_registry'` — pending row references a topic
 *    no producer is registered for (defensive — should never happen
 *    in production, but we surface it cleanly rather than silently
 *    dropping).
 *  - `'not_ai_surface'` — topic is AI-surface-false in the producer
 *    registry. Walk-cap is for AI-surface topics; deterministic ones
 *    don't burn tokens so they aren't budgeted here. The drain
 *    consumer still runs them — they just bypass the walk-cap gate.
 *  - `'trust_off'` / `'trust_manual'` — D-132 trust state is `'off'`
 *    or `'manual'`. The user has gated this topic from auto-running.
 *  - `'paused_ai'` — the global Pause-AI window is active and the
 *    topic is AI-surface. */
export type PlannerSkipReason =
  | 'topic_unknown_to_registry'
  | 'not_ai_surface'
  | 'trust_off'
  | 'trust_manual'
  | 'paused_ai';

export interface PlannerSkippedRow {
  row_id: string;
  topic: string;
  reason: PlannerSkipReason;
}

/** Output of `planHousekeepingCycle`. The drain consumer reads
 *  `over_budget` first; if true it short-circuits the cycle (yields
 *  early with `'budget_exhausted'`). When false, it walks
 *  `will_compute` in order, looks up each leaf's producer, and
 *  re-runs `produce()`. */
export interface CyclePlan {
  /** Every pending leaf carried into planning, after trust + AI-surface
   *  filtering. Ordered by `(topic, target_id, _id)` for deterministic
   *  re-runs. The drain consumer iterates `will_compute` (a strict
   *  subset that excludes dedup hits) for the actual work. */
  leaves: ReadonlyArray<PlannerLeaf>;
  /** Leaves the pre-flight dedup probe matched — these rows will
   *  short-circuit at execute time without spending tokens. The
   *  drain consumer can clear their `lifecycle_action_pending` field
   *  in bulk without re-running the producer (P5b.D wires the
   *  bookkeeping). Empty when the planner runs without producer-version
   *  metadata wired (the conservative path). */
  dedup_hits: ReadonlyArray<PlannerLeaf>;
  /** Leaves that will actually run the producer. `leaves \ dedup_hits`. */
  will_compute: ReadonlyArray<PlannerLeaf>;
  /** Sum of per-row token estimates routed to the free pool. */
  estimated_free_tokens: number;
  /** Sum of per-row token estimates routed to the BYOK pool. */
  estimated_byok_tokens: number;
  /** Free-pool budget remaining after subtracting today's consumed
   *  total from the configured cap. Negative when the pool has spilled
   *  past its budget (over-spend defended by the drain consumer's
   *  monotonic check). */
  remaining_free: number;
  /** BYOK-pool budget remaining (same shape). */
  remaining_byok: number;
  /** True iff `estimated_free_tokens > remaining_free` OR
   *  `estimated_byok_tokens > remaining_byok`. The drain consumer
   *  yields `'budget_exhausted'` on this signal. */
  over_budget: boolean;
  /** Rows excluded from `leaves` for trust / AI-surface reasons. */
  skipped: ReadonlyArray<PlannerSkippedRow>;
}

export interface PlanHousekeepingCycleOpts {
  db: Database.Database;
  store: EnrichmentStore;
  trustStore?: TrustStore;
  config: PlannerConfig;
  state: PlannerBudgetState;
  /** Per-topic producer metadata (token estimate + AI-surface flag).
   *  Caller assembles from the housekeeping registry. Topics absent
   *  from this list surface as `'topic_unknown_to_registry'` skipped
   *  rows. */
  producers: ReadonlyArray<PlannerProducerInfo>;
  now: number;
  /** Optional per-row dedup probe. When wired, the planner queries
   *  for a match against `(topic, scope, target_id, source_record_hash,
   *  producer_version_hash)`; matches are folded into `dedup_hits`.
   *  Tests + the initial drain consumer integration leave undefined —
   *  budgeting then runs conservative (every leaf is `will_compute`). */
  probeDedup?: (row: EnrichmentRecord) => boolean;
  /** Optional sentinel cap on the number of pending rows surveyed.
   *  Defaults to 10_000 — well above per-cycle steady-state — so the
   *  planner's `SELECT *` doesn't unbounded-scan a pathological
   *  warehouse. Cycles that hit the cap log + the drain consumer
   *  re-plans next cycle. */
  pending_limit?: number;
}

const DEFAULT_PENDING_LIMIT = 10_000;

// ────────────────────────────────────────────────────────────────
// Daily window helpers
// ────────────────────────────────────────────────────────────────

/** Roll the daily token-budget window forward when `now` lies past
 *  the previous window's 24h boundary. Returns the rolled state +
 *  whether a roll happened so callers can persist the reset. NULL
 *  `budget_window_start` is treated as "never opened" — the first
 *  call seeds it to UTC midnight of `now`.
 *
 *  Pure function: callers (the planner + the drain consumer) decide
 *  when to persist. Persistence shape lives on `housekeeping_state`
 *  per spec §A.6. */
const DAY_MS = 24 * 60 * 60 * 1000;

const utcMidnight = (now: number): number => {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
};

export interface BudgetWindowRollResult {
  state: PlannerBudgetState;
  rolled: boolean;
}

export const rollBudgetWindow = (
  state: PlannerBudgetState,
  now: number,
): BudgetWindowRollResult => {
  if (state.budget_window_start === null) {
    return {
      state: {
        tokens_consumed_today_free: state.tokens_consumed_today_free,
        tokens_consumed_today_byok: state.tokens_consumed_today_byok,
        budget_window_start: utcMidnight(now),
      },
      rolled: false, // first-open, not a true rollover
    };
  }
  if (now - state.budget_window_start < DAY_MS) {
    return { state, rolled: false };
  }
  return {
    state: {
      tokens_consumed_today_free: 0,
      tokens_consumed_today_byok: 0,
      budget_window_start: utcMidnight(now),
    },
    rolled: true,
  };
};

// ────────────────────────────────────────────────────────────────
// Planner
// ────────────────────────────────────────────────────────────────

const indexProducers = (
  producers: ReadonlyArray<PlannerProducerInfo>,
): Map<string, PlannerProducerInfo> => {
  const out = new Map<string, PlannerProducerInfo>();
  for (const p of producers) out.set(p.topic, p);
  return out;
};

/** Resolve which pool a topic's tokens route to. Mirrors
 *  `resolveEffectiveLayer` in `enrichment-producer.ts` — the executor
 *  honours the same precedence at runtime, so the planner's account
 *  matches what's actually spent. */
const resolvePool = (
  pool_policy: 'free_only' | 'free_then_byok' | 'byok_only',
  allow_byok_background: boolean,
): PlannerPool => {
  if (!allow_byok_background) return 'free';
  if (pool_policy === 'byok_only') return 'byok';
  // 'free_only' + 'free_then_byok' both account against free for the
  // optimistic common case — the executor's reject-set advances any
  // spillage if the free pool runs dry mid-cycle.
  return 'free';
};

export const planHousekeepingCycle = (opts: PlanHousekeepingCycleOpts): CyclePlan => {
  const { db, store, trustStore, config, state, producers, now } = opts;
  const limit = opts.pending_limit ?? DEFAULT_PENDING_LIMIT;
  const producerByTopic = indexProducers(producers);
  // Narrow at the SQL level — only ai-surface topics enter the budget
  // pass. Non-ai-surface topics still drain (P5b.D walks them
  // separately) but they don't contribute to the token budget.
  const aiSurfaceTopics = producers
    .filter((p) => p.is_ai_surface && p.token_estimate_per_record > 0)
    .map((p) => p.topic);

  const skipped: PlannerSkippedRow[] = [];
  const leaves: PlannerLeaf[] = [];
  const dedup_hits: PlannerLeaf[] = [];
  let estimated_free_tokens = 0;
  let estimated_byok_tokens = 0;

  if (aiSurfaceTopics.length === 0) {
    // No AI-surface topics in registry → nothing to budget. Still
    // surface the skipped rows pending in the queue so the drain
    // consumer can see them (deterministic / unknown topics).
    const pendingAll = store.listLifecycleActionPending({ limit });
    for (const row of pendingAll) {
      const info = producerByTopic.get(row.topic);
      const reason: PlannerSkipReason = info
        ? 'not_ai_surface'
        : 'topic_unknown_to_registry';
      skipped.push({ row_id: row._id, topic: row.topic, reason });
    }
    const remaining_free = config.daily_token_budget_free - state.tokens_consumed_today_free;
    const remaining_byok = config.daily_token_budget_byok - state.tokens_consumed_today_byok;
    return {
      leaves: [],
      dedup_hits: [],
      will_compute: [],
      estimated_free_tokens: 0,
      estimated_byok_tokens: 0,
      remaining_free,
      remaining_byok,
      over_budget: false,
      skipped,
    };
  }

  const pending = store.listLifecycleActionPending({
    topic_in: aiSurfaceTopics,
    limit,
  });

  // Pause-AI gate is global — short-circuit once. Topics that would
  // otherwise pass trust still skip when the user has paused AI.
  const aiPaused = isAiPaused(db, now);

  for (const row of pending) {
    const info = producerByTopic.get(row.topic);
    if (!info) {
      // Defensive — `aiSurfaceTopics` is built from `producers`, so
      // this shouldn't fire. Surface for observability if it does.
      skipped.push({ row_id: row._id, topic: row.topic, reason: 'topic_unknown_to_registry' });
      continue;
    }
    if (!info.is_ai_surface) {
      skipped.push({ row_id: row._id, topic: row.topic, reason: 'not_ai_surface' });
      continue;
    }

    if (trustStore) {
      const trust = trustStore.read(row.topic, info.is_ai_surface);
      if (trust.trust_state === 'off') {
        skipped.push({ row_id: row._id, topic: row.topic, reason: 'trust_off' });
        continue;
      }
      if (trust.trust_state === 'manual') {
        skipped.push({ row_id: row._id, topic: row.topic, reason: 'trust_manual' });
        continue;
      }
    }

    if (info.is_ai_surface && aiPaused) {
      skipped.push({ row_id: row._id, topic: row.topic, reason: 'paused_ai' });
      continue;
    }

    const pool: PlannerPool = trustStore
      ? resolvePool(
          trustStore.read(row.topic, info.is_ai_surface).pool_policy,
          config.allow_byok_background,
        )
      : 'free';

    const dedup_match = opts.probeDedup ? opts.probeDedup(row) : false;

    const leaf: PlannerLeaf = {
      row_id: row._id,
      topic: row.topic,
      scope: row.scope,
      target_id: row.target_id,
      lifecycle_action_pending: row.lifecycle_action_pending ?? 'recompute',
      pool,
      estimated_tokens: dedup_match ? 0 : info.token_estimate_per_record,
    };
    leaves.push(leaf);
    if (dedup_match) {
      dedup_hits.push(leaf);
      continue;
    }
    if (pool === 'free') {
      estimated_free_tokens += info.token_estimate_per_record;
    } else {
      estimated_byok_tokens += info.token_estimate_per_record;
    }
  }

  const will_compute = leaves.filter((l) => l.estimated_tokens > 0);

  const remaining_free = config.daily_token_budget_free - state.tokens_consumed_today_free;
  const remaining_byok = config.daily_token_budget_byok - state.tokens_consumed_today_byok;
  const over_budget =
    estimated_free_tokens > remaining_free ||
    estimated_byok_tokens > remaining_byok;

  return {
    leaves,
    dedup_hits,
    will_compute,
    estimated_free_tokens,
    estimated_byok_tokens,
    remaining_free,
    remaining_byok,
    over_budget,
    skipped,
  };
};

// ────────────────────────────────────────────────────────────────
// State persistence helpers
// ────────────────────────────────────────────────────────────────

/** Read budget-window state from `housekeeping_state`. The drain
 *  consumer's per-task row carries the counters; we hard-code the
 *  task id so all walk-cap usage shares one window per server. */
export const PLANNER_BUDGET_STATE_TASK_ID = '__d136_walk_cap_budget__';

/** Persist a snapshot of the rolled / consumed budget back to
 *  `housekeeping_state`. Idempotent on repeat — the task row is
 *  upserted under `PLANNER_BUDGET_STATE_TASK_ID`. */
export const persistBudgetState = (
  db: Database.Database,
  state: PlannerBudgetState,
  now: number,
): void => {
  db.prepare(
    `INSERT INTO housekeeping_state (
       task_id, cursor_json, last_run_at, last_status,
       tokens_consumed_today_free, tokens_consumed_today_byok,
       budget_window_start
     ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       tokens_consumed_today_free = excluded.tokens_consumed_today_free,
       tokens_consumed_today_byok = excluded.tokens_consumed_today_byok,
       budget_window_start = excluded.budget_window_start,
       last_run_at = excluded.last_run_at`,
  ).run(
    PLANNER_BUDGET_STATE_TASK_ID,
    JSON.stringify({ kind: 'complete' }),
    now,
    state.tokens_consumed_today_free,
    state.tokens_consumed_today_byok,
    state.budget_window_start,
  );
};

/** Read the persisted budget state back. Returns the zeroed shape
 *  with `budget_window_start: null` when no row has been written
 *  yet — `rollBudgetWindow` then seeds the window on first
 *  invocation. */
export const readBudgetState = (db: Database.Database): PlannerBudgetState => {
  const row = db
    .prepare(
      `SELECT tokens_consumed_today_free, tokens_consumed_today_byok, budget_window_start
         FROM housekeeping_state WHERE task_id = ?`,
    )
    .get(PLANNER_BUDGET_STATE_TASK_ID) as
    | {
        tokens_consumed_today_free: number;
        tokens_consumed_today_byok: number;
        budget_window_start: number | null;
      }
    | undefined;
  if (!row) {
    return {
      tokens_consumed_today_free: 0,
      tokens_consumed_today_byok: 0,
      budget_window_start: null,
    };
  }
  return {
    tokens_consumed_today_free: row.tokens_consumed_today_free,
    tokens_consumed_today_byok: row.tokens_consumed_today_byok,
    budget_window_start: row.budget_window_start,
  };
};

/** Suppress the unused-import warning on `isByokAllowedForBackground` —
 *  the planner reads `config.allow_byok_background` directly so the
 *  helper from `trust-store.ts` isn't needed here. Re-exporting keeps
 *  the import as a documentation pointer to the canonical resolver
 *  shape future callers may want. */
export const _PLANNER_TRUST_HELPER = isByokAllowedForBackground;
