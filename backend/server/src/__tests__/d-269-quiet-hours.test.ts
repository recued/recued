/** D-269 step 3 — quiet hours: one window, per person, consulted by delivery.
 *
 *  🔑 THE PROPERTY THAT MAKES SUPPRESSION SAFE IS DEFERRAL, NOT HOLDING. Nothing
 *  here stores a pending notification. A suppressed task reminder is deferred
 *  because the LEDGER IS LEFT WHERE IT WAS, so the next sweep after the window
 *  sees the state still diverging and emits then — the anchor row is the queue.
 *  ⇒ These tests drive two sweeps, because one sweep cannot tell "suppressed"
 *  from "lost".
 *
 *  ⛔ AND THE TWO SUPPRESSIONS ARE DIFFERENT. `enabled: false` means "not this
 *  kind, ever" and ADVANCES the ledger, so re-enabling does not replay a month.
 *  Quiet hours means "not now" and must not. A test that only checked "no emit"
 *  would pass on either and is the reason both are driven. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  canArmQuietHours,
  defaultQuietHoursPolicy,
  isMinuteWithinWindow,
  isWithinQuietHours,
  localMinuteOfDay,
  RECUED_BUILTIN_SOURCE_ID,
  shouldSuppressForQuietHours,
  WORK_ENTITY_DUE_SOON_WINDOW_MS,
  type QuietHoursPolicy,
} from '@recued/contracts';
import { createQuietHoursStore } from '../storage/quiet-hours-store.js';
import { createNotificationKindPolicyStore } from '../storage/notification-kind-policy-store.js';
import {
  createTaskEmissionLedger,
  runDueStatusSweep,
} from '../work-entity-due-status-sweep.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';

const HK = 'Asia/Hong_Kong';
/** 02:00 Hong Kong (on the 16th) — inside a 22:00→07:00 window. */
const NIGHT = Date.parse('2026-06-15T18:00:00Z');
/** 10:00 Hong Kong, the SAME MORNING the window ends — and therefore AFTER
 *  `NIGHT` in absolute time. ⚠ The first draft used 02:00 UTC on the 15th,
 *  which reads like "the day" but lands eight hours BEFORE the night instant;
 *  the deferral tests then swept backwards through time and saw `due_soon`
 *  where they expected `overdue`. A zone-named constant still has to be checked
 *  as an INSTANT. */
const DAY = Date.parse('2026-06-16T02:00:00Z');

const window_ = (over: Partial<QuietHoursPolicy> = {}): QuietHoursPolicy => ({
  ...defaultQuietHoursPolicy(), enabled: true, ...over,
});

describe('D-269 step 3 — the window itself', () => {
  it('⛔⛔ CROSS-MIDNIGHT IS THE NORMAL CASE, not an edge', () => {
    // 22:00 → 07:00 has from > to, and the naive `from <= m && m < to` is false
    // for EVERY minute of it. The window would silently never be active — the
    // worst possible failure for a feature whose only evidence is a
    // notification that did not arrive.
    const from = 22 * 60, to = 7 * 60;
    expect(isMinuteWithinWindow(23 * 60, from, to)).toBe(true);   // 23:00
    expect(isMinuteWithinWindow(2 * 60, from, to)).toBe(true);    // 02:00
    expect(isMinuteWithinWindow(6 * 60 + 59, from, to)).toBe(true);
    expect(isMinuteWithinWindow(7 * 60, from, to)).toBe(false);   // [from, to)
    expect(isMinuteWithinWindow(12 * 60, from, to)).toBe(false);
    expect(isMinuteWithinWindow(from, from, to)).toBe(true);
  });

  it('a same-day window still works, and the bounds stay half-open', () => {
    const from = 13 * 60, to = 14 * 60;
    expect(isMinuteWithinWindow(13 * 60, from, to)).toBe(true);
    expect(isMinuteWithinWindow(14 * 60, from, to)).toBe(false);
    expect(isMinuteWithinWindow(23 * 60, from, to)).toBe(false);
  });

  it('⛔ an EMPTY window silences nothing — the other reading would silence everything', () => {
    // `from === to` could mean "zero minutes" or "all day". Reading it as all
    // day lets one mis-set field silence the owner forever, and silence is
    // exactly what they cannot notice.
    expect(isMinuteWithinWindow(3 * 60, 60, 60)).toBe(false);
  });

  it('reads the LOCAL clock, so the same instant is night in one zone and day in another', () => {
    expect(localMinuteOfDay(NIGHT, HK)).toBe(2 * 60);
    expect(localMinuteOfDay(NIGHT, 'Europe/London')).toBe(19 * 60);
    expect(isWithinQuietHours(window_(), NIGHT, HK)).toBe(true);
    expect(isWithinQuietHours(window_(), NIGHT, 'Europe/London')).toBe(false);
  });

  it('⛔ DEFAULT OFF — an owner who never opens the setting keeps today\'s behaviour', () => {
    // A default-ON window withholds things nobody asked to have withheld, and
    // the evidence of the withholding is the notification that did not arrive.
    expect(defaultQuietHoursPolicy().enabled).toBe(false);
    expect(isWithinQuietHours(defaultQuietHoursPolicy(), NIGHT, HK)).toBe(false);
  });
});

