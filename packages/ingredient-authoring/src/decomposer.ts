import type {
  AcctAlias,
  ApiExecutionBinding,
  BulkPackManifest,
  ConnectorExecutionBinding,
  CrmAlias,
  EngagementEntityFacet,
  EntitySchemaIngredientInput,
  IngredientManifest,
  RecipeEventTrigger,
  OperationGroupSpec,
  PackContentRef,
  PackOperationGroupContentRef,
  ProviderSurfaces,
  RecipeDefinition as Recipe,
  RecipeStep,
  RiskTier,
} from '@recued/contracts';
import { normalizeBulkPackInstallPlan, RISK_TIER_RANK } from '@recued/contracts';
import type {
  CompositionIngredient,
  IngredientEntityField,
  IngredientRow,
  PackOperationRow,
  RecipeTemplateRow,
} from './schema.js';
import { CANONICAL_WORKFLOW_TEMPLATE_REGISTRY } from './schema.js';

const DEFAULT_AUTHOR = 'recued-core';

/** A non-fatal note the decomposer raises about an artifact it produced.
 *  `validateComposition` folds these into its `'warn'` issue stream, so they
 *  surface wherever validation issues already do — the install review UI
 *  (`review.issues`) and the install result (`IngredientInstallResult.warnings`).
 *  Never an error: a warning never blocks decompose or makes a composition
 *  invalid (an unrecoverable shape throws instead). */
export interface DecomposeWarning {
  code: string;
  path: string;
  message: string;
}

export interface DecomposedArtifacts {
  ingredient?: IngredientManifest;
  catalog?: IngredientManifest;
  entity_schemas?: EntitySchemaIngredientInput[];
  operation_groups?: OperationGroupSpec[];
  default_grants?: PackOperationGroupContentRef[];
  recipes?: Recipe[];
  /** Non-fatal decompose-time notes (see `DecomposeWarning`). Absent when none. */
  warnings?: DecomposeWarning[];
}

export interface PackDecomposition {
  contents: PackContentRef[];
}

const titleFromSlug = (slug: string): string =>
  slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || slug;

const configKey = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'connection';

/** The canonical entity-grouping key — the normalized entity id the decomposer
 *  emits as `EntitySchema.entity_id` / the scope segment. Exported so the
 *  composition validator reconciles `crm_alias` on the SAME grouping the
 *  decomposer will emit: two raw entity strings that normalize to one id
 *  (`Deal` / `deal`) must be one unit for the alias consistency / uniqueness /
 *  canonical-field checks, exactly as they become one entity schema. */
export const normalizeEntityId = (value: string): string => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(normalized) ? normalized : `entity_${normalized || 'unknown'}`;
};

const vendorId = (value: string): string => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(normalized) ? normalized : `vendor-${normalized || 'unknown'}`;
};

// ────────────────────────────────────────────────────────────────
// Two-table join helpers (D-182 §4 / 3b)
// ────────────────────────────────────────────────────────────────

/** The composition's primary ingredient. These by-value packs are
 *  single-ingredient (the pack composition's slug equals the one ingredient's
 *  slug); the primary ingredient drives the catalog surface + connection. */
const primaryIngredient = (composition: CompositionIngredient): IngredientRow | undefined =>
  composition.ingredients[0];

/** Resolve the Table-A ingredient an operation joins to (`op.ingredient`). */
const ingredientFor = (
  composition: CompositionIngredient,
  op: PackOperationRow,
): IngredientRow => {
  const found = composition.ingredients.find((ing) => ing.slug === op.ingredient);
  if (found === undefined) {
    throw new Error(`operation '${op.op}' references undeclared ingredient '${op.ingredient}'`);
  }
  return found;
};

/** The op-family — the op id's first (noun) segment (`invoice` from
 *  `invoice.search`). Mechanical; drives the derived operation group. */
const opFamily = (op: PackOperationRow): string => {
  const dot = op.op.indexOf('.');
  return dot > 0 ? op.op.slice(0, dot) : op.op;
};

/** The shared connection-kind name the ingredient's ops authenticate through
 *  (`github`, `reception`). Off the `http` / `connection` config cell; absent
 *  for a `cli` ingredient (no connection to bind). */
const ingredientConnectionName = (ingredient: IngredientRow): string | undefined =>
  ingredient.http?.connection ?? ingredient.connection?.connection;

/** All of an ingredient's vendor-surface fields, flattened across its
 *  entities (the 1×1 output map + the dropped-tag warnings read this). */
const allEntityFields = (ingredient: IngredientRow): IngredientEntityField[] =>
  Object.values(ingredient.entities ?? {}).flatMap((entity) => entity.fields);

// The strictness ladder is the canonical RISK_TIER_RANK (contracts).
const riskRank = RISK_TIER_RANK;

