/** D-201 Slice 10A — the recipe-dispatch worker, on the real stores.
 *
 * The post-9BQ audit failed Gates 7 and 15: the event outbox awaited every
 * recipe inside its 10-second timeout, so a longer run was retried while it
 * still ran, its claim was taken over, and eight timeouts dead-lettered an event
 * whose run then succeeded. The outbox now hands the event off (target rows) and
 * the worker runs each target under a lease its heartbeat renews. These are the
 * late-settlement cuts §14.1 names: a run past 10 s and past the former ~207 s
 * schedule, a lapsed claim followed by a late success, a restart while the run
 * is ambiguous, and siblings of different durations; plus the retry, refusal,
 * dead-letter, capacity and migration rules the worker brings.
 *
 * The production-composed proof (the real door, gate, runner and
 * `handleExecute`) is `home-assistant-camera-alert-pushed-run.test.ts`'s slow
 * camera. Here the runner is a hand-settled stand-in, so the clock can run for
 * minutes. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RpcError,
  type PackWebhookRequirement,
  type RecipeDefinition,
} from '@recued/contracts';
import type { AuditEntry } from '@recued/storage';
import { createRecipeStore } from '../recipe-store.js';
import { createWebhookConsumerStore } from '../storage/webhook-consumer-store.js';
import {
  createWebhookDeliveryStore,
  type WebhookAcceptedDeliveryInput,
} from '../storage/webhook-delivery-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import {
  createWebhookRecipeOutboxSink,
  WebhookRunNotRestartedError,
  type WebhookRecipeRunner,
  type WebhookRecipeRunRequest,
  type WebhookRecipeRunResult,
} from '../webhook-recipe-consumer.js';
import { heldRunReconcileOptions, reconcileWebhookAwaitingApprovalDispatches } from '../webhook-recipe-runner.js';
import { OWNER_DOOR_CLOSE_REASON } from '../mint-door-contract.js';
import { dispatchWebhookOutboxOnce } from '../webhook-outbox-dispatcher.js';
import {
  WEBHOOK_DISPATCH_LEASE_MS,
  WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS,
  createWebhookRecipeDeliveryRuntime,
  createWebhookRecipeDispatchRuntime,
} from '../webhook-recipe-dispatch-worker.js';

const T0 = 2_100_000_000_000;
const PACK_SLUG = 'dispatch-worker-pack';
const PUBLISHER = 'fixture-publisher';
const PROFILE = 'generic.static-header-token.v1';

const requirement: PackWebhookRequirement = {
  binding: 'generic_delivery',
  profile_ids: [PROFILE],
  required_event_types: ['delivery'],
  registration_modes: ['manual'],
  environment_policy: 'test_only',
  decoded_payload_access: 'scoped_read',
  source_truth_policy: 'delivery_payload_allowed',
};

const recipe = (recipeId: string): RecipeDefinition => ({
  recipe_id: recipeId,
  version: 1,
  ttl: 60,
  metadata: {
    name: recipeId,
    description: 'D-201 Slice 10A fixture',
    author: PUBLISHER,
    supported_platforms: [],
    tags: [],
    recipe_bundle: `${PUBLISHER}/${PACK_SLUG}`,
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  webhook_triggers: [{ binding: 'generic_delivery', event_types: ['delivery'] }],
});

const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  vi.useFakeTimers({
    now: T0 - 1_000,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});
afterEach(async () => {
  // Real timers first: a stop waits on a timer, and fake ones would never fire.
  vi.useRealTimers();
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** The three stores a server process opens over its database. */
const openStores = (
  db: Database.Database,
  options: { maxOutboxBacklog?: number; payloadRetentionMs?: number } = {},
) => {
  const ingressStore = createWebhookIngressStore(db, {
    now: () => Date.now(),
    getEncryptionKey: () => new Uint8Array(32).fill(71),
  });
  const consumerStore = createWebhookConsumerStore(db, {
    ingressStore,
    now: () => Date.now(),
  });
  const deliveryStore = createWebhookDeliveryStore(db, {
    now: () => Date.now(),
    getEncryptionKey: () => new Uint8Array(32).fill(83),
    hasDispatchTarget: (ingressId, eventType) =>
      consumerStore.hasDispatchTarget(ingressId, eventType),
    countActiveConsumerWork: () => consumerStore.countActiveDispatchEvents(),
    ...(options.maxOutboxBacklog !== undefined
      ? { maxOutboxBacklog: options.maxOutboxBacklog }
      : {}),
    ...(options.payloadRetentionMs !== undefined
      ? { payloadRetentionMs: options.payloadRetentionMs, dedupRetentionMs: 100 }
      : {}),
  });
  return { ingressStore, consumerStore, deliveryStore };
};

const makeHarness = async (input: {
  db?: Database.Database;
  recipeIds?: readonly string[];
  maxOutboxBacklog?: number;
  payloadRetentionMs?: number;
} = {}) => {
  const db = input.db ?? new Database(':memory:');
  if (!input.db) cleanups.push(() => { db.close(); });
  const stores = openStores(db, input);
  const recipeStore = createRecipeStore('/path/that/does/not/exist', db);
  const ingress = stores.ingressStore.create({
    display_name: 'Dispatch worker fixture',
    profile_id: PROFILE,
    environment: 'test',
    paired_connection_id: null,
    registration_mode: 'manual',
    selected_event_types: ['delivery'],
  });
  await stores.ingressStore.writeCredentialVersion(ingress.ingress_id, {
    header_name: 'x-fixture-token',
    header_token: 'fixture-token',
  });
  db.prepare(`
    UPDATE webhook_ingresses SET
      intake_state = 'enabled', registration_state = 'registered', enabled_at = ?
    WHERE ingress_id = ?
  `).run(Date.now(), ingress.ingress_id);
  const recipeIds = input.recipeIds ?? ['recipe-a'];
  for (const recipeId of recipeIds) {
    recipeStore.save(recipe(recipeId), PUBLISHER, 'pair-sync', Date.now(), PACK_SLUG);
  }
  stores.consumerStore.replaceConsumer({
    consumer_kind: 'pack_install',
    consumer_id: PACK_SLUG,
    requirements: [requirement],
    selections: [{ binding: 'generic_delivery', ingress_id: ingress.ingress_id }],
    recipes: recipeIds.map((recipeId) => ({
      recipe_id: recipeId,
      publisher_id: PUBLISHER,
      webhook_triggers: recipe(recipeId).webhook_triggers!,
    })),
  });
  // Time moves on the timer clock only: after a setSystemTime, a later
  // advance landed short by the difference.
  vi.advanceTimersByTime(Math.max(0, T0 - Date.now()));
  const accept = async (suffix: string) => {
    const input: WebhookAcceptedDeliveryInput = {
      ingress_id: ingress.ingress_id,
      profile_id: PROFILE,
      environment: 'test',
      received_at: Date.now(),
      delivery_dedup_key: `delivery-${suffix}`,
      raw_body_sha256: Buffer.from(suffix).toString('hex').padEnd(64, '0').slice(0, 64),
      decoded_content_type: 'application/json',
      decoded_schema_id: 'generic.delivery.v1',
      transport_assurance: 'authenticated',
      minimum_source_truth_policy: 'delivery_payload_allowed',
      credential_version: '1',
      admission_method: 'fixture',
      freshness_checked: false,
      response: { status: 202 },
      events: [{
        event_dedup_key: `event-${suffix}`,
        provider_event_id: `provider-${suffix}`,
        provider_resource_id: 'resource-fixture',
        provider_event_type: 'delivery',
        provider_occurred_at: null,
        decoded_payload_json: JSON.stringify({ private_value: suffix }),
      }],
    };
    const accepted = await stores.deliveryStore.accept(input);
    return accepted.fresh_events[0]!;
  };
  return { db, ...stores, accept };
};

type Stores = Pick<Awaited<ReturnType<typeof makeHarness>>, 'consumerStore' | 'deliveryStore'>;

