import type { QuoteSignoffSummary } from './quote-signoff.js';
import type { QuoteCompletionSummary } from './quote-completion.js';

export const CUSTOMER_JOB_FILTERS = ['all', 'waiting_customer', 'owner_review', 'in_progress', 'corrections', 'complete', 'unpaid', 'overdue', 'needs_attention'] as const;
export type CustomerJobFilter = (typeof CUSTOMER_JOB_FILTERS)[number];
export interface CustomerJobsListInput {
  search?: string;
  filter?: CustomerJobFilter;
  limit?: number;
  cursor?: string;
}
/** One root agreement and its amendments. Work and money remain independent. */
export interface CustomerJob {
  job_id: string;
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
    status: 'not_invoiced' | 'unpaid' | 'part_paid' | 'paid' | 'unavailable';
    amount_paid: string | null;
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
}