const maxRisk = (ops: PackOperationRow[]): RiskTier =>
  ops.reduce<RiskTier>((max, op) => (riskRank[op.risk] > riskRank[max] ? op.risk : max), 'read');

/** The risk-CLASS the derived group is keyed on — the op's risk tier verbatim
 *  (`read` / `write` / `admin` / `destructive`); each tier is its own class, so
 *  a `write` op and a `destructive` op in one family land in distinct groups. */
const riskClass = (risk: RiskTier): RiskTier => risk;

/** The derived group id — `<ingredient-slug>.<op-family>.<risk-class>`
 *  (`github.issue.read`). Replaces the authored `operation_groups` /
 *  per-op `group` tags. */
const derivedGroupId = (ingredient: IngredientRow, op: PackOperationRow): string =>
  `${ingredient.slug}.${opFamily(op)}.${riskClass(op.risk)}`;

const categoryForRisk = (risk: RiskTier): IngredientManifest['category'] =>
  risk === 'read' ? 'data' : 'action';

const operationSpec = (composition: CompositionIngredient, op: PackOperationRow) => ({
  operation_id: `${DEFAULT_AUTHOR}/${composition.slug}.${op.op}`,
  description: op.description,
  risk_tier: op.risk,
  // Each op belongs to exactly its one derived group.
  groups: [derivedGroupId(ingredientFor(composition, op), op)],
  approval: op.approval,
  required_scopes: op.required_scopes,
  // D-201 Slice 6B3 — only the logical binding + intent cross the portable
  // authoring boundary. Callback URL and request placement never do.
  operation_bound_webhook: op.operation_bound_webhook,
  idempotency: op.idempotency,
  accepts_media: op.accepts_media,
  produces_media: op.produces_media,
  request_schema: op.request_schema,
  response_schema: op.response_schema,
  // D-170 N.7 / D-173 N.6 — LOWER the authored op `editable_args` onto the
  // installed `OperationSpec` so the D-173 review-then-approve inbox's
  // `ArgEditSchema` resolver (which reads the installed catalog) is not inert.
  // Carried verbatim — `undefined` stays `undefined`.
  editable_args: op.editable_args,
  timeout_ms: op.timeout_ms,
  cache_ttl_ms: op.cache_ttl_ms,
  // Connection-agnostic op dispatch — LOWER the authored per-op `result_path`
  // override onto the installed `OperationSpec` so the runtime gateway's
  // pagination follower merges pages at the SAME effective envelope the install
  // resolver bakes into the read-projection ref. Carried verbatim.
  result_path: op.result_path,
  // V3 operation-local pagination contract. Omitted means one upstream call;
  // present means the runtime gateway walks pages behind the scenes.
  pagination: op.pagination,
});

const operationsRecord = (
  composition: CompositionIngredient,
): NonNullable<IngredientManifest['operations']> =>
  Object.fromEntries(
    composition.operations.map((op) => [op.op, operationSpec(composition, op)]),
  );

/** D-182 3b — operation groups are DERIVED. One group per
 *  `(ingredient × op-family × risk-class)`. */
const derivedOperationGroups = (
  composition: CompositionIngredient,
): Record<string, OperationGroupSpec> | undefined => {
  const byGroup = new Map<string, PackOperationRow[]>();
  for (const op of composition.operations) {
    const groupId = derivedGroupId(ingredientFor(composition, op), op);
    byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), op]);
  }
  if (byGroup.size === 0) return undefined;
  return Object.fromEntries([...byGroup.entries()].map(([groupId, ops]) => [
    groupId,
    {
      group_id: groupId,
      operations: ops.map((op) => op.op),
      risk_floor: maxRisk(ops),
      grant_default: maxRisk(ops) === 'read' ? 'on_after_connect' : 'off',
      upgrade_behavior: 'new_operations_off',
    } satisfies OperationGroupSpec,
  ]));
};

const apiSurface = (composition: CompositionIngredient): ProviderSurfaces => {
  const ingredient = primaryIngredient(composition);
  const http = ingredient?.http;
  const ops = composition.operations;
  const transport = ops.some((op) => (op.bind as unknown as ApiExecutionBinding).kind === 'graphql')
    ? 'graphql'
    : 'rest';
  return {
    api: {
      transport,
      default_base_url: http?.base ?? 'https://api.example.com',
      auth: { kind: 'none' },
      executes: Object.fromEntries(ops.map((op) => [op.op, op.bind as unknown as ApiExecutionBinding])),
      // Connection-agnostic op dispatch — carry the authored surface-level
      // response-envelope key / search dialect / write dialect off the
      // ingredient's `http` cell onto the catalog so the install resolver can
      // project collection results + translate canonical ops. Omitted when unset.
      ...(http?.result_path !== undefined ? { result_path: http.result_path } : {}),
      ...(http?.search_style !== undefined ? { search_style: http.search_style } : {}),
      ...(http?.write_style !== undefined ? { write_style: http.write_style } : {}),
      ...(http?.pagination_style !== undefined ? { pagination_style: http.pagination_style } : {}),
      // D-192 work-entity Source — the pinned schema-source document a declared
      // Source's `contract_source` must equal (one document, one pin). Carried
      // verbatim off the `http` cell onto `surfaces.api.<kind>_source`; the
      // fail-closed `validateWorkEntitySources` gate enforces the equality.
      ...(http?.openapi_source !== undefined ? { openapi_source: http.openapi_source } : {}),
      ...(http?.graphql_schema_source !== undefined ? { graphql_schema_source: http.graphql_schema_source } : {}),
      ...(http?.google_discovery_source !== undefined ? { google_discovery_source: http.google_discovery_source } : {}),
    },
  };
};

