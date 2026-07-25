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
