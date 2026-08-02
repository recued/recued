/** D-163 inbound-answer-dispatcher slice tests.
 *
 *  Pins the contract for `composeInboundAnswerDispatcher` — the bridge
 *  between D-148 P9's verified vendor webhook port and D-158's
 *  `block.submitAnswer` funnel.
 *
 *  Coverage:
 *    - Recognized Slack `block_actions` payload → `parseInboundReply`
 *      returns an `InboundReply` → `block.submitAnswer` is called with
 *      exactly that reply.
 *    - Recognized Telegram `callback_query` payload → same path.
 *    - Non-callback payloads (Slack `event_callback`, Telegram message
 *      updates, malformed envelopes) → `parseInboundReply` returns null
 *      → `block.submitAnswer` is never called; the substrate-slice
 *      "messenger inbound (<vendor>)" log line is emitted to preserve
 *      trace continuity.
 *    - A vendor absent from the `messengerChannels` registry ⇒ dispatcher
 *      logs + drops (substrate present but adapter not wired).
 *    - Absent `block` ⇒ dispatcher recognizes the callback but logs +
 *      drops with the ask_id (block-not-wired path).
 *    - `submitAnswer` throws ⇒ dispatcher LETS THE THROW PROPAGATE so
 *      the vendor provider converts to `{ ok: false }` → 502 → vendor
 *      retries. This is the fold from the review: submitAnswer's
 *      documented contract no-ops stale press / unknown ask internally,
 *      so any throw is a real storage failure worth surfacing. */

import { describe, expect, it, vi } from 'vitest';
import { listMessengerVendors } from '@recued/contracts';
import type {
  NotificationBlock,
  RemoteChannel,
} from '@recued/notification';

import { composeInboundAnswerDispatcher } from '../composition/bin/wire-inbound-answer-dispatcher.js';
import type {
  SlackInboundEvent,
} from '../connections/providers/slack-provider.js';
import type {
  TelegramInboundUpdate,
} from '../connections/providers/telegram-provider.js';

/** Slack `block_actions` envelope — what the vendor port hands to the
 *  dispatcher after signature verification. The `value` encoding is the
 *  D-158 P2 callback codec: `${correlation_id}|${option_id}`. */
const slackBlockActionsPayload = (
  correlation_id: string,
  option_id: string,
): unknown => ({
  type: 'block_actions',
  user: { id: 'U-click' },
  actions: [{ type: 'button', value: `${correlation_id}|${option_id}` }],
  container: { message_ts: '1716141000.000200' },
});

/** Slack `event_callback` (a regular message event, not an interactive
 *  callback). The dispatcher must NOT route this through submitAnswer. */
const slackEventCallbackPayload = (): unknown => ({
  type: 'event_callback',
  event: { type: 'message', user: 'U-msg', text: 'hello', ts: '1.2' },
});

/** Telegram `callback_query` update — the inline-keyboard button press
 *  inbound shape. */
const telegramCallbackQueryPayload = (
  correlation_id: string,
  option_id: string,
): unknown => ({
  update_id: 42,
  callback_query: {
    id: 'cb-1',
    data: `${correlation_id}|${option_id}`,
    from: { id: 7001, is_bot: false },
    message: { message_id: 99 },
  },
});

/** Plain Telegram message update — no `callback_query`; dispatcher
 *  must NOT route this through submitAnswer. */
const telegramMessageUpdatePayload = (): unknown => ({
  update_id: 100,
  message: { message_id: 7, text: 'hi', from: { id: 7001 } },
});

const slackEvent = (payload: unknown): SlackInboundEvent => ({
  connection_name: 'slack',
  type: 'block_actions',
  event_id: 'Ev123',
  team_id: 'T-team',
  payload,
  headers: {},
});

const telegramUpdate = (payload: unknown): TelegramInboundUpdate => ({
  connection_name: 'telegram',
  update_id: '42',
  payload,
  headers: {},
});

/** Minimal `RemoteChannel` stub. The dispatcher only touches `name` and
 *  `parseInboundReply`; the other methods (`deliverNotify` /
 *  `deliverAsk` / `closeAsk`) are exercised by the block, not by the
 *  dispatcher. Casting to `RemoteChannel` keeps the test focused on the
 *  consumed surface. */
