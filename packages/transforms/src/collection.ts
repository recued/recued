import type { ConditionOp, Condition } from '@recued/contracts';
import { CANONICAL_SYSTEM_FIELDS, formatHint, interpolationText } from '@recued/contracts';
import type { TransformFn, SortField, ReduceOp } from './types.js';
import { getField, evaluateOp } from './evaluate.js';
import { evaluateMathExpression } from './numeric.js';
import { applyValueParam, getTransformSchema } from './schemas.js';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const setSafe = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  if (DANGEROUS_KEYS.has(key)) return;
  target[key] = value;
};

/** D-119 Phase 12 — copy `_id` + `_collection` from `source` onto
 *  `target` when the source carries them and target doesn't. Used by
 *  `map.expression` to keep object-template projections canonical-
 *  ref-addressable by default. Author-supplied `_*` in the template
 *  always wins. Mongo / CouchDB convention. */
const preserveCanonicalFields = (
  source: unknown,
  target: Record<string, unknown>,
): Record<string, unknown> => {
  if (source == null || typeof source !== 'object' || Array.isArray(source)) {
    return target;
  }
  const src = source as Record<string, unknown>;
  for (const sf of CANONICAL_SYSTEM_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(src, sf) &&
      !Object.prototype.hasOwnProperty.call(target, sf)
    ) {
      target[sf] = src[sf];
    }
  }
  return target;
};

export const filter: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr)) return [];

  if (Array.isArray(p.conditions)) {
    const conds = p.conditions as Condition[];
    // mode 'all' (default) → AND across conditions (every must match)
    // mode 'any'           → OR  across conditions (at least one matches)
    const useAny = p.mode === 'any';
    const predicate = (item: unknown): boolean => {
      const test = (c: Condition): boolean =>
        evaluateOp(getField(item, c.field), c.operator as ConditionOp, c.value);
      return useAny ? conds.some(test) : conds.every(test);
    };
    return arr.filter(predicate);
  }

  // Single-condition mode: { array, field, operator, value }
  const field = p.field as string;
  const op = p.operator as ConditionOp;
  return arr.filter(item => evaluateOp(getField(item, field), op, p.value));
};

