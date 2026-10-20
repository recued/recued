/** D-318 step 5 — the answer goes back by email (§4.6).
 *
 *  Through the real pieces: the chat store, the chat orchestrator and D-265's
 *  queue, the proof handing over to the door's turns, the conversation map —
 *  and a real mail collection for the chat mailbox, so the send claim that
 *  keeps an answer from going twice is the real one. Only the model, the
 *  owner's mailbox and the chat mailbox's PROVIDER are stand-ins: the provider
 *  takes the send, and keeps a Sent record the answers can ask.
 *
 *  The order is the server's: the owner's email is proven → its turn runs → the
 *  orchestrator stores the answer, and that commit owes it by email → the
 *  answers send it from the chat mailbox → its Message-ID, as the Sent record
 *  shows it, joins the conversation. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { IngredientError } from '@recued/ingredients';
import type { NotificationMessage } from '@recued/notification';
import { createMiddlewareRegistry } from '@recued/middleware';
import { registerFirstPartyMiddlewares } from '@recued/middleware-recued';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type {
  AIOutput,
  ChatDispatchResult,
  CollectionRecord,
  InternalToolRegistry,
  MailSentByMessageIdResult,
  MailSentReconciliationQuery,
  MailSentReconciliationResult,
  ToolEntry,
} from '@recued/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChatOrchestrator, type ExecuteChatAiCall } from '../chat-orchestrator.js';
import { __clearSessionBriefs, __clearUnfoldedUserMessages } from '../chat-rolling-brief.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createMailCollection, type MailStoredContext } from '../collections/mail/mail-collection.js';
import type { CanonicalMessage, OutgoingMessage } from '../collections/mail/provider.js';
import {
  composeMailChatAnswers,
  MAIL_CHAT_ANSWER_GIVE_UP_MS,
  MAIL_CHAT_ANSWER_KEEP_MS,
  MAIL_CHAT_ANSWER_RETRY_MS,
  mailChatAnswerBody,
  mailChatAnswerReferences,
  mailChatAnswerSubject,
  type MailChatAnswers,
} from '../mail-chat-door/answers.js';
import { MAIL_CHAT_ANSWER_RECONCILIATION_PREFIX } from '../mail-chat-door/conversation-mail.js';
import { createMailChatConversations } from '../mail-chat-door/conversations.js';
import {
  MAIL_CHAT_FOLLOW_UP_KEEP_MS,
  mailChatFollowUpId,
  mailChatFollowUpText,
  mailChatRunOutcome,
  recordMailChatSettledRun,
} from '../mail-chat-door/follow-ups.js';
import type { PreflightRunSettled } from '../preflight-resumer.js';
import { createMailChatSentProof, type MailChatProofMailbox } from '../mail-chat-door/sent-proof.js';
import { composeMailChatTurns } from '../mail-chat-door/turns.js';
import { handleMailChatDoorRecent } from '../collections/mail/chat-door-handler.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createMailChatDoorStore } from '../storage/mail-chat-door-store.js';
import { createMailSendClaimStore } from '../storage/mail-send-claim-store.js';
import { createRecipeStore } from '../recipe-store.js';
import { recipeToolTitle } from '../recipe-tool-name.js';

const CHAT = 'recued-chat';
const CHAT_ADDRESS = 'recued@chat.example';
const OWNER = 'me';
const OWNER_ADDRESS = 'me@owner.example';
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'd318-answers' };
const key = () => new Uint8Array(32).fill(67);
const eventually = (assert: () => unknown | Promise<unknown>) => vi.waitFor(assert, { timeout: 8_000, interval: 10 });

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  __clearSessionBriefs();
  __clearUnfoldedUserMessages();
});

/** What the chat mailbox's provider does with the next send. `went_unheard`:
 *  the message goes out, and the answer to the send is lost on the way back. */
type SendOutcome = 'ok' | 'refused' | 'lost' | 'went_unheard' | 'bad_input' | 'message_refused';

interface SentCopy {
  readonly gmail_id: string;
  /** The Message-ID Gmail gave it: not the one a send returns. */
  readonly message_id: string;
  readonly msg: OutgoingMessage;
  readonly sent_at: number;
}

/** `held`: the answers are not told when a turn ends, so an answer owed stays
 *  pending until the test asks for a round. */
/** The recipe behind the tests' `recued-core/send-email` tool, in a real recipe
 *  store, read by the title lookup the server composes. */
const sendEmailTitle = (() => {
  const store = createRecipeStore('/nonexistent');
  store.register({
    recipe_id: 'send-email', version: 1, ttl: 60,
    metadata: { name: 'Send an email', description: 'One email.', author: 'test', supported_platforms: [] },
    variables: {}, prefetch_steps: [], steps: [], output: { render: [] },
  } as never);
  return (tool_name: string) => recipeToolTitle(store, tool_name);
})();

