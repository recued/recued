import type { QuoteSignoffReminder,QuoteSignoffReminderSetInput,QuoteSignoffReminderListInput,QuoteSignoffReminderDraftResult } from './quote-signoff-reminders.js';
import type { QuoteSignoffSummary,QuoteSignoffFollowUp } from './quote-signoff.js';

export const PAYMENT_REMINDER_REFERENCE_PREFIX = 'qpr_';
export interface QuotePaymentReminder extends Omit<QuoteSignoffReminder,'has_saved_link'> {
  /** The invoice changed after preparing this occurrence. Save again for a fresh draft. */
  draft_stale: boolean;
  /** Linked account follow-up owns this invoice until paused or its uncertain send is resolved. */
  account_follow_up?: boolean;
}
export interface QuotePaymentReminderGetInput { signoff_id: string }
export interface QuotePaymentReminderSetInput extends Omit<QuoteSignoffReminderSetInput,'share_url'> {}
export type QuotePaymentReminderListInput = QuoteSignoffReminderListInput;
export interface QuotePaymentReminderTarget extends Pick<QuoteSignoffSummary,
  'signoff_id' | 'invoice_id' | 'customer' | 'quote_label' | 'quote_reference' | 'invoice_ref' | 'currency' | 'amount'> {
  invoice: QuoteSignoffFollowUp['invoice'];
}
export interface QuotePaymentReminderListResult {
  reminders: Array<{ invoice: QuotePaymentReminderTarget;reminder: QuotePaymentReminder }>;next_cursor?: string;
}
export interface QuotePaymentReminderDraftInput { signoff_id: string;expected_revision: number }
export type QuotePaymentReminderDraftResult = QuoteSignoffReminderDraftResult;
