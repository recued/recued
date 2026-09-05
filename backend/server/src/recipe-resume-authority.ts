/** Shared fresh-bearer requirements for any delayed recipe continuation.
 *
 * A paused anchor records which top-level grant justified the original run;
 * it does not make that grant permanent. Owner approvals and peer answers both
 * call this immediately before re-instantiating the saved recipe. */
import { MCP_INGREDIENT_TOOL_PREFIX, type Checkpoint } from '@recued/contracts';
import { hashRecipe } from '@recued/recipes';
import type { AuditEntry } from '@recued/storage';

import type { ExecuteHandlerDeps } from './execute-handler.js';
import { RUN_INGREDIENT_RECIPE } from './run-ingredient-recipe.js';

export const requiredResumeBearerToolNames = (
  checkpoint: Checkpoint,
  anchor: AuditEntry,
  executeDeps: ExecuteHandlerDeps,
): ReadonlyArray<string> | undefined => {
  const source = anchor.execution_source;
  if (!source) return undefined;

  const recipeId = checkpoint.recipe_id ?? anchor.recipe_id;
  const inlineRecipe = checkpoint.recipe_snapshot !== undefined;
  const recipe = checkpoint.recipe_snapshot ?? executeDeps.recipeStore.get(recipeId);
  const stored = inlineRecipe
    ? undefined
    : executeDeps.recipeStore.getStored?.(recipeId);
  const publisher =
    stored?.publisher_id
    ?? (recipe as { metadata?: { author?: unknown } } | null | undefined)
      ?.metadata?.author;
  const qualified =
    typeof publisher === 'string' && publisher.length > 0
      ? `${publisher}/${recipeId}`
      : undefined;

  if (
    source.channel === 'chat'
    && source.actor === 'contracted_user'
    && source.chat_session_id.startsWith('llm_gateway:')
  ) {
    // The LLM gateway exposes only pinned, store-resident Tier-2 recipes. An
    // inline snapshot cannot borrow a publisher-qualified grant by copying its
    // metadata.
    return !inlineRecipe && qualified ? [qualified] : [];
  }
  if (source.channel === 'mcp') {
    // A host-stamped exact grant cannot be substituted by generic recipe.run
    // after revocation.
    const grantedBy = anchor.granted_by_recipe;
    if (typeof grantedBy === 'string' && grantedBy.length > 0) return [grantedBy];
    if (recipeId === 'run-ingredient' && inlineRecipe) {
      if (hashRecipe(recipe) !== hashRecipe(RUN_INGREDIENT_RECIPE)) return [];
      const ingredient = checkpoint.approved_target?.ingredient_slug;
      return ingredient
        ? [`${MCP_INGREDIENT_TOOL_PREFIX}${ingredient}`]
        : [];
    }
    const names = new Set<string>(['recued_runRecipe', 'recipe.run']);
    if (!inlineRecipe && qualified) names.add(qualified);
    return [...names];
  }
  return undefined;
};