const harness = (options: {
  held?: boolean;
  rfcIds?: boolean;
  /** The chat mailbox's provider; Gmail unless given. */
  kind?: string;
  /** Part 2 — the tools and the model, when a test scripts them. */
  registry?: InternalToolRegistry;
  executeAiCall?: ExecuteChatAiCall;
  /** §8.18 — the chat mailbox is the owner's own: they write to it from itself,
   *  and its provider keeps their Sent record. */
  oneMailbox?: boolean;
  /** The follow-up's title lookup, as the server composes it over its recipe
   *  store (`recipeToolTitle`); `null` composes none. */
  toolTitle?: ((tool_name: string) => string | undefined) | null;
} = {}) => {
  const chatAddress = options.oneMailbox ? OWNER_ADDRESS : CHAT_ADDRESS;
  const dir = mkdtempSync(join(tmpdir(), 'd318-answers-'));
  const db = new Database(join(dir, 'server.sqlite'));
  cleanup.push(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });
  ensureChatSchema(db);
  const store = createChatStore(db, key);

  let answerText = 'Booked for 7.';
  const raw = createChatOrchestrator({
    chatStore: store,
    selfSignature: signature,
    middlewareRegistry: (() => { const r = createMiddlewareRegistry(); registerFirstPartyMiddlewares(r); return r; })(),
    registry: options.registry ?? {
      list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {},
    },
    executeAiCall: options.executeAiCall ?? (async () => ({ body: { response: answerText, events: [], tool_calls: [] } })),
  });
  const orchestrator = withQueuedChatTurns(raw, { db, store, getKey: key, pollMs: 5 });
  cleanup.push(() => orchestrator.turnQueue!.close());

  // The chat mailbox's provider: the sends it was given, and its Sent record.
  const outcomes: SendOutcome[] = [];
  const sends: OutgoingMessage[] = [];
  const sentRecord: SentCopy[] = [];
  let showSentRecord = true;
  let canSend = true;
  const lookups: MailSentReconciliationQuery[] = [];
  const sentByOwner = new Set<string>();
  const provider = {
    kind: options.kind ?? 'gmail',
    get sendCapable() { return canSend; },
    accountEmail: chatAddress,
    // One mailbox: the chat mailbox's own Sent record is the owner's.
    ...(options.oneMailbox ? {
      lookupSentByMessageId: async ({ rfc_message_id }: { rfc_message_id: string }): Promise<MailSentByMessageIdResult> =>
        sentByOwner.has(rfc_message_id)
          ? { status: 'found', matches: [{ to: [OWNER_ADDRESS], subject: 's', sent_at: Date.now() - 2_000 }] }
          : { status: 'not_found' },
    } : {}),
    send: async (msg: OutgoingMessage) => {
      sends.push(msg);
      const outcome = outcomes.shift() ?? 'ok';
      if (outcome === 'refused') {
        throw new IngredientError('MAIL_SEND_RECIPIENT_INVALID', 'Gmail rejected a recipient (400)', { not_sent: true });
      }
      if (outcome === 'lost') throw new Error('socket hang up');
      if (outcome === 'bad_input') throw new IngredientError('BAD_INPUT', 'the subject is not one header line');
      if (outcome === 'message_refused') {
        throw new IngredientError('MAIL_SEND_MESSAGE_REFUSED', 'Graph refused the message (400)', { not_sent: true });
      }
      const n = sentRecord.length + 1;
      const copy: SentCopy = { gmail_id: `g${n}`, message_id: `CAgmail${n}@mail.gmail.com`, msg, sent_at: Date.now() };
      sentRecord.push(copy);
      if (outcome === 'went_unheard') throw new Error('socket hang up');
      // IMAP and Graph return the Message-ID itself; Gmail its own id.
      const message_id = options.rfcIds ? `<${copy.message_id}>` : copy.gmail_id;
      return { source_id: copy.gmail_id, message_id, sent_at: copy.sent_at, thread_id: msg.thread_id ?? 'new' };
    },
    lookupSentByReconciliationId: async (query: MailSentReconciliationQuery): Promise<MailSentReconciliationResult> => {
      lookups.push(query);
      const copy = showSentRecord
        ? sentRecord.find((entry) => entry.msg.reconciliation_id === query.reconciliation_id
          && entry.msg.subject === query.subject && entry.msg.to[0] === query.recipient)
        : undefined;
      return copy === undefined
        ? { status: 'not_found', scanned_candidates: sentRecord.length }
        : {
            status: 'matched',
            scanned_candidates: sentRecord.length,
            match: { proof_kind: 'envelope', source_id: copy.gmail_id, provider_message_id: `<${copy.message_id}>`, sent_at: copy.sent_at },
          };
    },
    initialScan: async () => {},
    poll: async () => {},
    stop: async () => {},
  };
  const chatMailbox = createMailCollection({
    db,
    blobs: createBlobStore(join(dir, 'blobs')),
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(),
    slug: CHAT,
    provider: provider as never,
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }) as never,
  });
  const ownerMailbox = {
    platform: 'mail', slug: OWNER, accountEmail: OWNER_ADDRESS,
    get: () => null,
    lookupSentByMessageId: async ({ rfc_message_id }: { rfc_message_id: string }): Promise<MailSentByMessageIdResult> =>
      sentByOwner.has(rfc_message_id)
        ? { status: 'found', matches: [{ to: [CHAT_ADDRESS], subject: 's', sent_at: Date.now() - 2_000 }] }
        : { status: 'not_found' },
  } as unknown as MailChatProofMailbox;
  const mailboxes = (options.oneMailbox ? [chatMailbox] : [chatMailbox, ownerMailbox]) as never[];

  const door = createMailChatDoorStore(db);
  door.setChatMailbox(CHAT, chatAddress);
  door.setOwnerMailboxes([options.oneMailbox ? CHAT : OWNER]);
  const conversations = createMailChatConversations(db);
  let answers: MailChatAnswers | undefined;
  const turns = composeMailChatTurns({
    orchestrator, door, mailboxes: () => mailboxes,
    readBody: async (record) => record.body_inline ?? null,
    conversations,
    ...(options.held ? {} : { afterTurn: () => answers?.kick() }),
  })!;
  const proof = createMailChatSentProof({ db, door, mailboxes: () => mailboxes });
  proof.bindAdmit(turns.admit);
  cleanup.push(() => proof.dispose());

  let skew = 0;
  const askOwner = vi.fn(async (_reconciliation_id: string) => undefined);
  const closeOwnerQuestion = vi.fn(async (_reconciliation_id: string) => undefined);
  const notices: NotificationMessage[] = [];
  const historyRows: string[] = [];
  answers = composeMailChatAnswers({
    db, chatStore: store, door, mailboxes: () => mailboxes as never, requests: proof, conversations,
    claims: createMailSendClaimStore(db),
    askOwner,
    closeOwnerQuestion,
    publicBaseUrl: () => null,
    auditLog: { logActivity: async (entry) => { historyRows.push(entry.activity_id); } },
    ...(options.toolTitle === null ? {} : { toolTitle: options.toolTitle ?? sendEmailTitle }),
    now: () => Date.now() + skew,
  })!;
  answers.bindNotify(async (message) => { notices.push(message); });
  answers.start();
  cleanup.push(() => answers!.dispose());

  /** The owner sends an email to the chat mailbox; it is proven and runs. */
  const send = async (email: {
    id: string; subject: string; body: string; thread?: string; references?: string; inReplyTo?: string;
    /** Step 6 — when the chat mailbox's provider received it; now by default. */
    receivedAt?: number;
  }): Promise<void> => {
    sentByOwner.add(email.id);
    const record_id = `mail:${email.id}`;
    // One mailbox: Gmail keeps an email to oneself as one message, filed as sent.
    const direction = options.oneMailbox ? 'outbound' : 'inbound';
    chatMailbox.upsert({
      record_id, platform: 'mail', slug: CHAT, received_at: Date.now(), modified_at: Date.now(),
      size_bytes: email.body.length, source_id: email.id, body_inline: email.body,
      hot_fields: {
        subject: email.subject, from: OWNER_ADDRESS, to: [chatAddress], cc: [],
        thread_id: email.thread ?? `thread-${email.id}`, direction, rfc_message_id: email.id,
      },
    } as unknown as CollectionRecord);
    const msg: CanonicalMessage = {
      source_id: email.id, rfc_message_id: `<${email.id}>`, from: OWNER_ADDRESS, to: [chatAddress], cc: [],
      subject: email.subject, thread_id: email.thread ?? `thread-${email.id}`, folder_or_label: 'INBOX',
      direction, is_read: false, is_flagged: false, has_attachments: false,
      ...(options.oneMailbox ? { labels: ['SENT', 'INBOX'] } : {}),
      received_at: Date.now(), provider_received_at: email.receivedAt ?? Date.now(), body_text: email.body,
      headers: {
        ...(email.inReplyTo ? { 'in-reply-to': email.inReplyTo } : {}),
        ...(email.references ? { references: email.references } : {}),
      },
    };
    const ctx: MailStoredContext = {
      slug: CHAT, record_id, backfill_complete: true, backfill_days: 30,
      ...(options.oneMailbox ? { provider_kind: 'gmail' as const, account_email: OWNER_ADDRESS } : {}),
    };
    proof.onMessageStored(msg, ctx);
    proof.onMessageUpserted(msg, { ...ctx, account_email: chatAddress, first_seen: true, attachments: [] });
    await proof.tick();
  };

  const sessionOf = (id: string): string => `mail:${CHAT}:${conversations.conversationOf(CHAT, id)!}`;
  const answerRows = () => db.prepare('SELECT answer_id, state FROM mail_chat_answers ORDER BY created_at')
    .all() as Array<{ answer_id: string; state: string }>;
  const answerOf = async (requestId: string) => {
    const session = sessionOf(requestId);
    await eventually(async () => expect((await store.listMessages(session)).some((m) => m.role === 'assistant')).toBe(true));
    const message = (await store.listMessages(session)).find((m) => m.role === 'assistant')!;
    return message.id;
  };

  return {
    db, store, door, conversations, proof, chatMailbox, outcomes, sends, sentRecord, lookups, askOwner, notices,
    closeOwnerQuestion, historyRows, send, sessionOf, answerRows, answerOf, now: () => Date.now() + skew,
    answers: answers!,
    setAnswer: (text: string) => { answerText = text; },
    hideSentRecord: (hidden: boolean) => { showSentRecord = !hidden; },
    setCanSend: (can: boolean) => { canSend = can; },
    advance: (ms: number) => { skew += ms; },
  };
};

