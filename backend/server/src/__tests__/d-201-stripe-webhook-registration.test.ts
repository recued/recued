import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import {
  createWebhookManagedRegistrationService,
  WEBHOOK_UNSETTLED_CREATE_GIVE_UP_MS,
  WEBHOOK_UNSETTLED_CREATE_WINDOW_MS,
} from '../webhook-registration-reconciler.js';
import {
  createWebhookRegistrationRuntimeRegistry,
  WebhookRegistrationAdapterError,
} from '../webhook-registration-runtime.js';
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

    // D-201 Slice 10G — create and update check the desired names, before
    // any connection or request...
    await expect(adapter.create(desired, 'create-key')).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Stripe managed registration input is invalid',
    });
    await expect(adapter.update(desired, REMOTE_ID, 'update-key')).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'Stripe managed registration input is invalid',
    });
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    // ...and a search, which cleanup runs, does not depend on them.
    await expect(adapter.find(desired)).resolves.toMatchObject([{
      endpoint: { event_types: ['*'] },
    }]);
    resolveConnection.mockClear();
    fetchImpl.mockClear();

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

/** D-201 Slice 10K — a Stripe that keeps idempotency as Stripe does: the first
 *  result to a key is what every later request with that key gets, whatever
 *  happened since. D-201 Slice 10T — a result once the request ran, a 5xx
 *  included; a request refused before it ran keeps none. Endpoints live in `endpoints`; `faults`
 *  makes the next reads fail, the next updates not hold, or the next creates be
 *  refused.
 *  D-201 Slice 10O — `faults.loseCreates` / `loseUpdates`: the request reaches
 *  Stripe and no response comes back, while Stripe is still carrying it out.
 *  Until `land()` finishes it, a request with its key is refused (409: no
 *  result is kept for it); after, the key gives that request's result. */
/** `idBase` — D-201 Slice 10Z: each account's endpoint ids start apart, as
 *  Stripe's are unique across accounts. */
