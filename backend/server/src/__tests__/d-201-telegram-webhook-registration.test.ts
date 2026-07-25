import { describe, expect, it, vi } from 'vitest';

import {
  createTelegramWebhookRegistrationAdapter,
  type TelegramWebhookRegistrationDeps,
} from '../connections/providers/telegram-webhook-registration.js';
import {
  createWebhookAsciiIdentifierParser,
} from '../webhook-ascii-identifier-parser.js';
import {
  createWebhookBoundedAsciiTokenParser,
} from '../webhook-bounded-ascii-token-parser.js';
import {
  createWebhookBoundedHttpsUrlParser,
} from '../webhook-bounded-https-url-parser.js';
import {
  createWebhookDecimalColonAsciiTokenParser,
} from '../webhook-decimal-colon-ascii-token-parser.js';
import {
  createWebhookPrefixedPositiveDecimalIdCodec,
} from '../webhook-prefixed-positive-decimal-id-codec.js';
import {
  createWebhookRegistrationJsonResponseReader,
} from '../webhook-registration-json-response-reader.js';
import {
  createWebhookRegistrationIdempotencyKeyParser,
} from '../webhook-registration-idempotency-key-parser.js';
import {
  webhookRegistrationIdempotencyKeyProfilePreset,
} from '../webhook-registration-idempotency-key-profile-presets.js';
import {
  webhookRegistrationResponseProfilePreset,
} from '../webhook-registration-response-profile-presets.js';
import {
  webhookRegistrationConnectionTokenProfilePreset,
} from '../webhook-registration-connection-token-profile-presets.js';
import {
  webhookEndpointProfilePreset,
} from '../webhook-endpoint-profile-presets.js';
import {
  webhookAsciiIdentifierEventTypeProfilePreset,
  webhookBoundedAsciiCredentialProfilePreset,
  webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const TELEGRAM_BOT_ID = '123456';
const EVENT_TYPE_PRESET = webhookAsciiIdentifierEventTypeProfilePreset(
  'telegram.bot-webhook.v1',
);
if (EVENT_TYPE_PRESET === null) {
  throw new Error('Telegram registration event-type test preset is unavailable');
}
const EVENT_TYPE_PARSER = createWebhookAsciiIdentifierParser(
  EVENT_TYPE_PRESET.parser,
);
const REMOTE_ID_PRESET =
  webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset(
    'telegram.bot-webhook.v1',
  );
if (REMOTE_ID_PRESET === null) {
  throw new Error('Telegram registration remote-id test preset is unavailable');
}
const REMOTE_ID_CODEC = createWebhookPrefixedPositiveDecimalIdCodec(
  REMOTE_ID_PRESET.codec,
);
const TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID = REMOTE_ID_CODEC.format(
  TELEGRAM_BOT_ID,
);
if (TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID === null) {
  throw new Error('Telegram registration remote-id test fixture is invalid');
}
const IDEMPOTENCY_KEY_PRESET =
  webhookRegistrationIdempotencyKeyProfilePreset('telegram.bot-webhook.v1');
if (IDEMPOTENCY_KEY_PRESET === null) {
  throw new Error('Telegram registration idempotency-key test preset is unavailable');
}
const IDEMPOTENCY_KEY_PARSER = createWebhookRegistrationIdempotencyKeyParser(
  IDEMPOTENCY_KEY_PRESET.parser,
);
const RESPONSE_PRESET = webhookRegistrationResponseProfilePreset(
  'telegram.bot-webhook.v1',
);
if (RESPONSE_PRESET === null) {
  throw new Error('Telegram registration-response test preset is unavailable');
}
const RESPONSE_READER = createWebhookRegistrationJsonResponseReader(
  RESPONSE_PRESET.reader,
);
const CREDENTIAL_PRESET = webhookBoundedAsciiCredentialProfilePreset(
  'telegram.bot-webhook.v1',
);
if (CREDENTIAL_PRESET === null) {
  throw new Error('Telegram registration credential test preset is unavailable');
}
const SECRET_PARSER = createWebhookBoundedAsciiTokenParser(
  CREDENTIAL_PRESET.parser,
);
const CONNECTION_TOKEN_PRESET = webhookRegistrationConnectionTokenProfilePreset(
  'telegram.bot-webhook.v1',
);
if (CONNECTION_TOKEN_PRESET === null) {
  throw new Error('Telegram registration connection-token test preset is unavailable');
}
const CONNECTION_TOKEN_PARSER = createWebhookDecimalColonAsciiTokenParser(
  CONNECTION_TOKEN_PRESET.parser,
);
const ENDPOINT_PRESET = webhookEndpointProfilePreset(
  'telegram.bot-webhook.v1',
);
if (ENDPOINT_PRESET === null) {
  throw new Error('Telegram endpoint test preset is unavailable');
}
const ENDPOINT_PARSER = createWebhookBoundedHttpsUrlParser(
  ENDPOINT_PRESET.parser,
);

const desired = {
  paired_connection_id: 'telegram-bot',
  desired: {
    ingress_id: 'whi_0123456789abcdef0123456789abcdef',
    environment: 'custom' as const,
    registration_target: null,
    endpoint_url: 'https://hooks.example/v1/webhooks/opaquePublicId_0123456789abcdef',
    event_types: ['message', 'callback_query'],
  },
};

const json = (body: unknown, status = 200): Response => new Response(
  JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } },
);

