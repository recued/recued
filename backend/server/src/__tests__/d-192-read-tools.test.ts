/** D-192 read-tool integration coverage over the real store, resolver,
 *  sync-state store, and targeted-read executor seam. */

import type {
  ChatDispatchContext,
  ChatDispatchResult,
  ConnectionOperationProfile,
  ExecutionSource,
  IngredientManifest,
  SourceRegistration,
  WorkEntitySourceFreshness,
} from '@recued/contracts';
import { qualifyWorkEntityId, RECUED_BUILTIN_SOURCE_ID } from '@recued/contracts';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  GatedCatalogOperationOutcome,
  GatedCatalogOperationRequest,
  RunGatedCatalogOperationFn,
  SourceMirrorFetchDeps,
} from '../source-mirror/fetch.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type TaskWriteInput,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  createWorkEntitySourceSyncStateStore,
  ensureWorkEntitySourceSyncStateSchema,
  type WorkEntitySourceSyncState,
  type WorkEntitySourceSyncStateStore,
} from '../storage/work-entity-source-mirror.js';
import type { WorkEntityReadPlan } from '../work-entity-read-resolution.js';
import {
  runWorkEntityReadTool,
  runWorkEntitySearchTool,
  type WorkEntityEscalationError,
  type WorkEntityReadToolsDeps,
  type WorkEntityToolItem,
} from '../work-entity-read-tools.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import type { KernelWorkEntitySourceDeclaration } from '../work-entity-source-boot.js';
import {
  prepareWorkEntitySourceTargetedRead,
  type WorkEntityTargetedReadDeps,
} from '../work-entity-write-executor.js';

const NOW = 1_700_000_000_000;
const CONNECTION = 'acme';
const CATALOG = 'hubspot-test';
const BUILTIN_TASK_SOURCE = RECUED_BUILTIN_SOURCE_ID('task');
const OWNER_CTX: ChatDispatchContext = { channel: 'internal_function_call' };
const MCP_CTX: ChatDispatchContext = { channel: 'mcp_wire', mcp_token_id: 't1' };

let db: Database.Database;
let store: WorkEntityStore;
let syncState: WorkEntitySourceSyncStateStore;
const qualifiedIdsByLocalId = new Map<string, string>();

interface SearchResult {
  entities: WorkEntityToolItem[];
  total: number;
  source_freshness?: WorkEntitySourceFreshness[];
  limitations?: Array<{ source_id: string; limitations: string[] }>;
  narrow?: { cap: string; detail: string };
  escalated?: Array<{ source_id: string; record_ids: string[] }>;
  escalation_errors?: WorkEntityEscalationError[];
  hidden_sources?: number;
  scan_truncated?: boolean;
}

interface ReadResult {
  entity: WorkEntityToolItem | null;
  found: boolean;
  source_freshness?: WorkEntitySourceFreshness;
  plan?: WorkEntityReadPlan;
  escalation_error?: WorkEntityEscalationError;
  live_read_at?: number;
}

interface TargetedHarness {
  deps: WorkEntityTargetedReadDeps;
  invocations: GatedCatalogOperationRequest[];
}

const op = (
  operation_id: string,
  risk_tier: 'read' | 'write',
  result_path?: string,
): Record<string, unknown> => ({
  operation_id,
  risk_tier,
  ...(result_path !== undefined ? { result_path } : {}),
});

const manifestFake: IngredientManifest = {
  slug: CATALOG,
  name: 'HubSpot test catalog',
  description: 'Test catalog for D-192 read tools',
  author: 'recued',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    'task.read': op('task.read', 'read', 'record'),
    'note.read': op('note.read', 'read', 'record'),
  },
} as unknown as IngredientManifest;

const profile: ConnectionOperationProfile = {
  allowed_operations: ['task.read', 'note.read'],
  catalog_slug: CATALOG,
};

