/** D-174 Runs/Audit pair-RPC contracts.
 *
 *  `execution.list` + `execution.get` are local-UI / paired-client reads
 *  over the audit log. These shapes deliberately project the audit row:
 *  no `config_snapshot`, no checkpoint `step_state`, no arg overrides, and
 *  no raw `ExecutionSource` token ids cross the wire.
 */

import type {
  Actor,
  ActorLabel,
  Channel,
  CommitKind,
  CommitStatus,
  RunAnchorStatus,
  RunDegradation,
} from './commits.js';
import type { HeavyOpErrorCategory } from './execution-control.js';
import type { CliFailureReason } from './cli-failure.js';
import type { PreflightApprovedTarget } from './checkpoint.js';
import type { RecipeError } from './errors.js';
import type { RunMode } from './memory.js';
import type { ProvenanceAttribution } from './provenance-attribution.js';

/** Run-level policy outcome. `blocked` is forward-compatible for the
 *  Tier-2 per-call commit-log read; Tier-1 never emits it because the
 *  D-153 commit-query substrate is not readable by run yet. */
export type PolicyResult =
  | 'allowed'
  | 'approval-requested'
  | 'denied'
  | 'released-after-approval'
  | 'blocked';

/** Cursor fields mirror the audit-export storage cursor: newest-first
 *  ordering by `started_at` DESC with `run_id` as the deterministic
 *  tiebreaker. */
export interface ExecutionListCursor {
  last_started_at: number;
  last_run_id: string;
}

/** Redaction-safe origin projection. The raw `ExecutionSource` can carry
 *  token ids / webhook secret ids / user ids; Runs only needs the
 *  channel x actor lane and the derived attribution descriptor. */
export interface RunOrigin {
  actor: Actor;
  label: ActorLabel;
  channel?: Channel;
  attribution?: ProvenanceAttribution;
}

export interface RunProvenanceLink {
  entity_id: string;
  kind: string;
  ts: number;
}

export interface RunFeedRow {
  run_id: string;
  recipe_id: string;
  /** Display name is best-effort in Tier-1; falls back to recipe_id. */
  name: string;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  origin: RunOrigin;
  status: RunAnchorStatus;
  policy_result: PolicyResult;
  links: RunProvenanceLink[];
  /** D-181 §12 — display category for a failed / killed long-op run
   *  (`killed` / `cancelled_before_dispatch` / `timeout` / `stalled`),
   *  so the feed reads *why* a run ended without opening the detail.
   *  Absent on ordinary failures + non-terminal rows. */
  error_category?: HeavyOpErrorCategory;
  /** D-182 — the reason a `kind: 'cli'` step failed (`not_found` /
   *  `nonzero_exit` / `timeout` / …), derived from the run's first
   *  `cli_failure`-bearing error, so the feed reads "tool not found" without
   *  opening the detail. Set ONLY when the run has no long-op `error_category` —
   *  a kill/stall/timeout WINS the single feed chip (a cli error from a SIGKILLed
   *  subprocess is its consequence, not an independent tool fault). The full
   *  stderr/exit detail always lives on the detail summary's
   *  `errors[].details.cli_failure`. */
  cli_failure_reason?: CliFailureReason;
}

export interface ExecutionListQuery {
  status?: ReadonlyArray<RunAnchorStatus>;
  /** Actor-lane filter, sanitized by the server via the timeline filter. */
  origin?: ReadonlyArray<Actor>;
  recipe_id?: string;
  trigger_source?: string;
  since?: number;
  until?: number;
  limit?: number;
  cursor?: ExecutionListCursor;
}

export interface ExecutionListResponse {
  runs: RunFeedRow[];
  next_cursor?: ExecutionListCursor;
}

export interface ExecutionGetRequest {
  run_id: string;
}

