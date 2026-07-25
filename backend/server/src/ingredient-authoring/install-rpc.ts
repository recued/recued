/** D-170 — `ingredient.install` / `ingredient.uninstall` rpc handlers (N.15).
 *
 *  The direct-manifest install path. `ingredient.install` hands a composition
 *  (bare 1×1) or app_pack (carrying a composition by value) to the provisioner
 *  (`provisionAuthoredArtifact`); the typed `IngredientInstallResult` returns on
 *  the result body (`ok: false` carries decompose-validate issues), and only an
 *  arg-shape problem (missing `manifest`) reaches the rpc error channel as
 *  `bad_request`.
 *
 *  `ingredient.uninstall` reverses an install, refcount-aware (a child shared by
 *  another installed pack survives), and adds the D-170 `ingredient_pins`
 *  dependency guard (N.14): it scans every installed recipe for a reference to a
 *  child being removed and BLOCKS (`code: 'pinned'`, `blocked_by`) unless
 *  `force: true`. This guard is new — the refcount-only pack uninstall
 *  (`pack-uninstall-handler.ts`) never checked recipe dependencies. The scan
 *  reads ingredient refs straight off recipe steps (recipes reference the
 *  catalog slug + pick operations via `input.operation`), so it needs no
 *  separate pins store.
 *
 *  After a clear removal it also deletes the removed ids' bodies from the local
 *  manifest store and deregisters them from the live manifest registry, so the
 *  gateway stops resolving them immediately (boot would not re-register an
 *  absent body).
 *
 *  Channel-isolation: `ingredient.` is in `MCP_RESERVED_RPC_PREFIXES`; only the
 *  Settings / Kitchen UI reaches this surface. Omitting `deps` (db-less harness,
 *  or a server with no contract store) leaves both methods returning
 *  `not_configured` (the whole slice is absent).
 *
 *  Spec: `docs/d-170-spec.md` § N.14 (uninstall + pin-guard), N.15 (rpc
 *  surface), N.16 (gateway resolution). */

import {
  RpcError,
  isInstallGrantSelection,
  type HandlerSlice,
  type IngredientInstallArgs,
  type IngredientInstallResult,
  type IngredientUninstallArgs,
  type IngredientUninstallResult,
  type RecipeDefinition,
  type RecipeTrustState,
  type ServerRpcRegistry,
} from '@recued/contracts';

import type { ManifestRegistry } from '../manifest-loader.js';
import {
  isIngredientPackOwned,
  previewDroppableIds,
  privateByoDropIds,
  removePackInventory,
  removeStandaloneIngredient,
} from '../pack-inventory.js';
import type { RecipeStore } from '../recipe-store.js';
import type { ContractStore } from '../storage/contract-store.js';
import type { ChatInboundTokenStore } from '../storage/chat-inbound-token-store.js';
import { createContractGrantStore } from '../storage/contract-grant-store.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import {
  applyInstallAudienceGrantIds,
  provisionAuthoredArtifact,
  type SellerInstallAudienceStore,
} from './install-composition.js';
import type { LocalManifestStore } from './local-manifest-store.js';
import type { WsClient } from '../ws-server.js';

interface RecipeTrustWriter {
  set(state: RecipeTrustState): void | Promise<void>;
}

