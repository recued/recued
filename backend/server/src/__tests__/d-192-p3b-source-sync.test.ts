/** D-192 P3b - runner and boot coverage for declared work-entity Source sync over a scripted fetch seam, real SQLite mirror writes, sync-state health, and boot-time sync-state seeding/deletion. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectionOperationProfile, IngredientManifest, Task } from '@recued/contracts';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionStore, type ConnectionStoreSqlite } from '../storage/connection-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  createWorkEntitySourceMirrorStore,
  createWorkEntitySourceSyncStateStore,
  ensureWorkEntitySourceSyncStateSchema,
  type WorkEntitySourceMirrorStore,
  type WorkEntitySourceSyncStateStore,
} from '../storage/work-entity-source-mirror.js';
import {
  type SourceMirrorFetchDeps,
  type SourceMirrorFetchOutcome,
  type SourceMirrorFetchRequest,
} from '../source-mirror/fetch.js';
import {
  KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS,
  wireWorkEntitySourceBoot,
  workEntitySourceContractHash,
  type KernelWorkEntitySourceDeclaration,
} from '../work-entity-source-boot.js';
import {
  describeStalenessSignal,
  stalenessSignal,
  type WorkEntitySourceFieldHealth,
} from '../work-entity-source-field-health.js';
import {
  runWorkEntitySourceSync,
  type RunSourceMirrorFetchFn,
} from '../work-entity-source-sync.js';

const NOW = 1_700_000_000_000;
const CONNECTION = 'acme';
const SOURCE = 'hubspot.acme.task';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let mirror: WorkEntitySourceMirrorStore;
let syncState: WorkEntitySourceSyncStateStore;
let connectionStore: ConnectionStoreSqlite;
let nowMs: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-p3b-'));
  db = new Database(join(dir, 'test.db'));
  ensureWorkEntitySchema(db);
  ensureWorkEntitySourceSyncStateSchema(db);
  store = createWorkEntityStore(db);
  mirror = createWorkEntitySourceMirrorStore(db, store);
  syncState = createWorkEntitySourceSyncStateStore(db);
  connectionStore = createConnectionStore(db);
  nowMs = NOW;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const taskDeclaration = (
  overrides: Partial<KernelWorkEntitySourceDeclaration> = {},
): KernelWorkEntitySourceDeclaration => ({
  kind: 'task',
  source_id_template: 'hubspot.${connection_id}.task',
  source_label_template: 'HubSpot tasks (${connection_name})',
  source_kind: 'connection',
  remote: {
    entity: 'task',
    id: 'id',
    version: { kind: 'updated_at', field: 'updatedAt' },
    hash_fields: ['title', 'done', 'label', 'updatedAt'],
  },
  ops: { list: 'task.list' },
  sync: {
    mode: 'read_write',
    depth: 'meta',
    tombstones: 'native',
    tombstone_field: 'archived',
    stale_after_ms: 21_600_000,
  },
  read_resolution: {
    default: 'local_rich_meta',
    remote_when: ['field_missing', 'source_stale'],
    wild_query: {
      remote_fanout: 'bounded_targeted',
      max_sources: 3,
      max_remote_records: 10,
      on_exceeds_cap: 'ask_to_narrow',
    },
  },
  projection: {
    canonical: { title: 'title', done: 'done' },
    extension: { label: 'label' },
  },
  writable_fields: ['title'],
  write_policy: {
    conditional_write: 'none',
    stale_write: 'manual_merge',
    field_conflicts: 'manual_merge',
  },
  ...overrides,
});

const missingMeansDeletedDeclaration = (): KernelWorkEntitySourceDeclaration =>
  taskDeclaration({
    sync: {
      mode: 'read_write',
      depth: 'meta',
      tombstones: 'missing_means_deleted',
      list_scope: 'complete_authoritative',
      stale_after_ms: 21_600_000,
    },
  });

const manifestFake = {
  slug: 'cat',
  operations: { 'task.list': { result_path: 'records' } },
  surfaces: { api: { result_path: 'records' } },
} as unknown as IngredientManifest;

const profile: ConnectionOperationProfile = {
  allowed_operations: ['task.list'],
  catalog_slug: 'cat',
};

const fetchDeps = (
  opts: {
    manifest?: IngredientManifest | null;
    profile?: ConnectionOperationProfile | null;
  } = {},
): SourceMirrorFetchDeps => ({
  executorConfig: {
    manifests: {
      get: (slug: string) => (slug === 'cat' ? opts.manifest ?? manifestFake : null),
    },
  },
  profiles: {
    get: () => (opts.profile === undefined ? profile : opts.profile),
  },
} as unknown as SourceMirrorFetchDeps);

const okFetch = (
  records: ReadonlyArray<Record<string, unknown>>,
  options: { complete?: boolean; skipped_no_id?: number } = {},
): SourceMirrorFetchOutcome => {
  const keyed: Array<[string, Record<string, unknown>]> = [];
  for (const record of records) {
    const id = record.id;
    if (typeof id !== 'string') throw new Error('test record requires a string id');
    keyed.push([id, record]);
  }
  return {
    ok: true,
    records: new Map(keyed),
    truncated: false,
    complete: options.complete ?? true,
    skipped_no_id: options.skipped_no_id ?? 0,
  };
};

const errorFetch = (
  kind: 'config' | 'policy' | 'error' | 'unavailable',
  reason: string,
): SourceMirrorFetchOutcome => ({ ok: false, kind, reason });

const scriptedFetch = (
  ...outcomes: SourceMirrorFetchOutcome[]
): { runFetch: RunSourceMirrorFetchFn; requests: SourceMirrorFetchRequest[] } => {
  const queue = [...outcomes];
  const requests: SourceMirrorFetchRequest[] = [];
  const runFetch: RunSourceMirrorFetchFn = async (_deps, request) => {
    requests.push(request);
    return queue.shift() ?? errorFetch('error', 'no scripted fetch outcome');
  };
  return { runFetch, requests };
};

const rawTask = (
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  title,
  done: false,
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...extra,
});

const registerTaskSource = (source_id: string): void => {
  if (store.getSource(source_id) !== null) return;
  store.registerSource({
    id: source_id,
    top_tier_kind: 'task',
    source_kind: 'connection',
    source_label: source_id,
    write_capable: false,
    mcp_exposed: false,
    registered_at: NOW,
  });
};

const seedSyncState = (
  source_id: string,
  declaration: KernelWorkEntitySourceDeclaration,
): void => {
  syncState.upsert({
    source_id,
    contract_hash: workEntitySourceContractHash(declaration),
    sync_depth: declaration.sync.depth,
    sync_mode: declaration.sync.mode,
    cursor_blob: null,
    last_sync_started_at: null,
    last_sync_completed_at: null,
    last_success_at: null,
    last_error_code: null,
    last_error_message: null,
    degraded: false,
    field_health_blob: null,
    list_complete: true,
    stale_after_ms: declaration.sync.stale_after_ms,
  });
};

const prepareSource = (
  source_id: string,
  declaration: KernelWorkEntitySourceDeclaration,
): void => {
  registerTaskSource(source_id);
  seedSyncState(source_id, declaration);
};

const runSync = async (
  declaration: KernelWorkEntitySourceDeclaration,
  script: { runFetch: RunSourceMirrorFetchFn },
  source_id = SOURCE,
  deps: SourceMirrorFetchDeps = fetchDeps(),
) =>
  runWorkEntitySourceSync({
    fetchDeps: deps,
    mirror,
    syncState,
    now: () => nowMs,
    runFetch: script.runFetch,
  }, {
    source_id,
    connection_name: CONNECTION,
    declaration,
  });

const expectSyncOk = (
  result: Awaited<ReturnType<typeof runWorkEntitySourceSync>>,
): Extract<Awaited<ReturnType<typeof runWorkEntitySourceSync>>, { ok: true }> => {
  if (!result.ok) throw new Error(`expected sync success, got ${result.kind}: ${result.reason}`);
  return result;
};

const expectSyncFailure = (
  result: Awaited<ReturnType<typeof runWorkEntitySourceSync>>,
): Extract<Awaited<ReturnType<typeof runWorkEntitySourceSync>>, { ok: false }> => {
  if (result.ok) throw new Error('expected sync failure');
  return result;
};

const taskByRemoteId = (
  source_id: string,
  remoteId: string,
  include_deleted = false,
): Task | null => {
  if (include_deleted) {
    const row = mirror.getBySourceIdentity('task', source_id, remoteId);
    return row !== null && 'done' in row ? row : null;
  }
  return store.listTasks({ source_id }).find((t) => t.source_record_id === remoteId) ?? null;
};

const upsertHubspotConnection = (): void => {
  connectionStore.upsert({
    kind: 'api',
    name: CONNECTION,
    display_name: 'HubSpot Acme',
    config_json: JSON.stringify({ vendor: 'hubspot' }),
    auth_ciphertext: 'ciphertext',
    enrolled_at: NOW,
    updated_at: NOW,
  });
};

describe('runWorkEntitySourceSync', () => {
  it('upserts fetched rows, records a healthy sync-state, and passes the raw fetch request shape', async () => {
    const declaration = taskDeclaration();
    prepareSource(SOURCE, declaration);
    const script = scriptedFetch(okFetch([
      rawTask('r1', 'One', { label: 'alpha' }),
      rawTask('r2', 'Two', { label: 'beta' }),
    ]));

    nowMs = NOW + 10;
    const result = expectSyncOk(await runSync(declaration, script));

    expect(result).toMatchObject({
      upserted: 2,
      unchanged: 0,
      tombstoned: 0,
      deleted: 0,
      failed_rows: 0,
      complete: true,
    });
    const rows = store.listTasks({ source_id: SOURCE });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.connection_id).toBe(CONNECTION);
      expect(row.source_record_hash).toMatch(/^fnv1a:/);
      expect(row.source_record_id === 'r1' || row.source_record_id === 'r2').toBe(true);
    }
    expect(syncState.get(SOURCE)).toMatchObject({
      last_success_at: NOW + 10,
      degraded: false,
      last_error_code: null,
      last_error_message: null,
    });
    expect(script.requests).toHaveLength(1);
    expect(script.requests[0]).toMatchObject({
      operationKey: 'task.list',
      args: {},
      resultPath: 'records',
      projectionTemplate: null,
      idField: 'id',
      stepId: 'source_sync',
    });
  });

  it('hash-skips identical records on a second run without touching row updated_at', async () => {
    const declaration = taskDeclaration();
    prepareSource(SOURCE, declaration);
    const records = [
      rawTask('r1', 'One', { label: 'alpha' }),
      rawTask('r2', 'Two', { label: 'beta' }),
    ];
    nowMs = NOW + 10;
    expectSyncOk(await runSync(declaration, scriptedFetch(okFetch(records))));
    const firstR1 = taskByRemoteId(SOURCE, 'r1');
    const firstR2 = taskByRemoteId(SOURCE, 'r2');
    if (firstR1 === null || firstR2 === null) throw new Error('seed rows missing');

    nowMs = NOW + 100;
    const second = expectSyncOk(await runSync(declaration, scriptedFetch(okFetch(records))));

    expect(second.upserted).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(taskByRemoteId(SOURCE, 'r1')?.updated_at).toBe(firstR1.updated_at);
    expect(taskByRemoteId(SOURCE, 'r2')?.updated_at).toBe(firstR2.updated_at);
  });

  it('applies native tombstones idempotently after a prior live sync', async () => {
    const declaration = taskDeclaration();
    prepareSource(SOURCE, declaration);
    nowMs = NOW + 10;
    expectSyncOk(await runSync(declaration, scriptedFetch(okFetch([rawTask('r1', 'One')]))));
    const row = taskByRemoteId(SOURCE, 'r1');
    if (row === null) throw new Error('seed row missing');

    nowMs = NOW + 20;
    const tombstone = expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([{ id: 'r1', archived: true }])),
    ));
    expect(tombstone.tombstoned).toBe(1);
    expect(store.readTask(row.id)?.deleted_at).toBe(NOW + 20);
    expect(mirror.listSnapshotHashes('task', SOURCE).has('r1')).toBe(false);

    nowMs = NOW + 30;
    const repeat = expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([{ id: 'r1', archived: true }])),
    ));
    expect(repeat.tombstoned).toBe(0);
    expect(store.readTask(row.id)?.deleted_at).toBe(NOW + 20);
  });

  it('resurrects a tombstoned Source row under the same local id when the remote row returns live', async () => {
    const declaration = taskDeclaration();
    prepareSource(SOURCE, declaration);
    nowMs = NOW + 10;
    expectSyncOk(await runSync(declaration, scriptedFetch(okFetch([rawTask('r1', 'One')]))));
    const original = taskByRemoteId(SOURCE, 'r1');
    if (original === null) throw new Error('seed row missing');

    nowMs = NOW + 20;
    expectSyncOk(await runSync(declaration, scriptedFetch(okFetch([{ id: 'r1', archived: true }]))));
    expect(store.listTasks({ source_id: SOURCE })).toHaveLength(0);

    nowMs = NOW + 30;
    expectSyncOk(await runSync(declaration, scriptedFetch(okFetch([rawTask('r1', 'One again')]))));
    const resurrected = taskByRemoteId(SOURCE, 'r1');
    expect(resurrected?.id).toBe(original.id);
    expect(resurrected?.title).toBe('One again');
    expect(resurrected?.deleted_at).toBeUndefined();
    expect(store.listTasks({ source_id: SOURCE })).toHaveLength(1);
  });

  it('deletes missing prior rows only on a complete authoritative missing-means-deleted walk', async () => {
    const declaration = missingMeansDeletedDeclaration();
    prepareSource(SOURCE, declaration);
    nowMs = NOW + 10;
    expectSyncOk(await runSync(declaration, scriptedFetch(okFetch([
      rawTask('r1', 'One'),
      rawTask('r2', 'Two'),
    ]))));

    nowMs = NOW + 20;
    const result = expectSyncOk(await runSync(
      declaration,
      scriptedFetch(okFetch([rawTask('r1', 'One')])),
    ));

    expect(result.deleted).toBe(1);
    expect(taskByRemoteId(SOURCE, 'r1')).not.toBeNull();
    expect(taskByRemoteId(SOURCE, 'r2')).toBeNull();
    expect(taskByRemoteId(SOURCE, 'r2', true)?.deleted_at).toBe(NOW + 20);
  });

  it('fail-closes delete diffs for incomplete walks, unkeyed rows, and non-missing tombstone modes', async () => {
    const scenarios = [
      {
        source_id: 'hubspot.incomplete.task',
        declaration: missingMeansDeletedDeclaration(),
        outcome: okFetch([rawTask('r1', 'One')], { complete: false }),
        error_code: null,
      },
      {
        source_id: 'hubspot.unkeyed.task',
        declaration: missingMeansDeletedDeclaration(),
        outcome: okFetch([rawTask('r1', 'One')], { skipped_no_id: 1 }),
        error_code: 'rows_unkeyed',
      },
      {
        source_id: 'hubspot.native.task',
        declaration: taskDeclaration(),
        outcome: okFetch([rawTask('r1', 'One')]),
        error_code: null,
      },
    ] as const;

    for (const scenario of scenarios) {
      prepareSource(scenario.source_id, scenario.declaration);
      nowMs = NOW + 10;
      expectSyncOk(await runSync(
        scenario.declaration,
        scriptedFetch(okFetch([rawTask('r1', 'One'), rawTask('r2', 'Two')])),
        scenario.source_id,
      ));

      nowMs = NOW + 20;
      const result = expectSyncOk(await runSync(
        scenario.declaration,
        scriptedFetch(scenario.outcome),
        scenario.source_id,
      ));

      expect(result.deleted).toBe(0);
      expect(taskByRemoteId(scenario.source_id, 'r2')).not.toBeNull();
      if (scenario.error_code === null) {
        expect(syncState.get(scenario.source_id)?.degraded).toBe(false);
      } else {
        expect(syncState.get(scenario.source_id)).toMatchObject({
          degraded: true,
          last_error_code: scenario.error_code,
        });
      }
    }
  });

  it('keeps projection-failed rows out of the delete diff while degrading the source', async () => {
    const declaration = missingMeansDeletedDeclaration();
    prepareSource(SOURCE, declaration);
    nowMs = NOW + 10;
    expectSyncOk(await runSync(declaration, scriptedFetch(okFetch([
      rawTask('good', 'Good'),
      rawTask('bad', 'Initially valid'),
    ]))));

    nowMs = NOW + 20;
    const result = expectSyncOk(await runSync(declaration, scriptedFetch(okFetch([
      rawTask('good', 'Good changed'),
      { id: 'bad', done: false, updatedAt: '2026-07-01T00:00:00.000Z' },
    ]))));

    expect(result.upserted).toBe(1);
    expect(result.failed_rows).toBe(1);
    expect(result.deleted).toBe(0);
    expect(taskByRemoteId(SOURCE, 'good')?.title).toBe('Good changed');
    expect(taskByRemoteId(SOURCE, 'bad')).not.toBeNull();
    expect(syncState.get(SOURCE)).toMatchObject({
      degraded: true,
      last_error_code: 'projection_failed',
    });
  });

  it('records fetch failures as degraded without changing last_success_at', async () => {
    const declaration = taskDeclaration();
    prepareSource(SOURCE, declaration);
    syncState.markCompleted(SOURCE, { ok: true, cursor_blob: 'prev', now: NOW + 1 });

    nowMs = NOW + 20;
    const result = expectSyncFailure(await runSync(
      declaration,
      scriptedFetch(errorFetch('error', 'gateway down')),
    ));

    expect(result.kind).toBe('error');
    expect(syncState.get(SOURCE)).toMatchObject({
      last_success_at: NOW + 1,
      degraded: true,
      last_error_code: 'fetch_error',
      last_error_message: 'gateway down',
    });
  });

  it('records missing operation profiles as config failures without calling the fetch seam', async () => {
    const declaration = taskDeclaration();
    prepareSource(SOURCE, declaration);
    const script = scriptedFetch(okFetch([]));

    nowMs = NOW + 20;
    const result = expectSyncFailure(await runSync(
      declaration,
      script,
      SOURCE,
      fetchDeps({ profile: null }),
    ));

    expect(result.kind).toBe('config');
    expect(script.requests).toHaveLength(0);
    expect(syncState.get(SOURCE)).toMatchObject({
      degraded: true,
      last_error_code: 'config',
    });
  });
});

describe('wireWorkEntitySourceBoot sync-state seeding', () => {
  it('seeds the HubSpot task sync-state row from the kernel declaration', () => {
    upsertHubspotConnection();
    wireWorkEntitySourceBoot({
      connectionStore,
      store,
      syncState,
      now: () => NOW,
    });

    const expected = KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS.hubspot[0];
    expect(store.getSource(SOURCE)).not.toBeNull();
    expect(syncState.get(SOURCE)).toMatchObject({
      contract_hash: workEntitySourceContractHash(expected),
      sync_mode: 'read_write',
      stale_after_ms: 21_600_000,
    });
  });

  it('leaves an unchanged contract row untouched on re-boot', () => {
    upsertHubspotConnection();
    wireWorkEntitySourceBoot({ connectionStore, store, syncState, now: () => NOW });
    syncState.markCompleted(SOURCE, { ok: true, cursor_blob: 'cursor-x', now: NOW + 1 });

    wireWorkEntitySourceBoot({ connectionStore, store, syncState, now: () => NOW + 2 });

    expect(syncState.get(SOURCE)).toMatchObject({
      cursor_blob: 'cursor-x',
      last_success_at: NOW + 1,
    });
  });

  it('re-pins changed contract fields, clears cursor, and preserves health history', () => {
    upsertHubspotConnection();
    syncState.upsert({
      source_id: SOURCE,
      contract_hash: 'fnv1a:old',
      sync_depth: 'meta',
      sync_mode: 'read_only',
      cursor_blob: 'cursor-x',
      last_sync_started_at: NOW - 10,
      last_sync_completed_at: NOW - 5,
      last_success_at: NOW - 5,
      last_error_code: null,
      last_error_message: null,
      degraded: false,
      field_health_blob: null,
      list_complete: true,
      stale_after_ms: 1,
    });

    wireWorkEntitySourceBoot({ connectionStore, store, syncState, now: () => NOW });

    const expected = KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS.hubspot[0];
    expect(syncState.get(SOURCE)).toMatchObject({
      contract_hash: workEntitySourceContractHash(expected),
      sync_mode: 'read_write',
      stale_after_ms: 21_600_000,
      cursor_blob: null,
      last_success_at: NOW - 5,
    });
  });

  it('deletes the sync-state row when the connection Source is unregistered on connection delete', () => {
    upsertHubspotConnection();
    wireWorkEntitySourceBoot({ connectionStore, store, syncState, now: () => NOW });
    expect(syncState.get(SOURCE)).not.toBeNull();

    expect(connectionStore.delete('api', CONNECTION)).toBe(true);

    expect(store.getSource(SOURCE)).toBeNull();
    expect(syncState.get(SOURCE)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// D-192 — silent-staleness observability, wired END-TO-END.
//
// The unit tests for the signal live in `d-192-source-field-health.test.ts`.
// THESE prove the tally is actually plumbed into a real sync cycle — that it
// reads the live vendor rows, persists across cycles, and survives a degraded
// walk. Without this the detector would be self-testing dead code.
// ────────────────────────────────────────────────────────────────

describe('silent-staleness field-health tally (end-to-end through the sync cycle)', () => {
  const health = (source_id = SOURCE): WorkEntitySourceFieldHealth | null => {
    const blob = syncState.get(source_id)?.field_health_blob ?? null;
    return blob === null ? null : JSON.parse(blob) as WorkEntitySourceFieldHealth;
  };

  it('a real cycle records which declared paths carried a value', async () => {
    const declaration = taskDeclaration();
    prepareSource(SOURCE, declaration);
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `t${i}`, title: `Task ${i}`, done: false, label: 'L', updatedAt: '2026-07-14T00:00:00Z',
      archived: false,
    }));
    expectSyncOk(await runSync(declaration, { runFetch: async () => okFetch(rows) }));

    const h = health();
    expect(h?.rows_seen).toBe(25);
    expect(h?.paths.updatedAt).toEqual({ role: 'version', with_value: 25 });
    expect(h?.paths.title).toEqual({ role: 'hash', with_value: 25 });
    // `done: false` and `archived: false` are VALUES — presence, not truthiness.
    expect(h?.paths.done.with_value).toBe(25);
    expect(h?.paths.archived).toEqual({ role: 'tombstone', with_value: 25 });
    expect(stalenessSignal(h).never_valued).toEqual([]);
  });

  it('🔴 a cycle over a PHANTOM declaration raises the frozen-mirror alarm', async () => {
    // The declaration names hash paths the vendor never returns. Every row hashes
    // to the same constant ⇒ nothing is ever detected as changed ⇒ the mirror is
    // frozen. The cycle itself reports ok — which is precisely the problem, and
    // precisely why this signal has to exist.
    const declaration = taskDeclaration({
      remote: {
        entity: 'task',
        id: 'id',
        version: { kind: 'updated_at', field: 'fields.updated' }, // vendor sends `updatedAt`
        hash_fields: ['fields.title', 'fields.done'],             // vendor has no `fields`
      },
    });
    prepareSource(SOURCE, declaration);
    const rows = Array.from({ length: 25 }, (_, i) => ({
      // `archived` IS present — the tombstone path is healthy, so the alarm below
      // is isolated to the phantom hash/version paths and nothing else.
      id: `t${i}`, title: `Task ${i}`, done: false, label: 'L',
      updatedAt: '2026-07-14T00:00:00Z', archived: false,
    }));
    const result = expectSyncOk(await runSync(declaration, { runFetch: async () => okFetch(rows) }));
    expect(result.ok).toBe(true); // ← the cycle is "healthy". It is not.

    const signal = stalenessSignal(health());
    expect(signal.change_detection_dead).toBe(true);
    expect(signal.never_valued.map((n) => n.path).sort())
      .toEqual(['fields.done', 'fields.title', 'fields.updated']);
    expect(describeStalenessSignal(SOURCE, signal)).toContain('FROZEN');
  });

  it('accumulates across cycles — the denominator is the Source lifetime, not one walk', async () => {
    const declaration = taskDeclaration();
    prepareSource(SOURCE, declaration);
    const batch = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({
      id: `t${from + i}`, title: `Task ${from + i}`, done: false, label: 'L',
      updatedAt: `2026-07-14T00:00:0${(from + i) % 10}Z`, archived: false,
    }));
    expectSyncOk(await runSync(declaration, { runFetch: async () => okFetch(batch(0, 10)) }));
    expect(health()?.rows_seen).toBe(10);

    expectSyncOk(await runSync(declaration, { runFetch: async () => okFetch(batch(10, 15)) }));
    expect(health()?.rows_seen).toBe(25);
    expect(health()?.paths.title.with_value).toBe(25);
  });
});