const stubSlackChannel = (): RemoteChannel & {
  parseInboundReply: ReturnType<typeof vi.fn>;
} =>
  ({
    name: 'slack',
    capability: 'inline',
    parseInboundReply: vi.fn((payload: unknown) => {
      if (
        payload === null ||
        typeof payload !== 'object' ||
        (payload as { type?: unknown }).type !== 'block_actions'
      ) {
        return null;
      }
      const actions = (payload as { actions?: Array<{ value?: string }> }).actions;
      const value = actions?.[0]?.value;
      if (typeof value !== 'string') return null;
      const sep = value.indexOf('|');
      if (sep <= 0 || sep >= value.length - 1) return null;
      return {
        ask_id: value.slice(0, sep),
        option: value.slice(sep + 1),
        via: 'slack' as const,
      };
    }),
    parseInboundMessage: vi.fn((payload: unknown) => {
      if (payload === null || typeof payload !== 'object') return null;
      const event = (payload as { event?: { type?: unknown; text?: unknown; user?: unknown; ts?: unknown } }).event;
      if (!event || event.type !== 'message' || typeof event.text !== 'string') return null;
      return {
        from: String(event.user ?? ''),
        text: event.text,
        ...(typeof event.ts === 'string' ? { vendor_message_id: event.ts } : {}),
      };
    }),
    deliverNotify: vi.fn(),
    deliverAsk: vi.fn(),
    closeAsk: vi.fn(),
  }) as unknown as RemoteChannel & {
    parseInboundReply: ReturnType<typeof vi.fn>;
  };

const stubTelegramChannel = (): RemoteChannel & {
  parseInboundReply: ReturnType<typeof vi.fn>;
} =>
  ({
    name: 'telegram',
    capability: 'inline',
    parseInboundReply: vi.fn((payload: unknown) => {
      if (payload === null || typeof payload !== 'object') return null;
      const cq = (payload as { callback_query?: { data?: unknown } }).callback_query;
      if (!cq || typeof cq.data !== 'string') return null;
      const sep = cq.data.indexOf('|');
      if (sep <= 0 || sep >= cq.data.length - 1) return null;
      return {
        ask_id: cq.data.slice(0, sep),
        option: cq.data.slice(sep + 1),
        via: 'telegram' as const,
      };
    }),
    parseInboundMessage: vi.fn((payload: unknown) => {
      if (payload === null || typeof payload !== 'object') return null;
      const message = (payload as { message?: { text?: unknown; from?: { id?: unknown } } }).message;
      if (!message || typeof message.text !== 'string') return null;
      return { from: String(message.from?.id ?? ''), text: message.text };
    }),
    deliverNotify: vi.fn(),
    deliverAsk: vi.fn(),
    closeAsk: vi.fn(),
  }) as unknown as RemoteChannel & {
    parseInboundReply: ReturnType<typeof vi.fn>;
  };

const stubBlock = (
  submitAnswerImpl: NotificationBlock['submitAnswer'] = async () => {},
): NotificationBlock => ({
  submitAnswer: vi.fn(submitAnswerImpl),
  // Everything else the block exposes is irrelevant to the dispatcher.
}) as unknown as NotificationBlock;

