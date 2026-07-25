import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createServerStateStore } from '../server-state.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

describe('createServerStateStore — kill switch', () => {
  it('starts inactive with no timestamp', () => {
    const state = createServerStateStore(db);
    expect(state.isCrashHaltActive()).toBe(false);
    expect(state.crashHaltSince()).toBeNull();
  });

  it('engaging records the activation time', () => {
    const state = createServerStateStore(db);
    const res = state.setCrashHalt(true, 1_700_000_000_000);
    expect(res).toEqual({ active: true, active_since: 1_700_000_000_000 });
    expect(state.isCrashHaltActive()).toBe(true);
    expect(state.crashHaltSince()).toBe(1_700_000_000_000);
  });

  it('re-engaging preserves the original activation time', () => {
    const state = createServerStateStore(db);
    state.setCrashHalt(true, 1_700_000_000_000);
    const res = state.setCrashHalt(true, 1_700_000_500_000);
    expect(res.active_since).toBe(1_700_000_000_000);
    expect(state.crashHaltSince()).toBe(1_700_000_000_000);
  });

  it('releasing clears the timestamp', () => {
    const state = createServerStateStore(db);
    state.setCrashHalt(true, 1_700_000_000_000);
    const res = state.setCrashHalt(false);
    expect(res).toEqual({ active: false, active_since: null });
    expect(state.isCrashHaltActive()).toBe(false);
    expect(state.crashHaltSince()).toBeNull();
  });

  it('survives a fresh store handle on the same db', () => {
    const s1 = createServerStateStore(db);
    s1.setCrashHalt(true, 1_700_000_000_000);
    const s2 = createServerStateStore(db);
    expect(s2.isCrashHaltActive()).toBe(true);
    expect(s2.crashHaltSince()).toBe(1_700_000_000_000);
  });
});

describe('createServerStateStore — master pause (D-188)', () => {
  it('starts not paused with no timestamp', () => {
    const state = createServerStateStore(db);
    expect(state.isPaused()).toBe(false);
    expect(state.pausedSince()).toBeNull();
  });

  it('engaging records the activation time', () => {
    const state = createServerStateStore(db);
    const res = state.setPaused(true, 1_700_000_000_000);
    expect(res).toEqual({ active: true, active_since: 1_700_000_000_000 });
    expect(state.isPaused()).toBe(true);
    expect(state.pausedSince()).toBe(1_700_000_000_000);
  });

  it('re-engaging preserves the original activation time', () => {
    const state = createServerStateStore(db);
    state.setPaused(true, 1_700_000_000_000);
    const res = state.setPaused(true, 1_700_000_500_000);
    expect(res.active_since).toBe(1_700_000_000_000);
    expect(state.pausedSince()).toBe(1_700_000_000_000);
  });

  it('releasing clears the timestamp', () => {
    const state = createServerStateStore(db);
    state.setPaused(true, 1_700_000_000_000);
    const res = state.setPaused(false);
    expect(res).toEqual({ active: false, active_since: null });
    expect(state.isPaused()).toBe(false);
    expect(state.pausedSince()).toBeNull();
  });

  it('survives a fresh store handle on the same db', () => {
    const s1 = createServerStateStore(db);
    s1.setPaused(true, 1_700_000_000_000);
    const s2 = createServerStateStore(db);
    expect(s2.isPaused()).toBe(true);
    expect(s2.pausedSince()).toBe(1_700_000_000_000);
  });

  it('SECURITY: pause is a DISTINCT axis from the kill switch (one never moves the other)', () => {
    const state = createServerStateStore(db);
    state.setPaused(true, 1_700_000_000_000);
    // Pausing must not engage the kill switch (different concern: no storage halt).
    expect(state.isCrashHaltActive()).toBe(false);
    state.setCrashHalt(true, 1_700_000_100_000);
    // …and the kill switch must not flip the pause flag.
    expect(state.isPaused()).toBe(true);
    expect(state.pausedSince()).toBe(1_700_000_000_000);
    // Releasing one leaves the other engaged.
    state.setPaused(false);
    expect(state.isPaused()).toBe(false);
    expect(state.isCrashHaltActive()).toBe(true);
  });
});

describe('createServerStateStore — staged bootstrap', () => {
  it('returns null when nothing is staged', () => {
    const state = createServerStateStore(db);
    expect(state.getStagedBootstrap()).toBeNull();
  });

  it('round-trips a partial patch', () => {
    const state = createServerStateStore(db);
    state.setStagedBootstrap({ bind_port: 9000, bind_host: '127.0.0.1' });
    expect(state.getStagedBootstrap()).toEqual({
      bind_port: 9000,
      bind_host: '127.0.0.1',
    });
  });

  it('clearing drops the row', () => {
    const state = createServerStateStore(db);
    state.setStagedBootstrap({ bind_port: 9000 });
    state.clearStagedBootstrap();
    expect(state.getStagedBootstrap()).toBeNull();
  });

  it('empty patch clears the row (no-op stage)', () => {
    const state = createServerStateStore(db);
    state.setStagedBootstrap({ bind_port: 9000 });
    state.setStagedBootstrap({});
    expect(state.getStagedBootstrap()).toBeNull();
  });

  it('corrupt row returns null instead of throwing', () => {
    createServerStateStore(db);
    db.prepare(
      `INSERT OR REPLACE INTO server_state (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run('bootstrap.staged', 'not-json', Date.now());
    const state = createServerStateStore(db);
    expect(state.getStagedBootstrap()).toBeNull();
  });
});
