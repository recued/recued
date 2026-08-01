/** D-192 P4b - declaration-driven work-entity write executor regressions. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ConnectionOperationProfile,
  IngredientManifest,
  Task,
  WorkEntityKind,
  WorkEntityPendingWrite,
  WorkEntitySourceDependency,
} from '@recued/contracts';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSourceDependencyEntityStore,
  ensureSourceDependencyEntitySchema,
  type SourceDependencyEntityStore,
} from '../storage/source-dependency-entity-store.js';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type TaskWriteInput,
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
  type GatedCatalogOperationOutcome,
  type GatedCatalogOperationRequest,
  type RunGatedCatalogOperationFn,
  type SourceMirrorFetchDeps,
  type SourceMirrorFetchOutcome,
  type SourceMirrorFetchRequest,
} from '../source-mirror/fetch.js';
import {
  createWorkEntityDispatchers,
  WorkEntityVendorWriteError,
  WorkEntityWriteConflictError,
} from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import {
  projectWorkEntitySourceRow,
  type ProjectedWorkEntityUpsert,
} from '../work-entity-source-projector.js';
import {
  type KernelWorkEntitySourceDeclaration,
  workEntitySourceContractHash,
} from '../work-entity-source-boot.js';
import {
  runWorkEntitySourceSync,
  type RunSourceMirrorFetchFn,
} from '../work-entity-source-sync.js';
import {
  createWorkEntitySourceWriteExecutor,
  type WorkEntityWriteExecutorDeps,
  type WorkEntitySourceWriteExecutor,
  type WorkEntityVendorWriteDispatchOutcome,
  type WorkEntityVendorWritePrepared,
  type WorkEntityVendorWritePrepareResult,
} from '../work-entity-write-executor.js';
import {
  currentExecutionCaseVerificationContext,
  runWithExecutionCaseVerificationContext,
} from '../execution-case-verification-context.js';

const NOW = 1_700_000_000_000;
const SOURCE_ID = 'hubspot.acme.task';
const CONNECTION = 'acme';
const CATALOG = 'hubspot-test';
const UPDATED_ISO = '2026-07-01T12:34:56.789Z';
const BASE_DUE_ISO = '2026-07-03T08:00:00.000Z';
const NEXT_DUE_ISO = '2026-07-04T09:30:00.000Z';
const VERSION_1 = '2026-07-01T00:00:00.000Z';
const VERSION_2 = '2026-07-02T00:00:00.000Z';
const VERSION_3 = '2026-07-03T00:00:00.000Z';
const VERSION_4 = '2026-07-04T00:00:00.000Z';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let mirror: WorkEntitySourceMirrorStore;
let syncState: WorkEntitySourceSyncStateStore;

interface StageCall {
  kind: WorkEntityKind;
  id: string;
  pending: WorkEntityPendingWrite;
}

interface ExecutorHarness {
  executor: WorkEntitySourceWriteExecutor;
  stageCalls: StageCall[];
}

interface VendorTaskOptions {
  title?: string | undefined;
  state?: string | undefined;
  dueAt?: string | number | undefined;
  body?: string | undefined;
  updatedAt?: string | number | undefined;
  extra?: Record<string, unknown>;
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

const manifestFake = {
  slug: CATALOG,
  name: 'HubSpot test catalog',
  description: 'Test catalog for D-192 P4b executor coverage',
  author: 'recued',
  kind: 'connection',
  category: 'data',
  risk_tier: 'write',
  input: {},
  output: {},
  operations: {
    'task.list': op('task.list', 'read', 'records'),
    'task.read': op('task.read', 'read'),
    'task.create': op('task.create', 'write'),
    'task.update': op('task.update', 'write'),
    'task.delete': op('task.delete', 'write'),
  },
  surfaces: {
    api: {
      result_path: 'records',
    },
  },
} as unknown as IngredientManifest;

const profile: ConnectionOperationProfile = {
  allowed_operations: ['task.list', 'task.read', 'task.create', 'task.update', 'task.delete'],
  catalog_slug: CATALOG,
};

const fetchDeps = (
  opts: {
    manifest?: IngredientManifest | null;
    profile?: ConnectionOperationProfile | null;
  } = {},
): SourceMirrorFetchDeps => ({
  executorConfig: {
    manifests: {
      get: (slug: string) => (slug === CATALOG ? opts.manifest ?? manifestFake : null),
    },
  },
  profiles: {
    get: (connection_name: string) =>
      connection_name === CONNECTION ? opts.profile ?? profile : null,
  },
} as unknown as SourceMirrorFetchDeps);

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
    hash_fields: [
      'properties.hs_task_subject',
      'properties.hs_task_status',
      'properties.hs_timestamp',
      'properties.hs_task_body',
      'updatedAt',
    ],
  },
  ops: {
    list: 'task.list',
    read: 'task.read',
    create: 'task.create',
    update: 'task.update',
  },
  op_bindings: {
    read: { id_arg: 'taskId' },
    update: { id_arg: 'taskId' },
  },
  sync: {
    mode: 'read_write',
    depth: 'meta',
    tombstones: 'none',
    stale_after_ms: 21_600_000,
  },
  read_resolution: {
    default: 'local_rich_meta',
    remote_when: ['write_preflight'],
    wild_query: {
      remote_fanout: 'bounded_targeted',
      max_sources: 1,
      max_remote_records: 10,
      on_exceeds_cap: 'ask_to_narrow',
    },
  },
  projection: {
    canonical: {
      title: 'properties.hs_task_subject',
      state: 'properties.hs_task_status',
      due_at: 'properties.hs_timestamp',
    },
    preview: {
      body: { field: 'properties.hs_task_body', max_chars: 800 },
    },
  },
  writable_fields: ['title', 'state', 'due_at', 'body'],
  write_policy: {
    conditional_write: 'none',
    stale_write: 'manual_merge',
    field_conflicts: 'manual_merge',
  },
  ...overrides,
});

const registerTaskSource = (): void => {
  store.registerSource({
    id: SOURCE_ID,
    top_tier_kind: 'task',
    source_kind: 'connection',
    source_label: 'HubSpot tasks (acme)',
    write_capable: false,
    mcp_exposed: false,
    registered_at: NOW,
  });
};

const makeExecutor = (
  opts: {
    declaration?: KernelWorkEntitySourceDeclaration | null;
    deps?: SourceMirrorFetchDeps;
    runOperation?: RunGatedCatalogOperationFn;
    now?: () => number;
    /** D-192 Slice 5 — the container-selection store (persist-dep create args). */
    dependencyStore?: { getSelected: (source_id: string, ref: string) => { entity_pk: string; label: string } | null };
    /** D-192 — the bound connection's parsed config (create_arg_bindings source). */
    connection_config?: Record<string, unknown>;
    recordDeterministicVerification?:
      WorkEntityWriteExecutorDeps['recordDeterministicVerification'];
    getDeterministicVerificationContext?:
      WorkEntityWriteExecutorDeps['getDeterministicVerificationContext'];
  } = {},
): ExecutorHarness => {
  const declaration = opts.declaration === undefined ? taskDeclaration() : opts.declaration;
  const stageCalls: StageCall[] = [];
  const executor = createWorkEntitySourceWriteExecutor({
    fetchDeps: opts.deps ?? fetchDeps(),
    mirror,
    store: {
      stagePendingWrite(kind, id, pending) {
        stageCalls.push({ kind, id, pending });
        return store.stagePendingWrite(kind, id, pending);
      },
      clearPendingWrite(kind, id) {
        return store.clearPendingWrite(kind, id);
      },
    },
    resolveDeclaration: (source_id) =>
      declaration !== null && source_id === SOURCE_ID
        ? {
            declaration,
            connection_name: CONNECTION,
            ...(opts.connection_config !== undefined ? { connection_config: opts.connection_config } : {}),
          }
        : null,
    now: opts.now ?? (() => NOW),
    ...(opts.dependencyStore !== undefined
      ? { dependencyStore: opts.dependencyStore as never }
      : {}),
    ...(opts.runOperation !== undefined ? { runOperation: opts.runOperation } : {}),
    ...(opts.recordDeterministicVerification !== undefined
      ? {
          recordDeterministicVerification:
            opts.recordDeterministicVerification,
        }
      : {}),
    ...(opts.getDeterministicVerificationContext !== undefined
      ? {
          getDeterministicVerificationContext:
            opts.getDeterministicVerificationContext,
        }
      : {}),
  });
  return { executor, stageCalls };
};

/** A stub container-selection store — one (ref → entity_pk) mapping. */
const selectionStore = (selected: Record<string, string>) => ({
  getSelected: (_source_id: string, ref: string) =>
    ref in selected ? { entity_pk: selected[ref]!, label: `label-${selected[ref]}` } : null,
});

const requirePrepared = (
  result: WorkEntityVendorWritePrepareResult,
): WorkEntityVendorWritePrepared => {
  if (!result.ok) {
    throw new Error(`expected prepare success, got config failure: ${result.reason}`);
  }
  if (!result.vendor_relevant) {
    throw new Error(`expected vendor-relevant prepare, got: ${result.reason}`);
  }
  return result.prepared;
};

const requireCreateOutcome = (
  outcome: WorkEntityVendorWriteDispatchOutcome,
): Extract<WorkEntityVendorWriteDispatchOutcome, { ok: true; operation: 'create' }> => {
  if (!outcome.ok || outcome.operation !== 'create') {
    throw new Error('expected create dispatch success');
  }
  return outcome;
};

const requireUpdateOutcome = (
  outcome: WorkEntityVendorWriteDispatchOutcome,
): Extract<WorkEntityVendorWriteDispatchOutcome, { ok: true; operation: 'update' | 'complete' }> => {
  if (!outcome.ok || (outcome.operation !== 'update' && outcome.operation !== 'complete')) {
    throw new Error('expected update dispatch success');
  }
  return outcome;
};

const requireDispatchFailure = (
  outcome: WorkEntityVendorWriteDispatchOutcome,
): Extract<WorkEntityVendorWriteDispatchOutcome, { ok: false }> => {
  if (outcome.ok) throw new Error('expected dispatch failure');
  return outcome;
};

