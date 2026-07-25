/** D-160 P0 -- external messenger channel, shared session continuity,
 *  and BYO Slack / Telegram ratchet.
 *
 *  Messenger tests use a fake Transport stub rather than real Slack or
 *  Telegram transports. The channel boundary is therefore deterministic
 *  and no test can hit the network.
 *
 *  Spec: docs/d-160-spec.md sections N.5 / N.6 / N.7 / A.5 + I-10.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createChatChannel,
  createInMemorySessionStore,
  type ChannelInbound,
  type ChannelOutbound,
  type SurfaceTag,
} from '@recued/chat';
import { createMessengerChannel } from '@recued/messenger';
import type {
  FetchedMedia,
  MediaRef,
  OutboundMessage,
  ParsedInbound,
  Transport,
  TransportSendResult,
  TransportVendor,
} from '@recued/transport';

interface FakeTransport {
  transport: Transport;
  sends: OutboundMessage[];
  parsedPayloads: unknown[];
  mediaFetches: Array<{ ref: MediaRef; token: string }>;
}

const fakeTransport = (
  vendor: TransportVendor,
  options: {
    sendResult?: TransportSendResult;
    parsed?: ParsedInbound | null | ((payload: unknown) => ParsedInbound | null);
    fetchMedia?: (ref: MediaRef, token: string) => Promise<FetchedMedia>;
  } = {},
): FakeTransport => {
  const sends: OutboundMessage[] = [];
  const parsedPayloads: unknown[] = [];
  const mediaFetches: Array<{ ref: MediaRef; token: string }> = [];
  const transport: Transport = {
    vendor,
    parseConversationId: () => null,
    async send(message) {
      sends.push(message);
      return options.sendResult ?? { ok: true, vendor_message_id: 'vendor-1' };
    },
    parseInbound(payload) {
      parsedPayloads.push(payload);
      if (typeof options.parsed === 'function') return options.parsed(payload);
      return options.parsed ?? null;
    },
    async fetchMedia(ref, token) {
      mediaFetches.push({ ref, token });
      if (options.fetchMedia) return options.fetchMedia(ref, token);
      return {
        temp_path: '/tmp/fake-media.bin',
        size: 5,
        head_bytes: Buffer.from('media'),
        filename: 'media.bin',
        mime_type: ref.mime,
      };
    },
  };
  return { transport, sends, parsedPayloads, mediaFetches };
};

const messageEvent = (
  overrides: Partial<Extract<ChannelOutbound, { kind: 'message' }>> = {},
): Extract<ChannelOutbound, { kind: 'message' }> => ({
  kind: 'message',
  session_id: 'session-1',
  turn_id: 'turn-1',
  text: 'assistant over messenger',
  ...overrides,
});

const messengerChannel = (
  fake: FakeTransport,
  options: {
    sessionId?: string;
    now?: () => number;
    store?: ReturnType<typeof createInMemorySessionStore>;
  } = {},
) =>
  createMessengerChannel({
    transport: fake.transport,
    sessionStore: options.store ?? createInMemorySessionStore(),
    token: 'byo-token',
    recipient: 'recipient-1',
    sessionId: options.sessionId ?? 'session-1',
    now: options.now ?? (() => 1716141000000),
  });

describe('D-160 P0 createMessengerChannel', () => {
  it.each([
    { vendor: 'slack', surface: 'messenger-slack' },
    { vendor: 'telegram', surface: 'messenger-telegram' },
  ] as const)('exposes $surface for a $vendor transport', (c) => {
    const fake = fakeTransport(c.vendor);
    const channel = messengerChannel(fake);

    expect(channel.surface).toBe(c.surface);
  });

  it.each([
    { vendor: 'slack', surface: 'messenger-slack' },
    { vendor: 'telegram', surface: 'messenger-telegram' },
  ] as const)(
    'deliver(message) sends through $vendor and stores one assistant $surface entry on success',
    async (c) => {
      const store = createInMemorySessionStore();
      const fake = fakeTransport(c.vendor);
      const channel = messengerChannel(fake, {
        store,
        now: () => 1716141000000,
      });

      await channel.deliver(messageEvent());

      expect(fake.sends).toEqual([
        {
          recipient: 'recipient-1',
          token: 'byo-token',
          text: 'assistant over messenger',
        },
      ]);
      expect(store.history('session-1')).toEqual([
        {
          session_id: 'session-1',
          surface: c.surface,
          role: 'assistant',
          text: 'assistant over messenger',
          ts: 1716141000000,
        },
      ]);
    },
  );

  it('deliver(message) does not append history when transport.send fails', async () => {
    const store = createInMemorySessionStore();
    const fake = fakeTransport('slack', {
      sendResult: {
        ok: false,
        error: { kind: 'rate_limited', detail: 'Slack: 429 Too Many Requests' },
      },
    });
    const channel = messengerChannel(fake, { store });

    await channel.deliver(messageEvent());

    expect(fake.sends).toEqual([
      {
        recipient: 'recipient-1',
        token: 'byo-token',
        text: 'assistant over messenger',
      },
    ]);
    expect(store.history('session-1')).toEqual([]);
  });

  it('deliver(message) drops events for a different session without send or append', async () => {
    const store = createInMemorySessionStore();
    const fake = fakeTransport('telegram');
    const channel = messengerChannel(fake, { store, sessionId: 'session-bound' });

    await channel.deliver(messageEvent({ session_id: 'session-other' }));

    expect(fake.sends).toEqual([]);
    expect(store.history('session-bound')).toEqual([]);
    expect(store.history('session-other')).toEqual([]);
  });

  it.each([
    {
      kind: 'token',
      event: {
        kind: 'token',
        session_id: 'session-1',
        turn_id: 'turn-1',
        delta: 'partial',
      } satisfies ChannelOutbound,
    },
    {
      kind: 'transparency',
      event: {
        kind: 'transparency',
        session_id: 'session-1',
        turn_id: 'turn-1',
        note: 'calling tool',
      } satisfies ChannelOutbound,
    },
    {
      kind: 'done',
      event: {
        kind: 'done',
        session_id: 'session-1',
        turn_id: 'turn-1',
      } satisfies ChannelOutbound,
    },
  ])('deliver($kind) is a no-op on messenger surfaces', async (c) => {
    const store = createInMemorySessionStore();
    const fake = fakeTransport('slack');
    const channel = messengerChannel(fake, { store });

    await channel.deliver(c.event);

    expect(fake.sends).toEqual([]);
    expect(store.history('session-1')).toEqual([]);
  });

  it.each([
    { vendor: 'slack', surface: 'messenger-slack' },
    { vendor: 'telegram', surface: 'messenger-telegram' },
  ] as const)(
    'ingest(payload) from $vendor appends a user entry and invokes the inbound handler',
    async (c) => {
      const store = createInMemorySessionStore();
      const inbound: ChannelInbound[] = [];
      const payload = { vendor: c.vendor, id: 1 };
      const fake = fakeTransport(c.vendor, {
        parsed: { from: 'sender-1', text: 'user over messenger', vendor_message_id: 'msg-1' },
      });
      const channel = messengerChannel(fake, {
        store,
        now: () => 1716141000000,
      });
      channel.onInbound((message) => {
        inbound.push(message);
      });

      await channel.ingest(payload);

      expect(fake.parsedPayloads).toEqual([payload]);
      expect(store.history('session-1')).toEqual([
        {
          session_id: 'session-1',
          surface: c.surface,
          role: 'user',
          text: 'user over messenger',
          ts: 1716141000000,
        },
      ]);
      expect(inbound).toEqual([
        {
          session_id: 'session-1',
          surface: c.surface,
          text: 'user over messenger',
          from: 'sender-1',
          source: {
            channel: 'messenger',
            actor: 'user_self',
            vendor: c.vendor,
            from: 'sender-1',
          },
          // D-160 P3 — a genuine inbound user message is top-level;
          // `ingest` defaults `dispatch_depth` to `0`.
          dispatch_depth: 0,
          ts: 1716141000000,
        },
      ]);
    },
  );

  it('ingest(payload) stores fetched media through the injected fileSink and forwards turn refs', async () => {
    const store = createInMemorySessionStore();
    const inbound: ChannelInbound[] = [];
    const sinkInputs: Array<{
      temp_path: string;
      head_bytes: Buffer;
      size: number;
      filename: string;
      mime_type: string;
      source_id: string;
    }> = [];
    const fake = fakeTransport('slack', {
      parsed: {
        from: 'sender-1',
        text: 'see this',
        vendor_message_id: 'msg-1',
        media: [
          {
            type: 'image',
            mime: 'image/png',
            size: 4,
            remote_id: 'F1',
          },
        ],
      },
      fetchMedia: async () => ({
        temp_path: '/tmp/image.png',
        size: 4,
        head_bytes: Buffer.from([1, 2, 3, 4]),
        filename: 'image.png',
        mime_type: 'image/png',
      }),
    });
    const channel = createMessengerChannel({
      transport: fake.transport,
      sessionStore: store,
      token: 'byo-token',
      recipient: 'recipient-1',
      sessionId: 'session-1',
      now: () => 1716141000000,
      fileSink: {
        async ingest(input) {
          sinkInputs.push(input);
          return { file_id: 'file-image-1', media_class: 'image' };
        },
      },
    });
    channel.onInbound((message) => {
      inbound.push(message);
    });

    await channel.ingest({ vendor: 'slack', id: 1 });

    expect(fake.mediaFetches).toEqual([
      {
        ref: { type: 'image', mime: 'image/png', size: 4, remote_id: 'F1' },
        token: 'byo-token',
      },
    ]);
    expect(sinkInputs).toEqual([
      {
        temp_path: '/tmp/image.png',
        size: 4,
        head_bytes: Buffer.from([1, 2, 3, 4]),
        filename: 'image.png',
        mime_type: 'image/png',
        source_id: 'msg-1:0',
      },
    ]);
    expect(store.history('session-1')[0]).toMatchObject({
      role: 'user',
      text: 'see this',
    });
    expect(inbound[0]).toMatchObject({
      text: 'see this',
      media: [{ file_id: 'file-image-1', media_class: 'image' }],
    });
  });

  it('ingest(payload) keeps media visible when fileSink is absent', async () => {
    const store = createInMemorySessionStore();
    const inbound: ChannelInbound[] = [];
    const fake = fakeTransport('telegram', {
      parsed: {
        from: 'sender-1',
        text: '',
        vendor_message_id: 'msg-1',
        media: [
          {
            type: 'voice',
            mime: 'audio/ogg',
            size: 12,
            remote_id: 'voice-1',
          },
        ],
      },
    });
    const channel = messengerChannel(fake, {
      store,
      now: () => 1716141000000,
    });
    channel.onInbound((message) => {
      inbound.push(message);
    });

    await channel.ingest({ vendor: 'telegram', id: 1 });

    expect(fake.mediaFetches).toEqual([]);
    expect(store.history('session-1')[0]?.text).toBe(
      '[voice received, but file ingest is not configured]',
    );
    expect(inbound[0]).toMatchObject({
      text: '[voice received, but file ingest is not configured]',
    });
    expect(inbound[0]?.media).toBeUndefined();
  });

  it('ingest(payload) is a no-op when the transport rejects the payload', async () => {
    const store = createInMemorySessionStore();
    const inbound: ChannelInbound[] = [];
    const fake = fakeTransport('slack', { parsed: null });
    const channel = messengerChannel(fake, { store });
    channel.onInbound((message) => {
      inbound.push(message);
    });

    await channel.ingest({ ignored: true });

    expect(fake.parsedPayloads).toEqual([{ ignored: true }]);
    expect(store.history('session-1')).toEqual([]);
    expect(inbound).toEqual([]);
  });
});

describe('D-160 P0 acceptance -- one conversation, two windows', () => {
  it('chat and messenger share one session store while retaining surface tags', async () => {
    const store = createInMemorySessionStore();
    const timestamps = [1000, 1001, 1002, 1003];
    const now = (): number => {
      const next = timestamps.shift();
      if (next === undefined) throw new Error('unexpected clock read');
      return next;
    };
    const chat = createChatChannel({
      sink: () => undefined,
      sessionStore: store,
      userId: 'user-1',
      now,
    });
    const messengerTransport = fakeTransport('slack', {
      parsed: { from: 'U-slack', text: 'user from Slack' },
    });
    const messenger = createMessengerChannel({
      transport: messengerTransport.transport,
      sessionStore: store,
      token: 'xoxb-user-token',
      recipient: 'C123',
      sessionId: 'shared-session',
      now,
    });

    await chat.deliver(
      messageEvent({
        session_id: 'shared-session',
        text: 'assistant in chat',
      }),
    );
    await messenger.deliver(
      messageEvent({
        session_id: 'shared-session',
        text: 'assistant in Slack',
      }),
    );
    await chat.receiveUserMessage({
      session_id: 'shared-session',
      text: 'user in chat',
    });
    await messenger.ingest({ type: 'slack-payload' });

    expect(store.history('shared-session')).toEqual([
      {
        session_id: 'shared-session',
        surface: 'chat',
        role: 'assistant',
        text: 'assistant in chat',
        ts: 1000,
      },
      {
        session_id: 'shared-session',
        surface: 'messenger-slack',
        role: 'assistant',
        text: 'assistant in Slack',
        ts: 1001,
      },
      {
        session_id: 'shared-session',
        surface: 'chat',
        role: 'user',
        text: 'user in chat',
        ts: 1002,
      },
      {
        session_id: 'shared-session',
        surface: 'messenger-slack',
        role: 'user',
        text: 'user from Slack',
        ts: 1003,
      },
    ]);
    expect(store.history('shared-session').map((entry) => entry.surface)).toEqual([
      'chat',
      'messenger-slack',
      'chat',
      'messenger-slack',
    ] satisfies SurfaceTag[]);
  });
});

const REPO = resolve(__dirname, '..', '..', '..', '..');
const PACKAGES = resolve(REPO, 'packages');
const SCAN_ROOTS = [
  join(PACKAGES, 'transport', 'src'),
  join(PACKAGES, 'chat', 'src'),
  join(PACKAGES, 'messenger', 'src'),
];
const FORBIDDEN = [
  'apps.create',
  'oauth.v2.access',
  'client_secret',
  'client_id',
  'setWebhook',
];

const collectSourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...collectSourceFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
};

const repoPath = (path: string): string => path.slice(REPO.length + 1);

const forbiddenTokens = (text: string): string[] => {
  const lower = text.toLowerCase();
  return FORBIDDEN.filter((token) => lower.includes(token.toLowerCase()));
};

describe('D-160 I-10 ratchet -- Slack / Telegram stay BYO leaf transports', () => {
  it('scopes the structural scan to exactly transport, chat, and messenger source', () => {
    expect(SCAN_ROOTS.map(repoPath)).toEqual([
      'packages/transport/src',
      'packages/chat/src',
      'packages/messenger/src',
    ]);
    expect(SCAN_ROOTS.flatMap(collectSourceFiles).map(repoPath).sort()).toEqual([
      'packages/chat/src/channel.ts',
      'packages/chat/src/chat-channel.ts',
      'packages/chat/src/index.ts',
      'packages/chat/src/session-store.ts',
      'packages/messenger/src/index.ts',
      'packages/messenger/src/messenger-channel.ts',
      'packages/transport/src/callback.ts',
      'packages/transport/src/discord.ts',
      'packages/transport/src/http.ts',
      'packages/transport/src/index.ts',
      'packages/transport/src/slack-users.ts',
      'packages/transport/src/slack.ts',
      'packages/transport/src/telegram.ts',
      'packages/transport/src/types.ts',
      // D-192 make-live — the third BYO leaf transport. Listed, not derived, on
      // purpose: this ratchet exists to notice when a FILE appears in the scanned
      // packages, so that its contents get swept for the forbidden tokens (an app
      // registration / setup wizard). A derived list would scan the new file but
      // stop anyone from ever having to look at it.
      'packages/transport/src/whatsapp.ts',
    ]);
  });

  it('finds no Slack/Telegram app-registration or OAuth-client surface in P0 leaf source', () => {
    const offenders = SCAN_ROOTS.flatMap(collectSourceFiles)
      .map((file) => ({
        file,
        tokens: forbiddenTokens(readFileSync(file, 'utf8')),
      }))
      .filter((result) => result.tokens.length > 0)
      .map((result) => `${repoPath(result.file)}: ${result.tokens.join(', ')}`);

    expect(offenders).toEqual([]);
  });

  it('synthetic regression -- the scanner catches app setup and OAuth tokens', () => {
    expect(
      forbiddenTokens(`
        await slack.apps.create({});
        await slack.oauth.v2.access({ client_id, client_secret });
        await telegram.setWebhook(url);
      `),
    ).toEqual([
      'apps.create',
      'oauth.v2.access',
      'client_secret',
      'client_id',
      'setWebhook',
    ]);
    expect(forbiddenTokens('connection.notification BYO token transport')).toEqual([]);
  });
});
