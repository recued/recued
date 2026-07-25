/** Connection-agnostic op dispatch — contract types.
 *
 *  The resolver I/O for the R1 install-time rewrite of a connection-agnostic
 *  canonical recipe (one whose steps carry `CanonicalOpStep`s) into a standard
 *  vendor-bound `RecipeDefinition`. Design:
 *  `docs/unified-pack-exploration/connection-agnostic-op-contract.md`.
 *
 *  The resolver logic lives in `@recued/recipes`
 *  (`resolveConnectionAgnosticRecipe`); these types are the contract seam the
 *  backend install path assembles a `PackResolutionContext` against. Public
 *  boundary: the pure resolver takes this injected context — it never imports
 *  the backend binding store.
 */
import {
  CONNECTION_VENDOR_ENTITIES,
  fieldDerivationPrimaryPath,
  canonicalCrmField,
  crmFieldTypeConforms,
  type AcctAlias,
  type ConnectionVendorEntity,
  type ConnectionVendorEntityMetaField,
  type ConnectionVendorEntityMetaFieldType,
  type CrmAlias,
} from './connection-vendors.js';
import type { OperationRow, EntityFieldRow } from './bulk-pack.js';
import type { EntitySchemaIngredientInput, MetaFieldType } from './entity-schema.js';
import type { SearchStyle, WriteStyle } from './ingredient-catalog.js';
import type { CanonicalOpStep, RecipeStep } from './steps.js';

/** The closed canonical CRM verb vocabulary (convention §2). A `CanonicalOpStep`'s
 *  `op` is `<crm_alias>.<verb>` where `<verb>` is one of these — the portable
 *  surface. A pack's vendor-specific ops (its escape hatch) are non-canonical and
 *  not reachable through an op-step. */
export const CANONICAL_CRM_VERBS = ['read', 'search', 'create', 'update', 'delete'] as const;

export type CanonicalCrmVerb = (typeof CANONICAL_CRM_VERBS)[number];

/** The closed canonical filter-operator vocabulary a portable `search` filter may
 *  use — the subset of the 14 recipe condition operators (CLAUDE.md) the resolver
 *  can translate to BOTH vendor search DSLs (HubSpot `filterGroups` + Salesforce
 *  SOQL `WHERE`). `is_empty` / `is_not_empty` are deliberately excluded — neither
 *  vendor has a clean empty-string predicate, so they would not round-trip. The
 *  resolver maps these to each vendor at install time (NEXT-1, search-query
 *  derivation). */
export const CANONICAL_FILTER_OPERATORS = [
  'equal',
  'not_equal',
  'greater',
  'greater_or_equal',
  'less',
  'less_or_equal',
  'is_null',
  'is_not_null',
  'in',
  'not_in',
  'contains',
  'not_contains',
] as const;

export type CanonicalFilterOperator = (typeof CANONICAL_FILTER_OPERATORS)[number];

/** The unary filter operators (no `value`). */
export const CANONICAL_UNARY_FILTER_OPERATORS = ['is_null', 'is_not_null'] as const;

/** One portable filter condition over a CANONICAL field name (the `maps_to`
 *  vocabulary — e.g. `stage`, NOT the vendor `dealstage`). The resolver reverse-
 *  maps `field` to the vendor field + translates `operator`/`value` to the vendor
 *  search DSL. `value` is a literal (string / number / boolean) OR a `{{ref}}`
 *  string resolved at runtime; omitted for the unary `is_null` / `is_not_null`;
 *  an array for `in` / `not_in`. Filtering a DERIVED canonical field (one with no
 *  vendor source — e.g. `close_state`) is rejected at install (it is read-only, G3;
 *  filter on the projectable `stage` instead). */
export interface CanonicalFilterCondition {
  /** canonical field name (a `maps_to` value). */
  field: string;
  operator: CanonicalFilterOperator;
  /** literal, `{{ref}}` string, or array (`in` / `not_in`); omit for unary ops. */
  value?: unknown;
}

/** OR-of-AND-groups search filter (the multi-group form). Each element of `any` is
 *  ONE AND-group — a single condition or an array of conditions AND'd together; the
 *  groups are OR'd. Maps to HubSpot's multiple `filterGroups` (groups OR'd, within-group
 *  AND'd) and SOQL `(… AND …) OR (… AND …)`. The bare-condition / bare-array forms remain
 *  a single AND-group. */
