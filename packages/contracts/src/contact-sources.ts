/** D-192 C-2 (slice 5) — the `ContactSourceDeclaration` registry.
 *
 *  The canonical-vocabulary half of the kinds-taxonomy §0 governing rule applied
 *  to the contact SOURCE family: "for any multi-vendor family, split the design
 *  into (1) a canonical vocabulary + a declaration the shared logic is written
 *  against ONCE and (2) a thin per-vendor adapter for only what can't generalize
 *  — the API leaf, the auth flow, the byte-format." A new contact vendor is one
 *  declaration entry here + its adapter leaf, NEVER a `switch (vendor)` in the
 *  shared sync.
 *
 *  Sibling of `file-vendors.ts` (`FileVendorDeclaration`). Consumed by
 *  `runContactSourceSync` (slice 6 — reads `rung` / `import_scope` / `match_on`
 *  and VERIFIES `supplies`) and the per-vendor leaves (slice 7).
 *
 *  ⚠ Naming: `ContactSourceDeclaration` describes a declared IMPORT SOURCE (a
 *  HubSpot connection, a Google address book). It is unrelated to `ContactSource`
 *  (`contact.ts` — how a contact ROW was first created: `manual` / `email_from` /
 *  `calendar_attendee`) and to `ContactContributionSource` (`contact-contribution.ts`
 *  — the C-2a trust RUNG). The spec's ratified name is kept as-is.
 *
 *  ────────────────────────────────────────────────────────────────
 *  WHY THIS IS HAND-DECLARED, not derived from `CONNECTION_VENDOR_ENTITIES`
 *  ────────────────────────────────────────────────────────────────
 *  The spec (D-192 step 5) floated deriving each
 *  CRM vendor's field map from `CONNECTION_VENDOR_ENTITIES.meta_fields` rather
 *  than re-declaring it. **Verified against the registry: it does not work, and a
 *  naive derive would fail SILENTLY.** Of the eight canonical contact fields:
 *
 *    - `email` / `phone` — backed by a real `source_path` on all three CRMs. ✅
 *    - `name` — DERIVED on HubSpot + Salesforce (a `concat` `FieldDerivation`,
 *      first+last with an email-local-part fallback) but a plain `source_path` on
 *      Pipedrive. Derivable only by a mapper that understands BOTH shapes.
 *    - `org` — `properties.company` on HubSpot only. ABSENT on Salesforce and
 *      Pipedrive — and that is not an omission to patch: a Salesforce Contact has
 *      no `Company` field at all (that lives on Lead), so its org is a
 *      CROSS-ENTITY LINK (`AccountId` → Account.Name), and Pipedrive's is the same
 *      (`org_id`). A `source_path` is a path into ONE record; it structurally
 *      cannot express a join. There is no derivation to add.
 *    - `address` — declared on HubSpot (`:769`) + Salesforce (`:951`) as
 *      `type: 'object'` with a "DERIVED" comment but NEITHER a `source_path` NOR a
 *      `derivation`. A bare declaration with nothing behind it: `entityFieldsFromRegistry`
 *      SKIPS it (`connection-agnostic.ts:295`), and `connection-vendors.ts:1760`
 *      says so outright — "unprojected pending a compose derivation". A derive
 *      yields SILENCE, not an error. That matters more here than anywhere: `address`
 *      feeds D-138's `address_zip_country_key` blocking key, and a MISSING blocking
 *      key produces NO match rather than a wrong one — the merge detector just
 *      quietly stops seeing duplicates.
 *    - `title` / `photo` / `birthday` — carried by NO CRM entity. (HubSpot's
 *      `jobtitle` and Salesforce's `Title` exist in the vendor APIs but are not
 *      requested and not declared; see the `title` gap note on the entries below.)
 *
 *  So the derive would cover two-and-a-half of eight fields and hide the rest.
 *  Worse, the mapping it would duplicate ALREADY has two implementations: the
 *  registry's `source_path`s feed the D-194 op-step/install resolver, while the
 *  ENRICHMENT plane hand-rolls its own projection in the reconcilers
 *  (`projectHubSpotMailingAddress` / `projectSalesforceMailingAddress` →
 *  `canonicalizeMailingAddress`) — which is where the address mapping really
 *  lives, and why the registry's own comment calls unification a TODO ("Reusable,
 *  later, as the one mapping source for the D-128/129/130 reconcilers too").
 *  Deriving would make contact-hydration the THIRD consumer of a map that is
 *  already forked.
 *
 *  And a contact is not FLAT the way a file is. `FileProjection` gets away with a
 *  `Record<canonical, vendorPath>` because every file field is a scalar. A contact
 *  is multi-valued and structured — Google People returns `emailAddresses[]`,
 *  `phoneNumbers[]`, `addresses[]`, `organizations[]` with primary flags; an
 *  address is five flat vendor fields assembled into one object. No path-map can
 *  express "the primary email of N" or "compose these five into an object". The
 *  shape-wrangling MUST live in the leaf.
 *
 *  Therefore the declaration carries the FACTS the shared sync dispatches on —
 *  the trust rung, the miss policy, the join key, and WHAT THIS VENDOR CAN ACTUALLY
 *  SUPPLY — and the leaf owns the vendor's shape. `supplies` is the anti-silence
 *  device: it makes each vendor's gaps DATA (Salesforce supplies no `org`;
 *  Pipedrive supplies neither `org` nor `address`), so a missing column is a
 *  DECLARED absence rather than one discovered six months on. It is a PROMISE, and
 *  slice 6's sync verifies the leaf kept it — never a silent skip.
 *
 *  Spec: D-192 step 5; taxonomy §0 / §3c. */

import {
  CONTACT_ATTRIBUTE_KIND_SET,
  type ContactAttributeKind,
  type ContactContributionSource,
} from './contact-contribution.js';
import { CONTACT_ALIAS_KIND_SET, type ContactAliasKind } from './contact-identity.js';
import {
  CONNECTION_VENDOR_ENTITIES,
  type ConnectionVendorEntity,
} from './connection-vendors.js';

