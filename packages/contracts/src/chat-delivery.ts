/** Paired-owner delivery status; payloads remain in encrypted Chat storage. */
export type ChatDeliveryState = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'skipped';
/** Receive health is independent of the outbound journal. A configured
 * webhook is not proof that the provider can currently reach this server. */
export type ChatMessengerReceiveState = 'active' | 'connecting' | 'retrying' | 'error'
  | 'stopped' | 'locked' | 'invalid' | 'webhook' | 'paused' | 'unknown'
  | 'checking' | 'unavailable' | 'connection_changed' | 'not_connected' | 'unlinked';
export interface ChatMessengerSessionStatus {
  vendor: string;
  recipient: string;
  linked: boolean;
  receive: ChatMessengerReceiveState;
  /** Null for older conversations without a delivery journal. Counts cover
   * the entire journal, including failures outside the recent detail window. */
  delivery: {
    pending_count: number;
    sending_count: number;
    failed_count: number;
    unknown_count: number;
    skipped_count: number;
  } | null;
}
export interface ChatDeliverySnapshot {
  generation: string;
  revision: number;
  pending_count: number;
  skipped_count: number;
  binding: { vendor: string; recipient: string; account: string; thread_id?: string } | null;
  deliveries: ChatDeliveryItem[];
  /** Additive capability marker. Older servers return the original summary. */
  details_available?: boolean;
  next_cursor?: string;
  available?: { vendor: string; recipient: string; linked_session_id?: string };
}

export interface ChatDeliveryListRequest {
  session_id: string;
  /** Omit for the existing unresolved + recent delivery overview. */
  view?: 'history' | 'messages';
  details?: boolean;
  /** History cursors are transient and scoped to this conversation binding. */
  cursor?: string;
  limit?: number;
  /** Bounded lookup for the messages actually rendered in the conversation. */
  message_ids?: string[];
}

export interface ChatDeliveryItem {
  delivery_id: string;
  message_id: string;
  state: ChatDeliveryState;
  sent_chunks: number;
  total_chunks: number;
  error?: string;
  details?: {
    message: { role: 'user' | 'assistant'; snippet: string; ts: number } | null;
    plan: 'unprepared' | 'prepared' | 'native' | 'legacy';
    text: { sent_parts: number; total_parts: number } | null;
    uncertain_parts?: number;
    attachments: Array<{
      file_id: string;
      filename?: string;
      state: ChatDeliveryState | 'not_mirrored';
      skipped?: boolean;
      error?: string;
    }>;
    /** Metadata could not be read; delivery receipts are still authoritative. */
    unavailable?: boolean;
  };
}
