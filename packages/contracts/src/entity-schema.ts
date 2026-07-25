/**
 * D-165 — Entity schemas (the vendor → canonical `data.*` mapping layer).
 *
 * Catalogs declare endpoints; **entity-schema ingredients** declare durable
 * schemas; recipes make data durable; packs bundle the three for one-click
 * install. This file lands the contract surface for the entity-schema
 * ingredient input and its per-field mapping (`MetaField`), so the catalog
 * publisher's vendor→canonical mapping is declarative and validatable rather
 * than buried in recipe code.
 *
 * `MetaField.privacy?` is the single D-167 catalog tag — a publisher marks a
 * canonical field as PII-bearing with one closed-list value and the D-167
 * substrate owns everything else (alias allocation, ledger keying, suffix
 * composition, restore policy, audit summary). The tag is consumed only in
 * chat mode (Recued-direct chat / webclient context / delegated-MCP tasks
 * where Recued owns the LLM↔user boundary); recipe-mode AI calls ignore it.
 *
 * Scope is bounded to the contract types + a strict shape validator. The
 * install-time machinery D-165 also specifies — schema discovery against a
 * live connection, `ConnectionRecord.discovered_schemas` persistence, the
 * derived `CONNECTION_VENDOR_ENTITIES` registry regeneration, and the
 * marketplace certification / shape-conformance gates — lives in D-165's own
 * runtime implementation, not here.
 *
 * Spec: D-165 §Durability model, §Entity schemas,
 * §`MetaField` — the vendor → canonical mapping. PII tag: D-167
 * §Field declaration + §Integration points → D-165 entity schemas.
 */

import { isEntityFieldPrivacy } from './pii-alias.js';
import type { EntityFieldPrivacy } from './pii-alias.js';
import { ACCT_ALIAS_VALUES, CRM_ALIAS_VALUES, assertEngagementFacetShape, isDateGranularity } from './connection-vendors.js';
import type { AcctAlias, CrmAlias, DateGranularity, EngagementEntityFacet } from './connection-vendors.js';

/* ──────────────── Projection + schema modes ──────────────── */

/**
 * Where the durable record lives + who is source-of-truth.
 *
 *   - `platform_reference`  — vendor is SoT; Recued stores an anchor + meta
 *                             snapshot (HubSpot / Salesforce CRM, Stripe
 *                             customers, Notion pages-as-anchors). Existing
 *                             D-128 substrate.
 *   - `canonical_mirror`    — Recued's warehouse IS the user-facing collection
 *                             (`data.mail.*`, `data.calendar.*`, `data.file.*`);
 *                             the vendor is one sync source.
 *   - `contributing_source` — multiple vendors contribute records to a
 *                             Recued-canonical collection keyed on a canonical
 *                             key (Google Contacts → `data.contact.<email>`,
 *                             D-138 `platform_ids` linkage).
 */
export type ProjectionMode =
  | 'platform_reference'
  | 'canonical_mirror'
  | 'contributing_source';

export const PROJECTION_MODES = [
  'platform_reference',
  'canonical_mirror',
  'contributing_source',
] as const satisfies readonly ProjectionMode[];

export const isProjectionMode = (s: unknown): s is ProjectionMode =>
  typeof s === 'string' && (PROJECTION_MODES as readonly string[]).includes(s);

/**
 * How the field schema is determined.
 *
 *   - `static`                — schema declared in the ingredient (HubSpot
 *                               deal, mail-message).
 *   - `dynamic_per_connection`— schema discovered at connection enrollment via
 *                               `schema_discovery_operation`, persisted per
 *                               connection. Sub-resource variability (Notion
 *                               databases, Linear teams) is handled by creating
 *                               multiple path-scoped connections, not a third
 *                               schema mode.
 */
export type EntitySchemaMode = 'static' | 'dynamic_per_connection';

export const ENTITY_SCHEMA_MODES = [
  'static',
  'dynamic_per_connection',
] as const satisfies readonly EntitySchemaMode[];

