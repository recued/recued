import { customerRefundBalanceLines,type CustomerRefundBalance } from './customer-refunds.js';
import type { CustomerPaymentEntry } from './customer-payment-receipts.js';
import type { MailDraftContent } from './mail-drafts.js';

export const CUSTOMER_ACCOUNT_PAYMENT_RECIPE = 'reception-customer-account-payment';
export const CUSTOMER_ACCOUNT_PAYMENT_MAX_ALLOCATIONS = 100;
export const CUSTOMER_ACCOUNT_PAYMENT_REFERENCE_PREFIX = 'qap_';
export const isCustomerAccountPaymentReference = (value: unknown): value is `qap_${string}` =>
  typeof value === 'string' && value.startsWith(CUSTOMER_ACCOUNT_PAYMENT_REFERENCE_PREFIX);
export interface CustomerAccountPaymentPrepareInput {
  request_key: string;account_id: string;expected_statement_hash: string;currency: string;
  amount: string;received_on: string;method?: string;reference?: string;
  allocations: Array<{ signoff_id: string;amount: string }>;
}
export interface CustomerAccountPaymentAllocation {
  job_id: string;signoff_id: string;invoice_id: string;invoice_ref: string;payment_id: string;
  amount: string;before_paid: string;after_paid: string;before_outstanding: string;after_outstanding: string;
}
export interface CustomerAccountPaymentRecord {
  account_payment_id: string;account_id: string;customer: string;business_name: string;currency: string;
  amount: string;received_on: string;method?: string;reference?: string;
  allocations: CustomerAccountPaymentAllocation[];prepared_at: number;prepared_by: string;
  applied_at: number | null;run_id?: string;actor?: string;
}
export interface CustomerAccountPaymentApplyInput { account_payment_id: string;expected_plan_hash: string;summary: string }
export interface CustomerAccountPaymentPreview { payment: CustomerAccountPaymentRecord;review: CustomerAccountPaymentApplyInput }
export interface CustomerAccountPaymentApplyResult { account_payment_id: string;account_id: string;already_applied: boolean }
export interface CustomerAccountPaymentHistoryInput { account_id: string;limit?: number;cursor?: string }
export interface CustomerAccountPaymentHistory { payments: CustomerAccountPaymentRecord[];next_cursor?: string }
export interface CustomerAccountPaymentReceiptInput { account_payment_id: string }
export interface CustomerAccountPaymentReceiptAllocation extends CustomerAccountPaymentAllocation,Partial<CustomerRefundBalance> {
  state: 'unchanged' | 'changed' | 'removed';current_payment: CustomerPaymentEntry | null;
  current_paid: string;current_outstanding: string;amount_credited?: string;
}
export interface CustomerAccountPaymentReceipt {
  format: 'recued.customer-account-payment-receipt';version: 1;statement_hash: string;captured_at: number;
  payment: CustomerAccountPaymentRecord;current_allocated: string;allocations: CustomerAccountPaymentReceiptAllocation[];
}
export interface CustomerAccountPaymentReceiptDraftInput extends CustomerAccountPaymentReceiptInput {
  expected_receipt_hash: string;sender_mail_instance: string;recipient_email: string;
}
export interface CustomerAccountPaymentReceiptDraftResult { idempotency_key: string;content: MailDraftContent }
export const customerAccountPaymentReceiptLines = (copy: CustomerAccountPaymentReceipt): string[] => {
  const p = copy.payment;
  return [
    `${p.business_name} · ${p.customer}`,
    `Account ${p.account_id} · Payment ${p.account_payment_id}`,
    `Originally recorded payment: ${p.amount} ${p.currency}`,
    `Received on: ${p.received_on}`,
    ...(p.method ? [`Method: ${p.method}`] : []),...(p.reference ? [`Payment reference: ${p.reference}`] : []),
    `Current recorded allocations: ${copy.current_allocated} ${p.currency}`,
    ...copy.allocations.flatMap(a => [
      `Invoice ${a.invoice_ref} · Job ${a.job_id} · Payment entry ${a.payment_id}`,
      `Originally allocated: ${a.amount} ${p.currency}`,
      a.state === 'removed' ? 'This payment entry has since been removed from the active ledger.'
        : a.state === 'changed' ? 'This payment entry has changed since the account payment was recorded.' : 'Payment entry unchanged.',
      ...(a.current_payment ? [`Current entry: ${a.current_payment.amount} ${p.currency} · ${a.current_payment.received_on}`,
        ...(a.current_payment.method ? [`Current method: ${a.current_payment.method}`] : []),
        ...(a.current_payment.reference ? [`Current payment reference: ${a.current_payment.reference}`] : [])] : []),
      `Invoice recorded paid: ${a.current_paid} ${p.currency}`,
      ...(a.amount_credited ? [`Invoice credited: ${a.amount_credited} ${p.currency}`] : []),
      `Invoice outstanding: ${a.current_outstanding} ${p.currency}`,
      ...customerRefundBalanceLines(a,p.currency),
    ]),
    `Recorded ${new Date(p.applied_at!).toISOString()}. Snapshot captured ${new Date(copy.captured_at).toISOString()}.`,
    'This receipt reflects the business’s recorded payments and current invoice balances.',
  ];
};
