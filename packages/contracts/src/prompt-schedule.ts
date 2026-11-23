/** Read-only outcome of the latest occurrence, including work held after its chat turn ended. */
export interface PromptScheduleRunOutcome {
  status: 'queued' | 'running' | 'cancelling' | 'finished' | 'needs_approval'
    | 'failed' | 'interrupted' | 'cancelled' | 'withdrawn' | 'needs_attention';
  reason?: 'turn_failed' | 'tool_failed' | 'outcome_unknown' | 'action_held'
    | 'awaiting_execution' | 'approval_expired' | 'approval_declined';
  message_id?: string;
  plan_id?: string;
}

/** A scheduled request owns one conversation; each occurrence is a new turn. */
export interface PromptSchedule {
  schedule_id: string;
  session_id: string;
  title: string;
  prompt: string;
  mode: 'one_shot' | 'recurring';
  time_zone: string;
  run_at?: number;
  cron_expression?: string;
  enabled: boolean;
  revision: number;
  created_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_turn_id: string | null;
  last_status: import('./chat-turn-queue.js').ChatQueuedTurnStatus | null;
  /** Absent on older servers. Computed from existing queue, action and tool-call records. */
  last_outcome?: PromptScheduleRunOutcome | null;
  /** Unanswered actions across all occurrences, so a later run cannot hide an earlier ask. */
  pending_approvals?: { count: number; plan_id: string; message_id?: string } | null;
  /** Unfinished action from any occurrence, including one older than the latest response. */
  pending_work?: PromptScheduleRunOutcome | null;
  /** Absent on servers without Run now. Availability is checked again at admission. */
  run_now_available?: boolean;
  /** D-338 slice 2 — a finished run sends its answer to the owner's notification channels. A
   *  server since D-338 always names it; one before names nothing, and refuses it in a save. */
  notify_on_done?: boolean;
  /** D-338 slice 3 — the feature that owns this schedule. A managed schedule is left out of every
   *  list and refuses edits from the scheduled-prompt screens and chat's schedule tools; its owner
   *  (the Agenda card) keeps it in step. */
  managed_by?: 'agenda';
  /** D-344 slice D — the model its runs use, as the chat's picker offers it; `null` is the chat's
   *  default. A server since D-344 always names it; one before names nothing, and refuses it in a save. */
  model_source_id?: import('./chat.js').ChatModelSourceId | null;
  /** Stable server identity used only to scope a client's unanswered run requests. */
  run_request_scope?: string;
  /** A current clock-driven admission failure. Cleared by a successful admission or timing/control change. */
  scheduling_issue?: { code: 'queue_unconfirmed'; since_at: number } | null;
  /** Absent on older servers. A separate clock revision keeps skips from invalidating queued work. */
  skip_state?: PromptScheduleSkipState;
  /** Absent on older servers; history is read only and scoped to this prompt. */
  run_history_available?: true;
  /** Supports reviewed, per-prompt bulk controls with durable results. */
  bulk_control_available?: true;
  /** Absent on older servers or non-recurring prompts; null means no timed pause. */
  timed_pause?: { until_at: number; first_run_at: number } | null;
}

export const PROMPT_SCHEDULE_BULK_MAX = 200;
export type PromptScheduleBulkAction = { kind: 'pause' | 'resume' } | { kind: 'pause_until'; local_time: string };
export interface PromptScheduleBulkPreviewRequest { schedule_ids: string[]; action: PromptScheduleBulkAction }
export interface PromptScheduleBulkReviewItem {
  schedule_id: string;
  schedule?: PromptSchedule;
  status: 'ready' | 'unchanged' | 'unavailable';
  message: string;
  review_token?: string;
  until_at?: number;
  first_run_at?: number;
  queued_runs?: number;
}
export interface PromptScheduleBulkPreview { action: PromptScheduleBulkAction; items: PromptScheduleBulkReviewItem[] }
export interface PromptScheduleBulkApplyRequest {
  request_id: string;
  action: PromptScheduleBulkAction;
  items: { schedule_id: string; review_token: string }[];
}
export interface PromptScheduleBulkOutcome {
  schedule_id: string;
  status: 'applied' | 'failed' | 'needs_review';
  message: string;
  replayed?: true;
}
export interface PromptScheduleBulkResult { items: PromptScheduleBulkOutcome[] }

export interface PromptSchedulePauseRequest { schedule_id: string; expected_revision: number; until_at: number }
export interface PromptSchedulePausePreview extends PromptSchedulePauseRequest { first_run_at: number; time_zone: string }
export interface PromptSchedulePauseResult {
  schedule: PromptSchedule;
  expected_revision: number;
  applied_revision: number;
  disposition: 'applied' | 'replayed';
}

