/** D-192 C-2 (Stance 2) — the contact contribution-projection substrate.
 *
 *  The canonical-vocabulary half of the kinds-taxonomy §0 governing rule
 *  (D-192 §3c) applied to contacts: contact-import is
 *  inherently many-sources-into-one-person (Google + Outlook + HubSpot +
 *  Salesforce + Zoho + vCard each contribute a PARTIAL view of the same human).
 *  A single-valued column cannot hold that — whoever writes last wins, silently.
 *
 *  So a `data.contact` row stops being STORAGE and becomes a PROJECTION: every
 *  source writes a `(kind, value, source, confidence, as_of)` CONTRIBUTION, and
 *  the canonical field is resolved from the contributions by the declared
 *  ladder below. Nothing is overwritten; conflicting views coexist and the
 *  strongest one surfaces. This is the D-192 North star — *many declared Sources
 *  → one canonical entity → a projection, not storage* — applied to contacts.
 *
 *  This module is the RESOLVER half (pure, storage-free): the source-priority
 *  ladder (C-2a) + the winner-selection it drives. The three contribution STORES
 *  it resolves over are:
 *
 *    | store                | axis        | value  |
 *    |----------------------|-------------|--------|
 *    | `contact_alias`      | identifiers | scalar |  (EXISTS — D-145 PA8)
 *    | `contact_attribute`  | attributes  | JSON   |  (new)
 *    | `contact_source_blob`| raw vendor  | blob   |  (new)
 *
 *  Scope note (what reads this): PURE + storage-free. The stores + the
 *  materializer consume `resolveContribution`; nothing here touches SQLite, so
 *  the ladder is unit-testable in isolation and the projection has exactly ONE
 *  conflict policy — a second implementation of "which value wins" is the bug
 *  this module exists to prevent.
 *
 *  Spec: D-192 §3c + C-2a; decisions-log § D-192. */

// Type-only, so no runtime import cycle: `contact.ts` already imports
// `ContactProjectionProvenance` from here, and both edges are erased at compile
// time. (A runtime edge would matter — this module has a boot-time self-check.)
import type { ContactSource, ContactCompanySource, ContactMatchField } from './contact.js';

// ────────────────────────────────────────────────────────────────
// C-2a — the source-priority ladder
// ────────────────────────────────────────────────────────────────

/** Where a contribution came from, STRONGEST first. The ratified C-2a ladder
 *  (`manual > user_confirmed > vendor_meta > contact_book > ai_inferred`), plus
 *  the two rungs the existing substrate already needs a home for:
 *
 *   - `manual`         — the user typed it (`contact.upsert`, the merge UI).
 *   - `user_confirmed` — the user ASSENTED to a value someone else proposed
 *                        (a confirmed merge, a chat confirmation, a tag button).
 *                        Subsumes the legacy `chat_confirmed` / `tag_button`
 *                        alias sources.
 *   - `vendor_meta`    — a CRM/platform record asserted it (HubSpot, Salesforce,
 *                        Dynamics …). Authoritative-ish: a human maintains it,
 *                        just not THIS human.
 *   - `contact_book`   — a personal contact book asserted it (Google People, MS
 *                        Graph, CardDAV). Below CRM deliberately: contact books
 *                        rot (stale phone numbers outlive job changes), CRMs are
 *                        curated.
 *                        ⚠ **Renamed from `address_book` (D-205 ruling 1).** They
 *                        hold full contact ENTITIES — name, phones, addresses,
 *                        photo, birthday, org — not addresses. The misnomer was
 *                        not cosmetic: it cost a wasted PII-on-address
 *                        investigation. Pre-launch rename, no migration (the
 *                        `source` columns are bare TEXT with no CHECK, and no
 *                        writer could ever emit this rung — no contact-book
 *                        source was declared).
 *   - `derived`        — Recued deterministically derived it from warehouse
 *                        traffic (a mail From header, a calendar attendee). No
 *                        model, no guess — but nobody ASSERTED it either.
 *   - `ai_inferred`    — a model proposed it.
 *   - `domain_inferred`— the email-domain → company resolver guessed it. The
 *                        WEAKEST rung, and deliberately its own: D-138 gates the
 *                        inference pool on it (only `vendor_meta` + `manual`
 *                        rows seed inference; `domain_inferred` rows must never
 *                        propagate further, or the guess compounds).
 *
 *  ⚠ **The ARRAY ORDER IS THE RANK** (`CONTACT_CONTRIBUTION_SOURCE_PRIORITY` is
 *  `Object.fromEntries(map((s, i) => [s, i]))`), so a rename must happen IN
 *  PLACE. Moving a line silently re-ranks every contribution below it.
 *
 *  ⚠ There is deliberately NO flat `legacy` rung, though C-2b's prose named one.
 *  A backfill that tags every pre-existing column `legacy` and parks it at the
 *  bottom would let the FIRST CRM import silently overwrite the user's own hand-
 *  typed edits — the exact data loss the projection exists to prevent. The
 *  backfill instead maps each legacy column to its TRUE rung using the
 *  provenance the substrate already records (`ContactCompanySource`,
 *  `ContactAliasSource`, `ContactRecord.source`). Provenance is preserved, not
 *  flattened. */
