/** Reception doors minted before 2026-10-10, re-derived at boot
 *  (`rederiveReceptionDoorsAtBoot`) by D-299's rule for a machine re-bind.
 *
 *  A door's grants are now spelled as the op-admission gate reads them, and every
 *  reception runner re-derives its door and refuses one that differs. So a door the
 *  old releases minted differs from today's derivation in one of two ways:
 *    - it only LOSES ids the gate never read. A Records catalog is bound under two
 *      pack refs (`<publisher>.records-<hash>` and the authored one), and the old
 *      resolver granted both spellings; the gate reads only the declared one. Such a
 *      door worked, and would start refusing: it is re-minted, narrower, at boot;
 *    - it GAINS ids — here a kernel step's `core.*` op, which the old derivation never
 *      recorded. That is a widening the owner never saw listed, so it waits for their
 *      re-bind, and the boot writes nothing.
 *  A door its owner revoked stays revoked, and an entry they switched off stays off.
 *
 *  The catalog is stamped as `stampRecordsCatalog` stamps one (a `records-` slug,
 *  `<publisher>.<pack>.<key>` op ids) and installed under both of its pack refs, as
 *  `buildPackOpResolution` reads a Records pack's inventory row; the resolvers are
 *  production's (`recipe-capability-wiring.ts`) over the real contract store. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { decomposeComposition } from '@recued/ingredient-authoring';

import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { mintDoorContract, type MintDoorDeps } from '../mint-door-contract.js';
import { rederiveReceptionDoorsAtBoot, type ReceptionDoorContractLink } from '../reception-door-bind.js';
import {
  composeRecipeIngredientKindResolver,
  composeRecipeOpKindsResolver,
  composeRecipeOpResolver,
  composeRecipeOpRiskResolver,
} from '../recipe-capability-wiring.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractScanFn, createContractStore } from '../storage/contract-store.js';

const ROOT = join(__dirname, '..', '..', '..', '..');
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T;
const HA_PACK = readJson<{
  contents: ReadonlyArray<{ composition?: { schema_version?: number } }>;
}>('community/packs/home-assistant.json');
const COMPOSITION = HA_PACK.contents.find((c) => c.composition !== undefined)!.composition!;
const DECOMPOSED: IngredientManifest = decomposeComposition[COMPOSITION.schema_version ?? 1]!(
  COMPOSITION as never,
).catalog!;
const CATALOG_SLUG = 'records-0123456789abcdef0123456789abcdef';
// Stamped as a Records catalog is: an internal slug, and dotted ids under the AUTHORED pack.
const CATALOG: IngredientManifest = {
  ...DECOMPOSED,
  slug: CATALOG_SLUG,
  operations: Object.fromEntries(Object.entries(DECOMPOSED.operations ?? {}).map(([key, spec]) => [
    key,
    { ...spec, operation_id: `recued-core.queue-desk.${key}` },
  ])),
};
const READ = 'recued-core.queue-desk.state.read';

const recipe = (id: string, steps: unknown[]): RecipeDefinition => ({
  recipe_id: id,
  version: 1,
  metadata: { name: id, description: id, author: 'recued-core' },
  steps,
} as unknown as RecipeDefinition);
// A queue lookup: one Records read, nothing rendered.
const LOOKUP = recipe('check-queue', [
  { id: 'ticket', ingredient: CATALOG_SLUG, input: { operation: 'state.read', args: { entity_id: 'x' } } },
]);
// The same, then a mail: its kernel step lowered to the backing slug, as install stores it.
const LOOKUP_THEN_MAIL = recipe('check-queue-and-mail', [
  { id: 'ticket', ingredient: CATALOG_SLUG, input: { operation: 'state.read', args: { entity_id: 'x' } } },
  { id: 'notify', ingredient: 'mail-send', input: { to: 'owner@example.test', subject: 's', body: 'b' } },
]);

const dbs: Database.Database[] = [];
afterEach(() => { while (dbs.length > 0) dbs.pop()!.close(); });

const world = () => {
  const db = new Database(':memory:');
  dbs.push(db);
  let stamp = 1_760_000_000_000;
  const contractStore = createContractStore(db, { now: () => ++stamp });
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  // A Records pack's inventory row is keyed by its catalog id and names its authored slug.
  contractStore.put('installed_pack', [CATALOG_SLUG], {
    pack_slug: CATALOG_SLUG, authored_pack_slug: 'queue-desk', publisher: 'recued-core',
    version: '1', installed_at: stamp, ingredient_ids: [CATALOG_SLUG],
  });
  const manifests = createManifestRegistry();
  manifests.register(CATALOG);
  const executeDeps = {
    contractScan: createContractScanFn(contractStore),
    executorConfig: { manifests },
  } as unknown as ExecuteHandlerDeps;
  const mintDeps: MintDoorDeps = { definitionStore, grantEntryStore, now: () => ++stamp };
  const recipes = new Map([[LOOKUP.recipe_id, LOOKUP], [LOOKUP_THEN_MAIL.recipe_id, LOOKUP_THEN_MAIL]]);
  /** A pair store holding one endpoint's door, as `ReceptionDoorContractLink` reads it. */
  const link = (contractId: string): ReceptionDoorContractLink & { current: () => string | null } => {
    let current: string | null = contractId;
    return {
      current: () => current,
      findByEndpoint: () => ({ contract_id: current }),
      setContractId: ({ contract_id }) => { current = contract_id; },
    };
  };
  /** A door exactly as the old releases minted it: op ids from the old resolver
   *  (every pack ref binding the catalog), no op for a kernel step. */
  const legacyDoor = (recipeId: string, ingredients: string[]) => mintDoorContract({
    door: 'reception',
    recipeId,
    capability: {
      operation_ids: ['recued-core.queue-desk.state.read', `recued-core.${CATALOG_SLUG}.state.read`].sort(),
      ingredient_ids: ingredients,
      connection_names: [],
      pack_bound_connection_ops: [],
      operation_steps: {},
    },
    mintedBy: 'owner',
  }, mintDeps).contract_id;
  const boot = (doors: Array<{ endpointId: string; recipeId: string; link: ReceptionDoorContractLink }>) =>
    rederiveReceptionDoorsAtBoot(doors, {
      ...mintDeps,
      resolveConfig: () => ({}),
      resolveOp: composeRecipeOpResolver(executeDeps)!,
      resolveOpRisk: composeRecipeOpRiskResolver(executeDeps)!,
      resolveIngredientKind: composeRecipeIngredientKindResolver(executeDeps),
      resolveOpKinds: composeRecipeOpKindsResolver(executeDeps)!,
      recipeOf: (recipeId) => recipes.get(recipeId) ?? null,
    });
  return { definitionStore, grantEntryStore, link, legacyDoor, boot };
};

