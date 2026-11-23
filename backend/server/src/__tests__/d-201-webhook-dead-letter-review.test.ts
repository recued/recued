/** D-201 Slice 10B — owner review of dead letters, and their capacity.
 *
 * The post-9BQ audit failed Gate 22: a dead letter could be neither tried again
 * nor closed, stayed protected forever, and counted inside the same 10,000-row
 * intake capacity as live work, so enough of them stopped all new deliveries
 * for good. Since Slice 10A a dead letter is either an event whose handoff to
 * its recipes kept failing (`event`) or one recipe's run that spent its
 * attempts (`target`). These cover §14.1's list on the real stores: a dead
 * letter tried again after a transient failure and recovered on the same run,
 * repeated and stale actions, authority loss, a webhook switched off or
 * retired, a reviewed close, the payload pin and retention, a restart, what an
 * action records and returns, and intake with more dead letters than the
 * active backlog allows. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RpcError,
  type PackWebhookRequirement,
  type RecipeDefinition,
} from '@recued/contracts';
import { createRecipeStore } from '../recipe-store.js';
import { createWebhookConsumerStore, isPassingStoreFault } from '../storage/webhook-consumer-store.js';
import {
  createWebhookDeliveryStore,
  type WebhookAcceptedDeliveryInput,
} from '../storage/webhook-delivery-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { listWebhookDeadLetterReviews } from '../storage/webhook-dead-letter-reviews.js';
import {
  createWebhookRecipeOutboxSink,
  type WebhookRecipeRunner,
} from '../webhook-recipe-consumer.js';
import { dispatchWebhookOutboxOnce, type WebhookEventOutboxSink } from '../webhook-outbox-dispatcher.js';
import { createWebhookRecipeDispatchRuntime } from '../webhook-recipe-dispatch-worker.js';
import {
  WEBHOOK_DEAD_LETTER_LIMIT_REASON,
  createWebhookDeadLetterService,
} from '../webhook-dead-letter-service.js';
import {
  handleWebhookDeadLetterList,
  handleWebhookDeadLetterRequeue,
  handleWebhookDeadLetterResolve,
  handleWebhookDeliveryGet,
  handleWebhookIngressList,
  handleWebhookIngressRetire,
  type WebhookIngressRpcDeps,
} from '../webhook-ingress-handler.js';
import { handleLocalRecipeWebhookArm, handleLocalRecipeWebhookDisarm, saveRecipeInline } from '../recipe-save-handler.js';
import { deleteRecipe } from '../recipe-delete-handler.js';
import { finishWebhookReplacementsAtStart } from '../webhook-replacement-finish.js';
import { WebhookManagedRegistrationError } from '../webhook-registration-reconciler.js';

const T0 = 2_100_000_000_000;
const PACK_SLUG = 'dead-letter-review-pack';
const PUBLISHER = 'fixture-publisher';
const PROFILE = 'generic.static-header-token.v1';
const OWNER = { instance_id: 'owner-webclient' };

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
    description: 'D-201 Slice 10B fixture',
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

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

const openStores = (
  db: Database.Database,
  clock: { now: number },
  options: { maxOutboxBacklog?: number; payloadRetentionMs?: number } = {},
) => {
  const ingressStore = createWebhookIngressStore(db, {
    now: () => clock.now,
    getEncryptionKey: () => new Uint8Array(32).fill(71),
  });
  const consumerStore = createWebhookConsumerStore(db, {
    ingressStore,
    now: () => clock.now,
  });
  const deliveryStore = createWebhookDeliveryStore(db, {
    now: () => clock.now,
    getEncryptionKey: () => new Uint8Array(32).fill(83),
    hasDispatchTarget: (ingressId, eventType) =>
      consumerStore.hasDispatchTarget(ingressId, eventType),
    countActiveConsumerWork: () => consumerStore.countActiveDispatchEvents(),
    // D-201 Slice 10F — as `compose-app-context.ts` wires them.
    onDeadLetterEventClosed: (eventId) => { consumerStore.closeTargetsOfClosedEvent(eventId); },
    onDeadLetterEventRequeued: (eventId) => { consumerStore.refreshTargetsOfRequeuedEvent(eventId); },
    eventHasCurrentRecipe: (eventId) => consumerStore.eventHasCurrentRecipe(eventId),
    pruneConsumerRows: () => { consumerStore.pruneDispatchesWithoutEvents(); },
    ...(options.maxOutboxBacklog !== undefined ? { maxOutboxBacklog: options.maxOutboxBacklog } : {}),
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
  limit?: number;
} = {}) => {
  const db = input.db ?? new Database(':memory:');
  if (!input.db) databases.push(db);
  const clock = { now: T0 - 1_000 };
  const stores = openStores(db, clock, input);
  const recipeStore = createRecipeStore('/path/that/does/not/exist', db);
  const ingress = stores.ingressStore.create({
    display_name: 'Dead letter fixture',
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
  `).run(clock.now, ingress.ingress_id);
  const recipeIds = input.recipeIds ?? ['recipe-a'];
  for (const recipeId of recipeIds) {
    recipeStore.save(recipe(recipeId), PUBLISHER, 'pair-sync', clock.now, PACK_SLUG);
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
  clock.now = T0;
  return { db, clock, ingressId: ingress.ingress_id, ...withService(stores, ingress.ingress_id, clock, input.limit) };
};

/** The dead-letter service, the RPC deps and an accept over a set of stores,
 *  as `compose-listeners.ts` composes them. */
const withService = (
  stores: ReturnType<typeof openStores>,
  ingressId: string,
  clock: { now: number },
  limit?: number,
) => {
  const deadLetters = createWebhookDeadLetterService({
    deliveryStore: stores.deliveryStore,
    consumerStore: stores.consumerStore,
    isIngressRetired: (id) => stores.ingressStore.get(id)?.intake_state === 'retired',
    ...(limit !== undefined ? { limit } : {}),
  });
  const deps: WebhookIngressRpcDeps = {
    store: stores.ingressStore,
    deliveryStore: stores.deliveryStore,
    deadLetters,
    countConsumerBindings: (id) => stores.consumerStore.listBindings()
      .filter((binding) => binding.ingress_id === id).length,
  };
  const accept = async (suffix: string) => {
    const delivery: WebhookAcceptedDeliveryInput = {
      ingress_id: ingressId,
      profile_id: PROFILE,
      environment: 'test',
      received_at: clock.now,
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
        decoded_payload_json: JSON.stringify({ private_value: `secret-${suffix}` }),
      }],
    };
    return (await stores.deliveryStore.accept(delivery)).fresh_events[0]!;
  };
  return { ...stores, deadLetters, deps, accept };
};

type Harness = Awaited<ReturnType<typeof makeHarness>>;

/** The same database opened again, by the next process (its schema steps run),
 *  which finishes what the last one left between a webhook replacement and its
 *  finalize before anything runs, as `compose-listeners.ts` composes the start
 *  (D-201 Slice 10U). No door substrate here: a replacement finishes with no
 *  door, as these saves make none. `finish: false` — a record made after the
 *  start (a failed save whose restore failed too). */
const reopen = (
  h: Pick<Harness, 'db' | 'clock' | 'ingressId'>,
  options: { maxOutboxBacklog?: number; payloadRetentionMs?: number; limit?: number; finish?: boolean } = {},
): Harness => {
  const stores = openStores(h.db, h.clock, options);
  if (options.finish !== false) {
    finishWebhookReplacementsAtStart({
      consumerStore: stores.consumerStore,
      recipes: createRecipeStore('/path/that/does/not/exist', h.db),
    });
  }
  return {
    db: h.db,
    clock: h.clock,
    ingressId: h.ingressId,
    ...withService(stores, h.ingressId, h.clock, options.limit),
  };
};

const failing: WebhookRecipeRunner = {
  run: async () => { throw new Error('the provider is down'); },
};

const handOff = (h: Pick<Harness, 'deliveryStore' | 'consumerStore'>, sink?: WebhookEventOutboxSink) =>
  dispatchWebhookOutboxOnce(
    h.deliveryStore,
    sink ?? createWebhookRecipeOutboxSink(h.consumerStore),
    { base_retry_ms: 0, max_retry_ms: 0, max_attempts: 2 },
  );

/** Run every runnable target with `runner`, failing ones retried at once
 *  until their two attempts are spent. */
const runTargets = (h: Pick<Harness, 'deliveryStore' | 'consumerStore'>, runner: WebhookRecipeRunner) =>
  createWebhookRecipeDispatchRuntime(
    { consumerStore: h.consumerStore, deliveryStore: h.deliveryStore, runner },
    { base_retry_ms: 0, max_retry_ms: 0, max_attempts: 2 },
  ).drain();

/** One accepted event whose only target spent its attempts. */
const targetDeadLetter = async (h: Harness, suffix: string) => {
  const event = await h.accept(suffix);
  await handOff(h);
  await runTargets(h, failing);
  const page = await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId, limit: 50 }, OWNER);
  const found = page.dead_letters.find((row) => row.kind === 'target' && row.event_id === event.event_id);
  if (found === undefined) throw new Error(`no dead letter for '${suffix}'`);
  return found;
};

const dispatchRow = (h: Harness, dispatchId: string) => h.db.prepare(`
  SELECT state, attempt_count, resolved_at, run_id FROM webhook_recipe_dispatches WHERE dispatch_id = ?
`).get(dispatchId) as { state: string; attempt_count: number; resolved_at: number | null; run_id: string };

const pinned = (h: Harness, dispatchId: string): boolean =>
  h.db.prepare('SELECT 1 FROM webhook_payload_pins WHERE pin_id = ?').get(dispatchId) !== undefined;

