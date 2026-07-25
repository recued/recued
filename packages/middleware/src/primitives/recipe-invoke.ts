/** D-145 PB3 — `recipe.invoke` primitive.
 *
 *  Per § B.1 row 8. Calls the existing recipe engine for sub-tasks
 *  (e.g. scheduled-puller invocation, sub-recipe composition). The
 *  primitive is a thin shim — caller-supplied `RecipeInvokeAdapter`
 *  routes through the existing `executeRecipe` entry point so PB3
 *  doesn't pull the recipe-engine dependency graph into the
 *  primitive layer.
 *
 *  Dry Run discipline (§ B.5.4): when `ctx.preview === true`, the
 *  primitive records `preview_no_op` status WITHOUT invoking the
 *  sub-recipe. No live caller wires the orchestrator to surface
 *  preview divergence yet.
 *
 *  Privacy: `args_summary` carries recipe slug + input keys —
 *  never raw input values.
 *
 *  Spec: § B.1 + § B.5.4. */

import {
  buildPrimitiveCall,
  projectAdapterDetailForAudit,
  projectErrorClass,
  resolveMintCallId,
  resolveNow,
  type EnginePrimitive,
  type PrimitiveExecuteContext,
  type PrimitiveExecuteResult,
} from './types.js';

export interface RecipeInvokeRequest {
  recipe_slug: string;
  recipe_version?: number;
  /** Per-recipe input bag. Adapter routes through `executeRecipe`. */
  inputs?: Record<string, unknown>;
}

export interface RecipeInvokeResult {
  /** True when every step succeeded. */
  success: boolean;
  /** The recipe engine's result. PB7 broker is responsible for
   *  content-class gating before any of this reaches AI / memory. */
  outputs?: Record<string, unknown>;
  /** Audit-friendly summary — never raw step outputs. */
  step_summary?: string;
  /** Detail string when `success === false`. */
  detail?: string;
}

export interface RecipeInvokeAdapter {
  invoke(request: RecipeInvokeRequest): Promise<RecipeInvokeResult>;
}

export interface RecipeInvokePrimitiveDeps {
  adapter: RecipeInvokeAdapter;
}

export interface RecipeInvokePrimitiveInput extends RecipeInvokeRequest {}
export interface RecipeInvokePrimitiveOutput extends RecipeInvokeResult {}

const summarizeRequest = (req: RecipeInvokeRequest): string => {
  const parts: string[] = [`recipe=${req.recipe_slug}`];
  if (req.recipe_version !== undefined) parts.push(`v=${req.recipe_version}`);
  if (req.inputs && Object.keys(req.inputs).length > 0) {
    parts.push(`input_keys=${Object.keys(req.inputs).sort().join(',')}`);
  }
  return parts.join(' ');
};

export const createRecipeInvokePrimitive = (
  deps: RecipeInvokePrimitiveDeps,
): EnginePrimitive<RecipeInvokePrimitiveInput, RecipeInvokePrimitiveOutput> => {
  return {
    primitive: 'recipe.invoke',
    async execute(input, ctx): Promise<PrimitiveExecuteResult<RecipeInvokePrimitiveOutput>> {
      const now = resolveNow(ctx);
      const mintId = resolveMintCallId(ctx);
      const started_at = now();
      const call_id = mintId();

      // PB13 Dry Run: skip the adapter, record preview_no_op.
      if (ctx.preview) {
        const completedAt = now();
        return {
          result: { success: true, step_summary: 'preview_no_op' },
          call: buildPrimitiveCall({
            primitive: 'recipe.invoke',
            call_id,
            args_summary: `preview ${summarizeRequest(input)}`,
            outcome_summary: 'preview no execution',
            status: 'preview_no_op',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      }

      try {
        const result = await deps.adapter.invoke(input);
        const completedAt = now();
        const safeStepSummary = projectAdapterDetailForAudit(result.step_summary);
        return {
          result,
          call: buildPrimitiveCall({
            primitive: 'recipe.invoke',
            call_id,
            args_summary: summarizeRequest(input),
            outcome_summary: `success=${result.success}${safeStepSummary ? ` ${safeStepSummary}` : ''}`,
            status: result.success ? 'ok' : 'error',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      } catch (e) {
        const completedAt = now();
        return {
          result: { success: false, detail: projectErrorClass(e) },
          call: buildPrimitiveCall({
            primitive: 'recipe.invoke',
            call_id,
            args_summary: summarizeRequest(input),
            outcome_summary: `error ${projectErrorClass(e)}`,
            status: 'error',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      }
    },
  };
};
