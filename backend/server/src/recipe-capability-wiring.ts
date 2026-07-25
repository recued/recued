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

import type { OpResolver } from './derive-recipe-capability.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { buildPackOpResolution } from './pack-inventory.js';

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
    const opIds: string[] = [];
    for (const [packRef, binding] of resolution) {
      if (binding.catalog_slug === ingredientSlug && binding.operations.has(operation)) {
        opIds.push(`${packRef}.${operation}`);
      }
    }
    return opIds;
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
