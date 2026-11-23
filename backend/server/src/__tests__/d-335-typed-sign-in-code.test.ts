/** D-335 slice Z (2026-11-17) — a sign-in code typed in a chat app the ask reached, for the browser
 *  step that waits for it.
 *
 *  ⛔ Before: a message typed in Telegram or Slack became a chat turn (kept in the chat, and handed to
 *  the model) and a message event (a recipe trigger), so a code typed there would have been kept;
 *  the ask said to give a code in the Recued app only. Now a code is taken before any of those, by
 *  the dispatcher every messenger message goes through.
 *
 *  The whole chain runs here as the server composes it: the notification block fans the ask out to
 *  the app and to Telegram (the real channel over the real transport, with only Telegram's HTTP API
 *  faked), the secret registry waits for the code, and the inbound dispatcher takes it. The chat turn
 *  and the message event are spies, since a code must reach neither. Which message answers which ask
 *  (replies, two asks, Slack threads) is the channel's, pinned in
 *  `packages/notification/src/__tests__/d-335-remote-typed-secret.test.ts`. */

import { describe, expect, it, vi } from 'vitest';
import {
  createAskStore,
  createNotificationBlock,
  createNotificationSettingsStore,
  createRemoteChannel,
  type Channel,
  type NotificationSettings,
  type PendingAsk,
} from '@recued/notification';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { createTelegramTransport } from '@recued/transport';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import {
  BROWSER_SECRET_LATE_MS,
  createBrowserSecrets,
  signInCodeOf,
  TYPED_CODE_NOT_GIVEN,
  TYPED_CODE_REMOVAL,
  type BrowserSecretAnswer,
  type BrowserSecretRequest,
} from '../bridges/browser-secrets.js';
import { composeInboundAnswerDispatcher } from '../composition/bin/wire-inbound-answer-dispatcher.js';

describe('D-335 slice Z — a sign-in code, as people type one', () => {
  it('reads a code on its own, and nothing else', () => {
    for (const [typed, code] of [
      ['482913', '482913'], [' 482913\n', '482913'], ['G-482913', 'G-482913'], ['AB12CD', 'AB12CD'], ['1234', '1234'],
      ['123 456', '123456'], ['1234 5678', '12345678'], ['４８２９１３', '482913'],
    ] as const) {
      expect(signInCodeOf(typed), typed).toBe(code);
    }
    for (const typed of ['thanks', 'ok', 'Room 1234', 'abcdef', '123', 'call me at 5 pm', '1 2 3 4', '12345678901234',
      'v1.2.3', 'https://x.io/1234', 'ok 123456']) {
      expect(signInCodeOf(typed), typed).toBeNull();
    }
  });
});

/** The owner's Telegram user id, as their connection names them, and their private chat with the bot. */
const OWNER = 1001;
const request = (over: Partial<BrowserSecretRequest> = {}): BrowserSecretRequest => ({
  run_id: 'run-1', kind: 'sign-in code', origin: 'https://login.live.com', field: 'name:otc', label: 'Code', ...over });

/** A Telegram message update, as the Bot API sends one. */
const telegramMessage = (text: string, from = OWNER) => ({
  update_id: 900,
  message: { message_id: 50, date: 1_700_000_000, text, from: { id: from, is_bot: false, first_name: 'Owner' },
    chat: { id: OWNER, type: 'private' } },
});

/** Until a condition holds, or a short while: an ask is fanned out after an await. */
const until = async (holds: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !holds(); i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
/** The answer a step got, or `pending`: a step that was never given its code waits five minutes. */
const settled = async (answer: Promise<BrowserSecretAnswer>): Promise<BrowserSecretAnswer | 'pending'> =>
  Promise.race([answer, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 200))]);

