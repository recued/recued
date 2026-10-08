/**
 * Auto-PII static flow trace (reactive-design § 7 — option B, install-time).
 *
 * A recipe is a static, typed DAG wired by `{{step.X.field}}` refs, so whether
 * a PII-classified source field's VALUE survives the transform graph into an
 * LLM-bound input is statically decidable: walk the steps in declaration
 * order, give every step output a taint profile (dot-path → privacy kinds),
 * propagate through a per-transform PII-flow rule (closed set — every entry in
 * `TRANSFORM_SCHEMAS` has a rule; the exhaustiveness test lives beside the
 * schemas), and judge each `ai-*` step's model-bound inputs.
 *
 * Corpus calibration (2026-06-10, 165 community recipes): 54 recipes carry 64
 * ai-steps; the rule set below traces ALL of them — zero flow-opacity. The
 * judged split: 43 clean (aggregates/derived metrics — the trace PROVES no PII
 * flows), 4 protected by the legacy bare-name hash bracket, 3 protected by
 * authored `pii-protect`, 7 content-only, 7 identifier leaks. Two author traps
 * the trace catches that eyeballing missed: a path-form legacy declaration
 * (`contacts[].email`) that `hash_replace`'s bare-name matcher can never honor
 * (silent no-op — full contact PII egressed), and partial coverage (names
 * tagged, `company` forgotten).
 *
 * Classification is INJECTED (`PiiSourceClassifier`), not embedded: the server
 * builds it from the shipped canonical privacy schemas (`MetaField.privacy`,
 * D-167) + curated kernel tables; this module owns only the flow algebra.
 * Classification-ABSENT sources read clean — matching the chat-mode posture
 * (only tagged fields alias; curation is the lever). `pii_untraced` means the
 * FLOW could not be followed (a transform without a rule, a foreach item the
 * walker cannot bind), never "fields lack tags" — flow opacity propagates as
 * taint and fails closed into the verdict.
 *
 * CONTRACT: trusts input like `analyzeRecipe` / `deriveRecipeTargeting` —
 * never throws on malformed recipes; run `validateRecipe` first if
 * correctness matters. Pure — no IO, no dynamic registries (the one lookup,
 * `kernelOpBackingSlug`, is a compile-time-const kernel-op map).
 */

import { isBatchCapableAISlug } from './ai-batch.js';
import { stripCorePrefix } from './core-pack.js';
import { kernelOpBackingSlug } from './kernel-op-registry.js';
import { ENTITY_FIELD_PRIVACY_KINDS } from './pii-alias.js';
import type { EntityFieldPrivacy } from './pii-alias.js';

/* ──────────────── Taint model ──────────────── */

/**
 * One taint kind flowing through the graph:
 *   - a raw `EntityFieldPrivacy` kind — the classified PII value is present;
 *   - `alias:<kind>` — the value descends from `pii-protect.aliased` /
 *     `hash_replace.data` and is in ALIAS SPACE (safe for egress, restorable);
 *   - `untraced` — flow opacity: a construct the walker has no rule for sits
 *     upstream. Propagates like content and fails the egress verdict closed.
 */
export type PiiTaintKind = EntityFieldPrivacy | `alias:${EntityFieldPrivacy}` | 'untraced';

/** Taint profile of one value: dot-path → kinds. `''` = the value itself
 *  carries the kinds (scalar, or a string the kinds were baked into).
 *
 *  A `[]` path segment marks a LIST boundary (`'[].email'` = each element's
 *  email; `'messages.[].from'` = each element of the `messages` field). The
 *  boundary is load-bearing for runtime honesty in two directions:
 *    - a `{{step.x.email}}` ref into a list resolves UNDEFINED at runtime
 *      (the engine's dot-walk indexes arrays only by NUMERIC segment), so
 *      the trace must not flow taint through a non-numeric ref segment that
 *      meets a `[]` boundary;
 *    - an `llm.pii_fields` / `pii-protect` tag path walks the same way
 *      (`getAtPath`), so a declared path can never cover taint that sits
 *      across a `[]` boundary — except the executor's per-element BATCH pass
 *      over a top-level `llm.data` list, where tag paths are item-relative. */
export type PiiPathProfile = Readonly<Record<string, readonly PiiTaintKind[]>>;

/** The list-boundary path segment (see `PiiPathProfile`). */
export const PII_LIST_SEGMENT = '[]';

/** Classification lookup for semantic step outputs (ingredient / catalog-op
 * reads and, when curated, model-output shapes). Returns the output taint
 * profile for a step, or undefined for "no classified PII" (the chat-mode
 * untagged posture). An AI step's classified output is applied only after its
 * own egress verdict, so it taints downstream consumers without retroactively
 * changing the call that produced it. Paths in the returned profile use raw
 * `EntityFieldPrivacy` kinds only. */
export type PiiSourceClassifier = (step: {
  readonly ingredient?: string;
  readonly op?: string;
}) => PiiPathProfile | undefined;

/* ──────────────── Egress findings ──────────────── */

export type PiiEgressVerdict =
  /** No classified PII (raw or aliased) reaches this model call. */
  | 'clean'
  /** Everything PII-bearing arrives in alias space (authored `pii-protect`). */
  | 'protected_alias'
  /** Raw PII arrives but every path is covered by a declared protection
   *  (`llm.pii_fields` map or an effective legacy bare-name `pii_fields`). */
  | 'protected_declared'
  /** Only `content`-kind taint arrives uncovered (free text that may mention
   *  identifiers — content-scan territory, not a whole-value identifier). */
  | 'content_reaches_llm'
  /** An identifier-kind PII value reaches the model uncovered. */
  | 'pii_reaches_llm'
  /** No concrete uncovered PII found, but flow opacity reached this call —
   *  the verdict cannot be trusted to be clean. */
  | 'pii_untraced';

/** One uncovered model-bound taint path. */
export interface PiiUncoveredPath {
  /** The model-bound input key (`llm.data`, `llm.prompt`, `llm.data_a`, …). */
  input_key: string;
  /** Dot-path within that input's value; `''` = the whole value (an
   *  interpolated string or a directly-tainted scalar). */
  path: string;
  /** Raw kinds present (never alias-space, never `untraced`). */
  kinds: readonly EntityFieldPrivacy[];
}

/** One payload-value ref that carried RAW classified taint into a model-bound
 *  input — per-ref provenance for the § 7 bracket synthesizer (an interpolated
 *  `llm.prompt` collapses its refs' taint onto the whole value in `uncovered`,
 *  so only this record says WHICH upstream output to wrap in a
 *  `pii-protect` / `pii-restore` bracket and which paths to tag). */
export interface PiiEgressSource {
  /** The model-bound input key the ref appears under. */
  input_key: string;
  /** The ref dot-path as written (`step.contacts_raw`, `item.email`) —
   *  format hints stripped. */
  ref: string;
  /** RAW kinds the ref selects (alias-space + `untraced` filtered out), in
   *  the ref's OWN coordinate space — `[]` list boundaries preserved
   *  (`'[].email'` = each element's email of the selected list). */
  profile: Readonly<Record<string, readonly EntityFieldPrivacy[]>>;
}

