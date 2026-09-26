/** D-177 P5b (N.11) — open-ended session grants: the taint-propagation
 *  provenance walker.
 *
 *  `grant_mode: 'open'` exists for repeats whose future payloads are
 *  genuinely un-enumerable at approval time ("status-reply each email I
 *  forward"). The guard sits on the gated step's AUTHORITY-BEARING args (the
 *  destination / entity / connection / risk-selecting paths — the same set
 *  `hash_exclude_args` may never exclude, N.2): for each such arg,
 *  canonicalization walks its ref graph to the boundary roots — STATIC over
 *  the recipe JSON — and classifies every root by ORIGIN against a closed
 *  table (rule 2). TAINTED roots (model/caller-typed) are pinned by resolved
 *  value at mint; CLEAN roots may vary with their inputs — that is the
 *  feature. The model can never re-aim a destination it (or its agent turns)
 *  authored: a pinned root resolving differently on a later fire fails the
 *  hash equality and re-asks.
 *
 *  Taint PROPAGATES, it is never originated mid-recipe (rule 4): an `ai-*`
 *  step adds no authority — it runs a recipe-authored prompt server-side,
 *  outside the chat agent's reach — so its output is tainted iff any input
 *  is, exactly like a transform. Taint is decided at the BOUNDARY roots only.
 *
 *  The closed origin table as BUILT (v1 — strictly ⊆ the spec's table; every
 *  narrowing is fail-closed or pins MORE, never less):
 *
 *  | root                                  | class            | behavior |
 *  |:--------------------------------------|:-----------------|:---------|
 *  | literal recipe/manifest content       | (skeleton)       | pinned via the arg's unresolved-value skeleton |
 *  | `meta.*`                              | `meta`           | pinned (constant) |
 *  | `vault.*` (deferVault placeholder)    | `vault`          | pinned (the placeholder string — constant) |
 *  | `config.*` / caller-supplied run args | `config`         | TAINTED → pinned |
 *  | `context.event.*` (trigger payload)   | `context_event`  | clean → varies |
 *  | `context.reception_submission.*` /    | `door_submission`| clean → varies, reception-door runs ONLY (N.14) |
 *  |   `context.reception_order.*`         |                  |          |
 *  | `connection.*` (user-enrolled)        | `connection`     | clean → varies |
 *  | `data.*` row, user-clean (rule 1)     | `stored_user`    | clean → varies |
 *  | `data.*` / `shared.*` (all other)     | `stored`         | TAINTED → pinned |
 *  | other `context.*` / `prefs` / unknown | —                | REFUSE (no `open`) |
 *  | `step.*` / `trigger.*`                | (recursive)      | inherits the producing step's roots |
 *  | `item.*`                              | (recursive)      | inherits the foreach/collection source's roots |
 *  | dynamic nested key (`{{a.{{b}}}}`)    | —                | REFUSE (rule 2) |
 *
 *  Per-row `origin_actor` stored-cleanliness gate (rule 1 — the named
 *  follow-on, landed): a `data.*` root is `stored_user` (clean → varies)
 *  exactly when the host's `resolveStoredRowOrigin` callback resolves the
 *  ref to ONE stored row and that row passes `isUserCleanStoredRow`
 *  (`origin_actor: 'user_self'` ∧ `origin_surface: 'client_rpc'` ∧ no
 *  contract — see `origin-provenance.ts` for why actor alone is not
 *  enough: chat/messenger agent writes stamp `user_self`). EVERYTHING
 *  else — callback absent (non-server hosts), unresolvable ref, dotted-id
 *  ambiguity, agent/system/engine-written row, callback throw — degrades
 *  to `stored` (TAINTED → pinned), the same fail-closed default v1
 *  shipped for every stored read. `shared.*` / `data.shared.*` are
 *  recipe-writable tiers with no per-row writer provenance and NEVER
 *  consult the callback (always `stored`, spec rule 2 "unknown →
 *  TAINTED"). Rule 5's session-ref anchors (user- vs agent-contributed
 *  chat content) have no by-reference representation on this surface yet
 *  and likewise fail closed (no namespace maps to them).
 *
 *  Clean-root re-verification (rule 6 "every clean-root anchor still
 *  resolves user-contributed") is the per-fire RE-WALK: clean origins are
 *  re-derived from the recipe + manifest at every fire, and the recipe's
 *  ref structure is pinned by the grant's `recipe_hash` (N.4 common
 *  predicate), so a root that stops classifying clean changes the projection
 *  structure → different hash → no match. The per-ROW stored anchor rides
 *  the same re-walk: `resolveStoredRowOrigin` re-reads the LIVE row at
 *  every match, so a row re-written by an agent between fires (the stores
 *  re-stamp origin facets on every write) re-classifies `stored_user` →
 *  `stored` — different structure, different hash, re-ask.
 *
 *  `pinned_projection_hash` covers the WHOLE canonical projection — arg
 *  paths, skeletons, root refs, origin classes, every pinned root value,
 *  and every tainted-fed arg's DERIVED pinned value (rule 6's "and of any
 *  authority value derived from one" — root pins alone do not survive a
 *  non-deterministic propagator: an `ai-*` step can sample a different
 *  destination off the same pinned prompt) — so ANY drift (an
 *  authority-set change from a manifest edit, a re-classified root, a
 *  pinned value resolving differently) fails the equality and re-asks.
 *  Hashing the structure alongside the values is strictly stricter than
 *  rule 6's minimum.
 *
 *  Spec: D-177 § N.11 / N.3 / N.4; landing order P5b. */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';
