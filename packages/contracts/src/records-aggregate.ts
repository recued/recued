/** D-226 — the ONE aggregation evaluator, shared by two callers.
 *
 *  Two surfaces will call this and they differ only in AUTHORITY, never in
 *  behaviour:
 *    - `core.records.aggregate` — recipe-callable; the caller chooses when and
 *      what.
 *    - a declared ref's `select`   — core-only; the OCCASION is fixed by the
 *      declaration (per query, per parent entity, in the binding).
 *
 *  ⛔⛔ They must never be two implementations. If they drift, a recipe's
 *  aggregate and a root read over the same rows return different numbers, each
 *  internally consistent, with no failing test anywhere. Hence: vocabulary,
 *  validity matrix, `where` semantics, empty-set behaviour and numeric handling
 *  all live here, and the surfaces are thin wrappers.
 *
 *  ⚠ This is NOT an expression language and must not become one. The function
 *  list is closed; the moment a caller needs a conditional, that is a producer
 *  recipe, not a declaration. */
import { RECORDS_DECIMAL_SCALE, type RecordsFieldKind } from './records.js';

export const RECORDS_AGGREGATE_FNS = [
  'count',
  'count_distinct',
  'sum',
  'avg',
  'min',
  'max',
  'latest',
  'earliest',
] as const;

export type RecordsAggregateFn = (typeof RECORDS_AGGREGATE_FNS)[number];

/** D-226 validity matrix. Derived per field kind — NOT a hand-copy of the
 *  decision's table that can rot: `RECORDS_AGGREGATE_VALIDITY` is the single
 *  place, and `RecordsFieldKind` keys it so a new slot family is a compile
 *  error here rather than a silent gap.
 *
 *  ⚠ `min`/`max` are DELIBERATELY absent on `string`/`text`. They appear to work
 *  on ISO dates because lexicographic order coincides with chronological, so an
 *  author learns the habit on a date-shaped string and then applies it to a
 *  description field, silently getting alphabetically-first. `latest`/`earliest`
 *  force the ordering field to be DECLARED rather than accidental. */
export const RECORDS_AGGREGATE_VALIDITY: Readonly<
  Record<RecordsFieldKind, readonly RecordsAggregateFn[]>
> = {
  number: ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'],
  decimal: ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'],
  date: ['count', 'count_distinct', 'min', 'max'],
  datetime: ['count', 'count_distinct', 'min', 'max'],
  string: ['count', 'count_distinct', 'latest', 'earliest'],
  text: ['count', 'count_distinct', 'latest', 'earliest'],
  boolean: ['count', 'count_distinct'],
  ref: ['count', 'count_distinct'],
};

/** Kinds a `latest`/`earliest` ORDERING field may have. An unordered `by` is
 *  the same footgun the matrix excludes `min`/`max` on strings for. */
export const RECORDS_AGGREGATE_ORDERABLE: readonly RecordsFieldKind[] = [
  'number', 'decimal', 'date', 'datetime',
];

export interface RecordsAggregateSelect {
  fn: RecordsAggregateFn;
  /** Omitted ONLY for `count`, which then counts ROWS. With a field, `count`
   *  counts rows whose field is non-null — a different question, and the
   *  distinction is why the field is optional rather than defaulted. */
  field?: string;
  /** Ordering field. Required by `latest` / `earliest`, rejected otherwise. */
  by?: string;
}

export type RecordsAggregateSelectMap = Readonly<Record<string, RecordsAggregateSelect>>;

export const isRecordsAggregateFn = (value: unknown): value is RecordsAggregateFn =>
  typeof value === 'string' && (RECORDS_AGGREGATE_FNS as readonly string[]).includes(value);

/** Static validation against the field kinds of one entity. Returns every
 *  problem rather than the first, so an author fixes a spec in one pass.
 *  Empty array = admissible. Callers MUST run this before evaluating: the
 *  evaluator assumes a validated spec and does not re-check kinds. */
