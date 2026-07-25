/** D-192 — the Discord inbound interaction webhook.
 *
 *  Signed with a REAL Ed25519 keypair, not a stubbed verifier — the whole point of
 *  this file is that the crypto is right, and a mocked signature would prove nothing.
 *
 *  ⚠ Discord VALIDATES YOUR VALIDATION: when the Interactions URL is saved it replays
 *  the PING with a deliberately BAD signature and requires a 401 back. A permissive
 *  verifier therefore does not fail quietly — the endpoint simply refuses to register.
 *  So the reject paths below are as load-bearing as the accept path, and the 3-second
 *  ack behaviour is pinned because a press that WORKS but answers late still shows the
 *  user a red "interaction failed".
 */

import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { IncomingMessage } from 'node:http';

import { describe, expect, it, vi } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';

import {
  createDiscordVendorDescriptor,
  DISCORD_DEFERRED_ACK_BODY,
  DISCORD_PONG_BODY,
  verifyDiscordSignature,
  type DiscordProviderDeps,
} from '../connections/providers/index.js';

// A real Discord application keypair: Discord holds the private half, we hold the
// public half as 64 hex chars.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY_HEX = publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(12) // strip the 12-byte SPKI header — the trailing 32 bytes ARE the key
  .toString('hex');

const TIMESTAMP = '1700000000';

const signBody = (body: Buffer, ts = TIMESTAMP): string =>
  edSign(null, Buffer.concat([Buffer.from(ts, 'utf8'), body]), privateKey).toString('hex');

const row = (config: Record<string, unknown>): ConnectionRow =>
  ({
    kind: 'notification',
    name: 'discord',
    subtype: 'discord',
    display_name: 'Discord',
    config_json: JSON.stringify(config),
    auth_ciphertext: '',
    enrolled_at: 0,
    updated_at: 0,
  }) as unknown as ConnectionRow;

const req = (headers: Record<string, string>): IncomingMessage =>
  ({ headers, url: '/webhooks/discord/discord', method: 'POST' }) as unknown as IncomingMessage;

describe('D-192 Discord — Ed25519 verification', () => {
  it('accepts a real signature over <timestamp><raw body>', () => {
    const body = Buffer.from(JSON.stringify({ type: 1 }));
    expect(
      verifyDiscordSignature({
        raw_body: body,
        signature_header: signBody(body),
        timestamp_header: TIMESTAMP,
        public_key: PUBLIC_KEY_HEX,
      }),
    ).toBe(true);
  });

  it('holds for a NON-ASCII body — the case a re-serializing verifier breaks on', () => {
    // The same trap as WhatsApp: hashing `JSON.stringify(JSON.parse(body))` passes
    // every ASCII fixture and rejects real traffic the moment someone types an emoji.
    const body = Buffer.from(JSON.stringify({ data: { custom_id: 'ask|✅ café 🚀' } }), 'utf8');
    expect(
      verifyDiscordSignature({
        raw_body: body,
        signature_header: signBody(body),
        timestamp_header: TIMESTAMP,
        public_key: PUBLIC_KEY_HEX,
      }),
    ).toBe(true);
  });

  it('REJECTS a bad signature — the check Discord actively tests for', () => {
    // Discord replays the PING with a deliberately invalid signature during endpoint
    // registration and requires a 401. If this ever returned true, the endpoint would
    // not merely be insecure — it would fail to register at all.
    const body = Buffer.from(JSON.stringify({ type: 1 }));
    const otherKey = generateKeyPairSync('ed25519').privateKey;
    const wrongSig = edSign(
      null,
      Buffer.concat([Buffer.from(TIMESTAMP), body]),
      otherKey,
    ).toString('hex');
    expect(
      verifyDiscordSignature({
        raw_body: body,
        signature_header: wrongSig,
        timestamp_header: TIMESTAMP,
        public_key: PUBLIC_KEY_HEX,
      }),
    ).toBe(false);
  });

  it('rejects a tampered body, a swapped timestamp, and malformed inputs', () => {
    const body = Buffer.from(JSON.stringify({ type: 1 }));
    const sig = signBody(body);
    const base = { timestamp_header: TIMESTAMP, public_key: PUBLIC_KEY_HEX };

    // The signature covers the timestamp AND the body — move either and it dies.
    expect(
      verifyDiscordSignature({ ...base, raw_body: Buffer.from('{"type":2}'), signature_header: sig }),
    ).toBe(false);
    expect(
      verifyDiscordSignature({ ...base, raw_body: body, signature_header: sig, timestamp_header: '1700000001' }),
    ).toBe(false);

    for (const bad of [undefined, '', 'nothex', sig.slice(0, 100), `${sig}ff`]) {
      expect(
        verifyDiscordSignature({ ...base, raw_body: body, signature_header: bad }),
      ).toBe(false);
    }
    // A malformed or absent PUBLIC key must fail closed, never throw.
    for (const key of ['', 'zz', PUBLIC_KEY_HEX.slice(0, 62)]) {
      expect(
        verifyDiscordSignature({ raw_body: body, signature_header: sig, timestamp_header: TIMESTAMP, public_key: key }),
      ).toBe(false);
    }
    expect(
      verifyDiscordSignature({ ...base, raw_body: body, signature_header: sig, timestamp_header: undefined }),
    ).toBe(false);
  });
});

