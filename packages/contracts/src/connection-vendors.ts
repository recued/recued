/** D-128 Phase 4 — Vendor-entity registry.
 *
 *  Per-vendor + per-entity manifest entries that vendor Ds (D-129
 *  HubSpot, D-130 Salesforce) populate at boot. The registry serves
 *  three loads:
 *
 *    1. **Validator gate.** Recipes referencing
 *       `data.enrichment.connection.api.<vendor>.<entity>.<id>.<topic>`
 *       are typo-rejected at parse time when `(vendor, entity)` isn't
 *       in `CONNECTION_VENDOR_ENTITIES`.
 *
 *    2. **Meta-fields schema.** Each entry declares the closed list of
 *       canonical fields its meta snapshot carries (`name`, `status`,
 *       `amount`, `key_dates`, etc.) plus their types. The Memory tab
 *       renders entity-detail cards from this schema (Phase 5);
 *       resolver `meta.<field>` lookups validate against it.
 *
 *    3. **Display name + entity-id format hint.** The Memory tab UI +
 *       any cross-vendor abstraction (D-130 `crm.deal.*` shape) reads
 *       these for human-readable rendering of opaque platform-native
 *       target ids.
 *
 *  D-128 shipped an empty array. D-129 P2 lands the first vendor entry
 *  (`hubspot.deal`); P3 + P4 stack `hubspot.contact` + `hubspot.company`.
 *  The registry initializer relies on `buildConnectionVendorEntity` +
 *  the shape validator being hoisted above the array literal — those
 *  helpers are declared as `function` (hoisted) and the per-module
 *  validator constants are declared above the registry for the same
 *  reason.
 *
 *  Spec: D-128 §A.6, D-129 §A.2. */

import type { EnrichmentScope } from './enrichment-registry.js';
import {
  composeVendorEntityScope,
  isPlatformReferenceScope,
  parseVendorEntityScope,
} from './enrichment-registry.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Type of a single canonical meta field. The closed list keeps the
 *  resolver's `meta.<field>` lookup typed and stops authors stuffing
 *  arbitrary blobs into snapshots — meta carries display + diff +
 *  enrichment-compute fields, not free-form metadata.
 *
 *  - `'string'` — single string (name / owner / stage).
 *  - `'number'` — numeric (amount / count / score).
 *  - `'string[]'` — string list (tags / contacts).
 *  - `'date_ms'` — unix-ms timestamp; numerically the same as `'number'`
 *    but semantically a date for renderers + bistemporal stamping. */
export type ConnectionVendorEntityMetaFieldType =
  | 'string'
  | 'number'
  | 'string[]'
  | 'date_ms'
  // D-138 P1 — structured mailing address sub-object on contact.
  | 'object';

/** Connection-agnostic op dispatch (G2 request-side datetime filter) — the
 *  date GRANULARITY of a `date_ms` field, declared PER VENDOR FIELD because it is
 *  not derivable from the canonical type: the same canonical field is a DATETIME on
 *  one vendor and a date-only field on another (e.g. `recent_activity_at` →
 *  HubSpot `notes_last_contacted` is a datetime, Salesforce `LastActivityDate` is a
 *  Date). It drives ONLY the request-side `search` filter literal — the read
 *  projection always normalizes to unix-ms regardless. Both vendors are strict:
 *  Salesforce SOQL needs `YYYY-MM-DD` for a Date field and `YYYY-MM-DDThh:mm:ssZ`
 *  for a DateTime field (NOT interchangeable); HubSpot's search accepts ISO for
 *  both. A `date_ms` field WITHOUT this annotation is not server-filterable (the
 *  resolver fails closed) — filter it in a transform step over the projected
 *  unix-ms instead. */
export type DateGranularity = 'date' | 'datetime';

export const DATE_GRANULARITIES = ['date', 'datetime'] as const satisfies readonly DateGranularity[];

export const isDateGranularity = (s: unknown): s is DateGranularity =>
  typeof s === 'string' && (DATE_GRANULARITIES as readonly string[]).includes(s);

/** Connection-agnostic op dispatch — a COMPUTED canonical field. Instead of a
 *  single `source_path`, the projection DERIVES the value from multiple vendor
 *  fields, so a canonical field that no single vendor field provides (the CRM
 *  open/won/lost state) is still projectable + cross-vendor — the G3 lift. The
 *  install resolver lowers each kind to a deterministic projection expression and
 *  the SELECT fetches the declared input paths. A vendor that DOES expose the
 *  value as one field uses a plain `source_path` instead (e.g. Pipedrive `status`
 *  is already open/won/lost) — both are supported; a field declares at most one. */
export type FieldDerivation =
  | {
      /** CRM open/won/lost tri-state from a "closed" flag + a "won" flag:
       *  `closed && won → "won"`; `closed && !won → "lost"`; else `"open"`. Vendor
       *  booleans may arrive as real booleans (Salesforce) or "true"/"false" strings
       *  (HubSpot) — both coerce. HubSpot `properties.hs_is_closed` +
       *  `properties.hs_is_closed_won`; Salesforce `IsClosed` + `IsWon`. */
      kind: 'closed_state';
      /** vendor path that is truthy when the record is closed (won OR lost). */
      closed_path: string;
      /** vendor path that is truthy when the record is closed-WON. */
      won_path: string;
    }
  | {
      /** Concatenate ≥1 vendor source paths into one string, in order, SKIPPING
       *  empty/whitespace parts, joined by `separator`. When every part is empty,
       *  falls back to `fallback_path`'s raw value if set, else `null`. The
       *  cross-vendor `name` for vendors that store first/last separately
       *  (HubSpot / Salesforce); a vendor with a single name field uses a plain
       *  `source_path` (Pipedrive `name`). Read-only / not server-filterable, like
       *  every derived field. */
      kind: 'concat';
      /** vendor paths to concatenate, in order (≥1, each a non-empty dot-path). */
      parts: string[];
      /** joiner between non-empty parts. Default `''` (name sets `' '`). */
      separator?: string;
      /** vendor path whose value is used when every part is empty (optionally
       *  transformed by `fallback_transform`). */
      fallback_path?: string;
      /** transform applied to the fallback before use. `'local_part'` → the
       *  substring before '@' (an email field → its name part); requires
       *  `fallback_path`. */
      fallback_transform?: 'local_part';
    };

/** The closed set of `FieldDerivation.kind`s — gated by the registry validator. */
export const FIELD_DERIVATION_KINDS: ReadonlySet<string> = new Set(['closed_state', 'concat']);

/** Every vendor source path a derivation reads — the SELECT/poll fetches these,
 *  and the resolver regex-validates each before embedding it as a projection
 *  `{{item.*}}` ref (so no input path can inject a template ref). */
export const fieldDerivationInputPaths = (d: FieldDerivation): string[] =>
  d.kind === 'closed_state'
    ? [d.closed_path, d.won_path]
    : [...d.parts, ...(d.fallback_path !== undefined ? [d.fallback_path] : [])];

/** The derivation's primary input path — carried as the field's `field_path`
 *  (a real dot-path for the resolver's safety validation + naive readers). */
export const fieldDerivationPrimaryPath = (d: FieldDerivation): string =>
  d.kind === 'closed_state' ? d.closed_path : (d.parts[0] ?? '');

/** Closed list of meta-fields a `(vendor, entity)` snapshot can carry. */
export interface ConnectionVendorEntityMetaField {
  /** Field name as it appears under `meta.<key>` in the enrichment
   *  row. Must match `/^[a-z][a-z0-9_]*$/` — same convention as
   *  scope segments + topic names. Nested keys (e.g. `key_dates.close_date`)
   *  use a dotted form here; the validator compares verbatim. */
  key: string;
  type: ConnectionVendorEntityMetaFieldType;
  description: string;
  /** Connection-agnostic op dispatch (G2 request-side datetime filter) — for a
   *  `type: 'date_ms'` field, its date GRANULARITY (`date` | `datetime`), which
   *  drives the vendor `search` filter literal (see `DateGranularity`). Required
   *  for a `date_ms` field to be server-side filterable; absent → the resolver fails
   *  closed on a filter over it. Meaningless on non-`date_ms` types (ignored). */
  date_granularity?: DateGranularity;
  /** Connection-agnostic op dispatch (slice 2) — the structured vendor source
   *  path this canonical field projects FROM in the raw vendor record (HubSpot
   *  search record `{ id, properties: {...} }` → `properties.dealname`;
   *  Salesforce SOQL record is flat → `Name`). The registry is the SINGLE,
   *  frozen mapping source: `entityFieldsFromRegistry` reads this to build the
   *  install resolver's canonical projection (and, later, unifies with the
   *  D-128/129/130 reconcilers). DERIVED fields (no single source — e.g.
   *  `close_state` computed from multiple flags, `name` concatenated from
   *  first+last, a structured `mailing_address` object) OMIT this and are
   *  read-only / not projectable by a simple ref (G3). Populated for the CRM
   *  `crm_alias` entities; absent on non-CRM entities until they need
   *  projection. When present must be a non-empty dotted path. */
  source_path?: string;
  /** Connection-agnostic op dispatch — a COMPUTED projection for a canonical
   *  field with no single vendor source (the G3 lift; see `FieldDerivation`).
   *  Mutually exclusive with `source_path`. Today only `close_state` carries one
   *  (`closed_state`). The resolver lowers it to a deterministic projection
   *  expression + the SELECT fetches the input paths. */
  derivation?: FieldDerivation;
}

/** D-130 P7 — closed list of cross-vendor logical CRM entity names.
 *  An entity that participates in the cross-vendor `data.crm.*`
 *  resolver carries one of these as its `crm_alias`; non-CRM vendors
 *  (future Linear / Notion / Jira) omit the field and do not appear
 *  under `data.crm.*`. The list is closed at D-130 — a third+ vendor
 *  with a brand-new entity that doesn't fit `'deal' | 'contact' | 'account'`
 *  forces an explicit list extension and validator update.
 *
 *  Naming favors Salesforce's industry-standard CRM lexicon
 *  (`account` over HubSpot's `company`) — `account` is the more
 *  neutral cross-CRM term. Vendor-specific aliases preserve native
 *  naming (`data.hubspot.company.*` / `data.salesforce.account.*`). */
export const CRM_ALIAS_VALUES = ['deal', 'contact', 'account'] as const;
export type CrmAlias = (typeof CRM_ALIAS_VALUES)[number];
const CRM_ALIAS_SET: ReadonlySet<string> = new Set(CRM_ALIAS_VALUES);

/** SMB-finance wedge slice 5b — closed list of cross-vendor logical ACCOUNTING
 *  entity names, the `acct_alias` sibling of `CRM_ALIAS_VALUES`. An accounting
 *  entity that a canonical op-step (`invoice.search`) dispatches across vendors
 *  (QuickBooks ↔ Xero) carries one of these as its `acct_alias`. Unlike the CRM
 *  aliases (deal → opportunity), the accounting canonical name IS the pack entity
 *  name on BOTH vendors (invoice → invoice), so the alias is an IDENTITY mapping —
 *  it exists to mark an entity as accounting-canonical + reachable through an
 *  op-step, not to remap a vendor-specific name.
 *
 *  Deliberately NO enrichment-plane resolver (no `data.acct.*` lens like
 *  `data.crm.*`): these entities are read LIVE from the vendor API each run and
 *  returned to the user, not pre-computed into the warehouse, so the cross-vendor
 *  value is in the live op dispatch, not an enrichment cache. */
export const ACCT_ALIAS_VALUES = [
  'invoice',
  'bill',
  'expense',
  'payment',
  'customer',
  'vendor',
  // `ledger_account` (NOT `account` — avoids the CRM `account` alias collision).
  // The underscore is intentional + consistent with the warehouse entity-id
  // convention (`normalizeEntityId` → `[a-z0-9_]`, so the acct identity
  // `acct_alias === entity_id` holds); the D-182 op-id parser admits `_` in an
  // operation segment (`OP_SEGMENT_RE`) so `core.acct.ledger_account.<verb>` is
  // addressable.
  'ledger_account',
] as const;
export type AcctAlias = (typeof ACCT_ALIAS_VALUES)[number];
const ACCT_ALIAS_SET: ReadonlySet<string> = new Set(ACCT_ALIAS_VALUES);

/** D-192 engagement facet — per-ENTITY capability class. `always` = the entity
 *  is emitted whenever the vendor is connected (HubSpot's 5; Salesforce
 *  task/event/email_message). `probe_gated` = surfaced only after a per-connection
 *  capability probe (Salesforce `describeSObjects`) confirms the SObject/stream
 *  exists — hidden until the probe lands, so the UI never shows a row that can
 *  never have `last_pulled_at`. Design: D-192. */
export const ENGAGEMENT_CAPABILITY_VALUES = ['always', 'probe_gated'] as const;
export type EngagementCapability = (typeof ENGAGEMENT_CAPABILITY_VALUES)[number];
const ENGAGEMENT_CAPABILITY_SET: ReadonlySet<string> = new Set(ENGAGEMENT_CAPABILITY_VALUES);

/** D-192 engagement facet — per-VENDOR sync class (all of a vendor's engagement
 *  entities share it; the registry validator enforces consistency). `poll` =
 *  REST re-list (HubSpot, + webhook accel); `stream` = a push feed (Salesforce
 *  CometD PushTopic); `delta_cursor` = incremental change-tracking / delta token
 *  (Microsoft Dynamics OData `$deltatoken`). Shared code that today branches
 *  `vendor==='salesforce'` for the CometD streaming / relationship / reprobe UI
 *  reads `engagementSyncKind(vendor) === 'stream'`; the reconcile MECHANISM stays
 *  in the per-vendor leaf. */
export const ENGAGEMENT_SYNC_KINDS = ['poll', 'delta_cursor', 'stream'] as const;
export type EngagementSyncKind = (typeof ENGAGEMENT_SYNC_KINDS)[number];
const ENGAGEMENT_SYNC_KIND_SET: ReadonlySet<string> = new Set(ENGAGEMENT_SYNC_KINDS);

