/** D-123 — Housekeeping execution-mode contracts.
 *
 *  Third execution mode alongside D-115 reactive
 *  (`auto_run` + `trigger_steps`) and manual: idle-driven
 *  deterministic maintenance. Substrate-only types here — the runtime + persistence
 *  + scheduler live in `backend/server/src/housekeeping/` (server-
 *  internal; never reaches the WS rpc surface as data).
 *
 *  Design + load-bearing decisions: D-123. */

import type { EnrichmentTag } from './enrichment-registry.js';
import type { TokenUsageReport } from './token-usage-report.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Minimum slice of cycle budget required to start a task. Below
 *  this the cycle yields without picking up the next task — better
 *  to defer one tick than start a task that will yield immediately
 *  on its first SQL read. Matches the time-relative-watcher
 *  sweeper's per-tick floor. */
export const HOUSEKEEPING_MIN_TASK_BUDGET_MS = 500;

/** How often (ms) the scheduler wakes to re-evaluate idle. The
 *  evaluation itself is cheap — a counter read on the engine's
 *  in-flight execution map. The actual cycle interval lives in
 *  `housekeeping_config.cycle_interval_minutes`. */
export const HOUSEKEEPING_IDLE_PROBE_MS = 60_000;

/** Idle threshold in ms for the `aggressive` preset — server is
 *  considered idle if no recipe execution + no warehouse delta-sync
 *  has happened for this long. Other presets gate on time-window
 *  + cycle_interval, not idle threshold. */
export const HOUSEKEEPING_AGGRESSIVE_IDLE_THRESHOLD_MS = 5 * 60_000;

/** Single-row primary key for the `housekeeping_config` table —
 *  the housekeeping config is per-server, never per-instance,
 *  never per-recipe. */
export const HOUSEKEEPING_CONFIG_PRIMARY_KEY = 'singleton';

/** D-145 PA9.6 / PA11 — registry id under which the `gcDanglingRefs`
 *  task registers. Surfaced from the `housekeeping_cycle` broadcast
 *  (in `per_task[].task_id`) so paired clients can refresh stats / UI
 *  state live whenever a GC sweep completes. Authored once here so the
 *  task module + the housekeeping-handler + every webclient subscriber
 *  agree on a single literal. */
export const LLM_RESULT_CACHE_GC_TASK_ID = 'llm-result-cache-gc' as const;

/** D-250 § D8.1 slice 4 — recompute the owner metrics and fold them into the two
 *  metric stores.
 *
 *  ⛔ COMPUTE ONLY. § D4 splits the two acts: computing is genuinely maintenance and
 *  needs no authorization, so it rides housekeeping's `admin` ceiling legitimately.
 *  PUBLISHING is a new outward act and carries its OWN bounded, revocable grant —
 *  it must never ride this task's exemption. */
export const OWNER_METRICS_COMPUTE_TASK_ID = 'owner-metrics-compute' as const;

/** Bounds for `cycle_budget_ms` accepted by
 *  `housekeeping.config.write` — min 1s (anything below isn't
 *  useful work), max 10 min (beyond this the cycle should split
 *  into smaller intervals). */
export const HOUSEKEEPING_CYCLE_BUDGET_MIN_MS = 1_000;
export const HOUSEKEEPING_CYCLE_BUDGET_MAX_MS = 600_000;

/** Failure threshold per task — 3 consecutive errors flip
 *  `last_status: 'error'` and skip the task on subsequent cycles
 *  until the user resets, an `onInvalidate` hook fires, or
 *  `HOUSEKEEPING_AUTO_RETRY_AFTER_MS` passes. Mirrors the
 *  auto-run circuit-breaker per-recipe shape. */
export const HOUSEKEEPING_DISABLE_AFTER_FAILURES = 3;
export const HOUSEKEEPING_AUTO_RETRY_AFTER_MS = 24 * 60 * 60_000;

// ────────────────────────────────────────────────────────────────
// Preset → cycle config
// ────────────────────────────────────────────────────────────────

/** The four user-facing preset slugs + a magic `'off'` value that
 *  prevents the scheduler from constructing on boot at all. Off is
 *  for power users / debugging — not surfaced in the UI as a
 *  picker option, only via direct config edit. */
export type HousekeepingPreset = 'off' | 'light' | 'balanced' | 'aggressive' | 'custom';

/** Default preset on fresh install. Balanced is the right default —
 *  every 15 min when idle, 60s budget per cycle. Light / aggressive /
 *  custom are explicit user choice. */
