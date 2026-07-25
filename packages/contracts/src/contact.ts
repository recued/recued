/** D-121 Phase 1 — `data.contact` warehouse collection.
 *
 *  Seventh canonical collection (after mail / calendar / file / webhook
 *  / service / shared / annotation+link). Derived (not externally
 *  adapted): every record materializes from `data.mail` (From / To /
 *  CC headers) + `data.calendar` (organizer + attendees) + the manual
 *  `contact.upsert` rpc.
 *
 *  `email` is the canonical key — every adapter-side write canonicalizes
 *  through `canonicalizeEmail` so `Bob Smith <bob@x.com>`,
 *  `<BOB@X.COM>`, and `bob@x.com (Bob)` all collapse onto one row.
 *  `first_seen` / `name` follow first-seen-wins discipline; manual
 *  `contact.upsert` is the one writer that may override `name` after
 *  the row exists.
 *
 *  `_id` (per D-119 Phase 12 CanonicalRecord) for a contact is the
 *  canonical email string — recipes ref `data.contact.<email>` and the
 *  D-119 Phase 13 annotations / links graph hangs off the same key. */

import type { Actor } from './commits.js';
import type { ContactProjectionProvenance } from './contact-contribution.js';
import type { CanonicalRecord } from './canonical-record.js';
import type { ContactIdentityStatus, NetworkDomain } from './contact-identity.js';
import type { OriginSurface } from './origin-provenance.js';
import type { PersonalRecipeEntry } from './personal-recipes.js';

/** Canonical contact record. Adapters preserve the system pair via
 *  `stampCanonicalFields` at the dispatch boundary so transforms see
 *  the `_id` / `_collection` keys consistently with the other warehouse
 *  collections. */