/** A free-text (`content`) path that a legacy bare-name `pii_fields` entry covers —
 *  names the field itself or a field above it. The step-level hash aliases nothing
 *  INSIDE text: it swaps every value under the name for a `HASH_STEP_<n>` token, so
 *  the model gets a token it cannot read in place of the text. It runs at dispatch,
 *  before the AI executor, so an `llm.pii_fields` `content` tag on the same path
 *  finds only the token. */
export interface PiiLegacyContentPath {
  /** The model-bound input key. */
  input_key: string;
  /** Dot-path within that input's value (may carry `[]` list segments). */
  path: string;
  /** The `pii_fields` entry that covers it — the outermost named key on the path. */
  entry: string;
}

export interface PiiEgressFinding {
  step_id: string;
  /** The ai-* ingredient slug. */
  slug: string;
  verdict: PiiEgressVerdict;
  /** Every kind that reached any model-bound input (incl. alias-space and
   *  `untraced`), for display. */
  kinds: readonly PiiTaintKind[];
  /** Uncovered raw-PII paths — what a protection must cover. Empty for
   *  clean / protected verdicts. Paths may carry `[]` list-boundary
   *  segments (see `PiiPathProfile`). */
  uncovered: readonly PiiUncoveredPath[];
  /** Every payload-value ref that carried RAW taint into this call (covered
   *  or not), one entry per (input_key, ref) — the bracket synthesizer's
   *  working set. */
  sources: readonly PiiEgressSource[];
  /** What the step already declares (display + injection-planning input). */
  declared: {
    /** Effective legacy bare-name `pii_fields` entries (path-form entries
     *  are excluded — they never match at runtime). */
    legacy_pii_fields: readonly string[];
    /** The authored `llm.pii_fields` map, verbatim path → kind. */
    llm_pii_fields: Readonly<Record<string, string>>;
    /** The step is an authored D-162 batch call (`llm.id_field` non-empty) —
     *  tag paths apply item-relative over the top-level `llm.data` list. */
    batch: boolean;
  };
  /** Flow opacity reached this call (true whenever `untraced` taint arrived,
   *  regardless of verdict — a concrete leak verdict can carry it too). */
  untraced: boolean;
  /** Free-text paths a legacy bare-name `pii_fields` entry covers (see
   *  {@link PiiLegacyContentPath}) — credited as covered above, but what the model
   *  then gets is a token in place of the text. */
  legacy_content: readonly PiiLegacyContentPath[];
}

export interface PiiUntracedStep {
  step_id: string;
  reason: string;
}

export interface RecipePiiTrace {
  /** One finding per ai-step, in declaration order. */
  findings: readonly PiiEgressFinding[];
  /** Steps whose flow rule was missing/unresolvable (the opacity SOURCES;
   *  `findings[].untraced` marks where the opacity arrived). */
  untraced_steps: readonly PiiUntracedStep[];
  /** Recipe-level flag (design § 7): any finding is `pii_untraced` or
   *  carries residual opacity. */
  pii_untraced: boolean;
}

/* ──────────────── Per-transform flow rules ──────────────── */

/**
 * Declarative rule classes. Structural transforms (map / group_by / pick /
 * pii-protect, …) need bespoke handlers in the walker; everything else
 * declares one of these classes so the table stays reviewable and the
 * exhaustiveness check ("every transform has a rule") is mechanical.
 *
 *   - `pass_array`       — item shape preserved; profile of the named arg
 *                          passes through (filter / sort / slice / …).
 *   - `pick_item`        — ONE element of the named list arg comes out
 *                          (find / min_by / max_by): the `[]` boundary strips.
 *   - `destroy`          — result is a number / boolean / date / hash with no
 *                          PII value surviving (count / math / compare / …).
 *   - `string_preserve`  — string-in string-out, value substance kept
 *                          (lowercase / trim / truncate / …): taint passes.
 *   - `collapse_render`  — inputs are rendered into one string (template /
 *                          join / to_table / …): every kind anywhere in the
 *                          named args lands on the whole value.
 *   - `union_values`     — result is one of / a merge of the named args'
 *                          values (coalesce / default / merge / ternary).
 *   - `structural`       — bespoke handler inside the walker.
 */
export type PiiFlowRule =
  | { readonly rule: 'pass_array'; readonly arg: string }
  | { readonly rule: 'pick_item'; readonly arg: string }
  | { readonly rule: 'destroy' }
  | { readonly rule: 'string_preserve'; readonly arg: string }
  | { readonly rule: 'collapse_render'; readonly args: readonly string[] }
  | { readonly rule: 'union_values'; readonly args: readonly string[] }
  | { readonly rule: 'structural' };

/**
 * The closed rule table — one entry per `TRANSFORM_SCHEMAS` key. A transform
 * added without a rule here is caught by the exhaustiveness test AND fails
 * closed at trace time (missing rule → `untraced` taint), so a new transform
 * can never silently launder PII past the trace.
 */