import { NS, type Namespace } from './namespaces.js';
import {
  isUserCleanStoredRow,
  type StoredRowProvenance,
} from './origin-provenance.js';
import { hasNestedRef, parseRef } from './resolve.js';
import { TARGET_SCOPE } from './values.js';

// ────────────────────────────────────────────────────────────────
// Vocabulary
// ────────────────────────────────────────────────────────────────

/** The wire-authority baseline — the input keys that select a dispatch's
 *  destination / transport / connection, union the per-kind target-scope
 *  keys. ONE source of truth (D-177 P5b): the `hash_exclude_args`
 *  publish-gate (`packages/ingredients/validate.ts`) and the open-projection
 *  authority set both read this list, so "what an exclusion may never
 *  target" and "what an open grant must guard" can never drift apart (N.2 —
 *  the same set). */
export const WIRE_AUTHORITY_ARG_PATHS: readonly string[] = [
  'method', 'url', 'path', 'connection', 'connection_kind',
  ...TARGET_SCOPE,
];

/** The closed origin classes a boundary root may carry (rule 2). Anything a
 *  walk cannot place in this table refuses `open` — fail closed. */
export type OpenOriginClass =
  | 'meta'           // recipe metadata — constant, pinned trivially
  | 'vault'          // deferVault placeholder string — constant, pinned
  | 'config'         // model/caller-typed — TAINTED, pinned
  | 'stored'         // data.* / shared.* stored reads, not user-clean —
                     //   TAINTED, pinned (the fail-closed default)
  | 'stored_user'    // data.* row passing the rule-1 per-row gate
                     //   (`isUserCleanStoredRow` over the host-resolved
                     //   row facets) — clean, varies
  | 'context_event'  // trigger payload — clean ONLY on a trusted event
                     //   channel (see `eventContextTrusted`), varies
  | 'connection'     // user-enrolled connection record — clean, varies
  | 'door_submission'; // N.14 — `context.reception_submission.*` /
                     //   `context.reception_order.*` on a reception-door run
                     //   ONLY (see `doorSubmissionTrusted`): visitor form
                     //   data flowing through a hash-pinned, statically-
                     //   analyzed bound recipe (D-207 — visitor input is
                     //   DATA, never CONTROL). Rides (varies) so a door
                     //   grant's projection stays stable across
                     //   visitor-varying fires; every other channel refuses
                     //   these roots exactly as before.

/** The classes whose roots are PINNED by resolved value (tainted, plus the
 *  trivially-constant ones — uniform handling keeps the projection shape
 *  regular; a constant pin can never fail an honest repeat). */
export const OPEN_PINNED_ORIGINS: ReadonlySet<OpenOriginClass> = new Set([
  'meta', 'vault', 'config', 'stored',
]);

/** The genuinely TAINTED classes (rule 2: model/caller-typed + unknown-writer
 *  stored reads). An authority arg with any root in this set ALSO pins its
 *  DERIVED resolved value (rule 6 — see `OpenProjectionArg.derived_pinned`);
 *  the constant classes (`meta`/`vault`) pin their roots for hygiene but
 *  never force a derived pin (their propagation is recipe-content-bound). */
export const OPEN_TAINTED_ORIGINS: ReadonlySet<OpenOriginClass> = new Set([
  'config', 'stored',
]);

/** One boundary root of one authority-bearing arg (rule 6). */
export interface OpenProjectionRoot {
  /** Canonical `ns.path` form (post alias-rewrite — `parseRef`). */
  readonly ref: string;
  readonly origin: OpenOriginClass;
  /** The resolved value at mint, present iff `origin` pins
   *  (`OPEN_PINNED_ORIGINS`). `undefined` resolutions are stored as `null`
   *  (canonical JSON carries no undefined; an upstream skip resolving
   *  undefined on both sides still matches). */
  readonly pinned?: unknown;
}

/** One authority-bearing arg's provenance record (rule 6: root refs, origin
 *  classes, pinned values; the clean-root anchor is the per-fire re-walk —
 *  see the module doc). */
export interface OpenProjectionArg {
  /** The authority path into the merged args (e.g. `to`, `mcp.tool`). */
  readonly path: string;
  /** The UNRESOLVED merged value at `path`, verbatim — ref strings
   *  included. Pins every literal (recipe- AND manifest-default-sourced:
   *  manifest defaults are NOT covered by `recipe_hash`, so a manifest edit
   *  that re-aims a default fails the hash here) plus the ref structure. */
  readonly skeleton: unknown;
  /** Ref roots reached from `skeleton`, deduped by ref, sorted by ref. */
  readonly roots: readonly OpenProjectionRoot[];
  /** Rule 6's "and of any authority value derived from one": present iff
   *  any root is TAINTED (`config` / `stored`) — the arg's RESOLVED value,
   *  pinned alongside the roots. Pinning the roots alone is insufficient
   *  through a NON-DETERMINISTIC propagator: an `ai-*` step fed a pinned
   *  `config` prompt can still sample a different destination per run —
   *  same root values, different derived authority value — so the derived
   *  value is pinned too and any drift re-asks. Clean-fed args deliberately
   *  carry no derived pin (varying with clean inputs IS the feature —
   *  rule 3). */
  readonly derived_pinned?: unknown;
}

