/** D-226 — the shared aggregation evaluator.
 *
 *  This is the piece BOTH aggregation surfaces call, so a defect here is a
 *  defect in every caller at once. The properties worth pinning are the ones
 *  that are invisible when wrong: empty-set answers, decimal exactness, and
 *  the tie-break — each returns a plausible number under a broken
 *  implementation. */
import { describe, expect, it } from 'vitest';
import {
  RECORDS_AGGREGATE_FNS,
  RECORDS_AGGREGATE_VALIDITY,
  RECORDS_GROUP_BY_KINDS,
  RECORDS_MAX_GROUPS,
  evaluateRecordsAggregate,
  evaluateRecordsGroupedAggregate,
  validateRecordsAggregateSelect,
  validateRecordsGroupBy,
  type RecordsFieldKind,
} from '../index.js';

const KINDS: Record<string, RecordsFieldKind> = {
  minutes: 'number',
  rate: 'decimal',
  worked_on: 'date',
  logged_at: 'datetime',
  task: 'string',
  note: 'text',
  billable: 'boolean',
  engagement_ref: 'ref',
};

const run = (rows: Record<string, unknown>[], select: Parameters<typeof evaluateRecordsAggregate>[1]) =>
  evaluateRecordsAggregate(rows, select, KINDS);

describe('validity matrix', () => {
  it('rejects sum on a date — a total of dates is not a quantity', () => {
    expect(validateRecordsAggregateSelect({ x: { fn: 'sum', field: 'worked_on' } }, KINDS))
      .toEqual([expect.stringContaining("'sum' is not valid on a date field")]);
  });

  it('⛔ rejects min/max on a string and says why, since ISO dates make it look fine', () => {
    const [msg] = validateRecordsAggregateSelect({ x: { fn: 'max', field: 'task' } }, KINDS);
    expect(msg).toContain("'max' is not valid on a string field");
    expect(msg).toContain('latest/earliest');   // the message must name the fix
  });

  it('latest/earliest need an ordering field, and it must be ordered', () => {
    expect(validateRecordsAggregateSelect({ x: { fn: 'latest', field: 'task' } }, KINDS))
      .toEqual([expect.stringContaining("requires 'by'")]);
    expect(validateRecordsAggregateSelect({ x: { fn: 'latest', field: 'task', by: 'note' } }, KINDS))
      .toEqual([expect.stringContaining('is text and is not ordered')]);
    expect(validateRecordsAggregateSelect({ x: { fn: 'latest', field: 'task', by: 'worked_on' } }, KINDS))
      .toEqual([]);
  });

  it("'by' on a non-ordering function is a mistake, not a no-op", () => {
    expect(validateRecordsAggregateSelect({ x: { fn: 'sum', field: 'minutes', by: 'worked_on' } }, KINDS))
      .toEqual([expect.stringContaining("'by' is only meaningful")]);
  });

  it('count alone is field-less; everything else must name a field', () => {
    expect(validateRecordsAggregateSelect({ n: { fn: 'count' } }, KINDS)).toEqual([]);
    expect(validateRecordsAggregateSelect({ n: { fn: 'sum' } }, KINDS))
      .toEqual([expect.stringContaining("'sum' requires a field")]);
  });

  it('reports EVERY problem, not just the first', () => {
    const problems = validateRecordsAggregateSelect(
      { a: { fn: 'sum', field: 'worked_on' }, b: { fn: 'nope' }, c: { fn: 'avg', field: 'ghost' } },
      KINDS,
    );
    expect(problems).toHaveLength(3);
  });

  it('is keyed by field KIND, so every kind has an explicit answer', () => {
    for (const kind of Object.keys(RECORDS_AGGREGATE_VALIDITY) as RecordsFieldKind[]) {
      expect(RECORDS_AGGREGATE_VALIDITY[kind].length, kind).toBeGreaterThan(0);
      for (const fn of RECORDS_AGGREGATE_VALIDITY[kind]) {
        expect(RECORDS_AGGREGATE_FNS).toContain(fn);
      }
    }
  });
});

