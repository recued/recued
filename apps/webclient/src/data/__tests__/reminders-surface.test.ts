/** D-324 — the Reminders tab's own state: what it shows, and what it sends.
 *
 *  ⛔ What these pin beyond the route test: a new time is read on the REMINDER'S
 *  clock, so a browser in another zone moves nothing it did not mean to; a time
 *  the server refuses keeps the row open with the server's words; and an unsaved
 *  time is an unsaved change. */

import { describe, expect, it, vi } from 'vitest';
import type { ReminderView, ReminderListResult } from '@recued/contracts';

import {
  REMINDERS_FIELD_ATTR,
  createRemindersSurface,
  reminderWallClockValue,
  type ReminderCallers,
} from '../reminders-surface.js';

const AT = Date.UTC(2026, 9, 16, 19, 0); // Friday 16 October, 15:00 in New York
const view = (over: Partial<ReminderView> = {}): ReminderView => ({
  reminder_id: 'rem_1', text: 'Call the dentist', at: AT, when: 'Friday 16 October at 3:00 PM',
  state: 'pending', delivered_at: null, time_zone: 'America/New_York', ...over,
});

const target = (attrs: Record<string, string>, value?: string): HTMLElement =>
  ({ getAttribute: (k: string) => attrs[k] ?? null, ...(value !== undefined ? { value } : {}) }) as unknown as HTMLElement;

const mount = (callers: ReminderCallers, browserZone = 'Europe/London') => {
  const render = vi.fn();
  const surface = createRemindersSurface({ callers, actionAttr: 'data-act', render, browserZone: () => browserZone });
  return { surface, render };
};

describe('reminderWallClockValue', () => {
  it('is the wall clock on the zone given, for a datetime-local field', () => {
    expect(reminderWallClockValue(AT, 'America/New_York')).toBe('2026-10-16T15:00');
    expect(reminderWallClockValue(AT, 'Asia/Tokyo')).toBe('2026-10-17T04:00');
    expect(reminderWallClockValue(Date.UTC(2026, 9, 16, 4, 0), 'America/New_York')).toBe('2026-10-16T00:00');
  });
});

