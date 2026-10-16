/** D-318 step 3 — an email request, proven the owner's, runs as a chat turn.
 *
 *  Through the real pieces: the chat store, the chat orchestrator and D-265's
 *  durable queue, the proof (`sent-proof.ts`) handing over to the door's turns
 *  (`turns.ts`), and the conversation map. Only the model and the two
 *  mailboxes are stand-ins. The order of events is the server's: an email lands
 *  → the proof finds it in the owner's Sent record → it is handed to chat →
 *  the queue runs it as a `mail` turn → the orchestrator stores the owner's
 *  words and the answer in the conversation.
 *
 *  ⛔ The turn's source is pinned through the store, not only the call: the
 *  chat store stamps each row's recall eligibility from the source it is given,
 *  and an email turn reads as a messenger turn there only because the contracts
 *  accept the door's vendor — before step 3 the same row read `ineligible`. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createMiddlewareRegistry } from '@recued/middleware';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { registerFirstPartyMiddlewares } from '@recued/middleware-recued';
import type { CollectionRecord, MailSentByMessageIdResult, MailSentRepliesResult } from '@recued/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatOrchestrator } from '../chat-orchestrator.js';
import { __clearSessionBriefs, __clearUnfoldedUserMessages } from '../chat-rolling-brief.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { createCollectionTable } from '../collections/table.js';
import type { MailStoredContext, MailUpsertAttachment } from '../collections/mail/mail-collection.js';
import { createEncryptedBlobStore } from '../storage/blob-store.js';
import type { CanonicalMessage } from '../collections/mail/provider.js';
import { mailChatAnswerReconciliationId } from '../mail-chat-door/conversation-mail.js';
import { createMailChatConversations } from '../mail-chat-door/conversations.js';
import {
  createMailChatSentProof,
  type MailChatProofMailbox,
  type MailChatProofNotify,
  type MailChatRequest,
} from '../mail-chat-door/sent-proof.js';
import {
  composeMailChatTurns,
  mailChatLateAnswer,
  mailChatLateness,
  mailChatSubjectLead,
  mailChatTitle,
  type MailChatTurnsMailbox,
} from '../mail-chat-door/turns.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createMailChatDoorStore } from '../storage/mail-chat-door-store.js';

const CHAT = 'recued-chat';
const CHAT_ADDRESS = 'recued@chat.example';
const OWNER = 'me';
const OWNER_ADDRESS = 'me@owner.example';
const START = Date.UTC(2026, 9, 14, 9, 0, 0);
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'd318-turns' };
const key = () => new Uint8Array(32).fill(61);
const eventually = (assert: () => unknown | Promise<unknown>) => vi.waitFor(assert, { timeout: 8_000, interval: 10 });

let clock = START;
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => { clock = START; });
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  __clearSessionBriefs();
  __clearUnfoldedUserMessages();
});

interface Email {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
  readonly references?: string;
  readonly inReplyTo?: string;
  readonly html?: string;
  /** Its attachments, stored as the mail sync stores them. */
  readonly files?: ReadonlyArray<{
    filename: string; mime_type: string; bytes: Buffer; disposition?: 'attachment' | 'inline'; content_id?: string;
  }>;
  /** Step 6 — when the chat mailbox's provider received it; now by default. */
  readonly receivedAt?: number;
  /** Step 6 — a recovery scan found it. */
  readonly recovered?: boolean;
}

type Mailbox = MailChatProofMailbox & MailChatTurnsMailbox;

