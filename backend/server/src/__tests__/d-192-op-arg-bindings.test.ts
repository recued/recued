/** D-192 — `op_arg_bindings` substrate: the connection_config → op-arg resolver
 *  and its threading into sync LIST plus targeted read/write dispatch. The generalization of
 *  `create_arg_bindings` that makes a vendor whose list op needs a per-connection
 *  scoping arg (Asana `workspace`, Google Tasks `tasklist`) a viable read-only
 *  Source — the sync runner used to walk with hard-coded `args: {}`.
 *
 *  Covers: (a) `resolveConfigArgBindings` — the shared resolver (ok / unset /
 *  own-property guard); (b) the runner passes the RESOLVED args to the fetch;
 *  (c) an unset bound key degrades the cycle BEFORE any request (never a bad
 *  request the vendor 400s on, which a `missing_means_deleted` diff would then
 *  read as an empty authoritative walk); (d) a Source with NO `op_arg_bindings`
 *  still walks with `{}` (Todoist / HubSpot unchanged). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectionOperationProfile, IngredientManifest } from '@recued/contracts';
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
import type {
  SourceMirrorFetchDeps,
  SourceMirrorFetchOutcome,
  SourceMirrorFetchRequest,
} from '../source-mirror/fetch.js';
import {
  workEntitySourceContractHash,
  type KernelWorkEntitySourceDeclaration,
} from '../work-entity-source-boot.js';
import { resolveConfigArgBindings } from '../work-entity-config-args.js';
import {
  runWorkEntitySourceSync,
  type RunSourceMirrorFetchFn,
} from '../work-entity-source-sync.js';
import { validateWorkEntitySources } from '@recued/ingredients/validate-work-entity-sources.js';

// ── validator: op_arg_bindings shape gates ───────────────────────

/** Wrap one declaration in the minimal catalog manifest the validator needs
 *  (surfaces.api.executes + a matching pin — else it SURFACE_REQUIREs and returns
 *  before per-declaration checks). Returns error-severity issue paths. */
const validateOne = (decl: Record<string, unknown>): string[] => {
  const errors: string[] = [];
  validateWorkEntitySources(
    {
      work_entity_sources: [decl],
      surfaces: {
        api: {
          openapi_source: { url: 'u', sha256: 'a'.repeat(64) },
          executes: {
            'task.search': { kind: 'rest', method: 'GET', path_template: '/tasks' },
            'task.read': { kind: 'rest', method: 'GET', path_template: '/tasks/{{task_id}}' },
            'task.update': { kind: 'rest', method: 'PUT', path_template: '/tasks/{{task_id}}' },
          },
        },
      },
      operations: {
        'task.search': { risk_tier: 'read' },
        'task.read': { risk_tier: 'read' },
        'task.update': { risk_tier: 'write' },
      },
    } as unknown as Record<string, unknown>,
    (severity, _code, path) => { if (severity === 'error') errors.push(path); },
  );
  return errors;
};

const validReadOnly = (): Record<string, unknown> => ({
  kind: 'task',
  source_id_template: 'v.${connection_id}.task',
  source_kind: 'connection',
  contract_source: {
    kind: 'openapi', surface: 'surfaces.api.openapi_source',
    url: 'u', sha256: 'a'.repeat(64), operations: ['task.search', 'task.read'],
  },
  remote: { entity: 'task', id: 'id', version: { kind: 'updated_at', field: 'updated' }, hash_fields: ['title'] },
  ops: { list: 'task.search', read: 'task.read' },
  op_bindings: { read: { id_arg: 'task_id' } },
  sync: { mode: 'read_only', depth: 'meta', tombstones: 'none', list_scope: 'filtered', stale_after_ms: 3_600_000 },
  read_resolution: {
    default: 'local_rich_meta', remote_when: ['field_missing'],
    wild_query: { remote_fanout: 'bounded_targeted', max_sources: 3, max_remote_records: 10, on_exceeds_cap: 'ask_to_narrow' },
  },
  // task requires title + a completion signal (done|state).
  projection: { canonical: { title: 'title', state: 'status' } },
});

