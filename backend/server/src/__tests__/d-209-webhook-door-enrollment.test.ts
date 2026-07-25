/** D-209 #1 W2b — webhook door ENROLLMENT, driven through the REAL stores.
 *
 *  The gate under test is the whole save-time ordering:
 *
 *      replaceConsumer → recipe save → mint → STAMP trigger rows → retire prior
 *
 *  and every store here is real (SQLite recipe store, schema-validated contract
 *  store, real consumer store with a real enabled ingress) because the two bugs
 *  this arc keeps finding — a schema that rejects what the const allows, and a
 *  rollback that loses what only the real snapshot carries — are invisible to a
 *  fake store. Only the failure-injection wrapper around `RecipeStore.save` is
 *  synthetic, and it delegates everything else to the real store.
 *
 *  Spec: `docs/d-209-spec.md` §1.4; `docs/d-207-spec.md` §5.1b / §5.1d. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
} from '@recued/contracts';

import {
  handleLocalRecipeWebhookArm,
  handleLocalRecipeWebhookStatus,
  saveRecipeInline,
  type RecipeSaveHandlerDeps,
} from '../recipe-save-handler.js';
import { installBulkPackOnServer } from '../install-bulk-pack-handler.js';
import { handlePacksUninstall } from '../pack-uninstall-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import {
  createContractStore,
} from '../storage/contract-store.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
} from '../storage/contract-definition-store.js';
import {
  createContractGrantEntryStore,
  type ContractGrantEntryStore,
} from '../storage/contract-grant-entry-store.js';
import {
  createWebhookConsumerStore,
  type WebhookConsumerStore,
} from '../storage/webhook-consumer-store.js';
import {
  createWebhookIngressStore,
} from '../storage/webhook-ingress-store.js';
import type { WebhookDoorEnrollDeps } from '../webhook-door-enroll.js';

const SECRET_KEY = new Uint8Array(32).fill(71);

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

// ── fixtures ──────────────────────────────────────────────────────────────

/** A parse-valid webhook recipe whose one op step gives the door a real grant
 *  to assert on. `core.ai.classify` is a REGISTERED closed-kind kernel op, so
 *  the D-182 save gate accepts it. */
const webhookRecipe = (
  recipe_id: string,
  extraSteps: Array<Record<string, unknown>> = [],
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  metadata: {
    name: `Name of ${recipe_id}`,
    description: 'D-209 W2b webhook door enrollment fixture.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['test', 'fixture', 'webhook'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'classify', op: 'core.ai.classify', args: {} },
    ...extraSteps,
  ],
  output: { sidebar: [{ type: 'summary', source: 'step.classify' }] },
  webhook_requirements: [{
    binding: 'generic_delivery',
    profile_ids: ['generic.static-header-token.v1'],
    required_event_types: ['delivery'],
    registration_modes: ['manual'],
    environment_policy: 'any',
    decoded_payload_access: 'metadata_only',
    source_truth_policy: 'delivery_payload_allowed',
  }],
  webhook_triggers: [{ binding: 'generic_delivery', event_types: ['delivery'] }],
} as unknown as RecipeDefinition);

/** The same recipe with its webhook block REMOVED — the declaration-removal
 *  save. */
const plainRecipe = (recipe_id: string): RecipeDefinition => {
  const recipe = webhookRecipe(recipe_id) as unknown as Record<string, unknown>;
  delete recipe.webhook_requirements;
  delete recipe.webhook_triggers;
  return recipe as unknown as RecipeDefinition;
};

/** A recipe the door must REFUSE: its dispatch target is a template, so no
 *  honest closure exists (`run-ingredient`'s shape). */
const dynamicDispatchRecipe = (recipe_id: string): RecipeDefinition => {
  const recipe = webhookRecipe(recipe_id) as unknown as Record<string, unknown>;
  recipe.steps = [
    { id: 'classify', ingredient: '{{config.ingredient_slug}}', input: {} },
  ];
  recipe.variables = {
    ingredient_slug: { type: 'string', default: '', label: 'Slug' },
  };
  return recipe as unknown as RecipeDefinition;
};