const opOk = (record: Record<string, unknown>): GatedCatalogOperationOutcome => ({
  ok: true,
  raw: { result: record },
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

const vendorTask = (
  id: string,
  opts: VendorTaskOptions = {},
): Record<string, unknown> => {
  const properties: Record<string, unknown> = {};
  const title = opts.title ?? 'Base title';
  const state = opts.state ?? 'OPEN';
  const dueAt = opts.dueAt ?? BASE_DUE_ISO;
  const body = opts.body ?? 'Vendor preview body';
  if (title !== undefined) properties.hs_task_subject = title;
  if (state !== undefined) properties.hs_task_status = state;
  if (dueAt !== undefined) properties.hs_timestamp = dueAt;
  if (body !== undefined) properties.hs_task_body = body;
  return {
    id,
    updatedAt: opts.updatedAt ?? UPDATED_ISO,
    properties,
    ...(opts.extra ?? {}),
  };
};

const sourceRecordIdOf = (record: Record<string, unknown>): string => {
  const id = record.id;
  if (typeof id !== 'string') throw new Error('test vendor row needs string id');
  return id;
};

const okFetch = (
  records: ReadonlyArray<Record<string, unknown>>,
): SourceMirrorFetchOutcome => ({
  ok: true,
  records: new Map(records.map((record) => [sourceRecordIdOf(record), record] as const)),
  truncated: false,
  complete: true,
  skipped_no_id: 0,
});

const scriptedFetch = (
  ...outcomes: SourceMirrorFetchOutcome[]
): { runFetch: RunSourceMirrorFetchFn; requests: SourceMirrorFetchRequest[] } => {
  const queue = [...outcomes];
  const requests: SourceMirrorFetchRequest[] = [];
  const runFetch: RunSourceMirrorFetchFn = async (_deps, request) => {
    requests.push(request);
    return queue.shift() ?? { ok: false, kind: 'error', reason: 'no scripted fetch outcome' };
  };
  return { runFetch, requests };
};

const projectRawTask = (
  record: Record<string, unknown>,
  declaration: KernelWorkEntitySourceDeclaration = taskDeclaration(),
): ProjectedWorkEntityUpsert => {
  const projected = projectWorkEntitySourceRow({
    declaration,
    source_id: SOURCE_ID,
    connection_name: CONNECTION,
    source_record_id: sourceRecordIdOf(record),
    raw: record,
  });
  if (!projected.ok) throw new Error(`expected projection success: ${projected.reason}`);
  if (projected.upsert.kind !== 'task') {
    throw new Error(`expected task projection, got ${projected.upsert.kind}`);
  }
  return projected.upsert;
};

const upsertRawTask = (
  record: Record<string, unknown>,
  declaration: KernelWorkEntitySourceDeclaration = taskDeclaration(),
): Task => {
  const row = mirror.upsertBySourceIdentity(projectRawTask(record, declaration), NOW);
  if (!('done' in row)) throw new Error('expected task row');
  return row;
};

const seedSyncState = (
  declaration: KernelWorkEntitySourceDeclaration = taskDeclaration(),
): void => {
  syncState.upsert({
    source_id: SOURCE_ID,
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

const seedTask = (input: {
  id: string;
  source_record_id: string;
  title?: string;
  state?: string;
  due_at?: number;
  done?: boolean;
  body?: string;
  parent_project_id?: string;
  source_version_token?: string;
  source_updated_at?: number;
  source_record_hash?: string;
  source_extension_blob?: Record<string, unknown>;
}): Task => {
  const write: TaskWriteInput = {
    id: input.id,
    source_id: SOURCE_ID,
    source_record_id: input.source_record_id,
    connection_id: CONNECTION,
    title: input.title ?? 'Base title',
    done: input.done ?? true,
    state: input.state ?? 'OPEN',
    due_at: input.due_at ?? Date.parse(BASE_DUE_ISO),
    source_version_token: input.source_version_token ?? 'v1',
    source_updated_at: input.source_updated_at ?? NOW - 10_000,
    source_record_hash: input.source_record_hash ?? 'hash-base',
    created_at: NOW - 20_000,
    updated_at: NOW - 10_000,
  };
  if (input.body !== undefined) write.body = input.body;
  if (input.parent_project_id !== undefined) write.parent_project_id = input.parent_project_id;
  if (input.source_extension_blob !== undefined) {
    write.source_extension_blob = input.source_extension_blob;
  }
  return store.writeTask(write, NOW - 10_000);
};

const taskWriteFrom = (
  task: Task,
  changes: Partial<Pick<
    Task,
    | 'title'
    | 'body'
    | 'done'
    | 'due_at'
    | 'priority'
    | 'completed_at'
    | 'assigned_contact_id'
    | 'parent_calendar_event_id'
    | 'linked_mail_thread_id'
    | 'parent_project_id'
    | 'state'
    | 'progress'
  >>,
): TaskWriteInput => {
  const write: TaskWriteInput = {
    id: task.id,
    source_id: task.source_id,
    title: changes.title ?? task.title,
    created_at: task.created_at,
    done: changes.done ?? task.done,
    blocks_task_ids: task.blocks_task_ids,
    sync_state: task.sync_state,
    conflict_policy: task.conflict_policy,
    last_seen_at: task.last_seen_at,
  };
  const copyString = <K extends keyof TaskWriteInput>(
    key: K,
    value: TaskWriteInput[K] | undefined,
  ): void => {
    if (value !== undefined) write[key] = value;
  };
  copyString('source_record_id', task.source_record_id);
  copyString('connection_id', task.connection_id);
  copyString('source_version_token', task.source_version_token);
  copyString('source_record_hash', task.source_record_hash);
  copyString('body', changes.body ?? task.body);
  copyString('priority', changes.priority ?? task.priority);
  copyString('completed_at', changes.completed_at ?? task.completed_at);
  copyString('assigned_contact_id', changes.assigned_contact_id ?? task.assigned_contact_id);
  copyString(
    'parent_calendar_event_id',
    changes.parent_calendar_event_id ?? task.parent_calendar_event_id,
  );
  copyString('linked_mail_thread_id', changes.linked_mail_thread_id ?? task.linked_mail_thread_id);
  copyString('parent_project_id', changes.parent_project_id ?? task.parent_project_id);
  copyString('state', changes.state ?? task.state);
  copyString('progress', changes.progress ?? task.progress);
  copyString('source_updated_at', task.source_updated_at);
  if (changes.due_at !== undefined || task.due_at !== undefined) {
    write.due_at = changes.due_at ?? task.due_at;
  }
  if (task.source_extension_blob !== undefined) {
    write.source_extension_blob = task.source_extension_blob;
  }
  return write;
};

const rewriteTask = (
  task: Task,
  changes: Parameters<typeof taskWriteFrom>[1],
  now = NOW + 1,
): Task => store.writeTask(taskWriteFrom(task, changes), now);

const readTask = (id: string): Task => {
  const row = store.readTask(id);
  if (row === null) throw new Error(`task '${id}' missing`);
  return row;
};

const prepareUpdate = (
  executor: WorkEntitySourceWriteExecutor,
  patch: Record<string, unknown>,
): WorkEntityVendorWritePrepared =>
  requirePrepared(executor.prepare({
    source_id: SOURCE_ID,
    kind: 'task',
    operation: 'update',
    patch,
  }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-p4b-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  ensureWorkEntitySourceSyncStateSchema(db);
  store = createWorkEntityStore(db);
  mirror = createWorkEntitySourceMirrorStore(db, store);
  syncState = createWorkEntitySourceSyncStateStore(db);
  registerTaskSource();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('prepare', () => {
  it('threads connection-config scope into a targeted write and fails before dispatch when unset', () => {
    const declaration = taskDeclaration({
      op_arg_bindings: {
        update: {
          project_ref: { source: 'connection_config', config_key: 'project_ref' },
        },
      },
    });
    const prepared = prepareUpdate(
      makeExecutor({ declaration, connection_config: { project_ref: 'project-42' } }).executor,
      { title: 'Scoped update' },
    );
    expect(prepared.writeOp.configArgs).toEqual({ project_ref: 'project-42' });

    expect(makeExecutor({ declaration, connection_config: {} }).executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { title: 'Must not dispatch' },
    })).toMatchObject({
      ok: false,
      kind: 'config',
      reason: expect.stringContaining("connection config 'project_ref', which is unset"),
    });
  });

  it('config-fails when a targeted-write scope arg collides with the narrow patch', () => {
    const declaration = taskDeclaration({
      op_arg_bindings: {
        update: {
          'body.properties.hs_task_subject': {
            source: 'connection_config',
            config_key: 'project_ref',
          },
        },
      },
    });

    expect(makeExecutor({
      declaration,
      connection_config: { project_ref: 'project-42' },
    }).executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { title: 'Must not become a local-only edit' },
    })).toMatchObject({
      ok: false,
      kind: 'config',
      reason: expect.stringContaining("collides with patch argument 'body.properties.hs_task_subject'"),
    });
  });

  it('config-fails structural non-writeable cases and treats non-pushable updates as local-only', () => {
    const { executor } = makeExecutor();

    // A note write against a TASK-declared Source is a kind mismatch
    // (P6 admitted `note` as a mirror kind — the gate is now the
    // declaration's own kind, not a substrate refusal).
    expect(executor.prepare({
      source_id: SOURCE_ID,
      kind: 'note',
      operation: 'update',
      patch: { title: 'x' },
    })).toMatchObject({ ok: false, kind: 'config', reason: expect.stringContaining("declares kind 'task', not 'note'") });

    expect(executor.prepare({
      source_id: SOURCE_ID,
      kind: 'commitment',
      operation: 'update',
      patch: { title: 'x' },
    })).toMatchObject({ ok: false, kind: 'config', reason: expect.stringContaining('never sync') });

    expect(makeExecutor({ declaration: null }).executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { title: 'x' },
    })).toMatchObject({ ok: false, kind: 'config', reason: expect.stringContaining('no work-entity Source declaration') });

    const readOnly = taskDeclaration({
      sync: { ...taskDeclaration().sync, mode: 'read_only' },
    });
    expect(makeExecutor({ declaration: readOnly }).executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { title: 'x' },
    })).toMatchObject({ ok: false, kind: 'config', reason: expect.stringContaining('read_only') });

    const missingUpdateBinding = taskDeclaration({
      op_bindings: { read: { id_arg: 'taskId' } },
    });
    expect(makeExecutor({ declaration: missingUpdateBinding }).executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { title: 'x' },
    })).toMatchObject({ ok: false, kind: 'config', reason: expect.stringContaining('op_bindings.update.id_arg') });

    const missingReadBinding = taskDeclaration({
      op_bindings: { update: { id_arg: 'taskId' } },
    });
    expect(makeExecutor({ declaration: missingReadBinding }).executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { title: 'x' },
    })).toMatchObject({ ok: false, kind: 'config', reason: expect.stringContaining('op_bindings.read.id_arg') });

    expect(executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'create',
      patch: { parent_project_id: 'project-1', title: null },
    })).toMatchObject({ ok: false, kind: 'config', reason: expect.stringContaining('nothing in the create') });

    expect(executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { parent_project_id: 'project-1', title: undefined },
    })).toEqual({
      ok: true,
      vendor_relevant: false,
      reason: `the patch touches no declared writable field on source '${SOURCE_ID}'`,
    });
  });

  it('intersects patch keys with writable projection lanes and drops nullish/non-writable fields', () => {
    const declaration = taskDeclaration({
      writable_fields: ['title', 'state', 'due_at', 'body', 'not_projected'],
    });
    const { executor } = makeExecutor({ declaration });

    const prepared = prepareUpdate(executor, {
      title: 'Push title',
      state: null,
      due_at: undefined,
      body: 'Push body',
      priority: 'high',
      not_projected: 'drop me',
    });

    // No declared write_transforms — `wire_value` rides the canonical
    // value verbatim.
    expect(prepared.pushable).toEqual([
      { field: 'title', remote_path: 'properties.hs_task_subject', value: 'Push title', wire_value: 'Push title' },
      { field: 'body', remote_path: 'properties.hs_task_body', value: 'Push body', wire_value: 'Push body' },
    ]);
  });

  it('write_paths overrides the projection READ path for a read≠write vendor', () => {
    // The vendor reads due_at from its projection path but WRITES it to a
    // different flat field (the Todoist `due.date` read / `due_date` write shape).
    const declaration = taskDeclaration({ write_paths: { due_at: 'due_date' } });
    const { executor } = makeExecutor({ declaration });
    const prepared = prepareUpdate(executor, { title: 'Push title', due_at: 1_700_000_000_000 });
    const byField = new Map(prepared.pushable.map((p) => [p.field, p]));
    // due_at composes at the declared WRITE path, not its projection read path
    expect(byField.get('due_at')?.remote_path).toBe('due_date');
    // a field with no override still uses its projection lane
    expect(byField.get('title')?.remote_path).toBe('properties.hs_task_subject');
  });

  it('config-fails a drifted writable title coalesce before composing a vendor push', () => {
    const declaration = taskDeclaration({
      projection: {
        canonical: {
          title: ['attributes.note', 'attributes.action'],
          state: 'attributes.state',
        },
      },
      writable_fields: ['title'],
      write_paths: { title: 'attributes.note' },
    });
    const { executor } = makeExecutor({ declaration });

    const result = executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { title: 'Locally edited coalesced title' },
    });

    expect(result).toEqual({
      ok: false,
      kind: 'config',
      reason: `writable field 'title' on source '${SOURCE_ID}' is projected by a derivation/coalesce — derived and coalesced canonical fields admit no vendor write path in v1`,
    });
    expect(result).not.toHaveProperty('vendor_relevant');
    expect(result).not.toHaveProperty('prepared');
  });

  it('config-fails a drifted writable number_equals derivation even with a write_paths override', () => {
    const declaration = taskDeclaration({
      projection: {
        canonical: {
          title: 'attributes.subject',
          done: { kind: 'number_equals', field: 'attributes.percentComplete', value: 100 },
        },
      },
      writable_fields: ['done'],
      write_paths: { done: 'attributes.completed' },
    });
    const { executor } = makeExecutor({ declaration });

    const result = executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { done: true },
    });

    expect(result).toEqual({
      ok: false,
      kind: 'config',
      reason: `writable field 'done' on source '${SOURCE_ID}' is projected by a derivation/coalesce — derived and coalesced canonical fields admit no vendor write path in v1`,
    });
    expect(result).not.toHaveProperty('vendor_relevant');
    expect(result).not.toHaveProperty('prepared');
  });

  it('config-fails a drifted writable transform derivation even with a write_paths override (CORE #8e)', () => {
    const declaration = taskDeclaration({
      projection: {
        canonical: {
          title: { kind: 'transform', field: 'body.storage.value', transform: 'strip_html' },
          state: 'status',
        },
      },
      writable_fields: ['title'],
      write_paths: { title: 'body.title' },
    });
    const { executor } = makeExecutor({ declaration });

    const result = executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { title: 'Locally edited transform-derived title' },
    });

    expect(result).toEqual({
      ok: false,
      kind: 'config',
      reason: `writable field 'title' on source '${SOURCE_ID}' is projected by a derivation/coalesce — derived and coalesced canonical fields admit no vendor write path in v1`,
    });
    expect(result).not.toHaveProperty('vendor_relevant');
    expect(result).not.toHaveProperty('prepared');
  });

  it('still composes a write_paths override for a plain canonical string lane', () => {
    const declaration = taskDeclaration({
      projection: {
        canonical: {
          title: 'title',
          state: 'status',
        },
      },
      writable_fields: ['title'],
      write_paths: { title: 'body.title' },
    });
    const { executor } = makeExecutor({ declaration });

    const prepared = prepareUpdate(executor, { title: 'Microsoft To Do local title edit' });

    expect(prepared.pushable).toEqual([{
      field: 'title',
      remote_path: 'body.title',
      value: 'Microsoft To Do local title edit',
      wire_value: 'Microsoft To Do local title edit',
    }]);
  });

  it('still composes a preview-only writable field when no canonical lane exists', () => {
    const declaration = taskDeclaration({ writable_fields: ['body'] });
    const { executor } = makeExecutor({ declaration });

    const prepared = prepareUpdate(executor, { body: 'Preview-only vendor body edit' });

    expect(prepared.pushable).toEqual([{
      field: 'body',
      remote_path: 'properties.hs_task_body',
      value: 'Preview-only vendor body edit',
      wire_value: 'Preview-only vendor body edit',
    }]);
  });
});

