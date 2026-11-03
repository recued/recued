import type { MailForwardContext, MailReplyContext } from './types.js';

export interface MailConversationScope { thread_id: string | null; incarnation: string }
export interface MailMessageRef {
  slug: string;
  record_id: string;
  /** Constrains a conversation selection to its original mailbox and thread. */
  conversation?: MailConversationScope;
}
export interface MailMessageAttachmentsRequest extends MailMessageRef {
  expected_incarnation?: string;
}
export interface MailMessageAttachment {
  file_id: string;
  filename: string;
  mime_type: string;
  size: number | null;
  content_hash?: string;
  selection_revision?: string;
  unavailable_reason?: string;
}
/** Retained links only; no remote attachment fetch or mailbox write. */
export interface MailMessageAttachmentsSnapshot extends MailMessageRef {
  incarnation: string;
  items: MailMessageAttachment[];
  warnings: string[];
  truncated: boolean;
}
export interface MailConversationCursor { received_at: number; record_id: string }
export interface MailConversationRequest extends MailMessageRef {
  before?: MailConversationCursor;
  expected_incarnation?: string;
  expected_thread_id?: string | null;
}
export interface MailConversationItem {
  record_id: string;
  source_id: string;
  modified_at: number;
  size_bytes: number;
  to: string[];
  from: string;
  subject: string;
  received_at: number;
  direction: 'inbound' | 'outbound' | 'unknown';
  folder: string;
  is_read: boolean;
  is_flagged?: boolean;
  has_attachments: boolean;
  snippet: string;
}
/** A page of retained metadata, never a claim of complete remote history. */
export interface MailConversationSnapshot {
  slug: string;
  anchor: MailConversationItem;
  thread_id: string | null;
  incarnation: string | null;
  mailbox_address: string;
  messages: MailConversationItem[];
  next_before?: MailConversationCursor;
}
/** A bounded, plain-text owner read. No provider state is changed. */
export interface MailMessageSnapshot extends MailMessageRef {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  received_at: number;
  body: string | null;
  body_truncated: boolean;
  read: 'provider' | 'stored';
  reply: MailReplyContext | null;
  reply_unavailable_reason?: string;
  /** Absent on older servers; forwarding requires a fresh complete original. */
  forward?: MailForwardContext | null;
  forward_unavailable_reason?: string;
  /** Absent on older servers. Sending access is independent of these actions. */
  state?: MailMessageState;
}

export interface MailMessageState {
  /** Binds an action to this message in this enrollment of the mailbox. */
  identity: string | null;
  is_read: boolean;
  is_flagged: boolean;
  verified: boolean;
  can_mark: boolean;
  can_flag: boolean;
  unavailable_reason?: string;
}
export interface MailMessageStateChange extends MailMessageRef {
  expected_identity: string;
  change: { kind: 'read' | 'star'; value: boolean };
}
export interface MailMessageStateResult extends MailMessageRef {
  state: MailMessageState;
  record: import('../collections.js').CollectionRecord;
}
