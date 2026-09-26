/** D-145 PA10 follow-on — `packs.install` rpc handler.
 *
 *  Bulk-pack install over the Settings → Packs UI flow. Accepts a raw
 *  `BulkPackManifest` + the set of permissions the user approved in the
 *  install dialog; parses the manifest, resolves bundled pack dependencies
 *  first (each pack through its own transaction), then resolves each
 *  `recipes[]` entry against the per-pair `RecipeStore` (memory override
 *  → SQLite → bundled), and hands the resolved input to
 *  `installBulkPackOnServer` — the same engine path foundation packs
 *  use at boot.
 *
 *  Engine result is returned on the rpc result body, not the error
 *  channel — `ok: false` outcomes (`permission_denied` /
 *  `version_mismatch` / `unresolved` / `validator_rejected` /
 *  `unexpected`) carry a typed `failure.code` the UI renders with
 *  targeted copy. Only manifest-validator failures + arg-shape problems
 *  reach the rpc error channel as `bad_request`.
 *
 *  Channel-isolation invariant: `packs.` is in
 *  `MCP_RESERVED_RPC_PREFIXES`. A pack install transaction commits
 *  recipes + body-content MCP grants + per-pair Standing Instruction
 *  rows in one atomic step; the reserved prefix keeps MCP-channel
 *  agents off the writer entirely. Dependency expansion is ordered rather
 *  than all-or-nothing across packs, but each single-pack transaction keeps
 *  its own rollback boundary. The D-138 ratchet test asserts the prefix
 *  stays reserved.
 *
 *  Spec: D-145 § PA10 (pack-shipped Standing
 *  Instructions). */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BULK_PACK_INSTALL_PERMISSION,
  buildPackOperationIndex,
  installAccessOptions,
  installGrantableOps,
  isInstallGrantSelection,
  isPureWorkflowRecipe,
  normalizeBulkPackInstallPlan,
  parseBulkPackManifest,
  parseRecipeBundleKey,
  RECORDS_RUNTIME_CANARY_OP,
  recipeOpIds,
  recipeTrustStateForPureWorkflow,
  RpcError,
  SLUG_RE,
  validateRecipeBundlePublisher,
  type BulkPackInstallResultLike,
  type BulkPackManifest,
  type PackWebhookPlanEntry,
  type RecipeWebhookTrigger,
  type CompositionIngredient,
  type HandlerSlice,
  type InstallAccessTier,
  type InstallGrantSelection,
  type PackContentRef,
  type PackDependencyInstallScope,
  type PackInstallPlan,
  type PackPackDependency,
  type PacksResolveResult,
  type RecipeDefinition,
  type RecipePiiDisclosureEntry,
  type RecipeRunnabilityEntry,
  type RecipeTrustState,
  type ServerRpcRegistry,
} from '@recued/contracts';
import {
  isRecordsComposition,
  recordsCatalogSlug,
  validatePack,
} from '@recued/ingredient-authoring';
import {
  BulkPackFetchError,
  fetchBulkPackBySlug,
  fetchRecipeBySlug,
  type BulkPackInstallInput,
  type BulkPackInstallRecipe,
  type MarketplaceRecipeResult,
} from '@recued/marketplace';
import { hashRecipe, unboundPackRefs, validateRecipe, type PackOpResolution } from '@recued/recipes';
import type { IngredientManifest } from '@recued/contracts';
import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';

import { assessRecipePiiPosture } from './auto-pii-apply.js';
import { isCoreFeaturePack, resolveBundledPackManifest } from './bundled-pack-source.js';
import { buildPackInstallPreview, RISK_RANK } from './pack-install-preview.js';
import { seedPackRecipeGrants } from './recipe-grant-seed.js';
import {
  applyInstallAudienceGrantIds,
  provisionPackCompositionForBulkInstall,
  resolvePackOpStepRecipes,
  type SellerInstallAudienceStore,
} from './ingredient-authoring/install-composition.js';
import type { LocalManifestStore } from './ingredient-authoring/local-manifest-store.js';
import { installBulkPackOnServer } from './install-bulk-pack-handler.js';
import type { ManifestRegistry } from './manifest-loader.js';
import {
  buildPackOpResolution,
  findInstalledPackByAuthoredSlug,
  getInstalledPack,
  recordPackInventory,
} from './pack-inventory.js';
// D-220 Slice B — pack-shipped intake templates persist on the install
// success path, for every pack kind, keyed by the authored slug.
import {
  isReceptionTemplateContent,
  recordPackReceptionTemplates,
} from './pack-reception-templates.js';
import { reviewOwnerOperationsForPackUpdate } from './owner-operation-update-review.js';
import {
  carriesRecords,
  compositionPackCurrentAccess,
  diffCompositionPackForUpdate,
  diffRecordsPackForUpdate,
  recordsPackCurrentAccess,
} from './pack-operation-update-diff.js';
import { currentPackAudience, currentPackConnection } from './pack-update-carry-over.js';
import { planPackWebhookBindings } from './pack-webhook-plan.js';
import { triggersSwitchedOff } from './pack-trigger-preview.js';
import { carryReceptionPairsAfterInstall, receptionPairsAtRisk } from './reception-pair-carry.js';
import { settingsNoLongerUsed } from './pack-settings-preview.js';
import { validateRecipeInline } from './recipe-save-handler.js';
import type { RecipeStore } from './recipe-store.js';
import type { RecipeRunnabilityBroadcaster } from './recipe-runnability-handler.js';
import {
  D201_WEBHOOK_RUNTIME_UNAVAILABLE,
  hasNonEmptyWebhookDeclarations,
} from './webhook-declaration-gate.js';
import type { ContractStore } from './storage/contract-store.js';
import type { SavedDataViewStore } from './saved-data-view-store.js';
import { packSavedViewId, packSavedViewsFrom } from './pack-saved-views.js';
import type { ChatInboundTokenStore } from './storage/chat-inbound-token-store.js';
import type { McpBodyVisibilityStore } from './storage/mcp-body-visibility-store.js';
import type { WebhookConsumerStore } from './storage/webhook-consumer-store.js';
import type { WsClient } from './ws-server.js';
import { makeBoundedOriginHttpFetcher } from './bounded-origin-http-fetcher.js';
import {
  classifyRecordsMigrationRecipe,
  installRecordsPackAtomic,
  recordsRuntimeCanaryIssue,
  RecordsPackInstallError,
  type RecordsMigrationArtifact,
  type RecordsMigrationPlan,
  type RecordsStore,
  buildRecordsPackUpdateReview,
  prepareRecordsReviewTarget,
  recordsManifestReviewHash,
  type PreparedRecordsReviewTarget,
  type RecordsReviewRecipe,
  type ResolvedRecordsPackRecipe,
} from './records/index.js';
import type { RecordsUpdateReviewFence } from '@recued/contracts';

interface RecipeTrustWriter {
  set(state: RecipeTrustState): void | Promise<void>;
}

/** D-145 PA10 follow-on — narrow broadcast emitter the install handler
 *  drives on success. Mirrors `ChatBroadcastEmitter` shape so a future
 *  bus refactor lands in one place. The bin composer
 *  (`wire-pack-install-rpc-deps.ts`) builds this from `EventBus.emit`;
 *  tests pass a synthetic capturing emitter (one-line array push). */
export interface PackInstallBroadcastEmitter {
  emit(event: {
    kind: 'pack_installed';
    pack_slug: string;
    pack_name: string;
    pack_version: number;
    installed_recipe_count: number;
  }): void;
}

export interface PackInstallRpcDeps {
  /** Per-pair recipe store. Required — the handler resolves every
   *  manifest `recipes[]` entry through it (memory override → SQLite →
   *  bundled). Absent → composer returns the undefined-bundle + the
   *  rpc returns `not_configured`. */
  recipeStore: RecipeStore;
  /** D-247 D15 — manifest lookup for the preview's risk-tier resolution. Absent
   *  ⇒ a catalog op's tier is unknown and the recipe reports `grant_class:
   *  'unknown'` rather than a guessed label. */
  getManifest?: (slug: string) => IngredientManifest | undefined;
  /** D-247 D15.1 — the owner's grant rows, so the install can pre-write each
   *  recipe's with the chosen access ceiling applied. ⚠ Absent ⇒ the store's
   *  mutation hook seeds on `chat_exposed` alone and the ceiling is ignored. */
  grantEntryStore?: ContractGrantEntryStore;
  /** D-221 namespaced Records authority. A recognized Records composition is
   * never deferred: absence of this store refuses before recipe mutation. */
  recordsStore?: RecordsStore;
  /** Provenance service for immutable historical Records pack artifacts. The
   * by-slug composer may wire this to a version-addressed marketplace/archive
   * source. Absent/offline means direct routes still work and skipped routes
   * fail closed before review. */
  resolveRecordsMigrationArtifacts?: (input: {
    owner: { publisher: string; pack_slug: string };
    from_version: number;
    target_version: number;
  }) => Promise<readonly RecordsMigrationArtifact[]>;
  /** D-201 Slice 4 — owner-approved pack webhook bindings. */
  webhookConsumerStore?: WebhookConsumerStore;
  /** D-295 — the owner's webhooks: the install dialog's webhook plan offers the
   *  ones that fit (`packs.install_preview`). Absent ⇒ no plan. */
  webhookIngressStore?: Pick<import('./storage/webhook-ingress-store.js').WebhookIngressStore, 'list'>;
  /** D-209 #1 W2b — webhook DOOR substrate; a successful install mints one
   *  derived door per webhook-declaring recipe and stamps its trigger rows. */
  webhookDoor?: import('./webhook-door-enroll.js').WebhookDoorEnrollDeps;
  /** Install seam 5c — resolve a manifest `recipes[]` slug that is NOT bundled
   *  on disk against the marketplace. When present, it is authoritative for
   *  EVERY constituent ref; the resolver must not fall back to a same-slug local
   *  bundled recipe, because that would let a marketplace pack relabel the local
   *  recipe under the pack publisher. When absent, resolution is bundled-only
   *  (the safe by-value default). The full row is required because its
   *  marketplace-authoritative `publisher_id` is the recipe's vault scope; a
   *  containing pack does not acquire authority to relabel a constituent recipe.
   *  DELIBERATELY populated only on the by-slug install path. The by-value
   *  `packs.install` leaves it undefined so a user-supplied manifest cannot point
   *  at an arbitrary marketplace row. */
  resolveMarketplaceRecipe?: (slug: string) => Promise<MarketplaceRecipeResult | null>;
  /** Install seam 5c — the `fetch` the by-slug install entries
   *  (`installPackBySlug` / `installRecipeBySlug`) use to reach the marketplace.
   *  Defaults to `globalThis.fetch`; tests inject a mock. (The by-slug entries
   *  build `resolveMarketplaceRecipe` from this, so the by-value path never
   *  carries either.) */
  marketplaceFetch?: typeof globalThis.fetch;
  /** D-311 — a pack an install brings in that this server does not bundle: the
   *  marketplace copy fetched for this call (`fetchMarketplaceDependencies`).
   *  Consulted after the bundled copy, by every dependency walk and by the
   *  install's recursion. Set only on the marketplace paths — `packs.installBySlug`
   *  and a `packs.install_preview` with `marketplace` — for the reason
   *  `resolveMarketplaceRecipe` is: a by-value manifest must not point the server
   *  at arbitrary marketplace rows. */
  resolveDependencyManifest?: (slug: string) => BulkPackManifest | null;
  /** D-311 — fetch, many at once, the recipes of the packs an install will
   *  write, once its preflight has passed and before its recursion reads them one
   *  by one. The marketplace path's resolver memoizes, so each is fetched once. */
  warmMarketplaceRecipes?: (manifests: readonly BulkPackManifest[]) => Promise<void>;
  /** D-139 P6.B — per-pair MCP body-content visibility grant store. When
   *  present, packs that ship `mcp_body_visibility_grants[]` persist their
   *  closed-list grant keys on install (revoked on uninstall/rollback);
   *  when absent the engine skips them (manifest field stays contract-only
   *  → MCP body content keeps being stripped). */
  mcpBodyVisibilityStore?: McpBodyVisibilityStore;
  /** D-145 PA10 follow-on — optional broadcast emitter. When wired the
   *  handler emits a `pack_installed` event after the engine
   *  transaction returns `ok: true`; failed installs (`ok: false`) do
   *  NOT emit so subscribers never react to a no-op transaction.
   *  Best-effort: emit failures are swallowed (mirrors the
   *  housekeeping cycle emit in `wire-housekeeping-substrate.ts`)
   *  so a bus-side hiccup never leaks an exception into the rpc
   *  result the user sees in the install dialog. Optional so dbless
   *  / pre-bus boot harnesses keep working. */
  broadcast?: PackInstallBroadcastEmitter;
  /** R2 build step 4c.4 — derived-runnability broadcaster. When wired, the
   *  handler recomputes every recipe's runnability and fans the fresh snapshot on
   *  the `recipe_runnability_changed` bus kind after a successful install (newly
   *  installed recipes may be born blocked/runnable; their grants may also flip
   *  others). Best-effort + optional — fires only on `ok: true`. */
  recipeRunnabilityBroadcast?: RecipeRunnabilityBroadcaster;
  /** R2 build step 4c.2 — read the CURRENT full per-recipe runnability snapshot
   *  (the SAME value `recipe.runnability` returns; the composer binds it to
   *  `listRecipeRunnability(recipeRunnabilityDeps).recipes`). The handler calls it
   *  once AFTER a successful install + all provisioning to populate the result's
   *  `born_blocked` / `born_degraded` disclosure for the freshly-installed recipes.
   *  Best-effort + optional — absent (dbless / no connection+profile store) → the
   *  result omits the born fields, exactly like `recipe.runnability` returning
   *  `not_configured`. Independent of `recipeRunnabilityBroadcast`: the disclosure
   *  is a synchronous read returned in THIS rpc result, the broadcast fans the same
   *  state to OTHER paired clients; an install does both. */
  computeRunnability?: () => readonly RecipeRunnabilityEntry[];
  /** D-165 P3.1 — gateway-read-only `contract.*` store. When present the
   *  handler records `installed_pack` + `installed_ingredient` inventory
   *  rows after a successful install (best-effort — a bookkeeping failure
   *  never fails the user's already-committed install). Optional so dbless
   *  / pre-contract-store boot harnesses keep working; absent → no
   *  inventory is recorded (the install still succeeds). */
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
  /** D-296 — late-bound: the trigger store and the vendor registry the
   *  reconcile compiles against, so the update preview can name an armed
   *  automation the update switches off. Absent ⇒ no warning. */
  getTriggerPreview?: () => import('./pack-trigger-preview.js').TriggerPreviewDeps | undefined;
  /** D-299 — the Reception pairs recipes back: the update carries the ones it may keep, and
   *  its preview names the ones it stops. Late-bound, like the trigger preview. */
  getReceptionPairs?: () => import('./reception-pair-carry.js').ReceptionPairCarryDeps | undefined;
  /** D-303 — where the owner's settings are saved, so the update preview can name the
   *  saved ones an update stops using. Late-bound, like the trigger preview. */
  getSavedSettings?: () => import('./pack-settings-preview.js').SavedSettingsReader | undefined;
  /** D-170 (packs.install composition branch) — local manifest body store +
   *  live manifest registry. When BOTH are present alongside `contractStore`,
   *  an app_pack carrying a `composition` content (N.17) has it decomposed +
   *  installed on the success path: the body lands in `localManifestStore`, the
   *  decomposed catalog joins the SAME `installed_pack` row's inventory and the
   *  live `registry` so the gateway resolves its operations (N.16), and the
   *  composition is dropped from the result's `deferred_contents`. Absent (db-
   *  less / pre-store boot) → composition contents stay deferred (honest), and
   *  recipes still install. The registry instance is the same
   *  `executorConfig.manifests` the gateway resolves through (shared with the
   *  `ingredient.install` rpc deps). */
  localManifestStore?: LocalManifestStore;
  registry?: Pick<ManifestRegistry, 'register' | 'get' | 'unregister'>;
  /** D-170 gap #2 live-reconcile — passed to the composition provisioner so a
   *  bound connection's operation profile is (re)derived the moment the
   *  composition's binding + grants commit (a connect-before-install dispatch then
   *  works at once). Optional: dbless / no-profile-store boots omit it + the
   *  composition's profile seeds on the next connect/boot (fail-closed until then). */
  reconcileConnectionProfile?: (connectionName: string) => void;
  /** D-192 — sibling of `reconcileConnectionProfile`: register the composition's
   *  bound connection's pack-declared work-entity Sources post-commit
   *  (enroll-before-install). */
  reconcileWorkEntitySources?: (connectionName: string) => void;
  /** D-196 install grant audiences. Optional; when absent customer-scoped fan-out
   *  sees no seller customer rows. */
  sellerStore?: SellerInstallAudienceStore;
  /** Existing D-196 customer bearers whose static grant snapshots must follow
   *  an explicit install-audience rollout. Generic token checklists are not
   *  reconciled because only seller customer rows supply token ids here. */
  inboundTokenStore?: Pick<ChatInboundTokenStore, 'getTokenById' | 'updateTokenGrants'>;
  /** Optional staged-trust store; pure-workflow recipes install as auto-trusted. */
  recipeTrustStore?: RecipeTrustWriter;
  /** Override the default `community/packs` directory. Tests pass a scratch
   *  directory; production callers leave undefined to use the bundled location.
   *  Mirrors `packs.list` / `packs.uninstall` and is also used to resolve v3
   *  `dependencies[]` pack manifests before the requested pack installs. */
  packDir?: string;
  /** Test seam — production passes `Date.now`. */
  now?: () => number;
}

type PacksInstallArgs = {
  manifest: unknown;
  granted_permissions: ReadonlyArray<string>;
  /** D-182 §7.1 — the install grant dialog's selection (Access × Scope) for a
   *  composition the pack carries by value. Forwarded to
   *  `provisionPackCompositionForBulkInstall`. Absent ⇒ the provisioner fails
   *  closed (authored read/`approval: ask` defaults only). NOT propagated to
   *  dependency packs: each takes its own from `dependency_install_scopes`
   *  (D-310), and one not named there installs at its authored defaults. */
  install_scope?: InstallGrantSelection;
  /** D-194 2b — the owner's chosen connection from the install dialog's Connect
   *  section. Forwarded to `provisionPackCompositionForBulkInstall` (5th arg),
   *  which re-sources the composition's grant + binding to it (step 3a). Absent ⇒
   *  the authored `auth.connection` literal (connect is optional). */
  chosen_connection?: string;
  /** D-201 Slice 4 — owner choices for this pack and any transitive pack
   * dependency. The manifest cannot populate this field. */
  webhook_bindings?: ReadonlyArray<{
    pack_slug: string;
    binding: string;
    ingress_id: string;
  }>;
  /** Exact review anchor returned by packs.list for a bundled Records update. */
  expected_manifest_hash?: string;
  /** D-310 — the owner's Access choice for each pack this install brings in with
   *  it, by authored slug. Each is that pack's `install_scope` when the
   *  recursion below installs it; a pack not named installs at its authored
   *  defaults, as every dependency did before. */
  dependency_install_scopes?: ReadonlyArray<PackDependencyInstallScope>;
};

type InternalInstallOutcome = {
  result: BulkPackInstallResultLike;
  /** Every recipe ref declared by this pack and the dependency packs that were
   *  installed ahead of it. Callers use this to avoid reinstalling dependency-
   *  owned recipes under the parent pack slug. */
  recipeKeys: ReadonlySet<string>;
};

type InternalInstallContext = {
  visiting: Set<string>;
  installed: Set<string>;
  recipeKeysByPack: Map<string, ReadonlySet<string>>;
};

const INSTALL_SCOPE_ERROR =
  'install_scope must carry access plus either legacy scope or the D-196 audience checklist';

/** D-310 — a present-but-malformed `dependency_install_scopes` is a client bug:
 *  refused loudly, like `install_scope`, so a mistyped choice cannot quietly
 *  install a pack at its authored defaults. */
