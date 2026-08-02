/** D-207 slice 1c / D-209 #1 W2b — the ONE construction of the inputs
 *  `deriveRecipeCapability` needs at a composition root.
 *
 *  Both door families (reception pair-bind, webhook enrollment) derive a
 *  recipe's op/connection closure and mint a door from it. The derivation's
 *  two lookups — (catalog slug, operation) → canonical op ids, and
 *  recipe → resolved install config — MUST be the same functions everywhere
 *  they are consumed: two hand-rolled lambdas are two derivations that can
 *  drift, and a drifted closure mints a door whose consent list lies
 *  (`wire-reception-substrate.ts` states the same rule for bind-vs-run).
 *  This module exists so the reception wiring, the webhook save/install
 *  wiring, and any future door class construct them from one place.
 *
 *  The op resolution is rebuilt PER CALL, never cached at boot: installing a
 *  pack changes it, and a bind/save must see the inventory as it is at that
 *  moment. Bind and save are rare owner-interactive actions over a scan of
 *  tens of packs — the rebuild cost is noise; a stale map would mint a door
 *  whose grants name bindings that no longer exist. */

import type { RecipeDefinition } from '@recued/contracts';

import { resolveCanonicalRecipeForDispatch } from './dispatch-canonical-resolve.js';
import type { OpResolver } from './derive-recipe-capability.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { buildPackOpResolution } from './pack-inventory.js';

export type DoorRecipeResolution =
  | {
      readonly ok: true;
      readonly recipe: RecipeDefinition;
      /** Concrete ingredient → canonical pack op lookup from the SAME inventory snapshot
       *  that lowered `recipe`. Using it avoids one live pack scan per recipe step and
       *  prevents the closure from observing a different install set than lowering. */
      readonly resolveOp?: OpResolver;
    }
  | { readonly ok: false; readonly reason: string };

/** Resolve the exact concrete recipe form `handleExecute` will dispatch under one saved
 * install config. Doors derive authority from this form, not from an earlier authored
 * op-step representation whose implicit account binding is not visible yet. */
export type DoorRecipeResolver = (
  recipe: RecipeDefinition,
  config: Record<string, unknown>,
) => DoorRecipeResolution;

const resolverFromPackSnapshot = (
  resolution: ReturnType<typeof buildPackOpResolution>,
): OpResolver =>
  (ingredientSlug, operation) => {
    const opIds: string[] = [];
    for (const [packRef, binding] of resolution) {
      if (binding.catalog_slug === ingredientSlug && binding.operations.has(operation)) {
        opIds.push(`${packRef}.${operation}`);
      }
    }
    return opIds;
  };

export const composeDoorRecipeResolver = (
  executeDeps: Pick<
    ExecuteHandlerDeps,
    'connectionOperationProfiles' | 'contractScan' | 'executorConfig'
  >,
): DoorRecipeResolver =>
  (recipe, config) => {
    const packs = executeDeps.contractScan === undefined
      ? undefined
      : buildPackOpResolution(
          () => executeDeps.contractScan!('installed_pack', []),
          (slug) => executeDeps.executorConfig.manifests.get(slug) ?? null,
        );
    const resolved = resolveCanonicalRecipeForDispatch(recipe, {
      profiles: executeDeps.connectionOperationProfiles ?? { get: () => null },
      manifests: executeDeps.executorConfig.manifests,
      config,
      ...(packs === undefined ? {} : { packs }),
    });
    return resolved.ok
      ? {
          ok: true,
          recipe: resolved.recipe,
          ...(packs === undefined ? {} : { resolveOp: resolverFromPackSnapshot(packs) }),
        }
      : { ok: false, reason: resolved.reason };
  };

/** Map an ingredient step's (catalog slug, `input.operation`) back to the
 *  canonical op id(s) it dispatches — so a derived closure names GRANTS, not
 *  just slugs. `undefined` when the contract substrate is absent (dbless /
 *  partial harness): every ingredient step then contributes no op id, and the
 *  door under-derives, which the callers treat as refusal-or-absent. */
