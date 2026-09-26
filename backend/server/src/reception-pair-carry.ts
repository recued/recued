/** ⛔ D-299 — A PACK UPDATE KEEPS A RECEPTION PAIR ALIVE, UNLESS WHAT IT RELIES ON CHANGED.
 *
 *  A form or scheduling pair pins the EXACT recipe it was bound to: its revision hashes the
 *  whole saved recipe, and every consumer re-derives it and refuses a mismatch. So any
 *  change to the recipe (a pack update that fixed one step) left the public form refusing
 *  every visitor until the owner re-bound it by hand. The lookup door beside it never did:
 *  its hash is a record, and it re-checks only AUTHORITY (D-240).
 *
 *  Owner, 2026-09-23: keep it alive as much as possible, since an update is most likely a
 *  bug fix; break it only when the recipe's parameters change, so the owner re-enables it,
 *  matching the new ones by hand if need be. So after an update, a pair that was current is
 *  re-pinned to the new recipe when:
 *  - its PARAMETERS are the same: the named answers the recipe reads off a submission
 *    (`requires_form_fields`: name, type, required; an author's note is not one), and the
 *    offer it sells;
 *  - its DOOR needs no new authority: the bind the owner's own re-bind would run,
 *    unconfirmed. Unchanged or narrower passes; a widening needs the owner and passes
 *    nothing.
 *
 *  Anything else is left as the update leaves it (stale, for the owner), and the update
 *  dialog names it first (`receptionPairsAtRisk`), reading the same derivation, the same
 *  parameter rule and the same door plan. */

import {
  paidDocumentDirectCheckoutSellerAssociation,
  receptionPairBindingEquals,
  type EndpointSummary,
  type RecipeDefinition,
} from '@recued/contracts';

import { bindReceptionDoor, planReceptionDoor, type ReceptionDoorBindDeps } from './reception-door-bind.js';
import { deriveEndpointPairBinding } from './reception-endpoint-pair.js';
import type {
  ReceptionIntakeRecipePairStore,
  ReceptionIntakeRecipePairSummary,
} from './storage/reception-intake-recipe-pair-store.js';

export interface ReceptionPairCarryDeps {
  readonly endpoints: { findById(endpoint_id: string): EndpointSummary | null | undefined };
  readonly pairs: Pick<ReceptionIntakeRecipePairStore, 'listByRecipeId' | 'compareAndSet'>;
  /** The substrate that binds a pair's door. Absent ⇒ no door can be checked, so no pair
   *  is carried: a pair re-pinned behind a door nobody checked could accept a visitor the
   *  gate then refuses. */
  readonly door?: ReceptionDoorBindDeps;
  readonly now: () => number;
}

/** Why a pair stops taking submissions after an update. */
export type ReceptionPairRisk = 'params_changed' | 'needs_owner';

/** One recipe an update changes: as installed now, and as it will be. */
export interface ReceptionPairRecipeChange {
  readonly recipe_id: string;
  readonly before: RecipeDefinition | null;
  readonly after: RecipeDefinition;
}

/** The recipe's side of its contract with the form. Declared-or-not is part of it: a recipe
 *  that starts declaring its fields gets its form checked at the owner's re-bind. */
