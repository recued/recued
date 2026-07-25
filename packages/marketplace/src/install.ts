/** D-122 Phase 4 — atomic bulk-pack install transaction.
 *
 *  Pure orchestrator. The marketplace layer resolves a `BulkPackManifest`
 *  into resolved recipe rows; this function consumes those rows + the
 *  user's permission decisions + a pluggable `InstallRegistry`-shaped
 *  adapter, and runs the install of every recipe in the pack in one
 *  transaction. On any single-recipe failure, rollback the partial
 *  state to what it was before the install started.
 *
 *  Engine layer doesn't import from `@recued/marketplace` (would invert
 *  the package dep direction), so the inputs are typed locally — the
 *  marketplace's `BulkPackResolution` shape conforms to
 *  `BulkPackInstallInput` without needing a shared type.
 *
 *  Failure modes (each surfaces a distinct `code` so the dialog can
 *  render targeted copy):
 *    - `permission_denied` — user rejected (or the manifest declared)
 *      a permission the engine couldn't grant.
 *    - `version_mismatch` — pack's `manifest_version` is not one the
 *      runtime supports (`SUPPORTED_BULK_PACK_MANIFEST_VERSIONS`).
 *    - `unresolved` — caller flagged at least one recipe with a
 *      `failure` (not_found / version_drift / fetch_error).
 *    - `validator_rejected` — `parseRecipe` rejected one of the
 *      resolved recipes.
 *    - `unexpected` — registry raised an unhandled exception. The
 *      rollback path runs and the original error is wrapped.
 *
 *  Pre-rip versions seeded backfill state for `runs_on` recipes via a
 *  `seedBackfill` callback the server passed in. After the runs_on
 *  rip there is no install-time backfill seeding — initial-install
 *  catch-up flows through the adapter path (D-124 P2.1) and reactive
 *  recipes accumulate forward (Model A; spec §"Backfill model").
 *
 *  Spec: D-122 §"Atomic install" + Phase 4.
 */

import {
  BULK_PACK_INSTALL_PERMISSION,
  PAID_DOCUMENT_FULFILLMENT_BUNDLE_KEY,
  SUPPORTED_BULK_PACK_MANIFEST_VERSIONS,
  isCanonicalOpStep,
  validateWebhookRequirements,
  validateWebhookTriggerBindings,
  validateRecipeBundlePublisher,
  type PackContentRef,
  type PackWebhookRequirement,
  type RecipeDefinition,
  type RecipeStep,
} from '@recued/contracts';
import { parseRecipe } from '@recued/recipes';

/** Shape of one resolved recipe entry inside a pack. The marketplace
 *  package's `ResolvedPackRecipe` conforms structurally — the engine
 *  doesn't import it to avoid the package-direction inversion.
 *
 *  `failure` mirrors the marketplace resolver's enum; the engine treats
 *  any non-undefined value as a hard reject. */
export interface BulkPackInstallRecipe {
  slug: string;
  pinned_version: number;
  recipe: {
    recipe_id: string;
    publisher_id: string;
    version: number;
    recipe_hash: string;
    recipe: RecipeDefinition;
  } | null;
  failure?: 'not_found' | 'version_drift' | 'fetch_error';
}

/** Pack-level inputs the engine needs from the manifest. Mirrors the
 *  fields the marketplace's `BulkPackResolution.manifest` provides
 *  without importing the type. */
