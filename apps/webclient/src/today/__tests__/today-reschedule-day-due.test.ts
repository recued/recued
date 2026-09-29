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

const rig = async (due_at: number) => {
  let stored = taskWith(due_at);
  const upsert = vi.fn(async (args: { due_at?: number }) => {
    stored = { ...stored, due_at: args.due_at ?? stored.due_at };
    return { entity: stored };
  });
  const callers: TodayCallers = {
    workEntitySourceListCaller: async () => ({ sources: [source] }),
    workEntityListCaller: async ({ kind }: { kind: string }) =>
      ({ entities: kind === 'task' ? [stored] : [], total: kind === 'task' ? 1 : 0 }),
    collectionListInstancesCaller: async () => ({ instances: [] }),
    collectionListCaller: async () => ({ records: [] }),
    workEntityGetCaller: async () => ({ entity: stored }),
    workEntityUpsertCaller: upsert,
  } as unknown as TodayCallers;
  const controller = createTodayController({
    callers,
    now: () => new Date(2026, 8, 8, 9).getTime(),
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
  return { controller, upsert };
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
});
