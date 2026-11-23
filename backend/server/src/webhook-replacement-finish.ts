/** D-201 Slice 10U (10Q finding 9) — the start finishes what a process left
 *  between a webhook replacement and its finalize, as the save, delete or pack
 *  install would have finished it.
 *
 *  `replaceConsumer` records the consumer's prior rows in the transaction that
 *  replaces them, and the caller's finalize clears the record (Slice 10P).
 *  Since 10U the callers make the door (`reconcileWebhookDoors`) BEFORE that
 *  finalize, so a record stands until the door does: a process that dies
 *  anywhere from the replace to the finalize leaves one. 10P finalized it at
 *  the start and made no door, so every row it re-homed landed on a trigger
 *  with none, and the first poll cancelled it unseen.
 *
 *  For each record:
 *    - a Kitchen recipe whose save never committed is given back
 *      (`restoreConsumer`), with the rows that still wait carried back: the
 *      webhook has what it had, under the door it had. Since 10X the record
 *      carries the recipe row's stamp from before the change, so a save that
 *      changed only its switch or its way in is told apart too (10V finding
 *      30); a record from before 10X is judged by its triggers, as 10U did;
 *    - anything else is finalized after its door. A recipe whose trigger rows
 *      already carry a door keeps it: its save made it (10V finding 2: judged
 *      from the record's prior, a door the save itself retired read as the
 *      owner's revoke and was put back, closing the webhook for good). A recipe
 *      whose rows carry none gets its door made as the save's would have been,
 *      when its stored version declares exactly the rows it has. A door it
 *      cannot have leaves the webhook on with its deliveries kept for the
 *      owner (`door_missing`): Recued never flips the switch (the owner's
 *      ruling of 2026-11-19; 10U switched a kept-on Kitchen webhook off).
 *  A record that cannot be read or finished is set aside (10Q finding 23), but
 *  one that met a fault that may pass is left for the next start (10V finding
 *  27).
 *
 *  Run once at the start, before the outbox, the worker and the dead-letter
 *  sweep, and synchronously, so no save interleaves. Never throws. */

import type { RecipeDefinition } from '@recued/contracts';

import {
  isPassingStoreFault,
  recipeRowStamp,
  type WebhookConsumerKind,
  type WebhookConsumerSnapshot,
  type WebhookConsumerStore,
} from './storage/webhook-consumer-store.js';
import {
  reconcileWebhookDoors,
  retireWebhookDoors,
  type WebhookDoorEnrollDeps,
  type WebhookDoorOutcome,
} from './webhook-door-enroll.js';

/** The recipe store as the runner reads it: the resolved definition, and the
 *  stored row (its publisher, and its stamp: hash and save time). */
export interface WebhookReplacementRecipes {
  get(recipeId: string): RecipeDefinition | null;
  getStored(recipeId: string): {
    readonly publisher_id: string;
    readonly recipe_hash: string;
    readonly installed_at: number;
  } | null;
}

export interface FinishedWebhookReplacement {
  readonly consumer_kind: WebhookConsumerKind;
  readonly consumer_id: string;
  /** `left`: a fault that may pass stopped it; the next start tries again. */
  readonly outcome: 'restored' | 'finished' | 'set_aside' | 'left';
  /** Each recipe's door, when one was made (`finished` with door deps). */
  readonly doors?: ReadonlyMap<string, WebhookDoorOutcome>;
  /** The recipes whose rows already carried a door, which they keep. */
  readonly kept_doors?: readonly string[];
  /** Why it was set aside or left. */
  readonly reason?: string;
}

const PAIR = '\u0000';

/** The (slot, event type) pairs a recipe's trigger rows carry in a snapshot. */
const rowPairs = (
  snapshot: WebhookConsumerSnapshot,
  recipeId: string,
  publisherId: string,
): Set<string> => {
  const slots = new Map(snapshot.bindings.map((row) => [row.binding_id, row.logical_binding]));
  const pairs = new Set<string>();
  for (const row of snapshot.triggers) {
    if (row.recipe_id !== recipeId || row.publisher_id !== publisherId) continue;
    pairs.add(`${slots.get(row.binding_id) ?? ''}${PAIR}${row.provider_event_type}`);
  }
  return pairs;
};

/** The (slot, event type) pairs a recipe declares. */
const declaredPairs = (recipe: RecipeDefinition | null): Set<string> => {
  const pairs = new Set<string>();
  for (const trigger of recipe?.webhook_triggers ?? []) {
    for (const eventType of trigger.event_types) pairs.add(`${trigger.binding}${PAIR}${eventType}`);
  }
  return pairs;
};

