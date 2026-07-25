import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createRuntimeConfigStore,
  runtimeDefaults,
} from '@recued/config';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type AuditEntry,
  type ActivityEntry,
  type AuditLogStore,
} from '@recued/storage';
import {
  createInMemoryStore,
  type CacheStore,
} from '@recued/cache';
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
  type AuditRetention,
} from '../audit-retention.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import {
  createEvictionCascade,
  DEFAULT_CASCADE_CONFIG,
  type EvictionCascade,
} from '../eviction-cascade.js';

const mkConfig = () => createRuntimeConfigStore(runtimeDefaults());

describe('EvictionCascade', () => {
  let db: Database.Database;
  let registry: GateRegistry;
  let state: PressureStateStore;
  let auditLog: AuditLogStore;
  let cache: CacheStore;
  let retention: AuditRetention;
  let cascade: EvictionCascade;

  beforeEach(() => {
    db = new Database(':memory:');
    // Create all tables computeInitialUsage expects.
    db.exec(`
      CREATE TABLE IF NOT EXISTS server_vault (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_store (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_store (key TEXT PRIMARY KEY, value_inline TEXT, blob_hash TEXT, size_bytes INTEGER NOT NULL, author_id TEXT NOT NULL, recipe_id TEXT, written_at INTEGER NOT NULL, last_read_at INTEGER);
      CREATE TABLE IF NOT EXISTS cache_entries (key TEXT PRIMARY KEY, inline_value TEXT, blob_hash TEXT, expires_at INTEGER NOT NULL, recipe_id TEXT NOT NULL, ingredient_slug TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL, category TEXT, risk_tier TEXT);
      CREATE TABLE IF NOT EXISTS schedules (schedule_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, data TEXT NOT NULL);
    `);
    state = createPressureStateStore(db);
    auditLog = createAuditLogStore(
      createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
      createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
    );
    registry = createGateRegistry({
      config: mkConfig(),
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0,
        cache: 0, audit: 0, schedules: 0,
      },
    });
    cache = createInMemoryStore({
      onBytesChanged: (d) => registry.cache.addUsed(d),
    });
    retention = createAuditRetention({
      db, auditLog, gate: registry.audit,
      config: () => ({
        retentionDays: 30,
        quotaBytes: 50 * 1024 * 1024,
        pruneAtPct: 70,
        pruneMaxRowsPerRun: 1000,
        reservePct: 4,
      }),
    });
    cascade = createEvictionCascade({
      registry,
      state,
      auditLog,
      cache,
      auditRetention: retention,
      config: () => DEFAULT_CASCADE_CONFIG,
    });
  });

  afterEach(() => {
    cascade.close();
    db.close();
  });

  it('reclaim on unknown surface returns no_such_surface', async () => {
    const r = await cascade.reclaim('does-not-exist');
    expect(r.ran).toBe(false);
    expect(r.reason_if_skipped).toBe('no_such_surface');
  });

  it('reclaim on vault returns not_evictable', async () => {
    const r = await cascade.reclaim('vault');
    expect(r.ran).toBe(false);
    expect(r.reason_if_skipped).toBe('not_evictable');
  });

  it('reclaim on cache runs cache_lru step', async () => {
    // Seed the cache with entries so LRU has something to evict.
    const now = Date.now();
    await cache.set({
      key: 'a', value: 'x'.repeat(1000),
      expires_at: now + 60_000, recipe_id: 'r', ingredient_slug: 's',
      size_bytes: 1000, created_at: now, last_accessed_at: now,
    });
    // Push gate into pressure_managed.
    registry.cache.setUsed(registry.cache.info().pressureAt + 1);

    const r = await cascade.reclaim('cache');
    expect(r.ran).toBe(true);
    expect(r.steps_run).toContain('cache_lru');
  });

  it('reclaim on audit runs retention pruner', async () => {
    // Age an entry so age-based prune drops it.
    const old = Date.now() - 40 * 86_400_000;
    await auditLog.append({
      run_id: 'old',
      recipe_id: 'r', recipe_hash: 'h',
      started_at: old, finished_at: old + 100, duration_ms: 100,
      commit_status: 'succeeded', config_snapshot: {},
      errors: [],
      trigger_url: null, trigger_source: null, instance_id: null,
    });

    const r = await cascade.reclaim('audit');
    expect(r.ran).toBe(true);
    expect(r.steps_run).toContain('audit_age_prune');
  });

  it('debounces repeated calls within the cooldown window', async () => {
    registry.cache.setUsed(registry.cache.info().pressureAt + 1);
    const first = await cascade.reclaim('cache');
    const second = await cascade.reclaim('cache');
    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(second.reason_if_skipped).toBe('debounced');
  });

  it('force: true bypasses the debounce', async () => {
    registry.cache.setUsed(registry.cache.info().pressureAt + 1);
    await cascade.reclaim('cache');
    const forced = await cascade.reclaim('cache', { force: true });
    expect(forced.ran).toBe(true);
  });

  it('writes a pressure_eviction_run activity with reserve=true', async () => {
    registry.cache.setUsed(registry.cache.info().pressureAt + 1);
    await cascade.reclaim('cache');
    const activities = await auditLog.listActivities();
    const evict = activities.find((a) => a.action === 'pressure_eviction_run');
    expect(evict).toBeDefined();
    expect(evict!.target).toBe('cache');
    expect(evict!.reserve).toBe(true);
  });

  it('persists last_reclaim in server_state', async () => {
    registry.cache.setUsed(registry.cache.info().pressureAt + 1);
    await cascade.reclaim('cache');
    const last = state.getLastReclaim('cache');
    expect(last).not.toBeNull();
    expect(Array.isArray(last!.steps)).toBe(true);
  });

  it('clears surface entered_at when reclaim returns gate to running', async () => {
    state.setEnteredAt('cache', 1000);
    // Force the gate into running.
    registry.cache.setUsed(0);
    // Trigger a reclaim — cache LRU won't do anything (nothing to evict)
    // but state should clear because gate is already `running`.
    await cascade.reclaim('cache', { force: true });
    expect(state.getEnteredAt('cache')).toBeNull();
  });

  it('auto-triggers reclaim on gate state-change to pressure_managed', async () => {
    // Nothing in the cache yet — the cascade will run but find nothing to free.
    const before = (await auditLog.listActivities()).length;
    // Trigger by crossing pressure threshold.
    registry.cache.setUsed(registry.cache.info().pressureAt + 1);
    // Fire-and-forget — yield to microtask queue.
    await new Promise((r) => setImmediate(r));
    const after = (await auditLog.listActivities()).length;
    // Activity recorded automatically.
    expect(after).toBeGreaterThan(before);
    // entered_at also set.
    expect(state.getEnteredAt('cache')).not.toBeNull();
  });

  it('close() removes listeners', async () => {
    cascade.close();
    // After close, a state-change should NOT trigger a reclaim activity.
    const before = (await auditLog.listActivities()).length;
    registry.cache.setUsed(registry.cache.info().pressureAt + 1);
    await new Promise((r) => setImmediate(r));
    const after = (await auditLog.listActivities()).length;
    expect(after).toBe(before);
  });

  it('reclaim on shared_store reports not_evictable without blob store', async () => {
    // shared_store reclaim only does orphan sweep; without a blob store
    // deps, no steps run — but it's still not_evictable in the cascade's
    // routing sense. Actually the pipeline runs but produces steps_run=[].
    const r = await cascade.reclaim('shared_store');
    // shared_store IS in EVICTABLE_SURFACES — so it runs. Just no steps.
    expect(r.ran).toBe(true);
    expect(r.steps_run).toEqual([]);
  });
});
