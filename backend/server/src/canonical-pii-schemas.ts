/** D-167 — shipped canonical + CRM privacy-tagged entity schemas (the
 *  "PII lever ON by default" content).
 *
 *  The D-167 alias substrate, the chat-egress resolver
 *  (`createMetaFieldPrivacyResolverFromLocalManifestStore`), and the
 *  enrichment-egress tag source
 *  (`createEnrichmentPiiTagSourceFromLocalManifestStore`) were all wired and
 *  proven — BUT every consumer reads `MetaField.privacy` tags from the per-pair
 *  `local_manifest` table, which is ONLY populated when a user installs a
 *  D-170-authored composition. So out of the box NOTHING was tagged: the alias
 *  pass was a byte-identical no-op on every real turn, and a user's contact /
 *  HubSpot email egressed to the cloud LLM in plaintext. The control-plane "PII
 *  stays local" promise was inert until a user hand-authored a tagged schema.
 *
 *  This module is that missing default-on content: a small, first-party set of
 *  `EntitySchemaIngredientInput`s over the universal canonical collections
 *  (`data.mail` / `data.contact` / `data.calendar`) plus the HubSpot + Salesforce
 *  contact entities, each tagging its PII-bearing fields with the D-167
 *  `MetaField.privacy` kind. The boot wiring UNIONS this set into BOTH egress
 *  resolvers (`wire-chat-orchestrator.ts`, `wire-housekeeping-substrate.ts`) on
 *  top of whatever the per-pair `local_manifest` holds — so protection is on for
 *  every self-hoster with zero install, and a connected-CRM user's contact email
 *  is aliased on both the chat catalog-op path and the enrichment housekeeping
 *  path.
 *
 *  Why a first-party constant, not `community/` JSON or a `local_manifest` seed:
 *    - These are KERNEL canonical schemas (the `recued` publisher pattern —
 *      runtime-bundled, invisible in the marketplace), not installable content.
 *    - Seeding them into `local_manifest` would pollute the gateway manifest
 *      registry (`listManifests()`), which serves the dispatch path — these
 *      schemas have no resolvable catalog manifest. The resolvers read entity
 *      schemas via a SEPARATE union source (an explicit factory parameter), so
 *      `local_manifest` stays exactly the user-authored set.
 *    - A typed constant is validated at module load (`assertEntitySchemaIngredientValid`)
 *      so a malformed shipped schema fails boot fast rather than silently
 *      under-tagging at first egress.
 *
 *  No-op invariant preserved: the resolver factories default the shipped set to
 *  `[]`, so every existing test (and any caller that does not pass the set) is
 *  byte-identical. Only the two boot-wiring sites pass `CANONICAL_PII_ENTITY_SCHEMAS`.
 *
 *  Scope of the tag set (spec resolved open-question #6 — mail / contact / CRM /
 *  calendar; file metadata is out of scope):
 *    - identifier kinds (`email` / `phone` / `name` / `address`) SEED the alias
 *      ledger (whole-value typed alias) and drive the chat identifier pass;
 *    - `content` kinds (`subject` / `summary` / `description`) are scanned
 *      against the seeded ledger (the content pass) so a body that mentions an
 *      already-aliased address / name is replaced consistently.
 *
 *  Spec: D-167 §Scope, §Field declaration, §Integration/D-165;
 *  internal design notes (ContactRecord / CanonicalEvent / mail hot_fields). */

import {
  assertEntitySchemaIngredientValid,
  composeVendorEntityScope,
  CONNECTION_VENDOR_ENTITIES,
  type ConnectionVendorEntity,
  type CrmAlias,
  type EnrichmentScope,
  type EntityFieldPrivacy,
  type EntityPrivacyTag,
  type EntitySchemaIngredientInput,
  MAIL_FACT_PERSON_VARIABLES,
  MAIL_FACT_PII_ENTITY,
  type IngredientManifest,
} from '@recued/contracts';

/** `data.mail` (canonical_mirror) — the universal inbox collection. The
 *  `CollectionRecord` nests these under `hot_fields` (`hot_fields.from`, …); the
 *  enrichment seam probes the bare path then the `hot_fields.` form, and the
 *  producer's flattened `llm.data` body is content-scanned against the seeded
 *  addresses. `from` is a single address; `to` / `cc` are address arrays (the
 *  seam reads string-array leaves element-wise). */
const MAIL_SCHEMA: EntitySchemaIngredientInput = {
  ingredient_id: 'recued-canonical-mail',
  entity_id: 'mail',
  scope: 'data.mail',
  projection_mode: 'canonical_mirror',
  schema_mode: 'static',
  target_id: { fields: ['message_id'], template: 'mail_{message_id}' },
  meta_fields: [
    { key: 'from', type: 'string', source_path: 'from', privacy: 'email' },
    { key: 'to', type: 'json', source_path: 'to', privacy: 'email' },
    { key: 'cc', type: 'json', source_path: 'cc', privacy: 'email' },
    { key: 'subject', type: 'string', source_path: 'subject', privacy: 'content' },
  ],
  source_operations: {
    list: { catalog: 'recued-canonical-mail', operation: 'mail.list' },
  },
};

