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
import { collectListPages, type RecipeDefinition } from '@recued/contracts';
import { createRecipeStore } from '../recipe-store.js';
import { getServerRecipe, listServerRecipes, makeRecipeListHandlers } from '../recipe-list-handler.js';

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

  it('⛔⛔ A KERNEL RECIPE IS NOT LISTED — `#recipes` IS the manage UI', async () => {
    // Reported from a live webclient: kernel recipes showing on the Recipes page.
    // CLAUDE.md's publisher table says the `recued` namespace is "invisible in
    // marketplace / install / manage UI"; the rule was enforced at the chat catalog
    // door and the MCP door, over this SAME store, and missing at this one.
    const store = createRecipeStore('/nonexistent', db);
    store.save(kernelRecipe('memory-embed'), 'recued-core', 'pair-sync', 1_700_001_000_000);
    store.save(recipe('detect-deal-risk'), 'recued-core', 'pair-sync', 1_700_001_000_000);

    const result = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }));

    expect(result.recipes.map((r) => r.recipe_id)).toEqual(['detect-deal-risk']);
  });

  it('⛔ THE MARKER IS metadata.author, NOT the emitted publisher_id', async () => {
    // The bundled branch HARDCODES `publisher_id: 'recued-core'`, so a kernel recipe
    // is emitted under the same publisher as first-party marketplace content. A filter
    // written against the emitted field would match nothing and look like it worked.
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('ordinary'), 'recued-core', 'pair-sync', 1_700_001_000_000);

    const listed = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT })).recipes;
    expect(listed).toHaveLength(1);
    expect(listed[0].publisher_id).toBe('recued-core');
    expect(listed[0].recipe.metadata.author).toBe('test');
  });

  it('returns SQLite-stored recipes with their stored hash + version + source', async () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('detect-deal-risk', 3), 'recued-core', 'pair-sync', 1_700_001_000_000);

    const result = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }));

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

  it('returns bundled recipes with serverStartedAt fallback + recued-core publisher', async () => {
    const store = createRecipeStore('/nonexistent');
    store.register(recipe('bundled-fixture', 1));
    // Hack: register() is the only way to make a recipe show up in
    // ids() without a real on-disk bundle dir. The handler treats
    // anything from ids()-not-in-listStored() as bundled.

    const result = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }));

    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      recipe_id: 'bundled-fixture',
      publisher_id: 'recued-core',
      source: 'bundled',
      installed_at: SERVER_STARTED_AT,
    });
  });

  it('⛔⛔ AND A BUNDLED KERNEL RECIPE IS EXCLUDED — this is the branch that fires', async () => {
    // ⚠ THE PRODUCTION PATH IS THE BUNDLED ONE. Kernel recipes are never in
    // `installRegistry`, so they reach `ids()` and never `listStored()`; a filter that
    // only covered the stored branch would have passed its test and fixed nothing.
    const store = createRecipeStore('/nonexistent');
    store.register(kernelRecipe('run-ingredient'));
    store.register(recipe('bundled-fixture', 1));

    const result = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }));

    expect(result.recipes.map((r) => r.recipe_id)).toEqual(['bundled-fixture']);
  });

  it('SQLite row wins when the same id exists in both bundled + db', async () => {
    const store = createRecipeStore('/nonexistent', db);
    // "Bundled" via register so the in-memory map lights up the id.
    store.register(recipe('shared-id', 1));
    // SQLite save with a different version.
    store.save(recipe('shared-id', 7), 'someone-else', 'pair-sync', 1_700_005_000_000);

    const result = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }));

    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      recipe_id: 'shared-id',
      publisher_id: 'someone-else',
      version: 7,
      source: 'pair-sync',
      installed_at: 1_700_005_000_000,
    });
  });

  it('sorts most-recent first, alphabetical tiebreaker', async () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('zebra'), 'p', 'pair-sync', 1_000);
    store.save(recipe('alpha'), 'p', 'pair-sync', 2_000);
    store.save(recipe('beta'), 'p', 'pair-sync', 2_000);
    store.save(recipe('gamma'), 'p', 'pair-sync', 3_000);

    const result = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }));

    expect(result.recipes.map((r) => r.recipe_id)).toEqual([
      'gamma', // most recent
      'alpha', // tied at 2000 — alphabetical first
      'beta',  // tied at 2000
      'zebra',
    ]);
  });

  it('returns an empty list when no recipes are registered or stored', async () => {
    const store = createRecipeStore('/nonexistent', db);
    const result = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }));
    expect(result.recipes).toEqual([]);
  });

  it('falls back to publisher_id="local" when SQLite row has empty publisher_id', async () => {
    const store = createRecipeStore('/nonexistent', db);
    // Empty publisher_id (test fixture / older row).
    store.save(recipe('legacy'), '', 'pair-sync', 1_700_002_000_000);

    const result = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }));
    expect(result.recipes[0].publisher_id).toBe('local');
  });

  it('embeds the full RecipeDefinition for first-paint rendering', async () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('detect-foo'), 'recued-core', 'pair-sync', 1_700_001_000_000);

    const result = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }));
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

  it('returns a stored recipe by id, in the list entry shape', async () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('detect-deal-risk'), 'acme', 'pair-sync', 1_700_001_000_000);

    const got = (await getServerRecipe(deps(store), 'detect-deal-risk')).recipe;
    expect(got).not.toBeNull();
    expect(got!.recipe_id).toBe('detect-deal-risk');
    expect(got!.publisher_id).toBe('acme');
    expect(got!.source).toBe('pair-sync');
    // The body is the whole point — the Kitchen editor initialises from it.
    expect(got!.recipe.steps).toBeDefined();
  });

  it('returns null for an unknown id, and for a blank one', async () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('present'), 'acme', 'pair-sync', 1_700_001_000_000);
    expect((await getServerRecipe(deps(store), 'absent')).recipe).toBeNull();
    expect((await getServerRecipe(deps(store), '   ')).recipe).toBeNull();
  });

  it('⛔⛔ HIDES A KERNEL RECIPE, exactly as the list does', async () => {
    // A fourth door onto the store. The rule existed at three and was missing
    // at the list once already; a `get` that answered would reopen it by a
    // different route — and by id, which is how a deep link arrives.
    const store = createRecipeStore('/nonexistent', db);
    store.save(kernelRecipe('memory-embed'), 'recued-core', 'pair-sync', 1_700_001_000_000);
    expect((await getServerRecipe(deps(store), 'memory-embed')).recipe).toBeNull();
  });

  it('🔑 AGREES WITH `recipe.list` ENTRY-FOR-ENTRY over the same store', async () => {
    // The no-drift assertion. Both doors build entries through one shared
    // builder; this fails the moment either grows a rule the other lacks,
    // without needing a test per rule.
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('alpha'), 'acme', 'pair-sync', 1_700_002_000_000);
    store.save(recipe('beta', 3), 'recued-core', 'pair-sync', 1_700_001_000_000);
    store.save(kernelRecipe('memory-embed'), 'recued-core', 'pair-sync', 1_700_003_000_000);

    const listed = (await listServerRecipes(deps(store))).recipes;
    expect(listed.length).toBeGreaterThan(0);
    for (const entry of listed) {
      const got = (await getServerRecipe(deps(store), entry.recipe_id)).recipe;
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
    expect((await getServerRecipe(deps(store), 'memory-embed')).recipe).toBeNull();
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

  it('projects TRUE for a recipe whose only op is declared read', async () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(withOp('reader', 'acme.demo-pack.look_thing'), 'acme', 'pair-sync', 1_700_001_000_000);
    const out = (await listServerRecipes({
      store, serverStartedAt: SERVER_STARTED_AT, packRoster: roster('look_thing', 'read'),
    })).recipes;
    expect(out[0]!.provably_read_only).toBe(true);
  });

  it('⛔ projects FALSE for a WRITE op — the answer that must never fail open', async () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(withOp('writer', 'acme.demo-pack.change_thing'), 'acme', 'pair-sync', 1_700_001_000_000);
    const out = (await listServerRecipes({
      store, serverStartedAt: SERVER_STARTED_AT, packRoster: roster('change_thing', 'write'),
    })).recipes;
    expect(out[0]!.provably_read_only).toBe(false);
  });

  it('⛔ projects FALSE when the op does not resolve — unknown is not harmless', async () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(withOp('mystery', 'acme.demo-pack.unlisted_thing'), 'acme', 'pair-sync', 1_700_001_000_000);
    const out = (await listServerRecipes({
      store, serverStartedAt: SERVER_STARTED_AT, packRoster: roster('look_thing', 'read'),
    })).recipes;
    expect(out[0]!.provably_read_only).toBe(false);
  });

  it('⛔ carries a NULL connection kind as null, never the string "null"', async () => {
    // The first cut of this projection did `String(c.kind)`. `kind` is
    // `ConnectionKind | null` and the null is MEANINGFUL — the need came from
    // a `read_connection_*` permission, not a typed ref — so stringifying it
    // shipped a `"null"` kind to every client, which reads as a real kind.
    const store = createRecipeStore('/nonexistent', db);
    store.save({
      ...recipe('permits'),
      requires: ['read_connection_personio'],
    } as unknown as RecipeDefinition, 'acme', 'pair-sync', 1_700_001_000_000);
    const out = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT })).recipes;
    const conns = out[0]!.required_connections ?? [];
    expect(conns).toStrictEqual([{ kind: null, name: 'personio' }]);
    for (const c of conns) expect(c.kind).not.toBe('null');
  });

  it('omits the field entirely when no roster is wired', async () => {
    // An older/dbless server projects nothing rather than guessing. The client
    // then answers from the row's steps if it still has them, and otherwise
    // treats the recipe as NOT proven read-only (`provablyReadOnly` in
    // `pack-app-model.ts`): a trimmed row cannot prove anything.
    const store = createRecipeStore('/nonexistent', db);
    store.save(withOp('reader', 'acme.demo-pack.look_thing'), 'acme', 'pair-sync', 1_700_001_000_000);
    const out = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT })).recipes;
    expect(out[0]!.provably_read_only).toBeUndefined();
    expect('provably_read_only' in out[0]!).toBe(false);
  });

  it('⛔ projects spends_per_run from the body — always, since it needs no roster', async () => {
    // The client used to compute this from the list row, which has no steps, so
    // it always answered "does not spend" and the cost gate on views was off.
    const store = createRecipeStore('/nonexistent', db);
    store.save(withOp('thinker', 'core.ai.classify'), 'acme', 'pair-sync', 1_700_001_000_000);
    store.save(withOp('reader', 'acme.demo-pack.look_thing'), 'acme', 'pair-sync', 1_700_001_000_000);
    const rows = new Map((await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }))
      .recipes.map((row) => [row.recipe_id, row]));
    expect(rows.get('thinker')!.spends_per_run).toBe(true);
    expect(rows.get('reader')!.spends_per_run).toBe(false);
  });

  it('⛔ projects spends_per_run TRUE for a pack op its vendor bills per call', async () => {
    // A metered vendor API is `risk: 'read'`, so it is read-only and only its
    // `spends_per_call` mark, found through the roster, says it costs.
    const store = createRecipeStore('/nonexistent', db);
    store.save(withOp('asker', 'acme.demo-pack.ask_thing'), 'acme', 'pair-sync', 1_700_001_000_000);
    const metered = () => [{
      slug: 'demo-pack', publisher: 'acme', name: 'Demo',
      manifest: { contents: [{ type: 'composition', composition: {
        operations: [{ op: 'ask_thing', risk: 'read', spends_per_call: true }],
      } }] },
    }] as never;
    const out = (await listServerRecipes({
      store, serverStartedAt: SERVER_STARTED_AT, packRoster: metered,
    })).recipes;
    expect(out[0]!.provably_read_only).toBe(true);
    expect(out[0]!.spends_per_run).toBe(true);
    // The same op unmarked does not spend.
    const unmarked = (await listServerRecipes({
      store, serverStartedAt: SERVER_STARTED_AT, packRoster: roster('ask_thing', 'read'),
    })).recipes;
    expect(unmarked[0]!.spends_per_run).toBe(false);
  });

  it('`recipe.get` projects it identically', async () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(withOp('writer', 'acme.demo-pack.change_thing'), 'acme', 'pair-sync', 1_700_001_000_000);
    const d = { store, serverStartedAt: SERVER_STARTED_AT, packRoster: roster('change_thing', 'write') };
    // Same projection from both doors; only the body differs.
    expect((await getServerRecipe(d, 'writer')).recipe!.provably_read_only)
      .toBe((await listServerRecipes(d)).recipes[0]!.provably_read_only);
    expect((await getServerRecipe(d, 'writer')).recipe!.required_connections)
      .toStrictEqual((await listServerRecipes(d)).recipes[0]!.required_connections);
  });
});

