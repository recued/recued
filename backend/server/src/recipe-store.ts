/** Recipe store for the headless server.
 *
 *  Loads recipes from three sources (priority: user > bundled):
 *  1. SQLite: user-imported/installed recipes (persistent)
 *  2. Bundled: community/recipes/*.json files on disk (read-only)
 *  3. Inline: POST /execute can pass a full recipe definition
 *
 *  Write operations (save, delete, updateUpstream) only affect SQLite.
 *  Bundled recipes are never modified — they serve as read-only defaults.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { droppedVariables, type RecipeDefinition } from '@recued/contracts';

import { BUNDLED_FOUNDATION_RECIPES } from './bundled-foundation.generated.js';
import {
  flattenRecipe,
  hashRecipe,
  serializeFlattenedInsight,
} from '@recued/recipes';
import type { StoredRecipe } from './types.js';
import { getOrCreateRecipeInsight } from './memory-schema.js';
import { initializePreapprovalLifecycle, mutatePreapprovalResource } from './storage/preapproval-lifecycle.js';

/** A RecipeStore-local authoring disposition. The editable snapshot carries
 * the exact persisted JSON used by `compareAndSaveLocalRecipe`; it is an
 * internal compare token, never a wire field. Pack-owned and bundled recipes
 * remain readable but require an explicit new-id fork before an owner tool may
 * write recipe-local configuration. In-memory overrides are unavailable: a
 * SQLite write could not become the effective recipe while they shadow it. */
export type LocalRecipeEditInspection =
  | {
      readonly kind: 'editable';
      readonly recipe: RecipeDefinition;
      readonly recipe_json: string;
    }
  | {
      readonly kind: 'fork_required';
      readonly recipe: RecipeDefinition;
    }
  | { readonly kind: 'unavailable' };

export type LocalRecipeCompareAndSaveResult =
  | {
      readonly kind: 'updated';
      readonly prior_recipe_hash: string;
      readonly recipe_hash: string;
    }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_editable' }
  | { readonly kind: 'not_configured' };