beforeEach(() => {
  qualifiedIdsByLocalId.clear();
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

const okResult = <T>(result: ChatDispatchResult): T => {
  if (!result.ok) {
    throw new Error(`expected ok dispatch, got ${result.reason}: ${result.detail ?? ''}`);
  }
  return result.result as T;
};

const rejectedResult = (
  result: ChatDispatchResult,
): Extract<ChatDispatchResult, { ok: false }> => {
  if (result.ok) throw new Error('expected rejected dispatch');
  return result;
};

const expectLocalPlan = (plan: WorkEntityReadPlan | undefined): Extract<WorkEntityReadPlan, { action: 'local' }> => {
  if (plan === undefined || plan.action !== 'local') {
    throw new Error('expected local read plan');
  }
  return plan;
};

const expectRemotePlan = (plan: WorkEntityReadPlan | undefined): Extract<WorkEntityReadPlan, { action: 'remote' }> => {
  if (plan === undefined || plan.action !== 'remote') {
    throw new Error('expected remote read plan');
  }
  return plan;
};

const entityById = (result: SearchResult, id: string): WorkEntityToolItem => {
  const entity = result.entities.find((row) => row.id === qualifiedIdsByLocalId.get(id));
  if (entity === undefined) throw new Error(`missing entity ${id}`);
  return entity;
};

const qualifiedIdFor = (localId: string): string => {
  const qualified = qualifiedIdsByLocalId.get(localId);
  if (qualified === undefined) throw new Error(`missing qualified id for ${localId}`);
  return qualified;
};

const registerSource = (
  id: string,
  top_tier_kind: SourceRegistration['top_tier_kind'] = 'task',
  source_kind: SourceRegistration['source_kind'] = 'connection',
  overrides: Partial<SourceRegistration> = {},
): SourceRegistration =>
  store.registerSource({
    id,
    top_tier_kind,
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

const seedTask = (input: {
  id: string;
  source_id: string;
  title: string;
  done?: boolean;
  body?: string;
  state?: string;
  updated_at?: number;
  source_record_id?: string;
  source_extension_blob?: Record<string, unknown>;
}): void => {
  const write: TaskWriteInput = {
    id: input.id,
    source_id: input.source_id,
    title: input.title,
    done: input.done ?? false,
    state: input.state ?? 'LOCAL_OPEN',
    created_at: input.updated_at ?? NOW,
    updated_at: input.updated_at ?? NOW,
  };
  if (input.body !== undefined) write.body = input.body;
  if (input.source_record_id !== undefined) {
    write.source_record_id = input.source_record_id;
    write.connection_id = CONNECTION;
  }
  if (input.source_extension_blob !== undefined) {
    write.source_extension_blob = input.source_extension_blob;
  }
  store.writeTask(write, input.updated_at ?? NOW);
  qualifiedIdsByLocalId.set(input.id, qualifyWorkEntityId({
    kind: 'task',
    source_id: input.source_id,
    ...(input.source_record_id !== undefined
      ? { source_record_id: input.source_record_id }
      : {}),
    local_id: input.id,
  }));
};

const seedNote = (input: {
  id: string;
  source_id: string;
  body: string;
  title?: string;
  updated_at?: number;
  source_record_id?: string;
  source_extension_blob?: Record<string, unknown>;
}): void => {
  store.writeNote({
    id: input.id,
    source_id: input.source_id,
    ...(input.source_record_id !== undefined
      ? { source_record_id: input.source_record_id, connection_id: CONNECTION }
      : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    body: input.body,
    created_at: input.updated_at ?? NOW,
    updated_at: input.updated_at ?? NOW,
    last_user_action_at: input.updated_at ?? NOW,
    ...(input.source_extension_blob !== undefined
      ? { source_extension_blob: input.source_extension_blob }
      : {}),
  }, input.updated_at ?? NOW);
  qualifiedIdsByLocalId.set(input.id, qualifyWorkEntityId({
    kind: 'note',
    source_id: input.source_id,
    ...(input.source_record_id !== undefined
      ? { source_record_id: input.source_record_id }
      : {}),
    local_id: input.id,
  }));
};

/** A scriptable op-admission gate for the escalation seam. Defaults
 *  permissive on both axes; tests override per-axis and capture the
 *  judged sources / op ids. */
const admissionGate = (
  over: Partial<{
    isFrozenByPause: (source: ExecutionSource) => boolean;
    isOpGranted: (source: ExecutionSource, opId: string | undefined) => boolean;
  }> = {},
): { isFrozenByPause: (s: ExecutionSource) => boolean; isOpGranted: (s: ExecutionSource, o: string | undefined) => boolean } => ({
  isFrozenByPause: () => false,
  isOpGranted: () => true,
  ...over,
});

const readToolsDeps = (
  opts: {
    targeted?: WorkEntityTargetedReadDeps;
    withSyncState?: boolean;
    gate?: ReturnType<typeof admissionGate>;
  } = {},
): WorkEntityReadToolsDeps => ({
  // D-205 #3 — these tests exercise the READ path, not the read FENCE (the fence has its
  // own suite, `d-205-tier1-collection-read-fence.test.ts`). Admit-all keeps them testing
  // what they were written to test. The dep is REQUIRED, so this is a deliberate choice
  // rather than an omission — which is the whole point of making it required.
  isCollectionReadGranted: () => true,
  // Same reasoning for the `core.work-entity.read` VERB-OP fence: these tests
  // exercise the read PATH, not the capability fence (which has its own suite in
  // `d-205-tier1-collection-read-fence.test.ts`). Also REQUIRED, so likewise a
  // deliberate choice rather than an omission.
  isVerbOpGranted: () => true,
  getResolver: () =>
    createWorkEntityResolver(
      store,
      opts.withSyncState === false ? {} : { syncState, now: () => NOW },
    ),
  getTargetedReadDeps: () => opts.targeted,
  ...(opts.gate !== undefined ? { getOpAdmissionGate: () => opts.gate } : {}),
  now: () => NOW,
});

const workEntityPolicy = (
  remote_when: NonNullable<KernelWorkEntitySourceDeclaration['read_resolution']['remote_when']>,
  wild_query: Partial<KernelWorkEntitySourceDeclaration['read_resolution']['wild_query']> = {},
): KernelWorkEntitySourceDeclaration['read_resolution'] => ({
  default: 'local_rich_meta',
  remote_when: [...remote_when],
  wild_query: {
    remote_fanout: 'bounded_targeted',
    max_sources: 3,
    max_remote_records: 10,
    on_exceeds_cap: 'ask_to_narrow',
    ...wild_query,
  },
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
    hash_fields: ['properties.title', 'properties.state', 'properties.body', 'updatedAt'],
  },
  ops: {
    list: 'task.list',
    read: 'task.read',
  },
  op_bindings: {
    read: { id_arg: 'taskId' },
  },
  sync: {
    mode: 'read_only',
    depth: 'meta',
    tombstones: 'none',
    stale_after_ms: 1_000,
  },
  read_resolution: workEntityPolicy([
    'field_missing',
    'source_stale',
    'complete_body_required',
    'current_remote_required',
    'write_preflight',
  ]),
  projection: {
    canonical: {
      title: 'properties.title',
      state: 'properties.state',
    },
    preview: {
      body: { field: 'properties.body', max_chars: 800 },
    },
  },
  ...overrides,
});

const noteDeclaration = (
  overrides: Partial<KernelWorkEntitySourceDeclaration> = {},
): KernelWorkEntitySourceDeclaration => ({
  kind: 'note',
  source_id_template: 'hubspot.${connection_id}.note',
  source_label_template: 'HubSpot notes (${connection_name})',
  source_kind: 'connection',
  remote: {
    entity: 'note',
    id: 'id',
    version: { kind: 'updated_at', field: 'updatedAt' },
    hash_fields: ['fields.title', 'fields.body', 'updatedAt'],
  },
  ops: {
    list: 'note.list',
    read: 'note.read',
  },
  op_bindings: {
    read: { id_arg: 'noteId' },
  },
  sync: {
    mode: 'read_only',
    depth: 'meta',
    tombstones: 'none',
    stale_after_ms: 1_000,
  },
  read_resolution: workEntityPolicy(['complete_body_required', 'current_remote_required']),
  projection: {
    canonical: {
      title: 'fields.title',
    },
    preview: {
      body: { field: 'fields.body', max_chars: 800 },
    },
  },
  ...overrides,
});

const opOk = (record: Record<string, unknown>): GatedCatalogOperationOutcome => ({
  ok: true,
  raw: { result: { record } },
});

const opError = (
  kind: 'config' | 'policy' | 'error' | 'unavailable',
  reason: string,
): GatedCatalogOperationOutcome => ({ ok: false, kind, reason });

const scriptedOperation = (
  ...outcomes: GatedCatalogOperationOutcome[]
): {
  runOperation: RunGatedCatalogOperationFn;
  invocations: GatedCatalogOperationRequest[];
} => {
  const queue = [...outcomes];
  const invocations: GatedCatalogOperationRequest[] = [];
  const runOperation: RunGatedCatalogOperationFn = async (_deps, request) => {
    invocations.push(request);
    return queue.shift() ?? opError('error', 'no scripted operation outcome');
  };
  return { runOperation, invocations };
};

const targetedHarness = (
  declarations: Readonly<Record<string, KernelWorkEntitySourceDeclaration | null | undefined>>,
  ...outcomes: GatedCatalogOperationOutcome[]
): TargetedHarness => {
  const scripted = scriptedOperation(...outcomes);
  return {
    invocations: scripted.invocations,
    deps: {
      fetchDeps: {
        executorConfig: {
          manifests: {
            get: (slug: string) => (slug === CATALOG ? manifestFake : null),
          },
        },
        profiles: {
          get: (name: string) => (name === CONNECTION ? profile : null),
        },
      } as unknown as SourceMirrorFetchDeps,
      resolveDeclaration: (source_id) => {
        const declaration = declarations[source_id] ?? null;
        return declaration === null ? null : { declaration, connection_name: CONNECTION };
      },
      runOperation: scripted.runOperation,
    },
  };
};

const targetedHarnessWithResolver = (
  resolveDeclaration: WorkEntityTargetedReadDeps['resolveDeclaration'],
  ...outcomes: GatedCatalogOperationOutcome[]
): TargetedHarness => {
  const scripted = scriptedOperation(...outcomes);
  return {
    invocations: scripted.invocations,
    deps: {
      fetchDeps: {
        executorConfig: {
          manifests: {
            get: (slug: string) => (slug === CATALOG ? manifestFake : null),
          },
        },
        profiles: {
          get: (name: string) => (name === CONNECTION ? profile : null),
        },
      } as unknown as SourceMirrorFetchDeps,
      resolveDeclaration,
      runOperation: scripted.runOperation,
    },
  };
};

const vendorTask = (
  id: string,
  opts: {
    title: string;
    state: string;
    body: string;
    updatedAt?: string;
  },
): Record<string, unknown> => ({
  id,
  updatedAt: opts.updatedAt ?? '2026-07-02T12:00:00.000Z',
  properties: {
    title: opts.title,
    state: opts.state,
    body: opts.body,
  },
});

describe('work.search', () => {
  it('performs local discovery with query, done/source filters, limit/total, lean fields, and clamped long text', async () => {
    const connectionSource = 'hubspot.search-local.task';
    registerSource(connectionSource);
    registerSource(BUILTIN_TASK_SOURCE, 'task', 'builtin', {
      source_label: 'Recued built-in',
    });
    seedSyncState(connectionSource);

    const longPreview = `needle body match ${'x'.repeat(340)}`;
    seedTask({
      id: 'search-title-local-row',
      source_id: connectionSource,
      source_record_id: 'search-title-remote-row',
      title: 'needle title local row',
      done: false,
      body: 'short local body without the other token',
      updated_at: NOW - 30,
    });
    seedTask({
      id: 'search-preview-local-row',
      source_id: BUILTIN_TASK_SOURCE,
      title: 'body only local row',
      done: true,
      updated_at: NOW - 10,
      source_extension_blob: {
        preview: { body: longPreview },
        detail_fidelity: { body: 'preview' },
      },
    });
    seedTask({
      id: 'search-unmatched-local-row',
      source_id: connectionSource,
      source_record_id: 'search-unmatched-remote-row',
      title: 'unmatched local row',
      done: false,
      body: 'nothing relevant',
      updated_at: NOW - 20,
    });

    const full = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps(),
        { kind: 'task', query: 'needle', limit: 10 },
        OWNER_CTX,
      ),
    );
    expect(full.total).toBe(2);
    expect(full.entities.map((entity) => entity.id).sort()).toEqual([
      qualifiedIdFor('search-preview-local-row'),
      qualifiedIdFor('search-title-local-row'),
    ].sort());

    const titleRow = entityById(full, 'search-title-local-row');
    expect(titleRow).toMatchObject({
      id: qualifiedIdFor('search-title-local-row'),
      kind: 'task',
      source_id: connectionSource,
      title: 'needle title local row',
      done: false,
      state: 'LOCAL_OPEN',
    });
    expect('body' in titleRow).toBe(false);

    const previewRow = entityById(full, 'search-preview-local-row');
    expect(previewRow.long_text).toEqual({
      field: 'body',
      text: longPreview.slice(0, 280),
      fidelity: 'preview',
      truncated: true,
    });
    expect(previewRow.long_text?.text).toHaveLength(280);

    const limited = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps(),
        { kind: 'task', query: 'needle', limit: 1 },
        OWNER_CTX,
      ),
    );
    expect(limited.total).toBe(2);
    expect(limited.entities).toHaveLength(1);

    const doneFalse = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps(),
        { kind: 'task', query: 'needle', done: false, limit: 10 },
        OWNER_CTX,
      ),
    );
    expect(doneFalse.entities.map((entity) => entity.id)).toEqual([
      qualifiedIdFor('search-title-local-row'),
    ]);

    const doneTrue = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps(),
        { kind: 'task', query: 'needle', done: true, limit: 10 },
        OWNER_CTX,
      ),
    );
    expect(doneTrue.entities.map((entity) => entity.id)).toEqual([
      qualifiedIdFor('search-preview-local-row'),
    ]);

    const scoped = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps(),
        { kind: 'task', query: 'needle', source_id: connectionSource, limit: 10 },
        OWNER_CTX,
      ),
    );
    expect(scoped.total).toBe(1);
    expect(scoped.entities.map((entity) => entity.id)).toEqual([
      qualifiedIdFor('search-title-local-row'),
    ]);
  });

  it('attaches fresh/stale/degraded source_freshness and omits it when no sync-state store is wired', async () => {
    const fresh = 'hubspot.search-fresh.task';
    const stale = 'hubspot.search-stale.task';
    const degraded = 'hubspot.search-degraded.task';
    for (const source of [fresh, stale, degraded]) {
      registerSource(source);
      seedTask({
        id: `${source}.row`,
        source_id: source,
        source_record_id: `${source}.remote`,
        title: `${source} local title`,
      });
    }
    seedSyncState(fresh, { last_success_at: NOW - 100, stale_after_ms: 1_000 });
    seedSyncState(stale, { last_success_at: NOW - 1_001, stale_after_ms: 1_000 });
    seedSyncState(degraded, {
      degraded: true,
      last_success_at: NOW - 100,
      stale_after_ms: 60_000,
      last_error_code: 'fetch_error',
      last_error_message: 'gateway timeout',
    });

    const out = okResult<SearchResult>(
      await runWorkEntitySearchTool(readToolsDeps(), { kind: 'task', limit: 10 }, OWNER_CTX),
    );
    const bySource = new Map(out.source_freshness?.map((row) => [row.source_id, row]));
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
      stale_after_ms: 60_000,
      last_error_code: 'fetch_error',
    });

    const noSync = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps({ withSyncState: false }),
        { kind: 'task', limit: 10 },
        OWNER_CTX,
      ),
    );
    expect('source_freshness' in noSync).toBe(false);
  });

  // D-187 Sources half — REPLACES 'filters unexposed sources on mcp_wire while
  // owner chat remains ungated'. That per-Source `mcp_exposed` filter is
  // deleted; exposure is decided upstream by the contract
  // (`core.work-entity.read` ∧ `data.<kind>`), which is channel-agnostic.
  // So the property to hold is the OPPOSITE of the old one: given the same
  // grants, both channels see exactly the same rows.
  //
  // ⚠ `readToolsDeps()` stubs both grant predicates TRUE — so this asserts
  // PARITY, not the gate itself. The gate is pinned where it is actually
  // resolved: `d-174-p3-contract-grants.test.ts` (owner-on / door-off through
  // the real panel) and the admission tests. A parity test here would pass
  // vacuously if it were read as gate coverage; it is not.
  it('mcp_wire and owner chat return the SAME rows — no per-channel Source filter', async () => {
    const a = 'hubspot.search-parity-a.task';
    const b = 'hubspot.search-parity-b.task';
    registerSource(a, 'task', 'connection');
    registerSource(b, 'task', 'connection');
    seedSyncState(a);
    seedSyncState(b);
    seedTask({
      id: 'search-parity-a-row',
      source_id: a,
      source_record_id: 'search-parity-a-remote',
      title: 'parity a local title',
    });
    seedTask({
      id: 'search-parity-b-row',
      source_id: b,
      source_record_id: 'search-parity-b-remote',
      title: 'parity b local title',
    });

    const external = okResult<SearchResult>(
      await runWorkEntitySearchTool(readToolsDeps(), { kind: 'task', limit: 10 }, MCP_CTX),
    );
    const owner = okResult<SearchResult>(
      await runWorkEntitySearchTool(readToolsDeps(), { kind: 'task', limit: 10 }, OWNER_CTX),
    );
    const ids = [
      qualifiedIdFor('search-parity-a-row'),
      qualifiedIdFor('search-parity-b-row'),
    ].sort();
    expect(external.entities.map((entity) => entity.id).sort()).toEqual(ids);
    expect(owner.entities.map((entity) => entity.id).sort()).toEqual(ids);

    // The coverage-disclosure field went with the filter it explained.
    expect('hidden_sources' in external).toBe(false);
    expect('hidden_sources' in owner).toBe(false);

    // A source-scoped read is no longer refused per channel either.
    const scopedExternal = okResult<SearchResult>(
      await runWorkEntitySearchTool(readToolsDeps(), { kind: 'task', source_id: b }, MCP_CTX),
    );
    const scopedOwner = okResult<SearchResult>(
      await runWorkEntitySearchTool(readToolsDeps(), { kind: 'task', source_id: b }, OWNER_CTX),
    );
    expect(scopedExternal.entities.map((entity) => entity.id)).toEqual([
      qualifiedIdFor('search-parity-b-row'),
    ]);
    expect(scopedOwner.entities.map((entity) => entity.id)).toEqual([
      qualifiedIdFor('search-parity-b-row'),
    ]);
  });

  it('escalates owner current queries through targeted reads and overlays only matching remote records', async () => {
    const completeSource = 'hubspot.search-live-complete.task';
    const previewSource = 'hubspot.search-live-preview.task';
    const longSource = 'hubspot.search-live-long.task';
    registerSource(completeSource);
    registerSource(previewSource);
    registerSource(longSource);
    for (const source of [completeSource, previewSource, longSource]) {
      seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    }
    seedTask({
      id: 'search-live-complete-row',
      source_id: completeSource,
      source_record_id: 'remote-live-complete',
      title: 'local complete title old',
      body: 'local complete body old',
      state: 'LOCAL_COMPLETE_STATE',
      updated_at: NOW - 10,
    });
    seedTask({
      id: 'search-live-preview-row',
      source_id: previewSource,
      source_record_id: 'remote-live-preview',
      title: 'local preview title old',
      body: 'local preview body old',
      state: 'LOCAL_PREVIEW_STATE',
      updated_at: NOW - 20,
    });
    seedTask({
      id: 'search-live-long-row',
      source_id: longSource,
      source_record_id: 'remote-live-long',
      title: 'local long title old',
      body: 'local long body old',
      state: 'LOCAL_LONG_STATE',
      updated_at: NOW - 30,
    });

    const completeDeclaration = taskDeclaration({
      read_resolution: workEntityPolicy(['complete_body_required'], { max_sources: 3 }),
    });
    const previewDeclaration = taskDeclaration({
      read_resolution: workEntityPolicy([], { max_sources: 3 }),
    });
    const longDeclaration = taskDeclaration({
      read_resolution: workEntityPolicy(['complete_body_required'], { max_sources: 3 }),
    });
    const vendorLongBody = 'V'.repeat(16_050);
    const targeted = targetedHarness(
      {
        [completeSource]: completeDeclaration,
        [previewSource]: previewDeclaration,
        [longSource]: longDeclaration,
      },
      opOk(vendorTask('remote-live-complete', {
        title: 'vendor complete title new',
        state: 'VENDOR_COMPLETE_STATE',
        body: 'vendor complete body new',
      })),
      opOk(vendorTask('remote-live-preview', {
        title: 'vendor preview title new',
        state: 'VENDOR_PREVIEW_STATE',
        body: 'vendor preview body new',
      })),
      opOk(vendorTask('remote-live-long', {
        title: 'vendor long title new',
        state: 'VENDOR_LONG_STATE',
        body: vendorLongBody,
      })),
    );

    const out = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', current: true, limit: 10 },
        OWNER_CTX,
      ),
    );

    expect(out.escalated).toEqual([
      { source_id: completeSource, record_ids: [qualifiedIdFor('search-live-complete-row')] },
      { source_id: previewSource, record_ids: [qualifiedIdFor('search-live-preview-row')] },
      { source_id: longSource, record_ids: [qualifiedIdFor('search-live-long-row')] },
    ]);
    expect(targeted.invocations).toHaveLength(3);
    for (const invocation of targeted.invocations) {
      expect(invocation.operationKey).toBe('task.read');
      expect(invocation.stepId).toBe('targeted_read');
      expect(invocation.auditRecipe.recipe_id).toBe('work-entity-source-read');
      expect(Object.keys(invocation.args)).toEqual(['taskId']);
    }

    const complete = entityById(out, 'search-live-complete-row');
    expect(complete.title).toBe('vendor complete title new');
    expect(complete.title).not.toBe('local complete title old');
    expect(complete.state).toBe('VENDOR_COMPLETE_STATE');
    expect(complete.state).not.toBe('LOCAL_COMPLETE_STATE');
    expect(complete.live).toBe(true);
    expect(complete.long_text).toEqual({
      field: 'body',
      text: 'vendor complete body new',
      fidelity: 'complete',
    });

    const preview = entityById(out, 'search-live-preview-row');
    expect(preview.title).toBe('vendor preview title new');
    expect(preview.title).not.toBe('local preview title old');
    expect(preview.live).toBe(true);
    expect(preview.long_text).toEqual({
      field: 'body',
      text: 'vendor preview body new',
      fidelity: 'preview',
    });

    const long = entityById(out, 'search-live-long-row');
    expect(long.title).toBe('vendor long title new');
    expect(long.title).not.toBe('local long title old');
    expect(long.live).toBe(true);
    expect(long.long_text).toEqual({
      field: 'body',
      text: vendorLongBody.slice(0, 16_000),
      fidelity: 'complete',
      truncated: true,
    });
  });

  it('refuses to overlay when the targeted read returns a different remote id', async () => {
    const source = 'hubspot.search-drift.task';
    registerSource(source);
    seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'search-drift-row',
      source_id: source,
      source_record_id: 'remote-drift-expected',
      title: 'local drift title old',
      body: 'local drift body old',
      state: 'LOCAL_DRIFT_STATE',
    });
    const targeted = targetedHarness(
      { [source]: taskDeclaration() },
      opOk(vendorTask('remote-drift-other', {
        title: 'vendor drift title new',
        state: 'VENDOR_DRIFT_STATE',
        body: 'vendor drift body new',
      })),
    );

    const out = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', current: true, limit: 10 },
        OWNER_CTX,
      ),
    );

    const row = entityById(out, 'search-drift-row');
    expect(row.title).toBe('local drift title old');
    expect(row.title).not.toBe('vendor drift title new');
    expect(row.live).toBeUndefined();
    expect(out.escalation_errors).toHaveLength(1);
    expect(out.escalation_errors?.[0]?.source_id).toBe(source);
    expect(out.escalation_errors?.[0]?.kind).toBe('error');
    expect(out.escalation_errors?.[0]?.reason).toContain(
      "targeted read returned record 'remote-drift-other'",
    );
    expect(out.escalation_errors?.[0]?.reason).toContain(
      "expected 'remote-drift-expected'",
    );
    expect(out.escalation_errors?.[0]?.reason).toContain("catalog 'task.read' drift");
    expect(out.escalated).toBeUndefined();
  });

  it('asks to narrow when wild-query escalation exceeds the declared source cap without invoking vendors', async () => {
    const first = 'hubspot.search-narrow-a.task';
    const second = 'hubspot.search-narrow-b.task';
    registerSource(first);
    registerSource(second);
    seedSyncState(first, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedSyncState(second, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'search-narrow-a-row',
      source_id: first,
      source_record_id: 'remote-narrow-a',
      title: 'local narrow a title',
      updated_at: NOW - 10,
    });
    seedTask({
      id: 'search-narrow-b-row',
      source_id: second,
      source_record_id: 'remote-narrow-b',
      title: 'local narrow b title',
      updated_at: NOW - 20,
    });
    const declaration = taskDeclaration({
      read_resolution: workEntityPolicy([], { max_sources: 1 }),
    });
    const targeted = targetedHarness({ [first]: declaration, [second]: declaration });

    const out = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', current: true, limit: 10 },
        OWNER_CTX,
      ),
    );

    expect(out.narrow?.cap).toBe('max_sources');
    expect(out.narrow?.detail).toContain('the cap is 1');
    expect(targeted.invocations).toHaveLength(0);
    expect(entityById(out, 'search-narrow-a-row').title).toBe('local narrow a title');
    expect(entityById(out, 'search-narrow-b-row').title).toBe('local narrow b title');
    expect(out.escalated).toBeUndefined();
  });

  it('refuses external-channel escalation fail-closed while serving the exposed local row', async () => {
    const source = 'hubspot.search-external-refusal.task';
    registerSource(source, 'task', 'connection');
    seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'search-external-refusal-row',
      source_id: source,
      source_record_id: 'remote-external-refusal',
      title: 'local external refusal title',
    });
    const targeted = targetedHarness(
      { [source]: taskDeclaration() },
      opOk(vendorTask('remote-external-refusal', {
        title: 'vendor external title',
        state: 'VENDOR_EXTERNAL_STATE',
        body: 'vendor external body',
      })),
    );

    const out = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', current: true, limit: 10 },
        MCP_CTX,
      ),
    );

    expect(entityById(out, 'search-external-refusal-row').title).toBe(
      'local external refusal title',
    );
    expect(out.escalation_errors).toHaveLength(1);
    expect(out.escalation_errors?.[0]?.kind).toBe('policy');
    expect(out.escalation_errors?.[0]?.reason).toContain('external MCP channel');
    expect(out.escalation_errors?.[0]?.reason).toContain('fail-closed');
    expect(targeted.invocations).toHaveLength(0);
  });

  it('refuses an mcp_wire escalation whose admission CANNOT run (identity without snapshot/gate)', async () => {
    const source = 'hubspot.search-external-threaded.task';
    registerSource(source, 'task', 'connection');
    seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'search-external-threaded-row',
      source_id: source,
      source_record_id: 'remote-external-threaded',
      title: 'local threaded title old',
    });
    const doorSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'call-1',
      mcp_token_id: 't1',
      contract_id: 'contract-door-1',
    } as const;
    const mcpCtxWithSource: ChatDispatchContext = {
      channel: 'mcp_wire',
      mcp_token_id: 't1',
      execution_source: doorSource,
    };
    const targeted = targetedHarness(
      { [source]: taskDeclaration() },
      opOk(vendorTask('remote-external-threaded', {
        title: 'vendor threaded title new',
        state: 'VENDOR_THREADED_STATE',
        body: 'vendor threaded body new',
      })),
    );

    const out = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', current: true, limit: 10 },
        mcpCtxWithSource,
      ),
    );

    // A dispatch identity alone is not enough — the admission needs the
    // door's contract snapshot AND the op-admission gate; either missing
    // (producer gap / dbless) means the admission cannot run, and
    // admission that cannot run never admits (fail closed).
    expect(entityById(out, 'search-external-threaded-row').title).toBe(
      'local threaded title old',
    );
    expect(out.escalation_errors).toHaveLength(1);
    expect(out.escalation_errors?.[0]?.kind).toBe('policy');
    expect(out.escalation_errors?.[0]?.reason).toContain('could not be evaluated');
    expect(out.escalation_errors?.[0]?.reason).toContain('fail-closed');
    expect(out.escalated).toBeUndefined();
    expect(targeted.invocations).toHaveLength(0);
  });

  it('ADMITS an mcp_wire escalation whose contract allows the catalog tool + op (the admission seam)', async () => {
    const source = 'hubspot.search-external-admitted.task';
    registerSource(source, 'task', 'connection');
    seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'search-external-admitted-row',
      source_id: source,
      source_record_id: 'remote-external-admitted',
      title: 'local admitted title old',
    });
    const doorSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'call-adm',
      mcp_token_id: 't1',
      contract_id: 'contract-door-1',
    } as const;
    const ctx: ChatDispatchContext = {
      channel: 'mcp_wire',
      mcp_token_id: 't1',
      execution_source: doorSource,
      // The door's contract allows the BACKING CATALOG tool — the
      // owner granted it (raw slug / recued_ingredient alias); no
      // catalog-slug aliasing happens at this seam.
      contract_snapshot: {
        contract_id: 'contract-door-1',
        contract_version: 'v1',
        allowed_tools: [CATALOG],
        approval_required: [],
        scope_restrictions: [],
        resolved_at: NOW,
      },
    };
    const judgedOps: Array<string | undefined> = [];
    const targeted = targetedHarness(
      { [source]: taskDeclaration() },
      opOk(vendorTask('remote-external-admitted', {
        title: 'vendor admitted title new',
        state: 'VENDOR_ADMITTED_STATE',
        body: 'vendor admitted body new',
      })),
    );

    const out = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps({
          targeted: targeted.deps,
          gate: admissionGate({
            isOpGranted: (_s, opId) => {
              judgedOps.push(opId);
              return true;
            },
          }),
        }),
        { kind: 'task', current: true, limit: 10 },
        ctx,
      ),
    );

    // The lift: a door whose contract allows the backing catalog tool
    // (and whose governing contract grants the op) escalates — the
    // vendor read ran and the live overlay landed.
    expect(out.escalation_errors ?? []).toHaveLength(0);
    expect(out.escalated).toEqual([
      { source_id: source, record_ids: [qualifiedIdFor('search-external-admitted-row')] },
    ]);
    expect(entityById(out, 'search-external-admitted-row').title).toBe(
      'vendor admitted title new',
    );
    expect(targeted.invocations).toHaveLength(1);
    // The op-grant gate judged the DECLARED operation_id of the read op
    // (the raw-op dispatch parity), never the short key alone when a
    // declared id exists.
    expect(judgedOps).toEqual(['task.read']);
  });

  it('DENIES an mcp_wire escalation whose contract lacks the catalog tool (no aliasing at this seam)', async () => {
    const source = 'hubspot.search-external-denied.task';
    registerSource(source, 'task', 'connection');
    seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'search-external-denied-row',
      source_id: source,
      source_record_id: 'remote-external-denied',
      title: 'local denied title',
    });
    const doorSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'call-den',
      mcp_token_id: 't1',
      contract_id: 'contract-door-1',
    } as const;
    const ctx: ChatDispatchContext = {
      channel: 'mcp_wire',
      mcp_token_id: 't1',
      execution_source: doorSource,
      // A work.search wire grant is a MIRROR grant — the backing
      // catalog tool is NOT in the allowlist, so the vendor stays
      // unreachable (also the dead-bound-contract shape: a collapsed
      // `[]` allowlist denies the same way).
      contract_snapshot: {
        contract_id: 'contract-door-1',
        contract_version: 'v1',
        allowed_tools: ['some-other-tool'],
        approval_required: [],
        scope_restrictions: [],
        resolved_at: NOW,
      },
    };
    const targeted = targetedHarness(
      { [source]: taskDeclaration() },
      opOk(vendorTask('remote-external-denied', { title: 'vendor denied title', state: 'V', body: 'vb' })),
    );

    const out = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps({ targeted: targeted.deps, gate: admissionGate() }),
        { kind: 'task', current: true, limit: 10 },
        ctx,
      ),
    );

    expect(entityById(out, 'search-external-denied-row').title).toBe('local denied title');
    expect(out.escalation_errors).toHaveLength(1);
    expect(out.escalation_errors?.[0]?.kind).toBe('policy');
    expect(out.escalation_errors?.[0]?.reason).toContain('tool_not_in_contract');
    expect(out.escalation_errors?.[0]?.reason).toContain('do not retry');
    expect(targeted.invocations).toHaveLength(0);
  });

  it('DENIES an mcp_wire escalation whose door scope fence excludes connection.api', async () => {
    const source = 'hubspot.search-external-scopefence.task';
    registerSource(source, 'task', 'connection');
    seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'search-external-scopefence-row',
      source_id: source,
      source_record_id: 'remote-external-scopefence',
      title: 'local scopefence title',
    });
    const doorSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'call-fence',
      mcp_token_id: 't1',
      contract_id: 'contract-door-1',
    } as const;
    const ctx: ChatDispatchContext = {
      channel: 'mcp_wire',
      mcp_token_id: 't1',
      execution_source: doorSource,
      // The catalog tool IS allowed, but the door's collection fence
      // covers only data.contact — the derived `connection.api` dispatch
      // scope falls outside it, and a scope deny wins over everything.
      contract_snapshot: {
        contract_id: 'contract-door-1',
        contract_version: 'v1',
        allowed_tools: [CATALOG],
        approval_required: [],
        scope_restrictions: ['data.contact'],
        resolved_at: NOW,
      },
    };
    const targeted = targetedHarness(
      { [source]: taskDeclaration() },
      opOk(vendorTask('remote-external-scopefence', { title: 'vendor fence title', state: 'V', body: 'vb' })),
    );

    const out = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps({ targeted: targeted.deps, gate: admissionGate() }),
        { kind: 'task', current: true, limit: 10 },
        ctx,
      ),
    );

    expect(out.escalation_errors).toHaveLength(1);
    expect(out.escalation_errors?.[0]?.kind).toBe('policy');
    expect(out.escalation_errors?.[0]?.reason).toContain('scope_not_in_restrictions');
    expect(targeted.invocations).toHaveLength(0);
  });

  it('DENIES an mcp_wire escalation whose governing contract revokes the op (op_not_granted)', async () => {
    const source = 'hubspot.search-external-oprevoked.task';
    registerSource(source, 'task', 'connection');
    seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'search-external-oprevoked-row',
      source_id: source,
      source_record_id: 'remote-external-oprevoked',
      title: 'local oprevoked title',
    });
    const doorSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'call-rev',
      mcp_token_id: 't1',
      contract_id: 'contract-door-1',
    } as const;
    const ctx: ChatDispatchContext = {
      channel: 'mcp_wire',
      mcp_token_id: 't1',
      execution_source: doorSource,
      contract_snapshot: {
        contract_id: 'contract-door-1',
        contract_version: 'v1',
        allowed_tools: [CATALOG],
        approval_required: [],
        scope_restrictions: [],
        resolved_at: NOW,
      },
    };
    const targeted = targetedHarness(
      { [source]: taskDeclaration() },
      opOk(vendorTask('remote-external-oprevoked', { title: 'vendor oprevoked title', state: 'V', body: 'vb' })),
    );

    const out = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps({
          targeted: targeted.deps,
          gate: admissionGate({ isOpGranted: () => false }),
        }),
        { kind: 'task', current: true, limit: 10 },
        ctx,
      ),
    );

    expect(out.escalation_errors).toHaveLength(1);
    expect(out.escalation_errors?.[0]?.kind).toBe('policy');
    expect(out.escalation_errors?.[0]?.reason).toContain('op_not_granted');
    expect(targeted.invocations).toHaveLength(0);
  });

  it('freezes a governed escalation while the server is paused, serving the local row', async () => {
    const source = 'hubspot.search-paused.task';
    registerSource(source);
    seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'search-paused-row',
      source_id: source,
      source_record_id: 'remote-paused',
      title: 'local paused title',
    });
    const chatSource = {
      channel: 'chat',
      actor: 'user_self',
      chat_session_id: 'sess-p',
      user_id: 'local',
    } as const;
    const frozenSources: ExecutionSource[] = [];
    const targeted = targetedHarness(
      { [source]: taskDeclaration() },
      opOk(vendorTask('remote-paused', {
        title: 'vendor paused title',
        state: 'VENDOR_PAUSED_STATE',
        body: 'vendor paused body',
      })),
    );

    const out = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps({
          targeted: targeted.deps,
          gate: admissionGate({
            isFrozenByPause: (src) => {
              frozenSources.push(src);
              return true;
            },
          }),
        }),
        { kind: 'task', current: true, limit: 10 },
        { channel: 'internal_function_call', execution_source: chatSource },
      ),
    );

    expect(entityById(out, 'search-paused-row').title).toBe('local paused title');
    expect(out.escalation_errors).toHaveLength(1);
    expect(out.escalation_errors?.[0]?.kind).toBe('policy');
    expect(out.escalation_errors?.[0]?.reason).toContain('server is paused');
    expect(out.escalation_errors?.[0]?.reason).toContain('do not retry until resumed');
    expect(targeted.invocations).toHaveLength(0);
    // The predicate judged the DISPATCH identity, not a system stand-in.
    expect(frozenSources).toEqual([chatSource]);
  });

  it('threads the owner-chat execution_source with trigger chat on escalated reads', async () => {
    const source = 'hubspot.search-chat-threaded.task';
    registerSource(source);
    seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'search-chat-threaded-row',
      source_id: source,
      source_record_id: 'remote-chat-threaded',
      title: 'local chat-threaded title old',
    });
    const chatSource = {
      channel: 'chat',
      actor: 'user_self',
      chat_session_id: 'sess-1',
      user_id: 'local',
      turn_id: 'turn-1',
    } as const;
    const ownerCtxWithSource: ChatDispatchContext = {
      channel: 'internal_function_call',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      execution_source: chatSource,
    };
    const targeted = targetedHarness(
      { [source]: taskDeclaration() },
      opOk(vendorTask('remote-chat-threaded', {
        title: 'vendor chat-threaded title new',
        state: 'VENDOR_CHAT_THREADED_STATE',
        body: 'vendor chat-threaded body new',
      })),
    );

    const out = okResult<SearchResult>(
      await runWorkEntitySearchTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', current: true, limit: 10 },
        ownerCtxWithSource,
      ),
    );

    expect(out.escalated).toEqual([
      { source_id: source, record_ids: [qualifiedIdFor('search-chat-threaded-row')] },
    ]);
    expect(targeted.invocations).toHaveLength(1);
    expect(targeted.invocations[0]?.execution_source).toBe(chatSource);
    expect(targeted.invocations[0]?.trigger_source).toBe('chat');
    // A chat source groups by its own turn_id — no correlation id.
    expect(targeted.invocations[0]?.correlation_id).toBeUndefined();
    expect(entityById(out, 'search-chat-threaded-row').title).toBe(
      'vendor chat-threaded title new',
    );
  });
});

