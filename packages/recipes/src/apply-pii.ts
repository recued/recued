/**
 * § 7 auto-PII APPLICATION (reactive-design § 7 follow-on) — turn the trace's
 * injection plan into a rewritten recipe.
 *
 * Two mechanisms, both reusing the D-167 alias substrate end-to-end:
 *
 *   1. `llm.pii_fields` INJECTION (the plan's `injections`): merge the derived
 *      tag map into the ai-step's input. The executor's own
 *      alias→call→restore round-trip handles everything (single AND batch
 *      mode); downstream steps see real values — fully transparent.
 *
 *   2. BRACKET SYNTHESIS for the plan's gaps that carry an IDENTIFIER-kind
 *      leak: insert the `pii-protect` / `pii-restore` bracket the author
 *      would have written (§ 7: "auto-injects the bracket"). Per tainted
 *      source ref: one `pii-protect` step before the ai-step over exactly
 *      the value the payload reads, the payload refs rewritten into its
 *      `.aliased` output, then one chained `pii-restore` per protect after
 *      the ai-step, and every DOWNSTREAM reference to the ai-step rewired to
 *      the final restore's `.restored` — so later steps observe the same
 *      values they would have seen without the bracket (zero-failure-restore
 *      invariant; restore passes unknown values through verbatim).
 *
 * CONTENT-only findings are deliberately NOT bracketed: a content scan
 * aliases only the identifier kinds seeded by tags in the SAME protect
 * step's run-local ledger, so a content-only bracket is decorative — those
 * findings stay flagged (validate-pii, info severity).
 *
 * "No harm done" is enforced MECHANICALLY, not by hope:
 *   - per-finding verification: after a candidate bracket is applied the
 *     trace re-runs; the bracket is kept only if the target finding's
 *     uncovered identifier set is now empty AND no other finding's verdict
 *     regressed AND no new flow opacity appeared — otherwise it rolls back
 *     and the finding lands in `residual`;
 *   - a final `parseRecipe` gate: if the rewritten recipe carries more
 *     error-severity issues than the original, every bracket rolls back
 *     (injections are re-checked alone, then dropped too if still failing);
 *   - synthesized protect steps cannot introduce runtime failures: their
 *     tags are static `{ path, kind }` literals over the 9-kind enum (the
 *     only `pii-protect` throw path), and protect/restore pass null /
 *     unexpected shapes through unchanged, so a skipped ai-step or an
 *     absent upstream value degrades exactly like the unbracketed recipe.
 *
 * The rewrite is DETERMINISTIC (ids derived from the ai-step id, no
 * clock/randomness), so re-deriving from the same stored recipe + classifier
 * yields byte-identical output — execution-time application is stable across
 * runs, resumes, and held-action identity hashing. It is also IDEMPOTENT by
 * construction: tracing an already-rewritten recipe yields protected
 * verdicts, an empty plan, and `changed: false`.
 *
 * Degrade-to-flag boundaries (each lands in `residual` with an outcome):
 *   - whole-value scalar taint (`{{step.contact_name}}` — the structure was
 *     collapsed upstream; a tag has no path to walk) → `no_bracketable_source`;
 *   - taint across an INTERIOR `[]` boundary of one source (a list nested
 *     inside the selected object; the runtime tag walk crosses at most the
 *     TOP-level list) → `no_bracketable_source`;
 *   - ai-step outside the sequential `steps` array (prefetch/trigger phases
 *     don't guarantee in-array ordering) → `unsupported_position`;
 *   - a `{{context.recipe.<ai_step>}}` prior-run continuity reference
 *     anywhere in the recipe (the engine snapshots the RAW step output —
 *     aliased text whose ledger dies with the run) → `continuity_reference`;
 *   - the ai-step's own `fail_on` reading its own output (it evaluates
 *     BEFORE the restore step) → `self_referential_fail_on`; the same for its
 *     own `stop_when` → `self_referential_stop_when`.
 *
 * Checkpoint pause/resume across the bracket (the former known edge) is
 * CLOSED by the pii-ledger-in-checkpoint substrate: a preflight pause
 * serializes the run's `PiiLedgerStore` onto `Checkpoint.pii_ledgers`, and
 * resume hydrates the fresh process's store from it, so `step.<protect>.
 * ledger_handle` strings carried in `step_state` resolve and the post-ai
 * restore returns REAL values. Shared with authored brackets — one substrate
 * heals both. (Legacy snapshot-free checkpoints keep the old degrade:
 * aliases — never raw PII — pass through downstream.)
 *
 * CONTRACT: trusts input like `tracePiiFlow` — never throws on malformed
 * recipes; run `validateRecipe` first if correctness matters. Pure — no IO.
 */

