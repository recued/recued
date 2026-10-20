import type { RecipeDefinition } from './recipe.js';
import type { RecipeRegressionCase } from './recipe-regression.js';
import type { ServerExecuteResponse } from './rpc/server-registry.js';

/** Temporary, paired-owner capture. Only an explicitly imported test is durable. */
export const RECIPE_RUN_CAPTURE_LIMITS = /* @__PURE__ */ Object.freeze({ entries: 32, active: 2,
  ttl_ms: 10 * 60_000, bytes: 2_000_000, retained_bytes: 32_000_000 });
export interface RecipeRunCaptureRequest {
  recipe_id: string; config?: Record<string, unknown>; context?: Record<string, unknown>;
  dish_id?: string; connections?: Record<string, string>;
}
export interface RecipeRunCaptureSummary {
  capture_id: string; recipe_id: string; created_at: number; expires_at: number;
  state: 'prepared' | 'running' | 'ready' | 'unavailable';
  reason?: string; run_id?: string;
  run_outcome?: 'passed' | 'failed' | 'held' | 'waiting' | 'terminated' | 'skipped';
}
export interface RecipeRunCaptureDraft {
  recipe: RecipeDefinition; recipe_digest: string; source_recipe_digest: string; case: RecipeRegressionCase;
  redactions: string[]; checks_omitted: number; replay_matches: boolean;
}
export interface RecipeRunCaptureRead { capture: RecipeRunCaptureSummary; draft: RecipeRunCaptureDraft | null }
export interface RecipeRunCaptureResult { execution: ServerExecuteResponse; capture: RecipeRunCaptureSummary }
export interface RecipeRunCaptureImport {
  capture_id: string; recipe_digest: string; expected_revision: number; request_id: string;
  reviewed: true; case: RecipeRegressionCase;
}
