/** D-181 slice 6b — messenger live-control tests.
 *
 *  Pins the two halves of the messenger live-control surface (§8 channel
 *  matrix: messenger = `control`, pull via `/recued running`, control via
 *  interactive buttons):
 *
 *    1. The composer (`composeMessengerLiveControl`) — a `/recued …` command in
 *       the bound conversation renders the active list (an interactive prompt
 *       carrying `LIVE_CONTROL_CORRELATION_ID`), an empty list / usage falls
 *       back to a plain send, a button press routes to the in-flight registry's
 *       kill / cancel / promote with a one-line confirmation, and the access
 *       boundary (canonical row + bound conversation) matches the messenger
 *       turn. A press on another prompt (an ask reply) is NOT consumed.
 *
 *    2. The dispatcher wiring (`composeInboundAnswerDispatcher`) — a live-control
 *       press is consumed BEFORE the ask-reply path, a `/recued` command BEFORE
 *       the messenger turn, an ask reply / regular message still flows to its
 *       existing handler, and a consumed Telegram press triggers the callback
 *       ack.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ActiveExecutionEntry,
  ExecutionActiveResponse,
  LaneStatus,
} from '@recued/contracts';
import type { RemoteChannel } from '@recued/notification';

import {
  composeMessengerLiveControl,
  LIVE_CONTROL_CORRELATION_ID,
  type ComposeMessengerLiveControlDeps,
} from '../composition/bin/wire-messenger-live-control.js';
import { composeInboundAnswerDispatcher } from '../composition/bin/wire-inbound-answer-dispatcher.js';
import type { MessengerLiveControl } from '../composition/bin/wire-messenger-live-control.js';
import type { InFlightRegistry } from '../execution/in-flight-registry.js';
import type { SlackInboundEvent } from '../connections/providers/slack-provider.js';
import type { TelegramInboundUpdate } from '../connections/providers/telegram-provider.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import {
  buildConnectionRow,
  encodePlaintextAuth,
  stubConnectionStore,
} from './d-163-remote-channel-test-helpers.js';

const NOW = Date.UTC(2031, 0, 2, 3, 4, 5);
const SLACK_TOKEN = 'xoxb-live-ctl';
const TELEGRAM_TOKEN = '321:live-ctl';
const SLACK_CHANNEL = 'C-bound';
const TELEGRAM_CHAT = '4242';

// ── fixtures ────────────────────────────────────────────────────────

const connectionRow = (
  vendor: 'slack' | 'telegram',
  config: Record<string, unknown>,
  token: string,
) => {
  const auth = { type: 'bearer', token } as const;
  return {
    ...buildConnectionRow({ name: vendor, auth, config }),
    auth_ciphertext: encodePlaintextAuth(auth),
  };
};

const slackStore = (channel = SLACK_CHANNEL): ConnectionStoreSqlite =>
  stubConnectionStore(connectionRow('slack', { channel_id: channel }, SLACK_TOKEN));

const telegramStore = (chat: number | string = TELEGRAM_CHAT): ConnectionStoreSqlite =>
  stubConnectionStore(connectionRow('telegram', { chat_id: chat }, TELEGRAM_TOKEN));

/** A fetch stub returning a combined OK envelope valid for both Slack
 *  (`{ok, ts}`) and Telegram (`{ok, result.message_id}`). */
