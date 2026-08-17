/** D-240 slice 3b — binding the LOOKUP door.
 *
 *  A thin composition over `bindReceptionDoor`, not a second implementation of
 *  it. Everything that makes a reception door safe is generic over
 *  `(recipeId, recipe)` and already lives there:
 *
 *    - §5.1a  the door's one eligibility rule (static analyzability)
 *    - §3c    a door that OWES the visitor a synchronous response cannot WRITE
 *    - §5.5b  the cost profile + AI opt-in
 *    - §5.1f  the widening-consent diff — narrowing is silent, widening asks
 *    -        retire-then-mint, so no instant has two live contracts
 *
 *  ⛔⛔ §3c IS THE ONE THAT MATTERS MOST HERE AND IS THE ONE A BESPOKE BIND WOULD
 *  HAVE DROPPED. A viewback recipe runs on a GET that the visitor is waiting on,
 *  so it is a responding door by definition — and a responding door that writes
 *  either holds (returning no output, so the visitor gets a blank page) or fires
 *  a side effect for a stranger refreshing a status page. Reusing the bind means
 *  that rule applies without anyone remembering to apply it.
 *
 *  Spec: D-240 § D12. */

import {
  bindReceptionDoor,
  unbindReceptionDoor,
  type ReceptionDoorBindDeps,
  type ReceptionDoorBindResult,
} from './reception-door-bind.js';
import type { ReceptionLookupRecipePairStore } from './storage/reception-lookup-recipe-pair-store.js';

export interface ReceptionLookupDoorBindDeps
  extends Omit<ReceptionDoorBindDeps, 'pairStore'> {
  readonly lookupPairStore: ReceptionLookupRecipePairStore;
  /** The stored recipe, by id. `null` ⇒ nothing to bind. */
  readonly resolveRecipe: (recipeId: string) => import('@recued/contracts').RecipeDefinition | null;
  /** Content hash of the recipe being bound — what the owner is consenting to.
   *  Threaded rather than computed here so the bind and the runner hash the same
   *  way; a second hashing site is a second answer. */
  readonly hashRecipe: (recipe: import('@recued/contracts').RecipeDefinition) => string;
  readonly now: () => number;
}

export type ReceptionLookupDoorBindResult =
  | ReceptionDoorBindResult
  /** No such recipe. Distinct from a refusal: nothing about the recipe was
   *  judged, because there was nothing to judge. */
  | { readonly kind: 'recipe_not_found' };

/** Bind a read-only lookup recipe to an endpoint.
 *
 *  ⚠ THE ROW IS WRITTEN BEFORE THE DOOR IS MINTED, and the order is forced:
 *  `bindReceptionDoor` reads the EXISTING contract off the pair row to compute
 *  the consent diff, and links the new contract back onto it. A mint against a
 *  row that does not exist yet would have nowhere to land — the contract would
 *  be minted and orphaned, granting the public authority no door points at.
 *
 *  ⛔ Which is why a REFUSAL must not leave the row behind. A bound recipe with
 *  a null contract is not inert — it is a pair the runner would find, and the
 *  only thing stopping it is that an anonymous dispatch floors to
 *  `PUBLIC_CONTRACT_ID`. Relying on that as the refusal mechanism would make the
 *  fail-closed FLOOR do the work of an explicit rejection, which is exactly the
 *  D-207 slice 1b hazard ("a revoke that doesn't revoke"). So the row is rolled
 *  back on every non-bound outcome. */
export const bindReceptionLookupDoor = (
  input: {
    readonly endpointId: string;
    readonly recipeId: string;
    readonly mintedBy: string;
    readonly confirmed?: boolean;
  },
  deps: ReceptionLookupDoorBindDeps,
): ReceptionLookupDoorBindResult => {
  const recipe = deps.resolveRecipe(input.recipeId);
  if (recipe === null) return { kind: 'recipe_not_found' };

  const priorRow = deps.lookupPairStore.findByEndpoint(input.endpointId);

  deps.lookupPairStore.upsert({
    endpoint_id: input.endpointId,
    recipe_id: input.recipeId,
    recipe_hash: deps.hashRecipe(recipe),
    now: deps.now(),
  });

  const result = bindReceptionDoor(
    {
      endpointId: input.endpointId,
      recipeId: input.recipeId,
      recipe,
      mintedBy: input.mintedBy,
      ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed }),
    },
    { ...deps, pairStore: deps.lookupPairStore },
  );

  if (result.kind !== 'bound') {
    // Roll back to exactly what was there — restoring a prior binding rather
    // than deleting, so a REFUSED re-bind does not silently unbind the door that
    // was already working. ⚠ `needs_consent` takes this path too: the owner has
    // not agreed yet, so nothing about the door may have moved when they are
    // shown the diff.
    if (priorRow === null) {
      deps.lookupPairStore.clear(input.endpointId);
    } else {
      deps.lookupPairStore.upsert({
        endpoint_id: priorRow.endpoint_id,
        recipe_id: priorRow.recipe_id,
        recipe_hash: priorRow.recipe_hash,
        now: deps.now(),
      });
      deps.lookupPairStore.setContractId({
        endpoint_id: priorRow.endpoint_id,
        contract_id: priorRow.contract_id,
      });
    }
  }

  return result;
};

/** Unbind: revoke the door's contract, then drop the row.
 *
 *  ⚠ REVOKE FIRST, exactly as `unbindReceptionDoor` documents — the contract
 *  stops governing the moment it is revoked, so even if the row delete never
 *  lands the door is already shut. The reverse order leaves a window where no
 *  row points at a still-live contract, which is the harder state to notice. */
export const unbindReceptionLookupDoor = (
  endpointId: string,
  deps: Pick<ReceptionLookupDoorBindDeps, 'lookupPairStore' | 'definitionStore' | 'now'>,
): void => {
  unbindReceptionDoor(endpointId, {
    pairStore: deps.lookupPairStore,
    definitionStore: deps.definitionStore,
    now: deps.now,
  });
  deps.lookupPairStore.clear(endpointId);
};

/** The DISPATCH hop for the lookup door: `endpoint_id → lookup pair → contract_id`.
 *
 *  `null` is safe for the same reason it is on the intake side: the source then
 *  carries no `contract_id` and an anonymous dispatch floors to
 *  `PUBLIC_CONTRACT_ID`, which grants nothing — rather than to "contract-free",
 *  which would SKIP the access gate entirely. */
export const resolveReceptionLookupDoorContractId = (
  endpointId: string,
  deps: Pick<ReceptionLookupDoorBindDeps, 'lookupPairStore'>,
): string | null => deps.lookupPairStore.findByEndpoint(endpointId)?.contract_id ?? null;
