/** D-192 Slice 3 — the `create_if_not_picked` decision + dependency list fetch. */

import Database from 'better-sqlite3';
import type {
  IngredientManifest,
  WorkEntitySourceDependency,
} from '@recued/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RunGatedCatalogOperationFn,
  SourceMirrorFetchDeps,
} from '../source-mirror/fetch.js';
import {
  createSourceDependencyEntityStore,
  ensureSourceDependencyEntitySchema,
  type SourceDependencyEntityStore,
} from '../storage/source-dependency-entity-store.js';
import {
  decideDependencyResolution,
  executePlannedCreate,
  fetchDependencyEntities,
  resolvePersistDependencies,
  resolvePersistDependencyCreateArgs,
  resolvePersistDependencyReadArgs,
  resolvePromptDependencies,
  resolvePromptDependency,
} from '../source-dependency-resolver.js';

const OPTS = [
  { entity_pk: 'w1', label: 'Acme' },
  { entity_pk: 'w2', label: 'Beta' },
];

describe('D-192 decideDependencyResolution', () => {
  it('named + exact (case/trim-folded) match → picked', () => {
    expect(decideDependencyResolution({ options: OPTS, named: '  acme ', createCapable: true }))
      .toEqual({ kind: 'picked', entity_pk: 'w1', label: 'Acme' });
  });

  it('named + no match + createCapable → create', () => {
    expect(decideDependencyResolution({ options: OPTS, named: 'Gamma', createCapable: true }))
      .toEqual({ kind: 'create', name: 'Gamma' });
  });

  it('named + no match + NOT createCapable → ask (pick from list, no ＋new)', () => {
    expect(decideDependencyResolution({ options: OPTS, named: 'Gamma', createCapable: false }))
      .toEqual({ kind: 'ask', options: OPTS, can_create: false });
  });

  it('a stored/default selection (no name) → picked', () => {
    expect(decideDependencyResolution({ options: OPTS, storedSelection: { entity_pk: 'w2', label: 'Beta' }, createCapable: false }))
      .toEqual({ kind: 'picked', entity_pk: 'w2', label: 'Beta' });
  });

  it('an explicit name overrides a stored selection', () => {
    // named matches w1 → wins over the stored w2.
    expect(decideDependencyResolution({ options: OPTS, storedSelection: { entity_pk: 'w2', label: 'Beta' }, named: 'Acme', createCapable: true }))
      .toMatchObject({ kind: 'picked', entity_pk: 'w1' });
    // named with no match + create still wins over the stored default.
    expect(decideDependencyResolution({ options: OPTS, storedSelection: { entity_pk: 'w2', label: 'Beta' }, named: 'New', createCapable: true }))
      .toEqual({ kind: 'create', name: 'New' });
  });

  it('empty options + createCapable → ask for a name', () => {
    expect(decideDependencyResolution({ options: [], createCapable: true }))
      .toEqual({ kind: 'ask', options: [], can_create: true });
  });

  it('empty options + NOT createCapable → unresolved', () => {
    expect(decideDependencyResolution({ options: [], createCapable: false }).kind).toBe('unresolved');
  });

  it('lone option + NOT createCapable → auto-picked', () => {
    expect(decideDependencyResolution({ options: [OPTS[0]], createCapable: false }))
      .toEqual({ kind: 'picked', entity_pk: 'w1', label: 'Acme' });
  });

  it('lone option + createCapable → ask (that one, or a new one)', () => {
    expect(decideDependencyResolution({ options: [OPTS[0]], createCapable: true }))
      .toEqual({ kind: 'ask', options: [OPTS[0]], can_create: true });
  });

  it('multiple options → ask', () => {
    expect(decideDependencyResolution({ options: OPTS, createCapable: false }))
      .toEqual({ kind: 'ask', options: OPTS, can_create: false });
  });
});

// ── fetch ──

const workspaceDep: WorkEntitySourceDependency = {
  ref: 'workspace', list_op: 'workspace.search', id_field: 'gid', label_field: 'name',
  binds: [{ op: 'list', arg: 'query.workspace' }], resolve: 'persist',
};

