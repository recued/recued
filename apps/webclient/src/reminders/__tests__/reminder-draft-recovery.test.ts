import { afterEach, expect, it, vi } from 'vitest';
import { createReminderDraftCheckpoint, createReminderRecoveryStore, parseReminderRecovery, reminderDraftAt, reminderDraftSource,
  type ReminderDraftEntry, type ReminderDraftValues } from '../reminder-draft-recovery.js';
import { recoveryDraftLabel, resolveRecoveryDraft, searchRecoveryDrafts } from '../../data/recovery-draft-search.js';
import { renderUniversalSearch } from '../../data/universal-search.js';

const now = Date.parse('2026-11-01T05:00:00Z');
const values = (): ReminderDraftValues => ({ kind: 'reminder', text: '  Call\n Ada  ', time: '2026-11-01T01:30', zone: 'America/New_York',
  chosenAt: Date.parse('2026-11-01T06:30:42.123Z'), creationId: crypto.randomUUID(), fromHistory: false, request: null });
const row = (): ReminderDraftEntry => ({ id: 'rdr_' + crypto.randomUUID(), revision: 1, updatedAt: now, sourceId: 'reminder',
  original: null, status: 'editing', values: values() });
const pending = (): ReminderDraftEntry => {
  const entry = row();
  return { ...entry, status: 'pending', attempt: crypto.randomUUID(),
    values: { ...entry.values, request: { text: 'Call Ada', at: entry.values.chosenAt!, creation_id: entry.values.creationId } } };
};
const setup = () => {
  const raw = new Map<string, string>(); let clock = now, blocked = false, unreadable = false, drop = false;
  const storage = { getItem(key: string) { if (unreadable) throw Error('unreadable'); return raw.get(key) ?? null; },
    setItem(key: string, value: string) { if (blocked) throw Error('quota'); if (!drop) raw.set(key, value); },
    removeItem(key: string) { if (blocked) throw Error('quota'); raw.delete(key); } };
  const store = createReminderRecoveryStore({ scope: 'paired-server-a', storage, now: () => clock });
  const checkpoint = createReminderDraftCheckpoint({ store, now: () => clock, changed() {} });
  return { store, checkpoint, storage, raw, advance() { clock += 8 * 86_400_000; },
    block(value = true) { blocked = value; }, unreadable(value = true) { unreadable = value; }, drop(value = true) { drop = value; } };
};
afterEach(() => vi.useRealTimers());

it('keeps incomplete owner input and the exact repeated-hour instant, stripping untrusted metadata', () => {
  const entry = row();
  expect(parseReminderRecovery(entry, now)).toEqual(entry);
  expect(reminderDraftAt(entry.values)).toBe(Date.parse('2026-11-01T06:30:42.123Z'));
  expect(parseReminderRecovery({ ...entry, values: { ...entry.values, text: '', time: '', chosenAt: null, extra: 'ignored' } }, now)?.values)
    .toEqual({ ...entry.values, text: '', time: '', chosenAt: null });
  const attempt = pending();
  expect(parseReminderRecovery({ ...attempt, values: { ...attempt.values, request: { ...attempt.values.request, arbitrary: 'ignored' } } }, now)).toEqual(attempt);
  expect(parseReminderRecovery({ ...entry, values: { ...entry.values, zone: 'Bad/Zone' } }, now)).toBeNull();
  expect(parseReminderRecovery({ ...entry, values: { ...entry.values, time: '2026-11-02T01:30' } }, now)).toBeNull();
});

it('requires an interrupted request to match the exact creation identity, normalized text, time and source lifetime', () => {
  const entry = pending(), ref = { kind: 'task' as const, id: 'task-1', source_id: 'recued.task', source_record_id: null, created_at: now };
  const linked = { ...entry, values: { ...entry.values, record_ref: ref, request: { ...entry.values.request!, record_ref: ref } } };
  expect(parseReminderRecovery(linked, now)).toEqual(linked);
  for (const request of [
    { ...linked.values.request, creation_id: crypto.randomUUID() }, { ...linked.values.request, text: 'Other text' },
    { ...linked.values.request, at: entry.values.chosenAt! + 1 },
    { ...linked.values.request, record_ref: { ...ref, created_at: now + 1 } },
  ]) expect(parseReminderRecovery({ ...linked, values: { ...linked.values, request } }, now)).toBeNull();
  expect(reminderDraftSource(linked.values)).toEqual({ href: '#data/task/task-1', label: 'View source task' });
});

it('isolates pairings, expires editing copies, and retains uncertain saves past seven days', () => {
  const f = setup(), editing = row(), attempt = pending();
  expect(f.store.save(editing)).toBe(true); expect(f.store.save(attempt)).toBe(true);
  expect(createReminderRecoveryStore({ scope: 'other-pairing', storage: f.storage, now: () => now }).list()).toEqual([]);
  f.advance(); expect(f.store.list()).toEqual([attempt]);
  f.unreadable(); expect(f.store.inspect?.()).toEqual({ unavailable: true, entries: [] });
});