/** `data.contact` (contributing_source) — the personal contact graph, keyed on
 *  canonical email. Two PII fields per internal design notes ContactRecord:
 *  `email` (the key) and `name` (display name). This is the lever's universal
 *  floor — every self-hoster materializes a contact graph from mail/calendar. */
const CONTACT_SCHEMA: EntitySchemaIngredientInput = {
  ingredient_id: 'recued-canonical-contact',
  entity_id: 'contact',
  scope: 'data.contact',
  projection_mode: 'contributing_source',
  schema_mode: 'static',
  target_id: { fields: ['email'], template: '{email}' },
  meta_fields: [
    { key: 'email', type: 'string', source_path: 'email', privacy: 'email' },
    { key: 'name', type: 'string', source_path: 'name', privacy: 'name' },
  ],
  source_operations: {
    list: { catalog: 'recued-canonical-contact', operation: 'contact.list' },
  },
};

/** `data.calendar` (canonical_mirror) — CanonicalEvent. `organizer.email` is the
 *  identifier seed (attendee arrays of objects are a comfort miss — the dot-path
 *  probe reads single objects + string-array leaves, not arrays of objects);
 *  `location` is a geo-suffixed `address` alias; `summary` / `description` are
 *  content-scanned. */
const CALENDAR_SCHEMA: EntitySchemaIngredientInput = {
  ingredient_id: 'recued-canonical-calendar',
  entity_id: 'event',
  scope: 'data.calendar',
  projection_mode: 'canonical_mirror',
  schema_mode: 'static',
  target_id: { fields: ['source_id'], template: 'event_{source_id}' },
  meta_fields: [
    { key: 'organizer.email', type: 'string', source_path: 'organizer.email', privacy: 'email' },
    { key: 'location', type: 'string', source_path: 'location', privacy: 'address' },
    { key: 'summary', type: 'string', source_path: 'summary', privacy: 'content' },
    { key: 'description', type: 'string', source_path: 'description', privacy: 'content' },
  ],
  source_operations: {
    list: { catalog: 'recued-canonical-calendar', operation: 'calendar.list' },
  },
};

/** HubSpot contact (platform_reference) — the exact case the launch audit flagged
 *  ("a user's HubSpot contact email egresses to the cloud LLM in plaintext").
 *
 *  Each tag covers BOTH shapes the resolvers see, because `piiPathsForMetaField`
 *  emits the `source_path` AND the canonical `key`:
 *    - the chat catalog-op RESULT is the RAW vendor shape — `contact-reader-hubspot`
 *      returns `properties.{email,firstname,lastname,phone,company}` — matched by
 *      the `source_path`;
 *    - the enrichment platform-reference SNAPSHOT is the canonical projection —
 *      `connection-vendors.ts` projects `{email, name, phone, company}` — matched
 *      by the `key`.
 *  Names are split in the raw read (`firstname` / `lastname`) but concatenated to
 *  `name` in the snapshot: the firstname tag carries `key: 'name'` so the snapshot
 *  `name` is aliased, and a second `lastname` tag covers the raw last name. Two
 *  aliases for one person on the raw path is an accepted comfort imperfection (the
 *  hard invariant is restore-fidelity, not minimal fragmentation) — what matters
 *  is that no name egresses in plaintext.
 *
 *  Address: the platform-reference SNAPSHOT carries a structured
 *  `meta.mailing_address` (`{ address1, address2?, city, state, zip, country }`,
 *  written by the contact reconcilers from HubSpot `properties.{address,address2,
 *  zip}` / Salesforce `Mailing{Street,PostalCode}`). The STRONG identifiers —
 *  street (`address1`/`address2`) and postal (`zip`) — are tagged `address`
 *  (covering both the raw vendor read path via `source_path` and the canonical
 *  snapshot path `mailing_address.*` via `key`). The COARSE city / state /
 *  country are deliberately NOT tagged: per D-167's resolved open-question #9
 *  city-grain is an accepted comfort tradeoff, and the `address` alias kind keeps
 *  city/state/country visible in its suffix (`pii.Address1.san-francisco.ca.usa`) for
 *  the LLM's timezone/region reasoning anyway. */
