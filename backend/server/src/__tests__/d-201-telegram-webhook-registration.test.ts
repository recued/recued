import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEBHOOK_PROFILE_IDS, WEBHOOK_PROFILE_REGISTRY } from '@recued/contracts';

import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { createWebhookDeliveryStore } from '../storage/webhook-delivery-store.js';
import {
  recuedSetsSecret,
  setRefusedSecretsAgain,
  WEBHOOK_REFUSAL_RUN_DEGRADES_AT,
  WEBHOOK_SECRET_SET_AGAIN_EVERY_MS,
} from '../webhook-refusal-run.js';
import { createWebhookManagedRegistrationService } from '../webhook-registration-reconciler.js';
import { createWebhookRegistrationRuntimeRegistry } from '../webhook-registration-runtime.js';
import {
  handleWebhookIngressGet,
  handleWebhookManagedRegistrationReconcile,
  type WebhookIngressRpcDeps,
} from '../webhook-ingress-handler.js';
import { webhookProfileRuntimeCapability } from '../webhook-profile-capability.js';

import {
  createTelegramWebhookRegistrationAdapter,
  type TelegramWebhookRegistrationDeps,
} from '../connections/providers/telegram-webhook-registration.js';
import {
  createWebhookLowercaseIdentifierEventTypeParser,
} from '../webhook-lowercase-identifier-event-type-parser.js';
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
  webhookLowercaseIdentifierEventTypeProfilePreset,
  webhookBoundedAsciiCredentialProfilePreset,
  webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const TELEGRAM_BOT_ID = '123456';
const EVENT_TYPE_PRESET = webhookLowercaseIdentifierEventTypeProfilePreset(
  'telegram.bot-webhook.v1',
);
if (EVENT_TYPE_PRESET === null) {
  throw new Error('Telegram registration event-type test preset is unavailable');
}
const EVENT_TYPE_PARSER = createWebhookLowercaseIdentifierEventTypeParser(
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
    const eventTypeParser = createWebhookLowercaseIdentifierEventTypeParser({
      kind: 'lowercase_identifier_event_type.v1',
      max_characters: 3,
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

    // D-201 Slice 10G — the desired names are checked where they are sent,
    // before any connection or request.
    await expect(desiredAdapter.create(desired, 'recued-create-key')).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Telegram managed registration input is invalid',
    });
    await expect(desiredAdapter.update(
      desired,
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      'recued-update-key',
    )).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Telegram managed registration input is invalid',
    });
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(desiredFetch).not.toHaveBeenCalled();

    // A search does not depend on them; Telegram's own names go through the
    // same parser.
    const providerFetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/getMe')
        ? botResult(botIdentity())
        : botResult(webhookInfo({ allowed_updates: ['message'] })));
    const providerAdapter = makeAdapter({ eventTypeParser, fetchImpl: providerFetch });

    await expect(providerAdapter.find(desired)).rejects.toMatchObject({
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
      // D-201 Slice 10G — the read-back of what Telegram kept after the set.
      [desiredEndpoint],
      [confirmedEndpoint],
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
    // D-201 Slice 10G — then reads back what Telegram kept.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://api.telegram.org/bot123456%3ATelegramBotToken_ABC-123456789/getMe',
    );
    expect(String(fetchImpl.mock.calls[1]![0])).toContain('/getWebhookInfo');
    expect(String(fetchImpl.mock.calls[3]![0])).toContain('/getWebhookInfo');
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

/** D-201 Slices 10G + 10K — a Bot API that keeps names as Telegram's server
 *  does, from its source (telegram-bot-api `Client.h`: `UpdateType`,
 *  `DEFAULT_ALLOWED_UPDATE_TYPES`; `Client.cpp`: `get_update_type_name`,
 *  `get_allowed_update_types`, `JsonUpdateTypes`, `JsonWebhookInfo`):
 *  - each name given is lowercased and kept if it names a kind, in the
 *    server's order; none known (or an empty list) means its default set, and
 *    a set call without names keeps the set as it was;
 *  - the default is every kind but `chat_member`, `message_reaction` and
 *    `message_reaction_count`, its two hidden kinds included;
 *  - getWebhookInfo lists `allowed_updates` whenever the set is not exactly the
 *    default, with or without a URL, and never lists the hidden kinds;
 *  - deleteWebhook leaves the set as it is;
 *  - D-201 Slice 10O (10L finding 5): a setWebhook with a URL less than a second
 *    after the last one is answered 429 with `retry_after` 1
 *    (`next_allowed_set_webhook_time_`); deleteWebhook is not limited. The
 *    fake's clock moves only by `sleep`, which the adapter is given.
 *  `bot.allowed_updates` is what getWebhookInfo lists (null: left out). Before
 *  10K this fake knew 23 kinds and called a set of 20 the default. */
const TELEGRAM_UPDATE_TYPES = [
  'message', 'edited_message', 'channel_post', 'edited_channel_post',
  'inline_query', 'chosen_inline_result', 'callback_query', 'custom_event',
  'custom_query', 'shipping_query', 'pre_checkout_query', 'poll', 'poll_answer',
  'my_chat_member', 'chat_member', 'chat_join_request', 'chat_boost',
  'removed_chat_boost', 'message_reaction', 'message_reaction_count',
  'business_connection', 'business_message', 'edited_business_message',
  'deleted_business_messages', 'purchased_paid_media', 'managed_bot',
  'guest_message', 'subscription', 'stopped_message_generation', 'widget_query',
  'shared_widget_query',
];
const TELEGRAM_HIDDEN_UPDATE_TYPES = ['custom_event', 'custom_query'];
const TELEGRAM_DEFAULT_SET = TELEGRAM_UPDATE_TYPES.filter((name) =>
  !['chat_member', 'message_reaction', 'message_reaction_count'].includes(name));
/** The public names of the default set: what an unlisted default reads as. */
const TELEGRAM_DEFAULT_UPDATE_TYPES = TELEGRAM_DEFAULT_SET.filter((name) =>
  !TELEGRAM_HIDDEN_UPDATE_TYPES.includes(name));

/** D-201 Slice 10BG — the address Telegram resolves this webhook's host to. */
const TELEGRAM_RESOLVED_IP = '198.51.100.20';

const telegramBotApi = () => {
  let set = [...TELEGRAM_DEFAULT_SET];
  const listed = (): string[] | null =>
    set.length === TELEGRAM_DEFAULT_SET.length
      && set.every((name) => TELEGRAM_DEFAULT_SET.includes(name))
      ? null
      : set.filter((name) => !TELEGRAM_HIDDEN_UPDATE_TYPES.includes(name));
  const bot = {
    url: '',
    secret_token: null as string | null,
    // D-201 Slice 10BB (10AY finding 7) — set at Telegram, as its Bot API
    // allows: a set without them puts back its documented defaults.
    max_connections: 40,
    /** D-201 Slice 10BG (10BF finding 2) — an address fixed at Telegram; with
     *  none, Telegram reports the one DNS gave (`RESOLVED_IP`), as it does. */
    ip_address: undefined as string | undefined,
    has_custom_certificate: false,
    get allowed_updates(): string[] | null { return listed(); },
    set allowed_updates(names: string[] | null) {
      set = names === null ? [...TELEGRAM_DEFAULT_SET] : [...names];
    },
  };
  const methods: string[] = [];
  /** Per-call faults, by method: what the next calls of it do instead. */
  const faults: Partial<Record<string, Array<() => unknown>>> = {};
  /** D-201 Slice 10O — the server's clock, and when it next takes a set. */
  const clock = { now: 0, nextSetAt: 0 };
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    clock.now += ms;
  };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf('/') + 1);
    methods.push(method);
    const fault = faults[method]?.shift();
    if (fault !== undefined) {
      const outcome = fault();
      if (outcome !== undefined) return outcome as Response;
    }
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : {};
    if (method === 'getMe') return botResult(botIdentity());
    if (method === 'getWebhookInfo') {
      const names = listed();
      return botResult({
        url: bot.url,
        has_custom_certificate: bot.has_custom_certificate,
        pending_update_count: 0,
        max_connections: bot.max_connections,
        // D-201 Slice 10BG (10BF finding 2) — the address in use, whenever a
        // webhook is set: the fixed one, or the one DNS gave. This mock reported
        // one only once fixed, so no test saw a set again send it back.
        ...(bot.url !== '' ? { ip_address: bot.ip_address ?? TELEGRAM_RESOLVED_IP } : {}),
        ...(names !== null ? { allowed_updates: names } : {}),
      });
    }
    if (method === 'setWebhook') {
      if (typeof body.url === 'string' && body.url !== '') {
        if (clock.now < clock.nextSetAt) {
          return json({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests: retry after 1',
            parameters: { retry_after: 1 },
          }, 429);
        }
        clock.nextSetAt = clock.now + 1_000;
      }
      if (Array.isArray(body.allowed_updates)) {
        const given = (body.allowed_updates as string[]).map((name) => name.toLowerCase());
        const kept = TELEGRAM_UPDATE_TYPES.filter((name) => given.includes(name));
        set = kept.length === 0 ? [...TELEGRAM_DEFAULT_SET] : kept;
      }
      bot.url = String(body.url);
      bot.secret_token = String(body.secret_token);
      bot.max_connections = typeof body.max_connections === 'number' ? body.max_connections : 40;
      bot.ip_address = typeof body.ip_address === 'string' ? body.ip_address : undefined;
      bot.has_custom_certificate = false;
      return botResult(true);
    }
    if (method === 'deleteWebhook') {
      bot.url = '';
      bot.secret_token = null;
      return botResult(true);
    }
    throw new Error(`unexpected Bot API method '${method}'`);
  });
  const state = () => ({ url: bot.url, secret_token: bot.secret_token, allowed_updates: bot.allowed_updates });
  return { bot, methods, faults, fetchImpl, state, clock, sleep, sleeps };
};

const withEvents = (eventTypes: readonly string[]) => ({
  ...desired,
  desired: { ...desired.desired, event_types: [...eventTypes] },
});

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

/** A managed Telegram webhook on the real store, reconciler and adapter, the
 *  Bot API faked as above. */
const managedTelegram = (selected: readonly string[]) => {
  const db = new Database(':memory:');
  databases.push(db);
  const store = createWebhookIngressStore(db, {
    getEncryptionKey: () => new Uint8Array(32).fill(9),
    newIngressId: () => desired.desired.ingress_id,
    newPublicId: () => 'opaquePublicId_0123456789abcdef',
    newCredentialSetRef: () => 'whc_0123456789abcdef0123456789abcdef',
  });
  const ingress = store.create({
    display_name: 'Telegram bot',
    profile_id: 'telegram.bot-webhook.v1',
    environment: 'custom',
    paired_connection_id: 'telegram-bot',
    registration_mode: 'managed_endpoint',
    selected_event_types: [...selected],
  });
  const api = telegramBotApi();
  let minted = 0;
  const adapter = makeAdapter({
    fetchImpl: api.fetchImpl,
    sleep: api.sleep,
    generateSecret: () => `generated_secret_token_${++minted}`,
    resolveActiveSecret: async (ingressId) =>
      (await store.readActiveCredentialVersions(ingressId))[0]?.credentials.secret_token ?? null,
    resolveConfirmedEndpoint: (ingressId) => store.get(ingressId)?.confirmed_endpoint_url ?? null,
  });
  const service = createWebhookManagedRegistrationService({
    store,
    adapters: createWebhookRegistrationRuntimeRegistry([adapter]),
    resolveCanonicalEndpoint: () => desired.desired.endpoint_url,
  });
  const deps = {
    store,
    managedRegistration: service,
    profileCapabilities: WEBHOOK_PROFILE_IDS.map((profileId) =>
      webhookProfileRuntimeCapability(WEBHOOK_PROFILE_REGISTRY[profileId], true)),
  } as unknown as WebhookIngressRpcDeps;
  return { db, store, ingress, api, service, deps };
};

