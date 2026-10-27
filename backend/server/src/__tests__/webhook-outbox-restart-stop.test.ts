/** Webhook outbox — what a restart drain needs from the outbox runtime.
 *
 *  `stop()` used to wait for the active pass plus every recipe run still going,
 *  and until then the runtime kept claiming work every second, because its gate
 *  checked only the vault and the pause. During a drain each such claim spends
 *  one of the event's attempts on a run the server refuses. These pin that a
 *  stopping server claims nothing, that a stopping pass dispatches nothing
 *  more, that `stop()` returns within `STOP_GRACE_MS` while a dispatch never
 *  finishes, and that a dispatch the server refused (`draining`) is handed back
 *  — pending, its attempt given back, never marked failed — so the next boot
 *  dispatches it at once and no number of restarts dead-letters it. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '@recued/contracts';

import {
  createWebhookDeliveryStore,
  type WebhookAcceptedDeliveryInput,
  type WebhookDeliveryStore,
} from '../storage/webhook-delivery-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { createWebhookOutboxRuntime } from '../webhook-outbox-dispatcher.js';
import { STOP_GRACE_MS } from '../lifecycle/settle-within.js';

const SECRET_KEY = new Uint8Array(32).fill(31);
const PAYLOAD_KEY = new Uint8Array(32).fill(47);
const LEASE_MS = 30_000;

const databases: Database.Database[] = [];
afterEach(() => {
  vi.useRealTimers();
  while (databases.length > 0) databases.pop()!.close();
});

/** The real ingress + delivery stores over one database, with an ingress
 *  enabled for `delivery` events (the D-201 delivery-store suite's harness). */
