import { expect, it, vi } from 'vitest';
import type { CalendarEventSnapshot, CalendarEventUpdateRequest } from '@recued/contracts';
import { createCalendarEventSurface, calendarEventDraft } from '../calendar-event-surface.js';
import { createCalendarEditRecoveryStore, calendarEditOriginal, type CalendarEditEntry } from '../calendar-edit-recovery.js';
import { CALENDAR_CONFLICT_FIELD, CALENDAR_CONFLICT_TOKEN } from '../calendar-edit-conflicts.js';

const now = () => Date.parse('2026-10-28T12:00Z');
const snapshot = (): CalendarEventSnapshot => ({ incarnation: 'local-1', resource_version: 'v1', editable: true,
  event: { source_id: 'event', record_id: 'cal:local:event', calendar_id: 'local', summary: 'Original title', description: 'Original notes', location: 'Room 2',
    start_at: Date.parse('2026-10-28T16:00:12.345Z'), end_at: Date.parse('2026-10-28T17:00:12.345Z'), timezone: 'America/Los_Angeles', is_all_day: false, status: 'confirmed', is_recurring: false, updated_at: now() },
  record: { source_id: 'event', record_id: 'cal:local:event', hot_fields: {}, received_at: now(), modified_at: now(), size_bytes: 0 } });
const setup = () => {
  const data = new Map<string, string>(); let failWrite = false, current = snapshot(), hold = false, finish: ((value: CalendarEventSnapshot) => void) | undefined;
  const store = createCalendarEditRecoveryStore({ scope: 'pair-a', now, storage: { getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { if (failWrite) throw Error('Full'); data.set(key, value); }, removeItem: key => { data.delete(key); } } });
  const before = snapshot(), entry: CalendarEditEntry = { id: 'ced_' + crypto.randomUUID(), revision: 1, updatedAt: now(), sourceId: 'local', status: 'editing',
    original: calendarEditOriginal('local', before), values: { draft: { ...calendarEventDraft(before.event), summary: 'My title', description: 'My notes' }, calendarName: 'Local', request: null } };
  expect(store.save(entry)).toBe(true); current = { ...before, resource_version: 'v2', event: { ...before.event, location: 'Saved room' } };
  const update = vi.fn(async (request: CalendarEventUpdateRequest) => { current = { ...current, resource_version: 'v3', event: { ...current.event, ...request.patch } }; return current; });
  const get = vi.fn(async (ref: { source_id: string }) => {
    if (hold && ref.source_id === 'event') { hold = false; return new Promise<CalendarEventSnapshot>(done => { finish = done; }); }
    return { ...current, event: { ...current.event, source_id: ref.source_id, record_id: `cal:local:${ref.source_id}` }, record: { ...current.record, source_id: ref.source_id, record_id: `cal:local:${ref.source_id}` } };
  });
  const make = () => createCalendarEventSurface({ callers: { get, update }, recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
  return { store, entry, make, update, get, current: () => current, set: (value: CalendarEventSnapshot) => { current = value; }, failWrite: (value: boolean) => { failWrite = value; },
    hold: () => { hold = true; }, release: (value: CalendarEventSnapshot) => finish!(value) };
};
const open = (surface: ReturnType<typeof createCalendarEventSurface>) => surface.open({ slug: 'local', source_id: 'event' }, 'cal:local:event');
const review = async (surface: ReturnType<typeof createCalendarEventSurface>, entry: CalendarEditEntry) => {
  await open(surface); surface.handleAction(`calendar-event-recovery-resume-${entry.id}-${entry.revision}`);
  await vi.waitFor(() => expect(surface.render()).toContain('Compare event edits'));
};
const action = (surface: ReturnType<typeof createCalendarEventSurface>, name = 'prepare') => /data-action="(calendar-event-conflict-prepare-[^"]+)"/.exec(surface.render())![1]!.replace('conflict-prepare-', 'conflict-' + name + '-');
const choose = (surface: ReturnType<typeof createCalendarEventSurface>, key: string, value: string, token = action(surface).split('conflict-prepare-')[1]!) => surface.handleInput({
  value, getAttribute: (attribute: string) => attribute === CALENDAR_CONFLICT_FIELD ? key : attribute === CALENDAR_CONFLICT_TOKEN ? token : null,
} as unknown as HTMLElement);

it('prepares and checkpoints independent edits against the current version without writing, then saves only the reviewed changes', async () => {
  const s = setup(), surface = s.make(); await review(surface, s.entry); expect(surface.isEditing()).toBe(false);
  const beforeReads = s.get.mock.calls.length; surface.handleAction(action(surface)); await vi.waitFor(() => expect(surface.isEditing()).toBe(true));
  expect(s.get.mock.calls.length).toBe(beforeReads + 1); expect(s.update).not.toHaveBeenCalled();
  expect(s.store.get(s.entry.id)).toMatchObject({ revision: 2, original: { resource_version: 'v2' }, values: { draft: { summary: 'My title', description: 'My notes', location: 'Saved room' } } });
  surface.handleAction('calendar-event-save'); await vi.waitFor(() => expect(s.update).toHaveBeenCalledTimes(1));
  expect(s.update.mock.calls[0]![0]).toMatchObject({ expected_version: 'v2', expected_incarnation: 'local-1', patch: { summary: 'My title', description: 'My notes' } });
  await vi.waitFor(() => expect(s.store.list()).toEqual([])); surface.dispose();
});

