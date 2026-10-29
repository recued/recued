/** Same-mailbox, exact-thread browsing of retained mail. Never reads a provider or changes flags. */
import {
  RpcError, type CollectionRecord, type MailConversationItem,
  type MailConversationRequest, type MailConversationSnapshot,
} from '@recued/contracts';
import type { MailCollection } from './mail-collection.js';

export interface MailConversationReadDeps {
  getCollection(slug: string): Pick<MailCollection, 'get' | 'list' | 'accountEmail'> | undefined;
  getIncarnation(slug: string): string | null;
}
const PAGE_SIZE = 30;
const bounded = (value: unknown, max: number): string => typeof value === 'string' ? value.slice(0, max) : '';
const item = (record: CollectionRecord): MailConversationItem => {
  const hot = record.hot_fields;
  return {
    record_id: record.record_id, source_id: record.source_id, modified_at: record.modified_at ?? record.received_at,
    size_bytes: record.size_bytes, to: Array.isArray(hot.to) ? hot.to.filter((value): value is string => typeof value === 'string').slice(0, 20).map(value => value.slice(0, 320)) : [],
    from: bounded(hot.from, 1024), subject: bounded(hot.subject, 1024),
    received_at: record.received_at,
    direction: hot.direction === 'inbound' || hot.direction === 'outbound' ? hot.direction : 'unknown',
    folder: bounded(hot.folder, 256), is_read: hot.is_read === true,
    has_attachments: hot.has_attachments === true,
    snippet: bounded(record.body_inline, 400).replace(/\s+/g, ' ').trim().slice(0, 160),
  };
};
export const getMailConversation = (
  deps: MailConversationReadDeps, input: MailConversationRequest,
): MailConversationSnapshot => {
  if (!input || typeof input.slug !== 'string' || !input.slug || input.slug.length > 256
    || typeof input.record_id !== 'string' || !input.record_id || input.record_id.length > 4096
    || input.before !== undefined && (!input.before || !Number.isSafeInteger(input.before.received_at)
      || typeof input.before.record_id !== 'string' || !input.before.record_id || input.before.record_id.length > 4096)) {
    throw new RpcError('invalid_args', 'A mailbox, message and valid page cursor are required.', 400);
  }
  const collection = deps.getCollection(input.slug);
  const anchor = collection?.get(input.record_id);
  if (!collection || !anchor) throw new RpcError('not_found', 'This email is unavailable. Open another message or refresh Mail.', 404);
  const rawThread = anchor.hot_fields.thread_id;
  const thread = typeof rawThread === 'string' && rawThread.trim() && rawThread.length <= 4096 ? rawThread : null;
  const incarnation = deps.getIncarnation(input.slug);
  if ((input.expected_thread_id !== undefined && input.expected_thread_id !== thread)
    || (input.expected_incarnation !== undefined && input.expected_incarnation !== incarnation)) {
    throw new RpcError('resource_changed', 'This conversation or mailbox changed. Open it again from Mail.', 409);
  }
  if (input.before && (!thread || !incarnation || input.expected_thread_id !== thread || input.expected_incarnation !== incarnation)) {
    throw new RpcError('resource_changed', 'This conversation or mailbox changed. Refresh the conversation.', 409);
  }
  const rows = thread ? collection.list({
    platform: 'mail', slug: input.slug, filters: { thread_id: thread }, limit: PAGE_SIZE + 1,
    ...(input.before ? { before: input.before } : {}),
  }) : [anchor];
  // A collection without the advertised filter must never turn a thread read
  // into a mailbox-wide response.
  if (thread && rows.some(row => row.hot_fields.thread_id !== thread)) {
    throw new RpcError('unavailable', 'The conversation index could not be verified. Refresh Mail.', 503);
  }
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    slug: input.slug, anchor: item(anchor), thread_id: thread, incarnation,
    mailbox_address: collection.accountEmail, messages: page.map(item),
    ...(last && rows.length > PAGE_SIZE && incarnation ? {
      next_before: { received_at: last.received_at, record_id: last.record_id },
    } : {}),
  };
};
