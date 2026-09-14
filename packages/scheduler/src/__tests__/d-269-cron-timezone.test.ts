/** D-269 — a cron expression is read in a ZONE, and until now that zone was
 *  whatever the process happened to be running in.
 *
 *  ⛔⛔ THE DEFECT. `cronMatchesAt` read `Date#getHours()` and friends, which are
 *  the HOST's local getters. So `0 9 * * *` meant "9am wherever this machine
 *  is" — and a Hong Kong owner on a Virginia VPS scheduling a 07:00 morning
 *  brief got it at 19:00 their time, silently, forever.
 *
 *  🔑 WORSE THAN THE CHAT-CLOCK DEFECT D-269 STEP 1 FIXED, AND THE DIFFERENCE IS
 *  THE POINT: a wrong `current_date` renders a wrong string; a wrong cron RUNS
 *  THE WORK AT THE WRONG HOUR. And unlike chat, no client can supply the zone
 *  per call — a cron fires with nobody connected, by definition. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cronMatchesAt, nextCronMatch } from '../cron-interval.js';

const NINE_AM = '0 9 * * *'.split(' ');
const FROM = Date.parse('2026-06-15T00:00:00Z');

describe('D-269 — the zone decides, and the HOST no longer does', () => {
  it('⛔ the same expression resolves to a DIFFERENT instant per zone', () => {
    // The whole bug, stated as the fix: these are the three answers the host
    // TZ used to pick between without asking.
    const at = (tz: string): string =>
      new Date(nextCronMatch(NINE_AM, FROM, 527_040, tz)!).toISOString();
    expect(at('UTC')).toBe('2026-06-15T09:00:00.000Z');
    expect(at('Asia/Hong_Kong')).toBe('2026-06-15T01:00:00.000Z');
    expect(at('America/Los_Angeles')).toBe('2026-06-15T16:00:00.000Z');
  });

  it('🔑 and the answer no longer depends on the machine it runs on', () => {
    // The property that actually matters: given a zone, the result is the same
    // everywhere. A test that only checked "HK gives 01:00Z" would pass on a
    // machine whose TZ happened to be HK.
    const hk = nextCronMatch(NINE_AM, FROM, 527_040, 'Asia/Hong_Kong');
    const hostLocal = nextCronMatch(NINE_AM, FROM);
    expect(new Date(hk!).toISOString()).toBe('2026-06-15T01:00:00.000Z');
    // ⚠ Only assert they DIFFER when the runner is not itself in HK — otherwise
    // the assertion is about the runner, not the code.
    const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (runnerZone !== 'Asia/Hong_Kong') expect(hostLocal).not.toBe(hk);
  });

  it('⚠ an absent zone still means host-local — every existing caller keeps its meaning', () => {
    const withNothing = nextCronMatch(NINE_AM, FROM);
    const runnerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(withNothing).toBe(nextCronMatch(NINE_AM, FROM, 527_040, runnerZone));
  });

  it('cronMatchesAt honours the zone too', () => {
    const nineHk = new Date('2026-06-15T01:00:00.000Z');
    expect(cronMatchesAt(NINE_AM, nineHk, 'Asia/Hong_Kong')).toBe(true);
    expect(cronMatchesAt(NINE_AM, nineHk, 'UTC')).toBe(false);
  });
});

describe('D-269 — DST, which is where a zone-aware cron earns its keep', () => {
  it('🔑 a daily 09:00 stays 09:00 LOCAL across a transition — the offset moves, not the hour', () => {
    // Los Angeles is UTC-8 in winter and UTC-7 in summer. A host-local cron on
    // a UTC server would fire the same INSTANT year-round and drift an hour
    // away from the owner's morning.
    const winter = nextCronMatch(NINE_AM, Date.parse('2026-01-15T00:00:00Z'), 527_040, 'America/Los_Angeles');
    const summer = nextCronMatch(NINE_AM, Date.parse('2026-07-15T00:00:00Z'), 527_040, 'America/Los_Angeles');
    expect(new Date(winter!).toISOString()).toBe('2026-01-15T17:00:00.000Z'); // 09:00 PST
    expect(new Date(summer!).toISOString()).toBe('2026-07-15T16:00:00.000Z'); // 09:00 PDT
  });

  it('⛔ an hour inside the spring-forward GAP never matches that day — it does not exist', () => {
    // 02:30 does not happen on 2026-03-08 in Los Angeles. Standard cron
    // behaviour is to skip it, and the scan does so by construction: no instant
    // reads as 02:30 local.
    const at230 = '30 2 * * *'.split(' ');
    const next = nextCronMatch(at230, Date.parse('2026-03-08T00:00:00Z'), 527_040, 'America/Los_Angeles');
    // The next match is the FOLLOWING day, not the gap.
    expect(new Date(next!).toISOString()).toBe('2026-03-09T09:30:00.000Z');
  });
});

describe('D-269 — the scan stays cheap', () => {
  it('⚠ a 366-day worst-case scan does not make half a million Intl calls', () => {
    // `zoneOffsetMsAt` formats through `Intl`; one per minute over the maximum
    // scan is ~527k calls and turns a schedule save into a visible stall. The
    // offset is cached per day, which is exact because a DST transition happens
    // at most once in a day.
    // ⚠ Feb-29 FROM 2026-03-01 is 730 days out — past the 366-day cap, so the
    // honest answer there is `null`, and my first draft asserted otherwise.
    // Seeded from 2027-06-01 the next Feb 29 is ~273 days ahead: a genuinely
    // long scan (~393k iterations) that also finds something.
    const t0 = Date.now();
    const at = nextCronMatch('0 0 29 2 *'.split(' '), Date.parse('2027-06-01T00:00:00Z'), 527_040, 'America/Los_Angeles');
    const elapsed = Date.now() - t0;
    expect(new Date(at!).toISOString()).toBe('2028-02-29T08:00:00.000Z'); // 00:00 PST
    expect(elapsed).toBeLessThan(3_000);
  });
});

describe('D-269 — the zone is SUPPLIED to the firing path, not merely accepted', () => {
  const read = (p: string): string =>
    readFileSync(join(process.cwd(), p), 'utf8');

  it('⛔ the runtime loop resolves a zone and passes it to nextCronMatch', () => {
    // `timeZone` is optional and defaults to host-local, so a missing supplier
    // is INVISIBLE: every cron keeps firing, just at the wrong hour. Same shape
    // as D-139's dead `prefsTimezone` reader.
    const src = read('backend/server/src/scheduler.ts');
    expect(src).toContain('cronZoneFor');
    expect(src).toContain('nextCronMatch(parts, fromMs + 60_000, undefined, zone)');
    expect(src).toContain('serverTimeZone');
  });

  it('⛔ and the composition root supplies it off the declared-zone store', () => {
    expect(read('backend/server/src/serve/start-post-listener-runtime.ts'))
      .toContain('serverTimeZone: (): string => resolveServerTimeZone(');
    expect(read('backend/server/src/composition/data/scheduler/cron/boot.ts'))
      .toContain('serverTimeZone: ctx.serverTimeZone');
  });

  it('⛔⛔ the one-shot cron derivation moved in LOCKSTEP with the matcher', () => {
    // A one-shot's `run_at` is absolute, but it is ALSO stored as a cron
    // expression derived from that instant's wall clock. Derive host-local
    // while the matcher reads a declared zone and the schedule fires at the
    // wrong hour despite `run_at` being exactly right.
    const src = read('backend/server/src/schedule-handler.ts');
    expect(src).toContain('const oneShotCronExpression = (runAt: number, timeZone?: string)');
    expect(src).toContain('zoneOffsetMsAt(runAt, timeZone)');
  });

  it('⚠ an empty zone never reaches Intl — it would throw, not fall back', () => {
    // `cronZoneFor(row, '')` yields `''`, and `Intl.DateTimeFormat({timeZone:''})`
    // throws a RangeError. Both resolvers guard for it rather than letting a
    // tick die where host-local was the intended fallback.
    expect(read('backend/server/src/scheduler.ts'))
      .toContain("resolved.length > 0 ? resolved : undefined");
    expect(read('backend/server/src/schedule-handler.ts'))
      .toContain('const resolveScheduleZone =');
  });
});