export const HOUSEKEEPING_DEFAULT_PRESET: HousekeepingPreset = 'balanced';

/** Built-in cycle budget + interval per preset. `aggressive`
 *  ignores the interval and gates on
 *  `HOUSEKEEPING_AGGRESSIVE_IDLE_THRESHOLD_MS` instead. `custom`
 *  reads its values from the config row directly. */
export const HOUSEKEEPING_PRESET_DEFAULTS: Record<
  Exclude<HousekeepingPreset, 'off' | 'custom'>,
  { cycle_budget_ms: number; cycle_interval_minutes: number }
> = {
  light:      { cycle_budget_ms: 30_000,  cycle_interval_minutes: 60 },
  balanced:   { cycle_budget_ms: 60_000,  cycle_interval_minutes: 15 },
  aggressive: { cycle_budget_ms: 120_000, cycle_interval_minutes: 0 },
};

// ────────────────────────────────────────────────────────────────
// Cursor — closed discriminated union
// ────────────────────────────────────────────────────────────────

/** Per-task progress marker. Closed discriminator over five kinds
 *  plus `complete`. New shapes require widening the union — keeps
 *  the persistence layer's serialize / deserialize flat.
 *
 *  D-138 P3 — `'time_email'` variant: like `'time'` but pairs the
 *  timestamp with a tiebreaker `last_email` so a same-millisecond
 *  group of rows can split across batches without losing peers
 *  inside the boundary. Walkers using this variant query
 *  `WHERE updated_at > ? OR (updated_at = ? AND email > ?)`
 *  ordered `(updated_at ASC, email ASC)`.
 *
 *  D-192 S4c2 — `'delta'` variant: an OPAQUE, vendor-owned incremental
 *  token (Microsoft Dynamics OData `$deltatoken` / a `@odata.deltaLink`
 *  URL — any `sync_kind: 'delta_cursor'` engagement vendor). The harness
 *  never interprets `token`; it hands the prior value to the reconciler
 *  before a walk and persists the new terminal watermark after a COMPLETE
 *  walk (an undrained / budget-yielded walk holds the prior token, so the
 *  next cycle re-walks from the same ref — mirrors the file-source
 *  `shapeDeltaOutcome` undrained-suppression rule). Cold start = `token: ''`
 *  ⇒ the vendor leaf drains from scratch. */
export type HousekeepingCursor =
  | { kind: 'time'; last_seen_at: number }
  | { kind: 'time_email'; last_seen_at: number; last_email: string }
  | { kind: 'index'; collection: string; offset: number }
  | { kind: 'auto_id'; collection: string; max_id_seen: number }
  | { kind: 'topic'; topic: string; scope?: string; max_target_id_seen: string }
  | { kind: 'delta'; token: string }
  | { kind: 'complete' };

/** Yield reason returned alongside a yielded cursor. Used by the
 *  Settings UI's per-task status table + the cycle audit row.
 *
 *  D-132 P2 — `'pool_policy_unsatisfiable'` covers two cases the
 *  per-topic pool-policy gate skip-and-logs without erroring the
 *  task: `pool_policy: 'free_only'` when the free pool has no
 *  available entry, and `pool_policy: 'byok_only'` when no BYOK slot
 *  is configured. The harness writes a structured entry into the
 *  task's `last_errors_json` ring buffer for the detail drawer; the
 *  scheduler treats this as a yield (not an error) so the task
 *  doesn't accumulate `consecutive_errors` toward the auto-disable
 *  threshold. */
export type HousekeepingYieldReason =
  | 'budget_exhausted'
  | 'no_work'
  | 'dependency_pending'
  | 'pool_policy_unsatisfiable'
  // D-184 — the shared per-(connection, vendor) VendorRateGate: the daily API
  // budget is spent (`vendor_budget_suspended`) or another reconciler pull is
  // already in flight for the same connection (`vendor_pull_in_flight`); both
  // are clean yields (resume next idle window), not errors.
  | 'vendor_budget_suspended'
  | 'vendor_pull_in_flight';

/** R13 T1-Q2 — cascade-governor telemetry a task carries out of one
 *  step. A governor-declined topic previously returned the same value
 *  as a genuinely calm one, so a persistently-declined topic looked
 *  persistently calm and the governor's dropped count was discarded.
 *  Optional: only tasks that consult `cascadeTopicAdmission` set it,
 *  and only when at least one topic was declined this step. */
