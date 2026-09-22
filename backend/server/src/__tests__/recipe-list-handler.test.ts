/** D-119 Phase 5 — `recipe.list` rpc handler tests.
 *
 *  Covers:
 *    - bundled-only store returns recued-core publisher attribution
 *    - SQLite-stored row wins over a same-id bundled row (user choice)
 *    - inline-registered (memory override) recipes are NOT returned
 *    - sort order: most recent first, alphabetical tiebreaker
 *    - serverStartedAt fallback for bundled `installed_at`
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { RecipeDefinition } from '@recued/contracts';
import { createRecipeStore } from '../recipe-store.js';
import { getServerRecipe, listServerRecipes } from '../recipe-list-handler.js';

const recipe = (id: string, version = 1): RecipeDefinition => ({
  recipe_id: id,
  version,
  ttl: 60,
  metadata: {
    name: `Test ${id}`,
    description: 'fixture',
    author: 'test',
    supported_platforms: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

/** A kernel recipe is marked by `metadata.author === 'recued'` — the same marker
 *  `chat-tool-handlers` and `mcp-server` filter on. */
const kernelRecipe = (id: string): RecipeDefinition => ({
  ...recipe(id),
  metadata: { ...recipe(id).metadata, author: 'recued' },
} as unknown as RecipeDefinition);

const SERVER_STARTED_AT = 1_700_000_000_000;

describe('listServerRecipes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('⛔⛔ A KERNEL RECIPE IS NOT LISTED — `#recipes` IS the manage UI', () => {
    // Reported from a live webclient: kernel recipes showing on the Recipes page.
    // CLAUDE.md's publisher table says the `recued` namespace is "invisible in
    // marketplace / install / manage UI"; the rule was enforced at the chat catalog
    // door and the MCP door, over this SAME store, and missing at this one.
    const store = createRecipeStore('/nonexistent', db);
    store.save(kernelRecipe('memory-embed'), 'recued-core', 'pair-sync', 1_700_001_000_000);
    store.save(recipe('detect-deal-risk'), 'recued-core', 'pair-sync', 1_700_001_000_000);

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });

    expect(result.recipes.map((r) => r.recipe_id)).toEqual(['detect-deal-risk']);
  });

  it('⛔ THE MARKER IS metadata.author, NOT the emitted publisher_id', () => {
    // The bundled branch HARDCODES `publisher_id: 'recued-core'`, so a kernel recipe
    // is emitted under the same publisher as first-party marketplace content. A filter
    // written against the emitted field would match nothing and look like it worked.
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('ordinary'), 'recued-core', 'pair-sync', 1_700_001_000_000);

    const listed = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }).recipes;
    expect(listed).toHaveLength(1);
    expect(listed[0].publisher_id).toBe('recued-core');
    expect(listed[0].recipe.metadata.author).toBe('test');
  });

  it('returns SQLite-stored recipes with their stored hash + version + source', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('detect-deal-risk', 3), 'recued-core', 'pair-sync', 1_700_001_000_000);

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });

    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      recipe_id: 'detect-deal-risk',
      publisher_id: 'recued-core',
      version: 3,
      source: 'pair-sync',
      installed_at: 1_700_001_000_000,
    });
    expect(result.recipes[0].recipe_hash).toMatch(/^[a-f0-9]{8,}/);
  });

  it('returns bundled recipes with serverStartedAt fallback + recued-core publisher', () => {
    const store = createRecipeStore('/nonexistent');
    store.register(recipe('bundled-fixture', 1));
    // Hack: register() is the only way to make a recipe show up in
    // ids() without a real on-disk bundle dir. The handler treats
    // anything from ids()-not-in-listStored() as bundled.

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });

    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      recipe_id: 'bundled-fixture',
      publisher_id: 'recued-core',
      source: 'bundled',
      installed_at: SERVER_STARTED_AT,
    });
  });

  it('⛔⛔ AND A BUNDLED KERNEL RECIPE IS EXCLUDED — this is the branch that fires', () => {
    // ⚠ THE PRODUCTION PATH IS THE BUNDLED ONE. Kernel recipes are never in
    // `installRegistry`, so they reach `ids()` and never `listStored()`; a filter that
    // only covered the stored branch would have passed its test and fixed nothing.
    const store = createRecipeStore('/nonexistent');
    store.register(kernelRecipe('run-ingredient'));
    store.register(recipe('bundled-fixture', 1));

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });

    expect(result.recipes.map((r) => r.recipe_id)).toEqual(['bundled-fixture']);
  });

  it('SQLite row wins when the same id exists in both bundled + db', () => {
    const store = createRecipeStore('/nonexistent', db);
    // "Bundled" via register so the in-memory map lights up the id.
    store.register(recipe('shared-id', 1));
    // SQLite save with a different version.
    store.save(recipe('shared-id', 7), 'someone-else', 'pair-sync', 1_700_005_000_000);

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });

    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      recipe_id: 'shared-id',
      publisher_id: 'someone-else',
      version: 7,
      source: 'pair-sync',
      installed_at: 1_700_005_000_000,
    });
  });

  it('sorts most-recent first, alphabetical tiebreaker', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('zebra'), 'p', 'pair-sync', 1_000);
    store.save(recipe('alpha'), 'p', 'pair-sync', 2_000);
    store.save(recipe('beta'), 'p', 'pair-sync', 2_000);
    store.save(recipe('gamma'), 'p', 'pair-sync', 3_000);

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });

    expect(result.recipes.map((r) => r.recipe_id)).toEqual([
      'gamma', // most recent
      'alpha', // tied at 2000 — alphabetical first
      'beta',  // tied at 2000
      'zebra',
    ]);
  });

  it('returns an empty list when no recipes are registered or stored', () => {
    const store = createRecipeStore('/nonexistent', db);
    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });
    expect(result.recipes).toEqual([]);
  });

  it('falls back to publisher_id="local" when SQLite row has empty publisher_id', () => {
    const store = createRecipeStore('/nonexistent', db);
    // Empty publisher_id (test fixture / older row).
    store.save(recipe('legacy'), '', 'pair-sync', 1_700_002_000_000);

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });
    expect(result.recipes[0].publisher_id).toBe('local');
  });

  it('embeds the full RecipeDefinition for first-paint rendering', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('detect-foo'), 'recued-core', 'pair-sync', 1_700_001_000_000);

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });
    expect(result.recipes[0].recipe).toMatchObject({
      recipe_id: 'detect-foo',
      metadata: expect.objectContaining({ name: 'Test detect-foo' }),
    });
  });
});

