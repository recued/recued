/** D-201 Slice 10X — the recipes a webhook starts, and their doors, for its
 *  card in Connections → Webhooks; and the owner's switch making them.
 *
 *  The owner's ruling (2026-11-19, after the Slice 10V re-audit): a webhook is
 *  managed in Connections → Webhooks, and its switch there is the owner's
 *  control, never a pack's. Switched on, Recued keeps its door available as
 *  best effort: it makes or re-makes the door whenever the recipe can have one,
 *  a door that was closed before included. A pack update changes neither
 *  direction (`reconcileWebhookDoors`' `keepOwnerRevoked`, unchanged). The card
 *  and the recipe link to each other.
 *
 *  So the card lists each recipe the webhook starts with its door (`open`,
 *  `missing` with why, or `closed`), and switching the webhook on, or pressing
 *  its door's button, which switches it on again, re-makes every door that is
 *  not open, for a recipe whose own switch is on.
 *
 *  D-201 Slice 10AF (the owner's rulings of 2026-11-20) — the webhook's switch
 *  is the master switch for the outside world. A webhook that starts one recipe
 *  has only it: it opens that recipe's door too, as above. One that starts
 *  several also gives each recipe its own door switch (`setDoor`), which the
 *  master leaves as the owner set it: switched on, it does not open a door its
 *  owner closed. A closed door keeps what arrives for its recipe as dead
 *  letters, until the owner opens it. */

import type { DishWebhookDoorChange, RecipeDefinition, WebhookIngressRecipeView } from '@recued/contracts';

import type { WebhookConsumerStore } from './storage/webhook-consumer-store.js';
import { RecordsNonOwnerExposureError } from './records/non-owner-exposure.js';
import { OWNER_DOOR_CLOSE_REASON } from './mint-door-contract.js';
import {
  deriveWebhookDoorCapability,
  describeWebhookDoorRefusal,
  followMainDishWebhookDoors,
  ownerDoorClosing,
  reasonCodeOf,
  webhookDoorState,
  type WebhookDoorEnrollDeps,
} from './webhook-door-enroll.js';

export interface WebhookIngressDoorsDeps {
  readonly consumerStore: Pick<
    WebhookConsumerStore,
    | 'recipesWithTriggers'
    | 'consumersOfRecipe'
    | 'doorContractIdForRecipe'
    | 'isConsumerEnabled'
    | 'stampTriggerContracts'
    | 'clearTriggerContracts'
    // D-201 Slice 10AO — required: absent, the owner's switch would be kept
    // nowhere, and an answer given before it would make the door.
    | 'keepOwnerDoorDecision'
  > & Partial<Pick<WebhookConsumerStore, 'newestRecipeDoor' | 'doorAnswerFor'>>;
  /** The recipe a trigger starts, as the runner reads it. */
  readonly recipeOf: (recipeId: string) => RecipeDefinition | null;
  /** The door substrate the save and the install mint with. */
  readonly door: WebhookDoorEnrollDeps;
  readonly now?: () => number;
}

export interface WebhookIngressDoors {
  /** The recipes this webhook starts, each with its door. Never throws: an
   *  unreadable store lists nothing. */
  list(ingressId: string): WebhookIngressRecipeView[];
  /** The owner's switch: every door of a recipe this webhook starts that is
   *  not open is made again, for a recipe whose own switch is on. Best effort;
   *  never throws. D-201 Slice 10AF — when it starts several recipes, a door
   *  its owner closed is left closed: each has its own switch. */
  reopen(ingressId: string): DishWebhookDoorChange[];
  /** D-201 Slice 10AF (the owner's rulings of 2026-11-20) — one recipe's own
   *  door switch: `open` makes or opens its door as the switch does; closing
   *  revokes it as the owner's (`OWNER_DOOR_CLOSE_REASON`). Throws
   *  `WebhookIngressDoorNotFoundError` for a recipe this webhook does not
   *  start, and `WebhookIngressDoorMasterOnlyError` for a webhook that starts
   *  one; a store fault otherwise reaches the caller. */
  setDoor(ingressId: string, recipeId: string, open: boolean): DishWebhookDoorChange[];
}

/** D-201 Slice 10AF — the recipe named is not one this webhook starts. */
export class WebhookIngressDoorNotFoundError extends Error {
  constructor(readonly recipe_id: string) {
    super(`this webhook does not start the recipe '${recipe_id}'`);
    this.name = 'WebhookIngressDoorNotFoundError';
  }
}

/** D-201 Slice 10AJ (10AI finding 9; the owner's ruling of 2026-11-20) — a
 *  webhook that starts one recipe has only its master switch. */
export class WebhookIngressDoorMasterOnlyError extends Error {
  constructor(readonly recipe_id: string) {
    super(`this webhook starts only '${recipe_id}', so its own switch opens and closes it`);
    this.name = 'WebhookIngressDoorMasterOnlyError';
  }
}