const connectorSurface = (composition: CompositionIngredient): ProviderSurfaces => {
  const ingredient = primaryIngredient(composition);
  const cli = ingredient?.cli;
  const ops = composition.operations;
  const isCli = ingredient?.kind === 'cli'
    || ops.some((op) => (op.bind as unknown as ConnectorExecutionBinding).kind === 'cli_invocation');
  const packageRef = cli?.package_ref
    ?? (cli?.tool ? `system_binary:${cli.tool}` : `system_binary:${composition.slug}`);
  return {
    connector: {
      runtime: {
        transport: 'stdio',
        wire_protocol: isCli ? 'cli_invocation' : 'mcp',
        package_ref: packageRef,
        entry_point: cli?.entry_point ?? cli?.tool ?? composition.slug,
        expected_protocol_version: 1,
      },
      lifecycle: {
        auth: { method: 'none' },
        connect: { idempotent: true, startup_timeout_ms: 30_000 },
        invoke: { default_method_timeout_ms: 30_000 },
        disconnect: { graceful_shutdown_timeout_ms: 30_000 },
        reconnect_policy: 'manual_only',
        persistent_connection: !isCli,
        ...(isCli ? { idle_disconnect_ms: 0 } : {}),
      },
      executes: Object.fromEntries(ops.map((op) => [op.op, op.bind as unknown as ConnectorExecutionBinding])),
    },
  };
};

/** Gate the surface on the primary ingredient's kind: `cli` lowers to a
 *  connector surface (cli_invocation runtime); `http` / `connection` lower to
 *  an api surface. */
const providerSurfaces = (composition: CompositionIngredient): ProviderSurfaces =>
  primaryIngredient(composition)?.kind === 'cli'
    ? connectorSurface(composition)
    : apiSurface(composition);

const fieldOutput = (fields: IngredientEntityField[]): Record<string, string> => {
  if (fields.length === 0) return { result: 'result' };
  return Object.fromEntries(fields.map((field) => [field.maps_to, field.field_path]));
};

const connectionRef = (composition: CompositionIngredient): string => {
  const ingredient = primaryIngredient(composition);
  const name = (ingredient !== undefined ? ingredientConnectionName(ingredient) : undefined)
    ?? composition.slug;
  return `{{config.${configKey(name)}}}`;
};

const simpleApiIngredient = (
  composition: CompositionIngredient,
  op: PackOperationRow,
): IngredientManifest => {
  const bind = op.bind as unknown as ApiExecutionBinding;
  if (bind.kind !== 'rest') {
    throw new Error(`1x1 api composition '${composition.slug}' requires a rest binding`);
  }
  const ingredient = primaryIngredient(composition);
  const risk = op.risk;
  return {
    slug: composition.slug,
    name: titleFromSlug(composition.slug),
    description: op.description ?? `Generated ${composition.slug} operation from a composition.`,
    author: DEFAULT_AUTHOR,
    kind: 'connection',
    version: 1,
    category: categoryForRisk(risk),
    risk_tier: risk,
    input: {
      connection_kind: 'api',
      connection: connectionRef(composition),
      method: bind.method,
      path: bind.path_template,
    },
    output: fieldOutput(ingredient !== undefined ? allEntityFields(ingredient) : []),
    tags: ['composition', composition.slug],
  };
};

const catalogIngredient = (composition: CompositionIngredient): IngredientManifest => ({
  slug: composition.slug,
  name: `${titleFromSlug(composition.slug)} Catalog`,
  description: `Generated catalog for ${composition.slug}.`,
  author: DEFAULT_AUTHOR,
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  input: {
    operation: null,
    args: null,
  },
  output: {
    result: 'result',
    headers: 'headers',
  },
  operations: operationsRecord(composition),
  operation_groups: derivedOperationGroups(composition),
  default_policy: {
    read_default: 'allow_after_group_grant',
    write_default: 'ask',
    admin_default: 'ask',
    destructive_default: 'always_ask',
  },
  catalog_kind: composition.catalog_kind ?? 'private_byo',
  marketplace_eligible: composition.catalog_kind !== 'private_byo' && composition.catalog_kind !== undefined
    ? true
    : false,
  surfaces: providerSurfaces(composition),
  // D-192 — pass the pack's work-entity Source declarations THROUGH to the
  // catalog manifest, where `validateWorkEntitySources` gates them over the
  // decomposed catalog (op membership + transport + pin equality against the
  // `surfaces.api.<kind>_source` emitted above). Omitted when the pack declares
  // none.
  ...(composition.work_entity_sources !== undefined
    ? { work_entity_sources: composition.work_entity_sources }
    : {}),
  tags: ['composition', composition.slug],
});

