/** Slice 3 — `work.update`: one tool, two substrate verbs, and the refusal that
 *  keeps them apart.
 *
 *  ⛔ `done` IS NOT A FIELD. `work-entities.ts` is explicit: *"`state` never
 *  auto-flips `done`: `done` stays the single completion bit (mark-done
 *  dispatcher + `completed` reactive events)"*, and `handleWorkEntityUpsert`
 *  carries no `done` field at all. So a completion routed through the upsert
 *  path would be silently DROPPED — accepted, approved by the owner, reported
 *  done, and not done. That is the defect this file exists for, and it is
 *  invisible to any test that only checks the happy path.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionSource } from '@recued/contracts';
import {
  RECUED_BUILTIN_SOURCE_ID,
  TIER1_CONCURRENCY_SAFE,
  TIER1_TOOL_DESCRIPTORS,
} from '@recued/contracts';
import { planApproval } from '@recued/gateway';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import type { ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const ownerSource: ExecutionSource = {
  channel: 'messenger',
  actor: 'user_self',
  vendor: 'telegram',
  from: '12345',
};
const ctx = () => ({ execution_source: ownerSource, session_id: 's1' }) as never;

const ALL_OPS = [
  'core.work-entity.task.update',
  'core.work-entity.note.update',
  'core.work-entity.commitment.update',
  'core.work-entity.project.update',
  'core.work-entity.task.mark-done',
];

const NOW = 1_700_000_000_000;

/** ⛔ THE DOUBLE SITS AT THE DISPATCHER, NOT AT THE DEPS OBJECT — the same rule
 *  `work-create-tier1-tool.test.ts` states, and the one this file broke.
 *
 *  The handler calls the REAL `handleWorkEntityUpsert`, and since `0c36e3dd2`
 *  that handler's TASK-update branch reads the row back through `store` +
 *  `resolver` before it dispatches (`withTaskMutation` serialises per task id;
 *  `requireWritableStoredTask` refuses a row whose Source cannot be written).
 *  A deps object carrying only `dispatchers` used to be enough and silently
 *  stopped being enough — so the store and the resolver here are the REAL ones
 *  over a temp DB, seeded the way the composition root seeds them. Hand-faking
 *  them would fake away the writability check, which is exactly what keeps the
 *  chat AI out of a read-only Source. */
let dir: string;
let db: Database.Database;
let store: WorkEntityStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'work-update-tier1-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  store.registerSource({
    id: RECUED_BUILTIN_SOURCE_ID('task'),
    top_tier_kind: 'task',
    source_kind: 'builtin',
    source_label: 'Recued built-in',
    write_capable: true,
    registered_at: NOW,
  });
  store.writeTask({ id: 't1', title: 'x', source_id: RECUED_BUILTIN_SOURCE_ID('task') }, NOW);
  // An ALREADY-COMPLETED row, so "reopen" and "complete it again" are real
  // transitions to assert against rather than no-ops that the guard skips.
  store.writeTask(
    { id: 't-done', title: 'x', source_id: RECUED_BUILTIN_SOURCE_ID('task'), done: true, completed_at: NOW },
    NOW,
  );
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const deps = (opts: { granted?: readonly string[] } = {}) => {
  const taskUpdate = vi.fn(async () => ({ task: { id: 't1', title: 'x' } }));
  const noteUpdate = vi.fn(async () => ({ note: { id: 'n1', body: 'x' } }));
  const markDone = vi.fn(async () => ({ task: { id: 't1', done: true } }));
  const granted = opts.granted ?? ALL_OPS;
  // Built ONCE and handed back on every call, the way `compose-listeners.ts`
  // hoists it — re-deriving per call would mint a second resolver over one
  // store, which that file calls out as the thing to avoid.
  const crud = {
    store,
    resolver: createWorkEntityResolver(store),
    dispatchers: {
      taskUpdate, noteUpdate, commitmentUpdate: taskUpdate, projectUpdate: taskUpdate,
      taskMarkDone: markDone,
    },
  } as unknown as never;
  return {
    __taskUpdate: taskUpdate,
    __markDone: markDone,
    getWorkEntityCrudDeps: () => crud,
    getOpAdmissionGate: () => ({
      isFrozenByPause: () => false,
      isOpGranted: (_s: ExecutionSource, opId: string | undefined) =>
        opId !== undefined && granted.includes(opId),
    }),
  } as unknown as ChatToolHandlerDeps & {
    __taskUpdate: ReturnType<typeof vi.fn>;
    __markDone: ReturnType<typeof vi.fn>;
  };
};