const compose = async (options: {
  owner?: number | null; clock?: { now: number }; ownersConnection?: string; deleteRefused?: boolean;
} = {}) => {
  const clock = options.clock ?? { now: 1_000 };
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let nextMessage = 7;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split('/').pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (method === 'deleteMessage' && options.deleteRefused === true) {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message can't be deleted" }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: method === 'sendMessage' ? nextMessage++ : 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const owner = options.owner === undefined ? OWNER : options.owner;
  const telegram = createRemoteChannel({
    transport: createTelegramTransport({ fetchImpl, timeoutMs: 5_000 }),
    resolveCredential: async () => ({ token: 'bot-token', recipient: String(OWNER),
      ...(owner !== null ? { expected_sender: String(owner) } : {}) }),
  });
  const ui: Channel = { name: 'ui', capability: 'inline', owns_llm_egress: true,
    async deliverNotify() {}, async deliverAsk() {}, async closeAsk() {} };
  const settingsStore = createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>());
  await settingsStore.setChannelMode('telegram', { notification: true, approval: true });
  const block = createNotificationBlock({ askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
    channels: [ui, telegram], settingsStore });
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
  const secrets = createBrowserSecrets();
  await secrets.install({ notifier: block, auditLog, now: () => clock.now });
  const turns = vi.fn(async () => true);
  const events: unknown[] = [];
  const logs: string[] = [];
  const { messengerDispatchers } = composeInboundAnswerDispatcher({
    block,
    messengerChannels: { telegram },
    typedSecrets: secrets,
    messengerTurnIngest: turns,
    warehouseBus: { emit: (event: unknown) => { events.push(event); } } as unknown as WarehouseEventBus,
    log: (level, msg, data) => { logs.push(`${level} ${msg} ${JSON.stringify(data ?? {})}`); },
    ...(options.ownersConnection !== undefined ? {
      connectionEnrollment: () => 5,
      plainAskConnection: async () => ({ name: options.ownersConnection!, enrolled_at: 5 }),
    } : {}),
  });
  const send = (text: string, from = OWNER, connection_name = 'telegram-main') =>
    messengerDispatchers.telegram!({ connection_name, payload: telegramMessage(text, from), update_id: '900' } as never);
  const sent = (method: string) => calls.filter((call) => call.method === method).map((call) => String(call.body.text));
  /** The messages Telegram was asked to delete: the chat and the message. */
  const deleted = () => calls.filter((call) => call.method === 'deleteMessage').map((call) => call.body);
  return { block, secrets, auditLog, turns, events, logs, send, sent, deleted };
};