export const sort: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr)) return [];
  const fields = (p.fields ?? [{ field: p.field, direction: p.direction ?? 'asc' }]) as SortField[];
  return [...arr].sort((a, b) => {
    for (const { field, direction } of fields) {
      const av = getField(a, field), bv = getField(b, field);
      // Missing values (null / undefined) always sort LAST, regardless of
      // `direction`. A desc sort must NOT float them to the top — otherwise a
      // "top N by value" ranking on a nullable field (e.g. deal amount, account
      // revenue) would rank the value-LESS rows #1. So the null verdict is
      // direction-INDEPENDENT; `direction` only orders the present values.
      if (av == null || bv == null) {
        if (av == null && bv == null) continue; // tie on this field → next field
        return av == null ? 1 : -1; // the missing one goes after the present one
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
};

export const map: TransformFn = (p, ctx) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr)) return [];

  // Expression mode: { array, expression, output_field? }
  // The expression is either a simple {{item.path}} lookup, an object/array
  // template with embedded {{item.*}} refs, or a math expression that mixes
  // operators and {{item.*}} references (e.g. "{{item.amount}} * {{item.prob}} / 100").
  //
  // When output_field is provided, the computed value is attached to each
  // original item as a new field — downstream steps like `sum` can then
  // aggregate that field. Without output_field, returns a flat array of
  // computed values.
  if (p.expression !== undefined) {
    const outputField = p.output_field as string | undefined;
    return arr.map(item => {
      const value = resolveExpression(p.expression, item);
      if (outputField) {
        // Spread on item already preserves `_*`; nothing extra needed.
        const out = { ...(item as Record<string, unknown>) };
        setSafe(out, outputField, value);
        return out;
      }
      // D-119 Phase 12 — when the expression projects an object
      // template, the resulting object loses the source item's
      // canonical refs unless we copy them. Other expression shapes
      // (pure ref returning a scalar, math expression returning a
      // number, raw value) deliberately leave the canonical realm —
      // they're not record projections.
      if (
        value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
      ) {
        return preserveCanonicalFields(item, value as Record<string, unknown>);
      }
      return value;
    });
  }

  // Apply mode: { array, apply, field, ...params, output_field }
  if (p.apply) {
    // An unknown apply target is a silent-corruption hazard, not a degrade
    // case: returning the array unchanged ships rows whose output_field is
    // simply missing, and downstream filters / aggregates compute on
    // nothing (s13 spot-run: two recipes shipped with ingredient slugs in
    // `apply` and never produced a real result). Fail loud — the validator
    // rejects this at authoring time; this throw covers dynamic shapes.
    const fn = ctx.getTransform?.(p.apply as string);
    if (!fn) {
      throw new Error(
        `map apply: "${String(p.apply)}" is not a registered transform`
        + ` — ingredient slugs cannot run inside a transform step; use a`
        + ` foreach ingredient step (or D-162 batch mode for ai-*) instead`,
      );
    }
    // Inject the per-item value under the TARGET transform's value param
    // (shared table — see APPLY_VALUE_PARAM in schemas.ts). The legacy
    // field-present → `from` rule fed every non-date_diff target an
    // undefined value.
    const valueParam = applyValueParam(p.apply as string);
    // A target whose schema never declares that param cannot RECEIVE the item
    // value: it computes on undefined and returns its own empty case, once per
    // row, with nothing raised. `join` did exactly that before it was added to
    // the table — every row got `""` because join reads `array` and the value
    // arrived as `input`. The recipe validator already refuses this at
    // authoring time (`apply_target_incompatible`, derived from the same
    // schema); this is the dynamic-shape half that the unregistered-target
    // throw above already covers for its own case. A target with no schema
    // entry at all is left alone rather than guessed at.
    const targetSchema = getTransformSchema(p.apply as string);
    if (targetSchema !== undefined && !(valueParam in targetSchema)) {
      throw new Error(
        `map apply: "${String(p.apply)}" has no "${valueParam}" parameter`
        + ` — it cannot receive the per-item value and would compute on`
        + ` undefined for every row; use expression mode or a different target`,
      );
    }
    const outputField = p.output_field as string;
    const { array: _, apply: __, output_field: ___, ...subParams } = p;
    return arr.map(item => {
      const input = { ...subParams, [valueParam]: getField(item, p.field as string) };
      const result = fn(input as Record<string, unknown>, ctx);
      const out = { ...(item as Record<string, unknown>) };
      setSafe(out, outputField, result);
      return out;
    });
  }

  return arr;
};

/** Single-object analogue of `map` for the connection-agnostic single-object
 *  RESPONSE projection (read / create / update — ops that return ONE record, not a
 *  collection). `map` over a non-array returns `[]`, so it can't project a lone
 *  record; `project` applies the SAME projection template to a single object and
 *  returns the projected object. It's exactly "one map iteration": the template's
 *  `{{item.<field_path>}}` refs resolve against the single record `obj` via the
 *  shared `resolveExpression`, so the G2 `{{item.x | number}}` numeric +
 *  `{{item.x | date_ms}}` date coercions, nested object/array templates, and
 *  pure-ref type-preservation all behave identically to the `map` expression path.
 *  A null / non-object (incl. array) input → `null`. */
export const project: TransformFn = (p) => {
  const obj = p.object;
  if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return resolveExpression(p.expression, obj);
};

/** Regex used to both detect and substitute {{item.path}} references. */
/** ⛔ The character class includes `-` because JSON APIs use kebab-case constantly and
 *  the omission failed SILENTLY. `{{item.first-release-date}}` did not match, fell through
 *  to the "return as-is" branch, and the LITERAL TEMPLATE STRING was written into the
 *  projected row — a column reading `{{item.first-release-date}}` instead of `1979-11-30`,
 *  with nothing raised. Found while binding MusicBrainz, whose payload is kebab-case
 *  throughout (`first-release-date`, `primary-type`, `artist-credit`, `release-groups`).
 *
 *  ⚠ Widening is safe and was measured: a hyphen INSIDE `{{item.…}}` is unambiguously part
 *  of the key, because the ref cannot extend past its closing `}}` — so a math expression
 *  like `"{{item.a}} - {{item.b}}"` is untouched. And it can only turn a passthrough into a
 *  resolution: at the time of the change ZERO shipped recipes used a hyphenated `item` ref,
 *  so no existing behaviour changes. Plain `{{step.x.a-b}}` refs already resolved — only
 *  these six item-scoped patterns were narrow. */
