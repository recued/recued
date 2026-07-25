/** D-121 Phase 1 — `data.contact` warehouse storage.
 *  D-138 Phase 1 — cross-platform reconciliation delta.
 *
 *  Single SQLite table (`contacts`) with three indexes (last_interaction
 *  desc, name COLLATE NOCASE, source). Adapter writes (`recordMailInteraction`
 *  / `recordCalendarInteraction`) and the manual upsert rpc all funnel
 *  through this store. First-seen wins for `source`, `first_seen`,
 *  `name`; `last_interaction` always pushes the max; `interaction_count`
 *  bumps once per source-record insert that involves the contact.
 *
 *  D-138 P1 widens the row with the merge-substrate columns (`platform_ids`
 *  + `rejected_pairs` + `merged_into` + `phone` + `mailing_address` +
 *  `company` + `company_source` + three precomputed blocking-key
 *  columns) and adds three server-internal tables:
 *
 *    - `contact_platform_link(canonical_email, vendor, platform_id, …)` —
 *      indexed `(vendor, platform_id)` UNIQUE. Reconciler-side lookup
 *      goes through this; `platform_ids` JSON on the row is the
 *      contracted API surface materialized at read.
 *    - `contact_rejection(email_a, email_b, …)` — indexed `(email_a,
 *      email_b)` UNIQUE (lex-ordered). Detection pre-filter goes
 *      through this; `rejected_pairs` JSON on the row materializes.
 *    - `contact_merge_candidate_queue(id, email_a, email_b, …)` —
 *      indexed `(status, detected_at)` + UNIQUE `(pair_key)` for dedup.
 *      Server-internal substrate (no cross-cloud sync per D-097 / D-168); rpc-only.
 *
 *  All three internal tables are server-internal. The row's JSON
 *  columns are materialized snapshots of the indexed primaries and
 *  exist for cheap `contact.get` / `contact.list` reads.
 *
 *  D-124 follow-on (contact bus emit) — when constructed with a
 *  `WarehouseEventBus`, observe / observeBatch / upsertManual / delete
 *  emit `data.contact.<slug>.<entity_type>.{created,updated,deleted}`
 *  events. */

import type Database from 'better-sqlite3';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import { randomUUID } from 'node:crypto';
import {
  aliasIncomingOutranks,
  canonicalizeEmail,
  canonicalPairKey,
  COMPANY_DOMAIN_INFERENCE_MAX_DISTINCT_COMPANIES,
  CONTACT_MATERIALIZE_BATCH_SIZE,
  CONTACT_REDIRECT_CHAIN_LIMIT,
  deriveAddressZipCountryKey,
  deriveCompanyNorm,
  deriveNameKey,
  evaluateContactMatch,
  fallbackDisplayName,
  isActor,
  isOriginSurface,
  isContactAliasPlatform,
  normalizeAliasPattern,
  resolveContactIdentity,
  sanitizeNetworkDomains,
  validateContactAliasInput,
  type Actor,
  type OriginSurface,
  type ContactAliasInput,
  type ContactAliasKind,
  type ContactAliasPlatform,
  type ContactAliasRecord,
  type ContactAliasSource,
  // D-192 C-2 — the contribution substrate + the projection.
  CONTACT_SOURCE_ID_MANUAL,
  CONTACT_SOURCE_ID_DERIVED,
  isContactAttributeKind,
  isContactContributionSource,
  resolveContributionsByKind,
  // C-2b — legacy provenance → ladder rung. Shared by the cutover backfill AND
  // the live write paths, so a contact cannot be re-ranked merely by being
  // touched after the cutover.
  contactSourceToContributionRung,
  CONTACT_IMPORT_ROW_SOURCES,
  companySourceToContributionRung,
  contributionSourceIdForRung,
  type ContactAttributeInput,
  type ContactAttributeKind,
  type ContactAttributeRecord,
  type ContactContribution,
  type ContactContributionSource,
  type ContactFieldProvenance,
  type ContactProjectionProvenance,
  type ContactSourceBlobInput,
  type ContactSourceBlobRecord,
  type ContactCompanySource,
  type ContactIdentityStatus,
  type ContactMatchField,
  type ContactMergeCandidate,
  type ContactRecord,
  type ContactReference,
  type ContactReferenceContext,
  type ContactReferenceLookups,
  type ContactReferenceResolution,
  type ContactSource,
  type ContactObservedSource,
  type MailingAddress,
  type NetworkDomain,
  type PersonalRecipeEntry,
  type PlatformIdEntry,
  assertValidPersonalRecipesBlob,
  normalizeTopic,
} from '@recued/contracts';
import { resolveContactReference as resolveContactReferenceImpl } from '@recued/contracts';
import { phoneMatchDigits } from '@recued/transforms';

import {
  CONTACT_ALIAS_TABLE,
  CONTACT_TABLE,
  MERGED_SOURCE_EMAILS_SQL,
  contactAddressSet,
} from './contact-merge-graph.js';

const CONTACT_PLATFORM = 'contact';
const DEFAULT_CONTACT_SLUG = 'default';
const DEFAULT_CONTACT_ENTITY_TYPE = 'contact';

/** D-167 §1.A — the prompt-cache prefetch index. An external-content FTS5 table
 *  over the contacts' `name` + `company` (the fuzzy text path), kept auto-fresh by
 *  AFTER INSERT/UPDATE/DELETE triggers on `${CONTACT_TABLE}` (the work-entity-store
 *  idiom). It replaces the recency-capped whole-warehouse scan for prefetch SEARCH:
 *  retrieval is store-wide + complete at any warehouse size, so a >10k warehouse no
 *  longer fails the §2 ambiguity gate closed. The recall known-value index
 *  (`chat-recall-index.ts`) still uses the capped `listForPrefetchScan` — migrating
 *  it is a separate follow-on (an enumerate-all-for-aliasing shape, not a search). */
const CONTACT_FTS_TABLE = 'contacts_fts';
/** D-167 §1.A — store-wide phone-form index. `phoneMatchDigits` is JS (country-code
 *  logic), so it is registered as the deterministic SQL function
 *  `phone_match_forms_json` and the table is maintained by triggers via `json_each`
 *  — same auto-fresh property as the FTS, with ZERO JS write-path hooks (the
 *  contacts table has many writers: observe / manual / merge-fields / mention-only).
 *  Keyed on the stable `rowid` (not `email`) so an email rekey can't orphan rows.
 *  Gives the scorer store-wide phone-form uniqueness (replacing the old page-local
 *  count), which lets phone identifier matching stay enabled past 10k. */
const CONTACT_PHONE_FORMS_TABLE = 'contact_phone_forms';
const CONTACT_PLATFORM_LINK_TABLE = 'contact_platform_link';
const CONTACT_REJECTION_TABLE = 'contact_rejection';
const CONTACT_MERGE_CANDIDATE_QUEUE = 'contact_merge_candidate_queue';
/** D-145 PA8 — `contact_alias` substrate. One table covers both
 *  chat aliases (`kind = 'chat_alias'`) and external platform IDs
 *  (`kind = 'platform_id'`); the resolver branches by kind. Per-pair
 *  only — no cross-cloud sync (D-097 / D-168), never returned via
 *  MCP rpcs to external AI clients.
 *
 *  ⚠ D-205 #3.5b — the name is now OWNED by `contact-merge-graph`, whose address
 *  walk joins this table (its `email_alias` rows are half the address space) and
 *  which may never import from here. Re-exported so existing importers are
 *  unchanged: one definition, two doors. */
export { CONTACT_ALIAS_TABLE };

/** D-192 C-2 — the ATTRIBUTE contribution store. The sibling of
 *  `contact_alias` on the other axis: `contact_alias` holds every value you can
 *  MATCH a person by (email / phone / handle / platform id); this holds every
 *  descriptive FACT about them (name / org / title / address / photo /
 *  birthday). Same contribution row shape — `(contact_id, kind, value, source,
 *  confidence, as_of)` — so both resolve through the ONE C-2a ladder in
 *  `packages/contracts/src/contact-contribution.ts`.
 *
 *  Why a store at all, rather than more columns on `contacts`: contact-import is
 *  many-sources-into-one-person, and a single-valued column cannot hold that —
 *  whoever writes last wins, silently, and the loser's view is gone. Here Google
 *  and HubSpot can BOTH assert a title and neither is destroyed; the `contacts`
 *  row is a PROJECTION over the winners. `title` + `photo` are the universal gap
 *  this closes (neither the personal graph nor the CRM `meta_fields` carry
 *  them). Per-pair only — no cross-cloud sync (D-097 / D-168). */
export const CONTACT_ATTRIBUTE_TABLE = 'contact_attribute';

/** D-192 C-2 — the RAW SOURCE store: one row per `(contact_id, vendor,
 *  remote_id)` holding the vendor's own payload verbatim, plus its
 *  `snapshot_hash`.
 *
 *  Two jobs. (1) It is the family's `SourceMirrorStore` — the hash is the
 *  incremental seam, so the `contact_import` reconciler skips unchanged remote
 *  records for free, exactly as the file family does (list → hash-skip → upsert).
 *  (2) It is the audit trail behind every derived contribution: when the
 *  projection surfaces "org = Acme (from HubSpot)", this is the record that
 *  said so. Re-deriving contributions after a mapping fix needs no re-fetch. */
export const CONTACT_SOURCE_BLOB_TABLE = 'contact_source_blob';

/** Synthetic placeholder local-part for mention_only contacts that
 *  don't yet carry a real email. RFC 6761 reserves `.invalid` for
 *  addresses that can never be a real address; the substrate uses it
 *  so the contacts table's email PK constraint isn't violated while
 *  also signaling at the data layer that no real outbound delivery is
 *  possible. Promoted contacts get the real email written over the
 *  placeholder via `promoteMentionOnlyToVerified`; the contact_id
 *  column survives the email rewrite intact. */
export const MENTION_ONLY_EMAIL_DOMAIN = '_recued.invalid';
export const MENTION_ONLY_EMAIL_PREFIX = 'mention-only-';

/** Substrate-level test for "this email is the synthetic placeholder
 *  the substrate emits for a mention_only contact". Surfaces in
 *  Settings UX so the placeholder isn't rendered as a real address. */
export const isMentionOnlyEmail = (email: string): boolean =>
  typeof email === 'string' &&
  email.startsWith(MENTION_ONLY_EMAIL_PREFIX) &&
  email.endsWith(`@${MENTION_ONLY_EMAIL_DOMAIN}`);

const synthesizeMentionOnlyEmail = (contact_id: string): string =>
  `${MENTION_ONLY_EMAIL_PREFIX}${contact_id.toLowerCase()}@${MENTION_ONLY_EMAIL_DOMAIN}`;

/** Install the contacts table + indexes + D-138 P1 internal tables.
 *  Idempotent — every statement uses `IF NOT EXISTS` and ALTERs are
 *  guarded by `PRAGMA table_info`. Safe to call on every boot. */
