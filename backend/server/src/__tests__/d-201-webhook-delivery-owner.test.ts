import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleWebhookDeliveryRetentionPrune,
  handleWebhookDeliveryEventGet,
  handleWebhookDeliveryGet,
  handleWebhookDeliveryList,
  handleWebhookRejectedDeliveryList,
  type WebhookIngressRpcDeps,
} from '../webhook-ingress-handler.js';
import { createWebhookDeliveryStore } from '../storage/webhook-delivery-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

const owner = { instance_id: 'owner-webclient' };

const makeFixture = async () => {
  const db = new Database(':memory:');
  databases.push(db);
  let now = 2_100_000_000_000;
  let unlocked = true;
  let ingressSequence = 0;
  let deliverySequence = 0;
  let eventSequence = 0;
  let payloadSequence = 0;
  let rejectionSequence = 0;
  const store = createWebhookIngressStore(db, {
    now: () => now,
    getEncryptionKey: () => new Uint8Array(32).fill(17),
    newIngressId: () => `whi_${String(++ingressSequence).padStart(32, '0')}`,
    newPublicId: () => `opaquePublicId_${String(ingressSequence).padStart(16, '0')}`,
    newCredentialSetRef: () => `whc_${String(ingressSequence).padStart(32, '0')}`,
  });
  const ingress = store.create({
    display_name: 'Inspectable generic webhook',
    profile_id: 'generic.static-header-token.v1',
    environment: 'test',
    paired_connection_id: null,
    registration_mode: 'manual',
    selected_event_types: ['delivery'],
  });
  await store.writeCredentialVersion(ingress.ingress_id, {
    header_name: 'x-webhook-token',
    header_token: 'credential-value-must-never-leak',
  });
  db.prepare(`
    UPDATE webhook_ingresses
    SET intake_state = 'enabled', registration_state = 'registered', enabled_at = ?
    WHERE ingress_id = ?
  `).run(now, ingress.ingress_id);
  const otherIngress = store.create({
    display_name: 'Other owner webhook',
    profile_id: 'generic.static-header-token.v1',
    environment: 'test',
    paired_connection_id: null,
    registration_mode: 'manual',
    selected_event_types: ['delivery'],
  });
  const deliveryStore = createWebhookDeliveryStore(db, {
    now: () => now,
    getEncryptionKey: () => unlocked ? new Uint8Array(32).fill(23) : null,
    payloadRetentionMs: 100,
    dedupRetentionMs: 200,
    newDeliveryId: () => `whd_${String(++deliverySequence).padStart(32, '0')}`,
    newEventId: () => `whe_${String(++eventSequence).padStart(32, '0')}`,
    newPayloadRef: () => `whp_${String(++payloadSequence).padStart(32, '0')}`,
    newRejectionId: () => `whr_${String(++rejectionSequence).padStart(32, '0')}`,
    hasDispatchTarget: () => false,
  });
  const accept = (
    suffix: string,
    payload: unknown,
  ) => deliveryStore.accept({
    ingress_id: ingress.ingress_id,
    profile_id: ingress.profile_id,
    environment: ingress.environment,
    received_at: now,
    delivery_dedup_key: `internal-delivery-dedup-${suffix}`,
    raw_body_sha256: suffix.repeat(64).slice(0, 64),
    decoded_content_type: 'application/json',
    decoded_schema_id: 'generic.delivery.v1',
    transport_assurance: 'authenticated',
    minimum_source_truth_policy: 'delivery_payload_allowed',
    credential_version: '1',
    admission_method: 'generic-static-header-token',
    freshness_checked: false,
    response: {
      status: 202,
      content_type: 'text/plain',
      body: `private-response-${suffix}`,
    },
    events: [{
      event_dedup_key: `internal-event-dedup-${suffix}`,
      provider_event_id: `provider-event-${suffix}`,
      provider_resource_id: `provider-resource-${suffix}`,
      provider_event_type: 'delivery',
      provider_occurred_at: null,
      decoded_payload_json: JSON.stringify(payload),
    }],
  });
  const first = await accept('a', null);
  const second = await accept('b', { private_body: '<script>alert(1)</script>' });
  const deps: WebhookIngressRpcDeps = { store, deliveryStore };
  return {
    deps,
    deliveryStore,
    ingress,
    otherIngress,
    first,
    second,
    setNow(value: number) {
      now = value;
    },
    setUnlocked(value: boolean) {
      unlocked = value;
    },
  };
};

