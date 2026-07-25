/** The kernel `run-ingredient` recipe, inlined here because kernel
 *  recipes live in the extension's bundled registry (not the server's
 *  `recipeStore`). Every per-ingredient MCP tool — and, since D-177
 *  P2b, every chat Tier-3 outbound MCP dispatch — runs through this
 *  recipe, so the normal audit / cache / adapter-dispatch / commit-
 *  gateway path applies uniformly: there is no separate "run one
 *  ingredient" engine primitive. Kept synchronized with the JSON in
 *  community/recipes/run-ingredient.json by human discipline (the
 *  file is tiny and rarely changes).
 *
 *  PERMANENT KERNEL PRIMITIVE (D-182 "run-ingredient" close-out,
 *  2026-06-18). This recipe is the engine of the ingredient-keyed
 *  MCP/door tool catalog (one `recued_ingredient_<slug>` tool per
 *  installed ingredient); its single step dispatches a DYNAMIC
 *  `{{config.ingredient_slug}}`, which by construction cannot be a
 *  static `op:` step — so the D-182 op-step migration does NOT (and
 *  cannot) absorb it. It is NOT a straggler blocking any "drop the
 *  legacy `ingredient:` branch" cleanup: that branch is permanent
 *  infrastructure (it is the lowering target for every op-step and the
 *  dispatch engine for every kernel `core.*` op — see the comment at
 *  the simple-form branch in `packages/engine/src/step-runner.ts` and
 *  the corrected `docs/d-182-spec.md` §10.4).
 *
 *  Extracted from `mcp-server.ts` (D-177 P2b) so the chat Tier-3
 *  dispatch (`chat-tool-handlers.ts`) can route through the same
 *  recipe without importing the MCP server module. */

import type { RecipeDefinition } from '@recued/contracts';

export const RUN_INGREDIENT_RECIPE: Readonly<RecipeDefinition> = Object.freeze({
  recipe_id: 'run-ingredient',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Run Ingredient',
    description: 'Kernel recipe dispatched by every MCP per-ingredient tool.',
    author: 'recued',
    supported_platforms: [],
    tags: ['kernel', 'mcp'],
  },
  variables: { ingredient_slug: null, input: {} },
  prefetch_steps: [],
  steps: [
    {
      id: 'call',
      ingredient: '{{config.ingredient_slug}}',
      input: '{{config.input}}',
    } as unknown as import('@recued/contracts').RecipeStep,
  ],
  output: { render: [{ type: 'summary', source: 'step.call' }] },
}) as unknown as RecipeDefinition;
