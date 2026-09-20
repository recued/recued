// D-181 Slice 4 — the live active-list + kill control surface.
//
// Slices 2/3 bounded the heavy *call* (the two-lane governor) and bounded its
// *duration* (progress-based stall detection). This slice makes a running /
// queued heavy call **visible and controllable**: an in-flight registry (server-
// side) surfaces the active runs + lane queues, and a small `execution.*` rpc set
// lets the **owner** kill a running op, cancel a queued call before it dispatches,
// or promote it ahead of a blocker. The list is a USER surface, session-scoped —
// the agent (`contracted_user`) never sees or drives it (D-181 §7b / §8).
//
// The read shape (`ActiveExecutionEntry` / `LaneStatus`) and the rpc request /
// response types live here; the registry + semaphore queue control + kill
// mechanisms are the backend impl. See D-181 §4/§7/§13.
//
// Naming note: the spec §13 calls the active-list read `execution.list`, but that
// method name is already taken by the D-174 Runs/Audit feed (a paginated read
// over the audit log). The live-control read is therefore `execution.active`;
// the three mutators (`execution.kill` / `cancel` / `promote`) are collision-free.

import type { ExecutionSource } from './commits.js';
import type { ExecutionLane, ProgressContract } from './execution-lane.js';
import type { StallReason } from './stall-detection.js';
import type { RiskTier } from './ingredient.js';

/** Display-clarity category for a failed / killed run, surfaced on the Runs
 *  surface so the user can tell *why* a run ended (D-181 §5/§12). Mapped from
 *  the kill mechanism / subprocess exit signal / stall flag and persisted via
 *  the `heavy_op.kill_reason` telemetry field + the run error. */
export type HeavyOpErrorCategory =
  | 'timeout'
  | 'oom'
  | 'crashed'
  | 'stalled'
  | 'killed'
  | 'cancelled_before_dispatch';

/** Closed set of every `HeavyOpErrorCategory`, in canonical order. */
export const HEAVY_OP_ERROR_CATEGORIES: readonly HeavyOpErrorCategory[] = [
  'timeout',
  'oom',
  'crashed',
  'stalled',
  'killed',
  'cancelled_before_dispatch',
] as const;

/** The structured kill telemetry a long-op carries on a `RecipeError.details`
 *  (under `details.heavy_op`) when its cli/`service` subprocess was force-killed
 *  by the stall monitor (D-181 §6). The engine preserves a thrown executor's
 *  `heavy_op` into the failing step error's `details` so it survives into the
 *  run errors the audit-anchor write reads — keeping the slice-5 category
 *  derivation structural (no error-message string matching). */
export interface HeavyOpKillTelemetry {
  /** `silent_cap` ⇒ the generous fail-safe hard cap tripped (a `timeout`-class
   *  outcome); `no_progress` ⇒ the per-op progress signal stalled for `k·T`
   *  (a `stalled`-class outcome). */
  kill_reason?: StallReason | null;
  progress_signal_count?: number;
}

/** A run's control-termination as recorded by the in-flight registry (D-181
 *  §7): an owner kill, or a queued call cancelled before it dispatched. */
export type RunControlTermination = 'killed' | 'cancelled_before_dispatch';

/** D-181 §7c (cancel-marker root fix) — derive the run's owner-control termination
 *  label from the AUTHORITATIVE signals, not from a run-level registry marker that
 *  `cancel()` used to write optimistically (a queued-call cancel doesn't always
 *  terminate the run — an OPTIONAL prefetch / foreach cancel is swallowed by the
 *  engine and the run keeps running). Two sources:
 *    - `killed` — the registry's kill marker (the owner's deliberate
 *      `execution.kill`). ALWAYS honored, even on a run that completed before the
 *      abort was observed (a kill firing when only transforms/guards remain).
 *    - `cancelled_before_dispatch` — derived ONLY when the run actually FAILED and
 *      a step error carries the `slot_cancelled` marker the engine preserves when
 *      a gated call's queued slot was dropped. A swallowed cancel leaves no such
 *      error, so a run that succeeds / pauses / fails for an unrelated reason is
 *      never mislabelled cancelled.
 *  `killed` takes precedence (a kill of a queued call also surfaces a
 *  `slot_cancelled` error, but the deliberate kill is the truer label). */
