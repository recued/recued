/** Launch boundary for anonymous reception-driven recipe work.
 *
 * Request buckets bound how often a visitor can submit; they do not bound what one accepted
 * submit spends. This profile makes that second dimension static and reviewable:
 *
 *  - at most 64 authored steps across every recipe phase;
 *  - no `foreach` fan-out (one authored step therefore executes at most once);
 *  - every dispatch kind must be resolvable; and
 *  - AI is identified explicitly so bind can require and persist an owner opt-in.
 *
 * The same function runs at bind AND immediately before dispatch. Bind gives the owner an
 * actionable refusal/consent moment; the runtime check closes legacy doors and recipe drift.
 */

import {
  getKernelOp,
  type DoorExecutionPolicy,
  type RecipeDefinition,
} from '@recued/contracts';

export const RECEPTION_RECIPE_MAX_STEPS = 64;

export const DEFAULT_RECEPTION_DOOR_EXECUTION_POLICY: DoorExecutionPolicy = Object.freeze({
  max_steps: RECEPTION_RECIPE_MAX_STEPS,
  allow_ai: false,
});

export interface ReceptionRecipeCostResolvers {
  /** Installed ingredient slug → manifest kind. */
  readonly resolveIngredientKind?: (ingredientSlug: string) => string | undefined;
  /** One live snapshot of non-kernel canonical op id → installed catalog kind. The
   *  analyzer resolves it lazily and at most once, even when a recipe has many op steps. */
  readonly resolveOpKinds?: () => ReadonlyMap<string, string>;
}

export type ReceptionRecipeCostRefusal =
  | {
      readonly reason: 'cost_step_limit';
      readonly step_id: '<recipe>';
      readonly steps: number;
      readonly max_steps: number;
    }
  | {
      readonly reason: 'cost_dynamic_fanout';
      readonly step_id: string;
    }
  | {
      readonly reason: 'cost_unknown_dispatch_kind';
      readonly step_id: string;
      readonly target: string;
    };

export interface ReceptionRecipeCostProfile {
  readonly step_count: number;
  readonly uses_ai: boolean;
  readonly ai_steps: readonly string[];
}

export type ReceptionRecipeCostAnalysis =
  | { readonly ok: true; readonly profile: ReceptionRecipeCostProfile }
  | { readonly ok: false; readonly refusal: ReceptionRecipeCostRefusal };

const allSteps = (recipe: RecipeDefinition): ReadonlyArray<Record<string, unknown>> => [
  ...((recipe.prefetch_steps ?? []) as unknown as Record<string, unknown>[]),
  ...((recipe.steps ?? []) as unknown as Record<string, unknown>[]),
  ...((recipe.trigger_steps ?? []) as unknown as Record<string, unknown>[]),
];

const stepId = (step: Record<string, unknown>): string =>
  typeof step.id === 'string' && step.id.length > 0 ? step.id : '<unnamed>';

/** Analyze one exact recipe snapshot under the public-reception cost posture. */
export const analyzeReceptionRecipeCost = (
  recipe: RecipeDefinition,
  resolvers: ReceptionRecipeCostResolvers = {},
): ReceptionRecipeCostAnalysis => {
  const steps = allSteps(recipe);
  if (steps.length > RECEPTION_RECIPE_MAX_STEPS) {
    return {
      ok: false,
      refusal: {
        reason: 'cost_step_limit',
        step_id: '<recipe>',
        steps: steps.length,
        max_steps: RECEPTION_RECIPE_MAX_STEPS,
      },
    };
  }

  const aiSteps = new Set<string>();
  let opKinds: ReadonlyMap<string, string> | undefined;
  for (const step of steps) {
    const id = stepId(step);
    if (step.foreach !== undefined && step.foreach !== null) {
      return { ok: false, refusal: { reason: 'cost_dynamic_fanout', step_id: id } };
    }

    const op = step.op;
    if (typeof op === 'string' && op.length > 0) {
      // `core.ai.*` is a closed kernel namespace. A stale/retired non-AI core op may be
      // unrunnable, but it cannot secretly become AI; non-kernel pack ops require the live
      // installed-catalog resolver because their kind is not encoded in the id.
      const kind = getKernelOp(op)?.domain
        ?? (op.startsWith('core.') ? (op.startsWith('core.ai.') ? 'ai' : 'kernel') : undefined)
        ?? (opKinds ??= resolvers.resolveOpKinds?.())?.get(op);
      if (kind === undefined) {
        return {
          ok: false,
          refusal: { reason: 'cost_unknown_dispatch_kind', step_id: id, target: op },
        };
      }
      if (kind === 'ai') aiSteps.add(id);
    }

    const ingredient = step.ingredient;
    if (typeof ingredient === 'string' && ingredient.length > 0) {
      const kind = resolvers.resolveIngredientKind?.(ingredient);
      if (kind === undefined) {
        return {
          ok: false,
          refusal: {
            reason: 'cost_unknown_dispatch_kind',
            step_id: id,
            target: ingredient,
          },
        };
      }
      if (kind === 'ai') aiSteps.add(id);
    }
  }

  return {
    ok: true,
    profile: {
      step_count: steps.length,
      uses_ai: aiSteps.size > 0,
      ai_steps: [...aiSteps],
    },
  };
};

/** The exact policy a successful reception bind persists on its door contract. */
export const receptionDoorExecutionPolicy = (
  profile: ReceptionRecipeCostProfile,
): DoorExecutionPolicy => ({
  max_steps: RECEPTION_RECIPE_MAX_STEPS,
  allow_ai: profile.uses_ai,
});

/** Fail-closed runtime validation of a stored policy against the current recipe snapshot. */
export const receptionDoorPolicyAdmits = (
  policy: DoorExecutionPolicy | undefined,
  profile: ReceptionRecipeCostProfile,
): boolean =>
  policy !== undefined
  && Number.isSafeInteger(policy.max_steps)
  && policy.max_steps >= 1
  && policy.max_steps <= RECEPTION_RECIPE_MAX_STEPS
  && profile.step_count <= policy.max_steps
  && (!profile.uses_ai || policy.allow_ai === true);