// ────────────────────────────────────────────────────────────────
// Closed enums (the declaration's controlled vocabulary)
// ────────────────────────────────────────────────────────────────

/** What to do when an imported remote contact matches NO local contact. The one
 *  axis that separates a CRM from a contact book — the MATCH logic is identical
 *  either way (resolve by `match_on`), only the MISS policy differs.
 *
 *   - `full_import`      — create the local contact. A personal contact book IS
 *     your contact list; every entry belongs in it.
 *   - `hydrate_on_match` — skip it. A 10k-row CRM is mostly strangers — people
 *     your company deals with, not people YOU know. Importing them all would
 *     drown the personal contact graph. So a CRM record only ever ENRICHES a
 *     contact Recued already knows about. */
export const CONTACT_IMPORT_SCOPES = ['full_import', 'hydrate_on_match'] as const;
export type ContactImportScope = (typeof CONTACT_IMPORT_SCOPES)[number];
export const CONTACT_IMPORT_SCOPE_SET: ReadonlySet<string> = new Set(CONTACT_IMPORT_SCOPES);

// ────────────────────────────────────────────────────────────────
// D-205 #2c — per-Source health, as it crosses the wire
// ────────────────────────────────────────────────────────────────

/** What one sync cycle actually DID — the runner's counts.
 *
 *  ⚠ **Lives HERE, not in the store, because it now crosses the WIRE** (D-205 #2c's
 *  `contact.source.list`), and `packages/` can never import from `backend/`. The
 *  store re-exports it, so its existing importers are unchanged; there is still
 *  exactly one definition. `ContactSourceSyncResult` is declared as an INTERSECTION
 *  with this, which is the guarantee that matters: **add a counter and it must be
 *  persisted, or it does not compile.**
 *
 *  ⚠ A cycle can be `ok: true` and still be DEGRADED — `failed_rows`, `unkeyable`
 *  and `mirror_failed` are COUNTED, never thrown, because one malformed vendor
 *  payload must not abort a walk over ten thousand records. That is exactly why they
 *  must be persisted AND read: an exception announces itself, a counter returned into
 *  the void does not. Before #2c these twelve had one writer and ZERO readers. */
export interface ContactSourceCycleCounts {
  /** Records whose contributions were written / refreshed. */
  hydrated: number;
  /** Records the hash-skip proved unchanged (no re-write, no re-materialize). */
  unchanged: number;
  /** Records that matched NO local contact — the `hydrate_on_match` miss. NOT a
   *  failure: a CRM is mostly strangers, so this is the common case and the whole
   *  point of the posture. A Source where this is 100% is worth a look, though.
   *
   *  ⚠ Always 0 for a `full_import` Source: it does not skip strangers, it creates
   *  them (see `created`). A contact book reporting `skipped` would be a bug. */
  skipped: number;
  /** D-205 #4 — contacts this cycle MINTED (`full_import` create-on-miss). Always
   *  0 for a CRM.
   *
   *  🔑 **The counter to watch on a contact book, and the one that catches the
   *  worst bug this posture can have.** An entry with no address can never match
   *  (the runner resolves addresses only), so it is a miss on EVERY cycle — and a
   *  create-on-miss that trusted the match alone would mint the same person again
   *  and again, forever. Re-identification rides the mirror's stable `remote_id`.
   *  So `created` should be large on the FIRST cycle and ~0 on every one after; a
   *  Source that keeps creating is duplicating your contact book, not importing it. */
  created: number;
  /** D-205 #4 — contacts whose synthetic placeholder was RE-KEYED to a real
   *  address this cycle (the dentist finally emailed you). Always 0 for a CRM. */
  promoted: number;
  /** Remote records DISCONNECTED — gone from a COMPLETE walk, so their link was cut
   *  and their blob soft-marked. Nothing was withdrawn (D-205 §1). */
  disconnected: number;
  /** 🔴 Records that failed the `supplies` promise or could not be written. **The
   *  headline failure.** A leaf that forgot a promised kind fails every record, so
   *  this equals the record count and the Source is doing nothing at all. */
  failed_rows: number;
  /** 🔴 Records carrying no keyable `remote_id` — this also POISONS the delete proof
   *  for the cycle (a record we cannot key is a record we cannot prove absent), so
   *  the Source silently stops reconciling deletions. */
  unkeyable: number;
  /** Records that lost a same-contact tiebreak to a fresher sibling — the CRM holds
   *  more than one record for one person. Mirrored, but not contributed from. */
  ambiguous: number;
  /** Records whose email is already attached to a DIFFERENT local contact — a merge
   *  signal, not an error. */
  conflicted: number;
  /** Records that now match a DIFFERENT local contact than the mirror had them on. */
  repointed: number;
  /** 🔴 Records whose raw payload could not be mirrored. The mirror feeds BOTH the
   *  hash-skip and the delete diff, so a systematic mirror failure makes every cycle
   *  re-hydrate everything from scratch, forever, while still reporting success. */
  mirror_failed: number;
  /** Contacts LINKED to their platform record. */
  linked: number;
  /** The walk's positive completeness proof (the delete-diff gate). `false` means
   *  the leaf could not prove it saw everything, so NOTHING was disconnected this
   *  cycle — fail-closed, and worth seeing. */
  complete: boolean;
}

/** D-205 #5 — one CRM record the user could pull into their contact graph, as
 *  `contact.import.candidates` returns it.
 *
 *  A **STRANGER**: a record this Source mirrors that matches no local contact. These
 *  are exactly the records the sync counts as `skipped` — the `hydrate_on_match`
 *  misses — and they are the 9,988 in *"HubSpot: 10,000 records, 12 of whom you have
 *  corresponded with"*. Nothing here is imported; it is a picker over data the
 *  reconcilers already mirrored, and the user decides who is theirs.
 *
 *  ⚠ The fields are the CRM's canonical `EnrichmentMeta`, NOT a `ContactRecord`.
 *  These people are not contacts and must not be rendered as if they were — the
 *  whole point of the surface is that Recued does NOT know them. */
