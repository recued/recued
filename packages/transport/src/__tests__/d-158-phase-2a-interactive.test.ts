import { describe, expect, it } from 'vitest';
import {
  createSlackTransport,
  createTelegramTransport,
  type InteractiveTransport,
} from '@recued/transport';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface SlackTextObject {
  type?: unknown;
  text?: unknown;
}

interface SlackButton {
  type?: unknown;
  text?: SlackTextObject;
  action_id?: unknown;
  value?: unknown;
}

interface SlackBlock {
  type?: unknown;
  block_id?: unknown;
  text?: SlackTextObject;
  elements?: SlackButton[];
}

interface TelegramButton {
  text?: unknown;
  callback_data?: unknown;
}

const statusText = (status: number): string => {
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 429) return 'Too Many Requests';
  if (status === 500) return 'Internal Server Error';
  return 'Bad Request';
};

const jsonFetch = (
  json: unknown,
  options: { status?: number } = {},
): { fetchImpl: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(json), {
      status: options.status ?? 200,
      statusText: statusText(options.status ?? 200),
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
};

const requestBody = <T>(call: FetchCall): T => {
  expect(typeof call.init?.body).toBe('string');
  return JSON.parse(call.init?.body as string) as T;
};

const requestHeaders = (call: FetchCall): Record<string, string> => {
  expect(call.init?.headers).toBeTypeOf('object');
  return call.init?.headers as Record<string, string>;
};

const slackChoicePayload = (
  value: string,
  overrides: Record<string, unknown> = {},
): unknown => ({
  type: 'block_actions',
  user: { id: 'U-click' },
  actions: [{ type: 'button', value }],
  container: { message_ts: '1716141000.000200' },
  ...overrides,
});

const telegramChoicePayload = (
  data: string,
  callbackOverrides: Record<string, unknown> = {},
): unknown => ({
  update_id: 10,
  callback_query: {
    id: 'callback-1',
    data,
    from: { id: 7001, is_bot: false },
    message: { message_id: 42 },
    ...callbackOverrides,
  },
});

const expectPlainTextAndChoiceStaySeparate = (
  transport: InteractiveTransport,
  plainPayload: unknown,
  expectedPlain: unknown,
  choicePayload: unknown,
  expectedChoice: unknown,
): void => {
  expect(transport.parseInbound(plainPayload)).toEqual(expectedPlain);
  expect(transport.parseInboundChoice(plainPayload)).toBeNull();
  expect(transport.parseInbound(choicePayload)).toBeNull();
  expect(transport.parseInboundChoice(choicePayload)).toEqual(expectedChoice);
};

describe('D-158 P2a transport callback codec through vendor payloads', () => {
  it('round-trips Slack button values, including option ids with pipes', async () => {
    const { fetchImpl, calls } = jsonFetch({ ok: true, ts: '1716141000.000100' });
    const slack = createSlackTransport({ fetchImpl });

    await slack.sendPrompt({
      recipient: 'C123',
      token: 'xoxb-token',
      text: 'Choose one',
      correlation_id: 'ask-slack',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'route|manual', label: 'Route manually' },
      ],
    });

    const body = requestBody<{ blocks: SlackBlock[] }>(calls[0]);
    const actions = body.blocks[1];
    const elements = actions.elements ?? [];

    expect(elements.map((element) => element.value)).toEqual([
      'ask-slack|approve',
      'ask-slack|route|manual',
    ]);
    expect(
      slack.parseInboundChoice(slackChoicePayload(String(elements[1].value))),
    ).toEqual({
      correlation_id: 'ask-slack',
      option_id: 'route|manual',
      from: 'U-click',
      vendor_message_id: '1716141000.000200',
    });
  });

  it('round-trips Telegram callback_data through parseInboundChoice', async () => {
    const { fetchImpl, calls } = jsonFetch({
      ok: true,
      result: { message_id: 42 },
    });
    const telegram = createTelegramTransport({ fetchImpl });

    await telegram.sendPrompt({
      recipient: '7001',
      token: '12345:secret',
      text: 'Choose one',
      correlation_id: 'ask-telegram',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'route|manual', label: 'Route manually' },
      ],
    });

    const body = requestBody<{
      reply_markup: { inline_keyboard: TelegramButton[][] };
    }>(calls[0]);
    const callbackData = body.reply_markup.inline_keyboard[1][0].callback_data;

    expect(callbackData).toBe('ask-telegram|route|manual');
    expect(
      telegram.parseInboundChoice(telegramChoicePayload(String(callbackData))),
    ).toEqual({
      correlation_id: 'ask-telegram',
      option_id: 'route|manual',
      from: '7001',
      vendor_message_id: '42',
    });
  });

  it.each(['missing-separator', '|empty-correlation', 'empty-option|'])(
    'rejects malformed callback data "%s"',
    (value) => {
      const slack = createSlackTransport({ fetchImpl: jsonFetch({ ok: true }).fetchImpl });
      const telegram = createTelegramTransport({
        fetchImpl: jsonFetch({ ok: true }).fetchImpl,
      });

      expect(slack.parseInboundChoice(slackChoicePayload(value))).toBeNull();
      expect(telegram.parseInboundChoice(telegramChoicePayload(value))).toBeNull();
    },
  );
});

