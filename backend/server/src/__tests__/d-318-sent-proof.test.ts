/** D-318 step 2 — proof (a): a message in the chat mailbox is the owner's only
 *  when the owner's own mailbox sent it.
 *
 *  Over a real SQLite table and the real door store; the mailboxes are the
 *  narrow part the proof reads, each provider's lookup pinned on its own in
 *  `collections/mail/__tests__/d-318-sent-lookup-by-message-id.test.ts`.
 *
 *  ⛔ What must never happen, each pinned below: a message not proven starts
 *  something (handed to chat); a forged flood floods the owner (more than one
 *  notice an hour); an outage reads as "not sent"; a notice quotes what a
 *  forger wrote; a restart loses a request or a notice. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIL_CHAT_BURST_MAX, type MailSentByMessageIdResult } from '@recued/contracts';

import type { MailStoredContext, MailUpsertAttachment } from '../collections/mail/mail-collection.js';
import { mailHeaderMap, normalizeRfcMessageId, type CanonicalMessage } from '../collections/mail/provider.js';
import { createCollectionTable } from '../collections/table.js';
import {
  createMailChatSentProof,
  mailChatBurstNotice,
  MAIL_CHAT_ADMIT_GIVE_UP_MS,
  MAIL_CHAT_ATTACHMENTS_WAIT_MS,
  MAIL_CHAT_PROOF_KEEP_MS,
  MAIL_CHAT_PROOF_WAIT_MS,
  type MailChatAdmit,
  type MailChatProofMailbox,
  type MailChatSentProof,
} from '../mail-chat-door/sent-proof.js';
import { createMailChatDoorStore } from '../storage/mail-chat-door-store.js';
import { createMailChatConversations, type MailChatConversations } from '../mail-chat-door/conversations.js';

const CHAT = 'recued-chat';
const CHAT_ADDRESS = 'recued@chat.example';
const OWNER = 'me';
const OWNER_ADDRESS = 'me@owner.example';
const ID = 'req-1@owner.example';
const START = Date.UTC(2026, 9, 14, 9, 0, 0);

let clock = START;
const open: MailChatSentProof[] = [];
const dbs: Database.Database[] = [];

beforeEach(() => { clock = START; });
afterEach(async () => {
  for (const proof of open.splice(0)) await proof.dispose();
  for (const db of dbs.splice(0)) db.close();
});

type Lookup = MailChatProofMailbox['lookupSentByMessageId'];
const notFound = async (): Promise<MailSentByMessageIdResult> => ({ status: 'not_found' });
const sent = (over: { to?: string[]; sent_at?: number } = {}): MailSentByMessageIdResult => ({
  status: 'found',
  matches: [{ to: over.to ?? ['Recued@Chat.example'], subject: 'ask: what is on today?', sent_at: over.sent_at ?? clock - 5_000 }],
});

const harness = (opts: {
  db?: Database.Database;
  lookup?: Lookup;
  auditLog?: boolean;
  bind?: boolean;
  mailboxes?: MailChatProofMailbox[];
  /** The mailboxes the owner names as theirs (P20); the owner's by default. */
  owners?: string[];
  /** The conversations a reply may continue (step 4). */
  conversations?: MailChatConversations;
  /** Whether the vault is open; always, unless given. */
  isUnlocked?: () => boolean;
} = {}) => {
  const db = opts.db ?? new Database(':memory:');
  if (opts.db === undefined) dbs.push(db);
  const door = createMailChatDoorStore(db);
  door.setChatMailbox(CHAT);
  door.setOwnerMailboxes(opts.owners ?? [OWNER]);
  const lookup = vi.fn<Lookup>(opts.lookup ?? notFound);
  const chatLookup = vi.fn<Lookup>(async () => { throw new Error('the chat mailbox is never asked'); });
  const mailboxes: MailChatProofMailbox[] = opts.mailboxes ?? [
    { platform: 'mail', slug: CHAT, accountEmail: CHAT_ADDRESS, lookupSentByMessageId: chatLookup },
    { platform: 'mail', slug: OWNER, accountEmail: 'Me@Owner.example', lookupSentByMessageId: lookup },
  ];
  const logActivity = vi.fn(async () => undefined);
  const notify = vi.fn(async () => undefined);
  const admit = vi.fn<MailChatAdmit>(async () => ({ outcome: 'admitted' }));
  const log = vi.fn<(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void>();
  const proof = createMailChatSentProof({
    db,
    door,
    ...(opts.conversations ? { conversations: opts.conversations } : {}),
    mailboxes: () => mailboxes,
    ...(opts.auditLog === false ? {} : { auditLog: { logActivity } }),
    ...(opts.isUnlocked ? { isUnlocked: opts.isUnlocked } : {}),
    now: () => clock,
    log,
  });
  open.push(proof);
  if (opts.bind !== false) {
    proof.bindNotify(notify);
    proof.bindAdmit(admit);
  }
  return { db, door, proof, lookup, chatLookup, mailboxes, logActivity, notify, admit, log };
};

const request = (over: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id: 'chat-1',
  rfc_message_id: `<${ID}>`,
  from: OWNER_ADDRESS,
  to: [CHAT_ADDRESS],
  cc: [],
  subject: 'ask: what is on today?',
  thread_id: 't-1',
  folder_or_label: 'INBOX',
  direction: 'inbound',
  is_read: false,
  is_flagged: false,
  has_attachments: false,
  received_at: clock,
  provider_received_at: clock,
  body_text: 'what is on today?',
  ...over,
});

const stored = (over: Partial<MailStoredContext> = {}): MailStoredContext => ({
  slug: CHAT,
  record_id: 'mail:chat-1',
  backfill_complete: true,
  backfill_days: 30,
  ...over,
});

/** The mailbox's own row, which the mail stack writes before it tells the
 *  door: the proof reads a Message-ID's copies from it (the first copy alone
 *  can be a request). */
const keep = (db: Database.Database, msg: CanonicalMessage, ctx: MailStoredContext): void => {
  const rfc_message_id = normalizeRfcMessageId(msg.rfc_message_id);
  createCollectionTable({ db, platform: 'mail', slug: ctx.slug }).upsert({
    record_id: ctx.record_id,
    received_at: clock,
    modified_at: clock,
    hot_fields: { from: msg.from, subject: msg.subject, ...(rfc_message_id === undefined ? {} : { rfc_message_id }) },
    size_bytes: 0,
    source_id: msg.source_id,
  });
};

/** The row lands, and the door is told — its attachments not yet stored. */
const store = (
  h: { db: Database.Database; proof: MailChatSentProof },
  msg: CanonicalMessage,
  ctx: MailStoredContext,
): void => {
  keep(h.db, msg, ctx);
  h.proof.onMessageStored(msg, ctx);
};

/** As the mail stack tells it: the row lands, then its attachments are stored
 *  (none, unless given) — step 4's hand-over waits for the second. */
const land = (
  h: { db: Database.Database; proof: MailChatSentProof },
  msg: CanonicalMessage,
  ctx: MailStoredContext,
  attachments: MailUpsertAttachment[] = [],
): void => {
  store(h, msg, ctx);
  h.proof.onMessageUpserted(msg, { ...ctx, account_email: CHAT_ADDRESS, first_seen: true, attachments });
};

/** Tick every 15 seconds until the request is settled, or `limitMs` passes. */
const runUntilSettled = async (proof: MailChatSentProof, id = ID, limitMs = 2 * MAIL_CHAT_PROOF_WAIT_MS) => {
  const until = clock + limitMs;
  await proof.tick();
  while (proof.get(CHAT, id)?.state === 'pending' && clock < until) {
    clock += 15_000;
    await proof.tick();
  }
  return proof.get(CHAT, id);
};