const sourceOperationsForEntity = (
  composition: CompositionIngredient,
  ingredient: IngredientRow,
  entityId: string,
  fields: IngredientEntityField[],
): EntitySchemaIngredientInput['source_operations'] => {
  const explicitOps = new Set(fields.map((field) => field.source_operation).filter(Boolean) as string[]);
  const familyOps = composition.operations
    .filter((op) => op.ingredient === ingredient.slug && normalizeEntityId(opFamily(op)) === entityId)
    .map((op) => op.op);
  const opKeys = explicitOps.size > 0 ? [...explicitOps] : familyOps;
  const fallback = opKeys.length > 0 ? opKeys : [composition.operations[0]?.op ?? 'read'];
  return Object.fromEntries(fallback.map((operation) => [
    operation,
    { catalog: composition.slug, operation },
  ]));
};

/** D-182 3b — entity schemas read the NESTED `ingredient.entities` map (the
 *  ingredient's vendor surface), with `crm_alias` / `acct_alias` now
 *  entity-level (was an agree-across-rows annotation on the flat field rows). */
const entitySchemas = (composition: CompositionIngredient): EntitySchemaIngredientInput[] => {
  const schemas: EntitySchemaIngredientInput[] = [];
  for (const ingredient of composition.ingredients) {
    const vendor = vendorId(ingredientConnectionName(ingredient) ?? composition.slug);
    for (const [rawEntityId, entity] of Object.entries(ingredient.entities ?? {})) {
      const entityId = normalizeEntityId(rawEntityId);
      const fields = entity.fields;
      const idField = fields.find((field) => field.maps_to === 'id') ?? fields[0];
      schemas.push({
        ingredient_id: composition.slug,
        wraps_vendor: vendor,
        entity_id: entityId,
        scope: `connection.api.${vendor}.${entityId}`,
        projection_mode: 'platform_reference',
        schema_mode: 'static',
        ...(entity.crm_alias !== undefined ? { crm_alias: entity.crm_alias } : {}),
        ...(entity.acct_alias !== undefined ? { acct_alias: entity.acct_alias } : {}),
        ...(entity.engagement !== undefined ? { engagement: entity.engagement } : {}),
        target_id: {
          fields: [idField.maps_to],
          template: `${entityId}_{${idField.maps_to}}`,
        },
        meta_fields: fields.map((field) => ({
          key: field.maps_to,
          type: field.type,
          description: field.description,
          required: field.optional === undefined ? true : !field.optional,
          source_path: field.field_path,
          privacy: field.pii,
          // G2 request-side datetime filter — carry the field's authored date
          // granularity onto the MetaField (spread so a non-datetime field never
          // emits a `date_granularity: undefined`).
          ...(field.date_granularity === undefined ? {} : { date_granularity: field.date_granularity }),
        })),
        source_operations: sourceOperationsForEntity(composition, ingredient, entityId, fields),
      });
    }
  }
  return schemas;
};

/** D-182 3b — `default_grants` is DERIVED (read-tier groups), with an OPTIONAL
 *  authored override UNIONed in. The derived read groups carry the
 *  read→granted-on-connect posture (write/destructive stay ungranted — the
 *  money-gate). The authored `composition.default_grants` adds non-read groups a
 *  pack explicitly needs granted at install — the D-173 reception cold-start case
 *  (its only op is a write `*.materialize`, granted so a trigger fire reaches the
 *  gate; the approval gate then holds it). Authored ids must name a derived
 *  group (the validator rejects unknown ones); we union + dedupe by group id.
 *  The install `writeDefaultGrantBindings` consumes the result unchanged. */
const defaultGrants = (composition: CompositionIngredient): PackOperationGroupContentRef[] => {
  const derived = derivedOperationGroups(composition) ?? {};
  const ids = new Set<string>(
    Object.values(derived).filter((group) => group.risk_floor === 'read').map((group) => group.group_id),
  );
  for (const authored of composition.default_grants ?? []) {
    if (derived[authored] !== undefined) ids.add(authored);
  }
  return [...ids].map((group_id) => ({
    type: 'operation_group',
    ingredient_id: composition.slug,
    group_id,
  }));
};

const recipeIdPart = (value: string): string => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'workflow';
};