describe('D-318 step 5 — the answer goes back by email', () => {
  it('is sent from the chat mailbox to the owner alone, in the request’s thread, marked automatic and Recued’s', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.', thread: 'thread-9' });
    const answer = await h.answerOf('req-1@owner.example');

    await eventually(() => expect(h.answers.get(answer)?.state).toBe('sent'));
    expect(h.sends).toHaveLength(1);
    const sent = h.sends[0]!;
    expect(sent.to).toEqual([OWNER_ADDRESS]);
    expect(sent.cc ?? []).toEqual([]);
    expect(sent.bcc ?? []).toEqual([]);
    expect(sent.reply_to).toBeUndefined();
    expect(sent.subject).toBe('Re: ask: lunch?');
    expect(sent.body_text).toBe('Booked for 7.');
    expect(sent.in_reply_to).toBe('<req-1@owner.example>');
    expect(sent.references).toEqual(['<req-1@owner.example>']);
    expect(sent.thread_id).toBe('thread-9');
    expect(sent.automatic).toBe(true);
    expect(sent.reconciliation_id).toMatch(new RegExp(`^${MAIL_CHAT_ANSWER_RECONCILIATION_PREFIX}[0-9a-f]{32}$`));
    expect(h.answers.get(answer)?.reconciliation_id).toBe(sent.reconciliation_id);
  });

  it('D-318 step 7 — the test round trip sees the request proven, handed to chat, and its answer sent', async () => {
    const h = harness();
    await h.send({ id: 'ping@owner.example', subject: 'ask: ping', body: 'ping', thread: 'thread-1' });
    const answer = await h.answerOf('ping@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('sent'));
    const { requests } = handleMailChatDoorRecent({ store: h.door, requests: h.proof, answers: h.answers });
    expect(requests).toEqual([{
      arrived_at: expect.any(Number), from: OWNER_ADDRESS, state: 'proven', proof: 'sent_record', reason: null,
      chat: 'admitted', chat_reason: null, sender_auth: 'unknown', answer: 'sent', answered_at: expect.any(Number),
    }]);
    // Never what the email says.
    expect(JSON.stringify(requests)).not.toMatch(/ping/);
  });

  it('D-318 step 6 — a request too late to act on is answered by email in one line, in its thread, and not run', async () => {
    const h = harness();
    await h.send({
      id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.', thread: 'thread-9',
      receivedAt: Date.now() - 2 * 3_600_000,
    });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('sent'));
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      to: [OWNER_ADDRESS], subject: 'Re: ask: lunch?', in_reply_to: '<req-1@owner.example>', thread_id: 'thread-9',
      automatic: true,
    });
    // The line, never the model's "Booked for 7.".
    expect(h.sends[0]!.body_text).toMatch(new RegExp('^This email arrived at \\d\\d:\\d\\d( on \\d{1,2} [A-Z][a-z]+)?, '
      + 'and Recued could not get to it within an hour, so it did not act on it\\. Ask again if you still need it\\.$'));
  });

  it('records the answer’s Message-ID as the Sent record shows it, so a reply to the answer alone continues the conversation', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    const session = h.sessionOf('req-1@owner.example');

    // Gmail's send returns its own id; the Message-ID it gave the answer is in
    // its Sent record, and that is what the owner's reply names.
    await eventually(() => expect(h.answers.get(answer)?.message_id).toBe('CAgmail1@mail.gmail.com'));
    expect(h.conversations.conversationOf(CHAT, 'CAgmail1@mail.gmail.com'))
      .toBe(h.conversations.conversationOf(CHAT, 'req-1@owner.example'));
    expect(h.lookups[0]).toMatchObject({
      proof_kind: 'envelope', recipient: OWNER_ADDRESS, subject: 'Re: ask: lunch?',
      reconciliation_id: h.sends[0]!.reconciliation_id,
    });

    // A mail app that writes In-Reply-To alone, naming the answer, and no ask:.
    await h.send({ id: 'req-2@owner.example', subject: 'Re: ask: lunch?', body: 'Make it 8.', inReplyTo: '<CAgmail1@mail.gmail.com>' });
    expect(h.sessionOf('req-2@owner.example')).toBe(session);
    await eventually(async () => expect((await h.store.listMessages(session)).filter((m) => m.role === 'assistant')).toHaveLength(2));
    await eventually(() => expect(h.sends).toHaveLength(2));
    // The second answer names the first in its References.
    expect(h.sends[1]!.in_reply_to).toBe('<req-2@owner.example>');
    expect(h.sends[1]!.references).toEqual(['<CAgmail1@mail.gmail.com>', '<req-2@owner.example>']);
  });

  it('records at once a Message-ID the send itself returns, as IMAP’s and Graph’s do', async () => {
    const h = harness({ rfcIds: true });
    h.hideSentRecord(true);
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)).toMatchObject({ state: 'sent', message_id: 'CAgmail1@mail.gmail.com' }));
    expect(h.conversations.conversationOf(CHAT, 'CAgmail1@mail.gmail.com'))
      .toBe(h.conversations.conversationOf(CHAT, 'req-1@owner.example'));
    expect(h.lookups).toEqual([]);
  });

  it('an empty answer sends nothing', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const session = h.sessionOf('req-1@owner.example');
    const first = await h.answerOf('req-1@owner.example');
    const turn_id = (await h.store.listMessages(session)).find((m) => m.id === first)!.turn_id!;
    await eventually(() => expect(h.sends).toHaveLength(1));
    await h.store.appendMessage({
      id: 'empty', session_id: session, role: 'assistant', content: '  ', turn_id,
      target_server: 'self', picker_at_send: { display_name: 'self', signature },
      model_used: { provider: 'local', model_id: 'm' }, ts: Date.now(),
    } as never);
    await h.answers.tick();
    expect(h.answers.get('empty')).toMatchObject({ state: 'dropped', reason: 'the answer is empty' });
    expect(h.sends).toHaveLength(1);
  });

  it('⛔ an attempt whose outcome is unknown is never sent again — the Sent record settles it', async () => {
    const h = harness();
    h.outcomes.push('went_unheard');
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');

    await eventually(() => expect(h.answers.get(answer)?.state).toBe('unknown'));
    expect(h.sends).toHaveLength(1);
    expect(h.askOwner).toHaveBeenCalledWith(h.answers.get(answer)!.reconciliation_id);

    // Asked again: the Sent record shows it went. Nothing is sent a second time.
    h.advance(MAIL_CHAT_ANSWER_RETRY_MS[0]!);
    await h.answers.tick();
    expect(h.answers.get(answer)).toMatchObject({ state: 'sent', message_id: 'CAgmail1@mail.gmail.com' });
    expect(h.sends).toHaveLength(1);
    expect(createMailSendClaimStore(h.db).get(h.answers.get(answer)!.reconciliation_id)?.status).toBe('reconciled');
  });

  it('⛔ while the Sent record shows nothing, the send claim refuses a second attempt until the owner answers', async () => {
    const h = harness();
    h.outcomes.push('lost');
    h.hideSentRecord(true);
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('unknown'));

    // Tried again: the claim stands, and the provider is not reached.
    h.advance(MAIL_CHAT_ANSWER_RETRY_MS[0]!);
    await h.answers.tick();
    expect(h.sends).toHaveLength(1);
    expect(h.answers.get(answer)).toMatchObject({ state: 'unknown', reason: 'MAIL_SEND_CLAIM_UNRESOLVED' });

    // The owner says it did not go: the next attempt sends it.
    const claims = createMailSendClaimStore(h.db);
    const claim = claims.get(h.answers.get(answer)!.reconciliation_id)!;
    claims.decideByOwner({ reconciliation_id: claim.reconciliation_id, expected_revision: claim.revision, went_out: false, now: Date.now() });
    h.hideSentRecord(false);
    h.advance(MAIL_CHAT_ANSWER_RETRY_MS[1]!);
    await h.answers.tick();
    expect(h.sends).toHaveLength(2);
    expect(h.answers.get(answer)?.state).toBe('sent');
  });

  it('a refusal is tried again, and a refused send into a thread goes without it', async () => {
    const h = harness();
    h.outcomes.push('refused');
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.', thread: 'gone-thread' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)).toMatchObject({ state: 'pending', reason: 'MAIL_SEND_RECIPIENT_INVALID' }));
    expect(h.sends[0]!.thread_id).toBe('gone-thread');

    // The request's email is gone from the chat mailbox meanwhile: the answer is
    // still the message the claim was made for.
    h.chatMailbox.delete('mail:req-1@owner.example');
    h.advance(MAIL_CHAT_ANSWER_RETRY_MS[0]!);
    await h.answers.tick();
    expect(h.answers.get(answer)?.state).toBe('sent');
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]!.thread_id).toBeUndefined();
    // The same answer, the same message: the envelope is the first attempt's.
    expect(h.sends[1]!.subject).toBe(h.sends[0]!.subject);
    expect(h.sends[1]!.reconciliation_id).toBe(h.sends[0]!.reconciliation_id);
  });

  it('a send refused before anything went is tried again, and the owner is not asked', async () => {
    const h = harness();
    h.setCanSend(false);
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)).toMatchObject({ state: 'pending', reason: 'MAIL_SEND_NOT_CAPABLE' }));
    expect(h.askOwner).not.toHaveBeenCalled();
    expect(h.sends).toHaveLength(0);

    h.setCanSend(true);
    h.advance(MAIL_CHAT_ANSWER_RETRY_MS[0]!);
    await h.answers.tick();
    expect(h.answers.get(answer)?.state).toBe('sent');
    expect(h.sends).toHaveLength(1);
  });

  it('a door changed while the send is prepared stops it before the provider', async () => {
    const h = harness({ held: true });
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    // The door names the chat mailbox when the attempt starts, and no longer
    // when the send is about to go.
    const isChatMailbox = h.door.isChatMailbox;
    let asked = 0;
    h.door.isChatMailbox = (slug) => (++asked === 1 ? isChatMailbox(slug) : false);
    await h.answers.tick();
    expect(asked).toBeGreaterThan(1);
    expect(h.answers.get(answer)).toMatchObject({ state: 'dropped', reason: 'the door no longer names this chat mailbox' });
    expect(h.sends).toHaveLength(0);
  });

  it('is given up a day after it was written, with one notice — and one an hour at most', async () => {
    const h = harness();
    h.outcomes.push('refused', 'refused', 'refused', 'refused');
    await h.send({ id: 'req-1@owner.example', subject: 'ask: one', body: 'First.' });
    const first = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(first)?.state).toBe('pending'));
    await h.send({ id: 'req-2@owner.example', subject: 'ask: two', body: 'Second.' });
    const second = await h.answerOf('req-2@owner.example');
    await eventually(() => expect(h.answers.get(second)?.state).toBe('pending'));

    h.advance(MAIL_CHAT_ANSWER_GIVE_UP_MS + 1);
    await h.answers.tick();
    expect(h.answers.get(first)?.state).toBe('failed');
    expect(h.answers.get(second)?.state).toBe('failed');
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.title).toBe('An answer to your email was not sent');
    expect(h.notices[0]!.text).toContain(CHAT_ADDRESS);
    expect(h.notices[0]!.text).not.toContain('Booked');
    expect(h.historyRows).toHaveLength(1);
  });

  it('nothing is sent once the door no longer names the chat mailbox', async () => {
    // The turn runs and its answer is owed, but the door changes first.
    const h = harness({ held: true });
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    h.door.setChatMailbox(null);
    await h.answers.tick();
    expect(h.answers.get(answer)).toMatchObject({ state: 'dropped', reason: 'the door no longer names this chat mailbox' });
    expect(h.sends).toHaveLength(0);
  });

  it('owes only answers to email turns: a web app turn in the same conversation sends nothing', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const session = h.sessionOf('req-1@owner.example');
    await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.sends).toHaveLength(1));

    await h.store.appendMessage({
      id: 'web-answer', session_id: session, role: 'assistant', content: 'From the web app.', turn_id: 'web-turn',
      target_server: 'self', picker_at_send: { display_name: 'self', signature },
      model_used: { provider: 'local', model_id: 'm' }, ts: Date.now(),
    } as never);
    await h.answers.tick();
    expect(h.answers.get('web-answer')).toBeNull();
    expect(h.sends).toHaveLength(1);
  });

  it('every answer an email turn stores is owed, with D-323’s offers as plain lines', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: rent', body: 'Collect the rent.' });
    const session = h.sessionOf('req-1@owner.example');
    const first = await h.answerOf('req-1@owner.example');
    const turn_id = (await h.store.listMessages(session)).find((m) => m.id === first)!.turn_id!;
    await eventually(() => expect(h.sends).toHaveLength(1));

    await h.store.appendMessage({
      id: 'with-offers', session_id: session, role: 'assistant', content: 'Nothing installed collects rent.', turn_id,
      target_server: 'self', picker_at_send: { display_name: 'self', signature },
      model_used: { provider: 'local', model_id: 'm' }, ts: Date.now(),
      install_offers: [{ kind: 'pack', slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: [] }],
    } as never);
    h.answers.kick();
    await eventually(() => expect(h.sends).toHaveLength(2));
    expect(h.sends[1]!.body_text).toBe(
      'Nothing installed collects rent.\n\nFrom the marketplace, not installed yet. Open Recued to install:\n- Rental Book',
    );
  });

  it('an answer whose conversation the owner deleted is no longer owed', async () => {
    const h = harness({ held: true });
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    expect(h.answers.get(answer)?.state).toBe('pending');
    h.store.deleteSession(h.sessionOf('req-1@owner.example'));
    expect(h.answers.get(answer)).toBeNull();
    await h.answers.tick();
    expect(h.sends).toHaveLength(0);
  });

  it('a stop mid-send is settled by the Sent record at the next start, never by a second send', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('sent'));
    // As a stop between the send and its record would leave it.
    h.db.prepare("UPDATE mail_chat_answers SET state = 'sending' WHERE answer_id = ?").run(answer);
    await h.answers.dispose();

    const again = composeMailChatAnswers({
      db: h.db, chatStore: h.store, door: h.door, mailboxes: () => [h.chatMailbox] as never, requests: h.proof,
      conversations: h.conversations, claims: createMailSendClaimStore(h.db),
    })!;
    cleanup.push(() => again.dispose());
    again.start();
    await eventually(() => expect(again.get(answer)?.state).toBe('sent'));
    expect(h.sends).toHaveLength(1);
  });
});

