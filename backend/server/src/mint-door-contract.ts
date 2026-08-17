/** D-207 slice 1b / D-209 #1 — minting a DERIVED door contract.
 *
 *  One `contract_definition` per door, whose `ContractScope` IS the capability (§5.1d —
 *  there is no separate `capability_hash`; the stored scope is the pin), plus one
 *  `contract_grant` row per derived op. Two doors mint here: `reception` (at pair BIND)
 *  and `webhook` (at enrollment — the owner wires a vendor webhook to a recipe). Both
 *  are DERIVED doors: never hand-authored (`AUTHORABLE_DOOR_TYPES` excludes them), scope
 *  computed by `deriveRecipeCapability`, id carried by the pair/trigger row.
 *
 *  ## The four things this must get right, each of which fails silently if missed
 *
 *  1. **The closure must be COMPLETE.** An ungranted op is a HARD DENY, not a hold — so an
 *     under-derived closure kills the visitor's submission mid-run AND makes the owner's
 *     "this form may: …" list a lie. `deriveRecipeCapability` refuses rather than skips,
 *     and a refusal must abort the BIND/enrollment, never reach a fire.
 *
 *  2. **`door_types` is load-bearing, not a label.** It is what makes
 *     `usesExplicitOnlyGrantDefaults` return true for this contract — DENY-BY-DEFAULT.
 *     Without it, a recipe with an EMPTY op closure (a pure-transform validate-and-render
 *     recipe) is read by `opAuthorDefault` as a WILDCARD door and admitted ANY op.
 *
 *  3. **`grant_kind` must be OMITTED.** `MintContractInput` only accepts
 *     `'customer_template'`; omission IS standing (`isStandingContractDefinition` admits
 *     absent / null / `'standing'`). Anything else and `gateGrantGoverningContractId`
 *     refuses to let the contract govern — the door would silently fall to the
 *     `PUBLIC_CONTRACT_ID` floor, which grants nothing, so every submission would fail.
 *     Fail-closed, but for entirely the wrong reason, and near-impossible to debug.
 *
 *  4. **The grant rows are the actual authority; the scope alone grants NOTHING.** The
 *     ACCESS gate reads `contract_grant` rows. The scope is the pin the upgrade diff
 *     compares against. Both, or the door denies everything.
 *
 *  ## The per-door trust ceiling (D-209 #1)
 *
 *  A `webhook` door mints with `max_risk_without_approval: 'admin'` — a machine endpoint
 *  the owner wired on BOTH sides (enabled on Recued AND pasted in the vendor console);
 *  the two-sided enrollment IS the standing approval, so a granted op admits without a
 *  per-call hold (D-209 §1.4). A `reception` door NEVER carries the field: a public form
 *  is human-facing and prompt-injectable, and `resolveTrustCeiling` pins an `anonymous`
 *  reception dispatch at `read` regardless (the rev-5 F3 rule) — the omission here and
 *  the reader's pin are two fences over the same hole.
 *
 *  ## The id is MINTED, not derived
 *
 *  `ContractDefinitionStore.mint()` generates the `contract_id`; there is no `put` /
 *  `upsert`. So the door's id cannot be `f(recipe_id)` — the PAIR/TRIGGER ROW carries it,
 *  which is exactly the `reception_id → pair → contract_id` (or `trigger →
 *  contract_id`) hop the dispatch needs anyway. A capability change therefore REPLACES
 *  the door: revoke the old contract (its grant rows die with it at the gate, since
 *  `gateGrantGoverningContractId` refuses a revoked def), mint a new one, and re-point
 *  the row.
 *
 *  ## Re-bind = the upgrade diff (§5.1b)
 *
 *  The grant is pinned to the CAPABILITY, never to a content hash (which moves on every
 *  cosmetic edit). A re-bind re-derives the scope and compares it to the stored one:
 *  identical ⇒ **silent**; different ⇒ the owner is re-prompted, and the **diff IS the
 *  prompt** ("adds: mail-send"). {@link doorCapabilityChanged} is that comparison.
 *
 *  Spec: D-207 §5.1b / §5.1d / §5.2; D-209 §1.4. */