export interface ContactImportCandidate {
  /** `CrmRecordMirrorRow.target_id` — what `contact.import.promote` takes back. */
  target_id: string;
  /** The CRM's email. **Never empty**: a record without one is not a candidate at
   *  all (the runner keys identity on the address space, and the mirror carries no
   *  phone-keyed identity to fall back on), so it is filtered out rather than
   *  offered and then refused. */
  email: string;
  name?: string;
  company?: string;
  phone?: string;
}

/** D-205 #5c — one CONFLICT between an uploaded file and what Recued already shows.
 *
 *  🔑 **This is the entire review surface, and it is deliberately the ONLY one.** An
 *  upload writes at the `manual` rung, which is the TOP of the C-2a ladder — nothing
 *  can ever correct it. That is right when you TYPE a value; it is a foot-gun when you
 *  upload a stale export you never opened, because those values would silently freeze
 *  the graph and your live CRM could never fix them.
 *
 *  So the plan splits exactly where the risk does: an ADD has nothing to overwrite and
 *  needs no review, and agreement is a no-op. A DISAGREEMENT with a value the user can
 *  see today is the only thing worth their attention — and it is opt-in. */
export interface ContactImportFileChange {
  /** The contact this file entry resolved to. */
  email: string;
  name: string;
  /** 1-based line (vCard) / row (CSV) — so the user can find it in their file. */
  line: number;
  /** ⚠ `from` is what the contact currently PROJECTS — what is on screen — not their
   *  previous manual value. If HubSpot supplies the phone today and the file
   *  disagrees, applying it changes what they SEE, and the review must say so. */
  fields: ReadonlyArray<{ field: string; from: string; to: string }>;
}

/** The plan a `contact.import.file_preview` returns. Purely derived — no writes, no
 *  server state between the two rpcs: `apply` re-parses the SAME bytes and re-derives
 *  the SAME plan, so the client cannot hand back one it edited. */
export interface ContactImportFilePlan {
  format: 'vcard' | 'csv';
  /** People Recued does not know. Nothing to overwrite ⇒ nothing to review. */
  adds: number;
  /** The file agrees with what Recued already shows. Counted, so the user can see the
   *  import was mostly agreement rather than wondering what it did. */
  unchanged: number;
  /** The conflicts. THIS is the review. */
  changes: ReadonlyArray<ContactImportFileChange>;
  /** Rows the parser could not use, verbatim. **Never silently dropped** — a row that
   *  vanishes is a person missing from the graph, and the user would have no way to
   *  know. */
  errors: ReadonlyArray<string>;
}

/** One contact Source's health, as `contact.source.list` returns it: the registry
 *  row joined to its sync-state row.
 *
 *  The three 🔴 counters (`failed_rows` / `unkeyable` / `mirror_failed`) are the
 *  reason this exists. Before #2c, the ONLY thing anything read off a contact
 *  Source's health was a single boolean (`source_freshness_degradation` selects
 *  `last_success_at, degraded` and nothing else) — so a leaf that failed every
 *  record on every cycle collapsed to `degraded: true` with no way to see WHY. */
export interface ContactSourceHealth {
  /** `CONNECTION_SOURCE_ID(vendor, connection_id, 'contact')` — e.g.
   *  `hubspot.my-hubspot.contact`. */
  source_id: string;
  /** Human-readable, pre-composed by the boot wire as
   *  `${declaration.display_name} (${connection.name})` — e.g. "HubSpot (work)".
   *  ⚠ Read this; do NOT re-parse `source_id`. */
  source_label: string;
  /** A disabled Source is not a broken one — it simply is not running. */
  enabled: boolean;
  /** The last CLEAN cycle. A DEGRADED cycle does not bump it, so a broken Source
   *  reads stale however recently it ran. Null = never synced. */
  last_success_at: number | null;
  /** The last cycle failed, or walked but could not do so cleanly. */
  degraded: boolean;
  /** `degraded` OR never-synced OR older than `stale_after_ms`. */
  stale: boolean;
  last_error_code: string | null;
  /** The failure IN WORDS, carrying the runner's failure SAMPLES. "12 record(s)
   *  failed … — hs_1: attributes.address promised by the declaration but absent" is
   *  a bug report; `degraded: true` is a shrug. Long (~500 chars) and deliberately
   *  passed through VERBATIM: it is assembled from structure the writer already
   *  destroyed, so re-parsing it into fields would be a lossy reconstruction. */
  last_error_message: string | null;
  /** The last cycle that actually WALKED. Null when none ever has — a Source refused
   *  at the config gate never produces counts, which is itself the diagnosis. */
  last_cycle: ContactSourceCycleCounts | null;
}

/** The C-2a ladder rungs an IMPORTER is allowed to write — a deliberate SUBSET of
 *  `CONTACT_CONTRIBUTION_SOURCES`, and the structural guarantee that no import can
 *  ever outrank a hand edit.
 *
 *  The four excluded rungs are excluded for two different reasons:
 *   - `manual` / `user_confirmed` are the USER's rungs. An importer writing
 *     `manual` would park a vendor's value at the TOP of the ladder where the
 *     user's own typing could never correct it — the precise data loss C-2b's
 *     rejected `legacy` rung would have caused, one door over.
 *   - `derived` / `ai_inferred` / `domain_inferred` are RECUED's own writers
 *     (warehouse traffic, a model, the domain guess). `contributionSourceIdForRung`
 *     says it outright: "any rung an IMPORTER writes carries its own
 *     `SourceRegistration.id` and never comes through here."
 *
 *  Which leaves exactly the two import rungs — a curated platform record
 *  (`vendor_meta`) and a personal contact book (`contact_book`, ranked BELOW it:
 *  contact books rot, CRMs are curated — just not by this human).
 *
 *  ⚠ `satisfies readonly ContactContributionSource[]` is the tripwire: rename a
 *  rung on the ladder and this fails to COMPILE rather than drifting. */
