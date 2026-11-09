/** D-338 — a notification sent through `connection.notification` is a notice too.
 *
 *  The Agenda, "Due today", the Overview and a recipe's notification go out through this handler,
 *  not through the remote channels that took the notice hook in D-338 slice 1, so none of them was
 *  ever a notice: the owner could not quote the Agenda back. Each messenger arm now asks the same
 *  hook, sends what it answers, and reports the id the messenger gave the message. */
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import {
  createConnectionNotificationHandler,
  type ConnectionNoticeHook,
} from '../connection-notification.js';
import type { ResolvedCall } from '../types.js';

const row = (subtype: string, config: Record<string, unknown>): ConnectionRow => ({
  pk: `notification:${subtype}`, kind: 'notification', name: subtype, display_name: subtype,
  config_json: JSON.stringify(config), auth_ciphertext: 'opaque', enrolled_at: 1, updated_at: 1, subtype,
});
const call: ResolvedCall = { slug: 'connection', risk_tier: 'write', input: {}, output: {} };
const bearer = (token: string): ConnectionAuth => ({ type: 'bearer', token });

const AGENDA = { title: 'Agenda · Sat 7 Nov', text: '09:00  Run 5 km\n18:00  Spanish lesson' };
const RULE = 'Not part of your chat with Recued. To ask about it, use Reply on this message.';

/** A hook that makes every notify a notice, the way the chat's does for the owner's chat. */
const noticing = () => {
  const recorded: Array<string | undefined> = [];
  const asked: Array<Parameters<ConnectionNoticeHook['prepare']>[0]> = [];
  const hook: ConnectionNoticeHook = {
    prepare: vi.fn(async (input) => {
      asked.push(input);
      return { title: `Notice · ${input.message.title ?? ''}`, text: `${input.message.text}\n\n${RULE}`,
        sent: async (id: string | undefined) => { recorded.push(id); } };
    }),
  };
  return { hook, recorded, asked };
};

const vendorAnswering = (body: unknown, status = 200) => {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, sent };
};

describe('D-338 a notification to the owner\'s chat goes out as a notice and is recorded', () => {
  it('Telegram: sends the notice, and records it under the message id Telegram gave it', async () => {
    const { hook, recorded, asked } = noticing();
    const vendor = vendorAnswering({ ok: true, result: { message_id: 102, chat: { id: 3001 } } });
    const handler = createConnectionNotificationHandler({ decodeAuth: async () => bearer('BOT-TOKEN'), fetchImpl: vendor.fetchImpl, notices: hook });

    const result = await handler(row('telegram', { chat_id: 3001 }), AGENDA, call);

    expect(result).toMatchObject({ status: 'ok', result: { message_id: 102 } });
    // A numeric chat id is asked about as the string a chat's binding keeps.
    expect(asked).toEqual([{ vendor: 'telegram', recipient: '3001', token: 'BOT-TOKEN', message: AGENDA }]);
    expect(vendor.sent[0]!.body).toEqual({ chat_id: 3001, text: `Notice · Agenda · Sat 7 Nov\n\n${AGENDA.text}\n\n${RULE}` });
    expect(recorded).toEqual(['102']);
  });

  it('Slack: the notice in the post, recorded under its ts', async () => {
    const { hook, recorded, asked } = noticing();
    const vendor = vendorAnswering({ ok: true, ts: '1730000000.0001', channel: 'C1' });
    const handler = createConnectionNotificationHandler({ decodeAuth: async () => bearer('xoxb-1'), fetchImpl: vendor.fetchImpl, notices: hook });

    await handler(row('slack', { channel_id: 'C1' }), AGENDA, call);

    expect(asked).toEqual([{ vendor: 'slack', recipient: 'C1', token: 'xoxb-1', message: AGENDA }]);
    expect(vendor.sent[0]!.body).toEqual({ channel: 'C1', text: `*Notice · Agenda · Sat 7 Nov*\n${AGENDA.text}\n\n${RULE}` });
    expect(recorded).toEqual(['1730000000.0001']);
  });

  it('Discord: the notice in the message, recorded under its id', async () => {
    const { hook, recorded, asked } = noticing();
    const vendor = vendorAnswering({ id: '991' });
    const handler = createConnectionNotificationHandler({ decodeAuth: async () => bearer('BOT-d'), fetchImpl: vendor.fetchImpl, notices: hook });

    await handler(row('discord', { channel_id: ' 555 ' }), { ...AGENDA, link_url: 'https://x.test/today' }, call);

    // The channel id as the chat's binding keeps it (trimmed), and the link stays the notification's.
    expect(asked).toEqual([{ vendor: 'discord', recipient: '555', token: 'BOT-d', message: { ...AGENDA, link_url: 'https://x.test/today' } }]);
    expect(vendor.sent[0]!.body).toEqual({ content: `**Notice · Agenda · Sat 7 Nov**\n${AGENDA.text}\n\n${RULE}\nhttps://x.test/today` });
    expect(recorded).toEqual(['991']);
  });

  it('asks about the chat a recipe names, not the connection\'s own', async () => {
    const { hook, asked } = noticing();
    const vendor = vendorAnswering({ ok: true, result: { message_id: 7 } });
    const handler = createConnectionNotificationHandler({ decodeAuth: async () => bearer('BOT-TOKEN'), fetchImpl: vendor.fetchImpl, notices: hook });

    await handler(row('telegram', { chat_id: 3001 }), { ...AGENDA, recipient: '-100200' }, call);

    expect(asked.map((input) => input.recipient)).toEqual(['-100200']);
  });
});

