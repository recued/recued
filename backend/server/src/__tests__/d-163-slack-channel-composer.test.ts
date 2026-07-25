/** D-163 Slack-adapter — composeSlackChannel unit tests.
 *
 *  Exercises the credential-resolver edges via stubbed fetchImpl: when
 *  resolveCredential returns null, the channel's built-in
 *  `credentialOrThrow` fires before any network call, so a zero-fetch
 *  outcome on `deliverNotify` is the assertion handle. When resolve-
 *  Credential returns a credential, fetch is invoked once with the
 *  resolved bearer + recipient — those are observable from the stub's
 *  call args.
 *
 *  Shared fixture builders (`buildConnectionRow`, `stubConnectionStore`,
 *  `stubKeyManager`, `stubFetch`) live in
 *  `d-163-remote-channel-test-helpers.ts` — the consolidation slice
 *  extracted them once `composeTelegramChannel` shipped its
 *  near-identical copies. */

import type { ConnectionRow } from '@recued/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  composeSlackChannel,
  type ComposeSlackChannelDeps,
} from '../composition/bin/wire-slack-channel.js';
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

/** Slack-flavored connection row — `name: 'slack'` defaults match the
 *  shared helper. */
const buildSlackRow = (overrides: {
  auth: Parameters<typeof buildConnectionRow>[0]['auth'];
  config: Record<string, unknown>;
}): ConnectionRow =>
  buildConnectionRow({
    auth: overrides.auth,
    config: overrides.config,
    name: 'slack',
  });

/** Slack-flavored fetch stub default — `chat.postMessage` happy-path
 *  envelope. */
const slackFetch = () => stubFetch({ ok: true, ts: '1700000000.000100' });

const composeHarness = (overrides: Partial<ComposeSlackChannelDeps> & {
  row?: ConnectionRow | null;
} = {}): {
  channel: ReturnType<typeof composeSlackChannel>;
  fetch: ReturnType<typeof slackFetch>;
  keys?: StubKeyManager;
} => {
  const fetchStub = slackFetch();
  const deps: ComposeSlackChannelDeps = {
    connectionStore: stubConnectionStore(
      overrides.row !== undefined
        ? overrides.row
        : buildSlackRow({
            auth: { type: 'bearer', token: 'xoxb-test' },
            config: { channel_id: 'C123' },
          }),
    ),
    fetchImpl: fetchStub,
    ...(overrides.keys ? { keys: overrides.keys } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  };
  const channel = composeSlackChannel(deps);
  return {
    channel,
    fetch: fetchStub,
    ...(overrides.keys ? { keys: overrides.keys as StubKeyManager } : {}),
  };
};

describe('composeSlackChannel — channel identity', () => {
  it("returns a RemoteChannel with name='slack' and capability='inline'", () => {
    const { channel } = composeHarness();
    expect(channel.name).toBe('slack');
    expect(channel.capability).toBe('inline');
  });

  it('exposes parseInboundReply for the future inbound-interactivity wiring', () => {
    const { channel } = composeHarness();
    expect(typeof channel.parseInboundReply).toBe('function');
    // Garbage payload → null (mirrors the Slack transport contract).
    expect(channel.parseInboundReply({ random: true })).toBeNull();
  });
});

describe('composeSlackChannel — happy path', () => {
  it("posts to Slack with the row's bearer + channel_id on deliverNotify", async () => {
    const { channel, fetch } = composeHarness();
    await channel.deliverNotify({ text: 'hello' });
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0]!;
    expect(call.url).toBe('https://slack.com/api/chat.postMessage');
    expect(call.init.headers).toMatchObject({
      Authorization: 'Bearer xoxb-test',
    });
    const body = JSON.parse(String(call.init.body)) as { channel: string };
    expect(body.channel).toBe('C123');
  });
});

describe('composeSlackChannel — credential null branches (no fetch fires)', () => {
  it('throws + skips fetch when no connection row enrolled', async () => {
    const { channel, fetch } = composeHarness({ row: null });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow(
      /no connection\.notification credential enrolled/,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when auth.type is not bearer', async () => {
    const { channel, fetch } = composeHarness({
      row: buildSlackRow({
        auth: { type: 'none' },
        config: { channel_id: 'C123' },
      }),
    });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when bearer token is empty', async () => {
    const { channel, fetch } = composeHarness({
      row: buildSlackRow({
        auth: { type: 'bearer', token: '' },
        config: { channel_id: 'C123' },
      }),
    });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when channel_id missing from config', async () => {
    const { channel, fetch } = composeHarness({
      row: buildSlackRow({
        auth: { type: 'bearer', token: 'xoxb-test' },
        config: { other_field: 'x' },
      }),
    });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when channel_id is empty string', async () => {
    const { channel, fetch } = composeHarness({
      row: buildSlackRow({
        auth: { type: 'bearer', token: 'xoxb-test' },
        config: { channel_id: '' },
      }),
    });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when channel_id is not a string', async () => {
    const { channel, fetch } = composeHarness({
      row: buildSlackRow({
        auth: { type: 'bearer', token: 'xoxb-test' },
        config: { channel_id: 12345 },
      }),
    });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when config_json is malformed', async () => {
    // Build a row directly with broken config_json — `buildSlackRow` always
    // JSON.stringify's, so reach in and clobber.
    const row = buildSlackRow({
      auth: { type: 'bearer', token: 'xoxb-test' },
      config: { channel_id: 'C123' },
    });
    (row as { config_json: string }).config_json = '{ not valid json';
    const { channel, fetch } = composeHarness({ row });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });

  it('throws + skips fetch when config_json parses to a non-object (e.g. array)', async () => {
    const row = buildSlackRow({
      auth: { type: 'bearer', token: 'xoxb-test' },
      config: { channel_id: 'C123' },
    });
    (row as { config_json: string }).config_json = JSON.stringify(['array']);
    const { channel, fetch } = composeHarness({ row });
    await expect(channel.deliverNotify({ text: 'ping' })).rejects.toThrow();
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('composeSlackChannel — KeyManager integration', () => {
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

    // KeyManager transitions to a state that exercises the
    // keyProvider branch. The composer holds `deps.keys` by reference
    // (no compose-time snapshot), so the next resolveCredential call
    // sees the new state. A real AEAD round-trip would need a real
    // sub-DEK; we only assert the re-read happens — the keyProvider
    // is requested, which is the observable invariant. The actual
    // dispatch may throw (stubbed keyProvider returns null) — that's
    // fine, we catch it to keep the test focused on the re-read.
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
