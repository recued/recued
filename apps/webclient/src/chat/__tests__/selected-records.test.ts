import { expect, it, vi } from 'vitest';
import { selectedRecordsWire, readSelectedRecordsWire, copySelectedRecords, verifySelectedRecord } from '../selected-records.js';
import { recordChatMessage, readRecordChatMessage, withSelectedRecords, selectedRecordsOf, baseRecordContext, withoutBaseRecordContext, recordContextFromRecovery, recordContextRecovery } from '../record-context.js';
import { copyComposerRecoveryDraft, hasComposerRecoveryDraft, hasProtectedChatRecoveryDraft } from '../draft-recovery.js';
import { formatChatMarkdownExport } from '../transcript-export.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../../shell/route.js';
import type { PreparedRecordLink } from '../../data/record-link-insert.js';

const work = (id = 'one'): PreparedRecordLink => ({ reference: { key: id, target: { tab: 'note', id, hash: serializeShellRoute('data', 'note', id) }, identity: JSON.stringify(['note', id, 'recued.note', null, 1]), href: 'https://app.test/client/?pair=private', title: 'Café <img src=x> ' + id, details: ['Private field contents must not leave as context'] } });
const source = (slug: string, kind: 'mail' | 'calendar' = 'mail'): PreparedRecordLink => {
  const target = { tab: kind, collectionSlug: slug, recordId: 'same/id?二', hash: serializeSourceRecordAddress({ tab: kind, collectionSlug: slug, recordId: 'same/id?二' }) };
  return { reference: { key: slug, target, identity: JSON.stringify([kind, slug, target.recordId, 'provider-row', 2]), title: slug + ' record', details: ['Private message metadata'], href: target.hash } };
};
const contact: PreparedRecordLink = { reference: { key: 'contact', target: { tab: 'contact', id: 'cid', hash: '#data/contact/cid' }, title: 'Selected person', details: ['Private phone number'], identity: JSON.stringify(['contact', 'cid', 1]), href: '#data/contact/cid' } };
const task: PreparedRecordLink = { reference: { ...work().reference, target: { tab: 'task', id: 'task', hash: '#data/task/task' }, identity: JSON.stringify(['task', 'task', 'recued.task', 'source-row', 1]) } };

it('carries all five exact record kinds and distinguishes matching provider ids in different accounts, without bodies or pairing data', () => {
  const records = [contact, task, work('note/二'), source('work'), source('home'), source('work', 'calendar')];
  const context = withSelectedRecords(null, records)!; const message = recordChatMessage('Compare these records.', context), parsed = readRecordChatMessage(message)!;
  expect(parsed.question).toBe('Compare these records.'); expect(selectedRecordsOf(parsed.context).map(row => [row.reference.target, row.reference.identity, row.reference.title])).toEqual(records.map(row => [row.reference.target, row.reference.identity, row.reference.title]));
  expect(message).toContain('recued.records_question'); expect(message).not.toContain('Private'); expect(message).not.toContain('pair=private');
  expect(recordChatMessage(parsed.question, parsed.context)).toBe(message);
});

it('preserves a legacy contact context beside selected records and recovers independent draft snapshots', () => {
  const legacy = { kind: 'contact' as const, id: 'cid', name: 'Person', email: 'person@example.test' };
  const first = work(); first.shortcut = { kind: 'note', id: 'one', title: 'Pinned', source_id: 'recued.note', source_label: 'Recued', created_at: 1, source_record_id: null };
  const context = withSelectedRecords(legacy, [first])!, recovery = { text: 'Question', protected: false, modelSourceId: null, ...recordContextRecovery(context) };
  expect(hasComposerRecoveryDraft(recovery)).toBe(true); expect(hasProtectedChatRecoveryDraft({ ...recovery, text: '' })).toBe(true);
  const copied = copyComposerRecoveryDraft(recovery); copied.selectedRecords![0]!.reference.details.push('changed');
  expect(first.reference.details).not.toContain('changed'); expect(recovery.selectedRecords![0]!.reference.details).not.toContain('changed');
  expect(Object.hasOwn(copied.selectedRecords![0]!.shortcut!, 'source_record_id')).toBe(true);
  const restored = recordContextFromRecovery(recovery)!;
  expect(baseRecordContext(restored)).toEqual(legacy); expect(selectedRecordsOf(restored)[0]?.reference.identity).toBe(first.reference.identity);
  expect(baseRecordContext(withoutBaseRecordContext(restored))).toBeNull(); expect(selectedRecordsOf(withoutBaseRecordContext(restored))).toHaveLength(1); expect(withSelectedRecords(restored, [])).toEqual(legacy);
  const parsed = readRecordChatMessage(recordChatMessage('Question', restored))!; expect(baseRecordContext(parsed.context)).toMatchObject({ kind: 'contact', id: 'cid' }); expect(selectedRecordsOf(parsed.context)).toHaveLength(1);
  const onlyRecords = { text: '', protected: false, modelSourceId: null, selectedRecords: [work()] }; expect(hasComposerRecoveryDraft(onlyRecords)).toBe(true); expect(hasProtectedChatRecoveryDraft(onlyRecords)).toBe(true);
});

