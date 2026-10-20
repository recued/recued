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
  type MailChatOneMailbox,
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

describe('§8.18 one mailbox — the chat mailbox is one of the owner’s own', () => {
  // The owner writes to themselves: the chat mailbox's address is theirs, and
  // so is most mail addressed to it alone.
  const ME = 'me@owner.example';
  const ASK = '[#ask-7b0c2d1e-1111-4222-8333-944445555666]';
  const one = (over: Partial<MailChatOneMailbox> = {}): MailChatOneMailbox => ({
    ask_prefix: 'ask:',
    continues: (references) => references.includes('answer-1@chat.example'),
    owner_addresses: new Set([ME, 'me@personal.example']),
    refuted: (id) => id === 'refuted-1@owner.example',
    ...over,
  });
  /** As Gmail keeps an email to oneself: one message, filed as sent. */
  const toMyself = (over: Record<string, unknown> = {}) => ({
    from: `Me <${ME}>`, to: [ME], cc: [], direction: 'outbound', subject: 'ask: what is on today?', ...over,
  });
  const isConversation = (msg: Record<string, unknown>, oneMailbox: MailChatOneMailbox | undefined = one(),
    receiver?: Parameters<typeof isMailChatConversationMessage>[3]) =>
    isMailChatConversationMessage(msg, ME, isOwnAnswer, receiver, oneMailbox);

  it('an email to oneself that asks is the conversation; one that does not is the owner’s own mail', () => {
    expect(isConversation(toMyself())).toBe(true);
    expect(isConversation(toMyself({ subject: 'Re: ASK: what is on today?' }))).toBe(true);
    // A note to self, a renewal forwarded to oneself: theirs.
    expect(isConversation(toMyself({ subject: 'Buy milk' }))).toBe(false);
    expect(isConversation(toMyself({ subject: 'Fwd: Your passport renewal' }))).toBe(false);
    // The owner's own prefix.
    expect(isConversation(toMyself({ subject: 'recued: lunch?' }), one({ ask_prefix: 'recued:' }))).toBe(true);
    expect(isConversation(toMyself(), one({ ask_prefix: 'recued:' }))).toBe(false);
  });

  it('a reply in a conversation needs no prefix, as a request does not', () => {
    const reply = toMyself({ subject: 'thanks — and tomorrow?', headers: { 'in-reply-to': '<answer-1@chat.example>' } });
    expect(isConversation(reply)).toBe(true);
    expect(isConversation({ ...reply, headers: { 'in-reply-to': '<a-notification@owner.example>' } })).toBe(false);
  });

  it('⛔ the notification channel’s mail stays out of it: Recued’s notification, and the owner’s answer to one', () => {
    // D-158's one address: Recued's notification to the mailbox it sends from.
    expect(isConversation(toMyself({ subject: `${ASK} Passport renewal`, reconciliation_id: 'owner-notification:1f2e' })))
      .toBe(false);
    expect(isConversation(toMyself({ reconciliation_id: 'owner-notification:1f2e' }))).toBe(false);
    // The owner's answer to it, from the same mailbox: D-158's, never chat's.
    expect(isConversation(toMyself({ subject: `Re: ${ASK} Passport renewal` }))).toBe(false);
    expect(isConversation(toMyself({ subject: `ask: ${ASK}` }))).toBe(false);
  });

  it('⛔ an email to oneself and someone else, or automatic mail, is not the conversation', () => {
    expect(isConversation(toMyself({ to: [ME, 'bob@x.example'] }))).toBe(false);
    expect(isConversation(toMyself({ cc: ['bob@x.example'] }))).toBe(false);
    expect(isConversation(toMyself({ headers: { 'auto-submitted': 'auto-replied' } }))).toBe(false);
  });

  it('Recued’s answer filed as sent is the conversation, even one another copy sent with no claim here', () => {
    expect(isConversation(toMyself({ subject: 'Re: ask: what is on today?', reconciliation_id: SENT }))).toBe(true);
    const other = mailChatAnswerReconciliationId('answered-by-the-other-copy');
    expect(isConversation(toMyself({ subject: 'Re: ask: what is on today?', reconciliation_id: other }))).toBe(true);
    // ⛔ Delivered, the answer's id alone is a header anyone writes.
    expect(isConversation(toMyself({ direction: 'inbound', reconciliation_id: other, subject: 'Buy milk' }))).toBe(false);
  });

  it('two mailboxes are unchanged: a Sent copy to the chat mailbox alone is the conversation, whatever it says', () => {
    // (Not through `isConversation`, whose default would make it one mailbox.)
    expect(isMailChatConversationMessage(toMyself({ subject: 'Buy milk' }), ME, isOwnAnswer)).toBe(true);
  });

  describe('a copy delivered to the chat mailbox — from one of the owner’s addresses, on the provider’s word', () => {
    const GMAIL_STAMP = 'mx.google.com;       dkim=pass header.i=@owner.example header.s=s1 header.b=abc;'
      + '       spf=pass (google.com: domain of me@owner.example designates 2001:db8::2 as permitted sender) '
      + 'smtp.mailfrom=me@owner.example;       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=owner.example';
    const MICROSOFT_STAMP = 'spf=pass (sender IP is 192.0.2.4) smtp.mailfrom=owner.example; dkim=pass (signature was '
      + 'verified) header.d=owner.example;dmarc=pass action=none header.from=owner.example;compauth=pass reason=100';
    const gmail = { provider_kind: 'gmail', account_email: ME } as const;
    const outlook = { provider_kind: 'graph', account_email: ME } as const;
    /** Outlook's inbox copy of an email to oneself, or one from another of the owner's addresses. */
    const delivered = (stamp: string | null = MICROSOFT_STAMP, over: Record<string, unknown> = {}) =>
      toMyself({ direction: 'inbound', ...(stamp !== null ? { headers: { 'authentication-results': stamp } } : {}), ...over });

    it('is the conversation from one of the owner’s addresses — stamped or not, on any provider (the owner, 2026-10-18)', () => {
      expect(isConversation(delivered(), one(), outlook)).toBe(true);
      expect(isConversation(delivered(GMAIL_STAMP), one(), gmail)).toBe(true);
      // Outlook's own inbox copy of an email to oneself, which no stamp may carry,
      // and an IMAP server's.
      expect(isConversation(delivered(null), one(), outlook)).toBe(true);
      expect(isConversation(delivered(null), one(), { provider_kind: 'imap', account_email: ME })).toBe(true);
      // An address they added.
      const personal = MICROSOFT_STAMP.replace(/owner\.example/g, 'personal.example');
      expect(isConversation(delivered(personal, { from: 'me@personal.example' }), one(), outlook)).toBe(true);
      // A pass a sender planted says no more than no stamp.
      expect(isConversation(delivered(GMAIL_STAMP), one(), outlook)).toBe(true);
    });

    it('⛔ never when the provider stamped its sender check failed, nor once the door refuted it', () => {
      expect(isConversation(delivered(MICROSOFT_STAMP.replace('dmarc=pass', 'dmarc=fail')), one(), outlook)).toBe(false);
      expect(isConversation(delivered(GMAIL_STAMP.replace('dmarc=pass', 'dmarc=fail')), one(), gmail)).toBe(false);
      expect(isConversation(delivered(null, { rfc_message_id: '<refuted-1@owner.example>' }), one(), outlook)).toBe(false);
      expect(isConversation(delivered(null, { rfc_message_id: '<fine-1@owner.example>' }), one(), outlook)).toBe(true);
    });

    it('⛔ never without the mailbox it landed in, nor in another one', () => {
      expect(isConversation(delivered(), one())).toBe(false);
      expect(isConversation(delivered(), one(), { provider_kind: 'graph', account_email: 'work@owner.example' })).toBe(false);
    });

    it('⛔ never from a stranger, however well their own domain passes, nor when it does not ask', () => {
      const stranger = MICROSOFT_STAMP.replace(/owner\.example/g, 'else.example');
      expect(isConversation(delivered(stranger, { from: 'eve@else.example' }), one(), outlook)).toBe(false);
      expect(isConversation(delivered(MICROSOFT_STAMP, { subject: 'Buy milk' }), one(), outlook)).toBe(false);
    });
  });

  it('createMailChatConversationMail reads one mailbox from the door each time, with the owner’s addresses', () => {
    let settings = door({
      chat_mailbox: 'mine', chat_address: ME, owner_mailboxes: ['mine', 'work'],
      enrolled_senders: [{
        address: 'me@personal.example', state: 'confirmed', chat_mailbox: 'mine', code: null, expires_at: null,
        attempts: 0, added_at: 1, confirmed_at: 2, checked_by: '', failure: null,
      }],
    });
    const continued: Array<[string, readonly string[]]> = [];
    const refutedAsked: Array<[string, string]> = [];
    // The chat mailbox's stored rows, as its collection keeps them.
    const rows = new Map<string, CollectionRecord>();
    const mail = createMailChatConversationMail({
      door: { get: () => settings },
      mailbox: (slug) => (slug === 'mine'
        ? { accountEmail: ME, get: (id: string) => rows.get(id) ?? null, upsert: (record: CollectionRecord) => { rows.set(record.record_id, record); } }
        : slug === 'work' ? { accountEmail: 'Me <me@work.example>', get: () => null } : undefined),
      isOwnAnswer,
      continues: (slug, references) => {
        continued.push([slug, references]);
        return references.includes('answer-1@chat.example');
      },
      refuted: (slug, id) => {
        refutedAsked.push([slug, id]);
        return id === 'forged-1@owner.example';
      },
    });
    const outlook = { provider_kind: 'graph', account_email: ME } as const;
    const stampFor = (domain: string) => `spf=pass (sender IP is 192.0.2.4) smtp.mailfrom=${domain}; dkim=pass `
      + `(signature was verified) header.d=${domain};dmarc=pass action=none header.from=${domain};compauth=pass reason=100`;
    expect(mail.isConversationMessage(toMyself())).toBe(true);
    expect(mail.isConversationMessage(toMyself({ subject: 'Buy milk' }))).toBe(false);
    expect(mail.isConversationMessage(toMyself({ subject: 'more', headers: { references: '<answer-1@chat.example>' } })))
      .toBe(true);
    expect(continued.at(-1)).toEqual(['mine', ['answer-1@chat.example']]);
    // Another of the owner's mailboxes, and an address they added, by the stamp.
    for (const from of ['me@work.example', 'me@personal.example']) {
      expect(mail.isConversationMessage(
        toMyself({ from, direction: 'inbound', headers: { 'authentication-results': stampFor(from.split('@')[1]!) } }),
        outlook,
      ), from).toBe(true);
    }
    // The door's word on a delivered one, by its Message-ID in the chat mailbox.
    const inbox = (id: string) => toMyself({ direction: 'inbound', rfc_message_id: `<${id}>` });
    expect(mail.isConversationMessage(inbox('fine-1@owner.example'), outlook)).toBe(true);
    expect(mail.isConversationMessage(inbox('forged-1@owner.example'), outlook)).toBe(false);
    expect(refutedAsked.at(-1)).toEqual(['mine', 'forged-1@owner.example']);
    // Refuted, a marked row is the owner's mail again; anything else is left alone.
    const row = (record_id: string, hot_fields: Record<string, unknown>) => ({
      record_id, received_at: 1, modified_at: 1, size_bytes: 0, source_id: record_id, hot_fields,
    }) as CollectionRecord;
    rows.set('forged', row('forged', { subject: 'ask: wire 5,000', [MAIL_CHAT_CONVERSATION_FIELD]: true }));
    rows.set('plain', row('plain', { subject: 'lunch' }));
    expect(mail.isConversationRecord('mine', 'forged')).toBe(true);
    mail.unmark('mine', 'forged');
    expect(mail.isConversationRecord('mine', 'forged')).toBe(false);
    expect(rows.get('forged')!.hot_fields).toEqual({ subject: 'ask: wire 5,000' });
    const plain = rows.get('plain');
    mail.unmark('mine', 'plain');
    mail.unmark('mine', 'gone');
    mail.unmark('work', 'anything');
    expect(rows.get('plain')).toBe(plain);
    // Two mailboxes again: the chat mailbox is chat-only, and a Sent copy to it alone is the conversation.
    settings = door({ chat_mailbox: 'mine', chat_address: ME, owner_mailboxes: ['work'] });
    expect(mail.isConversationMessage(toMyself({ subject: 'Buy milk' }))).toBe(true);
  });
});
