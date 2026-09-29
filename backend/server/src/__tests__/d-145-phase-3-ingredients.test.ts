/** D-145 PA3 — Kernel CRUD ingredient dispatcher tests.
 *
 *  Per § Phase PA3 acceptance — per-ingredient input/output contracts,
 *  Source dispatch correctness (Recued built-in vs Connection-Source),
 *  commitment lifecycle state-machine validation, and capability-probe
 *  flip behaviour. Tests exercise the dispatcher composer directly
 *  (the kernel adapter's switch-case wrapper is exercised by
 *  `d-145-phase-3-kernel.test.ts`). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONNECTION_SOURCE_ID,
  parseQualifiedWorkEntityId,
  qualifyWorkEntityId,
  RECUED_BUILTIN_SOURCE_ID,
  taskIdFromIdempotencyKey,
  WORK_ENTITY_KINDS,
  workEntityIdFromIdempotencyKey,
} from '@recued/contracts';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import {
  CommitmentLifecycleError,
  WorkEntityNotFoundError,
  WorkEntityWriteCapabilityError,
  WorkEntityWriteVerifyFailedError,
  createWorkEntityDispatchers,
} from '../work-entity-ingredients.js';
import type {
  WorkEntityReadThroughWriteDispatchOutcome,
  WorkEntitySourceWriteExecutor,
  WorkEntityVendorWriteDispatchOutcome,
  WorkEntityVendorWritePrepared,
  WorkEntityVendorWriteTarget,
} from '../work-entity-write-executor.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let dispatchers: ReturnType<typeof createWorkEntityDispatchers>;

const NOW = 1_700_000_000_000;

/** The dispatch-visible slice of the fake's pass-through prepared
 *  handle (the real executor's `prepared` is opaque to dispatchers, so
 *  the fake threads the prepare input straight through). */
interface FakePrepared {
  source_id: string;
  kind: string;
  operation: 'create' | 'update' | 'delete' | 'complete';
  patch: Record<string, unknown>;
}

/** Fake write executor for the dispatcher seam — every prepare is
 *  vendor-relevant; dispatch is scripted per test. */
const fakeWriteExecutor = (
  onDispatch: (
    input: FakePrepared,
    target?: WorkEntityVendorWriteTarget,
  ) => WorkEntityVendorWriteDispatchOutcome | Promise<WorkEntityVendorWriteDispatchOutcome>,
): WorkEntitySourceWriteExecutor => ({
  prepare: ({ source_id, kind, operation, patch }) => ({
    ok: true,
    vendor_relevant: true,
    prepared: { source_id, kind, operation, patch } as unknown as WorkEntityVendorWritePrepared,
  }),
  dispatch: async (prepared, target) =>
    onDispatch(prepared as unknown as FakePrepared, target),
  // No source dependencies in this seam's fakes — the create-assist preflight
  // resolves to no bound args.
  resolveCreateDependencies: async () => ({ ok: true, createArgs: {}, plannedCreates: [] }),
  executeCreatePlan: async () => ({ ok: false, reason: 'no create plans in this seam fake' }),
  tryFastTrackCreatePlan: async () => ({ ok: false, kind: 'not_granted' }),
});

const registerBuiltins = (s: WorkEntityStore): void => {
  for (const kind of WORK_ENTITY_KINDS) {
    s.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID(kind),
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: 'Recued built-in',
      write_capable: true,
      registered_at: NOW,
    });
  }
};