type FetchImpl = NonNullable<ComposeMessengerLiveControlDeps['fetchImpl']>;
const okFetch = (): ReturnType<typeof vi.fn<FetchImpl>> =>
  vi.fn<FetchImpl>(async () =>
    new Response(JSON.stringify({ ok: true, ts: '1', result: { message_id: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

const bodyOf = (init: RequestInit | undefined): Record<string, unknown> => {
  if (init === undefined || typeof init.body !== 'string') {
    throw new Error('expected a JSON request body');
  }
  return JSON.parse(init.body) as Record<string, unknown>;
};

const runEntry = (over: Partial<ActiveExecutionEntry> = {}): ActiveExecutionEntry => ({
  entry_kind: 'run',
  run_id: '20260101T000000000-aaa111',
  recipe_id: 'detect-deal-risk-hubspot',
  state: 'running',
  origin: 'attended',
  source: { channel: 'user', actor: 'user_self', user_id: 'u', client_token_id: 'c' },
  started_at: NOW - 120_000,
  slot_acquired_at: NOW - 120_000,
  progress: { contract: 'silent', stalled: false },
  kill: { mechanism: 'abandon_await', run_id: '20260101T000000000-aaa111' },
  ...over,
});

const queuedEntry = (over: Partial<ActiveExecutionEntry> = {}): ActiveExecutionEntry => ({
  entry_kind: 'queued-call',
  queued_call_id: 'call_7',
  run_id: '20260101T000000001-bbb222',
  recipe_id: 'overdue-invoice-chase',
  lane: 'local-heavy',
  state: 'waiting_slot',
  origin: 'attended',
  source: { channel: 'user', actor: 'user_self', user_id: 'u', client_token_id: 'c' },
  started_at: NOW - 14_000,
  progress: { contract: 'silent', stalled: false },
  kill: { mechanism: 'abandon_await', run_id: '20260101T000000001-bbb222' },
  ...over,
});

const lane = (over: Partial<LaneStatus> = {}): LaneStatus => ({
  lane: 'local-heavy',
  capacity: 2,
  in_use: 2,
  queued: 1,
  oldest_wait_ms: 30_000,
  ...over,
});

interface RegistryStub {
  registry: InFlightRegistry;
  snapshot: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  promote: ReturnType<typeof vi.fn>;
}

const stubRegistry = (opts: {
  snapshot?: ExecutionActiveResponse;
  killStatus?: string;
  cancelStatus?: string;
  promoteStatus?: string;
} = {}): RegistryStub => {
  const snapshot = vi.fn(() => opts.snapshot ?? { entries: [], lanes: [] });
  const kill = vi.fn(() => opts.killStatus ?? 'killed');
  const cancel = vi.fn(() => opts.cancelStatus ?? 'cancelled_before_dispatch');
  const promote = vi.fn(() => opts.promoteStatus ?? 'promoted');
  return {
    snapshot,
    kill,
    cancel,
    promote,
    registry: { snapshot, kill, cancel, promote } as unknown as InFlightRegistry,
  };
};

const compose = (deps: {
  registry?: InFlightRegistry;
  connectionStore?: ConnectionStoreSqlite;
  fetchImpl?: ReturnType<typeof okFetch>;
}): { control: MessengerLiveControl; fetchImpl: ReturnType<typeof okFetch> } => {
  const fetchImpl = deps.fetchImpl ?? okFetch();
  const control = composeMessengerLiveControl({
    registry: deps.registry ?? stubRegistry().registry,
    connectionStore: deps.connectionStore ?? slackStore(),
    fetchImpl,
    now: () => NOW,
  });
  if (control === undefined) throw new Error('expected live control to compose');
  return { control, fetchImpl };
};

// ── inbound payloads ────────────────────────────────────────────────

const slackText = (text: string, channel = SLACK_CHANNEL): unknown => ({
  type: 'event_callback',
  event: { type: 'message', user: 'U1', text, ts: '1730000000.000100', channel },
});

const slackPress = (
  correlation_id: string,
  option_id: string,
  channel = SLACK_CHANNEL,
): unknown => ({
  type: 'block_actions',
  user: { id: 'U1' },
  actions: [{ type: 'button', value: `${correlation_id}|${option_id}` }],
  container: { message_ts: '1730000000.000200', channel_id: channel },
});

const telegramText = (text: string, chatId: number | string = TELEGRAM_CHAT): unknown => ({
  update_id: 1,
  message: { message_id: 5, text, from: { id: 7, is_bot: false }, chat: { id: chatId } },
});

const telegramPress = (
  correlation_id: string,
  option_id: string,
  chatId: number | string = TELEGRAM_CHAT,
): unknown => ({
  update_id: 2,
  callback_query: {
    id: 'cb-1',
    data: `${correlation_id}|${option_id}`,
    from: { id: 7, is_bot: false },
    message: { message_id: 9, chat: { id: chatId } },
  },
});

// ════════════════════════════════════════════════════════════════════
// composer
// ════════════════════════════════════════════════════════════════════

describe('D-181 slice 6b — composeMessengerLiveControl', () => {
  it('returns undefined without a registry', () => {
    expect(
      composeMessengerLiveControl({ connectionStore: slackStore() }),
    ).toBeUndefined();
  });

  it('returns undefined without a connection store', () => {
    expect(
      composeMessengerLiveControl({ registry: stubRegistry().registry }),
    ).toBeUndefined();
  });

  it('renders the active list as an interactive prompt for /recued running', async () => {
    const reg = stubRegistry({
      snapshot: { entries: [runEntry(), queuedEntry()], lanes: [lane()] },
    });
    const { control, fetchImpl } = compose({ registry: reg.registry });

    const consumed = await control.handleCommand('slack', 'slack', slackText('/recued running'));

    expect(consumed).toBe(true);
    expect(reg.snapshot).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, body } = (() => {
      const call = fetchImpl.mock.calls[0]!;
      return { url: String(call[0]), body: bodyOf(call[1]) };
    })();
    // sendPrompt → chat.postMessage with a Block Kit actions block.
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(body.channel).toBe(SLACK_CHANNEL);
    const blocks = body.blocks as Array<Record<string, unknown>>;
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions).toBeDefined();
    expect(actions!.block_id).toBe(LIVE_CONTROL_CORRELATION_ID);
    const values = (actions!.elements as Array<{ value: string }>).map((e) => e.value);
    // kill the run, promote + cancel the queued call — each carrying the
    // live-control correlation id and the stable target id.
    expect(values).toContain(`${LIVE_CONTROL_CORRELATION_ID}|kill:20260101T000000000-aaa111`);
    expect(values).toContain(`${LIVE_CONTROL_CORRELATION_ID}|promote:call_7`);
    expect(values).toContain(`${LIVE_CONTROL_CORRELATION_ID}|cancel:call_7`);
    // The rendered text names the recipes + the busy lane.
    const text = blocks.find((b) => b.type === 'section') as { text: { text: string } };
    expect(text.text.text).toContain('detect-deal-risk-hubspot');
    expect(text.text.text).toContain('local-heavy 2/2');
  });

  it('sends a plain "nothing running" message when the list is empty', async () => {
    const reg = stubRegistry({ snapshot: { entries: [], lanes: [] } });
    const { control, fetchImpl } = compose({ registry: reg.registry });

    const consumed = await control.handleCommand('slack', 'slack', slackText('/recued running'));

    expect(consumed).toBe(true);
    const call = fetchImpl.mock.calls[0]!;
    const body = bodyOf(call[1]);
    // A plain send (no blocks) — "nothing running".
    expect(body.blocks).toBeUndefined();
    expect(String(body.text)).toContain('Nothing running');
  });

  it('sends a usage note for an unknown /recued subcommand', async () => {
    const { control, fetchImpl } = compose({});
    const consumed = await control.handleCommand('slack', 'slack', slackText('/recued frobnicate'));
    expect(consumed).toBe(true);
    expect(String(bodyOf(fetchImpl.mock.calls[0]![1]).text)).toContain('/recued running');
  });

  it('does not consume a non-command message', async () => {
    const { control, fetchImpl } = compose({});
    const consumed = await control.handleCommand('slack', 'slack', slackText('what is up'));
    expect(consumed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a /recued command outside the bound conversation', async () => {
    const { control, fetchImpl } = compose({});
    // The command arrives in a DIFFERENT Slack channel than the bound one.
    const consumed = await control.handleCommand(
      'slack',
      'slack',
      slackText('/recued running', 'C-other'),
    );
    expect(consumed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a command on a non-canonical connection row', async () => {
    const { control, fetchImpl } = compose({});
    const consumed = await control.handleCommand('slack', 'slack-secondary', slackText('/recued running'));
    expect(consumed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('routes a kill press to the registry and confirms', async () => {
    const reg = stubRegistry({ killStatus: 'killed' });
    const { control, fetchImpl } = compose({ registry: reg.registry });

    const consumed = await control.handleControlPress(
      'slack',
      'slack',
      slackPress(LIVE_CONTROL_CORRELATION_ID, 'kill:20260101T000000000-aaa111'),
    );

    expect(consumed).toBe(true);
    expect(reg.kill).toHaveBeenCalledWith('20260101T000000000-aaa111');
    expect(reg.cancel).not.toHaveBeenCalled();
    expect(String(bodyOf(fetchImpl.mock.calls[0]![1]).text)).toContain('Killed');
  });

  it('routes cancel + promote presses to the registry', async () => {
    const reg = stubRegistry({ cancelStatus: 'cancelled_before_dispatch', promoteStatus: 'promoted' });
    const { control } = compose({ registry: reg.registry });

    await control.handleControlPress(
      'slack',
      'slack',
      slackPress(LIVE_CONTROL_CORRELATION_ID, 'cancel:call_7'),
    );
    await control.handleControlPress(
      'slack',
      'slack',
      slackPress(LIVE_CONTROL_CORRELATION_ID, 'promote:call_7'),
    );

    expect(reg.cancel).toHaveBeenCalledWith('call_7');
    expect(reg.promote).toHaveBeenCalledWith('call_7');
  });

  it('maps non-terminal verdicts to legible confirmations', async () => {
    const reg = stubRegistry({ killStatus: 'already_terminal', cancelStatus: 'already_dispatched' });
    const { control, fetchImpl } = compose({ registry: reg.registry });

    await control.handleControlPress(
      'slack',
      'slack',
      slackPress(LIVE_CONTROL_CORRELATION_ID, 'kill:20260101T000000000-aaa111'),
    );
    await control.handleControlPress(
      'slack',
      'slack',
      slackPress(LIVE_CONTROL_CORRELATION_ID, 'cancel:call_7'),
    );

    expect(String(bodyOf(fetchImpl.mock.calls[0]![1]).text)).toContain('already finished');
    expect(String(bodyOf(fetchImpl.mock.calls[1]![1]).text)).toContain('already started');
  });

  it('refuses a control press from outside the bound conversation', async () => {
    const reg = stubRegistry();
    const { control, fetchImpl } = compose({ registry: reg.registry });

    // Our correlation id, but the press arrives in a DIFFERENT channel than the
    // currently-bound one (a stale button after a rebind).
    const consumed = await control.handleControlPress(
      'slack',
      'slack',
      slackPress(LIVE_CONTROL_CORRELATION_ID, 'kill:20260101T000000000-aaa111', 'C-other'),
    );

    // Consumed (it IS our correlation id, so it never falls to the ask path)…
    expect(consumed).toBe(true);
    // …but no mutation + no confirmation.
    expect(reg.kill).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not consume a press on another prompt (an ask reply)', async () => {
    const reg = stubRegistry();
    const { control, fetchImpl } = compose({ registry: reg.registry });

    const consumed = await control.handleControlPress(
      'slack',
      'slack',
      slackPress('ask-abc-123', 'option_yes'),
    );

    expect(consumed).toBe(false);
    expect(reg.kill).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('consumes a malformed live-control option without touching the registry', async () => {
    const reg = stubRegistry();
    const { control } = compose({ registry: reg.registry });

    const consumed = await control.handleControlPress(
      'slack',
      'slack',
      slackPress(LIVE_CONTROL_CORRELATION_ID, 'explode:nope'),
    );

    expect(consumed).toBe(true);
    expect(reg.kill).not.toHaveBeenCalled();
    expect(reg.cancel).not.toHaveBeenCalled();
    expect(reg.promote).not.toHaveBeenCalled();
  });

  it('encodes Telegram callback_data within the 64-byte cap', async () => {
    const reg = stubRegistry({
      snapshot: { entries: [runEntry(), queuedEntry()], lanes: [lane()] },
    });
    const { control, fetchImpl } = compose({
      registry: reg.registry,
      connectionStore: telegramStore(),
    });

    const consumed = await control.handleCommand('telegram', 'telegram', telegramText('/recued running'));

    expect(consumed).toBe(true);
    const body = bodyOf(fetchImpl.mock.calls[0]![1]);
    const keyboard = (body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
      .inline_keyboard;
    const datas = keyboard.flat().map((b) => b.callback_data);
    expect(datas.length).toBeGreaterThan(0);
    for (const data of datas) {
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    }
    // The Telegram send actually succeeded (the prompt was not rejected for an
    // over-cap payload, which would have fallen back to a plain send).
    expect(body.reply_markup).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// dispatcher wiring
// ════════════════════════════════════════════════════════════════════

const slackEvent = (payload: unknown): SlackInboundEvent => ({
  connection_name: 'slack',
  type: 'block_actions',
  event_id: 'Ev1',
  team_id: 'T1',
  payload,
  headers: {},
});

const telegramUpdate = (payload: unknown): TelegramInboundUpdate => ({
  connection_name: 'telegram',
  update_id: '2',
  payload,
  headers: {},
});

const stubReplyChannel = (reply: { ask_id: string; option: string } | null): RemoteChannel =>
  ({
    name: 'slack',
    capability: 'inline',
    parseInboundReply: vi.fn(() => reply),
    parseInboundMessage: vi.fn(() => null),
  }) as unknown as RemoteChannel;

const stubLiveControl = (opts: {
  press?: boolean;
  command?: boolean;
}): MessengerLiveControl & {
  handleControlPress: ReturnType<typeof vi.fn>;
  handleCommand: ReturnType<typeof vi.fn>;
} => ({
  handleControlPress: vi.fn(async () => opts.press ?? false),
  handleCommand: vi.fn(async () => opts.command ?? false),
});

describe('D-181 slice 6b — inbound dispatcher live-control wiring', () => {
  it('consumes a live-control press before the ask-reply path', async () => {
    const submitAnswer = vi.fn(async () => {});
    const liveControl = stubLiveControl({ press: true });
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block: { submitAnswer } as unknown as Parameters<typeof composeInboundAnswerDispatcher>[0]['block'],
      messengerChannels: { slack: stubReplyChannel({ ask_id: 'ask-1', option: 'yes' }) },
      messengerLiveControl: liveControl,
    });

    await dispatchSlackEvent(slackEvent(slackPress(LIVE_CONTROL_CORRELATION_ID, 'kill:r1')));

    expect(liveControl.handleControlPress).toHaveBeenCalledTimes(1);
    expect(submitAnswer).not.toHaveBeenCalled();
    expect(liveControl.handleCommand).not.toHaveBeenCalled();
  });

  it('still routes an ask reply to submitAnswer when the press is not live-control', async () => {
    const submitAnswer = vi.fn(async () => {});
    const liveControl = stubLiveControl({ press: false, command: false });
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block: { submitAnswer } as unknown as Parameters<typeof composeInboundAnswerDispatcher>[0]['block'],
      messengerChannels: { slack: stubReplyChannel({ ask_id: 'ask-1', option: 'yes' }) },
      messengerLiveControl: liveControl,
    });

    await dispatchSlackEvent(slackEvent(slackPress('ask-1', 'yes')));

    expect(liveControl.handleControlPress).toHaveBeenCalledTimes(1);
    expect(submitAnswer).toHaveBeenCalledWith({ ask_id: 'ask-1', option: 'yes' });
  });

  it('consumes a /recued command before the messenger turn', async () => {
    const messengerTurnIngest = vi.fn(async () => true);
    const liveControl = stubLiveControl({ press: false, command: true });
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      messengerChannels: { slack: stubReplyChannel(null) },
      messengerTurnIngest,
      messengerLiveControl: liveControl,
    });

    await dispatchSlackEvent(slackEvent(slackText('/recued running')));

    expect(liveControl.handleCommand).toHaveBeenCalledTimes(1);
    expect(messengerTurnIngest).not.toHaveBeenCalled();
  });

  it('lets a regular message flow to the messenger turn', async () => {
    const messengerTurnIngest = vi.fn(async () => true);
    const liveControl = stubLiveControl({ press: false, command: false });
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      messengerChannels: { slack: stubReplyChannel(null) },
      messengerTurnIngest,
      messengerLiveControl: liveControl,
    });

    await dispatchSlackEvent(slackEvent(slackText('hello there')));

    expect(liveControl.handleCommand).toHaveBeenCalledTimes(1);
    expect(messengerTurnIngest).toHaveBeenCalledTimes(1);
  });

  it('acks a consumed Telegram live-control press', async () => {
    const telegramAck = vi.fn(async () => {});
    const liveControl = stubLiveControl({ press: true });
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      messengerChannels: { telegram: stubReplyChannel(null) },
      telegramAck,
      messengerLiveControl: liveControl,
    });

    await dispatchTelegramEvent(telegramUpdate(telegramPress(LIVE_CONTROL_CORRELATION_ID, 'kill:r1')));

    expect(liveControl.handleControlPress).toHaveBeenCalledTimes(1);
    expect(telegramAck).toHaveBeenCalledTimes(1);
  });
});
