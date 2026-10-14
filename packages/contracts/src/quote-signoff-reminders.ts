import type { MailDraftContent } from './mail-drafts.js';
import type { QuoteSignoffSummary } from './quote-signoff.js';

/** Reserved for reminders that carry the trusted live offer send guard. */
export const SIGNOFF_REMINDER_REFERENCE_PREFIX = 'qsr_';

/** Owner follow-up dates are separate from the immutable customer agreement. */
export interface QuoteSignoffReminder {
  signoff_id: string;
  revision: number;
  due_at: number | null;
  status: 'unscheduled' | 'scheduled' | 'due' | 'paused' | 'stopped';
  has_saved_link: boolean;
  sender_mail_instance?: string;
  recipient_email?: string;
  notified_at: number | null;
  drafted_at: number | null;
  delivery: 'not_prepared' | 'draft_ready' | 'sent' | 'uncertain' | 'not_sent';
}
export interface QuoteSignoffReminderGetInput { signoff_id: string }
export interface QuoteSignoffReminderSetInput {
  signoff_id: string;
  expected_revision: number;
  /** null pauses follow-up. A past date means it is due now. */
  due_at: number | null;
  /** Both can be omitted for an owner-only reminder. */
  sender_mail_instance?: string;
  recipient_email?: string;
  /** For existing offers whose one-time link was not saved by this feature. */
  share_url?: string;
}
export interface QuoteSignoffReminderListInput { limit?: number; cursor?: string }
export interface QuoteSignoffReminderListResult {
  reminders: Array<{ signoff: QuoteSignoffSummary; reminder: QuoteSignoffReminder }>;
  next_cursor?: string;
}
export interface QuoteSignoffReminderDraftInput { signoff_id: string; expected_revision: number }
export interface QuoteSignoffReminderDraftResult {
  /** Save with mail.drafts.create, then review in the ordinary mail composer. */
  idempotency_key: string;
  content: MailDraftContent;
}
