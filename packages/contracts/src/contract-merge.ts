/** D-166 §"Merge algebra formalization" — the pure contract-policy merge engine.
 *
 *  D-165 sketched stricter-wins-plus-merge-card for `grant_resolution`; D-166
 *  proves well-definedness for every `applies_to` role by giving each policy
 *  field a lattice + an explicit `stricter_direction`, and each `merge_rule` a
 *  deterministic composition rule. This module is that engine — pure, storage-
 *  and context-agnostic. It operates on generic `Record<field, value>` rows
 *  whose keys are CANONICAL policy-field names (the `FIELD_LATTICES` keys), NOT
 *  on the D-165 value_shapes directly. The `composeForRole(role, context)`
 *  dispatcher (which reads the contract store, builds paths from a resolution
 *  context, and projects each scope's value_shape onto these canonical fields)
 *  + the `tightening_only` write-time enforcement that consumes `wouldLoosen`
 *  land in a later slice; this slice is the provable core.
 *
 *  Determinism (D-166 §"Composition determinism"): every merge_rule is
 *  commutative + associative on its lattice fields, so composition is
 *  order-independent WITHIN a precedence level. The two order-dependent cases —
 *  `union` taking the last primitive value, and `override` taking the last row —
 *  are deterministic only when same-precedence rows agree; `composeRows`
 *  surfaces any same-precedence disagreement as a `MergeConflict` (the gateway
 *  raises a merge card at write-time, D-165 Q22).
 *
 *  Spec: D-166 §"Merge algebra formalization" (lines 257–329) +
 *  §"Composition algorithm (final form)" (386–414). */

import type { MergeRule } from './contract-schema.js';
import { RISK_TIERS } from './ingredient.js';

// ════════════════════════════════════════════════════════════════
// Field lattices
// ════════════════════════════════════════════════════════════════

export type FieldDomain = 'enum' | 'set' | 'integer' | 'bool';
/** Which end of the lattice is "stricter" — consulted by `stricter_wins` /
 *  `tightening_only`. `high` = the greater element is stricter; `low` = the
 *  lesser. */
export type StricterDirection = 'high' | 'low';

export interface FieldLattice {
  domain: FieldDomain;
  /** enum only — ordered elements low → high. */
  order?: readonly string[];
  /** integer only — inclusive domain floor (`timeout_ms` ≥ 1, `cache_ttl_ms`
   *  ≥ 0). A value below it (or a non-integer) is rejected before ranking — the
   *  `number?` value_shape is looser than the lattice's integer domain. */
  min?: number;
  stricter_direction: StricterDirection;
}

/** The policy-field lattice registry (D-166 §"Lattice structures + stricter
 *  direction per field", spec table) — the canonical fields a contract row's value
 *  projects onto (via `POLICY_PROJECTIONS`) and how each ranks. A field NOT in this
 *  registry is treated as an opaque primitive under `union` / `override` (take-last);
 *  the stricter-family rules never see non-lattice fields for the policy roles.
 *  (D-187 dropped the matrix-only `approval_tier` / `allowed_kinds` / `allowed_risk_tiers`
 *  / `denied_ingredient_ids` entries with the policy matrix — `policy_matrix_cell` was
 *  their only projection producer.) */
export const FIELD_LATTICES: Readonly<Record<string, FieldLattice>> = {
  approval: { domain: 'enum', order: ['never', 'ask', 'always'], stricter_direction: 'high' },
  risk_tier: { domain: 'enum', order: RISK_TIERS, stricter_direction: 'high' },
  max_risk_without_approval: {
    domain: 'enum',
    order: ['none', 'read', 'write', 'admin'],
    stricter_direction: 'low',
  },
  denied_operation_ids: { domain: 'set', stricter_direction: 'high' },
  approval_required_operation_ids: { domain: 'set', stricter_direction: 'high' },
  // D-166 Slice 4a — OPERATIONS-level allow set. `merge_card_resolution`'s
  // `resolved_operations` projects here (the resolved allowed set for a contested
  // group); dynamic operation-id membership lives fine in a `set`. ∅ = strictest
  // (stricter LOW → set intersection).
  allowed_operation_ids: { domain: 'set', stricter_direction: 'low' },
  timeout_ms: { domain: 'integer', min: 1, stricter_direction: 'low' },
  cache_ttl_ms: { domain: 'integer', min: 0, stricter_direction: 'low' },
  allowed: { domain: 'bool', stricter_direction: 'low' },
};