const assertDependencyInstallScopes = (method: string, value: unknown): void => {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new RpcError('bad_request', `${method}: dependency_install_scopes must be an array`);
  }
  const seen = new Set<string>();
  value.forEach((entry: unknown, index) => {
    if (entry === null
      || typeof entry !== 'object'
      || Object.getPrototypeOf(entry) !== Object.prototype
      || Object.keys(entry).sort().join(',') !== 'install_scope,pack_slug'
      || typeof (entry as { pack_slug?: unknown }).pack_slug !== 'string'
      || !SLUG_RE.test((entry as { pack_slug: string }).pack_slug)
      || !isInstallGrantSelection((entry as { install_scope?: unknown }).install_scope)) {
      throw new RpcError('bad_request', `${method}: dependency_install_scopes[${index}] is invalid`);
    }
    const slug = (entry as { pack_slug: string }).pack_slug;
    if (seen.has(slug)) {
      throw new RpcError('bad_request', `${method}: dependency_install_scopes names ${JSON.stringify(slug)} twice`);
    }
    seen.add(slug);
  });
};

const recipeRefKey = (ref: { slug: string; version: number }): string => `${ref.slug}@${ref.version}`;

const declaredRecipeKeys = (manifest: BulkPackManifest): Set<string> =>
  new Set(normalizeBulkPackInstallPlan(manifest).recipes.map(recipeRefKey));

const emptySuccess = (): BulkPackInstallResultLike => ({
  ok: true,
  installed: [],
  rolled_back: [],
});

const mergeSuccessResults = (
  results: readonly BulkPackInstallResultLike[],
): BulkPackInstallResultLike => {
  const installed = results.flatMap((r) => r.installed);
  const rolled_back = results.flatMap((r) => r.rolled_back);
  const deferred_contents = results.flatMap((r) => r.deferred_contents ?? []);
  const born_blocked = results.flatMap((r) => r.born_blocked ?? []);
  const born_degraded = results.flatMap((r) => r.born_degraded ?? []);
  const pii_disclosure = results.flatMap((r) => r.pii_disclosure ?? []);
  return {
    ok: true,
    installed,
    rolled_back,
    ...(deferred_contents.length > 0 ? { deferred_contents } : {}),
    ...(born_blocked.length > 0 ? { born_blocked } : {}),
    ...(born_degraded.length > 0 ? { born_degraded } : {}),
    ...(pii_disclosure.length > 0 ? { pii_disclosure } : {}),
  };
};

const dependencyFailureResult = (
  packSlug: string,
  result: BulkPackInstallResultLike,
  priorSuccesses: readonly BulkPackInstallResultLike[],
): BulkPackInstallResultLike => {
  const prior = mergeSuccessResults(priorSuccesses);
  const failure = result.failure ?? {
    code: 'unexpected' as const,
    message: 'dependency install failed without a failure payload',
  };
  return {
    ok: false,
    installed: [...prior.installed, ...result.installed],
    rolled_back: [...prior.rolled_back, ...result.rolled_back],
    failure: {
      ...failure,
      message: `dependency pack ${JSON.stringify(packSlug)} failed during install: ${failure.message}`,
    },
  };
};

const filterPlanRecipeRefs = (
  plan: PackInstallPlan,
  omitRecipeKeys: ReadonlySet<string> | undefined,
): PackInstallPlan => {
  if (omitRecipeKeys === undefined || omitRecipeKeys.size === 0) return plan;
  return {
    recipes: plan.recipes.filter((ref) => !omitRecipeKeys.has(recipeRefKey(ref))),
    contents: plan.contents.filter((content) =>
      content.type !== 'recipe' || !omitRecipeKeys.has(recipeRefKey(content)),
    ),
  };
};

/** Resolve the release layout's exact `<root>/<slug>.json` artifact. Unlike the
 * recursive install resolver above, this is unambiguous and O(1): the closed
 * boot-reconciliation ledger must never select a duplicate from elsewhere in a
 * 1,000+ pack tree merely because directory enumeration reached it first. */
export const resolveRootBundledPackManifest = (
  packDir: string,
  packSlug: string,
): BulkPackManifest | null => {
  if (!SLUG_RE.test(packSlug)) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(packDir, `${packSlug}.json`), 'utf-8'));
    const result = parseBulkPackManifest(parsed);
    return result.ok && result.manifest.slug === packSlug ? result.manifest : null;
  } catch {
    return null;
  }
};

const dependencyPreflightFailure = (
  code: NonNullable<BulkPackInstallResultLike['failure']>['code'],
  message: string,
): BulkPackInstallResultLike => ({
  ok: false,
  installed: [],
  rolled_back: [],
  failure: { code, message },
});

/** Is a declared pack dependency ALREADY satisfied by what the owner has
 *  installed? Presence when the entry names no `min_version`; presence at a
 *  KNOWN version at or above it otherwise.
 *
 *  ⛔⛔ THIS EXISTS BECAUSE A DEPENDENCY ENTRY IS AN INSTALL, NOT AN ASSERTION.
 *  The recursion below hands each dependency to `handlePacksInstallInternal`
 *  forwarding `granted_permissions` and `webhook_bindings` and NOTHING else (and,
 *  since D-310, the install dialog's Access choice for a pack it brings in, which
 *  it asks only for a pack not yet installed) — so
 *  an absent `install_scope` (documented fail-closed: "grant ONLY the authored
 *  read / `approval: ask` defaults") and an absent `chosen_connection` (falls back
 *  to the authored `auth.connection` literal) REPLACED whatever the owner chose
 *  at that pack's own install. Installing an add-on therefore downgraded a pack
 *  the owner already had: driven, `federated-projects` installed with
 *  `{access:'all', scope:'owner'}` came back read-only and its very next
 *  `federation.bootstrap` answered `operation_not_granted` — an error naming an
 *  operation, not the add-on that caused it, and not the grant it replaced.
 *
 *  🔑 A SATISFIED REQUIREMENT IS NOT RE-INSTALLED. That one rule fixes the
 *  clobber and a second surprise with it: a bundled dependency whose disk copy
 *  had moved ahead was being upgraded as a SIDE EFFECT of installing something
 *  else, which is an unrequested content change to a pack the owner chose
 *  deliberately. `min_version` is what the entry actually asks for; meeting it is
 *  the whole obligation.
 *
 *  ⚠ FAIL-SAFE WHEN IT CANNOT TELL. No `contractStore` (the db-less harness) ⇒
 *  `false` ⇒ install exactly as before. A row whose version is unparseable is
 *  likewise not credited against a `min_version` — `getInstalledPack` is
 *  deliberately lenient about that so a corrupt row stays removable, and lenient
 *  is the wrong posture for a satisfaction check.
 *
 *  ⚠ RESIDUAL, STATED: a dependency installed BELOW `min_version` is still
 *  reinstalled — that is a genuine upgrade — and the owner's scope choice is
 *  still replaced on that path. Narrower than what this fixes, and arguably a
 *  different decision (an upgrade changes the op set the scope was chosen for),
 *  but it is not fixed here. */
const dependencyAlreadySatisfied = (
  store: ContractStore | undefined,
  dependency: { slug: string; min_version?: number },
): boolean => {
  if (store === undefined) return false;
  // ⛔ BY AUTHORED SLUG, NOT BY ROW KEY. A Records pack's inventory row is keyed
  // by its generated `records-<hash>` catalog id, so `getInstalledPack` answers
  // `null` for a pack that IS installed — and that is precisely the pack class
  // where a clobbered `install_scope` turns into "installed, looks fine, refuses
  // its own writes". Driven: the row for `federated-projects` reads
  // `records-84016f4885cb4d94b248193d6b702c5e`.
  const installed = findInstalledPackByAuthoredSlug(store, dependency.slug);
  if (installed === null) return false;
  if (dependency.min_version === undefined) return true;
  return installed.version >= dependency.min_version;
};

/** ⛔⛔ D-294 — A RECORDS PACK THE OWNER HAS IS NOT UPDATED AS A DEPENDENCY.
 *
 *  An installed dependency below a pack's `min_version` is re-installed, and for
 *  any other pack `carryOverUpdateChoices` keeps its Access and audience. A Records
 *  pack was left out of that on the grounds that "its update requires the review",
 *  but an update that arrives as a dependency carries no review: the recursion
 *  forwards no fence and the Records coordinator treats one as optional, so the
 *  update was applied at authored defaults. Installing `seller-quote-payment-events`
 *  over a v26.9.21 Seller Quote Request (3; it needs 4) took the owner's write
 *  grant on quotes with it (2026-09-24 audit; reproduced 2026-09-25).
 *
 *  So it is refused before anything is written, and the message says to update the
 *  Records pack first, from its own dialog, which shows the review. Called after
 *  `dependencyAlreadySatisfied`, so an installed pack here is one below the
 *  required version.
 *
 *  ⚠ ENFORCED IN THE PREFLIGHT WALK, WHICH IS ALSO WHAT THE INSTALL DIALOG READS
 *  (`dependencyRequirementsFor` answers `undefined`). The recursion needs no copy:
 *  `handlePacksInstallInternal` has one caller, which runs the preflight first
 *  over the same graph, and every pack the recursion installs is the bundled
 *  version. ⇒ A new entry point into the recursion must run the preflight too. */
const recordsDependencyUpdateRefusal = (
  store: ContractStore | undefined,
  parent: BulkPackManifest,
  dependency: { slug: string; min_version?: number },
  dependencyManifest: BulkPackManifest,
): BulkPackInstallResultLike | null => {
  if (store === undefined || !carriesRecords(dependencyManifest)) return null;
  const installed = findInstalledPackByAuthoredSlug(store, dependency.slug);
  if (installed === null) return null;
  const name = dependencyManifest.name;
  return dependencyPreflightFailure(
    'version_mismatch',
    `packs.install: ${parent.name} needs ${name} version ${dependency.min_version ?? dependencyManifest.version} `
      + `or later, and version ${installed.version} is installed. Updating ${name} changes its records, which `
      + `needs your review in its own update, so update ${name} first from Packs, then install ${parent.name} again.`,
  );
};

/** D-311 — where a pack an install brings in comes from: the server's own
 *  bundled copy, then the marketplace copy fetched for this call when the call is
 *  a marketplace one (`resolveDependencyManifest`). One resolver for every walk
 *  and for the install's recursion, so the preview, the preflight and the install
 *  cannot resolve a dependency differently. Bundled first, as `packs.resolveBySlug`
 *  orders the pack itself: the server's own copy cannot 404 or be substituted. */
const dependencyManifestResolver = (
  deps: Pick<PackInstallRpcDeps, 'packDir' | 'resolveDependencyManifest'>,
): ((slug: string) => BulkPackManifest | null) =>
  (slug) => resolveBundledPackManifest(deps.packDir, slug) ?? deps.resolveDependencyManifest?.(slug) ?? null;

const collectTransitivePackRequirements = (
  manifest: BulkPackManifest,
  resolveDependency: (slug: string) => BulkPackManifest | null,
  required: Set<string>,
  visiting: Set<string>,
  visited: Set<string>,
  manifestsBySlug: Map<string, BulkPackManifest>,
  contractStore: ContractStore | undefined,
): BulkPackInstallResultLike | null => {
  if (visited.has(manifest.slug)) return null;
  if (visiting.has(manifest.slug)) {
    return dependencyPreflightFailure(
      'unresolved',
      `packs.install: cyclic pack dependency involving ${JSON.stringify(manifest.slug)}`,
    );
  }
  visiting.add(manifest.slug);
  manifestsBySlug.set(manifest.slug, manifest);
  for (const dependency of manifest.dependencies ?? []) {
    if (dependency.type !== 'pack') continue;
    const dependencyManifest = resolveDependency(dependency.slug);
    if (dependencyManifest === null) {
      return dependencyPreflightFailure(
        'unresolved',
        `packs.install: dependency pack ${JSON.stringify(dependency.slug)} ` +
          `declared by ${JSON.stringify(manifest.slug)} was not found in bundled packs`,
      );
    }
    if (dependency.min_version !== undefined && dependencyManifest.version < dependency.min_version) {
      return dependencyPreflightFailure(
        'version_mismatch',
        `packs.install: dependency pack ${JSON.stringify(dependency.slug)} ` +
          `is version ${dependencyManifest.version}, below required ${dependency.min_version}`,
      );
    }
    // ⛔⛔ THE SKIP HAS TO BE HERE TOO, OR THE FIX BECOMES A NEW FALSE BLOCKER.
    // This walk unions every transitive `requires` and refuses `permission_denied`
    // when one is ungranted, and it fills `manifestsBySlug`, which then demands
    // "exactly one owner-selected ingress for every webhook binding" per pack. So
    // skipping the INSTALL while still walking here would ask the owner to grant
    // permissions and re-choose webhook ingresses for a pack this install is not
    // going to touch — and refuse the whole install if they declined.
    // 🔑 ONE RULE AT TWO ENDS, SHARING ONE PREDICATE. The two walks disagreeing is
    // exactly the shape where a precheck refuses something the runtime would have
    // allowed (or the reverse), and each end reads as correct on its own.
    if (dependencyAlreadySatisfied(contractStore, dependency)) continue;
    const needsItsOwnUpdate = recordsDependencyUpdateRefusal(
      contractStore, manifest, dependency, dependencyManifest,
    );
    if (needsItsOwnUpdate !== null) return needsItsOwnUpdate;
    for (const permission of dependencyManifest.requires) required.add(permission);
    const failure = collectTransitivePackRequirements(
      dependencyManifest,
      resolveDependency,
      required,
      visiting,
      visited,
      manifestsBySlug,
      contractStore,
    );
    if (failure !== null) return failure;
  }
  visiting.delete(manifest.slug);
  visited.add(manifest.slug);
  return null;
};

/** D-305 — the permissions the packs this install brings in with it need beyond
 *  the pack's own `requires`, each with the names of the packs that need it. The
 *  install dialog offered only the pack's own, so an install whose dependency
 *  needed more (Personal CRM → its foundation's `notification_send`) could never
 *  succeed from the dialog. It was refused "granted permissions are missing
 *  transitive pack requirements", and nothing on screen could grant the missing
 *  permission.
 *  🔑 THE INSTALL'S OWN WALK, with its already-installed skip: the dialog offers
 *  exactly what `preflightTransitivePermissions` checks, so granting what it
 *  offers installs. `undefined` when the walk fails; the install says why. */
export const dependencyRequirementsFor = (
  deps: Pick<PackInstallRpcDeps, 'packDir' | 'contractStore' | 'resolveDependencyManifest'>,
  manifest: BulkPackManifest,
): Array<{ permission: string; needed_by: string[] }> | undefined => {
  const required = new Set<string>(manifest.requires);
  const manifestsBySlug = new Map<string, BulkPackManifest>();
  const failure = collectTransitivePackRequirements(
    manifest, dependencyManifestResolver(deps), required, new Set(), new Set(), manifestsBySlug, deps.contractStore,
  );
  if (failure !== null) return undefined;
  const own = new Set<string>([BULK_PACK_INSTALL_PERMISSION, ...manifest.requires]);
  return [...required].filter((permission) => !own.has(permission)).sort().map((permission) => ({
    permission,
    needed_by: [...manifestsBySlug.values()]
      .filter((other) => other.slug !== manifest.slug && other.requires.includes(permission))
      .map((other) => other.name),
  }));
};

const preflightTransitivePermissions = (
  deps: PackInstallRpcDeps,
  args: PacksInstallArgs,
  manifest: BulkPackManifest,
): BulkPackInstallResultLike | null => {
  const required = new Set<string>(manifest.requires);
  const manifestsBySlug = new Map<string, BulkPackManifest>();
  const failure = collectTransitivePackRequirements(
    manifest,
    dependencyManifestResolver(deps),
    required,
    new Set(),
    new Set(),
    manifestsBySlug,
    deps.contractStore,
  );
  if (failure !== null) return failure;

  // D-201 Slice 4 — validate the complete root + dependency chooser payload
  // before installing the first dependency. Per-pack install still revalidates
  // the exact set, but this preflight prevents a missing/extra root selection
  // from surfacing only after a dependency has already landed.
  const selections = args.webhook_bindings ?? [];
  const selectionsByPack = new Map<string, Set<string>>();
  for (const selection of selections) {
    const packSelections = selectionsByPack.get(selection.pack_slug) ?? new Set<string>();
    packSelections.add(selection.binding);
    selectionsByPack.set(selection.pack_slug, packSelections);
  }
  for (const packSlug of selectionsByPack.keys()) {
    if (!manifestsBySlug.has(packSlug)) {
      return dependencyPreflightFailure(
        'validator_rejected',
        `packs.install: webhook binding selection names unknown pack ${JSON.stringify(packSlug)}`,
      );
    }
  }
  for (const [packSlug, packManifest] of manifestsBySlug) {
    const requirementBindings = new Set(
      (packManifest.webhook_requirements ?? []).map((requirement) => requirement.binding),
    );
    const selectedBindings = selectionsByPack.get(packSlug) ?? new Set<string>();
    if (selectedBindings.size !== requirementBindings.size
      || [...selectedBindings].some((binding) => !requirementBindings.has(binding))) {
      return dependencyPreflightFailure(
        'validator_rejected',
        `packs.install: pack ${JSON.stringify(packSlug)} requires exactly one owner-selected ingress for every webhook binding`,
      );
    }
    if (requirementBindings.size > 0 && !deps.webhookConsumerStore) {
      return dependencyPreflightFailure(
        'validator_rejected',
        `packs.install: pack ${JSON.stringify(packSlug)} requires the D-201 webhook consumer store`,
      );
    }
  }

  // D-310 — an Access choice names a pack this install brings in. The pack being
  // installed has its own (`install_scope`); any other name is a stale or wrong
  // dialog, and the owner's choice would silently apply to nothing. Checked on the
  // same walk the recursion takes, so a dependency already installed at the
  // version needed (skipped by both) is refused too: it would not be touched.
  for (const choice of args.dependency_install_scopes ?? []) {
    if (choice.pack_slug === manifest.slug || !manifestsBySlug.has(choice.pack_slug)) {
      return dependencyPreflightFailure(
        'validator_rejected',
        `packs.install: an Access choice names pack ${JSON.stringify(choice.pack_slug)}, which this install does not bring in`,
      );
    }
  }

  const granted = new Set<string>([BULK_PACK_INSTALL_PERMISSION, ...args.granted_permissions]);
  const missing = [...required].filter((permission) => !granted.has(permission)).sort();
  if (missing.length === 0) return null;
  return dependencyPreflightFailure(
    'permission_denied',
    `packs.install: granted permissions are missing transitive pack requirements: ${missing.join(', ')}`,
  );
};

const parsePacksInstallArgs = (args: PacksInstallArgs): { manifest: BulkPackManifest } => {
  if (args == null || typeof args !== 'object') {
    throw new RpcError('bad_request', 'packs.install: args required');
  }
  if (
    !Array.isArray(args.granted_permissions)
    || !args.granted_permissions.every((p): p is string => typeof p === 'string')
  ) {
    throw new RpcError(
      'bad_request',
      'packs.install: granted_permissions must be an array of strings',
    );
  }
  // D-182 §7.1 — present-but-malformed install_scope is a client bug; reject
  // loudly so a typo'd Access tier can't silently downgrade to authored-only.
  if (args.install_scope !== undefined && !isInstallGrantSelection(args.install_scope)) {
    throw new RpcError(
      'bad_request',
      `packs.install: ${INSTALL_SCOPE_ERROR}`,
    );
  }
  // D-194 2b — a present-but-non-string chosen_connection is a client bug; reject
  // loudly (mirrors the install_scope guard) rather than silently falling back to
  // the authored literal, which would mask a picker that sent the wrong shape.
  if (args.chosen_connection !== undefined && typeof args.chosen_connection !== 'string') {
    throw new RpcError(
      'bad_request',
      'packs.install: chosen_connection must be a string',
    );
  }
  assertDependencyInstallScopes('packs.install', args.dependency_install_scopes);
  if (args.expected_manifest_hash !== undefined
    && !/^[0-9a-f]{64}$/.test(args.expected_manifest_hash)) {
    throw new RpcError(
      'bad_request',
      'packs.install: expected_manifest_hash must be a lowercase SHA-256 digest',
    );
  }
  if (args.webhook_bindings !== undefined) {
    if (!Array.isArray(args.webhook_bindings)) {
      throw new RpcError(
        'bad_request',
        'packs.install: webhook_bindings must be an array',
      );
    }
    const seen = new Set<string>();
    for (let index = 0; index < args.webhook_bindings.length; index += 1) {
      const selection = args.webhook_bindings[index];
      if (selection === null
        || typeof selection !== 'object'
        || Object.getPrototypeOf(selection) !== Object.prototype
        || Object.keys(selection).sort().join(',') !== 'binding,ingress_id,pack_slug'
        || typeof selection.pack_slug !== 'string'
        || selection.pack_slug.length === 0
        || typeof selection.binding !== 'string'
        || selection.binding.length === 0
        || typeof selection.ingress_id !== 'string'
        || selection.ingress_id.length === 0) {
        throw new RpcError(
          'bad_request',
          `packs.install: webhook_bindings[${index}] is invalid`,
        );
      }
      const key = `${selection.pack_slug}\u0000${selection.binding}`;
      if (seen.has(key)) {
        throw new RpcError(
          'bad_request',
          `packs.install: duplicate webhook binding selection for '${selection.pack_slug}/${selection.binding}'`,
        );
      }
      seen.add(key);
    }
  }

  const parsed = parseBulkPackManifest(args.manifest);
  if (!parsed.ok) {
    const first =
      parsed.issues.find((i) => i.severity === 'error') ?? parsed.issues[0];
    const path = first?.path ?? '';
    const msg = first?.message ?? 'invalid pack manifest';
    throw new RpcError(
      'bad_request',
      path.length > 0
        ? `packs.install: invalid manifest — ${path}: ${msg}`
        : `packs.install: invalid manifest — ${msg}`,
    );
  }
  return { manifest: parsed.manifest };
};