export interface BulkPackInstallInput {
  /** `1` (recipe-only, D-122) or `2` (app-pack, D-165). The engine
   *  accepts every entry in `SUPPORTED_BULK_PACK_MANIFEST_VERSIONS`;
   *  anything else fails `version_mismatch` before any recipe lands. */
  manifest_version: number;
  pack_slug: string;
  publisher: string;
  /** Permissions the manifest declared. The engine cross-checks every
   *  entry against `granted_permissions` from the dialog. */
  requires: string[];
  recipes: BulkPackInstallRecipe[];
  /** D-165 app-pack v2 — the manifest's full normalized content list
   *  (`normalizeBulkPackInstallPlan(manifest).contents`): recipe refs
   *  PLUS the non-recipe app-pack contents (catalog ingredients,
   *  operation-group grants, channel bindings, policies). Optional — v1
   *  callers + the extension IDB path omit it.
   *
   *  The recipe install path is driven solely by `recipes` (which the
   *  parser/handler populate from the lifted recipe contents); the
   *  engine reads `contents` ONLY to echo the non-recipe entries back as
   *  `result.deferred_contents`. It does NOT provision them — pack-owned
   *  grant / connection-binding / channel-registration is the P3 install
   *  planner, blocked on D-166 (`InstalledAgentConnectionGrant` four-tuple
   *  store + cross-spec `contract.*` merge). Surfacing them keeps the
   *  install honest (no silent capability drop) and seats the P3 seam. */
  contents?: PackContentRef[];
  /** True only when every entry's `failure` is undefined. The engine
   *  refuses to start otherwise — the dialog should not have surfaced
   *  the install button. */
  ready: boolean;
  /** D-139 P6.B — optional MCP body-content permission grants the
   *  pack install transaction must persist. When non-empty, the
   *  engine calls `ctx.grantBodyVisibility?` with the closed-list
   *  registry keys after every recipe lands; rollback calls
   *  `ctx.revokeBodyVisibility?` with the same set. The pack
   *  manifest's `mcp_body_visibility_grants` field flows through to
   *  this slot via the marketplace resolver. Closed-list contents
   *  per `BULK_PACK_BODY_VISIBILITY_GRANT_KEYS` in `@recued/contracts`. */
  mcp_body_visibility_grants?: ReadonlyArray<string>;
  /** D-201 — validated pack-level logical webhook bindings. */
  webhook_requirements?: ReadonlyArray<PackWebhookRequirement>;
  /** D-201 Slice 4 — explicit owner choices, supplied by the install dialog and
   * never read from the pack manifest. Exactly one ingress is required for
   * every declared logical binding; extras and omissions fail before mutation. */
  webhook_bindings?: ReadonlyArray<{
    binding: string;
    ingress_id: string;
  }>;
}

/** Shape of one row the install registry persists per installed recipe.
 *  Structural duplicate of `@recued/marketplace`'s `InstalledRecipe` —
 *  the engine doesn't import it to keep the dep direction marketplace
 *  → engine, never the reverse. */
export interface InstalledRecipeRow {
  recipe_id: string;
  publisher_id: string;
  installed_version: number;
  installed_hash: string;
  installed_at: number;
  recipe: RecipeDefinition;
  auto_run: boolean;
  last_checked_at: number | null;
  upstream_version: number | null;
  upstream_hash: string | null;
  /** D-145 PA10 follow-on — per-recipe pack provenance, round-tripped
   *  through getInstalled → markInstalled so a rollback restoration
   *  preserves the prior's pack ownership. Hosts that don't track
   *  pack provenance (the IDB-backed extension registry) may omit;
   *  the engine never inspects the value, it only forwards it.
   *  - `string` — the slug of the pack that installed this recipe;
   *  - `null` — pre-existing (bundled, manually installed) or
   *    explicitly cleared;
   *  - `undefined` — host doesn't track pack provenance (the wrapper
   *    decides whether to stamp the current pack slug or leave the
   *    column NULL based on the call site). */
  pack_slug?: string | null;
}

/** Minimal registry interface the engine needs. The full
 *  `InstallRegistry` from `@recued/marketplace` extends this; the engine
 *  intentionally takes only the methods it uses. */
export interface BulkPackRegistry {
  getInstalled(recipe_id: string, publisher_id: string): Promise<InstalledRecipeRow | null>;
  markInstalled(record: InstalledRecipeRow): Promise<void>;
  markUninstalled(recipe_id: string, publisher_id: string): Promise<void>;
}

/** Caller's hash function — content addressing for an installed recipe.
 *  Same FNV-1a / canonical-hash function the marketplace listing layer
 *  uses; injected so the engine doesn't take a hash dep. */
export type RecipeHasher = (recipe: RecipeDefinition) => string;

