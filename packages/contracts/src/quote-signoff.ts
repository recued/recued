/** Customer acceptance is evidence about one frozen quote, never authority to
 * change work or issue an invoice. The owner reviews the release separately. */
export const QUOTE_SIGNOFF_SCOPE_MAX = 6_000;
export const QUOTE_SIGNOFF_CONTEXT_MAX = 8_000;
export const QUOTE_SIGNOFF_RELEASE_RECIPE = 'reception-quote-signoff-release';
export const QUOTE_SIGNOFF_RELEASE_OP = 'core.work-entity.quote-signoff.release';

export type QuoteSignoffState = 'draft' | 'publishing' | 'waiting' | 'accepted'
  | 'rejected' | 'superseded' | 'cancelled' | 'released';

export interface QuoteSignoffPrepareInput {
  quote_id: string;
  /** The complete customer-visible scope. Private quote notes are never copied. */
  scope: string;
  display_name: string;
  task_title: string;
  invoice_ref: string;
  /** VAT already included in the quote total; defaults to zero. Exact decimal. */
  vat_amount?: string;
  issued_on?: string;
  due_on?: string;
  expiry_days?: number;
}

/** Added work starts from the latest released agreement. Its amount is an
 * additional charge in the original currency, never a replacement total. */
export interface QuoteSignoffAdditionPrepareInput {
  parent_signoff_id: string;
  scope: string;
  amount: string;
  display_name: string;
  invoice_ref: string;
  vat_amount?: string;
  issued_on?: string;
  due_on?: string;
  expiry_days?: number;
}

export interface QuoteSignoffAdditionSummary {
  parent_signoff_id: string;
  root_signoff_id: string;
  revision: number;
  base_scope: string;
  base_amount: string;
  total_amount: string;
}

/** Current owner-only records, separate from the customer's saved agreement.
 * Completion uses the task's done bit; payment is what Invoice Book records. */
export interface QuoteSignoffFollowUp {
  checked_at: number;
  task: { availability: 'missing' | 'changed' | 'unavailable' } | {
    availability: 'current';
    title: string;
    done: boolean;
    state?: string;
    progress?: number;
  };
  invoice: { availability: 'missing' | 'changed' | 'unavailable' } | {
    availability: 'current';
    status: 'open' | 'settled' | 'carried_forward';
    amount_paid: string;
    outstanding: string;
    due_on: string;
    overdue: boolean;
    carried_to?: string;
  };
}

export interface QuoteSignoffSummary {
  signoff_id: string;
  quote_id: string;
  quote_version: number;
  quote_revision: number;
  quote_label: string;
  customer: string;
  amount: string;
  currency: string;
  net: string;
  vat_amount: string;
  scope: string;
  task_title: string;
  invoice_ref: string;
  issued_on: string;
  due_on: string;
  state: QuoteSignoffState;
  /** Owner review is separate from the customer's recorded acceptance. */
  release_review?: 'not_queued' | 'waiting' | 'running' | 'closed';
  /** Computed from the current quote and clock, including while awaiting review. */
  availability: 'current' | 'superseded' | 'expired' | 'unavailable';
  created_at: number;
  expires_at: number;
  endpoint_id: string | null;
  responded_at: number | null;
  released_at: number | null;
  task_id: string | null;
  invoice_id: string | null;
  /** Absent on the original quote. `scope` and `amount` describe added work. */
  addition?: QuoteSignoffAdditionSummary;
  /** Present only for released requests returned by the owner's list. */
  follow_up?: QuoteSignoffFollowUp;
}

export interface QuoteSignoffPrepareResult {
  signoff: QuoteSignoffSummary;
  preview_hash: string;
  /** The exact text the customer will be shown. */
  customer_preview: string;
}

export interface QuoteSignoffPublishInput { signoff_id: string; preview_hash: string }
export interface QuoteSignoffPublishResult { signoff: QuoteSignoffSummary; share_url: string }
export interface QuoteSignoffListInput { limit?: number }
export interface QuoteSignoffListResult { signoffs: QuoteSignoffSummary[]; truncated: boolean }
export interface QuoteSignoffQuoteChoice {
  id: string; label: string; customer: string; amount: string; currency: string; revision: number;
}
export interface QuoteSignoffQuotesResult { quotes: QuoteSignoffQuoteChoice[]; truncated: boolean }
export interface QuoteSignoffCancelInput { signoff_id: string }
export interface QuoteSignoffReleaseInput {
  signoff_id: string;
  /** Immutable plan digest. Editing an approval cannot substitute another plan. */
  expected_plan_hash: string;
  /** Human-readable review text, checked against the stored plan at dispatch. */
  summary: string;
}
export interface QuoteSignoffReleaseResult {
  signoff_id: string;
  task_id: string;
  invoice_id: string;
  already_released: boolean;
}
