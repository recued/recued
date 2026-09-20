/** ⛔⛔ `new Date(null)` IS EPOCH 0, NOT AN INVALID DATE — AND THE `isNaN` GUARD
 *  EVERY DATE TRANSFORM USES LETS IT THROUGH.
 *
 *  `date_parse` found this, fixed it, and wrote the reason down: *"an absent
 *  date (e.g. an AI-extracted `due_date` that is null when unstated) would be
 *  silently stamped 1970-01-01 and written downstream (task `due_at` etc)"*.
 *  Its two siblings in the same file kept the bug:
 *
 *    value   toDate → is_past   date_format('YYYY-MM-DD')   date_parse
 *    null    true  (1970)       1969-12-31                  null   ✓
 *    false   true  (1970)       1969-12-31                  0
 *    true    true  (1970)       1969-12-31                  1
 *
 *  `toDate` backs `is_past`, `is_future`, `date_diff` and `date_add`, so a
 *  recipe asking "has this deadline passed?" about a null date was told YES —
 *  and `is_future(null)` said `false`, so both gates agreed the missing date
 *  was in the past. `date_diff(from: null, to: 'now')` returned 20,713 days: a
 *  plausible number, not a null.
 *
 *  🔑 THE ASYMMETRY IS WHY IT SURVIVED. `undefined`, `''`, `[]` and `{}` all
 *  fall out as Invalid Date and need no guard. So a MISSING field behaves
 *  correctly and an explicit `null` — a vendor JSON null, a SQL NULL, an LLM
 *  emitting `null` for an unstated field — does not. Authoring looks fine;
 *  production does not.
 *
 *  ⚠ Booleans are the same class and `date_parse`'s own guard missed them:
 *  `new Date(true)` is `1970-01-01T00:00:00.001Z`.
 *
 *  ⚠ NUMERIC `0` IS NOT IN THE REFUSE-SET, deliberately — `date_parse(0)`
 *  returns `0` today, and "0 is not a date" is a different call from "null is
 *  not a date". Same for a unix-SECONDS number, which `new Date()` reads as
 *  1970 while `toRecentMs` normalises. Both are real and both are separate. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  date_add,
  date_diff,
  date_format,
  date_parse,
  is_future,
  is_past,
} from '../date.js';

const ctx = { now: () => new Date('2026-09-17T12:00:00.000Z') } as never;

/** Not dates, but `new Date()` turns each into a valid one. */
const NON_DATES: ReadonlyArray<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ["''", ''],
  ['false', false],
  ['true', true],
];

