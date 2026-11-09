/** D-343 slice 4 (ruling 20) — Today's "Close the day": a button that opens a conversation holding
 *  today's evening notice, with the reply already quoting it. Offered only where the shell wired the
 *  caller and the server names it (`ProactiveToday.close_day`). */
import type { ProactiveToday } from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createTodayController, type TodayCallers } from '../today-controller.js';
import { renderToday, TODAY_CLOSE_DAY_ACTION } from '../../data/today-view.js';

const now = new Date(2026, 10, 7, 20).getTime();
const proactive = (closeDay: boolean): ProactiveToday => ({ situations: { clusters: [], omitted: 0, ambiguous: [] }, occurrences: [],
  proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true, ...(closeDay ? { close_day: true as const } : {}) });
const setup = (options: { closeDay?: boolean; open?: () => Promise<void> } = {}) => {
  const callers = { workEntitySourceListCaller: async () => ({ sources: [] }), workEntityListCaller: async () => ({ entities: [], total: 0 }),
    collectionListInstancesCaller: async () => ({ instances: [] }), proactiveTodayCaller: async () => proactive(options.closeDay ?? true),
    ...(options.open ? { closeDayCaller: options.open } : {}) } as unknown as TodayCallers;
  const focused: string[] = [];
  const controller = createTodayController({ callers, now: () => now, render: () => {}, isDisposed: () => false, isActive: () => true,
    refreshActive: () => {}, focusTask: selector => { focused.push(selector); }, ownsFocus: () => false, actionAttr: 'data-action', errMessage: error => String(error) });
  const view = () => renderToday(controller.snapshot(), false, 'data-action', false, false, { canComplete: false, canReschedule: false, edit: null,
    notice: controller.notice(), error: controller.error(), canCloseDay: options.open !== undefined, closingDay: controller.closingDay() });
  return { controller, view, focused };
};
const button = new RegExp(`<button type="button" class="today-action" data-action="${TODAY_CLOSE_DAY_ACTION}" data-today-close-day aria-disabled="(true|false)">([^<]*)</button>`, 'u');

describe('Today\'s "Close the day"', () => {
  it('is offered where the shell can open it and the server names it, and nowhere else', async () => {
    const offered = setup({ open: async () => {} }); await offered.controller.load(() => true);
    expect(button.exec(offered.view())?.slice(1)).toEqual(['false', 'Close the day']);
    // A server before it: no button, though the shell could open one.
    const older = setup({ open: async () => {}, closeDay: false }); await older.controller.load(() => true);
    expect(older.view()).not.toContain('data-today-close-day');
    // A shell that wired no caller: no button, though the server names it.
    const unwired = setup(); await unwired.controller.load(() => true);
    expect(unwired.view()).not.toContain('data-today-close-day');
  });

  it('opens it once, says so while it opens, and a second press waits for the first', async () => {
    let finish!: () => void;
    const open = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const { controller, view } = setup({ open }); await controller.load(() => true);
    const first = controller.closeDay(); void controller.closeDay();
    expect(open).toHaveBeenCalledTimes(1);
    expect(button.exec(view())?.slice(1)).toEqual(['true', 'Opening…']);
    finish(); await first;
    expect(button.exec(view())?.slice(1)).toEqual(['false', 'Close the day']);
    expect(controller.error()).toBeNull();
  });

  it('says why when it could not open it, and moves focus to the reason', async () => {
    const { controller, view, focused } = setup({ open: async () => { throw new Error('Close the day is unavailable on this server'); } });
    await controller.load(() => true);
    await controller.closeDay();
    expect(controller.error()).toBe('Error: Close the day is unavailable on this server');
    expect(view()).toContain('<p role="alert" tabindex="-1" data-today-task-error>Error: Close the day is unavailable on this server</p>');
    expect(focused).toEqual(['[data-today-task-error]']);
  });
});
