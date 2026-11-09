// D-181 Slice 3 — the stateful stall monitor + the file-growth source.
//
// Drives the monitor with an injected clock + a manual timer scheduler so the
// poll loop is deterministic (no real wall-clock). Verifies the §6 AC end to
// end at the monitor level: a hung file-growth op is killed after k·T, a
// slow-but-growing op is spared, and a silent op is bounded only by the cap.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STALL_FACTOR_K,
  DEFAULT_EXPECTED_INTERVAL_MS,
  SILENT_OP_HARD_CAP_MS,
  type StallDecision,
} from '@recued/contracts';
import {
  StallMonitor,
  createFileGrowthSource,
  type ProgressSource,
} from '../execution/stall-monitor.js';

/** A controllable clock + single-slot timer (the monitor schedules one timer
 *  at a time via recursive `setTimer`). `tick(ms)` advances the clock and fires
 *  the pending timer if its deadline elapsed. */
const makeHarness = () => {
  let now = 0;
  let pending: { fn: () => void; at: number } | null = null;
  const setTimer = (fn: () => void, ms: number): unknown => {
    pending = { fn, at: now + ms };
    return pending;
  };
  const clearTimer = (h: unknown): void => {
    if (pending === h) pending = null;
  };
  /** Advance the clock by `ms` and fire the pending timer if due. */
  const advance = (ms: number): void => {
    now += ms;
    if (pending && pending.at <= now) {
      const due = pending;
      pending = null;
      due.fn();
    }
  };
  return {
    now: () => now,
    setTimer,
    clearTimer,
    advance,
    hasPending: () => pending !== null,
  };
};

