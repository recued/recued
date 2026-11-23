import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '@recued/contracts';
import { createNoteDraftCheckpoint, createNoteRecoveryStore, noteDraftMatchesOriginal, noteDraftOriginal, noteDraftValues,
  NOTE_RECOVERY_LIMITS, parseNoteRecovery, type NoteRecoveryEntry, type NoteRecoveryStorage } from '../note-draft-recovery.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const memory = () => {
  const values = new Map<string, string>();
  const storage: NoteRecoveryStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  return { values, storage };
};
const entry = (): NoteRecoveryEntry => ({ id: `ndr_${crypto.randomUUID()}`, revision: 1, updatedAt: now,
  sourceId: 'recued.note', original: null, status: 'editing', values: noteDraftValues({ title: 'Draft', body: '\r\nCafé 😀 <script>literal</script>\r\n',
    related_contact: ['person@example.test'], related_project: ['project-1'] }) });
const savedNote = (): Note => ({ id: 'note-1', source_id: 'recued.note', source_record_id: 'source-note-1',
  title: 'Saved', body: 'Original body', created_at: now - 1000, updated_at: now, last_seen_at: now, last_user_action_at: now,
  sync_state: 'live', conflict_policy: 'recued_wins', related_contact_ids: ['a', 'b'], related_calendar_event_ids: [], related_mail_thread_ids: [], related_project_ids: [] });
afterEach(() => vi.useRealTimers());