export const CONTACT_CONTRIBUTION_SOURCES = [
  'manual',
  'user_confirmed',
  'vendor_meta',
  'contact_book',
  'derived',
  'ai_inferred',
  'domain_inferred',
] as const;
export type ContactContributionSource = (typeof CONTACT_CONTRIBUTION_SOURCES)[number];

export const CONTACT_CONTRIBUTION_SOURCE_SET: ReadonlySet<string> = new Set(
  CONTACT_CONTRIBUTION_SOURCES,
);

export const isContactContributionSource = (v: unknown): v is ContactContributionSource =>
  typeof v === 'string' && CONTACT_CONTRIBUTION_SOURCE_SET.has(v);

/** The ladder as a comparable rank — LOWER wins (0 = strongest), mirroring
 *  `TRANSPARENCY_REDACTION_TIER_PRIORITY`. Derived from the array so the array
 *  stays the single source of truth: reordering the ladder above reorders the
 *  ranks, and a rung can never be added to one and forgotten in the other. */
export const CONTACT_CONTRIBUTION_SOURCE_PRIORITY: Readonly<
  Record<ContactContributionSource, number>
> = Object.freeze(
  Object.fromEntries(
    CONTACT_CONTRIBUTION_SOURCES.map((s, i) => [s, i]),
  ) as Record<ContactContributionSource, number>,
);

/** The rank an UNDECLARED source resolves to — weaker than every declared rung.
 *
 *  ⚠ This is the runtime floor, and it is the whole point. D-192's own scar:
 *  widening a union to `string` silently degrades `Record<Union, …>` into
 *  `Record<string, …>`, so a lookup that used to be compiler-checked starts
 *  returning `undefined` — and `undefined` in a numeric comparison poisons the
 *  sort rather than losing it. An unknown source must LOSE to a known one, not
 *  scramble the ladder. Fail-closed, always. */
const UNKNOWN_SOURCE_RANK = Number.MAX_SAFE_INTEGER;

/** Rank one source. Accepts `string` (not just the union) precisely because a
 *  persisted cell or a pack-declared Source can carry a value this build has
 *  never heard of — it ranks last instead of crashing or winning. */
export const contactContributionRank = (source: string): number =>
  CONTACT_CONTRIBUTION_SOURCE_PRIORITY[source as ContactContributionSource] ??
  UNKNOWN_SOURCE_RANK;

// ────────────────────────────────────────────────────────────────
// The `contact_attribute` kind vocabulary
// ────────────────────────────────────────────────────────────────

/** What a `contact_attribute` row can assert. The ATTRIBUTE axis — descriptive
 *  facts about a person. (The IDENTIFIER axis — values you can MATCH a person
 *  by — lives in `contact_alias`: `email_alias` / `phone_alias` / `chat_alias` /
 *  `platform_id`.)
 *
 *  ⚠ Two deliberate deviations from the ratified §3c table, both to keep the
 *  identifier/attribute split honest:
 *
 *   - **`phone` is NOT here.** The table listed it as an attribute, but a phone
 *     number is something you IDENTIFY someone by: it already drives the D-138
 *     merge predicate and already has a derived match index
 *     (`contact_phone_forms`). It lives in `contact_alias` as `phone_alias`.
 *     Storing it in BOTH would split-brain the projection — two stores, two
 *     answers, and no rule for which one `ContactRecord.phone` reads.
 *   - **`name` IS here.** The table omitted it, but the design's own
 *     `ContactSourceDeclaration.map.attributes` lists it — and it is the single
 *     most-conflicted field across sources (Google says "Bob Smith", HubSpot
 *     says "Robert Smith", the mail header says "bob"). A field that conflicts
 *     across sources is precisely what the contribution model is FOR.
 *
 *  `title` + `photo` are the UNIVERSAL GAP this store exists to close: neither
 *  the personal contact graph nor the CRM `meta_fields` carry them today. */
