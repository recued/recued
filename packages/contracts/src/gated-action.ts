/** Durable owner-facing outcome for one checkpointed gated operation.
 *
 * A recipe run is provenance, not the receipt identity: one run may cross
 * several approval gates and therefore own several receipts. Likewise an ask
 * is only a decision envelope: a D-177 batch ask may cover several receipts
 * and may be re-rendered under a new `ask_id`. `action_ref` identifies the
 * operation and `approval_ref` identifies the stable decision group. */

export const GATED_ACTION_STATUSES = [
  'awaiting_approval',
  'dispatching',
  'succeeded',
  'partial',
  'failed',
  'dispatched',
  'denied',
  'cancelled',
  'in_doubt',
] as const;

export type GatedActionStatus = (typeof GATED_ACTION_STATUSES)[number];

export type GatedActionTerminalStatus = Exclude<
  GatedActionStatus,
  'awaiting_approval' | 'dispatching'
>;

/** Host-owned interpretation of a gated operation's return value. Provider
 * data can resemble a detached-launch receipt, so only trusted dispatch
 * metadata may opt a receipt into durable-handoff classification. */
export type GatedActionSettlementMode = 'returned_result' | 'durable_handoff';

const GATED_ACTION_TERMINAL_STATUS_SET: ReadonlySet<GatedActionStatus> = new Set([
  'succeeded',
  'partial',
  'failed',
  'dispatched',
  'denied',
  'cancelled',
  'in_doubt',
]);

export const isGatedActionTerminal = (
  status: GatedActionStatus,
): status is GatedActionTerminalStatus =>
  GATED_ACTION_TERMINAL_STATUS_SET.has(status);

export interface GatedActionObserved {
  /** Provider-effect attempts represented by this approval segment. */
  items: number;
  succeeded: number;
  failed: number;
  /** Accepted by an asynchronous continuation substrate, not completed. */
  dispatched?: number;
}

export interface GatedActionHandoff {
  kind: 'peer_exchange' | 'deferred_execution';
  /** Address of the continuation substrate, not a promise of completion. */
  ref: string;
}

export interface GatedActionReceipt {
  action_ref: string;
  /** Stable decision group. A single action uses its own action_ref; a D-177
   * batch uses batch_id. Never an ask_id. */
  approval_ref: string;
  run_id: string;
  recipe_id?: string;
  gated_step_id: string;
  ingredient_slug?: string;
  operation_id?: string;
  connection_name?: string;
  /** A pre-approved invocation has no invented held checkpoint. Its owner
   * decision and encrypted result are addressed by this durable linkage. */
  preapproval?: {
    future_execution_ref: string; proposal_id: string; grant_id: string;
    member_id: string; root_run_id: string; parent_member_id: string | null;
  };
  status: GatedActionStatus;
  terminal: boolean;
  status_message: string;
  created_at: number;
  updated_at: number;
  /** Durable store-wide change order. Unlike updated_at, this cannot move
   * backward when the host clock is corrected. Concurrent writes may share a
   * sequence, so cursors pair it with action_ref. */
  change_seq: number;
  revision: number;
  /** The currently-rendered ask, for navigation only. It may change while the
   * action_ref and approval_ref remain stable. */
  current_ask_id?: string;
  approved_bound?: { requests: number; total_bytes: number };
  observed?: GatedActionObserved;
  result?: unknown;
  result_omitted_reason?: 'size_limit' | 'not_serializable';
  handoff?: GatedActionHandoff;
}

export interface GatedActionApprovalGroup {
  approval_ref: string;
  status: GatedActionStatus;
  terminal: boolean;
  status_message: string;
  action_refs: string[];
  items: number;
  succeeded: number;
  failed: number;
  dispatched: number;
  denied: number;
  cancelled: number;
  in_doubt: number;
  updated_at: number;
  /** Greatest member change sequence represented by this aggregate. */
  change_seq: number;
}

export interface GatedActionGetRequest {
  action_ref: string;
}

export interface GatedActionGetResponse {
  receipt: GatedActionReceipt;
  group: GatedActionApprovalGroup;
}

export interface GatedActionListRequest {
  /** Inclusive lower bound over `updated_at`. */
  since?: number;
  /** Epoch owning `since_change_seq`. When it differs from the server's
   * current epoch, the server resumes at that epoch's reserved floor rather
   * than applying a sequence value from a restored database lineage. */
  since_change_epoch?: string;
  /** Inclusive durable lower bound used for reconnect reconciliation. Zero is
   * valid for an empty/new lineage; persisted receipt rows remain positive. */
  since_change_seq?: number;
  /** Server-clamped; newest receipts are returned first. */
  limit?: number;
  status?: GatedActionStatus[];
  /** Exclusive descending-page cursor returned by the preceding response. */
  before?: GatedActionListCursor;
}

export interface GatedActionListCursor {
  change_seq: number;
  action_ref: string;
}

export interface GatedActionListResponse {
  /** Stable across ordinary restarts; rotated inside every committing archive
   * restore before its staged database becomes live. */
  change_epoch: string;
  /** Reserved sequence barrier for this epoch. Restored rows are strictly below
   * it and post-restore mutations are strictly above it. */
  change_floor: number;
  receipts: GatedActionReceipt[];
  groups: GatedActionApprovalGroup[];
  next_cursor?: GatedActionListCursor;
}