/** A runner whose runs settle when the test says so. */
const handSettledRunner = () => {
  const calls: Array<{
    run: WebhookRecipeRunRequest;
    settle: (outcome: WebhookRecipeRunResult | Error) => void;
  }> = [];
  const runner: WebhookRecipeRunner = {
    run: (run) => new Promise((resolve, reject) => {
      calls.push({
        run,
        settle: (outcome) => {
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        },
      });
    }),
  };
  return { runner, calls };
};

/** A process stops dead (a crash, a stall): every timer it had dies with it,
 *  its heartbeats included. ⚠ vi.clearAllTimers also rewinds the fake clock
 *  to where it started, so the time is put back. */
const timersDie = (): void => {
  const at = Date.now();
  vi.clearAllTimers();
  vi.setSystemTime(at);
};

const refusingRunner: WebhookRecipeRunner = {
  run: async () => { throw new Error('this worker must not run anything'); },
};

const targets = (db: Database.Database) => db.prepare(`
  SELECT recipe_id, run_id, state, attempt_count, claim_token,
    lease_expires_at, available_at, last_error_code
  FROM webhook_recipe_dispatches ORDER BY created_at ASC, rowid ASC
`).all() as Array<{
  recipe_id: string;
  run_id: string;
  state: string;
  attempt_count: number;
  claim_token: string | null;
  lease_expires_at: number | null;
  available_at: number;
  last_error_code: string | null;
}>;

const pins = (db: Database.Database): number => (db.prepare(
  'SELECT COUNT(*) AS count FROM webhook_payload_pins',
).get() as { count: number }).count;

const outboxRows = (stores: Stores) => stores.deliveryStore.listOutbox()
  .map((row) => ({ state: row.state, attempt_count: row.attempt_count }));

const startDelivery = (stores: Stores, runner: WebhookRecipeRunner, worker = {}) => {
  const runtime = createWebhookRecipeDeliveryRuntime(
    { ...stores, runner },
    { worker },
  );
  runtime.start();
  cleanups.push(() => runtime.stop());
  return runtime;
};

const handOff = (stores: Stores) => dispatchWebhookOutboxOnce(
  stores.deliveryStore,
  createWebhookRecipeOutboxSink(stores.consumerStore),
);