/** D-192 engagement facet on a `ConnectionVendorEntity`. Marks the entity as a
 *  CRM engagement/activity (email / meeting / call / task / …) — a THIRD
 *  entity-category alongside `crm_alias` (deal/contact/account) and `acct_alias`
 *  (invoice/…), mutually exclusive with both (an entity is exactly one). Lets a
 *  pack-declared CRM's engagement plane light up (reconcile / health / coverage /
 *  score) with no code edit: shared logic reads `liveVendorRegistry.filter(e =>
 *  e.engagement)` instead of the closed `EngagementVendor` union. Design:
 *  D-192. */
export interface EngagementEntityFacet {
  /** Always-present vs capability-probe-gated (Salesforce voice_call/call_history). */
  capability: EngagementCapability;
  /** Mutually-exclusive alternatives — at most ONE member surfaces per
   *  connection (the capability-winner). Generalizes Salesforce's
   *  voice_call XOR call_history pick (both `exclusive_group: 'call'` +
   *  `capability: 'probe_gated'`). Absent = not exclusive. */
  exclusive_group?: string;
  /** How this vendor's engagement plane syncs (per-vendor-consistent). */
  sync_kind: EngagementSyncKind;
  /** Per-vendor daily API-call budget for the engagement reconciler (HubSpot
   *  250k, Salesforce 50k). Optional — a vendor without a declared budget falls
   *  back to the store's default. Positive integer when present. */
  daily_budget?: number;
}

/** A registered `(vendor, entity)` entry. */
export interface ConnectionVendorEntity {
  /** Vendor segment of the platform-reference scope. Lowercase
   *  identifier (`hubspot`, `salesforce`, `linear`). */
  vendor: string;
  /** Entity segment (`deal`, `opportunity`, `issue`). Lowercase
   *  identifier; same regex as vendor. */
  entity: string;
  /** Canonical scope string `connection.api.<vendor>.<entity>`.
   *  Stamped at registration time via `composeVendorEntityScope` so
   *  callers don't have to compose it themselves; the assertion
   *  validator verifies it matches the vendor + entity components. */
  scope: `connection.api.${string}.${string}`;
  /** Human-readable label for the Memory tab (Phase 5) and validator
   *  error messages. ASCII alphanumeric + spaces; arbitrary length. */
  display_name: string;
  /** Closed list of meta-fields the snapshot carries. Validator gates
   *  resolver `meta.<field>` lookups against this list (Phase 5). */
  meta_fields: ReadonlyArray<ConnectionVendorEntityMetaField>;
  /** D-130 P7 — cross-vendor logical CRM entity name. When present,
   *  the entity participates in the `data.crm.<crm_alias>.*` resolver:
   *  e.g. `hubspot.deal` + `salesforce.opportunity` both carry
   *  `crm_alias: 'deal'`, so a recipe addressing
   *  `data.crm.deal.<full_target_id>.enrichments.<topic>` dispatches
   *  to either vendor based on the target_id prefix. Omit for non-CRM
   *  vendors (Linear, Notion, Jira). */
  crm_alias?: CrmAlias;
  /** SMB-finance wedge slice 5b — cross-vendor logical ACCOUNTING entity name.
   *  When present, the entity is reachable through a canonical accounting op-step
   *  (`invoice.search`) that the install resolver dispatches to whichever vendor
   *  (QuickBooks / Xero) the bound connection is. IDENTITY mapping — `acct_alias`
   *  equals `entity` on every vendor (invoice → invoice). Lifted onto the
   *  per-install registry from a by-value accounting pack's composition
   *  `entity_fields[].acct_alias` (`vendorEntitiesFromComposition`). Mutually
   *  exclusive with `crm_alias` (an entity is CRM-canonical OR accounting-canonical,
   *  never both). Omit for non-accounting entities. */
  acct_alias?: AcctAlias;
  /** D-192 — engagement facet. When present, this is a CRM engagement/activity
   *  entity (email / meeting / call / task / event / …), the source of a
   *  contact's engagement evidence. Mutually exclusive with `crm_alias` +
   *  `acct_alias` (a third entity category). Omit for non-engagement entities. */
  engagement?: EngagementEntityFacet;
}

// ────────────────────────────────────────────────────────────────
// Validator infrastructure (declared above the registry initializer)
// ────────────────────────────────────────────────────────────────

const IDENTIFIER_REGEX = /^[a-z][a-z0-9_]*$/;
const META_FIELD_KEY_REGEX = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const META_FIELD_TYPES: ReadonlySet<ConnectionVendorEntityMetaFieldType> = new Set([
  'string', 'number', 'string[]', 'date_ms', 'object',
]);

/** D-192 — validate an `EngagementEntityFacet` object's SHAPE (capability /
 *  sync_kind / exclusive_group / daily_budget). Returns issue strings prefixed
 *  by `engagement.` (empty when well-formed). Shared by
 *  `assertConnectionVendorEntityShape` (registry entries) AND
 *  `assertEntitySchemaIngredientShape` (pack-authored entity schemas, S4), so a
 *  pack's engagement declaration is gated byte-for-byte like a built-in's.
 *
 *  Does NOT check mutual-exclusivity with `crm_alias`/`acct_alias` — that is an
 *  ENTITY-level invariant each caller enforces over its own alias fields (the
 *  facet in isolation carries no alias to compare). The per-VENDOR cross-entry
 *  invariants (one sync_kind / one daily_budget / uniform group capability)
 *  stay in `assertConnectionVendorRegistry` (they span entries, not one facet). */
export function assertEngagementFacetShape(g: unknown): string[] {
  if (g === null || typeof g !== 'object' || Array.isArray(g)) {
    return ["field 'engagement' must be an object when present"];
  }
  const issues: string[] = [];
  const facet = g as Record<string, unknown>;
  if (typeof facet.capability !== 'string' || !ENGAGEMENT_CAPABILITY_SET.has(facet.capability)) {
    issues.push(
      `engagement.capability must be one of ${[...ENGAGEMENT_CAPABILITY_VALUES].join(' / ')} (got ${JSON.stringify(facet.capability)})`,
    );
  }
  if (typeof facet.sync_kind !== 'string' || !ENGAGEMENT_SYNC_KIND_SET.has(facet.sync_kind)) {
    issues.push(
      `engagement.sync_kind must be one of ${[...ENGAGEMENT_SYNC_KINDS].join(' / ')} (got ${JSON.stringify(facet.sync_kind)})`,
    );
  }
  if (facet.exclusive_group !== undefined
      && (typeof facet.exclusive_group !== 'string' || facet.exclusive_group.length === 0)) {
    issues.push('engagement.exclusive_group must be a non-empty string when present');
  }
  // A pick-one group is only meaningful for probe-gated alternatives — an
  // always-present entity is unconditionally surfaced, so it can't be one of a
  // mutually-exclusive set.
  if (facet.exclusive_group !== undefined && facet.capability === 'always') {
    issues.push(
      "engagement.exclusive_group requires capability 'probe_gated' — an always-present entity is not a pick-one alternative",
    );
  }
  if (facet.daily_budget !== undefined
      && (typeof facet.daily_budget !== 'number' || !Number.isInteger(facet.daily_budget) || facet.daily_budget <= 0)) {
    issues.push('engagement.daily_budget must be a positive integer when present');
  }
  return issues;
}

/** Strict shape validator. Vendor Ds run this on their entries before
 *  registering — catches typos in vendor / entity names, scope-vs-
 *  components mismatches, malformed meta_field declarations.
 *
 *  Returns an array of issue strings (empty when the entry is well-
 *  formed). Vendor Ds throw on non-empty arrays so misconfiguration
 *  surfaces at boot, not at first webhook delivery. */
export function assertConnectionVendorEntityShape(
  entry: unknown,
): string[] {
  const issues: string[] = [];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return ['expected object'];
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.vendor !== 'string' || !IDENTIFIER_REGEX.test(e.vendor)) {
    issues.push(`field 'vendor' must match ${IDENTIFIER_REGEX.source}`);
  }
  if (typeof e.entity !== 'string' || !IDENTIFIER_REGEX.test(e.entity)) {
    issues.push(`field 'entity' must match ${IDENTIFIER_REGEX.source}`);
  }
  if (typeof e.display_name !== 'string' || e.display_name.length === 0) {
    issues.push("field 'display_name' must be a non-empty string");
  }

  if (typeof e.scope !== 'string') {
    issues.push("field 'scope' must be a string");
  } else if (!isPlatformReferenceScope(e.scope)) {
    issues.push("field 'scope' must match 'connection.api.<vendor>.<entity>'");
  } else if (typeof e.vendor === 'string' && typeof e.entity === 'string') {
    const expectedScope = `connection.api.${e.vendor}.${e.entity}`;
    if (e.scope !== expectedScope) {
      issues.push(
        `field 'scope' (${e.scope}) does not match composeVendorEntityScope(vendor, entity) = '${expectedScope}'`,
      );
    }
  }

  if (e.crm_alias !== undefined) {
    if (typeof e.crm_alias !== 'string' || !CRM_ALIAS_SET.has(e.crm_alias)) {
      issues.push(
        `field 'crm_alias' must be one of ${[...CRM_ALIAS_VALUES].join(' / ')} when present (got ${JSON.stringify(e.crm_alias)})`,
      );
    }
  }

  if (e.acct_alias !== undefined) {
    if (typeof e.acct_alias !== 'string' || !ACCT_ALIAS_SET.has(e.acct_alias)) {
      issues.push(
        `field 'acct_alias' must be one of ${[...ACCT_ALIAS_VALUES].join(' / ')} when present (got ${JSON.stringify(e.acct_alias)})`,
      );
    }
    if (e.crm_alias !== undefined) {
      issues.push(
        "fields 'crm_alias' and 'acct_alias' are mutually exclusive — an entity is CRM-canonical or accounting-canonical, not both",
      );
    }
  }

  if (e.engagement !== undefined) {
    for (const i of assertEngagementFacetShape(e.engagement)) issues.push(i);
    // A third entity category — an entity is CRM-canonical, accounting-canonical,
    // OR an engagement, never more than one.
    if (e.crm_alias !== undefined || e.acct_alias !== undefined) {
      issues.push(
        "field 'engagement' is mutually exclusive with 'crm_alias' / 'acct_alias' — an entity is exactly one category",
      );
    }
  }

  if (!Array.isArray(e.meta_fields)) {
    issues.push("field 'meta_fields' must be an array");
  } else {
    const seen = new Set<string>();
    e.meta_fields.forEach((raw, idx) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push(`meta_fields[${idx}] must be an object`);
        return;
      }
      const f = raw as Record<string, unknown>;
      if (typeof f.key !== 'string' || !META_FIELD_KEY_REGEX.test(f.key)) {
        issues.push(`meta_fields[${idx}].key must match ${META_FIELD_KEY_REGEX.source}`);
      } else if (seen.has(f.key)) {
        issues.push(`meta_fields[${idx}].key '${f.key}' duplicates an earlier entry`);
      } else {
        seen.add(f.key);
      }
      if (typeof f.type !== 'string'
          || !META_FIELD_TYPES.has(f.type as ConnectionVendorEntityMetaFieldType)) {
        issues.push(
          `meta_fields[${idx}].type must be one of ${[...META_FIELD_TYPES].join(' / ')}`,
        );
      }
      if (typeof f.description !== 'string' || f.description.length === 0) {
        issues.push(`meta_fields[${idx}].description must be a non-empty string`);
      }
      // Connection-agnostic op dispatch (slice 2) — `source_path` is optional
      // (DERIVED fields omit it), but when present must be a non-empty string.
      if (f.source_path !== undefined
          && (typeof f.source_path !== 'string' || f.source_path.length === 0)) {
        issues.push(`meta_fields[${idx}].source_path must be a non-empty string when present`);
      }
      // A COMPUTED canonical field carries a `derivation` instead of a
      // `source_path` (the G3 lift). They are mutually exclusive; when present
      // the kind must be known and the input paths non-empty.
      if (f.derivation !== undefined) {
        if (f.source_path !== undefined) {
          issues.push(`meta_fields[${idx}] declares both source_path and derivation (mutually exclusive)`);
        }
        if (f.derivation === null || typeof f.derivation !== 'object' || Array.isArray(f.derivation)) {
          issues.push(`meta_fields[${idx}].derivation must be an object`);
        } else {
          const d = f.derivation as Record<string, unknown>;
          if (typeof d.kind !== 'string' || !FIELD_DERIVATION_KINDS.has(d.kind)) {
            issues.push(`meta_fields[${idx}].derivation.kind must be one of ${[...FIELD_DERIVATION_KINDS].join(' / ')}`);
          } else if (d.kind === 'closed_state') {
            if (typeof d.closed_path !== 'string' || d.closed_path.length === 0) {
              issues.push(`meta_fields[${idx}].derivation.closed_path must be a non-empty string`);
            }
            if (typeof d.won_path !== 'string' || d.won_path.length === 0) {
              issues.push(`meta_fields[${idx}].derivation.won_path must be a non-empty string`);
            }
          } else if (d.kind === 'concat') {
            if (!Array.isArray(d.parts) || d.parts.length === 0
              || !d.parts.every((p) => typeof p === 'string' && p.length > 0)) {
              issues.push(`meta_fields[${idx}].derivation.parts must be a non-empty array of non-empty strings`);
            }
            if (d.separator !== undefined && typeof d.separator !== 'string') {
              issues.push(`meta_fields[${idx}].derivation.separator must be a string when present`);
            }
            if (d.fallback_path !== undefined && (typeof d.fallback_path !== 'string' || d.fallback_path.length === 0)) {
              issues.push(`meta_fields[${idx}].derivation.fallback_path must be a non-empty string when present`);
            }
            if (d.fallback_transform !== undefined && d.fallback_transform !== 'local_part') {
              issues.push(`meta_fields[${idx}].derivation.fallback_transform must be 'local_part' when present`);
            }
            if (d.fallback_transform !== undefined && d.fallback_path === undefined) {
              issues.push(`meta_fields[${idx}].derivation.fallback_transform requires fallback_path`);
            }
          }
        }
      }
      // G2 request-side datetime filter — `date_granularity` is optional, but when
      // present must be `date` | `datetime` and only meaningful on a `date_ms`
      // field (it drives the vendor date literal; a non-date field can't be a date).
      if (f.date_granularity !== undefined) {
        if (!isDateGranularity(f.date_granularity)) {
          issues.push(`meta_fields[${idx}].date_granularity must be 'date' or 'datetime' when present`);
        } else if (f.type !== 'date_ms') {
          issues.push(`meta_fields[${idx}].date_granularity is only valid on a 'date_ms' field (got type '${String(f.type)}')`);
        }
      }
    });
  }

  return issues;
}

