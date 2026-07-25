/** § 7 third slice — the PII posture summary install / save / Kitchen
 *  surfaces render.
 *
 *  One writer for the copy: every surface (the packs install dialog, the
 *  webclient recipes view, the MCP `recued_saveRecipe` tool result) renders
 *  these lines VERBATIM, so the human's modal and the model's tool result
 *  teach the same thing (the § 8 targeting-guard precedent). Messages name
 *  step ids, input paths, and PII KINDS — never data values: everything in
 *  them comes from the recipe's own structure and the static trace, so the
 *  summary is safe on any channel.
 *
 *  The summary RECLASSIFIES the validator's findings against what the § 7
 *  dispatch seam will actually do at run time: an identifier-leak warning
 *  whose step auto-protection covers becomes a positive `auto_protected`
 *  line (rendering the raw warning beside a live auto-fix would teach
 *  users/models to "fix" steps that are already covered); a residual leak
 *  keeps its warning, suffixed with WHY auto-protection declined. Pure +
 *  deterministic like the applicator itself — same recipe + classifier →
 *  identical summary. */

import type {
  PiiSourceClassifier,
  RecipePiiPostureLine,
  RecipePiiPostureSummary,
} from '@recued/contracts';
import { applyAutoPiiProtection, type AutoPiiResidualOutcome } from './apply-pii.js';
import { validateRecipePii, type PiiIssue } from './validate-pii.js';

export interface SummarizePiiOptions {
  /** False when the dispatch seam will NOT rewrite (the `RECUED_AUTO_PII=off`
   *  operator hatch) — the summary then claims no auto-protection and every
   *  identifier leak stays a warning. Default true. */
  autoProtection?: boolean;
}

const aiSteps = (n: number): string => `${n} AI step${n === 1 ? '' : 's'}`;

/** `path (kind)` pairs, sorted for determinism (object key order is
 *  insertion order upstream; sorting keeps the line stable across
 *  structurally-equal recipes). */
const fieldList = (fields: Readonly<Record<string, string>>): string =>
  Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, kind]) => `${path} (${kind})`)
    .join(', ');

/** Why auto-protection declined, appended to the residual step's warning so
 *  the author knows the automatic path was tried. Keyed by the applicator's
 *  typed outcome; `content_only` is absent on purpose (info-grade, never a
 *  warning). */
const RESIDUAL_SUFFIX: Record<Exclude<AutoPiiResidualOutcome, 'content_only'>, string> = {
  no_bracketable_source:
    ' (auto-protection declined: no payload source offers a runtime-walkable tag set)',
  unsupported_position:
    ' (auto-protection declined: the step is not in the sequential steps array)',
  continuity_reference:
    " (auto-protection declined: a context.recipe continuity ref reads this step's prior-run output)",
  self_referential_fail_on:
    " (auto-protection declined: the step's own fail_on reads its output before the restore)",
  declaration_conflict:
    " (auto-injection declined: the step's llm.pii_fields is a dynamic declaration — verify it covers these paths)",
  verification_failed:
    ' (auto-protection was attempted but failed verification and was rolled back)',
};

const toLine = (issue: PiiIssue): RecipePiiPostureLine => ({
  step_id: issue.step_id,
  message: issue.message,
});

/** Build the posture summary one recipe gets at install / save / Kitchen.
 *  Trusts input like the trace itself — run `parseRecipe` first when the
 *  recipe came from outside. The classifier is injected (the server passes
 *  the canonical one); absent → classification-absent sources read clean,
 *  same as the trace. */
export const summarizeRecipePiiPosture = (
  recipe: unknown,
  classifier?: PiiSourceClassifier,
  options?: SummarizePiiOptions,
): RecipePiiPostureSummary => {
  const autoProtection = options?.autoProtection !== false;
  const validation = validateRecipePii(recipe, classifier);

  const application = autoProtection
    ? applyAutoPiiProtection(recipe, classifier)
    : null;

  const autoProtected: RecipePiiPostureLine[] = [];
  const covered = new Set<string>();
  const residualOutcome = new Map<string, Exclude<AutoPiiResidualOutcome, 'content_only'>>();
  if (application) {
    for (const inj of application.injections) {
      covered.add(inj.step_id);
      autoProtected.push({
        step_id: inj.step_id,
        message:
          `AI step '${inj.step_id}' (${inj.slug}): Recued injects llm.pii_fields at run time — `
          + `${fieldList(inj.fields)} aliased before egress.`,
      });
    }
    for (const bracket of application.brackets) {
      covered.add(bracket.step_id);
      const fields = bracket.sources.reduce<Record<string, string>>(
        (acc, s) => Object.assign(acc, s.fields),
        {},
      );
      autoProtected.push({
        step_id: bracket.step_id,
        message:
          `AI step '${bracket.step_id}' (${bracket.slug}): Recued wraps it in a `
          + `pii-protect/pii-restore bracket at run time — ${fieldList(fields)} aliased before egress.`,
      });
    }
    for (const r of application.residual) {
      if (r.outcome !== 'content_only') residualOutcome.set(r.step_id, r.outcome);
    }
  }

  const warnings: RecipePiiPostureLine[] = [];
  const infos: RecipePiiPostureLine[] = [];
  for (const issue of validation.issues) {
    if (issue.severity === 'info') {
      infos.push(toLine(issue));
      continue;
    }
    if (issue.code === 'pii_reaches_llm') {
      if (covered.has(issue.step_id)) continue; // replaced by its auto_protected line
      const outcome = residualOutcome.get(issue.step_id);
      const suffix = outcome !== undefined ? RESIDUAL_SUFFIX[outcome] : '';
      warnings.push({ step_id: issue.step_id, message: `${issue.message}${suffix}` });
      continue;
    }
    warnings.push(toLine(issue)); // pii_declaration_ineffective — auto-PII never fixes it
  }

  // M counts AI steps whose identifier egress STANDS at run time. With the
  // applicator on, that is the non-content residual set; with it off, every
  // identifier-leak warning stands.
  const manualSteps = application
    ? new Set(residualOutcome.keys())
    : new Set(
        validation.issues
          .filter((i) => i.code === 'pii_reaches_llm')
          .map((i) => i.step_id),
      );

  const n = covered.size;
  const m = manualSteps.size;
  const headline =
    n > 0 && m > 0
      ? `Recued will auto-protect ${aiSteps(n)} at run time; ${m} remain${m === 1 ? 's' : ''} manual.`
      : n > 0
        ? `Recued will auto-protect ${aiSteps(n)} at run time.`
        : m > 0
          ? `${aiSteps(m)} send${m === 1 ? 's' : ''} unprotected PII to the model at run time — manual protection needed.`
          : '';

  return { headline, auto_protected: autoProtected, warnings, infos };
};
