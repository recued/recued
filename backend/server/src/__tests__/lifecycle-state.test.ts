import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createLifecycleStateStore,
  createLifecycleStateMachine,
  buildLifecycleSnapshot,
  InvalidTransitionError,
  type LifecycleStateStore,
  type LifecycleStateMachine,
} from '../lifecycle/lifecycle-state.js';
import type { LifecycleState } from '@recued/contracts';

describe('LifecycleStateStore', () => {
  let db: Database.Database;
  let store: LifecycleStateStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createLifecycleStateStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('boot_at round-trips', () => {
    expect(store.getBootAt()).toBeNull();
    store.setBootAt(1_700_000_000_000);
    expect(store.getBootAt()).toBe(1_700_000_000_000);
  });

  it('restart_count starts at 0 and increments atomically', () => {
    expect(store.getRestartCount()).toBe(0);
    expect(store.incrementRestartCount()).toBe(1);
    expect(store.incrementRestartCount()).toBe(2);
    expect(store.incrementRestartCount()).toBe(3);
    expect(store.getRestartCount()).toBe(3);
  });

  it('resetRestartCount drops the key back to 0', () => {
    store.incrementRestartCount();
    store.incrementRestartCount();
    store.resetRestartCount();
    expect(store.getRestartCount()).toBe(0);
  });

  it('shutdown_at round-trips + clears on demand', () => {
    expect(store.getShutdownAt()).toBeNull();
    store.markCleanShutdown(1_700_000_001_000);
    expect(store.getShutdownAt()).toBe(1_700_000_001_000);
    store.clearShutdownAt();
    expect(store.getShutdownAt()).toBeNull();
  });

  it('last_crash persists the full shape', () => {
    expect(store.getLastCrash()).toBeNull();
    store.setLastCrash({
      at: 1_700_000_002_000,
      reason: 'unhandled promise rejection: TypeError foo',
      exit_code: 1,
    });
    expect(store.getLastCrash()).toEqual({
      at: 1_700_000_002_000,
      reason: 'unhandled promise rejection: TypeError foo',
      exit_code: 1,
    });
    store.clearLastCrash();
    expect(store.getLastCrash()).toBeNull();
  });

  it('last_crash returns null on malformed JSON (defensive)', () => {
    // Write garbage directly to simulate corruption.
    db.prepare(
      `INSERT INTO server_state (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run('lifecycle.last_crash', '{not json', Date.now());
    expect(store.getLastCrash()).toBeNull();
  });

  it('last_crash returns null when fields have wrong types', () => {
    db.prepare(
      `INSERT INTO server_state (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run('lifecycle.last_crash', JSON.stringify({ at: 'x', reason: 'y', exit_code: 1 }), Date.now());
    expect(store.getLastCrash()).toBeNull();
  });

  it('restart_pending round-trips', () => {
    expect(store.getRestartPending()).toBe(false);
    store.setRestartPending(true);
    expect(store.getRestartPending()).toBe(true);
    store.setRestartPending(false);
    expect(store.getRestartPending()).toBe(false);
  });

  it('defensive: non-numeric stored values return null/0', () => {
    db.prepare(
      `INSERT INTO server_state (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run('lifecycle.boot_at', 'nope', Date.now());
    expect(store.getBootAt()).toBeNull();
    db.prepare(
      `INSERT INTO server_state (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run('lifecycle.restart_count', 'nope', Date.now());
    expect(store.getRestartCount()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// State machine
// ────────────────────────────────────────────────────────────────

describe('LifecycleStateMachine', () => {
  let machine: LifecycleStateMachine;

  beforeEach(() => {
    machine = createLifecycleStateMachine();
  });

  it('starts in booting by default', () => {
    expect(machine.state).toBe('booting');
  });

  it('accepts custom initial state', () => {
    expect(createLifecycleStateMachine('running').state).toBe('running');
  });

  it('booting → running → draining → shutting_down is valid', () => {
    machine.transition('running');
    expect(machine.state).toBe('running');
    machine.transition('draining');
    expect(machine.state).toBe('draining');
    machine.transition('shutting_down');
    expect(machine.state).toBe('shutting_down');
  });

  it('booting → running → draining → restarting is valid', () => {
    machine.transition('running');
    machine.transition('draining');
    machine.transition('restarting');
    expect(machine.state).toBe('restarting');
  });

  it('crashed is reachable from any non-terminal state', () => {
    createLifecycleStateMachine('booting').transition('crashed');
    createLifecycleStateMachine('running').transition('crashed');
    createLifecycleStateMachine('draining').transition('crashed');
  });

  it('terminal states have no outgoing transitions', () => {
    const terminals: LifecycleState[] = ['restarting', 'shutting_down', 'crashed'];
    for (const t of terminals) {
      const m = createLifecycleStateMachine(t);
      expect(() => m.transition('running')).toThrow(InvalidTransitionError);
    }
  });

  it('rejects invalid transitions (booting → draining skips running)', () => {
    expect(() => machine.transition('draining')).toThrow(InvalidTransitionError);
    expect(machine.state).toBe('booting'); // not changed on throw
  });

  it('rejects reverse transitions (running → booting)', () => {
    machine.transition('running');
    expect(() => machine.transition('booting')).toThrow(InvalidTransitionError);
  });

  it('same-state transition is a no-op', () => {
    let changes = 0;
    machine.onStateChange(() => { changes++; });
    machine.transition('booting');
    expect(machine.state).toBe('booting');
    expect(changes).toBe(0);
  });

  it('observers fire synchronously after each transition', () => {
    const events: string[] = [];
    machine.onStateChange((prev, next) => events.push(`${prev}→${next}`));
    machine.transition('running');
    machine.transition('draining');
    expect(events).toEqual(['booting→running', 'running→draining']);
  });

  it('unsubscribe removes the observer', () => {
    const events: string[] = [];
    const unsub = machine.onStateChange((p, n) => events.push(`${p}→${n}`));
    machine.transition('running');
    unsub();
    machine.transition('draining');
    expect(events).toEqual(['booting→running']);
  });

  it('observer exception does not break subsequent observers or state flow', () => {
    const events: string[] = [];
    machine.onStateChange(() => { throw new Error('boom'); });
    machine.onStateChange((p, n) => events.push(`${p}→${n}`));
    expect(() => machine.transition('running')).not.toThrow();
    expect(events).toEqual(['booting→running']);
    expect(machine.state).toBe('running');
  });

  it('isAtLeast compares by LIFECYCLE_STATE_RANK', () => {
    expect(machine.isAtLeast('booting')).toBe(true);
    expect(machine.isAtLeast('running')).toBe(false);
    machine.transition('running');
    expect(machine.isAtLeast('running')).toBe(true);
    expect(machine.isAtLeast('draining')).toBe(false);
    machine.transition('draining');
    expect(machine.isAtLeast('running')).toBe(true);
    expect(machine.isAtLeast('draining')).toBe(true);
    expect(machine.isAtLeast('crashed')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Snapshot builder
// ────────────────────────────────────────────────────────────────

describe('buildLifecycleSnapshot', () => {
  let db: Database.Database;
  let store: LifecycleStateStore;
  let machine: LifecycleStateMachine;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createLifecycleStateStore(db);
    machine = createLifecycleStateMachine('running');
  });

  afterEach(() => {
    db.close();
  });

  it('computes uptime_s from boot_at + now', () => {
    store.setBootAt(1_700_000_000_000);
    const snap = buildLifecycleSnapshot({
      store,
      machine,
      supervisor_mode: 'systemd',
      now: () => 1_700_000_005_500,
    });
    expect(snap.uptime_s).toBe(5);
    expect(snap.boot_at).toBe(1_700_000_000_000);
  });

  it('returns uptime_s=0 when boot_at is missing or in the future', () => {
    // Missing
    let snap = buildLifecycleSnapshot({
      store, machine, supervisor_mode: 'dev', now: () => 1_700_000_000_000,
    });
    expect(snap.uptime_s).toBe(0);
    // Future
    store.setBootAt(1_700_000_010_000);
    snap = buildLifecycleSnapshot({
      store, machine, supervisor_mode: 'dev', now: () => 1_700_000_005_000,
    });
    expect(snap.uptime_s).toBe(0);
  });

  it('includes last_crash when present', () => {
    store.setLastCrash({ at: 1_699_999_999_000, reason: 'boom', exit_code: 1 });
    const snap = buildLifecycleSnapshot({
      store, machine, supervisor_mode: 'native', now: () => 1_700_000_000_000,
    });
    expect(snap.last_crash).toEqual({
      at: 1_699_999_999_000, reason: 'boom', exit_code: 1,
    });
  });

  it('includes drain state only when machine is draining', () => {
    const drain = {
      active: true,
      started_at: 1_700_000_000_000,
      reason: 'rpc',
      intent: 'restart' as const,
      current_step: 'await_inflight' as const,
      completed_steps: ['flip_to_draining', 'stop_accepting_rpc', 'pause_scheduler'] as const,
      aborted_steps: [],
    };
    // Not draining → drain omitted even if passed.
    let snap = buildLifecycleSnapshot({
      store,
      machine,
      supervisor_mode: 'docker',
      drain: { ...drain, completed_steps: [...drain.completed_steps], aborted_steps: [] },
    });
    expect(snap.drain).toBeUndefined();

    // Flip to draining.
    machine.transition('draining');
    snap = buildLifecycleSnapshot({
      store,
      machine,
      supervisor_mode: 'docker',
      drain: { ...drain, completed_steps: [...drain.completed_steps], aborted_steps: [] },
    });
    expect(snap.drain?.current_step).toBe('await_inflight');
  });

  it('OR-combines store restart_pending with stagedBootstrapPending', () => {
    let snap = buildLifecycleSnapshot({
      store, machine, supervisor_mode: 'launchd',
    });
    expect(snap.restart_pending).toBe(false);

    store.setRestartPending(true);
    snap = buildLifecycleSnapshot({
      store, machine, supervisor_mode: 'launchd',
    });
    expect(snap.restart_pending).toBe(true);

    store.setRestartPending(false);
    snap = buildLifecycleSnapshot({
      store, machine, supervisor_mode: 'launchd',
      stagedBootstrapPending: true,
    });
    expect(snap.restart_pending).toBe(true);
  });

  it('mirrors the supervisor_mode input verbatim', () => {
    for (const mode of ['native', 'systemd', 'launchd', 'docker', 'dev'] as const) {
      const snap = buildLifecycleSnapshot({ store, machine, supervisor_mode: mode });
      expect(snap.supervisor_mode).toBe(mode);
    }
  });
});
