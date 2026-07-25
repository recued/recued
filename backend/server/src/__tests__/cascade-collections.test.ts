import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  createRuntimeConfigStore,
  runtimeDefaults,
} from '@recued/config';
import {
  createAuditLogStore,
  type AuditEntry,
  type ActivityEntry,
  type AuditLogStore,
} from '@recued/storage';
import type {
  CollectionHealth,
  CollectionPlatform,
  CollectionRecord,
  CollectionSearchMatch,
} from '@recued/contracts';
import type { StorageGate } from '@recued/storage-gate';

import { createSQLiteCollection } from '../sqlite-collection.js';
import { createGateRegistry, type GateRegistry } from '../storage-gates.js';
import { createPressureStateStore } from '../pressure-state.js';
import {
  createEvictionCascade,
  DEFAULT_CASCADE_CONFIG,
  type EvictionCascade,
} from '../eviction-cascade.js';
import {
  createCollectionRegistry,
  type CollectionRegistry,
} from '../collections/registry.js';
import type {
  Collection,
  CollectionPruneResult,
  CollectionSyncAdapter,
} from '../collections/types.js';

const mkConfig = () => createRuntimeConfigStore(runtimeDefaults());

let db: Database.Database;
let registry: GateRegistry;
let auditLog: AuditLogStore;
let collectionRegistry: CollectionRegistry;
let cascade: EvictionCascade;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_vault (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS account_store (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_store (key TEXT PRIMARY KEY, value_inline TEXT, blob_hash TEXT, size_bytes INTEGER NOT NULL, author_id TEXT NOT NULL, recipe_id TEXT, written_at INTEGER NOT NULL, last_read_at INTEGER);
    CREATE TABLE IF NOT EXISTS cache_entries (key TEXT PRIMARY KEY, inline_value TEXT, blob_hash TEXT, expires_at INTEGER NOT NULL, recipe_id TEXT NOT NULL, ingredient_slug TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL, category TEXT, risk_tier TEXT);
    CREATE TABLE IF NOT EXISTS schedules (schedule_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, data TEXT NOT NULL);
  `);
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
  collectionRegistry = createCollectionRegistry();
  cascade = createEvictionCascade({
    registry,
    state: createPressureStateStore(db),
    auditLog,
    collectionRegistry,
    config: () => DEFAULT_CASCADE_CONFIG,
  });
});

afterEach(() => {
  cascade.close();
  db.close();
});

// ────────────────────────────────────────────────────────────────
// Stub collection
// ────────────────────────────────────────────────────────────────

interface StubOverrides {
  runRetention?: () => Promise<CollectionPruneResult>;
}

const stubCollection = (
  platform: CollectionPlatform,
  slug: string,
  overrides: StubOverrides = {},
): Collection => {
  const sync: CollectionSyncAdapter = { start: async () => {}, stop: async () => {} };
  const health: CollectionHealth = {
    platform, slug,
    last_indexed_at: 0, pending_queue_size: 0, error_count_24h: 0,
    state: 'idle',
  };
  return {
    platform, slug,
    gate: {} as StorageGate,
    sync,
    upsert: () => {},
    delete: () => true,
    get: () => null,
    list: () => [] as CollectionRecord[],
    search: () => [] as CollectionSearchMatch[],
    health: () => health,
    runRetention: overrides.runRetention ?? (async () => ({
      pruned_count: 0, bytes_freed: 0, blob_hashes_freed: [], duration_ms: 0,
    })),
    close: async () => {},
  };
};

// ────────────────────────────────────────────────────────────────
// GateRegistry dynamic surfaces
// ────────────────────────────────────────────────────────────────

describe('GateRegistry — dynamic gates', () => {
  it('register creates a gate and primes initialUsage', () => {
    const gate = registry.register('collection:mail:work', {
      quota: 1000, reservePct: 1, initialUsage: 400,
    });
    expect(gate.info().surface).toBe('collection:mail:work');
    expect(gate.info().used).toBe(400);
    expect(gate.info().quota).toBe(1000);
    expect(registry.get('collection:mail:work')).toBe(gate);
  });

  it('all() includes static + dynamic gates in order', () => {
    registry.register('collection:mail:work', { quota: 100, reservePct: 1, initialUsage: 0 });
    registry.register('collection:file:downloads', { quota: 100, reservePct: 1, initialUsage: 0 });
    const names = registry.all().map((g) => g.info().surface);
    // Static surfaces come first, in the GATED_SURFACES order.
    expect(names.slice(0, 6)).toEqual([
      'vault', 'account_store', 'shared_store', 'cache', 'audit', 'schedules',
    ]);
    expect(names.slice(6)).toEqual([
      'collection:mail:work', 'collection:file:downloads',
    ]);
  });

  it('rejects duplicate registration', () => {
    registry.register('collection:mail:work', { quota: 100, reservePct: 1, initialUsage: 0 });
    expect(() =>
      registry.register('collection:mail:work', { quota: 100, reservePct: 1, initialUsage: 0 }),
    ).toThrow(/duplicate surface name/);
  });

  it('rejects collision with a static surface', () => {
    expect(() =>
      registry.register('vault', { quota: 100, reservePct: 1, initialUsage: 0 }),
    ).toThrow(/duplicate surface name/);
  });

  it('unregister removes dynamic gates only', () => {
    registry.register('collection:mail:work', { quota: 100, reservePct: 1, initialUsage: 0 });
    expect(registry.unregister('collection:mail:work')).toBe(true);
    expect(registry.get('collection:mail:work')).toBeUndefined();
    // Second unregister is a no-op on the same name.
    expect(registry.unregister('collection:mail:work')).toBe(false);
    // Static surfaces can't be unregistered.
    expect(registry.unregister('vault')).toBe(false);
    expect(registry.get('vault')).toBeDefined();
  });

  it('onGateRegistered fires once per register call', () => {
    const seen: string[] = [];
    const unsub = registry.onGateRegistered((_gate, name) => { seen.push(name); });
    registry.register('collection:mail:work', { quota: 100, reservePct: 1, initialUsage: 0 });
    registry.register('collection:file:downloads', { quota: 100, reservePct: 1, initialUsage: 0 });
    unsub();
    registry.register('collection:webhook:github', { quota: 100, reservePct: 1, initialUsage: 0 });
    expect(seen).toEqual(['collection:mail:work', 'collection:file:downloads']);
  });
});

// ────────────────────────────────────────────────────────────────
// Eviction cascade — collection surfaces
// ────────────────────────────────────────────────────────────────

describe('EvictionCascade — collection:file:*', () => {
  it('returns not_evictable for file collections', async () => {
    registry.register('collection:file:downloads', {
      quota: 100, reservePct: 1, initialUsage: 50,
    });
    collectionRegistry.register(stubCollection('file', 'downloads'));
    const res = await cascade.reclaim('collection:file:downloads');
    expect(res.ran).toBe(false);
    expect(res.reason_if_skipped).toBe('not_evictable');
  });
});

describe('EvictionCascade — collection:mail:* / collection:webhook:*', () => {
  it('runs runRetention on a mail collection surface', async () => {
    const gate = registry.register('collection:mail:work', {
      quota: 1000, reservePct: 1, initialUsage: 800,
    });
    let retentionCalls = 0;
    collectionRegistry.register(stubCollection('mail', 'work', {
      runRetention: async () => {
        retentionCalls++;
        // Mimic the retention actually freeing bytes by syncing the gate.
        gate.subUsed(600);
        return {
          pruned_count: 3,
          bytes_freed: 600,
          blob_hashes_freed: [],
          duration_ms: 5,
        };
      },
    }));
    const res = await cascade.reclaim('collection:mail:work');
    expect(retentionCalls).toBe(1);
    expect(res.ran).toBe(true);
    expect(res.steps_run).toContain('collection_retention');
    expect(res.bytes_freed).toBe(600);
  });

  it('eagerly deletes freed CAS blobs when a blob store is wired', async () => {
    const deleted: string[] = [];
    const blobs = {
      put: async () => 'h',
      get: async () => null,
      has: async () => false,
      delete: async (hash: string) => { deleted.push(hash); },
      sizeOf: async () => 0,
      sweepOrphans: async () => 0,
      totalBytes: async () => 0,
      root: '/tmp',
    };
    const localCascade = createEvictionCascade({
      registry,
      state: createPressureStateStore(db),
      auditLog,
      collectionRegistry,
      // Collection bodies live in the encrypted cache_blobs root, so the eager
      // retention delete now targets `cacheBlobs` (blob-encryption Phase 1).
      cacheBlobs: blobs,
      config: () => DEFAULT_CASCADE_CONFIG,
    });
    try {
      registry.register('collection:webhook:github', {
        quota: 1000, reservePct: 1, initialUsage: 500,
      });
      collectionRegistry.register(stubCollection('webhook', 'github', {
        runRetention: async () => ({
          pruned_count: 2,
          bytes_freed: 200,
          blob_hashes_freed: ['h1', 'h2'],
          duration_ms: 3,
        }),
      }));
      const res = await localCascade.reclaim('collection:webhook:github');
      expect(res.steps_run).toContain('collection_retention');
      expect(res.steps_run).toContain('collection_cas_delete');
      expect(deleted).toEqual(['h1', 'h2']);
    } finally {
      localCascade.close();
    }
  });

  it('skipped_reason=retention_disabled suppresses the collection_retention step name', async () => {
    registry.register('collection:mail:dormant', {
      quota: 1000, reservePct: 1, initialUsage: 900,
    });
    collectionRegistry.register(stubCollection('mail', 'dormant', {
      runRetention: async () => ({
        pruned_count: 0,
        bytes_freed: 0,
        blob_hashes_freed: [],
        duration_ms: 1,
        skipped_reason: 'retention_disabled',
      }),
    }));
    const res = await cascade.reclaim('collection:mail:dormant');
    // Ran the pipeline, but the step was a no-op — so the step name
    // doesn't appear. Useful signal for the heartbeat envelope.
    expect(res.ran).toBe(true);
    expect(res.steps_run).not.toContain('collection_retention');
  });

  it('returns no_such_surface when the gate is unregistered', async () => {
    const res = await cascade.reclaim('collection:mail:never_registered');
    expect(res.ran).toBe(false);
    expect(res.reason_if_skipped).toBe('no_such_surface');
  });

  it('returns not_evictable when the surface name is malformed', async () => {
    registry.register('collection:junk', { quota: 100, reservePct: 1, initialUsage: 0 });
    const res = await cascade.reclaim('collection:junk');
    expect(res.ran).toBe(false);
    expect(res.reason_if_skipped).toBe('not_evictable');
  });
});

describe('EvictionCascade — late-registered gates', () => {
  // MIN_RESERVE_BYTES in @recued/storage-gate clamps the reserve floor
  // at 10 MB; tests that exercise state transitions must use quotas
  // comfortably above that floor so the gate's pressureAt/blockedAt
  // thresholds are meaningful.
  const BIG_QUOTA = 100 * 1024 * 1024; // 100 MB
  const AT_PRESSURE = 85 * 1024 * 1024; // 85 MB — above 72 MB pressureAt, below blockedAt.

  it('state-change on a post-creation gate drives the cascade', async () => {
    // The cascade subscribes to `onGateRegistered` at construction;
    // gates added after bin.ts creates the cascade must still wire
    // up correctly or pressure events would be missed.
    const gate = registry.register('collection:mail:work', {
      quota: BIG_QUOTA, reservePct: 10, initialUsage: 0,
    });
    let ran = 0;
    collectionRegistry.register(stubCollection('mail', 'work', {
      runRetention: async () => {
        ran++;
        gate.subUsed(AT_PRESSURE);
        return { pruned_count: 1, bytes_freed: AT_PRESSURE, blob_hashes_freed: [], duration_ms: 1 };
      },
    }));

    // Hook an independent listener to verify the state-change actually
    // fires on the newly-registered gate — proving the cascade's own
    // onGateRegistered-driven subscription covers the same event.
    const stateChanges: string[] = [];
    gate.onStateChange((ev) => { stateChanges.push(`${ev.previous}->${ev.next}`); });
    gate.setUsed(AT_PRESSURE);
    expect(stateChanges).toContain('running->pressure_managed');

    // The cascade's fire-and-forget reclaim runs the async pipeline.
    // Drain the microtask queue until the stub's runRetention lands.
    for (let i = 0; ran === 0 && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(ran).toBeGreaterThanOrEqual(1);
  });

  it('manual reclaim works on a late-registered gate', async () => {
    // Sanity complement to the state-change path — the direct rpc
    // call (`server.runPressureReclaim` → `cascade.reclaim`) must
    // also resolve the newly-registered surface without a restart.
    registry.register('collection:webhook:github', {
      quota: BIG_QUOTA, reservePct: 10, initialUsage: 0,
    });
    collectionRegistry.register(stubCollection('webhook', 'github', {
      runRetention: async () => ({
        pruned_count: 1, bytes_freed: 100, blob_hashes_freed: [], duration_ms: 1,
      }),
    }));
    const result = await cascade.reclaim('collection:webhook:github');
    expect(result.ran).toBe(true);
    expect(result.steps_run).toContain('collection_retention');
  });
});
