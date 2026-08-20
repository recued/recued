/** D-240 slice 3b — the gated runner behind `GET /reception/lookup/<secret>`.
 *
 *  The read-side sibling of `reception-recipe-runner.ts`. Same gate, same actor,
 *  same contract discipline; three differences, each forced:
 *
 *  1. IT OWNS NO SERVER-SIDE EFFECT. The submit runner opens a Seller order
 *     before the engine, which is why revocation has to stop the whole run
 *     there. Here there is nothing to stop — but the checks stay anyway, because
 *     a revoked door must not run a recipe at all, and "the snapshot would have
 *     floored it" is an argument about the gate's downstream, not about whether
 *     we should have dispatched.
 *
 *  2. ⛔⛔ NO IDEMPOTENCY ANCHOR. The submit runner passes
 *     `run_id: reception:<submission_id>` so a re-drive of the SAME submission
 *     collapses onto one run rather than re-firing its side effects. A status
 *     page is the exact opposite: the visitor refreshes it BECAUSE they want the
 *     current answer, and collapsing would serve them the first run's result
 *     forever. Every request is its own run.
 *
 *  3. ⚠ WHICH MAKES THIS A PUBLIC GET THAT EXECUTES A RECIPE, and the honest
 *     name for that is compute amplification. Three fences bound it and none is
 *     optional: the per-IP rate limit at the dispatcher, the door's persisted
 *     `DoorExecutionPolicy` (`max_steps`, and `allow_ai` which the owner must
 *     opt into at bind), and the concurrency caps below. The §3c bind refusal
 *     means it cannot be a WRITE amplifier, only a read one.
 *
 *  Spec: D-240 § D12 / D13. */

import {
  contractPermitsDoorType,
  isContractActive,
  type ExecutionSource,
  type RecipeDefinition,
} from '@recued/contracts';

import { handleExecute, type ExecuteHandlerDeps } from './execute-handler.js';
import { deriveResolvedRecipeCapability, type OpResolver } from './derive-recipe-capability.js';
import { doorCapabilityChanged } from './mint-door-contract.js';
import { resolveReceptionLookupDoorContractId } from './reception-lookup-door-bind.js';
import {
  buildReceptionContractSnapshot,
  grantedOperationsFor,
} from './reception-contract-snapshot.js';
import {
  analyzeReceptionRecipeCost,
  receptionDoorPolicyAdmits,
} from './reception-recipe-cost-policy.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';
import type { ReceptionLookupRecipePairStore } from './storage/reception-lookup-recipe-pair-store.js';
import type { DoorRecipeResolver } from './recipe-capability-wiring.js';
import type { ReceptionOutputBlock } from './ports/reception/handlers/reception-page-render.js';

/** ⚠ NO `held` ARM, and that is a claim the bind makes good on. §3c refuses a
 *  writing recipe on a responding door, and a lookup recipe always renders, so
 *  every op in a bound lookup door's closure is `read`. A hold would therefore
 *  mean the gate disagreed with the bind — reported as `failed` so it surfaces
 *  rather than rendering an empty page. */
export type ReceptionLookupRunOutcome =
  | {
      readonly kind: 'completed';
      readonly render: ReadonlyArray<ReceptionOutputBlock>;
      /** Did the recipe that produced these blocks run AI?
       *
       *  Drives the visitor-facing AI notice on the viewback page. Same source
       *  as the `allow_ai` policy check a few lines above — one analysis, so the
       *  page cannot claim AI on a run that used none, or stay silent on one
       *  that did.
       *
       *  ⛔ ONLY ON `completed`, and that is the whole distinction. A `failed`
       *  run falls back to the substrate-rendered status, so what the visitor
       *  reads was NOT produced by a model even if a model ran before the
       *  failure — and `no_door` ran no recipe at all. Carrying the flag on
       *  those branches would put an AI notice over text the substrate wrote. */
      readonly uses_ai: boolean;
    }
  /** No lookup recipe is bound to this endpoint. NOT an error — the caller falls
   *  back to the substrate-rendered status, which is what slice 3 shipped. */
  | { readonly kind: 'no_door' }
  | { readonly kind: 'failed'; readonly errors: ReadonlyArray<unknown> };

