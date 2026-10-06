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
 *  `pii_declaration_names_content` — a legacy bare-name entry covering a field
 *  the classifier calls free text (`content`), by naming it or a field above it.
 *  The step-level hash swaps every value under the name for a token, so the model
 *  gets tokens in place of the text; it hides nothing INSIDE text, which is what
 *  the `content` tag does.
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
  PII_LIST_SEGMENT,
  deriveAutoPiiFieldInjections,
  isBatchCapableAISlug,
  tracePiiFlow,
} from '@recued/contracts';
import type {
  PiiEgressFinding,
  PiiLegacyContentPath,
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
    | 'pii_declaration_ineffective'
    | 'pii_declaration_names_content';
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

/** The `llm.pii_fields` path that would tag this content path, or null where no tag
 *  can reach it — the same walk the trace credits a tag with: `llm.data` only, no
 *  `[]` crossing, except the item-relative paths of an authored batch call. */
const contentTagPath = (c: PiiLegacyContentPath, f: PiiEgressFinding): string | null => {
  if (c.input_key !== 'llm.data') return null;
  const segs = c.path.split('.');
  const isBatchPath = segs[0] === PII_LIST_SEGMENT;
  if (isBatchPath && !f.declared.batch) return null;
  const tagPath = isBatchPath ? segs.slice(1).join('.') : c.path;
  return tagPath !== '' && !tagPath.split('.').includes(PII_LIST_SEGMENT) ? tagPath : null;
};

const quoted = (items: readonly string[]): string => items.map((i) => `'${i}'`).join(', ');

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
      // D-316 amendment — a `content` tag hides the contacts the server knows and
      // every email in the text; only the identifiers it does not know need the
      // author's own tags.
      const hint = injectable.has(f.step_id)
        ? 'Recued tags them `content` at run time, which hides the contacts the server knows and every '
          + 'email in them; tag the identifier fields they draw on (llm.pii_fields) to hide the rest'
        : 'a `content` tag in a pii-protect bracket upstream hides the contacts the server knows and every '
          + 'email in them; tag the identifier fields they draw on in that bracket to hide the rest';
      issues.push({
        severity: 'info',
        code: 'pii_content_reaches_llm',
        step_id: f.step_id,
        message:
          `AI step '${f.step_id}' (${f.slug}) receives free-text content fields that may mention identifiers — ${hint}`,
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

  // A legacy bare-name entry over free text. The trace credits it as cover, but the
  // step-level hash hides nothing INSIDE text: the text goes as a token the model
  // cannot read, so the step's AI work has nothing to read. The content tag is what
  // hides the identifiers in text.
  for (const f of trace.findings) {
    if (f.legacy_content.length === 0) continue;
    const entries = [...new Set(f.legacy_content.map((c) => c.entry))].sort();
    const paths = [...new Set(f.legacy_content.map(
      (c) => `${c.input_key}${c.path ? `.${c.path}` : ''}`,
    ))].sort();
    const tagPaths = f.legacy_content.map((c) => contentTagPath(c, f));
    const one = entries.length === 1;
    const fix = isBatchCapableAISlug(f.slug) && tagPaths.every((p) => p !== null)
      ? `tag ${quoted([...new Set(tagPaths as string[])].sort())} \`content\` in llm.pii_fields instead`
      : 'give the text a `content` tag in a pii-protect / pii-restore bracket upstream instead '
        + '(llm.pii_fields does not reach it here)';
    issues.push({
      severity: 'warning',
      code: 'pii_declaration_names_content',
      step_id: f.step_id,
      message:
        `AI step '${f.step_id}' (${f.slug}): pii_fields ${one ? 'entry' : 'entries'} ${quoted(entries)} `
        + `cover${one ? 's' : ''} free text (${paths.join(', ')}) — step-level pii_fields swaps every value `
        + 'under the name for a token, so the model gets a token in place of the text; keep pii_fields to '
        + `identifier fields and ${fix}, which hides the contacts the server knows and every email in the `
        + 'text while the model still reads it',
    });
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
