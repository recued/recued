/** D-145 PA10 follow-on Slice B — `packs.uninstall` rpc handler.
 *
 *  Reverses the install transaction for a previously-installed bundled
 *  pack. Reads the bundled manifest off disk (same `community/packs/`
 *  scan path as `packs.list`), then drops in reverse-install order:
 *
 *    1. Body-content MCP visibility grants — the production composition wires
 *       the shared grant store through install, rollback, runtime reads, and
 *       uninstall. This step revokes every grant persisted for the pack and
 *       reports the removed keys in `removed.body_grants`.
 *    2. Pack-owned recipes — `recipeStore.listForPack(<slug>)` walks
 *       the per-pair recipe rows and returns the recipe_ids whose
 *       `pack_slug` column matches the uninstalling slug. Each id
 *       drops via `recipeStore.delete()`; the manifest's `recipes[]`
 *       is NOT used as the iteration source so:
 *         - recipes the pack installed at v1 but not present in v2's
 *           manifest still get dropped (cross-version drift survives);
 *         - bundled / manually-installed / other-pack recipes whose
 *           slug happens to collide stay untouched (pack_slug column
 *           identifies the owner explicitly).
 *       This closes the Codex MAJOR 2 v1 limitation Slice B inherited
 *       from Slice A; the manifest is still loaded above as the
 *       `not_found` gate + the source of truth for SI prefix.
 *
 *  Failure surface mirrors `packs.install`'s typed result body — the
 *  rpc only raises `bad_request` on argument shape problems. Engine-
 *  side outcomes (`ok: false` with a typed `failure.code`) flow on the
 *  result body so the Settings UI can render targeted copy:
 *
 *    - `not_found`  — no bundled manifest at `community/packs/<slug>.json`
 *      (or it failed validation). Reachable only via stale UI state /
 *      concurrent removal — the UI should refresh.
 *    - `webhook_cleanup_required` — an operation-bound consumer must retain
 *      its detach authority until workflow-owned provider resources are clear.
 *    - `unexpected` — a substrate call (recipe delete) threw. The
 *      `removed` block still reports whatever succeeded BEFORE the throw
 *      (best-effort, like the install rollback path); a typical SQLite
 *      error would surface here.
 *
 *  Channel-isolation invariant: `packs.` is in
 *  `MCP_RESERVED_RPC_PREFIXES` (D-138 P1). The uninstall transaction
 *  drops recipe rows in one shot; the reserved prefix keeps MCP-channel
 *  agents off the writer entirely. The D-138 ratchet test already
 *  asserts the prefix stays reserved.
 *
 *  Foundation-pack note: this handler does not differentiate
 *  foundation packs (`manifest.pre_install: true`) from user-installed
 *  packs — both run the same uninstall transaction. The Settings UI
 *  hides the Delete affordance on foundation packs (boot's
 *  `foundation-pack-pre-install.ts` would re-install on next start),
 *  but the handler accepts foundation slugs for symmetry + power-user
 *  scripted scenarios.
 *
 *  Spec: D-145 § PA10 follow-on (Settings → Packs Slice
 *  B uninstall affordance). */


import {
  RpcError,
  type BulkPackUninstallResultLike,
  type HandlerSlice,
  type RunnabilityTransition,
  type ServerRpcRegistry,
} from '@recued/contracts';

import { isCoreFeaturePack, resolveBundledPackManifest } from './bundled-pack-source.js';
import type { LocalManifestStore } from './ingredient-authoring/local-manifest-store.js';
import {
  applyInstallAudienceGrantIds,
  type SellerInstallAudienceStore,
} from './ingredient-authoring/install-composition.js';
import type { ManifestRegistry } from './manifest-loader.js';
import { getInstalledPack, privateByoDropIds, removePackInventory } from './pack-inventory.js';
// D-220 Slice B — pack-shipped intake templates leave with their pack.
import { removePackReceptionTemplates } from './pack-reception-templates.js';
import type { RecipeStore } from './recipe-store.js';
import type { RecipeRunnabilityBroadcaster } from './recipe-runnability-handler.js';
import type { McpBodyVisibilityStore } from './storage/mcp-body-visibility-store.js';
import {
  WebhookConsumerStoreError,
  type WebhookConsumerStore,
} from './storage/webhook-consumer-store.js';
import {
  retireWebhookDoors,
  snapshotDoorContractIds,
} from './webhook-door-enroll.js';
import { looksLikeGeneratedMcpPackSlug, recordsCatalogSlug } from '@recued/ingredient-authoring';
import { recipeOwnedStateOf } from './recipe-owned-state.js';
import type { ContractStore } from './storage/contract-store.js';
import type { SavedDataViewStore } from './saved-data-view-store.js';
import { packSavedViewId, packSavedViewsFrom } from './pack-saved-views.js';
import type { ChatInboundTokenStore } from './storage/chat-inbound-token-store.js';
import { createContractGrantStore } from './storage/contract-grant-store.js';
import { createConnectionCatalogBindingStore } from './storage/connection-catalog-binding-store.js';
import type { WsClient } from './ws-server.js';
import {
  uninstallRecordsPackAtomic,
  type RecordsUninstallDisposition,
} from './records/install-coordinator.js';
import type { RecordsStore } from './records/store.js';