const ITEM_REF_RE = /\{\{\s*item\.([a-zA-Z_][\w.-]*)\s*\}\}/g;

/** Hint-aware variant for the interpolation case: `{{item.path:currency}}`.
 *  The optional `:hint` group mirrors the engine value system — a hint
 *  formats during STRING interpolation only (Case 2.5); a pure single ref
 *  ignores it and preserves type (Case 1). The math case stays hint-blind
 *  on the plain regex: a formatted string inside arithmetic is authoring
 *  nonsense, and degrading it to interpolation keeps the output readable. */
const ITEM_REF_HINT_RE = /\{\{\s*item\.([a-zA-Z_][\w.-]*)(?::([a-zA-Z_]+))?\s*\}\}/g;

/** Single `{{item.path | number}}` numeric-coercion form. The `| number` filter
 *  sits INSIDE the braces, so this is deliberately invisible to `ITEM_REF_RE`
 *  (which requires `}}` straight after the path) — a coercion expression is never
 *  mistaken for a plain ref by the math / interpolation cases. See
 *  `resolveExpression` Case 1.5. */
const ITEM_NUMERIC_COERCE_RE = /^\{\{\s*item\.([a-zA-Z_][\w.-]*)\s*\|\s*number\s*\}\}$/;

/** Single `{{item.path | date_ms}}` date-coercion form (G2 datetime unify) — the
 *  sibling of `| number` for canonical `datetime` (`date_ms`) fields. Same
 *  inside-the-braces shape, so it is equally invisible to the plain-ref / math /
 *  interpolation regexes. See `resolveExpression` Case 1.6. */
const ITEM_DATE_COERCE_RE = /^\{\{\s*item\.([a-zA-Z_][\w.-]*)\s*\|\s*date_ms\s*\}\}$/;

/** D-190 — email local-part projection hint (`{{item.path | local_part}}`): the
 *  substring before the FIRST '@' of the resolved value. Same inside-the-braces
 *  shape as the number / date_ms coercions, invisible to the plain-ref / math /
 *  interpolation regexes. See `resolveExpression` Case 1.7. */
const ITEM_LOCAL_PART_RE = /^\{\{\s*item\.([a-zA-Z_][\w.-]*)\s*\|\s*local_part\s*\}\}$/;

/** Boolean coercion for the `$ternary` condition. A vendor flag arrives as a real
 *  boolean (Salesforce `IsClosed`) OR a "true"/"false" STRING (HubSpot returns all
 *  properties as strings), and a missing flag is falsey. Treat ONLY real `true` or
 *  the string "true" (case-insensitive) as truthy — `Boolean("false")` would be a
 *  silent bug. */
const coerceBool = (v: unknown): boolean =>
  v === true || (typeof v === 'string' && v.toLowerCase() === 'true');

/** Evaluate a map expression in the context of a single array item.
 *
 *  Supported shapes:
 *   1. Pure string reference: "{{item.amount}}" → returns the raw field value
 *      (preserves type — number stays number, object stays object)
 *   2. Math expression mixing refs + operators: "{{item.amount}} * {{item.prob}} / 100"
 *      → substitutes each ref with its numeric value, evaluates via the safe
 *      recursive-descent math parser (shared with the `math` transform)
 *   3. Object or array template: recursively resolves embedded {{item.*}} refs,
 *      preserving structure. Used when projecting items into a new shape.
 *   4. Anything else: returned as-is.
 */