export interface CanonicalFilterOrGroups {
  any: ReadonlyArray<CanonicalFilterCondition | ReadonlyArray<CanonicalFilterCondition>>;
}

/** A portable `search` filter — a single condition or an AND-conjoined array of
 *  conditions (one AND-group), or a `{ any: [...] }` OR-of-AND-groups form (the
 *  groups are OR'd, conditions within a group AND'd). */
export type CanonicalFilter =
  | CanonicalFilterCondition
  | ReadonlyArray<CanonicalFilterCondition>
  | CanonicalFilterOrGroups;

/** Sort directive over a CANONICAL field for a `search` op. */
export interface CanonicalSortSpec {
  /** canonical field name (a `maps_to` value). */
  field: string;
  /** defaults to `asc` when omitted. */
  direction?: 'asc' | 'desc';
}

/** Vendor-NEUTRAL args for a `<crm_alias>.search` op-step. The resolver derives
 *  the vendor SELECT/query (HubSpot search POST body / Salesforce SOQL `q`) from
 *  these + the pack's `entity_fields` (the request-side mirror of the read-side
 *  projection). A canonical search is WALK-ALL: the gateway follows the vendor
 *  cursor (`surfaces.api.pagination_style`) across pages and merges the records, so
 *  the recipe sees the full result set (bounded by `PAGINATION_MAX_RECORDS` /
 *  `PAGINATION_MAX_PAGES`). Unknown keys are rejected at install so a vendor-specific
 *  key (e.g. a raw `filterGroups`) can't silently leak into a "neutral" recipe. */
export interface CanonicalSearchArgs {
  /** per-PAGE size HINT (walk-all — NOT a total cap; the gateway walks all pages).
   *  HubSpot uses it as the per-request page size (clamped to its hard max);
   *  Salesforce has no page-size knob so it is ignored there. Defaults to the
   *  resolver's `DEFAULT_SEARCH_LIMIT` when omitted. */
  limit?: number;
  /** portable filter over canonical fields — a single condition or an AND-conjoined
   *  array (one AND-group), or a `{ any: [...] }` OR-of-AND-groups form (each `any`
   *  element is an AND-group, the groups are OR'd). */
  filter?: CanonicalFilter;
  /** sort over a canonical field. */
  sort?: CanonicalSortSpec;
}

/** Narrow a `RecipeStep` to a `CanonicalOpStep`. A canonical op-step carries a
 *  string `op` and none of the concrete step discriminants (`transform` /
 *  `ingredient` / `guard`) — so a transform step that happens to carry an `op`
 *  key is not mistaken for one. */
export const isCanonicalOpStep = (step: RecipeStep): step is CanonicalOpStep =>
  typeof (step as { op?: unknown }).op === 'string' &&
  !('transform' in step) &&
  !('ingredient' in step) &&
  !('guard' in step);

/** What the install-time resolver needs to bind a canonical op-step against the
 *  CRM-conformant pack the recipe is installed into. The backend assembles this
 *  from the installed `CompositionIngredient` (`operation_families` +
 *  `entity_fields`) + the connection→catalog binding store + the registry
 *  `crm_alias` mapping. */