import {
  ENTITY_FIELD_PRIVACY_KINDS,
  PII_LIST_SEGMENT,
  deriveAutoPiiFieldInjections,
  tracePiiFlow,
} from '@recued/contracts';
import type {
  EntityFieldPrivacy,
  PiiEgressFinding,
  PiiEgressVerdict,
  PiiFieldInjection,
  PiiInjectionGap,
  PiiSourceClassifier,
  RecipeDefinition,
  RecipePiiTrace,
} from '@recued/contracts';
import { parseRecipe } from './parse.js';

/** Not in the contracts barrel yet (shared-file discipline) — indexed off the
 *  exported finding shape instead. */
type PiiEgressSource = PiiEgressFinding['sources'][number];

/* ──────────────── Result shapes ──────────────── */

/** One synthesized protect step: which upstream value it wraps and which
 *  paths it tags (paths are item-relative when the value is a list). */
export interface AppliedPiiBracketSource {
  /** The payload ref the protect wraps (`step.contacts_raw`). */
  ref: string;
  protect_step_id: string;
  /** Tag path → kind, exactly as written into the protect step's `fields`. */
  fields: Readonly<Record<string, EntityFieldPrivacy>>;
}

export interface AppliedPiiBracket {
  /** The ai-step the bracket protects. */
  step_id: string;
  slug: string;
  sources: readonly AppliedPiiBracketSource[];
  /** The chained restore steps (last one is what downstream refs read). */
  restore_step_ids: readonly string[];
}

export type AutoPiiResidualOutcome =
  /** Only `content`-kind taint is uncovered — a bracket would be decorative
   *  (content scans alias only same-step-seeded identifier kinds). */
  | 'content_only'
  /** No payload source ref offers a runtime-walkable identifier tag set
   *  (scalar collapse, interior `[]` crossing, `item.*`-only sources). */
  | 'no_bracketable_source'
  /** The ai-step is not in the sequential `steps` array. */
  | 'unsupported_position'
  /** A `{{context.recipe.<step>}}` continuity ref reads this ai-step's
   *  prior-run output — bracketing would persist un-restorable aliases. */
  | 'continuity_reference'
  /** The ai-step's own `fail_on` reads its own output — that condition
   *  evaluates BEFORE the synthesized restore, so it would observe aliased
   *  echoes where the original observed raw text. */
  | 'self_referential_fail_on'
  /** The same, for the ai-step's own `stop_when`: it too is checked right after
   *  the step, before the restore, and would decide whether the run goes on from
   *  aliased echoes. */
  | 'self_referential_stop_when'
  /** The step declares a non-static `llm.pii_fields` (a `{{ref}}`) the
   *  injection must not clobber. */
  | 'declaration_conflict'
  /** The candidate rewrite failed the re-trace / parse verification gate
   *  and was rolled back. */
  | 'verification_failed';

export interface AutoPiiResidual {
  step_id: string;
  slug: string;
  /** Why `llm.pii_fields` injection could not cover it (the plan's gap).
   *  Absent for injection-side residuals (`declaration_conflict`). */
  gap_reason?: PiiInjectionGap['reason'];
  /** Why bracket synthesis did not cover it either. */
  outcome: AutoPiiResidualOutcome;
}

export interface AutoPiiApplication {
  /** The rewritten recipe — the INPUT object (unchanged, same reference)
   *  when nothing applied; a deep clone otherwise. */
  recipe: RecipeDefinition;
  changed: boolean;
  injections: readonly PiiFieldInjection[];
  brackets: readonly AppliedPiiBracket[];
  residual: readonly AutoPiiResidual[];
  /** The trace of the ORIGINAL recipe (callers surface findings from it). */
  trace: RecipePiiTrace;
}

/* ──────────────── Internals ──────────────── */

type Rec = Record<string, unknown>;

const asRecord = (v: unknown): Rec | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;

/** Recipes are JSON documents — a JSON round-trip is a faithful deep clone
 *  and preserves key order (determinism). */
const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const VERDICT_RANK: Record<PiiEgressVerdict, number> = {
  clean: 0,
  protected_alias: 1,
  protected_declared: 1,
  content_reaches_llm: 2,
  pii_untraced: 3,
  pii_reaches_llm: 4,
};

