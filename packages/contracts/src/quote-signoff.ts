/** Customer acceptance is evidence about one frozen quote, never authority to
 * change work or issue an invoice. The owner reviews the release separately. */
export const QUOTE_SIGNOFF_SCOPE_MAX = 6_000;
export const QUOTE_SIGNOFF_CONTEXT_MAX = 8_000;
export const QUOTE_SIGNOFF_RELEASE_RECIPE = 'reception-quote-signoff-release';
export const QUOTE_SIGNOFF_RELEASE_OP = 'core.work-entity.quote-signoff.release';

export const QUOTE_SIGNOFF_STATES = ['draft', 'publishing', 'waiting', 'accepted',
  'rejected', 'superseded', 'cancelled', 'released'] as const;
export type QuoteSignoffState = (typeof QUOTE_SIGNOFF_STATES)[number];
export const QUOTE_SIGNOFF_SEARCH_MAX = 200;

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
  /** The quote reference saved with the offered terms. */
  quote_reference?: string;
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
  /** Owner-list eligibility, including amendments outside the current page. */
  can_add_work?: boolean;
  /** Latest released agreement, with a bound local task. */
  can_request_completion?: boolean;
}

export interface QuoteSignoffPrepareResult {
  signoff: QuoteSignoffSummary;
  preview_hash: string;
  /** The exact text the customer will be shown. */
  customer_preview: string;
}

export interface QuoteSignoffPublishInput {
  signoff_id: string; preview_hash: string;
  /** Opt in to retaining the bearer link encrypted for reviewed follow-up mail. */
  remember_link_for_reminders?: boolean;
}
export interface QuoteSignoffPublishResult { signoff: QuoteSignoffSummary; share_url: string }
export interface QuoteSignoffListInput {
  limit?: number;
  /** Literal customer, quote label/reference or invoice-reference search. */
  search?: string;
  state?: QuoteSignoffState;
  /** Opaque keyset cursor bound to the search and state filter. */
  cursor?: string;
  /** Exact owner lookup for rechecking a displayed request before payment.
   * Cannot be combined with search, state or cursor. */
  signoff_id?: string;
}
export interface QuoteSignoffListResult {
  signoffs: QuoteSignoffSummary[];
  truncated: boolean;
  next_cursor?: string;
}
export interface QuoteSignoffQuoteChoice {
  id: string; label: string; customer: string; amount: string; currency: string; revision: number;
}
export interface QuoteSignoffQuotesResult { quotes: QuoteSignoffQuoteChoice[]; truncated: boolean }
export interface QuoteSignoffCancelInput { signoff_id: string }

export interface QuoteSignoffReceiptInput { signoff_id: string }

/** Shareable historical projection. Never includes a raw quote/plan, visitor
 * identity, reply comment, endpoint, bearer link or current work/payment data. */
export interface QuoteSignoffReceiptEntry {
  signoff_id: string;
  parent_signoff_id: string | null;
  revision: number;
  business_name: string;
  customer: string;
  quote_label: string;
  quote_reference: string | null;
  quote_revision: number;
  scope: string;
  amount: string;
  net: string;
  vat_amount: string;
  currency: string;
  /** Saved offer text when available; older plans rebuild it from frozen terms. */
  customer_preview: string;
  offer_text_source: 'saved' | 'reconstructed';
  state: QuoteSignoffState;
  prepared_at: number;
  expires_at: number;
  response: {
    decision: 'accepted' | 'declined' | 'not_recorded' | 'unavailable';
    /** Visitor submission time from the encrypted intent's consumption record. */
    received_at: number | null;
    /** Time the sign-off processor recorded the reply; may still be pending. */
    recorded_at: number | null;
  };
  release: null | {
    recorded_at: number;
    invoice_ref: string;
    issued_on: string;
    due_on: string;
  };
}

/** Root and released ancestors through the selected request only. Later
 * amendments and other pending offers never become part of an earlier receipt. */
export interface QuoteSignoffReceipt {
  format: 'recued.customer-signoff-receipt';
  version: 1 | 2;
  captured_at: number;
  selected_signoff_id: string;
  root_signoff_id: string;
  requests: QuoteSignoffReceiptEntry[];
  /** Present when this server supports delivery completion receipts. */
  completions?: import('./quote-completion.js').QuoteCompletionReceiptEntry[];
}

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