export const PII_FLOW_RULES: Readonly<Record<string, PiiFlowRule>> = {
  // ── Collection ──
  filter: { rule: 'pass_array', arg: 'array' },
  sort: { rule: 'pass_array', arg: 'array' },
  map: { rule: 'structural' },
  project: { rule: 'structural' },
  reduce: { rule: 'destroy' },
  unique: { rule: 'pass_array', arg: 'array' },
  flatten: { rule: 'pass_array', arg: 'array' },
  slice: { rule: 'pass_array', arg: 'array' },
  /** `chunk` REGROUPS rows without touching them — every element of every chunk is
   *  the identical object `array` carried in, so any taint on the input is present,
   *  unchanged, on the output. Same rule as `slice` / `partition` for the same reason:
   *  a nesting level is not a redaction. */
  chunk: { rule: 'pass_array', arg: 'array' },
  group_by: { rule: 'structural' },
  to_list: { rule: 'pass_array', arg: 'input' },
  partition: { rule: 'pass_array', arg: 'array' },
  // ── Object ──
  merge: { rule: 'union_values', args: ['source', 'sources'] },
  // Copies values from `with` onto items of `array`, so the result is tainted by
  // BOTH inputs — the same class as `merge`, not `pass_array`.
  enrich_by: { rule: 'union_values', args: ['array', 'with'] },
  prefix_keys: { rule: 'structural' },
  pick: { rule: 'structural' },
  omit: { rule: 'structural' },
  rename: { rule: 'structural' },
  set: { rule: 'structural' },
  // Like count: the scalar byte length reveals no recoverable content.
  json_byte_length: { rule: 'destroy' },
  // Serialization and parsing preserve every value and therefore its taint.
  json_stringify: { rule: 'string_preserve', arg: 'input' },
  json_parse: { rule: 'string_preserve', arg: 'input' },
  // A bank export is full of names and account references, and parsing moves
  // every one of them into the rows unchanged — the taint travels with them.
  csv_parse: { rule: 'string_preserve', arg: 'input' },
  utf8_byte_length: { rule: 'destroy' },
  sha256: { rule: 'destroy' },
  // ── String ──
  lowercase: { rule: 'string_preserve', arg: 'input' },
  uppercase: { rule: 'string_preserve', arg: 'input' },
  trim: { rule: 'string_preserve', arg: 'input' },
  string_length: { rule: 'destroy' },
  // encode_base64 is an ENCODING, not a hash and not redaction: the value
  // survives whole and `atob` reverses it. It reads as obscuring because the
  // output is unreadable, which is exactly why it must not be a `destroy` —
  // that would launder a name straight into a written file. Same shape as the
  // strip_html reasoning below.
  encode_base64: { rule: 'string_preserve', arg: 'input' },
  // decode_base64 REVEALS the plaintext an encode hid — taint must pass or a
  // decoded name would read as clean to the trace.
  decode_base64: { rule: 'string_preserve', arg: 'input' },
  split: { rule: 'string_preserve', arg: 'input' },
  contains_any: { rule: 'destroy' },
  concat: { rule: 'collapse_render', args: ['values'] },
  replace: { rule: 'string_preserve', arg: 'input' },
  template: { rule: 'collapse_render', args: ['template'] },
  truncate: { rule: 'string_preserve', arg: 'input' },
  // strip_html removes markup but NOT text-level PII (a name/email written as
  // body text survives), so taint passes through — not a `destroy`.
  strip_html: { rule: 'string_preserve', arg: 'input' },
  // ── Numeric ──
  round: { rule: 'destroy' },
  clamp: { rule: 'destroy' },
  to_number: { rule: 'destroy' },
  math: { rule: 'destroy' },
  weighted_score: { rule: 'destroy' },
  // ── Date ── (dates are not one of the 9 privacy kinds; formatting a date
  // string yields a date, not an identifier)
  // to_recent_date: epoch number in, epoch number out — no PII survives a
  // timestamp, same class as date_diff.
  to_recent_date: { rule: 'destroy' },
  date_diff: { rule: 'destroy' },
  date_format: { rule: 'destroy' },
  date_add: { rule: 'destroy' },
  date_parse: { rule: 'destroy' },
  is_past: { rule: 'destroy' },
  is_future: { rule: 'destroy' },
  date_period: { rule: 'destroy' },
  // event_when reads an event's times and all-day flag only; what it returns is
  // dates and clock times, never the event's text.
  event_when: { rule: 'destroy' },
  // ── Logic ──
  compare: { rule: 'destroy' },
  coalesce: { rule: 'union_values', args: ['values'] },
  switch: { rule: 'structural' },
  all: { rule: 'destroy' },
  any: { rule: 'destroy' },
  count: { rule: 'destroy' },
  default: { rule: 'union_values', args: ['value', 'fallback'] },
  // `defaults` — N defaults in one step. `union_values` over the single
  // `fields` param is CORRECT here, not a shortcut: `valueTaint` keys a nested
  // record by its OWN keys, so `fields: { vendor: { value, fallback } }` yields
  // a profile at `vendor.value` / `vendor.fallback`, and a downstream read of
  // `{{step.<id>.vendor}}` re-roots the remainder via `selectPath`
  // (`r === refSegs.length` branch) and carries both. Verified against that
  // walk before choosing the param shape — a flatter shape would have keyed the
  // taint one level off and UNDER-tainted, which is the unsafe direction.
  defaults: { rule: 'union_values', args: ['fields'] },
  not: { rule: 'destroy' },
  ternary: { rule: 'union_values', args: ['then', 'else'] },
  pluralize: { rule: 'destroy' },
  // ── Privacy ──
  hash_replace: { rule: 'structural' },
  hash_restore: { rule: 'structural' },
  redact: { rule: 'destroy' },
  'pii-protect': { rule: 'structural' },
  'pii-restore': { rule: 'structural' },
  // ── Display (rendered strings) ──
  to_checklist: { rule: 'collapse_render', args: ['title', 'items'] },
  to_table: { rule: 'collapse_render', args: ['array', 'columns'] },
  to_summary: { rule: 'collapse_render', args: ['fields'] },
  // `delimiter` is rendered between cells, so a tainted dynamic delimiter must
  // taint the output too — include it alongside the row data + column labels.
  to_csv: { rule: 'collapse_render', args: ['array', 'columns', 'delimiter'] },
  to_slack_blocks: { rule: 'collapse_render', args: ['blocks'] },
  // ── Boolean ──
  starts_with: { rule: 'destroy' },
  ends_with: { rule: 'destroy' },
  // ── Compound (Tier 2) ──
  find: { rule: 'pick_item', arg: 'array' },
  pluck: { rule: 'structural' },
  sum: { rule: 'destroy' },
  min_by: { rule: 'pick_item', arg: 'array' },
  max_by: { rule: 'pick_item', arg: 'array' },
  percent: { rule: 'destroy' },
  join: { rule: 'collapse_render', args: ['array'] },
  // ── D-115 reactive starter set ──
  mail_received: { rule: 'destroy' }, // boolean match
  file_changed: { rule: 'pass_array', arg: 'files' },
  calendar_starting_soon: { rule: 'pass_array', arg: 'events' },
  recipe_succeeded_since: { rule: 'destroy' },
  time_within_window: { rule: 'destroy' },
  time_elapsed_since: { rule: 'destroy' },
  http_changed: { rule: 'destroy' },
  calendar_changed_since: { rule: 'pass_array', arg: 'events' },
  calendar_new_since: { rule: 'pass_array', arg: 'events' },
  // diffs attendee identities out of event snapshots / attendee arrays —
  // the added/removed lists carry whatever the inputs carried
  attendee_diff: {
    rule: 'union_values',
    args: ['prior', 'current', 'prior_attendees', 'current_attendees', 'attendees'],
  },
  wait: { rule: 'destroy' },
  // Reads a warehouse enrichment row (derived facts) or falls through to a
  // fetch; its output is not classifiable from recipe text. Classification-
  // absent posture (clean) — the classifier growth path is enrichment-topic
  // schemas (D-136 registry), not a flow rule.
  'enrichment-or-fetch': { rule: 'destroy' },
};

/* ──────────────── Internals ──────────────── */

type Profile = Map<string, Set<PiiTaintKind>>;

const REF_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_*-]+)*)\s*(?::[a-zA-Z_]+)?\s*\}\}/g;

const refsIn = (s: string): string[] =>
  [...s.matchAll(REF_RE)].map((m) => m[1] as string);

const isPureRef = (s: string): boolean => {
  const matches = s.match(REF_RE);
  return matches !== null && matches.length === 1 && s.trim() === matches[0];
};

const empty = (): Profile => new Map();

const unionInto = (target: Profile, src: Profile, prefix = ''): Profile => {
  for (const [path, kinds] of src) {
    const key = prefix === '' ? path : path === '' ? prefix : `${prefix}.${path}`;
    let into = target.get(key);
    if (!into) {
      into = new Set();
      target.set(key, into);
    }
    for (const k of kinds) into.add(k);
  }
  return target;
};

const allKinds = (p: Profile): Set<PiiTaintKind> => {
  const out = new Set<PiiTaintKind>();
  for (const kinds of p.values()) for (const k of kinds) out.add(k);
  return out;
};

const isNumericSegment = (seg: string): boolean => /^[0-9]+$/.test(seg);