const HUBSPOT_CONTACT_SCHEMA: EntitySchemaIngredientInput = {
  ingredient_id: 'hubspot-catalog',
  wraps_vendor: 'hubspot',
  entity_id: 'contact',
  scope: 'connection.api.hubspot.contact',
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  crm_alias: 'contact',
  target_id: { fields: ['id'], template: 'hubspot_contact_{id}' },
  meta_fields: [
    { key: 'email', type: 'string', source_path: 'properties.email', privacy: 'email' },
    // Name PII across every shape the resolvers see: `name` (the snapshot concat),
    // `first_name` / `last_name` (the op-step canonical projection — D-167 follow-on of
    // making the name parts projectable), and the raw read's `properties.firstname` /
    // `properties.lastname` (via `source_path`). `properties.firstname` is tagged twice
    // (name + first_name) — the accepted comfort imperfection (the invariant is
    // restore-fidelity, not minimal fragmentation).
    { key: 'name', type: 'string', source_path: 'properties.firstname', privacy: 'name' },
    { key: 'first_name', type: 'string', source_path: 'properties.firstname', privacy: 'name' },
    { key: 'last_name', type: 'string', source_path: 'properties.lastname', privacy: 'name' },
    { key: 'phone', type: 'string', source_path: 'properties.phone', privacy: 'phone' },
    { key: 'company', type: 'string', source_path: 'properties.company', privacy: 'org' },
    // The WHOLE address object, so the aliaser can COMPOSE it (`registerAddressComposite`):
    // the record hands it every component, so the ledger learns the postcode's NEIGHBOURS and
    // can match the layouts it is really written in (`Mountain View, CA 94043`). Without this
    // the postcode is unmatchable in prose — a bare `94043` is indistinguishable from an
    // invoice number and is deliberately withheld. STRUCTURE-SAFE: the composer aliases each
    // leaf in place, so the object never collapses. The dotted-leaf tags below still cover the
    // RAW vendor shape (flat `properties.*`, where no object exists); double-tagging is safe —
    // `aliasIdentifierField` returns an already-aliased value unchanged.
    { key: 'mailing_address', type: 'json', source_path: 'mailing_address', privacy: 'address' },
    // Strong address identifiers — street + postal. `source_path` is the raw
    // vendor read field; `key` is the canonical snapshot path (`mailing_address.*`).
    { key: 'mailing_address.address1', type: 'string', source_path: 'properties.address', privacy: 'address' },
    { key: 'mailing_address.address2', type: 'string', source_path: 'properties.address2', privacy: 'address' },
    { key: 'mailing_address.zip', type: 'string', source_path: 'properties.zip', privacy: 'address' },
  ],
  source_operations: {
    read: { catalog: 'hubspot-catalog', operation: 'contact.read' },
  },
};

/** Salesforce contact (platform_reference) — the SF counterpart. Same dual-shape
 *  coverage: the chat read (`contact-reader-salesforce`) returns RAW PascalCase
 *  `{Email, FirstName, LastName, Phone, MobilePhone}` (matched by `source_path`),
 *  while the snapshot projects canonical `{email, name, phone}` (matched by `key`).
 *  Drives the chat catalog-op path (`contact.read`) AND the enrichment producer
 *  `lifecycle_stage_inferred_salesforce` over `connection.api.salesforce.contact`
 *  (the own-walk producer the audit flagged egressing raw). */
const SALESFORCE_CONTACT_SCHEMA: EntitySchemaIngredientInput = {
  ingredient_id: 'salesforce-catalog',
  wraps_vendor: 'salesforce',
  entity_id: 'contact',
  scope: 'connection.api.salesforce.contact',
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  crm_alias: 'contact',
  target_id: { fields: ['Id'], template: 'salesforce_contact_{Id}' },
  meta_fields: [
    { key: 'email', type: 'string', source_path: 'Email', privacy: 'email' },
    // Name PII across every shape: `name` (snapshot concat), `first_name` / `last_name`
    // (op-step canonical projection — D-167 follow-on), and the raw read's `FirstName` /
    // `LastName` (via `source_path`). `FirstName` is tagged twice (name + first_name) —
    // the accepted comfort imperfection (restore-fidelity over minimal fragmentation).
    { key: 'name', type: 'string', source_path: 'FirstName', privacy: 'name' },
    { key: 'first_name', type: 'string', source_path: 'FirstName', privacy: 'name' },
    { key: 'last_name', type: 'string', source_path: 'LastName', privacy: 'name' },
    { key: 'phone', type: 'string', source_path: 'Phone', privacy: 'phone' },
    { key: 'mobile_phone', type: 'string', source_path: 'MobilePhone', privacy: 'phone' },
    // The WHOLE address object, so the aliaser can COMPOSE it (`registerAddressComposite`):
    // the record hands it every component, so the ledger learns the postcode's NEIGHBOURS and
    // can match the layouts it is really written in (`Mountain View, CA 94043`). Without this
    // the postcode is unmatchable in prose — a bare `94043` is indistinguishable from an
    // invoice number and is deliberately withheld. STRUCTURE-SAFE: the composer aliases each
    // leaf in place, so the object never collapses. The dotted-leaf tags below still cover the
    // RAW vendor shape (flat `properties.*`, where no object exists); double-tagging is safe —
    // `aliasIdentifierField` returns an already-aliased value unchanged.
    { key: 'mailing_address', type: 'json', source_path: 'mailing_address', privacy: 'address' },
    // Strong address identifiers — street + postal. `source_path` is the raw
    // vendor read field; `key` is the canonical snapshot path (`mailing_address.*`).
    { key: 'mailing_address.address1', type: 'string', source_path: 'MailingStreet', privacy: 'address' },
    { key: 'mailing_address.address2', type: 'string', source_path: 'mailing_address.address2', privacy: 'address' },
    { key: 'mailing_address.zip', type: 'string', source_path: 'MailingPostalCode', privacy: 'address' },
  ],
  source_operations: {
    read: { catalog: 'salesforce-catalog', operation: 'contact.read' },
  },
};

/** The shipped privacy-tagged schemas, validated at module load so a malformed
 *  authored schema fails boot fast (the `assertEntitySchemaIngredientShape`
 *  "surface at boot, not at first sync" posture). Frozen — the resolvers read it
 *  per packet and must never mutate the shared set. */
