export const DECISION_WATCH_OWNER = { publisher: 'recued-core', pack_slug: 'decision-log' } as const;
export const DECISION_WATCH_ENTITY = 'decision';
export const CUSTOMER_ACCOUNT_SCOPES = ['connection.api.hubspot.company', 'connection.api.salesforce.account'] as const;
export type CustomerAccountScope = (typeof CUSTOMER_ACCOUNT_SCOPES)[number];

export interface CustomerAccountRef {
  scope: CustomerAccountScope;
  target_id: string;
}

export interface CustomerAccountChoice extends CustomerAccountRef {
  label: string;
  connection: string;
  domain?: string;
}

export interface CustomerDecisionRef {
  decision_id: string;
  created_at: number;
  revision: number;
}

export interface CustomerInteractionEvidence {
  id: string;
  kind: string;
  at: number;
  label: string;
}

export interface CustomerDecisionReview {
  id: string;
  watch_id: string;
  decision_id: string;
  title: string;
  rationale: string;
  account: CustomerAccountChoice;
  previous: CustomerInteractionEvidence;
  incoming: CustomerInteractionEvidence;
  gap_days: number;
  reviewed_at?: number;
}

export interface CustomerDecisionWatchView {
  quiet_days: number;
  watch: {
    id: string;
    account: CustomerAccountChoice;
    state: 'waiting_for_signal' | 'watching' | 'account_unavailable';
    checked_at?: number;
    review?: CustomerDecisionReview;
  } | null;
}

export type CustomerDecisionWatchChange =
  | { action: 'start'; decision: CustomerDecisionRef; account: CustomerAccountRef }
  | { action: 'stop'; watch_id: string }
  | { action: 'reviewed'; watch_id: string; review_id: string };