describe('D-318 step 2 — proof (a), the owner’s Sent record', () => {
  it('proves a request by the owner’s Sent record, once, and hands it on once', async () => {
    const h = harness({ lookup: async () => sent() });
    land(h, request(), stored());
    await h.proof.tick();

    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.lookup).toHaveBeenCalledWith({ rfc_message_id: ID });
    expect(h.chatLookup).not.toHaveBeenCalled();
    expect(h.proof.get(CHAT, ID)).toMatchObject({
      state: 'proven', reason: null, proven_by: OWNER, attempts: 1, from_address: OWNER_ADDRESS, record_id: 'mail:chat-1',
    });
    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.admit.mock.calls[0]![0]).toMatchObject({ chat_slug: CHAT, rfc_message_id: ID, state: 'proven' });
    expect(h.notify).not.toHaveBeenCalled();

    // A second copy under the same Message-ID is not another request.
    land(h, request({ source_id: 'chat-2' }), stored({ record_id: 'mail:chat-2' }));
    await h.proof.tick();
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.proof.get(CHAT, ID)?.record_id).toBe('mail:chat-1');
  });

  it('asks again while the Sent copy is not there yet, and proves it when it appears', async () => {
    const answers: MailSentByMessageIdResult[] = [{ status: 'not_found' }, { status: 'not_found' }];
    const h = harness({ lookup: async () => answers.shift() ?? sent() });
    land(h, request(), stored());

    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'pending', attempts: 1 });
    await h.proof.tick();
    expect(h.lookup).toHaveBeenCalledTimes(1); // not due again yet

    clock += 15_000;
    await h.proof.tick();
    clock += 30_000;
    await h.proof.tick();
    expect(h.lookup).toHaveBeenCalledTimes(3);
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven', attempts: 3 });
    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('gives up after ten minutes with one notice — its history row first, then the push — and never quotes the email', async () => {
    const h = harness();
    land(h, request({ subject: 'ask: URGENT: sign in at evil.example', body_text: 'evil' }), stored());
    const settled = await runUntilSettled(h.proof);

    expect(settled).toMatchObject({ state: 'not_proven', reason: 'not_in_sent' });
    // The schedule: at 0, 15 s, 45 s, 1:45, 3:45, 6:45, 9:45, and 10:00.
    expect(h.lookup).toHaveBeenCalledTimes(8);
    expect(clock - START).toBe(MAIL_CHAT_PROOF_WAIT_MS);
    expect(h.admit).not.toHaveBeenCalled();

    expect(h.logActivity).toHaveBeenCalledTimes(1);
    const activity = (h.logActivity.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(activity).toMatchObject({ action: 'notification_fired', target: 'mail_chat_door' });
    expect(activity.activity_id).toMatch(/^mail-chat-proof:[0-9a-f]{32}$/);
    expect(h.notify).toHaveBeenCalledTimes(1);
    const [message, extras] = h.notify.mock.calls[0] as unknown as [{ title: string; text: string }, unknown];
    expect(extras).toEqual({ persisted_activity_id: activity.activity_id });
    expect(JSON.parse(activity.detail as string)).toEqual(message);
    expect(h.logActivity.mock.invocationCallOrder[0]).toBeLessThan(h.notify.mock.invocationCallOrder[0]!);
    expect(message.text).toContain(OWNER_ADDRESS);
    expect(message.text).toContain(CHAT_ADDRESS);
    expect(message.text).toContain('Sent folder');
    expect(`${message.title} ${message.text}`).not.toMatch(/evil|URGENT/);

    clock += 60_000;
    await h.proof.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.lookup).toHaveBeenCalledTimes(8);
  });

  it('gives at most one notice an hour: a second unproven request inside it is held back', async () => {
    const h = harness();
    const second = 'req-2@owner.example';
    const third = 'req-3@owner.example';

    land(h, request(), stored());
    await runUntilSettled(h.proof);
    expect(h.notify).toHaveBeenCalledTimes(1);

    clock += 10 * 60_000;
    land(h, request({ rfc_message_id: `<${second}>` }), stored({ record_id: 'mail:chat-2' }));
    expect(await runUntilSettled(h.proof, second)).toMatchObject({ state: 'not_proven', reason: 'not_in_sent' });
    expect(h.notify).toHaveBeenCalledTimes(1);

    clock += 45 * 60_000; // an hour and five minutes after the first notice
    land(h, request({ rfc_message_id: `<${third}>` }), stored({ record_id: 'mail:chat-3' }));
    await runUntilSettled(h.proof, third);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it('a Sent message with the id that was not sent to the chat mailbox proves nothing, at once', async () => {
    const h = harness({ lookup: async () => sent({ to: ['someone@else.example'] }) });
    land(h, request(), stored());
    await h.proof.tick();

    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'not_proven', reason: 'mismatch', attempts: 1 });
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect((h.notify.mock.calls[0] as unknown as [{ text: string }])[0].text).toContain('copy');
  });

  it('a request replayed under an old Message-ID finds an old Sent record and proves nothing', async () => {
    const h = harness({ lookup: async () => sent({ sent_at: clock - 3 * 86_400_000 }) });
    land(h, request(), stored());
    await h.proof.tick();

    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'not_proven', reason: 'mismatch' });
    expect(h.admit).not.toHaveBeenCalled();
  });

  it('measures the replay window from the chat mailbox provider’s time, never the Date line', async () => {
    // Sent four hours ago and received then: delivered late to Recued, not old.
    const h = harness({ lookup: async () => sent({ sent_at: START - 4 * 3_600_000 }) });
    land(h, 
      request({ provider_received_at: START - 4 * 3_600_000 + 2_000, received_at: START }),
      stored(),
    );
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven' });

    // A forged Date line cannot pull an old Sent record into the window.
    const ID2 = 'req-2@owner.example';
    h.lookup.mockImplementation(async () => sent({ sent_at: START - 3 * 86_400_000 }));
    land(h, 
      request({ rfc_message_id: `<${ID2}>`, received_at: START - 3 * 86_400_000 }),
      stored({ record_id: 'mail:chat-2' }),
    );
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID2)).toMatchObject({ state: 'not_proven', reason: 'mismatch' });
  });

  it('never reads an outage as not sent: asked again, proven when the mailbox answers', async () => {
    const answers: MailSentByMessageIdResult[] = [
      { status: 'unavailable', reason: 'provider_error' },
      { status: 'unavailable', reason: 'provider_error' },
    ];
    const h = harness({ lookup: async () => answers.shift() ?? sent() });
    land(h, request(), stored());
    expect(await runUntilSettled(h.proof)).toMatchObject({ state: 'proven', attempts: 3 });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a mailbox that never answers is given up on after the wait, and the notice says it could not be reached', async () => {
    const h = harness({ lookup: async () => ({ status: 'unavailable', reason: 'provider_error' }) });
    land(h, request(), stored());
    expect(await runUntilSettled(h.proof)).toMatchObject({ state: 'not_proven', reason: 'unreachable' });
    expect((h.notify.mock.calls[0] as unknown as [{ text: string }])[0].text).toContain('could not reach');
  });

  it('a lookup that throws is an outage, not a refusal', async () => {
    let calls = 0;
    const h = harness({
      lookup: async () => {
        calls += 1;
        if (calls === 1) throw new Error('socket hang up');
        return sent();
      },
    });
    land(h, request(), stored());
    expect(await runUntilSettled(h.proof)).toMatchObject({ state: 'proven', attempts: 2 });
  });

  it('a provider that cannot be asked at all is settled at once', async () => {
    const h = harness({ lookup: async () => ({ status: 'unavailable', reason: 'unsupported' }) });
    land(h, request(), stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'not_proven', reason: 'unsupported', attempts: 1 });
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('proves through another of the owner’s mailboxes at their address', async () => {
    const second = vi.fn<Lookup>(async () => sent());
    const h = harness({ owners: [OWNER, 'me-again'] });
    h.mailboxes.push({ platform: 'mail', slug: 'me-again', accountEmail: OWNER_ADDRESS, lookupSentByMessageId: second });
    land(h, request(), stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven', proven_by: 'me-again' });
    expect(h.lookup).toHaveBeenCalledTimes(1);
  });

  it('sets a stranger’s mail, a copy, and the chat mailbox’s own address aside — no lookup, no notice', async () => {
    const h = harness({ lookup: async () => sent() });
    land(h, request({ rfc_message_id: '<a@x.example>', from: 'stranger@else.example' }), stored({ record_id: 'r-a' }));
    land(h, 
      request({ rfc_message_id: '<b@x.example>', to: ['client@else.example'], cc: [CHAT_ADDRESS] }),
      stored({ record_id: 'r-b' }),
    );
    land(h, request({ rfc_message_id: '<c@x.example>', from: CHAT_ADDRESS }), stored({ record_id: 'r-c' }));
    await h.proof.tick();

    expect(h.proof.get(CHAT, 'a@x.example')).toMatchObject({ state: 'ignored', reason: 'not_owner' });
    expect(h.proof.get(CHAT, 'b@x.example')).toMatchObject({ state: 'ignored', reason: 'not_addressed' });
    expect(h.proof.get(CHAT, 'c@x.example')).toMatchObject({ state: 'ignored', reason: 'not_owner' });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.chatLookup).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
  });

  it('records nothing that cannot be a request', async () => {
    const h = harness({ lookup: async () => sent() });
    const cases: Array<[string, Partial<CanonicalMessage>, Partial<MailStoredContext>]> = [
      ['another mailbox', {}, { slug: OWNER }],
      ['the chat mailbox’s first backfill', {}, { backfill_complete: false }],
      ['Recued’s own answer', { reconciliation_id: 'd318-answer-1' }, {}],
      ['sent by the chat mailbox', { direction: 'outbound' }, {}],
      ['a draft', { direction: 'draft' }, {}],
      ['no Message-ID', { rfc_message_id: undefined }, {}],
      ['a Message-ID with a space', { rfc_message_id: '<a b@owner.example>' }, {}],
      ['a Message-ID without an @', { rfc_message_id: '<no-at-sign>' }, {}],
    ];
    for (const [, msg, ctx] of cases) land(h, request(msg), stored(ctx));
    await h.proof.tick();
    const rows = h.db.prepare('SELECT COUNT(*) AS n FROM mail_chat_requests').get() as { n: number };
    expect(rows.n).toBe(0);
    expect(h.lookup).not.toHaveBeenCalled();

    h.door.setChatMailbox(null);
    land(h, request(), stored());
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM mail_chat_requests').get() as { n: number }).n).toBe(0);
  });

  it('decides whose a message is when it is checked: an owner’s mailbox registered after it landed still proves it', async () => {
    const lookup = vi.fn<Lookup>(async () => sent());
    const mailboxes: MailChatProofMailbox[] = [
      { platform: 'mail', slug: CHAT, accountEmail: CHAT_ADDRESS, lookupSentByMessageId: vi.fn<Lookup>() },
    ];
    const h = harness({ mailboxes });
    land(h, request(), stored());
    mailboxes.push({ platform: 'mail', slug: OWNER, accountEmail: OWNER_ADDRESS, lookupSentByMessageId: lookup });
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven', proven_by: OWNER });
  });

  it('waits for the chat mailbox to be registered, then sets the message aside when it never is', async () => {
    const h = harness({ mailboxes: [] });
    land(h, request(), stored());
    expect(await runUntilSettled(h.proof)).toMatchObject({ state: 'ignored', reason: 'no_chat_mailbox' });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('sets a request aside silently when the door changed before its check', async () => {
    const h = harness({ lookup: async () => sent() });
    land(h, request(), stored());
    h.door.setChatMailbox('another-mailbox');
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'ignored', reason: 'door_changed' });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('D-318 step 2 — what survives a restart', () => {
  it('a request a restart left unchecked is checked after the start, with a full wait from there', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const first = harness({ db });
    land(first, request(), stored());
    await first.proof.dispose();

    clock += 2 * 3_600_000;
    const second = harness({ db });
    second.proof.start();
    await second.proof.tick();
    // Long past its own ten minutes, but asked again from the start.
    expect(second.proof.get(CHAT, ID)).toMatchObject({ state: 'pending', attempts: 1 });
    expect(second.notify).not.toHaveBeenCalled();

    second.lookup.mockImplementation(async () => sent({ sent_at: START - 1_000 }));
    clock += 15_000;
    await second.proof.tick();
    expect(second.proof.get(CHAT, ID)).toMatchObject({ state: 'proven' });
    expect(second.admit).toHaveBeenCalledTimes(1);
  });

  it('a notice decided before the notifier was bound waits for it, and is given once', async () => {
    const h = harness({ bind: false, lookup: async () => sent({ to: ['someone@else.example'] }) });
    land(h, request(), stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'not_proven', reason: 'mismatch' });
    expect(h.logActivity).not.toHaveBeenCalled();

    h.proof.bindNotify(h.notify);
    await h.proof.tick();
    await h.proof.tick();
    expect(h.logActivity).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('a notice not yet given when the server stopped is given at the next start, onto the same history row', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const first = harness({ db, bind: false, lookup: async () => sent({ to: ['someone@else.example'] }) });
    land(first, request(), stored());
    await first.proof.tick();
    await first.proof.dispose();

    const second = harness({ db });
    await second.proof.tick();
    expect(second.notify).toHaveBeenCalledTimes(1);
    expect(second.logActivity).toHaveBeenCalledTimes(1);
  });

  it('a failed history write gives the notice at the next round, not never', async () => {
    const h = harness({ lookup: async () => sent({ to: ['someone@else.example'] }) });
    h.logActivity.mockRejectedValueOnce(new Error('disk full'));
    land(h, request(), stored());
    await h.proof.tick();
    expect(h.notify).not.toHaveBeenCalled();

    await h.proof.tick();
    expect(h.logActivity).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('without a history store the notifier writes the row: no history id is claimed', async () => {
    const h = harness({ auditLog: false, lookup: async () => sent({ to: ['someone@else.example'] }) });
    land(h, request(), stored());
    await h.proof.tick();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]).toHaveLength(1);
  });

  it('removes settled requests after a week, never one still waiting', async () => {
    const h = harness({ lookup: async () => sent() });
    land(h, request(), stored());
    await h.proof.tick();
    h.lookup.mockImplementation(notFound);
    clock += MAIL_CHAT_PROOF_KEEP_MS + 60_000;
    land(h, request({ rfc_message_id: '<waiting@owner.example>' }), stored({ record_id: 'r-w' }));
    await h.proof.tick();

    expect(h.proof.get(CHAT, ID)).toBeNull();
    expect(h.proof.get(CHAT, 'waiting@owner.example')).toMatchObject({ state: 'pending' });
  });

  it('once disposed, records nothing and waits for a check in progress without settling it', async () => {
    let release!: (result: MailSentByMessageIdResult) => void;
    const h = harness({ lookup: () => new Promise((resolve) => { release = resolve; }) });
    land(h, request(), stored());
    const round = h.proof.tick();
    await vi.waitFor(() => expect(h.lookup).toHaveBeenCalledTimes(1));

    let disposed = false;
    const disposing = h.proof.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release(sent());
    await disposing;
    await round;

    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'pending' });
    expect(h.admit).not.toHaveBeenCalled();
    land(h, request({ rfc_message_id: '<late@owner.example>' }), stored({ record_id: 'r-l' }));
    expect(h.proof.get(CHAT, 'late@owner.example')).toBeNull();
  });

  it('started and idle, a stored request is checked at once, not at a timer', async () => {
    const h = harness({ lookup: async () => sent() });
    h.proof.start();
    // The first round done: nothing waits, so no timer is set.
    await h.proof.tick();
    land(h, request(), stored());
    await vi.waitFor(() => expect(h.proof.get(CHAT, ID)?.state).toBe('proven'), { timeout: 500 });
  });
});