export const CANONICAL_PII_ENTITY_SCHEMAS: readonly EntitySchemaIngredientInput[] =
  Object.freeze(
    [
      MAIL_SCHEMA,
      CONTACT_SCHEMA,
      CALENDAR_SCHEMA,
      HUBSPOT_CONTACT_SCHEMA,
      SALESFORCE_CONTACT_SCHEMA,
    ].map((schema) => {
      assertEntitySchemaIngredientValid(schema);
      return schema;
    }),
  );

/** D-167 E.1 — the shipped operation-FREE entity-marker privacy tags (the
 *  entity-keyed counterpart of `CANONICAL_PII_ENTITY_SCHEMAS`). Once a producer
 *  stamps a record's `__entity` (the P2 slice — `projectLocalContact` /
 *  `projectPlatformContact` → `'contact'`, `projectPlatformDeal` → `'deal'`,
 *  plus the prefetch candidates), the chat resolver applies these bare field
 *  tags wherever that record appears — covering every re-embedded copy from ONE
 *  declaration, retiring the per-envelope `contact.search` / `deal.search`
 *  explicit-path declarations.
 *
 *  Field set:
 *    - contact → `email` (email), `name` (name), `target_id` (email — IS the
 *      canonical email for local contacts, so it aliases to the same surface),
 *      `phone` (phone), `company` (org). `email`/`name`/`target_id` mirror the
 *      retired explicit search paths; `phone` + `company` (D-167 B4) are NOT on a
 *      `ChatContactCandidate` (contact.search results surface neither) — each
 *      rides ONLY on the prefetch's resolved payload (`toPrefetchEntityRecord`),
 *      where tagging it seeds the turn ledger so a contact's phone / company the
 *      USER typed is aliased by the D-167 P4 user-message pass (known → aliased;
 *      unknown → ledger-residual). The shared `company → org` tag is a no-op for
 *      every other contact-marked record (the chat contact projections carry no
 *      `company` field), so it activates ONLY for the prefetch's new field; the
 *      prefetch withholds a single-token common-word company from the seed (its
 *      B4 commonness filter), so this tag never over-aliases a bare org word.
 *      RESIDUAL (ledger-anchored, no-NER): the transforms egress pass aliases a
 *      known phone in ANY separator layout — both the FULL E.164 run AND the
 *      NATIONAL run with a known country code stripped (`(415) 555-0199` →
 *      `4155550199` vs stored `+14155550199`), incl. the optional leading `0`
 *      trunk prefix most of the world writes (UK `020 7946 0958`), via the
 *      phone-variant pass in `pii-alias.ts`. So `1-415-555-0199` /
 *      `+1 (415) 555-0199` / `1.415.555.0199` / the bare national
 *      `(415) 555-0199` / `020 7946 0958` all alias once the phone is in the
 *      ledger. WHAT REMAINS: (1) a national form whose country code is ABSENT
 *      from the `pii-alias` ISO table (the national run can't be split off) — an
 *      even narrower case than the now-closed common one; (2) a national run TWO
 *      contacts share (same national digits) is deliberately left raw rather
 *      than coin-flip-aliased to the wrong contact; (3) the PREFETCH seeds a
 *      phone into the ledger only when the message carries the CONTIGUOUS-digit
 *      form (token match) or resolves the contact by name — a separated-phone-
 *      ONLY message with no name won't seed it. Same class as the accepted
 *      brand-new-value / email-suffix residuals.
 *      `mailing_address` / `platform_ids` are likewise un-surfaced today; add
 *      tags here if a producer ever carries them into a model-bound payload.
 *    - deal → `owner` (email — the only PII on a `ChatDealCandidate`; the deal
 *      title + vendor `target_id` are NOT PII and stay untagged).
 *
 *  Decoupled from `source_operations` ON PURPOSE: declaring contact's PII here
 *  must NOT alter `CONTACT_SCHEMA`'s `contact.list` operation binding (byte-
 *  identity — a separate constant touches no schema). Frozen — the resolver
 *  reads it per packet and must never mutate it. */
export const CANONICAL_PII_ENTITY_PRIVACY_TAGS: readonly EntityPrivacyTag[] =
  Object.freeze([
    {
      // Exact mail reads stamp their hot_fields envelope. Derive its address
      // and subject tags from the same canonical schema used by mail producers.
      entity_id: 'mail',
      fields: (MAIL_SCHEMA.meta_fields ?? []).flatMap(field => field.privacy
        ? [{ path: field.key, kind: field.privacy }] : []),
    },
    {
      entity_id: 'contact',
      fields: [
        { path: 'email', kind: 'email' },
        { path: 'name', kind: 'name' },
        { path: 'target_id', kind: 'email' },
        { path: 'phone', kind: 'phone' },
        { path: 'company', kind: 'org' },
      ],
    },
    {
      entity_id: 'deal',
      fields: [{ path: 'owner', kind: 'email' }],
    },
    {
      // account → `owner` (email when resolved — the only PII on a
      // `ChatAccountCandidate`; the company name / website domain / industry
      // are NOT PII and stay untagged). Mirrors `deal`.
      entity_id: 'account',
      fields: [{ path: 'owner', kind: 'email' }],
    },
    {
      // D-315 §9 — a mail fact's reading, as the AI pass sends it: the people a
      // template read (a lead's name, email and phone; a buyer's). Known values,
      // so the email's own copies of them are aliased too.
      entity_id: MAIL_FACT_PII_ENTITY,
      fields: Object.entries(MAIL_FACT_PERSON_VARIABLES).map(([path, kind]) => ({ path, kind })),
    },
  ] satisfies EntityPrivacyTag[]);

