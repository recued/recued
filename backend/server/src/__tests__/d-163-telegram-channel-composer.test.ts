/** D-163 Telegram-adapter — composeTelegramChannel unit tests.
 *
 *  Parallel to `d-163-slack-channel-composer.test.ts`. Exercises the
 *  credential-resolver edges via stubbed fetchImpl: when
 *  resolveCredential returns null the channel's `credentialOrThrow`
 *  fires before any network call, so a zero-fetch outcome on
 *  `deliverNotify` is the assertion handle. When resolveCredential
 *  returns a credential, fetch is invoked once with the resolved bearer
 *  + recipient — both observable from the stub's call args.
 *
 *  The Telegram-specific shape difference from Slack: chat_id may be
 *  numeric (private chats / channels) or `@channelname` strings (public
 *  channels). The numeric branch is covered explicitly. */

import type { ConnectionRow } from '@recued/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  composeTelegramChannel,
  type ComposeTelegramChannelDeps,
} from '../composition/bin/wire-telegram-channel.js';
import {
  buildConnectionRow,
  stubConnectionStore,
  stubFetch,
  stubKeyManager,
  type StubKeyManager,
} from './d-163-remote-channel-test-helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

/** Telegram-flavored connection row — overrides default `name: 'slack'`
 *  on the shared helper. */
const buildTelegramRow = (overrides: {
  auth: Parameters<typeof buildConnectionRow>[0]['auth'];
  config: Record<string, unknown>;
}): ConnectionRow =>
  buildConnectionRow({
    auth: overrides.auth,
    config: overrides.config,
    name: 'telegram',
  });

/** Telegram-flavored fetch stub default — `sendMessage` happy-path
 *  envelope. */
const telegramFetch = () => stubFetch({ ok: true, result: { message_id: 42 } });

const composeHarness = (overrides: Partial<ComposeTelegramChannelDeps> & {
  row?: ConnectionRow | null;
} = {}): {
  channel: ReturnType<typeof composeTelegramChannel>;
  fetch: ReturnType<typeof telegramFetch>;
  keys?: StubKeyManager;
} => {
  const fetchStub = telegramFetch();
  const deps: ComposeTelegramChannelDeps = {
    connectionStore: stubConnectionStore(
      overrides.row !== undefined
        ? overrides.row
        : buildTelegramRow({
            auth: { type: 'bearer', token: '12345:secret-bot-token' },
            config: { chat_id: '@my_channel' },
          }),
    ),
    fetchImpl: fetchStub,
    ...(overrides.keys ? { keys: overrides.keys } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  };
  const channel = composeTelegramChannel(deps);
  return {
    channel,
    fetch: fetchStub,
    ...(overrides.keys ? { keys: overrides.keys as StubKeyManager } : {}),
  };
};

describe('composeTelegramChannel — channel identity', () => {
  it("returns a RemoteChannel with name='telegram' and capability='inline'", () => {
    const { channel } = composeHarness();
    expect(channel.name).toBe('telegram');
    expect(channel.capability).toBe('inline');
  });

  it('exposes parseInboundReply for the future inbound-interactivity wiring', () => {
    const { channel } = composeHarness();
    expect(typeof channel.parseInboundReply).toBe('function');
    // Garbage payload → null (mirrors the Telegram transport contract).
    expect(channel.parseInboundReply({ random: true })).toBeNull();
  });
});

describe('composeTelegramChannel — happy path', () => {
  it("posts to Telegram with the row's bearer + chat_id on deliverNotify (string @channel)", async () => {
    const { channel, fetch } = composeHarness();
    await channel.deliverNotify({ text: 'hello' });
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0]!;
    // Telegram Bot API URL — token rides the path.
    expect(call.url).toBe('https://api.telegram.org/bot12345:secret-bot-token/sendMessage');
    const body = JSON.parse(String(call.init.body)) as {
      chat_id: string;
      text: string;
    };
    expect(body.chat_id).toBe('@my_channel');
    expect(body.text).toBe('hello');
  });

  it('coerces a numeric chat_id to string for the transport recipient', async () => {
    const { channel, fetch } = composeHarness({
      row: buildTelegramRow({
        auth: { type: 'bearer', token: '12345:secret-bot-token' },
        config: { chat_id: -1001234567890 }, // supergroup-form chat_id
      }),
    });
    await channel.deliverNotify({ text: 'hi' });
    expect(fetch.calls).toHaveLength(1);
    const body = JSON.parse(String(fetch.calls[0]!.init.body)) as { chat_id: string };
    expect(body.chat_id).toBe('-1001234567890');
  });
});

