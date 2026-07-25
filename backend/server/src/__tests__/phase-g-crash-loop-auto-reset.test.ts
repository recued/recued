/** Phase G (D-109) — crash-loop auto-reset periodic tick.
 *
 *  The detector already exposes `autoResetIfStable()`; Phase G wires
 *  it to a periodic interval inside `createLifecycle`. These tests
 *  exercise the interval contract (start / stop / cadence) using fake
 *  timers to avoid flaky real-clock assertions. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCrashLoopDetector,
  createCrashLoopPersistence,
  type CrashLoopDetector,
} from '../lifecycle/crash-loop.js';
import { createLifecycleStateStore } from '../lifecycle/lifecycle-state.js';

describe('crash-loop auto-reset tick', () => {
  let db: Database.Database;
  let nowRef: { value: number };

  beforeEach(() => {
    db = new Database(':memory:');
    nowRef = { value: 0 };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const buildDetector = (opts: { auto_reset_after_s: number }): CrashLoopDetector => {
    const store = createLifecycleStateStore(db);
    const persistence = createCrashLoopPersistence(db);
    return createCrashLoopDetector({
      store,
      persistence,
      now: () => nowRef.value,
      config: {
        auto_reset_after_s: opts.auto_reset_after_s,
      },
    });
  };

  it('autoResetIfStable fires once uptime crosses the threshold', () => {
    const detector = buildDetector({ auto_reset_after_s: 100 });
    const store = createLifecycleStateStore(db);
    // Set boot-at such that uptime starts at 50s (below threshold).
    nowRef.value = 50_000;
    store.setBootAt(0);
    store.setLastCrash({ at: 0, reason: 'boom', exit_code: 1 });

    expect(detector.autoResetIfStable()).toBe(false);

    // Bump clock past the threshold; counters should clear.
    nowRef.value = 200_000;
    expect(detector.autoResetIfStable()).toBe(true);
    expect(store.getLastCrash()).toBeNull();
    // A second call is idempotent (nothing to reset).
    expect(detector.autoResetIfStable()).toBe(false);
  });

  it('no-op when nothing is set', () => {
    const detector = buildDetector({ auto_reset_after_s: 10 });
    const store = createLifecycleStateStore(db);
    store.setBootAt(0);
    nowRef.value = 1_000_000;
    expect(detector.autoResetIfStable()).toBe(false);
    expect(store.getLastCrash()).toBeNull();
  });

  it('holds off while uptime is below the window', () => {
    const detector = buildDetector({ auto_reset_after_s: 3_600 });
    const store = createLifecycleStateStore(db);
    store.setBootAt(0);
    store.setLastCrash({ at: 0, reason: 'still sweating', exit_code: 1 });
    nowRef.value = 60 * 1000; // 1min uptime, threshold is 1h
    expect(detector.autoResetIfStable()).toBe(false);
    expect(store.getLastCrash()?.reason).toBe('still sweating');
  });

  it('tolerates a missing boot_at', () => {
    const detector = buildDetector({ auto_reset_after_s: 10 });
    const store = createLifecycleStateStore(db);
    // boot_at not set
    store.setLastCrash({ at: 0, reason: 'no boot', exit_code: 1 });
    nowRef.value = 1_000_000;
    expect(detector.autoResetIfStable()).toBe(false);
    expect(store.getLastCrash()).not.toBeNull();
  });

  it('resets restart_count alongside last_crash', () => {
    const detector = buildDetector({ auto_reset_after_s: 10 });
    const store = createLifecycleStateStore(db);
    store.setBootAt(0);
    store.incrementRestartCount();
    store.incrementRestartCount();
    store.setLastCrash({ at: 0, reason: 'x', exit_code: 1 });
    nowRef.value = 100_000;
    expect(detector.autoResetIfStable()).toBe(true);
    expect(store.getRestartCount()).toBe(0);
  });
});
