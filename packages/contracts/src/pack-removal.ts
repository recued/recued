import type { BulkPackUninstallResultLike } from './bulk-pack.js';

/** Install-time evidence. Absence means unknown, while an empty array proves
 * that the installed manifest declared no dependencies. Inventory grants no authority. */
export interface InstalledPackDependencies {
  schema_version: 1;
  dependencies: Array<{ type: 'pack' | 'ingredient'; slug: string; min_version?: number;
    installed: Array<{ inventory_key: string; publisher?: string; version?: number }> }>;
}
export interface PackRemovalPack { inventory_key: string; pack_slug: string; publisher?: string; version?: number }
export interface PackRemovalPlan {
  review_id: string; expires_at: number; pack: PackRemovalPack;
  publisher_choices: string[];
  blockers: Array<{ code: string; message: string }>;
  dependants: Array<PackRemovalPack & { direct: boolean; via: string[] }>;
  unknown_dependencies: PackRemovalPack[];
  dependencies_kept: PackRemovalPack[];
  ingredients: { removed: string[]; shared: string[] };
  recipes: string[];
  bundled_recipes_kept: string[];
  owned: { schedules: number; automations: number; recipes_with_settings: number };
  runtime: { would_disable: string[]; would_degrade: string[] };
  protection: { roots: string[]; release_history: boolean };
  records?: { disposition: 'retain'; publisher: string; pack_slug: string };
  prior_attempt_unconfirmed: boolean;
}
export interface PackRemovalReview { pack_slug: string; publisher?: string; request_id: string }
export interface PackRemovalApply {
  review_id: string; request_id: string;
  acknowledge_unknown_dependencies?: boolean; acknowledge_incomplete_attempt?: boolean;
}
export interface PackRemovalReceipt {
  review_id: string; request_id: string; pack_slug: string; completed_at: number;
  result: BulkPackUninstallResultLike;
}
export interface PackRemovalApplyResult { receipt: PackRemovalReceipt; installed_now: boolean }
