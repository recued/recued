/** D-192 P4a/P4c safe-write substrate regressions. */

import Database from 'better-sqlite3';
import {
  RECUED_BUILTIN_SOURCE_ID,
  WORK_ENTITY_KINDS,
  type WorkEntityKind,
  type WorkEntityPendingWrite,
} from '@recued/contracts';
import { validateWorkEntitySources } from '@recued/ingredients/validate-work-entity-sources.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  WorkEntityValidationError,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  projectWorkEntitySourceRow,
  type WorkEntityProjectionDeclaration,
} from '../work-entity-source-projector.js';
import { runDueStatusSweep } from '../work-entity-due-status-sweep.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const NOW = 1_700_000_000_000;
const UPDATED_ISO = '2026-07-01T12:34:56.789Z';
const SOURCE_ID = 'hubspot.acme.task';

let db: Database.Database;
let store: WorkEntityStore;

const registerBuiltins = (s: WorkEntityStore): void => {
  for (const kind of WORK_ENTITY_KINDS) {
    s.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID(kind),
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: `Recued ${kind}`,
      write_capable: true,
      registered_at: NOW,
    });
  }
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  registerBuiltins(store);
});

afterEach(() => {
  db.close();
});

const pendingWrite = (): WorkEntityPendingWrite => ({
  staged_at: NOW + 1,
  operation: 'update',
  dirty_fields: ['title'],
  base_source_updated_at: NOW - 10,
  base_source_record_hash: 'hash-before',
  base_source_version_token: 'token-before',
  state: 'pending',
  attempts: 1,
});

const taskDeclaration = (
  version: WorkEntityProjectionDeclaration['remote']['version'],
): WorkEntityProjectionDeclaration => ({
  kind: 'task',
  remote: {
    entity: 'task',
    id: 'id',
    version,
    hash_fields: ['title', 'state'],
  },
  sync: {
    mode: 'read_write',
    depth: 'meta',
    tombstones: 'none',
    stale_after_ms: 60_000,
  },
  projection: {
    canonical: {
      title: 'title',
      state: 'state',
    },
  },
});

const projectTaskRow = (
  declaration: WorkEntityProjectionDeclaration,
  raw: Record<string, unknown>,
) => {
  const result = projectWorkEntitySourceRow({
    declaration,
    source_id: SOURCE_ID,
    connection_name: 'acme',
    source_record_id: 'remote-1',
    raw,
  });
  if (!result.ok) throw new Error(`expected projection success: ${result.reason}`);
  if (result.upsert.kind !== 'task') {
    throw new Error(`expected task projection, got ${result.upsert.kind}`);
  }
  return result.upsert.write;
};

type Issue = {
  severity: 'error' | 'warn' | 'info';
  code: string;
  path: string;
  message: string;
};

const collectWorkEntityIssues = (manifest: Record<string, unknown>): Issue[] => {
  const issues: Issue[] = [];
  validateWorkEntitySources(
    manifest,
    (severity, code, path, message) => issues.push({ severity, code, path, message }),
  );
  return issues;
};

const OPENAPI_URL = 'https://example.test/openapi.yaml';
const OPENAPI_SHA = 'a'.repeat(64);
const TASK_LIST_OP = 'task.list';
const TASK_READ_OP = 'task.read';
const TASK_CREATE_OP = 'task.create';
const TASK_UPDATE_OP = 'task.update';

