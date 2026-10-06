/** D-209 #1 W2b — webhook door ENROLLMENT: mint the derived door contract a
 *  recipe's webhook dispatches will run under, and stamp it on the recipe's
 *  trigger rows.
 *
 *  The webhook twin of `reception-door-bind.ts`, with two deliberate
 *  differences that come from what a webhook IS:
 *
 *    1. **No write fence.** A reception door that owes the visitor a response
 *       refuses writes (a held run renders nothing). A webhook owes its caller
 *       nothing back — writes are the POINT, and the door's `admin` ceiling
 *       (D-209 §1.4: two-sided enrollment IS the standing approval) is what
 *       lets a granted write admit. Destructive still holds.
 *    2. **No consent gate at mint.** Local saves wire the consumer DISARMED;
 *       the `recipe.webhook.arm` rpc is the explicit consent gesture, and pack
 *       installs carry consent on the install screen. The mint is substrate;
 *       the save/arm responses carry `{operation_ids, added, removed}` so the
 *       owner surface (Task 3) can render exactly what the enrollment derived
 *       (§5.1g: every widening surface enumerates from the SAME derivation the
 *       mint uses).
 *
 *  ## Ordering — the whole point of this module
 *
 *  `replaceConsumer` runs BEFORE the cross-store recipe save and must stay
 *  restorable (a failed save rolls the prior rows back, stamps included). So:
 *
 *      save succeeds → derive → mint → STAMP trigger rows → retire prior door
 *
 *  Every crash window is fail-closed:
 *    - before mint: rows are NULL → dispatch floors to `PUBLIC_CONTRACT_ID`
 *      (denies); status says "door missing — re-save".
 *    - between mint and stamp: an orphan LIVE contract no row references —
 *      inert (authority only attaches through a dispatch carrying its id).
 *    - between stamp and retire: the prior door is live but unreferenced
 *      (its trigger rows were deleted by `replaceConsumer`) — same class.
 *
 *  ## One door per (consumer, RECIPE)
 *
 *  Capability is a property of the RECIPE (D-207 rev 7), so all of one
 *  recipe's trigger rows (one per provider event type) share one door, and a
 *  pack install mints one door per webhook-declaring recipe it ships.
 *
 *  Spec: D-209 §1.4; D-207 §5.1b / §5.1d / §5.1g. */

import type { DishWebhookDoorChange, RecipeDefinition } from '@recued/contracts';

import {
  deriveResolvedRecipeCapability,
  type OpResolver,
  type RecipeCapabilityRefusal,
} from './derive-recipe-capability.js';
import {
  mintDoorContract,
  doorCapabilityChanged,
  retireDoorContract,
  type MintDoorDeps,
} from './mint-door-contract.js';
import type {
  WebhookConsumerKind,
  WebhookConsumerSnapshot,
  WebhookConsumerStore,
} from './storage/webhook-consumer-store.js';
import type { DoorRecipeResolver } from './recipe-capability-wiring.js';

export interface WebhookDoorEnrollDeps extends MintDoorDeps {
  readonly consumerStore: Pick<
    WebhookConsumerStore,
    'stampTriggerContracts' | 'doorContractIdForRecipe'
  >;
  /** The installed dish's resolved `config_overlay` for a recipe — the SAME
   *  lookup the webhook runner feeds `handleExecute`, so the closure the door
   *  grants is derived from the config the run will actually use. */
  readonly resolveConfig: (recipeId: string) => Record<string, unknown> | undefined;
  readonly resolveDoorRecipe?: DoorRecipeResolver;
  readonly resolveOp?: OpResolver;
  /** D-221 §3.3.3 — arming/minting is the non-owner exposure act. A
   * refusing preflight leaves trigger rows NULL-stamped and therefore
   * uncallable; saving the draft itself remains allowed. */
  readonly preflightNonOwnerRecipeExposure?: (
    recipe: RecipeDefinition,
    surface: 'webhook',
  ) => void;
}