describe('D-201 Slice 10G — the names Telegram keeps', () => {
  it('names a misspelled update name Telegram skipped, and removes the webhook it set before saying so', async () => {
    const api = telegramBotApi();
    const adapter = makeAdapter({ fetchImpl: api.fetchImpl });
    await expect(adapter.create(withEvents(['message', 'edited_mesage']), 'recued-create-key'))
      .rejects.toMatchObject({
        code: 'event_types_unknown',
        event_types: ['edited_mesage'],
        message: 'Telegram does not know the update name edited_mesage',
      });
    // Slice 10K: the undo reads first, and removes only a webhook at this URL.
    expect(api.methods).toEqual([
      'getMe', 'getWebhookInfo', 'setWebhook', 'getWebhookInfo', 'getWebhookInfo', 'deleteWebhook',
    ]);
    // Telegram holds no webhook, so no secret Recued did not store (it keeps
    // the names it was given, as its server does after deleteWebhook).
    expect(api.state()).toEqual({ url: '', secret_token: null, allowed_updates: ['message'] });
  });

  it('names every one when Telegram knew none and fell back to its default set', async () => {
    const api = telegramBotApi();
    await expect(makeAdapter({ fetchImpl: api.fetchImpl })
      .create(withEvents(['mesage', 'calback_query']), 'recued-create-key'))
      .rejects.toMatchObject({
        code: 'event_types_unknown',
        event_types: ['mesage', 'calback_query'],
      });
    expect(api.bot.url).toBe('');
  });

  it("D-201 Slice 10K — a webhook given exactly Telegram's public default is listed as given, as the server lists it, and lines up", async () => {
    // 10H finding 18: the server's default also holds two kinds it never lists,
    // so 26 names make a set of their own; the fake called 20 the default.
    expect(TELEGRAM_DEFAULT_UPDATE_TYPES).toHaveLength(26);
    const api = telegramBotApi();
    const adapter = makeAdapter({ fetchImpl: api.fetchImpl });
    await expect(adapter.create(withEvents(TELEGRAM_DEFAULT_UPDATE_TYPES), 'recued-create-key'))
      .resolves.toMatchObject({ credential_result: { secret_token: 'generated_secret_token' } });
    expect(api.bot.allowed_updates).toEqual(TELEGRAM_DEFAULT_UPDATE_TYPES);
    const readBack = await adapter.read(
      withEvents(TELEGRAM_DEFAULT_UPDATE_TYPES),
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
    );
    expect([...readBack!.event_types].sort()).toEqual([...TELEGRAM_DEFAULT_UPDATE_TYPES].sort());
  });

  it('D-201 Slice 10K — reads an unlisted default as the 26 public names the Bot API server sends', async () => {
    const api = telegramBotApi();
    Object.assign(api.bot, { url: desired.desired.endpoint_url, secret_token: 'existing_secret_token' });
    api.bot.allowed_updates = null;
    const readBack = await makeAdapter({ fetchImpl: api.fetchImpl }).read(
      withEvents(TELEGRAM_DEFAULT_UPDATE_TYPES),
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
    );
    expect(readBack!.event_types).toEqual(TELEGRAM_DEFAULT_UPDATE_TYPES);
  });

  it('on an update, names the skipped one and leaves Telegram on the secret Recued holds', async () => {
    const api = telegramBotApi();
    Object.assign(api.bot, {
      url: desired.desired.endpoint_url,
      secret_token: 'existing_secret_token',
      allowed_updates: ['message'],
    });
    await expect(makeAdapter({ fetchImpl: api.fetchImpl }).update(
      withEvents(['message', 'edited_mesage']),
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      'recued-update-key',
    )).rejects.toMatchObject({ code: 'event_types_unknown', event_types: ['edited_mesage'] });
    expect(api.bot).toMatchObject({
      url: desired.desired.endpoint_url,
      secret_token: 'existing_secret_token',
      allowed_updates: ['message'],
    });
  });

  it('refuses a name Telegram would rewrite, before any request', async () => {
    const api = telegramBotApi();
    await expect(makeAdapter({ fetchImpl: api.fetchImpl })
      .create(withEvents(['Message']), 'recued-create-key'))
      .rejects.toMatchObject({ code: 'registration_input_invalid' });
    expect(api.methods).toEqual([]);
  });

  it('through the reconciler: a skipped name stores nothing and leaves Telegram nothing, Settings gets the names, and the fixed set lines up', async () => {
    const h = managedTelegram(['message', 'edited_mesage']);
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toMatchObject({
      code: 'event_types_unknown',
      event_types: ['edited_mesage'],
    });
    expect(h.store.listCredentialVersions(h.ingress.ingress_id)).toEqual([]);
    // Slice 10K (10H finding 17): stored under its own code, with the names.
    expect(h.store.get(h.ingress.ingress_id)).toMatchObject({
      remote_endpoint_id: null,
      last_error_code: 'managed_registration_event_types_unknown',
      last_error_event_types: ['edited_mesage'],
    });
    expect(h.api.state()).toMatchObject({ url: '', secret_token: null });
    // Over the RPC, under its own code with the names, for Settings to word.
    await expect(handleWebhookManagedRegistrationReconcile(
      h.deps,
      { ingress_id: h.ingress.ingress_id },
      { instance_id: 'owner-webclient' },
    )).rejects.toMatchObject({
      code: 'webhook_registration_event_types_unknown',
      status: 409,
      details: { event_types: ['edited_mesage'] },
    });
    expect(h.api.bot.url).toBe('');

    h.store.update(h.ingress.ingress_id, { selected_event_types: ['message', 'edited_message'] });
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered', last_error_code: null });
    expect(h.store.get(h.ingress.ingress_id)!.last_error_event_types).toBeUndefined();
    const [active] = await h.store.readActiveCredentialVersions(h.ingress.ingress_id);
    expect(h.api.bot.secret_token).toBe(active!.credentials.secret_token);
    expect(h.api.bot.allowed_updates).toEqual(['message', 'edited_message']);
  });

  it('switches off a managed webhook holding a name saved before Slice 10C: cleanup never reads the names', async () => {
    const h = managedTelegram(['message']);
    await h.service.reconcile(h.ingress.ingress_id);
    expect(h.api.bot.url).toBe(desired.desired.endpoint_url);
    // A name the grammar refuses now, saved under the old broad shape.
    h.db.prepare('UPDATE webhook_ingresses SET selected_event_types_json = ? WHERE ingress_id = ?')
      .run(JSON.stringify(['Message']), h.ingress.ingress_id);
    h.db.prepare("UPDATE webhook_ingresses SET intake_state = 'enabled' WHERE ingress_id = ?")
      .run(h.ingress.ingress_id);
    const before = h.api.methods.length;
    await expect(h.service.cleanup(h.ingress.ingress_id, 'disable')).resolves.toMatchObject({
      intake_state: 'disabled',
      remote_endpoint_id: null,
    });
    expect(h.api.methods.slice(before)).toContain('deleteWebhook');
    expect(h.api.state()).toEqual({ url: '', secret_token: null, allowed_updates: ['message'] });
  });
});