const harness = (options: { holdFirstAnswer?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'd318-turns-'));
  const db = new Database(join(dir, 'server.sqlite'));
  cleanup.push(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });
  ensureChatSchema(db);
  const store = createChatStore(db, key);
  // The received files, where the mail sync stores an email's attachments and
  // the chat queue reads a turn's files from.
  const received = createInboundFileCollection({
    db, blobs: createEncryptedBlobStore(join(dir, 'cas'), key), slug: 'received', bus: createWarehouseEventBus(),
    gate: createStorageGate({ quota: 100_000_000, reservePct: 10, surface: 'collection:file:received' }),
  });

  const prompts: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  const raw = createChatOrchestrator({
    chatStore: store,
    selfSignature: signature,
    // As the server resolves a turn's file names, from the received files.
    resolveFileNames: (ids) => new Map(ids.flatMap((id): Array<[string, string]> => {
      const file = received.get(id);
      return file ? [[id, file.hot_fields.filename]] : [];
    })),
    middlewareRegistry: (() => { const r = createMiddlewareRegistry(); registerFirstPartyMiddlewares(r); return r; })(),
    registry: {
      list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {},
    },
    executeAiCall: async (_tool, args) => {
      const n = prompts.push(JSON.stringify(args));
      active++;
      try {
        if (options.holdFirstAnswer && n === 1) await held;
        return { body: { response: `answer ${n}`, events: [], tool_calls: [] } };
      } finally { active--; }
    },
  });
  const orchestrator = withQueuedChatTurns(raw, { db, store, getKey: key, pollMs: 5 });
  // What each turn is run AS: its surface and its source, as the orchestrator
  // receives them.
  const runAs: Array<{ surface: string; source: unknown; dispatch_depth: number }> = [];
  const runMessengerTurn = orchestrator.runMessengerTurn;
  orchestrator.runMessengerTurn = (input) => {
    runAs.push({ surface: input.inbound.surface, source: input.inbound.source, dispatch_depth: input.inbound.dispatch_depth });
    return runMessengerTurn(input);
  };
  cleanup.push(async () => {
    release();
    orchestrator.turnQueue!.close();
    await eventually(() => expect(active).toBe(0));
  });

  const door = createMailChatDoorStore(db);
  door.setChatMailbox(CHAT);
  door.setOwnerMailboxes([OWNER]);
  // The chat mailbox's table, which the sync writes before it tells the door.
  const table = createCollectionTable({ db, platform: 'mail', slug: CHAT });
  const records = new Map<string, CollectionRecord>();
  const sentByOwner = new Set<string>();
  // The chat mailbox's Sent folder, as its provider answers for the replies to
  // one request: none, unless a test says otherwise.
  const sentReplies = new Map<string, MailSentRepliesResult>();
  const repliesAsked: string[] = [];
  const chatMailbox: Mailbox = {
    platform: 'mail', slug: CHAT, accountEmail: CHAT_ADDRESS,
    get: (record_id: string) => records.get(record_id) ?? null,
    lookupSentByMessageId: async () => { throw new Error('the chat mailbox is never asked'); },
    lookupSentReplies: async ({ rfc_message_id }: { rfc_message_id: string }): Promise<MailSentRepliesResult> => {
      repliesAsked.push(rfc_message_id);
      return sentReplies.get(rfc_message_id) ?? { status: 'not_found' };
    },
  } as unknown as Mailbox;
  const ownerMailbox: Mailbox = {
    platform: 'mail', slug: OWNER, accountEmail: OWNER_ADDRESS,
    get: () => null,
    lookupSentByMessageId: async ({ rfc_message_id }: { rfc_message_id: string }): Promise<MailSentByMessageIdResult> =>
      sentByOwner.has(rfc_message_id)
        ? { status: 'found', matches: [{ to: [CHAT_ADDRESS], subject: 's', sent_at: clock - 2_000 }] }
        : { status: 'not_found' },
  } as unknown as Mailbox;
  const mailboxes: Mailbox[] = [chatMailbox, ownerMailbox];

  const conversations = createMailChatConversations(db);
  const turns = composeMailChatTurns({
    orchestrator, door, mailboxes: () => mailboxes,
    readBody: async (record) => record.body_inline ?? null,
    conversations, now: () => clock,
    // As the server asks it: a conversation the owner deleted is gone.
    sessionExists: (session_id) => store.getSession(session_id) !== null,
    // The owner's clock: START is 17:00 there.
    timeZone: () => 'Asia/Hong_Kong',
  })!;
  const proof = createMailChatSentProof({ db, door, mailboxes: () => mailboxes, now: () => clock });
  proof.bindAdmit(turns.admit);
  const notify = vi.fn<MailChatProofNotify>(async () => undefined);
  proof.bindNotify(notify);
  cleanup.push(() => proof.dispose());

  /** The owner sends an email to the chat mailbox: its Sent copy, and the copy
   *  that lands in the chat mailbox. */
  const send = async (email: Email): Promise<void> => {
    sentByOwner.add(email.id);
    const record_id = `mail:${email.id}`;
    const record = {
      record_id, received_at: clock, modified_at: clock, size_bytes: email.body.length, source_id: email.id,
      hot_fields: { subject: email.subject, from: OWNER_ADDRESS, to: [CHAT_ADDRESS] }, body_inline: email.body,
    } as CollectionRecord;
    records.set(record_id, record);
    table.upsert({ ...record, hot_fields: { ...record.hot_fields, rfc_message_id: email.id } });
    const msg: CanonicalMessage = {
      source_id: email.id, rfc_message_id: `<${email.id}>`, from: OWNER_ADDRESS, to: [CHAT_ADDRESS], cc: [],
      subject: email.subject, thread_id: email.id, folder_or_label: 'INBOX', direction: 'inbound',
      is_read: false, is_flagged: false, has_attachments: (email.files ?? []).length > 0, received_at: clock,
      provider_received_at: email.receivedAt ?? clock, body_text: email.body,
      ...(email.html !== undefined ? { body_html: email.html } : {}),
      // The parts as the sync lists them when the email lands.
      ...(email.files !== undefined ? {
        attachments: email.files.map((file, i) => ({
          filename: file.filename, mime_type: file.mime_type, size: file.bytes.length, source_part_id: `part-${i}`,
          disposition: file.disposition ?? 'attachment', ...(file.content_id !== undefined ? { content_id: file.content_id } : {}),
          fetchBytes: async () => file.bytes,
        })),
      } : {}),
      headers: {
        ...(email.inReplyTo ? { 'in-reply-to': email.inReplyTo } : {}),
        ...(email.references ? { references: email.references } : {}),
      },
    };
    const ctx: MailStoredContext = {
      slug: CHAT, record_id, backfill_complete: true, backfill_days: 30, ...(email.recovered ? { recovered: true } : {}),
    };
    proof.onMessageStored(msg, ctx);
    // Then the attachments are stored, and the mail stack tells the door.
    const attachments: MailUpsertAttachment[] = [];
    for (const [i, file] of (email.files ?? []).entries()) {
      const stored = await received.ingest({
        bytes: file.bytes, filename: file.filename, mime_type: file.mime_type, origin: 'mail_attachment',
        source_id: `${email.id}:${i}`, now: clock,
      });
      attachments.push({
        file_id: stored.record_id, filename: file.filename, mime_type: file.mime_type,
        disposition: file.disposition ?? 'attachment', media_class: stored.hot_fields.media_class,
        ...(file.content_id !== undefined ? { content_id: file.content_id } : {}),
      });
    }
    proof.onMessageUpserted(msg, { ...ctx, account_email: CHAT_ADDRESS, first_seen: true, attachments });
    await proof.tick();
  };

  const sessionOf = (id: string): string => {
    const conversation = conversations.conversationOf(CHAT, id);
    expect(conversation).not.toBeNull();
    return `mail:${CHAT}:${conversation!}`;
  };
  const recallOf = (session: string): string[] =>
    (db.prepare(`SELECT recall_eligibility AS r FROM chat_messages WHERE session_id = ? ORDER BY ts`)
      .all(session) as Array<{ r: string }>).map((row) => row.r);
  const request = (id: string, over: Partial<MailChatRequest> = {}): MailChatRequest => ({
    chat_slug: CHAT, rfc_message_id: id, record_id: `mail:${id}`, from_address: OWNER_ADDRESS, references: [],
    state: 'proven', reason: null, proven_by: OWNER, proof: 'sent_record', attempts: 1, arrived_at: clock,
    received_at: clock, admit_state: 'waiting', files: [], html_text: null, html_cut: 'none', attached_email: false,
    recovered: false, sender_auth: 'unknown', stamped_by: null, ...over,
  });

  return {
    db, store, orchestrator, door, records, mailboxes, conversations, turns, proof, prompts, release, runAs, notify,
    send, sessionOf, recallOf, request, sentReplies, repliesAsked,
  };
};

