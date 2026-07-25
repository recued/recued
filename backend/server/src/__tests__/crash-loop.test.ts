import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createCrashLoopDetector,
  createCrashLoopPersistence,
  DEFAULT_CRASH_LOOP_CONFIG,
  type CrashLoopDetector,
  type CrashLoopPersistence,
} from '../lifecycle/crash-loop.js';
import {
  createLifecycleStateStore,
  type LifecycleStateStore,
} from '../lifecycle/lifecycle-state.js';

interface Harness {
  db: Database.Database;
  store: LifecycleStateStore;
  persistence: CrashLoopPersistence;
  detector: CrashLoopDetector;
  releasedCrashHalt: boolean;
  detectionFired: {
    restart_count: number;
    last_crash: import('@recued/contracts').LifecycleLastCrash | null;
  } | null;
  setNow: (ts: number) => void;
}

const newHarness = (opts: {
  window_s?: number;
  threshold?: number;
  auto_reset_after_s?: number;
  nowStart?: number;
} = {}): Harness => {
  const db = new Database(':memory:');
  const store = createLifecycleStateStore(db);
  const persistence = createCrashLoopPersistence(db);
  let nowValue = opts.nowStart ?? 1_700_000_000_000;
  const harness: Harness = {
    db, store, persistence,
    releasedCrashHalt: false,
    detectionFired: null,
    setNow: (ts: number) => { nowValue = ts; },
    detector: undefined as never,
  };
  harness.detector = createCrashLoopDetector({
    store,
    persistence,
    onDetected: (info) => { harness.detectionFired = info; },
    releaseCrashHalt: () => { harness.releasedCrashHalt = true; },
    now: () => nowValue,
    config: {
      window_s: opts.window_s ?? 60,
      threshold: opts.threshold ?? 5,
      auto_reset_after_s: opts.auto_reset_after_s ?? 3600,
    },
  });
  return harness;
};

describe('CrashLoopDetector.reconcileBoot — clean previous exit', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.db.close(); });

  it('does not increment on clean previous exit', () => {
    h.store.markCleanShutdown(1_699_999_999_000);
    const r = h.detector.reconcileBoot();
    expect(r.was_unclean).toBe(false);
    expect(r.restart_count).toBe(0);
    expect(r.detected).toBe(false);
  });

  it('clears shutdown_at on clean boot (so next unclean exit starts fresh)', () => {
    h.store.markCleanShutdown(1_699_999_999_000);
    h.detector.reconcileBoot();
    expect(h.store.getShutdownAt()).toBeNull();
  });
});

describe('CrashLoopDetector.reconcileBoot — unclean previous exit', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness({ window_s: 60, threshold: 3 }); });
  afterEach(() => { h.db.close(); });

  it('increments restart_count on first unclean boot', () => {
    const r = h.detector.reconcileBoot();
    expect(r.was_unclean).toBe(true);
    expect(r.restart_count).toBe(1);
    expect(r.detected).toBe(false);
  });

  it('does not detect until threshold is met AND last_crash is within window', () => {
    // Simulate two prior crashes but no last_crash stored → no window
    h.store.setLastCrash({ at: 1_700_000_000_000 - 30_000, reason: 'x', exit_code: 1 });
    h.detector.reconcileBoot();   // count=1
    h.detector.reconcileBoot();   // count=2
    const r = h.detector.reconcileBoot();
    expect(r.restart_count).toBe(3);
    expect(r.detected).toBe(true);
    expect(h.detectionFired?.restart_count).toBe(3);
    expect(h.persistence.isCrashLoopActive()).toBe(true);
  });

  it('does not detect when last_crash is outside the window', () => {
    // last_crash is 5 minutes ago — outside the 60s window.
    h.store.setLastCrash({ at: 1_700_000_000_000 - 300_000, reason: 'x', exit_code: 1 });
    h.detector.reconcileBoot();
    h.detector.reconcileBoot();
    h.detector.reconcileBoot();
    h.detector.reconcileBoot();
    const r = h.detector.reconcileBoot();
    expect(r.restart_count).toBe(5);
    expect(r.detected).toBe(false); // outside window
    expect(h.detectionFired).toBeNull();
  });
});

