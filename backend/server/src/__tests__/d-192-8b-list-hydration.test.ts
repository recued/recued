/** D-192 CORE #8b - reference-list hydration sync coverage. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE,
  type ConnectionOperationProfile,
  type IngredientManifest,
  type Task,
} from '@recued/contracts';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  getByDotPath,
  type GatedCatalogOperationOutcome,
  type GatedCatalogOperationRequest,
  type RunGatedCatalogOperationFn,
  type SourceMirrorFetchDeps,
  type SourceMirrorFetchOutcome,
  type SourceMirrorFetchRequest,
} from '../source-mirror/fetch.js';
import {
  workEntitySourceContractHash,
  type KernelWorkEntitySourceDeclaration,
} from '../work-entity-source-boot.js';
import {
  runWorkEntitySourceSync,
  type RunSourceMirrorFetchFn,
} from '../work-entity-source-sync.js';

const NOW = 1_700_000_000_000;
const CONNECTION = 'acme';
const SOURCE = 'azure.acme.task';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let mirror: WorkEntitySourceMirrorStore;
let syncState: WorkEntitySourceSyncStateStore;
let nowMs: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-8b-'));
  db = new Database(join(dir, 'test.db'));
  ensureWorkEntitySchema(db);
  ensureWorkEntitySourceSyncStateSchema(db);
  store = createWorkEntityStore(db);
  mirror = createWorkEntitySourceMirrorStore(db, store);
  syncState = createWorkEntitySourceSyncStateStore(db);
  nowMs = NOW;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const azureTaskDeclaration = (
  overrides: Partial<KernelWorkEntitySourceDeclaration> = {},
): KernelWorkEntitySourceDeclaration => ({
  kind: 'task',
  source_id_template: 'azure.${connection_id}.task',
  source_label_template: 'Azure tasks (${connection_name})',
  source_kind: 'connection',
  remote: {
    entity: 'workItem',
    id: 'id',
    version: { kind: 'revision', field: 'rev' },
    hash_fields: ['rev', 'fields.System.Title', 'fields.System.State', 'url'],
  },
  ops: { list: 'workitem.list', read: 'workitem.read' },
  op_bindings: { read: { id_arg: 'id' } },
  sync: {
    mode: 'read_only',
    depth: 'meta',
    list_rows: 'reference',
    tombstones: 'none',
    list_scope: 'filtered',
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
    canonical: {
      title: 'fields.System.Title',
      state: 'fields.System.State',
    },
    extension: {
      url: 'url',
    },
  },
  ...overrides,
});

const missingMeansDeletedDeclaration = (): KernelWorkEntitySourceDeclaration =>
  azureTaskDeclaration({
    sync: {
      mode: 'read_only',
      depth: 'meta',
      list_rows: 'reference',
      tombstones: 'missing_means_deleted',
      list_scope: 'complete_authoritative',
      stale_after_ms: 21_600_000,
    },
  });

const nativeTombstoneDeclaration = (): KernelWorkEntitySourceDeclaration =>
  azureTaskDeclaration({
    sync: {
      mode: 'read_only',
      depth: 'meta',
      list_rows: 'reference',
      tombstones: 'native',
      tombstone_field: 'fields.System.Deleted',
      list_scope: 'filtered',
      stale_after_ms: 21_600_000,
    },
  });

const recordModeDeclaration = (): KernelWorkEntitySourceDeclaration => {
  const declaration = azureTaskDeclaration({
    sync: {
      mode: 'read_only',
      depth: 'meta',
      tombstones: 'none',
      list_scope: 'filtered',
      stale_after_ms: 21_600_000,
    },
  });
  delete declaration.sync.list_rows;
  return declaration;
};

const readConfigDeclaration = (): KernelWorkEntitySourceDeclaration =>
  azureTaskDeclaration({
    op_arg_bindings: {
      read: { project: { source: 'connection_config', config_key: 'project' } },
    },
  });

const persistDependencyDeclaration = (): KernelWorkEntitySourceDeclaration =>
  recordModeDeclaration();

const manifestFake = {
  slug: 'azure',
  operations: {
    'workitem.list': { result_path: 'workItems' },
    'workitem.read': {},
    'project.list': { result_path: 'projects' },
  },
  surfaces: { api: { result_path: 'workItems' } },
} as unknown as IngredientManifest;

const profile: ConnectionOperationProfile = {
  allowed_operations: ['workitem.list', 'workitem.read', 'project.list'],
  catalog_slug: 'azure',
};

const fetchDeps = (): SourceMirrorFetchDeps => ({
  executorConfig: {
    manifests: {
      get: (slug: string) => (slug === 'azure' ? manifestFake : null),
    },
  },
  profiles: {
    get: () => profile,
  },
} as unknown as SourceMirrorFetchDeps);

const referenceRow = (id: string): Record<string, unknown> => ({
  id,
  url: `https://dev.azure.example/_apis/wit/workItems/${id}`,
});

const hydratedWorkItem = (
  id: string,
  title: string,
  state = 'Active',
  extraFields: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  rev: 1,
  fields: {
    'System.Title': title,
    'System.State': state,
    ...extraFields,
  },
  url: `https://dev.azure.example/_apis/wit/workItems/${id}`,
});

const okFetch = (
  records: ReadonlyArray<Record<string, unknown>>,
  options: { complete?: boolean; skipped_no_id?: number } = {},
): SourceMirrorFetchOutcome => ({
  ok: true,
  records: new Map(records.map((r) => [String(r.id), r])),
  truncated: false,
  complete: options.complete ?? true,
  skipped_no_id: options.skipped_no_id ?? 0,
});

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

const hydrationOk = (record: Record<string, unknown>): GatedCatalogOperationOutcome => ({
  ok: true,
  raw: { result: record },
});

const hydrationError = (
  kind: 'config' | 'policy' | 'error' | 'unavailable',
  reason: string,
): GatedCatalogOperationOutcome => ({ ok: false, kind, reason });

const scriptedHydration = (
  outcomes:
    | GatedCatalogOperationOutcome[]
    | ((request: GatedCatalogOperationRequest) => GatedCatalogOperationOutcome),
): { runHydrationOperation: RunGatedCatalogOperationFn; requests: GatedCatalogOperationRequest[] } => {
  const queue = Array.isArray(outcomes) ? [...outcomes] : null;
  const callback = typeof outcomes === 'function' ? outcomes : null;
  const requests: GatedCatalogOperationRequest[] = [];
  const runHydrationOperation: RunGatedCatalogOperationFn = async (_deps, request) => {
    requests.push(request);
    if (queue !== null) {
      return queue.shift() ?? hydrationError('error', 'no scripted hydration outcome');
    }
    if (callback === null) return hydrationError('error', 'no scripted hydration outcome');
    return callback(request);
  };
  return { runHydrationOperation, requests };
};

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
  script: {
    runFetch: RunSourceMirrorFetchFn;
    runHydrationOperation?: RunGatedCatalogOperationFn;
  },
  source_id = SOURCE,
  extraDeps: {
    resolveConnectionConfig?: (connection_name: string) => Record<string, unknown> | undefined;
  } = {},
) =>
  runWorkEntitySourceSync({
    fetchDeps: fetchDeps(),
    mirror,
    syncState,
    now: () => nowMs,
    runFetch: script.runFetch,
    ...(script.runHydrationOperation !== undefined
      ? { runHydrationOperation: script.runHydrationOperation }
      : {}),
    ...extraDeps,
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

describe('getByDotPath dotted-literal resolution', () => {
  it('resolves literal-dot keys below an ordinary parent', () => {
    expect(getByDotPath(
      { fields: { 'System.Title': 'Fix logout' } },
      'fields.System.Title',
    )).toBe('Fix logout');
  });

  it('resolves a literal dotted key with further nested fields', () => {
    expect(getByDotPath(
      { fields: { 'System.AssignedTo': { displayName: 'Ada Lovelace' } } },
      'fields.System.AssignedTo.displayName',
    )).toBe('Ada Lovelace');
  });

  it('still resolves root-level literal-dot keys', () => {
    expect(getByDotPath({ '@odata.etag': 'W/"1"' }, '@odata.etag')).toBe('W/"1"');
  });

  it('preserves ordinary nested path traversal', () => {
    expect(getByDotPath({ result: { records: [{ id: 'r1' }] } }, 'result.records')).toEqual([{ id: 'r1' }]);
  });

  it('backtracks when a literal subtree cannot resolve the remainder', () => {
    expect(getByDotPath(
      {
        a: { b: { c: 'nested' } },
        'a.b': { other: 'literal without c' },
      },
      'a.b.c',
    )).toBe('nested');
  });

  it('returns undefined on a miss', () => {
    expect(getByDotPath({ a: { b: 1 } }, 'a.c')).toBeUndefined();
  });
});

describe('runWorkEntitySourceSync reference-list hydration', () => {
  it('hydrates reference rows, projects the hydrated record, and records healthy state', async () => {
    const declaration = azureTaskDeclaration();
    prepareSource(SOURCE, declaration);
    const list = scriptedFetch(okFetch([referenceRow('101'), referenceRow('102')]));
    const hydration = scriptedHydration([
      hydrationOk(hydratedWorkItem('101', 'First task')),
      hydrationOk(hydratedWorkItem('102', 'Second task', 'Closed')),
    ]);

    nowMs = NOW + 10;
    const result = expectSyncOk(await runSync(declaration, {
      runFetch: list.runFetch,
      runHydrationOperation: hydration.runHydrationOperation,
    }));

    expect(result).toMatchObject({
      upserted: 2,
      unchanged: 0,
      failed_rows: 0,
      failed_hydration: 0,
      complete: true,
    });
    expect(taskByRemoteId(SOURCE, '101')?.title).toBe('First task');
    expect(taskByRemoteId(SOURCE, '102')?.state).toBe('Closed');
    expect(syncState.get(SOURCE)).toMatchObject({
      last_success_at: NOW + 10,
      degraded: false,
      last_error_code: null,
    });
    expect(list.requests[0]).toMatchObject({
      operationKey: 'workitem.list',
      idField: 'id',
    });
    expect(hydration.requests.map((r) => r.args)).toEqual([{ id: '101' }, { id: '102' }]);
    expect(hydration.requests.every((r) => r.stepId === 'source_sync_hydrate')).toBe(true);
  });

  it('hash-skips unchanged hydrated rows on the second cycle without re-upserting', async () => {
    const declaration = azureTaskDeclaration();
    prepareSource(SOURCE, declaration);
    const records = [
      hydrationOk(hydratedWorkItem('101', 'First task')),
      hydrationOk(hydratedWorkItem('102', 'Second task')),
    ];
    nowMs = NOW + 10;
    expectSyncOk(await runSync(declaration, {
      runFetch: scriptedFetch(okFetch([referenceRow('101'), referenceRow('102')])).runFetch,
      runHydrationOperation: scriptedHydration(records).runHydrationOperation,
    }));
    const first101 = taskByRemoteId(SOURCE, '101');
    const first102 = taskByRemoteId(SOURCE, '102');
    if (first101 === null || first102 === null) throw new Error('seed rows missing');

    nowMs = NOW + 100;
    const secondHydration = scriptedHydration([
      hydrationOk(hydratedWorkItem('101', 'First task')),
      hydrationOk(hydratedWorkItem('102', 'Second task')),
    ]);
    const second = expectSyncOk(await runSync(declaration, {
      runFetch: scriptedFetch(okFetch([referenceRow('101'), referenceRow('102')])).runFetch,
      runHydrationOperation: secondHydration.runHydrationOperation,
    }));

    expect(second.upserted).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(taskByRemoteId(SOURCE, '101')?.updated_at).toBe(first101.updated_at);
    expect(taskByRemoteId(SOURCE, '102')?.updated_at).toBe(first102.updated_at);
    expect(secondHydration.requests).toHaveLength(2);
  });

  it('fails one row on a hydration read error, lands other rows, and degrades health', async () => {
    const declaration = azureTaskDeclaration();
    prepareSource(SOURCE, declaration);
    const list = scriptedFetch(okFetch([referenceRow('good'), referenceRow('bad'), referenceRow('also-good')]));
    const hydration = scriptedHydration([
      hydrationOk(hydratedWorkItem('good', 'Good task')),
      hydrationError('error', '404 from read'),
      hydrationOk(hydratedWorkItem('also-good', 'Also good')),
    ]);

    nowMs = NOW + 10;
    const result = expectSyncOk(await runSync(declaration, {
      runFetch: list.runFetch,
      runHydrationOperation: hydration.runHydrationOperation,
    }));

    expect(result.upserted).toBe(2);
    expect(result.failed_hydration).toBe(1);
    expect(result.failed_rows).toBe(1);
    expect(taskByRemoteId(SOURCE, 'good')).not.toBeNull();
    expect(taskByRemoteId(SOURCE, 'bad')).toBeNull();
    expect(taskByRemoteId(SOURCE, 'also-good')).not.toBeNull();
    expect(syncState.get(SOURCE)).toMatchObject({
      degraded: true,
      last_error_code: 'hydration_failed',
    });
    expect(syncState.get(SOURCE)?.last_error_message).toContain('failed hydration');
  });

  it('aborts on a hydration policy verdict after prior rows fold and does not run absence deletes', async () => {
    const declaration = missingMeansDeletedDeclaration();
    prepareSource(SOURCE, declaration);
    nowMs = NOW + 10;
    expectSyncOk(await runSync(declaration, {
      runFetch: scriptedFetch(okFetch([referenceRow('keep'), referenceRow('gone')])).runFetch,
      runHydrationOperation: scriptedHydration([
        hydrationOk(hydratedWorkItem('keep', 'Keep seed')),
        hydrationOk(hydratedWorkItem('gone', 'Gone seed')),
      ]).runHydrationOperation,
    }));

    nowMs = NOW + 20;
    const result = expectSyncFailure(await runSync(declaration, {
      runFetch: scriptedFetch(okFetch([referenceRow('keep'), referenceRow('abort')])).runFetch,
      runHydrationOperation: scriptedHydration([
        hydrationOk(hydratedWorkItem('keep', 'Keep changed')),
        hydrationError('policy', 'requires approval'),
      ]).runHydrationOperation,
    }));

    expect(result.kind).toBe('policy');
    expect(taskByRemoteId(SOURCE, 'keep')?.title).toBe('Keep changed');
    expect(taskByRemoteId(SOURCE, 'gone')).not.toBeNull();
    expect(taskByRemoteId(SOURCE, 'gone', true)?.deleted_at).toBeUndefined();
    expect(syncState.get(SOURCE)).toMatchObject({
      degraded: true,
      last_error_code: 'hydration_policy',
    });
  });

  it('fails a row when the hydrated record identity drifts from the listed key', async () => {
    const declaration = azureTaskDeclaration();
    prepareSource(SOURCE, declaration);
    const hydration = scriptedHydration([
      hydrationOk(hydratedWorkItem('different', 'Wrong task')),
    ]);

    const result = expectSyncOk(await runSync(declaration, {
      runFetch: scriptedFetch(okFetch([referenceRow('listed')])).runFetch,
      runHydrationOperation: hydration.runHydrationOperation,
    }));

    expect(result.failed_hydration).toBe(1);
    expect(result.failed_rows).toBe(1);
    expect(taskByRemoteId(SOURCE, 'listed')).toBeNull();
    expect(syncState.get(SOURCE)?.last_error_message).toContain('identity drift');
  });

  it('fails rows beyond the per-cycle hydration cap and still lands hydrated rows', async () => {
    const declaration = azureTaskDeclaration();
    prepareSource(SOURCE, declaration);
    const refs = Array.from(
      { length: WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE + 1 },
      (_, i) => referenceRow(String(i + 1)),
    );
    const hydration = scriptedHydration((request) =>
      hydrationOk(hydratedWorkItem(String(request.args.id), `Task ${String(request.args.id)}`)));

    const result = expectSyncOk(await runSync(declaration, {
      runFetch: scriptedFetch(okFetch(refs)).runFetch,
      runHydrationOperation: hydration.runHydrationOperation,
    }));

    expect(result.upserted).toBe(WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE);
    expect(result.failed_hydration).toBe(1);
    expect(result.failed_rows).toBe(1);
    expect(hydration.requests).toHaveLength(WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE);
    expect(taskByRemoteId(SOURCE, String(WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE), true)).not.toBeNull();
    expect(taskByRemoteId(SOURCE, String(WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE + 1), true)).toBeNull();
    expect(syncState.get(SOURCE)?.last_error_message).toContain('per-cycle hydration cap');
  });

  it('never invokes hydration for record-mode Sources', async () => {
    const declaration = recordModeDeclaration();
    prepareSource(SOURCE, declaration);
    const hydration = scriptedHydration(() => {
      throw new Error('record mode must not hydrate');
    });

    const result = expectSyncOk(await runSync(declaration, {
      runFetch: scriptedFetch(okFetch([hydratedWorkItem('101', 'Record mode')])).runFetch,
      runHydrationOperation: hydration.runHydrationOperation,
    }));

    expect(result.upserted).toBe(1);
    expect(result.failed_hydration).toBe(0);
    expect(hydration.requests).toHaveLength(0);
  });

  it('reads native tombstone fields from the hydrated row', async () => {
    const declaration = nativeTombstoneDeclaration();
    prepareSource(SOURCE, declaration);
    nowMs = NOW + 10;
    expectSyncOk(await runSync(declaration, {
      runFetch: scriptedFetch(okFetch([referenceRow('101')])).runFetch,
      runHydrationOperation: scriptedHydration([
        hydrationOk(hydratedWorkItem('101', 'Live task')),
      ]).runHydrationOperation,
    }));
    const seeded = taskByRemoteId(SOURCE, '101');
    if (seeded === null) throw new Error('seed row missing');

    nowMs = NOW + 20;
    const result = expectSyncOk(await runSync(declaration, {
      runFetch: scriptedFetch(okFetch([referenceRow('101')])).runFetch,
      runHydrationOperation: scriptedHydration([
        hydrationOk(hydratedWorkItem('101', 'Deleted task', 'Closed', {
          'System.Deleted': true,
        })),
      ]).runHydrationOperation,
    }));

    expect(result.tombstoned).toBe(1);
    expect(taskByRemoteId(SOURCE, '101')).toBeNull();
    expect(store.readTask(seeded.id)?.deleted_at).toBe(NOW + 20);
  });

  it('merges op_arg_bindings.read config args into every hydration read next to the id', async () => {
    const declaration = readConfigDeclaration();
    prepareSource(SOURCE, declaration);
    const hydration = scriptedHydration([
      hydrationOk(hydratedWorkItem('101', 'Scoped read')),
      hydrationOk(hydratedWorkItem('102', 'Also scoped')),
    ]);

    const result = expectSyncOk(await runSync(
      declaration,
      {
        runFetch: scriptedFetch(okFetch([referenceRow('101'), referenceRow('102')])).runFetch,
        runHydrationOperation: hydration.runHydrationOperation,
      },
      SOURCE,
      { resolveConnectionConfig: () => ({ project: 'proj-9' }) },
    ));

    expect(result.upserted).toBe(2);
    expect(hydration.requests.map((r) => r.args)).toEqual([
      { project: 'proj-9', id: '101' },
      { project: 'proj-9', id: '102' },
    ]);
  });

  it('config-fails hydration preparation before the list fetch when read config is unset', async () => {
    const declaration = readConfigDeclaration();
    prepareSource(SOURCE, declaration);
    const list = scriptedFetch(okFetch([referenceRow('101')]));

    const result = expectSyncFailure(await runSync(
      declaration,
      { runFetch: list.runFetch },
      SOURCE,
      { resolveConnectionConfig: () => ({}) },
    ));

    expect(result.kind).toBe('config');
    expect(result.reason).toContain('project');
    expect(list.requests).toHaveLength(0);
    expect(syncState.get(SOURCE)).toMatchObject({
      degraded: true,
      last_error_code: 'hydration_config',
    });
  });

  it('config-fails persist dependencies when no dependency store is wired', async () => {
    const declaration = persistDependencyDeclaration();
    declaration.source_dependencies = [
      {
        ref: 'project',
        list_op: 'project.list',
        id_field: 'id',
        label_field: 'name',
        binds: [{ op: 'list', arg: 'project' }],
        resolve: 'persist',
      },
    ];
    prepareSource(SOURCE, declaration);
    const list = scriptedFetch(okFetch([hydratedWorkItem('101', 'Record mode')]));

    const result = expectSyncFailure(await runSync(declaration, { runFetch: list.runFetch }));

    expect(result.kind).toBe('config');
    expect(result.reason).toContain('no dependency store is wired');
    expect(list.requests).toHaveLength(0);
    expect(syncState.get(SOURCE)?.last_error_message).toContain('no dependency store is wired');
  });
});