function resolveExpression(expr: unknown, item: unknown): unknown {
  if (typeof expr === 'string') {
    // Case 1: single ref, entire string is {{item.path}} (an optional
    // `:hint` is accepted and IGNORED — the value-system rule: pure refs
    // preserve type, hints only format string interpolation).
    const singleMatch = /^\{\{\s*item\.([a-zA-Z_][\w.-]*)(?::[a-zA-Z_]+)?\s*\}\}$/.exec(expr);
    if (singleMatch) return getField(item, singleMatch[1]);

    // Case 1.5: numeric coercion — `{{item.path | number}}`. Coerce the field to a
    // real number via Number() (so a numeric STRING like "30000" or an exponent
    // form like "1e-7" becomes a number), preserving a missing / empty / non-finite
    // value as null (NOT 0 — a 0 would wrongly satisfy is_not_null / equal 0 /
    // less <n>). Used by the connection-agnostic projection for `number` canonical
    // fields whose vendor value arrives as a string (G2). Returning the value
    // DIRECTLY (no math-text re-parse) is what keeps exponents + nulls correct.
    const coerceMatch = ITEM_NUMERIC_COERCE_RE.exec(expr);
    if (coerceMatch) {
      const raw = getField(item, coerceMatch[1]);
      if (raw === null || raw === undefined || raw === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }

    // Case 1.6: date coercion — `{{item.path | date_ms}}`. Normalize a canonical
    // `datetime` (`date_ms`) field to a single unix-MS NUMBER so the same canonical
    // field reads identically across vendors (G2 datetime unify): HubSpot returns
    // `closedate` as an epoch-ms STRING ("1735689600000"), Salesforce returns
    // `CloseDate` as an ISO string ("2025-01-15") / datetime — a pure ref would leave
    // them as two different shapes, breaking portability + numeric date compares /
    // `:date` formatting. Number()-first honors the epoch-ms (string or number) form
    // AND keeps a real ms number exact (Date.parse would re-stringify-then-parse);
    // a non-numeric value falls back to Date.parse (ISO → ms). A missing / empty /
    // WHITESPACE-only / unparseable value PRESERVES as null (NOT 0 / epoch — `Number("  ")`
    // is 0, which would wrongly satisfy is_not_null and read as 1970): we trim a string
    // first, so a blank cell is null and a PADDED epoch-ms (" 1735… ") still parses.
    // Number()-first is deliberate even for a small/compact all-digit string ("2025"):
    // the field is registry-DECLARED `date_ms` (epoch-ms), so an all-digit value IS
    // epoch-ms by contract — a vendor that emits a bare year/basic-date for a date_ms
    // field has mis-declared its schema, and an epoch-ms range gate would instead
    // silently drop legitimately old/small epoch-ms values. Mirrors Case 1.5's null
    // discipline.
    const dateMatch = ITEM_DATE_COERCE_RE.exec(expr);
    if (dateMatch) {
      const raw = getField(item, dateMatch[1]);
      if (raw === null || raw === undefined) return null;
      const trimmed = typeof raw === 'string' ? raw.trim() : raw;
      if (trimmed === '') return null;
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
      const parsed = Date.parse(String(trimmed));
      return Number.isNaN(parsed) ? null : parsed;
    }

    // Case 1.7: email local-part — `{{item.path | local_part}}`. The substring
    // before the FIRST '@' of the resolved value (D-190 — the contact `name`
    // concat's email fallback projects "alice", not "alice@x.com"). No '@' →
    // the whole trimmed value (a malformed/non-email value passes through);
    // missing/empty → null; a leading '@' (empty local part) → "" so the
    // `$concat` fallback drops it to null. Mirrors Cases 1.5 / 1.6's null discipline.
    const localMatch = ITEM_LOCAL_PART_RE.exec(expr);
    if (localMatch) {
      const raw = getField(item, localMatch[1]);
      if (raw === null || raw === undefined) return null;
      const trimmed = String(raw).trim();
      if (trimmed === '') return null;
      const at = trimmed.indexOf('@');
      return at === -1 ? trimmed : trimmed.slice(0, at);
    }

    // Case 2: math expression — has operators AND at least one {{item.*}} ref
    ITEM_REF_RE.lastIndex = 0; // global regex carries state across CALLS
    // ⛔ An operator is not enough. Every Records reference is `<entity>/<id>`,
    // so `"rental_contract/{{item.id}}"` contains `/` and was read as DIVISION:
    // the ref substituted to a number, `rental_contract/0` evaluated, and the
    // whole thing resolved to null. Silently — a seeded grid row arrived with a
    // null tenancy and the write failed downstream for an unrelated-looking
    // reason. No ref could ever be built inline in a map expression, which is
    // why the corpus builds them in a `template` step instead.
    //
    // Real arithmetic has nothing but refs, numbers, operators and whitespace
    // between its parts. Anything else — a word, a slash in a path — means the
    // author wrote text, so it falls through to interpolation below.
    ITEM_REF_RE.lastIndex = 0;
    // Strip the refs and the function names `evaluateMathExpression` supports
    // (min, max, abs, ceil, floor, round) — what remains of REAL arithmetic is
    // only digits, operators, parens and whitespace. `round({{item.minutes}} *
    // 125 / 60 * 100) / 100` is arithmetic; `rental_contract/{{item.id}}` is
    // not, and the difference is a word that is not a function.
    //
    // ⚠ A first cut checked the leftovers without stripping the functions, and
    // broke every priced line in `billable-hours` and `invoice-book` — the
    // guard has to know what the evaluator accepts, or it rejects the
    // expressions it exists to protect.
    const withoutRefs = expr
      .replace(ITEM_REF_RE, ' ')
      .replace(/\b(?:min|max|abs|ceil|floor|round)\b/g, ' ');
    const looksArithmetic = /^[\d\s+\-*/%().,]*$/.test(withoutRefs);
    ITEM_REF_RE.lastIndex = 0;
    if (ITEM_REF_RE.test(expr) && /[+\-*/%()]/.test(expr) && looksArithmetic) {
      ITEM_REF_RE.lastIndex = 0; // reset after .test()
      const substituted = expr.replace(ITEM_REF_RE, (_, path) => {
        const v = getField(item, path);
        const n = Number(v);
        return Number.isFinite(n) ? String(n) : '0';
      });
      return evaluateMathExpression(substituted);
    }

    // Case 2.5: interpolation — has {{item.*}} ref(s) but NO math operators
    // (e.g. "{{item.company}} news last 7 days"). Substitute each item ref via
    // `interpolationText`, the same garble-aware text form as the engine's own
    // interpolation (an object field renders compact JSON, never
    // "[object Object]"); a `:hint` suffix formats via the engine's
    // `formatHint` ("{{item.raw_total:currency}}" → "$499,000") — pre-fix
    // the hinted refs failed every regex and survived as literal braces
    // (s13 spot-run: forecast-open-deals' monthly text reached the model
    // half-garbled). Reached when the engine deferred item refs for a map
    // expression (deferItem); non-deferred contexts never hand a raw item
    // ref to a map.
    ITEM_REF_HINT_RE.lastIndex = 0;
    if (ITEM_REF_HINT_RE.test(expr)) {
      ITEM_REF_HINT_RE.lastIndex = 0;
      return expr.replace(ITEM_REF_HINT_RE, (_, path: string, hint?: string) => {
        const value = getField(item, path);
        return hint
          ? formatHint(value, hint as Parameters<typeof formatHint>[1])
          : interpolationText(value);
      });
    }

    // Plain string without refs — return literally
    return expr;
  }

  if (typeof expr === 'object' && expr != null) {
    if (Array.isArray(expr)) return expr.map(e => resolveExpression(e, item));
    // Case 3.5: conditional construct `{ $ternary: { if, then, else } }`. Resolve
    // `if`, BOOL-coerce it, and return the resolved `then` (truthy) or `else`. The
    // branches resolve recursively, so a `$ternary` can nest (the CRM closed-state
    // projection nests two: closed ? (won ? "won" : "lost") : "open"). Emitted by
    // the connection-agnostic resolver for a derived canonical field; a plain
    // object template never carries a `$ternary` key, so this is unambiguous.
    const ternary = (expr as Record<string, unknown>).$ternary;
    if (ternary !== undefined && typeof ternary === 'object' && ternary !== null && !Array.isArray(ternary)) {
      const t = ternary as Record<string, unknown>;
      return coerceBool(resolveExpression(t.if, item))
        ? resolveExpression(t.then, item)
        : resolveExpression(t.else, item);
    }
    // Case 3.6: string concat `{ $concat: { parts: [...], separator?, fallback? } }`.
    // Resolve each part, DROP empty/whitespace ones, join the rest with `separator`
    // (default ''); when every part is empty, resolve `fallback` (else null). Emitted
    // by the connection-agnostic resolver for a `concat`-derived canonical field (the
    // cross-vendor contact `name`); a plain object template never carries a `$concat`
    // key, so this is unambiguous.
    const concat = (expr as Record<string, unknown>).$concat;
    if (concat !== undefined && typeof concat === 'object' && concat !== null && !Array.isArray(concat)) {
      const c = concat as Record<string, unknown>;
      const parts = Array.isArray(c.parts) ? c.parts : [];
      const separator = typeof c.separator === 'string' ? c.separator : '';
      const asStr = (v: unknown): string => (v === null || v === undefined ? '' : safeString(v).trim());
      const pieces = parts.map((p) => asStr(resolveExpression(p, item))).filter((s) => s.length > 0);
      if (pieces.length > 0) return pieces.join(separator);
      if (c.fallback !== undefined) {
        const fb = asStr(resolveExpression(c.fallback, item));
        return fb.length > 0 ? fb : null;
      }
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(expr)) {
      setSafe(out, k, resolveExpression(v, item));
    }
    return out;
  }
  return expr;
}

export const reduce: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr) || arr.length === 0) return p.initial ?? null;
  return applyReduce(arr, p.field as string, p.operator as ReduceOp, p.initial);
};

