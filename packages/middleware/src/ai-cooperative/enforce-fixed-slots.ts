/** D-145 PB5 — `enforceFixedSlots` substrate runtime gate.
 *
 *  Per § B.6.8. Drops every alternative whose `args[slot]` deep-differs
 *  from the request's `args[slot]` for any field listed in
 *  `fixed_slots`. The dropped alternative + violation kind + slot name
 *  flow up to the caller (`processActionResult`) which forwards them
 *  to the Transparency Stream + audit emission.
 *
 *  Pure function — no IO, no side effects. The caller is responsible
 *  for emitting `fixed_slot_drift` Transparency Stream events for every
 *  returned violation.
 *
 *  Invariant: empty `fixed_slots` means "nothing fixed" — every
 *  alternative passes (per § B.6.7 examples like "Find me a date for
 *  tonight" if AI mistakenly chooses an empty set; AI is responsible
 *  for declaring `fixed_slots` correctly per § B.6.5 Trust invariant).
 *  PB5 doesn't second-guess the fixed_slots declaration — the
 *  intent-level discipline lives in AI / spec / benchmark layers.
 *
 *  Spec: § B.6.5 + § B.6.8 + § B.6.9. */

import type {
  ActionRequest,
  ActionResult,
  FixedSlotInvariantViolation,
} from '@recued/contracts';

/** Output of `enforceFixedSlots` — surviving alternatives + the
 *  dropped ones with violation reason. The caller (typically
 *  `processActionResult`) re-shapes into `ProcessedActionResult`. */
export interface EnforceFixedSlotsResult<TArgs> {
  readonly survivors: ReadonlyArray<{
    readonly args: TArgs;
    readonly confidence: number;
    readonly annotation?: string;
    /** Index of this alternative in the original `result.alternatives`
     *  array — preserves audit-replay correlation. */
    readonly original_index: number;
  }>;
  readonly violations: ReadonlyArray<FixedSlotInvariantViolation>;
}

/** Codex P1 #2 fold — sanitize a slot keyname before it lands on the
 *  Transparency Stream / audit log. AI-supplied `fixed_slots` are
 *  developer-provided in TypeScript (closed to `keyof TArgs`) but the
 *  runtime substrate still receives an unknown string at the wire
 *  layer. Per § B.2.3 audit privacy contract, every value that lands
 *  in a Transparency Stream payload must be closed-character-set.
 *
 *  Maps to JS identifier shape (`[A-Za-z_][A-Za-z0-9_]*`) bounded by
 *  `MAX_LENGTH`. Non-conforming chars become `'_'`; over-long names
 *  truncate with a `'…'` marker (audit reader sees the truncation,
 *  doesn't lose the prefix). Empty / non-string input collapses to
 *  `'<invalid>'` — distinguishable from any legitimate slot. */
const SLOT_NAME_MAX_LENGTH = 64;
const SLOT_NAME_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const sanitizeSlotForAudit = (slot: unknown): string => {
  if (typeof slot !== 'string' || slot.length === 0) return '<invalid>';
  if (SLOT_NAME_IDENTIFIER_RE.test(slot) && slot.length <= SLOT_NAME_MAX_LENGTH) {
    return slot;
  }
  // Replace any char outside the identifier set with `_` to keep the
  // audit shape readable + closed-character-set.
  let out = '';
  for (const ch of slot) {
    if (/[A-Za-z0-9_]/.test(ch)) {
      out += ch;
      if (out.length >= SLOT_NAME_MAX_LENGTH) break;
    } else {
      out += '_';
      if (out.length >= SLOT_NAME_MAX_LENGTH) break;
    }
  }
  // Identifier rule: must NOT start with a digit. Prepend `_` if it does.
  if (/^[0-9]/.test(out)) out = `_${out}`.slice(0, SLOT_NAME_MAX_LENGTH);
  if (out.length === SLOT_NAME_MAX_LENGTH && slot.length > SLOT_NAME_MAX_LENGTH) {
    // Mark truncation so audit reader knows the prefix is bounded.
    out = `${out.slice(0, SLOT_NAME_MAX_LENGTH - 1)}…`;
  }
  return out.length === 0 ? '<invalid>' : out;
};

/** Deep equality used for fixed-slot comparison. Symmetric, terminates
 *  on cycles via WeakMap seen-pair tracking (DOS-safe — Codex P1 #1
 *  fold), handles JSON-extended types kernel ingredients realistically
 *  pass through fixed_slots:
 *    - Date — compare via getTime() so equivalent timestamps match
 *    - RegExp — compare via source + flags
 *    - Map / Set — reference identity only (kernel ingredient args
 *      should not embed Map/Set in fixed-slot values; substrate is
 *      defensive but not exhaustive)
 *    - Symbol-keyed properties — ignored (fixed_slots are typed as
 *      `keyof TArgs` which TS narrows to string|number; Symbol keys
 *      cannot appear at the gate boundary)
 *    - Array, plain object — recursively compared
 *    - Functions — reference identity (legitimate kernel ingredients
 *      do not pass functions through ActionResult wire)
 *
 *  Returns false for value pairs the substrate cannot prove equal — a
 *  conservative gate is preferable to a leaky one (per § B.6.5 Trust
 *  invariant: "Alternatives that violate semantic intent are worse
 *  than no alternatives"). */