const hasIdentifierLeak = (f: PiiEgressFinding): boolean =>
  f.uncovered.some((u) => u.kinds.some((k) => k !== 'content'));

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LIST_LEAD = `${PII_LIST_SEGMENT}.`;

/** The exact-ref pattern the engine's resolver matches: `{{ref}}` /
 *  `{{ref:format}}` with optional padding. Capture keeps the format hint. */
const refPattern = (ref: string): RegExp =>
  new RegExp(`\\{\\{\\s*${escapeRegExp(ref)}\\s*(:[a-zA-Z_]+)?\\s*\\}\\}`, 'g');

/** Replace every `{{ref}}` occurrence in a JSON value tree. */
const rewriteRef = (v: unknown, re: RegExp, newRef: string): unknown => {
  if (typeof v === 'string') {
    return v.replace(re, (_m, hint: string | undefined) => `{{${newRef}${hint ?? ''}}}`);
  }
  if (Array.isArray(v)) return v.map((el) => rewriteRef(el, re, newRef));
  const rec = asRecord(v);
  if (rec) {
    const out: Rec = {};
    for (const [k, val] of Object.entries(rec)) out[k] = rewriteRef(val, re, newRef);
    return out;
  }
  return v;
};

/** Rewire every `{{step.<aiId>…}}` reference (any selection, any format
 *  hint, token-boundary safe) onto the restore step's `.restored` view. */
const rewireStepRef = (v: unknown, aiId: string, restoredRef: string): unknown => {
  const re = new RegExp(`\\{\\{(\\s*)step\\.${escapeRegExp(aiId)}(?=[.:\\s}])`, 'g');
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return x.replace(re, (_m, pad: string) => `{{${pad}${restoredRef}`);
    if (Array.isArray(x)) return x.map(walk);
    const rec = asRecord(x);
    if (rec) {
      const out: Rec = {};
      for (const [k, val] of Object.entries(rec)) out[k] = walk(val);
      return out;
    }
    return x;
  };
  return walk(v);
};

const mintId = (base: string, taken: Set<string>): string => {
  let id = base;
  let n = 1;
  while (taken.has(id)) {
    n += 1;
    id = `${base}_${n}`;
  }
  taken.add(id);
  return id;
};

const allStepIds = (recipe: Rec): Set<string> => {
  const ids = new Set<string>();
  for (const key of ['prefetch_steps', 'steps', 'trigger_steps'] as const) {
    const arr = recipe[key];
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      const rec = asRecord(s);
      if (rec && typeof rec.id === 'string') ids.add(rec.id);
    }
  }
  return ids;
};

const findStep = (
  recipe: Rec,
  stepId: string,
): { where: 'prefetch_steps' | 'steps' | 'trigger_steps'; index: number; step: Rec } | null => {
  for (const key of ['prefetch_steps', 'steps', 'trigger_steps'] as const) {
    const arr = recipe[key];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const rec = asRecord(arr[i]);
      if (rec && rec.id === stepId) return { where: key, index: i, step: rec };
    }
  }
  return null;
};

/** Identifier-first kind for a tag path (mirrors the plan derivation). */
const pickKind = (kinds: readonly EntityFieldPrivacy[]): EntityFieldPrivacy =>
  ENTITY_FIELD_PRIVACY_KINDS.find((k) => k !== 'content' && kinds.includes(k))
  ?? 'content';

interface QualifiedSource {
  ref: string;
  input_keys: string[];
  /** Tag path → kind for the protect step (item-relative for lists). */
  fields: Record<string, EntityFieldPrivacy>;
}

/**
 * Decide whether one source ref's taint can be FULLY covered by a single
 * protect step over exactly that ref, and derive its tag set.
 *
 * Runtime reality the shape rules mirror (pii-transforms + pii-alias):
 *   - a top-level ARRAY runs `aliasFieldsBatch` — tag paths are
 *     item-relative, so a profile whose identifier entries all sit under ONE
 *     leading `[].` qualifies with the lead stripped;
 *   - an OBJECT runs `aliasFields` — tag paths walk `getAtPath` exactly and
 *     never cross a `[]` boundary;
 *   - a whole-value entry (`''`) is a scalar/smeared string — no path to tag;
 *   - content paths that fit the same shape ride along (the identifier tags
 *     seed the ledger, so the content scan actually protects them); content
 *     paths that don't fit are dropped silently (decorative either way).
 */