const samePairs = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((pair) => right.has(pair));

/** The stored recipe of a trigger row's recipe and publisher, or null. */
const storedRecipe = (
  recipes: WebhookReplacementRecipes,
  recipeId: string,
  publisherId: string,
): RecipeDefinition | null => {
  const stored = recipes.getStored(recipeId);
  if (stored === null || stored.publisher_id !== publisherId) return null;
  return recipes.get(recipeId);
};

/** D-201 Slice 10Y (10V finding 17) — whether a recipe remains after a pack
 *  update or a replacement the start finishes: it is still stored, under the
 *  publisher its trigger names. A trigger closed while it remains closes as
 *  `recipe_replaced`, else `recipe_removed`. The install and the start ask
 *  this one question, so one update gives one reason: the install asked
 *  whether the update still ships the recipe, and an update that stops
 *  shipping one but leaves it installed closed its history as removed where
 *  the start's finish of the same update said saved differently. */
export const recipeRemainsStored = (
  recipes: WebhookReplacementRecipes,
  recipeId: string,
  publisherId: string,
): boolean => storedRecipe(recipes, recipeId, publisherId) !== null;

/** D-201 Slice 10X (10V finding 30) — whether a Kitchen recipe's replacement
 *  committed: by the recipe row's stamp when the record carries one (the row
 *  moved on, or went: committed; as it was: never committed), else by its
 *  triggers (`kitchenReplacementCommitted`), as a record from before 10X. */
const kitchenCommitted = (
  record: { prior: WebhookConsumerSnapshot | null; current: WebhookConsumerSnapshot; prior_recipe_stamp: string | null },
  recipes: WebhookReplacementRecipes,
): boolean => {
  if (record.prior_recipe_stamp !== null && record.prior !== null) {
    return recipeRowStamp(recipes.getStored(record.prior.consumer_id)) !== record.prior_recipe_stamp;
  }
  return record.prior === null || kitchenReplacementCommitted(record.prior, record.current, recipes);
};

/** Whether a Kitchen recipe's replacement committed: `false` when its recipe
 *  row still declares the prior rows' triggers and not the ones the replace
 *  wrote. A save that left the triggers as they were is committed either way:
 *  finishing it carries the same triggers on, under the stored version's door. */