const botResult = (result: unknown): Response => json({ ok: true, result });

const botIdentity = (id = Number(TELEGRAM_BOT_ID)): Record<string, unknown> => ({
  id,
  is_bot: true,
  first_name: 'Recued test bot',
});

const webhookInfo = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  url: desired.desired.endpoint_url,
  has_custom_certificate: false,
  pending_update_count: 0,
  allowed_updates: desired.desired.event_types,
  ...overrides,
});

const emptyWebhookInfo = (): Record<string, unknown> => ({
  url: '',
  has_custom_certificate: false,
  pending_update_count: 0,
});

const makeAdapter = (overrides: Partial<TelegramWebhookRegistrationDeps> = {}) =>
  createTelegramWebhookRegistrationAdapter({
    connectionTokenParser: CONNECTION_TOKEN_PARSER,
    endpointParser: ENDPOINT_PARSER,
    eventTypeParser: EVENT_TYPE_PARSER,
    idempotencyKeyParser: IDEMPOTENCY_KEY_PARSER,
    remoteIdCodec: REMOTE_ID_CODEC,
    responseReader: RESPONSE_READER,
    secretParser: SECRET_PARSER,
    resolveConnection: async () => ({
      bot_token: '123456:TelegramBotToken_ABC-123456789',
    }),
    resolveActiveSecret: async () => 'existing_secret_token',
    resolveConfirmedEndpoint: async () => desired.desired.endpoint_url,
    generateSecret: () => 'generated_secret_token',
    ...overrides,
  });