describe('D-201 Slice 10A — the recipe-dispatch worker', () => {
  it('runs past 10 s and past the former eight-attempt schedule on its first claim, handed off before it settles', async () => {
    const h = await makeHarness();
    const { runner, calls } = handSettledRunner();
    // Production's defaults: the outbox's 10 s timeout and eight attempts,
    // the worker's 30 s lease.
    startDelivery(h, runner);
    await h.accept('long');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    const [first] = targets(h.db);
    expect(first).toMatchObject({ state: 'running', attempt_count: 1 });
    // ⛔ The outer row is done at the handoff, while the run goes on.
    expect(outboxRows(h)).toEqual([{ state: 'dispatched', attempt_count: 1 }]);

    // Past the outbox's 10 s, then well past the ~207 s its eight attempts
    // used to spend, then past ten leases.
    for (const ms of [10_000, 200_000, 100_000]) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(calls).toHaveLength(1);
      expect(targets(h.db)).toEqual([expect.objectContaining({
        state: 'running',
        attempt_count: 1,
        claim_token: first!.claim_token,
      })]);
      expect(targets(h.db)[0]!.lease_expires_at).toBeGreaterThan(Date.now());
      expect(outboxRows(h)).toEqual([{ state: 'dispatched', attempt_count: 1 }]);
    }
    // A worker of another server process sees a live claim.
    await expect(createWebhookRecipeDispatchRuntime({ ...h, runner: refusingRunner }).drain())
      .resolves.toMatchObject({ claimed: 0 });

    calls[0]!.settle('completed');
    await vi.advanceTimersByTimeAsync(0);
    expect(targets(h.db)).toEqual([expect.objectContaining({
      state: 'dispatched',
      attempt_count: 1,
      run_id: first!.run_id,
      lease_expires_at: null,
    })]);
    expect(pins(h.db)).toBe(0);
    expect(outboxRows(h)).toEqual([{ state: 'dispatched', attempt_count: 1 }]);
  });

  it('reclaims a claim whose lease lapsed on the same run id; the first run\'s late success changes nothing', async () => {
    const h = await makeHarness();
    await h.accept('stalled');
    await expect(handOff(h)).resolves.toMatchObject({ dispatched: 1 });
    const stalled = handSettledRunner();
    const draining = createWebhookRecipeDispatchRuntime({ ...h, runner: stalled.runner }).drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(stalled.calls).toHaveLength(1);
    // Its process stalls: no heartbeat renews the lease, which lapses.
    timersDie();
    await vi.advanceTimersByTimeAsync(WEBHOOK_DISPATCH_LEASE_MS + 1);

    const fresh = handSettledRunner();
    const reclaiming = createWebhookRecipeDispatchRuntime({ ...h, runner: fresh.runner }).drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh.calls).toHaveLength(1);
    // The same run id: the runner reuses what the first attempt left.
    expect(fresh.calls[0]!.run.run_id).toBe(stalled.calls[0]!.run.run_id);
    fresh.calls[0]!.settle('completed');
    await expect(reclaiming).resolves.toMatchObject({ claimed: 1, completed: 1 });

    // The stalled run succeeds after all: its claim is gone, so it reports
    // nothing and the target stays as the reclaim left it.
    stalled.calls[0]!.settle('completed');
    await expect(draining).resolves.toMatchObject({ claimed: 1, completed: 0, lost: 1 });
    expect(targets(h.db)).toEqual([expect.objectContaining({
      state: 'dispatched',
      attempt_count: 2,
      run_id: stalled.calls[0]!.run.run_id,
    })]);
    expect(outboxRows(h)).toEqual([{ state: 'dispatched', attempt_count: 1 }]);
  });

  it('a restart while the run is ambiguous: the next process reclaims it on the same run id once the dead claim\'s lease lapses', async () => {
    const db = new Database(':memory:');
    cleanups.push(() => { db.close(); });
    const h = await makeHarness({ db });
    const before = handSettledRunner();
    startDelivery(h, before.runner);
    await h.accept('ambiguous');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(before.calls).toHaveLength(1);
    // The process dies mid-run: no stop, no settle, and its timers die with it.
    timersDie();

    const after = handSettledRunner();
    startDelivery(openStores(db), after.runner);
    await vi.advanceTimersByTimeAsync(WEBHOOK_DISPATCH_LEASE_MS - 3_000);
    // Not before the dead claim's lease lapses: it could still be alive.
    expect(after.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(after.calls).toHaveLength(1);
    expect(after.calls[0]!.run.run_id).toBe(before.calls[0]!.run.run_id);
    after.calls[0]!.settle('completed');
    await vi.advanceTimersByTimeAsync(0);
    expect(targets(db)).toEqual([expect.objectContaining({
      state: 'dispatched',
      attempt_count: 2,
      run_id: before.calls[0]!.run.run_id,
    })]);
    expect(outboxRows(h)).toEqual([{ state: 'dispatched', attempt_count: 1 }]);
  });

  it('never reports an event handed off before its targets are durable', async () => {
    const h = await makeHarness();
    await h.accept('unowned');
    let failHandoff = true;
    const sink = createWebhookRecipeOutboxSink({
      prepareDispatches(input) {
        if (failHandoff) throw new Error('the target rows could not be written');
        return h.consumerStore.prepareDispatches(input);
      },
    });
    await expect(dispatchWebhookOutboxOnce(h.deliveryStore, sink, { base_retry_ms: 0 }))
      .resolves.toMatchObject({ claimed: 1, dispatched: 0, retried: 1 });
    expect(outboxRows(h)).toEqual([{ state: 'pending', attempt_count: 1 }]);
    expect(targets(h.db)).toEqual([]);
    failHandoff = false;
    await expect(dispatchWebhookOutboxOnce(h.deliveryStore, sink, { base_retry_ms: 0 }))
      .resolves.toMatchObject({ claimed: 1, dispatched: 1 });
    expect(targets(h.db)).toEqual([expect.objectContaining({ state: 'pending', attempt_count: 0 })]);
  });

  it('settles sibling targets of different durations apart, and runs a recipe\'s deliveries one at a time in order', async () => {
    const h = await makeHarness({ recipeIds: ['recipe-a', 'recipe-b'] });
    const { runner, calls } = handSettledRunner();
    startDelivery(h, runner);
    const one = await h.accept('one');
    await vi.advanceTimersByTimeAsync(1_000);
    // One event, two recipes: side by side.
    expect(calls.map((call) => call.run.recipe_id)).toEqual(['recipe-a', 'recipe-b']);
    calls[1]!.settle('completed');
    await vi.advanceTimersByTimeAsync(0);
    expect(targets(h.db).map((row) => [row.recipe_id, row.state])).toEqual([
      ['recipe-a', 'running'],
      ['recipe-b', 'dispatched'],
    ]);

    // The next event: recipe-b runs it at once, recipe-a waits for its first.
    const two = await h.accept('two');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.map((call) => [call.run.recipe_id, call.run.context.webhook.event_id]))
      .toEqual([
        ['recipe-a', one.event_id],
        ['recipe-b', one.event_id],
        ['recipe-b', two.event_id],
      ]);
    calls[2]!.settle('completed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3);

    calls[0]!.settle('completed');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(4);
    expect([calls[3]!.run.recipe_id, calls[3]!.run.context.webhook.event_id])
      .toEqual(['recipe-a', two.event_id]);
    calls[3]!.settle('completed');
    await vi.advanceTimersByTimeAsync(0);
    expect(targets(h.db).map((row) => [row.state, row.attempt_count])).toEqual([
      ['dispatched', 1],
      ['dispatched', 1],
      ['dispatched', 1],
      ['dispatched', 1],
    ]);
    expect(new Set(calls.map((call) => call.run.run_id)).size).toBe(4);
    expect(outboxRows(h)).toEqual([
      { state: 'dispatched', attempt_count: 1 },
      { state: 'dispatched', attempt_count: 1 },
    ]);
  });

  it('retries a failed run on the same run id after its backoff; the last attempt dead-letters it and keeps the payload', async () => {
    const h = await makeHarness({ payloadRetentionMs: 10 });
    const runIds: string[] = [];
    startDelivery(h, {
      run: async (run) => {
        runIds.push(run.run_id);
        throw new Error('the provider is down');
      },
    }, { max_attempts: 3, base_retry_ms: 1_000 });
    await h.accept('failing');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runIds).toHaveLength(1);
    expect(targets(h.db)).toEqual([expect.objectContaining({
      state: 'pending',
      attempt_count: 1,
      available_at: Date.now() + 1_000,
      last_error_code: 'run_failed',
    })]);
    // Attempt two after 1 s, three after 2 s more; the third is the last.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runIds).toHaveLength(3);
    expect(new Set(runIds).size).toBe(1);
    expect(targets(h.db)).toEqual([expect.objectContaining({
      state: 'dead_letter',
      attempt_count: 3,
      claim_token: null,
      lease_expires_at: null,
      last_error_code: 'run_failed',
    })]);
    // The event itself was handed off: its outer row is not a dead letter.
    expect(outboxRows(h)).toEqual([{ state: 'dispatched', attempt_count: 1 }]);
    // The payload stays for the owner past its retention. Since Slice 10B the
    // dead letter waits for review outside the intake capacity.
    expect(pins(h.db)).toBe(1);
    expect(h.deliveryStore.prune()).toMatchObject({ payloads_deleted: 0 });
    expect(h.consumerStore.countActiveDispatchEvents()).toBe(0);
    expect(h.consumerStore.countUnresolvedDeadLetterTargets()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runIds).toHaveLength(3);
  });

  it('hands back a run the server refused to start, with its attempt; a closed gate claims nothing', async () => {
    const h = await makeHarness();
    await h.accept('refused');
    await handOff(h);
    for (const code of ['draining', 'server_paused']) {
      await expect(createWebhookRecipeDispatchRuntime({
        ...h,
        runner: { run: async () => { throw new RpcError(code, 'The server is restarting or paused.', 503); } },
      }).drain()).resolves.toMatchObject({ claimed: 1, released: 1, retried: 0 });
      expect(targets(h.db)).toEqual([expect.objectContaining({
        state: 'pending',
        attempt_count: 0,
        claim_token: null,
        lease_expires_at: null,
      })]);
      expect(pins(h.db)).toBe(1);
    }
    // Paused or vault-locked: nothing is claimed, so no attempt is spent.
    await expect(createWebhookRecipeDispatchRuntime(
      { ...h, runner: refusingRunner },
      { canDispatch: () => false },
    ).drain()).resolves.toMatchObject({ claimed: 0 });
    // Stopping: the same.
    await expect(createWebhookRecipeDispatchRuntime(
      { ...h, runner: refusingRunner },
      { isStopping: () => true },
    ).drain()).resolves.toMatchObject({ claimed: 0 });
    expect(targets(h.db)).toEqual([expect.objectContaining({ state: 'pending', attempt_count: 0 })]);
  });

  it('dead-letters a target whose crashed claims spent every attempt, without running it again', async () => {
    const h = await makeHarness();
    await h.accept('crashing');
    await handOff(h);
    // Eight claims, each lost with its process (the run crashed it).
    h.db.prepare(`
      UPDATE webhook_recipe_dispatches SET
        state = 'running', attempt_count = 8, claim_token = 'crashed-claim',
        lease_expires_at = ?
    `).run(Date.now() - 1);
    await expect(createWebhookRecipeDispatchRuntime({ ...h, runner: refusingRunner }).drain())
      .resolves.toMatchObject({ claimed: 0 });
    expect(targets(h.db)).toEqual([expect.objectContaining({
      state: 'dead_letter',
      attempt_count: 8,
      claim_token: null,
      last_error_code: 'attempt_limit',
    })]);
    expect(pins(h.db)).toBe(1);
  });

  it('passes over a target it cannot claim, so it holds back no other', async () => {
    const h = await makeHarness({ recipeIds: ['recipe-a', 'recipe-b'] });
    await h.accept('corrupt');
    await handOff(h);
    // recipe-a's target is corrupt: a pending row with an owner-hold marker.
    const [corrupt] = targets(h.db);
    expect(corrupt!.recipe_id).toBe('recipe-a');
    h.db.prepare(`
      INSERT INTO webhook_waiting_dispatches (dispatch_id, run_id, created_at, updated_at)
      SELECT dispatch_id, run_id, 1, 1 FROM webhook_recipe_dispatches WHERE run_id = ?
    `).run(corrupt!.run_id);
    const logged: string[] = [];
    const ran: string[] = [];
    await expect(createWebhookRecipeDispatchRuntime({
      ...h,
      runner: { run: async (run) => { ran.push(run.recipe_id); return 'completed'; } },
    }, {
      log: (_level, _message, metadata) => { logged.push(String(metadata.code)); },
    }).drain()).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(ran).toEqual(['recipe-b']);
    expect(logged).toEqual(['dispatch_claim_failed']);
    expect(targets(h.db).map((row) => [row.recipe_id, row.state])).toEqual([
      ['recipe-a', 'pending'],
      ['recipe-b', 'dispatched'],
    ]);
  });

  it('counts handed-off work that has not run against the intake capacity', async () => {
    const h = await makeHarness({ maxOutboxBacklog: 2 });
    await h.accept('first');
    await h.accept('second');
    await expect(dispatchWebhookOutboxOnce(
      h.deliveryStore,
      createWebhookRecipeOutboxSink(h.consumerStore),
    )).resolves.toMatchObject({ dispatched: 2 });
    expect(outboxRows(h).every((row) => row.state === 'dispatched')).toBe(true);
    // The outbox is empty of active rows, but two events still wait to run.
    await expect(h.accept('third')).rejects.toMatchObject({ code: 'backpressure' });
    await expect(createWebhookRecipeDispatchRuntime({
      ...h,
      runner: { run: async () => 'completed' },
    }).drain()).resolves.toMatchObject({ completed: 2 });
    await expect(h.accept('third')).resolves.toMatchObject({ event_id: expect.any(String) });
  });

  it('migrates a dispatch table from before the worker in place', () => {
    const db = new Database(':memory:');
    cleanups.push(() => { db.close(); });
    db.exec(`
      CREATE TABLE webhook_recipe_dispatches (
        dispatch_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        publisher_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'running', 'dispatched', 'cancelled')
        ),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        claim_token TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (event_id, trigger_id),
        CHECK (
          (state = 'running' AND claim_token IS NOT NULL)
          OR (state <> 'running' AND claim_token IS NULL)
        )
      );
      CREATE TABLE webhook_waiting_dispatches (
        dispatch_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO webhook_recipe_dispatches VALUES (?, ?, 't', 'b', 'r', 'p', ?, ?, ?, ?, 1, 2)
    `);
    insert.run('whx_pending', 'e1', 'run_pending', 'pending', 0, null);
    insert.run('whx_inline', 'e2', 'run_inline', 'running', 3, 'old-claim');
    insert.run('whx_held', 'e3', 'run_held', 'running', 1, 'held-claim');
    insert.run('whx_done', 'e4', 'run_done', 'dispatched', 1, null);
    db.prepare(`
      INSERT INTO webhook_waiting_dispatches VALUES ('whx_held', 'run_held', 1, 2)
    `).run();

    openStores(db);
    const rows = db.prepare(`
      SELECT dispatch_id, state, attempt_count, claim_token, available_at,
        lease_expires_at, last_error_code, created_at, updated_at
      FROM webhook_recipe_dispatches ORDER BY dispatch_id
    `).all();
    expect(rows).toEqual([
      { dispatch_id: 'whx_done', state: 'dispatched', attempt_count: 1, claim_token: null, available_at: 0, lease_expires_at: null, last_error_code: null, created_at: 1, updated_at: 2 },
      // Held for the owner: no worker owns it, so it has no lease.
      { dispatch_id: 'whx_held', state: 'running', attempt_count: 1, claim_token: 'held-claim', available_at: 0, lease_expires_at: null, last_error_code: null, created_at: 1, updated_at: 2 },
      // Run inline by the old outbox, in a process that is gone: reclaimable.
      { dispatch_id: 'whx_inline', state: 'running', attempt_count: 3, claim_token: 'old-claim', available_at: 0, lease_expires_at: 0, last_error_code: null, created_at: 1, updated_at: 2 },
      { dispatch_id: 'whx_pending', state: 'pending', attempt_count: 0, claim_token: null, available_at: 0, lease_expires_at: null, last_error_code: null, created_at: 1, updated_at: 2 },
    ]);
    // The widened state CHECK, and the worker's indexes.
    expect(() => db.prepare(`
      UPDATE webhook_recipe_dispatches SET state = 'dead_letter' WHERE dispatch_id = 'whx_pending'
    `).run()).not.toThrow();
    const indexes = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'webhook_recipe_dispatches' AND name LIKE 'idx_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toEqual([
      'idx_webhook_recipe_dispatches_claim',
      // D-201 Slice 10F — the closed and the open dead letters.
      'idx_webhook_recipe_dispatches_closed_dead_letters',
      'idx_webhook_recipe_dispatches_event',
      'idx_webhook_recipe_dispatches_open_dead_letters',
      // D-201 Slice 10E — each recipe's queue, for the claim scan.
      'idx_webhook_recipe_dispatches_queue',
      'idx_webhook_recipe_dispatches_recipe',
      'idx_webhook_recipe_dispatches_trigger',
    ]);
    // D-201 Slice 10E — no migrated row carries a restart's mark.
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM webhook_recipe_dispatches
      WHERE restart_interrupted_at IS NOT NULL
    `).get()).toEqual({ count: 0 });
    // A second start finds nothing to migrate.
    openStores(db);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM webhook_recipe_dispatches
    `).get()).toEqual({ count: 4 });
  });
});

