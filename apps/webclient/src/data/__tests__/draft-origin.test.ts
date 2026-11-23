import { expect, it, vi } from 'vitest';
import type { CalendarEventSnapshot, ContactRecord, MailMessageSnapshot, WorkEntity } from '@recued/contracts';
import { checkDraftOrigin, draftOriginHash, readDraftOrigin, type DraftOrigin } from '../draft-origin.js';
import { createWorkDraftCheckpoint, createWorkRecoveryStore } from '../work-draft-recovery.js';
import { createNoteDraftCheckpoint, createNoteRecoveryStore } from '../note-draft-recovery.js';
import { parseShellRoute, parseSourceRecordAddress } from '../../shell/route.js';

const now = 1_800_000_000_000;
const contact: ContactRecord = { _id: 'riley@example.test', _collection: 'contact', contact_id: 'person/二', email: 'riley@example.test',
  name: 'Riley', source: 'manual', first_seen: 1, last_interaction: 1, interaction_count: 0, created_at: 1, updated_at: 2 };
const origin: DraftOrigin = { kind: 'contact', id: contact.contact_id!, createdAt: 1, label: '<img src=x> Riley' };

it('round trips context with draft fields through checkpoints, including source changes and uncertain saves', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  for (const kind of ['task', 'note'] as const) {
    const store = kind === 'task' ? createWorkRecoveryStore({ kind, scope: 'pair-a', storage, now: () => now }) : createNoteRecoveryStore({ scope: 'pair-a', storage, now: () => now });
    const checkpoint = kind === 'task' ? createWorkDraftCheckpoint({ kind, store: store as ReturnType<typeof createWorkRecoveryStore>, now: () => now })
      : createNoteDraftCheckpoint({ store: store as ReturnType<typeof createNoteRecoveryStore>, now: () => now });
    checkpoint.begin(`recued.${kind}`, {}, null); checkpoint.setOrigin(origin);
    checkpoint.capture(`other.${kind}`, { title: 'Reviewed context', body: 'Unfinished words' }); checkpoint.flush();
    const ticket = checkpoint.startAttempt()!; checkpoint.settle(ticket, false); checkpoint.suspend();
    const row = store.list()[0]!;
    expect(row).toMatchObject({ origin, sourceId: `other.${kind}`, values: { title: 'Reviewed context', body: 'Unfinished words' }, status: 'unknown' });
    const other = kind === 'task' ? createWorkRecoveryStore({ kind, scope: 'pair-b', storage, now: () => now }) : createNoteRecoveryStore({ scope: 'pair-b', storage, now: () => now });
    expect(other.list()).toEqual([]);
    const raw = [...values.entries()].find(([key]) => key.includes(`recued.${kind}.`))!;
    const malformed = JSON.parse(raw[1]); malformed[0].origin = { kind: 'contact', id: 'forged', createdAt: -1, label: 'Bad' };
    values.set(raw[0], JSON.stringify(malformed));
    expect(store.list()[0]!.origin).toBeUndefined(); expect(store.list()[0]!.values.body).toBe('Unfinished words');
  }
});

it('reconstructs only internal canonical addresses, preserving opaque IDs and mailbox qualification', () => {
  expect(parseShellRoute(draftOriginHash(origin)).segments).toEqual(['contact', contact.contact_id]);
  const source: DraftOrigin = { kind: 'mail', slug: 'work', recordId: "id/shared?二.)!'*", receivedAt: 1, identity: 'mail-1', label: 'Mail' };
  expect(parseSourceRecordAddress(parseShellRoute(draftOriginHash(source)))).toMatchObject({ tab: 'mail', collectionSlug: 'work', recordId: source.recordId });
  expect(readDraftOrigin({ ...source, href: 'https://evil.test/', method: 'delete', label: 'Mail' })).toEqual(source);
  for (const bad of [{ ...source, kind: 'files' }, { ...source, slug: 'work\n' }, { ...source, receivedAt: -1 },
    { ...origin, label: 'x'.repeat(513) }, { ...source, conversation: { incarnation: 'a', thread_id: 3 } }]) expect(readDraftOrigin(bad)).toBeUndefined();
});

