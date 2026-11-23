/** D-137 Wave 2.1 — InternalToolRegistry Tier 2 enumeration.
 *
 *  Acceptance per spec § A.1.1 + the W2.1 substrate notes:
 *   - The factory accepts an optional `tier2Source` + `manifestLookup`
 *     pair; without them the catalog stays Tier-1-only (P1 posture
 *     preserved).
 *   - `listByTier(2)` projects installed recipes through the
 *     `buildTier2Catalog` pipeline — `chat_exposed: true` (default-
 *     true) surfaces; `chat_exposed: false` drops; sorted by
 *     `<publisher>/<slug>`.
 *   - `list()` returns Tier 1 entries first, then Tier 2 — Tier 1
 *     ordering preserved.
 *   - `getByName('<publisher>/<slug>')` resolves Tier 2 entries.
 *   - Dispatch on a Tier 2 name routes through the optional
 *     `tier2Dispatch` override; defaults to `not_implemented` so the
 *     catalog enumerates ahead of the per-recipe invocation handler
 *     (lands in a later slice).
 *   - Dispatch on an unknown name still resolves `unknown_tool`.
 *   - Source mutation (recipe install / uninstall) surfaces in the
 *     next `list()` call — the factory pulls fresh on every read.
 *   - Mary's per-kind catalog scope toggle gate works through
 *     `requires_kinds` derived from the recipe's ingredient slugs +
 *     the caller's manifest kind lookup. */

import { describe, it, expect } from 'vitest';
import type {
  ChatDispatchContext,
  IngredientKind,
  IngredientManifest,
  RecipeDefinition,
  ToolEntry,
} from '@recued/contracts';
import { TIER1_TOOL_NAMES } from '@recued/contracts';
import {
  buildTier2Catalog,
  createManifestKindLookup,
} from '@recued/recipes';
import type { Tier2RecipeEntry } from '@recued/recipes';
import {
  createInternalToolRegistry,
  type Tier2Handler,
} from '../internal-tool-registry/index.js';

const ctxInternal = (
  session_id = 'sess-1',
  turn_id = 'turn-1',
): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id,
  turn_id,
});

const baseRecipe = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'r1',
  version: 1,
  // Post-flip (2026-07-02) distributed content defaults HIDDEN on an absent
  // flag; enumeration-focused tests opt in explicitly.
  chat_exposed: true,
  ttl: 60,
  metadata: {
    name: 'Recipe one',
    description: 'A recipe for testing Tier 2 enumeration.',
    author: 'recued-core',
    supported_platforms: ['gmail'],
    tags: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'concat', values: ['ok'] }],
  output: { sidebar: [{ type: 'summary', source: 'step.noop' }] },
  ...overrides,
});