export const isEntitySchemaMode = (s: unknown): s is EntitySchemaMode =>
  typeof s === 'string' && (ENTITY_SCHEMA_MODES as readonly string[]).includes(s);

/* ──────────────── MetaField — vendor → canonical mapping ──────────────── */

/**
 * Canonical field type. Distinct from D-128's `ConnectionVendorEntityMetaField`
 * type set (`'string[]'` / `'date_ms'` / `'object'`) — that type describes a
 * platform-reference *snapshot* slot; this one describes a canonical `data.*`
 * field's value shape.
 */
export type MetaFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'datetime'
  | 'json';

export const META_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'datetime',
  'json',
] as const satisfies readonly MetaFieldType[];

export const isMetaFieldType = (s: unknown): s is MetaFieldType =>
  typeof s === 'string' && (META_FIELD_TYPES as readonly string[]).includes(s);

/**
 * One canonical field + its vendor→canonical mapping.
 *
 * The entity-schema ingredient publisher is the trust authority for what
 * `source_path` maps onto which canonical field. Recipes become orchestrators
 * — they call catalog operations and feed responses through this mapping;
 * they don't re-implement field mapping per recipe.
 */
export interface MetaField {
  /** Canonical field name in `data.*`. Dotted form allowed for nested keys
   *  (`key_dates.close_date`); the validator compares verbatim. */
  key: string;
  type: MetaFieldType;
  description?: string;
  required?: boolean;

  /** JSONPath / dot-path into the operation's response. Required for both
   *  `static` and `dynamic_per_connection` modes (`"properties.dealname"`,
   *  `"Name"`, `"result.amount"`). */
  source_path: string;
  /** Optional named transform from the existing transform catalog
   *  (`"parse_number"`, `"lowercase"`, `"stage_label_lookup"`). The
   *  contract validator checks well-formedness only; the missing-transform
   *  cross-check against the transform catalog is an install-time concern. */
  transform?: string;
  transform_args?: Record<string, unknown>;
  /** Value to use when `source_path` resolves to null / missing. */
  fallback?: unknown;

  /**
   * Connection-agnostic op dispatch (G2 request-side datetime filter) — for a
   * `type: 'datetime'` field, its date GRANULARITY (`date` | `datetime`). A
   * 3rd-party CRM pack authors it here so the install-time lift
   * (`vendorEntitiesFromComposition` → `entityFieldsFromRegistry`) round-trips
   * it onto the projectable `EntityFieldRow.date_granularity`, which the search
   * builder needs to emit the right vendor date literal. Required for a
   * `datetime` field to be server-side filterable (absent → the resolver fails
   * closed); meaningless on a non-`datetime` field (the validator rejects it
   * there). First-party HubSpot / Salesforce declare it on the registry
   * meta-field instead. See `DateGranularity`.
   */
  date_granularity?: DateGranularity;

  /**
   * D-167 — optional PII tag. Consumed only in chat-mode context composition
   * (Recued-direct chat / webclient / delegated-MCP tasks where Recued owns
   * the LLM↔user boundary). Recipe-mode AI calls ignore it — recipes manage
   * PII via the `pii-protect` / `pii-restore` transforms (same alias substrate,
   * explicit opt-in). The substrate fills redaction mode / alias scope /
   * restore policy from per-kind defaults; this tag is the only publisher knob.
   */
  privacy?: EntityFieldPrivacy;
}

/* ──────────────── Composite target id + cross-catalog source ops ─────── */

/**
 * Composite-key target id. `template` interpolates `fields` into a stable
 * durable-row id (`"hubspot_deal_{id}"`, `"s3_{bucket}_{key_hash}"`,
 * `"forms_{form_id}_{response_id}"`).
 */
export interface EntitySchemaTargetId {
  fields: string[];
  template: string;
}

/**
 * A `{catalog, operation}` pair. Source operations carry full pairs (not bare
 * operation ids) so cross-catalog entity bindings work — Google Docs spans
 * Drive + Docs APIs, so the primary catalog need not be the operation source.
 */
