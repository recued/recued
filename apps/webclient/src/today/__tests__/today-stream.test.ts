/** D-340 slice 2 (§3.7) — Today's "Daily stream": a button that opens the streams' settings over
 *  Today, offered only where the shell wired them and the server names its streams
 *  (`ProactiveToday.stream`); and what the settings show: Send to's channels and the preview's
 *  counts. The dialog itself is driven in a real browser (`e2e/stream.spec.ts`). */
import type { NotificationChannelToggleView, ProactiveToday } from '@recued/contracts';
import { describe, expect, it } from 'vitest';
import { createTodayController, type TodayCallers } from '../today-controller.js';
import { renderToday, TODAY_STREAM_ACTION } from '../../data/today-view.js';
import { streamChannelsOf, streamCountsText } from '../stream-panel.js';

const now = new Date(2026, 10, 7, 8).getTime();
const proactive = (stream: boolean): ProactiveToday => ({ situations: { clusters: [], omitted: 0, ambiguous: [] }, occurrences: [],
  proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true, ...(stream ? { stream: true as const } : {}) });
const view = async (options: { named: boolean; wired: boolean }) => {
  const callers = { workEntitySourceListCaller: async () => ({ sources: [] }), workEntityListCaller: async () => ({ entities: [], total: 0 }),
    collectionListInstancesCaller: async () => ({ instances: [] }), proactiveTodayCaller: async () => proactive(options.named) } as unknown as TodayCallers;
  const controller = createTodayController({ callers, now: () => now, render: () => {}, isDisposed: () => false, isActive: () => true,
    refreshActive: () => {}, focusTask: () => {}, ownsFocus: () => false, actionAttr: 'data-action', errMessage: error => String(error) });
  await controller.load(() => true);
  return renderToday(controller.snapshot(), false, 'data-action', false, false, { canComplete: false, canReschedule: false, edit: null,
    notice: null, error: null, canOpenStream: options.wired });
};

describe('Today\'s "Daily stream"', () => {
  it('is offered where the shell can open the settings and the server names its streams, and nowhere else', async () => {
    expect(await view({ named: true, wired: true })).toContain(
      `<button type="button" class="today-action" data-action="${TODAY_STREAM_ACTION}" data-today-stream-open aria-haspopup="dialog">Daily stream</button>`);
    // A server before them: the Agenda and Coming up are still in Settings.
    expect(await view({ named: false, wired: true })).not.toContain('data-today-stream-open');
    expect(await view({ named: true, wired: false })).not.toContain('data-today-stream-open');
  });
});

describe('the streams\' settings', () => {
  const row = (channel: NotificationChannelToggleView['channel'], notification: boolean, ready: boolean) =>
    ({ channel, notification, ready, capability: 'inline', approval: false, notification_togglable: true, approval_togglable: true }) as NotificationChannelToggleView;
  it('offers Send to each channel set up with Notify on, the app\'s cards as "The app", and never the Browser Bridge', () => {
    expect(streamChannelsOf([row('ui', true, true), row('bridge', true, true), row('telegram', true, true), row('slack', false, true),
      row('discord', true, false), row('email', true, true)])).toEqual([
      { channel: 'in_app', label: 'The app' }, { channel: 'telegram', label: 'Telegram' }, { channel: 'email', label: 'Email' }]);
  });
  it('says how many lines each part of the next message holds, or that there is nothing to send', () => {
    expect(streamCountsText({ states: 1, agenda: 3, due_today: 0, coming_up: 1 })).toBe('1 that holds today, 3 agenda items, 1 coming up');
    expect(streamCountsText({ states: 2, agenda: 1, due_today: 2, coming_up: 0 })).toBe('2 that hold today, 1 agenda item, 2 due');
    expect(streamCountsText({ states: 0, agenda: 0, due_today: 0, coming_up: 0 })).toBe('nothing to send yet');
    // D-340 slice 3 — the day's reminders, after what is due.
    expect(streamCountsText({ states: 0, agenda: 2, due_today: 0, coming_up: 1, reminders: 1 })).toBe('2 agenda items, 1 reminder, 1 coming up');
    expect(streamCountsText({ states: 0, agenda: 0, due_today: 0, coming_up: 0, reminders: 3 })).toBe('3 reminders');
    // D-340 slice 4 — the AI suggestions, under what holds, as the message has them.
    expect(streamCountsText({ states: 1, agenda: 2, due_today: 0, coming_up: 0, reminders: 0, suggestions: 1 })).toBe('1 that holds today, AI suggestions, 2 agenda items');
    expect(streamCountsText({ states: 0, agenda: 0, due_today: 0, coming_up: 0, suggestions: 1 })).toBe('AI suggestions');
  });
});
