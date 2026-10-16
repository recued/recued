/** D-318 step 5 — the conversation stays out of the owner's mail (§4.10, P19):
 *  what, in the owner's OTHER mailboxes, is the conversation with the chat
 *  mailbox. Recued's answers (by a reconciliation id Recued's own send record
 *  holds) and the owner's requests as their Sent copies (filed as sent by the
 *  provider, to the chat mailbox alone) are; mail to the chat mailbox and
 *  someone else is not.
 *
 *  ⛔ The audit: a From line, a header, or a stored direction — anything a
 *  sender can write — hides nothing. The decision is made as a message syncs,
 *  with the provider's record in hand, and kept on the stored row. */

import Database from 'better-sqlite3';
import type { CollectionRecord, MailChatDoorSettings } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import { MAIL_CHAT_CONVERSATION_FIELD } from '../collections/mail/mail-collection.js';
import { createCollectionTable } from '../collections/table.js';
import {
  createMailChatConversationMail,
  isMailChatAnswerReconciliationId,
  isMailChatConversationMessage,
  isMailChatConversationRecord,
  MAIL_CHAT_OWNER_ROWS_SQL,
  mailChatAnswerReconciliationId,
} from '../mail-chat-door/conversation-mail.js';

const CHAT = 'recued@chat.example';
const SENT = mailChatAnswerReconciliationId('message-1');
/** Recued's own record of what it sent. */
const isOwnAnswer = (id: string): boolean => id === SENT;
const door = (over: Partial<MailChatDoorSettings> = {}): MailChatDoorSettings => ({
  chat_mailbox: 'recued-chat', ask_prefix: 'ask:', owner_mailboxes: ['work'], chat_address: CHAT, stale_after_minutes: 60,
  paused_at: null, enrolled_senders: [], ...over,
});

describe('a message as it syncs — isMailChatConversationMessage', () => {
  it('an answer, by a reconciliation id Recued’s record holds — even with no chat mailbox set', () => {
    expect(isMailChatAnswerReconciliationId(SENT)).toBe(true);
    expect(mailChatAnswerReconciliationId('message-1')).toBe(SENT);
    expect(mailChatAnswerReconciliationId('message-2')).not.toBe(SENT);
    expect(isMailChatConversationMessage({ reconciliation_id: SENT, to: ['me@owner.example'] }, null, isOwnAnswer)).toBe(true);
    // Another of Recued's own sends is not the conversation.
    expect(isMailChatConversationMessage({ reconciliation_id: 'qsr_123', to: ['c@x.example'] }, CHAT, () => true)).toBe(false);
  });

  it('a request’s Sent copy: filed as sent by its provider, to the chat mailbox alone', () => {
    expect(isMailChatConversationMessage({ to: ['"Recued" <recued@chat.example>'], cc: [], direction: 'outbound' }, CHAT))
      .toBe(true);
    expect(isMailChatConversationMessage({ to: 'recued@chat.example', direction: 'outbound' }, CHAT)).toBe(true);
  });

  it('⛔ a header, a From line or the inbox hides nothing', () => {
    // An answer's id that Recued never sent, or with no record to ask.
    const forged = mailChatAnswerReconciliationId('never-sent');
    expect(isMailChatConversationMessage({ reconciliation_id: forged, to: ['me@owner.example'] }, CHAT, isOwnAnswer)).toBe(false);
    expect(isMailChatConversationMessage({ reconciliation_id: SENT, to: ['me@owner.example'] }, CHAT)).toBe(false);
    // The chat mailbox in a From line.
    expect(isMailChatConversationMessage(
      { from: 'Recued <RECUED@chat.example>', to: ['me@owner.example'], direction: 'inbound' } as never, CHAT, isOwnAnswer,
    )).toBe(false);
    // The owner's From, the chat mailbox as the only To, the owner Bcc'd: in the inbox.
    expect(isMailChatConversationMessage({ to: [CHAT], direction: 'inbound' }, CHAT, isOwnAnswer)).toBe(false);
    expect(isMailChatConversationMessage({ to: [CHAT] }, CHAT, isOwnAnswer)).toBe(false);
  });

  it('⛔ mail to the chat mailbox and someone else stays the owner’s mail', () => {
    const sent = (to: unknown, cc: unknown = []) => isMailChatConversationMessage({ to, cc, direction: 'outbound' }, CHAT);
    expect(sent(['recued@chat.example', 'bob@x.example'])).toBe(false);
    expect(sent(['recued@chat.example, bob@x.example'])).toBe(false);
    expect(sent(['recued@chat.example'], ['bob@x.example'])).toBe(false);
    expect(sent(['bob@x.example'], ['recued@chat.example'])).toBe(false);
  });

  it('nothing else, and no Sent copy with no chat mailbox set', () => {
    expect(isMailChatConversationMessage({ to: ['me@owner.example'], direction: 'inbound' }, CHAT)).toBe(false);
    expect(isMailChatConversationMessage({ to: ['recued@chat.example'], direction: 'outbound' }, null)).toBe(false);
  });
});