export interface EntitySchemaSourceOperation {
  catalog: string;
  operation: string;
}

/**
 * Map of well-known lifecycle keys → source operation. Keys are open-ended
 * (`'list' | 'search' | 'get' | 'webhook' | 'delete_event' | string`); a
 * schema declares whichever the vendor supports.
 */
export type EntitySchemaSourceOperations = Record<string, EntitySchemaSourceOperation>;

/* ──────────────── Entity-schema ingredient input ──────────────── */

/**
 * The entity-schema ingredient — always a standalone artifact (never inline on
 * the catalog manifest), bundled via packs for first-party convenience.
 */
export interface EntitySchemaIngredientInput {
  /** Points at the catalog this entity binds to. */
  ingredient_id: string;
  /** Mirrors the catalog's `wraps_vendor`; keys the warehouse scope. */
  wraps_vendor?: string;
  /** `"deal"`, `"opportunity"`, `"issue"`, `"object"`, `"page"`. */
  entity_id: string;
  /** Durable scope; shape depends on `projection_mode` (see §Scope conventions
   *  per projection — `connection.api.<vendor>.<entity>` for platform_reference,
   *  `data.<collection>.<id>` for canonical_mirror, `data.<collection>.<key>`
   *  for contributing_source, `data.entity.<publisher>.<slug>.<entity>` for
   *  publisher-scoped). */
  scope: string;
  projection_mode: ProjectionMode;
  schema_mode: EntitySchemaMode;

  target_id: EntitySchemaTargetId;
  /** Canonical record fields with vendor→canonical mapping. Required for
   *  `static` schemas (the field schema is declared in the ingredient);
   *  omitted for `dynamic_per_connection`, where the schema is discovered at
   *  connection enrollment and persisted on the `ConnectionRecord` (see the
   *  spec's canonical Notion example, which carries no `meta_fields`). The
   *  validator enforces presence for `static`. */
  meta_fields?: MetaField[];
  source_operations: EntitySchemaSourceOperations;

  /** Cross-catalog parent (Forms responses, Notion blocks). */
  parent_entity?: { ingredient_id: string; entity_id: string };
  /** Required when `schema_mode` is `dynamic_per_connection`; the operation run
   *  once at connection enrollment to discover the field schema. */
  schema_discovery_operation?: string;
  /** D-130 cross-vendor logical CRM entity name; lifts the entity into the
   *  `data.crm.<crm_alias>.*` resolver. Omit for non-CRM entities. */
  crm_alias?: CrmAlias;
  /** SMB-finance wedge slice 5b — cross-vendor logical ACCOUNTING entity name;
   *  marks the entity reachable through a canonical accounting op-step
   *  (`invoice.search`) dispatched to the bound vendor (QuickBooks / Xero).
   *  Mutually exclusive with `crm_alias`. Omit for non-accounting entities. */
  acct_alias?: AcctAlias;
  /** D-192 — engagement facet. Marks this a CRM engagement/activity entity
   *  (email / meeting / call / task / …). `vendorEntitiesFromComposition` lifts
   *  it onto the per-install `ConnectionVendorEntity.engagement` so a pack CRM's
   *  engagement plane (reconcile / health / coverage / score) works with no code
   *  edit. A THIRD entity category — mutually exclusive with `crm_alias` /
   *  `acct_alias`. Omit for non-engagement entities. */
  engagement?: EngagementEntityFacet;
}

/* ──────────────── Validator ──────────────── */

/** Entity id: simple lowercase identifier (`deal`, `contact`, `database`). */
const IDENTIFIER_REGEX = /^[a-z][a-z0-9_]*$/;
/** Vendor id: lowercase identifier, hyphens allowed — catalogs use hyphenated
 *  vendor ids such as `google-contacts` (spec §Google Contacts example). */
