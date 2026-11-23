import { afterEach, expect, it, vi } from 'vitest';
import { calendarEditOriginal, calendarRecoverySearchStore, createCalendarEditCheckpoint, createCalendarEditRecoveryStore,
  parseCalendarEditRecovery, CALENDAR_EDIT_RECOVERY_LIMITS, type CalendarEditEntry } from '../calendar-edit-recovery.js';
import { calendarEventDraft } from '../calendar-event-draft.js';
import { createCalendarRecoveryStore } from '../calendar-draft-recovery.js';
import { resolveRecoveryDraft, searchRecoveryDrafts } from '../recovery-draft-search.js';
import type { CalendarEventSnapshot } from '@recued/contracts';

const now = Date.parse('2026-11-01T08:50Z');
const snapshot = (): CalendarEventSnapshot => ({ resource_version: 'v1', incarnation: 'local-1', editable: true,
  event: { source_id: 'event', record_id: 'cal:local:event', calendar_id: 'local', summary: 'Planning', description: 'Original notes', location: 'Room 2',
    start_at: Date.parse('2026-11-01T08:15Z'), end_at: Date.parse('2026-11-01T08:45:12.345Z'), timezone: 'America/Los_Angeles', is_all_day: false, status: 'confirmed', is_recurring: false, updated_at: now - 1000 },
  record: { record_id: 'cal:local:event', source_id: 'event', hot_fields: {}, received_at: now, modified_at: now, size_bytes: 0 } });
const entry = (): CalendarEditEntry => { const original = calendarEditOriginal('local', snapshot()); return { id: 'ced_' + crypto.randomUUID(), sourceId: 'local', revision: 1, updatedAt: now,
  status: 'editing', original, values: { draft: { ...calendarEventDraft(original.event), summary: 'Kept title', start: '2026-11-01T01:00', end: '2026-11-01T01:30:12.345',
    startChoice: String(Date.parse('2026-11-01T09:00Z')), endChoice: String(Date.parse('2026-11-01T09:30:12.345Z')) }, calendarName: 'Local', request: null } }; };
const pending = () => { const row = entry(); return { ...row, status: 'pending' as const, attempt: crypto.randomUUID(), values: { ...row.values,
  request: { slug: 'local', source_id: 'event', expected_incarnation: 'local-1', expected_version: 'v1', patch: { summary: 'Kept title', start_at: Date.parse('2026-11-01T09:00Z'), end_at: Date.parse('2026-11-01T09:30:12.345Z') } } } }; };
const memory = () => { const rows = new Map<string, string>(); let unavailable = false;
  return { rows, fail: (value: boolean) => { unavailable = value; }, storage: { getItem: (key: string) => { if (unavailable) throw Error('Unavailable'); return rows.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (unavailable) throw Error('Full'); rows.set(key, value); }, removeItem: (key: string) => { if (unavailable) throw Error('Full'); rows.delete(key); } } }; };
afterEach(() => vi.useRealTimers());

it('round trips exact repeated-hour choices, strips unrecognized data and scopes copies to their pairing', () => {
  const { storage } = memory(), store = createCalendarEditRecoveryStore({ scope: 'server-a:pair-1', storage, now: () => now });
  const row = pending(); expect(store.save({ ...row, values: { ...row.values, extra: 'not authority' } } as CalendarEditEntry)).toBe(true);
  expect(store.get(row.id)).toEqual(row); expect(createCalendarEditRecoveryStore({ scope: 'server-b:pair-1', storage, now: () => now }).list()).toEqual([]);
  expect(createCalendarEditRecoveryStore({ scope: 'server-a:pair-2', storage, now: () => now }).list()).toEqual([]);
  store.get(row.id)!.values.draft.summary = 'Changed returned value'; expect(store.get(row.id)!.values.draft.summary).toBe('Kept title');
});

