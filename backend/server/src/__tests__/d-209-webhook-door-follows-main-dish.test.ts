/** D-209 — a recipe's webhook door FOLLOWS ITS MAIN DISH, driven through the
 *  REAL stores and the real dish rpc functions.
 *
 *  A webhook-started run takes the main dish's settings, and its door is derived
 *  from them: which account a step reads is a DISH value (D-207 §5.1c-bis). Doors
 *  were minted only at `recipe.save` and pack install, so:
 *
 *    - ⛔ a pack recipe whose account is a dish setting got NO door at install —
 *      a fresh install has no dish — and every delivery was refused before the
 *      recipe ran (all 32 shipped vendor webhook recipes name theirs
 *      `{{config.<vendor>}}`);
 *    - and once the owner chose the account, nothing re-derived the door.
 *
 *  The hook is wired here exactly as `compose-listeners.ts` binds it; the binding
 *  itself is pinned in `serve-compose-listeners.test.ts`.
 *
 *  Spec: D-209 §1.4; D-207 §5.1c-bis / §5.1g. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
} from '@recued/contracts';

import { createDish, deleteDish, mainDishFor, updateDish, type DishHandlerDeps } from '../dish-handler.js';
import { createDishStore } from '../dish-store.js';
import { installBulkPackOnServer } from '../install-bulk-pack-handler.js';
import { composeInstallConfigResolver } from '../recipe-capability-wiring.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createContractStore } from '../storage/contract-store.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
} from '../storage/contract-definition-store.js';
import {
  createWebhookConsumerStore,
  type WebhookConsumerStore,
} from '../storage/webhook-consumer-store.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { followMainDishWebhookDoors, type WebhookDoorEnrollDeps } from '../webhook-door-enroll.js';
import { createSchedule, type ScheduleHandlerDeps } from '../schedule-handler.js';
import { createScheduleStore } from '../schedule-store.js';
import { handleTriggersCreate, type TriggersRpcDeps } from '../triggers/handler.js';
import { createEventTriggersStore } from '../triggers/store.js';

const SECRET_KEY = new Uint8Array(32).fill(73);
const PACK_SLUG = 'acme-webhook-pack';
const PUBLISHER = 'fixture-publisher';
const PAID = 'acme-order-paid';
const REFUNDED = 'acme-order-refunded';

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

/** A pack webhook recipe whose account is a DISH setting — the shape of every
 *  shipped vendor webhook recipe. `connectionDefault` is the variable's default:
 *  blank for a vendor recipe, a name for one that ships a usual account
 *  (Home Assistant's `home-assistant`). */
const webhookRecipe = (recipe_id: string, connectionDefault = ''): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 60,
  metadata: {
    name: recipe_id,
    description: 'D-209 door-follows-the-main-dish fixture',
    author: PUBLISHER,
    supported_platforms: [],
    tags: [],
    recipe_bundle: `${PUBLISHER}/${PACK_SLUG}`,
  },
  variables: {
    acme: { type: 'connection', label: 'Acme account', default: connectionDefault },
  },
  prefetch_steps: [],
  steps: [{
    id: 'order',
    ingredient: 'acme-widgets',
    input: { operation: 'order.read' },
    connection: '{{config.acme}}',
  }],
  output: { sidebar: [] },
  webhook_triggers: [{ binding: 'generic_delivery', event_types: ['delivery'] }],
} as unknown as RecipeDefinition);

interface World {
  consumerStore: WebhookConsumerStore;
  definitionStore: ContractDefinitionStore;
  recipeStore: RecipeStore;
  dishDeps: DishHandlerDeps;
  /** A schedule or trigger made for a recipe WITHOUT naming a dish makes its
   *  main dish when it has none (`mainDishFor`), as the composition binds it. */
  scheduleDeps: ScheduleHandlerDeps;
  triggerDeps: TriggersRpcDeps;
  install(recipes: RecipeDefinition[]): Promise<void>;
  doorIdFor(recipeId: string): string | null;
  liveWebhookDoors(): string[];
  /** Make the next door derivation throw, as a store fault would. */
  failNextDerivation(): void;
}