/** Minimal operation-id manifests for the built-in CRM catalogs, consumed ONLY
 *  by the chat field-privacy resolver's `getManifest` fallback.
 *
 *  Why this is needed: the chat resolver's `operationKeysFor` learns a fully-
 *  qualified `OperationSpec.operation_id` (e.g. `recued-core/hubspot.contact.read`
 *  — the tool name a connection MCP catalog actually surfaces, per
 *  `d-167-p5-resolver-index-e2e.test.ts`) only through a manifest lookup. The
 *  resolver's lookup is the per-pair `local_manifest` store, which holds only
 *  D-170-authored compositions — NOT the marketplace `hubspot-catalog` /
 *  `salesforce-catalog` (they live in the gateway dispatch registry). Without
 *  these, the shipped CRM schemas would index only the bare/`catalog.operation`
 *  key forms, and a chat tool call named `recued-core/hubspot.contact.read` would
 *  MISS the index → the contact's email/name/phone egress raw. These manifests
 *  supply exactly the operation_id the resolver needs (nothing dispatches them).
 *
 *  Keyed by the schemas' `source_operations.*.catalog` (`hubspot-catalog` /
 *  `salesforce-catalog`); the store lookup wins when present, this is the
 *  fallback. */
const crmCatalogOperationManifest = (slug: string, vendor: string): IngredientManifest => ({
  slug,
  version: 1,
  name: `${vendor} catalog (PII operation-id index)`,
  description: `Operation-id index for the built-in ${vendor} catalog so the chat PII resolver matches the fully-qualified tool name. Not a dispatchable catalog.`,
  author: 'recued-core',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    'contact.read': { operation_id: `recued-core/${vendor}.contact.read`, risk_tier: 'read' },
  },
});

export const CANONICAL_PII_CATALOG_MANIFESTS: ReadonlyMap<string, IngredientManifest> = new Map([
  ['hubspot-catalog', crmCatalogOperationManifest('hubspot-catalog', 'hubspot')],
  ['salesforce-catalog', crmCatalogOperationManifest('salesforce-catalog', 'salesforce')],
]);

/* ───────────────── CRM recall seeding (D-167 recall path, Tier 2) ───────────────── */

/** The CRM-mirror `meta` keys that feed the RECALL aliasing index, for ONE
 *  `crm_alias`. Grouped by the `RecallContactSeeds` slot each feeds — the gateway
 *  takes raw strings, so the KIND is decided here and nowhere else. */
export interface CrmRecallSeedFields {
  /** Keys whose value is a PERSON name → the A-C `name` seeds. */
  readonly names: readonly string[];
  /** Keys whose value is an ORG name → the A-C `org` seeds. */
  readonly orgs: readonly string[];
  /** Keys whose value is a phone → the exact form→phone resolution set. */
  readonly phones: readonly string[];
  /** Keys whose value is a STREET LINE → the A-C `address` seeds. Multi-token and
   *  distinctive, so the automaton matches them safely. The POSTCODE is deliberately absent
   *  (all digits → it collides with invoice numbers, and the content pass refuses to
   *  blind-match any all-digit value), as are city / state / country — single common tokens
   *  that would over-alias, and which stay VISIBLE by the owner's location-awareness ruling. */
  readonly addresses: readonly string[];
  /** Keys whose value is a web DOMAIN → the known-domain anchors that let a URL alias on the
   *  recall path. KNOWN-ONLY on purpose: unlike an email, a URL is usually NOT PII, so seeding
   *  every URL would alias `docs.python.org` and blind the model to public links. */
  readonly domains: readonly string[];
  /** Keys holding the postcode's NEIGHBOURS (city / state / postal). Projected so
   *  `addressMatchForms` can build the multi-token layouts a postcode is really
   *  written in — NEVER seeded individually, because a bare postcode is
   *  indistinguishable from an invoice number. */
  readonly postal_parts: readonly string[];
}