describe('D-318 step 3 — an email request runs as a chat turn', () => {
  it('runs in its own conversation, titled by its subject, as a messenger turn from the email door', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'Re: ask: what is on today?', body: 'What is on my calendar today?' });
    const session = h.sessionOf('req-1@owner.example');

    await eventually(async () => expect((await h.store.listMessages(session)).map((m) => [m.role, m.content])).toEqual([
      ['user', 'What is on my calendar today?'],
      ['assistant', 'answer 1'],
    ]));
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain('What is on my calendar today?');
    expect(h.store.getSession(session)?.title).toBe('what is on today?');
    // The owner's words and the answer, both stamped as a messenger turn.
    expect(h.recallOf(session)).toEqual(['messenger:not_owner_authenticated', 'messenger:not_owner_authenticated']);
    expect(h.runAs).toEqual([{
      surface: 'messenger-email',
      source: { channel: 'messenger', actor: 'user_self', vendor: 'email', from: OWNER_ADDRESS },
      dispatch_depth: 0,
    }]);
    expect(h.proof.get(CHAT, 'req-1@owner.example')).toMatchObject({ admit_state: 'admitted' });
  });

  it('a reply that refers to the request continues its conversation; an email that refers to nothing starts another', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Where should I have lunch?' });
    const first = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(first)).toHaveLength(2));

    // The reply names the request in References; its In-Reply-To is Recued's
    // answer, which step 5 records.
    clock += 60_000;
    await h.send({
      id: 'req-2@owner.example', subject: 'Re: ask: lunch?', body: 'Somewhere near the office.',
      inReplyTo: '<answer-1@chat.example>', references: '<req-1@owner.example> <answer-1@chat.example>',
    });
    expect(h.sessionOf('req-2@owner.example')).toBe(first);
    await eventually(async () => expect(await h.store.listMessages(first)).toHaveLength(4));

    clock += 60_000;
    await h.send({ id: 'req-3@owner.example', subject: 'ask: weather', body: 'Will it rain tomorrow?' });
    const third = h.sessionOf('req-3@owner.example');
    expect(third).not.toBe(first);
    await eventually(async () => expect(await h.store.listMessages(third)).toHaveLength(2));
    expect(h.store.listSessions().map((s) => s.id).sort()).toEqual([first, third].sort());
  });

  it('the same reply sent twice runs once; the same words replying to another message run again', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: hello', body: 'hello' });
    await eventually(() => expect(h.prompts).toHaveLength(1));
    const reply = (id: string, body: string, to: string) => h.send({
      id, subject: 'Re: ask: hello', body, inReplyTo: `<${to}>`, references: `<req-1@owner.example> <${to}>`,
    });
    clock += 60_000;
    await reply('req-2@owner.example', 'ping', 'req-1@owner.example');
    await eventually(() => expect(h.prompts).toHaveLength(2));
    // That same reply sent twice: run once (D-265).
    clock += 60_000;
    await reply('req-2b@owner.example', 'ping', 'req-1@owner.example');
    expect(h.proof.get(CHAT, 'req-2b@owner.example')).toMatchObject({ admit_state: 'admitted' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(2);
    // The same words replying to another message are another request, as a
    // Slack or Telegram reply is (the audit: "yes" to one question, then "yes"
    // to the next, ran once).
    clock += 60_000;
    await reply('req-3@owner.example', 'yes', 'req-2@owner.example');
    clock += 60_000;
    await reply('req-4@owner.example', 'yes', 'req-3@owner.example');
    await eventually(() => expect(h.prompts).toHaveLength(4));
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('the same words a third time in a row are not run, and the owner is told: a loop of automatic replies', async () => {
    const h = harness();
    // Its body begins with its subject, so the first says the same words too.
    const away = 'Away until Monday.';
    await h.send({ id: 'r1@owner.example', subject: 'ask: away', body: away });
    await eventually(() => expect(h.prompts).toHaveLength(1));
    // Each in reply to the last, as an automatic reply answers each answer.
    for (const [id, previous] of [['r2@owner.example', 'r1@owner.example'], ['r3@owner.example', 'r2@owner.example']] as const) {
      clock += 60_000;
      await h.send({ id, subject: 'Re: ask: away', body: away, inReplyTo: `<${previous}>`, references: `<${previous}>` });
    }
    await eventually(() => expect(h.prompts).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(2);
    expect(h.proof.get(CHAT, 'r3@owner.example')).toMatchObject({ admit_state: 'dropped' });
    expect(h.notify).toHaveBeenCalledTimes(1);
    const [notice] = h.notify.mock.calls[0]!;
    expect(notice.text).toContain('said the same as the two before it');
    expect(notice.text).toContain(CHAT_ADDRESS);
    expect(`${notice.title} ${notice.text}`).not.toContain('Monday');

    // Other words in the same conversation run.
    clock += 60_000;
    await h.send({
      id: 'r4@owner.example', subject: 'Re: ask: away', body: 'Thanks, noted.',
      inReplyTo: '<r3@owner.example>', references: '<r3@owner.example>',
    });
    await eventually(() => expect(h.prompts).toHaveLength(3));
    expect(h.sessionOf('r4@owner.example')).toBe(h.sessionOf('r1@owner.example'));
  });

  it('a reply into a conversation the owner deleted starts a new one', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Where should I have lunch?' });
    const first = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(first)).toHaveLength(2));
    expect(h.store.deleteSession(first)).toBe(true);

    clock += 60_000;
    await h.send({
      id: 'req-2@owner.example', subject: 'Re: ask: lunch?', body: 'Somewhere near the office.',
      inReplyTo: '<req-1@owner.example>', references: '<req-1@owner.example>',
    });
    const second = h.sessionOf('req-2@owner.example');
    expect(second).not.toBe(first);
    await eventually(async () => expect((await h.store.listMessages(second)).map((m) => m.content))
      .toEqual(['Somewhere near the office.', 'answer 2']));
    expect(h.store.getSession(first)).toBeNull();
  });

  it('a turn queued before the owner changed the chat mailbox does not run', async () => {
    const h = harness({ holdFirstAnswer: true });
    await h.send({ id: 'req-1@owner.example', subject: 'ask: one', body: 'First question' });
    await eventually(() => expect(h.prompts).toHaveLength(1));
    // Queued behind the first, in the same conversation.
    clock += 60_000;
    await h.send({ id: 'req-2@owner.example', subject: 'Re: ask: one', body: 'Second question', references: '<req-1@owner.example>' });
    expect(h.proof.get(CHAT, 'req-2@owner.example')).toMatchObject({ admit_state: 'admitted' });

    h.door.setChatMailbox('another-mailbox');
    h.release();
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => {
      const queue = await h.orchestrator.turnQueue!.snapshot(session);
      expect(queue.turns.map((t) => t.status)).toEqual(['completed', 'failed']);
    });
    expect(h.prompts).toHaveLength(1);
    expect((await h.store.listMessages(session)).map((m) => m.content)).not.toContain('Second question');
  });

  it('a hand-over repeated after a crash adds nothing', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: once', body: 'Only once, please.' });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(2));

    await expect(h.turns.admit(h.request('req-1@owner.example'))).resolves.toEqual({ outcome: 'admitted' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(1);
    expect((await h.orchestrator.turnQueue!.snapshot(session)).turns).toHaveLength(1);
  });

  it('asks in its subject when the body is empty', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: what time is it in Tokyo?', body: '  \n' });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect((await h.store.listMessages(session))[0]?.content).toBe('what time is it in Tokyo?'));
  });

  it('⛔ starting a conversation, asks in its subject AND its body', async () => {
    // Live, 2026-10-15: the request was in the subject, a note in the body, and
    // the model, given the body alone, asked what was wanted.
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: remind me in 2 minutes to check the test', body: 'testing 2 for reminder',
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect((await h.store.listMessages(session))[0]?.content)
      .toBe('remind me in 2 minutes to check the test\n\ntesting 2 for reminder'));
    expect(h.prompts[0]).toContain('remind me in 2 minutes to check the test');
    expect(h.store.getSession(session)?.title).toBe('remind me in 2 minutes to check the test');
  });
});