const manifest = {
  slug: 'asana',
  operations: { 'workspace.search': { result_path: 'data' } },
  surfaces: { api: { result_path: 'data' } },
} as unknown as IngredientManifest;

const scripted = (raw: unknown): { run: RunGatedCatalogOperationFn; calls: unknown[] } => {
  const calls: unknown[] = [];
  const run: RunGatedCatalogOperationFn = async (_deps, req) => {
    calls.push(req);
    return { ok: true, raw };
  };
  return { run, calls };
};

const fetchDeps = {} as unknown as SourceMirrorFetchDeps;

describe('D-192 fetchDependencyEntities', () => {
  it('invokes the list op, projects id/label, and refreshes the cache', async () => {
    const store = { replaceEntities: vi.fn() };
    const { run, calls } = scripted({ result: { data: [
      { gid: 'w1', name: 'Acme' }, { gid: 'w2', name: 'Beta' },
    ] } });
    const out = await fetchDependencyEntities(
      { fetchDeps, store, runOperation: run },
      { source_id: 'asana.acme.task', dependency: workspaceDep, connection_name: 'acme', manifest, catalogSlug: 'asana', now: 1 },
    );
    expect(out).toEqual({ ok: true, options: [
      { entity_pk: 'w1', label: 'Acme' }, { entity_pk: 'w2', label: 'Beta' },
    ] });
    expect((calls[0] as { operationKey: string }).operationKey).toBe('workspace.search');
    expect(store.replaceEntities).toHaveBeenCalledWith(
      'asana.acme.task', 'workspace',
      [{ entity_pk: 'w1', label: 'Acme' }, { entity_pk: 'w2', label: 'Beta' }],
      { pack_slug: null, now: 1 },
    );
  });

  it('skips rows missing an id (unkeyable — cannot be bound)', async () => {
    const store = { replaceEntities: vi.fn() };
    const { run } = scripted({ result: { data: [
      { gid: 'w1', name: 'Acme' }, { name: 'no-id' }, { gid: 42, name: 'numeric-id' },
    ] } });
    const out = await fetchDependencyEntities(
      { fetchDeps, store, runOperation: run },
      { source_id: 's', dependency: workspaceDep, connection_name: 'acme', manifest, catalogSlug: 'asana', now: 1 },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.options).toEqual([
      { entity_pk: 'w1', label: 'Acme' },
      { entity_pk: '42', label: 'numeric-id' }, // numeric id coerced
    ]);
  });

  it('config-fails when the list op declares no result_path', async () => {
    const store = { replaceEntities: vi.fn() };
    const bareManifest = { slug: 'x', operations: { 'workspace.search': {} }, surfaces: { api: {} } } as unknown as IngredientManifest;
    const { run } = scripted({ result: {} });
    const out = await fetchDependencyEntities(
      { fetchDeps, store, runOperation: run },
      { source_id: 's', dependency: workspaceDep, connection_name: 'acme', manifest: bareManifest, catalogSlug: 'x', now: 1 },
    );
    expect(out).toMatchObject({ ok: false, kind: 'config' });
    expect(store.replaceEntities).not.toHaveBeenCalled();
  });

  it('errors when the result is not an array', async () => {
    const store = { replaceEntities: vi.fn() };
    const { run } = scripted({ result: { data: { not: 'an array' } } });
    const out = await fetchDependencyEntities(
      { fetchDeps, store, runOperation: run },
      { source_id: 's', dependency: workspaceDep, connection_name: 'acme', manifest, catalogSlug: 'asana', now: 1 },
    );
    expect(out).toMatchObject({ ok: false, kind: 'error' });
  });

  it('propagates a gated-invoke failure', async () => {
    const store = { replaceEntities: vi.fn() };
    const run: RunGatedCatalogOperationFn = async () => ({ ok: false, kind: 'policy', reason: 'denied' });
    const out = await fetchDependencyEntities(
      { fetchDeps, store, runOperation: run },
      { source_id: 's', dependency: workspaceDep, connection_name: 'acme', manifest, catalogSlug: 'asana', now: 1 },
    );
    expect(out).toMatchObject({ ok: false, kind: 'policy', reason: 'denied' });
    expect(store.replaceEntities).not.toHaveBeenCalled();
  });
});