const compiledRecipeId = (
  composition: CompositionIngredient,
  row: RecipeTemplateRow,
  idx: number,
): string =>
  `${recipeIdPart(composition.slug)}-${recipeIdPart(row.template)}-${recipeIdPart(row.operation)}-${idx + 1}`;

/** Reception tables (`reception_*`) are NOT vendor entities — their compiled
 *  recipes are dispatched LOCALLY by the reception drain seam, which resolves
 *  them BY the `reception_*` trigger marker (D-173 § A.7). They must never
 *  become live bus subscribers: the slice-3 doorbell event carries
 *  `{endpoint_id, kind, action}` only, while the drain dispatch carries the
 *  full projection payload — a bus-materialized subscription would double-fire
 *  the workflow with a payload its materialize op can't use. */
const isReceptionEntity = (entity: string): boolean =>
  normalizeEntityId(entity).startsWith('reception_');

/** The strict platform-reference segment grammar (`composeVendorEntityScope`
 *  / the trigger-sugar `on:` form / `parseWatchDemandFromPattern` all share
 *  it). `vendorId` can mint hyphenated ids (a hyphenated connection name) —
 *  those are already non-reactive end-to-end (the registry lift and watch
 *  demand parse both reject hyphens), so the trigger lowering keeps the inert
 *  marker for them and raises a decompose warning instead of minting a
 *  subscription nothing will ever feed. */
const STRICT_SEGMENT_RE = /^[a-z][a-z0-9_]*$/;

/** Reactive lowering for one `recipe_templates` row (authoring-sugar
 *  compile-down): vendor-entity rows mint the canonical
 *  `on: <vendor>.<entity>.<verb>` subscriber form (created + changed), which
 *  the server's declarative reconciler compiles to live bus patterns. Reception
 *  rows + `scheduled-operate` keep their synthetic markers verbatim (the drain
 *  seam / schedule substrate own those vocabularies). */
const templateTriggers = (
  composition: CompositionIngredient,
  row: RecipeTemplateRow,
): { triggers: RecipeEventTrigger[]; warnings: DecomposeWarning[] } => {
  if (row.template === 'scheduled-operate') {
    return {
      triggers: [{
        event: 'schedule.cron',
        filter: { cron: row.trigger.cron ?? row.trigger.value ?? '*' },
      }],
      warnings: [],
    };
  }
  const marker = (): RecipeEventTrigger => {
    const filter: Record<string, unknown> = {};
    if (row.trigger.field !== undefined && row.trigger.value !== undefined) {
      filter[row.trigger.field] = row.trigger.value;
    } else if (row.trigger.field !== undefined) {
      filter.field = row.trigger.field;
    } else if (row.trigger.value !== undefined) {
      filter.value = row.trigger.value;
    }
    return {
      event: `composition.${row.trigger.entity}`,
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    };
  };
  if (isReceptionEntity(row.trigger.entity)) {
    return { triggers: [marker()], warnings: [] };
  }
  const ingredient = primaryIngredient(composition);
  const connection = ingredient !== undefined ? ingredientConnectionName(ingredient) : undefined;
  const vendor = vendorId(connection ?? composition.slug);
  const entityId = normalizeEntityId(row.trigger.entity);
  if (!STRICT_SEGMENT_RE.test(vendor)) {
    return {
      triggers: [marker()],
      warnings: [{
        code: 'composition_workflow_trigger_not_reactive',
        path: 'recipe_templates',
        message:
          `recipe_templates row on '${row.trigger.entity}' keeps the inert composition.* marker — vendor id `
          + `'${vendor}' (from the ingredient connection) is outside the platform-reference grammar `
          + `[a-z][a-z0-9_]*, so no reactive source (registry lift, watch demand) can ever feed it; `
          + `rename the connection to a conforming id to make the compiled template fire on changes`,
      }],
    };
  }
  const sugar: Omit<RecipeEventTrigger, 'on'> = {
    ...(connection !== undefined ? { connection } : {}),
    ...(row.trigger.field !== undefined ? { fields: [row.trigger.field] } : {}),
    ...(row.trigger.field !== undefined && row.trigger.value !== undefined
      ? { where: { [row.trigger.field]: row.trigger.value } }
      : {}),
  };
  return {
    triggers: [
      { on: `${vendor}.${entityId}.created`, ...sugar },
      { on: `${vendor}.${entityId}.changed`, ...sugar },
    ],
    warnings: [],
  };
};

/** Guard-condition ref for `conditional-operate`. A vendor row's field is a
 *  canonical projection key — on the bus dispatch payload the projection rides
 *  under `record`; a reception row's payload IS the projection (the drain seam
 *  dispatches `context.event.payload = <projection>`), so its fields stay
 *  top-level. */
const triggerFieldRef = (row: RecipeTemplateRow): string => {
  if (row.trigger.field === undefined) return '{{context.event.payload}}';
  return isReceptionEntity(row.trigger.entity)
    ? `{{context.event.payload.${row.trigger.field}}}`
    : `{{context.event.payload.record.${row.trigger.field}}}`;
};

