/** Phase 2: Quality checks.
 *
 *  Mirrors the Python `quality_precheck` — structural/mechanical
 *  hygiene checks that don't require semantic understanding.
 *  Everything here is derivable from the recipe JSON alone.
 *
 *  Runs AFTER Phase 1, so required-field presence has already been
 *  flagged. Non-error phase-1 issues don't block phase-2 from running
 *  — we still want orphan / hygiene hints even on a partially broken
 *  recipe.
 */

import { isEntityFieldPrivacy, stripCorePrefix } from '@recued/contracts';
import { canonicalJsonString } from '../canonical.js';
import {
  CURRENCY_FIELD_HINTS,
  DATE_FIELD_HINTS,
  PII_FIELD_HINTS,
  PLACEHOLDER_IDS,
  TTL_FLOOR_AI,
  TTL_FLOOR_DATA,
} from './constants.js';
import type { AddFn } from './helpers.js';

export const validateQualityChecks = (r: Record<string, unknown>, add: AddFn): void => {
  const prefetch = Array.isArray(r.prefetch_steps)
    ? (r.prefetch_steps as Array<Record<string, unknown>>)
    : [];
  const steps = Array.isArray(r.steps)
    ? (r.steps as Array<Record<string, unknown>>)
    : [];
  const output = (r.output && typeof r.output === 'object' && !Array.isArray(r.output))
    ? (r.output as Record<string, unknown>)
    : {};

  const aiStepIndices: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const ing = steps[i]?.ingredient;
    // §5 — recognize the `core-ai-*` kernel aliases as AI steps too (same quality
    // checks: guard-before-AI, etc.).
    if (typeof ing === 'string' && stripCorePrefix(ing).startsWith('ai-')) aiStepIndices.push(i);
  }

  checkOrphanPrefetch(prefetch, steps, output, add);
  checkOrphanSteps(steps, output, add);
  checkGuardBeforeAi(steps, aiStepIndices, add);
  checkHashPairing(steps, aiStepIndices, add);
  checkPiiAliasing(steps, aiStepIndices, add);
  checkUnguardedDivision(steps, add);
  checkTtlFloor(r, aiStepIndices, add);
  checkPlaceholderIds(prefetch, steps, add);
  checkOutputDeterminism(output, add);
  checkNoopTransforms(steps, add);
  checkAiPromptSpecificity(steps, add);
  checkFormatHints(steps, add);
  detectDuplicateStepContent(prefetch, 'prefetch_steps', add);
  detectDuplicateStepContent(steps, 'steps', add);
};

type StepArr = Array<Record<string, unknown>>;

const outputSections = (output: Record<string, unknown>): StepArr =>
  Array.isArray(output.render)
    ? (output.render as StepArr)
    : Array.isArray(output.sidebar)
      ? (output.sidebar as StepArr)
      : [];

const checkOrphanPrefetch = (prefetch: StepArr, steps: StepArr, output: Record<string, unknown>, add: AddFn): void => {
  const downstreamJson = JSON.stringify(steps) + JSON.stringify(output);
  for (const ps of prefetch) {
    const pid = ps?.id;
    if (typeof pid !== 'string' || !pid) continue;
    if (!downstreamJson.includes(`step.${pid}`)) {
      add('info', 'orphan_prefetch', 'prefetch_steps',
        `prefetch '${pid}' output is never referenced by any step or output`);
    }
  }
};

const checkOrphanSteps = (steps: StepArr, output: Record<string, unknown>, add: AddFn): void => {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const sid = s?.id;
    if (typeof sid !== 'string' || !sid) continue;
    if ('guard' in s) continue;
    const rest = JSON.stringify(steps.slice(i + 1)) + JSON.stringify(output);
    // A `defaults` step is referenced through its HOISTED FIELD NAMES, never
    // through its own id: the step-runner publishes each field into
    // `stores.step` so `{{step.<field>}}` keeps resolving after N `default`
    // steps fold into one. Checking only `step.<sid>` reported every folded
    // step as an orphan — a warning that is exactly backwards, since those are
    // the most-referenced steps in the recipe.
    const names = [sid];
    const f = (s as { transform?: string; fields?: unknown }).transform === 'defaults'
      ? (s as { fields?: unknown }).fields : undefined;
    if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
      names.push(...Object.keys(f as Record<string, unknown>));
    }
    if (!names.some((n) => rest.includes(`step.${n}`))) {
      add('info', 'orphan_step', `steps[${i}]`,
        `step '${sid}' output is not referenced downstream or in output`);
    }
  }
};