/** `recipe.get` — the by-id door onto the same store.
 *
 *  ⛔⛔ THE POINT OF THESE TESTS IS THAT THE TWO DOORS AGREE. This module's
 *  header records what one store with three readers cost when the kernel rule
 *  was applied at two of them: kernel recipes reached the one surface a human
 *  looks at. `recipe.get` is a fourth reader over that same store, so every
 *  invariant the list holds is asserted here too — and the last test pins the
 *  agreement itself rather than re-listing the rules, so a future rule added
 *  to one door and not the other fails here without anyone remembering to. */
describe('getServerRecipe', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  const deps = (store: ReturnType<typeof createRecipeStore>) =>
    ({ store, serverStartedAt: SERVER_STARTED_AT });

  it('returns a stored recipe by id, in the list entry shape', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('detect-deal-risk'), 'acme', 'pair-sync', 1_700_001_000_000);

    const got = getServerRecipe(deps(store), 'detect-deal-risk').recipe;
    expect(got).not.toBeNull();
    expect(got!.recipe_id).toBe('detect-deal-risk');
    expect(got!.publisher_id).toBe('acme');
    expect(got!.source).toBe('pair-sync');
    // The body is the whole point — the Kitchen editor initialises from it.
    expect(got!.recipe.steps).toBeDefined();
  });

  it('returns null for an unknown id, and for a blank one', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('present'), 'acme', 'pair-sync', 1_700_001_000_000);
    expect(getServerRecipe(deps(store), 'absent').recipe).toBeNull();
    expect(getServerRecipe(deps(store), '   ').recipe).toBeNull();
  });

  it('⛔⛔ HIDES A KERNEL RECIPE, exactly as the list does', () => {
    // A fourth door onto the store. The rule existed at three and was missing
    // at the list once already; a `get` that answered would reopen it by a
    // different route — and by id, which is how a deep link arrives.
    const store = createRecipeStore('/nonexistent', db);
    store.save(kernelRecipe('memory-embed'), 'recued-core', 'pair-sync', 1_700_001_000_000);
    expect(getServerRecipe(deps(store), 'memory-embed').recipe).toBeNull();
  });

  it('🔑 AGREES WITH `recipe.list` ENTRY-FOR-ENTRY over the same store', () => {
    // The no-drift assertion. Both doors build entries through one shared
    // builder; this fails the moment either grows a rule the other lacks,
    // without needing a test per rule.
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('alpha'), 'acme', 'pair-sync', 1_700_002_000_000);
    store.save(recipe('beta', 3), 'recued-core', 'pair-sync', 1_700_001_000_000);
    store.save(kernelRecipe('memory-embed'), 'recued-core', 'pair-sync', 1_700_003_000_000);

    const listed = listServerRecipes(deps(store)).recipes;
    expect(listed.length).toBeGreaterThan(0);
    for (const entry of listed) {
      const got = getServerRecipe(deps(store), entry.recipe_id).recipe;
      expect(got).not.toBeNull();
      // ⚠ THE ONE DIFFERENCE IS THE BODY, AND IT IS DELIBERATE. `recipe.list`
      // ships `RecipeListRecipeView` (no `steps` / `prefetch_steps`);
      // `recipe.get` ships the whole definition. Everything else — including
      // both projections — must still match field for field, which is what
      // stops a rule being added to one door and not the other.
      const { recipe: gotRecipe, ...gotRest } = got!;
      const { recipe: listRecipe, ...listRest } = entry;
      expect(gotRest).toStrictEqual(listRest);
      expect(gotRecipe).toMatchObject(listRecipe);
      expect((gotRecipe as { steps?: unknown }).steps).toBeDefined();
      expect((listRecipe as { steps?: unknown }).steps).toBeUndefined();
    }
    // And what the list withholds, `get` withholds.
    expect(listed.some((e) => e.recipe_id === 'memory-embed')).toBe(false);
    expect(getServerRecipe(deps(store), 'memory-embed').recipe).toBeNull();
  });
});

