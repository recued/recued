/** Completion confirms delivery of a released agreement. Customer replies are
 * evidence; the owner separately approves closing or reopening its local task. */
export const QUOTE_COMPLETION_RECIPE = 'reception-quote-completion-review';
export const QUOTE_COMPLETION_SCOPE_MAX = 4_000;
export const QUOTE_COMPLETION_STATES = ['draft', 'publishing', 'waiting', 'accepted',
  'corrections_requested', 'superseded', 'cancelled', 'closed', 'reopened'] as const;
export type QuoteCompletionState = (typeof QUOTE_COMPLETION_STATES)[number];

export interface QuoteCompletionPrepareInput {
  signoff_id: string;
  delivery_summary: string;
  expiry_days?: number;
}
export interface QuoteCompletionResponse {
  decision: 'accepted' | 'corrections_requested' | 'not_recorded' | 'unavailable';
  received_at: number | null;
  recorded_at: number | null;
  /** Paired owner view only. Customer receipts omit visitor free text. */
  corrections?: string;
}
export interface QuoteCompletionSummary {
  completion_id: string;
  signoff_id: string;
  root_signoff_id: string;
  customer: string;
  quote_label: string;
  business_name: string;
  agreed_scope: string;
  delivery_summary: string;
  customer_preview: string;
  state: QuoteCompletionState;
  availability: 'current' | 'expired' | 'superseded' | 'unavailable';
  created_at: number;
  expires_at: number;
  endpoint_id: string | null;
  response: QuoteCompletionResponse;
  owner_action: { action: 'close' | 'reopen'; recorded_at: number } | null;
  review?: 'not_queued' | 'waiting' | 'running' | 'closed';
}
export interface QuoteCompletionPrepareResult {
  completion: QuoteCompletionSummary;
  preview_hash: string;
  customer_preview: string;
}
export interface QuoteCompletionPublishInput { completion_id: string; preview_hash: string }
export interface QuoteCompletionPublishResult { completion: QuoteCompletionSummary; share_url: string }
export interface QuoteCompletionCancelInput { completion_id: string }
export interface QuoteCompletionListInput {
  signoff_id?: string;
  review_only?: boolean;
  limit?: number;
  cursor?: string;
}
export interface QuoteCompletionListResult { completions: QuoteCompletionSummary[]; next_cursor?: string }
export interface QuoteCompletionReviewInput {
  completion_id: string;
  expected_plan_hash: string;
  summary: string;
}
export interface QuoteCompletionReviewResult {
  completion_id: string;
  task_id: string;
  action: 'close' | 'reopen';
  already_reviewed: boolean;
}
/** A receipt captures the request, canonical decision and recorded owner action.
 * It excludes contact identity, share links, task snapshots and reply comments. */
export type QuoteCompletionReceiptEntry = Omit<QuoteCompletionSummary, 'availability' | 'review' | 'endpoint_id' | 'response'> & {
  response: Omit<QuoteCompletionResponse, 'corrections'>;
};
