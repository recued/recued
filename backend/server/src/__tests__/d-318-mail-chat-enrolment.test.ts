/** D-318 step 8 — proof (b): enrolling an address Recued does not read.
 *
 *  The store's side (a code, its time, its tries, what each email came to, what
 *  survives a restart and a change of chat mailbox), and the email's: the code
 *  found, and the checker the stamp on it shows held to the chat mailbox's
 *  provider. ⛔ The checker is what every later request from the address is
 *  held to, so the cases that must NOT confirm matter most. The sender's own
 *  relay stamp, real in the owner's Zoho sample, is one of them.
 *
 *  The door's use of both, over real mail, is in `d-318-sent-proof.test.ts`. */

import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  mailChatCheckerOrg,
  MAIL_CHAT_ENROL_ATTEMPTS_MAX,
  MAIL_CHAT_ENROL_CODE_TTL_MS,
  MAIL_CHAT_ENROLLED_SENDERS_MAX,
  type MailChatEnrolledSender,
} from '@recued/contracts';

import { canonicalizeImap } from '../collections/mail/imap-provider.js';
import {
  GMAIL_AUTHSERV_ID,
  mailChatCheckerFits,
  mailChatEnrolOutcome,
  mailChatSameChecker,
  type MailChatEnrolChat,
  type MailChatEnrolEmail,
} from '../mail-chat-door/enrolment.js';
import { createMailChatDoorStore } from '../storage/mail-chat-door-store.js';

const START = Date.UTC(2026, 9, 14, 9, 0, 0);
const CHAT = 'recued-chat';
const ME = 'me@personal.example';

const clockedStore = (db = new Database(':memory:')) => {
  const clock = { at: START };
  const store = createMailChatDoorStore(db, () => clock.at);
  return { db, clock, store };
};