describe('D-201 Slice 10K — a Telegram undo, update and default as the Bot API server has them', () => {
  const OTHER_URL = 'https://hooks.example/v1/webhooks/otherIngressPublicId_0123456789';

  it("an undo whose read-back failed removes only this ingress's webhook, never one another ingress set meanwhile", async () => {
    // 10H finding 15: the undo deleted whatever webhook the bot held.
    const api = telegramBotApi();
    api.faults.getWebhookInfo = [
      () => undefined, // the create's own check that the bot holds none
      () => {
        // Another ingress sets the bot's one webhook, and the read-back fails.
        Object.assign(api.bot, { url: OTHER_URL, secret_token: 'other_secret_token' });
        throw new TypeError('fetch failed');
      },
    ];
    await expect(makeAdapter({ fetchImpl: api.fetchImpl })
      .create(withEvents(['message']), 'recued-create-key')).rejects.toBeDefined();
    expect(api.methods).not.toContain('deleteWebhook');
    expect(api.state()).toMatchObject({ url: OTHER_URL, secret_token: 'other_secret_token' });

    // Still at this ingress's URL: the undo removes it, as before.
    const own = telegramBotApi();
    own.faults.getWebhookInfo = [() => undefined, () => { throw new TypeError('fetch failed'); }];
    await expect(makeAdapter({ fetchImpl: own.fetchImpl })
      .create(withEvents(['message']), 'recued-create-key')).rejects.toBeDefined();
    expect(own.methods.at(-1)).toBe('deleteWebhook');
    expect(own.state()).toMatchObject({ url: '', secret_token: null });
  });

  // D-201 Slice 10AD (10AA finding 29) — it was settled as refused while the
  // webhook stood, when the read-back answered with a 4xx and the undo failed.
  it('a set that landed, its read-back refused with a 4xx and its undo failing, may stand: never called refused', async () => {
    const api = telegramBotApi();
    api.faults.getWebhookInfo = [
      () => undefined, // the create's check that the bot holds none
      () => json({ ok: false, error_code: 400, description: 'Bad Request: try again later' }, 400),
      () => { throw new TypeError('fetch failed'); }, // the undo's own read
    ];
    await expect(makeAdapter({ fetchImpl: api.fetchImpl })
      .create(withEvents(['message']), 'recued-create-key'))
      .rejects.toMatchObject({ code: 'upstream_unavailable', message: expect.stringMatching(/could not be removed/) });
    expect(api.state().url).not.toBe('');
    // The undo working, the read-back's own refusal is what it says.
    const undone = telegramBotApi();
    undone.faults.getWebhookInfo = [
      () => undefined,
      () => json({ ok: false, error_code: 400, description: 'Bad Request: try again later' }, 400),
    ];
    await expect(makeAdapter({ fetchImpl: undone.fetchImpl })
      .create(withEvents(['message']), 'recued-create-key'))
      .rejects.not.toMatchObject({ code: 'upstream_unavailable' });
    expect(undone.state()).toMatchObject({ url: '', secret_token: null });
  });

  // D-201 Slice 10AH (10AE finding 21) — the undo took any answer as removed,
  // where `delete` takes only `true`: a create was settled as refused while its
  // webhook stood.
  it("an undo Telegram answers with anything but true has not removed it: the create may stand", async () => {
    const api = telegramBotApi();
    api.faults.getWebhookInfo = [
      () => undefined, // the create's check that the bot holds none
      () => json({ ok: false, error_code: 400, description: 'Bad Request: try again later' }, 400),
      () => undefined, // the undo's own read finds it at this URL
    ];
    api.faults.deleteWebhook = [() => json({ ok: true, result: false })];
    await expect(makeAdapter({ fetchImpl: api.fetchImpl })
      .create(withEvents(['message']), 'recued-create-key'))
      .rejects.toMatchObject({ code: 'upstream_unavailable', message: expect.stringMatching(/could not be removed/) });
    expect(api.state().url).not.toBe('');
  });

  // D-201 Slice 10AH (10AE finding 7) — 10AD wrapped this one as set but
  // standing: the RPC said only that it was unconfirmed, and Settings showed
  // the bare code. The record was kept either way.
  it('a create whose names Telegram skipped names them whether or not its undo worked, and is kept for the sweep', async () => {
    const api = telegramBotApi();
    api.faults.deleteWebhook = [() => { throw new TypeError('fetch failed'); }];
    await expect(makeAdapter({ fetchImpl: api.fetchImpl })
      .create(withEvents(['message', 'edited_mesage']), 'recued-create-key'))
      .rejects.toMatchObject({
        code: 'event_types_unknown',
        event_types: ['edited_mesage'],
        message: 'Telegram does not know the update name edited_mesage',
      });
    expect(api.state().url).not.toBe('');

    const h = managedTelegram(['message', 'edited_mesage']);
    h.api.faults.deleteWebhook = [() => { throw new TypeError('fetch failed'); }];
    await expect(handleWebhookManagedRegistrationReconcile(
      h.deps,
      { ingress_id: h.ingress.ingress_id },
      { instance_id: 'owner-webclient' },
    )).rejects.toMatchObject({
      code: 'webhook_registration_event_types_unknown',
      status: 409,
      details: { event_types: ['edited_mesage'] },
    });
    expect(h.store.get(h.ingress.ingress_id)).toMatchObject({
      remote_endpoint_id: null,
      last_error_code: 'managed_registration_event_types_unknown',
      last_error_event_types: ['edited_mesage'],
    });
    expect(h.api.bot.url).not.toBe('');
    expect(h.store.listUnsettledCreates()).toHaveLength(1);
  });

  it('through the reconciler, such a create is kept for the sweep', async () => {
    const h = managedTelegram(['message']);
    h.api.faults.setWebhook = [() => {
      h.api.faults.getWebhookInfo = [
        () => json({ ok: false, error_code: 400, description: 'Bad Request: try again later' }, 400),
        () => { throw new TypeError('fetch failed'); },
      ];
      return undefined;
    }];
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    expect(h.api.bot.url).not.toBe('');
    expect(h.store.listUnsettledCreates()).toHaveLength(1);
  });

  it('an update whose names Telegram knew none of puts back the URL and names it had, and says so', async () => {
    // 10H finding 16: Telegram fell back to its default set under the held
    // secret, so every update type arrived. D-201 Slice 10O (10L finding 5):
    // the put-back is the second set in a second, which the server turns
    // away; it is waited out.
    const api = telegramBotApi();
    Object.assign(api.bot, { url: desired.desired.endpoint_url, secret_token: 'existing_secret_token' });
    api.bot.allowed_updates = ['message', 'callback_query'];
    await expect(makeAdapter({ fetchImpl: api.fetchImpl, sleep: api.sleep }).update(
      withEvents(['mesage', 'calback_query']),
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      'recued-update-key',
    )).rejects.toMatchObject({
      code: 'event_types_unknown',
      event_types: ['mesage', 'calback_query'],
      message: 'Telegram does not know any of the update names mesage, calback_query; it was put back to the updates it had',
    });
    expect(api.state()).toEqual({
      url: desired.desired.endpoint_url,
      secret_token: 'existing_secret_token',
      allowed_updates: ['message', 'callback_query'],
    });
    // Turned away once, waited the second it asked for, and put back.
    expect(api.sleeps).toEqual([1_000]);
  });

  // D-201 Slice 10BQ (10BM finding 16) — the put-back keeps the bot's connection
  // limit, as the update before it does: pinned by no test.
  it("an update's put-back keeps the bot's connection limit", async () => {
    const api = telegramBotApi();
    Object.assign(api.bot, { url: desired.desired.endpoint_url, secret_token: 'existing_secret_token', max_connections: 100 });
    api.bot.allowed_updates = ['message', 'callback_query'];
    await expect(makeAdapter({ fetchImpl: api.fetchImpl, sleep: api.sleep }).update(
      withEvents(['mesage', 'calback_query']),
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      'recued-update-key',
    )).rejects.toMatchObject({ code: 'event_types_unknown' });
    expect(api.bot).toMatchObject({ allowed_updates: ['message', 'callback_query'], max_connections: 100 });
  });

  it('says so when it cannot put them back', async () => {
    const api = telegramBotApi();
    Object.assign(api.bot, { url: desired.desired.endpoint_url, secret_token: 'existing_secret_token' });
    api.bot.allowed_updates = ['message'];
    api.faults.setWebhook = [() => undefined, () => { throw new TypeError('fetch failed'); }];
    await expect(makeAdapter({ fetchImpl: api.fetchImpl }).update(
      withEvents(['mesage']),
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      'recued-update-key',
    )).rejects.toMatchObject({
      code: 'event_types_unknown',
      message: expect.stringContaining('could not be put back to the updates it had'),
      // D-201 Slice 10O — said so the reconciler stores it.
      left_on_default: true,
    });
    // Telegram on its default under the held secret: the next pass reads it.
    expect(api.bot.allowed_updates).toBeNull();
  });

  it('through the reconciler, an update refused for names Telegram does not know stores them for Settings', async () => {
    const h = managedTelegram(['message']);
    await h.service.reconcile(h.ingress.ingress_id);
    h.store.update(h.ingress.ingress_id, { selected_event_types: ['message', 'edited_mesage'] });
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toMatchObject({
      code: 'event_types_unknown',
      event_types: ['edited_mesage'],
    });
    expect(h.store.get(h.ingress.ingress_id)).toMatchObject({
      registration_state: 'drifted',
      last_error_code: 'managed_registration_event_types_unknown',
      last_error_event_types: ['edited_mesage'],
    });
    // And Settings reads them in the webhook's view.
    await expect(handleWebhookIngressGet(
      h.deps,
      { ingress_id: h.ingress.ingress_id },
      { instance_id: 'owner-webclient' },
    )).resolves.toMatchObject({
      ingress: {
        health: {
          last_error_code: 'managed_registration_event_types_unknown',
          last_error_event_types: ['edited_mesage'],
        },
      },
    });
  });
});

describe('D-201 Slice 10O — Telegram registration as its Bot API server behaves', () => {
  it("waits out the server's one-second limit on a set once, and not a longer wait it is asked for", async () => {
    // A set less than a second after another (another pass, another ingress).
    const api = telegramBotApi();
    api.clock.nextSetAt = 1_000;
    await expect(makeAdapter({ fetchImpl: api.fetchImpl, sleep: api.sleep })
      .create(withEvents(['message']), 'recued-create-key'))
      .resolves.toMatchObject({ credential_result: { secret_token: 'generated_secret_token' } });
    expect(api.sleeps).toEqual([1_000]);
    expect(api.state()).toMatchObject({ url: desired.desired.endpoint_url });
    // A flood limit asks for longer: reported, not waited for.
    const flooded = telegramBotApi();
    flooded.faults.setWebhook = [() => json({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 30',
      parameters: { retry_after: 30 },
    }, 429)];
    await expect(makeAdapter({ fetchImpl: flooded.fetchImpl, sleep: flooded.sleep })
      .create(withEvents(['message']), 'recued-create-key'))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(flooded.sleeps).toEqual([]);
    expect(flooded.state()).toMatchObject({ url: '' });
  });

  it('a bot left on its default is stored as such, and the view says so', async () => {
    const h = managedTelegram(['message']);
    await h.service.reconcile(h.ingress.ingress_id);
    h.store.update(h.ingress.ingress_id, { selected_event_types: ['mesage'] });
    // A later pass. The update's set goes through; the put-back cannot.
    h.api.clock.now += 60_000;
    h.api.faults.setWebhook = [() => undefined, () => { throw new TypeError('fetch failed'); }];
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toMatchObject({
      code: 'event_types_unknown',
      event_types: ['mesage'],
      left_on_default: true,
    });
    expect(h.store.get(h.ingress.ingress_id)).toMatchObject({
      registration_state: 'drifted',
      last_error_code: 'managed_registration_event_types_unrestored',
      last_error_event_types: ['mesage'],
    });
    await expect(handleWebhookIngressGet(
      h.deps,
      { ingress_id: h.ingress.ingress_id },
      { instance_id: 'owner-webclient' },
    )).resolves.toMatchObject({
      ingress: {
        health: {
          last_error_code: 'managed_registration_event_types_unrestored',
          last_error_event_types: ['mesage'],
        },
      },
    });
    // Fixed and lined up again: the code goes.
    h.store.update(h.ingress.ingress_id, { selected_event_types: ['message'] });
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered', last_error_code: null });
  });

  it('the RPC says so too, beside the names', async () => {
    const h = managedTelegram(['message']);
    await h.service.reconcile(h.ingress.ingress_id);
    h.store.update(h.ingress.ingress_id, { selected_event_types: ['mesage'] });
    h.api.clock.now += 60_000;
    h.api.faults.setWebhook = [() => undefined, () => { throw new TypeError('fetch failed'); }];
    const reconcileOverRpc = () => handleWebhookManagedRegistrationReconcile(
      h.deps,
      { ingress_id: h.ingress.ingress_id },
      { instance_id: 'owner-webclient' },
    ).then(() => { throw new Error('expected a refusal'); }, (error: unknown) => error as { code: string; details: unknown });
    const couldNot = await reconcileOverRpc();
    expect(couldNot.code).toBe('webhook_registration_event_types_unknown');
    expect(couldNot.details).toEqual({ event_types: ['mesage'], left_on_default: true });
    // D-201 Slice 10AD (10AA finding 25) — tried again: Recued's own put-back
    // left it on its default, so it still could not be put back. 10Z said it
    // was on its default already (`was_on_default`), as this case asserted.
    h.api.clock.now += 60_000;
    const again = await reconcileOverRpc();
    expect(again.details).toEqual({ event_types: ['mesage'], left_on_default: true });
  });

  it('refuses custom_event and custom_query by name before any request: Telegram never lists them', async () => {
    // 10L finding 15: the grammar and the server's parser take them, but a
    // webhook given one could never read back as given.
    const api = telegramBotApi();
    await expect(makeAdapter({ fetchImpl: api.fetchImpl })
      .create(withEvents(['message', 'custom_event']), 'recued-create-key'))
      .rejects.toMatchObject({ code: 'event_types_unknown', event_types: ['custom_event'] });
    await expect(makeAdapter({ fetchImpl: api.fetchImpl }).update(
      withEvents(['custom_query', 'message']),
      TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
      'recued-update-key',
    )).rejects.toMatchObject({ code: 'event_types_unknown', event_types: ['custom_query'] });
    expect(api.methods).toEqual([]);

    // Through the reconciler: named for Settings, and the bot given nothing.
    const h = managedTelegram(['message', 'custom_event']);
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'event_types_unknown', event_types: ['custom_event'] });
    expect(h.api.methods).not.toContain('setWebhook');
    expect(h.store.get(h.ingress.ingress_id)).toMatchObject({
      last_error_code: 'managed_registration_event_types_unknown',
      last_error_event_types: ['custom_event'],
    });
  });
});