describe('a value that is not a date is not 1970', () => {
  it('CONTROL: the transforms still work on a real date', () => {
    // ⛔ Without this, a guard that refused EVERYTHING would pass every
    //   assertion below.
    expect(is_past({ date: '2020-03-02T00:00:00Z' }, ctx)).toBe(true);
    expect(is_future({ date: '2030-03-02T00:00:00Z' }, ctx)).toBe(true);
    expect(date_format({ date: '2020-03-02T12:00:00Z', format: 'YYYY-MM' }, ctx))
      .toBe('2020-03');
    expect(date_parse({ input: '2020-03-02T00:00:00Z' }, ctx)).toBe(1583107200000);
    expect(date_add({ date: '2020-03-02T00:00:00Z', amount: 1, unit: 'days' }, ctx))
      .toBe('2020-03-03T00:00:00.000Z');
    expect(date_diff({ from: '2020-03-01T00:00:00Z', to: '2020-03-03T00:00:00Z', unit: 'days' }, ctx))
      .toBe(2);
  });

  for (const [label, value] of NON_DATES) {
    it(`${label} is null everywhere, not a 1970 date`, () => {
      expect(is_past({ date: value }, ctx), 'is_past').toBeNull();
      expect(is_future({ date: value }, ctx), 'is_future').toBeNull();
      expect(date_format({ date: value, format: 'YYYY-MM-DD' }, ctx), 'date_format').toBeNull();
      expect(date_parse({ input: value }, ctx), 'date_parse').toBeNull();
      expect(date_add({ date: value, amount: 1, unit: 'days' }, ctx), 'date_add').toBeNull();
      expect(date_diff({ from: value, to: 'now', unit: 'days' }, ctx), 'date_diff').toBeNull();
    });
  }

  it('the three deciders agree — one refuse-set, not three', () => {
    // The bug was not that a guard was missing; it was that ONE of three
    // siblings had it. Parity is the property, so a future fix to one of them
    // cannot silently leave the others behind.
    for (const [label, value] of NON_DATES) {
      const answers = [
        is_past({ date: value }, ctx),
        date_format({ date: value, format: 'YYYY-MM-DD' }, ctx),
        date_parse({ input: value }, ctx),
      ];
      expect(new Set(answers.map((a) => a === null)).size, `${label}: ${JSON.stringify(answers)}`)
        .toBe(1);
    }
  });

  it('`now` still resolves through the guard', () => {
    // `'now'` is handled before the refuse-set; a guard placed above it would
    // break every relative-date recipe.
    expect(is_past({ date: 'now' }, ctx)).toBe(false);
    expect(is_future({ date: 'now' }, ctx)).toBe(false);
    expect(date_diff({ from: 'now', to: 'now', unit: 'days' }, ctx)).toBe(0);
  });

  it('RATCHET: every `new Date(` in date.ts sits behind the shared decider', () => {
    // ⚠ A fourth sibling would reintroduce this exactly as the third did. The
    //   file is small enough that the check is a read, not a parse.
    const src = readFileSync(
      fileURLToPath(new URL('../date.ts', import.meta.url)),
      'utf8',
    );
    const constructions = [...src.matchAll(/new Date\(/g)];
    expect(constructions.length, 'the scan found no `new Date(` at all').toBeGreaterThan(2);
    // Each construction that takes a CALLER value must be preceded, within its
    // function, by the shared decider. `new Date(d.getTime() + ms)` and
    // `new Date(ms)` build from an already-validated number and are exempt.
    const callerFed = [...src.matchAll(/new Date\((p\.\w+|raw|v) as string\)|new Date\((p\.\w+|raw|v)\)/g)];
    expect(callerFed.length, 'no caller-fed `new Date(` found — the scan broke')
      .toBeGreaterThanOrEqual(3);
    expect(src, 'the shared decider is gone').toContain('const isNonDateValue =');
    // ⚠ CALL SITES ONLY — the declaration reads `isNonDateValue = (`, so it does
    //   NOT match this pattern. The first cut of this assertion added one for it
    //   and failed on the correct code, which is the whole reason to assert a
    //   number you can derive rather than one you counted by hand.
    const guards = [...src.matchAll(/isNonDateValue\(/g)];
    expect(
      guards.length,
      `${callerFed.length} caller-fed \`new Date(\` but only ${guards.length} guarded — `
        + 'a fourth date path was added without the decider',
    ).toBeGreaterThanOrEqual(callerFed.length);
  });

  it('a bad `unit` is null, not NaN and not a RangeError', () => {
    // ⛔ `DIVISORS[bad]` is undefined: `date_diff` divided by it and returned
    //   NaN; `date_add` multiplied by it and threw RangeError from
    //   `.toISOString()`. Every sibling in this file returns null.
    for (const unit of [undefined, null, '', 'fortnights', 7, {}]) {
      expect(date_add({ date: '2020-03-02T00:00:00Z', amount: 1, unit }, ctx), String(unit))
        .toBeNull();
      expect(date_diff({ from: '2020-03-01T00:00:00Z', to: '2020-03-03T00:00:00Z', unit }, ctx), String(unit))
        .toBeNull();
    }
  });

  it('a non-numeric `amount` is null, not a silent no-op', () => {
    // ⚠ `null` / `''` / `[]` each coerce through `Number()` to a valid 0, so an
    //   UNSET config returned "the same date" as though it had worked.
    const base = { date: '2020-03-02T00:00:00Z', unit: 'days' };
    for (const amount of [null, undefined, '', '  ', 'abc', [], {}, true, Number.NaN, Infinity]) {
      expect(date_add({ ...base, amount }, ctx), JSON.stringify(amount)).toBeNull();
    }
  });

  it('a numeric STRING amount still works — 37 shipped steps pass a template', () => {
    // ⛔ The guard must not reject the resolved form of
    //   `"amount": "{{config.no_response_timeout_days}}"`.
    const base = { date: '2020-03-02T00:00:00Z', unit: 'days' };
    expect(date_add({ ...base, amount: '1' }, ctx)).toBe('2020-03-03T00:00:00.000Z');
    expect(date_add({ ...base, amount: '-1' }, ctx)).toBe('2020-03-01T00:00:00.000Z');
    expect(date_add({ ...base, amount: 1.5 }, ctx)).toBe('2020-03-03T12:00:00.000Z');
    // And an explicit zero stays the documented no-op (231 shipped steps).
    expect(date_add({ ...base, amount: 0 }, ctx)).toBe('2020-03-02T00:00:00.000Z');
    expect(date_add({ ...base, amount: '0' }, ctx)).toBe('2020-03-02T00:00:00.000Z');
  });

  it('an amount that overflows the Date range is null, not a throw', () => {
    // The product is Infinity → Invalid Date → RangeError, but only at
    // `.toISOString()`, which is why the guard has to be after the arithmetic.
    expect(date_add({ date: '2020-03-02T00:00:00Z', amount: 1e308, unit: 'days' }, ctx))
      .toBeNull();
  });

  it('MUTATION: the unguarded expression really does produce a 1970 date', () => {
    // ⚠ Every assertion above is "expect null", which passes just as happily
    //   against a transform that returns null for everything. This pins what
    //   the guard is actually preventing.
    expect(new Date(null as unknown as number).getTime()).toBe(0);
    expect(Number.isNaN(new Date(null as unknown as number).getTime())).toBe(false);
    expect(new Date(true as unknown as number).getTime()).toBe(1);
    // …while the values that never needed a guard really are Invalid.
    expect(Number.isNaN(new Date(undefined as unknown as number).getTime())).toBe(true);
    expect(Number.isNaN(new Date('').getTime())).toBe(true);
  });
});