/** Convenience — assert shape + throw on issues. Vendor Ds wire this
 *  on registration so misconfiguration surfaces at boot. Pure shape
 *  check — collisions across entries (duplicate scope) are the
 *  registry-level concern, not this function's. */
export function assertConnectionVendorEntityValid(
  entry: ConnectionVendorEntity,
): void {
  const issues = assertConnectionVendorEntityShape(entry);
  if (issues.length > 0) {
    throw new Error(
      `invalid ConnectionVendorEntity for '${entry.vendor}.${entry.entity}': ${issues.join('; ')}`,
    );
  }
}

/** Build a registered entry from raw vendor + entity + meta_fields.
 *  Stamps `scope` via `composeVendorEntityScope` and validates the
 *  shape at construction time. Vendor Ds use this to guarantee every
 *  entry passes the shape check.
 *
 *  D-130 P7 — `crm_alias` lifts the entity into the cross-vendor
 *  `data.crm.<crm_alias>.*` resolver. CRM-flavored entities (deal /
 *  contact / account / opportunity / company) carry one of
 *  `CRM_ALIAS_VALUES`; non-CRM entities omit and never appear under
 *  `data.crm.*`. */
export function buildConnectionVendorEntity(input: {
  vendor: string;
  entity: string;
  display_name: string;
  meta_fields: ReadonlyArray<ConnectionVendorEntityMetaField>;
  crm_alias?: CrmAlias;
  /** D-192 — mark this a CRM engagement/activity entity. Mutually exclusive
   *  with `crm_alias` (the validator enforces it). */
  engagement?: EngagementEntityFacet;
}): ConnectionVendorEntity {
  const scope = composeVendorEntityScope(input.vendor, input.entity);
  const entry: ConnectionVendorEntity = {
    vendor: input.vendor,
    entity: input.entity,
    scope,
    display_name: input.display_name,
    meta_fields: input.meta_fields,
    ...(input.crm_alias === undefined ? {} : { crm_alias: input.crm_alias }),
    ...(input.engagement === undefined ? {} : { engagement: input.engagement }),
  };
  assertConnectionVendorEntityValid(entry);
  return entry;
}

/** D-192 — the ENGAGEMENT cross-entry invariants of
 *  `assertConnectionVendorRegistry`, extracted so the pack-lift merge
 *  (`liveVendorRegistry` / the install `thirdPartyRegistryMerge`) can gate a
 *  pack's lifted engagement entities on JUST these, WITHOUT the per-entry
 *  vendor-id regex check the full assert also runs — that regex
 *  (`IDENTIFIER_REGEX`, no hyphens) rejects the hyphenated vendor ids the
 *  decomposer legitimately emits (`google-contacts`), so the full assert cannot
 *  run on lifted entities. Checks, per VENDOR:
 *    - all engagement entities share ONE `sync_kind` (first-match
 *      `engagementSyncKind` reads the first — a split makes it arbitrary);
 *    - all that declare a `daily_budget` share ONE (same reason,
 *      `engagementDailyBudget`);
 *    - each `exclusive_group` is uniformly `always` OR `probe_gated` (the surface
 *      picks one winner within a probe-gated group).
 *  Reads only a WELL-SHAPED facet (a bad capability/sync_kind is a per-entry
 *  shape issue the caller surfaces separately via `assertEngagementFacetShape`).
 *  Returns issues (empty when clean). */
export function assertEngagementRegistryInvariants(
  registry: ReadonlyArray<ConnectionVendorEntity>,
): string[] {
  const issues: string[] = [];
  // vendor → (first sync_kind, its idx); (vendor, exclusive_group) → (first
  // capability, its idx); vendor → (first daily_budget, its idx).
  const syncKindByVendor = new Map<string, { kind: EngagementSyncKind; idx: number }>();
  const groupCapability = new Map<string, { capability: EngagementCapability; idx: number }>();
  const budgetByVendor = new Map<string, { budget: number; idx: number }>();
  registry.forEach((entry, idx) => {
    const g = entry.engagement;
    if (g === undefined || !ENGAGEMENT_SYNC_KIND_SET.has(g.sync_kind)) return;
    const priorSync = syncKindByVendor.get(entry.vendor);
    if (priorSync === undefined) {
      syncKindByVendor.set(entry.vendor, { kind: g.sync_kind, idx });
    } else if (priorSync.kind !== g.sync_kind) {
      issues.push(
        `[${idx}] vendor '${entry.vendor}' engagement entity declares sync_kind '${g.sync_kind}' but entry [${priorSync.idx}] declared '${priorSync.kind}' — a vendor's engagement entities must share ONE sync_kind`,
      );
    }
    if (g.exclusive_group !== undefined && ENGAGEMENT_CAPABILITY_SET.has(g.capability)) {
      const key = `${entry.vendor} ${g.exclusive_group}`;
      const priorCap = groupCapability.get(key);
      if (priorCap === undefined) {
        groupCapability.set(key, { capability: g.capability, idx });
      } else if (priorCap.capability !== g.capability) {
        issues.push(
          `[${idx}] engagement exclusive_group '${g.exclusive_group}' (vendor '${entry.vendor}') mixes capability '${g.capability}' with '${priorCap.capability}' at entry [${priorCap.idx}] — a group must be uniformly always OR probe_gated`,
        );
      }
    }
    if (g.daily_budget !== undefined && typeof g.daily_budget === 'number') {
      const priorBudget = budgetByVendor.get(entry.vendor);
      if (priorBudget === undefined) {
        budgetByVendor.set(entry.vendor, { budget: g.daily_budget, idx });
      } else if (priorBudget.budget !== g.daily_budget) {
        issues.push(
          `[${idx}] vendor '${entry.vendor}' engagement daily_budget ${g.daily_budget} conflicts with ${priorBudget.budget} at entry [${priorBudget.idx}] — a vendor's engagement entities must share ONE daily_budget`,
        );
      }
    }
  });
  return issues;
}

/** Intentionally exposed for the validator + Memory tab — duplicate-
 *  scope checks across the registry are caught here, not in the
 *  per-entry shape validator. Returns issues; empty when clean.
 *
 *  D-130 P7 — also catches within-vendor `crm_alias` collisions:
 *  `hubspot.deal.crm_alias = 'deal'` + a hypothetical
 *  `hubspot.opportunity.crm_alias = 'deal'` is a bug because the
 *  cross-vendor resolver would have no way to disambiguate which
 *  HubSpot entity to dispatch to. Cross-vendor collision is the
 *  intended shape (`hubspot.deal` + `salesforce.opportunity` both
 *  carry `'deal'` so the resolver dispatches by target_id prefix). */
export function assertConnectionVendorRegistry(
  registry: ReadonlyArray<ConnectionVendorEntity>,
): string[] {
  const issues: string[] = [];
  const seen = new Set<EnrichmentScope>();
  // Per-vendor crm_alias bookkeeping: vendor → (crm_alias → first idx).
  const aliasByVendor = new Map<string, Map<CrmAlias, number>>();
  registry.forEach((entry, idx) => {
    const entryIssues = assertConnectionVendorEntityShape(entry);
    for (const i of entryIssues) issues.push(`[${idx}] ${i}`);
    if (seen.has(entry.scope)) {
      issues.push(`[${idx}] duplicate scope '${entry.scope}' — only one entry per (vendor, entity) allowed`);
    } else {
      seen.add(entry.scope);
    }
    if (entry.crm_alias !== undefined && CRM_ALIAS_SET.has(entry.crm_alias)) {
      let perVendor = aliasByVendor.get(entry.vendor);
      if (perVendor === undefined) {
        perVendor = new Map();
        aliasByVendor.set(entry.vendor, perVendor);
      }
      const earlier = perVendor.get(entry.crm_alias);
      if (earlier !== undefined) {
        issues.push(
          `[${idx}] vendor '${entry.vendor}' already declares crm_alias '${entry.crm_alias}' at entry [${earlier}] — within a single vendor, each crm_alias may appear at most once (cross-vendor collision is allowed and intended)`,
        );
      } else {
        perVendor.set(entry.crm_alias, idx);
      }
    }
  });
  // D-192 engagement cross-entry invariants — extracted so the pack-lift merge
  // (`liveVendorRegistry` / `thirdPartyRegistryMerge`) reuses the SAME rules
  // without the per-entry vendor-id regex the loop above runs (which rejects the
  // hyphenated pack vendor ids the decomposer emits). Appended after the
  // scope/crm_alias issues; each still carries its `[idx]` anchor.
  for (const i of assertEngagementRegistryInvariants(registry)) issues.push(i);
  return issues;
}

// ────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────

/** D-129 — vendor-entity registry. P2 lands `hubspot.deal`; P3 + P4
 *  stack `hubspot.contact` + `hubspot.company`. D-130 (Salesforce)
 *  appends Opportunity / Contact / Account / Lead. Long-tail vendors
 *  arrive post-launch via the certified-vendor program — see
 *  decisions-log §D-128 §8. */