const triggerGuardCondition = (row: RecipeTemplateRow): NonNullable<RecipeStep['skip_when']> =>
  row.trigger.value === undefined
    ? { field: triggerFieldRef(row), operator: 'is_not_null' }
    : { field: triggerFieldRef(row), operator: 'equal', value: row.trigger.value };

/** The connection a compiled template step binds onto its catalog-op dispatch.
 *  Every step a template compiles to routes through the catalog-form gateway,
 *  which resolves a per-connection profile by the step's `connection` value; a
 *  step with NO `connection` resolves `''` and fails closed at
 *  `no_connection_profile` BEFORE the gate. The value is the ingredient's
 *  connection as a LITERAL name (not a `{{config.*}}` ref): the install planner
 *  binds the decomposed catalog to this literal + seeds the op profile on it
 *  (cold-start-local — zero user config). Absent for a connection-less (`cli`)
 *  ingredient — no catalog connection to bind. */
const stepConnection = (composition: CompositionIngredient): string | undefined => {
  const ingredient = primaryIngredient(composition);
  return ingredient !== undefined ? ingredientConnectionName(ingredient) : undefined;
};

const catalogOperationStep = (
  composition: CompositionIngredient,
  id: string,
  operation: string,
  args: Record<string, unknown> | string = '{{context.event.payload}}',
  extra?: Omit<Extract<RecipeStep, { ingredient: string }>, 'id' | 'ingredient' | 'input'>,
): RecipeStep => {
  const connection = stepConnection(composition);
  // `connection` is the D-165 step-level binding the catalog gateway resolves
  // (`resolveCatalogConnection` reads `step.connection`). It is not on the
  // `IngredientStep` interface today (reached via a cast at every call site),
  // so the step is assembled as a record and cast, mirroring `guardStep`.
  return {
    id,
    ingredient: composition.slug,
    ...(connection !== undefined ? { connection } : {}),
    input: { operation, args },
    ...extra,
  } as unknown as RecipeStep;
};

const notifyStep = (
  row: RecipeTemplateRow,
  id = 'notify',
  extra?: Omit<Extract<RecipeStep, { ingredient: string }>, 'id' | 'ingredient' | 'input'>,
): RecipeStep => ({
  id,
  ingredient: 'notification-send',
  input: {
    title: `${titleFromSlug(row.trigger.entity)} workflow`,
    text: `Workflow '${row.template}' fired for '${row.operation}'.`,
    ...(row.notify_target !== undefined ? { target: row.notify_target } : {}),
  },
  ...extra,
});

const guardStep = (condition: NonNullable<RecipeStep['skip_when']>): RecipeStep =>
  ({ id: 'condition', guard: condition } as unknown as RecipeStep);

const noSyncTargetSkip = (): NonNullable<RecipeStep['skip_when']> => ({
  field: '{{context.workflow.sync_target}}',
  operator: 'is_null',
});

const templateSteps = (
  composition: CompositionIngredient,
  row: RecipeTemplateRow,
): RecipeStep[] => {
  const template = CANONICAL_WORKFLOW_TEMPLATE_REGISTRY[row.template];
  if (template === undefined) {
    throw new Error(`unknown workflow template '${String(row.template)}'`);
  }
  // VENDOR rows with a field condition get a recipe-side guard in EVERY reactive
  // template: the dispatch filter PASSES doorbell-shaped reconciler events (no
  // `record`), so without a guard a "status becomes overdue" template would
  // notify / ask / escalate on EVERY change. The guard reads
  // `payload.record.<field>` — fat poll events gate correctly; doorbell events
  // resolve undefined and skip (an audited no-op run). Reception rows are
  // EXCLUDED: the drain seam dispatches them directly with the projection as the
  // payload, and the gate field is row state, not necessarily a projection field.
  const reactiveGuard: RecipeStep[] =
    row.trigger.field !== undefined
    && row.template !== 'scheduled-operate'
    && !isReceptionEntity(row.trigger.entity)
      ? [guardStep(triggerGuardCondition(row))]
      : [];
  switch (row.template) {
    case 'review-then-approve':
      return [
        ...reactiveGuard,
        catalogOperationStep(composition, 'approved_operation', row.operation, '{{context.event.payload}}', {
          prompt: `Approve ${row.operation} for ${titleFromSlug(composition.slug)}`,
        }),
        row.sync_target === undefined
          ? catalogOperationStep(composition, 'write_back', row.operation, {}, {
              skip_when: noSyncTargetSkip(),
            })
          : catalogOperationStep(composition, 'write_back', row.sync_target.write_back_op, {
              source_id: row.sync_target.source_id,
              operation_result: '{{step.approved_operation}}',
            }),
      ];
    case 'notify-on-event':
      return [...reactiveGuard, notifyStep(row)];
    case 'conditional-operate':
      return [
        // The guard IS this template's defining structure — for a reception row
        // (excluded from `reactiveGuard`) it still applies, reading the
        // top-level payload field.
        ...(reactiveGuard.length > 0 ? reactiveGuard : [guardStep(triggerGuardCondition(row))]),
        catalogOperationStep(composition, 'operation', row.operation),
      ];
    case 'scheduled-operate':
      return [catalogOperationStep(composition, 'operation', row.operation, {})];
    case 'escalate':
      return [
        ...reactiveGuard,
        catalogOperationStep(composition, 'approval_request', row.operation, '{{context.event.payload}}', {
          prompt: `Approve ${row.operation} for ${titleFromSlug(composition.slug)}`,
          ...(row.escalate_after_ms !== undefined
            ? { timeout_ms: row.escalate_after_ms, on_timeout: 'reject' as const }
            : {}),
        }),
        notifyStep(row, 'escalate_notify', {
          skip_when: { field: '{{step.approval_request}}', operator: 'is_not_null' },
        }),
      ];
  }
};

