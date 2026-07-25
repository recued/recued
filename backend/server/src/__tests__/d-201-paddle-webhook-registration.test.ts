import { describe, expect, it, vi } from 'vitest';

import {
  createPaddleWebhookRegistrationAdapter,
  type PaddleWebhookRegistrationDeps,
} from '../connections/providers/paddle-webhook-registration.js';
import {
  createWebhookRegistrationRuntimeRegistry,
  type ManagedWebhookRegistrationContext,
} from '../webhook-registration-runtime.js';
import {
  webhookFixedPrefixRegistrationRemoteIdProfilePreset,
  webhookDotSegmentEventTypeProfilePreset,
  webhookSegmentedAsciiCredentialProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';
import {
  createWebhookDotSegmentEventTypeParser,
  type WebhookDotSegmentEventTypeParser,
} from '../webhook-dot-segment-event-type-parser.js';
import {
  createWebhookRegistrationJsonResponseReader,
} from '../webhook-registration-json-response-reader.js';
import {
  createWebhookRegistrationIdempotencyKeyParser,
} from '../webhook-registration-idempotency-key-parser.js';
import {
  createWebhookFixedPrefixProviderIdParser,
} from '../webhook-fixed-prefix-provider-id-parser.js';
import {
  createWebhookSegmentedAsciiTokenParser,
} from '../webhook-segmented-ascii-token-parser.js';
import {
  createWebhookHttpOrOpaqueDestinationParser,
  type WebhookHttpOrOpaqueDestinationParser,
} from '../webhook-http-or-opaque-destination-parser.js';
import {
  webhookRegistrationIdempotencyKeyProfilePreset,
} from '../webhook-registration-idempotency-key-profile-presets.js';
import {
  webhookRegistrationResponseProfilePreset,
} from '../webhook-registration-response-profile-presets.js';
import {
  webhookRegistrationDestinationProfilePreset,
} from '../webhook-registration-destination-profile-presets.js';
import {
  createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier,
} from '../webhook-environment-mapped-segmented-ascii-token-classifier.js';
import {
  webhookRegistrationEnvironmentTokenProfilePreset,
} from '../webhook-registration-environment-token-profile-presets.js';

const TEST_API_KEY =
  `pdl_sdbx_apikey_${'a'.repeat(26)}_${'B'.repeat(22)}_${'C'.repeat(3)}`;
const LIVE_API_KEY =
  `pdl_live_apikey_${'d'.repeat(26)}_${'E'.repeat(22)}_${'F'.repeat(3)}`;
const REMOTE_ID = `ntfset_${'a'.repeat(26)}`;
const ENDPOINT_SECRET = `pdl_${REMOTE_ID}_${'S'.repeat(32)}`;
const LIST_PAGE_SIZE = 25;
const ENDPOINT = 'https://hooks.example/v1/webhooks/opaquePublicId_0123456789abcdef';
const OLD_ENDPOINT =
  'https://old.example/v1/webhooks/opaquePublicId_0123456789abcdef';
const EVENT_TYPE_PRESET = webhookDotSegmentEventTypeProfilePreset(
  'paddle.notification.v1',
);
if (EVENT_TYPE_PRESET === null) {
  throw new Error('Paddle event-type test preset is unavailable');
}
const EVENT_TYPE_PARSER = createWebhookDotSegmentEventTypeParser(
  EVENT_TYPE_PRESET.parser,
);
const CREDENTIAL_PRESET = webhookSegmentedAsciiCredentialProfilePreset(
  'paddle.notification.v1',
);
if (CREDENTIAL_PRESET === null) {
  throw new Error('Paddle registration credential test preset is unavailable');
}
const ENDPOINT_SECRET_PARSER = createWebhookSegmentedAsciiTokenParser(
  CREDENTIAL_PRESET.parser,
);
const REMOTE_ID_PRESET = webhookFixedPrefixRegistrationRemoteIdProfilePreset(
  'paddle.notification.v1',
);
if (REMOTE_ID_PRESET === null) {
  throw new Error('Paddle registration remote-id test preset is unavailable');
}
const REMOTE_ID_PARSER = createWebhookFixedPrefixProviderIdParser(
  REMOTE_ID_PRESET.parser,
);
const IDEMPOTENCY_KEY_PRESET =
  webhookRegistrationIdempotencyKeyProfilePreset('paddle.notification.v1');
if (IDEMPOTENCY_KEY_PRESET === null) {
  throw new Error('Paddle registration idempotency-key test preset is unavailable');
}
const IDEMPOTENCY_KEY_PARSER = createWebhookRegistrationIdempotencyKeyParser(
  IDEMPOTENCY_KEY_PRESET.parser,
);
const RESPONSE_PRESET = webhookRegistrationResponseProfilePreset(
  'paddle.notification.v1',
);
if (RESPONSE_PRESET === null) {
  throw new Error('Paddle registration-response test preset is unavailable');
}
const RESPONSE_READER = createWebhookRegistrationJsonResponseReader(
  RESPONSE_PRESET.reader,
);
const DESTINATION_PRESET = webhookRegistrationDestinationProfilePreset(
  'paddle.notification.v1',
);
if (DESTINATION_PRESET === null) {
  throw new Error('Paddle registration destination test preset is unavailable');
}
const DESTINATION_PARSER = createWebhookHttpOrOpaqueDestinationParser(
  DESTINATION_PRESET.parser,
);
const API_KEY_PRESET = webhookRegistrationEnvironmentTokenProfilePreset(
  'paddle.notification.v1',
);
if (API_KEY_PRESET === null
  || API_KEY_PRESET.classifier.kind
    !== 'environment_mapped_segmented_ascii_token.v1') {
  throw new Error('Paddle registration environment-token test preset is unavailable');
}
const API_KEY_CLASSIFIER =
  createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier(
    API_KEY_PRESET.classifier,
  );

const testContext: ManagedWebhookRegistrationContext = {
  paired_connection_id: 'paddle-api',
  desired: {
    ingress_id: 'whi_0123456789abcdef0123456789abcdef',
    environment: 'test',
    registration_target: null,
    endpoint_url: ENDPOINT,
    event_types: ['subscription.created', 'transaction.completed'],
  },
};

const liveContext: ManagedWebhookRegistrationContext = {
  ...testContext,
  desired: {
    ...testContext.desired,
    environment: 'live',
  },
};

const descriptionFor = (context: ManagedWebhookRegistrationContext): string =>
  `Recued managed webhook | paddle.notification.v1 | ${context.desired.environment} | ${context.desired.ingress_id}`;

const setting = (
  context: ManagedWebhookRegistrationContext,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => {
  const id = typeof overrides.id === 'string' ? overrides.id : REMOTE_ID;
  return {
    id,
    description: descriptionFor(context),
    type: 'url',
    destination: context.desired.endpoint_url,
    active: true,
    api_version: 1,
    include_sensitive_fields: false,
    subscribed_events: context.desired.event_types.map((name) => ({
      name,
      description: `Fixture for ${name}`,
      group: 'Fixture',
      available_versions: [1],
    })),
    endpoint_secret_key: `pdl_${id}_${'S'.repeat(32)}`,
    traffic_source: context.desired.environment === 'test' ? 'all' : 'platform',
    ...overrides,
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const envelope = (data: unknown): Record<string, unknown> => ({
  data,
  meta: { request_id: 'fixture-request-id' },
});

const listEnvelope = (input: {
  data: readonly unknown[];
  hasMore?: boolean;
  next?: string;
}): Record<string, unknown> => ({
  data: input.data,
  meta: {
    request_id: 'fixture-request-id',
    pagination: {
      per_page: LIST_PAGE_SIZE,
      estimated_total: -1,
      next: input.next
        ?? 'https://sandbox-api.paddle.com/notification-settings?after=ntfset_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      has_more: input.hasMore ?? false,
    },
  },
});

const makeAdapter = (overrides: Partial<PaddleWebhookRegistrationDeps> = {}) =>
  createPaddleWebhookRegistrationAdapter({
    apiKeyClassifier: API_KEY_CLASSIFIER,
    destinationParser: DESTINATION_PARSER,
    endpointSecretParser: ENDPOINT_SECRET_PARSER,
    eventTypeParser: EVENT_TYPE_PARSER,
    idempotencyKeyParser: IDEMPOTENCY_KEY_PARSER,
    remoteIdParser: REMOTE_ID_PARSER,
    responseReader: RESPONSE_READER,
    resolveConnection: async () => ({ api_key: TEST_API_KEY }),
    resolveOwnership: async () => null,
    ...overrides,
  });

describe('D-201 Slices 8I + 9I + 9AG + 9AK + 9AO + 9AU + 9AZ + 9BD Paddle registration adapter', () => {
  it('pins one API-key classification for Bearer authority and origin', async () => {
    const compiled = createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier({
      kind: 'environment_mapped_segmented_ascii_token.v1',
      separator: '_',
      segments: [{ length: 3, alphabet: 'lowercase_alphanumeric' }],
      mappings: [
        { prefix: 'fixture_sdbx_', environment: 'test' },
        { prefix: 'fixture_live_', environment: 'live' },
      ],
    });
    let classifiedValueReads = 0;
    let classifiedEnvironmentReads = 0;
    const classified = Object.create(null) as {
      readonly value: string;
      readonly environment: 'test' | 'live';
    };
    Object.defineProperties(classified, {
      value: {
        enumerable: true,
        get() {
          classifiedValueReads += 1;
          return classifiedValueReads === 1
            ? 'fixture_sdbx_clean'
            : 'fixture_live_bad';
        },
      },
      environment: {
        enumerable: true,
        get() {
          classifiedEnvironmentReads += 1;
          return classifiedEnvironmentReads === 1 ? 'test' : 'live';
        },
      },
    });
    const classify = vi.fn(() => classified);
    let tokenReads = 0;
    const connection = Object.create(null) as { api_key: string };
    Object.defineProperty(connection, 'api_key', {
      enumerable: true,
      get() {
        tokenReads += 1;
        return tokenReads === 1 ? 'fixture_sdbx_raw' : 'fixture_live_bad';
      },
    });
    const fetchImpl = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => json(listEnvelope({ data: [] })));
    const adapter = makeAdapter({
      apiKeyClassifier: { preset: compiled.preset, classify },
      fetchImpl,
      resolveConnection: async () => connection,
    });

    await expect(adapter.find(testContext)).resolves.toEqual([]);
    await expect(adapter.find(testContext)).resolves.toEqual([]);
    expect(tokenReads).toBe(1);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith('fixture_sdbx_raw');
    expect(classifiedValueReads).toBe(1);
    expect(classifiedEnvironmentReads).toBe(1);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/sandbox-api\.paddle\.com\//);
      expect((init?.headers as Headers).get('Authorization'))
        .toBe('Bearer fixture_sdbx_clean');
    }
  });

  it('rejects non-primitive resolved API keys before provider I/O', async () => {
    const fetchImpl = vi.fn();
    const adapter = makeAdapter({
      fetchImpl,
      resolveConnection: async () => ({
        api_key: new String(TEST_API_KEY) as unknown as string,
      }),
    });

    await expect(adapter.find(testContext)).rejects.toMatchObject({
      code: 'connection_auth_invalid',
      message: 'Paddle managed registration requires a modern API key',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('delegates desired and remote event-type admission to the profile parser', async () => {
    const customContext: ManagedWebhookRegistrationContext = {
      ...testContext,
      desired: {
        ...testContext.desired,
        event_types: ['Custom Event'],
      },
    };
    const observed: unknown[] = [];
    const eventTypeParser: WebhookDotSegmentEventTypeParser = {
      preset: EVENT_TYPE_PRESET.parser,
      parse(value) {
        observed.push(value);
        return value === 'Custom Event' ? 'normalized.event' : null;
      },
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(listEnvelope({
      data: [setting(customContext)],
    })));

    await expect(makeAdapter({ eventTypeParser, fetchImpl }).find(customContext))
      .resolves.toMatchObject([{
        endpoint: { event_types: ['normalized.event'] },
      }]);
    expect(observed.filter((value) => value === 'Custom Event').length)
      .toBeGreaterThanOrEqual(2);
  });

  it('uses injected destination labels and grammar for desired and provider URLs', async () => {
    const compiled = createWebhookHttpOrOpaqueDestinationParser({
      kind: 'http_or_opaque_destination.v1',
      max_characters: 2_048,
      http_url_discriminator: 'callback',
      opaque_discriminator: 'mailbox',
    });
    const parse = vi.fn(compiled.parse);
    const destinationParser: WebhookHttpOrOpaqueDestinationParser = {
      preset: compiled.preset,
      parse,
    };
    const fetchImpl = vi.fn(async () => json(listEnvelope({
      data: [setting(testContext, { type: 'callback' })],
    })));

    await expect(makeAdapter({ destinationParser, fetchImpl }).find(testContext))
      .resolves.toHaveLength(1);
    expect(parse.mock.calls).toContainEqual(['callback', ENDPOINT]);
    expect(parse.mock.calls.filter(
      ([discriminator, value]) => discriminator === 'callback' && value === ENDPOINT,
    ).length).toBeGreaterThanOrEqual(2);
  });

  it('writes the injected HTTP destination label in the closed create body', async () => {
    const destinationParser = createWebhookHttpOrOpaqueDestinationParser({
      kind: 'http_or_opaque_destination.v1',
      max_characters: 2_048,
      http_url_discriminator: 'callback',
      opaque_discriminator: 'mailbox',
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(listEnvelope({ data: [] })))
      .mockResolvedValueOnce(json(envelope(setting(testContext, {
        type: 'callback',
      })), 201));

    await expect(makeAdapter({ destinationParser, fetchImpl }).create(
      testContext,
      'recued-d201-create-key',
    )).resolves.toMatchObject({
      endpoint: { endpoint_url: ENDPOINT },
    });
    const [, init] = fetchImpl.mock.calls[1]!;
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      type: 'callback',
      destination: ENDPOINT,
    });
  });

  it('uses the injected bounded response reader for provider bodies', async () => {
    const responseReader = createWebhookRegistrationJsonResponseReader({
      kind: 'bounded_json_response.v1',
      max_bytes: 1,
      error_label: 'Injected Paddle fixture',
    });
    const fetchImpl = vi.fn(async () => json(listEnvelope({ data: [] })));
    const adapter = makeAdapter({ responseReader, fetchImpl });

    await expect(adapter.find(testContext)).rejects.toMatchObject({
      code: 'upstream_response_too_large',
      message: 'Injected Paddle fixture response exceeded the size limit',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves provider-field short-circuit order before destination admission', async () => {
    const invalid = setting(testContext, { id: 'invalid_remote_id' });
    const typeGetter = vi.fn(() => 'url');
    Object.defineProperty(invalid, 'type', {
      enumerable: true,
      get: typeGetter,
    });
    const responseReader = {
      preset: RESPONSE_READER.preset,
      readText: RESPONSE_READER.readText,
      async readJson(pending: Parameters<typeof RESPONSE_READER.readJson>[0]) {
        pending.finish();
        return listEnvelope({ data: [invalid] });
      },
    };
    const fetchImpl = vi.fn(async () => json(null));

    await expect(makeAdapter({ responseReader, fetchImpl }).find(testContext))
      .rejects.toMatchObject({
        code: 'upstream_response_invalid',
        message: 'Paddle returned an invalid notification-setting object',
      });
    expect(typeGetter).not.toHaveBeenCalled();
  });

  it('uses the injected credential parser for provider and ownership secrets', async () => {
    const endpointSecretParser = createWebhookSegmentedAsciiTokenParser({
      kind: 'segmented_ascii_token.v1',
      prefix: 'fixture_',
      separator: '-',
      segment_lengths: [2, 3],
    });
    const rejectedFetch = vi.fn(async () => json(listEnvelope({
      data: [setting(testContext)],
    })));
    const rejected = makeAdapter({
      endpointSecretParser,
      fetchImpl: rejectedFetch,
    });
    await expect(rejected.find(testContext)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'Paddle returned an invalid notification-setting object',
    });

    const customSecret = 'fixture_A1-b2C';
    const acceptedFetch = vi.fn(async () => json(listEnvelope({
      data: [setting(testContext, { endpoint_secret_key: customSecret })],
    })));
    const accepted = makeAdapter({
      endpointSecretParser,
      fetchImpl: acceptedFetch,
    });
    await expect(accepted.find(testContext)).resolves.toHaveLength(1);

    const ownershipFetch = vi.fn();
    const invalidOwnership = makeAdapter({
      endpointSecretParser,
      fetchImpl: ownershipFetch,
      resolveOwnership: async () => ({
        remote_endpoint_id: REMOTE_ID,
        confirmed_endpoint_url: ENDPOINT,
        endpoint_secret_key: ENDPOINT_SECRET,
      }),
    });
    await expect(invalidOwnership.read(testContext, REMOTE_ID))
      .rejects.toMatchObject({
        code: 'registration_input_invalid',
        message: 'Paddle managed webhook ownership state is invalid',
      });
    expect(ownershipFetch).not.toHaveBeenCalled();

    const parseEndpointSecret = vi.fn(endpointSecretParser.parse);
    const invalidRemoteOwnership = makeAdapter({
      endpointSecretParser: Object.freeze({
        preset: endpointSecretParser.preset,
        parse: parseEndpointSecret,
      }),
      resolveOwnership: async () => ({
        remote_endpoint_id: 'wrong_remote_id',
        confirmed_endpoint_url: ENDPOINT,
        endpoint_secret_key: customSecret,
      }),
    });
    await expect(invalidRemoteOwnership.read(testContext, REMOTE_ID))
      .rejects.toMatchObject({
        code: 'registration_input_invalid',
        message: 'Paddle managed webhook ownership state is invalid',
      });
    expect(parseEndpointSecret).not.toHaveBeenCalled();
  });

  it('uses the injected idempotency-key parser for create and update', async () => {
    const idempotencyKeyParser =
      createWebhookRegistrationIdempotencyKeyParser({
        kind: 'ascii_registration_idempotency_key.v1',
        max_characters: 1,
      });
    const fetchImpl = vi.fn();
    const adapter = makeAdapter({ idempotencyKeyParser, fetchImpl });

    await expect(adapter.create(testContext, 'ab')).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Paddle registration idempotency key is invalid',
    });
    await expect(adapter.update(
      testContext,
      REMOTE_ID,
      'ab',
    )).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Paddle registration idempotency key is invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed instead of regex-coercing non-string idempotency values', async () => {
    const fetchImpl = vi.fn();
    const resolveConnection = vi.fn(async () => ({ api_key: TEST_API_KEY }));
    const resolveOwnership = vi.fn(async () => null);
    const adapter = makeAdapter({
      fetchImpl,
      resolveConnection,
      resolveOwnership,
    });

    await expect(adapter.create(testContext, null as never)).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Paddle registration idempotency key is invalid',
    });
    await expect(adapter.update(
      testContext,
      REMOTE_ID,
      1 as never,
    )).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Paddle registration idempotency key is invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(resolveOwnership).not.toHaveBeenCalled();
  });

  it('uses the injected remote-id parser for provider results and committed ids', async () => {
    const remoteIdParser = createWebhookFixedPrefixProviderIdParser({
      kind: 'fixed_prefix_lowercase_alphanumeric_id.v1',
      prefix: 'ntfset_',
      suffix_length: 1,
    });
    const fetchImpl = vi.fn(async () => json(listEnvelope({
      data: [setting(testContext)],
    })));
    const adapter = makeAdapter({ fetchImpl, remoteIdParser });

    await expect(adapter.find(testContext)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'Paddle returned an invalid notification-setting object',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();

    for (const invoke of [
      () => adapter.read(testContext, REMOTE_ID),
      () => adapter.update(testContext, REMOTE_ID, 'recued-d201-update-key'),
      () => adapter.delete(testContext, REMOTE_ID),
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        code: 'upstream_response_invalid',
        message: 'Paddle remote notification-setting id is invalid',
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed instead of regex-coercing non-string remote ids', async () => {
    const readFetch = vi.fn();
    const readResolveConnection = vi.fn(async () => ({ api_key: TEST_API_KEY }));
    const readResolveOwnership = vi.fn(async () => null);
    const readAdapter = makeAdapter({
      fetchImpl: readFetch,
      resolveConnection: readResolveConnection,
      resolveOwnership: readResolveOwnership,
    });

    await expect(
      readAdapter.read(testContext, new String(REMOTE_ID) as never),
    ).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'Paddle remote notification-setting id is invalid',
    });
    expect(readResolveOwnership).toHaveBeenCalledTimes(1);
    expect(readFetch).not.toHaveBeenCalled();
    expect(readResolveConnection).not.toHaveBeenCalled();

    const mutationFetch = vi.fn();
    const mutationResolveConnection = vi.fn(async () => ({ api_key: TEST_API_KEY }));
    const mutationResolveOwnership = vi.fn(async () => null);
    const mutationAdapter = makeAdapter({
      fetchImpl: mutationFetch,
      resolveConnection: mutationResolveConnection,
      resolveOwnership: mutationResolveOwnership,
    });
    for (const invoke of [
      () => mutationAdapter.update(
        testContext,
        new String(REMOTE_ID) as never,
        'recued-d201-update-key',
      ),
      () => mutationAdapter.delete(testContext, null as never),
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        code: 'upstream_response_invalid',
        message: 'Paddle remote notification-setting id is invalid',
      });
    }
    expect(mutationFetch).not.toHaveBeenCalled();
    expect(mutationResolveConnection).not.toHaveBeenCalled();
    expect(mutationResolveOwnership).not.toHaveBeenCalled();
  });

  it('rejects a non-string stored remote id before provider I/O', async () => {
    const fetchImpl = vi.fn();
    const resolveConnection = vi.fn(async () => ({ api_key: TEST_API_KEY }));
    const resolveOwnership = vi.fn(async () => ({
      remote_endpoint_id: new String(REMOTE_ID) as never,
      confirmed_endpoint_url: ENDPOINT,
      endpoint_secret_key: ENDPOINT_SECRET,
    }));
    const adapter = makeAdapter({
      fetchImpl,
      resolveConnection,
      resolveOwnership,
    });

    await expect(adapter.find(testContext)).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Paddle managed webhook ownership state is invalid',
    });
    expect(resolveOwnership).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveConnection).toHaveBeenCalledTimes(1);
  });

  it('rejects legacy and wrong-environment keys before network access', async () => {
    const legacyFetch = vi.fn();
    const legacy = makeAdapter({
      resolveConnection: async () => ({ api_key: 'a'.repeat(50) }),
      fetchImpl: legacyFetch,
    });
    await expect(legacy.find(testContext)).rejects.toMatchObject({
      code: 'connection_auth_invalid',
    });
    expect(legacyFetch).not.toHaveBeenCalled();

    const wrongEnvironmentFetch = vi.fn();
    const wrongEnvironment = makeAdapter({
      resolveConnection: async () => ({ api_key: LIVE_API_KEY }),
      fetchImpl: wrongEnvironmentFetch,
    });
    await expect(wrongEnvironment.find(testContext)).rejects.toMatchObject({
      code: 'environment_mismatch',
    });
    expect(wrongEnvironmentFetch).not.toHaveBeenCalled();
  });

  it('creates a Sandbox URL destination with only closed Paddle fields', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(listEnvelope({ data: [] })))
      .mockResolvedValueOnce(json(envelope(setting(testContext)), 201))
      .mockResolvedValueOnce(json(envelope(setting(testContext))));
    const resolveConnection = vi.fn(async () => ({ api_key: TEST_API_KEY }));
    const adapter = makeAdapter({ resolveConnection, fetchImpl });

    await expect(adapter.create(
      testContext,
      'recued-d201-paddle-create',
    )).resolves.toEqual({
      endpoint: {
        remote_endpoint_id: REMOTE_ID,
        environment: 'test',
        endpoint_url: ENDPOINT,
        event_types: ['subscription.created', 'transaction.completed'],
        enabled: true,
        correlation_valid: true,
      },
      credential_result: { endpoint_secret_key: ENDPOINT_SECRET },
    });
    await expect(adapter.read(testContext, REMOTE_ID)).resolves.toMatchObject({
      remote_endpoint_id: REMOTE_ID,
      correlation_valid: true,
    });
    await expect(adapter.create(
      testContext,
      'recued-d201-paddle-create-repeated',
    )).rejects.toMatchObject({ code: 'registration_input_invalid' });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(resolveConnection).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      `https://sandbox-api.paddle.com/notification-settings?per_page=${LIST_PAGE_SIZE}&order_by=id%5BASC%5D`,
    );
    const listHeaders = fetchImpl.mock.calls[0]![1]?.headers as Headers;
    expect(listHeaders.get('Skip-Count')).toBe('true');
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(String(url)).toBe('https://sandbox-api.paddle.com/notification-settings');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
    const headers = init?.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${TEST_API_KEY}`);
    expect(headers.get('Paddle-Version')).toBe('1');
    expect(headers.has('Idempotency-Key')).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      type: 'url',
      description: descriptionFor(testContext),
      destination: ENDPOINT,
      api_version: 1,
      include_sensitive_fields: false,
      subscribed_events: ['subscription.created', 'transaction.completed'],
      traffic_source: 'all',
    });
  });

  it('pins Live to api.paddle.com and excludes simulation traffic', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(listEnvelope({
        data: [],
        next: 'https://api.paddle.com/notification-settings?after=ntfset_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      })))
      .mockResolvedValueOnce(json(envelope(setting(liveContext)), 201));
    const adapter = makeAdapter({
      resolveConnection: async () => ({ api_key: LIVE_API_KEY }),
      fetchImpl,
    });

    await adapter.create(liveContext, 'recued-d201-live-create');
    expect(String(fetchImpl.mock.calls[0]![0])).toMatch(
      /^https:\/\/api\.paddle\.com\/notification-settings\?/,
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body))).toMatchObject({
      traffic_source: 'platform',
    });
  });

  it('pages exhaustively without following provider-controlled outbound authority', async () => {
    const firstId = `ntfset_${'b'.repeat(26)}`;
    const ownedId = `ntfset_${'c'.repeat(26)}`;
    const urlOnlyId = `ntfset_${'d'.repeat(26)}`;
    const metadataId = `ntfset_${'e'.repeat(26)}`;
    const emailId = `ntfset_${'f'.repeat(26)}`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(listEnvelope({
        data: [setting(testContext, {
          id: firstId,
          description: 'Unrelated destination',
          destination: 'https://unrelated.example/webhook',
        })],
        hasMore: true,
        next: `https://sandbox-api.paddle.com/notification-settings?after=${firstId}`,
      })))
      .mockResolvedValueOnce(json(listEnvelope({
        data: [
          setting(testContext, { id: ownedId, active: false }),
          setting(testContext, {
            id: urlOnlyId,
            description: 'Different owner',
          }),
          setting(testContext, {
            id: metadataId,
            destination: 'https://different.example/webhook',
          }),
          setting(testContext, {
            id: emailId,
            type: 'email',
            destination: 'owner@example.com',
          }),
        ],
      })));
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.find(testContext)).resolves.toMatchObject([
      { correlation: 'owned', endpoint: { remote_endpoint_id: ownedId } },
      { correlation: 'url_only', endpoint: { remote_endpoint_id: urlOnlyId } },
      { correlation: 'metadata_conflict', endpoint: { remote_endpoint_id: metadataId } },
      { correlation: 'metadata_conflict', endpoint: { remote_endpoint_id: emailId } },
    ]);
    expect(String(fetchImpl.mock.calls[1]![0])).toBe(
      `https://sandbox-api.paddle.com/notification-settings?per_page=${LIST_PAGE_SIZE}&order_by=id%5BASC%5D&after=${firstId}`,
    );
  });

  it('uses the committed id, secret, and last-confirmed URL as ownership evidence', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(listEnvelope({
      data: [setting(testContext, {
        description: 'Drifted description',
        destination: OLD_ENDPOINT,
      })],
    })));
    const adapter = makeAdapter({
      resolveOwnership: async () => ({
        remote_endpoint_id: REMOTE_ID,
        confirmed_endpoint_url: OLD_ENDPOINT,
        endpoint_secret_key: ENDPOINT_SECRET,
      }),
      fetchImpl,
    });

    await expect(adapter.find(testContext)).resolves.toEqual([{
      correlation: 'owned',
      endpoint: {
        remote_endpoint_id: REMOTE_ID,
        environment: 'test',
        endpoint_url: OLD_ENDPOINT,
        event_types: ['subscription.created', 'transaction.completed'],
        enabled: true,
        correlation_valid: false,
      },
    }]);
  });

  it('rejects an off-origin next URL and a search beyond the page bound', async () => {
    const hostileId = `ntfset_${'g'.repeat(26)}`;
    const hostile = makeAdapter({
      fetchImpl: vi.fn().mockResolvedValue(json(listEnvelope({
        data: [setting(testContext, { id: hostileId })],
        hasMore: true,
        next: `https://attacker.example/notification-settings?after=${hostileId}`,
      }))),
    });
    await expect(hostile.find(testContext)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
    });

    let index = 0;
    const boundedFetch = vi.fn(async () => {
      const character = String.fromCharCode('h'.charCodeAt(0) + index);
      index += 1;
      const id = `ntfset_${character.repeat(26)}`;
      return json(listEnvelope({
        data: [setting(testContext, { id })],
        hasMore: true,
        next: `https://sandbox-api.paddle.com/notification-settings?after=${id}`,
      }));
    });
    const bounded = makeAdapter({ fetchImpl: boundedFetch });
    await expect(bounded.find(testContext)).rejects.toMatchObject({
      code: 'search_incomplete',
    });
    expect(boundedFetch).toHaveBeenCalledTimes(10);
  });

  it('rejects duplicate notification-setting ids across paginated results', async () => {
    const duplicateId = `ntfset_${'r'.repeat(26)}`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(listEnvelope({
        data: [setting(testContext, { id: duplicateId })],
        hasMore: true,
        next: `https://sandbox-api.paddle.com/notification-settings?after=${duplicateId}`,
      })))
      .mockResolvedValueOnce(json(listEnvelope({
        data: [setting(testContext, { id: duplicateId })],
      })));
    await expect(makeAdapter({ fetchImpl }).find(testContext)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
    });
  });

  it('rejects non-monotonic ids instead of trusting a lossy next cursor', async () => {
    const laterId = `ntfset_${'z'.repeat(26)}`;
    const earlierId = `ntfset_${'s'.repeat(26)}`;
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(listEnvelope({
      data: [
        setting(testContext, { id: laterId }),
        setting(testContext, { id: earlierId }),
      ],
    })));
    await expect(makeAdapter({ fetchImpl }).find(testContext)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
    });
  });

  it('updates only a secret-proven committed destination and sends the full event list', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(envelope(setting(testContext, {
        description: 'Drifted description',
        destination: OLD_ENDPOINT,
        active: false,
        api_version: 2,
        include_sensitive_fields: true,
        subscribed_events: [],
        traffic_source: 'simulation',
      }))))
      .mockResolvedValueOnce(json(envelope(setting(testContext))));
    const adapter = makeAdapter({
      resolveOwnership: async () => ({
        remote_endpoint_id: REMOTE_ID,
        confirmed_endpoint_url: OLD_ENDPOINT,
        endpoint_secret_key: ENDPOINT_SECRET,
      }),
      fetchImpl,
    });

    await expect(adapter.update(
      testContext,
      REMOTE_ID,
      'recued-d201-paddle-update',
    )).resolves.toMatchObject({
      remote_endpoint_id: REMOTE_ID,
      endpoint_url: ENDPOINT,
      correlation_valid: true,
    });
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(String(url)).toBe(
      `https://sandbox-api.paddle.com/notification-settings/${REMOTE_ID}`,
    );
    expect(init?.method).toBe('PATCH');
    expect((init?.headers as Headers).has('Idempotency-Key')).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      description: descriptionFor(testContext),
      destination: ENDPOINT,
      active: true,
      api_version: 1,
      include_sensitive_fields: false,
      subscribed_events: ['subscription.created', 'transaction.completed'],
      traffic_source: 'all',
    });
  });

  it('refuses secret or URL ownership conflicts before update and delete mutations', async () => {
    const wrongSecret = `pdl_${REMOTE_ID}_${'T'.repeat(32)}`;
    const updateFetch = vi.fn().mockResolvedValueOnce(json(envelope(setting(
      testContext,
      { endpoint_secret_key: wrongSecret },
    ))));
    const updateAdapter = makeAdapter({
      resolveOwnership: async () => ({
        remote_endpoint_id: REMOTE_ID,
        confirmed_endpoint_url: ENDPOINT,
        endpoint_secret_key: ENDPOINT_SECRET,
      }),
      fetchImpl: updateFetch,
    });
    await expect(updateAdapter.update(
      testContext,
      REMOTE_ID,
      'recued-d201-paddle-update',
    )).rejects.toMatchObject({ code: 'upstream_rejected' });
    expect(updateFetch).toHaveBeenCalledTimes(1);

    const deleteFetch = vi.fn().mockResolvedValueOnce(json(envelope(setting(
      testContext,
      { destination: 'https://foreign.example/webhook' },
    ))));
    const deleteAdapter = makeAdapter({
      resolveOwnership: async () => ({
        remote_endpoint_id: REMOTE_ID,
        confirmed_endpoint_url: OLD_ENDPOINT,
        endpoint_secret_key: ENDPOINT_SECRET,
      }),
      fetchImpl: deleteFetch,
    });
    await expect(deleteAdapter.delete(testContext, REMOTE_ID)).rejects.toMatchObject({
      code: 'upstream_rejected',
    });
    expect(deleteFetch).toHaveBeenCalledTimes(1);
  });

  it('deletes committed and crash-orphan destinations and treats absence idempotently', async () => {
    const committedFetch = vi.fn()
      .mockResolvedValueOnce(json(envelope(setting(testContext, {
        description: 'Drifted description',
        destination: OLD_ENDPOINT,
        subscribed_events: [],
      }))))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const committedAdapter = makeAdapter({
      resolveOwnership: async () => ({
        remote_endpoint_id: REMOTE_ID,
        confirmed_endpoint_url: OLD_ENDPOINT,
        endpoint_secret_key: ENDPOINT_SECRET,
      }),
      fetchImpl: committedFetch,
    });
    await expect(committedAdapter.delete(
      testContext,
      REMOTE_ID,
    )).resolves.toBeUndefined();
    expect(committedFetch).toHaveBeenCalledTimes(2);

    const orphanFetch = vi.fn()
      .mockResolvedValueOnce(json(envelope(setting(testContext, {
        subscribed_events: [],
      }))))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const orphanAdapter = makeAdapter({ fetchImpl: orphanFetch });
    await expect(orphanAdapter.delete(testContext, REMOTE_ID)).resolves.toBeUndefined();
    expect(orphanFetch).toHaveBeenCalledTimes(2);
    expect(orphanFetch.mock.calls[1]![1]?.method).toBe('DELETE');

    const missingFetch = vi.fn().mockResolvedValueOnce(json({
      error: { code: 'not_found' },
      meta: { request_id: 'missing' },
    }, 404));
    const missingAdapter = makeAdapter({ fetchImpl: missingFetch });
    await expect(missingAdapter.delete(testContext, REMOTE_ID)).resolves.toBeUndefined();
    expect(missingFetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a lost create secret, malformed JSON, and oversized bodies', async () => {
    const lostSecretFetch = vi.fn()
      .mockResolvedValueOnce(json(listEnvelope({ data: [] })))
      .mockResolvedValueOnce(json(envelope(setting(testContext, {
        endpoint_secret_key: undefined,
      })), 201));
    await expect(makeAdapter({ fetchImpl: lostSecretFetch }).create(
      testContext,
      'recued-d201-paddle-create',
    )).rejects.toMatchObject({ code: 'upstream_response_invalid' });

    const malformed = makeAdapter({
      fetchImpl: vi.fn().mockResolvedValue(new Response('{', { status: 200 })),
    });
    await expect(malformed.read(testContext, REMOTE_ID)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
    });

    const nonUtf8 = makeAdapter({
      fetchImpl: vi.fn().mockResolvedValue(new Response(
        new Uint8Array([0xc3, 0x28]),
        { status: 200 },
      )),
    });
    await expect(nonUtf8.read(testContext, REMOTE_ID)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
    });

    const oversized = makeAdapter({
      fetchImpl: vi.fn().mockResolvedValue(new Response(
        'x'.repeat(512 * 1024 + 1),
        { status: 200 },
      )),
    });
    await expect(oversized.read(testContext, REMOTE_ID)).rejects.toMatchObject({
      code: 'upstream_response_too_large',
    });
  });

  it('normalizes authentication and transient HTTP failures without response bodies', async () => {
    const forbidden = makeAdapter({
      fetchImpl: vi.fn().mockResolvedValue(json({ secret: TEST_API_KEY }, 403)),
    });
    await expect(forbidden.read(testContext, REMOTE_ID)).rejects.toMatchObject({
      code: 'connection_auth_invalid',
      message: 'Paddle webhook registration returned HTTP 403',
    });

    const unavailable = makeAdapter({
      fetchImpl: vi.fn().mockResolvedValue(json({ secret: ENDPOINT_SECRET }, 503)),
    });
    await expect(unavailable.read(testContext, REMOTE_ID)).rejects.toMatchObject({
      code: 'upstream_unavailable',
      message: 'Paddle webhook registration returned HTTP 503',
    });
  });

  it('rejects caller idempotency authority and enters the registry only after declaration', async () => {
    const fetchImpl = vi.fn();
    const adapter = makeAdapter({ fetchImpl });
    await expect(adapter.create(testContext, 'invalid key')).rejects.toMatchObject({
      code: 'registration_input_invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createWebhookRegistrationRuntimeRegistry([adapter]).get(
      'paddle.notification.v1',
    )).not.toBeNull();
  });
});