const pairParams = (recipe: RecipeDefinition): string => {
  const declared = recipe.metadata?.requires_form_fields;
  return JSON.stringify({
    declared: declared !== undefined,
    fields: [...(declared ?? [])]
      .map((field) => [field.name, field.type, field.required] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    offer: paidDocumentDirectCheckoutSellerAssociation(recipe),
  });
};

export const receptionPairParamsChanged = (
  before: RecipeDefinition,
  after: RecipeDefinition,
): boolean => pairParams(before) !== pairParams(after);

/** The owner's standing-approval opt-in on the pair's current door, so a narrowing re-mint
 *  keeps it (it rides the door's execution policy). */
const doorStandingClosure = (
  pair: ReceptionIntakeRecipePairSummary,
  door: ReceptionDoorBindDeps,
): boolean => {
  if (pair.contract_id === null) return false;
  const policy = door.definitionStore.get(pair.contract_id)?.door_execution_policy as
    | { readonly standing_closure?: boolean }
    | undefined;
  return policy?.standing_closure === true;
};

interface AffectedPair {
  readonly pair: ReceptionIntakeRecipePairSummary;
  readonly endpoint: EndpointSummary;
  readonly recipe_id: string;
  readonly after: RecipeDefinition;
  readonly next: ReturnType<typeof deriveEndpointPairBinding>;
  readonly paramsChanged: boolean;
}

/** Every pair an update CHANGES: current against the recipe as installed, and not current
 *  against it as it will be. A pair already stale is the owner's to fix and is left alone;
 *  one the update leaves identical needs nothing. */
const affectedPairs = (
  changes: ReadonlyArray<ReceptionPairRecipeChange>,
  deps: ReceptionPairCarryDeps,
): AffectedPair[] => {
  const out: AffectedPair[] = [];
  for (const change of changes) {
    if (change.before === null) continue;
    for (const pair of deps.pairs.listByRecipeId(change.recipe_id)) {
      const endpoint = deps.endpoints.findById(pair.endpoint_id);
      if (!endpoint) continue;
      const was = deriveEndpointPairBinding(endpoint, change.before);
      if (was.kind !== 'ready' || !receptionPairBindingEquals(pair.binding, was.binding)) continue;
      const next = deriveEndpointPairBinding(endpoint, change.after);
      if (next.kind === 'ready' && receptionPairBindingEquals(pair.binding, next.binding)) continue;
      out.push({
        pair,
        endpoint,
        recipe_id: change.recipe_id,
        after: change.after,
        next,
        paramsChanged: receptionPairParamsChanged(change.before, change.after),
      });
    }
  }
  return out;
};

const endpointName = (endpoint: EndpointSummary): string => {
  const name = endpoint.metadata['display_name'];
  return typeof name === 'string' && name.trim() !== '' ? name : endpoint.endpoint_id;
};

/** Before an update: the pairs it would stop, and why. Reads the door PLAN, which writes
 *  nothing and decides as the post-install bind does. */
export const receptionPairsAtRisk = (
  changes: ReadonlyArray<ReceptionPairRecipeChange>,
  deps: ReceptionPairCarryDeps,
): Array<{ endpoint_id: string; name: string; recipe_id: string; reason: ReceptionPairRisk }> =>
  affectedPairs(changes, deps).flatMap(({ pair, endpoint, recipe_id, after, next, paramsChanged }) => {
    const at = (reason: ReceptionPairRisk) =>
      [{ endpoint_id: pair.endpoint_id, name: endpointName(endpoint), recipe_id, reason }];
    if (paramsChanged) return at('params_changed');
    if (next.kind !== 'ready' || deps.door === undefined) return at('needs_owner');
    const plan = planReceptionDoor(
      {
        endpointId: pair.endpoint_id,
        recipeId: recipe_id,
        recipe: after,
        standingClosure: doorStandingClosure(pair, deps.door),
      },
      deps.door,
    );
    return plan.kind === 'refused' || plan.diff.added.length > 0 ? at('needs_owner') : [];
  });

/** D-299 — the step every install path takes once its update has committed: carry each pair
 *  the recipes it wrote back, and log each one it leaves for the owner. A failure here leaves
 *  the changed pairs stale, as they were before D-299; it never fails the install, which has
 *  already committed.
 *
 *  ⛔ SHARED, BECAUSE A PATH WITHOUT IT WAS THE DEFECT. Only `installBulkPackOnServer` ran the
 *  carry, and a Records pack installs through `installRecordsPackAtomic` instead, so every
 *  shipped form recipe (`open-quote-request`, `issue-queue-numbers`, `open-job-from-intake`,
 *  all in Records packs) stopped taking submissions after any update (2026-09-24 audit).
 *  `recipesBefore` is each recipe as stored BEFORE the update; the new ones are read back
 *  from `recipeStore`. */
export const carryReceptionPairsAfterInstall = (
  recipesBefore: ReadonlyMap<string, RecipeDefinition | null>,
  recipeStore: { get(recipe_id: string): RecipeDefinition | null },
  deps: ReceptionPairCarryDeps,
  packSlug: string,
): void => {
  try {
    const outcomes = carryReceptionPairs(
      [...recipesBefore].flatMap(([recipe_id, before]) => {
        const after = recipeStore.get(recipe_id);
        return after === null ? [] : [{ recipe_id, before, after }];
      }),
      deps,
    );
    for (const outcome of outcomes) {
      if (outcome.outcome === 'carried') continue;
      console.info(
        `[pack-install] Reception pair '${outcome.endpoint_id}' (recipe '${outcome.recipe_id}') stops taking submissions until its owner re-enables it (${outcome.outcome})`,
      );
    }
  } catch (error) {
    console.warn(
      `[pack-install] Reception pair carry failed for '${packSlug}' — its changed pairs are left stale for the owner`,
      error,
    );
  }
};

/** After an update commits: re-pin each pair it may keep. The door is bound FIRST, so a pair
 *  is never current behind a door that cannot run its recipe. */
export const carryReceptionPairs = (
  changes: ReadonlyArray<ReceptionPairRecipeChange>,
  deps: ReceptionPairCarryDeps,
): Array<{ endpoint_id: string; recipe_id: string; outcome: 'carried' | ReceptionPairRisk }> =>
  affectedPairs(changes, deps).map(({ pair, recipe_id, after, next, paramsChanged }) => {
    const left = (outcome: ReceptionPairRisk) => ({ endpoint_id: pair.endpoint_id, recipe_id, outcome });
    if (paramsChanged) return left('params_changed');
    if (next.kind !== 'ready' || deps.door === undefined) return left('needs_owner');
    const door = bindReceptionDoor(
      {
        endpointId: pair.endpoint_id,
        recipeId: recipe_id,
        recipe: after,
        mintedBy: 'pack_install',
        confirmed: false,
        standingClosure: doorStandingClosure(pair, deps.door),
      },
      deps.door,
    );
    if (door.kind !== 'bound') return left('needs_owner');
    const written = deps.pairs.compareAndSet({
      endpoint_id: pair.endpoint_id,
      binding: next.binding,
      expected_updated_at: pair.updated_at,
      now: deps.now(),
    });
    return written.kind === 'conflict'
      ? left('needs_owner')
      : { endpoint_id: pair.endpoint_id, recipe_id, outcome: 'carried' as const };
  });
