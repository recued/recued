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
 *  Spec: D-209 §1.4; D-207 §5.1b / §5.1d. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
} from '@recued/contracts';

import {
  handleLocalRecipeWebhookArm,
  handleLocalRecipeWebhookDisarm,
  handleLocalRecipeWebhookPreview,
  handleLocalRecipeWebhookStatus,
  saveRecipeInline,
  type RecipeSaveHandlerDeps,
} from '../recipe-save-handler.js';
import { installBulkPackOnServer } from '../install-bulk-pack-handler.js';
import { handlePacksUninstall } from '../pack-uninstall-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import {
  createContractScanFn,
  createContractStore,
} from '../storage/contract-store.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createDishStore } from '../dish-store.js';
import { composeDoorRecipeResolver, composeRecipeOpResolver } from '../recipe-capability-wiring.js';
import { assertRecordsNonOwnerRecipeExposure } from '../records/non-owner-exposure.js';
import { createRecordsStore } from '../records/store.js';
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
  type FinalizeConsumerReplacementOptions,
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
  ingressStore: ReturnType<typeof createWebhookIngressStore>;
  recipeStore: RecipeStore;
  consumerStore: WebhookConsumerStore;
  definitionStore: ContractDefinitionStore;
  grantEntryStore: ContractGrantEntryStore;
  doorDeps: WebhookDoorEnrollDeps;
  saveDeps: RecipeSaveHandlerDeps;
  ingressId: string;
  /** Trip the next `RecipeStore.save` to throw (the cross-store failure). */
  failNextSave(): void;
  /** D-201 Slice 10M — the main dish's settings the door is derived with. */
  setConfig(config: Record<string, unknown> | undefined): void;
}