describe('the D-318 audit — answers', () => {
  it('names the request’s thread only to a Gmail chat mailbox', async () => {
    const h = harness({ kind: 'imap' });
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.', thread: 'thread-9' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('sent'));
    expect(h.sends[0]!.thread_id).toBeUndefined();
    expect(h.sends[0]!.in_reply_to).toBe('<req-1@owner.example>');
  });

  it('a send refused for what it is fails at once, with the notice — trying again sends the same', async () => {
    const h = harness();
    h.outcomes.push('bad_input');
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('failed'));
    expect(h.answers.get(answer)?.reason).toMatch(/^refused: /);
    expect(h.notices).toHaveLength(1);
    h.advance(MAIL_CHAT_ANSWER_RETRY_MS.at(-1)!);
    await h.answers.tick();
    expect(h.sends).toHaveLength(1);
  });

  it('a message the provider refuses for what it is fails at once too, though nothing went', async () => {
    // Live, 2026-10-15: Graph refused the answers' In-Reply-To, said as a bad
    // recipient (`not_sent`), and each answer was to be retried for a day.
    const h = harness();
    h.outcomes.push('message_refused');
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('failed'));
    expect(h.answers.get(answer)?.reason).toMatch(/^refused: /);
    h.advance(MAIL_CHAT_ANSWER_RETRY_MS.at(-1)!);
    await h.answers.tick();
    expect(h.sends).toHaveLength(1);
  });

  it('an answer not sent within a day is given up before any attempt: never sent late', async () => {
    const h = harness({ held: true });
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    expect(h.answers.get(answer)?.state).toBe('pending');
    // The server was off, or the vault locked, for a day.
    h.advance(MAIL_CHAT_ANSWER_GIVE_UP_MS + 1);
    await h.answers.tick();
    expect(h.answers.get(answer)).toMatchObject({ state: 'failed', reason: 'not sent within a day', attempts: 0 });
    expect(h.sends).toHaveLength(0);
    expect(h.notices).toHaveLength(1);
  });

  it('giving up an answer that may have gone closes the owner’s question about it', async () => {
    const h = harness();
    h.outcomes.push('lost');
    h.hideSentRecord(true);
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('unknown'));
    const { reconciliation_id } = h.answers.get(answer)!;
    expect(h.askOwner).toHaveBeenCalledWith(reconciliation_id);
    expect(h.closeOwnerQuestion).not.toHaveBeenCalled();

    h.advance(MAIL_CHAT_ANSWER_GIVE_UP_MS + 1);
    await h.answers.tick();
    expect(h.answers.get(answer)?.state).toBe('failed');
    expect(h.closeOwnerQuestion).toHaveBeenCalledWith(reconciliation_id);
    // Its notice says it may have gone, not that it could not be sent.
    expect(h.notices.at(-1)!.text).toContain('could not tell whether the answer went out');
    expect(h.sends).toHaveLength(1);
  });

  it('a follow-up weeks later goes in the request’s envelope after the request’s own record is gone', async () => {
    const h = harness();
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.', thread: 'thread-4' });
    const session = h.sessionOf('req-1@owner.example');
    const first = await h.answerOf('req-1@owner.example');
    const turn_id = (await h.store.listMessages(session)).find((m) => m.id === first)!.turn_id!;
    await eventually(() => expect(h.sends).toHaveLength(1));
    // The proof keeps a settled request a week.
    h.db.prepare('DELETE FROM mail_chat_requests').run();
    h.advance(MAIL_CHAT_ANSWER_KEEP_MS + 86_400_000);
    // Rounds run all the while, each pruning what is past its time.
    await h.answers.tick();
    expect(h.answers.get(first)).toBeNull();

    await h.store.appendMessage({
      id: 'later', session_id: session, role: 'assistant', content: 'It is done.', turn_id,
      target_server: 'self', picker_at_send: { display_name: 'self', signature },
      model_used: { provider: 'local', model_id: 'm' }, ts: h.now(),
    } as never);
    h.answers.kick();
    await eventually(() => expect(h.sends).toHaveLength(2));
    expect(h.sends[1]).toMatchObject({
      to: [OWNER_ADDRESS], subject: 'Re: ask: lunch?', in_reply_to: '<req-1@owner.example>', thread_id: 'thread-4',
    });
  });

  it('a round that throws never rejects; locked, the loop looks again every fifteen seconds, never at once', async () => {
    const h = harness({ held: true });
    await h.send({ id: 'req-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.' });
    const answer = await h.answerOf('req-1@owner.example');
    await h.answers.dispose();

    const log = vi.fn();
    const broken = composeMailChatAnswers({
      db: h.db, chatStore: h.store, door: h.door, mailboxes: () => [h.chatMailbox] as never, requests: h.proof,
      conversations: h.conversations, log,
      isUnlocked: () => { throw new Error('vault store gone'); },
    })!;
    cleanup.push(() => broken.dispose());
    await expect(broken.tick()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('warn', 'chat mailbox answers round failed', { error: 'vault store gone' });

    vi.useFakeTimers();
    try {
      const locked = composeMailChatAnswers({
        db: h.db, chatStore: h.store, door: h.door, mailboxes: () => [h.chatMailbox] as never, requests: h.proof,
        conversations: h.conversations, isUnlocked: () => false,
      })!;
      cleanup.push(() => locked.dispose());
      locked.start();
      await vi.advanceTimersByTimeAsync(0);
      const timeouts = vi.spyOn(globalThis, 'setTimeout');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(timeouts.mock.calls.length).toBeLessThanOrEqual(5);
      timeouts.mockRestore();
    } finally {
      vi.useRealTimers();
    }
    expect(h.sends).toHaveLength(0);
    expect(h.answers.get(answer)?.state).toBe('pending');
  });
});

