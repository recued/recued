import type { MailReplyContext } from './types.js';

export interface MailConversationScope { thread_id: string | null; incarnation: string }
export interface MailMessageRef {
  slug: string;
  record_id: string;
  /** Constrains a conversation selection to its original mailbox and thread. */
  conversation?: MailConversationScope;
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
}