/** The normative `open_projection` structure stored on the grant row (N.3)
 *  and recomputed per fire (N.4 `'open'` arm). */
export interface OpenProjection {
  readonly version: 1;
  /** Sorted by `path`. Non-empty by construction (an empty authority set
   *  refuses `open` — a grant that guards nothing must not exist). */
  readonly args: readonly OpenProjectionArg[];
}

/** Human-readable pinned/varies summary for the ask body (rule 7 — the
 *  confirm sentence maps 1:1 onto enforced bounds; these lines show WHAT is
 *  pinned and WHAT may vary). Raise-time rendering only — never stored on
 *  the grant, never agent-visible (N.9.1: the agent projection is the
 *  closed `awaiting_approval` shape). */
export interface OpenProjectionPreview {
  /** `path ← ref: value` lines for every pinned root (+ literal-only args). */
  readonly pinned: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  /** `path ← ref (origin)` lines for every varying root. */
  readonly varying: ReadonlyArray<{ readonly label: string; readonly origin: string }>;
}

/** A successful walk: the normative structure, its canonical hash, and the
 *  ask-rendering preview. */
export interface OpenProjectionComputation {
  readonly projection: OpenProjection;
  readonly pinned_projection_hash: string;
  readonly preview: OpenProjectionPreview;
}

/** A refused walk — `grant_mode: 'open'` is not offerable/mintable for this
 *  dispatch. The reason is for logs/tests only (never user- or
 *  agent-facing). */
export interface OpenProjectionRefusal {
  readonly refused: string;
}

export const isOpenProjectionRefusal = (
  v: OpenProjectionComputation | OpenProjectionRefusal,
): v is OpenProjectionRefusal => 'refused' in v;

/** Serialized-projection byte ceiling. A projection is destination-scale
 *  data (a handful of args, small pinned values); blowing this budget means
 *  something pathological is being pinned — refuse rather than store it. */
export const OPEN_PROJECTION_MAX_BYTES = 8_192;

/** Node-count ceiling across ALL pin/skeleton materialization in one walk
 *  (codex LOW fold). The byte cap fires only AFTER canonicalizing the whole
 *  projection; this incremental budget refuses a breadth-explosion (a huge
 *  pinned config/stored array) DURING the clone, bounding the allocation
 *  before serialization. Generous vs. the byte cap — a real projection is a
 *  handful of small values. */
export const OPEN_PROJECTION_MAX_NODES = 4_096;

/** Preview list ceiling per side — the ask body enumerates at most this
 *  many pinned/varying lines (the projection itself is never truncated). */
export const OPEN_PREVIEW_MAX_LINES = 12;

/** Rendered pinned-value preview length ceiling (characters). */
const PREVIEW_VALUE_MAX_CHARS = 120;

/** Step-graph recursion ceiling — far above any real recipe's step count;
 *  a walk this deep is a malformed/cyclic graph. */
const MAX_WALK_DEPTH = 64;

// ────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────