// ── persist-mode dispatch resolution (Slice 4) ──

const SRC = 'asana.acme.task';
/** Manifest with the workspace + project list ops (both `result.data`). */
const depManifest = {
  slug: 'asana',
  operations: { 'workspace.search': { result_path: 'data' }, 'project.search': { result_path: 'data' } },
  surfaces: { api: { result_path: 'data' } },
} as unknown as IngredientManifest;

/** Scripted gated-invoke returning `result.data` from a per-op map. */
const scriptByOp = (byOp: Record<string, Array<Record<string, unknown>>>): {
  run: RunGatedCatalogOperationFn; calls: Array<{ operationKey: string; args: Record<string, unknown> }>;
} => {
  const calls: Array<{ operationKey: string; args: Record<string, unknown> }> = [];
  const run: RunGatedCatalogOperationFn = async (_d, req) => {
    calls.push({ operationKey: req.operationKey, args: req.args });
    return { ok: true, raw: { result: { data: byOp[req.operationKey] ?? [] } } };
  };
  return { run, calls };
};

describe('D-192 resolvePersistDependencies (sync-scope dispatch)', () => {
  let db: Database.Database;
  let store: SourceDependencyEntityStore;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureSourceDependencyEntitySchema(db);
    store = createSourceDependencyEntityStore(db);
  });
  afterEach(() => db.close());

  const run1 = (deps: { source_dependencies: WorkEntitySourceDependency[] }, run: RunGatedCatalogOperationFn) =>
    resolvePersistDependencies(
      { fetchDeps, store, runOperation: run },
      { source_id: SRC, declaration: deps, connection_name: 'acme', manifest: depManifest, catalogSlug: 'asana', now: 1 },
    );

  it('auto-selects a LONE option and binds its id into the list args', async () => {
    const { run } = scriptByOp({ 'workspace.search': [{ gid: 'w1', name: 'Acme' }] });
    const out = await run1({ source_dependencies: [workspaceDep] }, run);
    expect(out).toEqual({ ok: true, listArgs: { 'query.workspace': 'w1' } });
    expect(store.getSelected(SRC, 'workspace')?.entity_pk).toBe('w1'); // persisted
  });

  it('config-fails on MULTIPLE options (needs a pick) — no arg bound', async () => {
    const { run } = scriptByOp({ 'workspace.search': [{ gid: 'w1', name: 'Acme' }, { gid: 'w2', name: 'Beta' }] });
    const out = await run1({ source_dependencies: [workspaceDep] }, run);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('workspace');
    expect(out.reason).toContain('2 options');
  });

  it('reuses an existing selection WITHOUT re-fetching', async () => {
    store.replaceEntities(SRC, 'workspace', [{ entity_pk: 'w2', label: 'Beta' }], { now: 0 });
    store.select(SRC, 'workspace', 'w2');
    const { run, calls } = scriptByOp({}); // would return [] → fail if fetched
    const out = await run1({ source_dependencies: [workspaceDep] }, run);
    expect(out).toEqual({ ok: true, listArgs: { 'query.workspace': 'w2' } });
    expect(calls).toHaveLength(0); // no fetch — selection was authoritative
  });

  it('threads a resolved parent id into a chained child fetch (workspace → project)', async () => {
    const projectDep: WorkEntitySourceDependency = {
      ref: 'project', list_op: 'project.search', id_field: 'gid', label_field: 'name',
      arg_from: [{ dependency: 'workspace', arg: 'query.workspace' }],
      binds: [{ op: 'list', arg: 'query.project' }], resolve: 'persist',
    };
    const { run, calls } = scriptByOp({
      'workspace.search': [{ gid: 'w1', name: 'Acme' }],
      'project.search': [{ gid: 'p1', name: 'Roadmap' }],
    });
    const out = await run1({ source_dependencies: [workspaceDep, projectDep] }, run);
    expect(out).toEqual({ ok: true, listArgs: { 'query.workspace': 'w1', 'query.project': 'p1' } });
    // the project list was fetched WITH the resolved workspace id.
    const projectCall = calls.find((c) => c.operationKey === 'project.search');
    expect(projectCall?.args).toEqual({ 'query.workspace': 'w1' });
  });
});

