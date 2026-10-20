import type { RecipeDefinition } from './recipe.js';
import type { RecipeRegressionResult } from './recipe-regression.js';

/** Owner-only, fixture-qualified updates of installed recipe-only packs. */
export const PACK_UPDATE_LIMITS = /* @__PURE__ */ Object.freeze({ packs: 8, receipts: 10, recipes: 20, bytes: 4_000_000,
  tracks: 100, retained_bytes: 32_000_000, qualification_ms: 15 * 60_000 });
export const PACK_RELEASE_LIMITS = /* @__PURE__ */ Object.freeze({ releases: 10, bytes: 8_000_000, retained_bytes: 64_000_000 });
export interface PackReleaseSummary {
  release_id: string; sequence: number; created_at: number; digest: string; current: boolean;
  packs: Array<{ pack_slug: string; name: string; version: number }>;
}
export interface PackRestoreStage {
  pack_slug: string; release_id: string; expected_revision: number; request_id: string;
}
export interface PackUpdateStage {
  pack_slug: string; source: 'bundled' | 'marketplace'; expected_revision: number;
  expected_manifest_hash: string; request_id: string;
  /** Explicit new-client opt-in; older clients retain single-pack staging. */
  include_dependencies?: boolean;
}
export interface PackUpdateQualification {
  review_id: string; expires_at: number; passed: number;
  suites: Array<{ recipe_id: string; revision: number; digest: string }>;
}
export interface PackUpdateView {
  pack_slug: string; managed: boolean; revision: number; installed_version: number | null;
  candidate: null | { version: number; name: string; manifest_hash: string; digest: string;
    source: 'bundled' | 'marketplace'; recipes: Array<{ recipe_id: string; pack_slug?: string; before: RecipeDefinition | null; after: RecipeDefinition }>;
    /** Present for a group that commits together, in dependency order. */
    packs?: Array<{ pack_slug: string; name: string; installed_version: number; version: number; dependencies: string[] }>;
    restore?: { release_id: string; sequence: number; created_at: number; digest: string } };
  qualification: PackUpdateQualification | null; applied: boolean;
  last_apply?: PackUpdateApplyReceipt;
  releases?: PackReleaseSummary[];
}
export interface PackUpdateTest { pack_slug: string; expected_revision: number; run_id: string }
export interface PackUpdateTestResult extends PackUpdateView { comparisons: RecipeRegressionResult[] }
export interface PackUpdateApply {
  pack_slug: string; expected_revision: number; review_id: string; request_id: string;
}
export interface PackUpdateRelease { pack_slug: string; expected_revision: number; request_id: string }
export interface PackUpdateApplyReceipt {
  request_id: string; plan_digest: string; applied_at: number;
  packs: Array<{ pack_slug: string; version: number }>;
  release_id?: string;
  restored_release_id?: string;
}
export interface PackUpdateApplyResult extends PackUpdateView { receipt: PackUpdateApplyReceipt }