export interface RecipeStore {
  /** Look up a recipe by id. SQLite wins over bundled. */
  get(recipe_id: string): RecipeDefinition | null;
  /** D-145 PA10 — read the bundled-on-disk version of a recipe,
   *  bypassing the memory-overrides + SQLite precedence path. Returns
   *  the recipe loaded at store-construction time from
   *  `community/recipes/<id>.json`, or `null` when no such bundled
   *  file existed. The foundation-pack pre-install fast-path needs
   *  this to detect drift between the bundled file (source-of-truth
   *  for first-party packs) and the persistent SQLite row that
   *  `save()` previously wrote — `get()`'s SQLite-wins precedence
   *  would otherwise hide the drift. */
  getBundled(recipe_id: string): RecipeDefinition | null;
  /** Get full stored metadata (only for SQLite recipes). */
  getStored(recipe_id: string): StoredRecipe | null;
  /** Number of all recipes (bundled + SQLite). */
  size(): number;
  /** All recipe ids. */
  ids(): string[];
  /** Register a recipe in memory (no persistence). Convenience for
   *  tests and one-shot CLI mode without a database. */
  register(recipe: RecipeDefinition): void;
  /** Save a recipe to SQLite. `pack_slug` (D-145 PA10 follow-on) marks
   *  pack provenance — non-null for rows installed by `packs.install`,
   *  `null` for pre-existing / bundled / manually-installed rows. The
   *  uninstall transaction reads this column to scope `DELETE` to rows
   *  the uninstalling pack actually owns. */
  save(
    recipe: RecipeDefinition,
    publisher_id: string,
    source: StoredRecipe['source'],
    now?: number,
    pack_slug?: string | null,
  ): void;
  /** D-200 Slice 6g.11 — inspect the effective source before a narrow
   * recipe-local metadata edit. This never treats a pack/bundled row as
   * directly writable and never returns a memory-shadowed SQLite row. */
  inspectLocalRecipeEdit?(recipe_id: string): LocalRecipeEditInspection;
  /** Compare the exact persisted JSON and pack ownership in one SQLite
   * transaction, then replace recipe content fields only. Publisher/source,
   * install time, upstream state, and pack provenance are preserved. */
  compareAndSaveLocalRecipe?(input: {
    readonly recipe: RecipeDefinition;
    readonly expected_recipe_json: string;
    readonly now?: number;
  }): LocalRecipeCompareAndSaveResult;
  /** D-303 — the variables an earlier version of this recipe declared that the stored
   *  one does not: what updates dropped. A run drops a value still saved for one of
   *  these instead of refusing it (`execute-handler`, beside D-302's
   *  `metadata.retired_variables`). Recorded by every write (`save`,
   *  `compareAndSaveLocalRecipe`); a name a later version declares again leaves the
   *  list, so its saved value applies again. `[]` without a database. */
  retiredVariables?(recipe_id: string): readonly string[];
  /** D-303 — every recipe id with a retired list, for the boot sweep that forgets the
   *  lists nothing needs any more (`retired-settings.ts`). */
  retiredRecipeIds?(): string[];
  /** D-303 — forget a recipe's retired list. D-304: with the recipe's settings when it
   *  is uninstalled (`recipe-owned-state.ts`); at boot, a list left from before that
   *  (`forgetUnusedRetirements`). */
  forgetRetiredVariables?(recipe_id: string): void;
  /** Delete a recipe from SQLite. Cannot delete bundled recipes. */
  delete(recipe_id: string): boolean;
  /** D-145 PA10 follow-on — list recipe_ids owned by the given pack.
   *  Drives the pack-aware uninstall transaction in
   *  `pack-uninstall-handler.ts` so uninstall only removes rows the
   *  pack itself installed. Returns `[]` when no rows match (no SQLite,
   *  no installed pack rows, empty slug, etc.). */
  listForPack(pack_slug: string): string[];
  /** List all stored recipes with metadata. */
  listStored(): StoredRecipe[];
  /** Update upstream check state for a recipe. */
  updateUpstream(recipe_id: string, upstream: { version: number; hash: string }, now: number): void;
  /** D-122 follow-on — set the recipe-upgrade cascade hook. Fired by
   *  `save()` whenever the new `recipe_hash` differs from the prior
   *  hash for the same `recipe_id` (i.e. an actual upgrade vs a
   *  fresh install or no-op re-install). The cascade engine marks
   *  every `data.enrichment.*` row authored by the recipe as stale +
   *  drops sidecars; reactive producers repopulate on the next fire.
   *  Set lazily because the enrichment cascade engine isn't
   *  available until after the enrichment store is composed (later
   *  in boot than recipe-store creation). */
  setOnUpgrade(hook: ((recipe_id: string) => void) | undefined): void;
  /** Poll-manager / G6 — set the recipe-roster mutation hook. Fired
   *  AFTER every `save()` (fresh install, re-install, upgrade) and
   *  after every row-removing `delete()`, regardless of content
   *  change — the declarative event-trigger reconciler + the watch
   *  poll-manager re-derive their demand sets from the stored roster,
   *  so ANY roster mutation is a recompute signal. One seam covers
   *  every install path (pack install, bulk install, recipe save rpc,
   *  uninstall) instead of threading callbacks through each handler.
   *  Set lazily — the listener-stage composition (where the
   *  reconciler + manager live) runs after recipe-store creation. */
  setOnMutated(hook: ((recipe_id: string) => void) | undefined): void;
  /** D-247 — register an ADDITIONAL mutation subscriber. Fired on every write
   *  AND on delete, with the recipe id. Unlike {@link setOnMutated} this appends
   *  rather than replacing, so two consumers can coexist. */
  addOnMutated(hook: (recipe_id: string) => void): void;
  /** D-304 — register a subscriber for a recipe's DELETION (a row actually
   *  removed), fired before the mutation hooks so they see what it cleaned up.
   *  The server removes the recipe's own settings, schedules and automations here
   *  (`recipe-owned-state.ts`): one seam for every uninstall path. Optional, so a
   *  test double without it behaves as before. */
  addOnDeleted?(hook: (recipe_id: string) => void): void;
}

/** Scan a directory for *.json files and load each as a RecipeDefinition. */
const loadFromDirectory = (dir: string): Map<string, RecipeDefinition> => {
  const recipes = new Map<string, RecipeDefinition>();
  if (!existsSync(dir)) return recipes;

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const recipe = JSON.parse(raw) as RecipeDefinition;
      if (recipe.recipe_id) {
        recipes.set(recipe.recipe_id, recipe);
      }
    } catch {
      // Skip malformed files
    }
  }
  return recipes;
};

/** Resolve the community/recipes directory relative to the project root. */
const findCommunityDir = (): string => {
  const projectRoot = resolve(import.meta.dirname ?? __dirname, '..', '..', '..');
  return join(projectRoot, 'community', 'recipes');
};