describe('D-201 Slice 10B — dead letters the owner can try again or close', () => {
  it('tries a target dead letter again after a transient failure: the same run recovers it', async () => {
    const h = await makeHarness();
    const deadLetter = await targetDeadLetter(h, 'transient');
    expect(deadLetter).toMatchObject({
      kind: 'target',
      recipe_id: 'recipe-a',
      attempt_count: 2,
      last_error_code: 'run_failed',
      payload_retained: true,
    });
    const before = dispatchRow(h, deadLetter.dead_letter_id);

    h.clock.now += 5_000;
    const result = await handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'target', dead_letter_id: deadLetter.dead_letter_id },
      dead_lettered_at: deadLetter.dead_lettered_at,
      reason: 'The provider is back',
    }, OWNER);
    // Identifiers, status and the time only.
    expect(Object.keys(result).sort()).toEqual(['acted_at', 'dead_letter', 'outcome', 'review_id']);
    expect(result).toMatchObject({ outcome: 'requeued', acted_at: h.clock.now });
    expect(dispatchRow(h, deadLetter.dead_letter_id)).toMatchObject({
      state: 'pending',
      attempt_count: 0,
      resolved_at: null,
      run_id: before.run_id,
    });
    expect(pinned(h, deadLetter.dead_letter_id)).toBe(true);
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id }))
      .toEqual([expect.objectContaining({
        action: 'requeue',
        actor_kind: 'owner',
        actor_instance_id: OWNER.instance_id,
        reason: 'The provider is back',
        attempt_count: 2,
        created_at: h.clock.now,
      })]);

    const runs: string[] = [];
    await expect(runTargets(h, { run: async (run) => { runs.push(run.run_id); return 'completed'; } }))
      .resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(runs).toEqual([before.run_id]);
    expect(dispatchRow(h, deadLetter.dead_letter_id)).toMatchObject({ state: 'dispatched', attempt_count: 1 });
    expect(pinned(h, deadLetter.dead_letter_id)).toBe(false);
  });

  it('refuses a repeated or stale action, and one through another webhook', async () => {
    const h = await makeHarness();
    const deadLetter = await targetDeadLetter(h, 'repeated');
    const ref = { kind: 'target' as const, dead_letter_id: deadLetter.dead_letter_id };
    await handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId, dead_letter: ref, dead_lettered_at: deadLetter.dead_lettered_at,
    }, OWNER);
    // Again: it is pending now, not a dead letter.
    await expect(handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId, dead_letter: ref, dead_lettered_at: deadLetter.dead_lettered_at,
    }, OWNER)).rejects.toMatchObject({ code: 'webhook_dead_letter_settled', status: 409 });
    await expect(handleWebhookDeadLetterResolve(h.deps, {
      ingress_id: h.ingressId, dead_letter: ref, dead_lettered_at: deadLetter.dead_lettered_at, reason: 'late',
    }, OWNER)).rejects.toMatchObject({ code: 'webhook_dead_letter_settled' });

    // It fails again and dead-letters anew: the old view is stale.
    h.clock.now += 1_000;
    await runTargets(h, failing);
    const again = (await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER)).dead_letters[0]!;
    expect(again.dead_lettered_at).toBeGreaterThan(deadLetter.dead_lettered_at);
    await expect(handleWebhookDeadLetterResolve(h.deps, {
      ingress_id: h.ingressId, dead_letter: ref, dead_lettered_at: deadLetter.dead_lettered_at, reason: 'old view',
    }, OWNER)).rejects.toMatchObject({ code: 'webhook_dead_letter_stale', status: 409 });

    // Through another webhook's id: not found, never acted on.
    const other = h.ingressStore.create({
      display_name: 'Another webhook',
      profile_id: PROFILE,
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    });
    h.db.prepare(`UPDATE webhook_ingresses SET intake_state = 'enabled' WHERE ingress_id = ?`).run(other.ingress_id);
    await expect(handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: other.ingress_id, dead_letter: ref, dead_lettered_at: again.dead_lettered_at,
    }, OWNER)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(dispatchRow(h, deadLetter.dead_letter_id).state).toBe('dead_letter');
  });

  it('re-derives authority when a dead letter tried again runs, and an uninstall closes it first', async () => {
    const h = await makeHarness();
    const disarmed = await targetDeadLetter(h, 'disarmed');
    await handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'target', dead_letter_id: disarmed.dead_letter_id },
      dead_lettered_at: disarmed.dead_lettered_at,
    }, OWNER);
    // The owner disarms the pack's webhook recipes before it runs.
    h.consumerStore.setConsumerEnabled('pack_install', PACK_SLUG, false);
    const ran: string[] = [];
    await expect(runTargets(h, { run: async (run) => { ran.push(run.run_id); return 'completed'; } }))
      .resolves.toMatchObject({ claimed: 0 });
    expect(ran).toEqual([]);
    expect(dispatchRow(h, disarmed.dead_letter_id).state).toBe('cancelled');
    expect(pinned(h, disarmed.dead_letter_id)).toBe(false);

    const second = await makeHarness();
    const uninstalled = await targetDeadLetter(second, 'uninstalled');
    second.consumerStore.removeConsumer('pack_install', PACK_SLUG);
    // Slice 10F — closed, with a record that says why, not silently cancelled.
    expect(dispatchRow(second, uninstalled.dead_letter_id)).toMatchObject({
      state: 'dead_letter',
      resolved_at: expect.any(Number),
    });
    expect(listWebhookDeadLetterReviews(second.db, { kind: 'target', id: uninstalled.dead_letter_id }).at(-1))
      .toMatchObject({ action: 'expire', actor_kind: 'server', reason: 'recipe_removed' });
    expect(pinned(second, uninstalled.dead_letter_id)).toBe(false);
    await expect(handleWebhookDeadLetterRequeue(second.deps, {
      ingress_id: second.ingressId,
      dead_letter: { kind: 'target', dead_letter_id: uninstalled.dead_letter_id },
      dead_lettered_at: uninstalled.dead_lettered_at,
    }, OWNER)).rejects.toMatchObject({ code: 'webhook_dead_letter_settled' });
  });

  it('tries nothing again on a webhook that is switched off, and still closes one on a retired webhook', async () => {
    const h = await makeHarness();
    const deadLetter = await targetDeadLetter(h, 'switched-off');
    const ref = { kind: 'target' as const, dead_letter_id: deadLetter.dead_letter_id };
    h.db.prepare(`UPDATE webhook_ingresses SET intake_state = 'disabled' WHERE ingress_id = ?`).run(h.ingressId);
    await expect(handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId, dead_letter: ref, dead_lettered_at: deadLetter.dead_lettered_at,
    }, OWNER)).rejects.toMatchObject({ code: 'webhook_ingress_not_receiving', status: 409 });
    h.db.prepare(`UPDATE webhook_ingresses SET intake_state = 'retired' WHERE ingress_id = ?`).run(h.ingressId);
    await expect(handleWebhookDeadLetterResolve(h.deps, {
      ingress_id: h.ingressId, dead_letter: ref, dead_lettered_at: deadLetter.dead_lettered_at,
      reason: 'This webhook is gone',
    }, OWNER)).resolves.toMatchObject({ outcome: 'resolved' });
  });

  it('closes a target dead letter as a reviewed end: kept, unpinned, out of the list, untouched by an uninstall', async () => {
    const h = await makeHarness({ payloadRetentionMs: 10 });
    const deadLetter = await targetDeadLetter(h, 'reviewed');
    // Pinned past its retention while it waits for review.
    h.clock.now += 1_000;
    expect(h.deliveryStore.prune()).toMatchObject({ payloads_deleted: 0 });
    await expect(handleWebhookDeadLetterResolve(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'target', dead_letter_id: deadLetter.dead_letter_id },
      dead_lettered_at: deadLetter.dead_lettered_at,
    }, OWNER)).rejects.toMatchObject({ code: 'bad_request' });
    const result = await handleWebhookDeadLetterResolve(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'target', dead_letter_id: deadLetter.dead_letter_id },
      dead_lettered_at: deadLetter.dead_lettered_at,
      reason: '  Refunded the customer by hand  ',
    }, OWNER);
    expect(result).toMatchObject({ outcome: 'resolved' });
    // Its row stays, as a dead letter that was closed; nothing says it ran.
    expect(dispatchRow(h, deadLetter.dead_letter_id)).toMatchObject({
      state: 'dead_letter',
      resolved_at: h.clock.now,
    });
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id }))
      .toEqual([expect.objectContaining({ action: 'resolve', reason: 'Refunded the customer by hand' })]);
    expect(pinned(h, deadLetter.dead_letter_id)).toBe(false);
    await expect(handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER))
      .resolves.toMatchObject({ dead_letters: [], review: { unresolved: 0 } });
    // An uninstall cancels unresolved work; a closed dead letter stays closed.
    h.consumerStore.removeConsumer('pack_install', PACK_SLUG);
    expect(dispatchRow(h, deadLetter.dead_letter_id)).toMatchObject({ state: 'dead_letter' });
    // Its payload follows its retention now, and (Slice 10F) its row and its
    // review record go with its event, which this prune deletes too.
    expect(h.deliveryStore.prune()).toMatchObject({ payloads_deleted: 1, events_deleted: 1 });
    expect(dispatchRow(h, deadLetter.dead_letter_id)).toBeUndefined();
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id }))
      .toEqual([]);
  });

  it('tries an event dead letter again from its handoff, and closes one so its rows can go', async () => {
    const h = await makeHarness({ payloadRetentionMs: 10 });
    let failHandoff = true;
    const sink = createWebhookRecipeOutboxSink({
      prepareDispatches(input) {
        if (failHandoff) throw new Error('the targets could not be written');
        return h.consumerStore.prepareDispatches(input);
      },
    });
    await h.accept('handoff-a');
    await h.accept('handoff-b');
    await handOff(h, sink);
    await handOff(h, sink);
    const page = await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER);
    expect(page.dead_letters.map((row) => [row.kind, row.recipe_id, row.attempt_count, row.last_error_code]))
      .toEqual([['event', null, 2, 'dispatch_failed'], ['event', null, 2, 'dispatch_failed']]);
    const [first, second] = page.dead_letters;

    // Tried again: pending under the same event, fresh attempts; the handoff
    // now writes its targets, and its recipe runs.
    failHandoff = false;
    await handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'event', dead_letter_id: first!.dead_letter_id },
      dead_lettered_at: first!.dead_lettered_at,
    }, OWNER);
    await expect(handOff(h, sink)).resolves.toMatchObject({ claimed: 1, dispatched: 1 });
    await expect(runTargets(h, { run: async () => 'completed' }))
      .resolves.toMatchObject({ completed: 1 });

    // Closed: the outbox row and the event keep their state and gain the time.
    const closed = await handleWebhookDeadLetterResolve(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'event', dead_letter_id: second!.dead_letter_id },
      dead_lettered_at: second!.dead_lettered_at,
      reason: 'Sent before the recipe existed',
    }, OWNER);
    expect(closed).toMatchObject({ outcome: 'resolved' });
    const deliveryId = second!.delivery_id;
    const detail = await handleWebhookDeliveryGet(h.deps, {
      ingress_id: h.ingressId,
      delivery_id: deliveryId,
    }, OWNER);
    expect(detail.detail.events[0]).toMatchObject({ dispatch_state: 'resolved' });
    expect(h.deliveryStore.listOutbox().find((row) => row.outbox_id === second!.dead_letter_id))
      .toMatchObject({ state: 'dead_letter' });
    // Past its retention every row of it can go.
    h.clock.now += 200;
    const pruned = h.deliveryStore.prune();
    expect(pruned.outbox_rows_deleted).toBeGreaterThanOrEqual(1);
    expect(h.deliveryStore.getEvent(second!.event_id)).toBeNull();
  });

  it('accepts new deliveries with more dead letters than the active backlog allows', async () => {
    const h = await makeHarness({ maxOutboxBacklog: 2 });
    for (const suffix of ['d1', 'd2', 'd3']) await targetDeadLetter(h, suffix);
    expect(h.deadLetters.summary()).toEqual({ unresolved: 3, limit: 1_000 });
    expect(h.consumerStore.countActiveDispatchEvents()).toBe(0);
    await expect(h.accept('still-accepted')).resolves.toMatchObject({ dispatch_state: 'pending' });
    await expect(h.accept('second-active')).resolves.toMatchObject({ dispatch_state: 'pending' });
    // Live work still has its bound.
    await expect(h.accept('over-capacity')).rejects.toMatchObject({ code: 'backpressure' });
  });

  it('closes the oldest past the review limit, recording that the limit did', async () => {
    const h = await makeHarness({ limit: 2 });
    const oldest = await targetDeadLetter(h, 'oldest');
    h.clock.now += 1_000;
    await targetDeadLetter(h, 'middle');
    h.clock.now += 1_000;
    await targetDeadLetter(h, 'newest');
    expect(h.deadLetters.summary()).toEqual({ unresolved: 3, limit: 2 });
    expect(h.deadLetters.enforceReviewLimit()).toBe(1);
    expect(h.deadLetters.summary()).toEqual({ unresolved: 2, limit: 2 });
    expect(dispatchRow(h, oldest.dead_letter_id)).toMatchObject({ state: 'dead_letter', resolved_at: h.clock.now });
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: oldest.dead_letter_id }))
      .toEqual([expect.objectContaining({
        action: 'expire',
        actor_kind: 'server',
        actor_instance_id: null,
        reason: WEBHOOK_DEAD_LETTER_LIMIT_REASON,
      })]);
    expect(h.deadLetters.enforceReviewLimit()).toBe(0);
    const ingresses = await handleWebhookIngressList(h.deps, undefined, OWNER);
    expect(ingresses.dead_letter_review).toEqual({ unresolved: 2, limit: 2 });
    expect(ingresses.ingresses[0]).toMatchObject({ dead_letters_unresolved: 2 });
  });

  it('pages newest first across both kinds, each one once', async () => {
    const h = await makeHarness({ recipeIds: ['recipe-a', 'recipe-b'] });
    // Two targets per event, and event dead letters, at shared moments.
    await targetDeadLetter(h, 'p1');
    let failHandoff = true;
    const sink = createWebhookRecipeOutboxSink({
      prepareDispatches(input) {
        if (failHandoff) throw new Error('no targets');
        return h.consumerStore.prepareDispatches(input);
      },
    });
    await h.accept('p2');
    await h.accept('p3');
    await handOff(h, sink);
    await handOff(h, sink);
    failHandoff = false;
    const seen: string[] = [];
    let cursor: Awaited<ReturnType<typeof handleWebhookDeadLetterList>>['next_cursor'] = null;
    do {
      const page = await handleWebhookDeadLetterList(h.deps, {
        ingress_id: h.ingressId,
        limit: 1,
        ...(cursor === null ? {} : { cursor }),
      }, OWNER);
      seen.push(...page.dead_letters.map((row) => `${row.kind}:${row.dead_letter_id}`));
      cursor = page.next_cursor;
    } while (cursor !== null && seen.length < 20);
    const all = await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId, limit: 50 }, OWNER);
    expect(all.dead_letters).toHaveLength(4);
    expect(seen).toEqual(all.dead_letters.map((row) => `${row.kind}:${row.dead_letter_id}`));
    expect(new Set(seen).size).toBe(4);
  });

  it('keeps a dead letter tried again across a restart', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const h = await makeHarness({ db });
    const deadLetter = await targetDeadLetter(h, 'restart');
    await handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'target', dead_letter_id: deadLetter.dead_letter_id },
      dead_lettered_at: deadLetter.dead_lettered_at,
    }, OWNER);
    // The next process opens the same database.
    const reopened = openStores(db, h.clock);
    const runs: string[] = [];
    await expect(runTargets(reopened, { run: async (run) => { runs.push(run.run_id); return 'completed'; } }))
      .resolves.toMatchObject({ completed: 1 });
    expect(runs).toEqual([dispatchRow(h, deadLetter.dead_letter_id).run_id]);
  });

  it('answers only the owner, and only well-formed actions', async () => {
    const h = await makeHarness();
    const deadLetter = await targetDeadLetter(h, 'shape');
    const action = {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'target' as const, dead_letter_id: deadLetter.dead_letter_id },
      dead_lettered_at: deadLetter.dead_lettered_at,
    };
    await expect(handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, undefined))
      .rejects.toMatchObject({ code: 'permission_denied', status: 403 });
    await expect(handleWebhookDeadLetterRequeue(h.deps, action, { instance_id: null }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    for (const bad of [
      { ...action, dead_letter: { kind: 'recipe', dead_letter_id: deadLetter.dead_letter_id } },
      { ...action, dead_letter: { kind: 'event', dead_letter_id: deadLetter.dead_letter_id } },
      { ...action, dead_letter: { ...action.dead_letter, extra: true } },
      { ...action, dead_lettered_at: -1 },
      { ...action, reason: 'x'.repeat(501) },
      { ...action, reason: 'line\u0000break' },
      { ...action, run_id: 'chosen-by-the-caller' },
    ]) {
      await expect(handleWebhookDeadLetterRequeue(h.deps, bad as typeof action, OWNER))
        .rejects.toBeInstanceOf(RpcError);
    }
    expect(dispatchRow(h, deadLetter.dead_letter_id).state).toBe('dead_letter');
    // A reason may run over lines.
    await expect(handleWebhookDeadLetterResolve(h.deps, { ...action, reason: 'First line\nsecond line' }, OWNER))
      .resolves.toMatchObject({ outcome: 'resolved' });
  });

  it('keeps what was sent out of what it lists, returns and records', async () => {
    const h = await makeHarness();
    const deadLetter = await targetDeadLetter(h, 'private');
    const page = await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER);
    const resolved = await handleWebhookDeadLetterResolve(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'target', dead_letter_id: deadLetter.dead_letter_id },
      dead_lettered_at: deadLetter.dead_lettered_at,
      reason: 'closing',
    }, OWNER);
    const reviews = listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id });
    for (const shown of [page, resolved, reviews]) {
      expect(JSON.stringify(shown)).not.toContain('secret-private');
      expect(JSON.stringify(shown)).not.toContain('fixture-token');
    }
  });
});