import {
  opGrantEntry,
  type ContractDefinition,
  type DoorExecutionPolicy,
} from '@recued/contracts';

import type { RecipeCapability } from './derive-recipe-capability.js';
import { DEFAULT_RECEPTION_DOOR_EXECUTION_POLICY } from './reception-recipe-cost-policy.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';

export interface MintDoorDeps {
  readonly definitionStore: ContractDefinitionStore;
  readonly grantEntryStore: ContractGrantEntryStore;
  readonly now: () => number;
}

/** The two DERIVED doors this module may mint, and what differs between them.
 *  A closed table, not parameters: the ceiling is a per-door-CLASS ruling
 *  (D-209 §1.4), never caller input. */
const DOOR_MINT_PROFILES = {
  reception: {
    display: 'Reception door',
    channel: 'reception',
    /** No authored ceiling — and the reader pins `anonymous` reception at
     *  `read` even if a row somehow carried one. */
    max_risk_without_approval: undefined,
  },
  webhook: {
    display: 'Webhook door',
    channel: 'webhook',
    /** Two-sided enrollment IS the standing approval (D-209 §1.4): a granted
     *  op admits; destructive still holds (`admin` can't relax `always`). */
    max_risk_without_approval: 'admin' as const,
  },
} as const;

export type MintableDoorType = keyof typeof DOOR_MINT_PROFILES;

/** The authority diff between a door's STORED capability and a freshly derived one.
 *
 *  This — not a content hash — decides whether to re-prompt the owner. Returns what was
 *  ADDED and REMOVED so the caller can render the diff as the consent prompt itself,
 *  rather than a bare "something changed, approve again?" that trains the owner to click
 *  through without reading.
 *
 *  ⛔ A capability is ALL THREE persisted scope axes, not just its operations. The
 *  snapshot's tool gate reads `ingredient_ids`, and contract scope matching reads
 *  `connection_names`. Reusing a door after either one moved leaves the old scope linked
 *  to the new recipe: the next dispatch then hard-denies (or keeps a stale account pin)
 *  even though bind reported `unchanged`. Operation ids remain unprefixed for the existing
 *  owner copy; the other axes are named explicitly so the consent list cannot make an
 *  ingredient or account change look like an operation. */
export const doorCapabilityChanged = (
  stored: ContractDefinition | null,
  derived: RecipeCapability,
  desiredExecutionPolicy?: DoorExecutionPolicy,
): { readonly changed: boolean; readonly added: string[]; readonly removed: string[] } => {
  const added: string[] = [];
  const removed: string[] = [];
  const diffAxis = (
    beforeValues: readonly string[],
    afterValues: readonly string[],
    label: (value: string) => string,
  ): void => {
    const before = new Set(beforeValues);
    const after = new Set(afterValues);
    for (const value of after) {
      if (!before.has(value)) added.push(label(value));
    }
    for (const value of before) {
      if (!after.has(value)) removed.push(label(value));
    }
  };

  diffAxis(
    stored?.scope?.operation_ids ?? [],
    derived.operation_ids,
    (operation) => operation,
  );
  diffAxis(
    stored?.scope?.ingredient_ids ?? [],
    derived.ingredient_ids,
    (ingredient) => `ingredient:${ingredient}`,
  );
  diffAxis(
    stored?.scope?.connection_names ?? [],
    derived.connection_names,
    (connection) => `connection:${connection}`,
  );

  let executionPolicyChanged = false;
  if (desiredExecutionPolicy !== undefined) {
    const before = stored?.door_execution_policy;
    if (before === undefined) {
      // A legacy/missing policy is unbounded for this purpose. Adding the fixed step ceiling
      // is a narrowing and therefore needs no owner prompt; AI is a distinct positive opt-in.
      executionPolicyChanged = true;
      if (desiredExecutionPolicy.allow_ai) added.push('cost:ai');
    } else {
      if (before.allow_ai !== desiredExecutionPolicy.allow_ai) {
        executionPolicyChanged = true;
        (desiredExecutionPolicy.allow_ai ? added : removed).push('cost:ai');
      }
      if (before.max_steps !== desiredExecutionPolicy.max_steps) {
        executionPolicyChanged = true;
        const label = `cost:max-steps:${desiredExecutionPolicy.max_steps}`;
        if (before.max_steps < desiredExecutionPolicy.max_steps) added.push(label);
        else removed.push(`cost:max-steps:${before.max_steps}`);
      }
    }
  }

  added.sort();
  removed.sort();
  return {
    changed: added.length > 0 || removed.length > 0 || executionPolicyChanged,
    added,
    removed,
  };
};

