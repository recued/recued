import { createHmac } from 'node:crypto';
import http from 'node:http';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { startServer } from '../server.js';
import {
  PADDLE_SIGNATURE_HEADER,
  PADDLE_WEBHOOK_TOLERANCE_SECONDS,
  verifyPaddleWebhookSignature,
} from '../connections/providers/paddle-webhook-protocol.js';
import { createWebhookDeliveryStore } from '../storage/webhook-delivery-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import {
  webhookTimestampedHmacDeliveryProfilePreset,
} from '../webhook-delivery-engine-presets.js';
import { createWebhookOutboxRuntime } from '../webhook-outbox-dispatcher.js';
import { createWebhookProfileListener } from '../webhook-profile-listener.js';
import {
  createWebhookProfileRuntimeRegistry,
  type RawWebhookRequest,
  type ResolvedWebhookCredentialVersion,
  type WebhookProfileResult,
  type WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';
import {
  createClockGatedPaddleWebhookProfileAdapter,
  createPaddleWebhookProfileAdapter,
  PADDLE_DATA_OBJECT_EXTRACTOR_PRESET,
  PADDLE_DELIVERY_ID_PARSER_PRESET,
  PADDLE_EVENT_ID_PARSER_PRESET,
  PADDLE_EVENT_TYPE_PARSER_PRESET,
  PADDLE_JSON_OBJECT_DECODER_PRESET,
  PADDLE_JSON_SINGLE_NOTIFICATION_NORMALIZER_PRESET,
  PADDLE_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET,
  PADDLE_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET,
  PADDLE_RESOURCE_ID_EXTRACTOR_PRESET,
  PADDLE_RFC3339_TIMESTAMP_PARSER_PRESET,
  validatePaddleWebhookCredentialShape,
} from '../webhook-paddle-profile.js';
import type { WebhookClockHealthAuthority } from '../webhook-clock-health.js';
import type {
  WebhookDotSegmentEventTypeParser,
} from '../webhook-dot-segment-event-type-parser.js';
import type {
  WebhookFixedPrefixProviderIdParser,
} from '../webhook-fixed-prefix-provider-id-parser.js';
import {
  WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
  type WebhookJsonObjectDecoder,
} from '../webhook-json-object-decoder.js';
import type {
  WebhookJsonObjectProviderIdExtractor,
} from '../webhook-json-object-provider-id-extractor.js';
import type {
  WebhookJsonRequiredObjectExtractor,
} from '../webhook-json-required-object-extractor.js';
import {
  createWebhookJsonSingleNotificationNormalizer,
} from '../webhook-json-single-notification-normalizer.js';
import type { WebhookRfc3339TimestampParser } from '../webhook-rfc3339-timestamp-parser.js';

const NOW_MS = Date.parse('2026-07-12T20:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const SECRET =
  'pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms7_6h3qd3uFSi9YCD3OLYAShQI90XTI5vEI';
const OLDER_SECRET =
  'pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms8_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const EVENT_ID = 'evt_01gks14ge726w50ch2tmaw2a1x';
const NOTIFICATION_ID = 'ntf_01ghbkd0frb9k95cnhwd1bxpvk';
const SECOND_NOTIFICATION_ID = 'ntf_01ghbkd0frb9k95cnhwd1bxpvm';

const paddleBody = (
  overrides: Record<string, unknown> = {},
): Buffer => Buffer.from(JSON.stringify({
  event_id: EVENT_ID,
  event_type: 'subscription.updated',
  occurred_at: '2026-07-12T19:59:58.125Z',
  notification_id: NOTIFICATION_ID,
  data: {
    id: 'sub_01h04vsc0qhwtsbsxh3422wjs4',
    status: 'active',
  },
  ...overrides,
}), 'utf8');

const digestFor = (
  body: Buffer,
  secret = SECRET,
  timestamp: string | number = NOW_SECONDS,
): string => createHmac('sha256', secret)
  .update(`${timestamp}:`)
  .update(body)
  .digest('hex');

const signatureFor = (
  body: Buffer,
  secret = SECRET,
  timestamp: string | number = NOW_SECONDS,
): string => `ts=${timestamp};h1=${digestFor(body, secret, timestamp)}`;

const credentialVersion = (
  version: number,
  endpointSecretKey: string,
): ResolvedWebhookCredentialVersion => ({
  version: String(version),
  created_at: NOW_MS + version,
  credentials: { endpoint_secret_key: endpointSecretKey },
});

const context = (input: {
  environment?: 'test' | 'live' | 'custom';
  credentials?: readonly ResolvedWebhookCredentialVersion[];
  now?: () => number;
} = {}): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201paddleprofilefixture1234',
  environment: input.environment ?? 'test',
  credential_versions: input.credentials ?? [credentialVersion(1, SECRET)],
  now: input.now ?? (() => NOW_MS),
});

