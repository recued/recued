/** D-407 slice 2 — Today's "When is the next one?": each occasion that comes back whenever the last one says and waits
 *  for its next date, with a date, an optional time, Save and "No next one" (`occasion.next`). Drawn only where the
 *  server lists them (`ProactiveToday.occasions_waiting`) and the shell can send the answer. */
import type { ProactiveToday } from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createTodayController, type TodayCallers } from '../today-controller.js';
import { renderToday, TODAY_OCCASION_NEXT_NONE, TODAY_OCCASION_NEXT_SAVE } from '../../data/today-view.js';

// Saturday 21 November 2026, 20:00 on this machine's clock.
const now = new Date(2026, 10, 21, 20).getTime();
const proactive = (waiting?: ProactiveToday['occasions_waiting']): ProactiveToday => ({ situations: { clusters: [], omitted: 0, ambiguous: [] }, occurrences: [],
  proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true, ...(waiting ? { occasions_waiting: waiting } : {}) });
const lee = { id: 'occ_lee', title: 'Dr. Lee', last_on: '2026-11-17' };
const setup = (options: { waiting?: ProactiveToday['occasions_waiting']; answer?: TodayCallers['occasionNextCaller'] } = {}) => {
  const callers = { workEntitySourceListCaller: async () => ({ sources: [] }), workEntityListCaller: async () => ({ entities: [], total: 0 }),
    collectionListInstancesCaller: async () => ({ instances: [] }), proactiveTodayCaller: async () => proactive(options.waiting),
    ...(options.answer ? { occasionNextCaller: options.answer } : {}) } as unknown as TodayCallers;
  const focused: string[] = []; const refreshed: number[] = [];
  const controller = createTodayController({ callers, now: () => now, render: () => {}, isDisposed: () => false, isActive: () => true,
    refreshActive: () => { refreshed.push(1); }, focusTask: selector => { focused.push(selector); }, ownsFocus: () => true, actionAttr: 'data-action',
    errMessage: error => error instanceof Error ? error.message : String(error) });
  const view = (drafts?: Map<string, { on: string; time: string }>) => renderToday(controller.snapshot(), false, 'data-action', false, false, {
    canComplete: false, canReschedule: false, edit: null, notice: controller.notice(), error: controller.error(), commitmentBusy: controller.busy(),
    canAnswerOccasionNext: options.answer !== undefined, ...(drafts ? { occasionDrafts: drafts } : {}) });
  return { controller, view, focused, refreshed };
};

describe('Today\'s "When is the next one?"', () => {
  it('lists each occasion waiting, with the day it was last, a date from today, a time, Save and No next one', async () => {
    const { controller, view } = setup({ waiting: [lee], answer: async () => ({ message: '' }) }); await controller.load(() => true);
    const html = view();
    expect(html).toContain('<h3 id="today-occasion-next-title">When is the next one?<span class="today-count">1</span></h3>');
    expect(html).toContain('<a href="#yours/occasions/occasion/occ_lee">Dr. Lee</a>');
    expect(html).toContain('<time datetime="2026-11-17">');
    expect(html).toMatch(/<input type="date" data-today-occasion-next-on="occ_lee" min="2026-11-21" value="">/u);
    expect(html).toMatch(/<input type="time" data-today-occasion-next-time="occ_lee" value="">/u);
    expect(html).toContain(`data-action="${TODAY_OCCASION_NEXT_SAVE}" data-today-occasion-id="occ_lee">Save</button>`);
    expect(html).toContain(`data-action="${TODAY_OCCASION_NEXT_NONE}" data-today-occasion-id="occ_lee">No next one</button>`);
    // What the owner typed comes back on the next repaint.
    expect(view(new Map([['occ_lee', { on: '2027-05-18', time: '10:30' }]]))).toMatch(/data-today-occasion-next-on="occ_lee" min="2026-11-21" value="2027-05-18">[\s\S]*data-today-occasion-next-time="occ_lee" value="10:30">/u);
  });

  it('is not drawn from a server before it, with none waiting, or where the shell cannot answer', async () => {
    for (const options of [{ answer: async () => ({ message: '' }) }, { waiting: [], answer: async () => ({ message: '' }) }, { waiting: [lee] }]) {
      const { controller, view } = setup(options); await controller.load(() => true);
      expect(view()).not.toContain('data-today-occasion-next');
    }
  });

  it('sends the date and time, takes the row away, and says what it saved', async () => {
    const answer = vi.fn(async () => ({ message: 'Next one saved: 2027-05-18 at 10:30.' }));
    const { controller, view, focused, refreshed } = setup({ waiting: [lee], answer }); await controller.load(() => true);
    await controller.answerOccasionNext('occ_lee', '2027-05-18', '10:30');
    expect(answer).toHaveBeenCalledWith({ action: 'occasion.next', id: 'occ_lee', on: '2027-05-18', time: '10:30' });
    expect(view()).not.toContain('data-today-occasion-next');
    expect(controller.notice()).toBe('Dr. Lee: Next one saved: 2027-05-18 at 10:30.');
    expect(focused).toEqual(['[data-today-task-notice]']); expect(refreshed).toHaveLength(1);
  });

  it('"No next one" sends no date and no time', async () => {
    const answer = vi.fn(async () => ({ message: 'No next one: it keeps its last date.' }));
    const { controller } = setup({ waiting: [lee], answer }); await controller.load(() => true);
    await controller.answerOccasionNext('occ_lee', null, '10:30');
    expect(answer).toHaveBeenCalledWith({ action: 'occasion.next', id: 'occ_lee', on: null });
  });

  it('Save with no date says what to do and sends nothing; a refusal is shown with focus on it', async () => {
    const answer = vi.fn(async () => { throw new Error('Choose 2026-11-21 or a later date'); });
    const { controller, view, focused } = setup({ waiting: [lee], answer }); await controller.load(() => true);
    await controller.answerOccasionNext('occ_lee', '', '');
    expect(answer).not.toHaveBeenCalled();
    expect(controller.error()).toBe('Choose the date of the next “Dr. Lee”, or No next one.');
    await controller.answerOccasionNext('occ_lee', '2026-11-20', '');
    expect(answer).toHaveBeenCalledWith({ action: 'occasion.next', id: 'occ_lee', on: '2026-11-20' });
    expect(view()).toContain('<p role="alert" tabindex="-1" data-today-task-error>Choose 2026-11-21 or a later date</p>');
    // Still asked: the row stays until it is answered.
    expect(view()).toContain('data-today-occasion-next-on="occ_lee"');
    expect(focused).toEqual(['[data-today-task-error]', '[data-today-task-error]']);
  });
});