describe('D-318 step 8 — the store: an address, its code, and what came of it', () => {
  it('enrols through the chat mailbox with a fresh six-digit code, good for half an hour', () => {
    const { store } = clockedStore();
    store.setChatMailbox(CHAT, 'recued@chat.example');
    const [sender] = store.enrollSender('Me@Personal.Example').enrolled_senders;
    expect(sender).toEqual({
      address: ME, state: 'pending', chat_mailbox: CHAT, code: expect.stringMatching(/^\d{6}$/),
      expires_at: START + MAIL_CHAT_ENROL_CODE_TTL_MS, attempts: 0, added_at: START, confirmed_at: null,
      checked_by: null, failure: null,
    });
    // Again: a new code replaces the old, the address listed once.
    const codes = new Set<string>([sender!.code!]);
    for (let i = 0; i < 5; i += 1) codes.add(store.enrollSender(ME).enrolled_senders[0]!.code!);
    expect(store.get().enrolled_senders).toHaveLength(1);
    expect(codes.size).toBeGreaterThan(1);
  });

  it('enrols nobody while the door is off', () => {
    const { store } = clockedStore();
    expect(store.enrollSender(ME).enrolled_senders).toEqual([]);
  });

  it('a code past its time reads as failed, expired — and is not settled', () => {
    const { store, clock } = clockedStore();
    store.setChatMailbox(CHAT);
    store.enrollSender(ME);
    clock.at = START + MAIL_CHAT_ENROL_CODE_TTL_MS;
    expect(store.get().enrolled_senders[0]).toMatchObject({ state: 'failed', failure: 'expired', code: null });
    expect(store.settleEnrolment(CHAT, ME, { kind: 'confirmed', checked_by: 'mx.zohomail.com' })).toBeNull();
    expect(store.get().enrolled_senders[0]).toMatchObject({ state: 'failed', failure: 'expired' });
  });

  it('settles a pending address once: confirmed with its checker, or failed with why — the code spent either way', () => {
    const { store, clock } = clockedStore();
    store.setChatMailbox(CHAT);
    store.enrollSender(ME);
    clock.at = START + 60_000;
    expect(store.settleEnrolment(CHAT, ME, { kind: 'confirmed', checked_by: 'mx.zohomail.com' })).toMatchObject({
      state: 'confirmed', checked_by: 'mx.zohomail.com', confirmed_at: START + 60_000, code: null, expires_at: null,
    });
    // Settled: a second email changes nothing.
    expect(store.settleEnrolment(CHAT, ME, { kind: 'failed', failure: 'no_pass' })).toBeNull();
    store.enrollSender('other@personal.example');
    expect(store.settleEnrolment(CHAT, 'other@personal.example', { kind: 'failed', failure: 'foreign_check' }))
      .toMatchObject({ state: 'failed', failure: 'foreign_check', code: null });
    expect(store.settleEnrolment(CHAT, 'other@personal.example', { kind: 'confirmed', checked_by: 'x' })).toBeNull();
  });

  it('only the chat mailbox it was enrolled through settles it', () => {
    const { store } = clockedStore();
    store.setChatMailbox(CHAT);
    store.enrollSender(ME);
    expect(store.settleEnrolment('another-mailbox', ME, { kind: 'confirmed', checked_by: 'x' })).toBeNull();
    expect(store.get().enrolled_senders[0]!.state).toBe('pending');
  });

  it('wrong codes count, and the last one allowed fails it', () => {
    const { store } = clockedStore();
    store.setChatMailbox(CHAT);
    store.enrollSender(ME);
    for (let i = 1; i < MAIL_CHAT_ENROL_ATTEMPTS_MAX; i += 1) {
      expect(store.settleEnrolment(CHAT, ME, { kind: 'wrong_code' })).toMatchObject({ state: 'pending', attempts: i });
    }
    expect(store.settleEnrolment(CHAT, ME, { kind: 'wrong_code' })).toMatchObject({
      state: 'failed', failure: 'too_many_attempts', attempts: MAIL_CHAT_ENROL_ATTEMPTS_MAX, code: null,
    });
  });

  it('removes an address, and keeps at most five', () => {
    const { store } = clockedStore();
    store.setChatMailbox(CHAT);
    for (let i = 0; i <= MAIL_CHAT_ENROLLED_SENDERS_MAX; i += 1) store.enrollSender(`me${i}@personal.example`);
    expect(store.get().enrolled_senders).toHaveLength(MAIL_CHAT_ENROLLED_SENDERS_MAX);
    expect(store.unenrollSender('me5@personal.example').enrolled_senders.map((sender) => sender.address))
      .not.toContain('me5@personal.example');
    expect(store.unenrollSender('nobody@personal.example').enrolled_senders).toHaveLength(MAIL_CHAT_ENROLLED_SENDERS_MAX - 1);
  });

  it('switched off keeps a confirmed address for the same chat mailbox, not a code; another chat mailbox drops it', () => {
    const { store } = clockedStore();
    store.setChatMailbox(CHAT);
    store.enrollSender(ME);
    store.settleEnrolment(CHAT, ME, { kind: 'confirmed', checked_by: 'mx.zohomail.com' });
    store.enrollSender('pending@personal.example');
    // Off and on again: the way to change the owner's mailboxes.
    store.setChatMailbox(null);
    expect(store.get().enrolled_senders.map((sender) => sender.address)).toEqual([ME]);
    store.setChatMailbox(CHAT);
    expect(store.get().enrolled_senders[0]).toMatchObject({ address: ME, state: 'confirmed' });
    // Another chat mailbox: another provider makes the checks.
    store.setChatMailbox('another-mailbox');
    expect(store.get().enrolled_senders).toEqual([]);
  });

  it('a deleted chat mailbox takes its enrolments with it', () => {
    const { store } = clockedStore();
    store.setChatMailbox(CHAT);
    store.enrollSender(ME);
    store.settleEnrolment(CHAT, ME, { kind: 'confirmed', checked_by: 'mx.zohomail.com' });
    store.setChatMailbox(null);
    store.forgetMailbox(CHAT);
    expect(store.get().enrolled_senders).toEqual([]);
  });

  it('survives a restart; ⛔ a stored entry that does not parse is dropped, never read as confirmed', () => {
    const { db, store } = clockedStore();
    store.setChatMailbox(CHAT);
    store.enrollSender(ME);
    store.settleEnrolment(CHAT, ME, { kind: 'confirmed', checked_by: '' });
    const again = createMailChatDoorStore(db, () => START);
    expect(again.get().enrolled_senders).toEqual(store.get().enrolled_senders);
    // Microsoft's checker names nobody: `''` is a checker, kept.
    expect(again.get().enrolled_senders[0]!.checked_by).toBe('');
    const bad = (entry: Record<string, unknown>) => JSON.stringify({
      chat_mailbox: CHAT,
      enrolled_senders: [{ address: ME, chat_mailbox: CHAT, added_at: START, attempts: 0, ...entry }],
    });
    for (const entry of [
      { state: 'confirmed', confirmed_at: START },
      { state: 'confirmed', checked_by: 7, confirmed_at: START },
      { state: 'pending', code: '12345', expires_at: START + 1 },
      { state: 'pending', code: '123456' },
      { state: 'held' },
      { state: 'confirmed', checked_by: 'x', confirmed_at: START, address: 'not an address' },
    ]) {
      db.prepare('UPDATE mail_chat_door SET settings_json = ? WHERE id = 1').run(bad(entry));
      expect(createMailChatDoorStore(db, () => START).get().enrolled_senders, JSON.stringify(entry)).toEqual([]);
    }
  });
});