it('keeps strong pinned account references through wire round trips and checks them again', async () => {
  const record = source('work', 'calendar'); record.shortcut = { kind: 'calendar', id: JSON.stringify(['work', 'same/id?二']), title: 'Event', source_label: 'Work', origin: { kind: 'calendar', slug: 'work', recordId: 'same/id?二', sourceId: 'provider-row', receivedAt: 2, incarnation: 'calendar-one', label: 'Event' } };
  const recovered = readSelectedRecordsWire(selectedRecordsWire(copySelectedRecords([record])))![0]!;
  const read = vi.fn();
  const calendar = vi.fn(async () => ({ event: { record_id: 'same/id?二', source_id: 'provider-row' }, record: { record_id: 'same/id?二', source_id: 'provider-row', received_at: 2 }, incarnation: 'replacement' }));
  await expect(verifySelectedRecord(recovered, { calendar: calendar as never, source: read }, 'https://app.test/client/')).rejects.toThrow('unavailable'); expect(read).not.toHaveBeenCalled();
  const copied = copySelectedRecords([record]); if (copied[0]!.shortcut && 'origin' in copied[0]!.shortcut) copied[0]!.shortcut.origin.label = 'different';
  expect(record.shortcut.origin.label).toBe('Event');
});

it('rejects malformed or ambiguous reference packets instead of presenting them as selected records', () => {
  const packet = JSON.parse(selectedRecordsWire([work()]));
  for (const rows of [[], Array.from({ length: 21 }, () => packet[0]), [packet[0], packet[0]], [{ ...packet[0], record: { ...packet[0].record, id: '' } }], [{ ...packet[0], shortcut: { kind: 'note', id: 'other' } }], [{ ...packet[0], record: { kind: 'file', id: 'not-supported' } }]]) expect(readSelectedRecordsWire(JSON.stringify(rows))).toBeNull();
  const bad = work(); bad.reference.target.hash = '#data/note/someone-else'; expect(() => selectedRecordsWire([bad])).toThrow();
  const mismatched = work(); mismatched.reference.identity = JSON.stringify(['note', 'other-id', 'recued.note', null, 1]); expect(() => selectedRecordsWire([mismatched])).toThrow();
  const message = recordChatMessage('Question', withSelectedRecords(null, [work()])!); expect(readRecordChatMessage(message.replace('"version":1', '"version":2'))).toBeNull(); expect(readSelectedRecordsWire(undefined)).toBeNull();
});

it('exports the question and exact selected links as readable Markdown while retaining literal labels safely', () => {
  const message = recordChatMessage('Compare the note.', withSelectedRecords(null, [work()])!);
  const bundle = { session: { id: 's', title: 'Context' }, exported_at: 2, messages: [{ id: 'u', session_id: 's', role: 'user', content: message, ts: 1 }] };
  const md = formatChatMarkdownExport(bundle, { sessionId: 's', baseUrl: 'https://app.test/client/?pair=private' });
  expect(md).toContain('Compare the note.'); expect(md).toContain('### Selected records'); expect(md).toContain('https://app.test/client/#data/note/one'); expect(md).not.toContain('recued.records_question'); expect(md).not.toContain('pair=private'); expect(md).not.toContain('<img src=x>');
});