export const CONNECTION_VENDOR_ENTITIES: ReadonlyArray<ConnectionVendorEntity> = [
  buildConnectionVendorEntity({
    vendor: 'hubspot',
    entity: 'deal',
    display_name: 'HubSpot Deal',
    crm_alias: 'deal',
    meta_fields: [
      // R2 step 6 — canonical record id on the RESPONSE side. The request
      // side already treats `id` as the canonical record selector
      // (WRITE_SELECTOR_KEY: read/update/delete take `args.id`); without a
      // response-side `id` a canonical find-then-act (§1.3 — search locates,
      // the write targets `{{step.<find>.0.id}}`) was not expressible.
      // HubSpot rows carry the id top-level on both search + read shapes.
      { key: 'id', type: 'string', source_path: 'properties.hs_object_id', description: 'vendor record id via the hs_object_id property mirror (a pure property name keeps the search body.properties list valid; the canonical record selector for read/update/delete)' },
      { key: 'name', type: 'string', source_path: 'properties.dealname', description: 'dealname' },
      { key: 'stage', type: 'string', source_path: 'properties.dealstage', description: 'dealstage (canonical or pipeline-specific id)' },
      { key: 'amount', type: 'number', source_path: 'properties.amount', description: 'amount in deal currency' },
      { key: 'owner', type: 'string', source_path: 'properties.hubspot_owner_id', description: 'hubspot_owner_id (resolved to email when granted)' },
      { key: 'pipeline', type: 'string', source_path: 'properties.pipeline', description: 'pipeline id deal lives in' },
      { key: 'key_dates.close_date', type: 'date_ms', date_granularity: 'date', source_path: 'properties.closedate', description: 'closedate' },
      { key: 'key_dates.created_at', type: 'date_ms', date_granularity: 'datetime', source_path: 'properties.createdate', description: 'createdate' },
      // The next/last-activity key-dates + description / next_step / priority below are
      // populated on the OP paths — deal.read (catalog static_query already requests
      // their source props) + deal.search (properties derived from these source_paths).
      // The housekeeping enrichment reconciler now carries them too:
      // HUBSPOT_DEAL_PROPERTIES requests all five source props and deal-reconciler's
      // projectDealMeta maps them into the meta snapshot. description / hs_next_step /
      // hs_priority also participate in computeDealHash (semantic changes refresh meta +
      // fire a cascade); the two activity timestamps are projected but excluded from the
      // hash (mirror contact.recent_activity_at — a logged-touch bump shouldn't cascade).
      // The op paths project the full `description`; the bounded meta snapshot (8 KB cap)
      // clamps it to 1024 chars so one verbose deal can't overflow + wedge the cursor.
      // next_step gained its Salesforce parity row (`NextStep`) in D-192 F1 — the
      // commitment-evidence capture producer reads the canonical key on both vendors.
      { key: 'key_dates.next_activity_at', type: 'date_ms', date_granularity: 'datetime', source_path: 'properties.notes_next_activity_date', description: 'notes_next_activity_date — the deal\'s scheduled next-activity timestamp (same key-date family as close_date/created_at)' },
      { key: 'key_dates.last_activity_at', type: 'date_ms', date_granularity: 'datetime', source_path: 'properties.notes_last_contacted', description: 'notes_last_contacted — the deal\'s most-recent logged-activity timestamp' },
      { key: 'forecast_amount', type: 'number', source_path: 'properties.hs_forecast_amount', description: 'hs_forecast_amount when set' },
      { key: 'description', type: 'string', source_path: 'properties.description', description: 'free-text deal description' },
      { key: 'next_step', type: 'string', source_path: 'properties.hs_next_step', description: 'hs_next_step — the rep-authored next-step note' },
      { key: 'priority', type: 'string', source_path: 'properties.hs_priority', description: 'hs_priority (HubSpot-managed priority label)' },
      // PROJECTED tri-state computed from the hs_is_closed* flags (closed_state derivation).
      { key: 'close_state', type: 'string', description: '"open" | "won" | "lost" derived from hs_is_closed* flags', derivation: { kind: 'closed_state', closed_path: 'properties.hs_is_closed', won_path: 'properties.hs_is_closed_won' } },
    ],
  }),
  buildConnectionVendorEntity({
    vendor: 'hubspot',
    entity: 'contact',
    display_name: 'HubSpot Contact',
    crm_alias: 'contact',
    meta_fields: [
      // email stays FIRST — the canonical join key position is spec-pinned
      // (D-129 P3 / D-130 P3); the canonical record id rides second.
      { key: 'email', type: 'string', source_path: 'properties.email', description: 'canonical email — primary join key against data.contact.<email>' },
      { key: 'id', type: 'string', source_path: 'properties.hs_object_id', description: 'vendor record id via the hs_object_id property mirror (a pure property name keeps the search body.properties list valid; the canonical record selector for read/update/delete)' },
      // DERIVED — firstname + lastname concatenated with email-local-part fallback (G3, read-only).
      { key: 'name', type: 'string', description: 'firstname + lastname (space-joined); falls back to the email local-part when both absent', derivation: { kind: 'concat', parts: ['properties.firstname', 'properties.lastname'], separator: ' ', fallback_path: 'properties.email', fallback_transform: 'local_part' } },
      // PROJECTABLE name parts — the direct vendor fields a `name` concat is built FROM.
      // Unlike the derived `name` (no source → not op-step-projectable), these are plain
      // HubSpot properties, so a `contact.read`/`search` op-step projects them; PII-tagged
      // `name` in canonical-pii-schemas.ts. (D-167 / vendor-reader→canonical retirement.)
      { key: 'first_name', type: 'string', source_path: 'properties.firstname', description: 'firstname (given name)' },
      { key: 'last_name', type: 'string', source_path: 'properties.lastname', description: 'lastname (family name)' },
      { key: 'lifecycle_stage', type: 'string', source_path: 'properties.lifecyclestage', description: 'lifecyclestage (subscriber / lead / mql / sql / opportunity / customer / evangelist / other)' },
      { key: 'owner', type: 'string', source_path: 'properties.hubspot_owner_id', description: 'hubspot_owner_id (resolved to email when granted)' },
      { key: 'account_id', type: 'string', source_path: 'properties.associatedcompanyid', description: 'associatedcompanyid (links to hubspot.company target_id; canonical account link — cross-vendor with salesforce.contact.account_id)' },
      { key: 'recent_activity_at', type: 'date_ms', date_granularity: 'datetime', source_path: 'properties.notes_last_contacted', description: 'notes_last_contacted (last touch timestamp)' },
      // D-138 P1 — predicate-match identity fields
      { key: 'phone', type: 'string', source_path: 'properties.phone', description: 'phone (canonicalized E.164 at projection time)' },
      // DERIVED — structured object assembled from multiple address fields (G3, read-only).
      { key: 'mailing_address', type: 'object', description: 'structured mailing address (address1/address2/city/state/zip/country)' },
      { key: 'company', type: 'string', source_path: 'properties.company', description: 'company (HubSpot contact-level company-string property; distinct from associatedcompanyid)' },
    ],
  }),
  buildConnectionVendorEntity({
    vendor: 'hubspot',
    entity: 'company',
    display_name: 'HubSpot Company',
    crm_alias: 'account',
    meta_fields: [
      { key: 'id', type: 'string', source_path: 'properties.hs_object_id', description: 'vendor record id via the hs_object_id property mirror (a pure property name keeps the search body.properties list valid; the canonical record selector for read/update/delete)' },
      { key: 'name', type: 'string', source_path: 'properties.name', description: 'company name' },
      { key: 'domain', type: 'string', source_path: 'properties.domain', description: 'primary website domain' },
      { key: 'industry', type: 'string', source_path: 'properties.industry', description: 'industry tag (HubSpot-managed taxonomy)' },
      { key: 'num_employees', type: 'number', source_path: 'properties.numberofemployees', description: 'numberofemployees' },
      { key: 'owner', type: 'string', source_path: 'properties.hubspot_owner_id', description: 'hubspot_owner_id (resolved to email when granted)' },
      { key: 'annual_revenue', type: 'number', source_path: 'properties.annualrevenue', description: 'annualrevenue when set' },
    ],
  }),
  // D-139 P1a.1 — HubSpot email engagement. Per-type registration
  // matches HubSpot's REST shape one-to-one (no unified
  // hubspot.engagement). `crm_alias` deliberately omitted —
  // engagements are NOT in the closed crm_alias enum
  // (`'deal' | 'contact' | 'account'`); cross-vendor unification
  // happens at the topic layer (`engagement_velocity_signal`
  // valid_scopes), not the entity layer. See
  // D-139 § A.1 + § A.5.5 (Deal Identity Asymmetry
  // Invariant).
  buildConnectionVendorEntity({
    vendor: 'hubspot',
    entity: 'email',
    display_name: 'HubSpot Email Engagement',
    engagement: { capability: 'always', sync_kind: 'poll', daily_budget: 250000 },
    meta_fields: [
      { key: 'subject', type: 'string', description: 'hs_email_subject' },
      { key: 'direction', type: 'string', description: '"INCOMING_EMAIL" | "FORWARDED_EMAIL" | "EMAIL"' },
      { key: 'from_email', type: 'string', description: 'hs_email_from_email (canonical lowercase + trimmed)' },
      { key: 'to_emails', type: 'string[]', description: 'hs_email_to_email split + canonicalized' },
      { key: 'cc_emails', type: 'string[]', description: 'hs_email_cc_email split + canonicalized' },
      { key: 'timestamp', type: 'date_ms', description: 'hs_timestamp — engagement timeline time; promotes to row.event_at only when hs_email_status = "SENT" per § A.3.1' },
      { key: 'status', type: 'string', description: 'hs_email_status — closed list per HubSpot ("SCHEDULED" / "SENDING" / "SENT" / "FAILED" / "BOUNCED"); drives lifecycle_state per § A.3.6' },
      { key: 'message_id', type: 'string', description: 'RFC822 Message-ID for mail-twin matching when present' },
      { key: 'thread_id', type: 'string', description: 'hs_email_thread_id' },
      { key: 'body_preview', type: 'string', description: 'first 256 chars of body (display)' },
      { key: 'owner', type: 'string', description: 'hubspot_owner_id (resolved to email when granted)' },
    ],
  }),
  // D-139 P1a.2 — HubSpot meeting engagement. State machine
  // 'scheduled' (start_time future) → 'completed' (start_time past +
  // outcome populated) | 'cancelled' (hs_meeting_outcome=CANCELED) |
  // 'rescheduled' (start_time pushed forward; flips back to
  // 'scheduled' with new start_time). event_at NULL while upcoming;
  // populated to start_time once past per § A.3.1. Direction derived
  // from attendee-set internal-domain analysis per § A.3.3.
  // calendar-twin matcher emits engagement_edges.target_kind =
  // 'data.calendar' when the meeting matches a local calendar event.
  buildConnectionVendorEntity({
    vendor: 'hubspot',
    entity: 'meeting',
    display_name: 'HubSpot Meeting Engagement',
    engagement: { capability: 'always', sync_kind: 'poll', daily_budget: 250000 },
    meta_fields: [
      { key: 'title', type: 'string', description: 'hs_meeting_title' },
      { key: 'start_time', type: 'date_ms', description: 'hs_meeting_start_time — always populated; promotes to row.scheduled_start_at; promotes to row.event_at only when start_time ≤ now per § A.3.1' },
      { key: 'end_time', type: 'date_ms', description: 'hs_meeting_end_time' },
      { key: 'outcome', type: 'string', description: 'hs_meeting_outcome — "SCHEDULED" / "COMPLETED" / "CANCELED" / "RESCHEDULED" / "NO_SHOW"; drives lifecycle_state per § A.3.6' },
      { key: 'location', type: 'string', description: 'hs_meeting_location' },
      { key: 'external_url', type: 'string', description: 'hs_meeting_external_url — calendar-event URL when available; drives calendar-twin matcher per § A.3 body-state machine' },
      { key: 'attendee_emails', type: 'string[]', description: 'attendee email list (canonical) — drives direction internal-domain analysis per § A.3.3' },
      { key: 'owner', type: 'string', description: 'hubspot_owner_id (resolved to email when granted)' },
    ],
  }),
  // D-139 P1a.2 — HubSpot note engagement. Always 'point_in_time'
  // lifecycle per § A.3.6 (notes are timestamped at creation; no
  // scheduled-vs-completed distinction). Direction always 'unknown'
  // per § A.3.3 (notes don't carry direction in HubSpot's data model).
  buildConnectionVendorEntity({
    vendor: 'hubspot',
    entity: 'note',
    display_name: 'HubSpot Note Engagement',
    engagement: { capability: 'always', sync_kind: 'poll', daily_budget: 250000 },
    meta_fields: [
      { key: 'body_preview', type: 'string', description: 'first 256 chars of hs_note_body (display)' },
      { key: 'created_at', type: 'date_ms', description: 'hs_createdate — promotes to row.event_at per § A.3.1 (notes are point-in-time; created = happened)' },
      { key: 'owner', type: 'string', description: 'hubspot_owner_id (resolved to email when granted)' },
    ],
  }),
  // D-139 P1a.2 — HubSpot call engagement. Lifecycle per § A.3.6
  // Pass-5 R5.4: hs_call_status drives state — QUEUED/IN_PROGRESS →
  // 'pending'; COMPLETED → 'point_in_time'; NO_ANSWER → 'no_answer';
  // FAILED/CANCELED → 'failed'/'cancelled'. Direction from
  // hs_call_direction per § A.3.3.
  buildConnectionVendorEntity({
    vendor: 'hubspot',
    entity: 'call',
    display_name: 'HubSpot Call Engagement',
    engagement: { capability: 'always', sync_kind: 'poll', daily_budget: 250000 },
    meta_fields: [
      { key: 'title', type: 'string', description: 'hs_call_title' },
      { key: 'direction', type: 'string', description: 'hs_call_direction — "INBOUND" / "OUTBOUND"' },
      { key: 'status', type: 'string', description: 'hs_call_status — "QUEUED" / "IN_PROGRESS" / "COMPLETED" / "NO_ANSWER" / "FAILED" / "CANCELED"; drives lifecycle_state per § A.3.6 Pass-5 R5.4' },
      { key: 'duration_ms', type: 'number', description: 'hs_call_duration (milliseconds)' },
      { key: 'disposition', type: 'string', description: 'hs_call_disposition' },
      { key: 'recording_url', type: 'string', description: 'hs_call_recording_url when present' },
      { key: 'timestamp', type: 'date_ms', description: 'hs_timestamp — promotes to row.event_at when status indicates the attempt occurred (COMPLETED / NO_ANSWER) per § A.3.1' },
      { key: 'body_preview', type: 'string', description: 'first 256 chars of hs_call_body (call notes)' },
      { key: 'owner', type: 'string', description: 'hubspot_owner_id (resolved to email when granted)' },
    ],
  }),
  // D-139 P1a.2 — HubSpot task engagement. State machine 'pending'
  // (status not Completed/Cancelled) → 'completed' (status COMPLETED;
  // completed_at populated) | 'cancelled' (status DEFERRED/CANCELED).
  // event_at NULL while pending; populated to completed_at when
  // completed per § A.3.1. due_at_is_date_only set when due-date
  // arrives as date-only string ("2026-05-04") per § A.3.7 (local-day
  // interval, not midnight UTC). Direction derived from subject-verb
  // heuristic per § A.3.3.
  buildConnectionVendorEntity({
    vendor: 'hubspot',
    entity: 'task',
    display_name: 'HubSpot Task Engagement',
    engagement: { capability: 'always', sync_kind: 'poll', daily_budget: 250000 },
    meta_fields: [
      { key: 'subject', type: 'string', description: 'hs_task_subject — drives direction subject-verb heuristic per § A.3.3' },
      { key: 'status', type: 'string', description: 'hs_task_status — "NOT_STARTED" / "IN_PROGRESS" / "WAITING" / "COMPLETED" / "DEFERRED" / "CANCELED"; drives lifecycle_state per § A.3.6' },
      { key: 'priority', type: 'string', description: 'hs_task_priority — "LOW" / "MEDIUM" / "HIGH"' },
      { key: 'type', type: 'string', description: 'hs_task_type — "TODO" / "CALL" / "EMAIL"' },
      { key: 'due_at', type: 'date_ms', description: 'hs_task_completion_date interpreted as due-date (HubSpot legacy field naming); promotes to row.due_at + due_at_is_date_only when arriving as date-only string per § A.3.7' },
      { key: 'completed_at', type: 'date_ms', description: 'hs_task_completion_date when status=COMPLETED; promotes to row.completed_at + row.event_at per § A.3.1' },
      { key: 'body_preview', type: 'string', description: 'first 256 chars of hs_task_body (task notes)' },
      { key: 'owner', type: 'string', description: 'hubspot_owner_id (resolved to email when granted)' },
    ],
  }),
  buildConnectionVendorEntity({
    vendor: 'salesforce',
    entity: 'opportunity',
    display_name: 'Salesforce Opportunity',
    crm_alias: 'deal',
    meta_fields: [
      { key: 'id', type: 'string', source_path: 'Id', description: 'vendor record Id (the canonical record selector for read/update/delete; rides the SOQL SELECT)' },
      { key: 'name', type: 'string', source_path: 'Name', description: 'Name field on Opportunity' },
      { key: 'stage', type: 'string', source_path: 'StageName', description: 'StageName (canonical Salesforce stage label)' },
      { key: 'amount', type: 'number', source_path: 'Amount', description: 'Amount in opportunity currency' },
      { key: 'owner', type: 'string', source_path: 'OwnerId', description: 'OwnerId (resolved to email when User read permission granted)' },
      { key: 'key_dates.close_date', type: 'date_ms', date_granularity: 'date', source_path: 'CloseDate', description: 'CloseDate (parsed ISO → ms)' },
      { key: 'key_dates.created_at', type: 'date_ms', date_granularity: 'datetime', source_path: 'CreatedDate', description: 'CreatedDate (parsed ISO → ms)' },
      { key: 'forecast_amount', type: 'number', source_path: 'ForecastAmount', description: 'ForecastAmount when surfaced (omitted otherwise)' },
      // PROJECTED tri-state computed from IsClosed + IsWon (closed_state derivation).
      { key: 'close_state', type: 'string', description: '"open" | "won" | "lost" derived from IsClosed + IsWon', derivation: { kind: 'closed_state', closed_path: 'IsClosed', won_path: 'IsWon' } },
      { key: 'probability', type: 'number', source_path: 'Probability', description: 'Probability percentage 0-100' },
      // D-192 F1 — the SF parity row for the canonical next_step key (the hb D5
      // cluster above). Standard Opportunity field `NextStep` (Text 255) — joins
      // SALESFORCE_OPPORTUNITY_FIELDS (SOQL SELECT) + computeOpportunityHash so a
      // rep-authored next-step edit re-folds the deal and fires the cascade the
      // commitment-evidence capture producer subscribes to.
      { key: 'next_step', type: 'string', source_path: 'NextStep', description: 'NextStep — the rep-authored next-step note' },
    ],
  }),
  buildConnectionVendorEntity({
    vendor: 'salesforce',
    entity: 'contact',
    display_name: 'Salesforce Contact',
    crm_alias: 'contact',
    meta_fields: [
      // email stays FIRST — the canonical join key position is spec-pinned
      // (D-129 P3 / D-130 P3); the canonical record id rides second.
      { key: 'email', type: 'string', source_path: 'Email', description: 'canonical email (lowercase + trimmed) — primary join key against data.contact.<email>' },
      { key: 'id', type: 'string', source_path: 'Id', description: 'vendor record Id (the canonical record selector for read/update/delete; rides the SOQL SELECT)' },
      // DERIVED — FirstName + LastName concatenated with email-local-part fallback (G3, read-only).
      { key: 'name', type: 'string', description: 'FirstName + LastName (space-joined); falls back to the email local-part when both absent', derivation: { kind: 'concat', parts: ['FirstName', 'LastName'], separator: ' ', fallback_path: 'Email', fallback_transform: 'local_part' } },
      // PROJECTABLE name parts — the direct vendor fields a `name` concat is built FROM
      // (Salesforce Contact exposes FirstName / LastName as flat SOQL fields). Op-step
      // projectable, unlike the derived `name`; PII-tagged in canonical-pii-schemas.ts.
      { key: 'first_name', type: 'string', source_path: 'FirstName', description: 'FirstName (given name)' },
      { key: 'last_name', type: 'string', source_path: 'LastName', description: 'LastName (family name)' },
      { key: 'lifecycle_stage', type: 'string', source_path: 'LeadSource', description: 'LeadSource (Salesforce native model — Web / Phone Inquiry / Partner Referral / etc.)' },
      { key: 'owner', type: 'string', source_path: 'OwnerId', description: 'OwnerId (resolved to email when User read permission granted)' },
      { key: 'account_id', type: 'string', source_path: 'AccountId', description: 'AccountId — links to salesforce.account target_id' },
      { key: 'recent_activity_at', type: 'date_ms', date_granularity: 'date', source_path: 'LastActivityDate', description: 'LastActivityDate (parsed ISO → ms)' },
      // D-138 P1 — predicate-match identity fields
      { key: 'phone', type: 'string', source_path: 'Phone', description: 'Phone (canonicalized E.164 at projection time)' },
      // DERIVED — structured object assembled from MailingStreet/City/State/PostalCode/Country (G3, read-only).
      { key: 'mailing_address', type: 'object', description: 'structured mailing address from MailingStreet/City/State/PostalCode/Country' },
    ],
  }),
  buildConnectionVendorEntity({
    vendor: 'salesforce',
    entity: 'account',
    display_name: 'Salesforce Account',
    crm_alias: 'account',
    meta_fields: [
      { key: 'id', type: 'string', source_path: 'Id', description: 'vendor record Id (the canonical record selector for read/update/delete; rides the SOQL SELECT)' },
      { key: 'name', type: 'string', source_path: 'Name', description: 'Name field on Account' },
      { key: 'domain', type: 'string', source_path: 'Website', description: 'Website (primary domain — freeform; not canonicalized at projection; canonical account web-domain — cross-vendor with hubspot.company.domain)' },
      { key: 'industry', type: 'string', source_path: 'Industry', description: 'Industry tag (Salesforce standard taxonomy)' },
      { key: 'num_employees', type: 'number', source_path: 'NumberOfEmployees', description: 'NumberOfEmployees' },
      { key: 'owner', type: 'string', source_path: 'OwnerId', description: 'OwnerId (resolved to email when User read permission granted)' },
      { key: 'annual_revenue', type: 'number', source_path: 'AnnualRevenue', description: 'AnnualRevenue when set' },
    ],
  }),
  buildConnectionVendorEntity({
    vendor: 'pipedrive',
    entity: 'deal',
    display_name: 'Pipedrive Deal',
    crm_alias: 'deal',
    meta_fields: [
      { key: 'id', type: 'number', source_path: 'id', description: 'Pipedrive deal id (the canonical record selector for read/update/delete)' },
      { key: 'name', type: 'string', source_path: 'title', description: 'Deal title' },
      { key: 'stage', type: 'string', source_path: 'stage_id', description: 'Pipedrive stage id' },
      { key: 'amount', type: 'number', source_path: 'value', description: 'Deal value' },
      { key: 'owner', type: 'string', source_path: 'owner_id', description: 'Pipedrive owner id' },
      { key: 'pipeline', type: 'string', source_path: 'pipeline_id', description: 'Pipedrive pipeline id' },
      { key: 'account_id', type: 'string', source_path: 'org_id', description: 'Linked Pipedrive organization id' },
      { key: 'contact_id', type: 'string', source_path: 'person_id', description: 'Linked Pipedrive person id' },
      { key: 'key_dates.close_date', type: 'date_ms', date_granularity: 'date', source_path: 'expected_close_date', description: 'Expected close date' },
      { key: 'key_dates.created_at', type: 'date_ms', date_granularity: 'datetime', source_path: 'add_time', description: 'Deal creation time' },
      { key: 'updated_at', type: 'date_ms', date_granularity: 'datetime', source_path: 'update_time', description: 'Deal update time; request filters lower to updated_since / updated_until' },
      { key: 'close_state', type: 'string', source_path: 'status', description: 'Pipedrive status ("open" | "won" | "lost")' },
      { key: 'probability', type: 'number', source_path: 'probability', description: 'Deal probability percentage when set' },
    ],
  }),
  buildConnectionVendorEntity({
    vendor: 'pipedrive',
    entity: 'person',
    display_name: 'Pipedrive Person',
    crm_alias: 'contact',
    meta_fields: [
      { key: 'id', type: 'number', source_path: 'id', description: 'Pipedrive person id (the canonical record selector for read/update/delete)' },
      { key: 'name', type: 'string', source_path: 'name', description: 'Person display name' },
      { key: 'first_name', type: 'string', source_path: 'first_name', description: 'First name' },
      { key: 'last_name', type: 'string', source_path: 'last_name', description: 'Last name' },
      { key: 'owner', type: 'string', source_path: 'owner_id', description: 'Pipedrive owner id' },
      { key: 'account_id', type: 'string', source_path: 'org_id', description: 'Linked Pipedrive organization id' },
      { key: 'email', type: 'string', source_path: 'emails.0.value', description: 'First email value returned by Pipedrive' },
      { key: 'phone', type: 'string', source_path: 'phones.0.value', description: 'First phone value returned by Pipedrive' },
      { key: 'recent_activity_at', type: 'date_ms', date_granularity: 'datetime', source_path: 'update_time', description: 'Person update time used as the best available activity freshness marker' },
      { key: 'updated_at', type: 'date_ms', date_granularity: 'datetime', source_path: 'update_time', description: 'Person update time; request filters lower to updated_since / updated_until' },
    ],
  }),
  buildConnectionVendorEntity({
    vendor: 'pipedrive',
    entity: 'organization',
    display_name: 'Pipedrive Organization',
    crm_alias: 'account',
    meta_fields: [
      { key: 'id', type: 'number', source_path: 'id', description: 'Pipedrive organization id (the canonical record selector for read/update/delete)' },
      { key: 'name', type: 'string', source_path: 'name', description: 'Organization name' },
      { key: 'domain', type: 'string', source_path: 'website', description: 'Organization website' },
      { key: 'industry', type: 'string', source_path: 'industry', description: 'Industry tag when set' },
      { key: 'num_employees', type: 'number', source_path: 'employee_count', description: 'Employee count when set' },
      { key: 'owner', type: 'string', source_path: 'owner_id', description: 'Pipedrive owner id' },
      { key: 'annual_revenue', type: 'number', source_path: 'annual_revenue', description: 'Annual revenue when set' },
      { key: 'updated_at', type: 'date_ms', date_granularity: 'datetime', source_path: 'update_time', description: 'Organization update time; request filters lower to updated_since / updated_until' },
    ],
  }),
  // D-139 P1b — Salesforce Task engagement. State machine
  // 'pending' (Status not Completed/Cancelled) → 'completed'
  // (Status=Completed; CompletedDateTime populated) | 'cancelled'
  // (Status=Cancelled). event_at NULL while pending; promotes to
  // CompletedDateTime when completed per § A.3.1. due_at = ActivityDate
  // (date-only — flagged via due_at_is_date_only per § A.3.7).
  // Direction derived from subject-verb heuristic per § A.3.3 (shared
  // with HubSpot tasks). `crm_alias` deliberately omitted — engagements
  // are NOT in the closed crm_alias enum.
  buildConnectionVendorEntity({
    vendor: 'salesforce',
    entity: 'task',
    display_name: 'Salesforce Task',
    engagement: { capability: 'always', sync_kind: 'stream', daily_budget: 50000 },
    meta_fields: [
      { key: 'subject', type: 'string', description: 'Subject — drives direction subject-verb heuristic per § A.3.3' },
      { key: 'status', type: 'string', description: 'Status — Salesforce closed-list (NotStarted / InProgress / Completed / Waiting / Cancelled / Deferred); drives lifecycle_state per § A.3.6' },
      { key: 'priority', type: 'string', description: 'Priority — closed-list (High / Normal / Low)' },
      { key: 'task_type', type: 'string', description: 'TaskSubtype — Salesforce standard taxonomy' },
      { key: 'due_at', type: 'date_ms', description: 'ActivityDate parsed as local-day-interval start with due_at_is_date_only per § A.3.7' },
      { key: 'completed_at', type: 'date_ms', description: 'CompletedDateTime when Status=Completed; promotes to row.completed_at + row.event_at per § A.3.1' },
      { key: 'owner', type: 'string', description: 'OwnerId (resolved to email when User read permission granted)' },
      { key: 'who_id', type: 'string', description: 'WhoId — single-pointer fallback when TaskRelation unavailable (Contact / Lead id)' },
      { key: 'what_id', type: 'string', description: 'WhatId — single-pointer fallback when TaskRelation unavailable (Account / Opportunity / etc. id)' },
    ],
  }),
  // D-139 P1b — Salesforce Event engagement. State machine
  // 'scheduled' (StartDateTime > now) → 'completed' (StartDateTime past)
  // | 'cancelled' (Status=Cancelled). event_at NULL while upcoming;
  // promotes to StartDateTime once past per § A.3.1. Direction derived
  // from attendee-set internal-domain analysis (via EventRelation when
  // available) per § A.3.3.
  buildConnectionVendorEntity({
    vendor: 'salesforce',
    entity: 'event',
    display_name: 'Salesforce Event',
    engagement: { capability: 'always', sync_kind: 'stream', daily_budget: 50000 },
    meta_fields: [
      { key: 'subject', type: 'string', description: 'Subject — display name' },
      { key: 'description', type: 'string', description: 'Description (truncated to 256 chars)' },
      { key: 'start_at', type: 'date_ms', description: 'StartDateTime — promotes to row.scheduled_start_at; promotes to row.event_at when in the past per § A.3.1' },
      { key: 'end_at', type: 'date_ms', description: 'EndDateTime' },
      { key: 'duration_minutes', type: 'number', description: 'DurationInMinutes' },
      { key: 'location', type: 'string', description: 'Location' },
      { key: 'is_all_day', type: 'string', description: 'IsAllDayEvent (true/false as string)' },
      { key: 'owner', type: 'string', description: 'OwnerId (resolved to email when User read permission granted)' },
      { key: 'who_id', type: 'string', description: 'WhoId — single-pointer fallback when EventRelation unavailable' },
      { key: 'what_id', type: 'string', description: 'WhatId — single-pointer fallback when EventRelation unavailable' },
    ],
  }),
  // D-139 P1b — Salesforce EmailMessage engagement. Always
  // 'point_in_time' lifecycle per § A.3.6. Direction from `Incoming`
  // boolean per § A.3.3. Body-state from MessageDate + body presence;
  // mail-twin matcher attempts MessageIdentifier (RFC822 Message-ID)
  // first → 'exact' confidence; from+to+sent_at triple fallback →
  // 'probable'. EmailMessageRelation drives multi-recipient fan-out
  // when available; ToAddress fallback parses comma-separated string.
  buildConnectionVendorEntity({
    vendor: 'salesforce',
    entity: 'email_message',
    display_name: 'Salesforce Email Message',
    engagement: { capability: 'always', sync_kind: 'stream', daily_budget: 50000 },
    meta_fields: [
      { key: 'subject', type: 'string', description: 'Subject' },
      { key: 'from_email', type: 'string', description: 'FromAddress (canonical lowercase + trimmed)' },
      { key: 'from_name', type: 'string', description: 'FromName (display name when present)' },
      { key: 'to_emails', type: 'string[]', description: 'ToAddress split + canonicalized' },
      { key: 'cc_emails', type: 'string[]', description: 'CcAddress split + canonicalized' },
      { key: 'message_date', type: 'date_ms', description: 'MessageDate (parsed ISO → ms) — promotes to row.event_at per § A.3.1' },
      { key: 'incoming', type: 'string', description: 'Incoming — "true" / "false" — drives direction per § A.3.3' },
      { key: 'has_attachment', type: 'string', description: 'HasAttachment — "true" / "false"' },
      { key: 'message_id', type: 'string', description: 'MessageIdentifier (RFC822 Message-ID for mail-twin matching when present)' },
      { key: 'thread_id', type: 'string', description: 'ThreadIdentifier' },
      { key: 'related_to_id', type: 'string', description: 'RelatedToId — single-pointer fallback when EmailMessageRelation unavailable' },
      { key: 'body_preview', type: 'string', description: 'first 256 chars of TextBody (display)' },
    ],
  }),
  // D-139 P1b — Salesforce VoiceCall engagement. Service Cloud
  // Voice — point_in_time lifecycle. Direction from CallType
  // ('INBOUND' / 'OUTBOUND') per § A.3.3. event_at = CallStartDateTime
  // per § A.3.1.
  buildConnectionVendorEntity({
    vendor: 'salesforce',
    entity: 'voice_call',
    display_name: 'Salesforce Voice Call',
    engagement: { capability: 'probe_gated', exclusive_group: 'call', sync_kind: 'stream', daily_budget: 50000 },
    meta_fields: [
      { key: 'call_subject', type: 'string', description: 'CallSubject' },
      { key: 'call_type', type: 'string', description: 'CallType — INBOUND / OUTBOUND / INTERNAL — drives direction per § A.3.3' },
      { key: 'call_disposition', type: 'string', description: 'CallDisposition' },
      { key: 'call_object', type: 'string', description: 'CallObject — vendor-specific call subtype' },
      { key: 'caller_number', type: 'string', description: 'CallerNumber' },
      { key: 'duration_seconds', type: 'number', description: 'CallDurationInSeconds' },
      { key: 'start_at', type: 'date_ms', description: 'CallStartDateTime — promotes to row.event_at per § A.3.1' },
      { key: 'end_at', type: 'date_ms', description: 'CallEndDateTime' },
      { key: 'owner', type: 'string', description: 'OwnerId (resolved to email when User read permission granted)' },
      { key: 'contact_id', type: 'string', description: 'ContactId — direct contact pointer when populated' },
      { key: 'account_id', type: 'string', description: 'AccountId — direct account pointer when populated' },
      { key: 'opportunity_id', type: 'string', description: 'OpportunityId — direct opportunity pointer when populated' },
    ],
  }),
  // D-139 P1b — Salesforce CallHistory engagement. Legacy Service
  // Cloud — schema-probed at enrollment per Pass-5 R5.11; orgs
  // without it skip registration silently. point_in_time lifecycle.
  buildConnectionVendorEntity({
    vendor: 'salesforce',
    entity: 'call_history',
    display_name: 'Salesforce Call History',
    engagement: { capability: 'probe_gated', exclusive_group: 'call', sync_kind: 'stream', daily_budget: 50000 },
    meta_fields: [
      { key: 'call_type', type: 'string', description: 'CallType — INBOUND / OUTBOUND' },
      { key: 'duration_seconds', type: 'number', description: 'CallDurationInSeconds' },
      { key: 'start_at', type: 'date_ms', description: 'CallStartDateTime — promotes to row.event_at per § A.3.1' },
      { key: 'owner', type: 'string', description: 'OwnerId (resolved to email when User read permission granted)' },
    ],
  }),
];