/** D-201 Slice 10F — the dispatch table as v26.11.9 (the release before Slice
 *  10A) made it, copied from that release's `webhook-consumer-store.ts`. */
const V26_11_9_DISPATCH_TABLE = `
  CREATE TABLE webhook_recipe_dispatches (
    dispatch_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    trigger_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    recipe_id TEXT NOT NULL,
    publisher_id TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'dispatched', 'cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    claim_token TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (event_id, trigger_id),
    CHECK ((state = 'running' AND claim_token IS NOT NULL) OR (state <> 'running' AND claim_token IS NULL))
  )`;

/** What a server on v26.11.9 left when a recipe failed every attempt: the
 *  event's outer row dead-lettered after eight tries, and its target back to
 *  `pending` with the eight attempts its claims counted and no pin (that
 *  release's `markDispatchFailed`). A run stopped mid-way (`running`) left
 *  its target running, pinned. */
const v26_11_9DeadLetters = async (
  h: Harness,
  suffixes: readonly string[],
  running: string | null = null,
) => {
  const trigger = h.db.prepare(`
    SELECT trigger_id, binding_id, recipe_id, publisher_id FROM webhook_recipe_triggers LIMIT 1
  `).get() as { trigger_id: string; binding_id: string; recipe_id: string; publisher_id: string };
  const left: Array<{ suffix: string; event_id: string; dispatch_id: string; run_id: string }> = [];
  for (const [index, suffix] of suffixes.entries()) {
    const event = await h.accept(suffix);
    h.db.prepare(`
      UPDATE webhook_event_outbox SET state = 'dead_letter', attempt_count = 8,
        last_error_code = 'dispatch_failed', updated_at = ?
      WHERE event_id = ?
    `).run(h.clock.now, event.event_id);
    h.db.prepare(`UPDATE webhook_accepted_events SET dispatch_state = 'dead_letter' WHERE event_id = ?`)
      .run(event.event_id);
    left.push({
      suffix,
      event_id: event.event_id,
      dispatch_id: `whx_legacy${String(index).padStart(28, '0')}`,
      run_id: `whr_legacy${String(index).padStart(28, '0')}`,
    });
    h.clock.now += 1_000;
  }
  h.db.exec('DROP TABLE webhook_recipe_dispatches');
  h.db.exec(V26_11_9_DISPATCH_TABLE);
  for (const row of left) {
    const isRunning = row.suffix === running;
    h.db.prepare(`
      INSERT INTO webhook_recipe_dispatches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.dispatch_id, row.event_id, trigger.trigger_id, trigger.binding_id,
      trigger.recipe_id, trigger.publisher_id, row.run_id,
      isRunning ? 'running' : 'pending', isRunning ? 3 : 8,
      isRunning ? 'claim-of-a-gone-process' : null, h.clock.now, h.clock.now,
    );
    if (isRunning) {
      h.db.prepare(`
        INSERT INTO webhook_payload_pins (pin_id, event_id, run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(row.dispatch_id, row.event_id, row.run_id, h.clock.now, h.clock.now);
    }
  }
  return left;
};

/** The pack saved again (an update, or the owner's fix), with `changes` to
 *  its webhook requirement: the install and recipe-save handlers' two steps. */
const saveAgain = (
  h: Harness,
  changes: Partial<PackWebhookRequirement> = {},
  recipeIds: readonly string[] = ['recipe-a'],
): void => {
  const prior = h.consumerStore.replaceConsumer({
    consumer_kind: 'pack_install',
    consumer_id: PACK_SLUG,
    requirements: [{ ...requirement, ...changes }],
    selections: [{ binding: 'generic_delivery', ingress_id: h.ingressId }],
    recipes: recipeIds.map((recipeId) => ({
      recipe_id: recipeId,
      publisher_id: PUBLISHER,
      webhook_triggers: recipe(recipeId).webhook_triggers!,
    })),
  });
  h.consumerStore.finalizeConsumerReplacement(prior);
};

const eventDeadLetter = async (h: Harness, suffix: string) => {
  const event = await h.accept(suffix);
  const failingSink = createWebhookRecipeOutboxSink({
    prepareDispatches() { throw new Error('the targets could not be written'); },
  });
  await handOff(h, failingSink);
  await handOff(h, failingSink);
  const page = await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId, limit: 50 }, OWNER);
  const found = page.dead_letters.find((row) => row.kind === 'event' && row.event_id === event.event_id);
  if (found === undefined) throw new Error(`no event dead letter for '${suffix}'`);
  return found;
};

const recording = () => {
  const ran: string[] = [];
  return { ran, runner: { run: async (run: { run_id: string }) => { ran.push(run.run_id); return 'completed' as const; } } };
};

const targetRows = (h: Harness, eventId: string) => h.db.prepare(`
  SELECT dispatch_id, state, attempt_count, trigger_id FROM webhook_recipe_dispatches WHERE event_id = ?
`).all(eventId) as Array<{ dispatch_id: string; state: string; attempt_count: number; trigger_id: string }>;