/** Paging (internal design notes). One row per installed
 *  recipe, so the unpaged frame grows with installs; `recipe.list` was 3.81 MB
 *  at 2,369 recipes after its step bodies came off. */
describe('recipe.list paged', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  const seed = (n: number) => {
    const store = createRecipeStore('/nonexistent', db);
    for (let i = 0; i < n; i += 1) {
      // Mixed timestamps, so the sort order is not insertion order.
      store.save(recipe(`r-${String(i).padStart(2, '0')}`), 'acme', 'pair-sync', 1_700_001_000_000 + (i % 3));
    }
    return store;
  };

  it('an unpaged request answers exactly as before — no paging fields', async () => {
    const store = seed(4);
    const deps = { store, serverStartedAt: SERVER_STARTED_AT };
    const handler = makeRecipeListHandlers(deps)!.handlers['recipe.list']!;
    for (const args of [undefined, {}]) {
      const answer = await handler(args as never, {} as never);
      expect(Object.keys(answer)).toEqual(['recipes']);
      expect(answer).toEqual((await listServerRecipes(deps)));
    }
  });

  it('pages reassemble to the unpaged list in its sort order, from ONE build of the list', async () => {
    const store = seed(11);
    let builds = 0;
    // `listStored` is read once per build of the list — a count of builds. (Not
    // `packRoster`: that is read once per REQUEST, before paging, because naming
    // a Records catalog is async and the pager's compute is not.)
    const listStored = store.listStored.bind(store);
    (store as { listStored: typeof listStored }).listStored = () => {
      builds += 1;
      return listStored();
    };
    const deps = { store, serverStartedAt: SERVER_STARTED_AT, packRoster: () => [] };
    const unpaged = (await listServerRecipes(deps)).recipes;
    builds = 0;

    const handler = makeRecipeListHandlers(deps)!.handlers['recipe.list']!;
    const totals: Array<number | undefined> = [];
    const collected = await collectListPages({
      limit: 3,
      fetchPage: async (request) => {
        const page = await handler(request, {} as never);
        totals.push(page.total);
        return { items: page.recipes, next_cursor: page.next_cursor, total: page.total };
      },
    });

    expect(collected).toEqual(unpaged);
    // It really paged: 11 rows at 3 a page, every page naming the same total.
    expect(totals).toEqual([11, 11, 11, 11]);
    expect(collected.map((r) => r.recipe_id)).not.toEqual([...collected.map((r) => r.recipe_id)].sort());
    expect(builds).toBe(1);
  });
});