/** D-201 Slice 10E — the restart's mark on each target, in queue order. */
const marks = (db: Database.Database): Array<number | null> => (db.prepare(`
  SELECT restart_interrupted_at AS mark FROM webhook_recipe_dispatches
  ORDER BY created_at ASC, rowid ASC
`).all() as Array<{ mark: number | null }>).map((row) => row.mark);

describe('D-201 Slice 10E — restart-safe runs and an honest per-recipe queue', () => {
  it("a run the server's stop ends goes back with its attempt, and the next start runs it again on its run id", async () => {
    const db = new Database(':memory:');
    cleanups.push(() => { db.close(); });
    const h = await makeHarness({ db });
    const before = handSettledRunner();
    let stopping = false;
    const runtime = createWebhookRecipeDeliveryRuntime(
      { ...h, runner: before.runner },
      { isStopping: () => stopping },
    );
    runtime.start();
    cleanups.push(() => runtime.stop());
    await h.accept('stopped');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(before.calls).toHaveLength(1);
    // The server begins to stop: the worker marks the run it has going.
    stopping = true;
    expect(runtime.worker.noteServerStopping()).toBe(1);
    expect(marks(db)).toEqual([expect.any(Number)]);
    // The drain stops it; the runner reads that as the restart's.
    before.calls[0]!.settle('interrupted');
    await vi.advanceTimersByTimeAsync(0);
    expect(targets(db)).toEqual([expect.objectContaining({
      state: 'pending',
      attempt_count: 0,
      claim_token: null,
      lease_expires_at: null,
    })]);
    expect(marks(db)).toEqual([expect.any(Number)]);
    expect(pins(db)).toBe(1);
    expect(runtime.worker.totals()).toMatchObject({ released: 1, retried: 0, cancelled: 0 });
    await runtime.stop();

    const after = handSettledRunner();
    startDelivery(openStores(db), after.runner);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(after.calls).toHaveLength(1);
    expect(after.calls[0]!.run).toMatchObject({
      run_id: before.calls[0]!.run.run_id,
      resume_interrupted_run: true,
    });
    after.calls[0]!.settle('completed');
    await vi.advanceTimersByTimeAsync(0);
    expect(targets(db)).toEqual([expect.objectContaining({ state: 'dispatched', attempt_count: 1 })]);
    expect(marks(db)).toEqual([null]);
  });

  it('marks its runs when the server begins to stop, so one whose process dies before it hears back runs again', async () => {
    const db = new Database(':memory:');
    cleanups.push(() => { db.close(); });
    const h = await makeHarness({ db });
    const before = handSettledRunner();
    const runtime = startDelivery(h, before.runner);
    await h.accept('dies');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(before.calls).toHaveLength(1);
    expect(runtime.worker.noteServerStopping()).toBe(1);
    // The drain stops the run, its record says `killed`, and the process exits
    // before the worker hears how it ended.
    timersDie();

    const after = handSettledRunner();
    startDelivery(openStores(db), after.runner);
    await vi.advanceTimersByTimeAsync(WEBHOOK_DISPATCH_LEASE_MS + 1_000);
    expect(after.calls).toHaveLength(1);
    expect(after.calls[0]!.run).toMatchObject({
      run_id: before.calls[0]!.run.run_id,
      resume_interrupted_run: true,
    });
    after.calls[0]!.settle('completed');
    await vi.advanceTimersByTimeAsync(0);
    // The dead claim spent its attempt; the mark is gone with the settle.
    expect(targets(db)).toEqual([expect.objectContaining({ state: 'dispatched', attempt_count: 2 })]);
    expect(marks(db)).toEqual([null]);
  });

  it("clears the mark once a run settles any other way, so the owner's later Stop stays final", async () => {
    const h = await makeHarness();
    const { runner, calls } = handSettledRunner();
    const runtime = startDelivery(h, runner);
    await h.accept('settles');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.worker.noteServerStopping()).toBe(1);
    // It failed on its own before the drain stopped it: an ordinary retry.
    calls[0]!.settle(new Error('the provider is down'));
    await vi.advanceTimersByTimeAsync(0);
    expect(targets(h.db)).toEqual([expect.objectContaining({
      state: 'pending',
      attempt_count: 1,
      last_error_code: 'run_failed',
    })]);
    expect(marks(h.db)).toEqual([null]);
    await vi.advanceTimersByTimeAsync(WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS[0]! + 1_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.run.resume_interrupted_run).toBeUndefined();
    // Nothing going, nothing to mark.
    calls[1]!.settle('completed');
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.worker.noteServerStopping()).toBe(0);
  });

  it('lets a later delivery run while an earlier one waits to retry, and never runs two of a recipe at once', async () => {
    const h = await makeHarness();
    const { runner, calls } = handSettledRunner();
    let renewalsFail = false;
    const warnings: string[] = [];
    const consumerStore = {
      ...h.consumerStore,
      renewDispatchLease: (input: Parameters<typeof h.consumerStore.renewDispatchLease>[0]) => {
        if (renewalsFail) throw new Error('the database is busy');
        return h.consumerStore.renewDispatchLease(input);
      },
    };
    const runtime = createWebhookRecipeDeliveryRuntime(
      { ...h, consumerStore, runner },
      { log: (_level, _message, metadata) => { warnings.push(String(metadata.code)); } },
    );
    runtime.start();
    cleanups.push(() => runtime.stop());
    const one = await h.accept('one');
    await vi.advanceTimersByTimeAsync(1_000);
    const two = await h.accept('two');
    // The first fails and waits 30 s for its retry; the second runs meanwhile.
    calls[0]!.settle(new Error('the provider is down'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.map((call) => call.run.context.webhook.event_id)).toEqual([one.event_id, two.event_id]);

    // The second's lease lapses inside this process: its renewals fail.
    renewalsFail = true;
    h.db.prepare(`
      UPDATE webhook_recipe_dispatches SET lease_expires_at = ? WHERE state = 'running'
    `).run(Date.now() - 1);
    // The first's backoff ends: still one run of the recipe at a time.
    await vi.advanceTimersByTimeAsync(WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS[0]! + 1_000);
    expect(calls).toHaveLength(2);
    expect(warnings.filter((code) => code === 'dispatch_lease_renewal_failed')).toHaveLength(1);
    // One failed renewal did not end the heartbeat: the next one renews.
    renewalsFail = false;
    await vi.advanceTimersByTimeAsync(WEBHOOK_DISPATCH_LEASE_MS / 3 + 1);
    expect(targets(h.db).find((row) => row.state === 'running')!.lease_expires_at)
      .toBeGreaterThan(Date.now());

    // The second settles; then the first's retry, on its run id.
    calls[1]!.settle('completed');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.run.run_id).toBe(calls[0]!.run.run_id);
    calls[2]!.settle('completed');
    await vi.advanceTimersByTimeAsync(0);
    expect(targets(h.db).map((row) => [row.state, row.attempt_count])).toEqual([
      ['dispatched', 2],
      ['dispatched', 1],
    ]);
  });

  it('defers a row it cannot claim, holds no slot or recipe with it, and dead-letters it at the ceiling', async () => {
    const recipeIds = Array.from({ length: 17 }, (_, index) => `recipe-${String(index).padStart(2, '0')}`);
    const h = await makeHarness({ recipeIds });
    await h.accept('first');
    await handOff(h);
    // Sixteen recipes' targets are corrupt (a pending row with an owner-hold
    // marker); the seventeenth's is sound. Before 10E a pass read only as many
    // candidates as it had slots, and the sound one was never reached.
    const corrupt = targets(h.db).filter((row) => row.recipe_id !== 'recipe-16');
    expect(corrupt).toHaveLength(16);
    for (const row of corrupt) {
      h.db.prepare(`
        INSERT INTO webhook_waiting_dispatches (dispatch_id, run_id, created_at, updated_at)
        SELECT dispatch_id, run_id, 1, 1 FROM webhook_recipe_dispatches WHERE run_id = ?
      `).run(row.run_id);
    }
    const ran: string[] = [];
    const worker = createWebhookRecipeDispatchRuntime({
      ...h,
      runner: { run: async (run) => { ran.push(`${run.recipe_id}:${run.context.webhook.provider_event_id}`); return 'completed'; } },
    }, { max_attempts: 2, poll_interval_ms: 60_000 });
    // Its very first pass reaches the sound one, before any poll.
    worker.start();
    cleanups.push(() => worker.stop());
    await vi.advanceTimersByTimeAsync(0);
    expect(ran).toEqual(['recipe-16:provider-first']);
    expect(worker.totals()).toMatchObject({ claimed: 1, completed: 1 });
    // Each corrupt one waits out the first retry, its attempt counted.
    expect(targets(h.db).filter((row) => row.recipe_id !== 'recipe-16')).toEqual(corrupt.map(() =>
      expect.objectContaining({
        state: 'pending',
        attempt_count: 1,
        last_error_code: 'claim_failed',
        available_at: Date.now() + WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS[0]!,
      })));
    // Its recipe's later delivery does not wait for it.
    await h.accept('second');
    await handOff(h);
    await expect(worker.drain()).resolves.toMatchObject({ claimed: 17, completed: 17 });
    expect(ran.filter((entry) => entry.endsWith(':provider-second'))).toHaveLength(17);
    // At the ceiling it becomes a dead letter for the owner.
    vi.advanceTimersByTime(WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS[0]!);
    await expect(worker.drain()).resolves.toMatchObject({ claimed: 0, dead_lettered: 16 });
    expect(targets(h.db).filter((row) => row.state === 'dead_letter')).toEqual(corrupt.map(() =>
      expect.objectContaining({ attempt_count: 2, last_error_code: 'claim_failed' })));
    expect(h.consumerStore.countUnresolvedDeadLetterTargets()).toBe(16);
  });

  it('retries a failed run over about an hour by default before it becomes a dead letter', async () => {
    const h = await makeHarness();
    const at: number[] = [];
    startDelivery(h, {
      run: async () => {
        at.push(Date.now());
        throw new Error('the provider is down');
      },
    });
    await h.accept('down');
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
    expect(at).toHaveLength(8);
    // Each retry waits its scheduled time, and at most one poll more.
    at.slice(1).forEach((time, index) => {
      const gap = time - at[index]!;
      expect(gap).toBeGreaterThanOrEqual(WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS[index]!);
      expect(gap).toBeLessThanOrEqual(WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS[index]! + 1_000);
    });
    expect(at[7]! - at[0]!).toBeGreaterThanOrEqual(60.5 * 60 * 1_000);
    expect(targets(h.db)).toEqual([expect.objectContaining({
      state: 'dead_letter',
      attempt_count: 8,
      last_error_code: 'run_failed',
    })]);
  });
});