// ────────────────────────────────────────────────────────────────
// HubSpot canonical property lists (D-129)
// ────────────────────────────────────────────────────────────────

/** D-129 P2 — canonical HubSpot deal properties projected into `meta`
 *  snapshots and requested via `/crm/v3/objects/deals/search`'s
 *  `properties` body field. Per-portal custom property surfacing is
 *  post-launch (spec § Non-goals). One-to-one with the `meta_fields`
 *  declaration on the `hubspot.deal` entity above; the search helper
 *  copies the array verbatim into the request body.
 *
 *  The five `notes_next_activity_date` / `notes_last_contacted` /
 *  `description` / `hs_next_step` / `hs_priority` source props are the
 *  D5 deal-fold canonical extras (the `next_step` / `priority` /
 *  `description` recipes). The deal reconciler now projects all five
 *  into `meta`; `description` / `hs_next_step` / `hs_priority`
 *  participate in `computeDealHash` (semantic, rep-authored), while the
 *  two activity timestamps ride along like the contact reconciler's
 *  `recent_activity_at` — projected but excluded from the hash so a
 *  logged-activity bump alone doesn't force a meta refresh + cascade. */
export const HUBSPOT_DEAL_PROPERTIES = [
  'dealname',
  'dealstage',
  'amount',
  'closedate',
  'createdate',
  'hs_lastmodifieddate',
  'hubspot_owner_id',
  'pipeline',
  'hs_forecast_amount',
  'notes_next_activity_date',
  'notes_last_contacted',
  'description',
  'hs_next_step',
  'hs_priority',
  'hs_is_closed',
  'hs_is_closed_won',
  'hs_is_closed_lost',
] as const;