it('rejects requests that differ from the exact kept review and retains old uncertain writes', () => {
  const row = pending(), request = row.values.request;
  for (const change of [{ expected_incarnation: 'replacement' }, { expected_version: 'new-version' }, { source_id: 'other' },
    { patch: { ...request.patch, end_at: request.patch.end_at + 1 } }, { patch: { ...request.patch, arbitrary: 'extra' } }]) {
    expect(parseCalendarEditRecovery({ ...row, values: { ...row.values, request: { ...request, ...change } } }, now)).toBeNull();
  }
  expect(parseCalendarEditRecovery({ ...row, attempt: undefined }, now)).toBeNull();
  expect(parseCalendarEditRecovery(entry(), now + CALENDAR_EDIT_RECOVERY_LIMITS.age + 1)).toBeNull();
  expect(parseCalendarEditRecovery(row, now + CALENDAR_EDIT_RECOVERY_LIMITS.age + 1)).toEqual(row);
});

it('keeps incomplete edits, debounces typing, flushes on suspension and does not retain an untouched or reverted draft', () => {
  vi.useFakeTimers(); const { storage } = memory(), store = createCalendarEditRecoveryStore({ scope: 'a', storage, now: () => now });
  const row = entry(), baseline = calendarEventDraft(row.original.event), checkpoint = createCalendarEditCheckpoint({ store, now: () => now, changed: vi.fn() });
  checkpoint.begin(row.original, baseline, 'Local'); checkpoint.flush(); vi.advanceTimersByTime(500); expect(store.list()).toEqual([]);
  checkpoint.capture({ ...baseline, summary: 'First' }); checkpoint.capture(baseline); vi.advanceTimersByTime(500); expect(store.list()).toEqual([]);
  checkpoint.capture({ ...baseline, summary: '', end: '', endChoice: '' }); vi.advanceTimersByTime(100);
  checkpoint.capture({ ...baseline, summary: '', end: '', endChoice: '', description: 'Latest typing' }); checkpoint.suspend();
  expect(store.list()[0]!.values.draft).toMatchObject({ summary: '', end: '', endChoice: '', description: 'Latest typing' });
});

it('blocks dispatch on storage failure, retries keeping edits and fences settlement against a newer recovery revision', () => {
  const m = memory(), store = createCalendarEditRecoveryStore({ scope: 'a', storage: m.storage, now: () => now }), row = pending();
  const checkpoint = createCalendarEditCheckpoint({ store, now: () => now, changed: vi.fn() }); checkpoint.begin(row.original, calendarEventDraft(row.original.event), 'Local');
  checkpoint.capture(row.values.draft); m.fail(true); expect(checkpoint.startAttempt(row.values.request)?.blocked).toBe(true); expect(checkpoint.message()).toContain('could not be kept');
  m.fail(false); const ticket = checkpoint.startAttempt(row.values.request)!; expect(ticket.blocked).toBe(false);
  checkpoint.suspend(); const saved = store.get(ticket.id)!; expect(store.save({ ...saved, revision: saved.revision + 1, values: { ...saved.values, calendarName: 'Newer recovery' } })).toBe(true);
  checkpoint.settle(ticket, 'confirmed'); expect(store.get(ticket.id)?.values.calendarName).toBe('Newer recovery');
});

it('settles its exact attempt after disposal without resurrecting or deleting another copy', () => {
  const { storage } = memory(), store = createCalendarEditRecoveryStore({ scope: 'a', storage, now: () => now }), row = pending();
  const checkpoint = createCalendarEditCheckpoint({ store, now: () => now, changed: vi.fn() }); checkpoint.begin(row.original, calendarEventDraft(row.original.event), 'Local');
  checkpoint.capture(row.values.draft); const ticket = checkpoint.startAttempt(row.values.request)!; checkpoint.suspend(); checkpoint.settle(ticket, 'unknown');
  expect(store.get(ticket.id)?.status).toBe('unknown'); expect(store.get(ticket.id)?.values.request).toEqual(row.values.request);
  // An old callback cannot settle a revision that already recorded uncertainty.
  checkpoint.settle(ticket, 'confirmed'); expect(store.get(ticket.id)).not.toBeNull();
});

