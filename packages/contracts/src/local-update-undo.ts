import type { LocalMutationReceiptSummary, ResourceReview } from './resource-review.js';

/** A new owner decision over the reverse of a confirmed local update. */
export interface LocalUpdateUndoReview {
  undo_id: string;
  predecessor_receipt_id: string;
  review_hash: string;
  expires_at: number;
  resource_review: ResourceReview;
}
export interface LocalUpdateUndoDecision {
  undo_id: string;
  review_hash: string;
  decision: 'approve' | 'deny';
}
export interface LocalUpdateUndoResult {
  undo_id: string;
  predecessor_receipt_id: string;
  status: 'completed' | 'denied' | 'unknown' | 'failed';
  local_receipt?: LocalMutationReceiptSummary;
}