const qualifySource = (sources: readonly PiiEgressSource[]): QualifiedSource | null => {
  const first = sources[0];
  if (first === undefined) return null;
  const ref = first.ref;
  if (!ref.startsWith('step.')) return null; // item./config. — nothing to wrap
  // Union the profile across (input_key, ref) entries — refTaint is
  // deterministic so they agree; the union is belt-and-braces.
  const merged = new Map<string, Set<EntityFieldPrivacy>>();
  for (const s of sources) {
    for (const [p, kinds] of Object.entries(s.profile)) {
      let into = merged.get(p);
      if (!into) {
        into = new Set();
        merged.set(p, into);
      }
      for (const k of kinds) into.add(k);
    }
  }
  const identifierPaths = [...merged].filter(([, k]) => [...k].some((x) => x !== 'content'));
  if (identifierPaths.length === 0) return null; // content-only source
  const isListPath = (p: string): boolean => p.startsWith(LIST_LEAD);
  const listMode = identifierPaths.every(([p]) => isListPath(p));
  const tagPathOf = (p: string): string | null => {
    const rel = listMode && isListPath(p) ? p.slice(LIST_LEAD.length) : p;
    if (rel === '' || rel === PII_LIST_SEGMENT) return null;
    if (listMode !== isListPath(p)) return null; // mixed shape — can't be both
    if (rel.split('.').includes(PII_LIST_SEGMENT)) return null; // interior list
    return rel;
  };
  const fields: Record<string, EntityFieldPrivacy> = {};
  for (const [p, kinds] of identifierPaths) {
    const tag = tagPathOf(p);
    if (tag === null) return null; // an uncoverable identifier path → all-or-nothing
    fields[tag] = pickKind([...kinds]);
  }
  // Content paths ride along when they fit the same shape.
  for (const [p, kinds] of merged) {
    if ([...kinds].some((x) => x !== 'content')) continue;
    const tag = tagPathOf(p);
    if (tag !== null && fields[tag] === undefined) fields[tag] = 'content';
  }
  return { ref, input_keys: [...new Set(sources.map((s) => s.input_key))], fields };
};

/** A `{{context.recipe.<aiId>…}}` prior-run continuity ref anywhere in the
 *  recipe — the engine snapshots the RAW (aliased) step output at run end,
 *  and the alias ledger dies with the run. Token-boundary safe. */
const hasContinuityRef = (recipe: Rec, aiId: string): boolean =>
  new RegExp(`\\{\\{\\s*context\\.recipe\\.${escapeRegExp(aiId)}[.:\\s}]`).test(
    JSON.stringify(recipe),
  );

/** The ai-step's own `fail_on` / `stop_when` referencing its own output
 *  (`{{step.<self>…}}`, string or object condition form) — both run BEFORE the
 *  restore step, so under a bracket they would see aliased echoes. */
const hasSelfReferentialCondition = (
  aiStep: Rec,
  aiId: string,
  field: 'fail_on' | 'stop_when',
): boolean =>
  aiStep[field] !== undefined
  && new RegExp(`\\{\\{\\s*step\\.${escapeRegExp(aiId)}[.:\\s}]`).test(
    JSON.stringify(aiStep[field]),
  );

/** Bare `step.<aiId>[.path]` rewiring for output section sources — the one
 *  recipe surface that holds step paths WITHOUT mustache braces (the engine
 *  wraps `source` itself at render time). Covers canonical `output.render` and
 *  legacy `output.sidebar`. */
const rewireBareSources = (output: unknown, aiId: string, restoredRef: string): unknown => {
  const exact = `step.${aiId}`;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    const rec = asRecord(x);
    if (!rec) return x;
    const out: Rec = {};
    for (const [k, val] of Object.entries(rec)) {
      out[k] =
        k === 'source' && typeof val === 'string'
        && (val === exact || val.startsWith(`${exact}.`))
          ? `${restoredRef}${val.slice(exact.length)}`
          : walk(val);
    }
    return out;
  };
  return walk(output);
};

/** Verification gate: target finding fully identifier-covered, nobody else
 *  regressed, no new flow opacity. */
const verifyBracket = (
  prev: RecipePiiTrace,
  next: RecipePiiTrace,
  targetStepId: string,
): boolean => {
  const target = next.findings.find((f) => f.step_id === targetStepId);
  if (!target || hasIdentifierLeak(target) || target.untraced) return false;
  if (next.untraced_steps.length > prev.untraced_steps.length) return false;
  for (const nf of next.findings) {
    if (nf.step_id === targetStepId) continue;
    const pf = prev.findings.find((f) => f.step_id === nf.step_id);
    if (!pf) return false; // a new finding — fail closed
    if (VERDICT_RANK[nf.verdict] > VERDICT_RANK[pf.verdict]) return false;
  }
  return true;
};