/** A row value carried a field value the lattice can't rank (an enum value
 *  outside its order, a non-number integer, a non-array set, …). Validation
 *  (D-165's value_shape descriptors) should prevent this reaching the engine;
 *  thrown rather than silently mis-merged so malformed data surfaces loudly. */
export class ContractMergeError extends Error {
  constructor(detail: string) {
    super(`contract_merge_invalid: ${detail}`);
    this.name = 'ContractMergeError';
  }
}

// ── lattice primitives ──────────────────────────────────────────

const scalarRank = (field: string, lattice: FieldLattice, v: unknown): number => {
  if (lattice.domain === 'enum') {
    const i = (lattice.order ?? []).indexOf(v as string);
    if (i < 0) {
      throw new ContractMergeError(
        `field '${field}': ${JSON.stringify(v)} not in enum lattice [${(lattice.order ?? []).join('|')}]`,
      );
    }
    return i;
  }
  if (lattice.domain === 'integer') {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new ContractMergeError(`field '${field}': expected an integer, got ${JSON.stringify(v)}`);
    }
    if (lattice.min !== undefined && v < lattice.min) {
      throw new ContractMergeError(`field '${field}': ${v} is below the domain floor ${lattice.min}`);
    }
    return v;
  }
  // bool — false < true
  if (typeof v !== 'boolean') {
    throw new ContractMergeError(`field '${field}': expected a boolean, got ${JSON.stringify(v)}`);
  }
  return v ? 1 : 0;
};

const asSet = (field: string, v: unknown): readonly unknown[] => {
  if (!Array.isArray(v)) {
    throw new ContractMergeError(`field '${field}': expected an array (set), got ${JSON.stringify(v)}`);
  }
  return v;
};

/** Canonical (sorted, de-duplicated) set — makes set results order-independent
 *  so the array representation matches the set semantics under `toEqual`. */
const canonicalSet = (items: readonly unknown[]): unknown[] => {
  const seen = new Map<string, unknown>();
  for (const it of items) seen.set(JSON.stringify(it), it);
  return [...seen.values()].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
};

const unionSet = (a: readonly unknown[], b: readonly unknown[]): unknown[] => canonicalSet([...a, ...b]);
const intersectSet = (a: readonly unknown[], b: readonly unknown[]): unknown[] => {
  const bKeys = new Set(b.map((x) => JSON.stringify(x)));
  return canonicalSet(a.filter((x) => bKeys.has(JSON.stringify(x))));
};
const isSubset = (a: readonly unknown[], b: readonly unknown[]): boolean => {
  const bKeys = new Set(b.map((x) => JSON.stringify(x)));
  return a.every((x) => bKeys.has(JSON.stringify(x)));
};

/** The stricter of two values for a lattice field (the meet/join toward
 *  `stricter_direction`). Sets: union when stricter is `high` (more denied =
 *  stricter), intersection when `low` (fewer allowed = stricter). Scalars: the
 *  value at the stricter rank; equal ranks return `a` (deterministic). */
const stricterOf = (field: string, lattice: FieldLattice, a: unknown, b: unknown): unknown => {
  if (lattice.domain === 'set') {
    const sa = asSet(field, a);
    const sb = asSet(field, b);
    return lattice.stricter_direction === 'high' ? unionSet(sa, sb) : intersectSet(sa, sb);
  }
  const ra = scalarRank(field, lattice, a);
  const rb = scalarRank(field, lattice, b);
  if (ra === rb) return a;
  const aStricter = lattice.stricter_direction === 'high' ? ra > rb : ra < rb;
  return aStricter ? a : b;
};

/** Whether `value` is at least as strict as `ref` for a lattice field — the
 *  tightening partial order. Sets: superset (high) / subset (low). */