/** D-247 D15 — resolve every recipe ref in a plan to its BODY, exactly as the
 *  install does.
 *
 *  ⛔⛔ EXTRACTED SO THE INSTALL PREVIEW AND THE INSTALL CANNOT DRIFT.
 *  `grant-op-universe.ts` states the discipline this follows — *"the derivation
 *  IS the gate's read path, and two private copies would drift"* — and a preview
 *  that showed different recipes from the ones the install enables is worse than
 *  no preview: the owner would have consented to a list that was never true.
 *
 *  ⚠ The manifest CANNOT answer this on its own. `chat_exposed` lives on the
 *  BODY, and 0 of 2,310 shipped recipe refs across 340 packs carry one — a
 *  client-side derivation would have to reimplement the marketplace/bundled
 *  precedence AND the `recipes[]` backfill, which is the second copy this exists
 *  to prevent. */
export const resolvePackRecipeBodies = async (
  plan: { readonly recipes: ReadonlyArray<{ readonly slug: string; readonly version: number }> },
  manifestPublisher: string,
  deps: {
    readonly recipeStore: Pick<RecipeStore, 'getBundled'>;
    readonly resolveMarketplaceRecipe?: (slug: string) => Promise<MarketplaceRecipeResult | null>;
  },
): Promise<BulkPackInstallRecipe[]> => {
  const resolved: BulkPackInstallRecipe[] = [];
  for (const ref of plan.recipes) {
    // A marketplace-fetched pack resolves every ref back through the
    // marketplace, even if a same-slug bundled recipe exists locally. The local
    // body has no publisher row attached, so preferring it would reintroduce the
    // pack-publisher identity rewrite this boundary is meant to prevent.
    const marketplaceRow = deps.resolveMarketplaceRecipe
      ? await deps.resolveMarketplaceRecipe(ref.slug)
      : null;
    const bundledRecipe = deps.resolveMarketplaceRecipe
      ? null
      : deps.recipeStore.getBundled(ref.slug);
    const recipe = bundledRecipe ?? marketplaceRow?.recipe ?? null;
    if (recipe == null) {
      resolved.push({
        slug: ref.slug,
        pinned_version: ref.version,
        recipe: null,
        failure: 'not_found',
      });
      continue;
    }
    const recipeVersion = marketplaceRow?.version
      ?? (typeof (recipe as { version?: number }).version === 'number'
        ? (recipe as { version: number }).version
        : ref.version);
    resolved.push({
      slug: ref.slug,
      pinned_version: ref.version,
      recipe: {
        recipe_id: recipe.recipe_id,
        // Bundled recipes are pack-authored and retain the manifest publisher.
        // Marketplace-resolved recipes retain the fetched row's authority even
        // when the containing pack is published by somebody else.
        publisher_id: marketplaceRow?.publisher_id ?? manifestPublisher,
        version: recipeVersion,
        recipe_hash: hashRecipe(recipe),
        recipe,
      },
      ...(recipeVersion !== ref.version ? { failure: 'version_drift' as const } : {}),
    });
  }
  return resolved;
};

/** ⛔ D-294 — AN UPDATE THAT BRINGS NO CHOICE KEEPS THE PACK'S CURRENT ONES.
 *
 *  Every install path writes the pack's authority from what the call carries:
 *  its Access tier and audience (`install_scope`) and its account
 *  (`chosen_connection`). A call that carries none — a dependency re-installed
 *  below its `min_version`, a generated-pack re-commit, any rpc caller, or the
 *  dialog before its account list loaded — fell back to a FRESH install's
 *  answers on a pack the owner already has: authored grants only, the share
 *  withdrawn from every customer and agreement, the pack re-bound to its
 *  authored connection name.
 *
 *  So a missing choice on an update is filled from the pack as it is now
 *  (`current_access` / `current_audience` / `current_connection`, the same
 *  read-backs the update dialog starts from). A choice the caller made always
 *  wins. The Access tier is filled only when it can be told, or when the pack
 *  is shared beyond the owner (a share needs a tier to write; the install that
 *  shared it granted at least Read). A Records pack is left alone: its update
 *  requires the review, which the dialog fills, and one that would arrive as a
 *  dependency is refused instead (`recordsDependencyUpdateRefusal`). */
const carryOverUpdateChoices = (
  deps: PackInstallRpcDeps,
  args: PacksInstallArgs,
  manifest: BulkPackManifest,
): PacksInstallArgs => {
  if (deps.contractStore === undefined || carriesRecords(manifest)) return args;
  if (args.install_scope !== undefined && args.chosen_connection !== undefined) return args;
  if (getInstalledPack(deps.contractStore, manifest.slug) === null) return args;
  let installScope = args.install_scope;
  if (installScope === undefined) {
    const access = deps.localManifestStore !== undefined
      ? compositionPackCurrentAccess(deps.contractStore, deps.localManifestStore, manifest)
      : undefined;
    const audience = currentPackAudience({
      contractStore: deps.contractStore,
      ...(deps.sellerStore !== undefined ? { sellerStore: deps.sellerStore } : {}),
      sourcePack: manifest.slug,
      now: deps.now ?? Date.now,
    });
    const sharedBeyondOwner = !audience.owner || audience.all_customers || audience.all_other_contracts
      || (audience.customer_tier_ids?.length ?? 0) > 0 || (audience.contract_ids?.length ?? 0) > 0;
    if (access !== undefined || sharedBeyondOwner) installScope = { access: access ?? 'read', audience };
  }
  const connection = args.chosen_connection ?? currentPackConnection(deps.contractStore, manifest.slug);
  return {
    ...args,
    ...(installScope !== undefined ? { install_scope: installScope } : {}),
    ...(connection !== undefined ? { chosen_connection: connection } : {}),
  };
};

/** D-182 Slice 4 — the Tier-P `pack_ref → catalog` map an install of `manifest`
 *  lowers its recipes against: the installed packs, less the pack itself (a
 *  reinstall's stale prior row must not resolve its own recipes'
 *  self-references). `undefined` without the inventory store and the registry (a
 *  db-less boot). The install and its preview both build it here, so the preview
 *  cannot count as installed a pack the install would not bind. */
const installPackOpResolution = (
  deps: Pick<PackInstallRpcDeps, 'contractStore' | 'registry'>,
  manifest: Pick<BulkPackManifest, 'publisher' | 'slug'>,
): PackOpResolution | undefined =>
  deps.contractStore !== undefined && deps.registry !== undefined
    ? buildPackOpResolution(
        () => deps.contractStore!.scan('installed_pack'),
        (slug) => deps.registry!.get(slug) ?? null,
        `${manifest.publisher}.${manifest.slug}`,
      )
    : undefined;

/** The packs an install can count on for a recipe's Tier-P operations: the ones
 *  installed that `resolution` binds, and the ones the install itself writes
 *  (`installing`, as `<publisher>.<pack>` refs). */
const packsBoundFor = (
  resolution: PackOpResolution,
  installing: ReadonlySet<string>,
): { has(packRef: string): boolean } => ({
  has: (packRef) => resolution.has(packRef) || installing.has(packRef),
});

