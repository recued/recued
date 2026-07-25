import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PackWebhookRequirement,
  RecipeDefinition,
} from '@recued/contracts';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
} from '@recued/contracts';
import type { AuditEntry } from '@recued/storage';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { handlePacksUninstall } from '../pack-uninstall-handler.js';
import { installBulkPackOnServer } from '../install-bulk-pack-handler.js';
import {
  createWebhookConsumerStore,
  type WebhookConsumerStore,
} from '../storage/webhook-consumer-store.js';
import {
  createWebhookDeliveryStore,
  type WebhookAcceptedDeliveryInput,
  type WebhookDeliveryStore,
} from '../storage/webhook-delivery-store.js';
import {
  createWebhookIngressStore,
  type WebhookIngressStore,
} from '../storage/webhook-ingress-store.js';
import {
  WebhookEventAccessError,
  createScopedWebhookEventReader,
  createWebhookRecipeOutboxSink,
  type WebhookRecipeRunRequest,
} from '../webhook-recipe-consumer.js';
import { reconcileWebhookAwaitingApprovalDispatches } from '../webhook-recipe-runner.js';
import { dispatchWebhookOutboxOnce } from '../webhook-outbox-dispatcher.js';

const SECRET_KEY = new Uint8Array(32).fill(71);
const PAYLOAD_KEY = new Uint8Array(32).fill(83);
const PACK_SLUG = 'webhook-consumer-pack';
const PUBLISHER = 'fixture-publisher';

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

const requirement = (
  access: 'metadata_only' | 'scoped_read' = 'scoped_read',
): PackWebhookRequirement => ({
  binding: 'generic_delivery',
  profile_ids: ['generic.static-header-token.v1'],
  required_event_types: ['delivery'],
  registration_modes: ['manual'],
  environment_policy: 'test_only',
  decoded_payload_access: access,
  source_truth_policy: 'delivery_payload_allowed',
});

const recipe = (
  recipeId: string,
  eventTypes: readonly string[] = ['delivery'],
  packSlug = PACK_SLUG,
): RecipeDefinition => ({
  recipe_id: recipeId,
  version: 1,
  ttl: 60,
  metadata: {
    name: recipeId,
    description: 'D-201 Slice 4 fixture',
    author: PUBLISHER,
    supported_platforms: [],
    tags: [],
    recipe_bundle: `${PUBLISHER}/${packSlug}`,
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  webhook_triggers: [{
    binding: 'generic_delivery',
    event_types: [...eventTypes],
  }],
});

interface Harness {
  db: Database.Database;
  recipeStore: RecipeStore;
  ingressStore: WebhookIngressStore;
  consumerStore: WebhookConsumerStore;
  deliveryStore: WebhookDeliveryStore;
  ingressId: string;
  setNow(value: number): void;
}

const makeHarness = async (input: {
  bind?: boolean;
  access?: 'metadata_only' | 'scoped_read';
  recipeIds?: readonly string[];
  payloadRetentionMs?: number;
  dedupRetentionMs?: number;
} = {}): Promise<Harness> => {
  const db = new Database(':memory:');
  databases.push(db);
  // Consumer authority must predate an accepted event. Start one millisecond
  // earlier, materialize the fixture binding, then advance to delivery time.
  let stamp = 2_099_999_999_999;
  let bindingId = 0;
  let triggerId = 0;
  let dispatchId = 0;
  let runId = 0;
  let claimId = 0;
  let deliveryId = 0;
  let eventId = 0;
  let payloadId = 0;
  let outboxId = 0;
  let outboxClaimId = 0;
  const recipeStore = createRecipeStore('/path/that/does/not/exist', db);
  const ingressStore = createWebhookIngressStore(db, {
    now: () => stamp,
    getEncryptionKey: () => SECRET_KEY,
    newIngressId: () => 'whi_consumer_fixture_aaaaaaaaaaaaaaaa',
    newPublicId: () => 'consumerFixturePublicId_aaaaaaaa',
    newCredentialSetRef: () => 'whc_consumer_fixture_aaaaaaaaaaaaaaaa',
  });
  const ingress = ingressStore.create({
    display_name: 'Consumer fixture ingress',
    profile_id: 'generic.static-header-token.v1',
    environment: 'test',
    paired_connection_id: null,
    registration_mode: 'manual',
    selected_event_types: ['delivery'],
  });
  await ingressStore.writeCredentialVersion(ingress.ingress_id, {
    header_name: 'x-fixture-token',
    header_token: 'fixture-token',
  });
  db.prepare(`
    UPDATE webhook_ingresses SET
      intake_state = 'enabled', registration_state = 'registered', enabled_at = ?
    WHERE ingress_id = ?
  `).run(stamp, ingress.ingress_id);
  const consumerStore = createWebhookConsumerStore(db, {
    ingressStore,
    now: () => stamp,
    newBindingId: () => `whb_${String(++bindingId).padStart(32, '0')}`,
    newTriggerId: () => `wht_${String(++triggerId).padStart(32, '0')}`,
    newDispatchId: () => `whx_${String(++dispatchId).padStart(32, '0')}`,
    newRunId: () => `whr_${String(++runId).padStart(32, '0')}`,
    newClaimToken: () => `consumer-claim-${++claimId}`,
  });
  const deliveryStore = createWebhookDeliveryStore(db, {
    now: () => stamp,
    getEncryptionKey: () => PAYLOAD_KEY,
    newDeliveryId: () => `whd_${String(++deliveryId).padStart(32, '0')}`,
    newEventId: () => `whe_${String(++eventId).padStart(32, '0')}`,
    newPayloadRef: () => `whp_${String(++payloadId).padStart(32, '0')}`,
    newOutboxId: () => `who_${String(++outboxId).padStart(32, '0')}`,
    newClaimToken: () => `outbox-claim-${++outboxClaimId}`,
    hasDispatchTarget: (ingressId, eventType) =>
      consumerStore.hasDispatchTarget(ingressId, eventType),
    ...(input.payloadRetentionMs !== undefined
      ? { payloadRetentionMs: input.payloadRetentionMs }
      : {}),
    ...(input.dedupRetentionMs !== undefined
      ? { dedupRetentionMs: input.dedupRetentionMs }
      : {}),
  });
  const recipeIds = input.recipeIds ?? ['consumer-recipe-a'];
  for (const recipeIdValue of recipeIds) {
    recipeStore.save(
      recipe(recipeIdValue),
      PUBLISHER,
      'pair-sync',
      stamp,
      PACK_SLUG,
    );
  }
  if (input.bind ?? true) {
    consumerStore.replaceConsumer({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
      requirements: [requirement(input.access)],
      selections: [{
        binding: 'generic_delivery',
        ingress_id: ingress.ingress_id,
      }],
      recipes: recipeIds.map((recipeIdValue) => ({
        recipe_id: recipeIdValue,
        publisher_id: PUBLISHER,
        webhook_triggers: recipe(recipeIdValue).webhook_triggers!,
      })),
    });
  }
  stamp = 2_100_000_000_000;
  return {
    db,
    recipeStore,
    ingressStore,
    consumerStore,
    deliveryStore,
    ingressId: ingress.ingress_id,
    setNow(value) {
      stamp = value;
    },
  };
};

const acceptedInput = (
  harness: Harness,
  suffix = '1',
  receivedAt = 2_100_000_000_000,
): WebhookAcceptedDeliveryInput => ({
  ingress_id: harness.ingressId,
  profile_id: 'generic.static-header-token.v1',
  environment: 'test',
  received_at: receivedAt,
  delivery_dedup_key: `delivery-${suffix}`,
  raw_body_sha256: suffix.padEnd(64, 'a').slice(0, 64),
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
    decoded_payload_json: JSON.stringify({ private_value: `payload-${suffix}` }),
  }],
});