describe('⛔ the empty set — where a broken implementation looks fine', () => {
  const empty = run([], {
    rows: { fn: 'count' }, n: { fn: 'count', field: 'minutes' },
    d: { fn: 'count_distinct', field: 'task' }, s: { fn: 'sum', field: 'minutes' },
    money: { fn: 'sum', field: 'rate' }, a: { fn: 'avg', field: 'minutes' },
    lo: { fn: 'min', field: 'minutes' }, hi: { fn: 'max', field: 'worked_on' },
    last: { fn: 'latest', field: 'task', by: 'worked_on' },
  });

  it('counts and sums are 0 — "you have nothing unbilled" is a real answer', () => {
    expect(empty).toMatchObject({ rows: 0, n: 0, d: 0, s: 0 });
  });

  it('a decimal sum of nothing is a fixed-point zero, not a number', () => {
    expect(empty.money).toBe('0.0000');
  });

  it('⛔ avg/min/max/latest are NULL — "your average is 0" would be a lie', () => {
    expect(empty.a).toBeNull();
    expect(empty.lo).toBeNull();
    expect(empty.hi).toBeNull();
    expect(empty.last).toBeNull();
  });
});

describe('⛔ decimal arithmetic is exact — the reason the family exists', () => {
  it('sums fixed-point strings without float drift', () => {
    // 0.1 + 0.2 !== 0.3 in float; three of them compound it.
    const rows = [{ rate: '0.1000' }, { rate: '0.2000' }, { rate: '0.3000' }];
    expect(run(rows, { t: { fn: 'sum', field: 'rate' } }).t).toBe('0.6000');
  });

  it('survives a sum that float would visibly get wrong', () => {
    const rows = Array.from({ length: 10 }, () => ({ rate: '0.1000' }));
    expect(run(rows, { t: { fn: 'sum', field: 'rate' } }).t).toBe('1.0000');
    // the float answer for comparison — this is what a naive implementation ships
    expect(rows.reduce((a, r) => a + Number(r.rate), 0)).not.toBe(1);
  });

  it('compares decimals by value, not by string — "9.0000" < "10.0000"', () => {
    const rows = [{ rate: '9.0000' }, { rate: '10.0000' }, { rate: '2.5000' }];
    expect(run(rows, { hi: { fn: 'max', field: 'rate' } }).hi).toBe('10.0000');
    expect(run(rows, { lo: { fn: 'min', field: 'rate' } }).lo).toBe('2.5000');
  });

  it('averages at the family scale rather than escaping to float', () => {
    const rows = [{ rate: '1.0000' }, { rate: '2.0000' }];
    expect(run(rows, { a: { fn: 'avg', field: 'rate' } }).a).toBe('1.5000');
  });
});

describe('counting', () => {
  const rows = [
    { minutes: 60, task: 'A' }, { minutes: 30, task: 'B' },
    { minutes: null, task: 'A' }, { minutes: 15 },
  ];

  it('count with NO field counts rows; count WITH a field counts non-null', () => {
    expect(run(rows, { r: { fn: 'count' } }).r).toBe(4);
    expect(run(rows, { m: { fn: 'count', field: 'minutes' } }).m).toBe(3);
    expect(run(rows, { t: { fn: 'count', field: 'task' } }).t).toBe(3);
  });

  it('count_distinct ignores repeats and absences alike', () => {
    expect(run(rows, { t: { fn: 'count_distinct', field: 'task' } }).t).toBe(2);
  });

  it('an empty string counts as ABSENT, matching the is_empty operator', () => {
    // Otherwise an optional slot written as "" would inflate every count by the
    // number of rows that left it blank.
    expect(run([{ task: '' }, { task: 'A' }], { t: { fn: 'count', field: 'task' } }).t).toBe(1);
  });
});

describe('latest / earliest', () => {
  const rows = [
    { task: 'first',  worked_on: '2026-07-01' },
    { task: 'newest', worked_on: '2026-07-20' },
    { task: 'middle', worked_on: '2026-07-10' },
  ];

  it('picks the value whose ordering field is greatest / least', () => {
    expect(run(rows, { x: { fn: 'latest', field: 'task', by: 'worked_on' } }).x).toBe('newest');
    expect(run(rows, { x: { fn: 'earliest', field: 'task', by: 'worked_on' } }).x).toBe('first');
  });

  it('⛔ on a TIE the first row in input order wins — deterministic, not scan-order', () => {
    const tied = [
      { task: 'alpha', worked_on: '2026-07-20' },
      { task: 'beta',  worked_on: '2026-07-20' },
    ];
    expect(run(tied, { x: { fn: 'latest', field: 'task', by: 'worked_on' } }).x).toBe('alpha');
    expect(run([...tied].reverse(), { x: { fn: 'latest', field: 'task', by: 'worked_on' } }).x).toBe('beta');
  });

  it('a row with no ordering value cannot win, even if it is the only one with a value', () => {
    const partial = [{ task: 'unordered' }, { task: 'dated', worked_on: '2026-07-01' }];
    expect(run(partial, { x: { fn: 'latest', field: 'task', by: 'worked_on' } }).x).toBe('dated');
  });

  it('returns null when the winning row has no value in the selected field', () => {
    const rows2 = [{ worked_on: '2026-07-20' }, { task: 'older', worked_on: '2026-07-01' }];
    expect(run(rows2, { x: { fn: 'latest', field: 'task', by: 'worked_on' } }).x).toBeNull();
  });
});