export interface ContactRecord extends CanonicalRecord {
  /** Canonical key — lowercased, trimmed, comments stripped. */
  email: string;
  /** Display name. From the email From-header parse or vCard; falls
   *  back to email local-part on first sight. Manual `contact.upsert`
   *  may replace this after the first adapter write. */
  name?: string;
  /** D-161 P1 — origin provenance facet: the actor of the execution
   *  that wrote this contact row. Contacts are overwhelmingly derived
   *  from mail / calendar sync (`'system'`), which the store stamps by
   *  column default. The rare `'user_self'` / `'contracted_user'` manual
   *  `contact.upsert` write-actor threading is a P1 follow-on (lands with
   *  P2's producer provenance-filter). Read-back facet; absent on rows
   *  read before the column migration. */
  origin_actor?: Actor;
  /** D-161 P1 — contract in force on the writing execution, when
   *  contracted. Currently `'system'`-dominated → typically absent. */
  origin_contract_id?: string;
  /** D-177 N.11 rule 1 — the write SURFACE of the LAST `contact.upsert`
   *  write (`'client_rpc'` direct paired-client rpc / `'engine'`
   *  recipe-run `contact-upsert` / `'system'` default for sync-derived
   *  rows). Unlike the genesis-stamped fields above, `upsertManual`
   *  RE-STAMPS all three origin facets on every write — an agent edit
   *  of a user-created row demotes it out of the stored-cleanliness
   *  gate (`isUserCleanStoredRow`). Server-derived, never
   *  client-supplied. */
  origin_surface?: OriginSurface;
  /** First time this email appeared in mail / calendar. Set once on
   *  first sight; never updated. */
  first_seen: number;
  /** Most recent activity (mail received / sent or calendar event). */
  last_interaction: number;
  /** Cumulative interaction count — derivable but materialized for
   *  fast warehouse explorer rendering. Bumped once per source-record
   *  insert that involves this contact. */
  interaction_count: number;
  /** How this contact entry was first created. Stable for the lifetime
   *  of the row — first writer wins. */
  source: ContactSource;
  /** Engine bookkeeping — set on every write (insert or update). */
  created_at: number;
  updated_at: number;
  // ── D-138 Phase 1 — cross-platform reconciliation delta ─────────
  /** Confirmed-linked platform records for this canonical contact.
   *  Materialized at read time from the server-internal
   *  `contact_platform_link` table; the indexed lookup
   *  `(vendor, platform_id) → canonical_email` lives there, this JSON
   *  column is the contracted API surface. Storage emits `[]` on
   *  first sight; left optional so test fixtures + ad-hoc
   *  `ContactRecord` constructions stay terse. */
  platform_ids?: PlatformIdEntry[];
  /** Canonical emails this contact has been marked permanently
   *  different from. Materialized from the `contact_rejection` table.
   *  Symmetric — both sides of a rejection carry the other's email.
   *  Detection skips any pair listed here, regardless of field-match
   *  count. */
  rejected_pairs?: string[];
  /** When this row was merged into another canonical contact, points
   *  at the survivor's canonical email. `resolveContactIdentity`
   *  follows the chain to the terminal canonical row before any read
   *  or write that resolves identity. A row carrying `merged_into`
   *  is a tombstone — annotations + links are rewritten to the
   *  survivor at merge time, the redirect is the safety net for any
   *  reference that bypassed rewrite. */
  merged_into?: string;
  /** E.164-canonicalized phone number; populated from CRM-reconciler
   *  ingest (`hubspot.contact` `meta.phone` / `salesforce.contact`
   *  `meta.Phone`) or from `contact.upsert`. Drives the merge-
   *  candidate predicate (D-138 A.3). */
  phone?: string;
  /** Structured mailing address. Populated from CRM-reconciler ingest
   *  or from `contact.upsert`. Drives the predicate (A.3). */
  mailing_address?: MailingAddress;
  /** Workplace name. Populated from vendor meta (`vendor_meta`),
   *  manual `contact.upsert` (`manual`), or the gated email-domain →
   *  company resolver (`domain_inferred`). Drives the predicate. */
  company?: string;
  /** Provenance tag for `company`. Gates the email-domain inference
   *  pool — only `vendor_meta` + `manual` rows seed inference.
   *  `domain_inferred` rows do not propagate further.
   *
   *  D-192 C-2: now MATERIALIZED by the projection from the winning `org`
   *  contribution (it was previously only ever written as `'manual'` — the CRM
   *  path that would have written `'vendor_meta'` never existed). A winner at a
   *  rung this narrow enum cannot express (`contact_book` / `derived`) projects
   *  to `undefined`, which is the CORRECT answer for its one consumer: a
   *  non-authoritative company must not seed domain inference.
   *
   *  NOT retired, and deliberately (slice 3 revisited the plan to). It is no
   *  longer a provenance RECORD — `projection_provenance` is that, unlossily —
   *  but it is still the D-138 domain-inference SEED GATE, and that query
   *  (`WHERE company_source IN ('vendor_meta','manual')`) wants exactly the
   *  three-rung subset this enum can express. Dropping the column would mean
   *  re-expressing the gate as a join against `contact_attribute` for no gain.
   *  It is a derived index over the projection now, and the materializer owns it. */
  company_source?: ContactCompanySource;
  // ── D-192 C-2 — projected attribute fields ──────────────────────
  /** Job title. One of the two UNIVERSAL GAPS the `contact_attribute` store
   *  exists to close — neither the personal contact graph nor the CRM
   *  `meta_fields` carry it today. */
  title?: string;
  /** Avatar reference — a remote URL as the vendor supplied it. Bytes are NEVER
   *  fetched (the North star); a future slice can ride the file-family
   *  `storage_ref:{kind:'remote'}` seam. The second universal gap. */
  photo?: string;
  /** ISO-8601 date (`YYYY-MM-DD`). Year is often absent upstream; stored
   *  verbatim rather than coerced into a timestamp, because "March 4th, year
   *  unknown" is a real thing a contact book says and a Unix-ms field cannot
   *  hold it. */
  birthday?: string;
  /** D-192 C-2 — WHERE each projected field's value came from. Lets a surface
   *  render "org: Acme *(from HubSpot)*" without re-reading the contribution
   *  stores. Keyed by projected field name; a field absent from the map has no
   *  contribution behind it (which is not the same as having an empty one). */
  projection_provenance?: ContactProjectionProvenance;
  /** Precomputed blocking-key columns. Written on every contact
   *  upsert via `deriveNameKey` / `deriveAddressZipCountryKey` /
   *  `deriveCompanyNorm`. Housekeeping scan only evaluates the
   *  predicate against pairs sharing at least one blocking key. */
  name_key?: string;
  address_zip_country_key?: string;
  company_norm?: string;
  // ── D-145 PA8 — Contact identity extensions ─────────────────────
  /** Synthetic stable identifier — assigned at first insert, never
   *  reassigned across email changes / D-138 merges / mention_only →
   *  verified promotions. The contact_alias substrate keys on this
   *  column; chat_alias / platform_id rows survive promotion intact.
   *
   *  At PA8 the column lives alongside the email PK as a separate
   *  identifier with its own UNIQUE index; the contact_id-as-PK
   *  migration is reserved for a future phase (the prose in spec §
   *  A.4.1 about contact_id-first paths is forward-looking). For
   *  verified contacts the email column is still authoritative for
   *  `_id`; for mention_only contacts the email is a synthetic
   *  `mention-only-{ULID}@_recued.invalid` placeholder per RFC 6761
   *  reserved-for-invalid TLD discipline.
   *
   *  Optional on the read-side type so test fixtures + ad-hoc
   *  `ContactRecord` constructions stay terse; storage emits a
   *  populated value on every read. */
  contact_id?: string;
  /** § A.4.1 — `'mention_only' | 'partial' | 'verified'`. Default
   *  `'verified'` (set at insert when an email is present); chat-
   *  extraction stubs that lack an email start at `'mention_only'`.
   *  Transitions to `'verified'` via the promotion flow (§ A.4.6) re-
   *  run D-138 reconciliation against existing platform contacts. */
  identity_status?: ContactIdentityStatus;
  /** § A.4.2 — multi-value closed-list `family / work / social /
   *  other`. Drives D-145 chat extraction trust controls + D-140
   *  per-peer permission grant scope + D-147 extraction confirmation
   *  UX + privacy gating in MCP exposure. Empty array when no
   *  domain has been assigned (the substrate default). */
  network_domain?: NetworkDomain[];
  /** D-145 PB11 § B.12.1 — per-contact `personal_recipes` list. Each
   *  entry binds a recipe install to a topic; the engine matcher
   *  fires the recipe when an extraction event carries the contact's
   *  id + a topic surface that resolves to the entry's topic.
   *
   *  Per-pair only — never broadcast cross-cloud (D-097 / D-168);
   *  MCP responses strip this field by default. Settings UI is the only mutating
   *  surface; the engine dispatcher is the only reading surface
   *  (via `getPersonalRecipes`). Optional on the read-side type:
   *  contacts with an empty / missing blob surface `undefined` so
   *  test fixtures + ad-hoc constructions stay terse. */
  personal_recipes?: PersonalRecipeEntry[];
}