export interface ReceptionLookupRecipeRunnerDeps {
  readonly executeDeps: ExecuteHandlerDeps;
  readonly lookupPairStore: ReceptionLookupRecipePairStore;
  readonly definitionStore: ContractDefinitionStore;
  readonly resolveConfig: (recipeId: string) => Record<string, unknown> | undefined;
  readonly resolveRecipe: (recipeId: string) => RecipeDefinition | null;
  readonly resolveDoorRecipe?: DoorRecipeResolver;
  readonly resolveOp?: OpResolver;
  readonly resolveIngredientKind?: (ingredientSlug: string) => string | undefined;
  readonly resolveOpKinds?: () => ReadonlyMap<string, string>;
  readonly now: () => number;
  readonly maxConcurrentRunsGlobal?: number;
  readonly maxConcurrentRunsPerEndpoint?: number;
}

export interface ReceptionLookupRunInput {
  readonly endpoint_id: string;
  readonly record_id: string;
  /** The record's state, ALREADY PROJECTED for a visitor. ⛔ The sealed
   *  submission blob is deliberately NOT here: slice 3 established that a
   *  viewback shows what HAPPENED, not what was sent, and handing the recipe the
   *  visitor's answers would let an author render them back out — widening the
   *  receipt's one-time echo into a long-lived bearer page. */
  readonly record: Readonly<Record<string, unknown>>;
}

export interface ReceptionLookupRecipeRunner {
  run(input: ReceptionLookupRunInput): Promise<ReceptionLookupRunOutcome>;
}

/** ⚠ Lower than the submit runner's caps on purpose. A submit is one act by one
 *  person; a status page is refreshed, polled, and shared, so the same ceiling
 *  would let one widely-circulated link crowd out every other reception path. */
const DEFAULT_MAX_GLOBAL = 4;
const DEFAULT_MAX_PER_ENDPOINT = 2;

export class ReceptionLookupConcurrencyError extends Error {
  constructor(readonly scope: 'global' | 'endpoint') {
    super(`reception lookup is busy (${scope})`);
    this.name = 'ReceptionLookupConcurrencyError';
  }
}