/**
 * Subtree of `profile` at a REF dot-path, re-rooted — segment-aware so `[]`
 * list boundaries mirror the engine's dot-walk:
 *   - a NUMERIC ref segment indexes into a `[]` boundary (consumes it);
 *   - a non-numeric ref segment meeting `[]` resolves UNDEFINED at runtime —
 *     no taint flows (the engine reads a named key off an ARRAY);
 *   - an ancestor profile entry (a strict prefix of the path, or `''`) taints
 *     the whole selection, but only when the remaining ref segments don't
 *     cross a list boundary the entry itself sat above.
 */
const selectPath = (profile: Profile, path: string): Profile => {
  if (path === '') return new Map([...profile].map(([p, k]) => [p, new Set(k)]));
  const refSegs = path.split('.');
  const out = empty();
  for (const [p, kinds] of profile) {
    const profSegs = p === '' ? [] : p.split('.');
    // walk ref segments against profile segments
    let r = 0;
    let q = 0;
    let dead = false;
    while (r < refSegs.length && q < profSegs.length) {
      const rs = refSegs[r] as string;
      const ps = profSegs[q] as string;
      if (ps === PII_LIST_SEGMENT) {
        if (!isNumericSegment(rs)) { dead = true; break; }
        r += 1; q += 1; // numeric index consumes the boundary
      } else if (ps === rs) {
        r += 1; q += 1;
      } else {
        dead = true; break;
      }
    }
    if (dead) continue;
    if (r === refSegs.length) {
      // profile entry at or below the ref path → re-root the remainder
      unionInto(out, new Map([[profSegs.slice(q).join('.'), kinds]]));
    } else {
      // profile entry is an ANCESTOR (q exhausted first): the whole selected
      // value inherits the ancestor's kinds (a whole-value-tainted string /
      // object — any read off it carries the taint).
      unionInto(out, new Map([['', kinds]]));
    }
  }
  return out;
};

/** Strip ONE leading `[]` boundary — the item view of a list profile (what a
 *  single element looks like). Entries not under a leading `[]` (e.g. the
 *  whole-value `''`) pass through unchanged. */
const itemView = (listProfile: Profile): Profile => {
  const out = empty();
  for (const [p, kinds] of listProfile) {
    if (p === PII_LIST_SEGMENT) unionInto(out, new Map([['', kinds]]));
    else if (p.startsWith(`${PII_LIST_SEGMENT}.`)) {
      unionInto(out, new Map([[p.slice(PII_LIST_SEGMENT.length + 1), kinds]]));
    } else {
      unionInto(out, new Map([[p, kinds]]));
    }
  }
  return out;
};

/** Re-add the leading `[]` boundary — the list view over an item profile. */
const listView = (itemProfile: Profile): Profile => {
  const out = empty();
  for (const [p, kinds] of itemProfile) {
    unionInto(out, new Map([[p === '' ? PII_LIST_SEGMENT : `${PII_LIST_SEGMENT}.${p}`, kinds]]));
  }
  return out;
};

/** Collapse to a whole-value profile (string interpolation / rendering). */
const collapse = (p: Profile): Profile => {
  const kinds = allKinds(p);
  return kinds.size === 0 ? empty() : new Map([['', kinds]]);
};

const fromAliasSpace = (p: Profile): Profile => {
  const out = empty();
  for (const [path, kinds] of p) {
    out.set(
      path,
      new Set([...kinds].map((k): PiiTaintKind =>
        k.startsWith('alias:') ? (k.slice('alias:'.length) as PiiTaintKind) : k,
      )),
    );
  }
  return out;
};

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const stepsOf = (recipe: Record<string, unknown>): Array<Record<string, unknown>> => {
  const out: Array<Record<string, unknown>> = [];
  for (const key of ['prefetch_steps', 'steps'] as const) {
    const arr = recipe[key];
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      const rec = asRecord(s);
      if (rec) out.push(rec);
    }
  }
  return out;
};

/** Model-bound `llm.*` payload keys are OPEN (fail-closed: a new payload key
 *  defaults to traced); this is the closed NON-payload set — engine/executor
 *  control knobs whose values never reach the model as content. */
const LLM_NON_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'llm.pii_fields',
  'llm.id_field',
  'llm.model_hint',
  'llm.output_format',
  'llm.allow_search',
  'llm.content_parts',
  'llm.scale',
  'llm.max_length',
]);

const isAiSlug = (slug: string): boolean =>
  // §5 — a `core-ai-*` kernel alias reaches the LLM exactly like its bare slug, so
  // it must be traced for PII egress identically.
  stripCorePrefix(slug).startsWith('ai-');

/**
 * Mirror of the engine's map/project expression math case
 * (`resolveExpression` Case 2, transforms/collection.ts): a string with
 * `{{item.*}}` ref(s) AND any of `+ - * / % ( )` is evaluated as MATH — every
 * item ref is coerced through `Number()` (non-numeric → 0), so no PII value
 * survives. This applies ONLY inside a map/project `expression`; everywhere
 * else (llm payloads, transform args) the value system does plain string
 * interpolation and the real values ride through. A `{{step.*}}` ref inside
 * an expression string is resolved (interpolated) at INPUT resolution before
 * the map runs, so a mixed step+item string can carry the step value as
 * literal text — only item-ONLY operator strings destroy.
 */
const isEngineMathExpression = (s: string, refs: readonly string[]): boolean => {
  if (!/[+\-*/%()]/.test(s)) return false;
  const itemRefs = refs.filter((r) => r === 'item' || r.startsWith('item.'));
  return itemRefs.length > 0 && itemRefs.length === refs.length;
};

const IDENTIFIER_KIND_ORDER: readonly EntityFieldPrivacy[] = ENTITY_FIELD_PRIVACY_KINDS;

/* ──────────────── The trace ──────────────── */