const installSinglePack = async (
  deps: PackInstallRpcDeps,
  requestArgs: PacksInstallArgs,
  options: {
    omitRecipeKeys?: ReadonlySet<string>;
    verifiedPublisher?: string;
    recordsReviewFence?: RecordsUpdateReviewFence;
  } = {},
): Promise<{ result: BulkPackInstallResultLike }> => {
  const { manifest } = parsePacksInstallArgs(requestArgs);
  const args = carryOverUpdateChoices(deps, requestArgs, manifest);
  // D-165 app-pack v2 — collapse v1/v2 to one install plan. `plan.recipes`
  // is the deduped recipe set the parser already lifted into
  // `manifest.recipes` (so the resolve loop below is unchanged for v1);
  // `plan.contents` is the full typed content list (recipe + non-recipe)
  // threaded onto the engine input so it can echo non-recipe contents as
  // `deferred_contents`.
  const plan = filterPlanRecipeRefs(
    normalizeBulkPackInstallPlan(manifest),
    options.omitRecipeKeys,
  );

  // D-170 (packs.install composition branch) — an app_pack may carry its
  // integration as a `composition` content by value (N.17). When the
  // provisioning substrate is wired (contract + local-manifest stores +
  // registry) we decompose + install it alongside the recipes so the gateway
  // resolves its operations (N.16); otherwise it stays in `deferred_contents`
  // (honest deferral — e.g. a db-less harness, where we never touch it). Detect
  // it up front + run the pure D-170 validator BEFORE installing any recipe, so
  // a malformed composition fails the WHOLE install cleanly (no half-installed
  // pack). The state-dependent guards (slug / pack-slug conflicts) run at
  // provision time below; those rare conflicts degrade to a disclosed deferral,
  // not a pre-recipe abort.
  const compositionRefs = plan.contents.filter(
    (c): c is Extract<PackContentRef, { type: 'composition' }> => c.type === 'composition',
  );
  // Detect Records across EVERY composition ref, not just a lone one. Keying
  // this on `length === 1` made all three Records guards below — storage
  // availability, verified-publisher provenance, and the sidecar refusal —
  // structurally unreachable for a pack that simply ships a second
  // composition. The `length > 1` refusal further down is a different rule and
  // sits inside `canProvisionComposition`, so it is not a backstop for them.
  const recordsComposition = compositionRefs.some(
    (ref) => isRecordsComposition(ref.composition),
  );
  const genericCompositionSubstrate =
    compositionRefs.length > 0
    && deps.contractStore !== undefined
    && deps.localManifestStore !== undefined
    && deps.registry !== undefined;
  const canProvisionComposition = genericCompositionSubstrate
    && (!recordsComposition || deps.recordsStore !== undefined);
  if (recordsComposition && !canProvisionComposition) {
    return {
      result: {
        ok: false,
        installed: [],
        rolled_back: [],
        failure: {
          code: 'validator_rejected',
          message: 'packs.install: Records runtime/storage is unavailable; Records compositions are never deferred',
        },
      },
    };
  }
  if (recordsComposition && options.verifiedPublisher !== manifest.publisher) {
    return {
      result: {
        ok: false,
        installed: [],
        rolled_back: [],
        failure: {
          code: 'validator_rejected',
          message: 'packs.install: Records requires marketplace or bundled verified publisher provenance; by-value publisher strings are not authority',
        },
      },
    };
  }
  // ⛔ Count only the selections that name THIS pack. A dependency install is
  // handed the parent's whole `webhook_bindings` list (the dependency recursion
  // in `handlePacksInstallInternal`), so a non-Records pack that listens on a webhook and
  // depends on a Records pack used to be refused here for ITS OWN binding —
  // the Records dependency could only be installed first, by hand. The rule is
  // about this pack's sidecars, and a binding addressed to another pack is not
  // one: that pack's own install step owns it.
  const ownWebhookBindings = (args.webhook_bindings ?? [])
    .filter((selection) => selection.pack_slug === manifest.slug);
  if (
    recordsComposition
    && (
      (manifest.webhook_requirements?.length ?? 0) > 0
      || (manifest.mcp_body_visibility_grants?.length ?? 0) > 0
      || ownWebhookBindings.length > 0
    )
  ) {
    return {
      result: {
        ok: false,
        installed: [],
        rolled_back: [],
        failure: {
          code: 'validator_rejected',
          message: 'packs.install: Records v1 refuses webhook/body-visibility sidecars because they cannot join its atomic promotion',
        },
      },
    };
  }
  if (canProvisionComposition) {
    if (compositionRefs.length > 1) {
      return {
        result: {
          ok: false,
          installed: [],
          rolled_back: [],
          failure: {
            code: 'validator_rejected',
            message: 'packs.install: an app_pack carries at most one composition content',
          },
        },
      };
    }
    const validated = validatePack(args.manifest, { recipeValidator: validateRecipe });
    if (!validated.valid) {
      const firstError =
        validated.issues.find((i) => i.severity === 'error') ?? validated.issues[0];
      const detail = firstError
        ? firstError.path
          ? `${firstError.path}: ${firstError.message}`
          : firstError.message
        : 'composition failed validation';
      return {
        result: {
          ok: false,
          installed: [],
          rolled_back: [],
          failure: {
            code: 'validator_rejected',
            message: `packs.install: composition failed validation — ${detail}`,
          },
        },
      };
    }
  }

  const now = deps.now?.() ?? Date.now();
  // Resolve every `recipes[]` entry from exactly one authority: by-value /
  // foundation installs use the BUNDLED-only recipe view; marketplace by-slug
  // installs use the injected full-row marketplace resolver. Bundled-only is
  // the safe by-value default:
  //   - the engine's `markInstalled` upserts the recipe row with
  //     `publisher_id` sourced from the manifest's `publisher`, so a
  //     broader resolution scope (memory override → SQLite → bundled)
  //     would let a user-imported manifest from publisher B silently
  //     rewrite an already-installed recipe's publisher_id (a
  //     vault-scope reassignment vector, since vault credentials are
  //     scoped by publisher_id);
  //   - foundation packs ship their constituent recipes bundled, so
  //     bundled-only covers the v1 use case (first-party packs
  //     installing SI rules);
  //   - marketplace packs resolve every constituent (bundled slug collision or
  //     not) through
  //     `resolveMarketplaceRecipe` — the install-seam-5c marketplace-fetch
  //     path. It is present ONLY on the by-slug install entry
  //     (`installPackBySlug`), and returns the full authoritative recipe row so
  //     a cross-publisher pack reference preserves the constituent recipe's own
  //     `publisher_id`. The by-value path has no resolver and remains bundled-
  //     only, preserving its publisher_id-rewrite protection.
  const resolved: BulkPackInstallRecipe[] = await resolvePackRecipeBodies(
    plan,
    manifest.publisher,
    deps,
  );
  let ready = resolved.every((r) => r.recipe != null && r.failure == null);

  // Pure-workflow trust is a property of the AUTHORED recipe (an all-entity-op
  // recipe is pure-workflow — D-170 N.18), but the A3 rewrite below replaces an
  // op-step with a catalog fetch + a projection `map` transform, which would drop
  // it out of the tier post-resolution. Snapshot the authored defs (parallel to
  // `resolved`) BEFORE the rewrite so trust is classified from what the author
  // wrote, then applied to the persisted (resolved) recipe id/version.
  const authoredRecipeDefs = resolved.map((r) => r.recipe?.recipe ?? null);
  const recordsMigrationPlans: RecordsMigrationPlan[] = [];
  let recordsMigrationArtifacts: readonly RecordsMigrationArtifact[] = [];
  let recordsReviewSourceRecipes: readonly ResolvedRecordsPackRecipe[] | undefined;

  // D-221 compatibility canary — classify and remove it from the runnable set
  // before generic op lowering. The immediately preceding runtime sees the
  // unknown Tier-K op and fails closed; this runtime alone recognizes the exact
  // inert whole-recipe shape. It is never persisted or executed.
  if (recordsComposition && ready) {
    const canaryIndexes = resolved.flatMap((entry, index) => {
      const steps = entry.recipe?.recipe.steps;
      return Array.isArray(steps)
        && steps.some((step) => (
          step !== null
          && typeof step === 'object'
          && 'op' in step
          && step.op === RECORDS_RUNTIME_CANARY_OP
        ))
        ? [index]
        : [];
    });
    if (canaryIndexes.length !== 1) {
      return {
        result: {
          ok: false,
          installed: [],
          rolled_back: [],
          failure: {
            code: 'validator_rejected',
            message: 'packs.install: a Records artifact requires exactly one generated runtime canary',
          },
        },
      };
    }
    const canaryIndex = canaryIndexes[0]!;
    const canary = resolved[canaryIndex]!;
    const canaryRef = plan.contents.find((content): content is Extract<PackContentRef, { type: 'recipe' }> =>
      content.type === 'recipe'
      && content.slug === canary.slug
      && content.version === canary.pinned_version);
    const canaryIssue = canaryRef === undefined || canary.recipe === null
      ? 'runtime canary has no exact resolved content ref/body'
      : recordsRuntimeCanaryIssue(
          canaryRef,
          canary.recipe.recipe,
          `${manifest.publisher}/${manifest.slug}`,
        );
    if (canaryIssue !== null) {
      return {
        result: {
          ok: false,
          installed: [],
          rolled_back: [],
          failure: {
            code: 'validator_rejected',
            message: `packs.install: invalid Records runtime canary — ${canaryIssue}`,
          },
        },
      };
    }
    resolved.splice(canaryIndex, 1);
    authoredRecipeDefs.splice(canaryIndex, 1);
    for (let index = resolved.length - 1; index >= 0; index -= 1) {
      const entry = resolved[index]!;
      const body = entry.recipe?.recipe;
      const ref = plan.contents.find((content): content is Extract<PackContentRef, { type: 'recipe' }> =>
        content.type === 'recipe'
        && content.slug === entry.slug
        && content.version === entry.pinned_version);
      if (body === undefined || ref === undefined) continue;
      const classification = classifyRecordsMigrationRecipe(
        ref,
        body,
        `${manifest.publisher}/${manifest.slug}`,
      );
      if (classification.kind === 'invalid') {
        return {
          result: {
            ok: false,
            installed: [],
            rolled_back: [],
            failure: {
              code: 'validator_rejected',
              message: `packs.install: invalid Records migration '${entry.slug}' — ${classification.issue}`,
            },
          },
        };
      }
      if (classification.kind === 'migration') {
        // The removal walk runs backwards; prepend so immutable artifact and
        // route digests retain the manifest's reviewed recipe order.
        recordsMigrationPlans.unshift(classification.plan);
        resolved.splice(index, 1);
        authoredRecipeDefs.splice(index, 1);
      }
    }
    ready = resolved.every((entry) => entry.recipe !== null && entry.failure == null);
    if (ready) {
      recordsReviewSourceRecipes = resolved.map((entry) => ({
        recipe: entry.recipe!.recipe,
        publisher_id: entry.recipe!.publisher_id,
        version: entry.recipe!.version,
      }));
    }
    const namespace = deps.recordsStore?.getNamespace({
      publisher: manifest.publisher,
      pack_slug: manifest.slug,
    });
    const fromVersion = namespace?.state.state === 'ready'
      ? namespace.state.version
      : namespace?.state.state === 'orphaned'
        ? namespace.state.last_version
        : namespace?.state.state === 'migrating'
          ? namespace.state.from_version
          : undefined;
    if (fromVersion !== undefined && fromVersion !== manifest.version
      && deps.resolveRecordsMigrationArtifacts !== undefined) {
      try {
        recordsMigrationArtifacts = await deps.resolveRecordsMigrationArtifacts({
          owner: { publisher: manifest.publisher, pack_slug: manifest.slug },
          from_version: fromVersion,
          target_version: manifest.version,
        });
      } catch (error) {
        return {
          result: {
            ok: false,
            installed: [],
            rolled_back: [],
            failure: {
              code: 'unresolved',
              message: `packs.install: historical Records route artifacts are unavailable — ${error instanceof Error ? error.message : String(error)}`,
            },
          },
        };
      }
    }
  }

  // A3 (slice 3) + first-party install wiring — resolve any BUNDLED op-step recipe
  // to its concrete vendor-bound form BEFORE the recipe-install transaction
  // persists it. The recipe validator now ACCEPTS op-steps (so they can be
  // authored/published), but `installBulkPackOnServer` would persist them verbatim
  // and the engine can't dispatch an op-step (its safety net rejects them).
  // `resolvePackOpStepRecipes` picks the binding source: the pack's composition
  // (3rd-party / authored — same object provisioned below), OR a BUNDLED vendor
  // catalog the pack references by-ref (first-party HubSpot / Salesforce — looked
  // up in the live registry, the manifest the gateway resolves through). The
  // vendor↔catalog mapping is the static reverse-CATALOG_VENDOR_SLUGS default
  // (3rd-party vendor catalogs resolve once their mapping freezes into the
  // registry — slice 4). Runs regardless of `canProvisionComposition`: even a
  // deferred composition must not leave op-steps unresolved. Fast-path passthrough
  // when no recipe carries an op-step (every v1 recipe-only pack).
  if (ready) {
    const authoredComposition = compositionRefs[0]?.composition as CompositionIngredient | undefined;
    const composition = recordsComposition && authoredComposition !== undefined
      ? {
          ...authoredComposition,
          slug: await recordsCatalogSlug({
            publisher: manifest.publisher,
            pack_slug: manifest.slug,
          }),
        }
      : authoredComposition;
    const recipeDefs = resolved.map((r) => r.recipe!.recipe);
    // D-182 Slice 4 — the Tier-P `pack_ref → catalog` map this pack's recipes'
    // `depends_on` ops resolve against, built from the installed-pack inventory +
    // the live registry. A pure-workflow consumer pack (media-transcribe →
    // recued-core.whisper) resolves its already-installed dependency packs' ops.
    // Empty unless BOTH the inventory store + registry are present (db-less boot);
    // INERT on the current corpus (no two-tier op ids until the Slice-4 rewrite).
    const packOpResolution = installPackOpResolution(deps, manifest);
    const resolvedDefs = resolvePackOpStepRecipes(
      composition,
      plan.contents,
      manifest.slug,
      recipeDefs,
      // The live manifest registry's `get` — the bundled first-party catalog the
      // gateway resolves through. Absent registry (db-less boot) → null → the
      // first-party path fail-closes (never binds an unregistered catalog).
      (slug) => deps.registry?.get(slug) ?? null,
      canProvisionComposition,
      undefined,
      packOpResolution,
      // D-182 Slice 4 — the self pack_ref, so a Tier-P self-ref op
      // (`recued-core.<pack>.<op>` in a recipe that `depends_on` its own pack —
      // the shipped hubspot / salesforce / exa packs) lowers at install against
      // THIS pack's bundled catalog. `packOpResolution` excludes the self-pack
      // (stale-row guard), so the resolver rebuilds the fresh self-binding from
      // the bundled catalog. Same string as the `buildPackOpResolution` exclusion.
      `${manifest.publisher}.${manifest.slug}`,
    );
    if (!resolvedDefs.ok) {
      // ⚠ A pack the recipes call and the install neither finds nor brings in is
      // refused before this, with the packs as data (`missingPacksRefusal`, in
      // `handlePacksInstall`), before anything installs. Reaching here is the
      // backstop: what that check could not tell, and every other refusal the
      // lowering raises.
      return {
        result: {
          ok: false,
          installed: [],
          rolled_back: [],
          failure: { code: 'validator_rejected', message: `packs.install: ${resolvedDefs.message}` },
        },
      };
    }
    for (const w of resolvedDefs.warnings) {
      console.warn(`[d-170.a3] ${manifest.slug}: ${w.code} — ${w.message}`);
    }
    resolved.forEach((entry, i) => {
      const def = resolvedDefs.recipes[i];
      // Only rebuild the entry whose def actually changed (an op-step recipe got
      // rewritten); untouched recipes keep their original object + content hash.
      if (entry.recipe !== null && def !== entry.recipe.recipe) {
        entry.recipe = { ...entry.recipe, recipe: def, recipe_hash: hashRecipe(def) };
      }
    });
  }

  const input: BulkPackInstallInput = {
    // D-165 — forward the real schema version (1 or 2). The parser already
    // rejected anything outside SUPPORTED_BULK_PACK_MANIFEST_VERSIONS, so
    // this is always a value the engine's version gate accepts.
    manifest_version: manifest.manifest_version,
    pack_slug: manifest.slug,
    publisher: manifest.publisher,
    requires: [...manifest.requires],
    recipes: resolved,
    // D-165 app-pack v2 — full normalized content list; the engine reads
    // it only to echo non-recipe contents as `deferred_contents` (v1 packs
    // carry recipe-only contents → empty deferral).
    contents: plan.contents,
    ready,
    ...(manifest.webhook_requirements !== undefined
      ? { webhook_requirements: [...manifest.webhook_requirements] }
      : {}),
    ...(args.webhook_bindings !== undefined
      ? {
          webhook_bindings: args.webhook_bindings
            .filter((selection) => selection.pack_slug === manifest.slug)
            .map((selection) => ({
              binding: selection.binding,
              ingress_id: selection.ingress_id,
            })),
        }
      : {}),
    ...(manifest.mcp_body_visibility_grants !== undefined
      ? { mcp_body_visibility_grants: [...manifest.mcp_body_visibility_grants] }
      : {}),
  };

  // Auto-add `BULK_PACK_INSTALL_PERMISSION` — the rpc invocation itself
  // is the install-action consent (Settings → Packs is the sole writer
  // by the reserved-prefix gate). The manifest's `requires[]` still
  // flow through user consent via the caller-supplied
  // `granted_permissions` array; the engine rejects with
  // `permission_denied` when a required entry is missing.
  const granted = new Set<string>([
    BULK_PACK_INSTALL_PERMISSION,
    ...args.granted_permissions,
  ]);

  // D-299 — each recipe as stored BEFORE this install, so the Reception pairs they back
  // can be carried once the pack is whole (see the carry below the provisioning).
  const receptionPairs = deps.getReceptionPairs?.();
  const recipesBefore = new Map<string, RecipeDefinition | null>(
    resolved.flatMap((entry) => entry.recipe === null
      ? []
      : [[entry.recipe.recipe.recipe_id, deps.recipeStore.get(entry.recipe.recipe.recipe_id)] as const]),
  );
  let recordsAtomic = false;
  let result: BulkPackInstallResultLike;
  if (recordsComposition) {
    if (!ready) {
      result = {
        ok: false,
        installed: [],
        rolled_back: [],
        failure: {
          code: 'unresolved',
          message: 'packs.install: one or more Records pack recipes failed exact resolution',
        },
      };
    } else {
      try {
        const atomic = await installRecordsPackAtomic(
          {
            recipeStore: deps.recipeStore,
            recordsStore: deps.recordsStore!,
            localManifestStore: deps.localManifestStore!,
            contractStore: deps.contractStore!,
            registry: deps.registry!,
            now: () => now,
            applyAudience: (operationIds, sourcePack, selection) =>
              applyInstallAudienceGrantIds(
                {
                  contractStore: deps.contractStore!,
                  ...(deps.sellerStore ? { sellerStore: deps.sellerStore } : {}),
                  ...(deps.inboundTokenStore
                    ? { inboundTokenStore: deps.inboundTokenStore }
                    : {}),
                  now: () => now,
                },
                operationIds,
                sourcePack,
                selection,
              ),
          },
          {
            manifest,
            composition: compositionRefs[0]!.composition as CompositionIngredient,
            verified_publisher: options.verifiedPublisher!,
            recipes: resolved.map((entry) => ({
              recipe: entry.recipe!.recipe,
              publisher_id: entry.recipe!.publisher_id,
              version: entry.recipe!.version,
            })),
            ...(recordsReviewSourceRecipes !== undefined
              ? { review_source_recipes: recordsReviewSourceRecipes }
              : {}),
            migration_plans: recordsMigrationPlans,
            migration_artifacts: recordsMigrationArtifacts,
            by_ref_contents: plan.contents.filter((content) => content.type === 'ingredient'),
            ...(args.install_scope !== undefined ? { install_scope: args.install_scope } : {}),
            ...(options.recordsReviewFence !== undefined
              ? { review_fence: options.recordsReviewFence }
              : {}),
          },
        );
        recordsAtomic = true;
        result = { ok: true, installed: atomic.installed, rolled_back: [] };
      } catch (error) {
        const failure = error instanceof RecordsPackInstallError
          ? error
          : new RecordsPackInstallError(
              'unexpected',
              error instanceof Error ? error.message : String(error),
            );
        result = {
          ok: false,
          installed: [],
          rolled_back: [],
          failure: {
            code: failure.code,
            message: `packs.install: Records atomic install refused — ${failure.message}`,
          },
        };
      }
    }
  } else {
    result = await installBulkPackOnServer(input, granted, {
      recipeStore: deps.recipeStore,
      // ⛔ D-247 D15.1 — carry the owner's chosen ACCESS TIER into the grant
      // seed. Without this the store's mutation hook seeds on `chat_exposed`
      // alone and the dialog's answer is decorative: a pack shipping a
      // `chat_exposed` destructive adapter would be enabled under "Read only".
      // ⚠ Default `read` when no `install_scope` was sent — the pre-D-182
      // callers, and the SAFE floor rather than a permissive guess.
      ...(deps.grantEntryStore
        ? {
            seedRecipeGrants: (recipes) => {
              seedPackRecipeGrants(
                {
                  store: deps.recipeStore,
                  grants: deps.grantEntryStore!,
                  now: () => now,
                  ...(deps.getManifest ? { getManifest: deps.getManifest } : {}),
                },
                recipes,
                args.install_scope?.access ?? 'read',
              );
            },
          }
        : {}),
      ...(deps.webhookConsumerStore
        ? { webhookConsumerStore: deps.webhookConsumerStore }
        : {}),
      ...(deps.webhookDoor ? { webhookDoor: deps.webhookDoor } : {}),
      ...(deps.mcpBodyVisibilityStore
        ? { mcpBodyVisibilityStore: deps.mcpBodyVisibilityStore }
        : {}),
      now,
    });
  }
  if (result.ok && deps.recipeTrustStore !== undefined) {
    const trustedAt = new Date(now).toISOString();
    for (let i = 0; i < resolved.length; i++) {
      const entry = resolved[i];
      const authored = authoredRecipeDefs[i];
      // Classify from the AUTHORED def (op-steps still visible); a non-op-step
      // recipe's authored === resolved, so this is unchanged for every v1 pack.
      if (entry.recipe === null || authored === null || !isPureWorkflowRecipe(authored)) continue;
      await deps.recipeTrustStore.set(
        recipeTrustStateForPureWorkflow(entry.recipe.recipe, () => trustedAt),
      );
    }
  }
  // D-170 (packs.install composition branch) — provision any composition the
  // app_pack carried by value (N.17). Success path only (a rolled-back install
  // provisioned nothing) + only when the substrate is wired. On success the
  // composition is decomposed → local body + UNIFIED `installed_pack` inventory
  // (the provisioner owns the row, listing both the composition catalog and the
  // pack's by-ref ingredients) + the live registry (N.16), then dropped from
  // `deferred_contents` below. The pure validator already ran pre-recipe, so a
  // failure here is a rare state conflict (slug / pack-slug) or store error —
  // the recipes stay installed (ok: true) and the composition is left in
  // `deferred_contents` + logged: a disclosed partial the user resolves + re-runs.
  // True once the composition path has written the UNIFIED `installed_pack` row
  // + provisioned the catalog — drives BOTH the inventory-skip below and the
  // `deferred_contents` filter at the return (the composition is no longer
  // deferred). At most one composition per pack (the early gate rejects more),
  // so this single flag fully describes the composition outcome.
  let compositionProvisioned = recordsAtomic && result.ok;
  if (result.ok && canProvisionComposition && !recordsComposition) {
    // Only by-ref `ingredient` contents become marketplace inventory rows; the
    // composition catalog is recorded by the provisioner with its own kind.
    const byRefContents = plan.contents.filter((c) => c.type === 'ingredient');
    const provisioned = provisionPackCompositionForBulkInstall(
      {
        // Non-null by `canProvisionComposition` (all three checked present).
        localManifestStore: deps.localManifestStore!,
        contractStore: deps.contractStore!,
        registry: deps.registry!,
        now: () => now,
        compiledRecipeStore: deps.recipeStore,
        ...(deps.recipeTrustStore
          ? { recipeTrustStore: deps.recipeTrustStore }
          : {}),
        // D-170 gap #2 live-reconcile — seed the composition's bound connection
        // profile post-commit so a connect-before-install dispatch works at once.
        ...(deps.reconcileConnectionProfile
          ? { reconcileConnectionProfile: deps.reconcileConnectionProfile }
          : {}),
        // D-192 — same moment: register the bound connection's pack-declared
        // work-entity Sources (enroll-before-install).
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
      byRefContents,
      // D-182 §7.1 — forward the install dialog's grant selection. Absent ⇒ the
      // provisioner fails closed (authored read/`ask` defaults only); the silent
      // derived read-tier auto-grant is gone.
      args.install_scope,
      // D-194 2b — forward the owner's chosen connection so the grant + binding
      // re-source to it (step 3a). Absent ⇒ the authored `auth.connection` literal.
      args.chosen_connection,
    );
    if (provisioned.ok) {
      compositionProvisioned = true;
    } else {
      console.warn(
        `[d-170] composition provisioning failed for pack ${JSON.stringify(manifest.slug)}: ${provisioned.code} — ${provisioned.message}`,
      );
    }
  }

  // D-165 P3.1 — record install inventory (installed_pack +
  // installed_ingredient) so the contract store reflects what landed.
  // Success path only (a rolled-back install provisioned nothing).
  // Best-effort: the recipes are already committed, so a contract-store
  // hiccup must not flip the user's successful install to a failure —
  // log + swallow (matches the broadcast emit's swallow stance). Uses
  // `plan.contents` (version-normalized) + `manifest.version`.
  //
  // SKIPPED whenever we OWN the composition (`canProvisionComposition`) — the
  // composition provisioner is then the sole `installed_pack` writer for this
  // slug. Keying off provision *success* would be wrong: a post-recipe provision
  // FAILURE (rare slug/store conflict) must NOT fall through to this generic
  // write, which records `plan.contents` (composition ignored) and would OVERWRITE
  // a prior unified row — dropping the composition catalog from `ingredient_ids`
  // while its body/registry entry linger. On failure the composition is left
  // deferred + logged and any prior unified row is preserved intact.
  if (result.ok && deps.contractStore && !canProvisionComposition) {
    try {
      recordPackInventory(deps.contractStore, {
        pack_slug: manifest.slug,
        publisher: manifest.publisher,
        pack_version: manifest.version,
        contents: plan.contents,
        installed_at: now,
      });
    } catch (e) {
      console.warn(
        `[d-165.p3.1] failed to record install inventory for pack ${JSON.stringify(manifest.slug)}: ${(e as Error).message ?? String(e)}`,
      );
    }
  }

  // D-220 Slice B — persist the pack's shipped intake templates, replace-clean
  // per pack (a re-install drops what the new manifest no longer ships). Runs on
  // the success path for EVERY pack kind — including a Records pack, whose
  // `installed_pack` row the coordinator owns under its catalog id — because
  // the template row is keyed by the AUTHORED slug: the identity the ref
  // carries and the uninstall rpc receives. Best-effort like the inventory
  // write above: the recipes are committed, so a bookkeeping failure logs
  // rather than flipping the install to a failure. `templatesPersisted` drives
  // the `deferred_contents` filter at the return — a persisted template is not
  // a deferred capability, and an echo of it would read as a silent drop.
  const templateContents = plan.contents.filter(isReceptionTemplateContent);
  // A Records pack's templates were written INSIDE the coordinator's atomic
  // transaction (`installRecordsPackAtomic`); a refused write fails that install
  // as a whole, so `recordsAtomic && result.ok` already means "persisted".
  let templatesPersisted = recordsAtomic && result.ok;
  if (result.ok && deps.contractStore && !recordsAtomic) {
    const templates = templateContents.map((c) => c.template);
    try {
      recordPackReceptionTemplates(deps.contractStore, {
        pack_slug: manifest.slug,
        publisher: manifest.publisher,
        pack_name: manifest.name,
        pack_version: manifest.version,
        templates,
        installed_at: now,
      });
      templatesPersisted = true;
    } catch (e) {
      console.warn(
        `[d-220.b] failed to persist reception templates for pack ${JSON.stringify(manifest.slug)}: ${(e as Error).message ?? String(e)}`,
      );
    }
  }

  // D-289 — pack-shipped saved Data views. AFTER the install succeeded, and
  // best-effort: a view is a convenience surface, not a capability, so a
  // failure here must not fail a pack whose recipes and grants all landed.
  // The sync is idempotent and in-place, so the next install repairs it.
  const savedViewStore = deps.getSavedDataViewStore?.();
  if (result.ok && savedViewStore) {
    const declared = packSavedViewsFrom(plan.contents);
    const ref = { publisher: manifest.publisher, slug: manifest.slug };
    try {
      savedViewStore.syncPackViews(ref, declared.map((c) => ({
        id: packSavedViewId(ref, c.name), name: c.name, definition: c.definition,
      })));
    } catch (e) {
      console.warn(
        `[d-289] failed to sync saved views for pack ${JSON.stringify(manifest.slug)}: `
          + ((e as Error).message ?? String(e)),
      );
    }
  }

  // D-196 R6 — recipe tools are grantable even when the pack carries no
  // composition. Apply the same install checklist to their authoritative
  // `<publisher>/<recipe_id>` names. A successfully provisioned composition
  // already performed this source pack's replace-clean, so append recipes to
  // that set; a recipe-only pack owns the replace itself. If composition
  // provisioning failed, preserve its prior pack-owned rows and skip this
  // partial audience rewrite (fail closed, never silently drop old authority).
  if (
    result.ok
    && deps.contractStore
    && !recordsComposition
    && args.install_scope !== undefined
    && (compositionRefs.length === 0 || compositionProvisioned)
  ) {
    try {
      applyInstallAudienceGrantIds(
        {
          contractStore: deps.contractStore,
          ...(deps.sellerStore ? { sellerStore: deps.sellerStore } : {}),
          ...(deps.inboundTokenStore ? { inboundTokenStore: deps.inboundTokenStore } : {}),
          now: () => now,
        },
        result.installed.map((entry) => `${entry.publisher_id}/${entry.slug}`),
        manifest.slug,
        args.install_scope,
        !compositionProvisioned,
      );
    } catch (e) {
      console.warn(
        `[d-196.r6] failed to apply install audience for pack ${JSON.stringify(manifest.slug)}: ${(e as Error).message ?? String(e)}`,
      );
    }
  }
  // ⛔ D-299 — carry the Reception pairs once the pack is WHOLE: its recipes committed and
  // its composition in the registry. The door check reads each operation's risk and kind
  // from the live registry, and this used to run inside `installBulkPackOnServer`, before
  // `provisionPackCompositionForBulkInstall`, so an update that widened an operation was
  // judged by its old risk: the pair was re-pinned behind a door that no longer covered
  // it, looked alive, and failed at the next submission (2026-09-24 audit). A Records pack
  // is whole when its atomic install returns. If a composition could not be provisioned,
  // nothing is carried: the pairs stay stale for the owner rather than be judged against
  // operations that are not live.
  if (result.ok && receptionPairs && (compositionRefs.length === 0 || compositionProvisioned)) {
    carryReceptionPairsAfterInstall(recipesBefore, deps.recipeStore, receptionPairs, manifest.slug);
  }

  // D-145 PA10 follow-on — fan the success outcome out to every
  // paired client subscribed to `pack_installed`. Drives the Settings
  // → Packs panel's live refresh on sibling devices / tabs without
  // polling. `ok: false` paths (permission_denied / version_mismatch
  // / unresolved / validator_rejected / unexpected) skip the emit —
  // a refresh that re-renders the same list state is wasted work.
  // The emit count is the engine's `fresh_install: true` subset of
  // `installed[]`; an idempotent re-install where every slug was
  // already at the same version still counts as `ok: true` but
  // contributes zero rows.
  if (result.ok && deps.broadcast) {
    try {
      const freshCount = result.installed.filter(
        (entry) => entry.fresh_install,
      ).length;
      deps.broadcast.emit({
        kind: 'pack_installed',
        pack_slug: manifest.slug,
        pack_name: manifest.name,
        pack_version: manifest.version,
        installed_recipe_count: freshCount,
      });
    } catch {
      /* best-effort — bus emit failures never abort the rpc result */
    }
  }

  // R2 build step 4c.4 — a successful install adds recipes (and provisions their
  // grants / connection above), any of which can move runnability; recompute +
  // broadcast the fresh snapshot. Best-effort (the broadcaster swallows), only on
  // a committed install, AFTER all provisioning (recipes + composition grants +
  // the profile reconcile) so the recompute reads correct state.
  if (result.ok) deps.recipeRunnabilityBroadcast?.recomputeAndEmit();

  // R2 build step 4c.2 — "born blocked / degraded" install disclosure (recipe-
  // identity doc §1.6: install discloses "born blocked — add a provider"). After all
  // provisioning (recipes + composition grants + profile reconcile), read the full
  // runnability snapshot ONCE and partition THIS pack's just-installed recipes by
  // status. Scoped to the recipes the install resolved (`result.installed`), so the
  // disclosure names only the pack the user installed — never an unrelated blocked
  // recipe already in the store. NOTE: NOT scoped to `fresh_install` — pack recipes
  // resolve via `getBundled`, so the engine always finds a bundled prior and reports
  // `fresh_install: false` (a rollback semantic, not a "user already had this"
  // signal); a fresh-only filter would leave the disclosure permanently empty. The
  // install entry's `slug` IS the recipe_id (the engine echoes `row.recipe_id`, and
  // `ok: true` ⇒ every entry resolved), so it keys the snapshot directly. Best-
  // effort: a disclosure-compute failure must never fail the already-committed
  // install — swallow + omit the fields (mirrors the broadcast + inventory swallow).
  const born_blocked: RecipeRunnabilityEntry[] = [];
  const born_degraded: RecipeRunnabilityEntry[] = [];
  if (result.ok && deps.computeRunnability) {
    try {
      const installedIds = new Set(result.installed.map((e) => e.slug));
      if (installedIds.size > 0) {
        for (const entry of deps.computeRunnability()) {
          if (!installedIds.has(entry.recipe_id)) continue;
          if (entry.status === 'blocked') born_blocked.push(entry);
          else if (entry.status === 'degraded') born_degraded.push(entry);
        }
      }
    } catch {
      /* best-effort — a runnability read failure never aborts the install result */
    }
  }
  // § 7 surfacing slice — per-recipe PII posture disclosure. Assessed on the
  // RESOLVED defs (post-A3 — the concrete shape that was persisted and that
  // the dispatch seam will trace), with the same canonical classifier the
  // seam rewrites with. Success-path + non-empty only, best-effort: the
  // assessor is fail-safe (null on throw / nothing to disclose), so a
  // surprise here can only shrink the disclosure, never fail the install.
  const pii_disclosure: RecipePiiDisclosureEntry[] = [];
  if (result.ok) {
    for (const entry of resolved) {
      if (entry.recipe === null) continue;
      const summary = assessRecipePiiPosture(entry.recipe.recipe);
      if (summary !== null) {
        pii_disclosure.push({ recipe_id: entry.recipe.recipe_id, summary });
      }
    }
  }

  // Non-empty only — omitted otherwise, matching `deferred_contents`' rule.
  const bornDisclosure = {
    ...(born_blocked.length > 0 ? { born_blocked } : {}),
    ...(born_degraded.length > 0 ? { born_degraded } : {}),
    ...(pii_disclosure.length > 0 ? { pii_disclosure } : {}),
  };

  // D-170 (packs.install composition branch) — finalize `deferred_contents`: drop
  // the provisioned composition itself (its catalog IS provisioned, so it is no
  // longer deferred). The composition's declared `grant_defaults` are no longer
  // appended here: D-165 P3 now WRITES them as pack-owned `contract.grant` rows in
  // `provisionPackCompositionForBulkInstall`, so they are provisioned, not deferred.
  // When nothing remains the field is omitted (matching the engine's non-empty rule).
  // D-220 Slice B — a persisted `reception_template` is provisioned content too,
  // dropped from the echo on the same rule as the composition.
  const provisionedKinds = new Set<string>([
    ...(compositionProvisioned ? ['composition'] : []),
    ...(templatesPersisted ? ['reception_template'] : []),
  ]);
  // D-220 Slice B (audit) — a template the store did NOT take (the write threw,
  // or there is no store) is DISCLOSED, not just logged. The ordinary path's
  // engine echo already lists it; the Records path never initialises
  // `deferred_contents`, so a failed write there would otherwise vanish from
  // the result while the install reports success. Added once, by ref.
  const undisclosedTemplates = result.ok && !templatesPersisted
    ? templateContents.filter((t) => !(result.deferred_contents ?? []).some((c) =>
        c.type === 'reception_template' && c.template.template_ref === t.template.template_ref))
    : [];
  if (result.ok && (provisionedKinds.size > 0 || undisclosedTemplates.length > 0)) {
    const remaining = [
      ...(result.deferred_contents ?? []).filter((c) => !provisionedKinds.has(c.type)),
      ...undisclosedTemplates,
    ];
    return {
      result: {
        ok: result.ok,
        installed: result.installed,
        rolled_back: result.rolled_back,
        ...(remaining.length > 0 ? { deferred_contents: remaining } : {}),
        ...bornDisclosure,
      },
    };
  }

  return { result: { ...result, ...bornDisclosure } };
};

const handlePacksInstallInternal = async (
  deps: PackInstallRpcDeps,
  args: PacksInstallArgs,
  context: InternalInstallContext,
  verifiedPublisher?: string,
  recordsReviewFence?: RecordsUpdateReviewFence,
): Promise<InternalInstallOutcome> => {
  const { manifest } = parsePacksInstallArgs(args);
  const ownRecipeKeys = declaredRecipeKeys(manifest);
  const cachedKeys = context.recipeKeysByPack.get(manifest.slug);
  if (context.installed.has(manifest.slug) && cachedKeys !== undefined) {
    return { result: emptySuccess(), recipeKeys: cachedKeys };
  }
  if (context.visiting.has(manifest.slug)) {
    return {
      result: {
        ok: false,
        installed: [],
        rolled_back: [],
        failure: {
          code: 'unresolved',
          message: `packs.install: cyclic pack dependency involving ${JSON.stringify(manifest.slug)}`,
        },
      },
      recipeKeys: ownRecipeKeys,
    };
  }

  context.visiting.add(manifest.slug);
  const resolveDependency = dependencyManifestResolver(deps);
  const dependencyResults: BulkPackInstallResultLike[] = [];
  const dependencyRecipeKeys = new Set<string>();

  for (const dependency of manifest.dependencies ?? []) {
    if (dependency.type !== 'pack') continue;
    const dependencyManifest = resolveDependency(dependency.slug);
    if (dependencyManifest === null) {
      context.visiting.delete(manifest.slug);
      return {
        result: {
          ok: false,
          installed: dependencyResults.flatMap((r) => r.installed),
          rolled_back: dependencyResults.flatMap((r) => r.rolled_back),
          failure: {
            code: 'unresolved',
            message:
              `packs.install: dependency pack ${JSON.stringify(dependency.slug)} ` +
              `declared by ${JSON.stringify(manifest.slug)} was not found in bundled packs`,
          },
        },
        recipeKeys: new Set([...dependencyRecipeKeys, ...ownRecipeKeys]),
      };
    }
    if (dependency.min_version !== undefined && dependencyManifest.version < dependency.min_version) {
      context.visiting.delete(manifest.slug);
      return {
        result: {
          ok: false,
          installed: dependencyResults.flatMap((r) => r.installed),
          rolled_back: dependencyResults.flatMap((r) => r.rolled_back),
          failure: {
            code: 'version_mismatch',
            message:
              `packs.install: dependency pack ${JSON.stringify(dependency.slug)} ` +
              `is version ${dependencyManifest.version}, below required ${dependency.min_version}`,
          },
        },
        recipeKeys: new Set([...dependencyRecipeKeys, ...ownRecipeKeys]),
      };
    }

    // ⛔⛔⛔ A SATISFIED REQUIREMENT IS NOT RE-INSTALLED — the clobber fix. See
    // `dependencyAlreadySatisfied`: the recursion below forwards no
    // `chosen_connection`, and an `install_scope` only for a pack the dialog asked
    // about (D-310 asks only for one not yet installed), so reinstalling a pack
    // the owner already has REPLACES the `install_scope` and `chosen_connection`
    // they picked at its own install with authored defaults.
    //
    // ⚠ THE RECIPE KEYS STILL HAVE TO BE CONTRIBUTED. `omitRecipeKeys` is how the
    // parent avoids re-writing a recipe a dependency owns; dropping the skipped
    // pack's keys would let the parent claim ownership of rows that already
    // belong to it, which is the same silent-relabel this dedup exists to stop.
    // The keys are a property of the MANIFEST, not of having just installed it.
    if (dependencyAlreadySatisfied(deps.contractStore, dependency)) {
      for (const key of declaredRecipeKeys(dependencyManifest)) dependencyRecipeKeys.add(key);
      continue;
    }

    // D-310 — the owner's Access choice for THIS pack, from the install dialog's
    // list of the packs it brings in. Absent ⇒ its authored defaults, as before.
    // The whole list travels down, so a dependency's own dependencies find theirs.
    const dependencyScope = args.dependency_install_scopes
      ?.find((entry) => entry.pack_slug === dependency.slug)?.install_scope;
    const dependencyOutcome = await handlePacksInstallInternal(
      deps,
      {
        manifest: dependencyManifest,
        granted_permissions: args.granted_permissions,
        ...(dependencyScope !== undefined ? { install_scope: dependencyScope } : {}),
        ...(args.webhook_bindings !== undefined
          ? { webhook_bindings: args.webhook_bindings }
          : {}),
        ...(args.dependency_install_scopes !== undefined
          ? { dependency_install_scopes: args.dependency_install_scopes }
          : {}),
      },
      context,
      dependencyManifest.publisher,
    );
    for (const key of dependencyOutcome.recipeKeys) dependencyRecipeKeys.add(key);
    if (!dependencyOutcome.result.ok) {
      context.visiting.delete(manifest.slug);
      return {
        result: dependencyFailureResult(dependency.slug, dependencyOutcome.result, dependencyResults),
        recipeKeys: new Set([...dependencyRecipeKeys, ...ownRecipeKeys]),
      };
    }
    dependencyResults.push(dependencyOutcome.result);
  }

  const ownInstall = await installSinglePack(deps, args, {
    omitRecipeKeys: dependencyRecipeKeys,
    ...(verifiedPublisher !== undefined ? { verifiedPublisher } : {}),
    ...(recordsReviewFence !== undefined ? { recordsReviewFence } : {}),
  });
  context.visiting.delete(manifest.slug);
  if (!ownInstall.result.ok) {
    const prior = mergeSuccessResults(dependencyResults);
    const failure = ownInstall.result.failure ?? {
      code: 'unexpected' as const,
      message: 'pack install failed without a failure payload',
    };
    return {
      result: dependencyResults.length > 0
        ? {
            ok: false,
            installed: [...prior.installed, ...ownInstall.result.installed],
            rolled_back: [...prior.rolled_back, ...ownInstall.result.rolled_back],
            failure: {
              ...failure,
              message:
                `requested pack ${JSON.stringify(manifest.slug)} failed after dependency install: ` +
                failure.message,
            },
          }
        : ownInstall.result,
      recipeKeys: new Set([...dependencyRecipeKeys, ...ownRecipeKeys]),
    };
  }

  const allRecipeKeys = new Set([...dependencyRecipeKeys, ...ownRecipeKeys]);
  context.installed.add(manifest.slug);
  context.recipeKeysByPack.set(manifest.slug, allRecipeKeys);
  return {
    result: mergeSuccessResults([...dependencyResults, ownInstall.result]),
    recipeKeys: allRecipeKeys,
  };
};

/** A pack's webhook bindings as they are now: binding → ingress id. */
const currentWebhookBindings = (
  deps: Pick<PackInstallRpcDeps, 'webhookConsumerStore'>,
  packSlug: string,
): Map<string, string> =>
  new Map((deps.webhookConsumerStore?.listBindings({ consumer_kind: 'pack_install', consumer_id: packSlug }) ?? [])
    .map((binding) => [binding.logical_binding, binding.ingress_id]));

/** The packs an install of `manifest` will touch — itself and every dependency
 *  it will install — by the SAME walk the install's preflight runs, so what is
 *  asked about is exactly what the install will demand. `null` when the walk
 *  itself fails (the install reports that). */
const installTouchedManifests = (
  deps: PackInstallRpcDeps,
  manifest: BulkPackManifest,
): BulkPackManifest[] | null => {
  const manifestsBySlug = new Map<string, BulkPackManifest>();
  const failure = collectTransitivePackRequirements(
    manifest,
    dependencyManifestResolver(deps),
    new Set(manifest.requires),
    new Set(),
    new Set(),
    manifestsBySlug,
    deps.contractStore,
  );
  return failure === null ? [...manifestsBySlug.values()] : null;
};

/** D-296 — every recipe an install of `manifest` writes, as it will be: the
 *  pack's and those of each dependency it installs (the same walk), each under
 *  the publisher it installs as. */
const installIncomingRecipes = async (
  deps: PackInstallRpcDeps,
  manifest: BulkPackManifest,
): Promise<Array<{ recipe_id: string; publisher_id: string; definition: RecipeDefinition }>> => {
  const out: Array<{ recipe_id: string; publisher_id: string; definition: RecipeDefinition }> = [];
  for (const touched of installTouchedManifests(deps, manifest) ?? [manifest]) {
    for (const entry of await resolvePackRecipeBodies(normalizeBulkPackInstallPlan(touched), touched.publisher, deps)) {
      if (entry.recipe === null) continue;
      out.push({ recipe_id: entry.recipe.recipe_id, publisher_id: entry.recipe.publisher_id, definition: entry.recipe.recipe });
    }
  }
  return out;
};

/** D-310 — one pack an install brings in with it, as the install dialog lists it.
 *  The wire shape of `packs.install_preview` `dependency_packs`. */
export interface InstallDependencyPack {
  pack_slug: string;
  name: string;
  needed_by: string[];
  updates?: true;
  access_options: InstallAccessTier[];
  needs?: { access: 'write' | 'all'; by: string[] };
  /** D-310 REV 2 — the tier its OWN workflows need from its own Access, when
   *  above Read. `needs` covers only the other packs of the install. */
  own_needs?: 'write' | 'all';
}

/** D-310 REV 2 — what an install's Access choices must cover: the packs it brings
 *  in, and the tier the installing pack's own workflows need from its own Access. */
export interface InstallAccessNeeds {
  dependency_packs: InstallDependencyPack[];
  own_needs?: 'write' | 'all';
}

const accessTierForRisk = (rank: number): 'write' | 'all' => (rank >= RISK_RANK.admin ? 'all' : 'write');

/** D-310 — the packs an install of `manifest` brings in with it, each with the
 *  Access tiers its own dialog offers and what the other packs of the install
 *  need from it.
 *
 *  ⛔ A BUNDLED PACK WAS INSTALLED AT ITS AUTHORED READ DEFAULTS, whatever the
 *  owner chose for the pack that brought it (the recursion forwarded no
 *  `install_scope`). Driven live: Month-end closer brought Ledger book in
 *  read-only, and opening an account, the statement import and every booking
 *  were refused `operation_not_granted` — reported as "Run returned errors", on
 *  a pack no screen could re-grant.
 *
 *  🔑 The same walk the install takes (`installTouchedManifests`, which skips a
 *  dependency already installed at the version needed), the same recipe
 *  resolver, and for each pack the same tiers its own dialog would offer
 *  (`buildPackInstallPreview` → `installGrantableOps` → `installAccessOptions`).
 *  `needs` joins the Tier-P op ids the other packs' recipes name to the row that
 *  declares each (`buildPackOperationIndex`, the Recipes detail's join) and
 *  keeps the highest declared risk above read. `undefined` when the walk fails;
 *  the install says why. */
export const dependencyPacksFor = async (
  deps: PackInstallRpcDeps,
  manifest: BulkPackManifest,
): Promise<InstallDependencyPack[] | undefined> =>
  (await installAccessNeedsFor(deps, manifest))?.dependency_packs;

/** D-310 REV 2 — the same walk, also answering what each pack's OWN workflows
 *  need from its own Access.
 *
 *  ⛔ D-310 left a pack's use of its own operations to "its own dialog", and no
 *  dialog said it. The Access tier governs the owner's own runs too
 *  (`install-grant-picker.ts`: a Records pack installed at Read has its own write
 *  recipes refused when YOU run them), yet the pack's own picker suggested Read,
 *  and a pack brought in was listed at Read with no word. Seller Quote Request,
 *  brought in by Seller Quote Payment Events, is the case that showed it: its own
 *  workflows open and price requests (`quote_request.create` / `.update`, both
 *  write), and nothing on screen asked for Read + write.
 *
 *  🔑 The same join as `needs`, on the pack's OWN composition rows, counting only
 *  a row its Access actually grants (`installGrantableOps`: not a local tool's).
 *
 *  ⛔ AND `needs` COUNTS ONLY SUCH A ROW TOO (2026-09-26). It counted every row
 *  another pack of the install calls, so a local tool brought in was listed with
 *  "OCRmyPDF Pack adds and changes things in it. Choose Read + write, or those
 *  steps will be refused." That was untrue both ways: a `cli` operation is
 *  authorized by the tools dialog's reachability grant, whatever the tool's Access
 *  (`execute-handler.ts`, `cliReachabilityResolver`), so Read + write would not
 *  help and Read only would not refuse. It showed once OCRmyPDF brought in
 *  pdftotext, which its notes workflow calls. */
export const installAccessNeedsFor = async (
  deps: PackInstallRpcDeps,
  manifest: BulkPackManifest,
): Promise<InstallAccessNeeds | undefined> => {
  const touched = installTouchedManifests(deps, manifest);
  if (touched === null) return undefined;
  const brought = touched.filter((pack) => pack.slug !== manifest.slug);
  const index = buildPackOperationIndex(touched.map((pack) => ({
    slug: pack.slug, publisher: pack.publisher, name: pack.name, manifest: pack,
  })));
  const needs = new Map<string, { rank: number; by: Set<string> }>();
  const ownNeeds = new Map<string, number>();
  // What each pack's Access choice grants: a row outside it needs nothing from that choice.
  const grantableBySlug = new Map(touched.map((pack) =>
    [pack.slug, new Set(installGrantableOps(pack).map((op) => op.id))] as const));
  for (const pack of touched) {
    for (const entry of await resolvePackRecipeBodies(normalizeBulkPackInstallPlan(pack), pack.publisher, deps)) {
      if (entry.recipe === null) continue;
      for (const opId of recipeOpIds(entry.recipe.recipe)) {
        const target = index.byOpId.get(opId);
        if (target === undefined) continue;
        const rank = RISK_RANK[target.row.risk];
        if (rank === undefined || rank === 0) continue;
        if (grantableBySlug.get(target.pack.slug)?.has(target.row.op) !== true) continue;
        if (target.pack.slug === pack.slug) {
          ownNeeds.set(pack.slug, Math.max(ownNeeds.get(pack.slug) ?? 0, rank));
          continue;
        }
        const need = needs.get(target.pack.slug) ?? { rank: 0, by: new Set<string>() };
        need.rank = Math.max(need.rank, rank);
        need.by.add(pack.name);
        needs.set(target.pack.slug, need);
      }
    }
  }
  const out: InstallDependencyPack[] = [];
  for (const pack of brought) {
    const preview = await buildPackInstallPreview(pack, {
      recipeStore: deps.recipeStore,
      ...(deps.resolveMarketplaceRecipe ? { resolveMarketplaceRecipe: deps.resolveMarketplaceRecipe } : {}),
      getManifest: (slug: string) => deps.getManifest?.(slug),
    });
    const recipeRisk = preview.resolved
      ? new Map(preview.will_enable.map((r) => [r.recipe_id, r.top_risk ?? 'read' as const]))
      : undefined;
    const need = needs.get(pack.slug);
    const installed = deps.contractStore !== undefined
      && findInstalledPackByAuthoredSlug(deps.contractStore, pack.slug) !== null;
    out.push({
      pack_slug: pack.slug,
      name: pack.name,
      needed_by: touched
        .filter((other) => (other.dependencies ?? [])
          .some((dependency) => dependency.type === 'pack' && dependency.slug === pack.slug))
        .map((other) => other.name),
      ...(installed ? { updates: true as const } : {}),
      access_options: installAccessOptions(installGrantableOps(pack, recipeRisk)),
      ...(need !== undefined
        ? { needs: { access: accessTierForRisk(need.rank), by: [...need.by].sort() } }
        : {}),
      ...(ownNeeds.has(pack.slug) ? { own_needs: accessTierForRisk(ownNeeds.get(pack.slug)!) } : {}),
    });
  }
  const own = ownNeeds.get(manifest.slug);
  return { dependency_packs: out, ...(own !== undefined ? { own_needs: accessTierForRisk(own) } : {}) };
};

/** One pack an install needs and neither finds installed nor brings in, as
 *  `packs.install_preview` `missing_packs` lists it. */
export interface InstallMissingPack {
  /** `<publisher>.<pack>`, as the recipes' operations name it. */
  pack_ref: string;
  /** The packs of this install whose recipes call it, by name. */
  needed_by: string[];
  /** What the pack is called, where the preview could tell (`nameMissingPacks`). */
  name?: string;
}

/** The packs an install of `manifest` would be refused for: called by its recipes,
 *  or by those of a pack it brings in, and neither installed nor brought in.
 *
 *  ⛔ THE INSTALL REFUSED THEM ONLY AFTER EVERY CHOICE WAS MADE ("step 'x' uses the
 *  recued-core.federated-projects pack, which is not installed"), and the dialog
 *  could not offer them. Seven shipped meeting packs call Federated Projects
 *  without bringing it in, on purpose: the owner installs it deliberately, as their
 *  entry point.
 *
 *  🔑 The install's own reading throughout: its walk (`installTouchedManifests`),
 *  its recipe bodies, the lowering's view of a step (`unboundPackRefs`), and the
 *  installed packs it binds (`installPackOpResolution`). A pack the install brings
 *  in counts as there, since the recursion installs it first. `undefined` when
 *  that cannot be told: no inventory, or a walk that fails (the install says why). */
export const installMissingPacksFor = async (
  deps: PackInstallRpcDeps,
  manifest: BulkPackManifest,
): Promise<InstallMissingPack[] | undefined> => {
  const resolution = installPackOpResolution(deps, manifest);
  if (resolution === undefined) return undefined;
  const touched = installTouchedManifests(deps, manifest);
  if (touched === null) return undefined;
  const bound = packsBoundFor(resolution, new Set(touched.map((pack) => `${pack.publisher}.${pack.slug}`)));
  const missing = new Map<string, Set<string>>();
  for (const pack of touched) {
    for (const entry of await resolvePackRecipeBodies(normalizeBulkPackInstallPlan(pack), pack.publisher, deps)) {
      if (entry.recipe === null) continue;
      for (const packRef of unboundPackRefs(entry.recipe.recipe, bound)) {
        const neededBy = missing.get(packRef) ?? new Set<string>();
        neededBy.add(pack.name);
        missing.set(packRef, neededBy);
      }
    }
  }
  return [...missing].map(([pack_ref, neededBy]) => ({ pack_ref, needed_by: [...neededBy] }));
};

/** The name each missing pack goes by, for the dialog to offer it by: the
 *  server's own copy, else the marketplace's (`fetchFn`, a marketplace preview's),
 *  fetched UNMARKED since a preview installs nothing. A copy counts only when it
 *  names the same slug and the same publisher, or it is not the pack the recipes
 *  call. One that cannot be found keeps no name, and the dialog shows its slug. */
export const nameMissingPacks = async (
  deps: Pick<PackInstallRpcDeps, 'packDir' | 'resolveDependencyManifest'>,
  missing: readonly InstallMissingPack[],
  fetchFn: typeof globalThis.fetch | undefined,
): Promise<InstallMissingPack[]> => {
  const resolve = dependencyManifestResolver(deps);
  return mapBounded(missing, MARKETPLACE_FETCH_CONCURRENCY, async (pack) => {
    const dot = pack.pack_ref.indexOf('.');
    const publisher = pack.pack_ref.slice(0, dot);
    const slug = pack.pack_ref.slice(dot + 1);
    let manifest = resolve(slug);
    if (manifest === null && fetchFn !== undefined) {
      manifest = await fetchBulkPackBySlug(slug, fetchFn, { install: false }).catch(() => null);
    }
    return manifest !== null && manifest.slug === slug && manifest.publisher === publisher
      ? { ...pack, name: manifest.name }
      : pack;
  });
};

/** "a", "a and b", "a, b and c". */
const joinNames = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The refusal for an install that needs packs it neither finds installed nor
 *  brings in, all of them, in the words the dialog shows after "Recued did not
 *  install it: …", with the packs as data for its offer. */
export const missingPacksRefusal = (
  missing: readonly InstallMissingPack[],
): BulkPackInstallResultLike => {
  const needers = [...new Set(missing.flatMap((pack) => pack.needed_by))];
  const one = missing.length === 1;
  const packs = `${joinNames(missing.map((pack) => pack.pack_ref))} ${one ? 'pack' : 'packs'}`;
  return {
    ok: false,
    installed: [],
    rolled_back: [],
    failure: {
      code: 'validator_rejected',
      message:
        `packs.install: ${joinNames(needers)} ${needers.length === 1 ? 'needs' : 'need'} the ${packs}, `
        + `which ${one ? 'is' : 'are'} not installed, and this install does not bring ${one ? 'it' : 'them'} `
        + `in. Install ${one ? 'that pack' : 'those packs'}, then try again.`,
      missing_packs: missing.map((pack) => pack.pack_ref),
    },
  };
};

/** ⛔ D-295 — AN UPDATE THAT BRINGS NO WEBHOOK CHOICE KEEPS THE WEBHOOKS THE PACK
 *  USES NOW. The install requires one owner-selected webhook per binding and
 *  refused a call carrying none — a dependency re-install, an rpc caller —
 *  though the choice is on record (the pack's consumer bindings). Only a
 *  binding that HAS a current webhook is filled: one the update adds still
 *  needs the owner's choice. A caller that sends its own choices is never
 *  second-guessed. */
const carryOverWebhookBindings = (
  deps: PackInstallRpcDeps,
  args: PacksInstallArgs,
  manifest: BulkPackManifest,
): PacksInstallArgs => {
  if (args.webhook_bindings !== undefined || deps.webhookConsumerStore === undefined) return args;
  const carried: NonNullable<PacksInstallArgs['webhook_bindings']>[number][] = [];
  for (const touched of installTouchedManifests(deps, manifest) ?? []) {
    const current = currentWebhookBindings(deps, touched.slug);
    for (const requirement of touched.webhook_requirements ?? []) {
      const ingressId = current.get(requirement.binding);
      if (ingressId !== undefined) {
        carried.push({ pack_slug: touched.slug, binding: requirement.binding, ingress_id: ingressId });
      }
    }
  }
  return carried.length > 0 ? { ...args, webhook_bindings: carried } : args;
};

/** D-295 — the webhooks the install dialog has the owner choose: per binding of
 *  every pack the install will touch, the owner's webhooks that fit and the one
 *  in use now (`planPackWebhookBindings`). `undefined` when this server cannot
 *  say (no webhook store) or the walk fails; `[]` when none are needed. */
const webhookPlanFor = async (
  deps: PackInstallRpcDeps,
  manifest: BulkPackManifest,
): Promise<PackWebhookPlanEntry[] | undefined> => {
  if (deps.webhookIngressStore === undefined) return undefined;
  const touched = installTouchedManifests(deps, manifest);
  if (touched === null) return undefined;
  const listening = touched.filter((pack) => (pack.webhook_requirements?.length ?? 0) > 0);
  if (listening.length === 0) return [];
  const triggers = new Map<string, RecipeWebhookTrigger[]>();
  for (const pack of listening) {
    const recipes = await resolvePackRecipeBodies(normalizeBulkPackInstallPlan(pack), pack.publisher, deps);
    triggers.set(pack.slug, recipes.flatMap((entry) => entry.recipe?.recipe.webhook_triggers ?? []));
  }
  return planPackWebhookBindings({
    manifests: listening,
    triggersFor: (slug) => triggers.get(slug) ?? [],
    ingresses: deps.webhookIngressStore.list(),
    currentFor: (slug) => currentWebhookBindings(deps, slug),
  });
};

export const handlePacksInstall = async (
  deps: PackInstallRpcDeps,
  requestArgs: PacksInstallArgs,
  verifiedPublisher?: string,
  prevalidatedRecordsReview?: {
    fence?: RecordsUpdateReviewFence;
  },
): Promise<{ result: BulkPackInstallResultLike }> => {
  const { manifest } = parsePacksInstallArgs(requestArgs);
  const args = carryOverWebhookBindings(deps, requestArgs, manifest);
  // Owner ruling 2026-09-07 — a core feature is installed by the server, never
  // by the owner. Checked on the SUBMITTED manifest because this rpc takes the
  // manifest by value: refusing only what the roster offers would leave the
  // by-value door open. The boot wire does not come through here (it calls
  // `installBulkPackOnServer` directly), so this cannot starve a core pack.
  if (isCoreFeaturePack(manifest)) {
    throw new RpcError(
      'forbidden',
      `packs.install: ${JSON.stringify(manifest.slug)} is a core feature the server installs itself`,
    );
  }
  const plan = normalizeBulkPackInstallPlan(manifest);
  const isRecords = plan.contents.some((content) =>
    content.type === 'composition' && isRecordsComposition(content.composition));
  let effectiveVerifiedPublisher = verifiedPublisher;
  if (isRecords && effectiveVerifiedPublisher === undefined) {
    // The by-value UI route is authoritative only when the submitted body is
    // byte-semantically the exact bundled artifact reloaded by the server.
    const bundled = resolveBundledPackManifest(deps.packDir, manifest.slug);
    if (bundled !== null
      && recordsManifestReviewHash(bundled) === recordsManifestReviewHash(manifest)) {
      effectiveVerifiedPublisher = bundled.publisher;
    }
  }
  let recordsReviewFence = prevalidatedRecordsReview?.fence;
  if (isRecords && prevalidatedRecordsReview === undefined) {
    let prepared: PreparedRecordsUpdateReview | null;
    try {
      prepared = await prepareRecordsUpdateReview(
        deps,
        manifest,
        async (slug) => {
          const recipe = deps.recipeStore.getBundled(slug);
          if (recipe === null) return null;
          return {
            recipe,
            publisher_id: manifest.publisher,
            version: recipe.version,
          };
        },
      );
    } catch (error) {
      return {
        result: {
          ok: false,
          installed: [],
          rolled_back: [],
          failure: {
            code: 'validator_rejected',
            message: `packs.install: Records review staging refused — ${error instanceof Error ? error.message : String(error)}`,
          },
        },
      };
    }
    if (prepared?.transition !== null && prepared !== null) {
      if (args.expected_manifest_hash !== prepared.review_hash) {
        return { result: staleManifestReviewResult(manifest.slug) };
      }
      recordsReviewFence = prepared.transition.fence;
    } else if (args.expected_manifest_hash !== undefined
      && args.expected_manifest_hash !== (prepared?.review_hash ?? recordsManifestReviewHash(manifest))) {
      return { result: staleManifestReviewResult(manifest.slug) };
    }
  }
  const preflight = preflightTransitivePermissions(deps, args, manifest);
  if (preflight !== null) return { result: preflight };
  // D-311 — on the marketplace path, fetch every recipe the install writes, many at
  // once, now that it is going ahead: a refused install counts no recipe installs.
  await deps.warmMarketplaceRecipes?.(installTouchedManifests(deps, manifest) ?? [manifest]);
  // ⛔ A PACK ITS RECIPES CALL THAT IT NEITHER FINDS INSTALLED NOR BRINGS IN: refused
  // HERE, before the recursion installs anything. The lowering refuses it too, but
  // only once the packs this install brings in are installed, so a refused meeting
  // pack left Personal Organizer Foundation behind. The dialog holds Install on the
  // same list (`missing_packs` on the preview); this is for every caller that did
  // not ask first: an older webclient, an rpc caller, an Install pressed before the
  // preview landed.
  // ⚠ After the warm-up, deliberately: it reads the recipe bodies that fetched, and
  // a refusal here counts the same installs the lowering's refusal counted.
  const missingPacks = await installMissingPacksFor(deps, manifest);
  if (missingPacks !== undefined && missingPacks.length > 0) {
    return { result: missingPacksRefusal(missingPacks) };
  }
  const { result } = await handlePacksInstallInternal(
    deps,
    args,
    { visiting: new Set(), installed: new Set(), recipeKeysByPack: new Map() },
    effectiveVerifiedPublisher,
    recordsReviewFence,
  );
  return { result };
};

// ───────────────────────────────────────────────────────────────────────────
// Install seam 5c — by-slug install entries (marketplace-fetch path)
//
// The keystone both apex entry points need: `packs.installBySlug` (the
// `#packs/<slug>` detail/consent handoff + in-app Discover) and `recipe.installBySlug`
// (the standalone end of the `#recipes/install/<id>` deep-link; bundled rows
// are rejected with `bundle_pack_required`). The by-value `packs.install` above
// is untouched — bundled / foundation packs keep flowing through it.
//
// Marketplace-version note: the marketplace serves only latest-by-slug (there is
// no version-pinned fetch endpoint), so the by-slug path installs the CURRENT
// published version of each recipe. The manifest's pinned `version` is advisory
// — refusing to install on a pin↔latest mismatch would make a pack uninstallable
// the moment any constituent recipe is updated. This matches the bundled path,
// which likewise installs the on-disk version (the pin is its fallback only).
// ───────────────────────────────────────────────────────────────────────────

/** Server-side marketplace metadata stays small; bound the full response
 * lifecycle so a broken CDN cannot wedge an install or buffer unbounded JSON. */
export const MARKETPLACE_FETCH_TIMEOUT_MS = 10_000;
export const MARKETPLACE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

const boundedMarketplaceFetch = makeBoundedOriginHttpFetcher({
  timeoutMs: MARKETPLACE_FETCH_TIMEOUT_MS,
  maxResponseBytes: MARKETPLACE_RESPONSE_MAX_BYTES,
});

export const defaultMarketplaceFetch: typeof globalThis.fetch = async (input, init) => {
  if (typeof input !== 'string' && !(input instanceof URL)) {
    throw new TypeError('marketplace fetch requires a URL input');
  }
  const url = String(input);
  if (init?.body !== undefined && typeof init.body !== 'string') {
    throw new TypeError('marketplace fetch supports only string request bodies');
  }
  let headers: Record<string, string> | undefined;
  if (init?.headers !== undefined) {
    const copied: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      copied[name] = value;
    });
    headers = copied;
  }
  const response = await boundedMarketplaceFetch(url, {
    ...(init?.method !== undefined ? { method: init.method } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(typeof init?.body === 'string' ? { body: init.body } : {}),
  });
  return response as unknown as Response;
};

