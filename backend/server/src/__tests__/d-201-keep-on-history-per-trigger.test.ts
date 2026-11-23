/** D-201 Slice 10S — the keep-on question's history, and the record a closed
 *  trigger leaves, as the save carries them.
 *
 *  10Q finding 4: the question checked bindings only, so a draft dropping an
 *  event its slot merely allows was told "Keeping it on keeps them", and the
 *  save closed that event's dead letter as `recipe_removed` ("Its recipe was
 *  removed.") of a recipe the owner had just saved. 10Q finding 14: removing the
 *  `delivery_payload_allowed` widening left every test green.
 *
 *  On a Paddle way in taking two events, through the real ingress, delivery and
 *  consumer stores, the outbox handoff and the dispatch worker. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackWebhookRequirement, RecipeDefinition } from '@recued/contracts';

import { createRecipeStore } from '../recipe-store.js';

import { createWebhookConsumerStore } from '../storage/webhook-consumer-store.js';
import {
  createWebhookDeliveryStore,
  type WebhookAcceptedDeliveryInput,
} from '../storage/webhook-delivery-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { listWebhookDeadLetterReviews } from '../storage/webhook-dead-letter-reviews.js';
import { createWebhookRecipeOutboxSink, type WebhookRecipeRunner } from '../webhook-recipe-consumer.js';
import { dispatchWebhookOutboxOnce } from '../webhook-outbox-dispatcher.js';
import { createWebhookRecipeDispatchRuntime } from '../webhook-recipe-dispatch-worker.js';

const PROFILE = 'paddle.notification.v1';
const SECRET = 'pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms7_6h3qd3uFSi9YCD3OLYAShQI90XTI5vEI';
const T0 = 2_000_000_000_000;
const UPDATED = 'subscription.updated';
const CANCELED = 'subscription.canceled';

const requirement = (overrides: Partial<PackWebhookRequirement> = {}): PackWebhookRequirement => ({
  binding: 'billing',
  profile_ids: [PROFILE],
  required_event_types: [UPDATED],
  optional_event_types: [CANCELED],
  registration_modes: ['manual'],
  environment_policy: 'any',
  decoded_payload_access: 'metadata_only',
  source_truth_policy: 'delivery_payload_allowed',
  ...overrides,
} as PackWebhookRequirement);

/** The Kitchen recipe, taking `eventTypes` on its one slot. */
const taking = (eventTypes: string[]) => [{
  recipe_id: 'kitchen-recipe',
  publisher_id: 'kitchen',
  webhook_triggers: [{ binding: 'billing', event_types: eventTypes }],
}];

const failing: WebhookRecipeRunner = {
  run: async () => { throw new Error('the provider is down'); },
};
const succeeding: WebhookRecipeRunner = { run: async () => 'completed' };

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