export interface PackResolutionContext {
  /** pack stable id (binding key + error context). */
  pack_slug: string;
  /** the vendor whose registry `crm_alias`↔entity mapping applies (e.g. `hubspot`). */
  vendor: string;
  /** the pack's bound connection — the DEFAULT an op-step binds to when it
   *  names no per-operand slot (`CanonicalOpStep.connection`, doc §1.3). A
   *  per-step slot ref always wins over this. Omitted when every op-step is
   *  explicitly slotted (a multi-operand recipe has no single pack
   *  connection); an op-step with neither a slot nor this default fails
   *  closed at resolve. */
  connection?: string;
  /** the connection-kind catalog ingredient slug the resolved ops dispatch against. */
  catalog_slug: string;
  /** where a search/list op's records array lives in the raw vendor response.
   *  The result envelope differs per vendor (HubSpot `results`, Salesforce
   *  `records`). Not yet a declared catalog-op field — the open result-envelope
   *  gap; the caller supplies it until a catalog op declares it. */
  result_path: string;
  /** Connection-agnostic op dispatch (NEXT-1, vendor search-builder extensibility) —
   *  the catalog-declared SEARCH DIALECT (`surfaces.api.search_style`) the resolver
   *  translates a canonical `<crm_alias>.search` op-step's vendor-neutral args to.
   *  The request-side query builder is selected by THIS, not by `vendor` — so a
   *  3rd-party CRM whose search API matches a shipped dialect resolves with zero new
   *  code. Omitted (no declared dialect) → a canonical `search` op fails closed at
   *  resolve (other verbs are unaffected — `read` carries path-params, write verbs
   *  pass args verbatim). The install path fills it from the bound catalog's
   *  `surfaces.api.search_style`. See `SearchStyle`. */
  search_style?: SearchStyle;
  /** Connection-agnostic op dispatch (write-verb reverse projection) — the
   *  catalog-declared WRITE body DIALECT (`surfaces.api.write_style`) the resolver
   *  reverse-projects a canonical `<crm_alias>.{create,update}` op-step's canonical
   *  field→value body to (HubSpot `body.properties` / Salesforce flat sObject). The
   *  body builder is selected by THIS, not by `vendor` — a 3rd-party CRM whose write
   *  API matches a shipped dialect resolves with zero new code. Omitted (no declared
   *  dialect) → a canonical `create`/`update` op fails closed at resolve; `delete`
   *  carries no body and is unaffected; `read`/`search` are unaffected. The install
   *  path fills it from the bound catalog's `surfaces.api.write_style`. See
   *  `WriteStyle`. */
  write_style?: WriteStyle;
  /** the pack's operation families. A canonical op `<crm_alias>.<verb>` resolves
   *  to the row whose `operation` id equals `<vendorEntity>.<verb>` — the vendor
   *  entity comes from the registry `crm_alias` mapping, and `verb` here is the
   *  canonical verb (the catalog `OperationRow.verb` is the HTTP method, so the
   *  match is on the `operation` id, not on `verb`). */
  operation_families: ReadonlyArray<OperationRow>;
  /** the pack's entity fields — vendor `field_path` → canonical `maps_to`.
   *  Filtered to the resolved vendor entity (case-insensitive; request-only
   *  fields excluded) when building the projection. */
  entity_fields: ReadonlyArray<EntityFieldRow>;
  /** Connection-agnostic op dispatch (slice 4.5 — 3rd-party registry merge) —
   *  the vendor-entity registry the resolver maps a `crm_alias` → vendor entity
   *  against (`getVendorEntityByCrmAlias`). Omitted → the built-in
   *  `CONNECTION_VENDOR_ENTITIES` (first-party HubSpot / Salesforce, unchanged).
   *  The install path passes the built-ins MERGED with the pack's own
   *  `vendorEntitiesFromComposition(...)` so a 3rd-party CRM pack's authored
   *  `crm_alias` entities resolve too — built-ins first, so a 3rd-party can never
   *  shadow a first-party entity. */
  registry?: ReadonlyArray<ConnectionVendorEntity>;
}

/** The concrete binding a canonical op resolved to — returned per op-step so the
 *  install path can disclose the recipe's resolved ops + key the pack grant. */