interface Started {
  readonly recipe_id: string;
  readonly consumer_kind: 'local_recipe' | 'pack_install';
  readonly consumer_id: string;
  readonly publisher_id: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createWebhookIngressDoors = (deps: WebhookIngressDoorsDeps): WebhookIngressDoors => {
  const now = deps.now ?? Date.now;
  /** Each (consumer, recipe) whose triggers this webhook's bindings carry. */
  const started = (ingressId: string): Started[] => {
    const found: Started[] = [];
    for (const recipe_id of deps.consumerStore.recipesWithTriggers()) {
      for (const owner of deps.consumerStore.consumersOfRecipe(recipe_id)) {
        const bindings = new Set(owner.snapshot.bindings
          .filter((row) => row.ingress_id === ingressId)
          .map((row) => row.binding_id));
        if (!owner.snapshot.triggers.some((row) => row.recipe_id === recipe_id && bindings.has(row.binding_id))) {
          continue;
        }
        found.push({
          recipe_id,
          consumer_kind: owner.consumer_kind,
          consumer_id: owner.consumer_id,
          publisher_id: owner.publisher_id,
        });
      }
    }
    return found;
  };
  /** D-201 Slice 10AF — whether its owner closed this recipe's door: the door
   *  its rows carry, else (rows left door-less by a fault) the last it had.
   *  D-201 Slice 10AJ (10AI finding 1) — or, with none on its rows, the answer
   *  "closed" the owner gave for a door an update has not made yet.
   *  D-201 Slice 10AO (10AM findings 1 and 13) — read as Kitchen and the door
   *  step read it (`ownerLeftDoorClosed`), the answer whatever its publisher.
   *  D-201 Slice 10AX (10AS finding 10) — and where it is read from, so the card
   *  says a closing made before the door was only for one that was. */
  const ownerClosing = (entry: Started) => ownerDoorClosing(
    { consumerStore: deps.consumerStore, definitionStore: deps.door.definitionStore },
    entry.consumer_kind,
    entry.consumer_id,
    entry.recipe_id,
    entry.publisher_id,
  );
  const ownerClosed = (entry: Started): boolean => ownerClosing(entry) !== null;
  /** D-201 Slice 10AO (10AM finding 1) — the owner's switch, kept first for
   *  each of the recipe's rows that carry no door, so a door step that does
   *  not finish leaves the door to be made as they set it: an answer given
   *  before cannot outrank it. Kept, rows that carry a door forget any answer. */
  const keepDecision = (entries: readonly Started[], door: 'open' | 'closed'): void => {
    for (const entry of entries) {
      deps.consumerStore.keepOwnerDoorDecision(
        entry.consumer_kind,
        entry.consumer_id,
        entry.recipe_id,
        entry.publisher_id,
        door,
      );
    }
  };
  /** D-201 Slice 10BE (10AY finding 17) — the keep after a door step: a fault
   *  in it never fails the switch. The door step has run, and has made its
   *  door or not; a switch that threw after it lost its notice of what the door
   *  may now do, though the door was open. Unkept, a step that left the rows
   *  door-less leaves the door as 10AO did (logged).
   *  D-201 Slice 10BL (10BF finding 16) — tried three times, and whether it was
   *  kept, so a choice lost is said (`notKeptWhereDoorless`). */
  const keepDecisionAfter = (entries: readonly Started[], door: 'open' | 'closed'): boolean => {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        keepDecision(entries, door);
        return true;
      } catch (error) {
        last = error;
      }
    }
    console.warn(`[webhook] the owner's switch not kept after its door step: ${errorMessage(last)}`);
    return false;
  };
  const doorOf = (entry: Started) => webhookDoorState(
    deps.door.definitionStore,
    deps.consumerStore.doorContractIdForRecipe(
      entry.consumer_kind,
      entry.consumer_id,
      entry.recipe_id,
      entry.publisher_id,
    ),
    now(),
  );

  /** D-201 Slice 10BL (10BF finding 16) — an owner's open that could not be
   *  kept after its door step, which left the recipe's rows with no open door:
   *  said on the recipe's change (`choice_not_kept`), for a restart, a settings
   *  change or an update would make the door as an earlier answer said. It was
   *  lost without a word; before 10BE the switch failed, which the owner saw. */
  const notKeptWhereDoorless = (
    changes: DishWebhookDoorChange[],
    entries: readonly Started[],
    recipeId: string,
  ): DishWebhookDoorChange[] => {
    // D-201 Slice 10BR (10BM findings 17 and 18) — only where a closing of the
    // owner's still stands, read as the card reads it (`ownerClosed`): it is
    // what a restart, a settings change or an update would make the door as.
    // It was said wherever the keep failed and no door was open, though the
    // first keep had stored the open, or no closing stood to come back. And a
    // fault reading it never fails the switch, whose door step has run: it
    // failed a switch that had opened its door, or dropped its change.
    try {
      if (entries.some((entry) => doorOf(entry) === 'live')) return changes;
      if (!entries.some((entry) => ownerClosed(entry))) return changes;
    } catch (error) {
      console.warn(`[webhook] whether the owner's switch was lost could not be read: ${errorMessage(error)}`);
      return changes;
    }
    let marked = false;
    const out = changes.map((change) => {
      if (change.recipe_id !== recipeId) return change;
      marked = true;
      return { ...change, choice_not_kept: true as const };
    });
    if (!marked) out.push({ recipe_id: recipeId, state: 'unchanged', was_open: false, choice_not_kept: true });
    return out;
  };

  return {
    list(ingressId) {
      let entries: Started[];
      try {
        entries = started(ingressId);
      } catch {
        return [];
      }
      const views: WebhookIngressRecipeView[] = [];
      for (const entry of entries) {
        const recipe = (() => {
          try {
            return deps.recipeOf(entry.recipe_id);
          } catch {
            return null;
          }
        })();
        const name = recipe?.metadata?.name?.trim();
        let state: ReturnType<typeof doorOf>;
        let armed: boolean;
        try {
          state = doorOf(entry);
          armed = deps.consumerStore.isConsumerEnabled(entry.consumer_kind, entry.consumer_id);
        } catch {
          continue;
        }
        // D-201 Slice 10AJ (10AI finding 8) — rows a fault left door-less
        // under a door its owner closed: closed, as the master switch reads it
        // and leaves it. The card said "missing", with no reason, while the
        // master skipped it unsaid.
        let closing: ReturnType<typeof ownerClosing> = null;
        try {
          closing = state !== 'live' ? ownerClosing(entry) : null;
        } catch {
          closing = null;
        }
        const closedByItsOwner = closing !== null;
        // D-201 Slice 10AO (10AM finding 15) — its rows carry no door: what is
        // sent to it is kept as having none (`door_missing`), as the card says.
        // D-201 Slice 10AX (10AS finding 10) — "before its door was made" only
        // for a closing kept before one was (`answer`). A door its owner closed
        // after it was made, its rows door-less since, was said to be closed
        // before it was made, and why it has no door now was not said.
        const doorLess = state === 'missing';
        const noDoor = closedByItsOwner && doorLess;
        const noDoorYet = closing === 'answer';
        if (closedByItsOwner) state = 'closed';
        const view: WebhookIngressRecipeView = {
          recipe_id: entry.recipe_id,
          ...(name ? { name } : {}),
          consumer_kind: entry.consumer_kind,
          ...(entry.consumer_kind === 'pack_install' ? { pack_slug: entry.consumer_id } : {}),
          armed,
          door: state === 'live' ? 'open' : state,
          // D-201 Slice 10AF — so the card can say who closed it.
          ...(closedByItsOwner ? { closed_by_owner: true as const } : {}),
          ...(noDoor ? { no_door: true as const } : {}),
          ...(noDoorYet ? { no_door_yet: true as const } : {}),
        };
        // Why no door was made: what the mint derives now, as it would.
        // D-201 Slice 10AX (10AS finding 10) — for rows its owner's closing left
        // door-less too: why there is none now.
        // D-201 Slice 10BE (10AY finding 16) — and for a closed door that still
        // stands: opening it makes a door this version cannot have. The card
        // said to open it, where Kitchen said it cannot have one.
        if (state !== 'live' && recipe !== null) {
          // D-201 Slice 10AC (10AA finding 18) — a recipe its exposure check
          // refuses cannot have a door as it stands: `refused`, as the save's
          // preview says (`exposure_refused`), never a fault to try again.
          try {
            deps.door.preflightNonOwnerRecipeExposure?.(recipe, 'webhook');
          } catch (error) {
            if (error instanceof RecordsNonOwnerExposureError) {
              views.push({ ...view, door_reason: error.message, door_reason_code: 'refused' });
              continue;
            }
            views.push({ ...view, door_reason: errorMessage(error), door_reason_code: 'fault' });
            continue;
          }
          try {
            const derived = deriveWebhookDoorCapability({ recipe_id: entry.recipe_id, recipe }, deps.door);
            if (!derived.ok) {
              views.push({
                ...view,
                door_reason: describeWebhookDoorRefusal(derived.refusal),
                door_reason_code: reasonCodeOf(derived.refusal),
              });
              continue;
            }
          } catch (error) {
            views.push({ ...view, door_reason: errorMessage(error), door_reason_code: 'fault' });
            continue;
          }
        }
        views.push(view);
      }
      return views.sort((left, right) => (left.name ?? left.recipe_id).localeCompare(right.name ?? right.recipe_id)
        || left.recipe_id.localeCompare(right.recipe_id));
    },
    reopen(ingressId) {
      let entries: Started[];
      try {
        entries = started(ingressId);
      } catch (error) {
        console.warn(`[webhook] doors of '${ingressId}' not made on its switch: ${errorMessage(error)}`);
        return [];
      }
      const changes: DishWebhookDoorChange[] = [];
      const done = new Set<string>();
      // D-201 Slice 10AF (the owner's rulings of 2026-11-20) — several recipes,
      // each with its own door switch: the master leaves one its owner closed.
      const several = new Set(entries.map((entry) => entry.recipe_id)).size > 1;
      for (const entry of entries) {
        if (done.has(entry.recipe_id)) continue;
        try {
          // A recipe switched off in Kitchen is the owner's to switch on there.
          if (!deps.consumerStore.isConsumerEnabled(entry.consumer_kind, entry.consumer_id)) continue;
          if (doorOf(entry) === 'live') continue;
          if (several && ownerClosed(entry)) continue;
          const recipe = deps.recipeOf(entry.recipe_id);
          if (recipe === null) continue;
          done.add(entry.recipe_id);
          // D-201 Slice 10AO — switched on, its doors are to be open.
          const switched = entries.filter((same) => same.recipe_id === entry.recipe_id
            && deps.consumerStore.isConsumerEnabled(same.consumer_kind, same.consumer_id));
          keepDecision(switched, 'open');
          const made = followMainDishWebhookDoors(
            { recipe_id: entry.recipe_id, recipe },
            { ...deps.door, consumerStore: deps.consumerStore },
            { mintedBy: 'user_self', retireReason: 'owner_reopened', reopen: true },
          );
          // D-201 Slice 10AX (10AS finding 10) — and again after its door step:
          // one that cleared rows which carried a door, then failed, left them
          // door-less with nothing kept, and the owner's closing of the door
          // before stood in for this switch. Kept, rows a stamp reached forget it.
          changes.push(...(keepDecisionAfter(switched, 'open')
            ? made
            : notKeptWhereDoorless(made, switched, entry.recipe_id)));
        } catch (error) {
          console.warn(`[webhook] door for '${entry.recipe_id}' not made on its switch: ${errorMessage(error)}`);
        }
      }
      return changes;
    },
    setDoor(ingressId, recipeId, open) {
      const all = started(ingressId);
      const entries = all.filter((entry) => entry.recipe_id === recipeId);
      if (entries.length === 0) throw new WebhookIngressDoorNotFoundError(recipeId);
      // D-201 Slice 10AJ (10AI finding 9) — the owner's ruling of 2026-11-20:
      // starting one recipe, the webhook's own switch is that recipe's only
      // one. Its door was closed as the owner's here, which no card offers.
      if (new Set(all.map((entry) => entry.recipe_id)).size < 2) {
        throw new WebhookIngressDoorMasterOnlyError(recipeId);
      }
      if (open) {
        const recipe = deps.recipeOf(recipeId);
        if (recipe === null) throw new WebhookIngressDoorNotFoundError(recipeId);
        // D-201 Slice 10AO (10AM finding 1) — kept first: made in the door
        // step below, the decision is done; a step that does not finish
        // leaves the door to be made open, not as an answer given before.
        keepDecision(entries, 'open');
        const opened = followMainDishWebhookDoors(
          { recipe_id: recipeId, recipe },
          { ...deps.door, consumerStore: deps.consumerStore },
          { mintedBy: 'user_self', retireReason: 'owner_reopened', reopen: true },
        );
        // D-201 Slice 10AX (10AS finding 10) — and again after its door step, as
        // the master switch keeps it.
        return keepDecisionAfter(entries, 'open') ? opened : notKeptWhereDoorless(opened, entries, recipeId);
      }
      // Closed as the owner's: the door its rows carry, revoked where it stands,
      // so a later update, start or switch keeps it closed (`closedByOwner`). A
      // recipe with no door open has nothing to close.
      // D-201 Slice 10AO (10AM finding 1) — rows that carry no door keep the
      // owner's closing for the door made later. It was nothing to close, so
      // an answer "open" given before made it open.
      keepDecision(entries, 'closed');
      for (const entry of entries) {
        const contractId = deps.consumerStore.doorContractIdForRecipe(
          entry.consumer_kind,
          entry.consumer_id,
          entry.recipe_id,
          entry.publisher_id,
        );
        if (contractId === null || webhookDoorState(deps.door.definitionStore, contractId, now()) !== 'live') continue;
        deps.door.definitionStore.revoke(contractId, OWNER_DOOR_CLOSE_REASON);
      }
      return [];
    },
  };
};
