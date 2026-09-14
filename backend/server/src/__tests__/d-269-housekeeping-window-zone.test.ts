/** D-269 — the housekeeping custom window is the owner's hours, not the host's.
 *
 *  ⛔ THE DEFECT. `inCustomWindow` read `new Date(now).getHours()` — the HOST's
 *  clock. The owner sets *"do background work between 22:00 and 05:00"* in
 *  Settings → Housekeeping, and nothing in the contract ever said whose 22:00,
 *  so on a VPS it was the datacenter's. Milder than the cron defect (it delays
 *  work rather than misfiring it) but the same silent assumption.
 *
 *  ⚠ AND THE CROSS-MIDNIGHT RULE IS NO LONGER RE-IMPLEMENTED HERE. This file and
 *  quiet hours had independently arrived at the same predicate, including the
 *  `start === end → false` choice. Convergence is reassuring about the rule and
 *  a warning about the duplication — the next person to fix one would not have
 *  known about the other. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMinuteWithinWindow } from '@recued/contracts';
import { inCustomWindow } from '../housekeeping/scheduler.js';

/** 02:00 Hong Kong / 19:00 London, the same instant. */
const NIGHT_HK = Date.parse('2026-06-15T18:00:00Z');

describe('D-269 — the window is read in the OWNER\'s zone', () => {
  it('⛔ the same instant is inside the window in one zone and outside in another', () => {
    // The whole bug, stated as the fix. 22:00→05:00 covers 02:00 Hong Kong and
    // not 19:00 London, and until now which one you got depended on where the
    // process happened to run.
    expect(inCustomWindow(NIGHT_HK, 22, 5, 'Asia/Hong_Kong')).toBe(true);
    expect(inCustomWindow(NIGHT_HK, 22, 5, 'Europe/London')).toBe(false);
  });

  it('⚠ absent zone still means host-local — every existing caller keeps its meaning', () => {
    const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(inCustomWindow(NIGHT_HK, 22, 5))
      .toBe(inCustomWindow(NIGHT_HK, 22, 5, runnerZone));
  });

  it('cross-midnight and same-day windows both still behave', () => {
    expect(inCustomWindow(NIGHT_HK, 22, 5, 'Asia/Hong_Kong')).toBe(true);   // 02:00
    expect(inCustomWindow(NIGHT_HK, 1, 3, 'Asia/Hong_Kong')).toBe(true);    // 02:00 in [1,3)
    expect(inCustomWindow(NIGHT_HK, 3, 6, 'Asia/Hong_Kong')).toBe(false);
  });

  it('⛔ an empty window runs NOTHING — not "all day"', () => {
    // Reading `start === end` as all-day lets one mis-set field turn
    // housekeeping permanently on (or, for quiet hours, silence everything).
    expect(inCustomWindow(NIGHT_HK, 3, 3, 'Asia/Hong_Kong')).toBe(false);
  });
});

describe('D-269 — one predicate, not two', () => {
  it('🔑 housekeeping now AGREES with quiet hours by construction, not by luck', () => {
    // Both surfaces answer "is this minute inside [from, to)" with midnight
    // crossing. Driving the shared predicate against the housekeeping wrapper
    // pins that they cannot drift apart again.
    for (const [h, start, end] of [
      [2, 22, 5], [19, 22, 5], [22, 22, 5], [5, 22, 5], [4, 22, 5],
      [13, 13, 14], [14, 13, 14], [3, 3, 3],
    ] as const) {
      const instant = Date.parse(`2026-06-15T${String(h).padStart(2, '0')}:00:00Z`);
      expect(inCustomWindow(instant, start, end, 'UTC'))
        .toBe(isMinuteWithinWindow(h * 60, start * 60, end * 60));
    }
  });

  it('⛔ and the local re-implementation is GONE, not merely unused', () => {
    // An unused copy reads the same as a deleted one from a doc and differently
    // from the code: the first can be called again.
    const src = readFileSync(
      join(process.cwd(), 'backend/server/src/housekeeping/scheduler.ts'), 'utf8',
    );
    expect(src).toContain('isMinuteWithinWindow');
    // The old body's tell-tale comparisons must not survive anywhere in the file.
    expect(src).not.toContain('hour >= start_hour && hour < end_hour');
    expect(src).not.toContain('hour >= start_hour || hour < end_hour');
  });
});

describe('D-269 — the zone is SUPPLIED, not merely accepted', () => {
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

  it('⛔ the gate passes it, and the composition root builds it off the declared-zone store', () => {
    // `time_zone` is optional and falls back to host-local, so a missing
    // supplier is invisible: the window keeps working, on the wrong clock.
    const sched = read('backend/server/src/housekeeping/scheduler.ts');
    expect(sched).toContain('custom_window_end_hour, time_zone,');
    expect(sched).toContain('opts.serverTimeZone?.()');
    expect(read('backend/server/src/composition/bin/wire-housekeeping-substrate.ts'))
      .toContain('serverTimeZone: (): string => resolveServerTimeZone(');
  });
});