export interface ResolvedBinding {
  /** §5 tool-op pack seam — which resolution path produced this binding. Absent
   *  (or `'crm'`) = a CRM canonical op (`<crm_alias>.<verb>`, entity translate +
   *  canonical-field projection). `'tool'` = a tool-op (`<family>.<verb>`, e.g.
   *  `web.search`) that names a pack-declared catalog operation directly and
   *  dispatches PASS-THROUGH — no `crm_alias` / `vendor_entity`, no projection.
   *  `'acct'` (SMB-finance slice 5b) = an accounting canonical op
   *  (`<acct_alias>.<verb>`, read-only) — IDENTITY entity mapping + canonical-field
   *  projection, dispatched to the bound accounting vendor's by-value pack; carries
   *  an `acct_alias` (not a `crm_alias`). */
  op_kind?: 'crm' | 'tool' | 'acct';
  /** the canonical op as authored, e.g. `deal.search` (CRM) or `web.search` (tool). */
  canonical_op: string;
  /** the `crm_alias` entity parsed from the canonical op. Absent for a tool-op or
   *  an accounting op. */
  crm_alias?: CrmAlias;
  /** SMB-finance slice 5b — the `acct_alias` entity parsed from an accounting
   *  canonical op (`op_kind: 'acct'`). Absent for a CRM or tool op. */
  acct_alias?: AcctAlias;
  /** the canonical verb parsed from the canonical op (read/search/create/update/delete
   *  for a CRM op; the `<family>.<verb>` verb segment for a tool-op). */
  verb: string;
  /** the vendor entity the `crm_alias` resolved to via the registry, e.g.
   *  `opportunity`. Absent for a tool-op (no entity translation). */
  vendor_entity?: string;
  /** the resolved vendor operation id, e.g. `opportunity.search`. */
  operation: string;
  /** the catalog ingredient slug the op dispatches against. */
  catalog_slug: string;
  /** the bound connection the op runs against. */
  connection: string;
  /** the vendor. */
  vendor: string;
  /** the recipe step id the op-step occupied (the projection step keeps this id). */
  step_id: string;
  /** the effective result_path the projection read from (per-op override or the
   *  surface default; `''` = bare array at root). Surfaced so the install path
   *  can WARN when a collection op resolved to no path (the silent-empty trap). */
  result_path: string;
}

/** Map a registry meta-field type to the `EntityFieldRow` `MetaFieldType`. The
 *  resolver's projection uses PURE REFS (type-preserving) and ignores this, so
 *  the mapping is for `EntityFieldRow` completeness only — numeric coercion (G2)
 *  stays deferred. `string[]` / `object` collapse to `json`; `date_ms` (a unix-ms
 *  number that is semantically a date) maps to `datetime`. */
const META_FIELD_TYPE_TO_ENTITY_FIELD_TYPE:
  Record<ConnectionVendorEntityMetaFieldType, MetaFieldType> = {
  string: 'string',
  number: 'number',
  'string[]': 'json',
  date_ms: 'datetime',
  object: 'json',
};

/** Build the install resolver's canonical projection map for a vendor FROM THE
 *  REGISTRY — the single, frozen vendor→canonical mapping source (slice-2
 *  decision; supersedes "the pack carries `entity_fields`"). A user-editable
 *  per-instance mapping would silently break every recipe authored against the
 *  canonical fields, so the mapping is a fixed system contract.
 *
 *  Returns one `EntityFieldRow` per registry `crm_alias`-entity meta-field that
 *  declares a `source_path` (`maps_to` = canonical key, `field_path` = vendor
 *  `source_path`, `entity` = registry entity name — matched case-insensitively
 *  by the resolver's projection). DERIVED fields (no `source_path` — `close_state`,
 *  the name concat, the `mailing_address` object) are SKIPPED: they are read-only
 *  and not projectable by a simple ref (G3). A vendor with no `crm_alias` entity
 *  (or none with a `source_path`) yields `[]` → the resolver's "no projectable
 *  fields" install-block.
 *
 *  The backend fills `PackResolutionContext.entity_fields` with this at install;
 *  the resolver stays generic over `entity_fields` (it never reads the registry
 *  itself). Reusable, later, as the one mapping source for the D-128/129/130
 *  reconcilers too. */
