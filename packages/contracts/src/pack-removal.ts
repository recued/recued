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
  /** D-346 B — what removing a pack other packs use stops: each installed pack with
   *  actions that need it, and those actions. They are refused before they start,
   *  and offer the pack again, until it is installed again; everything else keeps
   *  working. A pack that lists it as a dependency without such an action is listed
   *  with none. Absent from a server before D-346, whose `dependants` block. */
  stops?: PackRemovalStop[];
}
/** D-346 B — one pack whose actions stop when the reviewed pack is removed.
 *  `pack_slug` null: the owner's own recipes, from no pack. */
export interface PackRemovalStop {
  pack_slug: string | null;
  /** The pack's name, when this server knows it. */
  name?: string;
  actions: Array<{ recipe_id: string; name?: string }>;
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