export const tracePiiFlow = (
  input: unknown,
  classifier?: PiiSourceClassifier,
): RecipePiiTrace => {
  const recipe = asRecord(input);
  if (!recipe) return { findings: [], untraced_steps: [], pii_untraced: false };

  const steps = stepsOf(recipe);
  const profiles = new Map<string, Profile>();
  const protectLedgers = new Map<string, Profile>();
  const untracedSteps: PiiUntracedStep[] = [];
  const findings: PiiEgressFinding[] = [];

  const markUntraced = (stepId: string, reason: string): Profile => {
    untracedSteps.push({ step_id: stepId, reason });
    return new Map([['', new Set<PiiTaintKind>(['untraced'])]]);
  };

  const refTaint = (ref: string, itemProfile: Profile | null): Profile => {
    const segs = ref.split('.');
    if (segs[0] === 'item') {
      if (itemProfile) return selectPath(itemProfile, segs.slice(1).join('.'));
      return empty(); // no foreach/array binding in scope — nothing to carry
    }
    if (segs[0] !== 'step') return empty();
    const prof = profiles.get(segs[1] ?? '');
    if (!prof) return empty();
    return selectPath(prof, segs.slice(2).join('.'));
  };

  /** Taint of an arbitrary input value: a string with refs, an object
   *  template, an array, a literal. `inExpression` marks map/project
   *  `expression` context — the only place the engine evaluates math. */
  const valueTaint = (
    v: unknown,
    itemProfile: Profile | null,
    inExpression = false,
  ): Profile => {
    if (typeof v === 'string') {
      if (isPureRef(v)) return refTaint(refsIn(v)[0] as string, itemProfile);
      const refs = refsIn(v);
      if (refs.length === 0) return empty();
      if (inExpression && isEngineMathExpression(v, refs)) return empty();
      const out = empty();
      for (const r of refs) unionInto(out, collapse(refTaint(r, itemProfile)));
      return out;
    }
    if (Array.isArray(v)) {
      const out = empty();
      for (const el of v) unionInto(out, collapse(valueTaint(el, itemProfile, inExpression)));
      return out;
    }
    const rec = asRecord(v);
    if (rec) {
      const out = empty();
      for (const [k, val] of Object.entries(rec)) {
        unionInto(out, valueTaint(val, itemProfile, inExpression), k);
      }
      return out;
    }
    return empty();
  };

  /** Output profile of one transform step. `itemProfile` is the foreach
   *  binding when the step carries `foreach` (resolved by the caller). */
  const transformProfile = (
    s: Record<string, unknown>,
    itemProfile: Profile | null,
  ): Profile => {
    const t = typeof s.transform === 'string' ? s.transform : '';
    const stepId = typeof s.id === 'string' ? s.id : '<anonymous>';
    const rule = PII_FLOW_RULES[t];
    if (!rule) return markUntraced(stepId, `transform '${t}' has no PII-flow rule`);

    switch (rule.rule) {
      case 'pass_array':
        return valueTaint(s[rule.arg], itemProfile);
      case 'pick_item':
        return itemView(valueTaint(s[rule.arg], itemProfile));
      case 'destroy':
        return empty();
      case 'string_preserve':
        return collapse(valueTaint(s[rule.arg], itemProfile));
      case 'collapse_render': {
        const out = empty();
        for (const arg of rule.args) {
          if (s[arg] !== undefined) unionInto(out, collapse(valueTaint(s[arg], itemProfile)));
        }
        return out;
      }
      case 'union_values': {
        // The result is ONE of (coalesce / ternary) or a key-merge of (merge)
        // the candidate values, structure intact — so an ARRAY-shaped arg
        // (`coalesce.values`, `merge.sources`) unions its ELEMENT profiles
        // uncollapsed. (`valueTaint`'s array branch collapses, which is right
        // for a literal array VALUE but would smear item-level taint onto the
        // whole value here — e.g. `coalesce(contacts, [])` tainting a
        // downstream `.length` read.)
        const out = empty();
        for (const arg of rule.args) {
          const v = s[arg];
          if (v === undefined) continue;
          if (Array.isArray(v)) {
            for (const el of v) unionInto(out, valueTaint(el, itemProfile));
          } else {
            unionInto(out, valueTaint(v, itemProfile));
          }
        }
        return out;
      }
      case 'structural':
        break;
    }

    switch (t) {
      case 'map': {
        const itemProf = itemView(valueTaint(s.array, itemProfile));
        if (s.expression !== undefined) {
          return listView(valueTaint(s.expression, itemProf, true));
        }
        // apply + field (+ output_field) mode
        const fieldTaint = selectPath(itemProf, typeof s.field === 'string' ? s.field : '');
        const apply = typeof s.apply === 'string' ? s.apply : undefined;
        const applyRule = apply ? PII_FLOW_RULES[apply] : undefined;
        const derived =
          apply === undefined ? fieldTaint
          : applyRule === undefined ? markUntraced(stepId, `map.apply '${apply}' has no PII-flow rule`)
          : applyRule.rule === 'string_preserve' ? fieldTaint
          : applyRule.rule === 'destroy' ? empty()
          : collapse(fieldTaint); // conservative for exotic applies
        if (typeof s.output_field === 'string' && s.output_field !== '') {
          const out = new Map([...itemProf].map(([p, k]) => [p, new Set(k)])) as Profile;
          unionInto(out, collapse(derived), s.output_field);
          return listView(out);
        }
        return listView(derived);
      }
      case 'project':
        return valueTaint(s.expression, valueTaint(s.object, itemProfile), true);
      case 'group_by': {
        const itemProf = itemView(valueTaint(s.array, itemProfile));
        const out = empty();
        if (typeof s.field === 'string' && s.field !== '') {
          unionInto(out, collapse(selectPath(itemProf, s.field)), s.field);
        }
        // aggregates (count / sum / avg / min / max) yield numbers — destroyed
        return listView(out);
      }
      case 'pick':
        // object-template builder (`source` carries refs per output key)
        return valueTaint(s.source, itemProfile);
      case 'omit': {
        const prof = valueTaint(s.source, itemProfile);
        const omitted = new Set(
          Array.isArray(s.fields) ? s.fields.filter((f): f is string => typeof f === 'string') : [],
        );
        const out = empty();
        for (const [p, kinds] of prof) {
          const root = p.split('.')[0] as string;
          if (!omitted.has(root) && !omitted.has(p)) out.set(p, new Set(kinds));
        }
        return out;
      }
      case 'rename': {
        const prof = valueTaint(s.source, itemProfile);
        const mapping = asRecord(s.mapping) ?? {};
        const out = empty();
        for (const [p, kinds] of prof) {
          const segs = p.split('.');
          const renamed = mapping[segs[0] as string];
          const np = typeof renamed === 'string'
            ? [renamed, ...segs.slice(1)].join('.')
            : p;
          unionInto(out, new Map([[np, kinds]]));
        }
        return out;
      }
      case 'prefix_keys': {
        const prof = valueTaint(s.source, itemProfile);
        if (
          typeof s.prefix !== 'string'
          || s.prefix.length === 0
          || refsIn(s.prefix).length > 0
        ) {
          return markUntraced(
            stepId,
            "prefix_keys 'prefix' is not a static non-empty string",
          );
        }
        const out = empty();
        for (const [p, kinds] of prof) {
          const prefixed = p === ''
            ? s.prefix.replace(/[.]$/, '')
            : `${s.prefix}${p}`;
          unionInto(out, new Map([[prefixed, kinds]]));
        }
        return out;
      }
      case 'set': {
        const out = valueTaint(s.source, itemProfile);
        if (typeof s.field === 'string' && s.field !== '') {
          unionInto(out, collapse(valueTaint(s.value, itemProfile)), s.field);
        }
        return out;
      }
      case 'switch': {
        const out = empty();
        const cases = asRecord(s.cases) ?? {};
        for (const v of Object.values(cases)) unionInto(out, collapse(valueTaint(v, itemProfile)));
        if (s.default !== undefined) unionInto(out, collapse(valueTaint(s.default, itemProfile)));
        return out;
      }
      case 'pluck': {
        const itemProf = itemView(valueTaint(s.array, itemProfile));
        return listView(selectPath(itemProf, typeof s.field === 'string' ? s.field : ''));
      }
      case 'pii-protect': {
        // Runtime aliases ONLY the tagged paths (`aliasFields` walks each
        // `{path, kind}` exactly; `fields` omitted = documented no-op
        // pass-through) — so untagged classified fields stay RAW under
        // `.aliased`, and a content-tagged path's scan catches only the
        // identifier kinds the SAME step's identifier tags seeded.
        const dataTaint = valueTaint(s.data, itemProfile);
        if (typeof s.id === 'string') protectLedgers.set(s.id, dataTaint);
        const rawFields = s.fields;
        let tags: Array<{ path: string; kind: string }> = [];
        let opaque = false;
        if (rawFields === undefined || rawFields === null) {
          tags = []; // documented no-op pass-through
        } else if (Array.isArray(rawFields)) {
          for (const t of rawFields) {
            const rec = asRecord(t);
            if (rec && typeof rec.path === 'string' && typeof rec.kind === 'string') {
              tags.push({ path: rec.path, kind: rec.kind });
            } else {
              opaque = true; // a ref / malformed entry — coverage unknowable
            }
          }
        } else {
          opaque = true; // `fields` is a `{{ref}}` — dynamic tags
        }
        if (opaque) {
          const out = markUntraced(stepId, "pii-protect 'fields' is not a static tag array");
          const wrapped = empty();
          unionInto(wrapped, out, 'aliased');
          unionInto(wrapped, collapse(dataTaint), 'aliased');
          return wrapped;
        }
        const identifierTagPaths = new Set(
          tags.filter((t) => t.kind !== 'content').map((t) => t.path),
        );
        const contentTagPaths = new Set(
          tags.filter((t) => t.kind === 'content').map((t) => t.path),
        );
        // identifier kinds seeded into the run ledger by this step's tags —
        // the content scan can only alias THOSE
        const seededKinds = new Set<PiiTaintKind>();
        for (const [path, kinds] of dataTaint) {
          const tagPath = path.startsWith(`${PII_LIST_SEGMENT}.`)
            ? path.slice(PII_LIST_SEGMENT.length + 1) // batch list: tags are item-relative
            : path;
          if (!identifierTagPaths.has(tagPath)) continue;
          for (const k of kinds) {
            if (k !== 'untraced' && !k.startsWith('alias:') && k !== 'content') seededKinds.add(k);
          }
        }
        const aliasedProfile = empty();
        for (const [path, kinds] of dataTaint) {
          const tagPath = path.startsWith(`${PII_LIST_SEGMENT}.`)
            ? path.slice(PII_LIST_SEGMENT.length + 1)
            : path;
          const mapped = new Set<PiiTaintKind>();
          for (const k of kinds) {
            if (k === 'untraced' || k.startsWith('alias:')) { mapped.add(k); continue; }
            if (identifierTagPaths.has(tagPath)) {
              mapped.add(`alias:${k}` as PiiTaintKind);
            } else if (contentTagPaths.has(tagPath)) {
              // scan-protected only for kinds the identifier pass seeded;
              // 'content' itself counts as scanned
              mapped.add(
                k === 'content' || seededKinds.has(k)
                  ? (`alias:${k}` as PiiTaintKind)
                  : k,
              );
            } else {
              mapped.add(k); // untagged → raw pass-through
            }
          }
          aliasedProfile.set(path, mapped);
        }
        const out = empty();
        unionInto(out, aliasedProfile, 'aliased');
        return out;
      }
      case 'pii-restore': {
        const dataTaint = valueTaint(s.data, itemProfile);
        const out = empty();
        unionInto(out, fromAliasSpace(dataTaint), 'restored');
        const handle = typeof s.ledger_handle === 'string' ? s.ledger_handle : '';
        const protectId = refsIn(handle)[0]?.split('.')[1];
        const orig = protectId !== undefined ? protectLedgers.get(protectId) : undefined;
        if (orig) unionInto(out, collapse(orig), 'restored');
        return out;
      }
      case 'hash_replace': {
        // Runtime deepReplace hashes everything under a LISTED bare key name (any
        // depth), so a path is covered when any key along it is listed; a
        // path-form entry never matches, a non-array `fields` is a no-op.
        const dataTaint = valueTaint(s.data, itemProfile);
        const bareNames = new Set(
          Array.isArray(s.fields)
            ? s.fields.filter(
                (f): f is string => typeof f === 'string' && !/[.[\]]/.test(f),
              )
            : [],
        );
        const hashed = empty();
        for (const [path, kinds] of dataTaint) {
          const covered = path.split('.').some(
            (seg) => seg !== PII_LIST_SEGMENT && bareNames.has(seg),
          );
          hashed.set(
            path,
            new Set(
              [...kinds].map((k): PiiTaintKind =>
                covered && k !== 'untraced' && !k.startsWith('alias:')
                  ? (`alias:${k}` as PiiTaintKind)
                  : k,
              ),
            ),
          );
        }
        const out = empty();
        unionInto(out, hashed, 'data');
        // the token→value mapping holds the REAL values of hashed fields
        unionInto(out, collapse(dataTaint), 'mapping');
        return out;
      }
      case 'hash_restore': {
        const out = empty();
        unionInto(out, fromAliasSpace(valueTaint(s.data, itemProfile)), 'data');
        return out;
      }
      default:
        return markUntraced(stepId, `structural transform '${t}' has no handler`);
    }
  };

  for (const s of steps) {
    const stepId = typeof s.id === 'string' ? s.id : '';
    if (stepId === '') continue;

    // foreach binding: `{{item.*}}` inside this step resolves to the foreach
    // array's ITEM profile (one element's view).
    const itemProfile =
      s.foreach !== undefined ? itemView(valueTaint(s.foreach, null)) : null;

    if (s.guard !== undefined) {
      profiles.set(stepId, empty());
      continue;
    }
    if (s.transform !== undefined) {
      profiles.set(stepId, transformProfile(s, itemProfile));
      continue;
    }

    const op = typeof s.op === 'string' ? s.op : undefined;
    // D-182 — a CLOSED-KIND kernel op-step (`core.ai.prompt`, `core.mail.get`, …)
    // reaches the LLM / produces PII EXACTLY as its backing kernel ingredient, and
    // its `args` ARE that ingredient's `input`. Resolve it to the backing slug + args
    // view so the egress detection and the source classifier (keyed on the kernel
    // ingredient slug, checked before `op`) treat it identically to the legacy
    // ingredient step. Non-closed-kind ops (bare canonical `deal.search`, tool
    // `web.search`, Tier-P, `core.crm.*`) have no registry backing slug → `slug`
    // stays undefined and the existing `op`-keyed classifier path runs unchanged.
    const backingSlug = op !== undefined ? kernelOpBackingSlug(op) : undefined;
    const slug =
      typeof s.ingredient === 'string' ? s.ingredient : backingSlug;
    const inputSource = backingSlug !== undefined ? s.args : s.input;

    if (slug !== undefined && isAiSlug(slug)) {
      // ── Egress point ──
      const inputRec = asRecord(inputSource) ?? {};
      const perKey = new Map<string, Profile>();
      const reached = empty();
      // Per-ref provenance (`sources`): the value-level taint below collapses
      // interpolated strings, so the per-ref selection profile is recorded
      // here, before the smear — it is the only place a bracket synthesizer
      // can learn WHICH upstream output carries the taint.
      const sources: PiiEgressSource[] = [];
      const seenSources = new Set<string>();
      const collectSources = (key: string, v: unknown): void => {
        if (typeof v === 'string') {
          for (const r of refsIn(v)) {
            const dedup = `${key} ${r}`;
            if (seenSources.has(dedup)) continue;
            seenSources.add(dedup);
            const prof = refTaint(r, itemProfile);
            const raw: Record<string, readonly EntityFieldPrivacy[]> = {};
            for (const [p, kinds] of prof) {
              const rawKinds = IDENTIFIER_KIND_ORDER.filter((k) => kinds.has(k));
              if (rawKinds.length > 0) raw[p] = rawKinds;
            }
            if (Object.keys(raw).length > 0) {
              sources.push({ input_key: key, ref: r, profile: raw });
            }
          }
          return;
        }
        if (Array.isArray(v)) {
          for (const el of v) collectSources(key, el);
          return;
        }
        const nested = asRecord(v);
        if (nested) for (const val of Object.values(nested)) collectSources(key, val);
      };
      for (const [key, value] of Object.entries(inputRec)) {
        // `llm.*` = the contracted/api surface. `chat.*` is retained
        // for legacy manifest traces and is model-bound payload.
        const isPayload =
          (key.startsWith('llm.') && !LLM_NON_PAYLOAD_KEYS.has(key))
          || key.startsWith('chat.');
        if (!isPayload) continue;
        const taint = valueTaint(value, itemProfile);
        if (taint.size > 0) perKey.set(key, taint);
        unionInto(reached, taint);
        collectSources(key, value);
      }

      // Declared protections.
      // legacy step-level pii_fields: hash_replace deep-matches BARE key names
      // at any depth and hashes everything under each; a path-form entry
      // ('contacts[].email', 'a.b') matches nothing (validate-pii reports those
      // as ineffective).
      const legacyBareNames = new Set(
        Array.isArray(s.pii_fields)
          ? s.pii_fields.filter(
              (p): p is string => typeof p === 'string' && !/[.[\]]/.test(p),
            )
          : [],
      );
      const piiFieldsMap = asRecord(inputRec['llm.pii_fields']);
      const declaredPaths = new Set(piiFieldsMap ? Object.keys(piiFieldsMap) : []);
      const piiFieldsApplies = piiFieldsMap !== null && isBatchCapableAISlug(slug);
      // The executor's per-element BATCH alias pass (tag paths item-relative)
      // engages only for a top-level llm.data list WITH a non-empty id_field.
      const idField = inputRec['llm.id_field'];
      const batchActive = typeof idField === 'string' && idField !== '';

      const uncovered: PiiUncoveredPath[] = [];
      const legacyContent: PiiLegacyContentPath[] = [];
      for (const [key, taint] of perKey) {
        for (const [path, kinds] of taint) {
          const raw = [...kinds].filter(
            (k): k is EntityFieldPrivacy => k !== 'untraced' && !k.startsWith('alias:'),
          );
          if (raw.length === 0) continue;
          const segs = path.split('.');
          // The step-level hash replaces EVERYTHING under a named key, so any key
          // along the path covers it. The outermost one is the key the hash hits
          // first. ⛔ It used to be the LAST key only, for a walk that left a list
          // under a named key in clear — mail `to` / `cc`, which the classifier
          // profiles as plain paths, read covered while every address went out.
          const namedSegment = segs.find(
            (sgm) => sgm !== PII_LIST_SEGMENT && legacyBareNames.has(sgm),
          );
          // llm.pii_fields walks EXACT dot-paths (`getAtPath`): no recursive
          // root coverage, no crossing a `[]` boundary — except item-relative
          // tags over a top-level batch list.
          const isBatchPath = segs[0] === PII_LIST_SEGMENT;
          const tagPath = isBatchPath ? segs.slice(1).join('.') : path;
          const tagWalkable =
            tagPath !== '' && !tagPath.split('.').includes(PII_LIST_SEGMENT);
          const piiFieldsCovered =
            piiFieldsApplies
            && key === 'llm.data'
            && (!isBatchPath || batchActive)
            && tagWalkable
            && declaredPaths.has(tagPath);
          const covered = piiFieldsCovered || namedSegment !== undefined;
          // Recorded even where `llm.pii_fields` also tags it: the step-level hash
          // runs first, at dispatch, so the content tag would only see the token.
          if (raw.includes('content') && namedSegment !== undefined) {
            legacyContent.push({ input_key: key, path, entry: namedSegment });
          }
          if (!covered) {
            uncovered.push({
              input_key: key,
              path,
              kinds: IDENTIFIER_KIND_ORDER.filter((k) => raw.includes(k)),
            });
          }
        }
      }

      const reachedKinds = allKinds(reached);
      const untraced = reachedKinds.has('untraced');
      const rawReached = [...reachedKinds].filter(
        (k) => k !== 'untraced' && !k.startsWith('alias:'),
      );
      const uncoveredIdentifier = uncovered.some((u) =>
        u.kinds.some((k) => k !== 'content'),
      );
      const uncoveredAny = uncovered.length > 0;

      const verdict: PiiEgressVerdict =
        uncoveredIdentifier ? 'pii_reaches_llm'
        : uncoveredAny ? 'content_reaches_llm'
        : untraced ? 'pii_untraced'
        : rawReached.length > 0 ? 'protected_declared'
        : reachedKinds.size > 0 ? 'protected_alias'
        : 'clean';

      findings.push({
        step_id: stepId,
        slug,
        verdict,
        kinds: [...reachedKinds].sort(),
        uncovered,
        sources,
        declared: {
          legacy_pii_fields: [...legacyBareNames],
          llm_pii_fields: Object.fromEntries(
            Object.entries(piiFieldsMap ?? {}).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          ),
          batch: batchActive,
        },
        untraced,
        legacy_content: legacyContent,
      });

      // The model may echo any (restored) input value into any output field:
      // collapse de-aliased input taint onto the whole output. (A protected
      // input is RESTORED post-call by the executor / restore step, so
      // downstream consumers see real values again.) A server classifier may
      // additionally describe the model's semantic output shape — for example,
      // ai-summarize.summary is content even when its opaque file-ref input
      // cannot be statically inspected. Apply that profile only AFTER judging
      // this call, then carry it to downstream consumers.
      const outputProfile = collapse(fromAliasSpace(reached));
      const classifiedOutput = classifier?.({ ingredient: slug, op });
      if (classifiedOutput) {
        for (const [path, kinds] of Object.entries(classifiedOutput)) {
          const current = outputProfile.get(path) ?? new Set<PiiTaintKind>();
          for (const kind of kinds) current.add(kind);
          outputProfile.set(path, current);
        }
      }
      profiles.set(stepId, outputProfile);
      continue;
    }

    if (slug !== undefined || op !== undefined) {
      const classified = classifier?.({ ingredient: slug, op });
      if (classified) {
        const prof = empty();
        for (const [path, kinds] of Object.entries(classified)) {
          prof.set(path, new Set(kinds));
        }
        profiles.set(stepId, prof);
      } else {
        profiles.set(stepId, empty());
      }
      continue;
    }

    profiles.set(stepId, empty());
  }

  const pii_untraced =
    findings.some((f) => f.untraced || f.verdict === 'pii_untraced');

  return { findings, untraced_steps: untracedSteps, pii_untraced };
};