const validSourceManifest = (): Record<string, any> => ({
  operations: {
    [TASK_LIST_OP]: { risk_tier: 'read' },
    [TASK_READ_OP]: { risk_tier: 'read' },
    [TASK_CREATE_OP]: { risk_tier: 'write' },
    [TASK_UPDATE_OP]: { risk_tier: 'write' },
  },
  surfaces: {
    api: {
      openapi_source: {
        url: OPENAPI_URL,
        sha256: OPENAPI_SHA,
      },
      executes: {
        [TASK_LIST_OP]: { kind: 'rest', method: 'GET', path_template: '/tasks' },
        [TASK_READ_OP]: { kind: 'rest', method: 'GET', path_template: '/tasks/{{task_id}}' },
        [TASK_CREATE_OP]: { kind: 'rest', method: 'POST', path_template: '/tasks' },
        [TASK_UPDATE_OP]: { kind: 'rest', method: 'PATCH', path_template: '/tasks/{{task_id}}' },
      },
    },
  },
  work_entity_sources: [
    {
      kind: 'task',
      source_id_template: 'example.${connection_id}.task',
      source_kind: 'connection',
      contract_source: {
        kind: 'openapi',
        surface: 'surfaces.api.openapi_source',
        url: OPENAPI_URL,
        sha256: OPENAPI_SHA,
        operations: [TASK_LIST_OP, TASK_READ_OP, TASK_CREATE_OP, TASK_UPDATE_OP],
      },
      remote: {
        entity: 'Task',
        id: 'id',
        version: { kind: 'updated_at', field: 'updatedAt' },
        hash_fields: ['title', 'state'],
      },
      ops: {
        list: TASK_LIST_OP,
        read: TASK_READ_OP,
        create: TASK_CREATE_OP,
        update: TASK_UPDATE_OP,
      },
      op_bindings: {
        read: { id_arg: 'task_id' },
        update: { id_arg: 'task_id' },
      },
      sync: {
        mode: 'read_write',
        depth: 'meta',
        tombstones: 'none',
        stale_after_ms: 60_000,
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
          title: 'title',
          state: 'state',
        },
      },
      writable_fields: ['title', 'state'],
      write_policy: {
        conditional_write: 'none',
        stale_write: 'manual_merge',
        field_conflicts: 'manual_merge',
      },
    },
  ],
});

const source = (manifest: Record<string, any>): Record<string, any> =>
  manifest.work_entity_sources[0];

const expectOpBindingError = (
  manifest: Record<string, unknown>,
  path: string,
): void => {
  expect(collectWorkEntityIssues(manifest)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        code: 'WORK_ENTITY_SOURCES_OP_BINDING_INVALID',
        path,
      }),
    ]),
  );
};

describe('D-192 P4a safe-write store substrate', () => {
  it('round-trips source_version_token and nulls it on overwrite without a token', () => {
    const task = store.writeTask({
      id: 'task-token',
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'token task',
      source_version_token: 'task-token-v1',
    }, NOW);
    expect(task.source_version_token).toBe('task-token-v1');
    expect(store.readTask(task.id)?.source_version_token).toBe('task-token-v1');

    const taskOverwrite = store.writeTask({
      id: task.id,
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'token task overwritten',
    }, NOW + 1);
    expect(taskOverwrite.source_version_token).toBeUndefined();
    expect(store.readTask(task.id)?.source_version_token).toBeUndefined();

    const project = store.writeProject({
      id: 'project-token',
      source_id: RECUED_BUILTIN_SOURCE_ID('project'),
      title: 'token project',
      source_version_token: 'project-token-v1',
    }, NOW);
    expect(project.source_version_token).toBe('project-token-v1');
    expect(store.readProject(project.id)?.source_version_token).toBe('project-token-v1');

    const projectOverwrite = store.writeProject({
      id: project.id,
      source_id: RECUED_BUILTIN_SOURCE_ID('project'),
      title: 'token project overwritten',
    }, NOW + 1);
    expect(projectOverwrite.source_version_token).toBeUndefined();
    expect(store.readProject(project.id)?.source_version_token).toBeUndefined();
  });

  it('stages and clears pending_write through the dedicated channel', () => {
    store.writeTask({
      id: 'pending-task',
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'pending task',
    }, NOW);

    const pending = pendingWrite();
    expect(store.stagePendingWrite('task', 'pending-task', pending)).toBe(true);
    expect(store.readTask('pending-task')?.pending_write).toEqual(pending);
    expect(store.clearPendingWrite('task', 'pending-task')).toBe(true);
    expect(store.readTask('pending-task')?.pending_write).toBeUndefined();
    expect(store.clearPendingWrite('task', 'pending-task')).toBe(false);
    expect(store.stagePendingWrite('task', 'missing-task', pending)).toBe(false);
    expect(() => store.stagePendingWrite('bogus' as WorkEntityKind, 'x', pending))
      .toThrow(WorkEntityValidationError);
    expect(() => store.clearPendingWrite('bogus' as WorkEntityKind, 'x'))
      .toThrow(WorkEntityValidationError);
  });

  it('keeps staged pending_write intact across full-row writeTask upserts', () => {
    store.writeTask({
      id: 'dirty-task',
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'dirty task',
      source_version_token: 'base-token',
    }, NOW);

    const pending = pendingWrite();
    expect(store.stagePendingWrite('task', 'dirty-task', pending)).toBe(true);
    store.writeTask({
      id: 'dirty-task',
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'dirty task from sync',
      source_record_hash: 'hash-after',
      source_version_token: 'token-after',
    }, NOW + 1);

    expect(store.readTask('dirty-task')?.pending_write).toEqual(pending);
  });

  it('can run ensureWorkEntitySchema repeatedly on the same database', () => {
    expect(() => ensureWorkEntitySchema(db)).not.toThrow();
    expect(() => ensureWorkEntitySchema(db)).not.toThrow();
  });
});