/** Inputs to `installBulkPack`. */
export interface BulkPackInstallContext {
  /** Permissions granted via the install dialog. Must include the pack-
   *  install permission + every entry the manifest's `requires` array
   *  declared; missing entries fail with `permission_denied`. */
  granted_permissions: Set<string>;
  /** Local install registry — the actual persistence layer (IDB on the
   *  extension, SQLite on the server). The engine reads + writes
   *  through this interface; pluggable so tests use in-memory. */
  registry: BulkPackRegistry;
  /** Hash function. The engine has no canonical hasher of its own; it
   *  receives one from the marketplace package (`recipe_hash`). */
  hashRecipe: RecipeHasher;
  /** When to opt the recipe into auto-run. Per-recipe override at the
   *  install layer; defaults to false when omitted. */
  auto_run_default?: boolean;
  /** Now in epoch ms. Tests inject a fixed clock; production callers
   *  pass `Date.now()` (or omit, the function defaults). */
  now?: number;
  /** D-139 P6.B — optional callback the engine invokes AFTER every
   *  recipe has been markInstalled when `input.mcp_body_visibility_grants`
   *  is non-empty. Persists per-pack body-content MCP permission rows
   *  (substrate-side store landing alongside this commit; see
   *  spec § A.9.5 + § P6.B "P6.B — Body-content permission grant on
   *  install" acceptance). Rollback path invokes
   *  `revokeBodyVisibility` with the same set. Hosts that don't ship
   *  the body-grant store yet may omit both fields — the engine
   *  silently skips when undefined; the substrate is already
   *  validator-rejected on the contracts layer when grants would
   *  otherwise be silently dropped. */
  grantBodyVisibility?: (input: {
    pack_slug: string;
    publisher: string;
    grants: ReadonlyArray<string>;
    granted_at: number;
  }) => Promise<void>;
  /** D-139 P6.B — counterpart to `grantBodyVisibility`. Engine
   *  invokes this on rollback (per-recipe install failure → revoke
   *  any grants that were already persisted in the same transaction).
   *  Hosts that don't ship the body-grant store yet may omit; the
   *  engine still emits the rollback entries on the result. */
  revokeBodyVisibility?: (input: {
    pack_slug: string;
    publisher: string;
    grants: ReadonlyArray<string>;
    revoked_at: number;
  }) => Promise<void>;
  /** D-201 Slice 4 — persist the complete binding/trigger set after every
   * recipe row lands. The opaque return value snapshots any prior install so a
   * later transaction failure can restore it exactly. */
  applyWebhookBindings?: (input: {
    pack_slug: string;
    publisher: string;
    requirements: readonly PackWebhookRequirement[];
    selections: readonly { binding: string; ingress_id: string }[];
    recipes: readonly {
      recipe_id: string;
      publisher_id: string;
      webhook_triggers: Readonly<NonNullable<RecipeDefinition['webhook_triggers']>>;
    }[];
  }) => Promise<unknown>;
  /** Exact rollback counterpart for `applyWebhookBindings`. */
  restoreWebhookBindings?: (rollbackToken: unknown) => Promise<void>;
}

/** Per-recipe outcome inside the install transaction. */
export interface BulkPackInstallEntry {
  slug: string;
  publisher_id: string;
  version: number;
  /** True when this recipe was installed as part of this transaction
   *  (and not pre-existing). Used by the rollback path. */
  fresh_install: boolean;
  /** Pre-install state of this slug. `null` when the recipe was not
   *  installed before; used to restore state on rollback. */
  prior?: InstalledRecipeRow | null;
}

/** Final result. */
export interface BulkPackInstallResult {
  ok: boolean;
  installed: BulkPackInstallEntry[];
  /** Entries the rollback path uninstalled / restored. Same set the
   *  caller can echo back to the audit emitter. */
  rolled_back: BulkPackInstallEntry[];
  /** D-165 app-pack v2 — the non-recipe contents the manifest declared
   *  (catalog ingredients, operation-group grants, channel bindings,
   *  policies) that this install transaction did NOT provision. Populated
   *  on the success path only (an `ok: false` rollback provisions
   *  nothing). Empty / absent when the pack carried only recipes (every
   *  v1 pack). These require the P3 install planner (blocked on D-166) to
   *  bind connections + persist pack-owned grants + register channels;
   *  the engine surfaces them so the dialog can disclose them and audit
   *  can record the deferral rather than silently dropping the
   *  capability. */
  deferred_contents?: PackContentRef[];
  /** When ok=false, what went wrong. */
  failure?: {
    code: 'permission_denied' | 'version_mismatch' | 'validator_rejected' | 'unresolved' | 'unexpected';
    message: string;
    /** The slug we were trying to install when the failure happened.
     *  Empty for pack-level failures (`permission_denied` /
     *  `version_mismatch` / `unresolved` checked against the resolution). */
    failed_at?: { slug: string; version: number };
  };
}