export interface HousekeepingGovernorTelemetry {
  /** Topics whose recompute enqueue was declined by the cascade
   *  governor this step (severity left in place; re-asked next cycle). */
  declined_topics: number;
  /** Sum of the governor's `dropped` counts across those declines. */
  dropped_rows: number;
}

/** Per-step result returned by `HousekeepingTaskInstance.step`. The
 *  scheduler persists `cursor` after every call so a yield mid-step
 *  resumes cleanly on the next idle window. */
export type HousekeepingStepResult =
  | { status: 'yield'; reason: HousekeepingYieldReason; cursor: HousekeepingCursor; governor?: HousekeepingGovernorTelemetry }
  | { status: 'complete'; cursor: HousekeepingCursor; governor?: HousekeepingGovernorTelemetry };

// ────────────────────────────────────────────────────────────────
// Task metadata
// ────────────────────────────────────────────────────────────────

/** Producer-kind contract — `core` tasks are deterministic
 *  maintenance defined in D-123; `enrichment` tasks plug into the
 *  `ENRICHMENT_REGISTRY` entries with `producer_kind: 'housekeeping'`
 *  and ship in subsequent Ds. The Settings UI renders the two
 *  kinds in separate sections. */
export type HousekeepingTaskKind = 'core' | 'enrichment';

/** Static metadata describing a registered housekeeping task. The
 *  runtime executable (`step()` + optional `onInvalidate()`) lives
 *  on `HousekeepingTaskInstance` in the server-side registry — this
 *  contract package only carries the metadata so the WS rpc surface
 *  can transmit it. */
export interface HousekeepingTaskMeta {
  /** Stable task id, e.g. `'audit-compaction'` or
   *  `'enrichment.thread_signals'`. Acts as the primary key of
   *  `housekeeping_state`. */
  id: string;
  /** One-line user-facing description shown on the Settings →
   *  Server → Housekeeping panel's task table. */
  description: string;
  /** True → the engine may call `step()` with a small remaining
   *  budget knowing the task can yield mid-work. False → only
   *  call when full cycle_budget_ms is available. Most tasks are
   *  interruptible by design (cursor-checkpointed). */
  interruptible: boolean;
  /** Other task ids that must be `last_status: 'complete'` before
   *  this task is eligible to run in the same cycle. Topo-sorted
   *  at registry-init; cycles throw. */
  depends_on?: ReadonlyArray<string>;
  /** Discriminator between deterministic core tasks and
   *  registry-driven enrichment producers. */
  kind: HousekeepingTaskKind;
  /** When `false`, the scheduler's idle-cycle path skips this task —
   *  it can only fire via the `Run now` rpc. Producers whose
   *  `estimate_per_record_tokens()` returns a positive value derive
   *  this as `false` so the user explicitly confirms before any AI
   *  spend. Deterministic producers (cost = 0) and core tasks default
   *  to `true` (or omit the field).
   *
   *  Treated as `true` when undefined for back-compat with existing
   *  task registrations. */
  idle_eligible?: boolean;
  /** D-134 — chip-filter tags for the housekeeping panel UI. Merged
   *  view of:
   *    - Author-declared tags from `EnrichmentDefinition.tags`
   *      (`platform:` / `industry:` / `department:`).
   *    - Auto-derived `domain:` / `policy:` / `shape:` / `kind:` from
   *      the registry definition.
   *    - `surface:ai` / `surface:deterministic` stamped from the
   *      task instance's `is_ai_surface` flag.
   *
   *  For core tasks (no `EnrichmentDefinition`), authors hand-write
   *  the full tag set — typically `kind:core` plus `domain:` /
   *  `surface:deterministic`. Tags are display-time hints only; they
   *  don't gate scheduling, trust, or pool routing. */
  tags?: ReadonlyArray<EnrichmentTag>;
}

// ────────────────────────────────────────────────────────────────
// Persistence row shapes
// ────────────────────────────────────────────────────────────────

/** Row shape for the per-server `housekeeping_config` singleton
 *  table. Returned from `housekeeping.config.read` rpc. */
export interface HousekeepingConfigRow {
  preset: HousekeepingPreset;
  cycle_budget_ms: number;
  cycle_interval_minutes: number;
  custom_window_start_hour?: number;
  custom_window_end_hour?: number;
  /** D-132 — when `true`, AI-surface housekeeping producers may use the
   *  user's BYOK key. When `false` (the default), every effective pool
   *  policy collapses to `'free_only'` regardless of the per-topic
   *  setting. Persisted as INTEGER 0/1 in `housekeeping_config`. */
  allow_byok_background: boolean;
  /** D-132 — global pause-AI window. When set + `now < pause_background_ai_until`,
   *  every AI-surface producer skips the idle cycle / reactive
   *  dispatch path. `null` = no pause window active. The top-bar
   *  Pause-AI duration picker (1h / 4h / 24h / Until I resume) writes
   *  this via `housekeeping.config.write`. */
  pause_background_ai_until: number | null;
  updated_at: number;
}