describe('D-201 Slice 10T — Telegram retries that never land over another, and a default kept named', () => {
  const OTHER_URL = 'https://other.example.test/telegram-hook';
  /** Another party sets the bot's webhook just before this adapter's set
   *  arrives, so the server's one-second limit refuses the adapter's. */
  const otherSetsFirst = (api: ReturnType<typeof telegramBotApi>) => () => {
    api.bot.url = OTHER_URL;
    api.bot.secret_token = 'not-recueds';
    api.clock.nextSetAt = api.clock.now + 1_000;
    return undefined;
  };
  const setCalls = (api: ReturnType<typeof telegramBotApi>) =>
    api.methods.filter((method) => method === 'setWebhook').length;

  it("a bot an earlier pass left on Telegram's default is reported left there, never 'put back' (10Q finding 7)", async () => {
    const h = managedTelegram(['message']);
    await h.service.reconcile(h.ingress.ingress_id);
    h.store.update(h.ingress.ingress_id, { selected_event_types: ['mesage'] });
    h.api.clock.now += 60_000;
    h.api.faults.setWebhook = [() => undefined, () => { throw new TypeError('fetch failed'); }];
    // Its put-back failed: it could not be put back.
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .rejects.toMatchObject({ left_on_default: true, was_on_default: false });
    expect(h.store.get(h.ingress.ingress_id)!.last_error_code)
      .toBe('managed_registration_event_types_unrestored');
    expect(h.api.bot.allowed_updates).toBeNull();
    // The owner tries again, as Settings offers. The bot reads back as the
    // default's names: 10O "put back" all of them and called it a restore.
    h.api.clock.now += 60_000;
    const before = setCalls(h.api);
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toMatchObject({
      code: 'event_types_unknown',
      event_types: ['mesage'],
      left_on_default: true,
      // D-201 Slice 10AD (10AA finding 25) — Recued's own put-back left it on
      // its default: still one that could not be put back. 10Z said it was on
      // its default already, losing that.
      was_on_default: false,
    });
    expect(setCalls(h.api) - before).toBe(1);
    expect(h.store.get(h.ingress.ingress_id)).toMatchObject({
      last_error_code: 'managed_registration_event_types_unrestored',
      last_error_event_types: ['mesage'],
    });
    // Fixed and lined up again: the code goes, as the others do.
    h.store.update(h.ingress.ingress_id, { selected_event_types: ['message'] });
    h.api.clock.now += 60_000;
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered', last_error_code: null });
  });

  it('a read that failed after the set loses the flag for that pass only: the next pass finds the default and says so', async () => {
    const h = managedTelegram(['message']);
    await h.service.reconcile(h.ingress.ingress_id);
    h.store.update(h.ingress.ingress_id, { selected_event_types: ['mesage'] });
    h.api.clock.now += 60_000;
    // The set goes through; the read after it, which says what Telegram kept, does not.
    h.api.faults.setWebhook = [() => {
      h.api.faults.getWebhookInfo = [() => { throw new TypeError('fetch failed'); }];
      return undefined;
    }];
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    expect(h.api.bot.allowed_updates).toBeNull();
    expect(['managed_registration_event_types_unrestored', 'managed_registration_event_types_on_default'])
      .not.toContain(h.store.get(h.ingress.ingress_id)!.last_error_code);
    h.api.clock.now += 60_000;
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toMatchObject({
      code: 'event_types_unknown',
      event_types: ['mesage'],
      left_on_default: true,
      was_on_default: true,
    });
    expect(h.store.get(h.ingress.ingress_id)).toMatchObject({
      last_error_code: 'managed_registration_event_types_on_default',
      last_error_event_types: ['mesage'],
    });
  });

  it('a create the limit refused checks the bot is still empty before it retries (10Q finding 8)', async () => {
    const api = telegramBotApi();
    api.faults.setWebhook = [otherSetsFirst(api)];
    await expect(makeAdapter({ fetchImpl: api.fetchImpl, sleep: api.sleep })
      .create(withEvents(['message']), 'recued-create-key'))
      .rejects.toMatchObject({ code: 'upstream_rejected', message: expect.stringMatching(/already has a webhook/) });
    // Waited, checked, and never sent again: the other webhook stands.
    expect(api.sleeps).toEqual([1_000]);
    expect(setCalls(api)).toBe(1);
    expect(api.state()).toMatchObject({ url: OTHER_URL, secret_token: 'not-recueds' });
  });

  it("an update the limit refused checks the bot is still Recued's before it retries (10Q finding 8)", async () => {
    const h = managedTelegram(['message']);
    await h.service.reconcile(h.ingress.ingress_id);
    h.store.update(h.ingress.ingress_id, { selected_event_types: ['message', 'edited_message'] });
    h.api.clock.now += 60_000;
    h.api.faults.setWebhook = [otherSetsFirst(h.api)];
    const before = setCalls(h.api);
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    expect(setCalls(h.api) - before).toBe(1);
    expect(h.api.state()).toMatchObject({ url: OTHER_URL, secret_token: 'not-recueds' });
  });

  it('a put-back the limit refused checks the bot is still at the URL just set before it retries (10Q finding 8)', async () => {
    const h = managedTelegram(['message']);
    await h.service.reconcile(h.ingress.ingress_id);
    expect(h.api.bot.allowed_updates).toEqual(['message']);
    h.store.update(h.ingress.ingress_id, { selected_event_types: ['mesage'] });
    h.api.clock.now += 60_000;
    // The update's set goes through and Telegram falls back to its default;
    // another party sets the bot just before the put-back, which the limit refuses.
    h.api.faults.setWebhook = [() => undefined, otherSetsFirst(h.api)];
    const before = setCalls(h.api);
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toMatchObject({
      code: 'upstream_rejected',
      message: expect.stringMatching(/changed while its update names were being put back/),
    });
    expect(setCalls(h.api) - before).toBe(2);
    expect(h.api.state()).toMatchObject({ url: OTHER_URL, secret_token: 'not-recueds' });
  });

  // D-201 Slice 10Z (10V finding 24) — 10T read an empty list as the default,
  // against a faked server that listed its default so; the Bot API server lists
  // one only for a set made of the kinds it never lists.
  it('a WebhookInfo listing no names is a set of the kinds Telegram never lists, not the default: left on the default, said so, and no put-back that would read as a restore', async () => {
    const h = managedTelegram(['message']);
    await h.service.reconcile(h.ingress.ingress_id);
    // Another party left the bot at this address on a hidden kind alone.
    h.api.bot.allowed_updates = ['custom_event'];
    expect(h.api.state().allowed_updates).toEqual([]);
    h.store.update(h.ingress.ingress_id, { selected_event_types: ['mesage'] });
    h.api.clock.now += 60_000;
    const before = setCalls(h.api);
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toMatchObject({
      code: 'event_types_unknown',
      event_types: ['mesage'],
      left_on_default: true,
      was_on_default: false,
    });
    // The update's set alone: sent as no names, a put-back sets the default.
    expect(setCalls(h.api) - before).toBe(1);
    expect(h.api.bot.allowed_updates).toBeNull();
    expect(h.store.get(h.ingress.ingress_id)!.last_error_code)
      .toBe('managed_registration_event_types_unrestored');
  });

  it('waits five seconds when asked, not six, and a second refusal after the wait is final (10Q finding 21)', async () => {
    const asking = (seconds: number) => () => json({
      ok: false,
      error_code: 429,
      description: `Too Many Requests: retry after ${seconds}`,
      parameters: { retry_after: seconds },
    }, 429);
    const five = telegramBotApi();
    five.faults.setWebhook = [asking(5)];
    await expect(makeAdapter({ fetchImpl: five.fetchImpl, sleep: five.sleep })
      .create(withEvents(['message']), 'recued-create-key')).resolves.toBeDefined();
    expect(five.sleeps).toEqual([5_000]);
    const six = telegramBotApi();
    six.faults.setWebhook = [asking(6)];
    await expect(makeAdapter({ fetchImpl: six.fetchImpl, sleep: six.sleep })
      .create(withEvents(['message']), 'recued-create-key')).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(six.sleeps).toEqual([]);
    expect(setCalls(six)).toBe(1);
    // Refused again after the one wait: reported, not waited out a second time.
    const twice = telegramBotApi();
    twice.faults.setWebhook = [asking(1), asking(1)];
    await expect(makeAdapter({ fetchImpl: twice.fetchImpl, sleep: twice.sleep })
      .create(withEvents(['message']), 'recued-create-key')).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(twice.sleeps).toEqual([1_000]);
    expect(setCalls(twice)).toBe(2);
    expect(twice.state()).toMatchObject({ url: '' });
  });

  it('the RPC names the update names Telegram never lists, for Settings to say so (10Q finding 19)', async () => {
    const h = managedTelegram(['message', 'custom_event']);
    await expect(handleWebhookManagedRegistrationReconcile(
      h.deps,
      { ingress_id: h.ingress.ingress_id },
      { instance_id: 'owner-webclient' },
    )).rejects.toMatchObject({
      code: 'webhook_registration_event_types_unknown',
      details: { event_types: ['custom_event'], never_listed: ['custom_event'] },
    });
    // A name it does not know at all is not one it never lists.
    const misspelt = managedTelegram(['message']);
    await misspelt.service.reconcile(misspelt.ingress.ingress_id);
    misspelt.store.update(misspelt.ingress.ingress_id, { selected_event_types: ['message', 'mesage'] });
    misspelt.api.clock.now += 60_000;
    const refused = await handleWebhookManagedRegistrationReconcile(
      misspelt.deps,
      { ingress_id: misspelt.ingress.ingress_id },
      { instance_id: 'owner-webclient' },
    ).catch((error: unknown) => error);
    expect(refused).toMatchObject({ details: { event_types: ['mesage'] } });
    expect((refused as { details: Record<string, unknown> }).details).not.toHaveProperty('never_listed');
  });
});