describe('D-201 Slices 5B2B1 / 5B2B2A owner delivery inspector', () => {
  it('pages stably, projects no internal keys, and rejects cross-ingress identifiers', async () => {
    const fixture = await makeFixture();
    await expect(handleWebhookDeliveryList(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
    }, undefined)).rejects.toMatchObject({ code: 'permission_denied' });

    const firstPage = await handleWebhookDeliveryList(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      limit: 1,
    }, owner);
    expect(firstPage.deliveries.map((delivery) => delivery.delivery_id))
      .toEqual([fixture.first.delivery.delivery_id]);
    expect(firstPage.next_cursor).toEqual({
      received_at: fixture.first.delivery.received_at,
      delivery_id: fixture.first.delivery.delivery_id,
    });
    const secondPage = await handleWebhookDeliveryList(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      limit: 1,
      cursor: firstPage.next_cursor!,
    }, owner);
    expect(secondPage).toMatchObject({
      deliveries: [{ delivery_id: fixture.second.delivery.delivery_id }],
      next_cursor: null,
    });

    const detail = await handleWebhookDeliveryGet(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      delivery_id: fixture.first.delivery.delivery_id,
    }, owner);
    expect(detail.detail.events).toEqual([
      expect.objectContaining({
        event_id: fixture.first.fresh_events[0]!.event_id,
        payload_retained: true,
      }),
    ]);
    const projected = JSON.stringify({ firstPage, secondPage, detail });
    for (const forbidden of [
      'internal-delivery-dedup',
      'internal-event-dedup',
      'private-response',
      'credential-value-must-never-leak',
      'whp_',
      'decoded_payload_ref',
      'delivery_dedup_key',
      'event_dedup_key',
    ]) expect(projected).not.toContain(forbidden);

    await expect(handleWebhookDeliveryGet(fixture.deps, {
      ingress_id: fixture.otherIngress.ingress_id,
      delivery_id: fixture.first.delivery.delivery_id,
    }, owner)).rejects.toMatchObject({ code: 'not_found' });
    await expect(handleWebhookDeliveryEventGet(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      delivery_id: fixture.first.delivery.delivery_id,
      event_id: fixture.second.fresh_events[0]!.event_id,
    }, owner)).rejects.toMatchObject({ code: 'not_found' });
    await expect(handleWebhookDeliveryList(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      limit: 51,
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('uses the shared core identity roles before any delivery lookup', async () => {
    const fixture = await makeFixture();
    await expect(handleWebhookDeliveryGet(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      delivery_id: `whd_${'a'.repeat(15)}`,
    }, owner)).rejects.toMatchObject({
      code: 'bad_request',
      message: 'webhook.delivery.get: delivery_id has invalid shape',
    });
    await expect(handleWebhookDeliveryEventGet(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      delivery_id: fixture.first.delivery.delivery_id,
      event_id: `whe_${'a'.repeat(129)}`,
    }, owner)).rejects.toMatchObject({
      code: 'bad_request',
      message: 'webhook.delivery.event.get: event_id has invalid shape',
    });
    await expect(handleWebhookRejectedDeliveryList(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      cursor: {
        bucket_started_at: 0,
        rejection_id: `whr_${'a'.repeat(15)}.`,
      },
    }, owner)).rejects.toMatchObject({
      code: 'bad_request',
      message: 'webhook.delivery.rejected.list: rejection_id has invalid shape',
    });

    await expect(handleWebhookDeliveryGet(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      delivery_id: `whd_${'a'.repeat(16)}`,
    }, owner)).rejects.toMatchObject({ code: 'not_found' });
    await expect(handleWebhookDeliveryEventGet(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      delivery_id: fixture.first.delivery.delivery_id,
      event_id: `whe_${'A0_-'.repeat(32)}`,
    }, owner)).rejects.toMatchObject({ code: 'not_found' });
    await expect(handleWebhookRejectedDeliveryList(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      cursor: {
        bucket_started_at: 0,
        rejection_id: `whr_${'A0_-'.repeat(32)}`,
      },
    }, owner)).resolves.toEqual({ rejections: [], next_cursor: null });
  });

  it('keeps retained JSON null distinct from a locked or expired payload', async () => {
    const fixture = await makeFixture();
    const eventId = fixture.first.fresh_events[0]!.event_id;
    const request = {
      ingress_id: fixture.ingress.ingress_id,
      delivery_id: fixture.first.delivery.delivery_id,
      event_id: eventId,
    };

    fixture.setUnlocked(false);
    await expect(handleWebhookDeliveryEventGet(fixture.deps, request, owner))
      .rejects.toMatchObject({ code: 'locked' });
    fixture.setUnlocked(true);
    await expect(handleWebhookDeliveryEventGet(fixture.deps, request, owner))
      .resolves.toMatchObject({
        event: { payload_retained: true, payload: null },
      });

    fixture.setNow(2_100_000_000_150);
    expect(fixture.deliveryStore.prune()).toMatchObject({ payloads_deleted: 2 });
    await expect(handleWebhookDeliveryEventGet(fixture.deps, request, owner))
      .resolves.toMatchObject({
        event: {
          payload_retained: false,
          event: { payload_retained: false, payload_expires_at: null },
        },
      });
  });

  it('keeps rejected summaries owner-only, paginated, and content-free', async () => {
    const fixture = await makeFixture();
    fixture.deliveryStore.recordRejectedDelivery({
      ingress_id: fixture.ingress.ingress_id,
      profile_id: fixture.ingress.profile_id,
      environment: fixture.ingress.environment,
      received_at: 2_100_000_000_000,
      reason_code: 'authentication_failed',
      http_status: 401,
    });
    fixture.deliveryStore.recordRejectedDelivery({
      ingress_id: fixture.ingress.ingress_id,
      profile_id: fixture.ingress.profile_id,
      environment: fixture.ingress.environment,
      received_at: 2_100_000_060_000,
      reason_code: 'structural_admission_failed',
      http_status: 400,
    });
    fixture.setNow(2_100_000_060_000);

    await expect(handleWebhookRejectedDeliveryList(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
    }, undefined)).rejects.toMatchObject({ code: 'permission_denied' });
    const page1 = await handleWebhookRejectedDeliveryList(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      limit: 1,
    }, owner);
    expect(page1).toMatchObject({
      rejections: [{
        reason_code: 'structural_admission_failed',
        http_status: 400,
      }],
      next_cursor: expect.any(Object),
    });
    const page2 = await handleWebhookRejectedDeliveryList(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      limit: 1,
      cursor: page1.next_cursor!,
    }, owner);
    expect(page2).toMatchObject({
      rejections: [{
        reason_code: 'authentication_failed',
        http_status: 401,
      }],
      next_cursor: null,
    });
    const projected = JSON.stringify({ page1, page2 });
    for (const forbidden of [
      '"raw_body"',
      '"raw_body_sha256"',
      '"headers"',
      '"signature"',
      '"credentials"',
      '"response_body"',
      '"payload"',
      '"remote_ip"',
    ]) expect(projected).not.toContain(forbidden);
    await expect(handleWebhookRejectedDeliveryList(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      limit: 51,
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleWebhookRejectedDeliveryList(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      cursor: {
        bucket_started_at: 2_100_000_060_000,
        rejection_id: 'whr_00000000000000000000000000000002',
        extra: true,
      } as never,
    }, owner)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleWebhookRejectedDeliveryList(fixture.deps, {
      ingress_id: fixture.otherIngress.ingress_id,
    }, owner)).resolves.toEqual({ rejections: [], next_cursor: null });

    const listRejectedDeliveriesPage = fixture.deliveryStore
      .listRejectedDeliveriesPage.bind(fixture.deliveryStore);
    fixture.deliveryStore.listRejectedDeliveriesPage = (input) => {
      const page = listRejectedDeliveriesPage(input);
      return {
        ...page,
        rejections: page.rejections.map((entry) => ({
          ...entry,
          profile_id: 'stripe.event.v1',
        })),
      };
    };
    await expect(handleWebhookRejectedDeliveryList(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
    }, owner)).rejects.toMatchObject({ code: 'storage_corrupt' });
  });

  it('prunes only server-eligible data for an owner-selected ingress', async () => {
    const fixture = await makeFixture();
    fixture.setNow(2_100_000_000_150);

    await expect(handleWebhookDeliveryRetentionPrune(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
    }, undefined)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(handleWebhookDeliveryRetentionPrune(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
      at: Number.MAX_SAFE_INTEGER,
    } as never, owner)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleWebhookDeliveryRetentionPrune(fixture.deps, {
      ingress_id: 'whi_99999999999999999999999999999999',
    }, owner)).rejects.toMatchObject({ code: 'not_found' });

    await expect(handleWebhookDeliveryRetentionPrune(fixture.deps, {
      ingress_id: fixture.ingress.ingress_id,
    }, owner)).resolves.toEqual({
      result: {
        payloads_deleted: 2,
        outbox_rows_deleted: 0,
        events_deleted: 0,
        deliveries_deleted: 0,
        rejected_summaries_deleted: 0,
      },
    });
    expect(fixture.deliveryStore.listDeliveries(fixture.ingress.ingress_id)).toHaveLength(2);
  });
});
