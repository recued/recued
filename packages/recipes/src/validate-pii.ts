/** Auto-PII flow validation (design § 7) — the validator surface over
 *  `tracePiiFlow` (@recued/contracts).
 *
 *  Separate from the phase-2 quality checks on purpose: those are derivable
 *  from the recipe JSON alone, while a PII trace is only as good as its
 *  source CLASSIFICATIONS (`MetaField.privacy` over canonical schemas +
 *  curated kernel tables), which the caller injects. The server composes the
 *  real classifier (`createCanonicalPiiSourceClassifier`); research-dev /
 *  Kitchen tooling can pass narrower ones.
 *
 *  One check in here is classifier-INDEPENDENT and always runs:
 *  `pii_declaration_ineffective` — a legacy step-level `pii_fields` entry in
 *  path form (`contacts[].email`, `a.b`). `hash_replace`'s deepReplace
 *  matches BARE key names at any depth (`fields.includes(k)`), so a path-form
 *  entry can never match a key and the author's declared protection is a
 *  silent no-op. Corpus calibration (2026-06-10) found exactly this live:
 *  `deal-handoff-brief-hubspot` declared four `contacts[].*` tags and
 *  egressed full contact PII anyway.
 */

import {
  deriveAutoPiiFieldInjections,
  tracePiiFlow,
} from '@recued/contracts';
import type {
  PiiSourceClassifier,
  RecipePiiTrace,
  AutoPiiInjectionPlan,
} from '@recued/contracts';

export type PiiIssueSeverity = 'warning' | 'info';

export interface PiiIssue {
  severity: PiiIssueSeverity;
  code:
    | 'pii_reaches_llm'
    | 'pii_content_reaches_llm'
    | 'pii_untraced'
    | 'pii_declaration_ineffective';
  /** Step path (`steps[3]` style is not reconstructable from the trace —
   *  the step ID is the stable handle). */
  step_id: string;
  message: string;
}

export interface RecipePiiValidation {
  issues: PiiIssue[];
  /** The underlying trace, for callers that render findings richer than a
   *  message line (Kitchen, install surfaces). */
  trace: RecipePiiTrace;
  /** What auto-injection WOULD add (the § 7 follow-on consumes this; today
   *  it powers the message's "Recued can cover this" hint). */
  injection_plan: AutoPiiInjectionPlan;
}

const formatKinds = (kinds: readonly string[]): string => kinds.join('/');

/** Identifier-segment field-path grammar (`contacts[].email`, `a.b_c`,
 *  `items[].meta.id`). The display gate for authored `pii_fields` strings —
 *  see the codex fold in the path-form check below. */
const SAFE_PATH_FORM_RE = /^[A-Za-z0-9_]+(?:\[\])?(?:\.[A-Za-z0-9_]+(?:\[\])?)*$/;

/** Validate a recipe's PII flow. Trusts input like `tracePiiFlow` — run
 *  `validateRecipe` first for structural correctness. */
