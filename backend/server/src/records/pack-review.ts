import type {
  IngredientManifest,
  BulkPackManifest,
  CompositionIngredient,
  PackContentRef,
  RecipeDefinition,
  RecordsDestructiveReviewItem,
  RecordsFieldSnapshot,
  RecordsPackUpdateReview,
  RecordsSchemaSnapshot,
  RecordsSchemaReviewChange,
  RecordsUpdateReviewFence,
} from '@recued/contracts';
import { normalizeBulkPackInstallPlan, RECORDS_RUNTIME_CANARY_OP } from '@recued/contracts';
import {
  canonicalHash,
  decomposeComposition,
  isRecordsComposition,
  recordsCatalogSlug,
  recordsEntitySchemas,
  stampRecordsCatalog,
} from '@recued/ingredient-authoring';

import {
  recordsRuntimeCanaryIssue,
  type RecordsMigrationArtifact,
  type ResolvedRecordsPackRecipe,
} from './install-coordinator.js';
import {
  classifyRecordsMigrationRecipe,
  selectRecordsMigrationRoute,
  type RecordsMigrationPlan,
} from './migration.js';
import { resolveRecordsMigrationAuthority } from './route-authority.js';
import {
  recordsNamespaceReviewDigest,
  recordsOwnerPolicyDigest,
  recordsRoutePlanDigest,
} from './review-fence.js';
import { deriveRecordsSubscriberBindings } from './subscribers.js';
import type { RecordsStore } from './store.js';

export interface RecordsReviewRecipe extends ResolvedRecordsPackRecipe {
  slug: string;
}

export interface PreparedRecordsReviewTarget {
  composition: CompositionIngredient;
  /** The stamped catalog this update would install — its operation ids are the
   *  ones the owner's rules and grants are keyed by (the composition's own slug
   *  is not). What an update's operation diff compares against. */
  catalog: IngredientManifest;
  business_recipes: ResolvedRecordsPackRecipe[];
  migration_plans: RecordsMigrationPlan[];
  target_storage_schema_hash: string;
  target_declaration_hash: string;
  target_artifact_digest: string;
  target_schema: RecordsSchemaSnapshot;
}

const contentRecipeRef = (
  contents: readonly PackContentRef[],
  slug: string,
  version: number,
): Extract<PackContentRef, { type: 'recipe' }> | undefined =>
  contents.find((content): content is Extract<PackContentRef, { type: 'recipe' }> =>
    content.type === 'recipe' && content.slug === slug && content.version === version);

const hasOp = (recipe: RecipeDefinition, op: string): boolean =>
  [...(recipe.prefetch_steps ?? []), ...recipe.steps].some((step) =>
    'op' in step && step.op === op);

/** Resolve the exact target artifact facts used by the coordinator. This is a
 * read-only staging pass: no recipe, catalog, namespace, or receipt is written. */