describe('D-163 — composeInboundAnswerDispatcher Slack routing', () => {
  it('routes a recognized block_actions payload through block.submitAnswer', async () => {
    const slackChannel = stubSlackChannel();
    const block = stubBlock();
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { slack: slackChannel },
    });

    await dispatchSlackEvent(
      slackEvent(slackBlockActionsPayload('ask-42', 'approve')),
    );

    expect(slackChannel.parseInboundReply).toHaveBeenCalledTimes(1);
    expect(block.submitAnswer).toHaveBeenCalledTimes(1);
    expect(block.submitAnswer).toHaveBeenCalledWith({
      ask_id: 'ask-42',
      option: 'approve',
      via: 'slack',
    });
  });

  it('logs + drops a non-callback payload (event_callback) without calling submitAnswer', async () => {
    const slackChannel = stubSlackChannel();
    const block = stubBlock();
    const log = vi.fn();
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { slack: slackChannel },
      log,
    });

    await dispatchSlackEvent(slackEvent(slackEventCallbackPayload()));

    expect(slackChannel.parseInboundReply).toHaveBeenCalledTimes(1);
    expect(block.submitAnswer).not.toHaveBeenCalled();
    // Substrate-slice log shape: trace continuity for non-callback
    // deliveries.
    expect(log).toHaveBeenCalledWith('info', 'messenger inbound (slack)', {
      connection_name: 'slack',
      event_id: 'Ev123',
    });
  });

  it('logs + drops when slackChannel is unwired (substrate-present, adapter-absent)', async () => {
    const block = stubBlock();
    const log = vi.fn();
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block,
      log,
    });

    await dispatchSlackEvent(
      slackEvent(slackBlockActionsPayload('ask-42', 'approve')),
    );

    expect(block.submitAnswer).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'info',
      'messenger inbound (slack) — no channel adapter wired',
      { connection_name: 'slack', event_id: 'Ev123' },
    );
  });

  it('logs + drops a recognized callback when block is unwired', async () => {
    const slackChannel = stubSlackChannel();
    const log = vi.fn();
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      messengerChannels: { slack: slackChannel },
      log,
    });

    await dispatchSlackEvent(
      slackEvent(slackBlockActionsPayload('ask-42', 'approve')),
    );

    expect(slackChannel.parseInboundReply).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'info',
      'messenger inbound (slack) — ask callback dropped, no block wired',
      { ask_id: 'ask-42', option: 'approve' },
    );
  });

  it('lets a submitAnswer throw propagate so the vendor provider returns 502', async () => {
    const slackChannel = stubSlackChannel();
    const block = stubBlock(async () => {
      throw new Error('SQLITE_BUSY');
    });
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { slack: slackChannel },
    });

    await expect(
      dispatchSlackEvent(
        slackEvent(slackBlockActionsPayload('ask-42', 'approve')),
      ),
    ).rejects.toThrow('SQLITE_BUSY');
  });

  it('omits event_id from the non-callback log when the event carried none', async () => {
    const slackChannel = stubSlackChannel();
    const log = vi.fn();
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      messengerChannels: { slack: slackChannel },
      log,
    });

    const event: SlackInboundEvent = {
      connection_name: 'slack',
      type: 'event_callback',
      event_id: null,
      team_id: null,
      payload: slackEventCallbackPayload(),
      headers: {},
    };
    await dispatchSlackEvent(event);

    expect(log).toHaveBeenCalledWith('info', 'messenger inbound (slack)', {
      connection_name: 'slack',
    });
  });
});

describe('D-163 — composeInboundAnswerDispatcher Telegram routing', () => {
  it('routes a recognized callback_query payload through block.submitAnswer', async () => {
    const telegramChannel = stubTelegramChannel();
    const block = stubBlock();
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { telegram: telegramChannel },
    });

    await dispatchTelegramEvent(
      telegramUpdate(telegramCallbackQueryPayload('ask-77', 'deny')),
    );

    expect(telegramChannel.parseInboundReply).toHaveBeenCalledTimes(1);
    expect(block.submitAnswer).toHaveBeenCalledWith({
      ask_id: 'ask-77',
      option: 'deny',
      via: 'telegram',
    });
  });

  it('logs + drops a plain message update without calling submitAnswer', async () => {
    const telegramChannel = stubTelegramChannel();
    const block = stubBlock();
    const log = vi.fn();
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { telegram: telegramChannel },
      log,
    });

    await dispatchTelegramEvent(telegramUpdate(telegramMessageUpdatePayload()));

    expect(telegramChannel.parseInboundReply).toHaveBeenCalledTimes(1);
    expect(block.submitAnswer).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('info', 'messenger inbound (telegram)', {
      connection_name: 'telegram',
      update_id: '42',
    });
  });

  it('logs + drops when telegramChannel is unwired', async () => {
    const block = stubBlock();
    const log = vi.fn();
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      block,
      log,
    });

    await dispatchTelegramEvent(
      telegramUpdate(telegramCallbackQueryPayload('ask-77', 'deny')),
    );

    expect(block.submitAnswer).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'info',
      'messenger inbound (telegram) — no channel adapter wired',
      { connection_name: 'telegram', update_id: '42' },
    );
  });

  it('logs + drops a recognized callback when block is unwired', async () => {
    const telegramChannel = stubTelegramChannel();
    const log = vi.fn();
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      messengerChannels: { telegram: telegramChannel },
      log,
    });

    await dispatchTelegramEvent(
      telegramUpdate(telegramCallbackQueryPayload('ask-77', 'deny')),
    );

    expect(log).toHaveBeenCalledWith(
      'info',
      'messenger inbound (telegram) — ask callback dropped, no block wired',
      { ask_id: 'ask-77', option: 'deny' },
    );
  });

  it('lets a submitAnswer throw propagate', async () => {
    const telegramChannel = stubTelegramChannel();
    const block = stubBlock(async () => {
      throw new Error('SQLITE_BUSY');
    });
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { telegram: telegramChannel },
    });

    await expect(
      dispatchTelegramEvent(
        telegramUpdate(telegramCallbackQueryPayload('ask-77', 'deny')),
      ),
    ).rejects.toThrow('SQLITE_BUSY');
  });

  it('omits update_id from the non-callback log when the update carried none', async () => {
    const telegramChannel = stubTelegramChannel();
    const log = vi.fn();
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      messengerChannels: { telegram: telegramChannel },
      log,
    });

    const update: TelegramInboundUpdate = {
      connection_name: 'telegram',
      update_id: null,
      payload: telegramMessageUpdatePayload(),
      headers: {},
    };
    await dispatchTelegramEvent(update);

    expect(log).toHaveBeenCalledWith('info', 'messenger inbound (telegram)', {
      connection_name: 'telegram',
    });
  });
});

