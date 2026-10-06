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

import { isEntityFieldPrivacy } from '@recued/contracts';
import { canonicalJsonString } from '../canonical.js';
import {
  CURRENCY_FIELD_HINTS,
  DATE_FIELD_HINTS,
  PII_FIELD_HINTS,
  PLACEHOLDER_IDS,
  TTL_FLOOR_AI,
  TTL_FLOOR_DATA,
} from './constants.js';
import type { RecipeDefinition } from '@recued/contracts';
import { guardRequiredVariables } from '../chat-catalog.js';
import { declaresPiiHandling, NO_PII_DECLARATION_DETAIL } from '../pii-declaration.js';
import { aiStepDispatch } from '../step-dispatch.js';
import { parseStepRef } from './helpers.js';
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

  checkConfidenceZeroAnchor(steps, add, 'steps');
  checkConfidenceZeroAnchor(prefetch, add, 'prefetch_steps');

  // An AI step in either form: `ingredient: "ai-*"` (or a `core-ai-*` alias) or
  // `op: "core.ai.*"`, which is how every shipped recipe writes one.
  const aiStepIndices: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (aiStepDispatch(steps[i]) !== undefined) aiStepIndices.push(i);
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
  checkOptionalButRequired(r, prefetch, steps, add);
  checkListWithoutRowAction(steps, output, add);
  checkListPagingUnreachable(r, output, add);
};

/** A variable whose EMPTY default is now overridden by the guard — reported so
 *  the author can drop the dead default, not because the model is misled.
 *
 *  🔑 THE SCHEMA NO LONGER LIES. `deriveTier2ArgSchema` unions
 *  {@link guardRequiredVariables} into `required`, so a guarded variable reaches
 *  the model as REQUIRED whatever its declaration says — the guard is the
 *  authority, because it is the thing that enforces. This warning is therefore
 *  hygiene rather than a defect report: the `default: ''` is now inert for AI
 *  callers and merely misleads a human reading the recipe.
 *
 *  ⚠ It still matters for the FORM. A human surface reads the declaration, not
 *  the projection, so a dead default there still renders a field that looks
 *  optional and then fails on submit.
 *
 *  ⚠ Shares `guardRequiredVariables` with the projection rather than restating
 *  it — two copies of "what the guard requires" is how a schema and its warning
 *  come to disagree. */