export const entityFieldsFromRegistry = (
  vendor: string,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): EntityFieldRow[] => {
  const rows: EntityFieldRow[] = [];
  for (const entry of registry) {
    // A registry entry is projectable iff it is alias-marked (CRM or accounting)
    // for this vendor — the alias is what makes its entity reachable through a
    // canonical op-step. (SMB-finance slice 5b adds the `acct_alias` arm.)
    if (entry.vendor !== vendor || (entry.crm_alias === undefined && entry.acct_alias === undefined)) continue;
    for (const field of entry.meta_fields) {
      // Projectable iff the field declares a single `source_path` OR a
      // `derivation` (a COMPUTED canonical field — the G3 lift; `closed_state`
      // for `close_state`, `concat` for `name`). A field with NEITHER (e.g. the
      // structured `mailing_address` object) stays non-projectable.
      if (field.source_path === undefined && field.derivation === undefined) continue;
      rows.push({
        entity: entry.entity,
        // A derivation field has no single source — `field_path` carries the
        // PRIMARY input (a real dot-path for the resolver's safety validation +
        // any naive reader); the projection + SELECT branch on `derivation` and
        // consume ALL of its input paths (`fieldDerivationInputPaths`).
        field_path: field.source_path ?? fieldDerivationPrimaryPath(field.derivation!),
        maps_to: field.key,
        type: META_FIELD_TYPE_TO_ENTITY_FIELD_TYPE[field.type],
        applies: 'response',
        reviewed: true,
        // G2 request-side datetime filter — carry the registry's per-field date
        // granularity onto the EntityFieldRow so the search builder can emit the
        // right vendor date literal. Only meaningful on a `date_ms` → `datetime` row.
        ...(field.date_granularity === undefined ? {} : { date_granularity: field.date_granularity }),
        ...(field.derivation === undefined ? {} : { derivation: field.derivation }),
      });
    }
  }
  return rows;
};

/** The inverse of `META_FIELD_TYPE_TO_ENTITY_FIELD_TYPE` — a composition's
 *  `MetaFieldType` (`EntityFieldRow.type`) back to the registry
 *  `ConnectionVendorEntityMetaFieldType`, so a 3rd-party pack's authored entity
 *  fields can be expressed as `ConnectionVendorEntity` registry entries (slice
 *  4.5 — registry merge). The round-trip (compositionType → registryType →
 *  `entityFieldsFromRegistry` → `EntityFieldRow.type`) is value-preserving for the
 *  projection: it reads every non-`number` canonical field with a pure,
 *  type-preserving ref, so a `boolean` vendor value still projects as a boolean
 *  even though there is no `boolean` registry slot. The declared type is consulted
 *  only by the request-side SEARCH derivation, which fails closed for a 3rd-party
 *  vendor (no search builder) — so collapsing `boolean`→`string` /
 *  `json`→`object` here cannot mis-drive a query. (`number`→`number` round-trips
 *  exactly, so the G2 numeric coercion still fires.) */
const ENTITY_FIELD_TYPE_TO_META_FIELD_TYPE:
  Record<MetaFieldType, ConnectionVendorEntityMetaFieldType> = {
  string: 'string',
  number: 'number',
  boolean: 'string',
  datetime: 'date_ms',
  json: 'object',
};

/** The canonical (registry-vocabulary) types a pack `MetaFieldType` is allowed to
 *  SATISFY for D-190 Slice 3 conformance. This is deliberately NOT the lossy
 *  projection lift (`ENTITY_FIELD_TYPE_TO_META_FIELD_TYPE`): that map collapses
 *  `boolean → string`, which for conformance would FALSE-PASS a canonical string
 *  field authored as a boolean (the canonical CRM vocabulary has no boolean, so a
 *  boolean must satisfy NOTHING). `json` is the pack's structured catch-all, so it
 *  satisfies both `object` and `string[]`. */
const META_FIELD_TYPE_SATISFIES:
  Record<MetaFieldType, readonly ConnectionVendorEntityMetaFieldType[]> = {
  string: ['string'],
  number: ['number'],
  boolean: [],
  datetime: ['date_ms'],
  json: ['object', 'string[]'],
};

/** Whether a pack field's `MetaFieldType` conforms to the canonical field's
 *  declared type(s) (D-190 Slice 3 decompose-side conformance). A name NOT in the
 *  schema is not type-governed → `true` (the caller emits the separate
 *  non-canonical portability warning). A `boolean` never conforms to a canonical
 *  field (it satisfies no canonical type); `json` conforms to a structured
 *  `object`/`string[]` field. */
export const crmFieldPackTypeConforms = (
  crmAlias: CrmAlias,
  name: string,
  packType: MetaFieldType,
): boolean => {
  if (canonicalCrmField(crmAlias, name) === undefined) return true;
  return META_FIELD_TYPE_SATISFIES[packType].some((t) =>
    crmFieldTypeConforms(crmAlias, name, t),
  );
};

