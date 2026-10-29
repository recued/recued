import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { CollectionRecord } from '@recued/contracts';
import { createCollectionTable } from '../../table.js';
import { getMailConversation, type MailConversationReadDeps } from '../conversation-read.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const record = (id: string, thread: string | null = 'thread-a', time = 100): CollectionRecord => ({
  record_id: id, source_id: `provider-${id}`, received_at: time, modified_at: time, size_bytes: 30,
  body_inline: `Body of ${id}`, hot_fields: { thread_id: thread, from: 'sender@example.test',
    to: ['owner@example.test'], subject: 'Same subject', direction: 'inbound', folder: 'INBOX', is_read: false },
});
const fixture = () => {
  const db = new Database(':memory:'); databases.push(db);
  const work = createCollectionTable({ db, platform: 'mail', slug: 'work' });
  const other = createCollectionTable({ db, platform: 'mail', slug: 'other' });
  let incarnation = 'work-v1';
  const deps: MailConversationReadDeps = {
    getCollection: slug => slug === 'work' ? { get: work.get, list: work.list, accountEmail: 'owner@example.test' }
      : slug === 'other' ? { get: other.get, list: other.list, accountEmail: 'other@example.test' } : undefined,
    getIncarnation: () => incarnation,
  };
  return { work, other, deps, replace() { incarnation = 'work-v2'; } };
};

describe('retained mail conversation reads', () => {
  it('uses exact thread identity inside one mailbox, includes sent mail, and leaves stored flags untouched', () => {
    const f = fixture();
    f.work.upsert(record('received'));
    const sent = record('sent', 'thread-a', 101);
    Object.assign(sent.hot_fields, { direction: 'outbound', from: 'owner@example.test', folder: 'Sent', is_read: true });
    f.work.upsert(sent);
    f.work.upsert(record('same-subject-other-thread', 'thread-b'));
    f.other.upsert(record('same-thread-other-mailbox'));
    const result = getMailConversation(f.deps, { slug: 'work', record_id: 'received' });
    expect(result).toMatchObject({ slug: 'work', thread_id: 'thread-a', incarnation: 'work-v1', mailbox_address: 'owner@example.test' });
    expect(result.messages.map(message => [message.record_id, message.direction])).toEqual([['sent', 'outbound'], ['received', 'inbound']]);
    expect(f.work.get('received')?.hot_fields.is_read).toBe(false);
    expect(f.work.get('sent')).toEqual(expect.objectContaining(sent));
  });

  it('pages a timestamp burst without gaps or duplicates and retains an older opened anchor separately', () => {
    const f = fixture();
    for (let index = 0; index < 65; index++) f.work.upsert(record(`mail-${String(index).padStart(2, '0')}`));
    const input = { slug: 'work', record_id: 'mail-00' };
    const first = getMailConversation(f.deps, input);
    expect(first.messages).toHaveLength(30);
    expect(first.anchor.record_id).toBe('mail-00');
    expect(first.messages.some(message => message.record_id === 'mail-00')).toBe(false);
    const second = getMailConversation(f.deps, { ...input, before: first.next_before!, expected_thread_id: first.thread_id, expected_incarnation: first.incarnation! });
    const third = getMailConversation(f.deps, { ...input, before: second.next_before!, expected_thread_id: first.thread_id, expected_incarnation: first.incarnation! });
    const ids = [...first.messages, ...second.messages, ...third.messages].map(message => message.record_id);
    expect(ids).toHaveLength(65);
    expect(new Set(ids).size).toBe(65);
    expect(third.next_before).toBeUndefined();
    f.replace();
    expect(() => getMailConversation(f.deps, { ...input, before: first.next_before!, expected_thread_id: first.thread_id, expected_incarnation: first.incarnation! }))
      .toThrow(expect.objectContaining({ code: 'resource_changed' }));
    expect(() => getMailConversation(f.deps, { ...input, expected_thread_id: 'thread-b' }))
      .toThrow(expect.objectContaining({ code: 'resource_changed' }));
  });

  it('shows only the anchor without a thread ID and returns bounded metadata without materializing bodies', () => {
    const f = fixture();
    const anchor = record('one', null); anchor.body_inline = '<script>never rendered as HTML</script>\n' + 'x'.repeat(5_000);
    f.work.upsert(anchor); f.work.upsert(record('two', null));
    const single = getMailConversation(f.deps, { slug: 'work', record_id: 'one' });
    expect(single.messages.map(message => message.record_id)).toEqual(['one']);
    expect(single.thread_id).toBeNull();
    expect(single.messages[0]?.snippet.length).toBeLessThanOrEqual(160);
    expect(single.messages[0]).not.toHaveProperty('body');
    expect(single.next_before).toBeUndefined();
    f.work.upsert({ ...record('cas'), body_inline: undefined, blob_hash: 'a'.repeat(64) });
    expect(getMailConversation(f.deps, { slug: 'work', record_id: 'cas' }).messages[0]?.snippet).toBe('');
  });

  it('fails closed if a collection ignores the thread filter', () => {
    const anchor = record('one');
    expect(() => getMailConversation({ getCollection: () => ({ get: () => anchor,
      list: () => [anchor, record('unrelated', 'thread-b')], accountEmail: 'owner@example.test' }), getIncarnation: () => 'v1' },
    { slug: 'work', record_id: 'one' })).toThrow(expect.objectContaining({ code: 'unavailable' }));
  });
});