/** D-167 (recall path, Tier 2) — which CRM-mirror `meta` keys seed the recall
 *  aliasing index, keyed by the CLOSED `crm_alias` enum (`deal | contact |
 *  account`).
 *
 *  WHY keyed on `crm_alias` and not the vendor/entity: the alias is exactly the
 *  axis that says what a `name` MEANS. `meta.name` is a PERSON on a `contact`, an
 *  ORG on an `account`, and a DEAL TITLE on a `deal` — the same key, three
 *  different privacy kinds. Keying on the alias also makes this vendor-blind: the
 *  scopes are enumerated from `CONNECTION_VENDOR_ENTITIES`, so Pipedrive (which
 *  runs on the GENERIC reconciler with zero per-vendor code) and any pack-declared
 *  CRM inherit the seeding for free — no per-vendor list to keep in sync.
 *
 *  WHY this is not `MetaField.privacy` on the vendor registry: the registry's
 *  `ConnectionVendorEntityMetaField` carries no `privacy` (only the D-167
 *  `EntitySchemaIngredientInput` in this file does), and adding one would make a
 *  THIRD declaration of the same fact — `CANONICAL_PII_ENTITY_SCHEMAS` (the
 *  tool-result egress) already tags `hubspot.contact` / `salesforce.contact`. This
 *  constant is the recall path's own, separate policy, and the two paths are
 *  deliberately allowed to differ (see the `account` note below).
 *
 *  Per-alias rationale:
 *    · `contact` — the whole point of Tier 2. A CRM contact does NOT produce a
 *      `data.contact` row: `ContactSource` is `email_from | email_to |
 *      calendar_attendee | manual` (no CRM member), nothing in the CRM ingest
 *      calls `observe`/`upsertManual`, and `contact_platform_link` only LINKS a
 *      platform id onto an ALREADY-EXISTING contact. So a person who lives only in
 *      your CRM — never emailed you, never on an invite — is invisible to the
 *      contact-derived A-C and their name/phone egressed RAW out of a recalled
 *      memory body. `name` covers the bespoke HubSpot/Salesforce reconcilers (they
 *      project only the concatenated name); `first_name`/`last_name` cover the
 *      generic reconciler, which mirrors the registry keys verbatim. An absent key
 *      json_extracts to NULL and is skipped, so listing all three is free.
 *    · `account` — `orgs: ['name']` (the CRM account's company name). Note the
 *      DELIBERATE asymmetry with `CANONICAL_PII_ENTITY_PRIVACY_TAGS`, which leaves
 *      an account's name untagged ("NOT PII on a `ChatAccountCandidate`"). That
 *      call governs the TOOL-RESULT path, where the model asked for the account by
 *      name and the record IS the answer. The recall path is a different question:
 *      it already seeds org names (a contact's `company` — the store's
 *      `listAllNamesAndCompanies` returns companies, and `contact.company` is
 *      tagged `org`), so an org name in a recalled memory body is ALREADY aliased
 *      when it happens to be some contact's employer. Seeding CRM account names
 *      adds no new KIND of exposure — it removes an arbitrary gap in an existing
 *      one. B4 (`shouldSeedEntityValue`) still withholds a single-token common word
 *      ("Gap"), so this cannot over-alias bare prose.
 *    · `deal` — EMPTY, on purpose. `meta.name` on a deal is a TITLE ("Acme Corp –
 *      Q3 Renewal"), not a person or an org; seeding it would bloat the automaton
 *      with non-PII and alias deal titles in prose for no protective gain. `owner`
 *      is likewise skipped across every alias: it is an OPAQUE vendor id
 *      (`hubspot_owner_id:123` / `salesforce_user:…`) — no reconciler resolves it
 *      to a mailbox (`resolveOwnerMailbox` returns null for both prefixes), so it
 *      carries no PII to shield.
 *
 *  NOT seeded (no recall slot — `RecallContactSeeds` is names/orgs/emails/phones):
 *    · `mailing_address.*` (privacy `address`) and `domain` (privacy `url`) — both
 *      real PII the tool-result path can alias, but the recall index has no slot
 *      for either. Widening it is a gateway change, not a declaration.
 *    · CRM `email` needs NOTHING: the recall egress already seeds EVERY email
 *      present in the recalled text unconditionally (store-free — an email is PII
 *      whether or not it is a known contact), so a CRM-only person's address is
 *      covered by that leg already. */
export const CRM_RECALL_SEED_FIELDS: Readonly<Record<CrmAlias, CrmRecallSeedFields>> =
  Object.freeze({
    contact: Object.freeze({
      names: Object.freeze(['name', 'first_name', 'last_name']),
      orgs: Object.freeze(['company']),
      phones: Object.freeze(['phone']),
      // Street lines only — these are seeded into the automaton AS-IS.
      addresses: Object.freeze(['mailing_address.address1', 'mailing_address.address2']),
      // ⛔⛔ POSTAL PARTS ARE PROJECTED BUT NEVER SEEDED INDIVIDUALLY. A bare
      // `94043` is indistinguishable from an invoice number, and aliasing it
      // would corrupt every digit-run in prose — that reasoning is unchanged and
      // still governs. What these enable is the COMPOSITE: `addressMatchForms`
      // turns them into the multi-token layouts the address is really written in
      // (`Mountain View, CA 94043`, `London SW1A 2AA`), which is the only shape a
      // postcode can be matched in safely. The generator NEVER emits a lone
      // token, and the alias keeps a geo suffix so region grain survives.
      // ⚠ Locale-agnostic by construction: `if (city) add(city, postal)` covers
      // UK/EU layouts as readily as the US `city, state postal` one.
      postal_parts: Object.freeze([
        'mailing_address.city', 'mailing_address.state', 'mailing_address.zip',
        // ⛔ COUNTRY IS LOAD-BEARING AND WAS MISSING. `aliasAddress` builds the
        // geo suffix (`pii.AddressN.city.state.iso`) ONLY when
        // `parseAddressComponents` reads a known country from the LAST comma
        // segment. Without it projected here the country-bearing layout is never
        // generated, the shorter form wins the scan, and the alias degrades to a
        // bare `pii.AddressN` — the address is protected but the region grain the
        // city/country exclusion exists to preserve is silently lost.
        'mailing_address.country',
      ]),
      domains: Object.freeze([]),
    }),
    account: Object.freeze({
      names: Object.freeze([]),
      orgs: Object.freeze(['name']),
      phones: Object.freeze([]),
      addresses: Object.freeze([]),
      // The CRM account's web domain — the anchor that lets a memory body's link to that
      // company's site alias (`https://acme.com/portal` → `https://d1.invalid/portal`).
      domains: Object.freeze(['domain']),
      postal_parts: Object.freeze([]),
    }),
    deal: Object.freeze({
      names: Object.freeze([]),
      orgs: Object.freeze([]),
      phones: Object.freeze([]),
      addresses: Object.freeze([]),
      domains: Object.freeze([]),
      postal_parts: Object.freeze([]),
    }),
  } satisfies Record<CrmAlias, CrmRecallSeedFields>);