/** D-138 — provenance discriminator for `ContactRecord.company`. */
export type ContactCompanySource = 'vendor_meta' | 'manual' | 'domain_inferred';

/** D-138 — confirmed-linked platform record entry on a canonical
 *  contact. Multiple entries with the same `vendor` are allowed
 *  (canonical Recued contact may absorb several HubSpot duplicates). */
export interface PlatformIdEntry {
  /** Vendor handle (`'hubspot'` / `'salesforce'` / future). */
  vendor: string;
  /** The vendor's **RAW** record id — `'47291'`, `'003ABC'`, `'123'`. **NOT** the
   *  prefixed `<vendor>_<entity>_<id>` form.
   *
   *  🔴 **This docstring used to give `'hubspot_contact_47291'` as its example, and it
   *  was WRONG** — the prefixed form is the `crm_record_mirror` / `data.crm.*`
   *  `target_id` shape, a DIFFERENT key space. The only writer that MINTS a
   *  `platform_id` is the contact Source sync, which passes `record.remote_id`
   *  verbatim (`contact-source-sync.ts:775` → `:1088`); the other three writers
   *  (merge / upstream-merge) only re-point an existing entry. So the stored value is
   *  always RAW.
   *
   *  🔑 **D-206 depends on this, and it is load-bearing.** The canonical CRM field
   *  `deal.contact_id` (Pipedrive `person_id`) holds the vendor's RAW contact id — the
   *  SAME key space — which is exactly why one declaration resolves a deal to the CORE
   *  contact in a single hop. **If a writer ever stores the prefixed form, that join
   *  silently no-matches: no error, just a relationship that quietly is not there.**
   *  Pinned by `d-206-platform-id-key-space.test.ts`. */
  platform_id: string;
  /** `'auto'` = substrate-driven via deterministic email match.
   *  `'confirmed'` = added or upgraded by user action. */
  state: 'auto' | 'confirmed';
  /** Unix-ms UTC when the link was recorded. */
  linked_at: number;
  /** Origin of the link.
   *    - `'auto:email_match'` — substrate auto-link on email match
   *    - `'reconciler:<vendor>'` — vendor reconciler ingest
   *    - `'user:<canonical_email>'` — user action via merge UI */
  linked_by: string;
}

