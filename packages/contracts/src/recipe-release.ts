import type { RecipeDefinition } from './recipe.js';
import type { RecipeRegressionResult } from './recipe-regression.js';

export const RECIPE_RELEASE_LIMITS = /* @__PURE__ */ Object.freeze({ recipe_bytes: 1_000_000,
  state_bytes: 4_000_000, retained_bytes: 32_000_000, tracks: 100, history: 20,
  qualification_ms: 15 * 60_000, review_ms: 5 * 60_000, diff_entries: 200 });
export interface RecipeReleaseDraft {
  revision: number; digest: string; base_digest: string; created_at: number; recipe: RecipeDefinition;
}
export interface RecipeReleaseVersion {
  sequence: number; digest: string; created_at: number; recipe: RecipeDefinition;
}
export interface RecipeReleaseQualification {
  receipt_id: string; draft_revision: number; candidate_digest: string;
  suite_revision: number; suite_digest: string; passed: number; expires_at: number;
}
export interface RecipeReleaseDifference { path: string[]; before_present: boolean; after_present: boolean; before: unknown; after: unknown }
export interface RecipeReleaseReview {
  review_id: string; draft_revision: number; candidate_digest: string; active_digest: string;
  expires_at: number; changes: RecipeReleaseDifference[]; truncated: boolean;
}
export interface RecipeReleaseView {
  recipe_id: string; supported: boolean; reason?: string; managed: boolean; revision: number;
  active: RecipeReleaseVersion | null; draft: RecipeReleaseDraft | null;
  drafts: Array<Omit<RecipeReleaseDraft,'recipe'>>; releases: Array<Omit<RecipeReleaseVersion,'recipe'>>;
  qualification: RecipeReleaseQualification | null;
}
export interface RecipeReleaseMutation extends RecipeReleaseView {
  mutation_revision: number; saved_draft?: RecipeReleaseDraft; activated?: RecipeReleaseVersion;
}
export interface RecipeReleaseSave {
  recipe_id: string; expected_revision: number; expected_active_digest: string; request_id: string; candidate: RecipeDefinition;
}
export interface RecipeReleaseRestore {
  recipe_id: string; expected_revision: number; expected_active_digest: string; request_id: string; sequence: number;
}
export interface RecipeReleaseTest { recipe_id: string; expected_revision: number; draft_revision: number; run_id: string }
export interface RecipeReleaseTestResult extends RecipeReleaseView { comparison: RecipeRegressionResult }
export interface RecipeReleasePrepare { recipe_id: string; expected_revision: number; draft_revision: number; receipt_id: string }
export interface RecipeReleaseActivate { recipe_id: string; expected_revision: number; review_id: string; request_id: string }