export type WebhookDoorOutcome =
  /** The door is minted (or re-used unchanged) and stamped on every trigger
   *  row. `added` / `removed` diff against the PRIOR door's stored scope —
   *  both empty on a re-save that did not move the recipe's authority. */
  | {
      readonly kind: 'minted';
      readonly contract_id: string;
      readonly operation_ids: readonly string[];
      readonly added: readonly string[];
      readonly removed: readonly string[];
      readonly unchanged: boolean;
    }
  /** The recipe cannot back a door (dynamic dispatch / unresolvable
   *  connection). Nothing was minted; its trigger rows stay NULL and every
   *  dispatch denies at the floor. The save is NOT blocked — drafts save. */
  | { readonly kind: 'refused'; readonly refusal: RecipeCapabilityRefusal }
  /** A store fault after the save already committed. Fail-closed exactly like
   *  a crash in the same window: rows stay NULL, status says re-save. */
  | { readonly kind: 'failed'; readonly message: string }
  /** D-295 — a PACK re-install found the door its owner revoked: it stays
   *  revoked, still stamped, so every delivery keeps being refused. Nothing
   *  was minted. */
  | { readonly kind: 'kept_revoked'; readonly contract_id: string };

/** Owner-facing prose for a door refusal — the webhook sibling of the
 *  reception handler's `describeDoorRefusal`, minus the responding-door case
 *  (a webhook owes its caller nothing back, so writes are not refused). */
export const describeWebhookDoorRefusal = (
  refusal: RecipeCapabilityRefusal,
): string => {
  switch (refusal.reason) {
    case 'dispatch_unresolvable':
      return `this recipe cannot be lowered to the exact operations and account bindings the webhook would run: ${refusal.detail}`;
    case 'dynamic_dispatch':
      return `step '${refusal.step_id}' chooses what to run at runtime (${refusal.field}), so what this webhook could do is not knowable in advance. A webhook-armed recipe must be statically analyzable.`;
    case 'dynamic_connection':
      return `step '${refusal.step_id}' resolves its connection at runtime (${refusal.ref}), so which account it would use is not knowable in advance.`;
    case 'literal_connection':
      return `step '${refusal.step_id}' names a connection directly ('${refusal.ref}'). A connection is a slot filled by the pack's enrollment, never hard-coded in a recipe.`;
  }
};

/** Distinct non-null door ids stamped on a snapshot's trigger rows —
 *  optionally narrowed to one recipe. The uninstall/removal paths retire
 *  these; the enroll path diffs against them. */
export const snapshotDoorContractIds = (
  snapshot: WebhookConsumerSnapshot | null,
  recipe?: { readonly recipe_id: string; readonly publisher_id: string },
): string[] => {
  const ids = new Set<string>();
  for (const row of snapshot?.triggers ?? []) {
    if (row.contract_id === null) continue;
    if (recipe !== undefined
      && (row.recipe_id !== recipe.recipe_id
        || row.publisher_id !== recipe.publisher_id)) continue;
    ids.add(row.contract_id);
  }
  return [...ids].sort();
};

/** Retire a set of webhook doors. Revocation is idempotent and a missing
 *  definition is a no-op, so this is safe on every teardown path (uninstall,
 *  declaration removal, re-save supersession). */
export const retireWebhookDoors = (
  contractIds: readonly string[],
  reason: string,
  deps: Pick<MintDoorDeps, 'definitionStore'>,
): void => {
  for (const contractId of contractIds) {
    retireDoorContract(contractId, reason, deps);
  }
};

/** Reconcile one consumer's webhook doors after its cross-store save/install
 *  has SUCCEEDED: enroll a door per webhook-declaring recipe, then retire
 *  every prior door that was not re-used (a capability change replaces the
 *  door; a removed declaration just retires it).
 *
 *  Returns one outcome per input recipe, keyed by `recipe_id`. Never throws
 *  for a single recipe's fault — the save already committed, so a per-recipe
 *  failure degrades to the fail-closed NULL-stamp state and says so. */