const errorCount = (recipe: unknown): number =>
  parseRecipe(recipe).issues.filter((i) => i.severity === 'error').length;

/* ──────────────── The application ──────────────── */

export const applyAutoPiiProtection = (
  input: unknown,
  classifier?: PiiSourceClassifier,
): AutoPiiApplication => {
  const trace = tracePiiFlow(input, classifier);
  const plan = deriveAutoPiiFieldInjections(trace);
  const original = input as RecipeDefinition;
  const unchanged: AutoPiiApplication = {
    recipe: original,
    changed: false,
    injections: [],
    brackets: [],
    residual: [],
    trace,
  };
  const rec = asRecord(input);
  if (!rec) return unchanged;
  if (plan.injections.length === 0 && plan.gaps.length === 0) return unchanged;

  const work = deepClone(rec);
  const injections: PiiFieldInjection[] = [];
  const brackets: AppliedPiiBracket[] = [];
  const residual: AutoPiiResidual[] = [];

  // ── 1. llm.pii_fields injections (executor-internal, position-free) ──
  for (const inj of plan.injections) {
    const loc = findStep(work, inj.step_id);
    const inputRec = loc ? asRecord(loc.step.input) : null;
    if (!loc || !inputRec) continue; // malformed — trace already trusted input
    const existing = inputRec['llm.pii_fields'];
    const authored = asRecord(existing);
    if (existing !== undefined && existing !== null && !authored) {
      // a `{{ref}}` / non-map declaration — never clobber the author's hand
      residual.push({
        step_id: inj.step_id,
        slug: inj.slug,
        outcome: 'declaration_conflict',
      });
      continue;
    }
    // The author's kind wins on a path collision (plan contract).
    inputRec['llm.pii_fields'] = { ...inj.fields, ...(authored ?? {}) };
    injections.push(inj);
  }

  // ── 2. Bracket synthesis for identifier-leak gaps ──
  const gapByStep = new Map(plan.gaps.map((g) => [g.step_id, g]));
  let currentTrace = injections.length > 0 ? tracePiiFlow(work, classifier) : trace;

  for (const gap of plan.gaps) {
    const finding = trace.findings.find((f) => f.step_id === gap.step_id);
    if (!finding) continue;
    const fail = (outcome: AutoPiiResidualOutcome): void => {
      residual.push({ step_id: gap.step_id, slug: gap.slug, gap_reason: gap.reason, outcome });
    };
    if (gap.reason === 'untraced') {
      fail('no_bracketable_source');
      continue;
    }
    if (!hasIdentifierLeak(finding)) {
      fail('content_only');
      continue;
    }
    const loc = findStep(work, gap.step_id);
    if (!loc) continue;
    if (loc.where !== 'steps') {
      fail('unsupported_position');
      continue;
    }
    if (hasContinuityRef(work, gap.step_id)) {
      fail('continuity_reference');
      continue;
    }
    if (hasSelfReferentialCondition(loc.step, gap.step_id, 'fail_on')) {
      fail('self_referential_fail_on');
      continue;
    }
    if (hasSelfReferentialCondition(loc.step, gap.step_id, 'stop_when')) {
      fail('self_referential_stop_when');
      continue;
    }

    // Group sources by ref (one protect per upstream value).
    const byRef = new Map<string, PiiEgressSource[]>();
    for (const s of finding.sources) {
      const list = byRef.get(s.ref);
      if (list) list.push(s);
      else byRef.set(s.ref, [s]);
    }
    const qualified: QualifiedSource[] = [];
    for (const group of byRef.values()) {
      const q = qualifySource(group);
      if (q) qualified.push(q);
    }
    if (qualified.length === 0) {
      fail('no_bracketable_source');
      continue;
    }

    // ── Candidate rewrite on a clone of the working recipe ──
    const candidate = deepClone(work);
    const candLoc = findStep(candidate, gap.step_id);
    if (!candLoc || candLoc.where !== 'steps') continue;
    const steps = candidate.steps as unknown[];
    const taken = allStepIds(candidate);
    const aiStep = candLoc.step;
    const aiInput = asRecord(aiStep.input);
    if (!aiInput) {
      fail('no_bracketable_source');
      continue;
    }

    const appliedSources: AppliedPiiBracketSource[] = [];
    const protectSteps: Rec[] = [];
    for (const q of qualified) {
      const pid = mintId(`${gap.step_id}_pii_protect`, taken);
      protectSteps.push({
        id: pid,
        transform: 'pii-protect',
        data: `{{${q.ref}}}`,
        fields: Object.entries(q.fields)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([path, kind]) => ({ path, kind })),
      });
      // Rewrite the tainted ref inside the payload keys it was seen under.
      const re = refPattern(q.ref);
      for (const key of q.input_keys) {
        if (aiInput[key] !== undefined) {
          aiInput[key] = rewriteRef(aiInput[key], re, `step.${pid}.aliased`);
        }
      }
      appliedSources.push({ ref: q.ref, protect_step_id: pid, fields: q.fields });
    }
    steps.splice(candLoc.index, 0, ...protectSteps);

    // Chained restores: ai output → restore(p1) → restore(p2) → …
    const restoreIds: string[] = [];
    let restoreData = `{{step.${gap.step_id}}}`;
    const restoreSteps: Rec[] = [];
    for (const src of appliedSources) {
      const rid = mintId(`${gap.step_id}_pii_restore`, taken);
      restoreSteps.push({
        id: rid,
        transform: 'pii-restore',
        data: restoreData,
        ledger_handle: `{{step.${src.protect_step_id}.ledger_handle}}`,
      });
      restoreData = `{{step.${rid}.restored}}`;
      restoreIds.push(rid);
    }
    const aiIndex = candLoc.index + protectSteps.length;
    steps.splice(aiIndex + 1, 0, ...restoreSteps);

    // Rewire downstream consumers (later steps + every non-step top-level
    // field) onto the final restore's view.
    const lastRestore = restoreIds[restoreIds.length - 1] as string;
    const restoredRef = `step.${lastRestore}.restored`;
    const firstDownstream = aiIndex + 1 + restoreSteps.length;
    for (let i = firstDownstream; i < steps.length; i++) {
      steps[i] = rewireStepRef(steps[i], gap.step_id, restoredRef);
    }
    for (const [key, value] of Object.entries(candidate)) {
      if (key === 'steps' || key === 'prefetch_steps' || key === 'trigger_steps') continue;
      candidate[key] = rewireStepRef(value, gap.step_id, restoredRef);
    }
    // Output section sources hold BARE `step.X` paths (no braces).
    if (candidate.output !== undefined) {
      candidate.output = rewireBareSources(candidate.output, gap.step_id, restoredRef);
    }

    // ── Verify or roll back ──
    const nextTrace = tracePiiFlow(candidate, classifier);
    if (!verifyBracket(currentTrace, nextTrace, gap.step_id)) {
      fail('verification_failed');
      continue;
    }
    Object.assign(work, candidate);
    currentTrace = nextTrace;
    brackets.push({
      step_id: gap.step_id,
      slug: gap.slug,
      sources: appliedSources,
      restore_step_ids: restoreIds,
    });
  }

  if (injections.length === 0 && brackets.length === 0) {
    return { ...unchanged, residual };
  }

  // ── 3. Final parse gate — the rewrite must not add error-severity issues ──
  if (errorCount(work) > errorCount(rec)) {
    if (brackets.length > 0) {
      // Drop every bracket, keep injections (re-derived on a fresh clone).
      const fallback = deepClone(rec);
      for (const inj of injections) {
        const loc = findStep(fallback, inj.step_id);
        const inputRec = loc ? asRecord(loc.step.input) : null;
        if (!loc || !inputRec) continue;
        const authored = asRecord(inputRec['llm.pii_fields']);
        inputRec['llm.pii_fields'] = { ...inj.fields, ...(authored ?? {}) };
      }
      for (const b of brackets) {
        const reason = gapByStep.get(b.step_id)?.reason;
        residual.push({
          step_id: b.step_id,
          slug: b.slug,
          ...(reason !== undefined ? { gap_reason: reason } : {}),
          outcome: 'verification_failed',
        });
      }
      brackets.length = 0;
      if (injections.length > 0 && errorCount(fallback) <= errorCount(rec)) {
        return {
          recipe: fallback as unknown as RecipeDefinition,
          changed: true,
          injections,
          brackets: [],
          residual,
          trace,
        };
      }
    }
    // Injections alone still fail (or nothing left) — apply nothing.
    return { ...unchanged, residual };
  }

  return {
    recipe: work as unknown as RecipeDefinition,
    changed: true,
    injections,
    brackets,
    residual,
    trace,
  };
};
