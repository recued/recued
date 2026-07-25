import { createHash } from 'node:crypto';
import http from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebhookProfileId } from '@recued/contracts';
import { startServer, type RunningServer } from '../server.js';
import {
  createWebhookDeliveryStore,
  type WebhookDeliveryStore,
} from '../storage/webhook-delivery-store.js';
import {
  createWebhookIngressStore,
  WEBHOOK_PAIRED_CONNECTION_DELETED,
  type WebhookIngressStore,
} from '../storage/webhook-ingress-store.js';
import {
  createWebhookOutboxRuntime,
  type WebhookOutboxRuntime,
} from '../webhook-outbox-dispatcher.js';
import {
  createWebhookProfileListener,
  type WebhookProfileRequestHandler,
} from '../webhook-profile-listener.js';
import { createPrimitiveWebhookProfileRuntimeRegistry } from '../webhook-primitive-profiles.js';
import {
  WebhookProfileDependencyUnavailableError,
  createWebhookProfileRuntimeRegistry,
  type RawWebhookRequest,
  type WebhookIngressProfileAdapter,
  type WebhookProfileResult,
  type WebhookProfileRuntimeContext,
} from '../webhook-profile-runtime.js';

const SECRET_KEY = new Uint8Array(32).fill(61);
const PAYLOAD_KEY = new Uint8Array(32).fill(73);
const PUBLIC_ID = 'A'.repeat(32);
const TEST_SUCCESS_RESPONSE = {
  status: 202,
  content_type: 'text/plain',
  body: 'profile-accepted',
} as const;

const databases: Database.Database[] = [];
const servers: RunningServer[] = [];
const runtimes: WebhookOutboxRuntime[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
  while (runtimes.length > 0) await runtimes.pop()!.stop();
  while (databases.length > 0) databases.pop()!.close();
});

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const request = (
  port: number,
  input: {
    path?: string;
    method?: string;
    headers?: http.OutgoingHttpHeaders;
    body?: Buffer;
  } = {},
): Promise<HttpResponse> => new Promise((resolve, reject) => {
  const body = input.body ?? Buffer.from('{}');
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: input.path ?? `/v1/webhooks/${PUBLIC_ID}`,
    method: input.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.byteLength,
      ...input.headers,
    },
  }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => resolve({
      status: res.statusCode ?? 0,
      headers: res.headers,
      body: Buffer.concat(chunks),
    }));
  });
  req.on('error', reject);
  req.end(body);
});

interface ListenerHarness {
  db: Database.Database;
  ingressStore: WebhookIngressStore;
  deliveryStore: WebhookDeliveryStore;
  listener: WebhookProfileRequestHandler;
  runtime: WebhookOutboxRuntime;
  ingressId: string;
  sinkEventIds: string[];
  failures: string[];
  handshakes: string[];
  setPayloadUnlocked(value: boolean): void;
}

const defaultAcceptedResult = (
  context: WebhookProfileRuntimeContext,
  input: {
    deliveryKey?: string;
    eventKey?: string;
    eventType?: string;
    payload?: unknown;
  } = {},
): WebhookProfileResult => ({
  ok: true,
  delivery: {
    delivery_dedup_key: input.deliveryKey ?? 'delivery-http-1',
    decoded_content_type: 'application/json',
    events: [{
      event_dedup_key: input.eventKey ?? 'event-http-1',
      provider_event_id: input.eventKey ?? 'event-http-1',
      provider_resource_id: null,
      provider_event_type: input.eventType ?? 'delivery',
      provider_occurred_at: null,
      decoded_payload: input.payload ?? { accepted: true },
    }],
    response: {
      ...TEST_SUCCESS_RESPONSE,
    },
    admission: {
      transport_assurance: 'authenticated',
      credential_version: context.credential_versions[0]?.version ?? null,
      freshness_checked: false,
      method_label: 'test-adapter',
    },
  },
});