/** D-129 P3 — canonical HubSpot contact properties. `email` is the
 *  primary join key against Recued local `data.contact.<email>` (the
 *  load-bearing differentiator at P6's `engagement_score_per_contact`).
 *  `firstname` + `lastname` reconstitute `meta.name` with email-local-
 *  part fallback. `lifecyclestage` projects to `meta.lifecycle_stage`;
 *  `hubspot_owner_id` to `meta.owner`; `associatedcompanyid` to
 *  `meta.account_id`; `notes_last_contacted` to `meta.recent_activity_at`.
 *  `hs_lastmodifieddate` carries the cursor field — the search helper's
 *  filter + sort hard-code it, and `listUpdatedSince` reads it back to
 *  stamp `modified_at`. (Spec § Constants lists `lastmodifieddate`
 *  without the `hs_` prefix; deviating to `hs_lastmodifieddate` for
 *  symmetry with the deal reconciler — both legacy + modern names
 *  exist on contacts in HubSpot's API, but the search helper is
 *  hard-coded against `hs_lastmodifieddate`.) */
export const HUBSPOT_CONTACT_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'lifecyclestage',
  'hubspot_owner_id',
  'associatedcompanyid',
  'notes_last_contacted',
  'hs_lastmodifieddate',
  // D-138 P1 — predicate-match identity fields. Hash tuple widens
  // in lockstep so cascades fire on phone/address/company changes.
  // `company` is HubSpot's contact-level company-string property —
  // distinct from `associatedcompanyid` (which projects to the
  // associated `hubspot.company` record). Both can be present and
  // diverge; the contact-level `company` is what's typed against
  // the contact card itself.
  'phone',
  'address',
  'address2',
  'city',
  'state',
  'zip',
  'country',
  'company',
] as const;

/** D-139 P1a.1 — canonical HubSpot email-engagement properties. The
 *  search helper requests these via the `properties` body field on
 *  `POST /crm/v3/objects/emails/search`, projecting them into
 *  `RawHubSpotRecord.properties` for the reconciler's hash + meta
 *  projection.
 *
 *  HubSpot exposes email engagements through the v3 objects API at
 *  `/crm/v3/objects/emails`. The property names below are HubSpot's
 *  canonical wire names — `hs_email_*` prefixed; `hs_timestamp` is
 *  the engagement-timeline timestamp;
 *  `hs_lastmodifieddate` is the cursor field for delta scan. Per-
 *  portal custom property surfacing is post-launch (spec § Non-goals).
 *  Authorship-derivation fields:
 *    - `hubspot_owner_id` → `meta.owner` + drives `'user'` /
 *      `'crm_user'` derivation per § A.3.2
 *    - `hs_created_by_workflow_id` populated → `'crm_automation'`
 *    - `hs_created_via_workflow` populated → `'crm_automation'`
 *    - `hs_email_status IN ('OPENED', 'BOUNCED', 'UNSUBSCRIBED')`
 *      → `'system_process'` when no human-typed subject/body
 *  Direction-derivation field:
 *    - `hs_email_direction` → `'inbound'` / `'outbound'` per § A.3.3
 *  Lifecycle-derivation field:
 *    - `hs_email_status` → `'pending'` / `'point_in_time'` /
 *      `'failed'` per § A.3.6
 *  Mail-twin matching:
 *    - `hs_email_internet_message_id` → RFC822 `Message-ID` for
 *      `'exact'`-confidence twin matching against `data.mail`. */
export const HUBSPOT_EMAIL_PROPERTIES = [
  'hs_email_subject',
  'hs_email_text',
  'hs_email_html',
  'hs_email_direction',
  'hs_email_status',
  'hs_email_from_email',
  'hs_email_to_email',
  'hs_email_cc_email',
  'hs_email_internet_message_id',
  'hs_email_thread_id',
  'hs_timestamp',
  'hs_lastmodifieddate',
  'hs_createdate',
  'hubspot_owner_id',
  'hs_created_by_workflow_id',
  'hs_created_via_workflow',
  'hs_email_bounce_error_detail_message',
  'hs_email_bounce_error_detail_status_code',
  'hs_import_id',
] as const;

/** D-139 P1a.2 — canonical HubSpot meeting-engagement properties.
 *  Requested via `POST /crm/v3/objects/meetings/search`. Lifecycle is
 *  driven by `hs_meeting_outcome` (per § A.3.6) — the value
 *  `'RESCHEDULED'` plus a forward-pushed `hs_meeting_start_time` flips
 *  the row back to `'scheduled'` with `event_at = NULL`. The
 *  `hs_meeting_external_url` field carries the calendar-event URL
 *  (when the meeting was created against a connected calendar) and
 *  drives the calendar-twin matcher per § A.3 body-state machine. */
export const HUBSPOT_MEETING_PROPERTIES = [
  'hs_meeting_title',
  'hs_meeting_body',
  'hs_meeting_start_time',
  'hs_meeting_end_time',
  'hs_meeting_outcome',
  'hs_meeting_location',
  'hs_meeting_external_url',
  'hs_internal_meeting_notes',
  'hs_timestamp',
  'hs_lastmodifieddate',
  'hs_createdate',
  'hubspot_owner_id',
  'hs_created_by_workflow_id',
  'hs_created_via_workflow',
  'hs_import_id',
] as const;

/** D-139 P1a.2 — canonical HubSpot note-engagement properties.
 *  Notes are point-in-time per § A.3.6 and unknown-direction per
 *  § A.3.3 (no direction field in HubSpot's data model).
 *  `hs_createdate` promotes to `event_at` per § A.3.1. */
export const HUBSPOT_NOTE_PROPERTIES = [
  'hs_note_body',
  'hs_timestamp',
  'hs_lastmodifieddate',
  'hs_createdate',
  'hubspot_owner_id',
  'hs_created_by_workflow_id',
  'hs_created_via_workflow',
  'hs_import_id',
] as const;

/** D-139 P1a.2 — canonical HubSpot call-engagement properties.
 *  Lifecycle driven by `hs_call_status` (Pass-5 R5.4): QUEUED/
 *  IN_PROGRESS → 'pending'; COMPLETED → 'point_in_time'; NO_ANSWER
 *  → 'no_answer'; FAILED/CANCELED → 'failed'/'cancelled'.
 *  `hs_call_direction` drives direction per § A.3.3. */
export const HUBSPOT_CALL_PROPERTIES = [
  'hs_call_title',
  'hs_call_body',
  'hs_call_direction',
  'hs_call_status',
  'hs_call_duration',
  'hs_call_disposition',
  'hs_call_recording_url',
  'hs_call_from_number',
  'hs_call_to_number',
  'hs_timestamp',
  'hs_lastmodifieddate',
  'hs_createdate',
  'hubspot_owner_id',
  'hs_created_by_workflow_id',
  'hs_created_via_workflow',
  'hs_import_id',
] as const;

/** D-139 P1a.2 — canonical HubSpot task-engagement properties.
 *  State machine driven by `hs_task_status` per § A.3.6. The
 *  `hs_task_completion_date` field is HubSpot legacy: while task is
 *  incomplete it carries the *due-date*; once status flips to
 *  COMPLETED the same field carries the *completion timestamp*. The
 *  reconciler reads it both ways per § A.3.1. Date-only due dates
 *  surface as ISO-date strings (`'2026-05-04'`) per § A.3.7 and
 *  promote to `due_at_is_date_only: true`. Direction derived from
 *  the subject-verb heuristic per § A.3.3. */
export const HUBSPOT_TASK_PROPERTIES = [
  'hs_task_subject',
  'hs_task_body',
  'hs_task_status',
  'hs_task_priority',
  'hs_task_type',
  'hs_task_completion_date',
  'hs_timestamp',
  'hs_lastmodifieddate',
  'hs_createdate',
  'hubspot_owner_id',
  'hs_created_by_workflow_id',
  'hs_created_via_workflow',
  'hs_import_id',
] as const;

/** D-129 P4 — canonical HubSpot company properties. `name` / `domain`
 *  / `industry` are HubSpot's property names verbatim;
 *  `numberofemployees` + `annualrevenue` are HubSpot's one-word
 *  property names that project to snake_case `meta.num_employees` +
 *  `meta.annual_revenue`. `hubspot_owner_id` projects to `meta.owner`.
 *  `hs_lastmodifieddate` carries the cursor field — same convention as
 *  deal + contact. Per-portal custom property surfacing is post-launch
 *  (spec § Non-goals). */
export const HUBSPOT_COMPANY_PROPERTIES = [
  'name',
  'domain',
  'industry',
  'numberofemployees',
  'hubspot_owner_id',
  'annualrevenue',
  'hs_lastmodifieddate',
] as const;

// ────────────────────────────────────────────────────────────────
// Salesforce canonical SOQL field lists (D-130)
// ────────────────────────────────────────────────────────────────

/** D-130 P2 — canonical Salesforce Opportunity fields projected into
 *  the SOQL `SELECT` list and consumed by `projectOpportunityMeta`.
 *  `Id` is the platform-native record id (lands as `target_id` segment
 *  `salesforce_opportunity_<Id>`); `LastModifiedDate` carries the cursor
 *  field — the search helper builds `WHERE LastModifiedDate >= <iso>`
 *  filters off it and `listUpdatedSince` parses it back to ms to advance
 *  the cursor. `IsClosed` + `IsWon` together discriminate the
 *  `meta.close_state` three-state (`'open' | 'won' | 'lost'`) — same shape
 *  as HubSpot's `hs_is_closed_won` / `_lost` flags but expressed via
 *  Salesforce's two-boolean convention. Per-org custom field surfacing
 *  in `meta` is post-launch (spec § Non-goals). */
export const SALESFORCE_OPPORTUNITY_FIELDS = [
  'Id',
  'Name',
  'StageName',
  'Amount',
  'CloseDate',
  'CreatedDate',
  'LastModifiedDate',
  'OwnerId',
  'IsClosed',
  'IsWon',
  'ForecastCategory',
  'Probability',
  // D-192 F1 — rides the SELECT so the reconciler can project canonical
  // `meta.next_step` + hash it (the commitment-evidence capture field).
  'NextStep',
] as const;

/** D-130 P3 — canonical Salesforce Contact fields projected into the
 *  SOQL `SELECT` list and consumed by `projectContactMeta`. `Email` is
 *  the canonical join key against Recued local `data.contact.<email>`
 *  + the cross-source `engagement_score_per_contact` topic at P6 — the
 *  reconciler canonicalizes (lowercase + trim) at projection time so
 *  capitalised raw input never silently misses the join.
 *  `FirstName` + `LastName` reconstitute `meta.name` with email-local-
 *  part fallback. `LeadSource` projects to `meta.lifecycle_stage`
 *  (Salesforce's lead-attribution-as-stage convention; native model
 *  diverges from HubSpot's lifecycle ladder, which is why the topic
 *  splits into a `_salesforce`-suffixed parallel at P6 per spec § 11).
 *  `OwnerId` projects to `meta.owner`; `AccountId` projects to
 *  `meta.account_id` (links to `salesforce.account` target_id at P4).
 *  `LastActivityDate` projects to `meta.recent_activity_at` but is
 *  intentionally NOT in the canonical hash tuple — Salesforce bumps
 *  it on any logged activity (call / meeting / email open) including
 *  ones that don't change anything semantically interesting; including
 *  it would force a meta refresh + cascade event on every touch.
 *  `LastModifiedDate` carries the cursor field — the search helper's
 *  `WHERE` clause + `listUpdatedSince` cursor advance both read it.
 *  Per-org custom field surfacing in `meta` is post-launch (spec §
 *  Non-goals). */