// Number()/String() on a null-prototype object (what `merge` emits) throws —
// no valueOf/toString on the chain — so coercion must never assume a primitive path.
function safeNumber(v: unknown): number {
  try { return Number(v); } catch { return NaN; }
}

function safeString(v: unknown): string {
  try { return String(v); } catch { return '[object]'; }
}

export function applyReduce(arr: unknown[], field: string, op: ReduceOp, initial?: unknown): unknown {
  if (op === 'count') return arr.length;
  const values = field ? arr.map(item => getField(item, field)) : arr;
  const nums = values.map(safeNumber).filter(n => !isNaN(n));

  if (op === 'sum') return nums.reduce((a, b) => a + b, Number(initial ?? 0));
  if (op === 'avg') return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  if (op === 'min') return nums.length ? Math.min(...nums) : null;
  if (op === 'max') return nums.length ? Math.max(...nums) : null;
  return null;
}

export const unique: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr)) return [];
  if (!p.field) return [...new Set(arr)];
  const seen = new Set<unknown>();
  return arr.filter(item => {
    const v = getField(item, p.field as string);
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
};

export const flatten: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr)) return [];
  return arr.flat(Number(p.depth ?? 1));
};

export const slice: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr)) return [];
  return arr.slice(Number(p.start ?? 0), Number(p.end));
};