/** Create a recipe store backed by bundled files + an optional SQLite database.
 *  When `db` is provided, user recipes persist across restarts. Without it,
 *  only bundled recipes are available (useful for tests). */
/** D-247 D6 — thrown when a save would take a recipe's `pack_slug` from non-null
 *  to null, i.e. strip a pack's ownership of its own content.
 *
 *  ⚠ A NAMED CLASS, not a bare `Error`, because three different rpc handlers must
 *  turn this into three different caller-facing refusals and a message-substring
 *  match is how that breaks quietly. Carries the owning pack so the refusal can
 *  say "fork it, or uninstall <pack>" rather than "no". */
export class RecipePackOwnershipError extends Error {
  readonly recipe_id: string;
  readonly pack_slug: string;
  constructor(recipe_id: string, pack_slug: string) {
    super(
      `recipe '${recipe_id}' belongs to pack '${pack_slug}' — change recipe_id to fork it before saving`,
    );
    this.name = 'RecipePackOwnershipError';
    this.recipe_id = recipe_id;
    this.pack_slug = pack_slug;
  }
}

export const createRecipeStore = (
  communityDir?: string,
  db?: import('better-sqlite3').Database,
): RecipeStore => {
  const dir = communityDir ?? findCommunityDir();
  const bundled = loadFromDirectory(dir);
  // Merge the embedded foundation recipes so a DEPLOYED server (npm/Docker ship
  // no `community/` dir — `findCommunityDir` mis-resolves there, so `bundled` is
  // empty) still resolves them via `get()` / `getBundled()`. A git-clone dev
  // build has the FS files → those win (skip when already present), keeping dev
  // behavior identical. Clone so a per-store consumer mutation can't corrupt the
  // shared module constant across boots.
  //
  // ONLY on the DEFAULT path (`communityDir` unset). A test / caller that pins an
  // explicit dir is supplying its own fixture and must not get the embedded
  // foundation recipes silently injected.
  if (communityDir === undefined) {
    for (const [recipeId, recipe] of Object.entries(BUNDLED_FOUNDATION_RECIPES)) {
      if (!bundled.has(recipeId)) bundled.set(recipeId, structuredClone(recipe));
    }
  }

  // Ensure recipes table exists when db is provided
  if (db) {
    initializePreapprovalLifecycle(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS recipes (
        recipe_id         TEXT NOT NULL PRIMARY KEY,
        publisher_id      TEXT NOT NULL DEFAULT '',
        version           INTEGER NOT NULL DEFAULT 1,
        recipe_hash       TEXT NOT NULL DEFAULT '',
        recipe_json       TEXT NOT NULL,
        source            TEXT NOT NULL DEFAULT 'imported',
        installed_at      INTEGER NOT NULL,
        upstream_version  INTEGER,
        upstream_hash     TEXT,
        last_checked_at   INTEGER,
        pack_slug         TEXT
      );
    `);
    // D-145 PA10 follow-on — `pack_slug` is the per-recipe pack-provenance
    // column. Fresh DBs pick it up via the CREATE TABLE above; DBs that
    // pre-date this commit get the column added here. SQLite ADD COLUMN
    // backfills existing rows to NULL, which is the right pre-existing
    // semantic (those rows weren't installed by a pack). Pre-launch
    // zero-installs rule applies — no migration code, just an
    // idempotent ADD COLUMN guarded against re-add.
    const cols = db.prepare(`PRAGMA table_info(recipes)`).all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === 'pack_slug')) {
      db.exec(`ALTER TABLE recipes ADD COLUMN pack_slug TEXT`);
    }
    // Index supports `listForPack` + `DELETE WHERE pack_slug = ?` on
    // the uninstall path. Partial index keeps it tight — rows with
    // NULL pack_slug (pre-existing / manually installed) don't enter
    // the index at all.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_recipes_pack_slug
        ON recipes (pack_slug)
        WHERE pack_slug IS NOT NULL;
    `);
    // D-303 — the variables updates dropped, per recipe (`retiredVariables`). D-304:
    // forgotten with the recipe's settings when it is uninstalled
    // (`recipe-owned-state.ts`).
    db.exec(`
      CREATE TABLE IF NOT EXISTS recipe_retired_variables (
        recipe_id  TEXT NOT NULL,
        name       TEXT NOT NULL,
        retired_at INTEGER NOT NULL,
        PRIMARY KEY (recipe_id, name)
      );
    `);
  }

  const getFromDb = (recipe_id: string): StoredRecipe | undefined => {
    if (!db) return undefined;
    return db
      .prepare('SELECT * FROM recipes WHERE recipe_id = ?')
      .get(recipe_id) as StoredRecipe | undefined;
  };

  const parseStored = (row: StoredRecipe): RecipeDefinition => {
    return JSON.parse(row.recipe_json) as RecipeDefinition;
  };

  // In-memory overrides (from register() calls)
  const memoryOverrides = new Map<string, RecipeDefinition>();

  // D-122 follow-on — recipe-upgrade cascade hook, set lazily by the
  // boot site after the enrichment cascade engine exists.
  let onUpgradeHook: ((recipe_id: string) => void) | undefined;
  let onMutatedHook: ((recipe_id: string) => void) | undefined;
  /** D-247 — ADDITIONAL mutation subscribers, because `setOnMutated` is a SINGLE
   *  SLOT and it is already taken.
   *
   *  ⛔⛔ THE EXISTING CONSUMER IS ALSO REGISTERED CONDITIONALLY
   *  (`if (eventTriggersBundle || watchBundle)` in `compose-listeners.ts`), so
   *  chaining onto it would make the grant seed run only when the trigger
   *  substrate happens to be wired — a feature that ships dead on every install
   *  without it, and green in every test that wires one. A list, and an
   *  UNCONDITIONAL registration, is what makes "did production wire it" one
   *  question. Mirrors `connectionStore.addOnUpsert`, two lines below the
   *  `setOnMutated` call site. */
  const onMutatedSubscribers: Array<(recipe_id: string) => void> = [];
  /** D-304 — deletion subscribers (`addOnDeleted`). */
  const onDeletedSubscribers: Array<(recipe_id: string) => void> = [];
  const fireOnDeleted = (recipe_id: string): void => {
    for (const sub of onDeletedSubscribers) {
      try {
        sub(recipe_id);
      } catch {
        // The row is already gone; a subscriber's failure must not report the
        // delete as failed.
      }
    }
  };
  const preapprovalMaterial = (id: string): unknown | null => {
    const row = db?.prepare('SELECT publisher_id,recipe_json FROM recipes WHERE recipe_id=?')
      .get(id) as { publisher_id: string; recipe_json: string } | undefined;
    return row ? { publisher_id: row.publisher_id, definition: JSON.parse(row.recipe_json) as unknown } : null;
  };
  const fireOnMutated = (recipe_id: string): void => {
    for (const sub of onMutatedSubscribers) {
      try {
        sub(recipe_id);
      } catch {
        // A subscriber's failure must never break the write that triggered it —
        // the row is already committed, and throwing here would report a
        // successful save as a failed one.
      }
    }
    if (!onMutatedHook) return;
    try {
      onMutatedHook(recipe_id);
    } catch {
      // Best-effort — reconcile/recompute failure must never break a
      // recipe save or delete.
    }
  };
  /** D-303 — ⛔ AN UPDATE THAT DROPS A VARIABLE MUST NOT STOP THE RECIPE RUNNING.
   *
   *  D-222 refuses every config key a recipe does not declare, including values the
   *  owner saved earlier: the install config, dishes, groups, and the managed dishes
   *  behind schedules, triggers and auto-run. Nothing prunes those, so a version that
   *  drops `x` would answer every run of an owner who ever saved `x` with a refusal.
   *
   *  Deleting the saved values is the wrong fix. A managed dish is immutable (one
   *  dish id, one config), a pre-approval pins a dish's config, and a group can serve
   *  more than one recipe. So nothing saved is rewritten. This records the names the
   *  update dropped, the run drops their values (D-302's mechanism), and a later
   *  version that declares a name again takes it off the list, so its saved value
   *  applies again. Called inside the write's transaction, so the list and the stored
   *  recipe cannot disagree. */
  const recordRetired = (next: RecipeDefinition, priorJson: string | undefined, now: number): void => {
    if (!db) return;
    let prior: RecipeDefinition | null = null;
    try {
      prior = priorJson === undefined ? null : JSON.parse(priorJson) as RecipeDefinition;
    } catch {
      prior = null;
    }
    const retire = db.prepare(
      'INSERT OR IGNORE INTO recipe_retired_variables (recipe_id, name, retired_at) VALUES (?, ?, ?)');
    for (const name of droppedVariables(prior, next)) retire.run(next.recipe_id, name, now);
    const revive = db.prepare('DELETE FROM recipe_retired_variables WHERE recipe_id = ? AND name = ?');
    for (const name of Object.keys(next.variables ?? {})) revive.run(next.recipe_id, name);
  };

  const fireOnUpgrade = (recipe_id: string): void => {
    if (!onUpgradeHook) return;
    try {
      onUpgradeHook(recipe_id);
    } catch {
      // Best-effort — cascade failure must never break recipe persistence.
    }
  };
  const recordRecipeInsight = (
    recipe: RecipeDefinition,
    hash: string,
    createdAt: number,
  ): void => {
    if (!db) return;
    // D-120 Phase 2 — content-addressed recipe-shape snapshot. Same
    // hash always lands the same row, so re-installs and version
    // bumps are no-ops on insight content; only the FK target id
    // grows. Flatten failures are best-effort: if the payload
    // would exceed the byte cap even after shrinking, skip the
    // insert entirely so audit rows for this run pin
    // recipe_insight_id = NULL (Phase 7 retention prune handles
    // orphans symmetrically).
    try {
      const flattened = flattenRecipe(recipe);
      const { json, over_cap } = serializeFlattenedInsight(flattened);
      if (over_cap) return;
      getOrCreateRecipeInsight(db, {
        hash,
        slug: recipe.recipe_id,
        version: recipe.version,
        flattened: json,
        created_at: createdAt,
      });
    } catch {
      // Flatten / insert failure is non-fatal for recipe persistence.
    }
  };

  return {
    get(recipe_id) {
      // Memory overrides (register) > SQLite > bundled
      const mem = memoryOverrides.get(recipe_id);
      if (mem) return mem;
      const row = getFromDb(recipe_id);
      if (row) return parseStored(row);
      return bundled.get(recipe_id) ?? null;
    },

    getBundled(recipe_id) {
      // D-145 PA10 — bundled-only read for foundation-pack drift
      // detection. Skips memoryOverrides + SQLite precedence so the
      // pre-install fast-path can compare the bundled file's hash
      // against the SQLite row's hash without `get()`'s SQLite-wins
      // path masking a content drift.
      return bundled.get(recipe_id) ?? null;
    },

    getStored(recipe_id) {
      return getFromDb(recipe_id) ?? null;
    },

    size() {
      const allIds = new Set<string>(bundled.keys());
      for (const id of memoryOverrides.keys()) allIds.add(id);
      if (db) {
        const rows = db.prepare('SELECT recipe_id FROM recipes').all() as { recipe_id: string }[];
        for (const r of rows) allIds.add(r.recipe_id);
      }
      return allIds.size;
    },

    ids() {
      const allIds = new Set<string>(bundled.keys());
      for (const id of memoryOverrides.keys()) allIds.add(id);
      if (db) {
        const rows = db.prepare('SELECT recipe_id FROM recipes').all() as { recipe_id: string }[];
        for (const r of rows) allIds.add(r.recipe_id);
      }
      return [...allIds];
    },

    register(recipe) {
      memoryOverrides.set(recipe.recipe_id, recipe);
    },

    save(recipe, publisher_id, source, now, pack_slug) {
      if (!db) throw new Error('No database configured — cannot save recipes');
      const hash = hashRecipe(recipe);
      const installedAt = now ?? Date.now();
      // D-122 follow-on — read prior hash before the upsert so we can
      // fire `onUpgradeHook` only on an actual content change (vs a
      // fresh install or a no-op re-install with the same hash). The
      // SELECT cost is cheap relative to the upsert and the hook
      // (when fired) does an indexed `markStaleByAuthor` over a
      // small subset of `data_enrichment`.
      const isUpgrade = mutatePreapprovalResource(db, 'recipe', recipe.recipe_id,
        () => preapprovalMaterial(recipe.recipe_id), () => {
        const priorRow = db
          .prepare('SELECT recipe_hash, pack_slug, recipe_json FROM recipes WHERE recipe_id = ?')
          .get(recipe.recipe_id) as { recipe_hash: string; pack_slug: string | null; recipe_json: string } | undefined;
        const isUpgrade = priorRow != null && priorRow.recipe_hash !== hash;
        // ── D-247 D6 — A PACK-OWNED ROW IS THE PACK'S TO CHANGE ──────────────
        //
        // ⛔⛔ THE GUARD IS HERE AND NOT IN THE HANDLERS BECAUSE THIS PAIR HAS
        // ALREADY DIVERGED TWICE. `recipe.save` refuses a pack-owned WEBHOOK
        // recipe; the MCP `recued_saveRecipe` tool has no ownership check at all;
        // `recipe.installBySlug` is a THIRD writer mirroring neither.
        // `form-contract-gate.ts` records the last divergence in this exact pair.
        // A fourth handler-level guard is the fifth divergence, already scheduled.
        //
        // Without it, a save over a non-webhook pack recipe keeps the recipe_id,
        // keeps any grant keyed on it, and silently strips `pack_slug` — so the
        // recipe stops receiving pack updates (a frozen body under a live grant,
        // with no signal) and D14's uninstall purge clears the grant while the
        // recipe survives, going dark. Both failures are silent.
        //
        // ⚠ SCOPED TO THE TRANSITION, not to "the row is pack-owned": pack install
        // and bulk install pass an explicit slug (non-null → non-null), a restore
        // passes `record.pack_slug`, and a new recipe has no prior row. Only the
        // ownership STRIP is refused.
        if (priorRow?.pack_slug != null && (pack_slug ?? null) === null) {
          throw new RecipePackOwnershipError(recipe.recipe_id, priorRow.pack_slug);
        }
        // D-145 PA10 follow-on — `pack_slug` is undefined for callers
        // that don't track pack provenance (legacy non-pack install
        // paths like mcp-server.ts's recipe upload). Persist as NULL
        // in that case so the column matches the pre-existing
        // semantic. The install wrapper in `install-bulk-pack-handler.ts`
        // always passes an explicit value (string for pack-installed
        // rows, `record.pack_slug` for restored priors), so this
        // branch only fires for non-pack callers.
        const packSlugValue = pack_slug ?? null;
        db.prepare(`
          INSERT INTO recipes (recipe_id, publisher_id, version, recipe_hash, recipe_json, source, installed_at, upstream_version, upstream_hash, last_checked_at, pack_slug)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
          ON CONFLICT (recipe_id) DO UPDATE SET
            publisher_id = excluded.publisher_id,
            version = excluded.version,
            recipe_hash = excluded.recipe_hash,
            recipe_json = excluded.recipe_json,
            source = excluded.source,
            installed_at = excluded.installed_at,
            pack_slug = excluded.pack_slug
        `).run(
          recipe.recipe_id,
          publisher_id,
          recipe.version,
          hash,
          JSON.stringify(recipe),
          source,
          installedAt,
          packSlugValue,
        );
        recordRetired(recipe, priorRow?.recipe_json, installedAt);
        return isUpgrade;
      });
      if (isUpgrade) fireOnUpgrade(recipe.recipe_id);
      // G6 — roster mutation signal. Fired BEFORE the insight-snapshot
      // block below (which early-returns on over-cap shapes) so the
      // reconcile signal never depends on insight bookkeeping.
      fireOnMutated(recipe.recipe_id);
      recordRecipeInsight(recipe, hash, installedAt);
    },

    inspectLocalRecipeEdit(recipe_id) {
      try {
        if (memoryOverrides.has(recipe_id)) return { kind: 'unavailable' };
        const row = getFromDb(recipe_id);
        if (row) {
          const recipe = parseStored(row);
          return row.pack_slug === null
            ? {
                kind: 'editable',
                recipe,
                recipe_json: row.recipe_json,
              }
            : { kind: 'fork_required', recipe };
        }
        const recipe = bundled.get(recipe_id);
        return recipe === undefined
          ? { kind: 'unavailable' }
          : { kind: 'fork_required', recipe: structuredClone(recipe) };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    compareAndSaveLocalRecipe(input) {
      if (!db) return { kind: 'not_configured' };
      if (memoryOverrides.has(input.recipe.recipe_id)) {
        return { kind: 'not_editable' };
      }
      const recipeJson = JSON.stringify(input.recipe);
      const recipeHash = hashRecipe(input.recipe);
      const result = mutatePreapprovalResource(db, 'recipe', input.recipe.recipe_id,
        () => preapprovalMaterial(input.recipe.recipe_id), (): LocalRecipeCompareAndSaveResult => {
        const row = getFromDb(input.recipe.recipe_id);
        if (!row) return { kind: 'not_found' };
        if (row.pack_slug !== null) return { kind: 'not_editable' };
        if (row.recipe_json !== input.expected_recipe_json) {
          return { kind: 'conflict' };
        }
        if (row.recipe_json === recipeJson) {
          return { kind: 'unchanged' };
        }
        const changed = db.prepare(`
          UPDATE recipes
          SET version = ?, recipe_hash = ?, recipe_json = ?
          WHERE recipe_id = ? AND recipe_json = ? AND pack_slug IS NULL
        `).run(
          input.recipe.version,
          recipeHash,
          recipeJson,
          input.recipe.recipe_id,
          input.expected_recipe_json,
        );
        if (changed.changes !== 1) {
          const current = getFromDb(input.recipe.recipe_id);
          return current === undefined
            ? { kind: 'not_found' }
            : current.pack_slug !== null
              ? { kind: 'not_editable' }
              : { kind: 'conflict' };
        }
        recordRetired(input.recipe, row.recipe_json, input.now ?? Date.now());
        return {
          kind: 'updated',
          prior_recipe_hash: row.recipe_hash,
          recipe_hash: recipeHash,
        };
      });
      if (result.kind === 'updated') {
        // This path knows the exact JSON changed even if the legacy 32-bit
        // cache hash happens to collide, so both mutation hooks still fire.
        fireOnUpgrade(input.recipe.recipe_id);
        fireOnMutated(input.recipe.recipe_id);
        recordRecipeInsight(input.recipe, recipeHash, input.now ?? Date.now());
      }
      return result;
    },

    delete(recipe_id) {
      if (!db) return false;
      const result = mutatePreapprovalResource(db, 'recipe', recipe_id, () => preapprovalMaterial(recipe_id),
        () => db.prepare('DELETE FROM recipes WHERE recipe_id = ?').run(recipe_id));
      if (result.changes > 0) {
        fireOnDeleted(recipe_id);
        fireOnMutated(recipe_id);
      }
      return result.changes > 0;
    },

    listForPack(pack_slug) {
      if (!db) return [];
      // Defensive: an empty / whitespace-only slug at the SQL layer
      // would match nothing (pack_slug column was stamped from a
      // validated input upstream) — but treat it as an obvious caller
      // bug rather than a silent empty list. The uninstall handler
      // already trims + non-empty-checks before reaching here.
      if (pack_slug.trim().length === 0) return [];
      // ORDER BY recipe_id ASC for deterministic uninstall ordering —
      // mid-loop throw tests + audit-replay reproducibility both rely
      // on listForPack returning the same order across runs. The
      // partial index on pack_slug means the sort is over the matching
      // subset only, not a full table scan.
      const rows = db
        .prepare(
          'SELECT recipe_id FROM recipes WHERE pack_slug = ? ORDER BY recipe_id ASC',
        )
        .all(pack_slug) as { recipe_id: string }[];
      return rows.map((r) => r.recipe_id);
    },

    listStored() {
      if (!db) return [];
      return db.prepare('SELECT * FROM recipes ORDER BY installed_at DESC').all() as StoredRecipe[];
    },

    retiredVariables(recipe_id) {
      if (!db) return [];
      return (db.prepare('SELECT name FROM recipe_retired_variables WHERE recipe_id = ? ORDER BY name')
        .all(recipe_id) as Array<{ name: string }>).map((row) => row.name);
    },

    retiredRecipeIds() {
      if (!db) return [];
      return (db.prepare('SELECT DISTINCT recipe_id FROM recipe_retired_variables ORDER BY recipe_id')
        .all() as Array<{ recipe_id: string }>).map((row) => row.recipe_id);
    },

    forgetRetiredVariables(recipe_id) {
      db?.prepare('DELETE FROM recipe_retired_variables WHERE recipe_id = ?').run(recipe_id);
    },

    updateUpstream(recipe_id, upstream, now) {
      if (!db) return;
      db.prepare(`
        UPDATE recipes SET upstream_version = ?, upstream_hash = ?, last_checked_at = ?
        WHERE recipe_id = ?
      `).run(upstream.version, upstream.hash, now, recipe_id);
    },

    setOnUpgrade(hook) {
      onUpgradeHook = hook;
    },

    addOnMutated(hook) {
      onMutatedSubscribers.push(hook);
    },
    addOnDeleted(hook) {
      onDeletedSubscribers.push(hook);
    },
    setOnMutated(hook) {
      onMutatedHook = hook;
    },
  };
};