/* ──────────────── Auto-injection plan (the § 7 "auto-inject" half) ─────── */

/**
 * One computed injection: add these `llm.pii_fields` entries to the step's
 * input (union with any author-declared map; the author's kind wins on a
 * path collision). Only derived for batch-capable contracted slugs whose
 * uncovered taint sits entirely on STRUCTURED `llm.data` paths — the shapes
 * the executor's alias→call→restore round-trip handles today.
 */
export interface PiiFieldInjection {
  step_id: string;
  slug: string;
  /** Path → kind, ready to merge into `input['llm.pii_fields']`. */
  fields: Readonly<Record<string, EntityFieldPrivacy>>;
}

/** Why a finding could not be auto-protected (surface-to-author territory). */
export interface PiiInjectionGap {
  step_id: string;
  slug: string;
  reason:
    /** `ai-prompt` / `ai-compare` — `llm.pii_fields` is undefined
     *  for these; the fix is an upstream `pii-protect` bracket. */
    | 'slug_not_contracted'
    /** Taint arrives on a non-`llm.data` payload key or as a whole-value
     *  interpolated string — no structured path for the alias pass to walk. */
    | 'unstructured_payload'
    /** Taint sits across a `[]` list boundary the runtime tag walk cannot
     *  cross (and the step is not an authored batch call) — the fix is an
     *  upstream `pii-protect` over the list itself. */
    | 'list_crossing'
    /** Flow opacity — `pii_untraced` (nothing concrete to cover). */
    | 'untraced';
}