const deepEqual = (a: unknown, b: unknown, seen?: WeakMap<object, WeakSet<object>>): boolean => {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') {
    // Number — handle NaN explicitly (NaN !== NaN by default; treat as equal).
    if (typeof a === 'number' && typeof b === 'number') {
      return Number.isNaN(a) && Number.isNaN(b);
    }
    return false;
  }
  // ── Codex P1 #1: cycle guard ─────────────────────────────────────
  // Track the (a, b) pair we're currently comparing. If we see the
  // same pair again deeper in the recursion, treat it as equal — both
  // sides are mutually self-referential at the same offset.
  const seenMap = seen ?? new WeakMap<object, WeakSet<object>>();
  const ao = a as object;
  const bo = b as object;
  let aBucket = seenMap.get(ao);
  if (aBucket && aBucket.has(bo)) return true;
  if (!aBucket) {
    aBucket = new WeakSet<object>();
    seenMap.set(ao, aBucket);
  }
  aBucket.add(bo);

  // ── Date ─────────────────────────────────────────────────────────
  if (a instanceof Date) {
    if (!(b instanceof Date)) return false;
    return a.getTime() === b.getTime();
  }
  if (b instanceof Date) return false;

  // ── RegExp ───────────────────────────────────────────────────────
  if (a instanceof RegExp) {
    if (!(b instanceof RegExp)) return false;
    return a.source === b.source && a.flags === b.flags;
  }
  if (b instanceof RegExp) return false;

  // ── Map / Set — reference identity only ──────────────────────────
  // Kernel ingredient ActionResult wire payloads are JSON-shaped per
  // the spec; Map/Set legitimate cases are rare. Substrate refuses to
  // prove equality of two distinct Map/Set objects to stay closed.
  if (a instanceof Map || b instanceof Map) return false;
  if (a instanceof Set || b instanceof Set) return false;

  // ── Array ────────────────────────────────────────────────────────
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], seenMap)) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  // ── Plain object — reject non-Object.prototype prototypes ────────
  // Class instances (other than the explicitly-handled JSON-extended
  // types above) fall through to "not equal unless reference-identical".
  const aProto = Object.getPrototypeOf(ao);
  const bProto = Object.getPrototypeOf(bo);
  if (aProto !== null && aProto !== Object.prototype) return false;
  if (bProto !== null && bProto !== Object.prototype) return false;

  const aor = ao as Record<string, unknown>;
  const bor = bo as Record<string, unknown>;
  const aKeys = Object.keys(aor);
  const bKeys = Object.keys(bor);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bor, k)) return false;
    if (!deepEqual(aor[k], bor[k], seenMap)) return false;
  }
  return true;
};

/** § B.6.8 — substrate runtime gate. Drops alternatives whose
 *  `fixed_slots` field-values drift from the request. Returns the
 *  survivors + the dropped+reason pairs.
 *
 *  Empty alternatives input → empty survivors + zero violations.
 *  Empty fixed_slots input → all alternatives pass (every alternative
 *  trivially preserves zero fixed slots).
 *
 *  When `fixed_slots` references a key that does not exist on the
 *  request's `args`, the substrate flags `fixed_slot_unknown_field`
 *  for every alternative against that slot — defensive against typos
 *  / stale ingredient code. */
export const enforceFixedSlots = <TArgs>(
  req: ActionRequest<TArgs>,
  result: ActionResult<TArgs>,
): EnforceFixedSlotsResult<TArgs> => {
  const alternatives = result.alternatives ?? [];
  if (alternatives.length === 0) {
    return { survivors: [], violations: [] };
  }
  const violations: FixedSlotInvariantViolation[] = [];
  const survivors: Array<{
    readonly args: TArgs;
    readonly confidence: number;
    readonly annotation?: string;
    readonly original_index: number;
  }> = [];

  // Detect unknown fixed-slot field names against the request's args.
  // We allow `args` to be any TArgs shape, but a `fixed_slot` that is
  // not a key of `args` is always a bug.
  const reqArgs = req.args as unknown;
  const reqKeysSet =
    reqArgs !== null && typeof reqArgs === 'object'
      ? new Set(Object.keys(reqArgs as Record<string, unknown>))
      : new Set<string>();

  for (let i = 0; i < alternatives.length; i++) {
    const alt = alternatives[i]!;
    let dropped = false;
    for (const slot of req.fixed_slots) {
      const slotKey = slot as unknown as string;
      // Codex P1 #2 fold: every violation event carries a sanitized
      // slot keyname so AI-supplied junk text can't reach the
      // Transparency Stream / audit log payload (§ B.2.3 audit privacy
      // contract — closed-character-set values only).
      const safeSlot = sanitizeSlotForAudit(slotKey);
      // Detect unknown-field violations first. Even if the alternative
      // happens to deep-match an undefined value on both sides, the
      // ingredient's declaration is still wrong — surface it.
      if (typeof slotKey !== 'string' || !reqKeysSet.has(slotKey)) {
        violations.push({
          kind: 'fixed_slot_unknown_field',
          slot: safeSlot,
          alternative_index: i,
        });
        dropped = true;
        // We continue scanning so all violations across slots land in
        // the audit (helps ingredient authors fix multiple typos in
        // one pass) — but this alternative is already disqualified.
        continue;
      }
      const reqValue = (req.args as Record<string, unknown>)[slotKey];
      const altValue = (alt.args as Record<string, unknown>)[slotKey];
      if (!deepEqual(reqValue, altValue)) {
        violations.push({
          kind: 'fixed_slot_drift',
          slot: safeSlot,
          alternative_index: i,
        });
        dropped = true;
        continue;
      }
    }
    if (!dropped) {
      survivors.push({
        args: alt.args,
        confidence: alt.confidence,
        ...(alt.annotation !== undefined ? { annotation: alt.annotation } : {}),
        original_index: i,
      });
    }
  }

  return { survivors, violations };
};