export interface PromptScheduleRun {
  occurrence_id: string;
  turn_id: string | null;
  revision: number;
  trigger: 'scheduled' | 'manual';
  due_at: number;
  queued_at: number | null;
  /** The saved timezone for this occurrence, including runs before a schedule edit. */
  time_zone: string;
  outcome: PromptScheduleRunOutcome;
}
export interface PromptScheduleRunsRequest { schedule_id: string; cursor?: string }
export interface PromptScheduleRunsPage {
  schedule_id: string;
  session_id: string;
  /** Newest recorded occurrences first; at most ten per page. */
  runs: PromptScheduleRun[];
  next_cursor: string | null;
}

export interface PromptScheduleSkipState {
  revision: number;
  next?: { run_at: number };
  skipped?: { skip_id: string; run_at: number; following_run_at: number; undo_available: boolean };
}
export interface PromptScheduleSkipRequest {
  schedule_id: string;
  expected_revision: number;
  expected_skip_revision: number;
  run_at: number;
}
export interface PromptScheduleUndoSkipRequest {
  schedule_id: string;
  expected_revision: number;
  expected_skip_revision: number;
  skip_id: string;
}
export interface PromptScheduleSkipPreview extends PromptScheduleSkipRequest {
  following_run_at: number;
  time_zone: string;
}
export interface PromptScheduleSkipResult {
  schedule: PromptSchedule;
  action: 'skip_next' | 'undo_skip';
  expected_skip_revision: number;
  skip_revision: number;
  disposition: 'applied' | 'replayed';
}

export interface PromptScheduleTiming {
  mode: 'one_shot' | 'recurring';
  time_zone: string;
  /** An absolute ISO date-time with offset, for a one-off request. */
  run_at?: string;
  cron_expression?: string;
}

export interface PromptScheduleInput extends PromptScheduleTiming {
  title: string;
  prompt: string;
  /** D-338 slice 2 — send only to a server whose schedules name it (a preview says so too). */
  notify_on_done?: boolean;
  /** D-344 slice D — the model its runs use; `null` or absent, the chat's default. Send only to a
   *  server whose schedules name it (a preview says so too). */
  model_source_id?: import('./chat.js').ChatModelSourceId | null;
}

/** Read-only times calculated with the server clock and the save-time rules. */
export interface PromptSchedulePreview {
  mode: PromptScheduleTiming['mode'];
  time_zone: string;
  calculated_at: number;
  next_runs: number[];
  /** Recurring previews are bounded to one year rather than scanning indefinitely. */
  window_ends_at?: number;
  /** A one-off instant that has already passed; no upcoming run is implied. */
  past_run_at?: number;
  /** D-338 slice 2 — this server can notify when a run is done. Absent on servers before it. */
  notify_on_done_available?: true;
  /** D-344 slice D — this server runs a schedule on the model it names. Absent on servers before it. */
  model_choice_available?: true;
}

export interface PromptScheduleUpdate {
  schedule_id: string;
  expected_revision: number;
  title?: string;
  prompt?: string;
  time_zone?: string;
  run_at?: string;
  cron_expression?: string;
  /** D-338 slice 2 — only to a server whose schedules name it. */
  notify_on_done?: boolean;
  /** D-344 slice D — only to a server whose schedules name it; `null` sets the chat's default. */
  model_source_id?: import('./chat.js').ChatModelSourceId | null;
}

export interface PromptScheduleTarget {
  schedule_id: string;
  expected_revision?: number;
}

export interface PromptScheduleRunRequest extends PromptScheduleTarget {
  expected_revision: number;
  /** Stable across retries of the same click; a new explicit run uses a new ID. */
  submission_id: string;
}

/** Host-authored provenance, never accepted from chat.send or model arguments. */
export interface ScheduledPromptOrigin {
  schedule_id: string;
  occurrence_id: string;
  revision: number;
  due_at: number;
  cron: string;
  /** Absent on older clock-driven occurrences. Authored by the server only. */
  trigger?: 'manual';
  /** D-341 slice B3 — the sha256 of the prompt text this occurrence runs, from its own snapshot:
   *  what a scheduled prompt's standing pre-approval pins, so an edit to the prompt ends it while a
   *  pause or a new time does not. Absent on occurrences queued before it. Authored by the server
   *  only. */
  prompt_sha256?: string;
}
