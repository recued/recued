/** D-119 Phase 5 — `recipe.list` rpc handler.
 *
 *  Returns every recipe the server knows about (bundled + pair-synced)
 *  so the extension's server-scope sidebar can render the list. The
 *  in-memory `register()` overrides are excluded — they're test / inline-
 *  execute artefacts, not durably installed recipes.
 *
 *  The bundled recipes don't carry their own `installed_at` or hash on
 *  disk, so we synthesize:
 *    - `installed_at = serverStartedAt` (the server's first-seen time)
 *    - `recipe_hash  = hashRecipe(recipe)` lazily on each list call
 *    - `publisher_id = recipe.publisher_id ?? 'recued-core'` (bundled
 *       defaults — they ship inside the server binary and are
 *       authoritative regardless of who else publishes them)
 *
 *  Pair-synced recipes return their stored values verbatim.
 *
 *  ⛔⛔ KERNEL RECIPES (`metadata.author === 'recued'`) ARE EXCLUDED. They are
 *  runtime-bundled implementation detail per `RESERVED_HANDLES` — the MCP
 *  per-ingredient dispatcher, the memory embedder, the work-entity sync — and
 *  CLAUDE.md's publisher table says the `recued` namespace is *"invisible in
 *  marketplace / install / manage UI"*. `#recipes` IS the manage UI.
 *
 *  🔑 THE RULE ALREADY EXISTED AT TWO OTHER DOORS OVER THIS SAME STORE and was
 *  missing only here: `chat-tool-handlers.ts` skips them when building the Tier-2
 *  catalog (*"never surface in the marketplace / chat catalog"*) and
 *  `mcp-server.ts` skips them when resolving a recipe tool. One store, three
 *  readers, the rule at two of them — so the recipes reached the one surface a
 *  human actually looks at. */

/** ⛔ THE MARKER IS `metadata.author`, NOT `publisher_id`. `RecipeDefinition` has
 *  no publisher field at all, and the bundled branch below HARDCODES
 *  `publisher_id: 'recued-core'` — so a filter on the emitted publisher would
 *  match nothing and read as if it were working. */
const isKernelRecipe = (recipe: { metadata?: { author?: string } } | undefined): boolean =>
  recipe?.metadata?.author === 'recued';

import { hashRecipe } from '@recued/recipes';
import {
  type HandlerSlice,
  type ServerRecipeListEntry,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { RecipeStore } from './recipe-store.js';
import type { WsClient } from './ws-server.js';

export interface RecipeListHandlerDeps {
  store: RecipeStore;
  /** Epoch ms — the server process's startup time. Used as the
   *  fallback `installed_at` for bundled recipes that don't track
   *  their own first-seen time. */
  serverStartedAt: number;
}

/** Shape used internally so the bundled-vs-stored branches converge
 *  on one return type before the rpc envelope wraps it. */
type ListEntry = ServerRecipeListEntry;

export const listServerRecipes = (
  deps: RecipeListHandlerDeps,
): { recipes: ListEntry[] } => {
  const seen = new Set<string>();
  const out: ListEntry[] = [];

  // SQLite-stored (pair-sync / imported) wins on conflict — those are
  // the user's chosen versions, bundled is the fallback.
  for (const row of deps.store.listStored()) {
    seen.add(row.recipe_id);
    const recipe = JSON.parse(row.recipe_json);
    // ⚠ A kernel recipe should never reach the stored table — it is not in
    // `installRegistry` — but the same rule applies if one ever does, and marking
    // it `seen` above still stops the bundled copy re-adding it.
    if (isKernelRecipe(recipe)) continue;
    out.push({
      recipe_id: row.recipe_id,
      publisher_id: row.publisher_id || 'local',
      version: row.version,
      recipe_hash: row.recipe_hash,
      recipe,
      // Stored 'imported' rows from older server builds are renamed
      // to 'pair-sync' on the wire — the contract shape only carries
      // the three values, and 'imported' is the legacy alias for
      // 'pair-sync' at the row layer.
      source: row.source === 'bundled' ? 'bundled' : 'pair-sync',
      installed_at: row.installed_at,
    });
  }

  // Bundled — every recipe the disk-loader saw at boot. Skip any id
  // already returned by SQLite (user chose to install a different
  // version of the same recipe).
  for (const id of deps.store.ids()) {
    if (seen.has(id)) continue;
    const recipe = deps.store.get(id);
    if (!recipe) continue; // shouldn't happen; defensive
    if (isKernelRecipe(recipe)) continue;
    // Bundled recipes have no row, so we have to derive these.
    out.push({
      recipe_id: recipe.recipe_id,
      publisher_id: 'recued-core',
      version: recipe.version,
      recipe_hash: hashRecipe(recipe),
      recipe,
      source: 'bundled',
      installed_at: deps.serverStartedAt,
    });
  }

  // Stable order: most recent first, then alphabetical by recipe_id.
  out.sort((a, b) => {
    if (a.installed_at !== b.installed_at) return b.installed_at - a.installed_at;
    return a.recipe_id.localeCompare(b.recipe_id);
  });

  return { recipes: out };
};

export type RecipeListMethods = 'recipe.list';

export const makeRecipeListHandlers = (
  deps: RecipeListHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, RecipeListMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['recipe.list'],
    handlers: {
      'recipe.list': async () => listServerRecipes(deps),
    },
  };
};