describe('the answer’s text', () => {
  it('names the files that came with it, which stay in Recued, and the subject keeps to one header line', () => {
    expect(mailChatAnswerBody({ content: 'Here they are.', attachments: [{ filename: 'a.pdf' }, { filename: 'b.png' }] }, null))
      .toBe('Here they are.\n\n(In Recued with this answer: a.pdf, b.png.)');
    expect(mailChatAnswerBody({ content: 'Here.', attachments: [{ filename: 'a.pdf' }, {}] }, null))
      .toBe('Here.\n\n(2 files come with this answer. Open the conversation in Recued to see them.)');
    expect(mailChatAnswerBody({ content: '', attachments: [{ filename: 'chart.png' }] }, null))
      .toBe('(In Recued with this answer: chart.png.)');
    expect(mailChatAnswerBody({ content: '  ' }, null)).toBe('');
    expect(mailChatAnswerSubject(`ask: ${'x'.repeat(2_000)}`).length).toBeLessThanOrEqual(900);
  });
});

describe('the answer’s envelope', () => {
  it('keeps the subject, as a reply', () => {
    expect(mailChatAnswerSubject('ask: lunch?')).toBe('Re: ask: lunch?');
    expect(mailChatAnswerSubject('Re: ask: lunch?')).toBe('Re: ask: lunch?');
    expect(mailChatAnswerSubject('AW:  ask:\tlunch?')).toBe('AW: ask: lunch?');
    expect(mailChatAnswerSubject('Fwd: invoice')).toBe('Re: Fwd: invoice');
  });

  it('names the request’s References in order, then the request; a long chain keeps its root and its nearest', () => {
    // The proof keeps them nearest first: In-Reply-To, then References from the end.
    expect(mailChatAnswerReferences(['b@x', 'a@x'], 'req@x')).toEqual(['<a@x>', '<b@x>', '<req@x>']);
    const long = Array.from({ length: 20 }, (_, i) => `m${String(i).padStart(2, '0')}@x`).reverse();
    const refs = mailChatAnswerReferences(long, 'req@x');
    expect(refs).toHaveLength(10);
    expect(refs[0]).toBe('<m00@x>');
    expect(refs.slice(-2)).toEqual(['<m19@x>', '<req@x>']);
  });
});