describe('D-318 step 4 — the owner’s own words', () => {
  it('a reply’s quoted history and signature reach neither the conversation nor the model', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Where should I have lunch?' });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(2));
    clock += 60_000;
    await h.send({
      id: 'req-2@owner.example', subject: 'Re: ask: lunch?', references: '<req-1@owner.example>',
      body: [
        'Somewhere near the office.',
        '',
        '-- ',
        'Ann Smith',
        '+1 555 0100',
        '',
        'On Tue, Oct 14, 2026 at 9:00 AM Recued <recued@chat.example> wrote:',
        '> answer 1',
      ].join('\n'),
    });
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(4));
    expect((await h.store.listMessages(session))[2]?.content).toBe('Somewhere near the office.');
    expect(h.prompts[1]).toContain('Somewhere near the office.');
    expect(h.prompts[1]).not.toContain('555 0100');
    expect(h.prompts[1]).not.toContain('mail.read');
  });

  it('reads the owner’s words from the HTML: an Outlook email’s stored text is one line', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: invoices',
      // As the Microsoft sync stores it: the HTML's words on one line, the
      // signature and the email replied to included.
      body: 'Please file the invoices. Ann Smith | +1 555 0100 From: Bob Sent: Monday 9:00 old text',
      html: '<div>Please file the invoices.</div><div id="Signature">Ann Smith | +1 555 0100</div>'
        + '<div id="divRplyFwdMsg"><b>From:</b> Bob<br><b>Sent:</b> Monday 9:00</div><div>old text</div>',
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect((await h.store.listMessages(session)).map((m) => m.content))
      .toEqual(['invoices\n\nPlease file the invoices.', 'answer 1']));
    expect(h.prompts[0]).not.toContain('555 0100');
    // Starting a conversation, the email it replies to is mail: pointed at.
    expect(h.prompts[0]).toContain('mail.read');
  });

  it('in a conversation, quoted HTML history is the conversation; a forward is still mail', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Where should I have lunch?' });
    await eventually(() => expect(h.prompts).toHaveLength(1));
    const quoted = '<div>Near the office.</div><div class="gmail_quote">On Tue, Recued wrote:<blockquote>answer 1</blockquote></div>';
    clock += 60_000;
    await h.send({
      id: 'req-2@owner.example', subject: 'Re: ask: lunch?', body: 'Near the office. answer 1', html: quoted,
      inReplyTo: '<req-1@owner.example>', references: '<req-1@owner.example>',
    });
    await eventually(() => expect(h.prompts).toHaveLength(2));
    expect(h.prompts[1]).toContain('Near the office.');
    expect(h.prompts[1]).not.toContain('mail.read');

    clock += 60_000;
    await h.send({
      id: 'req-3@owner.example', subject: 'Fwd: ask: lunch?', body: 'Near the office. answer 1', html: quoted.replace('Near', 'And near'),
      inReplyTo: '<req-2@owner.example>', references: '<req-1@owner.example> <req-2@owner.example>',
    });
    await eventually(() => expect(h.prompts).toHaveLength(3));
    expect(h.prompts[2]).toContain('mail.read');
  });

  it('a forward in a conversation, as Outlook writes one in plain text, is mail: its header block is not history', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: invoices', body: 'Any invoices due?' });
    await eventually(() => expect(h.prompts).toHaveLength(1));
    clock += 60_000;
    await h.send({
      id: 'req-2@owner.example', subject: 'FW: ask: invoices',
      inReplyTo: '<req-1@owner.example>', references: '<req-1@owner.example>',
      body: [
        'Can you handle this one?',
        '',
        'From: Supplier <billing@supplier.example>',
        'Sent: Tuesday, October 14, 2026 9:00 AM',
        'Subject: Invoice 1042',
        '',
        'Our bank: IBAN DE00 1234.',
      ].join('\n'),
    });
    await eventually(() => expect(h.prompts).toHaveLength(2));
    expect(h.prompts[1]).toContain('Can you handle this one?');
    expect(h.prompts[1]).toContain('mail.read');
    expect(h.prompts[1]).not.toContain('DE00 1234');
  });

  it('forwarded mail reaches the model as mail to read, never as the owner’s words', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: what do you make of this?',
      body: [
        'What do you make of this?',
        '',
        '---------- Forwarded message ---------',
        'From: Supplier <billing@supplier.example>',
        '',
        'Invoice 1042 is due. Our bank: IBAN DE00 1234.',
      ].join('\n'),
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(2));
    expect((await h.store.listMessages(session))[0]?.content).toBe('What do you make of this?');
    expect(h.prompts[0]).toContain('What do you make of this?');
    expect(h.prompts[0]).toContain('mail.read');
    // The prompt is JSON inside JSON here, so its quotes come escaped.
    expect(h.prompts[0]).toMatch(new RegExp(`slug \\\\*"${CHAT}\\\\*"`));
    expect(h.prompts[0]).toContain('mail:req-1@owner.example');
    expect(h.prompts[0]).not.toContain('DE00 1234');
  });

  it('starting a conversation with a reply to someone’s email: their email is mail for the model', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: draft my answer',
      body: [
        'Draft my answer to this, please.',
        '',
        'On Mon, Oct 13, 2026 at 5:00 PM Client <client@example.test> wrote:',
        '> Can you send the contract by Friday? My cell is +1 555 0199.',
      ].join('\n'),
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(2));
    expect((await h.store.listMessages(session))[0]?.content).toBe('Draft my answer to this, please.');
    expect(h.prompts[0]).toContain('mail.read');
    expect(h.prompts[0]).not.toContain('555 0199');
  });

  it('a bare forward under a bare ask: is stored as a forward, and points the model at the mail', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask:',
      body: '---------- Forwarded message ---------\nFrom: Supplier <billing@supplier.example>\n\nInvoice 1042.',
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect((await h.store.listMessages(session))[0]?.content).toBe('(forwarded email)'));
    expect(h.prompts[0]).toContain('mail.read');
  });

  it('⛔ §8.12 — a forward whose mail is not found gives none of its text as the owner’s', async () => {
    const h = harness();
    // A mail app that marks its forward no way the door reads: no marker, no quote.
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: Fwd: Invoice 1042',
      body: 'Invoice 1042 is due on Friday.\nOur bank: IBAN DE00 1234.',
      html: '<div>Invoice 1042 is due on Friday.</div><div>Our bank: IBAN DE00 1234.</div>',
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect((await h.store.listMessages(session))[0]?.content).toBe('(forwarded email)'));
    expect(h.prompts[0]).toContain('mail.read');
    expect(h.prompts[0]).not.toContain('DE00 1234');
  });

  it('⛔ §8.12 — so is one whose HTML shows only a signature: it may be the forwarded email’s', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: FW: Invoice 1042',
      body: 'Invoice 1042 is due. Our bank: IBAN DE00 1234. Supplier Ltd',
      html: '<div>Invoice 1042 is due. Our bank: IBAN DE00 1234.</div><div class="signature">Supplier Ltd</div>',
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect((await h.store.listMessages(session))[0]?.content).toBe('(forwarded email)'));
    expect(h.prompts[0]).toContain('mail.read');
    expect(h.prompts[0]).not.toContain('DE00 1234');
  });

  it('§8.12 — an email forwarded as a file leaves its text the owner’s: the mail is the file', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: Fwd: Invoice 1042', body: 'Can you handle this?',
      html: '<div>Can you handle this?</div>',
      files: [{ filename: 'Invoice 1042.eml', mime_type: 'text/plain', bytes: Buffer.from('From: Supplier\r\n\r\nInvoice.') }],
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(2));
    const [asked] = await h.store.listMessages(session);
    expect(asked?.content).toBe('Can you handle this?');
    expect(asked?.attachments?.map((file) => file.filename)).toEqual(['Invoice 1042.eml']);
  });

  it('§8.12 — a forward its mail app marks keeps the owner’s note, and points the model at the mail', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: Fwd: Invoice 1042', body: 'What do you make of this?',
      html: '<div dir="ltr">What do you make of this?</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">'
        + '---------- Forwarded message ---------<br>From: Supplier</div><br><div>Our bank: IBAN DE00 1234.</div></div>',
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect((await h.store.listMessages(session))[0]?.content).toBe('What do you make of this?'));
    expect(h.prompts[0]).toContain('mail.read');
    expect(h.prompts[0]).not.toContain('DE00 1234');
  });

  it('§8.12 — a reply to a forward is no forward: its words are the owner’s', async () => {
    const h = harness();
    // No prefix: a forward starts the conversation, and its replies are `Re: Fwd:`.
    h.door.setAskPrefix(null);
    await h.send({
      id: 'req-1@owner.example', subject: 'Fwd: lunch?', body: 'Where should I have lunch?',
      html: '<div>Where should I have lunch?</div><div class="gmail_quote">---------- Forwarded message ---------'
        + '<br>From: Ann</div><div>Lunch at the deli?</div>',
    });
    await eventually(() => expect(h.prompts).toHaveLength(1));
    expect(h.prompts[0]).toContain('mail.read');
    clock += 60_000;
    await h.send({
      id: 'req-2@owner.example', subject: 'Re: Fwd: lunch?', body: 'Somewhere near the office.',
      inReplyTo: '<req-1@owner.example>', references: '<req-1@owner.example>',
    });
    await eventually(() => expect(h.prompts).toHaveLength(2));
    const session = h.sessionOf('req-1@owner.example');
    expect((await h.store.listMessages(session)).map((m) => m.content)[2]).toBe('Somewhere near the office.');
    // No note of its own: the first turn's, carried with it, names the forward.
    expect(h.prompts[1]).not.toContain('mail:req-2@owner.example');
  });

  it('§8.12 — an attached email the mail parser wrote into the text is mail, even in a conversation', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: invoices', body: 'Any invoices due?' });
    await eventually(() => expect(h.prompts).toHaveLength(1));
    clock += 60_000;
    await h.send({
      id: 'req-2@owner.example', subject: 'Re: ask: invoices', body: 'This one.',
      inReplyTo: '<req-1@owner.example>', references: '<req-1@owner.example>',
      // As mailparser writes an email sent inline as a message/rfc822 part.
      html: '<p>This one.</p><br/>\n<table class="mp_head"><tr><td class="mp_head_key">From:</td>'
        + '<td class="mp_head_value">Supplier</td></tr></table><br/>\n<p>Our bank: IBAN DE00 1234.</p>',
    });
    await eventually(() => expect(h.prompts).toHaveLength(2));
    expect(h.prompts[1]).toContain('This one.');
    expect(h.prompts[1]).toContain('mail:req-2@owner.example');
    expect(h.prompts[1]).not.toContain('DE00 1234');
  });

  it('§8.12 — a reply written below the quote keeps the owner’s words', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Where should I have lunch?' });
    await eventually(() => expect(h.prompts).toHaveLength(1));
    clock += 60_000;
    await h.send({
      id: 'req-2@owner.example', subject: 'Re: ask: lunch?', body: 'answer 1 Near the office.',
      inReplyTo: '<req-1@owner.example>', references: '<req-1@owner.example>',
      html: '<div class="gmail_quote"><div class="gmail_attr">On Tue, Recued wrote:</div><blockquote>answer 1</blockquote></div>'
        + '<div>Near the office.</div>',
    });
    await eventually(() => expect(h.prompts).toHaveLength(2));
    const session = h.sessionOf('req-1@owner.example');
    expect((await h.store.listMessages(session)).map((m) => m.content)[2]).toBe('Near the office.');
    expect(h.prompts[1]).not.toContain('mail.read');
  });

  it('a forward with no word of the owner’s asks what its subject asks', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: thoughts?',
      body: '---------- Forwarded message ---------\nFrom: Supplier <billing@supplier.example>\n\nInvoice 1042.',
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect((await h.store.listMessages(session))[0]?.content).toBe('thoughts?'));
    expect(h.prompts[0]).toContain('mail.read');
  });
});

