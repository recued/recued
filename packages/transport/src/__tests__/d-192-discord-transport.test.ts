/** D-192 — the Discord transport.
 *
 *  Pins the three things a future edit could quietly break:
 *    - `Authorization: Bot`, not `Bearer` — one word, and the wrong one makes a
 *      healthy channel report `auth_failed`;
 *    - `parseInbound` ALWAYS null — the honest boundary of a webhook-only Discord,
 *      not a stub someone should "finish" without first building the Gateway;
 *    - buttons chunk into action rows of 5, and every cap is refused up front.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createDiscordTransport,
  discordInteractionId,
  DISCORD_BUTTONS_PER_ROW,
  DISCORD_BUTTON_LABEL_MAX,
  DISCORD_MAX_BUTTONS,
} from '../discord.js';

const CHANNEL = '987654321098765432';
const TOKEN = 'MTIz.bot.token';

const okResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** A MESSAGE_COMPONENT interaction — a button press. */
const press = (custom_id: string, over: Record<string, unknown> = {}): unknown => ({
  id: '111222333444555666',
  type: 3,
  channel_id: CHANNEL,
  data: { component_type: 2, custom_id },
  member: { user: { id: 'USER-1' } },
  message: { id: 'MSG-1' },
  ...over,
});

describe('D-192 Discord — outbound', () => {
  it('posts to the channel with `Bot` auth, NOT `Bearer`', async () => {
    // One word, and the wrong one is indistinguishable from a revoked token: Discord
    // reads `Bearer` as an OAuth2 user token and 401s a perfectly valid bot token.
    const fetchImpl = vi.fn(async () => okResponse({ id: 'MSG-NEW' }));
    const transport = createDiscordTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await transport.send({ recipient: CHANNEL, token: TOKEN, text: 'hello' });

    expect(result).toEqual({ ok: true, vendor_message_id: 'MSG-NEW' });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
    expect(JSON.parse(init.body as string).content).toBe('hello');
  });

  it("surfaces Discord's error MESSAGE and code, not just the status", async () => {
    // Discord (like Graph, unlike Slack/Telegram) reports faults by HTTP status with
    // the detail in the body. Without lifting it every failure reads "400".
    const fetchImpl = vi.fn(async () =>
      okResponse({ message: 'Invalid Form Body', code: 50035 }, 400),
    );
    const transport = createDiscordTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await transport.send({ recipient: CHANNEL, token: TOKEN, text: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.detail).toContain('Invalid Form Body');
    expect(result.error.detail).toContain('50035');
  });

  it('strips buttons by PATCHing the message — Discord CAN edit (unlike WhatsApp)', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ id: 'MSG-1' }));
    const transport = createDiscordTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await transport.closePrompt({
      recipient: CHANNEL,
      token: TOKEN,
      vendor_message_id: 'MSG-1',
      text: 'Approved',
    });

    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages/MSG-1`);
    const body = JSON.parse(init.body as string);
    expect(body.content).toBe('Approved');
    // An EXPLICIT empty array is what removes them — omitting the key leaves the
    // existing components in place, so a stale prompt would stay pressable.
    expect(body.components).toEqual([]);
  });
});

describe('D-192 Discord — interactive prompts', () => {
  const prompt = (options: Array<{ id: string; label: string }>) => ({
    recipient: CHANNEL,
    token: TOKEN,
    text: 'Approve?',
    correlation_id: 'ask-1',
    options,
  });

  it('renders buttons that round-trip the correlation id', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ id: 'MSG-P' }));
    const t = createDiscordTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await t.sendPrompt(
      prompt([{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }]),
    );
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.components).toEqual([
      {
        type: 1, // ACTION_ROW
        components: [
          { type: 2, style: 2, label: 'Approve', custom_id: 'ask-1|approve' },
          { type: 2, style: 2, label: 'Reject', custom_id: 'ask-1|reject' },
        ],
      },
    ]);
  });

  it('chunks into action rows of five — the vendor\'s layout unit, not ours', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ id: 'MSG-P' }));
    const t = createDiscordTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await t.sendPrompt(
      prompt(Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }))),
    );
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const rows = JSON.parse(init.body as string).components as Array<{ components: unknown[] }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.components).toHaveLength(DISCORD_BUTTONS_PER_ROW);
    expect(rows[1]!.components).toHaveLength(2);
  });

  it('refuses an over-long label rather than TRUNCATING it', async () => {
    // Load-bearing: these are approvals. A clipped label can change what the owner
    // believes they are agreeing to, so a silent truncation is worse than a refusal.
    const t = createDiscordTransport({ fetchImpl: vi.fn() as unknown as typeof fetch });
    const result = await t.sendPrompt(
      prompt([{ id: 'a', label: 'x'.repeat(DISCORD_BUTTON_LABEL_MAX + 1) }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('invalid_request');
    expect(result.error.detail).toContain('shorten');
  });

  it('refuses more options than Discord can render', async () => {
    const t = createDiscordTransport({ fetchImpl: vi.fn() as unknown as typeof fetch });
    const result = await t.sendPrompt(
      prompt(
        Array.from({ length: DISCORD_MAX_BUTTONS + 1 }, (_, i) => ({
          id: `o${i}`,
          label: `O${i}`,
        })),
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('invalid_request');
  });
});

describe('D-192 Discord — inbound', () => {
  const transport = createDiscordTransport({ fetchImpl: vi.fn() as unknown as typeof fetch });

  it('parseInbound is ALWAYS null — the honest boundary, not a stub', () => {
    // ⚠ Do not "fix" this. Discord's Interactions webhook carries no plain user
    // messages; those live on the Gateway (a persistent WS we do not run). The
    // messenger turn and the commitment funnel both gate on `parseInbound`, so
    // returning null is how a webhook-only Discord truthfully says "I cannot read
    // what you type" — through the ordinary seam, with no shared-code branch.
    expect(transport.parseInbound(press('ask-1|approve'))).toBeNull();
    expect(transport.parseInbound({ type: 1 })).toBeNull();
    expect(transport.parseInbound({ content: 'hello there' })).toBeNull();
  });

  it('decodes a button press, from a guild (member.user) and a DM (user)', () => {
    expect(transport.parseInboundChoice(press('ask-1|approve'))).toEqual({
      correlation_id: 'ask-1',
      option_id: 'approve',
      from: 'USER-1',
      vendor_message_id: 'MSG-1',
    });
    // A DM interaction has no `member` — the user sits at the top level instead.
    expect(
      transport.parseInboundChoice(
        press('ask-1|reject', { member: undefined, user: { id: 'DM-USER' } }),
      ),
    ).toMatchObject({ option_id: 'reject', from: 'DM-USER' });
  });

  it('ignores a PING and any non-component interaction', () => {
    expect(transport.parseInboundChoice({ id: '1', type: 1 })).toBeNull();
    expect(transport.parseInboundChoice({ id: '1', type: 2, data: {} })).toBeNull();
  });

  it('binds the conversation on the flat channel_id', () => {
    expect(transport.parseConversationId(press('ask-1|approve'))).toBe(CHANNEL);
    expect(transport.parseCallbackConversationId(press('ask-1|approve'))).toBe(CHANNEL);
    expect(transport.parseConversationId({ type: 3 })).toBeNull();
  });

  it('surfaces the interaction snowflake — the dedup key and the declared id_field', () => {
    expect(discordInteractionId(press('ask-1|approve'))).toBe('111222333444555666');
    expect(discordInteractionId({ type: 3 })).toBeNull();
  });
});