export const group_by: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr)) return {};
  const field = p.field as string;
  // The group key lands on each aggregate row under `group_as` when present,
  // else under `field`. `group_as` exists because a DOTTED field path (e.g. a
  // raw vendor read `properties.hubspot_owner_id`, D-182 Tier-P) would store
  // the key under the literal dotted string — which `getField` (dot-split)
  // can't read back downstream. `group_as` names the output key plainly so a
  // raw group-by stays readable without an intervening projection step. Absent
  // → unchanged behavior (non-dotted fields store under their own name).
  const keyAs = typeof p.group_as === 'string' && p.group_as !== '' ? p.group_as : field;
  const groups: Record<string, unknown[]> = Object.create(null);
  for (const item of arr) {
    const key = safeString(getField(item, field) ?? 'null');
    (groups[key] ??= []).push(item);
  }
  if (!p.aggregate) return groups;
  const agg = p.aggregate as Record<string, { operator: ReduceOp; field?: string }>;
  return Object.entries(groups).map(([key, items]) => {
    const row: Record<string, unknown> = {};
    setSafe(row, keyAs, key);
    for (const [name, spec] of Object.entries(agg)) {
      setSafe(row, name, applyReduce(items, spec.field ?? '', spec.operator));
    }
    return row;
  });
};

