/** D-192 CORE #6 make-live — the WhatsApp Cloud API transport.
 *
 *  Pins the three things that make WhatsApp different from Slack / Telegram, since
 *  each one is a place a future edit could quietly break it:
 *    - the conversation ADDRESS is a pair (`<phone_number_id>/<wa_id>`), and the
 *      encode side (backend resolver) and decode side (this transport) must agree
 *      or the binding gate silently refuses every turn;
 *    - the vendor caps are refused UP FRONT, never truncated;
 *    - `closePrompt` is impossible and says so, rather than lying `{ok:true}`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createWhatsAppTransport,
  decodeWhatsAppAddress,
  encodeWhatsAppAddress,
  normalizeWaId,
  whatsAppMessageId,
  WHATSAPP_BUTTON_LABEL_MAX,
  WHATSAPP_MAX_BUTTONS,
} from '../whatsapp.js';

const PNID = '123456789012345';
const WA_ID = '16505551234';
const ADDRESS = `${PNID}/${WA_ID}`;

const okResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** A Meta webhook envelope carrying one inbound message. */
const envelope = (message: Record<string, unknown>): unknown => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA-ID',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: PNID },
            contacts: [{ profile: { name: 'Owner' }, wa_id: WA_ID }],
            messages: [message],
          },
        },
      ],
    },
  ],
});

const textMessage = (body: string): Record<string, unknown> => ({
  from: WA_ID,
  id: 'wamid.TEXT',
  timestamp: '1700000000',
  type: 'text',
  text: { body },
});

describe('D-192 WhatsApp — the conversation address is a PAIR', () => {
  it('round-trips, and both halves survive', () => {
    expect(decodeWhatsAppAddress(encodeWhatsAppAddress(PNID, WA_ID))).toEqual({
      phone_number_id: PNID,
      wa_id: WA_ID,
    });
  });

  it('refuses a bare id — half an address cannot address anything', () => {
    expect(decodeWhatsAppAddress(WA_ID)).toBeNull();
    expect(decodeWhatsAppAddress('')).toBeNull();
    expect(decodeWhatsAppAddress(`/${WA_ID}`)).toBeNull();
    expect(decodeWhatsAppAddress(`${PNID}/`)).toBeNull();
  });

  it('normalises a human phone number to the wire form', () => {
    // The owner types this into the enroll card; the webhook's `from` is bare
    // digits. If only one side normalised, the binding gate would compare a
    // formatted number against a bare one, never match, and refuse every turn —
    // fail-closed, for a purely cosmetic reason, with nothing to explain why.
    expect(normalizeWaId('+1 (650) 555-1234')).toBe(WA_ID);
    expect(normalizeWaId(WA_ID)).toBe(WA_ID);
  });

  it('parses the SAME address out of an inbound payload that the resolver builds', () => {
    // The load-bearing agreement: `parseConversationId` must reproduce, byte for
    // byte, what the backend resolver composed from config — the binding gate is a
    // string compare.
    const transport = createWhatsAppTransport({ fetchImpl: vi.fn() });
    expect(transport.parseConversationId(envelope(textMessage('hi')))).toBe(
      encodeWhatsAppAddress(PNID, WA_ID),
    );
  });
});

describe('D-192 WhatsApp — outbound', () => {
  it('posts to the ACCOUNT-SCOPED url and puts the user in the body', () => {
    const fetchImpl = vi.fn(async () => okResponse({ messages: [{ id: 'wamid.SENT' }] }));
    const transport = createWhatsAppTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });

    return transport
      .send({ recipient: ADDRESS, token: 'EAAG', text: 'hello' })
      .then((result) => {
        expect(result).toEqual({ ok: true, vendor_message_id: 'wamid.SENT' });
        const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
        // The phone-number id is the URL — this is the whole reason the address
        // carries two halves.
        expect(url).toBe(`https://graph.facebook.com/v22.0/${PNID}/messages`);
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer EAAG');
        const body = JSON.parse(init.body as string);
        expect(body.to).toBe(WA_ID);
        expect(body.messaging_product).toBe('whatsapp');
        expect(body.text.body).toBe('hello');
      });
  });

  it('refuses a malformed address BEFORE any network call', async () => {
    const fetchImpl = vi.fn();
    const transport = createWhatsAppTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await transport.send({ recipient: WA_ID, token: 'EAAG', text: 'hi' });
    expect(result.ok).toBe(false);
    // Sending to the wrong business number is not a recoverable error, so it never
    // reaches the wire.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces Graph's error MESSAGE, not just its status", async () => {
    // Graph reports faults by HTTP status with the only useful detail in the body.
    // Without lifting it, every failure read "400 Bad Request" — which cannot tell
    // a bad token from the one that actually matters: outside the 24-hour window.
    const fetchImpl = vi.fn(async () =>
      okResponse(
        { error: { message: 'Message failed to send because more than 24 hours have passed', code: 131047 } },
        400,
      ),
    );
    const transport = createWhatsAppTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await transport.send({ recipient: ADDRESS, token: 'EAAG', text: 'hi' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.detail).toContain('24 hours');
    expect(result.error.detail).toContain('131047');
  });
});