export const composeRecipeOpResolver = (
  executeDeps: Pick<ExecuteHandlerDeps, 'contractScan' | 'executorConfig'>,
): OpResolver | undefined => {
  const contractScan = executeDeps.contractScan;
  if (!contractScan) return undefined;
  return (ingredientSlug, operation) => {
    const manifests = executeDeps.executorConfig?.manifests;
    if (manifests === undefined) return [];
    const resolution = buildPackOpResolution(
      () => contractScan('installed_pack', []),
      (slug) => manifests.get(slug) ?? null,
    );
    return resolverFromPackSnapshot(resolution)(ingredientSlug, operation);
  };
};

/** An op id's RISK TIER across the installed pack catalogs (the caller falls
 *  back to the kernel registry itself). Returning `undefined` is NOT "safe" —
 *  the reception responding-door fence treats an unclassifiable op as a
 *  refusal, because it cannot prove the op will not hold. */
export const composeRecipeOpRiskResolver = (
  executeDeps: Pick<ExecuteHandlerDeps, 'contractScan' | 'executorConfig'>,
): ((opId: string) => string | undefined) | undefined => {
  const contractScan = executeDeps.contractScan;
  if (!contractScan) return undefined;
  return (opId) => {
    const manifests = executeDeps.executorConfig?.manifests;
    if (manifests === undefined) return undefined;
    const resolution = buildPackOpResolution(
      () => contractScan('installed_pack', []),
      (slug) => manifests.get(slug) ?? null,
    );
    for (const [packRef, binding] of resolution) {
      const prefix = `${packRef}.`;
      if (!opId.startsWith(prefix)) continue;
      const operation = opId.slice(prefix.length);
      if (!binding.operations.has(operation)) continue;
      const manifest = manifests.get(binding.catalog_slug);
      return manifest?.operations?.[operation]?.risk_tier;
    }
    return undefined;
  };
};

/** Resolve a concrete ingredient's installed execution kind for public-door cost policy. */
export const composeRecipeIngredientKindResolver = (
  executeDeps: Pick<ExecuteHandlerDeps, 'executorConfig'>,
): ((ingredientSlug: string) => string | undefined) =>
  (ingredientSlug) => executeDeps.executorConfig.manifests.get(ingredientSlug)?.kind;

/** Resolve a non-kernel canonical op's installed catalog kind. Kernel ops are classified
 *  directly from the closed registry by the cost analyzer. */
export const composeRecipeOpKindsResolver = (
  executeDeps: Pick<ExecuteHandlerDeps, 'contractScan' | 'executorConfig'>,
): (() => ReadonlyMap<string, string>) | undefined => {
  const contractScan = executeDeps.contractScan;
  if (!contractScan) return undefined;
  return () => {
    const manifests = executeDeps.executorConfig.manifests;
    const resolution = buildPackOpResolution(
      () => contractScan('installed_pack', []),
      (slug) => manifests.get(slug) ?? null,
    );
    const kinds = new Map<string, string>();
    for (const [packRef, binding] of resolution) {
      const kind = manifests.get(binding.catalog_slug)?.kind;
      if (kind === undefined) continue;
      for (const operation of binding.operations) {
        kinds.set(`${packRef}.${operation}`, kind);
      }
    }
    return kinds;
  };
};

/** D-179 — a recipe's INSTALL config lives on its `is_default` dish; deriving
 *  from `recipe.variables` instead would refuse most of the shipped library
 *  outright (the values live on the dish, not the paper record). The SAME
 *  function must feed the door derivation AND the runner's execute merge, or
 *  the owner consents to a closure the run will not use. */
export const composeInstallConfigResolver = (
  dishStore: Pick<NonNullable<ExecuteHandlerDeps['dishStore']>, 'listByRecipe'> | undefined,
): ((recipeId: string) => Record<string, unknown> | undefined) =>
  (recipeId) =>
    dishStore?.listByRecipe(recipeId).find((dish) => dish.is_default)?.config_overlay;
