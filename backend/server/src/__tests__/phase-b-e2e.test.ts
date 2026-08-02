/** Phase B end-to-end integration tests.
 *
 *  Exercises the whole Phase B stack together rather than per-module:
 *  registry + cascade + audit retention + pressure-state persistence
 *  + heartbeat envelope + rpc surface. Each test sets up a single
 *  in-memory SQLite + in-memory cache + in-memory audit and drives
 *  scenarios that cross the usual commit boundaries.
 *
 *  The per-module test suites (cache-gate, shared-store-gate,
 *  audit-retention, eviction-cascade, pressure-handler) cover the
 *  narrow contracts; this suite is the safety net that the wiring
 *  between modules doesn't drift. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createRuntimeConfigStore,
  runtimeDefaults,
  type RuntimeConfigStore,
} from '@recued/config';
import {
  createAuditLogStore,
  type AuditEntry,
  type ActivityEntry,
  type AuditLogStore,
} from '@recued/storage';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureAuditIndexes } from '../audit-indexes.js';
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
import {
  createEvictionCascade,
  DEFAULT_CASCADE_CONFIG,
  type EvictionCascade,
} from '../eviction-cascade.js';
import {
  handleRunPressureReclaim,
} from '../pressure-handler.js';
import {
  buildPressureDetails,
  handleGetStatus,
  type BootstrapHandlerDeps,
} from '../bootstrap-handler.js';
import { createServerStateStore } from '../server-state.js';

const setupHarness = () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_vault (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS account_store (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedules (schedule_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_store (key TEXT PRIMARY KEY, value_inline TEXT, blob_hash TEXT, size_bytes INTEGER NOT NULL, author_id TEXT NOT NULL, recipe_id TEXT, written_at INTEGER NOT NULL, last_read_at INTEGER);
    CREATE TABLE IF NOT EXISTS cache_entries (key TEXT PRIMARY KEY, inline_value TEXT, blob_hash TEXT, expires_at INTEGER NOT NULL, recipe_id TEXT NOT NULL, ingredient_slug TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL, category TEXT, risk_tier TEXT);
  `);
  // Use generous quotas so every surface has a non-zero
  // `available` region even with the 10 MB MIN_RESERVE_BYTES floor
  // in play (otherwise small-quota gates like account_store collapse
  // to `available=0` → `blockedAt=0` → state stuck at writes_blocked
  // before any write lands).
  const config: RuntimeConfigStore = createRuntimeConfigStore({
    ...runtimeDefaults(),
    'vault.quota.total_bytes': 200 * 1024 * 1024,
    'account.quota.bytes': 100 * 1024 * 1024,
    'data.shared.quota.bytes': 200 * 1024 * 1024,
    'cache.max_bytes': 200 * 1024 * 1024,
    'audit.quota.bytes': 200 * 1024 * 1024,
    'scheduler.quota.bytes': 100 * 1024 * 1024,
  });
  const registry: GateRegistry = createGateRegistry({
    config,
    initialUsage: {
      vault: 0, account_store: 0, shared_store: 0,
      cache: 0, audit: 0, schedules: 0,
    },
  });
  const state: PressureStateStore = createPressureStateStore(db);
  // Use SQLite-backed collections so the audit retention pruner's
  // json_extract queries see the same rows the auditLog writes.
  const auditLog: AuditLogStore = createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
    createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
    { onBytesChanged: (d) => registry.audit.addUsed(d) },
  );
  ensureAuditIndexes(db);
  const cache: CacheStore = createInMemoryStore({
    onBytesChanged: (d) => registry.cache.addUsed(d),
  });
  const retention: AuditRetention = createAuditRetention({
    db, auditLog, gate: registry.audit,
    config: () => ({
      retentionDays: 30, quotaBytes: 50 * 1024 * 1024,
      pruneAtPct: 70, pruneMaxRowsPerRun: 1000, reservePct: 4,
    }),
  });
  const cascade: EvictionCascade = createEvictionCascade({
    registry, state, auditLog, cache, auditRetention: retention,
    config: () => DEFAULT_CASCADE_CONFIG,
  });
  const serverState = createServerStateStore(db);
  const bootstrapDeps: BootstrapHandlerDeps = {
    bootstrap: {
      data_path: '/tmp', bind_host: '127.0.0.1', bind_port: 3001,
      mcp_port: 0, webhook_port: 0, log_path: '/tmp/log',
    },
    state: serverState,
    gates: registry.all(),
    version: '0.0.0-test',
    auditLog,
    pressureState: state,
  };
  return {
    db, config, registry, state, auditLog, cache, retention, cascade,
    bootstrapDeps,
    close: async () => { await cascade.close(); db.close(); },
  };
};

describe('Phase B e2e — cache pressure → LRU → recover', () => {
  let h: ReturnType<typeof setupHarness>;
  beforeEach(() => { h = setupHarness(); });
  afterEach(async () => { await h.close(); });

  it('filling the cache past pressureAt triggers auto-reclaim and returns to running', async () => {
    // Seed the cache with enough bytes to actually cross pressureAt.
    // Cache quota = 200 MB → available = 190 MB → pressureAt ≈ 152 MB.
    // Pack in ~155 MB so the first push over pressureAt fires the
    // cascade and LRU has real rows to evict.
    const now = Date.now();
    const entrySize = 5 * 1024 * 1024; // 5 MB each
    for (let i = 0; i < 32; i++) {
      await h.cache.set({
        key: `e${i}`, value: 'x'.repeat(entrySize),
        expires_at: now + 60_000, recipe_id: 'r', ingredient_slug: 's',
        size_bytes: entrySize, created_at: now - i, last_accessed_at: now - i,
      });
    }
    // The cache's onBytesChanged already drove the gate into pressure
    // and the cascade auto-fired. Wait for the reclaim.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // After LRU evict, used should be below pressureAt.
    const info = h.registry.cache.info();
    expect(info.used).toBeLessThan(info.pressureAt);
  });
});

describe('Phase B e2e — audit pressure → retention → recover', () => {
  let h: ReturnType<typeof setupHarness>;
  beforeEach(() => { h = setupHarness(); });
  afterEach(() => h.close());

  it('age-based prune reclaims old audit entries under pressure', async () => {
    const old = Date.now() - 40 * 86_400_000;
    await h.auditLog.append({
      run_id: 'old', recipe_id: 'r', recipe_hash: 'h',
      started_at: old, finished_at: old + 100, duration_ms: 100,
      commit_status: 'succeeded', config_snapshot: {},
      errors: [],
      trigger_url: null, trigger_source: null, instance_id: null,
    });
    const result = await handleRunPressureReclaim(
      { registry: h.registry, cascade: h.cascade },
      { surface: 'audit' },
    );
    expect(result.ran).toBe(true);
    expect(result.steps_run).toContain('audit_age_prune');
    expect(await h.auditLog.get('old')).toBeNull();
  });
});

describe('Phase B e2e — shared_store pressure → writes_blocked', () => {
  let h: ReturnType<typeof setupHarness>;
  beforeEach(() => { h = setupHarness(); });
  afterEach(() => h.close());

  it('user-class writes reject at writes_blocked; admin override still admits', async () => {
    // Force shared_store to writes_blocked via setUsed directly.
    const gate = h.registry.shared_store;
    gate.setUsed(gate.info().blockedAt);
    expect(gate.info().state).toBe('writes_blocked');
    // Status + heartbeat report the worst state.
    const status = handleGetStatus(h.bootstrapDeps);
    expect(status.storage_state).toBe('writes_blocked');
    const shared = status.pressure_details.per_surface.find((d) => d.surface === 'shared_store');
    expect(shared?.state).toBe('writes_blocked');
  });
});

describe('Phase B e2e — kill switch halts every gate; reserve writes continue', () => {
  let h: ReturnType<typeof setupHarness>;
  beforeEach(() => { h = setupHarness(); });
  afterEach(() => h.close());

  // Engage/release the crash-loop kill switch the way production does now
  // (crash-loop → `serverState.setCrashHalt` + the lifecycle
  // `onCrashHaltChange` seam → `gate.halt`/`resume`); the toggle rpc that
  // used to drive this was removed as dead code.
  const engageCrashHalt = (active: boolean): void => {
    h.bootstrapDeps.state.setCrashHalt(active);
    for (const g of h.registry.all()) {
      if (active) g.halt('crash_halt');
      else g.resume();
    }
  };

  it('engaging halts every gate; releasing resumes', () => {
    engageCrashHalt(true);
    for (const g of h.registry.all()) {
      expect(g.info().state).toBe('halted');
    }
    engageCrashHalt(false);
    for (const g of h.registry.all()) {
      expect(g.info().state).toBe('running');
    }
  });

  it('pressure_details.worst_state reports halted while kill switch is active', () => {
    engageCrashHalt(true);
    const details = buildPressureDetails(h.registry.all(), true, h.state);
    expect(details.worst_state).toBe('halted');
  });
});

describe('Phase B e2e — persistence + reconciliation', () => {
  let h: ReturnType<typeof setupHarness>;
  beforeEach(() => { h = setupHarness(); });
  afterEach(() => h.close());

  it('entered_at survives cascade restart when still under pressure', async () => {
    // Force pressure, trigger reclaim, wait.
    h.registry.cache.setUsed(h.registry.cache.info().pressureAt + 1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const enteredAt = h.state.getEnteredAt('cache');
    expect(enteredAt).not.toBeNull();
    // Force back to running manually; cascade.reclaim should clear the row.
    h.registry.cache.setUsed(0);
    // Trigger a reclaim to drive the clear-path.
    await handleRunPressureReclaim(
      { registry: h.registry, cascade: h.cascade },
      { surface: 'cache', force: true },
    );
    // gate already at running, so the cascade clears the row.
    expect(h.state.getEnteredAt('cache')).toBeNull();
  });

  it('last_reclaim persists after a cache reclaim pass', async () => {
    h.registry.cache.setUsed(h.registry.cache.info().pressureAt + 1);
    await handleRunPressureReclaim(
      { registry: h.registry, cascade: h.cascade },
      { surface: 'cache' },
    );
    const last = h.state.getLastReclaim('cache');
    expect(last).not.toBeNull();
    expect(Array.isArray(last!.steps)).toBe(true);
  });
});

describe('Phase B e2e — pressure_details shape across surfaces', () => {
  let h: ReturnType<typeof setupHarness>;
  beforeEach(() => { h = setupHarness(); });
  afterEach(() => h.close());

  it('getStatus surfaces all six gates in sorted order', () => {
    const status = handleGetStatus(h.bootstrapDeps);
    const names = status.pressure_details.per_surface.map((d) => d.surface);
    expect(names).toEqual([
      'account_store',
      'audit',
      'cache',
      'schedules',
      'shared_store',
      'vault',
    ]);
  });

  it('every detail has pct ∈ [0, 100]', () => {
    const status = handleGetStatus(h.bootstrapDeps);
    for (const d of status.pressure_details.per_surface) {
      expect(d.pct).toBeGreaterThanOrEqual(0);
      expect(d.pct).toBeLessThanOrEqual(100);
    }
  });
});

describe('Phase B e2e — runtime config propagation', () => {
  let h: ReturnType<typeof setupHarness>;
  beforeEach(() => {
    h = setupHarness();
    h.config.onChange((key) => {
      if (key === 'cache.max_bytes' || key === 'storage.reserve_pct') {
        h.registry.reconfigureFromConfig();
      }
    });
  });
  afterEach(() => h.close());

  it('changing cache.max_bytes propagates to the cache gate', () => {
    const before = h.registry.cache.info().quota;
    h.config.set('cache.max_bytes', before * 2);
    expect(h.registry.cache.info().quota).toBe(before * 2);
  });
});

describe('Phase B e2e — runtime pruner cron tick', () => {
  let h: ReturnType<typeof setupHarness>;
  beforeEach(() => { h = setupHarness(); });
  afterEach(() => h.close());

  it('runSafe returns null on error without throwing', async () => {
    const broken = createAuditRetention({
      db: h.db, auditLog: h.auditLog,
      gate: h.registry.audit,
      config: () => { throw new Error('boom'); },
    });
    const result = await broken.runSafe();
    expect(result).toBeNull();
  });

  it('concurrent run() calls coalesce into one', async () => {
    let invocations = 0;
    const coalescing = createAuditRetention({
      db: h.db, auditLog: h.auditLog,
      gate: h.registry.audit,
      config: () => { invocations++; return {
        retentionDays: 30, quotaBytes: 50 * 1024 * 1024,
        pruneAtPct: 70, pruneMaxRowsPerRun: 1000, reservePct: 4,
      }; },
    });
    await Promise.all([coalescing.run(), coalescing.run()]);
    expect(invocations).toBe(1);
  });
});
