import { expect, it } from 'vitest';
import { savedWorkAddress, type WorkEntityLinkedFromItem, type WorkEntityGetRpcResponse } from '@recued/contracts';
import { verifyLinkedFromSource } from '../work-linked-from.js';
const target = savedWorkAddress('https://app.test/client/#data/task/target%2F%E4%BA%8C%3F')!;
const row: WorkEntityLinkedFromItem = { kind: 'note', id: 'source', title: 'Source', excerpt: '', source_id: 'recued.note', source_label: 'Notes',
  created_at: 10, updated_at: 20, stale: false, pending_write: false, source_record_id: 'original' };
const source = (patch = {}): WorkEntityGetRpcResponse => ({ entity: { _kind: 'note', id: row.id, source_id: row.source_id, source_record_id: 'original',
  body: '#data/task/target%2F%E4%BA%8C%3F', title: 'Updated title', created_at: 10, updated_at: 30, last_user_action_at: 10,
  related_contact_ids: [], related_project_ids: [], related_calendar_event_ids: [], related_mail_thread_ids: [], last_seen_at: 30, sync_state: 'live', conflict_policy: 'source_wins', ...patch } });
it('rechecks current saved text while allowing a title/content update and stale readable copies', () => {
  expect(() => verifyLinkedFromSource(row, target, source())).not.toThrow();
  expect(() => verifyLinkedFromSource(row, target, source({ sync_state: 'stale_unreachable' }))).not.toThrow();
  for (const body of ['Link removed', 'https://other.test/client/#data/task/target%2F%E4%BA%8C%3F', '#data/task/target%2F%E4%BA%8C%3Fsuffix'])
    expect(() => verifyLinkedFromSource(row, target, source({ body }))).toThrow('no longer links here');
});
it('refuses deleted, orphaned, wrong-kind and reused identities even if the link text remains', () => {
  for (const patch of [{ id: 'other' }, { _kind: 'task' }, { created_at: 11 }, { source_id: 'new' }, { source_record_id: 'replacement' },
    { deleted_at: 20 }, { sync_state: 'tombstoned' }, { sync_state: 'orphaned' }])
    expect(() => verifyLinkedFromSource(row, target, source(patch))).toThrow('no longer available');
  expect(() => verifyLinkedFromSource(row, target, { entity: null })).toThrow('no longer available');
});

it('uses only the current resolved contact references when validating a source after merge or split', () => {
  const contact = savedWorkAddress('https://app.test/client/#data/contact/current')!;
  const response = source({ body: '#data/contact/old' });
  expect(() => verifyLinkedFromSource(row, contact, response, ['current', 'old'])).not.toThrow();
  expect(() => verifyLinkedFromSource(row, contact, response, ['current'])).toThrow('no longer links here');
  expect(() => verifyLinkedFromSource(row, contact, source({ body: 'https://other.test/client/#data/contact/old' }), ['current', 'old'])).toThrow();
});

it('fresh source verification preserves account and occurrence identity for mail and event links', () => {
  for (const kind of ['mail', 'calendar']) {
    const url = 'https://app.test/client/#data/' + kind + '/record/work/same%2Fid';
    const target = savedWorkAddress(url)!;
    expect(() => verifyLinkedFromSource(row, target, source({ body: url }))).not.toThrow();
    for (const body of [url.replace('/work/', '/home/'), url + 'suffix', url.replace('app.test', 'other.test')]) expect(() => verifyLinkedFromSource(row, target, source({ body }))).toThrow('no longer links');
  }
});