export const prepareRecordsReviewTarget = async (input: {
  manifest: BulkPackManifest;
  recipes: readonly RecordsReviewRecipe[];
}): Promise<PreparedRecordsReviewTarget | null> => {
  const plan = normalizeBulkPackInstallPlan(input.manifest);
  const compositionRefs = plan.contents.filter(
    (content): content is Extract<PackContentRef, { type: 'composition' }> =>
      content.type === 'composition',
  );
  if (compositionRefs.length !== 1 || !isRecordsComposition(compositionRefs[0]!.composition)) {
    return null;
  }
  const owner = {
    publisher: input.manifest.publisher,
    pack_slug: input.manifest.slug,
  };
  const bySlug = new Map(input.recipes.map((entry) => [entry.slug, entry]));
  if (bySlug.size !== plan.recipes.length) {
    throw new Error('Records review requires one exact recipe body per content ref');
  }
  for (const ref of plan.recipes) {
    const row = bySlug.get(ref.slug);
    if (!row || row.publisher_id !== owner.publisher
      || row.version !== ref.version || row.recipe.version !== ref.version
      || row.recipe.recipe_id !== ref.slug) {
      throw new Error(`Records review recipe '${ref.slug}' has drifted from its pinned identity/provenance`);
    }
  }

  const canaries = input.recipes.filter((entry) =>
    hasOp(entry.recipe, RECORDS_RUNTIME_CANARY_OP));
  if (canaries.length !== 1) {
    throw new Error('Records review requires exactly one compatibility canary');
  }
  const canary = canaries[0]!;
  const canaryRef = contentRecipeRef(plan.contents, canary.slug, canary.version);
  const canaryIssue = canaryRef === undefined
    ? 'compatibility canary lacks an exact content ref'
    : recordsRuntimeCanaryIssue(
        canaryRef,
        canary.recipe,
        `${owner.publisher}/${owner.pack_slug}`,
      );
  if (canaryIssue !== null) throw new Error(`invalid Records compatibility canary: ${canaryIssue}`);

  const businessRecipes: ResolvedRecordsPackRecipe[] = [];
  const migrationPlans: RecordsMigrationPlan[] = [];
  for (const entry of input.recipes) {
    if (entry === canary) continue;
    const ref = contentRecipeRef(plan.contents, entry.slug, entry.version);
    if (ref === undefined) throw new Error(`Records recipe '${entry.slug}' lacks an exact content ref`);
    const classification = classifyRecordsMigrationRecipe(
      ref,
      entry.recipe,
      `${owner.publisher}/${owner.pack_slug}`,
    );
    if (classification.kind === 'invalid') {
      throw new Error(`invalid Records migration '${entry.slug}': ${classification.issue}`);
    }
    if (classification.kind === 'migration') migrationPlans.push(classification.plan);
    else businessRecipes.push({
      recipe: entry.recipe,
      publisher_id: entry.publisher_id,
      version: entry.version,
    });
  }

  const composition: CompositionIngredient = {
    ...compositionRefs[0]!.composition,
    slug: await recordsCatalogSlug(owner),
  };
  const decomposed = decomposeComposition[composition.schema_version]?.(composition);
  if (decomposed?.catalog === undefined || decomposed.ingredient !== undefined) {
    throw new Error('Records review composition must lower to exactly one catalog');
  }
  const stamped = await stampRecordsCatalog(
    decomposed.catalog,
    composition,
    owner,
    input.manifest.version,
  );
  const catalogId = stamped.manifest.slug;
  const schemas = recordsEntitySchemas(
    composition,
    owner.publisher,
    owner.pack_slug,
    catalogId,
  );
  const targetSchema = stamped.manifest.surfaces?.records?.schema;
  const bindings = stamped.manifest.surfaces?.records?.executes;
  if (targetSchema === undefined || bindings === undefined
    || schemas.length !== Object.keys(targetSchema.entities).length) {
    throw new Error('Records review target has an incomplete stamped schema/binding carrier');
  }
  const recipeDigests = Object.fromEntries(
    (await Promise.all(businessRecipes.map(async (entry) =>
      [entry.recipe.recipe_id, await canonicalHash(entry.recipe)] as const)))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const targetArtifactDigest = await canonicalHash({
    owner,
    version: input.manifest.version,
    catalog: stamped.manifest,
    schemas,
    recipes: recipeDigests,
    migration_plans: migrationPlans,
  });
  // Derivation is intentionally exercised during review too: malformed watcher
  // bindings cannot be hidden until after the user approves an update.
  deriveRecordsSubscriberBindings(
    owner,
    businessRecipes.map((entry) => ({
      recipe: entry.recipe,
      publisher_id: entry.publisher_id,
      recipe_digest: recipeDigests[entry.recipe.recipe_id]!,
    })),
  );
  return {
    composition,
    catalog: stamped.manifest,
    business_recipes: businessRecipes,
    migration_plans: migrationPlans,
    target_storage_schema_hash: stamped.hashes.storage_schema_hash,
    target_declaration_hash: stamped.hashes.declaration_hash,
    target_artifact_digest: targetArtifactDigest,
    target_schema: targetSchema,
  };
};

const displayField = (field: RecordsFieldSnapshot | undefined): string | undefined =>
  field === undefined
    ? undefined
    : JSON.stringify({
        slot: field.slot,
        type: field.kind,
        required: field.required,
        privacy: field.privacy ?? 'none',
      });

const schemaChanges = (
  current: RecordsSchemaSnapshot,
  target: RecordsSchemaSnapshot,
): RecordsSchemaReviewChange[] => {
  const changes: RecordsSchemaReviewChange[] = [];
  const entities = [...new Set([
    ...Object.keys(current.entities),
    ...Object.keys(target.entities),
  ])].sort();
  for (const entity of entities) {
    const before = current.entities[entity];
    const after = target.entities[entity];
    if (before === undefined) {
      changes.push({ entity, change: 'entity_added', destructive: false });
      continue;
    }
    if (after === undefined) {
      changes.push({ entity, change: 'entity_removed', destructive: true });
      continue;
    }
    const beforeFields = new Map(before.fields.map((field) => [field.key, field]));
    const afterFields = new Map(after.fields.map((field) => [field.key, field]));
    const fields = [...new Set([...beforeFields.keys(), ...afterFields.keys()])].sort();
    for (const field of fields) {
      const from = beforeFields.get(field);
      const to = afterFields.get(field);
      if (from === undefined) {
        changes.push({ entity, field, change: 'field_added', target: displayField(to), destructive: false });
      } else if (to === undefined) {
        changes.push({ entity, field, change: 'field_removed', current: displayField(from), destructive: true });
      } else {
        if (from.slot !== to.slot) changes.push({ entity, field, change: 'slot_changed', current: from.slot, target: to.slot, destructive: true });
        if (from.kind !== to.kind) changes.push({ entity, field, change: 'type_changed', current: from.kind, target: to.kind, destructive: true });
        if (from.required !== to.required) changes.push({ entity, field, change: 'nullability_changed', current: String(from.required), target: String(to.required), destructive: to.required });
        if ((from.privacy ?? '') !== (to.privacy ?? '')) changes.push({ entity, field, change: 'privacy_changed', current: from.privacy ?? 'none', target: to.privacy ?? 'none', destructive: false });
      }
    }
  }
  return changes;
};

const destructiveMappings = (
  plans: readonly RecordsMigrationPlan[],
): RecordsDestructiveReviewItem[] => plans.flatMap((plan) =>
  plan.steps.flatMap((step) => step.op !== 'core.records.migrate'
    ? []
    : step.args.field_mapping.flatMap((mapping) => {
        if (mapping.op !== 'clear' && mapping.op !== 'change_kind'
          && mapping.op !== 'safe_cast' && mapping.op !== 'move') return [];
        return [{
          edge: `${plan.from_v}->${plan.new_v}`,
          kind: step.args.kind,
          step_id: step.id,
          operation: mapping.op as RecordsDestructiveReviewItem['operation'],
          from: mapping.from,
          ...('to' in mapping ? { to: mapping.to } : {}),
        }];
      })),
);

const versionOf = (namespace: NonNullable<ReturnType<RecordsStore['getNamespace']>>): number =>
  namespace.state.state === 'ready'
    ? namespace.state.version
    : namespace.state.state === 'orphaned'
      ? namespace.state.last_version
      : namespace.state.state === 'migrating'
        ? namespace.state.from_version
        : 0;

const storageHashOf = (namespace: NonNullable<ReturnType<RecordsStore['getNamespace']>>): string =>
  namespace.state.state === 'ready' || namespace.state.state === 'orphaned'
    ? namespace.state.storage_schema_hash
    : namespace.state.state === 'migrating'
      ? namespace.state.target_storage_schema_hash
      : '';

export const buildRecordsPackUpdateReview = (input: {
  manifest: BulkPackManifest;
  target: PreparedRecordsReviewTarget;
  store: RecordsStore;
  migration_artifacts?: readonly RecordsMigrationArtifact[];
}): { review: RecordsPackUpdateReview; fence: RecordsUpdateReviewFence } | null => {
  const owner = { publisher: input.manifest.publisher, pack_slug: input.manifest.slug };
  const namespace = input.store.getNamespace(owner);
  if (namespace === null || namespace.state.state === 'incoherent') return null;
  const currentVersion = versionOf(namespace);
  if (currentVersion === 0 || (
    namespace.state.state === 'ready'
    && currentVersion === input.manifest.version
    && namespace.artifact_digest === input.target.target_artifact_digest
  )) return null;

  const retention = input.store.getRetention(owner);
  const globalQuota = input.store.getGlobalQuota();
  const artifacts = [...(input.migration_artifacts ?? [])].sort((a, b) => a.version - b.version);
  const rows = input.store.listKinds(owner);
  const estimatedRows = rows.reduce((sum, entry) => sum + entry.rows, 0);
  let selectedRoute: RecordsMigrationPlan[] = [];
  if (estimatedRows > 0 && currentVersion !== input.manifest.version) {
    selectedRoute = resolveRecordsMigrationAuthority({
      owner,
      from_version: currentVersion,
      target_version: input.manifest.version,
      source_storage_schema_hash: storageHashOf(namespace),
      target_storage_schema_hash: input.target.target_storage_schema_hash,
      source_artifact_digest: namespace.artifact_digest,
      target_artifact_digest: input.target.target_artifact_digest,
      source_schema: namespace.schema,
      target_schema: input.target.target_schema,
      source_plans: input.store.getInstalledMigrationPlans(owner),
      target_plans: input.target.migration_plans,
      migration_artifacts: artifacts,
    }).route;
  } else if (estimatedRows > 0
    && currentVersion === input.manifest.version
    && storageHashOf(namespace) !== input.target.target_storage_schema_hash) {
    throw new Error('populated Records storage schema changed without a versioned migration route');
  }
  const pendingDisposition = 'drain_or_explicit_retire' as const;
  const routePlanDigest = recordsRoutePlanDigest({
    owner,
    current_version: currentVersion,
    target_version: input.manifest.version,
    current_artifact_digest: namespace.artifact_digest,
    target_artifact_digest: input.target.target_artifact_digest,
    target_storage_schema_hash: input.target.target_storage_schema_hash,
    migration_plans: input.target.migration_plans,
    migration_artifacts: artifacts,
    pending_event_disposition: pendingDisposition,
  });
  const allPlans = [
    ...input.target.migration_plans,
    ...input.store.getInstalledMigrationPlans(owner),
    ...artifacts.flatMap((artifact) => artifact.migration_plans),
  ];
  let reverseRouteExists = false;
  try {
    reverseRouteExists = selectRecordsMigrationRoute(
      allPlans,
      input.manifest.version,
      currentVersion,
    ).length > 0;
  } catch {
    reverseRouteExists = false;
  }
  const review: RecordsPackUpdateReview = {
    owner,
    current_state: namespace.state.state,
    current_version: currentVersion,
    target_version: input.manifest.version,
    current_storage_schema_hash: storageHashOf(namespace),
    target_storage_schema_hash: input.target.target_storage_schema_hash,
    row_counts: rows,
    estimated_rows: estimatedRows,
    schema_changes: schemaChanges(namespace.schema, input.target.target_schema),
    destructive_changes: destructiveMappings(selectedRoute),
    quota: namespace.quota,
    global_quota: globalQuota,
    retention,
    export_checkpoint_available: true,
    export_recommended: namespace.quota.row_count > 0,
    active_executions: input.store.countActiveExecutionLeases(owner),
    unacknowledged_events: namespace.quota.outbox_count,
    pending_event_disposition: pendingDisposition,
    temporary_unavailability: true,
    resumable: true,
    reverse_route_exists: reverseRouteExists,
  };
  return {
    review,
    fence: {
      owner,
      current_snapshot_digest: recordsNamespaceReviewDigest(namespace),
      owner_policy_digest: recordsOwnerPolicyDigest({ retention, global_quota: globalQuota }),
      target_version: input.manifest.version,
      target_artifact_digest: input.target.target_artifact_digest,
      route_plan_digest: routePlanDigest,
      pending_event_disposition: pendingDisposition,
    },
  };
};
