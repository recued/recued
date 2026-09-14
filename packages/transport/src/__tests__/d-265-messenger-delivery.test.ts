import { describe, expect, it } from 'vitest';
import { createDiscordTransport, createSlackTransport, createTelegramTransport } from '../index.js';

const vendors = [
  { vendor: 'slack', create: createSlackTransport, response: { ok: true, ts: '200.001' } },
  { vendor: 'telegram', create: createTelegramTransport, response: { ok: true, result: { message_id: 200 } } },
  { vendor: 'discord', create: createDiscordTransport, response: { id: '200' } },
];
describe.each(vendors)('D-265 $vendor text delivery', ({ vendor, create, response }) => {
  it('sends exact Unicode text with explicit reply/thread addressing and disables incidental mentions', async () => {
    let body: unknown;
    const transport = create({ fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body)); return Response.json(response);
    } });
    const text = '😀 <@123> & <!everyone> *bold*\nhttps://example.test/?a=1&b=2';
    expect(await transport.send({ token: 'fixture', recipient: '123', text, lossless: true,
      reply_to_message_id: '100', thread_id: '77', delivery_id: '123456789012345678901234' })).toMatchObject({ ok: true });
    if (vendor === 'slack') expect(body).toEqual({ channel: '123', text, thread_ts: '77', mrkdwn: false,
      parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false,
      blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }],
    });
    if (vendor === 'telegram') expect(body).toEqual({ chat_id: '123', text,
      reply_parameters: { message_id: 100 }, message_thread_id: 77 });
    if (vendor === 'discord') expect(body).toEqual({ content: text,
      allowed_mentions: { parse: [], replied_user: false }, nonce: '123456789012345678901234', enforce_nonce: true,
      message_reference: { message_id: '100', fail_if_not_exists: true },
    });
  });

  it('rejects oversized lossless text before any request instead of silently trimming it', async () => {
    let calls = 0;
    const transport = create({ fetchImpl: async () => { calls++; return Response.json(response); } });
    expect(await transport.send({ token: 'fixture', recipient: '123', text: '😀'.repeat(3000), lossless: true }))
      .toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    expect(calls).toBe(0);
  });

  it('preserves the vendor minimum wait on HTTP 429', async () => {
    const transport = create({ fetchImpl: async () => Response.json({ message: 'rate limited' }, {
      status: 429, headers: { 'Retry-After': '123.5' },
    }) });
    expect(await transport.send({ token: 'fixture', recipient: '123', text: 'hello', lossless: true }))
      .toMatchObject({ ok: false, error: { kind: 'rate_limited', retry_after_ms: 123500 } });
  });
});

it('reads Telegram and Discord body retry timing when no header is present', async () => {
  const telegram = createTelegramTransport({ fetchImpl: async () => Response.json({ ok: false,
    error_code: 429, parameters: { retry_after: 180 }, description: 'Too Many Requests' }, { status: 429 }) });
  const discord = createDiscordTransport({ fetchImpl: async () => Response.json({ retry_after: 12.75,
    message: 'You are being rate limited.' }, { status: 429 }) });
  const message = { token: 'fixture', recipient: '123', text: 'hello' };
  expect(await telegram.send(message)).toMatchObject({ ok: false, error: { retry_after_ms: 180000 } });
  expect(await discord.send(message)).toMatchObject({ ok: false, error: { retry_after_ms: 12750 } });
});

it('does not invent a Slack thread from a generic reply identifier', async () => {
  let body: unknown;
  const slack = createSlackTransport({ fetchImpl: async (_url, init) => {
    body = JSON.parse(String(init?.body)); return Response.json({ ok: true, ts: 'posted' });
  } });
  await slack.send({ token: 'fixture', recipient: 'C123', text: 'hello', reply_to_message_id: '100', lossless: true });
  expect(body).not.toHaveProperty('thread_ts');
});