export const CONTACT_ATTRIBUTE_KINDS = [
  'name',
  'org',
  'title',
  'address',
  'photo',
  'birthday',
] as const;
export type ContactAttributeKind = (typeof CONTACT_ATTRIBUTE_KINDS)[number];

export const CONTACT_ATTRIBUTE_KIND_SET: ReadonlySet<string> = new Set(
  CONTACT_ATTRIBUTE_KINDS,
);

export const isContactAttributeKind = (v: unknown): v is ContactAttributeKind =>
  typeof v === 'string' && CONTACT_ATTRIBUTE_KIND_SET.has(v);

// ────────────────────────────────────────────────────────────────
// The contribution shape
// ────────────────────────────────────────────────────────────────

/** One source's assertion about one field of one contact. The row shape the
 *  three contribution stores share — `contact_alias` already persists exactly
 *  this (`contact_id, kind, value, source, confidence, created_at`), which is
 *  why C-2 needs no schema change there, only new `kind` values.
 *
 *  `V` is the value type: a scalar for an alias, a JSON object for an attribute. */
export interface ContactContribution<V = unknown> {
  /** Which field this asserts (`org`, `title`, `email_alias`, …). Open at this
   *  layer — each STORE closes its own kind vocabulary; the resolver only ever
   *  compares contributions already grouped by kind. */
  kind: string;
  /** The asserted value. */
  value: V;
  /** Provenance — ranked by the ladder. */
  source: ContactContributionSource | string;
  /** 0..1. A `manual` write is always 1.0. */
  confidence: number;
  /** Unix-ms UTC — when the SOURCE asserted this (event time), not when Recued
   *  stored it. A CRM record edited last year that Recued imported today is a
   *  year-old assertion, and the recency tiebreak must see it that way (the
   *  D-120 bistemporal rule: `event_at` over ingestion `ts`). */
  as_of: number;
}

// ────────────────────────────────────────────────────────────────
// Substrate row shapes (`contact_attribute` / `contact_source_blob`)
// ────────────────────────────────────────────────────────────────

/** One `contact_attribute` row — one source's assertion about one descriptive
 *  field. The attribute-axis twin of `ContactAliasRecord`.
 *
 *  `value` is JSON (an `address` is a structured object; a `title` is a string),
 *  parsed by the store.
 *
 *  ⚠ **Uniqueness is `(contact_id, kind, source_id)` — NOT `(…, source)`.** The
 *  distinction is load-bearing and easy to get wrong: `source` is a TRUST RUNG,
 *  not an identity. Google Contacts and Outlook Contacts are BOTH
 *  `contact_book`; HubSpot and Salesforce are BOTH `vendor_meta`. Keying on the
 *  rung would make two peer sources collide on one row and overwrite each other
 *  every sync cycle — the projection would ping-pong, which is exactly the
 *  "whoever writes last wins, silently" failure this store exists to prevent.
 *  `source_id` says WHO asserted it; `source` says HOW MUCH TO TRUST them. */