const isAtLeastAsStrict = (
  field: string,
  lattice: FieldLattice,
  value: unknown,
  ref: unknown,
): boolean => {
  if (lattice.domain === 'set') {
    const sv = asSet(field, value);
    const sr = asSet(field, ref);
    return lattice.stricter_direction === 'high' ? isSubset(sr, sv) : isSubset(sv, sr);
  }
  const rv = scalarRank(field, lattice, value);
  const rr = scalarRank(field, lattice, ref);
  return lattice.stricter_direction === 'high' ? rv >= rr : rv <= rr;
};

/** Validate + canonicalize one lattice-field value. Scalars are range-checked
 *  (throws on a bad enum / non-integer / out-of-floor / non-bool); sets are
 *  validated as arrays and returned canonical (sorted, de-duped). Applied to
 *  EVERY lattice value the engine accepts — a lone first value, a `union`
 *  take-last, and the operands of a merge all pass through the same gate, so a
 *  malformed value can't slip through just because it wasn't merged. */
const normalizeLatticeValue = (field: string, lattice: FieldLattice, v: unknown): unknown => {
  if (lattice.domain === 'set') return canonicalSet(asSet(field, v));
  scalarRank(field, lattice, v);
  return v;
};

// ════════════════════════════════════════════════════════════════
// applyMergeRule — fold one row's value into the accumulator
// ════════════════════════════════════════════════════════════════

/** Compose one row's `value` into `acc` per `rule` (D-166 §"Composition rules
 *  per merge_rule"). `acc` is the running aggregate of all lower-or-equal
 *  precedence rows; `value` is the current (higher-or-equal precedence) row, so
 *  "take last / highest precedence" = take `value`'s field. Pure — neither
 *  argument is mutated. */
export const applyMergeRule = (
  acc: Readonly<Record<string, unknown>>,
  value: Readonly<Record<string, unknown>>,
  rule: MergeRule,
): Record<string, unknown> => {
  // override — the highest-precedence row wins entirely; prior rows discarded.
  // Validate + canonicalize its lattice fields too, so a malformed value
  // (`approval: 'bogus'`, `timeout_ms: 0`) fails closed rather than becoming
  // effective policy; non-lattice fields pass through opaquely.
  if (rule === 'override') {
    const out: Record<string, unknown> = {};
    for (const [field, v] of Object.entries(value)) {
      if (v === undefined) continue;
      const lattice = Object.prototype.hasOwnProperty.call(FIELD_LATTICES, field)
        ? FIELD_LATTICES[field]
        : undefined;
      out[field] = lattice ? normalizeLatticeValue(field, lattice, v) : v;
    }
    return out;
  }

  const result: Record<string, unknown> = { ...acc };
  const strictRule =
    rule === 'stricter_wins' || rule === 'tightening_only' || rule === 'union_with_stricter_wins';
  for (const [field, incoming0] of Object.entries(value)) {
    if (incoming0 === undefined) continue;
    const lattice = Object.prototype.hasOwnProperty.call(FIELD_LATTICES, field)
      ? FIELD_LATTICES[field]
      : undefined;
    // The stricter-family rules are defined ONLY over lattice fields — a
    // non-lattice field can't be ranked, so silently taking-last would break
    // order-independence (detectConflicts assumes these rules never conflict)
    // and could drop a stricter value. Throw so un-projected rows (a value_shape
    // field not yet mapped onto a canonical lattice field) surface loudly.
    if (strictRule && !lattice) {
      throw new ContractMergeError(
        `field '${field}': a '${rule}' row must use canonical lattice fields (no lattice for '${field}')`,
      );
    }
    // Validate + canonicalize every lattice value up front so a lone first value
    // (no prior) and a union take-last are gated like a merge operand.
    const incoming = lattice ? normalizeLatticeValue(field, lattice, incoming0) : incoming0;
    const prior = result[field];
    if (prior === undefined) {
      result[field] = incoming;
      continue;
    }
    if (!lattice) {
      // union — non-lattice opaque primitive, take last (highest precedence).
      result[field] = incoming;
      continue;
    }
    switch (rule) {
      case 'union':
        result[field] =
          lattice.domain === 'set'
            ? unionSet(asSet(field, prior), asSet(field, incoming))
            : incoming; // primitive — take last
        break;
      case 'stricter_wins':
      case 'tightening_only':
        // tightening_only composes like stricter_wins; the looser-rejection step
        // is a write-time check (wouldLoosen), not a compose-time concern.
        result[field] = stricterOf(field, lattice, prior, incoming);
        break;
      case 'union_with_stricter_wins':
        result[field] =
          lattice.domain === 'set'
            ? unionSet(asSet(field, prior), asSet(field, incoming))
            : stricterOf(field, lattice, prior, incoming);
        break;
      default: {
        // exhaustiveness guard — a new merge_rule must extend this switch.
        const _never: never = rule;
        throw new ContractMergeError(`unhandled merge_rule '${String(_never)}'`);
      }
    }
  }
  return result;
};

