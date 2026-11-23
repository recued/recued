/** D-335 slice Z (2026-11-17) — a sign-in code typed in a chat app for the browser step that waits for
 *  it, through the remote channel over Telegram's and Slack's REAL transports: their own message
 *  parsers and prompt calls, with only the vendors' HTTP APIs faked. The server's half (the code's
 *  shape, the waits, and taking a code before any chat turn or message event) is
 *  `backend/server/src/__tests__/d-335-typed-sign-in-code.test.ts`. */

import { describe, expect, it } from 'vitest';
import { createSlackTransport, createTelegramTransport } from '@recued/transport';

import { createRemoteChannel, type SecretAskState } from '../channels/remote.js';
import type { NotificationMessage } from '../types.js';

/** The owner's Telegram user id, as their connection names them, and their private chat with the bot. */
const OWNER = 1001;
const STOP = [{ id: 'stop', label: 'Stop the task' }];
const ASK: NotificationMessage = {
  title: 'The sign-in code for login.live.com',
  text: 'Give it in the Recued app, on this ask. Do not send it in a chat.',
  chat: { title: 'The sign-in code for login.live.com', text: 'Send the code here, as a message on its own.' },
};
/** A stand-in for the server's rule (`signInCodeOf`): six digits, or conversation. */
const sixDigits = (text: string): string | null => (/^\d{6}$/u.test(text.trim()) ? text.trim() : null);
const waiting = (...ids: string[]): Map<string, SecretAskState> => new Map(ids.map((id) => [id, 'waiting' as const]));

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Telegram's Bot API, faked at HTTP: each `sendMessage` is answered with the next message id. */
const telegram = (owner: number | null = OWNER) => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let next = 7;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split('/').pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return jsonResponse({ ok: true, result: { message_id: method === 'sendMessage' ? next++ : 1 } });
  }) as typeof fetch;
  const channel = createRemoteChannel({
    transport: createTelegramTransport({ fetchImpl, timeoutMs: 5_000 }),
    resolveCredential: async () => ({ token: 'bot-token', recipient: String(OWNER),
      ...(owner !== null ? { expected_sender: String(owner) } : {}) }),
  });
  return { channel, calls };
};

/** A Telegram message update, as the Bot API sends one. */
const telegramMessage = (text: string, over: { from?: number; chat?: number; replyTo?: number } = {}) => ({
  update_id: 900,
  message: {
    message_id: 50, date: 1_700_000_000, text,
    from: { id: over.from ?? OWNER, is_bot: false, first_name: 'Owner' },
    chat: { id: over.chat ?? OWNER, type: 'private' },
    ...(over.replyTo !== undefined
      ? { reply_to_message: { message_id: over.replyTo, date: 1, chat: { id: over.chat ?? OWNER, type: 'private' } } } : {}),
  },
});

describe('D-335 slice Z — a chat app is told it may send a sign-in code only where it can tell the owner', () => {
  it('shows the chat words on a connection that names the owner, and the app\'s words on one that names nobody', async () => {
    const named = telegram();
    await named.channel.deliverAsk('ask-1', ASK, STOP);
    expect(named.calls[0]).toMatchObject({ method: 'sendMessage' });
    expect(String(named.calls[0]!.body.text)).toContain('Send the code here, as a message on its own.');
    expect(String(named.calls[0]!.body.text)).not.toContain('Give it in the Recued app');

    const unnamed = telegram(null);
    await unnamed.channel.deliverAsk('ask-1', ASK, STOP);
    expect(String(unnamed.calls[0]!.body.text)).toContain('Give it in the Recued app, on this ask. Do not send it in a chat.');
    expect(String(unnamed.calls[0]!.body.text)).not.toContain('Send the code here');
    // ⛔ And it takes none: the owner was never invited to type one, and nobody's typing is the owner's.
    expect(unnamed.channel.parseInboundSecret!(telegramMessage('482913'), waiting('ask-1'), sixDigits)).toBeNull();
  });

  it('an ask with no chat words reads as before on a named connection (an approval\'s plain words)', async () => {
    const { channel, calls } = telegram();
    await channel.deliverAsk('ask-1', { title: 'Approve?', text: 'tool_call: mail.send', plain: { text: 'Send the reply to Dana?' } }, STOP);
    expect(String(calls[0]!.body.text)).toContain('Send the reply to Dana?');
    expect(String(calls[0]!.body.text)).not.toContain('tool_call');
  });
});