describe('D-201 Slice 10F — dead letters across upgrades, recipe saves and retirement', () => {
  it("upgraded from v26.11.9: closing one releases its old targets, none holds intake, and one tried again runs at the first try", async () => {
    const before = await makeHarness();
    const [closed, retried, stopped] = await v26_11_9DeadLetters(before, ['closed', 'retried', 'stopped'], 'stopped');
    // The upgraded server opens the same database: every schema step runs.
    const h = reopen(before, { maxOutboxBacklog: 1 });
    // None of their targets can run before it is tried again: not active work.
    expect(h.consumerStore.countActiveDispatchEvents()).toBe(0);
    await expect(h.accept('after-the-upgrade')).resolves.toMatchObject({ event_id: expect.any(String) });

    const open = (await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId, limit: 50 }, OWNER))
      .dead_letters;
    const deadLetterOf = (eventId: string) => open.find((row) => row.event_id === eventId)!;
    for (const legacy of [closed!, stopped!]) {
      const deadLetter = deadLetterOf(legacy.event_id);
      await handleWebhookDeadLetterResolve(h.deps, {
        ingress_id: h.ingressId,
        dead_letter: { kind: 'event', dead_letter_id: deadLetter.dead_letter_id },
        dead_lettered_at: deadLetter.dead_lettered_at,
        reason: 'Old ones from before the update',
      }, OWNER);
      // Its old target is cancelled, and the stopped run's pin goes with it.
      expect(targetRows(h, legacy.event_id)).toEqual([expect.objectContaining({ state: 'cancelled' })]);
      expect(pinned(h, legacy.dispatch_id)).toBe(false);
    }

    const tried = deadLetterOf(retried!.event_id);
    await handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'event', dead_letter_id: tried.dead_letter_id },
      dead_lettered_at: tried.dead_lettered_at,
    }, OWNER);
    // Fresh attempts for its old target; the handoff finds it and it runs.
    expect(targetRows(h, retried!.event_id)).toEqual([expect.objectContaining({ state: 'pending', attempt_count: 0 })]);
    await handOff(h);
    const { ran, runner } = recording();
    await runTargets(h, runner);
    expect(ran).toContain(retried!.run_id);
    expect(targetRows(h, retried!.event_id)).toEqual([expect.objectContaining({ state: 'dispatched', attempt_count: 1 })]);
  });

  it("upgraded from v26.11.9: the first poll's review-limit pass closes the oldest, their old targets with them", async () => {
    const before = await makeHarness();
    const legacy = await v26_11_9DeadLetters(before, ['first', 'second', 'third']);
    const h = reopen(before, { limit: 1 });
    expect(h.deadLetters.enforceReviewLimit()).toBe(2);
    for (const row of legacy.slice(0, 2)) {
      expect(targetRows(h, row.event_id)).toEqual([expect.objectContaining({ state: 'cancelled' })]);
    }
    expect(h.consumerStore.countActiveDispatchEvents()).toBe(0);
    expect(h.deadLetters.summary()).toEqual({ unresolved: 1, limit: 1 });
    const left = (await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER)).dead_letters[0]!;
    expect(left.event_id).toBe(legacy[2]!.event_id);
    await handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'event', dead_letter_id: left.dead_letter_id },
      dead_lettered_at: left.dead_lettered_at,
    }, OWNER);
    await handOff(h);
    const { ran, runner } = recording();
    await runTargets(h, runner);
    expect(ran).toEqual([legacy[2]!.run_id]);
  });

  it('a recipe saved again with the same webhook setup keeps its dead letters and waiting deliveries, and runs them on the saved version', async () => {
    const h = await makeHarness();
    const deadLetter = await targetDeadLetter(h, 'failed-before-the-fix');
    h.clock.now += 1_000;
    const waiting = await h.accept('waiting-at-the-save');
    await handOff(h);
    const [oldTrigger] = targetRows(h, waiting.event_id);
    h.clock.now += 1_000;
    saveAgain(h);
    const [newTrigger] = h.db.prepare('SELECT trigger_id FROM webhook_recipe_triggers').all() as Array<{ trigger_id: string }>;
    expect(newTrigger!.trigger_id).not.toBe(oldTrigger!.trigger_id);
    // Nothing vanished: both are on the saved version's trigger, and nothing
    // was closed for them.
    expect(dispatchRow(h, deadLetter.dead_letter_id)).toMatchObject({ state: 'dead_letter', resolved_at: null });
    expect(targetRows(h, deadLetter.event_id)[0]!.trigger_id).toBe(newTrigger!.trigger_id);
    expect(targetRows(h, waiting.event_id)).toEqual([expect.objectContaining({
      state: 'pending',
      trigger_id: newTrigger!.trigger_id,
    })]);
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id })).toEqual([]);
    // Tried again, the dead letter runs on the saved version, and so does the
    // delivery that was waiting.
    const current = (await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER)).dead_letters[0]!;
    await handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'target', dead_letter_id: current.dead_letter_id },
      dead_lettered_at: current.dead_lettered_at,
    }, OWNER);
    const { ran, runner } = recording();
    await expect(runTargets(h, runner)).resolves.toMatchObject({ completed: 2 });
    expect(ran.sort()).toEqual([dispatchRow(h, deadLetter.dead_letter_id).run_id, targetRowsRunId(h, waiting.event_id)].sort());
  });

  it('a save that only reads less keeps them; one that changes the webhook setup closes them with a record', async () => {
    const h = await makeHarness();
    const kept = await targetDeadLetter(h, 'kept');
    saveAgain(h, { decoded_payload_access: 'metadata_only' });
    expect(dispatchRow(h, kept.dead_letter_id)).toMatchObject({ state: 'dead_letter', resolved_at: null });

    h.clock.now += 1_000;
    const closed = await targetDeadLetter(h, 'closed');
    h.clock.now += 1_000;
    saveAgain(h, { decoded_payload_access: 'metadata_only', environment_policy: 'any' });
    for (const deadLetter of [kept, closed]) {
      expect(dispatchRow(h, deadLetter.dead_letter_id)).toMatchObject({
        state: 'dead_letter',
        resolved_at: h.clock.now,
      });
      expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id }).at(-1))
        .toMatchObject({ action: 'expire', actor_kind: 'server', reason: 'recipe_replaced' });
      expect(pinned(h, deadLetter.dead_letter_id)).toBe(false);
    }
    await expect(handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER))
      .resolves.toMatchObject({ dead_letters: [], review: { unresolved: 0 } });
  });

  it('refuses to try again a message no recipe takes now, and says so', async () => {
    const h = await makeHarness();
    const deadLetter = await eventDeadLetter(h, 'orphaned');
    // The pack is uninstalled: no recipe takes the event any more.
    h.consumerStore.removeConsumer('pack_install', PACK_SLUG);
    await expect(handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'event', dead_letter_id: deadLetter.dead_letter_id },
      dead_lettered_at: deadLetter.dead_lettered_at,
    }, OWNER)).rejects.toMatchObject({ code: 'webhook_dead_letter_no_recipe', status: 409 });
    // Untouched: still open, for the owner to close.
    expect(h.deliveryStore.listOutbox()).toEqual([expect.objectContaining({ state: 'dead_letter' })]);
    expect(h.deadLetters.summary().unresolved).toBe(1);
    await expect(handleWebhookDeadLetterResolve(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'event', dead_letter_id: deadLetter.dead_letter_id },
      dead_lettered_at: deadLetter.dead_lettered_at,
      reason: 'The pack is gone',
    }, OWNER)).resolves.toMatchObject({ outcome: 'resolved' });
  });

  it("retiring a webhook closes its open dead letters with a record, and a stop between the two is caught at the next start", async () => {
    const h = await makeHarness({ payloadRetentionMs: 10 });
    const deadLetter = await eventDeadLetter(h, 'retired');
    h.consumerStore.removeConsumer('pack_install', PACK_SLUG);
    await expect(handleWebhookIngressRetire(h.deps, { ingress_id: h.ingressId }, OWNER))
      .resolves.toMatchObject({ ingress: { intake_state: 'retired' }, dead_letters_closed: 1 });
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'event', id: deadLetter.dead_letter_id }).at(-1))
      .toMatchObject({ action: 'expire', actor_kind: 'server', reason: 'webhook_retired' });
    expect(h.deadLetters.summary()).toEqual({ unresolved: 0, limit: 1_000 });
    // Its payload follows retention now.
    h.clock.now += 1_000;
    expect(h.deliveryStore.prune()).toMatchObject({ payloads_deleted: 1 });

    // Another webhook retired while the process stopped before closing hers.
    const other = await makeHarness();
    await eventDeadLetter(other, 'left-open');
    other.db.prepare(`UPDATE webhook_ingresses SET intake_state = 'retired' WHERE ingress_id = ?`)
      .run(other.ingressId);
    const next = reopen(other);
    expect(next.deadLetters.summary().unresolved).toBe(1);
    expect(next.deadLetters.enforceReviewLimit()).toBe(1);
    expect(next.deadLetters.summary().unresolved).toBe(0);
  });

  it("the start's pass finds a retired webhook's dead letters even behind more than the limit of older ones", async () => {
    const before = await makeHarness({ limit: 1 });
    const older = [];
    for (const suffix of ['older-1', 'older-2', 'older-3']) {
      older.push(await targetDeadLetter(before, suffix));
      before.clock.now += 1_000;
    }
    // A second webhook, retired while the process was stopped, holds the
    // newest dead letter.
    const retired = before.deps.store.create({
      display_name: 'Retired fixture',
      profile_id: PROFILE,
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    });
    const newest = await targetDeadLetter(before, 'newest');
    before.db.prepare('UPDATE webhook_accepted_deliveries SET ingress_id = ? WHERE delivery_id = ?')
      .run(retired.ingress_id, newest.delivery_id);
    before.db.prepare('UPDATE webhook_accepted_events SET ingress_id = ? WHERE event_id = ?')
      .run(retired.ingress_id, newest.event_id);
    before.db.prepare(`UPDATE webhook_ingresses SET intake_state = 'retired' WHERE ingress_id = ?`)
      .run(retired.ingress_id);

    const h = reopen(before, { limit: 1 });
    expect(h.deadLetters.enforceReviewLimit()).toBe(3);
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: newest.dead_letter_id }).at(-1))
      .toMatchObject({ action: 'expire', actor_kind: 'server', reason: 'webhook_retired' });
    // The limit then closes the oldest two, and keeps the newest of the rest.
    for (const deadLetter of older.slice(0, 2)) {
      expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id }).at(-1))
        .toMatchObject({ reason: 'review_limit' });
    }
    expect((await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER)).dead_letters
      .map((row) => row.dead_letter_id)).toEqual([older[2]!.dead_letter_id]);
  });

  it("a retire whose close fails leaves them for the next poll's pass", async () => {
    const h = await makeHarness();
    const deadLetter = await targetDeadLetter(h, 'left-by-a-failed-close');
    expect(h.deadLetters.enforceReviewLimit()).toBe(0);
    h.consumerStore.removeConsumer('pack_install', PACK_SLUG);
    // removeConsumer closed it already; reopen it to stand for one a failed
    // close left behind.
    h.db.prepare('UPDATE webhook_recipe_dispatches SET resolved_at = NULL WHERE dispatch_id = ?')
      .run(deadLetter.dead_letter_id);
    const close = h.consumerStore.closeDeadLetterTargetsForIngress;
    h.consumerStore.closeDeadLetterTargetsForIngress = () => { throw new Error('the database is busy'); };
    try {
      const response = await handleWebhookIngressRetire(h.deps, { ingress_id: h.ingressId }, OWNER);
      expect(response.ingress.intake_state).toBe('retired');
      expect(response.dead_letters_closed).toBeUndefined();
    } finally {
      h.consumerStore.closeDeadLetterTargetsForIngress = close;
    }
    expect(h.deadLetters.summary().unresolved).toBe(1);
    expect(h.deadLetters.enforceReviewLimit()).toBe(1);
    expect(h.deadLetters.summary().unresolved).toBe(0);
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id }).at(-1))
      .toMatchObject({ reason: 'webhook_retired' });
  });

  it('lists the closed ones with who closed them and why', async () => {
    const h = await makeHarness({ limit: 1 });
    const byOwner = await targetDeadLetter(h, 'by-owner');
    await handleWebhookDeadLetterResolve(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'target', dead_letter_id: byOwner.dead_letter_id },
      dead_lettered_at: byOwner.dead_lettered_at,
      reason: 'Refunded by hand',
    }, OWNER);
    h.clock.now += 1_000;
    const byLimit = await targetDeadLetter(h, 'by-limit');
    h.clock.now += 1_000;
    await targetDeadLetter(h, 'still-open');
    expect(h.deadLetters.enforceReviewLimit()).toBe(1);
    const closed = await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId, closed: true }, OWNER);
    expect(closed.dead_letters.map((row) => [row.dead_letter_id, row.closure])).toEqual([
      [byLimit.dead_letter_id, { closed_at: expect.any(Number), closed_by: 'server', reason: 'review_limit' }],
      [byOwner.dead_letter_id, { closed_at: expect.any(Number), closed_by: 'owner', reason: 'Refunded by hand' }],
    ]);
    const open = await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER);
    expect(open.dead_letters).toHaveLength(1);
    expect(open.dead_letters[0]!.closure).toBeUndefined();
    await expect(handleWebhookDeadLetterList(h.deps, {
      ingress_id: h.ingressId,
      closed: 'yes' as unknown as boolean,
    }, OWNER)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('counts and lists the open and the closed dead letters from their own indexes, never a scan of both', async () => {
    const h = await makeHarness();
    // The statements the stores really prepare, read back through the planner.
    const seen: string[] = [];
    const prepare = h.db.prepare.bind(h.db);
    h.db.prepare = ((sql: string) => {
      if (/dead_letter/.test(sql) && !/EXPLAIN/.test(sql)) seen.push(sql);
      return prepare(sql);
    }) as typeof h.db.prepare;
    try {
      h.deadLetters.summary();
      h.deadLetters.enforceReviewLimit();
      h.deadLetters.list({ ingress_id: h.ingressId, limit: 10 });
      h.deadLetters.list({ ingress_id: h.ingressId, limit: 10, closed: true });
      // Slice 10I (10H finding 12): the retire close's reads too.
      h.deadLetters.closeForRetiredIngress(h.ingressId);
    } finally {
      h.db.prepare = prepare;
    }
    // The reads only (a close also writes rows by id), each with its own
    // parameters bound: positional ones as many as it has, named ones by name.
    const reads = seen.filter((sql) => /^\s*SELECT/i.test(sql));
    const plans = reads.map((sql) => {
      const positional = (sql.match(/\?/g) ?? []).length;
      const named = Object.fromEntries((sql.match(/@[a-z_]+/g) ?? [])
        .map((name) => [name.slice(1), name === '@ingress_id' ? h.ingressId : 10]));
      const statement = h.db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
      const rows = (positional > 0
        ? statement.all(...Array.from({ length: positional }, () => 10))
        : statement.all(named)) as Array<{ detail: string }>;
      return rows.map((row) => row.detail).join(' | ');
    });
    expect(plans.length).toBeGreaterThanOrEqual(8);
    expect(reads.filter((sql) => /event\.ingress_id = \?/.test(sql))).toHaveLength(2);
    for (const plan of plans) {
      expect(plan).toMatch(/_open_dead_letters|_closed_dead_letters/);
      expect(plan).not.toMatch(/idx_webhook_recipe_dispatches_claim|idx_webhook_outbox_claim/);
    }
  });
});

const targetRowsRunId = (h: Harness, eventId: string): string => (h.db.prepare(`
  SELECT run_id FROM webhook_recipe_dispatches WHERE event_id = ?
`).get(eventId) as { run_id: string }).run_id;

/** D-201 Slice 10I — a Kitchen recipe with a webhook (a parse-valid one: its
 *  op step is a registered kernel op). */