describe('work.update sits on the WRITE side of the slice boundary', () => {
  it('gates on plan approval, unlike work.create', () => {
    expect(planApproval.requiresPlanApproval({ ...TIER1_TOOL_DESCRIPTORS['work.update'], tier: 1 })).toBe(true);
    expect(planApproval.requiresPlanApproval({ ...TIER1_TOOL_DESCRIPTORS['work.create'], tier: 1 })).toBe(false);
    // Shared identity ⇒ sequential, same axis as calendar.update.
    expect(TIER1_CONCURRENCY_SAFE['work.update']).toBe(false);
  });
});

describe('`done` takes the mark-done path, never the field-edit path', () => {
  it('routes a completion to taskMarkDone and NOT through the upsert', async () => {
    // 🔑 THE LOAD-BEARING ONE. The upsert has no `done` field, so if this ever
    // routes the other way the completion vanishes while everything reports ok.
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ kind: 'task', id: 't1', done: true }, ctx());
    expect(res.ok).toBe(true);
    expect(d.__markDone).toHaveBeenCalledTimes(1);
    expect(d.__markDone.mock.calls[0]![0]).toMatchObject({ id: 't1', done: true });
    expect(d.__taskUpdate).not.toHaveBeenCalled();
  });

  it('reopens a task with done:false through the same path', async () => {
    // ⚠ ON THE COMPLETED ROW. Against an already-open task this is a no-op the
    // completion guard now skips, so seeding `done: false` here would assert the
    // routing against a call that correctly never dispatches.
    const d = deps();
    const h = buildChatTier1Handlers(d);
    await h['work.update']!({ kind: 'task', id: 't-done', done: false }, ctx());
    expect(d.__markDone.mock.calls[0]![0]).toMatchObject({ done: false });
  });

  it('does NOT re-dispatch a completion the row already carries', async () => {
    // 🔑 THE GUARD THE CHAT PATH WAS MISSING. The raw dispatcher re-stamps
    // `completed_at`, so "mark it done" on a task that already is would move the
    // completion time every time the owner said it.
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ kind: 'task', id: 't-done', done: true }, ctx());
    expect(res.ok).toBe(true);
    expect(d.__markDone).not.toHaveBeenCalled();
  });

  it('refuses a MIXED call rather than splitting it into two dispatches', async () => {
    // ⛔ Two ops, two grants, two writes — and a half-applied change reported to
    // the owner as one confirmed action if the second fails.
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!(
      { kind: 'task', id: 't1', done: true, title: 'Renamed' },
      ctx(),
    );
    expect(res.ok).toBe(false);
    expect((res as { detail: string }).detail).toMatch(/on its own/i);
    expect(d.__markDone).not.toHaveBeenCalled();
    expect(d.__taskUpdate).not.toHaveBeenCalled();
  });

  it('refuses `done` on a non-task kind', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ kind: 'note', id: 'n1', done: true }, ctx());
    expect(res.ok).toBe(false);
    expect((res as { detail: string }).detail).toMatch(/task only/i);
  });

  it('gates the completion on its OWN op, not the update op', async () => {
    // Granting "may edit" must not also grant "may declare finished": a
    // completion fires `completed` reactive events that other things act on.
    const d = deps({ granted: ['core.work-entity.task.update'] });
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ kind: 'task', id: 't1', done: true }, ctx());
    expect((res as { reason: string }).reason).toBe('classification_blocked');
    expect(d.__markDone).not.toHaveBeenCalled();
  });
});