describe('⛔ an answer another copy of the server sent — by the stamp of the mailbox it landed in', () => {
  // A server restored from a backup holds no claim for the answers sent since
  // it was taken (live, 2026-10-15: such a copy stored two answers in the
  // owner's Gmail as the owner's mail, and counted the chat mailbox as someone
  // the owner corresponds with).
  const OTHER = mailChatAnswerReconciliationId('answered-by-the-other-copy');
  // Gmail's stamp on an answer from an Outlook chat mailbox, as measured on the
  // owner's Gmail (2026-10-15), with the test domain in place of outlook.com.
  const GMAIL_STAMP = 'mx.google.com;       dkim=pass header.i=@chat.example header.s=selector1 header.b=hJxoxgU2;'
    + '       arc=pass (i=1);       spf=pass (google.com: domain of recued@chat.example designates 2001:db8::2 as '
    + 'permitted sender) smtp.mailfrom=recued@chat.example;       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) '
    + 'header.from=chat.example';
  // Microsoft's, which names no checker.
  const MICROSOFT_STAMP = 'spf=pass (sender IP is 192.0.2.4) smtp.mailfrom=chat.example; dkim=pass (signature was '
    + 'verified) header.d=chat.example;dmarc=pass action=none header.from=chat.example;compauth=pass reason=100';
  const gmail = { provider_kind: 'gmail', account_email: 'me@owner.example' } as const;
  const outlook = { provider_kind: 'graph', account_email: 'me@owner.example' } as const;
  /** `stamp: null` ⇒ no stamp at all. */
  const answer = (over: Record<string, unknown> = {}, stamp: string | null = GMAIL_STAMP) => ({
    from: 'Recued <recued@chat.example>', to: ['me@owner.example'], direction: 'inbound', reconciliation_id: OTHER,
    ...(stamp !== null ? { headers: { 'authentication-results': stamp } } : {}), ...over,
  });

  it('is the conversation when Gmail’s or Microsoft’s own stamp passes the chat mailbox’s address', () => {
    expect(isMailChatConversationMessage(answer(), CHAT, isOwnAnswer, gmail)).toBe(true);
    expect(isMailChatConversationMessage(answer({}, MICROSOFT_STAMP), CHAT, isOwnAnswer, outlook)).toBe(true);
  });

  it('⛔ never without the mailbox it landed in, nor on an IMAP mailbox, whose server may stamp nothing', () => {
    expect(isMailChatConversationMessage(answer(), CHAT, isOwnAnswer)).toBe(false);
    expect(isMailChatConversationMessage(answer(), CHAT, isOwnAnswer,
      { provider_kind: 'imap', account_email: 'me@owner.example' })).toBe(false);
  });

  it('⛔ never from another address, whatever its name says', () => {
    expect(isMailChatConversationMessage(answer({ from: 'Recued <other@chat.example>' }), CHAT, isOwnAnswer, gmail)).toBe(false);
    expect(isMailChatConversationMessage(answer({ from: '"recued@chat.example" <evil@else.example>' }), CHAT, isOwnAnswer, gmail))
      .toBe(false);
    expect(isMailChatConversationMessage(answer({ from: 'recued@chat.example, evil@else.example' }), CHAT, isOwnAnswer, gmail))
      .toBe(false);
  });

  it('⛔ never on a stamp that does not pass the chat mailbox’s own domain, or that the mailbox’s provider did not write', () => {
    const fail = GMAIL_STAMP.replace('dmarc=pass', 'dmarc=fail');
    expect(isMailChatConversationMessage(answer({}, fail), CHAT, isOwnAnswer, gmail)).toBe(false);
    const elsewhere = GMAIL_STAMP.replace(/chat\.example/g, 'else.example');
    expect(isMailChatConversationMessage(answer({}, elsewhere), CHAT, isOwnAnswer, gmail)).toBe(false);
    // A pass a sender wrote: named for another checker on Gmail, or Gmail's
    // name on a Microsoft mailbox.
    expect(isMailChatConversationMessage(answer({}, GMAIL_STAMP.replace('mx.google.com', 'mx.evil.example')),
      CHAT, isOwnAnswer, gmail)).toBe(false);
    expect(isMailChatConversationMessage(answer(), CHAT, isOwnAnswer, outlook)).toBe(false);
    // A pass from a stamp that does not parse cleanly (a quoted local part).
    const planted = GMAIL_STAMP.replace('smtp.mailfrom=recued@chat.example', 'smtp.mailfrom="a;dmarc=pass"@chat.example');
    expect(isMailChatConversationMessage(answer({}, planted), CHAT, isOwnAnswer, gmail)).toBe(false);
    expect(isMailChatConversationMessage(answer({}, null), CHAT, isOwnAnswer, gmail)).toBe(false);
  });

  it('⛔ only an answer: other mail from the chat mailbox stays the owner’s, and so does everything with no chat mailbox set', () => {
    expect(isMailChatConversationMessage(answer({ reconciliation_id: undefined }), CHAT, isOwnAnswer, gmail)).toBe(false);
    expect(isMailChatConversationMessage(answer({ reconciliation_id: 'customer-reminder:5d1c' }), CHAT, isOwnAnswer, gmail))
      .toBe(false);
    expect(isMailChatConversationMessage(answer(), null, isOwnAnswer, gmail)).toBe(false);
  });
});

