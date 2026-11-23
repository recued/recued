import { expect, it, vi } from 'vitest';
import type { MailMessageSnapshot, WorkEntity } from '@recued/contracts';
import { recordLinkShortcuts, verifyRecordLinkShortcut } from '../record-link-shortcuts.js';
import { LINK_KINDS } from '../record-link-insert.js';
import { createPinnedRecords } from '../pinned-records.js';
import { createRecentWorkRecords, recentSourceRecord, type RecentSourceOrigin, type RecentWorkEntityRecord } from '../recent-work-records.js';
import { serializeSourceRecordAddress } from '../../shell/route.js';

const task: Extract<WorkEntity, { _kind: 'task' }> = { _kind: 'task', id: 'task/二', title: 'Fresh title', done: false, blocks_task_ids: [],
  source_id: 'remote.task', source_record_id: 'provider-one', created_at: 1, updated_at: 2, last_seen_at: 2, sync_state: 'live', conflict_policy: 'recued_wins' };
const work: RecentWorkEntityRecord = { kind: 'task', id: task.id, title: 'Cached title', source_id: task.source_id, source_record_id: task.source_record_id!, source_label: 'Remote', created_at: 1 };
const mailOrigin = (slug = 'work'): Extract<RecentSourceOrigin, { kind: 'mail' }> => ({ kind: 'mail', slug, recordId: 'same/id?二', receivedAt: 1, identity: null, label: 'Email ' + slug });

it('reads the existing scoped lists, puts pins first, deduplicates exact references, and excludes the edited record', () => {
  const pinned = createPinnedRecords({ scope: 'a', storage: null }), recent = createRecentWorkRecords({ scope: 'a', storage: null });
  pinned.pin(work); recent.remember(work);
  const own = { ...work, kind: 'note' as const, id: 'editor' }; pinned.pin(own); recent.remember(own);
  recent.remember(recentSourceRecord(mailOrigin(), 'Mailbox')!); recent.remember(recentSourceRecord(mailOrigin('home'), 'Mailbox')!);
  recent.remember(recentSourceRecord({ kind: 'contact', id: 'canonical-contact', createdAt: 1, label: 'Riley' }, 'Contacts')!);
  recent.remember(recentSourceRecord({ kind: 'calendar', slug: 'work', recordId: 'occurrence/二', sourceId: 'event', receivedAt: 1, incarnation: 'enrollment', label: 'Planning' }, 'Calendar')!);
  const before = { pinned: pinned.list(), recent: recent.list() };
  const deps = { pinned, recent, kinds: LINK_KINDS, filter: 'all' as const, current: { kind: 'note' as const, id: 'editor' } };
  const groups = recordLinkShortcuts(deps);
  expect(groups.map(group => group.label)).toEqual(['Pinned', 'Recently opened']);
  expect(groups.flatMap(group => group.options).map(option => option.shortcut?.kind)).toEqual(['task', 'calendar', 'contact', 'mail', 'mail']);
  const mail = groups[1]!.options.filter(option => option.target.tab === 'mail');
  expect(mail.map(option => option.target.hash)).toEqual(['home', 'work'].map(collectionSlug => serializeSourceRecordAddress({ tab: 'mail', collectionSlug, recordId: mailOrigin().recordId })));
  expect(mail.map(option => option.detail)).toEqual(['Email · Mailbox · Account: home', 'Email · Mailbox · Account: work']);
  expect(recordLinkShortcuts({ ...deps, filter: 'contact' }).flatMap(group => group.options)).toHaveLength(1);
  expect({ pinned: pinned.list(), recent: recent.list() }).toEqual(before);
});

it('keeps reused lifetimes distinct and verifies a pinned provider row before inserting its link', async () => {
  const pinned = { list: () => [work] }, recent = { list: () => [{ ...work, created_at: 3 }] };
  expect(recordLinkShortcuts({ pinned, recent, kinds: ['task'], filter: 'all' }).flatMap(group => group.options)).toHaveLength(2);
  const read = vi.fn(async () => ({ entity: task }));
  await expect(verifyRecordLinkShortcut(work, { work: read })).resolves.toBe(true); expect(read).toHaveBeenCalledExactlyOnceWith('task', task.id);
  for (const entity of [null, { ...task, created_at: 3 }, { ...task, source_record_id: 'replacement' }, { ...task, source_id: 'other' },
    { ...task, deleted_at: 3 }, { ...task, sync_state: 'tombstoned' as const }, { ...task, sync_state: 'orphaned' as const }]) {
    await expect(verifyRecordLinkShortcut(work, { work: async () => ({ entity }) })).resolves.toBe(false);
  }
  await expect(verifyRecordLinkShortcut(work, {})).resolves.toBe(false);
});

it('confirms mail in its exact account and then rejects a missing or replaced collection record', async () => {
  const origin = mailOrigin('home'), record = recentSourceRecord(origin, 'Mailbox')!;
  const message: MailMessageSnapshot = { slug: 'home', record_id: origin.recordId, received_at: 1, from: 'riley@example.test', to: [], cc: [], subject: 'Fresh',
    body: 'Private body', body_truncated: false, read: 'stored', reply: null };
  const mail = vi.fn(async () => message), current = { record_id: origin.recordId, source_id: 'provider', received_at: 1, modified_at: 1, size_bytes: 0, hot_fields: {} };
  const source = vi.fn(async () => ({ record: current }));
  await expect(verifyRecordLinkShortcut(record, { mail, source })).resolves.toBe(true);
  expect(mail).toHaveBeenCalledExactlyOnceWith({ slug: 'home', record_id: origin.recordId });
  expect(source).toHaveBeenCalledExactlyOnceWith({ platform: 'mail', slug: 'home', record_id: origin.recordId });
  for (const value of [null, { ...current, received_at: 3 }, { ...current, record_id: 'other' }])
    await expect(verifyRecordLinkShortcut(record, { mail, source: async () => ({ record: value }) })).resolves.toBe(false);
  const wrongAccount = vi.fn(async () => ({ ...message, slug: 'work' })); source.mockClear();
  await expect(verifyRecordLinkShortcut(record, { mail: wrongAccount, source })).rejects.toThrow('different identity'); expect(source).not.toHaveBeenCalled();
});