describe('D-318 step 3 — the hand-over to chat', () => {
  it('hands a proven request to chat once, with the Message-IDs it refers to, nearest first', async () => {
    const h = harness({ lookup: async () => sent() });
    land(h, request({
      headers: { 'in-reply-to': '<answer-1@chat.example>', references: '<req-0@owner.example> <answer-1@chat.example>' },
    }), stored());
    await h.proof.tick();

    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.admit.mock.calls[0]![0]).toMatchObject({
      chat_slug: CHAT,
      rfc_message_id: ID,
      record_id: 'mail:chat-1',
      from_address: OWNER_ADDRESS,
      references: ['answer-1@chat.example', 'req-0@owner.example'],
    });
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven', admit_state: 'admitted' });
    clock += 60_000;
    await h.proof.tick();
    expect(h.admit).toHaveBeenCalledTimes(1);
  });

  it('asks chat again after a failure, and hands it over when chat takes it', async () => {
    const h = harness({ lookup: async () => sent() });
    h.admit.mockRejectedValueOnce(new Error('Chat vault is locked.'));
    land(h, request(), stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ admit_state: 'waiting' });

    await h.proof.tick();
    expect(h.admit).toHaveBeenCalledTimes(1); // not due again yet
    clock += 15_000;
    await h.proof.tick();
    expect(h.admit).toHaveBeenCalledTimes(2);
    expect(h.proof.get(CHAT, ID)).toMatchObject({ admit_state: 'admitted' });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('gives up an hour after the proof, with one notice that quotes nothing of the email', async () => {
    const h = harness({ lookup: async () => sent() });
    h.admit.mockRejectedValue(new Error('The conversation queue is full.'));
    land(h, request({ subject: 'ask: URGENT: sign in at evil.example' }), stored());
    await h.proof.tick();
    const until = START + MAIL_CHAT_ADMIT_GIVE_UP_MS + 10 * 60_000;
    while (h.proof.get(CHAT, ID)?.admit_state === 'waiting' && clock < until) {
      clock += 60_000;
      await h.proof.tick();
    }

    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven', admit_state: 'gave_up' });
    expect(clock - START).toBeGreaterThanOrEqual(MAIL_CHAT_ADMIT_GIVE_UP_MS);
    expect(h.notify).toHaveBeenCalledTimes(1);
    const [message] = h.notify.mock.calls[0] as unknown as [{ title: string; text: string }];
    expect(message.text).toContain(OWNER_ADDRESS);
    expect(message.text).toContain(CHAT_ADDRESS);
    expect(`${message.title} ${message.text}`).not.toMatch(/evil|URGENT/);
    const calls = h.admit.mock.calls.length;
    clock += 60 * 60_000;
    await h.proof.tick();
    expect(h.admit).toHaveBeenCalledTimes(calls);
  });

  it('a request chat refuses for good is not asked again, and tells nobody', async () => {
    const h = harness({ lookup: async () => sent() });
    h.admit.mockResolvedValue({ outcome: 'dropped', reason: 'the email is no longer in the chat mailbox' });
    land(h, request(), stored());
    await h.proof.tick();
    clock += 10 * 60_000;
    await h.proof.tick();

    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.proof.get(CHAT, ID)).toMatchObject({ admit_state: 'dropped' });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('proven before chat is there, it waits — without the timer spinning — and is handed over once chat is bound', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ bind: false, lookup: async () => sent() });
      h.proof.start();
      land(h, request(), stored());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven', admit_state: 'waiting' });
      // A due hand-over with nowhere to go must not wake the timer at once,
      // over and over. ⚠ The fake clock does not refuse that loop on its own
      // (it ran 300,002 wake-ups in these five minutes), so count them.
      const timeouts = vi.spyOn(globalThis, 'setTimeout');
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(timeouts.mock.calls.length).toBeLessThan(10);
      timeouts.mockRestore();

      h.proof.bindAdmit(h.admit);
      await vi.advanceTimersByTimeAsync(0);
      await h.proof.tick();
      expect(h.admit).toHaveBeenCalledTimes(1);
      expect(h.proof.get(CHAT, ID)).toMatchObject({ admit_state: 'admitted' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hand-over a stop left waiting is made after the next start', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const first = harness({ db, bind: false, lookup: async () => sent() });
    land(first, request(), stored());
    await first.proof.tick();
    await first.proof.dispose();
    expect(first.proof.get(CHAT, ID)).toMatchObject({ admit_state: 'waiting' });

    const second = harness({ db });
    await second.proof.tick();
    expect(second.admit).toHaveBeenCalledTimes(1);
    expect(second.proof.get(CHAT, ID)).toMatchObject({ admit_state: 'admitted' });
  });

  it('keeps a request waiting for chat past the week a settled one is kept', async () => {
    const h = harness({ bind: false, lookup: async () => sent() });
    land(h, request(), stored());
    await h.proof.tick();
    clock += MAIL_CHAT_PROOF_KEEP_MS + 60_000;
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ admit_state: 'waiting' });
  });

  it('upgrades the table step 2 made: its columns join, and a request goes through', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    db.exec(`CREATE TABLE mail_chat_requests (
      chat_slug TEXT NOT NULL, rfc_message_id TEXT NOT NULL, record_id TEXT NOT NULL, from_address TEXT NOT NULL,
      to_json TEXT NOT NULL, arrived_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'proven', 'not_proven', 'ignored')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, reason TEXT, proven_by TEXT, resolved_at INTEGER,
      notice_state TEXT NOT NULL DEFAULT 'none' CHECK (notice_state IN ('none', 'due', 'sent', 'suppressed')),
      notice_at INTEGER, notice_json TEXT, PRIMARY KEY (chat_slug, rfc_message_id))`);
    db.prepare(`INSERT INTO mail_chat_requests (chat_slug, rfc_message_id, record_id, from_address, to_json, arrived_at,
      received_at, state, next_attempt_at) VALUES (?, ?, 'mail:old', ?, ?, ?, ?, 'pending', ?)`)
      .run(CHAT, 'old@owner.example', OWNER_ADDRESS, JSON.stringify([CHAT_ADDRESS]), START - 10 * 60_000, START, START);

    const h = harness({ db, lookup: async () => sent() });
    await h.proof.tick();
    expect(h.proof.get(CHAT, 'old@owner.example')).toMatchObject({ state: 'proven', admit_state: 'admitted', references: [] });
    expect(h.admit).toHaveBeenCalledTimes(1);
  });
});

