/**
 * Edit→Kitchen render harness (Playwright e2e, Layer 2).
 *
 * The `#kitchen/recipe/<id>` and `#kitchen/pack` routes dispatch INSIDE the
 * paired webclient bootstrap (after the WS handshake), so a fresh staging load
 * — with no paired recued-server — never reaches them: it shows the pair-form.
 * The staging-smoke spec covers that reachable surface.
 *
 * To actually eyeball the shipped Edit→Kitchen UI in a real browser, this
 * harness mounts the SAME two route-target components the bootstrap dispatches
 * to (`mountRecipeEditorRoute` for S1, `bootstrapIngredientBuilderRoute` for
 * S2), with the mock callers the vitest suites already proved render the real
 * editor + builder. It's the browser twin of those jsdom tests — real CSS,
 * real layout, screenshottable — minus the crypto pairing the components never
 * touch.
 *
 * `?surface=recipe` mounts the recipe editor; anything else mounts the pack
 * builder. `window.__harness` exposes the interaction hooks the spec asserts on.
 */
import { mountRecipeEditorRoute } from '../../src/kitchen/recipe-editor/mount-recipe-editor-route.js';
import { bootstrapIngredientBuilderRoute } from '../../src/kitchen/ingredient-builder/operation-family-table.js';
import type { IngredientBuilderConn } from '../../src/kitchen/ingredient-builder/operation-family-table.js';
import { mountKitchenChrome } from '../../src/kitchen/kitchen-route-chrome.js';
import type { RecipeDefinition, ServerRecipeListEntry } from '@recued/contracts';

interface HarnessHooks {
  surface: 'recipe' | 'pack';
  saveCalls: Array<{ recipe_id: string }>;
  draftChanges: Array<string | undefined>;
  connCalls: string[];
  mounted: boolean;
}

declare global {
  interface Window {
    __harness: HarnessHooks;
  }
}

// A recipe rich enough that the editor renders a populated form — the S1
// screenshot should show real fields + steps, not an empty shell.
const demoRecipe: RecipeDefinition = {
  recipe_id: 'detect-deal-risk-hubspot',
  version: 3,
  ttl: 300,
  metadata: {
    name: 'Detect deal risk (HubSpot)',
    description: 'Flag at-risk open deals from stall + sentiment signals.',
    author: 'recued-core',
    supported_platforms: [],
  },
  variables: { threshold_days: 14 },
  prefetch_steps: [],
  steps: [
    { id: 'deal', ingredient: 'deal-reader-hubspot' },
    { id: 'days_stalled', transform: 'date_diff' },
    { id: 'risk', ingredient: 'ai-score' },
  ] as RecipeDefinition['steps'],
  output: { render: [] },
};

const entry: ServerRecipeListEntry = {
  recipe_id: demoRecipe.recipe_id,
  publisher_id: 'recued-core',
  version: demoRecipe.version ?? 1,
  recipe_hash: 'demo-hash',
  recipe: demoRecipe,
  source: 'bundled',
  installed_at: 0,
};

const params = new URLSearchParams(globalThis.location?.search ?? '');
const surface = params.get('surface') === 'recipe' ? 'recipe' : 'pack';

const hooks: HarnessHooks = {
  surface,
  saveCalls: [],
  draftChanges: [],
  connCalls: [],
  mounted: false,
};
window.__harness = hooks;

const root = document.getElementById('root');
if (root === null) throw new Error('harness: #root missing');

// Wrap in the real route chrome (the [ Recipe | Ingredient pack ] tab bar),
// exactly as the bootstrap kitchen branch does — the surface mounts into the
// chrome's content slot.
const chrome = mountKitchenChrome({
  root,
  active: surface,
  ...(surface === 'recipe' ? { recipeId: demoRecipe.recipe_id } : {}),
});

if (surface === 'recipe') {
  mountRecipeEditorRoute({
    root: chrome.contentRoot,
    recipeId: demoRecipe.recipe_id,
    listCaller: async () => ({ recipes: [entry] }),
    validateCaller: async () => ({ ok: true, issues: [] }),
    saveCaller: async (args: { recipe: RecipeDefinition }) => {
      hooks.saveCalls.push({ recipe_id: args.recipe.recipe_id });
      return {
        saved: true as const,
        recipe_id: args.recipe.recipe_id,
        version: (demoRecipe.version ?? 1) + 1,
        name: args.recipe.metadata.name,
      };
    },
  });
} else {
  // The builder lists drafts on mount, then only touches `conn` again on
  // load/save. Mirror the shapes the vitest suite's mock returns (esp.
  // `draft.list → { drafts: [] }` — the builder iterates it, so a bare
  // `{ ok: true }` throws "state.drafts is not iterable" and the tables never
  // render). Everything past mount gets a benign draft echo.
  const conn = (async (method: string, payload: unknown) => {
    hooks.connCalls.push(method);
    if (method === 'ingredient.draft.list') return { ok: true, drafts: [] };
    if (method === 'ingredient.draft.get') {
      return { ok: false, code: 'not_found', message: 'harness: no drafts' };
    }
    const p = (payload ?? {}) as { draft_id?: string; title?: string; body?: unknown };
    return {
      ok: true,
      draft: {
        draft_id: p.draft_id ?? 'harness-draft',
        title: p.title ?? 'Harness draft',
        body: p.body,
        created_at: 1,
        updated_at: 2,
      },
    };
  }) as unknown as IngredientBuilderConn;
  bootstrapIngredientBuilderRoute({
    root: chrome.contentRoot,
    conn,
    onDraftChange: (draftId: string | undefined) => {
      hooks.draftChanges.push(draftId);
    },
  });
}

hooks.mounted = true;
