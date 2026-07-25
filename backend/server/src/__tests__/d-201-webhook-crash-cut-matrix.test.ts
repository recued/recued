import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../server.js';
import {
  createWebhookDeliveryStore,
  type WebhookDeliveryStore,
} from '../storage/webhook-delivery-store.js';
import {
  createWebhookIngressStore,
} from '../storage/webhook-ingress-store.js';
import {
  createWebhookOutboxRuntime,
  type WebhookOutboxRuntime,
} from '../webhook-outbox-dispatcher.js';
import {
  createWebhookProfileListener,
} from '../webhook-profile-listener.js';
import {
  createWebhookProfileRuntimeRegistry,
  type WebhookIngressProfileAdapter,
} from '../webhook-profile-runtime.js';

const SECRET_KEY = new Uint8Array(32).fill(83);
const PAYLOAD_KEY = new Uint8Array(32).fill(97);
const NOW_MS = 2_200_000_000_000;
const PUBLIC_ID = 'C'.repeat(32);
const INGRESS_ID = 'whi_cccccccccccccccccccccccccccccccc';
const SUCCESS_RESPONSE = Object.freeze({
  status: 202,
  content_type: 'text/plain',
  body: 'accepted-after-crash-cut',
});
const RETRY_RESPONSE = '{"error":{"code":"temporarily_unavailable"}}';
const RESTART_ONLY_RESPONSE = 'must-not-replace-persisted-response';

interface HttpResponse {
  status: number;
  body: string;
}

interface DurableCounts {
  deliveries: number;
  events: number;
  payloads: number;
  outbox: number;
}

interface CrashCutPhase {
  db: Database.Database;
  deliveryStore: WebhookDeliveryStore;
  runtime: WebhookOutboxRuntime;
  server: RunningServer;
  sinkEventIds: string[];
  close(): Promise<void>;
}

type CrashCut =
  | 'between_delivery_and_outbox'
  | 'after_commit_before_ack';