// D-201 Slice 10AN (the owner's call, 2026-11-20) — 10AD's limit for a late
// Telegram set: a create that landed after a later one committed replaced the
// bot's secret with one Recued never stored. Every message was refused for its
// signature, and the webhook read healthy until the owner switched it off and
// on.
describe('D-201 Slice 10AN — a Telegram webhook refusing every message', () => {
  const MINUTE = 60_000;
  const refusingTelegram = async () => {
    const h = managedTelegram(['message']);
    let stamp = 2_000_000_000_000;
    const deliveries = createWebhookDeliveryStore(h.db, {
      now: () => stamp,
      getEncryptionKey: () => new Uint8Array(32).fill(7),
    });
    await expect(h.service.reconcile(h.ingress.ingress_id)).resolves.toMatchObject({ registration_state: 'registered' });
    h.db.prepare(`UPDATE webhook_ingresses SET intake_state = 'enabled', enabled_at = ? WHERE ingress_id = ?`)
      .run(stamp, h.ingress.ingress_id);
    const deps = {
      ...h.deps,
      deliveryStore: deliveries,
      now: () => stamp,
      runtimeReadiness: async () => ({
        endpoint_url: desired.desired.endpoint_url,
        profile_runtime_available: true,
        paired_connection_available: true,
        listener_available: true,
        public_reachability_enabled: true,
        tls_ready: true,
        clock_ready: true,
        test_delivery_supported: false,
        vault_unlocked: true,
        server_unpaused: true,
      }),
    } as unknown as WebhookIngressRpcDeps;
    const health = async () => (await handleWebhookIngressGet(
      deps, { ingress_id: h.ingress.ingress_id }, { instance_id: 'owner-webclient' },
    )).ingress!.health;
    const refused = (count: number) => {
      for (let n = 0; n < count; n += 1) {
        stamp += MINUTE;
        // The Bot API server's clock too: a minute apart, past its limit on sets.
        h.api.clock.now += MINUTE;
        deliveries.recordRejectedDelivery({
          ingress_id: h.ingress.ingress_id,
          profile_id: 'telegram.bot-webhook.v1',
          environment: 'custom',
          received_at: stamp,
          reason_code: 'authentication_failed',
          http_status: 401,
        });
      }
    };
    const setAgain = () => setRefusedSecretsAgain({
      ingresses: h.store, deliveries, service: h.service, now: () => stamp,
    });
    const sets = () => h.api.methods.filter((method) => method === 'setWebhook').length;
    // D-201 Slice 10AR — and the Bot API server's clock with it.
    const advance = (ms: number) => {
      stamp += ms;
      h.api.clock.now += ms;
    };
    return { ...h, deliveries, health, refused, setAgain, sets, now: () => stamp, advance };
  };

  it('reads degraded, is set again with the secret it holds at most once an hour, and reads healthy once a message verifies', async () => {
    const w = await refusingTelegram();
    const stored = w.api.bot.secret_token;
    expect(stored).toBe('generated_secret_token_1');
    expect((await w.health()).status).toBe('healthy');
    // A late set: the bot's secret is one Recued never stored.
    w.api.bot.secret_token = 'secret_of_a_late_set';
    w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT - 1);
    // Two is a stray request to the address.
    expect((await w.health()).status).toBe('healthy');
    w.refused(1);
    const first = w.now() - (WEBHOOK_REFUSAL_RUN_DEGRADES_AT - 1) * MINUTE;
    // Before 10AN: healthy.
    expect(await w.health()).toMatchObject({
      status: 'degraded',
      refusing: { refused: WEBHOOK_REFUSAL_RUN_DEGRADES_AT, since: first, set_again: true },
    });
    expect((await w.health()).refusing).not.toHaveProperty('set_again_at');
    // Set again, with the secret it holds: the late set's is gone.
    const before = w.sets();
    await expect(w.setAgain()).resolves.toBe(1);
    expect(w.sets()).toBe(before + 1);
    expect(w.api.bot.secret_token).toBe(stored);
    expect((await w.health()).refusing).toMatchObject({ set_again_at: w.now() });
    // Within the hour: more refusals set nothing more (D-201 Slice 10AU: no
    // longer once a run, so not until a message verifies either).
    w.refused(2);
    await expect(w.setAgain()).resolves.toBe(0);
    expect(w.sets()).toBe(before + 1);
    // A message verifies: healthy again, nothing said.
    w.advance(MINUTE);
    w.store.recordAcceptedDelivery(w.ingress.ingress_id, w.now());
    const healed = await w.health();
    expect(healed.status).toBe('healthy');
    expect(healed).not.toHaveProperty('refusing');
    // A new run is a new one: set again once more, an hour after the last
    // (D-201 Slice 10AR, 10AM finding 10).
    w.api.bot.secret_token = 'secret_of_another_late_set';
    w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
    expect(await w.health()).toMatchObject({ status: 'degraded', refusing: { set_again: true } });
    expect((await w.health()).refusing).not.toHaveProperty('set_again_at');
    await expect(w.setAgain()).resolves.toBe(0);
    w.advance(WEBHOOK_SECRET_SET_AGAIN_EVERY_MS);
    await expect(w.setAgain()).resolves.toBe(1);
    expect(w.api.bot.secret_token).toBe(stored);
  });

  // D-201 Slice 10AR (10AM finding 10) — it was tried at every pass, every two
  // minutes: an hour after, now.
  it('a set again that fails is tried an hour later, the webhook degraded meanwhile and its card saying so', async () => {
    const w = await refusingTelegram();
    w.api.bot.secret_token = 'secret_of_a_late_set';
    w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
    w.api.faults.getWebhookInfo = [() => { throw new TypeError('fetch failed'); }];
    const log = vi.fn();
    await expect(setRefusedSecretsAgain({
      ingresses: w.store, deliveries: w.deliveries, service: w.service, now: w.now, log,
    })).resolves.toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(w.api.bot.secret_token).toBe('secret_of_a_late_set');
    const failedAt = w.now();
    const failed = await w.health();
    expect(failed).toMatchObject({ status: 'degraded', refusing: { set_again: true, set_again_failed_at: failedAt } });
    expect(failed.refusing).not.toHaveProperty('set_again_at');
    // The next pass asks nothing of Telegram.
    const calls = w.api.methods.length;
    w.advance(2 * MINUTE);
    await expect(w.setAgain()).resolves.toBe(0);
    expect(w.api.methods.length).toBe(calls);
    w.advance(WEBHOOK_SECRET_SET_AGAIN_EVERY_MS - 2 * MINUTE);
    await expect(w.setAgain()).resolves.toBe(1);
    expect(w.api.bot.secret_token).toBe('generated_secret_token_1');
    const done = (await w.health()).refusing;
    expect(done).toMatchObject({ set_again_at: w.now() });
    expect(done).not.toHaveProperty('set_again_failed_at');
  });

  // D-201 Slice 10BB (10AY finding 7) — the set again sent the URL and the
  // secret alone: Telegram put the bot's connection limit back to 40 and
  // dropped a certificate set there (its documented defaults).
  // D-201 Slice 10BG (10BF finding 2) — and never the address Telegram reports:
  // that is the one in use, DNS's too, and sent back it pinned the webhook to
  // it, so after the server's address changed nothing arrived.
  it("a set again keeps the bot's connection limit, never pins the address Telegram reports, and is refused over a certificate it cannot send back", async () => {
    const w = await refusingTelegram();
    // Set at Telegram by its owner, then a late set.
    w.api.bot.max_connections = 100;
    w.api.bot.secret_token = 'secret_of_a_late_set';
    w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
    const from = w.api.fetchImpl.mock.calls.length;
    await expect(w.setAgain()).resolves.toBe(1);
    const bodies = w.api.fetchImpl.mock.calls.slice(from)
      .filter(([input]) => String(input).endsWith('/setWebhook'))
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('ip_address');
    expect(w.api.bot).toMatchObject({ secret_token: 'generated_secret_token_1', max_connections: 100 });
    // Still resolved by DNS, so a new address for the server is followed.
    expect(w.api.bot.ip_address).toBeUndefined();
    // An address the owner fixed at Telegram is reset by it (the stated limit):
    // Recued cannot tell it from the one DNS gave.
    w.api.bot.ip_address = '203.0.113.7';
    w.api.bot.secret_token = 'secret_of_a_late_set';
    w.advance(WEBHOOK_SECRET_SET_AGAIN_EVERY_MS);
    w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
    await expect(w.setAgain()).resolves.toBe(1);
    expect(w.api.bot.ip_address).toBeUndefined();
    // A certificate set there: not set again, the bot left as it was, and said
    // under its own code, which the card words.
    const v = await refusingTelegram();
    v.api.bot.has_custom_certificate = true;
    v.api.bot.secret_token = 'secret_of_a_late_set';
    v.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
    const before = v.sets();
    await expect(v.service.setSecretAgain(v.ingress.ingress_id)).rejects.toThrow(/certificate Recued does not hold/);
    expect(v.sets()).toBe(before);
    expect(v.api.bot).toMatchObject({ has_custom_certificate: true, secret_token: 'secret_of_a_late_set' });
    expect(v.store.get(v.ingress.ingress_id)).toMatchObject({
      last_error_code: 'managed_registration_certificate_unheld',
    });
    // Through the pass too: a failed try, noted, with that code beside it.
    v.advance(WEBHOOK_SECRET_SET_AGAIN_EVERY_MS);
    v.refused(1);
    await expect(v.setAgain()).resolves.toBe(0);
    expect((await v.health()).refusing).toMatchObject({ set_again_failed_at: v.now() });
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBe('managed_registration_certificate_unheld');
    // The certificate gone from Telegram, the next set again lands, and the code
    // clears as drift does.
    v.api.bot.has_custom_certificate = false;
    v.advance(WEBHOOK_SECRET_SET_AGAIN_EVERY_MS);
    v.refused(1);
    await expect(v.setAgain()).resolves.toBe(1);
    expect(v.api.bot.secret_token).toBe('generated_secret_token_1');
    expect(v.store.get(v.ingress.ingress_id)).toMatchObject({ last_error_code: null });
  });

  // D-201 Slice 10BG (10BF finding 13) — an update from Recued (an event edit, a
  // drift repair) set the bot from its own setup alone: the connection limit
  // went back to 40. It is kept now; a fixed address set at Telegram is reset by
  // it, as by any set Recued makes (stated). D-201 Slice 10BQ — a certificate is
  // not: the update refuses beside one (below).
  it("an update keeps the bot's connection limit, as a set again does", async () => {
    const w = await refusingTelegram();
    w.api.bot.max_connections = 100;
    w.api.bot.allowed_updates = ['message', 'edited_message'];
    await w.service.reconcile(w.ingress.ingress_id);
    expect(w.api.bot).toMatchObject({ max_connections: 100, allowed_updates: ['message'] });
  });

  /** A certificate set at Telegram, over which the set again refused. */
  const refusedOverACertificate = async () => {
    const v = await refusingTelegram();
    v.api.bot.has_custom_certificate = true;
    v.api.bot.secret_token = 'secret_of_a_late_set';
    v.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
    await expect(v.service.setSecretAgain(v.ingress.ingress_id)).rejects.toThrow(/certificate Recued does not hold/);
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBe('managed_registration_certificate_unheld');
    return v;
  };

  // D-201 Slice 10BQ (10BM finding 15) — the owner's "Line the address up again"
  // beside a certificate set at Telegram: read back as wanted, it set nothing
  // but cleared the word for the certificate, so the card's advice (switch it
  // off and on) dropped it; read back otherwise, it took the update road, which
  // dropped it beside words saying Recued did not set the webhook again.
  it('beside a certificate: a read-back that sets nothing keeps its word, and the update refuses as the set again does', async () => {
    const v = await refusedOverACertificate();
    const before = v.sets();
    await expect(v.service.reconcile(v.ingress.ingress_id)).resolves.toMatchObject({ registration_state: 'registered' });
    expect(v.sets()).toBe(before);
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBe('managed_registration_certificate_unheld');
    // Changed at Telegram since: the update refuses, nothing set, the certificate kept.
    v.api.bot.allowed_updates = ['message', 'edited_message'];
    await expect(v.service.reconcile(v.ingress.ingress_id)).rejects.toBeDefined();
    expect(v.sets()).toBe(before);
    expect(v.api.bot).toMatchObject({ has_custom_certificate: true, allowed_updates: ['message', 'edited_message'] });
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBe('managed_registration_certificate_unheld');
    // The certificate gone from Telegram: the next reconcile sets it back, and the word goes.
    v.api.bot.has_custom_certificate = false;
    await expect(v.service.reconcile(v.ingress.ingress_id)).resolves.toMatchObject({ registration_state: 'registered' });
    expect(v.api.bot.allowed_updates).toEqual(['message']);
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBeNull();
  });

  // D-201 Slice 10BQ (10BM finding 16) — switched off, the word for a
  // certificate goes with the webhook's setup at Telegram: pinned by no test,
  // the card kept saying it until the webhook was switched back on.
  it('switched off after a refusal over a certificate: the word for it goes', async () => {
    const v = await refusedOverACertificate();
    await v.service.cleanup(v.ingress.ingress_id, 'disable');
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBeNull();
  });

  // D-201 Slice 10BT (10BS finding 11) — a drift that says nothing of the
  // certificate replaced its word, the next confirmation cleared that, and the
  // card then advised a switch off and on, which drops the certificate.
  it('beside a certificate: a failed read keeps its word, and the next read-back keeps it', async () => {
    const v = await refusedOverACertificate();
    v.api.faults.getWebhookInfo = [() => json({ ok: false, error_code: 502, description: 'Bad Gateway' }, 502)];
    await expect(v.service.reconcile(v.ingress.ingress_id)).rejects.toBeDefined();
    // Before 10BT: managed_registration_drift.
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBe('managed_registration_certificate_unheld');
    await expect(v.service.reconcile(v.ingress.ingress_id)).resolves.toMatchObject({ registration_state: 'registered' });
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBe('managed_registration_certificate_unheld');
    expect(v.api.bot.has_custom_certificate).toBe(true);
  });

  // D-201 Slice 10BT (10BS finding 12) — the word said why a set again was
  // refused while messages were; once one verifies none is needed. It never
  // ended while the certificate stood, and any stored code reads degraded.
  it('beside a certificate: a message that verifies ends its word, and the webhook reads healthy', async () => {
    const v = await refusedOverACertificate();
    // Drifted still, its setup there unconfirmed since the refusal: kept.
    v.advance(MINUTE);
    v.store.recordAcceptedDelivery(v.ingress.ingress_id, v.now());
    expect(v.store.get(v.ingress.ingress_id)).toMatchObject({
      registration_state: 'drifted', last_error_code: 'managed_registration_certificate_unheld',
    });
    await expect(v.service.reconcile(v.ingress.ingress_id)).resolves.toMatchObject({ registration_state: 'registered' });
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBe('managed_registration_certificate_unheld');
    v.advance(MINUTE);
    v.store.recordAcceptedDelivery(v.ingress.ingress_id, v.now());
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBeNull();
    // Before 10BT: degraded, a day on.
    v.advance(24 * 60 * MINUTE);
    expect((await v.health()).status).toBe('healthy');
  });

  // D-201 Slice 10BT (the 10BS review's gaps in tests) — only the certificate's
  // word is kept: a confirmation beside a certificate clears any other code
  // (keeping any code kept a stale drift for good); and a bot pointed elsewhere
  // is refused as not this webhook's before its certificate is looked at.
  it("beside a certificate, a read-back clears any other code, and an update names a bot not this webhook's first", async () => {
    const w = await refusingTelegram();
    w.api.bot.has_custom_certificate = true;
    w.db.prepare(`UPDATE webhook_ingresses SET last_error_code = 'managed_registration_drift' WHERE ingress_id = ?`)
      .run(w.ingress.ingress_id);
    await expect(w.service.reconcile(w.ingress.ingress_id)).resolves.toMatchObject({ registration_state: 'registered' });
    expect(w.store.get(w.ingress.ingress_id)?.last_error_code).toBeNull();
    // Pointed elsewhere at Telegram, with a certificate: not this webhook's.
    w.api.bot.url = 'https://elsewhere.example/bot-hook';
    const refused = await w.service.reconcile(w.ingress.ingress_id).catch((error: unknown) => error);
    expect(String((refused as Error).message)).toMatch(/ownership could not be confirmed/);
    expect(w.store.get(w.ingress.ingress_id)?.last_error_code).not.toBe('managed_registration_certificate_unheld');
    expect(w.api.bot.url).toBe('https://elsewhere.example/bot-hook');
  });

  // D-201 Slice 10BY (10BX finding 1) — a drift kept the certificate's word
  // whatever the read before it showed: with the bot pointed elsewhere without
  // one, the owner's "Line the address up again" and the hourly set again were
  // both refused as not this webhook's, and the card went on speaking of a
  // certificate the read had just shown gone.
  it("beside a certificate's word: a refusal after a read that finds none ends it, on either road", async () => {
    for (const road of ['line up again', 'set again'] as const) {
      const v = await refusedOverACertificate();
      v.api.bot.has_custom_certificate = false;
      v.api.bot.url = 'https://elsewhere.example/bot-hook';
      const refused = road === 'line up again'
        ? v.service.reconcile(v.ingress.ingress_id)
        : v.service.setSecretAgain(v.ingress.ingress_id);
      await expect(refused).rejects.toThrow(/ownership could not be confirmed/);
      // Before 10BY: managed_registration_certificate_unheld.
      expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBe('managed_registration_drift');
      expect(v.api.bot).toMatchObject({ url: 'https://elsewhere.example/bot-hook', has_custom_certificate: false });
    }
    // Pointed elsewhere with one: a certificate still stands there, and its word too.
    const v = await refusedOverACertificate();
    v.api.bot.url = 'https://elsewhere.example/bot-hook';
    await expect(v.service.reconcile(v.ingress.ingress_id)).rejects.toThrow(/ownership could not be confirmed/);
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBe('managed_registration_certificate_unheld');
    // Removed there, and other events set there: the set again goes through,
    // and the drift it finds ends the word, though the webhook was drifted.
    const w = await refusedOverACertificate();
    w.api.bot.has_custom_certificate = false;
    w.api.bot.allowed_updates = ['message', 'edited_message'];
    await expect(w.service.setSecretAgain(w.ingress.ingress_id)).resolves.toMatchObject({
      registration_state: 'drifted',
    });
    // Before 10BY: managed_registration_certificate_unheld, drifted already.
    expect(w.store.get(w.ingress.ingress_id)?.last_error_code).toBe('managed_registration_drift');
  });

  // D-201 Slice 10BY (10BX finding 4) — two halves of 10BT's keep no test
  // pinned: a setup gone takes the certificate's word with it, and the keep is
  // for that word alone (a drift that replaced no stored code passed them all).
  it("beside a certificate's word, a setup gone replaces it; and a drift replaces any other code", async () => {
    const v = await refusedOverACertificate();
    v.api.bot.url = '';
    v.api.bot.has_custom_certificate = false;
    await expect(v.service.reconcile(v.ingress.ingress_id)).rejects.toBeDefined();
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBe('managed_remote_missing');
    const w = await refusingTelegram();
    w.db.prepare(`UPDATE webhook_ingresses SET registration_state = 'drifted',
      last_error_code = 'managed_registration_unconfirmed' WHERE ingress_id = ?`).run(w.ingress.ingress_id);
    w.api.faults.getWebhookInfo = [() => json({ ok: false, error_code: 502, description: 'Bad Gateway' }, 502)];
    await expect(w.service.reconcile(w.ingress.ingress_id)).rejects.toBeDefined();
    expect(w.store.get(w.ingress.ingress_id)?.last_error_code).toBe('managed_registration_drift');
  });

  // D-201 Slice 10BY (the 10BX review's note) — an event edit replaced the
  // certificate's word with a drift, and the card advised a switch off and on,
  // which drops the certificate, until the next set again put the word back.
  it("beside a certificate's word, an event edit keeps it, and the update the edit needs is refused over it", async () => {
    const v = await refusedOverACertificate();
    v.store.update(v.ingress.ingress_id, { selected_event_types: ['message', 'edited_message'] });
    // Before 10BY: managed_registration_drift.
    expect(v.store.get(v.ingress.ingress_id)).toMatchObject({
      registration_state: 'drifted', last_error_code: 'managed_registration_certificate_unheld',
    });
    const before = v.sets();
    await expect(v.service.reconcile(v.ingress.ingress_id)).rejects.toThrow(/certificate Recued does not hold/);
    expect(v.sets()).toBe(before);
    expect(v.store.get(v.ingress.ingress_id)?.last_error_code).toBe('managed_registration_certificate_unheld');
    expect(v.api.bot).toMatchObject({ has_custom_certificate: true, allowed_updates: ['message'] });
  });

  it("a Telegram webhook the owner set up is never set again by Recued: its secret is theirs to set", async () => {
    expect(recuedSetsSecret({ profile_id: 'telegram.bot-webhook.v1', registration_mode: 'managed_endpoint' })).toBe(true);
    expect(recuedSetsSecret({ profile_id: 'telegram.bot-webhook.v1', registration_mode: 'manual' })).toBe(false);
    expect(recuedSetsSecret({ profile_id: 'github.webhook.v1', registration_mode: 'managed_endpoint' })).toBe(true);
    // The service makes these: Recued cannot set them.
    expect(recuedSetsSecret({ profile_id: 'stripe.event.v1', registration_mode: 'managed_endpoint' })).toBe(false);
    expect(recuedSetsSecret({ profile_id: 'paddle.notification.v1', registration_mode: 'managed_endpoint' })).toBe(false);
    expect(recuedSetsSecret({ profile_id: 'generic.static-header-token.v1', registration_mode: 'operation_bound' })).toBe(false);
    const w = await refusingTelegram();
    w.db.prepare(`UPDATE webhook_ingresses SET registration_mode = 'manual' WHERE ingress_id = ?`).run(w.ingress.ingress_id);
    w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
    await expect(w.setAgain()).resolves.toBe(0);
    // D-201 Slice 10AU (10AS finding 27) — none to set again: null, not a failure.
    await expect(w.service.setSecretAgain(w.ingress.ingress_id)).resolves.toBeNull();
    const health = await w.health();
    expect(health).toMatchObject({ status: 'degraded', refusing: { refused: WEBHOOK_REFUSAL_RUN_DEGRADES_AT } });
    expect(health.refusing).not.toHaveProperty('set_again');
  });

  // D-201 Slice 10AR (10AM findings 10, 12 and 28) — what no outsider can
  // steer, on the real reconciler and the Bot API server's fake.
  describe('D-201 Slice 10AR — bounded by time, and by what the webhook is now', () => {
    const HOUR = 60 * MINUTE;
    type World = Awaited<ReturnType<typeof refusingTelegram>>;
    /** Requests without the secret, all at once, a second on. */
    const burst = (w: World, count: number) => {
      w.advance(1_000);
      for (let n = 0; n < count; n += 1) {
        w.deliveries.recordRejectedDelivery({
          ingress_id: w.ingress.ingress_id,
          profile_id: 'telegram.bot-webhook.v1',
          environment: 'custom',
          received_at: w.now(),
          reason_code: 'authentication_failed',
          http_status: 401,
        });
      }
    };

    // 10AM finding 10 — a message every two minutes and four bad requests after
    // each: 30 sets an hour, the secret right throughout.
    it("an outsider's requests set it again at most once an hour, however its messages go", async () => {
      const w = await refusingTelegram();
      const before = w.sets();
      const passes: number[] = [];
      for (let minute = 2; minute <= 120; minute += 2) {
        w.advance(MINUTE);
        w.store.recordAcceptedDelivery(w.ingress.ingress_id, w.now());
        burst(w, 4);
        w.advance(MINUTE - 1_000);
        passes.push(await w.setAgain());
      }
      // The first pass, and the one an hour after it.
      expect(passes.flatMap((n, index) => (n === 1 ? [index] : []))).toEqual([0, 30]);
      expect(w.sets() - before).toBe(2);
      expect(w.api.bot.secret_token).toBe('generated_secret_token_1');
    });

    // 10AM finding 10 — one that cannot go through was tried at every pass,
    // with two Bot API calls and a warning.
    it('a set again that cannot go through is tried once an hour, and Telegram is asked nothing between', async () => {
      const w = await refusingTelegram();
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      // The bot's webhook was removed elsewhere.
      w.api.bot.url = '';
      w.api.bot.secret_token = null;
      const log = vi.fn();
      const pass = () => setRefusedSecretsAgain({
        ingresses: w.store, deliveries: w.deliveries, service: w.service, now: w.now, log,
      });
      await expect(pass()).resolves.toBe(0);
      expect(log).toHaveBeenCalledTimes(1);
      expect(w.store.get(w.ingress.ingress_id)).toMatchObject({ last_error_code: 'managed_remote_missing' });
      const calls = w.api.methods.length;
      for (let n = 0; n < 29; n += 1) {
        w.advance(2 * MINUTE);
        await expect(pass()).resolves.toBe(0);
      }
      expect(w.api.methods.length).toBe(calls);
      expect(log).toHaveBeenCalledTimes(1);
      w.advance(2 * MINUTE);
      await expect(pass()).resolves.toBe(0);
      expect(w.api.methods.slice(calls)).toEqual(['getMe', 'getWebhookInfo']);
      expect(log).toHaveBeenCalledTimes(2);
    });

    // The undo-each-fix run: a try that failed in an earlier run read as this
    // run's, on its card.
    it("a try that failed in an earlier run is not said on the next run's card", async () => {
      const w = await refusingTelegram();
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      w.api.faults.getWebhookInfo = [() => { throw new TypeError('fetch failed'); }];
      await expect(w.setAgain()).resolves.toBe(0);
      expect((await w.health()).refusing).toMatchObject({ set_again_failed_at: w.now() });
      // A message verifies, and a new run begins.
      w.advance(MINUTE);
      w.store.recordAcceptedDelivery(w.ingress.ingress_id, w.now());
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      const next = (await w.health()).refusing;
      expect(next).toMatchObject({ set_again: true });
      expect(next).not.toHaveProperty('set_again_failed_at');
      expect(next).not.toHaveProperty('set_again_at');
    });

    // 10AM's mutation I1 — a note that kept the first time set every later run
    // again at every pass, and the card lost the time.
    it('each run is set again once, an hour or more apart, and its card shows the latest', async () => {
      const w = await refusingTelegram();
      const passes: number[] = [];
      w.api.bot.secret_token = 'secret_of_a_late_set';
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      passes.push(await w.setAgain());
      const first = w.now();
      w.advance(MINUTE);
      w.store.recordAcceptedDelivery(w.ingress.ingress_id, w.now());
      w.api.bot.secret_token = 'secret_of_another_late_set';
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      passes.push(await w.setAgain());
      w.advance(first + WEBHOOK_SECRET_SET_AGAIN_EVERY_MS - w.now());
      passes.push(await w.setAgain());
      const second = w.now();
      expect(w.api.bot.secret_token).toBe('generated_secret_token_1');
      for (let n = 0; n < 3; n += 1) {
        w.advance(WEBHOOK_SECRET_SET_AGAIN_EVERY_MS);
        passes.push(await w.setAgain());
      }
      expect(passes).toEqual([1, 0, 1, 0, 0, 0]);
      expect((await w.health()).refusing).toMatchObject({ set_again_at: second });
    });

    // 10AM finding 12 — the pass's intake check, which the record called
    // defensive: two roads reach a webhook switched off and still set up.
    it('a webhook switched off and set up is never set again, by the pass or under its lock', async () => {
      // A reconcile before an enable.
      const beforeEnable = await refusingTelegram();
      beforeEnable.api.bot.secret_token = 'secret_of_a_late_set';
      beforeEnable.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      beforeEnable.db.prepare(`UPDATE webhook_ingresses SET intake_state = 'disabled', enabled_at = NULL WHERE ingress_id = ?`)
        .run(beforeEnable.ingress.ingress_id);
      await expect(beforeEnable.service.reconcile(beforeEnable.ingress.ingress_id)).resolves.toMatchObject({
        intake_state: 'disabled',
        registration_state: 'registered',
      });
      // The latch a deleted connection leaves, which the owner clears by hand.
      const latched = await refusingTelegram();
      latched.api.bot.secret_token = 'secret_of_a_late_set';
      latched.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      latched.store.failCloseForDeletedPairedConnection('telegram-bot', 'notification');
      expect(latched.store.get(latched.ingress.ingress_id)).toMatchObject({
        intake_state: 'disabled',
        registration_state: 'drifted',
        last_error_code: 'paired_connection_deleted',
      });
      for (const w of [beforeEnable, latched]) {
        const before = w.store.get(w.ingress.ingress_id);
        const calls = w.api.methods.length;
        await expect(w.setAgain()).resolves.toBe(0);
        // Not tried: a try is noted.
        expect(w.store.secretSetAgainFailedAt(w.ingress.ingress_id)).toBeNull();
        await expect(w.service.setSecretAgain(w.ingress.ingress_id)).resolves.toBeNull();
        expect(w.api.methods.length).toBe(calls);
        expect(w.api.bot.secret_token).toBe('secret_of_a_late_set');
        expect(w.store.get(w.ingress.ingress_id)).toEqual(before);
      }
    });

    it('a switch the pass did not see is read again under the lock', async () => {
      const w = await refusingTelegram();
      w.api.bot.secret_token = 'secret_of_a_late_set';
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      const calls = w.api.methods.length;
      // The connection is deleted once the pass has read the webhooks.
      const ingresses = {
        ...w.store,
        list: (input?: { include_retired?: boolean }) => {
          const rows = w.store.list(input);
          w.store.failCloseForDeletedPairedConnection('telegram-bot', 'notification');
          return rows;
        },
      };
      await expect(setRefusedSecretsAgain({
        ingresses, deliveries: w.deliveries, service: w.service, now: w.now,
      })).resolves.toBe(0);
      expect(w.api.methods.length).toBe(calls);
      expect(w.api.bot.secret_token).toBe('secret_of_a_late_set');
      expect(w.store.get(w.ingress.ingress_id)).toMatchObject({
        intake_state: 'disabled',
        last_error_code: 'paired_connection_deleted',
      });
    });

    // 10AM's mutation C4 — the set again's lock: untested.
    it("a set again waits for the webhook's lock, and a deleted connection landing meanwhile stops it", async () => {
      const w = await refusingTelegram();
      w.api.bot.secret_token = 'secret_of_a_late_set';
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      w.api.faults.getMe = [() => held.then(() => botResult(botIdentity()))];
      const sets = w.sets();
      const from = w.api.methods.length;
      const reconciling = w.service.reconcile(w.ingress.ingress_id).then(() => 'done', (error: unknown) => error);
      // Inside Telegram's getMe, the webhook's lock held.
      while (!w.api.methods.slice(from).includes('getMe')) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const setting = w.service.setSecretAgain(w.ingress.ingress_id)
        .then((set) => (set === null ? 'not set' : 'set'), (error: unknown) => error);
      w.store.failCloseForDeletedPairedConnection('telegram-bot', 'notification');
      release();
      // The reconcile under way finds the webhook changed, and keeps the latch.
      expect(await reconciling).toMatchObject({ code: 'state_changed' });
      expect(await setting).toBe('not set');
      expect(w.sets()).toBe(sets);
      expect(w.api.bot.secret_token).toBe('secret_of_a_late_set');
      expect(w.store.get(w.ingress.ingress_id)).toMatchObject({ last_error_code: 'paired_connection_deleted' });
    });

    // 10AS finding 5 — once per run, refused requests while the secret was
    // right used up the run's set again: a late set ten minutes on, with no
    // message verified, was never undone (0 sets over a day).
    it("an outsider's requests no longer use up the set again a later late set needs", async () => {
      const w = await refusingTelegram();
      // The secret right; three refused requests from someone with the address.
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      await expect(w.setAgain()).resolves.toBe(1);
      const first = w.now();
      expect(w.api.bot.secret_token).toBe('generated_secret_token_1');
      // Ten minutes on, a late set replaces it, and the bot's messages are refused.
      w.advance(10 * MINUTE);
      w.api.bot.secret_token = 'secret_of_a_late_set';
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      const passes: number[] = [];
      while (w.now() < first + WEBHOOK_SECRET_SET_AGAIN_EVERY_MS) {
        passes.push(await w.setAgain());
        w.advance(2 * MINUTE);
      }
      expect(passes.every((n) => n === 0)).toBe(true);
      // An hour after the first: undone. That hour is the bound.
      await expect(w.setAgain()).resolves.toBe(1);
      expect(w.api.bot.secret_token).toBe('generated_secret_token_1');
      expect((await w.health()).refusing).toMatchObject({ set_again_at: w.now() });
    });

    // 10AS finding 6 — the set again went through the full update, which set
    // what the bot holds back to Recued's in full.
    it('a set again sends the secret alone: the address the bot holds, no names, its pending updates kept', async () => {
      const w = await refusingTelegram();
      const address = w.api.bot.url;
      // A late set: another secret, and other names.
      w.api.bot.secret_token = 'secret_of_a_late_set';
      w.api.bot.allowed_updates = ['message', 'edited_message'];
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      const from = w.api.fetchImpl.mock.calls.length;
      await expect(w.setAgain()).resolves.toBe(1);
      const bodies = w.api.fetchImpl.mock.calls.slice(from)
        .filter(([input]) => String(input).endsWith('/setWebhook'))
        .map(([, init]) => JSON.parse(String(init?.body)) as unknown);
      // D-201 Slice 10BB (10AY finding 7) — and the bot's connection limit, as
      // Telegram reports it, which a set without it puts back to 40.
      expect(bodies).toEqual([{
        url: address, max_connections: 40, secret_token: 'generated_secret_token_1', drop_pending_updates: false,
      }]);
      expect(w.api.bot.secret_token).toBe('generated_secret_token_1');
      // Its names stay as they are there, and the webhook says it differs.
      expect(w.api.bot.allowed_updates).toEqual(['message', 'edited_message']);
      expect(w.store.get(w.ingress.ingress_id)).toMatchObject({
        registration_state: 'drifted',
        last_error_code: 'managed_registration_drift',
      });
      // The owner's own reconcile sets them back.
      await expect(w.service.reconcile(w.ingress.ingress_id)).resolves.toMatchObject({ registration_state: 'registered' });
      expect(w.api.bot.allowed_updates).toEqual(['message']);
      expect(w.api.bot.secret_token).toBe('generated_secret_token_1');
    });

    // The undo-each-fix review: a secret-only set again beside other drift wrote
    // the generic code over a more telling one.
    it('a webhook drifted already keeps what it says: the set again changes its secret, and only a match clears it', async () => {
      const w = await refusingTelegram();
      // Left on Telegram's default set by an earlier put-back that failed.
      w.api.bot.allowed_updates = null;
      w.db.prepare(`
        UPDATE webhook_ingresses SET registration_state = 'drifted',
          last_error_code = 'managed_registration_event_types_unrestored', last_error_event_types_json = ?
        WHERE ingress_id = ?
      `).run(JSON.stringify(['message']), w.ingress.ingress_id);
      w.api.bot.secret_token = 'secret_of_a_late_set';
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      await expect(w.setAgain()).resolves.toBe(1);
      expect(w.api.bot.secret_token).toBe('generated_secret_token_1');
      expect(w.store.get(w.ingress.ingress_id)).toMatchObject({
        registration_state: 'drifted',
        last_error_code: 'managed_registration_event_types_unrestored',
      });
    });

    it('a set again keeps the address the bot holds, never sets a bot pointed elsewhere, and retries only while it is this one', async () => {
      // At the address it was confirmed at, before a move Recued has not made.
      const held = await refusingTelegram();
      const old = 'https://old.example/v1/webhooks/opaquePublicId_0123456789abcdef';
      held.db.prepare(`UPDATE webhook_ingresses SET confirmed_endpoint_url = ? WHERE ingress_id = ?`)
        .run(old, held.ingress.ingress_id);
      held.api.bot.url = old;
      held.api.bot.secret_token = 'secret_of_a_late_set';
      held.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      await expect(held.setAgain()).resolves.toBe(1);
      expect(held.api.bot).toMatchObject({ url: old, secret_token: 'generated_secret_token_1' });
      expect(held.store.get(held.ingress.ingress_id)).toMatchObject({ registration_state: 'drifted' });
      // Pointed elsewhere: another's webhook, never set.
      const elsewhere = await refusingTelegram();
      elsewhere.api.bot.url = 'https://elsewhere.example/hook';
      elsewhere.api.bot.secret_token = 'theirs';
      elsewhere.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      const before = elsewhere.api.methods.length;
      await expect(elsewhere.setAgain()).resolves.toBe(0);
      expect(elsewhere.api.methods.slice(before)).not.toContain('setWebhook');
      expect(elsewhere.api.bot).toMatchObject({ url: 'https://elsewhere.example/hook', secret_token: 'theirs' });
      // The server's one set a second refuses the first; in that second the bot
      // was set elsewhere: not set again over it.
      const raced = await refusingTelegram();
      raced.api.bot.secret_token = 'secret_of_a_late_set';
      raced.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      raced.api.faults.setWebhook = [() => {
        raced.api.bot.url = 'https://elsewhere.example/hook';
        raced.api.bot.secret_token = 'theirs';
        return json({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 1',
          parameters: { retry_after: 1 },
        }, 429);
      }];
      const from = raced.api.methods.length;
      await expect(raced.setAgain()).resolves.toBe(0);
      expect(raced.api.methods.slice(from).filter((method) => method === 'setWebhook')).toHaveLength(1);
      expect(raced.api.bot).toMatchObject({ url: 'https://elsewhere.example/hook', secret_token: 'theirs' });
    });

    // The undo-each-fix run: through the reconciler, its own read first stops a
    // paired token now for another bot, from the same answer; `setSecret` is an
    // adapter operation in its own right, so it checks too.
    it('setSecret never sets another bot the paired token now names, though that bot points here', async () => {
      const api = telegramBotApi();
      api.bot.url = desired.desired.endpoint_url;
      api.bot.secret_token = 'secret_of_a_late_set';
      api.faults.getMe = [() => botResult(botIdentity(Number(TELEGRAM_BOT_ID) + 1))];
      const adapter = makeAdapter({
        fetchImpl: api.fetchImpl,
        sleep: api.sleep,
        resolveActiveSecret: async () => 'generated_secret_token_1',
        resolveConfirmedEndpoint: async () => desired.desired.endpoint_url,
      });
      await expect(adapter.setSecret!(desired, TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID!))
        .rejects.toMatchObject({ code: 'upstream_rejected' });
      expect(api.methods).not.toContain('setWebhook');
      expect(api.bot.secret_token).toBe('secret_of_a_late_set');
      // Its own bot: set, the secret alone.
      await expect(makeAdapter({
        fetchImpl: api.fetchImpl,
        sleep: api.sleep,
        resolveActiveSecret: async () => 'generated_secret_token_1',
        resolveConfirmedEndpoint: async () => desired.desired.endpoint_url,
      }).setSecret!(desired, TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID!)).resolves.toMatchObject({
        remote_endpoint_id: TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID,
        endpoint_url: desired.desired.endpoint_url,
      });
      expect(api.bot.secret_token).toBe('generated_secret_token_1');
    });

    // 10AS finding 27 — switched off between the pass's look and its lock,
    // nothing was sent, but it was noted as a failed try: switched back on, a
    // new run waited the hour.
    it('switched off before the lock is no failed try: switched back on, a new run is set again at once', async () => {
      const w = await refusingTelegram();
      w.api.bot.secret_token = 'secret_of_a_late_set';
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      const offAfterLooking = {
        ...w.store,
        list: (input?: { include_retired?: boolean }) => {
          const rows = w.store.list(input);
          w.db.prepare(`UPDATE webhook_ingresses SET intake_state = 'disabled', enabled_at = NULL WHERE ingress_id = ?`)
            .run(w.ingress.ingress_id);
          return rows;
        },
      };
      const log = vi.fn();
      const calls = w.api.methods.length;
      await expect(setRefusedSecretsAgain({
        ingresses: offAfterLooking, deliveries: w.deliveries, service: w.service, now: w.now, log,
      })).resolves.toBe(0);
      expect(w.api.methods.length).toBe(calls);
      expect(log).not.toHaveBeenCalled();
      expect(w.store.secretSetAgainFailedAt(w.ingress.ingress_id)).toBeNull();
      // Switched back on: a new run, set again at once.
      w.advance(MINUTE);
      w.db.prepare(`UPDATE webhook_ingresses SET intake_state = 'enabled', enabled_at = ? WHERE ingress_id = ?`)
        .run(w.now(), w.ingress.ingress_id);
      w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
      await expect(w.setAgain()).resolves.toBe(1);
      expect(w.api.bot.secret_token).toBe('generated_secret_token_1');
    });

    // 10AM finding 28 — a set again noted while the clock ran fast held the
    // next run until the clock passed it, and the card showed a time to come.
    // D-201 Slice 10AU (10AS finding 26) — ignored instead, a clock set back
    // let the pass set a webhook again at once: the note is brought back to
    // now, and holds the hour from there.
    it('a note ahead of now holds the hour from when the pass finds it, and the card shows no time to come', async () => {
      for (const note of ['noteSecretSetAgain', 'noteSecretSetAgainFailed'] as const) {
        const w = await refusingTelegram();
        w.api.bot.secret_token = 'secret_of_a_late_set';
        w.refused(WEBHOOK_REFUSAL_RUN_DEGRADES_AT);
        // Noted a day ahead: the clock was set back since, or ran ahead then.
        w.store[note](w.ingress.ingress_id, w.now() + 24 * HOUR);
        const read = (await w.health()).refusing;
        expect(read).toMatchObject({ set_again: true });
        expect(read).not.toHaveProperty('set_again_at');
        expect(read).not.toHaveProperty('set_again_failed_at');
        const sets = w.sets();
        await expect(w.setAgain()).resolves.toBe(0);
        expect(w.sets()).toBe(sets);
        const foundAt = w.now();
        const held = note === 'noteSecretSetAgain'
          ? w.store.secretSetAgainAt(w.ingress.ingress_id)
          : w.store.secretSetAgainFailedAt(w.ingress.ingress_id);
        expect(held).toBe(foundAt);
        // Still refused, an hour less a minute on: held.
        w.refused(1);
        w.advance(HOUR - 2 * MINUTE);
        await expect(w.setAgain()).resolves.toBe(0);
        // An hour after the pass found it, not a day: set again.
        w.advance(MINUTE);
        await expect(w.setAgain()).resolves.toBe(1);
        expect(w.api.bot.secret_token).toBe('generated_secret_token_1');
        const after = (await w.health()).refusing;
        expect(after).toMatchObject({ set_again_at: w.now() });
        expect(after).not.toHaveProperty('set_again_failed_at');
      }
    });
  });
});