describe('the Reminders tab', () => {
  it('keeps loaded pages after a failed Load more and retries the same cursor once', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => view({ reminder_id: 'row-' + String(index).padStart(3, '0'), text: 'Loaded reminder ' + index }));
    const cursor = { at: AT, reminder_id: rows.at(-1)!.reminder_id };
    let release!: (result: ReminderListResult) => void;
    const held = new Promise<ReminderListResult>(resolve => { release = resolve; });
    let reads = 0;
    const list = vi.fn<NonNullable<ReminderCallers['list']>>(async () => {
      reads++;
      if (reads === 1) return { reminders: rows, count: 51, page: { matched_count: 51, next_cursor: cursor } };
      if (reads === 2) throw new Error('Next page interrupted');
      return held;
    });
    const { surface } = mount({ list });
    await surface.refresh();
    surface.handleAction('reminders-more', target({}));
    await surface.whenLoaded();
    expect(surface.render()).toContain('Loaded reminder 49');
    expect(surface.render()).toContain('Next page interrupted');
    surface.handleAction('reminders-more', target({}));
    surface.handleAction('reminders-more', target({}));
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[2]?.[0].page?.cursor).toEqual(cursor);
    release({ reminders: [view({ reminder_id: 'row-050', text: 'Last matching reminder' })], count: 51,
      page: { matched_count: 51, next_cursor: null } });
    await surface.whenLoaded();
    expect(surface.render()).toContain('Last matching reminder');
    expect(surface.render()).toContain('Showing 51 of 51 matching reminders');
    surface.dispose();
  });

  it('ignores an older search reply and protects an edited reminder from a filter change', async () => {
    let release!: (result: ReminderListResult) => void;
    const held = new Promise<ReminderListResult>(resolve => { release = resolve; });
    const list = vi.fn<NonNullable<ReminderCallers['list']>>(async args => args.page?.query === 'older' ? held
      : { reminders: [view({ text: args.page?.query === 'newer' ? 'Newer result' : 'Initial result' })], count: 1,
        page: { matched_count: 1, next_cursor: null } });
    const { surface } = mount({ list, update: vi.fn() });
    await surface.refresh();
    surface.handleInput(target({ [REMINDERS_FIELD_ATTR]: 'query' }, 'older'));
    surface.handleAction('reminders-apply', target({}));
    const older = surface.whenLoaded();
    surface.handleInput(target({ [REMINDERS_FIELD_ATTR]: 'query' }, 'newer'));
    surface.handleAction('reminders-apply', target({}));
    await surface.whenLoaded();
    release({ reminders: [view({ text: 'Older result' })], count: 1, page: { matched_count: 1, next_cursor: null } });
    await older;
    expect(surface.render()).toContain('Newer result');
    expect(surface.render()).not.toContain('Older result');
    surface.handleAction('reminders-edit', target({ 'data-reminder-id': 'rem_1' }));
    surface.handleInput(target({ [REMINDERS_FIELD_ATTR]: 'text', 'data-reminder-id': 'rem_1' }, 'Keep this draft'));
    const calls = list.mock.calls.length;
    surface.handleAction('reminders-clear', target({}));
    expect(list).toHaveBeenCalledTimes(calls);
    expect(surface.hasUnsavedChanges()).toBe(true);
    expect(surface.render()).toContain('Keep this draft');
    surface.dispose();
  });

  it('turns date filters into whole days on the declared clock across DST', async () => {
    const list = vi.fn<NonNullable<ReminderCallers['list']>>(async () => ({ reminders: [], count: 0,
      page: { matched_count: 0, next_cursor: null } }));
    const surface = createRemindersSurface({ callers: { list }, actionAttr: 'data-act', render: vi.fn(),
      now: () => Date.parse('2026-11-01T15:00:00Z'), timeZone: () => 'America/New_York' });
    await surface.refresh();
    surface.handleChange(target({ [REMINDERS_FIELD_ATTR]: 'range' }, 'today'));
    surface.handleAction('reminders-apply', target({}));
    await surface.whenLoaded();
    expect(list.mock.calls.at(-1)?.[0].page).toEqual({ from: Date.parse('2026-11-01T04:00:00Z'), before: Date.parse('2026-11-02T05:00:00Z') });
    surface.handleChange(target({ [REMINDERS_FIELD_ATTR]: 'range' }, 'custom'));
    surface.handleInput(target({ [REMINDERS_FIELD_ATTR]: 'from' }, '2026-11-03'));
    surface.handleInput(target({ [REMINDERS_FIELD_ATTR]: 'through' }, '2026-11-02'));
    const calls = list.mock.calls.length;
    surface.handleAction('reminders-apply', target({}));
    expect(list).toHaveBeenCalledTimes(calls);
    expect(surface.render()).toContain('last day on or after the first');
    surface.dispose();
  });

  it('says how to set one when none waits', async () => {
    const { surface } = mount({ list: async () => ({ reminders: [], count: 0, delivered: [] }) });
    await surface.refresh();
    expect(surface.render()).toContain('No reminders waiting. Ask chat to set one');
  });

  it('names the reminder’s clock when it is not the browser’s, and reads the new time on it', async () => {
    const update = vi.fn(async () => ({ updated: true, message: 'Changed: Friday 16 October at 5:00 PM.' }));
    const { surface } = mount({ list: async () => ({ reminders: [view()], count: 1 }), update });
    await surface.refresh();
    surface.handleAction('reminders-edit', target({ 'data-reminder-id': 'rem_1' }));
    expect(surface.render()).toContain('(America/New_York time)');
    expect(surface.hasUnsavedChanges()).toBe(false);
    surface.handleChange(target({ [REMINDERS_FIELD_ATTR]: 'at', 'data-reminder-id': 'rem_1' }, '2026-10-16T17:00'));
    expect(surface.hasUnsavedChanges()).toBe(true);
    surface.handleAction('reminders-save', target({ 'data-reminder-id': 'rem_1' }));
    // 17:00 in New York, whatever the browser's clock says.
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ reminder_id: 'rem_1', at: Date.UTC(2026, 9, 16, 21, 0) }));
  });

  it('keeps the row open with the server’s words when the time is refused', async () => {
    const update = vi.fn(async () => { throw Object.assign(new Error('That time has passed: Thursday 15 October at 9:00 AM. Pick a time still to come.'), { code: 'bad_request' }); });
    const { surface } = mount({ list: async () => ({ reminders: [view()], count: 1 }), update }, 'America/New_York');
    await surface.refresh();
    surface.handleAction('reminders-edit', target({ 'data-reminder-id': 'rem_1' }));
    surface.handleChange(target({ [REMINDERS_FIELD_ATTR]: 'at', 'data-reminder-id': 'rem_1' }, '2026-10-15T09:00'));
    surface.handleAction('reminders-save', target({ 'data-reminder-id': 'rem_1' }));
    await vi.waitFor(() => expect(surface.render()).toContain('That time has passed'));
    expect(surface.render()).toContain('type="datetime-local"');
  });

  it('asks for a day and a time when the field is empty, and sends nothing', async () => {
    const update = vi.fn();
    const { surface } = mount({ list: async () => ({ reminders: [view()], count: 1 }), update });
    await surface.refresh();
    surface.handleAction('reminders-edit', target({ 'data-reminder-id': 'rem_1' }));
    surface.handleChange(target({ [REMINDERS_FIELD_ATTR]: 'at', 'data-reminder-id': 'rem_1' }, ''));
    surface.handleAction('reminders-save', target({ 'data-reminder-id': 'rem_1' }));
    await vi.waitFor(() => expect(surface.render()).toContain('Pick a valid day and time'));
    expect(update).not.toHaveBeenCalled();
  });

  it('offers no change or cancel the server does not support, and a retry when the list fails', async () => {
    let fail = true;
    const { surface } = mount({ list: async () => {
      if (fail) throw new Error('offline');
      return { reminders: [view()], count: 1 };
    } });
    await surface.refresh();
    expect(surface.render()).toContain('Try again');
    fail = false;
    surface.handleAction('reminders-retry', target({}));
    await vi.waitFor(() => expect(surface.render()).toContain('Call the dentist'));
    expect(surface.render()).not.toContain('Edit reminder');
    expect(surface.render()).not.toContain('>Cancel<');
  });

  it('closes a row whose reminder rang meanwhile', async () => {
    let reminders = [view()];
    const { surface } = mount({ list: async () => ({ reminders, count: reminders.length }), cancel: vi.fn() });
    await surface.refresh();
    surface.handleAction('reminders-cancel', target({ 'data-reminder-id': 'rem_1' }));
    expect(surface.isBusy()).toBe(true);
    reminders = [];
    await surface.refresh(true);
    expect(surface.isBusy()).toBe(false);
    expect(surface.render()).not.toContain('Cancel this reminder?');
  });

  it('shows a confirmed cancellation before its refresh finishes and keeps it if that refresh fails', async () => {
    let reads = 0;
    let failRefresh: (error: Error) => void = () => { throw new Error('No refresh is waiting'); };
    const { surface, render } = mount({
      list: async () => {
        if (++reads > 1) return new Promise((_resolve, reject) => { failRefresh = reject; });
        return { reminders: [view()], count: 1 };
      },
      cancel: async () => ({ cancelled: true, message: 'Cancelled.', reminder: view({ state: 'cancelled' }) }),
    });
    let painted = '';
    render.mockImplementation(() => { painted = surface.render(); });
    await surface.refresh(); const row = target({ 'data-reminder-id': 'rem_1' });
    surface.handleAction('reminders-cancel', row); surface.handleAction('reminders-cancel-confirm', row);
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(painted).toContain('No reminders waiting');
    expect(painted).toContain('Cancelled');
    expect(surface.hasInFlightWork()).toBe(false);
    failRefresh(new Error('Refresh interrupted'));
    await vi.waitFor(() => expect(surface.render()).toContain('Refresh interrupted'));
    expect(surface.render()).toContain('No reminders waiting');
    expect(surface.render()).toContain('Cancelled');
  });

  it('preserves an exact instant during a no-op or wording-only edit, including the second repeated hour', async () => {
    let reminder = view({ at: Date.parse('2026-11-01T06:30:12.345Z'), text: 'Call  the dentist' });
    const update = vi.fn(async (patch: { reminder_id: string; text?: string; at?: number }) => {
      reminder = { ...reminder, ...patch };
      return { updated: true, reminder, message: 'Reminder changed.' };
    });
    const { surface } = mount({ list: async () => ({ reminders: [reminder], count: 1 }), update });
    await surface.refresh();
    const row = target({ 'data-reminder-id': 'rem_1' });
    surface.handleAction('reminders-edit', row); surface.handleAction('reminders-save', row);
    expect(update).not.toHaveBeenCalled();
    surface.handleAction('reminders-edit', row);
    surface.handleInput(target({ [REMINDERS_FIELD_ATTR]: 'text', 'data-reminder-id': 'rem_1' }, 'Call Dr Patel about the invoice'));
    expect(surface.hasUnsavedChanges()).toBe(true);
    surface.handleAction('reminders-save', row);
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ reminder_id: 'rem_1', text: 'Call Dr Patel about the invoice' }));
    expect(reminder.at).toBe(Date.parse('2026-11-01T06:30:12.345Z'));
  });

  it('rejects empty wording and nonexistent local times without sending an update', async () => {
    const update = vi.fn();
    const { surface } = mount({ list: async () => ({ reminders: [view()], count: 1 }), update });
    await surface.refresh(); const row = target({ 'data-reminder-id': 'rem_1' });
    surface.handleAction('reminders-edit', row);
    surface.handleInput(target({ [REMINDERS_FIELD_ATTR]: 'text', 'data-reminder-id': 'rem_1' }, '   '));
    surface.handleAction('reminders-save', row);
    expect(surface.render()).toContain('Enter what this reminder should say.');
    surface.handleInput(target({ [REMINDERS_FIELD_ATTR]: 'text', 'data-reminder-id': 'rem_1' }, 'Call the dentist'));
    surface.handleChange(target({ [REMINDERS_FIELD_ATTR]: 'at', 'data-reminder-id': 'rem_1' }, '2026-03-08T02:30'));
    surface.handleAction('reminders-save', row);
    expect(surface.render()).toContain('Pick a valid day and time');
    expect(update).not.toHaveBeenCalled();
  });

  it('directs managed reminders to Yours and protects unsaved wording from another row', async () => {
    const update = vi.fn(), cancel = vi.fn();
    const { surface } = mount({ list: async () => ({ reminders: [view(), view({ reminder_id: 'clock', managed_by: 'clock' }), view({ reminder_id: 'other' })], count: 3 }), update, cancel });
    await surface.refresh();
    surface.handleAction('reminders-edit', target({ 'data-reminder-id': 'clock' }));
    surface.handleAction('reminders-cancel', target({ 'data-reminder-id': 'clock' }));
    expect(surface.render()).toContain('Manage in Yours');
    expect(surface.render()).not.toContain('<textarea');
    surface.handleAction('reminders-edit', target({ 'data-reminder-id': 'rem_1' }));
    surface.handleInput(target({ [REMINDERS_FIELD_ATTR]: 'text', 'data-reminder-id': 'rem_1' }, 'Keep this wording'));
    surface.handleAction('reminders-edit', target({ 'data-reminder-id': 'other' }));
    expect(surface.render()).toContain('Keep this wording');
    expect(surface.render()).toContain('Save or discard your reminder changes');
    expect(update).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  });
});