export interface AutoPiiInjectionPlan {
  injections: readonly PiiFieldInjection[];
  gaps: readonly PiiInjectionGap[];
}

export const deriveAutoPiiFieldInjections = (
  trace: RecipePiiTrace,
): AutoPiiInjectionPlan => {
  const injections: PiiFieldInjection[] = [];
  const gaps: PiiInjectionGap[] = [];
  for (const f of trace.findings) {
    if (f.verdict === 'pii_untraced') {
      gaps.push({ step_id: f.step_id, slug: f.slug, reason: 'untraced' });
      continue;
    }
    if (f.verdict !== 'pii_reaches_llm' && f.verdict !== 'content_reaches_llm') continue;
    if (!isBatchCapableAISlug(f.slug)) {
      gaps.push({ step_id: f.step_id, slug: f.slug, reason: 'slug_not_contracted' });
      continue;
    }
    // Tag paths must be runtime-walkable (`getAtPath` exact dot-paths).
    // Injection never flips a step into batch mode — but under an AUTHORED
    // batch call (`llm.id_field` set) tag paths apply ITEM-relative over the
    // top-level list, so a `[].`-prefixed path injects as its remainder.
    let gap: PiiInjectionGap['reason'] | null = null;
    const tagPaths = new Map<string, PiiUncoveredPath>();
    for (const u of f.uncovered) {
      if (u.input_key !== 'llm.data' || u.path === '') {
        gap = 'unstructured_payload';
        break;
      }
      const segs = u.path.split('.');
      const isBatchPath = segs[0] === PII_LIST_SEGMENT;
      const tagPath = isBatchPath && f.declared.batch ? segs.slice(1).join('.') : u.path;
      if (tagPath === '' || tagPath.split('.').includes(PII_LIST_SEGMENT)) {
        gap = 'list_crossing';
        break;
      }
      tagPaths.set(tagPath, u);
    }
    if (gap) {
      gaps.push({ step_id: f.step_id, slug: f.slug, reason: gap });
      continue;
    }
    const fields: Record<string, EntityFieldPrivacy> = {};
    for (const [tagPath, u] of tagPaths) {
      // one kind per path: strongest identifier first (declaration order of
      // the 9-kind list), `content` only when nothing stronger is present
      const identifier = u.kinds.find((k) => k !== 'content');
      fields[tagPath] = identifier ?? 'content';
    }
    // A content-only injection is injected too (owner ruling, 2026-10-05). A
    // content tag hides what the identifier pass seeded plus — on a server —
    // the warehouse's known contacts and every email in the text (D-316
    // amendment), so it is no longer decorative. It still misses identifiers
    // the warehouse lacks; the posture summary says exactly what it hides.
    injections.push({ step_id: f.step_id, slug: f.slug, fields });
  }
  return { injections, gaps };
};