describe('D-192 WhatsApp — interactive prompts refuse vendor caps up front', () => {
  const transport = createWhatsAppTransport({ fetchImpl: vi.fn() as unknown as typeof fetch });
  const prompt = (options: Array<{ id: string; label: string }>) => ({
    recipient: ADDRESS,
    token: 'EAAG',
    text: 'Approve?',
    correlation_id: 'ask-1',
    options,
  });

  it(`refuses more than ${WHATSAPP_MAX_BUTTONS} options rather than letting Meta reject the send`, async () => {
    const result = await transport.sendPrompt(
      prompt(
        Array.from({ length: WHATSAPP_MAX_BUTTONS + 1 }, (_, i) => ({
          id: `o${i}`,
          label: `Option ${i}`,
        })),
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('invalid_request');
  });

  it('refuses an over-long label rather than TRUNCATING it', async () => {
    // Load-bearing: these prompts are approvals. A clipped label can change what
    // the owner believes they are agreeing to, so a silent truncation would be
    // worse than a refusal.
    const label = 'x'.repeat(WHATSAPP_BUTTON_LABEL_MAX + 1);
    const result = await transport.sendPrompt(prompt([{ id: 'approve', label }]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('invalid_request');
    expect(result.error.detail).toContain('shorten');
  });

  it('renders reply buttons that round-trip the correlation id', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ messages: [{ id: 'wamid.PROMPT' }] }));
    const t = createWhatsAppTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await t.sendPrompt(prompt([{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }]));
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('interactive');
    expect(body.interactive.action.buttons).toEqual([
      { type: 'reply', reply: { id: 'ask-1|approve', title: 'Approve' } },
      { type: 'reply', reply: { id: 'ask-1|reject', title: 'Reject' } },
    ]);
  });
});

describe('D-192 WhatsApp — closePrompt is impossible, and says so', () => {
  it('reports invalid_request instead of lying ok:true', async () => {
    // WhatsApp has NO message-edit API. Returning `{ok:false}` is SAFE — `closeAsk`
    // discards the result and never throws — and honest, where `{ok:true}` would
    // claim the buttons were stripped when they are still sitting there.
    const fetchImpl = vi.fn();
    const transport = createWhatsAppTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await transport.closePrompt({
      recipient: ADDRESS,
      token: 'EAAG',
      vendor_message_id: 'wamid.PROMPT',
      text: 'Approved',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('invalid_request');
    // And it never posts a consolation message — WhatsApp bills per message, and
    // `closePrompt` means "edit that one", not "send another".
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('D-192 WhatsApp — inbound', () => {
  const transport = createWhatsAppTransport({ fetchImpl: vi.fn() as unknown as typeof fetch });

  it('parses a text message', () => {
    expect(transport.parseInbound(envelope(textMessage('ship it')))).toEqual({
      from: WA_ID,
      text: 'ship it',
      vendor_message_id: 'wamid.TEXT',
    });
  });

  it('parses a button press, and does NOT double-classify it as a message', () => {
    const press = envelope({
      from: WA_ID,
      id: 'wamid.PRESS',
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'ask-1|approve', title: 'Approve' },
      },
      context: { from: '15550001111', id: 'wamid.PROMPT' },
    });
    expect(transport.parseInboundChoice(press)).toEqual({
      correlation_id: 'ask-1',
      option_id: 'approve',
      from: WA_ID,
      vendor_message_id: 'wamid.PROMPT',
    });
    // The inbound dispatcher tries the reply path, then falls through to the
    // message path. A press that ALSO parsed as a user message would be handled
    // twice — once as an answer, once as a chat turn.
    expect(transport.parseInbound(press)).toBeNull();
  });

  it('ignores a delivery-status callback — a read receipt is not a user turn', () => {
    // These arrive constantly (sent / delivered / read). Treating one as a message
    // would wake the agent on its own outbound traffic.
    const status = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA-ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PNID },
                statuses: [{ id: 'wamid.SENT', status: 'read', recipient_id: WA_ID }],
              },
            },
          ],
        },
      ],
    };
    expect(transport.parseInbound(status)).toBeNull();
    expect(transport.parseInboundChoice(status)).toBeNull();
    expect(transport.parseConversationId(status)).toBeNull();
  });

  it('surfaces the nested message id the provider re-publishes under the flat id_field', () => {
    // The registry's `ingress.id_field` is a KEY NAME, not a path — so the leaf
    // does the walk. This is that walk.
    expect(whatsAppMessageId(envelope(textMessage('hi')))).toBe('wamid.TEXT');
    expect(whatsAppMessageId({ object: 'x', entry: [] })).toBeNull();
  });

  it('extracts media refs from an image message', () => {
    const parsed = transport.parseInbound(
      envelope({
        from: WA_ID,
        id: 'wamid.IMG',
        type: 'image',
        image: { id: 'MEDIA-1', mime_type: 'image/jpeg' },
        caption: 'look',
      }),
    );
    expect(parsed?.text).toBe('look');
    expect(parsed?.media).toEqual([
      { type: 'image', mime: 'image/jpeg', size: 0, remote_id: 'MEDIA-1' },
    ]);
  });
});