const pending = (over: Partial<MailChatEnrolledSender> = {}): MailChatEnrolledSender => ({
  address: ME, state: 'pending', chat_mailbox: CHAT, code: '482913', expires_at: START + MAIL_CHAT_ENROL_CODE_TTL_MS,
  attempts: 0, added_at: START, confirmed_at: null, checked_by: null, failure: null, ...over,
});
const ZOHO_PASS = 'mx.zohomail.com; dkim=pass; spf=pass (zohomail.com: domain of me@personal.example designates '
  + '192.0.2.10 as permitted sender) smtp.mailfrom=me@personal.example';
const email = (over: Partial<MailChatEnrolEmail> = {}): MailChatEnrolEmail => ({
  subject: 'Recued 482913', body_text: '', from_address: ME, authentication_results: ZOHO_PASS, ...over,
});
const IMAP: MailChatEnrolChat = { provider_kind: 'imap', address: 'recued@zoho.example' };

describe('D-318 step 8 — the email with the code', () => {
  it('confirms with the checker on its stamp, the code in its subject, its text or its HTML', () => {
    for (const over of [
      {},
      { subject: 'hello', body_text: 'my code: 482913\n' },
      { subject: 'hello', body_text: '', body_html: '<p>Code <b>482913</b></p>' },
      { subject: 'ask: 482913' },
    ]) {
      expect(mailChatEnrolOutcome(email(over), pending(), IMAP), JSON.stringify(over))
        .toEqual({ kind: 'confirmed', checked_by: 'mx.zohomail.com' });
    }
  });

  it('with no code it is just mail; another code in its subject is a wrong try', () => {
    expect(mailChatEnrolOutcome(email({ subject: 'lunch?' }), pending(), IMAP)).toBeNull();
    // A longer number holding the code is not the code.
    expect(mailChatEnrolOutcome(email({ subject: 'ref 14829130' }), pending(), IMAP)).toBeNull();
    expect(mailChatEnrolOutcome(email({ subject: 'Recued 482914' }), pending(), IMAP)).toEqual({ kind: 'wrong_code' });
    // A number in the text is not a try: a signature carries phone numbers.
    expect(mailChatEnrolOutcome(email({ subject: 'hi', body_text: 'call 555123' }), pending(), IMAP)).toBeNull();
    // Only a pending address has a code.
    expect(mailChatEnrolOutcome(email(), pending({ state: 'confirmed', code: null }), IMAP)).toBeNull();
  });

  it('says why a stamp cannot confirm it', () => {
    const cases: Array<[string | undefined, string]> = [
      [undefined, 'no_check'],
      // The sender's own server's stamp on top: a chat server that stamps nothing.
      ['mail.personal.example; spf=pass smtp.mailfrom=me@personal.example', 'foreign_check'],
      ['spf=pass smtp.mailfrom=personal.example;dmarc=pass action=none header.from=personal.example', 'foreign_check'],
      ['mx.zohomail.com; spf=pass smtp.mailfrom=me@personal.example; dmarc=fail header.from=personal.example', 'failed_check'],
      ['mx.zohomail.com; spf=pass smtp.mailfrom=bounce.personal.example', 'no_pass'],
    ];
    for (const [stamp, failure] of cases) {
      expect(mailChatEnrolOutcome(email({ authentication_results: stamp }), pending(), IMAP), String(stamp))
        .toEqual({ kind: 'failed', failure });
    }
  });

  it('holds the checker to the chat mailbox’s provider', () => {
    // Gmail's stamp names Gmail, and only that.
    const gmail: MailChatEnrolChat = { provider_kind: 'gmail', address: 'recued@gmail.example' };
    expect(mailChatCheckerFits(GMAIL_AUTHSERV_ID, 'personal.example', gmail)).toBe(true);
    expect(mailChatCheckerFits('mx.zohomail.com', 'personal.example', gmail)).toBe(false);
    expect(mailChatCheckerFits('', 'personal.example', gmail)).toBe(false);
    // Microsoft's names nobody, and only that.
    const graph: MailChatEnrolChat = { provider_kind: 'graph', address: 'recued@outlook.example' };
    expect(mailChatCheckerFits('', 'personal.example', graph)).toBe(true);
    expect(mailChatCheckerFits('mx.zohomail.com', 'personal.example', graph)).toBe(false);
    // Any other names itself, outside the sender's domain — unless the chat
    // mailbox is in that domain too, where one server holds both.
    expect(mailChatCheckerFits('mx.zohomail.com', 'personal.example', IMAP)).toBe(true);
    expect(mailChatCheckerFits('', 'personal.example', IMAP)).toBe(false);
    expect(mailChatCheckerFits('personal.example', 'personal.example', IMAP)).toBe(false);
    expect(mailChatCheckerFits('mx.mail.personal.example', 'personal.example', IMAP)).toBe(false);
    expect(mailChatCheckerFits('mx.personal.example', 'personal.example',
      { provider_kind: 'imap', address: 'recued@personal.example' })).toBe(true);
    // A provider not known reads as IMAP.
    expect(mailChatCheckerFits('', 'personal.example', { provider_kind: undefined, address: '' })).toBe(false);
    // The sender's own relay, for an address on a subdomain: still the sender's organisation.
    expect(mailChatCheckerFits('relay.firm.example', 'mail.firm.example', IMAP)).toBe(false);
  });

  it('a provider is its organisation, not the host: each receiving host names itself', () => {
    expect(mailChatCheckerOrg('mx3.messagingengine.com')).toBe('messagingengine.com');
    expect(mailChatCheckerOrg('atlas-production.v2-mail-prod1-gq1.omega.yahoo.com')).toBe('yahoo.com');
    expect(mailChatCheckerOrg('MX.Google.COM')).toBe('google.com');
    expect(mailChatCheckerOrg('mail.example.co.uk')).toBe('example.co.uk');
    expect(mailChatCheckerOrg('zohomail.com')).toBe('zohomail.com');
    expect(mailChatCheckerOrg('')).toBe('');
    expect(mailChatSameChecker('mx1.messagingengine.com', 'mx3.messagingengine.com')).toBe(true);
    expect(mailChatSameChecker('', '')).toBe(true);
    expect(mailChatSameChecker('mx.zohomail.com', 'mx.google.com')).toBe(false);
    expect(mailChatSameChecker('', 'mx.zohomail.com')).toBe(false);
    // Without a stamp, or before a checker is known: never the same.
    expect(mailChatSameChecker(null, 'mx.zohomail.com')).toBe(false);
    expect(mailChatSameChecker('mx.zohomail.com', null)).toBe(false);
    // No stamp is not Microsoft's, which is a stamp naming no checker.
    expect(mailChatSameChecker(null, '')).toBe(false);
  });
});