describe('D-318 step 4 — an email’s files', () => {
  const PDF = Buffer.from('%PDF-1.7\nquote\n%%EOF');
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  it('its attachment is the turn’s file — the signature’s logo is not', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: is this quote fair?', body: 'Is this quote fair?',
      html: '<div>Is this quote fair?</div><div class="gmail_signature"><img src="cid:logo@x"></div>',
      files: [
        { filename: 'quote.pdf', mime_type: 'application/pdf', bytes: PDF },
        { filename: 'logo.png', mime_type: 'image/png', bytes: PNG, disposition: 'inline', content_id: 'logo@x' },
      ],
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(2));
    const [asked] = await h.store.listMessages(session);
    expect(asked?.attachments?.map((file) => file.filename)).toEqual(['quote.pdf']);
    expect(h.prompts[0]).toContain('files attached to this message: quote.pdf');
    expect(h.prompts[0]).not.toContain('logo.png');
  });

  it('the same words with other files are another request', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: which is better?', body: 'Which is better?',
      files: [{ filename: 'a.pdf', mime_type: 'application/pdf', bytes: Buffer.from('%PDF-1.7\nA\n%%EOF') }] });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(2));
    clock += 60_000;
    await h.send({ id: 'req-2@owner.example', subject: 'Re: ask: which is better?', body: 'Which is better?',
      references: '<req-1@owner.example>',
      files: [{ filename: 'b.pdf', mime_type: 'application/pdf', bytes: Buffer.from('%PDF-1.7\nB\n%%EOF') }] });
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(4));
    expect(h.prompts).toHaveLength(2);
  });

  it('a photo with nothing written is still a request', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask:', body: '',
      files: [{ filename: 'IMG_1.png', mime_type: 'image/png', bytes: PNG }],
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(2));
    const [asked] = await h.store.listMessages(session);
    expect(asked?.attachments?.map((file) => file.filename)).toEqual(['IMG_1.png']);
  });
});

