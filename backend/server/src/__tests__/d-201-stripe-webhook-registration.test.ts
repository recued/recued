import { describe, expect, it, vi } from 'vitest';
import {
  createStripeWebhookRegistrationAdapter,
  type StripeWebhookRegistrationDeps,
} from '../connections/providers/stripe-webhook-registration.js';
import {
  createWebhookAsciiEventTypeParser,
} from '../webhook-ascii-event-type-parser.js';
import {
  createWebhookBoundedPrefixProviderIdParser,
} from '../webhook-bounded-prefix-provider-id-parser.js';
import {
  createWebhookBoundedHttpUrlParser,
} from '../webhook-bounded-http-url-parser.js';
import {
  createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier,
} from '../webhook-environment-mapped-prefixed-ascii-token-classifier.js';
import {
  createWebhookPrefixedAsciiTokenParser,
} from '../webhook-prefixed-ascii-token-parser.js';
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
  webhookRegistrationRemoteUrlProfilePreset,
} from '../webhook-registration-remote-url-profile-presets.js';
import {
  webhookRegistrationEnvironmentTokenProfilePreset,
} from '../webhook-registration-environment-token-profile-presets.js';
import {
  webhookAsciiEventTypeProfilePreset,
  webhookBoundedPrefixRegistrationRemoteIdProfilePreset,
  webhookPrefixedAsciiCredentialProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const EVENT_TYPE_PRESET = webhookAsciiEventTypeProfilePreset('stripe.event.v1');
if (EVENT_TYPE_PRESET === null) {
  throw new Error('Stripe registration event-type test preset is unavailable');
}
const EVENT_TYPE_PARSER = createWebhookAsciiEventTypeParser(
  EVENT_TYPE_PRESET.parser,
);

const CREDENTIAL_PRESET = webhookPrefixedAsciiCredentialProfilePreset(
  'stripe.event.v1',
);
if (CREDENTIAL_PRESET === null) {
  throw new Error('Stripe registration credential test preset is unavailable');
}
const ENDPOINT_SECRET_PARSER = createWebhookPrefixedAsciiTokenParser(
  CREDENTIAL_PRESET.parser,
);

const REMOTE_ID_PRESET =
  webhookBoundedPrefixRegistrationRemoteIdProfilePreset('stripe.event.v1');
if (REMOTE_ID_PRESET === null) {
  throw new Error('Stripe registration remote-id test preset is unavailable');
}
const REMOTE_ID_PARSER = createWebhookBoundedPrefixProviderIdParser(
  REMOTE_ID_PRESET.parser,
);

const IDEMPOTENCY_KEY_PRESET =
  webhookRegistrationIdempotencyKeyProfilePreset('stripe.event.v1');
if (IDEMPOTENCY_KEY_PRESET === null) {
  throw new Error('Stripe registration idempotency-key test preset is unavailable');
}
const IDEMPOTENCY_KEY_PARSER = createWebhookRegistrationIdempotencyKeyParser(
  IDEMPOTENCY_KEY_PRESET.parser,
);

const RESPONSE_PRESET = webhookRegistrationResponseProfilePreset(
  'stripe.event.v1',
);
if (RESPONSE_PRESET === null) {
  throw new Error('Stripe registration-response test preset is unavailable');
}
const RESPONSE_READER = createWebhookRegistrationJsonResponseReader(
  RESPONSE_PRESET.reader,
);

const REMOTE_URL_PRESET = webhookRegistrationRemoteUrlProfilePreset(
  'stripe.event.v1',
);
if (REMOTE_URL_PRESET === null) {
  throw new Error('Stripe registration remote-URL test preset is unavailable');
}
const REMOTE_URL_PARSER = createWebhookBoundedHttpUrlParser(
  REMOTE_URL_PRESET.parser,
);

const API_KEY_PRESET = webhookRegistrationEnvironmentTokenProfilePreset(
  'stripe.event.v1',
);
if (API_KEY_PRESET === null
  || API_KEY_PRESET.classifier.kind
    !== 'environment_mapped_prefixed_ascii_token.v1') {
  throw new Error('Stripe registration environment-token test preset is unavailable');
}
const API_KEY_CLASSIFIER =
  createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier(
    API_KEY_PRESET.classifier,
  );

const desired = {
  paired_connection_id: 'stripe-test',
  desired: {
    ingress_id: 'whi_0123456789abcdef0123456789abcdef',
    environment: 'test' as const,
    registration_target: null,
    endpoint_url: 'https://hooks.example/v1/webhooks/opaquePublicId_0123456789abcdef',
    event_types: ['invoice.paid', 'invoice.payment_failed'],
  },
};

const REMOTE_ID = 'we_1234567890abcdef';

const endpoint = (overrides: Record<string, unknown> = {}) => ({
  id: REMOTE_ID,
  object: 'webhook_endpoint',
  livemode: false,
  status: 'enabled',
  url: desired.desired.endpoint_url,
  enabled_events: desired.desired.event_types,
  metadata: {
    recued_ingress_id: desired.desired.ingress_id,
    recued_profile_id: 'stripe.event.v1',
    recued_environment: 'test',
  },
  ...overrides,
});

const json = (body: unknown, status = 200): Response => new Response(
  JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } },
);