type PacksInstallBySlugArgs = {
  slug: string;
  granted_permissions: ReadonlyArray<string>;
  /** Exact manifest rendered by `packs.resolveBySlug`; mandatory when this
   * call replaces an installed version. */
  expected_manifest_hash?: string;
  install_scope?: InstallGrantSelection;
  /** D-194 2b — forwarded verbatim to `packs.install`. See `PacksInstallArgs`. */
  chosen_connection?: string;
  /** D-201 Slice 4 — forwarded verbatim to the by-value install validator. */
  webhook_bindings?: PacksInstallArgs['webhook_bindings'];
  /** D-310 — forwarded verbatim to the by-value install. */
  dependency_install_scopes?: PacksInstallArgs['dependency_install_scopes'];
};

const marketplaceManifestReviewHash = (
  manifest: BulkPackManifest,
  recordsFence?: RecordsUpdateReviewFence,
): string => recordsManifestReviewHash(manifest, recordsFence);

const staleManifestReviewResult = (slug: string): BulkPackInstallResultLike => ({
  ok: false,
  installed: [],
  rolled_back: [],
  failure: {
    code: 'review_stale',
    message:
      `packs.installBySlug: pack ${JSON.stringify(slug)} changed since it was reviewed; `
      + 'refresh the pack detail and review the current manifest',
  },
});