describe('D-269 REV 15 — the window is a MASTER SILENCER, with no per-kind escape', () => {
  /** ⛔⛔ THIS REPLACES A SUITE THAT ASSERTED THE OPPOSITE. Until REV 15 each kind
   *  carried `respects_quiet_hours`, and the tests here pinned booking/calendar
   *  as exempt on the argument that "a slot starting inside the window is gone by
   *  morning". That argument is TRUE and it is about NOTIFICATION POLICY — what
   *  you want to be told about and how early — not about when you may be
   *  disturbed. Mixing them made one window mean four things, so neither panel
   *  could be read alone. The owner ruled them separate concerns. */
  it('⛔ suppression turns on the WINDOW and the class, and nothing else', () => {
    const args = { policy: window_(), instant: NIGHT, timeZone: HK };
    expect(shouldSuppressForQuietHours(args)).toBe(true);
    expect(shouldSuppressForQuietHours({ ...args, instant: DAY })).toBe(false);
  });

  it('⛔⛔ every kind is held — there is no argument left that exempts one', () => {
    // The signature is the assertion: a caller CANNOT pass a kind, so no code
    // path can quietly reintroduce a per-kind exemption without this failing to
    // compile. (`typecheck:tests` is what catches that, which is why the object
    // below is spelled out rather than spread from a helper.)
    expect(shouldSuppressForQuietHours({
      policy: window_(), instant: NIGHT, timeZone: HK,
    })).toBe(true);
  });

  it('⚠ applies_to still gates it — a window applying to nothing suppresses nothing', () => {
    // The CLASS axis survives (notification vs approval): that is "what kind of
    // interruption does the window cover", which is a property of the window
    // itself, not of any one reminder kind.
    expect(shouldSuppressForQuietHours({
      policy: window_({ applies_to: [] }), instant: NIGHT, timeZone: HK,
    })).toBe(false);
  });
});

describe('D-269 step 3 — arming is gated on a RESOLVABLE zone', () => {
  it('🔑 follows_host arms with nothing typed — the gate is resolvable, not declared', () => {
    // Requiring a typed zone would block the one deployment that never needs
    // one: a laptop, where the host clock IS the owner's clock.
    expect(canArmQuietHours({ mode: 'follows_host', zone: null, updated_at: 1 })).toBe(true);
    expect(canArmQuietHours({ mode: 'fixed', zone: HK, updated_at: 1 })).toBe(true);
    expect(canArmQuietHours({ mode: 'fixed', zone: null, updated_at: 1 })).toBe(false);
    expect(canArmQuietHours(null)).toBe(false);
  });
});

describe('D-269 step 3 — the store', () => {
  it('⛔ drops an applies_to value this build cannot ENFORCE, and KEEPS the ones it can', () => {
    // ⚠ This asserted that `'approval'` was dropped until step 5 shipped it —
    // correct then, wrong now. The RULE is what survives: a build that carried a
    // target it cannot apply would report a policy it does not enforce, which is
    // worse than not having it because the owner would believe approvals are
    // held. So the assertion names the rule and uses a value that will never be
    // real, rather than one the roadmap was about to make real.
    const db = new Database(':memory:');
    const store = createQuietHoursStore(db);
    store.write({ enabled: true }, 10);
    db.prepare(`UPDATE quiet_hours SET applies_to = ?`)
      .run('["notification","approval","telepathy"]');
    expect(store.read().applies_to).toEqual(['notification', 'approval']);
  });

  it('round-trips and stays one row', () => {
    const store = createQuietHoursStore(new Database(':memory:'));
    store.write({ enabled: true, from_minute: 60, to_minute: 120 }, 10);
    expect(store.read()).toEqual({
      enabled: true, from_minute: 60, to_minute: 120,
      applies_to: ['notification'], updated_at: 10,
    });
  });
});