/** D-138 — structured mailing address. Drives the predicate match.
 *  `state` doubles as `province` for non-US addresses (renderers may
 *  label the field "Province" when `country !== 'US'`). */
export interface MailingAddress {
  /** Street line 1, normalized: lowercased + whitespace-collapsed +
   *  abbreviations expanded (`'St.'` → `'street'`, `'Ave.'` → `'avenue'`,
   *  `'Blvd.'` → `'boulevard'`, `'Hwy'` → `'highway'`, `'Pkwy'` →
   *  `'parkway'`). */
  address1: string;
  /** Optional unit / suite / apartment — light-normalized; not used
   *  in predicate match. */
  address2?: string;
  /** City — lowercased + whitespace-collapsed. */
  city: string;
  /** 2-letter US state code (preserved verbatim) OR full province
   *  name lowercased for international. */
  state: string;
  /** Postal code — trimmed + uppercased (handles international codes
   *  like `'SW1A 1AA'`). */
  zip: string;
  /** ISO 3166-1 alpha-2 — uppercased (`'US'`, `'CA'`, `'GB'`). */
  country: string;
}

/** D-138 — server-internal merge-candidate queue row. No cross-cloud
 *  sync (server-internal substrate, same pattern as
 *  `housekeeping_config`). Surfaced only via the local-UI
 *  `contact.merge.list` rpc; never recipe-readable. */
export interface ContactMergeCandidate {
  /** ULID. */
  id: string;
  /** Lower-lex canonical email of one side (`email_a <= email_b`). */
  email_a: string;
  /** Higher-lex canonical email of the other side. */
  email_b: string;
  /** `${email_a}|${email_b}` — UNIQUE for queue dedup. */
  pair_key: string;
  /** Names of the predicate fields that matched (closed enum from
   *  `CONTACT_MATCH_FIELDS`). Length always >= `CONTACT_MATCH_MIN_FIELDS`. */
  matched_fields: ContactMatchField[];
  /** Unix-ms UTC of detection. */
  detected_at: number;
  /** Detection-path provenance — `'inline'` for write-time hooks,
   *  `'housekeeping'` for the daily scan, `'enrollment:<connection>'`
   *  for the enrollment-time review. */
  detected_by: 'inline' | 'housekeeping' | `enrollment:${string}`;
  /** Pending → resolved on user action via `contact.merge.{confirm,reject}`. */
  status: 'pending' | 'merged' | 'rejected';
  /** Unix-ms UTC; set when `status` flips off `'pending'`. */
  resolved_at?: number;
  /** Canonical email of the user who resolved; null on substrate-
   *  driven resolution (none in v1). */
  resolved_by?: string;
}