// ── harness ───────────────────────────────────────────────────────────────

interface Harness {
  db: Database.Database;
  recipeStore: RecipeStore;
  consumerStore: WebhookConsumerStore;
  definitionStore: ContractDefinitionStore;
  grantEntryStore: ContractGrantEntryStore;
  doorDeps: WebhookDoorEnrollDeps;
  saveDeps: RecipeSaveHandlerDeps;
  ingressId: string;
  /** Trip the next `RecipeStore.save` to throw (the cross-store failure). */
  failNextSave(): void;
}

const makeHarness = async (): Promise<Harness> => {
  const db = new Database(':memory:');
  databases.push(db);
  let stamp = 2_099_999_999_999;

  const realRecipeStore = createRecipeStore('/path/that/does/not/exist', db);
  const ingressStore = createWebhookIngressStore(db, {
    now: () => stamp,
    getEncryptionKey: () => SECRET_KEY,
  });
  const ingress = ingressStore.create({
    display_name: 'Door enrollment fixture ingress',
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
    now: () => ++stamp,
  });

  // The REAL schema-validated contract substrate — the same stores the
  // Gateway reads its verdicts from (the d-207 slice-1c lesson: fakes here
  // hid a bug that made the whole feature inert on a real server).
  const contractStore = createContractStore(db, { now: () => ++stamp });
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);

  let failNext = false;
  const recipeStore = new Proxy(realRecipeStore, {
    get(target, property, receiver) {
      if (property === 'save') {
        return (...args: Parameters<RecipeStore['save']>) => {
          if (failNext) {
            failNext = false;
            throw new Error('injected recipe-store save failure');
          }
          return target.save(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const doorDeps: WebhookDoorEnrollDeps = {
    definitionStore,
    grantEntryStore,
    consumerStore,
    now: () => ++stamp,
    resolveConfig: () => undefined,
  };
  const saveDeps: RecipeSaveHandlerDeps = {
    store: recipeStore,
    webhookConsumerStore: consumerStore,
    webhookDoor: doorDeps,
  };

  return {
    db,
    recipeStore,
    consumerStore,
    definitionStore,
    grantEntryStore,
    doorDeps,
    saveDeps,
    ingressId: ingress.ingress_id,
    failNextSave: () => {
      failNext = true;
    },
  };
};

const bindings = (harness: Harness) => [
  { binding: 'generic_delivery', ingress_id: harness.ingressId },
];

const doorIdFor = (harness: Harness, recipeId: string): string | null =>
  harness.consumerStore.doorContractIdForRecipe(
    'local_recipe',
    recipeId,
    recipeId,
    'kitchen',
  );

// ── recipe.save — mint / re-use / replace / retire ────────────────────────

describe('D-209 #1 W2b — recipe.save mints the webhook door and stamps the trigger rows', () => {
  it('a first save mints, grants, stamps every trigger row, and stays DISARMED', async () => {
    const harness = await makeHarness();
    const saved = saveRecipeInline(
      harness.saveDeps,
      webhookRecipe('door-first-save'),
      undefined,
      bindings(harness),
    );

    expect(saved.webhook?.door).toMatchObject({
      state: 'minted',
      operation_ids: ['core.ai.classify'],
      added: ['core.ai.classify'],
      removed: [],
    });
    const contractId = saved.webhook?.door?.contract_id;
    expect(contractId).toBeDefined();

    // The stamp is on the ROW (the dispatch hop W3 reads), not just the response.
    expect(doorIdFor(harness, 'door-first-save')).toBe(contractId);

    // The definition is a WEBHOOK door with the authored `admin` ceiling, and
    // its grant rows land in the store the Gateway reads.
    const stored = harness.definitionStore.get(contractId!);
    expect(stored?.door_types).toEqual(['webhook']);
    expect(stored?.max_risk_without_approval).toBe('admin');
    expect(stored?.scope.actors).toEqual(['anonymous']);
    expect(harness.grantEntryStore.get(contractId!, 'core.ai.classify')).toBe(true);

    // Minting is substrate; ARMING stays the separate consent gesture.
    expect(saved.webhook?.armed).toBe(false);
  });

  it('a re-save with an unchanged capability RE-USES the door silently (§5.1b)', async () => {
    const harness = await makeHarness();
    const recipe = webhookRecipe('door-resave-unchanged');
    const first = saveRecipeInline(harness.saveDeps, recipe, undefined, bindings(harness));
    const second = saveRecipeInline(harness.saveDeps, recipe, undefined, bindings(harness));

    expect(second.webhook?.door).toMatchObject({
      state: 'minted',
      contract_id: first.webhook?.door?.contract_id,
      added: [],
      removed: [],
    });
    // Not retired, not re-minted — one live definition.
    const stored = harness.definitionStore.get(first.webhook!.door!.contract_id!);
    expect(stored?.revoked_at ?? null).toBeNull();
    expect(harness.definitionStore.list()).toHaveLength(1);
  });

  it('a capability WIDENING mints a replacement, stamps it, and retires the prior door', async () => {
    const harness = await makeHarness();
    const first = saveRecipeInline(
      harness.saveDeps,
      webhookRecipe('door-widen'),
      undefined,
      bindings(harness),
    );
    const widened = saveRecipeInline(
      harness.saveDeps,
      webhookRecipe('door-widen', [
        { id: 'extra', op: 'acme.widgets.gadget.read', args: {} },
      ]),
      undefined,
      bindings(harness),
    );

    const priorId = first.webhook!.door!.contract_id!;
    const nextId = widened.webhook!.door!.contract_id!;
    expect(nextId).not.toBe(priorId);
    // The diff IS the consent payload the arm surface (Task 3) will render.
    expect(widened.webhook?.door?.added).toEqual(['acme.widgets.gadget.read']);
    expect(widened.webhook?.door?.removed).toEqual([]);

    expect(doorIdFor(harness, 'door-widen')).toBe(nextId);
    // Supersession: the prior door stopped governing the moment it was retired.
    expect(harness.definitionStore.get(priorId)?.revoked_at).toBeDefined();
    expect(harness.definitionStore.get(priorId)?.revocation_reason).toBe('resaved');
    expect(harness.definitionStore.get(nextId)?.revoked_at ?? null).toBeNull();
  });

  it('a save that DROPS the webhook block retires the door with the rows', async () => {
    const harness = await makeHarness();
    const first = saveRecipeInline(
      harness.saveDeps,
      webhookRecipe('door-removal'),
      undefined,
      bindings(harness),
    );
    const removed = saveRecipeInline(harness.saveDeps, plainRecipe('door-removal'));

    expect(removed.webhook).toBeUndefined();
    expect(doorIdFor(harness, 'door-removal')).toBeNull();
    const prior = harness.definitionStore.get(first.webhook!.door!.contract_id!);
    expect(prior?.revoked_at).toBeDefined();
    expect(prior?.revocation_reason).toBe('webhook_declarations_removed');
  });
});

// ── fail-closed windows ───────────────────────────────────────────────────

describe('D-209 #1 W2b — every intermediate state fails closed', () => {
  it('a failed cross-store save restores the PRIOR stamps and mints nothing', async () => {
    const harness = await makeHarness();
    const recipe = webhookRecipe('door-rollback');
    const first = saveRecipeInline(harness.saveDeps, recipe, undefined, bindings(harness));
    const priorId = first.webhook!.door!.contract_id!;

    harness.failNextSave();
    expect(() =>
      saveRecipeInline(harness.saveDeps, recipe, undefined, bindings(harness)),
    ).toThrow(/injected recipe-store save failure/);

    // The restored rows carry their original stamp — the door survives the
    // rollback intact (the snapshot round-trips `contract_id`).
    expect(doorIdFor(harness, 'door-rollback')).toBe(priorId);
    expect(harness.definitionStore.get(priorId)?.revoked_at ?? null).toBeNull();
    // And the failed attempt minted NO orphan (the mint runs strictly after
    // the save succeeds).
    expect(harness.definitionStore.list()).toHaveLength(1);
  });

  it('a dynamically-dispatching recipe SAVES but is REFUSED a door — rows stay unstamped', async () => {
    const harness = await makeHarness();
    const saved = saveRecipeInline(
      harness.saveDeps,
      dynamicDispatchRecipe('door-refused'),
      undefined,
      bindings(harness),
    );

    // Drafts save; the DOOR is what refuses (§5.1a).
    expect(saved.saved).toBe(true);
    expect(saved.webhook?.door?.state).toBe('refused');
    expect(saved.webhook?.door?.refusal?.reason).toBe('dynamic_dispatch');
    expect(doorIdFor(harness, 'door-refused')).toBeNull();
    expect(harness.definitionStore.list()).toHaveLength(0);
  });

  it('arm REFUSES while the door is missing, and names the remedy', async () => {
    const harness = await makeHarness();
    saveRecipeInline(
      harness.saveDeps,
      webhookRecipe('door-arm-gate'),
      undefined,
      bindings(harness),
    );
    // Simulate the crash window between save-success and stamp.
    harness.db.prepare(
      'UPDATE webhook_recipe_triggers SET contract_id = NULL',
    ).run();

    expect(() =>
      handleLocalRecipeWebhookArm(harness.saveDeps, { recipe_id: 'door-arm-gate' }),
    ).toThrow(/door contract missing — re-save/);

    // The status surface says the same thing (the owner's discovery path).
    const status = handleLocalRecipeWebhookStatus(
      harness.saveDeps,
      { recipe_id: 'door-arm-gate' },
    );
    expect(status.webhook.door?.state).toBe('missing');
  });

  it('arm succeeds on a minted door and the response carries the consent list', async () => {
    const harness = await makeHarness();
    const saved = saveRecipeInline(
      harness.saveDeps,
      webhookRecipe('door-arm-ok'),
      undefined,
      bindings(harness),
    );
    const armed = handleLocalRecipeWebhookArm(
      harness.saveDeps,
      { recipe_id: 'door-arm-ok' },
    );
    expect(armed.webhook.armed).toBe(true);
    expect(armed.webhook.door).toMatchObject({
      state: 'minted',
      contract_id: saved.webhook?.door?.contract_id,
      operation_ids: ['core.ai.classify'],
    });
  });
});

// ── pack install / uninstall ──────────────────────────────────────────────

describe('D-209 #1 W2b — pack install mints per-recipe doors; uninstall retires them', () => {
  const PACK_SLUG = 'door-webhook-pack';
  const PUBLISHER = 'fixture-publisher';

  // Transform-only: the pack-install engine rejects unresolved canonical
  // op-steps (they lower to a concrete pack binding BEFORE install), so the
  // pack fixture exercises the EMPTY-closure door — the case where
  // `door_types` is load-bearing (an empty op closure on a wildcard contract
  // would admit ANY op; on a webhook door it denies everything).
  const packRecipe = (recipeId: string): RecipeDefinition => ({
    recipe_id: recipeId,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipeId,
      description: 'D-209 W2b pack fixture',
      author: PUBLISHER,
      supported_platforms: [],
      tags: [],
      recipe_bundle: `${PUBLISHER}/${PACK_SLUG}`,
    },
    variables: {},
    prefetch_steps: [],
    steps: [{ id: 'seen', transform: 'compare', left: 'x', operator: 'is_not_empty' }],
    output: { sidebar: [] },
    webhook_triggers: [{ binding: 'generic_delivery', event_types: ['delivery'] }],
  } as unknown as RecipeDefinition);

  const install = async (harness: Harness, recipeId: string) =>
    installBulkPackOnServer(
      {
        manifest_version: BULK_INSTALL_PACK_VERSION,
        pack_slug: PACK_SLUG,
        publisher: PUBLISHER,
        requires: [BULK_PACK_INSTALL_PERMISSION],
        recipes: [{
          slug: recipeId,
          pinned_version: 1,
          recipe: {
            recipe_id: recipeId,
            publisher_id: PUBLISHER,
            version: 1,
            recipe_hash: 'fixture-hash',
            recipe: packRecipe(recipeId),
          },
        }],
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
        webhook_bindings: bindings(harness),
      },
      new Set([BULK_PACK_INSTALL_PERMISSION]),
      {
        recipeStore: harness.recipeStore,
        webhookConsumerStore: harness.consumerStore,
        webhookDoor: harness.doorDeps,
        publisherDefault: PUBLISHER,
      },
    );

  it('install mints + stamps the recipe door and defaults ARMED (install consent = the gesture)', async () => {
    const harness = await makeHarness();
    const result = await install(harness, 'pack-webhook-recipe');
    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);

    const doorId = harness.consumerStore.doorContractIdForRecipe(
      'pack_install',
      PACK_SLUG,
      'pack-webhook-recipe',
      PUBLISHER,
    );
    expect(doorId).not.toBeNull();
    const stored = harness.definitionStore.get(doorId!);
    expect(stored?.door_types).toEqual(['webhook']);
    expect(stored?.max_risk_without_approval).toBe('admin');
    // An EMPTY op closure: nothing was granted, and `door_types` is what
    // keeps the empty scope from reading as a wildcard.
    expect(stored?.scope.operation_ids).toEqual([]);
    expect(harness.grantEntryStore.get(doorId!, 'core.ai.classify')).toBeUndefined();
    expect(
      harness.consumerStore.isConsumerEnabled('pack_install', PACK_SLUG),
    ).toBe(true);
  });

  it('a RE-install with the same capability re-uses the door; uninstall retires it', async () => {
    const harness = await makeHarness();
    await install(harness, 'pack-webhook-recipe');
    const firstId = harness.consumerStore.doorContractIdForRecipe(
      'pack_install',
      PACK_SLUG,
      'pack-webhook-recipe',
      PUBLISHER,
    );
    await install(harness, 'pack-webhook-recipe');
    const secondId = harness.consumerStore.doorContractIdForRecipe(
      'pack_install',
      PACK_SLUG,
      'pack-webhook-recipe',
      PUBLISHER,
    );
    expect(secondId).toBe(firstId);
    expect(harness.definitionStore.get(firstId!)?.revoked_at ?? null).toBeNull();

    const { result } = await handlePacksUninstall(
      {
        recipeStore: harness.recipeStore,
        webhookConsumerStore: harness.consumerStore,
        webhookDoorDefinitionStore: harness.definitionStore,
        packDir: '/path/that/does/not/exist',
      },
      { pack_slug: PACK_SLUG },
    );
    expect(result.ok).toBe(true);
    const retired = harness.definitionStore.get(firstId!);
    expect(retired?.revoked_at).toBeDefined();
    expect(retired?.revocation_reason).toBe('pack_uninstalled');
  });
});

// ── storage migration ─────────────────────────────────────────────────────

describe('D-209 #1 W2b — the trigger-table door column migrates in place', () => {
  it('adds contract_id to a pre-existing webhook_recipe_triggers table', () => {
    const db = new Database(':memory:');
    databases.push(db);
    // The pre-W2b table shape (no contract_id).
    db.exec(`
      CREATE TABLE webhook_recipe_triggers (
        trigger_id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        publisher_id TEXT NOT NULL,
        provider_event_type TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (binding_id, recipe_id, publisher_id, provider_event_type)
      );
    `);
    db.prepare(`
      INSERT INTO webhook_recipe_triggers (
        trigger_id, binding_id, recipe_id, publisher_id,
        provider_event_type, enabled, created_at, updated_at
      ) VALUES ('wht_legacy', 'whb_legacy', 'legacy-recipe', 'kitchen',
        'delivery', 1, 1, 1)
    `).run();

    createWebhookConsumerStore(db, {
      ingressStore: { get: () => null },
    });

    const columns = db.prepare('PRAGMA table_info(webhook_recipe_triggers)')
      .all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'contract_id')).toBe(true);
    // Legacy rows read as NULL — no door was ever minted for them, so the
    // dispatch floor (deny) is exactly the right answer until a re-save.
    const row = db.prepare(
      'SELECT contract_id FROM webhook_recipe_triggers WHERE trigger_id = ?',
    ).get('wht_legacy') as { contract_id: string | null };
    expect(row.contract_id).toBeNull();
  });
});