export const SALESFORCE_CONTACT_FIELDS = [
  'Id',
  'Email',
  'FirstName',
  'LastName',
  'LeadSource',
  'OwnerId',
  'AccountId',
  'LastActivityDate',
  'LastModifiedDate',
  // D-138 P1 — predicate-match identity fields. Hash tuple widens
  // in lockstep so cascades fire on phone/address changes; company
  // is read indirectly via Account.Name (resolved at the SOQL layer
  // with a relationship traversal, not a flat field).
  'Phone',
  'MailingStreet',
  'MailingCity',
  'MailingState',
  'MailingPostalCode',
  'MailingCountry',
] as const;

/** D-130 P4 — canonical Salesforce Account fields projected into the
 *  SOQL `SELECT` list and consumed by `projectAccountMeta`. The simplest
 *  of the Sales Cloud trio — every canonical field participates in the
 *  hash. Unlike contact's `recent_activity_at`, there's no "activity"
 *  field that bumps independently of identity — `NumberOfEmployees` +
 *  `AnnualRevenue` changes ARE meaningful identity events for Recued's
 *  purposes (e.g. a 50→500 employee transition is exactly the kind of
 *  account-shape change downstream enrichments care about). Symmetric
 *  with HubSpot's company reconciler hash decision (D-129 P4).
 *  `LastModifiedDate` carries the cursor field — the search helper's
 *  `WHERE` clause + `listUpdatedSince` cursor advance both read it.
 *  Per-org custom field surfacing in `meta` is post-launch (spec §
 *  Non-goals). */
export const SALESFORCE_ACCOUNT_FIELDS = [
  'Id',
  'Name',
  'Website',
  'Industry',
  'NumberOfEmployees',
  'OwnerId',
  'AnnualRevenue',
  'LastModifiedDate',
] as const;

// ────────────────────────────────────────────────────────────────
// Lookup helpers
// ────────────────────────────────────────────────────────────────

/** Look up by canonical scope string. Returns `null` for closed-list
 *  scopes (mail / contact / calendar / file / connection.<kind>) +
 *  platform-reference scopes that no vendor D has registered yet. The
 *  validator surfaces `null` as `enrichment_scope_unsupported`. */
export const getVendorEntityForScope = (
  scope: EnrichmentScope,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): ConnectionVendorEntity | null => {
  if (!isPlatformReferenceScope(scope)) return null;
  for (const entry of registry) {
    if (entry.scope === scope) return entry;
  }
  return null;
};

/** Look up by `(vendor, entity)` pair — same view, saves the caller
 *  composing the scope. Returns null for unregistered combinations. */
export const getVendorEntityByVendorEntity = (
  vendor: string,
  entity: string,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): ConnectionVendorEntity | null => {
  for (const entry of registry) {
    if (entry.vendor === vendor && entry.entity === entity) return entry;
  }
  return null;
};

/** List every registered vendor for filter UI / Memory tab nav.
 *  Returns the vendor identifier list with duplicates collapsed,
 *  insertion order. */
export const listRegisteredVendors = (
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of registry) {
    if (seen.has(entry.vendor)) continue;
    seen.add(entry.vendor);
    out.push(entry.vendor);
  }
  return out;
};

/** D-130 P7 — lookup by `(vendor, crm_alias)`. The cross-vendor
 *  `data.crm.*` resolver dispatches by inspecting a target_id's
 *  vendor prefix, then asks this helper "given vendor X, which entity
 *  carries crm_alias Y?". Returns null when the vendor never registers
 *  the alias (a non-CRM vendor, or a CRM vendor that doesn't model
 *  this concept — e.g. a chat-only platform with `'contact'` but no
 *  `'deal'`). The within-vendor uniqueness invariant is enforced by
 *  `assertConnectionVendorRegistry`, so at most one match per
 *  `(vendor, alias)` pair exists. */
export const getVendorEntityByCrmAlias = (
  vendor: string,
  crmAlias: CrmAlias,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): ConnectionVendorEntity | null => {
  for (const entry of registry) {
    if (entry.vendor === vendor && entry.crm_alias === crmAlias) return entry;
  }
  return null;
};

/** D-192 — the `connection.api.<vendor>.<entity>` platform-reference scope
 *  strings for a `crm_alias`, across every vendor that models it. The
 *  declaration-driven replacement for hardcoding
 *  `['connection.api.hubspot.contact', '…salesforce.contact']`: a vendor
 *  declaring the alias (e.g. Pipedrive's `entity:'person'
 *  crm_alias:'contact'`) joins automatically, and a pack CRM joins when the
 *  LIVE merged registry (`liveVendorRegistry(...)`) is passed. Shared by the
 *  D-192 F1 deal-field capture producer + the E2b contact walk. */
export const scopesForCrmAlias = (
  crmAlias: CrmAlias,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): ReadonlySet<string> => {
  const scopes = new Set<string>();
  for (const entry of registry) {
    if (entry.crm_alias !== crmAlias) continue;
    scopes.add(`connection.api.${entry.vendor}.${entry.entity}`);
  }
  return scopes;
};

/** SMB-finance wedge slice 5b — the `acct_alias` sibling of
 *  `getVendorEntityByCrmAlias`. Resolve `(vendor, acct_alias)` → the registered
 *  accounting entity (identity mapping: the entity name equals the alias on every
 *  vendor, but the lookup still CONFIRMS the vendor models it before the resolver
 *  dispatches). Returns null when the vendor does not model the alias. */
export const getVendorEntityByAcctAlias = (
  vendor: string,
  acctAlias: AcctAlias,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): ConnectionVendorEntity | null => {
  for (const entry of registry) {
    if (entry.vendor === vendor && entry.acct_alias === acctAlias) return entry;
  }
  return null;
};

// ────────────────────────────────────────────────────────────────
// D-192 engagement facet accessors — the registry replacements for the closed
// EngagementVendor union + HUBSPOT/SALESFORCE_ENGAGEMENT_ENTITY_NAMES constants.
// Pass a LIVE registry (liveVendorRegistry) to include pack-declared vendors;
// the default reads the shipped builtins. Design: D-192.
// ────────────────────────────────────────────────────────────────

/** True when `(vendor, entity)` is a declared engagement/activity entity. */
export const isDeclaredEngagementEntity = (
  vendor: string,
  entity: string,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): boolean =>
  registry.some((e) => e.vendor === vendor && e.entity === entity && e.engagement !== undefined);

/** True when a vendor declares ANY engagement entity — the registry replacement
 *  for the closed `isEngagementVendor` union predicate. */
export const vendorHasEngagement = (
  vendor: string,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): boolean => registry.some((e) => e.vendor === vendor && e.engagement !== undefined);

/** Every engagement entity name a vendor declares (insertion order). The
 *  registry replacement for `HUBSPOT/SALESFORCE_ENGAGEMENT_ENTITY_NAMES`. Note
 *  this is the DECLARED superset — a probe-gated entity's presence in a live
 *  surface is decided by the capability probe, not this list. */
export const engagementEntitiesForVendor = (
  vendor: string,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): ReadonlyArray<string> =>
  registry.filter((e) => e.vendor === vendor && e.engagement !== undefined).map((e) => e.entity);

/** A vendor's engagement sync class (poll / delta_cursor / stream), read from
 *  its engagement entities — which the registry validator guarantees share one.
 *  `null` when the vendor declares no engagement entity. Shared code reads
 *  `=== 'stream'` where it once branched on the Salesforce vendor literal. */
export const engagementSyncKind = (
  vendor: string,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): EngagementSyncKind | null => {
  for (const e of registry) {
    if (e.vendor === vendor && e.engagement !== undefined) return e.engagement.sync_kind;
  }
  return null;
};

/** A vendor's declared daily engagement API-call budget, or `null` when no
 *  engagement entity declares one (the caller falls back to the store default). */
export const engagementDailyBudget = (
  vendor: string,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): number | null => {
  for (const e of registry) {
    if (e.vendor === vendor && e.engagement?.daily_budget !== undefined) {
      return e.engagement.daily_budget;
    }
  }
  return null;
};

/** Connection-agnostic op dispatch (slice 4) — the canonical field vocabulary
 *  for a `crm_alias`, the "convention's canonical field set" a CRM-conformant
 *  pack's `entity_fields[].maps_to` are validated against (authoring slice 4).
 *
 *  Derived FROM the registry — the union of every registered `crm_alias`-entity's
 *  `meta_fields[].key` (across all vendors that model the alias, so HubSpot-only
 *  `pipeline` and Salesforce-only `probability` are both canonical), PLUS the
 *  record-identity field `id`. `id` is the record `target_id`, not a registry
 *  `meta_field`, but it is the canonical identity a recipe references and the
 *  field the decomposer reads to build `target_id` — so a conformant pack maps
 *  its record id to `id` without tripping the portability check.
 *
 *  Registry-derived (not a hand-maintained constant) so the canonical vocabulary
 *  stays in lockstep with the shipped HubSpot/Salesforce `meta_fields`. A
 *  `maps_to` outside this set is a non-portable vendor extra (a recipe reading
 *  canonical fields won't see it) — the validator surfaces that as a warning, not
 *  an error (quality/portability, not safety). */
export const canonicalCrmFieldSet = (
  crmAlias: CrmAlias,
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): ReadonlySet<string> => {
  const fields = new Set<string>(['id']);
  for (const entry of registry) {
    if (entry.crm_alias !== crmAlias) continue;
    for (const field of entry.meta_fields) fields.add(field.key);
  }
  return fields;
};

// ────────────────────────────────────────────────────────────────
// D-190 Slice 3 — canonical CRM field schema (the missing contract)
// ────────────────────────────────────────────────────────────────

/** A canonical CRM field's accepted projection type — usually a single registry
 *  type; a small set ONLY where a field legitimately projects as more than one.
 *  The sole multi-type field today is the record selector `id`, which Pipedrive
 *  projects as `number` and HubSpot/Salesforce as `string` (D-190 fork C2 — the
 *  divergence is accepted, not coerced; `id` is a vendor-shaped selector). */
export type CanonicalCrmFieldType =
  | ConnectionVendorEntityMetaFieldType
  | readonly ConnectionVendorEntityMetaFieldType[];

/** One canonical CRM field's contract: its name, accepted projection type(s),
 *  whether a conformant entity MUST declare it, and a one-line description.
 *  D-190 Slice 3 formalizes the previously name-only `canonicalCrmFieldSet` into
 *  an AUTHORED, typed contract — so a registry/pack edit that diverges in TYPE (a
 *  future vendor mapping `amount` to a string) or omits a required field becomes a
 *  validation finding instead of a silent wart.
 *
 *  `enum_values` models a closed value set where one exists (D-190 Slice 2): today
 *  only `close_state` carries `['open','won','lost']`. The search resolver enforces
 *  it on a literal filter value (`close_state == 'success'` fails closed) and the
 *  describe surface (Slice 4) emits it so the AI filters only with a declared value. */
export interface CanonicalCrmField {
  /** Canonical key (a `maps_to` value); dotted for nested keys
   *  (`key_dates.close_date`), matching the registry `meta_field.key` form. */
  name: string;
  /** Accepted vendor projection type(s), in the registry
   *  `ConnectionVendorEntityMetaFieldType` vocabulary (a pack's `MetaFieldType`
   *  normalizes into it before comparison). */
  type: CanonicalCrmFieldType;
  /** A conformant entity for this alias SHOULD declare it — absence is a
   *  portability `warn`, never an authoring error (D-190 fork B-split). Set ONLY
   *  for fields every shipped vendor models, so the bundled registry conforms
   *  cleanly at boot (no missing-required noise). */
  required: boolean;
  description: string;
  /** D-190 Slice 2 — the closed set of accepted values for an ENUM-valued canonical
   *  field (today only `deal.close_state` → `'open' | 'won' | 'lost'`). Absent for a
   *  free-valued field. The search resolver enforces it on a LITERAL filter value
   *  (`connection-agnostic-search.ts`); the describe surface emits it to the AI. */
  enum_values?: readonly string[];
  /** **D-206 — the RELATIONSHIP declaration.** This field holds the VENDOR'S OWN ID
   *  of a record of `entity`. Present ⇒ the field is a REFERENCE, not an opaque
   *  string; absent ⇒ it is a plain value.
   *
   *  🔑 **This is the entire relationship substrate, and it stores NOTHING.** A
   *  vendor-asserted relationship is DECLARED and resolved at READ — never copied
   *  into a durable Recued edge, which would be a cache of the vendor's own foreign
   *  key and would drift (D-205 ruling 3: *Recued is not a cache of external
   *  systems*). The value is the vendor's record id — **stable and opaque** — so a
   *  read-time resolve is always correct and always fresh.
   *
   *  ⛔ **IDENTITY IS NOT A RELATIONSHIP, and must never be declared here.**
   *  `contact.email` is deliberately NOT a ref. `vendor.contact` and `data.contact`
   *  are not two entities in a relationship — they are the SAME PERSON in two
   *  planes, and that mapping hangs on a **MUTABLE** key (an email changes, merges,
   *  is promoted from a synthetic placeholder). It therefore needs a **durable,
   *  redirect-able link with a cascade** — which already exists
   *  (`contact_platform_link` / `ContactRecord.platform_ids`, auto-written by the
   *  contact Source sync). Declaring it as a read-time email join would re-introduce
   *  the exact bug D-205 spent an entire arc fixing.
   *
   *  🔑 **It is a BIDIRECTIONAL query contract, not just a forward pointer:**
   *   - **forward** — this deal's contact: `deal.meta.contact_id` → the vendor
   *     record (`crm_record_mirror`), and/or → the CORE contact
   *     (`contact_platform_link`, whose `platform_id` is the SAME raw vendor id).
   *   - **reverse** — this contact's deals: the contact's `platform_ids` → the
   *     vendor id → `json_extract(meta, '$.contact_id') = ?` over the deal mirror.
   *   - and it is the **INDEX HINT**: these are exactly the json paths the mirror
   *     must index, because `json_extract` on an unindexed path is a scan.
   *
   *  ⚠ **A reverse lookup must NOT go through `CrmRecordMirrorStore.list()`** — it is
   *  hard-capped at 200 (default 50), so *"Bob has 3 deals"* when he has 240: a
   *  confident number over a truncated set, which the model states to the user as
   *  fact. See D-206 §2.2c.
   *
   *  Spec: D-206 §2. */
  ref?: { entity: CrmAlias };
}

