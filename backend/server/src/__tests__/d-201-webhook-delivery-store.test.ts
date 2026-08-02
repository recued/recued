import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
} from '@recued/storage';
import { WEBHOOK_PROFILE_REGISTRY } from '@recued/contracts';
import { handleAuditExportPage } from '../audit-export-handler.js';
import { ensureMemorySchema } from '../memory-schema.js';
import {
  DEFAULT_WEBHOOK_DEDUP_RETENTION_MS,
  WebhookDeliveryStoreError,
  createWebhookDeliveryStore,
  type WebhookAcceptedDeliveryInput,
  type WebhookDeliveryStore,
} from '../storage/webhook-delivery-store.js';
import {
  createWebhookIngressStore,
  type WebhookIngressStore,
} from '../storage/webhook-ingress-store.js';
import {
  createWebhookOutboxRuntime,
  dispatchWebhookOutboxOnce,
  WEBHOOK_OUTBOX_MAX_ACTIVE_DISPATCHES,
} from '../webhook-outbox-dispatcher.js';

const SECRET_KEY = new Uint8Array(32).fill(31);
const PAYLOAD_KEY = new Uint8Array(32).fill(47);

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

interface Harness {
  db: Database.Database;
  ingressStore: WebhookIngressStore;
  deliveryStore: WebhookDeliveryStore;
  ingressId: string;
  setNow(value: number): void;
  setPayloadUnlocked(value: boolean): void;
}

const makeHarness = async (input: {
  payloadRetentionMs?: number;
  dedupRetentionMs?: number;
  rejectionRetentionMs?: number;
  rejectionBucketMs?: number;
  maxRejectionSummariesPerIngress?: number;
  maxRejectionSummaries?: number;
  maxOutboxBacklog?: number;
  beforeAcceptCommit?: () => void;
} = {}): Promise<Harness> => {
  const db = new Database(':memory:');
  databases.push(db);
  let stamp = 2_000_000_000_000;
  let payloadUnlocked = true;
  let deliverySequence = 0;
  let eventSequence = 0;
  let payloadSequence = 0;
  let outboxSequence = 0;
  let claimSequence = 0;
  let rejectionSequence = 0;
  let ingressSequence = 0;
  const ingressStore = createWebhookIngressStore(db, {
    now: () => stamp,
    getEncryptionKey: () => SECRET_KEY,
    newIngressId: () => `whi_${String(++ingressSequence).padStart(32, '0')}`,
    newPublicId: () => `opaquePublicId_${String(ingressSequence).padStart(16, '0')}`,
    newCredentialSetRef: () => `whc_${String(ingressSequence).padStart(32, '0')}`,
  });
  const ingress = ingressStore.create({
    display_name: 'Generic delivery test',
    profile_id: 'generic.static-header-token.v1',
    environment: 'test',
    paired_connection_id: null,
    registration_mode: 'manual',
    selected_event_types: ['delivery'],
  });
  await ingressStore.writeCredentialVersion(ingress.ingress_id, {
    header_name: 'x-test-token',
    header_token: 'fixture-secret-token',
  });
  db.prepare(`
    UPDATE webhook_ingresses
    SET intake_state = 'enabled', registration_state = 'registered', enabled_at = ?
    WHERE ingress_id = ?
  `).run(stamp, ingress.ingress_id);
  const deliveryStore = createWebhookDeliveryStore(db, {
    now: () => stamp,
    getEncryptionKey: () => payloadUnlocked ? PAYLOAD_KEY : null,
    newDeliveryId: () => `whd_${String(++deliverySequence).padStart(32, '0')}`,
    newEventId: () => `whe_${String(++eventSequence).padStart(32, '0')}`,
    newPayloadRef: () => `whp_${String(++payloadSequence).padStart(32, '0')}`,
    newOutboxId: () => `who_${String(++outboxSequence).padStart(32, '0')}`,
    newClaimToken: () => `claim-${++claimSequence}`,
    newRejectionId: () => `whr_${String(++rejectionSequence).padStart(32, '0')}`,
    hasDispatchTarget: (_ingressId, eventType) => eventType === 'delivery',
    ...(input.payloadRetentionMs !== undefined
      ? { payloadRetentionMs: input.payloadRetentionMs }
      : {}),
    ...(input.dedupRetentionMs !== undefined
      ? { dedupRetentionMs: input.dedupRetentionMs }
      : {}),
    ...(input.rejectionRetentionMs !== undefined
      ? { rejectionRetentionMs: input.rejectionRetentionMs }
      : {}),
    ...(input.rejectionBucketMs !== undefined
      ? { rejectionBucketMs: input.rejectionBucketMs }
      : {}),
    ...(input.maxRejectionSummariesPerIngress !== undefined
      ? { maxRejectionSummariesPerIngress: input.maxRejectionSummariesPerIngress }
      : {}),
    ...(input.maxRejectionSummaries !== undefined
      ? { maxRejectionSummaries: input.maxRejectionSummaries }
      : {}),
    ...(input.maxOutboxBacklog !== undefined
      ? { maxOutboxBacklog: input.maxOutboxBacklog }
      : {}),
    ...(input.beforeAcceptCommit
      ? { beforeAcceptCommit: input.beforeAcceptCommit }
      : {}),
  });
  return {
    db,
    ingressStore,
    deliveryStore,
    ingressId: ingress.ingress_id,
    setNow(value) {
      stamp = value;
    },
    setPayloadUnlocked(value) {
      payloadUnlocked = value;
    },
  };
};