export const CONTACT_IMPORT_RUNGS = [
  'vendor_meta',
  'contact_book',
] as const satisfies readonly ContactContributionSource[];
export type ContactImportRung = (typeof CONTACT_IMPORT_RUNGS)[number];
export const CONTACT_IMPORT_RUNG_SET: ReadonlySet<string> = new Set(CONTACT_IMPORT_RUNGS);

/** The identifier kinds that can KEY a local match — a subset of `ContactAliasKind`.
 *
 *  Matchability is a property of the KIND, not of the vendor: `email_alias` and
 *  `phone_alias` are the only two with a contact-store lookup behind them
 *  (`contactByAnyEmail` — the slice-4 address space — and the trigger-maintained
 *  `contact_phone_forms` index). A `chat_alias` or a `platform_id` identifies a
 *  person on ANOTHER surface; neither has a resolver, so keying on one would match
 *  zero contacts forever without ever erroring — indistinguishable from "the source
 *  had no matches", which is the worst failure mode in this family.
 *
 *  Closed at the TYPE level (`match_on: ReadonlyArray<ContactMatchKeyKind>`) so the
 *  mistake cannot even be written, with the runtime set as the floor for values
 *  that cross a boundary. */
export const CONTACT_MATCH_KEY_KINDS = [
  'email_alias',
  'phone_alias',
] as const satisfies readonly ContactAliasKind[];
export type ContactMatchKeyKind = (typeof CONTACT_MATCH_KEY_KINDS)[number];
export const CONTACT_MATCH_KEY_KIND_SET: ReadonlySet<string> = new Set(CONTACT_MATCH_KEY_KINDS);

// ────────────────────────────────────────────────────────────────
// The declaration shape
// ────────────────────────────────────────────────────────────────

/** What a vendor's leaf CAN contribute — the anti-silence device.
 *
 *  Not a field MAP (the leaf owns the vendor's shape — see the module header) but
 *  a PROMISE, in the contribution vocabulary the stores already speak: which
 *  `contact_alias` kinds and which `contact_attribute` kinds this vendor's records
 *  actually carry. Slice 6's sync reads it to verify the leaf delivered what it
 *  declared, so a leaf that quietly stops emitting `address` FAILS instead of
 *  draining a D-138 blocking key to NULL.
 *
 *  A gap here is a STATEMENT ("Salesforce contacts carry no company"), not an
 *  oversight — which is the whole point of writing it down. */
export interface ContactSupplies {
  /** Identifier contributions (`contact_alias`). Never empty — a source that
   *  supplies no identifier cannot attach its records to a person at all. */
  aliases: ReadonlyArray<ContactAliasKind>;
  /** Descriptive contributions (`contact_attribute`). May be empty (an
   *  identity-only source is coherent). */
  attributes: ReadonlyArray<ContactAttributeKind>;
}

/** One contact source declaration — the canonical vocabulary a new contact vendor
 *  joins the family through (§0). The `vendor` slug is the registry key AND the
 *  backend adapter-leaf key.
 *
 *  ⚠ There is deliberately NO `auth` field (its `FileVendorDeclaration` twin has
 *  one). Every contact Source declared today RIDES AN ALREADY-ENROLLED D-125
 *  connection — that is exactly what `CONNECTION_SOURCE_ID(vendor,
 *  connection_name, 'contact')` encodes — so the field would carry one constant
 *  value and have no reader. It earns its place when the contact books land
 *  (slice 7) and bring real variance: a new Google People OAuth scope, CardDAV
 *  basic-auth. This arc has been burned four times by declarations with nothing
 *  behind them; this is not the fifth. */
export interface ContactSourceDeclaration {
  /** Lowercase vendor slug — `/^[a-z][a-z0-9_]*$/`. Matches the D-125 connection
   *  vendor, so `CONNECTION_SOURCE_ID` composes a Source id from it. */
  vendor: string;
  /** Human-readable label (settings UI + validator error messages). */
  display_name: string;
  /** The C-2a rung EVERY contribution from this source carries. */
  rung: ContactImportRung;
  /** The miss policy — what happens when a remote record matches no local contact. */
  import_scope: ContactImportScope;
  /** The `CONNECTION_VENDOR_ENTITIES` entity this hydrates FROM (`contact` on
   *  HubSpot/Salesforce, `person` on Pipedrive) — the registry row that supplies
   *  the vendor's record id + the `email` join key. `null` for a source with no
   *  platform-record entity (a contact book; none declared yet — see the registry
   *  note). Validated to EXIST and to be `crm_alias: 'contact'`: hydrating a person
   *  from a `deal` entity is a typo the boot check should catch, not a runtime
   *  surprise. */
  vendor_entity: string | null;
  /** What this vendor's leaf can contribute. A promise, verified in slice 6. */
  supplies: ContactSupplies;
  /** Which identifier kinds KEY a local match. Non-empty, and a subset of
   *  `supplies.aliases` — matching on an identifier you never import silently
   *  imports nothing. Typed to `ContactMatchKeyKind`, so a `chat_alias` join key
   *  cannot be written at all (see that type).
   *
   *  Every entry today is `email_alias` alone, and deliberately: email is the
   *  address space (slice 4 — `contactByAnyEmail` resolves any known address to
   *  the contact that OWNS it), and both CRM registries call it "the primary join
   *  key against `data.contact.<email>`". Phone-keyed hydration is a real future
   *  capability (`contact_phone_forms` + the D-138 predicate both exist) but has
   *  no hydration resolver behind it today — and `match_on` is a promise like
   *  `supplies` is. Slice 6 owns widening it. */
  match_on: ReadonlyArray<ContactMatchKeyKind>;
}

// ────────────────────────────────────────────────────────────────
// Validation (hoisted above the registry initializer)
// ────────────────────────────────────────────────────────────────