export const ensureContactSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONTACT_TABLE} (
      email             TEXT PRIMARY KEY,
      name              TEXT,
      first_seen        INTEGER NOT NULL,
      last_interaction  INTEGER NOT NULL,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      source            TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_last_interaction
      ON ${CONTACT_TABLE} (last_interaction DESC);
    CREATE INDEX IF NOT EXISTS idx_contacts_name_collate
      ON ${CONTACT_TABLE} (name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_contacts_source
      ON ${CONTACT_TABLE} (source);
  `);

  // D-138 P1 — widen `contacts` with the merge-substrate columns.
  // Pre-launch zero-migration: ALTER guarded by PRAGMA table_info so
  // fresh boots and existing dev databases converge on the same shape.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(${CONTACT_TABLE})`).all() as { name: string }[])
      .map((r) => r.name),
  );
  const addColumn = (name: string, ddl: string): void => {
    if (!cols.has(name)) db.exec(`ALTER TABLE ${CONTACT_TABLE} ADD COLUMN ${ddl}`);
  };
  addColumn('platform_ids',            `platform_ids TEXT NOT NULL DEFAULT '[]'`);
  addColumn('rejected_pairs',          `rejected_pairs TEXT NOT NULL DEFAULT '[]'`);
  addColumn('merged_into',             `merged_into TEXT`);
  addColumn('phone',                   `phone TEXT`);
  addColumn('mailing_address',         `mailing_address TEXT`);
  addColumn('company',                 `company TEXT`);
  addColumn('company_source',          `company_source TEXT`);
  addColumn('name_key',                `name_key TEXT`);
  addColumn('address_zip_country_key', `address_zip_country_key TEXT`);
  addColumn('company_norm',            `company_norm TEXT`);
  // D-145 PA8 — contact identity extensions. `contact_id` is the
  // stable substrate-level identifier; spec § A.4.1 reserves it as
  // the canonical reference. `identity_status` defaults to
  // `'verified'` so every existing row stays compatible (mail /
  // calendar / `contact.upsert`-with-email all hit verified by
  // construction). `network_domain` is a JSON-encoded string array
  // (closed list `family / work / social / other`) defaulting to
  // empty.
  addColumn('contact_id',              `contact_id TEXT`);
  addColumn('identity_status',         `identity_status TEXT NOT NULL DEFAULT 'verified'`);
  addColumn('network_domain',          `network_domain TEXT NOT NULL DEFAULT '[]'`);
  // D-145 PB11 § B.12.1 — per-contact `personal_recipes` blob.
  // JSON array of `{ recipe_id, topic, enabled, created_at }`
  // entries. Default `'[]'` keeps every legacy row compatible (no
  // bindings); the column is read by the engine dispatcher (§ B.12.3)
  // and mutated only via the Settings UI / `setPersonalRecipes` store
  // method. Per-pair only — no cross-cloud sync (D-097 / D-168).
  addColumn('personal_recipes',        `personal_recipes TEXT NOT NULL DEFAULT '[]'`);
  // D-161 P1 — origin provenance facet. Contacts are overwhelmingly
  // mail/calendar-derived (`observe*` → `'system'`); the column DEFAULT
  // stamps every insert (observe + manual) without touching the shared
  // `insertStmt`. `origin_actor` NOT NULL DEFAULT 'system' so every row
  // carries a non-null write-actor (I-5). Threading the rare manual
  // `contact.upsert` user/agent actor (vs the system default) is a P1
  // follow-on alongside P2's producer provenance-filter.
  addColumn('origin_actor',            `origin_actor TEXT NOT NULL DEFAULT 'system'`);
  addColumn('origin_contract_id',      `origin_contract_id TEXT`);
  // D-177 N.11 rule 1 — the write SURFACE facet (`'client_rpc'` /
  // `'engine'` / `'system'`). Unlike the genesis-stamped pair above,
  // `upsertManual` RE-STAMPS all three origin facets on every write
  // (create or update): the stored-cleanliness gate reads the LAST
  // writer, so an agent edit of a user-created row demotes it out of
  // `isUserCleanStoredRow` and a later user edit (the human saw the
  // full record in the editor) re-adopts it. The observe / sync paths
  // never touch the facets (interaction bumps aren't authorship).
  addColumn('origin_surface',          `origin_surface TEXT NOT NULL DEFAULT 'system'`);

  // ── D-192 C-2 — the PROJECTED attribute columns ─────────────────────────
  //
  // `name` / `company` / `phone` / `mailing_address` already exist and become
  // projections of their contributions. These three are new — `title` + `photo`
  // are the UNIVERSAL GAP (neither the personal contact graph nor the CRM
  // `meta_fields` carry them), and `birthday` rides along from contact books.
  //
  // Why materialize into COLUMNS rather than read the projection on demand: the
  // `contacts_fts` (name, company) and `contact_phone_forms` (phone) indexes are
  // maintained by SQL TRIGGERS on this table. Writing the projected value into
  // the row keeps both correct for free — a projection that lived only in the
  // contribution stores would leave search and phone-matching reading stale
  // values with nothing to notice it.
  addColumn('title',                   `title TEXT`);
  addColumn('photo',                   `photo TEXT`);
  // ISO-8601 `YYYY-MM-DD`, stored verbatim — NOT a Unix-ms timestamp. Address
  // books routinely carry a year-less birthday ("March 4th"), which no epoch
  // field can represent.
  addColumn('birthday',                `birthday TEXT`);
  // Per-field provenance — `{ "<field>": { source, source_id } }`. Generalizes
  // `company_source` (the lone, company-only provenance column) to every field.
  addColumn('projection_provenance',   `projection_provenance TEXT`);

  // Backfill `contact_id` for legacy rows. SQLite's lower(hex(randomblob(16)))
  // emits 32-hex-character ULIDs without external code; idempotent on
  // every boot by virtue of the WHERE clause. New rows get their
  // contact_id assigned at INSERT time via the prepared statement
  // below — the backfill exists only for pre-PA8 dev databases.
  db.exec(
    `UPDATE ${CONTACT_TABLE}
       SET contact_id = lower(hex(randomblob(16)))
       WHERE contact_id IS NULL OR contact_id = ''`,
  );

  // Predicate-scan blocking-key indexes. Cheap to add (sparse on NULL
  // columns) and the housekeeping scan needs them — without them a
  // 50K-contact graph would cartesian-evaluate the predicate.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contacts_merged_into
      ON ${CONTACT_TABLE} (merged_into);
    CREATE INDEX IF NOT EXISTS idx_contacts_phone
      ON ${CONTACT_TABLE} (phone);
    CREATE INDEX IF NOT EXISTS idx_contacts_name_key
      ON ${CONTACT_TABLE} (name_key);
    CREATE INDEX IF NOT EXISTS idx_contacts_address_zip_country_key
      ON ${CONTACT_TABLE} (address_zip_country_key);
    CREATE INDEX IF NOT EXISTS idx_contacts_company_norm
      ON ${CONTACT_TABLE} (company_norm);
  `);

  // D-167 §1.A — prompt-cache prefetch index. Two derived indexes over the
  // already-durable contacts table (no new at-rest secret), both kept auto-fresh by
  // triggers on ${CONTACT_TABLE} (the work-entity-store idiom) — so there are NO JS
  // write-path hooks to miss across the many contact writers (observe / manual /
  // merge-fields / mention-only). They replace the recency-capped scan for prefetch
  // SEARCH: retrieval is store-wide + complete at any warehouse size, so the §2
  // ambiguity gate no longer fails closed above 10k contacts.
  //
  // `phone_match_forms_json` exposes the JS `phoneMatchDigits` (country-code logic
  // SQL can't express) to the phone-forms triggers as a deterministic scalar
  // returning a JSON array of [full, ...national] match forms. Registered HERE (not
  // only in createContactStore) because ensureContactSchema is also called directly
  // by tests that then write contacts; the triggers resolve the function name at
  // FIRE time, so it must exist on the connection before any write. Re-registration
  // safely replaces in better-sqlite3, so the repeated-call idempotence holds.
  db.function('phone_match_forms_json', { deterministic: true }, (phone: unknown) => {
    const { full, national } = phoneMatchDigits(typeof phone === 'string' ? phone : '');
    return JSON.stringify(full !== undefined ? [full, ...national] : []);
  });
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${CONTACT_FTS_TABLE}
      USING fts5(name, company, content='${CONTACT_TABLE}', content_rowid='rowid',
                 tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER IF NOT EXISTS trg_${CONTACT_TABLE}_ai_fts
      AFTER INSERT ON ${CONTACT_TABLE} BEGIN
        INSERT INTO ${CONTACT_FTS_TABLE}(rowid, name, company)
          VALUES (new.rowid, new.name, new.company);
      END;
    CREATE TRIGGER IF NOT EXISTS trg_${CONTACT_TABLE}_au_fts
      AFTER UPDATE OF name, company ON ${CONTACT_TABLE} BEGIN
        INSERT INTO ${CONTACT_FTS_TABLE}(${CONTACT_FTS_TABLE}, rowid, name, company)
          VALUES('delete', old.rowid, old.name, old.company);
        INSERT INTO ${CONTACT_FTS_TABLE}(rowid, name, company)
          VALUES (new.rowid, new.name, new.company);
      END;
    CREATE TRIGGER IF NOT EXISTS trg_${CONTACT_TABLE}_ad_fts
      AFTER DELETE ON ${CONTACT_TABLE} BEGIN
        INSERT INTO ${CONTACT_FTS_TABLE}(${CONTACT_FTS_TABLE}, rowid, name, company)
          VALUES('delete', old.rowid, old.name, old.company);
      END;

    CREATE TABLE IF NOT EXISTS ${CONTACT_PHONE_FORMS_TABLE} (
      rowid_ref INTEGER NOT NULL,
      form      TEXT NOT NULL,
      PRIMARY KEY (rowid_ref, form)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_contact_phone_forms_form
      ON ${CONTACT_PHONE_FORMS_TABLE} (form);
    CREATE TRIGGER IF NOT EXISTS trg_${CONTACT_PHONE_FORMS_TABLE}_ai
      AFTER INSERT ON ${CONTACT_TABLE} WHEN new.phone IS NOT NULL BEGIN
        INSERT OR IGNORE INTO ${CONTACT_PHONE_FORMS_TABLE}(rowid_ref, form)
          SELECT new.rowid, value FROM json_each(phone_match_forms_json(new.phone));
      END;
    CREATE TRIGGER IF NOT EXISTS trg_${CONTACT_PHONE_FORMS_TABLE}_au
      AFTER UPDATE OF phone ON ${CONTACT_TABLE} BEGIN
        DELETE FROM ${CONTACT_PHONE_FORMS_TABLE} WHERE rowid_ref = old.rowid;
        INSERT OR IGNORE INTO ${CONTACT_PHONE_FORMS_TABLE}(rowid_ref, form)
          SELECT new.rowid, value FROM json_each(phone_match_forms_json(new.phone))
          WHERE new.phone IS NOT NULL;
      END;
    CREATE TRIGGER IF NOT EXISTS trg_${CONTACT_PHONE_FORMS_TABLE}_ad
      AFTER DELETE ON ${CONTACT_TABLE} BEGIN
        DELETE FROM ${CONTACT_PHONE_FORMS_TABLE} WHERE rowid_ref = old.rowid;
      END;
  `);
  // One-time idempotent backfill for a warehouse whose contacts PREDATE this index
  // (a dev DB on older code, or the first time the index lands on an existing
  // warehouse). The triggers only fire on writes, so without this those rows would
  // be invisible to `prefetchCandidates` until each is rewritten — silently
  // disabling fuzzy + phone prefetch after an upgrade. This is idempotent
  // derived-index initialization (not a versioned data migration): a fresh DB no-ops
  // (no contacts → nothing to index; triggers populate as rows land) and an
  // already-built index no-ops (the guards skip), so the only work happens on the
  // upgrade path. Mirrors the `work-entity-store` FTS intent.
  //
  // The FTS "is it built?" probe reads the FTS5 `_docsize` shadow table (one row per
  // INDEXED doc), NOT a plain `SELECT` on the external-content FTS — that reflects
  // CONTENT rows even before the index is built, so it can't distinguish empty from
  // built. `_docsize` is empty until a rebuild/trigger indexes a document.
  const hasContacts = db.prepare(`SELECT 1 FROM ${CONTACT_TABLE} LIMIT 1`).get() !== undefined;
  const ftsBuilt = db.prepare(`SELECT 1 FROM ${CONTACT_FTS_TABLE}_docsize LIMIT 1`).get() !== undefined;
  if (hasContacts && !ftsBuilt) {
    db.exec(`INSERT INTO ${CONTACT_FTS_TABLE}(${CONTACT_FTS_TABLE}) VALUES('rebuild')`);
  }
  const hasPhones = db.prepare(`SELECT 1 FROM ${CONTACT_TABLE} WHERE phone IS NOT NULL LIMIT 1`).get() !== undefined;
  const formsBuilt = db.prepare(`SELECT 1 FROM ${CONTACT_PHONE_FORMS_TABLE} LIMIT 1`).get() !== undefined;
  if (hasPhones && !formsBuilt) {
    db.exec(
      `INSERT OR IGNORE INTO ${CONTACT_PHONE_FORMS_TABLE}(rowid_ref, form)
         SELECT ${CONTACT_TABLE}.rowid, value
           FROM ${CONTACT_TABLE}, json_each(phone_match_forms_json(${CONTACT_TABLE}.phone))
          WHERE ${CONTACT_TABLE}.phone IS NOT NULL`,
    );
  }

  // D-138 P1 — internal lookup tables. Each is the indexed primary;
  // the row-side JSON columns are read-time materializations.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONTACT_PLATFORM_LINK_TABLE} (
      canonical_email TEXT NOT NULL,
      vendor          TEXT NOT NULL,
      platform_id     TEXT NOT NULL,
      state           TEXT NOT NULL,
      linked_at       INTEGER NOT NULL,
      linked_by       TEXT NOT NULL,
      -- D-192 slice 4 — the messenger connection that contributed this link
      -- (NULLABLE: reconciler / merge-redistribution / split links carry no
      -- connection). The retract key: it discriminates same-vendor connections
      -- the (vendor, platform_id) PK cannot. Caveat: the PK still admits only
      -- ONE row (hence one connection_name) per (vendor, platform_id), so if two
      -- same-vendor connections' senders collide on platform_id (a pre-existing
      -- D-138 limitation) the FIRST linker owns the row — the retract is precise
      -- to that granularity. The vendor+connection_name index is created in the
      -- guarded block below (AFTER the column is guaranteed to exist on both
      -- fresh + migrated dev DBs).
      connection_name TEXT,
      PRIMARY KEY (vendor, platform_id)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_platform_link_email
      ON ${CONTACT_PLATFORM_LINK_TABLE} (canonical_email);

    CREATE TABLE IF NOT EXISTS ${CONTACT_REJECTION_TABLE} (
      email_a             TEXT NOT NULL,
      email_b             TEXT NOT NULL,
      rejected_at         INTEGER NOT NULL,
      rejected_by         TEXT,
      source_candidate_id TEXT,
      PRIMARY KEY (email_a, email_b)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_rejection_email_a
      ON ${CONTACT_REJECTION_TABLE} (email_a);
    CREATE INDEX IF NOT EXISTS idx_contact_rejection_email_b
      ON ${CONTACT_REJECTION_TABLE} (email_b);

    CREATE TABLE IF NOT EXISTS ${CONTACT_MERGE_CANDIDATE_QUEUE} (
      id              TEXT PRIMARY KEY,
      email_a         TEXT NOT NULL,
      email_b         TEXT NOT NULL,
      pair_key        TEXT NOT NULL UNIQUE,
      matched_fields  TEXT NOT NULL,
      detected_at     INTEGER NOT NULL,
      detected_by     TEXT NOT NULL,
      status          TEXT NOT NULL,
      resolved_at     INTEGER,
      resolved_by     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contact_merge_candidate_status
      ON ${CONTACT_MERGE_CANDIDATE_QUEUE} (status, detected_at DESC);
  `);

  // D-145 PA8 — UNIQUE-when-not-null index on `contact_id`. Acts as
  // the substrate-level stable identifier; survives email rewrites
  // (mention_only → verified promotion) intact. The legacy email PK
  // stays in place at PA8 — the contact_id-as-PK migration is a
  // forward-looking concern called out in spec § A.4.1 prose but not
  // listed in the PA8 phase scope.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_contact_id
      ON ${CONTACT_TABLE} (contact_id)
      WHERE contact_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_contacts_identity_status
      ON ${CONTACT_TABLE} (identity_status);
  `);

  // ── D-192 C-2 slice 3 — `contact_id` NOT NULL, enforced ───────────────────
  //
  // `contact_id` is the STORAGE IDENTITY now: every contribution in
  // `contact_attribute` / `contact_alias` / `contact_source_blob` keys on it, and
  // none of the three has a SQL FK (the substrate's standing choice — partial
  // unique indexes + a runtime existence check). `ContactRow.contact_id` has been
  // typed `string` since PA8, but nothing ever ENFORCED it: the invariant was
  // held only by the boot backfill above, so a row inserted NULL between boots
  // would make the type a lie and silently orphan every contribution written
  // against it.
  //
  // Why TRIGGERS and not `NOT NULL` on the column: SQLite cannot add a NOT NULL
  // constraint to an existing column, and the only way to change one is to
  // REBUILD the table — which is permanently forbidden here (`contacts_fts` is
  // external-content FTS5 on `rowid`, `contact_phone_forms` is keyed on
  // `rowid_ref`; a rebuild reassigns every rowid and silently desyncs both, and
  // the FTS self-heal guard only fires when the index is EMPTY so it would never
  // recover). `ALTER TABLE ADD COLUMN … NOT NULL` is equally unavailable — it
  // demands a constant DEFAULT, and a contact id is by definition not constant.
  // A BEFORE trigger is the enforcement SQLite actually offers, it costs nothing
  // on the write path, and it fails LOUD.
  //
  // Empty string is guarded alongside NULL: an empty contact_id is exactly as
  // orphaning, and the pre-existing backfill above already treats the two the
  // same. Declared AFTER that backfill so an old dev DB is repaired before the
  // guard can fire on it.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_${CONTACT_TABLE}_contact_id_required_ai
      BEFORE INSERT ON ${CONTACT_TABLE}
      WHEN new.contact_id IS NULL OR new.contact_id = ''
      BEGIN
        SELECT RAISE(ABORT, 'contact_id_required: contacts.contact_id must be non-empty');
      END;
    CREATE TRIGGER IF NOT EXISTS trg_${CONTACT_TABLE}_contact_id_required_au
      BEFORE UPDATE OF contact_id ON ${CONTACT_TABLE}
      WHEN new.contact_id IS NULL OR new.contact_id = ''
      BEGIN
        SELECT RAISE(ABORT, 'contact_id_required: contacts.contact_id must be non-empty');
      END;
  `);

  // D-192 C-2 slice 4 — and it is IMMUTABLE once assigned.
  //
  // `contact_id` is the storage identity: `contact_attribute`, `contact_alias` and
  // `contact_source_blob` all key on it, and none of the three carries a SQL FK. So
  // rewriting a row's `contact_id` does not RENAME a contact — it silently ORPHANS
  // every contribution that contact has ever received, and the projection then
  // materializes the row from an empty set and blanks every column. The row survives
  // looking perfectly healthy; the person's phone number, employer and address are
  // simply gone.
  //
  // Nothing in production does this (the boot backfill above only fills NULLs, which
  // this guard deliberately still permits — that is an ASSIGNMENT, not a re-key).
  // But a test fixture did, harmlessly, for as long as nothing hung off `contact_id`
  // — and the moment slice 3 made it load-bearing, that harmless line started
  // corrupting contacts. It cost a failing test to find. The next one gets a loud
  // abort instead of a quietly emptied contact.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_${CONTACT_TABLE}_contact_id_immutable
      BEFORE UPDATE OF contact_id ON ${CONTACT_TABLE}
      WHEN old.contact_id IS NOT NULL
       AND old.contact_id != ''
       -- Disjoint from the NOT-NULL guard above ON PURPOSE. SQLite does not define
       -- the firing order of two BEFORE triggers on the same column, so overlapping
       -- WHEN clauses would make the ERROR MESSAGE a coin-flip. Blanking raises
       -- contact_id_required; changing raises contact_id_immutable; neither can
       -- shadow the other. (No backticks in here -- this SQL lives inside a JS
       -- template literal and one would terminate it.)
       AND new.contact_id IS NOT NULL
       AND new.contact_id != ''
       AND new.contact_id != old.contact_id
      BEGIN
        SELECT RAISE(ABORT, 'contact_id_immutable: re-keying a contact orphans every contribution keyed on it');
      END;
  `);

  // D-145 PA8 — `contact_alias` substrate. Pre-launch zero-migration:
  // the table is born at PA8, no migration code path. Partial unique
  // indexes per spec § A.4.3 — chat_alias dedup per (contact_id,
  // normalized); platform_id dedup per (contact_id, platform,
  // normalized) AND globally per (platform, normalized) so a single
  // Facebook profile can attach to at most one contact.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONTACT_ALIAS_TABLE} (
      id                       TEXT PRIMARY KEY,
      contact_id               TEXT NOT NULL,
      kind                     TEXT NOT NULL,
      platform                 TEXT,
      alias_pattern            TEXT NOT NULL,
      alias_pattern_normalized TEXT NOT NULL,
      source                   TEXT NOT NULL,
      confidence               REAL NOT NULL DEFAULT 1.0,
      created_at               INTEGER NOT NULL,
      last_resolved_at         INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_alias_chat
      ON ${CONTACT_ALIAS_TABLE} (contact_id, alias_pattern_normalized)
      WHERE kind = 'chat_alias';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_alias_platform_per_contact
      ON ${CONTACT_ALIAS_TABLE} (contact_id, platform, alias_pattern_normalized)
      WHERE kind = 'platform_id';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_alias_platform_global
      ON ${CONTACT_ALIAS_TABLE} (platform, alias_pattern_normalized)
      WHERE kind = 'platform_id';
    CREATE INDEX IF NOT EXISTS idx_chat_alias_pattern
      ON ${CONTACT_ALIAS_TABLE} (alias_pattern_normalized)
      WHERE kind = 'chat_alias';
    CREATE INDEX IF NOT EXISTS idx_platform_id_lookup
      ON ${CONTACT_ALIAS_TABLE} (platform, alias_pattern_normalized)
      WHERE kind = 'platform_id';
    CREATE INDEX IF NOT EXISTS idx_contact_alias_by_contact
      ON ${CONTACT_ALIAS_TABLE} (contact_id, kind);
  `);

  // D-192 slice 4 — converge an existing dev `contact_platform_link` onto the
  // `connection_name` column (the CREATE above only lands it on a fresh DB).
  // Pre-launch zero-migration, guarded by PRAGMA table_info exactly like the
  // `contacts` widen above. The ALTER runs ONLY on an old DB; the covering index
  // is (re)declared UNCONDITIONALLY afterwards (IF NOT EXISTS) — it must NOT sit
  // in the CREATE block, where it would reference `connection_name` before the
  // ALTER on an existing DB and crash boot. By here the column exists on both
  // the fresh (CREATE) and migrated (ALTER) paths, so the index is always safe.
  const linkCols = new Set(
    (db.prepare(`PRAGMA table_info(${CONTACT_PLATFORM_LINK_TABLE})`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (!linkCols.has('connection_name')) {
    db.exec(`ALTER TABLE ${CONTACT_PLATFORM_LINK_TABLE} ADD COLUMN connection_name TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_contact_platform_link_conn
       ON ${CONTACT_PLATFORM_LINK_TABLE} (vendor, connection_name)`,
  );

  // ── D-192 C-2 — the contribution substrate ────────────────────────────────
  //
  // Pre-launch zero-migration: both tables are BORN here, no migration code
  // path (the `contact_alias` precedent at PA8, and the discipline this file
  // already declares). Deliberately additive — NO rebuild of `contacts`.
  //
  // ⚠ Why a rebuild is forbidden, permanently: `contacts_fts` is external-
  // content FTS5 (`content_rowid='rowid'`) and `contact_phone_forms` is keyed on
  // `rowid_ref`. Rebuilding `contacts` — the standard way to change a SQLite PK
  // — reassigns every rowid and SILENTLY desyncs both, and the FTS self-heal
  // guard only fires when the index is EMPTY, so it would never recover. It is
  // also unnecessary: `email TEXT PRIMARY KEY` on a rowid table is just a UNIQUE
  // index, so identity already lives on the implicit rowid. C-2 moves identity
  // to `contact_id` without touching the physical table at all.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONTACT_ATTRIBUTE_TABLE} (
      id          TEXT PRIMARY KEY,
      contact_id  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      value       TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      source      TEXT NOT NULL,
      confidence  REAL NOT NULL DEFAULT 1.0,
      as_of       INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    -- One assertion per (contact, field, SOURCE INSTANCE). A source RESTATING a
    -- field overwrites its OWN prior claim (an upsert) rather than stacking
    -- duplicate rows — but it never touches another source's claim, which is the
    -- whole point of the contribution model.
    --
    -- The key is source_id (WHO), NOT source (the trust RUNG). Google Contacts
    -- and Outlook Contacts are both address_book; HubSpot and Salesforce are
    -- both vendor_meta. Keying on the rung would collide two peer sources onto
    -- one row so they overwrite each other every sync cycle, and the projection
    -- would ping-pong between their values — exactly the silent
    -- last-writer-wins loss this store exists to prevent.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_attribute_origin
      ON ${CONTACT_ATTRIBUTE_TABLE} (contact_id, kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_contact_attribute_by_contact
      ON ${CONTACT_ATTRIBUTE_TABLE} (contact_id, kind);
    -- Source teardown — purge a disconnected Source's contributions.
    CREATE INDEX IF NOT EXISTS idx_contact_attribute_by_source
      ON ${CONTACT_ATTRIBUTE_TABLE} (source_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONTACT_SOURCE_BLOB_TABLE} (
      id            TEXT PRIMARY KEY,
      contact_id    TEXT NOT NULL,
      vendor        TEXT NOT NULL,
      remote_id     TEXT NOT NULL,
      blob          TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      as_of         INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_source_blob_by_contact
      ON ${CONTACT_SOURCE_BLOB_TABLE} (contact_id);
  `);

  // D-192 C-2 slice 6a — RE-KEY the mirror from `(vendor, remote_id)` to
  // `(source_id, remote_id)`.
  //
  // Slice 1 keyed the blob on the VENDOR. That is the same defect
  // `contact_attribute` was deliberately built to avoid one door over: a vendor
  // is not an identity. Two D-125 connections to ONE vendor are TWO Sources with
  // INDEPENDENT record-id spaces — a Salesforce sandbox + prod pair (D-130 ships
  // exactly that toggle), two HubSpot portals, two Google accounts. Under a
  // vendor key their records collide on one row; and the sync's delete diff is
  // far worse than the collision, because each Source's walk would see the
  // OTHER's records as absent and tombstone them — every cycle, forever
  // (`listContactSourceBlobHashes` returned the whole vendor's map).
  //
  // Safe to re-key in place: the blob API has ZERO production callers today (the
  // `contact_import` sync is its first consumer, and it lands in 6b), so the
  // table is empty in any real database. Nullable column + a write-site guard —
  // SQLite cannot ADD a NOT NULL column, and declaring it NOT NULL only in the
  // CREATE TABLE would leave fresh and altered databases with DIFFERENT schemas,
  // which is exactly how a constraint silently stops holding. Mirrors how
  // `contact_alias.source_id` was added.
  const sourceBlobCols = new Set(
    (
      db.prepare(`PRAGMA table_info(${CONTACT_SOURCE_BLOB_TABLE})`).all() as { name: string }[]
    ).map((r) => r.name),
  );
  if (!sourceBlobCols.has('source_id')) {
    db.exec(`ALTER TABLE ${CONTACT_SOURCE_BLOB_TABLE} ADD COLUMN source_id TEXT`);
  }

  // D-205 §1 — the SOFT MARK. A vendor deleting their record disconnects the
  // linkage and NOTHING ELSE: the contributions it made stay, so this blob stays
  // too. It is the evidence behind claims that now stand on their own, and
  // hard-deleting it would keep the claim while destroying the receipt.
  //
  // Nullable by construction — NULL is "still there", which is what every
  // existing row is.
  if (!sourceBlobCols.has('disconnected_at')) {
    db.exec(`ALTER TABLE ${CONTACT_SOURCE_BLOB_TABLE} ADD COLUMN disconnected_at INTEGER`);
  }

  db.exec(`
    -- The old vendor-keyed unique index MUST go, not merely be superseded: while
    -- it exists, two Sources of one vendor still collide on it and the re-key
    -- buys nothing.
    DROP INDEX IF EXISTS uq_contact_source_blob_remote;
    -- The mirror key. Unique WITHIN a Source: ONE remote record maps to at most
    -- one local contact, so a re-import can never fan a single CRM contact across
    -- two people. Re-pointing it at a different contact_id (a merge absorbed it)
    -- is an UPDATE of this row, not a second row.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_source_blob_source_remote
      ON ${CONTACT_SOURCE_BLOB_TABLE} (source_id, remote_id);
    -- The incremental seam — the reconciler reads (remote_id -> snapshot_hash)
    -- for ITS OWN Source once per cycle to skip unchanged remote records (the
    -- file-family idiom).
    CREATE INDEX IF NOT EXISTS idx_contact_source_blob_hash
      ON ${CONTACT_SOURCE_BLOB_TABLE} (source_id, remote_id, snapshot_hash);
  `);

  // D-192 C-2 — `contact_alias.source_id`: provenance's other half (WHO), the
  // twin of `contact_attribute.source_id`. `source` alone is a trust RUNG, and a
  // rung cannot say which of two contact books supplied a phone. Without this
  // the projection would have to FABRICATE a source instance for every alias —
  // and provenance that lies is worse than provenance that is absent, because a
  // surface renders it as fact. It is also what makes alias TEARDOWN possible
  // when a Source is disconnected. Nullable: a writer with no Source behind it
  // records none, and the projection then honestly reports "unknown".
  const aliasCols = new Set(
    (db.prepare(`PRAGMA table_info(${CONTACT_ALIAS_TABLE})`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (!aliasCols.has('source_id')) {
    db.exec(`ALTER TABLE ${CONTACT_ALIAS_TABLE} ADD COLUMN source_id TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_contact_alias_by_source
       ON ${CONTACT_ALIAS_TABLE} (source_id)`,
  );

  // D-192 C-2 — the identifier-axis indexes for the two new `contact_alias`
  // kinds. These MUST land with the kinds themselves: the vocabulary and its
  // enforcement are one fact. `email_alias` is globally unique on the
  // normalized value — an email address identifies AT MOST ONE person, which is
  // precisely what lets `merged_into`'s redirect-chain walk collapse into a
  // single indexed lookup (slice 4). `phone_alias` is deliberately NOT globally
  // unique: a shared household or office line legitimately belongs to several
  // people, so it dedups per-contact only.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_alias_email_global
      ON ${CONTACT_ALIAS_TABLE} (alias_pattern_normalized)
      WHERE kind = 'email_alias';
    CREATE INDEX IF NOT EXISTS idx_contact_alias_email_lookup
      ON ${CONTACT_ALIAS_TABLE} (alias_pattern_normalized)
      WHERE kind = 'email_alias';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_alias_phone_per_contact
      ON ${CONTACT_ALIAS_TABLE} (contact_id, alias_pattern_normalized)
      WHERE kind = 'phone_alias';
    CREATE INDEX IF NOT EXISTS idx_contact_alias_phone_lookup
      ON ${CONTACT_ALIAS_TABLE} (alias_pattern_normalized)
      WHERE kind = 'phone_alias';
  `);
};

interface ContactRow {
  email: string;
  name: string | null;
  first_seen: number;
  last_interaction: number;
  interaction_count: number;
  source: ContactSource;
  created_at: number;
  updated_at: number;
  // D-138 P1 columns
  platform_ids: string;
  rejected_pairs: string;
  merged_into: string | null;
  phone: string | null;
  mailing_address: string | null;
  company: string | null;
  company_source: ContactCompanySource | null;
  name_key: string | null;
  address_zip_country_key: string | null;
  company_norm: string | null;
  // D-145 PA8 columns
  contact_id: string;
  identity_status: ContactIdentityStatus;
  network_domain: string;
  // D-145 PB11 column — JSON blob of PersonalRecipeEntry[]
  personal_recipes: string;
  // D-161 P1 — origin provenance facet (NOT NULL DEFAULT 'system').
  origin_actor: string;
  origin_contract_id: string | null;
  // D-177 N.11 rule 1 — write surface (NOT NULL DEFAULT 'system').
  origin_surface: string;
  // D-192 C-2 — projected attribute columns + per-field provenance blob.
  title: string | null;
  photo: string | null;
  birthday: string | null;
  projection_provenance: string | null;
}

interface ContactAliasRow {
  id: string;
  contact_id: string;
  kind: ContactAliasKind;
  platform: ContactAliasPlatform | null;
  alias_pattern: string;
  alias_pattern_normalized: string;
  source: ContactAliasSource;
  // D-192 C-2 — the source INSTANCE (WHO). Nullable: a writer with no Source
  // behind it records none, and the projection reports "unknown" rather than
  // fabricating one.
  source_id: string | null;
  confidence: number;
  created_at: number;
  last_resolved_at: number | null;
}

interface PlatformLinkRow {
  canonical_email: string;
  vendor: string;
  platform_id: string;
  state: 'auto' | 'confirmed';
  linked_at: number;
  linked_by: string;
  connection_name: string | null;
}

interface RejectionRow {
  email_a: string;
  email_b: string;
  rejected_at: number;
  rejected_by: string | null;
  source_candidate_id: string | null;
}

interface MergeCandidateRow {
  id: string;
  email_a: string;
  email_b: string;
  pair_key: string;
  matched_fields: string;
  detected_at: number;
  detected_by: string;
  status: 'pending' | 'merged' | 'rejected';
  resolved_at: number | null;
  resolved_by: string | null;
}

const safeParseJsonArray = <T>(raw: string | null): T[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

const safeParseJsonObject = <T>(raw: string | null): T | undefined => {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as T) : undefined;
  } catch {
    return undefined;
  }
};

const rowToRecord = (row: ContactRow): ContactRecord => {
  // PA8 — synthetic placeholder emails for mention_only contacts surface
  // as the substrate-level marker for "no canonical email yet". The
  // public ContactRecord shape preserves the existing `email` field
  // contract (`string`) by leaving the placeholder visible — callers
  // that care about deliverable-vs-not check `identity_status`. A
  // future contact_id-as-PK migration may flip `email` to `string |
  // undefined` end-to-end; PA8 keeps the substrate type stable.
  const record: ContactRecord = {
    _id: row.email,
    _collection: 'contact',
    email: row.email,
    first_seen: row.first_seen,
    last_interaction: row.last_interaction,
    interaction_count: row.interaction_count,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
    platform_ids: safeParseJsonArray<PlatformIdEntry>(row.platform_ids),
    contact_id: row.contact_id,
    identity_status: row.identity_status,
    network_domain: safeParseJsonArray<NetworkDomain>(row.network_domain),
  };
  if (row.name !== null) record.name = row.name;
  const rejected = safeParseJsonArray<string>(row.rejected_pairs);
  if (rejected.length > 0) record.rejected_pairs = rejected;
  if (row.merged_into) record.merged_into = row.merged_into;
  if (row.phone) record.phone = row.phone;
  const addr = safeParseJsonObject<MailingAddress>(row.mailing_address);
  if (addr) record.mailing_address = addr;
  if (row.company) record.company = row.company;
  if (row.company_source) record.company_source = row.company_source;
  // D-192 C-2 — projected attribute fields. Absent column ⇒ absent field: no
  // contribution asserts it, which is not the same as asserting it is empty.
  if (row.title) record.title = row.title;
  if (row.photo) record.photo = row.photo;
  if (row.birthday) record.birthday = row.birthday;
  const provenance = safeParseJsonObject<ContactProjectionProvenance>(
    row.projection_provenance,
  );
  if (provenance) record.projection_provenance = provenance;
  if (row.name_key) record.name_key = row.name_key;
  if (row.address_zip_country_key) record.address_zip_country_key = row.address_zip_country_key;
  if (row.company_norm) record.company_norm = row.company_norm;
  // PB11 § B.12.1 — surface personal_recipes only when the blob holds
  // entries. Empty / malformed JSON → leave the field undefined so
  // callers can `record.personal_recipes ?? []` without distinguishing
  // "no bindings" from "never read the blob".
  const personalRecipes = safeParseJsonArray<PersonalRecipeEntry>(row.personal_recipes);
  if (personalRecipes.length > 0) record.personal_recipes = personalRecipes;
  // D-161 P1 — origin provenance facet. Column is NOT NULL DEFAULT
  // 'system'; the `?? 'system'` guards a row read before the migration.
  record.origin_actor = isActor(row.origin_actor) ? row.origin_actor : 'system';
  if (row.origin_contract_id) record.origin_contract_id = row.origin_contract_id;
  // D-177 N.11 rule 1 — write surface; unknown stored values read as
  // 'system' (fail closed at the cleanliness gate).
  record.origin_surface = isOriginSurface(row.origin_surface)
    ? row.origin_surface
    : 'system';
  return record;
};

/** One observation that touches a contact — the unit the mail /
 *  calendar derivers feed into the store. `event_at` is the source
 *  record's real-world event time so first-seen carries bistemporal
 *  chronology rather than today's ingestion clock. */
export interface ContactObservation {
  email: string;
  name?: string;
  /** 🔑 **Every IMPORT source is EXCLUDED, at the type, deliberately (D-205 #4/#5).**
   *
   *  `observe` is the WAREHOUSE-TRAFFIC path: it carries no `source_id`, so the
   *  contributions it writes are attributed via `contributionSourceIdForRung`,
   *  which maps every non-`manual` rung to `recued.derived`. Feed it an IMPORT
   *  and you get two failures at once — a provenance LIE (Recued did not derive
   *  this from a mail header; Google asserted it) and a COLLISION on
   *  `(contact_id, kind, source_id)` with the contact's real derived rows.
   *
   *  An import creates through `createImportedContact` (row only) and lets the
   *  sync's write pass supply every contribution at the declaration's rung with
   *  the Source's own id. This exclusion is what makes that unmissable rather
   *  than a comment nobody reads. */
  source: ContactObservedSource;
  event_at: number;
}

export interface ManualUpsertInput {
  email: string;
  name?: string;
  /** Optional override for `last_interaction` (defaults to `now`). */
  last_interaction?: number;
  /** Optional override for `first_seen` (defaults to `now`). */
  first_seen?: number;
  /** D-138 P1 — manual phone (E.164 already; caller canonicalizes). */
  phone?: string;
  /** D-138 P1 — manual structured mailing address (caller canonicalizes). */
  mailing_address?: MailingAddress;
  /** D-138 P1 — manual company name. Sets `company_source = 'manual'`. */
  company?: string;
  /** D-205 #5c — the three fields `ContactRecord` has carried since D-192 C-2 and
   *  that NO writer could supply. A vCard carries all three, and the contact dialog
   *  could not accept a job title. An ABSENT field means "not supplied" and
   *  contributes nothing — never "set it to empty". */
  title?: string;
  /** A URL, never bytes (C-2's North star). */
  photo?: string;
  /** ISO-8601 `YYYY-MM-DD`, verbatim — "March 4th, year unknown" is a real vCard
   *  value and a timestamp cannot hold it. */
  birthday?: string;
}

export interface ContactListQuery {
  name_contains?: string;
  /** D-167 B3 — case-insensitive substring match on the `company` column,
   *  the org-scoped contact search (so a `pii.Org` alias the chat boundary
   *  routes here, or a raw org name, finds contacts at that company).
   *  Combines with the other filters with AND. */
  company_contains?: string;
  source?: ContactSource;
  since?: number;
  /** D-145 PA8 follow-on — exact match on the `phone` column. Caller
   *  pre-canonicalizes to E.164 (same discipline as
   *  `ManualUpsertInput.phone`). Combines with the other filters with
   *  AND. */
  phone_exact?: string;
  limit?: number;
  offset?: number;
}

/** D-145 PA8 follow-on — alias-lookup input for `findByAlias`. When
 *  `platform` is supplied the lookup hits the `platform_id` substrate
 *  branch (cross-contact globally unique per § A.4.3); omitting
 *  `platform` runs the `chat_alias` branch through the resolver, which
 *  may surface 0..N alternatives. */
export interface ContactAliasLookupInput {
  alias_pattern: string;
  platform?: ContactAliasPlatform;
  /** Optional context forwarded to the resolver — recent contacts +
   *  network-domain hint used to break chat_alias ties. Defaults to an
   *  empty `recent_contacts: []` when omitted. */
  context?: ContactReferenceContext;
}

/** D-145 PA8 follow-on — alias-lookup result. `contact` is the
 *  unambiguous match (when the resolver returns a single candidate);
 *  `alternatives` carries the per-candidate records the caller should
 *  disambiguate against. Both null + empty array on no-match. */
export interface ContactAliasLookupResult {
  contact: ContactRecord | null;
  confidence: number;
  alternatives: readonly ContactRecord[];
}

/** D-145 PA8 follow-on — phone-lookup result. Mirrors
 *  `ContactAliasLookupResult` so the caller's disambiguation code-path
 *  is identical: `contact` populated + `alternatives` empty on a
 *  unique match, both empty on no-match, `contact` null +
 *  `alternatives` populated when multiple non-tombstoned contacts
 *  share the phone (transitional pre-D-138-merge state). */
export interface ContactPhoneLookupResult {
  contact: ContactRecord | null;
  confidence: number;
  alternatives: readonly ContactRecord[];
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** D-167 follow-on — the per-turn ceiling for the prompt-cache prefetch's
 *  whole-warehouse scan (`listForPrefetchScan`), DISTINCT from the general
 *  `list()` cap (`MAX_LIMIT`, a UI-page safety ceiling). The prefetch must scan
 *  EVERY contact to find a token / identifier match, so clamping it to 1000 was
 *  a silent COVERAGE cap (contacts past the 1000 most-recent were never
 *  prefetched, and the adapter's `scanComplete` gate disabled ALL phone matching
 *  above it). A lean raw scan stays well under budget at this size — M2 measured
 *  ~3.7ms @ 10k for the email/name/phone/company projection — so this lifts the
 *  cap 10× to cover realistic personal warehouses. Beyond it, `scanComplete`
 *  honestly degrades again (coverage capped, phone matching suppressed) — the FTS
 *  (`unicode61 remove_diacritics 2`) path is the next step for >10k warehouses
 *  (D-167 §6 / §6.1). */
const PREFETCH_SCAN_MAX = 10000;

/** D-167 §1.A — PER-TOKEN cap on FTS5(name/company) candidate rows fed to the
 *  scorer: each query token is matched + capped independently, so a flooding token
 *  (an org shared by thousands of recent contacts) can't starve a rarer token's
 *  matches out of the result. Generous — the scorer outputs only `limit` (≈3) and
 *  the §2 gate needs just ≥2 matchers of a token to flag it ambiguous, so a token
 *  over this cap still retrieves ≥2 matchers → correctly ambiguous (no global
 *  truncation signal needed). The kept rows are the most-recent matches (the FTS leg
 *  orders by `last_interaction`). Email (PK) + phone-form retrieval are exact. */
export const PREFETCH_FTS_LIMIT = 1000;

/** D-167 follow-on — the LEAN row the prefetch scan returns. Only the four
 *  columns the contact-backed `EntitySearchPort` scores on (name / company fuzzy
 *  + phone / email exact), so the whole-warehouse scan skips the per-row
 *  `rowToRecord` JSON parsing (`platform_ids` / `network_domain` / …) that a
 *  full `ContactRecord` carries — that parsing × up-to-10k rows every turn is the
 *  cost `listForPrefetchScan` avoids vs `list()`. `email` is the table PK so it
 *  is always present; the rest are nullable columns surfaced as optional. */
export interface PrefetchScanRow {
  email: string;
  name?: string;
  phone?: string;
  company?: string;
}

/** D-167 §1.A — parsed query for the index-backed prefetch retrieval. `tokens` are
 *  the normalised content unigrams (matched against the name/company FTS); `forms`
 *  are the digit-strings to match against `contact_phone_forms` (the query's bare
 *  numeric tokens ∪ reconstructed phone runs — a superset of what the scorer's phone
 *  block can hit); `emails` are canonical addresses for the exact PK lookup. Any
 *  field may be empty; an all-empty query yields no rows. */
export interface PrefetchIndexQuery {
  tokens: readonly string[];
  forms: readonly string[];
  emails: readonly string[];
}

/** D-167 (recall path, off-cap) — text-extracted identifier candidates to resolve
 *  against the WHOLE warehouse for memory-recall aliasing. `emails` are
 *  canonicalised addresses (exact PK lookup); `forms` are `phoneMatchDigits`
 *  digit-strings (matched against `contact_phone_forms`). Both legs are exact +
 *  store-wide (no cap), so a recalled identifier resolves regardless of warehouse
 *  size — the store-wide replacement for the prefetch-capped pre-seed-everything
 *  recall index. */
export interface RecallIdentifierQuery {
  emails: readonly string[];
  forms: readonly string[];
}

/** D-167 (recall path, off-cap) — the canonical STORED identifier forms of the
 *  contacts a `RecallIdentifierQuery` matched: `emails` are canonical addresses,
 *  `phones` canonical E.164. These become the recall `KnownValueIdentifierSeed`s —
 *  bounded by the (small) recalled text, never the warehouse. */
export interface RecallIdentifierMatches {
  emails: string[];
  phones: string[];
}

export interface ContactWriteOptions {
  silent?: boolean;
  /** D-210 audit finding 5 — the rung to attribute this write's ATTRIBUTE
   *  contributions to, when the values did NOT come from the owner's hands.
   *  Absent ⇒ `manual`, which is correct for the `contact.upsert` rpc: a paired
   *  client calling it IS the owner typing.
   *
   *  ⛔ SERVER-DETERMINED, exactly like the origin facets above — never read from
   *  an rpc payload. A caller able to choose its own provenance rung could park a
   *  guess at the top of the ladder, which is the whole failure this ladder exists
   *  to prevent.
   *
   *  The intake→contact destination sets `'derived'`: the name is text a VISITOR
   *  typed about themselves at a public door, and it is not shown to the owner at
   *  approval (`intake.materialize` exposes only title / body / destination), so
   *  nothing about it is owner-asserted. Recording it as `manual` put it at rank 0
   *  — above `user_confirmed`, above CRM — where it outranked every future
   *  correction, forever.
   *
   *  🔑 This is the same judgement the no-name branch of `upsertManualInner`
   *  already makes for the email local-part fallback, in its own words: "the user
   *  did not TYPE that, so recording it as `manual` would be a lie with teeth."
   *
   *  ⏭ `derived`'s doc says "nobody ASSERTED it", and a visitor asserting their
   *  own name is not quite that — it is closer than `manual` on every axis that
   *  matters, but a truthful `self_reported` rung would be better. Adding one is
   *  deliberately NOT done here: the array order IS the rank, so inserting a rung
   *  silently re-ranks everything below it, and D-138 gates its inference pool on
   *  specific rungs. That is an owner call, not a fix-it. */
  attribution_source?: 'derived';
  /** D-161 P2 — origin provenance facet. The mail / calendar `observe*`
   *  sync paths omit it → `'system'` (the column default). The manual
   *  `contact.upsert` rpc handler passes `'user_self'` (a paired-client
   *  rpc arrives on the `user` channel by construction). SERVER-
   *  DETERMINED — never read from the rpc payload (I-6 / A.5).
   *
   *  D-177 N.11 rule 1 — `upsertManual` now RE-STAMPS all three origin
   *  facets on EVERY write (create AND update): the stored-cleanliness
   *  gate reads the row's LAST writer, so an agent edit of a
   *  user-created row must demote it (the pre-D-177 genesis-only stamp
   *  would have let an agent rewrite e.g. `phone` while the row kept
   *  reading `'user_self'` — the rev-8 laundering, via update). The
   *  observe / sync paths still never touch the facets (an interaction
   *  bump isn't authorship). */
  origin_actor?: Actor;
  /** D-161 P2 — contract in force on the writing execution; paired with
   *  `origin_actor`, present iff contracted. */
  origin_contract_id?: string;
  /** D-177 N.11 rule 1 — the write surface (see
   *  `ORIGIN_SURFACES` in contracts). `'client_rpc'` from the direct
   *  paired-client rpc handler; `'engine'` from the recipe-run kernel
   *  dispatch; absent → `'system'`. SERVER-DETERMINED, same boundary as
   *  `origin_actor`. */
  origin_surface?: OriginSurface;
}

/** D-138 P1 — input shape for inserting a confirmed-linked platform
 *  record entry. Reconciler ingest emits `state: 'auto'` + `linked_by:
 *  'reconciler:<vendor>'`; user merge UI emits `state: 'confirmed'` +
 *  `linked_by: 'user:<canonical_email>'`. */
export interface PlatformLinkInput {
  canonical_email: string;
  vendor: string;
  platform_id: string;
  state: 'auto' | 'confirmed';
  linked_at: number;
  linked_by: string;
  /** D-192 slice 4 — the messenger connection that contributed this link, so a
   *  per-connection retract can cut it precisely (the `(vendor, platform_id)` PK
   *  cannot tell two same-vendor connections apart). Only the messenger inbound
   *  linker stamps it; reconciler / merge-redistribution / split writers omit it
   *  (they carry no single connection). */
  connection_name?: string;
}

/** D-138 P1 — input shape for inserting a rejection edge between two
 *  canonical contacts. The substrate enforces `email_a <= email_b`
 *  lexicographically; callers may pass in any order and the helper
 *  re-orders. */
export interface RejectionInput {
  email_a: string;
  email_b: string;
  rejected_at: number;
  rejected_by?: string;
  source_candidate_id?: string;
}

/** D-138 P1 — input shape for enqueueing a merge candidate row. */
export interface MergeCandidateInput {
  id: string;
  email_a: string;
  email_b: string;
  matched_fields: ContactMatchField[];
  detected_at: number;
  detected_by: ContactMergeCandidate['detected_by'];
}

/** D-138 P1 — query shape for listing merge candidates. */
export interface MergeCandidateListQuery {
  status?: 'pending' | 'merged' | 'rejected';
  limit?: number;
  cursor?: string;
}

/** D-138 P1 — domain-inference seed-pool result. `'inferred'` carries
 *  the company name to copy onto the freshly-ingested row when the
 *  pool has exactly one distinct company under that domain seeded by
 *  `vendor_meta` / `manual` rows. `'ambiguous'` means the pool size
 *  exceeded `COMPANY_DOMAIN_INFERENCE_MAX_DISTINCT_COMPANIES`, so the
 *  domain is treated as a consumer provider and inference is
 *  suppressed. */
export type CompanyDomainResolution =
  | { kind: 'inferred'; company: string }
  | { kind: 'empty' }
  | { kind: 'ambiguous' };

/** A contribution as the projection sees it — the contract shape PLUS the source
 *  instance. Typing the array as this (rather than the bare `ContactContribution`)
 *  is what lets `resolveContributionsByKind` — generic over the CONTRIBUTION type,
 *  not just the value — hand `source_id` back on the winner instead of erasing it
 *  and forcing a cast.
 *
 *  Module-scoped (it was local to the factory) so `listProjectionContributions` can
 *  appear on the `ContactStore` interface: the projection's input is now a READ
 *  surface too, not just an internal step. */
export type ProjectionContribution = ContactContribution<unknown> & {
  source_id?: string;
};

export interface ContactStore {
  observe(obs: ContactObservation, now?: number, opts?: ContactWriteOptions): ContactRecord;
  observeBatch(obs: readonly ContactObservation[], now?: number, opts?: ContactWriteOptions): number;
  upsertManual(input: ManualUpsertInput, now?: number, opts?: ContactWriteOptions): ContactRecord;
  get(email: string): ContactRecord | null;
  list(query?: ContactListQuery): ContactRecord[];
  /** D-167 follow-on — the prompt-cache prefetch's whole-warehouse scan. Returns
   *  LEAN rows (email / name / phone / company only — no `rowToRecord` parse)
   *  ordered by `last_interaction DESC`, capped at `PREFETCH_SCAN_MAX` (10000),
   *  NOT the general `list()` `MAX_LIMIT` (1000). This is what lifts the silent
   *  prefetch coverage cap: contacts past the first 1000 are now scanned (and the
   *  adapter's `scanComplete` phone gate holds true) for warehouses up to the
   *  ceiling. `limit` (tests) further caps but never EXCEEDS `PREFETCH_SCAN_MAX`. */
  listForPrefetchScan(limit?: number): PrefetchScanRow[];
  /** D-167 §1.A — index-backed prefetch retrieval (replaces the brute scan for the
   *  prompt-cache prefetch SEARCH). Returns the LEAN rows that COULD score > 0 for
   *  the query — the union of FTS5(name/company) matches, exact email-PK matches,
   *  and `contact_phone_forms` matches — deduped by contact. Store-wide + complete
   *  at any warehouse size (no recency cap), so the adapter passes `scanComplete:
   *  true` and the §2 ambiguity gate no longer fails closed above 10k. The FTS leg
   *  is matched PER TOKEN, each bounded by `PREFETCH_FTS_LIMIT`; email/phone legs
   *  are exact. */
  prefetchCandidates(query: PrefetchIndexQuery): PrefetchScanRow[];
  /** D-167 §1.A — store-wide count of DISTINCT contacts whose phone reduces to
   *  `form` (via `contact_phone_forms`). The scorer's `isUnique` oracle: `=== 1`
   *  means the phone form maps to exactly one contact across the WHOLE warehouse,
   *  replacing the old page-local count so phone-identifier matching stays enabled
   *  past 10k. */
  countPhoneForm(form: string): number;
  /** D-167 (recall path, off-cap) — enumerate EVERY contact's `name` + `company`
   *  (uncapped, no recency page) for the whole-warehouse memory-recall name/org
   *  Aho-Corasick automaton. Distinct from `listForPrefetchScan` (capped at
   *  `PREFETCH_SCAN_MAX`, recency-ordered, email/phone too): the recall automaton
   *  build is flat to the value count + memoised once per recalling turn, so it
   *  scans the whole warehouse with no cap (the A-C was designed for 100k values).
   *  Each list holds only non-empty values; a contact with neither contributes
   *  nothing. */
  listAllNamesAndCompanies(): { names: string[]; companies: string[] };
  /** D-167 (recall path) — the whole-warehouse recall seed sources that are NOT names/orgs:
   *
   *    · `streets` — the STREET LINES from `mailing_address` (`address1` / `address2`). Street
   *      lines are multi-token and distinctive, so they ride the same A-C as names/orgs.
   *      Postcodes are deliberately excluded (all digits → they collide with invoice numbers,
   *      and the content pass refuses to blind-match any all-digit value), as are city / state
   *      / country — single common tokens that would over-alias, and which the owner's ruling
   *      keeps VISIBLE so the model stays location-aware.
   *    · `domains` — the DISTINCT email domains of every contact. These are the anchors that
   *      let a URL alias on the recall path: a memory body linking `https://acme.com/portal`
   *      egresses raw unless `acme.com` is a known domain. KNOWN-ONLY on purpose — unlike an
   *      email, a URL is usually NOT PII, and seeding every URL would alias
   *      `docs.python.org` and blind the model to public links.
   *
   *  Uncapped, like `listAllNamesAndCompanies` — under-returning a PII seed set is a leak, not
   *  a smaller answer. */
  listRecallAddressSeeds(): { streets: string[]; domains: string[] };
  /** D-167 (recall path, off-cap) — resolve text-extracted identifier candidates to
   *  the canonical stored forms of the contacts they match, STORE-WIDE + exact (no
   *  cap). The text-driven replacement for the recall index's old
   *  pre-seed-every-identifier behaviour (which ballooned the session ledger + cost
   *  ~1s/turn at 10k): only identifiers actually present in the recalled text are
   *  looked up, so the result is bounded by the text, never the warehouse. */
  resolveRecallIdentifiers(query: RecallIdentifierQuery): RecallIdentifierMatches;
  walkByEmail(after_email: string, batch_size: number): ContactRecord[];
  delete(email: string, opts?: ContactWriteOptions): boolean;
  /** Row count. With a query, counts only the rows a `list()` with the same
   *  filter would return (drives the UI's "Showing N of M" + load-more); no
   *  arg → the whole-table count. `limit` / `offset` on the query are ignored. */
  count(query?: ContactListQuery): number;
  // D-138 P1 — resolver + platform link + rejection + queue surface.
  /** Walk `merged_into` to the terminal canonical row. Returns the
   *  survivor's canonical email + chain depth. Throws on cycle. */
  resolveCanonicalEmail(email: string): { canonical_email: string; chain_depth: number };
  /** The reverse MERGE walk — every tombstone email whose `merged_into`
   *  chain terminates at the supplied contact (transitive: with A→B→C,
   *  asking for C surfaces both A and B). Caller passes a CANONICAL (live)
   *  row's email; a tombstone input surfaces only its own sub-tree. Returns
   *  raw stored emails (mention-only placeholders included — callers
   *  filter), email-ascending; `[]` for an unknown / unmergeable email.
   *
   *  ⚠ **This is the MERGE half only, and it is NOT the contact's address
   *  set.** It once claimed to be ("together with its own canonical email
   *  they form the contact's complete linked address set") and that claim was
   *  wrong: an address also joins a person by being ATTACHED as an
   *  `email_alias` (an import supplying a second address) or RETIRED into one
   *  (a promotion re-keying the `email` PK). Neither is a tombstone, so
   *  neither appears here. **For "every address this person answers to", call
   *  {@link ContactStore.addressSet} — it is the complete set, and it cannot
   *  be misread this way.** This method stays for the one question it does
   *  answer: *what merged into this?* */
  listMergedSourceEmails(email: string): string[];
  /** D-205 #3.5b — **every address this contact answers to**: its canonical
   *  address, every address merged away into it, and every `email_alias` of
   *  the whole merge group. The reverse of the slice-4 resolver, and the value
   *  any reverse read ("given this contact, find its rows") must scope by.
   *
   *  Pass whatever address a row is keyed on — a `ContactRecord.email`, a
   *  stored `assigned_contact_id`, a promotion-retired synthetic. The walk
   *  resolves it to its owning contact (through the alias index if it is no
   *  longer a PK), forward-resolves any merge chain, then expands. Ascending
   *  order; `[]` only for an un-canonicalizable input.
   *
   *  ⚠ Returns raw stored addresses — the `mention-only-…@_recued.invalid`
   *  placeholder included. A caller that must not show one to a human, or
   *  must not hand one to a model, filters it (`chat-prompt-cache-gate` does).
   *  It is in the set on purpose: rows written while the contact was
   *  `mention_only` are still keyed on it. */
  addressSet(email: string): string[];
  /** Insert or replace a `(vendor, platform_id)` link onto a canonical
   *  contact. Idempotent — re-inserting the same `(vendor, platform_id)`
   *  preserves the older `linked_at`. Re-materializes the row's
   *  `platform_ids` JSON column. */
  linkPlatformId(input: PlatformLinkInput, now?: number): void;
  /** Remove a `(vendor, platform_id)` link from whichever canonical
   *  row carries it. Re-materializes the row's `platform_ids` JSON.
   *  Returns the canonical email the link was attached to (or null
   *  when not found). */
  unlinkPlatformId(vendor: string, platform_id: string): string | null;
  /** D-192 slice 4 — retract every `contact_platform_link` a messenger
   *  connection contributed (`(vendor, connection_name)` cut), re-materializing
   *  each affected contact's `platform_ids` JSON and firing a `removed` event
   *  per link. Connection-precise: a NULL-`connection_name` (reconciler / merge)
   *  or a sibling connection's rows are never matched. Removes only the
   *  ASSOCIATION — the shared `contacts` row is never deleted. Idempotent (a
   *  re-run removes nothing). */
  retractPlatformLinksForConnection(
    vendor: string,
    connection_name: string,
  ): { links_removed: number; contacts_affected: number };
  /** D-192 slice 4 — count a messenger connection's `contact_platform_link`
   *  rows (the removal-preview "[N] records" twin of the retract; same
   *  `(vendor, connection_name)` cut). */
  countPlatformLinksForConnection(vendor: string, connection_name: string): number;
  /** Look up the canonical email attached to `(vendor, platform_id)`. */
  lookupPlatformLink(vendor: string, platform_id: string): string | null;
  /** Append a rejection edge between two canonical contacts. Re-
   *  materializes both rows' `rejected_pairs` JSON. Idempotent on
   *  `(email_a, email_b)`. */
  addRejection(input: RejectionInput): void;
  /** Remove a rejection edge. Re-materializes both rows' JSON. */
  removeRejection(email_a: string, email_b: string): boolean;
  /** Pure pair-key lookup. */
  isPairRejected(email_a: string, email_b: string): boolean;
  /** Snapshot every rejection edge as a Set of `pair_key` strings —
   *  used by housekeeping scans to pre-compute the rejection filter
   *  once per cycle. */
  rejectedPairKeys(): Set<string>;
  /** Insert a merge-candidate row. Idempotent on `pair_key` UNIQUE
   *  constraint — re-inserting the same pair returns the existing row. */
  enqueueMergeCandidate(input: MergeCandidateInput): ContactMergeCandidate;
  /** List candidates matching the query. Defaults to `status: 'pending'`
   *  ordered by `detected_at DESC`. */
  listMergeCandidates(query?: MergeCandidateListQuery): {
    candidates: ContactMergeCandidate[];
    next_cursor?: string;
  };
  /** Fetch one candidate by id. */
  getMergeCandidate(id: string): ContactMergeCandidate | null;
  /** Set status on one candidate. Returns the updated row. */
  setMergeCandidateStatus(
    id: string,
    status: 'merged' | 'rejected',
    resolved_at: number,
    resolved_by?: string,
  ): ContactMergeCandidate | null;
  /** D-138 P1 — count of distinct `company` values seen at this email
   *  domain across rows whose `company_source IN ('vendor_meta', 'manual')`.
   *  Drives the gated email-domain → company resolver. Returns the
   *  inferred company when exactly one distinct value, ambiguous
   *  result when ≥ `COMPANY_DOMAIN_INFERENCE_MAX_DISTINCT_COMPANIES`,
   *  empty otherwise. */
  resolveCompanyForDomain(domain: string): CompanyDomainResolution;
  /** D-138 P1 — set / clear `merged_into` on the supplied rows.
   *  Substrate primitive used by the merge transaction (set survivor
   *  pointer) and the split transaction (clear it). Also clears the
   *  identity-bearing columns on tombstoned rows so the row carries
   *  only the redirect (per spec § A.8). Pass `survivor = null` to
   *  resurrect a tombstone (split). */
  setMergedInto(rows: ReadonlyArray<ContactRecord>, survivor: string | null, now: number): void;

  // ── D-145 PA8 — Contact identity extensions ──────────────────────
  /** Look up by `contact_id` (substrate-stable identifier; survives
   *  email changes, mention_only → verified promotions, and D-138
   *  merges intact). Returns null when no contact carries the id.
   *  Resolver-style helper for the alias substrate + future
   *  contact_id-keyed read paths. */
  getByContactId(contact_id: string): ContactRecord | null;
  /** D-192 P5 — the `contact_id → survivor` FORWARD-resolver (the edge
   *  substrate's named build prerequisite): `getByContactId` returns
   *  the raw row, so a D-138 merge LOSER surfaces as its tombstone.
   *  This variant follows the `merged_into` redirect chain to the
   *  canonical survivor — the same two-hop resolve contact writes
   *  already do. Null when the id is unknown or the chain is corrupted
   *  (survivor deleted). */
  getByContactIdResolved(contact_id: string): ContactRecord | null;
  /** § A.4.6 — create a `mention_only` contact stub from a chat
   *  reference. The substrate assigns a fresh `contact_id` + a
   *  synthetic `mention-only-{id}@_recued.invalid` placeholder email
   *  so the contacts table's email PK constraint stays satisfied
   *  while the contact has no real address. Promotion (`promoteMentionOnlyToVerified`)
   *  rewrites the email column to the supplied real value. */
  createMentionOnlyContact(input: MentionOnlyContactInput, now?: number): ContactRecord;
  /** D-205 #4 — mint a contact ROW for an IMPORT, and **nothing else**.
   *
   *  The `full_import` create-on-miss path. Handles BOTH shapes a contact book
   *  hands over: an entry with an address (→ `verified`, keyed on it) and the
   *  dentist without one (→ `partial` / `mention_only`, keyed on a synthetic
   *  placeholder).
   *
   *  ⚠ **Writes NO contributions.** The caller — the contact-source sync's write
   *  pass — already upserts every alias and attribute the record supplies, at the
   *  declaration's rung, carrying the Source's own id. This path has no
   *  `source_id` to offer, so anything it wrote would be attributed to
   *  `recued.derived`: a provenance LIE, and a collision with the contact's real
   *  derived rows. It mints an identity; the write pass says what is known about
   *  it; the caller materializes ONCE, after everything has landed.
   *
   *  ⛔ Refuses `source: 'manual'` — an import may never claim the user typed it
   *  (that would park a vendor's value at the TOP of the C-2a ladder, where the
   *  user's own typing could never correct it). */
  createImportedContact(input: ImportedContactInput, now?: number): ContactRecord;
  /** § A.4.6 — promotion flow. Input is `(contact_id, real email)`;
   *  storage rewrites the email column from the synthetic placeholder
   *  to the real value AND flips `identity_status` to `'verified'`.
   *  Idempotent on already-verified contacts (no-op). Throws when
   *  `contact_id` is unknown OR when the new email collides with an
   *  existing canonical contact (the caller is expected to dispatch
   *  to `contact.merge.confirm` for that case). The post-promotion
   *  D-138 reconciliation hook is called by the harness, not the
   *  store — keeps the store decoupled from match logic. */
  promoteMentionOnlyToVerified(
    input: PromoteMentionOnlyInput,
    now?: number,
  ): ContactRecord;
  /** Set / replace `network_domain` array on a contact. Validates
   *  every entry against the closed list. Empty array clears. */
  setNetworkDomain(
    contact_id: string,
    domains: readonly NetworkDomain[],
    now?: number,
  ): ContactRecord;
  /** Insert a `contact_alias` row. Validates the input + normalizes
   *  the pattern. Uses `INSERT OR IGNORE` semantics on the partial
   *  unique indexes — chat_alias dedup per (contact_id, normalized);
   *  platform_id dedup per (platform, normalized) global. Returns the
   *  inserted row OR the existing row when the unique constraint
   *  already had it. Cross-contact platform_id violation throws
   *  `platform_id_already_attached` per spec § A.4.3. */
  upsertContactAlias(input: ContactAliasInput, now?: number): ContactAliasRecord;
  /** Remove an alias by id. Returns true when removed. */
  deleteContactAlias(id: string): boolean;
  /** D-192 C-2 — drop every alias a Source supplied (the identifier-axis half of
   *  Source teardown). Returns the number of rows removed.
   *
   *  OMIT `contact_id` for the whole-Source teardown; pass one to scope the
   *  withdrawal to a single person.
   *
   *  ⚠ D-205 §1 — the ONLY caller of either form is the explicit whole-Source
   *  teardown ("also remove the imported data?"), a deliberate USER act. It is
   *  NOT a per-record delete-cascade: a vendor deleting their record withdraws
   *  NOTHING (it disconnects the linkage and soft-marks the blob). The sync used
   *  to call the contact-scoped form on every vanished record, and that was a
   *  vendor-plane deletion cascading into a core-plane data destruction. Do not
   *  re-wire it there. */
  deleteContactAliasesForSource(source_id: string, contact_id?: string): number;
  /** List aliases attached to a contact (kind-filtered when supplied). */
  listContactAliases(
    contact_id: string,
    kind?: ContactAliasKind,
  ): readonly ContactAliasRecord[];
  /** Resolver-friendly closure pack — the substrate provides the
   *  storage closures the pure resolver consumes. */
  resolveContactReference(
    reference: ContactReference,
    context: ContactReferenceContext,
  ): ContactReferenceResolution;

  // ── D-192 C-2 — the contribution substrate ────────────────────────
  /** Record one source's assertion about one descriptive field.
   *
   *  UPSERT on `(contact_id, kind, source_id)`: a source RESTATING a
   *  field overwrites its OWN prior claim, and never anyone else's.
   *  That is the whole contribution model — HubSpot revising a title
   *  must not destroy what the user typed, or what Google thinks.
   *
   *  ⚠ The key is `source_id` (WHO), not `source` (the trust RUNG) —
   *  two `contact_book`s or two `vendor_meta`s are peers, not the same
   *  writer, and keying on the rung would make them clobber each other
   *  every sync cycle.
   *
   *  There is deliberately NO rank gate here (unlike
   *  `upsertContactAlias`): a weak source is always allowed to RECORD
   *  its view. Rank decides which view the row PROJECTS, at read time,
   *  through the one C-2a ladder — not which views are allowed to
   *  exist. Storing only the winner would throw away the evidence the
   *  moment a stronger source appeared and then vanished. */
  upsertContactAttribute(
    input: ContactAttributeInput,
    now?: number,
  ): ContactAttributeRecord;
  /** Every attribute contribution for a contact (kind-filtered when
   *  supplied).
   *
   *  ⚠ **NOT the projection's full input, despite the obvious reading.** It is ONE
   *  contact (a merge moves nothing — the loser's rows stay on the loser) and ONE
   *  store (`phone` is an alias, not an attribute). For "everything the projection
   *  actually resolves over" use `listProjectionContributions`. */
  listContactAttributes(
    contact_id: string,
    kind?: ContactAttributeKind,
  ): readonly ContactAttributeRecord[];
  /** Everything the projection resolves over for this contact: the merge GROUP ×
   *  both contribution stores. The projection's real input, and the row set the
   *  D-205 per-source view renders. See the implementation for the two traps a
   *  per-contact / attribute-only read walks into. */
  listProjectionContributions(contact_id: string): readonly ProjectionContribution[];
  /** Remove one attribute contribution by id. Returns true when removed. */
  deleteContactAttribute(id: string): boolean;
  /** Drop every attribute contribution a Source made — the descriptive half of
   *  D-192 source-data-removal. Returns the number of rows removed.
   *
   *  OMIT `contact_id` for the whole-Source teardown; pass one to scope the
   *  withdrawal to a single person.
   *
   *  ⚠ D-205 §1 — see the alias twin. The ONLY sanctioned caller is the explicit
   *  user-driven teardown. A vendor deleting their record withdraws NOTHING, and
   *  the sync calling the contact-scoped form on every vanished record is exactly
   *  the data-destruction bug D-205 removed. Do not re-wire it there. */
  deleteContactAttributesForSource(source_id: string, contact_id?: string): number;

  /** Mirror one remote contact record's raw payload.
   *
   *  UPSERT on `(source_id, remote_id)` — one remote record maps to at
   *  most one local contact, so a re-import can never fan a single CRM
   *  contact across two people. Re-pointing at a different `contact_id`
   *  (a merge absorbed it) is an UPDATE of this row, not a second row.
   *
   *  ⚠ Keyed on the SOURCE INSTANCE, not the vendor (slice 6a re-key).
   *  Two connections to one vendor are two Sources with independent
   *  record-id spaces — a Salesforce sandbox + prod pair, two HubSpot
   *  portals — and under a vendor key each Source's delete diff would
   *  tombstone the other's records every cycle. */
  upsertContactSourceBlob(
    input: ContactSourceBlobInput,
    now?: number,
  ): ContactSourceBlobRecord;
  /** The `(remote_id → snapshot_hash)` map for one SOURCE — UNCAPPED, and
   *  DISCONNECTED ROWS OMITTED.
   *
   *  The incremental seam the `contact_import` reconciler reads ONCE per
   *  cycle to skip unchanged remote records (the `SourceMirrorStore`
   *  shape; same contract as the file family's `listSnapshotHashes`).
   *  Uncapped is load-bearing: a capped read would silently under-report
   *  which records are already current, so the reconciler would re-derive
   *  contributions for records it had already seen — and, far worse, the
   *  under-reported rows would look ABSENT to the delete diff.
   *
   *  D-205 §1 — the omission of soft-marked rows is load-bearing for the same
   *  diff, from the other side: a row already disconnected must never re-enter
   *  it as "prior but not polled", or the diff fires on it again every cycle. */
  listContactSourceBlobHashes(source_id: string): Map<string, string>;
  /** Raw source records mirrored for a contact — the audit trail behind
   *  its derived contributions, and the input to a re-derive after a
   *  mapping fix (no re-fetch needed). */
  listContactSourceBlobs(contact_id: string): readonly ContactSourceBlobRecord[];
  /** One mirrored record by its mirror key. The reconcile cycle reads it to
   *  learn WHICH contact a remote record is feeding — for the disconnect
   *  path, and to detect a record that now points at someone ELSE. Returns
   *  null when the record was never mirrored. Disconnected rows ARE
   *  returned (they carry `disconnected_at`); they are still the evidence
   *  behind live contributions. */
  getContactSourceBlob(source_id: string, remote_id: string): ContactSourceBlobRecord | null;
  /** Drop every mirrored record for a Source — the Source-teardown purge
   *  (D-192 source-data-removal).
   *
   *  ⚠ D-205 §1 — the whole-Source teardown is the ONLY path that hard-deletes
   *  a blob, and it is a deliberate USER act ("also remove the imported
   *  data?"). There is deliberately no per-record hard delete: a vendor
   *  deleting their record disconnects the linkage and withdraws nothing, so
   *  destroying the blob would keep the claim and destroy the receipt. Use
   *  `markContactSourceBlobDisconnected`. */
  deleteContactSourceBlobsForSource(source_id: string): number;
  /** D-205 §1 — soft-mark one mirrored record as gone from the vendor.
   *
   *  The vendor-plane delete, in full: the contributions this record made STAY
   *  (after import the core contact is one of the sources of truth), the blob
   *  stays as their evidence, and only the linkage is cut. Idempotent — returns
   *  false if it was already marked, so the mark records when the record FIRST
   *  vanished. */
  markContactSourceBlobDisconnected(
    source_id: string,
    remote_id: string,
    now?: number,
  ): boolean;

  /** D-192 C-2 — recompute the contact's projected row from its
   *  contributions. THE one place the projection is written.
   *
   *  Each field independently takes its strongest assertion via the
   *  C-2a ladder, and the D-138 blocking keys (`name_key` /
   *  `address_zip_country_key` / `company_norm`) are recomputed from the
   *  PROJECTED values — a stale blocking key does not mis-match, it
   *  silently STOPS matching, and a quiet false-negative in dedup is the
   *  worst failure mode available here.
   *
   *  ⚠ Writes the projection of the contributions, full stop: a field
   *  with NO contributions projects to NULL. Correct only once every
   *  legacy column value has a contribution behind it — which is what
   *  slice 3's backfill establishes. Hence this is not auto-wired yet;
   *  calling it before the backfill would wipe unclaimed legacy values.
   *
   *  Does NOT touch `email` — that is the PK and the public address, so
   *  re-electing a primary email is an identity operation that must
   *  cascade (slice 4), never a side effect of materializing a title.
   *
   *  Returns the refreshed record, or null for an unknown contact_id. */
  materializeContactProjection(contact_id: string, now?: number): ContactRecord | null;

  // ── D-145 PA8 follow-on — identifier-keyed lookup helpers ─────────
  /** Exact-match phone lookup. Caller pre-canonicalizes to E.164 (same
   *  discipline as `ManualUpsertInput.phone`). Tombstoned rows
   *  (`merged_into != NULL`) are excluded so the resolver never
   *  surfaces stale post-merge loser ids. When multiple non-tombstoned
   *  contacts share the phone (transitional pre-D-138-merge state) the
   *  result is intentionally ambiguous — `contact: null` plus the
   *  alternatives list; the caller surfaces a disambiguation UX rather
   *  than binding a downstream action to a guessed row. Returns empty
   *  result for unknown / empty phone. */
  findByPhone(phone: string): ContactPhoneLookupResult;
  /** Identifier-keyed alias lookup. Wraps `resolveContactReference`
   *  + materializes `ContactRecord` rows for each candidate. Hydrated
   *  rows are forwarded through the `merged_into` redirect chain so a
   *  chat_alias / platform_id row pointing at a tombstoned loser
   *  contact resolves to the canonical survivor (Codex P1 fold —
   *  without this guard, alias rows that survived past a D-138 merge
   *  could leak the loser's contact_id). The `confidence` field
   *  mirrors the underlying resolver (1.0 on user_set, < 1.0 on
   *  lower-trust writers). Returns `{ contact: null, alternatives: [] }`
   *  for empty / malformed inputs; alternatives surface only when the
   *  chat_alias branch could not collapse multiple candidates. */
  findByAlias(input: ContactAliasLookupInput): ContactAliasLookupResult;
  /** Non-mutating twin of `findByAlias`, for speculative deterministic
   *  candidate discovery. It performs the same exact resolution + merge-chain
   *  hydration but deliberately does NOT stamp `last_resolved_at`; only a
   *  committed user-facing resolver call may write that audit field. */
  peekByAlias(input: ContactAliasLookupInput): ContactAliasLookupResult;

  // ── D-145 PB11 — Person-Specific Automation primitive ─────────────
  /** § B.12 — read the contact's `personal_recipes` blob. Returns
   *  `[]` when the contact has no entries OR the contact_id doesn't
   *  exist (the dispatcher reads this on every chat extraction; a
   *  silent empty array keeps the hot path branch-free). */
  getPersonalRecipes(contact_id: string): readonly PersonalRecipeEntry[];
  /** § B.12.4 — append one entry. Idempotent on `(recipe_id, topic)`
   *  duplicates (lower-cased topic match) — the call is a no-op when
   *  the entry already exists; the validator's `duplicate_entry`
   *  issue would otherwise reject. The caller supplies `created_at`
   *  (production: `Date.now()`; tests: pinned clock). Throws
   *  `PersonalRecipeValidationError` on malformed inputs OR
   *  `ContactNotFoundError` when the contact_id is unknown. */
  addPersonalRecipe(
    contact_id: string,
    entry: PersonalRecipeEntry,
  ): readonly PersonalRecipeEntry[];
  /** § B.12.4 — flip the `enabled` flag on an entry without
   *  touching the rest of the blob. Returns the post-mutation
   *  array (or throws when the entry / contact is missing). */
  setPersonalRecipeEnabled(
    contact_id: string,
    recipe_id: string,
    topic: string,
    enabled: boolean,
  ): readonly PersonalRecipeEntry[];
  /** § B.12.4 — remove one entry by `(recipe_id, topic)`. Returns
   *  the post-mutation array. Missing entries are silently no-op
   *  (Settings UI uses this to clean up after recipe uninstalls). */
  removePersonalRecipe(
    contact_id: string,
    recipe_id: string,
    topic: string,
  ): readonly PersonalRecipeEntry[];
  /** § B.12.4 — replace the entire blob. Validates the new array
   *  through `assertValidPersonalRecipesBlob` before writing. Used
   *  by Settings UI batch edits + by import paths. */
  setPersonalRecipes(
    contact_id: string,
    entries: readonly PersonalRecipeEntry[],
  ): readonly PersonalRecipeEntry[];
}

/** § A.4.6 — input for `createMentionOnlyContact`. */
/** D-205 #4 — input for `createImportedContact`. The IMPORT create path.
 *
 *  Distinct from `MentionOnlyContactInput` (a chat stub the USER mentioned —
 *  `manual` / `mention_only`, and it writes its own `name` contribution because
 *  the user typed it). An import asserts nothing of its own: it mints the
 *  identity, and the sync's write pass supplies every field at the declaration's
 *  rung with the Source's id. */
export interface ImportedContactInput {
  /** The record's canonical address. **OMIT** for an entry that has none — the
   *  dentist — and storage synthesizes the placeholder PK. */
  email?: string;
  /** Display name. Required: a contact with neither an address nor a name is an
   *  identity nothing can ever match. */
  name: string;
  /** How the ROW was created (`contacts.source`). ⛔ Never `'manual'` — the store
   *  refuses it. An import may not claim the user typed it. */
  source: ContactSource;
  /** Only consulted when `email` is OMITTED (an address makes them `verified` by
   *  definition). `'partial'` = name + phone/address but no email — **the
   *  DENTIST, and the common case for a contact book**. `'mention_only'` = a name
   *  and nothing else. Defaults to `mention_only`. */
  identity_status?: Extract<ContactIdentityStatus, 'mention_only' | 'partial'>;
  network_domain?: readonly NetworkDomain[];
  /** Override for `contact_id` (tests). Production callers omit. */
  contact_id?: string;
  /** Override for `first_seen` (tests). Production callers omit. */
  first_seen?: number;
}

export interface MentionOnlyContactInput {
  /** Display name — typically the chat extraction's surface form
   *  ("Mom", "the cheese guy"). REQUIRED non-empty post-trim per spec
   *  § A.4.1's validator gate ("at least one of canonical_email,
   *  name, or phone must be populated"); mention_only contacts have
   *  no canonical email by definition, so name (or a future-PA8
   *  `phone` field) is the load-bearing identifier. */
  name: string;
  /** Optional initial network_domain assignment (validated). */
  network_domain?: readonly NetworkDomain[];
  /** Optional override for `contact_id` (tests). Production callers
   *  omit; the substrate generates a fresh ULID. */
  contact_id?: string;
  /** Optional override for `first_seen` (tests). Production callers
   *  use the now closure. */
  first_seen?: number;
}

/** § A.4.6 — input for `promoteMentionOnlyToVerified`. */
export interface PromoteMentionOnlyInput {
  contact_id: string;
  /** Real canonical email (substrate canonicalizes again at write). */
  email: string;
  /** Optional name patch — replaces the display name when supplied. */
  name?: string;
}

/** D-138 P3 — `(canonical_email, vendor, platform_id, kind)` event
 *  fired from `linkPlatformId` / `unlinkPlatformId` when the cycle
 *  observer is wired. Per spec § A.10, the observer correlates
 *  removes + adds inside one housekeeping cycle to detect upstream
 *  re-merges and fire prompts. */
export interface PlatformLinkChange {
  kind: 'added' | 'removed';
  canonical_email: string;
  vendor: string;
  platform_id: string;
}

export interface CreateContactStoreOptions {
  bus?: WarehouseEventBus;
  slug?: string;
  entityType?: string;
  now?: () => number;
  onDelete?: (email: string) => void;
  /** D-138 P1 — optional inline-detection callback. Called fire-and-
   *  forget after every contact upsert that did NOT auto-merge on
   *  email match — the harness evaluates the predicate against the
   *  graph and enqueues candidates. Passing the callback keeps the
   *  store decoupled from match logic so tests can exercise storage
   *  without spinning up the detector. Errors are swallowed. */
  onContactUpserted?: (record: ContactRecord) => void;
  /** D-138 P3 — optional callback fired after every `linkPlatformId`
   *  / `unlinkPlatformId` transition. The A.10 cycle observer wires
   *  it to record platform-link changes inside a housekeeping cycle
   *  window. Errors are swallowed. */
  onPlatformLinkChanged?: (change: PlatformLinkChange) => void;
}

export const createContactStore = (
  db: Database.Database,
  storeOpts: CreateContactStoreOptions = {},
): ContactStore => {
  ensureContactSchema(db);
  const bus = storeOpts.bus;
  const slug = storeOpts.slug ?? DEFAULT_CONTACT_SLUG;
  const entityType = storeOpts.entityType ?? DEFAULT_CONTACT_ENTITY_TYPE;
  const nowFn = storeOpts.now ?? ((): number => Date.now());

  const buildPrev = (row: ContactRow): Record<string, unknown> => ({
    name: row.name,
    email: row.email,
    last_interaction: row.last_interaction,
    interaction_count: row.interaction_count,
    source: row.source,
  });

  const emitEvent = (
    record_id: string,
    kind: 'created' | 'updated' | 'deleted',
    prev?: Record<string, unknown>,
  ): void => {
    if (!bus) return;
    bus.emit({
      platform: CONTACT_PLATFORM,
      slug,
      entity_type: entityType,
      event_kind: kind,
      record_id,
      at: nowFn(),
      ...(prev !== undefined ? { prev } : {}),
    });
  };

  const getStmt = db.prepare(`SELECT * FROM ${CONTACT_TABLE} WHERE email = ?`);
  // D-145 PA8 — INSERT now seeds `contact_id` at write time. The
  // `identity_status` defaults to `'verified'` via column DEFAULT —
  // every existing observe / upsert path stays compatible without
  // touching the call site. mention_only contacts go through the
  // dedicated `insertMentionOnlyContact` path.
  const insertStmt = db.prepare(
    `INSERT INTO ${CONTACT_TABLE}
       (email, name, first_seen, last_interaction, interaction_count,
        source, created_at, updated_at,
        platform_ids, rejected_pairs, contact_id,
        origin_actor, origin_contract_id, origin_surface)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?)`,
  );
  const newContactId = (): string => randomUUID().replace(/-/g, '');
  const updateOnObserveStmt = db.prepare(
    `UPDATE ${CONTACT_TABLE}
       SET last_interaction = MAX(last_interaction, ?),
           interaction_count = interaction_count + 1,
           updated_at = ?
       WHERE email = ?`,
  );
  // D-177 N.11 rule 1 — the manual-update statement RE-STAMPS the three
  // origin facets: the stored-cleanliness gate reads the row's LAST
  // writer. Genesis-only stamping would let an agent rewrite a
  // user-created row's content (phone / company / name) while the row
  // kept reading `'user_self'` — the rev-8 laundering via update.
  //
  // D-192 C-2 slice 3 — the CONTENT columns are gone from here. `name` (and the
  // whole D-138 merge-fields statement that used to follow: phone /
  // mailing_address / company / company_source + the three blocking keys) are a
  // PROJECTION now, written by `materializeContactProjection` from the winning
  // contributions. What survives here is exactly what is NOT a projection —
  // interaction bookkeeping and the origin facets.
  const updateManualStmt = db.prepare(
    `UPDATE ${CONTACT_TABLE}
       SET last_interaction = MAX(last_interaction, ?),
           interaction_count = interaction_count + 1,
           updated_at = ?,
           origin_actor = ?,
           origin_contract_id = ?,
           origin_surface = ?
       WHERE email = ?`,
  );
  const deleteStmt = db.prepare(`DELETE FROM ${CONTACT_TABLE} WHERE email = ?`);

  // D-138 P1 — internal-table statements.
  const platformLinkUpsertStmt = db.prepare(
    `INSERT INTO ${CONTACT_PLATFORM_LINK_TABLE}
       (canonical_email, vendor, platform_id, state, linked_at, linked_by, connection_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vendor, platform_id) DO UPDATE SET
         canonical_email = excluded.canonical_email,
         state = excluded.state,
         linked_at = MIN(linked_at, excluded.linked_at),
         linked_by = excluded.linked_by,
         connection_name = excluded.connection_name`,
  );
  const platformLinkDeleteStmt = db.prepare(
    `DELETE FROM ${CONTACT_PLATFORM_LINK_TABLE}
       WHERE vendor = ? AND platform_id = ?`,
  );
  const platformLinkLookupStmt = db.prepare(
    `SELECT canonical_email FROM ${CONTACT_PLATFORM_LINK_TABLE}
       WHERE vendor = ? AND platform_id = ?`,
  );
  const platformLinkListByEmailStmt = db.prepare(
    `SELECT * FROM ${CONTACT_PLATFORM_LINK_TABLE}
       WHERE canonical_email = ?
       ORDER BY linked_at ASC`,
  );
  // D-192 slice 4 — the per-connection retract cut (messenger). `connection_name`
  // is NULLABLE, so `= ?` with a concrete name matches ONLY that connection's
  // rows (NULL reconciler/merge rows never match — correctly untouched), and two
  // same-vendor connections stay disjoint.
  const platformLinkListByConnStmt = db.prepare(
    `SELECT canonical_email, platform_id FROM ${CONTACT_PLATFORM_LINK_TABLE}
       WHERE vendor = ? AND connection_name = ?`,
  );
  const platformLinkDeleteByConnStmt = db.prepare(
    `DELETE FROM ${CONTACT_PLATFORM_LINK_TABLE}
       WHERE vendor = ? AND connection_name = ?`,
  );
  const platformLinkCountByConnStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${CONTACT_PLATFORM_LINK_TABLE}
       WHERE vendor = ? AND connection_name = ?`,
  );

  const rejectionUpsertStmt = db.prepare(
    `INSERT INTO ${CONTACT_REJECTION_TABLE}
       (email_a, email_b, rejected_at, rejected_by, source_candidate_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email_a, email_b) DO NOTHING`,
  );
  const rejectionDeleteStmt = db.prepare(
    `DELETE FROM ${CONTACT_REJECTION_TABLE}
       WHERE email_a = ? AND email_b = ?`,
  );
  const rejectionLookupStmt = db.prepare(
    `SELECT 1 FROM ${CONTACT_REJECTION_TABLE}
       WHERE email_a = ? AND email_b = ?`,
  );
  const rejectionListForEmailStmt = db.prepare(
    `SELECT email_a, email_b FROM ${CONTACT_REJECTION_TABLE}
       WHERE email_a = ? OR email_b = ?`,
  );
  const rejectionAllStmt = db.prepare(
    `SELECT email_a, email_b FROM ${CONTACT_REJECTION_TABLE}`,
  );

  const updatePlatformIdsJsonStmt = db.prepare(
    `UPDATE ${CONTACT_TABLE} SET platform_ids = ?, updated_at = ? WHERE email = ?`,
  );
  const updateRejectedPairsJsonStmt = db.prepare(
    `UPDATE ${CONTACT_TABLE} SET rejected_pairs = ?, updated_at = ? WHERE email = ?`,
  );

  // D-138 P1 (codex review fix) — INSERT path is unconditional; the
  // dedup discipline lives in `enqueueMergeCandidate` below. Schema's
  // `pair_key UNIQUE` blocked re-queue after a prior pair resolved
  // (merged or rejected), which broke A.10 re-merge — `contact.merge.
  // resolve_remerge_prompt` reports it queued but the queue stays
  // empty. We can't drop the column-level UNIQUE without a migration
  // (pre-launch zero-migration discipline), so instead handle the
  // conflict by RESETTING the existing row to `pending` when its
  // status was off-pending and the caller is asking for a fresh
  // candidate. The row's id stays stable so candidate_ids passed
  // by the UI remain valid across the re-queue.
  const candidateInsertStmt = db.prepare(
    `INSERT INTO ${CONTACT_MERGE_CANDIDATE_QUEUE}
       (id, email_a, email_b, pair_key, matched_fields, detected_at, detected_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(pair_key) DO NOTHING`,
  );
  const candidateRequeueExistingStmt = db.prepare(
    `UPDATE ${CONTACT_MERGE_CANDIDATE_QUEUE}
       SET status = 'pending',
           matched_fields = ?,
           detected_at = ?,
           detected_by = ?,
           resolved_at = NULL,
           resolved_by = NULL
       WHERE pair_key = ? AND status IN ('merged', 'rejected')`,
  );
  const candidateLookupByPairKeyStmt = db.prepare(
    `SELECT * FROM ${CONTACT_MERGE_CANDIDATE_QUEUE} WHERE pair_key = ?`,
  );
  const candidateLookupByIdStmt = db.prepare(
    `SELECT * FROM ${CONTACT_MERGE_CANDIDATE_QUEUE} WHERE id = ?`,
  );
  const candidateUpdateStatusStmt = db.prepare(
    `UPDATE ${CONTACT_MERGE_CANDIDATE_QUEUE}
       SET status = ?, resolved_at = ?, resolved_by = ?
       WHERE id = ?`,
  );

  const domainSeedPoolStmt = db.prepare(
    `SELECT DISTINCT company FROM ${CONTACT_TABLE}
       WHERE email LIKE ?
         AND company IS NOT NULL
         AND company_source IN ('vendor_meta', 'manual')`,
  );

  // ── Helpers ─────────────────────────────────────────────────────

  const materializePlatformIdsJson = (canonical_email: string, now: number): void => {
    const rows = platformLinkListByEmailStmt.all(canonical_email) as PlatformLinkRow[];
    const entries: PlatformIdEntry[] = rows.map((r) => ({
      vendor: r.vendor,
      platform_id: r.platform_id,
      state: r.state,
      linked_at: r.linked_at,
      linked_by: r.linked_by,
    }));
    updatePlatformIdsJsonStmt.run(JSON.stringify(entries), now, canonical_email);
  };

  const materializeRejectedPairsJson = (canonical_email: string, now: number): void => {
    const rows = rejectionListForEmailStmt.all(canonical_email, canonical_email) as {
      email_a: string;
      email_b: string;
    }[];
    const partners = rows.map((r) =>
      r.email_a === canonical_email ? r.email_b : r.email_a,
    );
    updateRejectedPairsJsonStmt.run(JSON.stringify(partners), now, canonical_email);
  };

  // ── Internal write paths ────────────────────────────────────────

  interface PendingEmit {
    record_id: string;
    kind: 'created' | 'updated';
    prev?: Record<string, unknown>;
  }

  /** What `upsertManualInner` hands back across the transaction boundary.
   *
   *  `canonical_email` is the row's own PK, which is NOT necessarily the address the
   *  caller passed: D-192 C-2 slice 4 lets a write resolve through an alias, so a
   *  `contact.upsert` naming Bob's second mailbox lands on Bob's row. The caller
   *  reads back and emits under THIS, or it would read null and announce a record id
   *  the warehouse has never heard of. */
  interface UpsertManualOutcome {
    kind: 'created' | 'updated';
    prev?: Record<string, unknown>;
    canonical_email: string;
  }

  const observeOne = (
    obs: ContactObservation,
    now: number,
  ): { record: ContactRecord; pending: PendingEmit } => {
    const email = canonicalizeEmail(obs.email);
    if (!email) {
      throw new Error(`contact_invalid_email: ${obs.email}`);
    }
    // ── D-192 C-2 slice 4 — resolve-first ───────────────────────────────────
    //
    // The question used to be "does a contacts row have this PK?". That is the WRONG
    // QUESTION the moment a contact book gives Bob a second address: `bob@work.com`
    // is an alias Bob OWNS, with no contacts row of its own, so the old check missed
    // it, took the CREATE path, and minted a stranger — or, once the alias index
    // existed, threw `email_alias_already_attached` on the way. Neither is the
    // answer. Mail from `bob@work.com` IS mail from Bob, and bumping Bob is the
    // entire reason multi-email exists.
    //
    // Note we bump the OWNER even when the owner is a tombstone, which is exactly
    // what the pre-slice-4 PK lookup did (`getStmt` finds a tombstone by its PK).
    // Redirecting the interaction onto the survivor is a real question, but it is
    // D-138's, not this slice's, and answering it here would change merge semantics
    // by a side door.
    const existing = contactByAnyEmail(email);
    if (existing) {
      const prev = buildPrev(existing);
      // `existing.email`, NOT `email` — when we arrived via an alias the two differ,
      // and `WHERE email = <the alias>` would match no row at all: a silently
      // dropped interaction bump.
      updateOnObserveStmt.run(obs.event_at, now, existing.email);
      const refreshed = getStmt.get(existing.email) as ContactRow;
      return {
        record: rowToRecord(refreshed),
        pending: { record_id: existing.email, kind: 'updated', prev },
      };
    }
    // The CREATE path is now three writes (row + two contributions) and a
    // materialize, so it becomes atomic: a rejection part-way through must not
    // leave a contact row whose columns disagree with its own contributions.
    // Nests via SAVEPOINT under `observeBatch`'s outer transaction, where it also
    // upgrades the existing per-item `catch { /* skip malformed */ }` from
    // "swallow and keep the partial write" to a real per-item rollback.
    return insertObservedTx(email, obs, now);
  };

  const insertObservedTx = db.transaction((
    email: string,
    obs: ContactObservation,
    now: number,
  ): { record: ContactRecord; pending: PendingEmit } => {
    const name = obs.name?.trim() || fallbackDisplayName(email);
    const contact_id = newContactId();
    insertStmt.run(
      email,
      name,
      obs.event_at,
      obs.event_at,
      1,
      obs.source,
      now,
      now,
      contact_id,
      // D-161 P2 — mail / calendar sync derives contacts as `'system'`
      // (the adapter is the write-actor). origin_contract_id is NULL;
      // origin_surface is 'system' (D-177).
      'system',
      null,
      'system',
    );

    // ── D-192 C-2 slice 3 — the row's columns are now a PROJECTION ───────────
    //
    // Everything an adapter learns is a CONTRIBUTION first; the columns are
    // materialized from the winners. Both land at `derived` — Recued pulled the
    // name and the address out of warehouse traffic deterministically (a mail
    // `From`, a calendar attendee): no model, no guess, but nobody ASSERTED them
    // either, so a later address-book or CRM import legitimately outranks both.
    // That ordering is the entire point of the ladder, and it is why the ratified
    // "backfill everything as `legacy`" prose had to be rejected.
    //
    // `as_of` is the observation's EVENT time, not the ingestion clock (D-120
    // bistemporal): a six-month-old mail imported today asserted that name six
    // months ago, and the recency tiebreak has to see it that way.
    const rung = contactSourceToContributionRung(obs.source);
    const rungSourceId = contributionSourceIdForRung(rung);
    upsertContactAttribute(
      {
        contact_id,
        kind: 'name',
        value: name,
        source: rung,
        source_id: rungSourceId,
        as_of: obs.event_at,
        created_at: now,
      },
      now,
    );
    upsertContactAlias(
      {
        contact_id,
        kind: 'email_alias',
        alias_pattern: email,
        source: rung,
        source_id: rungSourceId,
        created_at: now,
      },
      now,
    );
    // Materializing also derives `name_key` (which the D-138 housekeeping scan's
    // blocking gate needs on first sight) — so the hand-rolled name_key UPDATE
    // that used to sit here is gone, and with it a `db.prepare` that was being
    // re-compiled on every single new contact.
    materializeContactProjection(contact_id, now);

    return {
      record: rowToRecord(getStmt.get(email) as ContactRow),
      pending: { record_id: email, kind: 'created' },
    };
  });

  const observe = (
    obs: ContactObservation,
    nowOpt?: number,
    opts: ContactWriteOptions = {},
  ): ContactRecord => {
    const now = nowOpt ?? nowFn();
    const { record, pending } = observeOne(obs, now);
    if (!opts.silent) emitEvent(pending.record_id, pending.kind, pending.prev);
    if (storeOpts.onContactUpserted) {
      try { storeOpts.onContactUpserted(record); } catch { /* fire-and-forget */ }
    }
    return record;
  };

  const observeBatch = (
    list: readonly ContactObservation[],
    nowOpt?: number,
    opts: ContactWriteOptions = {},
  ): number => {
    if (list.length === 0) return 0;
    const now = nowOpt ?? nowFn();
    const pending: PendingEmit[] = [];
    const records: ContactRecord[] = [];
    let n = 0;
    const tx = db.transaction((items: readonly ContactObservation[]) => {
      for (const obs of items) {
        try {
          const { record, pending: p } = observeOne(obs, now);
          pending.push(p);
          records.push(record);
          n++;
        } catch { /* skip malformed */ }
      }
    });
    tx(list);
    if (!opts.silent) {
      for (const p of pending) emitEvent(p.record_id, p.kind, p.prev);
    }
    if (storeOpts.onContactUpserted) {
      for (const rec of records) {
        try { storeOpts.onContactUpserted(rec); } catch { /* fire-and-forget */ }
      }
    }
    return n;
  };

  const upsertManualTx = db.transaction(
    (
      email: string,
      input: ManualUpsertInput,
      now: number,
      opts: ContactWriteOptions,
    ): UpsertManualOutcome => upsertManualInner(email, input, now, opts),
  );

  /** ATOMIC, and it has to be. A manual upsert is no longer one UPDATE — it is an
   *  insert (maybe), up to four contribution writes, and a materialize. Any one of
   *  the contribution writes can reject (an alias validator, a duplicate email
   *  already attached to another contact), and without a transaction a rejection
   *  half-way through would leave a contact row on disk with SOME of its
   *  contributions and NO projection: a contact whose columns disagree with its
   *  own contributions, which is precisely the split-brain this substrate exists
   *  to make impossible. `db.transaction` nests via SAVEPOINT, so this composes
   *  with `observeBatch`'s outer transaction rather than fighting it. */
  const upsertManual = (
    input: ManualUpsertInput,
    nowOpt?: number,
    opts: ContactWriteOptions = {},
  ): ContactRecord => {
    const email = canonicalizeEmail(input.email);
    if (!email) {
      throw new Error(`contact_invalid_email: ${input.email}`);
    }
    const now = nowOpt ?? nowFn();
    // `canonical_email` — NOT the caller's `email`. D-192 C-2 slice 4: the write may
    // have resolved through an alias (`contact.upsert` on Bob's second mailbox),
    // in which case the row that changed is Bob's, under Bob's PK. Reading back and
    // emitting under the ALIAS would return null and fire an event naming a record
    // the warehouse has never heard of.
    const { kind, prev, canonical_email } = upsertManualTx(email, input, now, opts);

    // Emits + callbacks land OUTSIDE the transaction: a listener must never see a
    // contact the database is still free to roll back.
    const result = rowToRecord(getStmt.get(canonical_email) as ContactRow);
    if (!opts.silent) emitEvent(canonical_email, kind, prev);
    if (storeOpts.onContactUpserted) {
      try { storeOpts.onContactUpserted(result); } catch { /* fire-and-forget */ }
    }
    return result;
  };

  const upsertManualInner = (
    email: string,
    input: ManualUpsertInput,
    now: number,
    opts: ContactWriteOptions,
  ): UpsertManualOutcome => {
    const lastInteraction = input.last_interaction ?? now;

    // Empty / whitespace-only means NOT SUPPLIED, for every field — and the phone
    // case is a live bug the contribution model would otherwise open.
    // `upsertContactAlias` REJECTS an empty `alias_pattern` (`alias_pattern_empty`),
    // so a `contact.upsert` carrying `phone: ''` — which the pre-C-2 code happily
    // wrote straight into the column — would now throw out of the rpc as a 500.
    // And `company: ''` would mint a `manual` org contribution holding an empty
    // string: top of the ladder, projects to NULL through the shape guard, and so
    // permanently SUPPRESSES a perfectly good vendor-supplied company. Neither model
    // has ever supported clearing a field, and an accidental clear that also gags
    // every future writer is not the place to invent one.
    const suppliedName = input.name?.trim();
    const suppliedPhone = input.phone?.trim();
    const suppliedCompany = input.company?.trim();

    // D-192 C-2 slice 4 — resolve-first. See `observeOne` for the full argument: a
    // `contact.upsert` naming Bob's SECOND mailbox must edit Bob, not mint a second
    // Bob (and, once the alias index exists, not throw
    // `email_alias_already_attached` trying to).
    const existing = contactByAnyEmail(email);
    // The row's OWN primary key. Identical to `email` on the ordinary path; the
    // OWNER's address when we arrived through one of its aliases. Every subsequent
    // `WHERE email = ?` in this function must use THIS, or it silently matches
    // nothing.
    let canonical_email = email;
    let kind: 'created' | 'updated';
    let prev: Record<string, unknown> | undefined;
    let contact_id: string;
    if (existing) {
      kind = 'updated';
      prev = buildPrev(existing);
      contact_id = existing.contact_id;
      canonical_email = existing.email;
      // D-177 N.11 rule 1 — re-stamp the origin facets to THIS write's
      // (last-writer semantics; see `ContactWriteOptions.origin_actor`).
      // The `name` column is no longer written here: it is a PROJECTION of the
      // name contributions now, and `materializeContactProjection` below sets it.
      updateManualStmt.run(
        lastInteraction,
        now,
        opts.origin_actor ?? 'system',
        opts.origin_contract_id ?? null,
        opts.origin_surface ?? 'system',
        canonical_email,
      );
    } else {
      kind = 'created';
      contact_id = newContactId();
      const firstSeen = input.first_seen ?? now;
      insertStmt.run(
        email,
        // Seeds the NOT-NULL-in-practice column; the materialize below
        // immediately re-derives it from the contributions. Identical value —
        // the same fallback feeds the `name` contribution a few lines down.
        suppliedName || fallbackDisplayName(email),
        firstSeen,
        Math.max(firstSeen, lastInteraction),
        1,
        'manual',
        now,
        now,
        contact_id,
        // D-161 P2 — stamp the SERVER-DETERMINED write-actor at genesis.
        // The `contact.upsert` rpc handler passes `'user_self'` (paired-
        // client `user` channel); absent → `'system'` (column default).
        opts.origin_actor ?? 'system',
        opts.origin_contract_id ?? null,
        // D-177 N.11 rule 1 — write surface (same server-determined
        // boundary; the rpc handler passes 'client_rpc', the kernel
        // dispatch passes 'engine').
        opts.origin_surface ?? 'system',
      );
      // The row's own address, at the rung its own creation earns.
      upsertContactAlias(
        {
          contact_id,
          kind: 'email_alias',
          alias_pattern: email,
          source: 'manual',
          source_id: CONTACT_SOURCE_ID_MANUAL,
          created_at: now,
        },
        now,
      );
    }

    // ── D-192 C-2 slice 3 — contribute ONLY what the caller actually supplied ──
    //
    // This replaces D-138's hand-rolled preserve-merge (`input.phone ??
    // existing.phone ?? null`, once per field). The preservation it was doing now
    // falls out of the projection for free: an unsupplied field simply gets no new
    // contribution, its existing winner stays the winner, and the materialize
    // rewrites the same value back into the column.
    //
    // ⚠ And this is the half the old code could not have got right. Re-writing an
    // untouched field's value back through a `manual` write would LAUNDER its
    // provenance to the top of the ladder: a company imported from HubSpot would,
    // after the user edited only the phone number, be recorded as hand-typed by
    // the user — and would then outrank every future HubSpot correction, forever.
    // Silence is the honest contribution for a field the user did not touch.
    // D-210 audit finding 5 — `manual` is the DEFAULT, not a constant. A caller
    // that knows its values were not hand-typed by the owner passes
    // `attribution_source: 'derived'` (server-determined; see ContactWriteOptions).
    // Without it the intake→contact destination recorded a VISITOR-typed name at
    // rank 0, above `user_confirmed` and above CRM, where it outranked every
    // future correction forever — the same "lie with teeth" the no-name branch
    // below already refuses to tell about the local-part fallback.
    const attributionSource = opts.attribution_source ?? 'manual';
    const attributionSourceId = attributionSource === 'derived'
      ? CONTACT_SOURCE_ID_DERIVED
      : CONTACT_SOURCE_ID_MANUAL;
    const contribute = (
      attr_kind: 'name' | 'org' | 'address' | 'title' | 'photo' | 'birthday',
      value: unknown,
    ): void => {
      upsertContactAttribute(
        {
          contact_id,
          kind: attr_kind,
          value,
          source: attributionSource,
          source_id: attributionSourceId,
          as_of: now,
          created_at: now,
        },
        now,
      );
    };

    if (suppliedName) {
      contribute('name', suppliedName);
    } else if (kind === 'created') {
      // A contact created with no name at all. The column has to hold something,
      // so it holds the email's local-part — but the user did not TYPE that, so
      // recording it as `manual` would be a lie with teeth: it would sit at the
      // top of the ladder and beat the real name ("Robert Smith") the first
      // address-book import ever supplies. It is `derived`, because that is
      // exactly what it is — Recued deterministically derived it from the address.
      const fallback = fallbackDisplayName(email);
      upsertContactAttribute(
        {
          contact_id,
          kind: 'name',
          value: fallback,
          source: 'derived',
          source_id: CONTACT_SOURCE_ID_DERIVED,
          as_of: now,
          created_at: now,
        },
        now,
      );
    }
    if (suppliedCompany) contribute('org', suppliedCompany);
    if (input.mailing_address !== undefined) contribute('address', input.mailing_address);
    // D-205 #5c — the same discipline as every field above: SILENCE for a field the
    // user did not supply. A vCard that omits `TITLE` is not asserting the user has
    // no job; contributing an empty string would park that non-assertion at the TOP
    // of the ladder, where no import could ever correct it.
    const suppliedTitle = input.title?.trim();
    if (suppliedTitle) contribute('title', suppliedTitle);
    const suppliedPhoto = input.photo?.trim();
    if (suppliedPhoto) contribute('photo', suppliedPhoto);
    const suppliedBirthday = input.birthday?.trim();
    if (suppliedBirthday) contribute('birthday', suppliedBirthday);
    if (suppliedPhone) {
      upsertContactAlias(
        {
          contact_id,
          kind: 'phone_alias',
          alias_pattern: suppliedPhone,
          source: 'manual',
          source_id: CONTACT_SOURCE_ID_MANUAL,
          created_at: now,
        },
        now,
      );
    }

    // Writes name / company / company_source / phone / mailing_address / title /
    // photo / birthday AND the three D-138 blocking keys, all from the winning
    // contributions. The blocking keys in particular must be recomputed here and
    // not left stale: the merge-candidate scan only evaluates its predicate
    // against pairs that already share a blocking key, so a stale key produces NO
    // match rather than a wrong one — the duplicate detector just silently stops
    // seeing a duplicate.
    materializeContactProjection(contact_id, now);

    return prev === undefined
      ? { kind, canonical_email }
      : { kind, prev, canonical_email };
  };

  const get = (email: string): ContactRecord | null => {
    const canonical = canonicalizeEmail(email);
    if (!canonical) return null;
    const row = getStmt.get(canonical) as ContactRow | undefined;
    return row ? rowToRecord(row) : null;
  };

  // Shared WHERE builder for `list()` + `count()` — so a filtered list and its
  // `total` apply the SAME predicate. (A `count()` that ignored the filter would
  // hand the UI an inflated "of M" that its offset pagination could never reach.)
  const buildContactWhere = (
    query: ContactListQuery,
  ): { whereClause: string; params: unknown[] } => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.name_contains) {
      where.push(`name LIKE ? COLLATE NOCASE`);
      params.push(`%${query.name_contains}%`);
    }
    if (query.company_contains) {
      where.push(`company LIKE ? COLLATE NOCASE`);
      params.push(`%${query.company_contains}%`);
    }
    if (query.source) {
      where.push(`source = ?`);
      params.push(query.source);
    }
    if (query.since !== undefined) {
      where.push(`last_interaction >= ?`);
      params.push(query.since);
    }
    if (query.phone_exact) {
      where.push(`phone = ?`);
      params.push(query.phone_exact);
    }
    return { whereClause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
  };

  const list = (query: ContactListQuery = {}): ContactRecord[] => {
    const { whereClause, params } = buildContactWhere(query);
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
    const offset = Math.max(0, query.offset ?? 0);
    const sql = `
      SELECT * FROM ${CONTACT_TABLE}
      ${whereClause}
      ORDER BY last_interaction DESC, email ASC
      LIMIT ? OFFSET ?
    `;
    const rows = db.prepare(sql).all(...params, limit, offset) as ContactRow[];
    return rows.map(rowToRecord);
  };

  // D-167 follow-on — lean whole-warehouse scan for the prompt-cache prefetch.
  // SELECTs ONLY the four scored columns (no `rowToRecord` JSON parse) ordered by
  // recency, capped at PREFETCH_SCAN_MAX (NOT the general list() MAX_LIMIT), so a
  // warehouse of up to 10k contacts is fully scanned per turn (lifting the silent
  // 1000-row coverage cap). `phone`/`company`/`name` are nullable columns →
  // surfaced as `undefined` so the adapter's `?? undefined`-shaped reads hold.
  const prefetchScanStmt = db.prepare(
    `SELECT email, name, phone, company FROM ${CONTACT_TABLE}
       ORDER BY last_interaction DESC, email ASC
       LIMIT ?`,
  );
  const listForPrefetchScan = (limit?: number): PrefetchScanRow[] => {
    const cap = Math.max(1, Math.min(limit ?? PREFETCH_SCAN_MAX, PREFETCH_SCAN_MAX));
    const rows = prefetchScanStmt.all(cap) as Array<{
      email: string;
      name: string | null;
      phone: string | null;
      company: string | null;
    }>;
    return rows.map((r) => ({
      email: r.email,
      ...(r.name !== null ? { name: r.name } : {}),
      ...(r.phone !== null ? { phone: r.phone } : {}),
      ...(r.company !== null ? { company: r.company } : {}),
    }));
  };

  // D-167 §1.A — index-backed prefetch retrieval. Three legs, deduped by email:
  //   1. FTS5(name, company) MATCH — fuzzy token candidates, per-token + recency-
  //      capped (see `prefetchCandidates`).
  //   2. exact email-PK lookup.
  //   3. contact_phone_forms — contacts whose phone reduces to a query form.
  // The union is a SUPERSET of every row the scorer can score > 0, so the pure
  // scorer re-scores authoritatively (store-wide, no recency page). Per-token
  // capping keeps each token's contention exact, so the adapter passes
  // `fuzzyComplete: true`; phone-form uniqueness is store-wide via `countPhoneForm`.
  type PrefetchRaw = {
    email: string; name: string | null; phone: string | null; company: string | null;
    last_interaction: number;
  };
  const toScanRow = (r: PrefetchRaw): PrefetchScanRow => ({
    email: r.email,
    ...(r.name !== null ? { name: r.name } : {}),
    ...(r.phone !== null ? { phone: r.phone } : {}),
    ...(r.company !== null ? { company: r.company } : {}),
  });
  // Order by RECENCY, not bm25 `rank`: the scorer re-ranks authoritatively by
  // token-overlap score, so FTS ordering only decides which matches each per-token
  // cap keeps (the most-recent). `last_interaction` is also SELECTed so the deduped
  // union can be globally recency-sorted before scoring — the scorer breaks equal
  // score+ambiguity ties by input order, so a per-token-bucket order would let an
  // older first-token match crowd out a newer later-token match.
  const ftsMatchStmt = db.prepare(
    `SELECT c.email AS email, c.name AS name, c.phone AS phone, c.company AS company,
            c.last_interaction AS last_interaction
       FROM ${CONTACT_FTS_TABLE} f
       JOIN ${CONTACT_TABLE} c ON c.rowid = f.rowid
      WHERE ${CONTACT_FTS_TABLE} MATCH ?
      ORDER BY c.last_interaction DESC, c.email ASC
      LIMIT ?`,
  );
  const phoneFormCountStmt = db.prepare(
    `SELECT COUNT(DISTINCT rowid_ref) AS n FROM ${CONTACT_PHONE_FORMS_TABLE} WHERE form = ?`,
  );
  // FTS5 phrase-literal each token (double-quote-wrapped, embedded `"` doubled) and
  // OR-join — so an operator/quote in a contact name can't inject into the MATCH
  // grammar. Empty after build → no FTS leg.
  const buildFtsMatch = (tokens: readonly string[]): string =>
    tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  const inClause = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

  const prefetchCandidates = (query: PrefetchIndexQuery): PrefetchScanRow[] => {
    const byEmail = new Map<string, PrefetchRaw>();
    const add = (r: PrefetchRaw): void => {
      if (!byEmail.has(r.email)) byEmail.set(r.email, r);
    };
    // 1. FTS name/company — matched PER TOKEN, each capped independently. A single
    //    OR query with one global cap lets a flooding token (e.g. an org token
    //    shared by thousands of recent contacts) starve a rarer token's matches out
    //    of the cap entirely; per-token retrieval guarantees every token's matches
    //    reach the scorer. A token over its own cap still yields >= 2 matchers, so
    //    the §2 gate marks it ambiguous — no global truncation signal needed. A
    //    malformed MATCH (defensive) just skips that token; the exact legs still run.
    //
    //    Accepted speculative-layer limitation: a MULTI-token match (e.g. "John
    //    Smith", which the scorer would score 2) is missed if it falls outside the
    //    per-token recency cap for EVERY one of its tokens — i.e. a very old contact
    //    buried under > PREFETCH_FTS_LIMIT more-recent same-token contacts in a large
    //    warehouse. This is zero-harm for a speculative prefetch (the model resolves
    //    the miss via a tool call) and is the SAFE degradation: the alternative — a
    //    score-ranked global cap — instead risks a confident WRONG resolution (the
    //    §2 wrong-Sarah failure) or starving a rare token, both worse than a miss.
    for (const token of query.tokens) {
      const match = buildFtsMatch([token]);
      if (match.length === 0) continue;
      try {
        for (const r of ftsMatchStmt.all(match, PREFETCH_FTS_LIMIT) as PrefetchRaw[]) add(r);
      } catch { /* malformed MATCH → skip this token */ }
    }
    // 2. exact email PK.
    if (query.emails.length > 0) {
      const rows = db.prepare(
        `SELECT email, name, phone, company, last_interaction FROM ${CONTACT_TABLE}
          WHERE email IN (${inClause(query.emails.length)})`,
      ).all(...query.emails) as PrefetchRaw[];
      for (const r of rows) add(r);
    }
    // 3. phone forms → contacts whose phone reduces to a query form.
    if (query.forms.length > 0) {
      const rows = db.prepare(
        `SELECT c.email AS email, c.name AS name, c.phone AS phone, c.company AS company,
                c.last_interaction AS last_interaction
           FROM ${CONTACT_PHONE_FORMS_TABLE} pf
           JOIN ${CONTACT_TABLE} c ON c.rowid = pf.rowid_ref
          WHERE pf.form IN (${inClause(query.forms.length)})`,
      ).all(...query.forms) as PrefetchRaw[];
      for (const r of rows) add(r);
    }
    // Globally recency-sort the deduped union before scoring: the per-token legs
    // each return recency-ordered, but their concatenation is bucketed by token, so
    // without this an older first-token match could precede a newer later-token one
    // and crowd it out under the scorer's input-order tie-break.
    return [...byEmail.values()]
      .sort((a, b) =>
        (b.last_interaction - a.last_interaction)
        || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0))
      .map(toScanRow);
  };

  const countPhoneForm = (form: string): number =>
    (phoneFormCountStmt.get(form) as { n: number }).n;

  // D-167 (recall path, off-cap) — uncapped name/company enumerate for the
  // whole-warehouse recall Aho-Corasick automaton. No recency cap (the A-C build is
  // flat to the value count + memoised once per recalling turn); only the two
  // columns the automaton needs, so no `rowToRecord` parse.
  const namesAndCompaniesStmt = db.prepare(
    `SELECT name, company FROM ${CONTACT_TABLE}
      WHERE name IS NOT NULL OR company IS NOT NULL`,
  );
  const listAllNamesAndCompanies = (): { names: string[]; companies: string[] } => {
    const rows = namesAndCompaniesStmt.all() as Array<{
      name: string | null;
      company: string | null;
    }>;
    const names: string[] = [];
    const companies: string[] = [];
    for (const r of rows) {
      if (r.name) names.push(r.name);
      if (r.company) companies.push(r.company);
    }
    return { names, companies };
  };

  // D-167 (recall path) — street lines + email domains, UNCAPPED, and computed in SQL so no
  // row is parsed that does not contribute. `json_extract` reads the `mailing_address` JSON
  // column directly; the domain is the substring after `@` on the canonical email PK.
  const recallAddressSeedsStmt = db.prepare(
    `SELECT json_extract(mailing_address, '$.address1') AS a1,
            json_extract(mailing_address, '$.address2') AS a2,
            substr(email, instr(email, '@') + 1)        AS domain
       FROM ${CONTACT_TABLE}
      WHERE mailing_address IS NOT NULL OR email IS NOT NULL`,
  );
  const listRecallAddressSeeds = (): { streets: string[]; domains: string[] } => {
    const streets = new Set<string>();
    const domains = new Set<string>();
    for (const r of recallAddressSeedsStmt.all() as Array<{
      a1: string | null;
      a2: string | null;
      domain: string | null;
    }>) {
      for (const line of [r.a1, r.a2]) {
        const trimmed = typeof line === 'string' ? line.trim() : '';
        if (trimmed.length > 0) streets.add(trimmed);
      }
      const domain = typeof r.domain === 'string' ? r.domain.trim().toLowerCase() : '';
      if (domain.length > 0 && domain.includes('.')) domains.add(domain);
    }
    return { streets: [...streets], domains: [...domains] };
  };

  // D-167 (recall path, off-cap) — resolve text-extracted identifier candidates to
  // canonical stored forms, STORE-WIDE + exact. Two exact legs (no FTS, no cap):
  // email PK + `contact_phone_forms`. Bounded by the (small) query, never the
  // warehouse — only identifiers PRESENT in the recalled text are looked up.
  const resolveRecallIdentifiers = (
    query: RecallIdentifierQuery,
  ): RecallIdentifierMatches => {
    const emails: string[] = [];
    if (query.emails.length > 0) {
      const rows = db.prepare(
        `SELECT email FROM ${CONTACT_TABLE} WHERE email IN (${inClause(query.emails.length)})`,
      ).all(...query.emails) as Array<{ email: string }>;
      for (const r of rows) emails.push(r.email);
    }
    const phones: string[] = [];
    if (query.forms.length > 0) {
      const rows = db.prepare(
        `SELECT DISTINCT c.phone AS phone
           FROM ${CONTACT_PHONE_FORMS_TABLE} pf
           JOIN ${CONTACT_TABLE} c ON c.rowid = pf.rowid_ref
          WHERE pf.form IN (${inClause(query.forms.length)}) AND c.phone IS NOT NULL`,
      ).all(...query.forms) as Array<{ phone: string }>;
      for (const r of rows) phones.push(r.phone);
    }
    return { emails, phones };
  };

  // D-145 PA8 — cascade-delete contact_alias rows tied to the deleted
  // contact_id. The substrate intentionally avoids a hard FK on
  // alias.contact_id (matches D-138 P1 discipline so test fixtures
  // can delete + recreate cleanly), so the application-level cascade
  // does the cleanup. Codex P1 fold — without this, alias rows
  // would orphan and `resolveContactReference` could keep returning
  // a dead contact_id.
  const aliasDeleteByContactStmt = db.prepare(
    `DELETE FROM ${CONTACT_ALIAS_TABLE} WHERE contact_id = ?`,
  );

  // D-192 C-2 slice 3 — the same cascade for the two contribution stores slice 1
  // added. They key on `contact_id` and carry no SQL FK either, so without this a
  // deleted contact leaves its `org` / `title` / `address` / `birthday`
  // assertions and every mirrored vendor payload behind — orphan rows no
  // resolver can reach and no delete can ever remove. On a substrate whose whole
  // premise is that personal data stays local and removable, a delete that
  // silently retains the person's employer and mailing address is a defect, not
  // an untidiness.
  const attributeDeleteByContactStmt = db.prepare(
    `DELETE FROM ${CONTACT_ATTRIBUTE_TABLE} WHERE contact_id = ?`,
  );
  const sourceBlobDeleteByContactStmt = db.prepare(
    `DELETE FROM ${CONTACT_SOURCE_BLOB_TABLE} WHERE contact_id = ?`,
  );

  const del = (email: string, opts: ContactWriteOptions = {}): boolean => {
    const canonical = canonicalizeEmail(email);
    if (!canonical) return false;
    const wantsEmit = !!bus && !opts.silent;
    const existing = (getStmt.get(canonical) as ContactRow | undefined);
    // ⚠ D-192 C-2 slice 4 — captured BEFORE the delete, because once the row is gone
    // there is no way to find the group it belonged to.
    //
    // Deleting a MERGED-AWAY contact removes contributions the SURVIVOR was
    // projecting (that is what the merge group means), so the survivor's columns have
    // to be recomputed. Without this, deleting Alice — who had been merged into Bob —
    // leaves Alice's phone number sitting in Bob's `contacts.phone`, and, because
    // `contact_phone_forms` is a trigger-maintained index over THAT column, leaves it
    // store-wide SEARCHABLE. The user deleted the person; her number is still in the
    // warehouse, filed under someone else. On a substrate whose premise is that
    // personal data stays local and removable, that is the defect this cascade exists
    // to prevent, surviving one level up.
    const groupSurvivor = existing?.merged_into
      ? resolvedLiveContact(existing.merged_into)
      : null;
    const tx = db.transaction(() => {
      if (existing) {
        aliasDeleteByContactStmt.run(existing.contact_id);
        attributeDeleteByContactStmt.run(existing.contact_id);
        sourceBlobDeleteByContactStmt.run(existing.contact_id);
      }
      const result = deleteStmt.run(canonical);
      if (result.changes > 0 && groupSurvivor) {
        materializeContactProjection(groupSurvivor.contact_id);
      }
      return result.changes > 0;
    });
    const deleted = tx();
    if (deleted && wantsEmit && existing) emitEvent(canonical, 'deleted', buildPrev(existing));
    if (deleted && storeOpts.onDelete) {
      try { storeOpts.onDelete(canonical); } catch { /* best-effort */ }
    }
    return deleted;
  };

  // Optional filter → the count matches a filtered `list()` (for the UI's
  // "Showing N of M" + load-more). No arg → the whole-table count (the
  // is-the-warehouse-empty callers).
  const count = (query: ContactListQuery = {}): number => {
    const { whereClause, params } = buildContactWhere(query);
    const sql = `SELECT COUNT(*) AS n FROM ${CONTACT_TABLE} ${whereClause}`;
    return (db.prepare(sql).get(...params) as { n: number }).n;
  };

  const walkByEmailStmt = db.prepare(
    `SELECT * FROM ${CONTACT_TABLE}
       WHERE email > ?
       ORDER BY email ASC
       LIMIT ?`,
  );
  const walkByEmail = (after_email: string, batch_size: number): ContactRecord[] => {
    const safeBatch = Math.max(1, Math.min(batch_size, MAX_LIMIT));
    const rows = walkByEmailStmt.all(after_email, safeBatch) as ContactRow[];
    return rows.map(rowToRecord);
  };

  // ── D-138 P1 — resolver + platform link + rejection + queue ────

  const lookup = (canonical: string): { merged_into?: string } | null => {
    const row = getStmt.get(canonical) as ContactRow | undefined;
    if (!row) return null;
    return row.merged_into ? { merged_into: row.merged_into } : {};
  };

  // ── D-192 C-2 slice 4 — `email_alias` becomes the ADDRESS SPACE ────────────
  //
  // What actually changes: identity resolution stops being "walk the `merged_into`
  // chain" and becomes "find the contact that OWNS this address, then resolve THAT
  // CONTACT". The address space is `contact_alias`; the merge graph is
  // `merged_into`; they are different questions and they now have different
  // answers.
  //
  // The payoff is not the hop count — it is that **`merged_into` cannot express
  // "Bob has two email addresses"**. A redirect chain can only say "this whole
  // contact was absorbed by that one", so a second address from a contact book has
  // nowhere to live unless you fabricate a tombstone contact for it. `email_alias`
  // holds both populations natively: merge-derived addresses (a tombstone row also
  // exists) and import-derived ones (no row at all, ever, and there never should be).
  //
  // ⚠ **NOTHING MOVES BETWEEN CONTACTS. Not aliases, not contributions.** The spec's
  // prose says "a merged loser's email BECOMES an `email_alias` of the survivor",
  // and — like C-2b's `legacy` rung — it is not built as written, for a concrete
  // reason: re-pointing a loser's alias rows onto the survivor DESTROYS THE ONE
  // THING `contact.merge.split` NEEDS, which is knowing whose they were. Restoring
  // the loser's primary address on a split is easy (it is the tombstone's PK); but
  // if the loser had a SECOND address of its own, a re-pointed closure cannot tell
  // it from the survivor's, and the split silently keeps it. That is the same defect
  // as moving contributions across `(contact_id, kind, source_id)` — one door over.
  //
  // So the alias's `contact_id` means OWNER, permanently, and a merge never rewrites
  // it. Resolution reads THROUGH the merge edge instead of flattening it: address →
  // owner → (if the owner is a tombstone) the existing chain walk. The walk survives,
  // but it is now the SECOND step, it runs over contacts rather than strings, and it
  // runs only for the merged minority. The unmerged common case — every live contact,
  // and every extra address an import ever attaches — is one indexed lookup.
  const aliasContactIdByEmailStmt = db.prepare(
    `SELECT contact_id FROM ${CONTACT_ALIAS_TABLE}
       WHERE kind = 'email_alias' AND alias_pattern_normalized = ?`,
  );

  /** Any known email — a contact's primary OR any alias it owns — → the OWNING row
   *  (which may be a tombstone; callers decide whether to resolve it onward).
   *
   *  `null` means the address is unknown to every contact. That is not an error, it
   *  is the question the write paths actually need answered: "update Bob" vs "mint a
   *  stranger". Asking `getStmt` alone — "does a contacts row have this PK?" — is
   *  the WRONG question the moment a contact book gives Bob a second address. */
  const contactByAnyEmail = (email: string): ContactRow | null => {
    const canonical = canonicalizeEmail(email);
    if (!canonical) return null;
    const direct = getStmt.get(canonical) as ContactRow | undefined;
    if (direct) return direct;
    const hit = aliasContactIdByEmailStmt.get(normalizeAliasPattern(canonical)) as
      | { contact_id: string }
      | undefined;
    if (!hit) return null;
    return (getByContactIdStmt.get(hit.contact_id) as ContactRow | undefined) ?? null;
  };

  const resolveCanonicalEmail = (
    email: string,
  ): { canonical_email: string; chain_depth: number } => {
    const canonical = canonicalizeEmail(email);
    // An unparseable address stays LOUD — `resolveContactIdentity` throws, and
    // callers rely on that rather than on a silent self-resolution.
    if (!canonical) return resolveContactIdentity(email, lookup);

    const owner = contactByAnyEmail(canonical);

    // Unknown address → itself, depth 0. Load-bearing: every caller canonicalizes
    // BEFORE creating a contact, so a miss must round-trip the input rather than
    // return null.
    if (!owner) return { canonical_email: canonical, chain_depth: 0 };

    // The owner is live — done. One indexed lookup, no walk. This is the common
    // case and it now covers an address the contact merely OWNS (a second mailbox),
    // which the chain walk could never have resolved at all.
    if (!owner.merged_into) {
      return {
        canonical_email: owner.email,
        chain_depth: owner.email === canonical ? 0 : 1,
      };
    }

    // The owner was absorbed. Resolve the CONTACT onward through the merge graph —
    // the same cycle-safe, depth-capped walk as before, just reached differently.
    // Its hops are counted on top of the alias hop (if we took one) so `chain_depth`
    // stays an honest "how far did we travel".
    const walked = resolveContactIdentity(owner.email, lookup);
    return {
      canonical_email: walked.canonical_email,
      chain_depth: walked.chain_depth + (owner.email === canonical ? 0 : 1),
    };
  };

  // Reverse `merged_into` enumeration (interface doc on the method). The walk
  // itself lives in `contact-merge-graph.ts` — ONE definition, shared with
  // every reverse read (D-205 #3.5). Two copies of a graph walk is how the
  // store's member set and a caller's drift apart.
  const mergedSourceEmailsStmt = db.prepare(MERGED_SOURCE_EMAILS_SQL);
  const listMergedSourceEmails = (email: string): string[] => {
    const canonical = canonicalizeEmail(email);
    if (!canonical) return [];
    const rows = mergedSourceEmailsStmt.all(canonical) as { email: string }[];
    return rows.map((r) => r.email);
  };

  /** D-205 #3.5b — the COMPLETE address set. Delegates to the single definition
   *  in `contact-merge-graph`, which owns the walk and caches its statements per
   *  database handle. The store exposes it so a consumer holding only a
   *  `Pick<ContactStore, …>` (the engagement resolver, the chat prompt-cache
   *  gate) can scope by the whole address space without reaching for the raw db
   *  — the same "one definition, two doors" discipline that keeps
   *  `MERGED_SOURCE_EMAILS_SQL` from being copied. */
  const addressSet = (email: string): string[] => contactAddressSet(db, email);

  const fireLinkChange = (change: PlatformLinkChange): void => {
    if (!storeOpts.onPlatformLinkChanged) return;
    try { storeOpts.onPlatformLinkChanged(change); } catch { /* best-effort */ }
  };

  const linkPlatformId = (input: PlatformLinkInput, nowOpt?: number): void => {
    const now = nowOpt ?? nowFn();
    const canonical = canonicalizeEmail(input.canonical_email);
    if (!canonical) {
      throw new Error(`platform_link_invalid_email: ${input.canonical_email}`);
    }
    let priorOwner: string | undefined;
    let isNewOwner = false;
    const tx = db.transaction(() => {
      // D-138 P1 (codex review fix) — when ON CONFLICT rekeys an
      // existing `(vendor, platform_id)` from a previous canonical
      // email to this one, both rows' `platform_ids` JSON
      // materializations need to refresh; otherwise the previous
      // owner keeps the moved entry and `contact.get` shows the
      // same platform record on both contacts. Snapshot the prior
      // owner BEFORE the upsert and re-materialize it after the
      // write if it differs from the new owner.
      const prior = platformLinkLookupStmt.get(input.vendor, input.platform_id) as
        | { canonical_email: string }
        | undefined;
      priorOwner = prior?.canonical_email;
      isNewOwner = !prior;
      platformLinkUpsertStmt.run(
        canonical,
        input.vendor,
        input.platform_id,
        input.state,
        input.linked_at,
        input.linked_by,
        input.connection_name ?? null,
      );
      if (prior && prior.canonical_email !== canonical) {
        materializePlatformIdsJson(prior.canonical_email, now);
      }
      materializePlatformIdsJson(canonical, now);
    });
    tx();
    // D-138 P3 — fire link-change events outside the SQLite tx so
    // listener exceptions don't roll back the write. A re-key
    // (prior !== new) emits both a remove + an add so the cycle
    // observer sees both transitions.
    if (priorOwner && priorOwner !== canonical) {
      fireLinkChange({
        kind: 'removed',
        canonical_email: priorOwner,
        vendor: input.vendor,
        platform_id: input.platform_id,
      });
      fireLinkChange({
        kind: 'added',
        canonical_email: canonical,
        vendor: input.vendor,
        platform_id: input.platform_id,
      });
    } else if (isNewOwner) {
      fireLinkChange({
        kind: 'added',
        canonical_email: canonical,
        vendor: input.vendor,
        platform_id: input.platform_id,
      });
    }
    // priorOwner === canonical (idempotent re-link) → no event
  };

  const unlinkPlatformId = (vendor: string, platform_id: string): string | null => {
    const found = platformLinkLookupStmt.get(vendor, platform_id) as
      | { canonical_email: string }
      | undefined;
    if (!found) return null;
    const now = nowFn();
    const tx = db.transaction(() => {
      platformLinkDeleteStmt.run(vendor, platform_id);
      materializePlatformIdsJson(found.canonical_email, now);
    });
    tx();
    fireLinkChange({
      kind: 'removed',
      canonical_email: found.canonical_email,
      vendor,
      platform_id,
    });
    return found.canonical_email;
  };

  const lookupPlatformLink = (vendor: string, platform_id: string): string | null => {
    const row = platformLinkLookupStmt.get(vendor, platform_id) as
      | { canonical_email: string }
      | undefined;
    return row ? row.canonical_email : null;
  };

  const retractPlatformLinksForConnection = (
    vendor: string,
    connection_name: string,
  ): { links_removed: number; contacts_affected: number } => {
    // Snapshot the (email, platform_id) rows BEFORE the bulk delete so we can
    // re-materialize each affected contact + fire per-link `removed` events —
    // the same discipline `unlinkPlatformId` follows one row at a time. This
    // ONLY removes the sender→email ASSOCIATION; the shared `contacts` row is
    // never touched (a messenger link never owns one — every contact carries a
    // permanent first-party `source`), so there is no contact-delete path here.
    const rows = platformLinkListByConnStmt.all(vendor, connection_name) as Array<{
      canonical_email: string;
      platform_id: string;
    }>;
    if (rows.length === 0) return { links_removed: 0, contacts_affected: 0 };
    const now = nowFn();
    const affected = new Set<string>();
    for (const r of rows) affected.add(r.canonical_email);
    const tx = db.transaction(() => {
      platformLinkDeleteByConnStmt.run(vendor, connection_name);
      // Re-materialize each affected contact's `platform_ids` JSON so the
      // removed association disappears from `contact.get`. A materialize on an
      // email with no `contacts` row is a harmless no-op (the link may have
      // pointed at a not-yet-observed person).
      for (const email of affected) materializePlatformIdsJson(email, now);
    });
    tx();
    // Events fire OUTSIDE the tx (listener throws must not roll back the write),
    // exactly as `unlinkPlatformId` / `linkPlatformId` do.
    for (const r of rows) {
      fireLinkChange({ kind: 'removed', canonical_email: r.canonical_email, vendor, platform_id: r.platform_id });
    }
    return { links_removed: rows.length, contacts_affected: affected.size };
  };

  const countPlatformLinksForConnection = (vendor: string, connection_name: string): number =>
    (platformLinkCountByConnStmt.get(vendor, connection_name) as { n: number }).n;

  const orderedPair = (a: string, b: string): { email_a: string; email_b: string } => {
    return a <= b ? { email_a: a, email_b: b } : { email_a: b, email_b: a };
  };

  const addRejection = (input: RejectionInput): void => {
    const a = canonicalizeEmail(input.email_a);
    const b = canonicalizeEmail(input.email_b);
    if (!a || !b || a === b) {
      throw new Error(`rejection_invalid_pair: ${input.email_a}, ${input.email_b}`);
    }
    const { email_a, email_b } = orderedPair(a, b);
    const now = nowFn();
    const tx = db.transaction(() => {
      rejectionUpsertStmt.run(
        email_a,
        email_b,
        input.rejected_at,
        input.rejected_by ?? null,
        input.source_candidate_id ?? null,
      );
      // Re-materialize both rows' JSON arrays. If either canonical
      // row doesn't exist (dangling rejection — possible if a
      // contact was deleted but the rejection was kept), the update
      // is a silent no-op which is fine — JSON materialization is
      // best-effort.
      materializeRejectedPairsJson(email_a, now);
      materializeRejectedPairsJson(email_b, now);
    });
    tx();
  };

  const removeRejection = (a_in: string, b_in: string): boolean => {
    const a = canonicalizeEmail(a_in);
    const b = canonicalizeEmail(b_in);
    if (!a || !b) return false;
    const { email_a, email_b } = orderedPair(a, b);
    const now = nowFn();
    let changed = false;
    const tx = db.transaction(() => {
      const result = rejectionDeleteStmt.run(email_a, email_b);
      changed = result.changes > 0;
      if (changed) {
        materializeRejectedPairsJson(email_a, now);
        materializeRejectedPairsJson(email_b, now);
      }
    });
    tx();
    return changed;
  };

  const isPairRejected = (a_in: string, b_in: string): boolean => {
    const a = canonicalizeEmail(a_in);
    const b = canonicalizeEmail(b_in);
    if (!a || !b) return false;
    const { email_a, email_b } = orderedPair(a, b);
    const found = rejectionLookupStmt.get(email_a, email_b);
    return !!found;
  };

  const rejectedPairKeys = (): Set<string> => {
    const rows = rejectionAllStmt.all() as { email_a: string; email_b: string }[];
    const out = new Set<string>();
    for (const r of rows) out.add(canonicalPairKey(r.email_a, r.email_b));
    return out;
  };

  const rowToCandidate = (row: MergeCandidateRow): ContactMergeCandidate => {
    const out: ContactMergeCandidate = {
      id: row.id,
      email_a: row.email_a,
      email_b: row.email_b,
      pair_key: row.pair_key,
      matched_fields: safeParseJsonArray<ContactMatchField>(row.matched_fields),
      detected_at: row.detected_at,
      detected_by: row.detected_by as ContactMergeCandidate['detected_by'],
      status: row.status,
    };
    if (row.resolved_at !== null) out.resolved_at = row.resolved_at;
    if (row.resolved_by !== null) out.resolved_by = row.resolved_by;
    return out;
  };

  const enqueueMergeCandidate = (input: MergeCandidateInput): ContactMergeCandidate => {
    const a = canonicalizeEmail(input.email_a);
    const b = canonicalizeEmail(input.email_b);
    if (!a || !b || a === b) {
      throw new Error(`merge_candidate_invalid_pair: ${input.email_a}, ${input.email_b}`);
    }
    const { email_a, email_b } = orderedPair(a, b);
    const pair_key = `${email_a}|${email_b}`;
    const tx = db.transaction(() => {
      // D-138 P1 (codex review fix) — three-state path:
      //   1. No row for the pair → INSERT a fresh pending row with
      //      the caller-supplied id.
      //   2. Existing pending row → INSERT is ON CONFLICT-suppressed;
      //      we return the existing row (idempotent dedup).
      //   3. Existing resolved row (merged/rejected) → INSERT is
      //      ON CONFLICT-suppressed, but we then UPDATE the row
      //      back to pending so `contact.merge.list({ status:
      //      'pending' })` surfaces it again. The row's id stays
      //      stable across the cycle. Used by A.10 re-merge.
      candidateInsertStmt.run(
        input.id,
        email_a,
        email_b,
        pair_key,
        JSON.stringify(input.matched_fields),
        input.detected_at,
        input.detected_by,
      );
      candidateRequeueExistingStmt.run(
        JSON.stringify(input.matched_fields),
        input.detected_at,
        input.detected_by,
        pair_key,
      );
    });
    tx();
    const row = candidateLookupByPairKeyStmt.get(pair_key) as MergeCandidateRow | undefined;
    if (!row) {
      throw new Error(`merge_candidate_persistence_failed: ${pair_key}`);
    }
    return rowToCandidate(row);
  };

  const listMergeCandidates = (
    query: MergeCandidateListQuery = {},
  ): { candidates: ContactMergeCandidate[]; next_cursor?: string } => {
    const status = query.status ?? 'pending';
    const limit = Math.max(1, Math.min(query.limit ?? 50, 500));
    // Cursor encodes the last seen `(detected_at, id)` tuple as a
    // base64 JSON. Simple keyset pagination — `(detected_at, id) <
    // (cursor.detected_at, cursor.id)` keeps the order stable across
    // inserts.
    let where = `status = ?`;
    const params: unknown[] = [status];
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64').toString('utf8')) as {
          detected_at: number;
          id: string;
        };
        where += ` AND (detected_at < ? OR (detected_at = ? AND id < ?))`;
        params.push(decoded.detected_at, decoded.detected_at, decoded.id);
      } catch {
        /* malformed cursor: ignore, return from beginning */
      }
    }
    const sql = `
      SELECT * FROM ${CONTACT_MERGE_CANDIDATE_QUEUE}
        WHERE ${where}
        ORDER BY detected_at DESC, id DESC
        LIMIT ?
    `;
    params.push(limit + 1);
    const rows = db.prepare(sql).all(...params) as MergeCandidateRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const out: { candidates: ContactMergeCandidate[]; next_cursor?: string } = {
      candidates: page.map(rowToCandidate),
    };
    if (hasMore) {
      const last = page[page.length - 1]!;
      out.next_cursor = Buffer.from(
        JSON.stringify({ detected_at: last.detected_at, id: last.id }),
        'utf8',
      ).toString('base64');
    }
    return out;
  };

  const getMergeCandidate = (id: string): ContactMergeCandidate | null => {
    const row = candidateLookupByIdStmt.get(id) as MergeCandidateRow | undefined;
    return row ? rowToCandidate(row) : null;
  };

  const setMergeCandidateStatus = (
    id: string,
    status: 'merged' | 'rejected',
    resolved_at: number,
    resolved_by?: string,
  ): ContactMergeCandidate | null => {
    candidateUpdateStatusStmt.run(status, resolved_at, resolved_by ?? null, id);
    return getMergeCandidate(id);
  };

  const resolveCompanyForDomain = (domain: string): CompanyDomainResolution => {
    const trimmed = domain.trim().toLowerCase();
    if (!trimmed) return { kind: 'empty' };
    const rows = domainSeedPoolStmt.all(`%@${trimmed}`) as { company: string }[];
    if (rows.length === 0) return { kind: 'empty' };
    const distinct = Array.from(new Set(rows.map((r) => r.company)));
    if (distinct.length >= COMPANY_DOMAIN_INFERENCE_MAX_DISTINCT_COMPANIES) {
      return { kind: 'ambiguous' };
    }
    return { kind: 'inferred', company: distinct[0]! };
  };

  // Sanity bound — the resolver helper imports its own limit; the
  // store-level constant is just to assert in tests we wired the
  // import correctly.
  void CONTACT_REDIRECT_CHAIN_LIMIT;

  const setMergedIntoSetStmt = db.prepare(
    `UPDATE ${CONTACT_TABLE}
       SET merged_into = ?,
           phone = NULL,
           mailing_address = NULL,
           company = NULL,
           company_source = NULL,
           name_key = NULL,
           address_zip_country_key = NULL,
           company_norm = NULL,
           -- D-192 C-2 slice 3 — the per-field provenance must go with the
           -- fields. Leaving it behind would leave the tombstone ASSERTING that
           -- its (now NULL) company came from HubSpot — provenance that lies is
           -- worse than provenance that is absent, because a surface renders it
           -- as fact. It also doubles as the "this row has been projected"
           -- marker the cutover backfill reads, and a tombstone has not been.
           projection_provenance = NULL,
           updated_at = ?
       WHERE email = ?`,
  );
  const setMergedIntoClearStmt = db.prepare(
    `UPDATE ${CONTACT_TABLE} SET merged_into = NULL, updated_at = ? WHERE email = ?`,
  );

  /** Any address → the LIVE contact it ultimately belongs to (through an alias, then
   *  through the merge chain), or `null` if there is none. The "who does this row
   *  actually settle on" question, which is the only one a re-projection cares
   *  about. */
  const resolvedLiveContact = (email: string): ContactRow | null => {
    const { canonical_email } = resolveCanonicalEmail(email);
    const row = getStmt.get(canonical_email) as ContactRow | undefined;
    return row && !row.merged_into ? row : null;
  };

  const setMergedInto = (
    rows: ReadonlyArray<ContactRecord>,
    survivor: string | null,
    now: number,
  ): void => {
    const tx = db.transaction(() => {
      // Whose projection changed as a side effect. A merge/split moves NO rows — it
      // only moves the EDGE — but the edge is what the merge group is computed from,
      // so both ends must be re-projected or the columns go stale against a group
      // that has just changed shape. Collected as contact_ids and re-projected once
      // at the end: a multi-loser merge would otherwise re-project the survivor once
      // per loser.
      const reproject = new Set<string>();

      for (const row of rows) {
        if (survivor) {
          // ⚠ REFUSE TO CLOSE A CYCLE. If the survivor already resolves back to this
          // very row, then pointing the row at the survivor completes a loop — and a
          // cyclic `merged_into` graph has no terminal survivor, so every read that
          // walks it (`resolveCanonicalEmail`, the merge-group CTE, `data.timeline`)
          // is left with no correct answer to give.
          //
          // The substrate's contract has always CLAIMED cycles are impossible ("split
          // clears merged_into before a re-merge can set it again"), but nothing
          // enforced it, and `upstream-merge-handler` passes a STORED survivor email
          // that may have been merged onward in the meantime — the one caller that can
          // actually reach this. Checked BEFORE the write, so the graph is never even
          // transiently corrupt, and the whole transaction rolls back.
          if (resolveCanonicalEmail(survivor).canonical_email === row.email) {
            throw new Error(
              `contact_merge_cycle: ${row.email} -> ${survivor} resolves back to ${row.email}`,
            );
          }
          setMergedIntoSetStmt.run(survivor, now, row.email);
          // The SURVIVOR now reads across the loser's contributions (D-192 C-2 slice
          // 4). Its projection must be recomputed — this is the moment a merge
          // actually UNIONS the two people's assertions, which is the whole promise
          // of the contribution model and something the pre-C-2 merge never did (it
          // blanked the loser's fields and kept only the survivor's).
          //
          // Resolve to the TERMINAL survivor, do not trust the argument. The merge
          // rpc passes an already-resolved email, but `upstream-merge-handler` passes
          // a STORED `row.survivor_email` that may since have been merged onward — and
          // the merge group is transitive, so it is the terminal contact whose
          // projection actually changed. A tombstone would simply be skipped here
          // (`!target.merged_into`), silently leaving the real survivor stale.
          const target = resolvedLiveContact(survivor);
          if (target) reproject.add(target.contact_id);
        } else {
          // A SPLIT — the row comes back from tombstone to standalone, and its
          // CONTRIBUTIONS were never destroyed, so re-projecting restores the phone /
          // company / address the merge took away.
          //
          // This is a D-138 bug C-2 fixes for free: pre-C-2, a split cleared
          // `merged_into` and nothing ever refilled those columns, so an undone merge
          // left the contact permanently stripped of its own fields.
          //
          // The FORMER survivor must be re-projected too, and read BEFORE the clear:
          // it has just LOST this contact from its merge group, so any field it was
          // projecting from the loser's contributions has to go. Forgetting this side
          // is the quiet half — the resurrected row looks right while the survivor
          // keeps showing a phone number that now belongs to somebody else.
          //
          // The TERMINAL survivor, again: in an A→B→C chain, splitting A out shrinks
          // C's group as well as B's (the group is transitive), and B is a tombstone
          // that does not project at all. C is the row with columns to fix.
          const formerSurvivor = row.merged_into
            ? resolvedLiveContact(row.merged_into)
            : null;

          // The clear must land BEFORE the materialize — the materializer refuses to
          // project a row that still carries a redirect.
          setMergedIntoClearStmt.run(now, row.email);
          const cleared = getStmt.get(row.email) as ContactRow | undefined;
          if (cleared) reproject.add(cleared.contact_id);
          if (formerSurvivor) reproject.add(formerSurvivor.contact_id);
        }
      }

      for (const contact_id of reproject) materializeContactProjection(contact_id, now);
    });
    tx();
  };

  // ── D-145 PA8 — Contact identity extensions ──────────────────────

  const getByContactIdStmt = db.prepare(
    `SELECT * FROM ${CONTACT_TABLE} WHERE contact_id = ?`,
  );
  const getByContactId = (contact_id: string): ContactRecord | null => {
    if (typeof contact_id !== 'string' || !contact_id.length) return null;
    const row = getByContactIdStmt.get(contact_id) as ContactRow | undefined;
    return row ? rowToRecord(row) : null;
  };

  const insertMentionOnlyStmt = db.prepare(
    `INSERT INTO ${CONTACT_TABLE}
       (email, name, first_seen, last_interaction, interaction_count,
        source, created_at, updated_at,
        platform_ids, rejected_pairs, contact_id, identity_status, network_domain)
       VALUES (?, ?, ?, ?, 0, 'manual', ?, ?, '[]', '[]', ?, 'mention_only', ?)`,
  );

  const createMentionOnlyContact = (
    input: MentionOnlyContactInput,
    nowOpt?: number,
  ): ContactRecord => {
    // Codex P1 fold — mention_only contacts must satisfy the spec
    // § A.4.1 validator gate: at least one of canonical_email, name,
    // or phone must be populated. mention_only by definition has no
    // canonical email; PA8 doesn't carry a phone field on the
    // mention_only input shape; therefore name MUST be non-empty
    // post-trim. Without this gate the substrate would silently
    // accept identity-empty rows that no resolver could ever match.
    const trimmedName = input.name?.trim();
    if (!trimmedName) {
      throw new Error('mention_only_name_required');
    }
    const now = nowOpt ?? nowFn();
    const contactId = input.contact_id ?? newContactId();
    const placeholderEmail = synthesizeMentionOnlyEmail(contactId);
    const firstSeen = input.first_seen ?? now;
    const domains = input.network_domain
      ? sanitizeNetworkDomains(input.network_domain)
      : [];
    insertMentionOnlyStmt.run(
      placeholderEmail,
      trimmedName,
      firstSeen,
      firstSeen,
      now,
      now,
      contactId,
      JSON.stringify(domains),
    );
    // D-192 C-2 slice 3 — the name is the ONLY thing a mention_only contact
    // asserts, and the user typed it (the gate above requires it), so it is
    // `manual`.
    //
    // Deliberately NO `email_alias`: this row's `email` column holds the
    // synthetic `mention-only-…@_recued.invalid` placeholder, which exists purely
    // so the PK constraint has something to hold. It is not an address anyone can
    // reach, and putting it in the globally-unique email index would seed the
    // slice-4 "any known email → this person" resolver with an address that is by
    // construction unknown to everyone. The real one is contributed at promotion.
    upsertContactAttribute(
      {
        contact_id: contactId,
        kind: 'name',
        value: trimmedName,
        source: 'manual',
        source_id: CONTACT_SOURCE_ID_MANUAL,
        as_of: now,
        created_at: now,
      },
      now,
    );
    materializeContactProjection(contactId, now);
    const row = getStmt.get(placeholderEmail) as ContactRow;
    const record = rowToRecord(row);
    emitEvent(placeholderEmail, 'created');
    if (storeOpts.onContactUpserted) {
      try { storeOpts.onContactUpserted(record); } catch { /* best-effort */ }
    }
    return record;
  };

  /** D-205 #4 — mint a contact ROW for an IMPORT. Covers BOTH shapes a contact
   *  book hands over: an entry with an address, and the dentist without one. */
  const insertImportedStmt = db.prepare(
    `INSERT INTO ${CONTACT_TABLE}
       (email, name, first_seen, last_interaction, interaction_count,
        source, created_at, updated_at,
        platform_ids, rejected_pairs, contact_id, identity_status, network_domain,
        origin_actor, origin_contract_id, origin_surface)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, '[]', '[]', ?, ?, ?, 'system', NULL, 'system')`,
  );

  const createImportedContact = (
    input: ImportedContactInput,
    nowOpt?: number,
  ): ContactRecord => {
    const trimmedName = input.name?.trim();
    if (!trimmedName) throw new Error('imported_contact_name_required');

    // ⚠ An importer stamping `manual` would park a vendor's assertion at the TOP
    // of the C-2a ladder, where the user's own typing could never correct it —
    // the precise data loss the ladder exists to prevent. Refuse it here rather
    // than trust every future leaf to remember.
    if (input.source === 'manual') {
      throw new Error(
        'imported_contact_source_manual: an import may never claim the user typed it',
      );
    }

    const now = nowOpt ?? nowFn();
    const contactId = input.contact_id ?? newContactId();

    // The address, or the placeholder that stands in for one. `contacts.email` IS
    // the PK, so a contact without an address still needs something to be keyed
    // on — and everything written about them until they get a real address is
    // keyed on THAT. (Which is why promotion must leave a redirect, and why the
    // address SET spans the alias space: D-205 #3.5b.)
    const canonical = input.email ? canonicalizeEmail(input.email) : null;
    if (input.email && !canonical) {
      throw new Error(`imported_contact_invalid_email: ${input.email}`);
    }
    const email = canonical ?? synthesizeMentionOnlyEmail(contactId);

    // An address makes them `verified` by definition. Without one the caller says
    // which kind of stub this is — `partial` (name + phone/address, no email: the
    // DENTIST) or `mention_only` (a name and nothing else). Defaulting to
    // `mention_only` would under-state every dentist a contact book imports.
    const identity_status: ContactIdentityStatus =
      canonical !== null ? 'verified' : (input.identity_status ?? 'mention_only');

    const firstSeen = input.first_seen ?? now;
    const domains = input.network_domain ? sanitizeNetworkDomains(input.network_domain) : [];

    insertImportedStmt.run(
      email,
      trimmedName,
      firstSeen,
      firstSeen,
      input.source,
      now,
      now,
      contactId,
      identity_status,
      JSON.stringify(domains),
    );

    // 🔑 **NO CONTRIBUTIONS ARE WRITTEN HERE, and that is the whole design.**
    //
    // The caller is the contact-source sync's write pass, which already upserts
    // every alias and attribute the record supplies — at the DECLARATION's rung,
    // carrying the Source's own `SourceRegistration.id`. Writing a `name` here
    // too would either duplicate that row or, worse, write it at the WRONG
    // provenance: this path has no `source_id`, so it would have to route through
    // `contributionSourceIdForRung`, which maps every non-`manual` rung to
    // `recued.derived` — claiming Recued derived from warehouse traffic a name
    // that Google asserted. A provenance lie is worse than an absent one, and it
    // would collide with the contact's real derived rows on
    // `(contact_id, kind, source_id)`.
    //
    // So: this mints an identity. The write pass says what is known about it.
    // The projection is materialized by the caller, ONCE, after every
    // contribution has landed — never per-write, which would briefly project a
    // half-written contribution set.
    const row = getStmt.get(email) as ContactRow;
    const record = rowToRecord(row);
    emitEvent(email, 'created');
    if (storeOpts.onContactUpserted) {
      try { storeOpts.onContactUpserted(record); } catch { /* best-effort */ }
    }
    return record;
  };

  const updateEmailIdentityStmt = db.prepare(
    `UPDATE ${CONTACT_TABLE}
       SET email = ?,
           identity_status = ?,
           name = COALESCE(?, name),
           updated_at = ?
       WHERE contact_id = ?`,
  );

  const promoteMentionOnlyToVerified = (
    input: PromoteMentionOnlyInput,
    nowOpt?: number,
  ): ContactRecord => {
    if (!input.contact_id) {
      throw new Error('promote_contact_id_required');
    }
    const targetEmail = canonicalizeEmail(input.email);
    if (!targetEmail) {
      throw new Error(`promote_invalid_email: ${input.email}`);
    }
    // Defense-in-depth: refuse to "promote" a contact to a synthetic
    // mention-only placeholder. Promotion is the path that takes a row
    // OFF the placeholder; accepting one as the target would leave the
    // row in mention_only-shaped state with identity_status flipped to
    // verified — a contradictory state the substrate refuses to reach.
    if (isMentionOnlyEmail(targetEmail)) {
      throw new Error(`promote_synthetic_email_forbidden: ${targetEmail}`);
    }
    const now = nowOpt ?? nowFn();

    // mention_only contacts graduate; partial contacts also get
    // verified-flipped when a real email arrives. For mention_only
    // specifically the email column is currently the synthetic
    // placeholder that we'll rewrite away.
    const existing = getByContactIdStmt.get(input.contact_id) as ContactRow | undefined;
    if (!existing) {
      throw new Error(`promote_contact_unknown: ${input.contact_id}`);
    }
    // Codex P1 fold — verified contacts MUST NOT be rekeyed via the
    // promotion path. Email changes on a verified row belong to a
    // separate explicit email-change / merge flow; silently rewriting
    // the canonical email here would dodge D-138 reconciliation +
    // surprise downstream consumers that pinned to the prior email.
    // Idempotent path (same email → no-op) stays allowed since it
    // preserves substrate-level invariants without surprise.
    if (existing.identity_status === 'verified' && existing.email !== targetEmail) {
      throw new Error(
        `promote_already_verified: contact_id=${input.contact_id} (use the email-change flow, not promotion)`,
      );
    }

    // Reject collision: if the target email is already attached to a
    // DIFFERENT contact (verified or partial — not the synthetic
    // placeholder of a different mention_only), this isn't a promotion,
    // it's a merge — surface up so caller can route to D-138.
    //
    // D-192 C-2 slice 4 — `contactByAnyEmail`, not `getStmt`. "Already attached"
    // now includes attached AS AN ALIAS: if `mary@gmail.com` is Bob's second
    // mailbox, promoting a mention_only stub onto it is still a collision, and it
    // is still a merge. The PK-only check would have waved it through and let the
    // failure surface three calls deeper as a raw `email_alias_already_attached`
    // out of the alias writer — the same defect class, one door over, and with a
    // far worse error for the caller to route on.
    const collision = contactByAnyEmail(targetEmail);
    if (collision && collision.contact_id !== input.contact_id) {
      throw new Error(`promote_email_already_attached: ${targetEmail}`);
    }

    // Empty-string name patches are coerced to "no patch" — the JS-
    // level coalesce treats `'' ?? null` as `''` (since nullish only
    // covers null/undefined), so we'd otherwise blank an existing name
    // when a caller passes `name: ''`. Treat empty / whitespace-only
    // names as "no patch" so promotion preserves the prior display
    // name for the row.
    const trimmed = input.name?.trim();
    const newName = trimmed ? trimmed : null;
    const tx = db.transaction(() => {
      // ── D-205 — THE REDIRECT. Retain the OUTGOING synthetic address as an
      //    `email_alias` before the PK is overwritten. ────────────────────────
      //
      // 🔑 Promotion is an EMAIL RE-KEY — and the ONLY one in this store
      // (`SET email = ?` appears exactly once, above). The other identity change,
      // a D-138 merge, leaves the loser row standing as a TOMBSTONE (`merged_into`),
      // which its own handler calls "the safety net for any reference that bypassed
      // rewrite". Promotion had NO such net: it rewrote the address in place, and the
      // synthetic placeholder simply CEASED TO EXIST (`createMentionOnlyContact`
      // deliberately withheld the alias, "because all it had was the placeholder").
      // Every stored reference still holding it became a pointer to nothing —
      // `contact_platform_link.canonical_email`, `annotation.target_id`, and
      // `data_task.assigned_contact_id` / `data_commitment.counterparty_contact_id`,
      // which hold an EMAIL despite their names (the `*_contact_id`-holds-an-email
      // naming lie this codebase names out loud in `contact-source-sync.ts`).
      //
      // The alias IS the net: `contactByAnyEmail` falls through the PK miss to the
      // email-alias index, so `resolveCanonicalEmail(<synthetic>)` now returns the
      // contact's REAL address instead of nothing. Same redirect the merge relies on,
      // one alias row instead of a tombstone row.
      //
      // ⚠ It does NOT promote the synthetic into a real address. It has no display
      // consumer, and no vendor can own a `_recued.invalid` mailbox, so it can never
      // match a remote record through `RESOLVABLE_MATCH_KINDS`. `isMentionOnlyEmail`
      // stays the predicate for any surface that must suppress it.
      //
      // ⚠ This closes the FORWARD direction only (a stored ref → the contact). The
      // REVERSE direction — the contact's own rows still keyed on the dead address —
      // needs the identity-change cascade, which the merge half-runs and promotion
      // does not run at all. Do not read this as "promotion is now safe to wire";
      // read D-205 §9 before wiring it (contact books mint these EN MASSE).
      if (isMentionOnlyEmail(existing.email)) {
        upsertContactAlias(
          {
            contact_id: input.contact_id,
            kind: 'email_alias',
            alias_pattern: existing.email,
            source: 'manual',
            source_id: CONTACT_SOURCE_ID_MANUAL,
            created_at: now,
          },
          now,
        );
      }
      updateEmailIdentityStmt.run(
        targetEmail,
        'verified',
        newName,
        now,
        input.contact_id,
      );
      // ── D-192 C-2 slice 3 ───────────────────────────────────────────────────
      //
      // The contact now HAS a real address, so it finally earns an `email_alias`
      // — the one `createMentionOnlyContact` withheld because all it had was the
      // synthetic placeholder. `manual`, because promotion is a user act.
      upsertContactAlias(
        {
          contact_id: input.contact_id,
          kind: 'email_alias',
          alias_pattern: targetEmail,
          source: 'manual',
          source_id: CONTACT_SOURCE_ID_MANUAL,
          created_at: now,
        },
        now,
      );
      if (newName) {
        upsertContactAttribute(
          {
            contact_id: input.contact_id,
            kind: 'name',
            value: newName,
            source: 'manual',
            source_id: CONTACT_SOURCE_ID_MANUAL,
            as_of: now,
            created_at: now,
          },
          now,
        );
      }
      // Re-project. This also derives `name_key`, which verified status now makes
      // load-bearing (it opens the contact to the D-138 candidate scan, and that
      // scan only ever compares pairs that already share a blocking key).
      materializeContactProjection(input.contact_id, now);
    });
    tx();

    const refreshed = getByContactIdStmt.get(input.contact_id) as ContactRow;
    const record = rowToRecord(refreshed);
    emitEvent(targetEmail, 'updated', buildPrev(existing));
    if (storeOpts.onContactUpserted) {
      try { storeOpts.onContactUpserted(record); } catch { /* best-effort */ }
    }
    return record;
  };

  const updateNetworkDomainStmt = db.prepare(
    `UPDATE ${CONTACT_TABLE}
       SET network_domain = ?, updated_at = ?
       WHERE contact_id = ?`,
  );

  const setNetworkDomain = (
    contact_id: string,
    domains: readonly NetworkDomain[],
    nowOpt?: number,
  ): ContactRecord => {
    const sanitized = sanitizeNetworkDomains(domains);
    const existing = getByContactIdStmt.get(contact_id) as ContactRow | undefined;
    if (!existing) {
      throw new Error(`network_domain_contact_unknown: ${contact_id}`);
    }
    const now = nowOpt ?? nowFn();
    updateNetworkDomainStmt.run(JSON.stringify(sanitized), now, contact_id);
    const refreshed = getByContactIdStmt.get(contact_id) as ContactRow;
    const record = rowToRecord(refreshed);
    emitEvent(refreshed.email, 'updated', buildPrev(existing));
    return record;
  };

  // ── D-145 PB11 — personal_recipes column accessors ───────────────

  const personalRecipesUpdateStmt = db.prepare(
    `UPDATE ${CONTACT_TABLE}
       SET personal_recipes = ?, updated_at = ?
       WHERE contact_id = ?`,
  );

  const readPersonalRecipes = (
    row: ContactRow,
  ): PersonalRecipeEntry[] => {
    // The column has a default of `'[]'` at insert time; legacy rows
    // backfill empty by virtue of the NOT NULL DEFAULT clause. The
    // safeParseJsonArray helper handles the legacy-blob-corrupted case
    // (returns []) without throwing.
    return safeParseJsonArray<PersonalRecipeEntry>(row.personal_recipes);
  };

  const getPersonalRecipes = (
    contact_id: string,
  ): readonly PersonalRecipeEntry[] => {
    const row = getByContactIdStmt.get(contact_id) as ContactRow | undefined;
    if (!row) return [];
    return readPersonalRecipes(row);
  };

  const writePersonalRecipes = (
    contact_id: string,
    nextEntries: readonly PersonalRecipeEntry[],
    existing: ContactRow,
  ): readonly PersonalRecipeEntry[] => {
    assertValidPersonalRecipesBlob(nextEntries);
    const now = nowFn();
    personalRecipesUpdateStmt.run(JSON.stringify(nextEntries), now, contact_id);
    const refreshed = getByContactIdStmt.get(contact_id) as ContactRow;
    // PB11 § B.12.4: blob mutations emit a `data.contact.*.updated`
    // bus event so reactive surfaces (Settings UI listening for
    // contact changes, future MCP tag-watcher) refresh without
    // polling. Mirrors setNetworkDomain's emit discipline.
    emitEvent(refreshed.email, 'updated', buildPrev(existing));
    return readPersonalRecipes(refreshed);
  };

  const addPersonalRecipe = (
    contact_id: string,
    entry: PersonalRecipeEntry,
  ): readonly PersonalRecipeEntry[] => {
    const existing = getByContactIdStmt.get(contact_id) as ContactRow | undefined;
    if (!existing) {
      throw new Error(`personal_recipe_contact_unknown: ${contact_id}`);
    }
    // Codex P2 fold (2026-05-10) — validate the incoming entry BEFORE
    // the duplicate-skip path so a malformed entry that happens to
    // collide with an existing (recipe_id, topic) pair doesn't get
    // silently accepted. The writePersonalRecipes path runs the same
    // assertion, but the idempotent return-early below bypasses it.
    assertValidPersonalRecipesBlob([entry]);
    const current = readPersonalRecipes(existing);
    // Idempotent on (recipe_id, normalized topic) — the validator's
    // duplicate_entry guard would otherwise reject. Returning the
    // current array unchanged matches Settings UI "add" semantics
    // (the user clicked Add but the binding already exists).
    const normalizedTopic = normalizeTopic(entry.topic);
    const duplicate = current.find(
      (e) => e.recipe_id === entry.recipe_id
        && normalizeTopic(e.topic) === normalizedTopic,
    );
    if (duplicate) return current;
    const next = [...current, entry];
    return writePersonalRecipes(contact_id, next, existing);
  };

  const setPersonalRecipeEnabled = (
    contact_id: string,
    recipe_id: string,
    topic: string,
    enabled: boolean,
  ): readonly PersonalRecipeEntry[] => {
    const existing = getByContactIdStmt.get(contact_id) as ContactRow | undefined;
    if (!existing) {
      throw new Error(`personal_recipe_contact_unknown: ${contact_id}`);
    }
    const current = readPersonalRecipes(existing);
    const normalizedTopic = normalizeTopic(topic);
    let touched = false;
    const next = current.map((e) => {
      if (e.recipe_id === recipe_id && normalizeTopic(e.topic) === normalizedTopic) {
        touched = true;
        return { ...e, enabled };
      }
      return e;
    });
    if (!touched) {
      throw new Error(
        `personal_recipe_entry_unknown: contact_id='${contact_id}' recipe_id='${recipe_id}' topic='${topic}'`,
      );
    }
    return writePersonalRecipes(contact_id, next, existing);
  };

  const removePersonalRecipe = (
    contact_id: string,
    recipe_id: string,
    topic: string,
  ): readonly PersonalRecipeEntry[] => {
    const existing = getByContactIdStmt.get(contact_id) as ContactRow | undefined;
    if (!existing) {
      // Settings UI may call remove after a contact got merged away;
      // silent empty return matches the "missing entries are no-op"
      // contract on the interface.
      return [];
    }
    const current = readPersonalRecipes(existing);
    const normalizedTopic = normalizeTopic(topic);
    const next = current.filter(
      (e) => !(e.recipe_id === recipe_id
              && normalizeTopic(e.topic) === normalizedTopic),
    );
    if (next.length === current.length) {
      // Entry absent — return current array unchanged without an
      // emit (no state changed; bus event would be noise).
      return current;
    }
    return writePersonalRecipes(contact_id, next, existing);
  };

  const setPersonalRecipes = (
    contact_id: string,
    entries: readonly PersonalRecipeEntry[],
  ): readonly PersonalRecipeEntry[] => {
    const existing = getByContactIdStmt.get(contact_id) as ContactRow | undefined;
    if (!existing) {
      throw new Error(`personal_recipe_contact_unknown: ${contact_id}`);
    }
    return writePersonalRecipes(contact_id, entries, existing);
  };

  // ── contact_alias substrate ─────────────────────────────────────

  const aliasInsertStmt = db.prepare(
    `INSERT INTO ${CONTACT_ALIAS_TABLE}
       (id, contact_id, kind, platform, alias_pattern, alias_pattern_normalized,
        source, source_id, confidence, created_at, last_resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const aliasDeleteBySourceStmt = db.prepare(
    `DELETE FROM ${CONTACT_ALIAS_TABLE} WHERE source_id = ?`,
  );
  // D-192 C-2 slice 6a — the CONTACT-SCOPED withdrawal: scope a Source teardown to
  // one person instead of all of them.
  //
  // ⚠ D-205 §1 — NOT a per-record delete-cascade. A vendor deleting their record
  // withdraws nothing; only the explicit user-driven teardown removes imported data.
  const aliasDeleteBySourceContactStmt = db.prepare(
    `DELETE FROM ${CONTACT_ALIAS_TABLE} WHERE source_id = ? AND contact_id = ?`,
  );
  const aliasLookupChatStmt = db.prepare(
    `SELECT * FROM ${CONTACT_ALIAS_TABLE}
       WHERE kind = 'chat_alias'
         AND contact_id = ?
         AND alias_pattern_normalized = ?`,
  );
  const aliasLookupPlatformPerContactStmt = db.prepare(
    `SELECT * FROM ${CONTACT_ALIAS_TABLE}
       WHERE kind = 'platform_id'
         AND contact_id = ?
         AND platform = ?
         AND alias_pattern_normalized = ?`,
  );
  const aliasLookupPlatformGlobalStmt = db.prepare(
    `SELECT * FROM ${CONTACT_ALIAS_TABLE}
       WHERE kind = 'platform_id'
         AND platform = ?
         AND alias_pattern_normalized = ?`,
  );
  const aliasDeleteStmt = db.prepare(
    `DELETE FROM ${CONTACT_ALIAS_TABLE} WHERE id = ?`,
  );
  // D-192 C-2 — lookups for the two new identifier kinds.
  const aliasLookupEmailGlobalStmt = db.prepare(
    `SELECT * FROM ${CONTACT_ALIAS_TABLE}
       WHERE kind = 'email_alias'
         AND alias_pattern_normalized = ?`,
  );
  const aliasLookupPhonePerContactStmt = db.prepare(
    `SELECT * FROM ${CONTACT_ALIAS_TABLE}
       WHERE kind = 'phone_alias'
         AND contact_id = ?
         AND alias_pattern_normalized = ?`,
  );
  /** Kind-agnostic read-back. The post-insert fetch used to reconstruct the
   *  per-kind lookup, which meant every NEW alias kind silently broke it (C-2's
   *  two additions did exactly that). Fetching by the id we just minted cannot
   *  rot. */
  const aliasGetByIdStmt = db.prepare(
    `SELECT * FROM ${CONTACT_ALIAS_TABLE} WHERE id = ?`,
  );
  const aliasListByContactStmt = db.prepare(
    `SELECT * FROM ${CONTACT_ALIAS_TABLE}
       WHERE contact_id = ?
       ORDER BY created_at ASC, id ASC`,
  );
  const aliasListByContactKindStmt = db.prepare(
    `SELECT * FROM ${CONTACT_ALIAS_TABLE}
       WHERE contact_id = ? AND kind = ?
       ORDER BY created_at ASC, id ASC`,
  );
  const aliasListChatNormalizedStmt = db.prepare(
    `SELECT * FROM ${CONTACT_ALIAS_TABLE}
       WHERE kind = 'chat_alias'
         AND alias_pattern_normalized = ?`,
  );
  const aliasUpdateLastResolvedStmt = db.prepare(
    `UPDATE ${CONTACT_ALIAS_TABLE}
       SET last_resolved_at = ?
       WHERE id = ?`,
  );
  // Codex P2 fold — confidence-promoting upsert overwrite. Updates
  // (source, confidence, alias_pattern) when the incoming write
  // outranks the stored row per `aliasIncomingOutranks`. id /
  // contact_id / kind / platform / alias_pattern_normalized stay
  // pinned; alias_pattern is updated so the user-visible casing
  // matches the latest writer (e.g. user-set "Mom" overrides
  // ai_inferred "mom").
  const aliasUpdateSourceConfidenceStmt = db.prepare(
    // D-192 C-2 — `source_id` travels WITH `source` on a promotion. A stronger
    // writer taking over an alias takes over its authorship too; leaving the old
    // instance behind would attribute the new value to whoever happened to write
    // it first.
    `UPDATE ${CONTACT_ALIAS_TABLE}
       SET source = ?,
           source_id = ?,
           confidence = ?,
           alias_pattern = ?
       WHERE id = ?`,
  );

  const rowToAlias = (row: ContactAliasRow): ContactAliasRecord => {
    const out: ContactAliasRecord = {
      id: row.id,
      contact_id: row.contact_id,
      kind: row.kind,
      alias_pattern: row.alias_pattern,
      alias_pattern_normalized: row.alias_pattern_normalized,
      source: row.source,
      confidence: row.confidence,
      created_at: row.created_at,
    };
    if (row.platform !== null) out.platform = row.platform;
    if (row.source_id !== null) out.source_id = row.source_id;
    if (row.last_resolved_at !== null) out.last_resolved_at = row.last_resolved_at;
    return out;
  };

  const upsertContactAlias = (
    input: ContactAliasInput,
    nowOpt?: number,
  ): ContactAliasRecord => {
    validateContactAliasInput(input);
    // Verify the contact exists — alias rows referencing missing contacts
    // would silently outlive their contact (no FK by design — partial
    // unique indexes do the heavy lifting, hard FK would block test
    // fixtures that delete + recreate). Substrate-level guard.
    const target = getByContactIdStmt.get(input.contact_id) as ContactRow | undefined;
    if (!target) {
      throw new Error(`contact_alias_contact_unknown: ${input.contact_id}`);
    }
    const now = nowOpt ?? nowFn();
    // D-192 C-2 — `manual` is the unified ladder's name for what PA8 called
    // `user_set`. A hand-typed alias is certain by construction; every other
    // source defaults to 0.8 and can be promoted by a stronger writer.
    const confidence = input.confidence ?? (input.source === 'manual' ? 1.0 : 0.8);

    // ── Normalization: the form MUST match what the row it identifies holds ──
    //
    // An `email_alias` normalizes through `canonicalizeEmail`, NOT the generic
    // alias normalizer. This is load-bearing, not tidiness: `contacts.email`
    // stores the canonicalized form, and slice 4 resolves "any known email →
    // this person" by matching an alias against it. A drifted form here would
    // not error — it would simply never MATCH, and the contact would look like a
    // stranger. (The same hazard `chat-recall-index` already documents: a
    // drifted form is a MISS.)
    const normalized =
      input.kind === 'email_alias'
        ? canonicalizeEmail(input.alias_pattern)
        : normalizeAliasPattern(input.alias_pattern);
    if (!normalized) {
      throw new Error(
        `contact_alias_pattern_invalid: kind=${input.kind}, pattern=${input.alias_pattern}`,
      );
    }

    // ── Per-kind identity strategy ────────────────────────────────────────
    //
    // Two axes: how a duplicate is FOUND, and whether the kind is GLOBALLY
    // unique (an identifier that reaches exactly one human) or merely
    // per-contact unique (a label several people may legitimately share).
    //
    //   chat_alias  — per-contact. "mom" means a different person to each contact.
    //   platform_id — GLOBAL. One Facebook profile is one human.
    //   email_alias — GLOBAL. An email address reaches exactly one person, which
    //                 is precisely what lets slice 4 collapse the `merged_into`
    //                 redirect-chain walk into one indexed lookup.
    //   phone_alias — per-contact. A household or office line legitimately
    //                 belongs to several people.
    //
    // ⚠ An EXHAUSTIVE switch, deliberately. Before C-2 this was
    // `if (chat_alias) … else <assume platform_id>` — so widening the union
    // silently routed the two new kinds into the platform branch, where
    // `input.platform!` is `undefined`. It failed loudly only because the
    // persistence guard caught the empty read-back; nothing in the type system
    // objected. The `never` default below makes the NEXT new kind a compile
    // error instead of a silent mis-route.
    const incoming = { source: input.source, confidence };
    let existing: ContactAliasRow | undefined;

    switch (input.kind) {
      case 'chat_alias':
        existing = aliasLookupChatStmt.get(input.contact_id, normalized) as
          | ContactAliasRow
          | undefined;
        break;
      case 'phone_alias':
        existing = aliasLookupPhonePerContactStmt.get(input.contact_id, normalized) as
          | ContactAliasRow
          | undefined;
        break;
      case 'platform_id': {
        const platform = input.platform;
        if (!platform) {
          throw new Error('contact_alias_platform_required: kind=platform_id');
        }
        const global = aliasLookupPlatformGlobalStmt.get(platform, normalized) as
          | ContactAliasRow
          | undefined;
        if (global && global.contact_id !== input.contact_id) {
          throw new Error(
            `platform_id_already_attached: platform=${platform}, contact_id=${global.contact_id}`,
          );
        }
        existing = global;
        break;
      }
      case 'email_alias': {
        const global = aliasLookupEmailGlobalStmt.get(normalized) as
          | ContactAliasRow
          | undefined;
        if (global && global.contact_id !== input.contact_id) {
          // Two people cannot share an address. Surfacing this as a named error
          // (rather than letting the UNIQUE index raise a raw SQLITE_CONSTRAINT)
          // gives the merge UX something to act on: this is the signal that the
          // two contacts are the same human.
          throw new Error(
            `email_alias_already_attached: contact_id=${global.contact_id}`,
          );
        }
        existing = global;
        break;
      }
      default: {
        const unreachable: never = input.kind;
        throw new Error(`contact_alias_kind_unsupported: ${String(unreachable)}`);
      }
    }

    // Codex P2 fold — alias confidence promotion. When a duplicate upsert
    // arrives, the substrate compares (source rank, confidence) and overwrites
    // the stored row when the incoming outranks it. user_set always wins;
    // chat_confirmed beats tag_button beats ai_inferred. Without this, an early
    // ai_inferred at confidence 0.6 silently shadows a later user_set 1.0.
    if (existing) {
      if (aliasIncomingOutranks(incoming, existing)) {
        aliasUpdateSourceConfidenceStmt.run(
          input.source,
          input.source_id ??
            (input.source === 'manual' ? CONTACT_SOURCE_ID_MANUAL : null),
          confidence,
          input.alias_pattern,
          existing.id,
        );
        return rowToAlias(aliasGetByIdStmt.get(existing.id) as ContactAliasRow);
      }
      return rowToAlias(existing);
    }

    const id = input.id ?? `alias_${randomUUID().replace(/-/g, '')}`;
    const platform: ContactAliasPlatform | null = input.kind === 'platform_id'
      ? (input.platform ?? null)
      : null;
    // WHO wrote it. A `manual` write is knowable without being told — there is
    // exactly one of the user — so it self-fills. Anything else that declines to
    // say records NULL, and the projection then honestly reports "unknown"
    // rather than inventing an instance.
    const source_id: string | null =
      input.source_id ?? (input.source === 'manual' ? CONTACT_SOURCE_ID_MANUAL : null);
    aliasInsertStmt.run(
      id,
      input.contact_id,
      input.kind,
      platform,
      input.alias_pattern,
      normalized,
      input.source,
      source_id,
      confidence,
      input.created_at ?? now,
    );

    // Read back by the id we just minted — kind-agnostic, so no future alias
    // kind can rot it (the old per-kind reconstruction is what C-2 broke).
    const fetched = aliasGetByIdStmt.get(id) as ContactAliasRow | undefined;
    if (!fetched) {
      throw new Error('contact_alias_persistence_failed');
    }
    return rowToAlias(fetched);
  };

  const deleteContactAlias = (id: string): boolean => {
    if (typeof id !== 'string' || !id.length) return false;
    const result = aliasDeleteStmt.run(id);
    return result.changes > 0;
  };

  /** Drop every alias a Source supplied — the identifier-axis half of Source
   *  teardown, twin of `deleteContactAttributesForSource`. Unimplementable
   *  without `source_id`: a disconnected Google account's phone aliases are
   *  otherwise indistinguishable from a still-connected Outlook's. */
  const deleteContactAliasesForSource = (source_id: string, contact_id?: string): number => {
    if (!source_id) return 0;
    // ⚠ An OMITTED `contact_id` means "every contact" (Source teardown) — but an
    // EMPTY-STRING one would silently mean the same thing if we only checked
    // truthiness on the pair, quietly widening a one-record withdrawal into a
    // whole-Source purge. So the two paths are chosen on `undefined`, and an
    // empty contact_id withdraws nothing.
    if (contact_id === undefined) return aliasDeleteBySourceStmt.run(source_id).changes;
    if (!contact_id) return 0;
    return aliasDeleteBySourceContactStmt.run(source_id, contact_id).changes;
  };

  const listContactAliases = (
    contact_id: string,
    kind?: ContactAliasKind,
  ): readonly ContactAliasRecord[] => {
    if (!contact_id) return [];
    const rows = (kind
      ? aliasListByContactKindStmt.all(contact_id, kind)
      : aliasListByContactStmt.all(contact_id)) as ContactAliasRow[];
    return rows.map(rowToAlias);
  };

  // ── D-192 C-2 — the contribution substrate ───────────────────────
  //
  // Two stores, one shape. `contact_attribute` holds descriptive facts;
  // `contact_source_blob` holds the raw remote record they were derived from.
  // Both key on `contact_id` — never on email — which is what makes the C-2
  // internal re-key work without touching the physical `contacts` table.

  interface ContactAttributeRow {
    id: string;
    contact_id: string;
    kind: string;
    value: string;
    source_id: string;
    source: string;
    confidence: number;
    as_of: number;
    created_at: number;
  }

  interface ContactSourceBlobRow {
    id: string;
    contact_id: string;
    /** Nullable in SQL only — the ALTER could not add NOT NULL. The single
     *  writer rejects an empty one, so a real row always carries it. */
    source_id: string | null;
    vendor: string;
    remote_id: string;
    blob: string;
    snapshot_hash: string;
    as_of: number;
    created_at: number;
    /** D-205 §1 — NULL while the vendor's record is still there. */
    disconnected_at: number | null;
  }

  // UPSERT on (contact_id, kind, source) — a source restating a field
  // overwrites its OWN claim only. `created_at` is preserved on conflict
  // (first-seen time, the SourceMirrorStore discipline); `as_of` is not — it is
  // the source's event time and a restatement legitimately moves it forward.
  const attributeUpsertStmt = db.prepare(
    `INSERT INTO ${CONTACT_ATTRIBUTE_TABLE}
       (id, contact_id, kind, value, source_id, source, confidence, as_of, created_at)
       VALUES (@id, @contact_id, @kind, @value, @source_id, @source, @confidence, @as_of, @created_at)
     ON CONFLICT(contact_id, kind, source_id) DO UPDATE SET
       value      = excluded.value,
       -- The rung travels with the row: a source that is re-declared at a
       -- different trust level (a connection re-enrolled, a producer promoted)
       -- must re-rank, not keep its old standing.
       source     = excluded.source,
       confidence = excluded.confidence,
       as_of      = excluded.as_of`,
  );
  const attributeGetOriginStmt = db.prepare(
    `SELECT * FROM ${CONTACT_ATTRIBUTE_TABLE}
       WHERE contact_id = ? AND kind = ? AND source_id = ?`,
  );
  const attributeDeleteBySourceStmt = db.prepare(
    `DELETE FROM ${CONTACT_ATTRIBUTE_TABLE} WHERE source_id = ?`,
  );
  // D-192 C-2 slice 6a — the CONTACT-SCOPED withdrawal (see the alias twin). ⚠ D-205
  // §1: teardown-scoping only, NOT a per-record delete-cascade.
  const attributeDeleteBySourceContactStmt = db.prepare(
    `DELETE FROM ${CONTACT_ATTRIBUTE_TABLE} WHERE source_id = ? AND contact_id = ?`,
  );
  const attributeListByContactStmt = db.prepare(
    `SELECT * FROM ${CONTACT_ATTRIBUTE_TABLE}
       WHERE contact_id = ?
       ORDER BY created_at ASC, id ASC`,
  );
  const attributeListByContactKindStmt = db.prepare(
    `SELECT * FROM ${CONTACT_ATTRIBUTE_TABLE}
       WHERE contact_id = ? AND kind = ?
       ORDER BY created_at ASC, id ASC`,
  );
  const attributeDeleteStmt = db.prepare(
    `DELETE FROM ${CONTACT_ATTRIBUTE_TABLE} WHERE id = ?`,
  );

  const rowToAttribute = (row: ContactAttributeRow): ContactAttributeRecord => ({
    id: row.id,
    contact_id: row.contact_id,
    kind: row.kind as ContactAttributeKind,
    value: JSON.parse(row.value) as unknown,
    source_id: row.source_id,
    source: row.source as ContactContributionSource,
    confidence: row.confidence,
    as_of: row.as_of,
    created_at: row.created_at,
  });

  const upsertContactAttribute = (
    input: ContactAttributeInput,
    now = Date.now(),
  ): ContactAttributeRecord => {
    // Validate the closed vocabularies at the door. An unknown `source` would
    // otherwise sail through, rank LAST at projection time (the runtime floor),
    // and read as "this source is just weak" rather than "this source is a
    // typo" — a silent mis-rank is worse than a loud reject.
    if (!isContactAttributeKind(input.kind)) {
      throw new Error(`contact_attribute_kind_invalid: ${String(input.kind)}`);
    }
    if (!isContactContributionSource(input.source)) {
      throw new Error(`contact_attribute_source_invalid: ${String(input.source)}`);
    }
    // `source_id` is the row's identity. An empty one would collapse every
    // writer at a given rung onto a single row — the peer-clobber this key
    // exists to prevent — so it is a hard requirement, not a defaulted field.
    if (!input.source_id) {
      throw new Error(`contact_attribute_source_id_required: ${input.kind}`);
    }
    if (input.value === undefined) {
      throw new Error(`contact_attribute_value_required: ${input.kind}`);
    }
    // Same convention as `upsertContactAlias`: the contact must exist. No SQL
    // FK (the alias table's precedent — partial unique indexes do the work), so
    // the guard is explicit or an orphan contribution would project into
    // nothing forever.
    if (getByContactIdStmt.get(input.contact_id) === undefined) {
      throw new Error(`contact_attribute_contact_unknown: ${input.contact_id}`);
    }

    const confidence =
      typeof input.confidence === 'number' ? input.confidence : 1.0;
    if (confidence < 0 || confidence > 1) {
      throw new Error(`contact_attribute_confidence_range: ${confidence}`);
    }

    const existing = attributeGetOriginStmt.get(
      input.contact_id,
      input.kind,
      input.source_id,
    ) as ContactAttributeRow | undefined;

    attributeUpsertStmt.run({
      id: existing?.id ?? input.id ?? `attr_${randomUUID().replace(/-/g, '')}`,
      contact_id: input.contact_id,
      kind: input.kind,
      value: JSON.stringify(input.value),
      source_id: input.source_id,
      source: input.source,
      confidence,
      as_of: input.as_of ?? now,
      // First-seen wins — a restatement never resets the ingestion clock.
      created_at: existing?.created_at ?? input.created_at ?? now,
    });

    return rowToAttribute(
      attributeGetOriginStmt.get(
        input.contact_id,
        input.kind,
        input.source_id,
      ) as ContactAttributeRow,
    );
  };

  /** Drop every attribute contribution a Source made — the teardown half of
   *  D-192 source-data-removal. Without a `source_id` this would be
   *  unimplementable: there would be no way to tell a disconnected Google
   *  account's assertions from a still-connected Outlook one's. */
  const deleteContactAttributesForSource = (source_id: string, contact_id?: string): number => {
    if (!source_id) return 0;
    // See the alias twin: `undefined` = whole-Source teardown; an empty string
    // must NOT silently widen into one.
    if (contact_id === undefined) return attributeDeleteBySourceStmt.run(source_id).changes;
    if (!contact_id) return 0;
    return attributeDeleteBySourceContactStmt.run(source_id, contact_id).changes;
  };

  const listContactAttributes = (
    contact_id: string,
    kind?: ContactAttributeKind,
  ): readonly ContactAttributeRecord[] => {
    if (!contact_id) return [];
    const rows = (kind
      ? attributeListByContactKindStmt.all(contact_id, kind)
      : attributeListByContactStmt.all(contact_id)) as ContactAttributeRow[];
    return rows.map(rowToAttribute);
  };

  const deleteContactAttribute = (id: string): boolean =>
    attributeDeleteStmt.run(id).changes > 0;

  // ── contact_source_blob ──────────────────────────────────────────

  const sourceBlobUpsertStmt = db.prepare(
    `INSERT INTO ${CONTACT_SOURCE_BLOB_TABLE}
       (id, contact_id, source_id, vendor, remote_id, blob, snapshot_hash, as_of, created_at)
       VALUES (@id, @contact_id, @source_id, @vendor, @remote_id, @blob, @snapshot_hash, @as_of, @created_at)
     ON CONFLICT(source_id, remote_id) DO UPDATE SET
       contact_id    = excluded.contact_id,
       blob          = excluded.blob,
       snapshot_hash = excluded.snapshot_hash,
       as_of         = excluded.as_of,
       -- D-205 §1 — a record we just polled is, by definition, there. An upsert
       -- CLEARS the soft mark, so a record that comes back (undeleted upstream)
       -- is connected again and rejoins the delete diff. Without this it would
       -- stay marked forever: omitted from the hash map, therefore never
       -- hash-skipped, therefore re-contributed on every single cycle.
       disconnected_at = NULL`,
  );
  const sourceBlobGetRemoteStmt = db.prepare(
    `SELECT * FROM ${CONTACT_SOURCE_BLOB_TABLE}
       WHERE source_id = ? AND remote_id = ?`,
  );
  // D-205 §1 — DISCONNECTED ROWS ARE OMITTED. This map is read for two things and
  // the omission is right for both: it is the delete diff's `priorKeys` (a row
  // already disconnected must never re-enter it as "prior but not polled", or the
  // diff re-fires on it every cycle, forever), and it is the hash-skip (a record
  // that comes back must be re-contributed, not skipped as unchanged).
  const sourceBlobHashesStmt = db.prepare(
    `SELECT remote_id, snapshot_hash FROM ${CONTACT_SOURCE_BLOB_TABLE}
       WHERE source_id = ? AND disconnected_at IS NULL`,
  );
  const sourceBlobDisconnectStmt = db.prepare(
    `UPDATE ${CONTACT_SOURCE_BLOB_TABLE}
        SET disconnected_at = ?
      WHERE source_id = ? AND remote_id = ? AND disconnected_at IS NULL`,
  );
  const sourceBlobListByContactStmt = db.prepare(
    `SELECT * FROM ${CONTACT_SOURCE_BLOB_TABLE}
       WHERE contact_id = ?
       ORDER BY created_at ASC, id ASC`,
  );
  const sourceBlobDeleteSourceStmt = db.prepare(
    `DELETE FROM ${CONTACT_SOURCE_BLOB_TABLE} WHERE source_id = ?`,
  );

  const rowToSourceBlob = (row: ContactSourceBlobRow): ContactSourceBlobRecord => ({
    id: row.id,
    contact_id: row.contact_id,
    // The column is nullable at the SQL level (SQLite cannot ADD a NOT NULL
    // column) but never null in practice — `upsertContactSourceBlob` is the one
    // writer and it rejects an empty `source_id`. Coalesced rather than asserted
    // so a hand-edited row degrades to '' instead of poisoning a caller's key.
    source_id: row.source_id ?? '',
    vendor: row.vendor,
    remote_id: row.remote_id,
    blob: JSON.parse(row.blob) as unknown,
    snapshot_hash: row.snapshot_hash,
    as_of: row.as_of,
    created_at: row.created_at,
    disconnected_at: row.disconnected_at ?? null,
  });

  const upsertContactSourceBlob = (
    input: ContactSourceBlobInput,
    now = Date.now(),
  ): ContactSourceBlobRecord => {
    // `source_id` is the mirror key's WHO half. Enforced here rather than by a
    // NOT NULL column because SQLite cannot add one to an existing table, and a
    // constraint that holds only on fresh databases is worse than none — it
    // stops holding exactly where it is never exercised. One writer, one guard.
    if (!input.source_id) throw new Error('contact_source_blob_source_id_required');
    if (!input.vendor) throw new Error('contact_source_blob_vendor_required');
    if (!input.remote_id) throw new Error('contact_source_blob_remote_id_required');
    if (!input.snapshot_hash) {
      throw new Error('contact_source_blob_snapshot_hash_required');
    }
    if (getByContactIdStmt.get(input.contact_id) === undefined) {
      throw new Error(`contact_source_blob_contact_unknown: ${input.contact_id}`);
    }

    const existing = sourceBlobGetRemoteStmt.get(input.source_id, input.remote_id) as
      | ContactSourceBlobRow
      | undefined;

    sourceBlobUpsertStmt.run({
      id: existing?.id ?? input.id ?? `csb_${randomUUID().replace(/-/g, '')}`,
      contact_id: input.contact_id,
      source_id: input.source_id,
      vendor: input.vendor,
      remote_id: input.remote_id,
      blob: JSON.stringify(input.blob ?? null),
      snapshot_hash: input.snapshot_hash,
      as_of: input.as_of ?? now,
      created_at: existing?.created_at ?? input.created_at ?? now,
    });

    return rowToSourceBlob(
      sourceBlobGetRemoteStmt.get(input.source_id, input.remote_id) as ContactSourceBlobRow,
    );
  };

  const listContactSourceBlobHashes = (source_id: string): Map<string, string> => {
    const out = new Map<string, string>();
    if (!source_id) return out;
    const rows = sourceBlobHashesStmt.all(source_id) as {
      remote_id: string;
      snapshot_hash: string;
    }[];
    for (const r of rows) {
      // A row without a stored hash must be OMITTED, never mapped to '' — the
      // SourceMirrorStore contract. An empty-string entry would compare equal to
      // a freshly-computed '' and the record would be wrongly skipped as
      // unchanged. Omitted rows simply re-sync.
      if (!r.snapshot_hash) continue;
      out.set(r.remote_id, r.snapshot_hash);
    }
    return out;
  };

  const listContactSourceBlobs = (
    contact_id: string,
  ): readonly ContactSourceBlobRecord[] => {
    if (!contact_id) return [];
    const rows = sourceBlobListByContactStmt.all(contact_id) as ContactSourceBlobRow[];
    return rows.map(rowToSourceBlob);
  };

  const getContactSourceBlob = (
    source_id: string,
    remote_id: string,
  ): ContactSourceBlobRecord | null => {
    if (!source_id || !remote_id) return null;
    const row = sourceBlobGetRemoteStmt.get(source_id, remote_id) as
      | ContactSourceBlobRow
      | undefined;
    return row === undefined ? null : rowToSourceBlob(row);
  };

  const deleteContactSourceBlobsForSource = (source_id: string): number =>
    source_id ? sourceBlobDeleteSourceStmt.run(source_id).changes : 0;

  /** D-205 §1 — SOFT-MARK one mirrored record as gone from the vendor.
   *
   *  The replacement for the per-record hard delete, which was a core-plane data
   *  destruction dressed as a mirror update. Idempotent (`disconnected_at IS
   *  NULL` in the WHERE), so a re-mark returns false rather than moving the
   *  timestamp — the mark records when the record FIRST vanished. */
  const markContactSourceBlobDisconnected = (
    source_id: string,
    remote_id: string,
    now = Date.now(),
  ): boolean =>
    source_id && remote_id
      ? sourceBlobDisconnectStmt.run(now, source_id, remote_id).changes > 0
      : false;

  // ── D-192 C-2 — the PROJECTION (materializer) ────────────────────
  //
  // The `data.contact` row stops being STORAGE and becomes a PROJECTION over the
  // contributions: each field independently takes its strongest assertion via
  // the one C-2a ladder. A contact can therefore carry a hand-typed `org` AND a
  // CRM-sourced `title` at the same time, each with its own provenance — which a
  // single-valued column can never do, because the second writer destroys the
  // first.
  //
  // ⚠ SEMANTICS: this writes the projection of the contributions, FULL STOP. A
  // field with no contributions projects to NULL. That is correct once every
  // existing column value has a contribution behind it — which is exactly what
  // slice 3's backfill establishes. So this function is deliberately NOT wired
  // to run automatically yet: calling it today, before the backfill, would wipe
  // legacy column values that no contribution has claimed. Slice 3 backfills,
  // THEN wires it. (Same "declare pure, wire next slice" discipline the file
  // family used for `FileVendorDeclaration`.)

  const materializeStmt = db.prepare(
    `UPDATE ${CONTACT_TABLE}
       SET name                  = @name,
           company               = @company,
           company_source        = @company_source,
           phone                 = @phone,
           mailing_address       = @mailing_address,
           title                 = @title,
           photo                 = @photo,
           birthday              = @birthday,
           projection_provenance = @projection_provenance,
           name_key              = @name_key,
           address_zip_country_key = @address_zip_country_key,
           company_norm          = @company_norm,
           updated_at            = @updated_at
       WHERE contact_id = @contact_id`,
  );

  /** Map a winning `org` contribution's rung down to the narrow legacy
   *  `ContactCompanySource` enum. A rung it cannot express (`contact_book` /
   *  `derived` / `user_confirmed`) yields `null` — and that is the RIGHT answer
   *  for this column's one consumer, the D-138 domain-inference seed pool
   *  (`WHERE company_source IN ('vendor_meta','manual')`): a company nobody
   *  authoritative asserted must not seed inference about other people.
   *
   *  Note this is the first time `'vendor_meta'` can ever be written. The CRM
   *  path that was supposed to write it never existed (no reconciler touches
   *  this store), so the value has been a dead enum member since D-138. */
  const companySourceFromRung = (
    source: ContactContributionSource,
  ): ContactCompanySource | null => {
    if (source === 'manual') return 'manual';
    if (source === 'vendor_meta') return 'vendor_meta';
    if (source === 'domain_inferred') return 'domain_inferred';
    return null;
  };

  /** Fold the identifier-axis rows (`phone_alias`) into the same contribution
   *  shape the attribute rows already have, so ONE resolver settles both axes.
   *
   *  Only `phone` projects onto a column. `email_alias` deliberately does NOT
   *  project here: `contacts.email` is the PRIMARY KEY and the public address,
   *  so changing which email is primary is an IDENTITY operation that must
   *  cascade to the six email-keyed tables — that is slice 4's job, not a side
   *  effect of materializing a title. `chat_alias` / `platform_id` have no
   *  column at all. */
  const phoneContributionsFor = (contact_id: string): ProjectionContribution[] =>
    (aliasListByContactKindStmt.all(contact_id, 'phone_alias') as ContactAliasRow[]).map(
      (row) => ({
        kind: 'phone',
        // The original pattern, not the normalized one — `contacts.phone` holds
        // the E.164 form the caller supplied, and `contact_phone_forms` derives
        // its match forms from THAT column via a trigger.
        value: row.alias_pattern,
        source: row.source as ContactContributionSource,
        confidence: row.confidence,
        // Aliases carry no event time; their ingestion time is the best proxy.
        as_of: row.created_at,
        // The REAL instance, or none. Never fabricated — a phone imported from
        // Google must not be reported as hand-typed.
        source_id: row.source_id ?? undefined,
      }),
    );

  // ── D-192 C-2 slice 4 — the MERGE GROUP ────────────────────────────────────
  //
  // A merge does not MOVE anything. It records an edge (`merged_into`) and leaves
  // every contribution exactly where it was written; the survivor's projection
  // simply reads ACROSS the group — itself, plus every contact ever absorbed into
  // it, transitively.
  //
  // ⚠ Why not just move the loser's contributions onto the survivor? Because the
  // contribution key is `(contact_id, kind, source_id)`, and moving them COLLIDES —
  // on the exact case D-138's merge detector exists to produce. Google exports
  // "Bob Smith" and "Robert Smith" as two records; both sync in as two contacts;
  // both carry a `google.personal.contact` name contribution; the detector flags
  // them; the user merges. Moving lands both on
  // `(survivor, 'name', 'google.personal.contact')` — one SILENTLY OVERWRITES the
  // other, and the split can never give it back. That is the same peer-clobber the
  // `source_id` key was introduced to prevent, arriving through a different door.
  //
  // Reading across the group instead: nothing collides, nothing is destroyed, the
  // split is trivially reversible (clear the edge, re-project both), and merging two
  // contacts finally does what the contribution model promises — it UNIONS their
  // assertions and lets the ladder settle the conflict, instead of `setMergedInto`
  // blanking the loser's fields as it did before C-2.
  const hasAbsorbeeStmt = db.prepare(
    `SELECT 1 FROM ${CONTACT_TABLE} WHERE merged_into = ? LIMIT 1`,
  );
  const absorbedContactIdsStmt = db.prepare(
    `WITH RECURSIVE absorbed(email) AS (
       SELECT email FROM ${CONTACT_TABLE} WHERE merged_into = ?
       UNION
       SELECT c.email FROM ${CONTACT_TABLE} c
         JOIN absorbed a ON c.merged_into = a.email
     )
     SELECT c.contact_id FROM ${CONTACT_TABLE} c
       JOIN absorbed a ON c.email = a.email
      ORDER BY c.contact_id ASC`,
  );

  /** The survivor's contact_id FIRST, then every contact absorbed into it, in a
   *  STABLE order.
   *
   *  Order is load-bearing, on both counts. `resolveContribution` keeps the
   *  FIRST-seen winner on a dead tie (same rung, same `as_of`, same confidence), so
   *  putting the survivor first makes "the survivor's own assertion wins a tie" the
   *  rule — deterministic, and the intuitive one. And the absorbed members are sorted
   *  (`ORDER BY contact_id`) because a recursive CTE has NO defined row order: without
   *  it, a three-way merge whose losers tie on a field would project one value today
   *  and the other tomorrow, from identical data. A projection that FLICKERS is worse
   *  than one that is wrong, because it is not reproducible.
   *
   *  The `hasAbsorbee` probe is the fast path: it is one hit on `idx_contacts_merged_into`,
   *  and it is false for essentially every contact in a real warehouse, so the
   *  recursive CTE only ever runs for the merged minority. This function is on the
   *  materialize path, which is on the `observe` path, which is the mail-sync hot loop. */
  const mergeGroupFor = (contact_id: string, email: string): string[] => {
    if (hasAbsorbeeStmt.get(email) === undefined) return [contact_id];
    const absorbed = absorbedContactIdsStmt.all(email) as { contact_id: string }[];
    return [contact_id, ...absorbed.map((r) => r.contact_id)];
  };

  const attributeContributionsFor = (contact_id: string): ProjectionContribution[] =>
    (attributeListByContactStmt.all(contact_id) as ContactAttributeRow[]).map((row) => ({
      kind: row.kind,
      value: JSON.parse(row.value) as unknown,
      source: row.source as ContactContributionSource,
      confidence: row.confidence,
      as_of: row.as_of,
      source_id: row.source_id,
    }));

  /** Every contribution the projection resolves over for this contact — the merge
   *  GROUP × BOTH contribution stores, exactly as `materializeContactProjection`
   *  gathers them. The materializer calls it too, so there is ONE definition of
   *  *what contributes to this contact* and a read surface can never disagree with
   *  the projection about the row set.
   *
   *  🔑 **Two traps a hand-rolled gather walks straight into, and each makes the
   *  answer a LIE rather than merely incomplete:**
   *
   *   1. **`listContactAttributes(contact_id)` reads ONE contact.** A merge MOVES
   *      NOTHING (D-205 §1) — the loser's contributions stay on the LOSER's
   *      `contact_id`, and the survivor reads them through the merge GROUP. So a
   *      per-contact read of a merged survivor omits the absorbed rows — and an
   *      absorbed row can be the one that WON. A "why does this field hold this
   *      value" view whose row set does not contain the winner is worse than no view.
   *   2. **`contact_attribute` is not the whole contribution axis.** `phone` is an
   *      IDENTIFIER: it lives in `contact_alias` as `phone_alias` and is gathered by
   *      `phoneContributionsFor`. An attribute-only read shows NO phone rows at all —
   *      for a field the detail page renders.
   *
   *  ⚠ A TOMBSTONE resolves to its survivor's group, for the same reason the
   *  projection does: a tombstone's contributions are not inert, they feed the
   *  SURVIVOR's projection. Terminates by construction — `resolvedLiveContact`
   *  returns a row that is live by definition. */
  const listProjectionContributions = (contact_id: string): ProjectionContribution[] => {
    const existing = getByContactIdStmt.get(contact_id) as ContactRow | undefined;
    if (!existing) return [];
    if (existing.merged_into) {
      const survivor = resolvedLiveContact(existing.merged_into);
      return survivor && survivor.contact_id !== contact_id
        ? listProjectionContributions(survivor.contact_id)
        : [];
    }
    const contributions: ProjectionContribution[] = [];
    for (const member of mergeGroupFor(contact_id, existing.email)) {
      contributions.push(...attributeContributionsFor(member));
      contributions.push(...phoneContributionsFor(member));
    }
    return contributions;
  };

  const materializeContactProjection = (
    contact_id: string,
    nowOpt?: number,
  ): ContactRecord | null => {
    const existing = getByContactIdStmt.get(contact_id) as ContactRow | undefined;
    if (!existing) return null;

    // A TOMBSTONE is not a projection target — its columns were deliberately blanked
    // by `setMergedInto` so it stops matching the D-138 candidate scan, and
    // projecting it would resurrect them.
    //
    // ⚠ But it must NOT be a silent no-op either, and that was a real bug. A
    // tombstone's contributions are not inert: slice 4 has the SURVIVOR read them,
    // through the merge group. So "materialize this contact" performed on a tombstone
    // was a lie — it wrote nothing, anywhere, while the contribution the caller had
    // just added sat in the survivor's group unprojected. A `contact.upsert` on a
    // merged-away address therefore VANISHED, and then TELEPORTED onto the survivor
    // at some arbitrary later moment, the next time anything else happened to
    // re-project it. A write that silently defers is worse than one that fails.
    //
    // The honest contract: the projection a tombstone's contributions feed is the
    // SURVIVOR's, so materializing a tombstone materializes the survivor. Terminates
    // by construction — `resolvedLiveContact` returns a row that is live by
    // definition, so the recursive call always lands on the branch below.
    if (existing.merged_into) {
      const survivor = resolvedLiveContact(existing.merged_into);
      if (survivor && survivor.contact_id !== contact_id) {
        materializeContactProjection(survivor.contact_id, nowOpt);
      }
      return rowToRecord(existing);
    }

    // The SAME gather the per-source read surface uses — one definition, so the view
    // can never show a row set the projection did not actually resolve over.
    const contributions = listProjectionContributions(contact_id);

    const winners = resolveContributionsByKind(contributions);

    // Read a winner as a plain string, or null. A structured value where a
    // scalar belongs (or vice-versa) is dropped rather than stringified into
    // "[object Object]" — a garbage column value is worse than an absent one,
    // because it looks like data.
    const str = (kind: string): string | null => {
      const w = winners.get(kind);
      if (w === undefined) return null;
      return typeof w.value === 'string' && w.value.length > 0 ? w.value : null;
    };
    const obj = <T>(kind: string): T | null => {
      const w = winners.get(kind);
      if (w === undefined) return null;
      return w.value !== null && typeof w.value === 'object' ? (w.value as T) : null;
    };

    const name = str('name');
    const company = str('org');
    const phone = str('phone');
    const address = obj<MailingAddress>('address');

    const orgWinner = winners.get('org');
    const company_source =
      orgWinner === undefined || company === null
        ? null
        : companySourceFromRung(orgWinner.source as ContactContributionSource);

    // Provenance for every field that actually projected a value. A field whose
    // winner was dropped by the shape guards above must NOT claim provenance —
    // it would advertise a source for a value the row does not hold.
    const provenance: Record<string, ContactFieldProvenance> = {};
    const projected: Record<string, unknown> = {
      name,
      org: company,
      phone,
      address,
      title: str('title'),
      photo: str('photo'),
      birthday: str('birthday'),
    };
    for (const [kind, winner] of winners) {
      if (projected[kind] === null || projected[kind] === undefined) continue;
      const entry: ContactFieldProvenance = {
        source: winner.source as ContactContributionSource,
      };
      // Omitted when the writer recorded no instance — "we don't know who" is
      // the truth, and provenance that LIES is worse than provenance that is
      // absent, because a surface renders it as fact.
      if (winner.source_id !== undefined) entry.source_id = winner.source_id;
      // The two tiebreakers BELOW the rung in `resolveContribution` (rung →
      // `as_of` → `confidence`). Carried so a surface that must PREDICT the
      // projection — the merge-review highlight, which tells the user what the
      // merged record will hold — can rank with the REAL ladder instead of
      // inventing a local one. The rung alone is not enough: a rung TIE is the
      // commonest case there is (two mail-derived duplicates are both `derived`),
      // and without these the commonest merge of all would be undecidable.
      //
      // Both are the winner's OWN values, never synthesized — a phone alias's
      // `as_of` is already its honest ingestion-time proxy (`phoneContributionsFor`).
      entry.as_of = winner.as_of;
      entry.confidence = winner.confidence;
      provenance[kind] = entry;
    }

    materializeStmt.run({
      contact_id,
      name,
      company,
      company_source,
      phone,
      mailing_address: address === null ? null : JSON.stringify(address),
      title: projected.title as string | null,
      photo: projected.photo as string | null,
      birthday: projected.birthday as string | null,
      projection_provenance:
        Object.keys(provenance).length > 0 ? JSON.stringify(provenance) : null,
      // ⚠ The D-138 BLOCKING KEYS must be recomputed from the PROJECTED values,
      // not left stale. `contact_merge_candidate_scan` only evaluates its
      // predicate against pairs sharing a blocking key — so a stale key does not
      // produce a wrong match, it produces NO match: the merge detector silently
      // stops seeing a duplicate it should have caught. A quiet false-negative in
      // dedup is the worst failure mode here, because nothing surfaces it.
      name_key: deriveNameKey(name),
      address_zip_country_key: deriveAddressZipCountryKey(address),
      company_norm: deriveCompanyNorm(company),
      updated_at: nowOpt ?? nowFn(),
    });

    const refreshed = getByContactIdStmt.get(contact_id) as ContactRow | undefined;
    return refreshed ? rowToRecord(refreshed) : null;
  };

  // ── resolveContactReference closures ─────────────────────────────

  const resolverLookups: ContactReferenceLookups = {
    chat_aliases_by_normalized: (n) => {
      const rows = aliasListChatNormalizedStmt.all(n) as ContactAliasRow[];
      return rows.map(rowToAlias);
    },
    platform_alias_by_key: (platform, n) => {
      if (!isContactAliasPlatform(platform)) return null;
      const row = aliasLookupPlatformGlobalStmt.get(platform, n) as
        | ContactAliasRow
        | undefined;
      return row ? rowToAlias(row) : null;
    },
    network_domains_for: (contact_id) => {
      const row = getByContactIdStmt.get(contact_id) as ContactRow | undefined;
      if (!row) return [];
      const parsed = safeParseJsonArray<NetworkDomain>(row.network_domain);
      return parsed;
    },
  };

  const resolveContactReference = (
    reference: ContactReference,
    context: ContactReferenceContext,
  ): ContactReferenceResolution => {
    const result = resolveContactReferenceImpl(reference, context, resolverLookups);
    // Bump `last_resolved_at` on the matched alias row(s) so Settings
    // UX can show "Recued resolved Mom 12 minutes ago" without a
    // separate audit-walk. Best-effort; ignore lookup misses.
    if (result.contact_id !== null) {
      const now = nowFn();
      try {
        if (typeof reference === 'string') {
          const normalized = normalizeAliasPattern(reference);
          if (normalized.length) {
            const matched = aliasListChatNormalizedStmt.all(normalized) as ContactAliasRow[];
            for (const m of matched) {
              if (m.contact_id === result.contact_id) {
                aliasUpdateLastResolvedStmt.run(now, m.id);
              }
            }
          }
        } else if (reference !== null && typeof reference === 'object') {
          const normalized = normalizeAliasPattern(reference.id);
          if (normalized.length) {
            const matched = aliasLookupPlatformGlobalStmt.get(
              reference.platform,
              normalized,
            ) as ContactAliasRow | undefined;
            if (matched && matched.contact_id === result.contact_id) {
              aliasUpdateLastResolvedStmt.run(now, matched.id);
            }
          }
        }
      } catch { /* best-effort bookkeeping */ }
    }
    return result;
  };

  // ── D-145 PA8 follow-on — identifier-keyed lookup helpers ─────────
  //
  // Phone uses the existing `idx_contacts_phone` regular index +
  // excludes tombstones; when multiple non-tombstoned contacts share
  // the phone we surface alternatives so callers don't silently bind
  // to a guessed row (Codex P1 fold). Alias dispatches through
  // `resolveContactReference` so the chat_alias / platform_id
  // disambiguation rules + `last_resolved_at` bookkeeping stay
  // consolidated in one place. Hydrated rows are forwarded through the
  // `merged_into` chain so alias entries that survived past a D-138
  // merge resolve to the canonical survivor (Codex P1 fold). Empty /
  // unknown identifiers return an empty result without throwing —
  // both helpers are read-side resolvers, never write.
  //
  // LIMIT 5 on the phone lookup is generous enough to surface every
  // transitional collision in practice while still being a strict
  // upper bound the caller can rely on; the merge candidate queue
  // resolves the long tail.
  const findByPhoneListStmt = db.prepare(
    `SELECT * FROM ${CONTACT_TABLE}
       WHERE phone = ? AND merged_into IS NULL
       ORDER BY last_interaction DESC, email ASC
       LIMIT 5`,
  );

  /** Forward a hydrated row through its `merged_into` redirect chain.
   *  Returns the canonical survivor (or `null` when the chain is
   *  corrupted — e.g. survivor was deleted). The redirect target lives
   *  in `merged_into` even on tombstones whose other identity columns
   *  were cleared per spec § A.8, so the walk is safe regardless of
   *  the tombstone's `email` column state. */
  const followMergeChain = (record: ContactRecord | null): ContactRecord | null => {
    if (!record) return null;
    if (!record.merged_into) return record;
    try {
      const { canonical_email } = resolveCanonicalEmail(record.merged_into);
      const next = get(canonical_email);
      // Survivor itself merged forward → recurse. The
      // resolveCanonicalEmail call already walks the chain, so this
      // recursion is a no-op in practice; kept as a belt-and-braces
      // safety net if the survivor row carries its own non-empty
      // merged_into pointer.
      if (next && next.merged_into && next.email !== record.email) {
        return followMergeChain(next);
      }
      return next;
    } catch {
      return null;
    }
  };

  // D-192 P5 — the contact_id → survivor forward-resolver (interface
  // doc above). Composition of the two existing primitives so the
  // redirect semantics can never drift from the email-keyed resolve.
  const getByContactIdResolved = (contact_id: string): ContactRecord | null =>
    followMergeChain(getByContactId(contact_id));

  const findByPhone = (phone: string): ContactPhoneLookupResult => {
    if (typeof phone !== 'string' || !phone.length) {
      return { contact: null, confidence: 0, alternatives: [] };
    }
    const rows = findByPhoneListStmt.all(phone) as ContactRow[];
    if (rows.length === 0) return { contact: null, confidence: 0, alternatives: [] };
    if (rows.length === 1) {
      const row = rows[0]!;
      return { contact: rowToRecord(row), confidence: 1.0, alternatives: [] };
    }
    return {
      contact: null,
      confidence: 0,
      alternatives: rows.map(rowToRecord),
    };
  };

  const aliasLookupResult = (
    resolution: ContactReferenceResolution,
  ): ContactAliasLookupResult => {
    if (resolution.contact_id !== null) {
      const row = getByContactIdStmt.get(resolution.contact_id) as ContactRow | undefined;
      const initial = row ? rowToRecord(row) : null;
      const survivor = followMergeChain(initial);
      return {
        contact: survivor,
        confidence: survivor ? resolution.confidence : 0,
        alternatives: [],
      };
    }
    if (resolution.alternatives.length === 0) {
      return { contact: null, confidence: 0, alternatives: [] };
    }
    const alternatives: ContactRecord[] = [];
    const seenIds = new Set<string>();
    for (const id of resolution.alternatives) {
      const row = getByContactIdStmt.get(id) as ContactRow | undefined;
      const initial = row ? rowToRecord(row) : null;
      const survivor = followMergeChain(initial);
      if (!survivor) continue;
      // Two alias rows resolving to the same canonical survivor after
      // the redirect walk collapse to one alternative entry; without
      // this dedup the caller would see the same survivor twice.
      const key = survivor.contact_id ?? survivor.email;
      if (key && seenIds.has(key)) continue;
      if (key) seenIds.add(key);
      alternatives.push(survivor);
    }
    return { contact: null, confidence: 0, alternatives };
  };

  const resolveAliasLookup = (
    input: ContactAliasLookupInput,
    touchLastResolved: boolean,
  ): ContactAliasLookupResult => {
    if (!input || typeof input.alias_pattern !== 'string' || !input.alias_pattern.length) {
      return { contact: null, confidence: 0, alternatives: [] };
    }
    const context: ContactReferenceContext = input.context ?? { recent_contacts: [] };
    const reference: ContactReference =
      input.platform !== undefined
        ? { platform: input.platform, id: input.alias_pattern }
        : input.alias_pattern;
    const resolution = touchLastResolved
      ? resolveContactReference(reference, context)
      : resolveContactReferenceImpl(reference, context, resolverLookups);
    return aliasLookupResult(resolution);
  };

  const findByAlias = (input: ContactAliasLookupInput): ContactAliasLookupResult =>
    resolveAliasLookup(input, true);

  const peekByAlias = (input: ContactAliasLookupInput): ContactAliasLookupResult =>
    resolveAliasLookup(input, false);

  // ── D-192 C-2b — the CUTOVER backfill ─────────────────────────────────────
  //
  // The gate slice 2 left standing. `materializeContactProjection` writes the
  // projection of the contributions FULL STOP — a field with no contribution
  // projects to NULL — so wiring it before every legacy column value had a
  // contribution behind it would have WIPED the warehouse. This is the pass that
  // makes it safe, and the write paths above are wired only because it runs.
  //
  // Provenance-PRESERVING, per C-2b-as-corrected. Each column maps to its TRUE
  // rung via the shared `*ToContributionRung` mappings, never to a flat `legacy`
  // rung parked at the bottom — that would have let the first CRM import silently
  // overwrite the user's own hand-typed edits, which is the precise data loss the
  // projection exists to prevent.
  //
  // Exactly-once per row, and the guard is a real invariant rather than a marker
  // bolted on for it: `projection_provenance IS NULL` means "this row has never
  // been projected". Nothing wrote that column before this slice, every write path
  // writes it now, and a row is skipped the moment it has been through here — so
  // the pass cannot re-derive a contribution that a later Source teardown
  // deliberately removed (which would resurrect a torn-down account's data under a
  // fabricated `manual` provenance).
  //
  // Tombstones are excluded on the same principle: a `merged_into` row is a
  // redirect, its columns were deliberately blanked, and it is not a projection
  // target (see the guard in `materializeContactProjection`). Slice 4 redistributes
  // its contributions to the survivor.
  //
  // Zero-migration, per the store's own standing discipline: this is not a
  // versioned migration hung off a runner (there is none, and no `PRAGMA
  // user_version` anywhere in the server) — it is an idempotent convergence pass,
  // exactly like the FTS and phone-form index backfills above it. On a fresh
  // database it does nothing at all: there are no contacts to converge.
  // BATCHED, not one pass over the whole table. A warehouse with 50k mail-derived
  // contacts would otherwise materialize 50k `ContactRow`s into memory at once and
  // wrap ~half a million statements in a single transaction, at boot, before the
  // server can serve anything. Chunking bounds both, and — because the guard is a
  // per-ROW marker rather than a global "did the migration run" flag — it also
  // makes the pass RESUMABLE: a crash half-way leaves the finished rows finished,
  // and the next boot picks up exactly the ones that are left.
  /** 🔑 **D-205 #5 — the IMPORT exclusion is not an optimisation. It closes a
   *  provenance LIE.**
   *
   *  This pass converges rows that PREDATE the contribution substrate, and it
   *  identifies them by `projection_provenance IS NULL`. A freshly-minted IMPORTED
   *  row has null provenance too — for the few milliseconds between
   *  `createImportedContact` (which writes the identity and DELIBERATELY no
   *  contributions) and its write pass landing them. Boot inside that window, or
   *  create an identity the write pass never reaches, and the backfill grabs the row
   *  and writes its `name` at `derived` / `recued.derived`: **Recued claiming it
   *  pulled out of a mail header a name that HubSpot asserted.**
   *
   *  An import NEVER predates contributions — it is post-C-2 by construction, and the
   *  Source that created it owns every value on it. So it is not a backfill
   *  candidate, at any moment, and the guard says so rather than relying on a race it
   *  usually wins. [[feedback_provenance_that_lies_is_worse_than_absent]] */
  const backfillPendingStmt = db.prepare(
    `SELECT * FROM ${CONTACT_TABLE}
       WHERE projection_provenance IS NULL
         AND merged_into IS NULL
         AND source NOT IN (${CONTACT_IMPORT_ROW_SOURCES.map(() => '?').join(', ')})
       LIMIT ?`,
  );

  const cutoverBatch = db.transaction((rows: readonly ContactRow[], now: number) => {
      for (const row of rows) {
        const contact_id = row.contact_id;
        // `as_of` — when the SOURCE asserted this. For a legacy column we do not
        // know, and cannot: the substrate never recorded it. `updated_at` is the
        // last moment the row's columns were written, which is the tightest
        // honest upper bound available. It only ever decides a SAME-RUNG tie,
        // and the ladder settles everything else.
        const as_of = row.updated_at;

        // name → `manual` only if the user really typed it. A row whose name is
        // exactly `fallbackDisplayName(email)` was never named by anyone —
        // Recued derived it from the local-part — and calling that `manual` would
        // park a placeholder at the TOP of the ladder, where the real name from
        // the first address-book import could never beat it. Same reasoning as
        // the live `upsertManual` path, which is why both ask the same question.
        if (row.name) {
          const rung: ContactContributionSource =
            contactSourceToContributionRung(row.source) === 'manual' &&
            row.name !== fallbackDisplayName(row.email)
              ? 'manual'
              : 'derived';
          upsertContactAttribute(
            {
              contact_id,
              kind: 'name',
              value: row.name,
              source: rung,
              source_id: contributionSourceIdForRung(rung),
              as_of,
              created_at: row.created_at,
            },
            now,
          );
        }

        // org → the rung `company_source` already recorded. A company with NO
        // recorded source maps to `derived`, NOT `manual` (see
        // `companySourceToContributionRung`): we do not know who asserted it, and
        // it round-trips back to a NULL `company_source`, keeping it correctly out
        // of the D-138 domain-inference seed pool.
        if (row.company) {
          const rung = companySourceToContributionRung(row.company_source);
          upsertContactAttribute(
            {
              contact_id,
              kind: 'org',
              value: row.company,
              source: rung,
              source_id: contributionSourceIdForRung(rung),
              as_of,
              created_at: row.created_at,
            },
            now,
          );
        }

        // address → `manual`. Its only writer, ever, is `upsertManual`: no CRM
        // reconciler has ever touched this store (the whole contact side of the
        // CRM path is dead — slice 7 is what finally builds it), so a mailing
        // address in this warehouse was typed by the user or it does not exist.
        const address = safeParseJsonObject<MailingAddress>(row.mailing_address);
        if (address) {
          upsertContactAttribute(
            {
              contact_id,
              kind: 'address',
              value: address,
              source: 'manual',
              source_id: CONTACT_SOURCE_ID_MANUAL,
              as_of,
              created_at: row.created_at,
            },
            now,
          );
        }

        // phone → `phone_alias`, `manual`. Same argument as address.
        if (row.phone) {
          upsertContactAlias(
            {
              contact_id,
              kind: 'phone_alias',
              alias_pattern: row.phone,
              source: 'manual',
              source_id: CONTACT_SOURCE_ID_MANUAL,
              created_at: row.created_at,
            },
            now,
          );
        }

        // email → `email_alias`, at the rung the ROW's own `source` earns
        // (`manual` if the user added the contact; `derived` for the three
        // adapter sources). This is where "email demotes from PK to an alias"
        // actually lands on disk. Slice 4 reads it.
        //
        // Skipped for a mention_only placeholder: `mention-only-…@_recued.invalid`
        // is not an address, it is a PK filler, and seeding the globally-unique
        // email index with it would give the slice-4 resolver an address that by
        // construction nobody can reach. The real one is contributed at promotion.
        if (!isMentionOnlyEmail(row.email)) {
          const rung = contactSourceToContributionRung(row.source);
          upsertContactAlias(
            {
              contact_id,
              kind: 'email_alias',
              alias_pattern: row.email,
              source: rung,
              source_id: contributionSourceIdForRung(rung),
              created_at: row.created_at,
            },
            now,
          );
        }

        // Project. Rewrites the same values back into the columns (they are what
        // we just derived the contributions FROM), and stamps
        // `projection_provenance` — which is both the new per-field provenance
        // surface and this pass's own done-marker. It is what retires the row from
        // `backfillPendingStmt`, so it is also what terminates the loop below.
        materializeContactProjection(contact_id, now);
      }
  });

  const backfillPendingCountStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${CONTACT_TABLE}
       WHERE projection_provenance IS NULL
         AND merged_into IS NULL`,
  );

  const runContributionCutover = (): number => {
    const pending = (backfillPendingCountStmt.get() as { n: number }).n;
    if (pending === 0) return 0; // the fresh-database path — no work, no cost

    // BOUNDED BY CONSTRUCTION, not by "did this batch shrink". A row that projects
    // an EMPTY provenance map (no name, no org, no phone, no address — reachable
    // only by a raw-SQL insert that bypassed every write path) stores NULL
    // provenance, so it never retires from the pending query and a drain-until-empty
    // loop would spin on it FOREVER, at boot, wedging the server. Every row gets its
    // one attempt; a row that cannot be converted is left alone rather than
    // relitigated. An infinite boot loop is a very bad way to discover an
    // unconvertible row.
    const maxBatches = Math.ceil(pending / CONTACT_MATERIALIZE_BATCH_SIZE) + 1;
    let converted = 0;
    for (let i = 0; i < maxBatches; i++) {
      const batch = backfillPendingStmt.all(
        ...CONTACT_IMPORT_ROW_SOURCES,
        CONTACT_MATERIALIZE_BATCH_SIZE,
      ) as ContactRow[];
      if (batch.length === 0) break;
      cutoverBatch(batch, nowFn());
      converted += batch.length;
    }
    return converted;
  };

  runContributionCutover();

  return {
    observe,
    observeBatch,
    upsertManual,
    get,
    list,
    listForPrefetchScan,
    prefetchCandidates,
    countPhoneForm,
    listAllNamesAndCompanies,
    listRecallAddressSeeds,
    resolveRecallIdentifiers,
    walkByEmail,
    delete: del,
    count,
    resolveCanonicalEmail,
    listMergedSourceEmails,
    addressSet,
    linkPlatformId,
    unlinkPlatformId,
    retractPlatformLinksForConnection,
    countPlatformLinksForConnection,
    lookupPlatformLink,
    addRejection,
    removeRejection,
    isPairRejected,
    rejectedPairKeys,
    enqueueMergeCandidate,
    listMergeCandidates,
    getMergeCandidate,
    setMergeCandidateStatus,
    resolveCompanyForDomain,
    setMergedInto,
    // D-145 PA8
    getByContactId,
    // D-192 P5
    getByContactIdResolved,
    createMentionOnlyContact,
    createImportedContact,
    promoteMentionOnlyToVerified,
    setNetworkDomain,
    // D-145 PB11
    getPersonalRecipes,
    addPersonalRecipe,
    setPersonalRecipeEnabled,
    removePersonalRecipe,
    setPersonalRecipes,
    upsertContactAlias,
    deleteContactAlias,
    deleteContactAliasesForSource,
    listContactAliases,
    // D-192 C-2 — the contribution substrate.
    upsertContactAttribute,
    listContactAttributes,
    listProjectionContributions,
    deleteContactAttribute,
    deleteContactAttributesForSource,
    upsertContactSourceBlob,
    listContactSourceBlobHashes,
    listContactSourceBlobs,
    getContactSourceBlob,
    deleteContactSourceBlobsForSource,
    markContactSourceBlobDisconnected,
    materializeContactProjection,
    resolveContactReference,
    // D-145 PA8 follow-on — identifier-keyed lookup helpers
    findByPhone,
    findByAlias,
    peekByAlias,
  };
};

/** D-138 P1 — evaluate the merge predicate against the existing graph
 *  for one upsert event, fire-and-forget enqueue any candidates the
 *  predicate surfaces. Pure orchestration; the storage layer holds the
 *  primitives. Caller controls cursor walking + ULID generation so
 *  this helper stays decoupled from runtime nondeterminism (tests
 *  inject their own clock + id allocator).
 *
 *  Bounded by `scanLimit` — inline detection scans the full graph by
 *  default (small graphs in v1) but caller can clamp for safety. */
export const detectInlineMergeCandidates = (
  store: ContactStore,
  changed: ContactRecord,
  opts: {
    nowFn: () => number;
    idFactory: () => string;
    detected_by?: ContactMergeCandidate['detected_by'];
    scanLimit?: number;
  },
): ContactMergeCandidate[] => {
  if (changed.merged_into) return []; // tombstone — never a side of a candidate
  // D-145 PA8 § A.4.1 — mention_only contacts are EXCLUDED from D-138
  // cross-platform reconciliation until promoted. The synthetic
  // placeholder email would never match a real platform contact's
  // email anyway, but the predicate-only paths (name / company /
  // phone) could spuriously surface candidates on reused names.
  // Skip the scan entirely until promotion writes a real email.
  if (changed.identity_status === 'mention_only') return [];
  const detected: ContactMergeCandidate[] = [];
  const seen = store.list({ limit: opts.scanLimit ?? 1_000 });
  const rejected = store.rejectedPairKeys();
  for (const other of seen) {
    if (other.email === changed.email) continue;
    if (other.merged_into) continue;
    if (other.identity_status === 'mention_only') continue;
    const pairKey = canonicalPairKey(changed.email, other.email);
    if (rejected.has(pairKey)) continue;
    const result = evaluateContactMatch(changed, other);
    if (!result.matches) continue;
    try {
      const cand = store.enqueueMergeCandidate({
        id: opts.idFactory(),
        email_a: changed.email,
        email_b: other.email,
        matched_fields: result.matched_fields,
        detected_at: opts.nowFn(),
        detected_by: opts.detected_by ?? 'inline',
      });
      detected.push(cand);
    } catch { /* dedup conflict / unique violation: skip */ }
  }
  return detected;
};
