/** `recipe.runnability` read-surface handler tests — the D-182 step 8 R1
 *  DISCLOSURE half.
 *
 *  The rpc + `recipe_runnability_changed` broadcast are RE-GROUNDED on the R1
 *  verb-split (`applyKernelOpRunnability` per recipe over the live bound
 *  convention families), NOT the dropped capability-DI `dependencies` graph. The
 *  wire shape (`RecipeRunnabilityEntry`) is unchanged — `dependencies` is now
 *  synthesized from the R1 entries. These tests pin:
 *    - the slice shape + the `undefined`-deps → omit (→ `not_configured`) gate;
 *    - the R1 status map: unbound canonical READ → `degraded` (empty + warn),
 *      unbound canonical WRITE → `blocked` (fail closed), bound family / no
 *      canonical op / closed-kind / legacy bare op → `runnable`;
 *    - the synthesized per-family `dependencies` detail (capability = the family,
 *      `optional` = read-only, always unsatisfied);
 *    - disclosure MATCHES enforcement: the built-in crm/acct registry (HubSpot /
 *      Salesforce lift `crm`; NO built-in lifts `acct`) — the deferred
 *      merged-registry gap is shared with the run path;
 *    - recompute-on-emit (a connection bound between two reads flips the status).
 *
 *  The `listRecipesWorsenedByPackUninstall` reverse-walk (install/uninstall
 *  disclosure) is DELIBERATELY left on the capability-DI path for now (the
 *  coordinated cleanup slice re-grounds it) — its describe blocks below still
 *  assert capability-DI `dependencies` behavior and are unchanged.
 *
 *  Fakes only — the handler + service are Pick-narrowed over their stores.
 */
