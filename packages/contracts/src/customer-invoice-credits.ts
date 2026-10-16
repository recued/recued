import { customerRefundBalanceLines,type CustomerRefundBalance } from './customer-refunds.js';
export const CUSTOMER_INVOICE_CREDIT_RECIPE = 'reception-customer-invoice-credit';
export interface CustomerInvoiceCreditReversal {
  correction_id: string;reason: string;reversed_on: string;replacement_credit_id?: string;
}
export interface CustomerInvoiceCreditEntry {
  credit_id: string;credit_ref: string;amount: string;issued_on: string;reason: string;
  replaces_credit_id?: string;reversal?: CustomerInvoiceCreditReversal;
}
export interface CustomerInvoiceCreditPrepareInput {
  request_key: string;signoff_id: string;expected_snapshot_hash: string;amount: string;issued_on: string;reason: string;
}
export interface CustomerInvoiceCreditBalance {
  amount_paid: string;amount_credited: string;outstanding: string;status: 'open' | 'credited';
}
export interface CustomerInvoiceCreditRecord extends CustomerInvoiceCreditEntry {
  signoff_id: string;invoice_id: string;invoice_ref: string;currency: string;
  before_balance: CustomerInvoiceCreditBalance;after_balance: CustomerInvoiceCreditBalance;
  prepared_at: number;prepared_by: string;applied_at: number | null;run_id?: string;actor?: string;
}
export interface CustomerInvoiceCreditApplyInput { credit_id: string;expected_plan_hash: string;summary: string }
export interface CustomerInvoiceCreditPreview { credit: CustomerInvoiceCreditRecord;review: CustomerInvoiceCreditApplyInput }
export interface CustomerInvoiceCreditApplyResult { credit_id: string;signoff_id: string;invoice_id: string;already_applied: boolean }
export interface CustomerInvoiceCreditHistoryInput { signoff_id: string;limit?: number;cursor?: string }
export interface CustomerInvoiceCreditHistory { credits: CustomerInvoiceCreditRecord[];next_cursor?: string }
export interface CustomerInvoiceCreditCopyInput { signoff_id: string;credit_id: string }
export interface CustomerInvoiceCreditCopy extends Partial<CustomerRefundBalance> {
  format: 'recued.customer-invoice-credit';version: 1 | 2 | 3;captured_at: number;copy_hash: string;
  signoff_id: string;invoice_id: string;invoice_ref: string;business_name: string;customer: string;currency: string;
  credit: CustomerInvoiceCreditEntry;invoice_total: string;amount_paid: string;amount_credited: string;outstanding: string;
}
export const customerInvoiceCreditLines = (copy: CustomerInvoiceCreditCopy): string[] => [
  `${copy.business_name} · ${copy.customer}`,
  `Invoice ${copy.invoice_ref} · Credit ${copy.credit.credit_ref}`,
  ...(copy.credit.reversal ? [`Status: Reversed on ${copy.credit.reversal.reversed_on}`,`Reversal reason: ${copy.credit.reversal.reason}`,
    ...(copy.credit.reversal.replacement_credit_id ? [`Replacement credit: CR-${copy.credit.reversal.replacement_credit_id}`] : [])] : ['Status: Issued']),
  ...(copy.credit.replaces_credit_id ? [`Replaces credit: CR-${copy.credit.replaces_credit_id}`] : []),
  `Credit issued: ${copy.credit.issued_on}`,
  `Credit amount: ${copy.credit.amount} ${copy.currency}`,
  `Reason: ${copy.credit.reason}`,
  `Original invoice total: ${copy.invoice_total} ${copy.currency}`,
  `Recorded paid: ${copy.amount_paid} ${copy.currency}`,
  `Total credited: ${copy.amount_credited} ${copy.currency}`,
  ...customerRefundBalanceLines(copy,copy.currency),
  `Recorded outstanding: ${copy.outstanding} ${copy.currency}`,
  `Balance snapshot captured ${new Date(copy.captured_at).toISOString()}.`,
  copy.credit.reversal ? 'This credit was reversed. Its original amount no longer reduces the recorded balance.'
    : 'This credit reduces the recorded invoice balance. It records no payment or refund.',
];