const stripeApi = (idBase = 0) => {
  const endpoints = new Map<string, Record<string, unknown>>();
  const firstResponses = new Map<string, { status: number; body: unknown }>();
  const requests: Array<{ method: string; path: string; key: string | null }> = [];
  const faults = {
    failReads: 0, ignoreUpdates: 0, refuseCreates: 0, failUpdates: 0, loseCreates: 0, loseUpdates: 0,
  };
  /** Requests Stripe is still carrying out, by key. */
  const inFlight = new Map<string, () => void>();
  let made = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const key = (init?.headers as Headers | undefined)?.get('Idempotency-Key') ?? null;
    requests.push({ method, path: url.pathname, key });
    if (key !== null && inFlight.has(key)) {
      return json({ error: { type: 'idempotency_error', message: 'Another request with this key is in progress' } }, 409);
    }
    const first = key === null ? undefined : firstResponses.get(key);
    if (first !== undefined) return json(first.body, first.status);
    const answer = (body: unknown, status = 200): Response => {
      // D-201 Slice 10T (10Q finding 21) — Stripe saves a key's result once its
      // endpoint began running, a 5xx included. A request refused before that
      // saves none, so the key can be sent again: failed validation (this
      // fake's only 4xx here), or a 409 for a request still running under it.
      if (key !== null && (status < 400 || status >= 500)) firstResponses.set(key, { status, body });
      return json(body, status);
    };
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    if (url.pathname === '/v1/webhook_endpoints' && method === 'GET') {
      return json({ object: 'list', data: [...endpoints.values()], has_more: false });
    }
    if (url.pathname === '/v1/webhook_endpoints' && method === 'POST') {
      if (faults.loseCreates > 0 && key !== null) {
        faults.loseCreates -= 1;
        const urlValue = form.get('url');
        const events = form.getAll('enabled_events[]');
        inFlight.set(key, () => {
          made += 1;
          const id = `we_${(idBase + made).toString(16).padStart(16, '0')}`;
          const created = endpoint({ id, url: urlValue, enabled_events: events });
          endpoints.set(id, created);
          firstResponses.set(key, { status: 200, body: { ...created, secret: `whsec_ReplayFakeSecret${made}` } });
        });
        throw new TypeError('fetch failed');
      }
      if (faults.refuseCreates > 0) {
        faults.refuseCreates -= 1;
        return answer({ error: { type: 'invalid_request_error', message: 'Not allowed' } }, 400);
      }
      made += 1;
      const id = `we_${(idBase + made).toString(16).padStart(16, '0')}`;
      const created = endpoint({
        id,
        url: form.get('url'),
        enabled_events: form.getAll('enabled_events[]'),
      });
      endpoints.set(id, created);
      return answer({ ...created, secret: `whsec_ReplayFakeSecret${made}` });
    }
    const id = /^\/v1\/webhook_endpoints\/(we_[0-9a-f]+)$/.exec(url.pathname)?.[1];
    if (id !== undefined) {
      const current = endpoints.get(id);
      if (method === 'GET') {
        if (faults.failReads > 0) {
          faults.failReads -= 1;
          return json({ error: { type: 'api_error', message: 'Stripe is unavailable' } }, 500);
        }
        return current === undefined
          ? json({ error: { type: 'invalid_request_error', code: 'resource_missing' } }, 404)
          : json(current);
      }
      if (method === 'POST' && current !== undefined) {
        if (faults.loseUpdates > 0 && key !== null) {
          faults.loseUpdates -= 1;
          const urlValue = form.get('url');
          const events = form.getAll('enabled_events[]');
          inFlight.set(key, () => {
            Object.assign(current, { url: urlValue, enabled_events: events });
            firstResponses.set(key, { status: 200, body: { ...current } });
          });
          throw new TypeError('fetch failed');
        }
        if (faults.failUpdates > 0) {
          faults.failUpdates -= 1;
          return answer({ error: { type: 'api_error', message: 'Stripe is unavailable' } }, 500);
        }
        if (faults.ignoreUpdates > 0) {
          faults.ignoreUpdates -= 1;
          return answer(current);
        }
        Object.assign(current, {
          url: form.get('url'),
          enabled_events: form.getAll('enabled_events[]'),
          status: form.get('disabled') === 'true' ? 'disabled' : 'enabled',
        });
        return answer(current);
      }
      if (method === 'DELETE') {
        endpoints.delete(id);
        return json({ id, object: 'webhook_endpoint', deleted: true });
      }
    }
    throw new Error(`unexpected Stripe call ${method} ${url.pathname}`);
  });
  const keysOf = (method: string, path: RegExp) => requests
    .filter((call) => call.method === method && path.test(call.path))
    .map((call) => call.key);
  /** D-201 Slice 10O — Stripe finishes what it was still carrying out. */
  const land = (): void => {
    for (const [key, finish] of inFlight) {
      inFlight.delete(key);
      finish();
    }
  };
  return { endpoints, requests, faults, fetchImpl, keysOf, land };
};

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

/** A managed Stripe webhook on the real store, reconciler and adapter. */
const managedStripe = () => {
  const db = new Database(':memory:');
  databases.push(db);
  const store = createWebhookIngressStore(db, {
    getEncryptionKey: () => new Uint8Array(32).fill(5),
    newIngressId: () => desired.desired.ingress_id,
    newPublicId: () => 'opaquePublicId_0123456789abcdef',
    newCredentialSetRef: () => 'whc_0123456789abcdef0123456789abcdef',
  });
  const ingress = store.create({
    display_name: 'Stripe test events',
    profile_id: 'stripe.event.v1',
    environment: 'test',
    paired_connection_id: 'stripe-test',
    registration_mode: 'managed_endpoint',
    selected_event_types: [...desired.desired.event_types],
  });
  const api = stripeApi();
  const service = createWebhookManagedRegistrationService({
    store,
    adapters: createWebhookRegistrationRuntimeRegistry([
      makeAdapter({ fetchImpl: api.fetchImpl as unknown as typeof fetch }),
    ]),
    resolveCanonicalEndpoint: () => desired.desired.endpoint_url,
  });
  return { store, ingress, api, service };
};