export interface ComputeOpenProjectionArgs {
  /** The gated dispatch's MERGED unresolved args — the SAME
   *  manifest-defaults + step-input merge the P1b hash basis uses
   *  (`mergeManifestStepInput`), BEFORE resolution. The walk reads ref
   *  strings out of this object. */
  readonly mergedArgs: Record<string, unknown>;
  /** The authority-bearing paths for this dispatch:
   *  `WIRE_AUTHORITY_ARG_PATHS` ∪ the manifest's `authority_args`
   *  declaration. The caller gates on the declaration's PRESENCE — `open`
   *  is a curated opt-in (an undeclared manifest never reaches this walk). */
  readonly authorityPaths: readonly string[];
  /** Every step of the executing recipe — `steps` + `prefetch_steps` +
   *  `trigger_steps` concatenated. Untyped on purpose: recipes are JSON and
   *  the walk discriminates defensively (an unrecognizable step shape
   *  refuses). */
  readonly steps: readonly unknown[];
  /** The gated step's id (`StepMeta.step_id`) — anchors `item.*`
   *  resolution to the gated step's own `foreach`. Absent ⇒ an `item.*`
   *  root at the top level refuses. */
  readonly gatedStepId?: string;
  /** Whether `context.event.*` is a TRUSTED system-stamped trigger payload
   *  on THIS run's channel (codex HIGH fold). `context.event` is clean
   *  (rule 2) only because it is a system event — which holds exactly on
   *  the event-fire channels (reactive / schedule / webhook / housekeeping),
   *  where the warehouse-bus dispatcher stamps it. On chat / mcp / user /
   *  messenger / reception the SAME `context.*` field is populated from the
   *  caller's `request.context` — so a model could put
   *  `context.event.payload.to` in an authority arg and have it ride as a
   *  "clean varying" root it actually controls (the laundering hole). The
   *  host sets this `true` only for the trusted channels; absent/false ⇒ a
   *  `context.event.*` root REFUSES open (falls back to exact, which pins
   *  the full payload — always safe). */
  readonly eventContextTrusted?: boolean;
  /** N.14 — whether `context.reception_submission.*` / `context.reception_order.*`
   *  are the RECEPTION RUNNER's server-populated door payload on THIS run's
   *  channel. The runner (`reception-recipe-runner.ts`) hands the recipe the
   *  visitor submission + the server-opened order projection under exactly
   *  these keys; on every OTHER channel the same `context.*` fields would be
   *  caller-populated (the same laundering hole `eventContextTrusted`
   *  guards), so the host sets this `true` ONLY when the run's
   *  `execution_source.channel === 'reception'`. Absent/false ⇒ these roots
   *  REFUSE open (fail closed — the pre-N.14 behavior, verbatim). When
   *  trusted they classify `door_submission` (clean → varies): the riding
   *  class is bounded by the grant's `bound_recipe.recipe_hash` (the D-207
   *  static-analyzability posture — visitor input is data, never control)
   *  and by the N.14 `bound_contract_id` door binding. */
  readonly doorSubmissionTrusted?: boolean;
  /** Resolve one full `{{ns.path}}` ref string against the run's live
   *  stores, `deferVault`-style (`{{vault.*}}` returns the ref string
   *  itself). The host closes this over the same stores the hash basis
   *  resolves against, so a pinned value and the dispatched value can never
   *  diverge. */
  readonly resolveRootValue: (ref: string) => unknown;
  /** Deep-resolve one UNRESOLVED merged value (the arg skeleton) against
   *  the same stores + `deferVault` — the rule-6 derived-pin basis for a
   *  tainted-fed authority arg. Must be the host's `resolveDeep` over the
   *  hash-basis stores so the derived pin equals what dispatches. */
  readonly resolveArgValue: (unresolvedValue: unknown) => unknown;
  /** Manifest-kind lookup for producing-step classification: `'ai'` steps
   *  PROPAGATE (rule 4); every other ingredient kind is an IO boundary the
   *  walk cannot see past — refuse. Unknown slug ⇒ refuse. */
  readonly getIngredientKind: (slug: string) => string | undefined;
  /** D-177 N.11 rule 1 — per-row stored-cleanliness lookup. Given the
   *  CANONICAL `data.*` ref string (post alias-rewrite, e.g.
   *  `data.contact.jane.doe@example.com.annotations.preferred_channel`),
   *  resolve it to exactly ONE stored row and return that row's stamped
   *  provenance facets — or `undefined` whenever the ref does not name
   *  one unambiguous gateable row (unknown collection, no such record,
   *  dotted-id ambiguity, plural-row grammar). The host closes this over
   *  its live warehouse stores; dotted record ids (canonical contact
   *  emails) are the host's to disambiguate (store-assisted — only the
   *  store knows which key exists). MUST be synchronous and MUST re-read
   *  the live row on every call: the per-fire re-walk is what re-asks
   *  when a row's writer changes between fires.
   *
   *  Absent (non-server hosts, tests) ⇒ every `data.*` root stays
   *  `'stored'` (tainted → pinned) — exactly the pre-follow-on
   *  behavior. The walker applies `isUserCleanStoredRow` itself; the
   *  callback only reports facets, so a host cannot accidentally loosen
   *  the predicate. */
  readonly resolveStoredRowOrigin?: (
    canonicalRef: string,
  ) => StoredRowProvenance | undefined;
}

// ────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────

/** Step-object fields that gate/control rather than flow into the output —
 *  excluded from taint propagation. `skip_when` / `fail_on` select WHETHER
 *  the value exists, not WHAT it is; `foreach` is handled explicitly by the
 *  `item.*` arm; the rest are engine plumbing. */
const STEP_CONTROL_FIELDS: ReadonlySet<string> = new Set([
  'id', 'transform', 'guard', 'ingredient', 'op', 'skip_when', 'fail_on',
  'cache', 'foreach', 'output', 'optional', 'ingredient_version',
  'timeout_ms', 'on_timeout', 'prompt', 'pii_fields', 'connection', 'pages',
]);

/** Thrown internally to unwind a walk into a refusal. Never escapes
 *  `computeOpenProjection`. */
class OpenWalkRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Mutable node-count budget threaded through the pin/skeleton clones
 *  (codex LOW fold). One per `computeOpenProjection` call; each visited
 *  node debits it, and exhaustion refuses the whole walk. */
interface NodeBudget {
  remaining: number;
}

const debit = (budget: NodeBudget): void => {
  if (budget.remaining <= 0) throw new OpenWalkRefusal('node_budget_exhausted');
  budget.remaining -= 1;
};

/** Extract the value an authority path names — mirroring
 *  `canonicalArgHash`'s `removePath` precedence (codex MEDIUM fold): a
 *  LITERAL flat dotted key wins first (catalog wire keys land flat, e.g.
 *  `"body.to"`), then segment traversal (nested `body: { to }`). Without
 *  the flat-first check the walk would SKIP a flat-keyed authority arg the
 *  hash still guards — desyncing what's pinned from what's hashed, so a
 *  same-shape change to the flat value could pass open matching. No array
 *  indexing — an authority path names arg KEYS; a path landing on an array
 *  pins/walks the whole array value. */
const valueAtPath = (obj: Record<string, unknown>, path: string): unknown => {
  if (Object.prototype.hasOwnProperty.call(obj, path)) {
    return obj[path];
  }
  let current: unknown = obj;
  for (const seg of path.split('.')) {
    if (
      current === null
      || typeof current !== 'object'
      || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, seg)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
};

/** True when a (statically declared) value tree contains a `file_ref` key —
 *  the D-172 multimodal handle. An `ai-*` step reading file CONTENT pulls
 *  warehouse bytes the static walk cannot classify (the row is mutable
 *  between fires while the recipe JSON is not) — refuse (rule 2 fail-closed
 *  default). */
const containsFileRefKey = (value: unknown, depth = 0): boolean => {
  if (depth > MAX_WALK_DEPTH || value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((v) => containsFileRefKey(v, depth + 1));
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'file_ref') return true;
    if (containsFileRefKey(v, depth + 1)) return true;
  }
  return false;
};

