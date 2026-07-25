import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createLifecycle,
  type Lifecycle,
} from '../lifecycle/index.js';
import { createServerStateStore, type ServerStateStore } from '../server-state.js';
import { createLifecycleStateStore } from '../lifecycle/lifecycle-state.js';
import { createStorageGate } from '@recued/storage-gate';
import { createRuntimeConfigStore } from '@recued/config';

interface Harness {
  dataPath: string;
  db: Database.Database;
  lifecycle: Lifecycle;
  serverState: ServerStateStore;
  exits: number[];
  close: () => void;
}

const newHarness = (opts: {
  supervisorMode?: import('@recued/contracts').SupervisorMode;
  onCrashHaltChange?: (active: boolean) => void;
  crashLoopConfig?: { threshold?: number; window_s?: number };
} = {}): Harness => {
  const dataPath = mkdtempSync(join(tmpdir(), 'recued-lifecycle-'));
  const db = new Database(':memory:');
  const serverState = createServerStateStore(db);
  const runtimeStore = createRuntimeConfigStore({
    'supervisor.mode': 'dev',
    'lifecycle.drain_timeout_s': 5,
    'lifecycle.watch_config': false,
  });
  const exits: number[] = [];
  const lifecycle = createLifecycle({
    db,
    dataPath,
    bindPort: 7717,
    version: '0.0.0-test',
    configPath: null,
    distribution: 'server',
    initialBootstrap: {
      data_path: dataPath,
      bind_host: '127.0.0.1',
      bind_port: 7717,
      mcp_port: 0,
      webhook_port: 0,
      log_path: `${dataPath}/logs`,
    },
    initialRuntime: {},
    runtimeStore,
    serverState,
    supervisorMode: opts.supervisorMode ?? 'dev',
    ...(opts.onCrashHaltChange ? { onCrashHaltChange: opts.onCrashHaltChange } : {}),
    ...(opts.crashLoopConfig ? { crashLoopConfig: opts.crashLoopConfig } : {}),
    exit: (code) => { exits.push(code); },
  });
  return {
    dataPath,
    db,
    lifecycle,
    serverState,
    exits,
    close() {
      lifecycle.uninstall();
      db.close();
      rmSync(dataPath, { recursive: true, force: true });
    },
  };
};

describe('createLifecycle — boot + state flow', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('resolves supervisor mode via override', () => {
    expect(h.lifecycle.mode).toBe('dev');
  });

  it('initial state is booting', () => {
    expect(h.lifecycle.machine.state).toBe('booting');
    const snap = h.lifecycle.getSnapshot();
    expect(snap.state).toBe('booting');
    expect(snap.supervisor_mode).toBe('dev');
  });

  it('markBooted flips to running and records boot_at', () => {
    h.lifecycle.markBooted();
    expect(h.lifecycle.machine.state).toBe('running');
    expect(h.lifecycle.store.getBootAt()).not.toBeNull();
    const snap = h.lifecycle.getSnapshot();
    expect(snap.state).toBe('running');
  });

  it('second markBooted is a no-op (already running)', () => {
    h.lifecycle.markBooted();
    const firstBoot = h.lifecycle.store.getBootAt();
    h.lifecycle.markBooted();
    expect(h.lifecycle.store.getBootAt()).toBe(firstBoot);
  });

  it('exposes the handler slice with three methods', () => {
    expect(h.lifecycle.handlerSlice?.methods).toEqual([
      'server.requestShutdown',
      'server.getLifecycleState',
      'server.resetCrashLoop',
    ]);
  });
});

describe('createLifecycle — drain + shutdown', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('requestDrain flips state and marks clean shutdown', async () => {
    h.lifecycle.markBooted();
    const result = await h.lifecycle.requestDrain({
      intent: 'shutdown',
      reason: 'test',
    });
    expect(result.intent).toBe('shutdown');
    expect(h.lifecycle.machine.state).toBe('shutting_down');
    expect(h.lifecycle.store.getShutdownAt()).not.toBeNull();
  });

  it('requestDrain with intent=restart transitions to restarting', async () => {
    h.lifecycle.markBooted();
    const result = await h.lifecycle.requestDrain({
      intent: 'restart',
      reason: 'rpc',
    });
    expect(result.intent).toBe('restart');
    expect(h.lifecycle.machine.state).toBe('restarting');
  });

  it('concurrent requestDrain calls coalesce', async () => {
    h.lifecycle.markBooted();
    const a = h.lifecycle.requestDrain({ intent: 'shutdown', reason: 'a' });
    const b = h.lifecycle.requestDrain({ intent: 'shutdown', reason: 'b' });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
  });
});

describe('createLifecycle — handleCrash', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('writes last_crash + transitions to crashed', async () => {
    h.lifecycle.markBooted();
    await h.lifecycle.handleCrash(new Error('boom'), 'uncaughtException');
    expect(h.lifecycle.machine.state).toBe('crashed');
    const crash = h.lifecycle.store.getLastCrash();
    expect(crash?.exit_code).toBe(1);
    expect(crash?.reason).toContain('boom');
  });
});

describe('createLifecycle — crash-loop write-halt seam', () => {
  it('crash-loop halt actually BLOCKS writes at a wired gate; reset unblocks', () => {
    // Wire onCrashHaltChange to a real gate exactly as compose-lifecycle does,
    // to prove the end effect: a crash-loop halt REJECTS writes (not just the
    // status flag — the original bug was the flag flipping without gate halt).
    const gate = createStorageGate({
      quota: 100 * 1024 * 1024,
      reservePct: 5,
      surface: 'shared_store',
    });
    const h = newHarness({
      onCrashHaltChange: (active) => {
        if (active) gate.halt('crash_halt');
        else if (gate.info().haltReason === 'crash_halt') gate.resume();
      },
      crashLoopConfig: { threshold: 2, window_s: 3_600 },
    });
    // Repeated unclean restarts within the window: reconcileBoot with no clean
    // shutdown increments the restart count; a recent lastCrash keeps it
    // in-window, so the threshold trips and the detector engages the switch.
    const store = createLifecycleStateStore(h.db);
    store.setLastCrash({ at: Date.now(), reason: 'test-crash', exit_code: 1 });
    for (let i = 0; i < 3; i += 1) h.lifecycle.crashLoop.reconcileBoot();

    expect(h.serverState.isCrashHaltActive()).toBe(true);
    expect(gate.canWrite(1024).ok).toBe(false); // writes REJECTED during halt

    // Reset releases it (releaseCrashHalt → onCrashHaltChange(false)).
    h.lifecycle.crashLoop.reset();
    expect(h.serverState.isCrashHaltActive()).toBe(false);
    expect(gate.canWrite(1024).ok).toBe(true); // writes admitted again

    h.close();
  });
});

describe('createLifecycle — install/uninstall', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('install registers signal handlers and is idempotent', () => {
    expect(h.lifecycle.signals.installed).toBe(false);
    h.lifecycle.install();
    expect(h.lifecycle.signals.installed).toBe(true);
    h.lifecycle.install(); // no-op
    expect(h.lifecycle.signals.installed).toBe(true);
  });

  it('uninstall removes every handler', () => {
    h.lifecycle.install();
    h.lifecycle.uninstall();
    expect(h.lifecycle.signals.installed).toBe(false);
  });
});

describe('createLifecycle — lock', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('exposes the instance lock rooted at data_path', () => {
    expect(h.lifecycle.lock.path).toContain(h.dataPath);
    expect(h.lifecycle.lock.path).toContain('recued-server.lock');
  });
});
