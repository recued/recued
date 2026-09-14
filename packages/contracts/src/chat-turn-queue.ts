/** D-265: durable execution state; delivery has its own progress. */
export type ChatQueuedTurnStatus =
  | 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'withdrawn';

export interface ChatQueuedTurn {
  turn_id: string;
  session_id: string;
  position: number;
  status: ChatQueuedTurnStatus;
  message: string;
  created_at: number;
  duplicate_count: number;
  failure_reason?: 'attachment_deleted';
  /** A restorable composer message. Absent on older servers and structured/native turns. */
  withdraw_to_edit_available?: boolean;
}

/** Returned only after the original is durably withdrawn from execution.
 * Resending uses ordinary chat.send with a fresh submission ID and current settings. */
export interface ChatWithdrawnDraft {
  session_id: string;
  turn_id: string;
  message: string;
  attachments?: import('./chat.js').ChatMessageAttachment[];
  reply_to_message_id?: string;
}

export interface ChatTurnQueueSnapshot {
  generation: string;
  revision: number;
  turns: ChatQueuedTurn[];
}

export interface ChatTurnAcceptance {
  turn_id: string;
  status?: ChatQueuedTurnStatus;
  disposition?: 'accepted' | 'duplicate' | 'replayed';
}