/** D-237 P2 — what a run PRODUCED, as opposed to whether it threw.
 *
 *  ⛔ WHY THIS EXISTS. `status` ranges over `RunAnchorStatus` and means "no
 *  exception was thrown"; `output_string` is length-capped free text. Nothing
 *  else on the run anchor measured output, so **a run that processed 400 items
 *  and a run that processed none were structurally identical in the audit
 *  trail** — which is the substrate-level reason this project has repeatedly
 *  shipped, and only ever caught by a live drive, the same failure: a `foreach`
 *  whose per-item writes were all rejected reporting `success`, a records import
 *  that wrote nothing audited `success`, a cursor stall reprocessing nothing
 *  while reporting `success`. None was findable from the trail, because the
 *  trail had no field in which the difference could appear.
 *  Measured at §10.9 of internal design notes.
 *
 *  🔑 IT COSTS NO NEW WRITES, AND THAT IS THE DESIGN CONSTRAINT, NOT A BONUS.
 *  Every number here is derived from the `StepLog`s the engine ALREADY returns
 *  on `ExecutionResult` and is stamped onto the run-anchor row that is ALREADY
 *  written once per run. No new row, no new table, no extra store read, and
 *  nothing added to the per-item path — the audit log grows by four small
 *  integers per run, not by write frequency.
 *
 *  ⛔ AND IT LETS THE COMMIT LOG SHRINK. Per-call commits already cost one row
 *  per boundary-crossing call (a 400-item `foreach` writes ~400 today, with or
 *  without this). What the anchor lacked was a durable summary of them, so
 *  pruning a run's commits destroyed the only evidence of what it did. With the
 *  yield folded onto the anchor, that evidence survives their eviction — this
 *  field is a precondition for pruning commits harder, not a reason the log
 *  grows.
 *
 *  ⚠ EMITTED EVEN WHEN EVERY COUNT IS ZERO, deliberately breaking the audit
 *  substrate's omit-when-falsy convention. A zero yield is the whole signal;
 *  omitting it would restore exactly the ambiguity this field exists to remove.
 *  Absent therefore means "row written before D-237", never "produced nothing". */
export interface RunYield {
  /** Steps that executed — `skipped === false`. */
  steps_run: number;
  /** Steps a condition skipped. 🔑 The field that separates "correctly had
   *  nothing to do" from "ran and produced nothing", which is the distinction
   *  the whole field exists for. */
  steps_skipped: number;
  /** `foreach` iterations attempted, summed across every step. `0` on a run
   *  with no `foreach` step — not every run has items. */
  items_total: number;
  /** Iterations whose inner step reported an error. ⛔ `items_failed ===
   *  items_total > 0` is the all-refused run that reports `success: true`,
   *  because a `foreach` is continue-on-error by design. */
  items_failed: number;
}

/** D-237 P2 — derive the run yield from the per-step logs.
 *
 *  Pure, and structurally typed rather than importing the engine's `StepLog`,
 *  which would invert this package's dependency direction. */
export const deriveRunYield = (
  steps: ReadonlyArray<{
    skipped?: boolean;
    foreach?: { items: number; failed: number };
  }>,
): RunYield => {
  let steps_run = 0;
  let steps_skipped = 0;
  let items_total = 0;
  let items_failed = 0;
  for (const s of steps) {
    if (s.skipped === true) steps_skipped += 1;
    else steps_run += 1;
    // ⚠ Malformed tallies are SKIPPED, never coerced — a `NaN` total renders a
    // confident, meaningless yield, which is worse than an absent one. Same
    // policy the agent-projection tally already applies.
    const f = s.foreach;
    if (f !== undefined && Number.isFinite(f.items) && Number.isFinite(f.failed)) {
      items_total += f.items;
      items_failed += f.failed;
    }
  }
  return { steps_run, steps_skipped, items_total, items_failed };
};