/** D-138 — closed-list field set evaluated by `evaluateContactMatch`.
 *  Email is reserved for binary auto-merge (A.2); email-domain + title
 *  were considered and dropped (consumer-provider noise + role
 *  fluidity). */
export const CONTACT_MATCH_FIELDS = ['name', 'company', 'phone', 'mailing_address'] as const;
export type ContactMatchField = (typeof CONTACT_MATCH_FIELDS)[number];

/** D-138 P3 — `contact.merge.resolve_remerge_prompt` action set. */
export type RemergePromptResolution = 'remerge' | 'treat_as_deletion';

/** D-138 P3 — server-internal A.10 prompt row. Persisted in the
 *  `contact_remerge_prompt` SQLite table (server-internal — no
 *  cross-cloud sync). The Settings → Contacts UI lists pending
 *  prompts via the prompt store; resolution flips `resolved_at` +
 *  `resolution`. */
export interface RemergePromptRecord {
  id: string;
  /** Canonical email of the row that lost a same-vendor link. */
  affected_email: string;
  /** Canonical email of the rejected partner whose row gained one. */
  partner_email: string;
  vendor: string;
  fired_at: number;
  resolved_at?: number;
  resolution?: RemergePromptResolution;
}

/** D-138 — `evaluateContactMatch` requires this many predicate fields
 *  to match before surfacing a candidate. NULL fields don't count. */
export const CONTACT_MATCH_MIN_FIELDS = 2;

/** D-138 — domain-inference cardinality cutoff. When ≥ this many
 *  distinct companies appear under one email domain in the seed pool,
 *  inference is suppressed (consumer providers like gmail.com /
 *  outlook.com naturally exceed this; cardinality is the
 *  discriminator instead of a static denylist). */
export const COMPANY_DOMAIN_INFERENCE_MAX_DISTINCT_COMPANIES = 2;

/** D-138 — bidirectional alias cluster for first-name canonicalization.
 *  `canonical` is the lowercased canonical form; `aliases` lists
 *  lowercased alternates. The name predicate consults this registry
 *  before falling through to Levenshtein, so canonical pairs like
 *  `Bob ↔ Robert` / `Liz ↔ Elizabeth` surface even when edit distance
 *  exceeds the threshold. */
export interface NicknameAliasSet {
  canonical: string;
  aliases: readonly string[];
}

/** D-138 — static English-language nickname registry. Bidirectional
 *  per-cluster — every alias maps to every other alias in its set.
 *  Versioned constant; additions are one-line registry edits.
 *  Localization is a future iteration; out-of-locale users still get
 *  exact-match + Levenshtein ≤ 2 coverage. */
export const NICKNAME_ALIASES: readonly NicknameAliasSet[] = [
  { canonical: 'robert',      aliases: ['bob', 'rob', 'bobby', 'robby'] },
  { canonical: 'william',     aliases: ['bill', 'will', 'billy', 'liam'] },
  { canonical: 'elizabeth',   aliases: ['liz', 'beth', 'eliza', 'libby', 'betty'] },
  { canonical: 'james',       aliases: ['jim', 'jamie', 'jimmy'] },
  { canonical: 'michael',     aliases: ['mike', 'mick', 'mikey'] },
  { canonical: 'richard',     aliases: ['rick', 'dick', 'rich', 'richie'] },
  { canonical: 'anthony',     aliases: ['tony'] },
  { canonical: 'margaret',    aliases: ['maggie', 'meg', 'peggy', 'marge'] },
  { canonical: 'katherine',   aliases: ['kate', 'katie', 'kat', 'kathy', 'katy', 'kathryn'] },
  { canonical: 'thomas',      aliases: ['tom', 'tommy'] },
  { canonical: 'christopher', aliases: ['chris', 'cris'] },
  { canonical: 'daniel',      aliases: ['dan', 'danny'] },
  { canonical: 'joseph',      aliases: ['joe', 'joey'] },
  { canonical: 'charles',     aliases: ['charlie', 'chuck', 'chas'] },
  { canonical: 'edward',      aliases: ['ed', 'eddie', 'ted', 'teddy'] },
  { canonical: 'andrew',      aliases: ['andy', 'drew'] },
  { canonical: 'matthew',     aliases: ['matt', 'matty'] },
  { canonical: 'samuel',      aliases: ['sam', 'sammy'] },
  { canonical: 'benjamin',    aliases: ['ben', 'benny'] },
  { canonical: 'nicholas',    aliases: ['nick', 'nicky'] },
  { canonical: 'patricia',    aliases: ['pat', 'patty', 'tricia', 'trish'] },
  { canonical: 'jennifer',    aliases: ['jen', 'jenny', 'jenn'] },
  { canonical: 'rebecca',     aliases: ['becca', 'becky'] },
  { canonical: 'barbara',     aliases: ['barb', 'barbie'] },
  { canonical: 'susan',       aliases: ['sue', 'susie', 'suzy'] },
] as const;