export interface IngredientAuthoringRpcDeps {
  /** Local manifest body store (shares its db with `contractStore`). */
  localManifestStore: LocalManifestStore;
  /** Gateway-read-only `contract.*` store — inventory home. */
  contractStore: ContractStore;
  /** Live manifest registry the gateway resolves through. */
  registry: Pick<ManifestRegistry, 'register' | 'get' | 'unregister'>;
  /** Per-pair recipe store — the pin-guard scans `ids()` → `get()` for
   *  references to a child being removed. */
  recipeStore: Pick<RecipeStore, 'ids' | 'get'>;
  /** Optional recipe writer for compiled workflow recipes emitted at install. */
  compiledRecipeStore?: Pick<RecipeStore, 'save'>;
  /** Optional staged-trust store; pure-workflow compiled recipes auto-trust. */
  recipeTrustStore?: RecipeTrustWriter;
  /** Epoch-ms clock for inventory timestamps. Production passes `Date.now`. */
  now?: () => number;
  /** D-170 gap #2 live-reconcile — (re)derive a connection's operation profile by
   *  name. `ingredient.install` passes it to the provisioner so a composition's bound
   *  connection seeds its profile post-commit; `ingredient.uninstall` calls it after
   *  the binding is dropped so the now-orphan profile is removed. Optional: dbless /
   *  no-profile-store boots omit it + fall back to next-connect/boot seeding
   *  (fail-closed until then, never over-granted). */
  reconcileConnectionProfile?: (connectionName: string) => void;
  /** D-192 — sibling of `reconcileConnectionProfile`: register/unregister the
   *  bound connection's pack-declared work-entity Sources post-commit
   *  (enroll-before-install / uninstall symmetry). */
  reconcileWorkEntitySources?: (connectionName: string) => void;
  /** D-196 install grant audiences. Optional; when absent customer-scoped fan-out
   *  sees no seller customer rows. */
  sellerStore?: SellerInstallAudienceStore;
  /** D-196 customer bearer snapshots updated by explicit audience rollout. */
  inboundTokenStore?: Pick<ChatInboundTokenStore, 'getTokenById' | 'updateTokenGrants'>;
}

const INSTALL_SCOPE_ERROR =
  'install_scope must carry access plus either legacy scope or the D-196 audience checklist';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every ingredient slug a recipe step references, across all step phases. A
 *  step references an ingredient via its `ingredient: string` field (transform
 *  steps carry `transform` instead); collecting any string `ingredient` field
 *  is robust to the step-type union without re-deriving the discriminator. */
const recipeIngredientRefs = (recipe: RecipeDefinition): string[] => {
  const out: string[] = [];
  const collect = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      if (isPlainObject(step) && typeof step.ingredient === 'string' && step.ingredient.length > 0) {
        out.push(step.ingredient);
      }
    }
  };
  const r = recipe as unknown as {
    steps?: unknown;
    prefetch_steps?: unknown;
    trigger_steps?: unknown;
  };
  collect(r.steps);
  collect(r.prefetch_steps);
  collect(r.trigger_steps);
  return out;
};

/** Installed recipes that still reference any of `ids` (the pin-guard's
 *  `blocked_by`). Empty when nothing depends on the ids being removed. Scans
 *  every recipe (bundled + stored); a bundled recipe never references a
 *  locally-authored slug, so it never false-blocks. */
const recipesReferencing = (
  recipeStore: Pick<RecipeStore, 'ids' | 'get'>,
  ids: ReadonlySet<string>,
): string[] => {
  if (ids.size === 0) return [];
  const blocking: string[] = [];
  for (const recipeId of recipeStore.ids()) {
    const recipe = recipeStore.get(recipeId);
    if (recipe && recipeIngredientRefs(recipe).some((slug) => ids.has(slug))) {
      blocking.push(recipeId);
    }
  }
  return blocking;
};

const handleInstall = (
  deps: IngredientAuthoringRpcDeps,
  now: () => number,
  args: IngredientInstallArgs,
): IngredientInstallResult => {
  if (!isPlainObject(args) || !('manifest' in args)) {
    throw new RpcError('bad_request', 'ingredient.install: manifest is required');
  }
  // D-182 §7.1 — the install grant dialog's selection. Present-but-malformed is
  // a client bug, not a fail-closed-to-headless case — reject loudly so a typo'd
  // Access tier can't silently downgrade to authored-only. Absent ⇒ undefined
  // (the provisioner fails closed: authored read/`ask` defaults only).
  const installScope = args.install_scope;
  if (installScope !== undefined && !isInstallGrantSelection(installScope)) {
    throw new RpcError(
      'bad_request',
      `ingredient.install: ${INSTALL_SCOPE_ERROR}`,
    );
  }
  return provisionAuthoredArtifact(
    {
      localManifestStore: deps.localManifestStore,
      contractStore: deps.contractStore,
      registry: deps.registry,
      now,
      ...(deps.compiledRecipeStore
        ? { compiledRecipeStore: deps.compiledRecipeStore }
        : {}),
      ...(deps.recipeTrustStore
        ? { recipeTrustStore: deps.recipeTrustStore }
        : {}),
      // D-170 gap #2 live-reconcile — pass through so the provisioner seeds the
      // bound connection's profile post-commit (a connect-before-install dispatch
      // then works at once). Absent → next-connect/boot seeding (fail-closed).
      ...(deps.reconcileConnectionProfile
        ? { reconcileConnectionProfile: deps.reconcileConnectionProfile }
        : {}),
      // D-192 — pass through so the provisioner registers the bound connection's
      // pack-declared work-entity Sources post-commit (enroll-before-install).
      ...(deps.reconcileWorkEntitySources
        ? { reconcileWorkEntitySources: deps.reconcileWorkEntitySources }
        : {}),
      ...(deps.sellerStore
        ? { sellerStore: deps.sellerStore }
        : {}),
      ...(deps.inboundTokenStore
        ? { inboundTokenStore: deps.inboundTokenStore }
        : {}),
    },
    args.manifest,
    installScope,
  );
};