export const deriveRunTermination = (input: {
  killed: boolean;
  success: boolean;
  errors?: ReadonlyArray<{ details?: Record<string, unknown> }>;
}): RunControlTermination | undefined => {
  if (input.killed) return 'killed';
  if (
    !input.success
    && (input.errors ?? []).some((e) => e.details?.slot_cancelled === true)
  ) {
    return 'cancelled_before_dispatch';
  }
  return undefined;
};

/** Derive the display `HeavyOpErrorCategory` for a failed / killed run from the
 *  structured signals available at the audit-anchor write (D-181 §12) — never by
 *  string-matching an error message. Precedence:
 *    1. an owner control-termination (`killed` / `cancelled_before_dispatch`),
 *       the in-flight registry's authoritative marker;
 *    2. a stall-monitor force-kill telemetry on any run error
 *       (`silent_cap` → `timeout`, `no_progress` → `stalled`).
 *  Returns `undefined` when neither is present — an ordinary failure carries no
 *  long-op category (the Runs surface just shows `failed`). `oom` / `crashed`
 *  (RSS / exit-signal derived) await the §10 `heavy_op` telemetry harvest. */
export const deriveHeavyOpErrorCategory = (input: {
  termination?: RunControlTermination;
  errors?: ReadonlyArray<{ details?: Record<string, unknown> }>;
}): HeavyOpErrorCategory | undefined => {
  if (input.termination === 'killed') return 'killed';
  if (input.termination === 'cancelled_before_dispatch') {
    return 'cancelled_before_dispatch';
  }
  for (const err of input.errors ?? []) {
    const heavy = err.details?.heavy_op;
    if (heavy !== null && typeof heavy === 'object') {
      const reason = (heavy as HeavyOpKillTelemetry).kill_reason;
      if (reason === 'silent_cap') return 'timeout';
      if (reason === 'no_progress') return 'stalled';
    }
  }
  return undefined;
};

/** How a running entry is killed, typed by op class (D-181 §4/§7a):
 *  - `sigkill`       — a cli/`service` subprocess: SIGKILL the child `pid`.
 *  - `process_group` — a D-179 detached job: process-group kill via its marker.
 *  - `abandon_await` — external-io / `ai`: abandon the run's await (no inference
 *    cancel — the upstream may still complete + bill, then be discarded /
 *    tombstoned, consistent with "no mid-flight LLM abort"). */
export type KillDescriptor =
  | { mechanism: 'sigkill'; pid: number }
  | { mechanism: 'process_group'; pid_marker: string }
  | { mechanism: 'abandon_await'; run_id: string };

/** The lifecycle state of an active entry as it appears on the live list.
 *  `stopping` (D-181 slice-4 #1 resolution) is a run the owner has killed /
 *  whose queued call was cancelled but which has not yet retired from the list.
 *  It gives the owner instant feedback that the kill registered — the entry
 *  flips `running` → `stopping`, then drops when the caller-facing run abandons
 *  its await. A non-cancellable external/AI transport may continue draining
 *  behind that terminal boundary; its late result is commit-tombstoned. */
export type ActiveExecutionState = 'running' | 'waiting_slot' | 'detached' | 'stopping';

/** One row of the live active-list (D-181 §4). A `run` entry is a recipe run
 *  with a heavy call currently holding a slot; a `queued-call` entry is a heavy
 *  call blocked on slot acquisition (`waiting_slot`); a `detached-job` entry is
 *  an unbounded D-179 detached job. */
