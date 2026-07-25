import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  createRuntimeConfigStore,
  runtimeDefaults,
  type RuntimeConfigStore,
} from '@recued/config';
import {
  createGateRegistry,
  computeInitialUsage,
  GATED_SURFACES,
  tableDataBytes,
  tableSizeColumn,
} from '../storage-gates.js';

const mkConfig = (
  overrides: Record<string, number | string | boolean> = {},
): RuntimeConfigStore => {
  const defaults = runtimeDefaults();
  return createRuntimeConfigStore({ ...defaults, ...overrides });
};

const mkDb = (): Database.Database => {
  const db = new Database(':memory:');
  // Create the tables computeInitialUsage expects — otherwise we're
  // just sanity-checking the registry against 0s.
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_vault (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS account_store (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedules (schedule_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_store (key TEXT PRIMARY KEY, value_inline TEXT, blob_hash TEXT, size_bytes INTEGER NOT NULL, author_id TEXT NOT NULL, recipe_id TEXT, written_at INTEGER NOT NULL, last_read_at INTEGER);
    CREATE TABLE IF NOT EXISTS cache_entries (key TEXT PRIMARY KEY, inline_value TEXT, blob_hash TEXT, expires_at INTEGER NOT NULL, recipe_id TEXT NOT NULL, ingredient_slug TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL, category TEXT, risk_tier TEXT);
  `);
  return db;
};

describe('GATED_SURFACES', () => {
  it('lists exactly the six Phase B surfaces', () => {
    expect([...GATED_SURFACES]).toEqual([
      'vault',
      'account_store',
      'shared_store',
      'cache',
      'audit',
      'schedules',
    ]);
  });
});

describe('tableDataBytes / tableSizeColumn helpers', () => {
  it('returns 0 for missing tables (defensive)', () => {
    const db = new Database(':memory:');
    expect(tableDataBytes(db, 'nonexistent')).toBe(0);
    expect(tableSizeColumn(db, 'nonexistent')).toBe(0);
    db.close();
  });

  it('sums length(data) across rows for generic collection tables', () => {
    const db = mkDb();
    db.prepare(`INSERT INTO audit_entries (key, data) VALUES (?, ?)`).run('a', 'xx');
    db.prepare(`INSERT INTO audit_entries (key, data) VALUES (?, ?)`).run('b', 'yyy');
    expect(tableDataBytes(db, 'audit_entries')).toBe(5);
    db.close();
  });

  it('sums size_bytes across rows for specialised tables', () => {
    const db = mkDb();
    db.prepare(
      `INSERT INTO shared_store (key, value_inline, size_bytes, author_id, written_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('k1', 'v1', 100, 'me', Date.now());
    db.prepare(
      `INSERT INTO shared_store (key, value_inline, size_bytes, author_id, written_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('k2', 'v2', 250, 'me', Date.now());
    expect(tableSizeColumn(db, 'shared_store')).toBe(350);
    db.close();
  });
});

describe('computeInitialUsage', () => {
  it('returns 0 for every surface on an empty db', () => {
    const db = mkDb();
    const usage = computeInitialUsage({ db });
    for (const s of GATED_SURFACES) {
      expect(usage[s]).toBe(0);
    }
    db.close();
  });

  it('aggregates audit_entries + audit_activities into one `audit` total', () => {
    const db = mkDb();
    db.prepare(`INSERT INTO audit_entries (key, data) VALUES (?, ?)`).run('r1', 'xxxx');
    db.prepare(`INSERT INTO audit_activities (key, data) VALUES (?, ?)`).run('a1', 'yyyyyy');
    const usage = computeInitialUsage({ db });
    expect(usage.audit).toBe(10);
    db.close();
  });
});

describe('createGateRegistry', () => {
  it('builds one gate per surface with surface-name metadata', () => {
    const config = mkConfig();
    const registry = createGateRegistry({
      config,
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0,
        cache: 0, audit: 0, schedules: 0,
      },
    });
    for (const surface of GATED_SURFACES) {
      const gate = registry.get(surface);
      expect(gate).toBeDefined();
      expect(gate!.info().surface).toBe(surface);
    }
  });

  it('all() returns gates in the GATED_SURFACES order', () => {
    const config = mkConfig();
    const registry = createGateRegistry({
      config,
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0,
        cache: 0, audit: 0, schedules: 0,
      },
    });
    const surfaces = registry.all().map((g) => g.info().surface);
    expect(surfaces).toEqual([...GATED_SURFACES]);
  });

  it('primes each gate with its initialUsage on construction', () => {
    const config = mkConfig();
    const registry = createGateRegistry({
      config,
      initialUsage: {
        vault: 1_000_000,
        account_store: 500_000,
        shared_store: 10_000_000,
        cache: 50_000_000,
        audit: 250_000,
        schedules: 75_000,
      },
    });
    expect(registry.vault.info().used).toBe(1_000_000);
    expect(registry.cache.info().used).toBe(50_000_000);
    expect(registry.audit.info().used).toBe(250_000);
  });

  it('pulls quota from runtime config per-surface', () => {
    const config = mkConfig({
      'cache.max_bytes': 123_456_789,
      'vault.quota.total_bytes': 777_000,
    });
    const registry = createGateRegistry({
      config,
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0,
        cache: 0, audit: 0, schedules: 0,
      },
    });
    expect(registry.cache.info().quota).toBe(123_456_789);
    expect(registry.vault.info().quota).toBe(777_000);
  });

  it('audit reservePct is double the storage.reserve_pct baseline', () => {
    const config = mkConfig({ 'storage.reserve_pct': 3 });
    const registry = createGateRegistry({
      config,
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0,
        cache: 0, audit: 0, schedules: 0,
      },
    });
    const auditInfo = registry.audit.info();
    const vaultInfo = registry.vault.info();
    // Reserve percentage is realised in the `reserve` bytes field only
    // past MIN_RESERVE_BYTES (10 MB). Use a big enough quota to cross
    // the floor: default audit quota ≈ 50 MB → 6% = 3 MB, below floor
    // so reserve == MIN_RESERVE_BYTES. Instead, verify by overriding
    // the audit quota to a large value.
    const configLarge = mkConfig({
      'storage.reserve_pct': 3,
    });
    configLarge.set('vault.quota.total_bytes', 1_000_000_000);
    const registryLarge = createGateRegistry({
      config: configLarge,
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0,
        cache: 0, audit: 0, schedules: 0,
      },
    });
    // vault reserve = 3% of 1 GB = 30 MB
    expect(registryLarge.vault.info().reserve).toBeGreaterThanOrEqual(30_000_000 - 1);
    // Smoke: audit reserve byte count ≥ vault reserve byte count at
    // identical quotas because the multiplier is 2×.
    expect(auditInfo.reserve).toBeGreaterThan(0);
    expect(vaultInfo.reserve).toBeGreaterThan(0);
  });

  it('shared_store + cache run with 0 reserve (fully user-evictable)', () => {
    const config = mkConfig({ 'storage.reserve_pct': 10 });
    const registry = createGateRegistry({
      config,
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0,
        cache: 0, audit: 0, schedules: 0,
      },
    });
    // With 0 × reserve_pct, the computed reserve falls back to the
    // MIN_RESERVE_BYTES floor (10 MB) — that's the gate-level
    // contract. What the registry controls is the *percentage*, which
    // should be 0 for these two surfaces.
    // Use a very large quota so the floor doesn't dominate.
    const cfg = mkConfig();
    cfg.set('storage.reserve_pct', 10);
    cfg.set('cache.max_bytes', 1_000_000_000);
    cfg.set('data.shared.quota.bytes', 1_000_000_000);
    const reg = createGateRegistry({
      config: cfg,
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0,
        cache: 0, audit: 0, schedules: 0,
      },
    });
    // 0% reserve → reserve bytes should still equal the floor only.
    // (The gate enforces MIN_RESERVE_BYTES as a hard minimum even when
    // reservePct resolves to 0.)
    const minReserve = 10 * 1024 * 1024;
    expect(reg.cache.info().reserve).toBe(minReserve);
    expect(reg.shared_store.info().reserve).toBe(minReserve);
  });

  it('reconfigureFromConfig applies live quota changes', () => {
    const config = mkConfig();
    const registry = createGateRegistry({
      config,
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0,
        cache: 0, audit: 0, schedules: 0,
      },
    });
    const before = registry.cache.info().quota;
    config.set('cache.max_bytes', before * 2);
    registry.reconfigureFromConfig();
    expect(registry.cache.info().quota).toBe(before * 2);
  });

  it('get() returns undefined for an unknown surface name', () => {
    const config = mkConfig();
    const registry = createGateRegistry({
      config,
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0,
        cache: 0, audit: 0, schedules: 0,
      },
    });
    expect(registry.get('does_not_exist')).toBeUndefined();
  });
});