describe('D-201 Slice 10J — restart marks, approved runs and rows that cannot be claimed', () => {
  /** A target the restart's drain stopped, handed back marked (Slice 10E). */
  const stoppedByRestart = async (db: Database.Database) => {
    const h = await makeHarness({ db });
    const before = handSettledRunner();
    const runtime = startDelivery(h, before.runner);
    await h.accept('stopped');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.worker.noteServerStopping()).toBe(1);
    before.calls[0]!.settle('interrupted');
    await vi.advanceTimersByTimeAsync(0);
    await runtime.stop();
    expect(marks(db)).toEqual([expect.any(Number)]);
    return { h, runId: before.calls[0]!.run.run_id };
  };

  const ingressId = (db: Database.Database): string => (db.prepare(
    'SELECT ingress_id FROM webhook_ingresses',
  ).get() as { ingress_id: string }).ingress_id;

  /** The owner tries a target dead letter again from Settings. */
  const tryAgain = (h: Awaited<ReturnType<typeof makeHarness>>, recipeId = 'recipe-a') => {
    const row = h.db.prepare(`
      SELECT dispatch_id, updated_at FROM webhook_recipe_dispatches WHERE recipe_id = ?
    `).get(recipeId) as { dispatch_id: string; updated_at: number };
    h.consumerStore.requeueDeadLetterTarget({
      dispatch_id: row.dispatch_id,
      ingress_id: ingressId(h.db),
      dead_lettered_at: row.updated_at,
      actor_kind: 'owner',
      actor_instance_id: 'owner-device',
      reason: null,
    });
  };

  it("keeps the restart's mark through a failure before the run starts again, so its retry still runs it again", async () => {
    const db = new Database(':memory:');
    cleanups.push(() => { db.close(); });
    const { runId } = await stoppedByRestart(db);
    const after = handSettledRunner();
    const runtime = startDelivery(openStores(db), after.runner);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(after.calls[0]!.run).toMatchObject({ run_id: runId, resume_interrupted_run: true });
    // Its door must be re-saved, say: it failed before a new run record. Before
    // 10J this cleared the mark, and the retry closed the target as stopped.
    after.calls[0]!.settle(new WebhookRunNotRestartedError(
      new Error('door authority changed; re-save the recipe'),
    ));
    await vi.advanceTimersByTimeAsync(0);
    expect(targets(db)).toEqual([expect.objectContaining({
      state: 'pending',
      attempt_count: 1,
      last_error_code: 'run_failed',
    })]);
    expect(marks(db)).toEqual([expect.any(Number)]);
    await vi.advanceTimersByTimeAsync(WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS[0]! + 1_000);
    expect(after.calls).toHaveLength(2);
    expect(after.calls[1]!.run).toMatchObject({ run_id: runId, resume_interrupted_run: true });
    // It ran again and failed on its own: the mark goes, as in 10E.
    after.calls[1]!.settle(new Error('the provider is down'));
    await vi.advanceTimersByTimeAsync(0);
    expect(marks(db)).toEqual([null]);
    expect(runtime.worker.totals()).toMatchObject({ retried: 2 });
  });

  it('keeps the mark when its claim fails, and runs it again once it can be claimed', async () => {
    const db = new Database(':memory:');
    cleanups.push(() => { db.close(); });
    const { runId } = await stoppedByRestart(db);
    // A hold marker on a pending row: it cannot be claimed for now.
    db.prepare(`
      INSERT INTO webhook_waiting_dispatches (dispatch_id, run_id, created_at, updated_at)
      SELECT dispatch_id, run_id, 1, 1 FROM webhook_recipe_dispatches
    `).run();
    const after = handSettledRunner();
    const worker = createWebhookRecipeDispatchRuntime(
      { ...openStores(db), runner: after.runner },
      { poll_interval_ms: 60_000 },
    );
    cleanups.push(() => worker.stop());
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(targets(db)).toEqual([expect.objectContaining({
      state: 'pending',
      attempt_count: 1,
      last_error_code: 'claim_failed',
    })]);
    expect(marks(db)).toEqual([expect.any(Number)]);
    db.prepare('DELETE FROM webhook_waiting_dispatches').run();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(after.calls).toHaveLength(1);
    expect(after.calls[0]!.run).toMatchObject({ run_id: runId, resume_interrupted_run: true });
  });

  it("keeps the mark through the attempt ceiling's dead letter, so the owner's try again runs it again", async () => {
    const db = new Database(':memory:');
    cleanups.push(() => { db.close(); });
    const { h, runId } = await stoppedByRestart(db);
    // Its claims died with their processes until none was left.
    db.prepare('UPDATE webhook_recipe_dispatches SET attempt_count = 8').run();
    const ran: WebhookRecipeRunRequest[] = [];
    const worker = createWebhookRecipeDispatchRuntime({
      ...openStores(db),
      runner: { run: async (run) => { ran.push(run); return 'completed'; } },
    }, { poll_interval_ms: 60_000 });
    cleanups.push(() => worker.stop());
    await expect(worker.drain()).resolves.toMatchObject({ claimed: 0 });
    expect(targets(db)).toEqual([expect.objectContaining({
      state: 'dead_letter',
      last_error_code: 'attempt_limit',
    })]);
    expect(marks(db)).toEqual([expect.any(Number)]);
    tryAgain(h);
    await expect(worker.drain()).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(ran).toEqual([expect.objectContaining({ run_id: runId, resume_interrupted_run: true })]);
    expect(marks(db)).toEqual([null]);
  });

  it('lets a row it cannot claim wait out the schedule step by step: a dead letter about an hour after its first failure', async () => {
    const h = await makeHarness();
    await h.accept('unclaimable');
    await handOff(h);
    h.db.prepare(`
      INSERT INTO webhook_waiting_dispatches (dispatch_id, run_id, created_at, updated_at)
      SELECT dispatch_id, run_id, 1, 1 FROM webhook_recipe_dispatches
    `).run();
    const waits: number[] = [];
    const consumerStore = {
      ...h.consumerStore,
      deferUnclaimableDispatch: (input: Parameters<typeof h.consumerStore.deferUnclaimableDispatch>[0]) => {
        waits.push(input.retry_delay_ms);
        return h.consumerStore.deferUnclaimableDispatch(input);
      },
    };
    const worker = createWebhookRecipeDispatchRuntime({ ...h, consumerStore, runner: refusingRunner });
    cleanups.push(() => worker.stop());
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = Date.now();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
    // The schedule's step for each attempt, as for a failed run (it was 30 s each time).
    expect(waits).toEqual([...WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS, WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS.at(-1)!]);
    const dead = h.db.prepare(`
      SELECT state, attempt_count, last_error_code, updated_at FROM webhook_recipe_dispatches
    `).get() as { state: string; attempt_count: number; last_error_code: string; updated_at: number };
    expect(dead).toMatchObject({ state: 'dead_letter', attempt_count: 8, last_error_code: 'claim_failed' });
    expect(dead.updated_at - first).toBeGreaterThanOrEqual(60.5 * 60 * 1_000);
    expect(dead.updated_at - first).toBeLessThanOrEqual(60.5 * 60 * 1_000 + 7 * 1_000);
  });

  it('marks a held delivery whose approved run is resuming when the server begins to stop, and no other', async () => {
    const h = await makeHarness({ recipeIds: ['recipe-a', 'recipe-b'] });
    const resuming = new Set<string>();
    const runtime = createWebhookRecipeDeliveryRuntime(
      { ...h, runner: { run: async () => 'awaiting_approval' } },
      { isRunActive: (runId) => resuming.has(runId) },
    );
    runtime.start();
    cleanups.push(() => runtime.stop());
    await h.accept('held');
    await vi.advanceTimersByTimeAsync(1_000);
    const held = () => h.consumerStore.listAwaitingApprovalDispatches()
      .map((row) => [row.recipe_id, row.restart_interrupted])
      .sort();
    expect(held()).toEqual([['recipe-a', false], ['recipe-b', false]]);
    // The owner approved recipe-a's: its run resumes here. recipe-b's waits on the owner.
    resuming.add(h.consumerStore.listAwaitingApprovalDispatches()
      .find((row) => row.recipe_id === 'recipe-a')!.run_id);
    expect(runtime.worker.noteServerStopping()).toBe(1);
    expect(held()).toEqual([['recipe-a', true], ['recipe-b', false]]);
  });

  it("makes an approved run the restart stopped a dead letter the owner can try again; the owner's Stop stays final", async () => {
    const recipeIds = ['recipe-a', 'recipe-b', 'recipe-c', 'recipe-d'];
    const h = await makeHarness({ recipeIds });
    const resuming = new Set<string>();
    const runtime = createWebhookRecipeDeliveryRuntime(
      { ...h, runner: { run: async () => 'awaiting_approval' } },
      { isRunActive: (runId) => resuming.has(runId) },
    );
    runtime.start();
    cleanups.push(() => runtime.stop());
    await h.accept('approved');
    await vi.advanceTimersByTimeAsync(1_000);
    const runOf = new Map(h.consumerStore.listAwaitingApprovalDispatches()
      .map((row) => [row.recipe_id, row.run_id]));
    // a, c and d resume when the server begins to stop; b waits on the owner.
    for (const recipeId of ['recipe-a', 'recipe-c', 'recipe-d']) resuming.add(runOf.get(recipeId)!);
    expect(runtime.worker.noteServerStopping()).toBe(3);
    await runtime.stop();
    // The records after the drain: it stopped a; the owner stopped b after the
    // start; c reached another hold first; d finished inside the grace.
    const status: Record<string, AuditEntry['commit_status']> = {
      'recipe-a': 'killed',
      'recipe-b': 'killed',
      'recipe-c': 'awaiting_approval',
      'recipe-d': 'succeeded',
    };
    const auditLog = {
      get: async (runId: string): Promise<AuditEntry | null> => {
        const recipeId = recipeIds.find((id) => runOf.get(id) === runId);
        return recipeId === undefined ? null : {
          run_id: runId,
          recipe_id: recipeId,
          recipe_hash: 'hash',
          started_at: 1,
          finished_at: 2,
          duration_ms: 1,
          commit_status: status[recipeId]!,
          config_snapshot: {},
          errors: [],
          trigger_url: null,
          trigger_source: 'webhook',
          instance_id: 'server',
        };
      },
    };
    await expect(reconcileWebhookAwaitingApprovalDispatches(h.consumerStore, auditLog))
      .resolves.toEqual({ scanned: 4, waiting: 1, succeeded: 1, failed: 1, interrupted: 1, in_doubt: 0 });
    const rows = h.db.prepare(`
      SELECT dispatch.recipe_id, dispatch.state, dispatch.last_error_code,
        dispatch.restart_interrupted_at IS NOT NULL AS marked,
        EXISTS (SELECT 1 FROM webhook_payload_pins pin WHERE pin.pin_id = dispatch.dispatch_id) AS pinned,
        EXISTS (SELECT 1 FROM webhook_waiting_dispatches waiting
          WHERE waiting.dispatch_id = dispatch.dispatch_id) AS held
      FROM webhook_recipe_dispatches dispatch ORDER BY dispatch.recipe_id
    `).all();
    expect(rows).toEqual([
      // Never a silent cancel: a dead letter, its payload and mark kept.
      { recipe_id: 'recipe-a', state: 'dead_letter', last_error_code: 'restart_interrupted', marked: 1, pinned: 1, held: 0 },
      // The owner's Stop: final, as before.
      { recipe_id: 'recipe-b', state: 'cancelled', last_error_code: null, marked: 0, pinned: 0, held: 0 },
      // Waiting on the owner again: a new record, so the mark goes.
      { recipe_id: 'recipe-c', state: 'running', last_error_code: null, marked: 0, pinned: 1, held: 1 },
      { recipe_id: 'recipe-d', state: 'dispatched', last_error_code: null, marked: 0, pinned: 0, held: 0 },
    ]);
    expect(h.consumerStore.countUnresolvedDeadLetterTargets()).toBe(1);
    // The owner tries it again: it runs again on its run id, as the restart's.
    tryAgain(h, 'recipe-a');
    const after = handSettledRunner();
    startDelivery(h, after.runner);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(after.calls.map((call) => call.run)).toEqual([expect.objectContaining({
      run_id: runOf.get('recipe-a'),
      resume_interrupted_run: true,
    })]);
  });
});

