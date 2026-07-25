import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRuntimeConfigStore, runtimeDefaults } from '@recued/config';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type AuditEntry,
  type ActivityEntry,
} from '@recued/storage';
import {
  createInMemoryStore,
  type CacheStore,
} from '@recued/cache';
import { RpcError } from '@recued/contracts';
import {
  createGateRegistry,
  type GateRegistry,
} from '../storage-gates.js';
import {
  createPressureStateStore,
  type PressureStateStore,
} from '../pressure-state.js';
import {
  createAuditRetention,
} from '../audit-retention.js';
import {
  createEvictionCascade,
  DEFAULT_CASCADE_CONFIG,
  type EvictionCascade,
} from '../eviction-cascade.js';
import {
  handleRunPressureReclaim,
  handleSetPressureOverride,
  type PressureHandlerDeps,
} from '../pressure-handler.js';

describe('pressure rpc handlers', () => {
  let db: Database.Database;
  let registry: GateRegistry;
  let cascade: EvictionCascade;
  let state: PressureStateStore;
  let cache: CacheStore;
  let deps: PressureHandlerDeps;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_store (key TEXT PRIMARY KEY, value_inline TEXT, blob_hash TEXT, size_bytes INTEGER NOT NULL, author_id TEXT NOT NULL, recipe_id TEXT, written_at INTEGER NOT NULL, last_read_at INTEGER);
      CREATE TABLE IF NOT EXISTS cache_entries (key TEXT PRIMARY KEY, inline_value TEXT, blob_hash TEXT, expires_at INTEGER NOT NULL, recipe_id TEXT NOT NULL, ingredient_slug TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL, category TEXT, risk_tier TEXT);
    `);
    state = createPressureStateStore(db);
    const auditLog = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );
    registry = createGateRegistry({
      config: createRuntimeConfigStore(runtimeDefaults()),
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0,
        cache: 0, audit: 0, schedules: 0,
      },
    });
    cache = createInMemoryStore({
      onBytesChanged: (d) => registry.cache.addUsed(d),
    });
    const retention = createAuditRetention({
      db, auditLog, gate: registry.audit,
      config: () => ({
        retentionDays: 30, quotaBytes: 50 * 1024 * 1024,
        pruneAtPct: 70, pruneMaxRowsPerRun: 1000, reservePct: 4,
      }),
    });
    cascade = createEvictionCascade({
      registry, state, auditLog, cache, auditRetention: retention,
      config: () => DEFAULT_CASCADE_CONFIG,
    });
    deps = { registry, cascade };
  });

  afterEach(() => {
    cascade.close();
    db.close();
  });

  // ── handleRunPressureReclaim ──

  it('runs reclaim on a valid surface', async () => {
    registry.cache.setUsed(registry.cache.info().pressureAt + 1);
    const result = await handleRunPressureReclaim(deps, { surface: 'cache' });
    expect(result.ran).toBe(true);
  });

  it('returns reason_if_skipped when debounced', async () => {
    registry.cache.setUsed(registry.cache.info().pressureAt + 1);
    await handleRunPressureReclaim(deps, { surface: 'cache' });
    const second = await handleRunPressureReclaim(deps, { surface: 'cache' });
    expect(second.ran).toBe(false);
    expect(second.reason_if_skipped).toBe('debounced');
  });

  it('force=true bypasses the debounce', async () => {
    registry.cache.setUsed(registry.cache.info().pressureAt + 1);
    await handleRunPressureReclaim(deps, { surface: 'cache' });
    const forced = await handleRunPressureReclaim(deps, { surface: 'cache', force: true });
    expect(forced.ran).toBe(true);
  });

  it('returns reason_if_skipped=no_such_surface for unknown surface', async () => {
    const result = await handleRunPressureReclaim(deps, { surface: 'bogus' });
    expect(result.ran).toBe(false);
    expect(result.reason_if_skipped).toBe('no_such_surface');
  });

  it('returns reason_if_skipped=not_evictable for vault / schedules / account', async () => {
    for (const surface of ['vault', 'schedules', 'account_store']) {
      const result = await handleRunPressureReclaim(deps, { surface });
      expect(result.reason_if_skipped).toBe('not_evictable');
    }
  });

  it('rejects missing / empty surface argument', async () => {
    await expect(handleRunPressureReclaim(deps, {})).rejects.toBeInstanceOf(RpcError);
    await expect(handleRunPressureReclaim(deps, { surface: '' })).rejects.toBeInstanceOf(RpcError);
    await expect(handleRunPressureReclaim(deps, { surface: 42 })).rejects.toBeInstanceOf(RpcError);
  });

  it('response shape matches ServerPressureReclaimResult contract', async () => {
    registry.cache.setUsed(registry.cache.info().pressureAt + 1);
    const result = await handleRunPressureReclaim(deps, { surface: 'cache' });
    expect(result).toMatchObject({
      ran: expect.any(Boolean),
      bytes_freed: expect.any(Number),
      steps_run: expect.any(Array),
    });
  });

  // ── handleSetPressureOverride ──

  it('halt then resume round-trips via override', async () => {
    const r1 = await handleSetPressureOverride(deps, { surface: 'cache', resume: false });
    expect(r1.ok).toBe(true);
    expect(registry.cache.info().state).toBe('halted');

    const r2 = await handleSetPressureOverride(deps, { surface: 'cache', resume: true });
    expect(r2.ok).toBe(true);
    expect(registry.cache.info().state).toBe('running');
  });

  it('rejects unknown surface', async () => {
    await expect(
      handleSetPressureOverride(deps, { surface: 'bogus', resume: false }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects missing / empty surface argument', async () => {
    await expect(
      handleSetPressureOverride(deps, { resume: false }),
    ).rejects.toBeInstanceOf(RpcError);
  });
});
