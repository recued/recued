/** D-177 P1 — the canonical action-identity primitive.
 *
 *  One canonicalization, two hashes, one consumer story. The `ActionEnvelope`
 *  (N.1) is a *named view* over fields the commit already carries plus three
 *  stamped at recipe canonicalization. This module owns the stamped three:
 *
 *    - `arg_shape_hash`        — the arg KEY SKELETON (paths + JSON types,
 *                                values erased). Drift guard: "did the arg
 *                                schema change?"
 *    - `canonical_payload_hash` — the arg VALUES after volatile exclusions.
 *                                Identity guard: "is this the same payload?"
 *
 *  Both are SHA-256 over the shared `@recued/crypto` canonical-JSON serializer
 *  (stable key order, no whitespace) — the SAME primitive D-148 signs with, so
 *  there is exactly one canonicalization in the codebase (N.7: this also
 *  subsumes the held-dedup `config_snapshot` stringify in a later slice).
 *
 *  HASH BASIS (normative, N.2). The caller supplies the args to hash; this
 *  module is basis-agnostic and pure. The stamping integration (a later P1
 *  slice) MUST pass the RESOLVED args — post-`{{config.*}}`/`{{step.*}}`/
 *  `{{item.*}}` interpolation, but with `{{vault.*}}` refs left UNRESOLVED so
 *  no secret enters the hash. Note `Commit.args` deliberately stores the
 *  *unresolved* template (secret-free + reusable as a save-as-Recipe
 *  template), so these hashes are computed from the resolved payload at
 *  canonicalization and stamped ALONGSIDE the unresolved `args` — they are
 *  siblings, not a re-hash of `Commit.args`.
 *
 *  VOLATILE EXCLUSIONS. `hash_exclude_args` (op-declared, never recipe- or
 *  Gateway-authored — N.2) removes per-call noise (client timestamps,
 *  correlation tokens) from `canonical_payload_hash` so an honest exact repeat
 *  still matches. Exclusions are fail-closed for authority-bearing paths
 *  (`validateHashExcludeArgs`): an op may never exclude a path that selects a
 *  destination / entity / connection / risk — else "exact repeat" could
 *  silently re-aim. The shape hash is NOT reduced by exclusions: a volatile
 *  field's key+type is stable across fires, and pinning the full schema is the
 *  strictly-safer choice (an excluded field that flaps presence re-asks). */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';
import type { ExecutionSource } from './commits.js';
import type { RiskTier } from './ingredient.js';

/** The two stamped identity hashes (N.1). Lowercase SHA-256 hex. */
export interface ArgHashes {
  /** Hash of the arg key skeleton (paths + JSON types; values erased). */
  readonly arg_shape_hash: string;
  /** Hash of the canonical arg values, after volatile exclusions. */
  readonly canonical_payload_hash: string;
}

/** The compact canonical envelope the Gateway hot path evaluates (N.1).
 *  A NAMED VIEW: every field except the three stamped hashes already lives
 *  on the commit (`@recued/contracts` `Commit`); this interface names the
 *  tuple the gate reads, carrying `ExecutionSource` verbatim (no parallel
 *  channel enum — D3). Constructing/stamping it onto the commit is a later
 *  P1 slice; the type is the contract. */
export interface ActionEnvelope {
  readonly recipe_id: string;
  /** Content identity — pins the grant to the exact recipe (replaces the
   *  draft's `recipe_version`; editing a recipe invalidates its grants). */
  readonly recipe_hash: string;
  readonly ingredient_slug: string;
  /** Catalog path (D-165); absent for simple-form ingredients. */
  readonly operation_id?: string;
  readonly connection_name?: string;
  /** The `(channel × actor × contract_id?)` triple, verbatim. */
  readonly source: ExecutionSource;
  readonly risk_tier: RiskTier;
  readonly idempotency_key: string;
  readonly channel_session_id: string;
  /** Stamped at canonicalization — the key skeleton (N.2). */
  readonly arg_shape_hash: string;
  /** Stamped at canonicalization — the value payload (N.2). */
  readonly canonical_payload_hash: string;
  /** Primary-entity binding when the op declares one; per gated call. */
  readonly entity_scope?: string;
}

