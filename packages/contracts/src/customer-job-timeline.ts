import type { CustomerJob } from './customer-jobs.js';

export const CUSTOMER_JOB_TIMELINE_CATEGORIES = ['all','agreements','work','money','followups','archive'] as const;
export type CustomerJobTimelineCategory = (typeof CUSTOMER_JOB_TIMELINE_CATEGORIES)[number];
export type CustomerJobTimelineAction = 'receipt' | 'payment_history' | 'closeout';
export interface CustomerJobTimelineInput {
  job_id: string;category?: CustomerJobTimelineCategory;search?: string;limit?: number;cursor?: string;
}
/** recorded_at is a saved local time. A business date never becomes a guessed timestamp. */
export interface CustomerJobTimelineEvent {
  event_id: string;category: Exclude<CustomerJobTimelineCategory,'all'>;
  recorded_at: number | null;title: string;details: string[];
  business_date?: { label: string;value: string };
  signoff_id?: string;action?: CustomerJobTimelineAction;run_id?: string;
}
export interface CustomerJobTimelineSchedule {
  kind: 'offer' | 'completion' | 'payment';request_id: string;due_at: number | null;revision: number;
}
export interface CustomerJobTimeline {
  job_id: string;captured_at: number;snapshot_hash: string;job: CustomerJob;
  events: CustomerJobTimelineEvent[];total_events: number;matching_events: number;
  schedules: CustomerJobTimelineSchedule[];notes: string[];issues: string[];billing_available: boolean;next_cursor?: string;
}
