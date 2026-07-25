/** § 7 surfacing slice — `recipe.pii` rpc handler.
 *
 *  The Kitchen-side read over the auto-PII substrate: for every known
 *  recipe (stored wins over bundled — the same enumeration as
 *  `recipe.list`), the posture summary the dispatch seam implies — which
 *  AI steps Recued auto-protects at run time, which still need the
 *  author's hand, and the validator's standing findings. Backs the
 *  webclient recipes view's per-recipe PII line.
 *
 *  Recomputed-on-read like `recipe.runnability`: the trace is a pure
 *  static walk (no model calls, no IO), so a classifier-curation change
 *  shipped in a server release is reflected on the next read with nothing
 *  persisted to go stale. ~165 recipes × a few JSON walks per call —
 *  cheap enough for a route-mount read.
 *
 *  Entries with nothing to disclose are omitted (absence = clean).
 *  DISCLOSURE only — the § 7 dispatch seam rewrites at run time
 *  regardless of who reads this. Per-pair / local-UI only; NOT in
 *  `MCP_TOOL_CATALOG` (PII flow topology stays off the MCP-channel agent
 *  surface; agents get the posture for recipes THEY save via the
 *  `recued_saveRecipe` result). */

import type {
  HandlerSlice,
  RecipePiiDisclosureEntry,
  ServerRpcRegistry,
} from '@recued/contracts';
import { assessRecipePiiPosture } from './auto-pii-apply.js';
import type { RecipeStore } from './recipe-store.js';
import type { WsClient } from './ws-server.js';

export interface RecipePiiHandlerDeps {
  store: RecipeStore;
}

export const listRecipePiiPostures = (
  deps: RecipePiiHandlerDeps,
): { recipes: RecipePiiDisclosureEntry[] } => {
  const out: RecipePiiDisclosureEntry[] = [];
  const seen = new Set<string>();

  // SQLite-stored wins on conflict, bundled fills the rest — mirrors
  // `listServerRecipes` so the posture lines key onto exactly the recipe
  // versions the recipes view lists.
  for (const row of deps.store.listStored()) {
    seen.add(row.recipe_id);
    const summary = assessRecipePiiPosture(JSON.parse(row.recipe_json));
    if (summary !== null) out.push({ recipe_id: row.recipe_id, summary });
  }
  for (const id of deps.store.ids()) {
    if (seen.has(id)) continue;
    const recipe = deps.store.get(id);
    if (!recipe) continue;
    const summary = assessRecipePiiPosture(recipe);
    if (summary !== null) out.push({ recipe_id: id, summary });
  }

  out.sort((a, b) => a.recipe_id.localeCompare(b.recipe_id));
  return { recipes: out };
};

export type RecipePiiMethods = 'recipe.pii';

export const makeRecipePiiHandlers = (
  deps: RecipePiiHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, RecipePiiMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['recipe.pii'],
    handlers: {
      'recipe.pii': async () => listRecipePiiPostures(deps),
    },
  };
};