// D-201 Slice 10BA (10AY finding 1) — Telegram's endpoint is the bot itself, so
// a stray, the endpoint this webhook commits and whatever the bot points at
// share one id. Counted as found, the stray was never settled, and a week on
// the card asked the owner to remove the webhook's own endpoint, or another
// service's.
describe("D-201 Slice 10BA — a Telegram stray, once its bot holds this webhook's endpoint or another's", () => {
  const HOUR = 60 * 60 * 1000;
  /** A first set that landed with its answer lost, then a sweep that could
   *  not remove it: one stray, the bot's own id. */
  const aStray = async (h: ReturnType<typeof managedTelegram>, clock: { now: number }) => {
    const id = h.ingress.ingress_id;
    h.api.faults.setWebhook = [() => {
      h.api.bot.url = desired.desired.endpoint_url;
      h.api.bot.secret_token = 'lost_secret';
      throw new TypeError('fetch failed');
    }];
    await expect(h.service.reconcile(id)).rejects.toBeDefined();
    h.api.faults.deleteWebhook = [() => json({ ok: false, error_code: 502, description: 'Bad Gateway' }, 502)];
    clock.now += 60_000;
    vi.setSystemTime(clock.now);
    await h.service.sweepUnsettledCreates();
    expect(h.store.listStrayEndpoints(id).map((stray) => stray.remote_endpoint_id))
      .toEqual([TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID]);
    return id;
  };

  it('the owner removed it at Telegram and switched the webhook on: the next sweep settles the stray, the bot left as it is', async () => {
    const h = managedTelegram(['message']);
    const clock = { now: 2_000_000_000_000 };
    vi.useFakeTimers({ now: clock.now, toFake: ['Date'] });
    try {
      const id = await aStray(h, clock);
      h.api.bot.url = '';
      h.api.bot.secret_token = null;
      clock.now += 30_000;
      vi.setSystemTime(clock.now);
      expect((await h.service.reconcile(id)).remote_endpoint_id).toBe(TELEGRAM_MANAGED_WEBHOOK_REMOTE_ID);
      const deletesBefore = h.api.methods.filter((method) => method === 'deleteWebhook').length;
      clock.now += HOUR;
      vi.setSystemTime(clock.now);
      // The stray, and the create whose answer was lost, both settled.
      await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 0, settled: 2, failed: 0 });
      expect(h.store.listStrayEndpoints(id)).toEqual([]);
      expect(h.store.listUnsettledCreates()).toEqual([]);
      // The webhook's own endpoint is never taken for the stray.
      expect(h.api.methods.filter((method) => method === 'deleteWebhook')).toHaveLength(deletesBefore);
      expect(h.api.bot.url).toBe(desired.desired.endpoint_url);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the bot pointed at another service's address: nothing of this webhook stands, so the stray is settled and that webhook left alone", async () => {
    const h = managedTelegram(['message']);
    const clock = { now: 2_000_000_000_000 };
    vi.useFakeTimers({ now: clock.now, toFake: ['Date'] });
    try {
      const id = await aStray(h, clock);
      h.api.bot.url = 'https://other-tool.example/telegram/hook';
      h.api.bot.secret_token = 'other_tools_secret';
      const deletesBefore = h.api.methods.filter((method) => method === 'deleteWebhook').length;
      clock.now += HOUR;
      vi.setSystemTime(clock.now);
      // The stray, and the create whose answer was lost, both settled.
      await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 0, settled: 2, failed: 0 });
      expect(h.store.listStrayEndpoints(id)).toEqual([]);
      expect(h.store.listUnsettledCreates()).toEqual([]);
      expect(h.api.methods.filter((method) => method === 'deleteWebhook')).toHaveLength(deletesBefore);
      expect(h.api.bot.url).toBe('https://other-tool.example/telegram/hook');
    } finally {
      vi.useRealTimers();
    }
  });

  it("its settle refused once, after the bot took this webhook's endpoint: the next sweep settles it", async () => {
    const h = managedTelegram(['message']);
    const clock = { now: 2_000_000_000_000 };
    vi.useFakeTimers({ now: clock.now, toFake: ['Date'] });
    try {
      const id = await aStray(h, clock);
      h.api.bot.url = '';
      h.api.bot.secret_token = null;
      clock.now += 30_000;
      vi.setSystemTime(clock.now);
      await h.service.reconcile(id);
      // Both of the sweep's settles refused once.
      const settle = vi.spyOn(h.store, 'settleStrayEndpoint').mockImplementationOnce(() => {
        throw new Error('the database is busy');
      });
      const settleRecord = vi.spyOn(h.store, 'settleUnsettledCreate').mockImplementation(() => {
        throw new Error('the database is busy');
      });
      clock.now += HOUR;
      vi.setSystemTime(clock.now);
      await h.service.sweepUnsettledCreates();
      expect(h.store.listStrayEndpoints(id)).toHaveLength(1);
      settle.mockRestore();
      settleRecord.mockRestore();
      clock.now += HOUR;
      vi.setSystemTime(clock.now);
      await h.service.sweepUnsettledCreates();
      expect(h.store.listStrayEndpoints(id)).toEqual([]);
      expect(h.api.bot.url).toBe(desired.desired.endpoint_url);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the bot still pointed at this address while nothing is committed: the stray is removed, as before', async () => {
    const h = managedTelegram(['message']);
    const clock = { now: 2_000_000_000_000 };
    vi.useFakeTimers({ now: clock.now, toFake: ['Date'] });
    try {
      const id = await aStray(h, clock);
      expect(h.store.get(id)!.remote_endpoint_id).toBeNull();
      clock.now += HOUR;
      vi.setSystemTime(clock.now);
      await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 1, failed: 0 });
      expect(h.store.listStrayEndpoints(id)).toEqual([]);
      expect(h.api.bot.url).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});
