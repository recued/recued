import type { LocalMutationReceiptSummary, ResourceReview } from './resource-review.js';

export const LOCAL_CHANGE_SET_LIMITS = Object.freeze({ members: 25,updates: 100,review_bytes: 256 * 1024,
  pending: 100,retained_review_bytes: 16 * 1024 * 1024,review_ms: 10 * 60_000 });

export interface LocalChangeSetPrepare { proposal_id: string; request_id: string }
export interface LocalChangeSetUndoPrepare { change_set_id: string; request_id: string }
export interface LocalChangeSetDecision { change_set_id: string; review_hash: string; decision: 'approve' | 'deny' }
export interface LocalChangeSetReview {
  change_set_id: string; source_proposal_id: string | null; undo_of: string | null;
  title: string; requested_through: string; review_hash: string; expires_at: number;
  changes: Array<{ member_id: string; label: string; resource_review: ResourceReview }>;
}
export interface LocalChangeSetInspection {
  change_set_id: string; source_proposal_id: string | null; undo_of: string | null;
  status: 'pending' | 'completed' | 'denied' | 'failed' | 'unknown' | 'expired';
  created_at: number; decided_at: number | null;
  receipts: Array<{ member_id: string; local_receipt: LocalMutationReceiptSummary }>;
  undo_available: boolean; undo_change_set_id: string | null;
  review?: LocalChangeSetReview;
}

/** Resource floor only: the host also verifies the installed update binding. */
export const hasLocalUpdateResources = (review: ResourceReview): boolean => review.resources.length > 0
  && review.resources.every(resource => resource.after !== null && (resource.kind === 'calendar'
    ? resource.precondition.kind === 'local_version' && review.operation === 'calendar-update'
    : resource.precondition.kind === 'records_revision'
      && (resource.changes === undefined || (resource.changes.length > 0 && resource.changes.every(change => change.action === 'update'
        && change.before !== null && change.after !== null)))));