describe('D-192 P4a projector version identity', () => {
  it('projects updated_at versions to source_updated_at and source_version_token', () => {
    const write = projectTaskRow(
      taskDeclaration({ kind: 'updated_at', field: 'updatedAt' }),
      { id: 'remote-1', title: 'Task', state: 'open', updatedAt: UPDATED_ISO },
    );

    expect(write.source_updated_at).toBe(Date.parse(UPDATED_ISO));
    expect(write.source_version_token).toBe(UPDATED_ISO);
  });

  it('projects revision and hash versions as tokens without source_updated_at', () => {
    const revision = projectTaskRow(
      taskDeclaration({ kind: 'revision', field: 'revision' }),
      { id: 'remote-1', title: 'Task', state: 'open', revision: 42 },
    );
    const hash = projectTaskRow(
      taskDeclaration({ kind: 'hash', field: 'hash' }),
      { id: 'remote-1', title: 'Task', state: 'open', hash: 'hash-token' },
    );

    expect(revision.source_version_token).toBe('42');
    expect('source_updated_at' in revision).toBe(false);
    expect(hash.source_version_token).toBe('hash-token');
    expect('source_updated_at' in hash).toBe(false);
  });

  it('omits a token for etag declarations without a response field', () => {
    const write = projectTaskRow(
      taskDeclaration({ kind: 'etag' }),
      { id: 'remote-1', title: 'Task', state: 'open' },
    );

    expect(write.source_version_token).toBeUndefined();
    expect('source_version_token' in write).toBe(false);
  });

  it('keeps source_record_hash stable when only the version value changes', () => {
    const declaration = taskDeclaration({ kind: 'revision', field: 'revision' });
    const v1 = projectTaskRow(declaration, {
      id: 'remote-1',
      title: 'Task',
      state: 'open',
      revision: 1,
    });
    const v2 = projectTaskRow(declaration, {
      id: 'remote-1',
      title: 'Task',
      state: 'open',
      revision: 2,
    });

    expect(v1.source_record_hash).toBe(v2.source_record_hash);
    expect(v1.source_version_token).toBe('1');
    expect(v2.source_version_token).toBe('2');
  });
});

