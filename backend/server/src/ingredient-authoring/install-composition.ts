/** D-170 — composition install provisioner (N.14 / N.16).
 *
 *  The decompose→write install_planner the direct-manifest install path drives.
 *  Given a `CompositionIngredient` body (bare 1×1) or an app_pack carrying a
 *  composition by value, it:
 *
 *    1. Validates by DECOMPOSING + reusing the D-165 validators (the pure
 *       `@recued/ingredient-authoring` validators — `validated ⇒ decomposable`,
 *       so a passing validation cannot throw at decompose time).
 *    2. Guards slug collisions (R12 — never silently overwrite a foreign,
 *       non-locally-authored artifact).
 *    3. Atomically (one shared-db transaction) persists the decomposed body to
 *       the local manifest store AND records `installed_pack` /
 *       `installed_ingredient` inventory.
 *    4. Registers the catalog / ingredient into the LIVE manifest registry so
 *       the gateway resolves its operations exactly as for a marketplace
 *       ingredient (N.16). Boot re-registers from the local store, so a missed
 *       register self-heals on the next start.
 *
 *  Scope (the install-integration core): it provisions composition CAPABILITY.
 *  A 1×1 composition installs as a standalone ingredient; a wider composition
 *  must arrive wrapped in an app_pack (the container that links its decomposed
 *  children via `installed_pack.ingredient_ids` — a bare wide composition has no
 *  pack slug to key the link). Non-composition pack contents (bundled recipes,
 *  etc.) are NOT provisioned here — they install through the recipe engine path
 *  (`packs.install`); this surfaces them as a `warn` rather than dropping them
 *  silently.
 *
 *  Grant provisioning (D-165 P3 install planner, supersedes the D-170 #7
 *  disclosure-only stopgap): a composition's decomposed `default_grants` are now
 *  WRITTEN as pack-owned `contract.grant` rows keyed on the pack's real
 *  `installed_pack_id` (`writePackGrants`, inside the install transaction), so each
 *  grant tracks its owning pack and uninstall drops exactly that pack's rows
 *  (per-pack isolation). They become effective at dispatch via the profile-union
 *  (Path A — `connection-operation-profile-boot` unions `listPackOwnedGroups` into
 *  the `ConnectionOperationProfile` seed) for any connection that HAS a profile. A
 *  composition's grants reference its OWN (private/local) catalog, which has no
 *  operation profile yet (the separate D-170 grant-panel registration follow-on,
 *  "gap #2"), so they are recorded + isolated here but not yet effective at dispatch
 *  — `grantProvisioningNote` discloses that honestly.
 *
 *  Atomicity note: `contractStore` and `localManifestStore` are both per-pair
 *  stores over the SAME better-sqlite3 db, so wrapping both writes in
 *  `contractStore.transaction` makes body + inventory commit together or not at
 *  all (the nested `recordPackInventory` transaction degrades to a SAVEPOINT).
 *  `registry.register` is in-memory and runs after the commit.
 *
 *  Spec: D-170 § N.14, N.16; the install rpc surface is N.15. */

import { isDeepStrictEqual } from 'node:util';

import {
  decomposeComposition,
  stampPackOwnedManifest,
  validateComposition,
  validatePack,
  type CompositionValidationIssue,
  type DecomposedArtifacts,
  type PackDecomposition,
} from '@recued/ingredient-authoring';
import { GENERATED_PACK_PUBLISHER } from '@recued/contracts';
import { validateIngredient } from '@recued/ingredients/validate';
import {
  validateRecipe,
  resolveConnectionAgnosticRecipe,
  connectionVariableNames,
  opStepConnectionSlots,
  parseOpStepConnectionRef,
  OP_STEP_CONNECTION_REF_REGEX,
  CanonicalOpResolutionError,
  lowerOpStepRecipe,
  type PackOpResolution,
} from '@recued/recipes';
import {
  isPureWorkflowRecipe,
  recipeTrustStateForPureWorkflow,
  entityFieldsFromRegistry,
  vendorEntitiesFromComposition,
  isCanonicalOpStep,
  isPrefetchOpStep,
  getKernelDomain,
  parseOpId,
  isSearchStyle,
  isWriteStyle,
  opGrantEntry,
  OWNER_CONTRACT_ID,
  CATALOG_VENDOR_SLUGS,
  CONNECTION_VENDOR_ENTITIES,
  assertEngagementRegistryInvariants,
} from '@recued/contracts';
import type {
  AuthoringValidationIssue,
  CatalogKind,
  CompositionIngredient,
  ConnectionVendorEntity,
  EntitySchemaIngredientInput,
  IngredientInstallResult,
  IngredientManifest,
  InstallAccessTier,
  InstallAudienceSelection,
  InstallGrantSelection,
  InstallScopeWho,
  OperationRiskTier,
  OperationRow,
  PackContentRef,
  PackOperationGroupContentRef,
  PackResolutionContext,
  ProviderSurfaces,
  RecipeDefinition,
  RecipeTrustState,
  SearchStyle,
  WriteStyle,
} from '@recued/contracts';

import type { ManifestRegistry } from '../manifest-loader.js';
import {
  ingredientOwnership,
  buildPackOpResolution,
  isIngredientPackOwned,
  isPrivateByoIngredient,
  packIngredientIds,
  recordPackInventory,
  recordStandaloneIngredient,
} from '../pack-inventory.js';
import type { RecipeStore } from '../recipe-store.js';
import type { ContractStore } from '../storage/contract-store.js';
import { createContractGrantStore } from '../storage/contract-grant-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import type { ChatInboundTokenStore } from '../storage/chat-inbound-token-store.js';
import { gateGrantGoverningContractId } from '../grant-governing-contract.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import type { LocalManifestStore } from './local-manifest-store.js';

interface RecipeTrustWriter {
  set(state: RecipeTrustState): void | Promise<void>;
}

export interface SellerInstallAudienceStore {
  listCustomers(): readonly {
    contract_id: string;
    tier_id?: string;
    inbound_token_id?: string | null;
    mcp_token_id?: string | null;
  }[];
}

type InstallAudienceInboundTokenStore = Pick<
  ChatInboundTokenStore,
  'getTokenById' | 'updateTokenGrants'
>;

const DEFAULT_AUTHOR = 'recued-core';
const COMPOSITION_VALIDATION_OPTS = { recipeValidator: validateRecipe };

export interface ProvisionAuthoredDeps {
  /** Persistent body store for decomposed catalog / ingredient / entity-schema
   *  bodies (keyed `slug@version`). MUST share its db with `contractStore`. */
  localManifestStore: LocalManifestStore;
  /** Gateway-read-only `contract.*` store — the `installed_pack` /
   *  `installed_ingredient` inventory home. MUST share its db with
   *  `localManifestStore`. */
  contractStore: ContractStore;
  /** Live manifest registry the gateway resolves through. `register` lands the
   *  catalog for immediate resolution (N.16); `get` checks slug collisions;
   *  `unregister` drops a prior catalog a pack reinstall renamed away. */
  registry: Pick<ManifestRegistry, 'register' | 'get' | 'unregister'>;
  /** Epoch-ms clock for inventory `installed_at`. */
  now: () => number;
  /** Optional recipe store used by N.18 to persist compiled workflow recipes. */
  compiledRecipeStore?: Pick<RecipeStore, 'save'>;
  /** Optional staged-trust store; pure-workflow recipes are marked auto-trusted. */
  recipeTrustStore?: RecipeTrustWriter;
  /** D-170 gap #2 live-reconcile — when wired, called POST-COMMIT with the
   *  composition's bound `auth.connection` so its operation profile is (re)derived
   *  the moment the binding + pack grants land (the connection row is unchanged, so
   *  the profile-boot upsert observer never fires for an install). Lets a
   *  connect-BEFORE-install dispatch work at once instead of waiting for the next
   *  reconnect/boot. Omitted (dbless / no profile store) → the binding still commits;
   *  the profile seeds on the next connect/boot (fail-closed until then, never
   *  over-granted). Never called for a connection-less composition. */
  reconcileConnectionProfile?: (connectionName: string) => void;
  /** D-192 — post-commit register/unregister of the bound connection's
   *  pack-declared work-entity Sources (enroll-before-install; sibling of
   *  `reconcileConnectionProfile`). Omitted (dbless / no work-entity store) → the
   *  binding still commits; Sources register on the next connection upsert / boot. */
  reconcileWorkEntitySources?: (connectionName: string) => void;
  /** Connection-agnostic op dispatch (slice 2) — map a bound catalog slug to its
   *  registry vendor, so a bundled recipe's `CanonicalOpStep`s resolve their
   *  field mapping from the registry (keyed by vendor). Omitted → the default
   *  reverse-`CATALOG_VENDOR_SLUGS` lookup (the single vendor↔catalog source of
   *  truth). Injected by tests / future 3rd-party vendor resolution. A catalog
   *  with no vendor → op-step recipes hard-block (their canonical fields can't be
   *  projected); non-op-step recipes are unaffected. */
  vendorForCatalog?: (catalogSlug: string) => string | undefined;
  /** D-196 install grant audiences — used by `all_customers` /
   *  `all_other_contracts` fan-out. Optional so pre-seller/db-less install
   *  paths keep their old shape. */
  sellerStore?: SellerInstallAudienceStore;
  /** D-196 static customer grant snapshots. When present, audience rollout
   *  reconciles the selected customer contract's existing bearer grant map in
   *  lockstep; ordinary MCP token checklists remain untouched. */
  inboundTokenStore?: InstallAudienceInboundTokenStore;
}

/** Narrow reinstall controls for callers that have already proved the incoming
 * body is authority-equivalent to the installed one. Ordinary owner-driven
 * installs MUST leave this absent: they replace the pack-owned authority rows
 * with the choices made in the current install review. */