it('requires explicit conflict choices and saves only those choices while keeping other current fields', async () => {
  const s = setup(); s.set({ ...s.current(), event: { ...s.current().event, summary: 'Saved title', description: 'Saved notes' } }); const surface = s.make(); await review(surface, s.entry);
  surface.handleAction(action(surface)); expect(surface.isEditing()).toBe(false); choose(surface, 'summary', 'mine'); surface.handleAction(action(surface)); expect(surface.isEditing()).toBe(false);
  choose(surface, 'description', 'saved'); surface.handleAction(action(surface)); await vi.waitFor(() => expect(surface.isEditing()).toBe(true));
  surface.handleAction('calendar-event-save'); await vi.waitFor(() => expect(s.update).toHaveBeenCalledTimes(1)); expect(s.update.mock.calls[0]![0].patch).toEqual({ summary: 'My title' }); surface.dispose();
});

it('refreshes the comparison after another saved change and ignores choices and actions from the retired review', async () => {
  const s = setup(); s.set({ ...s.current(), event: { ...s.current().event, summary: 'Saved title' } }); const surface = s.make(); await review(surface, s.entry);
  const old = action(surface), token = old.split('conflict-prepare-')[1]!; choose(surface, 'summary', 'mine');
  s.set({ ...s.current(), resource_version: 'v3', event: { ...s.current().event, summary: 'Even newer title' } }); surface.handleAction(old);
  await vi.waitFor(() => expect(surface.render()).toContain('changed again')); expect(s.store.get(s.entry.id)?.original?.resource_version).toBe('v1');
  choose(surface, 'summary', 'mine', token); surface.handleAction(old); expect(surface.isEditing()).toBe(false); surface.handleAction(action(surface)); expect(surface.isEditing()).toBe(false);
  choose(surface, 'summary', 'mine'); surface.handleAction(action(surface)); await vi.waitFor(() => expect(surface.isEditing()).toBe(true)); surface.handleAction('calendar-event-save');
  await vi.waitFor(() => expect(s.update).toHaveBeenCalledTimes(1)); expect(s.update.mock.calls[0]![0].expected_version).toBe('v3'); surface.dispose();
});

it('keeps the original copy if a calendar identity or field permission changes during review', async () => {
  for (const kind of ['identity', 'permission'] as const) {
    const s = setup(), surface = s.make(); await review(surface, s.entry);
    s.set(kind === 'identity' ? { ...s.current(), incarnation: 'replacement' }
      : { ...s.current(), editable_fields: ['location'], provider_verified: true });
    surface.handleAction(action(surface)); await vi.waitFor(() => expect(surface.render()).toMatch(kind === 'identity' ? /was replaced/ : /no longer be edited/));
    expect(surface.isEditing()).toBe(false); expect(s.store.get(s.entry.id)).toEqual(s.entry); expect(s.update).not.toHaveBeenCalled(); surface.dispose();
  }
});

it('retains the original recovery on checkpoint failure and resumes the prepared draft after a successful retry', async () => {
  const s = setup(), surface = s.make(); await review(surface, s.entry); s.failWrite(true); surface.handleAction(action(surface));
  await vi.waitFor(() => expect(surface.render()).toContain('prepared draft could not be kept')); expect(s.store.get(s.entry.id)).toEqual(s.entry); expect(surface.isEditing()).toBe(false);
  s.failWrite(false); surface.handleAction(action(surface)); await vi.waitFor(() => expect(surface.isEditing()).toBe(true)); surface.dispose();
  const stored = s.store.get(s.entry.id)!; expect(stored.original?.resource_version).toBe('v2'); const restored = s.make(); await open(restored);
  restored.handleAction(`calendar-event-recovery-resume-${stored.id}-${stored.revision}`); await vi.waitFor(() => expect(restored.isEditing()).toBe(true));
  expect(restored.render()).toContain('My title'); expect(restored.render()).toContain('Saved room'); expect(s.update).not.toHaveBeenCalled(); restored.dispose();
});

it('retires a prepare read when another event opens and keeps cancellation from changing the recovery', async () => {
  const s = setup(), surface = s.make(); await review(surface, s.entry); expect(surface.escape()).toBe(true); expect(s.store.get(s.entry.id)).toEqual(s.entry);
  surface.handleAction(`calendar-event-recovery-resume-${s.entry.id}-${s.entry.revision}`); await vi.waitFor(() => expect(surface.render()).toContain('Compare event edits'));
  s.hold(); surface.handleAction(action(surface)); await surface.open({ slug: 'local', source_id: 'other' }, 'cal:local:other'); s.release(s.current()); await new Promise(resolve => setTimeout(resolve, 0));
  expect(surface.isEditing()).toBe(false); expect(s.store.get(s.entry.id)).toEqual(s.entry); expect(s.update).not.toHaveBeenCalled(); surface.dispose();
});

it('preserves read-only rich provider notes when reapplying a permitted title edit', async () => {
  const s = setup(); const row = s.store.get(s.entry.id)!; row.values.draft.description = row.original!.event.description;
  expect(s.store.save(row)).toBe(true);
  const fresh = { ...s.current(), provider_verified: true as const, editable_fields: ['summary', 'location', 'start_at', 'end_at'] as Array<keyof CalendarEventUpdateRequest['patch']>,
    event: { ...s.current().event, description: '<p>New <b>provider</b> notes</p>' } }; s.set(fresh);
  const surface = s.make(); await review(surface, s.entry); surface.handleAction(action(surface)); await vi.waitFor(() => expect(surface.isEditing()).toBe(true));
  surface.handleAction('calendar-event-save'); await vi.waitFor(() => expect(s.update).toHaveBeenCalledTimes(1)); expect(s.update.mock.calls[0]![0].patch).toEqual({ summary: 'My title' });
  expect(s.current().event.description).toBe(fresh.event.description); surface.dispose();
});
