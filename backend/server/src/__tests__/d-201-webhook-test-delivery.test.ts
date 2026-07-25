import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webhookProfile } from '@recued/contracts';
import { createWebhookDeliveryStore } from '../storage/webhook-delivery-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import {
  createClockGatedTimestampedHmacWebhookProfileAdapter,
  createPrimitiveWebhookProfileRuntimeRegistry,
} from '../webhook-primitive-profiles.js';
import { createGitHubWebhookProfileAdapter } from '../webhook-github-profile.js';
import { createWebhookProfileRuntimeRegistry } from '../webhook-profile-runtime.js';
import { createClockGatedStripeWebhookProfileAdapter } from '../webhook-stripe-profile.js';
import {
  createWebhookTestDeliveryService,
} from '../webhook-test-delivery.js';

const NOW = 2_100_000_000_000;
const NONCE = 'c'.repeat(64);
const databases: Database.Database[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

const makeHarness = async () => {
  const db = new Database(':memory:');
  databases.push(db);
  const ingressStore = createWebhookIngressStore(db, {
    now: () => NOW,
    getEncryptionKey: () => new Uint8Array(32).fill(11),
    newIngressId: () => 'whi_testdelivery0000000000000000000',
    newPublicId: () => 'publicTestDelivery_0000000000000000',
    newCredentialSetRef: () => 'whc_testdelivery0000000000000000000',
  });
  const created = ingressStore.create({
    display_name: 'Test sender',
    profile_id: 'generic.static-header-token.v1',
    environment: 'test',
    paired_connection_id: null,
    registration_mode: 'manual',
    selected_event_types: ['delivery'],
  });
  await ingressStore.writeCredentialVersion(created.ingress_id, {
    header_name: 'x-test-token',
    header_token: 'test-delivery-secret',
  });
  const endpoint = `https://hooks.example.test/v1/webhooks/${created.public_id}`;
  ingressStore.confirmManualRegistration(created.ingress_id, {
    requires_handshake: false,
    endpoint_url: endpoint,
  });
  const ingress = ingressStore.enable(created.ingress_id);
  const deliveryStore = createWebhookDeliveryStore(db, {
    now: () => NOW,
    getEncryptionKey: () => new Uint8Array(32).fill(12),
    hasDispatchTarget: () => false,
  });
  const profiles = createPrimitiveWebhookProfileRuntimeRegistry();
  return {
    ingressStore,
    deliveryStore,
    profiles,
    ingress,
    endpoint,
  };
};

describe('D-201 profile-aware test delivery', () => {
  it('uses the canonical public request shape and succeeds only after durable admission', async () => {
    const harness = await makeHarness();
    let nonce = NONCE;
    let fetchOutcome:
      | 'success'
      | 'throw'
      | 'wrong_status'
      | 'rotate'
      | 'disable' = 'success';
    const fetchImpl = vi.fn(async (
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const rawBody = Buffer.from(init?.body as Uint8Array);
      const headers = new Headers(init?.headers);
      const adapter = harness.profiles.get(harness.ingress.profile_id)!;
      const credentials = await harness.ingressStore.readActiveCredentialVersions(
        harness.ingress.ingress_id,
      );
      const result = await adapter.verifyAndDecode({
        method: init?.method ?? 'POST',
        raw_body: rawBody,
        headers: new Map([...headers.entries()].map(([name, value]) => [name, [value]])),
        raw_path_and_query: new URL(String(input)).pathname,
        canonical_public_url: String(input),
        received_at: NOW,
        remote_ip: '127.0.0.1',
      }, {
        ingress_id: harness.ingress.ingress_id,
        environment: harness.ingress.environment,
        credential_versions: credentials,
        now: () => NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.failure.code);
      const descriptor = webhookProfile(harness.ingress.profile_id)!;
      await harness.deliveryStore.accept({
        ingress_id: harness.ingress.ingress_id,
        profile_id: harness.ingress.profile_id,
        environment: harness.ingress.environment,
        received_at: NOW,
        delivery_dedup_key: result.delivery.delivery_dedup_key,
        raw_body_sha256: createHash('sha256').update(rawBody).digest('hex'),
        decoded_content_type: result.delivery.decoded_content_type,
        decoded_schema_id: descriptor.decoded_schema_id,
        transport_assurance: result.delivery.admission.transport_assurance,
        minimum_source_truth_policy: descriptor.minimum_source_truth_policy,
        credential_version: result.delivery.admission.credential_version,
        admission_method: result.delivery.admission.method_label,
        freshness_checked: result.delivery.admission.freshness_checked,
        response: result.delivery.response,
        events: result.delivery.events.map((event) => ({
          event_dedup_key: event.event_dedup_key,
          provider_event_id: event.provider_event_id,
          provider_resource_id: event.provider_resource_id,
          provider_event_type: event.provider_event_type,
          provider_occurred_at: event.provider_occurred_at,
          decoded_payload_json: JSON.stringify(event.decoded_payload),
        })),
      });
      if (fetchOutcome === 'throw') throw new Error('response path lost');
      if (fetchOutcome === 'rotate') {
        await harness.ingressStore.writeCredentialVersion(
          harness.ingress.ingress_id,
          {
            header_name: 'x-test-token',
            header_token: 'rotated-test-delivery-secret',
          },
        );
      }
      if (fetchOutcome === 'disable') {
        harness.ingressStore.disable(harness.ingress.ingress_id);
      }
      const responseBody = fetchOutcome === 'success'
        ? new ReadableStream({
            cancel: () => new Promise<void>(() => undefined),
          })
        : null;
      return new Response(responseBody, {
        status: fetchOutcome === 'wrong_status' ? 500 : 202,
      });
    });
    const service = createWebhookTestDeliveryService({
      ingressStore: harness.ingressStore,
      deliveryStore: harness.deliveryStore,
      profiles: harness.profiles,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => NOW,
      newNonce: () => nonce,
    });

    await expect(service.deliver({
      ingress: harness.ingress,
      endpoint_url: harness.endpoint,
    })).resolves.toMatchObject({
      delivery_id: expect.stringMatching(/^whd_/),
      observed_at: NOW,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(harness.endpoint);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
    });
    const accepted = harness.deliveryStore.listDeliveries(harness.ingress.ingress_id);
    expect(accepted).toHaveLength(1);
    const events = harness.deliveryStore.listEvents(harness.ingress.ingress_id);
    await expect(harness.deliveryStore.readEventPayload(events[0]!.event_id))
      .resolves.toEqual({ recued_test_delivery: { nonce: NONCE } });
    expect(harness.ingressStore.get(harness.ingress.ingress_id)).toMatchObject({
      test_observed_at: NOW,
      last_delivery_at: NOW,
    });
    await expect(service.deliver({
      ingress: harness.ingress,
      endpoint_url: harness.endpoint,
    })).rejects.toMatchObject({ code: 'profile_unavailable' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    nonce = 'd'.repeat(64);
    fetchOutcome = 'throw';
    await expect(service.deliver({
      ingress: harness.ingress,
      endpoint_url: harness.endpoint,
    })).rejects.toMatchObject({
      code: 'accepted_response_unconfirmed',
      message: expect.stringContaining('may have dispatched'),
    });

    nonce = 'e'.repeat(64);
    fetchOutcome = 'wrong_status';
    await expect(service.deliver({
      ingress: harness.ingress,
      endpoint_url: harness.endpoint,
    })).rejects.toMatchObject({
      code: 'accepted_response_unconfirmed',
      message: expect.stringContaining('wrong status'),
    });

    nonce = 'f'.repeat(64);
    fetchOutcome = 'rotate';
    await expect(service.deliver({
      ingress: harness.ingress,
      endpoint_url: harness.endpoint,
    })).rejects.toMatchObject({
      code: 'accepted_state_changed',
      message: expect.stringContaining('may have dispatched'),
    });

    nonce = '1'.repeat(64);
    fetchOutcome = 'disable';
    await expect(service.deliver({
      ingress: harness.ingress,
      endpoint_url: harness.endpoint,
    })).rejects.toMatchObject({
      code: 'accepted_state_changed',
      message: expect.stringContaining('may have dispatched'),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(harness.deliveryStore.listDeliveries(harness.ingress.ingress_id))
      .toHaveLength(5);
  });

  it('does not trust a success-shaped response without the local durable row', async () => {
    const harness = await makeHarness();
    const service = createWebhookTestDeliveryService({
      ingressStore: harness.ingressStore,
      deliveryStore: harness.deliveryStore,
      profiles: harness.profiles,
      fetchImpl: vi.fn(async () => new Response(null, { status: 202 })) as typeof fetch,
      newNonce: () => NONCE,
    });

    await expect(service.deliver({
      ingress: harness.ingress,
      endpoint_url: harness.endpoint,
    })).rejects.toMatchObject({
      code: 'not_observed',
      message: expect.stringContaining('inspect before retrying'),
    });
    expect(harness.deliveryStore.listDeliveries(harness.ingress.ingress_id)).toEqual([]);
  });

  it('builds and admits a timestamped test only through fresh trusted-clock checks', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const ingressStore = createWebhookIngressStore(db, {
      now: () => NOW,
      getEncryptionKey: () => new Uint8Array(32).fill(21),
      newIngressId: () => 'whi_clocktest000000000000000000000',
      newPublicId: () => 'publicClockTest_000000000000000000',
      newCredentialSetRef: () => 'whc_clocktest000000000000000000000',
    });
    const created = ingressStore.create({
      display_name: 'Timestamped test sender',
      profile_id: 'generic.timestamped-raw-body-hmac-sha256.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    });
    await ingressStore.writeCredentialVersion(created.ingress_id, {
      signature_header: 'x-timestamped-signature',
      signing_secret: 'timestamped-test-secret',
    });
    const endpoint = `https://hooks.example.test/v1/webhooks/${created.public_id}`;
    ingressStore.confirmManualRegistration(created.ingress_id, {
      requires_handshake: false,
      endpoint_url: endpoint,
    });
    const ingress = ingressStore.enable(created.ingress_id);
    const deliveryStore = createWebhookDeliveryStore(db, {
      now: () => NOW,
      getEncryptionKey: () => new Uint8Array(32).fill(22),
      hasDispatchTarget: () => false,
    });
    let clockChecks = 0;
    const profiles = createWebhookProfileRuntimeRegistry([
      createClockGatedTimestampedHmacWebhookProfileAdapter({
        check: async () => {
          clockChecks += 1;
          return {
            healthy: true,
            trusted_now_ms: NOW,
            maximum_error_ms: 1_000,
            checked_at: NOW,
          };
        },
      }),
    ]);
    const fetchImpl = vi.fn(async (
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ) => {
      const rawBody = Buffer.from(init?.body as Uint8Array);
      const headers = new Headers(init?.headers);
      const credentials = await ingressStore.readActiveCredentialVersions(
        ingress.ingress_id,
      );
      const adapter = profiles.get(ingress.profile_id)!;
      const result = await adapter.verifyAndDecode({
        method: init?.method ?? 'POST',
        raw_body: rawBody,
        headers: new Map([...headers.entries()].map(([name, value]) => [name, [value]])),
        raw_path_and_query: new URL(String(input)).pathname,
        canonical_public_url: String(input),
        received_at: NOW,
        remote_ip: '127.0.0.1',
      }, {
        ingress_id: ingress.ingress_id,
        environment: ingress.environment,
        credential_versions: credentials,
        // Both wrapper calls must ignore this untrusted local clock.
        now: () => NOW - 86_400_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.failure.code);
      const descriptor = webhookProfile(ingress.profile_id)!;
      await deliveryStore.accept({
        ingress_id: ingress.ingress_id,
        profile_id: ingress.profile_id,
        environment: ingress.environment,
        received_at: NOW,
        delivery_dedup_key: result.delivery.delivery_dedup_key,
        raw_body_sha256: createHash('sha256').update(rawBody).digest('hex'),
        decoded_content_type: result.delivery.decoded_content_type,
        decoded_schema_id: descriptor.decoded_schema_id,
        transport_assurance: result.delivery.admission.transport_assurance,
        minimum_source_truth_policy: descriptor.minimum_source_truth_policy,
        credential_version: result.delivery.admission.credential_version,
        admission_method: result.delivery.admission.method_label,
        freshness_checked: result.delivery.admission.freshness_checked,
        response: result.delivery.response,
        events: result.delivery.events.map((event) => ({
          event_dedup_key: event.event_dedup_key,
          provider_event_id: event.provider_event_id,
          provider_resource_id: event.provider_resource_id,
          provider_event_type: event.provider_event_type,
          provider_occurred_at: event.provider_occurred_at,
          decoded_payload_json: JSON.stringify(event.decoded_payload),
        })),
      });
      return new Response(null, { status: 202 });
    });
    const service = createWebhookTestDeliveryService({
      ingressStore,
      deliveryStore,
      profiles,
      fetchImpl: fetchImpl as typeof fetch,
      // The builder receives this clock only through the clock-gated wrapper.
      now: () => NOW - 86_400_000,
      newNonce: () => NONCE,
    });

    expect(service.supports(ingress.profile_id)).toBe(true);
    await expect(service.deliver({
      ingress,
      endpoint_url: endpoint,
    })).resolves.toMatchObject({
      delivery_id: expect.stringMatching(/^whd_/),
      observed_at: NOW,
    });
    expect(clockChecks).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(deliveryStore.listDeliveries(ingress.ingress_id)[0]).toMatchObject({
      freshness_checked: true,
      admission_method: 'timestamped-hmac-sha256',
    });
  });

  it('sends a selected Stripe test event through normal durable dispatch', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const ingressStore = createWebhookIngressStore(db, {
      now: () => NOW,
      getEncryptionKey: () => new Uint8Array(32).fill(31),
      newIngressId: () => 'whi_stripetest00000000000000000000',
      newPublicId: () => 'publicStripeTest_00000000000000000',
      newCredentialSetRef: () => 'whc_stripetest00000000000000000000',
    });
    const created = ingressStore.create({
      display_name: 'Stripe test sender',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['invoice.payment_failed'],
    });
    await ingressStore.writeCredentialVersion(created.ingress_id, {
      endpoint_secret: 'whsec_D201StripeTestDelivery123',
    });
    const endpoint = `https://hooks.example.test/v1/webhooks/${created.public_id}`;
    ingressStore.confirmManualRegistration(created.ingress_id, {
      requires_handshake: false,
      endpoint_url: endpoint,
    });
    const ingress = ingressStore.enable(created.ingress_id);
    const deliveryStore = createWebhookDeliveryStore(db, {
      now: () => NOW,
      getEncryptionKey: () => new Uint8Array(32).fill(32),
      hasDispatchTarget: (_ingressId, eventType) =>
        eventType === 'invoice.payment_failed',
    });
    let clockChecks = 0;
    const profiles = createWebhookProfileRuntimeRegistry([
      createClockGatedStripeWebhookProfileAdapter({
        check: async () => {
          clockChecks += 1;
          return {
            healthy: true,
            trusted_now_ms: NOW,
            maximum_error_ms: 1_000,
            checked_at: NOW,
          };
        },
      }),
    ]);
    const fetchImpl = vi.fn(async (
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ) => {
      const rawBody = Buffer.from(init?.body as Uint8Array);
      const headers = new Headers(init?.headers);
      const credentials = await ingressStore.readActiveCredentialVersions(
        ingress.ingress_id,
      );
      const adapter = profiles.get(ingress.profile_id)!;
      const result = await adapter.verifyAndDecode({
        method: init?.method ?? 'POST',
        raw_body: rawBody,
        headers: new Map([...headers.entries()].map(([name, value]) => [name, [value]])),
        raw_path_and_query: new URL(String(input)).pathname,
        canonical_public_url: String(input),
        received_at: NOW,
        remote_ip: '127.0.0.1',
      }, {
        ingress_id: ingress.ingress_id,
        environment: ingress.environment,
        credential_versions: credentials,
        // Both Stripe wrapper calls must ignore this untrusted local clock.
        now: () => NOW - 86_400_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.failure.code);
      const descriptor = webhookProfile(ingress.profile_id)!;
      await deliveryStore.accept({
        ingress_id: ingress.ingress_id,
        profile_id: ingress.profile_id,
        environment: ingress.environment,
        received_at: NOW,
        delivery_dedup_key: result.delivery.delivery_dedup_key,
        raw_body_sha256: createHash('sha256').update(rawBody).digest('hex'),
        decoded_content_type: result.delivery.decoded_content_type,
        decoded_schema_id: descriptor.decoded_schema_id,
        transport_assurance: result.delivery.admission.transport_assurance,
        minimum_source_truth_policy: descriptor.minimum_source_truth_policy,
        credential_version: result.delivery.admission.credential_version,
        admission_method: result.delivery.admission.method_label,
        freshness_checked: result.delivery.admission.freshness_checked,
        response: result.delivery.response,
        events: result.delivery.events.map((event) => ({
          event_dedup_key: event.event_dedup_key,
          provider_event_id: event.provider_event_id,
          provider_resource_id: event.provider_resource_id,
          provider_event_type: event.provider_event_type,
          provider_occurred_at: event.provider_occurred_at,
          decoded_payload_json: JSON.stringify(event.decoded_payload),
        })),
      });
      return new Response(null, { status: 200 });
    });
    const service = createWebhookTestDeliveryService({
      ingressStore,
      deliveryStore,
      profiles,
      fetchImpl: fetchImpl as typeof fetch,
      // The builder receives this clock only through the clock-gated wrapper.
      now: () => NOW - 86_400_000,
      newNonce: () => NONCE,
    });

    expect(service.supports(ingress.profile_id)).toBe(true);
    await expect(service.deliver({
      ingress,
      endpoint_url: endpoint,
    })).resolves.toMatchObject({
      delivery_id: expect.stringMatching(/^whd_/),
      observed_at: NOW,
    });
    expect(clockChecks).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(deliveryStore.listDeliveries(ingress.ingress_id)[0]).toMatchObject({
      freshness_checked: true,
      admission_method: 'stripe-signature-v1',
      minimum_source_truth_policy: 'provider_readback_required',
    });
    const event = deliveryStore.listEvents(ingress.ingress_id)[0]!;
    expect(event).toMatchObject({
      provider_event_type: 'invoice.payment_failed',
      dispatch_state: 'pending',
    });
    await expect(deliveryStore.readEventPayload(event.event_id)).resolves.toMatchObject({
      recued_test_delivery: { nonce: NONCE },
    });
    expect(deliveryStore.listOutbox()).toHaveLength(1);
  });

  it('sends a selected GitHub test event through normal durable dispatch', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const ingressStore = createWebhookIngressStore(db, {
      now: () => NOW,
      getEncryptionKey: () => new Uint8Array(32).fill(41),
    });
    const created = ingressStore.create({
      display_name: 'GitHub test sender',
      profile_id: 'github.webhook.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['issues'],
    });
    const webhookSecret = 'G'.repeat(43);
    await ingressStore.writeCredentialVersion(created.ingress_id, {
      webhook_secret: webhookSecret,
    });
    const replacementSecret = 'R'.repeat(43);
    await ingressStore.writeCredentialVersion(created.ingress_id, {
      webhook_secret: replacementSecret,
    });
    const endpoint = `https://hooks.example.test/v1/webhooks/${created.public_id}`;
    ingressStore.confirmManualRegistration(created.ingress_id, {
      requires_handshake: false,
      endpoint_url: endpoint,
    });
    const ingress = ingressStore.enable(created.ingress_id);
    const deliveryStore = createWebhookDeliveryStore(db, {
      now: () => NOW,
      getEncryptionKey: () => new Uint8Array(32).fill(42),
      hasDispatchTarget: (_ingressId, eventType) => eventType === 'issues',
    });
    const profiles = createWebhookProfileRuntimeRegistry([
      createGitHubWebhookProfileAdapter(),
    ]);
    let sentDeliveryId: string | null = null;
    const fetchImpl = vi.fn(async (
      input: string | URL | globalThis.Request,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe(endpoint);
      const rawBody = Buffer.from(init?.body as Uint8Array);
      expect(rawBody.toString('utf8')).not.toContain(webhookSecret);
      expect(rawBody.toString('utf8')).not.toContain(replacementSecret);
      const headers = new Headers(init?.headers);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('x-github-event')).toBe('issues');
      expect(headers.get('x-github-hook-id')).toBe('1');
      sentDeliveryId = headers.get('x-github-delivery');
      expect(sentDeliveryId)
        .toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      expect(headers.get('x-hub-signature-256')).toMatch(/^sha256=[0-9a-f]{64}$/);
      const credentials = await ingressStore.readActiveCredentialVersions(
        ingress.ingress_id,
      );
      const adapter = profiles.get(ingress.profile_id)!;
      const result = await adapter.verifyAndDecode({
        method: init?.method ?? 'POST',
        raw_body: rawBody,
        headers: new Map([...headers.entries()].map(([name, value]) => [name, [value]])),
        raw_path_and_query: new URL(String(input)).pathname,
        canonical_public_url: String(input),
        received_at: NOW,
        remote_ip: '127.0.0.1',
      }, {
        ingress_id: ingress.ingress_id,
        environment: ingress.environment,
        credential_versions: credentials,
        now: () => {
          throw new Error('GitHub test delivery must not read a clock');
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.failure.code);
      const descriptor = webhookProfile(ingress.profile_id)!;
      await deliveryStore.accept({
        ingress_id: ingress.ingress_id,
        profile_id: ingress.profile_id,
        environment: ingress.environment,
        received_at: NOW,
        delivery_dedup_key: result.delivery.delivery_dedup_key,
        raw_body_sha256: createHash('sha256').update(rawBody).digest('hex'),
        decoded_content_type: result.delivery.decoded_content_type,
        decoded_schema_id: descriptor.decoded_schema_id,
        transport_assurance: result.delivery.admission.transport_assurance,
        minimum_source_truth_policy: descriptor.minimum_source_truth_policy,
        credential_version: result.delivery.admission.credential_version,
        admission_method: result.delivery.admission.method_label,
        freshness_checked: result.delivery.admission.freshness_checked,
        response: result.delivery.response,
        events: result.delivery.events.map((event) => ({
          event_dedup_key: event.event_dedup_key,
          provider_event_id: event.provider_event_id,
          provider_resource_id: event.provider_resource_id,
          provider_event_type: event.provider_event_type,
          provider_occurred_at: event.provider_occurred_at,
          decoded_payload_json: JSON.stringify(event.decoded_payload),
        })),
      });
      return new Response(null, { status: 200 });
    });
    const service = createWebhookTestDeliveryService({
      ingressStore,
      deliveryStore,
      profiles,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => {
        throw new Error('GitHub test delivery must not read a clock');
      },
      newNonce: () => NONCE,
    });

    expect(service.supports(ingress.profile_id)).toBe(true);
    await expect(service.deliver({
      ingress,
      endpoint_url: endpoint,
    })).resolves.toMatchObject({
      delivery_id: expect.stringMatching(/^whd_/),
      observed_at: NOW,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(deliveryStore.listDeliveries(ingress.ingress_id)[0]).toMatchObject({
      credential_version: '1',
      freshness_checked: false,
      admission_method: 'github-hmac-sha256',
      minimum_source_truth_policy: 'delivery_payload_allowed',
    });
    const event = deliveryStore.listEvents(ingress.ingress_id)[0]!;
    expect(event).toMatchObject({
      provider_resource_id: null,
      provider_event_type: 'issues',
      dispatch_state: 'pending',
    });
    expect(event.provider_event_id).toBe(sentDeliveryId);
    await expect(deliveryStore.readEventPayload(event.event_id)).resolves.toMatchObject({
      recued_test_delivery: { nonce: NONCE },
    });
    expect(deliveryStore.listOutbox()).toHaveLength(1);
    expect(ingressStore.listCredentialVersions(ingress.ingress_id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: '1', last_verified_at: NOW }),
        expect.objectContaining({ version: '2', last_verified_at: null }),
      ]),
    );
    expect(() => ingressStore.retireCredentialVersion(ingress.ingress_id, 1))
      .toThrow('verify a remaining credential');
  });

  it('refuses live/custom use and endpoint drift while exposing built profile capability', async () => {
    const harness = await makeHarness();
    const fetchImpl = vi.fn();
    const service = createWebhookTestDeliveryService({
      ingressStore: harness.ingressStore,
      deliveryStore: harness.deliveryStore,
      profiles: harness.profiles,
      fetchImpl: fetchImpl as typeof fetch,
      newNonce: () => NONCE,
    });

    expect(service.supports('generic.static-header-token.v1')).toBe(true);
    expect(service.supports('generic.timestamped-raw-body-hmac-sha256.v1')).toBe(false);
    expect(service.supports('stripe.event.v1')).toBe(false);
    await expect(service.deliver({
      ingress: { ...harness.ingress, environment: 'live' },
      endpoint_url: harness.endpoint,
    })).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(service.deliver({
      ingress: harness.ingress,
      endpoint_url: `https://other.example.test/v1/webhooks/${harness.ingress.public_id}`,
    })).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(service.deliver({
      ingress: {
        ...harness.ingress,
        profile_id: 'generic.timestamped-raw-body-hmac-sha256.v1',
      },
      endpoint_url: harness.endpoint,
    })).rejects.toMatchObject({ code: 'invalid_state' });
    const changedEndpoint =
      `https://changed.example.test/v1/webhooks/${harness.ingress.public_id}`;
    harness.ingressStore.confirmManualRegistration(harness.ingress.ingress_id, {
      requires_handshake: false,
      endpoint_url: changedEndpoint,
    });
    await expect(service.deliver({
      ingress: harness.ingress,
      endpoint_url: harness.endpoint,
    })).rejects.toMatchObject({
      code: 'invalid_state',
      message: expect.stringContaining('changed before'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
