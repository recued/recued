/** D-338 — notices, quoted replies, and answers given without a model.
 *
 *  Driven through the real chat store, messenger bridge, turn queue and orchestrator: a notice is
 *  recorded the way the messenger channels record it, a quote is resolved the way the messenger
 *  ingress and the app's chat.send resolve it, and the model's packet is read off the AI call. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMiddlewareRegistry } from '@recued/middleware';
import { registerFirstPartyMiddlewares } from '@recued/middleware-recued';
import { registerPromptCacheMiddleware, type GateDeps } from '@recued/middleware-prompt-cache';
import type { AIOutput, ChatMessage } from '@recued/contracts';
import type { NotificationMessage } from '@recued/notification';
import type { OutboundMessage } from '@recued/transport';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { buildChatTail, createChatOrchestrator, TAIL_QUOTE_MAX_CHARS } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { handleSend } from '../chat-handler.js';
import { createChatMessengerBridge } from '../chat-messenger-bridge.js';
import { conversationHoldsNotices, createChatNotices } from '../chat-notices.js';
import { FEATURE_TEXT_NOTICES } from '../chat-turn-executor.js';
import { createPromptCacheGateDeps } from '../chat-prompt-cache-gate.js';
import { recordAnswerInBrief } from '../chat-no-model-answers.js';
import type { ContactStore } from '../storage/contact-store.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'd-338' };
const AGENDA: NotificationMessage = { title: 'Agenda · Tue 3 Nov', text: '09:00  Dentist\n13:00  Lunch with Sam' };
/** What the owner saw, without the two lines that only explain the rule. */
const SEEN = 'Agenda · Tue 3 Nov\n09:00  Dentist\n13:00  Lunch with Sam';
const TELEGRAM_RULE = 'Not part of your chat with Recued. To ask about it, use Reply on this message.';

const contactStore = (): ContactStore =>
  ({ list: () => [{ email: 'pat@x.com', name: 'Pat Lee' }], addressSet: (email: string) => [email] }) as unknown as ContactStore;