describe('D-318 step 4 — what is not a request is never looked up', () => {
  const rows = (db: Database.Database): string[] =>
    (db.prepare('SELECT rfc_message_id AS id FROM mail_chat_requests ORDER BY id').all() as Array<{ id: string }>)
      .map((row) => row.id);

  it('declines automatic mail — each of §4.7’s signs — and an emailed approval answer', async () => {
    const h = harness({ lookup: async () => sent() });
    const declined: Array<Partial<CanonicalMessage>> = [
      { headers: { 'auto-submitted': 'auto-replied' } },
      { headers: { 'x-autoreply': 'yes' } },
      { headers: { precedence: 'bulk' } },
      { headers: { 'list-id': '<list.example.test>' } },
      { headers: { 'content-type': 'multipart/report; report-type=delivery-status' } },
      { headers: { 'return-path': '<>' } },
      { subject: 'Re: ask: [#ask-0f9b] Approve the invoice?' },
    ];
    for (const [i, over] of declined.entries()) {
      land(h, request({ rfc_message_id: `<auto-${i}@owner.example>`, ...over }), stored({ record_id: `r-${i}` }));
    }
    await h.proof.tick();
    expect(rows(h.db)).toEqual([]);
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('starts a conversation only with the prefix; a forward is not asking', async () => {
    const h = harness({ lookup: async () => sent() });
    land(h, request({ rfc_message_id: '<plain@owner.example>', subject: 'lunch?' }), stored({ record_id: 'r-1' }));
    land(h, request({ rfc_message_id: '<fwd@owner.example>', subject: 'Fwd: ask: lunch?' }), stored({ record_id: 'r-2' }));
    land(h, request({ rfc_message_id: '<re@owner.example>', subject: 'RE: Ask: lunch?' }), stored({ record_id: 'r-3' }));
    await h.proof.tick();
    expect(rows(h.db)).toEqual(['re@owner.example']);
  });

  it('a reply continues without it — in a conversation chat has, or to a request still being checked', async () => {
    const conversations = createMailChatConversations(new Database(':memory:'));
    conversations.record(CHAT, 'old-req@owner.example', 'conv-1', 'request', START);
    const h = harness({ conversations, lookup: async () => ({ status: 'not_found' }) });
    // A request still being checked.
    land(h, request({ rfc_message_id: '<first@owner.example>', subject: 'ask: first' }), stored({ record_id: 'r-0' }));
    const reply = (id: string, references: string, record_id: string) => land(h, 
      request({ rfc_message_id: `<${id}>`, subject: 'Re: first', headers: { references } }), stored({ record_id }));
    reply('in-conversation@owner.example', '<old-req@owner.example>', 'r-1');
    reply('to-pending@owner.example', '<first@owner.example>', 'r-2');
    reply('to-nothing@owner.example', '<someone-else@x.example>', 'r-3');
    await h.proof.tick();
    expect(rows(h.db)).toEqual(['first@owner.example', 'in-conversation@owner.example', 'to-pending@owner.example']);
  });

  it('a reply to a request that was not proven does not continue anything', async () => {
    const h = harness({ lookup: async () => sent({ to: ['someone@else.example'] }) });
    land(h, request({ rfc_message_id: '<forged@owner.example>' }), stored({ record_id: 'r-0' }));
    await h.proof.tick();
    expect(h.proof.get(CHAT, 'forged@owner.example')).toMatchObject({ state: 'not_proven' });
    land(h, request({
      rfc_message_id: '<follow@owner.example>', subject: 'Re: lunch', headers: { references: '<forged@owner.example>' },
    }), stored({ record_id: 'r-1' }));
    expect(h.proof.get(CHAT, 'follow@owner.example')).toBeNull();
  });

  it('with the filter off any subject starts one; a prefix of the owner’s own is the one asked for', async () => {
    const h = harness({ lookup: async () => sent() });
    h.door.setAskPrefix(null);
    land(h, request({ rfc_message_id: '<any@owner.example>', subject: 'lunch?' }), stored({ record_id: 'r-1' }));
    h.door.setAskPrefix('chat:');
    land(h, request({ rfc_message_id: '<ask@owner.example>', subject: 'ask: lunch?' }), stored({ record_id: 'r-2' }));
    land(h, request({ rfc_message_id: '<chat@owner.example>', subject: 'Chat: lunch?' }), stored({ record_id: 'r-3' }));
    await h.proof.tick();
    expect(rows(h.db)).toEqual(['any@owner.example', 'chat@owner.example']);
  });
});

describe('D-318 step 4 — a request’s files', () => {
  const upserted = (h: ReturnType<typeof harness>, msg: CanonicalMessage, attachments: MailUpsertAttachment[]) =>
    h.proof.onMessageUpserted(msg, {
      ...stored(), account_email: CHAT_ADDRESS, first_seen: true, attachments,
    });
  const PDF: MailUpsertAttachment = {
    file_id: 'file:pdf', filename: 'quote.pdf', mime_type: 'application/pdf', disposition: 'attachment', media_class: 'document',
  };
  const PHOTO: MailUpsertAttachment = {
    file_id: 'file:photo', filename: 'IMG_1.jpg', mime_type: 'image/jpeg', disposition: 'attachment', media_class: 'image',
  };
  /** The email's own account of its attachments: `n` of them. */
  const parts = (n: number): NonNullable<CanonicalMessage['attachments']> =>
    Array.from({ length: n }, (_, i) => ({
      filename: `part-${i}`, mime_type: 'application/octet-stream', size: 1, source_part_id: `${i + 1}`,
      fetchBytes: async () => Buffer.from('x'),
    }));

  it('the hand-over waits for the email’s attachments, and carries them — never the signature’s logo', async () => {
    const h = harness({ lookup: async () => sent() });
    const msg = request({
      body_html: '<div>What is this?<img src="cid:photo@x"></div><div class="gmail_signature"><img src="cid:logo@x"></div>',
    });
    store(h, msg, stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven', admit_state: 'waiting', files: [] });
    expect(h.admit).not.toHaveBeenCalled();

    upserted(h, msg, [
      { file_id: 'file:pdf', filename: 'quote.pdf', mime_type: 'application/pdf', disposition: 'attachment', media_class: 'document' },
      { file_id: 'file:photo', filename: 'IMG_1.jpg', mime_type: 'image/jpeg', disposition: 'inline', content_id: 'photo@x', media_class: 'image' },
      { file_id: 'file:logo', filename: 'logo.png', mime_type: 'image/png', disposition: 'inline', content_id: 'logo@x', media_class: 'image' },
    ]);
    await h.proof.tick();
    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.admit.mock.calls[0]![0].files).toEqual([
      { file_id: 'file:pdf', media_class: 'document' },
      { file_id: 'file:photo', media_class: 'image' },
    ]);
  });

  it('goes on without them once the wait has passed', async () => {
    const h = harness({ lookup: async () => sent() });
    store(h, request(), stored());
    await h.proof.tick();
    clock += MAIL_CHAT_ATTACHMENTS_WAIT_MS - 1_000;
    await h.proof.tick();
    expect(h.admit).not.toHaveBeenCalled();
    clock += 1_000;
    await h.proof.tick();
    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.admit.mock.calls[0]![0].files).toEqual([]);
  });

  it('a hand-over waiting for its files does not wake the timer over and over', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ lookup: async () => sent() });
      h.proof.start();
      store(h, request(), stored());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven', admit_state: 'waiting' });
      const timeouts = vi.spyOn(globalThis, 'setTimeout');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(timeouts.mock.calls.length).toBeLessThan(10);
      timeouts.mockRestore();
      expect(h.admit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the first account of a request’s files, and records none for mail that is not a request', async () => {
    const h = harness({ lookup: async () => ({ status: 'not_found' }) });
    const msg = request();
    store(h, msg, stored());
    upserted(h, msg, [{ file_id: 'file:a', filename: 'a.pdf', mime_type: 'application/pdf', disposition: 'attachment', media_class: 'document' }]);
    upserted(h, msg, [{ file_id: 'file:b', filename: 'b.pdf', mime_type: 'application/pdf', disposition: 'attachment', media_class: 'document' }]);
    expect(h.proof.get(CHAT, ID)?.files).toEqual([{ file_id: 'file:a', media_class: 'document' }]);

    upserted(h, request({ rfc_message_id: '<other@owner.example>', subject: 'not asking' }), []);
    expect(h.proof.get(CHAT, 'other@owner.example')).toBeNull();
  });
  it('a request’s files come from its own email: another copy of its Message-ID gives none', async () => {
    const h = harness({ lookup: async () => ({ status: 'not_found' }) });
    const msg = request();
    store(h, msg, stored());
    h.proof.onMessageUpserted(msg, {
      ...stored({ record_id: 'mail:chat-2' }), account_email: CHAT_ADDRESS, first_seen: true, attachments: [PDF],
    });
    expect(h.proof.get(CHAT, ID)?.files).toEqual([]);
    upserted(h, msg, []);
    expect(h.proof.get(CHAT, ID)?.files).toEqual([]);
  });

  it('an attachment that failed to store is waited for; the ones stored meanwhile are kept', async () => {
    const h = harness({ lookup: async () => sent() });
    const msg = request({ attachments: parts(2) });
    store(h, msg, stored());
    upserted(h, msg, [PDF]);
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({
      state: 'proven', admit_state: 'waiting', files: [{ file_id: 'file:pdf', media_class: 'document' }],
    });
    expect(h.admit).not.toHaveBeenCalled();

    // The next read of the email stores both.
    upserted(h, msg, [PDF, PHOTO]);
    await h.proof.tick();
    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.admit.mock.calls[0]![0].files).toEqual([
      { file_id: 'file:pdf', media_class: 'document' },
      { file_id: 'file:photo', media_class: 'image' },
    ]);
  });

  it('after a restart the wait for the files starts again: the re-read stores them', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const first = harness({ db, lookup: async () => sent() });
    const msg = request({ attachments: parts(1) });
    store(first, msg, stored());
    await first.proof.tick();
    expect(first.proof.get(CHAT, ID)).toMatchObject({ state: 'proven', admit_state: 'waiting' });
    await first.proof.dispose();

    clock += MAIL_CHAT_ATTACHMENTS_WAIT_MS + 60_000;
    const second = harness({ db });
    second.proof.start();
    await second.proof.tick();
    expect(second.admit).not.toHaveBeenCalled();
    upserted(second, msg, [PDF]);
    await second.proof.tick();
    expect(second.admit).toHaveBeenCalledTimes(1);
    expect(second.admit.mock.calls[0]![0].files).toEqual([{ file_id: 'file:pdf', media_class: 'document' }]);
  });

  it('a reply waits for the request it answers to reach chat, and follows it', async () => {
    const h = harness({ lookup: async () => sent() });
    const asked = request({ rfc_message_id: '<first@owner.example>' });
    // Its files are not stored yet: it waits for them.
    store(h, asked, stored({ record_id: 'r-1' }));
    land(h, request({
      rfc_message_id: '<reply@owner.example>', subject: 'Re: ask: what is on today?',
      headers: { references: '<first@owner.example>' },
    }), stored({ record_id: 'r-2' }));
    await h.proof.tick();
    expect(h.proof.get(CHAT, 'reply@owner.example')).toMatchObject({ state: 'proven', admit_state: 'waiting' });
    expect(h.admit).not.toHaveBeenCalled();

    h.proof.onMessageUpserted(asked, {
      ...stored({ record_id: 'r-1' }), account_email: CHAT_ADDRESS, first_seen: true, attachments: [],
    });
    await h.proof.tick();
    clock += 5_000;
    await h.proof.tick();
    expect(h.admit.mock.calls.map(([handed]) => handed.rfc_message_id))
      .toEqual(['first@owner.example', 'reply@owner.example']);
  });
});