it('searches kept edits with the existing calendar group and rechecks the owning revision', () => {
  const { storage } = memory(), edits = createCalendarEditRecoveryStore({ scope: 'a', storage, now: () => now }), creates = createCalendarRecoveryStore({ scope: 'a', storage, now: () => now });
  const row = entry(); expect(edits.save(row)).toBe(true); const calendar = calendarRecoverySearchStore([creates, edits]);
  const stores = { calendar }, found = searchRecoveryDrafts(stores, 'kept title').matches;
  expect(found).toHaveLength(1); expect(found[0]).toMatchObject({ kind: 'calendar', editingExisting: true, status: 'editing' });
  expect(resolveRecoveryDraft(stores, found[0]!)).toEqual(row); edits.save({ ...row, revision: 2 }); expect(resolveRecoveryDraft(stores, found[0]!)).toBeNull();
});

it('keeps and reads back the latest draft before detaching it for later', () => {
  vi.useFakeTimers(); const m = memory(), store = createCalendarEditRecoveryStore({ scope: 'a', storage: m.storage, now: () => now }), row = entry();
  const checkpoint = createCalendarEditCheckpoint({ store, now: () => now, changed: vi.fn() }); checkpoint.begin(row.original, calendarEventDraft(row.original.event), 'Local');
  checkpoint.capture(row.values.draft); const id = checkpoint.id()!; expect(store.list()).toEqual([]); expect(checkpoint.keepForLater()).toBe(true);
  expect(checkpoint.id()).toBeUndefined(); const saved = store.get(id)!; expect(saved.values.draft).toEqual(row.values.draft); expect(saved.original).toEqual(row.original);
  checkpoint.capture({ ...row.values.draft, summary: 'A detached callback' }); vi.advanceTimersByTime(1000); checkpoint.suspend(); expect(store.get(id)).toEqual(saved);
});

it('refuses leaving after failed writes, unreadable storage or a newer recovery revision, and permits a genuine retry', () => {
  const m = memory(), store = createCalendarEditRecoveryStore({ scope: 'a', storage: m.storage, now: () => now }), row = entry();
  const checkpoint = createCalendarEditCheckpoint({ store, now: () => now, changed: vi.fn() }); checkpoint.begin(row.original, calendarEventDraft(row.original.event), 'Local'); checkpoint.capture(row.values.draft);
  const id = checkpoint.id()!; m.fail(true); expect(checkpoint.keepForLater()).toBe(false); expect(checkpoint.id()).toBe(id);
  m.fail(false); checkpoint.flush(); const saved = store.get(id)!;
  m.fail(true); expect(checkpoint.keepForLater()).toBe(false); expect(checkpoint.id()).toBe(id);
  m.fail(false); expect(checkpoint.keepForLater()).toBe(true); expect(store.get(id)).toEqual(saved);
  checkpoint.begin(saved.original!, saved.values.draft, 'Local', saved as CalendarEditEntry);
  expect(store.save({ ...saved, revision: saved.revision + 1, values: { ...saved.values, calendarName: 'Newer copy' } })).toBe(true);
  expect(checkpoint.keepForLater()).toBe(false); expect(store.get(id)?.values.calendarName).toBe('Newer copy'); checkpoint.suspend();
});

it('keeps an interrupted save with its exact request, attempt and status without starting another attempt', () => {
  const m = memory(), store = createCalendarEditRecoveryStore({ scope: 'a', storage: m.storage, now: () => now }), row = pending();
  const checkpoint = createCalendarEditCheckpoint({ store, now: () => now, changed: vi.fn() }); checkpoint.begin(row.original, calendarEventDraft(row.original.event), 'Local'); checkpoint.capture(row.values.draft);
  const ticket = checkpoint.startAttempt(row.values.request)!; checkpoint.settle(ticket, 'unknown'); const saved = store.get(ticket.id)!;
  expect(checkpoint.keepForLater()).toBe(true); expect(store.get(ticket.id)).toEqual(saved); expect(saved).toMatchObject({ status: 'unknown', attempt: ticket.attempt, values: { request: row.values.request } });
});