const harness = async () => {
  const db = new Database(':memory:');
  databases.push(db);
  let stamp = 2_000_000_000_000;
  let seq = 0;
  const next = (prefix: string): string => `${prefix}_${String(++seq).padStart(32, '0')}`;
  const ingressStore = createWebhookIngressStore(db, {
    now: () => stamp,
    getEncryptionKey: () => SECRET_KEY,
    newIngressId: () => next('whi'),
    newPublicId: () => `opaquePublicId_${String(seq).padStart(16, '0')}`,
    newCredentialSetRef: () => next('whc'),
  });
  const ingress = ingressStore.create({
    display_name: 'Restart drain test',
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
  let claims = 0;
  const deliveryStore = createWebhookDeliveryStore(db, {
    now: () => stamp,
    getEncryptionKey: () => PAYLOAD_KEY,
    newDeliveryId: () => next('whd'),
    newEventId: () => next('whe'),
    newPayloadRef: () => next('whp'),
    newOutboxId: () => next('who'),
    newClaimToken: () => `claim-${++claims}`,
    newRejectionId: () => next('whr'),
    hasDispatchTarget: (_ingressId, eventType) => eventType === 'delivery',
  });
  const accept = async (key: string): Promise<void> => {
    const input: WebhookAcceptedDeliveryInput = {
      ingress_id: ingress.ingress_id,
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      received_at: stamp,
      delivery_dedup_key: `delivery-${key}`,
      raw_body_sha256: 'a'.repeat(64),
      decoded_content_type: 'application/json',
      decoded_schema_id: 'generic.delivery.v1',
      transport_assurance: 'authenticated',
      minimum_source_truth_policy: 'delivery_payload_allowed',
      credential_version: '1',
      admission_method: 'test-static-token',
      freshness_checked: false,
      response: { status: 202, content_type: 'text/plain', body: 'accepted-once' },
      events: [{
        event_dedup_key: `event-${key}`,
        provider_event_id: `event-${key}`,
        provider_resource_id: null,
        provider_event_type: 'delivery',
        provider_occurred_at: null,
        decoded_payload_json: JSON.stringify({ safe: true }),
      }],
    };
    await deliveryStore.accept(input);
  };
  return {
    deliveryStore,
    accept,
    advance: (ms: number) => { stamp += ms; },
  };
};

const rows = (store: WebhookDeliveryStore) =>
  store.listOutbox().map((row) => ({ state: row.state, attempt_count: row.attempt_count, last_error_code: row.last_error_code }));

describe('webhook outbox during a restart drain', () => {
  it('stop() returns within the grace while a dispatch never finishes; the pass dispatches nothing more', async () => {
    const h = await harness();
    await h.accept('1');
    await h.accept('2');
    vi.useFakeTimers();
    let release!: () => void;
    const hung = new Promise<void>((resolve) => { release = resolve; });
    const dispatched: string[] = [];
    const runtime = createWebhookOutboxRuntime(h.deliveryStore, {
      dispatch: async (input) => {
        dispatched.push(input.idempotency_key);
        if (dispatched.length === 1) await hung;
      },
    }, { lease_ms: LEASE_MS, dispatch_timeout_ms: LEASE_MS });

    const pass = runtime.drainOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatched).toHaveLength(1);

    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);

    // The hung run ends after the stop: the pass records it and goes no further.
    release();
    await expect(pass).resolves.toMatchObject({ claimed: 2, dispatched: 1, retried: 0, dead_lettered: 0 });
    expect(dispatched).toHaveLength(1);
    // The one it never reached is handed back, its attempt given back.
    expect(rows(h.deliveryStore)).toEqual(expect.arrayContaining([
      { state: 'dispatched', attempt_count: 1, last_error_code: null },
      { state: 'pending', attempt_count: 0, last_error_code: null },
    ]));
  });

  it('while the server is stopping a pass claims nothing and reconciles nothing', async () => {
    const h = await harness();
    await h.accept('1');
    const dispatch = vi.fn(async () => {});
    const reconcileWaitingDispatches = vi.fn(async () => {});
    let isStopping = true;
    const runtime = createWebhookOutboxRuntime(h.deliveryStore, { dispatch }, {
      isStopping: () => isStopping,
      reconcileWaitingDispatches,
    });
    await expect(runtime.drainOnce()).resolves.toEqual({ claimed: 0, dispatched: 0, retried: 0, dead_lettered: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(reconcileWaitingDispatches).not.toHaveBeenCalled();
    expect(rows(h.deliveryStore)).toEqual([{ state: 'pending', attempt_count: 0, last_error_code: null }]);

    // The permitting case: the same runtime dispatches once not stopping.
    isStopping = false;
    await expect(runtime.drainOnce()).resolves.toMatchObject({ claimed: 1, dispatched: 1 });
    await runtime.stop();
  });

  it('a dispatch the draining server refused is handed back, not failed, and the next boot delivers it at once', async () => {
    const h = await harness();
    await h.accept('1');
    await h.accept('2');
    const refusing = createWebhookOutboxRuntime(h.deliveryStore, {
      dispatch: async () => {
        throw new RpcError('draining', 'The server is restarting; try again in a moment.', 503);
      },
    }, { lease_ms: LEASE_MS });

    // Neither claim is marked failed or spends an attempt: the first was
    // refused, and the second is not even attempted — the server refuses every
    // run while it drains.
    await expect(refusing.drainOnce()).resolves.toEqual({ claimed: 2, dispatched: 0, retried: 0, dead_lettered: 0 });
    expect(rows(h.deliveryStore)).toEqual([
      { state: 'pending', attempt_count: 0, last_error_code: null },
      { state: 'pending', attempt_count: 0, last_error_code: null },
    ]);
    await refusing.stop();

    // The next boot delivers both, with no lease to wait out.
    const delivered: string[] = [];
    const next = createWebhookOutboxRuntime(h.deliveryStore, {
      dispatch: async (input) => { delivered.push(input.idempotency_key); },
    }, { lease_ms: LEASE_MS });
    await expect(next.drainOnce()).resolves.toMatchObject({ claimed: 2, dispatched: 2 });
    expect(delivered).toHaveLength(2);
    expect(rows(h.deliveryStore).map((row) => row.state)).toEqual(['dispatched', 'dispatched']);
    await next.stop();
  });

  // Each refused claim used to keep the attempt it counted, so the eighth
  // restart at the wrong moment dead-lettered an event that never once ran.
  it('dead-letters nothing however many restarts refuse it', async () => {
    const h = await harness();
    await h.accept('1');
    for (let restart = 0; restart < 10; restart += 1) {
      const refusing = createWebhookOutboxRuntime(h.deliveryStore, {
        dispatch: async () => {
          throw new RpcError('draining', 'The server is restarting; try again in a moment.', 503);
        },
      }, { lease_ms: LEASE_MS });
      await expect(refusing.drainOnce()).resolves.toMatchObject({ dispatched: 0, dead_lettered: 0 });
      await refusing.stop();
      h.advance(LEASE_MS + 1);
    }
    const delivered: string[] = [];
    const next = createWebhookOutboxRuntime(h.deliveryStore, {
      dispatch: async (input) => { delivered.push(input.idempotency_key); },
    }, { lease_ms: LEASE_MS });
    await expect(next.drainOnce()).resolves.toMatchObject({ claimed: 1, dispatched: 1, dead_lettered: 0 });
    expect(delivered).toHaveLength(1);
    await next.stop();
  });
});