describe('D-335 slice Z — a sign-in code typed in Telegram goes to the step, and is kept nowhere', () => {
  it('goes to the waiting step, never to a chat turn, a message event, a log line or an audit row', async () => {
    const t = await compose();
    const answer = t.secrets.resolve(request());
    await until(() => t.sent('sendMessage').length > 0);
    // Telegram is told it may send the code there.
    expect(t.sent('sendMessage')[0]).toContain('Send the code here, as a message on its own');
    expect(t.secrets.typedSecretAsks().size).toBe(1);

    await t.send('482 913');
    expect(await settled(answer)).toEqual({ value: '482913', from: 'owner' });
    expect(t.turns).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
    // The code as typed or as kept, never a bare `482`: an activity id and a log line carry a millisecond clock, and
    // one read `…909482` (about 1 run in 100 went red with nothing leaked).
    const holdsCode = (text: string): boolean => /482\s?913/u.test(text);
    expect(holdsCode(t.logs.join('\n'))).toBe(false);
    const activities = await t.auditLog.listActivities();
    expect(holdsCode(JSON.stringify(activities))).toBe(false);
    // The audit says where it came from; the ask closes everywhere, the prompt saying it was given.
    expect(activities.map((a) => [a.action, JSON.parse(a.detail ?? '{}').via])).toContainEqual(['browser_secret_given', 'telegram']);
    expect(await t.block.listOpenAsks()).toEqual([]);
    await until(() => t.sent('editMessageText').length > 0);
    expect(t.sent('editMessageText')[0]).toContain('Given: it went to your browser for that one step.');
    // ⛔ 2026-11-17: and the owner's message with it is deleted from the chat, which says so.
    expect(t.deleted()).toEqual([{ chat_id: String(OWNER), message_id: 50 }]);
    expect(t.sent('editMessageText')[0]).toContain(TYPED_CODE_REMOVAL.deleted);
  });

  it('a deletion Telegram refuses is said, and the code still goes to the step', async () => {
    const t = await compose({ deleteRefused: true });
    const answer = t.secrets.resolve(request());
    await until(() => t.sent('sendMessage').length > 0);
    await t.send('482913');
    expect(await settled(answer)).toEqual({ value: '482913', from: 'owner' });
    expect(t.deleted()).toHaveLength(1);
    await until(() => t.sent('editMessageText').length > 0);
    expect(t.sent('editMessageText')[0]).toContain(TYPED_CODE_REMOVAL.failed);
    expect(t.sent('editMessageText')[0]).not.toContain(TYPED_CODE_REMOVAL.deleted);
  });

  it('a code typed late is still taken, not used, and the chat is told; past the window it is conversation', async () => {
    const clock = { now: 1_000 };
    const t = await compose({ clock });
    const answer = t.secrets.resolve(request());
    await until(() => t.sent('sendMessage').length > 0);
    // The owner gave it in the app first.
    const [ask] = await t.block.listOpenAsks();
    expect(await t.secrets.give(ask!.ask_id, '111111', false)).toBe(true);
    expect(await answer).toEqual({ value: '111111', from: 'owner' });

    await t.send('482913');
    expect(t.turns).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
    await until(() => t.sent('sendMessage').length > 1);
    expect(t.sent('sendMessage').at(-1)).toContain(TYPED_CODE_NOT_GIVEN.late);
    // Not used, and still deleted from the chat: a code may still work when it comes late.
    expect(t.sent('sendMessage').at(-1)).toContain(TYPED_CODE_REMOVAL.deleted);
    expect(t.deleted()).toHaveLength(1);

    clock.now += BROWSER_SECRET_LATE_MS + 1;
    expect(t.secrets.typedSecretAsks().size).toBe(0);
    await t.send('482913');
    expect(t.turns).toHaveBeenCalledTimes(1);
  });

  it('conversation, another person, and another connection pass on while the step waits', async () => {
    const t = await compose({ ownersConnection: 'telegram-main' });
    const answer = t.secrets.resolve(request());
    await until(() => t.sent('sendMessage').length > 0);
    await t.send('which code do you mean?');
    await t.send('482913', 2002);
    await t.send('482913', OWNER, 'telegram-other');
    expect(t.turns).toHaveBeenCalledTimes(3);
    expect(await settled(answer)).toBe('pending');
    // ⛔ Nothing that passes on is deleted.
    expect(t.deleted()).toEqual([]);
    // The owner's code, on the owner's connection, is taken.
    await t.send('482913');
    expect(await settled(answer)).toEqual({ value: '482913', from: 'owner' });
    expect(t.turns).toHaveBeenCalledTimes(3);
    expect(t.deleted()).toHaveLength(1);
  });

  it('a password is never taken from a chat: Telegram is told to give it in the app, and a reply passes on', async () => {
    const t = await compose();
    const answer = t.secrets.resolve(request({ kind: 'password', field: 'name:passwd', label: 'Password' }));
    await until(() => t.sent('sendMessage').length > 0);
    expect(t.sent('sendMessage')[0]).toContain('Do not send it in a chat');
    expect(t.sent('sendMessage')[0]).not.toContain('Send the code here');
    expect(t.secrets.typedSecretAsks().size).toBe(0);
    await t.send('hunter2a1');
    expect(t.turns).toHaveBeenCalledTimes(1);
    expect(t.deleted()).toEqual([]);
    expect(await settled(answer)).toBe('pending');
    // ⛔ Nor can anything hand a chat app's text to it.
    const [ask] = await t.block.listOpenAsks();
    expect(await t.secrets.give(ask!.ask_id, 'hunter2a1', false, 'telegram')).toBe(false);
    expect(await settled(answer)).toBe('pending');
  });

  it('a connection that names no owner is not told to send a code, and takes none', async () => {
    const t = await compose({ owner: null });
    const answer = t.secrets.resolve(request());
    await until(() => t.sent('sendMessage').length > 0);
    expect(t.sent('sendMessage')[0]).toContain('Give it in the Recued app, on this ask');
    expect(t.sent('sendMessage')[0]).not.toContain('Send the code here');
    await t.send('482913');
    expect(t.turns).toHaveBeenCalledTimes(1);
    expect(await settled(answer)).toBe('pending');
  });
});
