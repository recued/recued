/** D-192 CORE #6 make-live — the WhatsApp inbound webhook.
 *
 *  The security half. Two independent Meta requirements, each with a way to get it
 *  subtly wrong that no ASCII fixture would ever catch:
 *
 *    1. The delivery signature is an HMAC over the RAW bytes. Re-serializing the
 *       JSON before hashing passes every ASCII test and rejects every real message
 *       containing an emoji or an accent — which, on WhatsApp, is most of them.
 *    2. The GET handshake must echo the challenge VERBATIM as text/plain, and must
 *       be indistinguishable from an unwired path when it fails, or it becomes a
 *       way to enumerate which connections exist.
 */

import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { IncomingMessage } from 'node:http';

import { describe, expect, it, vi } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';

import {
  answerWhatsAppChallenge,
  createWhatsAppVendorDescriptor,
  verifyWhatsAppSignature,
} from '../connections/providers/index.js';
import { createIdempotencyLedger, createWebhookPortHandler } from '../ports/index.js';

const APP_SECRET = 'meta-app-secret';
const VERIFY_TOKEN = 'a-long-random-verify-token';

const sign = (body: Buffer, secret = APP_SECRET): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const row = (config: Record<string, unknown>): ConnectionRow =>
  ({
    kind: 'notification',
    name: 'whatsapp',
    subtype: 'whatsapp',
    display_name: 'WhatsApp',
    config_json: JSON.stringify(config),
    auth_ciphertext: '',
    enrolled_at: 0,
    updated_at: 0,
  }) as unknown as ConnectionRow;

const req = (overrides: Partial<IncomingMessage> = {}): IncomingMessage =>
  ({ headers: {}, url: '/webhooks/whatsapp/whatsapp', method: 'POST', ...overrides }) as IncomingMessage;

describe('D-192 WhatsApp — delivery signature (X-Hub-Signature-256)', () => {
  it('accepts a signature over the exact bytes', () => {
    const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
    expect(
      verifyWhatsAppSignature({
        raw_body: body,
        signature_header: sign(body),
        app_secret: APP_SECRET,
      }),
    ).toBe(true);
  });

  it('holds for a NON-ASCII body — the case a re-serializing implementation breaks', () => {
    // THE test. Meta signs the bytes it sent, and escapes non-ASCII as \uXXXX when
    // it does. Any implementation that hashes `JSON.stringify(JSON.parse(body))`
    // produces different bytes here and rejects the delivery — while passing every
    // ASCII fixture. On WhatsApp, an emoji is not an edge case.
    const body = Buffer.from(
      JSON.stringify({ text: { body: 'ship it 🚀 — café' } }),
      'utf8',
    );
    expect(
      verifyWhatsAppSignature({
        raw_body: body,
        signature_header: sign(body),
        app_secret: APP_SECRET,
      }),
    ).toBe(true);
    // ...and a byte-level tamper still fails.
    const tampered = Buffer.from(body.toString('utf8').replace('🚀', '💣'), 'utf8');
    expect(
      verifyWhatsAppSignature({
        raw_body: tampered,
        signature_header: sign(body),
        app_secret: APP_SECRET,
      }),
    ).toBe(false);
  });

  it('fails closed on a wrong secret, a mangled body, a bad grammar, or no header', () => {
    const body = Buffer.from('{"a":1}');
    expect(
      verifyWhatsAppSignature({ raw_body: body, signature_header: sign(body, 'other'), app_secret: APP_SECRET }),
    ).toBe(false);
    expect(
      verifyWhatsAppSignature({ raw_body: Buffer.from('{"a":2}'), signature_header: sign(body), app_secret: APP_SECRET }),
    ).toBe(false);
    for (const header of [undefined, '', 'sha256=zzz', 'sha1=abc', sign(body).toUpperCase()]) {
      expect(
        verifyWhatsAppSignature({ raw_body: body, signature_header: header, app_secret: APP_SECRET }),
      ).toBe(false);
    }
    expect(
      verifyWhatsAppSignature({ raw_body: body, signature_header: sign(body), app_secret: '' }),
    ).toBe(false);
  });
});

describe('D-192 WhatsApp — the GET ownership handshake', () => {
  const query = (params: Record<string, string>): URLSearchParams => new URLSearchParams(params);

  it('echoes the challenge VERBATIM as text/plain', () => {
    // Meta compares the body byte for byte. A JSON-wrapped echo silently fails the
    // subscription while every other part of the endpoint looks perfectly healthy —
    // which is a genuinely awful thing to debug.
    const result = answerWhatsAppChallenge({
      query: query({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '1158201444',
      }),
      verify_token: VERIFY_TOKEN,
    });
    expect(result).toEqual({
      status: 200,
      body: '1158201444',
      content_type: 'text/plain; charset=utf-8',
    });
  });

  it('refuses a wrong token, a wrong mode, or a missing challenge', () => {
    const base = {
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': 'c',
    };
    expect(
      answerWhatsAppChallenge({ query: query({ ...base, 'hub.verify_token': 'wrong' }), verify_token: VERIFY_TOKEN }),
    ).toBeNull();
    expect(
      answerWhatsAppChallenge({ query: query({ ...base, 'hub.mode': 'unsubscribe' }), verify_token: VERIFY_TOKEN }),
    ).toBeNull();
    expect(
      answerWhatsAppChallenge({
        query: query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN }),
        verify_token: VERIFY_TOKEN,
      }),
    ).toBeNull();
  });
});