/** A Kitchen recipe taking both events, its webhook on. */
const world = async (options: { paired?: boolean } = {}) => {
  const db = new Database(':memory:');
  databases.push(db);
  const clock = { now: T0 - 10_000 };
  const ingressStore = createWebhookIngressStore(db, {
    now: () => clock.now,
    getEncryptionKey: () => new Uint8Array(32).fill(71),
  });
  const consumerStore = createWebhookConsumerStore(db, { ingressStore, now: () => clock.now });
  const deliveryStore = createWebhookDeliveryStore(db, {
    now: () => clock.now,
    getEncryptionKey: () => new Uint8Array(32).fill(83),
    hasDispatchTarget: (ingressId, eventType) => consumerStore.hasDispatchTarget(ingressId, eventType),
    countActiveConsumerWork: () => consumerStore.countActiveDispatchEvents(),
    onDeadLetterEventClosed: (eventId) => { consumerStore.closeTargetsOfClosedEvent(eventId); },
    onDeadLetterEventRequeued: (eventId) => { consumerStore.refreshTargetsOfRequeuedEvent(eventId); },
    eventHasCurrentRecipe: (eventId) => consumerStore.eventHasCurrentRecipe(eventId),
    pruneConsumerRows: () => { consumerStore.pruneDispatchesWithoutEvents(); },
  });
  const ingress = ingressStore.create({
    display_name: 'Paddle billing',
    profile_id: PROFILE,
    environment: 'test',
    paired_connection_id: options.paired === true ? 'paddle' : null,
    registration_mode: 'manual',
    selected_event_types: [UPDATED, CANCELED],
  });
  await ingressStore.writeCredentialVersion(ingress.ingress_id, { endpoint_secret_key: SECRET });
  ingressStore.confirmManualRegistration(ingress.ingress_id, {
    requires_handshake: false,
    endpoint_url: `https://hooks.example.test/v1/webhooks/${ingress.public_id}`,
  });
  ingressStore.enable(ingress.ingress_id);
  // The recipe itself, as a Kitchen save stores it: a target must reach one.
  createRecipeStore('/path/that/does/not/exist', db).save({
    recipe_id: 'kitchen-recipe',
    version: 1,
    ttl: 300,
    metadata: { name: 'Billing watcher', description: 'D-201 Slice 10S fixture.', author: 'recued-core', supported_platforms: ['test'] },
    variables: {},
    prefetch_steps: [],
    steps: [{ id: 'classify', op: 'core.ai.classify', args: {} }],
    output: { sidebar: [{ type: 'summary', source: 'step.classify' }] },
    webhook_requirements: [requirement()],
    webhook_triggers: taking([UPDATED, CANCELED])[0]!.webhook_triggers,
  } as unknown as RecipeDefinition, 'kitchen', 'inline', clock.now);
  const selections = [{ binding: 'billing', ingress_id: ingress.ingress_id }];
  const replace = (eventTypes: string[], change: Partial<PackWebhookRequirement> = {}) =>
    consumerStore.replaceConsumer({
      consumer_kind: 'local_recipe',
      consumer_id: 'kitchen-recipe',
      requirements: eventTypes.length === 0 ? [] : [requirement(change)],
      selections: eventTypes.length === 0 ? [] : selections,
      recipes: eventTypes.length === 0 ? [] : taking(eventTypes),
      enabled: true,
    });
  const preview = (eventTypes: string[], change: Partial<PackWebhookRequirement> = {}) =>
    consumerStore.previewReplacement({
      consumer_kind: 'local_recipe',
      consumer_id: 'kitchen-recipe',
      requirements: [requirement(change)],
      selections,
      recipes: taking(eventTypes),
    });
  const accept = async (suffix: string, eventType: string) => {
    const delivery: WebhookAcceptedDeliveryInput = {
      ingress_id: ingress.ingress_id,
      profile_id: PROFILE,
      environment: 'test',
      received_at: clock.now,
      delivery_dedup_key: `delivery-${suffix}`,
      raw_body_sha256: Buffer.from(suffix).toString('hex').padEnd(64, '0').slice(0, 64),
      decoded_content_type: 'application/json',
      decoded_schema_id: PROFILE,
      transport_assurance: 'authenticated',
      minimum_source_truth_policy: 'delivery_payload_allowed',
      credential_version: '1',
      admission_method: 'fixture',
      freshness_checked: true,
      response: { status: 200 },
      events: [{
        event_dedup_key: `event-${suffix}`,
        provider_event_id: `evt_${suffix}`,
        provider_resource_id: 'sub_fixture',
        provider_event_type: eventType,
        provider_occurred_at: null,
        decoded_payload_json: JSON.stringify({ event_type: eventType }),
      }],
    };
    return (await deliveryStore.accept(delivery)).fresh_events[0]!;
  };
  const handOff = () => dispatchWebhookOutboxOnce(
    deliveryStore,
    createWebhookRecipeOutboxSink(consumerStore),
    { base_retry_ms: 0, max_retry_ms: 0, max_attempts: 2 },
  );
  const runFailing = () => createWebhookRecipeDispatchRuntime(
    { consumerStore, deliveryStore, runner: failing },
    { base_retry_ms: 0, max_retry_ms: 0, max_attempts: 2 },
  ).drain();
  const runSucceeding = () => createWebhookRecipeDispatchRuntime(
    { consumerStore, deliveryStore, runner: succeeding },
    { base_retry_ms: 0, max_retry_ms: 0, max_attempts: 2 },
  ).drain();
  replace([UPDATED, CANCELED]);
  clock.now = T0;
  return { db, clock, consumerStore, selections, replace, preview, accept, handOff, runFailing, runSucceeding };
};