import { describe, it, expect } from 'vitest';
import type {
  ConnectionRow,
  EntitySchemaIngredientInput,
  IngredientManifest,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { RecipeStore } from '../recipe-store.js';
import type { LocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import {
  listRecipeRunnability,
  listRecipesWorsenedByPackUninstall,
  makeRecipeRunnabilityBroadcaster,
  makeRecipeRunnabilityHandlers,
  type RecipeRunnabilityHandlerDeps,
} from '../recipe-runnability-handler.js';
import type { RecipeRunnabilityEntry } from '@recued/contracts';

// ──────────────── fakes (mirror the 4b service test) ────────────────

const mkRow = (name: string, vendor: string | null): ConnectionRow => ({
  pk: `api:${name}`,
  kind: 'api',
  name,
  display_name: name,
  config_json: vendor === null ? '{}' : JSON.stringify({ vendor }),
  auth_ciphertext: '',
  enrolled_at: 0,
  updated_at: 0,
});

const connectionStoreOf = (rows: ConnectionRow[]): Pick<ConnectionStoreSqlite, 'list'> => ({
  list: (query) => (query?.kind ? rows.filter((r) => r.kind === query.kind) : rows),
});

const recipeStoreOf = (recipes: RecipeDefinition[]): Pick<RecipeStore, 'get' | 'ids'> => {
  const map = new Map(recipes.map((r) => [r.recipe_id, r]));
  return { ids: () => [...map.keys()], get: (id) => map.get(id) ?? null };
};

/** An R1 recipe: each op id becomes one op-step (`{ id, op }`). The R1 walk
 *  classifies `core.crm.*` / `core.acct.*` ops by verb; everything else
 *  (closed-kind `core.ai.*`, a legacy bare `deal.search`, a Tier-P op) is left
 *  untouched (runnable). */
const mkOpRecipe = (recipe_id: string, ops: string[]): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  metadata: {
    name: recipe_id,
    description: 'a test recipe',
    author: 'recued-core',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: ops.map((op, i): RecipeStep => ({ id: 's' + i, op })),
  output: { sidebar: [] },
});

/** A minimal valid `EntitySchemaIngredientInput` carrying the fields
 *  `vendorEntitiesFromComposition` lifts (`wraps_vendor` / `crm_alias` /
 *  `entity_id`); the rest are required-but-unread shape (copied from
 *  `connection-agnostic-registry.test.ts`'s fixture). */
const mkEntitySchema = (
  wraps_vendor: string,
  crm_alias: 'deal' | 'contact' | 'account',
  entity_id: string,
): EntitySchemaIngredientInput => ({
  ingredient_id: `${wraps_vendor}-crm`,
  wraps_vendor,
  entity_id,
  scope: `connection.api.${wraps_vendor}.${entity_id}`,
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  crm_alias,
  target_id: { fields: ['id'], template: `${entity_id}_{id}` },
  meta_fields: [{ key: 'id', type: 'string', source_path: 'id' }],
  source_operations: {},
});

/** The accounting twin of `mkEntitySchema` — lifts an `acct_alias` entity (a
 *  pack-composition acct vendor like QuickBooks / Xero, NOT a built-in). */
const mkAcctEntitySchema = (
  wraps_vendor: string,
  acct_alias: 'invoice',
  entity_id: string,
): EntitySchemaIngredientInput => ({
  ingredient_id: `${wraps_vendor}-acct`,
  wraps_vendor,
  entity_id,
  scope: `connection.api.${wraps_vendor}.${entity_id}`,
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  acct_alias,
  target_id: { fields: ['id'], template: `${entity_id}_{id}` },
  meta_fields: [{ key: 'id', type: 'string', source_path: 'id' }],
  source_operations: {},
});

/** A `localManifestStore` fake over a mutable `slug → entity_schemas[]` map (so a
 *  test can "install" a pack between two reads). Only the two methods the handler
 *  reads are implemented; `listManifests` returns minimal slug-only manifests. */
const localManifestStoreOf = (
  manifests: Map<string, EntitySchemaIngredientInput[]>,
): Pick<LocalManifestStore, 'listManifests' | 'getEntitySchemas'> => ({
  // The handler reads only `.slug`; a minimal stand-in keeps the fake honest.
  listManifests: () =>
    [...manifests.keys()].map((slug) => ({ slug }) as unknown as IngredientManifest),
  getEntitySchemas: (slug) => manifests.get(slug) ?? [],
});

// ──────────────── tests ────────────────

describe('makeRecipeRunnabilityHandlers', () => {
  it('returns undefined when deps are absent (rpc → not_configured)', () => {
    expect(makeRecipeRunnabilityHandlers(undefined)).toBeUndefined();
  });

  it('claims exactly the `recipe.runnability` method', () => {
    const deps: RecipeRunnabilityHandlerDeps = {
      connectionStore: connectionStoreOf([]),
      recipeStore: recipeStoreOf([]),
    };
    expect(makeRecipeRunnabilityHandlers(deps)?.methods).toEqual(['recipe.runnability']);
  });

  it('the handler resolves to the same payload as listRecipeRunnability (R1 verdict)', async () => {
    // No CRM connection bound → an unbound canonical READ degrades, and the
    // synthesized per-family detail rides through the handler closure unchanged.
    const deps: RecipeRunnabilityHandlerDeps = {
      connectionStore: connectionStoreOf([]),
      recipeStore: recipeStoreOf([mkOpRecipe('searches-deals', ['core.crm.deal.search'])]),
    };
    const slice = makeRecipeRunnabilityHandlers(deps);
    const fromHandler = await slice!.handlers['recipe.runnability'](
      undefined as never,
      undefined as never,
    );
    expect(fromHandler).toEqual(listRecipeRunnability(deps));
    expect(fromHandler.recipes).toEqual([
      {
        recipe_id: 'searches-deals',
        status: 'degraded',
        dependencies: [
          {
            capability: 'crm',
            ops: ['search'],
            optional: true,
            satisfied: false,
            providers: [],
            unprovided_ops: ['search'],
          },
        ],
      },
    ]);
  });
});

describe('listRecipeRunnability — R1 verb-split', () => {
  const runFor = (
    recipes: RecipeDefinition[],
    rows: ConnectionRow[] = [],
  ): RecipeRunnabilityEntry[] =>
    listRecipeRunnability({
      connectionStore: connectionStoreOf(rows),
      recipeStore: recipeStoreOf(recipes),
    }).recipes;

  it('unbound canonical READ → degraded (empty + warn), with synthesized per-family detail', () => {
    const [r] = runFor([mkOpRecipe('r', ['core.crm.deal.search'])]);
    expect(r.status).toBe('degraded');
    expect(r.dependencies).toEqual([
      { capability: 'crm', ops: ['search'], optional: true, satisfied: false, providers: [], unprovided_ops: ['search'] },
    ]);
  });

  it('unbound canonical WRITE → blocked (fail closed), hard dependency', () => {
    const [r] = runFor([mkOpRecipe('r', ['core.crm.deal.create'])]);
    expect(r.status).toBe('blocked');
    expect(r.dependencies).toEqual([
      { capability: 'crm', ops: ['create'], optional: false, satisfied: false, providers: [], unprovided_ops: ['create'] },
    ]);
  });

  it('a bound CRM vendor (HubSpot) → runnable, empty detail', () => {
    expect(runFor([mkOpRecipe('r', ['core.crm.deal.search'])], [mkRow('hs', 'hubspot')])).toEqual([
      { recipe_id: 'r', status: 'runnable', dependencies: [] },
    ]);
  });

  it('Salesforce binds the crm family too (built-ins resolve SF) → an unbound WRITE becomes runnable', () => {
    expect(
      runFor([mkOpRecipe('r', ['core.crm.deal.create'])], [mkRow('sf', 'salesforce')])[0].status,
    ).toBe('runnable');
  });

  it('no canonical op → runnable: empty steps, a closed-kind core.ai.*, a legacy bare op, a Tier-P op all pass through', () => {
    expect(
      runFor([
        mkOpRecipe('none', []),
        mkOpRecipe('ai', ['core.ai.summarize']), // closed-kind → always present
        mkOpRecipe('legacy', ['deal.search']), // one-dot bare canonical → left to the pick layer
        mkOpRecipe('tierp', ['recued-core.hubspot.deal.read']), // Tier-P concrete op
      ]).map((r) => ({ recipe_id: r.recipe_id, status: r.status })),
    ).toEqual([
      { recipe_id: 'none', status: 'runnable' },
      { recipe_id: 'ai', status: 'runnable' },
      { recipe_id: 'legacy', status: 'runnable' },
      { recipe_id: 'tierp', status: 'runnable' },
    ]);
  });

  it('mixed unbound write + read across families → blocked; detail spans BOTH families, sorted', () => {
    // A crm WRITE (hard → blocked) and an acct READ (would degrade) in one recipe:
    // the write dominates the status (blocked); the synthesized detail names both
    // unbound families, sorted (`acct` before `crm`), each with its own `optional`.
    const [r] = runFor([mkOpRecipe('r', ['core.crm.deal.create', 'core.acct.invoice.search'])]);
    expect(r.status).toBe('blocked');
    expect(r.dependencies).toEqual([
      { capability: 'acct', ops: ['search'], optional: true, satisfied: false, providers: [], unprovided_ops: ['search'] },
      { capability: 'crm', ops: ['create'], optional: false, satisfied: false, providers: [], unprovided_ops: ['create'] },
    ]);
  });

  it('multiple ops in one family collapse to one detail entry, verbs sorted + deduped', () => {
    const [r] = runFor([
      mkOpRecipe('r', ['core.crm.deal.search', 'core.crm.contact.read', 'core.crm.deal.search']),
    ]);
    expect(r.status).toBe('degraded'); // all reads
    expect(r.dependencies).toEqual([
      { capability: 'crm', ops: ['read', 'search'], optional: true, satisfied: false, providers: [], unprovided_ops: ['read', 'search'] },
    ]);
  });
});

describe('listRecipeRunnability — merged registry binds pack-composition vendors (Fix 2)', () => {
  // R1 derives bound families from the LIVE merged registry (`liveVendorRegistry`:
  // built-ins + each installed pack's decomposed crm/acct entities) — the SAME
  // registry the run path (`execute-handler`) uses, so a connected 3rd-party CRM vendor
  // or `acct` vendor (QuickBooks / Xero ship via pack composition, not the built-in
  // const) binds its family at disclosure exactly as it does at run-time.
  it('a 3rd-party CRM vendor connection binds crm via the installed pack (rpc reads localManifestStore)', () => {
    const out = listRecipeRunnability({
      connectionStore: connectionStoreOf([mkRow('acme-conn', 'acme')]),
      recipeStore: recipeStoreOf([mkOpRecipe('r', ['core.crm.deal.search'])]),
      // The pack lifts the acme CRM `deal` entity → merged registry maps acme → crm.
      localManifestStore: localManifestStoreOf(
        new Map([['acme-pack', [mkEntitySchema('acme', 'deal', 'acmedeal')]]]),
      ),
    });
    expect(out.recipes[0].status).toBe('runnable');
  });

  it('a connected acct vendor (QuickBooks) binds acct via the installed pack — the write no longer blocks', () => {
    const out = listRecipeRunnability({
      connectionStore: connectionStoreOf([mkRow('qb', 'quickbooks')]),
      recipeStore: recipeStoreOf([mkOpRecipe('r', ['core.acct.invoice.create'])]),
      localManifestStore: localManifestStoreOf(
        new Map([['qb-pack', [mkAcctEntitySchema('quickbooks', 'invoice', 'qbinvoice')]]]),
      ),
    });
    expect(out.recipes[0].status).toBe('runnable');
  });

  it('a connected acct vendor with NO installed pack stays blocked (fail-safe: built-ins only)', () => {
    const out = listRecipeRunnability({
      connectionStore: connectionStoreOf([mkRow('qb', 'quickbooks')]),
      recipeStore: recipeStoreOf([mkOpRecipe('r', ['core.acct.invoice.create'])]),
    });
    expect(out.recipes[0].status).toBe('blocked'); // write → fail closed
  });
});

describe('makeRecipeRunnabilityBroadcaster (reactive emit)', () => {
  const liveDeps = (rows: ConnectionRow[] = []): RecipeRunnabilityHandlerDeps => ({
    connectionStore: connectionStoreOf(rows),
    recipeStore: recipeStoreOf([mkOpRecipe('r', ['core.crm.deal.search'])]),
  });

  it('recomputeAndEmit emits recipe_runnability_changed carrying the read-surface snapshot', () => {
    const deps = liveDeps([mkRow('hs', 'hubspot')]); // crm bound → runnable
    const events: Array<{ kind: string; recipes: readonly RecipeRunnabilityEntry[] }> = [];
    makeRecipeRunnabilityBroadcaster(deps, (e) => {
      events.push(e);
    }).recomputeAndEmit();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('recipe_runnability_changed');
    // Identical to what a `recipe.runnability` re-read returns (one source of truth).
    expect(events[0].recipes).toEqual(listRecipeRunnability(deps).recipes);
    expect(events[0].recipes[0]).toMatchObject({ recipe_id: 'r', status: 'runnable' });
  });

  it('is best-effort: a throwing emit is swallowed (never surfaces to the mutation)', () => {
    const b = makeRecipeRunnabilityBroadcaster(liveDeps(), () => {
      throw new Error('bus down');
    });
    expect(() => b.recomputeAndEmit()).not.toThrow();
  });

  it('is best-effort: a throwing recompute (store failure) is swallowed + emits nothing', () => {
    const events: unknown[] = [];
    const b = makeRecipeRunnabilityBroadcaster(
      {
        connectionStore: {
          list: () => {
            throw new Error('db gone');
          },
        },
        recipeStore: recipeStoreOf([mkOpRecipe('r', ['core.crm.deal.search'])]),
      },
      (e) => {
        events.push(e);
      },
    );
    expect(() => b.recomputeAndEmit()).not.toThrow();
    expect(events).toEqual([]); // the recompute threw BEFORE emit
  });

  it('re-emits a FRESH snapshot each call (recompute-on-emit, no captured snapshot)', () => {
    // Mutating the live connection set between emits flips the verdict — proves the
    // broadcaster recomputes on every call (the connection-broadcast recompute path).
    const rows: ConnectionRow[] = [];
    const events: Array<{ recipes: readonly RecipeRunnabilityEntry[] }> = [];
    const b = makeRecipeRunnabilityBroadcaster(
      {
        connectionStore: { list: (q) => (q?.kind ? rows.filter((r) => r.kind === q.kind) : rows) },
        recipeStore: recipeStoreOf([mkOpRecipe('r', ['core.crm.deal.search'])]),
      },
      (e) => {
        events.push(e);
      },
    );
    b.recomputeAndEmit(); // no CRM bound → unbound read degrades
    rows.push(mkRow('hs', 'hubspot')); // bind HubSpot → crm family now bound
    b.recomputeAndEmit(); // → runnable
    expect(events.map((e) => e.recipes[0].status)).toEqual(['degraded', 'runnable']);
  });
});

describe('listRecipesWorsenedByPackUninstall — R1 reverse-walk (registry shrink)', () => {
  const PACK = 'the-pack';

  /** The pack's local CRM composition catalog: `acme-pack` lifts vendor `acme` →
   *  the `crm` family. Uninstalling the pack deletes this catalog, so `acme` leaves
   *  the merged registry and any connection carrying it loses its `crm` mapping. */
  const acmePack = () =>
    localManifestStoreOf(new Map([['acme-pack', [mkEntitySchema('acme', 'deal', 'acmedeal')]]]));

  /** `localCatalogDropIdsForPack` fake — the refcount-aware local-catalog ids the
   *  uninstall of `forPack` deletes (any other pack drops nothing). */
  const dropIds =
    (forPack: string, ...ids: string[]) =>
    (pack_slug: string): string[] =>
      pack_slug === forPack ? ids : [];

  it("a connection's pack-composition CRM vendor leaving the registry → its READ recipe degrades", () => {
    // Before: `acme` in the merged registry (the catalog is installed) → `acme-conn`
    // binds crm → the search READ is runnable. After: uninstall deletes `acme-pack`
    // → `acme` gone → crm unbound → an unbound canonical READ degrades.
    const out = listRecipesWorsenedByPackUninstall(
      {
        connectionStore: connectionStoreOf([mkRow('acme-conn', 'acme')]),
        recipeStore: recipeStoreOf([mkOpRecipe('r', ['core.crm.deal.search'])]),
        localManifestStore: acmePack(),
        localCatalogDropIdsForPack: dropIds(PACK, 'acme-pack'),
      },
      PACK,
    );
    expect(out).toEqual([{ recipe_id: 'r', before: 'runnable', after: 'degraded' }]);
  });

  it('registry shrink, NOT connection removal: a connection NEVER bound to the pack still worsens (its WRITE recipe blocks)', () => {
    // The case a binding-based walk MISSES: `acme-conn` carries vendor `acme` but was
    // never bound to `the-pack` (there is no binding store in the deps at all). The
    // walk reasons purely about the registry — uninstall deletes the `acme-pack`
    // catalog that CONTRIBUTED the `acme` vendor, so the family unbinds regardless of
    // which connection happens to carry it. A canonical WRITE then fails closed.
    const out = listRecipesWorsenedByPackUninstall(
      {
        connectionStore: connectionStoreOf([mkRow('acme-conn', 'acme')]),
        recipeStore: recipeStoreOf([mkOpRecipe('r', ['core.crm.deal.create'])]),
        localManifestStore: acmePack(),
        localCatalogDropIdsForPack: dropIds(PACK, 'acme-pack'),
      },
      PACK,
    );
    expect(out).toEqual([{ recipe_id: 'r', before: 'runnable', after: 'blocked' }]);
  });

  it('a recipe-only pack (no droppable local catalog) → []', () => {
    // `dropIds` returns [] → the registry is unchanged → no R1 family can become
    // unbound → the FAMILY diff worsens nothing.
    //
    // ⚠ This used to assert the walk returned before reading any recipe, proved
    // by a throwing `recipeStore`. That laziness guarantee is deliberately gone:
    // the Tier-P (`depends_on`) arm runs FIRST and unconditionally, because
    // sitting behind this very short-circuit is what made a connection-less cli
    // pack's uninstall disclose nothing. The OUTCOME is unchanged and is what
    // this test was really about — a recipe-only pack declares no ops, so no
    // recipe can name it in `depends_on` either.
    expect(
      listRecipesWorsenedByPackUninstall(
        {
          connectionStore: connectionStoreOf([mkRow('acme-conn', 'acme')]),
          recipeStore: recipeStoreOf([mkOpRecipe('unrelated', ['core.crm.deal.search'])]),
          localManifestStore: acmePack(),
          localCatalogDropIdsForPack: dropIds(PACK /* no ids */),
        },
        PACK,
      ),
    ).toEqual([]);
  });

  it('a BUILT-IN vendor connection is immune — dropping a pack catalog it never used → []', () => {
    // Only a HubSpot connection is enrolled. HubSpot is a built-in vendor, so crm
    // stays bound after the `acme-pack` drop → no transition. (Guards against a
    // registry rebuild wrongly perturbing built-in vendors.)
    expect(
      listRecipesWorsenedByPackUninstall(
        {
          connectionStore: connectionStoreOf([mkRow('hs', 'hubspot')]),
          recipeStore: recipeStoreOf([mkOpRecipe('r', ['core.crm.deal.create'])]),
          localManifestStore: acmePack(),
          localCatalogDropIdsForPack: dropIds(PACK, 'acme-pack'),
        },
        PACK,
      ),
    ).toEqual([]);
  });

  it('last-family semantics: a recipe still covered by a SURVIVING built-in connection does NOT worsen', () => {
    // `acme-conn` loses crm when `acme-pack` drops, but a registered HubSpot
    // connection still binds crm → the recipe stays runnable.
    expect(
      listRecipesWorsenedByPackUninstall(
        {
          connectionStore: connectionStoreOf([mkRow('acme-conn', 'acme'), mkRow('hs', 'hubspot')]),
          recipeStore: recipeStoreOf([mkOpRecipe('r', ['core.crm.deal.create'])]),
          localManifestStore: acmePack(),
          localCatalogDropIdsForPack: dropIds(PACK, 'acme-pack'),
        },
        PACK,
      ),
    ).toEqual([]);
  });

  it('per-FAMILY filtering: dropping the crm catalog degrades a crm recipe but leaves an acct recipe untouched', () => {
    // `acme-pack` (crm) is dropped; the `qb-pack` (acct, QuickBooks) catalog survives
    // (not in the drop set). The crm recipe degrades; the acct recipe stays runnable.
    const out = listRecipesWorsenedByPackUninstall(
      {
        connectionStore: connectionStoreOf([mkRow('acme-conn', 'acme'), mkRow('qb', 'quickbooks')]),
        recipeStore: recipeStoreOf([
          mkOpRecipe('crm-r', ['core.crm.deal.search']),
          mkOpRecipe('acct-r', ['core.acct.invoice.search']),
        ]),
        localManifestStore: localManifestStoreOf(
          new Map([
            ['acme-pack', [mkEntitySchema('acme', 'deal', 'acmedeal')]],
            ['qb-pack', [mkAcctEntitySchema('quickbooks', 'invoice', 'qbinvoice')]],
          ]),
        ),
        localCatalogDropIdsForPack: dropIds(PACK, 'acme-pack'),
      },
      PACK,
    );
    expect(out).toEqual([{ recipe_id: 'crm-r', before: 'runnable', after: 'degraded' }]);
  });

  it('a refcount-shared catalog (NOT in the drop set) survives → []', () => {
    // `privateByoDropIds` is refcount-aware: a catalog another pack still lists is
    // not deleted, so it is absent from `dropIds`. The `acme` vendor stays in the
    // registry → no family unbinds → no transition.
    expect(
      listRecipesWorsenedByPackUninstall(
        {
          connectionStore: connectionStoreOf([mkRow('acme-conn', 'acme')]),
          recipeStore: recipeStoreOf([mkOpRecipe('r', ['core.crm.deal.create'])]),
          localManifestStore: acmePack(),
          localCatalogDropIdsForPack: dropIds(PACK /* acme-pack shared → not dropped */),
        },
        PACK,
      ),
    ).toEqual([]);
  });

  it('absent drop-ids callback OR absent manifest store → [] (best-effort: discloses nothing)', () => {
    const base = {
      connectionStore: connectionStoreOf([mkRow('acme-conn', 'acme')]),
      recipeStore: recipeStoreOf([mkOpRecipe('r', ['core.crm.deal.create'])]),
    };
    // No drop-ids callback (dbless / no contract store).
    expect(
      listRecipesWorsenedByPackUninstall({ ...base, localManifestStore: acmePack() }, PACK),
    ).toEqual([]);
    // No manifest store (nothing to drop from).
    expect(
      listRecipesWorsenedByPackUninstall(
        { ...base, localCatalogDropIdsForPack: dropIds(PACK, 'acme-pack') },
        PACK,
      ),
    ).toEqual([]);
  });
});

/** The Tier-P arm of the uninstall reverse-walk.
 *
 *  ⛔ THE BUG THIS FIXES WAS AN EMPTY LIST. R1 runnability is a pure function of
 *  bound CONNECTION families, so both short-circuits in the family walk
 *  (`dropIds.size === 0`, `afterFamilies.size === beforeFamilies.size`) hold for
 *  a pack that enrols no connection. Uninstalling docling / whisper / ffmpeg /
 *  officecli therefore disclosed NOTHING while its dependent recipes were about
 *  to stop working — 121 shipped packs are `service_kind: cli` and 34 recipes
 *  depend on one. An empty would-disable list reads as "nothing is affected",
 *  not "I did not look".
 *
 *  A recipe naming a Tier-P op of the departing pack does not degrade; it cannot
 *  start. `lowerSequentialStep` throws for "a two-tier id that resolves to
 *  nothing" before step 1, so `after` is `blocked`. */
describe('uninstall reverse-walk — Tier-P (depends_on) arm', () => {
  const cliRecipe = (recipe_id: string, packRef: string, ops: string[]): RecipeDefinition => ({
    ...mkOpRecipe(recipe_id, ops),
    depends_on: [packRef],
  } as RecipeDefinition);

  it('discloses a recipe blocked by uninstalling a connection-less cli pack', () => {
    // The exact shape the old walk missed: no connection, no local catalog to
    // drop, so every family-based short-circuit returns early.
    const out = listRecipesWorsenedByPackUninstall({
      connectionStore: connectionStoreOf([]),
      recipeStore: recipeStoreOf([
        cliRecipe('parse-a-pdf', 'recued-core.docling', ['recued-core.docling.document.to_markdown']),
      ]),
    }, 'docling');
    expect(out).toEqual([{ recipe_id: 'parse-a-pdf', before: 'runnable', after: 'blocked' }]);
  });

  it('leaves recipes that do not name the pack alone', () => {
    const out = listRecipesWorsenedByPackUninstall({
      connectionStore: connectionStoreOf([]),
      recipeStore: recipeStoreOf([
        cliRecipe('uses-whisper', 'recued-core.whisper', ['recued-core.whisper.audio.transcribe']),
        mkOpRecipe('pure-kernel', ['core.ai.summarize']),
      ]),
    }, 'docling');
    expect(out).toEqual([]);
  });

  it('matches the pack SLUG, not the publisher-qualified ref', () => {
    // `installed_pack` is keyed by pack_slug alone, so qualifying here would
    // claim a precision the inventory does not have.
    const out = listRecipesWorsenedByPackUninstall({
      connectionStore: connectionStoreOf([]),
      recipeStore: recipeStoreOf([
        cliRecipe('third-party', 'someone-else.docling', ['someone-else.docling.document.to_markdown']),
      ]),
    }, 'docling');
    expect(out.map((t) => t.recipe_id)).toEqual(['third-party']);
  });

  it('does not report a recipe that is ALREADY blocked — uninstall cannot worsen it', () => {
    // An unbound canonical WRITE blocks the recipe today; losing the pack too
    // does not move its status, and a disclosure that lists it implies the
    // uninstall is what breaks it.
    const out = listRecipesWorsenedByPackUninstall({
      connectionStore: connectionStoreOf([]),
      recipeStore: recipeStoreOf([{
        ...mkOpRecipe('already-blocked', ['core.crm.deal.create', 'recued-core.docling.document.to_markdown']),
        depends_on: ['recued-core.docling'],
      } as RecipeDefinition]),
    }, 'docling');
    expect(out).toEqual([]);
  });

  it('reports a degraded recipe as newly blocked, not merely degraded', () => {
    // An unbound canonical READ degrades. Losing the pack is strictly worse:
    // the run stops existing rather than returning less.
    const out = listRecipesWorsenedByPackUninstall({
      connectionStore: connectionStoreOf([]),
      recipeStore: recipeStoreOf([{
        ...mkOpRecipe('degraded-then-blocked', ['core.crm.deal.search', 'recued-core.docling.document.to_markdown']),
        depends_on: ['recued-core.docling'],
      } as RecipeDefinition]),
    }, 'docling');
    expect(out).toEqual([
      { recipe_id: 'degraded-then-blocked', before: 'degraded', after: 'blocked' },
    ]);
  });

  it('ignores a recipe with no depends_on rather than guessing from its ops', () => {
    // `depends_on` is the declaration this walk reads. It is enforced
    // corpus-wide (`recipe-depends-on-coverage`), so an absent list is a real
    // "no pack dependency" — re-deriving from op ids here would be a second
    // source of truth that could disagree with the one users see.
    const out = listRecipesWorsenedByPackUninstall({
      connectionStore: connectionStoreOf([]),
      recipeStore: recipeStoreOf([
        mkOpRecipe('undeclared', ['recued-core.docling.document.to_markdown']),
      ]),
    }, 'docling');
    expect(out).toEqual([]);
  });
});

/** The PACK arm of the runnability READ — the proactive half.
 *
 *  The uninstall walk already told the truth about packs; the read did not, so a
 *  recipe whose pack was never installed showed a green `runnable` pill and only
 *  revealed the problem when someone pressed Run. Disclosure is the whole point
 *  of this surface, and it was silent on the one failure a user can fix in one
 *  click.
 *
 *  ⛔ `blocked`, never `degraded`. A missing pack does not skip some steps — the
 *  recipe cannot LOWER, so it never starts. Ranking it `degraded` would promise
 *  a partial run that cannot happen.
 */
describe('runnability read — missing pack arm', () => {
  const packRecipe = (recipe_id: string, packs: string[], ops: string[] = []): RecipeDefinition =>
    ({ ...mkOpRecipe(recipe_id, ops), depends_on: packs }) as RecipeDefinition;

  const read = (recipes: RecipeDefinition[], installed: string[] | null) =>
    listRecipeRunnability({
      connectionStore: connectionStoreOf([]),
      recipeStore: recipeStoreOf(recipes),
      ...(installed === null ? {} : { installedPackRefs: () => new Set(installed) }),
    }).recipes;

  it('blocks a recipe whose declared pack is not installed', () => {
    const [entry] = read([packRecipe('parse-a-pdf', ['recued-core.docling'])], []);
    expect(entry!.status).toBe('blocked');
    expect(entry!.dependencies.map((d) => d.capability)).toEqual(['recued-core.docling']);
    // HARD by construction — there is no optional half to a pack that is absent.
    expect(entry!.dependencies[0]!.optional).toBe(false);
    expect(entry!.dependencies[0]!.satisfied).toBe(false);
  });

  it('stays runnable when every declared pack is installed', () => {
    const [entry] = read(
      [packRecipe('parse-a-pdf', ['recued-core.docling'])],
      ['recued-core.docling'],
    );
    expect(entry!.status).toBe('runnable');
    expect(entry!.dependencies).toEqual([]);
  });

  it('lists the missing pack FIRST, ahead of family detail', () => {
    // The pack is the thing the owner can fix in one click; an unbound CRM
    // family below it is the longer errand.
    const [entry] = read(
      [packRecipe('mixed', ['recued-core.docling'], ['core.crm.deal.search'])],
      [],
    );
    expect(entry!.status).toBe('blocked');
    expect(entry!.dependencies[0]!.capability).toBe('recued-core.docling');
    expect(entry!.dependencies.length).toBeGreaterThan(1);
  });

  it('keeps the family warning alongside the pack, not instead of it', () => {
    // Fixing the pack must not then reveal a second problem the disclosure had
    // been hiding behind the first.
    const [entry] = read(
      [packRecipe('mixed', ['recued-core.docling'], ['core.crm.deal.search'])],
      [],
    );
    expect(entry!.dependencies.map((d) => d.capability)).toContain('crm');
  });

  // ⚠ Fail-OPEN, and only here. A dbless boot cannot enumerate installed packs;
  // treating "cannot tell" as "missing" would paint every pack recipe blocked.
  it('discloses nothing about packs when the dep is unwired', () => {
    const [entry] = read([packRecipe('parse-a-pdf', ['recued-core.docling'])], null);
    expect(entry!.status).toBe('runnable');
  });

  it('ignores a recipe that declares no packs', () => {
    const [entry] = read([mkOpRecipe('plain', [])], []);
    expect(entry!.status).toBe('runnable');
  });
});