describe('write transforms (inverse vocabulary/derivation)', () => {
  const transformDeclaration = (): KernelWorkEntitySourceDeclaration => taskDeclaration({
    projection: {
      canonical: {
        title: 'properties.hs_task_subject',
        state: 'properties.hs_task_status',
        due_at: 'properties.hs_timestamp',
        priority: 'properties.hs_task_priority',
      },
      preview: {
        body: { field: 'properties.hs_task_body', max_chars: 800 },
      },
    },
    writable_fields: ['title', 'state', 'due_at', 'body', 'priority'],
    write_transforms: {
      priority: { kind: 'vocab', map: { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' } },
      due_at: { kind: 'date_format', format: 'yyyy-MM-dd' },
    },
  });

  const priorityVendorRow = (
    id: string,
    priority: string,
    updatedAt: string,
  ): Record<string, unknown> => vendorTask(id, {
    title: 'Base title',
    state: 'OPEN',
    dueAt: BASE_DUE_ISO,
    updatedAt,
    extra: {
      properties: {
        hs_task_subject: 'Base title',
        hs_task_status: 'OPEN',
        hs_timestamp: BASE_DUE_ISO,
        hs_task_body: 'Vendor preview body',
        hs_task_priority: priority,
      },
    },
  });

  it('conflict compare stays CANONICAL while the wire carries the vendor vocabulary', async () => {
    // Prior mirrors vendor MEDIUM (canonical 'medium'); the local edit
    // set 'high'; the vendor ALSO moved to HIGH. The compare must read
    // canonical 'high' === patch 'high' as AGREEMENT — comparing the
    // wire value 'HIGH' against the canonical projection would
    // manufacture a false conflict.
    const prior = store.writeTask({
      id: 'task-vocab-agreement',
      source_id: SOURCE_ID,
      source_record_id: 'rid-vocab',
      connection_id: CONNECTION,
      title: 'Base title',
      done: false,
      state: 'OPEN',
      priority: 'medium',
      due_at: Date.parse(BASE_DUE_ISO),
      source_version_token: 'v1',
      source_updated_at: NOW - 10_000,
      source_record_hash: 'hash-base',
      created_at: NOW - 20_000,
      updated_at: NOW - 10_000,
    }, NOW - 10_000);
    const current = rewriteTask(prior, { priority: 'high' });
    const script = scriptedOperation(
      opOk(priorityVendorRow('rid-vocab', 'HIGH', VERSION_2)),
      opOk(priorityVendorRow('rid-vocab', 'HIGH', VERSION_3)),
    );
    const harness = makeExecutor({
      declaration: transformDeclaration(),
      runOperation: script.runOperation,
    });
    const prepared = prepareUpdate(harness.executor, { priority: 'high' });

    expect(requireUpdateOutcome(await harness.executor.dispatch(
      prepared,
      { local_id: prior.id, prior, current },
    ))).toMatchObject({ applied: 'pushed', verified: true });

    // The narrow PATCH body carries the VENDOR vocabulary.
    expect(script.invocations.map((i) => i.operationKey)).toEqual(['task.read', 'task.update']);
    expect(script.invocations[1]?.args['body.properties']).toEqual({ hs_task_priority: 'HIGH' });
    // The verify fold stores the CANONICAL value (forward projection of
    // the vendor's HIGH) — wire vocabulary never lands in the mirror.
    expect(readTask(prior.id).priority).toBe('high');
    expect(readTask(prior.id).pending_write).toBeUndefined();
  });

  it('a vendor move to a DIFFERENT priority still conflicts, in canonical terms', async () => {
    const prior = store.writeTask({
      id: 'task-vocab-conflict',
      source_id: SOURCE_ID,
      source_record_id: 'rid-vocab-conflict',
      connection_id: CONNECTION,
      title: 'Base title',
      done: false,
      state: 'OPEN',
      priority: 'medium',
      due_at: Date.parse(BASE_DUE_ISO),
      source_version_token: 'v1',
      source_updated_at: NOW - 10_000,
      source_record_hash: 'hash-base',
      created_at: NOW - 20_000,
      updated_at: NOW - 10_000,
    }, NOW - 10_000);
    const current = rewriteTask(prior, { priority: 'high' });
    const script = scriptedOperation(
      opOk(priorityVendorRow('rid-vocab-conflict', 'LOW', VERSION_2)),
    );
    const harness = makeExecutor({
      declaration: transformDeclaration(),
      runOperation: script.runOperation,
    });
    const prepared = prepareUpdate(harness.executor, { priority: 'high' });

    expect(requireDispatchFailure(await harness.executor.dispatch(
      prepared,
      { local_id: prior.id, prior, current },
    ))).toMatchObject({ kind: 'conflict', conflicting_fields: ['priority'], staged: true });
  });

  it('an unmapped or mistyped vocab value config-refuses BEFORE any side effect', () => {
    const { executor, stageCalls } = makeExecutor({ declaration: transformDeclaration() });
    expect(executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { priority: 'urgent' },
    })).toMatchObject({
      ok: false,
      kind: 'config',
      reason: expect.stringContaining('no declared vendor mapping'),
    });
    expect(executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { priority: 7 },
    })).toMatchObject({
      ok: false,
      kind: 'config',
      reason: expect.stringContaining('expects a string value'),
    });
    expect(stageCalls).toHaveLength(0);
  });

  it('a same-calendar-date vendor move on a date_format field reads as AGREEMENT', async () => {
    // The vendor field is date-typed: it cannot express sub-day
    // differences, so a local-picker ms (18:45 UTC) and the vendor's
    // midnight-projected ms on the SAME calendar date are the same
    // value to the vendor. Comparing at ms fidelity manufactured a
    // false manual-merge conflict here (codex MEDIUM).
    const prior = seedTask({
      id: 'task-date-agreement',
      source_record_id: 'rid-date',
      due_at: Date.parse('2026-07-10'),
    });
    const localPickerMs = Date.parse('2026-07-15T18:45:00.000Z');
    const current = rewriteTask(prior, { due_at: localPickerMs });
    const script = scriptedOperation(
      // Vendor concurrently moved the due date to the SAME calendar
      // date the patch targets — midnight ms after projection.
      opOk(vendorTask('rid-date', { dueAt: '2026-07-15', updatedAt: VERSION_2 })),
      opOk(vendorTask('rid-date', { dueAt: '2026-07-15', updatedAt: VERSION_3 })),
    );
    const harness = makeExecutor({
      declaration: transformDeclaration(),
      runOperation: script.runOperation,
    });
    const prepared = prepareUpdate(harness.executor, { due_at: localPickerMs });

    expect(requireUpdateOutcome(await harness.executor.dispatch(
      prepared,
      { local_id: prior.id, prior, current },
    ))).toMatchObject({ applied: 'pushed', verified: true });
    expect(script.invocations[1]?.args['body.properties']).toEqual({
      hs_timestamp: '2026-07-15',
    });
  });

  it('date_format derives the UTC calendar date and refuses non-epoch values', () => {
    const { executor } = makeExecutor({ declaration: transformDeclaration() });
    const prepared = prepareUpdate(executor, { due_at: Date.parse('2026-07-15T00:00:00.000Z') });
    expect(prepared.pushable).toEqual([{
      field: 'due_at',
      remote_path: 'properties.hs_timestamp',
      value: Date.parse('2026-07-15T00:00:00.000Z'),
      wire_value: '2026-07-15',
    }]);
    // A mid-day instant still derives its UTC calendar date.
    const midday = prepareUpdate(executor, { due_at: Date.parse('2026-07-15T18:45:00.000Z') });
    expect(midday.pushable[0]?.wire_value).toBe('2026-07-15');

    for (const bad of ['tomorrow', Number.NaN, Number.POSITIVE_INFINITY, 8.7e15]) {
      expect(executor.prepare({
        source_id: SOURCE_ID,
        kind: 'task',
        operation: 'update',
        patch: { due_at: bad },
      })).toMatchObject({
        ok: false,
        kind: 'config',
        reason: expect.stringContaining('ms-epoch'),
      });
    }
  });
});