const VENDOR_REGEX = /^[a-z][a-z0-9_-]*$/;
/** Canonical field name: lowercase identifier, dotted nesting allowed. */
const META_FIELD_KEY_REGEX = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const CRM_ALIAS_SET: ReadonlySet<string> = new Set(CRM_ALIAS_VALUES);
const ACCT_ALIAS_SET: ReadonlySet<string> = new Set(ACCT_ALIAS_VALUES);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Contract-level `source_path` check: present and not whitespace-only. The
 * spec's "well-formed JSONPath/dot-path" is resolved structurally against the
 * operation's `response_schema` at install time — a pure-contract validator
 * can't do that without a JSONPath parser, and must NOT false-reject valid
 * forms it can't parse: bracket indices (`emailAddresses[0].value`), recursive
 * descent (`$..author`), or quoted segment names with spaces (`$['Due Date']`,
 * common for Notion `dynamic_per_connection` properties).
 */
const isWellFormedSourcePath = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

/**
 * Strict shape validator for one `EntitySchemaIngredientInput`. Returns an
 * array of issue strings (empty when well-formed) — mirrors
 * `assertConnectionVendorEntityShape`. Authors throw on a non-empty array so
 * misconfiguration surfaces at boot, not at first sync.
 *
 * Deliberately lenient where the spec is lenient: `meta_fields` may be empty
 * (anchor-only platform_reference rows carry their snapshot elsewhere) and a
 * vendor field with no `meta_field` entry is not an error (recipes persist
 * unmapped fields to `extra.<key>`).
 */
