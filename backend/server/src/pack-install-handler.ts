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
 *  Spec: `docs/d-145-spec.md` § PA10 (pack-shipped Standing
 *  Instructions). */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  BULK_PACK_INSTALL_PERMISSION,
  isInstallGrantSelection,
  isPureWorkflowRecipe,
  normalizeBulkPackInstallPlan,
  parseBulkPackManifest,
  parseRecipeBundleKey,
  recipeTrustStateForPureWorkflow,
  RpcError,
  validateRecipeBundlePublisher,
  type BulkPackInstallResultLike,
  type BulkPackManifest,
  type CompositionIngredient,
  type HandlerSlice,
  type InstallGrantSelection,
  type PackContentRef,
  type PackInstallPlan,
  type PacksResolveResult,
  type RecipeDefinition,
  type RecipePiiDisclosureEntry,
  type RecipeRunnabilityEntry,
  type RecipeTrustState,
  type ServerRpcRegistry,
} from '@recued/contracts';
import { validatePack } from '@recued/ingredient-authoring';
import {
  BulkPackFetchError,
  fetchBulkPackBySlug,
  fetchRecipeBySlug,
  type BulkPackInstallInput,
  type BulkPackInstallRecipe,
  type MarketplaceRecipeResult,
} from '@recued/marketplace';
import { hashRecipe, validateRecipe } from '@recued/recipes';

import { assessRecipePiiPosture } from './auto-pii-apply.js';
import {
  applyInstallAudienceGrantIds,
  provisionPackCompositionForBulkInstall,
  resolvePackOpStepRecipes,
  type SellerInstallAudienceStore,
} from './ingredient-authoring/install-composition.js';
import type { LocalManifestStore } from './ingredient-authoring/local-manifest-store.js';
import { installBulkPackOnServer } from './install-bulk-pack-handler.js';
import type { ManifestRegistry } from './manifest-loader.js';
import { buildPackOpResolution, recordPackInventory } from './pack-inventory.js';
import { validateRecipeInline } from './recipe-save-handler.js';
import type { RecipeStore } from './recipe-store.js';
import type { RecipeRunnabilityBroadcaster } from './recipe-runnability-handler.js';
import {
  D201_WEBHOOK_RUNTIME_UNAVAILABLE,
  hasNonEmptyWebhookDeclarations,
} from './webhook-declaration-gate.js';
import type { ContractStore } from './storage/contract-store.js';
import type { ChatInboundTokenStore } from './storage/chat-inbound-token-store.js';
import type { McpBodyVisibilityStore } from './storage/mcp-body-visibility-store.js';
import type { WebhookConsumerStore } from './storage/webhook-consumer-store.js';
import type { WsClient } from './ws-server.js';

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
  /** D-201 Slice 4 — owner-approved pack webhook bindings. */
  webhookConsumerStore?: WebhookConsumerStore;
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
   *  dependency packs — each pack that carries a composition needs its own
   *  dialog grant (a dependency's composition fails closed to its authored
   *  defaults; the owner grants it later via Settings). */
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

/** Default community/packs directory resolution. Mirrors `packs.list` and
 *  `packs.uninstall` so list/install/uninstall agree on the bundled root. */
const findCommunityPackDir = (): string => {
  const projectRoot = resolve(import.meta.dirname ?? __dirname, '..', '..', '..');
  return join(projectRoot, 'community', 'packs');
};

const walkJsonFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
};