export interface ContactAttributeRecord {
  /** ULID. */
  id: string;
  /** FK → `contacts.contact_id` (by convention — the substrate uses partial
   *  unique indexes + a runtime existence check rather than a SQL FK, matching
   *  `contact_alias`). */
  contact_id: string;
  kind: ContactAttributeKind;
  /** The asserted value — scalar for `title` / `org`, object for `address`. */
  value: unknown;
  /** WHO asserted it — the writer's stable identity, and the row's uniqueness
   *  key alongside `(contact_id, kind)`.
   *
   *  For a Source-derived contribution this is the D-145 `SourceRegistration.id`
   *  (`CONNECTION_SOURCE_ID(vendor, connection_name, 'contact')`, e.g.
   *  `google.personal.contact`) — so two Google accounts are two sources, not
   *  one. For a hand edit it is `CONTACT_SOURCE_ID_MANUAL`; for warehouse
   *  derivation, the builtin Source id; for an AI producer, its recipe id.
   *
   *  It is also what makes Source TEARDOWN possible: purging a disconnected
   *  Source's contributions needs to know which rows were its. */
  source_id: string;
  /** HOW MUCH to trust it — the C-2a ladder rung. */
  source: ContactContributionSource;
  /** 0..1. A `manual` write is always 1.0. */
  confidence: number;
  /** Unix-ms UTC — when the SOURCE asserted this (event time). See
   *  `ContactContribution.as_of`. */
  as_of: number;
  /** Unix-ms UTC — when Recued first recorded this row (ingestion time).
   *  Preserved across re-upserts of the same `(contact_id, kind, source_id)`. */
  created_at: number;
}

/** Input for `upsertContactAttribute`. `id` + `created_at` are set by storage. */
export interface ContactAttributeInput {
  contact_id: string;
  kind: ContactAttributeKind;
  value: unknown;
  /** WHO — see `ContactAttributeRecord.source_id`. */
  source_id: string;
  /** HOW MUCH TO TRUST — the ladder rung. */
  source: ContactContributionSource;
  confidence?: number;
  /** Defaults to the write time when the source carries no event time. */
  as_of?: number;
  /** Test override. Production callers omit. */
  id?: string;
  /** Test override. Production callers omit. */
  created_at?: number;
}

/** The `source_id` a hand edit writes (`contact.upsert`, the merge UI). A
 *  constant, because there is exactly one of the user. */
export const CONTACT_SOURCE_ID_MANUAL = 'manual';

/** The `source_id` for facts Recued derived from its own warehouse traffic (a
 *  mail `From` header, a calendar attendee) rather than importing from anywhere. */
export const CONTACT_SOURCE_ID_DERIVED = 'recued.derived';

// ────────────────────────────────────────────────────────────────
// C-2b — legacy provenance → ladder rung
// ────────────────────────────────────────────────────────────────

/** ⚠ **C-2b's ratified prose is a defect and is NOT built as written.** It said
 *  "backfill existing columns as `source='legacy'` contributions". A flat
 *  `legacy` rung parked at the bottom of the ladder would let the FIRST CRM
 *  import (`vendor_meta`) silently overwrite the user's own hand-typed edits —
 *  the precise data loss the projection exists to prevent. There is no `legacy`
 *  rung, and these two functions are why: every legacy column already carries
 *  provenance somewhere in the substrate, so the backfill maps it to its TRUE
 *  rung instead of flattening it.
 *
 *  They live in contracts, next to the ladder, because the backfill is not their
 *  only caller — the LIVE write paths rank the same way (an `observe`-derived
 *  name and a backfilled one must land on the same rung, or the cutover would
 *  silently re-rank a contact the first time it was touched). One ladder, one
 *  mapping, one place. */

/** `ContactSource` (how the contact ROW was first created) → its ladder rung.
 *
 *  Only `'manual'` is an assertion by the user. The three adapter sources
 *  (`email_from` / `email_to` / `calendar_attendee`) are exactly what `derived`
 *  was added to the ladder for: Recued deterministically pulled the address out
 *  of warehouse traffic — no model, no guess, but nobody ASSERTED it either. So
 *  a later contact-book import legitimately outranks it.
 *
 *  🔑 **A TABLE, not a ternary — and that is the whole point (D-205 #4).** This
 *  was `source === 'manual' ? 'manual' : 'derived'`: an everything-else collapse
 *  with an `| string` signature, so adding a `ContactSource` member landed it on
 *  `derived` **silently, with no compile error**. `contact_book` would have been
 *  ranked BELOW the rung of the same name — an import outranked by nothing,
 *  correctable by anything, and no test would have said a word.
 *
 *  The `Record<ContactSource, …>` now forces a rung DECISION per member at
 *  compile time. The `?? 'derived'` is the runtime floor for a value that
 *  crossed a boundary (a persisted row written by an older build) and never met
 *  the type — weakest-but-declared, never `undefined`.
 *  [[feedback_widening_a_union_disarms_record_exhaustiveness]] */