describe('D-318 step 5, part 2 — the result after an approval follows in the thread', () => {
  const sendTool: ToolEntry = {
    name: 'recued-core/send-email', tier: 2, description: 'Send an email', arg_schema: { type: 'object' },
    topic_tags: ['mail'], classification: 'read', concurrency_safe: false,
  };
  /** The model asks for the tool once, then answers; the tool's run is held for
   *  the owner's approval. */
  const heldTurn = (run_id: string) => {
    let calls = 0;
    const registry: InternalToolRegistry = {
      list: () => [sendTool], listByTier: (tier) => (tier === 2 ? [sendTool] : []),
      getByName: (name) => (name === sendTool.name ? sendTool : null),
      dispatch: async (): Promise<ChatDispatchResult> => ({
        ok: true, result: { awaiting_approval: true }, run_held: { kind: 'approval' }, run_id,
      }),
      subscribeRefresh: () => () => undefined,
    };
    const executeAiCall: ExecuteChatAiCall = async () => {
      calls += 1;
      const body: AIOutput = calls === 1
        ? { response: '', events: [], tool_calls: [{ tool: sendTool.name, args: {} }] }
        : { response: 'The email to Bob is waiting for your approval in Recued.', events: [], tool_calls: [] };
      return { body };
    };
    return { registry, executeAiCall };
  };
  const settled = (run_id: string, over: Partial<PreflightRunSettled> = {}): PreflightRunSettled => ({
    execution_source: { channel: 'messenger', actor: 'user_self', vendor: 'email', from: OWNER_ADDRESS },
    run_id, tool_name: sendTool.name, result: { ok: true, result: {} }, state: 'succeeded', ts: Date.now(), ...over,
  });

  it('once the held run settles, its result is written in the conversation and emailed as a reply to the request', async () => {
    const h = harness(heldTurn('run-held-1'));
    await h.send({ id: 'req-1@owner.example', subject: 'ask: email Bob', body: 'Tell Bob I am late.', thread: 'thread-3' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('sent'));
    expect(h.sends[0]!.body_text).toBe('The email to Bob is waiting for your approval in Recued.');

    // The owner approves; the run settles, long after the turn.
    h.answers.onRunSettled(settled('run-held-1'));
    await eventually(() => expect(h.sends).toHaveLength(2));
    const followUp = h.sends[1]!;
    expect(followUp.body_text).toBe('The action that waited for your approval, "Send an email", is done.');
    expect(followUp.to).toEqual([OWNER_ADDRESS]);
    expect(followUp.subject).toBe('Re: ask: email Bob');
    expect(followUp.in_reply_to).toBe('<req-1@owner.example>');
    expect(followUp.thread_id).toBe('thread-3');
    expect(followUp.automatic).toBe(true);
    expect(followUp.reconciliation_id).not.toBe(h.sends[0]!.reconciliation_id);
    // In the conversation, as an answer of the turn that asked.
    const session = h.sessionOf('req-1@owner.example');
    const messages = await h.store.listMessages(session);
    const written = messages.find((m) => m.id === mailChatFollowUpId('run-held-1'))!;
    expect(written.role).toBe('assistant');
    expect(written.turn_id).toBe(messages.find((m) => m.id === answer)!.turn_id);

    // Told again: nothing more.
    h.answers.onRunSettled(settled('run-held-1'));
    await h.answers.tick();
    expect(h.sends).toHaveLength(2);
  });

  it('⛔ never by the tool\'s id: a run whose recipe has no title is named by what it was', async () => {
    // Live, 2026-10-18: "The action that waited for your approval
    // (recued-core/send-composed-mail) is done." reached the owner by email.
    const h = harness({ ...heldTurn('run-held-untitled'), toolTitle: null });
    await h.send({ id: 'req-1@owner.example', subject: 'ask: email Bob', body: 'Tell Bob I am late.' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('sent'));
    h.answers.onRunSettled(settled('run-held-untitled'));
    await eventually(() => expect(h.sends).toHaveLength(2));
    expect(h.sends[1]!.body_text).toBe('The action that waited for your approval is done.');
    expect(h.sends[1]!.body_text).not.toContain('recued-core');
  });

  it('an owner who approves before the answer is read still gets the result, after the answer', async () => {
    const h = harness({ ...heldTurn('run-held-2'), held: true });
    await h.send({ id: 'req-1@owner.example', subject: 'ask: email Bob', body: 'Tell Bob I am late.' });
    await h.answerOf('req-1@owner.example');
    h.answers.onRunSettled(settled('run-held-2', { state: undefined, result: { denied: true, message: 'denied' } }));
    await h.answers.tick();
    expect(h.sends.map((sent) => sent.body_text)).toEqual([
      'The email to Bob is waiting for your approval in Recued.',
      'The action that waited for your approval, "Send an email", was declined, so it was not done.',
    ]);
  });

  it('only a run the email door started, and only once it is no longer held', async () => {
    const h = harness(heldTurn('run-held-3'));
    await h.send({ id: 'req-1@owner.example', subject: 'ask: email Bob', body: 'Tell Bob I am late.' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('sent'));
    // Another door's run with the same id, and the run held again.
    h.answers.onRunSettled(settled('run-held-3', {
      execution_source: { channel: 'messenger', actor: 'user_self', vendor: 'slack', from: 'U1' },
    }));
    h.answers.onRunSettled(settled('run-held-3', { result: { ok: true, result: {}, run_held: { kind: 'approval' } } }));
    await h.answers.tick();
    expect(h.sends).toHaveLength(1);
    h.answers.onRunSettled(settled('run-held-3', {
      state: 'failed', result: { ok: true, result: {}, run_failed: { detail: 'Bob’s address bounced.' } },
    }));
    await eventually(() => expect(h.sends).toHaveLength(2));
    expect(h.sends[1]!.body_text)
      .toBe('The action that waited for your approval, "Send an email", did not complete: Bob’s address bounced.');
  });
});

describe('the D-318 audit — follow-ups', () => {
  const sendTool: ToolEntry = {
    name: 'recued-core/send-email', tier: 2, description: 'Send an email', arg_schema: { type: 'object' },
    topic_tags: ['mail'], classification: 'read', concurrency_safe: false,
  };
  const heldTurn = (run_id: string) => {
    let calls = 0;
    const registry: InternalToolRegistry = {
      list: () => [sendTool], listByTier: (tier) => (tier === 2 ? [sendTool] : []),
      getByName: (name) => (name === sendTool.name ? sendTool : null),
      dispatch: async (): Promise<ChatDispatchResult> => ({
        ok: true, result: { awaiting_approval: true }, run_held: { kind: 'approval' }, run_id,
      }),
      subscribeRefresh: () => () => undefined,
    };
    const executeAiCall: ExecuteChatAiCall = async () => {
      calls += 1;
      const body: AIOutput = calls === 1
        ? { response: '', events: [], tool_calls: [{ tool: sendTool.name, args: {} }] }
        : { response: 'Waiting for your approval.', events: [], tool_calls: [] };
      return { body };
    };
    return { registry, executeAiCall };
  };
  const settled = (run_id: string): PreflightRunSettled => ({
    execution_source: { channel: 'messenger', actor: 'user_self', vendor: 'email', from: OWNER_ADDRESS },
    run_id, tool_name: sendTool.name, result: { ok: true, result: {} }, state: 'succeeded', ts: Date.now(),
  });
  const DONE = 'The action that waited for your approval, "Send an email", is done.';

  it('never reaches the owner before the answer that says it waits: not while that answer may not have gone', async () => {
    const h = harness(heldTurn('run-a'));
    h.outcomes.push('went_unheard');
    h.hideSentRecord(true);
    await h.send({ id: 'req-1@owner.example', subject: 'ask: email Bob', body: 'Tell Bob.' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('unknown'));

    h.answers.onRunSettled(settled('run-a'));
    await h.answers.tick();
    expect(h.sends.map((sent) => sent.body_text)).toEqual(['Waiting for your approval.']);

    // The Sent record shows the answer went: the follow-up comes after it.
    h.hideSentRecord(false);
    h.advance(MAIL_CHAT_ANSWER_RETRY_MS[0]!);
    await h.answers.tick();
    await eventually(() => expect(h.sends.map((sent) => sent.body_text)).toEqual(['Waiting for your approval.', DONE]));
  });

  it('a run approved weeks later still follows: its watch outlives the week a settlement is kept', async () => {
    const h = harness(heldTurn('run-b'));
    await h.send({ id: 'req-1@owner.example', subject: 'ask: email Bob', body: 'Tell Bob.' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('sent'));
    h.advance(4 * MAIL_CHAT_FOLLOW_UP_KEEP_MS);
    await h.answers.tick();
    h.answers.onRunSettled(settled('run-b'));
    await eventually(() => expect(h.sends.map((sent) => sent.body_text)).toEqual(['Waiting for your approval.', DONE]));
  });

  it('a run that settled while the server started — before the door’s loop — still follows, at once', async () => {
    const h = harness(heldTurn('run-c'));
    await h.send({ id: 'req-1@owner.example', subject: 'ask: email Bob', body: 'Tell Bob.' });
    const answer = await h.answerOf('req-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('sent'));
    // As the server's listener from boot keeps it.
    expect(recordMailChatSettledRun(h.db, settled('run-c'), Date.now())).toBe(true);
    // Another door's run is not kept.
    expect(recordMailChatSettledRun(h.db, {
      ...settled('run-x'), execution_source: { channel: 'messenger', actor: 'user_self', vendor: 'slack', from: 'U1' },
    }, Date.now())).toBe(false);
    // Told again once the loop is there: already kept, and its follow-up goes now.
    h.answers.onRunSettled(settled('run-c'));
    await eventually(() => expect(h.sends.map((sent) => sent.body_text)).toEqual(['Waiting for your approval.', DONE]));
  });
});

describe('a settled run’s outcome, in words', () => {
  const base = { execution_source: {}, run_id: 'r', tool_name: 't', ts: 1 };
  it('reads the outcome as chat’s own settlement does', () => {
    expect(mailChatRunOutcome({ ...base, result: { denied: true }, state: 'failed' })).toEqual({ outcome: 'denied' });
    expect(mailChatRunOutcome({ ...base, result: {}, state: 'interrupted' })).toEqual({ outcome: 'interrupted' });
    expect(mailChatRunOutcome({ ...base, result: { success: true } })).toEqual({ outcome: 'succeeded' });
    expect(mailChatRunOutcome({ ...base, result: { success: false, errors: [{ message: 'Step 2 failed:\n  timeout' }] } }))
      .toEqual({ outcome: 'failed', detail: 'Step 2 failed: timeout' });
    expect(mailChatRunOutcome({ ...base, result: { success: false } })).toEqual({ outcome: 'failed' });
    expect(mailChatRunOutcome({ ...base, result: { detail: 'x'.repeat(400) }, state: 'failed' }).detail).toHaveLength(300);
  });

  it('says what became of the action, by its title, never by a tool name', () => {
    expect(mailChatFollowUpText('interrupted', 'Send an email'))
      .toBe('The action that waited for your approval, "Send an email", was interrupted. Open Recued to see how far it got.');
    expect(mailChatFollowUpText('failed'))
      .toBe('The action that waited for your approval did not complete. Open Recued to see why.');
    expect(mailChatFollowUpText('succeeded')).toBe('The action that waited for your approval is done.');
  });
});

describe('§8.18 one mailbox — the answer to an email the owner wrote to themselves', () => {
  it('goes back to the mailbox it is sent from, past the self-loop guard, in the thread, marked Recued’s', async () => {
    const h = harness({ oneMailbox: true });
    await h.send({ id: 'self-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.', thread: 'thread-9' });
    const answer = await h.answerOf('self-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('sent'));
    // ⛔ D-127's guard refuses mail from a mailbox to itself; the real
    // collection sent this one, so the answer lifted it.
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({
      to: [OWNER_ADDRESS], subject: 'Re: ask: lunch?', in_reply_to: '<self-1@owner.example>', thread_id: 'thread-9',
      automatic: true, reconciliation_id: expect.stringMatching(new RegExp(`^${MAIL_CHAT_ANSWER_RECONCILIATION_PREFIX}`)),
    });
    expect(h.sends[0]!.cc ?? []).toEqual([]);
    expect(h.sends[0]!.bcc ?? []).toEqual([]);
  });

  it('⛔ the answer landing back in that mailbox is never a request, and a reply to it continues the conversation', async () => {
    const h = harness({ oneMailbox: true });
    await h.send({ id: 'self-1@owner.example', subject: 'ask: lunch?', body: 'Book a table for 7.', thread: 'thread-9' });
    const answer = await h.answerOf('self-1@owner.example');
    await eventually(() => expect(h.answers.get(answer)?.state).toBe('sent'));
    // Gmail delivers it to the same mailbox: one message, filed as sent, with
    // the answer's reconciliation id.
    const copy = h.sentRecord[0]!;
    const landed: CanonicalMessage = {
      source_id: copy.gmail_id, rfc_message_id: `<${copy.message_id}>`, from: OWNER_ADDRESS, to: [OWNER_ADDRESS], cc: [],
      subject: copy.msg.subject, thread_id: 'thread-9', folder_or_label: 'INBOX', direction: 'outbound',
      labels: ['SENT', 'INBOX'], is_read: false, is_flagged: false, has_attachments: false,
      received_at: Date.now(), provider_received_at: Date.now(), body_text: copy.msg.body_text,
      reconciliation_id: copy.msg.reconciliation_id!,
      headers: { 'in-reply-to': '<self-1@owner.example>', 'auto-submitted': 'auto-replied' },
    };
    h.chatMailbox.upsert({
      record_id: `mail:${copy.gmail_id}`, platform: 'mail', slug: CHAT, received_at: Date.now(), modified_at: Date.now(),
      size_bytes: 1, source_id: copy.gmail_id, body_inline: copy.msg.body_text,
      hot_fields: { subject: copy.msg.subject, from: OWNER_ADDRESS, to: [OWNER_ADDRESS], rfc_message_id: copy.message_id },
    } as unknown as CollectionRecord);
    h.proof.onMessageStored(landed, {
      slug: CHAT, record_id: `mail:${copy.gmail_id}`, backfill_complete: true, backfill_days: 30,
      provider_kind: 'gmail', account_email: OWNER_ADDRESS,
    });
    await h.proof.tick();
    expect(h.proof.recent(CHAT, 10).map((request) => request.rfc_message_id)).toEqual(['self-1@owner.example']);

    // The owner replies to it, from the same mailbox, without the prefix.
    await eventually(() => expect(h.conversations.conversationOf(CHAT, copy.message_id)).not.toBeNull());
    h.setAnswer('Moved to 8.');
    await h.send({
      id: 'self-2@owner.example', subject: 'Re: lunch? make it 8', body: 'Make it 8.', thread: 'thread-9',
      inReplyTo: `<${copy.message_id}>`, references: `<self-1@owner.example> <${copy.message_id}>`,
    });
    await eventually(() => expect(h.sends).toHaveLength(2));
    expect(h.sessionOf('self-2@owner.example')).toBe(h.sessionOf('self-1@owner.example'));
    expect(h.sends[1]).toMatchObject({ to: [OWNER_ADDRESS], body_text: 'Moved to 8.' });
  });
});
