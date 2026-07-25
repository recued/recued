import { createHmac, createHash } from 'node:crypto';
import http from 'node:http';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_OWNER_PROFILE_SETTINGS,
  webhookProfile,
} from '@recued/contracts';
import { createBuiltinWebhookDeliveryProfileAdapters } from '../webhook-delivery-profile-presets.js';
import { startServer } from '../server.js';
import { createWebhookDeliveryStore } from '../storage/webhook-delivery-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import {
  WEBHOOK_JSON_API_SINGLE_EVENT_PROFILE_PRESETS,
} from '../webhook-json-api-single-event-profile-presets.js';
import {
  createLemonSqueezyWebhookProfileAdapter,
  LEMONSQUEEZY_EVENT_TYPE_PARSER_PRESET,
  LEMONSQUEEZY_JSON_API_EVENT_NORMALIZER_PRESET,
  LEMONSQUEEZY_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET,
  LEMONSQUEEZY_RECEIVED_AT_BODY_DEDUPLICATOR_PRESET,
  LEMONSQUEEZY_WEBHOOK_RAW_BODY_HMAC_MECHANISM_PRESET,
  validateLemonSqueezyWebhookCredentialShape,
} from '../webhook-lemonsqueezy-profile.js';
import { createWebhookJsonApiSingleEventNormalizer } from '../webhook-json-api-single-event-normalizer.js';
import { createWebhookLowercaseIdentifierEventTypeParser } from '../webhook-lowercase-identifier-event-type-parser.js';
import { BUILTIN_WEBHOOK_PROFILE_POLICIES } from '../webhook-profile-policy.js';
import { createWebhookOutboxRuntime } from '../webhook-outbox-dispatcher.js';
import { createWebhookProfileListener } from '../webhook-profile-listener.js';
import {
  createRawBodyJsonApiSingleEventWebhookProfileAdapter,
} from '../webhook-raw-body-json-api-single-event-profile.js';
import {
  createWebhookReceivedAtBodyDeduplicator,
} from '../webhook-received-at-body-deduplicator.js';
import type {
  RawWebhookRequest,
  ResolvedWebhookCredentialVersion,
  WebhookProfileResult,
  WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';
import { createWebhookProfileRuntimeRegistry } from '../webhook-profile-runtime.js';

const NOW_MS = Date.parse('2026-07-13T19:00:00.000Z');
const WINDOW_MS = 5 * 60 * 1_000;
const SECRET = 'lemonsqueezy-profile-secret';
const OLDER_SECRET = 'older-lemonsqueezy-secret';
const DOCUMENTED_EVENT_TYPES = [
  'order_created',
  'order_refunded',
  'customer_updated',
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
  'subscription_payment_success',
  'subscription_payment_failed',
  'subscription_payment_recovered',
  'subscription_payment_refunded',
  'license_key_created',
  'license_key_updated',
  'affiliate_activated',
] as const;

const payload = (
  eventName = 'subscription_payment_success',
  resourceId = '129339',
): Record<string, unknown> => ({
  meta: {
    event_name: eventName,
    custom_data: { user_id: '123' },
  },
  data: {
    type: 'subscription-invoices',
    id: resourceId,
    attributes: {
      store_id: 1,
      status: 'paid',
      total: 999,
      test_mode: true,
    },
    relationships: {
      store: { links: { related: 'https://api.lemonsqueezy.com/v1/stores/1' } },
    },
    links: {
      self: `https://api.lemonsqueezy.com/v1/subscription-invoices/${resourceId}`,
    },
  },
});

const bodyOf = (value: Record<string, unknown> = payload()): Buffer =>
  Buffer.from(JSON.stringify(value), 'utf8');

const signatureFor = (body: Buffer, secret = SECRET): string =>
  createHmac('sha256', secret).update(body).digest('hex');

const version = (
  value: number,
  secret: string,
): ResolvedWebhookCredentialVersion => ({
  version: String(value),
  created_at: NOW_MS + value,
  credentials: { signing_secret: secret },
});

const context = (input: {
  environment?: 'test' | 'live' | 'custom';
  credentials?: readonly ResolvedWebhookCredentialVersion[];
} = {}): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201_lemonsqueezy_fixture',
  environment: input.environment ?? 'test',
  credential_versions: input.credentials ?? [version(1, SECRET)],
  now: () => {
    throw new Error('Lemon Squeezy raw-body HMAC must not read a clock');
  },
});