it('checks canonical contacts without following a merge or accepting a reused identity', async () => {
  const get = vi.fn(async (_id: string) => ({ contact }));
  await expect(checkDraftOrigin(origin, { contact: get })).resolves.toMatchObject({ kind: 'contact', reply: { contact } });
  expect(get).toHaveBeenCalledWith(contact.contact_id);
  for (const current of [null, { ...contact, contact_id: 'other' }, { ...contact, created_at: 3 }, { ...contact, merged_into: 'survivor@example.test' }])
    await expect(checkDraftOrigin(origin, { contact: async () => ({ contact: current }) })).rejects.toThrow('Your draft is still here');
});

it('checks note source, provider identity and lifetime before opening its current text', async () => {
  const note: Extract<WorkEntity, { _kind: 'note' }> = { _kind: 'note', id: 'note-one', source_id: 'recued.note', source_record_id: 'native-1',
    title: 'New title', body: 'Current text', created_at: 1, updated_at: 2, last_seen_at: 2, last_user_action_at: 2, sync_state: 'live', conflict_policy: 'recued_wins',
    related_contact_ids: [], related_project_ids: [], related_mail_thread_ids: [], related_calendar_event_ids: [] };
  const from: DraftOrigin = { kind: 'note', id: note.id, sourceId: note.source_id, sourceRecordId: 'native-1', createdAt: 1, label: 'Old title' };
  await expect(checkDraftOrigin(from, { note: async () => ({ entity: note }) })).resolves.toMatchObject({ reply: { entity: { title: 'New title' } } });
  for (const value of [null, { ...note, source_id: 'other.note' }, { ...note, source_record_id: 'native-2' }, { ...note, created_at: 4 }, { ...note, deleted_at: 5 }])
    await expect(checkDraftOrigin(from, { note: async () => ({ entity: value }) })).rejects.toThrow('different identity');
});

it('binds email reads to the original mailbox, message and observed enrollment identity', async () => {
  const from: DraftOrigin = { kind: 'mail', slug: 'work', recordId: 'shared-id', receivedAt: 1, identity: 'enrollment-message-1', label: 'Subject' };
  const message: MailMessageSnapshot = { slug: 'work', record_id: 'shared-id', received_at: 1, from: 'riley@example.test', to: [], cc: [], subject: 'Renamed', body: '', body_truncated: false, read: 'stored', reply: null,
    state: { identity: from.identity, verified: true, is_read: true, is_flagged: false, can_mark: false, can_flag: false } };
  const get = vi.fn(async () => message);
  await expect(checkDraftOrigin(from, { mail: get })).resolves.toMatchObject({ message }); expect(get).toHaveBeenCalledWith({ slug: 'work', record_id: 'shared-id' });
  for (const changed of [{ ...message, slug: 'home' }, { ...message, record_id: 'other' }, { ...message, received_at: 2 }, { ...message, state: { ...message.state!, identity: 'replacement' } }])
    await expect(checkDraftOrigin(from, { mail: async () => changed })).rejects.toThrow('different identity');
});

it('checks the exact calendar occurrence and enrollment even when provider IDs match in two accounts', async () => {
  const from: DraftOrigin = { kind: 'calendar', slug: 'work', recordId: 'occurrence/二', sourceId: 'same-provider-id', receivedAt: 1, incarnation: 'work-1', label: 'Planning' };
  const snapshot: CalendarEventSnapshot = { event: { record_id: from.recordId, source_id: from.sourceId, calendar_id: 'work', calendar_name: 'Planning',
    summary: 'Fresh title', description: '', location: '', updated_at: 2, start_at: 1, end_at: 2, timezone: 'UTC', is_all_day: false, is_recurring: true, status: 'confirmed' },
    record: { record_id: from.recordId, source_id: from.sourceId, received_at: 1, modified_at: 2, size_bytes: 0, hot_fields: {} },
    resource_version: 'v2', incarnation: 'work-1', editable: false };
  const get = vi.fn(async () => snapshot);
  await expect(checkDraftOrigin(from, { calendar: get })).resolves.toMatchObject({ snapshot });
  expect(get).toHaveBeenCalledWith({ slug: 'work', source_id: 'same-provider-id' });
  for (const changed of [{ ...snapshot, incarnation: 'home-1' }, { ...snapshot, event: { ...snapshot.event, record_id: 'different-occurrence' } },
    { ...snapshot, record: { ...snapshot.record, received_at: 3 } }, { ...snapshot, record: { ...snapshot.record, source_id: 'different-provider-id' } }])
    await expect(checkDraftOrigin(from, { calendar: async () => changed })).rejects.toThrow('different identity');
});
