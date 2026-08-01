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
 *  The owner's `privacy.auto_pii_protection` setting (Settings → Privacy,
 *  default ON) is the escape hatch — debugging / comparing model behavior with
 *  and without aliasing. It replaced the `RECUED_AUTO_PII` env var, which was
 *  not boot-critical and had no UI, no persistence, and no visibility.
 */

import type { RecipeDefinition, RecipePiiPostureSummary } from '@recued/contracts';
import { recipePiiPostureHasContent } from '@recued/contracts';
import { applyAutoPiiProtection, summarizeRecipePiiPosture } from '@recued/recipes';
import { createCanonicalPiiSourceClassifier } from './pii-trace-classifier.js';

/** Built once — the canonical schemas + curated kernel table are static. */
const classifier = createCanonicalPiiSourceClassifier();

/** Live read of the owner's `privacy.auto_pii_protection` setting.
 *
 *  ⚠ DEFAULTS TO ENABLED. A boot path that forgets to call
 *  `configureAutoPiiProtection` therefore fails SAFE — protection ON — never
 *  silently off. Getting this default backwards would disable PII aliasing on
 *  every server whose composition root missed the wiring, with no error. */
let isProtectionEnabled: () => boolean = () => true;

/** Wire the setting source. Called once from the composition root with a
 *  closure over the `RuntimeConfigStore`, so the value stays a LIVE read.
 *
 *  Injected here rather than threaded to the seven call sites of
 *  `applyAutoPiiForExecution` / `assessRecipePiiPosture`: those live in five
 *  handler modules whose dep interfaces are field-by-field copiers, and a
 *  resolver dropped from one of them would silently read the safe default
 *  instead of the owner's setting — a wiring bug that looks like working code.
 *  One injection point has one place to get wrong, and the default covers it. */
export const configureAutoPiiProtection = (resolver: () => boolean): void => {
  isProtectionEnabled = resolver;
};

/** THE definition of "auto-PII is off" — one predicate, three readers
 *  (execution seam, disclosure assessor, boot banner).
 *
 *  ⚠ Resolves PER CALL, never snapshot at module load. `assessRecipePiiPosture`
 *  depends on that: a disclosure headline claims RUN-TIME behaviour, so a
 *  snapshot re-opens the lying-headline window — a server whose owner toggled
 *  the setting would keep promising a protection the seam now skips.
 *
 *  This used to read `process.env.RECUED_AUTO_PII === 'off'`. That var was
 *  deleted 2026-07-28: it is not boot-critical (nothing needs it before a store
 *  can be read), and it was the ONLY home for a user decision — no UI, no
 *  persistence, invisible to the owner. It is now
 *  `privacy.auto_pii_protection` in `RUNTIME_SCHEMA`, which the generic
 *  settings renderer surfaces as a labelled toggle. */
export const isAutoPiiDisabled = (): boolean => !isProtectionEnabled();

export const applyAutoPiiForExecution = (recipe: RecipeDefinition): RecipeDefinition => {
  if (isAutoPiiDisabled()) return recipe;
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
 *  `privacy.auto_pii_protection` setting (read per call, not at module load — the
 *  headline must never claim an auto-protection the seam will skip).
 *  Fail-safe `null`: a throw must never break an install / save rpc —
 *  surfaces omit the disclosure. Returns `null` for content-free summaries
 *  too, so callers get one "nothing to disclose" signal. */
export const assessRecipePiiPosture = (
  recipe: unknown,
): RecipePiiPostureSummary | null => {
  try {
    const summary = summarizeRecipePiiPosture(recipe, classifier, {
      autoProtection: !isAutoPiiDisabled(),
    });
    return recipePiiPostureHasContent(summary) ? summary : null;
  } catch {
    return null;
  }
};
