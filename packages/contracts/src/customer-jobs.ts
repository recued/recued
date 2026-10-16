import type { CustomerJobArchiveFilter,CustomerJobArchiveState } from './customer-job-closeout.js';
import type { QuoteSignoffSummary } from './quote-signoff.js';
import type { QuoteCompletionSummary } from './quote-completion.js';

export const CUSTOMER_JOB_FILTERS = ['all', 'waiting_customer', 'owner_review', 'in_progress', 'corrections', 'complete', 'unpaid', 'overdue', 'needs_attention'] as const;
export type CustomerJobFilter = (typeof CUSTOMER_JOB_FILTERS)[number];
export interface CustomerJobsListInput {
  archive?: CustomerJobArchiveFilter;
  search?: string;
  filter?: CustomerJobFilter;
  limit?: number;
  cursor?: string;
}
/** One root agreement and its amendments. Work and money remain independent. */
export interface CustomerJob {
  job_id: string;
  archive?: CustomerJobArchiveState;
  created_at: number;
  customer: string;
  quote_label: string;
  quote_reference?: string;
  currency: string;
  agreed_scope: string | null;
  agreed_total: string | null;
  offer: QuoteSignoffSummary;
  agreement: QuoteSignoffSummary | null;
  /** Payment targets omit cumulative amendment metadata, held on agreement. */
  invoices: Array<Omit<QuoteSignoffSummary,'addition'>>;
  work: 'not_released' | 'in_progress' | 'complete' | 'unavailable';
  payment: {
    status: 'not_invoiced' | 'unpaid' | 'part_paid' | 'paid' | 'credited' | 'unavailable';
    amount_paid: string | null;
    amount_credited?: string;
    amount_refund_credited?: string;amount_refunded?: string;refund_due?: string;net_received?: string;net_invoice_total?: string;
    outstanding: string | null;
    has_unpaid_balance: boolean;
    overdue: boolean;
  };
  completion: QuoteCompletionSummary | null;
  /** Historical replies to an earlier scope never confirm the current scope. */
  completion_matches_agreement: boolean;
  offer_reply: 'not_recorded' | 'received' | 'unavailable';
  waiting_customer: boolean;
  needs_owner_review: boolean;
  corrections: boolean;
  needs_attention: boolean;
  can_request_completion: boolean;
}
export interface CustomerJobsListResult {
  captured_at: number;
  jobs: CustomerJob[];
  next_cursor?: string;
  /** Checked candidates, separate from jobs matching the current filter. */
  scanned_jobs?: number;
  /** More indexed jobs remain after this bounded filter scan, even on an empty page. */
  scan_limited?: boolean;
}