describe('composeTelegramChannel — credential null branches (no fetch fires)', () => {
  it('throws + skips fetch when no connection row enrolled', async () => {
    const { channel, fetch } = composeHarness({ row: null });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow(
      /no connection\.notification credential enrolled/,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when auth.type is not bearer', async () => {
    const { channel, fetch } = composeHarness({
      row: buildTelegramRow({
        auth: { type: 'none' },
        config: { chat_id: '@my_channel' },
      }),
    });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when bearer token is empty', async () => {
    const { channel, fetch } = composeHarness({
      row: buildTelegramRow({
        auth: { type: 'bearer', token: '' },
        config: { chat_id: '@my_channel' },
      }),
    });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when chat_id missing from config', async () => {
    const { channel, fetch } = composeHarness({
      row: buildTelegramRow({
        auth: { type: 'bearer', token: '12345:secret-bot-token' },
        config: { other_field: 'x' },
      }),
    });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when chat_id is empty string', async () => {
    const { channel, fetch } = composeHarness({
      row: buildTelegramRow({
        auth: { type: 'bearer', token: '12345:secret-bot-token' },
        config: { chat_id: '' },
      }),
    });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when chat_id is non-finite number (NaN)', async () => {
    const { channel, fetch } = composeHarness({
      row: buildTelegramRow({
        auth: { type: 'bearer', token: '12345:secret-bot-token' },
        config: { chat_id: Number.NaN },
      }),
    });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when chat_id is neither string nor number (e.g. array)', async () => {
    const { channel, fetch } = composeHarness({
      row: buildTelegramRow({
        auth: { type: 'bearer', token: '12345:secret-bot-token' },
        config: { chat_id: [1, 2, 3] },
      }),
    });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when config_json is malformed', async () => {
    const row = buildTelegramRow({
      auth: { type: 'bearer', token: '12345:secret-bot-token' },
      config: { chat_id: '@my_channel' },
    });
    (row as { config_json: string }).config_json = '{ not valid json';
    const { channel, fetch } = composeHarness({ row });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when config_json parses to a non-object (e.g. array)', async () => {
    const row = buildTelegramRow({
      auth: { type: 'bearer', token: '12345:secret-bot-token' },
      config: { chat_id: '@my_channel' },
    });
    (row as { config_json: string }).config_json = JSON.stringify(['array']);
    const { channel, fetch } = composeHarness({ row });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('composeTelegramChannel — KeyManager integration', () => {
  it('passes no key provider when keys are uninitialized (plaintext branch)', async () => {
    const keys = stubKeyManager('uninitialized');
    const { channel, fetch } = composeHarness({ keys });
    await channel.deliverNotify({ text: 'ping' });
    expect(fetch.calls).toHaveLength(1);
    // `keyProvider('connection')` should NOT have been requested at
    // resolve time when state is 'uninitialized'.
    expect(keys.keyProvider).not.toHaveBeenCalled();
  });

  it('re-reads keys.state() on every dispatch (transparent unlock invariant)', async () => {
    const keys = stubKeyManager('uninitialized');
    const stateSpy = vi.spyOn(keys, 'state');
    const { channel } = composeHarness({ keys });

    // First dispatch — plaintext branch (state === 'uninitialized').
    await channel.deliverNotify({ text: 'first' });
    const callsAfterFirst = stateSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(keys.keyProvider).not.toHaveBeenCalled();

    // KeyManager transitions to a state that exercises the keyProvider
    // branch. The composer holds `deps.keys` by reference (no compose-
    // time snapshot), so the next resolveCredential call sees the new
    // state. A real AEAD round-trip would need a real sub-DEK; we only
    // assert the re-read happens — the keyProvider is requested, which
    // is the observable invariant. The dispatch may throw (stubbed
    // keyProvider returns null) — catch it to keep the test focused
    // on the re-read.
    keys.setState('unlocked');
    await channel.deliverNotify({ text: 'second' }).catch(() => undefined);
    expect(stateSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(keys.keyProvider).toHaveBeenCalledWith('connection');
  });

  it('skips keyProvider lookup entirely when no KeyManager is wired', async () => {
    // No `keys` passed at all — plaintext branch is the only option.
    const { channel, fetch } = composeHarness();
    await channel.deliverNotify({ text: 'ping' });
    expect(fetch.calls).toHaveLength(1);
  });
});
