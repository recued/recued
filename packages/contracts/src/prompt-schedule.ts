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
  /** Stable server identity used only to scope a client's unanswered run requests. */
  run_request_scope?: string;
  /** A current clock-driven admission failure. Cleared by a successful admission or timing/control change. */
  scheduling_issue?: { code: 'queue_unconfirmed'; since_at: number } | null;
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
}

export interface PromptScheduleUpdate {
  schedule_id: string;
  expected_revision: number;
  title?: string;
  prompt?: string;
  time_zone?: string;
  run_at?: string;
  cron_expression?: string;
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
}