describe('CrashLoopDetector.autoResetIfStable', () => {
  let h: Harness;
  beforeEach(() => {
    h = newHarness({ auto_reset_after_s: 3600, nowStart: 1_700_000_000_000 });
  });
  afterEach(() => { h.db.close(); });

  it('returns false when nothing is set (no-op)', () => {
    h.store.setBootAt(1_700_000_000_000);
    h.setNow(1_700_000_000_000 + 3_700_000);  // 1h uptime
    expect(h.detector.autoResetIfStable()).toBe(false);
  });

  it('returns false when uptime is below threshold', () => {
    h.store.setBootAt(1_700_000_000_000);
    h.store.incrementRestartCount();
    h.setNow(1_700_000_000_000 + 60_000);  // 1min uptime
    expect(h.detector.autoResetIfStable()).toBe(false);
    expect(h.store.getRestartCount()).toBe(1);
  });

  it('clears restart_count + last_crash when uptime exceeds threshold', () => {
    h.store.setBootAt(1_700_000_000_000);
    h.store.incrementRestartCount();
    h.store.incrementRestartCount();
    h.store.setLastCrash({ at: 1_699_999_999_000, reason: 'x', exit_code: 1 });
    h.setNow(1_700_000_000_000 + 3_700_000); // 61 minutes uptime
    expect(h.detector.autoResetIfStable()).toBe(true);
    expect(h.store.getRestartCount()).toBe(0);
    expect(h.store.getLastCrash()).toBeNull();
  });

  it('does not touch crash_loop_active or kill switch (those use reset)', () => {
    h.store.setBootAt(1_700_000_000_000);
    h.store.incrementRestartCount();
    h.persistence.setCrashLoopActive(true);
    h.setNow(1_700_000_000_000 + 3_700_000);
    h.detector.autoResetIfStable();
    expect(h.persistence.isCrashLoopActive()).toBe(true);
    expect(h.releasedCrashHalt).toBe(false);
  });
});

describe('CrashLoopDetector.reset', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.db.close(); });

  it('returns cleared=false for everything when nothing was set', () => {
    const r = h.detector.reset();
    expect(r).toEqual({
      restart_count_cleared: false,
      last_crash_cleared: false,
      crash_halt_released: false,
    });
  });

  it('clears restart_count + last_crash when present', () => {
    h.store.incrementRestartCount();
    h.store.incrementRestartCount();
    h.store.setLastCrash({ at: 1, reason: 'x', exit_code: 1 });
    const r = h.detector.reset();
    expect(r.restart_count_cleared).toBe(true);
    expect(r.last_crash_cleared).toBe(true);
    expect(h.store.getRestartCount()).toBe(0);
    expect(h.store.getLastCrash()).toBeNull();
  });

  it('releases kill switch ONLY when detector engaged it', () => {
    // Kill switch was NOT engaged by us.
    h.store.incrementRestartCount();
    let r = h.detector.reset();
    expect(r.crash_halt_released).toBe(false);
    expect(h.releasedCrashHalt).toBe(false);

    // Now simulate detection engaged the kill switch.
    h.persistence.setCrashLoopActive(true);
    r = h.detector.reset();
    expect(r.crash_halt_released).toBe(true);
    expect(h.releasedCrashHalt).toBe(true);
    expect(h.persistence.isCrashLoopActive()).toBe(false);
  });

  it('is idempotent — second call is a no-op', () => {
    h.store.incrementRestartCount();
    h.persistence.setCrashLoopActive(true);
    h.detector.reset();
    const r2 = h.detector.reset();
    expect(r2).toEqual({
      restart_count_cleared: false,
      last_crash_cleared: false,
      crash_halt_released: false,
    });
  });
});

describe('DEFAULT_CRASH_LOOP_CONFIG', () => {
  it('matches the values documented in the spec', () => {
    expect(DEFAULT_CRASH_LOOP_CONFIG).toEqual({
      window_s: 60,
      threshold: 5,
      auto_reset_after_s: 3600,
    });
  });
});
