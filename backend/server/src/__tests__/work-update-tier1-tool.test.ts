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

import { describe, expect, it, vi } from 'vitest';
import type { ExecutionSource } from '@recued/contracts';
import { TIER1_CONCURRENCY_SAFE, TIER1_TOOL_DESCRIPTORS } from '@recued/contracts';
import { planApproval } from '@recued/gateway';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import type { ChatToolHandlerDeps } from '../chat-tool-handlers.js';

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

const deps = (opts: { granted?: readonly string[] } = {}) => {
  const taskUpdate = vi.fn(async () => ({ task: { id: 't1', title: 'x' } }));
  const noteUpdate = vi.fn(async () => ({ note: { id: 'n1', body: 'x' } }));
  const markDone = vi.fn(async () => ({ task: { id: 't1', done: true } }));
  const granted = opts.granted ?? ALL_OPS;
  return {
    __taskUpdate: taskUpdate,
    __markDone: markDone,
    getWorkEntityCrudDeps: () =>
      ({
        dispatchers: {
          taskUpdate, noteUpdate, commitmentUpdate: taskUpdate, projectUpdate: taskUpdate,
          taskMarkDone: markDone,
        },
      } as unknown as never),
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
    const d = deps();
    const h = buildChatTier1Handlers(d);
    await h['work.update']!({ kind: 'task', id: 't1', done: false }, ctx());
    expect(d.__markDone.mock.calls[0]![0]).toMatchObject({ done: false });
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

  it('refuses an ungranted kind', async () => {
    const d = deps({ granted: ['core.work-entity.task.update'] });
    const h = buildChatTier1Handlers(d);
    const res = await h['work.update']!({ kind: 'note', id: 'n1', body: 'x' }, ctx());
    expect((res as { reason: string }).reason).toBe('classification_blocked');
  });
});
