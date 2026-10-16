/** D-324 — the Reminders tab's own state: what it shows, and what it sends.
 *
 *  ⛔ What these pin beyond the route test: a new time is read on the REMINDER'S
 *  clock, so a browser in another zone moves nothing it did not mean to; a time
 *  the server refuses keeps the row open with the server's words; and an unsaved
 *  time is an unsaved change. */

import { describe, expect, it, vi } from 'vitest';
import type { ReminderView } from '@recued/contracts';

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
    expect(surface.render()).not.toContain('America/New_York time');
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
    await vi.waitFor(() => expect(surface.render()).toContain('Pick a day and a time.'));
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
    expect(surface.render()).not.toContain('Change time');
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
});
