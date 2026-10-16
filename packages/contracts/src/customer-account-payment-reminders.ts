import type { QuoteSignoffReminder,QuoteSignoffReminderListInput,QuoteSignoffReminderDraftResult } from './quote-signoff-reminders.js';
import type { CustomerAccountStatement } from './customer-account-statements.js';

export const CUSTOMER_ACCOUNT_PAYMENT_REMINDER_REFERENCE_PREFIX = 'qapr_';
export const isCustomerAccountPaymentReminderReference = (value: unknown): value is `qapr_${string}` =>
  typeof value === 'string' && value.startsWith(CUSTOMER_ACCOUNT_PAYMENT_REMINDER_REFERENCE_PREFIX);
export interface CustomerAccountPaymentReminder extends Omit<QuoteSignoffReminder,'signoff_id' | 'has_saved_link'> {
  account_id: string;draft_stale: boolean;
}
export interface CustomerAccountPaymentReminderInput { account_id: string }
export interface CustomerAccountPaymentReminderSetInput extends CustomerAccountPaymentReminderInput {
  expected_revision: number;due_at: number | null;sender_mail_instance?: string;recipient_email?: string;
}
export interface CustomerAccountPaymentReminderDraftInput extends CustomerAccountPaymentReminderInput { expected_revision: number }
export type CustomerAccountPaymentReminderDraftResult = QuoteSignoffReminderDraftResult;
export type CustomerAccountPaymentReminderListInput = QuoteSignoffReminderListInput;
export interface CustomerAccountPaymentReminderTarget {
  account_id: string;customer: string;job_count: number;
  balances: Array<{ currency: string;outstanding: string }>;
}
export interface CustomerAccountPaymentReminderListResult {
  reminders: Array<{ account: CustomerAccountPaymentReminderTarget;reminder: CustomerAccountPaymentReminder }>;next_cursor?: string;
}
/** Keep every unpaid invoice and each currency separate, without private work or payment notes. */
export const customerAccountPaymentReminderLines = (copy: CustomerAccountStatement): string[] => [
  `${copy.business_name} · ${copy.customer}`,
  `Customer account ${copy.account_id} · ${copy.jobs.length} linked jobs`,
  ...copy.balances.filter(balance => balance.outstanding !== '0.0000')
    .map(balance => `Recorded outstanding: ${balance.outstanding} ${balance.currency}`),
  ...copy.jobs.flatMap(job => job.invoices.filter(invoice => invoice.outstanding !== '0.0000')
    .map(invoice => `Invoice ${invoice.invoice_ref} · Job ${job.job_id}: ${invoice.outstanding} ${job.currency} recorded outstanding; due ${invoice.due_on}.`)),
  'These amounts reflect the business’s records. If you have already paid, please let us know so we can check them.',
];
