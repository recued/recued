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
  buildPackOperationIndex,
  isProvablyReadOnly,
  recipeSpendsPerRun,
  recipeConsumedEnrichments,
  recipeNotificationChannels,
  recipeRequiredConnections,
  spreadsheetImportOf,
  type RecipeListRecipeView,
  type ServerRecipeFullEntry,
  type ConnectionKind,
  type RecipeDefinition,
  type PackOperationIndex,
  type RecordsUsagePack,
  type SpreadsheetImportDeclaration,
} from '@recued/contracts';
import {
  type HandlerSlice,
  type ServerRecipeListEntry,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { RecipeStore } from './recipe-store.js';
import type { WsClient } from './ws-server.js';
import { createListPager, readListPageRequest } from './list-pager.js';
import { packCatalogRefs } from './pack-catalog-refs.js';

export interface RecipeListHandlerDeps {
  store: RecipeStore;
  /** The installed pack roster, for the `provably_read_only` projection.
   *
   *  ⛔ WHY THE SERVER DECIDES THIS AND NOT THE CLIENT. The webclient used to
   *  answer it by walking each recipe's steps against a roster built from
   *  `packs.list` manifests. That list no longer forwards manifests, so the
   *  roster resolves nothing and the rule fails CLOSED — a genuine view shown
   *  as an operation. And once the step bodies come off this list it would
   *  fail OPEN instead, which is worse: `stepsAreAnalysable(undefined)` is
   *  `true`, so a stripped body passes every check vacuously and a recipe that
   *  DELETES answers "read only". A permissions answer must not be derivable
   *  from data the answerer no longer holds.
   *
   *  Optional: a server without it projects `undefined` and the client keeps
   *  its own full-body answer. */
  packRoster?: () => readonly RecordsUsagePack[];
  /** Epoch ms — the server process's startup time. Used as the
   *  fallback `installed_at` for bundled recipes that don't track
   *  their own first-seen time. */
  serverStartedAt: number;
}

/** Shape used internally so the bundled-vs-stored branches converge
 *  on one return type before the rpc envelope wraps it. */
type ListEntry = ServerRecipeListEntry;
/** The same row with its body intact — what `recipe.get` answers with. */
type FullEntry = ServerRecipeFullEntry;

/** Strip the execution body for a LIST row.
 *
 *  ⚠ APPLIED LAST, NEVER FIRST. `hashRecipe` must cover what this drops (it is
 *  the client's drift check), and both projections — `provably_read_only` and
 *  `required_connections` — read the very steps being removed. That ordering
 *  is the whole reason those answers are computed here and not by the client. */
const listView = (recipe: RecipeDefinition): RecipeListRecipeView => {
  const { steps: _s, prefetch_steps: _p, ...rest } = recipe as RecipeDefinition & {
    prefetch_steps?: unknown;
  };
  return rest as RecipeListRecipeView;
};

/** The facts a trimmed row can no longer derive for itself. */
const projections = (
  recipe: RecipeDefinition,
  ops: PackOperationIndex | null,
): {
  provably_read_only?: boolean;
  spends_per_run: boolean;
  required_connections?: { kind: ConnectionKind | null; name: string }[];
  spreadsheet_import?: SpreadsheetImportDeclaration;
  notification_channels: string[];
  consumed_enrichments: string[];
} => ({
  ...(ops === null ? {} : { provably_read_only: isProvablyReadOnly(recipe as never, ops) }),
  // The cost half of the unprompted-run gate, always projected. A kernel op id,
  // or its lowered backing ingredient, names itself; a pack op marked
  // `spends_per_call` is found through the roster when one is wired.
  spends_per_run: recipeSpendsPerRun(recipe as never, ops ?? undefined),
  // D-292 — judged HERE, on the body with its steps: the guided import's safety
  // check (its preview switch reaches `dry_run`) reads exactly what `listView`
  // strips. Present only when the declaration holds.
  ...((): { spreadsheet_import?: SpreadsheetImportDeclaration } => {
    const declaration = spreadsheetImportOf(recipe);
    return declaration === null ? {} : { spreadsheet_import: declaration };
  })(),
  // ⚠ `kind` is `ConnectionKind | null` and the NULL IS MEANINGFUL — it means
  // the need came from a `read_connection_*` permission rather than a typed
  // `connection.<kind>.<name>` ref. An earlier version of this line did
  // `String(c.kind)` and shipped the literal string "null" to every client.
  required_connections: recipeRequiredConnections(recipe)
    .map((c) => ({ kind: c.kind, name: c.name })),
  // The card's pills. Channels and enrichment reads live in `steps`, which
  // `listView` strips, so a card scanning the row showed none of them
  // (`recipe-card-facts.ts` has the measured cost).
  notification_channels: recipeNotificationChannels(recipe),
  consumed_enrichments: recipeConsumedEnrichments(recipe),
});

/** The stored (pair-sync / imported) row as a list entry, or null when the row
 *  is a kernel recipe. */
const storedEntry = (row: {
  recipe_id: string; publisher_id: string; version: number;
  recipe_hash: string; recipe_json: string;
  source: string; installed_at: number;
}, ops: PackOperationIndex | null): FullEntry | null => {
  const recipe = JSON.parse(row.recipe_json);
  // ⚠ A kernel recipe should never reach the stored table — it is not in
  // `installRegistry` — but the same rule applies if one ever does.
  if (isKernelRecipe(recipe)) return null;
  return {
    recipe_id: row.recipe_id,
    publisher_id: row.publisher_id || 'local',
    version: row.version,
    recipe_hash: row.recipe_hash,
    recipe,
    // Stored 'imported' rows from older server builds are renamed to
    // 'pair-sync' on the wire — the contract shape only carries the three
    // values, and 'imported' is the legacy alias for 'pair-sync'.
    source: row.source === 'bundled' ? 'bundled' : 'pair-sync',
    installed_at: row.installed_at,
    ...projections(recipe, ops),
  };
};

/** The bundled recipe as a list entry, or null when it is a kernel recipe.
 *  Bundled recipes have no row, so `installed_at` / `publisher_id` / the hash
 *  are derived — see this module's header. */
const bundledEntry = (
  recipe: { recipe_id: string; version: number; metadata?: { author?: string } },
  serverStartedAt: number,
  ops: PackOperationIndex | null,
): FullEntry | null => {
  if (isKernelRecipe(recipe)) return null;
  return {
    recipe_id: recipe.recipe_id,
    publisher_id: 'recued-core',
    version: recipe.version,
    recipe_hash: hashRecipe(recipe as never),
    recipe: recipe as never,
    source: 'bundled',
    installed_at: serverStartedAt,
    ...projections(recipe as never, ops),
  };
};

/** One request's read of the roster: the packs, and which pack each catalog
 *  belongs to. The catalogs are what let the proof read an INSTALLED recipe,
 *  whose pack ops install lowered onto them (`pack-catalog-refs.ts`). Read
 *  once per request, BEFORE any paging, because naming a Records catalog is a
 *  digest and the pager's compute is synchronous. */
interface RosterRead {
  packs: readonly RecordsUsagePack[];
  catalogs: ReadonlyMap<string, string>;
}

const readRoster = async (deps: RecipeListHandlerDeps): Promise<RosterRead | null> => {
  if (deps.packRoster === undefined) return null;
  const packs = deps.packRoster();
  return { packs, catalogs: await packCatalogRefs(packs) };
};

/** The op index for one build. ⛔ BUILT ONCE, NEVER PER RECIPE: the roster is
 *  ~26k operations, and the webclient's own note records that walking it once
 *  per recipe cost ~58s of a one-minute sweep. */
const opsFor = (roster: RosterRead | null): PackOperationIndex | null =>
  roster === null ? null : buildPackOperationIndex(roster.packs, roster.catalogs);

/** D-119 — `recipe.get`: ONE recipe by id, in the same entry shape
 *  `recipe.list` returns.
 *
 *  ⛔ WHY IT EXISTS, HAVING NOT EXISTED FOR A LONG TIME.
 *  `ServerRecipeListEntry.recipe` carries the whole definition, on a trade its
 *  own comment states: *"Bigger than necessary on first paint, but avoids a
 *  per-row `recipe.get` round-trip on scope switch."* That round-trip was never
 *  built, so every caller of `recipe.list` pays for the entire corpus. Measured
 *  on a 2,369-recipe realm the `recipe` field is **9,855,263 B, 96.0%** of a
 *  10.26 MB response, and the webclient issues `recipe.list` **23 times** in one
 *  session. A 10.26 MB frame takes seconds to drain, and a 12.73 MB
 *  `chat.inbound_token.tool_catalog` landing behind one of them blew the 16 MiB
 *  per-socket cap — the socket was terminated while the server logged `ok=true`.
 *  See internal design notes.
 *
 *  🔑 THIS IS THE PREREQUISITE, NOT THE FIX. Trimming the list body is the fix;
 *  it cannot happen while the Kitchen editor initialises from
 *  `entry.recipe` (`mount-recipe-editor-route.ts` — `initialRecipe: entry.recipe`)
 *  and `packs/pack-app-model.ts` reads `recipe.output` off a list row. Those
 *  callers move here first, THEN the body comes off the list.
 *
 *  ⚠ SAME PRECEDENCE AND SAME EXCLUSIONS AS THE LIST, by sharing the builders
 *  rather than restating them: stored wins over bundled (the user's chosen
 *  version), and kernel recipes are invisible. This module's header records
 *  what it cost when one store had three readers and only two applied the rule;
 *  a second door that re-derived the logic would be the fourth. */
export const getServerRecipe = async (
  deps: RecipeListHandlerDeps,
  recipe_id: string,
): Promise<{ recipe: FullEntry | null }> => {
  const id = typeof recipe_id === 'string' ? recipe_id.trim() : '';
  if (id === '') return { recipe: null };
  const ops = opsFor(await readRoster(deps));
  for (const row of deps.store.listStored()) {
    if (row.recipe_id !== id) continue;
    return { recipe: storedEntry(row, ops) };
  }
  const bundled = deps.store.get(id);
  if (!bundled) return { recipe: null };
  return { recipe: bundledEntry(bundled, deps.serverStartedAt, ops) };
};

export const listServerRecipes = async (
  deps: RecipeListHandlerDeps,
): Promise<{ recipes: ListEntry[] }> => buildRecipeList(deps, await readRoster(deps));

const buildRecipeList = (
  deps: RecipeListHandlerDeps,
  roster: RosterRead | null,
): { recipes: ListEntry[] } => {
  const seen = new Set<string>();
  const out: FullEntry[] = [];
  const ops = opsFor(roster);

  // SQLite-stored (pair-sync / imported) wins on conflict — those are
  // the user's chosen versions, bundled is the fallback.
  for (const row of deps.store.listStored()) {
    // ⚠ Marked `seen` even when the entry is dropped: that is what stops the
    // bundled copy of a kernel recipe re-adding it in the loop below.
    seen.add(row.recipe_id);
    const entry = storedEntry(row, ops);
    if (entry !== null) out.push(entry);
  }

  // Bundled — every recipe the disk-loader saw at boot. Skip any id
  // already returned by SQLite (user chose to install a different
  // version of the same recipe).
  for (const id of deps.store.ids()) {
    if (seen.has(id)) continue;
    const recipe = deps.store.get(id);
    if (!recipe) continue; // shouldn't happen; defensive
    const entry = bundledEntry(recipe, deps.serverStartedAt, ops);
    if (entry !== null) out.push(entry);
  }

  // Stable order: most recent first, then alphabetical by recipe_id.
  out.sort((a, b) => {
    if (a.installed_at !== b.installed_at) return b.installed_at - a.installed_at;
    return a.recipe_id.localeCompare(b.recipe_id);
  });

  // ⛔ THE TRIM HAPPENS HERE, ON THE WAY OUT, AND ONLY HERE. The builders hand
  // back whole entries so `recipe.get` and the projections above both see a
  // real body; the list is the one surface that ships without one.
  return { recipes: out.map((entry) => ({ ...entry, recipe: listView(entry.recipe) })) };
};

export type RecipeListMethods = 'recipe.list' | 'recipe.get';

export const makeRecipeListHandlers = (
  deps: RecipeListHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, RecipeListMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  // One per server. `recipe_id` is what the list dedups on, so it is also
  // what the page fingerprint follows.
  const pager = createListPager<ListEntry>({
    method: 'recipe.list',
    identity: (entry) => entry.recipe_id,
  });
  return {
    methods: ['recipe.list', 'recipe.get'],
    handlers: {
      // Paged when the request carries `limit` or `cursor`; a request with
      // neither gets the whole list, unchanged. See `list-pager.ts`.
      'recipe.list': async (args) => {
        const request = readListPageRequest('recipe.list', args);
        const roster = await readRoster(deps);
        if (request === null) return buildRecipeList(deps, roster);
        const page = pager.page(request, () => buildRecipeList(deps, roster).recipes);
        return { recipes: page.items, next_cursor: page.next_cursor, total: page.total };
      },
      'recipe.get': async (args) => getServerRecipe(deps, args.recipe_id),
    },
  };
};