/** Persisted per-task progress + last-run telemetry. Returned in
 *  `HousekeepingTaskStatus`'s `state` field via the
 *  `housekeeping.status.read` rpc. */
export type HousekeepingLastStatus = 'pending' | 'in_progress' | 'complete' | 'error';

export interface HousekeepingStateRow {
  task_id: string;
  cursor: HousekeepingCursor;
  last_run_at?: number;
  last_run_duration_ms?: number;
  /** D-250 § D — provider tokens the last step actually spent.
   *
   *  🔑 A SCALAR, DELIBERATELY, matching `last_run_duration_ms` beside it. The full
   *  {@link TokenUsageReport} — cache reads, provider calls, the breakdown — rides the
   *  `housekeeping_cycle` audit row; this is the latest-snapshot field the status surface
   *  renders, and a JSON blob on a state table would be storing analytics where a dashboard
   *  number belongs.
   *
   *  ⚠ ABSENT when the last step made no provider call, which is most tasks — never zero.
   *  ⚠ Sits beside `tokens_consumed_today_*`, which are the planner's ESTIMATE
   *  (`estimate_per_record_tokens()` x pending rows). Having both on one row is the point:
   *  the estimate becomes checkable against what the providers actually charged. */
  last_run_tokens?: number;
  last_yield_reason?: HousekeepingYieldReason;
  last_status: HousekeepingLastStatus;
  consecutive_errors: number;
  last_error?: string;
}

// ────────────────────────────────────────────────────────────────
// Cycle telemetry
// ────────────────────────────────────────────────────────────────

/** Per-task outcome inside a single cycle run. Aggregated into the
 *  `housekeeping_cycle` audit row's `detail.per_task`. */
export interface HousekeepingPerTaskResult {
  task_id: string;
  status: 'complete' | 'yield' | 'error';
  duration_ms: number;
  yield_reason?: HousekeepingYieldReason;
  /** R13 T1-Q2 — present iff the task reported governor declines this
   *  step; rides into the `housekeeping_cycle` audit row so a
   *  persistently-declined topic is distinguishable from a calm one. */
  governor?: HousekeepingGovernorTelemetry;
  /** D-250 § D — provider tokens this task actually spent, riding into the
   *  `housekeeping_cycle` audit row the same way `governor` does.
   *
   *  ⛔ THE ROW'S ONLY MEASUREMENT. `housekeeping_config`'s daily token budget
   *  is an ESTIMATE (`estimate_per_record_tokens()` x pending rows) used to
   *  decide whether to start a cycle; this is what the providers charged. With
   *  both on the same surface the estimate becomes checkable instead of merely
   *  load-bearing.
   *
   *  ⚠ ABSENT ON EVERY TASK THAT MADE NO PROVIDER CALL, which is most of them —
   *  never zero, the same rule `AuditEntry.total_usage` follows. */
  tokens?: TokenUsageReport;
}

/** Result of one full scheduler cycle. Emitted on the realtime bus
 *  as `RealtimeHousekeepingCycleEvent` + persisted as one
 *  `data.memory` row. */
export interface HousekeepingCycleResult {
  preset: HousekeepingPreset;
  duration_ms: number;
  tasks_stepped: number;
  tasks_complete: number;
  tasks_yielded: number;
  tasks_errored: number;
  per_task: ReadonlyArray<HousekeepingPerTaskResult>;
}

// ────────────────────────────────────────────────────────────────
// P5 — Settings UI rpc shapes
// ────────────────────────────────────────────────────────────────

/** D-132 P6 — One declared source-collection footprint entry. Server-
 *  side `bin.ts` derives this from the producer manifest's
 *  `scope_read_declaration` plus a per-collection record count query
 *  at preview time. Surfaced on `HousekeepingEnrichmentInfo.scope_read`
 *  for the Run-Now dialog + the Settings detail drawer. The UI mirror
 *  in `@recued/ui-shared/server-settings/housekeeping/state.ts` aliases
 *  this shape so the drawer can fall back to state-side scope when a
 *  pre-`status.read` boot race hides the field. */