describe('D-137 Wave 2.1 — Tier 2 catalog enumeration (§ A.1.1)', () => {
  it('list() preserves P1 Tier-1-only posture when no tier2Source is provided', () => {
    const registry = createInternalToolRegistry();
    const entries = registry.list();
    expect(entries.length).toBe(TIER1_TOOL_NAMES.length);
    expect(registry.listByTier(2)).toEqual([]);
  });

  it('listByTier(2) surfaces chat_exposed: true (default) recipes', () => {
    const recipes: Tier2RecipeEntry[] = [
      {
        recipe_id: 'draft-followup',
        publisher_id: 'recued-core',
        recipe: baseRecipe({ recipe_id: 'draft-followup' }),
      },
    ];
    const registry = createInternalToolRegistry({
      tier2Source: { listRecipes: () => recipes },
    });
    const tier2 = registry.listByTier(2);
    expect(tier2.length).toBe(1);
    expect(tier2[0]!.name).toBe('recued-core/draft-followup');
    expect(tier2[0]!.tier).toBe(2);
  });

  it('chat_exposed: false drops the recipe from listByTier(2)', () => {
    const recipes: Tier2RecipeEntry[] = [
      {
        recipe_id: 'private',
        publisher_id: 'mary',
        recipe: baseRecipe({ recipe_id: 'private', chat_exposed: false }),
      },
    ];
    const registry = createInternalToolRegistry({
      tier2Source: { listRecipes: () => recipes },
    });
    expect(registry.listByTier(2)).toEqual([]);
  });

  it('list() returns Tier 1 first then Tier 2 — both deterministic', () => {
    const recipes: Tier2RecipeEntry[] = [
      {
        recipe_id: 'omega',
        publisher_id: 'mary',
        recipe: baseRecipe({ recipe_id: 'omega' }),
      },
      {
        recipe_id: 'alpha',
        publisher_id: 'recued-core',
        recipe: baseRecipe({ recipe_id: 'alpha' }),
      },
    ];
    const registry = createInternalToolRegistry({
      tier2Source: { listRecipes: () => recipes },
    });
    const all = registry.list();
    expect(all.length).toBe(TIER1_TOOL_NAMES.length + 2);
    // Tier 1 entries first; their relative order is the closed
    // TIER1_TOOL_NAMES ordering.
    const tier1Names = all.filter((e) => e.tier === 1).map((e) => e.name);
    expect(tier1Names).toEqual([...TIER1_TOOL_NAMES]);
    // Tier 2 entries follow, sorted by <publisher>/<slug>.
    const tier2Names = all.filter((e) => e.tier === 2).map((e) => e.name);
    expect(tier2Names).toEqual(['mary/omega', 'recued-core/alpha']);
  });

  it('getByName resolves Tier 2 entries by <publisher>/<slug>', () => {
    const recipes: Tier2RecipeEntry[] = [
      {
        recipe_id: 'draft-followup',
        publisher_id: 'recued-core',
        recipe: baseRecipe({ recipe_id: 'draft-followup' }),
      },
    ];
    const registry = createInternalToolRegistry({
      tier2Source: { listRecipes: () => recipes },
    });
    const entry = registry.getByName('recued-core/draft-followup');
    expect(entry).not.toBeNull();
    expect(entry?.tier).toBe(2);
    expect(entry?.classification).toBe('unknown');
  });

  it('source mutation surfaces on the next read (no manual refresh)', () => {
    const recipes: Tier2RecipeEntry[] = [];
    const registry = createInternalToolRegistry({
      tier2Source: { listRecipes: () => recipes },
    });
    expect(registry.listByTier(2)).toEqual([]);
    recipes.push({
      recipe_id: 'new-arrival',
      publisher_id: 'mary',
      recipe: baseRecipe({ recipe_id: 'new-arrival' }),
    });
    const after = registry.listByTier(2);
    expect(after.map((e) => e.name)).toEqual(['mary/new-arrival']);
  });

  it('dispatch on a Tier 2 name routes through the override; defaults to not_implemented', async () => {
    const recipes: Tier2RecipeEntry[] = [
      {
        recipe_id: 'r',
        publisher_id: 'pub',
        recipe: baseRecipe({ recipe_id: 'r' }),
      },
    ];
    // Default — no override.
    const defaultRegistry = createInternalToolRegistry({
      tier2Source: { listRecipes: () => recipes },
    });
    const def = await defaultRegistry.dispatch('pub/r', {}, ctxInternal());
    expect(def.ok).toBe(false);
    if (!def.ok) expect(def.reason).toBe('not_implemented');

    // Custom dispatch override fires.
    const calls: Array<{ name: string }> = [];
    const tier2Dispatch: Tier2Handler = async (toolName) => {
      calls.push({ name: toolName });
      return { ok: true, result: { dispatched: toolName } };
    };
    const overrideRegistry = createInternalToolRegistry({
      tier2Source: { listRecipes: () => recipes },
      tier2Dispatch,
    });
    const ok = await overrideRegistry.dispatch('pub/r', {}, ctxInternal());
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.result).toEqual({ dispatched: 'pub/r' });
    }
    expect(calls).toEqual([{ name: 'pub/r' }]);
  });

  it('dispatch on an unknown name still resolves unknown_tool (Tier 2 lookup misses fall through)', async () => {
    const registry = createInternalToolRegistry({
      tier2Source: { listRecipes: () => [] },
    });
    const result = await registry.dispatch('pub/ghost', {}, ctxInternal());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_tool');
  });

  it('Tier 2 entry carries requires_kinds when ingredient kinds derive from steps', () => {
    const manifestById = new Map<string, IngredientManifest>([
      [
        'mail-list-gmail',
        {
          slug: 'mail-list-gmail',
          name: 'Mail list (Gmail)',
          description: 'List recent mail messages from Gmail.',
          author: 'recued',
          kind: 'http' as IngredientKind,
        } as IngredientManifest,
      ],
    ]);
    const recipes: Tier2RecipeEntry[] = [
      {
        recipe_id: 'mail-summary',
        publisher_id: 'recued-core',
        recipe: baseRecipe({
          recipe_id: 'mail-summary',
          steps: [
            { id: 'mail', ingredient: 'mail-list-gmail' },
            { id: 't', transform: 'concat', values: ['ok'] },
          ],
        }),
      },
    ];
    const manifestLookup = createManifestKindLookup((slug) => manifestById.get(slug) ?? null);
    const registry = createInternalToolRegistry({
      tier2Source: { listRecipes: () => recipes },
      manifestLookup,
    });
    const entry = registry.getByName('recued-core/mail-summary');
    expect(entry?.requires_kinds).toEqual(['http']);
  });
});