describe('D-192 resolvePersistDependencyReadArgs', () => {
  const tasklistDep: WorkEntitySourceDependency = {
    ref: 'tasklist', list_op: 'task_list.search', id_field: 'id', label_field: 'title',
    binds: [{ op: 'list', arg: 'tasklist_id' }, { op: 'read', arg: 'tasklist_id' }], resolve: 'persist',
  };
  const stubStore = (sel: string | null) => ({
    getSelected: (_s: string, ref: string) => sel !== null && ref === 'tasklist'
      ? { source_id: 's', dependency_ref: ref, entity_pk: sel, label: 'L', selected: true, pack_slug: null, fetched_at: 0 }
      : null,
  });

  it('binds the selected id into the read args', () => {
    expect(resolvePersistDependencyReadArgs(stubStore('MTI'), 's', { source_dependencies: [tasklistDep] }))
      .toEqual({ ok: true, readArgs: { tasklist_id: 'MTI' } });
  });

  it('config-fails when a read-bound dep has no selection', () => {
    const out = resolvePersistDependencyReadArgs(stubStore(null), 's', { source_dependencies: [tasklistDep] });
    expect(out).toMatchObject({ ok: false });
    if (out.ok) return;
    expect(out.reason).toContain('tasklist');
  });

  it('ignores a dep that does not bind the read op', () => {
    const listOnly: WorkEntitySourceDependency = { ...tasklistDep, ref: 'workspace', binds: [{ op: 'list', arg: 'query.workspace' }] };
    expect(resolvePersistDependencyReadArgs(stubStore(null), 's', { source_dependencies: [listOnly] }))
      .toEqual({ ok: true, readArgs: {} });
  });
});

// ── persist-mode CREATE-arg resolution (Slice 5) ──

describe('D-192 resolvePersistDependencyCreateArgs', () => {
  // The workspace persist dep scopes the walk AND attributes a create. Create args
  // are FLAT wire keys (graphql variable / one-level body field / path token) — the
  // executor merges them flat; multi-level REST body nesting is a Slice 7 extension.
  const workspaceCreateDep: WorkEntitySourceDependency = {
    ref: 'workspace', list_op: 'workspace.search', id_field: 'gid', label_field: 'name',
    binds: [{ op: 'list', arg: 'query.workspace' }, { op: 'create', arg: 'workspace_id' }],
    resolve: 'persist',
  };
  const stubStore = (sel: string | null) => ({
    getSelected: (_s: string, ref: string) => sel !== null && ref === 'workspace'
      ? { source_id: 's', dependency_ref: ref, entity_pk: sel, label: 'Acme', selected: true, pack_slug: null, fetched_at: 0 }
      : null,
  });

  it('binds the selected id into the create args', () => {
    expect(resolvePersistDependencyCreateArgs(stubStore('w1'), 's', { source_dependencies: [workspaceCreateDep] }))
      .toEqual({ ok: true, createArgs: { workspace_id: 'w1' } });
  });

  it('config-fails when a create-bound persist dep has no selection', () => {
    const out = resolvePersistDependencyCreateArgs(stubStore(null), 's', { source_dependencies: [workspaceCreateDep] });
    expect(out).toMatchObject({ ok: false });
    if (out.ok) return;
    expect(out.reason).toContain('workspace');
    expect(out.reason).toContain('create');
  });

  it('ignores a persist dep that binds only the list op', () => {
    const listOnly: WorkEntitySourceDependency = { ...workspaceCreateDep, binds: [{ op: 'list', arg: 'query.workspace' }] };
    expect(resolvePersistDependencyCreateArgs(stubStore(null), 's', { source_dependencies: [listOnly] }))
      .toEqual({ ok: true, createArgs: {} });
  });

  it('fails on two persist deps binding the SAME create arg (one authority per arg)', () => {
    const dupA: WorkEntitySourceDependency = { ...workspaceCreateDep, ref: 'a' };
    const dupB: WorkEntitySourceDependency = { ...workspaceCreateDep, ref: 'b' };
    const store = {
      getSelected: (_s: string, ref: string) =>
        ({ source_id: 's', dependency_ref: ref, entity_pk: `id-${ref}`, label: ref, selected: true, pack_slug: null, fetched_at: 0 }),
    };
    const out = resolvePersistDependencyCreateArgs(store, 's', { source_dependencies: [dupA, dupB] });
    expect(out).toMatchObject({ ok: false });
    if (out.ok) return;
    expect(out.reason).toContain('workspace_id');
  });
});