/** Same lowercase identifier rule the connection- / messenger- / file-vendor
 *  registries use (one grammar across the codebase). */
const CONTACT_VENDOR_REGEX = /^[a-z][a-z0-9_]*$/;

/** Validate a `ContactSupplies` sub-object. Returns issue strings prefixed with
 *  `supplies.<axis>`. */
const assertSuppliesAxis = (
  raw: unknown,
  axis: 'aliases' | 'attributes',
  kindSet: ReadonlySet<string>,
  allowEmpty: boolean,
): string[] => {
  const issues: string[] = [];
  if (!Array.isArray(raw)) {
    issues.push(`supplies.${axis} must be an array`);
    return issues;
  }
  if (!allowEmpty && raw.length === 0) {
    issues.push(
      `supplies.${axis} must be non-empty — a source that supplies no identifier cannot attach its records to any person`,
    );
  }
  const seen = new Set<string>();
  for (const k of raw as unknown[]) {
    if (typeof k !== 'string' || !kindSet.has(k)) {
      issues.push(`supplies.${axis} contains an unknown kind '${String(k)}'`);
      continue;
    }
    if (seen.has(k)) issues.push(`supplies.${axis} lists '${k}' twice`);
    seen.add(k);
  }
  return issues;
};

/** Strict per-entry shape validator — PURE (no cross-registry lookups; see
 *  `assertContactSourceVendorBinding` for those). Returns issue strings (empty
 *  when the entry is well-formed). `buildContactSourceDeclaration` throws on a
 *  non-empty result so a misconfigured entry surfaces at module load, not at the
 *  first sync. Mirrors `assertFileVendorDeclarationShape`. */
export function assertContactSourceDeclarationShape(entry: unknown): string[] {
  const issues: string[] = [];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return ['expected object'];
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.vendor !== 'string' || !CONTACT_VENDOR_REGEX.test(e.vendor)) {
    issues.push(`field 'vendor' must match ${CONTACT_VENDOR_REGEX.source}`);
  }
  if (typeof e.display_name !== 'string' || e.display_name.length === 0) {
    issues.push("field 'display_name' must be a non-empty string");
  }

  // rung — an IMPORT rung, never a user rung. The structural guarantee that no
  // import can outrank a hand edit.
  if (typeof e.rung !== 'string' || !CONTACT_IMPORT_RUNG_SET.has(e.rung)) {
    issues.push(
      `field 'rung' must be one of ${CONTACT_IMPORT_RUNGS.join(
        ' / ',
      )} — an importer may never write a user rung (manual / user_confirmed) or one of Recued's own (derived / ai_inferred / domain_inferred)`,
    );
  }

  if (typeof e.import_scope !== 'string' || !CONTACT_IMPORT_SCOPE_SET.has(e.import_scope)) {
    issues.push(`field 'import_scope' must be one of ${CONTACT_IMPORT_SCOPES.join(' / ')}`);
  }

  if (e.vendor_entity !== null) {
    if (typeof e.vendor_entity !== 'string' || !CONTACT_VENDOR_REGEX.test(e.vendor_entity)) {
      issues.push(`field 'vendor_entity' must be null or match ${CONTACT_VENDOR_REGEX.source}`);
    }
  }

  // supplies — the promise.
  let supplyAliases: ReadonlyArray<string> | null = null;
  if (e.supplies === null || typeof e.supplies !== 'object' || Array.isArray(e.supplies)) {
    issues.push("field 'supplies' must be an object");
  } else {
    const s = e.supplies as Record<string, unknown>;
    issues.push(...assertSuppliesAxis(s.aliases, 'aliases', CONTACT_ALIAS_KIND_SET, false));
    issues.push(
      ...assertSuppliesAxis(s.attributes, 'attributes', CONTACT_ATTRIBUTE_KIND_SET, true),
    );
    if (Array.isArray(s.aliases)) {
      supplyAliases = s.aliases.filter((a): a is string => typeof a === 'string');
    }
  }

  // match_on — non-empty, MATCHABLE kinds, and a SUBSET of supplies.aliases.
  if (!Array.isArray(e.match_on)) {
    issues.push("field 'match_on' must be an array");
  } else {
    if (e.match_on.length === 0) {
      issues.push(
        "field 'match_on' must be non-empty — a source with no join key matches nothing and would import silently into the void",
      );
    }
    const seen = new Set<string>();
    for (const k of e.match_on as unknown[]) {
      // Matchability is a property of the KIND, so it is checked HERE, for every
      // source — not in the vendor binding, which a contact book (vendor_entity:
      // null) skips entirely. A `chat_alias` join key has no resolver behind it on
      // a CRM or a contact book alike.
      if (typeof k !== 'string' || !CONTACT_MATCH_KEY_KIND_SET.has(k)) {
        issues.push(
          `match_on '${String(k)}' cannot key a match — only ${CONTACT_MATCH_KEY_KINDS.join(
            ' / ',
          )} have a contact-store resolver; any other kind would silently match zero contacts`,
        );
        continue;
      }
      if (seen.has(k)) issues.push(`match_on lists '${k}' twice`);
      seen.add(k);
      // Only meaningful when supplies.aliases actually parsed — otherwise every
      // join key would draw a second, misleading "you never import this" error.
      if (supplyAliases !== null && !supplyAliases.includes(k)) {
        issues.push(
          `match_on '${k}' is not in supplies.aliases — matching on an identifier the source never imports would silently import nothing`,
        );
      }
    }
  }

  return issues;
}

/** Throwing wrapper — entries run through `build*` so misconfiguration surfaces at
 *  module load. */
export function assertContactSourceDeclarationValid(entry: ContactSourceDeclaration): void {
  const issues = assertContactSourceDeclarationShape(entry);
  if (issues.length > 0) {
    throw new Error(
      `invalid ContactSourceDeclaration '${String(
        (entry as { vendor?: unknown }).vendor,
      )}': ${issues.join('; ')}`,
    );
  }
}