describe('D-192 WhatsApp — the descriptor', () => {
  const descriptor = (config: Record<string, unknown> | null) =>
    createWhatsAppVendorDescriptor({
      lookupWhatsAppConnection: (name) =>
        config === null || name !== 'whatsapp'
          ? null
          : { row: row(config), app_secret: APP_SECRET },
      dispatchEvent: vi.fn(async () => undefined),
    });

  it('answers the handshake for an enrolled connection', () => {
    const d = descriptor({ verify_token: VERIFY_TOKEN });
    const answer = d.verifyChallenge?.(
      req({ url: `/webhooks/whatsapp/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=XYZ` }),
      'whatsapp',
    );
    expect(answer).toEqual({ status: 200, body: 'XYZ', content_type: 'text/plain; charset=utf-8' });
  });

  it('returns null for an UNKNOWN connection — a GET must not enumerate what exists', () => {
    // The whole reason admitting GET on the port does not widen its fingerprint: a
    // failed handshake and an unwired path are the same generic 404 upstream.
    const d = descriptor({ verify_token: VERIFY_TOKEN });
    expect(
      d.verifyChallenge?.(
        req({ url: `/webhooks/whatsapp/nope?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=XYZ` }),
        'nope',
      ),
    ).toBeNull();
    // ...and for an enrolled row that never got a verify token.
    expect(
      descriptor({}).verifyChallenge?.(
        req({ url: `/webhooks/whatsapp/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=XYZ` }),
        'whatsapp',
      ),
    ).toBeNull();
  });

  it('dedups on the BODY HASH, never on a message id', () => {
    // Deliberate. A delivery batches `entry[] × changes[] × messages[]`, so no single
    // message id identifies it; keying on the first would swallow a re-batched
    // delivery and lose a message silently. `null` makes the port fall back to a
    // sha256 of the raw bytes — which is exact for the case that matters, because a
    // Meta retry is a byte-identical redelivery.
    expect(descriptor({ verify_token: VERIFY_TOKEN }).extractEventId(req(), Buffer.from('{}'))).toBeNull();
  });

  it('hands the dispatcher the NESTED message id under the declared flat key', async () => {
    const dispatchEvent = vi.fn(async () => undefined);
    const d = createWhatsAppVendorDescriptor({
      lookupWhatsAppConnection: () => ({ row: row({}), app_secret: APP_SECRET }),
      dispatchEvent,
    });
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '999' },
                messages: [{ from: '16505551234', id: 'wamid.DEEP', type: 'text', text: { body: 'hi' } }],
              },
            },
          ],
        },
      ],
    };
    const result = await d.dispatch({
      connection_name: 'whatsapp',
      body: Buffer.from(JSON.stringify(payload)),
      headers: {},
    });
    expect(result.ok).toBe(true);
    // `ingress.id_field: 'message_id'` is a flat KEY — the leaf walked the nesting.
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ connection_name: 'whatsapp', message_id: 'wamid.DEEP' }),
    );
  });
});

/** The property that makes admitting GET on the port SAFE.
 *
 *  The port was POST-only, with an explicit comment saying the 404 exists so it
 *  "doesn't leak which path-prefixes are wired". Admitting GET could have undone
 *  that — a GET that behaved differently for a live connection than for an unwired
 *  path would be an enumeration oracle. It does not, and these pin it: a failed
 *  handshake, a vendor with no handshake, and a path that was never configured are
 *  ALL the same generic 404. */
describe('D-192 WhatsApp — the GET handshake does not widen the port fingerprint', () => {
  const port = () =>
    createWebhookPortHandler({
      vendors: {
        whatsapp: createWhatsAppVendorDescriptor({
          lookupWhatsAppConnection: (name) =>
            name === 'whatsapp'
              ? { row: row({ verify_token: VERIFY_TOKEN }), app_secret: APP_SECRET }
              : null,
          dispatchEvent: vi.fn(async () => undefined),
        }),
        // A vendor with NO `verifyChallenge` — the pre-existing shape. Its GET must
        // keep behaving exactly as it did before the hook existed.
        slack: {
          path_prefix: '/webhooks/slack/',
          extractEventId: () => null,
          verifySignature: () => true,
          resolveSecret: () => 'x',
          dispatch: async () => ({ ok: true }),
        },
      },
      ledger: createIdempotencyLedger({ now: () => 0 }),
    });

  const get = async (url: string) => {
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: '',
      setHeader(k: string, v: string) { this.headers[k] = v; },
      end(b?: string) { this.body = b ?? ''; },
    };
    await port()(
      { method: 'GET', url, headers: {} } as IncomingMessage,
      res as never,
    );
    return res;
  };

  it('echoes the challenge as raw text/plain for a valid handshake', async () => {
    const res = await get(
      `/webhooks/whatsapp/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CHAL`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('CHAL');
    expect(res.headers['Content-Type']).toContain('text/plain');
  });

  it('404s a WRONG verify token exactly like an unwired path', async () => {
    const wrongToken = await get(
      '/webhooks/whatsapp/whatsapp?hub.mode=subscribe&hub.verify_token=guessed&hub.challenge=CHAL',
    );
    const unknownConn = await get(
      `/webhooks/whatsapp/nope?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CHAL`,
    );
    const noSuchVendor = await get('/webhooks/nothing/here?hub.mode=subscribe');
    // Byte-identical. An attacker holding the URL but not the token learns nothing
    // about whether a WhatsApp connection is enrolled here.
    for (const res of [wrongToken, unknownConn, noSuchVendor]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(JSON.stringify({ error: { code: 'not_found' } }));
    }
  });

  it('404s a GET to a vendor that declares no handshake — unchanged behavior', async () => {
    const res = await get('/webhooks/slack/slack-prod?hub.mode=subscribe');
    expect(res.statusCode).toBe(404);
  });
});