const CONTACT_SOURCE_RUNG: Readonly<Record<ContactSource, ContactContributionSource>> =
  Object.freeze({
    // The user typed it.
    manual: 'manual',
    // D-205 #4 — a `full_import` from the user's own contact book. Its own rung,
    // BELOW a CRM (contact books rot) and ABOVE `derived` (someone chose to keep
    // this person; nobody chose to appear in a mail header).
    contact_book: 'contact_book',
    // D-205 #5 — the user PULLED this person out of a CRM (selective promotion).
    // The row exists because the user chose it; every VALUE on it is the CRM's, and
    // lands at `vendor_meta` from the Source. Which is why this maps to the CRM's
    // rung and NOT to `manual`: the user picked the person, they did not type the
    // person's phone number.
    crm_import: 'vendor_meta',
    // Recued pulled the address out of warehouse traffic. No model, no guess —
    // and no assertion.
    email_from: 'derived',
    email_to: 'derived',
    calendar_attendee: 'derived',
  });

export const contactSourceToContributionRung = (
  source: ContactSource | string,
): ContactContributionSource => CONTACT_SOURCE_RUNG[source as ContactSource] ?? 'derived';

/** `ContactCompanySource` (the lone pre-C-2 per-field provenance column) → its
 *  ladder rung. All three of its values ARE rungs — the narrow enum was always a
 *  three-rung subset of the ladder, which is what made unifying them possible.
 *
 *  ⚠ The `null` case is the load-bearing one. A `company` with NO recorded
 *  `company_source` maps to **`derived`**, not `manual`: we genuinely do not know
 *  who asserted it, and guessing `manual` would park an unattributed value at the
 *  TOP of the ladder where no import could ever correct it. `derived` also
 *  round-trips exactly — the projection maps it back to a NULL `company_source`
 *  (the narrow enum cannot express it), which is the same value the column holds
 *  today and keeps it correctly OUT of the D-138 domain-inference seed pool. An
 *  unrecognized persisted value takes the same floor, for the same reason. */
export const companySourceToContributionRung = (
  company_source: ContactCompanySource | string | null | undefined,
): ContactContributionSource =>
  company_source === 'manual' ||
  company_source === 'vendor_meta' ||
  company_source === 'domain_inferred'
    ? company_source
    : 'derived';

/** The `source_id` (WHO) that pairs with a rung when the writer is Recued itself
 *  rather than an importer. Only two of the user's own writers exist: the user
 *  (`manual`), and Recued's own derivation from warehouse traffic. Any rung an
 *  IMPORTER writes carries its own `SourceRegistration.id` and never comes
 *  through here. */
export const contributionSourceIdForRung = (
  rung: ContactContributionSource,
): string =>
  rung === 'manual' ? CONTACT_SOURCE_ID_MANUAL : CONTACT_SOURCE_ID_DERIVED;

// ────────────────────────────────────────────────────────────────
// The projection's provenance facet
// ────────────────────────────────────────────────────────────────

/** WHERE a projected field's value came from — carried on the materialized
 *  `data.contact` row so a surface can render "org: Acme *(from HubSpot)*"
 *  without re-reading the contribution stores.
 *
 *  This is what generalizes `ContactCompanySource` (today's lone, company-only
 *  provenance column) to EVERY field. */