// ════════════════════════════════════════════════════════════════
// composeRows — reduce a role's contributing rows into one policy
// ════════════════════════════════════════════════════════════════

export interface ContractMergeRow {
  value: Readonly<Record<string, unknown>>;
  merge_precedence: number;
  merge_rule: MergeRule;
}

/** A same-precedence situation the order-dependent rules can't resolve
 *  deterministically — surfaced for the gateway's write-time merge card
 *  (D-165 Q22). `kind: 'value'` = a single rule's field disagreement (`union`
 *  primitive take-last, or `override` whole-row INCL. presence/absence, since an
 *  override row replaces wholesale); `kind: 'mixed_rule'` = the bucket mixes
 *  merge_rules, so composition is order-dependent regardless of field values
 *  (e.g. an `override` row discards what a `union` row merged). */
export interface MergeConflict {
  kind: 'value' | 'mixed_rule';
  merge_precedence: number;
  /** The conflicting field, or `'*'` for a bucket-level `mixed_rule` conflict. */
  field: string;
  /** The rule(s) involved — one for `value`, the distinct bucket rules for `mixed_rule`. */
  rules: MergeRule[];
  /** Distinct conflicting values (`value` only; empty for `mixed_rule`). */
  values: unknown[];
}

export interface ComposeResult {
  policy: Record<string, unknown>;
  conflicts: MergeConflict[];
}

/** A field is a "primitive" for conflict purposes when it is NOT a set-domain
 *  lattice field (sets union cleanly, so they never conflict under `union`). */
const isPrimitiveField = (field: string): boolean => {
  const l = Object.prototype.hasOwnProperty.call(FIELD_LATTICES, field) ? FIELD_LATTICES[field] : undefined;
  return !l || l.domain !== 'set';
};

/** Comparison key for conflict detection, consistent with how `applyMergeRule`
 *  treats the field: a set-domain LATTICE field is canonicalized — order-
 *  insensitive, since both `override` and the set-merge rules normalize it the
 *  same way — while every other field (a primitive lattice field, or a
 *  non-lattice opaque array taken raw under `override` / `union` take-last)
 *  compares RAW, so `['a','b']` and `['b','a']` are the genuinely-different
 *  policies they would produce. */
const conflictKey = (field: string, v: unknown): string => {
  const lattice = Object.prototype.hasOwnProperty.call(FIELD_LATTICES, field)
    ? FIELD_LATTICES[field]
    : undefined;
  if (lattice?.domain === 'set' && Array.isArray(v)) return JSON.stringify(canonicalSet(v));
  return JSON.stringify(v);
};

const collectFieldConflicts = (
  rows: readonly ContractMergeRow[],
  prec: number,
  rule: MergeRule,
  includeField: (field: string) => boolean,
  absenceIsDistinct: boolean,
  out: MergeConflict[],
): void => {
  if (rows.length < 2) return;
  const fields = new Set<string>();
  for (const r of rows) {
    for (const f of Object.keys(r.value)) {
      if (r.value[f] !== undefined && includeField(f)) fields.add(f);
    }
  }
  for (const field of fields) {
    const distinct = new Map<string, unknown>();
    let sawAbsent = false;
    for (const r of rows) {
      const v = r.value[field];
      if (v === undefined) sawAbsent = true;
      else distinct.set(conflictKey(field, v), v);
    }
    // For override, a field present in one row but absent in another is itself a
    // disagreement — the whole row replaces, so absence "discards" the field.
    const variants = distinct.size + (absenceIsDistinct && sawAbsent ? 1 : 0);
    if (variants > 1) {
      out.push({ kind: 'value', merge_precedence: prec, field, rules: [rule], values: [...distinct.values()] });
    }
  }
};