/** Mint a fresh door contract + its grant rows. Returns the minted `contract_id`, which
 *  the caller MUST persist on the pair/trigger row — it is the only way back from a
 *  dispatch's endpoint to its authority. */
export const mintDoorContract = (
  input: {
    readonly door: MintableDoorType;
    readonly recipeId: string;
    readonly capability: RecipeCapability;
    readonly mintedBy: string;
    /** Reception only. Omit for the fail-closed no-AI default; webhook doors do not consume
     *  this policy because their machine-trigger cost posture is separate. */
    readonly doorExecutionPolicy?: DoorExecutionPolicy;
    /** The owner's standing-closure opt-in, carried from the bind. Reception
     *  only — a webhook door consumes no execution policy. Absent ⇒ off, which
     *  is what every door minted before this field gets. */
    readonly standingClosure?: boolean;
  },
  deps: MintDoorDeps,
): { readonly contract_id: string } => {
  const ts = deps.now();
  const profile = DOOR_MINT_PROFILES[input.door];
  const basePolicy = input.door === 'reception'
    ? input.doorExecutionPolicy ?? DEFAULT_RECEPTION_DOOR_EXECUTION_POLICY
    : undefined;
  // ⚠ The flag rides the door's EXISTING policy object rather than a new
  // column: `allow_ai` is already a per-door owner opt-in resolved at bind, and
  // a second home for the same kind of decision is how the two drift.
  const doorExecutionPolicy = basePolicy === undefined
    ? undefined
    : input.standingClosure === true
      ? { ...basePolicy, standing_closure: true }
      : basePolicy;

  const def = deps.definitionStore.mint({
    minted_by: input.mintedBy,
    display_name: `${profile.display} — ${input.recipeId}`,
    // `grant_kind` DELIBERATELY OMITTED (note 3): omission is standing. Passing anything
    // else makes the contract non-governing and the door silently dies.
    scope: {
      channels: [profile.channel],
      actors: ['anonymous'],
      operation_ids: [...input.capability.operation_ids],
      ingredient_ids: [...input.capability.ingredient_ids],
      connection_names: [...input.capability.connection_names],
    },
    ...(doorExecutionPolicy === undefined
      ? {}
      : { door_execution_policy: doorExecutionPolicy }),
    // Load-bearing (note 2) — this is what makes the door deny-by-default.
    door_types: [input.door],
    // D-209 #1 — the per-door-class ceiling; landed only for the doors whose
    // profile authors one (webhook), omitted otherwise.
    ...(profile.max_risk_without_approval !== undefined
      ? { max_risk_without_approval: profile.max_risk_without_approval }
      : {}),
  } as Parameters<ContractDefinitionStore['mint']>[0]);

  // The mint FOLD — one explicit `granted: true` row per derived op. This is what the
  // ACCESS gate actually reads (note 4). Mirrors `contract-handler.ts`'s fold so the two
  // paths can never drift.
  for (const opId of input.capability.operation_ids) {
    deps.grantEntryStore.set(def.contract_id, opGrantEntry(opId), true, ts);
  }

  return { contract_id: def.contract_id };
};

/** Retire a door: revoke its contract. Its grant rows stop governing immediately —
 *  `gateGrantGoverningContractId` refuses a revoked definition, so the dispatch falls to
 *  the `PUBLIC_CONTRACT_ID` floor (which grants nothing) rather than to "contract-free"
 *  (which would skip the gate entirely). Unbinding therefore CLOSES the door rather
 *  than opening it — the property §5.1's floor exists to guarantee. */
export const retireDoorContract = (
  contractId: string,
  reason: string,
  deps: Pick<MintDoorDeps, 'definitionStore'>,
): void => {
  deps.definitionStore.revoke(contractId, reason);
};