const acceptedInput = (
  harness: Harness,
  input: {
    deliveryKey?: string;
    eventKey?: string;
    eventType?: string;
    payload?: unknown;
    responseBody?: string;
    receivedAt?: number;
    credentialVersion?: string;
    ingressId?: string;
  } = {},
): WebhookAcceptedDeliveryInput => ({
  ingress_id: input.ingressId ?? harness.ingressId,
  profile_id: 'generic.static-header-token.v1',
  environment: 'test',
  received_at: input.receivedAt ?? 2_000_000_000_000,
  delivery_dedup_key: input.deliveryKey ?? 'delivery-1',
  raw_body_sha256: 'a'.repeat(64),
  decoded_content_type: 'application/json',
  decoded_schema_id: 'generic.delivery.v1',
  transport_assurance: 'authenticated',
  minimum_source_truth_policy: 'delivery_payload_allowed',
  credential_version: input.credentialVersion ?? '1',
  admission_method: 'test-static-token',
  freshness_checked: false,
  response: {
    status: 202,
    content_type: 'text/plain',
    body: input.responseBody ?? 'accepted-once',
  },
  events: [{
    event_dedup_key: input.eventKey ?? 'event-1',
    provider_event_id: input.eventKey ?? 'event-1',
    provider_resource_id: null,
    provider_event_type: input.eventType ?? 'delivery',
    provider_occurred_at: null,
    decoded_payload_json: JSON.stringify(
      Object.prototype.hasOwnProperty.call(input, 'payload')
        ? input.payload
        : { safe: true },
    ),
  }],
});

const tableCount = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