type World = Awaited<ReturnType<typeof world>>;

/** The two triggers on the slot, by event: canceled's history, then updated's. */
const both = (canceled: 'kept' | 'closed', updated: 'kept' | 'closed') => [
  { slot: 'billing', event_type: CANCELED, history: canceled },
  { slot: 'billing', event_type: UPDATED, history: updated },
];

const targetOf = (w: World, eventId: string) => w.db.prepare(`
  SELECT dispatch_id, state, resolved_at FROM webhook_recipe_dispatches WHERE event_id = ?
`).get(eventId) as { dispatch_id: string; state: string; resolved_at: number | null };

/** A dead letter for `eventType`, and a delivery of `waitingType` waiting. */
const withHistory = async (w: World, eventType: string, waitingType: string) => {
  const dead = await w.accept('dead', eventType);
  await w.handOff();
  await w.runFailing();
  expect(targetOf(w, dead.event_id)).toMatchObject({ state: 'dead_letter', resolved_at: null });
  w.clock.now += 1_000;
  const waiting = await w.accept('waiting', waitingType);
  await w.handOff();
  expect(targetOf(w, waiting.event_id)).toMatchObject({ state: 'pending' });
  w.clock.now += 1_000;
  return { dead, waiting };
};

describe('D-201 Slice 10S — the history per trigger, and what a closed one says', () => {
  it('the question says the history closes when a draft drops an event its slot only allows (10Q finding 4)', async () => {
    const w = await world();
    expect(w.preview([UPDATED, CANCELED])).toEqual({ history: 'kept', widened: [], triggers: both('kept', 'kept') });
    // The slot continues: its required events are the same. The trigger does not.
    expect(w.preview([UPDATED])).toEqual({ history: 'closed', widened: [], triggers: both('closed', 'kept') });
  });

  it('a slot that would trust each message unchecked is named, and its history closes (10Q finding 14)', async () => {
    // Reading each message back from Paddle takes a paired connection.
    const w = await world({ paired: true });
    const readBack = { source_truth_policy: 'provider_readback_required', paired_connection_slot: 'paddle' } as const;
    w.replace([UPDATED, CANCELED], readBack);
    expect(w.preview([UPDATED, CANCELED], { ...readBack, source_truth_policy: 'delivery_payload_allowed' }))
      .toEqual({ history: 'closed', widened: ['billing:delivery_payload_allowed'], triggers: both('closed', 'closed') });
    // Reading back still, nothing widens and the history stays.
    expect(w.preview([UPDATED, CANCELED], readBack)).toEqual({ history: 'kept', widened: [], triggers: both('kept', 'kept') });
  });

  it("a keep-on save dropping an event closes that event's dead letter as saved differently, and keeps the other's waiting delivery", async () => {
    const w = await world();
    const { dead, waiting } = await withHistory(w, CANCELED, UPDATED);
    const prior = w.replace([UPDATED]);
    // As the Kitchen save finalizes it: the recipe remains.
    w.consumerStore.finalizeConsumerReplacement(prior, { recipeRemains: (id) => id === 'kitchen-recipe' });
    expect(listWebhookDeadLetterReviews(w.db, { kind: 'target', id: targetOf(w, dead.event_id).dispatch_id }).at(-1))
      .toMatchObject({ action: 'expire', reason: 'recipe_replaced' });
    expect(targetOf(w, waiting.event_id)).toMatchObject({ state: 'pending' });
  });

  it('without a caller to say, a recipe that still takes another event remains (the start finishing a save)', async () => {
    const w = await world();
    const { dead } = await withHistory(w, CANCELED, UPDATED);
    w.consumerStore.finalizeConsumerReplacement(w.replace([UPDATED]));
    expect(listWebhookDeadLetterReviews(w.db, { kind: 'target', id: targetOf(w, dead.event_id).dispatch_id }).at(-1))
      .toMatchObject({ reason: 'recipe_replaced' });
  });

  it('a recipe deleted closes as removed; one saved without its webhook, as saved differently', async () => {
    const deleted = await world();
    const gone = await withHistory(deleted, CANCELED, UPDATED);
    deleted.consumerStore.finalizeConsumerReplacement(deleted.replace([]));
    expect(listWebhookDeadLetterReviews(deleted.db, { kind: 'target', id: targetOf(deleted, gone.dead.event_id).dispatch_id }).at(-1))
      .toMatchObject({ reason: 'recipe_removed' });

    const unwebhooked = await world();
    const kept = await withHistory(unwebhooked, CANCELED, UPDATED);
    unwebhooked.consumerStore.finalizeConsumerReplacement(unwebhooked.replace([]), { recipeRemains: () => true });
    expect(listWebhookDeadLetterReviews(unwebhooked.db, { kind: 'target', id: targetOf(unwebhooked, kept.dead.event_id).dispatch_id }).at(-1))
      .toMatchObject({ reason: 'recipe_replaced' });
  });
});