describe('a stored row — isMailChatConversationRecord', () => {
  it('is the conversation by the mark the sync gave it, or — stored before the mark — by an answer’s claim', () => {
    expect(isMailChatConversationRecord({ [MAIL_CHAT_CONVERSATION_FIELD]: true })).toBe(true);
    expect(isMailChatConversationRecord({ reconciliation_id: SENT }, isOwnAnswer)).toBe(true);
    expect(isMailChatConversationRecord({ reconciliation_id: SENT })).toBe(false);
  });

  it('⛔ never by its stored direction, which reads outbound for any From equal to the account', () => {
    // The Bcc forgery, as it is stored: From the owner, so `outbound`.
    expect(isMailChatConversationRecord({ from: 'me@owner.example', to: [CHAT], direction: 'outbound' }, isOwnAnswer))
      .toBe(false);
  });

  it('every reader of the stored mail reads it without the marked rows — by SQL', () => {
    const db = new Database(':memory:');
    const table = createCollectionTable({ db, platform: 'mail', slug: 'work' });
    const row = (record_id: string, hot_fields: Record<string, unknown>) =>
      ({ record_id, received_at: 1, modified_at: 1, size_bytes: 0, source_id: record_id, hot_fields });
    table.upsert(row('mine', { subject: 'lunch' }));
    table.upsert(row('answer', { subject: 'Re: ask: lunch', [MAIL_CHAT_CONVERSATION_FIELD]: true }));
    table.upsert(row('false-mark', { subject: 'x', [MAIL_CHAT_CONVERSATION_FIELD]: false }));
    const name = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'collection_mail_%' AND name NOT LIKE '%fts%'")
      .get() as { name: string };
    const kept = db.prepare(`SELECT record_id FROM ${name.name} WHERE ${MAIL_CHAT_OWNER_ROWS_SQL} ORDER BY record_id`).all();
    // Only a mark the collection wrote (`true`) takes a row out.
    expect(kept).toEqual([{ record_id: 'false-mark' }, { record_id: 'mine' }].sort((a, b) => a.record_id.localeCompare(b.record_id)));
    db.close();
  });
});

describe('createMailChatConversationMail', () => {
  const setup = (settings: () => MailChatDoorSettings, records: Record<string, CollectionRecord> = {}) =>
    createMailChatConversationMail({
      door: { get: settings },
      mailbox: (slug) => slug === 'recued-chat'
        ? { accountEmail: 'Recued <recued@chat.example>', get: () => null }
        : slug === 'work'
          ? { accountEmail: 'me@owner.example', get: (id: string) => records[id] ?? null }
          : undefined,
      isOwnAnswer,
    });
  const sentCopy = { to: [CHAT], direction: 'outbound' };

  it('reads the chat mailbox’s address each time: the owner can change it', () => {
    let settings = door();
    const mail = setup(() => settings);
    expect(mail.isConversationMessage(sentCopy)).toBe(true);
    settings = door({ chat_mailbox: null, chat_address: null });
    expect(mail.isConversationMessage(sentCopy)).toBe(false);
    // Recued's answers stay known by its own record.
    expect(mail.isConversationMessage({ reconciliation_id: SENT, to: ['me@owner.example'] })).toBe(true);
  });

  it('knows the chat mailbox’s address while that mailbox is not running — and asks it when the door kept none', () => {
    const notRunning = createMailChatConversationMail({ door: { get: () => door() }, mailbox: () => undefined });
    expect(notRunning.isConversationMessage(sentCopy)).toBe(true);
    expect(setup(() => door({ chat_address: null })).isConversationMessage(sentCopy)).toBe(true);
    const neither = createMailChatConversationMail({ door: { get: () => door({ chat_address: null }) }, mailbox: () => undefined });
    expect(neither.isConversationMessage(sentCopy)).toBe(false);
  });

  it('a stored record, by its mailbox and id, and by its mark', () => {
    const answer = { record_id: 'a', hot_fields: { reconciliation_id: SENT, to: ['me@owner.example'] } } as unknown as CollectionRecord;
    const copy = { record_id: 'c', hot_fields: { to: [CHAT], [MAIL_CHAT_CONVERSATION_FIELD]: true } } as unknown as CollectionRecord;
    const forged = { record_id: 'f', hot_fields: { to: [CHAT], direction: 'outbound' } } as unknown as CollectionRecord;
    const own = { record_id: 'b', hot_fields: { from: 'bob@x.example', to: ['me@owner.example'] } } as unknown as CollectionRecord;
    const mail = setup(() => door(), { a: answer, b: own, c: copy, f: forged });
    expect(mail.isConversationRecord('work', 'a')).toBe(true);
    expect(mail.isConversationRecord('work', 'c')).toBe(true);
    expect(mail.isConversationRecord('work', 'f')).toBe(false);
    expect(mail.isConversationRecord('work', 'b')).toBe(false);
    expect(mail.isConversationRecord('work', 'gone')).toBe(false);
    expect(mail.isConversationRecord('unknown-mailbox', 'a')).toBe(false);
  });
});
