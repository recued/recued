import type { RecipeDefinition, RecipeStep } from '@recued/contracts';

/** D-221 §3.3.3 — the literal, host-owned refusal required before a Records
 * recipe can be made reachable by anyone other than the local owner. */
export const RECORDS_NON_OWNER_CONTRACT_REFUSAL =
  '{{context.caller.contract_id}} is_null' as const;

export type RecordsNonOwnerExposureSurface = 'mcp' | 'reception' | 'webhook';

export class RecordsNonOwnerExposureError extends Error {
  readonly code = 'records_non_owner_exposure_refused' as const;

  constructor(
    readonly recipe_id: string,
    readonly surface: RecordsNonOwnerExposureSurface,
    detail: string,
  ) {
    super(
      `Records recipe '${recipe_id}' cannot be exposed through ${surface}: ${detail}`,
    );
    this.name = 'RecordsNonOwnerExposureError';
  }
}

export interface RecordsInstalledOperationInventory {
  isOperationId(operationId: string): boolean;
  isCatalogOperation(catalogSlug: string, operationKey: string): boolean;
}

const stepOp = (step: unknown): string | null => {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) return null;
  const op = (step as Record<string, unknown>).op;
  return typeof op === 'string' ? op : null;
};

/** Detect Records use from the exact installed operation inventory. No tag,
 * recipe metadata, caller argument, or author-controlled prefix can opt a
 * recipe in or out of this boundary. */
export const recipeUsesInstalledRecordsOperation = (
  recipe: Pick<RecipeDefinition, 'trigger_steps' | 'prefetch_steps' | 'steps'>,
  inventory: RecordsInstalledOperationInventory,
): boolean => {
  for (const step of [
    ...(recipe.trigger_steps ?? []),
    ...(recipe.prefetch_steps ?? []),
    ...(recipe.steps ?? []),
  ]) {
    const op = stepOp(step);
    if (op !== null && inventory.isOperationId(op)) return true;
    if (step !== null && typeof step === 'object' && !Array.isArray(step)) {
      const shaped = step as unknown as Record<string, unknown>;
      const input = shaped.input;
      if (typeof shaped.ingredient === 'string'
        && input !== null && typeof input === 'object' && !Array.isArray(input)
        && typeof (input as Record<string, unknown>).operation === 'string'
        && inventory.isCatalogOperation(
          shaped.ingredient,
          (input as Record<string, unknown>).operation as string,
        )) {
        return true;
      }
    }
  }
  return false;
};

const isPureTransform = (step: RecipeStep): boolean => {
  const value = step as unknown as Record<string, unknown>;
  return typeof value.transform === 'string'
    && !('ingredient' in value)
    && !('op' in value)
    && !('guard' in value);
};

/** Enforce D-221 §3.3 at the act of exposure, rather than at diffuse recipe
 * authoring. The refusal must be the first executable work: prefetch/trigger
 * phases would otherwise run before `steps[0]`, and `fail_on` is evaluated
 * after its step, so the gate step itself must be a side-effect-free transform. */
export const assertRecordsNonOwnerRecipeExposure = (
  recipe: RecipeDefinition,
  surface: RecordsNonOwnerExposureSurface,
  inventory: RecordsInstalledOperationInventory,
): void => {
  if (!recipeUsesInstalledRecordsOperation(recipe, inventory)) return;

  const refuse = (detail: string): never => {
    throw new RecordsNonOwnerExposureError(recipe.recipe_id, surface, detail);
  };

  if ((recipe.trigger_steps?.length ?? 0) !== 0) {
    refuse('trigger_steps would execute before the required contract refusal');
  }
  if ((recipe.prefetch_steps?.length ?? 0) !== 0) {
    refuse('prefetch_steps would execute before the required contract refusal');
  }

  const first = recipe.steps[0];
  if (first === undefined) refuse('the recipe has no first step');
  if (first.skip_when !== undefined) {
    refuse('the first step uses skip_when; silent success is not an authority refusal');
  }
  if (first.fail_on !== RECORDS_NON_OWNER_CONTRACT_REFUSAL) {
    refuse(
      `the first step must use fail_on: "${RECORDS_NON_OWNER_CONTRACT_REFUSAL}"`,
    );
  }
  if (!isPureTransform(first)) {
    refuse('the first-step refusal must be a side-effect-free transform');
  }
};