const detectConflicts = (rows: readonly ContractMergeRow[]): MergeConflict[] => {
  const byPrecedence = new Map<number, ContractMergeRow[]>();
  for (const r of rows) {
    const g = byPrecedence.get(r.merge_precedence);
    if (g) g.push(r);
    else byPrecedence.set(r.merge_precedence, [r]);
  }
  const conflicts: MergeConflict[] = [];
  for (const [prec, group] of byPrecedence) {
    if (group.length < 2) continue;
    const rules = [...new Set(group.map((r) => r.merge_rule))];
    if (rules.length > 1) {
      // Mixed rules at one precedence level — composition is order-dependent
      // regardless of field values, so the level can't compose deterministically.
      conflicts.push({ kind: 'mixed_rule', merge_precedence: prec, field: '*', rules, values: [] });
      continue;
    }
    // Single-rule bucket. The stricter-family rules (stricter_wins /
    // tightening_only / union_with_stricter_wins) are commutative + associative
    // → never conflict; only override (whole-row, presence-sensitive) and union
    // (primitive take-last) are order-dependent.
    const [rule] = rules;
    if (rule === 'override') {
      collectFieldConflicts(group, prec, 'override', () => true, true, conflicts);
    } else if (rule === 'union') {
      collectFieldConflicts(group, prec, 'union', isPrimitiveField, false, conflicts);
    }
  }
  return conflicts;
};

/** Compose a role's contributing rows into one policy + any same-precedence
 *  conflicts (D-166 §"Composition algorithm"). Rows are reduced in ascending
 *  `merge_precedence` from an empty policy (a missing field = no contribution).
 *  Conflict-free results are order-independent; conflicts are reported, not
 *  silently resolved. Pure. */
export const composeRows = (rows: readonly ContractMergeRow[]): ComposeResult => {
  const conflicts = detectConflicts(rows);
  const ordered = [...rows].sort((a, b) => a.merge_precedence - b.merge_precedence);
  const policy = ordered.reduce<Record<string, unknown>>(
    (acc, row) => applyMergeRule(acc, row.value, row.merge_rule),
    {},
  );
  return { policy, conflicts };
};

// ════════════════════════════════════════════════════════════════
// wouldLoosen — the tightening_only write-time predicate
// ════════════════════════════════════════════════════════════════

/** The fields of `value` that would LOOSEN `aggregate` (the running aggregate of
 *  prior rows) — i.e. are strictly less strict than the current value. Empty ⇒
 *  the write only tightens (or holds) every field, so a `tightening_only` write
 *  is admissible. A field absent from `aggregate` carries no prior constraint and
 *  is skipped. `tightening_only` is a strict rule, so every field of `value` must
 *  be a canonical lattice field — a non-lattice field can't be checked for
 *  loosening, and skipping it would silently admit a loosening write, so it
 *  throws `ContractMergeError` (consistent with `applyMergeRule`'s strict-rule
 *  contract). The store's write path (a later slice) rejects when this is
 *  non-empty. */
export const wouldLoosen = (
  aggregate: Readonly<Record<string, unknown>>,
  value: Readonly<Record<string, unknown>>,
): string[] => {
  const loosening: string[] = [];
  for (const [field, incoming0] of Object.entries(value)) {
    if (incoming0 === undefined) continue;
    const lattice = Object.prototype.hasOwnProperty.call(FIELD_LATTICES, field)
      ? FIELD_LATTICES[field]
      : undefined;
    if (!lattice) {
      throw new ContractMergeError(
        `field '${field}': a tightening_only write must use canonical lattice fields (no lattice for '${field}')`,
      );
    }
    // Validate (+ canonicalize) the value even with no prior constraint, so a
    // malformed write like { timeout_ms: 0 } is rejected, not silently admitted
    // just because the field is new to the aggregate.
    const incoming = normalizeLatticeValue(field, lattice, incoming0);
    if (!Object.prototype.hasOwnProperty.call(aggregate, field)) continue; // no prior constraint
    const current = aggregate[field];
    if (current === undefined) continue;
    if (!isAtLeastAsStrict(field, lattice, incoming, current)) loosening.push(field);
  }
  return loosening;
};
