import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createPressureStateStore,
  reconcilePressureStateAtBoot,
  type PressureStateStore,
} from '../pressure-state.js';

const mkDb = (): Database.Database => {
  const db = new Database(':memory:');
  return db;
};

describe('PressureStateStore', () => {
  let db: Database.Database;
  let store: PressureStateStore;

  beforeEach(() => {
    db = mkDb();
    store = createPressureStateStore(db);
  });

  it('creates the server_state table if missing (idempotent)', () => {
    // Re-create another store on the same db — should not throw.
    expect(() => createPressureStateStore(db)).not.toThrow();
  });

  it('getEnteredAt returns null for unset surface', () => {
    expect(store.getEnteredAt('cache')).toBeNull();
  });

  it('setEnteredAt + getEnteredAt roundtrip', () => {
    store.setEnteredAt('cache', 1_700_000_000_000);
    expect(store.getEnteredAt('cache')).toBe(1_700_000_000_000);
  });

  it('setEnteredAt is earliest-wins — later call does not overwrite', () => {
    store.setEnteredAt('cache', 1_000);
    store.setEnteredAt('cache', 5_000);
    expect(store.getEnteredAt('cache')).toBe(1_000);
  });

  it('setEnteredAt earlier value overwrites (earliest-wins)', () => {
    store.setEnteredAt('cache', 5_000);
    store.setEnteredAt('cache', 1_000);
    expect(store.getEnteredAt('cache')).toBe(1_000);
  });

  it('clearSurface drops both entered_at and last_reclaim', () => {
    store.setEnteredAt('cache', 1_000);
    store.setLastReclaim('cache', { at: 2_000, bytes_freed: 50, success: true, steps: ['cache_lru'] });
    store.clearSurface('cache');
    expect(store.getEnteredAt('cache')).toBeNull();
    expect(store.getLastReclaim('cache')).toBeNull();
  });

  it('last_reclaim roundtrip preserves structured fields', () => {
    const snap = { at: 2_000, bytes_freed: 12_345_678, success: true, steps: ['cache_lru', 'audit_age_prune'] };
    store.setLastReclaim('cache', snap);
    expect(store.getLastReclaim('cache')).toEqual(snap);
  });

  it('getLastReclaim returns null for malformed JSON', () => {
    // Insert a bad row manually.
    db.prepare(
      `INSERT INTO server_state (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run('pressure.cache.last_reclaim', 'not json', Date.now());
    expect(store.getLastReclaim('cache')).toBeNull();
  });

  it('getLastReclaim returns null for structurally-wrong JSON', () => {
    db.prepare(
      `INSERT OR REPLACE INTO server_state (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run('pressure.cache.last_reclaim', JSON.stringify({ at: 'nope' }), Date.now());
    expect(store.getLastReclaim('cache')).toBeNull();
  });

  it('listSurfaces enumerates surfaces with active entered_at rows', () => {
    store.setEnteredAt('cache', 1);
    store.setEnteredAt('audit', 2);
    store.setEnteredAt('vault', 3);
    store.clearSurface('vault');
    expect(store.listSurfaces()).toEqual(['audit', 'cache']);
  });

  it('last_reclaim WITHOUT entered_at is not listed by listSurfaces (only entered_at rows count)', () => {
    store.setLastReclaim('cache', { at: 1, bytes_freed: 0, success: false, steps: [] });
    expect(store.listSurfaces()).toEqual([]);
  });

  it('setEnteredAt ignores NaN / negative input', () => {
    store.setEnteredAt('cache', Number.NaN);
    store.setEnteredAt('cache', -1);
    expect(store.getEnteredAt('cache')).toBeNull();
  });
});

describe('reconcilePressureStateAtBoot', () => {
  let db: Database.Database;
  let store: PressureStateStore;
  beforeEach(() => {
    db = mkDb();
    store = createPressureStateStore(db);
  });

  const fakeGate = (surface: string, state: string) => ({
    info: () => ({ surface, state }),
  });

  it('seeds entered_at for non-running gates with no prior row', () => {
    const result = reconcilePressureStateAtBoot({
      state: store,
      gates: [fakeGate('cache', 'pressure_managed'), fakeGate('vault', 'running')],
      now: () => 1_000,
    });
    expect(result.seeded).toEqual(['cache']);
    expect(result.cleared).toEqual([]);
    expect(result.active).toEqual(['cache']);
    expect(store.getEnteredAt('cache')).toBe(1_000);
    expect(store.getEnteredAt('vault')).toBeNull();
  });

  it('preserves entered_at across restart for surfaces still in pressure', () => {
    store.setEnteredAt('cache', 500);
    const result = reconcilePressureStateAtBoot({
      state: store,
      gates: [fakeGate('cache', 'writes_blocked')],
      now: () => 5_000,
    });
    expect(result.seeded).toEqual([]);
    expect(store.getEnteredAt('cache')).toBe(500);
    expect(result.active).toEqual(['cache']);
  });

  it('clears stale rows when the gate returned to running', () => {
    store.setEnteredAt('cache', 500);
    store.setLastReclaim('cache', { at: 600, bytes_freed: 100, success: true, steps: [] });
    const result = reconcilePressureStateAtBoot({
      state: store,
      gates: [fakeGate('cache', 'running')],
      now: () => 5_000,
    });
    expect(result.cleared).toEqual(['cache']);
    expect(store.getEnteredAt('cache')).toBeNull();
    expect(store.getLastReclaim('cache')).toBeNull();
  });

  it('drops rows for surfaces the gate set no longer reports', () => {
    store.setEnteredAt('retired_surface', 100);
    const result = reconcilePressureStateAtBoot({
      state: store,
      gates: [fakeGate('cache', 'running')],
      now: () => 5_000,
    });
    expect(result.cleared).toContain('retired_surface');
    expect(store.getEnteredAt('retired_surface')).toBeNull();
  });

  it('halted state also keeps entered_at (halt is a pressure state)', () => {
    const result = reconcilePressureStateAtBoot({
      state: store,
      gates: [fakeGate('cache', 'halted')],
      now: () => 1_000,
    });
    expect(result.active).toEqual(['cache']);
    expect(store.getEnteredAt('cache')).toBe(1_000);
  });
});
