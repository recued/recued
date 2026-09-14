/** D-269 step 1 — D-139 § A.3.7's third fallback step finally has a supplier.
 *
 *  ⛔⛔ WHAT WAS BROKEN, AND WHY NOTHING CAUGHT IT. The engagement timezone
 *  chain is documented as `vendor → calendar adapter → prefs.timezone → UTC`.
 *  Eleven reconcilers/leaves declared `prefsTimezone?: () => string | null |
 *  undefined` for that third step, `resolveEngagementTzHint` reads it, and the
 *  step is exercised by its own unit tests — but **no composition root ever
 *  supplied the reader**, and `INSTANCE_PREFS` had no `timezone` key for it to
 *  read even if one had. The only mention in composition was a comment saying
 *  `prefsTimezone` stays default.
 *
 *  ⇒ Every engagement whose vendor stamped no zone fell through to the UTC
 *  sentinel with `event_at_tz_inferred: true`. The chain reported three steps
 *  and ran two, and it did so at `success: true` forever.
 *
 *  🔑 SO THE UNIT IS NOT THE SUBJECT HERE. `resolveEngagementTzHint` was always
 *  correct; the defect was that its third branch was unreachable in production.
 *  These tests pin the BRANCH BEHAVIOUR and then pin that the wiring exists,
 *  because only the pair distinguishes "declared" from "backed". */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { resolveServerTimeZone } from '@recued/contracts';
import { resolveEngagementTzHint } from '../data/hubspot/engagement-shared.js';
import { createServerTimeZoneStore } from '../storage/server-timezone-store.js';

const HOST = 'Europe/Paris';

describe('D-269 — the third fallback step resolves on the owner\'s clock', () => {
  it('⛔ WITHOUT a supplier it lands on the UTC sentinel — the shipped behaviour until now', () => {
    const out = resolveEngagementTzHint({});
    expect(out).toEqual({ tz: 'UTC', inferred: true });
    // ⚠ `inferred: true` is the flag producers turn into `'tz_inferred'` in
    // `coverage.sources_degraded`. It is the difference between "we know" and
    // "we guessed", and it was always the latter.
  });

  it('🔑 WITH one, the engagement resolves on the declared server zone, NOT inferred', () => {
    const db = new Database(':memory:');
    const store = createServerTimeZoneStore(db);
    store.write('fixed', 'Asia/Hong_Kong', 1);

    const out = resolveEngagementTzHint({
      prefsTimezone: () => resolveServerTimeZone(store.read(), HOST),
    });
    expect(out).toEqual({ tz: 'Asia/Hong_Kong', inferred: false });
  });

  it('⚠ a laptop server (`follows_host`) resolves on the HOST clock, still not inferred', () => {
    const db = new Database(':memory:');
    const store = createServerTimeZoneStore(db);
    store.write('follows_host', null, 1);
    const out = resolveEngagementTzHint({
      prefsTimezone: () => resolveServerTimeZone(store.read(), 'Europe/London'),
    });
    expect(out).toEqual({ tz: 'Europe/London', inferred: false });
  });

  it('⛔ the vendor and calendar hints still WIN — this is the third step, not the first', () => {
    // A real vendor stamp is knowledge; the server's clock is a default. An
    // implementation that let the default outrank the stamp would be worse
    // than the unwired one it replaces.
    const prefsTimezone = (): string => 'Asia/Hong_Kong';
    expect(resolveEngagementTzHint({ vendorTzHint: 'America/New_York', prefsTimezone }))
      .toEqual({ tz: 'America/New_York', inferred: false });
    expect(resolveEngagementTzHint({ calendarAdapterTzHint: 'Europe/Berlin', prefsTimezone }))
      .toEqual({ tz: 'Europe/Berlin', inferred: false });
  });

  it('a throwing reader degrades to the sentinel rather than aborting the ingest', () => {
    const out = resolveEngagementTzHint({
      prefsTimezone: () => { throw new Error('store closed'); },
    });
    expect(out).toEqual({ tz: 'UTC', inferred: true });
  });
});

describe('D-269 — and the supplier EXISTS, which is the half that was missing', () => {
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

  it('⛔ the composition roots supply prefsTimezone off the server timezone store', () => {
    // ⚠ THIS IS THE ASSERTION THE OLD CODE WOULD HAVE FAILED. Everything above
    // passed before D-269 too — the branch was tested in isolation and dead in
    // production. A reader with no supplier is the exact shape of that defect,
    // so the wiring is pinned here rather than assumed from a green unit.
    for (const path of [
      'backend/server/src/serve/start-housekeeping-startup.ts',
      'backend/server/src/serve/start-post-listener-runtime.ts',
    ]) {
      const src = read(path);
    // ⚠ SOURCE-TEXT, DELIBERATELY AND NARROWLY: this asserts a composition root
    // MENTIONS the thing it must pass, which catches a deleted supply and
    // nothing else. It cannot catch a wrong one. Kept because the alternative
    // here is no coverage at all — unlike the sweep wiring, which is now driven
    // in `d-269-reminder-composition-drive.test.ts`. See D-269 REV 21.
      expect(src).toContain('prefsTimezone:');
      expect(src).toContain('serverTimeZoneStore.read()');
    }
  });

  it('⛔ and every vendor boot FORWARDS it into its reconcilers', () => {
    // A supplier at the composition root that no vendor forwards would be the
    // same defect one layer down.
    for (const path of [
      'backend/server/src/data/hubspot/boot.ts',
      'backend/server/src/data/salesforce/boot.ts',
      'backend/server/src/serve/compose-generic-engagement-reconciliation.ts',
    ]) {
      expect(read(path)).toContain('prefsTimezone');
    }
  });
});