describe('reception doors minted before the fix, re-derived at boot', () => {
  it('re-mints a door that only loses an id the gate never read, keeping what the owner switched off', () => {
    const w = world();
    const old = w.legacyDoor(LOOKUP.recipe_id, [CATALOG_SLUG]);
    // On the door's Entities tab, the owner switched a collection read off.
    w.grantEntryStore.set(old, 'data.calendar', false, Date.now());
    const pair = w.link(old);

    expect(w.boot([{ endpointId: 'ep-queue', recipeId: LOOKUP.recipe_id, link: pair }])).toEqual([
      { endpoint_id: 'ep-queue', recipe_id: LOOKUP.recipe_id, outcome: 'rebound' },
    ]);
    const door = pair.current()!;
    expect(door).not.toBe(old);
    expect(w.definitionStore.get(old)?.revoked_at).toEqual(expect.any(Number));
    expect(w.definitionStore.get(door)?.scope.operation_ids).toEqual([READ]);
    expect(w.grantEntryStore.get(door, READ)).toBe(true);
    expect(w.grantEntryStore.get(door, 'data.calendar')).toBe(false);

    // Idempotent: current now, so a second boot writes nothing.
    expect(w.boot([{ endpointId: 'ep-queue', recipeId: LOOKUP.recipe_id, link: pair }])).toEqual([]);
    expect(pair.current()).toBe(door);
  });

  it('leaves a door that would GAIN an op for its owner, untouched', () => {
    const w = world();
    const old = w.legacyDoor(LOOKUP_THEN_MAIL.recipe_id, [CATALOG_SLUG, 'mail-send']);
    const pair = w.link(old);

    expect(w.boot([{ endpointId: 'ep-mail', recipeId: LOOKUP_THEN_MAIL.recipe_id, link: pair }])).toEqual([
      { endpoint_id: 'ep-mail', recipe_id: LOOKUP_THEN_MAIL.recipe_id, outcome: 'needs_owner' },
    ]);
    expect(pair.current()).toBe(old);
    expect(w.definitionStore.get(old)?.revoked_at ?? null).toBeNull();
    expect(w.grantEntryStore.get(old, 'core.mail.send')).toBeUndefined();
  });

  it('leaves a door its owner revoked revoked', () => {
    const w = world();
    const old = w.legacyDoor(LOOKUP.recipe_id, [CATALOG_SLUG]);
    w.definitionStore.revoke(old, 'owner_revoked');
    const pair = w.link(old);

    expect(w.boot([{ endpointId: 'ep-queue', recipeId: LOOKUP.recipe_id, link: pair }])).toEqual([]);
    expect(pair.current()).toBe(old);
  });
});