// ── prompt-mode resolution (create-assist, Slice 5) ──

/** Manifest carrying the workspace/project list ops + the project create op. */
const promptManifest = {
  slug: 'asana',
  operations: {
    'workspace.search': { result_path: 'data' },
    'project.search': { result_path: 'data' },
    'project.create': { result_path: 'data', operation_id: 'recued-core/asana.project.create' },
  },
  surfaces: { api: { result_path: 'data' } },
} as unknown as IngredientManifest;

/** A workspace PERSIST parent + a project PROMPT leaf with a create op. The list
 *  op scopes projects by `query.workspace`; the create op attributes by the FLAT
 *  `workspace_id` (the `create_arg` split — list vs create name the parent under
 *  different wire keys). Flat wire keys throughout (a graphql-shaped container). */
const workspaceParent: WorkEntitySourceDependency = {
  ref: 'workspace', list_op: 'workspace.search', id_field: 'gid', label_field: 'name',
  binds: [{ op: 'list', arg: 'query.workspace' }], resolve: 'persist',
};
const projectLeaf: WorkEntitySourceDependency = {
  ref: 'project', list_op: 'project.search', id_field: 'gid', label_field: 'name',
  create_op: 'project.create', create_name_arg: 'name',
  arg_from: [{ dependency: 'workspace', arg: 'query.workspace', create_arg: 'workspace_id' }],
  binds: [{ op: 'create', arg: 'project_id' }], resolve: 'prompt',
};

/** The SAME project leaf shaped for Asana's REST `data:{}` body (Slice 6c): the
 *  create attributes nest 2-level (`body.data.workspace`, `body.data.name`) and
 *  the resolved id flows into the array-typed `body.data.projects`. The resolver
 *  composes the nested body through the shared composer + array-wraps the bind. */
const projectLeafNested: WorkEntitySourceDependency = {
  ref: 'project', list_op: 'project.search', id_field: 'gid', label_field: 'name',
  create_op: 'project.create', create_name_arg: 'body.data.name',
  arg_from: [{ dependency: 'workspace', arg: 'query.workspace', create_arg: 'body.data.workspace' }],
  binds: [{ op: 'create', arg: 'body.data.projects', wrap_array: true }], resolve: 'prompt',
};
const projectLeafNoCreate: WorkEntitySourceDependency = {
  ref: 'project', list_op: 'project.search', id_field: 'gid', label_field: 'name',
  arg_from: [{ dependency: 'workspace', arg: 'query.workspace' }],
  binds: [{ op: 'create', arg: 'project_id' }], resolve: 'prompt',
};

/** Scripted gated invoke: list ops return `result.data` arrays from a per-op map;
 *  `project.create` returns a single created record; captures every call. */
const scriptPrompt = (byOp: Record<string, Array<Record<string, unknown>>>, created?: Record<string, unknown>): {
  run: RunGatedCatalogOperationFn; calls: Array<{ operationKey: string; args: Record<string, unknown> }>;
} => {
  const calls: Array<{ operationKey: string; args: Record<string, unknown> }> = [];
  const run: RunGatedCatalogOperationFn = async (_d, req) => {
    calls.push({ operationKey: req.operationKey, args: req.args });
    if (req.operationKey === 'project.create') {
      return { ok: true, raw: { result: { data: created ?? {} } } };
    }
    return { ok: true, raw: { result: { data: byOp[req.operationKey] ?? [] } } };
  };
  return { run, calls };
};

