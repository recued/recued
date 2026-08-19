/** D-122 Phase 4 — server-side bulk-pack install handler.
 *
 *  Adapts the engine's pure `installBulkPack` orchestrator to the
 *  server's persistence layer:
 *    - Recipe registry shim — `BulkPackRegistry` over `RecipeStore`.
 *    - Hash function — re-uses `@recued/recipes` hashRecipe.
 *
 *  Exposed as a function (not yet a wired rpc — pack-install today
 *  flows through the extension's install flow which calls
 *  `installBulkPack` against its own IDB registry; the server-side
 *  call exists for two reasons:
 *
 *    1. Future MCP / rpc handler — the call shape mirrors the rpc the
 *       cloud will eventually surface so a webapp install on a
 *       paired-only client can hand the pack to the server.
 *    2. Tests — exercise the engine + recipe-store wiring against
 *       in-memory SQLite without booting the full WS server.
 *
 *  Pre-rip versions also wired `seedBackfill` to
 *  `BackfillStateStore.ensureRow` — gone with the runs_on rip.
 *  Initial-install backfill flows through the adapter path (D-124
 *  P2.1) instead of recipe-engine substrate.
 *
 *  Kept thin: the engine does the work; the handler only wires deps.
 */

import { hashRecipe } from '@recued/recipes';
import {
  installBulkPack,
  type BulkPackInstallContext,
  type BulkPackInstallInput,
  type BulkPackInstallResult,
  type BulkPackRegistry,
  type InstalledRecipeRow,
} from '@recued/marketplace';

import type { RecipeDefinition } from '@recued/contracts';
import type { RecipeStore } from './recipe-store.js';
import type { McpBodyVisibilityStore } from './storage/mcp-body-visibility-store.js';
import type {
  WebhookConsumerRecipeDeclaration,
  WebhookConsumerSnapshot,
  WebhookConsumerStore,
} from './storage/webhook-consumer-store.js';
import {
  reconcileWebhookDoors,
  type WebhookDoorEnrollDeps,
} from './webhook-door-enroll.js';
import { hasNonEmptyWebhookDeclarations } from './webhook-declaration-gate.js';

/** Wrap a `RecipeStore` so the engine can read/write through the
 *  bulk-pack-registry shape. The server's `RecipeStore.save()` is
 *  upsert-shaped, so re-installing the same slug at a higher version
 *  just overwrites — matching what the engine's transaction expects.
 *
 *  Read path: `get()` returns memory-override / SQLite / bundled in
 *  preference order; the engine only cares whether the recipe was
 *  installed before, not how (a bundled recipe shows up as "prior" so
 *  the engine treats the install as a version bump rather than a
 *  fresh install — correct outcome).
 *
 *  D-145 PA10 follow-on — `currentPackSlug` (the slug of the pack being
 *  installed in this transaction) is threaded through `markInstalled`
 *  so per-recipe pack provenance is stamped on the row. The branch:
 *    - `record.pack_slug !== undefined` — engine is restoring a prior
 *      via rollback (the prior carried its own pack_slug through
 *      `getInstalled`); preserve it byte-for-byte so a rollback over
 *      a previously pack-A-owned recipe restores pack-A's ownership;
 *    - `record.pack_slug === undefined` — fresh install (engine's
 *      builder at `install.ts:435` doesn't set the field); stamp with
 *      `currentPackSlug`.
 *  This branching keeps pack provenance correct across both the
 *  fresh-install and rollback-restoration paths without the engine
 *  having to know what `pack_slug` means semantically.
 *
 *  `getInstalled` surfaces the stored row's `pack_slug` so the engine
 *  round-trips it onto the `entry.prior` it stores for rollback. */