describe('D-269 step 3 — ⛔⛔ the sweep DEFERS, it does not drop', () => {
  const build = () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureWorkEntitySchema(db);
    const store = createWorkEntityStore(db);
    for (const kind of ['task', 'commitment'] as const) {
      store.registerSource({
        id: RECUED_BUILTIN_SOURCE_ID(kind),
        top_tier_kind: kind,
        source_kind: 'builtin',
        source_label: `Recued ${kind}`,
        write_capable: true,
        registered_at: NIGHT,
      });
    }
    store.writeTask({
      id: 't-1',
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'ship it',
      done: false,
      due_at: NIGHT - 1,
    }, NIGHT - 20_000);
    return store;
  };

  const sweepArgs = (store: ReturnType<typeof createWorkEntityStore>, emitted: string[]) => ({
    store,
    bus: { emit: (e: { event_kind: string }) => { emitted.push(e.event_kind); } } as never,
    policy: () => ({
      enabled: true,
      offset_ms: WORK_ENTITY_DUE_SOON_WINDOW_MS,
    }),
  });

  it('🔑 a reminder suppressed at 02:00 ARRIVES after the window — nothing is stored to make that happen', () => {
    const store = build();
    const emitted: string[] = [];
    const ledger = createTaskEmissionLedger();

    // Inside the window: silent, and the ledger is deliberately NOT advanced.
    runDueStatusSweep({
      ...sweepArgs(store, emitted),
      taskEmissionLedger: ledger,
      isQuiet: () => true,
      now: () => NIGHT,
    });
    expect(emitted).toEqual([]);
    expect(ledger.get('t-1')).toBeUndefined();

    // After it: the state still diverges, so the sweep emits. The anchor row
    // was the queue; no pending notification was ever stored.
    runDueStatusSweep({
      ...sweepArgs(store, emitted),
      taskEmissionLedger: ledger,
      isQuiet: () => false,
      now: () => DAY,
    });
    expect(emitted).toEqual(['overdue']);
  });

  it('⛔ and it does NOT re-emit forever once delivered', () => {
    const store = build();
    const emitted: string[] = [];
    const ledger = createTaskEmissionLedger();
    for (const _ of [1, 2, 3]) {
      runDueStatusSweep({
        ...sweepArgs(store, emitted), taskEmissionLedger: ledger,
        isQuiet: () => false, now: () => DAY,
      });
    }
    expect(emitted).toEqual(['overdue']);
  });

  it('⛔⛔ DISABLED is NOT deferred — it advances the ledger, so re-enabling replays nothing', () => {
    // The distinction a "was anything emitted?" assertion cannot see. "Not this
    // kind, ever" and "not now" must not share a mechanism, or turning a kind
    // back on delivers every crossing from the off period at once.
    const store = build();
    const emitted: string[] = [];
    const ledger = createTaskEmissionLedger();

    runDueStatusSweep({
      store,
      bus: { emit: (e: { event_kind: string }) => { emitted.push(e.event_kind); } } as never,
      policy: () => ({ enabled: false, offset_ms: WORK_ENTITY_DUE_SOON_WINDOW_MS }),
      taskEmissionLedger: ledger,
      isQuiet: () => false,
      now: () => DAY,
    });
    expect(emitted).toEqual([]);
    expect(ledger.get('t-1')).toBe('overdue');   // ⚠ advanced

    runDueStatusSweep({
      ...sweepArgs(store, emitted), taskEmissionLedger: ledger,
      isQuiet: () => false, now: () => DAY,
    });
    expect(emitted).toEqual([]);                  // nothing replayed
  });

  it('an EXEMPT kind is not suppressed even at 02:00', () => {
    const store = build();
    const emitted: string[] = [];
    runDueStatusSweep({
      ...sweepArgs(store, emitted),
      taskEmissionLedger: createTaskEmissionLedger(),
      // `isQuiet` already folds in the kind's stance — an exempt kind answers
      // false, which is what `shouldSuppressForQuietHours` returns for it.
      isQuiet: () => false,
      now: () => NIGHT,
    });
    expect(emitted).toEqual(['overdue']);
  });
});

describe('D-269 step 3 — the window is SUPPLIED, not merely accepted', () => {
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

  it('⛔ the isQuiet FORWARD survives; the wiring itself is driven', () => {
    // Same split as the reminder sweep's forward above. Making `isQuiet` never
    // suppress left this test green when it grepped the composer; the drive in
    // `d-269-reminder-composition-drive.test.ts` reds on it.
    expect(read('backend/server/src/serve/start-schedulers.ts'))
      .toContain('quietHoursStore');
  });

  // ⛔ A sibling assertion here checked that the kind store supplied a per-kind
  // STANCE toward the window. REV 15 retired the stance: the window is a master
  // silencer and takes no kind, so there is nothing left for the store to supply
  // to it. Removed rather than rewritten — a test for a concept that no longer
  // exists is worse than none, because it reads as coverage.
});