/** D-145 PA10 follow-on Slice B — narrow broadcast emitter for the
 *  uninstall handler. Same shape rationale as
 *  `PackInstallBroadcastEmitter` (mirrors `ChatBroadcastEmitter`). Bin
 *  composer builds this from `EventBus.emit`; tests pass a synthetic
 *  capturing emitter. */
export interface PackUninstallBroadcastEmitter {
  emit(event: {
    kind: 'pack_uninstalled';
    pack_slug: string;
    pack_name: string;
    pack_version: number;
    removed_recipe_count: number;
  }): void;
}

export interface PackUninstallRpcDeps {
  /** Per-pair recipe store. Required — the handler calls `delete()` per
   *  recipe in the resolved manifest. Absent → composer returns the
   *  undefined-bundle + the rpc surfaces `not_configured`. */
  recipeStore: RecipeStore;
  /** D-201 Slice 4 — removes logical ingress bindings and exact recipe
   * triggers without deleting the shared ingress or active-run payload pins. */
  webhookConsumerStore?: WebhookConsumerStore;
  /** D-209 #1 W2b — the contract store the pack's webhook DOORS were minted
   *  into. When present, uninstall revokes every door stamped on the removed
   *  trigger rows so no live `contract.anonymous` authority outlives its
   *  consumer. Absent ⇒ the doors go unreferenced (inert — nothing carries
   *  their id after the rows drop) but stay live until a re-install retires
   *  them; wire it wherever the install path's mint deps are wired. */
  webhookDoorDefinitionStore?:
    import('./storage/contract-definition-store.js').ContractDefinitionStore;
  /** D-139 P6.B — per-pair MCP body-content visibility grant store.
   *  Optional — when present, uninstall revokes every body grant the
   *  pack persisted (keyed by `(pack_slug, publisher)`); the dropped
   *  keys surface in `removed.body_grants`. When absent the step is a
   *  no-op (symmetric with the install path's opt-in). */
  mcpBodyVisibilityStore?: McpBodyVisibilityStore;
  /** D-145 PA10 follow-on — optional broadcast emitter. When wired the
   *  handler emits a `pack_uninstalled` event after the engine
   *  transaction returns `ok: true`. Failed lookups (`not_found`) do
   *  NOT emit; mid-transaction throws (`unexpected`) also do NOT emit
   *  because the partial-rollback state isn't a coherent "pack is
   *  gone" signal for subscribers. Best-effort: emit failures are
   *  swallowed so a bus-side hiccup never leaks into the rpc result
   *  the user sees in the confirm strip. Optional so dbless / pre-bus
   *  boot harnesses keep working. */
  broadcast?: PackUninstallBroadcastEmitter;
  /** R2 build step 4c.4 — derived-runnability broadcaster. When wired, the
   *  handler recomputes every recipe's runnability and fans the fresh snapshot on
   *  the `recipe_runnability_changed` bus kind after a successful uninstall (the
   *  pack's recipes are gone; a survivor that lost its last provider goes blocked).
   *  Best-effort + optional — fires only on `ok: true`, after the profile
   *  reconcile loop so the recompute reads correct post-uninstall state. */
  recipeRunnabilityBroadcast?: RecipeRunnabilityBroadcaster;
  /** R2 build step 4c.3 + §1.6 follow-on — the reverse-walk: which recipes WORSEN
   *  when this pack is uninstalled? The composer binds it to
   *  `listRecipesWorsenedByPackUninstall(recipeRunnabilityDeps, pack_slug)`, which
   *  derives the pack's bound connections (whole-connection removal) AND its
   *  grant-target connections (grant-only profile shrink on a surviving
   *  registered-vendor connection) from its own stores. The handler calls it ONCE
   *  BEFORE any mutation (the providers + grant rows must still be present) and
   *  splits the worsenings by `after` into the result's `would_disable`
   *  (`blocked`) + `would_degrade` (`degraded`) disclosures. Best-effort +
   *  optional — absent (dbless / no connection+profile store) → the result omits
   *  both fields, like `recipe.runnability` returning `not_configured`.
   *  Independent of `recipeRunnabilityBroadcast`: the disclosure is a synchronous
   *  PRE-mutation prediction returned in THIS rpc result; the broadcast fans the
   *  POST-mutation state to OTHER paired clients. */
  computeWouldWorsen?: (pack_slug: string) => RunnabilityTransition[];
  /** D-165 P3.1 — gateway-read-only `contract.*` store. When present the
   *  handler drops this pack's `installed_pack` + owned `installed_ingredient`
   *  inventory rows on a successful uninstall (best-effort — a bookkeeping
   *  failure never fails the uninstall). Optional so dbless / pre-contract-
   *  store boot harnesses keep working. */
  contractStore?: ContractStore;
  /** D-289 — late-bound saved-view store.
   *
   *  ⛔ A GETTER, NOT THE STORE. The store is built in `compose-listeners`
   *  (it needs `execution.notificationBlock` for its alert runtime) while these
   *  deps compose a stage earlier in `compose-rpc-context`, so there is nothing
   *  to hand over at construction. Reads resolve at CALL time — an install
   *  always happens after boot — which is the same shape
   *  `publishExecutionCaseOfferNotifier` uses for the same ordering problem.
   *
   *  Absent, or resolving undefined (db-less harness) ⇒ a manifest's
   *  `saved_view` contents install nothing and the pack still succeeds: a view
   *  is a convenience surface, never a capability. */
  getSavedDataViewStore?: () => SavedDataViewStore | undefined;
  /** D-304 — the stores a recipe's own state lives in, so `packs.uninstall_preview`
   *  can say what goes with the pack's recipes. The REMOVAL is not here: it runs from
   *  the recipe store's deletion hook (`recipe-owned-state.ts`), which every
   *  uninstall path reaches. Late-bound, like the saved-view store. */
  getRecipeOwnedState?: () => import('./recipe-owned-state.js').RecipeOwnedStateDeps | undefined;
  /** D-225 Slice 2 — remove the MCP connection a GENERATED pack was minted
   *  from, and report its name so the surface can say what it did. Returns null
   *  when no enrolled connection derives this slug — which is every pack that
   *  is not a generated one.
   *
   *  ⛔ The cycle with `ConnectionRpcDeps.teardownGeneratedPack` is broken
   *  STRUCTURALLY: the deps this closure hands the connection delete omit that
   *  hook, so coming back here is not possible rather than merely not done. */
  removeGeneratedPackConnection?: (pack_slug: string) => Promise<string | null>;
  /** D-196 install-audience customer rows and their existing bearer snapshots.
   *  Together these let uninstall revoke pack-owned grants from both durable
   *  halves of a customer instance without touching ordinary MCP tokens. */
  sellerStore?: SellerInstallAudienceStore;
  inboundTokenStore?: Pick<ChatInboundTokenStore, 'getTokenById' | 'updateTokenGrants'>;
  /** D-170 (packs.install composition branch) — local manifest body store +
   *  live manifest registry, the uninstall counterparts to the same handles on
   *  `PackInstallRpcDeps`. When BOTH are present alongside `contractStore`, a
   *  pack the install path provisioned a `composition` for has its locally-
   *  authored catalog body deleted + deregistered (refcount-aware) so the
   *  gateway stops resolving it — otherwise the body lingers, resolvable but
   *  unremovable (the inventory row uninstall would have dropped is gone). Only
   *  ids with a LOCAL body are touched; by-ref marketplace ids (and the
   *  registry's bundled manifests) are left untouched. Absent → no body cleanup
   *  (recipe-only packs need none; the install path could not have provisioned a
   *  composition without these either). */
  localManifestStore?: LocalManifestStore;
  registry?: Pick<ManifestRegistry, 'unregister'>;
  /** D-221 fixed Records store. Together with contract/local-manifest/registry
   * this enables the full-ref atomic uninstall path. */
  recordsStore?: RecordsStore;
  /** D-170 gap #2 live-reconcile — (re)derive a connection's operation profile by
   *  name. Called AFTER this pack's connection→catalog bindings are dropped, for each
   *  connection the pack had bound, so the now-orphan local profile is removed at once
   *  (a registered-vendor connection keeps its vendor profile). Optional: dbless /
   *  no-profile-store boots omit it + the stale profile is unreachable anyway (the
   *  catalog is deregistered) until the next connect/boot drops it. */
  reconcileConnectionProfile?: (connectionName: string) => void;
  /** D-192 — sibling of `reconcileConnectionProfile`: unregister the formerly-
   *  bound connection's pack-declared work-entity Sources post-commit (the
   *  binding is dropped → the resolver yields nothing → unregister). */
  reconcileWorkEntitySources?: (connectionName: string) => void;
  /** Fixed clock for customer bearer grant-snapshot reconciliation tests. */
  now?: () => number;
  /** Override the default `community/packs` directory. Tests pass a
   *  scratch dir; production callers leave undefined to use the bundled
   *  location. Mirrors `packs.list`'s same-named seam so test harnesses
   *  driving both rpcs can share one fixture root. */
  packDir?: string;
}

