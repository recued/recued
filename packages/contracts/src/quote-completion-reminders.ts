import { SIGNOFF_REMINDER_REFERENCE_PREFIX,type QuoteSignoffReminder,type QuoteSignoffReminderSetInput,
  type QuoteSignoffReminderListInput,type QuoteSignoffReminderDraftResult } from './quote-signoff-reminders.js';
import type { QuoteCompletionSummary } from './quote-completion.js';
import { PAYMENT_REMINDER_REFERENCE_PREFIX } from './quote-payment-reminders.js';

export const COMPLETION_REMINDER_REFERENCE_PREFIX = 'qcr_';
/** Reserved references always require the server's trusted final send guard. */
export const isCustomerReminderReference = (value: unknown): value is string => typeof value === 'string'
  && (value.startsWith(SIGNOFF_REMINDER_REFERENCE_PREFIX) || value.startsWith(COMPLETION_REMINDER_REFERENCE_PREFIX)
    || value.startsWith(PAYMENT_REMINDER_REFERENCE_PREFIX));
export interface QuoteCompletionReminder extends Omit<QuoteSignoffReminder,'signoff_id'> { completion_id: string }
export interface QuoteCompletionReminderGetInput { completion_id: string }
export interface QuoteCompletionReminderSetInput extends Omit<QuoteSignoffReminderSetInput,'signoff_id'> { completion_id: string }
export type QuoteCompletionReminderListInput = QuoteSignoffReminderListInput;
export interface QuoteCompletionReminderListResult {
  reminders: Array<{ completion: QuoteCompletionSummary;reminder: QuoteCompletionReminder }>;next_cursor?: string;
}
export interface QuoteCompletionReminderDraftInput { completion_id: string;expected_revision: number }
export type QuoteCompletionReminderDraftResult = QuoteSignoffReminderDraftResult;