const phases: CrashCutPhase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (phases.length > 0) await phases.pop()!.close();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const request = (port: number): Promise<HttpResponse> => new Promise(
  (resolve, reject) => {
    const body = Buffer.from('{"slice":"9BN"}', 'utf8');
    const outgoing = http.request({
      host: '127.0.0.1',
      port,
      path: `/v1/webhooks/${PUBLIC_ID}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.byteLength,
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  },
);

const countTable = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;

const durableCounts = (db: Database.Database): DurableCounts => ({
  deliveries: countTable(db, 'webhook_accepted_deliveries'),
  events: countTable(db, 'webhook_accepted_events'),
  payloads: countTable(db, 'webhook_decoded_payloads'),
  outbox: countTable(db, 'webhook_event_outbox'),
});

const newDatabasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'recued-d201-9bn-'));
  temporaryDirectories.push(directory);
  return join(directory, 'webhook-crash-cuts.sqlite');
};

const profileAdapter = (responseBody: string): WebhookIngressProfileAdapter => {
  const response = Object.freeze({
    ...SUCCESS_RESPONSE,
    body: responseBody,
  });
  return {
    profile_id: 'generic.static-header-token.v1',
    success_response: response,
    async verifyAndDecode(_request, context) {
      return {
        ok: true,
        delivery: {
          delivery_dedup_key: 'delivery-crash-cut-1',
          decoded_content_type: 'application/json',
          events: [{
            event_dedup_key: 'event-crash-cut-1',
            provider_event_id: 'event-crash-cut-1',
            provider_resource_id: null,
            provider_event_type: 'delivery',
            provider_occurred_at: null,
            decoded_payload: { slice: '9BN', durable: true },
          }],
          response,
          admission: {
            transport_assurance: 'authenticated',
            credential_version: context.credential_versions[0]?.version ?? null,
            freshness_checked: false,
            method_label: 'crash-cut-fixture',
          },
        },
      };
    },
  };
};

const openPhase = async (input: {
  databasePath: string;
  initialize?: boolean;
  crashCut?: CrashCut;
  idFill?: string;
  profileResponseBody?: string;
}): Promise<CrashCutPhase> => {
  const db = new Database(input.databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  const ingressStore = createWebhookIngressStore(db, {
    now: () => NOW_MS,
    getEncryptionKey: () => SECRET_KEY,
    newIngressId: () => INGRESS_ID,
    newPublicId: () => PUBLIC_ID,
    newCredentialSetRef: () => 'whc_cccccccccccccccccccccccccccccccc',
  });
  if (input.initialize) {
    const ingress = ingressStore.create({
      display_name: 'Crash-cut matrix fixture',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    });
    await ingressStore.writeCredentialVersion(ingress.ingress_id, {
      header_name: 'x-crash-cut-token',
      header_token: 'crash-cut-secret',
    });
    db.prepare(`
      UPDATE webhook_ingresses SET
        intake_state = 'enabled', registration_state = 'registered',
        confirmed_endpoint_url = ?, enabled_at = ?
      WHERE ingress_id = ?
    `).run(
      `https://hooks.example.test/v1/webhooks/${PUBLIC_ID}`,
      NOW_MS,
      INGRESS_ID,
    );
  } else if (ingressStore.get(INGRESS_ID) === null) {
    throw new Error('D-201 crash-cut restart lost its ingress');
  }

  const idFill = input.idFill ?? 'd';
  if (!/^[a-z]$/.test(idFill)) {
    throw new Error('D-201 crash-cut id fill is invalid');
  }
  const deliveryStore = createWebhookDeliveryStore(db, {
    now: () => NOW_MS,
    getEncryptionKey: () => PAYLOAD_KEY,
    newDeliveryId: () => `whd_${idFill.repeat(32)}`,
    newEventId: () => `whe_${idFill.repeat(32)}`,
    newPayloadRef: () => `whp_${idFill.repeat(32)}`,
    newOutboxId: () => `who_${idFill.repeat(32)}`,
    hasDispatchTarget: () => true,
  });
  if (input.crashCut === 'between_delivery_and_outbox') {
    db.exec(`
      CREATE TEMP TRIGGER d201_9bn_crash_before_outbox
      BEFORE INSERT ON webhook_event_outbox
      BEGIN
        SELECT RAISE(ABORT, 'd201_9bn_crash_before_outbox');
      END;
    `);
  }

  let listenerStore = deliveryStore;
  if (input.crashCut === 'after_commit_before_ack') {
    listenerStore = {
      ...deliveryStore,
      async accept(acceptedInput) {
        await deliveryStore.accept(acceptedInput);
        throw new Error('d201_9bn_crash_after_commit_before_ack');
      },
    };
  }

  const sinkEventIds: string[] = [];
  const runtime = createWebhookOutboxRuntime(deliveryStore, {
    dispatch: async (dispatch) => {
      sinkEventIds.push(dispatch.idempotency_key);
    },
  }, {
    poll_interval_ms: 60_000,
  });
  runtime.start();
  const listener = createWebhookProfileListener({
    ingressStore,
    deliveryStore: listenerStore,
    profiles: createWebhookProfileRuntimeRegistry([
      profileAdapter(input.profileResponseBody ?? SUCCESS_RESPONSE.body),
    ]),
    isOutboxDispatcherStarted: runtime.isStarted,
    resolveCanonicalPublicUrl: ({ raw_path_and_query }) =>
      `https://hooks.example.test${raw_path_and_query}`,
    now: () => NOW_MS,
  });
  const server = await startServer(0, { webhookProfileListener: listener });
  let closed = false;
  const phase: CrashCutPhase = {
    db,
    deliveryStore,
    runtime,
    server,
    sinkEventIds,
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      await runtime.stop();
      db.close();
    },
  };
  phases.push(phase);
  return phase;
};

const expectOnePendingEvent = (
  phase: CrashCutPhase,
): string => {
  expect(durableCounts(phase.db)).toEqual({
    deliveries: 1,
    events: 1,
    payloads: 1,
    outbox: 1,
  });
  const events = phase.deliveryStore.listEvents(INGRESS_ID);
  expect(events).toEqual([
    expect.objectContaining({
      selected_for_dispatch: true,
      dispatch_state: 'pending',
    }),
  ]);
  expect(phase.deliveryStore.listOutbox()).toEqual([
    expect.objectContaining({ state: 'pending', attempt_count: 0 }),
  ]);
  expect(phase.sinkEventIds).toEqual([]);
  return events[0]!.event_id;
};