describe('D-158 P2a Slack sendPrompt and closePrompt', () => {
  it('posts a Block Kit prompt with encoded button values and bearer auth', async () => {
    const { fetchImpl, calls } = jsonFetch({
      ok: true,
      ts: '1716141000.000300',
    });
    const slack = createSlackTransport({ fetchImpl });

    await expect(
      slack.sendPrompt({
        recipient: 'C123',
        token: 'xoxb-token',
        title: 'Decision ready',
        text: 'Approve the plan?',
        correlation_id: 'ask-slack-body',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'later|manual', label: 'Later' },
        ],
      }),
    ).resolves.toEqual({
      ok: true,
      vendor_message_id: '1716141000.000300',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://slack.com/api/chat.postMessage');
    expect(requestHeaders(calls[0])).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: 'Bearer xoxb-token',
    });

    const body = requestBody<{
      channel: string;
      text: string;
      blocks: SlackBlock[];
    }>(calls[0]);
    expect(body.channel).toBe('C123');
    expect(body.text).toBe('*Decision ready*\nApprove the plan?');
    expect(body.blocks).toHaveLength(2);
    expect(body.blocks[0]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Decision ready*\nApprove the plan?' },
    });

    const actions = body.blocks[1];
    const elements = actions.elements ?? [];
    expect(actions.type).toBe('actions');
    expect(actions.block_id).toBe('ask-slack-body');
    expect(elements).toHaveLength(2);
    expect(elements.map((element) => element.type)).toEqual(['button', 'button']);
    expect(elements.map((element) => element.text?.text)).toEqual(['Yes', 'Later']);
    expect(elements.map((element) => element.value)).toEqual([
      'ask-slack-body|yes',
      'ask-slack-body|later|manual',
    ]);
    expect(new Set(elements.map((element) => element.action_id)).size).toBe(2);
  });

  it('maps Slack ok:false and HTTP failures from sendPrompt to failed results', async () => {
    const vendorFailure = createSlackTransport({
      fetchImpl: jsonFetch({ ok: false, error: 'channel_not_found' }).fetchImpl,
    });
    const httpFailure = createSlackTransport({
      fetchImpl: jsonFetch({ ok: true }, { status: 500 }).fetchImpl,
    });
    const prompt = {
      recipient: 'C123',
      token: 'xoxb-token',
      text: 'Choose',
      correlation_id: 'ask-fail',
      options: [{ id: 'ok', label: 'OK' }],
    };

    await expect(vendorFailure.sendPrompt(prompt)).resolves.toEqual({
      ok: false,
      error: { kind: 'vendor_error', detail: 'Slack: channel_not_found' },
    });
    await expect(httpFailure.sendPrompt(prompt)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'server_error' },
    });
  });

  it('closePrompt updates the message with only a section block', async () => {
    const { fetchImpl, calls } = jsonFetch({
      ok: true,
      ts: '1716141000.000300',
    });
    const slack = createSlackTransport({ fetchImpl });

    await expect(
      slack.closePrompt({
        recipient: 'C123',
        token: 'xoxb-token',
        vendor_message_id: '1716141000.000300',
        text: 'Closed',
      }),
    ).resolves.toEqual({
      ok: true,
      vendor_message_id: '1716141000.000300',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://slack.com/api/chat.update');
    const body = requestBody<{ channel: string; ts: string; text: string; blocks: SlackBlock[] }>(
      calls[0],
    );
    expect(body).toEqual({
      channel: 'C123',
      ts: '1716141000.000300',
      text: 'Closed',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Closed' } }],
    });
    expect(body.blocks.some((block) => block.type === 'actions')).toBe(false);
  });
});