export interface HousekeepingScopeReadEntry {
  /** Canonical collection name — `'data.mail'`, `'data.calendar'`,
   *  `'data.contact'`, `'data.file'`, or an enrichment scope. */
  collection: string;
  /** 3-5 field paths the user should know are inspected. Mirrors the
   *  producer manifest's `scope_read_declaration[i].sample_field_paths`. */
  sample_field_paths: ReadonlyArray<string>;
  /** Records visible in the collection at preview time — bin.ts
   *  computes by counting rows in the source scope. Typically equal
   *  to `source_collection_count` for the producer's primary scope;
   *  may differ when a producer reads cross-collection enrichment
   *  rollups. Undefined means the host couldn't resolve a count
   *  (e.g. early boot before the source walker is wired). */
  record_count?: number;
}

/** Per-record token estimate + current source-collection size for
 *  a `kind: 'enrichment'` task. The Settings UI multiplies them to
 *  show a pre-run cost estimate on the *Run now* dialog. Server-side
 *  computed (the producer's `estimate_per_record_tokens()` + a count
 *  query against the source collection); always present on the
 *  `housekeeping.status.read` response for every enrichment task and
 *  always absent for `kind: 'core'` tasks. Deterministic producers
 *  (`thread_signals`) report `token_estimate_per_record: 0` — the
 *  dialog renders "no token cost" inline. */
export interface HousekeepingEnrichmentInfo {
  token_estimate_per_record: number;
  source_collection_count: number;
  /** Pre-confirm AI availability probe — set when the producer is
   *  AI-driven (`token_estimate_per_record > 0`). `true` means at
   *  least one slot or free-pool entry resolves at probe time;
   *  `false` means no AI path is configured and the *Run now*
   *  dialog should render the warning state instead of the cost
   *  preview. Undefined for deterministic producers (no AI required)
   *  and during early boot before the LLM config has loaded. */
  ai_path_available?: boolean;
  /** Human-shaped tag for the warning copy when `ai_path_available
   *  === false`. The dialog uses this to pick between "configure AI
   *  in Settings → AI" (`no_byok_no_freepool`), "AI quota is
   *  exhausted; wait for reset or add another key"
   *  (`quota_exhausted`), or "no embeddings model configured — add
   *  an OpenAI / Google / Mistral key alongside" (`no_embeddings_model`).
   *  D-131 A.3 widened the union when the embeddings probe shipped;
   *  the third reason only surfaces for vector-output producers
   *  (`producer.ai_surface === 'embeddings'`). */
  ai_path_reason?: 'no_byok_no_freepool' | 'quota_exhausted' | 'no_embeddings_model';
  /** D-132 P6 — declared scope-of-read with per-collection record
   *  counts. Surfaced on the *Run now* dialog so the user sees what
   *  the producer reads alongside the cost preview. The detail drawer
   *  uses the same payload (with state-side fallback during boot
   *  races). Empty array on early-boot when the manifest cache hasn't
   *  populated; deterministic producers + AI producers both ship the
   *  field once the manifest registers. */
  scope_read?: ReadonlyArray<HousekeepingScopeReadEntry>;
  /** D-132 P6 — effective pool policy after collapsing the per-topic
   *  policy through the global `allow_byok_background` master. The
   *  Run-Now dialog renders this so the user knows which AI tier the
   *  producer will actually hit. Undefined for deterministic producers
   *  (pool routing doesn't apply). */
  effective_pool_policy?: 'free_only' | 'free_then_byok' | 'byok_only';
  /** D-132 P6 — pass-through of the global BYOK master switch. When
   *  `false`, every per-topic pool policy collapses to `'free'` —
   *  surfacing this on the dialog lets the user understand why a
   *  `byok_only`-configured topic is running on free pool. Undefined
   *  for deterministic producers. */
  global_byok_allowed?: boolean;
}

/** Denormalized join of `HousekeepingTaskMeta` + `HousekeepingStateRow`
 *  returned by `housekeeping.status.read`. The persisted state may
 *  be `null` when a task has been registered but never stepped —
 *  `state` is then absent and the UI renders "not yet run". */
export interface HousekeepingTaskStatus {
  meta: HousekeepingTaskMeta;
  state?: HousekeepingStateRow;
  /** Set iff `meta.kind === 'enrichment'`. Drives the *Run now*
   *  dialog's token-cost preview. */
  enrichment?: HousekeepingEnrichmentInfo;
}