const kitchenRecipe = (recipeId = 'kitchen-recipe'): RecipeDefinition => ({
  recipe_id: recipeId,
  version: 1,
  ttl: 300,
  metadata: {
    name: `Name of ${recipeId}`,
    description: 'D-201 Slice 10I Kitchen fixture.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['test', 'fixture', 'webhook'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'classify', op: 'core.ai.classify', args: {} }],
  output: { sidebar: [{ type: 'summary', source: 'step.classify' }] },
  webhook_requirements: [requirement],
  webhook_triggers: [{ binding: 'generic_delivery', event_types: ['delivery'] }],
} as unknown as RecipeDefinition);

/** A webhook whose only taker is a Kitchen recipe, saved with its webhook on. */
const kitchenHarness = async () => {
  const h = await makeHarness({ recipeIds: [] });
  const recipes = createRecipeStore('/path/that/does/not/exist', h.db);
  const saveDeps = { store: recipes, webhookConsumerStore: h.consumerStore };
  const bindings = [{ binding: 'generic_delivery', ingress_id: h.ingressId }];
  const save = (webhookOn: boolean, recipe = kitchenRecipe()) =>
    saveRecipeInline(saveDeps, recipe, undefined, bindings, webhookOn);
  // Saved, then switched on as the owner does (Slice 10M: a save can keep a
  // webhook on, never turn one on that is off).
  save(false);
  expect(handleLocalRecipeWebhookArm(saveDeps, { recipe_id: 'kitchen-recipe' }).webhook)
    .toMatchObject({ configured: true, armed: true });
  // A binding switched on takes deliveries that arrive after it.
  h.clock.now += 1_000;
  return { ...h, recipes, save };
};

const openTargets = (h: Harness) => h.db.prepare(`
  SELECT dispatch_id, state, resolved_at, trigger_id FROM webhook_recipe_dispatches
  WHERE state IN ('pending', 'running') OR (state = 'dead_letter' AND resolved_at IS NULL)
  ORDER BY rowid
`).all() as Array<{ dispatch_id: string; state: string; resolved_at: number | null; trigger_id: string }>;

const kitchenTrigger = (h: Harness): string => (h.db.prepare(`
  SELECT trigger_id FROM webhook_recipe_triggers WHERE recipe_id = 'kitchen-recipe'
`).get() as { trigger_id: string }).trigger_id;

describe('D-201 Slice 10I — continuity across upgrades, saves and deletes', () => {
  it('after a save that keeps the setup, a retried legacy event runs only the recipe that failed, never again one that finished', async () => {
    // 10H finding 1: the finished row stayed on the old trigger, so the
    // handoff gave the continuation a new row and ran recipe-a again.
    const before = await makeHarness({ recipeIds: ['recipe-a', 'recipe-b'] });
    const event = await before.accept('two-recipes');
    before.db.prepare(`
      UPDATE webhook_event_outbox SET state = 'dead_letter', attempt_count = 8,
        last_error_code = 'dispatch_failed', updated_at = ?
      WHERE event_id = ?
    `).run(before.clock.now, event.event_id);
    before.db.prepare(`UPDATE webhook_accepted_events SET dispatch_state = 'dead_letter' WHERE event_id = ?`)
      .run(event.event_id);
    const triggers = before.db.prepare(`
      SELECT trigger_id, binding_id, recipe_id, publisher_id FROM webhook_recipe_triggers ORDER BY recipe_id
    `).all() as Array<{ trigger_id: string; binding_id: string; recipe_id: string; publisher_id: string }>;
    expect(triggers.map((row) => row.recipe_id)).toEqual(['recipe-a', 'recipe-b']);
    before.db.exec('DROP TABLE webhook_recipe_dispatches');
    before.db.exec(V26_11_9_DISPATCH_TABLE);
    const legacy = (index: number, state: string, attempts: number) => {
      const trigger = triggers[index]!;
      const id = `legacy${'0'.repeat(27)}${index}`;
      before.db.prepare(`
        INSERT INTO webhook_recipe_dispatches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(`whx_${id}`, event.event_id, trigger.trigger_id, trigger.binding_id, trigger.recipe_id,
        trigger.publisher_id, `whr_${id}`, state, attempts, before.clock.now, before.clock.now);
      return `whr_${id}`;
    };
    const finishedRun = legacy(0, 'dispatched', 1);
    const failedRun = legacy(1, 'pending', 8);
    const h = reopen(before);
    h.clock.now += 1_000;
    saveAgain(h, {}, ['recipe-a', 'recipe-b']);

    const deadLetter = (await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER))
      .dead_letters.find((row) => row.kind === 'event')!;
    await handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'event', dead_letter_id: deadLetter.dead_letter_id },
      dead_lettered_at: deadLetter.dead_lettered_at,
    }, OWNER);
    await handOff(h);
    const { ran, runner } = recording();
    await runTargets(h, runner);
    expect(ran).toEqual([failedRun]);
    // recipe-a keeps the one row it had, finished, now on the saved version.
    expect(h.db.prepare(`
      SELECT recipe_id, state, run_id FROM webhook_recipe_dispatches WHERE event_id = ? ORDER BY recipe_id
    `).all(event.event_id)).toEqual([
      { recipe_id: 'recipe-a', state: 'dispatched', run_id: finishedRun },
      { recipe_id: 'recipe-b', state: 'dispatched', run_id: failedRun },
    ]);
  });

  it('a Kitchen save that keeps its webhook on keeps its dead letters and waiting deliveries, and they run on the saved version', async () => {
    // 10H finding 4: a Kitchen save switched the webhook off, so nothing ever
    // continued; the owner's answer to the save's question now keeps it on.
    const h = await kitchenHarness();
    const deadLetter = await targetDeadLetter(h, 'failed-before-the-fix');
    h.clock.now += 1_000;
    const waiting = await h.accept('waiting-at-the-save');
    await handOff(h);
    const oldTrigger = kitchenTrigger(h);
    h.clock.now += 1_000;
    expect(h.save(true).webhook).toMatchObject({ armed: true });
    const newTrigger = kitchenTrigger(h);
    expect(newTrigger).not.toBe(oldTrigger);
    expect(openTargets(h)).toEqual([
      expect.objectContaining({ dispatch_id: deadLetter.dead_letter_id, state: 'dead_letter', trigger_id: newTrigger }),
      expect.objectContaining({ state: 'pending', trigger_id: newTrigger }),
    ]);
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id })).toEqual([]);

    const current = (await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER)).dead_letters[0]!;
    await handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'target', dead_letter_id: current.dead_letter_id },
      dead_lettered_at: current.dead_lettered_at,
    }, OWNER);
    const { ran, runner } = recording();
    await expect(runTargets(h, runner)).resolves.toMatchObject({ completed: 2 });
    expect(ran).toHaveLength(2);
    expect(waiting.event_id).toBeDefined();
  });

  it('a Kitchen save that switches its webhook off closes its dead letters with a record and cancels what waits', async () => {
    const h = await kitchenHarness();
    const deadLetter = await targetDeadLetter(h, 'closed-by-the-save');
    h.clock.now += 1_000;
    await h.accept('cancelled-by-the-save');
    await handOff(h);
    h.clock.now += 1_000;
    expect(h.save(false).webhook).toMatchObject({ armed: false });
    expect(openTargets(h)).toEqual([]);
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id }).at(-1))
      .toMatchObject({ action: 'expire', actor_kind: 'server', reason: 'recipe_disarmed' });
    expect(pinned(h, deadLetter.dead_letter_id)).toBe(false);
  });

  it('D-201 Slice 10M — never switches back on a webhook switched off since: a save keeps it on, never turns it on', async () => {
    const h = await kitchenHarness();
    const saveDeps = { store: h.recipes, webhookConsumerStore: h.consumerStore };
    handleLocalRecipeWebhookDisarm(saveDeps, { recipe_id: 'kitchen-recipe' });
    expect(() => h.save(true)).toThrow(expect.objectContaining({ code: 'webhook_consent_stale' }));
    expect(h.consumerStore.isConsumerEnabled('local_recipe', 'kitchen-recipe')).toBe(false);
  });

  it('refuses to keep a webhook on that is no longer ready, before anything changes', async () => {
    const h = await kitchenHarness();
    const deadLetter = await targetDeadLetter(h, 'kept-through-a-refusal');
    const trigger = kitchenTrigger(h);
    const asItWas = () => {
      expect(h.consumerStore.isConsumerEnabled('local_recipe', 'kitchen-recipe')).toBe(true);
      expect(openTargets(h)).toEqual([
        expect.objectContaining({ dispatch_id: deadLetter.dead_letter_id, trigger_id: trigger }),
      ]);
    };
    // A way in this recipe cannot take any more (it asks for test deliveries):
    // only the readiness switching it on checks catches it.
    h.db.prepare(`UPDATE webhook_ingresses SET environment = 'live' WHERE ingress_id = ?`).run(h.ingressId);
    expect(() => h.save(true)).toThrow(expect.objectContaining({ code: 'webhook_not_ready' }));
    asItWas();
    // A way in switched off.
    h.db.prepare(`UPDATE webhook_ingresses SET environment = 'test', intake_state = 'disabled' WHERE ingress_id = ?`)
      .run(h.ingressId);
    expect(() => h.save(true)).toThrow(expect.objectContaining({ code: 'webhook_not_ready' }));
    asItWas();
  });

  it('D-201 Slice 10S — a Kitchen save that drops its webhook closes its dead letters as saved differently, never as removed (10Q finding 4)', async () => {
    const h = await kitchenHarness();
    const deadLetter = await targetDeadLetter(h, 'kept-recipe-dropped-webhook');
    h.clock.now += 1_000;
    const unwebhooked = kitchenRecipe() as unknown as Record<string, unknown>;
    delete unwebhooked.webhook_requirements;
    delete unwebhooked.webhook_triggers;
    saveRecipeInline(
      { store: h.recipes, webhookConsumerStore: h.consumerStore },
      unwebhooked as unknown as RecipeDefinition,
      undefined,
      [],
    );
    // The recipe is still there; Settings said "Its recipe was removed."
    expect(h.recipes.get('kitchen-recipe')).not.toBeNull();
    expect(openTargets(h)).toEqual([]);
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id }).at(-1))
      .toMatchObject({ action: 'expire', actor_kind: 'server', reason: 'recipe_replaced' });
  });

  it('deleting a Kitchen recipe closes its dead letters with a record and cancels what waits, so nothing is stranded or holds intake', async () => {
    // 10H finding 5: the delete never finalized, so its rows stayed pending,
    // pinned and counted against intake, with nothing to run or sweep them.
    const h = await kitchenHarness();
    const deadLetter = await targetDeadLetter(h, 'dead-letter-of-a-deleted-recipe');
    h.clock.now += 1_000;
    await h.accept('waiting-for-a-deleted-recipe');
    await handOff(h);
    expect(deleteRecipe({ store: h.recipes, webhookConsumerStore: h.consumerStore }, 'kitchen-recipe'))
      .toEqual({ deleted: true });
    expect(openTargets(h)).toEqual([]);
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id }).at(-1))
      .toMatchObject({ action: 'expire', actor_kind: 'server', reason: 'recipe_removed' });
    expect(h.db.prepare('SELECT COUNT(*) AS count FROM webhook_payload_pins').get()).toEqual({ count: 0 });
    expect(h.consumerStore.countActiveDispatchEvents()).toBe(0);
  });

  it('D-201 Slice 10P (10L finding 9) — a delete that fails keeps the recipe and its webhook as they were', async () => {
    const h = await kitchenHarness();
    const deadLetter = await targetDeadLetter(h, 'dead-letter-of-a-failed-delete');
    h.clock.now += 1_000;
    await h.accept('waiting-through-a-failed-delete');
    await handOff(h);
    const trigger = kitchenTrigger(h);
    const failing = { ...h.recipes, delete: () => { throw new Error('the recipe row could not be removed'); } };
    expect(() => deleteRecipe(
      { store: failing as typeof h.recipes, webhookConsumerStore: h.consumerStore },
      'kitchen-recipe',
    )).toThrow('the recipe row could not be removed');
    expect(h.recipes.get('kitchen-recipe')).not.toBeNull();
    expect(kitchenTrigger(h)).toBe(trigger);
    expect(openTargets(h)).toEqual([
      expect.objectContaining({ dispatch_id: deadLetter.dead_letter_id, state: 'dead_letter', trigger_id: trigger }),
      expect.objectContaining({ state: 'pending', trigger_id: trigger }),
    ]);
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id })).toEqual([]);
    expect(h.consumerStore.isConsumerEnabled('local_recipe', 'kitchen-recipe')).toBe(true);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM webhook_consumer_replacements').get() as { n: number }).n).toBe(0);
  });

  it('the next start closes what a delete before 10I stranded', async () => {
    const before = await kitchenHarness();
    const deadLetter = await targetDeadLetter(before, 'stranded-dead-letter');
    before.clock.now += 1_000;
    await before.accept('stranded-waiting');
    await handOff(before);
    // As v26.11.9's delete left it: the consumer replaced, never finalized.
    before.consumerStore.replaceConsumer({
      consumer_kind: 'local_recipe',
      consumer_id: 'kitchen-recipe',
      requirements: [],
      selections: [],
      recipes: [],
      enabled: false,
    });
    // A server before 10P kept no record of the replacement (Slice 10P).
    before.db.prepare('DELETE FROM webhook_consumer_replacements').run();
    before.recipes.delete('kitchen-recipe');
    expect(openTargets(before)).toHaveLength(2);
    expect(before.consumerStore.countActiveDispatchEvents()).toBe(1);

    const h = reopen(before);
    expect(h.deadLetters.enforceReviewLimit()).toBe(2);
    expect(openTargets(h)).toEqual([]);
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id }).at(-1))
      .toMatchObject({ actor_kind: 'server', reason: 'recipe_removed' });
    expect(h.db.prepare('SELECT COUNT(*) AS count FROM webhook_payload_pins').get()).toEqual({ count: 0 });
    expect(h.consumerStore.countActiveDispatchEvents()).toBe(0);
  });

  it('closing an event leaves an approval hold under it alone', async () => {
    // 10H finding 11: a hold has no lease, which read as lapsed.
    const before = await makeHarness({ recipeIds: ['recipe-a', 'recipe-b'] });
    const [legacy] = await v26_11_9DeadLetters(before, ['held'], 'held');
    const h = reopen(before);
    const holdId = legacy!.dispatch_id;
    h.db.prepare(`UPDATE webhook_recipe_dispatches SET lease_expires_at = NULL, claim_token = 'held' WHERE dispatch_id = ?`)
      .run(holdId);
    h.db.prepare(`
      INSERT INTO webhook_waiting_dispatches (dispatch_id, run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(holdId, legacy!.run_id, h.clock.now, h.clock.now);
    const deadLetter = (await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER))
      .dead_letters.find((row) => row.kind === 'event')!;
    await handleWebhookDeadLetterResolve(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'event', dead_letter_id: deadLetter.dead_letter_id },
      dead_lettered_at: deadLetter.dead_lettered_at,
      reason: 'Closing the old one',
    }, OWNER);
    expect(dispatchRow(h, holdId)).toMatchObject({ state: 'running' });
    expect(h.db.prepare('SELECT COUNT(*) AS count FROM webhook_waiting_dispatches WHERE dispatch_id = ?').get(holdId))
      .toEqual({ count: 1 });
  });

  it("a managed retire closes its dead letters even when the vendor's cleanup fails", async () => {
    // 10H finding 14: the failed cleanup threw before they were closed.
    const h = await makeHarness();
    const deadLetter = await eventDeadLetter(h, 'managed-retire');
    h.consumerStore.removeConsumer('pack_install', PACK_SLUG);
    h.db.prepare(`
      UPDATE webhook_ingresses SET registration_mode = 'managed_endpoint',
        paired_connection_id = 'fixture-connection', remote_endpoint_id = 'we_fixture',
        registration_state = 'registered', intake_state = 'disabled'
      WHERE ingress_id = ?
    `).run(h.ingressId);
    const deps = {
      ...h.deps,
      managedRegistration: {
        cleanup: async () => { throw new WebhookManagedRegistrationError('upstream_unavailable', 'The service did not answer'); },
      },
    } as unknown as WebhookIngressRpcDeps;
    await expect(handleWebhookIngressRetire(deps, { ingress_id: h.ingressId }, OWNER))
      .rejects.toMatchObject({ code: 'webhook_registration_unconfirmed' });
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'event', id: deadLetter.dead_letter_id }).at(-1))
      .toMatchObject({ action: 'expire', actor_kind: 'server', reason: 'webhook_retired' });
    expect(h.deadLetters.summary().unresolved).toBe(0);
  });
});