describe('D-163 — composeInboundAnswerDispatcher cross-vendor isolation', () => {
  it('returns one dispatcher per DECLARED transport, regardless of which substrates are wired', () => {
    // D-192 seam 11 — the named `dispatchSlackEvent` / `dispatchTelegramEvent`
    // pair became a vendor→dispatcher record built over the registry. Iterating
    // it here means a newly declared transport is covered with no edit, and the
    // original invariant still holds: degraded inputs flip a dispatcher to
    // log-and-drop, never to undefined, so the webhook port has a stable seam.
    const { messengerDispatchers } = composeInboundAnswerDispatcher({});
    for (const vendor of listMessengerVendors()) {
      expect(typeof messengerDispatchers[vendor]).toBe('function');
    }
    expect(Object.keys(messengerDispatchers).sort()).toEqual([...listMessengerVendors()].sort());
  });

  it('does not route a Telegram payload through the Slack channel', async () => {
    const slackChannel = stubSlackChannel();
    const telegramChannel = stubTelegramChannel();
    const block = stubBlock();
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { slack: slackChannel, telegram: telegramChannel },
    });

    await dispatchTelegramEvent(
      telegramUpdate(telegramCallbackQueryPayload('ask-77', 'deny')),
    );

    expect(slackChannel.parseInboundReply).not.toHaveBeenCalled();
    expect(telegramChannel.parseInboundReply).toHaveBeenCalledTimes(1);
  });

  it('does not route a Slack payload through the Telegram channel', async () => {
    const slackChannel = stubSlackChannel();
    const telegramChannel = stubTelegramChannel();
    const block = stubBlock();
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { slack: slackChannel, telegram: telegramChannel },
    });

    await dispatchSlackEvent(
      slackEvent(slackBlockActionsPayload('ask-42', 'approve')),
    );

    expect(telegramChannel.parseInboundReply).not.toHaveBeenCalled();
    expect(slackChannel.parseInboundReply).toHaveBeenCalledTimes(1);
  });
});