/** **D-206 — every declared RELATIONSHIP on a `crm_alias`'s canonical fields.**
 *
 *  The read side of the declaration: *"which of this entity's fields point at
 *  another entity, and at which one?"* A resolver reads THIS rather than hardcoding
 *  `'contact_id'`, so a relationship added to the schema lights up everywhere with
 *  no consumer change — which is the entire point of declaring it.
 *
 *  Returns `[]` for an alias with no declared relationships. ⛔ `contact.email` will
 *  never appear here: it is IDENTITY, not a relationship (see `CanonicalCrmField.ref`). */
export const crmRefFields = (
  alias: CrmAlias,
): ReadonlyArray<{ field: string; entity: CrmAlias }> =>
  CANONICAL_CRM_FIELD_SCHEMA[alias].flatMap((f) =>
    f.ref === undefined ? [] : [{ field: f.name, entity: f.ref.entity }],
  );

/** The closed, AUTHORED canonical CRM field vocabulary per `crm_alias` — the
 *  contract a CRM-conformant entity's `meta_fields` (registry) / a pack's
 *  `maps_to` (decompose) are validated against (D-190 Slice 3). Built bottom-up
 *  from the shipped HubSpot / Salesforce / Pipedrive `meta_fields` union, then
 *  FROZEN here as the contract so future drift (a new vendor's type divergence, a
 *  dropped core field) is caught against it rather than silently absorbed. Every
 *  `required` field is one EVERY current vendor models, so the registry boot check
 *  produces no missing-required noise; the conformance test guards completeness
 *  (every registry crm field has a schema entry). */
export const CANONICAL_CRM_FIELD_SCHEMA: Record<CrmAlias, ReadonlyArray<CanonicalCrmField>> = {
  deal: [
    { name: 'id', type: ['string', 'number'], required: true, description: 'Vendor record id — the canonical record selector. String on HubSpot/Salesforce, number on Pipedrive (D-190 C2).' },
    { name: 'name', type: 'string', required: true, description: 'Deal/opportunity title.' },
    { name: 'stage', type: 'string', required: true, description: 'Pipeline stage id (raw vendor stage).' },
    { name: 'amount', type: 'number', required: true, description: 'Deal value/amount.' },
    { name: 'owner', type: 'string', required: true, description: 'Owning user id.' },
    { name: 'close_state', type: 'string', required: true, enum_values: ['open', 'won', 'lost'], description: "Won/lost tri-state — 'open' | 'won' | 'lost' (D-190 Slice 2 rename of is_closed; enum-enforced on literal filters)." },
    { name: 'key_dates.close_date', type: 'date_ms', required: true, description: 'Expected/actual close date.' },
    { name: 'key_dates.created_at', type: 'date_ms', required: true, description: 'Record creation time.' },
    { name: 'pipeline', type: 'string', required: false, description: 'Pipeline id (HubSpot/Pipedrive; Salesforce has no pipeline entity).' },
    { name: 'probability', type: 'number', required: false, description: 'Win probability percentage (Salesforce/Pipedrive).' },
    { name: 'forecast_amount', type: 'number', required: false, description: 'Forecast amount (HubSpot/Salesforce).' },
    { name: 'key_dates.next_activity_at', type: 'date_ms', required: false, description: 'Next scheduled activity time (HubSpot).' },
    { name: 'key_dates.last_activity_at', type: 'date_ms', required: false, description: 'Last activity time (HubSpot).' },
    { name: 'description', type: 'string', required: false, description: 'Free-text description (HubSpot).' },
    { name: 'next_step', type: 'string', required: false, description: 'Next-step note (HubSpot).' },
    { name: 'priority', type: 'string', required: false, description: 'Priority (HubSpot).' },
    // D-206 — a RELATIONSHIP. Pipedrive models deal→org as a plain property (`org_id`);
    // HubSpot and Salesforce model it as an association, so they simply do not map this
    // field — and that ABSENCE is itself the declaration that they have no property route.
    { name: 'account_id', type: 'string', required: false, ref: { entity: 'account' }, description: 'Linked account/organization id (Pipedrive). D-206: a REFERENCE — holds the vendor’s own id of an `account`.' },
    // D-206 — a RELATIONSHIP, and the one that started this spec. Pipedrive holds the
    // deal→person FK as a plain property (`person_id`); HubSpot serves it from a separate
    // ASSOCIATION endpoint and Salesforce from the `OpportunityContactRole` junction, so
    // neither maps it here. ⇒ whether a relationship is a PROPERTY is PER VENDOR.
    { name: 'contact_id', type: 'string', required: false, ref: { entity: 'contact' }, description: 'Linked contact/person id (Pipedrive). D-206: a REFERENCE — holds the vendor’s own id of a `contact`, which is ALSO the key space of `ContactRecord.platform_ids[].platform_id`, so it resolves to the CORE contact in one hop.' },
    { name: 'updated_at', type: 'date_ms', required: false, description: 'Record update time (Pipedrive).' },
  ],
  contact: [
    { name: 'id', type: ['string', 'number'], required: true, description: 'Vendor record id — the canonical record selector. String on HubSpot/Salesforce, number on Pipedrive (D-190 C2).' },
    { name: 'name', type: 'string', required: true, description: 'Display name (first+last concat on HubSpot/Salesforce; native on Pipedrive).' },
    // ⛔ D-206 — DELIBERATELY **NOT** a `ref`, and do not "complete the set" by adding one.
    // `vendor.contact` and `data.contact` are not two entities in a relationship — they are
    // the SAME PERSON in two planes. That is IDENTITY, it hangs on a MUTABLE key (an email
    // changes / merges / is promoted from a synthetic), and it therefore needs a DURABLE,
    // redirect-able link with a cascade — which already exists (`contact_platform_link`).
    // A read-time email join would re-introduce the exact bug D-205 spent an arc fixing.
    { name: 'email', type: 'string', required: true, description: 'Primary email. ⛔ NOT a D-206 ref — identity, not a relationship (see the comment above).' },
    { name: 'owner', type: 'string', required: true, description: 'Owning user id.' },
    { name: 'first_name', type: 'string', required: false, description: 'First name.' },
    { name: 'last_name', type: 'string', required: false, description: 'Last name.' },
    { name: 'phone', type: 'string', required: false, description: 'Primary phone.' },
    // D-206 — a RELATIONSHIP (a contact WORKS AT an account; they are two different
    // things). All three built-in vendors model it as a plain property, so all three
    // light up from this ONE declaration: HubSpot `associatedcompanyid` · Salesforce
    // `AccountId` · Pipedrive `org_id`. Before D-206 this relationship existed only in
    // the human-readable `description` prose — the engine could not see it.
    { name: 'account_id', type: 'string', required: false, ref: { entity: 'account' }, description: 'Linked account/organization id. D-206: a REFERENCE — holds the vendor’s own id of an `account`.' },
    { name: 'recent_activity_at', type: 'date_ms', required: false, description: 'Most-recent activity time (Pipedrive uses update_time as a proxy).' },
    { name: 'lifecycle_stage', type: 'string', required: false, description: 'Lifecycle/lead stage (HubSpot/Salesforce; Salesforce approximates with LeadSource).' },
    { name: 'mailing_address', type: 'object', required: false, description: 'Structured mailing address (HubSpot/Salesforce; unprojected pending a compose derivation).' },
    { name: 'company', type: 'string', required: false, description: 'Company name string (HubSpot).' },
    { name: 'updated_at', type: 'date_ms', required: false, description: 'Record update time (Pipedrive).' },
  ],
  account: [
    { name: 'id', type: ['string', 'number'], required: true, description: 'Vendor record id — the canonical record selector. String on HubSpot/Salesforce, number on Pipedrive (D-190 C2).' },
    { name: 'name', type: 'string', required: true, description: 'Account/company/organization name.' },
    { name: 'owner', type: 'string', required: true, description: 'Owning user id.' },
    { name: 'domain', type: 'string', required: false, description: 'Primary web domain/website.' },
    { name: 'industry', type: 'string', required: false, description: 'Industry tag.' },
    { name: 'num_employees', type: 'number', required: false, description: 'Employee count.' },
    { name: 'annual_revenue', type: 'number', required: false, description: 'Annual revenue.' },
    { name: 'updated_at', type: 'date_ms', required: false, description: 'Record update time (Pipedrive).' },
  ],
};

/** Accepted types for a `CanonicalCrmField.type`, normalized to a set. */
const canonicalFieldAcceptedTypes = (
  t: CanonicalCrmFieldType,
): ReadonlySet<ConnectionVendorEntityMetaFieldType> =>
  new Set(Array.isArray(t) ? t : [t as ConnectionVendorEntityMetaFieldType]);

/** Look up a canonical field's contract by `(crm_alias, name)`; `undefined` if the
 *  name is not a canonical field for the alias. */
export const canonicalCrmField = (
  crmAlias: CrmAlias,
  name: string,
): CanonicalCrmField | undefined =>
  CANONICAL_CRM_FIELD_SCHEMA[crmAlias].find((f) => f.name === name);

/** Whether `type` (registry vocabulary) conforms to the canonical field's declared
 *  type(s). A name NOT in the schema is not type-governed → `true` (the caller
 *  emits the separate non-canonical portability warning). */
export const crmFieldTypeConforms = (
  crmAlias: CrmAlias,
  name: string,
  type: ConnectionVendorEntityMetaFieldType,
): boolean => {
  const field = canonicalCrmField(crmAlias, name);
  return field === undefined || canonicalFieldAcceptedTypes(field.type).has(type);
};

/** Human-readable accepted-type list for a canonical field (validator messages). */
export const canonicalCrmFieldTypeLabel = (crmAlias: CrmAlias, name: string): string => {
  const field = canonicalCrmField(crmAlias, name);
  return field === undefined ? '' : [...canonicalFieldAcceptedTypes(field.type)].join(' | ');
};

/** The required canonical field names for an alias (absence → portability warn). */
export const requiredCanonicalCrmFields = (crmAlias: CrmAlias): ReadonlySet<string> =>
  new Set(CANONICAL_CRM_FIELD_SCHEMA[crmAlias].filter((f) => f.required).map((f) => f.name));

/** Registry-side canonical conformance for ONE entity (D-190 Slice 3). Splits by
 *  severity (fork B-split): a TYPE divergence on a canonical field is an ERROR;
 *  a missing required field is a WARNING. A registry field absent from the schema
 *  (coverage gap) is surfaced as an error too — the first-party schema must cover
 *  every shipped canonical field. A non-CRM entity (no `crm_alias`) yields nothing. */
export const crmEntityConformanceIssues = (
  entry: ConnectionVendorEntity,
): { errors: string[]; warnings: string[] } => {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (entry.crm_alias === undefined || !CRM_ALIAS_SET.has(entry.crm_alias)) {
    return { errors, warnings };
  }
  const alias = entry.crm_alias as CrmAlias;
  const present = new Set<string>();
  for (const field of entry.meta_fields) {
    present.add(field.key);
    const schemaField = canonicalCrmField(alias, field.key);
    if (schemaField === undefined) {
      errors.push(
        `${entry.vendor}.${entry.entity}: canonical field '${field.key}' is absent from CANONICAL_CRM_FIELD_SCHEMA['${alias}'] — add it to the schema (D-190 Slice 3)`,
      );
      continue;
    }
    if (!canonicalFieldAcceptedTypes(schemaField.type).has(field.type)) {
      const accepted = [...canonicalFieldAcceptedTypes(schemaField.type)].join(' | ');
      errors.push(
        `${entry.vendor}.${entry.entity}: canonical field '${field.key}' has type '${field.type}', schema accepts: ${accepted}`,
      );
    }
  }
  for (const req of requiredCanonicalCrmFields(alias)) {
    if (!present.has(req)) {
      warnings.push(`${entry.vendor}.${entry.entity}: required canonical field '${req}' is not declared`);
    }
  }
  return { errors, warnings };
};

// ────────────────────────────────────────────────────────────────
// Boot validation
// ────────────────────────────────────────────────────────────────

// Defensive: verify the bundled registry is well-formed at module
// load. Catches a bad future edit that pushes a malformed entry.
// D-129 P7 — the alias-prefix clash check runs from the bottom of
// `connection-vendor-aliases.ts` (after the reserved-set const has
// initialised), since pulling the helper in here would create a
// module-init cycle: aliases.ts imports CONNECTION_VENDOR_ENTITIES,
// connection-vendors.ts would import the helper, and the helper's
// default reserved-set parameter would be read before its `const`
// binding finished initialising.
const _bootIssues = assertConnectionVendorRegistry(CONNECTION_VENDOR_ENTITIES);
if (_bootIssues.length > 0) {
  throw new Error(`CONNECTION_VENDOR_ENTITIES boot validation failed: ${_bootIssues.join('; ')}`);
}

// D-190 Slice 3 — canonical CRM field conformance. A TYPE divergence on a shipped
// canonical field (or a registry field with no schema entry) is a hard boot
// failure: the bundled registry is the contract's reference conformer, so a
// future edit that breaks the canonical type contract fails fast. Missing-required
// is a WARN (fork B-split), never thrown — `required` ⊆ the universally-modeled
// fields, so it stays empty for the bundled registry (the conformance test guards).
const _crmConformanceErrors = CONNECTION_VENDOR_ENTITIES.flatMap(
  (entry) => crmEntityConformanceIssues(entry).errors,
);
if (_crmConformanceErrors.length > 0) {
  throw new Error(`CANONICAL_CRM_FIELD_SCHEMA conformance failed: ${_crmConformanceErrors.join('; ')}`);
}

// Re-export the parser for convenience — many call sites that read
// the registry also want to decompose a scope string into its parts.
export { parseVendorEntityScope };