const wrapRecipeStore = (
  store: RecipeStore,
  publisherDefault: string,
  now: number,
  currentPackSlug: string,
): BulkPackRegistry => {
  return {
    async getInstalled(recipe_id, publisher_id) {
      const stored = store.getStored(recipe_id);
      if (stored) {
        return {
          recipe_id: stored.recipe_id,
          publisher_id: stored.publisher_id || publisher_id,
          installed_version: stored.version,
          installed_hash: stored.recipe_hash,
          installed_at: stored.installed_at,
          recipe: JSON.parse(stored.recipe_json),
          // RecipeStore doesn't track auto_run today; conservative default.
          auto_run: false,
          // Upstream tracking lives in the SQLite row but isn't on the
          // typed StoredRecipe view; the engine only reads these for
          // restoration on rollback so leaving them null is safe — the
          // worst case is a stale upstream pointer the next pollUpstream
          // tick refreshes.
          last_checked_at: null,
          upstream_version: null,
          upstream_hash: null,
          // D-145 PA10 follow-on — surface stored pack provenance so the
          // engine's rollback path restores the prior's ownership rather
          // than collapsing it onto `currentPackSlug`. The column was
          // backfilled to NULL for pre-existing rows by the
          // `ALTER TABLE recipes ADD COLUMN pack_slug` migration, so
          // legacy rows correctly report no pack ownership.
          pack_slug: stored.pack_slug,
        } satisfies InstalledRecipeRow;
      }
      // Bundled recipes show up via store.get() but have no stored row.
      // The engine treats them as a non-fresh install and records a
      // null prior — same shape, slightly different semantics on
      // rollback (uninstalls the freshly-saved row, leaving the bundled
      // copy as before).
      const bundled = store.get(recipe_id);
      if (!bundled) return null;
      return {
        recipe_id,
        publisher_id: publisher_id || publisherDefault,
        installed_version: bundled.version ?? 1,
        installed_hash: hashRecipe(bundled),
        installed_at: now,
        recipe: bundled,
        auto_run: false,
        last_checked_at: null,
        upstream_version: null,
        upstream_hash: null,
        // Bundled recipes have no SQLite row — no pack ownership to
        // restore. `null` keeps the rollback path's restoration write
        // consistent with the pre-pack state.
        pack_slug: null,
      } satisfies InstalledRecipeRow;
    },
    async markInstalled(record) {
      // RecipeStore.save() is upsert-shaped — repeats overwrite.
      // Branch on whether the engine handed us a restoration record
      // (`pack_slug !== undefined` — the prior round-tripped from
      // `getInstalled`) or a fresh install record (engine's builder
      // omits the field; default to the current pack's slug). The
      // `?? currentPackSlug` form is correct because the only legal
      // `record.pack_slug === null` case is "engine restored a prior
      // that was pre-existing" — and a pre-existing row should
      // restore to NULL, NOT to the uninstalling pack's slug.
      const stampedSlug =
        record.pack_slug === undefined ? currentPackSlug : record.pack_slug;
      store.save(
        record.recipe,
        record.publisher_id,
        'pair-sync',
        record.installed_at,
        stampedSlug,
      );
      if (record.upstream_version != null && record.upstream_hash != null) {
        store.updateUpstream(
          record.recipe_id,
          { version: record.upstream_version, hash: record.upstream_hash },
          record.last_checked_at ?? now,
        );
      }
    },
    async markUninstalled(recipe_id, _publisher_id) {
      store.delete(recipe_id);
    },
  };
};

/** Server-side bulk-pack installer. Composes the engine + recipe store
 *  and is callable from MCP handlers, future rpc shims, or boot-time
 *  one-click pack provisioning. */
export interface InstallBulkPackOnServerDeps {
  recipeStore: RecipeStore;
  /** D-247 D15.1 — write each recipe's grant row with the install's chosen access
   *  ceiling applied, BEFORE the recipes are saved. The caller closes over the
   *  tier and the grant store; this seam only supplies the resolved bodies.
   *
   *  ⚠ Absent ⇒ the store's mutation hook seeds on `chat_exposed` alone, which
   *  ignores the ceiling. */
  seedRecipeGrants?: (
    recipes: ReadonlyArray<{
      readonly recipe_id: string;
      readonly publisher_id: string;
      readonly recipe: RecipeDefinition;
    }>,
  ) => void;
  /** D-201 Slice 4 — exact logical-binding + recipe-trigger store. Absent
   * leaves webhook-declaring packs fail-closed in the pure install engine. */
  webhookConsumerStore?: WebhookConsumerStore;
  /** D-209 #1 W2b — the webhook DOOR substrate. When present, a successful
   *  install mints one derived `contract.anonymous` door per webhook-declaring
   *  recipe (pack installs default ARMED — the install consent screen is the
   *  gesture) and stamps it on the recipe's trigger rows. Absent ⇒ rows stay
   *  NULL-stamped and every dispatch denies at the contract floor. */
  webhookDoor?: WebhookDoorEnrollDeps;
  /** D-139 P6.B — optional per-pair MCP body-content visibility grant
   *  store. When present, packs that ship `mcp_body_visibility_grants[]`
   *  persist their closed-list grant keys on install; uninstall +
   *  rollback revoke them. When absent, the engine silently skips the
   *  grants (the manifest field stays a contract-only declaration —
   *  validator-checked at parse, never persisted), so the MCP read path
   *  keeps stripping body content. */
  mcpBodyVisibilityStore?: McpBodyVisibilityStore;
  /** Caller's publisher fallback when a stored row is missing the
   *  publisher_id (legacy rows from older builds). Defaults to
   *  `'recued-core'`. */
  publisherDefault?: string;
  /** Fixed clock for tests. */
  now?: number;
}