describe('D-192 resolvePromptDependency (create-assist)', () => {
  let db: Database.Database;
  let store: SourceDependencyEntityStore;
  const SRC = 'asana.acme.task';
  beforeEach(() => {
    db = new Database(':memory:');
    ensureSourceDependencyEntitySchema(db);
    store = createSourceDependencyEntityStore(db);
    // The workspace persist parent is already selected (a sync established it).
    store.replaceEntities(SRC, 'workspace', [{ entity_pk: 'w1', label: 'Acme' }], { now: 0 });
    store.select(SRC, 'workspace', 'w1');
  });
  afterEach(() => db.close());

  const ctx = (over: Record<string, unknown> = {}) => ({
    source_id: SRC,
    declaration: { source_dependencies: [workspaceParent, projectLeaf] },
    connection_name: 'acme', manifest: promptManifest, catalogSlug: 'asana', now: 1,
    ...over,
  });

  it('named container ABSENT + authorized → a PLAN (no gated create), splits list vs create args', async () => {
    const { run, calls } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'Existing' }] });
    const res = await resolvePromptDependency(
      { fetchDeps, store, runOperation: run },
      ctx({ named: { project: 'Roadmap' }, isCreateAuthorized: () => true }),
      'project',
    );
    // DECIDE-only: the container create is PLANNED, never executed here.
    expect(res).toMatchObject({
      kind: 'plan', ref: 'project',
      plan: { ref: 'project', create_op: 'project.create', name: 'Roadmap' },
    });
    if (res.kind !== 'plan') return;
    // the CREATE args use the create_arg split (workspace_id) + the name — resolved
    // at decide time, ready to invoke on approval.
    expect(res.plan.args).toEqual({ workspace_id: 'w1', name: 'Roadmap' });
    // the project LIST fetch was scoped by the parent workspace under query.workspace
    expect(calls.find((c) => c.operationKey === 'project.search')?.args).toEqual({ 'query.workspace': 'w1' });
    // NO gated create fired — decide is side-effect-free.
    expect(calls.some((c) => c.operationKey === 'project.create')).toBe(false);
  });

  it('named container PRESENT (case/trim-folded) → picked, never plans a create', async () => {
    const { run, calls } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'Roadmap' }] });
    const res = await resolvePromptDependency(
      { fetchDeps, store, runOperation: run },
      ctx({ named: { project: '  roadmap ' }, isCreateAuthorized: () => true }),
      'project',
    );
    expect(res).toEqual({ kind: 'resolved', ref: 'project', entity_pk: 'p1', label: 'Roadmap' });
    expect(calls.some((c) => c.operationKey === 'project.create')).toBe(false);
  });

  it('no name + multiple options → pick-only ask even when the create_op is granted', async () => {
    // NO name → a create is unreachable (you can't create an unnamed container), so
    // an ambiguous unnamed set is pick-only (can_create false), and a lone option
    // still auto-picks (asserted separately) — zero-config is preserved.
    const { run } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'A' }, { gid: 'p2', name: 'B' }] });
    const res = await resolvePromptDependency(
      { fetchDeps, store, runOperation: run },
      ctx({ isCreateAuthorized: () => true }),
      'project',
    );
    expect(res).toMatchObject({ kind: 'ask', ref: 'project', can_create: false });
  });

  it('ambiguous ask for a create-op dependency carries the resolved create_op id', async () => {
    const { run } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'A' }, { gid: 'p2', name: 'B' }] });
    const res = await resolvePromptDependency(
      { fetchDeps, store, runOperation: run },
      ctx({ isCreateAuthorized: () => true }),
      'project',
    );
    expect(res).toMatchObject({
      kind: 'ask',
      ref: 'project',
      can_create: false,
      create_op: 'recued-core/asana.project.create',
    });
  });

  it('ambiguous ask for a dependency without create_op omits create_op', async () => {
    const { run } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'A' }, { gid: 'p2', name: 'B' }] });
    const res = await resolvePromptDependency(
      { fetchDeps, store, runOperation: run },
      ctx({ declaration: { source_dependencies: [workspaceParent, projectLeafNoCreate] } }),
      'project',
    );
    expect(res).toMatchObject({ kind: 'ask', ref: 'project', can_create: false });
    if (res.kind !== 'ask') return;
    expect(res.create_op).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(res, 'create_op')).toBe(false);
  });

  it('no name + a LONE option auto-picks even when the create_op is granted (zero-config preserved)', async () => {
    const { run, calls } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'Only' }] });
    const res = await resolvePromptDependency(
      { fetchDeps, store, runOperation: run },
      ctx({ isCreateAuthorized: () => true }),
      'project',
    );
    expect(res).toEqual({ kind: 'resolved', ref: 'project', entity_pk: 'p1', label: 'Only' });
    expect(calls.some((c) => c.operationKey === 'project.create')).toBe(false);
  });

  it('named ABSENT but NOT authorized → ask (pick-only, no ＋new)', async () => {
    const { run, calls } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'A' }] });
    const res = await resolvePromptDependency(
      { fetchDeps, store, runOperation: run },
      ctx({ named: { project: 'Roadmap' }, isCreateAuthorized: () => false }),
      'project',
    );
    expect(res).toMatchObject({ kind: 'ask', ref: 'project', can_create: false });
    expect(calls.some((c) => c.operationKey === 'project.create')).toBe(false);
  });

  it('the create_op grant is per-op: an UNGRANTED create_op degrades to pick-only', async () => {
    // authorized for a DIFFERENT op only — the project's create_op is not granted.
    const { run } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'A' }] });
    const res = await resolvePromptDependency(
      { fetchDeps, store, runOperation: run },
      ctx({ named: { project: 'Roadmap' }, isCreateAuthorized: (op: string) => op === 'task.create' }),
      'project',
    );
    // no match + not authorized to create THIS container → pick-only ask.
    expect(res).toMatchObject({ kind: 'ask', ref: 'project', can_create: false });
  });

  it('parent persist dep with NO selection → unresolved (run a sync first)', async () => {
    store.deleteForSource(SRC); // drop the workspace selection
    const { run } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'A' }] });
    const res = await resolvePromptDependency(
      { fetchDeps, store, runOperation: run },
      ctx({ named: { project: 'Roadmap' }, isCreateAuthorized: () => true }),
      'project',
    );
    expect(res).toMatchObject({ kind: 'unresolved', ref: 'project' });
    if (res.kind !== 'unresolved') return;
    expect(res.reason).toContain('workspace');
  });

  it('plans the container create body 2-level for a REST vendor (Slice 6c nested body)', async () => {
    const { run, calls } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'Existing' }] });
    const res = await resolvePromptDependency(
      { fetchDeps, store, runOperation: run },
      ctx({
        declaration: { source_dependencies: [workspaceParent, projectLeafNested] },
        named: { project: 'Roadmap' }, isCreateAuthorized: () => true,
      }),
      'project',
    );
    expect(res).toMatchObject({ kind: 'plan', ref: 'project' });
    if (res.kind !== 'plan') return;
    // the parent id + new name nest under ONE `body.data` object — never the flat
    // literal-dot keys the adapter would drop outside `data`.
    expect(res.plan.args).toEqual({ 'body.data': { workspace: 'w1', name: 'Roadmap' } });
    expect(calls.some((c) => c.operationKey === 'project.create')).toBe(false);
  });

  it('executePlannedCreate invokes the gated create with the plan args + extracts the id', async () => {
    // the EXECUTE half of decide-then-execute: run the container write on approval.
    const { run, calls } = scriptPrompt({}, { gid: 'pNew', name: 'Roadmap' });
    const res = await executePlannedCreate(
      { fetchDeps, store, runOperation: run },
      { connection_name: 'acme', manifest: promptManifest, catalogSlug: 'asana' },
      {
        ref: 'project', create_op: 'project.create', name: 'Roadmap',
        args: { 'body.data': { workspace: 'w1', name: 'Roadmap' } }, result_path: 'data', id_field: 'gid',
      },
    );
    expect(res).toEqual({ ok: true, entity_pk: 'pNew' });
    expect(calls.find((c) => c.operationKey === 'project.create')?.args)
      .toEqual({ 'body.data': { workspace: 'w1', name: 'Roadmap' } });
  });

  it('executePlannedCreate admits the create past its approval:ask gate (preflight_admitted)', async () => {
    // The create-plan confirm the user answered WAS this create's approval — the
    // standalone gated spine would otherwise degrade an approval:ask op to a policy-
    // fail, so the admission is what lets the approved container create run.
    const captured: Array<Record<string, unknown>> = [];
    const run: RunGatedCatalogOperationFn = async (_d, req) => {
      captured.push(req as unknown as Record<string, unknown>);
      return { ok: true, raw: { result: { data: { gid: 'pNew' } } } };
    };
    const res = await executePlannedCreate(
      { fetchDeps, store, runOperation: run },
      { connection_name: 'acme', manifest: promptManifest, catalogSlug: 'asana' },
      { ref: 'project', create_op: 'project.create', name: 'Roadmap', args: {}, result_path: 'data', id_field: 'gid' },
    );
    expect(res).toEqual({ ok: true, entity_pk: 'pNew' });
    expect(captured[0]?.preflight_admitted).toBe(true);
  });
});