const makeAdapter = (overrides: Partial<StripeWebhookRegistrationDeps> = {}) =>
  createStripeWebhookRegistrationAdapter({
    apiKeyClassifier: API_KEY_CLASSIFIER,
    endpointSecretParser: ENDPOINT_SECRET_PARSER,
    eventTypeParser: EVENT_TYPE_PARSER,
    idempotencyKeyParser: IDEMPOTENCY_KEY_PARSER,
    remoteIdParser: REMOTE_ID_PARSER,
    remoteUrlParser: REMOTE_URL_PARSER,
    responseReader: RESPONSE_READER,
    resolveConnection: async () => ({ api_key: 'sk_test_FAKEKEY123' }),
    ...overrides,
  });

describe('D-201 Slices 6A + 9AI-9AJ + 9AP + 9AS-9AT + 9AY + 9BB Stripe managed webhook registration adapter', () => {
  it('rejects a registration target instead of silently ignoring foreign scope', async () => {
    const resolveConnection = vi.fn(async () => ({ api_key: 'sk_test_FAKEKEY123' }));
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => json({
      object: 'list',
      has_more: false,
      data: [],
    }));
    const adapter = makeAdapter({
      resolveConnection,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(adapter.find({
      ...desired,
      desired: {
        ...desired.desired,
        registration_target: { kind: 'repository', key: 'openai/example' },
      },
    })).rejects.toMatchObject({ code: 'registration_input_invalid' });
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the injected bounded response reader for Stripe API bodies', async () => {
    const responseReader = createWebhookRegistrationJsonResponseReader({
      kind: 'bounded_json_response.v1',
      max_bytes: 1,
      error_label: 'Injected Stripe fixture',
    });
    const fetchImpl = vi.fn(async () => json({
      object: 'list',
      has_more: false,
      data: [],
    }));
    const adapter = makeAdapter({ responseReader, fetchImpl });

    await expect(adapter.find(desired)).rejects.toMatchObject({
      code: 'upstream_response_too_large',
      message: 'Injected Stripe fixture response exceeded the size limit',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('pins one injected API-key classification and uses its token as Basic authority', async () => {
    const compiled = createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier({
      kind: 'environment_mapped_prefixed_ascii_token.v1',
      max_bytes: 64,
      mappings: [
        { prefix: 'fixture_test_', environment: 'test' },
        { prefix: 'fixture_live_', environment: 'live' },
      ],
    });
    const classify = vi.fn(() => Object.freeze({
      value: 'fixture_test_CLEAN',
      environment: 'test' as const,
    }));
    let tokenReads = 0;
    const connection = Object.create(null) as { api_key: string };
    Object.defineProperty(connection, 'api_key', {
      enumerable: true,
      get() {
        tokenReads += 1;
        return tokenReads === 1 ? 'fixture_test_RAW' : 'fixture_live_BAD';
      },
    });
    const fetchImpl = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => json({
      object: 'list',
      has_more: false,
      data: [],
    }));
    const adapter = makeAdapter({
      apiKeyClassifier: { preset: compiled.preset, classify },
      fetchImpl,
      resolveConnection: async () => connection,
    });

    await expect(adapter.find(desired)).resolves.toEqual([]);
    await expect(adapter.find(desired)).resolves.toEqual([]);
    expect(tokenReads).toBe(1);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith('fixture_test_RAW');
    for (const [, init] of fetchImpl.mock.calls) {
      const authorization = (init?.headers as Headers).get('Authorization');
      expect(Buffer.from(
        authorization!.slice('Basic '.length),
        'base64',
      ).toString('utf8')).toBe('fixture_test_CLEAN:');
    }
  });

  it('rejects non-primitive resolved API keys before provider I/O', async () => {
    const fetchImpl = vi.fn();
    const adapter = makeAdapter({
      fetchImpl,
      resolveConnection: async () => ({
        api_key: new String('sk_test_FAKEKEY123') as unknown as string,
      }),
    });

    await expect(adapter.find(desired)).rejects.toMatchObject({
      code: 'connection_auth_invalid',
      message: 'Stripe connection does not contain a test or live secret/restricted key',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses one injected remote-URL parser for desired and provider URLs', async () => {
    const remoteUrl = 'http://legacy.example/hook?query=1#fragment';
    const compiled = createWebhookBoundedHttpUrlParser(REMOTE_URL_PRESET.parser);
    const parse = vi.fn(compiled.parse);
    const fetchImpl = vi.fn(async () => json({
      object: 'list',
      has_more: false,
      data: [endpoint({ url: remoteUrl })],
    }));
    const adapter = makeAdapter({
      fetchImpl,
      remoteUrlParser: { preset: compiled.preset, parse },
    });

    await expect(adapter.find(desired)).resolves.toEqual([{
      correlation: 'owned',
      endpoint: expect.objectContaining({ endpoint_url: remoteUrl }),
    }]);
    expect(parse.mock.calls).toEqual([
      [desired.desired.endpoint_url],
      [remoteUrl],
    ]);
  });

  it('uses the injected credential parser for the one-time create secret', async () => {
    const endpointSecretParser = createWebhookPrefixedAsciiTokenParser({
      kind: 'prefixed_ascii_token.v1',
      prefix: 'fixture_',
      max_bytes: 32,
    });
    const rejectedFetch = vi.fn(async () => json({
      ...endpoint(),
      secret: 'whsec_ManagedSecret123',
    }));
    const rejected = makeAdapter({
      endpointSecretParser,
      fetchImpl: rejectedFetch,
    });

    await expect(rejected.create(desired, 'create-key')).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'Stripe create response omitted the one-time endpoint secret',
    });

    const acceptedFetch = vi.fn(async () => json({
      ...endpoint(),
      secret: 'fixture_ManagedSecret123',
    }));
    const accepted = makeAdapter({
      endpointSecretParser,
      fetchImpl: acceptedFetch,
    });
    await expect(accepted.create(desired, 'create-key')).resolves.toMatchObject({
      credential_result: { endpoint_secret: 'fixture_ManagedSecret123' },
    });
  });

  it('injects desired-event admission without narrowing provider readback', async () => {
    const eventTypeParser = createWebhookAsciiEventTypeParser({
      kind: 'ascii_alphanumeric_dot_colon_slash_dash.v1',
      max_bytes: 1,
    });
    const resolveConnection = vi.fn(async () => ({
      api_key: 'sk_test_FAKEKEY123',
    }));
    const fetchImpl = vi.fn(async () => json({
      object: 'list',
      has_more: false,
      data: [endpoint({ enabled_events: ['*'] })],
    }));
    const adapter = makeAdapter({
      eventTypeParser,
      resolveConnection,
      fetchImpl,
    });

    await expect(adapter.find(desired)).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Stripe managed registration input is invalid',
    });
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const shortDesired = {
      ...desired,
      desired: {
        ...desired.desired,
        event_types: ['a'],
      },
    };
    await expect(adapter.find(shortDesired)).resolves.toMatchObject([{
      endpoint: {
        event_types: ['*'],
      },
    }]);
    expect(resolveConnection).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the injected idempotency-key parser for create and update', async () => {
    const idempotencyKeyParser =
      createWebhookRegistrationIdempotencyKeyParser({
        kind: 'ascii_registration_idempotency_key.v1',
        max_characters: 1,
      });
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      json(endpoint()));
    const adapter = makeAdapter({ idempotencyKeyParser, fetchImpl });

    await expect(adapter.create(desired, 'ab')).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Stripe create idempotency key is invalid',
    });
    await expect(adapter.update(
      desired,
      'we_1234567890abcdef',
      'ab',
    )).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Stripe update idempotency key is invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed instead of regex-coercing non-string idempotency values', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      json(endpoint()));
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.create(desired, null as never)).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Stripe create idempotency key is invalid',
    });
    await expect(adapter.update(
      desired,
      'we_1234567890abcdef',
      1 as never,
    )).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Stripe update idempotency key is invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the injected remote-id parser for provider results and committed ids', async () => {
    const remoteIdParser = createWebhookBoundedPrefixProviderIdParser({
      kind: 'fixed_prefix_ascii_alphanumeric_id.v1',
      prefix: 'we_',
      min_suffix_length: 1,
      max_suffix_length: 1,
    });
    const providerFetch = vi.fn(async () => json({
      object: 'list',
      has_more: false,
      data: [endpoint()],
    }));
    const providerAdapter = makeAdapter({
      fetchImpl: providerFetch,
      remoteIdParser,
    });

    await expect(providerAdapter.find(desired)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'Stripe returned an invalid webhook endpoint object',
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);

    const committedFetch = vi.fn();
    const resolveConnection = vi.fn(async () => ({ api_key: 'sk_test_FAKEKEY123' }));
    const committedAdapter = makeAdapter({
      fetchImpl: committedFetch,
      remoteIdParser,
      resolveConnection,
    });
    for (const invoke of [
      () => committedAdapter.read(desired, REMOTE_ID),
      () => committedAdapter.update(desired, REMOTE_ID, 'update-key'),
      () => committedAdapter.delete(desired, REMOTE_ID),
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        code: 'upstream_response_invalid',
        message: 'Stripe remote endpoint id is invalid',
      });
    }
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(committedFetch).not.toHaveBeenCalled();
  });

  it('fails closed instead of regex-coercing non-string remote ids', async () => {
    const fetchImpl = vi.fn();
    const resolveConnection = vi.fn(async () => ({ api_key: 'sk_test_FAKEKEY123' }));
    const adapter = makeAdapter({ fetchImpl, resolveConnection });
    const boxedRemoteId = new String(REMOTE_ID) as never;

    await expect(adapter.update(
      desired,
      boxedRemoteId,
      null as never,
    )).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Stripe update idempotency key is invalid',
    });
    for (const invoke of [
      () => adapter.read(desired, boxedRemoteId),
      () => adapter.update(desired, boxedRemoteId, 'update-key'),
      () => adapter.delete(desired, boxedRemoteId),
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        code: 'upstream_response_invalid',
        message: 'Stripe remote endpoint id is invalid',
      });
    }
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('creates with only trusted form fields/idempotency and captures the one-time secret', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => json({
      ...endpoint(),
      secret: 'whsec_ManagedSecret123',
    }));
    const adapter = makeAdapter({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(adapter.create(desired, 'recued-idempotency-1')).resolves.toEqual({
      endpoint: {
        remote_endpoint_id: 'we_1234567890abcdef',
        environment: 'test',
        endpoint_url: desired.desired.endpoint_url,
        event_types: desired.desired.event_types,
        enabled: true,
        correlation_valid: true,
      },
      credential_result: { endpoint_secret: 'whsec_ManagedSecret123' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(init).toBeDefined();
    const requestInit = init!;
    expect(url).toBe('https://api.stripe.com/v1/webhook_endpoints');
    expect(requestInit.method).toBe('POST');
    const headers = requestInit.headers as Headers;
    expect(headers.get('Idempotency-Key')).toBe('recued-idempotency-1');
    expect(Buffer.from(
      headers.get('Authorization')!.slice('Basic '.length),
      'base64',
    ).toString('utf8')).toBe('sk_test_FAKEKEY123:');
    const form = new URLSearchParams(String(requestInit.body));
    expect(form.get('url')).toBe(desired.desired.endpoint_url);
    expect(form.getAll('enabled_events[]')).toEqual(desired.desired.event_types);
    expect(form.get('metadata[recued_ingress_id]')).toBe(desired.desired.ingress_id);
    expect([...form.keys()].sort()).toEqual([
      'description',
      'enabled_events[]',
      'enabled_events[]',
      'metadata[recued_environment]',
      'metadata[recued_ingress_id]',
      'metadata[recued_profile_id]',
      'url',
    ].sort());
  });

  it('finds owned and URL-only collisions without treating URL equality as deletion authority', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => json({
      object: 'list',
      has_more: false,
      data: [
        endpoint({
          id: 'we_owned1234567890',
          url: 'https://old.example/v1/webhooks/old',
        }),
        endpoint({
          id: 'we_urlonly1234567',
          metadata: { recued_ingress_id: 'whi_someone_else_1234567890' },
        }),
        endpoint({
          id: 'we_metadataconflict1',
          url: 'https://old.example/v1/webhooks/old',
          metadata: {
            recued_ingress_id: desired.desired.ingress_id,
            recued_profile_id: 'stripe.event.v0',
            recued_environment: 'live',
          },
        }),
        endpoint({
          id: 'we_unrelated123456',
          // A valid unrelated provider URL need not use WHATWG's canonical
          // spelling. It must not make the exhaustive account scan fail.
          url: 'https://unrelated.example:443/hook',
          metadata: {},
        }),
      ],
    }));
    const adapter = makeAdapter({
      resolveConnection: async () => ({ api_key: 'rk_test_FAKEKEY123' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(adapter.find(desired)).resolves.toEqual([
      expect.objectContaining({
        correlation: 'owned',
        endpoint: expect.objectContaining({ remote_endpoint_id: 'we_owned1234567890' }),
      }),
      expect.objectContaining({
        correlation: 'url_only',
        endpoint: expect.objectContaining({ remote_endpoint_id: 'we_urlonly1234567' }),
      }),
      expect.objectContaining({
        correlation: 'metadata_conflict',
        endpoint: expect.objectContaining({ remote_endpoint_id: 'we_metadataconflict1' }),
      }),
    ]);
    expect(String(fetchImpl.mock.calls[0]![0]))
      .toBe('https://api.stripe.com/v1/webhook_endpoints?limit=100');
  });

  it('uses retrieve/update/delete and treats missing reads/deletes idempotently', async () => {
    const responses = [
      json(endpoint()),
      json(endpoint({ enabled_events: ['invoice.paid'] })),
      json({ id: 'we_1234567890abcdef', object: 'webhook_endpoint', deleted: true }),
      json({ error: { type: 'invalid_request_error' } }, 404),
      json({ error: { type: 'invalid_request_error' } }, 404),
    ];
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) => responses.shift()!);
    const resolveConnection = vi.fn(async () => ({ api_key: 'sk_test_FAKEKEY123' }));
    const adapter = makeAdapter({
      resolveConnection,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(adapter.read(desired, 'we_1234567890abcdef'))
      .resolves.toEqual(expect.objectContaining({ enabled: true }));
    await expect(adapter.update(
      desired,
      'we_1234567890abcdef',
      'update-key',
    )).resolves.toEqual(expect.objectContaining({ event_types: ['invoice.paid'] }));
    await expect(adapter.delete(desired, 'we_1234567890abcdef')).resolves.toBeUndefined();
    await expect(adapter.read(desired, 'we_1234567890abcdef')).resolves.toBeNull();
    await expect(adapter.delete(desired, 'we_1234567890abcdef')).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls.map(([, init]) => init!.method))
      .toEqual(['GET', 'POST', 'DELETE', 'GET', 'DELETE']);
    expect(resolveConnection).toHaveBeenCalledTimes(1);
  });

  it('fails closed across test/live keys, response mode, and lost creation secrets', async () => {
    const noFetch = vi.fn(async (..._args: Parameters<typeof fetch>) => json(endpoint()));
    const liveKeyAdapter = makeAdapter({
      resolveConnection: async () => ({ api_key: 'sk_live_FAKEKEY123' }),
      fetchImpl: noFetch as unknown as typeof fetch,
    });
    await expect(liveKeyAdapter.find(desired)).rejects.toMatchObject({
      code: 'environment_mismatch',
    });
    expect(noFetch).not.toHaveBeenCalled();

    const liveResponseAdapter = makeAdapter({
      fetchImpl: (async () => json(endpoint({ livemode: true }))) as typeof fetch,
    });
    await expect(liveResponseAdapter.read(desired, 'we_1234567890abcdef'))
      .rejects.toMatchObject({ code: 'environment_mismatch' });

    const wrongIdAdapter = makeAdapter({
      fetchImpl: (async () => json(endpoint({
        id: 'we_different12345678',
      }))) as typeof fetch,
    });
    await expect(wrongIdAdapter.read(desired, 'we_1234567890abcdef'))
      .rejects.toMatchObject({ code: 'upstream_response_invalid' });

    const noSecretAdapter = makeAdapter({
      fetchImpl: (async () => json(endpoint())) as typeof fetch,
    });
    await expect(noSecretAdapter.create(desired, 'create-key'))
      .rejects.toMatchObject({ code: 'upstream_response_invalid' });
  });

  it('bounds provider bytes and fails closed on malformed JSON or UTF-8', async () => {
    const oversized = makeAdapter({
      fetchImpl: (async () => new Response('x'.repeat(512 * 1024 + 1))) as typeof fetch,
    });
    await expect(oversized.find(desired)).rejects.toMatchObject({
      code: 'upstream_response_too_large',
    });

    const malformed = makeAdapter({
      fetchImpl: (async () => new Response('{')) as typeof fetch,
    });
    await expect(malformed.find(desired)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'Stripe webhook registration returned malformed JSON',
    });

    const corruptPrefix = new TextEncoder().encode(
      '{"object":"list","has_more":false,"data":[],"ignored":"',
    );
    const corruptSuffix = new TextEncoder().encode('"}');
    const corruptBytes = new Uint8Array(
      corruptPrefix.byteLength + 1 + corruptSuffix.byteLength,
    );
    corruptBytes.set(corruptPrefix);
    corruptBytes[corruptPrefix.byteLength] = 0xff;
    corruptBytes.set(corruptSuffix, corruptPrefix.byteLength + 1);
    const invalidUtf8 = makeAdapter({
      fetchImpl: (async () => new Response(corruptBytes)) as typeof fetch,
    });
    await expect(invalidUtf8.find(desired)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'Stripe webhook registration returned invalid UTF-8',
    });
  });
});