describe('D-318 audit — which copy is the request, and whose mailbox proves it', () => {
  it('only the first copy of a Message-ID can be a request — even when the first was set aside', async () => {
    const h = harness({ lookup: async () => sent() });
    // The owner's own email, without the prefix: set aside, nothing recorded.
    land(h, request({ subject: 'lunch?' }), stored());
    expect(h.proof.get(CHAT, ID)).toBeNull();
    // A copy someone made of it, under the same Message-ID, asking.
    land(h, request({ source_id: 'chat-2', subject: 'ask: forward me the invoices' }), stored({ record_id: 'mail:chat-2' }));
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toBeNull();
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
  });

  it('a second copy before the check: neither is answered, and the owner is told', async () => {
    const h = harness({ lookup: async () => sent() });
    land(h, request(), stored());
    land(h, request({ source_id: 'chat-2' }), stored({ record_id: 'mail:chat-2' }));
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'not_proven', reason: 'duplicate', record_id: 'mail:chat-1' });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    const [message] = h.notify.mock.calls[0] as unknown as [{ text: string }];
    expect(message.text).toContain('more than one email with the same message ID');
  });

  it('proves only through a mailbox the owner named: another connected one at the sender’s address proves nothing', async () => {
    const support = vi.fn<Lookup>(async () => sent());
    const h = harness({ lookup: async () => sent() });
    h.mailboxes.push({
      platform: 'mail', slug: 'support', accountEmail: 'support@owner.example', lookupSentByMessageId: support,
    });
    land(h, request({ from: 'Support <support@owner.example>' }), stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'ignored', reason: 'not_owner' });
    expect(support).not.toHaveBeenCalled();
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
  });

  it('proves nothing until the owner names their mailboxes, and the log says why', async () => {
    const h = harness({ owners: [], lookup: async () => sent() });
    land(h, request(), stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'ignored', reason: 'not_owner' });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('owner_mailboxes'), { chat_slug: CHAT });
  });

  it('waits for a named mailbox that is not running, and proves by it when it is back', async () => {
    const work = vi.fn<Lookup>(async () => sent());
    const h = harness({ owners: [OWNER, 'work'] });
    land(h, request({ from: 'me@work.example' }), stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'pending' });
    expect(h.lookup).not.toHaveBeenCalled();

    clock += 60_000;
    h.mailboxes.push({ platform: 'mail', slug: 'work', accountEmail: 'me@work.example', lookupSentByMessageId: work });
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven', proven_by: 'work' });
  });

  it('a named mailbox that never comes back: given up after the wait, with one notice', async () => {
    const h = harness({ owners: [OWNER, 'work'] });
    land(h, request({ from: 'me@work.example' }), stored());
    expect(await runUntilSettled(h.proof)).toMatchObject({ state: 'not_proven', reason: 'unreachable' });
    expect(clock - START).toBe(MAIL_CHAT_PROOF_WAIT_MS);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });
});