const request = (input: {
  body?: Buffer;
  signature?: string | readonly string[];
  signatureSecret?: string;
} = {}): RawWebhookRequest => {
  const body = input.body ?? paddleBody();
  const signature = input.signature
    ?? signatureFor(body, input.signatureSecret ?? SECRET);
  return {
    method: 'POST',
    raw_body: body,
    headers: new Map([
      ['content-type', ['application/json']],
      [PADDLE_SIGNATURE_HEADER, typeof signature === 'string'
        ? [signature]
        : signature],
    ]),
    raw_path_and_query: '/v1/webhooks/paddle-profile-fixture',
    canonical_public_url:
      'https://hooks.example.test/v1/webhooks/paddle-profile-fixture',
    received_at: NOW_MS,
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
      disposition: code === 'profile_internal_error'
        || code === 'profile_dependency_unavailable'
        ? 'retry'
        : 'reject',
      code,
      response: { status },
    },
  });
};

describe('D-201 Slices 8G + 8M + 9F-9O Paddle profile', () => {
  it('delegates JSON and envelope fields to selected neutral engines', () => {
    const rawBody = Buffer.from('decoder-owned bytes', 'utf8');
    const envelope = {
      event_id: EVENT_ID,
      event_type: 'subscription.updated',
      occurred_at: '2026-07-12T19:59:58.125Z',
      notification_id: NOTIFICATION_ID,
      data: { id: 'sub_01h04vsc0qhwtsbsxh3422wjs4' },
    };
    let observedBody: Buffer | null = null;
    const decoder: WebhookJsonObjectDecoder = {
      preset: WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
      decode(body) {
        observedBody = body;
        return envelope;
      },
    };

    expect(PADDLE_JSON_OBJECT_DECODER_PRESET)
      .toEqual(WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET);
    expect(PADDLE_RFC3339_TIMESTAMP_PARSER_PRESET).toEqual({
      kind: 'strict_rfc3339_milliseconds.v1',
      max_bytes: 64,
    });
    let observedOccurredAt: unknown;
    const occurredAtParser: WebhookRfc3339TimestampParser = {
      preset: PADDLE_RFC3339_TIMESTAMP_PARSER_PRESET,
      parse(value) {
        observedOccurredAt = value;
        return 1_750_000_000_123;
      },
    };
    expect(PADDLE_EVENT_ID_PARSER_PRESET).toEqual({
      kind: 'fixed_prefix_lowercase_alphanumeric_id.v1',
      prefix: 'evt_',
      suffix_length: 26,
    });
    expect(PADDLE_DELIVERY_ID_PARSER_PRESET).toEqual({
      kind: 'fixed_prefix_lowercase_alphanumeric_id.v1',
      prefix: 'ntf_',
      suffix_length: 26,
    });
    let observedEventId: unknown;
    const eventIdParser: WebhookFixedPrefixProviderIdParser = {
      preset: PADDLE_EVENT_ID_PARSER_PRESET,
      parse(value) {
        observedEventId = value;
        return 'normalized event id';
      },
    };
    let observedDeliveryId: unknown;
    const deliveryIdParser: WebhookFixedPrefixProviderIdParser = {
      preset: PADDLE_DELIVERY_ID_PARSER_PRESET,
      parse(value) {
        observedDeliveryId = value;
        return 'normalized delivery id';
      },
    };
    expect(PADDLE_EVENT_TYPE_PARSER_PRESET).toEqual({
      kind: 'lowercase_dot_segment_event_type.v1',
      segment_count: 2,
      max_segment_characters: 63,
    });
    let observedEventType: unknown;
    const eventTypeParser: WebhookDotSegmentEventTypeParser = {
      preset: PADDLE_EVENT_TYPE_PARSER_PRESET,
      parse(value) {
        observedEventType = value;
        return 'normalized event type';
      },
    };
    expect(PADDLE_RESOURCE_ID_EXTRACTOR_PRESET).toEqual({
      kind: 'optional_json_object_provider_id.v1',
      field: 'id',
      grammar: 'control_free_trimmed_utf8.v1',
      max_bytes: 512,
    });
    let observedResourceObject: unknown;
    const resourceIdExtractor: WebhookJsonObjectProviderIdExtractor = {
      preset: PADDLE_RESOURCE_ID_EXTRACTOR_PRESET,
      extract(value) {
        observedResourceObject = value;
        return 'normalized resource id';
      },
    };
    expect(PADDLE_DATA_OBJECT_EXTRACTOR_PRESET).toEqual({
      kind: 'required_json_object_field.v1',
      field: 'data',
    });
    const extractedData = { id: 'extractor-owned-resource' };
    let observedDataEnvelope: unknown;
    const dataObjectExtractor: WebhookJsonRequiredObjectExtractor = {
      preset: PADDLE_DATA_OBJECT_EXTRACTOR_PRESET,
      extract(value) {
        observedDataEnvelope = value;
        return extractedData;
      },
    };
    expect(PADDLE_JSON_SINGLE_NOTIFICATION_NORMALIZER_PRESET).toEqual({
      kind: 'json_single_notification_fields.v1',
      event_id_field: 'event_id',
      delivery_id_field: 'notification_id',
      event_type_field: 'event_type',
      occurred_at_field: 'occurred_at',
    });
    expect(PADDLE_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET).toEqual({
      kind: 'normalized_single_event.v1',
      provider_event_id_field: 'event_id',
      provider_resource_id_field: 'resource_id',
      provider_event_type_field: 'event_type',
      provider_occurred_at_field: 'occurred_at',
      decoded_payload_field: 'payload',
      occurred_at_unit: 'unix_milliseconds.v1',
    });
    expect(PADDLE_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET).toBe(
      webhookTimestampedHmacDeliveryProfilePreset(
        'paddle.notification.v1',
      )?.event_projector,
    );
    expect(Object.isFrozen(PADDLE_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET))
      .toBe(true);
    expect(PADDLE_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET).toEqual({
      kind: 'normalized_paired_ids_sha256.v1',
      delivery_id_field: 'delivery_id',
      event_id_field: 'event_id',
      delivery_id_prefix: 'paddle:notification:',
      event_id_prefix: 'paddle:event:',
    });
    expect(PADDLE_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET).toBe(
      webhookTimestampedHmacDeliveryProfilePreset(
        'paddle.notification.v1',
      )?.delivery_deduplicator,
    );
    expect(Object.isFrozen(PADDLE_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET))
      .toBe(true);
    const normalizer = createWebhookJsonSingleNotificationNormalizer(
      PADDLE_JSON_SINGLE_NOTIFICATION_NORMALIZER_PRESET,
      {
        decoder,
        occurred_at_parser: occurredAtParser,
        event_id_parser: eventIdParser,
        delivery_id_parser: deliveryIdParser,
        event_type_parser: eventTypeParser,
        data_object_extractor: dataObjectExtractor,
        resource_id_extractor: resourceIdExtractor,
      },
    );
    expect(normalizer.normalize(rawBody)).toEqual({
      event_id: 'normalized event id',
      delivery_id: 'normalized delivery id',
      event_type: 'normalized event type',
      occurred_at: 1_750_000_000_123,
      resource_id: 'normalized resource id',
      payload: envelope,
    });
    expect(observedBody).toBe(rawBody);
    expect(observedOccurredAt).toBe('2026-07-12T19:59:58.125Z');
    expect(observedEventId).toBe(EVENT_ID);
    expect(observedDeliveryId).toBe(NOTIFICATION_ID);
    expect(observedEventType).toBe('subscription.updated');
    expect(observedDataEnvelope).toBe(envelope);
    expect(observedResourceObject).toBe(extractedData);
  });

  it('pins exact-byte ts:body HMAC, multiple h1 values, and the five-second window', () => {
    expect(verifyPaddleWebhookSignature({
      header:
        'ts=1698796800;h1=c174899d19b7316437836caa36609c632749005f8090b8904bd13d7af06d0501',
      raw_body: Buffer.from('{"data": ["1", "2"]}', 'utf8'),
      endpoint_secret_key: SECRET,
      now_ms: 1_698_796_800_000,
    })).toBe(true);
    const body = paddleBody();
    const correct = digestFor(body);
    expect(verifyPaddleWebhookSignature({
      header: `h2=future;ts=${NOW_SECONDS};h1=${'0'.repeat(64)};h1=${correct}`,
      raw_body: body,
      endpoint_secret_key: SECRET,
      now_ms: NOW_MS,
    })).toBe(true);
    expect(verifyPaddleWebhookSignature({
      header: signatureFor(body),
      raw_body: Buffer.from(`${body.toString('utf8')}\n`, 'utf8'),
      endpoint_secret_key: SECRET,
      now_ms: NOW_MS,
    })).toBe(false);
    for (const delta of [
      -PADDLE_WEBHOOK_TOLERANCE_SECONDS,
      PADDLE_WEBHOOK_TOLERANCE_SECONDS,
    ]) {
      expect(verifyPaddleWebhookSignature({
        header: signatureFor(body, SECRET, NOW_SECONDS + delta),
        raw_body: body,
        endpoint_secret_key: SECRET,
        now_ms: NOW_MS,
      })).toBe(true);
    }
    for (const delta of [
      -PADDLE_WEBHOOK_TOLERANCE_SECONDS - 1,
      PADDLE_WEBHOOK_TOLERANCE_SECONDS + 1,
    ]) {
      expect(verifyPaddleWebhookSignature({
        header: signatureFor(body, SECRET, NOW_SECONDS + delta),
        raw_body: body,
        endpoint_secret_key: SECRET,
        now_ms: NOW_MS,
      })).toBe(false);
    }
    expect(verifyPaddleWebhookSignature({
      header: `ts=${NOW_SECONDS};ts=${NOW_SECONDS};h1=${correct}`,
      raw_body: body,
      endpoint_secret_key: SECRET,
      now_ms: NOW_MS,
    })).toBe(false);
    expect(verifyPaddleWebhookSignature({
      header: `ts=${NOW_SECONDS};h1=${correct.toUpperCase()}`,
      raw_body: body,
      endpoint_secret_key: SECRET,
      now_ms: NOW_MS,
    })).toBe(false);
    expect(verifyPaddleWebhookSignature({
      header: `ts=${NOW_SECONDS};${Array.from(
        { length: 17 },
        () => `h1=${correct}`,
      ).join(';')}`,
      raw_body: body,
      endpoint_secret_key: SECRET,
      now_ms: NOW_MS,
    })).toBe(false);
    expect(verifyPaddleWebhookSignature({
      header: `ts=${NOW_SECONDS};h1=${correct};x=${'a'.repeat(8_192)}`,
      raw_body: body,
      endpoint_secret_key: SECRET,
      now_ms: NOW_MS,
    })).toBe(false);
  });

  it('separates Paddle notification delivery identity from logical event identity', async () => {
    const adapter = createPaddleWebhookProfileAdapter();
    const body = paddleBody();
    const header = `ts=${NOW_SECONDS};h1=${digestFor(body, OLDER_SECRET)}`
      + `;h1=${digestFor(body, SECRET)}`;
    const first = requireAccepted(await adapter.verifyAndDecode(
      request({ body, signature: header }),
      context({
        credentials: [
          credentialVersion(1, OLDER_SECRET),
          credentialVersion(2, SECRET),
        ],
      }),
    ));
    expect(first).toMatchObject({
      decoded_content_type: 'application/json',
      response: { status: 200 },
      admission: {
        transport_assurance: 'authenticated',
        credential_version: '2',
        freshness_checked: true,
        method_label: 'paddle-hmac-sha256',
      },
      events: [{
        provider_event_id: EVENT_ID,
        provider_resource_id: 'sub_01h04vsc0qhwtsbsxh3422wjs4',
        provider_event_type: 'subscription.updated',
        provider_occurred_at: Date.parse('2026-07-12T19:59:58.125Z'),
        decoded_payload: JSON.parse(body.toString('utf8')),
      }],
    });
    expect(first.delivery_dedup_key)
      .toBe('paddle:notification:'
        + 'b7ba6b652ac00b553bfa1c7dbbf51449aef1a58d0c237b0c38818dfaed41a547');
    expect(first.events[0]?.event_dedup_key)
      .toBe('paddle:event:'
        + '5893c79f326e89b2aaf146b016d26ea045b1cc751ac99c40466ff52725e2ae2d');

    const olderOnly = requireAccepted(await adapter.verifyAndDecode(
      request({ body, signature: signatureFor(body, OLDER_SECRET) }),
      context({
        credentials: [
          credentialVersion(1, OLDER_SECRET),
          credentialVersion(2, SECRET),
        ],
      }),
    ));
    expect(olderOnly.admission.credential_version).toBe('1');

    const secondBody = paddleBody({ notification_id: SECOND_NOTIFICATION_ID });
    const second = requireAccepted(await adapter.verifyAndDecode(
      request({ body: secondBody }),
      context(),
    ));
    expect(second.delivery_dedup_key).not.toBe(first.delivery_dedup_key);
    expect(second.events[0]?.event_dedup_key)
      .toBe(first.events[0]?.event_dedup_key);

    const changedEventBody = paddleBody({
      event_id: 'evt_01gks14ge726w50ch2tmaw2a1y',
    });
    const changedEvent = requireAccepted(await adapter.verifyAndDecode(
      request({ body: changedEventBody }),
      context(),
    ));
    expect(changedEvent.delivery_dedup_key).toBe(first.delivery_dedup_key);
    expect(changedEvent.events[0]?.event_dedup_key)
      .not.toBe(first.events[0]?.event_dedup_key);
  });

  it('authenticates before bounded envelope decoding and rejects repeated headers', async () => {
    const adapter = createPaddleWebhookProfileAdapter();
    const malformed = Buffer.from('{not-json', 'utf8');
    expectFailure(await adapter.verifyAndDecode(request({
      body: malformed,
      signatureSecret: OLDER_SECRET,
    }), context()), 'authentication_failed', 401);
    expectFailure(await adapter.verifyAndDecode(request({
      body: malformed,
    }), context()), 'structural_admission_failed', 400);
    const valid = paddleBody();
    expectFailure(await adapter.verifyAndDecode(request({
      signature: [signatureFor(valid), signatureFor(valid)],
    }), context()), 'authentication_failed', 401);
  });

  it('requires the common Paddle envelope, strict RFC3339 time, and bounded JSON', async () => {
    const adapter = createPaddleWebhookProfileAdapter();
    const invalidBodies = [
      paddleBody({ event_id: 'evt_invalid' }),
      paddleBody({ notification_id: 'ntf_invalid' }),
      paddleBody({ event_type: 'Subscription.Updated' }),
      paddleBody({ event_type: 'subscription.updated.extra' }),
      paddleBody({ occurred_at: '2026-02-30T20:00:00Z' }),
      paddleBody({ occurred_at: '2026-07-12 20:00:00Z' }),
      paddleBody({ occurred_at: '2026-07-12T20:00:60Z' }),
      paddleBody({ data: undefined }),
      paddleBody({ data: null }),
      paddleBody({ data: [] }),
      paddleBody({ data: 'scalar' }),
      paddleBody({ data: 1 }),
      paddleBody({ data: true }),
      Buffer.from([0xff]),
      Buffer.from('\ufeff{}', 'utf8'),
      Buffer.from('[]', 'utf8'),
      ...['__proto__', 'constructor', 'prototype'].map((key) =>
        paddleBody({ data: Object.fromEntries([[key, {}]]) })),
      Buffer.from(`${'{"nested":'.repeat(34)}{}${'}'.repeat(34)}`, 'utf8'),
      paddleBody({ data: { values: new Array(10_001).fill(null) } }),
      Buffer.from(`{"event_id":"${EVENT_ID}","event_type":"subscription.updated","occurred_at":"2026-07-12T20:00:00Z","notification_id":"${NOTIFICATION_ID}","data":{"value":1e400}}`, 'utf8'),
    ];
    for (const body of invalidBodies) {
      expectFailure(await adapter.verifyAndDecode(
        request({ body }),
        context(),
      ), 'structural_admission_failed', 400);
    }

    const offsetBody = paddleBody({
      occurred_at: '2026-07-12T13:00:00.125-07:00',
    });
    const offset = requireAccepted(await adapter.verifyAndDecode(
      request({ body: offsetBody }),
      context(),
    ));
    expect(offset.events[0]?.provider_occurred_at)
      .toBe(Date.parse('2026-07-12T20:00:00.125Z'));
  });

  it('treats malformed optional data.id values as absent resources', async () => {
    const adapter = createPaddleWebhookProfileAdapter();
    for (const id of [
      undefined,
      null,
      '',
      ' padded',
      'line\nbreak',
      'nul\u0000id',
      'a'.repeat(513),
      1,
    ]) {
      const body = paddleBody({
        data: id === undefined ? {} : { id },
      });
      const delivery = requireAccepted(await adapter.verifyAndDecode(
        request({ body }),
        context(),
      ));
      expect(delivery.events[0]?.provider_resource_id).toBeNull();
    }
  });

  it('requires one exact provider secret and at most two active versions', async () => {
    expect(validatePaddleWebhookCredentialShape({
      endpoint_secret_key: SECRET,
    })).toBe(true);
    expect(validatePaddleWebhookCredentialShape({
      endpoint_secret_key: SECRET,
      ignored_secret: 'must-fail',
    })).toBe(false);
    expect(validatePaddleWebhookCredentialShape({
      endpoint_secret_key: 'pdl_ntfset_not-valid',
    })).toBe(false);
    const inherited = Object.create({
      endpoint_secret_key: SECRET,
    }) as Record<string, string>;
    expect(validatePaddleWebhookCredentialShape(inherited)).toBe(false);

    const adapter = createPaddleWebhookProfileAdapter();
    expectFailure(await adapter.verifyAndDecode(request(), context({
      credentials: [
        credentialVersion(1, OLDER_SECRET),
        credentialVersion(2, SECRET),
        credentialVersion(3,
          'pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms9_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'),
      ],
    })), 'profile_internal_error', 503);
    expectFailure(await adapter.verifyAndDecode(request(), context({
      environment: 'custom',
    })), 'profile_internal_error', 503);
  });

  it('uses authority-derived time and fails retryably without clock evidence', async () => {
    const checks = [
      {
        healthy: true as const,
        trusted_now_ms: NOW_MS,
        maximum_error_ms: 1_000,
        checked_at: NOW_MS,
      },
      { healthy: false as const, reason: 'probe_unavailable' as const },
    ];
    const authority: WebhookClockHealthAuthority = {
      check: async () => checks.shift()!,
    };
    const adapter = createClockGatedPaddleWebhookProfileAdapter(authority);
    const untrustedContext = context({
      now: () => {
        throw new Error('listener clock must not be used');
      },
    });
    const accepted = requireAccepted(await adapter.verifyAndDecode(
      request(),
      untrustedContext,
    ));
    expect(accepted.admission.freshness_checked).toBe(true);
    expectFailure(await adapter.verifyAndDecode(
      request(),
      untrustedContext,
    ), 'profile_dependency_unavailable', 503);
    expect(checks).toHaveLength(0);
  });

  it('deduplicates Paddle retries and cross-notification event identity durably', async () => {
    const db = new Database(':memory:');
    const ingressStore = createWebhookIngressStore(db, {
      now: () => NOW_MS,
      getEncryptionKey: () => new Uint8Array(32).fill(71),
    });
    const ingress = ingressStore.create({
      display_name: 'Durable Paddle fixture',
      profile_id: 'paddle.notification.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['subscription.updated'],
    });
    await ingressStore.writeCredentialVersion(ingress.ingress_id, {
      endpoint_secret_key: SECRET,
    });
    const endpoint = `https://hooks.example.test/v1/webhooks/${ingress.public_id}`;
    ingressStore.confirmManualRegistration(ingress.ingress_id, {
      requires_handshake: false,
      endpoint_url: endpoint,
    });
    ingressStore.enable(ingress.ingress_id);
    const deliveryStore = createWebhookDeliveryStore(db, {
      now: () => NOW_MS,
      getEncryptionKey: () => new Uint8Array(32).fill(72),
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
        createPaddleWebhookProfileAdapter(),
      ]),
      isOutboxDispatcherStarted: outbox.isStarted,
      resolveCanonicalPublicUrl: () => endpoint,
      now: () => NOW_MS,
    });
    const server = await startServer(0, { webhookProfileListener: listener });
    outbox.start();

    const send = (body: Buffer): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: server.port,
          path: `/v1/webhooks/${ingress.public_id}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.byteLength,
            'Paddle-Signature': signatureFor(body),
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

    const first = paddleBody();
    const secondNotification = paddleBody({
      notification_id: SECOND_NOTIFICATION_ID,
    });
    try {
      await expect(send(first)).resolves.toEqual({ status: 200, body: '' });
      await expect(send(first)).resolves.toEqual({ status: 200, body: '' });
      await expect(send(secondNotification))
        .resolves.toEqual({ status: 200, body: '' });
      expect(deliveryStore.listDeliveries(ingress.ingress_id)).toHaveLength(2);
      expect(deliveryStore.listDeliveries(ingress.ingress_id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            profile_id: 'paddle.notification.v1',
            minimum_source_truth_policy: 'delivery_payload_allowed',
            freshness_checked: true,
            event_count: 1,
          }),
        ]),
      );
      const events = deliveryStore.listEvents(ingress.ingress_id);
      expect(events).toEqual([expect.objectContaining({
        provider_event_id: EVENT_ID,
        provider_resource_id: 'sub_01h04vsc0qhwtsbsxh3422wjs4',
        provider_event_type: 'subscription.updated',
        dispatch_state: 'pending',
      })]);
      expect(deliveryStore.listOutbox()).toHaveLength(1);
      await outbox.drainOnce();
      expect(dispatched).toEqual([events[0]!.event_id]);
    } finally {
      await server.close();
      await outbox.stop();
      db.close();
    }
  });
});
