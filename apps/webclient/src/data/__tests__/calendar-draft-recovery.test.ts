import { afterEach, expect, it, vi } from 'vitest';
import { createCalendarDraftCheckpoint, createCalendarRecoveryStore, parseCalendarRecovery, CALENDAR_RECOVERY_LIMITS,
  type CalendarRecoveryEntry, type CalendarRecoveryStorage } from '../calendar-draft-recovery.js';

const now = Date.parse('2026-11-15T12:00:00Z');
const memory = () => {
  const rows = new Map<string, string>();
  const storage: CalendarRecoveryStorage = { getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => { rows.set(key, value); }, removeItem: key => { rows.delete(key); } };
  return { rows, storage };
};
const entry = (): CalendarRecoveryEntry => ({ id: `cdr_${crypto.randomUUID()}`, revision: 1, sourceId: 'calendar', original: null, status: 'editing', updatedAt: now,
  values: { zone: 'America/Los_Angeles', calendarName: 'Work calendar', incarnation: 'work-1', creationId: crypto.randomUUID(), request: null,
    draft: { destination: JSON.stringify(['work', 'primary']), summary: 'Planning', description: '\nCafé 😀 <script>literal</script>\n', location: 'Room 2',
      start: '2026-11-01T01:30', end: '2026-11-01T03:00', startChoice: String(Date.parse('2026-11-01T09:30:00Z')), endChoice: '',
      allDay: false, guests: [{ email: 'ada@example.com', display_name: 'Ada' }], guestQuery: '' } } });
const pending = (): CalendarRecoveryEntry => {
  const row = entry(), { draft } = row.values;
  return { ...row, status: 'pending', attempt: crypto.randomUUID(), values: { ...row.values,
    request: { slug: 'work', calendar_id: 'primary', expected_incarnation: 'work-1', creation_id: row.values.creationId,
      summary: draft.summary, description: draft.description, location: draft.location, timezone: row.values.zone,
      start_at: Date.parse('2026-11-01T09:30:00Z'), end_at: Date.parse('2026-11-01T11:00:00Z'), is_all_day: false,
      guests: draft.guests, send_invitations: true } } };
};
afterEach(() => vi.useRealTimers());

it('round trips exact draft and submitted values, strips unknown fields and isolates pairings', () => {
  const { storage } = memory(), store = createCalendarRecoveryStore({ scope: 'pair-a', storage, now: () => now });
  const row = pending();
  expect(store.save({ ...row, values: { ...row.values, rpc: 'invented', draft: { ...row.values.draft, arbitrary: 'ignored' },
    request: { ...row.values.request, arbitrary: 'ignored' } } } as CalendarRecoveryEntry)).toBe(true);
  expect(store.get(row.id)).toEqual(row);
  store.get(row.id)!.values.draft.guests.push({ email: 'other@example.com' });
  expect(store.get(row.id)!.values.draft.guests).toEqual(row.values.draft.guests);
  expect(createCalendarRecoveryStore({ scope: 'pair-a', storage, now: () => now }).get(row.id)).toEqual(row);
  expect(createCalendarRecoveryStore({ scope: 'pair-b', storage, now: () => now }).list()).toEqual([]);
});

it('rejects unbound, malformed or stale editing copies and retains old unconfirmed saves', () => {
  const row = pending(), request = row.values.request!;
  for (const change of [{ creation_id: crypto.randomUUID() }, { expected_incarnation: 'another-calendar' }, { start_at: request.start_at - 3_600_000 },
    { timezone: 'Asia/Tokyo' }, { guests: [{ email: 'unreviewed@example.com' }] }, { send_invitations: undefined }, { summary: 'Different' }]) {
    expect(parseCalendarRecovery({ ...row, values: { ...row.values, request: { ...request, ...change } } }, now)).toBeNull();
  }
  expect(parseCalendarRecovery({ ...row, attempt: undefined }, now)).toBeNull();
  expect(parseCalendarRecovery({ ...row, values: { ...row.values, zone: 'Invented/Zone' } }, now)).toBeNull();
  expect(parseCalendarRecovery({ ...row, values: { ...row.values, draft: { ...row.values.draft, guests: [{ email: 'invalid' }] } } }, now)).toBeNull();
  expect(parseCalendarRecovery(entry(), now + CALENDAR_RECOVERY_LIMITS.age + 1)).toBeNull();
  expect(parseCalendarRecovery(row, now + CALENDAR_RECOVERY_LIMITS.age + 1)).toEqual(row);
  expect(parseCalendarRecovery({ ...row, updatedAt: now + 60_001 }, now)).toBeNull();
});