const dispatchAfterRestart = async (
  phase: CrashCutPhase,
  eventId: string,
): Promise<void> => {
  await expect(phase.runtime.drainOnce()).resolves.toMatchObject({
    claimed: 1,
    dispatched: 1,
    retried: 0,
    dead_lettered: 0,
  });
  expect(phase.sinkEventIds).toEqual([eventId]);
  expect(phase.deliveryStore.getEvent(eventId))
    .toMatchObject({ dispatch_state: 'dispatched' });
  expect(phase.deliveryStore.listOutbox())
    .toEqual([expect.objectContaining({ state: 'dispatched' })]);
  await expect(phase.runtime.drainOnce()).resolves.toEqual({
    claimed: 0,
    dispatched: 0,
    retried: 0,
    dead_lettered: 0,
  });
  expect(phase.sinkEventIds).toEqual([eventId]);
};

describe('D-201 Slice 9BN exact crash-cut restart matrix', () => {
  it('rolls back a cut between delivery and outbox writes, then admits after restart', async () => {
    const databasePath = newDatabasePath();
    const crashed = await openPhase({
      databasePath,
      initialize: true,
      crashCut: 'between_delivery_and_outbox',
    });

    await expect(request(crashed.server.port)).resolves.toEqual({
      status: 503,
      body: RETRY_RESPONSE,
    });
    expect(durableCounts(crashed.db)).toEqual({
      deliveries: 0,
      events: 0,
      payloads: 0,
      outbox: 0,
    });
    await crashed.close();

    const restarted = await openPhase({ databasePath, idFill: 'r' });
    expect(restarted.db.pragma('integrity_check', { simple: true })).toBe('ok');
    await expect(request(restarted.server.port)).resolves.toEqual({
      status: 202,
      body: SUCCESS_RESPONSE.body,
    });
    const eventId = expectOnePendingEvent(restarted);
    await dispatchAfterRestart(restarted, eventId);
  });

  it('keeps the commit when failure wins before acknowledgement, then deduplicates retry', async () => {
    const databasePath = newDatabasePath();
    const crashed = await openPhase({
      databasePath,
      initialize: true,
      crashCut: 'after_commit_before_ack',
    });

    await expect(request(crashed.server.port)).resolves.toEqual({
      status: 503,
      body: RETRY_RESPONSE,
    });
    const eventId = expectOnePendingEvent(crashed);
    await crashed.close();

    const restarted = await openPhase({
      databasePath,
      idFill: 'r',
      profileResponseBody: RESTART_ONLY_RESPONSE,
    });
    expect(restarted.db.pragma('integrity_check', { simple: true })).toBe('ok');
    await expect(request(restarted.server.port)).resolves.toEqual({
      status: 202,
      body: SUCCESS_RESPONSE.body,
    });
    expect(expectOnePendingEvent(restarted)).toBe(eventId);
    await dispatchAfterRestart(restarted, eventId);
  });

  it('recovers acknowledged pending work before any internal dispatch', async () => {
    const databasePath = newDatabasePath();
    const acknowledged = await openPhase({
      databasePath,
      initialize: true,
    });

    await expect(request(acknowledged.server.port)).resolves.toEqual({
      status: 202,
      body: SUCCESS_RESPONSE.body,
    });
    const eventId = expectOnePendingEvent(acknowledged);
    await acknowledged.close();

    const restarted = await openPhase({ databasePath, idFill: 'r' });
    expect(restarted.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(expectOnePendingEvent(restarted)).toBe(eventId);
    await dispatchAfterRestart(restarted, eventId);
    expect(durableCounts(restarted.db)).toEqual({
      deliveries: 1,
      events: 1,
      payloads: 1,
      outbox: 1,
    });
  });
});
