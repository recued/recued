import { customerRefundBalanceLines,type CustomerRefundBalance,type CustomerPaidCreditEntry,type CustomerRefundEntry } from './customer-refunds.js';
import type { CustomerInvoiceCreditEntry } from './customer-invoice-credits.js';
import type { MailDraftContent } from './mail-drafts.js';
import type { CustomerPaymentEntry } from './customer-payment-receipts.js';

export const CUSTOMER_JOB_PAYMENT_STATEMENT_REFERENCE_PREFIX = 'qjs_';
export const isCustomerJobPaymentStatementReference = (value: unknown): value is `qjs_${string}` =>
  typeof value === 'string' && value.startsWith(CUSTOMER_JOB_PAYMENT_STATEMENT_REFERENCE_PREFIX);

export interface CustomerJobPaymentStatementInput { job_id: string }
export interface CustomerJobPaymentStatementInvoice extends Partial<CustomerRefundBalance> {
  signoff_id: string;invoice_id: string;invoice_ref: string;revision: number;
  issued_on: string;due_on: string;total: string;amount_paid: string;outstanding: string;
  paid_credits?: CustomerPaidCreditEntry[];refunds?: CustomerRefundEntry[];payments: CustomerPaymentEntry[];amount_credited?: string;credits?: CustomerInvoiceCreditEntry[];
}
/** One complete, as-of copy of released invoices and owner-recorded payments. */
export interface CustomerJobPaymentStatement extends Partial<CustomerRefundBalance> {
  format: 'recued.customer-job-payment-statement';version: 1 | 2 | 3 | 4;captured_at: number;statement_hash: string;
  job_id: string;business_name: string;customer: string;quote_label: string;quote_reference?: string;
  currency: string;invoiced_total: string;amount_paid: string;amount_credited?: string;outstanding: string;
  invoices: CustomerJobPaymentStatementInvoice[];
}
export interface CustomerJobPaymentStatementDraftInput {
  job_id: string;expected_statement_hash: string;sender_mail_instance: string;recipient_email: string;
}
export interface CustomerJobPaymentStatementDraftResult { idempotency_key: string;content: MailDraftContent }

/** Offline export and reviewed email use the same customer-visible content. */
export const customerJobPaymentStatementLines = (statement: CustomerJobPaymentStatement): string[] => [
  `${statement.business_name} · ${statement.customer}`,
  `Job: ${statement.quote_label}${statement.quote_reference ? ` · Quote ${statement.quote_reference}` : ''}`,
  `Total invoiced: ${statement.invoiced_total} ${statement.currency}`,
  `Recorded paid: ${statement.amount_paid} ${statement.currency}`,
  ...(statement.amount_credited ? [`Recorded credits: ${statement.amount_credited} ${statement.currency}`] : []),
  ...customerRefundBalanceLines(statement,statement.currency),
  `Recorded outstanding: ${statement.outstanding} ${statement.currency}`,
  ...statement.invoices.flatMap(invoice => [
    '',
    `Invoice ${invoice.invoice_ref} · ${invoice.revision === 0 ? 'Original work' : `Added work ${invoice.revision}`}`,
    `Issued: ${invoice.issued_on} · Due: ${invoice.due_on}`,
    `Invoice total: ${invoice.total} ${statement.currency}`,
    `Recorded paid: ${invoice.amount_paid} ${statement.currency} · Outstanding: ${invoice.outstanding} ${statement.currency}`,
    ...(invoice.credits ?? []).flatMap(credit => [
      `Credit ${credit.credit_ref}: ${credit.amount} ${statement.currency} · ${credit.issued_on} · ${credit.reason}`,
      ...(credit.replaces_credit_id ? [`Replaces credit: CR-${credit.replaces_credit_id}`] : []),
      ...(credit.reversal ? [`Reversed on ${credit.reversal.reversed_on}: ${credit.reversal.reason}`,
        ...(credit.reversal.replacement_credit_id ? [`Replacement credit: CR-${credit.reversal.replacement_credit_id}`] : [])] : []),
    ]),
    ...customerRefundBalanceLines(invoice,statement.currency),
    ...(invoice.paid_credits ?? []).map(credit => `Paid invoice credit ${credit.credit_ref}: ${credit.amount} ${statement.currency} · ${credit.issued_on} · ${credit.reason}`),
    ...(invoice.refunds ?? []).flatMap(refund => [
      `${refund.reversal ? 'Reversed refund entry' : 'Recorded refund'} ${refund.refund_ref}: ${refund.amount} ${statement.currency} · ${refund.returned_on} · ${refund.reason} · Credit PCR-${refund.credit_id}`,
      ...(refund.replaces_refund_id ? [`Replaces refund RF-${refund.replaces_refund_id}.`] : []),
      ...(refund.reversal ? [`Reversed on ${refund.reversal.reversed_on}: ${refund.reversal.reason}. Excluded from recorded refund totals.`,
        ...(refund.reversal.replacement_refund_id ? [`Replacement refund RF-${refund.reversal.replacement_refund_id}.`] : [])] : []),
    ]),
    ...invoice.payments.flatMap(payment => [
      `Recorded payment: ${payment.amount} ${statement.currency} · Received on: ${payment.received_on}`,
      ...(payment.method ? [`Method: ${payment.method}`] : []),
      ...(payment.reference ? [`Payment reference: ${payment.reference}`] : []),
    ]),
    ...(invoice.payments.length === 0 ? ['No payments recorded against this invoice.'] : []),
  ]),
  '',
  `Snapshot captured ${new Date(statement.captured_at).toISOString()}.`,
  'This statement covers released invoices and the business’s recorded payments. Pending offers are excluded.',
].map(line => line.replace(/\r\n?/g,'\n'));