const makeHarness = async (input: {
  profileId?: WebhookProfileId;
  adapter?: WebhookIngressProfileAdapter;
  adapters?: readonly WebhookIngressProfileAdapter[];
  intakeState?: 'enabled' | 'verification_pending';
  globalMaxBodyBytes?: number;
  profileTimeoutMs?: number;
  beforeAcceptCommit?: () => void;
  credentials?: Readonly<Record<string, string>>;
  isPaused?: () => boolean;
  isIntakeReachable?: () => boolean | Promise<boolean>;
} = {}): Promise<ListenerHarness> => {
  const profileId = input.profileId ?? 'generic.static-header-token.v1';
  const db = new Database(':memory:');
  databases.push(db);
  let stamp = 2_100_000_000_000;
  let payloadUnlocked = true;
  let deliverySequence = 0;
  let eventSequence = 0;
  let payloadSequence = 0;
  let outboxSequence = 0;
  const ingressStore = createWebhookIngressStore(db, {
    now: () => ++stamp,
    getEncryptionKey: () => SECRET_KEY,
    newIngressId: () => 'whi_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    newPublicId: () => PUBLIC_ID,
    newCredentialSetRef: () => 'whc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const ingress = ingressStore.create({
    display_name: 'HTTP kernel fixture',
    profile_id: profileId,
    environment: 'test',
    paired_connection_id: null,
    registration_mode: 'manual',
    selected_event_types: profileId === 'slack.request.v0'
      ? ['event_callback']
      : ['delivery'],
  });
  await ingressStore.writeCredentialVersion(
    ingress.ingress_id,
    input.credentials ?? (profileId === 'slack.request.v0'
      ? { signing_secret: 'slack-fixture-secret' }
      : { header_name: 'x-test-token', header_token: 'fixture-secret-token' }),
  );
  const intakeState = input.intakeState ?? 'enabled';
  db.prepare(`
    UPDATE webhook_ingresses SET
      intake_state = ?, registration_state = 'registered',
      confirmed_endpoint_url = ?,
      enabled_at = CASE WHEN ? = 'enabled' THEN ? ELSE NULL END
    WHERE ingress_id = ?
  `).run(
    intakeState,
    `https://hooks.example.test/v1/webhooks/${PUBLIC_ID}`,
    intakeState,
    stamp,
    ingress.ingress_id,
  );

  const deliveryStore = createWebhookDeliveryStore(db, {
    now: () => ++stamp,
    getEncryptionKey: () => payloadUnlocked ? PAYLOAD_KEY : null,
    newDeliveryId: () => `whd_${String(++deliverySequence).padStart(32, '0')}`,
    newEventId: () => `whe_${String(++eventSequence).padStart(32, '0')}`,
    newPayloadRef: () => `whp_${String(++payloadSequence).padStart(32, '0')}`,
    newOutboxId: () => `who_${String(++outboxSequence).padStart(32, '0')}`,
    hasDispatchTarget: () => true,
    ...(input.beforeAcceptCommit
      ? { beforeAcceptCommit: input.beforeAcceptCommit }
      : {}),
  });
  const adapter = input.adapter ?? {
    profile_id: profileId,
    success_response: TEST_SUCCESS_RESPONSE,
    verifyAndDecode: async (_request, context) => defaultAcceptedResult(context),
  };
  const profiles = createWebhookProfileRuntimeRegistry(
    input.adapters ?? [adapter],
  );
  const sinkEventIds: string[] = [];
  const failures: string[] = [];
  const handshakes: string[] = [];
  const runtime = createWebhookOutboxRuntime(deliveryStore, {
    dispatch: async (dispatch) => {
      sinkEventIds.push(dispatch.idempotency_key);
    },
  }, { poll_interval_ms: 60_000 });
  runtimes.push(runtime);
  const listener = createWebhookProfileListener({
    ingressStore,
    deliveryStore,
    profiles,
    isOutboxDispatcherStarted: runtime.isStarted,
    ...(input.isPaused ? { isPaused: input.isPaused } : {}),
    ...(input.isIntakeReachable
      ? { isIntakeReachable: input.isIntakeReachable }
      : {}),
    resolveCanonicalPublicUrl: ({ raw_path_and_query }) =>
      `https://hooks.example.test${raw_path_and_query}`,
    captureTransportEvidence: () => ({
      trusted_proxy_id: 'test-listener',
      client_certificate_chain_der: [Buffer.from('trusted-cert-evidence')],
    }),
    now: () => ++stamp,
    ...(input.globalMaxBodyBytes !== undefined
      ? { globalMaxBodyBytes: input.globalMaxBodyBytes }
      : {}),
    ...(input.profileTimeoutMs !== undefined
      ? { profileTimeoutMs: input.profileTimeoutMs }
      : {}),
    onProfileFailure: ({ code }) => failures.push(code),
    onHandshakeReadinessProven: (ingressId) => handshakes.push(ingressId),
  });
  return {
    db,
    ingressStore,
    deliveryStore,
    listener,
    runtime,
    ingressId: ingress.ingress_id,
    sinkEventIds,
    failures,
    handshakes,
    setPayloadUnlocked(value) {
      payloadUnlocked = value;
    },
  };
};

const startHarnessServer = async (harness: ListenerHarness): Promise<RunningServer> => {
  const server = await startServer(0, {
    webhookProfileListener: harness.listener,
  });
  servers.push(server);
  return server;
};