describe('field edits — a patch, and never an empty one', () => {
  it('refuses an empty change rather than burning an approval on a no-op', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ kind: 'task', id: 't1' }, ctx());
    expect(res.ok).toBe(false);
    expect((res as { detail: string }).detail).toMatch(/at least one field/i);
    expect(d.__taskUpdate).not.toHaveBeenCalled();
  });

  it('requires an id — never guesses which row was meant', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ kind: 'task', title: 'X' }, ctx());
    expect(res.ok).toBe(false);
    expect((res as { detail: string }).detail).toMatch(/id/i);
  });

  it('sends only the fields given, and reports which they were', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!(
      { kind: 'task', id: 't1', due_at: 99_000 },
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect((res as { result: { fields: string[] } }).result.fields).toEqual(['due_at']);
    // `state` is free-form pipeline state and must NOT be confused with done.
    expect(d.__markDone).not.toHaveBeenCalled();
  });

  it('removes a task\'s deadline with `clear_due_at` — never beside a new one, never on another kind', async () => {
    // A task's `null` means "not given", so a removal has a flag of its own.
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ kind: 'task', id: 't1', clear_due_at: true }, ctx());
    expect(res.ok).toBe(true);
    expect(d.__taskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', clear_due_at: true }));
    expect((res as { result: { fields: string[] } }).result.fields).toEqual(['clear_due_at']);

    const both = await h['work.update']!({ kind: 'task', id: 't1', due_at: 99_000, clear_due_at: true }, ctx());
    expect((both as { detail: string }).detail).toMatch(/not both/u);
    const project = await h['work.update']!({ kind: 'project', id: 'p1', clear_due_at: true }, ctx());
    expect((project as { detail: string }).detail).toMatch(/task only/u);
    expect(d.__taskUpdate).toHaveBeenCalledTimes(1);
  });

  it('sets a project\'s target as a DAY, and removes it with `clear_target_completion_at`', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const set = await h['work.update']!({ kind: 'project', id: 'p1', target_completion_at: '2026-10-30' }, ctx());
    expect(set.ok).toBe(true);
    // A day is stored as its UTC midnight — due all of that day where the owner is.
    expect(d.__taskUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'p1', target_completion_at: Date.UTC(2026, 9, 30) }),
    );
    expect((set as { result: { fields: string[] } }).result.fields).toEqual(['target_completion_at']);

    const removed = await h['work.update']!({ kind: 'project', id: 'p1', clear_target_completion_at: true }, ctx());
    // A project's `null` removes its target (a task's would not).
    expect(d.__taskUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'p1', target_completion_at: null }));
    expect((removed as { result: { fields: string[] } }).result.fields).toEqual(['clear_target_completion_at']);
  });

  it.each([
    ['a day that does not exist', { kind: 'project', target_completion_at: '2026-02-30' }, /YYYY-MM-DD/u],
    ['a time, not a day', { kind: 'project', target_completion_at: '2026-10-30T09:00' }, /YYYY-MM-DD/u],
    ['epoch ms, not a day', { kind: 'project', target_completion_at: 1_790_000_000_000 }, /YYYY-MM-DD/u],
    ['a target AND its removal', { kind: 'project', target_completion_at: '2026-10-30', clear_target_completion_at: true }, /not both/u],
    ['a target on a task', { kind: 'task', target_completion_at: '2026-10-30' }, /project only/u],
    ['a removal on a task', { kind: 'task', clear_target_completion_at: true }, /project only/u],
  ])('refuses %s, and changes nothing', async (_label, args, detail) => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ id: 'x1', ...args }, ctx());
    expect((res as { detail: string }).detail).toMatch(detail);
    expect(d.__taskUpdate).not.toHaveBeenCalled();
  });

  it('⛔ a task\'s `due_at` on a project is REFUSED — it changed nothing and was reported as changed', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ kind: 'project', id: 'p1', due_at: 99_000 }, ctx());
    expect((res as { detail: string }).detail).toMatch(/target_completion_at/u);
    expect(d.__taskUpdate).not.toHaveBeenCalled();
  });

  it('a `state` change is not a completion', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    await h['work.update']!({ kind: 'task', id: 't1', state: 'blocked' }, ctx());
    expect(d.__markDone).not.toHaveBeenCalled();
    expect(d.__taskUpdate).toHaveBeenCalledTimes(1);
  });

  it('refuses a task whose Source cannot be written, rather than dispatching', async () => {
    // 🔑 PINS THE READ-BACK THE DEPS OBJECT EXISTS FOR. `handleWorkEntityUpsert`
    // re-reads the row and its Source before the task dispatch, so a row living
    // in a read-only / read-through Source is refused. Without this the store +
    // resolver above are load-bearing but unasserted — which is how they came to
    // be missing in the first place.
    store.registerSource({
      id: 'asana.acme.task',
      top_tier_kind: 'task',
      source_kind: 'connection',
      source_label: 'Asana tasks (acme)',
      write_capable: false,
      registered_at: NOW,
    });
    store.writeTask({ id: 't-ro', title: 'x', source_id: 'asana.acme.task' }, NOW);
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ kind: 'task', id: 't-ro', title: 'Renamed' }, ctx());
    expect(res.ok).toBe(false);
    // Name the cause: `ok:false` alone would also pass if the row simply were
    // not found, which is a different refusal and not the one under test.
    expect((res as { detail: string }).detail).toMatch(/not write-capable/i);
    expect((res as { detail: string }).detail).toContain('asana.acme.task');
    expect(d.__taskUpdate).not.toHaveBeenCalled();
  });

  it('refuses an ungranted kind', async () => {
    const d = deps({ granted: ['core.work-entity.task.update'] });
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ kind: 'note', id: 'n1', body: 'x' }, ctx());
    expect((res as { reason: string }).reason).toBe('classification_blocked');
  });
});