describe('the billable-hours shape it exists to serve', () => {
  const entries = [
    { minutes: 60, task: 'ENG-441', worked_on: '2026-07-02', engagement_ref: 'engagement/e1' },
    { minutes: 30, task: 'ENG-441', worked_on: '2026-07-09', engagement_ref: 'engagement/e1' },
    { minutes: 45, task: 'ENG-502', worked_on: '2026-07-14', engagement_ref: 'engagement/e2' },
  ];

  it('answers the whole rollup in one pass', () => {
    expect(run(entries, {
      unbilled_minutes: { fn: 'sum', field: 'minutes' },
      entry_count:      { fn: 'count' },
      task_count:       { fn: 'count_distinct', field: 'task' },
      engagements:      { fn: 'count_distinct', field: 'engagement_ref' },
      last_worked_on:   { fn: 'max', field: 'worked_on' },
      last_task:        { fn: 'latest', field: 'task', by: 'worked_on' },
    })).toEqual({
      unbilled_minutes: 135, entry_count: 3, task_count: 2, engagements: 2,
      last_worked_on: '2026-07-14', last_task: 'ENG-502',
    });
  });

  it('⚠ carries MINUTES, never money — the rate lives on the parent, so a', () => {
    // weighted sum across engagements at different rates is not expressible in
    // a closed function set. D-226: that the declaration CANNOT express it is
    // the signal the topic needs a producer, not a wider vocabulary.
    expect(validateRecordsAggregateSelect(
      { amount: { fn: 'sum', field: 'minutes * rate' } }, KINDS,
    )).toEqual([expect.stringContaining('unknown field')]);
  });
});

// ── grouping ────────────────────────────────────────────────────────────────
describe('⛔ grouped aggregation — one row per key, and every one of them exact', () => {
  const grouped = (rows: Record<string, unknown>[], by: string,
                   select: Parameters<typeof evaluateRecordsAggregate>[1]) =>
    evaluateRecordsGroupedAggregate(rows, by, select, KINDS);
  const OWED = { total: { fn: 'sum', field: 'rate' }, n: { fn: 'count' } } as const;
  const rows = [
    { task: 'acme', rate: '1234.1000', minutes: 60 },
    { task: 'acme', rate: '5678.2000', minutes: 30 },
    { task: 'globex', rate: '10.5000', minutes: 15 },
  ];

  it('splits by key and keeps each total to itself', () => {
    const out = grouped(rows, 'task', OWED);
    expect(out.group_by).toBe('task');
    expect(out.groups.map(g => g.key)).toEqual(['acme', 'globex']);
    expect(out.groups[0]!.values).toEqual({ total: '6912.3000', n: 2 });
    expect(out.groups[1]!.values).toEqual({ total: '10.5000', n: 1 });
    expect(out.complete).toBe(true);
  });

  it('⛔⛔ money stays exact per group — the float sum is visibly wrong', () => {
    // Same witness as the fan-out test: this pair actually breaks IEEE-754, so
    // a float implementation fails here rather than passing by luck.
    expect(1234.10 + 5678.20).not.toBe(6912.30);
    expect(grouped(rows, 'task', OWED).groups[0]!.values.total).toBe('6912.3000');
  });

  it('⛔⛔ grouped totals RECONCILE with the ungrouped total over the same rows', () => {
    // The property that says grouping did not become a second evaluator. If
    // these ever disagree, both answers look internally consistent and nothing
    // else in the suite notices.
    const parts = grouped(rows, 'task', OWED).groups
      .map(g => BigInt(String(g.values.total).replace('.', '')))
      .reduce((a, b) => a + b, 0n);
    const whole = BigInt(String(run(rows, OWED).total).replace('.', ''));
    expect(parts).toBe(whole);
  });

  it('⛔ an absent key gets a NULL bucket — never the string "null"', () => {
    // The transforms-layer `group_by` keys on `safeString(value ?? 'null')`,
    // which merges a missing value with a field literally holding "null". Here
    // the two are different buckets and the absent one is a JSON null.
    const out = grouped([
      { rate: '5.0000' },                       // absent
      { task: '', rate: '3.0000' },             // empty counts as absent
      { task: 'null', rate: '7.0000' },         // the literal string
      { task: 'acme', rate: '1.0000' },
    ], 'task', OWED);
    expect(out.groups.map(g => g.key)).toEqual(['acme', 'null', null]);
    expect(out.groups.find(g => g.key === null)!.values).toEqual({ total: '8.0000', n: 2 });
    expect(out.groups.find(g => g.key === 'null')!.values.total).toBe('7.0000');
  });

  it('⚠ the absent bucket sorts LAST, and order is stable between reads', () => {
    const of = () => grouped([
      { task: 'zeta', rate: '1.0000' }, { rate: '1.0000' }, { task: 'alpha', rate: '1.0000' },
    ], 'task', OWED).groups.map(g => g.key);
    expect(of()).toEqual(['alpha', 'zeta', null]);
    expect(of()).toEqual(of());
  });

  it('groups a boolean and a ref, not just strings', () => {
    expect(grouped([{ billable: true, minutes: 60 }, { billable: false, minutes: 30 },
                    { billable: true, minutes: 15 }], 'billable',
                   { m: { fn: 'sum', field: 'minutes' } }).groups)
      .toEqual([{ key: false, values: { m: 30 } }, { key: true, values: { m: 75 } }]);
  });
});