export interface ActiveExecutionEntry {
  entry_kind: 'run' | 'queued-call' | 'detached-job';
  /** Present iff `entry_kind === 'queued-call'` — the id used to `cancel` /
   *  `promote` the queued call. */
  queued_call_id?: string;
  /** Absent only for a queued-call whose run has not been threaded down (the
   *  queue feed always carries it once the descriptor does). */
  run_id?: string;
  recipe_id: string;
  dish_id?: string;
  /** Bounded, host-derived description of what the live run is doing. These
   *  fields are safe to project into an agent turn: they describe declared
   *  recipe form only and never include config, vault, context, or outputs. */
  intent?: string;
  risk?: RiskTier;
  effect?: string;
  step_id?: string;
  /** The lane this entry occupies / waits on; absent for a detached-job. */
  lane?: ExecutionLane;
  state: ActiveExecutionState;
  /** Attended (a human is plausibly watching) vs unattended (scheduled /
   *  reactive / housekeeping). Governs whether a stall auto-kills (§6). */
  origin: 'attended' | 'unattended';
  /** D-153 origin — `(channel × actor × contract_id?)`. */
  source: ExecutionSource;
  /** Session-scoping for the list (§7b); absent for unattended runs. */
  session_id?: string;
  started_at: number;
  slot_acquired_at?: number;
  progress: { contract: ProgressContract; last_signal_at?: number; stalled: boolean };
  /** D-274 §8 — the heavy call running under this run right now, so a live
   *  readout can show TWO clocks: the recipe's elapsed and this op's. `started_at`
   *  is the RUN's, which for a multi-step recipe says nothing about how long the
   *  op a human is staring at has been going. Absent when no subprocess is
   *  attached (an external-io / AI-only run, or between steps). Bounded,
   *  host-derived, safe to project into an agent turn — the op KEY only, never
   *  argv, cwd, config or output. */
  current_op?: { op: string; started_at: number; pid: number };
  kill: KillDescriptor;
}

/** A snapshot of one lane's occupancy for the server-status line + the live
 *  list (D-181 §4/§12). */
export interface LaneStatus {
  lane: ExecutionLane;
  /** Auto-detected capacity N. */
  capacity: number;
  in_use: number;
  queued: number;
  /** Wall-clock age (ms) of the oldest queued waiter; 0 when none queued. */
  oldest_wait_ms: number;
}

/** Per-channel renderer entitlement for the live list — its OWN capability
 *  leaf, deliberately NOT the D-163 `ask` taxonomy (D-181 §8, fold #8):
 *  - `none`    — no list (e.g. the MCP machine consumer);
 *  - `view`    — read-only mirror, no queue mutation (e.g. a non-approval bridge);
 *  - `control` — full kill / cancel / promote (webclient; an approval-mode bridge). */
export type LiveControlCapability = 'none' | 'view' | 'control';

// ────────────────────────────────────────────────────────────────
// rpc request / response shapes (D-181 §13) — owner-only, reserved
// out of MCP. The read is `execution.active`; the three mutators are
// `execution.kill` / `execution.cancel` / `execution.promote`.
// ────────────────────────────────────────────────────────────────

/** `execution.active` — the live active-list snapshot. Session-scoped: when
 *  `session_id` is supplied the server returns the attended entries for that
 *  session plus the always-visible unattended entries; omitted → the full
 *  owner view. */
export interface ExecutionActiveRequest {
  session_id?: string;
}

export interface ExecutionActiveResponse {
  entries: ActiveExecutionEntry[];
  lanes: LaneStatus[];
  /** Pending chat calls, including interrupted calls from a previous process.
   * Optional for compatibility with servers predating durable chat calls. */
  tool_calls?: import('./chat-tool-call.js').ChatToolCallRecord[];
}

/** `execution.kill` — SIGKILL / abandon a *running* op; the run terminates in
 *  the `killed` state. Idempotent: a run that already reached a terminal state
 *  returns `already_terminal`. */
export interface ExecutionKillRequest {
  run_id: string;
}
export type ExecutionKillStatus = 'killed' | 'already_terminal' | 'not_found';
export interface ExecutionKillResponse {
  status: ExecutionKillStatus;
}

/** `execution.cancel` — drop a *queued* call before it dispatches. Resolves the
 *  call's anchor as `cancelled_before_dispatch` (the single queue record, §7d);
 *  a call that already won a slot returns `already_dispatched` (use `kill`). */
export interface ExecutionCancelRequest {
  queued_call_id: string;
}
export type ExecutionCancelStatus =
  | 'cancelled_before_dispatch'
  | 'already_dispatched'
  | 'not_found';
export interface ExecutionCancelResponse {
  status: ExecutionCancelStatus;
}

/** `execution.promote` — move a queued call to the head of its lane queue
 *  (ahead of a long-running blocker). No run-level trail; touches only the
 *  in-memory queue. */
export interface ExecutionPromoteRequest {
  queued_call_id: string;
}
export type ExecutionPromoteStatus = 'promoted' | 'not_found';
export interface ExecutionPromoteResponse {
  status: ExecutionPromoteStatus;
}