export const validateRecordsAggregateSelect = (
  select: unknown,
  kinds: Readonly<Record<string, RecordsFieldKind>>,
): string[] => {
  const problems: string[] = [];
  if (select === null || typeof select !== 'object' || Array.isArray(select)) {
    return ['select must be an object of { output_name: { fn, field?, by? } }'];
  }
  const entries = Object.entries(select as Record<string, unknown>);
  if (entries.length === 0) problems.push('select must name at least one output');

  for (const [name, rawSpec] of entries) {
    const at = `select.${name}`;
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      problems.push(`${at}: output name must be lower_snake_case`);
    }
    if (rawSpec === null || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
      problems.push(`${at}: must be an object { fn, field?, by? }`);
      continue;
    }
    const spec = rawSpec as Record<string, unknown>;
    for (const key of Object.keys(spec)) {
      if (!['fn', 'field', 'by'].includes(key)) problems.push(`${at}: unknown key '${key}'`);
    }
    if (!isRecordsAggregateFn(spec.fn)) {
      problems.push(`${at}: fn must be one of ${RECORDS_AGGREGATE_FNS.join(', ')}`);
      continue;
    }
    const fn = spec.fn;
    const field = spec.field;
    const by = spec.by;

    if (field === undefined) {
      // ⚠ Only `count` has a meaningful field-less reading (count the rows).
      // Everything else without a field would silently aggregate nothing.
      if (fn !== 'count') problems.push(`${at}: '${fn}' requires a field`);
    } else if (typeof field !== 'string' || field.length === 0) {
      problems.push(`${at}: field must be a non-empty string`);
    } else if (!(field in kinds)) {
      problems.push(`${at}: unknown field '${field}'`);
    } else {
      const kind = kinds[field]!;
      if (!RECORDS_AGGREGATE_VALIDITY[kind].includes(fn)) {
        problems.push(
          `${at}: '${fn}' is not valid on a ${kind} field` +
          (['string', 'text'].includes(kind) && ['min', 'max'].includes(fn)
            ? ` — use latest/earliest with an explicit 'by', so the ordering is declared`
            : ''),
        );
      }
    }

    const needsBy = fn === 'latest' || fn === 'earliest';
    if (needsBy) {
      if (typeof by !== 'string' || by.length === 0) {
        problems.push(`${at}: '${fn}' requires 'by' — the ordering field`);
      } else if (!(by in kinds)) {
        problems.push(`${at}: unknown ordering field '${by}'`);
      } else if (!RECORDS_AGGREGATE_ORDERABLE.includes(kinds[by]!)) {
        problems.push(`${at}: ordering field '${by}' is ${kinds[by]} and is not ordered`);
      }
    } else if (by !== undefined) {
      problems.push(`${at}: 'by' is only meaningful for latest/earliest`);
    }
  }
  return problems;
};

// ── decimal arithmetic ──────────────────────────────────────────────────────
/** A `decimal` slot round-trips as a fixed-point STRING (`decodeDecimal`), and
 *  summing those as floats would reintroduce exactly the error the decimal
 *  family exists to avoid. Scaled BigInt keeps it exact. */
const SCALE = 10n ** BigInt(RECORDS_DECIMAL_SCALE);

const decimalToScaled = (value: unknown): bigint | null => {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || !/^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^[+-]/, '').split('.');
  const scaled = BigInt(whole) * SCALE
    + BigInt(fraction.slice(0, RECORDS_DECIMAL_SCALE).padEnd(RECORDS_DECIMAL_SCALE, '0'));
  return negative ? -scaled : scaled;
};

const scaledToDecimal = (scaled: bigint): string => {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  return `${negative ? '-' : ''}${abs / SCALE}.${(abs % SCALE).toString().padStart(RECORDS_DECIMAL_SCALE, '0')}`;
};

// ── comparison ──────────────────────────────────────────────────────────────
/** Kind-aware ordering. `date`/`datetime` compare lexicographically ONLY because
 *  they are canonical ISO — which is exactly the coincidence that makes
 *  `min`/`max` on a free string a trap, so that pairing stays out of the
 *  matrix rather than relying on this. */