export interface ProvisionPackCompositionOptions {
  /** Preserve every existing grant, connection binding, and audience fan-out
   * row byte-for-byte while replacing only the pack body + the existing pack
   * row's version field. Used by the closed launch-reconciliation ledger; never
   * inferred from a manifest and never exposed through an RPC. */
  preserveExistingAuthority?: boolean;
  /** Compare-and-swap fence for boot reconciliation. Checked inside the SAME
   * SQLite transaction, before the body write, so a concurrent uninstall or
   * update cannot be silently resurrected/overwritten from an earlier scan. */
  expectedInstalledState?: {
    /** Exact row value observed by the reconciler. The update preserves every
     * field except `version`, rather than rebuilding inventory metadata. */
    installed_pack: Record<string, unknown>;
    /** Exact catalog inventory row observed by the reconciler. It is not
     * rewritten, but belongs in the CAS so a concurrent ownership change cannot
     * turn the catalog into shared state before its body is replaced. */
    installed_ingredient: Record<string, unknown>;
    body: IngredientManifest;
    entity_schemas: readonly EntitySchemaIngredientInput[];
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const toIssue = (i: CompositionValidationIssue): AuthoringValidationIssue => ({
  severity: i.severity,
  code: i.code,
  path: i.path,
  message: i.message,
});

const warningsFrom = (issues: AuthoringValidationIssue[]): AuthoringValidationIssue[] =>
  issues.filter((i) => i.severity !== 'error');

// ────────────────────────────────────────────────────────────────
// Connection-agnostic op dispatch (slice 2) — R1 install-time rewrite
// ────────────────────────────────────────────────────────────────

/** Reverse of `CATALOG_VENDOR_SLUGS` (catalog slug → vendor) — the default
 *  `vendorForCatalog`. An op-step recipe resolves its field mapping from the
 *  registry keyed by VENDOR, but the install path knows the bound CATALOG; this
 *  inverts the single vendor↔catalog source of truth. A catalog with no
 *  registered vendor → undefined → op-step recipes hard-block. */
const REVERSE_CATALOG_VENDOR: ReadonlyMap<string, string> = new Map(
  Object.entries(CATALOG_VENDOR_SLUGS).map(([vendor, slug]) => [slug, vendor]),
);
const defaultVendorForCatalog = (catalogSlug: string): string | undefined =>
  REVERSE_CATALOG_VENDOR.get(catalogSlug);

/** The built-in vendor ids (HubSpot / Salesforce) — a 3rd-party catalog may not
 *  claim one of these as its own vendor (see `thirdPartyRegistryMerge`). */
const BUILTIN_VENDOR_IDS: ReadonlySet<string> = new Set(
  CONNECTION_VENDOR_ENTITIES.map((e) => e.vendor),
);

/** Connection-agnostic op dispatch (slice 4.5 — 3rd-party registry merge) — for a
 *  pack that carries its integration as a COMPOSITION, derive the vendor + registry
 *  the op-step resolver binds against.
 *
 *  A first-party catalog (slug ∈ `CATALOG_VENDOR_SLUGS`, e.g. a composition that
 *  re-declares `hubspot-catalog` by value) ALWAYS resolves against the FROZEN
 *  built-in registry — the slice-2 "registry is the single, frozen mapping source"
 *  decision wins even when the pack ships its own `entity_fields`. Only a GENUINE
 *  3rd-party catalog (no built-in vendor) lifts the composition's own decomposed
 *  `crm_alias` entities into the registry via `vendorEntitiesFromComposition`,
 *  APPENDED after the built-ins so a 3rd-party can never shadow a first-party
 *  entity, and maps its decomposed catalog slug → its derived `wraps_vendor`.
 *
 *  Returns the base resolver + built-in registry unchanged when there's nothing to
 *  merge (built-in catalog, or a composition with no `crm_alias` entities — the
 *  op-step then hard-blocks downstream as "not a known CRM vendor catalog"). Pure. */
const thirdPartyRegistryMerge = (
  bodySlug: string,
  entitySchemas: DecomposedArtifacts['entity_schemas'],
  baseVendorForCatalog: (slug: string) => string | undefined,
): {
  vendorForCatalog: (slug: string) => string | undefined;
  registry: ReadonlyArray<ConnectionVendorEntity>;
} => {
  if (baseVendorForCatalog(bodySlug) !== undefined) {
    // First-party catalog (by slug) — the frozen built-in registry is authoritative.
    return { vendorForCatalog: baseVendorForCatalog, registry: CONNECTION_VENDOR_ENTITIES };
  }
  const vendorEntities = vendorEntitiesFromComposition(entitySchemas ?? []);
  if (vendorEntities.length === 0) {
    // No CRM entities to merge — nothing to bind a canonical op against.
    return { vendorForCatalog: baseVendorForCatalog, registry: CONNECTION_VENDOR_ENTITIES };
  }
  // SECURITY (slice 4.5): a 3rd-party catalog must not CLAIM a built-in vendor id
  // (e.g. `auth.connection: 'hubspot'` → `wraps_vendor: 'hubspot'`). Were it allowed,
  // its op-step would BORROW the first-party field mapping + the HubSpot/Salesforce
  // search builder (the search fail-closed path is keyed by vendor id) while
  // dispatching against the 3rd-party's OWN catalog/connection — an off-contract
  // resolution. (Built-ins already win the registry crm_alias lookup via append-after
  // first-wins, and an entity-name collision hard-blocks on duplicate `maps_to`; this
  // additionally closes the search-builder borrow the ordering alone doesn't cover.)
  // A genuine 3rd-party vendor id is distinct by construction, so on collision we
  // refuse the merge and let the op-step hard-block downstream ("not a known CRM
  // vendor catalog") — fail-closed.
  if (vendorEntities.some((e) => BUILTIN_VENDOR_IDS.has(e.vendor))) {
    return { vendorForCatalog: baseVendorForCatalog, registry: CONNECTION_VENDOR_ENTITIES };
  }
  // D-192 — fail-closed on an internally-inconsistent engagement declaration in
  // THIS composition (its engagement entities disagreeing on sync_kind /
  // daily_budget / group capability): the first-match live-registry helpers would
  // read whichever entity sorts first, so refuse the whole merge exactly as the
  // builtin-vendor-id case does. Scope note: this resolves ONE composition against
  // the built-ins, so it catches the composition's OWN inconsistency but NOT a
  // cross-pack conflict with an already-installed manifest sharing the same vendor
  // id — that is caught at runtime by `liveVendorRegistry` (which walks every
  // manifest). Only the engagement invariants (not the full
  // `assertConnectionVendorRegistry`, whose vendor-id regex would reject legit
  // hyphenated pack vendors).
  if (assertEngagementRegistryInvariants(vendorEntities).length > 0) {
    return { vendorForCatalog: baseVendorForCatalog, registry: CONNECTION_VENDOR_ENTITIES };
  }
  const registry: ReadonlyArray<ConnectionVendorEntity> = [
    ...CONNECTION_VENDOR_ENTITIES,
    ...vendorEntities,
  ];
  // The composition's vendor — read off a LIFTED entity (not the raw schemas) so it
  // can never diverge from what was actually merged: a CRM schema whose `wraps_vendor`
  // is missing is skipped by the lifter, so the first raw schema could otherwise name
  // a vendor that isn't in the registry. Every lifted entity carries a non-empty
  // vendor, and all share one (the decomposer derives `wraps_vendor` once per
  // composition from `auth.connection ?? slug`).
  const schemaVendor = vendorEntities[0].vendor;
  const vendorForCatalog = (slug: string): string | undefined =>
    slug === bodySlug ? schemaVendor : baseVendorForCatalog(slug);
  return { vendorForCatalog, registry };
};

/** Canonical CRM verbs whose op returns a COLLECTION (records array) — the only
 *  ops for which `result_path` matters (a single `read` returns one object).
 *
 *  §5 tool-op pack seam: a TOOL op (`op_kind: 'tool'`, e.g. `web.search`) carries
 *  the verb `search` too, but it dispatches PASS-THROUGH with a fixed
 *  `result_path: ''` (the raw response IS the output — no projection, no records
 *  envelope), so the empty-result_path warning below MUST NOT fire for it. Every
 *  warning site gates on `op_kind !== 'tool'` before this membership test. */
const COLLECTION_CANONICAL_VERBS: ReadonlySet<string> = new Set(['search']);

/** Does a recipe carry a `CanonicalOpStep` in its executable `steps`? */
const hasCanonicalOpStep = (recipe: RecipeDefinition): boolean =>
  recipe.steps.some(isCanonicalOpStep);

/** Does a recipe carry ANY op-step in `prefetch_steps`? Used to TRIGGER op-step
 *  handling (the resolver short-circuits + the provisioning gate) — a prefetch
 *  op-step still needs lowering even though it isn't vendor-bound. D-182 Slice 4
 *  — a kernel / Tier-P prefetch op-step is now LOWERED (`lowerOpStepRecipe`) into a
 *  concrete fetch (it is NOT hard-blocked); only `hasNonPrefetchableOpStepInPrefetch`
 *  below rejects. */
const hasOpStepInPrefetch = (recipe: RecipeDefinition): boolean =>
  (recipe.prefetch_steps ?? []).some(isPrefetchOpStep);

/** D-182 Slice 4 — a prefetch op-step that CANNOT lower to a single fetch and so
 *  is hard-blocked from `prefetch_steps`: a canonical-convention kernel op
 *  (`core.crm.*` / `core.acct.*`) or a legacy bare canonical / malformed op
 *  (`deal.search`, `parseOpId === null`). Both decompose into a fetch + a projection
 *  transform, which the ingredient-calls-only prefetch phase can't hold — they must
 *  live in `steps`. A kernel closed-kind read or a Tier-P vendor raw read PASSES
 *  (it lowers to one fetch). Mirrors `lowerPrefetchOpStep`'s admit/reject split so
 *  the install hard-block surfaces a clean message before the lowering would throw. */
const hasNonPrefetchableOpStepInPrefetch = (recipe: RecipeDefinition): boolean =>
  (recipe.prefetch_steps ?? []).some((step) => {
    if (!isPrefetchOpStep(step)) return false;
    const parsed = parseOpId(step.op);
    if (parsed === null) return true; // legacy bare canonical / malformed
    return parsed.tier === 'kernel'
      && getKernelDomain(parsed.domain)?.class === 'canonical_convention';
  });

/** A3 (slice 3) — does any recipe in the set carry a canonical op-step (in `steps`
 *  or `prefetch_steps`)? The `packs.install` handler uses this to fail closed when
 *  bundled op-step recipes are present but the composition they bind to can't be
 *  provisioned (substrate not wired) — they'd otherwise persist pointing at a
 *  catalog that was never registered. */
export const recipesHaveCanonicalOpStep = (recipes: readonly RecipeDefinition[]): boolean =>
  recipes.some((r) => hasCanonicalOpStep(r) || hasOpStepInPrefetch(r));

/** The resolution-context inputs the install path assembles per pack (the field
 *  mapping itself comes from the registry, not here). */
interface OpStepResolutionInputs {
  packSlug: string;
  catalogSlug: string;
  /** the PACK-level default connection for op-steps that name no per-operand
   *  slot (R2 step 5, doc §1.3) — the composition's bound connection
   *  (`auth.connection`) on the composition path; undefined on the first-party
   *  path (each recipe's own `type:'connection'` variable supplies the
   *  default). A slot-less op-step with no default anywhere hard-blocks. */
  connection: string | undefined;
  /** the catalog's surface-level `surfaces.api.result_path` default (`''` =
   *  bare array); a per-op `OperationRow.result_path` overrides it. */
  surfaceResultPath: string;
  /** Connection-agnostic op dispatch (NEXT-1) — the catalog's declared search
   *  DIALECT (`surfaces.api.search_style`); selects the resolver's query builder for
   *  a canonical `<crm_alias>.search`. Omitted (the catalog declares none) → a
   *  canonical `search` op-step fails closed; other verbs are unaffected. */
  searchStyle?: SearchStyle;
  /** Connection-agnostic op dispatch (write-verb reverse projection) — the catalog's
   *  declared WRITE body DIALECT (`surfaces.api.write_style`); selects the resolver's
   *  body builder for a canonical `<crm_alias>.{create,update}`. Omitted (the catalog
   *  declares none) → a canonical `create`/`update` op-step fails closed; `delete`
   *  (selector only) and `read`/`search` are unaffected. */
  writeStyle?: WriteStyle;
  operationFamilies: ReadonlyArray<OperationRow>;
  /** Connection-agnostic op dispatch (slice 4.5 — 3rd-party registry merge) — the
   *  vendor-entity registry the resolver maps `crm_alias`→entity + projects fields
   *  from. Omitted → the built-in `CONNECTION_VENDOR_ENTITIES` (first-party, the
   *  unchanged path). The composition path passes the built-ins merged with the
   *  pack's own `vendorEntitiesFromComposition(...)` (`thirdPartyRegistryMerge`). */
  registry?: ReadonlyArray<ConnectionVendorEntity>;
}

/** Per-operand connection slot plan for ONE recipe (R2 step 5, doc §1.3).
 *
 *  Validates every op-step's explicit `connection` slot (a pure
 *  `{{config.<var>}}` ref naming a declared `type:'connection'` variable —
 *  mirrors the recipe validator, re-checked here so the install path fails
 *  closed on an unvalidated def) and derives the DEFAULT connection for the
 *  recipe's slot-less op-steps:
 *
 *    1. MULTIPLE declared connection variables → hard-block (no implicit
 *       default, every op-step must name its slot — outranks the pack default,
 *       mirroring the validator's `op_step_connection_ambiguous`);
 *    2. else the pack default (`packDefault` — the composition's bound
 *       `auth.connection`) when the pack provides one;
 *    3. else the recipe's SINGLE `type:'connection'` variable
 *       (`{{config.<var>}}` — the established catalog-recipe UX);
 *    4. else hard-block: zero variables → nothing to bind.
 *
 *  This replaces the retired `sharedConnectionRef` ("a first-party pack binds
 *  one connection" + the cross-recipe same-variable rule): connection is
 *  per-OPERAND now — a multi-operand recipe (compare / move / combine) declares
 *  N connection variables and each op-step names its slot; single-target
 *  recipes keep their one implicit variable, byte-identical resolution. */
const opStepConnectionPlan = (
  recipe: RecipeDefinition,
  packDefault: string | undefined,
): { ok: true; defaultConnection: string | undefined } | { ok: false; message: string } => {
  const connVars = connectionVariableNames(recipe);
  let hasSlotless = false;
  for (const step of recipe.steps) {
    if (!isCanonicalOpStep(step)) continue;
    if (step.connection === undefined) {
      hasSlotless = true;
      continue;
    }
    if (!OP_STEP_CONNECTION_REF_REGEX.test(step.connection)) {
      return {
        ok: false,
        message:
          `recipe '${recipe.recipe_id}' op-step '${step.id}' has an invalid connection slot '${step.connection}' — ` +
          `must be a pure {{config.<var>}} ref naming a type:'connection' variable`,
      };
    }
    const varName = parseOpStepConnectionRef(step.connection);
    if (varName !== undefined && !connVars.includes(varName)) {
      return {
        ok: false,
        message:
          `recipe '${recipe.recipe_id}' op-step '${step.id}' connection slot names variable '${varName}', ` +
          `which is not declared as a type:'connection' variable`,
      };
    }
  }
  if (!hasSlotless) return { ok: true, defaultConnection: undefined };
  // The ambiguity rule outranks the pack default (mirrors the validator's
  // `op_step_connection_ambiguous`): a multi-variable recipe has NO implicit
  // default — silently binding its slot-less op-steps to the pack connection
  // would contradict the declared multi-operand intent.
  if (connVars.length > 1) {
    const slotless = recipe.steps.find((s) => isCanonicalOpStep(s) && s.connection === undefined);
    return {
      ok: false,
      message:
        `recipe '${recipe.recipe_id}' declares ${connVars.length} connection variables ` +
        `(${[...connVars].sort().join(', ')}) — op-step '${slotless?.id}' must name its slot explicitly ` +
        `(connection: "{{config.<var>}}")`,
    };
  }
  if (packDefault !== undefined) return { ok: true, defaultConnection: packDefault };
  if (connVars.length === 1) {
    return { ok: true, defaultConnection: `{{config.${connVars[0]}}}` };
  }
  return {
    ok: false,
    message:
      `op-step recipe '${recipe.recipe_id}' has no connection to bind: it declares no type:'connection' ` +
      `variable and the pack provides no bound connection — a connection-agnostic recipe must name its ` +
      `connection so the user can bind one at install`,
  };
};

/** Connection-agnostic op dispatch (slice 2) — R1 install-time rewrite of any
 *  bundled recipe carrying `CanonicalOpStep`s into a concrete vendor-bound
 *  recipe BEFORE it is persisted, so the existing engine / gateway / audit /
 *  grant path runs it unchanged. Pure of writes; runs BEFORE the commit
 *  transaction so a resolution failure aborts the install cleanly.
 *
 *  Fast path: a recipe set with no op-steps passes through untouched (the common
 *  case today — compiled workflow recipes are already concrete).
 *
 *  The field mapping comes from the REGISTRY (frozen, single source — slice-2
 *  decision), keyed by the bound catalog's vendor. The CONNECTION is per-recipe /
 *  per-operand (R2 step 5): each recipe's op-steps bind their explicit slots or
 *  the recipe's derived default (`opStepConnectionPlan`). Hard-blocks (typed
 *  `{ ok: false }`) when op-steps are present but can't bind — the catalog isn't
 *  a known vendor catalog, a slot/default can't be derived, op-steps sit in
 *  `prefetch_steps` (unsupported), or `resolveConnectionAgnosticRecipe` throws
 *  (op the pack doesn't model, no projectable fields, …) — per the three-layer
 *  gate "op-step + no registry entry → hard install-block". WARNs when a
 *  collection op resolved to no `result_path` (the silent-empty trap). */
/** D-182 Slice 4 — the EMPTY Tier-P resolution fallback (the former permanent
 *  seam, now just the default when a caller has no inventory to source from —
 *  db-less / unit paths). Kernel `core.*` + canonical-convention ops never
 *  consult it (kernel → concrete kernel step; canonical → bare op the existing
 *  resolver finishes), so a Slice-4 `core.*` op flows through with no map. A
 *  Tier-P pack op fails closed under it ("no resolved catalog binding"). The real
 *  `pack_ref → catalog` map is built by `buildPackOpResolution` (pack-inventory)
 *  from the installed-pack inventory + manifest registry and passed in at the
 *  install / dispatch / pick call sites. */
const EMPTY_PACK_OP_RESOLUTION: PackOpResolution = new Map();

/** Lower a recipe's D-182 two-tier op-steps (kernel `core.*` / Tier-P) to the
 *  forms `resolveConnectionAgnosticRecipe` runs, BEFORE that resolver sees them
 *  (a kernel op is canonical-op-shaped but is NOT a vendor canonical op — it must
 *  become a concrete kernel step first, never reach the vendor binder). Returns
 *  the SAME recipe object when nothing was lowered (the current corpus —
 *  `lowerOpStepRecipe` preserves the step reference for an untouched step), so an
 *  inert recipe keeps its identity + content hash. Throws
 *  `CanonicalOpResolutionError` (fail closed) on a well-formed two-tier op id with
 *  no resolved target — the caller maps it to its typed failure.
 *
 *  D-182 Slice 4 — `packs` is the Tier-P `pack_ref → catalog binding` map
 *  (`buildPackOpResolution`); a Tier-P op resolves against it. Defaults to the
 *  empty map (kernel-only lowering / db-less paths). INERT on the current corpus
 *  regardless: no recipe carries a two-tier `op` id until the Slice-4 rewrite, so
 *  the pre-pass is a reference-preserving no-op whether or not a map is passed. */
export const lowerTwoTierOpSteps = (
  recipe: RecipeDefinition,
  packs: PackOpResolution = EMPTY_PACK_OP_RESOLUTION,
): RecipeDefinition => {
  const lowered = lowerOpStepRecipe(recipe, packs);
  // D-182 Slice 4 — `lowerOpStepRecipe` lowers `steps`, `prefetch_steps` AND
  // `trigger_steps` (a Tier-P prefetch read concretizes to a `PrefetchStep`; a
  // D-182 watcher `core.watch.*` trigger op concretizes to its backing watcher
  // `IngredientStep`), and preserves the element reference for an untouched entry —
  // so identity is detectable per array. A recipe whose ONLY op-step lives in
  // prefetch OR trigger_steps would slip past a steps-only check, so ALL THREE
  // arrays are compared (a trigger-only watch recipe must not return the unchanged
  // original — that left an unlowered `core.watch.*` op to reach `runStep`).
  const stepsChanged = lowered.steps.some((s, i) => s !== recipe.steps[i]);
  const loweredPrefetch = lowered.prefetch_steps ?? [];
  const originalPrefetch = recipe.prefetch_steps ?? [];
  const prefetchChanged = loweredPrefetch.some((s, i) => s !== originalPrefetch[i]);
  const loweredTrigger = lowered.trigger_steps ?? [];
  const originalTrigger = recipe.trigger_steps ?? [];
  const triggerChanged = loweredTrigger.some((s, i) => s !== originalTrigger[i]);
  return stepsChanged || prefetchChanged || triggerChanged ? lowered : recipe;
};

/** D-182 Slice 4 — build the Tier-P `pack_ref → catalog` resolution map from a
 *  provisioner's deps: scan the installed-pack inventory (`contractStore`) + read
 *  each catalog from the live registry. `selfPackRef` (`<publisher>.<pack_slug>`
 *  of the pack being installed) is EXCLUDED so a reinstall's stale prior row never
 *  resolves the pack's own Tier-P self-reference (it binds via its own composition
 *  or fails closed); on first install the pack isn't in the inventory anyway. The
 *  map is exactly the already-installed DEPENDENCY packs its recipes' `depends_on`
 *  ops resolve against. */
const packOpResolutionFromDeps = (
  deps: ProvisionAuthoredDeps,
  selfPackRef: string,
): PackOpResolution =>
  buildPackOpResolution(
    () => deps.contractStore.scan('installed_pack'),
    (slug) => deps.registry.get(slug) ?? null,
    selfPackRef,
  );

export const resolveOpStepRecipes = (
  vendorForCatalog: (catalogSlug: string) => string | undefined,
  recipes: readonly RecipeDefinition[],
  inputs: OpStepResolutionInputs,
  // D-182 Slice 4 — the Tier-P `pack_ref → catalog` map a recipe's
  // `<publisher>.<pack>.<op>` op-steps (from its `depends_on` packs) lower
  // against. Default-empty (kernel-only / db-less paths); the install callers
  // build it from inventory (`buildPackOpResolution`).
  packs: PackOpResolution = EMPTY_PACK_OP_RESOLUTION,
): { ok: true; recipes: RecipeDefinition[]; warnings: AuthoringValidationIssue[] }
  | { ok: false; message: string } => {
  if (!recipes.some((r) => hasCanonicalOpStep(r) || hasOpStepInPrefetch(r))) {
    return { ok: true, recipes: [...recipes], warnings: [] };
  }
  const prefetchOffender = recipes.find(hasNonPrefetchableOpStepInPrefetch);
  if (prefetchOffender !== undefined) {
    return {
      ok: false,
      message:
        `recipe '${prefetchOffender.recipe_id}' uses a canonical (CRM/acct or bare) op-step in prefetch_steps — ` +
        `it decomposes into a fetch + a projection and must live in steps; only kernel / Tier-P raw reads may sit in prefetch_steps`,
    };
  }
  const vendor = vendorForCatalog(inputs.catalogSlug);
  if (vendor === undefined) {
    return {
      ok: false,
      message:
        `a bundled recipe uses canonical op-steps but the pack's catalog '${inputs.catalogSlug}' is not a known catalog vendor (CATALOG_VENDOR_SLUGS) — op-step recipes must bind a CRM-conformant vendor pack (deal/contact/account ops) or an entity-less tool catalog (e.g. web.search)`,
    };
  }
  // Registry = the single, frozen vendor→canonical mapping source (slice-2
  // decision; supersedes "the pack carries entity_fields"). First-party →
  // the built-in CONNECTION_VENDOR_ENTITIES; the composition path passes the
  // built-ins merged with the pack's own entities (slice 4.5).
  const registry = inputs.registry ?? CONNECTION_VENDOR_ENTITIES;
  const baseCtx: Omit<PackResolutionContext, 'connection'> = {
    pack_slug: inputs.packSlug,
    vendor,
    catalog_slug: inputs.catalogSlug,
    result_path: inputs.surfaceResultPath,
    // NEXT-1 — the catalog-declared search dialect selects the resolver's query
    // builder (a `search` op-step fails closed when undefined). Threaded from the
    // bound catalog's `surfaces.api.search_style` at every call site below.
    search_style: inputs.searchStyle,
    // write-verb reverse projection — the catalog-declared write body dialect selects
    // the resolver's body builder (a `create`/`update` op-step fails closed when
    // undefined). Threaded from the bound catalog's `surfaces.api.write_style`.
    write_style: inputs.writeStyle,
    operation_families: inputs.operationFamilies,
    entity_fields: entityFieldsFromRegistry(vendor, registry),
    registry,
  };
  const out: RecipeDefinition[] = [];
  const warnings: AuthoringValidationIssue[] = [];
  for (const rawRecipe of recipes) {
    // D-182 Slice 5 (Increment 2b) — lower any D-182 two-tier op-step (kernel
    // `core.*` / Tier-P) to a concrete kernel step / a bare canonical op BEFORE
    // the vendor binder below reads it (a kernel op is canonical-op-shaped but is
    // NOT a vendor canonical op — it must become concrete first). Inert no-op on
    // the current corpus (no two-tier op ids). A two-tier op with no resolved
    // target fails closed → install-block (empty-map seam — Tier-P unsourced yet).
    let recipe: RecipeDefinition;
    try {
      recipe = lowerTwoTierOpSteps(rawRecipe, packs);
    } catch (e) {
      if (e instanceof CanonicalOpResolutionError) {
        return { ok: false, message: `recipe '${rawRecipe.recipe_id}': ${e.message}` };
      }
      throw e;
    }
    if (!hasCanonicalOpStep(recipe)) {
      out.push(recipe);
      continue;
    }
    // Per-operand connection (R2 step 5) — explicit slots validated, slot-less
    // default derived per recipe (ambiguity > pack default > the recipe's single
    // connection variable). The per-step slot wins inside the resolver.
    const plan = opStepConnectionPlan(recipe, inputs.connection);
    if (!plan.ok) return { ok: false, message: plan.message };
    const ctx: PackResolutionContext = {
      ...baseCtx,
      ...(plan.defaultConnection !== undefined ? { connection: plan.defaultConnection } : {}),
    };
    let resolved: ReturnType<typeof resolveConnectionAgnosticRecipe>;
    try {
      resolved = resolveConnectionAgnosticRecipe(recipe, ctx);
    } catch (e) {
      if (e instanceof CanonicalOpResolutionError) {
        return { ok: false, message: `recipe '${recipe.recipe_id}': ${e.message}` };
      }
      throw e;
    }
    out.push(resolved.recipe);
    for (const b of resolved.bindings) {
      if (b.op_kind !== 'tool' && COLLECTION_CANONICAL_VERBS.has(b.verb) && b.result_path.length === 0) {
        warnings.push({
          severity: 'warn',
          code: 'authoring_install_op_no_result_path',
          path: `recipes.${recipe.recipe_id}.${b.step_id}`,
          message:
            `canonical op '${b.canonical_op}' (→ ${b.operation}) is a collection op but resolved to no result_path — ` +
            `the projection reads the raw response as a bare array at root; declare surfaces.api.result_path ` +
            `(or a per-op result_path) if '${vendor}' wraps results in an envelope`,
        });
      }
    }
  }
  return { ok: true, recipes: out, warnings };
};

/** D-182 3b — the connection-kind name the composition's primary ingredient
 *  authenticates through (the new home of the legacy `composition.auth.connection`).
 *  Off the `http` / `connection` config cell; `undefined` for a connection-less
 *  `cli` ingredient. */
const compositionConnectionName = (composition: CompositionIngredient): string | undefined => {
  const ing = composition.ingredients?.[0];
  return ing?.http?.connection ?? ing?.connection?.connection;
};

/** D-194 step 3a — resolve the connection a pack's grant + `connection_catalog_
 *  binding` + op dispatch bind to. Prefers the owner's CHOSEN connection (the
 *  install-dialog reuse/Connect pick) when it names a non-empty connection AND
 *  the composition actually binds one (`authored !== undefined`) — this is the
 *  install-time re-source of §3/§13 (bind the grant to the CHOSEN connection's
 *  name, not the hardcoded authored literal). A connection-less (cli) composition
 *  has nothing to re-target, so the pin is ignored. Absent / empty pin ⇒ the
 *  authored `auth.connection` literal (back-compat). PURE. */
export const reSourceGrantConnection = (
  authored: string | undefined,
  chosen: string | undefined,
): string | undefined =>
  authored !== undefined && typeof chosen === 'string' && chosen.length > 0
    ? chosen
    : authored;

/** The catalog's surface-level `result_path` (`''` when unset). The decomposed
 *  catalog body carries catalog fields (`surfaces`) that aren't on the base
 *  `IngredientManifest` type, so read it through a cast (mirrors `catalogKindOf`). */
const surfaceResultPathOf = (body: IngredientManifest): string =>
  (body as { surfaces?: ProviderSurfaces }).surfaces?.api?.result_path ?? '';

/** Connection-agnostic op dispatch (NEXT-1) — the catalog's surface-level search
 *  DIALECT (`undefined` when unset OR not a known `SearchStyle`). Narrowed via
 *  `isSearchStyle` at the read boundary so a bogus value from a hand-built / 3rd-party
 *  catalog body collapses to `undefined` (→ a canonical `search` fails closed at
 *  resolve) rather than reaching the resolver as an unknown builder key. */
const surfaceSearchStyleOf = (body: IngredientManifest): SearchStyle | undefined => {
  const raw = (body as { surfaces?: ProviderSurfaces }).surfaces?.api?.search_style;
  return isSearchStyle(raw) ? raw : undefined;
};

/** Connection-agnostic op dispatch (write-verb reverse projection) — the catalog's
 *  surface-level WRITE body DIALECT (`undefined` when unset OR not a known
 *  `WriteStyle`). Narrowed via `isWriteStyle` at the read boundary so a bogus value
 *  from a hand-built / 3rd-party catalog body collapses to `undefined` (→ a canonical
 *  `create`/`update` fails closed at resolve) rather than reaching the resolver as an
 *  unknown builder key. */
const surfaceWriteStyleOf = (body: IngredientManifest): WriteStyle | undefined => {
  const raw = (body as { surfaces?: ProviderSurfaces }).surfaces?.api?.write_style;
  return isWriteStyle(raw) ? raw : undefined;
};

/** A3 (slice 3) — resolve a pack's BUNDLED authored recipes' canonical op-steps
 *  against the app_pack's composition BEFORE they install through the recipe
 *  engine (`installBulkPackOnServer`, the `packs.install` recipe path).
 *
 *  Why this exists: the composition's OWN decomposed recipes resolve in
 *  `provisionPack{,CompositionForBulkInstall}` (slice 2), but a pack's authored
 *  recipes bundled as `recipes[]` install through a DIFFERENT path that persists
 *  each def verbatim (validator + content-addressing only). The recipe validator
 *  now ACCEPTS op-steps (so they can be authored + published), so an op-step
 *  recipe reaching the recipe-install path unresolved would persist an unrunnable
 *  recipe (the engine has no op→ingredient dispatch; the marketplace safety net
 *  would reject it). This R1-rewrites them first, using the SAME resolver +
 *  registry-frozen field mapping as slice 2, with the resolution context drawn
 *  from the pack's OWN composition (its decomposed catalog + bound connection +
 *  operation_families + result envelope).
 *
 *  Fast path: no op-step recipes → passthrough (the common v1 pack — recipe-only,
 *  no composition). Hard-block (`ok: false`) when op-step recipes are present but
 *  the pack carries no composition to bind against, the composition can't be
 *  decomposed, or a binding fails (delegated to `resolveOpStepRecipes`). Runs
 *  regardless of whether the composition is later provisioned — even a deferred
 *  composition (db-less boot) must NOT leave op-steps unresolved (a fail-closed
 *  gate beats a silently-unrunnable recipe). Pure of writes. */
export const resolveBundledPackRecipes = (
  composition: CompositionIngredient | undefined,
  packSlug: string,
  recipes: readonly RecipeDefinition[],
  vendorForCatalog: (catalogSlug: string) => string | undefined = defaultVendorForCatalog,
  // D-182 Slice 4 — Tier-P `pack_ref → catalog` map (threaded to `resolveOpStepRecipes`).
  packs: PackOpResolution = EMPTY_PACK_OP_RESOLUTION,
): { ok: true; recipes: RecipeDefinition[]; warnings: AuthoringValidationIssue[] }
  | { ok: false; message: string } => {
  if (!recipes.some((r) => hasCanonicalOpStep(r) || hasOpStepInPrefetch(r))) {
    return { ok: true, recipes: [...recipes], warnings: [] };
  }
  if (composition === undefined) {
    return {
      ok: false,
      message:
        'pack bundles canonical op-step recipe(s) but carries no composition to bind them against — op-step recipes require a CRM-conformant vendor pack',
    };
  }
  let decomposed: DecomposedArtifacts;
  try {
    decomposed = decomposeComposition[composition.schema_version](composition);
  } catch (e) {
    return {
      ok: false,
      message: `pack composition failed to decompose for op-step resolution: ${(e as Error).message ?? String(e)}`,
    };
  }
  const body = decomposed.catalog ?? decomposed.ingredient;
  if (body === undefined) {
    return {
      ok: false,
      message: 'pack composition decomposed to no catalog body — cannot resolve op-step recipes',
    };
  }
  // slice 4.5 — a 3rd-party composition resolves against its own merged registry
  // (built-ins + its decomposed crm_alias entities); a first-party catalog keeps
  // the frozen built-in registry.
  const merge = thirdPartyRegistryMerge(body.slug, decomposed.entity_schemas, vendorForCatalog);
  return resolveOpStepRecipes(merge.vendorForCatalog, recipes, {
    packSlug,
    catalogSlug: body.slug,
    connection: compositionConnectionName(composition),
    surfaceResultPath: surfaceResultPathOf(body),
    searchStyle: surfaceSearchStyleOf(body),
    writeStyle: surfaceWriteStyleOf(body),
    // D-182 3b — re-feed the resolver's operation rows from the decomposed catalog
    // (the authored `composition.operation_families` is gone; the catalog reverse-
    // lift is the canonical source). The resolver only reads `.operation`.
    operationFamilies: operationFamiliesFromCatalog(body),
    registry: merge.registry,
  }, packs);
};

// ────────────────────────────────────────────────────────────────
// First-party catalog op dispatch — connection-agnostic recipe →
// a BUNDLED vendor catalog (hubspot-catalog / salesforce-catalog)
// ────────────────────────────────────────────────────────────────

/** Minimal `OperationRow[]` from a BUNDLED catalog manifest's `operations` map.
 *  The bundled first-party catalogs declare ops as an `OperationSpec` map (not a
 *  composition's authored `operation_families` array); the op-step resolver only
 *  matches a canonical op against `.operation`, so a row carrying the op id +
 *  the catalog's real surface binding is what it needs. A per-op `OperationSpec.
 *  result_path` (if a bundled catalog ever declares one) is carried onto the row so
 *  the resolver bakes the read-projection ref at the SAME envelope the runtime
 *  gateway's pagination follower merges at (which reads the lowered
 *  `OperationSpec.result_path`); absent → the surface default inherits. The shipped
 *  HubSpot/Salesforce search ops declare none (surface-level envelope), so this is
 *  inert for them today. */
const operationFamiliesFromCatalog = (catalog: IngredientManifest): OperationRow[] => {
  const executes = catalog.surfaces?.api?.executes ?? {};
  return Object.entries(catalog.operations ?? {}).map(([operation, spec]): OperationRow => {
    const dot = operation.indexOf('.');
    const binding = executes[operation];
    return {
      family: dot > 0 ? operation.slice(0, dot) : operation,
      operation,
      verb: binding !== undefined && binding.kind === 'rest' ? binding.method.toLowerCase() : 'post',
      surface: 'api',
      binding: binding ?? { kind: 'rest', method: 'POST', path_template: '' },
      risk_tier: spec.risk_tier,
      approval: spec.approval ?? 'never',
      ...(spec.groups !== undefined ? { groups: spec.groups } : {}),
      ...(spec.result_path !== undefined ? { result_path: spec.result_path } : {}),
      ...(spec.pagination !== undefined ? { pagination: spec.pagination } : {}),
      reviewed: true,
    };
  });
};

/** Find the single bundled vendor catalog a pack references by-ref — a
 *  `type:'ingredient'` content whose id (`ingredient_id` or `slug`) is a known
 *  CRM vendor catalog (`hubspot-catalog` / `salesforce-catalog`). This is how a
 *  first-party CRM pack names the bundled catalog its connection-agnostic recipes
 *  bind to (the first-party analogue of a composition's decomposed catalog).
 *  Returns the catalog slug, `undefined` when none is referenced, or a typed
 *  error when more than one is referenced (ambiguous vendor binding — a pack
 *  binds one catalog). */
const firstPartyVendorCatalogRef = (
  contents: readonly PackContentRef[],
  vendorForCatalog: (catalogSlug: string) => string | undefined,
): { ok: true; catalogSlug: string | undefined } | { ok: false; message: string } => {
  const refs = new Set<string>();
  for (const content of contents) {
    if (content.type !== 'ingredient') continue;
    const id = content.ingredient_id ?? content.slug;
    if (id !== undefined && vendorForCatalog(id) !== undefined) refs.add(id);
  }
  if (refs.size > 1) {
    return {
      ok: false,
      message:
        `pack references multiple CRM vendor catalogs (${[...refs].sort().join(', ')}) for its op-step recipes — a first-party op-step pack binds exactly one catalog`,
    };
  }
  return { ok: true, catalogSlug: refs.size === 1 ? [...refs][0] : undefined };
};

/** First-party install wiring — resolve a pack's connection-agnostic op-step
 *  recipes against a BUNDLED first-party vendor catalog (`hubspot-catalog` /
 *  `salesforce-catalog`). The analogue of `resolveBundledPackRecipes` for a pack
 *  that references a bundled catalog BY-REF instead of carrying a composition.
 *
 *  Assembles the `PackResolutionContext` from the bundled catalog MANIFEST (its
 *  `slug`, `operations` → `operation_families`, `surfaces.api.result_path`) and
 *  the REGISTRY (`vendor` via `CATALOG_VENDOR_SLUGS` + `entity_fields` via
 *  `entityFieldsFromRegistry`, both inside `resolveOpStepRecipes`), then
 *  delegates to the shared `resolveOpStepRecipes` R1 rewrite — so the resolved
 *  recipes run through the existing engine / gateway / audit / grant path
 *  unchanged. Pure of writes; runs BEFORE the install commit.
 *
 *  The connection is per-recipe / per-operand (R2 step 5): a first-party pack
 *  provides NO pack-level default (`connection: undefined`), so each recipe's
 *  op-steps bind their explicit `{{config.<var>}}` slots or the recipe's single
 *  `type:'connection'` variable (`opStepConnectionPlan` — the established
 *  catalog-recipe UX, the user binds each variable to an enrolled connection).
 *  The retired `sharedConnectionRef` cross-recipe same-variable rule is gone:
 *  recipes in one pack may name different variables, and a multi-operand recipe
 *  may declare several.
 *
 *  Fast path: no op-step recipes → passthrough. Hard-block (`ok:false`) when the
 *  catalog is not a known CRM vendor catalog or a recipe's slots/default can't
 *  be derived (both delegated to `resolveOpStepRecipes`). */
export const resolveFirstPartyCatalogPackRecipes = (
  catalog: IngredientManifest,
  packSlug: string,
  recipes: readonly RecipeDefinition[],
  vendorForCatalog: (catalogSlug: string) => string | undefined = defaultVendorForCatalog,
  // D-182 Slice 4 — Tier-P `pack_ref → catalog` map (threaded to `resolveOpStepRecipes`).
  packs: PackOpResolution = EMPTY_PACK_OP_RESOLUTION,
): { ok: true; recipes: RecipeDefinition[]; warnings: AuthoringValidationIssue[] }
  | { ok: false; message: string } => {
  if (!recipes.some((r) => hasCanonicalOpStep(r) || hasOpStepInPrefetch(r))) {
    return { ok: true, recipes: [...recipes], warnings: [] };
  }
  return resolveOpStepRecipes(vendorForCatalog, recipes, {
    packSlug,
    catalogSlug: catalog.slug,
    connection: undefined,
    surfaceResultPath: surfaceResultPathOf(catalog),
    searchStyle: surfaceSearchStyleOf(catalog),
    writeStyle: surfaceWriteStyleOf(catalog),
    operationFamilies: operationFamiliesFromCatalog(catalog),
  }, packs);
};

/** Per-operand dispatch resolve (R2 step 5, doc §1.3) — rewrite ONE canonical
 *  recipe whose op-steps may bind DIFFERENT connection slots, each against its
 *  OWN catalog. The dispatch-side analogue of
 *  `resolveFirstPartyCatalogPackRecipes`: the caller derives the recipe's slots
 *  (`opStepConnectionSlots`), resolves each slot's run-supplied connection to
 *  its bound catalog manifest (operation profile → `catalog_slug` → registry),
 *  and passes `catalogBySlotVariable`; this assembles one
 *  `PackResolutionContext` per slot (vendor / styles / op rows / fields from
 *  THAT slot's catalog, `connection: {{config.<var>}}` so the engine re-resolves
 *  the same config at execute) and runs the shared rewrite with a per-step
 *  selector — so a cross-vendor compare resolves each operand against its own
 *  registry mapping (same-platform = the picked connections coincide).
 *
 *  Hard-blocks (typed `{ ok: false }`): op-steps in `prefetch_steps`, an
 *  underivable slot (no/ambiguous connection variable, bad slot ref), a slot
 *  whose catalog is missing from the map, a catalog that is not a known CRM
 *  vendor catalog, or a binding failure inside the resolver. WARNs (mirroring
 *  `resolveOpStepRecipes`) when a collection op resolved to no `result_path`.
 *  Pure of writes — never persists. */
export const resolvePerSlotOpStepRecipe = (
  recipe: RecipeDefinition,
  catalogBySlotVariable: ReadonlyMap<string, IngredientManifest>,
  packSlug: string,
  vendorForCatalog: (catalogSlug: string) => string | undefined = defaultVendorForCatalog,
): { ok: true; recipe: RecipeDefinition; warnings: AuthoringValidationIssue[] }
  | { ok: false; message: string } => {
  if (hasNonPrefetchableOpStepInPrefetch(recipe)) {
    return {
      ok: false,
      message:
        `recipe '${recipe.recipe_id}' uses a canonical (CRM/acct or bare) op-step in prefetch_steps — ` +
        `it decomposes into a fetch + a projection and must live in steps; only kernel / Tier-P raw reads may sit in prefetch_steps`,
    };
  }
  const slots = opStepConnectionSlots(recipe);
  if (!slots.ok) return { ok: false, message: slots.reason };
  const ctxBySlotVariable = new Map<string, PackResolutionContext>();
  for (const variable of slots.variables) {
    const catalog = catalogBySlotVariable.get(variable);
    if (catalog === undefined) {
      return {
        ok: false,
        message: `no catalog was supplied for connection slot '${variable}' — cannot resolve its op-steps`,
      };
    }
    const vendor = vendorForCatalog(catalog.slug);
    if (vendor === undefined) {
      return {
        ok: false,
        message:
          `connection slot '${variable}' is bound to catalog '${catalog.slug}', which is not a known CRM vendor ` +
          `catalog — canonical field mappings can't be resolved (op-step recipes require a CRM-conformant vendor pack)`,
      };
    }
    ctxBySlotVariable.set(variable, {
      pack_slug: packSlug,
      vendor,
      connection: `{{config.${variable}}}`,
      catalog_slug: catalog.slug,
      result_path: surfaceResultPathOf(catalog),
      search_style: surfaceSearchStyleOf(catalog),
      write_style: surfaceWriteStyleOf(catalog),
      operation_families: operationFamiliesFromCatalog(catalog),
      entity_fields: entityFieldsFromRegistry(vendor),
    });
  }
  let resolved: ReturnType<typeof resolveConnectionAgnosticRecipe>;
  try {
    // Both maps are keyed off the same `opStepConnectionSlots` walk, so every
    // op-step id resolves a slot and every slot resolved a ctx above.
    resolved = resolveConnectionAgnosticRecipe(
      recipe,
      (step) => ctxBySlotVariable.get(slots.slotByStepId.get(step.id) as string) as PackResolutionContext,
    );
  } catch (e) {
    if (e instanceof CanonicalOpResolutionError) {
      return { ok: false, message: `recipe '${recipe.recipe_id}': ${e.message}` };
    }
    throw e;
  }
  const warnings: AuthoringValidationIssue[] = [];
  for (const b of resolved.bindings) {
    if (b.op_kind !== 'tool' && COLLECTION_CANONICAL_VERBS.has(b.verb) && b.result_path.length === 0) {
      warnings.push({
        severity: 'warn',
        code: 'authoring_install_op_no_result_path',
        path: `recipes.${recipe.recipe_id}.${b.step_id}`,
        message:
          `canonical op '${b.canonical_op}' (→ ${b.operation}) is a collection op but resolved to no result_path — ` +
          `the projection reads the raw response as a bare array at root; declare surfaces.api.result_path ` +
          `(or a per-op result_path) if '${b.vendor}' wraps results in an envelope`,
      });
    }
  }
  return { ok: true, recipe: resolved.recipe, warnings };
};

/** The op-step resolution entry point the `packs.install` handler calls — picks
 *  the right resolver for a pack's bundled op-step recipes and fails closed
 *  otherwise. Three cases (per the three-layer gate "op-step + no binding →
 *  hard install-block"):
 *
 *  D-182 Slice 5 (Increment 2b) lowers any two-tier op-step FIRST (kernel `core.*`
 *  → concrete; canonical-convention → bare canonical op; Tier-P → fail closed under
 *  the empty map), so a kernel-only recipe pack (no composition, no vendor catalog)
 *  passes through case 1 instead of hard-blocking as "needs a vendor binding".
 *
 *    1. no op-step recipes        → passthrough (the common v1 recipe-only pack,
 *       AND a kernel-only recipe pack after lowering);
 *    2. pack carries a composition → `resolveBundledPackRecipes` (3rd-party /
 *       authored), hard-block first when the composition can't be provisioned
 *       in this environment (else the recipes would point at a catalog that was
 *       never registered);
 *    3. pack references a BUNDLED vendor catalog by-ref (no composition) →
 *       `resolveFirstPartyCatalogPackRecipes` (first-party HubSpot / Salesforce).
 *
 *  Anything else with op-steps (no composition AND no vendor-catalog ref, or the
 *  referenced catalog isn't registered) hard-blocks. `getCatalogManifest` is the
 *  live manifest registry's `get` (returns `null` when the substrate is absent —
 *  a db-less boot then fail-closes the first-party path, never over-installs).
 *  Pure of writes. */
export const resolvePackOpStepRecipes = (
  composition: CompositionIngredient | undefined,
  contents: readonly PackContentRef[],
  packSlug: string,
  recipes: readonly RecipeDefinition[],
  getCatalogManifest: (catalogSlug: string) => IngredientManifest | null,
  canProvisionComposition: boolean,
  vendorForCatalog: (catalogSlug: string) => string | undefined = defaultVendorForCatalog,
  // D-182 Slice 4 — the Tier-P `pack_ref → catalog` map the pack's recipes lower
  // their `depends_on` packs' `<publisher>.<pack>.<op>` op-steps against. The
  // install handler builds it from the installed-pack inventory
  // (`buildPackOpResolution`); a pure-workflow consumer pack (media-transcribe →
  // recued-core.whisper) resolves its deps' ops here. Default-empty (db-less /
  // unit). INERT on the current corpus (no two-tier op ids).
  packs: PackOpResolution = EMPTY_PACK_OP_RESOLUTION,
  // D-182 Slice 4 — the SELF pack_ref (`<publisher>.<slug>`) of the pack being
  // installed. When present, a FRESH self-binding is built from the pack's OWN
  // bundled first-party catalog and merged into `packs`, so a Tier-P self-ref op
  // (`recued-core.<pack>.<op>` in a recipe that `depends_on` its own pack — the
  // shipped hubspot / salesforce / exa packs) lowers at install against the
  // bundled catalog. `buildPackOpResolution` deliberately EXCLUDES the self-pack
  // (to dodge a STALE reinstall row), so the only correct source for the self
  // binding is the bundled catalog being installed — this is the "binds via its
  // own bundled catalog at install" path. Omitted ⇒ no self-binding (a
  // dependency-only resolution, unchanged).
  selfPackRef?: string,
): { ok: true; recipes: RecipeDefinition[]; warnings: AuthoringValidationIssue[] }
  | { ok: false; message: string } => {
  // D-182 Slice 4 — merge the self-pack's own bundled-catalog Tier-P binding (see
  // `selfPackRef`). Source the fresh binding from the pack's by-value composition
  // first, then fall back to the older first-party by-ref catalog shape. This lets
  // self-contained packs lower `recued-core.<pack>.<op>` recipes against the
  // catalog they are installing instead of requiring a stale pre-existing
  // installed-pack row.
  let effectivePacks: PackOpResolution = packs;
  if (selfPackRef !== undefined) {
    if (composition !== undefined && composition.operations.length > 0) {
      const merged = new Map(packs);
      merged.set(selfPackRef, {
        catalog_slug: composition.slug,
        operations: new Set(composition.operations.map((op) => op.op)),
      });
      effectivePacks = merged;
    } else {
      const selfRef = firstPartyVendorCatalogRef(contents, vendorForCatalog);
      if (selfRef.ok && selfRef.catalogSlug !== undefined) {
        const selfCatalog = getCatalogManifest(selfRef.catalogSlug);
        const ops = selfCatalog?.operations;
        if (selfCatalog !== null && ops !== undefined && Object.keys(ops).length > 0) {
          const merged = new Map(packs);
          merged.set(selfPackRef, {
            catalog_slug: selfCatalog.slug,
            operations: new Set(Object.keys(ops)),
          });
          effectivePacks = merged;
        }
      }
    }
  }
  // D-182 Slice 5 (Increment 2b) — lower D-182 two-tier op-steps (kernel `core.*`
  // / Tier-P) BEFORE the case-routing below, so a kernel-only recipe (no
  // composition, no vendor catalog) is not mis-routed to the "needs a vendor
  // binding" hard-block: its kernel ops become CONCRETE steps here, so the
  // op-step fast-path treats it as a plain recipe (passthrough). A
  // canonical-convention op is stripped to its bare form the vendor binder
  // finishes; a Tier-P op resolves against `effectivePacks` (Slice 4 — the
  // dependency packs + the self-binding above) or fails closed when its pack
  // isn't installed. The downstream resolvers re-lower idempotently (a
  // concrete step is not an op-step; a bare canonical op is a 2-segment
  // passthrough). INERT no-op on the current corpus.
  const lowered: RecipeDefinition[] = [];
  for (const r of recipes) {
    try {
      lowered.push(lowerTwoTierOpSteps(r, effectivePacks));
    } catch (e) {
      if (e instanceof CanonicalOpResolutionError) {
        return { ok: false, message: `recipe '${r.recipe_id}': ${e.message}` };
      }
      throw e;
    }
  }
  recipes = lowered;
  if (!recipes.some((r) => hasCanonicalOpStep(r) || hasOpStepInPrefetch(r))) {
    return { ok: true, recipes: [...recipes], warnings: [] };
  }
  // (2) composition path — the pack carries its integration by value.
  if (composition !== undefined) {
    if (!canProvisionComposition) {
      return {
        ok: false,
        message:
          'pack bundles canonical op-step recipe(s) but its composition cannot be provisioned in this environment — refusing to install recipes that point at an unprovisioned catalog',
      };
    }
    return resolveBundledPackRecipes(composition, packSlug, recipes, vendorForCatalog, effectivePacks);
  }
  // (3) first-party path — the pack references a BUNDLED vendor catalog by-ref.
  const catalogRef = firstPartyVendorCatalogRef(contents, vendorForCatalog);
  if (!catalogRef.ok) return { ok: false, message: catalogRef.message };
  if (catalogRef.catalogSlug === undefined) {
    return {
      ok: false,
      message:
        'pack bundles canonical op-step recipe(s) but carries neither a composition nor a reference to a bundled CRM vendor catalog (hubspot-catalog / salesforce-catalog) to bind them against',
    };
  }
  const catalog = getCatalogManifest(catalogRef.catalogSlug);
  if (catalog === null) {
    return {
      ok: false,
      message:
        `pack references bundled catalog '${catalogRef.catalogSlug}' for its op-step recipes, but it is not registered — the first-party catalog must be bundled/installed to bind connection-agnostic recipes against it`,
    };
  }
  return resolveFirstPartyCatalogPackRecipes(catalog, packSlug, recipes, vendorForCatalog, effectivePacks);
};

/** D-182 §7.1 — the `Access` tier ceiling → the risk tiers it grants. `Read`
 *  grants only read-tier groups; `+Write` adds write; `All (destructive)` adds
 *  admin + destructive. Conservative: an admin-tier group is granted only at
 *  `All` (admin sits between write and destructive). A group whose `risk_floor`
 *  is undeclared is never tier-selected (fail-closed). */
const ACCESS_TIER_PERMITS: Record<InstallAccessTier, ReadonlySet<OperationRiskTier>> = {
  read: new Set<OperationRiskTier>(['read']),
  write: new Set<OperationRiskTier>(['read', 'write']),
  all: new Set<OperationRiskTier>(['read', 'write', 'admin', 'destructive']),
};

/** D-182 §7.1 (F3 fold) — is a pack's AUTHORED default-grant group honorable
 *  HEADLESSLY (no install dialog could be shown — bulk / boot / cron, or an
 *  install rpc that omitted `install_scope`)? A read-tier group always is (a
 *  read grant carries no unattended authority). A higher-tier group is honored
 *  ONLY when EVERY operation in it carries an approval gate (`ask` / `always`)
 *  — the per-action gate still fires, so the grant hands no silent unattended
 *  authority (reception's `*.materialize` is `write` + `approval: ask` → it
 *  qualifies, so a fresh reception inbox's first materialize reaches its
 *  review-then-approve gate). A non-read op with `approval: never` (or unset —
 *  the gateway would derive it from the provider default) is NOT honored
 *  headlessly: it needs the interactive dialog or an explicit `install_scope`. */
const isHeadlessHonorableGroup = (body: IngredientManifest, groupId: string): boolean => {
  const group = body.operation_groups?.[groupId];
  if (group === undefined) return false;
  if (group.risk_floor === 'read') return true;
  const ops = body.operations ?? {};
  return group.operations.length > 0
    && group.operations.every((opId) => {
      const approval = ops[opId]?.approval;
      return approval === 'ask' || approval === 'always';
    });
};

/** D-182 §7.1 — resolve the operation-group grants to actually WRITE at install,
 *  replacing the silent derived read-tier auto-grant.
 *
 *  Two contributions, UNIONed + deduped (the pack's authored read/`ask` minimum
 *  is written in BOTH paths; the owner's dialog choice adds to it):
 *    1. The pack's AUTHORED `composition.default_grants`, filtered to the
 *       headless-honorable subset (`isHeadlessHonorableGroup`) — the §7.1 F3
 *       fold. Always written (even headlessly), so a pack's declared cold-start
 *       minimum is met.
 *    2. When `installScope` is present (the install dialog was shown), the
 *       owner's chosen `Access` tier → every derived group at-or-below the
 *       ceiling (`ACCESS_TIER_PERMITS`). This is the ONLY path that grants the
 *       read tier — the silent derived read-tier auto-grant is gone.
 *
 *  ABSENT `installScope` ⇒ only (1): fail-closed for silent auto-grants. The
 *  `scope` axis does not change this connection-level write set: it only drives
 *  the per-contract op-admission fan-out below.
 *
 *  Returns deduped refs in deterministic (sorted group-id) order so a reinstall
 *  writes byte-stable rows. */
const resolveInstallGrantWriteSet = (
  body: IngredientManifest,
  authoredGroupIds: ReadonlySet<string>,
  installScope: InstallGrantSelection | undefined,
): PackOperationGroupContentRef[] => {
  const groups = body.operation_groups ?? {};
  const selected = new Set<string>();
  for (const groupId of authoredGroupIds) {
    if (isHeadlessHonorableGroup(body, groupId)) selected.add(groupId);
  }
  if (installScope !== undefined) {
    const permitted = ACCESS_TIER_PERMITS[installScope.access];
    for (const [groupId, group] of Object.entries(groups)) {
      const tier = group.risk_floor;
      if (tier !== undefined && permitted.has(tier)) selected.add(groupId);
    }
  }
  return [...selected].sort().map((group_id) => ({
    type: 'operation_group',
    ingredient_id: body.slug,
    group_id,
  }));
};

/** D-182 §7.2 / D-196 — the install-audience op-admission FAN-OUT target set:
 *  the DECLARED `operation_id`s to grant to selected existing doors when the
 *  install dialog picks a non-owner scope.
 *
 *  Derived from the SAME (A) group write-set the connection-level grant uses
 *  (`grantedGroupIds` = the `group_id`s `resolveInstallGrantWriteSet` selected),
 *  so a door is admitted EXACTLY the ops the pack enabled on its connection —
 *  never a superset. Each granted group expands to its member ops
 *  (`operation_groups[gid].operations` = SHORT keys into `body.operations`); each
 *  short key resolves to its fully-qualified `OperationSpec.operation_id` — the
 *  key the op-admission gate matches on (`opGrantEntry`, keyed identically to the
 *  mint-time door fold in `contract-handler.ts`). Each op is then filtered to the
 *  chosen `access` tier by its OWN `risk_tier` (`ACCESS_TIER_PERMITS`): a per-op
 *  CEILING, so a higher-tier op that happens to sit in a read-floor group is not
 *  over-granted to a door (the owner still reaches it via the permissive
 *  author-default; a door gets only ops at-or-below the picked tier).
 *
 *  Pure + deterministic — deduped and sorted so a reinstall re-writes byte-stable
 *  rows. A short key with no matching `OperationSpec`, or a spec with an empty
 *  `operation_id`, is skipped (a degenerate key the grant store would reject). */
const resolveInstallOpAdmissionFanOut = (
  body: IngredientManifest,
  grantedGroupIds: ReadonlySet<string>,
  access: InstallAccessTier,
): string[] => {
  const groups = body.operation_groups ?? {};
  const ops = body.operations ?? {};
  const permitted = ACCESS_TIER_PERMITS[access];
  const operationIds = new Set<string>();
  for (const groupId of grantedGroupIds) {
    const group = groups[groupId];
    if (group === undefined) continue;
    for (const shortKey of group.operations) {
      const spec = ops[shortKey];
      if (spec === undefined) continue; // group names an op with no spec — skip
      if (!permitted.has(spec.risk_tier)) continue; // above the access ceiling
      if (!spec.operation_id) continue; // no declared id → not a grantable op
      operationIds.add(spec.operation_id);
    }
  }
  return [...operationIds].sort();
};

/** D-165 P3 install planner — write a composition's decomposed `default_grants`
 *  as PACK-OWNED `contract.grant` rows (supersedes the D-170 #7 disclosure-only
 *  stopgap).
 *
 *  Each grant default names an operation GROUP (`group_id`) on the composition's
 *  decomposed catalog (`ingredient_id` = the catalog slug) that the pack wants
 *  granted on its bound connection. We write one minimal `{ allowed: true }` row
 *  per default, keyed on the pack's REAL `installed_pack_id` (`packSlug`) — so each
 *  grant tracks its owning pack and `removePackGroups(packSlug)` at uninstall drops
 *  exactly this pack's rows (per-pack isolation; another pack's grants on the same
 *  connection survive).
 *
 *  Clean REPLACE, not append. We FIRST drop this pack's prior grant rows
 *  (`removePackGroups(packSlug)`), THEN write the current defaults — so a reinstall
 *  that dropped a `grant_default`, changed `auth.connection`, or renamed the catalog
 *  leaves no stale grant live under the same `installed_pack_id`. This mirrors
 *  `commit()`'s reinstall-replace for inventory/bodies. The pre-clean runs
 *  unconditionally (even with no connection / empty defaults) so a reinstall that
 *  removed ALL grants clears the old ones.
 *
 *  Atomicity — `createContractGrantStore(deps.contractStore)` wraps the SAME
 *  per-pair db as the body + inventory writes, and this runs INSIDE the caller's
 *  `commit()` transaction, so all three (body, inventory, grants) commit together
 *  or roll back together.
 *
 *  No NEW rows are written when the composition declares no bound connection (the
 *  grant scope requires a `connection_name`) or no grant defaults —
 *  `grantProvisioningNote` discloses the no-connection case. `grantPackGroup` /
 *  `removePackGroups` reject the `__user__` sentinel, so a pack can never touch the
 *  user-manual grant space. */
const writePackGrants = (
  deps: ProvisionAuthoredDeps,
  packSlug: string,
  defaultGrants: readonly PackOperationGroupContentRef[],
  connection: string | undefined,
): void => {
  const grantStore = createContractGrantStore(deps.contractStore);
  // Drop this pack's prior grants first (reinstall = replace, not append).
  grantStore.removePackGroups(packSlug);
  if (connection === undefined) return;
  for (const grant of defaultGrants) {
    grantStore.grantPackGroup(packSlug, grant.ingredient_id, connection, grant.group_id);
  }
};

const customerTierByContractForInstallAudience = (
  customers: ReturnType<SellerInstallAudienceStore['listCustomers']>,
): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const customer of customers) {
    if (
      customer.contract_id.length === 0
      || typeof customer.tier_id !== 'string'
      || customer.tier_id.length === 0
    ) continue;
    if (ambiguous.has(customer.contract_id)) continue;
    if (out.has(customer.contract_id)) {
      out.delete(customer.contract_id);
      ambiguous.add(customer.contract_id);
      continue;
    }
    out.set(customer.contract_id, customer.tier_id);
  }
  return out;
};

