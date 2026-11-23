import { expect, it, vi } from 'vitest';
import type { ReminderListRequest, ReminderListResult, ReminderView } from '@recued/contracts';
import { createTodayReminders } from '../reminders.js';
import { createTodayReminderNavigation } from '../reminder-navigation.js';
import { todayWindow } from '../../data/today-view.js';

const NOW = Date.parse('2026-11-01T05:30:00Z');
const row = (id = 'rem-one', at = NOW + 3600_000): ReminderView => ({
  reminder_id: id, text: 'Call <Riley>', at, when: 'Confirmed reminder time', state: 'pending', time_zone: 'America/New_York', delivered_at: null,
});
const page = (rows: ReminderView[]): ReminderListResult => ({ reminders: rows, count: rows.length,
  page: { state: 'pending', matched_count: rows.length, next_cursor: null } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const setup = () => {
  let current = row();
  let clock = NOW;
  const list = vi.fn(async (_input: ReminderListRequest) => page([current]));
  const get = vi.fn(async () => ({ reminder: current }));
  const update = vi.fn(async (input: { reminder_id: string; at?: number }) => {
    current = { ...current, at: input.at! }; return { updated: true, reminder: current, message: 'Changed on the server.' };
  });
  const cancel = vi.fn(async () => {
    current = { ...current, state: 'cancelled' }; return { cancelled: true, reminder: current, message: 'Cancelled on the server.' };
  });
  const blocked = vi.fn(() => false), changed = vi.fn();
  const model = createTodayReminders({ callers: { list, get, update, cancel }, now: () => clock, changed, blocked });
  return { model, list, get, update, cancel, blocked, changed, setNow: (at: number) => { clock = at; }, replace: (value: ReminderView) => { current = value; } };
};

it('walks past managed reminders before grouping one-off rows by the viewer day, retaining all confirmed rows after a later-page failure', async () => {
  const f = setup(), span = todayWindow(NOW);
  const managed = Array.from({ length: 100 }, (_, i) => ({ ...row('clock-' + i, NOW - 1000 + i), managed_by: 'clock' as const }));
  const own = [row('due', NOW - 1), row('later', NOW + 3600_000), row('next', span.tomorrow + 1000)];
  f.list.mockImplementation(async input => input.page?.cursor ? { ...page(own), count: 103, page: { state: 'pending', matched_count: 103, next_cursor: null } }
    : { ...page(managed), count: 103, page: { state: 'pending', matched_count: 103, next_cursor: { at: managed[99]!.at, reminder_id: managed[99]!.reminder_id } } });
  await f.model.load();
  const html = f.model.render('data-action');
  expect(f.list).toHaveBeenCalledTimes(2);
  expect(html).toContain('Due now'); expect(html).toContain('Next seven days');
  expect(html).toContain('Call &lt;Riley&gt;'); expect(html).not.toContain('data-today-reminder-row="clock-');
  expect(html).toContain('America/New_York'); expect(f.model.current()).toBe(true);
  f.list.mockImplementation(async input => { if (input.page?.cursor) throw new Error('Page interrupted'); return { ...page(managed), count: 103,
    page: { state: 'pending', matched_count: 103, next_cursor: { at: managed[99]!.at, reminder_id: managed[99]!.reminder_id } } }; });
  await f.model.load();
  expect(f.model.render('data-action')).toContain('Page interrupted');
  expect(f.model.render('data-action')).toContain('data-today-reminder-row="next"');
  expect(f.model.current()).toBe(false);
});

it('rejects nonadvancing, changed-count and old-server pages instead of claiming an empty complete view', async () => {
  for (const out of [{ reminders: [], count: 0 }, { ...page([row()]), page: { state: 'pending', matched_count: 2, next_cursor: null } },
    { ...page([row()]), page: { state: 'pending', matched_count: 2, next_cursor: { at: NOW, reminder_id: 'wrong' } } }]) {
    const f = setup(); f.list.mockResolvedValue(out as ReminderListResult); await f.model.load();
    expect(f.model.current()).toBe(false); expect(f.model.render('data-action')).not.toContain('No one-off reminders waiting');
  }
});

it('reschedules on the reminder clock across DST, keeps wording and the record binding, and confirms only the saved server result', async () => {
  const f = setup(), record_ref = { kind: 'task' as const, id: 'task', source_id: 'recued.task', source_record_id: null, created_at: 1 };
  f.replace({ ...row(), record_ref }); await f.model.load();
  await f.model.change('rem-one', 'tomorrow-9');
  expect(f.update).toHaveBeenCalledExactlyOnceWith({ reminder_id: 'rem-one', at: Date.parse('2026-11-02T14:00:00Z') });
  expect(f.model.render('data-action')).toContain('Linked task'); expect(f.model.render('data-action')).toContain('Changed on the server.');
  expect(f.cancel).not.toHaveBeenCalled();
});

it('reconciles a lost move reply by rereading the frozen target time without moving it again', async () => {
  const f = setup(); await f.model.load();
  f.update.mockImplementationOnce(async input => { f.replace({ ...row(), at: input.at! }); throw new Error('Reply lost'); });
  await f.model.change('rem-one', '1-hour');
  expect(f.model.render('data-action')).toContain('Reply lost');
  await f.model.change('rem-one', '1-hour');
  expect(f.update).toHaveBeenCalledTimes(1); expect(f.model.render('data-action')).toContain('Reminder moved');
});

it('uses the contract UTC clock for a legacy null zone instead of the travelling viewer clock', async () => {
  const f = setup(); f.replace({ ...row(), time_zone: null }); await f.model.load();
  await f.model.change('rem-one', 'tomorrow-9');
  expect(f.update).toHaveBeenCalledExactlyOnceWith({ reminder_id: 'rem-one', at: Date.parse('2026-11-02T09:00:00Z') });
});

it('retires a lost-reply retry when a refreshed list confirms it, so a later click sets a new relative time', async () => {
  const f = setup(); await f.model.load();
  f.update.mockImplementationOnce(async input => { f.replace({ ...row(), at: input.at! }); throw new Error('Reply lost'); });
  await f.model.change('rem-one', '1-hour'); f.setNow(NOW + 600_000);
  await f.model.load(); await f.model.change('rem-one', '1-hour');
  expect(f.update).toHaveBeenCalledTimes(2);
  expect(f.update).toHaveBeenLastCalledWith({ reminder_id: 'rem-one', at: NOW + 600_000 + 3600_000 });
});

it('checks confirmation and the latest state, refusing delivered, replaced wording and managed reminders without writing', async () => {
  for (const patch of [{ state: 'delivered' as const, delivered_at: NOW }, { text: 'Changed purpose' }, { managed_by: 'clock' as const }]) {
    const f = setup(); await f.model.load(); f.replace({ ...row(), ...patch });
    f.model.handle('today-reminder-confirm', 'rem-one'); expect(f.cancel).not.toHaveBeenCalled();
    f.model.handle('today-reminder-cancel', 'rem-one');
    await f.model.change('rem-one');
    expect(f.cancel).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  }
});

it('reconciles a lost cancellation and never treats a refusal or a wrong update receipt as success', async () => {
  const f = setup(); await f.model.load();
  f.cancel.mockImplementationOnce(async () => { f.replace({ ...row(), state: 'cancelled' }); throw new Error('Cancellation reply lost'); });
  await f.model.change('rem-one'); await f.model.change('rem-one');
  expect(f.cancel).toHaveBeenCalledTimes(1); expect(f.model.render('data-action')).toContain('already cancelled');
  const other = setup(); await other.model.load();
  other.update.mockResolvedValueOnce({ updated: false, reminder: row(), message: 'Already rang.' });
  await other.model.change('rem-one', '15-minutes');
  expect(other.model.render('data-action')).toContain('Already rang.'); expect(other.model.render('data-action')).not.toContain('Changed on the server.');
});

it('fences an older list reply after a write and stops an action when its route retires or another editor opens', async () => {
  const f = setup(); await f.model.load();
  const read = deferred<ReminderListResult>(); f.list.mockReturnValueOnce(read.promise);
  const loading = f.model.load(); await f.model.change('rem-one', '15-minutes');
  read.resolve(page([row()])); await loading;
  expect(f.model.render('data-action')).toContain(new Date(NOW + 900_000).toISOString());
  for (const retire of [true, false]) {
    const g = setup(); await g.model.load(); const held = deferred<{ reminder: ReminderView }>(); g.get.mockReturnValueOnce(held.promise);
    const action = g.model.change('rem-one', '1-hour');
    if (retire) g.model.dispose(); else g.blocked.mockReturnValue(true);
    held.resolve({ reminder: row() }); await action; expect(g.update).not.toHaveBeenCalled();
  }
});

it('retains only the explicit Today-reminder-child return chain and gives each return its own copy of view state', () => {
  const navigate = vi.fn(), nav = createTodayReminderNavigation(navigate);
  nav.open({ id: 'rem-one', focus: 'open:rem-one', sphere: 'professional', expanded: ['task'], sourcesOpen: true, scrollTop: 400 });
  expect(navigate).toHaveBeenLastCalledWith('#data/reminder/rem-one');
  nav.follow('rem-one', '#data/task/task-one'); nav.route('#data/task/task-one'); expect(nav.owns('rem-one')).toBe(true);
  nav.route('#data/today'); expect(nav.owns('rem-one')).toBe(true);
  expect(nav.back('rem-one')).toBe(true); expect(navigate).toHaveBeenLastCalledWith('#today');
  const returned = nav.restoreToday()!; returned.expanded.push('different');
  expect(nav.restoreToday()!.expanded).toEqual(['task']);
  nav.route('#data/mail'); expect(nav.back('rem-one')).toBe(false); expect(nav.restoreToday()).toBeUndefined();
});