describe('D-201 Slice 10K — a Stripe registration that can be retried', () => {
  const CREATES = /^\/v1\/webhook_endpoints$/;
  const UPDATES = /^\/v1\/webhook_endpoints\/we_[0-9a-f]+$/;

  it("removes an unconfirmed create and makes the next one under a new key, not Stripe's replay of the removed one", async () => {
    // 10H finding 7: the next pass sent the same key, Stripe answered with the
    // removed endpoint, and setup stopped on `remote_missing` for a day.
    const h = managedStripe();
    h.api.faults.failReads = 1;
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(h.api.endpoints.size).toBe(0);
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    const keys = h.api.keysOf('POST', CREATES);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect([...h.api.endpoints.keys()]).toEqual([h.store.get(h.ingress.ingress_id)!.remote_endpoint_id]);
  });

  it('sends a repair update that did not hold again under a new key, so it can hold', async () => {
    const h = managedStripe();
    await h.service.reconcile(h.ingress.ingress_id);
    const remoteId = h.store.get(h.ingress.ingress_id)!.remote_endpoint_id!;
    h.api.endpoints.get(remoteId)!.enabled_events = ['invoice.created'];
    h.api.faults.ignoreUpdates = 1;
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    const keys = h.api.keysOf('POST', UPDATES);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(h.api.endpoints.get(remoteId)!.enabled_events).toEqual(desired.desired.event_types);
  });

  it('after a repair update Stripe answered with a failure, the next one is not answered with it again', async () => {
    const h = managedStripe();
    await h.service.reconcile(h.ingress.ingress_id);
    const remoteId = h.store.get(h.ingress.ingress_id)!.remote_endpoint_id!;
    h.api.endpoints.get(remoteId)!.enabled_events = ['invoice.created'];
    h.api.faults.failUpdates = 1;
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    const keys = h.api.keysOf('POST', UPDATES);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('after a refused create, the next pass is not answered with the refusal again', async () => {
    const h = managedStripe();
    h.api.faults.refuseCreates = 1;
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    const keys = h.api.keysOf('POST', CREATES);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });
});

describe('D-201 Slice 10O — Stripe keys kept and moved as the responses say', () => {
  const CREATES = /^\/v1\/webhook_endpoints$/;
  const UPDATES = /^\/v1\/webhook_endpoints\/we_[0-9a-f]+$/;

  it('a create that got no response keeps its key, so the one Stripe is still making never lands beside another', async () => {
    // 10L finding 11: under a new key, the next pass's create committed a
    // second endpoint, and the first then landed holding a secret Recued never
    // stored.
    const h = managedStripe();
    h.api.faults.loseCreates = 1;
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
    // Still being made: the search finds nothing, and the same key is refused.
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    expect(h.api.endpoints.size).toBe(0);
    const [first, second] = h.api.keysOf('POST', CREATES);
    expect(second).toBe(first);
    // It lands: the next pass finds it by its URL, removes it (its secret was
    // never stored) and makes the one it keeps.
    h.api.land();
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    expect([...h.api.endpoints.keys()]).toEqual([h.store.get(h.ingress.ingress_id)!.remote_endpoint_id]);
  });

  it('a create whose response came back still moves its key on, as 10K made it', async () => {
    const h = managedStripe();
    h.api.faults.refuseCreates = 1;
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    h.api.faults.loseCreates = 1;
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    const keys = h.api.keysOf('POST', CREATES);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a repair update that got no response keeps its key for the next pass', async () => {
    const h = managedStripe();
    await h.service.reconcile(h.ingress.ingress_id);
    const remoteId = h.store.get(h.ingress.ingress_id)!.remote_endpoint_id!;
    h.api.endpoints.get(remoteId)!.enabled_events = ['invoice.created'];
    h.api.faults.loseUpdates = 1;
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    const [first, second] = h.api.keysOf('POST', UPDATES);
    expect(second).toBe(first);
    h.api.land();
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    expect(h.api.endpoints.get(remoteId)!.enabled_events).toEqual(desired.desired.event_types);
  });

  it('a repair back to a set an earlier repair reached holds the first time: a repair that held moved its key on', async () => {
    // 10L finding 12: the second repair sent the first one's key, Stripe
    // answered with that success without making the change, and the pass
    // failed once before the next one held.
    const h = managedStripe();
    await h.service.reconcile(h.ingress.ingress_id);
    const remoteId = h.store.get(h.ingress.ingress_id)!.remote_endpoint_id!;
    h.api.endpoints.get(remoteId)!.enabled_events = ['invoice.created'];
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    h.api.endpoints.get(remoteId)!.enabled_events = ['invoice.created'];
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    const keys = h.api.keysOf('POST', UPDATES);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(h.api.endpoints.get(remoteId)!.enabled_events).toEqual(desired.desired.event_types);
  });

  it('records a repair that did not hold before it moves the key on, so the webhook reads drifted (10L finding 14)', async () => {
    const h = managedStripe();
    await h.service.reconcile(h.ingress.ingress_id);
    const remoteId = h.store.get(h.ingress.ingress_id)!.remote_endpoint_id!;
    h.api.endpoints.get(remoteId)!.enabled_events = ['invoice.created'];
    h.api.faults.ignoreUpdates = 1;
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    // Moved on first, the record would lose its compare-and-set: still registered.
    expect(h.store.get(h.ingress.ingress_id)).toMatchObject({
      registration_state: 'drifted',
      last_error_code: 'managed_registration_drift',
    });
  });
});

describe('D-201 Slice 10T — a Stripe key kept while its request runs, and moved once confirmed', () => {
  const CREATES = /^\/v1\/webhook_endpoints$/;
  const UPDATES = /^\/v1\/webhook_endpoints\/we_[0-9a-f]+$/;

  // D-201 Slice 10Z (10V finding 10) — this said "so one endpoint lands": the
  // one Stripe was making lands, and the next pass finds it, removes it (its
  // secret was never stored) and makes the one it keeps. One stands.
  it('a create Stripe is still making keeps its key through every pass it refuses, so no second lands beside it, and one stands (10Q finding 6)', async () => {
    // 10O kept the key after no response, and a 409 then moved it on: a third
    // pass created under a new key, and two endpoints stood at the URL.
    const h = managedStripe();
    h.api.faults.loseCreates = 1;
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(h.api.endpoints.size).toBe(0);
    const keys = h.api.keysOf('POST', CREATES);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    h.api.land();
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    expect([...h.api.endpoints.keys()]).toEqual([h.store.get(h.ingress.ingress_id)!.remote_endpoint_id]);
  });

  it('a repair Stripe is still making keeps its key too', async () => {
    const h = managedStripe();
    await h.service.reconcile(h.ingress.ingress_id);
    const remoteId = h.store.get(h.ingress.ingress_id)!.remote_endpoint_id!;
    h.api.endpoints.get(remoteId)!.enabled_events = ['invoice.created'];
    h.api.faults.loseUpdates = 1;
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    const keys = h.api.keysOf('POST', UPDATES);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('a repair that got no response but landed is confirmed by a read, and its key still moves on (10Q finding 18)', async () => {
    const h = managedStripe();
    await h.service.reconcile(h.ingress.ingress_id);
    const remoteId = h.store.get(h.ingress.ingress_id)!.remote_endpoint_id!;
    h.api.endpoints.get(remoteId)!.enabled_events = ['invoice.created'];
    h.api.faults.loseUpdates = 1;
    await expect(h.service.reconcile(h.ingress.ingress_id)).rejects.toBeDefined();
    h.api.land();
    // Confirmed by its read: nothing is sent.
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    expect(h.api.keysOf('POST', UPDATES)).toHaveLength(1);
    // It drifts back within Stripe's day: the repair goes out under a new key,
    // and is made, not answered with the landed one's success.
    h.api.endpoints.get(remoteId)!.enabled_events = ['invoice.created'];
    await expect(h.service.reconcile(h.ingress.ingress_id))
      .resolves.toMatchObject({ registration_state: 'registered' });
    const keys = h.api.keysOf('POST', UPDATES);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(h.api.endpoints.get(remoteId)!.enabled_events).toEqual(desired.desired.event_types);
  });
});

/** D-201 Slice 10Z — Stripe with two accounts, a request going to the one its
 *  key belongs to: `stripe-test` and `stripe-alias` reach account A, and
 *  `stripe-other` account B. Keys are kept per account, as Stripe keeps them. */
const managedStripeAccounts = () => {
  const clock = { now: 2_000_000_000_000 };
  const db = new Database(':memory:');
  databases.push(db);
  const store = createWebhookIngressStore(db, {
    now: () => clock.now,
    getEncryptionKey: () => new Uint8Array(32).fill(5),
    newIngressId: () => desired.desired.ingress_id,
    newPublicId: () => 'opaquePublicId_0123456789abcdef',
    newCredentialSetRef: () => 'whc_0123456789abcdef0123456789abcdef',
  });
  const ingress = store.create({
    display_name: 'Stripe test events',
    profile_id: 'stripe.event.v1',
    environment: 'test',
    paired_connection_id: 'stripe-test',
    registration_mode: 'managed_endpoint',
    selected_event_types: [...desired.desired.event_types],
  });
  const accounts = { a: stripeApi(), b: stripeApi(0x100000) };
  const keyOf: Record<string, string> = {
    'stripe-test': 'sk_test_ACCOUNTAKEYONE',
    'stripe-alias': 'sk_test_ACCOUNTAKEYTWO',
    'stripe-other': 'sk_test_ACCOUNTBKEYONE',
  };
  const accountOf: Record<string, ReturnType<typeof stripeApi>> = {
    sk_test_ACCOUNTAKEYONE: accounts.a,
    sk_test_ACCOUNTAKEYTWO: accounts.a,
    sk_test_ACCOUNTBKEYONE: accounts.b,
  };
  /** Connections that cannot be reached: their account cannot be searched. */
  const unreachable = new Set<string>();
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const basic = (init?.headers as Headers).get('Authorization')!.slice('Basic '.length);
    const apiKey = Buffer.from(basic, 'base64').toString('utf8').replace(/:$/, '');
    return accountOf[apiKey]!.fetchImpl(input, init);
  };
  const service = createWebhookManagedRegistrationService({
    store,
    adapters: createWebhookRegistrationRuntimeRegistry([
      makeAdapter({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolveConnection: async (connectionId) => {
          if (unreachable.has(connectionId)) {
            throw new WebhookRegistrationAdapterError('connection_unavailable', 'the connection is gone');
          }
          return { api_key: keyOf[connectionId]! };
        },
      }),
    ]),
    resolveCanonicalEndpoint: () => desired.desired.endpoint_url,
    now: () => clock.now,
  });
  const committed = () => store.get(ingress.ingress_id)!.remote_endpoint_id;
  return { clock, store, ingress, accounts, unreachable, service, committed };
};

describe('D-201 Slice 10Z — no Stripe endpoint stands beside a create still running (10V findings 8, 9 and 23)', () => {
  const CREATES = /^\/v1\/webhook_endpoints$/;
  const UPDATES = /^\/v1\/webhook_endpoints\/we_[0-9a-f]+$/;

  it('an event edit while a create is still running: the next pass makes its endpoint, and the first is removed when it lands (finding 8)', async () => {
    const h = managedStripeAccounts();
    const id = h.ingress.ingress_id;
    h.accounts.a.faults.loseCreates = 1;
    await expect(h.service.reconcile(id)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    // The owner edits the events right after, as Settings offers.
    h.store.update(id, { selected_event_types: ['invoice.paid'] });
    await expect(h.service.reconcile(id)).resolves.toMatchObject({ registration_state: 'registered' });
    const [first, second] = h.accounts.a.keysOf('POST', CREATES);
    expect(second).not.toBe(first);
    // The first lands: 10V found both standing at the address, one holding a
    // secret Recued never stored.
    h.accounts.a.land();
    expect(h.accounts.a.endpoints.size).toBe(2);
    await expect(h.service.sweepUnsettledCreates())
      .resolves.toEqual({ removed: 1, settled: 0, given_up: 0, failed: 0 });
    expect([...h.accounts.a.endpoints.keys()]).toEqual([h.committed()]);
    // Searched again after the hour it could land in: settled.
    h.clock.now += WEBHOOK_UNSETTLED_CREATE_WINDOW_MS;
    await expect(h.service.sweepUnsettledCreates())
      .resolves.toEqual({ removed: 0, settled: 1, given_up: 0, failed: 0 });
    expect(h.store.listUnsettledCreates()).toEqual([]);
    expect([...h.accounts.a.endpoints.keys()]).toEqual([h.committed()]);
  });

  it('a rebind while a create is still running: it lands on the old account, which is searched again and cleared (finding 9)', async () => {
    const h = managedStripeAccounts();
    const id = h.ingress.ingress_id;
    h.accounts.a.faults.loseCreates = 1;
    await expect(h.service.reconcile(id)).rejects.toBeDefined();
    // The owner moves the webhook to another account; its cleanup of the old
    // one finds nothing yet.
    await expect(h.service.rebind(id, 'stripe-other'))
      .resolves.toMatchObject({ paired_connection_id: 'stripe-other' });
    await expect(h.service.reconcile(id)).resolves.toMatchObject({ registration_state: 'registered' });
    h.accounts.a.land();
    expect(h.accounts.a.endpoints.size).toBe(1);
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 1, failed: 0 });
    expect(h.accounts.a.endpoints.size).toBe(0);
    expect([...h.accounts.b.endpoints.keys()]).toEqual([h.committed()]);
  });

  // A switch-off needs a webhook on, which has its endpoint committed, so no
  // create runs beside one; a retire can meet one.
  it('a retire while a create is still running: it is removed when it lands (the 10T limit)', async () => {
    const h = managedStripeAccounts();
    const id = h.ingress.ingress_id;
    h.accounts.a.faults.loseCreates = 1;
    await expect(h.service.reconcile(id)).rejects.toBeDefined();
    await expect(h.service.cleanup(id, 'retire')).resolves.toMatchObject({ intake_state: 'retired' });
    h.accounts.a.land();
    expect(h.accounts.a.endpoints.size).toBe(1);
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 1, failed: 0 });
    expect(h.accounts.a.endpoints.size).toBe(0);
  });

  it('a stray removed from a webhook with nothing committed moves its attempt on: the next create is made, not answered with the one removed', async () => {
    const h = managedStripeAccounts();
    const id = h.ingress.ingress_id;
    h.accounts.a.faults.loseCreates = 1;
    await expect(h.service.reconcile(id)).rejects.toBeDefined();
    h.accounts.a.land();
    await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ removed: 1 });
    await expect(h.service.reconcile(id)).resolves.toMatchObject({ registration_state: 'registered' });
    const keys = h.accounts.a.keysOf('POST', CREATES);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect([...h.accounts.a.endpoints.keys()]).toEqual([h.committed()]);
  });

  // D-201 Slice 10AH (10AE finding 9) — a week of searches the sweep ran and
  // failed: one failure and a week with no sweeps gave it up.
  it('a create whose account cannot be searched is kept, and given up after a week of failed searches', async () => {
    const h = managedStripeAccounts();
    const id = h.ingress.ingress_id;
    h.accounts.a.faults.loseCreates = 1;
    await expect(h.service.reconcile(id)).rejects.toBeDefined();
    h.unreachable.add('stripe-test');
    h.clock.now += WEBHOOK_UNSETTLED_CREATE_WINDOW_MS;
    await expect(h.service.sweepUnsettledCreates())
      .resolves.toEqual({ removed: 0, settled: 0, given_up: 0, failed: 1 });
    expect(h.store.listUnsettledCreates()).toHaveLength(1);
    // A week with no sweeps counts an hour.
    h.clock.now += WEBHOOK_UNSETTLED_CREATE_GIVE_UP_MS;
    await expect(h.service.sweepUnsettledCreates())
      .resolves.toEqual({ removed: 0, settled: 0, given_up: 0, failed: 1 });
    // Then a search failing every hour: a week of them gives it up.
    const HOUR = 60 * 60 * 1000;
    for (let hour = 2; hour < 168; hour += 1) {
      h.clock.now += HOUR;
      await expect(h.service.sweepUnsettledCreates()).resolves.toMatchObject({ given_up: 0, failed: 1 });
    }
    h.clock.now += HOUR;
    await expect(h.service.sweepUnsettledCreates())
      .resolves.toEqual({ removed: 0, settled: 0, given_up: 1, failed: 0 });
    expect(h.store.listUnsettledCreates()).toEqual([]);
  });

  it('a confirmation through another connection to the same account moves the attempt on (finding 23)', async () => {
    const h = managedStripeAccounts();
    const id = h.ingress.ingress_id;
    await h.service.reconcile(id);
    const remoteId = h.committed()!;
    h.accounts.a.endpoints.get(remoteId)!.enabled_events = ['invoice.created'];
    h.accounts.a.faults.loseUpdates = 1;
    await expect(h.service.reconcile(id)).rejects.toBeDefined();
    h.accounts.a.land();
    // Moved to another key on the same account: confirmed by a read, as 10Q
    // finding 18's repair was, with nothing sent.
    await expect(h.service.rebind(id, 'stripe-alias')).resolves.toMatchObject({
      paired_connection_id: 'stripe-alias',
      registration_state: 'registered',
    });
    // It drifts back within Stripe's day: the repair goes out under a new key,
    // and is made, not answered with the landed one's success.
    h.accounts.a.endpoints.get(remoteId)!.enabled_events = ['invoice.created'];
    await expect(h.service.reconcile(id)).resolves.toMatchObject({ registration_state: 'registered' });
    const keys = h.accounts.a.keysOf('POST', UPDATES);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(h.accounts.a.endpoints.get(remoteId)!.enabled_events).toEqual(desired.desired.event_types);
  });
});
