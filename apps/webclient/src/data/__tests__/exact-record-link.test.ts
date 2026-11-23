import { expect, it, vi } from 'vitest';
import type { ContactRecord, WorkEntity } from '@recued/contracts';
import { limitRecordLinkQuery, parseRecordLinkQuery, readExactRecordLink, verifyExactRecordLink } from '../exact-record-link.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../../shell/route.js';
import type { WorkReaderLink } from '../task-note-source.js';
const client = 'https://app.test/client/index.html?pair=private#data/search';
const task: Extract<WorkEntity, { _kind: 'task' }> = { _kind: 'task', id: 'task/二', title: 'Current task', done: false, blocks_task_ids: [],
  body: 'Do not retain private body', source_id: 'remote.task', source_record_id: 'provider-one', created_at: 1, updated_at: 2, last_seen_at: 2, sync_state: 'live', conflict_policy: 'recued_wins' };
const target: WorkReaderLink = { tab: 'task', id: task.id, hash: serializeShellRoute('data', 'task', task.id) };
const contact: ContactRecord = { _id: 'riley@example.test', _collection: 'contact', email: 'riley@example.test', contact_id: 'canonical-contact', name: 'Riley',
  source: 'manual', created_at: 1, updated_at: 1, first_seen: 1, last_interaction: 1, interaction_count: 0 };

it('recognizes supported exact record kinds in this deployment and leaves ordinary terms as text', () => {
  for (const tab of ['contact', 'task', 'note', 'commitment', 'mail', 'calendar'] as const) {
    const hash = tab === 'mail' || tab === 'calendar' ? serializeSourceRecordAddress({ tab, collectionSlug: 'Account/二', recordId: 'same/id?二' }) : serializeShellRoute('data', tab, 'id/二?');
    expect(parseRecordLinkQuery('  https://app.test/client/index.html' + hash + '  ', client)).toMatchObject({ kind: 'link', target: { tab, hash } });
    expect(parseRecordLinkQuery(hash, client)).toMatchObject({ kind: 'link', target: { tab, hash } });
  }
  for (const text of ['Riley', 'from:riley@example.test', 'quarterly review', 'design/api', '/Projects/agenda.md']) expect(parseRecordLinkQuery(text, client)).toEqual({ kind: 'text' });
});
it('refuses foreign, credentialed, parameterized, malformed and editor links before any record lookup', () => {
  for (const value of ['https://other.test/client/index.html#data/task/one', 'https://app.test/other/#data/task/one', 'https://user:secret@app.test/client/index.html#data/task/one',
    'https://app.test/client/index.html?pair=private#data/task/one', '#data/task/%broken', '#data/task/', '#data/task/new/edit', '#data/mail/unqualified',
    'javascript:alert(1)', 'data:text/html,private', 'file:///client/index.html#data/task/one', 'https://' + 'x'.repeat(65_536)])
    expect(parseRecordLinkQuery(value, client).kind).toBe('invalid');
});
it('keeps long encoded record addresses intact while retaining the text-search limit', () => {
  const hash = serializeShellRoute('data', 'note', '二'.repeat(120)); expect(hash.length).toBeGreaterThan(200);
  expect(limitRecordLinkQuery(hash)).toBe(hash); expect(parseRecordLinkQuery(hash, client)).toMatchObject({ kind: 'link' }); expect(limitRecordLinkQuery('x'.repeat(201))).toHaveLength(200);
});
it('reads one saved record and retains only its display labels and lifetime token', async () => {
  const work = vi.fn(async () => ({ entity: task })); const result = await readExactRecordLink(target, { work }, client);
  expect(work).toHaveBeenCalledExactlyOnceWith('task', task.id); expect(result).toMatchObject({ state: 'ready', match: { title: task.title, href: 'https://app.test/client/index.html' + target.hash } });
  expect(JSON.stringify(result)).not.toContain(task.body); expect(JSON.stringify(result)).not.toContain('private');
  if (result.state !== 'ready') throw Error('Missing match');
  await expect(verifyExactRecordLink(result.match, { work: async () => ({ entity: { ...task, title: 'Renamed', updated_at: 3 } }) }, client)).resolves.toBe(true);
  for (const entity of [null, { ...task, created_at: 4 }, { ...task, source_record_id: 'replacement' }, { ...task, deleted_at: 4 }])
    await expect(verifyExactRecordLink(result.match, { work: async () => ({ entity }) }, client)).resolves.toBe(false);
});
it('canonicalizes a contact email link and refuses a merged or reused contact', async () => {
  const original: WorkReaderLink = { tab: 'contact', id: contact.email, hash: serializeShellRoute('data', 'contact', contact.email) };
  const result = await readExactRecordLink(original, { contact: async () => ({ contact }) }, client); expect(result).toMatchObject({ state: 'ready', match: { target: { id: contact.contact_id } } });
  if (result.state !== 'ready') throw Error('Missing contact');
  for (const current of [{ ...contact, created_at: 5 }, { ...contact, merged_into: 'survivor' }])
    await expect(verifyExactRecordLink(result.match, { contact: async () => ({ contact: current }) }, client)).resolves.toBe(false);
});
it('uses the addressed mailbox or calendar and refuses a replaced collection record', async () => {
  for (const tab of ['mail', 'calendar'] as const) {
    const selected = { tab, collectionSlug: 'home', recordId: 'shared/id?二', hash: serializeSourceRecordAddress({ tab, collectionSlug: 'home', recordId: 'shared/id?二' }) };
    const record = { record_id: selected.recordId, source_id: 'provider-id', received_at: 1, modified_at: 1, size_bytes: 0, hot_fields: { subject: 'Current mail', summary: 'Current event' } };
    const source = vi.fn(async () => ({ record })); const result = await readExactRecordLink(selected, { source }, client);
    expect(source).toHaveBeenCalledExactlyOnceWith({ platform: tab, slug: 'home', record_id: selected.recordId }); expect(result).toMatchObject({ state: 'ready', match: { details: expect.arrayContaining(['Account: home']) } });
    if (result.state !== 'ready') throw Error('Missing source');
    await expect(verifyExactRecordLink(result.match, { source: async () => ({ record: { ...record, received_at: 2 } }) }, client)).resolves.toBe(false);
    await expect(verifyExactRecordLink(result.match, { source: async () => ({ record: null }) }, client)).resolves.toBe(false);
  }
});