describe('D-318 audit — a locked vault pauses the door', () => {
  it('checks nothing while the vault is locked, and the wait starts again when it opens', async () => {
    let unlocked = false;
    const h = harness({ isUnlocked: () => unlocked });
    land(h, request(), stored());
    await h.proof.tick();
    clock += 2 * MAIL_CHAT_PROOF_WAIT_MS;
    await h.proof.tick();
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'pending', attempts: 0 });

    unlocked = true;
    await h.proof.tick();
    // Asked, and not given up: its ten minutes count from the opening.
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'pending', attempts: 1 });
    h.lookup.mockImplementation(async () => sent());
    clock += 15_000;
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven' });
  });

  it('a hand-over the lock held up gets its hour from the opening', async () => {
    let unlocked = true;
    const h = harness({ isUnlocked: () => unlocked, lookup: async () => sent() });
    h.admit.mockRejectedValue(new Error('the chat queue is behind the vault'));
    land(h, request(), stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven', admit_state: 'waiting' });

    unlocked = false;
    clock += 2 * MAIL_CHAT_ADMIT_GIVE_UP_MS;
    await h.proof.tick();
    unlocked = true;
    await h.proof.tick();
    expect(h.admit).toHaveBeenCalledTimes(2);
    expect(h.proof.get(CHAT, ID)).toMatchObject({ admit_state: 'waiting' });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('locked, the timer looks again once a minute — it never spins', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ isUnlocked: () => false });
      h.proof.start();
      land(h, request(), stored());
      await vi.advanceTimersByTimeAsync(0);
      const timeouts = vi.spyOn(globalThis, 'setTimeout');
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(timeouts.mock.calls.length).toBeLessThanOrEqual(6);
      timeouts.mockRestore();
      expect(h.lookup).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('D-318 audit — a round never rejects', () => {
  // Every caller leaves a round's promise unhandled, and the server treats an
  // unhandled rejection as fatal.
  it('a round that throws is logged, and the next one goes on', async () => {
    let broken = true;
    const h = harness({
      isUnlocked: () => {
        if (broken) throw new Error('vault store gone');
        return true;
      },
    });
    land(h, request(), stored());
    await expect(h.proof.tick()).resolves.toBeUndefined();
    expect(h.log).toHaveBeenCalledWith('warn', 'chat mailbox round failed', { error: 'vault store gone' });
    broken = false;
    await h.proof.tick();
    expect(h.lookup).toHaveBeenCalledTimes(1);
  });

  it('nor does a round whose database closed under it, nor its schedule', async () => {
    const h = harness();
    h.proof.start();
    land(h, request(), stored());
    h.db.close();
    await expect(h.proof.tick()).resolves.toBeUndefined();
  });
});

describe('D-318 step 6 — the burst guard, and requests a recovery scan found', () => {
  /** A proven request of the owner's, landed now, and its admit row. */
  const landOwn = (h: ReturnType<typeof harness>, n: number) =>
    land(h, request({ rfc_message_id: `<own-${n}@owner.example>`, source_id: `own-${n}` }), stored({ record_id: `r-own-${n}` }));
  const reason = (h: ReturnType<typeof harness>, id: string): string | null =>
    (h.db.prepare('SELECT admit_reason AS r FROM mail_chat_requests WHERE rfc_message_id = ?').get(id) as { r: string | null }).r;
  const ownSent = async ({ rfc_message_id }: { rfc_message_id: string }): Promise<MailSentByMessageIdResult> =>
    rfc_message_id.startsWith('own-') ? sent() : { status: 'not_found' };

  it(`pauses the door when more than ${MAIL_CHAT_BURST_MAX} of the owner's requests land within a minute, and tells them once`, async () => {
    const h = harness({ lookup: ownSent });
    // A notice within the hour holds the next one back — but not this one: the
    // door now waits for the owner.
    land(h, request({ rfc_message_id: '<copy@owner.example>', source_id: 'copy' }), stored({ record_id: 'r-copy-1' }));
    keep(h.db, request({ rfc_message_id: '<copy@owner.example>', source_id: 'copy-2' }), stored({ record_id: 'r-copy-2' }));
    await h.proof.tick();
    expect(h.proof.get(CHAT, 'copy@owner.example')).toMatchObject({ state: 'not_proven', reason: 'duplicate' });
    expect(h.notify).toHaveBeenCalledTimes(1);

    clock += 60_000;
    for (let n = 1; n <= MAIL_CHAT_BURST_MAX + 2; n++) landOwn(h, n);
    await h.proof.tick();
    await h.proof.tick();
    const states = Array.from({ length: MAIL_CHAT_BURST_MAX + 2 }, (_, i) => h.proof.get(CHAT, `own-${i + 1}@owner.example`));
    expect(states.filter((row) => row?.admit_state === 'admitted')).toHaveLength(MAIL_CHAT_BURST_MAX);
    const dropped = states.filter((row) => row?.admit_state === 'dropped').map((row) => reason(h, row!.rfc_message_id));
    expect(dropped.sort()).toEqual(['the burst guard paused the email chat', 'the email chat is paused']);
    expect(h.admit).toHaveBeenCalledTimes(MAIL_CHAT_BURST_MAX);
    expect(h.door.get().paused_at).toBe(clock);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect((h.notify.mock.calls[1] as unknown as [unknown])[0]).toEqual(mailChatBurstNotice(CHAT_ADDRESS));

    // Paused, a request is neither handed over nor noticed again.
    clock += 5 * 60_000;
    landOwn(h, 100);
    await h.proof.tick();
    expect(h.proof.get(CHAT, 'own-100@owner.example')).toMatchObject({ state: 'proven', admit_state: 'dropped' });
    expect(reason(h, 'own-100@owner.example')).toBe('the email chat is paused');
    expect(h.notify).toHaveBeenCalledTimes(2);

    // The owner's word: requests are taken again.
    h.door.resume();
    clock += 5 * 60_000;
    landOwn(h, 101);
    await h.proof.tick();
    expect(h.proof.get(CHAT, 'own-101@owner.example')).toMatchObject({ admit_state: 'admitted' });
    expect(h.admit).toHaveBeenCalledTimes(MAIL_CHAT_BURST_MAX + 1);
  });

  it('counts proven requests only: a stranger writing in the owner’s name cannot pause the door', async () => {
    const h = harness({ lookup: ownSent });
    for (let n = 1; n <= 6; n++) landOwn(h, n);
    // Nine more, forged: the owner's From, no Sent record.
    for (let n = 1; n <= 9; n++) {
      land(h, request({ rfc_message_id: `<forged-${n}@owner.example>`, source_id: `forged-${n}` }), stored({ record_id: `r-f-${n}` }));
    }
    await h.proof.tick();
    await h.proof.tick();
    expect(h.admit).toHaveBeenCalledTimes(6);
    expect(h.door.get().paused_at).toBeNull();
  });

  it('a person writing does not reach it: the same number spread over more than a minute runs', async () => {
    const h = harness({ lookup: ownSent });
    for (let n = 1; n <= MAIL_CHAT_BURST_MAX + 2; n++) {
      landOwn(h, n);
      await h.proof.tick();
      clock += 10_000;
    }
    expect(h.admit).toHaveBeenCalledTimes(MAIL_CHAT_BURST_MAX + 2);
    expect(h.door.get().paused_at).toBeNull();
  });

  it('D-318 step 7 — lists the latest requests newest first, with why chat did not take one', async () => {
    const h = harness({ lookup: ownSent });
    landOwn(h, 1);
    clock += 1_000;
    land(h, request({ rfc_message_id: '<forged-1@owner.example>', source_id: 'forged-1' }), stored({ record_id: 'r-f-1' }));
    clock += 1_000;
    landOwn(h, 2);
    h.door.pause(clock);
    await h.proof.tick();
    const recent = h.proof.recent(CHAT, 10);
    expect(recent.map((row) => [row.rfc_message_id, row.state, row.admit_state, row.admit_reason])).toEqual([
      ['own-2@owner.example', 'proven', 'dropped', 'the email chat is paused'],
      ['forged-1@owner.example', 'pending', null, null],
      ['own-1@owner.example', 'proven', 'dropped', 'the email chat is paused'],
    ]);
    expect(h.proof.recent(CHAT, 1).map((row) => row.rfc_message_id)).toEqual(['own-2@owner.example']);
    expect(h.proof.recent('another-mailbox', 10)).toEqual([]);
  });

  it('keeps that a recovery scan found it, for its turn to answer in one line (P22)', async () => {
    const h = harness({ lookup: async () => sent() });
    land(h, request(), stored({ recovered: true }));
    land(h, request({ rfc_message_id: '<live@owner.example>', source_id: 'live' }), stored({ record_id: 'r-2' }));
    await h.proof.tick();
    expect(h.admit.mock.calls.map(([admitted]) => [admitted.rfc_message_id, admitted.recovered]).sort())
      .toEqual([['live@owner.example', false], [ID, true]].sort());
  });
});

describe('D-318 audit — the owner’s words from the HTML', () => {
  it('keeps the owner’s own part of the HTML as the email lands — the sync keeps none', () => {
    const h = harness();
    land(h, request({
      body_text: 'What is on today? On Mon, Ann wrote: old news',
      body_html: '<div dir="ltr">What is on <b>today</b>?<br>And tomorrow?</div>'
        + '<div class="gmail_quote">On Mon, Ann wrote:<blockquote>old news</blockquote></div>',
    }), stored());
    expect(h.proof.get(CHAT, ID)).toMatchObject({ html_text: 'What is on today?\nAnd tomorrow?', html_cut: 'quote' });

    land(h, request({ rfc_message_id: '<plain@owner.example>' }), stored({ record_id: 'r-2' }));
    expect(h.proof.get(CHAT, 'plain@owner.example')).toMatchObject({ html_text: null, html_cut: 'none', attached_email: false });
  });

  it('§8.12 — reads a forward as one, and keeps what was left out and whether an email came as a file', () => {
    const h = harness();
    const html = '<div>FYI</div><blockquote type="cite">Invoice 1042.</blockquote><div>Our bank: IBAN DE00 1234.</div>';
    // A forward ends at its first quote: what follows is the forwarded mail.
    land(h, request({ subject: 'ask: Fwd: invoice 1042', body_html: html }), stored());
    expect(h.proof.get(CHAT, ID)).toMatchObject({ html_text: 'FYI', html_cut: 'quote', attached_email: false });
    // A reply's quote is removed: what follows it is an answer below it.
    land(h, request({ rfc_message_id: '<reply@owner.example>', subject: 'ask: invoice 1042', body_html: html }),
      stored({ record_id: 'r-2' }));
    expect(h.proof.get(CHAT, 'reply@owner.example'))
      .toMatchObject({ html_text: 'FYI\n\nOur bank: IBAN DE00 1234.', html_cut: 'quote' });
    land(h, request({
      rfc_message_id: '<sig@owner.example>', subject: 'ask: book it', body_html: '<div>Book it.</div><div id="Signature">Ann</div>',
    }), stored({ record_id: 'r-3' }));
    expect(h.proof.get(CHAT, 'sig@owner.example')).toMatchObject({ html_text: 'Book it.', html_cut: 'signature' });
    land(h, request({
      rfc_message_id: '<file@owner.example>', subject: 'ask: Fwd: invoice 1042', has_attachments: true,
      attachments: [{
        filename: 'Invoice 1042.eml', mime_type: 'text/plain', size: 5, source_part_id: 'part-0', disposition: 'attachment',
        fetchBytes: async () => Buffer.from('From:'),
      }],
    }), stored({ record_id: 'r-4' }));
    expect(h.proof.get(CHAT, 'file@owner.example')).toMatchObject({ attached_email: true });
  });

  it('§8.12 — a forward’s files are read as its words are: an image after its first quote is the forwarded mail’s', () => {
    const h = harness();
    const html = '<div>FYI<img src="cid:mine@x"></div><blockquote type="cite">Invoice.</blockquote><div><img src="cid:theirs@x"></div>';
    const inline = (file_id: string, content_id: string): MailUpsertAttachment => ({
      file_id, filename: `${file_id}.png`, mime_type: 'image/png', disposition: 'inline', content_id, media_class: 'image',
    });
    land(h, request({ subject: 'ask: Fwd: invoice', body_html: html }), stored(),
      [inline('file:mine', 'mine@x'), inline('file:theirs', 'theirs@x')]);
    expect(h.proof.get(CHAT, ID)?.files.map((file) => file.file_id)).toEqual(['file:mine']);
    // As a reply, the image below the quote is the owner's.
    land(h, request({ rfc_message_id: '<reply@owner.example>', subject: 'ask: invoice', body_html: html }),
      stored({ record_id: 'r-2' }), [inline('file:mine', 'mine@x'), inline('file:theirs', 'theirs@x')]);
    expect(h.proof.get(CHAT, 'reply@owner.example')?.files.map((file) => file.file_id)).toEqual(['file:mine', 'file:theirs']);
  });

  it('§8.12 — a row stored before the kinds were told apart reads as quoted history', () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const h = harness({ db });
    land(h, request(), stored());
    // `html_cut` was 0 or 1; any cut was a 1.
    db.prepare('UPDATE mail_chat_requests SET html_cut = 1').run();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ html_cut: 'quote' });
    db.prepare('UPDATE mail_chat_requests SET html_cut = 7').run();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ html_cut: 'quote' });
  });
});