const auditAnchor = (
  runId: string,
  recipeId: string,
  status: AuditEntry['commit_status'],
): AuditEntry => ({
  run_id: runId,
  recipe_id: recipeId,
  recipe_hash: 'fixture-hash',
  started_at: 1,
  finished_at: 2,
  duration_ms: 1,
  commit_status: status,
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: 'webhook',
  instance_id: 'server',
});

describe('D-201 Slices 4/5B2A binding-aware webhook recipe consumption', () => {
  it('keeps a local recipe disarmed and excludes pre-arm deliveries', async () => {
    const harness = await makeHarness();
    const localRecipe = recipe('local-webhook-recipe', ['delivery'], 'local');
    harness.recipeStore.save(localRecipe, 'kitchen', 'inline', 2_100_000_000_000);
    harness.consumerStore.replaceConsumer({
      consumer_kind: 'local_recipe',
      consumer_id: localRecipe.recipe_id,
      requirements: [requirement()],
      selections: [{ binding: 'generic_delivery', ingress_id: harness.ingressId }],
      recipes: [{
        recipe_id: localRecipe.recipe_id,
        publisher_id: 'kitchen',
        webhook_triggers: localRecipe.webhook_triggers!,
      }],
      enabled: false,
    });
    expect(harness.consumerStore.listBindings({
      consumer_kind: 'local_recipe',
      consumer_id: localRecipe.recipe_id,
    })).toEqual([expect.objectContaining({ enabled: false })]);

    const beforeArm = await harness.deliveryStore.accept(acceptedInput(harness));
    harness.setNow(2_100_000_000_001);
    harness.consumerStore.setConsumerEnabled(
      'local_recipe',
      localRecipe.recipe_id,
      true,
    );
    const armed = harness.consumerStore.listBindings({
      consumer_kind: 'local_recipe',
      consumer_id: localRecipe.recipe_id,
    });
    expect(armed).toEqual([expect.objectContaining({
      enabled: true,
      created_at: 2_100_000_000_001,
    })]);

    const calls: Array<{ recipe_id: string; event_id: string }> = [];
    const sink = createWebhookRecipeOutboxSink(harness.consumerStore, {
      async run(run) {
        calls.push({ recipe_id: run.recipe_id, event_id: run.context.webhook.event_id });
        return 'completed';
      },
    });
    await dispatchWebhookOutboxOnce(harness.deliveryStore, sink);
    expect(calls).toEqual([{
      recipe_id: 'consumer-recipe-a',
      event_id: beforeArm.fresh_events[0]!.event_id,
    }]);

    harness.setNow(2_100_000_000_002);
    const afterArm = await harness.deliveryStore.accept(acceptedInput(
      harness,
      'b',
      2_100_000_000_002,
    ));
    const prepared = harness.consumerStore.prepareDispatches({
      event: afterArm.fresh_events[0]!,
      delivery: afterArm.delivery,
    });
    const local = prepared.find((entry) => entry.recipe_id === localRecipe.recipe_id);
    expect(local).toBeDefined();
    const claim = harness.consumerStore.beginDispatch({
      dispatch_id: local!.dispatch_id,
      event: afterArm.fresh_events[0]!,
      delivery: afterArm.delivery,
    });
    expect(claim).not.toBeNull();

    harness.consumerStore.setConsumerEnabled(
      'local_recipe',
      localRecipe.recipe_id,
      false,
    );
    expect(harness.consumerStore.listBindings({
      consumer_kind: 'local_recipe',
      consumer_id: localRecipe.recipe_id,
    })).toEqual([expect.objectContaining({ enabled: false })]);
    expect(() => harness.consumerStore.markDispatchSucceeded(
      claim!.dispatch_id,
      claim!.claim_token,
    )).toThrow(/claim is stale/);
  });

  it('revalidates an already armed consumer instead of accepting a stale no-op', async () => {
    const harness = await makeHarness();
    harness.ingressStore.disable(harness.ingressId);

    expect(() => harness.consumerStore.setConsumerEnabled(
      'pack_install',
      PACK_SLUG,
      true,
    )).toThrow(/no longer ready/);
  });

  it('allows an inert local replacement when the delivery clock cannot advance', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(
      harness,
      'clock-max',
      Number.MAX_SAFE_INTEGER,
    ));
    const localRecipe = recipe('clock-exhausted-local', ['delivery'], 'local');
    harness.recipeStore.save(localRecipe, 'kitchen', 'inline');

    expect(() => harness.consumerStore.replaceConsumer({
      consumer_kind: 'local_recipe',
      consumer_id: localRecipe.recipe_id,
      requirements: [requirement()],
      selections: [{ binding: 'generic_delivery', ingress_id: harness.ingressId }],
      recipes: [{
        recipe_id: localRecipe.recipe_id,
        publisher_id: 'kitchen',
        webhook_triggers: localRecipe.webhook_triggers!,
      }],
      enabled: false,
    })).not.toThrow();
    expect(() => harness.consumerStore.setConsumerEnabled(
      'local_recipe',
      localRecipe.recipe_id,
      true,
    )).toThrow(/clock is exhausted/);
  });

  it('materializes the binding through the real server pack-install adapter', async () => {
    const harness = await makeHarness({ bind: false });
    const finalize = vi.spyOn(
      harness.consumerStore,
      'finalizeConsumerReplacement',
    );
    const definition = recipe('consumer-recipe-a');
    const result = await installBulkPackOnServer(
      {
        manifest_version: BULK_INSTALL_PACK_VERSION,
        pack_slug: PACK_SLUG,
        publisher: PUBLISHER,
        requires: [BULK_PACK_INSTALL_PERMISSION],
        recipes: [{
          slug: definition.recipe_id,
          pinned_version: 1,
          recipe: {
            recipe_id: definition.recipe_id,
            publisher_id: PUBLISHER,
            version: 1,
            recipe_hash: 'fixture-hash',
            recipe: definition,
          },
        }],
        ready: true,
        webhook_requirements: [requirement()],
        webhook_bindings: [{
          binding: 'generic_delivery',
          ingress_id: harness.ingressId,
        }],
      },
      new Set([BULK_PACK_INSTALL_PERMISSION]),
      {
        recipeStore: harness.recipeStore,
        webhookConsumerStore: harness.consumerStore,
        publisherDefault: PUBLISHER,
        now: 2_100_000_000_000,
      },
    );

    expect(result.ok).toBe(true);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(harness.consumerStore.listBindings({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
    })).toEqual([
      expect.objectContaining({
        logical_binding: 'generic_delivery',
        ingress_id: harness.ingressId,
        decoded_payload_access: 'scoped_read',
      }),
    ]);
  });

  it('does not let bulk pack install shadow a Kitchen webhook recipe', async () => {
    const harness = await makeHarness({ bind: false });
    const local = recipe('kitchen-webhook-shadow-guard', ['delivery'], 'local');
    harness.recipeStore.save(local, 'kitchen', 'inline');
    const incoming = recipe(local.recipe_id);

    const result = await installBulkPackOnServer(
      {
        manifest_version: BULK_INSTALL_PACK_VERSION,
        pack_slug: PACK_SLUG,
        publisher: PUBLISHER,
        requires: [BULK_PACK_INSTALL_PERMISSION],
        recipes: [{
          slug: incoming.recipe_id,
          pinned_version: 1,
          recipe: {
            recipe_id: incoming.recipe_id,
            publisher_id: PUBLISHER,
            version: 1,
            recipe_hash: 'fixture-hash',
            recipe: incoming,
          },
        }],
        ready: true,
      },
      new Set([BULK_PACK_INSTALL_PERMISSION]),
      { recipeStore: harness.recipeStore },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('validator_rejected');
    expect(result.failure?.message).toContain('cannot shadow webhook recipe');
    expect(harness.recipeStore.getStored(local.recipe_id)?.pack_slug).toBeNull();
    expect(harness.recipeStore.get(local.recipe_id)?.webhook_triggers).toHaveLength(1);
  });

  it('persists inspection-only events when no installed binding can receive them', async () => {
    const harness = await makeHarness({ bind: false });
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    expect(accepted.fresh_events).toEqual([
      expect.objectContaining({
        selected_for_dispatch: false,
        dispatch_state: 'ignored',
      }),
    ]);
    expect(harness.deliveryStore.listOutbox()).toEqual([]);
  });

  it('fans one outbox item to exact installed recipe targets with minimized context', async () => {
    const harness = await makeHarness({
      recipeIds: ['consumer-recipe-a', 'consumer-recipe-b'],
    });
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    expect(accepted.fresh_events[0]).toMatchObject({
      selected_for_dispatch: true,
      dispatch_state: 'pending',
    });
    expect(harness.deliveryStore.listOutbox()).toHaveLength(1);

    const reader = createScopedWebhookEventReader(
      harness.consumerStore,
      harness.deliveryStore,
    );
    const runs: WebhookRecipeRunRequest[] = [];
    const payloads: unknown[] = [];
    const sink = createWebhookRecipeOutboxSink(harness.consumerStore, {
      async run(run) {
        runs.push(run);
        payloads.push(await reader.read({
          event_ref: run.context.webhook.event_ref,
          recipe_id: run.recipe_id,
          run_id: run.run_id,
        }));
        return 'completed';
      },
    });
    await expect(dispatchWebhookOutboxOnce(harness.deliveryStore, sink))
      .resolves.toMatchObject({ dispatched: 1 });

    expect(runs.map((run) => run.recipe_id)).toEqual([
      'consumer-recipe-a',
      'consumer-recipe-b',
    ]);
    expect(new Set(runs.map((run) => run.run_id)).size).toBe(2);
    expect(runs[0]).toMatchObject({
      idempotency_key: runs[0]!.run_id,
      context: {
        webhook: {
          kind: 'webhook',
          binding: 'generic_delivery',
          event_ref: accepted.fresh_events[0]!.event_id,
          delivery_ref: accepted.delivery.delivery_id,
          provider_event_type: 'delivery',
          duplicate: false,
        },
      },
      // D-209 #1 W3 — the fire is an ANONYMOUS door dispatch. This harness's
      // trigger rows are unstamped (no mint ran), so no contract_id rides the
      // source — the gate floors such a dispatch to `PUBLIC_CONTRACT_ID`.
      execution_source: {
        channel: 'webhook',
        actor: 'anonymous',
        vendor: 'generic',
        webhook_secret_id: harness.ingressId,
      },
    });
    expect(runs[0]!.execution_source.contract_id).toBeUndefined();
    expect(JSON.stringify(runs)).not.toContain('private_value');
    expect(payloads).toEqual([
      expect.objectContaining({ payload: { private_value: 'payload-1' } }),
      expect.objectContaining({ payload: { private_value: 'payload-1' } }),
    ]);
  });

  it('D-209 #1 W3 — a stamped trigger row rides its door contract_id on the dispatch source; an unstamped one stays door-less', async () => {
    const harness = await makeHarness({
      recipeIds: ['consumer-recipe-a', 'consumer-recipe-b'],
    });
    // Stamp ONLY recipe-a's rows (the W2b enrollment step); recipe-b stays NULL
    // — the pre-mint crash-window shape whose dispatch must floor at the gate.
    expect(harness.consumerStore.stampTriggerContracts({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
      recipe_id: 'consumer-recipe-a',
      publisher_id: PUBLISHER,
      contract_id: 'door-recipe-a',
    })).toBeGreaterThan(0);
    await harness.deliveryStore.accept(acceptedInput(harness));

    const runs: WebhookRecipeRunRequest[] = [];
    const sink = createWebhookRecipeOutboxSink(harness.consumerStore, {
      async run(run) {
        runs.push(run);
        return 'completed';
      },
    });
    await expect(dispatchWebhookOutboxOnce(harness.deliveryStore, sink))
      .resolves.toMatchObject({ dispatched: 1 });

    expect(runs.map((run) => run.recipe_id)).toEqual([
      'consumer-recipe-a',
      'consumer-recipe-b',
    ]);
    expect(runs[0]!.execution_source).toMatchObject({
      channel: 'webhook',
      actor: 'anonymous',
      contract_id: 'door-recipe-a',
    });
    expect(runs[1]!.execution_source.actor).toBe('anonymous');
    expect(runs[1]!.execution_source.contract_id).toBeUndefined();
  });

  it('retries the same per-target run identity after a post-side-effect failure', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness));
    const seenRunIds: string[] = [];
    const sideEffects = new Set<string>();
    let crashAfterEffect = true;
    const sink = createWebhookRecipeOutboxSink(harness.consumerStore, {
      async run(run) {
        seenRunIds.push(run.run_id);
        sideEffects.add(run.run_id);
        if (crashAfterEffect) throw new Error('simulated post-run crash');
        return 'completed';
      },
    });

    await expect(dispatchWebhookOutboxOnce(harness.deliveryStore, sink, {
      base_retry_ms: 0,
      max_retry_ms: 0,
    })).resolves.toMatchObject({ retried: 1 });
    crashAfterEffect = false;
    await expect(dispatchWebhookOutboxOnce(harness.deliveryStore, sink, {
      base_retry_ms: 0,
      max_retry_ms: 0,
    })).resolves.toMatchObject({ dispatched: 1 });
    expect(seenRunIds).toHaveLength(2);
    expect(new Set(seenRunIds).size).toBe(1);
    expect(sideEffects.size).toBe(1);
  });

  it('holds approval dispatches without retry burn and reconciles terminal decisions', async () => {
    const harness = await makeHarness({
      payloadRetentionMs: 10,
      dedupRetentionMs: 100,
    });
    const accepted = [
      await harness.deliveryStore.accept(acceptedInput(harness, 'a1')),
      await harness.deliveryStore.accept(acceptedInput(harness, 'b2')),
    ];
    const runs: WebhookRecipeRunRequest[] = [];
    const sink = createWebhookRecipeOutboxSink(harness.consumerStore, {
      async run(run) {
        runs.push(run);
        return 'awaiting_approval';
      },
    });

    // Simulate a process crash after the sink durably hands both runs to owner
    // approval but before the delivery outbox rows are acknowledged.
    for (const item of accepted) {
      await sink.dispatch({
        idempotency_key: item.fresh_events[0]!.event_id,
        event: item.fresh_events[0]!,
        delivery: item.delivery,
      });
    }
    expect(runs).toHaveLength(2);
    expect(harness.db.prepare(`
      SELECT state, attempt_count FROM webhook_recipe_dispatches
      ORDER BY dispatch_id ASC
    `).all()).toEqual([
      { state: 'running', attempt_count: 1 },
      { state: 'running', attempt_count: 1 },
    ]);
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM webhook_waiting_dispatches
    `).get()).toEqual({ count: 2 });
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM webhook_payload_pins
    `).get()).toEqual({ count: 2 });

    await expect(dispatchWebhookOutboxOnce(harness.deliveryStore, sink))
      .resolves.toMatchObject({ claimed: 2, dispatched: 2 });
    expect(runs).toHaveLength(2);
    expect(harness.db.prepare(`
      SELECT attempt_count FROM webhook_recipe_dispatches
      ORDER BY dispatch_id ASC
    `).all()).toEqual([{ attempt_count: 1 }, { attempt_count: 1 }]);

    harness.setNow(2_100_000_000_020);
    expect(harness.deliveryStore.prune()).toMatchObject({ payloads_deleted: 0 });
    const reader = createScopedWebhookEventReader(
      harness.consumerStore,
      harness.deliveryStore,
    );
    for (const run of runs) {
      await expect(reader.read({
        event_ref: run.context.webhook.event_ref,
        recipe_id: run.recipe_id,
        run_id: run.run_id,
      })).resolves.toMatchObject({
        payload: { private_value: expect.stringMatching(/^payload-(a1|b2)$/) },
      });
    }

    const statuses = new Map<string, AuditEntry['commit_status']>();
    const auditLog = {
      get: async (runId: string) => auditAnchor(
        runId,
        'consumer-recipe-a',
        statuses.get(runId) ?? 'awaiting_approval',
      ),
    };
    await expect(reconcileWebhookAwaitingApprovalDispatches(
      harness.consumerStore,
      auditLog,
    )).resolves.toEqual({ scanned: 2, waiting: 2, succeeded: 0, failed: 0 });

    statuses.set(runs[0]!.run_id, 'succeeded');
    statuses.set(runs[1]!.run_id, 'failed');
    await expect(reconcileWebhookAwaitingApprovalDispatches(
      harness.consumerStore,
      auditLog,
    )).resolves.toEqual({ scanned: 2, waiting: 0, succeeded: 1, failed: 1 });
    expect(harness.consumerStore.prepareDispatches({
      event: accepted[0]!.fresh_events[0]!,
      delivery: accepted[0]!.delivery,
    })[0]).toMatchObject({ state: 'dispatched', run_id: runs[0]!.run_id });
    expect(harness.consumerStore.prepareDispatches({
      event: accepted[1]!.fresh_events[0]!,
      delivery: accepted[1]!.delivery,
    })[0]).toMatchObject({ state: 'cancelled', run_id: runs[1]!.run_id });
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM webhook_waiting_dispatches
    `).get()).toEqual({ count: 0 });
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM webhook_payload_pins
    `).get()).toEqual({ count: 0 });
    expect(harness.deliveryStore.prune()).toMatchObject({ payloads_deleted: 2 });
  });

  it('fails closed and releases a hold whose durable audit anchor is missing', async () => {
    const harness = await makeHarness();
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    let runCalls = 0;
    const sink = createWebhookRecipeOutboxSink(harness.consumerStore, {
      async run() {
        runCalls += 1;
        return 'awaiting_approval';
      },
    });
    await sink.dispatch({
      idempotency_key: accepted.fresh_events[0]!.event_id,
      event: accepted.fresh_events[0]!,
      delivery: accepted.delivery,
    });

    await expect(reconcileWebhookAwaitingApprovalDispatches(
      harness.consumerStore,
      { get: async () => null },
    )).resolves.toEqual({ scanned: 1, waiting: 0, succeeded: 0, failed: 1 });
    expect(harness.consumerStore.prepareDispatches({
      event: accepted.fresh_events[0]!,
      delivery: accepted.delivery,
    })[0]).toMatchObject({ state: 'cancelled' });
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM webhook_payload_pins
    `).get()).toEqual({ count: 0 });

    await expect(dispatchWebhookOutboxOnce(harness.deliveryStore, sink))
      .resolves.toMatchObject({ dispatched: 1 });
    expect(runCalls).toBe(1);
  });

  it('bounds and fairly rotates approval reconciliation backlog', async () => {
    const harness = await makeHarness();
    const sink = createWebhookRecipeOutboxSink(harness.consumerStore, {
      async run() {
        return 'awaiting_approval';
      },
    });
    for (let index = 0; index < 26; index += 1) {
      const accepted = await harness.deliveryStore.accept(acceptedInput(
        harness,
        index.toString(16).padStart(2, '0'),
      ));
      await sink.dispatch({
        idempotency_key: accepted.fresh_events[0]!.event_id,
        event: accepted.fresh_events[0]!,
        delivery: accepted.delivery,
      });
    }

    const observed = new Set<string>();
    const auditLog = {
      get: async (runId: string) => {
        observed.add(runId);
        return auditAnchor(runId, 'consumer-recipe-a', 'awaiting_approval');
      },
    };
    await expect(reconcileWebhookAwaitingApprovalDispatches(
      harness.consumerStore,
      auditLog,
    )).resolves.toEqual({ scanned: 25, waiting: 25, succeeded: 0, failed: 0 });
    await expect(reconcileWebhookAwaitingApprovalDispatches(
      harness.consumerStore,
      auditLog,
    )).resolves.toEqual({ scanned: 25, waiting: 25, succeeded: 0, failed: 0 });
    expect(observed.size).toBe(26);
    expect(harness.consumerStore.listAwaitingApprovalDispatches()).toHaveLength(26);
  });

  it('closes a pre-marker terminal result without retrying the target', async () => {
    const harness = await makeHarness();
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    let runCalls = 0;
    const sink = createWebhookRecipeOutboxSink(harness.consumerStore, {
      async run() {
        runCalls += 1;
        return 'terminal_non_success';
      },
    });

    await expect(dispatchWebhookOutboxOnce(harness.deliveryStore, sink))
      .resolves.toMatchObject({ dispatched: 1, retried: 0 });
    expect(harness.consumerStore.prepareDispatches({
      event: accepted.fresh_events[0]!,
      delivery: accepted.delivery,
    })[0]).toMatchObject({ state: 'cancelled' });
    expect(harness.db.prepare(`
      SELECT state, attempt_count FROM webhook_recipe_dispatches
    `).get()).toEqual({ state: 'cancelled', attempt_count: 1 });
    expect(runCalls).toBe(1);
  });

  it('defers replay and reconciliation across a replacement rollback window', async () => {
    const harness = await makeHarness();
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    const event = accepted.fresh_events[0]!;
    const sink = createWebhookRecipeOutboxSink(harness.consumerStore, {
      async run() {
        return 'awaiting_approval';
      },
    });
    await sink.dispatch({
      idempotency_key: event.event_id,
      event,
      delivery: accepted.delivery,
    });
    const [held] = harness.consumerStore.listAwaitingApprovalDispatches();
    expect(held).toBeDefined();

    let releaseAudit!: (entry: AuditEntry) => void;
    let auditReadStarted!: () => void;
    const auditRead = new Promise<void>((resolve) => { auditReadStarted = resolve; });
    const terminalAnchor = new Promise<AuditEntry>((resolve) => {
      releaseAudit = resolve;
    });
    const reconciling = reconcileWebhookAwaitingApprovalDispatches(
      harness.consumerStore,
      {
        get: async () => {
          auditReadStarted();
          return terminalAnchor;
        },
      },
    );
    await auditRead;

    const prior = harness.consumerStore.replaceConsumer({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
      requirements: [requirement('metadata_only')],
      selections: [{ binding: 'generic_delivery', ingress_id: harness.ingressId }],
      recipes: [{
        recipe_id: 'consumer-recipe-a',
        publisher_id: PUBLISHER,
        webhook_triggers: recipe('consumer-recipe-a').webhook_triggers!,
      }],
    });
    await expect(sink.dispatch({
      idempotency_key: event.event_id,
      event,
      delivery: accepted.delivery,
    })).rejects.toThrow(/replacement is still in progress/);

    releaseAudit(auditAnchor(held!.run_id, held!.recipe_id, 'succeeded'));
    await expect(reconciling).resolves.toEqual({
      scanned: 1,
      waiting: 1,
      succeeded: 0,
      failed: 0,
    });
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM webhook_waiting_dispatches
    `).get()).toEqual({ count: 1 });
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM webhook_payload_pins
    `).get()).toEqual({ count: 1 });

    harness.consumerStore.restoreConsumer(prior);
    const [restored] = harness.consumerStore.listAwaitingApprovalDispatches();
    expect(restored).toBeDefined();
    await expect(reconcileWebhookAwaitingApprovalDispatches(
      harness.consumerStore,
      { get: async () => auditAnchor(restored!.run_id, restored!.recipe_id, 'succeeded') },
    )).resolves.toEqual({ scanned: 1, waiting: 0, succeeded: 1, failed: 0 });
  });

  it('does not rerun a completed sibling when a later fan-out target retries', async () => {
    const harness = await makeHarness({
      recipeIds: ['consumer-recipe-a', 'consumer-recipe-b'],
    });
    await harness.deliveryStore.accept(acceptedInput(harness));
    const calls: Array<{ recipe_id: string; run_id: string }> = [];
    let failSecondTarget = true;
    const sink = createWebhookRecipeOutboxSink(harness.consumerStore, {
      async run(run) {
        calls.push({ recipe_id: run.recipe_id, run_id: run.run_id });
        if (run.recipe_id === 'consumer-recipe-b' && failSecondTarget) {
          throw new Error('retry only the second target');
        }
        return 'completed';
      },
    });

    await expect(dispatchWebhookOutboxOnce(harness.deliveryStore, sink, {
      base_retry_ms: 0,
      max_retry_ms: 0,
    })).resolves.toMatchObject({ retried: 1 });
    failSecondTarget = false;
    await expect(dispatchWebhookOutboxOnce(harness.deliveryStore, sink, {
      base_retry_ms: 0,
      max_retry_ms: 0,
    })).resolves.toMatchObject({ dispatched: 1 });

    expect(calls.filter((entry) => entry.recipe_id === 'consumer-recipe-a'))
      .toHaveLength(1);
    const secondTargetCalls = calls.filter(
      (entry) => entry.recipe_id === 'consumer-recipe-b',
    );
    expect(secondTargetCalls).toHaveLength(2);
    expect(new Set(secondTargetCalls.map((entry) => entry.run_id)).size).toBe(1);
  });

  it('does not deliver a queued historical event to a consumer bound afterward', async () => {
    const harness = await makeHarness();
    await harness.deliveryStore.accept(acceptedInput(harness));

    const latePack = 'late-webhook-consumer-pack';
    const lateRecipe = recipe('consumer-recipe-late', ['delivery'], latePack);
    harness.recipeStore.save(
      lateRecipe,
      PUBLISHER,
      'pair-sync',
      2_100_000_000_000,
      latePack,
    );
    // Keep the same millisecond as receipt: ties fail closed because the two
    // tables have no trustworthy cross-table row ordering.
    harness.setNow(2_100_000_000_000);
    harness.consumerStore.replaceConsumer({
      consumer_kind: 'pack_install',
      consumer_id: latePack,
      requirements: [requirement()],
      selections: [{ binding: 'generic_delivery', ingress_id: harness.ingressId }],
      recipes: [{
        recipe_id: lateRecipe.recipe_id,
        publisher_id: PUBLISHER,
        webhook_triggers: lateRecipe.webhook_triggers!,
      }],
    });

    const invoked: string[] = [];
    await dispatchWebhookOutboxOnce(
      harness.deliveryStore,
      createWebhookRecipeOutboxSink(harness.consumerStore, {
        async run(run) {
          invoked.push(run.recipe_id);
          return 'completed';
        },
      }),
    );
    expect(invoked).toEqual(['consumer-recipe-a']);
  });

  it('does not let a wall-clock rollback make a late consumer historical', async () => {
    const harness = await makeHarness();
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));

    const latePack = 'clock-rollback-consumer-pack';
    const lateRecipe = recipe('consumer-recipe-clock-rollback', ['delivery'], latePack);
    harness.recipeStore.save(
      lateRecipe,
      PUBLISHER,
      'pair-sync',
      2_100_000_000_000,
      latePack,
    );
    harness.setNow(2_000_000_000_000);
    harness.consumerStore.replaceConsumer({
      consumer_kind: 'pack_install',
      consumer_id: latePack,
      requirements: [requirement()],
      selections: [{ binding: 'generic_delivery', ingress_id: harness.ingressId }],
      recipes: [{
        recipe_id: lateRecipe.recipe_id,
        publisher_id: PUBLISHER,
        webhook_triggers: lateRecipe.webhook_triggers!,
      }],
    });
    expect(harness.consumerStore.listBindings({
      consumer_kind: 'pack_install',
      consumer_id: latePack,
    })[0]!.created_at).toBeGreaterThan(accepted.delivery.received_at);

    // Recover the dispatcher clock enough to make the already-pending outbox
    // item available; the late binding keeps its logical post-delivery stamp.
    harness.setNow(accepted.delivery.received_at);
    const invoked: string[] = [];
    await dispatchWebhookOutboxOnce(
      harness.deliveryStore,
      createWebhookRecipeOutboxSink(harness.consumerStore, {
        async run(run) {
          invoked.push(run.recipe_id);
          return 'completed';
        },
      }),
    );
    expect(invoked).toEqual(['consumer-recipe-a']);
  });

  it('pins decoded payload retention for the active recipe run after outbox completion', async () => {
    const harness = await makeHarness({
      payloadRetentionMs: 10,
      dedupRetentionMs: 100,
    });
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    const event = accepted.fresh_events[0]!;
    const prepared = harness.consumerStore.prepareDispatches({
      event,
      delivery: accepted.delivery,
    });
    const runClaim = harness.consumerStore.beginDispatch({
      dispatch_id: prepared[0]!.dispatch_id,
      event,
      delivery: accepted.delivery,
    });
    expect(runClaim).not.toBeNull();

    const [outboxClaim] = harness.deliveryStore.claimOutbox({
      limit: 1,
      lease_ms: 1_000,
    });
    harness.deliveryStore.markOutboxDispatched(
      outboxClaim!.outbox_id,
      outboxClaim!.claim_token,
    );
    harness.setNow(2_100_000_000_020);

    expect(harness.deliveryStore.prune()).toMatchObject({ payloads_deleted: 0 });
    await expect(createScopedWebhookEventReader(
      harness.consumerStore,
      harness.deliveryStore,
    ).read({
      event_ref: event.event_id,
      recipe_id: runClaim!.recipe_id,
      run_id: runClaim!.run_id,
    })).resolves.toMatchObject({ payload: { private_value: 'payload-1' } });

    harness.consumerStore.markDispatchSucceeded(
      runClaim!.dispatch_id,
      runClaim!.claim_token,
    );
    expect(harness.deliveryStore.prune()).toMatchObject({ payloads_deleted: 1 });
    await expect(harness.deliveryStore.readEventPayload(event.event_id)).resolves.toBeNull();
  });

  it('rechecks authorization after asynchronous payload decryption', async () => {
    const harness = await makeHarness();
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    const event = accepted.fresh_events[0]!;
    const [prepared] = harness.consumerStore.prepareDispatches({
      event,
      delivery: accepted.delivery,
    });
    const claim = harness.consumerStore.beginDispatch({
      dispatch_id: prepared!.dispatch_id,
      event,
      delivery: accepted.delivery,
    });
    expect(claim).not.toBeNull();

    let releaseDecrypt!: () => void;
    let decryptStarted!: () => void;
    const started = new Promise<void>((resolve) => { decryptStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
    const reader = createScopedWebhookEventReader(harness.consumerStore, {
      getEvent: (eventId) => harness.deliveryStore.getEvent(eventId),
      getDelivery: (deliveryId) => harness.deliveryStore.getDelivery(deliveryId),
      async readEventPayload() {
        decryptStarted();
        await release;
        return { private_value: 'must-not-escape' };
      },
    });
    const pendingRead = reader.read({
      event_ref: event.event_id,
      recipe_id: claim!.recipe_id,
      run_id: claim!.run_id,
    });
    await started;
    harness.consumerStore.removeConsumer('pack_install', PACK_SLUG);
    releaseDecrypt();

    await expect(pendingRead).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('cancels an unbound approval hold and releases its retention pin', async () => {
    const harness = await makeHarness({
      payloadRetentionMs: 10,
      dedupRetentionMs: 100,
    });
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    const event = accepted.fresh_events[0]!;
    const [prepared] = harness.consumerStore.prepareDispatches({
      event,
      delivery: accepted.delivery,
    });
    const claim = harness.consumerStore.beginDispatch({
      dispatch_id: prepared!.dispatch_id,
      event,
      delivery: accepted.delivery,
    });
    expect(claim).not.toBeNull();
    harness.consumerStore.markDispatchAwaitingApproval(
      claim!.dispatch_id,
      claim!.claim_token,
    );
    expect(harness.consumerStore.listAwaitingApprovalDispatches()).toHaveLength(1);

    harness.consumerStore.removeConsumer('pack_install', PACK_SLUG);
    expect(harness.consumerStore.listAwaitingApprovalDispatches()).toEqual([]);
    expect(() => harness.consumerStore.markDispatchSucceeded(
      claim!.dispatch_id,
      claim!.claim_token,
    )).toThrow(/claim is stale/);

    const [outboxClaim] = harness.deliveryStore.claimOutbox({
      limit: 1,
      lease_ms: 1_000,
    });
    harness.deliveryStore.markOutboxDispatched(
      outboxClaim!.outbox_id,
      outboxClaim!.claim_token,
    );
    harness.setNow(2_100_000_000_020);
    expect(harness.deliveryStore.prune()).toMatchObject({ payloads_deleted: 1 });
  });

  it('finalizes a committed replacement by cancelling superseded claims and pins', async () => {
    const harness = await makeHarness({
      payloadRetentionMs: 10,
      dedupRetentionMs: 100,
    });
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    const event = accepted.fresh_events[0]!;
    const [prepared] = harness.consumerStore.prepareDispatches({
      event,
      delivery: accepted.delivery,
    });
    const claim = harness.consumerStore.beginDispatch({
      dispatch_id: prepared!.dispatch_id,
      event,
      delivery: accepted.delivery,
    });
    expect(claim).not.toBeNull();
    harness.consumerStore.markDispatchAwaitingApproval(
      claim!.dispatch_id,
      claim!.claim_token,
    );

    const prior = harness.consumerStore.replaceConsumer({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
      requirements: [requirement()],
      selections: [{ binding: 'generic_delivery', ingress_id: harness.ingressId }],
      recipes: [{
        recipe_id: 'consumer-recipe-a',
        publisher_id: PUBLISHER,
        webhook_triggers: recipe('consumer-recipe-a').webhook_triggers!,
      }],
      enabled: false,
    });
    harness.consumerStore.finalizeConsumerReplacement(prior);
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM webhook_waiting_dispatches
    `).get()).toEqual({ count: 0 });
    expect(() => harness.consumerStore.markDispatchSucceeded(
      claim!.dispatch_id,
      claim!.claim_token,
    )).toThrow(/claim is stale/);

    const [outboxClaim] = harness.deliveryStore.claimOutbox({
      limit: 1,
      lease_ms: 1_000,
    });
    harness.deliveryStore.markOutboxDispatched(
      outboxClaim!.outbox_id,
      outboxClaim!.claim_token,
    );
    harness.setNow(2_100_000_000_020);
    expect(harness.deliveryStore.prune()).toMatchObject({ payloads_deleted: 1 });
  });

  it('denies metadata-only, wrong-run, wrong-recipe, completed, and unbound reads', async () => {
    const metadataOnly = await makeHarness({ access: 'metadata_only' });
    await metadataOnly.deliveryStore.accept(acceptedInput(metadataOnly));
    const reader = createScopedWebhookEventReader(
      metadataOnly.consumerStore,
      metadataOnly.deliveryStore,
    );
    const failures: string[] = [];
    const sink = createWebhookRecipeOutboxSink(metadataOnly.consumerStore, {
      async run(run) {
        for (const attempt of [
          { recipe_id: run.recipe_id, run_id: run.run_id },
          { recipe_id: 'another-recipe', run_id: run.run_id },
          { recipe_id: run.recipe_id, run_id: 'whr_wrong_run_identity' },
        ]) {
          try {
            await reader.read({
              event_ref: run.context.webhook.event_ref,
              ...attempt,
            });
          } catch (error) {
            failures.push((error as WebhookEventAccessError).code);
          }
        }
        return 'completed';
      },
    });
    await dispatchWebhookOutboxOnce(metadataOnly.deliveryStore, sink);
    expect(failures).toEqual([
      'not_authorized',
      'not_authorized',
      'not_authorized',
    ]);

    const scoped = await makeHarness();
    const accepted = await scoped.deliveryStore.accept(acceptedInput(scoped));
    let completedRun: WebhookRecipeRunRequest | null = null;
    await dispatchWebhookOutboxOnce(
      scoped.deliveryStore,
      createWebhookRecipeOutboxSink(scoped.consumerStore, {
        async run(run) {
          completedRun = run;
          scoped.consumerStore.removeConsumer('pack_install', PACK_SLUG);
          await expect(createScopedWebhookEventReader(
            scoped.consumerStore,
            scoped.deliveryStore,
          ).read({
            event_ref: run.context.webhook.event_ref,
            recipe_id: run.recipe_id,
            run_id: run.run_id,
          })).rejects.toMatchObject({ code: 'not_authorized' });
          return 'completed';
        },
      }),
    );
    expect(completedRun).not.toBeNull();
    await expect(createScopedWebhookEventReader(
      scoped.consumerStore,
      scoped.deliveryStore,
    ).read({
      event_ref: accepted.fresh_events[0]!.event_id,
      recipe_id: completedRun!.recipe_id,
      run_id: completedRun!.run_id,
    })).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('replaces and restores a consumer snapshot without touching the shared ingress', async () => {
    const harness = await makeHarness();
    const accepted = await harness.deliveryStore.accept(acceptedInput(harness));
    const [prepared] = harness.consumerStore.prepareDispatches({
      event: accepted.fresh_events[0]!,
      delivery: accepted.delivery,
    });
    const claim = harness.consumerStore.beginDispatch({
      dispatch_id: prepared!.dispatch_id,
      event: accepted.fresh_events[0]!,
      delivery: accepted.delivery,
    });
    expect(claim).not.toBeNull();
    const prior = harness.consumerStore.replaceConsumer({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
      requirements: [requirement('metadata_only')],
      selections: [{ binding: 'generic_delivery', ingress_id: harness.ingressId }],
      recipes: [{
        recipe_id: 'consumer-recipe-a',
        publisher_id: PUBLISHER,
        webhook_triggers: recipe('consumer-recipe-a').webhook_triggers!,
      }],
    });
    expect(harness.consumerStore.listBindings({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
    })[0]).toMatchObject({ decoded_payload_access: 'metadata_only' });

    harness.consumerStore.restoreConsumer(prior);
    expect(harness.consumerStore.listBindings({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
    })[0]).toMatchObject({ decoded_payload_access: 'scoped_read' });
    expect(() => harness.consumerStore.markDispatchSucceeded(
      claim!.dispatch_id,
      claim!.claim_token,
    )).not.toThrow();
    expect(harness.ingressStore.get(harness.ingressId)).not.toBeNull();
  });

  it('uninstall removes the binding and installed recipe but retains the shared ingress', async () => {
    const harness = await makeHarness();
    const { result } = await handlePacksUninstall(
      {
        recipeStore: harness.recipeStore,
        webhookConsumerStore: harness.consumerStore,
        packDir: '/path/that/does/not/exist',
      },
      { pack_slug: PACK_SLUG },
    );

    expect(result.ok).toBe(true);
    expect(result.removed.recipes).toEqual(['consumer-recipe-a']);
    expect(harness.consumerStore.listBindings({
      consumer_kind: 'pack_install',
      consumer_id: PACK_SLUG,
    })).toEqual([]);
    expect(harness.recipeStore.get('consumer-recipe-a')).toBeNull();
    expect(harness.ingressStore.get(harness.ingressId)).not.toBeNull();
  });
});