const validReadWrite = (): Record<string, unknown> => {
  const declaration = validReadOnly();
  (declaration.contract_source as Record<string, unknown>).operations = [
    'task.search', 'task.read', 'task.update',
  ];
  declaration.ops = { list: 'task.search', read: 'task.read', update: 'task.update' };
  declaration.op_bindings = {
    read: { id_arg: 'task_id' },
    update: { id_arg: 'task_id' },
  };
  declaration.sync = {
    mode: 'read_write', depth: 'meta', tombstones: 'none',
    list_scope: 'filtered', stale_after_ms: 3_600_000,
  };
  declaration.read_resolution = {
    ...(declaration.read_resolution as Record<string, unknown>),
    remote_when: ['field_missing', 'write_preflight'],
  };
  declaration.writable_fields = ['title'];
  declaration.write_policy = {
    conditional_write: 'none', stale_write: 'manual_merge', field_conflicts: 'manual_merge',
  };
  return declaration;
};

describe('D-192 validator — op_arg_bindings', () => {
  it('accepts a valid list+read binding', () => {
    const decl = validReadOnly();
    decl.op_arg_bindings = {
      list: { tasklist_id: { source: 'connection_config', config_key: 'tasklist_id' } },
      read: { tasklist_id: { source: 'connection_config', config_key: 'tasklist_id' } },
    };
    expect(validateOne(decl)).toEqual([]);
  });

  it('accepts a targeted update binding and rejects an id-arg collision', () => {
    const decl = validReadWrite();
    decl.op_arg_bindings = {
      update: { project_ref: { source: 'connection_config', config_key: 'project_ref' } },
    };
    expect(validateOne(decl)).toEqual([]);

    decl.op_arg_bindings = {
      update: { task_id: { source: 'connection_config', config_key: 'wrong' } },
    };
    expect(validateOne(decl).some((p) => p.includes('op_arg_bindings.update.task_id'))).toBe(true);
  });

  it('rejects a targeted binding that collides with the write precondition arg', () => {
    const decl = validReadWrite();
    (decl.op_bindings as Record<string, Record<string, unknown>>).update!.precondition_arg = 'revision';
    decl.op_arg_bindings = {
      update: { revision: { source: 'connection_config', config_key: 'project_revision' } },
    };
    expect(validateOne(decl).some((p) => p.includes('op_arg_bindings.update.revision'))).toBe(true);
  });

  it('rejects create in op_arg_bindings because create has its own binding lane', () => {
    const decl = validReadWrite();
    decl.op_arg_bindings = { create: { project_ref: { source: 'static', value: 'p' } } };
    expect(validateOne(decl).some((p) => p.includes('op_arg_bindings.create'))).toBe(true);
  });

  it('rejects a binding for a slot whose op is not declared', () => {
    const decl = validReadOnly();
    delete (decl.ops as Record<string, string>).read;
    delete (decl as Record<string, unknown>).op_bindings;
    decl.op_arg_bindings = { read: { tasklist_id: { source: 'connection_config', config_key: 't' } } };
    expect(validateOne(decl).some((p) => p.includes('op_arg_bindings.read'))).toBe(true);
  });

  it('rejects a scoping arg that collides with op_bindings.read.id_arg (dead config)', () => {
    const decl = validReadOnly();
    // binding the RECORD-ID arg to config is dead config — the id wins at dispatch.
    decl.op_arg_bindings = { read: { task_id: { source: 'connection_config', config_key: 'x' } } };
    expect(validateOne(decl).some((p) => p.includes('op_arg_bindings.read.task_id'))).toBe(true);
  });

  it('rejects a reserved prototype config_key', () => {
    const decl = validReadOnly();
    decl.op_arg_bindings = { list: { a: { source: 'connection_config', config_key: '__proto__' } } };
    expect(validateOne(decl).some((p) => p.includes('config_key'))).toBe(true);
  });

  it('accepts a static binding (a constant baked into the declaration — Zoho module)', () => {
    const decl = validReadOnly();
    decl.op_arg_bindings = {
      list: { module: { source: 'static', value: 'Tasks' } },
      read: { module: { source: 'static', value: 'Tasks' } },
    };
    expect(validateOne(decl)).toEqual([]);
  });

  it('rejects a static binding with an empty value', () => {
    const decl = validReadOnly();
    decl.op_arg_bindings = { list: { module: { source: 'static', value: '' } } };
    expect(validateOne(decl).some((p) => p.includes('op_arg_bindings.list.module'))).toBe(true);
  });
});

// ── resolveConfigArgBindings unit ────────────────────────────────