interface PreparedRecordsUpdateReview {
  target: PreparedRecordsReviewTarget;
  recipes: RecordsReviewRecipe[];
  migration_artifacts: readonly RecordsMigrationArtifact[];
  transition: ReturnType<typeof buildRecordsPackUpdateReview>;
  review_hash: string;
}

const recordsCurrentVersion = (
  namespace: NonNullable<ReturnType<RecordsStore['getNamespace']>>,
): number | undefined => namespace.state.state === 'ready'
  ? namespace.state.version
  : namespace.state.state === 'orphaned'
    ? namespace.state.last_version
    : namespace.state.state === 'migrating'
      ? namespace.state.from_version
      : undefined;

/** How many marketplace fetches one install or preview runs at once. */
const MARKETPLACE_FETCH_CONCURRENCY = 8;

/** Run `fn` over `items`, at most `limit` at a time, results in `items` order. */
const mapBounded = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

/** Read-only target staging shared by marketplace preview/confirm and bundled
 * list/confirm. It resolves exact recipe bodies because a ref-only manifest hash
 * cannot bind migration bodies or watcher behavior. */
export const prepareRecordsUpdateReview = async (
  deps: PackInstallRpcDeps,
  manifest: BulkPackManifest,
  resolveRecipe: (slug: string) => Promise<{
    recipe: RecipeDefinition;
    publisher_id: string;
    version: number;
  } | null>,
): Promise<PreparedRecordsUpdateReview | null> => {
  const plan = normalizeBulkPackInstallPlan(manifest);
  const recordsComposition = plan.contents.some((content) =>
    content.type === 'composition' && isRecordsComposition(content.composition));
  if (!recordsComposition) return null;
  if (deps.recordsStore === undefined) {
    throw new Error('Records runtime/storage is unavailable');
  }
  // D-311 — resolved several at once. On the marketplace paths each is a network
  // round trip, and one after another they took about a second each: opening
  // Invoice Book's detail on a deployed layout took 9.6 s, and Fleet Money's 27
  // recipes would near the webclient's 30 s wait. The first one missing, in the
  // manifest's order, still refuses.
  const rows = await mapBounded(plan.recipes, MARKETPLACE_FETCH_CONCURRENCY, (ref) => resolveRecipe(ref.slug));
  const recipes: RecordsReviewRecipe[] = plan.recipes.map((ref, index) => {
    const row = rows[index] ?? null;
    if (row === null) throw new Error(`Records recipe '${ref.slug}' could not be resolved for review`);
    return {
      slug: ref.slug,
      recipe: row.recipe,
      publisher_id: row.publisher_id,
      version: row.version,
    };
  });
  const target = await prepareRecordsReviewTarget({ manifest, recipes });
  if (target === null) return null;
  const owner = { publisher: manifest.publisher, pack_slug: manifest.slug };
  const namespace = deps.recordsStore.getNamespace(owner);
  const fromVersion = namespace === null ? undefined : recordsCurrentVersion(namespace);
  let migrationArtifacts: readonly RecordsMigrationArtifact[] = [];
  if (fromVersion !== undefined && fromVersion !== manifest.version
    && deps.resolveRecordsMigrationArtifacts !== undefined) {
    migrationArtifacts = await deps.resolveRecordsMigrationArtifacts({
      owner,
      from_version: fromVersion,
      target_version: manifest.version,
    });
  }
  const transition = buildRecordsPackUpdateReview({
    manifest,
    target,
    store: deps.recordsStore,
    migration_artifacts: migrationArtifacts,
  });
  return {
    target,
    recipes,
    migration_artifacts: migrationArtifacts,
    transition,
    review_hash: marketplaceManifestReviewHash(manifest, transition?.fence),
  };
};

/** Add-a-pack (2026-07-01) — `packs.resolveBySlug` args (manifest-only preview). */
type PacksResolveBySlugArgs = {
  slug: string;
};

/** Map a `BulkPackFetchError` (raised by `fetchBulkPackBySlug` for everything
 *  except a clean 404) onto a result-body failure, so the install dialog renders
 *  targeted copy instead of seeing a raw rpc error. A clean 404 (null return) is
 *  handled by the caller as `unresolved`. */