const checkGuardBeforeAi = (steps: StepArr, aiStepIndices: number[], add: AddFn): void => {
  for (const aiIdx of aiStepIndices) {
    const aiStep = steps[aiIdx];
    const hasSkip = aiStep.skip_when !== undefined && aiStep.skip_when !== null;
    const hasPriorGuard = steps.slice(0, aiIdx).some((s) => 'guard' in s);
    if (!hasSkip && !hasPriorGuard) {
      add('info', 'no_guard_before_ai', `steps[${aiIdx}]`,
        `AI step '${aiStep.id}' has no guard or skip_when — runs even on empty data`);
    }
  }
};

const checkHashPairing = (steps: StepArr, aiStepIndices: number[], add: AddFn): void => {
  const hasReplace = steps.some((s) => s.transform === 'hash_replace');
  const hasRestore = steps.some((s) => s.transform === 'hash_restore');
  const hasPiiFields = steps.some((s) => Array.isArray(s.pii_fields) && (s.pii_fields as unknown[]).length > 0);
  if (aiStepIndices.length > 0 && !hasReplace && !hasPiiFields) {
    add('info', 'no_hash_before_ai', 'steps',
      'recipe has AI steps but no hash_replace or pii_fields — verify no PII is sent to LLM');
  }
  if (hasReplace && !hasRestore) {
    add('warn', 'missing_hash_restore', 'steps',
      'hash_replace used but no hash_restore — output may contain hashed tokens');
  }
};

/** D-167 P4 surfacing — two nudges toward the reversible PII alias transforms:
 *
 *   1. `prefer_pii_protect` (info) — a `hash_replace` step in an AI recipe whose
 *      fields read as aliasable PII (email / name / phone / …). `pii-protect`
 *      is the better tool there: the LLM gets typed aliases it can reason over
 *      (`pii.Person1`, `m1@d1.invalid`), not opaque hash tokens. Gated on AI
 *      presence so it never fires on a `hash_replace` used as a stable
 *      pseudonym key with no LLM round-trip — `pii-protect`'s run-local ledger
 *      would be the wrong call there. `content`-shaped blobs have no
 *      field-name signature, so they stay on `hash_replace` untouched.
 *   2. `missing_pii_restore` (warn) — `pii-protect` without a matching
 *      `pii-restore`. The engine auto-restores the final output before it
 *      reaches the user (D-167 Slice 3), so this is no longer an output-leak
 *      hole; it stays a warn because any MID-RUN egress (a notify, a durable
 *      write, another channel) reached before the run ends still surfaces the
 *      alias tokens — an explicit `pii-restore` ahead of those steps is clearer
 *      and covers them.
 *   3. `pii_protect_bad_field_tag` (error) — a `pii-protect` field tag the alias
 *      substrate can't honor (not a `{ path, kind }` object, empty path, or
 *      `kind` outside the 9-kind enum). The author thinks that field is
 *      protected; it isn't, so its real value would reach the LLM. This is a
 *      hard error (blocks the recipe), matching the runtime: `pii-protect`
 *      throws on the same condition (D-167 safe-feature rule — fail closed,
 *      never silently leave PII un-aliased). */
const checkPiiAliasing = (steps: StepArr, aiStepIndices: number[], add: AddFn): void => {
  if (aiStepIndices.length > 0) {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.transform !== 'hash_replace' || !Array.isArray(s.fields)) continue;
      const piiField = (s.fields as unknown[]).find(
        (f) => typeof f === 'string' && fieldLooksLikePii(f),
      );
      if (typeof piiField === 'string') {
        add('info', 'prefer_pii_protect', `steps[${i}]`,
          `step '${s.id}' hash_replaces '${piiField}', which looks like aliasable PII — consider pii-protect, which hands the LLM typed aliases (pii.Person1, m1@d1.invalid) it can reason over instead of opaque hash tokens`);
      }
    }
  }

  const hasProtect = steps.some((s) => s.transform === 'pii-protect');
  const hasRestore = steps.some((s) => s.transform === 'pii-restore');
  if (hasProtect && !hasRestore) {
    add('warn', 'missing_pii_restore', 'steps',
      'pii-protect used but no pii-restore — the engine restores the final output, but alias tokens (pii.Person1, m1@d1.invalid) still reach any mid-run egress (notify, durable write); add pii-restore before those steps');
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.transform !== 'pii-protect' || !Array.isArray(s.fields)) continue;
    const fields = s.fields as unknown[];
    for (let j = 0; j < fields.length; j++) {
      const problem = piiFieldTagProblem(fields[j]);
      if (problem) {
        add('error', 'pii_protect_bad_field_tag', `steps[${i}].fields[${j}]`,
          `pii-protect field tag #${j} ${problem} — that field would NOT be aliased and its real value would reach the LLM; pii-protect rejects this at run time (fail closed), so fix or remove the tag`);
      }
    }
  }
};

