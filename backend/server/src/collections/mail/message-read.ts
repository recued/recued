/** Owner-started message reading and verified reply context. Never sends or
 * marks mail read. Provider ids and provider thread ids are not RFC headers. */
import { simpleParser } from 'mailparser';
import { MAIL_DRAFT_SOURCE_MAX, RpcError, type MailMessageRef, type MailMessageSnapshot } from '@recued/contracts';
import { materializeMailBody } from '../../mail-body-read-handler.js';
import type { BlobStore } from '../../storage/blob-store.js';
import type { MailCollection } from './mail-collection.js';

export interface MailMessageReadDeps {
  getCollection(slug: string): (Pick<MailCollection, 'get' | 'accountEmail'> & {
    readonly provider: Pick<MailCollection['provider'], 'fetchMessage'>;
  }) | undefined;
  listMailInstances(): Promise<{ instances: readonly { slug: string; send_capable: boolean; auth_state: string }[] }>;
  blobs?: BlobStore;
  getIncarnation?(slug: string): string | null;
}

const rfcId = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 998) return null;
  const bare = value.trim().replace(/^<([^<>]+)>$/, '$1');
  const id = `<${bare}>`;
  return /^[^\s<>@]+@[^\s<>@]+$/.test(bare) && !/[\u0000-\u001f\u007f]/.test(bare)
    && Buffer.byteLength(id, 'utf8') <= 998 ? id : null;
};
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string') : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';

export const getMailMessage = async (deps: MailMessageReadDeps, input: MailMessageRef): Promise<MailMessageSnapshot> => {
  if (!input || typeof input.slug !== 'string' || !input.slug || input.slug.length > 256
    || typeof input.record_id !== 'string' || !input.record_id || input.record_id.length > 4096) {
    throw new RpcError('invalid_args', 'A mailbox and message identity are required.', 400);
  }
  const collection = deps.getCollection(input.slug);
  const record = collection?.get(input.record_id);
  if (!collection || !record) throw new RpcError('not_found', 'This email is unavailable. Refresh Mail.', 404);
  const scope = input.conversation;
  if (scope !== undefined && (!scope || scope.thread_id !== null && (typeof scope.thread_id !== 'string' || !scope.thread_id || scope.thread_id.length > 4096)
    || typeof scope.incarnation !== 'string' || !scope.incarnation || scope.incarnation.length > 256)) {
    throw new RpcError('invalid_args', 'A valid conversation identity is required.', 400);
  }
  const assertScope = (): void => {
    if (!scope) return;
    const current = collection.get(input.record_id);
    if (deps.getCollection(input.slug) !== collection || !current || current.source_id !== record.source_id
      || (typeof current.hot_fields.thread_id === 'string' && current.hot_fields.thread_id.trim() ? current.hot_fields.thread_id : null) !== scope.thread_id || deps.getIncarnation?.(input.slug) !== scope.incarnation) {
      throw new RpcError('resource_changed', 'This conversation or mailbox changed. Refresh the conversation.', 409);
    }
  };
  assertScope();
  const hot = record.hot_fields;
  let body = typeof record.body_inline === 'string' ? record.body_inline : deps.blobs
    ? await materializeMailBody(record, deps.blobs) : null;
  const snapshot: MailMessageSnapshot = {
    slug: input.slug, record_id: input.record_id, from: text(hot.from), to: strings(hot.to), cc: strings(hot.cc), subject: text(hot.subject),
    received_at: record.received_at,
    body: null, body_truncated: false, read: 'stored', reply: null,
  };
  const unavailable = (reason: string): MailMessageSnapshot => {
    assertScope();
    snapshot.body_truncated = body !== null && body.length > MAIL_DRAFT_SOURCE_MAX;
    snapshot.body = body === null ? null : body.slice(0, MAIL_DRAFT_SOURCE_MAX);
    snapshot.reply_unavailable_reason = reason;
    return snapshot;
  };
  const canSend = async (): Promise<boolean> => {
    const listed = await deps.listMailInstances();
    return listed.instances.some(row => row.slug === input.slug && row.send_capable && row.auth_state === 'healthy');
  };
  try {
    if (!await canSend()) return unavailable('Sending is unavailable for this mailbox. Enable sending in Connections to reply.');
  } catch { return unavailable('Sending could not be checked. Refresh this email to try again.'); }
  if (hot.direction !== 'inbound') return unavailable('Reply is available on received email.');
  const fetch = collection.provider.fetchMessage;
  if (!fetch) return unavailable('This mailbox cannot verify the original email’s reply details.');
  try {
    const message = await fetch.call(collection.provider, record.source_id);
    const storedId = rfcId(hot.rfc_message_id);
    const messageId = rfcId(message?.rfc_message_id);
    if (!message || message.source_id !== record.source_id || !messageId || !storedId || storedId !== messageId) {
      return unavailable('The original email could not be verified. Refresh Mail before replying.');
    }
    // An asynchronous provider read may outlive deletion, re-enrollment or a
    // sending-scope change. Do not open a reply on the replacement mailbox.
    const rawReplyTo = message.headers?.['reply-to'];
    let replyTo = [message.from];
    if (rawReplyTo !== undefined) {
      const header = rawReplyTo.replace(/\r?\n[ \t]+/g, ' ');
      if (header.length > 8_000 || /[\r\n]/.test(header)) return unavailable('This email’s Reply-To address could not be verified.');
      const parsed = await simpleParser(`Reply-To: ${header}\r\n\r\n`);
      replyTo = parsed.replyTo?.value.map(item => item.address ?? '') ?? [];
    }
    if (!replyTo.length || replyTo.length > 20 || replyTo.some(address => !/^[^\s<>,;@]+@[^\s<>,;@]+$/.test(address)
      || address.toLowerCase() === collection.accountEmail.toLowerCase())) {
      return unavailable('This email has no usable reply address.');
    }
    const referenceHeader = message.headers?.references ?? message.headers?.['in-reply-to'] ?? '';
    const references = [...new Set((referenceHeader.match(/<[^<>\s]+@[^<>\s]+>/g) ?? [])
      .map(rfcId).filter((id): id is string => id !== null))].slice(-99);
    const stillSending = await canSend();
    const current = collection.get(input.record_id);
    if (deps.getCollection(input.slug) !== collection || !current || current.source_id !== record.source_id
      || rfcId(current.hot_fields.rfc_message_id) !== storedId || !stillSending) {
      return unavailable('This mailbox changed. Refresh Mail before replying.');
    }
    body = message.body_text;
    snapshot.from = message.from; snapshot.to = message.to; snapshot.cc = message.cc; snapshot.subject = message.subject;
    snapshot.read = 'provider';
    snapshot.body_truncated = body.length > MAIL_DRAFT_SOURCE_MAX;
    snapshot.body = body.slice(0, MAIL_DRAFT_SOURCE_MAX);
    assertScope();
    snapshot.reply = {
      original_source_id: input.slug,
      original_message: { id: messageId, from: message.from, subject: message.subject,
        to: [...message.to], cc: [...message.cc], reply_to: replyTo, references,
        body: snapshot.body, body_truncated: snapshot.body_truncated },
    };
    return snapshot;
  } catch {
    return unavailable('Reply details could not be checked. Refresh this email to try again.');
  }
};