describe('work.read', () => {
  it('refuses a legacy declaration whose read slot points at a write-tier op', () => {
    const source = 'hubspot.acme.task';
    const dangerousManifest = {
      ...manifestFake,
      operations: {
        ...manifestFake.operations,
        'task.read': op('task.read', 'write', 'record'),
      },
    } as unknown as IngredientManifest;
    const prepared = prepareWorkEntitySourceTargetedRead({
      fetchDeps: {
        executorConfig: {
          manifests: { get: (slug: string) => slug === CATALOG ? dangerousManifest : null },
        },
        profiles: { get: (name: string) => name === CONNECTION ? profile : null },
      } as unknown as SourceMirrorFetchDeps,
      resolveDeclaration: (source_id) => source_id === source
        ? { declaration: taskDeclaration(), connection_name: CONNECTION }
        : null,
    }, { source_id: source });

    expect(prepared).toMatchObject({ ok: false, kind: 'config' });
    if (prepared.ok) throw new Error('expected read-tier refusal');
    expect(prepared.reason).toContain('not read-tier');
  });

  it('plans local, current, detail, and no-read-op fidelities honestly', async () => {
    const richSource = 'hubspot.read-rich.task';
    const currentSource = 'hubspot.read-current.task';
    const detailSource = 'hubspot.read-detail.task';
    const noDetailSource = 'hubspot.read-no-detail.task';
    const noReadSource = 'hubspot.read-no-op.task';
    for (const source of [richSource, currentSource, detailSource, noDetailSource, noReadSource]) {
      registerSource(source);
      seedSyncState(source, {
        last_success_at: source === richSource ? NOW - 2_000 : NOW - 100,
        stale_after_ms: 1_000,
      });
    }
    seedTask({
      id: 'read-rich-row',
      source_id: richSource,
      source_record_id: 'remote-read-rich',
      title: 'local rich title',
    });
    seedTask({
      id: 'read-current-row',
      source_id: currentSource,
      source_record_id: 'remote-read-current',
      title: 'local current title',
    });
    seedTask({
      id: 'read-detail-row',
      source_id: detailSource,
      source_record_id: 'remote-read-detail',
      title: 'local detail title',
    });
    seedTask({
      id: 'read-no-detail-row',
      source_id: noDetailSource,
      source_record_id: 'remote-read-no-detail',
      title: 'local no-detail title',
    });
    seedTask({
      id: 'read-no-op-row',
      source_id: noReadSource,
      source_record_id: 'remote-read-no-op',
      title: 'local no-op title',
    });

    const noReadDeclaration = taskDeclaration({
      ops: { list: 'task.list', read: null },
      read_resolution: workEntityPolicy(['complete_body_required']),
    });
    const targeted = targetedHarness(
      {
        [richSource]: taskDeclaration(),
        [currentSource]: taskDeclaration({ read_resolution: workEntityPolicy([]) }),
        [detailSource]: taskDeclaration({
          read_resolution: workEntityPolicy(['complete_body_required']),
        }),
        [noDetailSource]: taskDeclaration({ read_resolution: workEntityPolicy([]) }),
        [noReadSource]: noReadDeclaration,
      },
      opOk(vendorTask('remote-read-current', {
        title: 'vendor current title',
        state: 'VENDOR_CURRENT_STATE',
        body: 'vendor current body',
      })),
      opOk(vendorTask('remote-read-detail', {
        title: 'vendor detail title',
        state: 'VENDOR_DETAIL_STATE',
        body: 'vendor detail body',
      })),
    );

    const rich = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', id: 'read-rich-row', fidelity: 'rich_meta' },
        OWNER_CTX,
      ),
    );
    expect(rich.entity?.title).toBe('local rich title');
    expect(rich.entity?.id).toBe(qualifiedIdFor('read-rich-row'));
    const richPlan = expectLocalPlan(rich.plan);
    expect(richPlan.fresh).toBe(false);
    expect(richPlan.limitations).toEqual(['source_stale']);

    const qualifiedRead = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', id: qualifiedIdFor('read-rich-row') },
        OWNER_CTX,
      ),
    );
    expect(qualifiedRead).toMatchObject({
      found: true,
      entity: {
        id: qualifiedIdFor('read-rich-row'),
        source_id: richSource,
        title: 'local rich title',
      },
    });

    const current = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', id: 'read-current-row', fidelity: 'current_remote' },
        OWNER_CTX,
      ),
    );
    const currentPlan = expectRemotePlan(current.plan);
    expect(currentPlan.reasons).toContain('current_remote_required');
    expect(current.entity?.title).toBe('vendor current title');

    const detail = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', id: 'read-detail-row', fidelity: 'remote_detail' },
        OWNER_CTX,
      ),
    );
    const detailPlan = expectRemotePlan(detail.plan);
    expect(detailPlan.reasons).toEqual(['complete_body_required']);
    expect(detail.entity?.title).toBe('vendor detail title');

    const noDetail = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', id: 'read-no-detail-row', fidelity: 'remote_detail' },
        OWNER_CTX,
      ),
    );
    const noDetailPlan = expectLocalPlan(noDetail.plan);
    expect(noDetailPlan.fresh).toBe(true);
    expect(noDetailPlan.limitations).toEqual([]);
    expect(noDetail.entity?.title).toBe('local no-detail title');

    const noRead = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', id: 'read-no-op-row', fidelity: 'remote_detail' },
        OWNER_CTX,
      ),
    );
    const noReadPlan = expectLocalPlan(noRead.plan);
    expect(noReadPlan.limitations).toEqual(['no_remote_read_op', 'preview_only']);
    expect(noRead.entity?.title).toBe('local no-op title');
    expect(targeted.invocations).toHaveLength(2);
  });

  it('overlays successful live reads and degrades config, policy, and external-channel failures to the local row', async () => {
    const successSource = 'hubspot.read-success.task';
    const configSource = 'hubspot.read-config.task';
    const policySource = 'hubspot.read-policy.task';
    const externalSource = 'hubspot.read-external.task';
    registerSource(successSource);
    registerSource(configSource);
    registerSource(policySource);
    registerSource(externalSource, 'task', 'connection');
    for (const source of [successSource, configSource, policySource, externalSource]) {
      seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    }
    seedTask({
      id: 'read-success-row',
      source_id: successSource,
      source_record_id: 'remote-read-success',
      title: 'local success title old',
      body: 'local success body old',
      state: 'LOCAL_SUCCESS_STATE',
    });
    seedTask({
      id: 'read-config-row',
      source_id: configSource,
      source_record_id: 'remote-read-config',
      title: 'local config title old',
    });
    seedTask({
      id: 'read-policy-row',
      source_id: policySource,
      source_record_id: 'remote-read-policy',
      title: 'local policy title old',
    });
    seedTask({
      id: 'read-external-row',
      source_id: externalSource,
      source_record_id: 'remote-read-external',
      title: 'local external read title old',
    });

    const targeted = targetedHarness(
      {
        [successSource]: taskDeclaration({
          read_resolution: workEntityPolicy(['complete_body_required']),
        }),
        [policySource]: taskDeclaration(),
        [externalSource]: taskDeclaration(),
      },
      opOk(vendorTask('remote-read-success', {
        title: 'vendor success title new',
        state: 'VENDOR_SUCCESS_STATE',
        body: 'vendor success body new under cap',
      })),
      opError('policy', 'gateway denied task.read for this connection'),
    );

    const success = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', id: 'read-success-row', fidelity: 'current_remote' },
        OWNER_CTX,
      ),
    );
    expect(success.entity?.title).toBe('vendor success title new');
    expect(success.entity?.title).not.toBe('local success title old');
    expect(success.entity?.live).toBe(true);
    expect(success.entity?.long_text).toEqual({
      field: 'body',
      text: 'vendor success body new under cap',
      fidelity: 'complete',
    });
    expect(success.live_read_at).toBe(NOW);

    let configCalls = 0;
    const configHarness = targetedHarnessWithResolver((source_id) => {
      if (source_id !== configSource) return null;
      configCalls += 1;
      return configCalls === 1
        ? { declaration: taskDeclaration(), connection_name: CONNECTION }
        : null;
    });
    const config = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: configHarness.deps }),
        { kind: 'task', id: 'read-config-row', fidelity: 'current_remote' },
        OWNER_CTX,
      ),
    );
    expect(config.entity?.title).toBe('local config title old');
    expect(config.escalation_error?.kind).toBe('config');
    expect(config.escalation_error?.reason).toContain('has no work-entity Source declaration');
    expect(configHarness.invocations).toHaveLength(0);

    const policy = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', id: 'read-policy-row', fidelity: 'current_remote' },
        OWNER_CTX,
      ),
    );
    expect(policy.entity?.title).toBe('local policy title old');
    expect(policy.entity?.title).not.toBe('vendor policy title new');
    expect(policy.escalation_error).toEqual({
      source_id: policySource,
      kind: 'policy',
      reason: 'gateway denied task.read for this connection',
    });

    const external = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', id: 'read-external-row', fidelity: 'current_remote' },
        MCP_CTX,
      ),
    );
    expect(external.entity?.title).toBe('local external read title old');
    expect(external.escalation_error?.kind).toBe('policy');
    expect(external.escalation_error?.reason).toContain('external MCP channel');
    expect(targeted.invocations).toHaveLength(2);
  });

  it('refuses a work.read escalation on mcp_wire whose admission cannot run, admits a granted one', async () => {
    const source = 'hubspot.read-external-threaded.task';
    registerSource(source, 'task', 'connection');
    seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'read-external-threaded-row',
      source_id: source,
      source_record_id: 'remote-read-external-threaded',
      title: 'local read-threaded title old',
    });
    const doorSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-2',
      tool_call_id: 'call-2',
      mcp_token_id: 't1',
      contract_id: 'contract-door-2',
    } as const;
    const targeted = targetedHarness(
      { [source]: taskDeclaration() },
      opOk(vendorTask('remote-read-external-threaded', {
        title: 'vendor read-threaded title new',
        state: 'VENDOR_READ_THREADED_STATE',
        body: 'vendor read-threaded body new',
      })),
    );

    // Identity WITHOUT snapshot/gate — admission cannot run, refused.
    const refused = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'task', id: 'read-external-threaded-row', fidelity: 'current_remote' },
        { channel: 'mcp_wire', mcp_token_id: 't1', execution_source: doorSource },
      ),
    );
    expect(refused.entity?.title).toBe('local read-threaded title old');
    expect(refused.entity?.live).toBeUndefined();
    expect(refused.escalation_error?.kind).toBe('policy');
    expect(refused.escalation_error?.reason).toContain('could not be evaluated');
    expect(targeted.invocations).toHaveLength(0);

    // Identity + snapshot allowing the catalog tool + a granting gate —
    // the admission seam ADMITS and the live read lands.
    const admitted = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps, gate: admissionGate() }),
        { kind: 'task', id: 'read-external-threaded-row', fidelity: 'current_remote' },
        {
          channel: 'mcp_wire',
          mcp_token_id: 't1',
          execution_source: doorSource,
          contract_snapshot: {
            contract_id: 'contract-door-2',
            contract_version: 'v1',
            allowed_tools: [CATALOG],
            approval_required: [],
            scope_restrictions: [],
            resolved_at: NOW,
          },
        },
      ),
    );
    expect(admitted.entity?.title).toBe('vendor read-threaded title new');
    expect(admitted.live_read_at).toBe(NOW);
    expect(admitted.escalation_error).toBeUndefined();
    expect(targeted.invocations).toHaveLength(1);
  });

  it('refuses (never throws) an internal contract-bearing identity without its snapshot', async () => {
    const source = 'hubspot.read-contracted-nosnap.task';
    registerSource(source);
    seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'read-contracted-nosnap-row',
      source_id: source,
      source_record_id: 'remote-contracted-nosnap',
      title: 'local nosnap title',
    });
    // A future self-restricted producer shape: contract_id on an
    // internal-channel source with NO paired snapshot —
    // `evaluatePreflightAdmission` throws on it by design; the seam
    // must refuse honestly instead of throwing through the tool.
    const restrictedSource = {
      channel: 'chat',
      actor: 'user_self',
      chat_session_id: 'sess-ns',
      user_id: 'local',
      contract_id: 'contract-self-restricted',
    } as unknown as ExecutionSource;
    const targeted = targetedHarness(
      { [source]: taskDeclaration() },
      opOk(vendorTask('remote-contracted-nosnap', { title: 'vendor nosnap title', state: 'V', body: 'vb' })),
    );

    const out = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps, gate: admissionGate() }),
        { kind: 'task', id: 'read-contracted-nosnap-row', fidelity: 'current_remote' },
        { channel: 'internal_function_call', execution_source: restrictedSource },
      ),
    );

    expect(out.entity?.title).toBe('local nosnap title');
    expect(out.escalation_error?.kind).toBe('policy');
    expect(out.escalation_error?.reason).toContain('no contract snapshot');
    expect(targeted.invocations).toHaveLength(0);
  });

  it('blocks an owner-chat escalation whose owner contract revokes the op (the carried isOpGranted gap)', async () => {
    const source = 'hubspot.read-owner-oprevoked.task';
    registerSource(source);
    seedSyncState(source, { last_success_at: NOW - 2_000, stale_after_ms: 1_000 });
    seedTask({
      id: 'read-owner-oprevoked-row',
      source_id: source,
      source_record_id: 'remote-owner-oprevoked',
      title: 'local owner-oprevoked title',
    });
    const chatSource = {
      channel: 'chat',
      actor: 'user_self',
      chat_session_id: 'sess-rev',
      user_id: 'local',
    } as const;
    const judged: Array<{ source: ExecutionSource; opId: string | undefined }> = [];
    const targeted = targetedHarness(
      { [source]: taskDeclaration() },
      opOk(vendorTask('remote-owner-oprevoked', { title: 'vendor owner title', state: 'V', body: 'vb' })),
    );

    const out = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({
          targeted: targeted.deps,
          gate: admissionGate({
            isOpGranted: (src, opId) => {
              judged.push({ source: src, opId });
              return false;
            },
          }),
        }),
        { kind: 'task', id: 'read-owner-oprevoked-row', fidelity: 'current_remote' },
        { channel: 'internal_function_call', execution_source: chatSource },
      ),
    );

    // Owner chat runs the SAME admission core snapshot-less: an
    // explicit op revoke on the owner contract now blocks the vendor
    // read (previously ungated on this channel).
    expect(out.entity?.title).toBe('local owner-oprevoked title');
    expect(out.escalation_error?.kind).toBe('policy');
    expect(out.escalation_error?.reason).toContain('op_not_granted');
    expect(targeted.invocations).toHaveLength(0);
    expect(judged).toEqual([{ source: chatSource, opId: 'task.read' }]);
  });

  // D-187 Sources half — the UNEXPOSED half of this test is gone with the flag.
  // The DISABLED half deliberately survives: `work.read` is by-id and bypasses
  // the store's polymorphic read WHERE, so it re-checks `enabled` per channel.
  // That asymmetry is about data-plane wiring, not authority, and is the ONE
  // `mcp_wire` special-case left in this module.

  it('serves note canonical bodies as complete and mirror previews as preview fidelity', async () => {
    const localNoteSource = 'hubspot.read-note-local.note';
    const mirrorNoteSource = 'hubspot.read-note-preview.note';
    registerSource(localNoteSource, 'note');
    registerSource(mirrorNoteSource, 'note');
    seedSyncState(localNoteSource);
    seedSyncState(mirrorNoteSource);
    seedNote({
      id: 'read-note-complete-row',
      source_id: localNoteSource,
      source_record_id: 'remote-note-complete',
      title: 'local note complete title',
      body: 'local-only complete note body',
    });
    seedNote({
      id: 'read-note-preview-row',
      source_id: mirrorNoteSource,
      source_record_id: 'remote-note-preview',
      title: 'local note preview title',
      body: '',
      source_extension_blob: {
        preview: { body: 'vendor note preview text' },
        detail_fidelity: { body: 'preview' },
      },
    });
    const targeted = targetedHarness({
      [localNoteSource]: noteDeclaration(),
      [mirrorNoteSource]: noteDeclaration(),
    });

    const complete = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'note', id: 'read-note-complete-row', fidelity: 'rich_meta' },
        OWNER_CTX,
      ),
    );
    expect(complete.entity?.long_text).toEqual({
      field: 'body',
      text: 'local-only complete note body',
      fidelity: 'complete',
    });

    const preview = okResult<ReadResult>(
      await runWorkEntityReadTool(
        readToolsDeps({ targeted: targeted.deps }),
        { kind: 'note', id: 'read-note-preview-row', fidelity: 'rich_meta' },
        OWNER_CTX,
      ),
    );
    expect(preview.entity?.long_text).toEqual({
      field: 'body',
      text: 'vendor note preview text',
      fidelity: 'preview',
    });
  });
});