describe('dispatch create', () => {
  it('composes nested body args, returns remote identity, stamps projectable responses, and errors without an id', async () => {
    const createRecord = vendorTask('remote-created', {
      title: 'Created title',
      state: 'WAITING',
      dueAt: NEXT_DUE_ISO,
      body: 'Created preview',
      updatedAt: UPDATED_ISO,
    });
    const createScript = scriptedOperation(opOk(createRecord));
    const { executor } = makeExecutor({ runOperation: createScript.runOperation });
    const prepared = requirePrepared(executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'create',
      patch: {
        title: 'Created title',
        state: 'WAITING',
        due_at: Date.parse(NEXT_DUE_ISO),
        body: 'Created body',
      },
    }));

    const created = requireCreateOutcome(await executor.dispatch(prepared));

    expect(created.source_record_id).toBe('remote-created');
    expect(created.stamp).toMatchObject({
      source_version_token: UPDATED_ISO,
      source_updated_at: Date.parse(UPDATED_ISO),
      source_record_hash: expect.stringMatching(/^fnv1a:/),
    });
    expect(created.stamp?.source_extension_blob).toEqual({
      preview: { body: 'Created preview' },
      detail_fidelity: { body: 'preview' },
    });
    expect(createScript.invocations).toHaveLength(1);
    expect(createScript.invocations[0]?.operationKey).toBe('task.create');
    expect(createScript.invocations[0]?.args).toEqual({
      'body.properties': {
        hs_task_subject: 'Created title',
        hs_task_status: 'WAITING',
        hs_timestamp: Date.parse(NEXT_DUE_ISO),
        hs_task_body: 'Created body',
      },
    });
    expect(Object.keys(createScript.invocations[0]?.args ?? {})).not.toContain(
      'body.properties.hs_task_subject',
    );

    const partialScript = scriptedOperation(opOk({ id: 'remote-partial', updatedAt: UPDATED_ISO }));
    const partialExecutor = makeExecutor({ runOperation: partialScript.runOperation }).executor;
    const partialPrepared = requirePrepared(partialExecutor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'create',
      patch: { title: 'Partial title' },
    }));
    expect(requireCreateOutcome(await partialExecutor.dispatch(partialPrepared))).toEqual({
      ok: true,
      operation: 'create',
      source_record_id: 'remote-partial',
    });

    const noIdScript = scriptedOperation(opOk(vendorTask('', { extra: { id: undefined } })));
    const noIdExecutor = makeExecutor({ runOperation: noIdScript.runOperation }).executor;
    const noIdPrepared = requirePrepared(noIdExecutor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'create',
      patch: { title: 'No id title' },
    }));
    expect(requireDispatchFailure(await noIdExecutor.dispatch(noIdPrepared))).toMatchObject({
      kind: 'error',
      staged: false,
      reason: expect.stringContaining('carries no'),
    });
  });
});

describe('dispatch update', () => {
  it('stages, preflights, narrow-writes, verifies from the write response, refreshes vendor fields, preserves local-only fields, and clears pending', async () => {
    const prior = seedTask({
      id: 'task-happy',
      source_record_id: 'rid-happy',
      title: 'Base title',
      state: 'OPEN',
      done: true,
      body: 'Old local body',
      source_version_token: VERSION_1,
      source_updated_at: NOW - 50_000,
      source_record_hash: 'hash-before',
    });
    const current = rewriteTask(prior, {
      title: 'Local title',
      body: 'Local complete body',
      parent_project_id: 'project-local',
    });
    const script = scriptedOperation(
      opOk(vendorTask('rid-happy', {
        title: 'Base title',
        state: 'OPEN',
        dueAt: BASE_DUE_ISO,
        body: 'Old vendor preview',
        updatedAt: VERSION_1,
      })),
      opOk(vendorTask('rid-happy', {
        title: 'Vendor accepted title',
        state: 'WAITING',
        dueAt: NEXT_DUE_ISO,
        body: 'Vendor accepted preview',
        updatedAt: VERSION_2,
      })),
    );
    const recordDeterministicVerification = vi.fn(async () => ({
      recorded: true,
    }));
    const harness = makeExecutor({
      runOperation: script.runOperation,
      recordDeterministicVerification,
      getDeterministicVerificationContext:
        () => currentExecutionCaseVerificationContext(),
    });
    const prepared = prepareUpdate(harness.executor, {
      title: 'Local title',
      body: 'Local complete body',
    });

    const outcome = requireUpdateOutcome(
      await runWithExecutionCaseVerificationContext(
        { session_id: 'chat-session', turn_id: 'chat-turn' },
        () => harness.executor.dispatch(prepared, {
          local_id: prior.id,
          prior,
          current,
        }),
      ),
    );

    expect(outcome).toMatchObject({
      ok: true,
      operation: 'update',
      applied: 'pushed',
      verified: true,
    });
    expect(recordDeterministicVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'chat-session',
        turn_id: 'chat-turn',
        kind: 'passed',
        postcondition_key: 'work_entity_vendor:task:update',
      }),
    );
    expect(harness.stageCalls).toHaveLength(1);
    expect(harness.stageCalls[0]).toMatchObject({
      kind: 'task',
      id: prior.id,
      pending: {
        staged_at: NOW,
        operation: 'update',
        dirty_fields: ['title', 'body'],
        base_source_updated_at: NOW - 50_000,
        base_source_record_hash: 'hash-before',
        base_source_version_token: VERSION_1,
        state: 'pending',
        attempts: 1,
      },
    });
    expect(script.invocations.map((i) => ({
      operationKey: i.operationKey,
      args: i.args,
      stepId: i.stepId,
    }))).toEqual([
      { operationKey: 'task.read', args: { taskId: 'rid-happy' }, stepId: 'write_preflight' },
      {
        operationKey: 'task.update',
        args: {
          taskId: 'rid-happy',
          'body.properties': {
            hs_task_subject: 'Local title',
            hs_task_body: 'Local complete body',
          },
        },
        stepId: 'source_write',
      },
    ]);
    const refreshed = readTask(prior.id);
    expect(refreshed).toMatchObject({
      title: 'Vendor accepted title',
      state: 'WAITING',
      due_at: Date.parse(NEXT_DUE_ISO),
      body: 'Local complete body',
      parent_project_id: 'project-local',
      done: true,
      source_record_id: 'rid-happy',
      source_version_token: VERSION_2,
      source_updated_at: Date.parse(VERSION_2),
    });
    expect(refreshed.source_extension_blob).toEqual({
      preview: { body: 'Vendor accepted preview' },
      detail_fidelity: { body: 'preview' },
    });
    expect(refreshed.pending_write).toBeUndefined();
  });

  it('keeps pending staged and does not write when preflight returns a different record id', async () => {
    const prior = seedTask({
      id: 'task-id-mismatch',
      source_record_id: 'rid-expected',
      title: 'Base title',
      source_version_token: 'v1',
    });
    const current = rewriteTask(prior, { title: 'Local title' });
    const script = scriptedOperation(opOk(vendorTask('rid-other', {
      title: 'Base title',
      state: 'OPEN',
      updatedAt: VERSION_1,
    })));
    const harness = makeExecutor({ runOperation: script.runOperation });
    const prepared = prepareUpdate(harness.executor, { title: 'Local title' });

    const failure = requireDispatchFailure(await harness.executor.dispatch(prepared, {
      local_id: prior.id,
      prior,
      current,
    }));

    expect(failure).toMatchObject({
      kind: 'error',
      staged: true,
      reason: expect.stringContaining("expected 'rid-expected'"),
    });
    expect(script.invocations.map((i) => i.operationKey)).toEqual(['task.read']);
    expect(readTask(prior.id).pending_write).toMatchObject({
      state: 'pending',
      dirty_fields: ['title'],
      attempts: 1,
    });
  });

  it('conflicts only when the vendor changed an overlapping dirty field to a different value', async () => {
    const prior = seedTask({
      id: 'task-conflict',
      source_record_id: 'rid-conflict',
      title: 'Base title',
      state: 'OPEN',
      source_version_token: 'v1',
    });
    const current = rewriteTask(prior, { title: 'Local title' });
    const conflictScript = scriptedOperation(opOk(vendorTask('rid-conflict', {
      title: 'Vendor title',
      state: 'OPEN',
      updatedAt: VERSION_2,
    })));
    const conflictHarness = makeExecutor({ runOperation: conflictScript.runOperation });
    const conflictPrepared = prepareUpdate(conflictHarness.executor, { title: 'Local title' });

    const conflict = requireDispatchFailure(await conflictHarness.executor.dispatch(
      conflictPrepared,
      { local_id: prior.id, prior, current },
    ));

    expect(conflict).toMatchObject({
      kind: 'conflict',
      conflicting_fields: ['title'],
      staged: true,
    });
    expect(conflictScript.invocations.map((i) => i.operationKey)).toEqual(['task.read']);
    expect(readTask(prior.id).pending_write).toMatchObject({
      state: 'pending',
      dirty_fields: ['title'],
    });

    const agreedPrior = seedTask({
      id: 'task-agreement',
      source_record_id: 'rid-agreement',
      title: 'Base title',
      state: 'OPEN',
      source_version_token: 'v1',
    });
    const agreedCurrent = rewriteTask(agreedPrior, { title: 'Local title' });
    const agreementScript = scriptedOperation(
      opOk(vendorTask('rid-agreement', {
        title: 'Local title',
        state: 'OPEN',
        updatedAt: VERSION_2,
      })),
      opOk(vendorTask('rid-agreement', {
        title: 'Local title',
        state: 'OPEN',
        updatedAt: VERSION_3,
      })),
    );
    const agreementHarness = makeExecutor({ runOperation: agreementScript.runOperation });
    const agreementPrepared = prepareUpdate(agreementHarness.executor, { title: 'Local title' });

    expect(requireUpdateOutcome(await agreementHarness.executor.dispatch(
      agreementPrepared,
      { local_id: agreedPrior.id, prior: agreedPrior, current: agreedCurrent },
    ))).toMatchObject({ applied: 'pushed', verified: true });
    expect(agreementScript.invocations.map((i) => i.operationKey)).toEqual([
      'task.read',
      'task.update',
    ]);
    expect(readTask(agreedPrior.id).pending_write).toBeUndefined();
  });

  it('pushes through changed-disjoint vendor state and folds the vendor field on verify', async () => {
    const prior = seedTask({
      id: 'task-disjoint',
      source_record_id: 'rid-disjoint',
      title: 'Base title',
      state: 'OPEN',
      source_version_token: 'v1',
    });
    const current = rewriteTask(prior, { title: 'Local title' });
    const script = scriptedOperation(
      opOk(vendorTask('rid-disjoint', {
        title: 'Base title',
        state: 'WAITING_ON_VENDOR',
        updatedAt: VERSION_2,
      })),
      opOk(vendorTask('rid-disjoint', {
        title: 'Local title',
        state: 'WAITING_ON_VENDOR',
        updatedAt: VERSION_3,
      })),
    );
    const harness = makeExecutor({ runOperation: script.runOperation });
    const prepared = prepareUpdate(harness.executor, { title: 'Local title' });

    expect(requireUpdateOutcome(await harness.executor.dispatch(prepared, {
      local_id: prior.id,
      prior,
      current,
    }))).toMatchObject({ applied: 'pushed', verified: true });

    expect(script.invocations.map((i) => i.operationKey)).toEqual(['task.read', 'task.update']);
    expect(readTask(prior.id)).toMatchObject({
      title: 'Local title',
      state: 'WAITING_ON_VENDOR',
      source_version_token: VERSION_3,
    });
  });

  it('leaves failed writes pending and increments attempts while unioning dirty fields on re-dispatch', async () => {
    const prior = seedTask({
      id: 'task-write-failure',
      source_record_id: 'rid-failure',
      title: 'Base title',
      state: 'OPEN',
      source_version_token: 'v1',
    });
    const current = rewriteTask(prior, { title: 'Local title' });
    const firstScript = scriptedOperation(
      opOk(vendorTask('rid-failure', { title: 'Base title', state: 'OPEN', updatedAt: VERSION_1 })),
      opError('error', 'gateway write failed'),
    );
    const firstHarness = makeExecutor({ runOperation: firstScript.runOperation });
    const firstPrepared = prepareUpdate(firstHarness.executor, { title: 'Local title' });

    expect(requireDispatchFailure(await firstHarness.executor.dispatch(firstPrepared, {
      local_id: prior.id,
      prior,
      current,
    }))).toMatchObject({
      kind: 'error',
      staged: true,
      reason: 'gateway write failed',
    });
    expect(readTask(prior.id).pending_write).toMatchObject({
      state: 'pending',
      dirty_fields: ['title'],
      attempts: 1,
    });

    const retryPrior = readTask(prior.id);
    const retryCurrent = rewriteTask(retryPrior, { state: 'BLOCKED' }, NOW + 2);
    const retryScript = scriptedOperation(
      opOk(vendorTask('rid-failure', { title: 'Base title', state: 'OPEN', updatedAt: VERSION_1 })),
      opError('error', 'still failing'),
    );
    const retryHarness = makeExecutor({ runOperation: retryScript.runOperation });
    const retryPrepared = prepareUpdate(retryHarness.executor, { state: 'BLOCKED' });

    expect(requireDispatchFailure(await retryHarness.executor.dispatch(retryPrepared, {
      local_id: retryPrior.id,
      prior: retryPrior,
      current: retryCurrent,
    }))).toMatchObject({ kind: 'error', staged: true });
    expect(readTask(prior.id).pending_write).toMatchObject({
      state: 'pending',
      dirty_fields: ['title', 'state'],
      attempts: 2,
    });
  });

  it('falls back to a verify read when the write response is unprojectable and restages awaiting_verify when that read fails', async () => {
    const prior = seedTask({
      id: 'task-verify-fallback',
      source_record_id: 'rid-verify',
      title: 'Base title',
      state: 'OPEN',
      source_version_token: 'v1',
    });
    const current = rewriteTask(prior, { title: 'Local title' });
    const script = scriptedOperation(
      opOk(vendorTask('rid-verify', { title: 'Base title', state: 'OPEN', updatedAt: VERSION_1 })),
      opOk({ id: 'rid-verify' }),
      opError('error', 'verify read failed'),
    );
    const harness = makeExecutor({ runOperation: script.runOperation });
    const prepared = prepareUpdate(harness.executor, { title: 'Local title' });

    const outcome = requireUpdateOutcome(await harness.executor.dispatch(prepared, {
      local_id: prior.id,
      prior,
      current,
    }));

    expect(outcome).toMatchObject({
      ok: true,
      operation: 'update',
      applied: 'pushed',
      verified: false,
    });
    expect(script.invocations.map((i) => ({
      operationKey: i.operationKey,
      stepId: i.stepId,
      args: i.args,
    }))).toEqual([
      { operationKey: 'task.read', stepId: 'write_preflight', args: { taskId: 'rid-verify' } },
      {
        operationKey: 'task.update',
        stepId: 'source_write',
        args: {
          taskId: 'rid-verify',
          'body.properties': { hs_task_subject: 'Local title' },
        },
      },
      { operationKey: 'task.read', stepId: 'write_verify', args: { taskId: 'rid-verify' } },
    ]);
    expect(readTask(prior.id).pending_write).toMatchObject({
      state: 'awaiting_verify',
      dirty_fields: ['title'],
    });
  });
});

