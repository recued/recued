/** ⛔⛔ ONE USAGE-CAP VOCABULARY, ONE WINDOW BOUNDARY.
 *
 *  Six mechanisms in this tree answer "how many uses are left", and they shared
 *  no type, no field names and no protocol (see
 *  internal design notes). The consolidation is
 *  deliberately NOT a merge of their storage — a session grant's window is the
 *  row's own life, a seller plan counts billable units against a tier, and a
 *  contract counts dispatches — but two things genuinely were duplicated, and
 *  both are pinned here.
 *
 *  🔑 THE ONE THAT COULD BE WRONG IS THE ARITHMETIC. "When does the UTC month
 *  start" had THREE implementations: `usageCapWindowStart` in contracts,
 *  `sellerCustomerUsagePeriodStart`, and a third PRIVATE copy inside
 *  `customer-status.ts` that an edit to the exported one would never have
 *  reached. They agreed byte-for-byte, so nothing was broken — and that is
 *  exactly why it needed a test rather than a fix: a dispatch counted against
 *  one boundary and billed against another is a discrepancy no suite would
 *  show, because each copy is self-consistent.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SELLER_USAGE_PERIOD_GRANULARITIES,
  USAGE_CAP_PERIODS,
  usageCapWindowStart,
  type SellerUsagePeriodGranularity,
} from '@recued/contracts';

import { sellerCustomerUsagePeriodStart } from '../seller/customer-usage-policy.js';

const SELLER_DIR = fileURLToPath(new URL('../seller/', import.meta.url));

describe('usage-cap vocabulary — the seller granularity is a subset of the cap periods', () => {
  it('every billing granularity is a cap period', () => {
    for (const granularity of SELLER_USAGE_PERIOD_GRANULARITIES) {
      expect(USAGE_CAP_PERIODS as readonly string[]).toContain(granularity);
    }
  });

  /** ⚠ THE LISTS ARE DELIBERATELY NOT DERIVED FROM ONE ANOTHER, and this test
   *  states the reason rather than hiding it. Whether every cap period is a
   *  valid BILLING period is a policy question with money attached — deriving
   *  the seller's list would answer it silently, and a later `'week'` added for
   *  a door would become a billing period nobody chose. So they stay separate
   *  and the CONTAINMENT is pinned: the two may differ only by `'total'`, which
   *  a rolling billing period has no meaning for. */
  it('and the only difference is `total`, which a billing period cannot mean', () => {
    const sellerSet = new Set<string>(SELLER_USAGE_PERIOD_GRANULARITIES);
    const capOnly = USAGE_CAP_PERIODS.filter((p) => !sellerSet.has(p));
    expect(capOnly).toEqual(['total']);
  });
});

describe('usage-cap vocabulary — one window boundary', () => {
  /** Instants chosen to break a wrong implementation rather than to pass a right
   *  one: exactly on each boundary, one millisecond either side of both, a
   *  month-length edge (31st), a leap day, and a year boundary. */
  const INSTANTS = [
    Date.UTC(2024, 0, 1),                  // month + day + year boundary, exact
    Date.UTC(2024, 0, 1) - 1,              // one ms before — the previous year
    Date.UTC(2024, 0, 1) + 1,              // one ms after
    Date.UTC(2024, 1, 29, 23, 59, 59, 999), // leap day, last ms
    Date.UTC(2024, 2, 1),                  // the month after a leap February
    Date.UTC(2023, 11, 31, 12, 0, 0),      // mid-day on a 31st
    Date.UTC(2023, 10, 14, 22, 13, 20),    // an arbitrary mid-window instant
  ];

  it('the seller period start IS the shared cap window start', () => {
    for (const granularity of SELLER_USAGE_PERIOD_GRANULARITIES) {
      for (const at of INSTANTS) {
        expect(
          sellerCustomerUsagePeriodStart(at, granularity),
          `granularity=${granularity} at=${new Date(at).toISOString()}`,
        ).toBe(usageCapWindowStart(granularity, at));
      }
    }
  });

  it('a day window is inside its month window, and both are in the past', () => {
    // The property that makes them composable at all — and the one a
    // hand-rolled copy is most likely to get backwards.
    for (const at of INSTANTS) {
      const day = usageCapWindowStart('day', at)!;
      const month = usageCapWindowStart('month', at)!;
      expect(month).toBeLessThanOrEqual(day);
      expect(day).toBeLessThanOrEqual(at);
    }
  });

  /** ⛔ AND THE ARITHMETIC ITSELF LIVES IN ONE PLACE. The behavioural check above
   *  catches DIVERGENCE; it cannot catch someone re-hand-rolling a copy that
   *  happens to still agree — which is precisely how the third copy arrived and
   *  sat unnoticed. This catches the re-duplication instead. */
  it('the seller surface hand-rolls no UTC boundary of its own', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SELLER_DIR)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const src = readFileSync(join(SELLER_DIR, name), 'utf8');
      // The signature of the copies that were here: `Date.UTC(` built from
      // `getUTCFullYear()` / `getUTCMonth()` on a local `new Date(...)`.
      if (/Date\.UTC\(/.test(src) && /getUTCFullYear\(\)/.test(src)) {
        offenders.push(name);
      }
    }
    expect(
      offenders,
      'a UTC window boundary belongs to `usageCapWindowStart`; delegate instead of re-deriving',
    ).toEqual([]);
  });

  it('MUTATION: the source check can actually see a hand-rolled boundary', () => {
    // ⚠ Without this the check above passes just as happily against a regex that
    // matches nothing — the failure mode the whole file is about.
    const planted = 'const x = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);';
    expect(/Date\.UTC\(/.test(planted) && /getUTCFullYear\(\)/.test(planted)).toBe(true);
  });
});