/** JSON-clean defensive clone for a pinned value: `undefined` → `null`
 *  (canonical JSON cannot carry undefined; an unresolvable root pins as
 *  null and matches a future unresolvable resolution), prototype-sensitive
 *  keys dropped, non-JSON leaves (functions, bigints, non-finite numbers,
 *  class instances like Date) REFUSE — a value the canonical form cannot
 *  represent unambiguously must not anchor authority (same posture as the
 *  P1a hash primitive). */
const toPinnedJson = (value: unknown, budget: NodeBudget, depth = 0): unknown => {
  if (depth > MAX_WALK_DEPTH) throw new OpenWalkRefusal('pinned_value_too_deep');
  debit(budget);
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new OpenWalkRefusal('pinned_value_not_json');
      return value;
    case 'object':
      break;
    default:
      throw new OpenWalkRefusal('pinned_value_not_json');
  }
  if (Array.isArray(value)) return value.map((v) => toPinnedJson(v, budget, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new OpenWalkRefusal('pinned_value_not_json');
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = toPinnedJson(v, budget, depth + 1);
  }
  return out;
};

/** Skeleton clone — the unresolved merged value, verbatim, with the same
 *  JSON-clean discipline (an unresolvable skeleton refuses). `undefined`
 *  object members erase exactly as the wire projection erases them. */
const toSkeletonJson = (value: unknown, budget: NodeBudget, depth = 0): unknown => {
  if (depth > MAX_WALK_DEPTH) throw new OpenWalkRefusal('skeleton_too_deep');
  debit(budget);
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new OpenWalkRefusal('skeleton_not_json');
      return value;
    case 'object':
      break;
    default:
      throw new OpenWalkRefusal('skeleton_not_json');
  }
  if (Array.isArray(value)) {
    return value.map((v) => (v === undefined ? null : toSkeletonJson(v, budget, depth + 1)));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new OpenWalkRefusal('skeleton_not_json');
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v === undefined) continue;
    out[k] = toSkeletonJson(v, budget, depth + 1);
  }
  return out;
};

interface RawRoot {
  readonly ref: string;
  readonly origin: OpenOriginClass;
}

// ────────────────────────────────────────────────────────────────
// The walk
// ────────────────────────────────────────────────────────────────

/** Walk one authority-bearing arg's ref graph to its boundary roots and
 *  classify each (rules 1–5 as narrowed above), then pin every
 *  pinning-class root by resolved value (rule 3) and assemble the normative
 *  structure + canonical hash (rule 6). Returns a refusal whenever ANY
 *  authority-bearing arg is unclassifiable or undecidable — the mint and
 *  the match both fail closed on a refused walk (rule 2).
 *
 *  Pure given the two callbacks; no clock, no I/O of its own. */
