import type { CustomerPaymentEntry } from './customer-payment-receipts.js';
import type { CustomerPaidCreditEntry,CustomerRefundBalance,CustomerRefundEntry } from './customer-refunds.js';

export const CUSTOMER_REFUND_CORRECTION_RECIPE = 'reception-customer-refund-correction';
export interface CustomerRefundCorrectionPrepareInput {
  request_key: string;signoff_id: string;refund_id: string;expected_snapshot_hash: string;
  action: 'reverse' | 'replace';reason: string;reversed_on: string;
  amount?: string;returned_on?: string;replacement_reason?: string;method?: string;reference?: string;
}
export interface CustomerRefundCorrectionRecord {
  correction_id: string;signoff_id: string;invoice_id: string;invoice_ref: string;currency: string;
  action: 'reverse' | 'replace';reason: string;reversed_on: string;
  before: CustomerRefundEntry;replacement: CustomerRefundEntry | null;
  credit: CustomerPaidCreditEntry;payment: CustomerPaymentEntry;
  invoice_total: string;amount_paid: string;amount_credited: string;outstanding: string;
  before_balance: CustomerRefundBalance;after_balance: CustomerRefundBalance;
  prepared_at: number;prepared_by: string;applied_at: number | null;run_id?: string;actor?: string;
}
export interface CustomerRefundCorrectionApplyInput { correction_id: string;expected_plan_hash: string;summary: string }
export interface CustomerRefundCorrectionPreview { correction: CustomerRefundCorrectionRecord;review: CustomerRefundCorrectionApplyInput }
export interface CustomerRefundCorrectionApplyResult {
  correction_id: string;signoff_id: string;refund_id: string;replacement_refund_id?: string;already_applied: boolean;
}
export interface CustomerRefundCorrectionHistoryInput { signoff_id: string;limit?: number;cursor?: string }
export interface CustomerRefundCorrectionHistory { corrections: CustomerRefundCorrectionRecord[];next_cursor?: string }
