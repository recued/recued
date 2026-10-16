import type { CustomerJob } from './customer-jobs.js';

export const CUSTOMER_JOB_ARCHIVE_FILTERS = ['active','archived','all'] as const;
export type CustomerJobArchiveFilter = (typeof CUSTOMER_JOB_ARCHIVE_FILTERS)[number];
export interface CustomerJobArchiveRecord { job_id: string;revision: number;archived_at: number | null;updated_at: number | null }
export interface CustomerJobArchiveState extends CustomerJobArchiveRecord { needs_review: boolean }
export interface CustomerJobCloseoutInput { job_id: string }
export interface CustomerJobArchiveInput extends CustomerJobCloseoutInput { expected_revision: number;expected_snapshot_hash: string;confirmed: boolean }
export interface CustomerJobRestoreInput extends CustomerJobCloseoutInput { expected_revision: number }
export interface CustomerJobArchiveEvent { revision: number;action: 'archive' | 'restore';recorded_at: number }
export interface CustomerJobCloseoutReport {
  job_id: string;captured_at: number;job: CustomerJob | null;archive: CustomerJobArchiveRecord;
  can_archive: boolean;blockers: string[];snapshot_hash: string | null;
  reminders: { saved_schedules: number;uncertain_sends: number };events: CustomerJobArchiveEvent[];has_older_events: boolean;
}
/** Archiving records an owner's closeout; it never infers customer acceptance or payment. */
export const customerJobCloseoutBlockers = (job: CustomerJob): string[] => {
  const blockers: string[] = [];
  if (['draft','publishing','waiting','accepted'].includes(job.offer.state)) blockers.push('Resolve or cancel the pending offer or added work.');
  if (!job.agreement) {
    if (!['rejected','cancelled'].includes(job.offer.state)) blockers.push('Only a declined or cancelled offer can close without released work.');
    return blockers;
  }
  if (job.agreed_scope === null || job.agreed_total === null || !job.invoices.length) blockers.push('Review the complete released agreement in Records.');
  if (job.work !== 'complete') blockers.push('Complete the released work and review its task.');
  if (job.payment.status === 'unavailable' || job.payment.outstanding === null) blockers.push('Review unavailable invoice balances in Records.');
  else if (job.payment.outstanding !== '0.0000') blockers.push('Record payment or reviewed credits for every unpaid invoice.');
  if (job.payment.refund_due && job.payment.refund_due !== '0.0000') blockers.push('Record all refunds still owed to the customer.');
  const reply = job.completion;
  if (reply && !['cancelled','superseded'].includes(reply.state)) {
    if (!job.completion_matches_agreement || reply.availability !== 'current' || reply.response.decision === 'unavailable') blockers.push('Review the completion evidence for the current agreement.');
    if (reply.state !== 'closed' || reply.owner_action?.action !== 'close' || reply.response.decision !== 'accepted') blockers.push('Resolve or cancel the completion request and finish its owner review.');
  }
  return blockers;
};