export const installBulkPackOnServer = async (
  input: BulkPackInstallInput,
  granted_permissions: Set<string>,
  deps: InstallBulkPackOnServerDeps,
): Promise<BulkPackInstallResult> => {
  const now = deps.now ?? Date.now();
  for (const resolved of input.recipes) {
    const incoming = resolved.recipe?.recipe;
    if (!incoming) continue;
    const stored = deps.recipeStore.getStored(incoming.recipe_id);
    const existing = deps.recipeStore.get(incoming.recipe_id);
    if (stored !== null
      && stored.pack_slug !== input.pack_slug
      && existing !== null
      && hasNonEmptyWebhookDeclarations(existing)) {
      return {
        ok: false,
        installed: [],
        rolled_back: [],
        failure: {
          code: 'validator_rejected',
          message: `Pack install cannot shadow webhook recipe '${incoming.recipe_id}' owned outside '${input.pack_slug}'`,
        },
      };
    }
  }
  // ── D-247 D15.1 — THE OWNER'S CEILING, WRITTEN BEFORE THE SAVES ──────────
  //
  // ⛔⛔ ORDER IS THE MECHANISM. The ordinary grant seed rides `RecipeStore`'s
  // mutation hook, which knows only a `recipe_id` — the install dialog's chosen
  // access tier is nowhere in scope there, so a pack recipe would be seeded on
  // `chat_exposed` ALONE and the owner's "Read only" would mean nothing.
  // Writing here, BEFORE `markInstalled` reaches `store.save`, lets the hook's
  // INSERT-IF-ABSENT no-op and carries the answer across without threading
  // ambient install state through the store.
  //
  // ⚠ Absent dep ⇒ the hook seeds as before. That is a real degradation (the
  // ceiling is ignored) and it is the SAFE direction only because pack content
  // defaults `chat_exposed: false`; it is not a reason to leave it unwired.
  if (deps.seedRecipeGrants) {
    deps.seedRecipeGrants(
      input.recipes.flatMap((r) =>
        r.recipe?.recipe
          ? [{
              recipe_id: r.recipe.recipe_id,
              publisher_id: r.recipe.publisher_id,
              recipe: r.recipe.recipe,
            }]
          : []),
    );
  }
  // D-145 PA10 follow-on — `input.pack_slug` flows through the engine
  // as the pack identity. Capture it as `currentPackSlug` for the
  // wrapper so every `markInstalled` call in this transaction stamps
  // the right pack provenance (fresh installs) or preserves the
  // restored prior's slug (rollback). The engine validates
  // `input.pack_slug` upstream via `parseBulkPackManifest`'s SLUG_RE,
  // so reaching this site with an empty / malformed string would be a
  // contract violation upstream — no defensive trim needed.
  const registry = wrapRecipeStore(
    deps.recipeStore,
    deps.publisherDefault ?? 'recued-core',
    now,
    input.pack_slug,
  );

  // D-139 P6.B — body-content MCP visibility grants. The engine calls
  // `grantBodyVisibility` AFTER every recipe lands (so a rollback reverts
  // the grant alongside the registry rows) and `revokeBodyVisibility` on
  // rollback with the exact grant set it persisted. Server scope: the
  // grant is keyed by the granting pack `(pack_slug, publisher)` — the
  // callback carries no token. Absent store ⇒ callbacks omitted ⇒ the
  // engine skips persistence (manifest field stays contract-only).
  const bodyStore = deps.mcpBodyVisibilityStore;
  // Transaction-scoped rollback: snapshot which grant keys the pack ALREADY
  // held before this transaction's idempotent upsert, so a rollback only
  // revokes the keys THIS install added. Without this, a rollback during a
  // RE-install / version-bump (the re-grant is a no-op upsert, then a later
  // step — e.g. an SI insert — fails) would wipe a grant that predated the
  // transaction. Captured in this composer's scope; both callbacks close over
  // it.
  const preExistingBodyGrants = new Set<string>();
  const grantBodyVisibility: BulkPackInstallContext['grantBodyVisibility'] =
    bodyStore
      ? async ({ pack_slug, publisher, grants, granted_at }) => {
          for (const k of bodyStore.listGrantsForPack({ pack_slug, publisher })) {
            preExistingBodyGrants.add(k);
          }
          bodyStore.grant({ pack_slug, publisher, grants, granted_at });
        }
      : undefined;
  const revokeBodyVisibility: BulkPackInstallContext['revokeBodyVisibility'] =
    bodyStore
      ? async ({ pack_slug, publisher, grants }) => {
          // Revoke only the keys this transaction newly added; leave any that
          // pre-existed (the idempotent upsert only refreshed their granted_at).
          const added = grants.filter((k) => !preExistingBodyGrants.has(k));
          if (added.length > 0) {
            bodyStore.revokeForPack({ pack_slug, publisher, grants: added });
          }
        }
      : undefined;

  const webhookConsumerStore = deps.webhookConsumerStore;
  let appliedWebhookSnapshot: WebhookConsumerSnapshot | null = null;
  let appliedWebhookRecipes: readonly WebhookConsumerRecipeDeclaration[] = [];
  const applyWebhookBindings: BulkPackInstallContext['applyWebhookBindings'] =
    webhookConsumerStore
      ? async (input) => {
          const snapshot = webhookConsumerStore.replaceConsumer({
            consumer_kind: 'pack_install',
            consumer_id: input.pack_slug,
            requirements: input.requirements,
            selections: input.selections,
            recipes: input.recipes,
          });
          appliedWebhookSnapshot = snapshot;
          appliedWebhookRecipes = input.recipes;
          return snapshot;
        }
      : undefined;
  const restoreWebhookBindings: BulkPackInstallContext['restoreWebhookBindings'] =
    webhookConsumerStore
      ? async (rollbackToken) => {
          const snapshot = rollbackToken as WebhookConsumerSnapshot;
          try {
            webhookConsumerStore.restoreConsumer(snapshot);
          } catch (error) {
            // An upgrade rollback must not leave the just-attempted trigger set
            // attached to the restored prior recipe rows. If exact restoration
            // fails, revoke the whole consumer as the fail-closed fallback.
            try {
              webhookConsumerStore.removeConsumer(
                snapshot.consumer_kind,
                snapshot.consumer_id,
              );
            } catch {
              // Preserve the original restore failure for the engine's rollback
              // accounting; a second storage fault cannot be repaired here.
            }
            throw error;
          }
        }
      : undefined;

  const ctx: BulkPackInstallContext = {
    granted_permissions,
    registry,
    hashRecipe,
    now,
    ...(grantBodyVisibility ? { grantBodyVisibility } : {}),
    ...(revokeBodyVisibility ? { revokeBodyVisibility } : {}),
    ...(applyWebhookBindings ? { applyWebhookBindings } : {}),
    ...(restoreWebhookBindings ? { restoreWebhookBindings } : {}),
  };

  const result = await installBulkPack(input, ctx);
  if (result.ok && webhookConsumerStore && appliedWebhookSnapshot) {
    // A committed replacement no longer needs its rollback window. Revoke
    // detached claims belonging to the superseded trigger ids and release
    // their payload pins only after every later install phase has succeeded.
    webhookConsumerStore.finalizeConsumerReplacement(appliedWebhookSnapshot);

    // D-209 #1 W2b — mint the pack's webhook DOORS, one per webhook-declaring
    // recipe, strictly after the install transaction committed (a mint inside
    // the transaction would leak an orphan live door on rollback — the same
    // ordering rule as `recipe.save`). An upgrade whose new trigger set drops
    // a recipe retires that recipe's prior door; an unchanged capability
    // re-uses the prior door silently (§5.1b). Failures degrade fail-closed:
    // the rows stay NULL-stamped (dispatch denies) and re-install re-mints.
    if (deps.webhookDoor) {
      try {
        const outcomes = reconcileWebhookDoors(
          {
            consumer_kind: 'pack_install',
            consumer_id: input.pack_slug,
            prior: appliedWebhookSnapshot,
            recipes: appliedWebhookRecipes.flatMap((declaration) => {
              const recipe = deps.recipeStore.get(declaration.recipe_id);
              return recipe === null
                ? []
                : [{
                    recipe_id: declaration.recipe_id,
                    publisher_id: declaration.publisher_id,
                    recipe,
                  }];
            }),
            // The install rpc invocation is the owner's consent gesture
            // (Settings → Packs is the sole writer by the reserved-prefix
            // gate); the pack itself is only the distribution vehicle.
            mintedBy: 'pack_install',
            retireReason: 'pack_reinstalled',
          },
          deps.webhookDoor,
        );
        for (const [recipeId, outcome] of outcomes) {
          if (outcome.kind === 'minted') continue;
          const detail = outcome.kind === 'refused'
            ? outcome.refusal.reason
            : outcome.message;
          console.warn(
            `[pack-install] webhook door not minted for '${recipeId}' (${outcome.kind}: ${detail}) — its dispatches deny until re-install`,
          );
        }
      } catch (error) {
        console.warn(
          `[pack-install] webhook door reconciliation failed for '${input.pack_slug}' — its dispatches deny until re-install`,
          error,
        );
      }
    }
  }
  return result;
};