describe('D-318 step 6 — a request reached too late is answered in one line, and nothing runs', () => {
  const HOUR = 3_600_000;

  it('one the chat mailbox received more than an hour ago is stored, answered in one line, and the model never asked', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: what is on today?', body: 'What is on my calendar today?',
      // Received at 15:02 on the owner's clock; Recued reaches it at 17:00.
      receivedAt: clock - HOUR - 58 * 60_000,
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect((await h.store.listMessages(session)).map((m) => [m.role, m.content])).toEqual([
      ['user', 'what is on today?\n\nWhat is on my calendar today?'],
      ['assistant', 'This email arrived at 15:02, and Recued could not get to it within an hour, so it did not act on '
        + 'it. Ask again if you still need it.'],
    ]));
    expect(h.prompts).toEqual([]);
    // A turn of the conversation like any other, from the email door: its
    // answer is owed by email, and a reply continues the conversation.
    expect(h.runAs).toHaveLength(1);
    expect(h.proof.get(CHAT, 'req-1@owner.example')).toMatchObject({ admit_state: 'admitted' });
    clock += 60_000;
    await h.send({
      id: 'req-2@owner.example', subject: 'Re: ask: what is on today?', body: 'Yes, please check now.',
      references: '<req-1@owner.example>',
    });
    expect(h.sessionOf('req-2@owner.example')).toBe(session);
    await eventually(() => expect(h.prompts).toHaveLength(1));
    expect(h.prompts[0]).toContain('Yes, please check now.');
  });

  it('the time is the owner’s setting', async () => {
    const h = harness();
    h.door.setStaleAfterMinutes(5);
    await h.send({ id: 'req-1@owner.example', subject: 'ask: one', body: 'First.', receivedAt: clock - 10 * 60_000 });
    await h.send({ id: 'req-2@owner.example', subject: 'ask: two', body: 'Second.', receivedAt: clock - 3 * 60_000 });
    const late = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect((await h.store.listMessages(late))[1]?.content)
      .toBe('This email arrived at 16:50, and Recued could not get to it within 5 minutes, so it did not act on it. '
        + 'Ask again if you still need it.'));
    await eventually(() => expect(h.prompts).toHaveLength(1));
    expect(h.prompts[0]).toContain('Second.');
  });

  it('one a recovery scan found is answered in one line however fresh it is (P22)', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Where should I have lunch?',
      receivedAt: clock - 60_000, recovered: true,
    });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect((await h.store.listMessages(session))[1]?.content)
      .toBe('This email arrived at 16:59, and Recued found it only while catching up after a gap in the chat '
        + 'mailbox\'s sync, so it did not act on it. Ask again if you still need it.'));
    expect(h.prompts).toEqual([]);
  });

  it('decided as the turn runs: a request that waits in the queue past the setting is answered in one line', async () => {
    const h = harness({ holdFirstAnswer: true });
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Where should I have lunch?' });
    await eventually(() => expect(h.prompts).toHaveLength(1));
    // Fresh when it reaches chat, behind a turn still running in its conversation.
    clock += 60_000;
    await h.send({
      id: 'req-2@owner.example', subject: 'Re: ask: lunch?', body: 'And a coffee after?',
      references: '<req-1@owner.example>',
    });
    expect(h.proof.get(CHAT, 'req-2@owner.example')).toMatchObject({ admit_state: 'admitted' });
    clock += 2 * HOUR;
    h.release();
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect((await h.store.listMessages(session)).map((m) => m.content)).toEqual([
      'lunch?\n\nWhere should I have lunch?', 'answer 1', 'And a coffee after?',
      'This email arrived at 17:01, and Recued could not get to it within an hour, so it did not act on it. '
        + 'Ask again if you still need it.',
    ]));
    expect(h.prompts).toHaveLength(1);
  });
});