/** D-138 — `resolveContactIdentity` chain depth ceiling. Real merge
 *  chains are short (typically 0 or 1 hop); the cap is a paranoia
 *  guard so a corrupted chain throws fast instead of looping. */
export const CONTACT_REDIRECT_CHAIN_LIMIT = 32;

/** D-138 — server-internal contact-merge rpc namespaces. Listed here
 *  so the MCP-catalog ratchet can reference a single source of
 *  truth. */
export const CONTACT_MERGE_RPC_METHODS = [
  'contact.merge.list',
  'contact.merge.confirm',
  'contact.merge.reject',
  'contact.merge.split',
  'contact.merge.undo_rejection',
  'contact.merge.resolve_remerge_prompt',
  'contact.merge.scan_now',
] as const;
export type ContactMergeRpcMethod = (typeof CONTACT_MERGE_RPC_METHODS)[number];

/** D-138 P3 — task id of the housekeeping scan task. Stable across
 *  releases; surfaces as the `task_id` argument the Settings →
 *  Server → Housekeeping → Run Now action passes through
 *  `housekeeping.task.run_now`, and as the value the boot wiring
 *  registers under in the housekeeping registry. */
export const CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID = 'contact-merge-candidate-scan' as const;

/** D-138 P3 — `contact.merge.scan_now` mode. `'delta'` walks contacts
 *  modified since the housekeeping cursor; `'full'` resets the cursor
 *  to 0 and walks every non-tombstone row. The Settings → Contacts →
 *  Scan now button drives `'full'` (covers the install-over-existing-
 *  graph case); the housekeeping admin Run-Now drives `'delta'` via
 *  the existing `housekeeping.task.run_now` rpc. */
export type ContactMergeScanMode = 'delta' | 'full';

/** D-138 — resolver helper. Given a canonical email, follows the
 *  `merged_into` redirect chain to the terminal canonical row; returns
 *  the survivor's canonical email + the number of hops walked.
 *  Throws on cycle detection (a corrupted graph; substrate invariants
 *  forbid cycles since split clears `merged_into` before re-merge can
 *  set it again). The lookup callback is the indirection — storage
 *  layers pass a closure over the `contacts` table; pure tests pass an
 *  in-memory map. Returns `chain_depth: 0` when the email is already
 *  canonical (no redirect). */
export function resolveContactIdentity(
  email: string,
  lookup: (canonical_email: string) => { merged_into?: string } | null,
): { canonical_email: string; chain_depth: number } {
  const canonical = canonicalizeEmail(email);
  if (!canonical) {
    throw new Error(`contact_redirect_invalid_email: ${email}`);
  }
  const seen = new Set<string>([canonical]);
  let cursor = canonical;
  let depth = 0;
  while (depth < CONTACT_REDIRECT_CHAIN_LIMIT) {
    const row = lookup(cursor);
    if (!row || !row.merged_into) {
      return { canonical_email: cursor, chain_depth: depth };
    }
    const next = canonicalizeEmail(row.merged_into);
    if (!next) {
      throw new Error(`contact_redirect_invalid_target: ${row.merged_into}`);
    }
    if (seen.has(next)) {
      throw new Error(`contact_redirect_cycle: ${canonical}`);
    }
    seen.add(next);
    cursor = next;
    depth++;
  }
  throw new Error(`contact_redirect_chain_exceeded: ${canonical}`);
}