describe('every field goes where its kind keeps it, or is refused', () => {
  // ⛔ A dispatcher ignores a field it does not have, and this tool reported each
  // such field as changed: a project's `body`, a commitment's `title`, a date on
  // the wrong kind, a note's or a commitment's `state`. Nothing changed, and the
  // model was told it had.
  it.each([
    ['a project\'s body is its description', { kind: 'project', body: 'Scope' }, { description: 'Scope' }, ['body']],
    ['a project\'s state', { kind: 'project', state: 'paused' }, { state: 'paused' }, ['state']],
    ['a commitment\'s title is what was promised', { kind: 'commitment', title: 'Send the quote' }, { statement: 'Send the quote' }, ['title']],
    ['a promise for a day', { kind: 'commitment', promised_for_at: '2026-10-02' }, { promised_for_at: Date.UTC(2026, 9, 2) }, ['promised_for_at']],
    ['a promise for a time, with its offset', { kind: 'commitment', promised_for_at: '2026-10-02T15:00:00+02:00' }, { promised_for_at: Date.parse('2026-10-02T13:00:00Z') }, ['promised_for_at']],
    ['a promise date removed', { kind: 'commitment', clear_promised_for_at: true }, { promised_for_at: null }, ['clear_promised_for_at']],
  ])('%s', async (_label, args, sent, fields) => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ id: 'x1', ...args }, ctx());
    expect(res.ok).toBe(true);
    expect(d.__taskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'x1', ...sent }));
    // Reported in the tool's own words — what the model asked to change.
    expect((res as { result: { fields: string[] } }).result.fields).toEqual(fields);
  });

  it('a commitment is not sent a `title` it would ignore', async () => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    await h['work.update']!({ kind: 'commitment', id: 'c1', title: 'Send the quote' }, ctx());
    expect(d.__taskUpdate.mock.calls[0]?.[0]).not.toHaveProperty('title');
  });

  it.each([
    ['a commitment\'s body', { kind: 'commitment', body: 'x' }, /a commitment has no `body` — what was promised is its `title`/u],
    ['a commitment\'s state', { kind: 'commitment', state: 'blocked' }, /a commitment has no `state`/u],
    ['a note\'s state', { kind: 'note', state: 'blocked' }, /a note has no `state`/u],
    ['a promise date on a task', { kind: 'task', promised_for_at: '2026-10-02' }, /commitment only — a task's date is `due_at`/u],
    ['a task deadline on a commitment', { kind: 'commitment', due_at: 99_000 }, /task only — a commitment's date is `promised_for_at`/u],
    ['a promise time with no zone', { kind: 'commitment', promised_for_at: '2026-10-02T15:00' }, /with its offset/u],
    ['a promise on a day that does not exist', { kind: 'commitment', promised_for_at: '2026-02-30' }, /with its offset/u],
    ['a promise date AND its removal', { kind: 'commitment', promised_for_at: '2026-10-02', clear_promised_for_at: true }, /not both/u],
  ])('refuses %s, and changes nothing', async (_label, args, detail) => {
    const d = deps();
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ id: 'x1', ...args }, ctx());
    expect((res as { detail: string }).detail).toMatch(detail);
    expect(d.__taskUpdate).not.toHaveBeenCalled();
  });

  it('lands on the real store: a project\'s description and target, a promise\'s words and date', async () => {
    for (const kind of ['project', 'commitment'] as const) {
      store.registerSource({
        id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind, source_kind: 'builtin',
        source_label: `Recued built-in (${kind})`, write_capable: true, registered_at: NOW,
      });
    }
    const project = store.writeProject({ title: 'Launch', source_id: RECUED_BUILTIN_SOURCE_ID('project') }, NOW);
    const promise = store.writeCommitment({
      direction: 'outbound', statement: 'Send it', derivation: 'user_declared',
      source_id: RECUED_BUILTIN_SOURCE_ID('commitment'),
    }, NOW);
    const resolver = createWorkEntityResolver(store);
    const dispatchers = createWorkEntityDispatchers({ store, resolver, now: () => NOW });
    const h = buildChatTier1Handlers({
      getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
      getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOpGranted: () => true }),
    } as unknown as ChatToolHandlerDeps);

    expect((await h['work.update']!({
      kind: 'project', id: project.id, body: 'Ship the pilot', target_completion_at: '2026-11-30',
    }, ctx())).ok).toBe(true);
    expect(store.readProject(project.id)).toMatchObject({
      description: 'Ship the pilot', target_completion_at: Date.UTC(2026, 10, 30),
    });
    expect((await h['work.update']!({
      kind: 'commitment', id: promise.id, title: 'Send the signed quote', promised_for_at: '2026-10-02',
    }, ctx())).ok).toBe(true);
    expect(store.readCommitment(promise.id)).toMatchObject({
      statement: 'Send the signed quote', promised_for_at: Date.UTC(2026, 9, 2),
    });
    await h['work.update']!({ kind: 'commitment', id: promise.id, clear_promised_for_at: true }, ctx());
    expect(store.readCommitment(promise.id)?.promised_for_at).toBeUndefined();
  });
});