const legacyInstallAudience = (scope: InstallScopeWho): InstallAudienceSelection => {
  switch (scope) {
    case 'all_contracts':
      return { owner: true, all_customers: true, all_other_contracts: true };
    case 'all_customers':
      return { owner: true, all_customers: true, all_other_contracts: false };
    case 'all_other_contracts':
      return { owner: true, all_customers: false, all_other_contracts: true };
    case 'owner':
      return { owner: true, all_customers: false, all_other_contracts: false };
  }
};

/** Resolve the legacy radio wire and the D-196 checklist to one strict shape.
 *  The type guard rejects callers that send both; this fallback still prefers
 *  `audience` defensively when invoked directly by a typed internal caller. */
export const resolveInstallAudience = (
  selection: InstallGrantSelection | undefined,
): InstallAudienceSelection => selection?.audience ?? legacyInstallAudience(
  selection?.scope ?? 'owner',
);

const installAudienceTargetsContract = (
  audience: InstallAudienceSelection,
  def: { readonly contract_id: string; readonly grant_kind?: string },
  customerTierByContract: ReadonlyMap<string, string>,
): boolean => {
  if (audience.contract_ids?.includes(def.contract_id)) return true;

  // Contract kind is the authority boundary. In particular, a missing or stale
  // Seller membership row can never make a customer_instance look like an
  // "other" contract and widen all_other_contracts.
  if (def.grant_kind === 'customer_instance') {
    if (audience.all_customers) return true;
    const tierId = customerTierByContract.get(def.contract_id);
    return tierId !== undefined && audience.customer_tier_ids?.includes(tierId) === true;
  }
  return audience.all_other_contracts;
};