/* ─────────── Derived vendor-entity privacy (the TOOL-RESULT / producer path) ─────────── */

/** Canonical CRM-CONTACT field → privacy kind.
 *
 *  A `crm_alias: 'contact'` entity IS a person record BY DECLARATION, so these
 *  canonical keys carry KNOWN privacy kinds whatever the vendor — the same insight
 *  `CRM_RECALL_SEED_FIELDS` uses on the recall path. The list mirrors the hand-written
 *  `HUBSPOT_CONTACT_SCHEMA` / `SALESFORCE_CONTACT_SCHEMA` field-for-field; those two
 *  now simply state explicitly what this would derive anyway. */
const CRM_CONTACT_FIELD_PRIVACY: Readonly<Record<string, EntityFieldPrivacy>> =
  Object.freeze({
    email: 'email',
    name: 'name',
    first_name: 'name',
    last_name: 'name',
    phone: 'phone',
    mobile_phone: 'phone',
    company: 'org',
    // The whole object — this is what lets the aliaser COMPOSE the address and learn the
    // postcode's neighbours. A pack CRM contact gets it for free, like every other tag here.
    mailing_address: 'address',
    'mailing_address.address1': 'address',
    'mailing_address.address2': 'address',
    'mailing_address.zip': 'address',
  });

/** Canonical CRM-ENGAGEMENT field → privacy kind.
 *
 *  An `engagement` facet declares the record is an ACTIVITY BETWEEN PEOPLE (an email, a
 *  meeting, a call, a note, a task), so its canonical keys carry known kinds whatever the
 *  vendor — the engagement counterpart of the `crm_alias: 'contact'` rule above. These
 *  entities were **entirely untagged**: `hubspot.email` / `salesforce.email_message` ship
 *  `from_email` + `to_emails` + `cc_emails`, `hubspot.meeting` ships `attendee_emails`,
 *  `salesforce.voice_call` ships `caller_number` — so an enrichment producer walking
 *  `connection.api.<vendor>.<engagement>` sent every participant's **address, name and
 *  phone number to the model in the clear**, including who met whom.
 *
 *  The free-text keys are tagged `content`, which is a SCAN-ONLY kind: it replaces values
 *  ALREADY in the ledger and never seeds new ones, so tagging them carries **zero**
 *  over-alias risk and simply keeps a body that mentions an already-aliased person
 *  consistent with the rest of the packet. `location` mirrors `CALENDAR_SCHEMA`'s
 *  `location → address` treatment exactly. `owner` is skipped everywhere — it is an
 *  opaque vendor id (`hubspot_owner_id:123`), never resolved to a mailbox. */
const ENGAGEMENT_FIELD_PRIVACY: Readonly<Record<string, EntityFieldPrivacy>> =
  Object.freeze({
    from_email: 'email',
    to_emails: 'email',
    cc_emails: 'email',
    attendee_emails: 'email',
    from_name: 'name',
    caller_number: 'phone',
    location: 'address',
    // SCAN-ONLY (`content` never seeds) — free text that may mention a seeded person.
    subject: 'content',
    title: 'content',
    call_subject: 'content',
    description: 'content',
    body_preview: 'content',
  });

/** Attach the canonical privacy kinds to every entity schema whose DECLARATION says what
 *  the record is — a `crm_alias: 'contact'` (a person) or an `engagement` facet (an
 *  activity between people) — and that has not already tagged them. Built-in or
 *  pack-authored, it makes no difference.
 *
 *  WHY THE KERNEL DERIVES THIS INSTEAD OF ASKING AUTHORS: privacy tagging was hand-written
 *  per entity, and only `hubspot.contact` + `salesforce.contact` ever got it. **Every**
 *  pack-declared CRM contact ships with ZERO privacy tags — measured:
 *  `community/packs/{pipedrive,zoho-crm-sales,dynamics}.json` all declare
 *  `crm_alias: 'contact'` and tag nothing — and **every** engagement entity, built-in
 *  included, was untagged. So a `contact.search` against a pack CRM, or any producer over
 *  a CRM email / meeting / call, egressed that person's **email, phone and name RAW to the
 *  cloud LLM**.
 *
 *  That is a SUBSTRATE bug, not a pack bug: a third-party author forgetting a `privacy`
 *  tag must not be able to leak the USER's data, and "remember to tag your PII" is exactly
 *  the invariant humans fail. The declaration already tells the kernel what the record IS;
 *  deriving from it makes protection the DEFAULT and makes a new vendor safe on arrival,
 *  with no list to keep in sync.
 *
 *  An author's EXPLICIT tag always wins (this only fills absences), and there is
 *  deliberately NO way to declare a field not-PII — a pack must not be able to switch the
 *  user's protection off. Idempotent, so applying it at more than one union point is
 *  harmless. Everything else is untouched: `crm_alias: 'account'` keeps the documented
 *  "company name / website domain / industry are NOT PII" call
 *  (`CANONICAL_PII_ENTITY_PRIVACY_TAGS`), `deal` carries no person PII, and an entity with
 *  NEITHER declaration is never force-tagged — the rule keys on what the author DECLARED,
 *  it does not guess from field names. */