describe('D-318 audit — the copy itself must pass its sender check where it lands', () => {
  /** The chat mailbox's provider's stamp: its DMARC verdict for a domain. */
  const stamp = (verdict: string, domain = 'owner.example') =>
    `mx.chat.example; dkim=pass header.d=${domain}; spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=${domain}; `
    + `dmarc=${verdict} (p=REJECT sp=REJECT dis=NONE) header.from=${domain}`;

  it('a copy that fails DMARC for the owner’s domain is refused, with a notice — its Sent record is never asked', async () => {
    const h = harness({ lookup: async () => sent() });
    land(h, request({ headers: { 'authentication-results': stamp('fail') } }), stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'not_proven', reason: 'unauthenticated', sender_auth: 'fail' });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    const [message] = h.notify.mock.calls[0] as unknown as [{ title: string; text: string }];
    expect(message.text).toContain('sender check (DMARC)');
    expect(message.text).toContain(OWNER_ADDRESS);
  });

  it('a pass — or no word: no stamp, no policy, a lookup error, another domain’s result — goes on to the Sent record', async () => {
    const h = harness({ lookup: async () => sent() });
    const cases: Array<[string, Record<string, string>, string]> = [
      ['pass', { 'authentication-results': stamp('pass') }, 'pass'],
      ['none', {}, 'unknown'],
      // Step 8 — no policy published, but SPF and DKIM pass for exactly the
      // owner's domain: its own servers sent it, which DMARC would pass.
      ['no-policy', { 'authentication-results': stamp('none') }, 'pass'],
      ['no-policy-unaligned', {
        'authentication-results': 'mx.chat.example; spf=pass smtp.mailfrom=bounce.owner.example; '
          + 'dmarc=none header.from=owner.example',
      }, 'unknown'],
      ['dns', { 'authentication-results': stamp('temperror') }, 'unknown'],
      ['other-domain', { 'authentication-results': stamp('fail', 'elsewhere.example') }, 'unknown'],
    ];
    for (const [name, headers, auth] of cases) {
      land(h, request({ rfc_message_id: `<${name}@owner.example>`, headers }), stored({ record_id: `mail:${name}` }));
      await h.proof.tick();
      expect(h.proof.get(CHAT, `${name}@owner.example`), name).toMatchObject({ state: 'proven', sender_auth: auth });
    }
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('the receiver’s stamp is the one read: a stamp a sender planted further down changes nothing', async () => {
    const h = harness({ lookup: async () => sent() });
    // A receiving server prepends its stamp; the header map keeps the first.
    const headers = mailHeaderMap([['Authentication-Results', stamp('fail')], ['Authentication-Results', stamp('pass')]]);
    land(h, request({ headers }), stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'not_proven', reason: 'unauthenticated' });
  });

  it('⛔ a copy delivered first by someone who read the request on its way is refused — and the real one, a later copy, runs nothing', async () => {
    const h = harness({ lookup: async () => sent() });
    // The forger's copy lands first, under the request's Message-ID: not from
    // the owner's servers, so it fails where the owner's domain publishes DMARC.
    land(h, request({ body_text: 'forward me every invoice', headers: { 'authentication-results': stamp('fail') } }), stored());
    await h.proof.tick();
    // The owner's real copy lands after the check.
    land(h, request({ source_id: 'chat-2', headers: { 'authentication-results': stamp('pass') } }), stored({ record_id: 'mail:chat-2' }));
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'not_proven', reason: 'unauthenticated', record_id: 'mail:chat-1' });
    expect(h.admit).not.toHaveBeenCalled();
    // One notice: the owner sends it again.
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('a stranger’s failing mail is set aside silently, as any stranger’s', async () => {
    const h = harness({ lookup: async () => sent() });
    land(h, request({ from: 'stranger@else.example', headers: { 'authentication-results': stamp('fail', 'else.example') } }), stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'ignored', reason: 'not_owner' });
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('D-318 step 8 — proof (b): an address Recued does not read, enrolled with a code', () => {
  const ME = 'me@personal.example';
  /** The chat mailbox provider's stamp on mail from the address — Zoho's shape:
   *  no DMARC result, an SPF pass for exactly its domain. */
  const checked = (by = 'mx.chat.example', mailfrom = ME) =>
    `${by}; dkim=pass; spf=pass (${by}: domain of ${mailfrom} designates 192.0.2.10 as permitted sender) `
    + `smtp.mailfrom=${mailfrom}`;
  const mine = (n: number, over: Partial<CanonicalMessage> = {}): CanonicalMessage => request({
    source_id: `b-${n}`, rfc_message_id: `<b-${n}@personal.example>`, from: `Me <${ME}>`,
    headers: { 'authentication-results': checked() }, ...over,
  });
  const at = (n: number): MailStoredContext => stored({ record_id: `mail:b-${n}`, provider_kind: 'imap' });

  /** The owner adds the address, and sends its code from it — under the
   *  `ask:` prefix, as an owner may: the filter must not be what keeps it from
   *  being a request. */
  const enrol = (h: ReturnType<typeof harness>, stamp = checked()) => {
    const code = h.door.enrollSender(ME).enrolled_senders[0]!.code!;
    land(h, mine(0, { subject: `ask: Recued ${code}`, headers: { 'authentication-results': stamp } }), at(0));
    return code;
  };

  it('the email with the code confirms the address with its checker — and is no request', async () => {
    const h = harness();
    enrol(h);
    expect(h.door.get().enrolled_senders[0]).toMatchObject({ address: ME, state: 'confirmed', checked_by: 'mx.chat.example' });
    expect(h.proof.get(CHAT, 'b-0@personal.example')).toBeNull();
    await h.proof.tick();
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    // Audited, without the code.
    await vi.waitFor(() => expect(h.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: 'mail_chat_door_enrolment',
      detail: JSON.stringify({ address: ME, state: 'confirmed', checked_by: 'mx.chat.example' }),
    })));
  });

  it('a request from it is proven by its checker’s pass — no Sent folder asked — and goes to chat as the owner’s', async () => {
    const h = harness();
    enrol(h);
    land(h, mine(1), at(1));
    await h.proof.tick();
    expect(h.proof.get(CHAT, 'b-1@personal.example')).toMatchObject({
      state: 'proven', proof: 'enrolled', proven_by: null, sender_auth: 'pass', stamped_by: 'mx.chat.example',
    });
    expect(h.lookup).not.toHaveBeenCalled();
    // The answer goes to the address the request came from.
    expect(h.admit).toHaveBeenCalledWith(expect.objectContaining({ from_address: ME, proof: 'enrolled' }));
  });

  it('⛔ a stamp by anyone but its checker on top is refused, with a notice — a pass of its own counts for nothing', async () => {
    const h = harness();
    enrol(h);
    // What a chat server that stamps nothing leaves on top: whatever the sender wrote.
    land(h, mine(1, { headers: { 'authentication-results':
      'mx.google.com; spf=pass smtp.mailfrom=me@personal.example; dmarc=pass header.from=personal.example' } }), at(1));
    land(h, mine(2, { headers: {} }), at(2));
    await h.proof.tick();
    for (const n of [1, 2]) {
      expect(h.proof.get(CHAT, `b-${n}@personal.example`)).toMatchObject({ state: 'not_proven', reason: 'unverified' });
    }
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.lookup).not.toHaveBeenCalled();
    // One notice: the second is within the hour.
    expect(h.notify).toHaveBeenCalledTimes(1);
    const [message] = h.notify.mock.calls[0] as unknown as [{ text: string }];
    expect(message.text).toContain('did not confirm it came from that address');
    expect(message.text).toContain(ME);
  });

  it('another receiving host of the same provider is the same checker', async () => {
    const h = harness();
    enrol(h);
    land(h, mine(1, { headers: { 'authentication-results': checked('mx2.chat.example') } }), at(1));
    await h.proof.tick();
    expect(h.proof.get(CHAT, 'b-1@personal.example')).toMatchObject({ state: 'proven', proof: 'enrolled' });
  });

  it('its checker’s fail refuses it as unauthenticated; no pass at all as unverified', async () => {
    const h = harness();
    enrol(h);
    land(h, mine(1, { headers: { 'authentication-results':
      'mx.chat.example; spf=fail smtp.mailfrom=me@personal.example; dmarc=fail header.from=personal.example' } }), at(1));
    land(h, mine(2, { headers: { 'authentication-results': checked('mx.chat.example', 'me@bounce.personal.example') } }), at(2));
    await h.proof.tick();
    expect(h.proof.get(CHAT, 'b-1@personal.example')).toMatchObject({ state: 'not_proven', reason: 'unauthenticated' });
    expect(h.proof.get(CHAT, 'b-2@personal.example')).toMatchObject({ state: 'not_proven', reason: 'unverified' });
    expect(h.admit).not.toHaveBeenCalled();
  });

  it('while its code is pending, mail from it is a stranger’s; once removed, again', async () => {
    const h = harness();
    h.door.enrollSender(ME);
    land(h, mine(1), at(1));
    await h.proof.tick();
    expect(h.proof.get(CHAT, 'b-1@personal.example')).toMatchObject({ state: 'ignored', reason: 'not_owner' });
    h.door.unenrollSender(ME);
    enrol(h);
    h.door.unenrollSender(ME);
    land(h, mine(2), at(2));
    await h.proof.tick();
    expect(h.proof.get(CHAT, 'b-2@personal.example')).toMatchObject({ state: 'ignored', reason: 'not_owner' });
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('⛔ a code whose email fails is spent: the same code again confirms nothing', async () => {
    const h = harness();
    const code = enrol(h, '');
    expect(h.door.get().enrolled_senders[0]).toMatchObject({ state: 'failed', failure: 'no_check', code: null });
    land(h, mine(1, { subject: `ask: Recued ${code}` }), at(1));
    expect(h.door.get().enrolled_senders[0]).toMatchObject({ state: 'failed', failure: 'no_check' });
    // It is a stranger's request now.
    await h.proof.tick();
    expect(h.proof.get(CHAT, 'b-1@personal.example')).toMatchObject({ state: 'ignored', reason: 'not_owner' });
  });

  it('the checker must fit the chat mailbox’s provider: a Gmail chat mailbox’s is Gmail’s', () => {
    const h = harness();
    const code = h.door.enrollSender(ME).enrolled_senders[0]!.code!;
    land(h, mine(0, { subject: `Recued ${code}` }), stored({ record_id: 'mail:b-0', provider_kind: 'gmail' }));
    expect(h.door.get().enrolled_senders[0]).toMatchObject({ state: 'failed', failure: 'foreign_check' });
  });

  it('automatic mail never confirms, and wrong codes run out', () => {
    const h = harness();
    const code = h.door.enrollSender(ME).enrolled_senders[0]!.code!;
    land(h, mine(0, { subject: `Auto: Recued ${code}`, headers: {
      'authentication-results': checked(), 'auto-submitted': 'auto-replied',
    } }), at(0));
    expect(h.door.get().enrolled_senders[0]).toMatchObject({ state: 'pending', attempts: 0 });
    const wrong = code === '000000' ? '000001' : '000000';
    for (let n = 1; n <= 5; n += 1) land(h, mine(n, { subject: `Recued ${wrong}` }), at(n));
    expect(h.door.get().enrolled_senders[0]).toMatchObject({ state: 'failed', failure: 'too_many_attempts' });
    land(h, mine(6, { subject: `Recued ${code}` }), at(6));
    expect(h.door.get().enrolled_senders[0]).toMatchObject({ state: 'failed', failure: 'too_many_attempts' });
  });

  it('the owner’s own mailboxes are still proven by their Sent record', async () => {
    const h = harness({ lookup: async () => sent() });
    enrol(h);
    land(h, request(), stored());
    await h.proof.tick();
    expect(h.proof.get(CHAT, ID)).toMatchObject({ state: 'proven', proof: 'sent_record', proven_by: OWNER });
  });
});

describe('§8.18 one mailbox — the owner writes to the chat mailbox from itself', () => {
  const MINE = 'mine';
  const MY_ADDRESS = 'me@owner.example';
  const SELF_ID = 'self-1@owner.example';
  const ASK = '[#ask-7b0c2d1e-1111-4222-8333-944445555666]';
  const foundToMyself = async (): Promise<MailSentByMessageIdResult> => ({
    status: 'found', matches: [{ to: [MY_ADDRESS], subject: 'ask: what is on today?', sent_at: clock - 1_000 }],
  });

  /** The chat mailbox is the owner's own (`owner_mailboxes` names it), or —
   *  `two: true` — the same mailbox used for chat alone. */
  const oneMailbox = (opts: { lookup?: Lookup; two?: boolean; conversations?: MailChatConversations } = {}) => {
    const db = new Database(':memory:');
    dbs.push(db);
    const door = createMailChatDoorStore(db);
    door.setOwnerMailboxes(opts.two === true ? [] : [MINE]);
    door.setChatMailbox(MINE, MY_ADDRESS);
    const lookup = vi.fn<Lookup>(opts.lookup ?? foundToMyself);
    const mailboxes: MailChatProofMailbox[] = [
      { platform: 'mail', slug: MINE, accountEmail: `Me <${MY_ADDRESS}>`, lookupSentByMessageId: lookup },
    ];
    const notify = vi.fn(async () => undefined);
    const admit = vi.fn<MailChatAdmit>(async () => ({ outcome: 'admitted' }));
    const log = vi.fn<(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void>();
    const notProven = vi.fn<(chat_slug: string, record_id: string) => void>();
    const proof = createMailChatSentProof({
      db, door, mailboxes: () => mailboxes, now: () => clock, log, onNotProven: notProven,
      ...(opts.conversations ? { conversations: opts.conversations } : {}),
    });
    open.push(proof);
    proof.bindNotify(notify);
    proof.bindAdmit(admit);
    return { db, door, proof, lookup, notify, admit, log, notProven };
  };
  /** As Gmail keeps an email to oneself: one message, labelled SENT and INBOX. */
  const toMyself = (over: Partial<CanonicalMessage> = {}): CanonicalMessage => request({
    source_id: 'self-1', rfc_message_id: `<${SELF_ID}>`, from: `Me <${MY_ADDRESS}>`, to: [MY_ADDRESS],
    direction: 'outbound', labels: ['SENT', 'INBOX'], ...over,
  });
  const at = (over: Partial<MailStoredContext> = {}): MailStoredContext =>
    stored({ slug: MINE, record_id: 'mail:self-1', provider_kind: 'gmail', account_email: MY_ADDRESS, ...over });
  const settle = async (proof: MailChatSentProof, id = SELF_ID) => {
    const until = clock + 2 * MAIL_CHAT_PROOF_WAIT_MS;
    await proof.tick();
    while (proof.get(MINE, id)?.state === 'pending' && clock < until) {
      clock += 15_000;
      await proof.tick();
    }
    return proof.get(MINE, id);
  };

  it('⛔ Gmail: the email to oneself, filed as sent, is the request — proven by its own Sent record', async () => {
    const h = oneMailbox();
    land(h, toMyself(), at());
    await expect(settle(h.proof)).resolves.toMatchObject({
      state: 'proven', proof: 'sent_record', proven_by: MINE, from_address: MY_ADDRESS, record_id: 'mail:self-1',
    });
    expect(h.lookup).toHaveBeenCalledWith({ rfc_message_id: SELF_ID });
    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('⛔ used for chat alone, the chat mailbox’s own outbound mail is still never a request', async () => {
    const h = oneMailbox({ two: true });
    land(h, toMyself(), at());
    await h.proof.tick();
    expect(h.proof.get(MINE, SELF_ID)).toBeNull();
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('the owner’s own mail is set aside without a word, the notification channel’s included', async () => {
    const h = oneMailbox();
    const own: Array<[Partial<CanonicalMessage>, string]> = [
      [{ subject: 'Buy milk' }, 'a note to self'],
      [{ subject: 'Fwd: Your passport renewal' }, 'a renewal forwarded to oneself'],
      [{ subject: `${ASK} Passport renewal`, reconciliation_id: 'owner-notification:1f2e', direction: 'inbound' },
        'Recued’s notification to the mailbox it sends from (D-158)'],
      [{ subject: `Re: ${ASK} Passport renewal` }, 'the owner’s answer to it'],
      [{ to: [MY_ADDRESS, 'bob@x.example'] }, 'to oneself and someone else'],
      [{ cc: ['bob@x.example'] }, 'copied to someone'],
      [{ from: 'news@shop.example', direction: 'inbound', headers: { 'list-id': '<deals.shop.example>' } }, 'a newsletter'],
      [{ from: 'bob@x.example', direction: 'inbound', subject: 'lunch?' }, 'a friend’s email'],
      [{ to: ['bob@x.example'], subject: 'ask: lunch?' }, 'mail the owner sent to someone else'],
    ];
    own.forEach(([over, why], n) => {
      land(h, toMyself({ source_id: `own-${n}`, rfc_message_id: `<own-${n}@owner.example>`, ...over }),
        at({ record_id: `mail:own-${n}` }));
      expect(h.proof.get(MINE, `own-${n}@owner.example`), why).toBeNull();
    });
    await h.proof.tick();
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.proof.recent(MINE, 20)).toEqual([]);
    // ⛔ The log names none of them: the mailbox holds all the owner's mail.
    expect(h.log.mock.calls.filter(([, msg]) => msg.includes('ignored'))).toEqual([]);
  });

  it('a stranger’s email with the prefix is recorded and set aside at its check, as with two mailboxes', async () => {
    const h = oneMailbox();
    land(h, toMyself({ from: 'eve@else.example', direction: 'inbound' }), at());
    await expect(settle(h.proof)).resolves.toMatchObject({ state: 'ignored', reason: 'not_owner' });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
  });

  it('a reply in a conversation needs no prefix', async () => {
    const conversations = createMailChatConversations(new Database(':memory:'));
    conversations.record(MINE, 'answer-1@owner.example', 'conversation-1', 'answer', clock);
    const h = oneMailbox({ conversations });
    const reply = toMyself({ subject: 'and tomorrow?', headers: { 'in-reply-to': '<answer-1@owner.example>' } });
    land(h, reply, at());
    await expect(settle(h.proof)).resolves.toMatchObject({ state: 'proven', references: ['answer-1@owner.example'] });
    expect(h.proof.continuesConversation(MINE, ['answer-1@owner.example'])).toBe(true);
    expect(h.proof.continuesConversation(MINE, ['elsewhere@owner.example'])).toBe(false);
    // A request still on its way is a conversation too.
    expect(h.proof.continuesConversation(MINE, [SELF_ID])).toBe(true);
    expect(h.proof.continuesConversation('another-chat', [SELF_ID])).toBe(false);
  });

  it('an email it does not prove is given back to the owner’s mail, once — and reads as refuted', async () => {
    // Outlook's inbox copy, with no Sent record behind it: someone else wrote it.
    const h = oneMailbox({ lookup: notFound });
    land(h, toMyself({ direction: 'inbound' }), at({ provider_kind: 'graph' }));
    expect(h.proof.refuted(MINE, SELF_ID)).toBe(false);
    await expect(settle(h.proof)).resolves.toMatchObject({ state: 'not_proven', reason: 'not_in_sent' });
    expect(h.notProven.mock.calls).toEqual([[MINE, 'mail:self-1']]);
    expect(h.proof.refuted(MINE, SELF_ID)).toBe(true);
    expect(h.proof.refuted(MINE, 'never-seen@owner.example')).toBe(false);
    // A stranger's, set aside, is refuted too.
    land(h, toMyself({ source_id: 'eve-1', rfc_message_id: '<eve-1@else.example>', from: 'eve@else.example',
      direction: 'inbound' }), at({ record_id: 'mail:eve-1', provider_kind: 'graph' }));
    await settle(h.proof, 'eve-1@else.example');
    expect(h.proof.refuted(MINE, 'eve-1@else.example')).toBe(true);
    expect(h.notProven.mock.calls.at(-1)).toEqual([MINE, 'mail:eve-1']);
  });

  it('⛔ a proven request is never given back, and one that throws while given back still settles', async () => {
    const h = oneMailbox();
    h.notProven.mockImplementation(() => { throw new Error('row locked'); });
    land(h, toMyself(), at());
    await expect(settle(h.proof)).resolves.toMatchObject({ state: 'proven' });
    expect(h.notProven).not.toHaveBeenCalled();
    expect(h.proof.refuted(MINE, SELF_ID)).toBe(false);
    const g = oneMailbox({ lookup: notFound });
    g.notProven.mockImplementation(() => { throw new Error('row locked'); });
    land(g, toMyself({ direction: 'inbound' }), at({ provider_kind: 'graph' }));
    await expect(settle(g.proof)).resolves.toMatchObject({ state: 'not_proven' });
    expect(g.notProven).toHaveBeenCalledTimes(1);
  });

  it('the ask: filter cannot be switched off: a note to self stays the owner’s', async () => {
    const h = oneMailbox();
    h.door.setAskPrefix(null);
    land(h, toMyself({ subject: 'Buy milk' }), at());
    expect(h.proof.get(MINE, SELF_ID)).toBeNull();
  });

  describe('⛔ Outlook and IMAP file the Sent copy apart: the owner’s record, never a request, never a second copy', () => {
    for (const provider_kind of ['graph', 'imap'] as const) {
      const inbox = toMyself({ source_id: 'inbox-1', direction: 'inbound', labels: [] });
      const sentCopy = toMyself({ source_id: 'sent-1', labels: [] });

      it(`${provider_kind}: the Sent copy first, then the inbox copy — the inbox copy is the request`, async () => {
        const h = oneMailbox();
        land(h, sentCopy, at({ record_id: 'mail:sent-1', provider_kind }));
        expect(h.proof.get(MINE, SELF_ID)).toBeNull();
        land(h, inbox, at({ record_id: 'mail:inbox-1', provider_kind }));
        await expect(settle(h.proof)).resolves.toMatchObject({ state: 'proven', record_id: 'mail:inbox-1' });
      });

      it(`${provider_kind}: the inbox copy first, its Sent copy before the check — not a duplicate`, async () => {
        const h = oneMailbox();
        land(h, inbox, at({ record_id: 'mail:inbox-1', provider_kind }));
        land(h, sentCopy, at({ record_id: 'mail:sent-1', provider_kind }));
        await expect(settle(h.proof)).resolves.toMatchObject({ state: 'proven', record_id: 'mail:inbox-1' });
      });

      it(`${provider_kind}: ⛔ a second copy DELIVERED under the same Message-ID still refuses both`, async () => {
        const h = oneMailbox();
        land(h, inbox, at({ record_id: 'mail:inbox-1', provider_kind }));
        land(h, sentCopy, at({ record_id: 'mail:sent-1', provider_kind }));
        land(h, toMyself({ source_id: 'forged-1', direction: 'inbound' }), at({ record_id: 'mail:forged-1', provider_kind }));
        await expect(settle(h.proof)).resolves.toMatchObject({ state: 'not_proven', reason: 'duplicate' });
        expect(h.admit).not.toHaveBeenCalled();
      });
    }

    it('⛔ a provider not named reads as Gmail: its outbound copy is the request, and a second copy refuses it aloud', async () => {
      const h = oneMailbox();
      land(h, toMyself({ source_id: 'sent-1' }), at({ record_id: 'mail:sent-1', provider_kind: undefined }));
      land(h, toMyself({ source_id: 'inbox-1', direction: 'inbound' }), at({ record_id: 'mail:inbox-1', provider_kind: undefined }));
      await expect(settle(h.proof)).resolves.toMatchObject({ state: 'not_proven', reason: 'duplicate' });
      expect(h.notify).toHaveBeenCalledTimes(1);
    });
  });
});