export interface ApplyInstallAudienceGrantIdsDeps {
  readonly contractStore: ContractStore;
  readonly sellerStore?: SellerInstallAudienceStore;
  readonly inboundTokenStore?: InstallAudienceInboundTokenStore;
  readonly now: () => number;
}

const syncInstallAudienceCustomerTokens = (
  deps: ApplyInstallAudienceGrantIdsDeps,
  customers: ReturnType<SellerInstallAudienceStore['listCustomers']>,
  affectedContractIds: ReadonlySet<string>,
  definitionStore: ReturnType<typeof createContractDefinitionStore>,
  grantEntryStore: ReturnType<typeof createContractGrantEntryStore>,
  now: number,
): void => {
  if (deps.inboundTokenStore === undefined || affectedContractIds.size === 0) return;
  for (const customer of customers) {
    if (!affectedContractIds.has(customer.contract_id)) continue;
    const definition = definitionStore.get(customer.contract_id);
    if (definition?.grant_kind !== 'customer_instance') continue;
    const grants = Object.fromEntries(
      grantEntryStore.listForContract(customer.contract_id).map((row) => [
        row.entry_key,
        row.granted,
      ]),
    );
    const tokenIds = new Set(
      [customer.inbound_token_id, customer.mcp_token_id].filter(
        (tokenId): tokenId is string => typeof tokenId === 'string' && tokenId.length > 0,
      ),
    );
    for (const tokenId of tokenIds) {
      const token = deps.inboundTokenStore.getTokenById(tokenId);
      // A stale/misbound seller row must never rewrite some other bearer. Exact
      // customer pairing admission already denies this customer until repaired.
      if (token === null || token.contract_id !== customer.contract_id) continue;
      deps.inboundTokenStore.updateTokenGrants({ token_id: tokenId, grants, now });
    }
  }
};

