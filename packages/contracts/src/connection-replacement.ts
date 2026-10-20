/** Owner-reviewed changes to local account references. No credentials or remote
 * resource identifiers are copied by this protocol. */
export interface ConnectionReplacementIdentity {
  connection_name: string;
  display_name: string;
  host: string | null;
  vendor?: string;
  /** Opaque enrolled route and credential-lineage identity, never a name match. */
  identity: string;
}
export interface ConnectionReplacementIssue { code: string; message: string; resource?: string }
export interface ConnectionReplacementTarget { pack_slug: string; slot: string }
export interface ConnectionReplacementPack extends ConnectionReplacementTarget {
  pack_name: string;
  catalogs: string[];
  shared_with: string[];
  before_connections: string[];
  after_connections: string[];
  before_default?: string;
  after_default?: string;
  blockers: ConnectionReplacementIssue[];
}
export interface ConnectionReplacementDish {
  dish_id: string; recipe_id: string; name: string; slots: string[];
}
export interface ConnectionReplacementImpact {
  recipe_id: string; name: string; dish_ids: string[];
  schedules: number; triggers: number; timers: number;
}
export interface ConnectionReplacementSelection {
  from_connection: string; to_connection: string;
  targets: ConnectionReplacementTarget[];
  dish_ids: string[];
}
export interface ConnectionReplacementReview extends ConnectionReplacementSelection { request_id: string }
export interface ConnectionReplacementRollback { receipt_id: string; request_id: string }
export interface ConnectionReplacementPlan {
  review_id: string; expires_at: number; direction: 'replace' | 'rollback';
  parent_receipt_id?: string;
  from: ConnectionReplacementIdentity; to: ConnectionReplacementIdentity;
  packs: ConnectionReplacementPack[]; dishes: ConnectionReplacementDish[];
  impacts: ConnectionReplacementImpact[]; blockers: ConnectionReplacementIssue[];
  changes: string[];
}
export interface ConnectionReplacementApply {
  review_id: string; request_id: string; acknowledge_account_change: boolean;
}
export interface ConnectionReplacementReceipt {
  review_id: string; request_id: string; completed_at: number;
  direction: 'replace' | 'rollback'; parent_receipt_id?: string;
  from: ConnectionReplacementIdentity; to: ConnectionReplacementIdentity;
  packs: ConnectionReplacementTarget[]; dish_ids: string[]; changes: string[];
}
export interface ConnectionReplacementInspection {
  connections: ConnectionReplacementIdentity[];
  packs: ConnectionReplacementPack[]; dishes: ConnectionReplacementDish[];
  recent: Array<{ request: ConnectionReplacementApply; receipt: ConnectionReplacementReceipt }>;
  unavailable_receipts: number;
}
export interface ConnectionReplacementInspect { from_connection?: string; to_connection?: string }
export interface ConnectionReplacementResult {
  receipt: ConnectionReplacementReceipt;
  /** Current evidence is independent of the historical completion receipt. */
  current?: ConnectionReplacementInspection;
  reconciliation_pending: boolean;
}