describe('D-201 Slice 10N — an approved run in doubt, tried again by the owner', () => {
  const rerunFlags = (db: Database.Database): Array<number | null> => (db.prepare(`
    SELECT in_doubt_rerun_at FROM webhook_recipe_dispatches ORDER BY created_at ASC, rowid ASC
  `).all() as Array<{ in_doubt_rerun_at: number | null }>).map((row) => row.in_doubt_rerun_at);

  /** A delivery held for the owner, whose approved run then ended in doubt:
   *  the reconciler makes it a dead letter for the owner's review. */
  const inDoubtDeadLetter = async () => {
    const h = await makeHarness();
    const runtime = createWebhookRecipeDeliveryRuntime({ ...h, runner: { run: async () => 'awaiting_approval' } });
    runtime.start();
    await h.accept('approved');
    await vi.advanceTimersByTimeAsync(1_000);
    const held = h.consumerStore.listAwaitingApprovalDispatches()[0]!;
    await runtime.stop();
    const auditLog = {
      get: async (runId: string): Promise<AuditEntry | null> => ({
        run_id: runId,
        recipe_id: held.recipe_id,
        recipe_hash: 'hash',
        started_at: 1,
        finished_at: 2,
        duration_ms: 1,
        commit_status: 'in_doubt',
        config_snapshot: {},
        errors: [],
        trigger_url: null,
        trigger_source: 'webhook',
        instance_id: 'server',
      }),
    };
    await expect(reconcileWebhookAwaitingApprovalDispatches(h.consumerStore, auditLog))
      .resolves.toMatchObject({ in_doubt: 1, failed: 0 });
    expect(targets(h.db)).toEqual([expect.objectContaining({
      state: 'dead_letter', last_error_code: 'approved_run_in_doubt',
    })]);
    expect(pins(h.db)).toBe(1);
    // The dead letter alone never runs it again.
    expect(rerunFlags(h.db)).toEqual([null]);
    return { h, runId: held.run_id };
  };

  const tryAgain = (h: Awaited<ReturnType<typeof makeHarness>>) => {
    const row = h.db.prepare(`
      SELECT dispatch_id, updated_at FROM webhook_recipe_dispatches
    `).get() as { dispatch_id: string; updated_at: number };
    h.consumerStore.requeueDeadLetterTarget({
      dispatch_id: row.dispatch_id,
      ingress_id: (h.db.prepare('SELECT ingress_id FROM webhook_ingresses').get() as { ingress_id: string }).ingress_id,
      dead_lettered_at: row.updated_at,
      actor_kind: 'owner',
      actor_instance_id: 'owner-device',
      reason: null,
    });
  };

  it("runs again on its run id once the owner tries it again, and the owner's say-so goes once it has run", async () => {
    const { h, runId } = await inDoubtDeadLetter();
    tryAgain(h);
    expect(rerunFlags(h.db)).toEqual([expect.any(Number)]);
    const ran: WebhookRecipeRunRequest[] = [];
    const worker = createWebhookRecipeDispatchRuntime({
      ...h,
      runner: { run: async (run) => { ran.push(run); return 'completed'; } },
    }, { poll_interval_ms: 60_000 });
    cleanups.push(() => worker.stop());
    await expect(worker.drain()).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(ran).toEqual([expect.objectContaining({ run_id: runId, rerun_in_doubt: true })]);
    expect(rerunFlags(h.db)).toEqual([null]);
  });

  it("keeps the owner's say-so through a failure before a new run record, and drops it after the run's own failure", async () => {
    const { h, runId } = await inDoubtDeadLetter();
    tryAgain(h);
    const after = handSettledRunner();
    const runtime = startDelivery(h, after.runner);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(after.calls[0]!.run).toMatchObject({ run_id: runId, rerun_in_doubt: true });
    after.calls[0]!.settle(new WebhookRunNotRestartedError(new Error('door authority changed; re-save the recipe')));
    await vi.advanceTimersByTimeAsync(0);
    expect(rerunFlags(h.db)).toEqual([expect.any(Number)]);
    await vi.advanceTimersByTimeAsync(WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS[0]! + 1_000);
    expect(after.calls[1]!.run).toMatchObject({ run_id: runId, rerun_in_doubt: true });
    after.calls[1]!.settle(new Error('the provider is down'));
    await vi.advanceTimersByTimeAsync(0);
    expect(rerunFlags(h.db)).toEqual([null]);
    await runtime.stop();
  });

  it('a hold reached on the rerun drops it too: the owner decides again from there', async () => {
    const { h } = await inDoubtDeadLetter();
    tryAgain(h);
    const worker = createWebhookRecipeDispatchRuntime({
      ...h,
      runner: { run: async () => 'awaiting_approval' },
    }, { poll_interval_ms: 60_000 });
    cleanups.push(() => worker.stop());
    await expect(worker.drain()).resolves.toMatchObject({ claimed: 1, awaiting_approval: 1 });
    expect(rerunFlags(h.db)).toEqual([null]);
  });
});

