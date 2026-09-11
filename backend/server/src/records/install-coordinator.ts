import type {
  BulkPackInstallEntryLike,
  BulkPackManifest,
  InstallGrantSelection,
  PackContentRef,
  RecipeDefinition,
  RecordsExecutionBinding,
  RecordsExportEnvelope,
  RecordsPackRef,
  RecordsSchemaSnapshot,
  RecordsUpdateReviewFence,
} from '@recued/contracts';
import {
  canonicalHash,
  decomposeComposition,
  recordsCatalogSlug,
  recordsEntitySchemas,
  stampRecordsCatalog,
  validateComposition,
  type CompositionIngredient,
} from '@recued/ingredient-authoring';
import { validateIngredient } from '@recued/ingredients';
import { validateRecipe } from '@recued/recipes';

import type { LocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import type { ManifestRegistry } from '../manifest-loader.js';
import { getInstalledPack, recordPackInventory, removePackInventory } from '../pack-inventory.js';
// D-220 Slice B (follow-up) — a Records pack's shipped intake templates land and
// leave INSIDE the coordinator's transaction, with the namespace and inventory.
import {
  isReceptionTemplateContent,
  recordPackReceptionTemplates,
  removePackReceptionTemplates,
} from '../pack-reception-templates.js';
import type { RecipeStore } from '../recipe-store.js';
import { createContractGrantStore } from '../storage/contract-grant-store.js';
import type { ContractStore } from '../storage/contract-store.js';
import {
  type RecordsMigrationFinalizeStep,
  type RecordsMigrationPlan,
  type RecordsMigrationTransformStep,
  type RecordsMigrationVerifyStep,
} from './migration.js';
import {
  resolveRecordsMigrationAuthority,
  type RecordsMigrationArtifact,
} from './route-authority.js';
import { deriveRecordsSubscriberBindings } from './subscribers.js';
import type { RecordsStore } from './store.js';
import { copyLiteralJson } from './literal-json.js';
import { recordsRoutePlanDigest } from './review-fence.js';

const CANARY_OP = 'core.records.require-runtime';
const PRIVILEGED_RECORDS_OPS = new Set([
  CANARY_OP,
  'core.records.migrate',
  'core.records.verify-migration',
  'core.records.finalize-migration',
]);
const EXACT_CANARY_ROOT_KEYS = [
  'chat_exposed', 'metadata', 'output', 'prefetch_steps', 'recipe_id',
  'steps', 'ttl', 'variables', 'version',
] as const;
const EXACT_METADATA_KEYS = new Set([
  'author', 'description', 'name', 'recipe_bundle', 'supported_platforms',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join('\u0000') === [...keys].sort().join('\u0000');

export interface RecordsRuntimeCanaryRef {
  slug: string;
  version: number;
  visible?: boolean;
}

/** Closed whole-recipe classifier for the generated compatibility canary. */
export const recordsRuntimeCanaryIssue = (
  ref: RecordsRuntimeCanaryRef,
  recipe: unknown,
  expectedBundle: string,
): string | null => {
  const literal = copyLiteralJson(recipe);
  if (!literal.ok) return `runtime canary must be literal JSON: ${literal.issue}`;
  recipe = literal.value;
  if (ref.visible !== false) return 'runtime canary content ref must be visible:false';
  if (!isPlainObject(recipe) || !sameKeys(recipe, EXACT_CANARY_ROOT_KEYS)) {
    return 'runtime canary root must use the closed inert recipe shape';
  }
  if (recipe.recipe_id !== ref.slug || recipe.version !== ref.version) {
    return 'runtime canary body identity must match its exact content ref';
  }
  if (recipe.chat_exposed !== false) return 'runtime canary must be chat_exposed:false';
  if (!isPlainObject(recipe.variables) || Object.keys(recipe.variables).length !== 0) {
    return 'runtime canary variables must be empty';
  }
  if (!Array.isArray(recipe.prefetch_steps) || recipe.prefetch_steps.length !== 0) {
    return 'runtime canary prefetch_steps must be empty';
  }
  if (!isPlainObject(recipe.output)
    || !sameKeys(recipe.output, ['render'])
    || !Array.isArray(recipe.output.render)
    || recipe.output.render.length !== 0) {
    return 'runtime canary output must be exactly { render: [] }';
  }
  if (!isPlainObject(recipe.metadata)) return 'runtime canary metadata is required';
  for (const key of Object.keys(recipe.metadata)) {
    if (!EXACT_METADATA_KEYS.has(key)) return `runtime canary metadata key '${key}' is not inert`;
  }
  for (const key of ['name', 'description', 'author', 'supported_platforms']) {
    if (!Object.hasOwn(recipe.metadata, key)) return `runtime canary metadata.${key} is required`;
  }
  if (recipe.metadata.recipe_bundle !== undefined
    && recipe.metadata.recipe_bundle !== expectedBundle) {
    return 'runtime canary recipe_bundle disagrees with verified pack provenance';
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length !== 1) {
    return 'runtime canary must contain exactly one step';
  }
  const step = recipe.steps[0];
  if (!isPlainObject(step)
    || !sameKeys(step, ['args', 'id', 'op'])
    || step.op !== CANARY_OP
    || typeof step.id !== 'string'
    || step.id.length === 0
    || !isPlainObject(step.args)
    || Object.keys(step.args).length !== 0) {
    return `runtime canary step must be the exact literal '${CANARY_OP}' with empty args`;
  }
  if (JSON.stringify(recipe).includes('{{')) return 'runtime canary cannot contain dynamic references';
  return null;
};

export interface ResolvedRecordsPackRecipe {
  recipe: RecipeDefinition;
  publisher_id: string;
  version: number;
}

export interface InstallRecordsPackAtomicDeps {
  recipeStore: RecipeStore;
  recordsStore: RecordsStore;
  localManifestStore: LocalManifestStore;
  contractStore: ContractStore;
  registry: Pick<ManifestRegistry, 'get' | 'register' | 'unregister'>;
  now: () => number;
  /** Bounded old-activation drain before migration. Tests may shorten it. */
  quiescence_timeout_ms?: number;
  /** Optional D-196 audience writer over the same contract DB. Invoked inside
   * the atomic promotion after operation ids are fully installer-stamped. */
  applyAudience?: (
    operationIds: readonly string[],
    sourcePack: string,
    selection: InstallGrantSelection | undefined,
  ) => void;
}

export type RecordsUninstallDisposition = 'retain' | 'export' | 'purge';

export interface UninstallRecordsPackAtomicInput {
  owner: RecordsPackRef;
  /** Retain/orphan is the safety default. */
  disposition?: RecordsUninstallDisposition;
  expected_state_generation?: number;
  /** Required only for purge; must equal `<publisher>/<pack_slug>`. */
  confirmation?: string;
}

export interface UninstallRecordsPackAtomicDeps {
  recipeStore: RecipeStore;
  recordsStore: RecordsStore;
  localManifestStore: LocalManifestStore;
  contractStore: ContractStore;
  registry: Pick<ManifestRegistry, 'unregister'>;
  /** Bounded old-activation drain before retain/export/purge. */
  quiescence_timeout_ms?: number;
  applyAudience?: InstallRecordsPackAtomicDeps['applyAudience'];
}

export interface UninstallRecordsPackAtomicResult {
  owner: RecordsPackRef;
  internal_pack_id: string;
  disposition: RecordsUninstallDisposition;
  removed_recipes: string[];
  retired_events: string[];
  export?: RecordsExportEnvelope;
}

export interface InstallRecordsPackAtomicInput {
  manifest: BulkPackManifest;
  composition: CompositionIngredient;
  verified_publisher: string;
  recipes: readonly ResolvedRecordsPackRecipe[];
  /** Exact authored business recipe bodies seen before deterministic Tier-P
   * lowering. Required with review_fence so the coordinator can recompute the
   * artifact the owner actually reviewed as well as its lowered runtime form. */
  review_source_recipes?: readonly ResolvedRecordsPackRecipe[];
  /** Coordinator-only, whole-recipe-classified plans. They are never written
   * into the runnable RecipeStore. */
  migration_plans?: readonly RecordsMigrationPlan[];
  /** Provenance-verified historical route artifacts resolved before review.
   * Required only when a selected route crosses an intermediate version. */
  migration_artifacts?: readonly RecordsMigrationArtifact[];
  by_ref_contents?: readonly PackContentRef[];
  install_scope?: InstallGrantSelection;
  /** Exact §9.1 owner approval binding. External update entry points require
   * this; the coordinator re-checks it after quiescence and before mutation. */
  review_fence?: RecordsUpdateReviewFence;
}

export type { RecordsMigrationArtifact } from './route-authority.js';

export interface InstallRecordsPackAtomicResult {
  owner: RecordsPackRef;
  internal_pack_id: string;
  catalog_id: string;
  installed: BulkPackInstallEntryLike[];
}

export class RecordsPackInstallError extends Error {
  readonly code: 'validator_rejected' | 'version_mismatch' | 'unexpected';
  constructor(code: RecordsPackInstallError['code'], message: string) {
    super(message);
    this.name = 'RecordsPackInstallError';
    this.code = code;
  }
}

const runBatchToCompletion = (
  run: () => { done: boolean },
  label: string,
  maxBatches = 1_000_000,
): void => {
  for (let batch = 0; batch < maxBatches; batch += 1) {
    if (run().done) return;
  }
  throw new RecordsPackInstallError('unexpected', `${label} exceeded the bounded migration batch count`);
};

const firstValidationError = (
  result: { valid: boolean; issues: ReadonlyArray<{ severity: string; path: string; message: string }> },
): string | null => {
  if (result.valid) return null;
  const first = result.issues.find((entry) => entry.severity === 'error') ?? result.issues[0];
  return first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'validation failed';
};

const hasPrivilegedRecordsStep = (recipe: RecipeDefinition): boolean =>
  [...(recipe.prefetch_steps ?? []), ...recipe.steps].some((step) => {
    if (!isPlainObject(step)) return false;
    return typeof step.op === 'string' && PRIVILEGED_RECORDS_OPS.has(step.op);
  });

/** Per-entity natural key from the stamped catalog, canonically ordered — the
 *  target side of the rekey check in `resolveRecordsMigrationAuthority`. */
const naturalKeysFromExecutes = (
  executes: Record<string, { entity?: unknown; action?: unknown; natural_key?: unknown }>,
): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const bind of Object.values(executes)) {
    if (bind.action !== 'create' || typeof bind.entity !== 'string') continue;
    if (!Array.isArray(bind.natural_key)) continue;
    out[bind.entity] = [...bind.natural_key as string[]].sort();
  }
  return out;
};

const groupIdsForInstall = (
  manifest: Awaited<ReturnType<typeof stampRecordsCatalog>>['manifest'],
  defaults: readonly { group_id: string }[],
  selection: InstallGrantSelection | undefined,
): string[] => {
  const selected = new Set(defaults.map((entry) => entry.group_id));
  if (selection !== undefined) {
    const rank = selection.access === 'read' ? 0 : selection.access === 'write' ? 1 : 3;
    const riskRank = { read: 0, write: 1, admin: 2, destructive: 3 } as const;
    for (const [id, group] of Object.entries(manifest.operation_groups ?? {})) {
      if (group.risk_floor !== undefined && riskRank[group.risk_floor] <= rank) selected.add(id);
    }
  }
  return [...selected].sort();
};

/** D-221 control-plane commit: all async staging happens before one synchronous
 * shared-database transaction promotes every install surface together. */
export const installRecordsPackAtomic = async (
  deps: InstallRecordsPackAtomicDeps,
  input: InstallRecordsPackAtomicInput,
): Promise<InstallRecordsPackAtomicResult> => {
  if (input.verified_publisher !== input.manifest.publisher) {
    throw new RecordsPackInstallError(
      'validator_rejected',
      'Records namespace publisher must come from verified artifact provenance',
    );
  }
  const owner = {
    publisher: input.verified_publisher,
    pack_slug: input.manifest.slug,
  } satisfies RecordsPackRef;
  const compositionValidation = validateComposition(input.composition, {
    recipeValidator: validateRecipe,
  });
  const compositionError = firstValidationError(compositionValidation);
  if (compositionError !== null) {
    throw new RecordsPackInstallError('validator_rejected', `Records composition: ${compositionError}`);
  }
  // The public composition keeps the pack slug. Every persisted catalog
  // carrier is decomposed from the verified full-ref-derived internal slug;
  // review staging uses this same canonical form.
  const internalComposition: CompositionIngredient = {
    ...input.composition,
    slug: await recordsCatalogSlug(owner),
  };
  const decompose = decomposeComposition[internalComposition.schema_version];
  const decomposed = decompose?.(internalComposition);
  if (decomposed?.catalog === undefined || decomposed.ingredient !== undefined) {
    throw new RecordsPackInstallError('validator_rejected', 'Records composition must lower to exactly one catalog');
  }
  const stamped = await stampRecordsCatalog(
    decomposed.catalog,
    internalComposition,
    owner,
    input.manifest.version,
  );
  const catalogError = firstValidationError(validateIngredient(stamped.manifest));
  if (catalogError !== null) {
    throw new RecordsPackInstallError('validator_rejected', `stamped Records catalog: ${catalogError}`);
  }
  const catalogId = stamped.manifest.slug;
  const internalPackId = catalogId;
  const schemas = recordsEntitySchemas(
    internalComposition,
    owner.publisher,
    owner.pack_slug,
    catalogId,
  );
  if (schemas.length !== Object.keys(stamped.manifest.surfaces?.records?.schema.entities ?? {}).length) {
    throw new RecordsPackInstallError('validator_rejected', 'Records PII schema carrier is incomplete');
  }

  const bundle = `${owner.publisher}/${owner.pack_slug}`;
  const legacyPackId = input.manifest.slug;
  const legacyInventory = legacyPackId === internalPackId
    ? null
    : getInstalledPack(deps.contractStore, legacyPackId);
  const mayAdoptVerifiedLegacyPack = legacyInventory?.publisher === owner.publisher;
  const recipeIds = new Set<string>();
  const priorRows = new Map<string, ReturnType<RecipeStore['getStored']>>();
  for (const resolved of input.recipes) {
    if (resolved.publisher_id !== owner.publisher) {
      throw new RecordsPackInstallError('validator_rejected', `recipe '${resolved.recipe.recipe_id}' is not owned by the verified Records publisher`);
    }
    if (resolved.recipe.version !== resolved.version) {
      throw new RecordsPackInstallError('version_mismatch', `recipe '${resolved.recipe.recipe_id}' body/version identity disagrees`);
    }
    if (recipeIds.has(resolved.recipe.recipe_id)) {
      throw new RecordsPackInstallError('validator_rejected', `duplicate Records business recipe '${resolved.recipe.recipe_id}'`);
    }
    recipeIds.add(resolved.recipe.recipe_id);
    const recipeError = firstValidationError(validateRecipe(resolved.recipe));
    if (recipeError !== null) {
      throw new RecordsPackInstallError('validator_rejected', `recipe '${resolved.recipe.recipe_id}': ${recipeError}`);
    }
    if (hasPrivilegedRecordsStep(resolved.recipe)) {
      throw new RecordsPackInstallError('validator_rejected', `ordinary recipe '${resolved.recipe.recipe_id}' contains a coordinator-only Records op`);
    }
    if (resolved.recipe.metadata?.recipe_bundle !== bundle) {
      throw new RecordsPackInstallError('validator_rejected', `recipe '${resolved.recipe.recipe_id}' has foreign recipe_bundle provenance`);
    }
    const stored = deps.recipeStore.getStored(resolved.recipe.recipe_id);
    priorRows.set(resolved.recipe.recipe_id, stored);
    if (stored !== null
      && stored.pack_slug !== internalPackId
      && !(mayAdoptVerifiedLegacyPack && stored.pack_slug === legacyPackId)) {
      throw new RecordsPackInstallError('validator_rejected', `global recipe id '${resolved.recipe.recipe_id}' is already owned outside ${bundle}`);
    }
    const fallback = stored === null ? deps.recipeStore.get(resolved.recipe.recipe_id) : null;
    const bundled = stored === null ? deps.recipeStore.getBundled(resolved.recipe.recipe_id) : null;
    if (stored === null && fallback !== null && fallback !== bundled) {
      throw new RecordsPackInstallError('validator_rejected', `global recipe id '${resolved.recipe.recipe_id}' collides with a bundled or transient recipe`);
    }
  }

  const registryPrior = deps.registry.get(catalogId);
  const localPrior = deps.localManifestStore.getManifest(catalogId);
  if (registryPrior !== null && localPrior === null) {
    throw new RecordsPackInstallError('validator_rejected', `derived Records catalog '${catalogId}' collides with a non-local manifest`);
  }
  if (localPrior !== null && localPrior.author !== owner.publisher) {
    throw new RecordsPackInstallError('validator_rejected', 'derived Records catalog provenance disagrees with the installed owner');
  }

  const existingNamespace = deps.recordsStore.getNamespace(owner);
  const bindings = stamped.manifest.surfaces?.records?.executes;
  if (bindings === undefined
    || Object.values(bindings).some((binding) => !('operation_digest' in binding))) {
    throw new RecordsPackInstallError('validator_rejected', 'stamped Records catalog has incomplete execution bindings');
  }
  const recipeDigests = Object.fromEntries(
    (await Promise.all(input.recipes.map(async (entry) =>
      [entry.recipe.recipe_id, await canonicalHash(entry.recipe)] as const)))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const artifactDigest = await canonicalHash({
    owner,
    version: input.manifest.version,
    catalog: stamped.manifest,
    schemas,
    recipes: recipeDigests,
    migration_plans: input.migration_plans ?? [],
  });
  const existingVersion = existingNamespace === null
    ? 0
    : existingNamespace.state.state === 'ready'
      ? existingNamespace.state.version
      : existingNamespace.state.state === 'orphaned'
        ? existingNamespace.state.last_version
        : existingNamespace.state.state === 'migrating'
          ? existingNamespace.state.from_version
          : 0;
  // The two reserved external entry points require review before invoking this
  // coordinator. Direct coordinator callers are trusted internal recovery/test
  // code; whenever a fence is supplied it remains mandatory and fail-closed.
  if (input.review_fence !== undefined) {
    const reviewSourceRecipes = input.review_source_recipes;
    const runtimeIds = [...input.recipes].map((entry) => entry.recipe.recipe_id).sort();
    const reviewIds = [...(reviewSourceRecipes ?? [])]
      .map((entry) => entry.recipe.recipe_id)
      .sort();
    if (reviewSourceRecipes === undefined
      || runtimeIds.join('\u0000') !== reviewIds.join('\u0000')
      || reviewSourceRecipes.some((entry) =>
        entry.publisher_id !== owner.publisher
        || entry.version !== entry.recipe.version
        || entry.recipe.metadata?.recipe_bundle !== bundle)) {
      throw new RecordsPackInstallError(
        'validator_rejected',
        'Records update review source recipes are missing or divergent',
      );
    }
    const reviewRecipeDigests = Object.fromEntries(
      (await Promise.all(reviewSourceRecipes.map(async (entry) =>
        [entry.recipe.recipe_id, await canonicalHash(entry.recipe)] as const)))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const reviewArtifactDigest = await canonicalHash({
      owner,
      version: input.manifest.version,
      catalog: stamped.manifest,
      schemas,
      recipes: reviewRecipeDigests,
      migration_plans: input.migration_plans ?? [],
    });
    const expectedRouteDigest = recordsRoutePlanDigest({
      owner,
      current_version: existingVersion,
      target_version: input.manifest.version,
      current_artifact_digest: existingNamespace?.artifact_digest ?? '',
      // The owner reviews the provenance artifact before deterministic Tier-P
      // lowering; artifactDigest separately binds the lowered runtime bodies.
      target_artifact_digest: reviewArtifactDigest,
      target_storage_schema_hash: stamped.hashes.storage_schema_hash,
      migration_plans: input.migration_plans ?? [],
      migration_artifacts: [...(input.migration_artifacts ?? [])].sort((a, b) => a.version - b.version),
      pending_event_disposition: 'drain_or_explicit_retire',
    });
    const staleReason = input.review_fence.owner.publisher !== owner.publisher
      || input.review_fence.owner.pack_slug !== owner.pack_slug
      ? 'namespace owner changed'
      : input.review_fence.target_version !== input.manifest.version
        ? 'target version changed'
        : input.review_fence.target_artifact_digest !== reviewArtifactDigest
          ? 'authored recipe artifact changed'
          : input.review_fence.route_plan_digest !== expectedRouteDigest
            ? 'migration route inputs changed'
            : input.review_fence.pending_event_disposition !== 'drain_or_explicit_retire'
              ? 'pending-event disposition changed'
              : existingNamespace === null
                ? 'source namespace disappeared'
                : null;
    if (staleReason !== null) {
      throw new RecordsPackInstallError(
        'validator_rejected',
        `Records update review target is stale: ${staleReason}`,
      );
    }
    try {
      deps.recordsStore.assertUpdateReviewFence(input.review_fence);
    } catch (error) {
      throw new RecordsPackInstallError(
        'validator_rejected',
        `Records update review is stale: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const grantIds = groupIdsForInstall(
    stamped.manifest,
    decomposed.default_grants ?? [],
    input.install_scope,
  );
  const audienceOperationIds = [...new Set(grantIds.flatMap((groupId) =>
    (stamped.manifest.operation_groups?.[groupId]?.operations ?? [])
      .map((operationKey) => stamped.manifest.operations?.[operationKey]?.operation_id)
      .filter((operationId): operationId is string =>
        typeof operationId === 'string' && operationId.length > 0),
  ))].sort();
  const subscribers = deriveRecordsSubscriberBindings(
    owner,
    input.recipes.map((entry) => ({
      recipe: entry.recipe,
      publisher_id: entry.publisher_id,
      recipe_digest: recipeDigests[entry.recipe.recipe_id],
    })),
    {
      installed_pack_id: internalPackId,
      ingredient_id: catalogId,
      connection_name: catalogId,
      group_ids: grantIds,
    },
  );
  const subscriberDigest = subscribers.digest;
  const targetSchema = stamped.manifest.surfaces!.records!.schema;
  let migrationPromotion: {
    migration_id: string;
    lock_generation: number;
    finalizer: { recipe_digest: string; step_id: string; args_hash: string };
  } | null = null;
  let executionFence: ReturnType<RecordsStore['fenceNamespace']> | null = null;
  try {
  if (existingNamespace !== null
    && existingNamespace.quota.row_count > 0
    && existingNamespace.state.state !== 'incoherent'
    && input.manifest.version !== (
      existingNamespace.state.state === 'ready'
        ? existingNamespace.state.version
        : existingNamespace.state.state === 'orphaned'
          ? existingNamespace.state.last_version
          : existingNamespace.state.from_version
    )) {
    const fromVersion = existingNamespace.state.state === 'ready'
      ? existingNamespace.state.version
      : existingNamespace.state.state === 'orphaned'
        ? existingNamespace.state.last_version
        : existingNamespace.state.from_version;
    const targetVersion = input.manifest.version;
    const upgrading = targetVersion > fromVersion;
    const targetPlans = [...(input.migration_plans ?? [])];
    const sourcePlans = upgrading ? [] : deps.recordsStore.getInstalledMigrationPlans(owner);
    let authority: ReturnType<typeof resolveRecordsMigrationAuthority>;
    try {
      authority = resolveRecordsMigrationAuthority({
        owner,
        from_version: fromVersion,
        target_version: targetVersion,
        source_storage_schema_hash: existingNamespace.state.state === 'migrating'
          ? existingNamespace.state.target_storage_schema_hash
          : existingNamespace.state.storage_schema_hash,
        target_storage_schema_hash: stamped.hashes.storage_schema_hash,
        source_artifact_digest: existingNamespace.artifact_digest,
        target_artifact_digest: artifactDigest,
        source_schema: existingNamespace.schema,
        target_schema: targetSchema,
        source_plans: sourcePlans,
        target_plans: targetPlans,
        migration_artifacts: input.migration_artifacts ?? [],
        source_natural_keys: deps.recordsStore.getEntityNaturalKeys(owner),
        target_natural_keys: naturalKeysFromExecutes(
          stamped.manifest.surfaces?.records?.executes ?? {},
        ),
        // Per ENTITY, not per namespace: this whole block is gated on the
        // namespace holding rows, so without this a rekey of a brand-new empty
        // entity would be refused because some sibling entity has data.
        populated_entities: deps.recordsStore.listKinds(owner)
          .filter((entry) => entry.rows > 0)
          .map((entry) => entry.kind),
      });
    } catch (error) {
      throw new RecordsPackInstallError(
        'validator_rejected',
        error instanceof Error ? error.message : 'no complete migration route',
      );
    }
    const { route, route_schemas: routeSchemas, artifact_pins: artifactPins } = authority;
    const autoArgs = { from_v: fromVersion, new_v: targetVersion };
    const autoFinalizer: RecordsMigrationFinalizeStep = {
      id: 'system-records-version-sweep',
      op: 'core.records.finalize-migration',
      args: autoArgs,
      args_hash: await canonicalHash(autoArgs),
    };
    const autoRecipeDigest = await canonicalHash({
      kind: 'core.records.system-version-sweep',
      owner,
      from_version: fromVersion,
      target_version: targetVersion,
    });
    const ordered = route.length > 0
      ? route.flatMap((selected) => [...selected.steps, selected.finalizer].map((step) => ({
          recipe_digest: selected.recipe_digest,
          step,
        })))
      : [{ recipe_digest: autoRecipeDigest, step: autoFinalizer }];
    const requiredSteps = ordered.map(({ recipe_digest, step }) => ({
      recipe_digest,
      step_id: step.id,
      args_hash: step.args_hash,
      op: step.op,
    }));
    const planDigest = await canonicalHash({
      owner,
      from_version: fromVersion,
      target_version: targetVersion,
      target_artifact_digest: artifactDigest,
      artifact_pins: [...artifactPins.entries()].sort(([a], [b]) => a - b),
      required_steps: requiredSteps,
    });
    const migrationId = `records-migration:${planDigest}`;
    let migrationStart = {
      owner,
      migration_id: migrationId,
      plan_digest: planDigest,
      from_version: fromVersion,
      target_version: targetVersion,
      target_storage_schema_hash: stamped.hashes.storage_schema_hash,
      target_declaration_hash: stamped.hashes.declaration_hash,
      target_artifact_digest: artifactDigest,
      target_schema: targetSchema,
      route_schemas: routeSchemas,
      artifact_pins: Object.fromEntries(
        [...artifactPins.entries()].map(([version, digest]) => [String(version), digest]),
      ),
      target_bindings: bindings as Record<string, RecordsExecutionBinding>,
      target_migration_plans: targetPlans,
      target_subscriber_digest: subscriberDigest,
      target_subscribers: subscribers.bindings,
      required_steps: requiredSteps,
      ordered_steps: ordered,
      expected_state_generation: existingNamespace.state_generation,
      ...(existingNamespace.state.state === 'migrating'
        ? {
            reserved_byte_delta:
              deps.recordsStore.getMigration(owner)?.reserved_byte_delta ?? 0,
          }
        : {}),
    };
    if (existingNamespace.state.state !== 'migrating') {
      // Execute the exact kernel plan inside one deliberately rolled-back
      // transaction. This catches mapping, collision, relationship, target
      // verification, and quota failures while the old activation is still
      // fully ready and before the execution fence/lock mutates anything.
      try {
        const preflight = deps.recordsStore.preflightMigration({
          start: migrationStart,
          ordered_steps: ordered,
        });
        migrationStart = {
          ...migrationStart,
          reserved_byte_delta: Math.max(0, preflight.byte_delta),
        };
      } catch (error) {
        throw new RecordsPackInstallError(
          'validator_rejected',
          `Records migration preflight refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      executionFence = deps.recordsStore.fenceNamespace({
        owner,
        expected_activation_generation: existingNamespace.activation_generation,
      });
      const quiescence = await deps.recordsStore.waitForNamespaceQuiescence({
        ...executionFence,
        timeout_ms: deps.quiescence_timeout_ms ?? 15_000,
      });
      if (!quiescence.drained) {
        const callers = [...new Set(quiescence.blockers.map((blocker) => blocker.caller_pack))].sort();
        throw new RecordsPackInstallError(
          'validator_rejected',
          `Records update could not quiesce old execution leases; blockers: ${callers.join(', ')}`,
        );
      }
    }
    if (input.review_fence !== undefined) {
      // This is the last synchronous compare before beginMigration's lock CAS.
      deps.recordsStore.assertUpdateReviewFence(input.review_fence);
    }
    const migration = deps.recordsStore.beginMigration(migrationStart);
    for (const entry of ordered) {
      if (entry.step.op === 'core.records.migrate') {
        const step = entry.step as RecordsMigrationTransformStep;
        runBatchToCompletion(() => deps.recordsStore.runMigrationTransform({
          owner,
          migration_id: migrationId,
          lock_generation: migration.lock_generation,
          recipe_digest: entry.recipe_digest,
          step,
        }), `Records transform '${step.id}'`);
      } else if (entry.step.op === 'core.records.verify-migration') {
        const step = entry.step as RecordsMigrationVerifyStep;
        runBatchToCompletion(() => deps.recordsStore.runMigrationVerify({
          owner,
          migration_id: migrationId,
          lock_generation: migration.lock_generation,
          recipe_digest: entry.recipe_digest,
          step,
        }), `Records verification '${step.id}'`);
      } else {
        const step = entry.step as RecordsMigrationFinalizeStep;
        const finalizerIndex = requiredSteps.findIndex((required) =>
          required.recipe_digest === entry.recipe_digest && required.step_id === entry.step.id);
        const requiredReceipts = requiredSteps.slice(0, finalizerIndex).map((required) => ({
          recipe_digest: required.recipe_digest,
          step_id: required.step_id,
          args_hash: required.args_hash,
        }));
        runBatchToCompletion(() => deps.recordsStore.runMigrationFinalizer({
          owner,
          migration_id: migrationId,
          lock_generation: migration.lock_generation,
          recipe_digest: entry.recipe_digest,
          step,
          required_receipts: requiredReceipts,
        }), `Records finalizer '${step.id}'`);
      }
    }
    const final = ordered.at(-1)!;
    migrationPromotion = {
      migration_id: migrationId,
      lock_generation: migration.lock_generation,
      finalizer: {
        recipe_digest: final.recipe_digest,
        step_id: final.step.id,
        args_hash: final.step.args_hash,
      },
    };
  } else if (existingNamespace !== null
    && existingNamespace.quota.row_count > 0
    && (existingNamespace.state.state === 'ready' || existingNamespace.state.state === 'orphaned')
    && existingNamespace.state.storage_schema_hash !== stamped.hashes.storage_schema_hash) {
    throw new RecordsPackInstallError(
      'validator_rejected',
      'a populated Records schema cannot change without advancing through a declared migration edge',
    );
  }
  // Every activation replacement drains the old execution lease set, not only
  // data-bearing migrations. An empty namespace can still have a recipe that
  // already passed Records admission and is now performing an external side
  // effect; a same-version reinstall also advances activation and must not let
  // that run straddle the promotion boundary.
  if (existingNamespace !== null
    && executionFence === null
    && (existingNamespace.state.state === 'ready' || existingNamespace.state.state === 'orphaned')) {
    executionFence = deps.recordsStore.fenceNamespace({
      owner,
      expected_activation_generation: existingNamespace.activation_generation,
    });
    const quiescence = await deps.recordsStore.waitForNamespaceQuiescence({
      ...executionFence,
      timeout_ms: deps.quiescence_timeout_ms ?? 15_000,
    });
    if (!quiescence.drained) {
      const callers = [...new Set(quiescence.blockers.map((blocker) => blocker.caller_pack))].sort();
      throw new RecordsPackInstallError(
        'validator_rejected',
        `Records update could not quiesce old execution leases; blockers: ${callers.join(', ')}`,
      );
    }
    if (deps.recordsStore.getNamespace(owner)?.state_generation !== existingNamespace.state_generation) {
      throw new RecordsPackInstallError(
        'validator_rejected',
        'Records update review became stale before activation replacement',
      );
    }
  }
  const installedAt = deps.now();
  const installed: BulkPackInstallEntryLike[] = input.recipes.map((entry) => ({
    slug: entry.recipe.recipe_id,
    publisher_id: entry.publisher_id,
    version: entry.version,
    fresh_install: priorRows.get(entry.recipe.recipe_id) === null,
  }));

  try {
    deps.contractStore.transaction(() => {
      if (mayAdoptVerifiedLegacyPack) {
        for (const oldId of deps.recipeStore.listForPack(legacyPackId)) {
          if (!recipeIds.has(oldId)) deps.recipeStore.delete(oldId);
        }
        createContractGrantStore(deps.contractStore).removePackGroups(legacyPackId);
        removePackInventory(deps.contractStore, legacyPackId);
      }
      if (input.review_fence !== undefined && migrationPromotion === null) {
        // No await follows this final compare: quiescence has fenced new starts,
        // and this assertion plus promotion run in one synchronous DB turn.
        deps.recordsStore.assertUpdateReviewFence(input.review_fence);
      }
      for (const oldId of deps.recipeStore.listForPack(internalPackId)) {
        if (!recipeIds.has(oldId)) deps.recipeStore.delete(oldId);
      }
      for (const resolved of input.recipes) {
        deps.recipeStore.save(resolved.recipe, resolved.publisher_id, 'pair-sync', installedAt, internalPackId);
      }
      deps.localManifestStore.put({ manifest: stamped.manifest, entity_schemas: schemas });

      const grantStore = createContractGrantStore(deps.contractStore);
      grantStore.removePackGroups(internalPackId);
      for (const groupId of grantIds) {
        grantStore.grantPackGroup(internalPackId, catalogId, catalogId, groupId);
      }
      deps.applyAudience?.(audienceOperationIds, internalPackId, input.install_scope);

      recordPackInventory(deps.contractStore, {
        pack_slug: internalPackId,
        // ⛔ The row is KEYED by the generated catalog id, and that is deliberate
        // (grants, recipes and migration adoption all hang off it). But it meant
        // the authored slug appeared nowhere on the row, so a dependent pack's
        // Tier-P op — `recued-core.billable-hours.entry.get` — had no
        // `<publisher>.<authored-slug>` pack_ref to resolve against and its
        // install failed closed. Carry the authored name alongside the key.
        authored_pack_slug: owner.pack_slug,
        publisher: owner.publisher,
        pack_version: input.manifest.version,
        contents: input.by_ref_contents ?? [],
        local_catalogs: [{
          ingredient_id: catalogId,
          version: input.manifest.version,
          catalog_kind: 'private_byo',
        }],
        installed_at: installedAt,
      });
      // D-220 Slice B (follow-up) — the pack's shipped intake templates ride the SAME
      // transaction as the namespace + inventory: a refused template fails the
      // install outright instead of leaving a success with a missing row. Keyed by
      // the AUTHORED slug + publisher (the ref's identity), not the catalog id.
      recordPackReceptionTemplates(deps.contractStore, {
        pack_slug: owner.pack_slug,
        publisher: owner.publisher,
        pack_name: input.manifest.name,
        pack_version: input.manifest.version,
        templates: (input.manifest.contents ?? []).filter(isReceptionTemplateContent).map((c) => c.template),
        installed_at: installedAt,
      });

      if (migrationPromotion !== null) {
        deps.recordsStore.promoteMigration({ owner, ...migrationPromotion });
      } else {
        deps.recordsStore.installNamespace({
          owner,
          version: input.manifest.version,
          storage_schema_hash: stamped.hashes.storage_schema_hash,
          declaration_hash: stamped.hashes.declaration_hash,
          artifact_digest: artifactDigest,
          schema: stamped.manifest.surfaces!.records!.schema,
          bindings: bindings as Record<string, RecordsExecutionBinding>,
          migration_plans: input.migration_plans ?? [],
          subscriber_digest: subscriberDigest,
          subscribers: subscribers.bindings,
          ...(existingNamespace !== null
            ? { expected_state_generation: existingNamespace.state_generation }
            : {}),
        });
      }
    });
  } catch (error) {
    if (error instanceof RecordsPackInstallError) throw error;
    throw new RecordsPackInstallError(
      'unexpected',
      error instanceof Error ? error.message : String(error),
    );
  }

  deps.registry.register(stamped.manifest);
  return { owner, internal_pack_id: internalPackId, catalog_id: catalogId, installed };
  } finally {
    if (executionFence !== null) deps.recordsStore.releaseNamespaceFence(executionFence);
  }
};

/** Reverse the Records install promotion in one shared-database transaction.
 *
 * Data disposition is committed before capability deletion. Pending watcher
 * targets are explicitly dead-lettered (never silently rebound to a future
 * reinstall), and retain/orphan is the default. The generation captured by the
 * review is checked again at the transition boundary.
 */
export const uninstallRecordsPackAtomic = async (
  deps: UninstallRecordsPackAtomicDeps,
  input: UninstallRecordsPackAtomicInput,
): Promise<UninstallRecordsPackAtomicResult> => {
  const owner = input.owner;
  if (
    typeof owner.publisher !== 'string' || owner.publisher.length === 0
    || typeof owner.pack_slug !== 'string' || owner.pack_slug.length === 0
  ) {
    throw new RecordsPackInstallError('validator_rejected', 'Records uninstall requires a full pack reference');
  }
  const namespace = deps.recordsStore.getNamespace(owner);
  if (namespace === null) {
    throw new RecordsPackInstallError(
      'validator_rejected',
      `Records namespace '${owner.publisher}/${owner.pack_slug}' is not installed or retained`,
    );
  }
  if (namespace.state.state === 'migrating') {
    throw new RecordsPackInstallError('validator_rejected', 'cannot uninstall Records during migration');
  }
  const expectedGeneration = input.expected_state_generation ?? namespace.state_generation;
  if (expectedGeneration !== namespace.state_generation) {
    throw new RecordsPackInstallError('validator_rejected', 'Records uninstall review is stale');
  }
  const disposition = input.disposition ?? 'retain';
  if (!['retain', 'export', 'purge'].includes(disposition)) {
    throw new RecordsPackInstallError('validator_rejected', 'unknown Records uninstall disposition');
  }
  const fullRef = `${owner.publisher}/${owner.pack_slug}`;
  if (disposition === 'purge' && input.confirmation !== fullRef) {
    throw new RecordsPackInstallError(
      'validator_rejected',
      `Records purge confirmation must equal '${fullRef}'`,
    );
  }

  const executionFence = deps.recordsStore.fenceNamespace({
    owner,
    expected_activation_generation: namespace.activation_generation,
  });
  try {
  const quiescence = await deps.recordsStore.waitForNamespaceQuiescence({
    ...executionFence,
    timeout_ms: deps.quiescence_timeout_ms ?? 15_000,
  });
  if (!quiescence.drained) {
    const callers = [...new Set(quiescence.blockers.map((blocker) => blocker.caller_pack))].sort();
    throw new RecordsPackInstallError(
      'validator_rejected',
      `Records uninstall could not quiesce execution leases; blockers: ${callers.join(', ')}`,
    );
  }
  if (deps.recordsStore.getNamespace(owner)?.state_generation !== expectedGeneration) {
    throw new RecordsPackInstallError('validator_rejected', 'Records uninstall review became stale before mutation');
  }
  const internalPackId = await recordsCatalogSlug(owner);
  const pending = deps.recordsStore.listOutbox(owner, 'pending');
  const exported = disposition === 'export'
    ? deps.recordsStore.exportNamespace(owner)
    : undefined;
  const removedRecipes: string[] = [];
  const retiredEvents: string[] = [];
  try {
    deps.contractStore.transaction(() => {
      // Data lifecycle first. If any later capability deletion throws, the
      // outer transaction restores both data state and capabilities.
      if (disposition === 'purge') {
        deps.recordsStore.purgeNamespace(owner, input.confirmation!);
      } else {
        deps.recordsStore.orphanNamespace(owner, expectedGeneration);
        for (const event of pending) {
          if (deps.recordsStore.deadLetterEvent(
            event.event_id,
            `retired by Records uninstall of ${fullRef}`,
          )) retiredEvents.push(event.event_id);
        }
      }

      for (const recipeId of deps.recipeStore.listForPack(internalPackId)) {
        if (deps.recipeStore.delete(recipeId)) removedRecipes.push(recipeId);
      }
      createContractGrantStore(deps.contractStore).removePackGroups(internalPackId);
      deps.applyAudience?.([], internalPackId, undefined);
      removePackInventory(deps.contractStore, internalPackId);
      deps.localManifestStore.delete(internalPackId);
      // D-220 Slice B (follow-up) — and its shipped intake templates go with it, in
      // the same transaction (a failed sweep now rolls the uninstall back rather
      // than leaving rows the template list would still advertise).
      removePackReceptionTemplates(deps.contractStore, owner.pack_slug, owner.publisher);
    });
  } catch (error) {
    throw new RecordsPackInstallError(
      'unexpected',
      error instanceof Error ? error.message : String(error),
    );
  }
  deps.registry.unregister(internalPackId);
  return {
    owner,
    internal_pack_id: internalPackId,
    disposition,
    removed_recipes: removedRecipes,
    retired_events: retiredEvents,
    ...(exported !== undefined ? { export: exported } : {}),
  };
  } finally {
    deps.recordsStore.releaseNamespaceFence(executionFence);
  }
};