it('does not auto-keep an untouched form but verifies an explicitly kept copy before detaching', () => {
  vi.useFakeTimers(); const f = setup();
  f.checkpoint.begin(values()); vi.runAllTimers(); expect(f.store.list()).toEqual([]);
  f.drop(); expect(f.checkpoint.keepForLater()).toBe(false); expect(f.checkpoint.id()).toBeDefined();
  f.drop(false);
  // A storage implementation that silently dropped the write cannot pass read-back.
  f.checkpoint.suspend(); f.checkpoint.begin(values());
  const id = f.checkpoint.id(); expect(f.checkpoint.keepForLater()).toBe(true);
  expect(f.checkpoint.id()).toBeUndefined(); expect(f.store.get(id!)?.values.text).toBe('  Call\n Ada  ');
});

it('flushes the latest fields immediately and refuses to overwrite or discard a newer revision', () => {
  vi.useFakeTimers(); const f = setup(), initial = values();
  f.checkpoint.begin(initial); f.checkpoint.capture({ ...initial, text: 'Latest input' });
  expect(f.checkpoint.flush()).toBe(true);
  const kept = f.store.list()[0]!; expect(kept.values.text).toBe('Latest input');
  const newer = { ...kept, revision: kept.revision + 1, values: { ...kept.values, text: 'Newer copy' } };
  expect(f.store.save(newer)).toBe(true); f.checkpoint.capture({ ...initial, text: 'Stale input' });
  expect(f.checkpoint.flush()).toBe(false); expect(f.checkpoint.keepForLater()).toBe(false);
  expect(f.checkpoint.discard()).toBe(false); expect(f.store.get(kept.id)).toEqual(newer);
  f.checkpoint.suspend();
});

it('blocks the first dispatch on storage failure and persists the exact pending request before returning its ticket', () => {
  const f = setup(), attempt = pending();
  f.checkpoint.begin(attempt.values); f.block();
  expect(f.checkpoint.startAttempt(attempt.values)?.blocked).toBe(true); expect(f.store.list()).toEqual([]);
  f.block(false); const ticket = f.checkpoint.startAttempt(attempt.values)!;
  expect(ticket.blocked).toBeUndefined();
  expect(f.store.get(ticket.id)).toMatchObject({ status: 'pending', attempt: ticket.attempt, revision: ticket.revision, values: attempt.values });
  f.checkpoint.suspend();
});

it('fences late replies and confirms only the matching replay without changing its request', () => {
  const f = setup(), attempt = pending();
  f.checkpoint.begin(attempt.values); const old = f.checkpoint.startAttempt(attempt.values)!;
  f.checkpoint.settle(old, 'unknown'); const unknown = f.store.get(old.id)!;
  expect(unknown.status).toBe('unknown'); expect(unknown.values.request).toEqual(attempt.values.request);
  const resumed = createReminderDraftCheckpoint({ store: f.store, now: () => now, changed() {} });
  resumed.begin(unknown.values, unknown); const next = resumed.startAttempt(unknown.values)!;
  f.checkpoint.settle(old, 'confirmed'); expect(f.store.get(old.id)?.attempt).toBe(next.attempt);
  resumed.settle(next, 'confirmed'); expect(f.store.list()).toEqual([]);
  f.checkpoint.suspend(); resumed.suspend();
});

it('retains an unknown request when confirmation cleanup fails and permits editing only after a definite refusal', () => {
  const f = setup(), attempt = pending(); f.checkpoint.begin(attempt.values);
  const ticket = f.checkpoint.startAttempt(attempt.values)!; f.block();
  f.checkpoint.settle(ticket, 'confirmed'); expect(f.checkpoint.status()).toBe('unknown');
  f.block(false); expect(f.checkpoint.keepForLater()).toBe(true);
  const kept = f.store.get(ticket.id)!; expect(kept.status).toBe('unknown'); expect(kept.values.request).toEqual(attempt.values.request);
  f.checkpoint.begin(kept.values, kept); const retry = f.checkpoint.startAttempt(kept.values)!;
  f.checkpoint.settle(retry, 'refused'); expect(f.store.get(ticket.id)).toMatchObject({ status: 'editing', values: { request: null } });
  expect(f.checkpoint.discard()).toBe(true); expect(f.store.list()).toEqual([]);
});

it('finds reminder and alarm input under Drafts, hides opaque IDs, and refuses stale search selections', () => {
  const f = setup(), entry = row(), alarm = { ...row(), values: { ...values(), kind: 'alarm' as const, text: 'Take medicine' } };
  expect(f.store.save(entry)).toBe(true); expect(f.store.save(alarm)).toBe(true);
  const stores = { reminder: f.store };
  expect(searchRecoveryDrafts(stores, 'call 2026-11-01 new_york').matches).toHaveLength(1);
  expect(searchRecoveryDrafts(stores, entry.values.creationId).matches).toEqual([]);
  const match = searchRecoveryDrafts(stores, 'alarm medicine').matches[0]!;
  expect(recoveryDraftLabel(match)).toBe('Alarm'); expect(resolveRecoveryDraft(stores, match)).toEqual(alarm);
  const html = renderUniversalSearch({ query: 'medicine', actionAttr: 'data-action', resultType: 'draft', recoveryDraftSearch: searchRecoveryDrafts(stores, 'medicine') });
  expect(html).toContain('Resume alarm draft Take medicine');
  expect(f.store.save({ ...alarm, values: { ...alarm.values, text: 'Changed at the same revision' } })).toBe(true);
  expect(resolveRecoveryDraft(stores, match)).toBeNull();
});
