export const RECEIVABLE_AGING_BUCKETS = ['current','1_30','31_60','61_90','91_plus'] as const;
export type ReceivableAgingBucket = (typeof RECEIVABLE_AGING_BUCKETS)[number];
export type ReceivableAgingFilter = ReceivableAgingBucket | 'all' | 'needs_review';
export interface CustomerReceivablesAgingInput {
  search?: string;currency?: string;bucket?: ReceivableAgingFilter;limit?: number;cursor?: string;
}
interface ReceivableInvoiceIdentity {
  job_id: string;signoff_id: string;invoice_id: string;invoice_ref: string;
  customer: string;quote_label: string;quote_reference?: string;currency: string;
}
export type CustomerReceivableInvoice = ReceivableInvoiceIdentity & ({
  availability: 'current';due_on: string;days_overdue: number;bucket: ReceivableAgingBucket;
  outstanding: string;refund_due: string;
} | {
  availability: 'needs_review';bucket: 'needs_review';issue: string;
  due_on: null;days_overdue: null;outstanding: null;refund_due: null;
});
export interface CustomerReceivablesCurrency {
  currency: string;outstanding: string;overdue: string;invoice_count: number;
  buckets: Array<{ bucket: ReceivableAgingBucket;amount: string;invoice_count: number }>;
  /** Refund liabilities stay separate and never offset customer debt. */
  refund_due: string;refund_invoice_count: number;
}
export interface CustomerReceivablesAging {
  format: 'recued.customer-receivables-aging';version: 1;
  captured_at: number;as_of: string;time_zone: string;snapshot_hash: string;
  /** Totals follow search/currency, before the aging-bucket filter or paging. */
  balances: CustomerReceivablesCurrency[];currencies: string[];
  rows: CustomerReceivableInvoice[];matching_rows: number;review_count: number;complete: boolean;
  evaluated_invoices: number;notes: string[];next_cursor?: string;
}