const values = (value: string | readonly string[]): readonly string[] =>
  typeof value === 'string' ? [value] : value;

const request = (input: {
  body?: Buffer;
  signature?: string | readonly string[];
  signatureSecret?: string;
  eventName?: string | readonly string[];
  receivedAt?: number;
} = {}): RawWebhookRequest => {
  const body = input.body ?? bodyOf();
  return {
    method: 'POST',
    raw_body: body,
    headers: new Map([
      ['content-type', ['application/json']],
      ['x-signature', values(
        input.signature ?? signatureFor(body, input.signatureSecret ?? SECRET),
      )],
      ['x-event-name', values(
        input.eventName ?? 'subscription_payment_success',
      )],
    ]),
    raw_path_and_query: '/v1/webhooks/lemonsqueezy-fixture',
    canonical_public_url:
      'https://hooks.example.test/v1/webhooks/lemonsqueezy-fixture',
    received_at: input.receivedAt ?? NOW_MS,
    remote_ip: '127.0.0.1',
  };
};

const requireAccepted = (
  result: WebhookProfileResult,
): Extract<WebhookProfileResult, { ok: true }>['delivery'] => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected acceptance, got ${result.failure.code}`);
  return result.delivery;
};

const expectFailure = (
  result: WebhookProfileResult,
  code: Extract<WebhookProfileResult, { ok: false }>['failure']['code'],
  status: number,
): void => {
  expect(result).toEqual({
    ok: false,
    failure: {
      disposition: code === 'profile_internal_error' ? 'retry' : 'reject',
      code,
      response: { status },
    },
  });
};

const expectDeeplyFrozen = (value: unknown, seen = new WeakSet<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeeplyFrozen((value as Record<PropertyKey, unknown>)[key], seen);
  }
};

describe('D-201 Slice 9BQ Lemon Squeezy webhook profile', () => {
  it('pins a portable manual profile and data-only generalized composition', () => {
    const descriptor = webhookProfile('lemonsqueezy.webhook.v1');
    expect(descriptor).toMatchObject({
      vendor: 'lemonsqueezy',
      mechanism_kind: 'raw_body_hmac',
      transport_assurance: 'authenticated',
      minimum_source_truth_policy: 'delivery_payload_allowed',
      decoder_kind: 'json',
      decoded_schema_id: 'lemonsqueezy.webhook.v1',
      registration_modes: ['manual'],
      supported_environments: ['test', 'live'],
      max_body_bytes: 1_048_576,
      max_events_per_delivery: 1,
      deduplication: {
        identity: { kind: 'received_at_body_window', window_ms: WINDOW_MS },
      },
      managed_registration_requires_connection: false,
      handshakes: [],
    });
    expect(descriptor?.event_types).toEqual({
      kind: 'open',
      known_values: DOCUMENTED_EVENT_TYPES,
    });
    expect(descriptor?.fields).toEqual([expect.objectContaining({
      key: 'signing_secret',
      kind: 'secret',
      source: 'owner',
      required: true,
    })]);

    expect(Object.keys(WEBHOOK_JSON_API_SINGLE_EVENT_PROFILE_PRESETS))
      .toEqual(['lemonsqueezy.webhook.v1']);
    expect(Object.getPrototypeOf(WEBHOOK_JSON_API_SINGLE_EVENT_PROFILE_PRESETS))
      .toBeNull();
    expectDeeplyFrozen(WEBHOOK_JSON_API_SINGLE_EVENT_PROFILE_PRESETS);
    expect(() => JSON.stringify(WEBHOOK_JSON_API_SINGLE_EVENT_PROFILE_PRESETS))
      .not.toThrow();
    expect(JSON.stringify(WEBHOOK_JSON_API_SINGLE_EVENT_PROFILE_PRESETS))
      .not.toMatch(/function|verifyAndDecode|callback/);
    expect(LEMONSQUEEZY_WEBHOOK_RAW_BODY_HMAC_MECHANISM_PRESET).toEqual({
      kind: 'raw_body_hmac_sha256.v1',
      secret_field: 'signing_secret',
      secret_shape: 'nonempty_utf8_65536',
      signature_header: { kind: 'fixed', name: 'x-signature' },
      signature_format: 'lowerhex.v1',
      matching_credential: 'newest',
    });
    expect(LEMONSQUEEZY_EVENT_TYPE_PARSER_PRESET).toEqual({
      kind: 'lowercase_identifier_event_type.v1',
      max_characters: 128,
    });
    expect(LEMONSQUEEZY_JSON_API_EVENT_NORMALIZER_PRESET).toEqual({
      kind: 'json_api_single_event.v1',
      event_type_header: 'x-event-name',
      metadata_field: 'meta',
      event_type_field: 'event_name',
      data_field: 'data',
      resource_type_field: 'type',
      resource_id_field: 'id',
      max_resource_type_bytes: 128,
      max_resource_id_bytes: 512,
    });
    expect(LEMONSQUEEZY_RECEIVED_AT_BODY_DEDUPLICATOR_PRESET).toEqual({
      kind: 'received_at_body_sha256_window.v1',
      key_prefix: 'lemonsqueezy:request:',
      window_ms: WINDOW_MS,
      max_body_bytes: 1_048_576,
    });
    expect(LEMONSQUEEZY_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET).toEqual({
      kind: 'normalized_single_event.v1',
      provider_event_id_field: 'event_id',
      provider_resource_id_field: 'resource_id',
      provider_event_type_field: 'event_type',
      provider_occurred_at_field: 'occurred_at',
      decoded_payload_field: 'payload',
      occurred_at_unit: 'unix_milliseconds.v1',
    });
  });

  it('accepts an official-shaped exact-byte delivery and projects signed body truth', async () => {
    const adapter = createLemonSqueezyWebhookProfileAdapter();
    expect(adapter.profile_id).toBe('lemonsqueezy.webhook.v1');
    expect(adapter.success_response).toEqual({ status: 200 });
    expect(adapter.buildTestDelivery).toBeUndefined();
    const rawBody = bodyOf();
    const accepted = requireAccepted(await adapter.verifyAndDecode(
      request({ body: rawBody }),
      context(),
    ));
    const bucket = Math.floor(NOW_MS / WINDOW_MS);
    const digest = createHash('sha256').update(rawBody).digest('hex');
    const key = `lemonsqueezy:request:w${bucket}:${digest}`;
    expect(accepted).toEqual({
      delivery_dedup_key: key,
      decoded_content_type: 'application/json',
      events: [{
        event_dedup_key: `${key}:0`,
        provider_event_id: null,
        provider_resource_id: '129339',
        provider_event_type: 'subscription_payment_success',
        provider_occurred_at: null,
        decoded_payload: payload(),
      }],
      response: { status: 200 },
      admission: {
        transport_assurance: 'authenticated',
        credential_version: '1',
        freshness_checked: false,
        method_label: 'lemonsqueezy-hmac-sha256',
      },
    });
  });

  it('uses bare lowercase hex only and authenticates exact raw bytes', async () => {
    const adapter = createLemonSqueezyWebhookProfileAdapter();
    const body = bodyOf();
    const signature = signatureFor(body);
    for (const invalid of [
      `sha256=${signature}`,
      signature.toUpperCase(),
      `${signature} `,
      signature.slice(0, -1),
      `${signature}0`,
    ]) {
      expectFailure(await adapter.verifyAndDecode(
        request({ body, signature: invalid }),
        context(),
      ), 'authentication_failed', 401);
    }
    expectFailure(await adapter.verifyAndDecode(request({
      body: Buffer.from(`${body.toString('utf8')}\n`, 'utf8'),
      signature,
    }), context()), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(request({
      body,
      signature: [signature, signature],
    }), context()), 'authentication_failed', 401);
  });

  it('requires the one event header to agree with signed meta.event_name', async () => {
    const adapter = createLemonSqueezyWebhookProfileAdapter();
    expectFailure(await adapter.verifyAndDecode(
      request({ eventName: 'order_created' }),
      context(),
    ), 'structural_admission_failed', 400);
    expectFailure(await adapter.verifyAndDecode(
      request({ eventName: ['subscription_payment_success', 'order_created'] }),
      context(),
    ), 'structural_admission_failed', 400);
    const headers = request().headers as Map<string, readonly string[]>;
    headers.delete('x-event-name');
    expectFailure(await adapter.verifyAndDecode({ ...request(), headers }, context()),
      'structural_admission_failed', 400);

    // Lemon Squeezy's simulator page documents this value even though its
    // authoritative "full list" page currently omits it. The open catalog and
    // closed underscore grammar keep that documented drift executable without
    // presenting it as a known subscription option.
    const simulatorOnlyBody = bodyOf(payload('subscription_plan_changed'));
    const simulatorOnly = requireAccepted(await adapter.verifyAndDecode(request({
      body: simulatorOnlyBody,
      eventName: 'subscription_plan_changed',
    }), context()));
    expect(simulatorOnly.events[0]?.provider_event_type)
      .toBe('subscription_plan_changed');
  });

  it('rejects malformed JSON:API structure, identifiers, and body ceilings', async () => {
    const adapter = createLemonSqueezyWebhookProfileAdapter();
    const cases: Array<{ value: Record<string, unknown>; eventName?: string }> = [
      { value: { data: payload().data } },
      { value: { meta: payload().meta } },
      { value: { ...payload(), meta: { event_name: 'UPPERCASE' } }, eventName: 'UPPERCASE' },
      { value: { ...payload(), meta: { event_name: '_bad' } }, eventName: '_bad' },
      { value: { ...payload(), data: { type: '', id: '1' } } },
      { value: { ...payload(), data: { type: 'orders', id: '' } } },
      { value: { ...payload(), data: { type: 'orders', id: 1 } } },
      { value: { ...payload(), data: { type: 'x'.repeat(129), id: '1' } } },
      { value: { ...payload(), data: { type: 'orders', id: 'x'.repeat(513) } } },
    ];
    for (const fixture of cases) {
      const body = bodyOf(fixture.value);
      expectFailure(await adapter.verifyAndDecode(request({
        body,
        eventName: fixture.eventName ?? 'subscription_payment_success',
      }), context()), 'structural_admission_failed', 400);
    }
    const oversized = bodyOf({
      ...payload(),
      padding: 'x'.repeat(1_048_577),
    });
    expectFailure(await adapter.verifyAndDecode(request({ body: oversized }), context()),
      'structural_admission_failed', 400);
  });

  it('uses receipt buckets honestly instead of treating a resource id as a delivery id', async () => {
    const adapter = createLemonSqueezyWebhookProfileAdapter();
    const body = bodyOf();
    const bucketStart = Math.floor(NOW_MS / WINDOW_MS) * WINDOW_MS;
    const first = requireAccepted(await adapter.verifyAndDecode(
      request({ body, receivedAt: bucketStart }),
      context(),
    ));
    const sameBucket = requireAccepted(await adapter.verifyAndDecode(
      request({ body, receivedAt: bucketStart + WINDOW_MS - 1 }),
      context(),
    ));
    const nextBucket = requireAccepted(await adapter.verifyAndDecode(
      request({ body, receivedAt: bucketStart + WINDOW_MS }),
      context(),
    ));
    expect(sameBucket.delivery_dedup_key).toBe(first.delivery_dedup_key);
    expect(nextBucket.delivery_dedup_key).not.toBe(first.delivery_dedup_key);
    expect(first.events[0]?.provider_event_id).toBeNull();
    expect(first.events[0]?.provider_resource_id).toBe('129339');

    const otherPayload = payload('subscription_payment_success', '129339');
    const otherData = otherPayload.data as Record<string, unknown>;
    otherData.attributes = {
      ...(otherData.attributes as Record<string, unknown>),
      total: 1_000,
    };
    const otherBody = bodyOf(otherPayload);
    const other = requireAccepted(await adapter.verifyAndDecode(request({
      body: otherBody,
      receivedAt: bucketStart,
    }), context()));
    expect(other.delivery_dedup_key).not.toBe(first.delivery_dedup_key);
    expect(other.events[0]?.provider_resource_id).toBe('129339');
  });

  it('supports overlap-safe credential attribution and fails closed on configuration', async () => {
    const adapter = createLemonSqueezyWebhookProfileAdapter();
    const body = bodyOf();
    const credentials = [version(1, OLDER_SECRET), version(2, SECRET)];
    expect(requireAccepted(await adapter.verifyAndDecode(request({
      body,
      signatureSecret: OLDER_SECRET,
    }), context({ credentials }))).admission.credential_version).toBe('1');
    expect(requireAccepted(await adapter.verifyAndDecode(request({
      body,
      signatureSecret: SECRET,
    }), context({ credentials }))).admission.credential_version).toBe('2');
    const shared = [version(1, SECRET), version(2, SECRET)];
    expect(requireAccepted(await adapter.verifyAndDecode(
      request({ body }),
      context({ credentials: shared }),
    )).admission.credential_version).toBe('2');
    expectFailure(await adapter.verifyAndDecode(
      request({ body }),
      context({ credentials: [] }),
    ), 'profile_internal_error', 503);
    expectFailure(await adapter.verifyAndDecode(
      request({ body }),
      context({ environment: 'custom' }),
    ), 'profile_internal_error', 503);
    expect((await adapter.verifyAndDecode(
      request({ body }),
      context({ environment: 'live' }),
    )).ok).toBe(true);
  });

  it('persists, deduplicates, acknowledges, and dispatches through the public listener', async () => {
    const db = new Database(':memory:');
    const ingressStore = createWebhookIngressStore(db, {
      now: () => NOW_MS,
      getEncryptionKey: () => new Uint8Array(32).fill(41),
    });
    const created = ingressStore.create({
      display_name: 'Durable Lemon Squeezy fixture',
      profile_id: 'lemonsqueezy.webhook.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['subscription_payment_success'],
    });
    await ingressStore.writeCredentialVersion(created.ingress_id, {
      signing_secret: SECRET,
    });
    const endpoint = `https://hooks.example.test/v1/webhooks/${created.public_id}`;
    ingressStore.confirmManualRegistration(created.ingress_id, {
      requires_handshake: false,
      endpoint_url: endpoint,
    });
    ingressStore.enable(created.ingress_id);
    const deliveryStore = createWebhookDeliveryStore(db, {
      now: () => NOW_MS,
      getEncryptionKey: () => new Uint8Array(32).fill(42),
      hasDispatchTarget: () => true,
    });
    const dispatched: string[] = [];
    const outbox = createWebhookOutboxRuntime(deliveryStore, {
      dispatch: async (event) => {
        dispatched.push(event.idempotency_key);
      },
    }, { poll_interval_ms: 60_000 });
    const listener = createWebhookProfileListener({
      ingressStore,
      deliveryStore,
      profiles: createWebhookProfileRuntimeRegistry([
        createLemonSqueezyWebhookProfileAdapter(),
      ]),
      isOutboxDispatcherStarted: outbox.isStarted,
      resolveCanonicalPublicUrl: () => endpoint,
      now: () => NOW_MS,
    });
    const server = await startServer(0, { webhookProfileListener: listener });
    outbox.start();

    const send = (
      body: Buffer,
    ): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: server.port,
        path: `/v1/webhooks/${created.public_id}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.byteLength,
          'X-Signature': signatureFor(body),
          'X-Event-Name': 'subscription_payment_success',
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', reject);
      req.end(body);
    });

    const body = bodyOf();
    const changed = payload();
    const changedData = changed.data as Record<string, unknown>;
    changedData.attributes = {
      ...(changedData.attributes as Record<string, unknown>),
      total: 1_001,
    };
    const changedBody = bodyOf(changed);
    try {
      await expect(send(body)).resolves.toEqual({ status: 200, body: '' });
      await expect(send(body)).resolves.toEqual({ status: 200, body: '' });
      await expect(send(changedBody)).resolves.toEqual({ status: 200, body: '' });
      expect(deliveryStore.listDeliveries(created.ingress_id)).toHaveLength(2);
      const storedEvents = deliveryStore.listEvents(created.ingress_id);
      expect(storedEvents).toHaveLength(2);
      expect(storedEvents.every((event) =>
        event.provider_event_id === null
        && event.provider_resource_id === '129339'
        && event.provider_event_type === 'subscription_payment_success'
        && event.dispatch_state === 'pending')).toBe(true);
      expect(deliveryStore.listOutbox()).toHaveLength(2);
      await outbox.drainOnce();
      expect(dispatched.slice().sort()).toEqual(storedEvents
        .map((event) => event.event_id)
        .sort());
    } finally {
      await server.close();
      await outbox.stop();
      db.close();
    }
  });

  it('pins exact credential shape, production mount, policy, and manual owner flow', () => {
    expect(validateLemonSqueezyWebhookCredentialShape({
      signing_secret: SECRET,
    })).toBe(true);
    expect(validateLemonSqueezyWebhookCredentialShape({
      signing_secret: '',
    })).toBe(false);
    expect(validateLemonSqueezyWebhookCredentialShape({
      signing_secret: 'x'.repeat(65_536),
    })).toBe(true);
    expect(validateLemonSqueezyWebhookCredentialShape({
      signing_secret: 'x'.repeat(65_537),
    })).toBe(false);
    expect(validateLemonSqueezyWebhookCredentialShape({
      signing_secret: SECRET,
      algorithm: 'sha1',
    })).toBe(false);
    expect(BUILTIN_WEBHOOK_PROFILE_POLICIES.get('lemonsqueezy.webhook.v1')
      .validateCredentialShape({ signing_secret: SECRET })).toBe(true);
    expect(createBuiltinWebhookDeliveryProfileAdapters(null)
      .filter((candidate) => candidate.profile_id === 'lemonsqueezy.webhook.v1'))
      .toHaveLength(1);
    expect(() => createRawBodyJsonApiSingleEventWebhookProfileAdapter(
      'github.webhook.v1',
    )).toThrow('is unavailable');

    const settings = WEBHOOK_OWNER_PROFILE_SETTINGS['lemonsqueezy.webhook.v1'];
    expect(settings.create_instructions.manual?.default)
      .toContain('Settings > Webhooks');
    expect(settings.manual_confirmation_instructions.test)
      .toContain('test-mode simulation or dashboard resend');
    expect(settings.credential_rotation_instructions)
      .toContain('accepted delivery verified by the new version');
    expect(settings.test_delivery_boundary)
      .toContain('No Recued-originated test delivery is available');
    expect(settings.manual_retirement_instructions)
      .toContain('Delete or disable the matching webhook');
  });

  it('keeps the neutral normalizer and deduplicator total under hostile direct inputs', () => {
    const eventTypeParser = createWebhookLowercaseIdentifierEventTypeParser(
      LEMONSQUEEZY_EVENT_TYPE_PARSER_PRESET,
    );
    const normalizer = createWebhookJsonApiSingleEventNormalizer(
      LEMONSQUEEZY_JSON_API_EVENT_NORMALIZER_PRESET,
      eventTypeParser,
    );
    let accessorReads = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, 'meta', {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error('must not execute');
      },
    });
    Object.defineProperty(hostile, 'data', {
      enumerable: true,
      value: { type: 'orders', id: '1' },
    });
    expect(normalizer.normalize(new Map([
      ['x-event-name', ['order_created']],
    ]), hostile)).toBeNull();
    expect(accessorReads).toBe(0);
    expect(normalizer.normalize(new Map([
      ['x-event-name', ['order_created']],
    ]), Object.assign(Object.create({ inherited: true }), payload('order_created'))))
      .toBeNull();

    const deduplicator = createWebhookReceivedAtBodyDeduplicator(
      LEMONSQUEEZY_RECEIVED_AT_BODY_DEDUPLICATOR_PRESET,
    );
    expect(deduplicator.deduplicate(-1, Buffer.from('{}'))).toBeNull();
    expect(deduplicator.deduplicate(1.5, Buffer.from('{}'))).toBeNull();
    expect(deduplicator.deduplicate(
      NOW_MS,
      new Uint8Array([1]) as unknown as Buffer,
    )).toBeNull();
    expect(() => createWebhookReceivedAtBodyDeduplicator({
      ...LEMONSQUEEZY_RECEIVED_AT_BODY_DEDUPLICATOR_PRESET,
      window_ms: 0,
    })).toThrow('invalid trusted preset');
    expect(() => createWebhookReceivedAtBodyDeduplicator({
      ...LEMONSQUEEZY_RECEIVED_AT_BODY_DEDUPLICATOR_PRESET,
      owner_hash: 'sha1',
    } as never)).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonApiSingleEventNormalizer({
      ...LEMONSQUEEZY_JSON_API_EVENT_NORMALIZER_PRESET,
      event_type_header: 'X-Event-Name',
    }, eventTypeParser)).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonApiSingleEventNormalizer({
      ...LEMONSQUEEZY_JSON_API_EVENT_NORMALIZER_PRESET,
      data_field: 'constructor',
    }, eventTypeParser)).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonApiSingleEventNormalizer({
      ...LEMONSQUEEZY_JSON_API_EVENT_NORMALIZER_PRESET,
      event_type_header: 'content-encoding',
    }, eventTypeParser)).toThrow('invalid trusted preset');
    expect(() => createWebhookJsonApiSingleEventNormalizer({
      ...LEMONSQUEEZY_JSON_API_EVENT_NORMALIZER_PRESET,
      json_path: '$.meta.event_name',
    } as never, eventTypeParser)).toThrow('invalid trusted preset');
  });
});