describe('dispatch — container-scoped conditional write (D-192 write-slot container scoping)', () => {
  // A read_write Source whose vendor record lives UNDER a persisted container
  // (MS To Do's task under a `todoTaskListId`) and whose writes are ETag-conditional.
  // The container id is a `resolve: 'persist'` source dependency that binds BOTH the
  // read AND the write ops — the write path must fold the SAME stored id the sync
  // walk uses into the read-before-write preflight AND the narrow write, alongside
  // the id_arg + the If-Match precondition. Without the write-slot fold the update
  // PATCHes `/lists//tasks/{task}` (dropped container) and 404s.
  const containerDeclaration = (): KernelWorkEntitySourceDeclaration => taskDeclaration({
    remote: {
      entity: 'task',
      id: 'id',
      version: { kind: 'etag', field: 'etag' },
      hash_fields: ['properties.hs_task_subject', 'properties.hs_task_status', 'properties.hs_task_body'],
    },
    op_bindings: {
      read: { id_arg: 'taskId' },
      update: { id_arg: 'taskId', precondition_arg: 'header.If-Match' },
    },
    source_dependencies: [{
      ref: 'list',
      list_op: 'task_list.search',
      id_field: 'id',
      label_field: 'displayName',
      binds: [
        { op: 'list', arg: 'list_id' },
        { op: 'read', arg: 'list_id' },
        { op: 'update', arg: 'list_id' },
      ],
      resolve: 'persist',
    }] as WorkEntitySourceDependency[],
    write_policy: {
      conditional_write: 'etag',
      stale_write: 'manual_merge',
      field_conflicts: 'manual_merge',
    },
  });

  // A vendor task row carrying a flat `etag` version field (unlike `updatedAt`).
  const containerVendorTask = (
    etag: string,
    title = 'Base title',
  ): Record<string, unknown> => vendorTask('rid-c', {
    title,
    state: 'OPEN',
    updatedAt: UPDATED_ISO,
    extra: { etag },
  });

  it('threads the persisted container id into the preflight read AND the narrow write, with the If-Match token', async () => {
    const declaration = containerDeclaration();
    const prior = seedTask({
      id: 'task-container',
      source_record_id: 'rid-c',
      title: 'Base title',
      state: 'OPEN',
      // The vendor-current etag equals the stored base token → an `unchanged`
      // verdict (compareVendorState short-circuit) → clean push, so the test
      // asserts the write args, not the conflict machinery.
      source_version_token: 'etag-1',
    });
    const current = rewriteTask(prior, { title: 'Local title' });
    const script = scriptedOperation(
      opOk(containerVendorTask('etag-1')),                    // preflight read
      opOk(containerVendorTask('etag-2', 'Local title')),     // write response (verify)
    );
    const harness = makeExecutor({
      declaration,
      runOperation: script.runOperation,
      dependencyStore: selectionStore({ list: 'list-123' }),
    });
    const prepared = prepareUpdate(harness.executor, { title: 'Local title' });

    expect(requireUpdateOutcome(await harness.executor.dispatch(prepared, {
      local_id: prior.id,
      prior,
      current,
    }))).toMatchObject({ applied: 'pushed', verified: true });

    expect(script.invocations.map((i) => ({ operationKey: i.operationKey, args: i.args }))).toEqual([
      // Read-before-write — the persisted container id rides flat next to the record id.
      { operationKey: 'task.read', args: { list_id: 'list-123', taskId: 'rid-c' } },
      // Narrow write — container id + record id + If-Match(vendor-current etag) + body.
      {
        operationKey: 'task.update',
        args: {
          list_id: 'list-123',
          taskId: 'rid-c',
          'header.If-Match': 'etag-1',
          'body.properties': { hs_task_subject: 'Local title' },
        },
      },
    ]);
  });

  it('config-fails the write BEFORE any side effect when a write-bound container has no persisted selection', () => {
    const { executor, stageCalls } = makeExecutor({
      declaration: containerDeclaration(),
      // No selection for the `list` dependency → the vendor record cannot be addressed.
      dependencyStore: selectionStore({}),
    });
    expect(executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'update',
      patch: { title: 'Local title' },
    })).toMatchObject({
      ok: false,
      kind: 'config',
      reason: expect.stringContaining('no selection for the update op'),
    });
    expect(stageCalls).toHaveLength(0);
  });

  it('resolves the container under the EFFECTIVE update slot when complete falls back to update', () => {
    // No dedicated `ops.complete` → `complete` dispatches through the UPDATE op +
    // binding (resolveOp fallback), so the container is bound to `update`, not
    // `complete`. The write prepare must resolve the container for the EFFECTIVE slot;
    // a `complete`-keyed lookup would find no binds and 404 on the container-less URL.
    const declaration = containerDeclaration();
    expect(declaration.ops.complete).toBeUndefined();
    const harness = makeExecutor({
      declaration,
      dependencyStore: selectionStore({ list: 'list-123' }),
    });
    const prepared = requirePrepared(harness.executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'complete',
      patch: { state: 'completed' },
    }));
    expect(prepared.writeOp.opKey).toBe('task.update'); // the fallback op
    expect(prepared.writeOp.configArgs).toEqual({ list_id: 'list-123' });
  });
});

describe('sync dirty-row guard', () => {
  it('skips pending rows, folds awaiting_verify rows, and clears unchanged awaiting_verify rows', async () => {
    const declaration = taskDeclaration();
    seedSyncState(declaration);

    const pending = upsertRawTask(vendorTask('rid-pending', {
      title: 'Vendor pending base',
      state: 'OPEN',
      updatedAt: VERSION_1,
    }), declaration);
    const pendingLocal = rewriteTask(pending, { title: 'Local pending title' });
    store.stagePendingWrite('task', pendingLocal.id, {
      staged_at: NOW,
      operation: 'update',
      dirty_fields: ['title'],
      base_source_updated_at: pending.source_updated_at ?? null,
      base_source_record_hash: pending.source_record_hash ?? null,
      base_source_version_token: pending.source_version_token ?? null,
      state: 'pending',
      attempts: 1,
    });

    const awaitingChanged = upsertRawTask(vendorTask('rid-awaiting-changed', {
      title: 'Awaiting old',
      state: 'OPEN',
      updatedAt: VERSION_1,
    }), declaration);
    store.stagePendingWrite('task', awaitingChanged.id, {
      staged_at: NOW,
      operation: 'update',
      dirty_fields: ['title'],
      base_source_updated_at: awaitingChanged.source_updated_at ?? null,
      base_source_record_hash: awaitingChanged.source_record_hash ?? null,
      base_source_version_token: awaitingChanged.source_version_token ?? null,
      state: 'awaiting_verify',
      attempts: 1,
    });

    const unchangedRecord = vendorTask('rid-awaiting-unchanged', {
      title: 'Awaiting unchanged',
      state: 'OPEN',
      updatedAt: VERSION_1,
    });
    const awaitingUnchanged = upsertRawTask(unchangedRecord, declaration);
    store.stagePendingWrite('task', awaitingUnchanged.id, {
      staged_at: NOW,
      operation: 'update',
      dirty_fields: ['title'],
      base_source_updated_at: awaitingUnchanged.source_updated_at ?? null,
      base_source_record_hash: awaitingUnchanged.source_record_hash ?? null,
      base_source_version_token: awaitingUnchanged.source_version_token ?? null,
      state: 'awaiting_verify',
      attempts: 1,
    });

    const fetch = scriptedFetch(okFetch([
      vendorTask('rid-pending', {
        title: 'Vendor pending changed',
        state: 'OPEN',
        updatedAt: VERSION_2,
      }),
      vendorTask('rid-awaiting-changed', {
        title: 'Awaiting vendor folded',
        state: 'WAITING',
        updatedAt: VERSION_2,
      }),
      unchangedRecord,
    ]));

    const result = await runWorkEntitySourceSync({
      fetchDeps: fetchDeps(),
      mirror,
      syncState,
      now: () => NOW + 10,
      runFetch: fetch.runFetch,
    }, {
      source_id: SOURCE_ID,
      connection_name: CONNECTION,
      declaration,
    });

    expect(result).toMatchObject({
      ok: true,
      upserted: 1,
      unchanged: 1,
      skipped_dirty: 1,
      failed_rows: 0,
    });
    expect(readTask(pending.id)).toMatchObject({
      title: 'Local pending title',
      pending_write: expect.objectContaining({ state: 'pending' }),
    });
    expect(readTask(awaitingChanged.id)).toMatchObject({
      title: 'Awaiting vendor folded',
      state: 'WAITING',
    });
    expect(readTask(awaitingChanged.id).pending_write).toBeUndefined();
    expect(readTask(awaitingUnchanged.id).pending_write).toBeUndefined();
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]).toMatchObject({
      operationKey: 'task.list',
      stepId: 'source_sync',
      resultPath: 'records',
    });
  });
});

