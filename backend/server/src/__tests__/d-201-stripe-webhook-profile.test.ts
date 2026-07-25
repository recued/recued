import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { startServer } from '../server.js';
import { createWebhookDeliveryStore } from '../storage/webhook-delivery-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { createWebhookOutboxRuntime } from '../webhook-outbox-dispatcher.js';
import { createWebhookProfileListener } from '../webhook-profile-listener.js';
import { createWebhookProfileRuntimeRegistry } from '../webhook-profile-runtime.js';
import type {
  RawWebhookRequest,
  ResolvedWebhookCredentialVersion,
  WebhookProfileResult,
  WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';
import {
  createClockGatedStripeWebhookProfileAdapter,
  createStripeWebhookProfileAdapter,
  validateStripeWebhookCredentialShape,
} from '../webhook-stripe-profile.js';
import type { WebhookClockHealthAuthority } from '../webhook-clock-health.js';
import {
  decodeStripeWebhookEvent,
} from '../connections/providers/stripe-webhook-protocol.js';
import {
  WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
  type WebhookJsonObjectDecoder,
} from '../webhook-json-object-decoder.js';

const NOW_MS = Date.parse('2026-07-11T20:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const SECRET = 'whsec_D201StripeProfile123';

const stripeBody = (overrides: Record<string, unknown> = {}): Buffer =>
  Buffer.from(JSON.stringify({
    id: 'evt_d201_profile_1',
    object: 'event',
    type: 'invoice.paid',
    created: NOW_SECONDS - 20,
    livemode: false,
    data: { object: { id: 'in_d201_profile_1' } },
    ...overrides,
  }), 'utf8');

const stripeDigest = (
  body: Buffer,
  secret = SECRET,
  timestamp: string | number = NOW_SECONDS,
): string => createHmac('sha256', secret)
  .update(`${timestamp}.`)
  .update(body)
  .digest('hex');

const stripeHeader = (
  body: Buffer,
  secret = SECRET,
  timestamp: string | number = NOW_SECONDS,
): string => `t=${timestamp},v1=${stripeDigest(body, secret, timestamp)}`;

const credentialVersion = (
  version: number,
  endpointSecret: string,
): ResolvedWebhookCredentialVersion => ({
  version: String(version),
  created_at: NOW_MS + version,
  credentials: { endpoint_secret: endpointSecret },
});

const context = (input: {
  environment?: 'test' | 'live' | 'custom';
  credentials?: readonly ResolvedWebhookCredentialVersion[];
  now?: () => number;
} = {}): WebhookProfileRuntimeContext => ({
  ingress_id: 'whi_d201stripeprofilefixture123456',
  environment: input.environment ?? 'test',
  credential_versions: input.credentials ?? [credentialVersion(1, SECRET)],
  now: input.now ?? (() => NOW_MS),
});

const request = (input: {
  body?: Buffer;
  signature?: string | readonly string[];
} = {}): RawWebhookRequest => {
  const signature = input.signature;
  return {
    method: 'POST',
    raw_body: input.body ?? stripeBody(),
    headers: new Map(signature === undefined
      ? []
      : [['stripe-signature', typeof signature === 'string'
        ? [signature]
        : signature]]),
    raw_path_and_query: '/v1/webhooks/stripe-profile-fixture',
    canonical_public_url: 'https://hooks.example.test/v1/webhooks/stripe-profile-fixture',
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

describe('D-201 Slices 7A + 7C + 8Y-9D Stripe profile adapter', () => {
  it('delegates bounded JSON decoding to the injected neutral engine', () => {
    const rawBody = Buffer.from('decoder-owned bytes', 'utf8');
    const envelope = {
      id: 'evt_d201_injected_decoder',
      object: 'event',
      type: 'invoice.paid',
      created: NOW_SECONDS,
      livemode: false,
      data: { object: { id: 'in_d201_injected_decoder' } },
    };
    let observedBody: Buffer | null = null;
    const decoder: WebhookJsonObjectDecoder = {
      preset: WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
      decode(body) {
        observedBody = body;
        return envelope;
      },
    };

    expect(decodeStripeWebhookEvent(rawBody, decoder)).toEqual({
      event_id: 'evt_d201_injected_decoder',
      type: 'invoice.paid',
      created: NOW_SECONDS,
      livemode: false,
      resource_id: 'in_d201_injected_decoder',
      payload: envelope,
    });
    expect(observedBody).toBe(rawBody);
  });

  it('authenticates exact bytes across credential rotation and projects one bounded event', async () => {
    const adapter = createStripeWebhookProfileAdapter();
    const body = stripeBody({ resource_id: 'top-level-must-stay-ignored' });
    const olderSecret = 'whsec_D201StripeOlder123';
    const delivery = requireAccepted(await adapter.verifyAndDecode(
      request({
        body,
        signature: `t=${NOW_SECONDS},v1=${'0'.repeat(64)},v1=${stripeDigest(
          body,
          olderSecret,
        ).toUpperCase()}`,
      }),
      context({
        credentials: [
          credentialVersion(1, olderSecret),
          credentialVersion(2, SECRET),
        ],
      }),
    ));

    expect(delivery).toMatchObject({
      decoded_content_type: 'application/json',
      response: { status: 200 },
      admission: {
        transport_assurance: 'authenticated',
        credential_version: '1',
        freshness_checked: true,
        method_label: 'stripe-signature-v1',
      },
      events: [{
        provider_event_id: 'evt_d201_profile_1',
        provider_resource_id: 'in_d201_profile_1',
        provider_event_type: 'invoice.paid',
        provider_occurred_at: NOW_MS - 20_000,
        decoded_payload: JSON.parse(body.toString('utf8')),
      }],
    });
    expect(delivery.delivery_dedup_key).toBe(
      `stripe:event:${createHash('sha256')
        .update('evt_d201_profile_1', 'utf8')
        .digest('hex')}`,
    );
    expect(delivery.events[0]?.event_dedup_key)
      .toBe(`${delivery.delivery_dedup_key}:0`);

    const changedBody = stripeBody({
      data: { object: { id: 'in_changed_body_same_event' } },
    });
    const changedTransport = requireAccepted(await adapter.verifyAndDecode(
      request({
        body: changedBody,
        signature: stripeHeader(changedBody, SECRET, NOW_SECONDS - 1),
      }),
      context(),
    ));
    expect(changedTransport.delivery_dedup_key)
      .toBe(delivery.delivery_dedup_key);
    expect(changedTransport.events[0]?.event_dedup_key)
      .toBe(delivery.events[0]?.event_dedup_key);
  });

  it('builds one nonce-bearing selected test event with the newest credential', async () => {
    const adapter = createStripeWebhookProfileAdapter();
    const nonce = 'a'.repeat(64);
    const runtime = context({
      credentials: [
        credentialVersion(1, 'whsec_D201StripeOlder123'),
        credentialVersion(2, SECRET),
      ],
    });
    const built = await adapter.buildTestDelivery!({
      nonce,
      selected_event_types: ['invoice.payment_failed', 'invoice.paid'],
    }, runtime);

    const expectedEnvelope = {
      id: `evt_recued_test_${nonce}`,
      object: 'event',
      type: 'invoice.payment_failed',
      created: NOW_SECONDS,
      livemode: false,
      data: { object: { id: `recued_test_${nonce}` } },
      recued_test_delivery: { nonce },
    };
    expect(built.raw_body.toString('utf8')).not.toContain(SECRET);
    expect(built.raw_body.toString('utf8')).toBe(JSON.stringify(expectedEnvelope));
    expect(JSON.parse(built.raw_body.toString('utf8'))).toEqual(expectedEnvelope);
    expect(built.headers).toEqual({
      'stripe-signature': expect.stringMatching(
        new RegExp(`^t=${NOW_SECONDS},v1=[0-9a-f]{64}$`),
      ),
    });
    const accepted = requireAccepted(await adapter.verifyAndDecode(
      request({
        body: built.raw_body,
        signature: built.headers['stripe-signature'],
      }),
      runtime,
    ));
    expect(accepted.admission).toMatchObject({
      credential_version: '2',
      freshness_checked: true,
      method_label: 'stripe-signature-v1',
    });
    expect(accepted.events[0]).toMatchObject({
      provider_event_id: `evt_recued_test_${nonce}`,
      provider_resource_id: `recued_test_${nonce}`,
      provider_event_type: 'invoice.payment_failed',
      provider_occurred_at: NOW_MS,
    });

    await expect(Promise.resolve().then(() => adapter.buildTestDelivery!({
      nonce: 'invalid',
      selected_event_types: ['invoice.paid'],
    }, context({
      now: () => {
        throw new Error('nonce rejection must precede clock access');
      },
    })))).rejects.toThrow('Stripe webhook test delivery nonce is invalid');
    await expect(Promise.resolve().then(() => adapter.buildTestDelivery!({
      nonce,
      selected_event_types: ['invalid event type'],
    }, runtime))).rejects.toThrow(
      'Stripe webhook selected test event is invalid',
    );
    await expect(Promise.resolve().then(() => adapter.buildTestDelivery!({
      nonce,
      selected_event_types: [],
    }, runtime))).rejects.toThrow(
      'Stripe webhook selected test event is invalid',
    );
    await expect(Promise.resolve().then(() => adapter.buildTestDelivery!({
      nonce,
      selected_event_types: ['invoice.paid'],
    }, context({ environment: 'live' })))).rejects.toThrow(
      'Stripe webhook test configuration is unavailable',
    );
  });

  it('rejects changed bytes, repeated headers, wrong secrets, and stale or future captures', async () => {
    const adapter = createStripeWebhookProfileAdapter();
    const compact = stripeBody();
    const pretty = Buffer.from(JSON.stringify(JSON.parse(compact.toString()), null, 2));
    const tooManySignatures = `t=${NOW_SECONDS},${[
      stripeDigest(compact),
      ...Array.from({ length: 16 }, () => '0'.repeat(64)),
    ].map((signature) => `v1=${signature}`).join(',')}`;
    const fixtures: RawWebhookRequest[] = [
      request({ body: pretty, signature: stripeHeader(compact) }),
      request({ signature: [stripeHeader(compact), stripeHeader(compact)] }),
      request({ signature: stripeHeader(compact, 'whsec_WrongStripeSecret123') }),
      request({ signature: tooManySignatures }),
      request({
        signature: stripeHeader(compact, SECRET, NOW_SECONDS - 301),
      }),
      request({
        signature: stripeHeader(compact, SECRET, NOW_SECONDS + 301),
      }),
    ];
    for (const fixture of fixtures) {
      expectFailure(
        await adapter.verifyAndDecode(fixture, context()),
        'authentication_failed',
        401,
      );
    }
  });

  it('separates authenticated envelope failures from test/live mismatch', async () => {
    const adapter = createStripeWebhookProfileAdapter();
    const malformed = stripeBody({ object: 'v2.core.event' });
    expectFailure(await adapter.verifyAndDecode(
      request({ body: malformed, signature: stripeHeader(malformed) }),
      context(),
    ), 'structural_admission_failed', 400);
    const overflowingCreated = stripeBody({
      created: Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1,
    });
    expectFailure(await adapter.verifyAndDecode(
      request({
        body: overflowingCreated,
        signature: stripeHeader(overflowingCreated),
      }),
      context(),
    ), 'structural_admission_failed', 400);
    const prototypeSensitive = Buffer.from(
      `{"id":"evt_unsafe","object":"event","type":"invoice.paid","created":${NOW_SECONDS},"livemode":false,"data":{"__proto__":{"polluted":true}}}`,
      'utf8',
    );
    expectFailure(await adapter.verifyAndDecode(
      request({
        body: prototypeSensitive,
        signature: stripeHeader(prototypeSensitive),
      }),
      context(),
    ), 'structural_admission_failed', 400);
    for (const controlBearingId of [
      stripeBody({ id: 'evt_bad\nidentifier' }),
      stripeBody({ data: { object: { id: 'in_bad\nidentifier' } } }),
    ]) {
      expectFailure(await adapter.verifyAndDecode(
        request({
          body: controlBearingId,
          signature: stripeHeader(controlBearingId),
        }),
        context(),
      ), 'structural_admission_failed', 400);
    }

    const noResource = stripeBody({ data: null });
    expect(requireAccepted(await adapter.verifyAndDecode(
      request({ body: noResource, signature: stripeHeader(noResource) }),
      context(),
    )).events[0]?.provider_resource_id).toBeNull();
    for (const malformedOptionalResourceId of [
      null,
      '',
      ' padded ',
      'r'.repeat(513),
      42,
    ]) {
      const malformedResource = stripeBody({
        data: { object: { id: malformedOptionalResourceId } },
      });
      expect(requireAccepted(await adapter.verifyAndDecode(
        request({
          body: malformedResource,
          signature: stripeHeader(malformedResource),
        }),
        context(),
      )).events[0]?.provider_resource_id).toBeNull();
    }

    for (const invalidEnvironmentSelection of [
      stripeBody({ livemode: undefined }),
      stripeBody({ livemode: null }),
      stripeBody({ livemode: 'false' }),
      stripeBody({ livemode: 0 }),
    ]) {
      expectFailure(await adapter.verifyAndDecode(
        request({
          body: invalidEnvironmentSelection,
          signature: stripeHeader(invalidEnvironmentSelection),
        }),
        context(),
      ), 'structural_admission_failed', 400);
    }

    const test = stripeBody({ livemode: false });
    const live = stripeBody({ livemode: true });
    expect(requireAccepted(await adapter.verifyAndDecode(
      request({ body: live, signature: stripeHeader(live) }),
      context({ environment: 'live' }),
    )).events[0]?.provider_event_id).toBe('evt_d201_profile_1');
    expectFailure(await adapter.verifyAndDecode(
      request({ body: live, signature: stripeHeader(live) }),
      context({ environment: 'test' }),
    ), 'unsupported_delivery', 400);
    expectFailure(await adapter.verifyAndDecode(
      request({ body: test, signature: stripeHeader(test) }),
      context({ environment: 'live' }),
    ), 'unsupported_delivery', 400);
    expectFailure(await adapter.verifyAndDecode(
      request({ body: live, signature: stripeHeader(live) }),
      context({ environment: 'custom' }),
    ), 'profile_internal_error', 503);
  });

  it('requires one exact bounded endpoint-secret field and at most two active versions', async () => {
    expect(validateStripeWebhookCredentialShape({ endpoint_secret: SECRET })).toBe(true);
    expect(validateStripeWebhookCredentialShape({
      endpoint_secret: SECRET,
      ignored_secret: 'must-fail',
    })).toBe(false);
    expect(validateStripeWebhookCredentialShape({ endpoint_secret: 'not-a-whsec' }))
      .toBe(false);
    const inherited = Object.create({ endpoint_secret: SECRET }) as Record<string, string>;
    expect(validateStripeWebhookCredentialShape(inherited)).toBe(false);

    const adapter = createStripeWebhookProfileAdapter();
    const body = stripeBody();
    expectFailure(await adapter.verifyAndDecode(
      request({ body, signature: stripeHeader(body) }),
      context({
        credentials: [
          credentialVersion(1, 'whsec_One123'),
          credentialVersion(2, 'whsec_Two123'),
          credentialVersion(3, SECRET),
        ],
      }),
    ), 'profile_internal_error', 503);
  });

  it('uses only authority-derived time and fails retryably when clock evidence is unhealthy', async () => {
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
    const adapter = createClockGatedStripeWebhookProfileAdapter(authority);
    const body = stripeBody();
    const untrustedLocalClock = context({
      now: () => NOW_MS - 1_000_000,
    });
    const accepted = requireAccepted(await adapter.verifyAndDecode(
      request({ body, signature: stripeHeader(body) }),
      untrustedLocalClock,
    ));
    expect(accepted.admission.freshness_checked).toBe(true);
    expectFailure(await adapter.verifyAndDecode(
      request({ body, signature: stripeHeader(body) }),
      untrustedLocalClock,
    ), 'profile_dependency_unavailable', 503);
    expect(checks).toHaveLength(0);
  });

  it('uses only authority-derived time for test signatures and refuses an unhealthy clock', async () => {
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
    const adapter = createClockGatedStripeWebhookProfileAdapter(authority);
    const input = {
      nonce: 'b'.repeat(64),
      selected_event_types: ['invoice.paid'],
    };
    const untrustedLocalClock = context({
      now: () => NOW_MS - 86_400_000,
    });

    const built = await adapter.buildTestDelivery!(input, untrustedLocalClock);
    expect(built.headers['stripe-signature']).toMatch(
      new RegExp(`^t=${NOW_SECONDS},v1=[0-9a-f]{64}$`),
    );
    await expect(adapter.buildTestDelivery!(input, untrustedLocalClock))
      .rejects.toThrow('Stripe webhook trusted clock is unavailable');
    expect(checks).toHaveLength(0);
  });

  it('persists and dispatches a signed retry through the canonical durable listener once', async () => {
    const db = new Database(':memory:');
    const ingressStore = createWebhookIngressStore(db, {
      now: () => NOW_MS,
      getEncryptionKey: () => new Uint8Array(32).fill(11),
    });
    const ingress = ingressStore.create({
      display_name: 'Durable Stripe fixture',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'stripe-test',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['invoice.paid'],
    });
    const endpointUrl = `https://hooks.example.test/v1/webhooks/${ingress.public_id}`;
    const attempt = ingressStore.prepareManagedRegistration(ingress.ingress_id);
    await ingressStore.commitManagedRegistrationCreate({
      expected: attempt.expected,
      remote_endpoint_id: 'we_d201stripeprofile123',
      endpoint_url: endpointUrl,
      credentials: { endpoint_secret: SECRET },
      requires_handshake: false,
    });
    ingressStore.enable(ingress.ingress_id);

    const deliveryStore = createWebhookDeliveryStore(db, {
      now: () => NOW_MS,
      getEncryptionKey: () => new Uint8Array(32).fill(12),
      hasDispatchTarget: () => true,
    });
    const dispatched: string[] = [];
    const outbox = createWebhookOutboxRuntime(deliveryStore, {
      dispatch: async (event) => {
        dispatched.push(event.idempotency_key);
      },
    }, { poll_interval_ms: 60_000 });
    let canonicalEndpointUrl = endpointUrl;
    const listener = createWebhookProfileListener({
      ingressStore,
      deliveryStore,
      profiles: createWebhookProfileRuntimeRegistry([
        createStripeWebhookProfileAdapter(),
      ]),
      isOutboxDispatcherStarted: outbox.isStarted,
      resolveCanonicalPublicUrl: () => canonicalEndpointUrl,
      now: () => NOW_MS,
    });
    const server = await startServer(0, { webhookProfileListener: listener });
    outbox.start();

    const body = stripeBody();
    const send = (): Promise<{ status: number; body: string }> => new Promise(
      (resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: server.port,
          path: `/v1/webhooks/${ingress.public_id}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.byteLength,
            'Stripe-Signature': stripeHeader(body),
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
      },
    );

    try {
      await expect(send()).resolves.toEqual({ status: 200, body: '' });
      await expect(send()).resolves.toEqual({ status: 200, body: '' });
      expect(deliveryStore.listDeliveries(ingress.ingress_id)).toEqual([
        expect.objectContaining({
          profile_id: 'stripe.event.v1',
          minimum_source_truth_policy: 'provider_readback_required',
          freshness_checked: true,
          event_count: 1,
        }),
      ]);
      expect(deliveryStore.listEvents(ingress.ingress_id)).toEqual([
        expect.objectContaining({
          provider_event_id: 'evt_d201_profile_1',
          provider_resource_id: 'in_d201_profile_1',
          provider_event_type: 'invoice.paid',
          dispatch_state: 'pending',
        }),
      ]);
      expect(deliveryStore.listOutbox()).toHaveLength(1);
      await outbox.drainOnce();
      expect(dispatched).toEqual([
        deliveryStore.listEvents(ingress.ingress_id)[0]!.event_id,
      ]);
      expect(deliveryStore.listEvents(ingress.ingress_id)[0]?.dispatch_state)
        .toBe('dispatched');
      canonicalEndpointUrl = `https://moved-hooks.example.test/v1/webhooks/${ingress.public_id}`;
      await expect(send()).resolves.toEqual({
        status: 404,
        body: '{"error":{"code":"not_found"}}',
      });
      expect(deliveryStore.listDeliveries(ingress.ingress_id)).toHaveLength(1);
    } finally {
      await server.close();
      await outbox.stop();
      db.close();
    }
  });
});
