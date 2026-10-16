import type { CustomerInvoiceCreditBalance,CustomerInvoiceCreditEntry,CustomerInvoiceCreditRecord } from './customer-invoice-credits.js';

export const CUSTOMER_CREDIT_CORRECTION_RECIPE = 'reception-customer-credit-correction';
export interface CustomerCreditCorrectionPrepareInput {
  request_key: string;signoff_id: string;credit_id: string;expected_snapshot_hash: string;
  action: 'reverse' | 'replace';reason: string;reversed_on: string;
  amount?: string;issued_on?: string;replacement_reason?: string;
}
export interface CustomerCreditCorrectionRecord {
  correction_id: string;signoff_id: string;invoice_id: string;invoice_ref: string;currency: string;
  action: 'reverse' | 'replace';reason: string;reversed_on: string;
  before: CustomerInvoiceCreditEntry;replacement: CustomerInvoiceCreditRecord | null;
  before_balance: CustomerInvoiceCreditBalance;after_balance: CustomerInvoiceCreditBalance;
  prepared_at: number;prepared_by: string;applied_at: number | null;run_id?: string;actor?: string;
}
export interface CustomerCreditCorrectionApplyInput { correction_id: string;expected_plan_hash: string;summary: string }
export interface CustomerCreditCorrectionPreview { correction: CustomerCreditCorrectionRecord;review: CustomerCreditCorrectionApplyInput }
export interface CustomerCreditCorrectionApplyResult {
  correction_id: string;signoff_id: string;credit_id: string;invoice_id: string;replacement_credit_id?: string;already_applied: boolean;
}
export interface CustomerCreditCorrectionHistoryInput { signoff_id: string;limit?: number;cursor?: string }
export interface CustomerCreditCorrectionHistory { corrections: CustomerCreditCorrectionRecord[];next_cursor?: string }
