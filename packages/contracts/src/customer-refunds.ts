import type { CustomerPaymentEntry } from './customer-payment-receipts.js';
import type { MailDraftContent } from './mail-drafts.js';

export const CUSTOMER_REFUND_RECIPE = 'reception-customer-refund';
export const CUSTOMER_REFUND_RECEIPT_REFERENCE_PREFIX = 'qrf_';
export const isCustomerRefundReceiptReference = (value: unknown): value is `qrf_${string}` =>
  typeof value === 'string' && value.startsWith(CUSTOMER_REFUND_RECEIPT_REFERENCE_PREFIX);
/** Credits against paid money are a liability, separate from credits against unpaid balances. */
export interface CustomerRefundBalance {
  amount_refund_credited: string;amount_refunded: string;refund_due: string;net_received: string;net_invoice_total: string;
}
export interface CustomerPaidCreditEntry {
  credit_id: string;credit_ref: string;payment_id: string;amount: string;issued_on: string;reason: string;
}
export interface CustomerRefundEntry {
  refund_id: string;refund_ref: string;credit_id: string;payment_id: string;amount: string;returned_on: string;
  reason: string;method?: string;reference?: string;
  replaces_refund_id?: string;
  reversal?: { correction_id: string;reason: string;reversed_on: string;replacement_refund_id?: string };
}
export interface CustomerRefundPrepareInput {
  request_key: string;signoff_id: string;expected_snapshot_hash: string;kind: 'credit' | 'refund';
  payment_id: string;credit_id?: string;amount: string;date: string;reason: string;method?: string;reference?: string;
}
export interface CustomerRefundAction {
  action_id: string;signoff_id: string;invoice_id: string;invoice_ref: string;currency: string;kind: 'credit' | 'refund';
  invoice_total: string;amount_paid: string;amount_credited: string;outstanding: string;
  credit: CustomerPaidCreditEntry;refund: CustomerRefundEntry | null;payment: CustomerPaymentEntry;
  before: CustomerRefundBalance;after: CustomerRefundBalance;prepared_at: number;prepared_by: string;
  applied_at: number | null;run_id?: string;actor?: string;
}
export interface CustomerRefundApplyInput { action_id: string;expected_plan_hash: string;summary: string }
export interface CustomerRefundPreview { action: CustomerRefundAction;review: CustomerRefundApplyInput }
export interface CustomerRefundApplyResult { action_id: string;signoff_id: string;kind: 'credit' | 'refund';already_applied: boolean }
export interface CustomerRefundHistoryInput { signoff_id: string;limit?: number;cursor?: string }
export interface CustomerRefundHistory { actions: CustomerRefundAction[];next_cursor?: string }
export interface CustomerRefundCopyInput { signoff_id: string;action_id: string }
export interface CustomerRefundDocument extends CustomerRefundBalance {
  format: 'recued.customer-refund-document';version: 1 | 2;captured_at: number;document_hash: string;
  action_id: string;signoff_id: string;invoice_id: string;invoice_ref: string;business_name: string;customer: string;currency: string;
  kind: 'credit' | 'refund';credit: CustomerPaidCreditEntry;refund: CustomerRefundEntry | null;payment: CustomerPaymentEntry;
  invoice_total: string;amount_paid: string;amount_credited: string;outstanding: string;
}
export interface CustomerRefundDraftInput extends CustomerRefundCopyInput {
  expected_document_hash: string;sender_mail_instance: string;recipient_email: string;
}
export interface CustomerRefundDraftResult { idempotency_key: string;content: MailDraftContent }
export const customerRefundDocumentTitle = (copy: CustomerRefundDocument): string => copy.kind==='credit' ? 'Paid invoice credit'
  : copy.refund?.reversal ? 'Customer refund correction notice' : copy.refund?.replaces_refund_id ? 'Corrected customer refund receipt' : 'Customer refund receipt';
export const customerRefundBalanceFields = (value: Partial<CustomerRefundBalance>): Partial<CustomerRefundBalance> =>
  value.amount_refund_credited === undefined ? {} : { amount_refund_credited: value.amount_refund_credited,amount_refunded: value.amount_refunded!,refund_due: value.refund_due!,net_received: value.net_received!,net_invoice_total: value.net_invoice_total! };
export const customerRefundBalanceLines = (balance: Partial<CustomerRefundBalance>,currency: string): string[] => balance.amount_refund_credited === undefined ? [] : [
  `Paid invoice credits: ${balance.amount_refund_credited} ${currency}`,
  `Recorded refunds: ${balance.amount_refunded} ${currency}`,
  `Refund still owed: ${balance.refund_due} ${currency}`,
  `Recorded net received: ${balance.net_received} ${currency}`,
  `Invoice after all credits: ${balance.net_invoice_total} ${currency}`,
];
export const customerRefundDocumentLines = (copy: CustomerRefundDocument): string[] => [
  `${copy.business_name} · ${copy.customer}`,`Invoice ${copy.invoice_ref}`,
  `Paid invoice credit ${copy.credit.credit_ref}: ${copy.credit.amount} ${copy.currency} · ${copy.credit.issued_on}`,
  `Credit reason: ${copy.credit.reason}`,
  ...(copy.refund ? [`Recorded refund ${copy.refund.refund_ref}: ${copy.refund.amount} ${copy.currency}`,`Returned on: ${copy.refund.returned_on}`,
    `Refund reason: ${copy.refund.reason}`,...(copy.refund.method ? [`Method: ${copy.refund.method}`] : []),
    ...(copy.refund.reference ? [`Refund reference: ${copy.refund.reference}`] : []),
    ...(copy.refund.replaces_refund_id ? [`Replaces refund record RF-${copy.refund.replaces_refund_id}.`] : []),
    ...(copy.refund.reversal ? [`This refund entry was reversed on ${copy.refund.reversal.reversed_on} and is excluded from recorded refund totals.`,
      `Correction reason: ${copy.refund.reversal.reason}`,...(copy.refund.reversal.replacement_refund_id ? [`Replacement refund record: RF-${copy.refund.reversal.replacement_refund_id}.`] : ['No replacement refund was recorded.'])] : [])] : ['This credit records an amount owed back to the customer.']),
  `Original recorded payment: ${copy.payment.amount} ${copy.currency} · ${copy.payment.received_on}`,
  ...(copy.payment.reference ? [`Payment reference: ${copy.payment.reference}`] : []),
  `Original invoice total: ${copy.invoice_total} ${copy.currency}`,`Recorded payments: ${copy.amount_paid} ${copy.currency}`,
  `Unpaid invoice credits: ${copy.amount_credited} ${copy.currency}`,...customerRefundBalanceLines(copy,copy.currency),
  `Customer still owes: ${copy.outstanding} ${copy.currency}`,`Snapshot captured ${new Date(copy.captured_at).toISOString()}.`,
  copy.refund?.reversal ? 'This notice corrects a saved refund entry. It does not move money.'
    : copy.refund ? 'This receipt reflects the business’s recorded refund completed outside Recued.' : 'A credit is separate from money returned. Refunds have their own receipts.',
].map(line => line.replace(/\r\n?/g,'\n'));