type PacksUninstallArgs = {
  pack_slug: string;
  publisher?: string;
  records_disposition?: RecordsUninstallDisposition;
  expected_records_state_generation?: number;
  records_purge_confirmation?: string;
};

/** Empty `removed` shape — used by every early-return path so the
 *  rpc surface stays uniform regardless of which step failed first. */
const emptyRemoved = (): BulkPackUninstallResultLike['removed'] => ({
  recipes: [],
  body_grants: [],
});

export const handlePacksUninstall = async (
  deps: PackUninstallRpcDeps,
  args: PacksUninstallArgs,
): Promise<{ result: BulkPackUninstallResultLike }> => {
  if (args == null || typeof args !== 'object') {
    throw new RpcError('bad_request', 'packs.uninstall: args required');
  }
  if (typeof args.pack_slug !== 'string') {
    throw new RpcError(
      'bad_request',
      'packs.uninstall: pack_slug must be a string',
    );
  }
  // Defensive trim check — empty / whitespace-only slugs are a malformed
  // input that should not reach the recipe store. The pack-list handler's
  // manifest validator already enforces SLUG_RE shape for legitimate
  // packs, so this branch is only reached by a malformed UI / programmatic
  // caller.
  const pack_slug = args.pack_slug.trim();
  if (pack_slug.length === 0) {
    throw new RpcError(
      'bad_request',
      'packs.uninstall: pack_slug must be a non-empty string',
    );
  }

  const manifest = resolveBundledPackManifest(deps.packDir, pack_slug);
  // 🔑 A CORE FEATURE IS NOT OWNER-MANAGEABLE (owner ruling 2026-09-07). The
  // roster never lists one, so no UI can reach this — which is exactly why the
  // refusal lives HERE and not in the panel: "the user cannot manage them" is a
  // property of the server, not of which buttons a client happens to draw.
  //
  // ⚠ It also stops being a lie. Uninstall used to SUCCEED on a foundation pack
  // and the next boot silently put it back, which the panel had to disclose in a
  // warning ("uninstalling will undo on next start") — a destructive action
  // whose only honest description was that it does not last.
  if (manifest !== null && isCoreFeaturePack(manifest)) {
    throw new RpcError(
      'forbidden',
      `packs.uninstall: ${JSON.stringify(pack_slug)} is a core feature installed and maintained by the server, not a pack you manage`,
    );
  }
  // D-221 — Records inventory/capability identity is full-ref-derived rather
  // than public-slug keyed. Resolve it before the legacy slug existence proof,
  // then run the dedicated all-or-nothing data-first coordinator.
  const matchingRecords = deps.recordsStore?.listNamespaces()
    .filter((namespace) => namespace.owner.pack_slug === pack_slug) ?? [];
  const requestedPublisher = typeof args.publisher === 'string' && args.publisher.trim().length > 0
    ? args.publisher.trim()
    : manifest?.publisher;
  if (requestedPublisher === undefined && matchingRecords.length > 1) {
    throw new RpcError(
      'bad_request',
      'packs.uninstall: publisher is required for same-slug Records packs',
      400,
    );
  }
  const recordsNamespace = requestedPublisher !== undefined
    ? matchingRecords.find((namespace) => namespace.owner.publisher === requestedPublisher)
    : matchingRecords[0];
  if (args.records_disposition !== undefined && recordsNamespace === undefined) {
    throw new RpcError(
      'bad_request',
      'packs.uninstall: Records disposition requires an installed/retained full-ref namespace',
      400,
    );
  }
  if (recordsNamespace !== undefined) {
    if (!deps.contractStore || !deps.localManifestStore || !deps.registry || !deps.recordsStore) {
      return {
        result: {
          ok: false,
          removed: emptyRemoved(),
          failure: {
            code: 'unexpected',
            message: 'packs.uninstall: Records lifecycle dependencies are not configured',
          },
        },
      };
    }
    try {
      const removed = await uninstallRecordsPackAtomic({
        recipeStore: deps.recipeStore,
        recordsStore: deps.recordsStore,
        localManifestStore: deps.localManifestStore,
        contractStore: deps.contractStore,
        registry: deps.registry,
        applyAudience: (operationIds, sourcePack, selection) => {
          applyInstallAudienceGrantIds(
            {
              contractStore: deps.contractStore!,
              ...(deps.sellerStore ? { sellerStore: deps.sellerStore } : {}),
              ...(deps.inboundTokenStore ? { inboundTokenStore: deps.inboundTokenStore } : {}),
              now: deps.now ?? Date.now,
            },
            operationIds,
            sourcePack,
            selection,
          );
        },
      }, {
        owner: recordsNamespace.owner,
        ...(args.records_disposition !== undefined
          ? { disposition: args.records_disposition }
          : {}),
        ...(args.expected_records_state_generation !== undefined
          ? { expected_state_generation: args.expected_records_state_generation }
          : {}),
        ...(args.records_purge_confirmation !== undefined
          ? { confirmation: args.records_purge_confirmation }
          : {}),
      });
      // D-220 Slice B — the pack's shipped intake templates were swept INSIDE the
      // coordinator's transaction (`uninstallRecordsPackAtomic`), keyed by the
      // authored slug + publisher; nothing to do here.
      try {
        const version = recordsNamespace.state.state === 'ready'
          ? recordsNamespace.state.version
          : recordsNamespace.state.state === 'orphaned'
            ? recordsNamespace.state.last_version
            : 0;
        deps.broadcast?.emit({
          kind: 'pack_uninstalled',
          pack_slug,
          pack_name: manifest?.name ?? pack_slug,
          pack_version: version,
          removed_recipe_count: removed.removed_recipes.length,
        });
      } catch {
        // Best-effort UI convergence; durable uninstall already committed.
      }
      deps.recipeRunnabilityBroadcast?.recomputeAndEmit();
      return {
        result: {
          ok: true,
          removed: { recipes: removed.removed_recipes, body_grants: [] },
          records: {
            owner: removed.owner,
            disposition: removed.disposition,
            retired_event_count: removed.retired_events.length,
            ...(removed.export !== undefined ? { export: removed.export } : {}),
          },
        },
      };
    } catch (error) {
      return {
        result: {
          ok: false,
          removed: emptyRemoved(),
          failure: {
            code: 'unexpected',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }
  // Existence proof, cheapest-first + MANIFEST-SAFE: a bundled manifest, else a
  // MARKETPLACE pack's `installed_pack` inventory row, else (an inventory-write-
  // FAILED install — the install path records that row best-effort AFTER recipes
  // commit, so a hiccup can orphan recipes with no inventory row) its owned
  // recipe rows. The removal itself is entirely slug/ownership-driven
  // (`listForPack(slug)` for recipes, `removePackInventory` for ingredients, the
  // grant store by `pack_slug`) — the manifest is only ever a gate + identity.
  //
  // The inventory + recipe reads run ONLY when there's no manifest: a bundled
  // uninstall must neither depend on nor be aborted by an inventory read (both
  // are try-wrapped so a store hiccup fails toward "not this proof", never a
  // throw). Only when ALL THREE proofs are absent is the slug not installed.
  let inventoryRow: { version?: number; publisher?: string } | null = null;
  let ownsRecipes = false;
  let hasBodyGrants = false;
  let hasWebhookBindings = false;
  if (manifest === null) {
    try {
      inventoryRow = deps.contractStore ? getInstalledPack(deps.contractStore, pack_slug) : null;
    } catch {
      inventoryRow = null;
    }
    if (inventoryRow === null) {
      try {
        ownsRecipes = deps.recipeStore.listForPack(pack_slug).length > 0;
      } catch {
        ownsRecipes = false;
      }
      // Body grants are a FOURTH existence proof (+ a body-content exposure the
      // revoke below closes): a recipe-free marketplace pack whose inventory
      // write failed can leave a body grant as its ONLY durable artifact, and it
      // must stay uninstallable so the grant is revoked rather than orphaned.
      if (!ownsRecipes) {
        try {
          hasBodyGrants = deps.mcpBodyVisibilityStore?.hasGrantsForPackSlug(pack_slug) ?? false;
        } catch {
          hasBodyGrants = false;
        }
      }
      if (!ownsRecipes && !hasBodyGrants) {
        try {
          hasWebhookBindings = (deps.webhookConsumerStore?.listBindings({
            consumer_kind: 'pack_install',
            consumer_id: pack_slug,
          }).length ?? 0) > 0;
        } catch {
          hasWebhookBindings = false;
        }
      }
    }
  }
  if (manifest === null && inventoryRow === null && !ownsRecipes
    && !hasBodyGrants && !hasWebhookBindings) {
    return {
      result: {
        ok: false,
        removed: emptyRemoved(),
        failure: {
          code: 'not_found',
          message: `packs.uninstall: no installed pack for slug ${JSON.stringify(pack_slug)}`,
        },
      },
    };
  }
  // Identity fields — the bundled manifest when present, else the inventory row
  // (a marketplace pack persists slug + version + publisher but NO display name,
  // so the broadcast name degrades to the slug; an orphaned recipes-only install
  // has neither → publisher undefined, version 0).
  const packPublisher = manifest?.publisher ?? inventoryRow?.publisher;
  const packName = manifest?.name ?? pack_slug;
  const packVersion = manifest?.version ?? inventoryRow?.version ?? 0;

  // R2 build step 4c.3 + §1.6 follow-on — "this disables N recipes" disclosure
  // (doc §1.6). Compute BEFORE any mutation, while the pack's bindings + grant
  // rows are STILL present (the walk derives both removal shapes from them: a
  // local-catalog-bound connection vanishes wholesale; a surviving registered-
  // vendor connection's profile shrinks to the re-derivation sans this pack's
  // granted groups). The walk returns every SURVIVOR-relevant worsening; we split
  // it by `after` — BLOCKED → `would_disable`, DEGRADED → `would_degrade` —
  // excluding this pack's OWN recipes from both (they're being deleted, listed in
  // `removed.recipes`, not "disabled"). Best-effort + gated on the optional
  // thunk; a read failure must never abort the uninstall.
  const wouldDisable: RunnabilityTransition[] = [];
  const wouldDegrade: RunnabilityTransition[] = [];
  if (deps.computeWouldWorsen) {
    try {
      const owned = new Set(deps.recipeStore.listForPack(pack_slug));
      for (const t of deps.computeWouldWorsen(pack_slug)) {
        if (owned.has(t.recipe_id)) continue;
        if (t.after === 'blocked') wouldDisable.push(t);
        else if (t.after === 'degraded') wouldDegrade.push(t);
      }
    } catch {
      /* best-effort — a runnability read failure never aborts the uninstall result */
    }
  }

  // Track per-category outcomes as we go so a mid-transaction throw
  // still reports what landed before the failure (best-effort, matches
  // the install rollback path's swallow-on-rollback shape).
  const removedRecipes: string[] = [];
  const removedBodyGrants: string[] = [];

  // D-201 Slice 4 — revoke recipe payload/read authority before deleting any
  // installed rows. Unbinding cancels active consumer claims and releases their
  // payload pins because those runs immediately lose read authorization.
  if (deps.webhookConsumerStore) {
    try {
      const removedWebhook = deps.webhookConsumerStore.removeConsumer(
        'pack_install',
        pack_slug,
      );
      // D-209 #1 W2b — retire the pack's webhook DOORS alongside their
      // trigger rows: a revoked definition stops governing immediately, so
      // no `contract.anonymous` authority outlives the consumer that carried
      // it. Best-effort AFTER the removal committed (revocation is
      // idempotent; a re-install of the pack retires stragglers).
      if (deps.webhookDoorDefinitionStore) {
        try {
          retireWebhookDoors(
            snapshotDoorContractIds(removedWebhook),
            'pack_uninstalled',
            { definitionStore: deps.webhookDoorDefinitionStore },
          );
        } catch {
          /* best-effort — an unreferenced live door is inert; re-install retires it */
        }
      }
    } catch (e) {
      const cleanupRequired = e instanceof WebhookConsumerStoreError
        && e.code === 'cleanup_required';
      return {
        result: {
          ok: false,
          removed: emptyRemoved(),
          failure: {
            code: cleanupRequired
              ? 'webhook_cleanup_required'
              : 'unexpected',
            message: cleanupRequired
              ? `packs.uninstall: ${(e as Error).message}`
              : `webhookConsumerStore.removeConsumer threw: ${(e as Error).message ?? String(e)}`,
          },
        },
      };
    }
  }

  // Step 1 — Body-content MCP visibility grants (D-139 P6.B). Drop every
  // grant the pack persisted, keyed by `(pack_slug, publisher)`. Robust to
  // manifest drift in the grant SET (revoke-all-for-pack, like the SI step's
  // by-prefix drop); `manifest.publisher` is the pack's stable identity half
  // (slug+publisher). Absent store ⇒ no-op (symmetric with install). The
  // dropped keys surface in `removed.body_grants`.
  // ALWAYS revoke when the store is wired — publisher-scoped when known (bundled
  // manifest / inventory row), else slug-wide. A publisher-less orphan (an
  // inventory-write-failed marketplace install) must STILL drop its body grants,
  // or body content stays MCP-readable after the user believes the pack was
  // removed (the store's `revokeForPack` drops every grant for the slug when no
  // publisher is given).
  if (deps.mcpBodyVisibilityStore) {
    try {
      removedBodyGrants.push(
        ...deps.mcpBodyVisibilityStore.revokeForPack({
          pack_slug,
          ...(packPublisher !== undefined ? { publisher: packPublisher } : {}),
        }),
      );
    } catch (e) {
      return {
        result: {
          ok: false,
          removed: {
            recipes: [...removedRecipes],
            body_grants: [...removedBodyGrants],
          },
          failure: {
            code: 'unexpected',
            message: `mcpBodyVisibilityStore.revokeForPack threw: ${(e as Error).message ?? String(e)}`,
          },
        },
      };
    }
  }

  // Step 2 — Recipes. Drop every row whose `pack_slug` column matches
  // the uninstalling slug. This closes both v1 limitations the prior
  // manifest-driven loop carried (Codex MAJOR 2 from Slice B):
  //
  //   1. Pre-existing-recipe overdelete — a recipe with the same slug
  //      that was bundled / manually saved / installed by a different
  //      pack carries `pack_slug = NULL` or `pack_slug = '<other>'`;
  //      neither matches `pack_slug = ?` so the row stays.
  //   2. Cross-version drift — recipes installed by the pack at v1
  //      but missing from v2's manifest still carry `pack_slug =
  //      '<slug>'` on their row and are now dropped (the prior loop
  //      missed them because it iterated the current manifest's
  //      `recipes[]`). The manifest is only used as the source of
  //      truth for SI prefix + body-grant lookup, not the recipe
  //      list.
  //
  // `listForPack` + per-id `delete()` (one DELETE per row) keeps the
  // failure surface uniform with the old loop: a mid-loop SQLite
  // exception leaves `removedRecipes` populated with whatever
  // succeeded before the throw, exactly matching the install rollback
  // path's best-effort shape. `delete()` returns false for already-
  // gone rows so concurrent uninstall (e.g. two tabs racing) converges
  // cleanly without double-counting.
  let ownedRecipeIds: string[];
  try {
    ownedRecipeIds = deps.recipeStore.listForPack(pack_slug);
  } catch (e) {
    return {
      result: {
        ok: false,
        removed: {
          recipes: [...removedRecipes],
          body_grants: [...removedBodyGrants],
        },
        failure: {
          code: 'unexpected',
          message: `recipeStore.listForPack threw: ${(e as Error).message ?? String(e)}`,
        },
      },
    };
  }
  for (const recipe_id of ownedRecipeIds) {
    try {
      const removed = deps.recipeStore.delete(recipe_id);
      if (removed) removedRecipes.push(recipe_id);
    } catch (e) {
      return {
        result: {
          ok: false,
          removed: {
            recipes: [...removedRecipes],
            body_grants: [...removedBodyGrants],
          },
          failure: {
            code: 'unexpected',
            message: `recipeStore.delete threw for ${recipe_id}: ${(e as Error).message ?? String(e)}`,
          },
        },
      };
    }
  }

  // D-165 P3.1 — drop this pack's contract inventory (installed_pack +
  // the installed_ingredient rows it still owns). Success path only —
  // the `unexpected` early-returns above leave inventory for a retry to
  // clean. Best-effort: the recipes are already gone, so a
  // contract-store hiccup must not flip the uninstall to a failure (the
  // counts on the result reflect only recipes / body-grants — the
  // wire shape is unchanged; inventory removal is silent bookkeeping).
  //
  // D-170 (packs.install composition branch) — when the local manifest store +
  // registry are wired, ALSO clean any locally-provisioned composition catalog
  // this pack owned: delete its body + deregister it so the gateway stops
  // resolving it (else it lingers, resolvable but unremovable — its inventory
  // row is gone). `privateByoDropIds` is the refcount-aware set `removePackInventory`
  // will drop, NARROWED to ids this pack provisioned as a local composition
  // catalog (`catalog_kind === 'private_byo'`); intersect with ids that still have
  // a LOCAL body. By-ref marketplace ids — and a standalone local ingredient a
  // pack merely lists by-ref — are excluded, so a body this pack didn't author is
  // never deleted. Inventory removal + body deletion run in ONE shared-db
  // transaction (a body-delete throw can't orphan inventory); deregister after.
  if (deps.contractStore) {
    // D-170 gap #2 live-reconcile — this pack's bound connections, captured BEFORE the
    // removal txn drops their bindings (declared out here so it survives the try/catch).
    // Each gets its profile re-derived after the removal (local-only → dropped; a
    // registered-vendor connection keeps its vendor profile).
    let reboundConnections: string[] = [];
    try {
      // D-165 P3 — drop this pack's pack-owned contract.grant rows alongside its
      // inventory, in the SAME transaction (per-pack isolation: only rows whose
      // leading `installed_pack_id` segment === pack_slug; other packs' grants + the
      // `__user__` manual grants survive). A recipe-only pack has no pack-owned
      // grants, so this is a no-op there — but always calling it keeps install +
      // uninstall symmetric and is robust to a future recipe-pack grant path.
      const grantStore = createContractGrantStore(deps.contractStore);
      // D-182 §7.2 — the per-door op-admission (B) fan-out counterpart to the (A)
      // `removePackGroups` below: drop every `contract_grant` row this pack's
      // "Install for everyone" fan-out stamped (`source_pack === pack_slug`). Isolated
      // by source_pack, so a hand-minted door's own `scope.operation_ids` grant + owner
      // rows survive. A pack that never fanned out → no-op.
      // D-170 gap #2 — drop this pack's connection→catalog bindings alongside its
      // grants + inventory (a recipe-only pack has none, so it's a no-op there).
      const bindingStore = createConnectionCatalogBindingStore(deps.contractStore);
      // Reconcile targets = this pack's BOUND connections ∪ its GRANT-target
      // connections (§1.6 follow-on): `removePackGroups` below shrinks what a
      // surviving connection's profile derives from, so it must be re-derived
      // even when the pack never bound it (today's install paths always pair a
      // grant with a binding on the same connection, so the union is a no-op —
      // it keeps the reconcile honest for any future grant-without-binding path).
      reboundConnections = deps.reconcileConnectionProfile || deps.reconcileWorkEntitySources
        ? [
            ...new Set([
              ...bindingStore
                .list()
                .filter((b) => b.installed_pack_id === pack_slug)
                .map((b) => b.connection_name),
              ...grantStore.listPackGrantTargets(pack_slug).map((t) => t.connection_name),
            ]),
          ]
        : [];
      if (deps.localManifestStore && deps.registry) {
        const localStore = deps.localManifestStore;
        const localDroppable = privateByoDropIds(deps.contractStore, pack_slug).filter(
          (id) => localStore.getManifest(id) !== null,
        );
        deps.contractStore.transaction(() => {
          removePackInventory(deps.contractStore!, pack_slug);
          // D-220 Slice B — the pack's shipped intake templates go with it.
          removePackReceptionTemplates(deps.contractStore!, pack_slug);
          // D-289 — and the views it shipped, on the SAME paths: a view left
          // behind is a dead row in the owner's list pointing at a pack that
          // no longer exists.
          deps.getSavedDataViewStore?.()?.removePackViews(pack_slug);
          for (const id of localDroppable) localStore.delete(id);
          grantStore.removePackGroups(pack_slug);
          applyInstallAudienceGrantIds(
            {
              contractStore: deps.contractStore!,
              ...(deps.sellerStore ? { sellerStore: deps.sellerStore } : {}),
              ...(deps.inboundTokenStore
                ? { inboundTokenStore: deps.inboundTokenStore }
                : {}),
              now: deps.now ?? Date.now,
            },
            [],
            pack_slug,
            undefined,
          );
          bindingStore.removeForPack(pack_slug);
        });
        for (const id of localDroppable) deps.registry.unregister(id);
      } else {
        deps.contractStore.transaction(() => {
          removePackInventory(deps.contractStore!, pack_slug);
          // D-220 Slice B — the pack's shipped intake templates go with it.
          removePackReceptionTemplates(deps.contractStore!, pack_slug);
          // D-289 — and the views it shipped, on the SAME paths: a view left
          // behind is a dead row in the owner's list pointing at a pack that
          // no longer exists.
          deps.getSavedDataViewStore?.()?.removePackViews(pack_slug);
          grantStore.removePackGroups(pack_slug);
          applyInstallAudienceGrantIds(
            {
              contractStore: deps.contractStore!,
              ...(deps.sellerStore ? { sellerStore: deps.sellerStore } : {}),
              ...(deps.inboundTokenStore
                ? { inboundTokenStore: deps.inboundTokenStore }
                : {}),
              now: deps.now ?? Date.now,
            },
            [],
            pack_slug,
            undefined,
          );
          bindingStore.removeForPack(pack_slug);
        });
      }
    } catch (e) {
      console.warn(
        `[d-165.p3.1] failed to remove install inventory for pack ${JSON.stringify(pack_slug)}: ${(e as Error).message ?? String(e)}`,
      );
    }
    // D-170 gap #2 live-reconcile — after the bindings are dropped, re-derive each
    // formerly-bound connection's profile so a now-orphan local profile is removed at
    // once. Outside the try (runs on the success path); if the removal rolled back, the
    // binding still resolves so this re-seeds the same profile (harmless). Best-effort
    // like the surrounding bookkeeping — a reconcile hiccup never fails the uninstall.
    for (const name of reboundConnections) {
      try {
        deps.reconcileConnectionProfile?.(name);
        // D-192 — binding gone → unregister the connection's work-entity Sources.
        deps.reconcileWorkEntitySources?.(name);
      } catch {
        /* best-effort — never leak into the uninstall result */
      }
    }
  }

  // D-145 PA10 follow-on — fan the success outcome out to every
  // paired client subscribed to `pack_uninstalled`. Drives the
  // Settings → Packs panel's live refresh on sibling devices /
  // tabs without polling. Failed lookups (`not_found` above) skip
  // the emit; mid-transaction throws (`unexpected` above) also skip
  // because the partial-rollback state isn't a coherent "pack is
  // gone" signal — subscribers expect the pack to have been removed
  // wholesale, not partially. The counts reflect what actually
  // landed in the store.
  if (deps.broadcast) {
    try {
      deps.broadcast.emit({
        kind: 'pack_uninstalled',
        pack_slug,
        pack_name: packName,
        pack_version: packVersion,
        removed_recipe_count: removedRecipes.length,
      });
    } catch {
      /* best-effort — bus emit failures never abort the rpc result */
    }
  }

  // R2 build step 4c.4 — the pack's recipes are gone + any connection it bound is
  // unbound and its profile reconciled above, so a surviving recipe that lost its
  // last provider now goes blocked; recompute + broadcast the fresh snapshot.
  // Best-effort (the broadcaster swallows), after the reconcile loop.
  deps.recipeRunnabilityBroadcast?.recomputeAndEmit();

  // D-225 Slice 2 — the reverse half of destroy. A GENERATED MCP pack and its
  // connection are one thing to the owner: the pack's every operation
  // dispatches through that connection, and a connection whose pack is gone is
  // back to the raw path. Removing one and leaving the other is a half state
  // neither surface explains.
  //
  // ⚠ It deletes the enrolled CREDENTIAL, which reads smaller than it is from a
  // button labelled "remove pack". The removed connection NAME is returned so
  // the surface can say what actually happened rather than leaving the owner to
  // discover it.
  //
  // ⛔ Only for a pack an enrolled MCP connection actually derives — the
  // recomputed derivation is the authority, never the slug's shape, and a
  // marketplace pack can never reach this. The cycle back to here is broken at
  // the composition site: the deps this closure hands the connection delete
  // OMIT its pack-teardown hook, so the capability to recurse is absent rather
  // than merely unused.
  let removedConnection: string | undefined;
  if (deps.removeGeneratedPackConnection && looksLikeGeneratedMcpPackSlug(pack_slug)) {
    try {
      removedConnection = (await deps.removeGeneratedPackConnection(pack_slug)) ?? undefined;
    } catch {
      // Best-effort — the pack is already gone and a throw would leave the
      // owner unable to retry.
    }
  }

  return {
    result: {
      ok: true,
      removed: {
        recipes: removedRecipes,
        body_grants: removedBodyGrants,
      },
      ...(removedConnection !== undefined
        ? { removed_connection: removedConnection }
        : {}),
      // R2 build step 4c.3 + §1.6 follow-on — the pre-mutation prediction of which
      // surviving recipes this uninstall blocks / degrades. Non-empty only
      // (omitted otherwise, matching the install born-disclosure rule).
      ...(wouldDisable.length > 0 ? { would_disable: wouldDisable } : {}),
      ...(wouldDegrade.length > 0 ? { would_degrade: wouldDegrade } : {}),
    },
  };
};

/** D-304 — what deleting a pack removes with its recipes: their schedules, the
 *  automations the owner set up on them, and how many have saved settings. The
 *  recipes are the ones the uninstall would delete: the pack's own rows, and a
 *  Records pack's rows under its catalog id (the uninstall's own resolution). Nothing
 *  to count on a server that cannot say (no store reader): all zero, so the
 *  confirmation adds no line rather than a wrong one. */
export const previewPackUninstall = async (
  deps: PackUninstallRpcDeps,
  args: { pack_slug?: unknown },
): Promise<{ schedules: number; automations: number; recipes_with_settings: number }> => {
  const pack_slug = typeof args?.pack_slug === 'string' ? args.pack_slug.trim() : '';
  if (pack_slug === '') throw new RpcError('bad_request', 'packs.uninstall_preview: pack_slug must be a non-empty string');
  const owned = deps.getRecipeOwnedState?.();
  if (owned === undefined) return { schedules: 0, automations: 0, recipes_with_settings: 0 };
  const recipeIds = new Set(deps.recipeStore.listForPack(pack_slug));
  for (const namespace of deps.recordsStore?.listNamespaces() ?? []) {
    if (namespace.owner.pack_slug !== pack_slug) continue;
    for (const id of deps.recipeStore.listForPack(await recordsCatalogSlug(namespace.owner))) recipeIds.add(id);
  }
  let schedules = 0;
  let automations = 0;
  let recipesWithSettings = 0;
  for (const recipe_id of recipeIds) {
    const state = recipeOwnedStateOf(recipe_id, owned);
    schedules += state.schedules;
    automations += state.automations;
    if (state.settings > 0) recipesWithSettings += 1;
  }
  return { schedules, automations, recipes_with_settings: recipesWithSettings };
};

type PacksUninstallMethods = 'packs.uninstall' | 'packs.uninstall_preview';

export const makePackUninstallHandlers = (
  deps: PackUninstallRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, PacksUninstallMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['packs.uninstall', 'packs.uninstall_preview'],
    handlers: {
      'packs.uninstall': async (args) =>
        handlePacksUninstall(
          deps,
          args as Parameters<typeof handlePacksUninstall>[1],
        ),
      'packs.uninstall_preview': async (args) => previewPackUninstall(deps, args),
    },
  };
};