describe('D-335 slice Z — Telegram: which message is a code, and for which ask', () => {
  it('the owner\'s code on its own answers the one ask waiting in that chat', async () => {
    const { channel } = telegram();
    await channel.deliverAsk('ask-1', ASK, STOP);
    expect(channel.parseInboundSecret!(telegramMessage(' 482913 '), waiting('ask-1'), sixDigits))
      .toEqual({ kind: 'secret', ask_id: 'ask-1', value: '482913' });
  });

  it('passes on conversation, another person in the chat, another chat, and an ask this channel never delivered', async () => {
    const { channel } = telegram();
    await channel.deliverAsk('ask-1', ASK, STOP);
    const asks = waiting('ask-1');
    expect(channel.parseInboundSecret!(telegramMessage('thanks, on it'), asks, sixDigits)).toBeNull();
    expect(channel.parseInboundSecret!(telegramMessage('482913', { from: 2002 }), asks, sixDigits)).toBeNull();
    expect(channel.parseInboundSecret!(telegramMessage('482913', { chat: -5005 }), asks, sixDigits)).toBeNull();
    expect(channel.parseInboundSecret!(telegramMessage('482913'), waiting('not-here'), sixDigits)).toBeNull();
    // A button press is not a typed message.
    expect(channel.parseInboundSecret!({ update_id: 901, callback_query: { id: 'q', data: 'x', from: { id: OWNER } } },
      asks, sixDigits)).toBeNull();
    // Nothing is read while nothing waits.
    expect(channel.parseInboundSecret!(telegramMessage('482913'), new Map(), sixDigits)).toBeNull();
  });

  it('with two asks waiting, a reply to one\'s message names it, and a code on its own is given to neither', async () => {
    const { channel } = telegram();
    await channel.deliverAsk('ask-1', ASK, STOP); // Telegram message 7
    await channel.deliverAsk('ask-2', ASK, STOP); // Telegram message 8
    const asks = waiting('ask-1', 'ask-2');
    expect(channel.parseInboundSecret!(telegramMessage('482913', { replyTo: 8 }), asks, sixDigits))
      .toEqual({ kind: 'secret', ask_id: 'ask-2', value: '482913' });
    expect(channel.parseInboundSecret!(telegramMessage('482913', { replyTo: 7 }), asks, sixDigits))
      .toEqual({ kind: 'secret', ask_id: 'ask-1', value: '482913' });
    expect(channel.parseInboundSecret!(telegramMessage('482913'), asks, sixDigits)).toEqual({ kind: 'ambiguous' });
    // A reply to some other message names neither.
    expect(channel.parseInboundSecret!(telegramMessage('482913', { replyTo: 3 }), asks, sixDigits)).toEqual({ kind: 'ambiguous' });
  });

  it('a code for an ask that waits no longer is late: closed here, or ended at the step', async () => {
    const { channel } = telegram();
    await channel.deliverAsk('ask-1', ASK, STOP);
    expect(channel.parseInboundSecret!(telegramMessage('482913'), new Map([['ask-1', 'ended' as const]]), sixDigits))
      .toEqual({ kind: 'late' });
    expect(channel.parseInboundSecret!(telegramMessage('482913', { replyTo: 7 }), new Map([['ask-1', 'ended' as const]]), sixDigits))
      .toEqual({ kind: 'late' });
    // Closed on this channel (answered in the app): late, though the server has not yet said so.
    await channel.closeAsk('ask-1');
    expect(channel.parseInboundSecret!(telegramMessage('482913'), waiting('ask-1'), sixDigits)).toEqual({ kind: 'late' });
  });
});

