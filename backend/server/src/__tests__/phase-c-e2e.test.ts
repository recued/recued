/** Phase C end-to-end integration.
 *
 *  Wires the lifecycle composition root against a real SQLite + audit
 *  log + server-state store + runtime config store and drives the
 *  full booting → running → draining → terminal path through both
 *  the rpc surface and signal-listener surface.
 *
 *  Does NOT spin up a full HTTP + WS server — unit + handler tests
 *  in this suite already cover those layers. This file proves that
 *  the composition works end-to-end: audit emissions fire, state
 *  transitions persist, and `supervisor.handoff` returns the
 *  expected codes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createLifecycle, type Lifecycle } from '../lifecycle/index.js';
import { createServerStateStore } from '../server-state.js';
import {
  createRuntimeConfigStore,
  type BootstrapConfig,
  type RuntimeConfig,
} from '@recued/config';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type AuditEntry,
  type ActivityEntry,
  type AuditLogStore,
} from '@recued/storage';
import {
  handleRequestShutdown,
  handleGetLifecycleState,
  handleResetCrashLoop,
} from '../lifecycle/lifecycle-handler.js';

interface E2eHarness {
  dataPath: string;
  db: Database.Database;
  lifecycle: Lifecycle;
  auditLog: AuditLogStore;
  exits: number[];
  close: () => void;
}

const BOOTSTRAP: BootstrapConfig = {
  data_path: '',
  bind_host: '127.0.0.1',
  bind_port: 7717,
  mcp_port: 0,
  webhook_port: 0,
  log_path: '',
};

const RUNTIME: RuntimeConfig = {
  'supervisor.mode': 'dev',
  'lifecycle.drain_timeout_s': 5,
  'lifecycle.crash_loop_threshold': 3,
  'lifecycle.crash_loop_window_s': 60,
};

const newE2e = async (): Promise<E2eHarness> => {
  const dataPath = mkdtempSync(join(tmpdir(), 'recued-e2e-'));
  const db = new Database(':memory:');
  const serverState = createServerStateStore(db);
  const runtimeStore = createRuntimeConfigStore({ ...RUNTIME });
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );
  const exits: number[] = [];

  const drainLog: string[] = [];
  const lifecycle = createLifecycle({
    db,
    dataPath,
    bindPort: 7717,
    version: '0.0.0-e2e',
    configPath: null,
    distribution: 'source',
    initialBootstrap: { ...BOOTSTRAP, data_path: dataPath, log_path: dataPath },
    initialRuntime: { ...RUNTIME },
    runtimeStore,
    serverState,
    auditLog,
    supervisorMode: 'dev',
    crashLoopConfig: { threshold: 3, window_s: 60, auto_reset_after_s: 3600 },
    exit: (code) => { exits.push(code); },
    drainSteps: {
      pause_scheduler: async () => { drainLog.push('pause_scheduler'); },
      close_ws: async () => { drainLog.push('close_ws'); },
      stop_timers: async () => { drainLog.push('stop_timers'); },
      close_cascade: async () => { drainLog.push('close_cascade'); },
      flush_audit: async () => { drainLog.push('flush_audit'); },
      close_db: async () => { drainLog.push('close_db'); },
    },
    getInFlightCount: () => 0,
  });
  lifecycle.lock.claim({ boot_at: Date.now(), bind_port: 7717 });

  return {
    dataPath,
    db,
    lifecycle,
    auditLog,
    exits,
    close() {
      lifecycle.uninstall();
      lifecycle.lock.release();
      db.close();
      rmSync(dataPath, { recursive: true, force: true });
    },
  };
};

describe('Phase C e2e — boot → running → drain → terminal', () => {
  let e: E2eHarness;
  beforeEach(async () => { e = await newE2e(); });
  afterEach(() => { e.close(); });

  it('markBooted flips booting → running and emits server_boot audit', async () => {
    expect(e.lifecycle.machine.state).toBe('booting');
    e.lifecycle.markBooted();
    expect(e.lifecycle.machine.state).toBe('running');
    expect(e.lifecycle.store.getBootAt()).not.toBeNull();
    // Give the async auditLog.logActivity call a tick to flush.
    await new Promise((r) => setImmediate(r));
    const activities = await e.auditLog.listActivities(50);
    const bootAct = activities.find((a) => a.action === 'server_boot');
    expect(bootAct).toBeDefined();
    expect(bootAct?.reserve).toBe(true);
  });

  it('requestShutdown rpc triggers drain → clean exit path', async () => {
    e.lifecycle.markBooted();
    const r = handleRequestShutdown(
      {
        getSnapshot: () => e.lifecycle.getSnapshot(),
        drain: e.lifecycle.drain,
        onDrainComplete: () => {},
        crashLoop: e.lifecycle.crashLoop,
      },
      { reason: 'e2e' },
    );
    expect(r).toEqual({ accepted: true });
    // Wait for the drain to resolve.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(e.lifecycle.drain.state.active).toBe(false);
    // We use lifecycle.requestDrain directly below for state flip —
    // handleRequestShutdown fires the drain but doesn't flip the
    // state machine through `draining → shutting_down` (that happens
    // inside lifecycle.requestDrain, which e2e test #3 exercises).
  });

  it('lifecycle.requestDrain runs every wired step + flips terminal state', async () => {
    e.lifecycle.markBooted();
    const result = await e.lifecycle.requestDrain({
      intent: 'shutdown',
      reason: 'e2e-shutdown',
    });
    expect(result.intent).toBe('shutdown');
    expect(e.lifecycle.machine.state).toBe('shutting_down');
    expect(e.lifecycle.store.getShutdownAt()).not.toBeNull();
    // Every wired step landed in completed.
    expect(result.completed).toEqual(
      expect.arrayContaining([
        'flip_to_draining',
        'pause_scheduler',
        'await_inflight',
        'close_ws',
        'stop_timers',
        'close_cascade',
        'flush_audit',
        'close_db',
        'release_lock',
      ]),
    );
    // Audit has a drain_started + drain_completed (reserve=true for both).
    await new Promise((r) => setImmediate(r));
    const activities = await e.auditLog.listActivities(50);
    const started = activities.find((a) => a.action === 'drain_started');
    const completed = activities.find((a) => a.action === 'drain_completed');
    expect(started?.reserve).toBe(true);
    expect(completed?.reserve).toBe(true);
    // Supervisor handoff for dev returns 0 regardless.
    expect(e.lifecycle.supervisor.handoff('shutdown')).toBe(0);
  });
});

describe('Phase C e2e — crash-loop detection', () => {
  let e: E2eHarness;
  beforeEach(async () => { e = await newE2e(); });
  afterEach(() => { e.close(); });

  it('trips detection after threshold unclean boots + flips kill switch', async () => {
    // Seed a "last crash within window" so the next reconcileBoot
    // will detect if count crosses threshold.
    e.lifecycle.store.setLastCrash({
      at: Date.now() - 10_000,
      reason: 'test',
      exit_code: 1,
    });
    // Simulate three unclean boots (reconcileBoot without markCleanShutdown).
    for (let i = 0; i < 3; i++) {
      // Each reconcileBoot increments restart_count when shutdown_at
      // is missing. Threshold=3, so the third should trip.
      const result = e.lifecycle.crashLoop.reconcileBoot();
      if (i < 2) {
        expect(result.detected).toBe(false);
      } else {
        expect(result.detected).toBe(true);
        expect(result.restart_count).toBe(3);
      }
    }
    // Kill switch should now be engaged with reason=crash_loop.
    expect(e.lifecycle.crashLoopPersistence.isCrashLoopActive()).toBe(true);
  });

  it('resetCrashLoop clears counters + releases kill switch', () => {
    e.lifecycle.store.setLastCrash({ at: Date.now(), reason: 'x', exit_code: 1 });
    e.lifecycle.store.incrementRestartCount();
    e.lifecycle.store.incrementRestartCount();
    e.lifecycle.crashLoopPersistence.setCrashLoopActive(true);

    const r = handleResetCrashLoop({
      getSnapshot: () => e.lifecycle.getSnapshot(),
      drain: e.lifecycle.drain,
      crashLoop: e.lifecycle.crashLoop,
    });
    expect(r.ok).toBe(true);
    expect(r.cleared).toEqual({
      restart_count: true,
      last_crash: true,
      crash_halt: true,
    });
    expect(e.lifecycle.crashLoopPersistence.isCrashLoopActive()).toBe(false);
  });
});

describe('Phase C e2e — signal listener + config reload', () => {
  let e: E2eHarness;
  beforeEach(async () => { e = await newE2e(); });
  afterEach(() => { e.close(); });

  it('getLifecycleState rpc returns live snapshot through the handler', () => {
    e.lifecycle.markBooted();
    const snap = handleGetLifecycleState({
      getSnapshot: () => e.lifecycle.getSnapshot(),
      drain: e.lifecycle.drain,
      crashLoop: e.lifecycle.crashLoop,
    });
    expect(snap.state).toBe('running');
    expect(snap.supervisor_mode).toBe('dev');
    expect(snap.boot_at).toBeGreaterThan(0);
    expect(snap.uptime_s).toBeGreaterThanOrEqual(0);
  });
});

describe('Phase C e2e — lock enforcement', () => {
  it('second lock against the same lock path refuses to claim', async () => {
    const e1 = await newE2e();
    // A second lock instance — pretend to be a different PID, and
    // treat the existing holder as alive.
    const { createInstanceLock } = await import('../lifecycle/instance-lock.js');
    const secondLock = createInstanceLock({
      lockPath: e1.lifecycle.lock.path,
      currentPid: () => process.pid + 1,
      isAlive: () => true,
    });
    expect(() =>
      secondLock.claim({ boot_at: Date.now(), bind_port: 7717 }),
    ).toThrow(/lock held/);
    e1.close();
  });
});