/** Build + validate one declaration. Keeps the registry literal honest (a typo in
 *  a rung / scope / kind throws at load). Mirrors `buildFileVendorDeclaration`. */
export function buildContactSourceDeclaration(
  input: ContactSourceDeclaration,
): ContactSourceDeclaration {
  assertContactSourceDeclarationValid(input);
  return input;
}

/** Cross-registry binding check — the half `assertContactSourceDeclarationShape`
 *  cannot do, because it needs `CONNECTION_VENDOR_ENTITIES`.
 *
 *  This is where the join key stops being a hopeful string. A declaration that
 *  says "match on `email_alias`" against a vendor entity that declares no
 *  projectable `email` meta-field would hydrate exactly ZERO contacts, forever,
 *  without erroring — the single worst failure mode in this family, because it is
 *  indistinguishable from "the CRM had no matches". So the join key must be BACKED
 *  by a real `source_path` on the entity it claims to read, and a fourth CRM
 *  vendor that forgets one fails at BOOT. */
export function assertContactSourceVendorBinding(
  entry: ContactSourceDeclaration,
  vendorRegistry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): string[] {
  // An address book has no platform-record entity — nothing to bind.
  if (entry.vendor_entity === null) return [];

  const issues: string[] = [];
  const found = vendorRegistry.find(
    (v) => v.vendor === entry.vendor && v.entity === entry.vendor_entity,
  );
  if (found === undefined) {
    issues.push(
      `vendor_entity '${entry.vendor_entity}' is not declared in CONNECTION_VENDOR_ENTITIES for vendor '${entry.vendor}'`,
    );
    return issues;
  }
  if (found.crm_alias !== 'contact') {
    issues.push(
      `vendor_entity '${entry.vendor_entity}' has crm_alias '${String(
        found.crm_alias,
      )}' — a contact source must hydrate from a contact-aliased entity, not a deal/account one`,
    );
  }

  // The join key must be BACKED by a real projectable field on that entity — a
  // `source_path` or a `derivation`. A bare declaration with neither (the
  // `mailing_address` shape) does NOT count: `entityFieldsFromRegistry` skips it,
  // so nothing can actually read it.
  const backs = (key: string): boolean =>
    found.meta_fields.some(
      (f) => f.key === key && (f.source_path !== undefined || f.derivation !== undefined),
    );
  // Exhaustive over the closed `ContactMatchKeyKind` — the compiler now requires an
  // arm per matchable kind, so widening that union cannot silently leave a join key
  // unmapped. The `?? undefined` floor still stands for a value that crossed a
  // boundary (a persisted row) and never met the type.
  const JOIN_KEY_META_FIELD: Readonly<Record<ContactMatchKeyKind, string>> = {
    email_alias: 'email',
    phone_alias: 'phone',
  };
  for (const k of entry.match_on) {
    const metaKey: string | undefined = JOIN_KEY_META_FIELD[k];
    // Unmatchable kinds are rejected by the shape validator (matchability is a
    // property of the kind, not the vendor) — this is only the runtime floor.
    if (metaKey === undefined) continue;
    if (!backs(metaKey)) {
      issues.push(
        `match_on '${k}' requires a projectable '${metaKey}' meta-field on ${entry.vendor}.${entry.vendor_entity}, which declares none — hydration would silently match zero contacts`,
      );
    }
  }

  return issues;
}

/** Cross-entry registry validator — per-entry shape + a duplicate `vendor` slug.
 *  SELF-CONTAINED (no cross-registry reach); this is what the boot check runs.
 *  Mirrors `assertFileVendorRegistry`. */
export function assertContactSourceRegistry(
  registry: ReadonlyArray<ContactSourceDeclaration>,
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  registry.forEach((entry, idx) => {
    for (const i of assertContactSourceDeclarationShape(entry)) issues.push(`[${idx}] ${i}`);
    if (seen.has(entry.vendor)) {
      issues.push(`[${idx}] duplicate vendor '${entry.vendor}' — only one entry per vendor allowed`);
    } else {
      seen.add(entry.vendor);
    }
  });
  return issues;
}

/** The cross-registry half — every entry's `assertContactSourceVendorBinding`.
 *
 *  ⚠ **Deliberately NOT part of the boot check**, unlike the shape + dup guard
 *  above. This one reaches into a registry another feature owns
 *  (`CONNECTION_VENDOR_ENTITIES`), so hanging a module-load `throw` on it would let
 *  an unrelated D-194 edit — dropping the `email` meta-field from
 *  `salesforce.contact`, renaming Pipedrive's `person` entity — fail EVERY import of
 *  `packages/contracts`: server boot, the webclient build, every test. That is wildly
 *  disproportionate to the thing being protected (a contact sync that would hydrate
 *  nothing).
 *
 *  So the binding is enforced at the two places where it is actionable and its blast
 *  radius is the contact family alone:
 *   - **CI** — the slice-5 test asserts it over the LIVE registry, so the breaking
 *     edit is caught before it merges.
 *   - **slice 6** — `runContactSourceSync` calls it per source at sync start and
 *     fails THAT source loudly (fail-closed: hydrate nothing, surface the reason),
 *     rather than taking the process down. */
export function assertContactSourceRegistryBinding(
  registry: ReadonlyArray<ContactSourceDeclaration>,
  vendorRegistry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): string[] {
  const issues: string[] = [];
  registry.forEach((entry, idx) => {
    for (const i of assertContactSourceVendorBinding(entry, vendorRegistry)) {
      issues.push(`[${idx}] ${i}`);
    }
  });
  return issues;
}

// ────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────

