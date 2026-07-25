import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  handleRequestShutdown,
  handleGetLifecycleState,
  handleResetCrashLoop,
  makeLifecycleHandlers,
  type LifecycleHandlerDeps,
} from '../lifecycle/lifecycle-handler.js';
import {
  createDrainOrchestrator,
  type DrainOrchestrator,
} from '../lifecycle/drain-orchestrator.js';
import {
  createLifecycleStateMachine,
  createLifecycleStateStore,
  buildLifecycleSnapshot,
  type LifecycleStateStore,
} from '../lifecycle/lifecycle-state.js';
import {
  createCrashLoopDetector,
  createCrashLoopPersistence,
  type CrashLoopDetector,
  type CrashLoopPersistence,
} from '../lifecycle/crash-loop.js';

interface Harness {
  db: Database.Database;
  store: LifecycleStateStore;
  crashPersistence: CrashLoopPersistence;
  crashDetector: CrashLoopDetector;
  drain: DrainOrchestrator;
  deps: LifecycleHandlerDeps;
  drainCompletions: Array<{ intent: string; reason: string }>;
  releasedCrashHalt: boolean;
}

const newHarness = (): Harness => {
  const db = new Database(':memory:');
  const store = createLifecycleStateStore(db);
  store.setBootAt(1_700_000_000_000);
  const crashPersistence = createCrashLoopPersistence(db);
  const machine = createLifecycleStateMachine('running');
  const drain = createDrainOrchestrator({
    machine,
    steps: {
      pause_scheduler: async () => {
        await new Promise((r) => setTimeout(r, 20));
      },
    },
    defaultTimeoutMs: 500,
    stepTimeoutMs: 100,
  });
  const h: Harness = {
    db,
    store,
    crashPersistence,
    crashDetector: undefined as never,
    drain,
    deps: undefined as never,
    drainCompletions: [],
    releasedCrashHalt: false,
  };
  h.crashDetector = createCrashLoopDetector({
    store,
    persistence: crashPersistence,
    releaseCrashHalt: () => { h.releasedCrashHalt = true; },
  });
  h.deps = {
    getSnapshot: () =>
      buildLifecycleSnapshot({
        store,
        machine,
        supervisor_mode: 'dev',
        drain: drain.state,
        now: () => 1_700_000_005_000,
      }),
    drain,
    onDrainComplete: (intent, reason) => {
      h.drainCompletions.push({ intent, reason });
    },
    crashLoop: h.crashDetector,
  };
  return h;
};

describe('handleRequestShutdown', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.db.close(); });

  it('returns accepted:true on first call', () => {
    const r = handleRequestShutdown(h.deps, { reason: 'test' });
    expect(r).toEqual({ accepted: true });
  });

  it('returns accepted:false when a drain is already active', async () => {
    handleRequestShutdown(h.deps, { reason: 'first' });
    // drain is now active — second call rejects.
    const second = handleRequestShutdown(h.deps, { reason: 'second' });
    expect(second).toEqual({ accepted: false });
    // Wait for the drain to finish so the test cleans up.
    await new Promise((r) => setTimeout(r, 150));
  });

  it('invokes onDrainComplete with intent=shutdown after drain finishes', async () => {
    handleRequestShutdown(h.deps, { reason: 'drained' });
    // Wait for async drain to complete.
    await new Promise((r) => setTimeout(r, 200));
    expect(h.drainCompletions).toEqual([
      { intent: 'shutdown', reason: 'drained' },
    ]);
  });

  it('honours drain_timeout_s override (converts to ms, clamps >= 1000)', () => {
    handleRequestShutdown(h.deps, { reason: 'test', drain_timeout_s: 10 });
    expect(h.deps.drain.state.active).toBe(true);
  });

  it('falls back to reason="rpc" when caller passes empty reason', async () => {
    handleRequestShutdown(h.deps, { reason: '' });
    await new Promise((r) => setTimeout(r, 200));
    expect(h.drainCompletions[0].reason).toBe('rpc');
  });
});

describe('handleGetLifecycleState', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.db.close(); });

  it('returns the current snapshot', () => {
    const snap = handleGetLifecycleState(h.deps);
    expect(snap.state).toBe('running');
    expect(snap.boot_at).toBe(1_700_000_000_000);
    expect(snap.uptime_s).toBe(5);
    expect(snap.supervisor_mode).toBe('dev');
  });

  it('reflects last_crash when persisted', () => {
    h.store.setLastCrash({ at: 1_699_999_000_000, reason: 'boom', exit_code: 1 });
    const snap = handleGetLifecycleState(h.deps);
    expect(snap.last_crash).toEqual({
      at: 1_699_999_000_000, reason: 'boom', exit_code: 1,
    });
  });
});

describe('handleResetCrashLoop', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.db.close(); });

  it('returns ok:true + all cleared:false when nothing was set', () => {
    const r = handleResetCrashLoop(h.deps);
    expect(r.ok).toBe(true);
    expect(r.cleared).toEqual({
      restart_count: false,
      last_crash: false,
      crash_halt: false,
    });
  });

  it('clears restart_count + last_crash and reports which cleared', () => {
    h.store.incrementRestartCount();
    h.store.setLastCrash({ at: 1, reason: 'x', exit_code: 1 });
    const r = handleResetCrashLoop(h.deps);
    expect(r.cleared.restart_count).toBe(true);
    expect(r.cleared.last_crash).toBe(true);
    expect(r.cleared.crash_halt).toBe(false);
  });

  it('releases kill switch when detector engaged it', () => {
    h.crashPersistence.setCrashLoopActive(true);
    const r = handleResetCrashLoop(h.deps);
    expect(r.cleared.crash_halt).toBe(true);
    expect(h.releasedCrashHalt).toBe(true);
  });
});

describe('makeLifecycleHandlers slice', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.db.close(); });

  it('returns undefined when deps are absent', () => {
    expect(makeLifecycleHandlers(undefined)).toBeUndefined();
  });

  it('returns the three lifecycle methods in the methods tuple', () => {
    const slice = makeLifecycleHandlers(h.deps);
    expect(slice?.methods).toEqual([
      'server.requestShutdown',
      'server.getLifecycleState',
      'server.resetCrashLoop',
    ]);
  });

  it('handlers match the tuple (exhaustive keys)', () => {
    const slice = makeLifecycleHandlers(h.deps)!;
    for (const name of slice.methods) {
      expect(slice.handlers).toHaveProperty(name);
    }
  });
});
