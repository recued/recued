/** D-136 §A.7 P5b — Lifecycle queue drain consumer.
 *
 *  Core housekeeping task that walks the `lifecycle_action_pending`
 *  queue + dispatches per action:
 *
 *    - `'recompute'` — leaves the row for the per-producer
 *      enrichment task's stale-sweep to re-run. The cascade
 *      primitives + drift signal upstream already flipped
 *      `staleness_class` to `'stale'`, so the per-producer harness
 *      will pick it up on its next idle cycle. The drain task's
 *      role here is observational — it counts dispatched rows,
 *      respects the walk-cap budget gate (yields
 *      `'budget_exhausted'` early when over-budget), and clears
 *      LAP for dedup-hit rows so the per-producer cycle doesn't
 *      pointlessly walk them.
 *
 *    - `'discard'` — tombstones the row synchronously. Source data
 *      changed in a way the producer can no longer derive a value
 *      from (e.g. a calendar event was retracted, a contact merged
 *      into another); the cached enrichment is no longer
 *      meaningful. Tombstone preserves the D-120 link graph (the
 *      `_id` survives, just flagged `staleness_class = 'expired'`).
 *
 *    - `'permanently_failed'` — observability only. P6 wires the
 *      retry/backoff escalation that flips rows here once exhausted;
 *      P5b just counts them so Settings → Housekeeping renders the
 *      "X rows permanently failed" indicator. The drain neither
 *      retries nor tombstones these — the user resolves via topic-
 *      reset or vote-correction (P7).
 *
 *  Producer-version mismatch / cross-pool changes / source content
 *  changes are all handled by the per-producer harness's existing
 *  skip rule; the drain task doesn't try to re-derive itself. This
 *  separation keeps the drain consumer dependency-free vs. the
 *  producer registry while still draining the queue + tombstoning
 *  what needs tombstoning.
 *
 *  Cycle budget: drain task itself spends ZERO tokens (no producer
 *  dispatch). The walk-cap planner's `over_budget` signal still
 *  matters because it indicates the per-producer cycles ABOUT to
 *  run will exceed budget — the drain yields `'budget_exhausted'`
 *  early to signal the scheduler to pause AI-surface producer
 *  cycles. P6 wires the actual scheduler-side gate that consumes
 *  this signal.
 *
 *  Spec: `docs/d-136-spec.md` §A.7 (walk-cap planner) + handover
 *  pickup actions (drain task scoped per spec). */