export const kitchenReplacementCommitted = (
  prior: WebhookConsumerSnapshot,
  current: WebhookConsumerSnapshot,
  recipes: WebhookReplacementRecipes,
): boolean => {
  const recipeId = prior.consumer_id;
  const publishers = new Set([...prior.triggers, ...current.triggers]
    .filter((row) => row.recipe_id === recipeId)
    .map((row) => row.publisher_id));
  for (const publisherId of publishers) {
    const declared = declaredPairs(storedRecipe(recipes, recipeId, publisherId));
    if (samePairs(declared, rowPairs(prior, recipeId, publisherId))
      && !samePairs(declared, rowPairs(current, recipeId, publisherId))) {
      return false;
    }
  }
  return true;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const finishWebhookReplacementsAtStart = (deps: {
  readonly consumerStore: Pick<
    WebhookConsumerStore,
    | 'pendingReplacements'
    | 'setAsidePendingReplacement'
    | 'restoreConsumer'
    | 'finalizeConsumerReplacement'
  >;
  readonly recipes: WebhookReplacementRecipes;
  /** The door substrate the save and the install mint with. Absent: the
   *  replacement is finished with no door, as those paths make none. */
  readonly door?: WebhookDoorEnrollDeps;
}): FinishedWebhookReplacement[] => {
  let pending: ReturnType<WebhookConsumerStore['pendingReplacements']>;
  try {
    pending = deps.consumerStore.pendingReplacements();
  } catch (error) {
    console.warn(`[webhook] unfinished replacements not read at the start: ${errorMessage(error)}`);
    return [];
  }
  const finished: FinishedWebhookReplacement[] = [];
  for (const record of pending) {
    const { consumer_kind, consumer_id, prior, current, prior_recipe_stamp } = record;
    const setAside = (reason: string): void => {
      try {
        deps.consumerStore.setAsidePendingReplacement(consumer_kind, consumer_id);
      } catch {
        // Left for the next start to try again.
      }
      finished.push({ consumer_kind, consumer_id, outcome: 'set_aside', reason });
    };
    if (prior === null) {
      setAside('its record cannot be read');
      continue;
    }
    try {
      if (consumer_kind === 'local_recipe' && !kitchenCommitted(record, deps.recipes)) {
        deps.consumerStore.restoreConsumer(prior, { carryOpenRows: true });
        finished.push({ consumer_kind, consumer_id, outcome: 'restored' });
        continue;
      }
      const enabled = current.bindings.length > 0
        && current.bindings.every((row) => row.enabled === 1);
      const keyOf = (row: { recipe_id: string; publisher_id: string }): string =>
        `${row.publisher_id}${PAIR}${row.recipe_id}`;
      // What the rows carry now. A recipe whose rows carry a door keeps it:
      // its save (or an earlier start) made it, and judged by the record's
      // prior, a door the save itself retired read as the owner's revoke.
      const stamped = new Set(current.triggers
        .filter((row) => row.contract_id !== null)
        .map(keyOf));
      const liveDoors = new Set(current.triggers
        .map((row) => row.contract_id)
        .filter((id): id is string => id !== null));
      // Each other recipe whose stored version declares exactly the rows it
      // has. One that does not gets no door, and its deliveries are kept for
      // the owner.
      const seen = new Set<string>();
      const recipes: Array<{ recipe_id: string; publisher_id: string; recipe: RecipeDefinition }> = [];
      for (const row of current.triggers) {
        const key = keyOf(row);
        if (seen.has(key) || stamped.has(key)) continue;
        seen.add(key);
        const recipe = storedRecipe(deps.recipes, row.recipe_id, row.publisher_id);
        if (recipe === null
          || !samePairs(declaredPairs(recipe), rowPairs(current, row.recipe_id, row.publisher_id))) continue;
        recipes.push({ recipe_id: row.recipe_id, publisher_id: row.publisher_id, recipe });
      }
      // The door first, then the finalize, as the save and the install now do:
      // should this start die in between, the record still stands, and the
      // next start finds the door on the rows and keeps it.
      let doors: Map<string, WebhookDoorOutcome> | undefined;
      if (deps.door !== undefined) {
        const needing = new Set(recipes.map(keyOf));
        doors = reconcileWebhookDoors({
          consumer_kind,
          consumer_id,
          // Only the prior rows of the recipes whose doors are made now: the
          // rest keep the door their rows carry.
          prior: { ...prior, triggers: prior.triggers.filter((row) => needing.has(keyOf(row))) },
          recipes,
          ...(consumer_kind === 'pack_install'
            ? { mintedBy: 'pack_install', retireReason: 'pack_reinstalled', keepOwnerRevoked: true }
            : {
                mintedBy: 'user_self',
                retireReason: current.triggers.length > 0 ? 'resaved' : 'webhook_declarations_removed',
                ...(enabled ? { keepOwnerRevoked: true } : {}),
              }),
        }, deps.door);
        // The doors the replacement superseded that no row carries now: what
        // the save's door step would have retired.
        const made = new Set([...doors.values()]
          .flatMap((outcome) => (outcome.kind === 'minted' || outcome.kind === 'kept_revoked'
            ? [outcome.contract_id]
            : [])));
        const superseded = [...new Set(prior.triggers
          .filter((row) => !needing.has(keyOf(row)))
          .map((row) => row.contract_id)
          .filter((id): id is string => id !== null && !liveDoors.has(id) && !made.has(id)))];
        retireWebhookDoors(
          superseded,
          consumer_kind === 'pack_install' ? 'pack_reinstalled' : 'resaved',
          deps.door,
        );
      }
      deps.consumerStore.finalizeConsumerReplacement(prior, {
        recipeRemains: (recipeId, publisherId) =>
          recipeRemainsStored(deps.recipes, recipeId, publisherId),
      });
      finished.push({
        consumer_kind,
        consumer_id,
        outcome: 'finished',
        ...(doors !== undefined ? { doors } : {}),
        ...(stamped.size > 0
          ? { kept_doors: [...stamped].map((key) => key.split(PAIR)[1]!) }
          : {}),
      });
    } catch (error) {
      if (isPassingStoreFault(error)) {
        // A busy or failing disk: the record stands for the next start.
        finished.push({ consumer_kind, consumer_id, outcome: 'left', reason: errorMessage(error) });
        continue;
      }
      setAside(errorMessage(error));
    }
  }
  return finished;
};