export const validateRecipePii = (
  recipe: unknown,
  classifier?: PiiSourceClassifier,
): RecipePiiValidation => {
  const trace = tracePiiFlow(recipe, classifier);
  const injection_plan = deriveAutoPiiFieldInjections(trace);
  const issues: PiiIssue[] = [];

  const injectable = new Set(injection_plan.injections.map((i) => i.step_id));
  const gapReason = new Map(injection_plan.gaps.map((g) => [g.step_id, g.reason]));

  const bracketHint = (stepId: string): string => {
    switch (gapReason.get(stepId)) {
      case 'list_crossing':
        return 'the PII sits inside a nested record list a tag path cannot reach — '
          + 'protect the list itself upstream with a pii-protect / pii-restore bracket';
      case 'unstructured_payload':
        return 'the payload is an interpolated string — protect the structured source '
          + 'fields upstream with a pii-protect / pii-restore bracket, then interpolate the aliased values';
      case 'content_without_identifier_seed':
        return 'only free-text content is tagged and nothing seeds the alias ledger — '
          + 'tag the identifier fields too (a content scan aliases only seeded values)';
      case 'slug_not_contracted':
      default:
        return 'alias upstream with a pii-protect / pii-restore bracket '
          + '(llm.pii_fields is not defined for this payload shape)';
    }
  };

  for (const f of trace.findings) {
    if (f.verdict === 'pii_reaches_llm') {
      const paths = f.uncovered
        .map((u) => `${u.input_key}${u.path ? `.${u.path}` : ''} (${formatKinds(u.kinds)})`)
        .join(', ');
      const hint = injectable.has(f.step_id)
        ? 'declaring llm.pii_fields on these paths (or letting auto-PII inject it) aliases them before egress'
        : bracketHint(f.step_id);
      issues.push({
        severity: 'warning',
        code: 'pii_reaches_llm',
        step_id: f.step_id,
        message:
          `AI step '${f.step_id}' (${f.slug}) receives unprotected PII: ${paths} — ${hint}`,
      });
    } else if (f.verdict === 'content_reaches_llm') {
      issues.push({
        severity: 'info',
        code: 'pii_content_reaches_llm',
        step_id: f.step_id,
        message:
          `AI step '${f.step_id}' (${f.slug}) receives free-text content fields that may mention identifiers — `
          + 'a pii-protect bracket over the structured source fields seeds the ledger so the content scan can alias them',
      });
    }
    if (f.untraced || f.verdict === 'pii_untraced') {
      const reasons = trace.untraced_steps.map((u) => `'${u.step_id}': ${u.reason}`).join('; ');
      issues.push({
        severity: 'info',
        code: 'pii_untraced',
        step_id: f.step_id,
        message:
          `AI step '${f.step_id}' (${f.slug}) PII flow could not be fully traced`
          + (reasons ? ` (${reasons})` : '')
          + ' — verify manually that no PII reaches the model',
      });
    }
  }

  // Classifier-independent: path-form legacy pii_fields entries never match.
  const stepsArrays: unknown[] = [];
  const rec = recipe !== null && typeof recipe === 'object' && !Array.isArray(recipe)
    ? (recipe as Record<string, unknown>)
    : null;
  if (rec) {
    for (const key of ['prefetch_steps', 'steps'] as const) {
      if (Array.isArray(rec[key])) stepsArrays.push(...(rec[key] as unknown[]));
    }
  }
  for (const raw of stepsArrays) {
    const s = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
    if (!s || !Array.isArray(s.pii_fields)) continue;
    const pathForm = s.pii_fields.filter(
      (p): p is string => typeof p === 'string' && /[.[\]]/.test(p),
    );
    if (pathForm.length === 0) continue;
    const stepId = typeof s.id === 'string' ? s.id : '<anonymous>';
    // Codex fold (MED, § 7 surfacing review) — pii_fields entries are
    // free-form authored strings, and these messages reach model-facing
    // surfaces (the MCP saveRecipe result) and the install dialog. Echo an
    // entry ONLY when it parses as a field path (identifier segments +
    // `[]`); anything else — say, a literal value pasted by mistake — is
    // counted, never quoted.
    const displayable = pathForm.filter((p) => SAFE_PATH_FORM_RE.test(p));
    const hiddenCount = pathForm.length - displayable.length;
    const listed = [
      ...displayable,
      ...(hiddenCount > 0
        ? [
            `${hiddenCount} entr${hiddenCount === 1 ? 'y' : 'ies'} not shown `
            + '(not a recognizable field path)',
          ]
        : []),
    ].join(', ');
    const example =
      (displayable[0] ?? '').split(/[.[\]]+/).filter(Boolean).at(-1) ?? 'email';
    issues.push({
      severity: 'warning',
      code: 'pii_declaration_ineffective',
      step_id: stepId,
      message:
        `step '${stepId}' pii_fields entries [${listed}] are path-form — `
        + 'hash_replace matches bare field names at any depth, so these never match anything '
        + `and protect nothing; declare the bare names instead (e.g. '${example}')`,
    });
  }

  return { issues, trace, injection_plan };
};