const compareByKind = (a: unknown, b: unknown, kind: RecordsFieldKind): number => {
  if (kind === 'decimal') {
    const sa = decimalToScaled(a), sb = decimalToScaled(b);
    if (sa === null || sb === null) return 0;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  if (kind === 'number') {
    const na = Number(a), nb = Number(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

const present = (value: unknown): boolean => value !== null && value !== undefined && value !== '';

/** ⛔ Empty-set behaviour, stated once and depended on everywhere:
 *    count / count_distinct → 0
 *    sum                    → 0 (or "0.0000" on a decimal field)
 *    avg / min / max / latest / earliest → null
 *  A `sum` of nothing is 0 because "you have nothing unbilled" is a real
 *  answer; an `avg` of nothing is null because "your average is 0" is a lie. */
export interface RecordsAggregator {
  push(row: Readonly<Record<string, unknown>>): void;
  finish(): Record<string, unknown>;
}

/** ⛔ STREAMING, on purpose. The store scans up to `RECORDS_MAX_QUERY_ROWS`
 *  candidates and must not retain them — `count` streams for exactly this
 *  reason. Every accumulator here is O(1) in rows except `count_distinct`,
 *  which is O(distinct) and is the one function with a memory cost worth
 *  knowing about.
 *
 *  ⚠ This is the ONLY implementation. `evaluateRecordsAggregate` below is a
 *  thin array wrapper over it, so the streaming caller (the op) and the
 *  in-memory caller (a declared ref's select over an already-fetched set)
 *  cannot drift — which is the whole reason the evaluator is shared. */
export const createRecordsAggregator = (
  select: RecordsAggregateSelectMap,
  kinds: Readonly<Record<string, RecordsFieldKind>>,
): RecordsAggregator => {
  interface Acc {
    name: string; spec: RecordsAggregateSelect; kind?: RecordsFieldKind; byKind?: RecordsFieldKind;
    n: number; totalNum: number; totalDec: bigint; distinct?: Set<string>;
    best?: unknown; bestKey?: unknown; seen: boolean;
  }
  const accs: Acc[] = Object.entries(select).map(([name, spec]) => ({
    name, spec,
    kind: spec.field === undefined ? undefined : kinds[spec.field],
    byKind: spec.by === undefined ? undefined : kinds[spec.by],
    n: 0, totalNum: 0, totalDec: 0n, seen: false,
    distinct: spec.fn === 'count_distinct' ? new Set<string>() : undefined,
  }));

  return {
    push(row) {
      for (const a of accs) {
        const { fn, field, by } = a.spec;
        if (fn === 'count' && field === undefined) { a.n += 1; continue; }

        if (fn === 'latest' || fn === 'earliest') {
          const key = row[by!];
          if (!present(key)) continue;          // an unorderable row cannot win
          // STRICT comparison, so on a tie the FIRST row seen wins. Deterministic
          // and documented — a tie-break that depended on scan order would make
          // the same data give different answers on different runs.
          const want = fn === 'latest' ? 1 : -1;
          if (!a.seen || compareByKind(key, a.bestKey, a.byKind!) === want) {
            a.seen = true; a.bestKey = key;
            a.best = present(row[field!]) ? row[field!] : null;
          }
          continue;
        }

        const v = row[field!];
        if (!present(v)) continue;
        a.n += 1;
        switch (fn) {
          case 'count': break;
          // Keyed on the DECODED value's string form. For `ref` that is the
          // canonical encoded ref, which makes "how many distinct engagements"
          // answerable without resolving any of them.
          case 'count_distinct': a.distinct!.add(String(v)); break;
          case 'sum':
          case 'avg':
            if (a.kind === 'decimal') a.totalDec += decimalToScaled(v) ?? 0n;
            else a.totalNum += Number(v);
            break;
          case 'min':
          case 'max': {
            const want = fn === 'min' ? -1 : 1;
            if (!a.seen || compareByKind(v, a.best, a.kind!) === want) { a.seen = true; a.best = v; }
            break;
          }
        }
      }
    },

    finish() {
      const out: Record<string, unknown> = {};
      for (const a of accs) {
        switch (a.spec.fn) {
          case 'count': out[a.name] = a.n; break;
          case 'count_distinct': out[a.name] = a.distinct!.size; break;
          case 'sum':
            out[a.name] = a.kind === 'decimal' ? scaledToDecimal(a.totalDec) : a.totalNum;
            break;
          case 'avg':
            out[a.name] = a.n === 0 ? null
              : a.kind === 'decimal'
                // Truncates toward zero at the family scale — an average is
                // derived, so it carries that precision and no more.
                ? scaledToDecimal(a.totalDec / BigInt(a.n))
                : a.totalNum / a.n;
            break;
          default: out[a.name] = a.seen ? a.best ?? null : null; break;
        }
      }
      return out;
    },
  };
};

// ── grouping ────────────────────────────────────────────────────────────────
/** Kinds a GROUP KEY may have — deliberately narrower than the fields you can
 *  aggregate, and narrow on purpose:
 *
 *  ⛔ `datetime` is excluded while `date` is admitted. A calendar date is a
 *  BUCKET; a millisecond timestamp is an INSTANT, and grouping on one yields
 *  approximately one group per row — a "list" that is the table back again,
 *  straight into the group cap. `number` is out for the same reason, `decimal`
 *  because money is not a category, and `text` because a 1 MiB group key is not
 *  a key.
 *
 *  ⚠ Widening this later is free; narrowing it is not — a shipped pack's
 *  declaration is data, and a kind removed here silently invalidates it. */
export const RECORDS_GROUP_BY_KINDS: readonly RecordsFieldKind[] = [
  'string', 'date', 'boolean', 'ref',
];

/** Matches `RECORDS_MAX_PAGE_SIZE`: a grouped aggregate IS a list, and the same
 *  bound that holds a page of rows holds a page of groups. */
export const RECORDS_MAX_GROUPS = 200;

export interface RecordsAggregateGroup {
  /** The group's value, decoded — `null` for rows whose key is absent or empty.
   *  ⛔ Actual `null`, never the STRING "null". The transforms-layer `group_by`
   *  keys on `safeString(value ?? 'null')`, which merges a missing value with a
   *  field that literally holds "null" and reads as one bucket. Here the absent
   *  bucket is a JSON null, which no `string` key can ever collide with. */
  key: unknown;
  values: Record<string, unknown>;
}

export interface RecordsGroupedAggregateResult {
  group_by: string;
  groups: RecordsAggregateGroup[];
  /** False iff groups were dropped. ⛔ EVERY GROUP RETURNED IS EXACT — the cap
   *  stops NEW keys being admitted, it never truncates a group already open, so
   *  a number shown is the whole number. What is missing is groups, and this
   *  says so. Truncating a group's total instead would hand you a figure that
   *  is wrong by an unknowable amount while looking ordinary. */
  complete: boolean;
  incomplete_reason?: 'group_cap';
}

export const validateRecordsGroupBy = (
  groupBy: unknown,
  kinds: Readonly<Record<string, RecordsFieldKind>>,
): string[] => {
  if (typeof groupBy !== 'string' || groupBy.length === 0) {
    return ['group_by must be a non-empty field name'];
  }
  if (!(groupBy in kinds)) return [`group_by: unknown field '${groupBy}'`];
  const kind = kinds[groupBy]!;
  if (!RECORDS_GROUP_BY_KINDS.includes(kind)) {
    return [
      `group_by: a ${kind} field cannot be a group key` +
      (kind === 'datetime'
        ? ' — a timestamp is an instant, not a bucket; use a date field'
        : ` — group keys may be ${RECORDS_GROUP_BY_KINDS.join(', ')}`),
    ];
  }
  return [];
};

export interface RecordsGroupedAggregator {
  push(row: Readonly<Record<string, unknown>>): void;
  finish(): RecordsGroupedAggregateResult;
}

/** One `createRecordsAggregator` per group — which is why grouping is a small
 *  change rather than a second evaluator. The accumulators, the validity
 *  matrix, the decimal arithmetic and the empty-set rules are all the ungrouped
 *  ones, unchanged, so a grouped total and an ungrouped total over the same
 *  rows cannot disagree. */
export const createRecordsGroupedAggregator = (
  groupBy: string,
  select: RecordsAggregateSelectMap,
  kinds: Readonly<Record<string, RecordsFieldKind>>,
): RecordsGroupedAggregator => {
  // `null` keys the absent bucket directly. `present()` already rejects null,
  // undefined and '', and String() of a real value never yields null — so the
  // two can never land in the same slot.
  const groups = new Map<string | null, { key: unknown; agg: RecordsAggregator }>();
  const keyKind = kinds[groupBy]!;
  let dropped = false;

  return {
    push(row) {
      const raw = row[groupBy];
      const absent = !present(raw);
      const mapKey = absent ? null : String(raw);
      let entry = groups.get(mapKey);
      if (entry === undefined) {
        // ⛔ At the cap, a NEW key is refused and its rows are skipped whole.
        // Admitting the row into some other group would corrupt that group's
        // total; admitting the key would make the cap meaningless.
        if (groups.size >= RECORDS_MAX_GROUPS) { dropped = true; return; }
        entry = { key: absent ? null : raw, agg: createRecordsAggregator(select, kinds) };
        groups.set(mapKey, entry);
      }
      entry.agg.push(row);
    },

    finish() {
      const out = [...groups.values()]
        .map(({ key, agg }) => ({ key, values: agg.finish() }))
        // Stable order or a list view reshuffles between reads. The absent
        // bucket sorts LAST — deterministic, and "no client" belongs at the
        // bottom of a customer list rather than the top.
        .sort((a, b) =>
          a.key === null ? (b.key === null ? 0 : 1)
            : b.key === null ? -1
              : compareByKind(a.key, b.key, keyKind));
      return {
        group_by: groupBy,
        groups: out,
        complete: !dropped,
        ...(dropped ? { incomplete_reason: 'group_cap' as const } : {}),
      };
    },
  };
};

/** Array form — the same accumulator, fed from a materialized set. */
export const evaluateRecordsGroupedAggregate = (
  rows: readonly Readonly<Record<string, unknown>>[],
  groupBy: string,
  select: RecordsAggregateSelectMap,
  kinds: Readonly<Record<string, RecordsFieldKind>>,
): RecordsGroupedAggregateResult => {
  const agg = createRecordsGroupedAggregator(groupBy, select, kinds);
  for (const row of rows) agg.push(row);
  return agg.finish();
};

/** Array form — the same accumulator, fed from a materialized set. */
export const evaluateRecordsAggregate = (
  rows: readonly Readonly<Record<string, unknown>>[],
  select: RecordsAggregateSelectMap,
  kinds: Readonly<Record<string, RecordsFieldKind>>,
): Record<string, unknown> => {
  const agg = createRecordsAggregator(select, kinds);
  for (const row of rows) agg.push(row);
  return agg.finish();
};