export const computeOpenProjection = (
  args: ComputeOpenProjectionArgs,
): OpenProjectionComputation | OpenProjectionRefusal => {
  // Index every step by id once. Duplicate ids refuse — the producing-step
  // lookup would be ambiguous (the validator rejects duplicates upstream,
  // but this walk trusts nothing it can re-check cheaply).
  const stepIndex = new Map<string, Record<string, unknown>>();
  for (const raw of args.steps) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const step = raw as Record<string, unknown>;
    if (typeof step.id !== 'string' || step.id.length === 0) continue;
    if (stepIndex.has(step.id)) {
      return { refused: `duplicate_step_id:${step.id}` };
    }
    stepIndex.set(step.id, step);
  }

  /** Per-walk memo for the rule-1 row lookup — one store read per
   *  distinct stored ref, and one CONSISTENT classification per walk
   *  even if the same ref is reached through several args (keeps the
   *  dedup's first-wins invariant exact). */
  const storedOriginMemo = new Map<string, OpenOriginClass>();
  const classifyStoredDataRef = (canonical: string): OpenOriginClass => {
    const memoized = storedOriginMemo.get(canonical);
    if (memoized !== undefined) return memoized;
    let origin: OpenOriginClass = 'stored';
    if (args.resolveStoredRowOrigin !== undefined) {
      try {
        const row = args.resolveStoredRowOrigin(canonical);
        if (row !== undefined && isUserCleanStoredRow(row)) {
          origin = 'stored_user';
        }
      } catch {
        // fail closed to `stored`
      }
    }
    storedOriginMemo.set(canonical, origin);
    return origin;
  };

  /** Classify one parsed ref into roots. `stepCtx` is the step whose body
   *  the ref appears in (anchors `item.*`); `visited` carries the step-id
   *  recursion guard. */
  const classifyRef = (
    ns: string,
    path: string,
    stepCtx: Record<string, unknown> | undefined,
    visited: ReadonlySet<string>,
    depth: number,
  ): RawRoot[] => {
    if (depth > MAX_WALK_DEPTH) throw new OpenWalkRefusal('walk_too_deep');
    const canonical = path.length > 0 ? `${ns}.${path}` : ns;
    switch (ns) {
      case 'meta':
        return [{ ref: canonical, origin: 'meta' }];
      case 'vault':
        return [{ ref: canonical, origin: 'vault' }];
      case 'config':
        // Model/caller-typed (chat tool args land here) — TAINTED (rule 2).
        return [{ ref: canonical, origin: 'config' }];
      case 'connection':
        // User-enrolled at Settings — clean (rule 2).
        return [{ ref: canonical, origin: 'connection' }];
      case 'context':
        // ONLY the trigger payload is classified, and ONLY on a trusted
        // event channel where the dispatcher stamps it (system event —
        // clean; codex HIGH fold). On chat/mcp/user the same field is
        // caller-populated, so a `context.event` root there is
        // model-controlled and must NOT be classed clean — refuse. Every
        // other context.* field (tabs, server, recipe — prior-run state!)
        // is off the closed table regardless of channel → refuse (rule 2).
        if (path === 'event' || path.startsWith('event.')) {
          if (args.eventContextTrusted === true) {
            return [{ ref: canonical, origin: 'context_event' }];
          }
          throw new OpenWalkRefusal(`untrusted_context_event:${canonical}`);
        }
        // N.14 — the reception runner's server-populated door payload
        // (visitor submission + server-opened order projection). Trusted
        // ONLY when the host attests the run is a reception-door dispatch
        // (`doorSubmissionTrusted` — same per-channel host attestation as
        // `eventContextTrusted` above); everywhere else these are
        // caller-populated `context.*` fields and refuse exactly as before.
        if (
          path === 'reception_submission'
          || path.startsWith('reception_submission.')
          || path === 'reception_order'
          || path.startsWith('reception_order.')
        ) {
          if (args.doorSubmissionTrusted === true) {
            return [{ ref: canonical, origin: 'door_submission' }];
          }
          throw new OpenWalkRefusal(`untrusted_door_submission:${canonical}`);
        }
        throw new OpenWalkRefusal(`unclassified_context_root:${canonical}`);
      case 'shared':
        // Recipe-writable cache tier — no per-row writer provenance;
        // TAINTED → pinned (rule 2 "unknown → TAINTED"). Never consults
        // the rule-1 callback.
        return [{ ref: canonical, origin: 'stored' }];
      case 'data': {
        // `data.shared.*` is the D-103 recipe-writable durable tier —
        // same posture as `shared.*` above, never gated per-row.
        if (path === 'shared' || path.startsWith('shared.')) {
          return [{ ref: canonical, origin: 'stored' }];
        }
        // Per-row origin_actor stored-cleanliness gate (N.11 rule 1).
        // The host resolves the ref to ONE row's stamped facets; the
        // walker owns the predicate (memoized per walk). Any failure
        // mode — callback absent, no unambiguous row, agent/system/
        // engine writer, throw — degrades to `stored` (tainted →
        // pinned), never to a refusal: pinning is always a sound
        // (stricter) answer for a stored read, and refusing here would
        // kill `open` for sibling args that are fine.
        return [{ ref: canonical, origin: classifyStoredDataRef(canonical) }];
      }
      case 'step':
      case 'trigger': {
        // Inherits the producing step (rule 2 — recursive walk). The path's
        // first segment is the step id; `trigger.*` reads trigger_steps
        // outputs through the same index.
        const stepId = path.split('.')[0] ?? '';
        if (stepId.length === 0) {
          throw new OpenWalkRefusal(`unanchored_step_ref:${canonical}`);
        }
        const producer = stepIndex.get(stepId);
        if (producer === undefined) {
          throw new OpenWalkRefusal(`unknown_producing_step:${stepId}`);
        }
        if (visited.has(stepId)) {
          throw new OpenWalkRefusal(`step_cycle:${stepId}`);
        }
        return walkProducingStep(producer, new Set([...visited, stepId]), depth + 1);
      }
      case 'item': {
        // Inherits the foreach/collection source's origin (rule 2). The
        // enclosing step's `foreach` binds engine iterations; a transform's
        // `input` collection binds its internal per-element item refs.
        if (stepCtx === undefined) {
          throw new OpenWalkRefusal('item_ref_without_step_context');
        }
        const source = stepCtx.foreach ?? (
          typeof stepCtx.transform === 'string' ? stepCtx.input : undefined
        );
        if (source === undefined || source === null) {
          throw new OpenWalkRefusal('item_ref_without_collection_source');
        }
        return walkValue(source, stepCtx, visited, depth + 1);
      }
      default:
        // prefs / account / contract / unknown vocabulary — off the closed
        // table, fail closed (rule 2).
        throw new OpenWalkRefusal(`unclassified_root:${canonical}`);
    }
  };

  /** Collect roots from one value (string templates, arrays, objects). */
  const walkValue = (
    value: unknown,
    stepCtx: Record<string, unknown> | undefined,
    visited: ReadonlySet<string>,
    depth: number,
  ): RawRoot[] => {
    if (depth > MAX_WALK_DEPTH) throw new OpenWalkRefusal('walk_too_deep');
    if (typeof value === 'string') {
      if (!value.includes('{{')) return [];
      // A dynamic nested key is statically unresolvable — which row/field
      // feeds the arg is itself runtime-chosen (rule 2: no `open`).
      if (hasNestedRef(value)) {
        throw new OpenWalkRefusal('dynamic_nested_ref');
      }
      const roots: RawRoot[] = [];
      for (const m of value.matchAll(/\{\{([^}]+)\}\}/g)) {
        const { ns, path } = parseRef(m[1].trim());
        if (!NS.has(ns as Namespace)) {
          throw new OpenWalkRefusal(`unknown_namespace:${ns}`);
        }
        roots.push(...classifyRef(ns, path, stepCtx, visited, depth + 1));
      }
      return roots;
    }
    if (Array.isArray(value)) {
      const roots: RawRoot[] = [];
      for (const v of value) roots.push(...walkValue(v, stepCtx, visited, depth + 1));
      return roots;
    }
    if (value !== null && typeof value === 'object') {
      const roots: RawRoot[] = [];
      for (const v of Object.values(value as Record<string, unknown>)) {
        roots.push(...walkValue(v, stepCtx, visited, depth + 1));
      }
      return roots;
    }
    return [];
  };

  /** Propagate through one producing step (rule 4): transforms / guards /
   *  `ai`-kind ingredients carry their inputs' taint; every other step kind
   *  is an IO boundary whose output origin the static walk cannot see —
   *  refuse. */
  const walkProducingStep = (
    step: Record<string, unknown>,
    visited: ReadonlySet<string>,
    depth: number,
  ): RawRoot[] => {
    if (depth > MAX_WALK_DEPTH) throw new OpenWalkRefusal('walk_too_deep');
    if (typeof step.op === 'string') {
      // Canonical op-step — a catalog IO dispatch (external read).
      throw new OpenWalkRefusal(`io_step_output:${String(step.id)}`);
    }
    if (typeof step.ingredient === 'string') {
      const kind = args.getIngredientKind(step.ingredient);
      if (kind !== 'ai') {
        // http / dom / chat / mcp / storage / connection / service /
        // unknown — output is external-world or warehouse content the
        // static walk cannot classify. (Direct `{{data.*}}` refs ARE
        // classified — as `stored`; an IO FETCH's output is not a ref.)
        throw new OpenWalkRefusal(`io_step_output:${String(step.id)}`);
      }
      const input = step.input;
      if (input !== undefined && (input === null || typeof input !== 'object')) {
        throw new OpenWalkRefusal(`malformed_ai_step_input:${String(step.id)}`);
      }
      const inputObj = (input ?? {}) as Record<string, unknown>;
      // `llm.allow_search` pulls EXTERNAL web content into the output —
      // not propagation. Fail closed on any truthy declaration.
      if (inputObj['llm.allow_search'] !== undefined
        && inputObj['llm.allow_search'] !== false) {
        throw new OpenWalkRefusal(`ai_allow_search:${String(step.id)}`);
      }
      // A `file_ref` handle reads mutable warehouse bytes (D-172) the
      // static walk cannot pin — refuse.
      if (containsFileRefKey(inputObj)) {
        throw new OpenWalkRefusal(`ai_file_ref:${String(step.id)}`);
      }
      return walkValue(inputObj, step, visited, depth + 1);
    }
    if (typeof step.transform === 'string' || typeof step.guard === 'string') {
      // Flat propagation over every data-bearing field (D-024 flat params).
      const roots: RawRoot[] = [];
      for (const [k, v] of Object.entries(step)) {
        if (STEP_CONTROL_FIELDS.has(k)) continue;
        roots.push(...walkValue(v, step, visited, depth + 1));
      }
      // A transform's `input` collection is data-bearing even though item
      // refs also resolve through it — it flows into the output directly
      // (filter/sort/slice pass elements through).
      if (step.input !== undefined) {
        roots.push(...walkValue(step.input, step, visited, depth + 1));
      }
      return roots;
    }
    throw new OpenWalkRefusal(`unrecognized_step_shape:${String(step.id)}`);
  };

  // ── Assemble ──────────────────────────────────────────────────
  try {
    const budget: NodeBudget = { remaining: OPEN_PROJECTION_MAX_NODES };
    const gatedStep =
      args.gatedStepId !== undefined ? stepIndex.get(args.gatedStepId) : undefined;
    // Dedup authority paths; drop paths absent from the merged args (the
    // arg_shape_hash pins absence — a fire that ADDS the key reshapes and
    // re-asks).
    const projArgs: OpenProjectionArg[] = [];
    const seenPaths = new Set<string>();
    for (const path of args.authorityPaths) {
      if (typeof path !== 'string' || path.length === 0 || seenPaths.has(path)) {
        continue;
      }
      seenPaths.add(path);
      const value = valueAtPath(args.mergedArgs, path);
      if (value === undefined) continue;
      const raw = walkValue(value, gatedStep, new Set<string>(), 0);
      // Dedup by canonical ref; a ref reached twice with DIFFERENT origins
      // is impossible (classification is a pure function of the ref +
      // recipe, and the rule-1 row lookup is memoized per walk), so
      // first-wins is safe. Sort for canonical order.
      const byRef = new Map<string, RawRoot>();
      for (const r of raw) {
        if (!byRef.has(r.ref)) byRef.set(r.ref, r);
      }
      const roots: OpenProjectionRoot[] = [...byRef.values()]
        .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
        .map((r) =>
          OPEN_PINNED_ORIGINS.has(r.origin)
            ? {
                ref: r.ref,
                origin: r.origin,
                pinned: toPinnedJson(args.resolveRootValue(`{{${r.ref}}}`), budget),
              }
            : { ref: r.ref, origin: r.origin },
        );
      // Rule 6 — "and of any authority value derived from one": a tainted
      // root anywhere in the arg's graph pins the arg's RESOLVED value too.
      // Root pins alone do not survive a non-deterministic propagator (an
      // `ai-*` step can sample a different destination off the same pinned
      // prompt); the derived pin makes any such drift re-ask.
      const tainted = roots.some((r) => OPEN_TAINTED_ORIGINS.has(r.origin));
      projArgs.push({
        path,
        skeleton: toSkeletonJson(value, budget),
        roots,
        ...(tainted
          ? { derived_pinned: toPinnedJson(args.resolveArgValue(value), budget) }
          : {}),
      });
    }
    if (projArgs.length === 0) {
      // Nothing to guard ⇒ nothing sound to grant — an open grant over an
      // empty authority set would admit ANY same-shape payload.
      return { refused: 'no_authority_args_present' };
    }
    projArgs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const projection: OpenProjection = { version: 1, args: projArgs };
    const serialized = canonicalJSONStringify(projection);
    if (new TextEncoder().encode(serialized).length > OPEN_PROJECTION_MAX_BYTES) {
      return { refused: 'projection_over_size_cap' };
    }
    return {
      projection,
      pinned_projection_hash: sha256Hex(serialized),
      preview: buildPreview(projection),
    };
  } catch (e) {
    if (e instanceof OpenWalkRefusal) return { refused: e.reason };
    // Anything unexpected refuses too — the walk is an offer/mint
    // precondition, never a dispatch dependency.
    return { refused: `walk_error:${e instanceof Error ? e.message : String(e)}` };
  }
};

