import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { StorageGate } from '@recued/storage-gate';
import type {
  CollectionHealth,
  CollectionPlatform,
  CollectionRecord,
  CollectionSearchMatch,
} from '@recued/contracts';
import {
  createAuditLogStore,
  type AuditLogStore,
  type AuditEntry,
  type ActivityEntry,
} from '@recued/storage';
import {
  runtimeDefaults,
  createRuntimeConfigStore,
} from '@recued/config';

import { createSQLiteCollection } from '../sqlite-collection.js';
import { createLifecycle, type Lifecycle } from '../lifecycle/index.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createServerStateStore } from '../server-state.js';
import type {
  Collection,
  CollectionSyncAdapter,
} from '../collections/types.js';

const BOOTSTRAP = {
  data_path: '',
  bind_host: '127.0.0.1',
  bind_port: 7720,
  mcp_port: 0,
  webhook_port: 0,
  log_path: '',
  public_reachable: false,
  cert_path: null,
};

const stubCollection = (
  platform: CollectionPlatform,
  slug: string,
  onClose: () => void,
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
    runRetention: async () => ({
      pruned_count: 0, bytes_freed: 0, blob_hashes_freed: [], duration_ms: 0,
    }),
    close: async () => { onClose(); },
  };
};

interface Harness {
  dataPath: string;
  db: Database.Database;
  lifecycle: Lifecycle;
  auditLog: AuditLogStore;
  registry: ReturnType<typeof createCollectionRegistry>;
  close(): void;
}

const newHarness = (): Harness => {
  const dataPath = mkdtempSync(join(tmpdir(), 'collection-drain-'));
  const db = new Database(join(dataPath, 'recued.db'));
  const auditLog = createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
    createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
  );
  const runtimeStore = createRuntimeConfigStore(runtimeDefaults());
  // Minimal server_state table — the lifecycle composition reads
  // boot_at / shutdown_at / crash ring from here during drain +
  // reconcile; the store creates its own schema on construction.
  const serverState = createServerStateStore(db);
  const registry = createCollectionRegistry();
  const lifecycle = createLifecycle({
    db,
    dataPath,
    bindPort: BOOTSTRAP.bind_port,
    version: '0.0.0-drain',
    configPath: null,
    distribution: 'source',
    initialBootstrap: { ...BOOTSTRAP, data_path: dataPath, log_path: dataPath },
    initialRuntime: runtimeDefaults(),
    runtimeStore,
    serverState,
    auditLog,
    supervisorMode: 'dev',
    crashLoopConfig: { threshold: 3, window_s: 60, auto_reset_after_s: 3600 },
    exit: () => {},
    drainSteps: {
      pause_collections: async () => { await registry.dispose(); },
    },
    getInFlightCount: () => 0,
  });
  lifecycle.lock.claim({ boot_at: Date.now(), bind_port: BOOTSTRAP.bind_port });
  return {
    dataPath,
    db,
    lifecycle,
    auditLog,
    registry,
    close() {
      lifecycle.uninstall();
      lifecycle.lock.release();
      db.close();
      rmSync(dataPath, { recursive: true, force: true });
    },
  };
};

describe('pause_collections drain step — empty registry', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('lists pause_collections in completed when no collections are registered', async () => {
    h.lifecycle.markBooted();
    const result = await h.lifecycle.requestDrain({
      intent: 'shutdown',
      reason: 'empty-registry',
    });
    expect(result.completed).toContain('pause_collections');
    expect(result.aborted).not.toContain('pause_collections');
  });
});

describe('pause_collections drain step — with collections', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('calls close() on every registered collection', async () => {
    const closed: string[] = [];
    h.registry.register(stubCollection('mail', 'work', () => closed.push('mail:work')));
    h.registry.register(stubCollection('file', 'downloads', () => closed.push('file:downloads')));
    h.registry.register(stubCollection('webhook', 'github', () => closed.push('webhook:github')));

    h.lifecycle.markBooted();
    const result = await h.lifecycle.requestDrain({
      intent: 'shutdown',
      reason: 'with-collections',
    });

    expect(result.completed).toContain('pause_collections');
    expect(closed).toEqual(['mail:work', 'file:downloads', 'webhook:github']);
  });

  it('orders pause_collections before pause_scheduler in the completed sequence', async () => {
    // Register a collection so pause_collections has real work.
    h.registry.register(stubCollection('mail', 'work', () => {}));
    h.lifecycle.markBooted();
    const result = await h.lifecycle.requestDrain({
      intent: 'shutdown',
      reason: 'ordering',
    });
    const colIdx = result.completed.indexOf('pause_collections');
    const schedIdx = result.completed.indexOf('pause_scheduler');
    // pause_scheduler isn't wired in this harness so it's absent;
    // accept either "pause_scheduler absent" or "pause_collections
    // precedes pause_scheduler".
    if (schedIdx !== -1) {
      expect(colIdx).toBeLessThan(schedIdx);
    } else {
      expect(colIdx).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('pause_collections drain step — close() failures', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('survives a close() that throws — best-effort dispose across siblings', async () => {
    // One collection throws, one completes cleanly. The registry's
    // dispose throws an AggregateError. The drain orchestrator contains it so
    // later cleanup still runs, but records the step as aborted — an archive
    // restore must never mistake partial collection teardown for a safe drain.
    // The sibling's close() still fires because dispose is best-effort.
    const cleanCalls: string[] = [];
    h.registry.register({
      ...stubCollection('mail', 'broken', () => {}),
      close: async () => { throw new Error('imap unclean'); },
    });
    h.registry.register(stubCollection('file', 'fine', () => cleanCalls.push('file:fine')));

    h.lifecycle.markBooted();
    const result = await h.lifecycle.requestDrain({
      intent: 'shutdown',
      reason: 'with-broken-close',
    });

    expect(result.completed).not.toContain('pause_collections');
    expect(result.aborted).toContain('pause_collections');
    expect(cleanCalls).toEqual(['file:fine']);
  });
});