describe('D-201 Slice 10P — a save the process died in, and what finalize moves', () => {
  const pending = (h: Pick<Harness, 'db'>): number => (h.db.prepare(
    'SELECT COUNT(*) AS n FROM webhook_consumer_replacements',
  ).get() as { n: number }).n;

  it("a keep-on save whose process dies before its finalize: the next start re-homes the continued trigger's rows, never closing them as removed", async () => {
    // 10L finding 6: the start's sweep closed the dead letter as
    // `recipe_removed` and cancelled the waiting delivery.
    const before = await kitchenHarness();
    const deadLetter = await targetDeadLetter(before, 'crash-dead-letter');
    before.clock.now += 1_000;
    await before.accept('crash-waiting');
    await handOff(before);
    before.clock.now += 1_000;
    // The save gets as far as its recipe row; the process dies before finalize.
    before.consumerStore.finalizeConsumerReplacement = () => { throw new Error('the process died'); };
    expect(() => before.save(true)).toThrow();
    expect(pending(before)).toBe(1);
    expect(openTargets(before)).toHaveLength(2);

    const h = reopen(before);
    h.deadLetters.enforceReviewLimit();
    const trigger = kitchenTrigger(h);
    expect(openTargets(h)).toEqual([
      expect.objectContaining({ dispatch_id: deadLetter.dead_letter_id, state: 'dead_letter', trigger_id: trigger }),
      expect.objectContaining({ state: 'pending', trigger_id: trigger }),
    ]);
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id })).toEqual([]);
    expect(pending(h)).toBe(0);
  });

  it("10I's legacy event, when the save that keeps its setup dies before finalize: tried again, it runs only the recipe that failed", async () => {
    const before = await makeHarness({ recipeIds: ['recipe-a', 'recipe-b'] });
    const event = await before.accept('two-recipes-crash');
    await handOff(before);
    const rows = targetRows(before, event.event_id);
    expect(rows).toHaveLength(2);
    // recipe-a finished; recipe-b dead-lettered with its event (as v26.11.9 did).
    const [finished, failed] = (before.db.prepare(`
      SELECT dispatch_id, run_id FROM webhook_recipe_dispatches WHERE event_id = ? ORDER BY recipe_id
    `).all(event.event_id) as Array<{ dispatch_id: string; run_id: string }>);
    before.db.prepare(`UPDATE webhook_recipe_dispatches SET state = 'dispatched' WHERE dispatch_id = ?`)
      .run(finished!.dispatch_id);
    before.db.prepare(`
      UPDATE webhook_event_outbox SET state = 'dead_letter', attempt_count = 8,
        last_error_code = 'dispatch_failed', available_at = ?, updated_at = ?, claim_token = NULL, lease_expires_at = NULL
      WHERE event_id = ?
    `).run(before.clock.now, before.clock.now, event.event_id);
    before.db.prepare(`UPDATE webhook_accepted_events SET dispatch_state = 'dead_letter' WHERE event_id = ?`)
      .run(event.event_id);
    // The re-save's replace commits; its finalize never runs.
    before.clock.now += 1_000;
    before.consumerStore.replaceConsumer({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
      requirements: [requirement],
      selections: [{ binding: 'generic_delivery', ingress_id: before.ingressId }],
      recipes: ['recipe-a', 'recipe-b'].map((recipeId) => ({
        recipe_id: recipeId,
        publisher_id: PUBLISHER,
        webhook_triggers: recipe(recipeId).webhook_triggers!,
      })),
    });

    const h = reopen(before);
    h.deadLetters.enforceReviewLimit();
    const deadLetter = (await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER))
      .dead_letters.find((row) => row.kind === 'event')!;
    await handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'event', dead_letter_id: deadLetter.dead_letter_id },
      dead_lettered_at: deadLetter.dead_lettered_at,
    }, OWNER);
    await handOff(h);
    const { ran, runner } = recording();
    await runTargets(h, runner);
    expect(ran).toEqual([failed!.run_id]);
  });

  it("finalize moves a finished row only for an event the outbox can still hand off: a done event's history stays", async () => {
    // 10L finding 8: every finished row moved, about a second at 200,000.
    const h = await makeHarness({ recipeIds: ['recipe-a'] });
    const done = await h.accept('done-event');
    await handOff(h);
    const retriable = await h.accept('retriable-event');
    await handOff(h);
    h.db.prepare(`UPDATE webhook_recipe_dispatches SET state = 'dispatched'`).run();
    h.db.prepare(`
      UPDATE webhook_event_outbox SET state = 'dead_letter', attempt_count = 8,
        last_error_code = 'dispatch_failed', updated_at = ?, claim_token = NULL, lease_expires_at = NULL
      WHERE event_id = ?
    `).run(h.clock.now, retriable.event_id);
    const oldTrigger = (targetRows(h, done.event_id))[0]!.trigger_id;
    h.clock.now += 1_000;
    // The statements finalize really prepares, read back through the planner.
    const seen: string[] = [];
    const prepare = h.db.prepare.bind(h.db);
    h.db.prepare = ((sql: string) => {
      if (/webhook_event_outbox/.test(sql) && /^\s*UPDATE/i.test(sql)) seen.push(sql);
      return prepare(sql);
    }) as typeof h.db.prepare;
    try {
      saveAgain(h);
    } finally {
      h.db.prepare = prepare;
    }
    const newTrigger = h.db.prepare(`SELECT trigger_id FROM webhook_recipe_triggers`).get() as { trigger_id: string };
    expect(targetRows(h, done.event_id)[0]!.trigger_id).toBe(oldTrigger);
    expect(targetRows(h, retriable.event_id)[0]!.trigger_id).toBe(newTrigger.trigger_id);
    // Driven by the open events, never a walk of the trigger's history.
    expect(seen).toHaveLength(1);
    const rows = h.db.prepare(`EXPLAIN QUERY PLAN ${seen[0]}`).all('t1', 'b1', 't0', 't1') as Array<{
      id: number; parent: number; detail: string;
    }>;
    const plan = rows.map((row) => row.detail).join(' | ');
    // D-201 Slice 10U (10Q finding 22) — the outer loop is the event-driven
    // one: the rows it updates are reached by event and trigger, one event at
    // a time. Forcing the trigger's own index (a walk of its whole history)
    // passed the assertions before, at twice the time.
    const outer = rows.filter((row) => row.parent === 0 && /webhook_recipe_dispatches/.test(row.detail));
    expect(outer.map((row) => row.detail), plan).toEqual([
      expect.stringMatching(/^SEARCH webhook_recipe_dispatches USING .*\(event_id=\? AND trigger_id=\?\)$/),
    ]);
    // And the events it moves for are read from the open rows only: the event
    // dead letters through the index of the open ones, never the closed ones
    // (17 ms against 9 ms at 200,000 closed).
    expect(plan, plan).toMatch(/SCAN webhook_event_outbox USING (COVERING )?INDEX idx_webhook_outbox_open_dead_letters/);
    expect(plan, plan).toMatch(/SEARCH webhook_event_outbox USING (COVERING )?INDEX idx_webhook_outbox_claim \(state=\?\)/);
    expect(plan.match(/idx_webhook_outbox_claim/g), plan).toHaveLength(1);
    expect(plan, plan).not.toMatch(/SCAN webhook_recipe_dispatches(?! USING)|SCAN webhook_event_outbox(?! USING)/);
  });

  it('a record the start never saw (a failed save whose restore failed too) is carried on first by the next save', async () => {
    // D-201 Slice 10U — the start finishes every record before any save can
    // run; one made after it is a save's whose recipe row and restore both
    // failed. The next save of that recipe carries it on before it replaces.
    const before = await kitchenHarness();
    const deadLetter = await targetDeadLetter(before, 'crash-then-save');
    before.clock.now += 1_000;
    const finalize = before.consumerStore.finalizeConsumerReplacement;
    before.consumerStore.finalizeConsumerReplacement = () => { throw new Error('the process died'); };
    expect(() => before.save(true)).toThrow();
    before.consumerStore.finalizeConsumerReplacement = finalize;
    // The owner saves again at once.
    const h = reopen(before, { finish: false });
    h.clock.now += 1_000;
    const saved = saveRecipeInline(
      { store: createRecipeStore('/path/that/does/not/exist', h.db), webhookConsumerStore: h.consumerStore },
      kitchenRecipe(),
      undefined,
      [{ binding: 'generic_delivery', ingress_id: h.ingressId }],
      true,
    );
    expect(saved.webhook).toMatchObject({ armed: true });
    expect(openTargets(h)).toEqual([
      expect.objectContaining({ dispatch_id: deadLetter.dead_letter_id, state: 'dead_letter', trigger_id: kitchenTrigger(h) }),
    ]);
    expect(pending(h)).toBe(0);
    h.deadLetters.enforceReviewLimit();
    expect(openTargets(h)).toHaveLength(1);
  });

  it("a webhook retired while a save waited to finish: its re-homed dead letter closes as retired, and an uninstall leaves no record", async () => {
    const before = await makeHarness();
    const deadLetter = await targetDeadLetter(before, 'retired-mid-save');
    before.clock.now += 1_000;
    before.consumerStore.replaceConsumer({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
      requirements: [requirement],
      selections: [{ binding: 'generic_delivery', ingress_id: before.ingressId }],
      recipes: [{ recipe_id: 'recipe-a', publisher_id: PUBLISHER, webhook_triggers: recipe('recipe-a').webhook_triggers! }],
    });
    before.db.prepare(`UPDATE webhook_ingresses SET intake_state = 'retired' WHERE ingress_id = ?`).run(before.ingressId);
    const h = reopen(before);
    // D-201 Slice 10U (10Q finding 24) — re-homed first: this passed with the
    // start's finish doing nothing, the retired sweep closing it on its old
    // trigger regardless.
    expect(h.db.prepare(`SELECT trigger_id FROM webhook_recipe_dispatches WHERE dispatch_id = ?`)
      .get(deadLetter.dead_letter_id)).toEqual(
      h.db.prepare(`SELECT trigger_id FROM webhook_recipe_triggers`).get(),
    );
    h.deadLetters.enforceReviewLimit();
    expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: deadLetter.dead_letter_id }).at(-1))
      .toMatchObject({ actor_kind: 'server', reason: 'webhook_retired' });

    const other = await makeHarness();
    other.consumerStore.replaceConsumer({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
      requirements: [requirement],
      selections: [{ binding: 'generic_delivery', ingress_id: other.ingressId }],
      recipes: [{ recipe_id: 'recipe-a', publisher_id: PUBLISHER, webhook_triggers: recipe('recipe-a').webhook_triggers! }],
    });
    expect(pending(other)).toBe(1);
    other.consumerStore.removeConsumer('pack_install', PACK_SLUG);
    expect(pending(other)).toBe(0);
  });

  it('a save, a failed save (its restore clears it) and a delete leave no record behind', async () => {
    const h = await kitchenHarness();
    expect(pending(h)).toBe(0);
    h.clock.now += 1_000;
    h.save(true);
    expect(pending(h)).toBe(0);
    const failingStore = { ...h.recipes, save: () => { throw new Error('the recipe row could not be written'); } };
    expect(() => saveRecipeInline(
      { store: failingStore as typeof h.recipes, webhookConsumerStore: h.consumerStore },
      kitchenRecipe(),
      undefined,
      [{ binding: 'generic_delivery', ingress_id: h.ingressId }],
      true,
    )).toThrow();
    expect(pending(h)).toBe(0);
    // D-201 Slice 10U (10Q finding 24) — this said "a delete" and made none.
    expect(deleteRecipe({ store: h.recipes, webhookConsumerStore: h.consumerStore }, 'kitchen-recipe'))
      .toEqual({ deleted: true });
    expect(pending(h)).toBe(0);
  });
});