export function assertEntitySchemaIngredientShape(entry: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainObject(entry)) return ['expected object'];
  const e = entry;

  if (!isNonEmptyString(e.ingredient_id)) {
    issues.push("field 'ingredient_id' must be a non-empty string");
  }
  if (typeof e.entity_id !== 'string' || !IDENTIFIER_REGEX.test(e.entity_id)) {
    issues.push(`field 'entity_id' must match ${IDENTIFIER_REGEX.source}`);
  }
  if (e.wraps_vendor !== undefined
      && (typeof e.wraps_vendor !== 'string' || !VENDOR_REGEX.test(e.wraps_vendor))) {
    issues.push(`field 'wraps_vendor' must match ${VENDOR_REGEX.source} when present`);
  }

  if (!isProjectionMode(e.projection_mode)) {
    issues.push(
      `field 'projection_mode' must be one of ${PROJECTION_MODES.join(' / ')}`,
    );
  }
  if (!isEntitySchemaMode(e.schema_mode)) {
    issues.push(
      `field 'schema_mode' must be one of ${ENTITY_SCHEMA_MODES.join(' / ')}`,
    );
  }

  // Scope: shape is gated by projection_mode (spec §Scope conventions per
  // projection). platform_reference → `connection.api.<wraps_vendor>.<entity_id>`
  // (or the publisher-scoped `data.entity.*` escape hatch); canonical_mirror /
  // contributing_source → `data.*`. The publisher-scoped `data.entity.*` form
  // is valid under any projection. The mode-specific checks run only when
  // projection_mode itself is valid (an invalid mode is already flagged above).
  if (!isNonEmptyString(e.scope)) {
    issues.push("field 'scope' must be a non-empty string");
  } else if (isProjectionMode(e.projection_mode)) {
    const scope = e.scope;
    if (e.projection_mode === 'platform_reference') {
      if (scope.startsWith('connection.api.')) {
        if (typeof e.wraps_vendor === 'string' && typeof e.entity_id === 'string') {
          const expected = `connection.api.${e.wraps_vendor}.${e.entity_id}`;
          if (scope !== expected) {
            issues.push(
              `field 'scope' (${scope}) does not match platform_reference layout 'connection.api.<wraps_vendor>.<entity_id>' = '${expected}'`,
            );
          }
        }
      } else if (!scope.startsWith('data.entity.')) {
        issues.push(
          "field 'scope' for projection_mode 'platform_reference' must be 'connection.api.<wraps_vendor>.<entity_id>' or a publisher-scoped 'data.entity.*' scope",
        );
      }
    } else if (!scope.startsWith('data.')) {
      // canonical_mirror | contributing_source
      issues.push(
        `field 'scope' for projection_mode '${e.projection_mode}' must start with 'data.' (canonical collection or publisher-scoped 'data.entity.*')`,
      );
    }
  }

  // target_id
  if (!isPlainObject(e.target_id)) {
    issues.push("field 'target_id' must be an object { fields, template }");
  } else {
    const t = e.target_id;
    if (!Array.isArray(t.fields) || t.fields.length === 0
        || !t.fields.every(isNonEmptyString)) {
      issues.push("field 'target_id.fields' must be a non-empty array of non-empty strings");
    }
    if (!isNonEmptyString(t.template)) {
      issues.push("field 'target_id.template' must be a non-empty string");
    }
  }

  // meta_fields — required (an array) for `static`; omitted for
  // `dynamic_per_connection` (schema discovered at enrollment). When present
  // under any mode, every entry is validated.
  if (e.meta_fields === undefined) {
    if (e.schema_mode === 'static') {
      issues.push("field 'meta_fields' is required (an array) when schema_mode is 'static'");
    }
  } else if (!Array.isArray(e.meta_fields)) {
    issues.push("field 'meta_fields' must be an array when present");
  } else {
    const seen = new Set<string>();
    e.meta_fields.forEach((raw, idx) => {
      if (!isPlainObject(raw)) {
        issues.push(`meta_fields[${idx}] must be an object`);
        return;
      }
      const f = raw;
      if (typeof f.key !== 'string' || !META_FIELD_KEY_REGEX.test(f.key)) {
        issues.push(`meta_fields[${idx}].key must match ${META_FIELD_KEY_REGEX.source}`);
      } else if (seen.has(f.key)) {
        issues.push(`meta_fields[${idx}].key '${f.key}' duplicates an earlier entry`);
      } else {
        seen.add(f.key);
      }
      if (!isMetaFieldType(f.type)) {
        issues.push(`meta_fields[${idx}].type must be one of ${META_FIELD_TYPES.join(' / ')}`);
      }
      if (f.description !== undefined && typeof f.description !== 'string') {
        issues.push(`meta_fields[${idx}].description must be a string when present`);
      }
      if (f.required !== undefined && typeof f.required !== 'boolean') {
        issues.push(`meta_fields[${idx}].required must be a boolean when present`);
      }
      if (!isWellFormedSourcePath(f.source_path)) {
        issues.push(`meta_fields[${idx}].source_path must be a non-empty string (structural JSONPath/dot-path validation resolves against the operation response_schema at install time)`);
      }
      if (f.transform !== undefined && !isNonEmptyString(f.transform)) {
        issues.push(`meta_fields[${idx}].transform must be a non-empty string when present`);
      }
      if (f.transform_args !== undefined && !isPlainObject(f.transform_args)) {
        issues.push(`meta_fields[${idx}].transform_args must be an object when present`);
      }
      if (f.privacy !== undefined && !isEntityFieldPrivacy(f.privacy)) {
        issues.push(`meta_fields[${idx}].privacy must be a valid EntityFieldPrivacy kind when present (got ${JSON.stringify(f.privacy)})`);
      }
      // G2 request-side datetime filter — `date_granularity` is optional, but when
      // present must be `date` | `datetime` and only valid on a `datetime` field (it
      // drives the vendor date literal; a non-date field can't carry a date
      // granularity). Mirrors the registry meta-field gate
      // (`assertConnectionVendorEntityShape`), keyed on this layer's `datetime` type
      // (the registry's `date_ms`).
      if (f.date_granularity !== undefined) {
        if (!isDateGranularity(f.date_granularity)) {
          issues.push(`meta_fields[${idx}].date_granularity must be 'date' or 'datetime' when present`);
        } else if (f.type !== 'datetime') {
          issues.push(`meta_fields[${idx}].date_granularity is only valid on a 'datetime' field (got type '${String(f.type)}')`);
        }
      }
    });
  }

  // source_operations
  if (!isPlainObject(e.source_operations)) {
    issues.push("field 'source_operations' must be an object of { catalog, operation } pairs");
  } else {
    const keys = Object.keys(e.source_operations);
    if (keys.length === 0) {
      issues.push("field 'source_operations' must declare at least one source operation");
    }
    for (const k of keys) {
      const op = (e.source_operations as Record<string, unknown>)[k];
      if (!isPlainObject(op)
          || !isNonEmptyString(op.catalog)
          || !isNonEmptyString(op.operation)) {
        issues.push(`source_operations['${k}'] must be { catalog: string; operation: string }`);
      }
    }
  }

  // parent_entity
  if (e.parent_entity !== undefined) {
    if (!isPlainObject(e.parent_entity)) {
      issues.push("field 'parent_entity' must be an object { ingredient_id, entity_id } when present");
    } else {
      const p = e.parent_entity;
      if (!isNonEmptyString(p.ingredient_id)) {
        issues.push("field 'parent_entity.ingredient_id' must be a non-empty string");
      }
      if (typeof p.entity_id !== 'string' || !IDENTIFIER_REGEX.test(p.entity_id)) {
        issues.push(`field 'parent_entity.entity_id' must match ${IDENTIFIER_REGEX.source}`);
      }
    }
  }

  // schema_discovery_operation — required iff dynamic_per_connection
  if (e.schema_mode === 'dynamic_per_connection') {
    if (!isNonEmptyString(e.schema_discovery_operation)) {
      issues.push("field 'schema_discovery_operation' is required when schema_mode is 'dynamic_per_connection'");
    }
  } else if (e.schema_discovery_operation !== undefined
             && !isNonEmptyString(e.schema_discovery_operation)) {
    issues.push("field 'schema_discovery_operation' must be a non-empty string when present");
  }

  // crm_alias
  if (e.crm_alias !== undefined
      && (typeof e.crm_alias !== 'string' || !CRM_ALIAS_SET.has(e.crm_alias))) {
    issues.push(
      `field 'crm_alias' must be one of ${[...CRM_ALIAS_VALUES].join(' / ')} when present (got ${JSON.stringify(e.crm_alias)})`,
    );
  }

  // acct_alias (SMB-finance slice 5b) — mutually exclusive with crm_alias
  if (e.acct_alias !== undefined) {
    if (typeof e.acct_alias !== 'string' || !ACCT_ALIAS_SET.has(e.acct_alias)) {
      issues.push(
        `field 'acct_alias' must be one of ${[...ACCT_ALIAS_VALUES].join(' / ')} when present (got ${JSON.stringify(e.acct_alias)})`,
      );
    }
    if (e.crm_alias !== undefined) {
      issues.push("fields 'crm_alias' and 'acct_alias' are mutually exclusive");
    }
  }

  // engagement (D-192 S4) — the SAME facet shape as a registry entry (validated
  // by the shared `assertEngagementFacetShape`), a THIRD entity category mutually
  // exclusive with crm_alias / acct_alias. The per-vendor cross-entry invariants
  // (one sync_kind / one daily_budget / uniform group capability) are enforced on
  // the MERGED registry at lift time (`assertEngagementRegistryInvariants`), not
  // here — one schema carries one entity, so they can't be checked in isolation.
  if (e.engagement !== undefined) {
    for (const i of assertEngagementFacetShape(e.engagement)) issues.push(i);
    if (e.crm_alias !== undefined || e.acct_alias !== undefined) {
      issues.push(
        "field 'engagement' is mutually exclusive with 'crm_alias' / 'acct_alias' — an entity is exactly one category",
      );
    }
  }

  return issues;
}

/** Convenience — assert shape + throw on issues, so a malformed entity-schema
 *  ingredient surfaces at boot rather than at first sync. */
export function assertEntitySchemaIngredientValid(
  entry: EntitySchemaIngredientInput,
): void {
  const issues = assertEntitySchemaIngredientShape(entry);
  if (issues.length > 0) {
    throw new Error(
      `invalid EntitySchemaIngredientInput for '${entry.ingredient_id ?? '<unknown>'}::${entry.entity_id ?? '<unknown>'}': ${issues.join('; ')}`,
    );
  }
}