describe('D-201 Slice 10Y — the keep-on question per trigger (10V findings 6 and 19)', () => {
  it('a draft dropping one event says that one closes and the other stays, and a keep-on save does just that (finding 6)', async () => {
    const w = await world();
    const { dead, waiting } = await withHistory(w, CANCELED, UPDATED);
    // 10V reproduced it here: "closed" for the whole history, while the save
    // carried updated's waiting delivery on and ran it.
    expect(w.preview([UPDATED]).triggers).toEqual(both('closed', 'kept'));
    const prior = w.replace([UPDATED]);
    w.consumerStore.finalizeConsumerReplacement(prior, { recipeRemains: (id) => id === 'kitchen-recipe' });
    expect(listWebhookDeadLetterReviews(w.db, { kind: 'target', id: targetOf(w, dead.event_id).dispatch_id }).at(-1))
      .toMatchObject({ action: 'expire', reason: 'recipe_replaced' });
    await w.runSucceeding();
    expect(targetOf(w, waiting.event_id)).toMatchObject({ state: 'dispatched' });
  });

  it('a version under another publisher continues no trigger, so each says it closes (finding 19)', async () => {
    const w = await world();
    expect(w.consumerStore.previewReplacement({
      consumer_kind: 'local_recipe',
      consumer_id: 'kitchen-recipe',
      requirements: [requirement()],
      selections: w.selections,
      recipes: [{ ...taking([UPDATED, CANCELED])[0]!, publisher_id: 'another-publisher' }],
    })).toEqual({ history: 'closed', widened: [], triggers: both('closed', 'closed') });
  });

  it('an event a draft moves to another slot closes on the slot it left (finding 19)', async () => {
    const w = await world();
    // Two slots on the one way in, the recipe taking canceled on billing only.
    const twoSlots = (billing: string[], audit: string[]) => ({
      consumer_kind: 'local_recipe' as const,
      consumer_id: 'kitchen-recipe',
      requirements: [requirement(), requirement({ binding: 'audit' })],
      selections: [...w.selections, { binding: 'audit', ingress_id: w.selections[0]!.ingress_id }],
      recipes: [{
        recipe_id: 'kitchen-recipe',
        publisher_id: 'kitchen',
        webhook_triggers: [
          { binding: 'billing', event_types: billing },
          { binding: 'audit', event_types: audit },
        ],
      }],
    });
    w.consumerStore.replaceConsumer({ ...twoSlots([UPDATED, CANCELED], [UPDATED]), enabled: true });
    // Canceled moves to audit: audit takes it, billing no longer does.
    expect(w.consumerStore.previewReplacement(twoSlots([UPDATED], [UPDATED, CANCELED]))).toEqual({
      history: 'closed',
      widened: [],
      triggers: [
        { slot: 'audit', event_type: UPDATED, history: 'kept' },
        { slot: 'billing', event_type: CANCELED, history: 'closed' },
        { slot: 'billing', event_type: UPDATED, history: 'kept' },
      ],
    });
  });
});