/** D-292 — the `spreadsheet_import` projection.
 *
 *  ⛔⛔ THE SAME SHAPE AS `provably_read_only`, FOUND THE SAME WAY. The guided
 *  import is only safe when the recipe's preview switch reaches its import's
 *  `dry_run` — a fact read off the STEP BODIES this list strips. A client judging
 *  the trimmed row found no switch and refused every importer (failing closed, so
 *  silently); a live drive saw the plain form open where the guided one should.
 *  The server judges the full body and projects the answer. */
describe('spreadsheet_import projection', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });

  const importer = (dryRun: unknown): RecipeDefinition => ({
    ...recipe('import-things'),
    metadata: {
      ...recipe('import-things').metadata,
      spreadsheet_import: { file: 'file', preview: 'check_first', columns: ['column_name'] },
    },
    variables: {
      file: { label: 'CSV', type: 'file_ref' },
      column_name: { label: 'Column holding the name', type: 'string', default: 'Name' },
      check_first: { label: 'Check first', type: 'boolean', default: false },
    },
    steps: [
      { id: 'read', op: 'core.storage.data-file-read', args: { record_id: '{{config.file}}' } },
      { id: 'imported', op: 'acme.things.thing.import', args: {
        csv: '{{step.read.bytes_b64}}', dry_run: dryRun,
        spec: { columns: [{ column: '{{config.column_name}}', field: 'name' }] },
      } },
    ],
  } as unknown as RecipeDefinition);

  it('carries the declaration on a row that no longer carries the steps it was judged on', async () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(importer('{{config.check_first}}'), 'acme', 'pair-sync', 1_700_001_000_000);
    const [row] = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT })).recipes;
    expect((row!.recipe as { steps?: unknown }).steps, 'the list row is trimmed').toBeUndefined();
    expect(row!.spreadsheet_import).toEqual({
      file: 'file', preview: 'check_first', columns: ['column_name'],
    });
  });

  it('⛔ projects NOTHING when the switch does not reach dry_run — Check would import for real', async () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(importer(false), 'acme', 'pair-sync', 1_700_001_000_000);
    const [row] = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT })).recipes;
    expect(row!.spreadsheet_import).toBeUndefined();
  });

  it('projects nothing for a recipe that declares no spreadsheet import', async () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('ordinary'), 'acme', 'pair-sync', 1_700_001_000_000);
    const [row] = (await listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT })).recipes;
    expect(row).not.toHaveProperty('spreadsheet_import');
  });

  // The shipped bank importer's projection lives in
  // `recipe-list-handler-shipped-importer.test.ts`: it reads a marketplace recipe,
  // which the public source export does not carry.
});