describe('D-192 P4a preservation sites', () => {
  it('preserves version identity when the due-status sweep rewrites commitments', () => {
    store.writeCommitment({
      id: 'sweep-commitment',
      source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
      direction: 'outbound',
      statement: 'deliver report',
      derivation: 'user_declared',
      promised_for_at: NOW - 1,
      due_status: 'not_due',
      source_version_token: 'commitment-token',
      source_updated_at: NOW - 10_000,
    }, NOW - 20_000);

    const result = runDueStatusSweep({ store, now: () => NOW });
    const row = store.readCommitment('sweep-commitment');

    expect(result.commitments_due_status_updated).toBe(1);
    expect(row?.due_status).toBe('overdue');
    expect(row?.source_version_token).toBe('commitment-token');
    expect(row?.source_updated_at).toBe(NOW - 10_000);
  });

  it('preserves version identity through task, project, and commitment dispatchers', async () => {
    const dispatchers = createWorkEntityDispatchers({
      store,
      resolver: createWorkEntityResolver(store),
      now: () => NOW + 5_000,
    });

    store.writeTask({
      id: 'ingredient-task',
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'seed task',
      source_version_token: 'task-token',
      source_updated_at: NOW - 1_000,
    }, NOW);
    await dispatchers.taskUpdate({ id: 'ingredient-task', title: 'updated task' });
    expect(store.readTask('ingredient-task')?.source_version_token).toBe('task-token');
    expect(store.readTask('ingredient-task')?.source_updated_at).toBe(NOW - 1_000);
    await dispatchers.taskMarkDone({ id: 'ingredient-task' });
    expect(store.readTask('ingredient-task')?.source_version_token).toBe('task-token');
    expect(store.readTask('ingredient-task')?.source_updated_at).toBe(NOW - 1_000);

    store.writeProject({
      id: 'ingredient-project',
      source_id: RECUED_BUILTIN_SOURCE_ID('project'),
      title: 'seed project',
      source_version_token: 'project-token',
      source_updated_at: NOW - 2_000,
    }, NOW);
    await dispatchers.projectUpdate({ id: 'ingredient-project', title: 'updated project' });
    expect(store.readProject('ingredient-project')?.source_version_token).toBe('project-token');
    expect(store.readProject('ingredient-project')?.source_updated_at).toBe(NOW - 2_000);

    store.writeCommitment({
      id: 'ingredient-commitment',
      source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
      direction: 'outbound',
      statement: 'seed commitment',
      derivation: 'user_declared',
      source_version_token: 'commitment-token',
      source_updated_at: NOW - 3_000,
    }, NOW);
    await dispatchers.commitmentUpdate({
      id: 'ingredient-commitment',
      statement: 'updated commitment',
    });
    expect(store.readCommitment('ingredient-commitment')?.source_version_token)
      .toBe('commitment-token');
    expect(store.readCommitment('ingredient-commitment')?.source_updated_at)
      .toBe(NOW - 3_000);
  });
});

describe('D-192 P4a work_entity_sources op_bindings validation', () => {
  it('accepts read op_bindings and treats absence as optional', () => {
    expect(collectWorkEntityIssues(validSourceManifest())).toEqual([]);

    const absent = validSourceManifest();
    delete source(absent).op_bindings;
    expect(collectWorkEntityIssues(absent)).toEqual([]);
  });

  it.each(['list', 'create', 'bogus'])(
    'rejects an op_binding for unsupported slot %s',
    (slot) => {
      const manifest = validSourceManifest();
      source(manifest).op_bindings = {
        [slot]: { id_arg: 'task_id' },
      };

      expectOpBindingError(manifest, `work_entity_sources[0].op_bindings.${slot}`);
    },
  );

  it('rejects a binding for a slot whose op is absent or null', () => {
    const absent = validSourceManifest();
    delete source(absent).ops.update;
    source(absent).op_bindings = {
      update: { id_arg: 'task_id' },
    };
    expectOpBindingError(absent, 'work_entity_sources[0].op_bindings.update');

    const nulled = validSourceManifest();
    source(nulled).ops.update = null;
    source(nulled).op_bindings = {
      update: { id_arg: 'task_id' },
    };
    expectOpBindingError(nulled, 'work_entity_sources[0].op_bindings.update');
  });

  it.each([
    ['empty', { id_arg: '' }],
    ['missing', {}],
    ['non-string', { id_arg: 123 }],
  ])('rejects %s id_arg values', (_label, binding) => {
    const manifest = validSourceManifest();
    source(manifest).op_bindings = {
      read: binding,
    };

    expectOpBindingError(manifest, 'work_entity_sources[0].op_bindings.read');
  });

  it('rejects non-object op_bindings', () => {
    const manifest = validSourceManifest();
    source(manifest).op_bindings = 'read:task_id';

    expectOpBindingError(manifest, 'work_entity_sources[0].op_bindings');
  });
});