import {
  HOUSEKEEPING_MIN_TASK_BUDGET_MS,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';
import {
  planHousekeepingCycle,
  PLANNER_BUDGET_STATE_TASK_ID,
  persistBudgetState,
  readBudgetState,
  rollBudgetWindow,
  type CyclePlan,
  type PlannerProducerInfo,
} from '../cycle-planner.js';
import { listHousekeepingTasks } from '../registry.js';
import { isAiPaused } from '../trust-store.js';
import type { HousekeepingTaskInstance as TaskInstance } from '../registry.js';

/** Per-cycle drain summary. The scheduler folds this into the
 *  `housekeeping_cycle` audit row's `detail.per_task[i]` payload via
 *  the cursor's `last_status` carry-over; the Settings → Housekeeping
 *  panel reads it for the per-cycle counters. */
export interface LifecycleQueueDrainResult {
  pending_total: number;
  rows_tombstoned: number;
  rows_dedup_cleared: number;
  rows_recompute_dispatched: number;
  rows_permanently_failed_observed: number;
  rows_skipped_by_trust: number;
  rows_skipped_by_pause_ai: number;
  over_budget: boolean;
  estimated_free_tokens: number;
  estimated_byok_tokens: number;
  remaining_free: number;
  remaining_byok: number;
}

/** Stable id used by the scheduler + Settings panel to address the
 *  task. Distinct from `PLANNER_BUDGET_STATE_TASK_ID` (which is the
 *  bookkeeping row) — the task itself is registered separately. */
export const LIFECYCLE_QUEUE_DRAIN_TASK_ID = 'lifecycle-queue-drain';

/** Default budget config used when the housekeeping_config row hasn't
 *  been seeded yet. Mirrors the schema defaults. */
const DEFAULT_DAILY_TOKEN_BUDGET_FREE = 1_000_000;
const DEFAULT_DAILY_TOKEN_BUDGET_BYOK = 10_000_000;

interface DrainCursor {
  kind: 'time';
  last_seen_at: number;
}

const isDrainCursor = (cursor: HousekeepingCursor): cursor is DrainCursor =>
  cursor.kind === 'time';

/** Read the per-server budget config row. Returns the schema-default
 *  shape when the row hasn't been seeded (test paths + fresh DBs).
 *  We read the columns directly rather than going through
 *  HousekeepingConfigStore so we don't widen its public surface for
 *  one consumer; the schema already declares the columns + their
 *  defaults via `ensureHousekeepingSchema`. */
const readBudgetConfig = (
  ctx: HousekeepingContext,
): {
  daily_token_budget_free: number;
  daily_token_budget_byok: number;
  allow_byok_background: boolean;
  pause_background_ai_until: number | null;
} => {
  const row = ctx.db
    .prepare(
      `SELECT daily_token_budget_free, daily_token_budget_byok,
              allow_byok_background, pause_background_ai_until
         FROM housekeeping_config WHERE id = 'singleton'`,
    )
    .get() as
    | {
        daily_token_budget_free: number;
        daily_token_budget_byok: number;
        allow_byok_background: number;
        pause_background_ai_until: number | null;
      }
    | undefined;
  if (!row) {
    return {
      daily_token_budget_free: DEFAULT_DAILY_TOKEN_BUDGET_FREE,
      daily_token_budget_byok: DEFAULT_DAILY_TOKEN_BUDGET_BYOK,
      allow_byok_background: false,
      pause_background_ai_until: null,
    };
  }
  return {
    daily_token_budget_free: row.daily_token_budget_free,
    daily_token_budget_byok: row.daily_token_budget_byok,
    allow_byok_background: row.allow_byok_background === 1,
    pause_background_ai_until: row.pause_background_ai_until,
  };
};

/** Build the planner's per-topic producer-info list from the live
 *  housekeeping registry. The registry stamps `topic` + `is_ai_surface`
 *  + `token_estimate_per_record` (D-136 §A.7 P6 stamps the lossless
 *  value via `buildEnrichmentProducerTask`) on each enrichment task.
 *  Tasks missing the stamp (legacy / hand-built core tasks) fall
 *  back to the conservative default so the budget gate stays
 *  functional even when a future task class skips the wrapper. */
const DEFAULT_AI_TOKEN_ESTIMATE = 200;

const collectProducerInfos = (
  registry: ReadonlyArray<TaskInstance>,
): PlannerProducerInfo[] => {
  const out: PlannerProducerInfo[] = [];
  for (const task of registry) {
    if (!task.topic) continue;
    const isAiSurface = task.is_ai_surface ?? false;
    // P6 — read the stamped per-record estimate when present; fall
    // back only when the task didn't go through
    // `buildEnrichmentProducerTask` (deterministic core tasks skip
    // it entirely, but `is_ai_surface = false` then routes them to
    // the planner's `not_ai_surface` skip path regardless).
    const stamped = task.token_estimate_per_record;
    const tokenEstimate =
      typeof stamped === 'number' && Number.isFinite(stamped)
        ? Math.max(0, stamped)
        : isAiSurface
          ? DEFAULT_AI_TOKEN_ESTIMATE
          : 0;
    out.push({
      topic: task.topic,
      is_ai_surface: isAiSurface,
      token_estimate_per_record: tokenEstimate,
    });
  }
  return out;
};

/** Tombstone every row whose lifecycle_action_pending = 'discard'
 *  ACROSS THE FULL PENDING QUEUE — not just the planner's AI-surface
 *  subset. Discards are non-token work and should always tombstone
 *  regardless of trust state, Pause-AI, or whether the topic is
 *  AI-surface. Codex P5b review fix: prior code only saw discards
 *  the planner surfaced, missing deterministic-topic + trust-skipped
 *  discards. The store's `tombstoneRowIds` also clears LAP so
 *  tombstoned rows don't re-surface in `listLifecycleActionPending`
 *  next cycle. Returns count tombstoned. */
const tombstoneDiscardRows = (ctx: HousekeepingContext): number => {
  const allDiscards = ctx.db
    .prepare(
      `SELECT _id FROM data_enrichment
         WHERE lifecycle_action_pending = 'discard'
           AND superseded_by_id IS NULL
           AND is_pinned = 0
           AND tombstoned_at IS NULL`,
    )
    .all() as Array<{ _id: string }>;
  if (allDiscards.length === 0) return 0;
  return ctx.enrichmentStore.tombstoneRowIds(
    allDiscards.map((r) => r._id),
    'user_discarded',
  );
};

/** Clear lifecycle_action_pending on dedup-hit rows. The producer
 *  would re-derive the same value (source content + producer version
 *  unchanged), so spending a producer cycle on them is wasted work.
 *  Leaves staleness_class as-is — the per-producer harness's
 *  fresh_only filter ignores them, but the drain has cleared the
 *  queue marker so the budget gate doesn't see them as pending. */
const clearDedupHitLap = (
  ctx: HousekeepingContext,
  plan: CyclePlan,
): number => {
  if (plan.dedup_hits.length === 0) return 0;
  const ids = plan.dedup_hits.map((l) => l.row_id);
  const placeholders = ids.map(() => '?').join(',');
  const sql = `UPDATE data_enrichment
                  SET lifecycle_action_pending = NULL,
                      staleness_class = 'fresh',
                      last_evaluated_at = ?
                WHERE _id IN (${placeholders})`;
  return ctx.db.prepare(sql).run(ctx.now(), ...ids).changes;
};

/** Count rows surfaced by the planner with action = 'permanently_failed'.
 *  The drain task observes only — P6's retry/backoff path is what
 *  flips rows into this state in the first place. */
const countPermanentlyFailed = (plan: CyclePlan): number =>
  plan.leaves.filter((l) => l.lifecycle_action_pending === 'permanently_failed').length;

/** Drain task `step()` — pure orchestration over the planner +
 *  store. Returns observability counts via the cycle's audit row.
 *
 *  The cursor is mostly cosmetic since the drain is idempotent on
 *  re-fire (planner + cascade primitives both column-state-driven).
 *  Carrying `last_seen_at` lets the Settings panel render "drain
 *  last ran at T" alongside the per-task table. */
export const lifecycleQueueDrainStep = async (
  ctx: HousekeepingContext,
  cursor: HousekeepingCursor,
  budget_ms: number,
): Promise<HousekeepingStepResult> => {
  const start = ctx.now();
  const cursorAfter = (now: number): DrainCursor => ({
    kind: 'time',
    last_seen_at: now,
  });

  // Quick exit if we're cooked before doing anything — defensive,
  // budget_ms shouldn't be below the min task budget here.
  if (budget_ms < HOUSEKEEPING_MIN_TASK_BUDGET_MS) {
    return {
      status: 'yield',
      reason: 'budget_exhausted',
      cursor: cursorAfter(start),
    };
  }

  // Ensure the prior cursor's shape is valid; reset on first run.
  void isDrainCursor(cursor);

  // ── Build planner inputs ──────────────────────────────────────
  const config = readBudgetConfig(ctx);
  const aiPaused = isAiPaused(ctx.db, start);

  // Roll the budget window forward if a day has elapsed since the
  // last drain. Persist the rolled state so the next planner read
  // sees zeroed counters.
  const priorState = readBudgetState(ctx.db);
  const rolled = rollBudgetWindow(priorState, start);
  if (rolled.rolled || priorState.budget_window_start === null) {
    persistBudgetState(ctx.db, rolled.state, start);
  }

  const registry = listHousekeepingTasks();
  const producers = collectProducerInfos(registry);

  const plan = planHousekeepingCycle({
    db: ctx.db,
    store: ctx.enrichmentStore,
    ...(ctx.trustStore !== undefined ? { trustStore: ctx.trustStore } : {}),
    config: {
      daily_token_budget_free: config.daily_token_budget_free,
      daily_token_budget_byok: config.daily_token_budget_byok,
      allow_byok_background: config.allow_byok_background,
      pause_background_ai_until: config.pause_background_ai_until,
    },
    state: rolled.state,
    producers,
    now: start,
  });

  const skipped_trust =
    plan.skipped.filter((s) => s.reason === 'trust_off' || s.reason === 'trust_manual').length;
  const skipped_pause = plan.skipped.filter((s) => s.reason === 'paused_ai').length;

  const rows_tombstoned = tombstoneDiscardRows(ctx);
  const rows_dedup_cleared = clearDedupHitLap(ctx, plan);
  const rows_permanently_failed = countPermanentlyFailed(plan);
  const rows_recompute_dispatched = plan.will_compute.filter(
    (l) => l.lifecycle_action_pending === 'recompute',
  ).length;

  const summary: LifecycleQueueDrainResult = {
    pending_total: plan.leaves.length,
    rows_tombstoned,
    rows_dedup_cleared,
    rows_recompute_dispatched,
    rows_permanently_failed_observed: rows_permanently_failed,
    rows_skipped_by_trust: skipped_trust,
    rows_skipped_by_pause_ai: skipped_pause,
    over_budget: plan.over_budget,
    estimated_free_tokens: plan.estimated_free_tokens,
    estimated_byok_tokens: plan.estimated_byok_tokens,
    remaining_free: plan.remaining_free,
    remaining_byok: plan.remaining_byok,
  };

  // P5b — emit a structured audit row summarising the drain pass.
  // The Settings panel reads from cycle telemetry; the audit row
  // gives operators a per-drain trail. Best-effort — emission
  // errors don't fail the task.
  try {
    ctx.emitAuditRow({
      ts: ctx.now(),
      event_at: ctx.now(),
      action: 'lifecycle_queue_drain',
      target: 'system',
      run_mode: 'live',
      detail: {
        ...summary,
        ai_paused: aiPaused,
      },
    });
  } catch {
    /* best-effort */
  }

  // Over-budget signal: yield with budget_exhausted so the scheduler
  // (P6 will wire the consumer) knows AI-surface producer cycles
  // should pause this round.
  if (plan.over_budget) {
    return {
      status: 'yield',
      reason: 'budget_exhausted',
      cursor: cursorAfter(ctx.now()),
    };
  }

  return {
    status: 'complete',
    cursor: cursorAfter(ctx.now()),
  };
};

/** Read the most-recent drain summary off the audit feed for
 *  Settings → Housekeeping. Returns null when no drain has run yet.
 *  Looks at the latest `lifecycle_queue_drain` action row in
 *  `audit_entries`. */
export const readLatestDrainSummary = (
  ctx: HousekeepingContext,
): LifecycleQueueDrainResult | null => {
  const row = ctx.db
    .prepare(
      `SELECT json_extract(data, '$.detail') AS detail FROM audit_entries
         WHERE json_extract(data, '$.action') = 'lifecycle_queue_drain'
         ORDER BY json_extract(data, '$.started_at') DESC
         LIMIT 1`,
    )
    .get() as { detail: string | null } | undefined;
  if (!row?.detail) return null;
  try {
    return JSON.parse(row.detail) as LifecycleQueueDrainResult;
  } catch {
    return null;
  }
};

export const lifecycleQueueDrainTask: HousekeepingTaskInstance = {
  meta: {
    id: LIFECYCLE_QUEUE_DRAIN_TASK_ID,
    description:
      'Drain the lifecycle_action_pending queue: tombstone discards, clear dedup hits, observe recompute backlog, surface over-budget signals.',
    interruptible: false,
    kind: 'core',
    tags: ['kind:core', 'domain:enrichment', 'surface:deterministic'],
    // Deliberately runs FIRST in each cycle — depends_on undefined.
    // The per-producer enrichment tasks read `staleness_class` to
    // pick rows up; the drain's tombstones flip `expired` so those
    // tasks don't waste work on rows the user discarded.
  },
  step: lifecycleQueueDrainStep,

  // No invalidation hook — the drain is pure observational +
  // tombstone discipline; cascade engine signals don't reset
  // anything for the drain to re-walk (it walks the SQL queue
  // itself each cycle).
};

/** Suppress dead-code warning on the planner-state task id export —
 *  the drain task uses `readBudgetState` / `persistBudgetState`
 *  directly, but external callers (Settings panel, tests) reference
 *  the constant. */
export const _DRAIN_REFERENCES_BUDGET_STATE_TASK_ID = PLANNER_BUDGET_STATE_TASK_ID;