describe('D-137 Wave 2.1 — Tier 2 requires_kinds derivation', () => {
  it('a Tier 2 entry carries the kinds its steps touch', () => {
    // The projection derives `requires_kinds` from the recipe's ingredient
    // steps. ⛔ It no longer gates chat — the per-kind scope that keyed off it
    // is retired (D-137 W2.2, 2026-10-04) — but the MCP door's grant checklist
    // still groups tools by it.
    const manifestById = new Map<string, IngredientManifest>([
      [
        'file-write',
        {
          slug: 'file-write',
          name: 'File write',
          description: 'Write content to a file.',
          author: 'recued',
          kind: 'storage' as IngredientKind,
        } as IngredientManifest,
      ],
    ]);
    const recipes: Tier2RecipeEntry[] = [
      {
        recipe_id: 'archive',
        publisher_id: 'mary',
        recipe: baseRecipe({
          recipe_id: 'archive',
          steps: [{ id: 'w', ingredient: 'file-write' }],
        }),
      },
    ];
    const catalog = buildTier2Catalog(
      recipes,
      createManifestKindLookup((slug) => manifestById.get(slug) ?? null),
    );
    expect(catalog.map((e: ToolEntry) => [e.name, e.requires_kinds])).toEqual([
      ['mary/archive', ['storage']],
    ]);
  });
});

// D-347 slice C follow-up (2026-11-08) — a lookup by name read every installed recipe: 780 entries at
// 140 to 430 ms a projection, 36 projections in one two-message conversation, 15 of them after its answer.
describe('Tier 2 lookup by name, read alone (`recipeNamed`)', () => {
  const entries: Tier2RecipeEntry[] = [
    { recipe_id: 'draft-followup', publisher_id: 'recued-core', recipe: baseRecipe({ recipe_id: 'draft-followup' }) },
    { recipe_id: 'hidden-one', publisher_id: 'recued-core', recipe: baseRecipe({ recipe_id: 'hidden-one', chat_exposed: false }) },
    { recipe_id: 'a/b', publisher_id: 'mary', recipe: baseRecipe({ recipe_id: 'a/b' }) },
  ];
  /** A source that reads one entry, counting its full listings. */
  const counted = () => {
    let listings = 0;
    return {
      source: {
        listRecipes: () => { listings += 1; return entries; },
        recipeNamed: (name: string) => entries.find((e) => `${e.publisher_id}/${e.recipe_id}` === name) ?? null,
      },
      listings: () => listings,
    };
  };

  it('finds the entry a full projection holds, a hidden one as hidden, without listing every recipe', () => {
    const { source, listings } = counted();
    const alone = createInternalToolRegistry({ tier2Source: source });
    const projected = createInternalToolRegistry({ tier2Source: { listRecipes: () => entries } });
    for (const name of ['recued-core/draft-followup', 'mary/a/b', 'recued-core/hidden-one', 'recued-core/ghost', 'no-slash']) {
      expect(alone.getByName(name)).toEqual(projected.getByName(name));
    }
    expect(alone.getByName('recued-core/draft-followup')?.tier).toBe(2);
    expect(alone.getByName('mary/a/b')?.name).toBe('mary/a/b');
    expect(alone.getByName('recued-core/hidden-one')).toBeNull();
    expect(listings()).toBe(0);
  });

  it('dispatch reads the one entry too, and a miss is still unknown_tool', async () => {
    const { source, listings } = counted();
    const calls: string[] = [];
    const registry = createInternalToolRegistry({ tier2Source: source,
      tier2Dispatch: async (toolName) => { calls.push(toolName); return { ok: true, result: {} }; } });
    expect((await registry.dispatch('mary/a/b', {}, ctxInternal())).ok).toBe(true);
    const miss = await registry.dispatch('mary/ghost', {}, ctxInternal());
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.reason).toBe('unknown_tool');
    expect(calls).toEqual(['mary/a/b']);
    expect(listings()).toBe(0);
  });

  it('a listing still lists every exposed recipe, from one listing', () => {
    const { source, listings } = counted();
    const registry = createInternalToolRegistry({ tier2Source: source });
    expect(registry.listByTier(2).map((e) => e.name)).toEqual(['mary/a/b', 'recued-core/draft-followup']);
    expect(listings()).toBe(1);
  });
});

// "Turn it on" under the owner's answer names a switched-off recipe by its title, where it read
// "recued-core/weekly-digest is turned off for you"; the refusal the model reads keeps the name
// it calls.
describe('a switched-off recipe, offered to turn on', () => {
  const recipes: Tier2RecipeEntry[] = [{
    recipe_id: 'weekly-digest', publisher_id: 'recued-core',
    recipe: baseRecipe({ recipe_id: 'weekly-digest', metadata: { ...baseRecipe().metadata, name: 'Weekly digest' } }),
  }];
  const own = { ...ctxInternal(), execution_source: { channel: 'chat', actor: 'user_self' } as never };

  it('labels the offer by the recipe\'s title, through either lookup', async () => {
    for (const tier2Source of [
      { listRecipes: () => recipes },
      { listRecipes: () => recipes, recipeNamed: (name: string) => recipes.find(r => `${r.publisher_id}/${r.recipe_id}` === name) ?? null },
    ]) {
      const registry = createInternalToolRegistry({ tier2Source, admitTier2: () => false });
      const res = await registry.dispatch('recued-core/weekly-digest', {}, own) as { detail: string; fixes?: unknown };
      expect(res.fixes).toEqual([{ kind: 'switch', entry_key: 'recipe.recued-core/weekly-digest', label: '“Weekly digest”' }]);
      expect(res.detail).toContain("'recued-core/weekly-digest'");
    }
  });
});