const fixture = (options: { gateDeps?: GateDeps } = {}) => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  let key: Uint8Array | null = new Uint8Array(32).fill(53);
  const getKey = () => key;
  const store = createChatStore(db, getKey);
  store.createSession({ id: 's' }); store.createSession({ id: 'plain' });
  const calls: Array<{ system: string; prompt: string }> = [];
  const middlewareRegistry = createMiddlewareRegistry(); registerFirstPartyMiddlewares(middlewareRegistry);
  if (options.gateDeps) registerPromptCacheMiddleware(middlewareRegistry, options.gateDeps, { search: () => [] });
  const raw = createChatOrchestrator({ chatStore: store, selfSignature: signature, middlewareRegistry,
    registry: { list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} },
    executeAiCall: async (_tool, args) => {
      calls.push({ system: String(args['llm.system_prompt']), prompt: String(args['llm.prompt']) });
      return { body: { response: `answer ${calls.length}`, events: [], tool_calls: [] } satisfies AIOutput };
    },
    noticesHere: (sid) => conversationHoldsNotices(db, sid),
  });
  const orchestrator = withQueuedChatTurns(raw, { db, store, getKey, pollMs: 5 });
  cleanups.push(() => { orchestrator.turnQueue!.close(); db.close(); });
  // The bridge after the database's cleanup, so it closes first.
  const bridge = createChatMessengerBridge({ db, store, getKey, pollMs: 5, minSendIntervalMs: 0 });
  cleanups.push(() => bridge.close());
  bridge.bind('telegram', 'chat-1', 'telegram:42', 's');
  const sends: OutboundMessage[] = [];
  bridge.register('telegram', { resolve: async () => ({ token: 'bot', recipient: 'chat-1', account: 'telegram:42' }),
    send: async (message) => { sends.push(message); return { ok: true, vendor_message_id: `posted-${sends.length}` }; } });
  const events: Array<{ kind: string; session_id: string; final: unknown }> = [];
  const accountFor = vi.fn(async (vendor: string, token: string) => `${vendor}:${token === 'bot' ? '42' : '7'}`);
  const notices = createChatNotices({ db, chatStore: store, accountFor,
    keyReady: () => key !== null, signature, broadcast: { emit: (event) => { events.push(event); } } });
  const notify = async (message: NotificationMessage = AGENDA,
    opts: { vendor?: string; recipient?: string; token?: string; id?: string } = {}) => {
    const decoration = await notices.prepare({ vendor: opts.vendor ?? 'telegram', recipient: opts.recipient ?? 'chat-1',
      token: opts.token ?? 'bot', message });
    if (decoration) await decoration.sent(opts.id ?? '801');
    return decoration;
  };
  const deps = { store, orchestrator, selfSignature: signature };
  const send = (session_id: string, message: string, submission_id: string, reply_to_message_id?: string) => handleSend(deps, {
    session_id, message, submission_id, picker_state: { current: 'self' },
    ...(reply_to_message_id ? { reply_to_message_id } : {}),
  });
  const settled = (session_id: string, count: number) => vi.waitFor(async () => expect(
    (await orchestrator.turnQueue!.snapshot(session_id)).turns.map((turn) => turn.status),
  ).toEqual(Array.from({ length: count }, () => 'completed')));
  const noticeOf = async (): Promise<ChatMessage> => (await store.listMessages('s')).find((m) => m.role === 'notice')!;
  let ts = Date.now();
  const add = (id: string, content: string, role: 'user' | 'assistant', reply_to?: string) => store.appendMessage({
    id, session_id: 's', role, content, target_server: 'self', ts: ts++,
    picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'fixture', model_id: 'fixture' },
    ...(reply_to ? { reply_to: { message_id: reply_to } } : {}),
  });
  return { db, store, raw, orchestrator, bridge, sends, events, calls, notify, send, settled, noticeOf, add, accountFor,
    lock: () => { key = null; } };
};

describe('D-338 a notification to a linked chat is a notice in it', () => {
  it('goes out marked as a notice, and is kept in the chat where the model cannot see it', async () => {
    const f = fixture();
    const decoration = await f.notify();
    expect(decoration).toMatchObject({ title: 'Notice · Agenda · Tue 3 Nov', text: `${AGENDA.text}\n\n${TELEGRAM_RULE}` });

    const notice = await f.noticeOf();
    expect(notice).toMatchObject({ role: 'notice', content: AGENDA.text, contributor: 'tool_result',
      notice: { vendor: 'telegram', title: 'Agenda · Tue 3 Nov' } });
    const row = f.db.prepare('SELECT recall_eligibility, metadata_blob FROM chat_messages WHERE message_id = ?')
      .get(notice.id) as { recall_eligibility: string; metadata_blob: string };
    // Recall never reads it, and its title is stored encrypted, as its text is.
    expect(row.recall_eligibility).toBe('ineligible');
    expect(row.metadata_blob).not.toContain('Agenda');
    expect(f.db.prepare('SELECT vendor, vendor_message_id FROM chat_notice_receipts WHERE message_id = ?').get(notice.id))
      .toEqual({ vendor: 'telegram', vendor_message_id: '801' });
    // Not copied out to the messenger a second time, and not in the model's window.
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_deliveries WHERE message_id = ?').get(notice.id)).toEqual({ n: 0 });
    expect(await f.store.listRecentConversational('s', 3)).toEqual([]);
    expect(f.events).toEqual([expect.objectContaining({ kind: 'chat.message_complete', session_id: 's',
      final: expect.objectContaining({ id: notice.id, role: 'notice' }) })]);
  });

  it('leaves every other notification as it was', async () => {
    const f = fixture();
    expect(await f.notify(AGENDA, { token: 'another-bot' })).toBeUndefined();
    expect(f.accountFor).toHaveBeenCalledTimes(1);
    // No chat on that messenger and recipient: the vendor is not even asked who the bot is.
    expect(await f.notify(AGENDA, { recipient: 'household-group' })).toBeUndefined();
    expect(f.accountFor).toHaveBeenCalledTimes(1);
    expect(await f.notify(AGENDA, { vendor: 'teams' })).toBeUndefined();
    f.lock();
    expect(await f.notify()).toBeUndefined();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'notice'").get()).toEqual({ n: 0 });
  });

  it('says on Slack to reply in its thread, and names a notice without a title "Notice"', async () => {
    const f = fixture(); f.store.createSession({ id: 'slack-chat' });
    f.bridge.bind('slack', 'C1', 'slack:42', 'slack-chat');
    const decoration = await f.notify({ text: 'Your backup finished.' }, { vendor: 'slack', recipient: 'C1' });
    expect(decoration).toMatchObject({ title: 'Notice',
      text: "Your backup finished.\n\nNot part of your chat with Recued. To ask about it, reply in this message's thread." });
  });
});

