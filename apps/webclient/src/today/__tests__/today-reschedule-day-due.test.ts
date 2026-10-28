/** Today → Reschedule and a due stored as a DAY (UTC midnight, `due-day.ts`).
 *
 *  Moving "due Monday" to another day at midnight keeps it a whole day — not
 *  this zone's midnight, which would make it overdue from the day's first
 *  minute. Any other pick is a time, kept off 00:00 UTC so it cannot read as a
 *  day. Built from local dates, so it holds in any zone. */

import { describe, expect, it, vi } from 'vitest';
import type { SourceRegistration, WorkEntity } from '@recued/contracts';

import { createTodayController, toDatetimeLocal, type TodayCallers } from '../today-controller.js';

const source: SourceRegistration = {
  id: 'recued.task', top_tier_kind: 'task', source_kind: 'builtin',
  source_label: 'My tasks', write_capable: true, registered_at: 1,
};

const taskWith = (due_at: number): Extract<WorkEntity, { _kind: 'task' }> => ({
  _kind: 'task', id: 't-1', title: 'File the return', done: false, due_at,
  source_id: source.id, sync_state: 'live', conflict_policy: 'recued_wins',
  last_seen_at: 1, created_at: 1, updated_at: 1, blocks_task_ids: [],
});

const rig = async (due_at: number, now = new Date(2026, 8, 8, 9).getTime()) => {
  let stored = taskWith(due_at);
  const currentSource = { ...source };
  const upsert = vi.fn(async (args: { due_at?: number; clear_due_at?: boolean }) => {
    stored = { ...stored, due_at: args.clear_due_at ? undefined : args.due_at ?? stored.due_at };
    return { entity: stored };
  });
  const callers: TodayCallers = {
    workEntitySourceListCaller: async () => ({ sources: [currentSource] }),
    workEntityListCaller: async ({ kind }: { kind: string }) =>
      ({ entities: kind === 'task' ? [stored] : [], total: kind === 'task' ? 1 : 0 }),
    collectionListInstancesCaller: async () => ({ instances: [] }),
    collectionListCaller: async () => ({ records: [] }),
    workEntityGetCaller: async () => ({ entity: stored }),
    workEntityUpsertCaller: upsert,
  } as unknown as TodayCallers;
  const controller = createTodayController({
    callers,
    now: () => now,
    render: () => {},
    isDisposed: () => false,
    isActive: () => true,
    refreshActive: () => {},
    focusTask: () => {},
    ownsFocus: () => false,
    actionAttr: 'data-action',
    errMessage: (e) => String(e),
  });
  await controller.load(() => true);
  const key = controller.snapshot()!.items[0]!.key;
  controller.openEditor(key, 'reschedule');
  return { controller, upsert, key, currentSource, setStored: (task: typeof stored) => { stored = task; } };
};

const dayOf = (y: number, m: number, d: number) => Date.UTC(y, m, d);