const buildDispatchers = (
  executor?: WorkEntitySourceWriteExecutor,
  now: () => number = (): number => NOW,
): ReturnType<typeof createWorkEntityDispatchers> => {
  const resolver = createWorkEntityResolver(store);
  return createWorkEntityDispatchers({
    store,
    resolver,
    ...(executor ? { getWriteExecutor: () => executor } : {}),
    now,
  });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd145-pa3-ingredients-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  registerBuiltins(store);
  dispatchers = buildDispatchers();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// idempotent create — note / commitment / project (a task's contract)
// ────────────────────────────────────────────────────────────────

describe('idempotent create for notes, commitments and projects', () => {
  // The check INSIDE the write: a repeat with the same key returns the record
  // the first made, whatever an earlier read saw — the cache cannot answer it,
  // and two runs racing get one record. Same contract a task create has.
  type Kind = 'note' | 'commitment' | 'project';
  const KINDS: Record<Kind, {
    create: (extra: Record<string, unknown>) => Promise<Record<string, unknown>>;
    count: () => number;
    remove: (id: string) => Promise<unknown>;
    plant: (id: string) => void;
    text: string;
  }> = {
    note: {
      create: async (extra) => (await dispatchers.noteCreate({ body: 'Minutes of the sync', ...extra } as never)).note as never,
      count: () => store.countNotes(),
      remove: (id) => dispatchers.noteDelete({ id }),
      plant: (id) => { store.writeNote({ id, source_id: RECUED_BUILTIN_SOURCE_ID('note'), body: 'Unrelated' }, NOW); },
      text: 'body',
    },
    commitment: {
      create: async (extra) => (await dispatchers.commitmentCreate({
        direction: 'outbound', statement: 'Send the revised quote', derivation: 'user_declared', ...extra,
      } as never)).commitment as never,
      count: () => store.countCommitments(),
      remove: (id) => dispatchers.commitmentDelete({ id }),
      plant: (id) => {
        store.writeCommitment({
          id, source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
          direction: 'outbound', statement: 'Unrelated', derivation: 'user_declared',
        }, NOW);
      },
      text: 'statement',
    },
    project: {
      create: async (extra) => (await dispatchers.projectCreate({ title: 'Launch', ...extra } as never)).project as never,
      count: () => store.countProjects(),
      remove: (id) => dispatchers.projectDelete({ id }),
      plant: (id) => { store.writeProject({ id, source_id: RECUED_BUILTIN_SOURCE_ID('project'), title: 'Unrelated' }, NOW); },
      text: 'title',
    },
  };
  const kinds = Object.keys(KINDS) as Kind[];

  it.each(kinds)('%s: a repeat with the same key returns the first record — never a second', async (kind) => {
    const k = KINDS[kind];
    const first = await k.create({ idempotency_key: 'meeting-minutes:site-sync:2026-09-28' });
    const again = await k.create({ idempotency_key: 'meeting-minutes:site-sync:2026-09-28', [k.text]: 'Replayed copy' });
    expect(again.id).toBe(first.id);
    expect(again.id).toBe(workEntityIdFromIdempotencyKey(kind, 'meeting-minutes:site-sync:2026-09-28'));
    expect(again[k.text]).toBe(first[k.text]);
    expect(k.count()).toBe(1);
    // Without a key, two creates are two records — the key is what makes it once.
    await k.create({});
    await k.create({});
    expect(k.count()).toBe(3);
  });

  it.each(kinds)('%s: refuses an invalid key and a vendor Source', async (kind) => {
    const k = KINDS[kind];
    await expect(k.create({ idempotency_key: 'spaces are not stable' })).rejects.toThrow(/idempotency_key/);
    store.registerSource({
      id: `hubspot.acme.${kind}`, top_tier_kind: kind, source_kind: 'connection',
      source_label: 'HubSpot (acme)', write_capable: true, registered_at: NOW,
    });
    await expect(k.create({ idempotency_key: 'workflow:1', source_id: `hubspot.acme.${kind}` }))
      .rejects.toThrow(/Recued-local/);
    expect(k.count()).toBe(0);
  });

  it.each(kinds)('%s: never adopts an unrelated row at the key’s id', async (kind) => {
    const k = KINDS[kind];
    k.plant(workEntityIdFromIdempotencyKey(kind, 'workflow:collide')!);
    await expect(k.create({ idempotency_key: 'workflow:collide' })).rejects.toThrow(/unrelated existing/);
    expect(k.count()).toBe(1);
  });

  it.each(kinds)('%s: does not bring back a record the owner deleted', async (kind) => {
    const k = KINDS[kind];
    const made = await k.create({ idempotency_key: 'workflow:deleted' });
    await k.remove(String(made.id));
    await expect(k.create({ idempotency_key: 'workflow:deleted' })).rejects.toThrow(/tombstoned/);
  });

  it('a task’s id is unchanged by the shared helper', () => {
    expect(workEntityIdFromIdempotencyKey('task', 'workflow:submission-1'))
      .toBe(taskIdFromIdempotencyKey('workflow:submission-1'));
  });
});

// ────────────────────────────────────────────────────────────────
// task-create / task-update / task-delete / task-mark-done
// ────────────────────────────────────────────────────────────────

describe('task-* ingredients', () => {
  it('task-create writes against the Recued built-in by default', async () => {
    const out = await dispatchers.taskCreate({ title: 'pick up groceries' });
    expect(out.task.title).toBe('pick up groceries');
    expect(out.task.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('task'));
    expect(out.task.done).toBe(false);
    expect(out.task.created_at).toBe(NOW);
    expect(out.task.updated_at).toBe(NOW);
  });


  it('task-create idempotency refuses invalid keys and vendor routing', async () => {
    await expect(dispatchers.taskCreate({
      title: 'bad key',
      idempotency_key: 'spaces are not stable',
    })).rejects.toThrow(/idempotency_key/);

    store.registerSource({
      id: 'hubspot.acme.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (acme)',
      write_capable: true,
      registered_at: NOW,
    });
    await expect(dispatchers.taskCreate({
      title: 'wrong cloud',
      idempotency_key: 'workflow:submission-1',
      source_id: 'hubspot.acme.task',
    })).rejects.toThrow(/Recued-local/);
    expect(store.countTasks()).toBe(0);
  });

  it('task-create idempotency never adopts or overwrites an unrelated colliding row', async () => {
    const key = 'workflow:submission-1';
    const id = taskIdFromIdempotencyKey(key)!;
    store.writeTask({
      id,
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'Unrelated existing task',
    }, NOW);

    await expect(dispatchers.taskCreate({
      title: 'Attempted workflow task',
      idempotency_key: key,
    })).rejects.toThrow(/unrelated existing task/);
    expect(store.readTask(id)?.title).toBe('Unrelated existing task');
    expect(store.countTasks()).toBe(1);
  });

  it('task-create idempotency refuses to reuse a tombstoned coordinator task', async () => {
    const key = 'workflow:submission-tombstoned';
    const created = await dispatchers.taskCreate({
      title: 'Coordinator task',
      idempotency_key: key,
    });
    await dispatchers.taskDelete({ id: created.task.id });

    await expect(dispatchers.taskCreate({
      title: 'Coordinator replay',
      idempotency_key: key,
    })).rejects.toThrow(/tombstoned task/);
    expect(store.readTask(created.task.id)).toMatchObject({
      deleted_at: NOW,
      sync_state: 'tombstoned',
    });
  });






  it('task-create rejects unknown source_id', async () => {
    await expect(
      dispatchers.taskCreate({ title: 'bad', source_id: 'recued.nope' }),
    ).rejects.toThrow(/not registered/);
  });

  it('task-create rejects empty-string source_id (Codex P2 fold)', async () => {
    // Empty source_id used to silently fall through to the per-kind
    // default. Recipe interpolation that resolves an unset variable
    // should surface the bug at dispatch time instead.
    await expect(
      dispatchers.taskCreate({ title: 't', source_id: '' }),
    ).rejects.toThrow(/non-empty/);
  });

  it('task-create rejects cross-kind Source', async () => {
    await expect(
      dispatchers.taskCreate({ title: 'bad', source_id: RECUED_BUILTIN_SOURCE_ID('note') }),
    ).rejects.toThrow(/note/);
  });

  it('task-create rejects write to write_capable: false connection-Source', async () => {
    store.registerSource({
      id: 'hubspot.acme.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (acme)',
      write_capable: false,
      registered_at: NOW,
    });
    await expect(
      dispatchers.taskCreate({ title: 'fail', source_id: 'hubspot.acme.task' }),
    ).rejects.toThrow(WorkEntityWriteCapabilityError);
  });

  it('task-create accepts every optional field', async () => {
    const out = await dispatchers.taskCreate({
      title: 'big task',
      body: 'detail',
      due_at: NOW + 1000,
      priority: 'high',
      done: true,
      assigned_contact_id: 'alice@example.com',
      parent_calendar_event_id: 'evt-1',
      linked_mail_thread_id: 'thread-1',
      blocks_task_ids: ['task-2'],
    });
    expect(out.task.body).toBe('detail');
    expect(out.task.due_at).toBe(NOW + 1000);
    expect(out.task.priority).toBe('high');
    expect(out.task.done).toBe(true);
    expect(out.task.completed_at).toBe(NOW);
    expect(out.task.assigned_contact_id).toBe('alice@example.com');
    expect(out.task.blocks_task_ids).toEqual(['task-2']);
  });

  it('task-update patches named fields, preserves source identity', async () => {
    const created = await dispatchers.taskCreate({ title: 'orig', priority: 'low' });
    const updated = await dispatchers.taskUpdate({ id: created.task.id, title: 'new', priority: 'high' });
    expect(updated.task.id).toBe(created.task.id);
    expect(updated.task.title).toBe('new');
    expect(updated.task.priority).toBe('high');
    expect(updated.task.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('task'));
  });

  it('task update/delete resolve a Source-qualified id through the mirror', async () => {
    const sourceId = 'todoist.personal.task';
    store.registerSource({
      id: sourceId,
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'Todoist tasks (personal)',
      write_capable: true,
      registered_at: NOW,
    });
    store.writeTask({
      id: 'mirror-task-1',
      source_id: sourceId,
      source_record_id: 'todoist-native-1',
      title: 'Original',
    }, NOW);
    const qualifiedId = qualifyWorkEntityId({
      kind: 'task',
      source_id: sourceId,
      source_record_id: 'todoist-native-1',
      local_id: 'mirror-task-1',
    });
    dispatchers = buildDispatchers(fakeWriteExecutor(({ operation }) =>
      operation === 'delete'
        ? { ok: true, operation: 'delete' }
        : { ok: true, operation: 'update', applied: 'pushed', verified: false }));

    const updated = await dispatchers.taskUpdate({
      id: qualifiedId,
      title: 'Updated through generic data.task',
    });
    expect(updated.task).toMatchObject({
      id: 'mirror-task-1',
      source_id: sourceId,
      source_record_id: 'todoist-native-1',
      title: 'Updated through generic data.task',
    });
    expect(store.readBySourceIdentity('task', sourceId, 'todoist-native-1')?.id)
      .toBe('mirror-task-1');

    const deleted = await dispatchers.taskDelete({ id: qualifiedId });
    expect(deleted).toEqual({ ok: true, id: qualifiedId, tombstoned: true });
    expect(store.readTask('mirror-task-1')?.sync_state).toBe('tombstoned');
  });

  it('keeps the local row live when the provider delete is proven not to have landed', async () => {
    const sourceId = 'todoist.personal.task';
    store.registerSource({
      id: sourceId,
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'Todoist tasks (personal)',
      write_capable: true,
      registered_at: NOW,
    });
    store.writeTask({
      id: 'mirror-task-delete-guard',
      source_id: sourceId,
      source_record_id: 'todoist-native-delete-guard',
      title: 'Must remain local',
    }, NOW);
    const qualifiedId = qualifyWorkEntityId({
      kind: 'task',
      source_id: sourceId,
      source_record_id: 'todoist-native-delete-guard',
      local_id: 'mirror-task-delete-guard',
    });
    dispatchers = buildDispatchers(fakeWriteExecutor(() => ({
      ok: false,
      kind: 'verify_failed',
      reason: 'the provider still returns the record after task.delete reported success',
      unlanded_fields: [],
      staged: false,
    })));

    await expect(dispatchers.taskDelete({ id: qualifiedId }))
      .rejects.toBeInstanceOf(WorkEntityWriteVerifyFailedError);
    const retained = store.readTask('mirror-task-delete-guard');
    expect(retained).toMatchObject({
      title: 'Must remain local',
      sync_state: 'live',
    });
    expect(retained?.deleted_at).toBeUndefined();
  });

  it('a forged local qualified id fails loud without writing another Source row', async () => {
    const created = await dispatchers.taskCreate({ title: 'Untouched' });
    const wrongSourceId = qualifyWorkEntityId({
      kind: 'task',
      source_id: 'todoist.personal.task',
      local_id: created.task.id,
    });

    await expect(dispatchers.taskUpdate({
      id: wrongSourceId,
      title: 'Must not land',
    })).rejects.toMatchObject({
      code: 'SOURCE_MISMATCH',
      retry_with: 'work.search',
      actual_source: 'todoist.personal.task',
    });
    expect(store.readTask(created.task.id)?.title).toBe('Untouched');
  });

  it('resolves qualified work-entity relationship ids to local foreign keys', async () => {
    const project = await dispatchers.projectCreate({ title: 'Roadmap' });
    const blocker = await dispatchers.taskCreate({ title: 'Foundation' });
    const projectId = qualifyWorkEntityId({
      kind: 'project',
      source_id: project.project.source_id,
      local_id: project.project.id,
    });
    const blockerId = qualifyWorkEntityId({
      kind: 'task',
      source_id: blocker.task.source_id,
      local_id: blocker.task.id,
    });

    const child = await dispatchers.taskCreate({
      title: 'Ship it',
      parent_project_id: projectId,
      blocks_task_ids: [blockerId],
    });
    expect(child.task.parent_project_id).toBe(project.project.id);
    expect(child.task.blocks_task_ids).toEqual([blocker.task.id]);

    const listed = await dispatchers.workEntityList({
      kind: 'task',
      parent_project_id: projectId,
    });
    expect(listed.entities.map((entity) => entity.id)).toContain(child.task.id);
  });

  it('task-update preserves untouched fields', async () => {
    const created = await dispatchers.taskCreate({ title: 'orig', body: 'keep' });
    const updated = await dispatchers.taskUpdate({ id: created.task.id, title: 'new' });
    expect(updated.task.body).toBe('keep');
  });

  it('task-update patches state without clearing progress', async () => {
    const created = await dispatchers.taskCreate({
      title: 'codex run',
      state: 'queued',
      progress: 25,
    });
    const updated = await dispatchers.taskUpdate({
      id: created.task.id,
      state: 'running',
    });
    expect(updated.task.state).toBe('running');
    expect(updated.task.progress).toBe(25);
  });

  it('task-update treats explicit null on an unset field as absent (preserve, never reject/clear)', async () => {
    // Regression (D-179 live-verification finding): the engine fills an
    // ingredient's declared-but-unset input with its `null` manifest default,
    // so an ad-hoc `task-update` of one field arrives with `null` on the rest.
    // The legacy fields used `!== undefined`, so that `null` either rejected
    // (`due_at must be a finite number` / `unknown priority 'null'`) or silently
    // cleared the field. Aligned to `!= null` (matching create + state/progress):
    // a null falls through to the existing value.
    const created = await dispatchers.taskCreate({
      title: 'codex run',
      body: 'keep me',
      due_at: NOW + 86_400_000,
      priority: 'high',
      assigned_contact_id: 'alice@example.com',
      state: 'queued',
    });
    const updated = await dispatchers.taskUpdate({
      id: created.task.id,
      state: 'running',
      // every other field arrives null, exactly as the manifest merge supplies it.
      body: null as unknown as string,
      due_at: null as unknown as number,
      priority: null as unknown as import('@recued/contracts').TaskPriority,
      assigned_contact_id: null as unknown as string,
    });
    expect(updated.task.state).toBe('running'); // the one supplied field applied
    expect(updated.task.body).toBe('keep me'); // null → preserved, not cleared
    expect(updated.task.due_at).toBe(NOW + 86_400_000); // null → preserved, not rejected
    expect(updated.task.priority).toBe('high'); // null → preserved, not "unknown priority"
    expect(updated.task.assigned_contact_id).toBe('alice@example.com'); // null → preserved
  });

  it('task-update on missing id throws WorkEntityNotFoundError', async () => {
    await expect(
      dispatchers.taskUpdate({ id: 'nope', title: 'x' }),
    ).rejects.toThrow(WorkEntityNotFoundError);
  });

  it('task-delete tombstones by default', async () => {
    const created = await dispatchers.taskCreate({ title: 't' });
    const out = await dispatchers.taskDelete({ id: created.task.id });
    expect(out).toEqual({ ok: true, id: created.task.id, tombstoned: true });
    // Tombstoned rows survive but with sync_state flipped.
    const row = store.readTask(created.task.id);
    expect(row?.sync_state).toBe('tombstoned');
    expect(row?.deleted_at).toBe(NOW);
  });

  it('task-delete hard-deletes when tombstone: false', async () => {
    const created = await dispatchers.taskCreate({ title: 't' });
    const out = await dispatchers.taskDelete({ id: created.task.id, tombstone: false });
    expect(out.tombstoned).toBe(false);
    expect(store.readTask(created.task.id)).toBeNull();
  });

  it('task-delete on missing id throws', async () => {
    await expect(dispatchers.taskDelete({ id: 'nope' })).rejects.toThrow(WorkEntityNotFoundError);
  });

  it('task-mark-done flips done + stamps completed_at', async () => {
    const created = await dispatchers.taskCreate({ title: 't' });
    expect(created.task.done).toBe(false);
    const later = NOW + 5000;
    dispatchers = buildDispatchers(undefined, () => later);
    const out = await dispatchers.taskMarkDone({ id: created.task.id });
    expect(out.task.done).toBe(true);
    expect(out.task.completed_at).toBe(later);
  });

  it('task-mark-done with done: false un-completes', async () => {
    const created = await dispatchers.taskCreate({ title: 't', done: true });
    expect(created.task.done).toBe(true);
    const out = await dispatchers.taskMarkDone({ id: created.task.id, done: false });
    expect(out.task.done).toBe(false);
    expect(out.task.completed_at).toBeUndefined();
  });

  it('task-mark-done accepts explicit completed_at', async () => {
    const created = await dispatchers.taskCreate({ title: 't' });
    const stamp = NOW - 1000;
    const out = await dispatchers.taskMarkDone({ id: created.task.id, completed_at: stamp });
    expect(out.task.completed_at).toBe(stamp);
  });

  it('task-mark-done preserves state and progress through its upsert', async () => {
    const created = await dispatchers.taskCreate({
      title: 'codex run',
      state: 'running',
      progress: 80,
    });
    const out = await dispatchers.taskMarkDone({ id: created.task.id });
    expect(out.task.done).toBe(true);
    expect(out.task.state).toBe('running');
    expect(out.task.progress).toBe(80);
    expect(store.readTask(created.task.id)).toMatchObject({
      state: 'running',
      progress: 80,
    });
  });
});

// ────────────────────────────────────────────────────────────────
// note-create / note-update / note-delete
// ────────────────────────────────────────────────────────────────

describe('note-* ingredients', () => {
  it('note-create writes against the Recued built-in by default', async () => {
    const out = await dispatchers.noteCreate({ body: 'remember this' });
    expect(out.note.body).toBe('remember this');
    expect(out.note.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('note'));
    expect(out.note.last_user_action_at).toBe(NOW);
  });

  it('note-create accepts title + related_*_ids', async () => {
    const out = await dispatchers.noteCreate({
      body: 'meeting notes',
      title: '2026 Q1 review',
      related_contact_ids: ['alice@example.com'],
      related_mail_thread_ids: ['thread-1'],
      related_project_ids: ['project-1'],
    });
    expect(out.note.title).toBe('2026 Q1 review');
    expect(out.note.related_contact_ids).toEqual(['alice@example.com']);
    expect(out.note.related_mail_thread_ids).toEqual(['thread-1']);
    expect(out.note.related_project_ids).toEqual(['project-1']);
  });

  it('note-update advances last_user_action_at', async () => {
    const created = await dispatchers.noteCreate({ body: 'orig' });
    const later = NOW + 7777;
    dispatchers = buildDispatchers(undefined, () => later);
    const out = await dispatchers.noteUpdate({ id: created.note.id, body: 'new' });
    expect(out.note.body).toBe('new');
    expect(out.note.last_user_action_at).toBe(later);
  });

  it('note-update preserves untouched fields', async () => {
    const created = await dispatchers.noteCreate({
      body: 'orig',
      title: 'keep',
      related_project_ids: ['p-1'],
    });
    const out = await dispatchers.noteUpdate({ id: created.note.id, body: 'new' });
    expect(out.note.title).toBe('keep');
    expect(out.note.related_project_ids).toEqual(['p-1']);
  });

  it('note update/delete resolve a Source-qualified id and dispatch to its Source', async () => {
    const sourceId = 'hubspot.personal.note';
    store.registerSource({
      id: sourceId,
      top_tier_kind: 'note',
      source_kind: 'connection',
      source_label: 'HubSpot notes (personal)',
      write_capable: true,
      registered_at: NOW,
    });
    store.writeNote({
      id: 'mirror-note-1',
      source_id: sourceId,
      source_record_id: 'note-native-1',
      body: 'Original',
    }, NOW);
    const calls: FakePrepared[] = [];
    const targets: Array<WorkEntityVendorWriteTarget | undefined> = [];
    dispatchers = buildDispatchers(fakeWriteExecutor((input, target) => {
      calls.push(input);
      targets.push(target);
      return input.operation === 'delete'
        ? { ok: true, operation: 'delete' }
        : { ok: true, operation: 'update', applied: 'pushed', verified: false };
    }));
    const qualifiedId = qualifyWorkEntityId({
      kind: 'note',
      source_id: sourceId,
      source_record_id: 'note-native-1',
      local_id: 'mirror-note-1',
    });

    const out = await dispatchers.noteUpdate({ id: qualifiedId, body: 'Updated' });
    expect(out.note).toMatchObject({
      id: 'mirror-note-1',
      source_id: sourceId,
      source_record_id: 'note-native-1',
      body: 'Updated',
    });
    expect(calls[0]).toMatchObject({
      source_id: sourceId,
      kind: 'note',
      operation: 'update',
      patch: { body: 'Updated' },
    });
    expect(targets[0]).toMatchObject({
      local_id: 'mirror-note-1',
      prior: { source_id: sourceId, source_record_id: 'note-native-1' },
      current: { source_id: sourceId, source_record_id: 'note-native-1' },
    });

    const deleted = await dispatchers.noteDelete({ id: qualifiedId });
    expect(deleted).toEqual({ ok: true, id: qualifiedId, tombstoned: true });
    expect(calls.map(({ operation }) => operation)).toEqual(['update', 'delete']);
    expect(targets[1]).toMatchObject({
      local_id: 'mirror-note-1',
      prior: { source_id: sourceId, source_record_id: 'note-native-1' },
    });
    expect(store.readNote('mirror-note-1')?.sync_state).toBe('tombstoned');
  });

  it('note-update on missing id throws', async () => {
    await expect(dispatchers.noteUpdate({ id: 'nope', body: 'x' })).rejects.toThrow(WorkEntityNotFoundError);
  });

  it('note-delete tombstones by default', async () => {
    const created = await dispatchers.noteCreate({ body: 'n' });
    const out = await dispatchers.noteDelete({ id: created.note.id });
    expect(out.tombstoned).toBe(true);
    expect(store.readNote(created.note.id)?.sync_state).toBe('tombstoned');
  });

  it('note-delete hard-deletes when tombstone: false', async () => {
    const created = await dispatchers.noteCreate({ body: 'n' });
    const out = await dispatchers.noteDelete({ id: created.note.id, tombstone: false });
    expect(out.tombstoned).toBe(false);
    expect(store.readNote(created.note.id)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// commitment-create / commitment-update / commitment-fulfill / commitment-cancel
// ────────────────────────────────────────────────────────────────

describe('commitment-* ingredients', () => {
  it('commitment-create defaults lifecycle to pending + due_status to no_deadline', async () => {
    const out = await dispatchers.commitmentCreate({
      direction: 'outbound',
      statement: 'pay invoice',
      derivation: 'user_declared',
    });
    expect(out.commitment.lifecycle_state).toBe('pending');
    expect(out.commitment.due_status).toBe('no_deadline');
    expect(out.commitment.expiry_policy).toBe('escalate_overdue');
  });

  it('commitment-create with promised_for_at sets due_status to not_due', async () => {
    const out = await dispatchers.commitmentCreate({
      direction: 'inbound',
      statement: 'deliver report',
      derivation: 'mail_extracted',
      promised_for_at: NOW + 1_000_000,
    });
    expect(out.commitment.due_status).toBe('not_due');
    expect(out.commitment.promised_for_at).toBe(NOW + 1_000_000);
  });

  it('commitment-create accepts monetary_value', async () => {
    const out = await dispatchers.commitmentCreate({
      direction: 'outbound',
      statement: 'payment',
      derivation: 'user_declared',
      monetary_value: { amount: '500.00', currency: 'USD' },
      counterparty_contact_id: 'vendor@example.com',
    });
    expect(out.commitment.monetary_value).toEqual({ amount: '500.00', currency: 'USD' });
  });

  it('commitment-update patches metadata fields without touching lifecycle', async () => {
    const created = await dispatchers.commitmentCreate({
      direction: 'outbound',
      statement: 'orig',
      derivation: 'user_declared',
    });
    const updated = await dispatchers.commitmentUpdate({
      id: created.commitment.id,
      statement: 'new statement',
    });
    expect(updated.commitment.statement).toBe('new statement');
    expect(updated.commitment.lifecycle_state).toBe('pending');
  });

  it('commitment-fulfill moves pending → fulfilled', async () => {
    const created = await dispatchers.commitmentCreate({
      direction: 'outbound',
      statement: 's',
      derivation: 'user_declared',
    });
    const later = NOW + 100;
    dispatchers = buildDispatchers(undefined, () => later);
    const out = await dispatchers.commitmentFulfill({ id: created.commitment.id });
    expect(out.commitment.lifecycle_state).toBe('fulfilled');
    expect(out.commitment.lifecycle_changed_at).toBe(later);
    expect(out.commitment.state_changed_at).toBe(later);
  });

  it('commitment-fulfill accepts explicit fulfilled_at', async () => {
    const created = await dispatchers.commitmentCreate({
      direction: 'outbound',
      statement: 's',
      derivation: 'user_declared',
    });
    const stamp = NOW - 200;
    const out = await dispatchers.commitmentFulfill({ id: created.commitment.id, fulfilled_at: stamp });
    expect(out.commitment.lifecycle_changed_at).toBe(stamp);
  });

  it('commitment-cancel moves pending → cancelled', async () => {
    const created = await dispatchers.commitmentCreate({
      direction: 'inbound',
      statement: 's',
      derivation: 'user_declared',
    });
    const out = await dispatchers.commitmentCancel({ id: created.commitment.id });
    expect(out.commitment.lifecycle_state).toBe('cancelled');
  });

  it('commitment-fulfill rejects fulfilled commitment (terminal)', async () => {
    const created = await dispatchers.commitmentCreate({
      direction: 'outbound',
      statement: 's',
      derivation: 'user_declared',
    });
    await dispatchers.commitmentFulfill({ id: created.commitment.id });
    await expect(
      dispatchers.commitmentFulfill({ id: created.commitment.id }),
    ).rejects.toThrow(CommitmentLifecycleError);
  });

  it('commitment-cancel rejects cancelled commitment (terminal)', async () => {
    const created = await dispatchers.commitmentCreate({
      direction: 'outbound',
      statement: 's',
      derivation: 'user_declared',
    });
    await dispatchers.commitmentCancel({ id: created.commitment.id });
    await expect(
      dispatchers.commitmentCancel({ id: created.commitment.id }),
    ).rejects.toThrow(CommitmentLifecycleError);
  });

  it('commitment-fulfill rejects fulfilled→cancelled', async () => {
    const created = await dispatchers.commitmentCreate({
      direction: 'outbound',
      statement: 's',
      derivation: 'user_declared',
    });
    await dispatchers.commitmentFulfill({ id: created.commitment.id });
    await expect(
      dispatchers.commitmentCancel({ id: created.commitment.id }),
    ).rejects.toThrow(CommitmentLifecycleError);
  });

  it('expired → fulfilled allowed under escalate_overdue (§ A.1.3 invariant)', async () => {
    const created = store.writeCommitment({
      source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
      direction: 'outbound',
      statement: 's',
      derivation: 'user_declared',
      lifecycle_state: 'expired',
      expiry_policy: 'escalate_overdue',
    });
    const out = await dispatchers.commitmentFulfill({ id: created.id });
    expect(out.commitment.lifecycle_state).toBe('fulfilled');
  });

  it('expired → fulfilled allowed under indefinite', async () => {
    const created = store.writeCommitment({
      source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
      direction: 'outbound',
      statement: 's',
      derivation: 'user_declared',
      lifecycle_state: 'expired',
      expiry_policy: 'indefinite',
    });
    const out = await dispatchers.commitmentFulfill({ id: created.id });
    expect(out.commitment.lifecycle_state).toBe('fulfilled');
  });

  it('expired → fulfilled rejected under strict_expire (terminal at deadline)', async () => {
    const created = store.writeCommitment({
      source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
      direction: 'outbound',
      statement: 's',
      derivation: 'user_declared',
      lifecycle_state: 'expired',
      expiry_policy: 'strict_expire',
    });
    await expect(
      dispatchers.commitmentFulfill({ id: created.id }),
    ).rejects.toThrow(/strict_expire/);
  });

  it('expired → cancelled allowed under any expiry_policy', async () => {
    for (const policy of ['escalate_overdue', 'strict_expire', 'indefinite'] as const) {
      const created = store.writeCommitment({
        source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
        direction: 'outbound',
        statement: `s-${policy}`,
        derivation: 'user_declared',
        lifecycle_state: 'expired',
        expiry_policy: policy,
      });
      const out = await dispatchers.commitmentCancel({ id: created.id });
      expect(out.commitment.lifecycle_state).toBe('cancelled');
    }
  });

  it('commitment-fulfill on missing id throws WorkEntityNotFoundError', async () => {
    await expect(
      dispatchers.commitmentFulfill({ id: 'nope' }),
    ).rejects.toThrow(WorkEntityNotFoundError);
  });

  it('commitment-create rejects invalid monetary_value amount', async () => {
    await expect(
      dispatchers.commitmentCreate({
        direction: 'outbound',
        statement: 's',
        derivation: 'user_declared',
        monetary_value: { amount: 'twelve', currency: 'USD' },
      }),
    ).rejects.toThrow(/decimal string/);
  });

  it('commitment-create rejects invalid currency', async () => {
    await expect(
      dispatchers.commitmentCreate({
        direction: 'outbound',
        statement: 's',
        derivation: 'user_declared',
        monetary_value: { amount: '1.00', currency: 'usd' },
      }),
    ).rejects.toThrow(/ISO 4217/);
  });
});

// ────────────────────────────────────────────────────────────────
// project-create / project-update / project-archive
// ────────────────────────────────────────────────────────────────

describe('project-* ingredients', () => {
  it('project-create defaults state to active + last_activity_at to now', async () => {
    const out = await dispatchers.projectCreate({ title: 'Q1 launch' });
    expect(out.project.state).toBe('active');
    expect(out.project.last_activity_at).toBe(NOW);
  });

  it('project-create accepts state, target_completion_at, parent_project_id', async () => {
    const parent = await dispatchers.projectCreate({ title: 'parent' });
    const out = await dispatchers.projectCreate({
      title: 'child',
      state: 'paused',
      target_completion_at: NOW + 90 * 86_400_000,
      parent_project_id: parent.project.id,
    });
    expect(out.project.state).toBe('paused');
    expect(out.project.target_completion_at).toBe(NOW + 90 * 86_400_000);
    expect(out.project.parent_project_id).toBe(parent.project.id);
  });

  it('project-update patches title + state', async () => {
    const created = await dispatchers.projectCreate({ title: 'orig' });
    const out = await dispatchers.projectUpdate({
      id: created.project.id,
      title: 'new',
      state: 'completed',
    });
    expect(out.project.title).toBe('new');
    expect(out.project.state).toBe('completed');
  });

  it('project update/delete resolve a Source-qualified id and dispatch to its Source', async () => {
    const sourceId = 'linear.personal.project';
    store.registerSource({
      id: sourceId,
      top_tier_kind: 'project',
      source_kind: 'connection',
      source_label: 'Linear projects (personal)',
      write_capable: true,
      registered_at: NOW,
    });
    store.writeProject({
      id: 'mirror-project-1',
      source_id: sourceId,
      source_record_id: 'project-native-1',
      title: 'Original',
    }, NOW);
    const calls: FakePrepared[] = [];
    const targets: Array<WorkEntityVendorWriteTarget | undefined> = [];
    dispatchers = buildDispatchers(fakeWriteExecutor((input, target) => {
      calls.push(input);
      targets.push(target);
      return input.operation === 'delete'
        ? { ok: true, operation: 'delete' }
        : { ok: true, operation: 'update', applied: 'pushed', verified: false };
    }));
    const qualifiedId = qualifyWorkEntityId({
      kind: 'project',
      source_id: sourceId,
      source_record_id: 'project-native-1',
      local_id: 'mirror-project-1',
    });

    const out = await dispatchers.projectUpdate({
      id: qualifiedId,
      title: 'Updated',
    });
    expect(out.project).toMatchObject({
      id: 'mirror-project-1',
      source_id: sourceId,
      source_record_id: 'project-native-1',
      title: 'Updated',
    });
    expect(calls[0]).toMatchObject({
      source_id: sourceId,
      kind: 'project',
      operation: 'update',
      patch: { title: 'Updated' },
    });
    expect(targets[0]).toMatchObject({
      local_id: 'mirror-project-1',
      prior: { source_id: sourceId, source_record_id: 'project-native-1' },
      current: { source_id: sourceId, source_record_id: 'project-native-1' },
    });

    const deleted = await dispatchers.projectDelete({ id: qualifiedId });
    expect(deleted).toEqual({ ok: true, id: qualifiedId, tombstoned: true });
    expect(calls.map(({ operation }) => operation)).toEqual(['update', 'delete']);
    expect(targets[1]).toMatchObject({
      local_id: 'mirror-project-1',
      prior: { source_id: sourceId, source_record_id: 'project-native-1' },
    });
    expect(store.readProject('mirror-project-1')?.sync_state).toBe('tombstoned');
  });

  it('project-update on missing id throws', async () => {
    await expect(
      dispatchers.projectUpdate({ id: 'nope' }),
    ).rejects.toThrow(WorkEntityNotFoundError);
  });

  it('project-archive sets state to archived', async () => {
    const created = await dispatchers.projectCreate({ title: 't' });
    const out = await dispatchers.projectArchive({ id: created.project.id });
    expect(out.project.state).toBe('archived');
  });

  it('project-archive is idempotent (already archived → no-op)', async () => {
    const created = await dispatchers.projectCreate({ title: 't', state: 'archived' });
    const out = await dispatchers.projectArchive({ id: created.project.id });
    expect(out.project.state).toBe('archived');
    expect(out.project.id).toBe(created.project.id);
  });

  it('project-archive on missing id throws', async () => {
    await expect(
      dispatchers.projectArchive({ id: 'nope' }),
    ).rejects.toThrow(WorkEntityNotFoundError);
  });
});

// ────────────────────────────────────────────────────────────────
// Source dispatch — connection-Source vendor probe seam
// ────────────────────────────────────────────────────────────────

describe('connection-Source vendor probe', () => {
  beforeEach(() => {
    store.registerSource({
      id: CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'),
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (acme)',
      write_capable: false,
      registered_at: NOW,
    });
  });

  it('flips write_capable to true on first successful vendor probe', async () => {
    const calls: Array<{ operation: string }> = [];
    dispatchers = buildDispatchers(fakeWriteExecutor(({ operation }) => {
      calls.push({ operation });
      return { ok: true, operation: 'create', source_record_id: 'hs-task-123' };
    }));
    const out = await dispatchers.taskCreate({
      title: 'follow up',
      source_id: CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'),
    });
    expect(out.task.source_id).toBe(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'));
    expect(out.task.source_record_id).toBe('hs-task-123');
    expect(calls).toEqual([{ operation: 'create' }]);
    // Source row should now report write_capable: true.
    const reg = store.getSource(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'));
    expect(reg?.write_capable).toBe(true);
  });

  it('preserves registered_at across capability flip', async () => {
    const ORIGINAL = NOW - 86_400_000; // 1 day before NOW
    store.registerSource({
      id: CONNECTION_SOURCE_ID('hubspot', 'beta', 'task'),
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (beta)',
      write_capable: false,
      registered_at: ORIGINAL,
    });
    dispatchers = buildDispatchers(fakeWriteExecutor(() => ({
      ok: true,
      operation: 'create',
      source_record_id: 'hs-task-beta-1',
    })));
    await dispatchers.taskCreate({
      title: 't',
      source_id: CONNECTION_SOURCE_ID('hubspot', 'beta', 'task'),
    });
    const reg = store.getSource(CONNECTION_SOURCE_ID('hubspot', 'beta', 'task'));
    expect(reg?.registered_at).toBe(ORIGINAL);
    expect(reg?.write_capable).toBe(true);
  });

  it('keeps write_capable false when vendor probe fails', async () => {
    dispatchers = buildDispatchers(fakeWriteExecutor(() => ({
      ok: false,
      kind: 'error',
      reason: 'scope_missing',
      staged: false,
    })));
    await expect(
      dispatchers.taskCreate({
        title: 'fail',
        source_id: CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'),
      }),
    ).rejects.toThrow(/scope_missing/);
    const reg = store.getSource(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'));
    expect(reg?.write_capable).toBe(false);
  });

  it('rejects write_capable: false connection-Source when no write executor is wired', async () => {
    // Default `dispatchers` from the outer beforeEach has no executor.
    await expect(
      dispatchers.taskCreate({
        title: 'fail',
        source_id: CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'),
      }),
    ).rejects.toThrow(WorkEntityWriteCapabilityError);
  });

  it('dispatches through the write executor on every write — even when already write_capable (Codex P1 fold)', async () => {
    let called = 0;
    // Pre-flip the Source so we exercise the "already write_capable"
    // branch — the prior shape skipped the dispatch here, leaving the
    // local row with source_record_id: null. Codex P1 closed: every
    // connection-Source write must dispatch so the local mirror
    // carries the vendor-native id.
    store.registerSource({
      id: CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'),
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (acme)',
      write_capable: true,
      registered_at: NOW,
    });
    dispatchers = buildDispatchers(fakeWriteExecutor(() => {
      called += 1;
      return { ok: true, operation: 'create', source_record_id: `hs-${called}` };
    }));
    const out1 = await dispatchers.taskCreate({
      title: 'first',
      source_id: CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'),
    });
    expect(called).toBe(1);
    expect(out1.task.source_record_id).toBe('hs-1');
    const out2 = await dispatchers.taskCreate({
      title: 'second',
      source_id: CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'),
    });
    expect(called).toBe(2);
    expect(out2.task.source_record_id).toBe('hs-2');
  });

  it('rejects already-write-capable connection-Source when the write executor is missing (invariant)', async () => {
    // write_capable: true with no executor is an invariant violation —
    // how did the flag flip without one? Substrate refuses the write
    // rather than silently producing a row with no upstream id.
    store.registerSource({
      id: CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'),
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks (acme)',
      write_capable: true,
      registered_at: NOW,
    });
    // No executor supplied to dispatchers (default outer beforeEach setup).
    await expect(
      dispatchers.taskCreate({
        title: 'fail',
        source_id: CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'),
      }),
    ).rejects.toThrow(WorkEntityWriteCapabilityError);
  });
});

// ────────────────────────────────────────────────────────────────
// registerSource UPSERT semantics — load-bearing for the probe
// ────────────────────────────────────────────────────────────────

describe('registerSource UPSERT semantics', () => {
  it('preserves registered_at on re-register (idempotent boot)', () => {
    const ORIGINAL = NOW - 1000;
    store.registerSource({
      id: 'recued.task',
      top_tier_kind: 'task',
      source_kind: 'builtin',
      source_label: 'Recued built-in',
      write_capable: true,
      registered_at: ORIGINAL,
    });
    const reg = store.getSource('recued.task');
    expect(reg?.registered_at).toBe(NOW); // beforeEach's registerBuiltins ran first at NOW
    // Now flip write_capable; registered_at should NOT advance.
    store.registerSource({
      id: 'recued.task',
      top_tier_kind: 'task',
      source_kind: 'builtin',
      source_label: 'Recued built-in',
      write_capable: false,
      registered_at: NOW + 999,
    });
    const flipped = store.getSource('recued.task');
    expect(flipped?.registered_at).toBe(NOW);
    expect(flipped?.write_capable).toBe(false);
  });

  it('rejects re-register with mismatched top_tier_kind', () => {
    expect(() =>
      store.registerSource({
        id: 'recued.task',
        top_tier_kind: 'note',
        source_kind: 'builtin',
        source_label: 'Recued built-in',
        write_capable: true,
        registered_at: NOW,
      }),
    ).toThrow(/already registered/);
  });
});

// ────────────────────────────────────────────────────────────────
// read_through Sources vs the generic LOCAL reads.
//
// `work.search` / `work.read` invoke a read_through Source on demand. The
// recipe-callable `work-entity-list` / `work-entity-get` read the canonical
// tables instead, where a read_through Source has nothing — so before this
// guard they answered "no rows" / "not found" for records that exist and are
// readable. A wrong answer, not a missing feature: refuse and name the surface
// that can fetch it.
// ────────────────────────────────────────────────────────────────

describe('read_through Sources and the generic local reads', () => {
  const PEER_SOURCE = 'recued-peer.hq.task';

  beforeEach(() => {
    store.registerSource({
      id: PEER_SOURCE,
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'Federated peer (task)',
      write_capable: true,
      sync_posture: 'read_through',
      registered_at: NOW,
    });
  });

  it('work-entity-list refuses a read_through source_id instead of answering empty', async () => {
    await expect(
      dispatchers.workEntityList({ kind: 'task', source_id: PEER_SOURCE }),
    ).rejects.toThrow(/read_through/);
  });

  it('work-entity-list drops rows an interrupted posture migration left behind', async () => {
    // What a half-finished migration leaves in the canonical table. The
    // declaration says these rows do not exist, so no reader may serve them.
    store.writeTask({ source_id: PEER_SOURCE, title: 'migration residue' }, NOW);
    const listed = await dispatchers.workEntityList({ kind: 'task' });

    expect(listed.entities.map((entity) => entity.source_id)).not.toContain(PEER_SOURCE);
    // `total` stays on the same basis as the rows — a count that still
    // included the residue would re-advertise exactly what was filtered.
    expect(listed.total).toBe(listed.entities.length);
  });

  it('work-entity-get refuses a read_through qualified id instead of reporting not-found', async () => {
    const id = qualifyWorkEntityId({
      kind: 'task',
      source_id: PEER_SOURCE,
      source_record_id: 'peer-task-1',
      local_id: 'no-local-row',
    });

    await expect(dispatchers.workEntityGet({ kind: 'task', id })).rejects.toThrow(/read_through/);
  });
});

// ────────────────────────────────────────────────────────────────
// Read-through CREATE at the dispatcher seam. The point of the feature is the
// round trip: the id a create hands back must route the very next write to the
// same remote record, with no local row in between.
// ────────────────────────────────────────────────────────────────

describe('read_through create', () => {
  const RT_SOURCE = 'recued-peer.hq.task';

  /** A write executor whose read-through lane mints 'peer-1' and projects it. */
  const readThroughExecutor = (
    onCreate: () => WorkEntityReadThroughWriteDispatchOutcome = () => ({
      ok: true,
      operation: 'create',
      source_record_id: 'peer-1',
      projected: {
        kind: 'task',
        write: { source_id: RT_SOURCE, source_record_id: 'peer-1', title: 'From the peer' },
      },
      verified: true,
    }),
  ): WorkEntitySourceWriteExecutor => ({
    prepare: () => ({ ok: false, kind: 'config', reason: 'mirror prepare must not be reached' }),
    dispatch: async () => ({ ok: false, kind: 'error', reason: 'unused', staged: false }),
    prepareReadThrough: ({ source_id, kind, operation, patch }) => ({
      ok: true,
      vendor_relevant: true,
      prepared: {
        source_id, kind, operation, patch,
        // The update lane intersects the patch with what can actually be
        // pushed; a fake without it would not exercise that guard.
        pushable: Object.keys(patch).map((field) => ({ field })),
      } as unknown as WorkEntityVendorWritePrepared,
    }),
    dispatchReadThrough: async () => ({
      ok: false, kind: 'error', reason: 'unused in these cases', staged: false,
    }),
    dispatchReadThroughCreate: async () => onCreate(),
    resolveCreateDependencies: async () => ({ ok: true, createArgs: {}, plannedCreates: [] }),
    executeCreatePlan: async () => ({ ok: false, reason: 'unused' }),
    tryFastTrackCreatePlan: async () => ({ ok: false, kind: 'not_granted' }),
  });

  beforeEach(() => {
    store.registerSource({
      id: RT_SOURCE,
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'Federated peer (task)',
      write_capable: true,
      sync_posture: 'read_through',
      registered_at: NOW,
    });
  });

  it('answers with the Source-qualified id the vendor minted, and writes no local row', async () => {
    dispatchers = buildDispatchers(readThroughExecutor());

    const out = await dispatchers.taskCreate({ title: 'From the peer', source_id: RT_SOURCE });

    // The id IS the route for the next write — kind, Source, and the vendor's
    // own record id, all recoverable without asking the model to remember them.
    expect(parseQualifiedWorkEntityId(out.task.id)).toEqual({
      version: 'we1',
      kind: 'task',
      source_id: RT_SOURCE,
      identity: 'source',
      record_id: 'peer-1',
    });
    expect(out.task.title).toBe('From the peer');
    // The whole point of the posture: nothing landed in the canonical table.
    expect(store.listByKind('task', { source_id: RT_SOURCE })).toEqual([]);
    expect(store.countByKind('task', { source_id: RT_SOURCE })).toBe(0);
  });

  it('the id it returns routes the next update back to the same remote record', async () => {
    let updatedRecordId: string | undefined;
    const executor = readThroughExecutor();
    executor.dispatchReadThrough = async (_prepared, source_record_id) => {
      updatedRecordId = source_record_id;
      return {
        ok: true,
        operation: 'update',
        projected: {
          kind: 'task',
          write: { source_id: RT_SOURCE, source_record_id: 'peer-1', title: 'Renamed' },
        },
        verified: true,
      };
    };
    dispatchers = buildDispatchers(executor);

    const created = await dispatchers.taskCreate({ title: 'From the peer', source_id: RT_SOURCE });
    const updated = await dispatchers.taskUpdate({ id: created.task.id, title: 'Renamed' });

    // No local lookup could have supplied this — it came out of the create's id.
    expect(updatedRecordId).toBe('peer-1');
    expect(updated.task.title).toBe('Renamed');
    expect(updated.task.id).toBe(created.task.id);
  });

  it('refuses fields that would land only locally, instead of dropping them', async () => {
    dispatchers = buildDispatchers(readThroughExecutor());

    // `parent_project_id` rides the local FK lane and never reaches the vendor.
    // Accepting it would report success while silently discarding the link.
    await expect(
      dispatchers.taskCreate({
        title: 'From the peer',
        source_id: RT_SOURCE,
        parent_project_id: 'proj-local',
      }),
    ).rejects.toThrow(/parent_project_id/);
  });

  it('propagates a created-but-unverifiable failure rather than inventing a row', async () => {
    dispatchers = buildDispatchers(
      readThroughExecutor(() => ({
        ok: false,
        kind: 'verify_failed',
        reason: "'task.create' created record 'peer-1', but the provider result could not be projected",
        unlanded_fields: ['title'],
        staged: false,
        source_record_id: 'peer-1',
      })),
    );

    await expect(
      dispatchers.taskCreate({ title: 'From the peer', source_id: RT_SOURCE }),
    ).rejects.toThrow(/peer-1/);
    expect(store.countByKind('task', { source_id: RT_SOURCE })).toBe(0);
  });
});
