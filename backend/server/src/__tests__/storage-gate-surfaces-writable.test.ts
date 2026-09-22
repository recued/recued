/** Every configured surface must accept a write on an EMPTY server.
 *
 *  ⛔⛔ THIS IS THE TEST THAT WAS MISSING, AND TWO SURFACES SHIPPED DEAD
 *  WITHOUT IT. The reserve is `max(MIN_RESERVE_BYTES, quota × pct)` and
 *  `blockedAt = quota − reserve`, so any quota at or below the 10 MB floor
 *  computed `blockedAt = 0` — and the gate blocks on `used >= blockedAt`,
 *  which at zero bytes is true. `schedules` (5 MB) and `account_store`
 *  (exactly 10 MB) were therefore permanently `writes_blocked` on every
 *  install: `schedules.create` could not succeed anywhere, ever.
 *
 *  ⚠ NOTHING CAUGHT IT because every existing gate test picks its own quota
 *  and asserts the transitions in the abstract. None of them asked the only
 *  question that matters at boot — *can this surface, as actually configured,
 *  take a byte?* Found by seeding a demo, which was the first thing in a long
 *  while to call `schedules.create` for real.
 *
 *  🔑 DERIVED FROM `QUOTA_FALLBACKS`, NEVER A HAND-WRITTEN LIST. A surface
 *  added tomorrow with a sub-floor quota is caught here on its first run; a
 *  list that had to be updated by hand would have let exactly this through,
 *  which is how it got here. */
import { describe, expect, it } from 'vitest';

import { createStorageGate } from '@recued/storage-gate';
import { MAX_RESERVE_FRACTION, MIN_RESERVE_BYTES } from '@recued/storage-gate';

import { QUOTA_FALLBACKS } from '../storage-gates.js';

const RESERVE_PCT = 10;

describe('every gated surface is writable at boot', () => {
  const surfaces = Object.entries(QUOTA_FALLBACKS) as Array<[string, number]>;

  it('covers every surface the registry can build', () => {
    // Guards the guard: a surface dropped from the map would silently shrink
    // this suite to nothing.
    expect(surfaces.length).toBeGreaterThanOrEqual(6);
  });

  it.each(surfaces)('⛔ %s accepts a write at used=0', (surface, quota) => {
    const gate = createStorageGate({
      quota, reservePct: RESERVE_PCT, surface: surface as never, now: () => 1,
    });
    gate.setUsed(0);
    const info = gate.info();
    expect(
      info.state,
      `${surface} (quota ${quota}) is ${info.state} on an EMPTY server — `
      + `reserve ${info.reserve} leaves blockedAt ${info.blockedAt}`,
    ).toBe('running');
    // The reason it is running, asserted directly: an empty surface with no
    // headroom is the bug, and `state` alone would pass if the thresholds
    // were fixed by accident somewhere else.
    expect(info.blockedAt).toBeGreaterThan(0);
  });

  it('⛔ the reserve never consumes the whole quota, however small', () => {
    // The class of bug, not the two instances of it. A quota well under the
    // floor must still leave room, or the next sub-floor surface repeats it.
    for (const quota of [1, 1024, 1024 * 1024, MIN_RESERVE_BYTES, MIN_RESERVE_BYTES * 2]) {
      const gate = createStorageGate({
        quota, reservePct: RESERVE_PCT, surface: 'schedules', now: () => 1,
      });
      gate.setUsed(0);
      const info = gate.info();
      expect(info.reserve, `reserve ate the whole ${quota}B quota`)
        .toBeLessThanOrEqual(Math.floor(quota * MAX_RESERVE_FRACTION));
      expect(info.blockedAt, `${quota}B quota left no writable room`).toBeGreaterThan(0);
    }
  });
});
