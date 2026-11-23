import type { Page } from '@playwright/test';
import type { CollectionRecord, MailMessageSnapshot } from '@recued/contracts';
import { installCalendarRecoveryFixture } from './calendar-recovery-fixture.js';

/** Real calendar owner/receipt handling, with controlled source mail reads.
 * The source is read-only and cannot send email. State survives page reload. */
export const installMailCalendarEventFixture = async (page: Page) => {
  let subject = 'Review <the launch> & dates', identity = 'mail-v1', fail = false, hold = false;
  let release: (() => void) | undefined;
  const calls: string[] = [], writes: unknown[] = [];
  const scope = () => ({ thread_id: 'thread-1', incarnation: identity });
  const message = (id = 'mail/one?#二'): MailMessageSnapshot => ({
    slug: 'mailbox', record_id: id, received_at: id === 'mail/one?#二' ? 1_793_184_000_000 : 1_793_184_001_000,
    subject: id === 'mail/one?#二' ? subject : 'A different message', from: 'Alex <alex@example.test>', to: ['owner@example.test'], cc: ['private@example.test'],
    body: id === 'mail/one?#二' ? 'Original email context. Please review the launch dates.' : 'Second message context.', body_truncated: false, read: 'stored', reply: null,
    conversation: scope(), state: { identity, verified: true, is_read: true, is_flagged: false, can_mark: false, can_flag: false },
  });
  const record = (id: string): CollectionRecord => {
    const m = message(id);
    return { record_id: id, source_id: id, received_at: m.received_at, modified_at: m.received_at, size_bytes: m.body!.length,
      hot_fields: { subject: m.subject, from: m.from, to: m.to, cc: m.cc, thread_id: 'thread-1', received_at: m.received_at, is_read: true, is_flagged: false } };
  };
  const calendar = await installCalendarRecoveryFixture(page, async (method, args) => {
    if (method === 'collection.listInstances' && (args.platform === undefined || args.platform === 'mail')) return { result: { instances: [
      { platform: 'mail', slug: 'mailbox', adapter_type: 'gmail', auth_state: 'healthy', caps: {}, last_synced_at: Date.parse('2026-11-19T12:00Z') },
      { platform: 'calendar', slug: 'work', adapter_type: 'gcal', auth_state: 'healthy', caps: {}, last_synced_at: Date.parse('2026-11-19T12:00Z') },
    ] } };
    if (method === 'collection.list' && args.platform === 'mail') return { result: { records: [record('mail/one?#二'), record('mail-2')] } };
    if (method === 'collection.get' && args.platform === 'mail') return { result: { record: record(String(args.record_id)) } };
    if (method === 'collection.mail.conversation.get') {
      const messages = ['mail/one?#二', 'mail-2'].map(id => ({ ...record(id), ...record(id).hot_fields,
        snippet: 'Review dates.', direction: 'inbound', has_attachments: false }));
      return { result: { slug: 'mailbox', anchor: messages.find(m => m.record_id === args.record_id), messages, ...scope(), mailbox_address: 'owner@example.test' } };
    }
    if (method === 'collection.mail.message.get') {
      calls.push(method);
      if (hold) { hold = false; await new Promise<void>(done => { release = done; }); }
      if (fail) return { error: { code: 'unavailable', message: 'The email check was interrupted.' } };
      return { result: structuredClone(message(String(args.record_id))) };
    }
    if (method === 'collection.mail.message.attachments') return { result: { slug: 'mailbox', record_id: args.record_id, incarnation: identity, items: [], warnings: [], truncated: false } };
    if (method === 'collection.mail.message.updateState' || method === 'mail.send') { writes.push(args); throw Error('The source email must not be changed or sent.'); }
    return undefined;
  });
  return { ...calendar, calls, writes, source: () => ({ tab: 'mail' as const, collectionSlug: 'mailbox', recordId: 'mail/one?#二' }),
    message, changeSubject(value: string) { subject = value; }, replaceMailbox() { identity = 'mail-v2'; }, failReads(value: boolean) { fail = value; },
    holdRead() { hold = true; }, readPending: () => release !== undefined, releaseRead() { const done = release; release = undefined; done?.(); },
    async dispose() { release?.(); await calendar.dispose(); } };
};