describe('D-192 Discord — the descriptor', () => {
  const build = (
    dispatchEvent: (event: never) => Promise<void> = vi.fn(async () => undefined),
  ) => {
    const log = vi.fn();
    const descriptor = createDiscordVendorDescriptor({
      lookupDiscordConnection: (name) =>
        name === 'discord' ? { row: row({ public_key: PUBLIC_KEY_HEX }), public_key: PUBLIC_KEY_HEX } : null,
      dispatchEvent: dispatchEvent as unknown as DiscordProviderDeps['dispatchEvent'],
      log,
    });
    return { descriptor, dispatchEvent, log };
  };

  const body = (payload: unknown): Buffer => Buffer.from(JSON.stringify(payload));

  it('answers a PING with the exact PONG body', async () => {
    const { descriptor, dispatchEvent } = build();
    const result = await descriptor.dispatch({
      connection_name: 'discord',
      body: body({ id: '1', type: 1 }),
      headers: {},
    });
    expect(result.ok).toBe(true);
    expect(result.response_override).toEqual({
      status: 200,
      content_type: 'application/json',
      body: DISCORD_PONG_BODY,
    });
    // A PING is endpoint validation, not an event — it must never reach the engine.
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('SKIPS DEDUP on a PING — a re-verify must not be answered {deduped:true}', () => {
    // Discord re-PINGs whenever the URL is saved, and periodically after. If the
    // idempotency ledger swallowed the second one it would get `{ok:true,
    // deduped:true}` instead of a PONG and mark the endpoint invalid. The exact trap
    // Slack's `url_verification` opt-out exists for.
    const { descriptor } = build();
    expect(descriptor.shouldSkipDedup?.(req({}), body({ type: 1 }))).toBe(true);
    expect(descriptor.shouldSkipDedup?.(req({}), body({ type: 3 }))).toBe(false);
  });

  it('acks a button press with DEFERRED_UPDATE_MESSAGE and dispatches it', async () => {
    const { descriptor, dispatchEvent } = build();
    const result = await descriptor.dispatch({
      connection_name: 'discord',
      body: body({ id: 'INT-9', type: 3, channel_id: 'C1', data: { custom_id: 'ask|approve' } }),
      headers: {},
    });
    expect(result.response_override).toEqual({
      status: 200,
      content_type: 'application/json',
      body: DISCORD_DEFERRED_ACK_BODY,
    });
    // The nested→flat id walk, under the declared `ingress.id_field`.
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ connection_name: 'discord', interaction_id: 'INT-9' }),
    );
  });

  it('ACKS WITHOUT AWAITING the downstream — the 3-second rule', async () => {
    // THE design test. Discord kills an unacknowledged interaction at 3 seconds and
    // shows the user a red "This interaction failed" — even when the press was
    // recorded. Meanwhile `submitAnswer` fans `closeAsk` out across every enrolled
    // channel, each an HTTP call with a 15-second timeout, so ONE slow vendor would
    // blow the budget on a press that worked perfectly.
    //
    // So: a dispatch that never settles must STILL produce the ack. Awaiting here
    // would hang this test — which is exactly what it would do to a real user.
    let release: (() => void) | undefined;
    const hangs = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const { descriptor, log } = build(hangs as unknown as (e: never) => Promise<void>);

    const result = await descriptor.dispatch({
      connection_name: 'discord',
      body: body({ id: 'INT-SLOW', type: 3, data: { custom_id: 'ask|approve' } }),
      headers: {},
    });

    expect(result.ok).toBe(true);
    expect((result.response_override as { body: string }).body).toBe(DISCORD_DEFERRED_ACK_BODY);
    expect(hangs).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalledWith('warn', expect.anything(), expect.anything());
    release?.();
  });

  it('LOGS a downstream failure — the only place it can surface, since we did not await', async () => {
    const boom = vi.fn(async () => { throw new Error('ask already answered'); });
    const { descriptor, log } = build(boom as unknown as (e: never) => Promise<void>);

    await descriptor.dispatch({
      connection_name: 'discord',
      body: body({ id: 'INT-BOOM', type: 3, data: { custom_id: 'ask|approve' } }),
      headers: {},
    });
    // The rejection settles on a later microtask; let it.
    await new Promise((r) => setTimeout(r, 0));

    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('dispatch failed after ack'),
      expect.objectContaining({ interaction_id: 'INT-BOOM' }),
    );
  });

  it('dedups on the interaction snowflake', () => {
    const { descriptor } = build();
    expect(descriptor.extractEventId(req({}), body({ id: 'INT-1', type: 3 }))).toBe('INT-1');
    expect(descriptor.extractEventId(req({}), Buffer.from('not json'))).toBeNull();
  });

  it('resolves the PUBLIC key, and refuses a malformed one', () => {
    const { descriptor } = build();
    expect(descriptor.resolveSecret('discord')).toBe(PUBLIC_KEY_HEX);
    expect(descriptor.resolveSecret('nope')).toBeNull();
  });

  it('verifies through the descriptor with the real headers', () => {
    const { descriptor } = build();
    const b = body({ id: '1', type: 1 });
    expect(
      descriptor.verifySignature(
        req({ 'x-signature-ed25519': signBody(b), 'x-signature-timestamp': TIMESTAMP }),
        b,
        PUBLIC_KEY_HEX,
      ),
    ).toBe(true);
    expect(descriptor.verifySignature(req({}), b, PUBLIC_KEY_HEX)).toBe(false);
  });
});