/** True iff the yield PROVES the run produced nothing — every `foreach` item it
 *  attempted was refused. D-237 P2 named this case in {@link RunYield}'s own
 *  doc and shipped the owner-facing notice for it; this is the predicate that
 *  lets a NON-display reader act on it, so "the run finished" and "the run did
 *  something" stop being the same question.
 *
 *  🔑 IT DOES NOT MEAN "FAILED", AND MUST NOT BE USED TO REWRITE
 *  `commit_status`. A `foreach` is continue-on-error by design, so the anchor
 *  is right that the run completed; what is false is the INFERENCE that a
 *  completed run yielded anything. Readers that care about the outcome ask
 *  this; readers that care about the lifecycle keep reading the status.
 *
 *  ⛔ ABSENT IS NOT ZERO. `undefined` means the row predates D-237, never
 *  "produced nothing" — such a row returns `false` and keeps its historical
 *  reading. Getting this backwards would silently reclassify every pre-D-237
 *  run in the store as a non-event.
 *
 *  ⛔ A MALFORMED TALLY IS NOT A REFUSAL. Non-finite counts, or `items_failed`
 *  above `items_total`, return `false` rather than a confident wrong answer —
 *  the same policy {@link deriveRunYield} applies when it skips a `NaN` tally.
 *
 *  ⚠ Takes `unknown` on purpose: the reactive transforms receive audit rows as
 *  untyped data, and a cast at the call site would be a lie the compiler could
 *  not catch. */
export const runYieldIsTotalRefusal = (runYield: unknown): boolean => {
  if (runYield === null || typeof runYield !== 'object' || Array.isArray(runYield)) return false;
  const { items_total: total, items_failed: failed } =
    runYield as { items_total?: unknown; items_failed?: unknown };
  if (typeof total !== 'number' || typeof failed !== 'number') return false;
  if (!Number.isFinite(total) || !Number.isFinite(failed)) return false;
  if (total <= 0 || failed <= 0 || failed > total) return false;
  return failed === total;
};

export interface RunAuditSummary {
  run_id: string;
  recipe_id: string;
  recipe_hash: string;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  status: RunAnchorStatus;
  origin: RunOrigin;
  trigger_source: string | null;
  instance_id: string | null;
  errors: RecipeError[];
  /** D-181 §12 — display category for a failed / killed long-op run. Same
   *  field as `RunFeedRow.error_category`, carried onto the run detail. */
  error_category?: HeavyOpErrorCategory;
  degraded?: RunDegradation[];
  output_string?: string;
  run_mode?: RunMode;
  process_id?: string;
  recipe_insight_id?: number;
  channel_session_id?: string;
  cognition_session_id?: string;
  correlation_id?: string;
  checkpoint_id?: string;
  ask_id?: string;
  /** D-237 P2 — what the run produced. Absent on rows written before D-237;
   *  present-and-all-zero is a real answer, not a missing one. */
  run_yield?: RunYield;
}

export interface RunApprovalCheckpoint {
  checkpoint_id: string;
  run_id: string;
  recipe_id: string;
  gated_step_id: string;
  created_at: number;
  approved_target?: PreflightApprovedTarget;
}

export type RunApprovalOutcome =
  | 'allow'
  | 'deny'
  | 'edit'
  | 'dismiss'
  | 'dismiss_unseen';

export interface RunApprovalSummary {
  checkpoints: RunApprovalCheckpoint[];
  ask_id?: string;
  checkpoint_id?: string;
  outcome?: RunApprovalOutcome;
  output_string?: string;
}

export type RunGatewayCallDecision = 'allowed' | 'blocked';

export interface RunGatewayCallTraceEntry {
  commit_id: string;
  kind: CommitKind;
  ingredient: string;
  tool: string;
  decision: RunGatewayCallDecision;
  verdict: CommitStatus;
  dispatched_at: number;
  completed_at?: number;
  duration_ms?: number;
  cached?: true;
}

export interface RunGatewaySummary {
  policy_result: PolicyResult;
  per_call_trace: RunGatewayCallTraceEntry[];
}

export interface RunDetail {
  audit: RunAuditSummary;
  approvals: RunApprovalSummary;
  errors: RecipeError[];
  links: RunProvenanceLink[];
  gateway: RunGatewaySummary;
}

export interface ExecutionGetResponse {
  run: RunDetail;
}