/** The owner's real Zoho sample (its structure, every word replaced). Zoho's
 *  stamp is on top, and BELOW it the sender's own relay's: an SPF pass for the
 *  sender's own domain. */
describe('D-318 step 8 — over the real Zoho sample', () => {
  const SOURCE = readFileSync(new URL('./fixtures/mail-outlook-reply-in-zoho/reply.eml', import.meta.url), 'latin1');
  const parse = (source: string) => canonicalizeImap(Buffer.from(source, 'latin1'),
    { uid: 7, folder: 'INBOX', flags: new Set(), internalDate: new Date('2026-09-24T06:35:36Z') });
  const sender = pending({ address: 'sender@firm.example' });
  const asEnrolment = (msg: Awaited<ReturnType<typeof parse>>): MailChatEnrolEmail => ({
    subject: 'Recued 482913', body_text: msg.body_text, from_address: 'sender@firm.example',
    authentication_results: msg.headers?.['authentication-results'],
  });

  it('Zoho’s own stamp confirms it: no DMARC result, but an SPF pass for exactly the sender’s domain', async () => {
    const msg = await parse(SOURCE);
    expect(mailChatEnrolOutcome(asEnrolment(msg), sender, IMAP)).toEqual({ kind: 'confirmed', checked_by: 'mx.zohomail.com' });
  });

  it('⛔ on a chat server that stamps nothing, the sender’s relay stamp is on top, and confirms nothing', async () => {
    // The same email with Zoho's stamp gone: the relay's is the first.
    const unstamped = SOURCE.replace(/^Authentication-Results: mx\.zohomail\.com;\r?\n(?:[ \t].*\r?\n)*/m, '');
    expect(unstamped).not.toBe(SOURCE);
    const msg = await parse(unstamped);
    expect(msg.headers?.['authentication-results']).toMatch(/^relay\.firm\.example;/);
    // It is a pass for the sender's own domain, written by that domain's server…
    expect(mailChatEnrolOutcome(asEnrolment(msg), sender, IMAP)).toEqual({ kind: 'failed', failure: 'foreign_check' });
    // …which can be the checker only where that server also holds the chat
    // mailbox.
    expect(mailChatEnrolOutcome(asEnrolment(msg), sender, { provider_kind: 'imap', address: 'recued@firm.example' }))
      .toEqual({ kind: 'confirmed', checked_by: 'relay.firm.example' });
  });
});