/** Op-level volatile-exclusion declaration (N.2). Dot-paths into the args
 *  object — `'client_ts'`, `'body.properties.requested_at'`. Object-key
 *  paths only (array-index traversal is unsupported and validated out). */
export type HashExcludeArgs = readonly string[];

/** A JSON type tag for the shape skeleton. Mirrors the JSON value kinds; a
 *  `null` leaf is its own tag (distinct from an absent key). */
type JsonTypeTag = 'string' | 'number' | 'boolean' | 'null';

/** Internal: a deep clone restricted to JSON-shaped values. We never hash a
 *  caller's live object (exclusion mutates a copy) and `structuredClone`
 *  isn't guaranteed in every bundle target, so clone explicitly. Inputs are
 *  pre-asserted JSON-clean (`assertJsonClean`), so only string/number/boolean/
 *  null/array/plain-object reach here. Generated objects are NULL-PROTOTYPE:
 *  an own JSON key named `__proto__` (legal, e.g. from `JSON.parse`) must
 *  become an own data key, not silently reset the prototype — on a
 *  null-proto target `out['__proto__'] = v` defines an own key. */
const cloneJson = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  const out: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(value as Record<string, unknown>)) {
    out[k] = cloneJson((value as Record<string, unknown>)[k]);
  }
  return out;
};

/** True for a plain (non-array, non-null) object — the only container an
 *  exclusion path may descend through. Loose by design (used only on
 *  pre-asserted-clean values, where Date/Map/etc. cannot appear). */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strict: a plain data object (`{}` / `Object.create(null)`), NOT a Date /
 *  Map / RegExp / class instance. Used by the fail-closed cleanliness gate. */
const isPlainDataObject = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Fail-closed gate: throw on any value the hash cannot represent
 *  UNAMBIGUOUSLY. A security primitive over model-authored args must reject
 *  rather than let a non-JSON value COLLAPSE into a colliding hash — the
 *  lenient canonical serializer maps `NaN`/`±Infinity` → `null` (so distinct
 *  values collide) and omits `undefined` object values (so `{a:undefined,b:1}`
 *  collides with `{b:1}`); `Date`/`Map` → `{}`. The caller MUST treat a throw
 *  as "cannot compute action identity" → hold for approval, never mint a
 *  grant. Walks the whole structure so the offending path is named. */