describe('D-192 resolvePromptDependencies (plural — create dispatch)', () => {
  let db: Database.Database;
  let store: SourceDependencyEntityStore;
  const SRC = 'asana.acme.task';
  beforeEach(() => {
    db = new Database(':memory:');
    ensureSourceDependencyEntitySchema(db);
    store = createSourceDependencyEntityStore(db);
    store.replaceEntities(SRC, 'workspace', [{ entity_pk: 'w1', label: 'Acme' }], { now: 0 });
    store.select(SRC, 'workspace', 'w1');
  });
  afterEach(() => db.close());

  const baseCtx = (over: Record<string, unknown> = {}) => ({
    source_id: SRC,
    declaration: { source_dependencies: [workspaceParent, projectLeaf] },
    connection_name: 'acme', manifest: promptManifest, catalogSlug: 'asana', now: 1,
    ...over,
  });

  it('collects a PLANNED container create (decide-only) — no id bound, no side effect', async () => {
    const { run, calls } = scriptPrompt({ 'project.search': [] });
    const out = await resolvePromptDependencies(
      { fetchDeps, store, runOperation: run },
      baseCtx({ named: { project: 'Roadmap' }, isCreateAuthorized: () => true }),
    );
    expect(out).toMatchObject({ ok: true, createArgs: {} }); // no id bound — not created yet
    if (!out.ok) return;
    expect(out.plannedCreates).toMatchObject([
      { ref: 'project', create_op: 'project.create', name: 'Roadmap' },
    ]);
    expect(out.plannedCreates[0]!.args).toEqual({ workspace_id: 'w1', name: 'Roadmap' });
    // no gated create fired — decide is side-effect-free.
    expect(calls.some((c) => c.operationKey === 'project.create')).toBe(false);
  });

  it('wrap_array binds a PICKED container id as a single-element array (Asana body.data.projects)', async () => {
    // an EXISTING 'Roadmap' → picked (not planned); its id binds, array-wrapped.
    const { run } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'Roadmap' }] });
    const out = await resolvePromptDependencies(
      { fetchDeps, store, runOperation: run },
      baseCtx({
        declaration: { source_dependencies: [workspaceParent, projectLeafNested] },
        named: { project: 'Roadmap' }, isCreateAuthorized: () => true,
      }),
    );
    expect(out).toEqual({
      ok: true,
      createArgs: { 'body.data.projects': ['p1'] },
      plannedCreates: [],
    });
  });

  it('bubbles the first ambiguous dependency as an ask (unnamed → pick-only)', async () => {
    const { run } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'A' }, { gid: 'p2', name: 'B' }] });
    const out = await resolvePromptDependencies(
      { fetchDeps, store, runOperation: run },
      baseCtx({ isCreateAuthorized: () => true }),
    );
    // no name → a create is unreachable → the ambiguous set is pick-only.
    expect(out).toMatchObject({ ok: false, kind: 'ask', ask: { ref: 'project', can_create: false } });
  });

  it('skips a prompt dep that does not bind the requested operation', async () => {
    // projectLeaf binds `create`; ask for `update` → nothing to resolve, no fetch.
    const { run, calls } = scriptPrompt({ 'project.search': [{ gid: 'p1', name: 'A' }] });
    const out = await resolvePromptDependencies(
      { fetchDeps, store, runOperation: run },
      baseCtx({ isCreateAuthorized: () => true }),
      'update',
    );
    expect(out).toEqual({ ok: true, createArgs: {}, plannedCreates: [] });
    expect(calls).toHaveLength(0);
  });
});
