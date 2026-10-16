import { isCustomerAccountPaymentReminderReference } from './customer-account-payment-reminders.js';
import { isCustomerRefundReceiptReference,type CustomerPaidCreditEntry,type CustomerRefundEntry,type CustomerRefundBalance,customerRefundBalanceLines } from './customer-refunds.js';
import type { CustomerInvoiceCreditEntry } from './customer-invoice-credits.js';
import type { MailDraftContent } from './mail-drafts.js';
import type { QuoteSignoffFollowUp } from './quote-signoff.js';
import { isCustomerAccountPaymentReference } from './customer-account-payments.js';
import { isCustomerAccountStatementReference } from './customer-account-statements.js';
import { isCustomerJobPaymentStatementReference } from './customer-job-payment-statements.js';
import { isCustomerReminderReference } from './quote-completion-reminders.js';

export const CUSTOMER_PAYMENT_RECEIPT_REFERENCE_PREFIX = 'qpe_';
export const isCustomerPaymentReceiptReference = (value: unknown): value is `qpe_${string}` =>
  typeof value === 'string' && value.startsWith(CUSTOMER_PAYMENT_RECEIPT_REFERENCE_PREFIX);
/** Every customer reminder or payment copy needs the trusted final send guard. */
export const isGuardedCustomerMailReference = (value: unknown): value is string =>
  isCustomerAccountPaymentReminderReference(value) || isCustomerAccountPaymentReference(value) || isCustomerRefundReceiptReference(value) || isCustomerReminderReference(value) || isCustomerPaymentReceiptReference(value) || isCustomerJobPaymentStatementReference(value) || isCustomerAccountStatementReference(value);

export interface CustomerPaymentEntry {
  payment_id: string;
  amount: string;
  received_on: string;
  method?: string;
  reference?: string;
}
export interface CustomerPaymentHistoryInput { signoff_id: string;limit?: number;cursor?: string }
export interface CustomerPaymentHistory {
  signoff_id: string;invoice_id: string;invoice_ref: string;
  business_name: string;customer: string;quote_label: string;quote_reference?: string;
  currency: string;total: string;captured_at: number;
  invoice: QuoteSignoffFollowUp['invoice'];
  consistency: 'matched' | 'mismatch' | 'unavailable';
  issue?: string;
  payments: CustomerPaymentEntry[];
  credit_notes?: CustomerInvoiceCreditEntry[];paid_credits?: CustomerPaidCreditEntry[];refunds?: CustomerRefundEntry[];
  snapshot_hash: string | null;
  next_cursor?: string;
}
export interface CustomerPaymentReceiptInput { signoff_id: string;payment_id: string;expected_snapshot_hash: string }
/** A customer copy acknowledges owner-recorded money, with balance as of capture. */
export interface CustomerPaymentReceipt extends Partial<CustomerRefundBalance> {
  format: 'recued.customer-payment-receipt';version: 1 | 2;captured_at: number;receipt_hash: string;
  signoff_id: string;invoice_id: string;invoice_ref: string;
  business_name: string;customer: string;quote_label: string;quote_reference?: string;
  currency: string;total: string;payment: CustomerPaymentEntry;
  amount_paid: string;amount_credited?: string;outstanding: string;due_on: string;
}
export interface CustomerPaymentReceiptDraftInput {
  signoff_id: string;payment_id: string;expected_receipt_hash: string;
  sender_mail_instance: string;recipient_email: string;
}
export interface CustomerPaymentReceiptDraftResult { idempotency_key: string;content: MailDraftContent }

/** The same customer copy is used by the offline document and reviewed email. */
export const customerPaymentReceiptLines = (receipt: CustomerPaymentReceipt): string[] => [
  `${receipt.business_name} · ${receipt.customer}`,
  `Invoice ${receipt.invoice_ref}${receipt.quote_reference ? ` · Quote ${receipt.quote_reference}` : ''}`,
  `Recorded payment: ${receipt.payment.amount} ${receipt.currency}`,
  `Received on: ${receipt.payment.received_on}`,
  ...(receipt.payment.method ? [`Method: ${receipt.payment.method}`] : []),
  ...(receipt.payment.reference ? [`Payment reference: ${receipt.payment.reference}`] : []),
  `Invoice total: ${receipt.total} ${receipt.currency}`,
  `Recorded paid: ${receipt.amount_paid} ${receipt.currency}`,
  ...(receipt.amount_credited ? [`Recorded credits: ${receipt.amount_credited} ${receipt.currency}`] : []),
  `Recorded outstanding: ${receipt.outstanding} ${receipt.currency}`,
  ...customerRefundBalanceLines(receipt,receipt.currency),
  `Invoice due: ${receipt.due_on}`,
  `Snapshot captured ${new Date(receipt.captured_at).toISOString()}.`,
  'This receipt reflects the business’s recorded payment.',
];