describe('D-201 Slices 2 / 5B2B2A exact-byte webhook profile listener', () => {
  it('keeps the runtime registry closed and handshake-compatible with portable descriptors', () => {
    const generic: WebhookIngressProfileAdapter = {
      profile_id: 'generic.static-header-token.v1',
      success_response: TEST_SUCCESS_RESPONSE,
      verifyAndDecode: async (_raw, context) => defaultAcceptedResult(context),
    };
    expect(() => createWebhookProfileRuntimeRegistry([generic, generic]))
      .toThrow('duplicate adapter');
    expect(() => createWebhookProfileRuntimeRegistry([{
      ...generic,
      handleHandshake: async () => null,
    }])).toThrow('handshake surface');
    expect(() => createWebhookProfileRuntimeRegistry([{
      profile_id: 'slack.request.v0',
      success_response: TEST_SUCCESS_RESPONSE,
      verifyAndDecode: async (_raw, context) =>
        defaultAcceptedResult(context, { eventType: 'event_callback' }),
    }])).toThrow('handshake surface');
  });

  it('captures exact bytes/repeated headers/trusted URL and acknowledges only after durable acceptance', async () => {
    let captured: {
      body: Buffer;
      signatures: readonly string[];
      rawPath: string;
      canonicalUrl: string;
      credential: string | undefined;
      proxyId: string | undefined;
      cert: string | undefined;
    } | null = null;
    const adapter: WebhookIngressProfileAdapter = {
      profile_id: 'generic.static-header-token.v1',
      success_response: TEST_SUCCESS_RESPONSE,
      verifyAndDecode: async (raw, context) => {
        captured = {
          body: Buffer.from(raw.raw_body),
          signatures: [...(raw.headers.get('x-test-signature') ?? [])],
          rawPath: raw.raw_path_and_query,
          canonicalUrl: raw.canonical_public_url,
          credential: context.credential_versions[0]?.credentials.header_token,
          proxyId: raw.transport_evidence?.trusted_proxy_id,
          cert: raw.transport_evidence?.client_certificate_chain_der?.[0]?.toString(),
        };
        raw.raw_body.fill(0x78);
        return defaultAcceptedResult(context, {
          payload: { private_value: 'payload-only-in-ciphertext' },
        });
      },
    };
    const harness = await makeHarness({ adapter });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    const body = Buffer.from('{"z":1,\n  "a":2}', 'utf8');
    const result = await request(server.port, {
      path: `/v1/webhooks/${PUBLIC_ID}?b=2&a=1`,
      headers: {
        'X-Test-Signature': ['first', 'second'],
      },
      body,
    });

    expect(result).toMatchObject({ status: 202 });
    expect(result.body.toString()).toBe('profile-accepted');
    expect(captured).toEqual({
      body,
      signatures: ['first', 'second'],
      rawPath: `/v1/webhooks/${PUBLIC_ID}?b=2&a=1`,
      canonicalUrl: `https://hooks.example.test/v1/webhooks/${PUBLIC_ID}?b=2&a=1`,
      credential: 'fixture-secret-token',
      proxyId: 'test-listener',
      cert: 'trusted-cert-evidence',
    });
    const deliveries = harness.deliveryStore.listDeliveries(harness.ingressId);
    expect(deliveries).toEqual([
      expect.objectContaining({
        raw_body_sha256: createHash('sha256').update(body).digest('hex'),
        raw_body_ref: null,
        decoded_schema_id: 'generic.delivery.v1',
      }),
    ]);
    expect(harness.deliveryStore.listOutbox()).toEqual([
      expect.objectContaining({ state: 'pending' }),
    ]);
    await harness.runtime.drainOnce();
    expect(harness.sinkEventIds).toEqual([
      harness.deliveryStore.listEvents(harness.ingressId)[0]!.event_id,
    ]);
    expect(harness.deliveryStore.listEvents(harness.ingressId)[0])
      .toMatchObject({ dispatch_state: 'dispatched' });
    expect(harness.ingressStore.get(harness.ingressId)).toMatchObject({
      intake_state: 'enabled',
      test_observed_at: expect.any(Number),
      last_delivery_at: expect.any(Number),
      last_error_code: null,
    });

    const persistedBytes = JSON.stringify({
      deliveries: harness.db.prepare('SELECT * FROM webhook_accepted_deliveries').all(),
      events: harness.db.prepare('SELECT * FROM webhook_accepted_events').all(),
      payloads: harness.db.prepare('SELECT * FROM webhook_decoded_payloads').all(),
      outbox: harness.db.prepare('SELECT * FROM webhook_event_outbox').all(),
    });
    expect(persistedBytes).not.toContain(body.toString());
    expect(persistedBytes).not.toContain('first');
    expect(persistedBytes).not.toContain('second');
    expect(persistedBytes).not.toContain('payload-only-in-ciphertext');
  });

  it('keeps known, unknown, disabled, retired, and adapter-less routes on the same dormant 404 floor', async () => {
    const harness = await makeHarness();
    const server = await startHarnessServer(harness);
    const dormant = await request(server.port);
    expect(dormant.status).toBe(404);
    expect(dormant.body.toString()).toBe('{"error":{"code":"not_found"}}');

    harness.runtime.start();
    const unknown = await request(server.port, {
      path: `/v1/webhooks/${'B'.repeat(32)}`,
    });
    harness.db.prepare(`
      UPDATE webhook_ingresses SET intake_state = 'disabled' WHERE ingress_id = ?
    `).run(harness.ingressId);
    const disabled = await request(server.port);
    harness.ingressStore.retire(harness.ingressId);
    const retired = await request(server.port);
    expect([unknown, disabled, retired].map((entry) => ({
      status: entry.status,
      body: entry.body.toString(),
    }))).toEqual([
      { status: 404, body: '{"error":{"code":"not_found"}}' },
      { status: 404, body: '{"error":{"code":"not_found"}}' },
      { status: 404, body: '{"error":{"code":"not_found"}}' },
    ]);
    expect(harness.db.prepare(`
      SELECT COUNT(*) FROM webhook_rejected_delivery_summaries
    `).pluck().get()).toBe(0);

    const adapterless = await makeHarness({ adapters: [] });
    const adapterlessServer = await startHarnessServer(adapterless);
    adapterless.runtime.start();
    expect((await request(adapterlessServer.port)).body.toString())
      .toBe('{"error":{"code":"not_found"}}');
  });

  it('closes every opaque route on the same pause response before id lookup', async () => {
    const harness = await makeHarness({ isPaused: () => true });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    const known = await request(server.port);
    const unknown = await request(server.port, {
      path: `/v1/webhooks/${'B'.repeat(32)}`,
    });
    expect([known, unknown].map((entry) => ({
      status: entry.status,
      body: entry.body.toString(),
    }))).toEqual([
      { status: 503, body: '{"error":{"code":"server_paused"}}' },
      { status: 503, body: '{"error":{"code":"server_paused"}}' },
    ]);
  });

  it('returns the generic floor when live public exposure is later removed', async () => {
    const harness = await makeHarness({ isIntakeReachable: async () => false });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    const known = await request(server.port);
    const unknown = await request(server.port, {
      path: `/v1/webhooks/${'B'.repeat(32)}`,
    });
    expect([known, unknown].map((entry) => ({
      status: entry.status,
      body: entry.body.toString(),
    }))).toEqual([
      { status: 404, body: '{"error":{"code":"not_found"}}' },
      { status: 404, body: '{"error":{"code":"not_found"}}' },
    ]);
  });

  it('closes a previously-confirmed ingress when its canonical endpoint changes', async () => {
    const harness = await makeHarness();
    harness.db.prepare(`
      UPDATE webhook_ingresses
      SET confirmed_endpoint_url = ?
      WHERE ingress_id = ?
    `).run(
      `https://old-hooks.example.test/v1/webhooks/${PUBLIC_ID}`,
      harness.ingressId,
    );
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    const known = await request(server.port);
    const unknown = await request(server.port, {
      path: `/v1/webhooks/${'B'.repeat(32)}`,
    });
    expect([known, unknown].map((entry) => ({
      status: entry.status,
      body: entry.body.toString(),
    }))).toEqual([
      { status: 404, body: '{"error":{"code":"not_found"}}' },
      { status: 404, body: '{"error":{"code":"not_found"}}' },
    ]);
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toEqual([]);
  });

  it('enforces method, media/encoding, and body bounds before invoking the adapter', async () => {
    let calls = 0;
    const harness = await makeHarness({
      globalMaxBodyBytes: 8,
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async (_raw, context) => {
          calls += 1;
          return defaultAcceptedResult(context);
        },
      },
    });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    expect((await request(server.port, { method: 'GET', body: Buffer.alloc(0) })).status)
      .toBe(405);
    expect((await request(server.port, {
      headers: { 'Content-Type': 'text/plain' },
    })).status).toBe(415);
    expect((await request(server.port, {
      headers: { 'Content-Encoding': 'gzip' },
    })).status).toBe(415);
    expect((await request(server.port, {
      body: Buffer.from('123456789'),
    })).status).toBe(413);
    expect(calls).toBe(0);
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toEqual([]);
    const rejections = harness.deliveryStore.listRejectedDeliveriesPage({
      ingress_id: harness.ingressId,
      limit: 10,
    }).rejections;
    expect(rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason_code: 'method_not_allowed',
        http_status: 405,
        recorded_attempt_count: 1,
      }),
      expect.objectContaining({
        reason_code: 'unsupported_media_type',
        http_status: 415,
        recorded_attempt_count: 2,
      }),
      expect.objectContaining({
        reason_code: 'payload_too_large',
        http_status: 413,
        recorded_attempt_count: 1,
      }),
    ]));
    const persisted = JSON.stringify(harness.db.prepare(`
      SELECT * FROM webhook_rejected_delivery_summaries
    `).all());
    expect(persisted).not.toContain('text/plain');
    expect(persisted).not.toContain('gzip');
    expect(persisted).not.toContain('123456789');
  });

  it('does not let rejection-ledger failure change the external admission decision', async () => {
    const harness = await makeHarness({
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async () => ({
          ok: false,
          failure: {
            disposition: 'reject',
            code: 'authentication_failed',
            response: { status: 401 },
          },
        }),
      },
    });
    harness.deliveryStore.recordRejectedDelivery = () => {
      throw new Error('rejection-ledger-offline');
    };
    const server = await startHarnessServer(harness);
    harness.runtime.start();

    const response = await request(server.port);
    expect(response).toMatchObject({ status: 401 });
    expect(response.body.toString()).toBe(
      '{"error":{"code":"authentication_failed"}}',
    );
    expect(harness.failures).toEqual(['authentication_failed']);
  });

  it('normalizes adapter throws/failures and rejects assurance or payload escape attempts', async () => {
    const throwing = await makeHarness({
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async () => {
          throw new Error('secret from adapter internals');
        },
      },
    });
    const throwingServer = await startHarnessServer(throwing);
    throwing.runtime.start();
    const thrown = await request(throwingServer.port);
    expect(thrown.status).toBe(503);
    expect(thrown.body.toString()).not.toContain('secret from adapter internals');
    expect(throwing.failures).toEqual(['profile_internal_error']);
    expect(throwing.ingressStore.get(throwing.ingressId)).toMatchObject({
      intake_state: 'degraded',
      last_error_code: 'profile_internal_error',
    });

    const timedOut = await makeHarness({
      profileTimeoutMs: 5,
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: () => new Promise<WebhookProfileResult>(() => {}),
      },
    });
    const timedOutServer = await startHarnessServer(timedOut);
    timedOut.runtime.start();
    expect((await request(timedOutServer.port)).status).toBe(503);
    expect(timedOut.failures).toEqual(['profile_dependency_unavailable']);
    expect(timedOut.deliveryStore.listDeliveries(timedOut.ingressId)).toEqual([]);
    expect(timedOut.deliveryStore.listRejectedDeliveriesPage({
      ingress_id: timedOut.ingressId,
      limit: 10,
    }).rejections).toEqual([]);
    expect(timedOut.ingressStore.get(timedOut.ingressId)).toMatchObject({
      intake_state: 'degraded',
      last_error_code: 'profile_dependency_unavailable',
    });

    const rejected = await makeHarness({
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async () => ({
          ok: false,
          failure: {
            disposition: 'reject',
            code: 'authentication_failed',
            response: { status: 401, body: 'vendor-specific rejection detail' },
          },
        }),
      },
    });
    const rejectedServer = await startHarnessServer(rejected);
    rejected.runtime.start();
    const rejectedSecret = 'rejected-body-and-header-must-never-persist';
    const rejection = await request(rejectedServer.port, {
      body: Buffer.from(JSON.stringify({ rejectedSecret })),
      headers: { 'X-Test-Signature': rejectedSecret },
    });
    expect(rejection.status).toBe(401);
    expect(rejection.body.toString()).toBe(
      '{"error":{"code":"authentication_failed"}}',
    );
    expect(rejection.body.toString()).not.toContain('vendor-specific');
    expect(rejected.failures).toEqual(['authentication_failed']);
    expect(rejected.ingressStore.get(rejected.ingressId)).toMatchObject({
      intake_state: 'enabled',
      last_error_code: null,
    });
    expect(rejected.deliveryStore.listRejectedDeliveriesPage({
      ingress_id: rejected.ingressId,
      limit: 10,
    }).rejections).toEqual([
      expect.objectContaining({
        reason_code: 'authentication_failed',
        http_status: 401,
        recorded_attempt_count: 1,
      }),
    ]);
    expect(JSON.stringify(rejected.db.prepare(`
      SELECT * FROM webhook_rejected_delivery_summaries
    `).all())).not.toContain(rejectedSecret);

    const malformed = await makeHarness({
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async (_raw, context) => {
          const result = defaultAcceptedResult(context);
          if (result.ok) {
            result.delivery.admission.transport_assurance = 'notification_only';
          }
          return result;
        },
      },
    });
    const malformedServer = await startHarnessServer(malformed);
    malformed.runtime.start();
    const bad = await request(malformedServer.port);
    expect(bad.status).toBe(503);
    expect(malformed.failures).toEqual(['profile_internal_error']);
    expect(malformed.deliveryStore.listDeliveries(malformed.ingressId)).toEqual([]);

    const responseInjection = await makeHarness({
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async (_raw, context) => {
          const result = defaultAcceptedResult(context);
          if (result.ok) result.delivery.response.body = 'decoded-input-controlled-body';
          return result;
        },
      },
    });
    const responseInjectionServer = await startHarnessServer(responseInjection);
    responseInjection.runtime.start();
    const injected = await request(responseInjectionServer.port);
    expect(injected.status).toBe(503);
    expect(injected.body.toString()).not.toContain('decoded-input-controlled-body');
    expect(responseInjection.deliveryStore.listDeliveries(responseInjection.ingressId))
      .toEqual([]);

    const unsafePayload = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
    const payloadEscape = await makeHarness({
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async (_raw, context) =>
          defaultAcceptedResult(context, { payload: unsafePayload }),
      },
    });
    const payloadEscapeServer = await startHarnessServer(payloadEscape);
    payloadEscape.runtime.start();
    expect((await request(payloadEscapeServer.port)).status).toBe(503);
    expect(payloadEscape.failures).toEqual(['profile_internal_error']);
    expect(payloadEscape.deliveryStore.listDeliveries(payloadEscape.ingressId)).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('degrades on a trusted unsupported-delivery fault and heals after durable admission', async () => {
    let unsupported = true;
    const harness = await makeHarness({
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async (_raw, context) => unsupported
          ? {
              ok: false,
              failure: {
                disposition: 'reject',
                code: 'unsupported_delivery',
                response: { status: 422 },
              },
            }
          : defaultAcceptedResult(context),
      },
    });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    expect((await request(server.port)).status).toBe(422);
    expect(harness.ingressStore.get(harness.ingressId)).toMatchObject({
      intake_state: 'degraded',
      last_error_code: 'unsupported_delivery',
    });

    unsupported = false;
    expect((await request(server.port)).status).toBe(202);
    expect(harness.ingressStore.get(harness.ingressId)).toMatchObject({
      intake_state: 'enabled',
      last_error_code: null,
      last_delivery_at: expect.any(Number),
    });
  });

  it('re-verifies duplicate HTTP deliveries but creates one durable event/outbox', async () => {
    let calls = 0;
    const harness = await makeHarness({
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async (_raw, context) => {
          calls += 1;
          return defaultAcceptedResult(context);
        },
      },
    });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    const first = await request(server.port);
    harness.setPayloadUnlocked(false);
    const second = await request(server.port);
    expect([first.status, second.status]).toEqual([202, 202]);
    expect([first.body.toString(), second.body.toString()])
      .toEqual(['profile-accepted', 'profile-accepted']);
    expect(calls).toBe(2);
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toHaveLength(1);
    expect(harness.deliveryStore.listEvents(harness.ingressId)).toHaveLength(1);
    expect(harness.deliveryStore.listOutbox()).toHaveLength(1);
  });

  it('serves repeatable authenticated handshakes without creating delivery work', async () => {
    let verifyCalls = 0;
    const adapter: WebhookIngressProfileAdapter = {
      profile_id: 'slack.request.v0',
      success_response: TEST_SUCCESS_RESPONSE,
      handleHandshake: async (raw, context) => {
        const body = JSON.parse(raw.raw_body.toString()) as { challenge?: string };
        if (typeof body.challenge !== 'string') return null;
        return {
          response: {
            status: 200,
            content_type: 'text/plain',
            body: body.challenge,
          },
          readiness_proven: true,
          admission: {
            transport_assurance: 'authenticated',
            credential_version: context.credential_versions[0]?.version ?? null,
            freshness_checked: true,
            method_label: 'slack-handshake-test',
          },
        };
      },
      verifyAndDecode: async (_raw, context) => {
        verifyCalls += 1;
        return defaultAcceptedResult(context, { eventType: 'event_callback' });
      },
    };
    const harness = await makeHarness({
      profileId: 'slack.request.v0',
      intakeState: 'verification_pending',
      adapter,
    });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    for (let index = 0; index < 2; index += 1) {
      const response = await request(server.port, {
        body: Buffer.from('{"challenge":"challenge-replay"}'),
      });
      expect(response.status).toBe(200);
      expect(response.body.toString()).toBe('challenge-replay');
    }
    harness.db.prepare(`
      UPDATE webhook_ingresses SET last_error_code = ? WHERE ingress_id = ?
    `).run(WEBHOOK_PAIRED_CONNECTION_DELETED, harness.ingressId);
    const latched = await request(server.port, {
      body: Buffer.from('{"challenge":"must-stay-closed"}'),
    });
    expect(latched.status).toBe(404);
    expect(latched.body.toString()).toBe('{"error":{"code":"not_found"}}');
    const ordinary = await request(server.port, {
      body: Buffer.from('{"type":"event_callback"}'),
    });
    expect(ordinary.status).toBe(404);
    expect(verifyCalls).toBe(0);
    expect(harness.handshakes).toEqual([harness.ingressId, harness.ingressId]);
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toEqual([]);
    expect(harness.deliveryStore.listOutbox()).toEqual([]);
    expect(harness.deliveryStore.listRejectedDeliveriesPage({
      ingress_id: harness.ingressId,
      limit: 10,
    }).rejections).toEqual([]);
  });

  it('classifies a handshake dependency outage as retryable profile unavailability', async () => {
    const harness = await makeHarness({
      profileId: 'slack.request.v0',
      intakeState: 'verification_pending',
      adapter: {
        profile_id: 'slack.request.v0',
        success_response: TEST_SUCCESS_RESPONSE,
        handleHandshake: async () => {
          throw new WebhookProfileDependencyUnavailableError();
        },
        verifyAndDecode: async (_raw, context) => defaultAcceptedResult(
          context,
          { eventType: 'event_callback' },
        ),
      },
    });
    const server = await startHarnessServer(harness);
    harness.runtime.start();

    const response = await request(server.port, {
      body: Buffer.from('{"type":"url_verification","challenge":"retry"}'),
    });
    expect(response.status).toBe(503);
    expect(response.body.toString()).toBe('{"error":{"code":"profile_unavailable"}}');
    expect(harness.failures).toEqual(['profile_dependency_unavailable']);
    expect(harness.handshakes).toEqual([]);
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toEqual([]);
  });

  it('does not complete a handshake after its matched credential is retired', async () => {
    let release!: () => void;
    let started!: () => void;
    const handshakeStarted = new Promise<void>((resolve) => { started = resolve; });
    const handshakeRelease = new Promise<void>((resolve) => { release = resolve; });
    const adapter: WebhookIngressProfileAdapter = {
      profile_id: 'slack.request.v0',
      success_response: TEST_SUCCESS_RESPONSE,
      handleHandshake: async (_raw, context) => {
        started();
        await handshakeRelease;
        return {
          response: { status: 200, body: 'challenge-race' },
          readiness_proven: true,
          admission: {
            transport_assurance: 'authenticated',
            credential_version: context.credential_versions[0]?.version ?? null,
            freshness_checked: true,
            method_label: 'slack-handshake-race',
          },
        };
      },
      verifyAndDecode: async (_raw, context) =>
        defaultAcceptedResult(context, { eventType: 'event_callback' }),
    };
    const harness = await makeHarness({
      profileId: 'slack.request.v0',
      intakeState: 'verification_pending',
      adapter,
    });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    const pending = request(server.port, {
      body: Buffer.from('{"challenge":"challenge-race"}'),
    });
    await handshakeStarted;
    await harness.ingressStore.writeCredentialVersion(harness.ingressId, {
      signing_secret: 'rotated-slack-fixture-secret',
    });
    harness.ingressStore.retireCredentialVersion(harness.ingressId, 1);
    release();

    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.body.toString()).toBe(
      '{"error":{"code":"profile_unavailable"}}',
    );
    expect(harness.handshakes).toEqual([]);
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toEqual([]);
  });

  it('returns generic not-found when retirement wins an async verification race', async () => {
    let release!: () => void;
    let started!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { started = resolve; });
    const verificationRelease = new Promise<void>((resolve) => { release = resolve; });
    const harness = await makeHarness({
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async (_raw, context) => {
          started();
          await verificationRelease;
          return defaultAcceptedResult(context);
        },
      },
    });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    const pending = request(server.port);
    await verificationStarted;
    harness.ingressStore.retire(harness.ingressId);
    release();
    const response = await pending;
    expect(response.status).toBe(404);
    expect(response.body.toString()).toBe('{"error":{"code":"not_found"}}');
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toEqual([]);
  });

  it('returns generic not-found when a connection-deletion latch wins verification', async () => {
    let release!: () => void;
    let started!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { started = resolve; });
    const verificationRelease = new Promise<void>((resolve) => { release = resolve; });
    const harness = await makeHarness({
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async (_raw, context) => {
          started();
          await verificationRelease;
          return defaultAcceptedResult(context);
        },
      },
    });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    const pending = request(server.port);
    await verificationStarted;
    harness.db.prepare(`
      UPDATE webhook_ingresses SET last_error_code = ? WHERE ingress_id = ?
    `).run(WEBHOOK_PAIRED_CONNECTION_DELETED, harness.ingressId);
    release();

    const response = await pending;
    expect(response.status).toBe(404);
    expect(response.body.toString()).toBe('{"error":{"code":"not_found"}}');
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toEqual([]);
    expect(harness.deliveryStore.listOutbox()).toEqual([]);
  });

  it('keeps the generic not-found floor when retirement wins an adapter failure', async () => {
    let release!: () => void;
    let started!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { started = resolve; });
    const verificationRelease = new Promise<void>((resolve) => { release = resolve; });
    const harness = await makeHarness({
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async () => {
          started();
          await verificationRelease;
          throw new Error('adapter-failed-after-retirement');
        },
      },
    });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    const pending = request(server.port);
    await verificationStarted;
    harness.ingressStore.retire(harness.ingressId);
    release();

    const response = await pending;
    expect(response.status).toBe(404);
    expect(response.body.toString()).toBe('{"error":{"code":"not_found"}}');
    expect(harness.failures).toEqual([]);
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toEqual([]);
  });

  it('does not commit a delivery after its matched credential is retired', async () => {
    let release!: () => void;
    let started!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { started = resolve; });
    const verificationRelease = new Promise<void>((resolve) => { release = resolve; });
    const harness = await makeHarness({
      adapter: {
        profile_id: 'generic.static-header-token.v1',
        success_response: TEST_SUCCESS_RESPONSE,
        verifyAndDecode: async (_raw, context) => {
          started();
          await verificationRelease;
          return defaultAcceptedResult(context);
        },
      },
    });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    const pending = request(server.port);
    await verificationStarted;
    await harness.ingressStore.writeCredentialVersion(harness.ingressId, {
      header_name: 'x-test-token',
      header_token: 'rotated-fixture-secret-token',
    });
    // This test targets the accept-time active-version race, not the separate
    // live-rotation proof gate. Model a replacement that verified elsewhere so
    // retirement of the in-flight version is an admitted transition.
    harness.db.prepare(`
      UPDATE webhook_credential_versions
      SET last_verified_at = 1
      WHERE ingress_id = ? AND version = 2
    `).run(harness.ingressId);
    harness.ingressStore.retireCredentialVersion(harness.ingressId, 1);
    release();

    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.body.toString()).toBe(
      '{"error":{"code":"temporarily_unavailable"}}',
    );
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toEqual([]);
    expect(harness.deliveryStore.listOutbox()).toEqual([]);
  });

  it('never acknowledges an injected transaction crash', async () => {
    const harness = await makeHarness({
      beforeAcceptCommit: () => { throw new Error('crash-before-commit'); },
    });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    const response = await request(server.port);
    expect(response.status).toBe(503);
    expect(response.body.toString()).toBe(
      '{"error":{"code":"temporarily_unavailable"}}',
    );
    expect(harness.deliveryStore.listDeliveries(harness.ingressId)).toEqual([]);
    expect(harness.deliveryStore.listEvents(harness.ingressId)).toEqual([]);
    expect(harness.deliveryStore.listOutbox()).toEqual([]);
  });

  it('admits a Slice 3 primitive through the exact-byte durable kernel', async () => {
    const adapter = createPrimitiveWebhookProfileRuntimeRegistry()
      .get('generic.static-header-token.v1')!;
    const harness = await makeHarness({
      adapter,
      credentials: {
        header_name: 'X-Primitive-Token',
        header_token: 'primitive-fixture-token',
      },
    });
    const server = await startHarnessServer(harness);
    harness.runtime.start();
    const response = await request(server.port, {
      headers: { 'X-Primitive-Token': 'primitive-fixture-token' },
      body: Buffer.from('{"slice":3,"admitted":true}'),
    });

    expect(response.status).toBe(202);
    expect(response.body.byteLength).toBe(0);
    const events = harness.deliveryStore.listEvents(harness.ingressId);
    expect(events).toEqual([
      expect.objectContaining({
        provider_event_type: 'delivery',
        selected_for_dispatch: true,
        dispatch_state: 'pending',
      }),
    ]);
    await expect(harness.deliveryStore.readEventPayload(events[0]!.event_id))
      .resolves.toEqual({ slice: 3, admitted: true });
  });
});