it('does not checkpoint an untouched form, debounces changes and flushes the latest details on suspension', () => {
  vi.useFakeTimers(); const { storage } = memory(), store = createCalendarRecoveryStore({ scope: 'a', storage, now: () => now });
  const checkpoint = createCalendarDraftCheckpoint({ store, now: () => now, changed: vi.fn() }), row = entry();
  checkpoint.begin(row.values); checkpoint.flush(); vi.advanceTimersByTime(1000); expect(store.list()).toEqual([]);
  checkpoint.capture({ ...row.values, draft: { ...row.values.draft, description: 'first' } }); vi.advanceTimersByTime(200);
  checkpoint.capture({ ...row.values, draft: { ...row.values.draft, description: 'latest', guestQuery: 'Unadded person' } });
  expect(store.list()).toEqual([]); checkpoint.suspend();
  expect(store.list()[0]!.values.draft).toMatchObject({ description: 'latest', guestQuery: 'Unadded person' });
});

it('persists the frozen request before dispatch and fences a late reply from a resumed attempt', () => {
  const { storage } = memory(), store = createCalendarRecoveryStore({ scope: 'a', storage, now: () => now }), row = pending();
  const old = createCalendarDraftCheckpoint({ store, now: () => now, changed: vi.fn() });
  old.begin({ ...row.values, request: null }); const first = old.startAttempt(row.values)!; old.suspend();
  const saved = store.get(first.id)!; expect(saved).toMatchObject({ status: 'pending', values: { request: row.values.request } });
  const current = createCalendarDraftCheckpoint({ store, now: () => now, changed: vi.fn() }); current.begin(saved.values, saved);
  const next = current.startAttempt(saved.values)!;
  old.settle(first, 'confirmed'); expect(store.get(next.id)!.attempt).toBe(next.attempt);
  current.settle(next, 'unknown'); expect(store.get(next.id)!.status).toBe('unknown');
  const check = current.startAttempt(saved.values)!; current.settle(check, 'confirmed'); expect(store.list()).toEqual([]);
});

it('keeps a refused save editable and blocks dispatch if its earlier recovery copy cannot be updated', () => {
  const { storage } = memory(); let full = false;
  const store = createCalendarRecoveryStore({ scope: 'a', now: () => now, storage: { ...storage,
    setItem: (key, value) => { if (full) throw Error('quota'); storage.setItem(key, value); } } });
  const row = pending(), checkpoint = createCalendarDraftCheckpoint({ store, now: () => now, changed: vi.fn() });
  checkpoint.begin(entry().values); checkpoint.capture(row.values); const first = checkpoint.startAttempt(row.values)!;
  checkpoint.settle(first, 'refused');
  expect(store.get(first.id)).toMatchObject({ status: 'editing', values: { request: null } });
  const before = store.get(first.id); full = true;
  expect(checkpoint.startAttempt(row.values)!.blocked).toBe(true); expect(store.get(first.id)).toEqual(before);
  expect(checkpoint.message()).toContain('could not be kept');
  full = false; const retry = checkpoint.startAttempt(row.values)!; checkpoint.settle(retry, 'unknown');
  const unknown = store.get(first.id); full = true;
  expect(checkpoint.startAttempt(row.values)!.blocked).toBe(true); expect(store.get(first.id)).toEqual(unknown);
  full = false; checkpoint.flush();
  expect(store.get(first.id)).toMatchObject({ status: 'unknown', values: { request: row.values.request } });
  expect(checkpoint.discard()).toBe(true); expect(store.list()).toEqual([]);
});