describe('D-335 slice Z — Slack: a thread reply names the ask', () => {
  const slack = () => {
    let ts = 0;
    const fetchImpl = (async () => jsonResponse({ ok: true, channel: 'D0OWNER', ts: `1700000000.00010${String(ts++)}` })) as typeof fetch;
    const channel = createRemoteChannel({
      transport: createSlackTransport({ fetchImpl, timeoutMs: 5_000 }),
      resolveCredential: async () => ({ token: 'xoxb', recipient: 'D0OWNER', expected_sender: 'U0OWNER' }),
    });
    return channel;
  };
  /** A Slack Events API message, as the owner sends one in the DM, or in a prompt's thread. */
  const slackMessage = (text: string, over: { user?: string; thread_ts?: string } = {}) => ({
    type: 'event_callback', event_id: 'Ev1',
    event: { type: 'message', channel: 'D0OWNER', user: over.user ?? 'U0OWNER', text, ts: '1700000099.000900',
      ...(over.thread_ts !== undefined ? { thread_ts: over.thread_ts } : {}) },
  });

  it('answers in the DM, names the ask by its thread, and refuses another user', async () => {
    const channel = slack();
    await channel.deliverAsk('ask-1', ASK, STOP); // ts …000100
    await channel.deliverAsk('ask-2', ASK, STOP); // ts …000101
    expect(channel.parseInboundSecret!(slackMessage('482913', { thread_ts: '1700000000.000101' }), waiting('ask-1', 'ask-2'), sixDigits))
      .toEqual({ kind: 'secret', ask_id: 'ask-2', value: '482913' });
    expect(channel.parseInboundSecret!(slackMessage('482913'), waiting('ask-1'), sixDigits))
      .toEqual({ kind: 'secret', ask_id: 'ask-1', value: '482913' });
    expect(channel.parseInboundSecret!(slackMessage('482913', { user: 'U0SOMEONE' }), waiting('ask-1'), sixDigits)).toBeNull();
  });
});

describe('D-335 slice Z follow-up (2026-11-17) — the owner’s message with a code is deleted from the chat', () => {
  /** Telegram's Bot API, faked at HTTP, answering `deleteMessage` as told. */
  const telegramDeleting = (deleteAnswer: unknown = { ok: true, result: true }, owner: number | null = OWNER) => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const method = String(input).split('/').pop()!;
      calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return jsonResponse(method === 'deleteMessage' ? deleteAnswer : { ok: true, result: { message_id: 7 } });
    }) as typeof fetch;
    const channel = createRemoteChannel({
      transport: createTelegramTransport({ fetchImpl, timeoutMs: 5_000 }),
      resolveCredential: async () => ({ token: 'bot-token', recipient: String(OWNER),
        ...(owner !== null ? { expected_sender: String(owner) } : {}) }),
    });
    return { channel, deletes: () => calls.filter((call) => call.method === 'deleteMessage').map((call) => call.body) };
  };

  it('Telegram deletes the owner’s own message, by its chat and its id', async () => {
    const { channel, deletes } = telegramDeleting();
    expect(await channel.deleteInboundMessage!(telegramMessage('482913'))).toBe('deleted');
    expect(deletes()).toEqual([{ chat_id: String(OWNER), message_id: 50 }]);
  });

  it('⛔ never another person’s message, one in another chat, or any on a connection that names no owner', async () => {
    const someone = telegramDeleting();
    expect(await someone.channel.deleteInboundMessage!(telegramMessage('482913', { from: 2002 }))).toBe('failed');
    expect(await someone.channel.deleteInboundMessage!(telegramMessage('482913', { chat: 3003 }))).toBe('failed');
    expect(someone.deletes()).toEqual([]);
    const unnamed = telegramDeleting(undefined, null);
    expect(await unnamed.channel.deleteInboundMessage!(telegramMessage('482913'))).toBe('failed');
    expect(unnamed.deletes()).toEqual([]);
  });

  it('a deletion Telegram refuses is failed, never deleted', async () => {
    const { channel, deletes } = telegramDeleting({ ok: false, error_code: 400, description: 'Bad Request: message can\'t be deleted' });
    expect(await channel.deleteInboundMessage!(telegramMessage('482913'))).toBe('failed');
    expect(deletes()).toHaveLength(1);
  });

  it('Slack lets no bot delete the owner’s message: unsupported, and nothing is called', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return jsonResponse({ ok: true, channel: 'D0OWNER', ts: '1700000000.000100' });
    }) as typeof fetch;
    const channel = createRemoteChannel({
      transport: createSlackTransport({ fetchImpl, timeoutMs: 5_000 }),
      resolveCredential: async () => ({ token: 'xoxb', recipient: 'D0OWNER', expected_sender: 'U0OWNER' }),
    });
    const message = { type: 'event_callback', event_id: 'Ev1',
      event: { type: 'message', channel: 'D0OWNER', user: 'U0OWNER', text: '482913', ts: '1700000099.000900' } };
    expect(await channel.deleteInboundMessage!(message)).toBe('unsupported');
    expect(calls).toEqual([]);
  });
});
