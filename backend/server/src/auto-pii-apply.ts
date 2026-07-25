/** § 7 auto-PII at the execution dispatch seam.
 *
 *  One call, one place: `handleExecute` passes every recipe (bundled / SQLite
 *  / inline / MCP-authored) through here AFTER the R2 dispatch-resolve and
 *  BEFORE anything downstream reads the step list — so the held-action
 *  identity, the provenance insight snapshot (which records the
 *  execution-time shape by design, D-120), the session-grant recipe hash,
 *  the open-projection walk, and the engine all see ONE consistent recipe.
 *
 *  The rewrite is deterministic (same recipe + same classifier → identical
 *  output), so re-runs, resumes, and held-action dedup hash the same shape.
 *  Bundled recipes stay disk-read-only and SQLite rows stay as authored —
 *  the protected shape exists only in the dispatched run (and is visible in
 *  its step logs / execution-time insight). A curation change to the
 *  canonical classifier therefore takes effect on the NEXT run of every
 *  recipe — no install-time bake to go stale.
 *
 *  Fail-open on the dispatch axis, fail-closed on the privacy axis: a throw
 *  in here must never break execution (the recipe runs unprotected exactly
 *  as it did before § 7 — the validator still flags it), while the applicator
 *  itself rolls back any rewrite that does not verifiably remove the leak.
 *
 *  The former known edge — a preflight pause at the bracketed ai-step losing
 *  the run-local pii ledger across a fresh-process resume — is CLOSED by the
 *  pii-ledger-in-checkpoint substrate (`Checkpoint.pii_ledgers`; serialize at
 *  pause, hydrate at resume). Shared with authored brackets. See the
 *  apply-pii.ts header.
 *
 *  `RECUED_AUTO_PII=off` is the operator escape hatch (debugging /
 *  comparing model behavior with and without aliasing).
 */

import type { RecipeDefinition, RecipePiiPostureSummary } from '@recued/contracts';
import { recipePiiPostureHasContent } from '@recued/contracts';
import { applyAutoPiiProtection, summarizeRecipePiiPosture } from '@recued/recipes';
import { createCanonicalPiiSourceClassifier } from './pii-trace-classifier.js';

/** Built once — the canonical schemas + curated kernel table are static. */
const classifier = createCanonicalPiiSourceClassifier();

export const applyAutoPiiForExecution = (recipe: RecipeDefinition): RecipeDefinition => {
  if (process.env.RECUED_AUTO_PII === 'off') return recipe;
  try {
    const applied = applyAutoPiiProtection(recipe, classifier);
    if (!applied.changed) return recipe;
    if (applied.brackets.length > 0) {
      // One honest line per protected dispatch — a rewrite the author did
      // not write should never be invisible outside the step logs.
      console.warn(
        `[auto-pii] '${recipe.recipe_id}': aliased PII before model egress on `
        + applied.brackets.map((b) => `'${b.step_id}'`).join(', ')
        + (applied.injections.length > 0
          ? ` (+ llm.pii_fields on ${applied.injections.map((i) => `'${i.step_id}'`).join(', ')})`
          : ''),
      );
    }
    return applied.recipe;
  } catch {
    return recipe; // never break dispatch — the validator still flags the leak
  }
};

/** § 7 surfacing — assess a recipe's PII posture with the SAME canonical
 *  classifier the dispatch seam rewrites with, so what install / save /
 *  Kitchen disclose is exactly what run time will do. Honors the
 *  `RECUED_AUTO_PII=off` hatch (read per call, not at module load — the
 *  headline must never claim an auto-protection the seam will skip).
 *  Fail-safe `null`: a throw must never break an install / save rpc —
 *  surfaces omit the disclosure. Returns `null` for content-free summaries
 *  too, so callers get one "nothing to disclose" signal. */
export const assessRecipePiiPosture = (
  recipe: unknown,
): RecipePiiPostureSummary | null => {
  try {
    const summary = summarizeRecipePiiPosture(recipe, classifier, {
      autoProtection: process.env.RECUED_AUTO_PII !== 'off',
    });
    return recipePiiPostureHasContent(summary) ? summary : null;
  } catch {
    return null;
  }
};