describe('D-192 resolveConfigArgBindings', () => {
  const cfg = { workspace_gid: 'W1', empty: '', nul: null };

  it('resolves each bound arg from the connection config', () => {
    const r = resolveConfigArgBindings(
      { 'query.workspace': { source: 'connection_config', config_key: 'workspace_gid' } },
      cfg,
    );
    expect(r).toEqual({ ok: true, args: { 'query.workspace': 'W1' } });
  });

  it('undefined bindings resolve to {} (the pre-existing full-walk args)', () => {
    expect(resolveConfigArgBindings(undefined, cfg)).toEqual({ ok: true, args: {} });
  });

  it('an unset / empty / null bound key fails with the arg + config_key named', () => {
    const unset = resolveConfigArgBindings(
      { tasklist_id: { source: 'connection_config', config_key: 'missing' } }, cfg,
    );
    expect(unset).toEqual({ ok: false, arg: 'tasklist_id', config_key: 'missing' });
    expect(resolveConfigArgBindings(
      { a: { source: 'connection_config', config_key: 'empty' } }, cfg,
    )).toMatchObject({ ok: false, config_key: 'empty' });
    expect(resolveConfigArgBindings(
      { a: { source: 'connection_config', config_key: 'nul' } }, cfg,
    )).toMatchObject({ ok: false, config_key: 'nul' });
  });

  it('an inherited (prototype) config_key does not resolve — own-property guard', () => {
    // `toString` lives on Object.prototype, not as an own key — must fail, not
    // resolve `[Function: toString]`.
    const r = resolveConfigArgBindings(
      { a: { source: 'connection_config', config_key: 'toString' } }, cfg,
    );
    expect(r).toMatchObject({ ok: false, config_key: 'toString' });
  });

  it('resolves a static binding to its constant — no connection config consulted, never fails', () => {
    // A static binding is baked into the declaration (Zoho module='Tasks'); it
    // resolves even when the connection carries no config at all.
    expect(resolveConfigArgBindings({ module: { source: 'static', value: 'Tasks' } }, undefined))
      .toEqual({ ok: true, args: { module: 'Tasks' } });
    expect(resolveConfigArgBindings({ module: { source: 'static', value: 'Tasks' } }, cfg))
      .toEqual({ ok: true, args: { module: 'Tasks' } });
  });

  it('resolves a mix of static + connection_config bindings', () => {
    expect(resolveConfigArgBindings(
      {
        module: { source: 'static', value: 'Tasks' },
        'query.workspace': { source: 'connection_config', config_key: 'workspace_gid' },
      },
      cfg,
    )).toEqual({ ok: true, args: { module: 'Tasks', 'query.workspace': 'W1' } });
  });
});

// ── sync-runner list dispatch threading ──────────────────────────