describe('D-163 polish — composeInboundAnswerDispatcher telegramAck integration', () => {
  it('calls telegramAck with the raw payload + connection_name after submitAnswer succeeds', async () => {
    const telegramChannel = stubTelegramChannel();
    const block = stubBlock();
    const telegramAck = vi.fn(async () => {});
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { telegram: telegramChannel },
      telegramAck,
    });

    const payload = telegramCallbackQueryPayload('ask-77', 'deny');
    await dispatchTelegramEvent(telegramUpdate(payload));

    expect(block.submitAnswer).toHaveBeenCalledTimes(1);
    expect(telegramAck).toHaveBeenCalledTimes(1);
    expect(telegramAck).toHaveBeenCalledWith(payload, 'telegram');
  });

  it('does NOT call telegramAck when the payload is not a recognized callback', async () => {
    const telegramChannel = stubTelegramChannel();
    const block = stubBlock();
    const telegramAck = vi.fn();
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { telegram: telegramChannel },
      telegramAck,
    });

    await dispatchTelegramEvent(telegramUpdate(telegramMessageUpdatePayload()));

    expect(block.submitAnswer).not.toHaveBeenCalled();
    expect(telegramAck).not.toHaveBeenCalled();
  });

  it('does NOT call telegramAck when block is unwired (no submitAnswer fired)', async () => {
    const telegramChannel = stubTelegramChannel();
    const telegramAck = vi.fn();
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      messengerChannels: { telegram: telegramChannel },
      telegramAck,
    });

    await dispatchTelegramEvent(
      telegramUpdate(telegramCallbackQueryPayload('ask-77', 'deny')),
    );

    expect(telegramAck).not.toHaveBeenCalled();
  });

  it('catches + logs telegramAck failures; never propagates past the dispatcher', async () => {
    const telegramChannel = stubTelegramChannel();
    const block = stubBlock();
    const telegramAck = vi.fn(async () => {
      throw new Error('NETWORK_DOWN');
    });
    const log = vi.fn();
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { telegram: telegramChannel },
      telegramAck,
      log,
    });

    // Resolves cleanly — the ack throw must NOT bubble up (would
    // become a 502 → Telegram retry storm).
    await expect(
      dispatchTelegramEvent(
        telegramUpdate(telegramCallbackQueryPayload('ask-77', 'deny')),
      ),
    ).resolves.toBeUndefined();

    expect(block.submitAnswer).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'warn',
      'messenger inbound (telegram) — answerCallbackQuery failed',
      {
        ask_id: 'ask-77',
        connection_name: 'telegram',
        error: 'NETWORK_DOWN',
      },
    );
  });

  it('Slack path is unaffected by the telegramAck dep', async () => {
    const slackChannel = stubSlackChannel();
    const block = stubBlock();
    const telegramAck = vi.fn();
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { slack: slackChannel },
      telegramAck,
    });

    await dispatchSlackEvent(
      slackEvent(slackBlockActionsPayload('ask-42', 'approve')),
    );

    expect(block.submitAnswer).toHaveBeenCalledTimes(1);
    expect(telegramAck).not.toHaveBeenCalled();
  });

  it('runs submitAnswer BEFORE telegramAck (ordering invariant)', async () => {
    const telegramChannel = stubTelegramChannel();
    const order: string[] = [];
    const block = stubBlock(async () => {
      order.push('submitAnswer');
    });
    const telegramAck = vi.fn(async () => {
      order.push('telegramAck');
    });
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { telegram: telegramChannel },
      telegramAck,
    });

    await dispatchTelegramEvent(
      telegramUpdate(telegramCallbackQueryPayload('ask-77', 'deny')),
    );

    expect(order).toEqual(['submitAnswer', 'telegramAck']);
  });

  it('does NOT call telegramAck if submitAnswer throws (real storage failure should propagate, not ack)', async () => {
    const telegramChannel = stubTelegramChannel();
    const block = stubBlock(async () => {
      throw new Error('SQLITE_BUSY');
    });
    const telegramAck = vi.fn();
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { telegram: telegramChannel },
      telegramAck,
    });

    await expect(
      dispatchTelegramEvent(
        telegramUpdate(telegramCallbackQueryPayload('ask-77', 'deny')),
      ),
    ).rejects.toThrow('SQLITE_BUSY');

    // The retry will re-fire submitAnswer; the ack would land then.
    expect(telegramAck).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// WatchSource generalization — messenger bus emits
// ────────────────────────────────────────────────────────────────

