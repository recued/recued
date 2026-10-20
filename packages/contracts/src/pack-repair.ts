import type { PackRemovalPack } from './pack-removal.js';
import type { RecordsNamespaceState } from './records.js';

/** Local installation evidence. A clean inspection is not provider qualification. */
export interface PackRepairFinding { code: string; message: string }
export interface PackRepairEntry {
  pack: PackRemovalPack;
  inventory: boolean;
  recipes: string[];
  records_state?: RecordsNamespaceState['state'];
  ingredients: Array<{ id: string; inventory: boolean; local_manifest: 'present' | 'missing' | 'stale' | 'not_required' }>;
  metadata: { grants: number; body_grants: number; bindings: number; defaults: number; holders: number; templates: number; protection: boolean; history: boolean };
  removal: 'none' | 'unconfirmed' | 'complete' | 'unreadable';
  findings: PackRepairFinding[];
  next_step: 'none' | 'review_cleanup' | 'install' | 'inspect';
}
export interface PackRepairInspection {
  inspected_at: number;
  entries: PackRepairEntry[];
  /** Bodies without an installed ingredient cannot safely be attributed to a pack. */
  unattributed_manifests: string[];
  /** Latest retained completions for this paired client, including lost replies. */
  recent_repairs: Array<{ request: PackRepairApply; receipt: PackRepairReceipt }>;
  unavailable_receipts: number;
}
export interface PackRepairReview { inventory_key: string; request_id: string }
export interface PackRepairPlan {
  review_id: string;
  expires_at: number;
  entry: PackRepairEntry;
  action: 'finish_local_cleanup' | 'retire_orphaned_metadata' | 'none';
  blockers: PackRepairFinding[];
  changes: string[];
  manifests_removed: string[];
  ingredients_removed: string[];
  ingredients_kept: string[];
  connections: string[];
  unknown_dependencies: PackRemovalPack[];
  would_disable: string[];
  would_degrade: string[];
}
export interface PackRepairApply {
  review_id: string;
  request_id: string;
  acknowledge_local_cleanup: boolean;
  acknowledge_unknown_dependencies?: boolean;
}
export interface PackRepairReceipt {
  review_id: string;
  request_id: string;
  completed_at: number;
  pack: PackRemovalPack;
  action: Exclude<PackRepairPlan['action'], 'none'>;
  changes: string[];
}
export interface PackRepairApplyResult {
  receipt: PackRepairReceipt;
  /** Fresh evidence, separate from the historical completion receipt. */
  current?: PackRepairEntry;
  reconciliation_pending: boolean;
}
