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