const checkOptionalButRequired = (
  r: Record<string, unknown>,
  _prefetch: StepArr,
  _steps: StepArr,
  add: AddFn,
): void => {
  const vars = (r.variables && typeof r.variables === 'object' && !Array.isArray(r.variables))
    ? (r.variables as Record<string, unknown>)
    : {};
  const guardRequired = guardRequiredVariables(r as unknown as RecipeDefinition);
  for (const key of guardRequired) {
    const def = vars[key];
    const empty = (def !== null && typeof def === 'object' && !Array.isArray(def))
      ? ('default' in (def as Record<string, unknown>)
        && ((def as Record<string, unknown>).default === ''
          || (def as Record<string, unknown>).default === null))
      : (def === '' || def === null);
    if (!empty) continue;
    add(
      'warn',
      'variable_optional_but_required',
      `variables.${key}`,
      `'${key}' declares an EMPTY default, but a guard refuses the run without it. `
      + 'The AI-facing schema now marks it required from the guard, so the default '
      + 'is dead there — but a human form still reads the declaration and will '
      + 'render an optional-looking field that fails on submit. Drop the default.',
    );
  }
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
  if (aiStepIndices.length > 0 && !declaresPiiHandling(steps)) {
    add('info', 'no_hash_before_ai', 'steps', NO_PII_DECLARATION_DETAIL);
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
 *      `pii-restore`. The engine auto-restores what the run hands on when it
 *      ends — its rendered output (D-167 Slice 3) and, since 2026-10-06, an
 *      `output.exchange` it fires (`buildExchangeFirePayload`) — so neither is
 *      an output-leak hole; it stays a warn because any MID-RUN egress (a notify, a durable
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
      'pii-protect used but no pii-restore — the engine restores what the run renders, and what it fires as an exchange, when it ends; alias tokens (pii.Person1, m1@d1.invalid) still reach any step before then that sends or stores data (notify, durable write) — add pii-restore before those steps');
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
    const call = aiStepDispatch(s);
    if (call?.slug !== 'ai-prompt') continue;
    // The step's own spelling: `ai-prompt`, or `core.ai.prompt` for an op step.
    const name = typeof s.op === 'string' ? s.op : String(s.ingredient);
    const at = `steps[${i}].${call.payloadKey}['llm.system_prompt']`;
    const sysPrompt = call.payload['llm.system_prompt'];
    if (typeof sysPrompt !== 'string' || sysPrompt.length === 0) {
      add('warn', 'ai_prompt_missing_system', at,
        `step '${s.id}' is ${name} but has no llm.system_prompt`);
    } else if (sysPrompt.length < 80) {
      add('info', 'ai_prompt_vague', at,
        `step '${s.id}' ${name} system_prompt is ${sysPrompt.length} chars — be specific`);
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

/** D-278 — a self-rated confidence with no ZERO-ANCHOR does not discriminate.
 *
 *  ⛔⛔ MEASURED, NOT REASONED. `meeting-notes-to-action`'s shipped contract
 *  says only *"Return extraction_confidence as a number from 0 to 1"*. Held
 *  everything else constant — same model, same fields, same four inputs — and
 *  varied ONE sentence:
 *
 *      shipped (range only)  distinct [0.85, 0.9, 0.95]  separation -0.037
 *                            8/8 cleared the 0.7 floor, INCLUDING 4/4 inputs
 *                            with no decision and no action in them
 *      + "Use 0 when the      distinct [0, 0.9]           separation +0.900
 *        notes record no      0/4 of those same inputs cleared the floor
 *        decision and no
 *        next action."
 *
 *  The same bimodal shape appears in `track-warranty-from-receipt`, the one
 *  shipped gate measured to work (1.0 real / 0.0 non-warranty) — and it is the
 *  one whose prose says *"Use 0 when the body states no warranty length."*
 *
 *  🔑 THE VARIABLE IS THE ANCHOR, NOT THE DESCRIPTION. Recipes whose
 *  confidence field carries a paragraph of description but no "return 0 when
 *  …" measured no better than ones with a bare invented key: without a case
 *  the model is told to score zero, it narrates 0.85-0.95 for everything and
 *  any floor beneath that passes all of it.
 *
 *  ⚠ THE PROSE MATCH IS A HEURISTIC AND THIS IS A `warn`. It reads the field
 *  descriptions and `llm.data` for an anchor phrase; a differently-worded one
 *  will be missed, and an anchor for a DIFFERENT field will be credited to
 *  this one. It is a prompt for the author, never a proof. */
const ZERO_ANCHOR = /(use|return|set|give)\s+[^.]{0,40}\b0\b[^.]{0,20}\bwhen\b|confidence\s+0\s+when|\b0\s+when\b/i;

const checkConfidenceZeroAnchor = (steps: StepArr, add: AddFn, pathRoot: string): void => {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const args = (s?.args && typeof s.args === 'object' && !Array.isArray(s.args))
      ? (s.args as Record<string, unknown>)
      : (s?.input && typeof s.input === 'object' && !Array.isArray(s.input))
        ? (s.input as Record<string, unknown>)
        : {};
    const fields = args['llm.fields'];
    if (!Array.isArray(fields)) continue;

    const named: string[] = [];
    let prose = typeof args['llm.data'] === 'string' ? (args['llm.data'] as string) : '';
    for (const f of fields) {
      if (typeof f === 'string') {
        if (/confidence/i.test(f)) named.push(f);
      } else if (f && typeof f === 'object') {
        const name = (f as { name?: unknown }).name;
        const desc = (f as { description?: unknown }).description;
        if (typeof desc === 'string') prose += ` ${desc}`;
        if (typeof name === 'string' && /confidence/i.test(name)) named.push(name);
      }
    }
    if (named.length === 0) continue;
    if (ZERO_ANCHOR.test(prose)) continue;

    add('warn', 'confidence_without_zero_anchor', `${pathRoot}[${i}].args['llm.fields']`,
      `step '${String(s?.id ?? i)}' asks the model for ${named.length === 1 ? `'${named[0]}'` : `${named.length} confidence fields`}`
      + ' but never tells it when to answer 0 — measured, a self-rating with no zero-anchor'
      + ' clusters at 0.85-0.95 for every input and any floor beneath it passes all of them.'
      + ' Add one sentence naming the case that scores zero (see track-warranty-from-receipt).');
  }
};

/** D-282 A2 — a list you can look at and cannot act on.
 *
 *  Measured 2026-09-20 over `community/`: 269 packs render a list or a detail
 *  and **11** of them carry a single row action. 827 recipes render a `table`
 *  or `record_fields`; 51 emit any `recipe.run` at all. The substrate for
 *  list -> detail has been shipped and reachable the whole time (D-195 actions,
 *  the result panel's row-action -> detail -> return-and-refresh loop); what is
 *  missing is that nothing makes it the default and nothing notices its
 *  absence. This is the noticing.
 *
 *  ⚠ IT FIRES ONLY WHERE THE LIST SAYS IT IS OVER OPENABLE THINGS — the block
 *  declares an `entity`, or the `to_table` step names an id-ish column. A table
 *  of aggregates (`to_summary` rollups, a count by week) has no row to open and
 *  must not be nagged about one; the whole value of the hint is that an author
 *  who sees it is looking at a row they could have opened.
 *
 *  ⛔ `info`, NEVER an error. 363 shipped recipes match today. An error turns
 *  the corpus red on the day it lands, gets suppressed, and then catches
 *  nothing; the point is the NEXT author's default, and a progress measure for
 *  the D-282 A1 regeneration. */
const ID_ISH = /(^id$|_id$|_ref$|^ref$)/;

const checkListWithoutRowAction = (
  steps: StepArr,
  output: Record<string, unknown>,
  add: AddFn,
): void => {
  const sections = outputSections(output);
  const byId = new Map<string, Record<string, unknown>>();
  for (const s of steps) {
    if (typeof s?.id === 'string') byId.set(s.id, s);
  }
  const renderPath = Array.isArray(output.render) ? 'output.render' : 'output.sidebar';

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (section?.type !== 'table') continue;

    // The table's columns come from the `to_table` step it renders, from the
    // entity schema, or from both. Only the step half is readable here — the
    // entity schema lives on the installed pack manifest, not in the recipe —
    // so `entity` is taken as its own evidence that the rows are records.
    const source = typeof section.source === 'string' ? section.source : '';
    const stepId = parseStepRef(source);
    const step = stepId === null ? undefined : byId.get(stepId);
    const columns = Array.isArray(step?.columns) ? step.columns as unknown[] : [];

    const hasActionColumn = columns.some((c) =>
      c !== null && typeof c === 'object'
      && (c as Record<string, unknown>).type === 'action');
    if (hasActionColumn) continue;

    // ⛔ A SELECTABLE TABLE IS ALREADY ACTIONABLE, and this hint's own sentence
    // ("offers no way to act on one") is FALSE there. D-282 B6 added `select`
    // AFTER this rule, so the rule went on nagging every author who used the
    // new facet correctly — including the first recipe that shipped with it.
    // ⚠ A row action and a selection are different gestures, not substitutes:
    // one opens a record, the other acts on a set. Either answers "can I do
    // anything with these rows", which is all this hint asks.
    if (section.select !== undefined) continue;

    const namesAnId = columns.some((c) => {
      if (c === null || typeof c !== 'object') return false;
      const field = (c as Record<string, unknown>).field;
      return typeof field === 'string' && ID_ISH.test(field);
    });
    if (typeof section.entity !== 'string' && !namesAnId) continue;

    add('info', 'table_without_row_action', `${renderPath}[${i}]`,
      'this table renders rows that identify a record and offers no way to act on one'
      + ' — add an `actions` column (`{ field: "actions", type: "action" }`) whose cells'
      + ' carry a `recipe.run` descriptor, and the row opens a detail recipe in the'
      + ' result panel. See community/recipes/list-buildings.json.');
  }
};

/** D-282 A2 — a row cap the owner cannot page past.
 *
 *  `filter` (D-222) is the ONLY surface that reaches a recipe's `cursor`: the
 *  Next/Previous controls bind to the descriptor's hidden carrier
 *  (`outputFilterPageConfig` writes `config.cursor`), so a recipe that declares
 *  a cap or a cursor and renders no `filter` has paging that exists and cannot
 *  be operated. The list silently stops at the cap, and nothing on the page
 *  says there is more.
 *
 *  🔑 IT IS ONE RULE COVERING BOTH DIRECTIONS ON PURPOSE. Measured: 48 recipes
 *  declare `limit` with neither a `cursor` nor a `filter`; **0** declare
 *  `cursor` without a `filter`. The second half is therefore a RATCHET over a
 *  currently-true invariant rather than a finding — which is exactly what it is
 *  for, because the D-282 A1 emitter adds `cursor` to recipes mechanically and
 *  the failure it could introduce is dropping the `filter` that reaches it. */
const checkListPagingUnreachable = (
  r: Record<string, unknown>,
  output: Record<string, unknown>,
  add: AddFn,
): void => {
  const variables = (r.variables && typeof r.variables === 'object' && !Array.isArray(r.variables))
    ? (r.variables as Record<string, unknown>)
    : {};
  const declared = ['cursor', 'limit'].filter((key) =>
    Object.prototype.hasOwnProperty.call(variables, key));
  if (declared.length === 0) return;

  const sections = outputSections(output);
  const rendersAList = sections.some((s) =>
    s?.type === 'table' || s?.type === 'record_fields');
  if (!rendersAList) return;
  if (sections.some((s) => s?.type === 'filter')) return;

  add('info', 'list_paging_unreachable',
    Array.isArray(output.render) ? 'output.render' : 'output.sidebar',
    `this recipe declares ${declared.map((k) => `\`${k}\``).join(' and ')} but renders no`
    + ' `filter` block, and `filter` is the only surface that reaches them — the list stops'
    + ' at the cap with nothing on the page saying there is more. Add'
    + ' `{ type: "filter", fields: [...], hidden: ["limit", "cursor"], submit: "Search" }`.');
};