// D-201 Slice 10AG — the reconcile's own rules, over stub stores.
describe('D-201 Slice 10AG — the reconcile of runs kept or held (10AE findings 2, 12 and 13)', () => {
  const dispatch = (runId: string, marked: boolean) => ({
    dispatch_id: `dispatch-${runId}`,
    run_id: runId,
    recipe_id: 'recipe',
    restart_interrupted: marked,
  });
  const anchor = (runId: string, commitStatus: AuditEntry['commit_status'], errors: AuditEntry['errors'] = []): AuditEntry => ({
    run_id: runId,
    recipe_id: 'recipe',
    recipe_hash: 'hash',
    started_at: 1,
    finished_at: 2,
    duration_ms: 1,
    commit_status: commitStatus,
    config_snapshot: {},
    errors,
    trigger_url: null,
    trigger_source: 'webhook',
    instance_id: 'server',
  });

  it('a killed run kept for the replay waits, marked or not, its mark gone; one that finished resolves; a held failure is the dead letter, unless the owner declined', async () => {
    const resolved: Array<[string, string]> = [];
    const cleared: string[] = [];
    const store = {
      takeAwaitingApprovalDispatches: () => [
        dispatch('killed-kept', true),
        dispatch('unmarked-kept', false),
        dispatch('succeeded-kept', false),
        dispatch('failed-held', false),
        dispatch('declined-held', false),
      ],
      resolveAwaitingApprovalDispatch: (input: { run_id: string; outcome: string }) => {
        resolved.push([input.run_id, input.outcome]);
        return true;
      },
      clearHeldRestartMark: (input: { run_id: string }) => { cleared.push(input.run_id); return true; },
    };
    const records: Record<string, AuditEntry> = {
      'killed-kept': anchor('killed-kept', 'killed'),
      'unmarked-kept': anchor('unmarked-kept', 'killed'),
      'succeeded-kept': anchor('succeeded-kept', 'succeeded'),
      'failed-held': anchor('failed-held', 'failed'),
      'declined-held': anchor('declined-held', 'failed', [{
        error_id: 'declined',
        code: 'RECIPE_POLICY_DENIED',
        message: 'The owner declined it.',
        severity: 'fatal',
        source: { recipe_id: 'recipe', step_id: 'close_again', ingredient_slug: null },
        details: { denied_by: 'owner' },
        timestamp: new Date(0).toISOString(),
        retryable: false,
      }]),
    };
    await expect(reconcileWebhookAwaitingApprovalDispatches(
      store as never,
      { get: async (runId: string) => records[runId] ?? null },
      { hasKeptRun: (runId) => runId.endsWith('-kept'), isHeldFailure: (runId) => runId.endsWith('-held') },
    )).resolves.toEqual({ scanned: 5, waiting: 2, succeeded: 1, failed: 1, interrupted: 0, in_doubt: 1 });
    // Only a killed run waits for the replay, and its mark goes: the owner's
    // Stop of that replay is the owner's (finding 12).
    expect(cleared).toEqual(['killed-kept']);
    expect(resolved).toEqual([
      ['succeeded-kept', 'succeeded'],
      ['failed-held', 'in_doubt'],
      ['declined-held', 'failed'],
    ]);
  });
});