export interface ContactFieldProvenance {
  /** The winning contribution's trust rung. */
  source: ContactContributionSource;
  /** The winning contribution's source instance — WHO.
   *
   *  OPTIONAL, and deliberately so: an alias row may predate any importer and
   *  carry no recorded instance. Omitting it says "we don't know who" — which is
   *  the truth. Fabricating a plausible one (`'manual'`, say) would be worse than
   *  useless: provenance that LIES is more dangerous than provenance that is
   *  absent, because a surface will render it as fact. */
  source_id?: string;
  /** The winning contribution's event time — `ContactContribution.as_of`.
   *
   *  🔑 **Carried because the rung alone cannot PREDICT a winner, and one surface
   *  must.** `resolveContribution` ranks rung → `as_of` → `confidence`, so a rung
   *  TIE is broken on these two — and a rung tie is the COMMON case, not an edge
   *  one: two mail-derived duplicates of the same person are both `derived`, and
   *  that is the single most frequent merge candidate there is. A consumer given
   *  only the rung would find exactly the commonest merge undecidable, and would
   *  then invent a local fallback — a second implementation of "which value wins",
   *  which is the precise bug this module exists to prevent (see the header).
   *
   *  Always the WINNER's own value, never synthesized.
   *
   *  ⚠ OPTIONAL, like `source_id`, and for a harder reason: `projection_provenance`
   *  is persisted JSON and is parsed with an unchecked cast, so a row materialized
   *  by an older build carries neither this nor `confidence` and no type can police
   *  what is already on disk. A consumer that RANKS must therefore check for them
   *  and refuse to guess when they are absent — see `winningCardsForField`. */
  as_of?: number;
  /** The winning contribution's confidence — the tiebreaker below `as_of`. Same
   *  optionality reasoning as `as_of`; the two travel together. */
  confidence?: number;
}

/** The per-field provenance map materialized onto a contact row, keyed by the
 *  projected field name (`name` / `org` / `title` / `address` / `photo` /
 *  `birthday` / `phone`). A field absent from the map has no contribution
 *  behind it — which is different from having an empty one. */
export type ContactProjectionProvenance = Readonly<
  Record<string, ContactFieldProvenance>
>;

/** A `ContactMatchField` (the column a merge-review card renders) → the
 *  CONTRIBUTION KIND it is asserted as, which is its key in
 *  `ContactProjectionProvenance`.
 *
 *  🔑 **TWO OF THE FOUR DIFFER, and both differences are silent.** The column
 *  `company` is asserted as the kind `org`; the column `mailing_address` as the
 *  kind `address`. Looking the provenance map up by the COLUMN name yields
 *  `undefined` for exactly those two — so a field that HAS provenance reads as if
 *  it had none. That is HALF the merge-review field set, and it is precisely the
 *  half where cross-source conflict actually lives (the Google-vs-HubSpot `org`
 *  disagreement is the whole reason the ladder exists).
 *
 *  The webclient's contact-detail page hit this exact miss during D-205 #2a and
 *  pinned it with a test. This table is that lesson made reusable — the pairing is
 *  a TABLE, not an assumption, and it lives here (next to the provenance shape it
 *  indexes) so the two surfaces that need it cannot drift apart.
 *
 *  A `Record<ContactMatchField, …>` on purpose: adding a match field forces a
 *  decision here at COMPILE time instead of defaulting to a silent `undefined`
 *  lookup at runtime. [[feedback_widening_a_union_disarms_record_exhaustiveness]]
 *
 *  ⚠ The VALUE type is closed too, and for the same reason: a typo'd kind would
 *  otherwise be a perfectly legal `string` that simply never matches a provenance
 *  key — the silent-miss this table exists to prevent, reintroduced inside the
 *  table itself. `'phone'` is spelled out because a phone is NOT a
 *  `ContactAttributeKind`: it is an IDENTIFIER (`contact_alias.phone_alias`), and
 *  the projection keys its provenance under `phone` all the same. */
export const CONTACT_MATCH_FIELD_CONTRIBUTION_KIND: Readonly<
  Record<ContactMatchField, ContactAttributeKind | 'phone'>
> = Object.freeze({
  name: 'name',
  // ⚠ NOT `company` — the projection asserts the workplace as the kind `org`.
  company: 'org',
  phone: 'phone',
  // ⚠ NOT `mailing_address` — the projection asserts it as the kind `address`.
  mailing_address: 'address',
});

/** One contribution as a READ row — the contribution, plus whether it WON its kind.
 *
 *  **D-205 merge-review item 3 — the per-source value view.** The projection
 *  materializes only the WINNER onto the `data.contact` row, so a client could see
 *  *what* a field holds and (since #2a) *who* asserted it — but never what the OTHER
 *  sources said. The ladder was legible only in its OUTCOME. These rows make it
 *  legible in its INPUT: *"Company — Acme Inc., from HubSpot (kept) · Acme Corp, from
 *  Google Contacts"*. Same rows the projection resolved over, nothing else.
 *
 *  ⛔ **`winner` is computed SERVER-side by `resolveContribution` — the ONE conflict
 *  policy — and a client must NEVER re-rank these rows.** That is precisely the bug
 *  merge-review item 1 fixed: `winningCardsForField` was a second implementation of
 *  "which value wins" and it silently disagreed with the projection for years. The
 *  flag is carried so no consumer ever needs to compute it.
 *
 *  ⚠ It is a per-KIND flag, not a global one: exactly one row per `kind` present in
 *  the set carries `winner: true` (the kind's own winner), except where the
 *  materializer's shape guard dropped the winning value — then the field projects
 *  nothing and no row for that kind is marked. */