describe('dispatcher integration', () => {
  it('taskUpdate pushes through a real executor, preserves local edits on vendor failure, and maps conflicts to typed errors', async () => {
    const resolver = createWorkEntityResolver(store);
    let executorRef: WorkEntitySourceWriteExecutor | null = null;
    const dispatchers = createWorkEntityDispatchers({
      store,
      resolver,
      getWriteExecutor: () => executorRef,
      now: () => NOW + 100,
    });

    const okPrior = seedTask({
      id: 'task-dispatch-ok',
      source_record_id: 'rid-dispatch-ok',
      title: 'Dispatch base',
      state: 'OPEN',
      done: true,
      source_version_token: VERSION_1,
    });
    const okScript = scriptedOperation(
      opOk(vendorTask('rid-dispatch-ok', {
        title: 'Dispatch base',
        state: 'OPEN',
        updatedAt: VERSION_1,
      })),
      opOk(vendorTask('rid-dispatch-ok', {
        title: 'Dispatcher vendor title',
        state: 'DONE',
        body: 'Dispatcher vendor preview',
        updatedAt: VERSION_2,
      })),
    );
    executorRef = makeExecutor({
      runOperation: okScript.runOperation,
      now: () => NOW + 100,
    }).executor;

    const ok = await dispatchers.taskUpdate({
      id: okPrior.id,
      title: 'Dispatcher local title',
      body: 'Dispatcher local body',
      parent_project_id: 'dispatcher-project',
    });

    expect(ok.task).toMatchObject({
      id: okPrior.id,
      title: 'Dispatcher vendor title',
      state: 'DONE',
      body: 'Dispatcher local body',
      parent_project_id: 'dispatcher-project',
    });
    expect(ok.task.pending_write).toBeUndefined();
    expect(okScript.invocations.map((i) => i.operationKey)).toEqual(['task.read', 'task.update']);

    const failurePrior = seedTask({
      id: 'task-dispatch-failure',
      source_record_id: 'rid-dispatch-failure',
      title: 'Failure base',
      state: 'OPEN',
      source_version_token: VERSION_1,
    });
    const failureScript = scriptedOperation(
      opOk(vendorTask('rid-dispatch-failure', {
        title: 'Failure base',
        state: 'OPEN',
        updatedAt: VERSION_1,
      })),
      opError('error', 'vendor unavailable'),
    );
    executorRef = makeExecutor({
      runOperation: failureScript.runOperation,
      now: () => NOW + 100,
    }).executor;

    await expect(dispatchers.taskUpdate({
      id: failurePrior.id,
      title: 'Failure local title',
    })).rejects.toBeInstanceOf(WorkEntityVendorWriteError);

    expect(readTask(failurePrior.id)).toMatchObject({
      title: 'Failure local title',
      pending_write: expect.objectContaining({
        state: 'pending',
        dirty_fields: ['title'],
      }),
    });

    const conflictPrior = seedTask({
      id: 'task-dispatch-conflict',
      source_record_id: 'rid-dispatch-conflict',
      title: 'Conflict base',
      state: 'OPEN',
      source_version_token: VERSION_1,
    });
    const conflictScript = scriptedOperation(opOk(vendorTask('rid-dispatch-conflict', {
      title: 'Vendor conflict title',
      state: 'OPEN',
      updatedAt: VERSION_2,
    })));
    executorRef = makeExecutor({
      runOperation: conflictScript.runOperation,
      now: () => NOW + 100,
    }).executor;

    try {
      await dispatchers.taskUpdate({
        id: conflictPrior.id,
        title: 'Conflict local title',
      });
      throw new Error('expected taskUpdate conflict to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(WorkEntityWriteConflictError);
      if (e instanceof WorkEntityWriteConflictError) {
        expect(e.conflicting_fields).toEqual(['title']);
      }
    }
    expect(readTask(conflictPrior.id)).toMatchObject({
      title: 'Conflict local title',
      pending_write: expect.objectContaining({
        state: 'pending',
        dirty_fields: ['title'],
      }),
    });
  });
});

describe('dispatch create — source-dependency create args (Slice 5)', () => {
  /** The HubSpot base + a workspace persist dep that scopes the walk AND
   *  attributes a create (binds both `list` and `create`). Create args are FLAT
   *  wire keys (a graphql-shaped container) — the composer passes them through
   *  flat alongside the pushable body. */
  const depDeclaration = (): KernelWorkEntitySourceDeclaration => taskDeclaration({
    source_dependencies: [
      {
        ref: 'workspace', list_op: 'w.search', id_field: 'gid', label_field: 'name',
        binds: [
          { op: 'list', arg: 'query.workspace' },
          { op: 'create', arg: 'workspace_id' },
        ],
        resolve: 'persist',
      },
    ],
  });

  /** An Asana-shaped REST source: write_paths are EXECUTOR-LOCAL body paths
   *  (`data.name`, not `body.data.name`) and the workspace persist dep attributes
   *  the create via the 2-level `body.data.workspace`. Proves Slice 6c's nested-
   *  body composition — pushable fields + create-attribute args all land inside
   *  ONE `body.data` object. */
  const nestedDepDeclaration = (): KernelWorkEntitySourceDeclaration => taskDeclaration({
    write_paths: { title: 'data.name', state: 'data.status', due_at: 'data.due', body: 'data.notes' },
    source_dependencies: [
      {
        ref: 'workspace', list_op: 'w.search', id_field: 'gid', label_field: 'name',
        binds: [
          { op: 'list', arg: 'query.workspace' },
          { op: 'create', arg: 'body.data.workspace' },
        ],
        resolve: 'persist',
      },
    ],
  });

  it('merges the persisted container selection into the create op args', async () => {
    const script = scriptedOperation(opOk(vendorTask('created')));
    const { executor } = makeExecutor({
      declaration: depDeclaration(),
      dependencyStore: selectionStore({ workspace: 'w1' }),
      runOperation: script.runOperation,
    });
    const prepared = requirePrepared(executor.prepare({
      source_id: SOURCE_ID, kind: 'task', operation: 'create', patch: { title: 'T' },
    }));
    requireCreateOutcome(await executor.dispatch(prepared));
    expect(script.invocations[0]?.args['workspace_id']).toBe('w1');
    // the pushable body still rides alongside — the create-arg is additive, flat.
    expect(script.invocations[0]?.args['body.properties']).toMatchObject({ hs_task_subject: 'T' });
  });

  it('config-fails when a create-bound persist dep has no selection', () => {
    const { executor } = makeExecutor({
      declaration: depDeclaration(),
      dependencyStore: selectionStore({}), // no workspace selected
    });
    const result = executor.prepare({
      source_id: SOURCE_ID, kind: 'task', operation: 'create', patch: { title: 'T' },
    });
    expect(result).toMatchObject({ ok: false, kind: 'config' });
    if (result.ok) return;
    expect(result.reason).toContain('workspace');
  });

  it('merges passed-in prompt-resolved container ids (dependencyCreateArgs)', async () => {
    const script = scriptedOperation(opOk(vendorTask('created')));
    const { executor } = makeExecutor({
      declaration: depDeclaration(),
      dependencyStore: selectionStore({ workspace: 'w1' }),
      runOperation: script.runOperation,
    });
    const prepared = requirePrepared(executor.prepare({
      source_id: SOURCE_ID, kind: 'task', operation: 'create', patch: { title: 'T' },
      dependencyCreateArgs: { project_id: 'pNew' },
    }));
    requireCreateOutcome(await executor.dispatch(prepared));
    expect(script.invocations[0]?.args['workspace_id']).toBe('w1');
    expect(script.invocations[0]?.args['project_id']).toBe('pNew');
  });

  it('config-fails on a create-arg collision across sources (one authority per arg)', () => {
    const { executor } = makeExecutor({
      declaration: depDeclaration(),
      dependencyStore: selectionStore({ workspace: 'w1' }),
    });
    // the passed-in dependencyCreateArgs collides with the persist dep's arg key.
    const result = executor.prepare({
      source_id: SOURCE_ID, kind: 'task', operation: 'create', patch: { title: 'T' },
      dependencyCreateArgs: { workspace_id: 'other' },
    });
    expect(result).toMatchObject({ ok: false, kind: 'config' });
    if (result.ok) return;
    expect(result.reason).toContain('workspace_id');
  });

  it('nests pushable + persist + prompt create args under one body.data (Slice 6c REST body)', async () => {
    const script = scriptedOperation(opOk(vendorTask('created')));
    const { executor } = makeExecutor({
      declaration: nestedDepDeclaration(),
      dependencyStore: selectionStore({ workspace: 'w1' }),
      runOperation: script.runOperation,
    });
    const prepared = requirePrepared(executor.prepare({
      source_id: SOURCE_ID, kind: 'task', operation: 'create', patch: { title: 'T', body: 'B' },
      // the prompt-resolved project id — array-wrapped by the resolver's wrap_array bind.
      dependencyCreateArgs: { 'body.data.projects': ['pGid'] },
    }));
    requireCreateOutcome(await executor.dispatch(prepared));
    // pushable body fields + the persist workspace + the prompt project id all
    // compose into ONE body.data object — never the flat literal-dot keys the
    // adapter would drop outside `data`.
    expect(script.invocations[0]?.args).toEqual({
      'body.data': { name: 'T', notes: 'B', workspace: 'w1', projects: ['pGid'] },
    });
    expect(Object.keys(script.invocations[0]?.args ?? {})).not.toContain('body.data.workspace');
  });

  it('without a dependency store the create args stay untouched (backward-compat)', async () => {
    const script = scriptedOperation(opOk(vendorTask('created')));
    const { executor } = makeExecutor({ declaration: depDeclaration(), runOperation: script.runOperation });
    const prepared = requirePrepared(executor.prepare({
      source_id: SOURCE_ID, kind: 'task', operation: 'create', patch: { title: 'T' },
    }));
    requireCreateOutcome(await executor.dispatch(prepared));
    expect(script.invocations[0]?.args['workspace_id']).toBeUndefined();
  });
});

describe('resolveCreateDependencies — create-assist preflight (Slice 6a, pick-only)', () => {
  // A `team` PROMPT dependency binding the create's `teamId` (Linear's shape) —
  // pick-only (no create_op). Flat wire key, resolved live at create time.
  const TEAM_MANIFEST = {
    ...manifestFake,
    operations: {
      ...(manifestFake as unknown as { operations: Record<string, unknown> }).operations,
      'team.search': op('team.search', 'read', 'teams'),
    },
  } as unknown as IngredientManifest;
  const teamDep: WorkEntitySourceDependency = {
    ref: 'team', list_op: 'team.search', id_field: 'id', label_field: 'name',
    binds: [{ op: 'create', arg: 'teamId' }], resolve: 'prompt',
  };
  const teamDeclaration = (): KernelWorkEntitySourceDeclaration =>
    taskDeclaration({ source_dependencies: [teamDep] });

  let depDb: Database.Database;
  let depStore: SourceDependencyEntityStore;
  beforeEach(() => {
    depDb = new Database(':memory:');
    ensureSourceDependencyEntitySchema(depDb);
    depStore = createSourceDependencyEntityStore(depDb);
  });
  afterEach(() => depDb.close());

  const mkExecutor = (teams: Array<Record<string, unknown>>, opts: {
    declaration?: KernelWorkEntitySourceDeclaration; wireStore?: boolean;
  } = {}) => {
    const script = scriptedOperation(opOk({ teams }));
    const { executor } = makeExecutor({
      declaration: opts.declaration ?? teamDeclaration(),
      deps: fetchDeps({ manifest: TEAM_MANIFEST }),
      runOperation: script.runOperation,
      ...(opts.wireStore === false ? {} : { dependencyStore: depStore }),
    });
    return { executor, script };
  };

  it('auto-resolves a LONE team and binds its id into the create args (zero config)', async () => {
    const { executor, script } = mkExecutor([{ id: 't1', name: 'Engineering' }]);
    const out = await executor.resolveCreateDependencies({ source_id: SOURCE_ID, kind: 'task' });
    expect(out).toEqual({ ok: true, createArgs: { teamId: 't1' }, plannedCreates: [] });
    // the team list was fetched (a read-tier gated invoke)
    expect(script.invocations[0]?.operationKey).toBe('team.search');
  });

  it('resolves a STORED selection without re-fetching', async () => {
    depStore.replaceEntities(SOURCE_ID, 'team', [{ entity_pk: 't2', label: 'Design' }], { now: 0 });
    depStore.select(SOURCE_ID, 'team', 't2');
    // even with two teams live, the stored pick wins and still binds.
    const { executor } = mkExecutor([{ id: 't1', name: 'Eng' }, { id: 't2', name: 'Design' }]);
    const out = await executor.resolveCreateDependencies({ source_id: SOURCE_ID, kind: 'task' });
    expect(out).toEqual({ ok: true, createArgs: { teamId: 't2' }, plannedCreates: [] });
  });

  it('a caller-named team label-matches to a pick', async () => {
    const { executor } = mkExecutor([{ id: 't1', name: 'Engineering' }, { id: 't2', name: 'Design' }]);
    const out = await executor.resolveCreateDependencies({
      source_id: SOURCE_ID, kind: 'task', named: { team: '  design ' },
    });
    expect(out).toEqual({ ok: true, createArgs: { teamId: 't2' }, plannedCreates: [] });
  });

  it('an AMBIGUOUS team (multiple, none named/stored) returns an ask — never creates', async () => {
    const { executor } = mkExecutor([{ id: 't1', name: 'Eng' }, { id: 't2', name: 'Design' }]);
    const out = await executor.resolveCreateDependencies({ source_id: SOURCE_ID, kind: 'task' });
    expect(out).toMatchObject({ ok: false, kind: 'ask' });
    if (out.ok || out.kind !== 'ask') return;
    // pick-only: can_create is false even though the option set is offered.
    expect(out.ask).toMatchObject({ ref: 'team', can_create: false });
    expect(out.ask.options).toHaveLength(2);
  });

  it('returns empty args when NO dependency store is wired (byte-identical)', async () => {
    const { executor, script } = mkExecutor([{ id: 't1', name: 'Eng' }], { wireStore: false });
    const out = await executor.resolveCreateDependencies({ source_id: SOURCE_ID, kind: 'task' });
    expect(out).toEqual({ ok: true, createArgs: {}, plannedCreates: [] });
    expect(script.invocations).toHaveLength(0); // no fetch
  });

  it('returns empty args for a source with NO prompt-create dependency (fast path)', async () => {
    const { executor, script } = mkExecutor([{ id: 't1', name: 'Eng' }], { declaration: taskDeclaration() });
    const out = await executor.resolveCreateDependencies({ source_id: SOURCE_ID, kind: 'task' });
    expect(out).toEqual({ ok: true, createArgs: {}, plannedCreates: [] });
    expect(script.invocations).toHaveLength(0); // no fetch — fast path
  });

  it('returns empty args for a read_only source (the write itself surfaces that)', async () => {
    const readOnly = taskDeclaration({
      sync: { mode: 'read_only', depth: 'meta', tombstones: 'none', stale_after_ms: 1 },
      source_dependencies: [teamDep],
    });
    const { executor } = mkExecutor([{ id: 't1', name: 'Eng' }], { declaration: readOnly });
    const out = await executor.resolveCreateDependencies({ source_id: SOURCE_ID, kind: 'task' });
    expect(out).toEqual({ ok: true, createArgs: {}, plannedCreates: [] });
  });
});

describe('resolveCreateDependencies + executeCreatePlan — container create-if-not-picked (Slice 6c)', () => {
  // A `project` PROMPT dep with a create_op (Asana-shaped): bare-callable list, a
  // REST nested-body create keyed by `body.data.name`, binding the array-typed
  // `body.data.projects`.
  const PROJECT_MANIFEST = {
    ...manifestFake,
    operations: {
      ...(manifestFake as unknown as { operations: Record<string, unknown> }).operations,
      'project.search': op('project.search', 'read', 'data'),
      'project.create': op('project.create', 'write', 'data'),
    },
  } as unknown as IngredientManifest;
  const projectDep: WorkEntitySourceDependency = {
    ref: 'project', list_op: 'project.search', id_field: 'gid', label_field: 'name',
    create_op: 'project.create', create_name_arg: 'body.data.name',
    binds: [{ op: 'create', arg: 'body.data.projects', wrap_array: true }], resolve: 'prompt',
  };
  const projectDeclaration = (): KernelWorkEntitySourceDeclaration =>
    taskDeclaration({ source_dependencies: [projectDep] });

  let depDb: Database.Database;
  let depStore: SourceDependencyEntityStore;
  beforeEach(() => {
    depDb = new Database(':memory:');
    ensureSourceDependencyEntitySchema(depDb);
    depStore = createSourceDependencyEntityStore(depDb);
  });
  afterEach(() => depDb.close());

  /** Wire an executor over an EXPLICIT scripted-outcome queue (decide fetches only
   *  the list; executeCreatePlan invokes only the create — so each test scripts
   *  exactly the ops its flow consumes, in order). */
  const mkExecutor = (outcomes: GatedCatalogOperationOutcome[], grantedOps?: string[]) => {
    const script = scriptedOperation(...outcomes);
    const { executor } = makeExecutor({
      declaration: projectDeclaration(),
      deps: fetchDeps({
        manifest: PROJECT_MANIFEST,
        profile: {
          allowed_operations: grantedOps ?? ['project.search', 'project.create'],
          catalog_slug: CATALOG,
        },
      }),
      runOperation: script.runOperation,
      dependencyStore: depStore,
    });
    return { executor, script };
  };
  const listOf = (...projects: Array<Record<string, unknown>>): GatedCatalogOperationOutcome =>
    opOk({ data: projects });
  const createdProject = (rec: Record<string, unknown>): GatedCatalogOperationOutcome =>
    opOk({ data: rec });

  it('a GRANTED create_op + a named container that is absent → a create PLAN (decide-only)', async () => {
    const { executor, script } = mkExecutor([listOf({ gid: 'p0', name: 'Old' })]);
    const out = await executor.resolveCreateDependencies({
      source_id: SOURCE_ID, kind: 'task', named: { project: 'Roadmap' },
    });
    expect(out).toMatchObject({ ok: true, createArgs: {} }); // no id bound — not created yet
    if (!out.ok) return;
    expect(out.plannedCreates).toMatchObject([
      { ref: 'project', create_op: 'project.create', name: 'Roadmap' },
    ]);
    // the nested REST body composed at decide time, ready to invoke on approval
    expect(out.plannedCreates[0]!.args).toEqual({ 'body.data': { name: 'Roadmap' } });
    // the list was fetched (read) but NO gated create fired — decide is side-effect-free
    expect(script.invocations.map((i) => i.operationKey)).toEqual(['project.search']);
  });

  it('an UNGRANTED create_op degrades to pick-only (grant-driven authorization)', async () => {
    // project.create is NOT in allowed_operations → the named-absent container
    // cannot be planned; the resolver offers a pick-only ask instead.
    const { executor } = mkExecutor([listOf({ gid: 'p0', name: 'Old' })], ['project.search']);
    const out = await executor.resolveCreateDependencies({
      source_id: SOURCE_ID, kind: 'task', named: { project: 'Roadmap' },
    });
    expect(out).toMatchObject({ ok: false, kind: 'ask' });
    if (out.ok || out.kind !== 'ask') return;
    expect(out.ask).toMatchObject({ ref: 'project', can_create: false });
  });

  it('executeCreatePlan runs the gated create + persists the created container as the selection', async () => {
    const { executor, script } = mkExecutor([createdProject({ gid: 'pNew', name: 'Roadmap' })]);
    const plan = {
      ref: 'project', create_op: 'project.create', name: 'Roadmap',
      args: { 'body.data': { name: 'Roadmap' } }, result_path: 'data', id_field: 'gid',
    };
    const res = await executor.executeCreatePlan({ source_id: SOURCE_ID, kind: 'task', plan });
    expect(res).toEqual({ ok: true, entity_pk: 'pNew' });
    // the gated WRITE fired with the plan's composed args
    expect(script.invocations.map((i) => i.operationKey)).toEqual(['project.create']);
    expect(script.invocations[0]?.args).toEqual({ 'body.data': { name: 'Roadmap' } });
    // and persisted the selection so the create's re-run auto-resolves it as a pick
    expect(depStore.getSelected(SOURCE_ID, 'project')).toMatchObject({ entity_pk: 'pNew', label: 'Roadmap' });
  });

  it('after executeCreatePlan, a re-run resolves the container as a PICK (no second create)', async () => {
    const created = mkExecutor([createdProject({ gid: 'pNew', name: 'Roadmap' })]);
    await created.executor.executeCreatePlan({
      source_id: SOURCE_ID, kind: 'task',
      plan: { ref: 'project', create_op: 'project.create', name: 'Roadmap', args: { 'body.data': { name: 'Roadmap' } }, result_path: 'data', id_field: 'gid' },
    });
    // a fresh resolve (the re-run) over the SAME store finds the stored selection →
    // the container binds as a pick; nothing is planned, no second create fires. The
    // re-run passes NO `named` (it relies on the stored selection, like container-
    // pick), and the vendor's post-create list now includes the new project (so the
    // selection survives the list fetch's cache replace).
    const reRun = mkExecutor([listOf({ gid: 'p0', name: 'Old' }, { gid: 'pNew', name: 'Roadmap' })]);
    const out = await reRun.executor.resolveCreateDependencies({ source_id: SOURCE_ID, kind: 'task' });
    expect(out).toEqual({ ok: true, createArgs: { 'body.data.projects': ['pNew'] }, plannedCreates: [] });
    expect(reRun.script.invocations.some((i) => i.operationKey === 'project.create')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// D-192 — the post-write ASSERT (§8.3). Before this, `composeVerifiedUpsert`
// let the VENDOR's value win for every declared canonical field, so a write that
// never landed folded the vendor's stale value back OVER the user's edit,
// cleared the pending write, and returned `verified: true`. These tests exist to
// prove the guard BITES — and, just as importantly, that it does not false-fail
// the two legitimate cases (vendor normalisation, and lossy date granularity).
// ────────────────────────────────────────────────────────────────

describe('post-write verify — assert the write LANDED', () => {
  it('REFUSES a write the vendor never applied (the mis-mapped write_paths bug) and keeps the local edit', async () => {
    // The canonical bug: `write_paths: { title: 'type' }` sends the user's value
    // into the WRONG vendor field. The vendor's `title` source path therefore
    // re-projects UNCHANGED. Simulated here by a write response whose title is
    // still the PRIOR value while we pushed a different one.
    const prior = seedTask({
      id: 'task-unlanded',
      source_record_id: 'rid-unlanded',
      title: 'Base title',
      source_version_token: VERSION_1,
      source_updated_at: NOW - 50_000,
      source_record_hash: 'hash-before',
    });
    const current = rewriteTask(prior, { title: 'Local title' });
    const script = scriptedOperation(
      opOk(vendorTask('rid-unlanded', { title: 'Base title', updatedAt: VERSION_1 })),
      // write "succeeds" — but the title never moved.
      opOk(vendorTask('rid-unlanded', { title: 'Base title', updatedAt: VERSION_2 })),
    );
    const recordDeterministicVerification = vi.fn();
    const harness = makeExecutor({
      runOperation: script.runOperation,
      recordDeterministicVerification,
      getDeterministicVerificationContext: () => ({
        session_id: 'chat-session',
        turn_id: 'chat-turn',
      }),
    });
    const prepared = prepareUpdate(harness.executor, { title: 'Local title' });

    const outcome = requireDispatchFailure(
      await harness.executor.dispatch(prepared, { local_id: prior.id, prior, current }),
    );

    expect(outcome).toMatchObject({
      ok: false,
      kind: 'verify_failed',
      unlanded_fields: ['title'],
      staged: true,
    });
    // The old code folded the vendor's stale 'Base title' back over the edit and
    // reported verified:true. The user's edit must SURVIVE.
    expect(readTask(prior.id).title).toBe('Local title');
    // Skipping `storeVerified` is what preserves the edit — it is the same call
    // that clears the pending write, so the row stays honest dirty state.
    expect(harness.stageCalls).toHaveLength(1);
    expect(harness.stageCalls[0]).toMatchObject({ pending: { state: 'pending' } });
    expect(recordDeterministicVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'chat-session',
        turn_id: 'chat-turn',
        kind: 'failed',
        postcondition_key: 'work_entity_vendor:task:update',
      }),
    );
  });

  it('FOLDS a value the vendor normalised (it moved the field) — an exact echo is NOT required', async () => {
    // A vendor legitimately trims / truncates / title-cases / templates what it
    // accepts. The field MOVED off its prior value, so the write landed and the
    // normalised result is the truth. Demanding an exact byte-echo here would
    // false-fail every such vendor.
    const prior = seedTask({
      id: 'task-normalised',
      source_record_id: 'rid-normalised',
      title: 'Base title',
      source_version_token: VERSION_1,
      source_updated_at: NOW - 50_000,
      source_record_hash: 'hash-before',
    });
    const current = rewriteTask(prior, { title: '  Local title  ' });
    const script = scriptedOperation(
      opOk(vendorTask('rid-normalised', { title: 'Base title', updatedAt: VERSION_1 })),
      opOk(vendorTask('rid-normalised', { title: 'Local title', updatedAt: VERSION_2 })),
    );
    const harness = makeExecutor({ runOperation: script.runOperation });
    const prepared = prepareUpdate(harness.executor, { title: '  Local title  ' });

    const outcome = requireUpdateOutcome(
      await harness.executor.dispatch(prepared, { local_id: prior.id, prior, current }),
    );

    expect(outcome).toMatchObject({ ok: true, applied: 'pushed', verified: true });
    expect(readTask(prior.id).title).toBe('Local title'); // the vendor's trimmed form wins
  });
});

describe('post-write verify — lossy fields must not false-fail', () => {
  const transformDecl = (): KernelWorkEntitySourceDeclaration => taskDeclaration({
    projection: {
      canonical: {
        title: 'properties.hs_task_subject',
        state: 'properties.hs_task_status',
        due_at: 'properties.hs_timestamp',
      },
      preview: { body: { field: 'properties.hs_task_body', max_chars: 800 } },
    },
    writable_fields: ['title', 'state', 'due_at', 'body'],
    write_transforms: { due_at: { kind: 'date_format', format: 'yyyy-MM-dd' } },
  });

  it('a date_format due_at that re-reads as UTC MIDNIGHT verifies as landed', async () => {
    // THE Asana landmine: `due_at` is written date-only (`due_on`) and re-reads
    // as midnight, so the vendor can never echo the ms instant we sent. Compared
    // at WIRE fidelity both sides are the same calendar date ⇒ landed. An
    // exact-ms compare would false-fail EVERY write on such a vendor.
    const dueMs = Date.parse('2026-07-09T14:30:00.000Z'); // time-of-day precision
    const prior = seedTask({
      id: 'task-lossy',
      source_record_id: 'rid-lossy',
      title: 'Base title',
      source_version_token: VERSION_1,
      source_updated_at: NOW - 50_000,
      source_record_hash: 'hash-before',
    });
    const current = rewriteTask(prior, { due_at: dueMs });
    const script = scriptedOperation(
      opOk(vendorTask('rid-lossy', { dueAt: BASE_DUE_ISO, updatedAt: VERSION_1 })),
      // the vendor stored the DATE only — it comes back as midnight UTC.
      opOk(vendorTask('rid-lossy', { dueAt: '2026-07-09T00:00:00.000Z', updatedAt: VERSION_2 })),
    );
    const harness = makeExecutor({
      declaration: transformDecl(),
      runOperation: script.runOperation,
    });
    const prepared = prepareUpdate(harness.executor, { due_at: dueMs });

    const outcome = await harness.executor.dispatch(prepared, {
      local_id: prior.id, prior, current,
    });

    expect(outcome).toMatchObject({ ok: true, verified: true });
  });
});

describe('dispatch delete — a 2xx is not proof', () => {
  const deleteDecl = (
    overrides: Partial<KernelWorkEntitySourceDeclaration> = {},
  ): KernelWorkEntitySourceDeclaration => taskDeclaration({
    ops: { list: 'task.list', read: 'task.read', update: 'task.update', delete: 'task.delete' },
    op_bindings: {
      read: { id_arg: 'taskId' },
      update: { id_arg: 'taskId' },
      delete: { id_arg: 'taskId' },
    },
    ...overrides,
  });

  const prepareDelete = (
    executor: WorkEntitySourceWriteExecutor,
  ): WorkEntityVendorWritePrepared =>
    requirePrepared(executor.prepare({
      source_id: SOURCE_ID,
      kind: 'task',
      operation: 'delete',
      patch: {},
    }));

  const seedForDelete = (): Task => seedTask({
    id: 'task-del',
    source_record_id: 'rid-del',
    title: 'Base title',
    source_version_token: VERSION_1,
    source_updated_at: NOW - 50_000,
    source_record_hash: 'hash-before',
  });

  it('REFUSES when the record survives the delete (soft delete / mis-mapped id_arg) — the next sync would resurrect it', async () => {
    const prior = seedForDelete();
    const script = scriptedOperation(
      opOk({}),                                              // task.delete → 2xx
      opOk(vendorTask('rid-del', { title: 'Base title' })),  // read-back → STILL THERE
    );
    const harness = makeExecutor({ declaration: deleteDecl(), runOperation: script.runOperation });

    const outcome = requireDispatchFailure(
      await harness.executor.dispatch(prepareDelete(harness.executor), {
        local_id: prior.id, prior, current: prior,
      }),
    );

    expect(outcome).toMatchObject({ ok: false, kind: 'verify_failed' });
    expect(outcome.reason).toContain('still returns record');
    // The read-back must actually have been issued.
    expect(script.invocations.map((i) => i.operationKey)).toEqual(['task.delete', 'task.read']);
    expect(script.invocations[1]).toMatchObject({ stepId: 'write_verify', args: { taskId: 'rid-del' } });
  });

  it('SUCCEEDS when the read-back no longer finds the record', async () => {
    const prior = seedForDelete();
    const script = scriptedOperation(
      opOk({}),                                  // task.delete → 2xx
      opError('error', 'task.read returned 404'), // read-back → gone
    );
    const harness = makeExecutor({ declaration: deleteDecl(), runOperation: script.runOperation });

    const outcome = await harness.executor.dispatch(prepareDelete(harness.executor), {
      local_id: prior.id, prior, current: prior,
    });

    expect(outcome).toMatchObject({ ok: true, operation: 'delete' });
  });

  it('does NOT infer deletion from a TRANSIENT read failure — it refutes, it never confirms', async () => {
    // The read-back carries no HTTP status, so a 404 (gone) is indistinguishable
    // from a 500 (unknown). We therefore never invert it into "the read failed ⇒
    // the record is gone" — that would fail OPEN on a transient. A failed
    // read-back falls back to the 2xx, exactly as an unverifiable delete must.
    const prior = seedForDelete();
    const script = scriptedOperation(
      opOk({}),
      opError('unavailable', 'connection timed out'), // NOT proof of deletion
    );
    const recordDeterministicVerification = vi.fn();
    const harness = makeExecutor({
      declaration: deleteDecl(),
      runOperation: script.runOperation,
      recordDeterministicVerification,
      getDeterministicVerificationContext: () => ({
        session_id: 'chat-session',
        turn_id: 'chat-turn',
      }),
    });

    const outcome = await harness.executor.dispatch(prepareDelete(harness.executor), {
      local_id: prior.id, prior, current: prior,
    });

    // Falls back to the 2xx rather than erroring — but it never CLAIMED to have
    // proven the record gone. The safety property is the refutation, not this.
    expect(outcome).toMatchObject({ ok: true, operation: 'delete' });
    expect(recordDeterministicVerification).not.toHaveBeenCalled();
  });

  it('a Source with no read binding still deletes on the 2xx alone (no regression)', async () => {
    // A delete never needed a read op before, and must not start needing one.
    const noReadDecl = deleteDecl({
      ops: { list: 'task.list', delete: 'task.delete' },
      op_bindings: { delete: { id_arg: 'taskId' } },
    });
    const prior = seedForDelete();
    const script = scriptedOperation(opOk({}));
    const harness = makeExecutor({
      declaration: noReadDecl,
      runOperation: script.runOperation,
    });

    const outcome = await harness.executor.dispatch(prepareDelete(harness.executor), {
      local_id: prior.id, prior, current: prior,
    });

    expect(outcome).toMatchObject({ ok: true, operation: 'delete' });
    expect(script.invocations.map((i) => i.operationKey)).toEqual(['task.delete']); // no read-back
  });
});