describe('mailChatLateness and mailChatLateAnswer', () => {
  const AT = Date.UTC(2026, 9, 14, 9, 0, 0);

  it('a recovery scan’s request is late whatever its age; another only past the setting', () => {
    expect(mailChatLateness({ received_at: AT, recovered: true }, 60, AT)).toBe('recovered');
    expect(mailChatLateness({ received_at: AT - 60 * 60_000 }, 60, AT)).toBeNull();
    expect(mailChatLateness({ received_at: AT - 60 * 60_000 - 1 }, 60, AT)).toBe('stale');
    // A provider clock ahead of the server's is not late, and a turn queued
    // before step 6 carries no time.
    expect(mailChatLateness({ received_at: AT + 60_000 }, 5, AT)).toBeNull();
    expect(mailChatLateness({}, 5, AT)).toBeNull();
  });

  it('says when it arrived on the owner’s clock, the day too when it was not today, and how late is too late', () => {
    expect(mailChatLateAnswer('stale', AT - 2 * 60 * 60_000, 120, AT, 'Europe/London'))
      .toBe('This email arrived at 08:00, and Recued could not get to it within 2 hours, so it did not act on it. '
        + 'Ask again if you still need it.');
    expect(mailChatLateAnswer('stale', AT - 20 * 60 * 60_000, 1440, AT, 'America/New_York'))
      .toMatch(/^This email arrived at 09:00 on 13 October, and Recued could not get to it within a day,/);
    expect(mailChatLateAnswer('stale', AT - 90 * 60_000, 90, AT, 'Asia/Hong_Kong'))
      .toMatch(/arrived at 15:30, and Recued could not get to it within 90 minutes,/);
    // A zone the host cannot read: UTC's clock, never a throw.
    expect(mailChatLateAnswer('recovered', AT - 60_000, 60, AT, 'Not/AZone')).toMatch(/^This email arrived at 08:59, /);
  });
});

describe('D-318 — a request the chat mailbox already answered: a restored server, or a second copy', () => {
  // A server restored from a backup remembers none of the requests answered
  // since it was taken; the chat mailbox's Sent folder does. Without it, the
  // copy that caught up ran each again (a second reminder, a second send), or
  // answered it "too late" — saying Recued did not act on one it acted on.
  const answered = (n: number): MailSentRepliesResult => ({
    status: 'found',
    matches: [{ reconciliation_id: mailChatAnswerReconciliationId(`answer-${n}-on-the-other-copy`), sent_at: clock - 1_000 }],
  });
  const reasonOf = (h: ReturnType<typeof harness>, id: string): string | null | undefined =>
    h.proof.recent(CHAT, 10).find((row) => row.rfc_message_id === id)?.admit_reason;

  it('⛔ one whose answer is in the Sent folder is not run, stored, or answered again', async () => {
    const h = harness();
    h.sentReplies.set('req-1@owner.example', answered(1));
    await h.send({ id: 'req-1@owner.example', subject: 'ask: remind me at 5', body: 'Remind me at 5 to call the bank.' });

    await eventually(() => expect(h.proof.get(CHAT, 'req-1@owner.example')).toMatchObject({ admit_state: 'dropped' }));
    expect(reasonOf(h, 'req-1@owner.example')).toBe('already answered: its answer is in the chat mailbox\'s Sent folder');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.prompts).toEqual([]);
    expect(h.store.listSessions()).toEqual([]);
    expect(h.conversations.conversationOf(CHAT, 'req-1@owner.example')).toBeNull();
    // The owner has the answer: there is nothing to tell them.
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.repliesAsked).toEqual(['req-1@owner.example']);
  });

  it('a reply there that is not an email chat answer does not stop it: the owner’s own, or another send’s', async () => {
    const h = harness();
    h.sentReplies.set('req-1@owner.example', {
      status: 'found',
      matches: [
        // The owner answered it from the chat mailbox's own mail app…
        { reconciliation_id: null, sent_at: clock - 1_000 },
        // …or a recipe's email replied to it (D-127).
        { reconciliation_id: 'customer-reminder:5d1c', sent_at: clock - 500 },
      ],
    });
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Where should I have lunch?' });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(2));
    expect(h.proof.get(CHAT, 'req-1@owner.example')).toMatchObject({ admit_state: 'admitted' });
  });

  it('a Sent folder that could not be read is asked again; one that cannot be asked lets it run', async () => {
    const h = harness();
    h.sentReplies.set('req-1@owner.example', { status: 'unavailable', reason: 'provider_error' });
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Where should I have lunch?' });
    expect(h.proof.get(CHAT, 'req-1@owner.example')).toMatchObject({ admit_state: 'waiting' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.prompts).toEqual([]);

    // Readable again by the next try.
    h.sentReplies.delete('req-1@owner.example');
    clock += 15_000;
    await h.proof.tick();
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(2));
    expect(h.repliesAsked).toEqual(['req-1@owner.example', 'req-1@owner.example']);

    // An IMAP mailbox without a Sent folder can never be asked: waiting would
    // only lose the request.
    h.sentReplies.set('req-2@owner.example', { status: 'unavailable', reason: 'unsupported' });
    clock += 60_000;
    await h.send({ id: 'req-2@owner.example', subject: 'ask: weather', body: 'Will it rain tomorrow?' });
    const second = h.sessionOf('req-2@owner.example');
    await eventually(async () => expect(await h.store.listMessages(second)).toHaveLength(2));
  });

  it('a hand-over repeated after a crash is not asked again, though its answer is in the Sent folder by then', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: once', body: 'Only once, please.' });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(2));
    // This server sent the answer; the queue has the turn.
    h.sentReplies.set('req-1@owner.example', answered(1));

    await expect(h.turns.admit(h.request('req-1@owner.example'))).resolves.toEqual({ outcome: 'admitted' });
    expect(h.repliesAsked).toEqual(['req-1@owner.example']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(1);
  });
});