describe('D-338 every other notification goes as before', () => {
  it('a notification the hook does not make a notice is sent as it was', async () => {
    const vendor = vendorAnswering({ ok: true, result: { message_id: 5 } });
    const prepare = vi.fn(async () => undefined);
    const handler = createConnectionNotificationHandler({ decodeAuth: async () => bearer('BOT-TOKEN'), fetchImpl: vendor.fetchImpl, notices: { prepare } });

    await handler(row('telegram', { chat_id: 3001 }), AGENDA, call);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(vendor.sent[0]!.body).toEqual({ chat_id: 3001, text: `Agenda · Sat 7 Nov\n\n${AGENDA.text}` });
  });

  it('a hook that fails costs the notice, never the notification', async () => {
    const vendor = vendorAnswering({ ok: true, result: { message_id: 5 } });
    const handler = createConnectionNotificationHandler({ decodeAuth: async () => bearer('BOT-TOKEN'), fetchImpl: vendor.fetchImpl,
      notices: { prepare: async () => { throw new Error('identity unavailable'); } } });

    const result = await handler(row('telegram', { chat_id: 3001 }), AGENDA, call);

    expect(result).toMatchObject({ status: 'ok' });
    expect(vendor.sent[0]!.body).toEqual({ chat_id: 3001, text: `Agenda · Sat 7 Nov\n\n${AGENDA.text}` });
  });

  it('a notice the messenger refused is not recorded', async () => {
    const { hook, recorded } = noticing();
    const vendor = vendorAnswering({ ok: false, description: 'Bad Request: chat not found', error_code: 400 });
    const handler = createConnectionNotificationHandler({ decodeAuth: async () => bearer('BOT-TOKEN'), fetchImpl: vendor.fetchImpl, notices: hook });

    const result = await handler(row('telegram', { chat_id: 3001 }), AGENDA, call);

    expect(result).toMatchObject({ status: 'send_error', result: { vendor: 'telegram' } });
    expect(recorded).toEqual([]);
  });

  it('a notice whose delivery is unknown is not recorded', async () => {
    const { hook, recorded } = noticing();
    const vendor = vendorAnswering({ ok: false }, 502);
    const handler = createConnectionNotificationHandler({ decodeAuth: async () => bearer('BOT-TOKEN'), fetchImpl: vendor.fetchImpl, notices: hook });

    await expect(handler(row('telegram', { chat_id: 3001 }), AGENDA, call)).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
    expect(recorded).toEqual([]);
  });

  it('a notice sent but not recorded still reports the send', async () => {
    const vendor = vendorAnswering({ ok: true, result: { message_id: 9 } });
    const handler = createConnectionNotificationHandler({ decodeAuth: async () => bearer('BOT-TOKEN'), fetchImpl: vendor.fetchImpl,
      notices: { prepare: async (input) => ({ title: `Notice · ${input.message.title ?? ''}`, text: input.message.text,
        sent: async () => { throw new Error('the chat is locked'); } }) } });

    expect(await handler(row('telegram', { chat_id: 3001 }), AGENDA, call)).toMatchObject({ status: 'ok', result: { message_id: 9 } });
  });

  it('in the app and by email nothing is asked', async () => {
    const prepare = vi.fn(async () => undefined);
    const emitInApp = vi.fn();
    const mailSend = vi.fn(async () => ({ source_id: 'home', message_id: 'm1', sent_at: 1 }));
    const handler = createConnectionNotificationHandler({ decodeAuth: async () => bearer('x'), emitInApp, notices: { prepare },
      mailRpc: { send: mailSend } });

    await handler(row('in-app', {}), AGENDA, call);
    await handler(row('email', { sender_mail_instance: 'home', default_recipient: 'owner@x.test' }), AGENDA, call);

    expect(emitInApp).toHaveBeenCalledTimes(1);
    expect(mailSend).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
  });
});