/** Provenance discriminator — recorded once on first write, never
 *  changed. Manual edits to a previously-derived contact still carry
 *  the original adapter source so the explorer can group "auto-
 *  discovered" vs "manually added" contacts.
 *
 *  ⚠ **This is NOT the C-2a ladder.** It records how the contact ROW was first
 *  CREATED; `ContactContributionSource` (`contact-contribution.ts`) records who
 *  asserted each FIELD. Two vocabularies, deliberately —
 *  `contactSourceToContributionRung` is the only bridge, and it is where a new
 *  member here must earn its rung. */
export type ContactSource =
  | 'email_from'        // first appeared as From of an inbound mail
  | 'email_to'          // first appeared as To/CC of an outbound mail
  | 'calendar_attendee' // first appeared as calendar event attendee
  | 'contact_book'      // D-205 #4 — created by a contact-book `full_import`
  | 'crm_import'        // D-205 #5 — the user PULLED this person out of a CRM
  | 'manual';           // user-added via contact.upsert rpc

/** D-205 #5 — the `ContactSource`s an IMPORT stamps on a row it creates, as opposed
 *  to the ones Recued derives from warehouse traffic or the user types.
 *
 *  🔑 **The distinction is load-bearing in three places, and getting it wrong is
 *  silent every time:**
 *
 *   1. **`observe` refuses them** (`ContactObservation.source` excludes this set). It
 *      is the warehouse-traffic path and carries no `source_id`, so its contributions
 *      are attributed to `recued.derived` — a provenance LIE for an import, and a
 *      collision with the contact's real derived rows.
 *   2. **The C-2 cutover backfill SKIPS them.** That pass converges rows that PREDATE
 *      contributions (its guard is `projection_provenance IS NULL`). A freshly-minted
 *      imported row has null provenance too — for a few milliseconds, until its write
 *      pass lands — so without this the backfill can grab one mid-flight and write its
 *      name at `derived` / `recued.derived`: Recued claiming it pulled from a mail
 *      header a name that HubSpot asserted. **An import never predates contributions.
 *      It is post-C-2 by construction.**
 *   3. **A created row must be ATTRIBUTABLE.** These are the only values an importer
 *      may stamp; `manual` would park a vendor's assertion at the TOP of the C-2a
 *      ladder where the user's own typing could never correct it. */
export const CONTACT_IMPORT_ROW_SOURCES = ['contact_book', 'crm_import'] as const;
export type ContactImportRowSource = (typeof CONTACT_IMPORT_ROW_SOURCES)[number];
export const CONTACT_IMPORT_ROW_SOURCE_SET: ReadonlySet<string> = new Set(
  CONTACT_IMPORT_ROW_SOURCES,
);
export const isContactImportRowSource = (v: unknown): v is ContactImportRowSource =>
  typeof v === 'string' && CONTACT_IMPORT_ROW_SOURCE_SET.has(v);

/** Every source that is NOT an import — what `observe` may stamp. */
export type ContactObservedSource = Exclude<ContactSource, ContactImportRowSource>;

/** Maximum records processed in one materialize pass before the
 *  backfill yields back to the engine. Prevents long backfills from
 *  blocking the runtime; one tick == one batch == one progress emit. */
export const CONTACT_MATERIALIZE_BATCH_SIZE = 500;

// ────────────────────────────────────────────────────────────────
// Canonicalization
// ────────────────────────────────────────────────────────────────