describe('D-318 step 3 — what chat refuses, and what it asks for again', () => {
  it('refuses for good when the door changed, the email is gone, or it says nothing', async () => {
    const h = harness();
    h.records.set('mail:empty@owner.example', {
      record_id: 'mail:empty@owner.example', received_at: clock, modified_at: clock, size_bytes: 0, source_id: 'empty',
      hot_fields: { subject: '  ' }, body_inline: '',
    } as CollectionRecord);
    await expect(h.turns.admit(h.request('gone@owner.example'))).resolves.toEqual({
      outcome: 'dropped', reason: 'the email is no longer in the chat mailbox',
    });
    await expect(h.turns.admit(h.request('empty@owner.example'))).resolves.toEqual({
      outcome: 'dropped', reason: 'the email has no text',
    });
    h.door.setChatMailbox(null);
    await expect(h.turns.admit(h.request('gone@owner.example'))).resolves.toEqual({
      outcome: 'dropped', reason: 'the door no longer names this chat mailbox',
    });
    expect(h.store.listSessions()).toEqual([]);
  });

  it('asks again while the chat mailbox is not registered yet', async () => {
    const h = harness();
    h.mailboxes.splice(0, 1);
    await expect(h.turns.admit(h.request('req-1@owner.example'))).rejects.toThrow('The chat mailbox is not connected.');
  });

  it('a conversation the owner deleted is not brought back by the same email', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: secret', body: 'Something I later deleted' });
    const session = h.sessionOf('req-1@owner.example');
    await eventually(async () => expect(await h.store.listMessages(session)).toHaveLength(2));
    h.store.deleteSession(session);

    await expect(h.turns.admit(h.request('req-1@owner.example'))).resolves.toEqual({
      outcome: 'dropped', reason: 'its conversation was deleted',
    });
    expect(h.store.getSession(session)).toBeNull();
  });

  it('without a queue there is nothing to hand over to', () => {
    expect(composeMailChatTurns({
      orchestrator: { turnQueue: undefined } as never,
      door: {
        isChatMailbox: () => true,
        get: () => ({
          chat_mailbox: CHAT, ask_prefix: 'ask:', owner_mailboxes: [OWNER], chat_address: CHAT_ADDRESS,
          stale_after_minutes: 60, paused_at: null, enrolled_senders: [],
        }),
      },
      mailboxes: () => [],
      readBody: async () => null,
      conversations: { conversationOf: () => null, find: () => null, record: (_c, _m, id) => id, repeats: () => 1 },
    })).toBeUndefined();
  });
});

describe('mailChatSubjectLead', () => {
  it('leads with the subject past ask:, unless it is someone’s mail or the body already says it', () => {
    expect(mailChatSubjectLead('ask: remind me at 3', 'ask:', 'testing')).toBe('remind me at 3');
    expect(mailChatSubjectLead('Remind me at 3', null, 'testing')).toBe('Remind me at 3');
    // The body begins with it, case and spacing aside.
    expect(mailChatSubjectLead('ask: Lunch?', 'ask:', 'lunch?  Where should I go?')).toBeNull();
    // A reply's subject, a forward's, or under ask: the subject of the email replied to.
    expect(mailChatSubjectLead('Re: ask: lunch?', 'ask:', 'Make it 7.')).toBeNull();
    expect(mailChatSubjectLead('Fwd: Invoice 1042', 'ask:', 'Thoughts?')).toBeNull();
    expect(mailChatSubjectLead('ask: Fwd: Invoice 1042', 'ask:', 'Thoughts?')).toBeNull();
    expect(mailChatSubjectLead('ask: Re: Invoice 1042', 'ask:', 'Thoughts?')).toBeNull();
    // Nothing past the prefix.
    expect(mailChatSubjectLead('ask:', 'ask:', 'What is on today?')).toBeNull();
  });
});

describe('mailChatTitle', () => {
  it('drops reply and forward prefixes and the ask: prefix, and names an empty subject', () => {
    expect(mailChatTitle('Re: RE: Fwd: FW:  Lunch   plans ')).toBe('Lunch plans');
    expect(mailChatTitle('ask: lunch')).toBe('ask: lunch');
    expect(mailChatTitle('Re: ASK: lunch', 'ask:')).toBe('lunch');
    expect(mailChatTitle('chat: lunch', 'chat:')).toBe('lunch');
    expect(mailChatTitle('ask:', 'ask:')).toBe('Email');
    expect(mailChatTitle('  ')).toBe('Email');
    expect(mailChatTitle('x'.repeat(300))).toHaveLength(120);
  });
});