const bulkFetchErrorToResult = (
  slug: string,
  err: unknown,
): BulkPackInstallResultLike => {
  const fail = (
    code: NonNullable<BulkPackInstallResultLike['failure']>['code'],
    message: string,
  ): BulkPackInstallResultLike => ({
    ok: false,
    installed: [],
    rolled_back: [],
    failure: { code, message },
  });
  if (err instanceof BulkPackFetchError) {
    switch (err.kind) {
      case 'validation':
        return fail(
          'validator_rejected',
          `packs.installBySlug: pack ${JSON.stringify(slug)} failed validation — ${err.message}`,
        );
      case 'version':
        return fail('version_mismatch', `packs.installBySlug: ${err.message}`);
      // network / http / parse — reaching or reading the marketplace failed.
      default:
        return fail(
          'unexpected',
          `packs.installBySlug: could not fetch pack ${JSON.stringify(slug)} — ${err.message}`,
        );
    }
  }
  return fail(
    'unexpected',
    `packs.installBySlug: could not fetch pack ${JSON.stringify(slug)} — ${(err as Error).message ?? String(err)}`,
  );
};

const packDependenciesOf = (
  manifest: BulkPackManifest,
): Array<{ dependency: PackPackDependency; declaredBy: string }> =>
  (manifest.dependencies ?? [])
    .filter((dependency): dependency is PackPackDependency => dependency.type === 'pack')
    .map((dependency) => ({ dependency, declaredBy: manifest.slug }));

/** D-311 — the packs a marketplace pack brings in that this server does not
 *  bundle, fetched from the marketplace, and the ones they bring in in turn.
 *
 *  ⛔ A DEPLOYED SERVER BUNDLES ONLY ITS FOUNDATION PACKS. A distribution ships
 *  `dist/`, not the pack tree, so a walk that looked each dependency up among the
 *  bundled packs found nothing: every marketplace pack that brings others in was
 *  refused "was not found in bundled packs". Invoice Book was refused even with
 *  Billable Hours already installed, because the lookup comes before the
 *  installed check. 208 shipped packs declare dependencies.
 *
 *  🔑 Fetched AHEAD of the walk, because the walk is synchronous and a fetch is
 *  not, and by the walk's own rules so the two cannot disagree: the bundled copy
 *  first; a dependency already installed at the version needed is not descended
 *  into (the walk does not descend into it either); a fetched manifest must name
 *  the slug it was fetched for, or it is not the pack that was asked for.
 *
 *  ⚠ THE MARKETPLACE COUNTS AN INSTALL FROM THE FETCH MARKER. `install` marks
 *  the fetch of each pack the install will write, the way the pack itself is
 *  marked. A pack already installed is fetched unmarked: the walk needs its
 *  manifest, and nothing installs it. A preview never marks. */
export const fetchMarketplaceDependencies = async (
  deps: Pick<PackInstallRpcDeps, 'packDir' | 'contractStore'>,
  root: BulkPackManifest,
  fetchFn: typeof globalThis.fetch,
  mode: 'install' | 'preview',
): Promise<
  | { ok: true; manifests: ReadonlyMap<string, BulkPackManifest> }
  | { ok: false; failure: NonNullable<BulkPackInstallResultLike['failure']> }
> => {
  const manifests = new Map<string, BulkPackManifest>();
  const seen = new Set<string>([root.slug]);
  let level = packDependenciesOf(root);
  while (level.length > 0) {
    const fresh = level.filter(({ dependency }) => {
      if (seen.has(dependency.slug)) return false;
      seen.add(dependency.slug);
      return true;
    });
    const found = await mapBounded(fresh, MARKETPLACE_FETCH_CONCURRENCY, async ({ dependency, declaredBy }) => {
      const satisfied = dependencyAlreadySatisfied(deps.contractStore, dependency);
      const bundled = resolveBundledPackManifest(deps.packDir, dependency.slug);
      if (bundled !== null) return { dependency, declaredBy, satisfied, manifest: bundled, fetched: false };
      try {
        const manifest = await fetchBulkPackBySlug(
          dependency.slug,
          fetchFn,
          { install: mode === 'install' && !satisfied },
        );
        return {
          dependency,
          declaredBy,
          satisfied,
          manifest: manifest !== null && manifest.slug === dependency.slug ? manifest : null,
          fetched: true,
        };
      } catch (error) {
        const failure = bulkFetchErrorToResult(dependency.slug, error).failure!;
        return { dependency, declaredBy, satisfied, manifest: null, fetched: true, failure };
      }
    });
    const next: typeof level = [];
    for (const entry of found) {
      const named = `dependency pack ${JSON.stringify(entry.dependency.slug)} declared by ${JSON.stringify(entry.declaredBy)}`;
      if ('failure' in entry && entry.failure !== undefined) {
        return { ok: false, failure: { ...entry.failure, message: `${named}: ${entry.failure.message}` } };
      }
      if (entry.manifest === null) {
        return {
          ok: false,
          failure: { code: 'unresolved', message: `packs.installBySlug: ${named} was not found on the marketplace` },
        };
      }
      if (entry.fetched) manifests.set(entry.dependency.slug, entry.manifest);
      if (!entry.satisfied) next.push(...packDependenciesOf(entry.manifest));
    }
    level = next;
  }
  return { ok: true, manifests };
};

/** D-311 — a marketplace recipe resolver that fetches each slug once per call.
 *  `warm` fetches the recipes of many packs at once, ahead of walks that read
 *  them one at a time. A failure it meets stays in the memo, so the walk that
 *  reads that slug meets the same failure it would have met on its own. */
const memoizeMarketplaceRecipes = (
  resolve: (slug: string) => Promise<MarketplaceRecipeResult | null>,
): {
  resolve: (slug: string) => Promise<MarketplaceRecipeResult | null>;
  warm: (manifests: readonly BulkPackManifest[]) => Promise<void>;
} => {
  const memo = new Map<string, Promise<MarketplaceRecipeResult | null>>();
  const get = (slug: string): Promise<MarketplaceRecipeResult | null> => {
    let pending = memo.get(slug);
    if (pending === undefined) {
      pending = resolve(slug);
      memo.set(slug, pending);
    }
    return pending;
  };
  return {
    resolve: get,
    warm: async (manifests) => {
      const slugs = [...new Set(manifests.flatMap((manifest) =>
        normalizeBulkPackInstallPlan(manifest).recipes.map((ref) => ref.slug)))];
      await mapBounded(slugs, MARKETPLACE_FETCH_CONCURRENCY, (slug) => get(slug).catch(() => null));
    },
  };
};

/** D-311 — the deps a `packs.install_preview` with `marketplace` runs with: the
 *  marketplace's recipes and the packs the pack brings in, resolved as
 *  `packs.installBySlug` will resolve them, but unmarked, since a preview
 *  installs nothing. A dependency that cannot be fetched leaves the walks to
 *  fail as before, and the lists stay absent. */
const marketplacePreviewDeps = async (
  deps: PackInstallRpcDeps,
  manifest: BulkPackManifest,
): Promise<PackInstallRpcDeps> => {
  const fetchFn = deps.marketplaceFetch ?? defaultMarketplaceFetch;
  const recipes = memoizeMarketplaceRecipes(async (slug) => {
    const row = await fetchRecipeBySlug(slug, fetchFn);
    // The install's slug-confusion guard: a row naming another recipe is not this one.
    return row !== null && row.recipe_id === slug && row.recipe.recipe_id === slug ? row : null;
  });
  const dependencies = await fetchMarketplaceDependencies(deps, manifest, fetchFn, 'preview');
  const previewDeps: PackInstallRpcDeps = {
    ...deps,
    resolveMarketplaceRecipe: recipes.resolve,
    ...(dependencies.ok
      ? { resolveDependencyManifest: (slug: string) => dependencies.manifests.get(slug) ?? null }
      : {}),
  };
  await recipes.warm(installTouchedManifests(previewDeps, manifest) ?? [manifest]);
  return previewDeps;
};

/** Install seam 5c — install a marketplace pack by slug. Fetch the manifest,
 *  then drive the EXISTING `handlePacksInstall` transaction with the marketplace
 *  recipe resolver injected — so all the security-critical post-install
 *  orchestration (grants, recipe-trust, composition provisioning, inventory,
 *  `pack_installed` broadcast, runnability / PII disclosures) is reused verbatim.
 *  The resolver is built here from `deps.marketplaceFetch` so it is present ONLY
 *  on this path; the by-value `packs.install` stays bundled-only. */
export const installPackBySlug = async (
  deps: PackInstallRpcDeps,
  args: PacksInstallBySlugArgs,
): Promise<{ result: BulkPackInstallResultLike }> => {
  if (args == null || typeof args !== 'object') {
    throw new RpcError('bad_request', 'packs.installBySlug: args required');
  }
  if (typeof args.slug !== 'string' || args.slug.length === 0) {
    throw new RpcError('bad_request', 'packs.installBySlug: slug must be a non-empty string');
  }
  if (
    !Array.isArray(args.granted_permissions)
    || !args.granted_permissions.every((p): p is string => typeof p === 'string')
  ) {
    throw new RpcError(
      'bad_request',
      'packs.installBySlug: granted_permissions must be an array of strings',
    );
  }
  if (
    args.expected_manifest_hash !== undefined
    && !/^[0-9a-f]{64}$/.test(args.expected_manifest_hash)
  ) {
    throw new RpcError(
      'bad_request',
      'packs.installBySlug: expected_manifest_hash must be a lowercase SHA-256 digest',
    );
  }
  if (args.install_scope !== undefined && !isInstallGrantSelection(args.install_scope)) {
    throw new RpcError(
      'bad_request',
      `packs.installBySlug: ${INSTALL_SCOPE_ERROR}`,
    );
  }
  // D-194 2b — mirror the by-value guard so a malformed pick fails loudly here too.
  if (args.chosen_connection !== undefined && typeof args.chosen_connection !== 'string') {
    throw new RpcError(
      'bad_request',
      'packs.installBySlug: chosen_connection must be a string',
    );
  }
  if (args.webhook_bindings !== undefined && !Array.isArray(args.webhook_bindings)) {
    throw new RpcError(
      'bad_request',
      'packs.installBySlug: webhook_bindings must be an array',
    );
  }
  assertDependencyInstallScopes('packs.installBySlug', args.dependency_install_scopes);

  const fetchFn = deps.marketplaceFetch ?? defaultMarketplaceFetch;
  let manifest: BulkPackManifest | null;
  try {
    // Marked as an install — this is the post-consent path. Its twin in
    // `resolvePackBySlug` fires on merely opening the detail and stays unmarked.
    manifest = await fetchBulkPackBySlug(args.slug, fetchFn, { install: true });
  } catch (e) {
    return { result: bulkFetchErrorToResult(args.slug, e) };
  }
  if (manifest === null) {
    return {
      result: {
        ok: false,
        installed: [],
        rolled_back: [],
        failure: {
          code: 'unresolved',
          message: `packs.installBySlug: pack ${JSON.stringify(args.slug)} was not found on the marketplace`,
        },
      },
    };
  }
  let preparedRecords: PreparedRecordsUpdateReview | null = null;
  try {
    preparedRecords = await prepareRecordsUpdateReview(
      deps,
      manifest,
      async (slug) => {
        const row = await fetchRecipeBySlug(slug, fetchFn, { install: true });
        if (row === null || row.recipe_id !== slug || row.recipe.recipe_id !== slug) return null;
        return { recipe: row.recipe, publisher_id: row.publisher_id, version: row.version };
      },
    );
  } catch (error) {
    return {
      result: {
        ok: false,
        installed: [],
        rolled_back: [],
        failure: {
          code: 'validator_rejected',
          message: `packs.installBySlug: Records review staging refused — ${error instanceof Error ? error.message : String(error)}`,
        },
      },
    };
  }
  const currentManifestHash = preparedRecords?.review_hash
    ?? marketplaceManifestReviewHash(manifest);
  const recordsNamespace = deps.recordsStore?.getNamespace({
    publisher: manifest.publisher,
    pack_slug: manifest.slug,
  }) ?? null;
  const installed = recordsNamespace !== null
    ? {
        version: recordsNamespace.state.state === 'ready'
          ? recordsNamespace.state.version
          : recordsNamespace.state.state === 'orphaned'
            ? recordsNamespace.state.last_version
            : undefined,
      }
    : deps.contractStore === undefined
      ? null
      : getInstalledPack(deps.contractStore, manifest.slug);
  const isUpdate = preparedRecords?.transition !== null && preparedRecords !== null
    ? true
    : installed !== null
    && (
      recordsNamespace?.state.state === 'orphaned'
      || installed.version === undefined
      || installed.version < manifest.version
    );
  if (
    (args.expected_manifest_hash !== undefined
      && args.expected_manifest_hash !== currentManifestHash)
    || (isUpdate && args.expected_manifest_hash === undefined)
  ) {
    return { result: staleManifestReviewResult(args.slug) };
  }

  // D-311 — the packs it brings in: the server's bundled copy, else the
  // marketplace's, fetched now (marked, for each one this install will write).
  const dependencies = await fetchMarketplaceDependencies(deps, manifest, fetchFn, 'install');
  if (!dependencies.ok) {
    return { result: { ok: false, installed: [], rolled_back: [], failure: dependencies.failure } };
  }

  // Build the marketplace recipe resolver from the SAME fetch — present ONLY on
  // this by-slug call. It returns the full row because the constituent recipe's
  // marketplace `publisher_id` remains authoritative independently of the pack's
  // publisher. A clean 404 on a constituent recipe → null → the resolution loop
  // records `not_found` (→ engine `ok: false,
  // unresolved`); a hard fetch error throws → caught below as an `unexpected`
  // result, so a transient blip never masquerades as `not_found` or a raw rpc
  // error.
  const preparedRecipeRows = new Map(
    (preparedRecords?.recipes ?? []).map((row) => [row.slug, row]),
  );
  const resolveMarketplaceRecipe = async (slug: string): Promise<MarketplaceRecipeResult | null> => {
    const prepared = preparedRecipeRows.get(slug);
    if (prepared !== undefined) {
      // No `recipe_hash`: a prepared row carries none, and the field is
      // optional precisely so this path does not have to invent one.
      return {
        recipe_id: slug,
        publisher_id: prepared.publisher_id,
        version: prepared.version,
        recipe: prepared.recipe,
      };
    }
    // Marked: a pack install DOES install each constituent recipe, so each ref
    // is a real recipe install. One N-recipe pack install therefore contributes
    // 1 to the pack and 1 to each of its N recipes — intended, not double
    // counting. This closure exists only on the install-by-slug path.
    const row = await fetchRecipeBySlug(slug, fetchFn, { install: true });
    if (row == null) return null;
    // Slug-confusion guard — the install txn keys on `recipe.recipe_id`, so a
    // marketplace row whose identity disagrees with the requested slug must NOT
    // be installed under that slug. Fail closed → the loop records `not_found`
    // → the pack install fails `unresolved` rather than persisting a mismatch.
    if (row.recipe_id !== slug || row.recipe.recipe_id !== slug) return null;
    return row;
  };
  const recipes = memoizeMarketplaceRecipes(resolveMarketplaceRecipe);

  try {
    return await handlePacksInstall(
      {
        ...deps,
        resolveMarketplaceRecipe: recipes.resolve,
        resolveDependencyManifest: (slug) => dependencies.manifests.get(slug) ?? null,
        warmMarketplaceRecipes: recipes.warm,
        ...(preparedRecords !== null
          ? {
              resolveRecordsMigrationArtifacts: async () =>
                preparedRecords!.migration_artifacts,
            }
          : {}),
      },
      {
        manifest,
        granted_permissions: args.granted_permissions,
        ...(args.install_scope !== undefined ? { install_scope: args.install_scope } : {}),
        ...(args.chosen_connection !== undefined ? { chosen_connection: args.chosen_connection } : {}),
        ...(args.webhook_bindings !== undefined
          ? { webhook_bindings: args.webhook_bindings }
          : {}),
        ...(args.dependency_install_scopes !== undefined
          ? { dependency_install_scopes: args.dependency_install_scopes }
          : {}),
      },
      manifest.publisher,
      {
        ...(preparedRecords?.transition?.fence !== undefined
          ? { fence: preparedRecords.transition.fence }
          : {}),
      },
    );
  } catch (e) {
    // Arg-shape / manifest-validator failures stay on the rpc error channel (the
    // manifest was already validated by `fetchBulkPackBySlug`, so re-parse here
    // is belt-and-suspenders). A thrown recipe-resolution fetch error becomes a
    // result-body `unexpected` so the dialog renders it rather than erroring.
    if (e instanceof RpcError) throw e;
    return {
      result: {
        ok: false,
        installed: [],
        rolled_back: [],
        failure: {
          code: 'unexpected',
          message: `packs.installBySlug: install failed — ${(e as Error).message ?? String(e)}`,
        },
      },
    };
  }
};

/** Map a `BulkPackFetchError` onto a `PacksResolveResult.failure`, so the Add-a-pack
 *  consent dialog renders targeted copy. Parallel to `bulkFetchErrorToResult` but
 *  for the manifest-only preview shape (no install envelope). */
const resolveFetchErrorToResult = (err: unknown): PacksResolveResult => {
  if (err instanceof BulkPackFetchError) {
    if (err.kind === 'validation') {
      return { manifest: null, failure: { code: 'validation', message: err.message } };
    }
    if (err.kind === 'version') {
      return { manifest: null, failure: { code: 'version', message: err.message } };
    }
    // network / http / parse — reaching or reading the marketplace failed.
    return { manifest: null, failure: { code: 'fetch_error', message: err.message } };
  }
  return {
    manifest: null,
    failure: { code: 'fetch_error', message: (err as Error).message ?? String(err) },
  };
};

/** Add-a-pack (2026-07-01) — `packs.resolveBySlug`: fetch a marketplace pack's
 *  manifest by slug WITHOUT installing, so the webclient's "Add a pack" flow can
 *  render the install consent dialog before the owner commits. Server-fetch (the
 *  same fixed marketplace host as `installPackBySlug`) keeps the manifest
 *  marketplace-authoritative — the webclient never fetches or trusts it. On
 *  confirm the flow calls the trusted `packs.installBySlug`. A clean 404 →
 *  `unresolved`; any fetch / validation / version failure → the matching
 *  `failure` code (never throws for those — only a bad-args shape throws). */