const compiledTemplateRecipes = (
  composition: CompositionIngredient,
): { recipes: Recipe[]; warnings: DecomposeWarning[] } => {
  const warnings: DecomposeWarning[] = [];
  const recipes = (composition.recipe_templates ?? []).map((row, idx) => {
    const lowering = templateTriggers(composition, row);
    warnings.push(...lowering.warnings);
    return {
      recipe_id: compiledRecipeId(composition, row, idx),
      version: 1,
      ttl: 300,
      metadata: {
        name: `${titleFromSlug(composition.slug)} ${titleFromSlug(row.template)}`,
        description:
          `Compiled pure-workflow recipe for '${row.template}' on '${composition.slug}.${row.operation}'.`,
        author: DEFAULT_AUTHOR,
        supported_platforms: ['server'],
        tags: ['composition', 'workflow', row.template, composition.slug],
      },
      variables: {},
      event_triggers: lowering.triggers,
      prefetch_steps: [],
      steps: templateSteps(composition, row),
      output: { render: [] },
    };
  });
  return { recipes, warnings };
};

/** A single-op, single-entity, non-templated `http`/`connection` composition
 *  compiles to a plain ingredient (the 1×1 path) rather than a catalog. Explicit
 *  official catalogs stay catalogs even at 1×1: app packs use that by-value
 *  shape to publish an operation surface, not a one-off helper ingredient. A
 *  `cli` ingredient always takes the catalog path (it has a derived group →
 *  never a plain ingredient); a templated composition needs the catalog its
 *  compiled recipes dispatch operations against. */
const isOneToOne = (composition: CompositionIngredient): boolean => {
  const ingredient = primaryIngredient(composition);
  if (ingredient === undefined) return false;
  if (ingredient.kind !== 'http' && ingredient.kind !== 'connection') return false;
  if (composition.catalog_kind !== undefined && composition.catalog_kind !== 'private_byo') return false;
  if (composition.operations.length !== 1) return false;
  // Operation-bound callback injection exists only in the catalog Gateway.
  // Never silently collapse its sole operation to a plain ingredient.
  if (composition.operations[0]?.operation_bound_webhook !== undefined) return false;
  if (composition.recipe_templates !== undefined && composition.recipe_templates.length > 0) {
    return false;
  }
  const entityCount = new Set(
    composition.ingredients.flatMap((ing) => Object.keys(ing.entities ?? {}).map(normalizeEntityId)),
  ).size;
  return entityCount <= 1;
};

/** The 1×1 path emits a plain ingredient with NO entity schema, so any
 *  `MetaField.privacy` tag is dropped (the D-167 egress alias layer reads
 *  privacy off `entity_schemas`). Losing a declared privacy contract silently
 *  is a quiet downgrade, so warn. The author keeps the tags by giving the
 *  composition a catalog shape (a second operation or entity). */
const droppedPrivacyWarning = (composition: CompositionIngredient): DecomposeWarning[] => {
  const tagged = composition.ingredients
    .flatMap((ing) => allEntityFields(ing))
    .filter((field) => field.pii !== undefined);
  if (tagged.length === 0) return [];
  const tags = tagged.map((field) => `${field.maps_to} (${field.pii})`).join(', ');
  return [{
    code: 'composition_1x1_privacy_tags_dropped',
    path: 'ingredients',
    message:
      `1×1 API wrapper '${composition.slug}' compiles to a plain ingredient with no entity schema, so its `
      + `${tagged.length} privacy-tagged field(s) — ${tags} — are not carried into the installed artifact `
      + `and the PII alias layer cannot protect them; add a second operation or entity so the composition `
      + `compiles to a catalog that keeps the tags`,
  }];
};

/** The `crm_alias` sibling of `droppedPrivacyWarning` — a 1×1 emits no entity
 *  schema, so a declared entity `crm_alias` is silently dropped (the only
 *  carrier into the installed artifact + the connection-agnostic resolution
 *  input). */