// ────────────────────────────────────────────────────────────────
// Preview + stored-structure validation
// ────────────────────────────────────────────────────────────────

const renderPreviewValue = (value: unknown): string => {
  let s: string;
  try {
    s = JSON.stringify(value) ?? 'null';
  } catch {
    s = String(value);
  }
  return s.length > PREVIEW_VALUE_MAX_CHARS
    ? `${s.slice(0, PREVIEW_VALUE_MAX_CHARS - 1)}…`
    : s;
};

/** Render the pinned/varies summary off a computed projection. A pure
 *  literal arg (no ref roots) renders one pinned line off its skeleton —
 *  the destination IS the literal. Lists are capped at
 *  `OPEN_PREVIEW_MAX_LINES` per side (rendering only — the projection and
 *  its hash are never truncated). */
const buildPreview = (projection: OpenProjection): OpenProjectionPreview => {
  const pinned: Array<{ label: string; value: string }> = [];
  const varying: Array<{ label: string; origin: string }> = [];
  for (const arg of projection.args) {
    if (arg.roots.length === 0) {
      pinned.push({ label: arg.path, value: renderPreviewValue(arg.skeleton) });
      continue;
    }
    // A tainted-fed arg's derived pin IS the human-relevant line — the
    // actual resolved destination that must stay put. Root pins render
    // beneath it with their provenance arrows.
    if ('derived_pinned' in arg) {
      pinned.push({
        label: arg.path,
        value: renderPreviewValue(arg.derived_pinned),
      });
    }
    for (const root of arg.roots) {
      if (OPEN_PINNED_ORIGINS.has(root.origin)) {
        pinned.push({
          label: `${arg.path} ← ${root.ref}`,
          value: renderPreviewValue(root.pinned),
        });
      } else {
        varying.push({ label: `${arg.path} ← ${root.ref}`, origin: root.origin });
      }
    }
  }
  return {
    pinned: pinned.slice(0, OPEN_PREVIEW_MAX_LINES),
    varying: varying.slice(0, OPEN_PREVIEW_MAX_LINES),
  };
};