export const withDerivedVendorEntityPrivacy = (
  schemas: readonly EntitySchemaIngredientInput[],
): EntitySchemaIngredientInput[] =>
  schemas.map((schema) => {
    const map =
      schema.crm_alias === 'contact'
        ? CRM_CONTACT_FIELD_PRIVACY
        : schema.engagement !== undefined
          ? ENGAGEMENT_FIELD_PRIVACY
          : undefined;
    if (map === undefined) return schema;
    let derived = false;
    const meta_fields = (schema.meta_fields ?? []).map((field) => {
      if (field.privacy !== undefined) return field; // author's explicit tag WINS
      const kind = map[field.key];
      if (kind === undefined) return field;
      derived = true;
      return { ...field, privacy: kind };
    });
    return derived ? { ...schema, meta_fields } : schema;
  });

/** The CRM `meta` key a synthetic `name` may merely echo. The reconcilers SYNTHESIZE
 *  `meta.name` from the email local-part when a contact carries no first/last name
 *  (`constructContactName` in `data/hubspot/contact-reconciler.ts`; the registry says
 *  it outright — `fallback_path: 'properties.email', fallback_transform: 'local_part'`).
 *  Fetched alongside the seed keys purely so `isSyntheticLocalPartName` can reject it. */
export const CRM_NAME_PLACEHOLDER_SOURCE_KEY = 'email';

/** Is `name` merely `email`'s local part — a reconciler-synthesized placeholder rather
 *  than a real person's name?
 *
 *  WHY THIS GUARD EXISTS (adversarial-review find): a CRM contact `sales@acme.com` with
 *  no first/last name gets `meta.name = 'sales'`. Seeding that as a PERSON name puts the
 *  bare token `sales` into the whole-warehouse Aho-Corasick automaton, which then
 *  aliases EVERY occurrence of it in a recalled memory body — "Q3 sales were up; the
 *  support team flagged billing" would reach the model as "Q3 pii.Person1 were up; the
 *  pii.Person2 pii.Person3 flagged pii.Person4". That is CORRUPTION, the same class the
 *  phone known-only rule guards against — and **B4 does NOT catch it**: `sales` / `info`
 *  / `support` / `admin` / `billing` / `team` / `office` / `accounts` are all ABSENT
 *  from the common-single-token list, so every one of them would seed.
 *
 *  Case-insensitive (a vendor may title-case the fallback). Comparing against the row's
 *  OWN email is what keeps it surgical: a contact who genuinely IS mononymous ("Cher")
 *  still seeds, because her name is not her address's local part. */
export const isSyntheticLocalPartName = (
  name: string,
  email: string | undefined,
): boolean => {
  if (email === undefined) return false;
  const at = email.indexOf('@');
  if (at <= 0) return false;
  return name.trim().toLowerCase() === email.slice(0, at).trim().toLowerCase();
};

/** Is `value` an all-digit string? Never a person or an org, and seeding it into the
 *  name/org automaton would alias bare numbers in recalled prose (the same corruption
 *  the phone leg's known-only rule exists to prevent). Belt-and-braces over an
 *  open-vocabulary `meta` a third-party pack can shape however it likes. */
export const isAllDigits = (value: string): boolean => /^\d+$/.test(value.trim());

/** One CRM mirror scope's recall seed plan — the scope to scan plus the `meta`
 *  keys to project out of it, already split by seed slot. */
export interface CrmRecallSeedScope {
  readonly scope: EnrichmentScope;
  readonly fields: CrmRecallSeedFields;
}

/** Enumerate every CRM mirror scope that contributes recall seeds, from the vendor
 *  registry. Registry-driven so a new CRM vendor (or a pack-declared one on the
 *  generic reconciler) is covered the moment it declares a `crm_alias` — there is
 *  no per-vendor list here to fall out of sync. Aliases that seed nothing (`deal`)
 *  are dropped, so the caller never scans a scope it has no use for. */
export const crmRecallSeedScopes = (
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): CrmRecallSeedScope[] => {
  const out: CrmRecallSeedScope[] = [];
  for (const entry of registry) {
    if (entry.crm_alias === undefined) continue;
    const fields = CRM_RECALL_SEED_FIELDS[entry.crm_alias];
    const total = fields.names.length + fields.orgs.length + fields.phones.length
      + fields.addresses.length + fields.domains.length;
    if (total === 0) continue;
    out.push({ scope: composeVendorEntityScope(entry.vendor, entry.entity), fields });
  }
  return out;
};