/** The `provably_read_only` projection.
 *
 *  ⛔⛔ THIS IS A PERMISSIONS ANSWER, AND BOTH WAYS OF GETTING IT WRONG ARE
 *  LIVE. Without a resolvable roster the rule fails CLOSED — a real view shown
 *  as an operation, which is what the webclient started doing when `packs.list`
 *  stopped forwarding manifests. Without step bodies it fails OPEN, because
 *  `stepsAreAnalysable(undefined)` is `true`: a stripped recipe passes every
 *  check vacuously and one that DELETES answers "read only". The server
 *  projects it precisely so no client has to hold both inputs. */
describe('provably_read_only projection', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });

  const withOp = (id: string, op: string): RecipeDefinition => ({
    ...recipe(id),
    steps: [{ id: 's1', op }],
  } as unknown as RecipeDefinition);

  const roster = (opId: string, risk: 'read' | 'write') => () => [{
    slug: 'demo-pack', publisher: 'acme', name: 'Demo',
    manifest: { contents: [{ type: 'composition', composition: {
      operations: [{ op: opId, risk }],
    } }] },
  }] as never;

  it('projects TRUE for a recipe whose only op is declared read', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(withOp('reader', 'acme.demo-pack.look_thing'), 'acme', 'pair-sync', 1_700_001_000_000);
    const out = listServerRecipes({
      store, serverStartedAt: SERVER_STARTED_AT, packRoster: roster('look_thing', 'read'),
    }).recipes;
    expect(out[0]!.provably_read_only).toBe(true);
  });

  it('⛔ projects FALSE for a WRITE op — the answer that must never fail open', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(withOp('writer', 'acme.demo-pack.change_thing'), 'acme', 'pair-sync', 1_700_001_000_000);
    const out = listServerRecipes({
      store, serverStartedAt: SERVER_STARTED_AT, packRoster: roster('change_thing', 'write'),
    }).recipes;
    expect(out[0]!.provably_read_only).toBe(false);
  });

  it('⛔ projects FALSE when the op does not resolve — unknown is not harmless', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(withOp('mystery', 'acme.demo-pack.unlisted_thing'), 'acme', 'pair-sync', 1_700_001_000_000);
    const out = listServerRecipes({
      store, serverStartedAt: SERVER_STARTED_AT, packRoster: roster('look_thing', 'read'),
    }).recipes;
    expect(out[0]!.provably_read_only).toBe(false);
  });

  it('⛔ carries a NULL connection kind as null, never the string "null"', () => {
    // The first cut of this projection did `String(c.kind)`. `kind` is
    // `ConnectionKind | null` and the null is MEANINGFUL — the need came from
    // a `read_connection_*` permission, not a typed ref — so stringifying it
    // shipped a `"null"` kind to every client, which reads as a real kind.
    const store = createRecipeStore('/nonexistent', db);
    store.save({
      ...recipe('permits'),
      requires: ['read_connection_personio'],
    } as unknown as RecipeDefinition, 'acme', 'pair-sync', 1_700_001_000_000);
    const out = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }).recipes;
    const conns = out[0]!.required_connections ?? [];
    expect(conns).toStrictEqual([{ kind: null, name: 'personio' }]);
    for (const c of conns) expect(c.kind).not.toBe('null');
  });

  it('omits the field entirely when no roster is wired', () => {
    // An older/dbless server projects nothing rather than guessing, and the
    // client keeps its own full-body answer. `undefined` must not read as
    // `false` — that is the fail-closed misclassification, just relocated.
    const store = createRecipeStore('/nonexistent', db);
    store.save(withOp('reader', 'acme.demo-pack.look_thing'), 'acme', 'pair-sync', 1_700_001_000_000);
    const out = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }).recipes;
    expect(out[0]!.provably_read_only).toBeUndefined();
    expect('provably_read_only' in out[0]!).toBe(false);
  });

  it('`recipe.get` projects it identically', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(withOp('writer', 'acme.demo-pack.change_thing'), 'acme', 'pair-sync', 1_700_001_000_000);
    const d = { store, serverStartedAt: SERVER_STARTED_AT, packRoster: roster('change_thing', 'write') };
    // Same projection from both doors; only the body differs.
    expect(getServerRecipe(d, 'writer').recipe!.provably_read_only)
      .toBe(listServerRecipes(d).recipes[0]!.provably_read_only);
    expect(getServerRecipe(d, 'writer').recipe!.required_connections)
      .toStrictEqual(listServerRecipes(d).recipes[0]!.required_connections);
  });
});