export const reconcileWebhookDoors = (
  input: {
    readonly consumer_kind: WebhookConsumerKind;
    readonly consumer_id: string;
    /** The snapshot `replaceConsumer`/`removeConsumer` returned — the prior
     *  authority window, whose stamps name the doors being superseded. */
    readonly prior: WebhookConsumerSnapshot | null;
    /** The CURRENT webhook-declaring recipes (post-save). Empty on the
     *  declaration-removal path: nothing enrolls, every prior door retires. */
    readonly recipes: ReadonlyArray<{
      readonly recipe_id: string;
      readonly publisher_id: string;
      readonly recipe: RecipeDefinition;
    }>;
    readonly mintedBy: string;
    /** Stamped as the prior doors' revocation reason (`'resaved'`,
     *  `'pack_reinstalled'`, …). */
    readonly retireReason: string;
    /** ⛔ D-295 — a PACK install: a door its owner revoked stays revoked.
     *  Re-minting it (the default — a revoked prior "must never be re-used as
     *  the live door") re-opened, on every pack update, a door the owner had
     *  shut. A pack's door that is revoked while still STAMPED on its rows was
     *  revoked by the owner: every machine retirement replaces the stamp with a
     *  new door, or leaves none. A Kitchen re-save is the owner acting on that
     *  recipe, and still re-mints. */
    readonly keepOwnerRevoked?: boolean;
  },
  deps: WebhookDoorEnrollDeps,
): Map<string, WebhookDoorOutcome> => {
  const outcomes = new Map<string, WebhookDoorOutcome>();
  const reused = new Set<string>();

  for (const entry of input.recipes) {
    const priorIds = snapshotDoorContractIds(input.prior, entry);
    try {
      deps.preflightNonOwnerRecipeExposure?.(entry.recipe, 'webhook');
    } catch (error) {
      outcomes.set(entry.recipe_id, {
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const config = deps.resolveConfig(entry.recipe_id);
    const dispatchRecipe = deps.resolveDoorRecipe?.(entry.recipe, config ?? {})
      ?? { ok: true as const, recipe: entry.recipe };
    if (!dispatchRecipe.ok) {
      outcomes.set(entry.recipe_id, {
        kind: 'refused',
        refusal: {
          reason: 'dispatch_unresolvable',
          step_id: '<recipe>',
          detail: dispatchRecipe.reason,
        },
      });
      continue;
    }
    const resolveOp = dispatchRecipe.resolveOp ?? deps.resolveOp;
    const derived = deriveResolvedRecipeCapability(
      entry.recipe,
      dispatchRecipe.recipe,
      {
        ...(config === undefined ? {} : { config }),
        ...(resolveOp === undefined ? {} : { resolveOp }),
      },
    );
    if (!derived.ok) {
      outcomes.set(entry.recipe_id, { kind: 'refused', refusal: derived.refusal });
      continue;
    }

    try {
      // The diff renders against the prior door only when there is exactly ONE
      // — the invariant state. Zero (first save) or a disagreeing set (a
      // half-stamped crash window) diff against nothing: every op reads as
      // `added`, which is the honest consent list for a door being minted from
      // scratch.
      const stored = priorIds.length === 1
        ? deps.definitionStore.get(priorIds[0]!)
        : null;
      if (
        input.keepOwnerRevoked === true
        && stored !== null
        && stored.revoked_at !== undefined
        && stored.revoked_at !== null
      ) {
        const stampedRows = deps.consumerStore.stampTriggerContracts({
          consumer_kind: input.consumer_kind,
          consumer_id: input.consumer_id,
          recipe_id: entry.recipe_id,
          publisher_id: entry.publisher_id,
          contract_id: priorIds[0]!,
        });
        reused.add(priorIds[0]!);
        outcomes.set(entry.recipe_id, stampedRows === 0
          ? { kind: 'failed', message: 'no trigger rows to stamp — re-save the recipe' }
          : { kind: 'kept_revoked', contract_id: priorIds[0]! });
        continue;
      }
      const diff = doorCapabilityChanged(stored, derived.capability);
      // A revoked prior can still anchor the DIFF (it is what the owner last
      // consented to) but must never be re-used as the live door.
      const reusable = stored !== null
        && (stored.revoked_at === undefined || stored.revoked_at === null);

      let contractId: string;
      let unchanged = false;
      if (!diff.changed && reusable) {
        contractId = priorIds[0]!;
        unchanged = true;
      } else {
        contractId = mintDoorContract(
          {
            door: 'webhook',
            recipeId: entry.recipe_id,
            capability: derived.capability,
            mintedBy: input.mintedBy,
          },
          deps,
        ).contract_id;
      }

      const stampedRows = deps.consumerStore.stampTriggerContracts({
        consumer_kind: input.consumer_kind,
        consumer_id: input.consumer_id,
        recipe_id: entry.recipe_id,
        publisher_id: entry.publisher_id,
        contract_id: contractId,
      });
      if (stampedRows === 0) {
        // No trigger rows to carry the door — retire the fresh mint rather
        // than leave a live orphan, and report the enrollment as failed.
        if (!unchanged) retireDoorContract(contractId, 'stamp_failed', deps);
        outcomes.set(entry.recipe_id, {
          kind: 'failed',
          message: 'no trigger rows to stamp — re-save the recipe',
        });
        continue;
      }

      if (unchanged) reused.add(contractId);
      outcomes.set(entry.recipe_id, {
        kind: 'minted',
        contract_id: contractId,
        operation_ids: derived.capability.operation_ids,
        added: diff.added,
        removed: diff.removed,
        unchanged,
      });
    } catch (error) {
      outcomes.set(entry.recipe_id, {
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Supersession — every prior door not re-used stops governing NOW. Retire
  // runs LAST (mint → stamp → retire) so no window pairs a retired door with
  // unstamped rows; both halves of that window fail closed regardless.
  const priorAll = snapshotDoorContractIds(input.prior);
  retireWebhookDoors(
    priorAll.filter((id) => !reused.has(id)),
    input.retireReason,
    deps,
  );

  return outcomes;
};

/** D-209 — a recipe's webhook door FOLLOWS ITS MAIN DISH.
 *
 *  A webhook-started run takes the MAIN dish's settings (`webhook-recipe-runner`
 *  `resolveConfig`), and its door is derived from those settings — which account
 *  each step reads is a dish value, not a recipe one (D-207 §5.1c-bis). Doors were
 *  minted only at `recipe.save` and pack install, and both read the main dish:
 *
 *    - ⛔ a fresh pack install HAS no main dish, so every recipe whose connection
 *      is a dish setting — all 32 shipped webhook recipes name theirs
 *      `{{config.<vendor>}}` — got no door, and every delivery ended
 *      `terminal_non_success` before the recipe ran;
 *    - and once the owner did choose the account, nothing re-derived: the door
 *      stayed missing, or (after a later swap) the runner refused every delivery
 *      with "door authority changed; re-save the recipe".
 *
 *  So the dish rpc calls this whenever the MAIN dish's settings change, it is
 *  made main, or it goes. Owner's ruling (2026-10-04): a settings save is the
 *  owner's own act and the door follows it — and per D-207 §5.1g the change is
 *  RETURNED, so the surface that saved names what the webhook may now do.
 *
 *  Scoped to ONE recipe on every consumer that triggers it, with the prior
 *  snapshot NARROWED to that recipe (`consumersOfRecipe`) — given a consumer's
 *  whole snapshot, the reconcile would retire a sibling recipe's door as
 *  "not re-used". ⚠ `keepOwnerRevoked`: a door its owner revoked stays revoked;
 *  changing a setting is not the gesture that reopens it.
 *
 *  ⛔ The rows are CLEARED before the reconcile, as `replaceConsumer` leaves the
 *  rows of every other caller. These rows are not re-created, so a refusal would
 *  otherwise retire the door while its id stayed STAMPED — and D-295 reads a
 *  revoked door still stamped as one its OWNER shut, so every later save would
 *  keep it shut ("kept_revoked"), for good. The snapshot taken first still
 *  names the prior door: an unchanged door is re-stamped, an owner-revoked one
 *  is recognised. Synchronous end to end, so no delivery sees the cleared rows
 *  in between; a crash there leaves them door-less, which refuses (fail-closed)
 *  until the next save. */
export const followMainDishWebhookDoors = (
  input: { readonly recipe_id: string; readonly recipe: RecipeDefinition },
  deps: WebhookDoorEnrollDeps & {
    readonly consumerStore: Pick<
      WebhookConsumerStore,
      | 'stampTriggerContracts'
      | 'clearTriggerContracts'
      | 'doorContractIdForRecipe'
      | 'consumersOfRecipe'
    >;
  },
): DishWebhookDoorChange[] => {
  // ⚠ Never throws. The settings save already committed, so a door fault must
  // not report the save as failed; it degrades to the fail-closed state and says
  // so, as the install and save paths do around their own reconcile.
  let owners: ReturnType<WebhookConsumerStore['consumersOfRecipe']>;
  try {
    owners = deps.consumerStore.consumersOfRecipe(input.recipe_id);
  } catch (error) {
    console.warn(
      `[dish] webhook doors for '${input.recipe_id}' not re-derived: ${errorMessage(error)}`,
    );
    return [];
  }
  const recipeName = input.recipe.metadata?.name?.trim();
  const changes: DishWebhookDoorChange[] = [];
  for (const owner of owners) {
    // What the owner is told about: this recipe, and whether a live door let its
    // pushes through BEFORE this change ("now works" vs "what it may do changed").
    const subject: DoorChangeSubject = {
      recipe_id: input.recipe_id,
      ...(recipeName ? { recipe_name: recipeName } : {}),
      was_open: hadLiveDoor(owner.snapshot, deps),
    };
    let cleared = false;
    try {
      deps.consumerStore.clearTriggerContracts({
        consumer_kind: owner.consumer_kind,
        consumer_id: owner.consumer_id,
        recipe_id: input.recipe_id,
        publisher_id: owner.publisher_id,
      });
      cleared = true;
      const outcome = reconcileWebhookDoors(
        {
          consumer_kind: owner.consumer_kind,
          consumer_id: owner.consumer_id,
          prior: owner.snapshot,
          recipes: [{
            recipe_id: input.recipe_id,
            publisher_id: owner.publisher_id,
            recipe: input.recipe,
          }],
          mintedBy: 'dish_settings',
          retireReason: 'dish_settings_changed',
          keepOwnerRevoked: true,
        },
        deps,
      ).get(input.recipe_id);
      if (outcome !== undefined) changes.push(doorChangeOf(subject, outcome));
    } catch (error) {
      // Fail closed, and leave no live door behind. Once the rows are cleared,
      // every prior door is retired, as the reconcile's own supersession would
      // have done: either nothing was stamped (the rows stay door-less and every
      // delivery is refused), or a new door was, before the retire threw. Rows
      // the clear never reached keep their door, so nothing is retired under a
      // stamp (D-295 would read that as the owner's revoke).
      if (cleared) {
        try {
          retireWebhookDoors(snapshotDoorContractIds(owner.snapshot), 'dish_settings_changed', deps);
        } catch {
          // A live door that no row names is inert: authority attaches only
          // through a dispatch carrying its id.
        }
      }
      changes.push({ ...subject, state: 'closed', reason: errorMessage(error), reason_code: 'fault' });
    }
  }
  return changes;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type DoorChangeSubject = Pick<DishWebhookDoorChange, 'recipe_id' | 'recipe_name' | 'was_open'>;

/** Whether any door stamped on these rows was LIVE: the webhook let pushes
 *  through. Never throws (the follow must not): an unreadable store reads as
 *  "not open", which only words the notice. */
const hadLiveDoor = (
  snapshot: WebhookConsumerSnapshot,
  deps: Pick<MintDoorDeps, 'definitionStore'>,
): boolean => {
  try {
    return snapshotDoorContractIds(snapshot).some((contractId) => {
      const stored = deps.definitionStore.get(contractId);
      return stored !== null && (stored.revoked_at === undefined || stored.revoked_at === null);
    });
  } catch {
    return false;
  }
};

/** A refusal the owner can fix in these settings: a step's account slot
 *  (`{{config.<name>}}`) that names no account. Anything else is the recipe's. */
const reasonCodeOf = (refusal: RecipeCapabilityRefusal): 'no_account' | 'refused' =>
  refusal.reason === 'dynamic_connection' && /^\{\{\s*config\./.test(refusal.ref)
    ? 'no_account'
    : 'refused';

/** One reconcile outcome, as the owner-facing change the dish rpc returns. */
const doorChangeOf = (
  subject: DoorChangeSubject,
  outcome: WebhookDoorOutcome,
): DishWebhookDoorChange => {
  switch (outcome.kind) {
    case 'minted':
      return outcome.unchanged
        ? { ...subject, state: 'unchanged', operation_ids: [...outcome.operation_ids] }
        : {
            ...subject,
            state: 'opened',
            operation_ids: [...outcome.operation_ids],
            added: [...outcome.added],
            removed: [...outcome.removed],
          };
    case 'refused':
      return {
        ...subject,
        state: 'closed',
        reason: describeWebhookDoorRefusal(outcome.refusal),
        reason_code: reasonCodeOf(outcome.refusal),
      };
    case 'failed':
      return { ...subject, state: 'closed', reason: outcome.message, reason_code: 'fault' };
    case 'kept_revoked':
      return { ...subject, state: 'kept_revoked' };
  }
};