/** D-192 C-2 — the contact source registry.
 *
 *  **The three CRM vendors, and only those.** Each has a real
 *  `CONNECTION_VENDOR_ENTITIES` contact entity, a real D-125 provider, and a
 *  verifiable set of supplies — so every fact below is READ OFF the substrate, not
 *  guessed. Together they make the dead CRM contact path real (slice 7): no CRM
 *  reconciler touches the contact store today, so CRM contacts currently neither
 *  hydrate NOR link, and `resolveCompanyForDomain` has zero production callers.
 *
 *  ✅ **D-205 #4 — `google` (Google Contacts) has LANDED: the first `full_import`
 *  source, and the first entry here that is not a CRM.** It arrived the way this
 *  note demanded — in the same commit as its leaf, with `supplies` read off a field
 *  map that actually exists (the `google-contacts` pack's `entities.person`) rather
 *  than off an API nobody had opened.
 *
 *  ⚠ The note used to say the OAuth scopes "do not even ask for contacts", and that
 *  was TRUE of `GOOGLE_PROVIDER` and IRRELEVANT to this. A pack's `required_scopes`
 *  are UNIONed into the enroll request **per installed pack**
 *  (`installedPackScopeUnion`), so installing the contact book asks for
 *  `contacts.readonly` without widening the Drive scope floor for anyone who did
 *  not install it. There was never a second vendor slug to mint.
 *
 *  ⚠ **MS Graph and CardDAV are still DELIBERATELY ABSENT**, for the original
 *  reason: neither has an adapter leaf, and `supplies` is a PROMISE the runner
 *  VERIFIES per record. Promising the shape of an API nobody has read fails EVERY
 *  record on the FIRST cycle — which is the failure this registry exists to make
 *  loud, not the one it exists to hide. They land with their leaves.
 *
 *  ⚠ **`platform_id` is NOT in any `supplies.aliases` below, and that is not an
 *  oversight.** `contact_alias`'s `platform_id` kind is the SOCIAL-handle axis —
 *  `CONTACT_ALIAS_PLATFORMS` is a closed list (facebook / x / instagram / linkedin
 *  / github / substack) with no CRM vendors in it, so a CRM record id cannot be
 *  expressed as one. The CRM record LINK is a different substrate:
 *  `PlatformIdEntry` / `contact_platform_link` (`{ vendor, platform_id, state }`),
 *  which slice 7 writes from the entity's `id` meta-field. Two mechanisms, one
 *  confusingly-shared word.
 *
 *  ⚠ **`title` is supplied by nobody, on purpose.** HubSpot's `jobtitle` and
 *  Salesforce's `Title` are real vendor properties, but neither is declared as a
 *  meta-field nor requested by the reconcilers' property lists — so promising
 *  `title` here would be promising a value no code can produce. Closing it is a
 *  priced, visible step (a `CONNECTION_VENDOR_ENTITIES` meta-field + the
 *  reconciler's property list + the enrichment snapshot shape), not something to
 *  discover as an empty column. `photo` / `birthday` are the same, minus the
 *  vendor field: CRMs carry neither. They are what an ADDRESS BOOK is for. */