describe('same-tab note recovery', () => {
  it('round trips only canonical text and links, clones reads, and isolates pairing scopes', () => {
    const { storage } = memory(), a = createNoteRecoveryStore({ scope: 'pair-a', storage, now: () => now });
    const row = entry();
    expect(a.save({ ...row, values: { ...row.values, arbitrary_rpc: 'must not survive' } } as NoteRecoveryEntry)).toBe(true);
    expect(a.get(row.id)).toEqual(row);
    a.get(row.id)!.values.related_project.push('not saved');
    expect(a.get(row.id)!.values.related_project).toEqual(['project-1']);
    expect(createNoteRecoveryStore({ scope: 'pair-b', storage, now: () => now }).list()).toEqual([]);
    expect(createNoteRecoveryStore({ scope: 'pair-a', storage, now: () => now }).get(row.id)!.values.body).toBe(row.values.body);
  });

  it('rejects expired, mismatched, malformed, and unbound submitted copies at the storage boundary', () => {
    const row = entry(), original = noteDraftOriginal(savedNote());
    expect(parseNoteRecovery({ ...row, original }, now)).toEqual({ ...row, original });
    expect(parseNoteRecovery({ ...row, original: { ...original, sourceId: 'another-source' } }, now)).toBeNull();
    expect(parseNoteRecovery({ ...row, status: 'pending' }, now)).toBeNull();
    expect(parseNoteRecovery({ ...row, values: { ...row.values, related_contact: [{ id: 'invented' }] } }, now)).toBeNull();
    expect(parseNoteRecovery(row, now + NOTE_RECOVERY_LIMITS.age + 1)).toBeNull();
    expect(parseNoteRecovery({ ...row, updatedAt: now + 60_001 }, now)).toBeNull();
  });

  it('preserves earlier copies when full or when reads and writes fail', () => {
    const { storage, values } = memory(), store = createNoteRecoveryStore({ scope: 'a', storage, now: () => now });
    const first = entry(); expect(store.save(first)).toBe(true);
    for (let count = 1; count < NOTE_RECOVERY_LIMITS.entries; count++) expect(store.save(entry())).toBe(true);
    const before = [...values];
    expect(store.save(entry())).toBe(false); expect([...values]).toEqual(before);
    const unreadable = createNoteRecoveryStore({ scope: 'a', storage: { ...storage, getItem: () => { throw new Error('blocked'); } }, now: () => now });
    expect(unreadable.save(entry())).toBe(false); expect(unreadable.remove(first.id)).toBe(false); expect([...values]).toEqual(before);
    const quota = createNoteRecoveryStore({ scope: 'a', storage: { ...storage, setItem: () => { throw new Error('quota'); } }, now: () => now });
    expect(quota.save({ ...first, values: { ...first.values, body: 'latest' } })).toBe(false); expect([...values]).toEqual(before);
  });

  it('debounces typing, flushes the latest text and links on suspension, and never checkpoints an untouched editor', () => {
    vi.useFakeTimers(); const { storage } = memory();
    const store = createNoteRecoveryStore({ scope: 'a', storage, now: () => now });
    const checkpoint = createNoteDraftCheckpoint({ store, now: () => now });
    checkpoint.begin('recued.note', {}, null); checkpoint.flush(); expect(store.list()).toEqual([]);
    checkpoint.capture('recued.note', { body: 'first' }); vi.advanceTimersByTime(200);
    checkpoint.capture('recued.note', { body: 'latest', related_project: ['project-2'] }); expect(store.list()).toEqual([]);
    checkpoint.suspend(); expect(store.list()[0]!.values).toEqual(noteDraftValues({ body: 'latest', related_project: ['project-2'] }));
    checkpoint.begin('recued.note', {}, null); vi.advanceTimersByTime(1000); expect(store.list()).toHaveLength(1);
    expect(checkpoint.message()).toBe('Unfinished notes are kept in this tab.');
  });

  it('keeps a reverted edit current and reports a failed checkpoint without losing its earlier copy', () => {
    vi.useFakeTimers(); const { storage } = memory(); let full = false;
    const store = createNoteRecoveryStore({ scope: 'a', storage: { ...storage, setItem: (key, value) => { if (full) throw new Error('quota'); storage.setItem(key, value); } }, now: () => now });
    const original = noteDraftOriginal(savedNote()), checkpoint = createNoteDraftCheckpoint({ store, now: () => now });
    checkpoint.begin(original.sourceId, original.values, original);
    checkpoint.capture(original.sourceId, { ...original.values, body: 'edited' }); vi.advanceTimersByTime(300);
    expect(checkpoint.message()).toBe('Changes kept in this tab.');
    checkpoint.capture(original.sourceId, original.values); checkpoint.flush(); expect(store.list()[0]!.values.body).toBe('Original body');
    full = true; checkpoint.capture(original.sourceId, { ...original.values, body: 'latest' }); checkpoint.flush();
    expect(checkpoint.message()).toContain('Latest edits could not be kept'); expect(store.list()[0]!.values.body).toBe('Original body');
    expect(checkpoint.startAttempt()!.blocked).toBe(true);
    full = false; expect(checkpoint.discard()).toBe(true); expect(store.list()).toEqual([]);
  });

  it('retains an interrupted save and fences late responses from a newer save attempt', () => {
    const { storage } = memory(), store = createNoteRecoveryStore({ scope: 'a', storage, now: () => now });
    const checkpoint = createNoteDraftCheckpoint({ store, now: () => now }); checkpoint.begin('recued.note', {}, null);
    checkpoint.capture('recued.note', { body: 'draft' });
    const first = checkpoint.startAttempt()!; checkpoint.suspend();
    const pending = createNoteRecoveryStore({ scope: 'a', storage, now: () => now }).get(first.id)!;
    expect(pending.status).toBe('pending');
    checkpoint.begin('recued.note', {}, null, pending);
    const next = checkpoint.startAttempt()!;
    checkpoint.settle(first, true); expect(store.get(next.id)!.attempt).toBe(next.attempt);
    checkpoint.settle(next, false, 'created-note'); expect(store.get(next.id)).toMatchObject({ status: 'unknown', savedId: 'created-note' });
    const retry = checkpoint.startAttempt()!; checkpoint.settle(retry, true); expect(store.list()).toEqual([]);
  });

  it('settles a departed editor without deleting later edits or another note draft', () => {
    const { storage } = memory(), store = createNoteRecoveryStore({ scope: 'a', storage, now: () => now });
    const checkpoint = createNoteDraftCheckpoint({ store, now: () => now }); checkpoint.begin('recued.note', {}, null);
    checkpoint.capture('recued.note', { body: 'submitted' }); const ticket = checkpoint.startAttempt()!;
    checkpoint.capture('recued.note', { body: 'typed while saving' }); checkpoint.flush();
    checkpoint.settle(ticket, true, 'saved-note'); expect(store.get(ticket.id)).toMatchObject({ status: 'unknown', values: { body: 'typed while saving' } });
    checkpoint.suspend(); checkpoint.begin('recued.note', {}, null); checkpoint.capture('recued.note', { body: 'another draft' }); checkpoint.flush();
    checkpoint.settle(ticket, true); expect(store.list().map(row => row.values.body)).toContain('another draft');
    checkpoint.suspend();
  });

  it('checks note identity and content as well as timestamps before restoring', () => {
    const note = savedNote(), base = noteDraftOriginal(note);
    expect(noteDraftMatchesOriginal(base, { ...note, last_user_action_at: now + 500, related_contact_ids: ['b', 'a'] })).toBe(true);
    for (const patch of [{ body: 'changed with the same timestamp' }, { source_id: 'another-source' }, { source_record_id: 'reused-id' }, { created_at: now + 1 }, { updated_at: now + 1 }]) {
      expect(noteDraftMatchesOriginal(base, { ...note, ...patch })).toBe(false);
    }
  });
});