// ── D-201 Slice 10AP — the reconcile's rules, away from the refund lane ──────

describe("D-201 Slice 10AP — the reconcile's rules for held runs, each its own (10AM findings 3, 5, 18 and 20)", () => {
  type RunError = NonNullable<AuditEntry['errors']>[number];
  const refusal = (stepId: string, details: Record<string, unknown>, code = 'RECIPE_POLICY_DENIED'): RunError => ({
    error_id: `error-${stepId}`,
    code: code as RunError['code'],
    message: 'refused',
    severity: 'fatal' as const,
    source: { recipe_id: 'recipe', step_id: stepId, ingredient_slug: null },
    details,
    timestamp: new Date(0).toISOString(),
    retryable: false,
  });
  const anchor = (runId: string, ranUnder: string, errors: AuditEntry['errors']): AuditEntry => ({
    run_id: runId,
    recipe_id: 'recipe',
    recipe_hash: 'hash',
    started_at: 1,
    finished_at: 2,
    duration_ms: 1,
    commit_status: 'failed',
    config_snapshot: {},
    errors,
    trigger_url: null,
    trigger_source: 'webhook',
    instance_id: 'server',
    execution_source: { channel: 'webhook', actor: 'webhook', vendor: 'stripe', contract_id: ranUnder } as never,
  });
  const doors: Record<string, { revoked_at?: number; revocation_reason?: string }> = {
    'live-door': {},
    'owner-closed': { revoked_at: 5, revocation_reason: OWNER_DOOR_CLOSE_REASON },
    'retired-by-recued': { revoked_at: 5, revocation_reason: 'pack_connections_changed' },
  };
  const runs = [
    // [run, the door it ran under, its errors, the door its delivery goes through now, the outcome]
    ['held-failure', 'live-door', [], 'live-door', 'in_doubt'],
    ['declined', 'live-door', [refusal('close_again', { denied_by: 'owner' })], 'live-door', 'failed'],
    ['expired', 'live-door', [refusal('close_again', {}, 'RECIPE_APPROVAL_TIMEOUT')], 'live-door', 'failed'],
    ['door-closed', 'owner-closed', [refusal('close_again', {})], 'owner-closed', 'failed'],
    ['operation-off', 'live-door', [refusal('close_again', {})], 'live-door', 'failed'],
    // Finding 3: Recued replaced the door, and its owner closed the new one.
    ['replaced-then-closed', 'retired-by-recued', [refusal('close_again', {})], 'owner-closed', 'failed'],
    // Recued's own replacement, the new door open: held for a try again under it.
    ['replaced-left-open', 'retired-by-recued', [refusal('close_again', {})], 'live-door', 'in_doubt'],
  ] as const;

  it('reads each held run by its own rule: the owner declining, an ask expiring, their door then or now, Recued replacing it', async () => {
    const resolved: Array<[string, string]> = [];
    const store = {
      takeAwaitingApprovalDispatches: () => runs.map(([runId]) => ({
        dispatch_id: `dispatch-${runId}`, run_id: runId, recipe_id: 'recipe', restart_interrupted: false,
      })),
      resolveAwaitingApprovalDispatch: (input: { run_id: string; outcome: string }) => {
        resolved.push([input.run_id, input.outcome]);
        return true;
      },
      clearHeldRestartMark: () => true,
    };
    const nowThrough = new Map<string, string>(runs.map(([runId, , , now]) => [runId, now]));
    const options = heldRunReconcileOptions(
      { hasKeptRun: () => false, isHeldFailure: () => true },
      { get: (id: string) => (doors[id] === undefined ? null : doors[id]) as never },
      {
        consumerStore: {
          doorOwnerOfRun: (runId: string) => ({
            consumer_kind: 'pack_install' as const, consumer_id: 'refunds', recipe_id: 'recipe', publisher_id: runId,
          }),
          // The publisher names the run here, so each reads its own door now.
          doorContractIdForRecipe: (_kind: string, _id: string, _recipe: string, publisher: string) =>
            nowThrough.get(publisher) ?? null,
        },
      },
    );
    await expect(reconcileWebhookAwaitingApprovalDispatches(
      store as never,
      { get: async (runId: string) => {
        const run = runs.find(([id]) => id === runId)!;
        return anchor(run[0], run[1], [...run[2]]);
      } },
      options,
    )).resolves.toMatchObject({ scanned: runs.length, in_doubt: 2, failed: runs.length - 2 });
    expect(resolved).toEqual(runs.map(([runId, , , , outcome]) => [runId, outcome]));
  });

  it('a run whose resume is still under way waits, its record read only once the resume is done', async () => {
    const read: string[] = [];
    const store = {
      takeAwaitingApprovalDispatches: () => [
        { dispatch_id: 'dispatch-resuming', run_id: 'resuming', recipe_id: 'recipe', restart_interrupted: false },
      ],
      resolveAwaitingApprovalDispatch: () => true,
      clearHeldRestartMark: () => true,
    };
    await expect(reconcileWebhookAwaitingApprovalDispatches(
      store as never,
      { get: async (runId: string) => { read.push(runId); return null; } },
      heldRunReconcileOptions(
        { hasKeptRun: () => false, isHeldFailure: () => true },
        { get: () => null },
        { isResuming: (runId) => runId === 'resuming' },
      ),
    )).resolves.toMatchObject({ scanned: 1, waiting: 1, failed: 0 });
    expect(read).toEqual([]);
  });
});