describe('D-201 Slices 2 / 5B2B durable webhook delivery store', () => {
  it('fails construction when actual retention cannot honor every registered profile horizon', () => {
    const db = new Database(':memory:');
    databases.push(db);
    const requirements = Object.values(WEBHOOK_PROFILE_REGISTRY);

    expect(() => createWebhookDeliveryStore(db, {
      payloadRetentionMs: 1,
      dedupRetentionMs: DEFAULT_WEBHOOK_DEDUP_RETENTION_MS - 1,
      profileDeduplicationRequirements: requirements,
    })).toThrow(
      `profile 'stripe.event.v1' tombstone horizon ${DEFAULT_WEBHOOK_DEDUP_RETENTION_MS}ms`,
    );
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'webhook_accepted_deliveries'
    `).get()).toBeUndefined();

    expect(() => createWebhookDeliveryStore(db, {
      profileDeduplicationRequirements: [],
    })).toThrow('profile deduplication requirements must not be empty');
    expect(() => createWebhookDeliveryStore(db, {
      profileDeduplicationRequirements: [requirements[0]!, requirements[0]!],
    })).toThrow("duplicate profile deduplication requirement 'stripe.event.v1'");
    expect(() => createWebhookDeliveryStore(db, {
      profileDeduplicationRequirements: [{
        ...requirements[0]!,
        deduplication: {
          ...requirements[0]!.deduplication,
          tombstone_horizon_ms: 0,
        },
      }],
    })).toThrow("profile 'stripe.event.v1' has an invalid deduplication tombstone horizon");

    expect(() => createWebhookDeliveryStore(db, {
      profileDeduplicationRequirements: requirements,
    })).not.toThrow();
  });

  it('atomically stores encrypted payload/event/outbox rows and preserves the first ack on replay', async () => {
    const harness = await makeHarness();
    const secretPayload = { card_hint: 'not-secret-but-private-4242' };
    const first = await harness.deliveryStore.accept(acceptedInput(harness, {
      payload: secretPayload,
    }));

    expect(first).toMatchObject({
      duplicate_delivery: false,
      response: { status: 202, body: 'accepted-once' },
    });
    expect(first.fresh_events).toEqual([
      expect.objectContaining({
        selected_for_dispatch: true,
        dispatch_state: 'pending',
      }),
    ]);
    const ciphertext = harness.db.prepare(`
      SELECT ciphertext FROM webhook_decoded_payloads
    `).pluck().get() as string;
    expect(ciphertext).not.toContain('not-secret-but-private-4242');
    await expect(harness.deliveryStore.readEventPayload(
      first.fresh_events[0]!.event_id,
    )).resolves.toEqual(secretPayload);
    expect(harness.deliveryStore.listOutbox()).toEqual([
      expect.objectContaining({ state: 'pending', attempt_count: 0 }),
    ]);
    expect(harness.deliveryStore.findDeliveryByRawBodySha256(
      harness.ingressId,
      'a'.repeat(64),
    )).toMatchObject({ delivery_id: first.delivery.delivery_id });
    expect(harness.deliveryStore.findDeliveryByRawBodySha256(
      harness.ingressId,
      'b'.repeat(64),
    )).toBeNull();

    const duplicate = await harness.deliveryStore.accept(acceptedInput(harness, {
      payload: { attacker_replay: true },
      responseBody: 'must-not-replace-original-ack',
    }));
    expect(duplicate).toMatchObject({
      duplicate_delivery: true,
      fresh_events: [],
      response: { body: 'accepted-once' },
    });
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toHaveLength(1);
    expect(harness.deliveryStore.listEvents(harness.ingressId)).toHaveLength(1);
    expect(harness.deliveryStore.listOutbox()).toHaveLength(1);
  });

  it('deduplicates overlapping event keys across differently keyed deliveries', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness));
    const overlap = await harness.deliveryStore.accept(acceptedInput(harness, {
      deliveryKey: 'delivery-2',
      eventKey: 'event-1',
      payload: { duplicate_item: true },
    }));
    const ignored = await harness.deliveryStore.accept(acceptedInput(harness, {
      deliveryKey: 'delivery-3',
      eventKey: 'event-2',
      eventType: 'not-selected',
    }));

    expect(overlap).toMatchObject({ duplicate_delivery: false, fresh_events: [] });
    expect(ignored.fresh_events).toEqual([
      expect.objectContaining({
        provider_event_type: 'not-selected',
        selected_for_dispatch: false,
        dispatch_state: 'ignored',
      }),
    ]);
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toHaveLength(3);
    expect(harness.deliveryStore.listEvents(harness.ingressId)).toHaveLength(2);
    expect(harness.deliveryStore.listOutbox()).toHaveLength(1);
  });

  it('fails closed when a payload row no longer matches its event identity', async () => {
    const harness = await makeHarness();
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    const eventId = accepted.fresh_events[0]!.event_id;
    harness.db.prepare(`
      UPDATE webhook_decoded_payloads SET event_id = ? WHERE event_id = ?
    `).run('whe_corruptpayloadidentity0000000000', eventId);

    expect(() => harness.deliveryStore.listEventsForDelivery(
      accepted.delivery.delivery_id,
    )).toThrowError(WebhookDeliveryStoreError);
    await expect(harness.deliveryStore.readRetainedEventPayload(eventId))
      .rejects.toMatchObject({ code: 'corrupt' });
  });

  it('aggregates, paginates, expires, and caps content-free rejection summaries', async () => {
    const harness = await makeHarness({
      rejectionRetentionMs: 5_000,
      rejectionBucketMs: 1_000,
    });
    const record = (
      receivedAt: number,
      reason: 'authentication_failed' | 'structural_admission_failed',
      status: number,
    ): void => harness.deliveryStore.recordRejectedDelivery({
      ingress_id: harness.ingressId,
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      received_at: receivedAt,
      reason_code: reason,
      http_status: status,
    });
    record(2_000_000_000_000, 'authentication_failed', 401);
    record(2_000_000_000_200, 'authentication_failed', 401);
    // The third observation stays in memory until the next power-of-two
    // checkpoint, bounding unauthenticated-request write amplification.
    record(2_000_000_000_250, 'authentication_failed', 401);
    record(2_000_000_000_300, 'structural_admission_failed', 400);
    record(2_000_000_001_000, 'authentication_failed', 401);
    harness.setNow(2_000_000_001_000);

    const page1 = harness.deliveryStore.listRejectedDeliveriesPage({
      ingress_id: harness.ingressId,
      limit: 1,
    });
    expect(page1).toEqual({
      rejections: [expect.objectContaining({
        bucket_started_at: 2_000_000_001_000,
        reason_code: 'authentication_failed',
        recorded_attempt_count: 1,
      })],
      has_more: true,
    });
    const page2 = harness.deliveryStore.listRejectedDeliveriesPage({
      ingress_id: harness.ingressId,
      limit: 1,
      cursor: {
        bucket_started_at: page1.rejections[0]!.bucket_started_at,
        rejection_id: page1.rejections[0]!.rejection_id,
      },
    });
    expect(page2.rejections).toEqual([expect.objectContaining({
      reason_code: 'authentication_failed',
      first_recorded_at: 2_000_000_000_000,
      last_recorded_at: 2_000_000_000_200,
      recorded_attempt_count: 2,
    })]);
    const page3 = harness.deliveryStore.listRejectedDeliveriesPage({
      ingress_id: harness.ingressId,
      limit: 1,
      cursor: {
        bucket_started_at: page2.rejections[0]!.bucket_started_at,
        rejection_id: page2.rejections[0]!.rejection_id,
      },
    });
    expect(page3).toEqual({
      rejections: [expect.objectContaining({
        reason_code: 'structural_admission_failed',
      })],
      has_more: false,
    });
    const columns = harness.db.prepare(`
      PRAGMA table_info(webhook_rejected_delivery_summaries)
    `).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'rejection_id',
      'ingress_id',
      'profile_id',
      'environment',
      'reason_code',
      'http_status',
      'bucket_started_at',
      'first_recorded_at',
      'last_recorded_at',
      'recorded_attempt_count',
      'expires_at',
    ]);

    harness.setNow(2_000_000_006_001);
    expect(harness.deliveryStore.listRejectedDeliveriesPage({
      ingress_id: harness.ingressId,
      limit: 10,
    }).rejections).toEqual([]);

    const capped = await makeHarness({
      rejectionRetentionMs: 5_000,
      rejectionBucketMs: 1_000,
      maxRejectionSummariesPerIngress: 2,
      maxRejectionSummaries: 2,
    });
    for (let index = 0; index < 3; index += 1) {
      capped.deliveryStore.recordRejectedDelivery({
        ingress_id: capped.ingressId,
        profile_id: 'generic.static-header-token.v1',
        environment: 'test',
        received_at: 2_000_000_000_000 + index * 1_000,
        reason_code: 'authentication_failed',
        http_status: 401 + index,
      });
    }
    capped.setNow(2_000_000_002_000);
    expect(capped.deliveryStore.listRejectedDeliveriesPage({
      ingress_id: capped.ingressId,
      limit: 10,
    }).rejections.map((entry) => entry.http_status)).toEqual([403, 402]);
  });

  it('pins shared rejection-id parser results before cursor queries', async () => {
    const harness = await makeHarness();
    for (const rejectionId of [
      `whr_${'a'.repeat(16)}`,
      `whr_${'A0_-'.repeat(32)}`,
    ]) {
      expect(harness.deliveryStore.listRejectedDeliveriesPage({
        ingress_id: harness.ingressId,
        limit: 10,
        cursor: { bucket_started_at: 0, rejection_id: rejectionId },
      })).toEqual({ rejections: [], has_more: false });
    }
    for (const rejectionId of [
      `whr_${'a'.repeat(15)}`,
      `whr_${'a'.repeat(129)}`,
      `whr_${'a'.repeat(15)}.`,
      `whd_${'a'.repeat(16)}`,
      new String(`whr_${'a'.repeat(16)}`),
    ]) {
      expect(() => harness.deliveryStore.listRejectedDeliveriesPage({
        ingress_id: harness.ingressId,
        limit: 10,
        cursor: { bucket_started_at: 0, rejection_id: rejectionId },
      } as never)).toThrow('webhook rejection page: cursor is invalid');
    }

    let rejectionIdReads = 0;
    const accessorCursor = {
      bucket_started_at: 0,
      get rejection_id(): string {
        rejectionIdReads += 1;
        return rejectionIdReads === 1
          ? `whr_${'a'.repeat(16)}`
          : `whr_${'a'.repeat(15)}.`;
      },
    };
    expect(harness.deliveryStore.listRejectedDeliveriesPage({
      ingress_id: harness.ingressId,
      limit: 10,
      cursor: accessorCursor,
    })).toEqual({ rejections: [], has_more: false });
    expect(rejectionIdReads).toBe(1);
  });

  it('keeps logarithmic checkpoints across adjacent-bucket completion interleaving', async () => {
    const harness = await makeHarness({
      rejectionRetentionMs: 10_000,
      rejectionBucketMs: 1_000,
    });
    const base = 2_000_000_000_000;
    const record = (receivedAt: number): void => {
      harness.deliveryStore.recordRejectedDelivery({
        ingress_id: harness.ingressId,
        profile_id: 'generic.static-header-token.v1',
        environment: 'test',
        received_at: receivedAt,
        reason_code: 'authentication_failed',
        http_status: 401,
      });
    };
    // Model profile calls that started on either side of a bucket boundary and
    // completed out of receive order. The third observation in the old bucket
    // must remain below the next checkpoint instead of causing another write.
    record(base);
    record(base + 1_000);
    record(base + 100);
    record(base + 1_100);
    record(base + 200);
    harness.setNow(base + 1_100);

    const rows = harness.deliveryStore.listRejectedDeliveriesPage({
      ingress_id: harness.ingressId,
      limit: 10,
    }).rejections;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.bucket_started_at === base)).toMatchObject({
      recorded_attempt_count: 2,
      first_recorded_at: base,
      last_recorded_at: base + 100,
    });
    expect(rows.find((row) => row.bucket_started_at === base + 1_000)).toMatchObject({
      recorded_attempt_count: 2,
      first_recorded_at: base + 1_000,
      last_recorded_at: base + 1_100,
    });
  });

  it('evicts the least recently observed summaries when a cap ties within one bucket', async () => {
    const harness = await makeHarness({
      rejectionRetentionMs: 10_000,
      rejectionBucketMs: 1_000,
      maxRejectionSummariesPerIngress: 2,
      maxRejectionSummaries: 2,
    });
    const base = 2_000_000_000_000;
    for (const [offset, reason, status] of [
      [10, 'authentication_failed', 401],
      [20, 'structural_admission_failed', 400],
      [30, 'unsupported_media_type', 415],
    ] as const) {
      harness.deliveryStore.recordRejectedDelivery({
        ingress_id: harness.ingressId,
        profile_id: 'generic.static-header-token.v1',
        environment: 'test',
        received_at: base + offset,
        reason_code: reason,
        http_status: status,
      });
    }
    harness.setNow(base + 30);

    const reasons = harness.deliveryStore.listRejectedDeliveriesPage({
      ingress_id: harness.ingressId,
      limit: 10,
    }).rejections.map((row) => row.reason_code);
    expect(reasons).toHaveLength(2);
    expect(reasons).toEqual(expect.arrayContaining([
      'structural_admission_failed',
      'unsupported_media_type',
    ]));
    expect(reasons).not.toContain('authentication_failed');
  });

  it('does not let an accepted request erase an unrelated registration fault', async () => {
    const harness = await makeHarness();
    harness.db.prepare(`
      UPDATE webhook_ingresses
      SET intake_state = 'degraded', registration_state = 'drifted',
          last_error_code = 'remote_endpoint_drift'
      WHERE ingress_id = ?
    `).run(harness.ingressId);
    await harness.deliveryStore.accept(acceptedInput(harness));
    // The HTTP listener records health again after the durable accept. That
    // best-effort projection must preserve the same unrelated fault too.
    harness.ingressStore.recordAcceptedDelivery(
      harness.ingressId,
      2_000_000_000_000,
    );
    expect(harness.ingressStore.get(harness.ingressId)).toMatchObject({
      intake_state: 'degraded',
      registration_state: 'drifted',
      last_error_code: 'remote_endpoint_drift',
      last_delivery_at: expect.any(Number),
    });
  });

  it('keeps first/last observed bounds monotonic across out-of-order accepts', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness, {
      deliveryKey: 'delivery-newer',
      eventKey: 'event-newer',
      receivedAt: 1_999_999_999_900,
    }));
    await harness.deliveryStore.accept(acceptedInput(harness, {
      deliveryKey: 'delivery-older',
      eventKey: 'event-older',
      receivedAt: 1_999_999_999_800,
    }));

    expect(harness.ingressStore.get(harness.ingressId)).toMatchObject({
      test_observed_at: 1_999_999_999_800,
      last_delivery_at: 1_999_999_999_900,
    });
  });

  it('rejects invalid credential versions and pins accepted text across commit', async () => {
    const harness = await makeHarness();
    const toPrimitive = vi.fn(() => '1');
    const valueOf = vi.fn(() => 1);
    const toString = vi.fn(() => '1');
    const coercible = {
      [Symbol.toPrimitive]: toPrimitive,
      valueOf,
      toString,
    };
    const invalidVersions: unknown[] = [
      '',
      '0',
      '01',
      '+1',
      String(Number.MAX_SAFE_INTEGER + 1),
      '1'.repeat(1_000),
      1,
      Symbol('1'),
      new String('1'),
      coercible,
    ];
    for (let index = 0; index < invalidVersions.length; index += 1) {
      const input = acceptedInput(harness, {
        deliveryKey: `invalid-credential-delivery-${index}`,
        eventKey: `invalid-credential-event-${index}`,
      });
      input.credential_version = invalidVersions[index] as never;
      await expect(harness.deliveryStore.accept(input)).rejects.toMatchObject({
        code: 'conflict',
        message: 'webhook profile returned an invalid credential version',
      });
    }
    expect(toPrimitive).not.toHaveBeenCalled();
    expect(valueOf).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toEqual([]);

    let credentialVersionReads = 0;
    const pinned = acceptedInput(harness, {
      deliveryKey: 'pinned-credential-delivery',
      eventKey: 'pinned-credential-event',
    });
    Object.defineProperty(pinned, 'credential_version', {
      configurable: true,
      enumerable: true,
      get() {
        credentialVersionReads += 1;
        return credentialVersionReads === 1
          ? '1'
          : String(Number.MAX_SAFE_INTEGER + 1);
      },
    });
    await expect(harness.deliveryStore.accept(pinned)).resolves.toMatchObject({
      duplicate_delivery: false,
      delivery: { credential_version: '1' },
    });
    expect(credentialVersionReads).toBe(1);
  });

  it('requires a verified remaining version before live credential retirement', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness, {
      deliveryKey: 'rotation-delivery',
      eventKey: 'rotation-event',
    }));
    const replacement = await harness.ingressStore.writeCredentialVersion(
      harness.ingressId,
      {
        header_name: 'x-test-token',
        header_token: 'replacement-secret-token',
      },
    );
    expect(replacement).toMatchObject({
      version: '2',
      last_verified_at: null,
    });
    expect(() => harness.ingressStore.retireCredentialVersion(
      harness.ingressId,
      1,
    )).toThrow('verify a remaining credential');

    await expect(harness.deliveryStore.accept(acceptedInput(harness, {
      deliveryKey: 'rotation-delivery',
      eventKey: 'rotation-event',
      credentialVersion: '2',
    }))).resolves.toMatchObject({ duplicate_delivery: true });
    expect(harness.ingressStore.listCredentialVersions(harness.ingressId))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          version: '2',
          last_verified_at: 2_000_000_000_000,
        }),
      ]));
    expect(harness.ingressStore.retireCredentialVersion(
      harness.ingressId,
      1,
    ).intake_state).toBe('enabled');
  });

  it('applies durable outbox backpressure without turning a duplicate into a retry storm', async () => {
    const harness = await makeHarness({ maxOutboxBacklog: 1 });
    await harness.deliveryStore.accept(acceptedInput(harness));
    await expect(harness.deliveryStore.accept(acceptedInput(harness, {
      deliveryKey: 'delivery-unselected-over-capacity',
      eventKey: 'event-unselected-over-capacity',
      eventType: 'not-selected',
    }))).resolves.toMatchObject({
      duplicate_delivery: false,
      fresh_events: [expect.objectContaining({ dispatch_state: 'ignored' })],
    });
    await expect(harness.deliveryStore.accept(acceptedInput(harness, {
      deliveryKey: 'delivery-over-capacity',
      eventKey: 'event-over-capacity',
    }))).rejects.toMatchObject({ code: 'backpressure' });
    await expect(harness.deliveryStore.accept(acceptedInput(harness)))
      .resolves.toMatchObject({ duplicate_delivery: true });
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toHaveLength(2);
    expect(harness.deliveryStore.listOutbox()).toHaveLength(1);
  });

  it('keeps encrypted decoded payload rows out of the server audit export', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness, {
      payload: { private_export_value: 'must-not-enter-audit-export' },
    }));
    const stored = harness.db.prepare(`
      SELECT payload_ref, ciphertext FROM webhook_decoded_payloads
    `).get() as { payload_ref: string; ciphertext: string };
    harness.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_entries (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
    `);
    ensureMemorySchema(harness.db);
    const auditLog = createAuditLogStore(
      createInMemoryCollection(),
      createInMemoryCollection(),
    );
    await auditLog.append(buildAuditEntry({
      run_id: 'run-webhook-payload-export-regression',
      recipe_id: 'recipe-safe',
      recipe_hash: 'hash-safe',
      now: 2_000_000_000_100,
      duration_ms: 0,
      commit_status: 'succeeded',
      config_snapshot: {},
      errors: [],
      trigger_url: null,
      trigger_source: 'manual',
      instance_id: 'owner-webclient',
    }));

    const page = await handleAuditExportPage({
      db: harness.db,
      auditLog,
      serverInstanceId: 'server-webhook-payload-export-regression',
    }, { format: 'json' });
    const exported = JSON.stringify(page);
    expect(exported).not.toContain('must-not-enter-audit-export');
    expect(exported).not.toContain(stored.payload_ref);
    expect(exported).not.toContain(stored.ciphertext);
    expect(exported).not.toContain('webhook_decoded_payloads');
  });

  it('rolls back every row at the injected pre-commit crash point', async () => {
    let crash = true;
    const harness = await makeHarness({
      beforeAcceptCommit: () => {
        if (crash) throw new Error('simulated-before-commit-crash');
      },
    });
    await expect(harness.deliveryStore.accept(acceptedInput(harness)))
      .rejects.toThrow('simulated-before-commit-crash');
    for (const table of [
      'webhook_accepted_deliveries',
      'webhook_accepted_events',
      'webhook_decoded_payloads',
      'webhook_event_outbox',
    ]) {
      expect(tableCount(harness.db, table)).toBe(0);
    }
    expect(harness.ingressStore.get(harness.ingressId)?.last_delivery_at).toBeNull();

    crash = false;
    await expect(harness.deliveryStore.accept(acceptedInput(harness)))
      .resolves.toMatchObject({ duplicate_delivery: false });
  });

  it('cannot commit after a vault lock or ingress retirement wins async encryption', async () => {
    const locked = await makeHarness();
    const pendingLocked = locked.deliveryStore.accept(acceptedInput(locked));
    locked.setPayloadUnlocked(false);
    await expect(pendingLocked).rejects.toMatchObject({ code: 'locked' });
    expect(tableCount(locked.db, 'webhook_accepted_deliveries')).toBe(0);

    const retired = await makeHarness();
    const pendingRetired = retired.deliveryStore.accept(acceptedInput(retired));
    retired.ingressStore.retire(retired.ingressId);
    await expect(pendingRetired).rejects.toBeInstanceOf(WebhookDeliveryStoreError);
    await expect(pendingRetired).rejects.toMatchObject({ code: 'ingress_closed' });
    expect(tableCount(retired.db, 'webhook_accepted_deliveries')).toBe(0);
  });

  it('reclaims expired leases and rejects a stale worker completion', async () => {
    const harness = await makeHarness();
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    const firstClaim = harness.deliveryStore.claimOutbox({ limit: 1, lease_ms: 1_000 });
    expect(firstClaim).toEqual([
      expect.objectContaining({ attempt_count: 1 }),
    ]);
    harness.setNow(2_000_000_002_000);
    const recovered = harness.deliveryStore.claimOutbox({ limit: 1, lease_ms: 1_000 });
    expect(recovered).toEqual([
      expect.objectContaining({
        attempt_count: 2,
        event: expect.objectContaining({
          event_id: accepted.fresh_events[0]!.event_id,
        }),
      }),
    ]);
    expect(() => harness.deliveryStore.markOutboxDispatched(
      firstClaim[0]!.outbox_id,
      firstClaim[0]!.claim_token,
    )).toThrowError(WebhookDeliveryStoreError);
    harness.deliveryStore.markOutboxDispatched(
      recovered[0]!.outbox_id,
      recovered[0]!.claim_token,
    );
    expect(harness.deliveryStore.getEvent(accepted.fresh_events[0]!.event_id))
      .toMatchObject({ dispatch_state: 'dispatched' });
  });

  it('replays the same event id after a crash following the sink side effect', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness));
    const firstClaim = harness.deliveryStore.claimOutbox({ limit: 1, lease_ms: 1_000 });
    const observedIds = [firstClaim[0]!.event.event_id];
    // Simulated process crash: sink side effect happened, no mark call.
    harness.setNow(2_000_000_002_000);
    const result = await dispatchWebhookOutboxOnce(
      harness.deliveryStore,
      {
        dispatch: async (input) => {
          observedIds.push(input.idempotency_key);
        },
      },
      { lease_ms: 1_000, dispatch_timeout_ms: 500 },
    );
    expect(result).toMatchObject({ claimed: 1, dispatched: 1 });
    expect(observedIds).toEqual([
      firstClaim[0]!.event.event_id,
      firstClaim[0]!.event.event_id,
    ]);
  });

  it('does not claim or burn attempts while autonomous dispatch is gated', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness));
    let allowed = false;
    let calls = 0;
    const runtime = createWebhookOutboxRuntime(
      harness.deliveryStore,
      { dispatch: async () => { calls += 1; } },
      {
        canDispatch: () => allowed,
        poll_interval_ms: 60_000,
      },
    );
    runtime.start();
    try {
      await expect(runtime.drainOnce()).resolves.toEqual({
        claimed: 0,
        dispatched: 0,
        retried: 0,
        dead_lettered: 0,
      });
      expect(harness.deliveryStore.listOutbox()[0]).toMatchObject({
        state: 'pending',
        attempt_count: 0,
      });
      expect(calls).toBe(0);

      allowed = true;
      await expect(runtime.drainOnce()).resolves.toMatchObject({
        claimed: 1,
        dispatched: 1,
      });
      expect(calls).toBe(1);
    } finally {
      await runtime.stop();
    }
  });

  it('reconciles durable approval holds before the autonomous dispatch gate', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness));
    const order: string[] = [];
    const runtime = createWebhookOutboxRuntime(
      harness.deliveryStore,
      { dispatch: async () => { order.push('dispatch'); } },
      {
        reconcileWaitingDispatches: async () => { order.push('reconcile'); },
        canDispatch: () => {
          order.push('gate');
          return false;
        },
      },
    );

    await expect(runtime.drainOnce()).resolves.toEqual({
      claimed: 0,
      dispatched: 0,
      retried: 0,
      dead_lettered: 0,
    });
    expect(order).toEqual(['reconcile', 'gate']);
    expect(harness.deliveryStore.listOutbox()[0]).toMatchObject({
      state: 'pending',
      attempt_count: 0,
    });
    await runtime.stop();
  });

  it('fails closed without claiming work when the autonomous gate throws', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness));
    let calls = 0;
    const logs: Array<{ message: string; code: string | number | undefined }> = [];
    const runtime = createWebhookOutboxRuntime(
      harness.deliveryStore,
      { dispatch: async () => { calls += 1; } },
      {
        canDispatch: () => { throw new Error('pause authority unavailable'); },
        log: (_level, message, metadata) => {
          logs.push({ message, code: metadata.code });
        },
      },
    );

    await expect(runtime.drainOnce()).resolves.toEqual({
      claimed: 0,
      dispatched: 0,
      retried: 0,
      dead_lettered: 0,
    });
    expect(harness.deliveryStore.listOutbox()[0]).toMatchObject({
      state: 'pending',
      attempt_count: 0,
    });
    expect(calls).toBe(0);
    expect(logs).toEqual([{
      message: 'webhook outbox dispatch gate unavailable',
      code: 'dispatch_gate_unavailable',
    }]);
    await runtime.stop();
  });

  it('waits for an active dispatch pass before shutdown completes', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness));
    let enterDispatch!: () => void;
    const dispatchEntered = new Promise<void>((resolve) => { enterDispatch = resolve; });
    let releaseDispatch!: () => void;
    const dispatchReleased = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const runtime = createWebhookOutboxRuntime(harness.deliveryStore, {
      dispatch: async () => {
        enterDispatch();
        await dispatchReleased;
      },
    });

    const activePass = runtime.drainOnce();
    await dispatchEntered;
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseDispatch();
    await expect(activePass).resolves.toMatchObject({ dispatched: 1 });
    await stopping;
    expect(stopped).toBe(true);
  });

  it('waits for a recipe dispatch that outlives its polling-pass timeout', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness));
    let releaseDispatch!: () => void;
    const dispatchReleased = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let dispatchEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      dispatchEntered = resolve;
    });
    const runtime = createWebhookOutboxRuntime(harness.deliveryStore, {
      dispatch: async () => {
        dispatchEntered();
        await dispatchReleased;
      },
    }, {
      dispatch_timeout_ms: 1,
      base_retry_ms: 0,
      max_retry_ms: 0,
    });

    const pass = runtime.drainOnce();
    await entered;
    await expect(pass).resolves.toMatchObject({ claimed: 1, retried: 1 });

    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseDispatch();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('pauses claims at the residual dispatch ceiling without burning attempts', async () => {
    const harness = await makeHarness();
    for (let index = 1; index <= 3; index += 1) {
      await harness.deliveryStore.accept(acceptedInput(harness, {
        deliveryKey: `delivery-cap-${index}`,
        eventKey: `event-cap-${index}`,
      }));
    }
    const gates: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    const logs: Array<{ message: string; code: string | number | undefined }> = [];
    const runtime = createWebhookOutboxRuntime(harness.deliveryStore, {
      dispatch: () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        gates.push({ promise, resolve });
        return promise;
      },
    }, {
      max_active_dispatches: 2,
      dispatch_timeout_ms: 1,
      base_retry_ms: 0,
      max_retry_ms: 0,
      log: (_level, message, metadata) => {
        logs.push({ message, code: metadata.code });
      },
    });

    await expect(runtime.drainOnce()).resolves.toMatchObject({
      claimed: 2,
      retried: 2,
    });
    expect(gates).toHaveLength(2);
    expect(harness.deliveryStore.listOutbox().map((row) => row.attempt_count).sort())
      .toEqual([0, 1, 1]);

    await expect(runtime.drainOnce()).resolves.toEqual({
      claimed: 0,
      dispatched: 0,
      retried: 0,
      dead_lettered: 0,
    });
    await expect(runtime.drainOnce()).resolves.toMatchObject({ claimed: 0 });
    expect(gates).toHaveLength(2);
    expect(harness.deliveryStore.listOutbox().map((row) => row.attempt_count).sort())
      .toEqual([0, 1, 1]);
    expect(logs).toEqual([{
      message: 'webhook outbox active dispatch ceiling reached',
      code: 'active_dispatch_ceiling',
    }]);

    gates[0]!.resolve();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await expect(runtime.drainOnce()).resolves.toMatchObject({
      claimed: 1,
      retried: 1,
    });
    expect(gates).toHaveLength(3);
    expect(WEBHOOK_OUTBOX_MAX_ACTIVE_DISPATCHES).toBe(16);

    for (const gate of gates) gate.resolve();
    await runtime.stop();
  });

  it('refuses a fresh explicit pass after shutdown closes admission', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness));
    let calls = 0;
    const runtime = createWebhookOutboxRuntime(harness.deliveryStore, {
      dispatch: async () => { calls += 1; },
    });

    await runtime.stop();

    await expect(runtime.drainOnce()).resolves.toEqual({
      claimed: 0,
      dispatched: 0,
      retried: 0,
      dead_lettered: 0,
    });
    expect(calls).toBe(0);
    expect(harness.deliveryStore.listOutbox()[0]).toMatchObject({
      state: 'pending',
      attempt_count: 0,
    });
  });

  it('dead-letters an expired crash claim once its attempt ceiling is reached', async () => {
    const harness = await makeHarness();
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    const crashed = harness.deliveryStore.claimOutbox({ limit: 1, lease_ms: 1_000 });
    expect(crashed[0]).toMatchObject({ attempt_count: 1 });
    harness.setNow(2_000_000_002_000);
    let sinkCalls = 0;

    await expect(dispatchWebhookOutboxOnce(
      harness.deliveryStore,
      { dispatch: async () => { sinkCalls += 1; } },
      {
        batch_size: 0,
        lease_ms: 1_000,
        dispatch_timeout_ms: 500,
        max_attempts: 1,
      },
    )).rejects.toThrow('batch_size');
    expect(harness.deliveryStore.listOutbox()[0])
      .toMatchObject({ state: 'leased', attempt_count: 1 });
    expect(harness.deliveryStore.claimOutbox({
      limit: 1,
      lease_ms: 1_000,
      max_attempts: 1,
    })).toEqual([]);

    const result = await dispatchWebhookOutboxOnce(
      harness.deliveryStore,
      { dispatch: async () => { sinkCalls += 1; } },
      { lease_ms: 1_000, dispatch_timeout_ms: 500, max_attempts: 1 },
    );

    expect(result).toEqual({
      claimed: 0,
      dispatched: 0,
      retried: 0,
      dead_lettered: 1,
    });
    expect(sinkCalls).toBe(0);
    expect(harness.deliveryStore.listOutbox()).toEqual([
      expect.objectContaining({
        state: 'dead_letter',
        attempt_count: 1,
        last_error_code: 'lease_expired_attempt_limit',
      }),
    ]);
    expect(harness.deliveryStore.getEvent(accepted.fresh_events[0]!.event_id))
      .toMatchObject({ dispatch_state: 'dead_letter' });
  });

  it('retries with bounded attempts and dead-letters without persisting an exception', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness));
    const sink = { dispatch: async () => { throw new Error('secret-bearing failure text'); } };

    const first = await dispatchWebhookOutboxOnce(harness.deliveryStore, sink, {
      max_attempts: 2,
      base_retry_ms: 0,
      max_retry_ms: 0,
    });
    const second = await dispatchWebhookOutboxOnce(harness.deliveryStore, sink, {
      max_attempts: 2,
      base_retry_ms: 0,
      max_retry_ms: 0,
    });
    expect(first).toMatchObject({ retried: 1, dead_lettered: 0 });
    expect(second).toMatchObject({ retried: 0, dead_lettered: 1 });
    expect(harness.deliveryStore.listOutbox()).toEqual([
      expect.objectContaining({
        state: 'dead_letter',
        attempt_count: 2,
        last_error_code: 'dispatch_failed',
      }),
    ]);
    expect(JSON.stringify(harness.deliveryStore.listOutbox()))
      .not.toContain('secret-bearing failure text');
  });

  it('keeps payloads behind pending/dead-letter work and tombstones beyond payload retention', async () => {
    const harness = await makeHarness({ payloadRetentionMs: 100, dedupRetentionMs: 200 });
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    const eventId = accepted.fresh_events[0]!.event_id;

    harness.setNow(2_000_000_000_150);
    expect(harness.deliveryStore.prune()).toMatchObject({ payloads_deleted: 0 });
    await expect(harness.deliveryStore.readEventPayload(eventId)).resolves.toEqual({ safe: true });

    await dispatchWebhookOutboxOnce(harness.deliveryStore, {
      dispatch: async () => {},
    });
    expect(harness.deliveryStore.prune()).toMatchObject({ payloads_deleted: 1 });
    await expect(harness.deliveryStore.readEventPayload(eventId)).resolves.toBeNull();
    expect(harness.deliveryStore.listEvents(harness.ingressId)).toHaveLength(1);

    harness.setPayloadUnlocked(false);
    await expect(harness.deliveryStore.accept(acceptedInput(harness, {
      payload: { replay_after_payload_prune: true },
    }))).resolves.toMatchObject({ duplicate_delivery: true, fresh_events: [] });
    expect(harness.deliveryStore.listOutbox()).toHaveLength(1);

    harness.setNow(2_000_000_000_250);
    expect(harness.deliveryStore.prune()).toMatchObject({
      outbox_rows_deleted: 1,
      events_deleted: 1,
      deliveries_deleted: 1,
    });
  });

  it('prunes only eligible rows for the selected ingress and includes rejected summaries', async () => {
    const harness = await makeHarness({
      payloadRetentionMs: 100,
      dedupRetentionMs: 200,
      rejectionRetentionMs: 100,
    });
    const base = 2_000_000_000_000;
    const other = harness.ingressStore.create({
      display_name: 'Other retention scope',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    });
    await harness.ingressStore.writeCredentialVersion(other.ingress_id, {
      header_name: 'x-other-test-token',
      header_token: 'other-fixture-secret-token',
    });
    harness.db.prepare(`
      UPDATE webhook_ingresses
      SET intake_state = 'enabled', registration_state = 'registered', enabled_at = ?
      WHERE ingress_id = ?
    `).run(base, other.ingress_id);
    await harness.deliveryStore.accept(acceptedInput(harness, {
      ingressId: other.ingress_id,
      deliveryKey: 'other-delivery',
      eventKey: 'other-event',
    }));
    await dispatchWebhookOutboxOnce(harness.deliveryStore, { dispatch: async () => {} });
    await harness.deliveryStore.accept(acceptedInput(harness));
    for (const ingressId of [harness.ingressId, other.ingress_id]) {
      harness.deliveryStore.recordRejectedDelivery({
        ingress_id: ingressId,
        profile_id: 'generic.static-header-token.v1',
        environment: 'test',
        received_at: base,
        reason_code: 'authentication_failed',
        http_status: 401,
      });
    }

    harness.setNow(base + 50);
    expect(harness.deliveryStore.pruneIngress({
      ingress_id: harness.ingressId,
    })).toEqual({
      payloads_deleted: 0,
      outbox_rows_deleted: 0,
      events_deleted: 0,
      deliveries_deleted: 0,
      rejected_summaries_deleted: 0,
    });

    harness.setNow(base + 250);
    expect(harness.deliveryStore.pruneIngress({
      ingress_id: harness.ingressId,
    })).toMatchObject({
      payloads_deleted: 0,
      rejected_summaries_deleted: 1,
    });
    // Pending delivery work and its payload survive even after the payload
    // threshold; completed rows and the eligible rejection on the other ingress
    // are outside this scoped pass even though global retention could delete them.
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toHaveLength(1);
    for (const table of [
      'webhook_decoded_payloads',
      'webhook_accepted_events',
      'webhook_accepted_deliveries',
      'webhook_rejected_delivery_summaries',
    ]) {
      expect(harness.db.prepare(`
        SELECT ingress_id FROM ${table} WHERE ingress_id = ?
      `).all(other.ingress_id)).toEqual([{ ingress_id: other.ingress_id }]);
    }
    expect(harness.deliveryStore.listOutbox()).toEqual([
      expect.objectContaining({ state: 'dispatched' }),
      expect.objectContaining({ state: 'pending' }),
    ]);

    expect(harness.deliveryStore.prune()).toMatchObject({
      payloads_deleted: 1,
      outbox_rows_deleted: 1,
      events_deleted: 1,
      deliveries_deleted: 1,
      rejected_summaries_deleted: 1,
    });
    expect(harness.deliveryStore.listOutbox()).toEqual([
      expect.objectContaining({ state: 'pending' }),
    ]);

    expect(() => harness.deliveryStore.pruneIngress({
      ingress_id: 'not-an-ingress',
    })).toThrow('ingress_id has invalid shape');
  });

  it('paginates same-millisecond deliveries and distinguishes retained JSON null from expiry', async () => {
    const harness = await makeHarness({ payloadRetentionMs: 100, dedupRetentionMs: 200 });
    const first = await harness.deliveryStore.accept(acceptedInput(harness, {
      deliveryKey: 'delivery-page-1',
      eventKey: 'event-page-1',
      receivedAt: 2_000_000_000_000,
      payload: null,
    }));
    const second = await harness.deliveryStore.accept(acceptedInput(harness, {
      deliveryKey: 'delivery-page-2',
      eventKey: 'event-page-2',
      receivedAt: 2_000_000_000_000,
    }));
    const third = await harness.deliveryStore.accept(acceptedInput(harness, {
      deliveryKey: 'delivery-page-3',
      eventKey: 'event-page-3',
      receivedAt: 1_999_999_999_900,
    }));

    const page1 = harness.deliveryStore.listDeliveriesPage({
      ingress_id: harness.ingressId,
      limit: 1,
    });
    expect(page1).toEqual({ deliveries: [first.delivery], has_more: true });
    const page2 = harness.deliveryStore.listDeliveriesPage({
      ingress_id: harness.ingressId,
      limit: 1,
      cursor: {
        received_at: first.delivery.received_at,
        delivery_id: first.delivery.delivery_id,
      },
    });
    expect(page2).toEqual({ deliveries: [second.delivery], has_more: true });
    const page3 = harness.deliveryStore.listDeliveriesPage({
      ingress_id: harness.ingressId,
      limit: 1,
      cursor: {
        received_at: second.delivery.received_at,
        delivery_id: second.delivery.delivery_id,
      },
    });
    expect(page3).toEqual({ deliveries: [third.delivery], has_more: false });

    const firstEventId = first.fresh_events[0]!.event_id;
    expect(harness.deliveryStore.listEventsForDelivery(first.delivery.delivery_id))
      .toEqual([
        expect.objectContaining({
          event: expect.objectContaining({ event_id: firstEventId }),
          payload_retained: true,
          payload_expires_at: 2_000_000_000_100,
        }),
      ]);
    await expect(harness.deliveryStore.readRetainedEventPayload(firstEventId))
      .resolves.toEqual({ payload: null });

    await dispatchWebhookOutboxOnce(harness.deliveryStore, { dispatch: async () => {} });
    harness.setNow(2_000_000_000_150);
    expect(harness.deliveryStore.prune()).toMatchObject({ payloads_deleted: 3 });
    expect(harness.deliveryStore.listEventsForDelivery(first.delivery.delivery_id))
      .toEqual([
        expect.objectContaining({
          event: expect.objectContaining({ event_id: firstEventId }),
          payload_retained: false,
          payload_expires_at: null,
        }),
      ]);
    await expect(harness.deliveryStore.readRetainedEventPayload(firstEventId))
      .resolves.toBeNull();
  });
});