/* ──────────────── § 7 third slice — surfacing wire shapes ──────────────── */

/** One display-ready disclosure line about one AI step. The MESSAGE is the
 *  surface: built once server-side (`@recued/recipes`
 *  `summarizeRecipePiiPosture`) and rendered verbatim by every consumer —
 *  the packs install dialog, the webclient recipes view, and the MCP
 *  `recued_saveRecipe` tool result — so the teaching cannot drift between
 *  the human's modal and the model's tool result (the § 8 targeting-guard
 *  precedent). Messages name step ids, input paths, and PII KINDS — never
 *  data values. */
export interface RecipePiiPostureLine {
  step_id: string;
  message: string;
}

/** A recipe's PII posture as surfaced at install / save / Kitchen: what the
 *  § 7 dispatch seam will auto-protect at run time, what still needs the
 *  author's hand, and the validator's standing findings. Wire shape only —
 *  the builder lives in `@recued/recipes` (it needs the trace + applicator);
 *  the canonical classifier composition is server-side. */
export interface RecipePiiPostureSummary {
  /** One-line status — `Recued will auto-protect N AI steps at run time;
   *  M remain manual.` Empty string when there is nothing headline-worthy
   *  (no AI egress findings; `infos` / `warnings` may still carry
   *  supplementary lines, e.g. an ineffective legacy declaration). */
  headline: string;
  /** AI steps the dispatch seam covers automatically at run time
   *  (`llm.pii_fields` injection or a synthesized protect/restore
   *  bracket) — positive disclosure, not a warning. */
  auto_protected: readonly RecipePiiPostureLine[];
  /** Warning-grade: identifier egress that still stands at run time
   *  (auto-protection declined — each message carries the actionable
   *  authoring hint) + ineffective authored declarations. */
  warnings: readonly RecipePiiPostureLine[];
  /** Info-grade: content-only egress and untraced flows. */
  infos: readonly RecipePiiPostureLine[];
}

/** One recipe's posture inside a multi-recipe result (`packs.install`
 *  `pii_disclosure`, the `recipe.pii` rpc). */
export interface RecipePiiDisclosureEntry {
  recipe_id: string;
  summary: RecipePiiPostureSummary;
}

/** True when the summary carries anything worth rendering — consumers omit
 *  empty summaries so absence keeps meaning "nothing to disclose". */
export const recipePiiPostureHasContent = (
  summary: RecipePiiPostureSummary,
): boolean =>
  summary.headline !== ''
  || summary.auto_protected.length > 0
  || summary.warnings.length > 0
  || summary.infos.length > 0;