/** Connection-agnostic op dispatch (slice 4.5 — 3rd-party registry merge) — lift a
 *  decomposed composition's entity schemas into `ConnectionVendorEntity` registry
 *  entries, so a 3rd-party CRM pack's authored `crm_alias` + `meta_fields[].source_path`
 *  (slice 4) resolve through the SAME registry path as first-party HubSpot /
 *  Salesforce (`getVendorEntityByCrmAlias` for the `crm_alias`→entity map,
 *  `entityFieldsFromRegistry` for the projection). The install path appends the
 *  result AFTER `CONNECTION_VENDOR_ENTITIES` (built-ins win any collision) and
 *  passes the merged registry on `PackResolutionContext.registry`.
 *
 *  Only category-marked entities (a `crm_alias`, an `acct_alias` [SMB-finance
 *  slice 5b], or an `engagement` facet [D-192 S4] + a `wraps_vendor`) are lifted
 *  — a plain entity is reachable through neither a canonical op nor an engagement
 *  consumer. An engagement entity carries the `engagement` facet through so the
 *  live-registry engagement helpers (`vendorHasEngagement` / `engagementSyncKind`
 *  / …) light up for the pack vendor; its per-vendor cross-entry invariants are
 *  gated at the merge by `assertEngagementRegistryInvariants`. A meta-field with
 *  no `source_path` (a derived field — G3) is skipped, exactly as
 *  `entityFieldsFromRegistry` skips registry-derived fields. The entries are built
 *  directly (not via `buildConnectionVendorEntity`): the source schemas are already
 *  shape-validated by the composition + entity-schema validators at decompose time,
 *  and only `vendor` / `entity` / `crm_alias` / `engagement` / `meta_fields` are
 *  consumed by the registry readers (the registry vendor-id regex also rejects the
 *  hyphenated vendor ids the decomposer legitimately emits, e.g. `google-contacts`).
 *  The result is an ephemeral per-install registry, never the module-level
 *  boot-validated one. */
export const vendorEntitiesFromComposition = (
  schemas: ReadonlyArray<EntitySchemaIngredientInput>,
): ConnectionVendorEntity[] => {
  const out: ConnectionVendorEntity[] = [];
  for (const schema of schemas) {
    const vendor = schema.wraps_vendor;
    const crm_alias = schema.crm_alias;
    const acct_alias = schema.acct_alias;
    const engagement = schema.engagement;
    // Lift an entity that is category-marked — CRM (slice 4.5), accounting
    // (SMB-finance slice 5b), OR an engagement/activity (D-192 S4). A plain
    // entity in none of the three is never reachable through a canonical op nor
    // read by an engagement consumer, so it is not lifted.
    if (crm_alias === undefined && acct_alias === undefined && engagement === undefined) continue;
    if (vendor === undefined || vendor.length === 0) continue; // no vendor key to merge under
    const meta_fields: ConnectionVendorEntityMetaField[] = [];
    for (const field of schema.meta_fields ?? []) {
      if (!field.source_path) continue; // derived / not projectable (G3)
      meta_fields.push({
        key: field.key,
        type: ENTITY_FIELD_TYPE_TO_META_FIELD_TYPE[field.type],
        source_path: field.source_path,
        description: field.description ?? field.key,
        // G2 request-side datetime filter — carry the composition `MetaField`'s
        // authored date granularity onto the lifted registry field so a 3rd-party
        // CRM pack's datetime filter round-trips (the search builder reads it back
        // off `EntityFieldRow.date_granularity` via `entityFieldsFromRegistry`). The
        // composition author declares it on a `datetime`-typed field, which lifts to
        // a `date_ms` registry field here — exactly where the registry gate expects
        // it. A non-`datetime` field never carries it (the entity-schema validator
        // rejects that), so this only ever annotates a `date_ms` row.
        ...(field.date_granularity === undefined ? {} : { date_granularity: field.date_granularity }),
      });
    }
    out.push({
      vendor,
      entity: schema.entity_id,
      scope: `connection.api.${vendor}.${schema.entity_id}`,
      display_name: `${vendor} ${schema.entity_id}`,
      meta_fields,
      ...(crm_alias !== undefined ? { crm_alias } : {}),
      ...(acct_alias !== undefined ? { acct_alias } : {}),
      ...(engagement !== undefined ? { engagement } : {}),
    });
  }
  return out;
};