export const to_list: TransformFn = (p) => {
  const input = p.input;
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return [];
  return Object.entries(input as Record<string, unknown>).map(([key, value]) => ({ key, value }));
};

/** Splits an array into `{ matched, unmatched }` by a predicate. Mirrors the
 *  filter API (single-condition or `conditions` array with `mode: all|any`)
 *  so authors can flip between them without re-learning params. Useful when
 *  a recipe needs BOTH sides of a split — e.g. `won` deals and `lost` deals
 *  from one pass — without running filter twice. */
export const partition: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr)) return { matched: [], unmatched: [] };

  let predicate: (item: unknown) => boolean;
  if (Array.isArray(p.conditions)) {
    const conds = p.conditions as Condition[];
    const useAny = p.mode === 'any';
    predicate = (item) => {
      const test = (c: Condition) => evaluateOp(getField(item, c.field), c.operator as ConditionOp, c.value);
      return useAny ? conds.some(test) : conds.every(test);
    };
  } else {
    const field = p.field as string;
    const op = p.operator as ConditionOp;
    predicate = (item) => evaluateOp(getField(item, field), op, p.value);
  }

  const matched: unknown[] = [];
  const unmatched: unknown[] = [];
  for (const item of arr) (predicate(item) ? matched : unmatched).push(item);
  return { matched, unmatched };
};

/** Attach fields from a SECOND array onto each item of the first, matched on a
 *  key. The relational join the recipe language was missing.
 *
 *  ── Why this exists ──────────────────────────────────────────────
 *  A board that lists one collection and wants a column from another had no way
 *  to express it. `group_by` produces a keyed object, but a `map` expression
 *  cannot do a DYNAMIC lookup into it: the step's input is resolved before the
 *  transform runs, so `{{step.by_id.{{item.key}}}}` is a nested template and is
 *  not resolvable. `find` matches one element but cannot be called per item from
 *  inside `map`. So the only alternatives were N per-row op reads, or storing a
 *  denormalised copy on the left-hand record.
 *
 *  ⚠ FIRST match wins, and the right-hand array is indexed in its given order,
 *  so the result is deterministic for duplicate keys rather than
 *  last-one-seen. Keys are compared as STRINGS: a numeric id on one side and its
 *  string form on the other still match, which is what mixed warehouse / provider
 *  ids need.
 *
 *  ⚠ An unmatched item gets each declared field as `null`, never a missing key —
 *  a renderer that reads `row.description` must not see `undefined` for "no
 *  match" and a real absence identically. */
export const enrich_by: TransformFn = (p) => {
  const left = p.array as unknown[];
  if (!Array.isArray(left)) return [];
  const right = Array.isArray(p.with) ? (p.with as unknown[]) : [];
  const leftKey = String(p.key ?? '');
  const rightKey = String(p.with_key ?? p.key ?? '');
  const fields = (typeof p.fields === 'object' && p.fields !== null
    ? p.fields
    : {}) as Record<string, unknown>;

  const index = new Map<string, unknown>();
  for (const row of right) {
    const raw = getField(row, rightKey);
    if (raw === undefined || raw === null) continue;
    const key = String(raw);
    if (!index.has(key)) index.set(key, row);
  }

  return left.map((item) => {
    const raw = getField(item, leftKey);
    const match = raw === undefined || raw === null ? undefined : index.get(String(raw));
    const out = { ...(item as Record<string, unknown>) };
    for (const [outName, path] of Object.entries(fields)) {
      const value = match === undefined ? null : getField(match, String(path));
      // setSafe: `fields` keys are recipe-authored, so the prototype filter is
      // load-bearing here exactly as it is for `map`'s `output_field`.
      setSafe(out, outName, value === undefined ? null : value);
    }
    return out;
  });
};
