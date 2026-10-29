import { KERNEL_OP_REGISTRY } from '@recued/contracts';
import { TRANSFORM_SCHEMAS } from '@recued/transforms';

export type RecipeStepGroup = 'steps' | 'prefetch_steps' | 'trigger_steps';

/** Registered recipe-callable kernels, restricted to their execution phase. */
export const recipeStepKernelOperations = (group: RecipeStepGroup) => KERNEL_OP_REGISTRY.filter(op => !op.native
  && (group === 'trigger_steps' ? op.domain === 'watch' : op.domain !== 'watch' && (group !== 'prefetch_steps' || op.risk === 'read')));

/** Prefetch contains calls only; the trigger gate must complete without waiting. */
export const recipeStepTransforms = (group: RecipeStepGroup) => Object.entries(TRANSFORM_SCHEMAS)
  .filter(([name]) => group !== 'prefetch_steps' && !(group === 'trigger_steps' && name === 'wait'));