export interface ContactContributionView extends ContactContribution<unknown> {
  /** WHO asserted it — the source INSTANCE (`google.personal.contact`, `manual`, …).
   *  Optional, and never fabricated: a row may predate any importer, and "we don't
   *  know who" is the truth. [[feedback_provenance_that_lies_is_worse_than_absent]] */
  source_id?: string;
  /** True iff `resolveContribution` picked this row as its kind's winner — i.e. this
   *  is the value the contact row actually holds. */
  winner: boolean;
}

/** One `contact_source_blob` row — a remote contact record, mirrored verbatim.
 *
 *  Both the family's `SourceMirrorStore` row (the `snapshot_hash` is the
 *  incremental seam) and the audit trail behind every derived contribution:
 *  when the projection says "org = Acme (from HubSpot)", this is the record that
 *  said so.
 *
 *  ⚠ **The mirror key is `(source_id, remote_id)` — NOT `(vendor, remote_id)`.**
 *  Slice 1 keyed it on the VENDOR, which is the same defect `contact_attribute`
 *  was built to avoid one door over: a vendor is not an identity. Two D-125
 *  connections to ONE vendor are TWO Sources with INDEPENDENT record-id spaces —
 *  a Salesforce sandbox + prod pair (D-130 ships that toggle), two HubSpot
 *  portals, two Google accounts. Under a vendor key they collide on one row, and
 *  the sync's delete diff is worse than the collision: each Source's walk would
 *  see the OTHER's records as absent and tombstone them, every cycle, forever.
 *  `source_id` says WHICH INSTANCE mirrored this record, and it is the same key
 *  the contributions already use — so a Source's blobs, attributes and aliases
 *  all tear down together. (D-192 C-2 slice 6a.) */
export interface ContactSourceBlobRecord {
  /** ULID. */
  id: string;
  /** The local contact this remote record contributed to. */
  contact_id: string;
  /** WHO mirrored it — the D-145 `SourceRegistration.id`
   *  (`CONNECTION_SOURCE_ID(vendor, connection_name, 'contact')`, e.g.
   *  `hubspot.work.contact`). The mirror key alongside `remote_id`. */
  source_id: string;
  /** Vendor slug — `hubspot` / `google` / `carddav` / … Denormalized from
   *  `source_id`'s first segment for display + cross-Source queries ("every
   *  HubSpot record for this person"). NOT the identity — see the note above. */
  vendor: string;
  /** The vendor's own record id. Unique WITHIN a Source: one remote record maps
   *  to at most one local contact, so a re-import can never fan a single CRM
   *  contact across two people. */
  remote_id: string;
  /** The vendor payload, verbatim. */
  blob: unknown;
  /** Content hash of `blob` — the hash-skip key. */
  snapshot_hash: string;
  /** Unix-ms UTC — the remote record's own last-modified (event time). */
  as_of: number;
  /** Unix-ms UTC — first mirrored. Preserved across re-upserts. */
  created_at: number;
  /** D-205 §1 — Unix-ms UTC when the vendor's record went away (absent from a
   *  COMPLETE walk), or null while it is still there.
   *
   *  A SOFT MARK, never a delete. A vendor deleting *their* record is only a
   *  disconnection of the linkage: the contributions it made STAY, because after
   *  import the core contact is one of the sources of truth and HubSpot deleting
   *  its copy is not a retraction of what Recued learned. This blob is the
   *  EVIDENCE behind claims that now stand on their own — hard-deleting it would
   *  keep the claim and destroy the receipt.
   *
   *  It is also what stops the delete diff re-firing: a disconnected row is
   *  omitted from `listContactSourceBlobHashes`, so it never re-enters the
   *  absence diff as "prior but not polled" on every subsequent cycle.
   *
   *  Cleared on re-upsert — a record that comes back is connected again. */
  disconnected_at: number | null;
}

