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

describe('D-137 Wave 2.1 — Mary\'s per-kind catalog scope gate plumbing', () => {
  it('Tier 2 entry requires_kinds is the substrate filter-tools keys off via kindGatedTier2Names', () => {
    // Whitebox check that the projection + filter-tools gate compose
    // correctly: a recipe touching the `file` kind, with Mary's per-
    // kind toggle leaving `file` unchecked, should end up in the
    // caller-supplied `kindGatedTier2Names` set (the caller builds it
    // from `entry.requires_kinds ∩ Mary's disabled-kinds`).
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
    // The caller (chat orchestrator) builds kindGatedTier2Names as:
    //   { recipe.name | recipe.requires_kinds intersects Mary.disabled }
    const maryDisabled: ReadonlySet<IngredientKind> = new Set<IngredientKind>(['storage']);
    const kindGated = new Set<string>(
      catalog
        .filter((e) =>
          (e.requires_kinds ?? []).some((k) => maryDisabled.has(k)),
        )
        .map((e: ToolEntry) => e.name),
    );
    expect(kindGated.has('mary/archive')).toBe(true);
  });
});