/** Parse one address out of a mail header value. Handles the three
 *  canonical RFC 5322 shapes the spec mandates:
 *    `bob@x.com`
 *    `Bob Smith <bob@x.com>`
 *    `"Smith, Bob" <bob@x.com>`
 *    `bob@x.com (Bob Smith)`
 *
 *  Returns `null` when no `@` is found — caller skips the row. Does
 *  NOT split a header containing multiple addresses; pair this with
 *  `splitAddressList` for that. */
export interface ParsedAddress {
  /** Canonical (lowercased, trimmed) email. */
  email: string;
  /** Display name when one was supplied alongside the address. */
  name?: string;
}

/** Split a mail header value into one entry per address. Naive on
 *  purpose — splits on commas outside double-quoted display names so
 *  `"Last, First" <a@b.com>, c@d.com` parses as two entries.
 *  Whitespace-only entries are filtered out. */
export const splitAddressList = (header: string): string[] => {
  if (!header) return [];
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;
  for (const ch of header) {
    if (ch === '"' && !inAngle) {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === '<' && !inQuotes) inAngle = true;
    else if (ch === '>' && !inQuotes) inAngle = false;
    if (ch === ',' && !inQuotes && !inAngle) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
};

const ANGLE_PATTERN = /^(.*?)<([^<>]+)>\s*$/;
const PAREN_PATTERN = /^([^()]+?)\s*\(([^()]+)\)\s*$/;

const stripQuotes = (s: string): string => {
  const trimmed = s.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

/** Parse one address. Returns `null` when no `@` is present after
 *  stripping wrappers. */
export const parseAddress = (raw: string): ParsedAddress | null => {
  if (!raw) return null;
  let display: string | undefined;
  let addr: string;

  const angle = raw.match(ANGLE_PATTERN);
  if (angle) {
    display = stripQuotes(angle[1] ?? '');
    addr = (angle[2] ?? '').trim();
  } else {
    const paren = raw.match(PAREN_PATTERN);
    if (paren) {
      addr = (paren[1] ?? '').trim();
      display = (paren[2] ?? '').trim();
    } else {
      addr = raw.trim();
    }
  }
  if (!addr || !addr.includes('@')) return null;
  const email = canonicalizeEmail(addr);
  if (!email) return null;
  const out: ParsedAddress = { email };
  if (display) out.name = display;
  return out;
};

/** Lowercase + trim + strip surrounding whitespace / angle brackets.
 *  Returns the canonical key used for the `email` column. Empty
 *  string when the input is unparseable so callers can early-out
 *  without throwing.
 *
 *  Plus-addressing is preserved — `bob+ml@x.com` stays distinct from
 *  `bob@x.com` since the user generally treats the alias as a separate
 *  identity. Quoted local-parts are passed through unchanged (rare in
 *  practice; if they arrive, we trust the source to have escaped). */
export const canonicalizeEmail = (raw: string): string => {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  // Strip optional surrounding angle brackets — `<bob@x.com>` → `bob@x.com`.
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  // No `@` → not an email; bail. Reject multi-`@` strings outright —
  // a real address has exactly one (we already stripped the angle
  // brackets above, so `Bob <a@b>` doesn't reach this branch).
  const at = s.indexOf('@');
  if (at < 1 || at === s.length - 1) return '';
  if (s.indexOf('@', at + 1) !== -1) return '';
  // Lowercase the domain unconditionally (case-insensitive per RFC).
  // Lowercase the local-part too — strict reading of RFC 5321 says
  // local-part is case-sensitive, but real-world providers (Gmail,
  // Outlook, etc.) all treat it case-insensitively. Matching that
  // norm prevents `Bob@x.com` and `bob@x.com` showing as two contacts.
  const local = s.slice(0, at).toLowerCase();
  const domain = s.slice(at + 1).toLowerCase();
  if (!local || !domain) return '';
  return `${local}@${domain}`;
};

/** Default display name when an address arrives without one. Returns
 *  the local-part of the email — `bob@x.com` → `bob`. Used by the
 *  derivation passes when the mail header didn't ship a friendly name. */
export const fallbackDisplayName = (email: string): string => {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
};