/** Mirrors the drop conditions of the alias substrate's `normalizeFields`
 *  (packages/transforms/src/pii-transforms.ts): a `pii-protect` field tag is
 *  silently discarded unless it is a `{ path, kind }` object with a non-empty
 *  string `path` and a `kind` in the 9-kind EntityFieldPrivacy enum. Returns a
 *  human-readable reason when the tag would be dropped, else null. */
const piiFieldTagProblem = (tag: unknown): string | null => {
  if (!tag || typeof tag !== 'object' || Array.isArray(tag)) {
    return 'is not a { path, kind } object';
  }
  const t = tag as { path?: unknown; kind?: unknown };
  if (typeof t.path !== 'string' || t.path.length === 0) {
    return "has no non-empty 'path' string";
  }
  if (!isEntityFieldPrivacy(t.kind)) {
    return `has kind ${JSON.stringify(t.kind)} outside the privacy kinds (email/name/org/phone/address/url/external_id/account_id/content)`;
  }
  return null;
};

/** True if a `hash_replace` field path's last segment reads as one of the
 *  aliasable D-167 PII kinds. camelCase is folded to `_` first so CRM-derived
 *  fields (`ownerName`, `contactEmail`, `phoneNumber`) match the same roots as
 *  their snake_case forms. Affix-tolerant (`contact.email`, `owner_name`,
 *  `work_phone`) but boundary-aware via the `<root>_` / `_<root>` rule, so a
 *  `username` / `filename` field doesn't trip the `name` hint. Only the last
 *  dot segment is tested — checking every segment would over-fire on shapes
 *  like `name.length` / `url_count`, and a missed nudge is cheaper than a
 *  wrong one for an info hint. */
const fieldLooksLikePii = (path: string): boolean => {
  const last = path.split('.').pop() ?? '';
  // ownerName → owner_name, so the affix rule below sees the same boundaries
  // a snake_case author would have written.
  const seg = last.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (!seg) return false;
  return PII_FIELD_HINTS.some(
    (h) => seg === h || seg.endsWith(`_${h}`) || seg.startsWith(`${h}_`),
  );
};

const checkUnguardedDivision = (steps: StepArr, add: AddFn): void => {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.transform !== 'math') continue;
    // Expression mode handles division internally (returns null on /0)
    if (s.expression != null) continue;
    if ((s.operator ?? s.operation) !== 'divide') continue;
    if (s.skip_when === undefined || s.skip_when === null) {
      add('warn', 'unguarded_division', `steps[${i}]`,
        `step '${s.id}' divides without zero guard (skip_when)`);
    }
  }
};

const checkTtlFloor = (r: Record<string, unknown>, aiStepIndices: number[], add: AddFn): void => {
  if (typeof r.ttl !== 'number' || !Number.isFinite(r.ttl)) return;
  const hasAi = aiStepIndices.length > 0;
  const floor = hasAi ? TTL_FLOOR_AI : TTL_FLOOR_DATA;
  if (r.ttl < floor) {
    add('info', 'ttl_below_floor', 'ttl',
      `ttl ${r.ttl}s is below the ${hasAi ? 'AI' : 'data'} recipe floor of ${floor}s — cache hits will be rare`);
  }
};

const checkPlaceholderIds = (prefetch: StepArr, steps: StepArr, add: AddFn): void => {
  for (let i = 0; i < prefetch.length; i++) {
    const pid = prefetch[i]?.id;
    if (typeof pid === 'string' && PLACEHOLDER_IDS.has(pid.toLowerCase())) {
      add('info', 'placeholder_id', `prefetch_steps[${i}].id`,
        `prefetch id '${pid}' looks like a placeholder name`);
    }
  }
  for (let i = 0; i < steps.length; i++) {
    const sid = steps[i]?.id;
    if (typeof sid === 'string' && PLACEHOLDER_IDS.has(sid.toLowerCase())) {
      add('info', 'placeholder_id', `steps[${i}].id`,
        `step id '${sid}' looks like a placeholder name`);
    }
  }
};