export const createReceptionLookupRecipeRunner = (
  deps: ReceptionLookupRecipeRunnerDeps,
): ReceptionLookupRecipeRunner => {
  const maxGlobal = deps.maxConcurrentRunsGlobal ?? DEFAULT_MAX_GLOBAL;
  const maxPerEndpoint = deps.maxConcurrentRunsPerEndpoint ?? DEFAULT_MAX_PER_ENDPOINT;
  let activeGlobal = 0;
  const activeByEndpoint = new Map<string, number>();

  return {
    async run(input) {
      const pair = deps.lookupPairStore.findByEndpoint(input.endpoint_id);
      if (pair === null) return { kind: 'no_door' };

      const contract_id = resolveReceptionLookupDoorContractId(input.endpoint_id, deps);
      if (contract_id === null) return { kind: 'no_door' };

      const storedDoor = deps.definitionStore.get(contract_id);
      if (
        storedDoor === null
        || !isContractActive(storedDoor, deps.now())
        || !contractPermitsDoorType(storedDoor, 'reception')
      ) {
        return {
          kind: 'failed',
          errors: ['the viewback door is no longer active; ask the owner to re-bind it'],
        };
      }

      const recipe = deps.resolveRecipe(pair.recipe_id);
      if (recipe === null) {
        return { kind: 'failed', errors: [`viewback recipe '${pair.recipe_id}' is unavailable`] };
      }
      const config = deps.resolveConfig(pair.recipe_id);
      const dispatchRecipe = deps.resolveDoorRecipe?.(recipe, config ?? {})
        ?? { ok: true as const, recipe };
      if (!dispatchRecipe.ok) {
        return {
          kind: 'failed',
          errors: ['the viewback recipe binding changed; ask the owner to re-bind it'],
        };
      }

      const cost = analyzeReceptionRecipeCost(dispatchRecipe.recipe, {
        ...(deps.resolveIngredientKind === undefined
          ? {}
          : { resolveIngredientKind: deps.resolveIngredientKind }),
        ...(deps.resolveOpKinds === undefined ? {} : { resolveOpKinds: deps.resolveOpKinds }),
      });
      if (!cost.ok) {
        return { kind: 'failed', errors: ['the viewback recipe cannot run on a public door'] };
      }
      if (!receptionDoorPolicyAdmits(storedDoor.door_execution_policy, cost.profile)) {
        return {
          kind: 'failed',
          errors: [
            cost.profile.uses_ai
              ? 'the viewback recipe needs an owner AI-cost opt-in; re-bind it'
              : 'the viewback recipe has no valid per-run execution policy; re-bind it',
          ],
        };
      }

      // ⛔ AUTHORITY drift, not byte drift — the same check the submit runner
      // makes, deliberately. A recipe whose bytes moved without its capability
      // moving still runs: the owner consented to what it may DO, and re-asking
      // for a relabelled block is what makes a consent surface stop being read.
      if (deps.resolveDoorRecipe !== undefined) {
        const resolveOp = dispatchRecipe.resolveOp ?? deps.resolveOp;
        const derived = deriveResolvedRecipeCapability(recipe, dispatchRecipe.recipe, {
          ...(config === undefined ? {} : { config }),
          ...(resolveOp === undefined ? {} : { resolveOp }),
        });
        if (!derived.ok || doorCapabilityChanged(storedDoor, derived.capability).changed) {
          return {
            kind: 'failed',
            errors: ['the viewback recipe authority changed; ask the owner to re-bind it'],
          };
        }
      }

      const activeForEndpoint = activeByEndpoint.get(input.endpoint_id) ?? 0;
      if (activeForEndpoint >= maxPerEndpoint) {
        throw new ReceptionLookupConcurrencyError('endpoint');
      }
      if (activeGlobal >= maxGlobal) {
        throw new ReceptionLookupConcurrencyError('global');
      }
      activeGlobal += 1;
      activeByEndpoint.set(input.endpoint_id, activeForEndpoint + 1);

      try {
        // `anonymous`, as on the submit side: identity says WHO, contract_id says
        // UNDER WHAT AUTHORITY. A viewback visitor is no more identified than a
        // form submitter — they hold a bearer URL, which is not a claim about who
        // they are.
        const execution_source: ExecutionSource = {
          channel: 'reception',
          actor: 'anonymous',
          reception_id: input.endpoint_id,
          contract_id,
        };
        const contract_snapshot = buildReceptionContractSnapshot(execution_source, {
          definitionStore: deps.definitionStore,
          allowedTools: allowedToolsFor(deps.definitionStore),
          grantedOperations: grantedOperationsFor(deps.definitionStore),
          now: deps.now,
        });

        const result = await handleExecute(deps.executeDeps, {
          recipe_id: pair.recipe_id,
          context: { reception_lookup: { record: input.record } },
          ...(config === undefined ? {} : { config }),
          trigger_source: 'reception',
          execution_source,
          contract_snapshot,
        });

        if (!result.success) {
          // A hold here contradicts the §3c bind refusal (see the outcome type).
          // Reported rather than rendered as an empty page.
          return { kind: 'failed', errors: result.errors };
        }
        return {
          kind: 'completed',
          render: result.output.render ?? [],
          uses_ai: cost.profile.uses_ai,
        };
      } finally {
        activeGlobal -= 1;
        const remaining = (activeByEndpoint.get(input.endpoint_id) ?? 1) - 1;
        if (remaining <= 0) activeByEndpoint.delete(input.endpoint_id);
        else activeByEndpoint.set(input.endpoint_id, remaining);
      }
    },
  };
};

/** Byte-identical to the submit runner's helper, and that is the point: the
 *  door's tool allowlist comes from the SAME derivation the mint wrote its grant
 *  rows from, so the ACCESS and TOOL axes can never disagree. Two doors, one
 *  rule. */
const allowedToolsFor = (
  definitionStore: ContractDefinitionStore,
): ((contractId: string) => readonly string[]) => (contractId) =>
  definitionStore.get(contractId)?.scope?.ingredient_ids ?? [];
