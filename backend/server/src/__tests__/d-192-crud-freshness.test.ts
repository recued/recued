/** D-192 CRUD read freshness integration over the real store, resolver,
 *  sync-state store, and CRUD handlers. */

import Database from 'better-sqlite3';
import {
  RECUED_BUILTIN_SOURCE_ID,
  type SourceRegistration,
} from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  createWorkEntitySourceSyncStateStore,
  ensureWorkEntitySourceSyncStateSchema,
  type WorkEntitySourceSyncState,
  type WorkEntitySourceSyncStateStore,
} from '../storage/work-entity-source-mirror.js';
import { handleWorkEntityGet, handleWorkEntityList, type WorkEntityCrudRpcDeps } from '../work-entity-crud-handler.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const NOW = 1_700_000_000_000;
const BUILTIN_TASK_SOURCE = RECUED_BUILTIN_SOURCE_ID('task');

let db: Database.Database;
let store: WorkEntityStore;
let syncState: WorkEntitySourceSyncStateStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  ensureWorkEntitySourceSyncStateSchema(db);
  store = createWorkEntityStore(db);
  syncState = createWorkEntitySourceSyncStateStore(db);
});

afterEach(() => {
  db.close();
});

const registerTaskSource = (
  id: string,
  source_kind: SourceRegistration['source_kind'],
  overrides: Partial<SourceRegistration> = {},
): SourceRegistration =>
  store.registerSource({
    id,
    top_tier_kind: 'task',
    source_kind,
    source_label: id,
    write_capable: source_kind === 'builtin',
    registered_at: NOW,
    ...overrides,
  });

const seedSyncState = (
  source_id: string,
  overrides: Partial<WorkEntitySourceSyncState> = {},
): void => {
  syncState.upsert({
    source_id,
    contract_hash: 'hash',
    sync_depth: 'meta',
    sync_mode: 'read_only',
    cursor_blob: null,
    last_sync_started_at: NOW - 2_000,
    last_sync_completed_at: NOW - 1_000,
    last_success_at: NOW - 100,
    last_error_code: null,
    last_error_message: null,
    degraded: false,
    field_health_blob: null,
    list_complete: true,
    stale_after_ms: 1_000,
    ...overrides,
  });
};

const seedTask = (id: string, source_id: string): void => {
  store.writeTask({
    id,
    title: id,
    done: false,
    source_id,
    ...(source_id === BUILTIN_TASK_SOURCE
      ? {}
      : { source_record_id: `remote-${id}`, connection_id: 'acme' }),
  }, NOW);
};

const deps = (withSyncState = true): WorkEntityCrudRpcDeps => {
  const resolver = createWorkEntityResolver(
    store,
    withSyncState ? { syncState, now: () => NOW } : {},
  );
  const bus = createWarehouseEventBus();
  const dispatchers = createWorkEntityDispatchers({
    store,
    resolver,
    bus,
    now: () => NOW,
  });
  return { store, resolver, dispatchers };
};

describe('D-192 work_entity CRUD freshness metadata', () => {
  it('carries source_freshness on list responses and marks builtin sources local', async () => {
    registerTaskSource(BUILTIN_TASK_SOURCE, 'builtin', {
      source_label: 'Recued built-in',
    });
    seedTask('builtin-task', BUILTIN_TASK_SOURCE);

    const out = await handleWorkEntityList(deps(), { kind: 'task' });

    expect(out.entities.map((entity) => entity.id)).toEqual(['builtin-task']);
    expect(out.source_freshness).toEqual([
      { source_id: BUILTIN_TASK_SOURCE, state: 'local' },
    ]);
  });

  it('reports fresh, stale, and degraded connection sources from seeded sync-state rows', async () => {
    const fresh = 'hubspot.acme.fresh-task';
    const stale = 'hubspot.acme.stale-task';
    const degraded = 'hubspot.acme.degraded-task';
    for (const id of [fresh, stale, degraded]) {
      registerTaskSource(id, 'connection');
      seedTask(`${id}-row`, id);
    }
    seedSyncState(fresh, { last_success_at: NOW - 100, stale_after_ms: 1_000 });
    seedSyncState(stale, { last_success_at: NOW - 1_001, stale_after_ms: 1_000 });
    seedSyncState(degraded, {
      degraded: true,
      last_success_at: NOW - 100,
      last_error_code: 'fetch_error',
      last_error_message: 'gateway timeout',
      stale_after_ms: 10_000,
    });

    const out = await handleWorkEntityList(deps(), { kind: 'task' });
    const bySource = new Map(
      out.source_freshness?.map((row) => [row.source_id, row]),
    );

    expect(bySource.get(fresh)).toEqual({
      source_id: fresh,
      state: 'fresh',
      last_success_at: NOW - 100,
      stale_after_ms: 1_000,
    });
    expect(bySource.get(stale)).toEqual({
      source_id: stale,
      state: 'stale',
      last_success_at: NOW - 1_001,
      stale_after_ms: 1_000,
    });
    expect(bySource.get(degraded)).toEqual({
      source_id: degraded,
      state: 'degraded',
      last_success_at: NOW - 100,
      stale_after_ms: 10_000,
      last_error_code: 'fetch_error',
    });
  });

  it('omits source_freshness from list responses when the resolver has no sync-state dependency', async () => {
    registerTaskSource(BUILTIN_TASK_SOURCE, 'builtin');
    seedTask('builtin-task', BUILTIN_TASK_SOURCE);

    const out = await handleWorkEntityList(deps(false), { kind: 'task' });

    expect('source_freshness' in out).toBe(false);
  });



  it('returns a null entity without source_freshness for a missing get row', async () => {
    registerTaskSource(BUILTIN_TASK_SOURCE, 'builtin');

    const out = await handleWorkEntityGet(deps(), {
      kind: 'task',
      id: 'missing',
    });

    expect(out).toEqual({ entity: null });
    expect('source_freshness' in out).toBe(false);
  });
});