export const CONTACT_SOURCE_DECLARATIONS: ReadonlyArray<ContactSourceDeclaration> = [
  buildContactSourceDeclaration({
    vendor: 'hubspot',
    display_name: 'HubSpot Contacts',
    // A CRM record is curated by a human — just not THIS human. Below the user's
    // own rungs, above a contact book.
    rung: 'vendor_meta',
    // A 10k-row CRM is mostly strangers: enrich people Recued already knows,
    // never import the whole book into the personal contact graph.
    import_scope: 'hydrate_on_match',
    vendor_entity: 'contact',
    supplies: {
      // `properties.email` + `properties.phone` — both real `source_path`s.
      aliases: ['email_alias', 'phone_alias'],
      // `name`  — the registry's `concat` derivation (firstname + lastname, with an
      //           email-local-part fallback).
      // `org`   — `properties.company`, the contact-level company STRING (distinct
      //           from `associatedcompanyid`, which is the company LINK). HubSpot is
      //           the only CRM of the three that carries one.
      // `address` — NOT registry-backed (the `mailing_address` meta-field is a bare
      //           declaration with no `source_path` and no `derivation`). The mapping
      //           the leaf must reuse is `projectHubSpotMailingAddress` in
      //           `data/hubspot/contact-reconciler.ts` — flat `properties.{address,
      //           address2,city,state,zip,country}` → `canonicalizeMailingAddress`.
      attributes: ['name', 'org', 'address'],
    },
    match_on: ['email_alias'],
  }),
  buildContactSourceDeclaration({
    vendor: 'salesforce',
    display_name: 'Salesforce Contacts',
    rung: 'vendor_meta',
    import_scope: 'hydrate_on_match',
    vendor_entity: 'contact',
    supplies: {
      // `Email` + `Phone` — both real `source_path`s.
      aliases: ['email_alias', 'phone_alias'],
      // `name`    — the registry's `concat` derivation (FirstName + LastName).
      // `address` — NOT registry-backed; the leaf reuses
      //             `projectSalesforceMailingAddress` (`Mailing{Street,City,State,
      //             PostalCode,Country}` → `canonicalizeMailingAddress`).
      //
      // ⚠ NO `org`, and this is a STATEMENT, not a gap to fill later: a Salesforce
      // Contact has no `Company` field at all (that lives on Lead). Its org is a
      // CROSS-ENTITY LINK — `AccountId` → `salesforce.account.name` — which no
      // `source_path` can express, since a path reads ONE record. Resolving it needs
      // a join the contact family does not do today. Declaring `org` here would
      // quietly project an empty column.
      attributes: ['name', 'address'],
    },
    match_on: ['email_alias'],
  }),
  buildContactSourceDeclaration({
    // D-205 #4 — the FIRST `full_import` source, and the first that is not a CRM.
    //
    // ⚠ Vendor `google`, not `google_contacts`. One vendor slug, N api_bases + N
    // named connections is the established pattern across the Google pack family
    // (`gdrive` → drive/v3, `google-calendar` → calendar/v3, `google-sheets` →
    // sheets/v4, this → people.googleapis.com), and the pack's `required_scopes`
    // are UNIONed into the enroll request per INSTALLED PACK
    // (`installedPackScopeUnion`). So enrolling a contact book asks for
    // `contacts.readonly` WITHOUT touching `GOOGLE_PROVIDER`'s scope floor — a
    // Drive-only user is never asked for their contacts.
    vendor: 'google',
    display_name: 'Google Contacts',
    // A contact book is YOUR list, curated by you — but it ROTS (a phone number
    // outlives the job it belonged to), so it sits BELOW a CRM and ABOVE anything
    // Recued merely derived from traffic.
    rung: 'contact_book',
    // 🔑 The posture that makes this vendor exist. Every entry is someone you
    // CHOSE to keep — including the dentist, who has never emailed you and never
    // will. Not importing him means Recued does not know your contacts.
    import_scope: 'full_import',
    // ⚠ NULL, and load-bearing. A contact book has no platform-record entity: it
    // IS the record. This is what makes `assertContactSourceVendorBinding`
    // early-return, so the runner's step-1 bind gate (which reads the FROZEN
    // `CONNECTION_VENDOR_ENTITIES`) never fires for it — a CRM-shaped check on a
    // thing that is not a CRM.
    vendor_entity: null,
    supplies: {
      // People returns `emailAddresses[]` / `phoneNumbers[]` — genuinely
      // multi-valued, and the leaf contributes EVERY one of them (that is the
      // slice-4 address space working as designed, and #3.5b is what makes those
      // extra addresses readable in reverse).
      aliases: ['email_alias', 'phone_alias'],
      // `name`    — `names[]`, primary-flag preferred.
      // `org`     — `organizations[].name`.
      // `address` — `addresses[]` composed into a canonical `MailingAddress`;
      //             this is what feeds D-138's `address_zip_country_key` blocking
      //             key, so a leaf that quietly stopped emitting it would drain the
      //             merge detector rather than error. Hence the promise.
      // `photo`   — `photos[].url`. A URL, never bytes (C-2's North star), and the
      //             detail page renders it as TEXT for exactly that reason.
      //
      // ⚠ NO `birthday` and NO `title`, and both are STATEMENTS rather than gaps.
      // The People API carries both — but the PACK's `entities.person` field map
      // declares neither, so nothing can produce them today. `supplies` is a
      // PROMISE the runner verifies per record: promising a field no code emits
      // fails EVERY record on the FIRST cycle. Adding them is a visible two-line
      // pack edit + a line here, not a discovery six months on.
      attributes: ['name', 'org', 'address', 'photo'],
    },
    // Email only. `phone_alias` is in `supplies` (we import every number) but is
    // NOT a join key: the runner has no phone→contact resolver, and it REFUSES a
    // cycle keyed on one rather than match zero contacts in silence.
    match_on: ['email_alias'],
  }),
  buildContactSourceDeclaration({
    vendor: 'pipedrive',
    display_name: 'Pipedrive People',
    rung: 'vendor_meta',
    import_scope: 'hydrate_on_match',
    // Pipedrive's contact entity is named `person` (crm_alias: 'contact').
    vendor_entity: 'person',
    supplies: {
      // `emails.0.value` + `phones.0.value` — the FIRST of each array. Pipedrive is
      // genuinely multi-valued upstream and the registry projects only the first;
      // a leaf that wants the rest reads the raw record (it is mirrored verbatim in
      // `contact_source_blob`), which is precisely the multi-email case the
      // `email_alias` address space (slice 4) was built to hold.
      aliases: ['email_alias', 'phone_alias'],
      // `name` — a plain `source_path` here, NOT a derivation (Pipedrive stores a
      // single `name` field). The one vendor of the three whose name needs no concat.
      //
      // ⚠ NO `org` (an `org_id` LINK, same as Salesforce) and NO `address`
      // (Pipedrive's `person` declares no `mailing_address` meta-field at all — not
      // even the phantom the other two carry). Pipedrive also has NO reconciler
      // (`data/pipedrive/` does not exist), so its leaf is the thinnest of the three
      // and has no existing projection to reuse.
      attributes: ['name'],
    },
    match_on: ['email_alias'],
  }),
];

// ────────────────────────────────────────────────────────────────
// Accessors (defaulted-registry param — a live/merged registry can be passed)
// ────────────────────────────────────────────────────────────────

/** Look up one vendor's declaration. Returns `null` for an undeclared vendor. */
export const getContactSourceDeclaration = (
  vendor: string,
  registry: ReadonlyArray<ContactSourceDeclaration> = CONTACT_SOURCE_DECLARATIONS,
): ContactSourceDeclaration | null => {
  for (const entry of registry) {
    if (entry.vendor === vendor) return entry;
  }
  return null;
};

/** List every declared contact-source vendor slug (insertion order, deduped). */
export const listContactSourceVendors = (
  registry: ReadonlyArray<ContactSourceDeclaration> = CONTACT_SOURCE_DECLARATIONS,
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

/** Predicate — true when `vendor` has a contact-source declaration. */
export const isDeclaredContactSourceVendor = (
  vendor: unknown,
  registry: ReadonlyArray<ContactSourceDeclaration> = CONTACT_SOURCE_DECLARATIONS,
): vendor is string =>
  typeof vendor === 'string' && getContactSourceDeclaration(vendor, registry) !== null;

// Boot-time registry self-validation (mirrors `file-vendors.ts`). Each entry is
// already validated in isolation by `buildContactSourceDeclaration`; this catches
// the CROSS-ENTRY invariant a per-entry check cannot — a duplicate `vendor` slug —
// so a bad future edit fails at module load, not silently.
//
// The cross-REGISTRY binding is deliberately NOT run here — see
// `assertContactSourceRegistryBinding` for why a module-load throw is the wrong
// enforcement point for an invariant that depends on another feature's registry.
const _bootIssues = assertContactSourceRegistry(CONTACT_SOURCE_DECLARATIONS);
if (_bootIssues.length > 0) {
  throw new Error(`CONTACT_SOURCE_DECLARATIONS boot validation failed: ${_bootIssues.join('; ')}`);
}