const uninstallPack = (
  deps: IngredientAuthoringRpcDeps,
  packSlug: string,
  force: boolean,
): IngredientUninstallResult => {
  const preview = previewDroppableIds(deps.contractStore, packSlug);
  if (!preview.exists) {
    return { ok: false, code: 'not_found', message: `no installed pack '${packSlug}'` };
  }
  if (!force) {
    const blockedBy = recipesReferencing(deps.recipeStore, new Set(preview.droppable));
    if (blockedBy.length > 0) {
      return {
        ok: false,
        code: 'pinned',
        message: `${blockedBy.length} installed recipe(s) still reference an ingredient this pack would remove — retry with force to proceed`,
        blocked_by: blockedBy,
      };
    }
  }
  // `removePackInventory` drops every droppable id from inventory (refcount-
  // aware), but body deletion + deregistration is restricted to ids THIS pack
  // provisioned as a LOCAL composition catalog (`privateByoDropIds`, intersected
  // with a real local body). A by-ref marketplace id (or a standalone local body
  // a pack merely lists by-ref) is left in the store + registry untouched — its
  // body isn't ours to delete, and unregistering it could drop a bundled
  // manifest. Inventory removal + body deletion run in ONE shared-db transaction
  // so a body-delete throw can't leave an orphan body that boot would re-register;
  // registry deregistration is in-memory and runs after the commit.
  const localDroppable = privateByoDropIds(deps.contractStore, packSlug).filter(
    (id) => deps.localManifestStore.getManifest(id) !== null,
  );
  // D-170 gap #2 live-reconcile — capture this pack's bound connections BEFORE
  // removeForPack drops their bindings, so each one's profile can be re-derived after
  // the commit (a local-only connection → profile dropped fail-closed; a registered-
  // vendor connection → keeps its vendor profile). Only scan when a reconciler is wired.
  const bindingStore = createConnectionCatalogBindingStore(deps.contractStore);
  const reboundConnections = deps.reconcileConnectionProfile || deps.reconcileWorkEntitySources
    ? bindingStore
        .list()
        .filter((b) => b.installed_pack_id === packSlug)
        .map((b) => b.connection_name)
    : [];
  let removedPack = false;
  deps.contractStore.transaction(() => {
    removedPack = removePackInventory(deps.contractStore, packSlug).removed_pack;
    for (const id of localDroppable) deps.localManifestStore.delete(id);
    // D-165 P3 — drop this pack's pack-owned contract.grant rows in the SAME
    // transaction as the inventory removal (per-pack isolation: only rows whose
    // leading `installed_pack_id` segment === packSlug; other packs' grants + the
    // `__user__` manual grants on the same connection survive).
    createContractGrantStore(deps.contractStore).removePackGroups(packSlug);
    // D-182 §7.2 / D-196 — drop this pack's audience rows and reconcile any
    // affected customer bearer snapshot in the same shared-db transaction.
    applyInstallAudienceGrantIds(
      {
        contractStore: deps.contractStore,
        ...(deps.sellerStore ? { sellerStore: deps.sellerStore } : {}),
        ...(deps.inboundTokenStore ? { inboundTokenStore: deps.inboundTokenStore } : {}),
        now: deps.now ?? Date.now,
      },
      [],
      packSlug,
      undefined,
    );
    // D-170 gap #2 — drop this pack's connection→catalog binding too (so the local
    // catalog connection stops resolving / being grantable once the pack is gone).
    bindingStore.removeForPack(packSlug);
  });
  for (const id of localDroppable) deps.registry.unregister(id);
  // D-170 gap #2 live-reconcile — bindings dropped + catalog deregistered above;
  // re-derive each formerly-bound connection's profile so a now-orphan local profile
  // is removed at once (a registered-vendor connection keeps its vendor profile).
  for (const name of reboundConnections) deps.reconcileConnectionProfile?.(name);
  // D-192 — the binding is gone → the resolver yields nothing → unregister the
  // formerly-bound connection's work-entity Sources (uninstall symmetry).
  for (const name of reboundConnections) deps.reconcileWorkEntitySources?.(name);
  return {
    ok: true,
    removed_ingredient_ids: preview.droppable,
    removed_pack: removedPack,
  };
};