/** The card's pills (`recipe-card-facts.ts`): channels and enrichment reads
 *  live in `steps`, which the list row does not carry. */
describe('recipe.list projects the card pills from the body', () => {
  it('⛔ a trimmed row still carries what only its steps named, and recipe.get agrees', async () => {
    const db = new Database(':memory:');
    const store = createRecipeStore('/nonexistent', db);
    store.save({
      ...recipe('deal-alert'),
      steps: [
        { id: 'score', op: 'core.data.read', args: { ref: '{{data.enrichment.contact.alice.deal_risk}}' } },
        { id: 'notify', op: 'notification.slack.post', args: { text: 'heads up' } },
      ],
    } as unknown as RecipeDefinition, 'acme', 'pair-sync', 1_700_001_000_000);
    const deps = { store, serverStartedAt: SERVER_STARTED_AT };

    const row = (await listServerRecipes(deps)).recipes[0]!;
    // The body the pills come from is NOT on the row…
    expect('steps' in row.recipe).toBe(false);
    // …so the answers have to be.
    expect(row.notification_channels).toContain('slack');
    expect(row.consumed_enrichments).toEqual(['data.enrichment.contact.alice.deal_risk']);

    const full = (await getServerRecipe(deps, 'deal-alert')).recipe!;
    expect(full.notification_channels).toEqual(row.notification_channels);
    expect(full.consumed_enrichments).toEqual(row.consumed_enrichments);
  });
});