/** Apply one pack's already-resolved grant ids to the D-196 checklist target set.
 *  `replace` owns the source-pack pre-clean; callers that append a recipe-only
 *  grant set after composition provisioning pass false because the composition
 *  path already replaced the same source. */
export const applyInstallAudienceGrantIds = (
  deps: ApplyInstallAudienceGrantIdsDeps,
  grantIds: readonly string[],
  sourcePack: string,
  installScope: InstallGrantSelection | undefined,
  replace = true,
): void => {
  const grantEntryStore = createContractGrantEntryStore(deps.contractStore);
  const definitionStore = createContractDefinitionStore(deps.contractStore);
  const customers = deps.sellerStore?.listCustomers() ?? [];
  const affectedCustomerContracts = new Set<string>();
  if (replace) {
    for (const customer of customers) {
      if (grantEntryStore.listForContract(customer.contract_id).some(
        (row) => row.source_pack === sourcePack,
      )) {
        affectedCustomerContracts.add(customer.contract_id);
      }
    }
  }
  if (replace) grantEntryStore.clearForSourcePack(sourcePack);
  const nowMs = deps.now();
  if (installScope === undefined) {
    syncInstallAudienceCustomerTokens(
      deps,
      customers,
      affectedCustomerContracts,
      definitionStore,
      grantEntryStore,
      nowMs,
    );
    return;
  }

  const ids = [...new Set(grantIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (ids.length === 0) {
    syncInstallAudienceCustomerTokens(
      deps,
      customers,
      affectedCustomerContracts,
      definitionStore,
      grantEntryStore,
      nowMs,
    );
    return;
  }
  const audience = resolveInstallAudience(installScope);

  // Connection-level pack grants are shared substrate and therefore make the
  // owner author-default reachable. A checklist with "You" unchecked must pin
  // an explicit pack-owned owner revoke, otherwise customer-only is a lie.
  if (!audience.owner) {
    for (const grantId of ids) {
      grantEntryStore.set(
        OWNER_CONTRACT_ID,
        opGrantEntry(grantId),
        false,
        nowMs,
        sourcePack,
      );
    }
  }

  const customerTierByContract = customerTierByContractForInstallAudience(customers);
  const nowThunk = (): number => nowMs;
  for (const def of definitionStore.list()) {
    if (
      gateGrantGoverningContractId(def.contract_id, definitionStore, nowThunk)
      === undefined
    ) continue;
    if (!installAudienceTargetsContract(audience, def, customerTierByContract)) continue;
    if (def.grant_kind === 'customer_instance') {
      affectedCustomerContracts.add(def.contract_id);
    }
    for (const grantId of ids) {
      grantEntryStore.set(
        def.contract_id,
        opGrantEntry(grantId),
        true,
        nowMs,
        sourcePack,
      );
    }
  }
  syncInstallAudienceCustomerTokens(
    deps,
    customers,
    affectedCustomerContracts,
    definitionStore,
    grantEntryStore,
    nowMs,
  );
};

/** D-182 §7.2 / D-196 — apply the install-audience op-admission fan-out, with clean
 *  REPLACE semantics (mirrors {@link writePackGrants}). Runs on EVERY install:
 *
 *    1. **Pre-clean (always).** Drop this pack's PRIOR fan-out rows via
 *       {@link ContractGrantEntryStore.clearForSourcePack} keyed on `packSlug`.
 *       So a `for-everyone → for-you` reinstall removes the old per-door grants,
 *       and — because the clean matches ONLY rows stamped `source_pack: packSlug`
 *       — a hand-minted door's own `scope.operation_ids` grant (mint-fold, no
 *       `source_pack`) and any owner/manual (B) row are NEVER disturbed. This is
 *       the per-pack isolation the connection-op (A) `removePackGroups` gives, now
 *       for the per-contract (B) axis.
 *    2. **Write (only non-owner scopes on a connection-backed pack).** Grant each
 *       of the pack's connection-enabled ops ({@link resolveInstallOpAdmissionFanOut})
 *       to EVERY targeted live governing door as an explicit `granted:true`
 *       `contract_grant` op-admission entry (substrate (B)), stamped
 *       `source_pack: packSlug`. The
 *       (A) group grant is CONNECTION-level (one enablement shared by all
 *       contracts); this (B) layer is the per-CONTRACT WHO the op-admission gate
 *       reads for a door — a door needs BOTH. `owner` / absent scope, or a
 *       connection-less pack (its ops aren't dispatchable), stops after the clean;
 *       the owner reaches the ops via the permissive author-default regardless.
 *       D-196 splits the non-owner audience into `all_customers` (contracts with
 *       seller customer rows), `all_other_contracts` (everything live except those
 *       rows), and legacy broad `all_contracts`.
 *
 *  Door target set = `ContractDefinitionStore.list()` filtered to live ordinary
 *  standing doors plus D-196 `customer_instance` doors. Customer templates,
 *  gate-consumed `session`/`delegation` grants, unknown future kinds, the owner
 *  sentinel, and dead/revoked/expired doors are skipped. Keyed by
 *  `opGrantEntry(operationId)`, identical to the mint-time door fold.
 *
 *  OPTION A (install-time fan-out): only doors that EXIST NOW are granted — a door
 *  minted AFTER an audience install stays fail-closed to this pack until
 *  re-granted (the UI helper copy discloses this). Runs INSIDE the caller's commit
 *  transaction (same `deps.contractStore` db), so it commits atomically with the
 *  (A) grant + inventory writes.
 *
 *  ── Ordinary MCP-token checklists remain independent (D-137 § A.9) ──
 *  This writes the op-admission (B) axis. An ordinary HTTP-transport MCP door
 *  carries a THIRD, deliberately-independent axis — its per-token tool checklist
 *  (`isMcpInboundTokenToolAuthorized`, `chat.inbound_token.update_grants`), which
 *  `mcp-server.ts` `handleToolCall` checks BEFORE the op gate and which is
 *  OWNER-CURATED + default-off. This fan-out does not touch ordinary token rows.
 *  D-196 customer bearers are the narrow exception: their token grant map is the
 *  static snapshot of the `customer_instance` contract stamped at issue/restamp,
 *  so an explicit customer audience rollout reconciles only token ids named by
 *  the authoritative Seller customer row. A stale/misbound row is skipped and
 *  remains denied by exact-pairing admission. Thus generic external MCP tokens
 *  still require their own Settings checklist, while customer bearers receive
 *  exactly the seller's deliberate static-contract rollout.
 *  (Codex trust-review 2026-07-03: fail-closed, working-as-intended; not a bypass.) */
const applyInstallOpAdmissionFanOut = (
  deps: ProvisionAuthoredDeps,
  body: IngredientManifest,
  grantWriteSet: readonly PackOperationGroupContentRef[],
  packSlug: string,
  installScope: InstallGrantSelection | undefined,
  grantConnection: string | undefined,
): void => {
  // Resolve only dispatchable connection-backed ids here. The shared audience
  // writer still runs with an empty set so reinstall pre-clean remains exact.
  if (installScope === undefined || grantConnection === undefined) {
    applyInstallAudienceGrantIds(deps, [], packSlug, installScope);
    return;
  }
  const operationIds = resolveInstallOpAdmissionFanOut(
    body,
    new Set(grantWriteSet.map((g) => g.group_id)),
    installScope.access,
  );
  applyInstallAudienceGrantIds(deps, operationIds, packSlug, installScope);
};

/** D-170 gap #2 — record the connection → local-catalog binding so a private/local
 *  composition catalog connection resolves to its catalog for the operation-profile
 *  seed + the grant gate (a local catalog has no `config.vendor` to resolve through,
 *  and the composition's `auth.connection` is lost when it decomposes to a
 *  connection-agnostic catalog). `catalogSlug` is the decomposed catalog's slug;
 *  `connection` is the composition's `auth.connection`.
 *
 *  Clean REPLACE (mirrors `writePackGrants`): drop this pack's prior binding first,
 *  so a reinstall that renamed `auth.connection` doesn't strand the old connection's
 *  binding. Runs INSIDE the caller's commit transaction (same db), so the binding
 *  commits atomically with the body + inventory + grants. No binding is recorded for
 *  a connection-less composition (a cli_delegated artifact has no connection to bind);
 *  the catalog still installs, it just isn't gateway-dispatchable until bound. */
const writeConnectionBinding = (
  deps: ProvisionAuthoredDeps,
  packSlug: string,
  catalogSlug: string,
  connection: string | undefined,
): void => {
  const bindingStore = createConnectionCatalogBindingStore(deps.contractStore);
  bindingStore.removeForPack(packSlug);
  if (connection === undefined) return;
  // One catalog per connection (the ConnectionOperationProfile carries a SINGLE
  // catalog_slug stamp). After dropping THIS pack's prior binding above, a binding
  // that still names this connection is owned by ANOTHER pack — don't clobber it
  // (that would hijack the connection + corrupt the other pack's uninstall). The
  // other pack's binding wins; this composition's catalog stays non-dispatchable on
  // that connection (fail-closed) until the conflict is resolved.
  const existing = bindingStore.list().find((b) => b.connection_name === connection);
  // ⛔⛔ UNLESS THE INCUMBENT IS THE MACHINE'S OWN MIRROR, WHICH IT ALWAYS IS FOR
  // AN MCP CONNECTION — AND THAT MADE THE SLOT UNREACHABLE TO EVERY AUTHORED
  // PACK. D-225 auto-mint installs a GENERATED pack the moment an mcp connection
  // is enrolled, and that pack takes the connection's single catalog slot. Every
  // authored composition bound to the same connection afterwards therefore hit
  // the guard above, logged this warning, and stayed permanently
  // non-dispatchable — `catalog_mismatch` on every op, for a pack the owner
  // deliberately installed and pointed at that connection.
  //
  // 🔑 THE GUARD'S REASON DOES NOT REACH THIS CASE, AND THAT IS THE WHOLE
  // ARGUMENT. It protects ANOTHER PACK's binding: clobbering one would hijack a
  // connection someone else's install owns and corrupt that pack's uninstall. A
  // generated pack is not another owner's declaration — it is this connection's
  // own machine-derived mirror, minted from the peer's `tools/list`, re-minted
  // on the idle probe, and re-derivable at any time. Yielding the slot to what
  // the owner explicitly installed is not a hijack; it is the same rule the
  // exchange's `deliver_to` resolver applies one layer up, and the same one the
  // connection layer applies to owner-typed config: preserve what the owner
  // typed, drop what the machine cached.
  //
  // ⚠ THE COST, STATED RATHER THAN GLOSSED: the generated pack's ops become
  // non-dispatchable on this connection while the authored pack holds the slot.
  // For a peer relationship that is the intended outcome — the generated ops
  // duplicate the authored ones — but an owner who enrolled a third-party MCP
  // server for its tools AND installed an authored pack against the same
  // connection loses the generated half until they uninstall the authored pack.
  // One catalog per connection is the model; this only decides which one, and it
  // decides it by provenance rather than by which happened to be installed first.
  const incumbentIsGenerated = existing !== undefined
    && existing.catalog_slug === existing.installed_pack_id
    && deps.registry.get(existing.catalog_slug)?.author === GENERATED_PACK_PUBLISHER;
  if (existing && existing.installed_pack_id !== packSlug && !incumbentIsGenerated) {
    console.warn(
      `[d-170.gap2] connection '${connection}' is already bound to catalog `
        + `'${existing.catalog_slug}' by pack '${existing.installed_pack_id}'; not rebinding `
        + `for pack '${packSlug}' (one catalog per connection)`,
    );
    return;
  }
  if (incumbentIsGenerated && existing !== undefined) {
    // ⚠ SAY IT, because a silent takeover of a slot is exactly the kind of thing
    // an owner later has to reconstruct from behaviour. The generated pack stays
    // INSTALLED — only its claim on this connection yields.
    console.warn(
      `[d-170.gap2] connection '${connection}' was bound to the GENERATED catalog `
        + `'${existing.catalog_slug}'; yielding it to authored pack '${packSlug}' `
        + '(an owner-installed declaration outranks the machine-minted mirror)',
    );
  }
  bindingStore.bind(connection, catalogSlug, packSlug);
};

/** D-170 gap #2 live-reconcile — the connection names whose operation profile must be
 *  (re)derived after this pack's install commits. Read BEFORE the commit rewrites the
 *  bindings, because a reinstall that MOVED `auth.connection` (`old` → `new`, same pack)
 *  drops `old`'s binding inside `writeConnectionBinding`: reconciling only the current
 *  `grantConnection` would seed `new` but leave `old`'s now-orphan profile live (still
 *  dispatching the local catalog's read-tier ops until the next reconnect/boot — a
 *  fail-OPEN lingering grant). So the target set is this pack's CURRENTLY-bound
 *  connections (the prior set, dropped/replaced by the commit) UNIONED with the new
 *  `grantConnection`. Post-commit each is reconciled live: a dropped binding → profile
 *  deleted (fail-closed), the new binding → profile seeded. Deduped, so the common
 *  same-connection reinstall reconciles once. Empty when no reconciler is wired. */
const connectionsToReconcileForInstall = (
  deps: ProvisionAuthoredDeps,
  packSlug: string,
  grantConnection: string | undefined,
): string[] => {
  // Either post-commit reconciler consumes this target list — the profile seed
  // (D-170 gap #2) OR the work-entity Source reconcile (D-192). Gate on both so a
  // caller wiring only one still reconciles (matches the install-rpc /
  // pack-uninstall rebound gates).
  if (!deps.reconcileConnectionProfile && !deps.reconcileWorkEntitySources) return [];
  const targets = new Set(
    createConnectionCatalogBindingStore(deps.contractStore)
      .list()
      .filter((b) => b.installed_pack_id === packSlug)
      .map((b) => b.connection_name),
  );
  if (grantConnection !== undefined) targets.add(grantConnection);
  return [...targets];
};

/** D-165 P3 install planner — the honest caveat after `writePackGrants`.
 *
 *  The grants ARE written pack-owned now; this `warn` states what that does and
 *  doesn't yet buy the user:
 *    - no bound connection → the grants could NOT be recorded (the grant scope
 *      requires a `connection_name`), so their operations stay denied.
 *    - bound connection → recorded pack-owned + the local catalog is bound to this
 *      connection at install (D-170 gap #2), so its `ConnectionOperationProfile`
 *      resolves once the connection is set up. The grants take effect at dispatch on
 *      the next (re)connect / boot — disclosed so the user knows to connect, rather
 *      than letting a not-yet-connected dispatch deny silently.
 *
 *  Backs `ingredient.install`, whose result carries `warnings`. The `packs.install`
 *  bulk path writes grants the same way (`provisionPackCompositionForBulkInstall`)
 *  but its result has no `warnings` field, so it surfaces no note. */
const grantProvisioningNote = (
  grants: readonly PackOperationGroupContentRef[],
  connection: string | undefined,
): AuthoringValidationIssue | undefined => {
  if (grants.length === 0) return undefined;
  const groups = grants.map((g) => g.group_id).join(', ');
  if (connection === undefined) {
    return {
      severity: 'warn',
      code: 'authoring_install_grants_no_connection',
      path: 'grant_defaults',
      message:
        `${grants.length} declared operation-group grant(s) (${groups}) could not be recorded — ` +
        `the composition declares no bound connection (auth.connection) to apply them to`,
    };
  }
  return {
    severity: 'warn',
    code: 'authoring_install_grants_pending_profile',
    path: 'grant_defaults',
    // D-170 gap #2 closed the registration: the install binds the local catalog to
    // this connection, so its operation profile resolves once the connection is set
    // up. The grants are recorded pack-owned; they take effect at dispatch once
    // connection 'X' is connected (a freshly-(re)connected connection picks them up).
    message:
      `${grants.length} operation-group grant(s) (${groups}) recorded as pack-owned on connection ` +
      `'${connection}' — they take effect at dispatch once that connection is set up (its local catalog is ` +
      `bound to it at install)`,
  };
};

const catalogKindOf = (manifest: IngredientManifest): CatalogKind =>
  (manifest as { catalog_kind?: CatalogKind }).catalog_kind ?? 'private_byo';

/** R12 guard — refuse to overwrite a slug that already resolves to a
 *  non-locally-authored manifest. A re-install / edit of an already-local slug
 *  is allowed (the local store already holds it). */
const slugConflict = (
  deps: ProvisionAuthoredDeps,
  slug: string,
): boolean => deps.registry.get(slug) !== null && deps.localManifestStore.getManifest(slug) === null;

const persistCompiledRecipes = (
  deps: ProvisionAuthoredDeps,
  recipes: readonly RecipeDefinition[] | undefined,
  publisherId: string,
  packSlug?: string,
): void => {
  if (recipes === undefined || recipes.length === 0 || deps.compiledRecipeStore === undefined) return;
  const installedAt = deps.now();
  for (const recipe of recipes) {
    deps.compiledRecipeStore.save(recipe, publisherId, 'pair-sync', installedAt, packSlug ?? null);
    if (deps.recipeTrustStore !== undefined && isPureWorkflowRecipe(recipe)) {
      const state = recipeTrustStateForPureWorkflow(
        recipe,
        () => new Date(installedAt).toISOString(),
      );
      const stored = deps.recipeTrustStore.set(state);
      if (stored && typeof (stored as Promise<void>).catch === 'function') {
        void (stored as Promise<void>).catch((e) => {
          console.warn(
            `[d-170.n18] failed to mark pure-workflow recipe ${JSON.stringify(recipe.recipe_id)} auto-trusted: ${(e as Error).message ?? String(e)}`,
          );
        });
      }
    }
  }
};

/** Persist one decomposed body + its entity schemas, record inventory, and
 *  register the body for live resolution.
 *
 *  Body-put + `inventory()` run INSIDE one shared-db transaction so they are
 *  atomic (a partial install can't leave an orphan body or orphan inventory);
 *  `registry.register` is in-memory and runs after the commit.
 *
 *  `priorIds` (a pack reinstall's previously-listed catalog ids) drives orphan
 *  cleanup: after `inventory()` GCs the dropped inventory rows, any prior id no
 *  longer the current body AND no longer owned by any pack has its body deleted
 *  in the SAME transaction + is unregistered after — so a reinstall that renames
 *  the catalog slug can't leave the old catalog resolvable-but-unremovable. */
const commit = (
  deps: ProvisionAuthoredDeps,
  body: IngredientManifest,
  entitySchemas: DecomposedArtifacts['entity_schemas'],
  inventory: () => void,
  priorIds: readonly string[] = [],
  recipes: readonly RecipeDefinition[] = [],
  recipePublisher = DEFAULT_AUTHOR,
  recipePackSlug?: string,
  precondition?: () => void,
): void => {
  const orphaned: string[] = [];
  deps.contractStore.transaction(() => {
    // Reconciliation's compare-and-swap fence belongs INSIDE the transaction
    // and BEFORE the first write. A check at the caller would race another
    // server process sharing this WAL database.
    precondition?.();
    // Snapshot which prior ids were LOCAL composition catalogs (`private_byo`)
    // BEFORE `inventory()` can overwrite / GC their rows — only those are bodies
    // THIS pack provisioned, so only those may be orphan-cleaned on a rename /
    // drop. A by-ref id (incl. a standalone local body a pack merely lists by-
    // ref, whose `private_byo` kind was cleared when the by-ref recording
    // overwrote the row) is excluded, so its body is never deleted here.
    const priorLocalCatalogs = new Set(
      priorIds.filter((id) => isPrivateByoIngredient(deps.contractStore, id)),
    );
    deps.localManifestStore.put({ manifest: body, entity_schemas: entitySchemas ?? [] });
    inventory();
    persistCompiledRecipes(deps, recipes, recipePublisher, recipePackSlug);
    for (const id of priorIds) {
      // `isIngredientPackOwned` reads the post-`inventory()` state inside the
      // same transaction, so a prior id this reinstall dropped (and no other
      // pack still lists) is cleaned; a still-shared id survives. Gated on the
      // pre-`inventory()` `private_byo` snapshot so only a catalog this pack
      // authored is deleted — a prior id with no local body (e.g. a slug this
      // pack_slug previously carried via marketplace packs.install) and a by-ref
      // standalone are both left in the store + registry untouched.
      if (
        id !== body.slug
        && priorLocalCatalogs.has(id)
        && !isIngredientPackOwned(deps.contractStore, id)
      ) {
        if (deps.localManifestStore.delete(id)) orphaned.push(id);
      }
    }
  });
  deps.registry.register(body);
  for (const id of orphaned) deps.registry.unregister(id);
};

/** Bare composition → a 1×1 standalone ingredient (the only bare-composition
 *  install shape; a wide composition must be wrapped in an app_pack). */
const provisionBareComposition = (
  deps: ProvisionAuthoredDeps,
  body: unknown,
): IngredientInstallResult => {
  const result = validateComposition(body, COMPOSITION_VALIDATION_OPTS);
  const issues = result.issues.map(toIssue);
  if (!result.valid) {
    return { ok: false, code: 'validation_failed', message: 'composition failed validation', issues };
  }
  const decomposed = result.decomposed as DecomposedArtifacts;
  if (decomposed.ingredient === undefined) {
    return {
      ok: false,
      code: 'validation_failed',
      message:
        'a wide composition (multiple operations / entities) must be installed wrapped in an app_pack so its decomposed children can be linked; only a 1×1 composition installs as a standalone ingredient',
      issues,
    };
  }
  const ingredient = decomposed.ingredient;
  // The decomposer always emits `version: 1` (N.9 version-bump is a later
  // slice); `?? 1` satisfies the optional `IngredientManifest.version` type.
  const version = ingredient.version ?? 1;
  if (slugConflict(deps, ingredient.slug)) {
    return {
      ok: false,
      code: 'slug_conflict',
      message: `slug '${ingredient.slug}' already names an installed ingredient that was not locally authored — choose a different slug or save-as-new`,
      issues,
    };
  }
  // Cross-mode guard — refuse to install a standalone over a pack-owned slug
  // (a pack uninstall would otherwise erase this standalone, or vice versa).
  const owner = ingredientOwnership(deps.contractStore, ingredient.slug);
  if (owner.installed && owner.pack_slug !== undefined) {
    return {
      ok: false,
      code: 'slug_conflict',
      message: `slug '${ingredient.slug}' is already installed as part of pack '${owner.pack_slug}' — uninstall that pack first or choose a different slug`,
      issues,
    };
  }
  // Connection-agnostic op dispatch (slice 2) — a bare 1×1 standalone has no
  // CRM-conformant vendor pack to bind op-steps against; refuse to persist an
  // unrunnable op-step recipe rather than break at execute time.
  const bareRecipes = decomposed.recipes ?? [];
  const opStepRecipe = bareRecipes.find(
    (r) => hasCanonicalOpStep(r) || hasOpStepInPrefetch(r),
  );
  if (opStepRecipe !== undefined) {
    return {
      ok: false,
      code: 'validation_failed',
      message: `recipe '${opStepRecipe.recipe_id}' uses canonical op-steps, which require a CRM-conformant vendor pack — a bare 1×1 composition can't host them`,
      issues,
    };
  }
  try {
    commit(deps, ingredient, decomposed.entity_schemas, () =>
      recordStandaloneIngredient(deps.contractStore, {
        ingredient_id: ingredient.slug,
        version,
        catalog_kind: 'private_byo',
        installed_at: deps.now(),
      }),
      [],
      bareRecipes,
      DEFAULT_AUTHOR,
    );
  } catch (e) {
    return { ok: false, code: 'unexpected', message: (e as Error).message ?? String(e), issues };
  }
  return {
    ok: true,
    installed: { kind: 'ingredient', ingredient_id: ingredient.slug, version },
    ingredient_ids: [ingredient.slug],
    warnings: warningsFrom(issues),
  };
};

/** The validated + decomposed + guarded artifact an app_pack's single
 *  `composition` content lowers to — everything a caller needs to commit, with
 *  the install-path-specific decision (deferred-disclosure vs unified inventory)
 *  left to the caller. */
interface PreparedComposedPack {
  /** The decomposed catalog (wide) or 1×1 ingredient — the one body the pack owns. */
  body: IngredientManifest;
  /** Entity schemas the composition decomposed into (`[]` for a 1×1). */
  entitySchemas: DecomposedArtifacts['entity_schemas'];
  /** `body.version ?? 1` (the v1 decomposer always emits 1). */
  bodyVersion: number;
  packSlug: string;
  packVersion: number;
  /** Catalog ids THIS pack listed before this (re-)install — drives `commit()`'s
   *  orphan cleanup when a reinstall renames the catalog slug. */
  priorIds: string[];
  /** The full validate issue list (callers filter to warnings). */
  issues: AuthoringValidationIssue[];
  /** Non-composition pack contents (recipes, by-ref ingredients, …) — the
   *  `ingredient.install` path defer-discloses these; the bulk path records the
   *  by-ref ingredients + installs the recipes, so it ignores this. */
  nonCompositionContents: PackContentRef[];
  /** D-182 §7.1 — the operation-GROUP ids the composition AUTHORED in
   *  `composition.default_grants` (the pack's explicit declarations, NOT the
   *  decomposer's derived read-tier groups). `resolveInstallGrantWriteSet`
   *  honors the headless-honorable subset (read / `approval: ask`) even with no
   *  install dialog; the silent derived read-tier auto-grant is gone. Empty set
   *  when the composition authored none. */
  authoredGroupIds: ReadonlySet<string>;
  /** The composition's bound connection name (`auth.connection`) — names the
   *  target in the grant disclosure message. `undefined` for a cli_delegated /
   *  connection-less composition. */
  grantConnection: string | undefined;
  /** The composition's operation families — the resolver matches a canonical
   *  op's `<entity>.<verb>` against these (+ reads a per-op `result_path`) when
   *  rewriting op-step recipes at install (slice 2). */
  operationFamilies: OperationRow[];
  /** N.18 compiled workflow recipes emitted from workflow_families. */
  recipes: RecipeDefinition[];
  /** Publisher stamped onto compiled recipe rows. */
  publisher: string;
}

/** Shared validate → decompose → guard core for an app_pack carrying ONE
 *  composition by value. Reused by both install paths (`provisionPack` via
 *  `ingredient.install`, and `provisionPackCompositionForBulkInstall` via
 *  `packs.install`). Pure of writes — every failure is a typed
 *  `IngredientInstallResult`, never a throw; on success the caller commits. */
const prepareComposedPack = (
  deps: ProvisionAuthoredDeps,
  manifest: Record<string, unknown>,
  // D-194 step 3a — the owner's chosen connection (the install-dialog "Connect /
  // Reuse" pick). When present AND the composition binds a connection, it
  // RE-SOURCES `grantConnection` — the grant + `connection_catalog_binding` + op
  // dispatch bind to the chosen connection instead of the composition's authored
  // `auth.connection` literal (§3/§13). A connection-less (cli) composition has
  // nothing to re-target, so the pin is ignored there. Absent ⇒ the authored
  // literal (back-compat).
  chosenConnection?: string,
): { ok: true; prepared: PreparedComposedPack } | { ok: false; result: IngredientInstallResult } => {
  const result = validatePack(manifest, COMPOSITION_VALIDATION_OPTS);
  const issues = result.issues.map(toIssue);
  if (!result.valid) {
    return {
      ok: false,
      result: { ok: false, code: 'validation_failed', message: 'app_pack failed validation', issues },
    };
  }
  const decomposition = result.decomposed as PackDecomposition;
  const compositionContents = decomposition.contents.filter(
    (c): c is Extract<PackContentRef, { type: 'composition' }> => c.type === 'composition',
  );
  if (compositionContents.length === 0) {
    return {
      ok: false,
      result: {
        ok: false,
        code: 'validation_failed',
        message:
          'app_pack carries no composition content — ingredient.install provisions composition capability; install recipe-only packs via packs.install',
        issues,
      },
    };
  }
  if (compositionContents.length > 1) {
    return {
      ok: false,
      result: {
        ok: false,
        code: 'validation_failed',
        message: 'ingredient.install supports one composition per app_pack',
        issues,
      },
    };
  }
  const composition = compositionContents[0].composition as CompositionIngredient;

  // Validation already ran decompose; re-run to get the artifacts (guarded —
  // `validated ⇒ decomposable`, so this is defensive, never the failure path).
  let decomposed: DecomposedArtifacts;
  try {
    decomposed = decomposeComposition[composition.schema_version](composition);
  } catch (e) {
    return { ok: false, result: { ok: false, code: 'unexpected', message: (e as Error).message ?? String(e), issues } };
  }
  const publisher = typeof manifest.publisher === 'string' && manifest.publisher.length > 0
    ? manifest.publisher
    : DEFAULT_AUTHOR;
  // The decomposed body is either a catalog (wide) or a 1×1 ingredient — both
  // install as pack-owned. Exactly one is set on a valid decomposition.
  const decomposedBody = decomposed.catalog ?? decomposed.ingredient;
  if (decomposedBody === undefined) {
    return { ok: false, result: { ok: false, code: 'unexpected', message: 'composition decomposed to no body', issues } };
  }
  // Restamp every NON-first-party pack body with the verified publisher that
  // owns the pack. `decomposeComposition` cannot know marketplace provenance,
  // so its portable output carries `DEFAULT_AUTHOR` (`recued-core`) and legacy
  // slash-form ids. Persisting that output for a third party lets two publishers
  // with the same public slug share grant identities and makes the installed
  // body falsely look first-party.
  //
  // ⚠ NOT a reserved-capability hole — `publisherMayDeclare` reads the PACK
  // MANIFEST's publisher (always `recued-local`), never the catalog's author.
  // What it DOES break: `opGrantEntry` returns the operation_id verbatim, so a
  // slash-form id makes `isGeneratedPackOpEntry` miss and § 9.6's
  // owner-default-only treatment silently does not apply.
  //
  // First-party output stays byte-compatible. Every other publisher receives
  // `<publisher>.<pack>.<operation>` ids, including `recued-local` generated
  // MCP packs and ordinary marketplace compositions.
  const body = publisher === DEFAULT_AUTHOR
    ? decomposedBody
    : stampPackOwnedManifest(decomposedBody, {
        publisher,
        pack_slug: String(manifest.slug),
      });
  // Validation before decomposition proved the portable body. Re-run it after
  // the authority-bearing restamp so this exact persisted body, not merely its
  // pre-provenance precursor, passes the universal catalog gate.
  // The portable-body warnings are already present in `issues`; retain only
  // post-stamp errors here so review copy is not duplicated on every install.
  const stampedErrors = validateIngredient(body).issues
    .filter((issue) => issue.severity === 'error')
    .map(toIssue);
  issues.push(...stampedErrors);
  if (stampedErrors.length > 0) {
    return {
      ok: false,
      result: {
        ok: false,
        code: 'validation_failed',
        message: 'pack-owned manifest failed validation after publisher stamping',
        issues,
      },
    };
  }
  const bodyVersion = body.version ?? 1; // decomposer always emits 1 (see above)
  const packSlug = String(manifest.slug);
  const packVersion = typeof manifest.version === 'number' ? manifest.version : 1;

  const existingLocalBody = deps.localManifestStore.getManifest(body.slug);
  const existingOwnership = ingredientOwnership(deps.contractStore, body.slug);
  // The local manifest store persists JSON, which omits object properties whose
  // value is `undefined`. Compare the candidate in that same storage shape so a
  // byte-equivalent shared body is not mistaken for a rewrite merely because
  // the freshly decomposed object still carries optional `undefined` keys.
  const persistedBodyShape = JSON.parse(JSON.stringify(body)) as IngredientManifest;
  const anotherPackWouldRewriteSharedBody = existingLocalBody !== null
    && existingOwnership.pack_slug !== undefined
    && existingOwnership.pack_slug !== packSlug
    && !isDeepStrictEqual(existingLocalBody, persistedBodyShape);
  if (slugConflict(deps, body.slug) || anotherPackWouldRewriteSharedBody) {
    return {
      ok: false,
      result: {
        ok: false,
        code: 'slug_conflict',
        message: anotherPackWouldRewriteSharedBody
          ? `slug '${body.slug}' is owned by another installed pack with a different body — choose a distinct composition slug`
          : `slug '${body.slug}' already names an installed ingredient that was not locally authored — choose a different slug or save-as-new`,
        issues,
      },
    };
  }
  // Cross-mode guard — refuse to install a pack catalog over a slug already held
  // by a STANDALONE 1×1 ingredient (the standalone would otherwise be silently
  // absorbed and erased when the pack is uninstalled). A different PACK holding
  // the slug is allowed (refcount sharing); a reinstall by THIS same pack is the
  // normal update path.
  const owner = existingOwnership;
  if (owner.installed && owner.pack_slug === undefined) {
    return {
      ok: false,
      result: {
        ok: false,
        code: 'slug_conflict',
        message: `slug '${body.slug}' is already installed as a standalone ingredient — uninstall it first or choose a different slug`,
        issues,
      },
    };
  }
  // Prior catalog ids THIS pack listed — so a reinstall that renamed the catalog
  // slug cleans the old catalog's body + registry entry (commit()).
  const priorIds = packIngredientIds(deps.contractStore, packSlug);
  // Cross-path pack-slug guard — refuse to reuse a pack_slug already held by a
  // NON-authored pack (e.g. a marketplace `packs.install` of marketplace
  // ingredients): such a pack's listed ids are ALL non-local (no body), and
  // proceeding would GC its inventory. A genuine D-170 (re)install ALWAYS carries
  // at least the local composition catalog, so a prior row with ≥1 local body is
  // this pack's own prior install — allowed. NB the `packs.install` unified
  // inventory legitimately lists by-ref marketplace ids (no local body) ALONGSIDE
  // the local catalog, so per-id "no local body" can't be the reuse signal —
  // "NO local body at ALL" is. (commit()'s orphan loop only deletes a prior id's
  // body when it actually has one, so a dropped by-ref id is left untouched.)
  if (priorIds.length > 0 && !priorIds.some((id) => deps.localManifestStore.getManifest(id) !== null)) {
    return {
      ok: false,
      result: {
        ok: false,
        code: 'slug_conflict',
        message: `pack slug '${packSlug}' is already installed by another source — choose a different pack slug`,
        issues,
      },
    };
  }

  return {
    ok: true,
    prepared: {
      body,
      entitySchemas: decomposed.entity_schemas,
      bodyVersion,
      packSlug,
      packVersion,
      priorIds,
      issues,
      nonCompositionContents: decomposition.contents.filter((c) => c.type !== 'composition'),
      authoredGroupIds: new Set(composition.default_grants ?? []),
      // D-194 step 3a — re-source from the owner's chosen connection when the
      // composition binds one; else the authored `auth.connection` literal.
      grantConnection: reSourceGrantConnection(compositionConnectionName(composition), chosenConnection),
      operationFamilies: operationFamiliesFromCatalog(body),
      recipes: decomposed.recipes ?? [],
      publisher,
    },
  };
};

/** App_pack carrying one composition → provision the decomposed catalog (or 1×1
 *  ingredient) + entity schemas, linked under the pack. The `ingredient.install`
 *  path: it records the composition catalog as the pack's sole inventory and
 *  defer-discloses every non-composition content (the recipes a bulk
 *  `packs.install` would install). */
const provisionPack = (
  deps: ProvisionAuthoredDeps,
  manifest: Record<string, unknown>,
  installScope?: InstallGrantSelection,
  // D-194 step 3a — owner's chosen connection (re-sources the grant; see
  // `prepareComposedPack`). A SEPARATE axis from `installScope` (access × scope),
  // not folded into it.
  chosenConnection?: string,
): IngredientInstallResult => {
  const prep = prepareComposedPack(deps, manifest, chosenConnection);
  if (!prep.ok) return prep.result;
  const {
    body, entitySchemas, bodyVersion, packSlug, packVersion, priorIds, issues,
    nonCompositionContents, authoredGroupIds, grantConnection, operationFamilies, recipes, publisher,
  } = prep.prepared;
  // D-182 §7.1 — the grants to WRITE (replaces the silent derived read-tier
  // auto-grant): the pack's authored read/`ask` defaults (always) + the install
  // dialog's chosen access tier (when shown). Absent dialog ⇒ authored-only.
  const grantWriteSet = resolveInstallGrantWriteSet(body, authoredGroupIds, installScope);

  // Connection-agnostic op dispatch (slice 2) — rewrite any op-step recipe to its
  // concrete vendor-bound form BEFORE persisting; hard-block if it can't bind.
  // slice 4.5 — a 3rd-party composition binds against its own merged registry.
  const merge = thirdPartyRegistryMerge(
    body.slug, entitySchemas, deps.vendorForCatalog ?? defaultVendorForCatalog,
  );
  const resolvedRecipes = resolveOpStepRecipes(
    merge.vendorForCatalog,
    recipes,
    {
      packSlug,
      catalogSlug: body.slug,
      connection: grantConnection,
      surfaceResultPath: surfaceResultPathOf(body),
      searchStyle: surfaceSearchStyleOf(body),
      writeStyle: surfaceWriteStyleOf(body),
      operationFamilies,
      registry: merge.registry,
    },
    // D-182 Slice 4 — the pack's recipes' `depends_on` Tier-P ops resolve against
    // the already-installed dependency packs (this pack's own catalog binds via
    // the vendor binder above; its own pack_ref is excluded from the map).
    packOpResolutionFromDeps(deps, `${publisher}.${packSlug}`),
  );
  if (!resolvedRecipes.ok) {
    return { ok: false, code: 'validation_failed', message: resolvedRecipes.message, issues };
  }

  // Honest disclosure of non-composition contents this path does not provision.
  const warnings = warningsFrom(issues);
  warnings.push(...resolvedRecipes.warnings);
  if (nonCompositionContents.length > 0) {
    warnings.push({
      severity: 'warn',
      code: 'authoring_install_deferred_contents',
      path: 'contents',
      message: `${nonCompositionContents.length} non-composition content(s) not provisioned by ingredient.install — install bundled recipes via packs.install`,
    });
  }
  // D-165 P3 — the resolved grants are WRITTEN as pack-owned contract.grant
  // rows (inside the commit transaction, below); this note discloses the
  // effectiveness caveat (a private/local catalog has no operation profile yet).
  const grantWarning = grantProvisioningNote(grantWriteSet, grantConnection);
  if (grantWarning) warnings.push(grantWarning);

  // D-170 gap #2 live-reconcile — capture the reconcile targets BEFORE commit rewrites
  // this pack's bindings (so a reinstall that moved auth.connection also drops the old
  // connection's profile, not just seeds the new one).
  const reconcileTargets = connectionsToReconcileForInstall(deps, packSlug, grantConnection);

  try {
    commit(deps, body, entitySchemas, () => {
      recordPackInventory(deps.contractStore, {
        pack_slug: packSlug,
        publisher,
        pack_version: packVersion,
        // The catalog / ingredient is the one ingredient the pack owns; entity
        // schemas share its id, so a single synthetic ingredient content ref
        // drives the refcount-aware inventory writer.
        contents: [
          { type: 'ingredient', ingredient_id: body.slug, ingredient_version: bodyVersion },
        ],
        catalog_kind: catalogKindOf(body),
        installed_at: deps.now(),
      });
      // Pack-owned grants + the connection→catalog binding commit atomically with
      // the inventory (same db + txn). The binding makes the local catalog resolvable
      // at dispatch + grantable (D-170 gap #2).
      writePackGrants(deps, packSlug, grantWriteSet, grantConnection);
      writeConnectionBinding(deps, packSlug, body.slug, grantConnection);
      // D-182 §7.2 / D-196 — per-door op-admission fan-out (REPLACE semantics:
      // always clears this pack's prior fan-out rows, writes new ones only for
      // non-owner scopes on a connection-backed pack). Same txn as the (A) write.
      applyInstallOpAdmissionFanOut(deps, body, grantWriteSet, packSlug, installScope, grantConnection);
    },
      priorIds,
      resolvedRecipes.recipes,
      publisher,
      packSlug,
    );
  } catch (e) {
    return { ok: false, code: 'unexpected', message: (e as Error).message ?? String(e), issues };
  }

  // D-170 gap #2 live-reconcile — binding + grants committed and the catalog registered
  // (commit() registers after its txn). (Re)derive each target's profile NOW: the bound
  // connection seeds (connect-BEFORE-install dispatch works at once), a connection a
  // reinstall displaced drops (its binding is gone → fail-closed delete).
  for (const name of reconcileTargets) deps.reconcileConnectionProfile?.(name);
  // D-192 — same targets, same moment: register the bound connection's
  // pack-declared work-entity Sources now (or unregister on a reinstall that
  // displaced it), instead of at the next upsert / restart.
  for (const name of reconcileTargets) deps.reconcileWorkEntitySources?.(name);

  return {
    ok: true,
    installed: {
      kind: 'pack',
      pack_slug: packSlug,
      pack_version: packVersion,
      catalog_id: body.slug,
      entity_schema_count: (entitySchemas ?? []).length,
    },
    ingredient_ids: [body.slug],
    warnings,
  };
};

/** D-170 (packs.install composition branch) — provision the composition an
 *  app_pack carries by value as part of an in-flight bulk-pack install (N.17).
 *
 *  The `packs.install` counterpart to `provisionPack`. The bulk path's RECIPES
 *  install separately through the recipe engine, so this differs in two ways:
 *
 *    - **Unified inventory.** It records ONE `installed_pack` row listing the
 *      composition catalog (`private_byo`, local body) AND the pack's by-ref
 *      marketplace ingredients (`byRefContents`, marketplace kind). The caller
 *      MUST therefore SKIP the engine's generic `recordPackInventory` when this
 *      runs — this call owns the pack row (N.14: one pack row lists every child).
 *    - **No recipe deferral warning.** The pack's recipes ARE installed, so its
 *      warnings are the composition's own non-blocking validation issues only.
 *
 *  Same validate → decompose → guard → atomic (body + inventory) commit → live
 *  register as `provisionPack`. Returns the same `IngredientInstallResult` — the
 *  caller reads `installed.catalog_id` / `warnings` on success, or the typed
 *  failure (`validation_failed` / `slug_conflict` / `unexpected`) on a guard /
 *  store error. Never throws. */
export const provisionPackCompositionForBulkInstall = (
  deps: ProvisionAuthoredDeps,
  manifest: unknown,
  byRefContents: readonly PackContentRef[],
  installScope?: InstallGrantSelection,
  // D-194 step 3a — owner's chosen connection (re-sources the grant; see
  // `prepareComposedPack`). Optional, so the boot / foundation callers
  // (`foundation-pack-pre-install.ts`) stay untouched and fall back to the
  // authored literal. Reconciliation controls remain one argument farther out
  // and are never inferred from this owner choice.
  chosenConnection?: string,
  options: ProvisionPackCompositionOptions = {},
): IngredientInstallResult => {
  // Defensive object guard (mirrors `provisionAuthoredArtifact`) — the rpc
  // caller passes `args.manifest: unknown`, already shape-validated upstream by
  // `parseBulkPackManifest`, but keep the provisioner safe to call directly.
  if (!isPlainObject(manifest)) {
    return { ok: false, code: 'validation_failed', message: 'manifest must be an object', issues: [] };
  }
  const preservingState = options.preserveExistingAuthority === true
    ? options.expectedInstalledState
    : undefined;
  // Preserve mode is an internal compare-and-swap operation, never a relaxed
  // form of ordinary install. Requiring both controls together prevents a new
  // caller from silently skipping authority writes without pinning the state it
  // intends to replace.
  if (
    (options.preserveExistingAuthority === true) !==
    (options.expectedInstalledState !== undefined)
  ) {
    return {
      ok: false,
      code: 'validation_failed',
      message: 'authority-preserving install requires an expected installed state',
      issues: [],
    };
  }
  const prep = prepareComposedPack(deps, manifest, chosenConnection);
  if (!prep.ok) return prep.result;
  const {
    body, entitySchemas, bodyVersion, packSlug, packVersion, priorIds, issues,
    authoredGroupIds, grantConnection, operationFamilies, recipes, publisher,
  } = prep.prepared;
  // D-182 §7.1 — the grants to WRITE (see `provisionPack`). The boot / bulk path
  // typically passes NO `installScope` ⇒ authored read/`ask` defaults only (the
  // reception cold-start grant survives; the silent derived read auto-grant does
  // not). `packs.install` forwards the dialog selection when the owner gave one.
  const grantWriteSet = resolveInstallGrantWriteSet(body, authoredGroupIds, installScope);

  // Connection-agnostic op dispatch (slice 2) — rewrite op-step recipes to concrete
  // before persisting (same as provisionPack); hard-block if they can't bind.
  // slice 4.5 — a 3rd-party composition binds against its own merged registry.
  const merge = thirdPartyRegistryMerge(
    body.slug, entitySchemas, deps.vendorForCatalog ?? defaultVendorForCatalog,
  );
  const resolvedRecipes = resolveOpStepRecipes(
    merge.vendorForCatalog,
    recipes,
    {
      packSlug,
      catalogSlug: body.slug,
      connection: grantConnection,
      surfaceResultPath: surfaceResultPathOf(body),
      searchStyle: surfaceSearchStyleOf(body),
      writeStyle: surfaceWriteStyleOf(body),
      operationFamilies,
      registry: merge.registry,
    },
    // D-182 Slice 4 — `depends_on` Tier-P ops resolve against already-installed
    // packs (this pack's own pack_ref is excluded from the map).
    packOpResolutionFromDeps(deps, `${publisher}.${packSlug}`),
  );
  if (!resolvedRecipes.ok) {
    return { ok: false, code: 'validation_failed', message: resolvedRecipes.message, issues };
  }

  if (
    preservingState !== undefined
    && (
      preservingState.body.slug !== body.slug
      || preservingState.installed_pack.publisher !== publisher
      || !isDeepStrictEqual(preservingState.installed_pack.ingredient_ids, [body.slug])
      || preservingState.installed_ingredient.ingredient_id !== body.slug
      || preservingState.installed_ingredient.version !== String(bodyVersion)
      || preservingState.installed_ingredient.source_pack_slug !== packSlug
      || preservingState.installed_ingredient.catalog_kind !== catalogKindOf(body)
      || byRefContents.length !== 0
      || resolvedRecipes.recipes.length !== 0
      || grantConnection !== undefined
      || authoredGroupIds.size !== 0
      || !isDeepStrictEqual(entitySchemas ?? [], preservingState.entity_schemas)
      || (body.work_entity_sources?.length ?? 0) !== 0
    )
  ) {
    return {
      ok: false,
      code: 'validation_failed',
      message: 'authority-preserving install is limited to side-effect-free composition updates',
      issues,
    };
  }

  // D-170 gap #2 live-reconcile — capture targets before commit (see `provisionPack`).
  const reconcileTargets = options.preserveExistingAuthority
    ? []
    : connectionsToReconcileForInstall(deps, packSlug, grantConnection);

  const assertExpectedInstalledState = (): void => {
    const expected = preservingState;
    if (expected === undefined) return;
    const expectedPackSlug = expected.installed_pack.pack_slug;
    const row = typeof expectedPackSlug === 'string'
      ? deps.contractStore.get('installed_pack', [expectedPackSlug])
      : null;
    const ingredientRow = deps.contractStore.get('installed_ingredient', [expected.body.slug]);
    const bodyAtCommit = deps.localManifestStore.getManifest(expected.body.slug);
    const schemasAtCommit = deps.localManifestStore.getEntitySchemas(expected.body.slug);
    const anotherPackClaimsCatalog = deps.contractStore.scan('installed_pack').some((candidate) => {
      if (candidate.segments.length === 1 && candidate.segments[0] === packSlug) return false;
      if (!isPlainObject(candidate.value) || !Array.isArray(candidate.value.ingredient_ids)) {
        return false;
      }
      return candidate.value.ingredient_ids.includes(expected.body.slug);
    });
    if (
      expectedPackSlug !== packSlug
      || !isDeepStrictEqual(row?.value, expected.installed_pack)
      || !isDeepStrictEqual(ingredientRow?.value, expected.installed_ingredient)
      || !isDeepStrictEqual(bodyAtCommit, expected.body)
      || !isDeepStrictEqual(schemasAtCommit, expected.entity_schemas)
      || anotherPackClaimsCatalog
    ) {
      throw new Error('installed pack changed during reconciliation');
    }
  };

  try {
    commit(deps, body, entitySchemas, () => {
      if (preservingState !== undefined) {
        // The precondition above proved this exact row still exists. Change
        // only its pack version: do not rewrite installed_at, authored identity,
        // ingredient provenance, or any shared installed_ingredient row.
        deps.contractStore.put('installed_pack', [packSlug], {
          ...preservingState.installed_pack,
          version: String(packVersion),
        });
      } else {
        recordPackInventory(deps.contractStore, {
          pack_slug: packSlug,
          publisher,
          pack_version: packVersion,
          // By-ref marketplace ingredients keep their (absent) marketplace kind;
          // recordPackInventory ignores every non-`ingredient` content (recipes,
          // the composition itself). The composition catalog joins the SAME pack
          // row via `local_catalogs` with `private_byo` (its body is local).
          contents: byRefContents,
          local_catalogs: [
            { ingredient_id: body.slug, version: bodyVersion, catalog_kind: catalogKindOf(body) },
          ],
          installed_at: deps.now(),
        });
      }
      if (!options.preserveExistingAuthority) {
        // D-165 P3 — write the resolved grants pack-owned, atomic with the
        // inventory. The bulk result carries no `warnings` field, so (unlike
        // `provisionPack`) there's no effectiveness note — the rows are written the
        // same way, and the packs.install handler no longer discloses them as deferred.
        writePackGrants(deps, packSlug, grantWriteSet, grantConnection);
        // D-170 gap #2 — the connection→catalog binding (resolvable + grantable).
        writeConnectionBinding(deps, packSlug, body.slug, grantConnection);
        // D-182 §7.2 / D-196 — per-door op-admission fan-out (REPLACE; see
        // `provisionPack`). Same txn; writes only for non-owner scopes on
        // connection-backed packs.
        applyInstallOpAdmissionFanOut(
          deps,
          body,
          grantWriteSet,
          packSlug,
          installScope,
          grantConnection,
        );
      }
    },
      priorIds,
      resolvedRecipes.recipes,
      publisher,
      packSlug,
      preservingState === undefined ? undefined : assertExpectedInstalledState,
    );
  } catch (e) {
    return { ok: false, code: 'unexpected', message: (e as Error).message ?? String(e), issues };
  }

  // D-170 gap #2 live-reconcile — same as `provisionPack`: post-commit, seed the bound
  // connection + drop any connection a reinstall displaced (binding gone → fail-closed).
  for (const name of reconcileTargets) deps.reconcileConnectionProfile?.(name);
  // D-192 — same targets, same moment: register the bound connection's
  // pack-declared work-entity Sources now (or unregister on a reinstall that
  // displaced it), instead of at the next upsert / restart.
  for (const name of reconcileTargets) deps.reconcileWorkEntitySources?.(name);

  // The bulk path installs the pack's recipes through the engine, and the
  // packs.install RESULT surface (`BulkPackInstallResultLike`) has NO `warnings`
  // field. The composition's `grant_defaults` are now WRITTEN pack-owned above
  // (D-165 P3), so they are no longer disclosed as `deferred_contents` — this
  // path's warnings are the composition's own non-blocking validation issues only.
  return {
    ok: true,
    installed: {
      kind: 'pack',
      pack_slug: packSlug,
      pack_version: packVersion,
      catalog_id: body.slug,
      entity_schema_count: (entitySchemas ?? []).length,
    },
    ingredient_ids: [body.slug],
    warnings: [...warningsFrom(issues), ...resolvedRecipes.warnings],
  };
};

/** Provision a locally-authored artifact from a raw manifest. Discriminates a
 *  bare composition (D-182 `operations` table) from an app_pack
 *  (`manifest_version`) and routes accordingly. Never throws — every failure is a
 *  typed `IngredientInstallResult`. */
export const provisionAuthoredArtifact = (
  deps: ProvisionAuthoredDeps,
  rawManifest: unknown,
  installScope?: InstallGrantSelection,
  // D-194 step 3a — owner's chosen connection, forwarded to the app_pack path
  // (`provisionPack`). A bare 1×1 composition writes no grants, so it's ignored
  // there.
  chosenConnection?: string,
): IngredientInstallResult => {
  if (!isPlainObject(rawManifest)) {
    return { ok: false, code: 'validation_failed', message: 'manifest must be an object', issues: [] };
  }
  if (typeof rawManifest.manifest_version === 'number') {
    return provisionPack(deps, rawManifest, installScope, chosenConnection);
  }
  if (Array.isArray(rawManifest.operations)) {
    // A bare 1×1 standalone composition writes no operation-group grants
    // (`provisionBareComposition` records the ingredient only — there are no
    // derived groups to grant), so the install scope is inapplicable here.
    return provisionBareComposition(deps, rawManifest);
  }
  return {
    ok: false,
    code: 'validation_failed',
    message:
      'manifest is neither a composition (expected `operations`) nor an app_pack (expected `manifest_version`)',
    issues: [],
  };
};