const droppedCrmAliasWarning = (composition: CompositionIngredient): DecomposeWarning[] => {
  const aliased = composition.ingredients
    .flatMap((ing) => Object.values(ing.entities ?? {}))
    .map((entity) => entity.crm_alias)
    .filter((alias): alias is CrmAlias => alias !== undefined);
  if (aliased.length === 0) return [];
  const aliases = [...new Set(aliased)].sort().join(', ');
  return [{
    code: 'composition_1x1_crm_alias_dropped',
    path: 'ingredients',
    message:
      `1×1 API wrapper '${composition.slug}' compiles to a plain ingredient with no entity schema, so its `
      + `declared crm_alias (${aliases}) is not carried into the installed artifact and the composition is not `
      + `CRM-conformant despite the annotation; add a second operation or entity so the composition compiles `
      + `to a catalog whose entity schema keeps the crm_alias`,
  }];
};

/** The `acct_alias` sibling of `droppedCrmAliasWarning`. */
const droppedAcctAliasWarning = (composition: CompositionIngredient): DecomposeWarning[] => {
  const aliased = composition.ingredients
    .flatMap((ing) => Object.values(ing.entities ?? {}))
    .map((entity) => entity.acct_alias)
    .filter((alias): alias is AcctAlias => alias !== undefined);
  if (aliased.length === 0) return [];
  const aliases = [...new Set(aliased)].sort().join(', ');
  return [{
    code: 'composition_1x1_acct_alias_dropped',
    path: 'ingredients',
    message:
      `1×1 API wrapper '${composition.slug}' compiles to a plain ingredient with no entity schema, so its `
      + `declared acct_alias (${aliases}) is not carried into the installed artifact and the composition is not `
      + `accounting-conformant despite the annotation; add a second operation or entity so the composition `
      + `compiles to a catalog whose entity schema keeps the acct_alias`,
  }];
};

/** D-192 — the `engagement` sibling of `droppedCrmAliasWarning`. A 1×1 emits no
 *  entity schema, so a declared engagement facet is silently dropped and the
 *  pack's engagement plane (reconcile / health / coverage / score) never lights
 *  up despite the annotation. */
const droppedEngagementWarning = (composition: CompositionIngredient): DecomposeWarning[] => {
  const engaged = composition.ingredients
    .flatMap((ing) => Object.values(ing.entities ?? {}))
    .filter((entity): entity is typeof entity & { engagement: EngagementEntityFacet } =>
      entity.engagement !== undefined);
  if (engaged.length === 0) return [];
  return [{
    code: 'composition_1x1_engagement_dropped',
    path: 'ingredients',
    message:
      `1×1 API wrapper '${composition.slug}' compiles to a plain ingredient with no entity schema, so its `
      + `declared engagement facet(s) are not carried into the installed artifact and the pack's engagement plane `
      + `(reconcile / health / coverage / score) will not light up despite the annotation; add a second operation `
      + `or entity so the composition compiles to a catalog whose entity schema keeps the engagement facet`,
  }];
};

const decomposeCompositionV1 = (composition: CompositionIngredient): DecomposedArtifacts => {
  if (composition.operations.length === 0) {
    throw new Error('composition must declare at least one operation');
  }
  const { recipes, warnings: templateWarnings } = compiledTemplateRecipes(composition);
  if (isOneToOne(composition)) {
    const warnings = [
      ...droppedPrivacyWarning(composition),
      ...droppedCrmAliasWarning(composition),
      ...droppedAcctAliasWarning(composition),
      ...droppedEngagementWarning(composition),
      ...templateWarnings,
    ];
    return {
      ingredient: simpleApiIngredient(composition, composition.operations[0]),
      ...(recipes.length > 0 ? { recipes } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
  const catalog = catalogIngredient(composition);
  return {
    catalog,
    entity_schemas: entitySchemas(composition),
    operation_groups: Object.values(catalog.operation_groups ?? {}),
    default_grants: defaultGrants(composition),
    ...(recipes.length > 0 ? { recipes } : {}),
    ...(templateWarnings.length > 0 ? { warnings: templateWarnings } : {}),
  };
};

const decomposePackV1 = (pack: BulkPackManifest): PackDecomposition => ({
  contents: pack.recipes.map((recipe) => ({ type: 'recipe', ...recipe })),
});

const decomposePackV2 = (pack: BulkPackManifest): PackDecomposition => ({
  contents: normalizeBulkPackInstallPlan(pack).contents,
});

export const decomposeComposition: Record<number, (composition: CompositionIngredient) => DecomposedArtifacts> = {
  1: decomposeCompositionV1,
};

export const decomposePack: Record<number, (pack: BulkPackManifest) => PackDecomposition> = {
  1: decomposePackV1,
  2: decomposePackV2,
};