const isKnownOrigin = (v: unknown): v is OpenOriginClass =>
  v === 'meta' || v === 'vault' || v === 'config' || v === 'stored'
  || v === 'stored_user' || v === 'context_event' || v === 'connection'
  || v === 'door_submission';

/** Fail-closed structural validation of a STORED `open_projection` row
 *  value (N.4 `'open'` arm: "every authority-bearing arg classified — else
 *  fail closed"). Rows are JSON; a hand-shaped or future-vocabulary row
 *  must read as NOT well-formed and never match. Pure. */
export const isWellFormedOpenProjection = (value: unknown): value is OpenProjection => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (!Array.isArray(v.args) || v.args.length === 0) return false;
  for (const rawArg of v.args) {
    if (rawArg === null || typeof rawArg !== 'object' || Array.isArray(rawArg)) {
      return false;
    }
    const arg = rawArg as Record<string, unknown>;
    if (typeof arg.path !== 'string' || arg.path.length === 0) return false;
    if (!('skeleton' in arg)) return false;
    if (!Array.isArray(arg.roots)) return false;
    let taintedArg = false;
    for (const rawRoot of arg.roots) {
      if (rawRoot === null || typeof rawRoot !== 'object' || Array.isArray(rawRoot)) {
        return false;
      }
      const root = rawRoot as Record<string, unknown>;
      if (typeof root.ref !== 'string' || root.ref.length === 0) return false;
      if (!isKnownOrigin(root.origin)) return false;
      // A pinning-class root must carry its pinned value; a varying-class
      // root must not (a stray pin would imply vocabulary this version
      // doesn't define — fail closed).
      if (OPEN_PINNED_ORIGINS.has(root.origin)) {
        if (!('pinned' in root)) return false;
      } else if ('pinned' in root) {
        return false;
      }
      if (OPEN_TAINTED_ORIGINS.has(root.origin)) taintedArg = true;
    }
    // Rule 6 — a tainted-fed arg must carry its derived pin; a clean-only
    // arg must not (presence discipline mirrors the root-level rule).
    if (taintedArg !== ('derived_pinned' in arg)) return false;
  }
  return true;
};