describe('D-338 the model sees a notice only when the owner quotes it', () => {
  it('an unquoted message carries no notice, and the prompt says notices are there', async () => {
    const f = fixture();
    await f.notify();
    await f.send('s', 'what does that mean?', 'unquoted');
    await f.send('plain', 'hello', 'elsewhere');
    await f.settled('s', 1); await f.settled('plain', 1);
    const [linked, plain] = [f.calls.find((c) => c.prompt.includes('what does that mean?'))!,
      f.calls.find((c) => c.prompt.includes('hello'))!];
    expect(linked.prompt).not.toContain('Dentist');
    expect(linked.system).toContain(FEATURE_TEXT_NOTICES);
    expect(plain.system).not.toContain(FEATURE_TEXT_NOTICES);
  });

  it('a reply quoting it from the app carries what the owner saw, and the quote rides with that reply', async () => {
    const f = fixture();
    await f.notify();
    const notice = await f.noticeOf();
    await f.send('s', 'can I move the dentist to Thursday?', 'quoted', notice.id);
    await f.settled('s', 1);
    expect(JSON.parse(JSON.parse(f.calls[0]!.prompt).user_message)).toEqual({
      reply_to: { message_id: notice.id, role: 'notice', text: SEEN }, message: 'can I move the dentist to Thursday?',
    });
    const reply = (await f.store.listMessages('s')).find((m) => m.content === 'can I move the dentist to Thursday?')!;
    expect(reply.reply_to).toEqual({ message_id: notice.id,
      preview: { role: 'notice', text: AGENDA.text.replace(/\s+/gu, ' '), title: 'Agenda · Tue 3 Nov' } });

    // The next turn still has the quote, with the reply that made it.
    await f.send('s', 'and lunch?', 'follow-up');
    await f.settled('s', 2);
    const tail = JSON.parse(f.calls[1]!.prompt).chat_tail as Array<{ role: string; content: string }>;
    const quoting = tail.find((m) => m.role === 'user')!;
    expect(JSON.parse(quoting.content)).toEqual({ reply_to: { role: 'notice', text: SEEN },
      message: 'can I move the dentist to Thursday?' });

    // Its copy in Telegram is a reply to the notice there.
    await vi.waitFor(() => expect(f.sends.find((m) => m.text.includes('can I move the dentist')))
      .toMatchObject({ reply_to_message_id: '801' }));
  });

  it('a reply quoting it on the messenger resolves to what the owner saw', async () => {
    const f = fixture();
    await f.notify();
    const notice = await f.noticeOf();
    expect(await f.bridge.nativeReply('s', 'telegram', '801')).toEqual({ message_id: notice.id, role: 'notice', text: SEEN });
    expect(await f.bridge.nativeReply('s', 'telegram', '802')).toBeUndefined();
    expect(await f.bridge.nativeReply('s', 'slack', '801')).toBeUndefined();
  });
});

