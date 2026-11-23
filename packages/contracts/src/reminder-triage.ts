import type { ReminderView } from './reminder.js';

/** A bounded selection from the owner's loaded, filtered reminder list. */
export const REMINDER_TRIAGE_MAX = 200;
export type ReminderTriageAction = { kind: 'cancel' } | { kind: 'move'; at: number; time_zone: string };
export interface ReminderTriagePreviewRequest {
  reminder_ids: string[];
  action: ReminderTriageAction;
}
export interface ReminderTriageReviewItem {
  reminder_id: string;
  reminder?: ReminderView;
  /** Present only when this exact reminder and delivery policy can be reviewed. */
  review_token?: string;
  message: string;
  /** Delivery may be held until this instant by the owner's quiet hours. */
  delivery_not_before?: number;
}
export interface ReminderTriagePreview {
  action: ReminderTriageAction;
  items: ReminderTriageReviewItem[];
}
export interface ReminderTriageApplyRequest {
  /** Stable across retries of this reviewed operation, scoped to the paired owner. */
  request_id: string;
  action: ReminderTriageAction;
  items: { reminder_id: string; review_token: string }[];
}
export interface ReminderTriageOutcome {
  reminder_id: string;
  status: 'applied' | 'failed' | 'needs_review';
  message: string;
  reminder?: ReminderView;
  replayed?: true;
}
export interface ReminderTriageResult { items: ReminderTriageOutcome[] }