const checkOutputDeterminism = (output: Record<string, unknown>, add: AddFn): void => {
  const sections = outputSections(output);
  if (sections.length > 0 && sections.every((s) => s?.type === 'ai_analysis')) {
    add('warn', 'no_deterministic_output',
      Array.isArray(output.render) ? 'output.render' : 'output.sidebar',
      'all render sections are ai_analysis — recipe renders nothing when AI is disabled or errors');
  }
};

const checkNoopTransforms = (steps: StepArr, add: AddFn): void => {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.transform === 'hash_replace' && (!Array.isArray(s.fields) || (s.fields as unknown[]).length === 0)) {
      add('warn', 'empty_hash_replace', `steps[${i}]`,
        `step '${s.id}' is hash_replace with no fields — no-op, remove it`);
    }
    if (s.transform === 'pick' && typeof s.source !== 'string' && (!Array.isArray(s.keys) || (s.keys as unknown[]).length === 0)) {
      add('warn', 'empty_pick', `steps[${i}]`,
        `step '${s.id}' is pick with no source or keys — no-op, remove it`);
    }
  }
};

const checkAiPromptSpecificity = (steps: StepArr, add: AddFn): void => {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.ingredient !== 'ai-prompt') continue;
    const input = (s.input && typeof s.input === 'object' && !Array.isArray(s.input))
      ? (s.input as Record<string, unknown>) : {};
    const sysPrompt = input['llm.system_prompt'];
    if (typeof sysPrompt !== 'string' || sysPrompt.length === 0) {
      add('warn', 'ai_prompt_missing_system', `steps[${i}].input['llm.system_prompt']`,
        `step '${s.id}' is ai-prompt but has no llm.system_prompt`);
    } else if (sysPrompt.length < 80) {
      add('info', 'ai_prompt_vague', `steps[${i}].input['llm.system_prompt']`,
        `step '${s.id}' ai-prompt system_prompt is ${sysPrompt.length} chars — be specific`);
    }
  }
};

const checkFormatHints = (steps: StepArr, add: AddFn): void => {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.transform !== 'to_table') continue;
    const cols = s.columns;
    if (!Array.isArray(cols)) continue;
    for (let c = 0; c < (cols as unknown[]).length; c++) {
      const col = (cols as unknown[])[c];
      if (!col || typeof col !== 'object') continue;
      const colRec = col as Record<string, unknown>;
      if (colRec.type === 'action') continue;
      const field = typeof colRec.field === 'string' ? colRec.field.toLowerCase() : '';
      if (colRec.format !== undefined && colRec.format !== null && colRec.format !== '') continue;
      if (!field) continue;
      if (CURRENCY_FIELD_HINTS.some((h) => field.includes(h))) {
        add('info', 'format_hint_missing_currency', `steps[${i}].columns[${c}]`,
          `to_table column '${colRec.field}' in step '${s.id}' looks like currency but has no format hint`);
      } else if (DATE_FIELD_HINTS.some((d) => field === d || field.endsWith(`_${d}`))) {
        add('info', 'format_hint_missing_date', `steps[${i}].columns[${c}]`,
          `to_table column '${colRec.field}' in step '${s.id}' looks like a date but has no format hint`);
      }
    }
  }
};

/** Scan a step array for two steps with byte-identical content (minus the
 *  id field). Reports the second occurrence as a warning, referencing the
 *  first. Uses canonicalJsonString so different key orderings still match. */
const detectDuplicateStepContent = (
  stepArr: Array<Record<string, unknown>>,
  pathRoot: 'prefetch_steps' | 'steps',
  add: AddFn,
): void => {
  const seen = new Map<string, { id: string; index: number }>();
  for (let i = 0; i < stepArr.length; i++) {
    const s = stepArr[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const id = s.id;
    if (typeof id !== 'string' || !id) continue;
    const { id: _id, ...rest } = s;
    const body = canonicalJsonString(rest);
    const prior = seen.get(body);
    if (prior) {
      add('warn', 'duplicate_step_content', `${pathRoot}[${i}]`,
        `step '${id}' has identical content to step '${prior.id}' (${pathRoot}[${prior.index}]) — one of them is dead weight`);
    } else {
      seen.set(body, { id, index: i });
    }
  }
};