it('retains an unconfirmed copy if confirmed-save cleanup or explicit discard cannot reach storage', () => {
  const { storage } = memory(); let blocked = true;
  const store = createCalendarRecoveryStore({ scope: 'a', now: () => now, storage: { ...storage,
    removeItem: key => { if (blocked) throw Error('blocked'); storage.removeItem(key); } } });
  const row = pending(), checkpoint = createCalendarDraftCheckpoint({ store, now: () => now, changed: vi.fn() });
  checkpoint.begin(row.values); const ticket = checkpoint.startAttempt(row.values)!;
  checkpoint.settle(ticket, 'confirmed'); checkpoint.suspend();
  expect(store.get(ticket.id)).toMatchObject({ status: 'unknown', values: { request: row.values.request } });
  checkpoint.begin(row.values, store.get(ticket.id)!); expect(checkpoint.discard()).toBe(false); expect(store.list()).toHaveLength(1);
  blocked = false; expect(checkpoint.discard()).toBe(true); expect(store.list()).toEqual([]);
});

it('verifies and releases the exact interrupted creation without changing its request, attempt or guests', () => {
  const { storage } = memory(), store = createCalendarRecoveryStore({ scope: 'a', storage, now: () => now }), row = pending();
  store.save(row);
  const checkpoint = createCalendarDraftCheckpoint({ store, now: () => now, changed: vi.fn() });
  checkpoint.begin(row.values, store.get(row.id)!);
  expect(checkpoint.keepForLater()).toBe(true);
  expect(checkpoint.id()).toBeUndefined(); expect(store.get(row.id)).toEqual(row);
  checkpoint.capture(entry().values); checkpoint.suspend();
  expect(store.get(row.id)).toEqual(row);
});

it('keeps the checkpoint attached after a failed write or read-back and allows a verified retry', () => {
  const { storage } = memory(); let writeBlocked = true, readBlocked = false;
  const store = createCalendarRecoveryStore({ scope: 'a', now: () => now, storage: { ...storage,
    setItem: (key, value) => { if (writeBlocked) throw Error('quota'); storage.setItem(key, value); },
    getItem: key => { if (readBlocked) throw Error('unavailable'); return storage.getItem(key); },
  } });
  const checkpoint = createCalendarDraftCheckpoint({ store, now: () => now, changed: vi.fn() }), row = entry();
  checkpoint.begin(row.values, undefined, true); const id = checkpoint.id()!;
  expect(checkpoint.keepForLater()).toBe(false); expect(checkpoint.id()).toBe(id);
  writeBlocked = false; checkpoint.flush(); const saved = store.get(id)!;
  readBlocked = true; expect(checkpoint.keepForLater()).toBe(false); expect(checkpoint.id()).toBe(id);
  readBlocked = false; expect(checkpoint.keepForLater()).toBe(true); expect(store.get(id)).toEqual(saved);
});

it('refuses to overwrite a newer recovery revision when keeping late edits for later', () => {
  const { storage } = memory(), store = createCalendarRecoveryStore({ scope: 'a', storage, now: () => now }), row = entry();
  store.save(row);
  const checkpoint = createCalendarDraftCheckpoint({ store, now: () => now, changed: vi.fn() });
  checkpoint.begin(row.values, row); checkpoint.capture({ ...row.values, draft: { ...row.values.draft, summary: 'Stale editor' } });
  const newer = { ...row, revision: row.revision + 1, values: { ...row.values, draft: { ...row.values.draft, summary: 'Resumed elsewhere' } } };
  store.save(newer);
  expect(checkpoint.keepForLater()).toBe(false); expect(checkpoint.id()).toBe(row.id); expect(store.get(row.id)).toEqual(newer);
  checkpoint.suspend(); expect(store.get(row.id)).toEqual(newer);
});
