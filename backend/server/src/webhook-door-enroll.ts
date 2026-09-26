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

import type { RecipeDefinition } from '@recued/contracts';

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