describe('D-338 a quote rides with its row while the row is in the window', () => {
  it('is not repeated when what it quotes is in the window too, and is cut when long', async () => {
    const f = fixture();
    const long = `${'x'.repeat(TAIL_QUOTE_MAX_CHARS)}END`;
    await f.add('question', long, 'assistant');
    await f.add('quoting', 'yes', 'user', 'question');
    const together = await buildChatTail(f.store, 's');
    expect(together.messages.map((m) => m.content)).toEqual([long, 'yes']);

    await f.add('answer', 'noted', 'assistant');
    await f.add('next', 'thanks', 'user');
    const apart = await buildChatTail(f.store, 's');
    expect(apart.messages).toHaveLength(3);
    const carried = JSON.parse(apart.messages[0]!.content) as { reply_to: { role: string; text: string }; message: string };
    expect(carried.message).toBe('yes');
    expect(carried.reply_to.role).toBe('assistant');
    expect(Array.from(carried.reply_to.text)).toHaveLength(TAIL_QUOTE_MAX_CHARS + 1);
    expect(carried.reply_to.text.endsWith('…')).toBe(true);
  });
});

describe('D-338 an answer given without a model', () => {
  const question = "what is Pat Lee's email address?";
  const answer = "Pat Lee's email address is pat@x.com.";
  const gate = () => createPromptCacheGateDeps(contactStore, () => undefined, undefined, undefined, undefined);

  it('is labelled with the store it read, and goes into the brief', async () => {
    const f = fixture({ gateDeps: gate() });
    await f.send('plain', question, 'gate');
    await f.settled('plain', 1);
    expect(f.calls).toEqual([]);
    const reply = (await f.store.listMessages('plain')).find((m) => m.role === 'assistant')!;
    expect(reply).toMatchObject({ content: answer, answered_without_model: { from: 'contacts' } });
    const brief = JSON.parse((await f.store.readSessionBrief('plain'))!);
    expect(brief).toMatchObject({ intent: question, findings: [answer], pending: [] });
  });

  it('keeps what the brief already holds, the still-to-do list included', async () => {
    const f = fixture({ gateDeps: gate() });
    await f.store.writeSessionBrief('plain', JSON.stringify({ intent: 'Plan the week', constraints: ['No meetings Friday'],
      pending: ['Book the dentist'], findings: ['Sam is in Lisbon until the 9th'], completed: [] }));
    await f.send('plain', question, 'gate');
    await f.settled('plain', 1);
    expect(JSON.parse((await f.store.readSessionBrief('plain'))!)).toMatchObject({
      intent: 'Plan the week', constraints: ['No meetings Friday'], pending: ['Book the dentist'],
      findings: ['Sam is in Lisbon until the 9th', answer],
    });
  });

  it('is labelled on the messenger too, where a model answer is not', async () => {
    const f = fixture({ gateDeps: gate() });
    const source = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as const;
    const turn = (text: string) => f.raw.runMessengerTurn({
      channel: { surface: 'messenger-telegram', onInbound: () => undefined, deliver: async () => undefined },
      sessionStore: f.raw.sessionStore,
      inbound: { session_id: 's', surface: 'messenger-telegram', text, from: '42', source, dispatch_depth: 0, ts: Date.now() },
    });
    await turn(question);
    await turn('thanks, anything else today?');
    const replies = (await f.store.listMessages('s')).filter((m) => m.role === 'assistant');
    expect(replies.map((m) => m.answered_without_model)).toEqual([{ from: 'contacts' }, undefined]);
  });

  it('stays out of the brief when the owner turned the brief off', async () => {
    const f = fixture();
    f.store.setRollingBriefEnabled(false);
    await recordAnswerInBrief(f.store, 'plain', answer, question);
    expect(await f.store.readSessionBrief('plain')).toBeNull();
  });
});