/** Input for `upsertContactSourceBlob`. `id` + `created_at` set by storage. */
export interface ContactSourceBlobInput {
  contact_id: string;
  /** WHO — required. See `ContactSourceBlobRecord.source_id`. */
  source_id: string;
  vendor: string;
  remote_id: string;
  blob: unknown;
  snapshot_hash: string;
  as_of?: number;
  /** Test override. Production callers omit. */
  id?: string;
  /** Test override. Production callers omit. */
  created_at?: number;
}

// ────────────────────────────────────────────────────────────────
// C-2a — the projection resolver
// ────────────────────────────────────────────────────────────────

/** Resolve the winning contribution for ONE field from all contributions to it.
 *
 *  The ratified C-2a policy, in order:
 *    1. source-priority ladder (`manual` beats `vendor_meta` beats …)
 *    2. then recency (`as_of` desc) — a fresher assertion from the same rung wins
 *    3. then confidence (desc)
 *
 *  Returns `null` for an empty input (the field simply has no value — an absent
 *  contribution is not an empty one).
 *
 *  Determinism: the comparison is a total order (ties fall through to a stable
 *  scan that keeps the FIRST-seen winner), so the same contribution set always
 *  projects to the same value regardless of row order out of SQLite. A
 *  projection that flickered between two equally-ranked values would be worse
 *  than a wrong one — it would be unreproducible.
 *
 *  Callers pass contributions for a SINGLE kind. Mixing kinds here would compare
 *  a `title` against an `org`; `resolveContributionsByKind` does the grouping. */
export const resolveContribution = <C extends ContactContribution<unknown>>(
  contributions: ReadonlyArray<C>,
): C | null => {
  let winner: C | null = null;
  let winnerRank = UNKNOWN_SOURCE_RANK;

  for (const c of contributions) {
    if (winner === null) {
      winner = c;
      winnerRank = contactContributionRank(c.source);
      continue;
    }
    const rank = contactContributionRank(c.source);

    // 1. ladder
    if (rank !== winnerRank) {
      if (rank < winnerRank) {
        winner = c;
        winnerRank = rank;
      }
      continue;
    }
    // 2. recency
    if (c.as_of !== winner.as_of) {
      if (c.as_of > winner.as_of) {
        winner = c;
        winnerRank = rank;
      }
      continue;
    }
    // 3. confidence
    if (c.confidence > winner.confidence) {
      winner = c;
      winnerRank = rank;
    }
    // Fully tied — keep the incumbent (stable, first-seen wins).
  }

  return winner;
};

/** Group contributions by `kind` and resolve each independently — the whole
 *  projection in one pass. This is what materializes a `data.contact` row: each
 *  field independently takes its strongest assertion, so a contact can carry a
 *  hand-typed `org` AND a CRM-sourced `title` at the same time, each with its
 *  own provenance. Field-level resolution, never row-level "last writer wins". */
export const resolveContributionsByKind = <C extends ContactContribution<unknown>>(
  contributions: ReadonlyArray<C>,
): Map<string, C> => {
  const byKind = new Map<string, C[]>();
  for (const c of contributions) {
    const bucket = byKind.get(c.kind);
    if (bucket === undefined) byKind.set(c.kind, [c]);
    else bucket.push(c);
  }

  const out = new Map<string, C>();
  for (const [kind, bucket] of byKind) {
    const winner = resolveContribution(bucket);
    if (winner !== null) out.set(kind, winner);
  }
  return out;
};

// Boot-time self-validation — the ladder array and its derived rank map must
// stay in lockstep. Cheap, and it catches the one edit that would silently
// un-rank a rung (mirrors `FILE_VENDOR_DECLARATIONS`' boot check).
if (
  Object.keys(CONTACT_CONTRIBUTION_SOURCE_PRIORITY).length !==
  CONTACT_CONTRIBUTION_SOURCES.length
) {
  throw new Error(
    'CONTACT_CONTRIBUTION_SOURCE_PRIORITY is out of sync with CONTACT_CONTRIBUTION_SOURCES',
  );
}