const NOW = 1_700_000_000_000;
const CONNECTION = 'acme';
const SOURCE = 'asana.acme.task';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let mirror: WorkEntitySourceMirrorStore;
let syncState: WorkEntitySourceSyncStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-oab-'));
  db = new Database(join(dir, 'test.db'));
  ensureWorkEntitySchema(db);
  ensureWorkEntitySourceSyncStateSchema(db);
  store = createWorkEntityStore(db);
  mirror = createWorkEntitySourceMirrorStore(db, store);
  syncState = createWorkEntitySourceSyncStateStore(db);
  store.registerSource({
    id: SOURCE, top_tier_kind: 'task', source_kind: 'connection',
    source_label: SOURCE, write_capable: false, mcp_exposed: false, registered_at: NOW,
  });
  // Real boot seeds the sync-state row at registration (`seedSyncState`);
  // `markStarted`/`markCompleted` are UPDATEs that need it present.
  syncState.upsert({
    source_id: SOURCE,
    contract_hash: workEntitySourceContractHash(asanaShapeDeclaration()),
    sync_depth: 'meta', sync_mode: 'read_only',
    cursor_blob: null, last_sync_started_at: null, last_sync_completed_at: null,
    last_success_at: null, last_error_code: null, last_error_message: null,
    degraded: false, field_health_blob: null, list_complete: true,
    stale_after_ms: 21_600_000,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A read-only task Source whose list op needs a `query.workspace` scoping arg
 *  from the connection config — the Asana shape. */
const asanaShapeDeclaration = (): KernelWorkEntitySourceDeclaration => ({
  kind: 'task',
  source_id_template: 'asana.${connection_id}.task',
  source_kind: 'connection',
  remote: { entity: 'task', id: 'id', version: { kind: 'updated_at', field: 'updated' }, hash_fields: ['title'] },
  ops: { list: 'task.list' },
  op_arg_bindings: {
    list: { 'query.workspace': { source: 'connection_config', config_key: 'workspace_gid' } },
  },
  sync: { mode: 'read_only', depth: 'meta', tombstones: 'none', list_scope: 'filtered', stale_after_ms: 21_600_000 },
  read_resolution: {
    default: 'local_rich_meta', remote_when: ['field_missing'],
    wild_query: { remote_fanout: 'bounded_targeted', max_sources: 3, max_remote_records: 10, on_exceeds_cap: 'ask_to_narrow' },
  },
  projection: { canonical: { title: 'title' } },
});

const manifestFake = {
  slug: 'cat',
  operations: { 'task.list': { result_path: 'records' } },
  surfaces: { api: { result_path: 'records' } },
} as unknown as IngredientManifest;

const profile: ConnectionOperationProfile = { allowed_operations: ['task.list'], catalog_slug: 'cat' };

const fetchDeps = (): SourceMirrorFetchDeps => ({
  executorConfig: { manifests: { get: (slug: string) => (slug === 'cat' ? manifestFake : null) } },
  profiles: { get: () => profile },
} as unknown as SourceMirrorFetchDeps);

const okFetch = (records: ReadonlyArray<Record<string, unknown>>): SourceMirrorFetchOutcome => ({
  ok: true,
  records: new Map(records.map((r) => [r.id as string, r])),
  truncated: false,
  complete: true,
  skipped_no_id: 0,
});

const scriptedFetch = (
  outcome: SourceMirrorFetchOutcome,
): { runFetch: RunSourceMirrorFetchFn; requests: SourceMirrorFetchRequest[] } => {
  const requests: SourceMirrorFetchRequest[] = [];
  const runFetch: RunSourceMirrorFetchFn = async (_deps, request) => {
    requests.push(request);
    return outcome;
  };
  return { runFetch, requests };
};

describe('D-192 op_arg_bindings — sync-runner list dispatch', () => {
  it('passes the RESOLVED workspace arg to the list fetch', async () => {
    const { runFetch, requests } = scriptedFetch(okFetch([{ id: 't1', title: 'A', updated: '2026-07-01' }]));
    const result = await runWorkEntitySourceSync(
      {
        fetchDeps: fetchDeps(), mirror, syncState, runFetch, now: () => NOW,
        resolveConnectionConfig: (name) => (name === CONNECTION ? { workspace_gid: 'W-123' } : undefined),
      },
      { source_id: SOURCE, connection_name: CONNECTION, declaration: asanaShapeDeclaration() },
    );
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].args).toEqual({ 'query.workspace': 'W-123' });
  });

  it('degrades the cycle BEFORE any fetch when the bound config key is unset', async () => {
    const { runFetch, requests } = scriptedFetch(okFetch([]));
    const result = await runWorkEntitySourceSync(
      {
        fetchDeps: fetchDeps(), mirror, syncState, runFetch, now: () => NOW,
        resolveConnectionConfig: () => ({}), // workspace_gid unset
      },
      { source_id: SOURCE, connection_name: CONNECTION, declaration: asanaShapeDeclaration() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('config');
    expect(result.reason).toContain('workspace_gid');
    // NO request was issued — the guard fires before the walk.
    expect(requests).toHaveLength(0);
    const health = syncState.get(SOURCE);
    expect(health?.degraded).toBe(true);
    expect(health?.last_error_code).toBe('config');
  });

  it('a Source with NO op_arg_bindings still walks with {} (Todoist / HubSpot unchanged)', async () => {
    const { runFetch, requests } = scriptedFetch(okFetch([{ id: 't1', title: 'A', updated: '2026-07-01' }]));
    const decl = asanaShapeDeclaration();
    delete decl.op_arg_bindings;
    const state = syncState.get(SOURCE);
    if (state === null) throw new Error('expected seeded sync state');
    syncState.upsert({
      ...state,
      contract_hash: workEntitySourceContractHash(decl),
    });
    const result = await runWorkEntitySourceSync(
      { fetchDeps: fetchDeps(), mirror, syncState, runFetch, now: () => NOW },
      { source_id: SOURCE, connection_name: CONNECTION, declaration: decl },
    );
    expect(result.ok).toBe(true);
    expect(requests[0].args).toEqual({});
  });
});
