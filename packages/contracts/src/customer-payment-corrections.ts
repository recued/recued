import type { CustomerPaymentEntry } from './customer-payment-receipts.js';

export const CUSTOMER_PAYMENT_CORRECTION_RECIPE = 'reception-customer-payment-correction';
export type CustomerPaymentCorrectionAction = 'correct' | 'void';
export interface CustomerPaymentCorrectionPrepareInput {
  request_key: string;signoff_id: string;payment_id: string;expected_snapshot_hash: string;
  action: CustomerPaymentCorrectionAction;reason: string;
  amount?: string;received_on?: string;method?: string;reference?: string;
}
export interface CustomerPaymentCorrectionBalance {
  amount_paid: string;amount_credited?: string;outstanding: string;status: 'open' | 'settled' | 'credited';settled_on?: string;
}
export interface CustomerPaymentCorrectionRecord {
  correction_id: string;signoff_id: string;payment_id: string;invoice_id: string;invoice_ref: string;currency: string;
  action: CustomerPaymentCorrectionAction;reason: string;before: CustomerPaymentEntry;after: CustomerPaymentEntry | null;
  before_balance: CustomerPaymentCorrectionBalance;after_balance: CustomerPaymentCorrectionBalance;
  prepared_at: number;prepared_by: string;applied_at: number | null;run_id?: string;actor?: string;
}
export interface CustomerPaymentCorrectionApplyInput { correction_id: string;expected_plan_hash: string;summary: string }
export interface CustomerPaymentCorrectionPreview {
  correction: CustomerPaymentCorrectionRecord;review: CustomerPaymentCorrectionApplyInput;
}
export interface CustomerPaymentCorrectionApplyResult {
  correction_id: string;signoff_id: string;payment_id: string;invoice_id: string;
  action: CustomerPaymentCorrectionAction;already_applied: boolean;
}
export interface CustomerPaymentCorrectionHistoryInput { signoff_id: string;limit?: number;cursor?: string }
export interface CustomerPaymentCorrectionHistory { corrections: CustomerPaymentCorrectionRecord[];next_cursor?: string }