describe('⛔⛔ the group cap: what is missing is GROUPS, never a group\'s number', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => [
    { task: `c${String(i).padStart(4, '0')}`, minutes: 10 },
    { task: `c${String(i).padStart(4, '0')}`, minutes: 5 },
  ]).flat();
  const SEL = { m: { fn: 'sum', field: 'minutes' }, n: { fn: 'count' } } as const;

  it('under the cap, everything is there and complete', () => {
    const out = evaluateRecordsGroupedAggregate(many(RECORDS_MAX_GROUPS), 'task', SEL, KINDS);
    expect(out.groups).toHaveLength(RECORDS_MAX_GROUPS);
    expect(out.complete).toBe(true);
    expect(out.incomplete_reason).toBeUndefined();
  });

  it('⛔ over it, new keys are DROPPED and the survivors are still whole', () => {
    // The tempting alternative — stop mid-scan — would return groups whose
    // totals are short by an unknowable amount and look completely ordinary.
    // Refusing the KEY keeps every number that IS shown correct.
    const out = evaluateRecordsGroupedAggregate(many(RECORDS_MAX_GROUPS + 50), 'task', SEL, KINDS);
    expect(out.groups).toHaveLength(RECORDS_MAX_GROUPS);
    expect(out.complete).toBe(false);
    expect(out.incomplete_reason).toBe('group_cap');
    for (const g of out.groups) expect(g.values).toEqual({ m: 15, n: 2 });
  });

  it('⚠ a dropped key\'s rows do not leak into some other group', () => {
    const out = evaluateRecordsGroupedAggregate(
      [...many(RECORDS_MAX_GROUPS), { task: 'overflow', minutes: 999 }], 'task', SEL, KINDS);
    expect(out.groups.every(g => g.values.m === 15)).toBe(true);
    expect(out.groups.map(g => g.key)).not.toContain('overflow');
  });
});

describe('group keys are a NARROWER vocabulary than aggregatable fields', () => {
  it('⛔ refuses a datetime, and says a date is the fix', () => {
    const [msg] = validateRecordsGroupBy('logged_at', KINDS);
    expect(msg).toContain('cannot be a group key');
    expect(msg).toContain('use a date field');
  });

  it('refuses number, decimal and text — none of them are categories', () => {
    for (const field of ['minutes', 'rate', 'note']) {
      expect(validateRecordsGroupBy(field, KINDS), field).toHaveLength(1);
    }
  });

  it('⛔ the guard PERMITS every kind it is meant to', () => {
    // The half that separates a vocabulary from a blanket refusal.
    for (const field of ['task', 'worked_on', 'billable', 'engagement_ref']) {
      expect(validateRecordsGroupBy(field, KINDS), field).toEqual([]);
    }
  });

  it('the admitted list and the kinds that pass are the SAME set', () => {
    // Derived both ways, so widening one without the other is a red rather
    // than a validator that quietly disagrees with its own constant.
    const passing = Object.entries(KINDS)
      .filter(([field]) => validateRecordsGroupBy(field, KINDS).length === 0)
      .map(([, kind]) => kind);
    expect([...new Set(passing)].sort()).toEqual([...RECORDS_GROUP_BY_KINDS].sort());
  });

  it('rejects an unknown field and a non-string', () => {
    expect(validateRecordsGroupBy('nope', KINDS)).toEqual([expect.stringContaining('unknown field')]);
    expect(validateRecordsGroupBy(42, KINDS)).toHaveLength(1);
    expect(validateRecordsGroupBy('', KINDS)).toHaveLength(1);
  });
});