const makeHarness = async (options: { production?: boolean } = {}): Promise<Harness> => {
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

  let config: Record<string, unknown> | undefined;
  // D-201 Slice 10S (10Q finding 14) — the keep-on question derived as
  // production derives a door (`compose-listeners.ts`): its recipe and op
  // resolvers over the execute substrate, and the records exposure check over
  // the records store. Before, only the settings were wired, so the preview and
  // the mint agreed on a derivation production does not make. The mint's own
  // mechanics (reuse, replace, retire) keep the bare wiring, whose fixture
  // operations no installed pack provides.
  const executeSubstrate = {
    contractScan: createContractScanFn(contractStore),
    executorConfig: { manifests: createManifestRegistry('/nonexistent-d209-door') },
    dishStore: createDishStore(db),
  } as unknown as ExecuteHandlerDeps;
  const recordsStore = createRecordsStore(db);
  const resolveOp = composeRecipeOpResolver(executeSubstrate);
  const doorDeps: WebhookDoorEnrollDeps = {
    definitionStore,
    grantEntryStore,
    consumerStore,
    now: () => ++stamp,
    resolveConfig: () => config,
    ...(options.production === true
      ? {
          resolveDoorRecipe: composeDoorRecipeResolver(executeSubstrate),
          preflightNonOwnerRecipeExposure: (recipe: RecipeDefinition) =>
            assertRecordsNonOwnerRecipeExposure(recipe, 'webhook', {
              isOperationId: (operationId) => recordsStore.isInstalledOperationId(operationId),
              isCatalogOperation: (catalogSlug, operationKey) =>
                recordsStore.isInstalledCatalogOperation(catalogSlug, operationKey),
            }),
          ...(resolveOp !== undefined ? { resolveOp } : {}),
        }
      : {}),
  };
  const saveDeps: RecipeSaveHandlerDeps = {
    store: recipeStore,
    webhookConsumerStore: consumerStore,
    webhookDoor: doorDeps,
  };

  return {
    db,
    ingressStore,
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
    setConfig: (next) => {
      config = next;
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
  it('D-201 Slice 10U — a save makes its door before its finalize, so a death between leaves the start a record', async () => {
    const harness = await makeHarness();
    saveRecipeInline(harness.saveDeps, webhookRecipe('door-order'), undefined, bindings(harness));
    const stamp = harness.consumerStore.stampTriggerContracts.bind(harness.consumerStore);
    const seen: number[] = [];
    harness.consumerStore.stampTriggerContracts = (input) => {
      seen.push(harness.consumerStore.pendingReplacements().length);
      return stamp(input);
    };
    saveRecipeInline(harness.saveDeps, webhookRecipe('door-order'), undefined, bindings(harness));
    // 10P finalized first: the record was gone while the door was made.
    expect(seen).toEqual([1]);
    expect(harness.consumerStore.pendingReplacements()).toEqual([]);
  });

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
  it('a dispatch-unresolvable recipe saves but never receives a webhook door', async () => {
    const harness = await makeHarness();
    Object.assign(harness.doorDeps, {
      resolveDoorRecipe: () => ({
        ok: false as const,
        reason: 'configured connection has no bound catalog',
      }),
    });
    const saved = saveRecipeInline(
      harness.saveDeps,
      webhookRecipe('door-dispatch-unresolvable'),
      undefined,
      bindings(harness),
    );

    expect(saved.saved).toBe(true);
    expect(saved.webhook?.door).toMatchObject({
      state: 'refused',
      refusal: { reason: 'dispatch_unresolvable', step_id: '<recipe>' },
    });
    expect(doorIdFor(harness, 'door-dispatch-unresolvable')).toBeNull();
    expect(harness.definitionStore.list()).toHaveLength(0);
  });

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

  // D-201 Slice 10X — switching it on is the owner's control (the owner's
  // ruling of 2026-11-19): it makes a door that is missing. Before 10X it
  // refused, naming a re-save.
  it('arm makes a door that is missing, and refuses only one it cannot make, saying why', async () => {
    const harness = await makeHarness();
    saveRecipeInline(
      harness.saveDeps,
      webhookRecipe('door-arm-gate'),
      undefined,
      bindings(harness),
    );
    // Simulate the crash window between save-success and stamp. D-201 Slice
    // 10AF — the stamp keeps the recipe's last door with the rows, so a crash
    // before it leaves no record of the door either.
    harness.db.prepare(
      'UPDATE webhook_recipe_triggers SET contract_id = NULL',
    ).run();
    harness.db.prepare('DELETE FROM webhook_recipe_last_doors').run();
    // The status surface says so (the owner's discovery path).
    expect(handleLocalRecipeWebhookStatus(harness.saveDeps, { recipe_id: 'door-arm-gate' })
      .webhook.door?.state).toBe('missing');

    // One that cannot be made: refused, and the webhook stays off.
    const definitionStore = new Proxy(harness.doorDeps.definitionStore, {
      get(target, property, receiver) {
        if (property === 'mint') {
          return () => { throw new Error('the contract store is unavailable'); };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const failing = {
      ...harness.saveDeps,
      webhookDoor: { ...harness.doorDeps, definitionStore },
    } as typeof harness.saveDeps;
    expect(() => handleLocalRecipeWebhookArm(failing, { recipe_id: 'door-arm-gate' }))
      .toThrow(/its webhook door could not be made/);
    expect(harness.consumerStore.isConsumerEnabled('local_recipe', 'door-arm-gate')).toBe(false);

    // Made: switched on, with its door.
    const armed = handleLocalRecipeWebhookArm(harness.saveDeps, { recipe_id: 'door-arm-gate' });
    expect(armed.webhook).toMatchObject({ armed: true, door: { state: 'minted' } });
    expect(doorIdFor(harness, 'door-arm-gate')).toBe(armed.webhook.door?.contract_id);
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

// ── D-201 Slices 10I + 10M — the save's "keep its webhook on?" ──────────

/** Saved, then switched on the way the owner switches it on. */
const switchedOn = (harness: Harness, recipe: RecipeDefinition) => {
  saveRecipeInline(harness.saveDeps, recipe, undefined, bindings(harness));
  return handleLocalRecipeWebhookArm(harness.saveDeps, { recipe_id: recipe.recipe_id }).webhook;
};

/** The question as the owner sees it. */
const asked = (harness: Harness, recipe: RecipeDefinition) =>
  handleLocalRecipeWebhookPreview(harness.saveDeps, { recipe, webhook_bindings: bindings(harness) }).door;

/** The save that answers it: kept on, under what was shown. */
const keptOn = (harness: Harness, recipe: RecipeDefinition, consent: string | undefined) =>
  saveRecipeInline(harness.saveDeps, recipe, undefined, bindings(harness), true, consent);

const doorScope = (harness: Harness, contractId: string) => {
  const scope = harness.definitionStore.get(contractId)?.scope;
  return {
    operation_ids: [...(scope?.operation_ids ?? [])].sort(),
    ingredient_ids: [...(scope?.ingredient_ids ?? [])].sort(),
    connection_names: [...(scope?.connection_names ?? [])].sort(),
  };
};

describe('D-201 Slices 10I + 10M — a save that keeps the webhook on, asked first', () => {
  const summarize = { id: 'summarize', op: 'core.ai.summarize', args: {} };

  it('previews what a draft would let its webhook do, against the saved door, and changes nothing', async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-preview'));
    const before = doorIdFor(harness, 'door-preview');
    expect(asked(harness, webhookRecipe('door-preview', [summarize]))).toMatchObject({
      state: 'derivable',
      operation_ids: ['core.ai.classify', 'core.ai.summarize'],
      // As production derives it, the step's ingredient comes with its operation.
      added: ['core.ai.summarize', 'ingredient:core-ai-summarize'],
      removed: [],
      widened: [],
      kept_off: [],
      history: 'kept',
      armed: true,
      consent: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(doorIdFor(harness, 'door-preview')).toBe(before);
    expect(handleLocalRecipeWebhookStatus(harness.saveDeps, { recipe_id: 'door-preview' }).webhook)
      .toMatchObject({ armed: true, door: { operation_ids: ['core.ai.classify'] } });
  });

  it('a save the owner keeps on mints exactly the door it was shown, and stays on', async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-keep-on'));
    const draft = webhookRecipe('door-keep-on', [summarize]);
    const shown = asked(harness, draft)!;
    const saved = keptOn(harness, draft, shown.consent);
    expect(saved.webhook).toMatchObject({
      armed: true,
      door: { state: 'minted', added: shown.added, removed: [] },
    });
    expect(doorIdFor(harness, 'door-keep-on')).toBe(saved.webhook?.door?.contract_id);
    expect(doorScope(harness, saved.webhook!.door!.contract_id!)).toMatchObject({
      operation_ids: shown.operation_ids,
    });
  });

  it('shows a connection and a step the door gains, as the mint names them, and mints what it shows (10L finding 1)', async () => {
    const harness = await makeHarness({ production: true });
    harness.setConfig({ personal: 'acct-personal', work: 'acct-work' });
    const withSlots = (steps: Array<Record<string, unknown>>): RecipeDefinition => {
      const recipe = webhookRecipe('door-axes', steps) as unknown as Record<string, unknown>;
      recipe.variables = {
        personal: { type: 'connection', connection_kind: 'api', label: 'Personal account', default: '' },
        work: { type: 'connection', connection_kind: 'api', label: 'Work account', default: '' },
      };
      return recipe as unknown as RecipeDefinition;
    };
    switchedOn(harness, withSlots([
      { id: 'note', op: 'core.ai.summarize', args: {}, connection: '{{config.personal}}' },
    ]));
    const draft = withSlots([
      { id: 'note', op: 'core.ai.summarize', args: {}, connection: '{{config.work}}' },
      { id: 'fetch', ingredient: 'http-fetch', input: {} },
    ]);
    const shown = asked(harness, draft)!;
    // Operations unchanged: before 10M this read "nothing new".
    expect(shown.added).toEqual(expect.arrayContaining(['connection:acct-work', 'ingredient:http-fetch']));
    expect(shown.removed).toEqual(expect.arrayContaining(['connection:acct-personal']));
    const saved = keptOn(harness, draft, shown.consent);
    expect(saved.webhook).toMatchObject({ armed: true, door: { state: 'minted' } });
    const scope = doorScope(harness, saved.webhook!.door!.contract_id!);
    expect(scope.connection_names).toContain('acct-work');
    expect(scope.connection_names).not.toContain('acct-personal');
    expect(scope.ingredient_ids).toContain('http-fetch');
    expect(saved.webhook?.door?.added).toEqual(shown.added);
  });

  it("keeps what the owner switched off under Contracts off, and lists it (the owner's call)", async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-kept-off', [summarize]));
    const doorId = doorIdFor(harness, 'door-kept-off')!;
    harness.grantEntryStore.set(doorId, 'core.ai.summarize', false, Date.now());
    const draft = webhookRecipe('door-kept-off', [summarize, { id: 'extract', op: 'core.ai.extract', args: {} }]);
    const shown = asked(harness, draft)!;
    expect(shown).toMatchObject({
      added: ['core.ai.extract', 'ingredient:core-ai-extract'],
      kept_off: ['core.ai.summarize'],
    });
    const saved = keptOn(harness, draft, shown.consent);
    const next = saved.webhook!.door!.contract_id!;
    expect(next).not.toBe(doorId);
    // Before 10M a Kitchen re-save started the door clean: summarize came back on.
    expect(harness.grantEntryStore.listForContract(next)
      .find((row) => row.entry_key === 'core.ai.summarize')?.granted).toBe(false);
  });

  // D-201 Slice 10X — the owner's ruling (2026-11-19): switching it on opens a
  // door they closed; what they switched off on it stays off.
  it('switching it on again opens a door its owner closed, and what they switched off under Contracts stays off', async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-reopened', [summarize, { id: 'extract', op: 'core.ai.extract', args: {} }]));
    const doorId = doorIdFor(harness, 'door-reopened')!;
    harness.grantEntryStore.set(doorId, 'core.ai.summarize', false, Date.now());
    harness.doorDeps.definitionStore.revoke(doorId, 'owner_revoked');
    handleLocalRecipeWebhookDisarm(harness.saveDeps, { recipe_id: 'door-reopened' });
    const on = handleLocalRecipeWebhookArm(harness.saveDeps, { recipe_id: 'door-reopened' });
    const next = on.webhook.door!.contract_id!;
    expect(on.webhook).toMatchObject({ armed: true, door: { state: 'minted', switched_off: ['core.ai.summarize'] } });
    expect(next).not.toBe(doorId);
    expect(harness.grantEntryStore.listForContract(next)
      .find((row) => row.entry_key === 'core.ai.summarize')?.granted).toBe(false);
    expect(harness.grantEntryStore.listForContract(next)
      .find((row) => row.entry_key === 'core.ai.extract')?.granted).not.toBe(false);
  });

  it('shows a slot that reads more of each message, and says its history closes', async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-widened'));
    const draft = webhookRecipe('door-widened') as unknown as {
      webhook_requirements: Array<Record<string, unknown>>;
    };
    draft.webhook_requirements[0]!.decoded_payload_access = 'scoped_read';
    expect(asked(harness, draft as unknown as RecipeDefinition)).toMatchObject({
      widened: ['generic_delivery:scoped_read'],
      history: 'closed',
    });
  });

  it('refuses a stale answer before anything changes: the draft, an operation switched off, the webhook switched off', async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-stale'));
    const doorId = doorIdFor(harness, 'door-stale');
    const draft = webhookRecipe('door-stale', [summarize]);
    const shown = asked(harness, draft)!;
    const unchanged = () => {
      expect(harness.recipeStore.get('door-stale')?.steps).toEqual(webhookRecipe('door-stale').steps);
      expect(doorIdFor(harness, 'door-stale')).toBe(doorId);
    };
    // The draft changed since: another version than the one shown.
    expect(() => keptOn(harness, webhookRecipe('door-stale', [summarize, { id: 'extract', op: 'core.ai.extract', args: {} }]), shown.consent))
      .toThrow(expect.objectContaining({ code: 'webhook_consent_stale' }));
    unchanged();
    // An answer with no question.
    expect(() => keptOn(harness, draft, undefined))
      .toThrow(expect.objectContaining({ code: 'webhook_consent_stale' }));
    unchanged();
    // An operation switched off under Contracts since.
    harness.grantEntryStore.set(doorId!, 'core.ai.classify', false, Date.now());
    expect(() => keptOn(harness, draft, shown.consent))
      .toThrow(expect.objectContaining({ code: 'webhook_consent_stale' }));
    unchanged();
    harness.grantEntryStore.set(doorId!, 'core.ai.classify', true, Date.now());
    // The webhook switched off since, in another tab: never switched back on.
    handleLocalRecipeWebhookDisarm(harness.saveDeps, { recipe_id: 'door-stale' });
    expect(() => keptOn(harness, draft, shown.consent))
      .toThrow(expect.objectContaining({ code: 'webhook_consent_stale' }));
    expect(harness.consumerStore.isConsumerEnabled('local_recipe', 'door-stale')).toBe(false);
    unchanged();
  });

  it('a door the owner revoked under Contracts cannot be kept on: refused up front, and it stays revoked', async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-revoked'));
    const doorId = doorIdFor(harness, 'door-revoked')!;
    const draft = webhookRecipe('door-revoked', [summarize]);
    // Asked while the door was on; the owner revokes it before answering.
    const before = asked(harness, draft);
    expect(before).toMatchObject({ state: 'derivable' });
    harness.definitionStore.revoke(doorId, 'Revoked from Settings');
    // D-201 Slice 10X (10V finding 12) — with a remedy the owner can take: the
    // Contracts route has no switch for a webhook's door. D-201 Slice 10AF
    // (10AE finding 14) — the remedy Kitchen gives since 10AC, which keeps what
    // waits: switching it off and on again lost it.
    expect(asked(harness, draft)).toMatchObject({
      state: 'refused',
      refusal: {
        reason: 'door_revoked',
        detail: 'its door is closed, so a save cannot keep it on. Open its door first, on its webhook in Settings → Connections → Webhooks or with its switch here, then save again: what is waiting for it is kept',
      },
    });
    // D-201 Slice 10S (10Q finding 11) — the answer is stale, so Kitchen asks
    // again and shows why; keep-on asked without any answer was never askable.
    expect(() => keptOn(harness, draft, before?.consent))
      .toThrow(expect.objectContaining({ code: 'webhook_consent_stale' }));
    expect(() => keptOn(harness, draft, undefined))
      .toThrow(expect.objectContaining({ code: 'webhook_not_ready' }));
    expect(harness.recipeStore.get('door-revoked')?.steps).toEqual(webhookRecipe('door-revoked').steps);
    expect(harness.definitionStore.get(doorId)).toMatchObject({ revocation_reason: 'Revoked from Settings' });
  });

  it('refuses to keep on a version that cannot have a door, before anything changes', async () => {
    const harness = await makeHarness({ production: true });
    const first = switchedOn(harness, webhookRecipe('door-keep-refused'));
    expect(asked(harness, dynamicDispatchRecipe('door-keep-refused')))
      .toMatchObject({ state: 'refused', refusal: { reason: 'dynamic_dispatch' } });
    // A refused question offers no keep-on: asked without an answer, it is not ready.
    expect(() => keptOn(harness, dynamicDispatchRecipe('door-keep-refused'), undefined))
      .toThrow(expect.objectContaining({ code: 'webhook_not_ready' }));
    expect(harness.recipeStore.get('door-keep-refused')?.steps).toEqual(webhookRecipe('door-keep-refused').steps);
    expect(harness.consumerStore.isConsumerEnabled('local_recipe', 'door-keep-refused')).toBe(true);
    expect(doorIdFor(harness, 'door-keep-refused')).toBe(first.door?.contract_id);
  });

  // D-201 Slice 10X — 10I switched it off here, closing what it carried. The
  // owner's ruling (2026-11-19): the switch is the owner's, never Recued's.
  it("leaves it on, its door missing, when the mint fails after the save; switching it on again makes the door", async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-keep-fault'));
    const draft = webhookRecipe('door-keep-fault', [summarize]);
    const shown = asked(harness, draft)!;
    // The new door cannot be minted (the widened version needs a new one).
    const definitionStore = new Proxy(harness.doorDeps.definitionStore, {
      get(target, property, receiver) {
        if (property === 'mint') {
          return () => { throw new Error('the contract store is unavailable'); };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const failing = {
      ...harness.saveDeps,
      webhookDoor: { ...harness.doorDeps, definitionStore },
    } as typeof harness.saveDeps;
    const saved = saveRecipeInline(failing, draft, undefined, bindings(harness), true, shown.consent);
    expect(saved.webhook).toMatchObject({ armed: true, door: { state: 'missing' } });
    expect(harness.consumerStore.isConsumerEnabled('local_recipe', 'door-keep-fault')).toBe(true);
    // Kitchen's own switch, on again: the door is made now the store works.
    const on = handleLocalRecipeWebhookArm(harness.saveDeps, { recipe_id: 'door-keep-fault' });
    expect(on.webhook).toMatchObject({ armed: true, door: { state: 'minted' } });
    expect(on.webhook.door?.operation_ids).toContain('core.ai.summarize');
  });
});

// ── D-201 Slice 10S — the question as the save will act on it ─────────────

/** Another way in, as the first was made: a second ingress taking deliveries. */
const secondIngress = async (harness: Harness): Promise<string> => {
  const ingress = harness.ingressStore.create({
    display_name: 'A second way in',
    profile_id: 'generic.static-header-token.v1',
    environment: 'test',
    paired_connection_id: null,
    registration_mode: 'manual',
    selected_event_types: ['delivery'],
  });
  await harness.ingressStore.writeCredentialVersion(ingress.ingress_id, {
    header_name: 'x-fixture-token',
    header_token: 'fixture-token-2',
  });
  harness.db.prepare(`
    UPDATE webhook_ingresses SET
      intake_state = 'enabled', registration_state = 'registered', enabled_at = ?
    WHERE ingress_id = ?
  `).run(2_099_999_999_999, ingress.ingress_id);
  return ingress.ingress_id;
};

describe('D-201 Slice 10S — the keep-on question as the save will act on it', () => {
  const summarize = { id: 'summarize', op: 'core.ai.summarize', args: {} };
  const extract = { id: 'extract', op: 'core.ai.extract', args: {} };

  it('a save naming another publisher cannot keep the webhook on: the question was asked under its own (10Q finding 5)', async () => {
    const harness = await makeHarness({ production: true });
    saveRecipeInline(harness.saveDeps, webhookRecipe('door-publisher', [summarize]), 'acme', bindings(harness));
    handleLocalRecipeWebhookArm(harness.saveDeps, { recipe_id: 'door-publisher' });
    const doorId = harness.consumerStore.doorContractIdForRecipe('local_recipe', 'door-publisher', 'door-publisher', 'acme')!;
    harness.grantEntryStore.set(doorId, 'core.ai.summarize', false, Date.now());
    // Each call gets its own draft, as each RPC does: the save's gates
    // normalize the one they are given.
    const draft = () => webhookRecipe('door-publisher', [summarize, extract]);
    // D-201 Slice 10Y (10V finding 22) — asked as Kitchen asks (no publisher
    // named), it is the save under `kitchen` that answers: refused up front.
    expect(asked(harness, draft())).toMatchObject({
      state: 'refused',
      refusal: { reason: 'not_ready', detail: "it was saved under the publisher 'acme', and this save is under 'kitchen'" },
      armed: true,
    });
    const shown = handleLocalRecipeWebhookPreview(harness.saveDeps, {
      recipe: draft(),
      webhook_bindings: bindings(harness),
      publisher_id: 'acme',
    }).door!;
    expect(shown).toMatchObject({ state: 'derivable', kept_off: ['core.ai.summarize'] });
    // As Kitchen saves (no publisher named), under what the question under its own showed.
    expect(() => keptOn(harness, draft(), shown.consent))
      .toThrow(expect.objectContaining({ code: 'webhook_not_ready', message: expect.stringMatching(/publisher it was saved under \('acme'\)/) }));
    // Nothing changed: the door, its switch-off, the webhook on.
    expect(harness.consumerStore.doorContractIdForRecipe('local_recipe', 'door-publisher', 'door-publisher', 'acme')).toBe(doorId);
    expect(harness.consumerStore.isConsumerEnabled('local_recipe', 'door-publisher')).toBe(true);
    // Under its own publisher it keeps the switch-off, as the question said.
    const saved = saveRecipeInline(harness.saveDeps, draft(), 'acme', bindings(harness), true, shown.consent);
    expect(saved.webhook).toMatchObject({ armed: true, door: { state: 'minted' } });
    expect(harness.grantEntryStore.listForContract(saved.webhook!.door!.contract_id!)
      .find((row) => row.entry_key === 'core.ai.summarize')?.granted).toBe(false);
  });

  it('the answer covers the whole draft: drafts that differ only in a description get different answers (10Q finding 10)', async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-digest'));
    const draft = (description: string) => {
      const recipe = webhookRecipe('door-digest', [summarize]) as unknown as { metadata: { description: string } };
      recipe.metadata.description = description;
      return recipe as unknown as RecipeDefinition;
    };
    const first = asked(harness, draft('variant 162789'))!;
    const second = asked(harness, draft('variant 379192'))!;
    // The two descriptions 10Q found sharing a 32-bit draft hash.
    expect(first.consent).not.toBe(second.consent);
    expect(() => keptOn(harness, draft('variant 379192'), first.consent))
      .toThrow(expect.objectContaining({ code: 'webhook_consent_stale' }));
  });

  it('a draft with no webhook trigger is not offered keeping it on, as the save would refuse it (10Q finding 13)', async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-no-trigger'));
    const draft = webhookRecipe('door-no-trigger') as unknown as { webhook_triggers: unknown[] };
    draft.webhook_triggers = [];
    expect(asked(harness, draft as unknown as RecipeDefinition)).toEqual({
      state: 'refused',
      refusal: { reason: 'not_ready', step_id: '<recipe>', detail: 'this version has no webhook trigger' },
      armed: true,
    });
  });

  it('the history is in the answer: a way in moved by another tab since asks again (10Q finding 14)', async () => {
    const harness = await makeHarness({ production: true });
    // The version saved is the version asked about: the door cannot change.
    const version = () => webhookRecipe('door-history', [summarize]);
    switchedOn(harness, version());
    const other = await secondIngress(harness);
    const doorAsked = doorIdFor(harness, 'door-history');
    const tabA = asked(harness, version())!;
    expect(tabA).toMatchObject({ history: 'kept', added: [], removed: [], widened: [] });
    // Another tab saves the same version kept on, moved to the second way in.
    const moved = [{ binding: 'generic_delivery', ingress_id: other }];
    const tabB = handleLocalRecipeWebhookPreview(harness.saveDeps, { recipe: version(), webhook_bindings: moved }).door!;
    saveRecipeInline(harness.saveDeps, version(), undefined, moved, true, tabB.consent);
    // Same door, same operations, still on: only the history Tab A was told of
    // has changed, since its way in now carries the other tab's.
    expect(doorIdFor(harness, 'door-history')).toBe(doorAsked);
    expect(asked(harness, version())).toMatchObject({ history: 'closed', added: [], removed: [], widened: [] });
    expect(() => keptOn(harness, version(), tabA.consent))
      .toThrow(expect.objectContaining({ code: 'webhook_consent_stale' }));
    expect(doorIdFor(harness, 'door-history')).toBe(doorAsked);
  });

  it('a save that switches it off keeps an unchanged door, switch-offs and all, and switching on does not list them as let through (10Q finding 12)', async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-off-kept', [summarize]));
    const doorId = doorIdFor(harness, 'door-off-kept')!;
    harness.grantEntryStore.set(doorId, 'core.ai.summarize', false, Date.now());
    const off = saveRecipeInline(harness.saveDeps, webhookRecipe('door-off-kept', [summarize]), undefined, bindings(harness));
    expect(off.webhook).toMatchObject({ armed: false, door: { contract_id: doorId, switched_off: ['core.ai.summarize'] } });
    const on = handleLocalRecipeWebhookArm(harness.saveDeps, { recipe_id: 'door-off-kept' }).webhook;
    expect(on).toMatchObject({ armed: true, door: { contract_id: doorId, switched_off: ['core.ai.summarize'] } });
    expect(handleLocalRecipeWebhookStatus(harness.saveDeps, { recipe_id: 'door-off-kept' }).webhook.door)
      .toMatchObject({ switched_off: ['core.ai.summarize'] });
  });
});

describe('D-201 Slice 10Y — the keep-on question as the save acts (10V findings 6 and 20–22)', () => {
  const summarize = { id: 'summarize', op: 'core.ai.summarize', args: {} };
  const SECOND = 'second_delivery';
  /** The recipe on two slots of the one way in, taking a delivery on `taking`. */
  const twoWays = (recipeId: string, taking: string[]): RecipeDefinition => {
    const recipe = webhookRecipe(recipeId) as unknown as {
      webhook_requirements: Array<Record<string, unknown>>;
      webhook_triggers: unknown[];
    };
    recipe.webhook_requirements = [recipe.webhook_requirements[0]!, { ...recipe.webhook_requirements[0]!, binding: SECOND }];
    recipe.webhook_triggers = taking.map((binding) => ({ binding, event_types: ['delivery'] }));
    return recipe as unknown as RecipeDefinition;
  };
  const twoBindings = (harness: Harness) => [
    ...bindings(harness),
    { binding: SECOND, ingress_id: bindings(harness)[0]!.ingress_id },
  ];

  it("the answer covers each trigger's history: one kept that another tab has since closed asks again (finding 6)", async () => {
    const harness = await makeHarness({ production: true });
    saveRecipeInline(harness.saveDeps, twoWays('door-two-ways', ['generic_delivery', SECOND]), undefined, twoBindings(harness));
    handleLocalRecipeWebhookArm(harness.saveDeps, { recipe_id: 'door-two-ways' });
    const ask = (recipe: RecipeDefinition) =>
      handleLocalRecipeWebhookPreview(harness.saveDeps, { recipe, webhook_bindings: twoBindings(harness) }).door!;
    const tabA = ask(twoWays('door-two-ways', ['generic_delivery']));
    expect(tabA).toMatchObject({
      history: 'closed',
      history_triggers: [
        { slot: 'generic_delivery', event_type: 'delivery', history: 'kept' },
        { slot: SECOND, event_type: 'delivery', history: 'closed' },
      ],
    });
    // Another tab keeps it on, taking the second way only.
    const tabB = ask(twoWays('door-two-ways', [SECOND]));
    saveRecipeInline(harness.saveDeps, twoWays('door-two-ways', [SECOND]), undefined, twoBindings(harness), true, tabB.consent);
    // The same door and the same history overall: only which trigger keeps it.
    expect(ask(twoWays('door-two-ways', ['generic_delivery']))).toMatchObject({
      history: 'closed',
      added: tabA.added,
      removed: tabA.removed,
      widened: tabA.widened,
      history_triggers: [{ slot: SECOND, event_type: 'delivery', history: 'closed' }],
    });
    expect(() => saveRecipeInline(
      harness.saveDeps,
      twoWays('door-two-ways', ['generic_delivery']),
      undefined,
      twoBindings(harness),
      true,
      tabA.consent,
    )).toThrow(expect.objectContaining({ code: 'webhook_consent_stale' }));
  });

  it('a switch-off carried onto a door without that operation is not listed, and one taken back is listed off, never as added (finding 20)', async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-carried', [summarize]));
    harness.grantEntryStore.set(doorIdFor(harness, 'door-carried')!, 'core.ai.summarize', false, Date.now());
    // A version without summarize: the door it gets has no summarize, though
    // the switch-off is carried onto it, should a later version take it back.
    const without = webhookRecipe('door-carried');
    const asked1 = asked(harness, without)!;
    expect(asked1).toMatchObject({ kept_off: [], removed: ['core.ai.summarize', 'ingredient:core-ai-summarize'] });
    const saved1 = keptOn(harness, without, asked1.consent).webhook!;
    const door1 = saved1.door!.contract_id!;
    expect(harness.grantEntryStore.listForContract(door1)
      .find((row) => row.entry_key === 'core.ai.summarize')?.granted).toBe(false);
    expect(saved1.door).not.toHaveProperty('switched_off');
    expect(handleLocalRecipeWebhookStatus(harness.saveDeps, { recipe_id: 'door-carried' }).webhook.door)
      .not.toHaveProperty('switched_off');
    // Taken back: it stays off, so it is listed off and not as added.
    const back = webhookRecipe('door-carried', [summarize]);
    const asked2 = asked(harness, back)!;
    expect(asked2).toMatchObject({ kept_off: ['core.ai.summarize'] });
    const saved2 = keptOn(harness, back, asked2.consent).webhook!;
    expect(saved2.door).toMatchObject({ switched_off: ['core.ai.summarize'], added: ['ingredient:core-ai-summarize'] });
    expect(harness.grantEntryStore.listForContract(saved2.door!.contract_id!)
      .find((row) => row.entry_key === 'core.ai.summarize')?.granted).toBe(false);
  });

  it('a refused draft on a webhook switched off since says it is off (finding 21)', async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-refused-off'));
    expect(asked(harness, dynamicDispatchRecipe('door-refused-off'))).toMatchObject({ state: 'refused', armed: true });
    // Another tab switches it off.
    handleLocalRecipeWebhookDisarm(harness.saveDeps, { recipe_id: 'door-refused-off' });
    expect(asked(harness, dynamicDispatchRecipe('door-refused-off'))).toMatchObject({ state: 'refused', armed: false });
  });

  it('the question takes the publisher the save would name, and refuses one that is not a name (finding 22)', async () => {
    const harness = await makeHarness({ production: true });
    switchedOn(harness, webhookRecipe('door-named'));
    const named = (publisher_id: unknown) => handleLocalRecipeWebhookPreview(harness.saveDeps, {
      recipe: webhookRecipe('door-named', [summarize]),
      webhook_bindings: bindings(harness),
      publisher_id: publisher_id as string,
    }).door;
    expect(named('kitchen')).toMatchObject({ state: 'derivable', history: 'kept' });
    expect(named('acme')).toMatchObject({
      state: 'refused',
      refusal: { reason: 'not_ready', detail: "it was saved under the publisher 'kitchen', and this save is under 'acme'" },
    });
    for (const bad of ['', 7]) {
      expect(() => named(bad)).toThrow(expect.objectContaining({ code: 'bad_request' }));
    }
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

  it('D-201 Slice 10U — an update makes its doors before its finalize, so a death between leaves the start a record', async () => {
    const harness = await makeHarness();
    await install(harness, 'pack-order-recipe');
    const stamp = harness.consumerStore.stampTriggerContracts.bind(harness.consumerStore);
    const seen: number[] = [];
    harness.consumerStore.stampTriggerContracts = (input) => {
      seen.push(harness.consumerStore.pendingReplacements().length);
      return stamp(input);
    };
    await install(harness, 'pack-order-recipe');
    // 10P finalized first: the record was gone while the door was made.
    expect(seen).toEqual([1]);
    expect(harness.consumerStore.pendingReplacements()).toEqual([]);
  });

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

  // D-201 Slice 10S (10Q finding 4) — a recipe the update still ships was not
  // removed: the finalize is told which, so what it stops taking closes as
  // saved with a different setup (the store-level cases hold the reasons).
  // D-201 Slice 10Y (10V finding 17) — asked as the start asks it: whether the
  // recipe is still stored, under its trigger's publisher. "Still ships" gave
  // one it stops shipping but leaves installed a second reason.
  it('an update tells the finalize which recipes remain: still stored, under their publisher', async () => {
    const harness = await makeHarness();
    expect((await install(harness, 'pack-webhook-recipe')).ok).toBe(true);
    const told: Array<FinalizeConsumerReplacementOptions | undefined> = [];
    const finalize = harness.consumerStore.finalizeConsumerReplacement.bind(harness.consumerStore);
    harness.consumerStore.finalizeConsumerReplacement = (prior, options) => {
      told.push(options);
      finalize(prior, options);
    };
    expect((await install(harness, 'pack-webhook-recipe')).ok).toBe(true);
    expect(told).toHaveLength(1);
    expect(told[0]?.recipeRemains?.('pack-webhook-recipe', PUBLISHER)).toBe(true);
    expect(told[0]?.recipeRemains?.('pack-webhook-recipe', 'another-publisher')).toBe(false);
    expect(told[0]?.recipeRemains?.('a-recipe-it-dropped', PUBLISHER)).toBe(false);
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

  it('⛔ D-295 — a re-install keeps a door its OWNER revoked, revoked: an update never re-opens it', async () => {
    /** A revoked prior "must never be re-used as the live door", so a re-install
     *  minted a FRESH live door in its place — re-opening, on every pack update,
     *  a door the owner had shut. */
    const harness = await makeHarness();
    await install(harness, 'pack-webhook-recipe');
    const doorId = harness.consumerStore.doorContractIdForRecipe(
      'pack_install', PACK_SLUG, 'pack-webhook-recipe', PUBLISHER,
    )!;
    harness.definitionStore.revoke(doorId, 'Revoked from Settings');

    const result = await install(harness, 'pack-webhook-recipe');
    expect(result.ok).toBe(true);
    // Still the owner's revoked door on the rows — every delivery keeps being refused…
    expect(harness.consumerStore.doorContractIdForRecipe(
      'pack_install', PACK_SLUG, 'pack-webhook-recipe', PUBLISHER,
    )).toBe(doorId);
    expect(harness.definitionStore.get(doorId)).toMatchObject({ revocation_reason: 'Revoked from Settings' });
    // …and no live webhook door was minted in its place.
    const live = harness.definitionStore.list().filter((def) =>
      def.door_types?.includes('webhook') === true && (def.revoked_at === undefined || def.revoked_at === null));
    expect(live).toEqual([]);
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