describe('D-201 Slice 10U — a replacement record that cannot be finished (10Q finding 23)', () => {
  const pending = (h: Pick<Harness, 'db'>): number => (h.db.prepare(
    'SELECT COUNT(*) AS n FROM webhook_consumer_replacements',
  ).get() as { n: number }).n;
  /** A record that parses but names a row no finalize can take (a corrupt one,
   *  or one a newer version wrote): its trigger id is not a string. An id with
   *  spaces is a valid one, and finished like any other: the first version of
   *  these cases used one, and passed with the set-aside path never taken. */
  const unfinishable = (h: Pick<Harness, 'db' | 'clock'>, consumerId = 'kitchen-recipe') => {
    h.db.prepare(`
      INSERT INTO webhook_consumer_replacements (consumer_kind, consumer_id, prior_json, created_at)
      VALUES ('local_recipe', ?, ?, ?)
    `).run(consumerId, JSON.stringify({
      consumer_kind: 'local_recipe',
      consumer_id: consumerId,
      bindings: [],
      triggers: [{
        trigger_id: 7,
        binding_id: 'whb_missing',
        recipe_id: consumerId,
        publisher_id: 'kitchen',
        provider_event_type: 'delivery',
        contract_id: null,
        enabled: 1,
        created_at: h.clock.now,
        updated_at: h.clock.now,
      }],
    }), h.clock.now);
  };

  it("is set aside at the start: the start goes on, the sweep runs, and the recipe's saves work", async () => {
    const before = await kitchenHarness();
    const deadLetter = await targetDeadLetter(before, 'beside-a-corrupt-record');
    unfinishable(before);
    // It really cannot be finished: its finalize throws, and leaves it.
    const prior = before.consumerStore.pendingReplacements()[0]!.prior!;
    expect(() => before.consumerStore.finalizeConsumerReplacement(prior)).toThrow(/trigger_id has invalid shape/);
    expect(pending(before)).toBe(1);
    // 10P: the first poll's sweep threw on it after marking itself done, and
    // every save of this recipe threw on it, across restarts.
    const h = reopen(before, { finish: false });
    expect(finishWebhookReplacementsAtStart({
      consumerStore: h.consumerStore,
      recipes: createRecipeStore('/path/that/does/not/exist', h.db),
    })).toEqual([expect.objectContaining({
      consumer_id: 'kitchen-recipe',
      outcome: 'set_aside',
      reason: expect.stringMatching(/trigger_id has invalid shape/),
    })]);
    expect(pending(h)).toBe(0);
    expect(() => h.deadLetters.enforceReviewLimit()).not.toThrow();
    expect(openTargets(h)).toEqual([
      expect.objectContaining({ dispatch_id: deadLetter.dead_letter_id, state: 'dead_letter', trigger_id: kitchenTrigger(h) }),
    ]);
    h.clock.now += 1_000;
    expect(saveRecipeInline(
      { store: createRecipeStore('/path/that/does/not/exist', h.db), webhookConsumerStore: h.consumerStore },
      kitchenRecipe(),
      undefined,
      [{ binding: 'generic_delivery', ingress_id: h.ingressId }],
      true,
    ).webhook).toMatchObject({ armed: true });
  });

  it('one that cannot be read is set aside at the start too', async () => {
    const before = await kitchenHarness();
    before.db.prepare(`
      INSERT INTO webhook_consumer_replacements (consumer_kind, consumer_id, prior_json, created_at)
      VALUES ('local_recipe', 'kitchen-recipe', '{"not json', ?)
    `).run(before.clock.now);
    const h = reopen(before, { finish: false });
    expect(finishWebhookReplacementsAtStart({
      consumerStore: h.consumerStore,
      recipes: createRecipeStore('/path/that/does/not/exist', h.db),
    })).toEqual([expect.objectContaining({ outcome: 'set_aside', reason: 'its record cannot be read' })]);
    expect(pending(h)).toBe(0);
  });

  it('a save carrying one on first sets it aside rather than failing', async () => {
    const before = await kitchenHarness();
    const h = reopen(before, { finish: false });
    unfinishable(h);
    const prior = h.consumerStore.pendingReplacements()[0]!.prior!;
    expect(() => h.consumerStore.finalizeConsumerReplacement(prior)).toThrow(/trigger_id has invalid shape/);
    h.clock.now += 1_000;
    expect(() => saveRecipeInline(
      { store: createRecipeStore('/path/that/does/not/exist', h.db), webhookConsumerStore: h.consumerStore },
      kitchenRecipe(),
      undefined,
      [{ binding: 'generic_delivery', ingress_id: h.ingressId }],
      true,
    )).not.toThrow();
    expect(pending(h)).toBe(0);
  });

  it("the first poll's sweep leaves a replacement under way alone: its rows are its finalize's, never stranded", async () => {
    const h = await makeHarness();
    const deadLetter = await targetDeadLetter(h, 'under-way');
    const oldTrigger = (h.db.prepare(`SELECT trigger_id FROM webhook_recipe_triggers`).get() as { trigger_id: string }).trigger_id;
    h.clock.now += 1_000;
    // A pack install between its replace and its finalize: it awaits in between.
    const prior = h.consumerStore.replaceConsumer({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
      requirements: [requirement],
      selections: [{ binding: 'generic_delivery', ingress_id: h.ingressId }],
      recipes: [{ recipe_id: 'recipe-a', publisher_id: PUBLISHER, webhook_triggers: recipe('recipe-a').webhook_triggers! }],
    });
    // 10P finalized it here, under the install's feet; the stranded sweep
    // would close its dead letter as its recipe's removal.
    expect(h.deadLetters.enforceReviewLimit()).toBe(0);
    const triggerOf = () => (h.db.prepare(`SELECT trigger_id, resolved_at FROM webhook_recipe_dispatches WHERE dispatch_id = ?`)
      .get(deadLetter.dead_letter_id) as { trigger_id: string; resolved_at: number | null });
    expect(triggerOf()).toEqual({ trigger_id: oldTrigger, resolved_at: null });
    h.consumerStore.finalizeConsumerReplacement(prior);
    const newTrigger = (h.db.prepare(`SELECT trigger_id FROM webhook_recipe_triggers`).get() as { trigger_id: string }).trigger_id;
    expect(triggerOf()).toEqual({ trigger_id: newTrigger, resolved_at: null });
  });

  it("a delivery a restart marked keeps the mark through a door-less dead letter: tried again, it resumes the stopped run", async () => {
    const h = await makeHarness();
    const event = await h.accept('marked-no-door');
    await handOff(h);
    // The mark the restart's drain leaves on a stopped run's target (Slice 10E).
    h.db.prepare(`UPDATE webhook_recipe_dispatches SET restart_interrupted_at = ? WHERE event_id = ?`)
      .run(h.clock.now, event.event_id);
    await runTargets(h, { run: async () => 'door_missing' as const });
    const rowAfter = () => h.db.prepare(`
      SELECT state, last_error_code, restart_interrupted_at FROM webhook_recipe_dispatches WHERE event_id = ?
    `).get(event.event_id) as { state: string; last_error_code: string | null; restart_interrupted_at: number | null };
    expect(rowAfter()).toMatchObject({ state: 'dead_letter', last_error_code: 'door_missing', restart_interrupted_at: expect.any(Number) });
    const deadLetter = (await handleWebhookDeadLetterList(h.deps, { ingress_id: h.ingressId }, OWNER))
      .dead_letters.find((row) => row.event_id === event.event_id)!;
    await handleWebhookDeadLetterRequeue(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'target', dead_letter_id: deadLetter.dead_letter_id },
      dead_lettered_at: deadLetter.dead_lettered_at,
    }, OWNER);
    const resumed: boolean[] = [];
    await runTargets(h, { run: async (run) => { resumed.push(run.resume_interrupted_run === true); return 'completed' as const; } });
    expect(resumed).toEqual([true]);
  });

  it("the first poll's sweep that throws is tried again on the next", async () => {
    const h = await makeHarness();
    const sweep = h.consumerStore.closeStrandedTargets;
    let calls = 0;
    h.consumerStore.closeStrandedTargets = () => {
      calls += 1;
      if (calls === 1) throw new Error('the database is busy');
      return sweep();
    };
    expect(() => h.deadLetters.enforceReviewLimit()).toThrow('the database is busy');
    h.deadLetters.enforceReviewLimit();
    expect(calls).toBe(2);
    h.deadLetters.enforceReviewLimit();
    expect(calls).toBe(2);
  });
});

