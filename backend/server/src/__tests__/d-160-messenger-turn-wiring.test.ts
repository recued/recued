/** D-160 A.8 step 6 - messenger transport turn wiring tests.
 *
 *  Pins the downstream consumer in `composeMessengerTurnIngest`: verified
 *  Slack/Telegram user-message payloads are parsed by the real transports,
 *  authorized against the canonical `connection.notification.<vendor>` row,
 *  bound to one configured conversation, enqueued onto a per-vendor FIFO,
 *  re-gated at run time, driven through `orchestrator.runMessengerTurn`, and
 *  delivered back over the same transport without holding the webhook open.
 *
 *  Also pins the dispatcher seam in `composeInboundAnswerDispatcher`: a
 *  non-callback user message is offered to `messengerTurnIngest` alongside
 *  the WatchSource warehouse event, while ask callbacks remain exclusively
 *  routed to `block.submitAnswer` and ingest failures are contained.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createInMemorySessionStore,
  type ChannelInbound,
  type SessionStateStore,
  type SurfaceTag,
} from '@recued/chat';
import type {
  ConnectionAuth,
  ConnectionKind,
  ConnectionRow,
} from '@recued/contracts';
import type {
  NotificationBlock,
  RemoteChannel,
} from '@recued/notification';
import type { ParsedInbound } from '@recued/transport';
import type {
  WarehouseEvent,
  WarehouseEventBus,
} from '@recued/warehouse-events';

import {
  composeMessengerTurnIngest,
  messengerSessionId,
  type ComposeMessengerTurnIngestDeps,
  type MessengerTurnIngest,
} from '../composition/bin/wire-messenger-turn.js';
import { composeInboundAnswerDispatcher } from '../composition/bin/wire-inbound-answer-dispatcher.js';
import type { SlackInboundEvent } from '../connections/providers/slack-provider.js';
import type { TelegramInboundUpdate } from '../connections/providers/telegram-provider.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import {
  buildConnectionRow,
  encodePlaintextAuth,
  stubConnectionStore,
} from './d-163-remote-channel-test-helpers.js';

const NOW = Date.UTC(2031, 0, 2, 3, 4, 5);
const SLACK_TOKEN = 'xoxb-slack-row-token';
const TELEGRAM_TOKEN = '123:telegram-row-token';

type FetchImpl = NonNullable<ComposeMessengerTurnIngestDeps['fetchImpl']>;
type LogFn = NonNullable<ComposeMessengerTurnIngestDeps['log']>;
type LogLevel = Parameters<LogFn>[0];
type Orchestrator = NonNullable<ComposeMessengerTurnIngestDeps['orchestrator']>;
type RunMessengerTurn = Orchestrator['runMessengerTurn'];
type RunMessengerTurnInput = Parameters<RunMessengerTurn>[0];
type RunMessengerTurnMock = ReturnType<typeof vi.fn<RunMessengerTurn>>;
type FetchMock = ReturnType<typeof jsonFetch>;

interface LogEntry {
  level: LogLevel;
  msg: string;
  data: Record<string, unknown> | undefined;
}

const captureLogs = (): { log: LogFn; entries: LogEntry[] } => {
  const entries: LogEntry[] = [];
  return {
    entries,
    log: (level, msg, data) => {
      entries.push({ level, msg, data });
    },
  };
};

const bearerAuth = (token: string): ConnectionAuth => ({ type: 'bearer', token });

const connectionRow = (
  vendor: 'slack' | 'telegram',
  config: Record<string, unknown>,
  token = vendor === 'slack' ? SLACK_TOKEN : TELEGRAM_TOKEN,
): ConnectionRow => {
  const auth = bearerAuth(token);
  return {
    ...buildConnectionRow({
      name: vendor,
      auth,
      config,
    }),
    auth_ciphertext: encodePlaintextAuth(auth),
  };
};

const slackRow = (
  config: Record<string, unknown> = { channel_id: 'C123' },
): ConnectionRow => connectionRow('slack', config, SLACK_TOKEN);

const telegramRow = (
  config: Record<string, unknown> = { chat_id: 99 },
): ConnectionRow => connectionRow('telegram', config, TELEGRAM_TOKEN);

const sequenceConnectionStore = (
  rows: readonly (ConnectionRow | null)[],
): {
  store: ConnectionStoreSqlite;
  get: ReturnType<typeof vi.fn<(kind: ConnectionKind, name: string) => ConnectionRow | null>>;
} => {
  let idx = 0;
  const get = vi.fn((kind: ConnectionKind, name: string): ConnectionRow | null => {
    const row = rows[Math.min(idx, rows.length - 1)] ?? null;
    idx += 1;
    return row !== null && row.kind === kind && row.name === name ? row : null;
  });
  return {
    get,
    store: ({ get } as unknown) as ConnectionStoreSqlite,
  };
};

const jsonFetch = (body: Record<string, unknown>) =>
  vi.fn(async (
    _input: Parameters<FetchImpl>[0],
    _init?: Parameters<FetchImpl>[1],
  ): ReturnType<FetchImpl> =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

const slackFetch = (): FetchMock => jsonFetch({ ok: true });
const telegramFetch = (): FetchMock =>
  jsonFetch({ ok: true, result: { message_id: 1 } });

const singleFetchCall = (
  fetchImpl: FetchMock,
): { url: string; init: RequestInit } => {
  const call = fetchImpl.mock.calls[0];
  if (call === undefined) throw new Error('expected one fetch call');
  const [input, init = {}] = call;
  return { url: String(input), init };
};

const requestJsonBody = (init: RequestInit): Record<string, unknown> => {
  if (typeof init.body !== 'string') {
    throw new Error('expected string JSON request body');
  }
  const parsed: unknown = JSON.parse(init.body);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected object JSON request body');
  }
  return parsed as Record<string, unknown>;
};

interface OrchestratorHarness {
  orchestrator: Orchestrator;
  runMessengerTurn: RunMessengerTurnMock;
  sessionStore: SessionStateStore;
}

const makeOrchestrator = (
  runMessengerTurnImpl?: RunMessengerTurn,
): OrchestratorHarness => {
  const sessionStore = createInMemorySessionStore();
  const runMessengerTurn = vi.fn<RunMessengerTurn>(
    runMessengerTurnImpl
      ?? (async (input) => {
        await input.channel.deliver({
          kind: 'message',
          session_id: input.inbound.session_id,
          turn_id: 't1',
          text: 'reply',
        });
        return { turn_id: 't1' };
      }),
  );
  const runTurn = vi.fn<Orchestrator['runTurn']>(async () => ({ turn_id: 'chat-t1' }));
  const dispatchTool = vi.fn(async () => ({ ok: true, result: {} }) as const);
  return {
    sessionStore,
    runMessengerTurn,
    orchestrator: ({
      runTurn,
      runMessengerTurn,
      sessionStore,
      dispatch: { dispatchTool },
    } as unknown) as Orchestrator,
  };
};

const composeIngest = (deps: {
  row?: ConnectionRow | null;
  store?: ConnectionStoreSqlite;
  fetchImpl?: FetchMock;
  runMessengerTurnImpl?: RunMessengerTurn;
  log?: LogFn;
  fileCollection?: ComposeMessengerTurnIngestDeps['fileCollection'];
} = {}): {
  ingest: MessengerTurnIngest;
  runMessengerTurn: RunMessengerTurnMock;
  sessionStore: SessionStateStore;
  fetchImpl: FetchMock;
} => {
  const { orchestrator, runMessengerTurn, sessionStore } = makeOrchestrator(
    deps.runMessengerTurnImpl,
  );
  const fetchImpl = deps.fetchImpl ?? slackFetch();
  const ingest = composeMessengerTurnIngest({
    orchestrator,
    connectionStore:
      deps.store ?? stubConnectionStore(deps.row === undefined ? slackRow() : deps.row),
    fetchImpl,
    now: () => NOW,
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.fileCollection ? { fileCollection: deps.fileCollection } : {}),
  });
  if (ingest === undefined) throw new Error('expected messenger ingest to compose');
  return { ingest, runMessengerTurn, sessionStore, fetchImpl };
};

const slackMessagePayload = (opts: {
  text?: string;
  channel?: string;
  user?: string;
  ts?: string;
  bot_id?: string;
} = {}): unknown => {
  const event: Record<string, unknown> = {
    type: 'message',
    user: opts.user ?? 'U1',
    text: opts.text ?? 'hi',
    ts: opts.ts ?? '1730000000.000100',
  };
  if (opts.channel !== undefined) event.channel = opts.channel;
  if (opts.bot_id !== undefined) event.bot_id = opts.bot_id;
  return {
    type: 'event_callback',
    event,
  };
};

const telegramMessagePayload = (opts: {
  text?: string;
  chatId?: number | string;
  fromId?: number | string;
  isBot?: boolean;
  includeChat?: boolean;
} = {}): unknown => {
  const message: Record<string, unknown> = {
    message_id: 7,
    text: opts.text ?? 'hi',
    from: {
      id: opts.fromId ?? 99,
      is_bot: opts.isBot ?? false,
    },
  };
  if (opts.includeChat !== false) {
    message.chat = { id: opts.chatId ?? 99 };
  }
  return {
    update_id: 1,
    message,
  };
};

const slackUrlVerificationPayload = (): unknown => ({
  type: 'url_verification',
  challenge: 'challenge',
});

const telegramCallbackOnlyPayload = (): unknown => ({
  update_id: 1,
  callback_query: {
    id: 'cb-1',
    data: 'ask-1|approve',
    from: { id: 99, is_bot: false },
  },
});

const firstRunInput = (runMessengerTurn: RunMessengerTurnMock): RunMessengerTurnInput => {
  const call = runMessengerTurn.mock.calls[0];
  if (call === undefined) throw new Error('expected runMessengerTurn call');
  return call[0];
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const makeWarehouseBus = (): {
  bus: WarehouseEventBus;
  events: WarehouseEvent[];
} => {
  const events: WarehouseEvent[] = [];
  return {
    events,
    bus: {
      emit(event) {
        events.push(event);
      },
      subscribe() {
        return () => undefined;
      },
      dispose() {},
    },
  };
};

const remoteChannel = (opts: {
  reply?: ReturnType<RemoteChannel['parseInboundReply']>;
  message?: ParsedInbound | null;
} = {}): RemoteChannel & {
  parseInboundReply: ReturnType<typeof vi.fn<RemoteChannel['parseInboundReply']>>;
  parseInboundMessage: ReturnType<typeof vi.fn<RemoteChannel['parseInboundMessage']>>;
} =>
  ({
    name: 'slack',
    capability: 'inline',
    owns_llm_egress: false,
    parseInboundReply: vi.fn<RemoteChannel['parseInboundReply']>(
      () => opts.reply ?? null,
    ),
    parseInboundMessage: vi.fn<RemoteChannel['parseInboundMessage']>(
      () => opts.message ?? null,
    ),
    deliverNotify: vi.fn(),
    deliverAsk: vi.fn(),
    closeAsk: vi.fn(),
  } as unknown) as RemoteChannel & {
    parseInboundReply: ReturnType<typeof vi.fn<RemoteChannel['parseInboundReply']>>;
    parseInboundMessage: ReturnType<typeof vi.fn<RemoteChannel['parseInboundMessage']>>;
  };

const stubBlock = (): NotificationBlock =>
  ({
    submitAnswer: vi.fn(async () => undefined),
  } as unknown) as NotificationBlock;

const slackInboundEvent = (
  payload: unknown,
  connection_name = 'slack',
): SlackInboundEvent => ({
  connection_name,
  type: 'event_callback',
  event_id: 'Ev-1',
  team_id: 'T-1',
  payload,
  headers: {},
});

const telegramInboundUpdate = (
  payload: unknown,
  connection_name = 'telegram',
): TelegramInboundUpdate => ({
  connection_name,
  update_id: '1',
  payload,
  headers: {},
});

describe('D-160 messenger turn composer - composition gates', () => {
  it('returns undefined when orchestrator or connectionStore is absent', () => {
    const { orchestrator } = makeOrchestrator();

    expect(
      composeMessengerTurnIngest({
        connectionStore: stubConnectionStore(slackRow()),
      }),
    ).toBeUndefined();
    expect(
      composeMessengerTurnIngest({
        orchestrator,
      }),
    ).toBeUndefined();
  });

  it('skips alternate-named Slack rows before queueing a turn', async () => {
    const { ingest, runMessengerTurn, fetchImpl } = composeIngest({
      row: slackRow(),
    });

    await expect(
      ingest('slack', 'slack-prod', slackMessagePayload({ channel: 'C123' })),
    ).resolves.toBe(false);

    expect(runMessengerTurn).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('D-160 messenger turn composer - parse and binding gates', () => {
  it('drops non-user-message Slack and Telegram payloads', async () => {
    const slack = composeIngest({ row: slackRow() });
    const telegram = composeIngest({
      row: telegramRow(),
      fetchImpl: telegramFetch(),
    });
    const slackBot = composeIngest({ row: slackRow() });

    await expect(slack.ingest('slack', 'slack', slackUrlVerificationPayload()))
      .resolves.toBe(false);
    await expect(
      telegram.ingest('telegram', 'telegram', telegramCallbackOnlyPayload()),
    ).resolves.toBe(false);
    await expect(
      slackBot.ingest(
        'slack',
        'slack',
        slackMessagePayload({ channel: 'C123', bot_id: 'B1' }),
      ),
    ).resolves.toBe(false);

    expect(slack.runMessengerTurn).not.toHaveBeenCalled();
    expect(telegram.runMessengerTurn).not.toHaveBeenCalled();
    expect(slackBot.runMessengerTurn).not.toHaveBeenCalled();
    expect(slack.fetchImpl).not.toHaveBeenCalled();
    expect(telegram.fetchImpl).not.toHaveBeenCalled();
    expect(slackBot.fetchImpl).not.toHaveBeenCalled();
  });

  it('returns false and logs info when no connection row or recipient is enrolled', async () => {
    const noRowLogs = captureLogs();
    const noRecipientLogs = captureLogs();
    const noRow = composeIngest({
      row: null,
      log: noRowLogs.log,
    });
    const noRecipient = composeIngest({
      row: slackRow({}),
      log: noRecipientLogs.log,
    });

    await expect(
      noRow.ingest('slack', 'slack', slackMessagePayload({ channel: 'C123' })),
    ).resolves.toBe(false);
    await expect(
      noRecipient.ingest(
        'slack',
        'slack',
        slackMessagePayload({ channel: 'C123' }),
      ),
    ).resolves.toBe(false);

    expect(noRow.runMessengerTurn).not.toHaveBeenCalled();
    expect(noRecipient.runMessengerTurn).not.toHaveBeenCalled();
    expect(noRow.fetchImpl).not.toHaveBeenCalled();
    expect(noRecipient.fetchImpl).not.toHaveBeenCalled();
    expect(noRowLogs.entries).toContainEqual(
      expect.objectContaining({
        level: 'info',
        msg: expect.stringContaining('no credential / recipient enrolled'),
      }),
    );
    expect(noRecipientLogs.entries).toContainEqual(
      expect.objectContaining({
        level: 'info',
        msg: expect.stringContaining('no credential / recipient enrolled'),
      }),
    );
  });

  it('refuses messages outside or missing the bound conversation', async () => {
    const slackLogs = captureLogs();
    const telegramLogs = captureLogs();
    const missingLogs = captureLogs();
    const slack = composeIngest({
      row: slackRow({ channel_id: 'C123' }),
      log: slackLogs.log,
    });
    const telegram = composeIngest({
      row: telegramRow({ chat_id: 99 }),
      fetchImpl: telegramFetch(),
      log: telegramLogs.log,
    });
    const missing = composeIngest({
      row: slackRow({ channel_id: 'C123' }),
      log: missingLogs.log,
    });

    await expect(
      slack.ingest('slack', 'slack', slackMessagePayload({ channel: 'C999' })),
    ).resolves.toBe(false);
    await expect(
      telegram.ingest(
        'telegram',
        'telegram',
        telegramMessagePayload({ chatId: 100 }),
      ),
    ).resolves.toBe(false);
    await expect(
      missing.ingest('slack', 'slack', slackMessagePayload()),
    ).resolves.toBe(false);

    expect(slack.runMessengerTurn).not.toHaveBeenCalled();
    expect(telegram.runMessengerTurn).not.toHaveBeenCalled();
    expect(missing.runMessengerTurn).not.toHaveBeenCalled();
    expect(slack.fetchImpl).not.toHaveBeenCalled();
    expect(telegram.fetchImpl).not.toHaveBeenCalled();
    expect(missing.fetchImpl).not.toHaveBeenCalled();
    expect(slackLogs.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: expect.stringContaining('message outside the bound conversation'),
      }),
    );
    expect(telegramLogs.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: expect.stringContaining('message outside the bound conversation'),
      }),
    );
    expect(missingLogs.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: expect.stringContaining('message outside the bound conversation'),
      }),
    );
  });
});

describe('D-160 messenger turn composer - happy paths', () => {
  it('queues a Slack user message, runs a messenger turn, sends the reply, and records session history', async () => {
    const { ingest, runMessengerTurn, sessionStore, fetchImpl } = composeIngest({
      row: slackRow({ channel_id: 'C123' }),
      fetchImpl: slackFetch(),
    });

    await expect(
      ingest('slack', 'slack', slackMessagePayload({ channel: 'C123' })),
    ).resolves.toBe(true);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(sessionStore.history('messenger:slack:C123')).toHaveLength(2),
    );

    expect(runMessengerTurn).toHaveBeenCalledTimes(1);
    const input = firstRunInput(runMessengerTurn);
    expect(input.sessionStore).toBe(sessionStore);
    expect(input.inbound).toMatchObject({
      surface: 'messenger-slack',
      text: 'hi',
      from: 'U1',
      dispatch_depth: 0,
      session_id: 'messenger:slack:C123',
      source: {
        channel: 'messenger',
        actor: 'user_self',
        vendor: 'slack',
        from: 'U1',
      },
    });

    const fetchCall = singleFetchCall(fetchImpl);
    expect(fetchCall.url).toBe('https://slack.com/api/chat.postMessage');
    expect(fetchCall.init.headers).toEqual(
      expect.objectContaining({
        Authorization: `Bearer ${SLACK_TOKEN}`,
      }),
    );
    expect(requestJsonBody(fetchCall.init)).toMatchObject({
      channel: 'C123',
      text: 'reply',
    });
    expect(sessionStore.history('messenger:slack:C123')).toEqual([
      {
        session_id: 'messenger:slack:C123',
        surface: 'messenger-slack' satisfies SurfaceTag,
        role: 'user',
        text: 'hi',
        ts: NOW,
      },
      {
        session_id: 'messenger:slack:C123',
        surface: 'messenger-slack' satisfies SurfaceTag,
        role: 'assistant',
        text: 'reply',
        ts: NOW,
      },
    ]);
  });

  it('coerces a numeric Telegram chat_id into the session id and sendMessage payload', async () => {
    const fetchImpl = telegramFetch();
    const { ingest, runMessengerTurn, sessionStore } = composeIngest({
      row: telegramRow({ chat_id: 99 }),
      fetchImpl,
    });

    await expect(
      ingest('telegram', 'telegram', telegramMessagePayload({ chatId: 99 })),
    ).resolves.toBe(true);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(sessionStore.history('messenger:telegram:99')).toHaveLength(2),
    );

    expect(runMessengerTurn).toHaveBeenCalledTimes(1);
    expect(firstRunInput(runMessengerTurn).inbound.session_id).toBe(
      'messenger:telegram:99',
    );
    const fetchCall = singleFetchCall(fetchImpl);
    expect(fetchCall.url).toBe(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    );
    expect(requestJsonBody(fetchCall.init)).toMatchObject({
      chat_id: '99',
      text: 'reply',
    });
    expect(sessionStore.history('messenger:telegram:99').map((entry) => ({
      role: entry.role,
      surface: entry.surface,
      text: entry.text,
    }))).toEqual([
      { role: 'user', surface: 'messenger-telegram', text: 'hi' },
      { role: 'assistant', surface: 'messenger-telegram', text: 'reply' },
    ]);
  });

  it('exports deterministic messenger session ids keyed by vendor and recipient', () => {
    expect(messengerSessionId('slack', 'C123')).toBe('messenger:slack:C123');
  });

  it('stores Slack media through the fileSink as origin messenger_media and attaches the ref', async () => {
    const MEDIA_URL = 'https://files.slack.com/f1.png';
    // Real PNG magic so the server-side magic-byte detector (D-172 N.1) keeps
    // the stored mime as image/png rather than the vendor-reported value.
    const PNG_BYTES = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    // URL-switching fetch: the media download returns raw bytes; every
    // other call (chat.postMessage) returns the Slack ok envelope.
    const fetchImpl = vi.fn(async (
      input: Parameters<FetchImpl>[0],
      _init?: Parameters<FetchImpl>[1],
    ): ReturnType<FetchImpl> =>
      String(input) === MEDIA_URL
        ? new Response(PNG_BYTES, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          })
        : new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
    const fileIngest = vi.fn(async () => ({
      record_id: 'file-1',
      hot_fields: { media_class: 'image' },
    }));
    const fileCollection = ({
      ingest: fileIngest,
    } as unknown) as NonNullable<ComposeMessengerTurnIngestDeps['fileCollection']>;
    const { ingest, runMessengerTurn } = composeIngest({
      row: slackRow({ channel_id: 'C123' }),
      fetchImpl,
      fileCollection,
    });

    const payload = {
      type: 'event_callback',
      event: {
        type: 'message',
        subtype: 'file_share',
        user: 'U1',
        text: 'see attached',
        ts: '1730000000.000100',
        channel: 'C123',
        files: [
          { url_private: MEDIA_URL, mimetype: 'image/png', size: PNG_BYTES.length },
        ],
      },
    };
    await expect(ingest('slack', 'slack', payload)).resolves.toBe(true);

    await vi.waitFor(() => expect(runMessengerTurn).toHaveBeenCalledTimes(1));
    // The sink received the downloaded bytes stamped with the D-172
    // messenger origin; the turn's inbound carries only the stored ref.
    expect(fileIngest).toHaveBeenCalledTimes(1);
    // D-172 streaming: the sink ingests by `src_path` (the streamed temp file),
    // never an in-memory `bytes` buffer; the mime is server-detected.
    expect(fileIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'messenger_media',
        mime_type: 'image/png',
        src_path: expect.any(String),
        size_bytes: PNG_BYTES.length,
        source_id: '1730000000.000100:0',
      }),
    );
    expect(firstRunInput(runMessengerTurn).inbound.media).toEqual([
      { file_id: 'file-1', media_class: 'image' },
    ]);
  });

  it('downgrades a NON-audio file mislabelled audio/* so it cannot force transcription', async () => {
    const MEDIA_URL = 'https://files.slack.com/spoof.ogg';
    // Binary bytes (NUL + high bytes) that are neither text nor a known
    // image/PDF/audio container → the detector passes the reported `audio/ogg`
    // through, and the audio-magic guard then downgrades it. (Text bytes would
    // already fall to text/plain via the detector's text path.)
    const NOT_AUDIO = Buffer.from([0x00, 0xde, 0xad, 0xbe, 0xef, 0x13, 0x37, 0x00, 0x42, 0x99]);
    const fetchImpl = vi.fn(async (
      input: Parameters<FetchImpl>[0],
      _init?: Parameters<FetchImpl>[1],
    ): ReturnType<FetchImpl> =>
      String(input) === MEDIA_URL
        ? new Response(NOT_AUDIO, { status: 200, headers: { 'content-type': 'audio/ogg' } })
        : new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
    const fileIngest = vi.fn(async () => ({
      record_id: 'file-2',
      hot_fields: { media_class: 'document' },
    }));
    const fileCollection = ({
      ingest: fileIngest,
    } as unknown) as NonNullable<ComposeMessengerTurnIngestDeps['fileCollection']>;
    const { ingest, runMessengerTurn } = composeIngest({
      row: slackRow({ channel_id: 'C123' }),
      fetchImpl,
      fileCollection,
    });

    const payload = {
      type: 'event_callback',
      event: {
        type: 'message',
        subtype: 'file_share',
        user: 'U1',
        text: '',
        ts: '1730000000.000200',
        channel: 'C123',
        files: [{ url_private: MEDIA_URL, mimetype: 'audio/ogg', size: NOT_AUDIO.length }],
      },
    };
    await expect(ingest('slack', 'slack', payload)).resolves.toBe(true);
    await vi.waitFor(() => expect(runMessengerTurn).toHaveBeenCalledTimes(1));

    // The bogus audio/ogg label is dropped to octet-stream → media_class is NOT
    // 'voice', so the eager-transcribe path is never auto-selected.
    expect(fileIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'messenger_media',
        mime_type: 'application/octet-stream',
      }),
    );
  });

  it('keeps the audio/* label when the head bytes are a real audio container', async () => {
    const MEDIA_URL = 'https://files.slack.com/real.ogg';
    // "OggS" container signature → trusted as audio.
    const OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);
    const fetchImpl = vi.fn(async (
      input: Parameters<FetchImpl>[0],
      _init?: Parameters<FetchImpl>[1],
    ): ReturnType<FetchImpl> =>
      String(input) === MEDIA_URL
        ? new Response(OGG, { status: 200, headers: { 'content-type': 'audio/ogg' } })
        : new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
    const fileIngest = vi.fn(async () => ({
      record_id: 'file-3',
      hot_fields: { media_class: 'voice' },
    }));
    const fileCollection = ({
      ingest: fileIngest,
    } as unknown) as NonNullable<ComposeMessengerTurnIngestDeps['fileCollection']>;
    const { ingest, runMessengerTurn } = composeIngest({
      row: slackRow({ channel_id: 'C123' }),
      fetchImpl,
      fileCollection,
    });

    const payload = {
      type: 'event_callback',
      event: {
        type: 'message',
        subtype: 'file_share',
        user: 'U1',
        text: '',
        ts: '1730000000.000300',
        channel: 'C123',
        files: [{ url_private: MEDIA_URL, mimetype: 'audio/ogg', size: OGG.length }],
      },
    };
    await expect(ingest('slack', 'slack', payload)).resolves.toBe(true);
    await vi.waitFor(() => expect(runMessengerTurn).toHaveBeenCalledTimes(1));

    expect(fileIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'messenger_media',
        mime_type: 'audio/ogg',
      }),
    );
  });
});

describe('D-160 messenger turn composer - queueing and run-stage robustness', () => {
  it('serializes Slack turns FIFO so the second turn starts only after the first completes', async () => {
    const firstRelease = deferred<void>();
    const started: string[] = [];
    const runMessengerTurnImpl: RunMessengerTurn = async (input) => {
      started.push(input.inbound.text);
      if (input.inbound.text === 'first') {
        await firstRelease.promise;
      }
      await input.channel.deliver({
        kind: 'message',
        session_id: input.inbound.session_id,
        turn_id: `turn-${started.length}`,
        text: `reply:${input.inbound.text}`,
      });
      return { turn_id: `turn-${started.length}` };
    };
    const { ingest, runMessengerTurn, sessionStore, fetchImpl } = composeIngest({
      row: slackRow({ channel_id: 'C123' }),
      fetchImpl: slackFetch(),
      runMessengerTurnImpl,
    });

    const firstAccepted = ingest(
      'slack',
      'slack',
      slackMessagePayload({
        channel: 'C123',
        text: 'first',
        ts: '1730000000.000100',
      }),
    );
    const secondAccepted = ingest(
      'slack',
      'slack',
      slackMessagePayload({
        channel: 'C123',
        text: 'second',
        ts: '1730000000.000200',
      }),
    );

    await expect(Promise.all([firstAccepted, secondAccepted])).resolves.toEqual([
      true,
      true,
    ]);
    await vi.waitFor(() => expect(started).toEqual(['first']));
    expect(runMessengerTurn).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();

    firstRelease.resolve(undefined);

    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(sessionStore.history('messenger:slack:C123').map((entry) => ({
      role: entry.role,
      text: entry.text,
    }))).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'reply:first' },
      { role: 'user', text: 'second' },
      { role: 'assistant', text: 'reply:second' },
    ]);
  });

  it('logs a rejected Slack turn and keeps the queue alive for the next message', async () => {
    const logs = captureLogs();
    const runMessengerTurnImpl: RunMessengerTurn = async (input) => {
      if (input.inbound.text === 'fail') {
        throw new Error('turn exploded');
      }
      await input.channel.deliver({
        kind: 'message',
        session_id: input.inbound.session_id,
        turn_id: 't-next',
        text: 'reply:next',
      });
      return { turn_id: 't-next' };
    };
    const { ingest, runMessengerTurn, fetchImpl } = composeIngest({
      row: slackRow({ channel_id: 'C123' }),
      fetchImpl: slackFetch(),
      runMessengerTurnImpl,
      log: logs.log,
    });

    await expect(
      ingest(
        'slack',
        'slack',
        slackMessagePayload({ channel: 'C123', text: 'fail' }),
      ),
    ).resolves.toBe(true);
    await expect(
      ingest(
        'slack',
        'slack',
        slackMessagePayload({ channel: 'C123', text: 'next' }),
      ),
    ).resolves.toBe(true);

    await vi.waitFor(() => expect(runMessengerTurn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(logs.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: 'messenger turn failed (slack)',
      }),
    );
  });

  it('drops queued Slack turns when the canonical row is removed before run-stage re-resolution', async () => {
    const logs = captureLogs();
    const row = slackRow({ channel_id: 'C123' });
    const { store, get } = sequenceConnectionStore([row, row, null, null]);
    const { ingest, runMessengerTurn, fetchImpl } = composeIngest({
      store,
      fetchImpl: slackFetch(),
      log: logs.log,
    });

    const firstAccepted = ingest(
      'slack',
      'slack',
      slackMessagePayload({ channel: 'C123', text: 'first' }),
    );
    const secondAccepted = ingest(
      'slack',
      'slack',
      slackMessagePayload({ channel: 'C123', text: 'second' }),
    );

    await expect(Promise.all([firstAccepted, secondAccepted])).resolves.toEqual([
      true,
      true,
    ]);
    await vi.waitFor(() =>
      expect(
        logs.entries.filter((entry) => entry.msg.includes('dropped at run')),
      ).toHaveLength(2),
    );

    expect(get).toHaveBeenCalledTimes(4);
    expect(runMessengerTurn).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a queued Slack turn when the row is rebound to a different channel before run-stage re-gating', async () => {
    const logs = captureLogs();
    const { store } = sequenceConnectionStore([
      slackRow({ channel_id: 'C123' }),
      slackRow({ channel_id: 'C999' }),
    ]);
    const { ingest, runMessengerTurn, fetchImpl } = composeIngest({
      store,
      fetchImpl: slackFetch(),
      log: logs.log,
    });

    await expect(
      ingest('slack', 'slack', slackMessagePayload({ channel: 'C123' })),
    ).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(
        logs.entries.some((entry) => entry.msg.includes('refused at run')),
      ).toBe(true),
    );

    expect(runMessengerTurn).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('D-160 messenger turn dispatcher seam', () => {
  it('offers non-callback Slack messages to messengerTurnIngest and still emits the warehouse event', async () => {
    const payload = slackMessagePayload({ channel: 'C123' });
    const messengerTurnIngest = vi.fn<MessengerTurnIngest>(async () => true);
    const { bus, events } = makeWarehouseBus();
    const slackChannel = remoteChannel({
      message: {
        from: 'U1',
        text: 'hi',
        vendor_message_id: '1730000000.000100',
      },
    });
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      messengerChannels: { slack: slackChannel },
      messengerTurnIngest,
      warehouseBus: bus,
      now: () => NOW,
    });

    await dispatchSlackEvent(slackInboundEvent(payload, 'slack-prod'));

    expect(messengerTurnIngest).toHaveBeenCalledTimes(1);
    expect(messengerTurnIngest).toHaveBeenCalledWith('slack', 'slack-prod', payload);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      platform: 'messenger',
      slug: 'slack',
      entity_type: 'message',
      event_kind: 'created',
      record_id: '1730000000.000100',
      record: {
        from: 'U1',
        text: 'hi',
        vendor: 'slack',
        connection_name: 'slack-prod',
      },
    });
  });

  it('does not offer Slack ask replies to messengerTurnIngest', async () => {
    const payload = { type: 'block_actions' };
    const reply: NonNullable<ReturnType<RemoteChannel['parseInboundReply']>> = {
      ask_id: 'ask-1',
      option: 'approve',
      via: 'slack',
    };
    const messengerTurnIngest = vi.fn<MessengerTurnIngest>(async () => true);
    const block = stubBlock();
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { slack: remoteChannel({ reply }) },
      messengerTurnIngest,
    });

    await dispatchSlackEvent(slackInboundEvent(payload));

    expect(messengerTurnIngest).not.toHaveBeenCalled();
    expect(block.submitAnswer).toHaveBeenCalledWith(reply);
  });

  it('contains messengerTurnIngest throws so Slack dispatch resolves and logs', async () => {
    const logs = captureLogs();
    const payload = slackMessagePayload({ channel: 'C123' });
    const messengerTurnIngest = vi.fn<MessengerTurnIngest>(async () => {
      throw new Error('ingest seam failed');
    });
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      messengerChannels: {
        slack: remoteChannel({
          message: { from: 'U1', text: 'hi', vendor_message_id: 'm1' },
        }),
      },
      messengerTurnIngest,
      log: logs.log,
    });

    await expect(dispatchSlackEvent(slackInboundEvent(payload))).resolves.toBeUndefined();

    expect(messengerTurnIngest).toHaveBeenCalledTimes(1);
    expect(logs.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: expect.stringContaining('messenger turn ingest threw'),
      }),
    );
  });

  it('offers non-callback Telegram messages to messengerTurnIngest with the verified connection name', async () => {
    const payload = telegramMessagePayload({ chatId: 99 });
    const messengerTurnIngest = vi.fn<MessengerTurnIngest>(async () => true);
    const telegramChannel = ({
      ...remoteChannel({
        message: { from: '99', text: 'hi', vendor_message_id: '7' },
      }),
      name: 'telegram',
    } as unknown) as RemoteChannel;
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      messengerChannels: { telegram: telegramChannel },
      messengerTurnIngest,
    });

    await dispatchTelegramEvent(telegramInboundUpdate(payload, 'telegram-prod'));

    expect(messengerTurnIngest).toHaveBeenCalledTimes(1);
    expect(messengerTurnIngest).toHaveBeenCalledWith(
      'telegram',
      'telegram-prod',
      payload,
    );
  });
});