const assertJsonClean = (value: unknown, path: string): void => {
  const here = path || '<root>';
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalArgHash: non-finite number at '${here}'`);
    }
    return;
  }
  if (t !== 'object') {
    // undefined / bigint / function / symbol.
    throw new TypeError(`canonicalArgHash: non-JSON ${t} at '${here}'`);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new TypeError(`canonicalArgHash: sparse-array hole at '${here}[${i}]'`);
      }
      assertJsonClean(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (!isPlainDataObject(value as object)) {
    throw new TypeError(
      `canonicalArgHash: non-plain object (Date/Map/RegExp/instance) at '${here}'`,
    );
  }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    assertJsonClean((value as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
  }
};

/** Remove one dot-path from a cloned args object. Two spellings of the same
 *  path are both removed (D-177 P1b):
 *
 *    1. A LITERAL own key equal to the whole dotted path — the connection-api
 *       wire-key form catalog operations use (`'body.client_ts'` is one flat
 *       key on the dispatch input, not a nested `body` object).
 *    2. Segment-wise descent through plain objects — the nested form.
 *
 *  An exclusion declares "this path is volatile", so removing both spellings
 *  is the faithful application; exclusions are fail-closed validated against
 *  authority paths upstream, so the wider removal can never widen authority.
 *  A path that resolves under neither spelling is a no-op (the value hash is
 *  unchanged) — `validateHashExcludeArgs` is where a malformed/forbidden path
 *  is rejected loudly; application is forgiving so a stale exclusion never
 *  throws mid-dispatch. */
const removePath = (root: Record<string, unknown>, path: string): void => {
  // Literal flat-key spelling first (catalog wire keys). Only meaningful for
  // a dotted path — a single-segment path is identical under both spellings.
  if (Object.prototype.hasOwnProperty.call(root, path)) delete root[path];
  const segments = path.split('.');
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    // OWN-key only: never descend an inherited member (defense-in-depth —
    // a `__proto__`/`constructor` segment can't reach a shared prototype,
    // independent of the null-proto clone + `validateHashExcludeArgs` gate).
    if (!Object.prototype.hasOwnProperty.call(cursor, segments[i])) return;
    const next = cursor[segments[i]];
    if (!isPlainObject(next)) return; // path doesn't resolve → no-op
    cursor = next;
  }
  const leaf = segments[segments.length - 1];
  if (Object.prototype.hasOwnProperty.call(cursor, leaf)) delete cursor[leaf];
};

/** Project a JSON value to its SHAPE skeleton: every scalar leaf becomes its
 *  type tag, objects/arrays keep their structure. Canonical-JSON of the
 *  skeleton is then position- and key-sorted-stable. `{to:"x",n:5}` and
 *  `{to:"y",n:9}` share a skeleton; `{to:"x"}` and `{to:5}` do not. */
const shapeSkeleton = (value: unknown): unknown => {
  if (value === null) return 'null' satisfies JsonTypeTag;
  if (Array.isArray(value)) return value.map(shapeSkeleton);
  if (isPlainObject(value)) {
    // Null-proto target — an own `__proto__` key becomes a data key in the
    // skeleton instead of resetting the prototype (same hazard as cloneJson).
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(value)) out[k] = shapeSkeleton(value[k]);
    return out;
  }
  const t = typeof value;
  // Inputs are pre-asserted JSON-clean, so only string/number/boolean reach
  // here. Anything else is an internal-invariant violation, not an input
  // error — fail loud rather than emit a silently-degraded skeleton.
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return t satisfies JsonTypeTag;
  }
  throw new TypeError(`shapeSkeleton: unexpected ${t} (input not pre-asserted clean?)`);
};

/** D-177 P1b — project resolved args to their JSON WIRE form before hashing.
 *
 *  Template resolution legitimately yields `undefined` (an unset optional
 *  `{{config.*}}` ref resolves to undefined), and the dispatched payload's
 *  wire form erases it: `JSON.stringify` — and the shared canonical
 *  serializer's own lenient rule — omits `undefined` object values and
 *  nulls `undefined` array elements. Two calls differing only in a
 *  resolved-undefined optional field produce the SAME wire effect, so
 *  hashing them equal is the faithful identity, not a collision. This
 *  projection applies exactly that erasure — and ONLY that erasure —
 *  ahead of `canonicalArgHash`'s fail-closed gate:
 *
 *    - object entries whose value is `undefined` → omitted
 *    - array elements that are `undefined`        → `null`
 *
 *  Everything else passes through untouched: non-finite numbers, Dates,
 *  functions, bigints still reach `assertJsonClean` and THROW — those are
 *  adapter-shape anomalies with no unambiguous wire form, where "cannot
 *  compute action identity → hold" remains the right answer. `undefined`
 *  is different in kind: it is the resolver's well-defined "absent"
 *  signal with a principled JSON projection.
 *
 *  Pure — returns a fresh null-prototype structure (an own `__proto__`
 *  key stays an own data key, as in `cloneJson`); the input is never
 *  mutated. Stamping callers (the commit Gateway, held-dedup) compose
 *  `canonicalArgHash(projectResolvedArgs(resolved), …)`. */
export const projectResolvedArgs = (
  args: Record<string, unknown>,
): Record<string, unknown> =>
  projectValue(args) as Record<string, unknown>;

const projectValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((v) => (v === undefined ? null : projectValue(v)));
  }
  // STRICT plain-data check — this runs BEFORE `assertJsonClean`, so a
  // Date/Map/class instance must pass through UNTOUCHED to be rejected
  // there. The loose `isPlainObject` would walk a Date's (empty) own keys
  // and silently collapse it to `{}` — the exact collision the fail-closed
  // gate exists to prevent.
  if (typeof value === 'object' && value !== null && isPlainDataObject(value)) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(obj)) {
      if (obj[k] === undefined) continue;
      out[k] = projectValue(obj[k]);
    }
    return out;
  }
  return value;
};

/** Compute the two D-177 identity hashes for a tool call's args (N.2).
 *
 *  Pure + deterministic. `arg_shape_hash` covers the full key skeleton (NOT
 *  reduced by exclusions); `canonical_payload_hash` covers the values with
 *  `excludePaths` removed. Pass the resolved-minus-vault args (see module
 *  doc). `args` is treated read-only — exclusions mutate a clone.
 *
 *  THROWS `TypeError` (fail-closed) if `args` is not JSON-clean — non-finite
 *  numbers, `undefined`/`bigint`/`function`/`symbol` values, sparse-array
 *  holes, or non-plain objects (Date/Map/…). Callers MUST treat a throw as
 *  "cannot compute action identity" and hold for approval (never mint a
 *  grant): the alternative — a silently-collapsed hash — is a grant
 *  collision (N.2). */
export const canonicalArgHash = (
  args: Record<string, unknown>,
  opts: { readonly excludePaths?: HashExcludeArgs } = {},
): ArgHashes => {
  assertJsonClean(args, '');
  const shape = shapeSkeleton(args);
  const arg_shape_hash = sha256Hex(canonicalJSONStringify(shape));

  const payload = cloneJson(args) as Record<string, unknown>;
  for (const path of opts.excludePaths ?? []) removePath(payload, path);
  const canonical_payload_hash = sha256Hex(canonicalJSONStringify(payload));

  return { arg_shape_hash, canonical_payload_hash };
};

/** Why a `hash_exclude_args` declaration was rejected. */
export type HashExcludeViolationReason =
  | 'empty_path'
  | 'authority_bearing'
  | 'destination_name'
  | 'array_traversal'
  | 'reserved_segment';

/** Prototype-reserved path segments — never a legitimate exclusion target,
 *  and a defense-in-depth backstop against prototype traversal in
 *  `removePath` (which also requires own-keys + clones null-proto). */
const RESERVED_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** D-177 N.2 backstop — well-known DESTINATION leaf names that select where a
 *  call goes (recipient / channel / calendar / destination-source), matched on
 *  the path's LEAF segment regardless of any op declaration. The primary
 *  authority check (`pathsOverlap` against `authorityBearingPaths`) only
 *  protects args the op DECLARED authority-bearing (wire targets ∪ `path_scope`
 *  tokens ∪ `affects_target` editable args ∪ `authority_args`); a semantic
 *  recipient expressed as a plain body/query arg an author neglected to declare
 *  would otherwise be excludable, dropping the destination out of
 *  `canonical_payload_hash` so an exact grant approved for `to=alice` admits
 *  `to=bob` (the model re-aims a destination — exactly what N.2's "exact repeat
 *  means what the approver saw" forbids). This denylist is a strict
 *  improvement: it can only force an arg back INTO the hash basis (more
 *  pinning), never let one out, so it never loosens a grant match — it only
 *  rejects a publish-time exclusion DECLARATION. Covers the spec's enumerated
 *  destinations (recipient / calendar id / channel / connection selectors) +
 *  the D-167/D-173 target-affecting leaf set. Entity/object-record ids beyond
 *  this set still rely on the declaration mechanisms (`path_scope` /
 *  `affects_target` / `authority_args`) — generic `*_id` is deliberately NOT
 *  denylisted, so a legitimate volatile `trace_id` / `correlation_id` /
 *  `request_id` exclusion still validates. */
const DESTINATION_LEAF_NAMES: ReadonlySet<string> = new Set([
  // communication recipients
  'to', 'cc', 'bcc', 'recipient', 'recipients',
  'recipient_email', 'recipient_emails', 'to_email', 'to_emails',
  'destination', 'destinations', 'dest',
  'email', 'emails', 'email_address', 'email_addresses',
  'attendee', 'attendees',
  'phone', 'phone_number', 'phone_numbers', 'to_number', 'msisdn',
  'address', 'to_address',
  // channel / conversation targets
  'channel', 'channel_id', 'chat_id', 'conversation_id',
  'room', 'room_id', 'thread_id',
  // calendar / destination-source / connection selectors
  // (mirrors the D-167/D-173 target-affecting leaf set)
  'calendar', 'calendar_id', 'source_id', 'destination_source_id',
  'connection_id', 'connection_name',
]);

/** The trailing segment of a dot-path (`body.to` → `to`, `to` → `to`). */
const leafSegment = (path: string): string => {
  const idx = path.lastIndexOf('.');
  return idx === -1 ? path : path.slice(idx + 1);
};

export interface HashExcludeViolation {
  readonly path: string;
  readonly reason: HashExcludeViolationReason;
}

export interface HashExcludeValidation {
  readonly ok: boolean;
  readonly violations: readonly HashExcludeViolation[];
}

/** Fail-closed gate on an op's `hash_exclude_args` (N.2). Runs at the curated
 *  catalog trust surface, NOT at dispatch. An exclusion may never target an
 *  authority-bearing path (the destination / entity / connection / risk set —
 *  the same set the grant pins). `authorityBearingPaths` is the op's declared
 *  authority set; a declared exclusion that equals, prefixes, or is prefixed
 *  by an authority path is rejected (excluding `body` would drop a nested
 *  `body.to`; excluding `body.to.name` still touches the `body.to` selector).
 *
 *  Pure — the caller (op-schema validation) owns the authority list. Empty
 *  and array-index segments are rejected so an exclusion can't be a silent
 *  no-op that reads as coverage. A `'destination_name'` backstop additionally
 *  rejects a leaf that names a well-known destination (`to` / `recipient` /
 *  `calendar_id` / `channel` / …) even when the op never declared it
 *  authority-bearing (`DESTINATION_LEAF_NAMES`) — closing the latent gap where
 *  an undeclared semantic recipient could be excluded from the grant hash. */
export const validateHashExcludeArgs = (
  excludePaths: HashExcludeArgs,
  authorityBearingPaths: readonly string[],
): HashExcludeValidation => {
  const violations: HashExcludeViolation[] = [];
  for (const path of excludePaths) {
    const segments = path.split('.');
    if (path.length === 0 || segments.some((s) => s.length === 0)) {
      violations.push({ path, reason: 'empty_path' });
      continue;
    }
    if (segments.some((s) => RESERVED_SEGMENTS.has(s))) {
      violations.push({ path, reason: 'reserved_segment' });
      continue;
    }
    if (segments.some((s) => /^\d+$/.test(s))) {
      // A numeric segment is an array index — unsupported by `removePath`,
      // so it would silently fail to exclude. Reject rather than no-op.
      violations.push({ path, reason: 'array_traversal' });
      continue;
    }
    if (authorityBearingPaths.some((a) => pathsOverlap(path, a))) {
      violations.push({ path, reason: 'authority_bearing' });
      continue;
    }
    // D-177 N.2 backstop — a destination-shaped leaf is never excludable, even
    // when the op did NOT declare it authority-bearing (the gap this closes).
    // Runs AFTER the declared-authority check so a declared destination still
    // reports `authority_bearing`; this only catches an UNDECLARED one.
    if (DESTINATION_LEAF_NAMES.has(leafSegment(path).toLowerCase())) {
      violations.push({ path, reason: 'destination_name' });
    }
  }
  return { ok: violations.length === 0, violations };
};

/** True when two dot-paths are equal or one is an ancestor of the other —
 *  segment-wise (so `body.to` overlaps `body.to.name` but `body.t` does not
 *  overlap `body.to`). */
const pathsOverlap = (a: string, b: string): boolean => {
  const as = a.split('.');
  const bs = b.split('.');
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) if (as[i] !== bs[i]) return false;
  return true;
};