describe('StallMonitor — heartbeat (unattended)', () => {
  it('kills after k·T of silence', () => {
    const h = makeHarness();
    const t = 1_000;
    const monitor = new StallMonitor({
      contract: 'heartbeat',
      origin: 'unattended',
      expectedIntervalMs: t,
      pollMs: t,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const stalls: StallDecision[] = [];
    monitor.start((d) => stalls.push(d));
    // Poll every T; no signal ever → stalled at idle ≥ k·T.
    for (let i = 0; i < STALL_FACTOR_K + 1; i += 1) h.advance(t);
    expect(stalls).toHaveLength(1);
    expect(stalls[0].reason).toBe('no_progress');
    expect(h.hasPending()).toBe(false); // monitor stopped itself
  });

  it('is spared while it keeps signalling', () => {
    const h = makeHarness();
    const t = 1_000;
    const monitor = new StallMonitor({
      contract: 'heartbeat',
      origin: 'unattended',
      expectedIntervalMs: t,
      pollMs: t,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const stalls: StallDecision[] = [];
    monitor.start((d) => stalls.push(d));
    // Signal on every tick → never idle past k·T.
    for (let i = 0; i < 4 * STALL_FACTOR_K; i += 1) {
      h.advance(t);
      monitor.signal();
    }
    expect(stalls).toHaveLength(0);
    expect(monitor.signalCount).toBe(4 * STALL_FACTOR_K);
  });

  it('reports only signal timestamps to a best-effort observer', () => {
    const h = makeHarness();
    const observed: number[] = [];
    const monitor = new StallMonitor({
      contract: 'heartbeat',
      origin: 'unattended',
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      onSignal: (at) => observed.push(at),
    });
    h.advance(25);
    monitor.signal();
    expect(observed).toEqual([25]);

    const resilient = new StallMonitor({
      contract: 'heartbeat',
      origin: 'unattended',
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      onSignal: () => { throw new Error('observer failed'); },
    });
    expect(() => resilient.signal()).not.toThrow();
    expect(resilient.signalCount).toBe(1);
  });
});

describe('StallMonitor — attended flags but does not kill on no-progress', () => {
  it('fires onFlag (once) without onStall', () => {
    const h = makeHarness();
    const t = 1_000;
    const monitor = new StallMonitor({
      contract: 'heartbeat',
      origin: 'attended',
      expectedIntervalMs: t,
      pollMs: t,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const stalls: StallDecision[] = [];
    const flags: StallDecision[] = [];
    monitor.start((d) => stalls.push(d), (d) => flags.push(d));
    for (let i = 0; i < 3 * STALL_FACTOR_K; i += 1) h.advance(t);
    expect(stalls).toHaveLength(0); // attended → no auto-kill on no-progress
    expect(flags).toHaveLength(1); // flagged exactly once
    expect(flags[0].reason).toBe('no_progress');
    expect(h.hasPending()).toBe(true); // still running (the human governs)
    monitor.stop();
  });
});

describe('StallMonitor — silent contract', () => {
  it('is bounded only by the generous hard cap', () => {
    const h = makeHarness();
    const poll = 1_000;
    const cap = 10_000;
    const monitor = new StallMonitor({
      contract: 'silent',
      origin: 'unattended',
      silentHardCapMs: cap,
      pollMs: poll,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const stalls: StallDecision[] = [];
    monitor.start((d) => stalls.push(d));
    h.advance(cap - poll); // just under the cap
    expect(stalls).toHaveLength(0);
    h.advance(poll); // reaches the cap
    expect(stalls).toHaveLength(1);
    expect(stalls[0].reason).toBe('silent_cap');
  });
});

describe('StallMonitor — file-growth source', () => {
  it('kills a hung op whose output file stops growing', () => {
    const h = makeHarness();
    const t = 1_000;
    let size = 0;
    const source: ProgressSource = createFileGrowthSource('/out.md', {
      statFn: () => ({ size, mtimeMs: 0 }),
    });
    const monitor = new StallMonitor({
      contract: 'file-growth',
      origin: 'unattended',
      source,
      expectedIntervalMs: t,
      pollMs: t,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const stalls: StallDecision[] = [];
    monitor.start((d) => stalls.push(d));
    // Grow for a while, then freeze.
    for (let i = 0; i < 3; i += 1) {
      size += 100;
      h.advance(t);
    }
    expect(stalls).toHaveLength(0); // growing → spared
    // Freeze: no more growth for k·T.
    for (let i = 0; i < STALL_FACTOR_K + 1; i += 1) h.advance(t);
    expect(stalls).toHaveLength(1);
    expect(stalls[0].reason).toBe('no_progress');
  });
});

describe('createFileGrowthSource', () => {
  it('reports growth on size or mtime advance, primes a stale baseline', () => {
    let sample: { size: number; mtimeMs: number } | null = { size: 50, mtimeMs: 50 };
    const source = createFileGrowthSource('/x', { statFn: () => sample });
    // Primed at 50/50 — equal sample is NOT growth.
    expect(source.grewSince()).toBe(false);
    sample = { size: 60, mtimeMs: 50 }; // size up
    expect(source.grewSince()).toBe(true);
    sample = { size: 60, mtimeMs: 70 }; // mtime up
    expect(source.grewSince()).toBe(true);
    sample = { size: 60, mtimeMs: 70 }; // unchanged
    expect(source.grewSince()).toBe(false);
  });

  it('treats a missing file as no growth, counts first appearance as growth', () => {
    let sample: { size: number; mtimeMs: number } | null = null;
    const source = createFileGrowthSource('/x', { statFn: () => sample });
    expect(source.grewSince()).toBe(false); // absent
    sample = { size: 0, mtimeMs: 1 }; // appears (size 0 but mtime > -1)
    expect(source.grewSince()).toBe(true);
  });
});

describe('StallMonitor — stop() idempotent', () => {
  it('is safe to call repeatedly', () => {
    const h = makeHarness();
    const monitor = new StallMonitor({
      contract: 'silent',
      origin: 'unattended',
      pollMs: 1_000,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    monitor.start(() => {});
    monitor.stop();
    monitor.stop();
    expect(h.hasPending()).toBe(false);
  });
});

describe('D-274 — the flag latch is per EPISODE, not per monitor lifetime', () => {
  it('flags again after a stall, a recovery, and a SECOND stall', () => {
    // ⛔ The regression this pins: `flaggedFired` was set once per monitor, while
    // the registry's latch (`stalledRuns`) is CLEARED by the same progress
    // signal that ends the episode. After one stall + recovery the registry read
    // "not stalled" and the monitor could never say otherwise, so the second
    // stall was silent FOREVER. A long op that blips, resumes, then wedges for
    // real would spend its only flag on the blip.
    const h = makeHarness();
    let moving = true;
    const source: ProgressSource = { grewSince: () => moving };
    const monitor = new StallMonitor({
      contract: 'resource', origin: 'attended', source,
      expectedIntervalMs: 100, factorK: 2,
      silentHardCapMs: Number.POSITIVE_INFINITY, flagOnly: true,
      pollMs: 50, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer,
    });
    const flags: StallDecision[] = [];
    const kills: StallDecision[] = [];
    monitor.start((d) => kills.push(d), (d) => flags.push(d));
    const run = (ms: number): void => { for (let i = 0; i < ms / 50; i += 1) h.advance(50); };

    run(300);                      // moving
    moving = false; run(400);      // episode 1
    expect(flags).toHaveLength(1);
    moving = true;  run(300);      // recovered
    moving = false; run(600);      // episode 2
    expect(flags).toHaveLength(2);
    // report-only throughout: the op is never killed on either episode
    expect(kills).toHaveLength(0);
  });

  it('does not re-flag WITHIN one episode (bounded to one per episode)', () => {
    const h = makeHarness();
    const source: ProgressSource = { grewSince: () => false };
    const monitor = new StallMonitor({
      contract: 'resource', origin: 'attended', source,
      expectedIntervalMs: 100, factorK: 2,
      silentHardCapMs: Number.POSITIVE_INFINITY, flagOnly: true,
      pollMs: 50, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer,
    });
    const flags: StallDecision[] = [];
    monitor.start(() => {}, (d) => flags.push(d));
    for (let i = 0; i < 40; i += 1) h.advance(50);   // 2s of unbroken stillness
    expect(flags).toHaveLength(1);                    // not 1-per-poll
  });
});

/** ⛔ A closed lid is not a stall. No-progress time was measured on `Date.now`,
 *  which jumps by the time slept, so the first poll after waking killed an agent
 *  CLI "idle" for the whole sleep — 45 minutes for the coding agents, 90 seconds
 *  for yt-dlp. It is measured on a clock that stops while the machine sleeps. */
describe('StallMonitor — a machine that slept', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('⛔ a sleep longer than the window is not a stall; a window of AWAKE silence still is', () => {
    const h = makeHarness();
    let wall = Date.UTC(2026, 10, 6, 9, 0);
    const stalls: StallDecision[] = [];
    const monitor = new StallMonitor({
      contract: 'heartbeat', origin: 'unattended', expectedIntervalMs: 1_000, factorK: 1, pollMs: 100,
      killOnNoProgress: true, now: h.now, wallNow: () => wall, setTimer: h.setTimer, clearTimer: h.clearTimer,
    });
    monitor.start((d) => stalls.push(d));
    h.advance(100);
    wall += 2 * 60 * 60_000; // the lid is shut for two hours; the stopped clock does not move
    h.advance(100);          // the first poll after waking
    expect(stalls).toEqual([]);
    h.advance(1_000);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.reason).toBe('no_progress');
  });

  it('reports a progress signal at the wall-clock time the active list shows', () => {
    const h = makeHarness();
    const wall = Date.UTC(2026, 10, 6, 9, 0);
    const seen: number[] = [];
    const monitor = new StallMonitor({
      contract: 'heartbeat', origin: 'unattended', now: h.now, wallNow: () => wall,
      onSignal: (at) => seen.push(at), setTimer: h.setTimer, clearTimer: h.clearTimer,
    });
    h.advance(500);
    monitor.signal();
    expect(seen).toEqual([wall]);
  });

  it('⛔ by default the wall clock jumping does not move no-progress time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 6, 9, 0));
    const monitor = new StallMonitor({
      contract: 'heartbeat', origin: 'unattended', expectedIntervalMs: 1_000, factorK: 1, killOnNoProgress: true,
    });
    vi.setSystemTime(Date.UTC(2026, 10, 6, 11, 0));
    const decision = monitor.poll();
    expect(decision.stalled).toBe(false);
    expect(decision.idle_ms).toBeLessThan(1_000);
  });
});