const makeWorld = async (): Promise<World> => {
  const db = new Database(':memory:');
  databases.push(db);
  let stamp = 2_099_999_999_999;

  const ingressStore = createWebhookIngressStore(db, {
    now: () => stamp,
    getEncryptionKey: () => SECRET_KEY,
  });
  const ingress = ingressStore.create({
    display_name: 'Acme order events',
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
  const consumerStore = createWebhookConsumerStore(db, { ingressStore, now: () => ++stamp });
  const contractStore = createContractStore(db, { now: () => ++stamp });
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const recipeStore = createRecipeStore('/path/that/does/not/exist', db);
  // Production's resolver: the MAIN dish's settings — the ones a pushed run takes.
  const dishStore = createDishStore(db);
  const mainDishConfig = composeInstallConfigResolver(dishStore);
  let failNext = false;
  const doorDeps: WebhookDoorEnrollDeps = {
    definitionStore,
    grantEntryStore,
    consumerStore,
    now: () => ++stamp,
    resolveConfig: (recipeId) => {
      if (failNext) {
        failNext = false;
        throw new Error('injected door fault');
      }
      return mainDishConfig(recipeId);
    },
  };
  const dishDeps: DishHandlerDeps = {
    store: dishStore,
    publisherOf: () => PUBLISHER,
    webhookDoors: {
      mainDishChanged: (recipe_id) => followMainDishWebhookDoors(
        { recipe_id, recipe: recipeStore.get(recipe_id)! },
        { ...doorDeps, consumerStore },
      ),
    },
  };

  const mainDish = (input: Parameters<typeof mainDishFor>[1]) => mainDishFor(dishDeps, input);

  return {
    consumerStore,
    definitionStore,
    recipeStore,
    dishDeps,
    scheduleDeps: { store: createScheduleStore(db), dishStore, mainDish, instanceId: 'i-1', now: () => stamp },
    triggerDeps: { store: createEventTriggersStore(db), dishStore, mainDish, now: () => stamp },
    install: async (recipes) => {
      const result = await installBulkPackOnServer(
        {
          manifest_version: BULK_INSTALL_PACK_VERSION,
          pack_slug: PACK_SLUG,
          publisher: PUBLISHER,
          requires: [BULK_PACK_INSTALL_PERMISSION],
          recipes: recipes.map((recipe) => ({
            slug: recipe.recipe_id,
            pinned_version: 1,
            recipe: {
              recipe_id: recipe.recipe_id,
              publisher_id: PUBLISHER,
              version: 1,
              recipe_hash: `fixture-hash-${recipe.recipe_id}`,
              recipe,
            },
          })),
          ready: true,
          webhook_requirements: [{
            binding: 'generic_delivery',
            profile_ids: ['generic.static-header-token.v1'],
            required_event_types: ['delivery'],
            registration_modes: ['manual'],
            environment_policy: 'any',
            decoded_payload_access: 'metadata_only',
            source_truth_policy: 'delivery_payload_allowed',
          }],
          webhook_bindings: [{ binding: 'generic_delivery', ingress_id: ingress.ingress_id }],
        },
        new Set([BULK_PACK_INSTALL_PERMISSION]),
        {
          recipeStore,
          webhookConsumerStore: consumerStore,
          webhookDoor: doorDeps,
          publisherDefault: PUBLISHER,
        },
      );
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    },
    doorIdFor: (recipeId) =>
      consumerStore.doorContractIdForRecipe('pack_install', PACK_SLUG, recipeId, PUBLISHER),
    liveWebhookDoors: () => definitionStore.list()
      .filter((def) => def.door_types?.includes('webhook') === true
        && (def.revoked_at === undefined || def.revoked_at === null))
      .map((def) => def.contract_id),
    failNextDerivation: () => {
      failNext = true;
    },
  };
};

const connectionsOf = (world: World, contractId: string | null) =>
  contractId === null ? null : world.definitionStore.get(contractId)?.scope.connection_names;

describe('D-209 — the webhook door follows the main dish', () => {
  it('a fresh install has no door; the first dish, with the account, opens it — and says so', async () => {
    const world = await makeWorld();
    await world.install([webhookRecipe(PAID)]);
    // No dish yet, a blank default: which account the run would use is unknowable.
    expect(world.doorIdFor(PAID)).toBeNull();

    const made = createDish(world.dishDeps, { recipe_id: PAID, config_overlay: { acme: 'acme-prod' } });

    expect(made.dish.is_default).toBe(true);
    // §5.1g — the surface that saved is told what the webhook may now do.
    expect(made.webhook_doors).toEqual([{
      recipe_id: PAID,
      recipe_name: PAID,
      state: 'opened',
      was_open: false,
      operation_ids: [],
      added: ['connection:acme-prod', 'ingredient:acme-widgets'],
      removed: [],
    }]);
    const doorId = world.doorIdFor(PAID);
    expect(doorId).not.toBeNull();
    expect(connectionsOf(world, doorId)).toEqual(['acme-prod']);
    expect(world.liveWebhookDoors()).toEqual([doorId]);
  });

  it('changing the main dish\'s account re-mints the door and retires the one it replaces', async () => {
    const world = await makeWorld();
    await world.install([webhookRecipe(PAID)]);
    const main = createDish(world.dishDeps, { recipe_id: PAID, config_overlay: { acme: 'acme-prod' } }).dish;
    const first = world.doorIdFor(PAID)!;

    const changed = updateDish(world.dishDeps, main.dish_id, { config_overlay: { acme: 'acme-staging' } });

    expect(changed.webhook_doors).toEqual([expect.objectContaining({
      state: 'opened',
      was_open: true,
      added: ['connection:acme-staging'],
      removed: ['connection:acme-prod'],
    })]);
    const next = world.doorIdFor(PAID)!;
    expect(next).not.toBe(first);
    expect(connectionsOf(world, next)).toEqual(['acme-staging']);
    expect(world.definitionStore.get(first)).toMatchObject({ revocation_reason: 'dish_settings_changed' });
    expect(world.liveWebhookDoors()).toEqual([next]);
  });

  it('a change that leaves the account alone moves nothing, and reports nothing', async () => {
    const world = await makeWorld();
    await world.install([webhookRecipe(PAID)]);
    const main = createDish(world.dishDeps, { recipe_id: PAID, config_overlay: { acme: 'acme-prod' } }).dish;
    const door = world.doorIdFor(PAID)!;

    expect(updateDish(world.dishDeps, main.dish_id, { name: 'Production orders' }))
      .not.toHaveProperty('webhook_doors');
    expect(updateDish(world.dishDeps, main.dish_id, { config_overlay: { acme: 'acme-prod' } }))
      .not.toHaveProperty('webhook_doors');
    expect(world.doorIdFor(PAID)).toBe(door);
    expect(world.liveWebhookDoors()).toEqual([door]);
  });

  it('a dish that is not the main one moves nothing — until it is made main', async () => {
    const world = await makeWorld();
    await world.install([webhookRecipe(PAID)]);
    createDish(world.dishDeps, { recipe_id: PAID, config_overlay: { acme: 'acme-prod' } });
    const door = world.doorIdFor(PAID)!;

    const other = createDish(world.dishDeps, { recipe_id: PAID, config_overlay: { acme: 'acme-staging' } });
    expect(other.dish.is_default).toBe(false);
    expect(other).not.toHaveProperty('webhook_doors');
    expect(updateDish(world.dishDeps, other.dish.dish_id, { config_overlay: { acme: 'acme-eu' } }))
      .not.toHaveProperty('webhook_doors');
    expect(world.doorIdFor(PAID)).toBe(door);

    const promoted = updateDish(world.dishDeps, other.dish.dish_id, { main: true });
    expect(promoted.webhook_doors).toEqual([expect.objectContaining({
      state: 'opened',
      added: ['connection:acme-eu'],
      removed: ['connection:acme-prod'],
    })]);
    expect(connectionsOf(world, world.doorIdFor(PAID))).toEqual(['acme-eu']);
  });

  it('deleting the main dish hands the door to the next dish\'s settings', async () => {
    const world = await makeWorld();
    await world.install([webhookRecipe(PAID)]);
    const main = createDish(world.dishDeps, { recipe_id: PAID, config_overlay: { acme: 'acme-prod' } }).dish;
    createDish(world.dishDeps, { recipe_id: PAID, config_overlay: { acme: 'acme-staging' } });

    const deleted = deleteDish(world.dishDeps, main.dish_id);

    expect(deleted.webhook_doors).toEqual([expect.objectContaining({
      state: 'opened',
      added: ['connection:acme-staging'],
      removed: ['connection:acme-prod'],
    })]);
    expect(connectionsOf(world, world.doorIdFor(PAID))).toEqual(['acme-staging']);
  });

  it('⛔ deleting the only dish closes the door, and a new one RE-OPENS it — a machine closing is not the owner\'s', async () => {
    /** The rows here are not re-created (as `replaceConsumer` re-creates every
     *  other caller's), so a refusal once retired the door with its id still
     *  STAMPED. D-295 reads "revoked while stamped" as the OWNER's revocation, so
     *  the next dish found it `kept_revoked`: the webhook stayed shut for good. */
    const world = await makeWorld();
    await world.install([webhookRecipe(PAID)]);
    const main = createDish(world.dishDeps, { recipe_id: PAID, config_overlay: { acme: 'acme-prod' } }).dish;
    const first = world.doorIdFor(PAID)!;

    const deleted = deleteDish(world.dishDeps, main.dish_id);
    expect(deleted.webhook_doors).toEqual([{
      recipe_id: PAID,
      recipe_name: PAID,
      state: 'closed',
      was_open: true,
      reason: expect.stringContaining('resolves its connection at runtime'),
      reason_code: 'no_account',
    }]);
    // Door-less rows refuse every delivery, and no stamp names the retired door.
    expect(world.doorIdFor(PAID)).toBeNull();
    expect(world.definitionStore.get(first)).toMatchObject({ revocation_reason: 'dish_settings_changed' });
    expect(world.liveWebhookDoors()).toEqual([]);

    const remade = createDish(world.dishDeps, { recipe_id: PAID, config_overlay: { acme: 'acme-prod' } });
    expect(remade.webhook_doors).toEqual([expect.objectContaining({ state: 'opened', was_open: false })]);
    const reopened = world.doorIdFor(PAID)!;
    expect(reopened).not.toBe(first);
    expect(world.liveWebhookDoors()).toEqual([reopened]);
  });

  it('⛔ D-295 — a door its OWNER revoked stays revoked through a settings change', async () => {
    const world = await makeWorld();
    await world.install([webhookRecipe(PAID)]);
    const main = createDish(world.dishDeps, { recipe_id: PAID, config_overlay: { acme: 'acme-prod' } }).dish;
    const door = world.doorIdFor(PAID)!;
    world.definitionStore.revoke(door, 'Revoked from Settings');

    const changed = updateDish(world.dishDeps, main.dish_id, { config_overlay: { acme: 'acme-staging' } });

    expect(changed.webhook_doors).toEqual([{ recipe_id: PAID, recipe_name: PAID, state: 'kept_revoked', was_open: false }]);
    expect(world.doorIdFor(PAID)).toBe(door);
    expect(world.definitionStore.get(door)).toMatchObject({ revocation_reason: 'Revoked from Settings' });
    expect(world.liveWebhookDoors()).toEqual([]);
  });

  it('a usual account in the default opens the door at install; a dish that agrees moves nothing', async () => {
    const world = await makeWorld();
    await world.install([webhookRecipe(PAID, 'acme-prod')]);
    // The run would use the default with no dish, so the door is derived from it.
    const door = world.doorIdFor(PAID)!;
    expect(connectionsOf(world, door)).toEqual(['acme-prod']);

    const made = createDish(world.dishDeps, { recipe_id: PAID, config_overlay: {} });
    expect(made).not.toHaveProperty('webhook_doors');
    expect(world.doorIdFor(PAID)).toBe(door);

    const changed = updateDish(world.dishDeps, made.dish.dish_id, { config_overlay: { acme: 'acme-eu' } });
    expect(changed.webhook_doors).toEqual([expect.objectContaining({ state: 'opened' })]);
    expect(connectionsOf(world, world.doorIdFor(PAID))).toEqual(['acme-eu']);
  });

  it('a door fault never fails the settings save: the webhook says it is closed, and leaves no live door', async () => {
    /** The save has already committed, so a fault re-deriving the door must not
     *  report it as failed — the install and save paths wrap their reconcile the
     *  same way. */
    const world = await makeWorld();
    await world.install([webhookRecipe(PAID)]);
    const main = createDish(world.dishDeps, { recipe_id: PAID, config_overlay: { acme: 'acme-prod' } }).dish;
    const first = world.doorIdFor(PAID)!;

    world.failNextDerivation();
    const changed = updateDish(world.dishDeps, main.dish_id, { config_overlay: { acme: 'acme-staging' } });

    expect(changed.dish.config_overlay).toEqual({ acme: 'acme-staging' });
    expect(changed.webhook_doors).toEqual([{
      recipe_id: PAID,
      recipe_name: PAID,
      state: 'closed',
      was_open: true,
      reason: 'injected door fault',
      reason_code: 'fault',
    }]);
    expect(world.doorIdFor(PAID)).toBeNull();
    expect(world.definitionStore.get(first)).toMatchObject({ revocation_reason: 'dish_settings_changed' });
    expect(world.liveWebhookDoors()).toEqual([]);

    // The next save re-derives it — a machine closing, not the owner's.
    const again = updateDish(world.dishDeps, main.dish_id, { config_overlay: { acme: 'acme-staging' } });
    expect(again.webhook_doors).toEqual([expect.objectContaining({ state: 'opened' })]);
    expect(connectionsOf(world, world.doorIdFor(PAID))).toEqual(['acme-staging']);
  });

  it('a schedule made for a recipe with no dish makes its main dish — and reports the door that opened', async () => {
    const world = await makeWorld();
    await world.install([webhookRecipe(PAID)]);

    const made = createSchedule(world.scheduleDeps, {
      recipe_id: PAID,
      publisher_id: PUBLISHER,
      cron_expression: '0 8 * * *',
      config_overlay: { acme: 'acme-prod' },
    });

    expect(made.webhook_doors).toEqual([expect.objectContaining({
      recipe_id: PAID,
      state: 'opened',
      was_open: false,
      added: ['connection:acme-prod', 'ingredient:acme-widgets'],
    })]);
    expect(connectionsOf(world, world.doorIdFor(PAID))).toEqual(['acme-prod']);

    // A second schedule joins the main dish that now exists: nothing moves.
    const second = createSchedule(world.scheduleDeps, {
      recipe_id: PAID, publisher_id: PUBLISHER, cron_expression: '0 18 * * *',
    });
    expect(second).not.toHaveProperty('webhook_doors');
  });

  it('an owner-made trigger for a recipe with no dish reports the door its main dish opened', async () => {
    const world = await makeWorld();
    await world.install([webhookRecipe(REFUNDED)]);

    const made = await handleTriggersCreate(world.triggerDeps, {
      recipe_id: REFUNDED,
      publisher_id: PUBLISHER,
      pattern: 'data.mail.**.created',
      config_overlay: { acme: 'acme-prod' },
    });

    expect(made.webhook_doors).toEqual([expect.objectContaining({ recipe_id: REFUNDED, state: 'opened' })]);
    expect(connectionsOf(world, world.doorIdFor(REFUNDED))).toEqual(['acme-prod']);
  });

  it('a sibling recipe of the same pack keeps its door when one recipe\'s dish changes', async () => {
    const world = await makeWorld();
    await world.install([webhookRecipe(PAID), webhookRecipe(REFUNDED)]);
    const paidMain = createDish(world.dishDeps, { recipe_id: PAID, config_overlay: { acme: 'acme-prod' } }).dish;
    createDish(world.dishDeps, { recipe_id: REFUNDED, config_overlay: { acme: 'acme-prod' } });
    const siblingDoor = world.doorIdFor(REFUNDED)!;

    // One consumer starts both recipes; the snapshot a reconcile diffs against
    // is narrowed to the recipe — given the whole one, the sibling's door would
    // be retired as "not re-used".
    const owners = world.consumerStore.consumersOfRecipe(PAID);
    expect(owners.map((owner) => [owner.consumer_kind, owner.consumer_id])).toEqual([['pack_install', PACK_SLUG]]);
    expect(new Set(owners[0]!.snapshot.triggers.map((row) => row.recipe_id))).toEqual(new Set([PAID]));

    updateDish(world.dishDeps, paidMain.dish_id, { config_overlay: { acme: 'acme-staging' } });
    deleteDish(world.dishDeps, paidMain.dish_id);

    expect(world.doorIdFor(REFUNDED)).toBe(siblingDoor);
    expect(world.liveWebhookDoors()).toEqual([siblingDoor]);
  });
});