describe('D-201 Slice 10X — door-less dead letters, faults that pass, and the savepoint (10V findings 11, 27, 28, 29)', () => {
  const pending = (h: Pick<Harness, 'db'>): number => (h.db.prepare(
    'SELECT COUNT(*) AS n FROM webhook_consumer_replacements',
  ).get() as { n: number }).n;
  const triggerOfRow = (h: Pick<Harness, 'db'>, dispatchId: string): string => (h.db.prepare(
    'SELECT trigger_id FROM webhook_recipe_dispatches WHERE dispatch_id = ?',
  ).get(dispatchId) as { trigger_id: string }).trigger_id;
  /** A keep-on save of the Kitchen recipe that died before its finalize. */
  const diedBeforeItsFinalize = (h: Awaited<ReturnType<typeof kitchenHarness>>) => {
    h.clock.now += 1_000;
    h.consumerStore.replaceConsumer({
      consumer_kind: 'local_recipe',
      consumer_id: 'kitchen-recipe',
      requirements: [requirement],
      selections: [{ binding: 'generic_delivery', ingress_id: h.ingressId }],
      recipes: [{
        recipe_id: 'kitchen-recipe',
        publisher_id: h.recipes.getStored('kitchen-recipe')!.publisher_id,
        webhook_triggers: kitchenRecipe().webhook_triggers!,
      }],
      enabled: true,
    });
    expect(pending(h)).toBe(1);
  };

  it('the review limit closes the dead letters no door let run before any other: a webhook with no door never crowds out the rest (finding 11)', async () => {
    const h = await makeHarness({ limit: 2 });
    // The oldest: a run that failed.
    const failed = await targetDeadLetter(h, 'run-failed');
    // Then three that no door let run: missing, closed, missing. D-201 Slice
    // 10AC (10AA finding 20) — a closed door's counts too, pinned.
    const doorless: string[] = [];
    for (const [suffix, outcome] of [
      ['no-door-1', 'door_missing'], ['no-door-2', 'door_closed'], ['no-door-3', 'door_missing'],
    ] as const) {
      h.clock.now += 1_000;
      const event = await h.accept(suffix);
      await handOff(h);
      await runTargets(h, { run: async () => outcome });
      doorless.push((h.db.prepare(`SELECT dispatch_id FROM webhook_recipe_dispatches WHERE event_id = ?`)
        .get(event.event_id) as { dispatch_id: string }).dispatch_id);
    }
    expect(h.deadLetters.enforceReviewLimit()).toBe(2);
    // 10U closed the run that failed first, as the oldest of all.
    expect(openTargets(h).map((row) => row.dispatch_id)).toEqual([failed.dead_letter_id, doorless[2]]);
    for (const closed of doorless.slice(0, 2)) {
      expect(listWebhookDeadLetterReviews(h.db, { kind: 'target', id: closed }).at(-1))
        .toMatchObject({ actor_kind: 'server', reason: 'review_limit' });
    }
  });

  it("the first poll's pass is tried again when any part of it throws, not only the stranded sweep (finding 28)", async () => {
    const h = await makeHarness();
    const oldest = h.consumerStore.oldestUnresolvedDeadLetterTargets;
    let calls = 0;
    h.consumerStore.oldestUnresolvedDeadLetterTargets = (limit) => {
      calls += 1;
      if (calls === 1) throw new Error('the database is busy');
      return oldest(limit);
    };
    expect(() => h.deadLetters.enforceReviewLimit()).toThrow('the database is busy');
    // 10U marked the pass done before it, so this throw kept it from ever
    // running again in this process.
    h.deadLetters.enforceReviewLimit();
    expect(calls).toBe(2);
    h.deadLetters.enforceReviewLimit();
    expect(calls).toBe(2);
  });

  it('a save carrying on a record it cannot finish does none of it: a move made before the throw is put back (finding 29)', async () => {
    const h = await kitchenHarness();
    const deadLetter = await targetDeadLetter(h, 'before-the-crash');
    const first = kitchenTrigger(h);
    diedBeforeItsFinalize(h);
    expect(kitchenTrigger(h)).not.toBe(first);
    // A second trigger no finalize can take, AFTER the first: the first's dead
    // letter is moved to the trigger that continues it before the throw. 10U's
    // fixture threw before any write, so its savepoint could go unseen.
    const { prior_json: priorJson } = h.db.prepare('SELECT prior_json FROM webhook_consumer_replacements')
      .get() as { prior_json: string };
    const prior = JSON.parse(priorJson) as { triggers: Array<Record<string, unknown>> };
    prior.triggers.push({ ...prior.triggers[0], trigger_id: 7 });
    h.db.prepare('UPDATE webhook_consumer_replacements SET prior_json = ?').run(JSON.stringify(prior));
    h.clock.now += 1_000;
    expect(() => h.save(true)).not.toThrow();
    expect(pending(h)).toBe(0);
    // Set aside whole: the dead letter is where the record left it, for the
    // sweep. A bare call kept the move, and the save's own finalize carried it
    // on: a record it could not read whole, acted on in part.
    expect(triggerOfRow(h, deadLetter.dead_letter_id)).toBe(first);
  });

  // D-201 Slice 10AC (10AA finding 20) — every code the finish leaves for the
  // next try: only `SQLITE_BUSY` was driven.
  it.each([
    'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR', 'SQLITE_IOERR_WRITE', 'SQLITE_FULL', 'SQLITE_NOMEM',
    'SQLITE_INTERRUPT', 'SQLITE_PROTOCOL', 'SQLITE_CANTOPEN',
  ])('%s is a fault that may pass', (code) => {
    expect(isPassingStoreFault(Object.assign(new Error('the database'), { code }))).toBe(true);
  });

  it.each(['SQLITE_CORRUPT', 'SQLITE_CONSTRAINT', 'SQLITE_ERROR', 'SQLITE_NOTADB', undefined, 7])(
    '%s is not one: the record is set aside',
    (code) => {
      expect(isPassingStoreFault(Object.assign(new Error('the database'), { code }))).toBe(false);
    },
  );

  it('a save carrying on a record whose finish meets a fault that may pass fails, and the record stays for the next (finding 27)', async () => {
    const h = await kitchenHarness();
    const deadLetter = await targetDeadLetter(h, 'before-the-crash');
    diedBeforeItsFinalize(h);
    // The database is busy as the save carries it on.
    const prepare = h.db.prepare;
    let busy = true;
    h.db.prepare = function patched(this: Database.Database, sql: string) {
      if (busy && sql.includes('DELETE FROM webhook_waiting_dispatches')) {
        busy = false;
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }
      return prepare.call(this, sql);
    } as typeof h.db.prepare;
    h.clock.now += 1_000;
    try {
      expect(() => h.save(true)).toThrow();
    } finally {
      h.db.prepare = prepare;
    }
    expect(busy).toBe(false);
    // 10U set it aside, and the sweep then closed its rows as removed.
    expect(pending(h)).toBe(1);
    expect(() => h.save(true)).not.toThrow();
    expect(pending(h)).toBe(0);
    expect(openTargets(h)).toEqual([expect.objectContaining({
      dispatch_id: deadLetter.dead_letter_id,
      state: 'dead_letter',
      trigger_id: kitchenTrigger(h),
    })]);
  });
});

describe('D-201 Slice 10W — an approved run in doubt names its step (10V finding 1)', () => {
  it('a dead letter held for its try again names the step in doubt; one not held, or another kind, names none', async () => {
    const h = await makeHarness();
    const event = await h.accept('in-doubt');
    await handOff(h);
    // The worker's outcome for a try again stopped with a step in doubt again.
    await expect(runTargets(h, { run: async () => 'in_doubt' as const })).resolves.toMatchObject({ dead_lettered: 1 });
    const runId = (h.db.prepare('SELECT run_id FROM webhook_recipe_dispatches WHERE event_id = ?')
      .get(event.event_id) as { run_id: string }).run_id;
    const failed = await targetDeadLetter(h, 'run-failed');
    const listWith = async (heldStepOf: Parameters<typeof createWebhookDeadLetterService>[0]['heldStepOf']) => {
      const service = createWebhookDeadLetterService({
        deliveryStore: h.deliveryStore,
        consumerStore: h.consumerStore,
        ...(heldStepOf !== undefined ? { heldStepOf } : {}),
      });
      return service.list({ ingress_id: h.ingressId, limit: 50 }).dead_letters;
    };
    const inDoubt = (rows: Awaited<ReturnType<typeof listWith>>) =>
      rows.find((row) => row.event_id === event.event_id)!;
    const asked: string[] = [];
    const rows = await listWith((id) => {
      asked.push(id);
      return id === runId ? { step_id: 'tell_owner_two' } : null;
    });
    expect(inDoubt(rows)).toMatchObject({ last_error_code: 'approved_run_in_doubt', step_in_doubt: { step_id: 'tell_owner_two' } });
    // Only an in-doubt dead letter is asked about.
    expect(asked).toEqual([runId]);
    expect(rows.find((row) => row.dead_letter_id === failed.dead_letter_id)).not.toHaveProperty('step_in_doubt');
    expect(inDoubt(await listWith(() => null))).not.toHaveProperty('step_in_doubt');
    expect(inDoubt(await listWith(() => { throw new Error('the store is unreadable'); }))).not.toHaveProperty('step_in_doubt');
    expect(inDoubt(await listWith(undefined))).not.toHaveProperty('step_in_doubt');
    // D-201 Slice 10BC (10AY findings 2 and 9) — one whose later steps run again
    // too, in its own field alone: an older Settings, reading `step_in_doubt`,
    // would say only that step can run twice.
    for (const held of [
      { step_id: 'tell_owner_two', later_run_again: true as const },
      { step_id: 'close', asks_again: true as const, later_run_again: true as const },
    ]) {
      const lagging = inDoubt(await listWith((id) => (id === runId ? held : null)));
      expect(lagging).toMatchObject({ held_try_again: held });
      expect(lagging).not.toHaveProperty('step_in_doubt');
    }
  });
});

describe('D-201 Slice 10AB — closing a dead letter sweeps what a held run kept (10AA finding 14)', () => {
  it("the owner's close of a target and the review limit each sweep; an event's close, a pass that closes nothing, and a sweep that throws do not touch the action", async () => {
    const h = await makeHarness();
    let swept = 0;
    const service = createWebhookDeadLetterService({
      deliveryStore: h.deliveryStore,
      consumerStore: h.consumerStore,
      limit: 2,
      onClosed: () => { swept += 1; },
    });
    const close = (svc: typeof service, row: { kind: 'event' | 'target'; dead_letter_id: string; dead_lettered_at: number }) =>
      svc.resolve({
        ingress_id: h.ingressId,
        dead_letter: { kind: row.kind, dead_letter_id: row.dead_letter_id },
        dead_lettered_at: row.dead_lettered_at,
        reason: 'Checked by hand.',
        actor_instance_id: 'owner-device',
      });
    await targetDeadLetter(h, 'oldest');
    h.clock.now += 1_000;
    const middle = await targetDeadLetter(h, 'middle');
    h.clock.now += 1_000;
    await targetDeadLetter(h, 'newest');
    expect(service.enforceReviewLimit()).toBe(1);
    expect(swept).toBe(1);
    expect(service.enforceReviewLimit()).toBe(0);
    expect(swept).toBe(1);
    close(service, middle);
    expect(swept).toBe(2);
    // No run is held for an event: its close sweeps nothing.
    const event = await eventDeadLetter(h, 'event');
    close(service, event);
    expect(swept).toBe(2);
    const throwing = createWebhookDeadLetterService({
      deliveryStore: h.deliveryStore,
      consumerStore: h.consumerStore,
      onClosed: () => { throw new Error('the database is busy'); },
    });
    const last = await targetDeadLetter(h, 'last');
    expect(close(throwing, last)).toMatchObject({ outcome: 'resolved' });
  });
});

describe('D-201 Slice 10W — whether a run still waits (the held-run sweep reads it)', () => {
  it('queued or an open dead letter waits; dispatched, cancelled or closed does not', async () => {
    const h = await makeHarness();
    const runOf = (eventId: string) => (h.db.prepare('SELECT run_id FROM webhook_recipe_dispatches WHERE event_id = ?')
      .get(eventId) as { run_id: string }).run_id;
    const queued = await h.accept('queued');
    await handOff(h);
    expect(h.consumerStore.isRunStillOpen(runOf(queued.event_id))).toBe(true);
    await runTargets(h, { run: async () => 'completed' as const });
    expect(h.consumerStore.isRunStillOpen(runOf(queued.event_id))).toBe(false);
    const dead = await targetDeadLetter(h, 'dead');
    const deadRun = runOf(dead.event_id);
    expect(h.consumerStore.isRunStillOpen(deadRun)).toBe(true);
    await handleWebhookDeadLetterResolve(h.deps, {
      ingress_id: h.ingressId,
      dead_letter: { kind: 'target', dead_letter_id: dead.dead_letter_id },
      dead_lettered_at: dead.dead_lettered_at,
      reason: 'Checked by hand.',
    }, OWNER);
    expect(h.consumerStore.isRunStillOpen(deadRun)).toBe(false);
    expect(h.consumerStore.isRunStillOpen('no-such-run')).toBe(false);
  });
});