const uninstallStandalone = (
  deps: IngredientAuthoringRpcDeps,
  ingredientId: string,
  force: boolean,
): IngredientUninstallResult => {
  // Pack-owned guard first → a clean `bad_request` before the pin-guard.
  if (isIngredientPackOwned(deps.contractStore, ingredientId)) {
    return {
      ok: false,
      code: 'bad_request',
      message: `'${ingredientId}' is owned by an installed pack — uninstall the pack instead`,
    };
  }
  if (!force) {
    const blockedBy = recipesReferencing(deps.recipeStore, new Set([ingredientId]));
    if (blockedBy.length > 0) {
      return {
        ok: false,
        code: 'pinned',
        message: `${blockedBy.length} installed recipe(s) still reference '${ingredientId}' — retry with force to proceed`,
        blocked_by: blockedBy,
      };
    }
  }
  // Inventory removal + body deletion in ONE shared-db transaction (a
  // body-delete throw can't leave an orphan body); deregister after commit.
  let result = { removed: false, pack_owned: false };
  deps.contractStore.transaction(() => {
    result = removeStandaloneIngredient(deps.contractStore, ingredientId);
    if (result.removed) deps.localManifestStore.delete(ingredientId);
  });
  if (!result.removed) {
    // Pack-ownership re-checked atomically inside the remove (a race could
    // have a pack claim the id between the upfront guard and here).
    return result.pack_owned
      ? {
          ok: false,
          code: 'bad_request',
          message: `'${ingredientId}' is owned by an installed pack — uninstall the pack instead`,
        }
      : { ok: false, code: 'not_found', message: `no installed ingredient '${ingredientId}'` };
  }
  deps.registry.unregister(ingredientId);
  return { ok: true, removed_ingredient_ids: [ingredientId], removed_pack: false };
};

const handleUninstall = (
  deps: IngredientAuthoringRpcDeps,
  args: IngredientUninstallArgs,
): IngredientUninstallResult => {
  if (!isPlainObject(args)) {
    throw new RpcError('bad_request', 'ingredient.uninstall: args must be an object');
  }
  const hasPack = typeof args.pack_slug === 'string' && args.pack_slug.trim().length > 0;
  const hasIngredient = typeof args.ingredient_id === 'string' && args.ingredient_id.trim().length > 0;
  if (hasPack === hasIngredient) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'ingredient.uninstall: exactly one of pack_slug / ingredient_id is required',
    };
  }
  const force = args.force === true;
  return hasPack
    ? uninstallPack(deps, (args.pack_slug as string).trim(), force)
    : uninstallStandalone(deps, (args.ingredient_id as string).trim(), force);
};

type IngredientAuthoringMethods = 'ingredient.install' | 'ingredient.uninstall';

export const makeIngredientAuthoringHandlers = (
  deps: IngredientAuthoringRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, IngredientAuthoringMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  const now = deps.now ?? ((): number => Date.now());
  return {
    methods: ['ingredient.install', 'ingredient.uninstall'],
    handlers: {
      'ingredient.install': async (args) =>
        handleInstall(deps, now, args as IngredientInstallArgs),
      'ingredient.uninstall': async (args) =>
        handleUninstall(deps, args as IngredientUninstallArgs),
    },
  };
};
