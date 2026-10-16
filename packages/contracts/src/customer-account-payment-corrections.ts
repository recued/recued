import type { CustomerPaymentCorrectionRecord } from './customer-payment-corrections.js';
export const CUSTOMER_ACCOUNT_PAYMENT_CORRECTION_RECIPE = 'reception-customer-account-payment-correction';
export interface CustomerAccountPaymentCorrectionPrepareInput {
  request_key: string;account_payment_id: string;expected_receipt_hash: string;action: 'correct' | 'void';reason: string;
  amount?: string;received_on?: string;method?: string;reference?: string;
  allocations?: Array<{ payment_id: string;amount: string }>;
}
export interface CustomerAccountPaymentCorrectionRecord {
  correction_id: string;account_payment_id: string;account_id: string;customer: string;currency: string;
  action: 'correct' | 'void';reason: string;before_amount: string;after_amount: string;
  allocations: CustomerPaymentCorrectionRecord[];
  prepared_at: number;prepared_by: string;applied_at: number | null;run_id?: string;actor?: string;
}
export interface CustomerAccountPaymentCorrectionApplyInput { correction_id: string;expected_plan_hash: string;summary: string }
export interface CustomerAccountPaymentCorrectionPreview { correction: CustomerAccountPaymentCorrectionRecord;review: CustomerAccountPaymentCorrectionApplyInput }
export interface CustomerAccountPaymentCorrectionApplyResult { correction_id: string;account_payment_id: string;account_id: string;already_applied: boolean }
export interface CustomerAccountPaymentCorrectionHistoryInput { account_payment_id: string;limit?: number;cursor?: string }
export interface CustomerAccountPaymentCorrectionHistory { corrections: CustomerAccountPaymentCorrectionRecord[];next_cursor?: string }