export const resolvePackBySlug = async (
  deps: PackInstallRpcDeps,
  args: PacksResolveBySlugArgs,
): Promise<PacksResolveResult> => {
  if (args == null || typeof args !== 'object') {
    throw new RpcError('bad_request', 'packs.resolveBySlug: args required');
  }
  if (typeof args.slug !== 'string' || args.slug.length === 0) {
    throw new RpcError('bad_request', 'packs.resolveBySlug: slug must be a non-empty string');
  }
  // BUNDLED FIRST — the server's own disk outranks the marketplace for a pack it
  // already ships. Added when `packs.list` stopped forwarding the manifest for
  // UNINSTALLED packs (44.6 MB → ~1 MB; see `PackListEntry.manifest`): the
  // install dialog for a bundled Discover row now resolves its manifest here
  // instead of reading one the list pushed eagerly.
  //
  // 🔑 Order is the trust decision, not an optimisation. The marketplace-
  // authoritative rule this rpc documents exists so the WEBCLIENT never supplies
  // the manifest; reading the server's own bundled copy honours that rule more
  // strictly than a network fetch does, and it cannot 404 or be MITM'd. A pack
  // that is bundled AND published resolves to the bundled bytes — which is the
  // copy `packs.install` would validate against anyway (see the records
  // review-hash comparison below).
  const bundled = resolveBundledPackManifest(deps.packDir, args.slug);
  // Owner ruling 2026-09-07 — the third door. Add-a-pack takes a typed slug, so
  // a core feature could be reached by name even though no roster offers it, and
  // its detail would render an Install the install rpc then refuses. Refusing
  // here keeps "never shows up in Packs" true for the one surface that does not
  // read the roster.
  if (bundled !== null && isCoreFeaturePack(bundled)) {
    throw new RpcError(
      'forbidden',
      `packs.resolveBySlug: ${JSON.stringify(args.slug)} is a core feature the server installs itself`,
    );
  }
  const fetchFn = deps.marketplaceFetch ?? defaultMarketplaceFetch;
  let manifest: BulkPackManifest | null;
  if (bundled !== null) {
    manifest = bundled;
  } else {
    try {
      // DELIBERATELY UNMARKED. `ensureDetailResolved` calls this on every pack
      // detail render — a Discover card click, a click-through from the public
      // marketplace, a back/forward nav — all with zero install intent. Marking it
      // would turn the install signal back into a view count, which is what the
      // marker exists to separate.
      manifest = await fetchBulkPackBySlug(args.slug, fetchFn);
    } catch (e) {
      return resolveFetchErrorToResult(e);
    }
  }
  if (manifest === null) {
    return {
      manifest: null,
      failure: {
        code: 'unresolved',
        message: `packs.resolveBySlug: pack ${JSON.stringify(args.slug)} was not found on the marketplace`,
      },
    };
  }
  let preparedRecords: PreparedRecordsUpdateReview | null = null;
  const pinnedRecipes = normalizeBulkPackInstallPlan(manifest).recipes;
  const pinnedVersion = (slug: string): number | undefined =>
    pinnedRecipes.find((ref) => ref.slug === slug)?.version;
  try {
    preparedRecords = await prepareRecordsUpdateReview(
      deps,
      manifest,
      // ⛔ BUNDLED FIRST HERE TOO. The manifest above already resolves from the
      // server's own disk before the marketplace, and the comment there calls
      // that a trust decision rather than an optimisation. This callback used to
      // undo it: it went straight to the marketplace for every recipe, so a
      // BUNDLED records pack whose recipes are not published — or any records
      // pack at all on a LAN-only server — failed its whole resolve on the first
      // ref, with `Records recipe '<slug>' could not be resolved for review`.
      //
      // The user-visible shape was `rental-book` → Install → nothing. It is a
      // records pack with 19 refs; `booking-desk`, four refs and no records
      // composition, installed fine, because it never reaches this code.
      //
      // Mirrors the by-value path's precedence (see `resolveMarketplaceRecipe`
      // above): when a marketplace row exists it WINS, because its publisher row
      // is the identity the install will attribute. The bundled body is the
      // fallback that keeps a self-hosted server working offline, attributed to
      // the pack's own publisher — which is exactly who ships it on disk.
      async (slug) => {
        const row = await fetchRecipeBySlug(slug, fetchFn).catch(() => null);
        // ⛔⛔ D-292 — THE MARKETPLACE SERVES ONLY ITS LATEST BODY, AND A BUNDLED
        // MANIFEST PINS A VERSION. `fetchRecipeBySlug` has no version argument, so
        // whenever the two disagree the published row is a body for a DIFFERENT
        // version than this manifest names, and the review refused the whole pack
        // as "drifted from its pinned identity". That happens on EVERY recipe bump
        // inside a records pack, in both directions: a new server before the
        // marketplace republishes (pin v2, published v1), and every older server
        // after it does (pin v1, published v2). Found live — the guided-import
        // recipes moved to v2 and `statement-import` stopped installing.
        //
        // 🔑 The published row still wins AT THE PINNED VERSION, exactly as before.
        // At any other version the bundled body is the one this manifest means —
        // and it is also the body the by-value install of a bundled pack uses
        // (`resolvePackRecipeBodies` without a marketplace resolver), so the review
        // now describes what will actually be installed.
        const publishedAtPin = row !== null && row.recipe_id === slug && row.recipe.recipe_id === slug
          && (bundled === null || row.version === pinnedVersion(slug));
        if (publishedAtPin) {
          return { recipe: row.recipe, publisher_id: row.publisher_id, version: row.version };
        }
        if (bundled === null) return null;
        const local = deps.recipeStore?.getBundled(slug) ?? null;
        if (local === null) return null;
        return {
          recipe: local,
          publisher_id: manifest.publisher,
          version: typeof (local as { version?: number }).version === 'number'
            ? (local as { version: number }).version
            : (manifest.recipes.find((r) => r.slug === slug)?.version ?? manifest.version),
        };
      },
    );
  } catch (error) {
    return {
      manifest: null,
      failure: {
        code: 'validation',
        message: `Records update preview refused: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  const recordsNamespace = deps.recordsStore?.getNamespace({
    publisher: manifest.publisher,
    pack_slug: manifest.slug,
  }) ?? null;
  const installed = recordsNamespace !== null
    ? {
        version: recordsNamespace.state.state === 'ready'
          ? recordsNamespace.state.version
          : recordsNamespace.state.state === 'orphaned'
            ? recordsNamespace.state.last_version
            : undefined,
      }
    : deps.contractStore === undefined
      ? null
      : getInstalledPack(deps.contractStore, manifest.slug);
  const ownerOperationReview =
    deps.contractStore !== undefined
    && installed !== null
    && (
      recordsNamespace?.state.state === 'orphaned'
      || installed.version === undefined
      || installed.version < manifest.version
    )
      ? reviewOwnerOperationsForPackUpdate(deps.contractStore, manifest)
      : [];
  // The whole-pack operation diff, same as `packs.list` carries for a bundled
  // update: a records pack's stamped catalog, or the pack's own compositions.
  const isUpdate = installed !== null
    && (recordsNamespace?.state.state === 'orphaned'
      || installed.version === undefined
      || installed.version < manifest.version
      || (preparedRecords?.transition !== null && preparedRecords !== null));
  const operationDiff = !isUpdate || deps.contractStore === undefined || deps.localManifestStore === undefined
    ? undefined
    : preparedRecords !== null && preparedRecords !== undefined
      ? diffRecordsPackForUpdate(deps.contractStore, deps.localManifestStore, preparedRecords.target.catalog)
      : diffCompositionPackForUpdate(deps.contractStore, deps.localManifestStore, manifest);
  // Where the update's Access choice starts: what the pack holds now. A
  // Records pack's grants are keyed by its derived catalog id, not its slug.
  const currentAccess = !isUpdate || deps.contractStore === undefined || deps.localManifestStore === undefined
    ? undefined
    : preparedRecords !== null && preparedRecords !== undefined
      ? recordsPackCurrentAccess(deps.contractStore, deps.localManifestStore, preparedRecords.target)
      : compositionPackCurrentAccess(deps.contractStore, deps.localManifestStore, manifest);
  // …and "Who may use it" at who has it now (D-294): the fan-out's stamp is the
  // pack slug, or a Records pack's catalog id.
  const audienceSource = preparedRecords !== null && preparedRecords !== undefined
    ? preparedRecords.target.catalog.slug
    : carriesRecords(manifest) ? undefined : manifest.slug;
  const currentAudience = !isUpdate || deps.contractStore === undefined || audienceSource === undefined
    ? undefined
    : currentPackAudience({
      contractStore: deps.contractStore,
      ...(deps.sellerStore !== undefined ? { sellerStore: deps.sellerStore } : {}),
      sourcePack: audienceSource,
      now: deps.now ?? Date.now,
    });
  // …and Connect at the account it uses now (a Records pack connects nothing).
  const currentConnection = !isUpdate || deps.contractStore === undefined || carriesRecords(manifest)
    ? undefined
    : currentPackConnection(deps.contractStore, manifest.slug);
  return {
    manifest,
    manifest_review_hash: preparedRecords?.review_hash
      ?? marketplaceManifestReviewHash(manifest),
    ...(ownerOperationReview.length > 0
      ? { owner_operation_review: ownerOperationReview }
      : {}),
    ...(operationDiff !== undefined ? { operation_diff: operationDiff } : {}),
    ...(currentAccess !== undefined ? { current_access: currentAccess } : {}),
    ...(currentAudience !== undefined ? { current_audience: currentAudience } : {}),
    ...(currentConnection !== undefined ? { current_connection: currentConnection } : {}),
    ...(preparedRecords?.transition !== null && preparedRecords !== null
      ? { records_review: preparedRecords.transition.review }
      : {}),
  };
};

/** The `recipe.installBySlug` result body — mirrors the registry spec. */
type RecipeInstallBySlugResult =
  | {
      ok: true;
      recipe_id: string;
      version: number;
      name: string;
      publisher_id: string;
      pii?: {
        headline?: string;
        auto_protected?: string[];
        warnings?: string[];
        infos?: string[];
      };
    }
  | {
      ok: false;
      failure: {
        code: 'not_found' | 'validator_rejected' | 'fetch_error' | 'bundle_pack_required';
        message: string;
        pack_slug?: string;
      };
    };

/** Install seam 5c — install a standalone marketplace recipe by slug. Fetch →
 *  validate → persist with the marketplace-authoritative `publisher_id`. Mirrors
 *  `recipe.save`'s validate-then-save shape (the same `validateRecipeInline`
 *  walk, the same roster-mutation hook via `save()`) but sourced from a
 *  marketplace fetch; like `recipe.save` it emits no broadcast and provisions no
 *  pack grants (a standalone recipe carries no pack `requires[]`). */
export const installRecipeBySlug = async (
  deps: PackInstallRpcDeps,
  args: { slug: string },
): Promise<{ result: RecipeInstallBySlugResult }> => {
  if (args == null || typeof args !== 'object' || typeof args.slug !== 'string' || args.slug.length === 0) {
    throw new RpcError('bad_request', 'recipe.installBySlug: slug must be a non-empty string');
  }

  const fetchFn = deps.marketplaceFetch ?? defaultMarketplaceFetch;
  let row: MarketplaceRecipeResult | null;
  try {
    // Marked — the standalone recipe install path. Note it can still refuse
    // downstream with `bundle_pack_required`, so this counts installs STARTED.
    row = await fetchRecipeBySlug(args.slug, fetchFn, { install: true });
  } catch (e) {
    return {
      result: {
        ok: false,
        failure: {
          code: 'fetch_error',
          message: `recipe.installBySlug: could not fetch recipe ${JSON.stringify(args.slug)} — ${(e as Error).message ?? String(e)}`,
        },
      },
    };
  }
  if (row === null) {
    return {
      result: {
        ok: false,
        failure: {
          code: 'not_found',
          message: `recipe.installBySlug: recipe ${JSON.stringify(args.slug)} was not found on the marketplace`,
        },
      },
    };
  }

  // Slug-confusion guard — `RecipeStore.save` keys on `recipe.recipe_id` and the
  // result reports `row.recipe_id`; reject unless the requested slug, the
  // marketplace row id, and the recipe body id all agree, so a corrupt / mismatched
  // marketplace response can never persist or report a different identity than asked.
  if (row.recipe_id !== args.slug || row.recipe.recipe_id !== args.slug) {
    return {
      result: {
        ok: false,
        failure: {
          code: 'validator_rejected',
          message: `recipe.installBySlug: marketplace returned a recipe whose id does not match the requested slug ${JSON.stringify(args.slug)}`,
        },
      },
    };
  }

  // Validate before persisting (defensive — published recipes should already be
  // valid; never persist an invalid def). Same path `recipe.save` runs
  // (`parseRecipe` + the inline op-step checks).
  const validation = validateRecipeInline(row.recipe);
  if (!validation.ok) {
    const errs = validation.issues
      .filter((i) => i.severity === 'error')
      .map((i) => `${i.path !== undefined && i.path !== '' ? i.path : '<root>'}: ${i.message}`);
    return {
      result: {
        ok: false,
        failure: {
          code: 'validator_rejected',
          message: `recipe.installBySlug: ${errs.join('; ')}`,
        },
      },
    };
  }
  const bundleIssues = validateRecipeBundlePublisher(
    row.recipe as unknown as Record<string, unknown>,
    row.publisher_id,
  );
  if (bundleIssues.length > 0) {
    return {
      result: {
        ok: false,
        failure: {
          code: 'validator_rejected',
          message: `recipe.installBySlug: ${bundleIssues[0]?.message ?? 'Recipe bundle publisher mismatch'}`,
        },
      },
    };
  }

  // A declared recipe_bundle is an install-routing contract, not an optional
  // sibling hint. Direct recipe installation would bypass the pack's complete
  // contents, consent, grants, and atomic transaction, so reject it even when a
  // client misses the catalog handoff. The result reports the validated
  // declared slug for targeted copy; the UI still uses the public catalogs to
  // reject any cross-publisher slug ambiguity before opening pack detail.
  const bundleKey = row.recipe.metadata?.recipe_bundle;
  if (typeof bundleKey === 'string') {
    const packSlug = parseRecipeBundleKey(bundleKey)?.bundle_slug;
    return {
      result: {
        ok: false,
        failure: {
          code: 'bundle_pack_required',
          message: packSlug === undefined
            ? 'recipe.installBySlug: bundled recipes must be installed through their pack'
            : `recipe.installBySlug: recipe ${JSON.stringify(args.slug)} must be installed through pack ${JSON.stringify(packSlug)}`,
          ...(packSlug !== undefined ? { pack_slug: packSlug } : {}),
        },
      },
    };
  }

  if (hasNonEmptyWebhookDeclarations(row.recipe)) {
    return {
      result: {
        ok: false,
        failure: {
          code: 'validator_rejected',
          message: `recipe.installBySlug: ${D201_WEBHOOK_RUNTIME_UNAVAILABLE}`,
        },
      },
    };
  }
  const existingRecipe = deps.recipeStore.get(row.recipe_id);
  if (existingRecipe !== null && hasNonEmptyWebhookDeclarations(existingRecipe)) {
    return {
      result: {
        ok: false,
        failure: {
          code: 'validator_rejected',
          message: `recipe.installBySlug: ${D201_WEBHOOK_RUNTIME_UNAVAILABLE}`,
        },
      },
    };
  }

  const now = deps.now?.() ?? Date.now();
  // Persist with the MARKETPLACE-authoritative `publisher_id` (vault scope is
  // keyed by publisher_id — never trust a client-supplied one). `'pair-sync'`
  // source mirrors the pack install path; `save()` fires the roster-mutation
  // hook so trigger reconciliation runs exactly as for `recipe.save`.
  deps.recipeStore.save(row.recipe, row.publisher_id, 'pair-sync', now);

  // § 7 surfacing — disclose the recipe's run-time PII posture (same projection
  // `recipe.save` returns). Fail-safe (null when nothing to disclose).
  const pii = assessRecipePiiPosture(row.recipe);
  return {
    result: {
      ok: true,
      recipe_id: row.recipe_id,
      version: row.version,
      name: row.recipe.metadata?.name ?? row.recipe_id,
      publisher_id: row.publisher_id,
      ...(pii !== null
        ? {
            pii: {
              ...(pii.headline !== '' ? { headline: pii.headline } : {}),
              ...(pii.auto_protected.length > 0
                ? { auto_protected: pii.auto_protected.map((l) => l.message) }
                : {}),
              ...(pii.warnings.length > 0
                ? { warnings: pii.warnings.map((l) => l.message) }
                : {}),
              ...(pii.infos.length > 0 ? { infos: pii.infos.map((l) => l.message) } : {}),
            },
          }
        : {}),
    },
  };
};

type PackInstallMethods =
  | 'packs.install'
  | 'packs.install_preview'
  | 'packs.installBySlug'
  | 'packs.resolveBySlug'
  | 'recipe.installBySlug';

export const makePackInstallHandlers = (
  deps: PackInstallRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, PackInstallMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'packs.install', 'packs.install_preview', 'packs.installBySlug',
      'packs.resolveBySlug', 'recipe.installBySlug',
    ],
    handlers: {
      'packs.install': async (args) =>
        handlePacksInstall(
          deps,
          args as Parameters<typeof handlePacksInstall>[1],
        ),
      // D-247 D15 — the disclosure the picker reads. Runs the install's OWN
      // resolver, so it cannot name a different set from the one the install
      // enables; a malformed manifest resolves to `resolved: false` rather than
      // throwing, because the picker's honest fallback is to render nothing.
      'packs.install_preview': async (args) => {
        const { manifest } = parsePacksInstallArgs({
          manifest: (args as { manifest: unknown }).manifest,
          granted_permissions: [],
        } as never);
        // D-311 — a pack the dialog resolved from the marketplace installs through
        // `packs.installBySlug`, which takes its recipes and the packs it brings in
        // from the marketplace. The preview resolves them the same way, or it
        // describes an install that will not happen.
        const fromMarketplace = (args as { marketplace?: unknown }).marketplace === true;
        const previewDeps = fromMarketplace
          ? await marketplacePreviewDeps(deps, manifest)
          : deps;
        const preview = await buildPackInstallPreview(manifest, {
          recipeStore: previewDeps.recipeStore,
          ...(previewDeps.resolveMarketplaceRecipe
            ? { resolveMarketplaceRecipe: previewDeps.resolveMarketplaceRecipe }
            : {}),
          getManifest: (slug: string) => deps.getManifest?.(slug),
        });
        const webhookPlan = await webhookPlanFor(previewDeps, manifest);
        // D-305 — what the packs it brings in need, so the dialog can grant it.
        const dependencyRequires = dependencyRequirementsFor(previewDeps, manifest);
        // D-310 — and the packs themselves, so the dialog can ask what each may do;
        // REV 2 — and what this pack's own workflows need from its own Access.
        const accessNeeds = await installAccessNeedsFor(previewDeps, manifest);
        const dependencyPacks = accessNeeds?.dependency_packs;
        // The packs it needs and does not bring in, which the install would refuse
        // it for: named before the owner chooses anything, so the dialog can offer them.
        const missing = await installMissingPacksFor(previewDeps, manifest);
        // …each by its name where the server can tell, so the dialog offers "Federated
        // Projects" rather than a slug.
        const missingPacks = missing === undefined ? undefined : await nameMissingPacks(
          previewDeps,
          missing,
          fromMarketplace ? (deps.marketplaceFetch ?? defaultMarketplaceFetch) : undefined,
        );
        // D-296 — an armed automation this update switches off, named before
        // the owner presses Update.
        const triggerPreview = deps.getTriggerPreview?.();
        const receptionPairs = deps.getReceptionPairs?.();
        const savedSettings = deps.getSavedSettings?.();
        const incoming = triggerPreview === undefined && receptionPairs === undefined && savedSettings === undefined
          ? []
          : await installIncomingRecipes(previewDeps, manifest);
        const switchedOff = triggerPreview === undefined
          ? []
          : triggersSwitchedOff({ preview: triggerPreview, recipes: incoming });
        // D-299 — a Reception form or link this update stops taking submissions.
        const receptionsOff = receptionPairs === undefined
          ? []
          : receptionPairsAtRisk(
            incoming.map((recipe) => ({
              recipe_id: recipe.recipe_id,
              before: deps.recipeStore.get(recipe.recipe_id),
              after: recipe.definition,
            })),
            receptionPairs,
          ).map(({ endpoint_id, name, reason }) => ({ endpoint_id, name, reason }));
        // D-303 — a setting the owner saved that this update stops using.
        const settingsDropped = savedSettings === undefined
          ? []
          : settingsNoLongerUsed(
            incoming.map((recipe) => ({
              recipe_id: recipe.recipe_id,
              before: deps.recipeStore.get(recipe.recipe_id),
              after: recipe.definition,
            })),
            savedSettings,
          ).map(({ recipe_id, recipe, setting }) => ({ recipe_id, recipe, setting }));
        // Widen the readonly view to the rpc's mutable wire shape.
        return {
          resolved: preview.resolved,
          hidden_count: preview.hidden_count,
          ...(webhookPlan !== undefined ? { webhook_plan: webhookPlan } : {}),
          ...(dependencyRequires !== undefined ? { dependency_requires: dependencyRequires } : {}),
          ...(dependencyPacks !== undefined ? { dependency_packs: dependencyPacks } : {}),
          ...(accessNeeds?.own_needs !== undefined ? { own_needs: accessNeeds.own_needs } : {}),
          ...(missingPacks !== undefined ? { missing_packs: missingPacks } : {}),
          ...(switchedOff.length > 0 ? { triggers_switched_off: switchedOff } : {}),
          ...(receptionsOff.length > 0 ? { receptions_switched_off: receptionsOff } : {}),
          ...(settingsDropped.length > 0 ? { settings_no_longer_used: settingsDropped } : {}),
          will_enable: preview.will_enable.map((r) => ({
            publisher_id: r.publisher_id,
            recipe_id: r.recipe_id,
            name: r.name,
            grant_class: r.grant_class,
            top_risk: r.top_risk,
            operation_ids: [...r.operation_ids],
          })),
        };
      },
      // Install seam 5c — marketplace-fetch install paths sharing the same
      // `packInstallDeps` (recipeStore + marketplaceFetch). Both inherit the
      // already-forwarded `packInstallDeps` slice registration, so they are live
      // over the wire without a new `server.ts` forward.
      'packs.installBySlug': async (args) =>
        installPackBySlug(deps, args as Parameters<typeof installPackBySlug>[1]),
      // Add-a-pack (2026-07-01) — manifest-only preview for the install consent
      // dialog; reuses the same `marketplaceFetch` dep as installBySlug.
      'packs.resolveBySlug': async (args) =>
        resolvePackBySlug(deps, args as Parameters<typeof resolvePackBySlug>[1]),
      'recipe.installBySlug': async (args) =>
        installRecipeBySlug(deps, args as Parameters<typeof installRecipeBySlug>[1]),
    },
  };
};