const resolveBundledPackManifest = (
  packDir: string,
  packSlug: string,
): BulkPackManifest | null => {
  for (const file of walkJsonFiles(packDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    const result = parseBulkPackManifest(parsed);
    if (result.ok && result.manifest.slug === packSlug) return result.manifest;
  }
  return null;
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

const collectTransitivePackRequirements = (
  manifest: BulkPackManifest,
  packDir: string,
  required: Set<string>,
  visiting: Set<string>,
  visited: Set<string>,
  manifestsBySlug: Map<string, BulkPackManifest>,
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
    const dependencyManifest = resolveBundledPackManifest(packDir, dependency.slug);
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
    for (const permission of dependencyManifest.requires) required.add(permission);
    const failure = collectTransitivePackRequirements(
      dependencyManifest,
      packDir,
      required,
      visiting,
      visited,
      manifestsBySlug,
    );
    if (failure !== null) return failure;
  }
  visiting.delete(manifest.slug);
  visited.add(manifest.slug);
  return null;
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
    deps.packDir ?? findCommunityPackDir(),
    required,
    new Set(),
    new Set(),
    manifestsBySlug,
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

const installSinglePack = async (
  deps: PackInstallRpcDeps,
  args: PacksInstallArgs,
  options: { omitRecipeKeys?: ReadonlySet<string> } = {},
): Promise<{ result: BulkPackInstallResultLike }> => {
  const { manifest } = parsePacksInstallArgs(args);
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
  const canProvisionComposition =
    compositionRefs.length > 0
    && deps.contractStore !== undefined
    && deps.localManifestStore !== undefined
    && deps.registry !== undefined;
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
        publisher_id: marketplaceRow?.publisher_id ?? manifest.publisher,
        version: recipeVersion,
        recipe_hash: hashRecipe(recipe),
        recipe,
      },
      ...(recipeVersion !== ref.version ? { failure: 'version_drift' as const } : {}),
    });
  }
  const ready = resolved.every((r) => r.recipe != null && r.failure == null);

  // Pure-workflow trust is a property of the AUTHORED recipe (an all-entity-op
  // recipe is pure-workflow — D-170 N.18), but the A3 rewrite below replaces an
  // op-step with a catalog fetch + a projection `map` transform, which would drop
  // it out of the tier post-resolution. Snapshot the authored defs (parallel to
  // `resolved`) BEFORE the rewrite so trust is classified from what the author
  // wrote, then applied to the persisted (resolved) recipe id/version.
  const authoredRecipeDefs = resolved.map((r) => r.recipe?.recipe ?? null);

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
    const composition = compositionRefs[0]?.composition as CompositionIngredient | undefined;
    const recipeDefs = resolved.map((r) => r.recipe!.recipe);
    // D-182 Slice 4 — the Tier-P `pack_ref → catalog` map this pack's recipes'
    // `depends_on` ops resolve against, built from the installed-pack inventory +
    // the live registry. A pure-workflow consumer pack (media-transcribe →
    // recued-core.whisper) resolves its already-installed dependency packs' ops.
    // Empty unless BOTH the inventory store + registry are present (db-less boot);
    // INERT on the current corpus (no two-tier op ids until the Slice-4 rewrite).
    const packOpResolution =
      deps.contractStore !== undefined && deps.registry !== undefined
        ? buildPackOpResolution(
            () => deps.contractStore!.scan('installed_pack'),
            (slug) => deps.registry!.get(slug) ?? null,
            // Exclude this pack's own pack_ref — a reinstall's stale prior row
            // must not resolve its own recipes' self-references.
            `${manifest.publisher}.${manifest.slug}`,
          )
        : undefined;
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

  const result = await installBulkPackOnServer(input, granted, {
    recipeStore: deps.recipeStore,
    ...(deps.webhookConsumerStore
      ? { webhookConsumerStore: deps.webhookConsumerStore }
      : {}),
    ...(deps.webhookDoor ? { webhookDoor: deps.webhookDoor } : {}),
    ...(deps.mcpBodyVisibilityStore
      ? { mcpBodyVisibilityStore: deps.mcpBodyVisibilityStore }
      : {}),
    now,
  });
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
  let compositionProvisioned = false;
  if (result.ok && canProvisionComposition) {
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
  if (compositionProvisioned && result.ok) {
    const remaining = (result.deferred_contents ?? []).filter((c) => c.type !== 'composition');
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
  const packDir = deps.packDir ?? findCommunityPackDir();
  const dependencyResults: BulkPackInstallResultLike[] = [];
  const dependencyRecipeKeys = new Set<string>();

  for (const dependency of manifest.dependencies ?? []) {
    if (dependency.type !== 'pack') continue;
    const dependencyManifest = resolveBundledPackManifest(packDir, dependency.slug);
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

    const dependencyOutcome = await handlePacksInstallInternal(
      deps,
      {
        manifest: dependencyManifest,
        granted_permissions: args.granted_permissions,
        ...(args.webhook_bindings !== undefined
          ? { webhook_bindings: args.webhook_bindings }
          : {}),
      },
      context,
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

export const handlePacksInstall = async (
  deps: PackInstallRpcDeps,
  args: PacksInstallArgs,
): Promise<{ result: BulkPackInstallResultLike }> => {
  const { manifest } = parsePacksInstallArgs(args);
  const preflight = preflightTransitivePermissions(deps, args, manifest);
  if (preflight !== null) return { result: preflight };
  const { result } = await handlePacksInstallInternal(
    deps,
    args,
    { visiting: new Set(), installed: new Set(), recipeKeysByPack: new Map() },
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

/** Install seam 5c — server-side marketplace fetches get a bounded timeout so a
 *  hung connection can't leave the install RPC pending forever (mirrors the
 *  `AbortSignal.timeout` pattern in `daemon.ts`). On timeout the fetch aborts →
 *  the marketplace client throws → it is mapped to a result-body failure. Tests
 *  inject their own `marketplaceFetch`, so only the production default is wrapped. */
const MARKETPLACE_FETCH_TIMEOUT_MS = 10_000;

const defaultMarketplaceFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
  });

type PacksInstallBySlugArgs = {
  slug: string;
  granted_permissions: ReadonlyArray<string>;
  install_scope?: InstallGrantSelection;
  /** D-194 2b — forwarded verbatim to `packs.install`. See `PacksInstallArgs`. */
  chosen_connection?: string;
  /** D-201 Slice 4 — forwarded verbatim to the by-value install validator. */
  webhook_bindings?: PacksInstallArgs['webhook_bindings'];
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

  const fetchFn = deps.marketplaceFetch ?? defaultMarketplaceFetch;
  let manifest: BulkPackManifest | null;
  try {
    manifest = await fetchBulkPackBySlug(args.slug, fetchFn);
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

  // Build the marketplace recipe resolver from the SAME fetch — present ONLY on
  // this by-slug call. It returns the full row because the constituent recipe's
  // marketplace `publisher_id` remains authoritative independently of the pack's
  // publisher. A clean 404 on a constituent recipe → null → the resolution loop
  // records `not_found` (→ engine `ok: false,
  // unresolved`); a hard fetch error throws → caught below as an `unexpected`
  // result, so a transient blip never masquerades as `not_found` or a raw rpc
  // error.
  const resolveMarketplaceRecipe = async (slug: string): Promise<MarketplaceRecipeResult | null> => {
    const row = await fetchRecipeBySlug(slug, fetchFn);
    if (row == null) return null;
    // Slug-confusion guard — the install txn keys on `recipe.recipe_id`, so a
    // marketplace row whose identity disagrees with the requested slug must NOT
    // be installed under that slug. Fail closed → the loop records `not_found`
    // → the pack install fails `unresolved` rather than persisting a mismatch.
    if (row.recipe_id !== slug || row.recipe.recipe_id !== slug) return null;
    return row;
  };

  try {
    return await handlePacksInstall(
      { ...deps, resolveMarketplaceRecipe },
      {
        manifest,
        granted_permissions: args.granted_permissions,
        ...(args.install_scope !== undefined ? { install_scope: args.install_scope } : {}),
        ...(args.chosen_connection !== undefined ? { chosen_connection: args.chosen_connection } : {}),
        ...(args.webhook_bindings !== undefined
          ? { webhook_bindings: args.webhook_bindings }
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
  const fetchFn = deps.marketplaceFetch ?? defaultMarketplaceFetch;
  let manifest: BulkPackManifest | null;
  try {
    manifest = await fetchBulkPackBySlug(args.slug, fetchFn);
  } catch (e) {
    return resolveFetchErrorToResult(e);
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
  return { manifest };
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
    row = await fetchRecipeBySlug(args.slug, fetchFn);
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
  | 'packs.installBySlug'
  | 'packs.resolveBySlug'
  | 'recipe.installBySlug';

export const makePackInstallHandlers = (
  deps: PackInstallRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, PackInstallMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['packs.install', 'packs.installBySlug', 'packs.resolveBySlug', 'recipe.installBySlug'],
    handlers: {
      'packs.install': async (args) =>
        handlePacksInstall(
          deps,
          args as Parameters<typeof handlePacksInstall>[1],
        ),
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
