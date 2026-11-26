/** A reception door over a FIRST-PARTY catalog op (2026-10-10).
 *
 *  A first-party composition declares its ops in the SLASH form
 *  (`recued-core/home-assistant.state.read`, `decomposer.ts`), and that is the id the
 *  op-admission gate checks. The door's grants are now spelled that way — so the
 *  responding-door fence must classify that spelling too: an op it cannot classify is
 *  refused, and the resolver used to read only `<pack_ref>.<op>`. Driven with
 *  production's resolvers over the real contract store, the bind, and the real gate.
 *
 *  ⚠ And the two resolvers that DON'T move with it are pinned: the risk resolver still
 *  reads a recipe's authored `<pack_ref>.<op>` (a Kitchen save keeps those ids on its
 *  door beside the declared ones), and the op-kinds map stays keyed by it, because its
 *  one reader — the cost analyzer — looks up a step's own authored `op`. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionSource, IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { decomposeComposition } from '@recued/ingredient-authoring';

import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { bindReceptionDoor, type ReceptionDoorContractLink } from '../reception-door-bind.js';
import { analyzeReceptionRecipeCost } from '../reception-recipe-cost-policy.js';
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
const CATALOG: IngredientManifest = decomposeComposition[COMPOSITION.schema_version ?? 1]!(
  COMPOSITION as never,
).catalog!;
const READ = CATALOG.operations!['state.read']!.operation_id;

// A public form that shows the visitor a light's state: one first-party read, and a
// rendered response — so the bind's responding-door fence classifies every op.
const SHOW_STATE = {
  recipe_id: 'show-light-state',
  version: 1,
  metadata: { name: 'Show a light', description: 'Show a light', author: 'recued-core' },
  steps: [
    { id: 'state', ingredient: 'home-assistant', input: { operation: 'state.read', args: { entity_id: 'light.kitchen' } } },
  ],
  output: { render: [{ type: 'summary', source: 'step.state' }] },
} as unknown as RecipeDefinition;

const dbs: Database.Database[] = [];
afterEach(() => { while (dbs.length > 0) dbs.pop()!.close(); });

describe('a responding reception door over a first-party catalog read', () => {
  it('binds, granting the op in the spelling the gate checks', () => {
    expect(READ).toBe('recued-core/home-assistant.state.read');
    const db = new Database(':memory:');
    dbs.push(db);
    let stamp = 1_760_000_000_000;
    const contractStore = createContractStore(db, { now: () => ++stamp });
    const definitionStore = createContractDefinitionStore(contractStore);
    const grantEntryStore = createContractGrantEntryStore(contractStore);
    contractStore.put('installed_pack', ['home-assistant'], {
      pack_slug: 'home-assistant', publisher: 'recued-core', version: '1',
      installed_at: stamp, ingredient_ids: ['home-assistant'],
    });
    const manifests = createManifestRegistry();
    manifests.register(CATALOG);
    const executeDeps = {
      contractScan: createContractScanFn(contractStore),
      executorConfig: { manifests },
    } as unknown as ExecuteHandlerDeps;
    let contractId: string | null = null;
    const pairStore: ReceptionDoorContractLink = {
      findByEndpoint: () => ({ contract_id: contractId }),
      setContractId: ({ contract_id }) => { contractId = contract_id; },
    };

    const result = bindReceptionDoor({
      endpointId: 'ep-light',
      recipeId: SHOW_STATE.recipe_id,
      recipe: SHOW_STATE,
      mintedBy: 'owner',
      confirmed: true,
    }, {
      pairStore,
      definitionStore,
      grantEntryStore,
      now: () => ++stamp,
      resolveConfig: () => ({}),
      resolveOp: composeRecipeOpResolver(executeDeps)!,
      resolveOpRisk: composeRecipeOpRiskResolver(executeDeps)!,
      resolveIngredientKind: composeRecipeIngredientKindResolver(executeDeps),
      resolveOpKinds: composeRecipeOpKindsResolver(executeDeps)!,
    });

    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'bound' });
    expect(contractId).not.toBeNull();
    expect(definitionStore.get(contractId!)?.scope.operation_ids).toEqual([READ]);
    const gate = createOpAdmissionGate({ grantEntryStore, definitionStore });
    const visitor = {
      channel: 'reception', actor: 'anonymous', reception_id: 'ep-light', contract_id: contractId!,
    } as ExecutionSource;
    expect(gate.isOpGranted(visitor, READ)).toBe(true);
  });
});

describe('the resolvers a door bind reads, over a first-party catalog', () => {
  const resolvers = () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const contractStore = createContractStore(db, { now: () => 1_760_000_000_000 });
    contractStore.put('installed_pack', ['home-assistant'], {
      pack_slug: 'home-assistant', publisher: 'recued-core', version: '1',
      installed_at: 1_760_000_000_000, ingredient_ids: ['home-assistant'],
    });
    const manifests = createManifestRegistry();
    manifests.register(CATALOG);
    const executeDeps = {
      contractScan: createContractScanFn(contractStore),
      executorConfig: { manifests },
    } as unknown as ExecuteHandlerDeps;
    return {
      opRisk: composeRecipeOpRiskResolver(executeDeps)!,
      opKinds: composeRecipeOpKindsResolver(executeDeps)!,
      ingredientKind: composeRecipeIngredientKindResolver(executeDeps),
    };
  };

  it('classifies both spellings a door can hold, and nothing else', () => {
    const { opRisk } = resolvers();
    expect(opRisk(READ)).toBe('read');
    expect(opRisk('recued-core.home-assistant.state.read')).toBe('read');
    expect(opRisk(CATALOG.operations!['lock.unlock']!.operation_id)).toBe('admin');
    expect(opRisk('recued-core/home-assistant.no.such.op')).toBeUndefined();
  });

  it('prices an authored Tier-P step by its own op id', () => {
    const { opKinds, ingredientKind } = resolvers();
    const authored = {
      ...SHOW_STATE,
      steps: [{ id: 'state', op: 'recued-core.home-assistant.state.read', args: { entity_id: 'light.kitchen' } }],
    } as unknown as RecipeDefinition;
    expect(analyzeReceptionRecipeCost(authored, { resolveOpKinds: opKinds, resolveIngredientKind: ingredientKind }))
      .toMatchObject({ ok: true });
  });
});