/** Run the atomic install transaction. */
export const installBulkPack = async (
  input: BulkPackInstallInput,
  ctx: BulkPackInstallContext,
): Promise<BulkPackInstallResult> => {
  const installed: BulkPackInstallEntry[] = [];
  const rolled_back: BulkPackInstallEntry[] = [];
  const now = ctx.now ?? Date.now();

  // ────────────────────────────────────────────────────────────────
  // Pre-flight: pack version + permission gates
  // ────────────────────────────────────────────────────────────────

  // D-165 — accept every supported pack schema version (v1 recipe-only +
  // v2 app-pack). `parseBulkPackManifest` already rejects unsupported
  // versions upstream; this is the belt-and-suspenders gate for direct
  // engine callers (extension IDB path, tests).
  if (!(SUPPORTED_BULK_PACK_MANIFEST_VERSIONS as readonly number[]).includes(input.manifest_version)) {
    return {
      ok: false,
      installed,
      rolled_back,
      failure: {
        code: 'version_mismatch',
        message: `Pack manifest_version ${input.manifest_version} is not supported by this runtime (supports ${SUPPORTED_BULK_PACK_MANIFEST_VERSIONS.join(', ')})`,
      },
    };
  }

  for (const required of input.requires) {
    if (!ctx.granted_permissions.has(required)) {
      return {
        ok: false,
        installed,
        rolled_back,
        failure: {
          code: 'permission_denied',
          message: `Permission ${JSON.stringify(required)} was not granted`,
        },
      };
    }
  }
  // Belt-and-suspenders: even if a manifest somehow ships without the
  // install permission in `requires`, the engine still requires the
  // dialog to grant it.
  if (!ctx.granted_permissions.has(BULK_PACK_INSTALL_PERMISSION)) {
    return {
      ok: false,
      installed,
      rolled_back,
      failure: {
        code: 'permission_denied',
        message: `Permission ${JSON.stringify(BULK_PACK_INSTALL_PERMISSION)} was not granted`,
      },
    };
  }

  if (!input.ready) {
    return {
      ok: false,
      installed,
      rolled_back,
      failure: {
        code: 'unresolved',
        message: 'One or more recipes in the pack failed to resolve from the marketplace',
      },
    };
  }

  // D-201 Slice 0 — cross-artifact preflight.  Manifest and recipe validators
  // can each run before recipe refs resolve; this is the first boundary that
  // has BOTH declarations.  Reject before any registry mutation when a recipe
  // names another pack as its binding authority, an unknown binding, or an
  // event type the pack did not disclose as required/optional.
  if (input.webhook_requirements !== undefined) {
    const requirementIssues = validateWebhookRequirements(input.webhook_requirements);
    if (requirementIssues.length > 0) {
      const first = requirementIssues[0];
      return {
        ok: false,
        installed,
        rolled_back,
        failure: {
          code: 'validator_rejected',
          message: `Pack webhook requirement failed validation: ${first.path}: ${first.message}`,
        },
      };
    }
  }
  const expectedBundle = `${input.publisher}/${input.pack_slug}`;

  // D-200 Slice 0 — prove the member slug/version identity literals while the
  // authoritative pack and all resolved bodies are together, before the first
  // registry mutation. (The shared-key namespace validator that also ran here
  // died with the D-200 shared-state machine — D-207 3d·6.)
  if (expectedBundle === PAID_DOCUMENT_FULFILLMENT_BUNDLE_KEY) {
    const declaredMembers = input.contents?.filter(
      (content): content is Extract<PackContentRef, { type: 'recipe' }> =>
        content.type === 'recipe',
    );
    if (declaredMembers === undefined
      || declaredMembers.length !== input.recipes.length
      || new Set(declaredMembers.map((member) => member.slug)).size !== declaredMembers.length
      || new Set(input.recipes.map((member) => member.slug)).size !== input.recipes.length) {
      return {
        ok: false,
        installed,
        rolled_back,
        failure: {
          code: 'validator_rejected',
          message: 'D-200 pack install requires one resolved recipe for every unique declared member',
        },
      };
    }
    const declaredBySlug = new Map(
      declaredMembers.map((member) => [member.slug, member.version] as const),
    );
    for (const resolved of input.recipes) {
      const declaredVersion = declaredBySlug.get(resolved.slug);
      const definition = resolved.recipe?.recipe;
      const definitionIdentity = definition !== null && typeof definition === 'object'
        ? definition as unknown as { recipe_id?: unknown; version?: unknown }
        : null;
      if (declaredVersion !== resolved.pinned_version
        || resolved.recipe?.recipe_id !== resolved.slug
        || resolved.recipe?.version !== resolved.pinned_version
        || (definitionIdentity !== null && (
          definitionIdentity.recipe_id !== resolved.slug
          || definitionIdentity.version !== resolved.pinned_version
        ))) {
        return {
          ok: false,
          installed,
          rolled_back,
          failure: {
            code: 'validator_rejected',
            message: `D-200 pack member '${resolved.slug}' does not match its declared slug/version identity`,
            failed_at: { slug: resolved.slug, version: resolved.pinned_version },
          },
        };
      }
    }
  }

  let hasRecipeWebhookTriggers = false;
  for (const resolved of input.recipes) {
    const definition = resolved.recipe?.recipe;
    // `== null` — a malformed resolved body can be `null` at runtime despite the
    // non-null type; it must reach the parseRecipe pass below, not throw here.
    if (definition == null) continue;
    if (Array.isArray(definition.webhook_requirements)
      && definition.webhook_requirements.length > 0) {
      return {
        ok: false,
        installed,
        rolled_back,
        failure: {
          code: 'validator_rejected',
          message: `Recipe '${resolved.slug}' is pack-owned and must inherit the pack webhook requirements`,
          failed_at: { slug: resolved.slug, version: resolved.pinned_version },
        },
      };
    }
    if (!Array.isArray(definition.webhook_triggers)
      || definition.webhook_triggers.length === 0) continue;
    hasRecipeWebhookTriggers = true;
    if (definition.metadata?.recipe_bundle !== expectedBundle) {
      return {
        ok: false,
        installed,
        rolled_back,
        failure: {
          code: 'validator_rejected',
          message: `Recipe '${resolved.slug}' webhook_triggers require metadata.recipe_bundle '${expectedBundle}'`,
          failed_at: { slug: resolved.slug, version: resolved.pinned_version },
        },
      };
    }
    const bindingIssues = validateWebhookTriggerBindings(
      input.webhook_requirements ?? [],
      definition.webhook_triggers,
    );
    if (bindingIssues.length > 0) {
      const first = bindingIssues[0];
      return {
        ok: false,
        installed,
        rolled_back,
        failure: {
          code: 'validator_rejected',
          message: `Recipe '${resolved.slug}' webhook trigger failed pack binding validation: ${first.path}: ${first.message}`,
          failed_at: { slug: resolved.slug, version: resolved.pinned_version },
        },
      };
    }
  }

  const webhookRequirements = input.webhook_requirements ?? [];
  const webhookBindings = input.webhook_bindings ?? [];
  const hasWebhookDeclarations = webhookRequirements.length > 0
    || hasRecipeWebhookTriggers;
  const selectionByBinding = new Map<string, string>();
  for (let index = 0; index < webhookBindings.length; index += 1) {
    const selection = webhookBindings[index];
    if (selection === null
      || typeof selection !== 'object'
      || Object.getPrototypeOf(selection) !== Object.prototype
      || Object.keys(selection).sort().join(',') !== 'binding,ingress_id'
      || typeof selection.binding !== 'string'
      || typeof selection.ingress_id !== 'string'
      || selection.ingress_id.length === 0
      || selectionByBinding.has(selection.binding)) {
      return {
        ok: false,
        installed,
        rolled_back,
        failure: {
          code: 'validator_rejected',
          message: `Pack webhook binding selection ${index} is invalid or duplicated`,
        },
      };
    }
    selectionByBinding.set(selection.binding, selection.ingress_id);
  }
  const requirementBindings = new Set(
    webhookRequirements.map((requirement) => requirement.binding),
  );
  if (selectionByBinding.size !== requirementBindings.size
    || [...selectionByBinding.keys()].some((binding) => !requirementBindings.has(binding))) {
    return {
      ok: false,
      installed,
      rolled_back,
      failure: {
        code: 'validator_rejected',
        message: 'Pack install requires exactly one owner-selected ingress for every webhook binding',
      },
    };
  }
  if (hasWebhookDeclarations
    && (!ctx.applyWebhookBindings || !ctx.restoreWebhookBindings)) {
    return {
      ok: false,
      installed,
      rolled_back,
      failure: {
        code: 'validator_rejected',
        message: 'D-201 webhook declarations require the Slice 4 consumer store',
      },
    };
  }

  // ────────────────────────────────────────────────────────────────
  // Apply each recipe inside a try/finally rollback frame
  // ────────────────────────────────────────────────────────────────

  // D-139 P6.B — track whether body grants have been persisted in
  // this transaction so rollback can revoke them. Closed-list grants
  // come from `input.mcp_body_visibility_grants` (validator-rejected
  // outside `BULK_PACK_BODY_VISIBILITY_GRANT_KEYS` upstream).
  let bodyGrantsPersisted = false;
  const bodyGrants = input.mcp_body_visibility_grants ?? [];
  let webhookBindingsPersisted = false;
  let webhookBindingsRollbackToken: unknown;

  const rollback = async (
    failureCode: BulkPackInstallResult['failure'] & object,
  ): Promise<BulkPackInstallResult> => {
    // Reverse the install order on rollback: body grants revoked, then
    // recipe rows unwound. Each step is best-effort: a thrown rollback
    // handler doesn't block the remaining steps — the surfaced failure
    // code carries the original cause regardless.
    // D-139 P6.B — revoke any body grants we persisted before the
    // failure. Hosts that don't ship `revokeBodyVisibility` skip
    // gracefully (rollback path stays valid; the grant-store
    // substrate may not yet exist on every host).
    if (bodyGrantsPersisted && bodyGrants.length > 0 && ctx.revokeBodyVisibility) {
      try {
        await ctx.revokeBodyVisibility({
          pack_slug: input.pack_slug,
          publisher: input.publisher,
          grants: bodyGrants,
          revoked_at: now,
        });
      } catch {
        // Same swallow-on-rollback rule as the registry-side rollback.
      }
    }
    if (webhookBindingsPersisted && ctx.restoreWebhookBindings) {
      try {
        await ctx.restoreWebhookBindings(webhookBindingsRollbackToken);
      } catch {
        // Trigger selection still joins installed recipe rows, so a failed
        // best-effort restore cannot dispatch a freshly rolled-back recipe.
      }
    }
    for (const entry of installed.slice().reverse()) {
      try {
        if (entry.fresh_install) {
          await ctx.registry.markUninstalled(entry.slug, entry.publisher_id);
        } else if (entry.prior != null) {
          // Restore the prior install record to undo the version bump.
          await ctx.registry.markInstalled(entry.prior);
        }
      } catch {
        // Rollback errors are swallowed — best-effort restoration; the
        // failure cause is what the caller sees.
      }
      rolled_back.push(entry);
    }
    return {
      ok: false,
      installed: [],
      rolled_back,
      failure: failureCode,
    };
  };

  for (const resolved of input.recipes) {
    if (resolved.recipe == null) {
      // input.ready was true so this branch is unreachable —
      // belt-and-suspenders for type safety.
      return rollback({
        code: 'unresolved',
        message: `Resolved recipe was unexpectedly null for slug ${resolved.slug}`,
        failed_at: { slug: resolved.slug, version: resolved.pinned_version },
      });
    }
    const row = resolved.recipe;
    const def = row.recipe;

    // Validator pass — `parseRecipe` is the source of truth; rejecting
    // mid-transaction triggers rollback.
    const parsed = parseRecipe(def);
    if (!parsed.ok) {
      const first = parsed.issues.find((i) => i.severity === 'error');
      return rollback({
        code: 'validator_rejected',
        message: first?.message ?? 'Recipe failed validation',
        failed_at: { slug: row.recipe_id, version: row.version },
      });
    }
    const bundleIssues = validateRecipeBundlePublisher(
      def as unknown as Record<string, unknown>,
      row.publisher_id,
    );
    if (bundleIssues.length > 0) {
      return rollback({
        code: 'validator_rejected',
        message: bundleIssues[0]?.message ?? 'Recipe bundle publisher mismatch',
        failed_at: { slug: row.recipe_id, version: row.version },
      });
    }

    // Slice 3 / A3 safety net — the recipe validator ACCEPTS canonical op-steps
    // (so they can be authored + published), but the engine has no op→ingredient
    // dispatch: a connection-agnostic recipe MUST be R1-rewritten to concrete
    // bindings before this transaction persists it (the `packs.install` handler
    // resolves bundled op-step recipes against the pack's composition). Reject
    // loudly rather than install an unrunnable recipe — closes the "validator
    // opens → this path silently persists unresolved op-steps" gap (A3).
    const unresolvedOpStep =
      (def.steps ?? []).some(isCanonicalOpStep)
      || (def.prefetch_steps ?? []).some((s) => isCanonicalOpStep(s as unknown as RecipeStep));
    if (unresolvedOpStep) {
      return rollback({
        code: 'validator_rejected',
        message: `Recipe '${row.recipe_id}' contains an unresolved canonical op-step — connection-agnostic recipes must be resolved to a concrete pack binding at install`,
        failed_at: { slug: row.recipe_id, version: row.version },
      });
    }

    let prior: InstalledRecipeRow | null = null;
    try {
      prior = await ctx.registry.getInstalled(row.recipe_id, row.publisher_id);
    } catch (e) {
      return rollback({
        code: 'unexpected',
        message: `registry.getInstalled threw: ${(e as Error).message ?? String(e)}`,
        failed_at: { slug: row.recipe_id, version: row.version },
      });
    }

    const installRecord: InstalledRecipeRow = {
      recipe_id: row.recipe_id,
      publisher_id: row.publisher_id,
      installed_version: row.version,
      installed_hash: ctx.hashRecipe(def),
      installed_at: now,
      recipe: def,
      auto_run: ctx.auto_run_default ?? false,
      last_checked_at: now,
      upstream_version: row.version,
      upstream_hash: row.recipe_hash,
    };

    try {
      await ctx.registry.markInstalled(installRecord);
    } catch (e) {
      return rollback({
        code: 'unexpected',
        message: `registry.markInstalled threw: ${(e as Error).message ?? String(e)}`,
        failed_at: { slug: row.recipe_id, version: row.version },
      });
    }

    const entry: BulkPackInstallEntry = {
      slug: row.recipe_id,
      publisher_id: row.publisher_id,
      version: row.version,
      fresh_install: prior == null,
      prior,
    };
    installed.push(entry);
  }

  // D-201 Slice 4 — bind logical slots and materialize exact recipe/event
  // triggers only after all recipe rows exist. The consumer store returns an
  // opaque snapshot so any later grant failure restores a prior install rather
  // than merely deleting it.
  if (hasWebhookDeclarations && ctx.applyWebhookBindings) {
    try {
      webhookBindingsRollbackToken = await ctx.applyWebhookBindings({
        pack_slug: input.pack_slug,
        publisher: input.publisher,
        requirements: webhookRequirements,
        selections: webhookBindings,
        recipes: input.recipes.map((resolved) => ({
          recipe_id: resolved.recipe!.recipe_id,
          publisher_id: resolved.recipe!.publisher_id,
          webhook_triggers: resolved.recipe!.recipe.webhook_triggers ?? [],
        })),
      });
      webhookBindingsPersisted = true;
    } catch (error) {
      return rollback({
        code: 'validator_rejected',
        message: `Webhook binding failed: ${(error as Error).message ?? String(error)}`,
      });
    }
  }

  // D-139 P6.B — persist body-content MCP grants AFTER every recipe
  // has landed in the registry so a rollback during install reverts
  // the grant alongside the registry rows. Hosts that don't ship the
  // grant store yet may omit `grantBodyVisibility`; the manifest
  // field is then a contract-only declaration (validator-checked at
  // parse time, persisted when the host opts in). When the callback
  // throws, treat as `unexpected` failure + roll back.
  if (bodyGrants.length > 0 && ctx.grantBodyVisibility) {
    try {
      await ctx.grantBodyVisibility({
        pack_slug: input.pack_slug,
        publisher: input.publisher,
        grants: bodyGrants,
        granted_at: now,
      });
      bodyGrantsPersisted = true;
    } catch (e) {
      return rollback({
        code: 'unexpected',
        message: `grantBodyVisibility threw: ${(e as Error).message ?? String(e)}`,
      });
    }
  }

  // D-165 app-pack v2 — echo the non-recipe contents the manifest
  // declared but this transaction did not provision (recipe contents are
  // already installed via `input.recipes`). NOT persisted: pack-owned
  // grant / connection-binding / channel-registration is the P3 install
  // planner (blocked on D-166). Surfacing keeps the install honest and
  // lets the dialog disclose + audit record the deferral.
  const deferred_contents = (input.contents ?? []).filter(
    (c) => c.type !== 'recipe',
  );

  return {
    ok: true,
    installed,
    rolled_back,
    ...(deferred_contents.length > 0 ? { deferred_contents } : {}),
  };
};