describe('D-201 Slices 7G + 9AH + 9AM + 9AQ + 9AR + 9AW-9AX + 9BA Telegram managed webhook registration adapter', () => {
  it('rejects a registration target instead of silently ignoring foreign scope', async () => {
    const resolveConnection = vi.fn(async () => ({
      bot_token: '123456:TelegramBotToken_ABC-123456789',
    }));
    const fetchImpl = vi.fn(async () => botResult(emptyWebhookInfo()));
    const adapter = makeAdapter({ resolveConnection, fetchImpl });

    await expect(adapter.find({
      ...desired,
      desired: {
        ...desired.desired,
        registration_target: { kind: 'organization', key: 'openai' },
      },
    })).rejects.toMatchObject({ code: 'registration_input_invalid' });
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the injected bounded response reader for Bot API bodies', async () => {
    const responseReader = createWebhookRegistrationJsonResponseReader({
      kind: 'bounded_json_response.v1',
      max_bytes: 1,
      error_label: 'Injected Telegram fixture',
    });
    const fetchImpl = vi.fn(async () => botResult(botIdentity()));
    const adapter = makeAdapter({ responseReader, fetchImpl });

    await expect(adapter.find(desired)).rejects.toMatchObject({
      code: 'upstream_response_too_large',
      message: 'Injected Telegram fixture response exceeded the size limit',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the injected connection-token parser result as request authority', async () => {
    const compiled = createWebhookDecimalColonAsciiTokenParser({
      kind: 'decimal_colon_ascii_token.v1',
      max_digits: 2,
      max_suffix_characters: 3,
    });
    const parse = vi.fn(() => '12:Ab_' as string | null);
    let tokenReads = 0;
    const connection = Object.create(null) as { bot_token: string };
    Object.defineProperty(connection, 'bot_token', {
      enumerable: true,
      get() {
        tokenReads += 1;
        return tokenReads === 1 ? '34:Cd-' : '99:BAD';
      },
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/getMe')
        ? botResult(botIdentity())
        : botResult(webhookInfo()));
    const adapter = makeAdapter({
      connectionTokenParser: { preset: compiled.preset, parse },
      fetchImpl,
      resolveConnection: async () => connection,
    });

    await expect(adapter.find(desired)).resolves.toHaveLength(1);
    expect(tokenReads).toBe(1);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith('34:Cd-');
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://api.telegram.org/bot12%3AAb_/getMe',
    );
    expect(String(fetchImpl.mock.calls[1]![0])).toBe(
      'https://api.telegram.org/bot12%3AAb_/getWebhookInfo',
    );
  });

  it('rejects non-primitive resolved connection tokens before provider I/O', async () => {
    const fetchImpl = vi.fn();
    const adapter = makeAdapter({
      fetchImpl,
      resolveConnection: async () => ({
        bot_token: new String(
          '123456:TelegramBotToken_ABC-123456789',
        ) as unknown as string,
      }),
    });

    await expect(adapter.find(desired)).rejects.toMatchObject({
      code: 'connection_auth_invalid',
      message: 'Telegram managed registration requires a valid bot token',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the injected event-type parser for desired and provider values', async () => {
    const eventTypeParser = createWebhookAsciiIdentifierParser({
      kind: 'ascii_identifier.v1',
      max_bytes: 3,
    });
    const resolveConnection = vi.fn(async () => ({
      bot_token: '123456:TelegramBotToken_ABC-123456789',
    }));
    const desiredFetch = vi.fn();
    const desiredAdapter = makeAdapter({
      eventTypeParser,
      fetchImpl: desiredFetch,
      resolveConnection,
    });

    await expect(desiredAdapter.find(desired)).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Telegram managed registration input is invalid',
    });
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(desiredFetch).not.toHaveBeenCalled();

    const shortDesired = {
      ...desired,
      desired: { ...desired.desired, event_types: ['Msg'] },
    };
    const providerFetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/getMe')
        ? botResult(botIdentity())
        : botResult(webhookInfo({ allowed_updates: ['Message'] })));
    const providerAdapter = makeAdapter({ eventTypeParser, fetchImpl: providerFetch });

    await expect(providerAdapter.find(shortDesired)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'Telegram returned invalid allowed update types',
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it('uses one injected endpoint parser for desired, provider, and confirmed URLs', async () => {
    const desiredEndpoint =
      'https://hooks.example:9443/v1/webhooks/opaquePublicId_0123456789abcdef';
    const confirmedEndpoint =
      'https://old-hooks.example:9443/v1/webhooks/opaquePublicId_0123456789abcdef';
    const moved = {
      ...desired,
      desired: { ...desired.desired, endpoint_url: desiredEndpoint },
    };
    const compiled = createWebhookBoundedHttpsUrlParser({
      kind: 'bounded_https_url.v1',
      max_bytes: 4_096,
      allowed_ports: [9_443],
    });
    const parse = vi.fn(compiled.parse);
    const fetchImpl = vi.fn(async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const value = String(url);
      if (value.endsWith('/getMe')) return botResult(botIdentity());
      if (value.endsWith('/getWebhookInfo')) {
        return botResult(webhookInfo({ url: confirmedEndpoint }));
      }
      if (value.endsWith('/setWebhook')) return botResult(true);
      throw new Error(`unexpected Telegram test URL '${value}' with '${init?.method}'`);
    });
    const adapter = makeAdapter({
      endpointParser: { preset: compiled.preset, parse },
      fetchImpl,
      resolveConfirmedEndpoint: async () => confirmedEndpoint,
    });

    await expect(adapter.update(
      moved,
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      'recued-update-key',
    )).resolves.toMatchObject({ endpoint_url: desiredEndpoint });

    expect(parse.mock.calls).toEqual([
      [desiredEndpoint],
      [desiredEndpoint],
      [confirmedEndpoint],
      [confirmedEndpoint],
      [desiredEndpoint],
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]![1]?.body)))
      .toMatchObject({ url: desiredEndpoint });
  });

  it('uses the injected idempotency-key parser for create and update', async () => {
    const idempotencyKeyParser =
      createWebhookRegistrationIdempotencyKeyParser({
        kind: 'ascii_registration_idempotency_key.v1',
        max_characters: 1,
      });
    const fetchImpl = vi.fn();
    const adapter = makeAdapter({ idempotencyKeyParser, fetchImpl });

    await expect(adapter.create(desired, 'ab')).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Telegram registration idempotency key is invalid',
    });
    await expect(adapter.update(
      desired,
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      'ab',
    )).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Telegram registration idempotency key is invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed instead of regex-coercing non-string idempotency values', async () => {
    const fetchImpl = vi.fn();
    const resolveConnection = vi.fn(async () => ({
      bot_token: '123456:TelegramBotToken_ABC-123456789',
    }));
    const resolveActiveSecret = vi.fn(async () => 'existing_secret_token');
    const resolveConfirmedEndpoint = vi.fn(async () => desired.desired.endpoint_url);
    const generateSecret = vi.fn(() => 'generated_secret_token');
    const adapter = makeAdapter({
      fetchImpl,
      generateSecret,
      resolveActiveSecret,
      resolveConfirmedEndpoint,
      resolveConnection,
    });

    await expect(adapter.create(desired, null as never)).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Telegram registration idempotency key is invalid',
    });
    await expect(adapter.update(
      desired,
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      1 as never,
    )).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Telegram registration idempotency key is invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(generateSecret).not.toHaveBeenCalled();
    expect(resolveActiveSecret).not.toHaveBeenCalled();
    expect(resolveConfirmedEndpoint).not.toHaveBeenCalled();
    expect(resolveConnection).not.toHaveBeenCalled();
  });

  it('uses the injected remote-id codec for provider composition and committed ids', async () => {
    const remoteIdCodec = createWebhookPrefixedPositiveDecimalIdCodec({
      kind: 'fixed_prefix_positive_decimal_id.v1',
      prefix: 'bot_',
      max_digits: 16,
    });
    const providerFetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/getMe')
        ? botResult(botIdentity())
        : botResult(webhookInfo()));
    const providerAdapter = makeAdapter({
      fetchImpl: providerFetch,
      remoteIdCodec,
    });

    await expect(providerAdapter.find(desired)).resolves.toEqual([
      expect.objectContaining({
        endpoint: expect.objectContaining({
          remote_endpoint_id: 'bot_123456',
        }),
      }),
    ]);
    expect(providerFetch).toHaveBeenCalledTimes(2);

    const committedFetch = vi.fn();
    const resolveConnection = vi.fn(async () => ({
      bot_token: '123456:TelegramBotToken_ABC-123456789',
    }));
    const committedAdapter = makeAdapter({
      fetchImpl: committedFetch,
      remoteIdCodec,
      resolveConnection,
    });
    for (const invoke of [
      () => committedAdapter.read(desired, TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID),
      () => committedAdapter.update(
        desired,
        TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
        'update-key',
      ),
      () => committedAdapter.delete(desired, TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID),
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        code: 'upstream_response_invalid',
        message: 'Telegram managed webhook id is invalid',
      });
    }
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(committedFetch).not.toHaveBeenCalled();
  });

  it('fails closed instead of coercing non-string remote ids', async () => {
    const fetchImpl = vi.fn();
    const resolveConnection = vi.fn(async () => ({
      bot_token: '123456:TelegramBotToken_ABC-123456789',
    }));
    const resolveActiveSecret = vi.fn(async () => 'existing_secret_token');
    const resolveConfirmedEndpoint = vi.fn(async () => desired.desired.endpoint_url);
    const adapter = makeAdapter({
      fetchImpl,
      resolveActiveSecret,
      resolveConfirmedEndpoint,
      resolveConnection,
    });
    const boxedRemoteId = new String(
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
    ) as never;

    for (const invoke of [
      () => adapter.read(desired, boxedRemoteId),
      () => adapter.update(desired, boxedRemoteId, null as never),
      () => adapter.delete(desired, boxedRemoteId),
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        code: 'upstream_response_invalid',
        message: 'Telegram managed webhook id is invalid',
      });
    }
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(resolveActiveSecret).not.toHaveBeenCalled();
    expect(resolveConfirmedEndpoint).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('creates only after proving the singleton empty and returns one generated secret', async () => {
    const fetchImpl = vi.fn(async (
      url: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const value = String(url);
      if (value.endsWith('/getMe')) return botResult(botIdentity());
      if (value.endsWith('/getWebhookInfo')) return botResult(emptyWebhookInfo());
      return botResult(true);
    });
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.create(desired, 'recued-create-key')).resolves.toEqual({
      endpoint: {
        remote_endpoint_id: TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
        environment: 'custom',
        endpoint_url: desired.desired.endpoint_url,
        event_types: desired.desired.event_types,
        enabled: true,
        correlation_valid: true,
      },
      credential_result: { secret_token: 'generated_secret_token' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://api.telegram.org/bot123456%3ATelegramBotToken_ABC-123456789/getMe',
    );
    expect(String(fetchImpl.mock.calls[1]![0])).toContain('/getWebhookInfo');
    const [, setInit] = fetchImpl.mock.calls[2]!;
    expect(String(fetchImpl.mock.calls[2]![0])).toContain('/setWebhook');
    expect(setInit?.method).toBe('POST');
    expect((setInit?.headers as Headers).has('Idempotency-Key')).toBe(false);
    expect(JSON.parse(String(setInit?.body))).toEqual({
      url: desired.desired.endpoint_url,
      allowed_updates: desired.desired.event_types,
      secret_token: 'generated_secret_token',
      drop_pending_updates: false,
    });
    expect(setInit?.redirect).toBe('error');
    expect(setInit?.credentials).toBe('omit');
  });

  it('treats only the exact opaque URL as owned and refuses singleton replacement', async () => {
    let webhookReads = 0;
    const fetchImpl = vi.fn(async (
      url: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const value = String(url);
      if (value.endsWith('/getMe')) return botResult(botIdentity());
      webhookReads += 1;
      if (webhookReads === 1) {
        return botResult(webhookInfo({ allowed_updates: ['message'] }));
      }
      return botResult(webhookInfo({
        url: 'https://legacy.example/webhooks/telegram/telegram-bot',
      }));
    });
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.find(desired)).resolves.toEqual([
      expect.objectContaining({
        correlation: 'owned',
        endpoint: expect.objectContaining({
          event_types: ['message'],
          correlation_valid: true,
        }),
      }),
    ]);
    await expect(adapter.find(desired)).resolves.toEqual([
      expect.objectContaining({
        correlation: 'metadata_conflict',
        endpoint: expect.objectContaining({ correlation_valid: false }),
      }),
    ]);
    await expect(adapter.create(desired, 'recued-create-key'))
      .rejects.toMatchObject({ code: 'upstream_rejected' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('updates an owned prior URL with the exact active secret and never rotates it', async () => {
    const priorEndpoint = 'https://old-hooks.example/v1/webhooks/opaquePublicId_0123456789abcdef';
    const moved = {
      ...desired,
      desired: { ...desired.desired, endpoint_url: desired.desired.endpoint_url },
    };
    const resolveActiveSecret = vi.fn(async () => 'preserved_secret_token');
    const fetchImpl = vi.fn(async (
      url: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const value = String(url);
      if (value.endsWith('/getMe')) return botResult(botIdentity());
      if (value.endsWith('/getWebhookInfo')) {
        return botResult(webhookInfo({ url: priorEndpoint, allowed_updates: ['message'] }));
      }
      return botResult(true);
    });
    const generateSecret = vi.fn(() => 'must_not_be_generated');
    const adapter = makeAdapter({
      fetchImpl,
      resolveActiveSecret,
      resolveConfirmedEndpoint: async () => priorEndpoint,
      generateSecret,
    });

    await expect(adapter.update(
      moved,
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      'recued-update-key',
    )).resolves.toEqual(expect.objectContaining({
      endpoint_url: desired.desired.endpoint_url,
      event_types: desired.desired.event_types,
    }));
    const body = JSON.parse(String(fetchImpl.mock.calls[2]![1]?.body));
    expect(body.secret_token).toBe('preserved_secret_token');
    expect((fetchImpl.mock.calls[2]![1]?.headers as Headers)
      .has('Idempotency-Key')).toBe(false);
    expect(resolveActiveSecret).toHaveBeenCalledWith(desired.desired.ingress_id);
    expect(generateSecret).not.toHaveBeenCalled();
  });

  it('uses one injected credential parser for generated, active, and request-body secrets', async () => {
    const customSecret = 'Ab_1';
    const compiled = createWebhookBoundedAsciiTokenParser({
      kind: 'bounded_ascii_token.v1',
      max_characters: customSecret.length,
    });
    const parse = vi.fn(compiled.parse);
    let configured = false;
    const setBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const value = String(url);
      if (value.endsWith('/getMe')) return botResult(botIdentity());
      if (value.endsWith('/getWebhookInfo')) {
        return botResult(configured ? webhookInfo() : emptyWebhookInfo());
      }
      if (value.endsWith('/setWebhook')) {
        configured = true;
        setBodies.push(JSON.parse(String(init?.body)));
        return botResult(true);
      }
      throw new Error(`unexpected Telegram test URL '${value}'`);
    });
    const adapter = makeAdapter({
      fetchImpl,
      generateSecret: () => customSecret,
      resolveActiveSecret: async () => customSecret,
      secretParser: { preset: compiled.preset, parse },
    });

    await expect(adapter.create(
      desired,
      'recued-create-key',
    )).resolves.toMatchObject({
      credential_result: { secret_token: customSecret },
    });
    await expect(adapter.update(
      desired,
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      'recued-update-key',
    )).resolves.toMatchObject({
      remote_endpoint_id: TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
    });

    expect(parse.mock.calls).toEqual([
      [customSecret],
      [customSecret],
      [customSecret],
      [customSecret],
    ]);
    expect(setBodies).toEqual([
      expect.objectContaining({ secret_token: customSecret }),
      expect.objectContaining({ secret_token: customSecret }),
    ]);
  });

  it('does not update or delete a singleton whose URL is not locally owned', async () => {
    const fetchImpl = vi.fn(async (
      url: string | URL | Request,
      _init?: RequestInit,
    ) =>
      String(url).endsWith('/getMe')
        ? botResult(botIdentity())
        : botResult(webhookInfo({ url: 'https://someone-else.example/webhook' })));
    const adapter = makeAdapter({
      fetchImpl,
      resolveConfirmedEndpoint: async () =>
        'https://old-hooks.example/v1/webhooks/opaquePublicId_0123456789abcdef',
    });

    await expect(adapter.update(
      desired,
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      'recued-update-key',
    )).rejects.toMatchObject({ code: 'upstream_rejected' });
    await expect(adapter.delete(desired, TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID))
      .rejects.toMatchObject({ code: 'upstream_rejected' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('deletes without dropping pending updates and confirms absence through read', async () => {
    const responses = [
      botResult(webhookInfo()),
      botResult(emptyWebhookInfo()),
    ];
    const fetchImpl = vi.fn(async (
      url: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const value = String(url);
      if (value.endsWith('/getMe')) return botResult(botIdentity());
      if (value.endsWith('/deleteWebhook')) return botResult(true);
      return responses.shift()!;
    });
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.delete(desired, TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID))
      .resolves.toBeUndefined();
    await expect(adapter.read(desired, TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID))
      .resolves.toBeNull();
    expect(fetchImpl.mock.calls.map(([url]) => String(url).split('/').at(-1)))
      .toEqual(['getMe', 'getWebhookInfo', 'deleteWebhook', 'getWebhookInfo']);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]![1]?.body)))
      .toEqual({ drop_pending_updates: false });
  });

  it('does not treat a different bot with the same URL and events as a connection alias', async () => {
    const otherBotId = '654321';
    const otherRemoteId = REMOTE_ID_CODEC.format(otherBotId);
    if (otherRemoteId === null) throw new Error('other bot fixture is invalid');
    const otherContext = {
      ...desired,
      paired_connection_id: 'telegram-bot-other',
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith('/getMe')) return botResult(botIdentity(Number(otherBotId)));
      if (value.endsWith('/getWebhookInfo')) return botResult(webhookInfo());
      throw new Error('mutation must not be attempted');
    });
    const adapter = makeAdapter({
      resolveConnection: async () => ({
        bot_token: '654321:OtherTelegramBotToken_ABC-123456789',
      }),
      fetchImpl,
    });

    await expect(adapter.read(otherContext, TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID))
      .resolves.toBeNull();
    await expect(adapter.find(otherContext)).resolves.toEqual([
      expect.objectContaining({
        correlation: 'owned',
        endpoint: expect.objectContaining({ remote_endpoint_id: otherRemoteId }),
      }),
    ]);
    await expect(adapter.update(
      otherContext,
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      'recued-update-key',
    )).rejects.toMatchObject({ code: 'upstream_rejected' });
    await expect(adapter.delete(otherContext, TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID))
      .rejects.toMatchObject({ code: 'upstream_rejected' });
    expect(fetchImpl.mock.calls.map(([url]) => String(url).split('/').at(-1)))
      .toEqual(['getMe', 'getWebhookInfo']);
  });

  it('bounds and sanitizes provider failures before they reach owner errors', async () => {
    const invalidTokenFetch = vi.fn();
    const invalidTokenAdapter = makeAdapter({
      resolveConnection: async () => ({ bot_token: 'not-a-bot-token' }),
      fetchImpl: invalidTokenFetch,
    });
    await expect(invalidTokenAdapter.find(desired)).rejects.toMatchObject({
      code: 'connection_auth_invalid',
    });
    expect(invalidTokenFetch).not.toHaveBeenCalled();

    const malformed = makeAdapter({
      fetchImpl: (async () => new Response('{')) as typeof fetch,
    });
    await expect(malformed.find(desired)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'Telegram webhook registration returned malformed JSON',
    });

    const nonUtf8 = makeAdapter({
      fetchImpl: (async () => new Response(
        new Uint8Array([0xc3, 0x28]),
      )) as typeof fetch,
    });
    await expect(nonUtf8.find(desired)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'Telegram webhook registration returned invalid UTF-8',
    });

    const oversized = makeAdapter({
      fetchImpl: (async () => new Response('x'.repeat(128 * 1024 + 1))) as typeof fetch,
    });
    await expect(oversized.find(desired)).rejects.toMatchObject({
      code: 'upstream_response_too_large',
    });

    const rejected = makeAdapter({
      fetchImpl: (async () => json({
        ok: false,
        description: 'secret provider detail must not escape',
      }, 401)) as typeof fetch,
    });
    const error = await rejected.find(desired).catch((cause: unknown) => cause) as Error;
    expect(error).toMatchObject({ code: 'upstream_rejected' });
    expect(error.message).not.toContain('secret provider detail');

    const nonBotIdentity = makeAdapter({
      fetchImpl: (async () => botResult(botIdentity(0))) as typeof fetch,
    });
    await expect(nonBotIdentity.find(desired)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
    });

    const malformedEmptyInfo = makeAdapter({
      fetchImpl: (async (url: string | URL | Request) =>
        String(url).endsWith('/getMe')
          ? botResult(botIdentity())
          : botResult({
              ...emptyWebhookInfo(),
              allowed_updates: ['message', 'message'],
            })) as typeof fetch,
    });
    await expect(malformedEmptyInfo.find(desired)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
    });
  });
});