describe('WatchSource — messenger inbound message bus emits', () => {
  const makeBus = () => {
    const events: Array<Record<string, unknown>> = [];
    return {
      events,
      bus: {
        emit: (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
        subscribe: () => () => {},
        dispose: () => {},
      },
    };
  };

  it('a Slack user message emits data.messenger.slack.message.created + marks the source', async () => {
    const { bus, events } = makeBus();
    const marks: Array<[string, number]> = [];
    const block = stubBlock();
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { slack: stubSlackChannel() },
      warehouseBus: bus as never,
      markSourceEvent: (key, at) => marks.push([key, at]),
      now: () => 9_000,
    });

    await dispatchSlackEvent(slackEvent(slackEventCallbackPayload()));

    expect(block.submitAnswer).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      platform: 'messenger',
      slug: 'slack',
      entity_type: 'message',
      event_kind: 'created',
      record_id: '1.2',
      at: 9_000,
      record: {
        from: 'U-msg',
        text: 'hello',
        vendor: 'slack',
        connection_name: 'slack',
        media_count: 0,
      },
    });
    expect(marks).toEqual([['messenger/slack', 9_000]]);
  });

  it('a button press routes to submitAnswer and emits NO message event', async () => {
    const { bus, events } = makeBus();
    const block = stubBlock();
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block,
      messengerChannels: { slack: stubSlackChannel() },
      warehouseBus: bus as never,
    });

    await dispatchSlackEvent(slackEvent(slackBlockActionsPayload('ask-1', 'approve')));

    expect(block.submitAnswer).toHaveBeenCalledOnce();
    expect(events).toHaveLength(0);
  });

  it('without a warehouse bus the message path stays log + drop', async () => {
    const logs: string[] = [];
    const channel = stubSlackChannel();
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block: stubBlock(),
      messengerChannels: { slack: channel },
      log: (_level, msg) => logs.push(msg),
    });

    await dispatchSlackEvent(slackEvent(slackEventCallbackPayload()));

    expect(logs).toContain('messenger inbound (slack)');
  });

  it('a Telegram message update without a vendor message id mints an OPAQUE fallback id', async () => {
    const { bus, events } = makeBus();
    const { messengerDispatchers: { telegram: dispatchTelegramEvent } } = composeInboundAnswerDispatcher({
      block: stubBlock(),
      messengerChannels: { telegram: stubTelegramChannel() },
      warehouseBus: bus as never,
      now: () => 5_500,
    });

    await dispatchTelegramEvent(telegramUpdate(telegramMessageUpdatePayload()));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      platform: 'messenger',
      slug: 'telegram',
      record: { from: '7001', text: 'hi', vendor: 'telegram', connection_name: 'telegram' },
    });
    // record_id crosses the realtime bridge to paired clients — the
    // fallback must be an opaque digest, never sender identity (codex
    // HIGH fold). Deterministic: a vendor redelivery mints the same id.
    const record_id = events[0]?.record_id as string;
    expect(record_id).toMatch(/^[0-9a-f]{24}$/);
    expect(record_id).not.toContain('7001');

    const { bus: bus2, events: events2 } = makeBus();
    const { messengerDispatchers: { telegram: redeliver } } = composeInboundAnswerDispatcher({
      block: stubBlock(),
      messengerChannels: { telegram: stubTelegramChannel() },
      warehouseBus: bus2 as never,
      now: () => 5_500,
    });
    await redeliver(telegramUpdate(telegramMessageUpdatePayload()));
    expect(events2[0]?.record_id).toBe(record_id);
  });

  it('a parseInboundMessage throw is contained (warn, no emit, no rejection)', async () => {
    const { bus, events } = makeBus();
    const logs: Array<[string, string]> = [];
    const channel = stubSlackChannel();
    (channel as unknown as { parseInboundMessage: ReturnType<typeof vi.fn> }).parseInboundMessage =
      vi.fn(() => {
        throw new Error('exotic payload');
      });
    const { messengerDispatchers: { slack: dispatchSlackEvent } } = composeInboundAnswerDispatcher({
      block: stubBlock(),
      messengerChannels: { slack: channel },
      warehouseBus: bus as never,
      log: (level, msg) => logs.push([level, msg]),
    });

    await expect(
      dispatchSlackEvent(slackEvent(slackEventCallbackPayload())),
    ).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
    expect(logs.some(([level, msg]) => level === 'warn' && msg.includes('parseInboundMessage'))).toBe(
      true,
    );
  });
});