describe('Today → Reschedule and a due that names a day', () => {
  it('opens a whole-day due on its day at midnight', async () => {
    const { controller } = await rig(dayOf(2026, 8, 9));
    expect(controller.edit()?.value).toBe('2026-09-09T00:00');
    expect(controller.edit()?.allDay).toBe(true);
  });

  it('moved to another day at midnight, it stays a whole day', async () => {
    const { controller, upsert } = await rig(dayOf(2026, 8, 9));
    controller.setEditValue('2026-09-11T00:00');
    await controller.submit();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ due_at: dayOf(2026, 8, 11) }));
    expect(controller.edit()).toBeNull();
  });

  it('given a time, it becomes that time here', async () => {
    const { controller, upsert } = await rig(dayOf(2026, 8, 9));
    controller.setEditValue('2026-09-11T15:30');
    await controller.submit();
    const due = (upsert.mock.calls[0]![0] as { due_at: number }).due_at;
    expect(toDatetimeLocal(due)).toBe('2026-09-11T15:30');
    expect(due % 86_400_000).not.toBe(0);
  });

  it('a timed due moved to midnight stays a time (only a day-due keeps its day)', async () => {
    const { controller, upsert } = await rig(new Date(2026, 8, 9, 14, 0).getTime());
    controller.setEditValue('2026-09-11T00:00');
    await controller.submit();
    const due = (upsert.mock.calls[0]![0] as { due_at: number }).due_at;
    expect(toDatetimeLocal(due)).toBe('2026-09-11T00:00');
  });

  it('quick Today and Tomorrow keep a whole-day due on the local calendar day', async () => {
    const { controller, upsert, key } = await rig(dayOf(2026, 8, 6));
    controller.closeEditor();
    await controller.applyDueShortcut(key, 'today');
    expect(upsert).toHaveBeenLastCalledWith({ kind: 'task', id: 't-1', due_at: dayOf(2026, 8, 8) });
    await controller.applyDueShortcut(key, 'tomorrow');
    expect(upsert).toHaveBeenLastCalledWith({ kind: 'task', id: 't-1', due_at: dayOf(2026, 8, 9) });
  });

  it('quick Tomorrow preserves the clock and seconds across the daylight-saving change', async () => {
    const { controller, upsert, key } = await rig(new Date(2026, 2, 7, 17, 30, 15, 123).getTime(), new Date(2026, 2, 7, 9).getTime());
    controller.closeEditor();
    await controller.applyDueShortcut(key, 'tomorrow');
    expect(upsert).toHaveBeenCalledWith({ kind: 'task', id: 't-1', due_at: new Date(2026, 2, 8, 17, 30, 15, 123).getTime() });
  });

  it('clears only the due date and removes the confirmed task from Today', async () => {
    const { controller, upsert, key } = await rig(dayOf(2026, 8, 9));
    controller.closeEditor();
    await controller.applyDueShortcut(key, 'clear');
    expect(upsert).toHaveBeenCalledWith({ kind: 'task', id: 't-1', clear_due_at: true });
    expect(controller.snapshot()?.items).toEqual([]);
    expect(controller.notice()).toContain('Cleared the due date');
  });

  it('refuses a shortcut if the fresh source is no longer writable', async () => {
    const { controller, upsert, key, currentSource } = await rig(dayOf(2026, 8, 9));
    controller.closeEditor();
    currentSource.write_capable = false;
    await controller.applyDueShortcut(key, 'clear');
    expect(upsert).not.toHaveBeenCalled();
    expect(controller.edit()?.error).toContain('cannot be changed');
    expect(controller.snapshot()?.items).toHaveLength(1);
  });

  it('does not retry an unconfirmed clear while the fresh task still has a pending write', async () => {
    const { controller, upsert, key, setStored } = await rig(dayOf(2026, 8, 9));
    controller.closeEditor();
    upsert.mockImplementationOnce(async () => {
      const pending = { ...taskWith(dayOf(2026, 8, 9)), due_at: undefined,
        pending_write: { staged_at: 1, operation: 'update' as const, dirty_fields: ['due_at'], state: 'awaiting_verify' as const } };
      setStored(pending);
      return { entity: pending };
    });
    await controller.applyDueShortcut(key, 'clear');
    expect(controller.edit()?.error).toContain('source has not confirmed');
    await controller.submit();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(controller.edit()?.error).toContain('waiting for its source');
    expect(controller.notice()).toBeNull();
  });

  it('offers manual picking instead of silently shifting a deadline through a missing DST hour', async () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const { controller, upsert, key } = await rig(new Date(2026, 2, 7, 2, 30).getTime(), new Date(2026, 2, 7, 9).getTime());
      controller.closeEditor();
      await controller.applyDueShortcut(key, 'tomorrow');
      expect(upsert).not.toHaveBeenCalled();
      expect(controller.edit()?.error).toContain('time does not exist');
      expect(controller.edit()?.value).toBe('2026-03-07T02:30');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