describe('D-158 P2a Telegram sendPrompt and closePrompt', () => {
  it('posts an inline keyboard with encoded callback_data', async () => {
    const { fetchImpl, calls } = jsonFetch({
      ok: true,
      result: { message_id: 77 },
    });
    const telegram = createTelegramTransport({ fetchImpl });

    await expect(
      telegram.sendPrompt({
        recipient: '7001',
        token: '12345:secret',
        title: 'Decision ready',
        text: 'Approve the plan?',
        correlation_id: 'ask-telegram-body',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'later|manual', label: 'Later' },
        ],
      }),
    ).resolves.toEqual({ ok: true, vendor_message_id: '77' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://api.telegram.org/bot12345:secret/sendMessage',
    );
    const body = requestBody<{
      chat_id: string;
      text: string;
      reply_markup: { inline_keyboard: TelegramButton[][] };
    }>(calls[0]);
    expect(body.chat_id).toBe('7001');
    expect(body.text).toBe('Decision ready\n\nApprove the plan?');
    expect(body.reply_markup.inline_keyboard).toEqual([
      [{ text: 'Yes', callback_data: 'ask-telegram-body|yes' }],
      [{ text: 'Later', callback_data: 'ask-telegram-body|later|manual' }],
    ]);
  });

  it('refuses callback_data over Telegram 64 byte cap without fetching', async () => {
    const { fetchImpl, calls } = jsonFetch({
      ok: true,
      result: { message_id: 1 },
    });
    const telegram = createTelegramTransport({ fetchImpl });

    await expect(
      telegram.sendPrompt({
        recipient: '7001',
        token: '12345:secret',
        text: 'Choose',
        correlation_id: 'ask-telegram-long',
        options: [{ id: 'x'.repeat(60), label: 'Too long' }],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
    });
    expect(calls).toHaveLength(0);
  });

  it('closePrompt edits text with an explicit empty inline keyboard', async () => {
    const { fetchImpl, calls } = jsonFetch({
      ok: true,
      result: { message_id: 77 },
    });
    const telegram = createTelegramTransport({ fetchImpl });

    await expect(
      telegram.closePrompt({
        recipient: '7001',
        token: '12345:secret',
        vendor_message_id: '77',
        text: 'Closed',
      }),
    ).resolves.toEqual({ ok: true, vendor_message_id: '77' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://api.telegram.org/bot12345:secret/editMessageText',
    );
    expect(requestBody(calls[0])).toEqual({
      chat_id: '7001',
      message_id: 77,
      text: 'Closed',
      reply_markup: { inline_keyboard: [] },
    });
  });
});

describe('D-158 P2a Slack parseInboundChoice', () => {
  const slack = createSlackTransport({ fetchImpl: jsonFetch({ ok: true }).fetchImpl });

  it('parses block_actions choices and prefers container.message_ts', () => {
    expect(slack.parseInboundChoice(slackChoicePayload('ask-1|approve'))).toEqual({
      correlation_id: 'ask-1',
      option_id: 'approve',
      from: 'U-click',
      vendor_message_id: '1716141000.000200',
    });
  });

  it('falls back to message.ts when container.message_ts is absent', () => {
    expect(
      slack.parseInboundChoice(
        slackChoicePayload('ask-1|reject', {
          container: undefined,
          message: { ts: '1716141000.000400' },
        }),
      ),
    ).toEqual({
      correlation_id: 'ask-1',
      option_id: 'reject',
      from: 'U-click',
      vendor_message_id: '1716141000.000400',
    });
  });

  it.each([
    ['non-block_actions', { type: 'event_callback' }],
    ['empty actions', slackChoicePayload('ask-1|approve', { actions: [] })],
    ['missing value', slackChoicePayload('ask-1|approve', { actions: [{}] })],
    ['missing user', slackChoicePayload('ask-1|approve', { user: undefined })],
  ])('ignores %s payloads', (_name, payload) => {
    expect(slack.parseInboundChoice(payload)).toBeNull();
  });
});

describe('D-158 P2a Telegram parseInboundChoice', () => {
  const telegram = createTelegramTransport({
    fetchImpl: jsonFetch({ ok: true }).fetchImpl,
  });

  it('parses callback_query updates from non-bot users', () => {
    expect(telegram.parseInboundChoice(telegramChoicePayload('ask-1|approve'))).toEqual({
      correlation_id: 'ask-1',
      option_id: 'approve',
      from: '7001',
      vendor_message_id: '42',
    });
  });

  it.each([
    ['bot sender', telegramChoicePayload('ask-1|approve', { from: { id: 7001, is_bot: true } })],
    ['missing callback_query', { update_id: 10 }],
    ['missing data', { update_id: 10, callback_query: { from: { id: 7001 } } }],
  ])('ignores %s payloads', (_name, payload) => {
    expect(telegram.parseInboundChoice(payload)).toBeNull();
  });
});

describe('D-158 P2a interactive parsing coexists with plain text parsing', () => {
  it('keeps Slack plain messages and button presses on separate parsers', () => {
    const slack = createSlackTransport({ fetchImpl: jsonFetch({ ok: true }).fetchImpl });

    expectPlainTextAndChoiceStaySeparate(
      slack,
      {
        type: 'event_callback',
        event: {
          type: 'message',
          user: 'U-text',
          text: 'plain hello',
          ts: '1716141000.000500',
        },
      },
      {
        from: 'U-text',
        text: 'plain hello',
        vendor_message_id: '1716141000.000500',
      },
      slackChoicePayload('ask-plain|yes'),
      {
        correlation_id: 'ask-plain',
        option_id: 'yes',
        from: 'U-click',
        vendor_message_id: '1716141000.000200',
      },
    );
  });

  it('keeps Telegram plain messages and callback queries on separate parsers', () => {
    const telegram = createTelegramTransport({
      fetchImpl: jsonFetch({ ok: true }).fetchImpl,
    });

    expectPlainTextAndChoiceStaySeparate(
      telegram,
      {
        update_id: 1,
        message: {
          message_id: 88,
          text: 'plain hello',
          from: { id: 7001, is_bot: false },
        },
      },
      {
        from: '7001',
        text: 'plain hello',
        vendor_message_id: '88',
      },
      telegramChoicePayload('ask-plain|yes'),
      {
        correlation_id: 'ask-plain',
        option_id: 'yes',
        from: '7001',
        vendor_message_id: '42',
      },
    );
  });
});
