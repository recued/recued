/** D-192 C-2 (slice 6) — the `contact_import` reconcile runner + wire.
 *
 *  The posture finally gets an implementation. `contact_import` has been DECLARED
 *  with ZERO implementation since P-1 (`source-primitive.ts`) — two JSDoc mentions
 *  and one test asserting the enum contains it. Nothing branched on it.
 *
 *  The contact-family counterpart of `file-source-sync.ts`, sharing its reconcile
 *  spine (list → hash-skip → upsert → complete-walk tombstone) but differing in
 *  the two ways the family actually differs:
 *
 *  1. **The leaf returns CANONICAL records, not raw rows + a path-map.** A file is
 *     flat, so `FileProjection` can be a `Record<canonical, vendorPath>` the shared
 *     projector walks. A contact is not: Google People returns `emailAddresses[]` /
 *     `phoneNumbers[]` / `addresses[]` with primary flags, and an address is five
 *     vendor fields composed into one object. No path-map expresses that, so the
 *     shape-wrangling lives in the leaf (§0's "only what can't generalize") and the
 *     declaration carries the FACTS instead — see `contact-sources.ts`.
 *
 *  2. **The MISS POLICY is the whole difference between a CRM and a contact book.**
 *     `hydrate_on_match` — a remote record that matches no local contact is
 *     SKIPPED. A 10k-row CRM is mostly strangers: people your company deals with,
 *     not people you know, so a CRM record only ever ENRICHES someone Recued
 *     already knows. `full_import` (D-205 #4) — a miss is CREATED. A contact book
 *     is YOUR list; the dentist, `{name, phone, address}`, IS a contact, and not
 *     importing him means Recued does not know your contacts.
 *
 *  ## D-205 #4 — `full_import`, and the hole underneath it
 *
 *  🔑 **"Create on a miss" is not enough, and taken literally it is a disaster.**
 *  `matchLocalContact` resolves `email_alias` and nothing else — it is the only
 *  kind with a contact-store resolver. So an entry with NO address (the dentist —
 *  and the entire reason this posture exists) has nothing to match on and can NEVER
 *  match. It is a miss on cycle 1 and a miss on every cycle after, forever. A naive
 *  create-on-miss would mint **a new dentist every cycle**: one person, fanned
 *  across a growing pile of contacts, each an identity the user never made.
 *
 *  So identity resolves in THREE steps, and the order is the design
 *  (`resolveDestination`): the **ADDRESS** wins (the slice-4 address space is the
 *  strongest signal there is) → else the **MIRROR** re-identifies (the vendor's
 *  `remote_id` is stable, so the mirror row IS the memory of "this record is
 *  already that contact") → else **CREATE**. A record that acquires an address it
 *  never had — the dentist finally emails you — is PROMOTED: the synthetic
 *  placeholder is re-keyed to the real thing.
 *
 *  One cycle, per `(source_id, declaration, connection)`. Three of its eight steps
 *  exist purely to make a SILENT failure loud — this family's characteristic bug is
 *  a cycle that reports perfect health over zero work:
 *
 *    1. **Bind**, fail-closed — the join key must be backed by a real meta-field on
 *       the vendor entity this Source reads. Unbacked, hydration matches ZERO
 *       contacts forever and never errors. (A contact book declares
 *       `vendor_entity: null` — no platform record — so this is a no-op for it.)
 *    2. **Resolvable join key**, fail-closed — and it must be a key this runner can
 *       actually resolve. The contract permits `phone_alias`; the runner has no
 *       phone resolver, so it refuses rather than skip.
 *    3. **The miss policy**, fail-closed — `full_import` CREATES, and a created row
 *       must be ATTRIBUTABLE. A rung with no `ContactSource` may not create: the
 *       runner refuses rather than reach for `manual` (which would outrank the
 *       user's own typing forever) or `derived` (which would claim Recued saw it in
 *       warehouse traffic it never saw).
 *    4. **List** — the INJECTED per-vendor leaf.
 *    5. Per record: key → **verify the `supplies` promise** → **resolve the
 *       destination** (match → re-identify → create) → detect a **re-point** →
 *       hash-skip → dedupe → stage.
 *    6. **Disconnects** — absence-based, gated on a POSITIVE completeness proof AND
 *       zero unkeyable rows (the D-190 rule). **Cuts the linkage and NOTHING ELSE.**
 *    7. **Write** — contribute, mirror, then materialize each touched contact ONCE.
 *
 *  ## D-205 §1 — the two planes, and why a vendor delete withdraws NOTHING
 *
 *  A vendor-plane delete and a core-plane delete are DIFFERENT EVENTS. The mirror
 *  (`crm_record_mirror`) mirrors, so a deleted vendor record genuinely goes. But
 *  `data.contact` is not a cache of HubSpot — after import the Recued contact is
 *  **one of the sources of truth**, and HubSpot deleting *their* copy is not a
 *  retraction of what Recued learned. `as_of` already carries the historical truth:
 *  *"HubSpot asserted, as of `<date>`, that Bob works at Acme."*
 *
 *  So a vendor delete is **only a disconnection of the linkage** (`unlinkPlatformId`),
 *  and the blob is **soft-marked**, never dropped — it is the *evidence behind claims
 *  that now stand on their own*, and hard-deleting it would keep the claim and destroy
 *  the receipt. A **re-point** is the same rule from the other side: disconnect from
 *  the old contact, connect to the new; the old keeps what it learned.
 *
 *  The ONE path that removes imported data is the explicit whole-Source teardown
 *  ("also remove the imported data?") — a deliberate user act, never a vendor's.
 *
 *  This runner shipped doing the opposite: a vendor-plane deletion cascaded into a
 *  core-plane withdrawal, and it fired *only* on contacts that had a core record to
 *  damage (an unmatched record never enters `contact_source_blob` at all).
 *
 *  Spec: D-192 step 6 + D-205
 *  §1. */

import type {
  ContactAttributeKind,
  ContactAliasKind,
  ContactImportRung,
  ContactSource,
  ContactSourceDeclaration,
  ConnectionRow,
} from '@recued/contracts';
import {
  CONNECTION_SOURCE_ID,
  assertContactSourceVendorBinding,
  canonicalizeEmail,
  getContactSourceDeclaration,
} from '@recued/contracts';

import { connectionVendorOf } from './work-entity-source-boot.js';
import { hashCanonical } from './source-mirror/hash.js';
import { computeCompleteWalkDeletes } from './source-mirror/diff.js';
import { isMentionOnlyEmail, type ContactStore } from './storage/contact-store.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import {
  initialContactSourceSyncState,
  type ContactSourceCycleCounts,
  type ContactSourceSyncStateStore,
} from './storage/contact-source-sync-state.js';
import {
  getHousekeepingTask,
  registerHousekeepingTask,
  unregisterHousekeepingTask,
  type HousekeepingTaskInstance,
} from './housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// The injected list port (slice-7 adapter leaves satisfy it)
// ────────────────────────────────────────────────────────────────

/** One remote contact record, CANONICALIZED BY THE LEAF.
 *
 *  ⚠ **`aliases` and `attributes` must each carry a key for EVERY kind the
 *  declaration `supplies` — and no others.** An explicit `null` / `[]` means "this
 *  record genuinely has no value for that kind"; a MISSING key means the leaf never
 *  looked, and that is a hard record failure.
 *
 *  This is the whole point of `supplies` being a promise, and it is the difference
 *  between a bug that screams and one that is invisible. A leaf that quietly stops
 *  emitting `address` would drain D-138's `address_zip_country_key` blocking key to
 *  NULL — and a missing blocking key produces NO match rather than a wrong one, so
 *  the merge detector simply stops seeing duplicates. Nobody gets an exception; a
 *  feature just stops working. Requiring the key turns the omission into an
 *  immediate, total, unmissable failure on the first cycle instead. */
export interface ContactSourceRecord {
  /** The vendor's own record id — the mirror key (with `source_id`). */
  remote_id: string;
  /** Unix-ms UTC — when the SOURCE last asserted this (the record's own
   *  last-modified). Feeds the C-2a recency tiebreak, so it is EVENT time, never
   *  ingestion time (D-120 bistemporal). */
  as_of: number;
  /** The vendor payload, verbatim — mirrored into `contact_source_blob` as the
   *  audit trail behind every contribution this record makes. */
  raw: unknown;
  /** Identifier contributions. A key per supplied alias kind; `[]` = none found. */
  aliases: Partial<Record<ContactAliasKind, readonly string[]>>;
  /** Descriptive contributions. A key per supplied attribute kind; `null` = none
   *  found. */
  attributes: Partial<Record<ContactAttributeKind, unknown>>;
}

export interface ContactSourceListRequest {
  source_id: string;
  connection_name: string;
  /** The declaration's `vendor` slug — the leaf keys on it. */
  vendor: string;
  declaration: ContactSourceDeclaration;
}

export type ContactSourceListOutcome =
  | {
      ok: true;
      records: ReadonlyArray<ContactSourceRecord>;
      /** Positive completeness proof — true iff the leaf PROVABLY walked the whole
       *  remote contact list to exhaustion (every page fetched). The delete diff's
       *  gate: a partial walk proves nothing about absence, so it tombstones
       *  nothing (D-190 fail-closed).
       *
       *  There is deliberately NO delta/cursor arm. `ContactSourceDeclaration`
       *  declares no cursor facet, so there is nothing to ride — every cycle is a
       *  full walk, and the hash-skip keeps an unchanged re-list cheap (the S3
       *  posture). A vendor that later grows a real delta earns a cursor facet on
       *  the declaration first; inventing one here would be a cursor with nothing
       *  behind it. */
      complete: boolean;
    }
  | {
      ok: false;
      /** `'config'` — the leaf can't list (missing credential / unenrolled, or the
       *  Source failed its vendor binding); `'policy'` — a permission gate refused;
       *  `'error'` — the call failed; `'unavailable'` — a transient nothing-to-list. */
      kind: 'config' | 'policy' | 'error' | 'unavailable';
      reason: string;
    };

export type ContactSourceListFn = (
  request: ContactSourceListRequest,
) => Promise<ContactSourceListOutcome>;

/** Resolve the per-vendor list leaf. Absent / returns `undefined` (slice 6) → the
 *  vendor has no adapter leaf yet, so no Source gets a sync task. The runner + the
 *  wiring stand ready; slice 7's leaves are what light the tasks up. */
export type ContactSourceAdapterResolver = (
  vendor: string,
) => ContactSourceListFn | undefined;

// ────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────

export interface ContactSourceSyncDeps {
  store: ContactStore;
  /** The resolved list leaf for THIS Source's vendor (the wire resolves it; tests
   *  inject a stub). */
  listContacts: ContactSourceListFn;
  /** D-205 item #1 — where the cycle's outcome is RECORDED.
   *
   *  ⚠ Required, deliberately. The cycle used to return its outcome to a caller that
   *  discarded it, so a leaf that forgot a promised field failed every record, every
   *  cycle, in total silence — the exact failure the `supplies` promise exists to
   *  make loud. A dependency you can forget to pass is a dependency that will be
   *  forgotten; the runner records its own health, and it cannot be constructed
   *  without somewhere to record it. */
  syncState: ContactSourceSyncStateStore;
  now?: () => number;
}

export interface ContactSourceSyncInput {
  source_id: string;
  connection_name: string;
  declaration: ContactSourceDeclaration;
}

/** What one cycle did, plus whether it could say so cleanly.
 *
 *  The counters live on {@link ContactSourceCycleCounts} — in the STATE STORE, which
 *  persists them — and this type is an INTERSECTION with it rather than a copy. That
 *  is load-bearing: adding a counter to the cycle now forces it into the persisted
 *  row, or it does not compile. A counter that exists only in a return value is a
 *  counter nobody will ever read, which is precisely how this family got here. */
export type ContactSourceSyncResult =
  | (ContactSourceCycleCounts & {
      ok: true;
      /** Up to 3 sample failures, verbatim ("hs_1: attributes.address promised by the
       *  declaration but absent ..."). The runner has always collected these and then
       *  DROPPED them on the floor — a count tells you something broke, a sample tells
       *  you what. Persisted into `last_error_message`. */
      failures: readonly string[];
    })
  | { ok: false; kind: 'config' | 'policy' | 'error' | 'unavailable'; reason: string };

/** A record that survived keying, verification and matching — staged for the write
 *  pass. */
interface StagedRecord {
  key: string;
  record: ContactSourceRecord;
  contact_id: string;
  /** The matched contact's canonical email — what the platform-link substrate keys
   *  on. Carried from the match rather than re-queried. */
  canonical_email: string;
  /** False when the hash-skip proved the canonical contribution set unchanged. */
  changed: boolean;
  snapshot_hash: string;
}

/** Verify the leaf kept the declaration's `supplies` promise, for ONE record.
 *
 *  The key SET must match the declaration exactly, in both directions:
 *   - a MISSING key   ⇒ the leaf never looked for a kind it promised (the silent
 *     drain this whole mechanism exists to prevent);
 *   - an EXTRA key    ⇒ the leaf supplies something the declaration does not
 *     cover, so the declaration is stale and the user's expectations of this
 *     Source are wrong.
 *
 *  An explicitly-present `null` / `[]` is FINE — it says "I looked; this record has
 *  none". That distinction (`in` vs truthiness) is the entire mechanism: without it
 *  "no address on this contact" and "this leaf has forgotten how to read addresses"
 *  are the same observation. */
const verifySupplies = (
  record: ContactSourceRecord,
  declaration: ContactSourceDeclaration,
): string[] => {
  const issues: string[] = [];
  const check = (
    got: Record<string, unknown>,
    promised: ReadonlyArray<string>,
    axis: 'aliases' | 'attributes',
  ): void => {
    for (const kind of promised) {
      if (!(kind in got)) {
        issues.push(
          `${axis}.${kind} promised by the declaration but absent from the record (an explicit null/[] means "none"; a missing key means the leaf never looked)`,
        );
      }
    }
    for (const kind of Object.keys(got)) {
      if (!promised.includes(kind)) {
        issues.push(`${axis}.${kind} supplied but NOT declared — the declaration is stale`);
      }
    }
  };
  check(record.aliases as Record<string, unknown>, declaration.supplies.aliases, 'aliases');
  check(
    record.attributes as Record<string, unknown>,
    declaration.supplies.attributes,
    'attributes',
  );
  return issues;
};

/** The canonical contribution set's hash — the incremental seam.
 *
 *  Hashed over what we CONTRIBUTE (`aliases` + `attributes`), not the raw vendor
 *  payload: a vendor bumping an unrelated field (a `lastViewedAt`) must not
 *  re-write every contribution and re-materialize the contact. Same convention as
 *  the CRM reconcilers, which deliberately exclude activity timestamps from their
 *  hashes. `as_of` is excluded for the same reason. */
const contactRecordHash = (record: ContactSourceRecord): string =>
  hashCanonical({ aliases: record.aliases, attributes: record.attributes });

/** The `match_on` kinds this runner can actually RESOLVE to a local contact.
 *
 *  ⚠ Deliberately narrower than `CONTACT_MATCH_KEY_KINDS`, and the gap is the
 *  point. The contract permits `phone_alias` as a join key and the vendor binding
 *  HAPPILY passes it (hubspot.contact declares a projectable `phone` meta-field) —
 *  but this runner has no phone→contact resolver, so a declaration keyed on it
 *  would match nothing. Skipping such a kind quietly would produce a cycle that
 *  reports `ok: true`, counts every record as a `hydrate_on_match` miss, and
 *  hydrates ZERO contacts forever — indistinguishable from "the CRM had no
 *  matches", which is the precise failure every other guard in this file exists to
 *  prevent. So an unresolvable join key REFUSES THE CYCLE instead (see the runner).
 *
 *  Widening this set is what "slice 6 owns whether to widen `match_on`" means:
 *  `contact_phone_forms` and the D-138 predicate both exist, so a phone resolver is
 *  a real, small piece of work — it is simply not done, and says so. */
const RESOLVABLE_MATCH_KINDS: ReadonlySet<string> = new Set(['email_alias']);

/** The local person a remote record resolved to. Carries the canonical EMAIL as
 *  well as the id because the platform-link substrate keys on the email (one more
 *  face of the `*_contact_id`-holds-an-email naming lie), and re-querying for it
 *  after the fact would be a second lookup for something the match already had. */
interface MatchedContact {
  contact_id: string;
  canonical_email: string;
}

/** D-205 #4 — the `ContactSource` an import stamps on a row it CREATES.
 *
 *  A created row must be ATTRIBUTABLE: `contacts.source` records how the row came
 *  to exist, and the C-2a ladder ranks its contributions off that. Only
 *  `contact_book` has a `ContactSource` member; `vendor_meta` does not, because no
 *  CRM is `full_import` (a CRM is mostly strangers — that is the whole posture).
 *
 *  ⛔ **A rung without an entry here MAY NOT CREATE, and the runner refuses the
 *  cycle rather than improvise.** The improvisations both exist and are both
 *  fatal: `manual` would park a vendor's assertion at the TOP of the ladder where
 *  the user's own typing could never correct it, and `derived` would claim Recued
 *  pulled it out of warehouse traffic it never saw. A future `full_import` vendor
 *  at another rung earns its own member — in the same commit as its leaf. */
const IMPORT_ROW_SOURCE: Readonly<Partial<Record<ContactImportRung, ContactSource>>> = {
  contact_book: 'contact_book',
};

/** The record's first usable address, or null when it carries none (the DENTIST).
 *  Not a match — just "does this record name an address at all", which is what
 *  decides `verified` vs `partial` on a create, and what a promotion needs. */
const firstAddressOf = (record: ContactSourceRecord): string | null => {
  for (const raw of record.aliases.email_alias ?? []) {
    const canonical = canonicalizeEmail(raw);
    if (canonical) return canonical;
  }
  return null;
};

/** Which local contact this remote record belongs to, via the declaration's
 *  `match_on` join key. Returns null for the `hydrate_on_match` miss.
 *
 *  Email resolution rides the SLICE-4 ADDRESS SPACE: `resolveCanonicalEmail`
 *  resolves any known address — primary OR a secondary alias, through any merge
 *  chain — to the contact that OWNS it, and an UNKNOWN address resolves to itself.
 *  So a `get` that comes back null IS the miss, exactly. Mail from `bob@work.com`
 *  is mail from Bob even when his row is keyed on `bob@home.com`.
 *
 *  Every kind reaching here is guaranteed resolvable — the runner refused the cycle
 *  otherwise. */
const matchLocalContact = (
  store: ContactStore,
  record: ContactSourceRecord,
  declaration: ContactSourceDeclaration,
): MatchedContact | null => {
  for (const kind of declaration.match_on) {
    if (kind !== 'email_alias') continue;
    for (const raw of record.aliases.email_alias ?? []) {
      const email = raw.trim();
      if (email.length === 0) continue;
      let canonical: string;
      try {
        canonical = store.resolveCanonicalEmail(email).canonical_email;
      } catch {
        continue; // unparseable address — not a match, not a crash
      }
      const hit = store.get(canonical);
      if (hit?.contact_id) {
        return { contact_id: hit.contact_id, canonical_email: hit.email };
      }
    }
  }
  return null;
};

/** Where one remote record's contributions are going to land. */
type Destination =
  | {
      kind: 'contact';
      contact_id: string;
      canonical_email: string;
      /** This cycle minted the row. */
      created: boolean;
      /** This cycle re-keyed a synthetic placeholder to a real address. */
      promoted: boolean;
    }
  /** The `hydrate_on_match` miss — a person Recued does not know. */
  | { kind: 'stranger' }
  | { kind: 'failed'; reason: string };

interface ResolveDestinationInput {
  store: ContactStore;
  record: ContactSourceRecord;
  declaration: ContactSourceDeclaration;
  key: string;
  /** The `match_on` result — null when no local contact owns any of its addresses. */
  matched: MatchedContact | null;
  /** The mirror row for `(source_id, remote_id)`, if this record has been seen. */
  prior: { contact_id: string } | null;
  /** The `ContactSource` to stamp on a created row. Undefined ⇒ this Source may
   *  not create (guaranteed absent only for `hydrate_on_match` — the runner
   *  refused the cycle otherwise). */
  rowSource: ContactSource | undefined;
  now: number;
}

/** Which local person this remote record belongs to — MATCH, then RE-IDENTIFY,
 *  then CREATE. The order is the design, and each step earns its place:
 *
 *  1. **The ADDRESS wins.** An email match rides the slice-4 address space, which
 *     resolves any known address — primary, secondary alias, through any merge
 *     chain — to the contact that OWNS it. It is the strongest identity signal
 *     there is, and it must outrank the mirror: if the dentist's new Google
 *     address turns out to be someone Recued already knows, that person IS the
 *     destination, and the record RE-POINTS onto them. (The synthetic contact we
 *     minted earlier is then a duplicate of a person we now know by address — the
 *     D-138 detector blocks them on name/phone and offers the merge. That is
 *     ruling 2: *import is import AND merge*, and it is why we do not force it.)
 *
 *  2. **The MIRROR re-identifies.** No address match, but we have seen this
 *     `remote_id` before ⇒ it is already a contact. This is the duplicate-dentist
 *     fix, and it is the only thing standing between `full_import` and minting the
 *     same person on every cycle for the rest of time.
 *     ⚠ Resolved THROUGH the merge chain (`getByContactIdResolved`): the contact
 *     this record fed last cycle may have been merged away since, and writing to a
 *     tombstone would strand every contribution on a dead identity.
 *     💡 And if the record has ACQUIRED an address since — the dentist finally
 *     emails you — that is exactly what PROMOTION is for: re-key the synthetic
 *     placeholder to the real thing. Safe now that a contact's reads span its whole
 *     address set (D-205 #3.5b); before that it would have silently orphaned every
 *     row still keyed on the synthetic.
 *
 *  3. **CREATE** — genuinely new, and `full_import` says every entry in YOUR
 *     contact book belongs in your contact graph. `hydrate_on_match` says the
 *     opposite (a 10k-row CRM is mostly strangers) and stops here. */
const resolveDestination = (input: ResolveDestinationInput): Destination => {
  const { store, record, declaration, key, matched, prior, rowSource, now } = input;

  // 1. THE ADDRESS WINS.
  if (matched !== null) {
    return { kind: 'contact', ...matched, created: false, promoted: false };
  }

  // A CRM record matching nobody is a stranger, and that is the entire posture.
  if (declaration.import_scope !== 'full_import') return { kind: 'stranger' };

  // The runner refuses a `full_import` Source whose rung cannot be stamped, so
  // this is unreachable — the floor is here because a value that reaches a create
  // without provenance is the one failure this family must never have.
  if (rowSource === undefined) {
    return { kind: 'failed', reason: 'full_import with no ContactSource to stamp' };
  }

  const address = firstAddressOf(record);
  const name = typeof record.attributes.name === 'string' ? record.attributes.name.trim() : '';

  // 2. THE MIRROR RE-IDENTIFIES.
  if (prior !== null) {
    const existing = store.getByContactIdResolved(prior.contact_id);
    if (existing !== null) {
      // The dentist finally emailed you. Re-key the placeholder to the real thing.
      const isPlaceholder = isMentionOnlyEmail(existing.email);
      if (address !== null && isPlaceholder) {
        try {
          const verified = store.promoteMentionOnlyToVerified(
            { contact_id: existing.contact_id!, email: address },
            now,
          );
          return {
            kind: 'contact',
            contact_id: verified.contact_id!,
            canonical_email: verified.email,
            created: false,
            promoted: true,
          };
        } catch (err) {
          // Promotion is an ENHANCEMENT, not the identity. The contact exists and
          // the write pass is about to attach the address as an `email_alias`
          // anyway, so it stays reachable either way — it just keeps its synthetic
          // key. Fail the RECORD (loudly, into the cycle's health) rather than the
          // cycle: next cycle retries, and the sample says why.
          return {
            kind: 'failed',
            reason: `promotion to '${address}' failed — ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      return {
        kind: 'contact',
        contact_id: existing.contact_id!,
        canonical_email: existing.email,
        created: false,
        promoted: false,
      };
    }
    // The mirror points at a contact that no longer exists (a hard delete outside
    // the sync). Fall through and create — the record is real, the identity is not.
  }

  // 3. CREATE.
  //
  // A record with neither an address nor a name is an identity nothing could ever
  // match — not by the address space, not by a D-138 blocking key. Creating it
  // would add a row that can only ever be found by scrolling. Fail it, visibly.
  if (address === null && name.length === 0) {
    return {
      kind: 'failed',
      reason: 'no address and no name — nothing could ever match this identity',
    };
  }

  // The DENTIST: no address, but a phone (or an address on the map) makes them a
  // real, findable person — `partial`, not `mention_only`. Defaulting every
  // emailless entry to `mention_only` would under-state exactly the case the
  // `full_import` posture exists for.
  const hasPhone = (record.aliases.phone_alias ?? []).some((p) => p.trim().length > 0);

  try {
    const fresh = store.createImportedContact(
      {
        ...(address !== null ? { email: address } : {}),
        // `fallbackDisplayName` is the store's own local-part fallback; an address
        // with no name still deserves a row (it is a person you kept), and the
        // write pass will overwrite the name the moment the vendor supplies one.
        name: name.length > 0 ? name : (address ?? key),
        source: rowSource,
        ...(address === null && hasPhone ? { identity_status: 'partial' as const } : {}),
      },
      now,
    );
    return {
      kind: 'contact',
      contact_id: fresh.contact_id!,
      canonical_email: fresh.email,
      created: true,
      promoted: false,
    };
  } catch (err) {
    return {
      kind: 'failed',
      reason: `create failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/** Deterministic tiebreak when a Source holds MORE THAN ONE record for one person.
 *
 *  Salesforce and Pipedrive both permit duplicate contacts, so this is real. The
 *  contributions are keyed `(contact_id, kind, source_id)` — one row per source —
 *  so two records of the same Source would overwrite each other, and whichever the
 *  vendor happened to return LAST would win. The projection would then FLICKER
 *  between two values across cycles, which slice 4 already established is worse than
 *  being wrong: a wrong value is reproducible, a flickering one is not.
 *
 *  Freshest wins; ties break on `remote_id` so the winner never depends on the
 *  vendor's page order. */
const beats = (a: ContactSourceRecord, b: ContactSourceRecord): boolean =>
  a.as_of !== b.as_of ? a.as_of > b.as_of : a.remote_id > b.remote_id;

/** D-205 item #1 — the health verdict for a cycle that WALKED.
 *
 *  A cycle can be `ok: true` and still be doing nothing useful, and this is the
 *  function that refuses to let that pass unremarked. Failures here are COUNTED, not
 *  thrown, because one malformed vendor payload must not abort a walk over ten
 *  thousand records — which means the counts are the *only* evidence, and a count
 *  nobody persists is a count nobody reads.
 *
 *  The three that mean the Source is not doing its job:
 *   - `failed_rows`  — the headline. A leaf that forgot a promised kind fails EVERY
 *     record, so this equals the record count and the Source hydrates nothing at all.
 *   - `mirror_failed` — the mirror feeds both the hash-skip and the delete diff, so a
 *     systematic mirror failure re-hydrates everything from scratch, every cycle,
 *     forever, while reporting success.
 *   - `unkeyable` — poisons the delete proof, so the Source silently stops
 *     reconciling deletions (D-190 fail-closed).
 *
 *  ⚠ An INCOMPLETE walk is deliberately NOT degradation. For the CRM leaf
 *  `complete: false` means the mirror is empty — cold, purged, or a CRM with no
 *  contacts — and the runner cannot tell those apart from the inside. Claiming a
 *  health verdict it cannot prove would be a false alarm on every cold start, and it
 *  would feed `partial_api_failure` into the AI-context omission decision. The fact
 *  is RECORDED (`complete` is one of the persisted counts) without being editorialized.
 *  Returns null when the cycle was clean. */
const degradationOf = (
  counts: ContactSourceCycleCounts,
  failures: readonly string[],
): { code: string; message: string } | null => {
  const parts: string[] = [];
  if (counts.failed_rows > 0) {
    parts.push(`${counts.failed_rows} record(s) failed their supplies promise or could not be written`);
  }
  if (counts.mirror_failed > 0) {
    parts.push(`${counts.mirror_failed} record(s) could not be mirrored`);
  }
  if (counts.unkeyable > 0) {
    parts.push(`${counts.unkeyable} record(s) carried no keyable remote_id (deletes suppressed this cycle)`);
  }
  if (parts.length === 0) return null;
  const code = counts.failed_rows > 0
    ? 'records_failed'
    : counts.mirror_failed > 0
      ? 'mirror_failed'
      : 'records_unkeyed';
  // The SAMPLES are what make this a bug report instead of a shrug.
  const detail = failures.length > 0 ? ` — ${failures.join(' | ')}` : '';
  return { code, message: `${parts.join('; ')}${detail}` };
};

/** Run one sync cycle for a declared contact Source, and RECORD its outcome. */
export const runContactSourceSync = async (
  deps: ContactSourceSyncDeps,
  input: ContactSourceSyncInput,
): Promise<ContactSourceSyncResult> => {
  const { store, listContacts, syncState } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const { source_id, connection_name, declaration } = input;

  syncState.markStarted(source_id, now());

  /** Refuse the cycle — and RECORD the refusal. Every one of these guards exists to
   *  turn a silent zero-import into a loud failure, and returning the reason to a
   *  caller that drops it achieves exactly nothing. A refused cycle never walked, so
   *  it carries no counts (and must not blank the counts of the last cycle that did). */
  const refuse = (
    kind: 'config' | 'policy' | 'error' | 'unavailable',
    reason: string,
  ): ContactSourceSyncResult => {
    syncState.markCompleted(source_id, { now: now(), error: { code: kind, message: reason } });
    return { ok: false, kind, reason };
  };

  // ── 1. Bind, fail-closed ──────────────────────────────────────
  // The join key must be BACKED by a real projectable meta-field on the vendor
  // entity this Source reads. Unbacked, hydration matches ZERO contacts forever and
  // never errors — indistinguishable from "the CRM had no matches", which is why it
  // must refuse to run rather than run and report success over nothing.
  //
  // Checked HERE, per Source, and NOT as a module-load throw in contracts: the
  // binding reaches into `CONNECTION_VENDOR_ENTITIES`, a registry another feature
  // owns, so a boot throw would let an unrelated D-194 edit brick every import of
  // `packages/contracts`. An invariant should fail as loudly as possible, but no
  // more widely than the thing it protects.
  const bindingIssues = assertContactSourceVendorBinding(declaration);
  if (bindingIssues.length > 0) {
    return refuse(
      'config',
      `contact source '${source_id}' failed its vendor binding: ${bindingIssues.join('; ')}`,
    );
  }

  // ── 2. The join key must be one we can actually RESOLVE ───────
  // The contract permits `phone_alias` and the vendor binding passes it, but this
  // runner has no phone→contact resolver. Running anyway would report a healthy
  // cycle over zero hydrations, forever — the same silent-zero-import the binding
  // check refuses. A promise the runner cannot keep is refused, not skipped.
  const unresolvable = declaration.match_on.filter((k) => !RESOLVABLE_MATCH_KINDS.has(k));
  if (unresolvable.length > 0) {
    return refuse(
      'config',
      `match_on ${unresolvable.join(' / ')} has no resolver in this runner (only ${[
        ...RESOLVABLE_MATCH_KINDS,
      ].join(' / ')}); hydrating would silently match zero contacts`,
    );
  }

  // ── 3. The miss policy ────────────────────────────────────────
  // `full_import` CREATES on a miss (D-205 #4 — a contact book is YOUR list; the
  // dentist IS a contact). But a created row must be ATTRIBUTABLE, and that is the
  // one thing this posture can get catastrophically wrong: `contacts.source` needs
  // a `ContactSource`, and the only honest one is the rung's own. A rung with no
  // member in `IMPORT_ROW_SOURCE` may not create — the runner refuses the cycle
  // rather than reach for `manual` (which would outrank the user's own typing
  // forever) or `derived` (which would claim Recued saw it in warehouse traffic).
  const rowSource: ContactSource | undefined = IMPORT_ROW_SOURCE[declaration.rung];
  if (declaration.import_scope === 'full_import' && rowSource === undefined) {
    return refuse(
      'config',
      `import_scope 'full_import' at rung '${declaration.rung}' has no ContactSource to stamp on a created row — only ${Object.keys(
        IMPORT_ROW_SOURCE,
      ).join(' / ')} may create; a new full_import rung earns its member with its leaf`,
    );
  }

  // ── 4. List ───────────────────────────────────────────────────
  const outcome = await listContacts({
    source_id,
    connection_name,
    vendor: declaration.vendor,
    declaration,
  });
  if (!outcome.ok) return refuse(outcome.kind, outcome.reason);

  // ── 5. Per record: key → verify → match → re-point → hash-skip → dedupe ──
  //
  // ⚠ `priorHashes` OMITS soft-marked rows (D-205 §1), which is what it must do for
  // both of its jobs: it is the delete diff's `priorKeys` (an already-disconnected
  // row must never re-enter it as "prior but not polled", or the diff re-fires on it
  // every cycle forever), and it is the hash-skip (a record that comes BACK must be
  // re-contributed, not skipped as unchanged).
  const priorHashes = store.listContactSourceBlobHashes(source_id);
  const polledKeys = new Set<string>();
  /** contact_id → the best record for that contact this cycle. */
  const winners = new Map<string, StagedRecord>();
  /** Every matched record's blob gets mirrored, winner or not — the mirror is the
   *  mirror, and a loser we drop today may be the winner once its sibling is
   *  deleted (self-healing). */
  const toMirror: StagedRecord[] = [];
  const failures: string[] = [];
  /** Contacts whose record set for THIS Source lost a member this cycle — a record
   *  disconnected, or re-pointed away to someone else.
   *
   *  ⚠ NOT "contacts we withdrew from" — this cycle withdraws from nobody (D-205
   *  §1). It is a WINNER RE-ELECTION: the contribution key is
   *  `(contact_id, kind, source_id)`, ONE row per Source, and that row currently
   *  holds the value of the record that just left. A surviving sibling record is
   *  therefore now this Source's best record for that person, and it must RE-ASSERT
   *  even though its own payload never changed — otherwise the Source's row keeps
   *  quoting a record the Source no longer has, while the record it DOES have says
   *  something else, and the detail page renders that provenance as fact.
   *
   *  It is an upsert by the same `source_id`, so nothing is destroyed. And when NO
   *  record survives for that contact, the row stands exactly as it was — which is
   *  precisely the ruling: the core contact keeps what it learned. */
  const resettled = new Set<string>();
  let unchanged = 0;
  let skipped = 0;
  // D-205 #4 — the `full_import` counters. `created` large on cycle 1 and ~0 after;
  // a Source that keeps creating is DUPLICATING your contact book, not importing it.
  let created = 0;
  let promoted = 0;
  let failed_rows = 0;
  let unkeyable = 0;
  let ambiguous = 0;
  let repointed = 0;

  for (const record of outcome.records) {
    // Key FIRST — a record that fails anything downstream is still PRESENT and must
    // never enter the delete diff as absent. A record with no key is UNKEYABLE:
    // counted, and it fail-closes the delete proof below (a record we cannot key is
    // a record we cannot prove absent).
    const key = typeof record.remote_id === 'string' ? record.remote_id.trim() : '';
    if (key.length === 0) {
      unkeyable += 1;
      continue;
    }
    polledKeys.add(key);

    // The supplies promise. A leaf that forgot a kind fails EVERY record, so the
    // cycle collapses immediately and unmissably rather than draining a column.
    const issues = verifySupplies(record, declaration);
    if (issues.length > 0) {
      failed_rows += 1;
      if (failures.length < 3) failures.push(`${key}: ${issues.join('; ')}`);
      continue;
    }

    // The hash is computed by walking the record's own structure, so a leaf that
    // emits something pathological (a cyclic object, an absurdly deep one) throws
    // HERE — before any try/catch downstream. Unguarded, ONE malformed record would
    // abort the whole cycle, and a housekeeping throw is reserved for programming
    // errors, not for a vendor payload we did not like. Fail the record, keep the
    // cycle: the other contacts still land, and the record is present (already in
    // `polledKeys`) so it is never mistaken for deleted.
    let snapshot_hash: string;
    try {
      snapshot_hash = contactRecordHash(record);
    } catch (err) {
      failed_rows += 1;
      if (failures.length < 3) {
        failures.push(`${key}: unhashable — ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    // The mirror's view of this record: WHO it was feeding last cycle. It settles
    // the re-point and the hash-skip — and, under `full_import`, the thing neither
    // of those needed: WHO THIS RECORD ALREADY IS.
    //
    // 🔑 **THE DUPLICATE-DENTIST HOLE, and why this read moved above the match.**
    // `matchLocalContact` resolves `email_alias` and nothing else (it is the only
    // kind with a contact-store resolver). An entry with NO address — the dentist,
    // `{name, phone, address}`, and the entire reason a contact book is
    // `full_import` at all — therefore has nothing to match on and can NEVER match.
    // It is a miss on cycle 1, and it is a miss on every cycle after. A create-on-
    // miss that trusted the match alone would mint **a new dentist every cycle,
    // forever** — the same person, fanned across a growing pile of contacts, each
    // one an identity the user never made.
    //
    // The vendor's `remote_id` is stable (Google People's `resourceName`), and the
    // mirror is keyed on it. So the mirror row IS the memory: *"this record is
    // already that contact."* It is the re-identification key an address cannot be.
    const prior = store.getContactSourceBlob(source_id, key);

    const matched = matchLocalContact(store, record, declaration);
    const destination = resolveDestination({
      store,
      record,
      declaration,
      key,
      matched,
      prior,
      rowSource,
      now: now(),
    });

    if (destination.kind === 'stranger') {
      // The `hydrate_on_match` miss — a stranger. Not mirrored, not contributed.
      skipped += 1;
      continue;
    }
    if (destination.kind === 'failed') {
      failed_rows += 1;
      if (failures.length < 3) failures.push(`${key}: ${destination.reason}`);
      continue;
    }
    if (destination.created) created += 1;
    if (destination.promoted) promoted += 1;
    const { contact_id, canonical_email } = destination;

    // ── The RE-POINT ─────────────────────────────────────────────
    // The record still EXISTS — the delete diff will never see it — but it now
    // belongs to someone ELSE: its email was edited upstream, or a local merge moved
    // that address's owner. The new contact gets the contributions and the mirror row
    // follows.
    //
    // ⚠ The OLD contact keeps everything (D-205 §1). This path used to withdraw the
    // Source's contributions from them, on the reasoning that Bob should not keep a
    // company from a record that no longer refers to him. The ruling is the reverse:
    // after import that value IS Bob's, `as_of` carries the historical truth, and a
    // vendor re-assigning a record is not a retraction. Disconnect from the old,
    // connect to the new.
    const movedContact = prior !== null && prior.contact_id !== contact_id;
    if (movedContact) {
      repointed += 1;
      resettled.add(prior.contact_id);
    }

    // The hash-skip is an optimisation over "same payload AND same destination". A
    // record whose destination moved must be re-written even when its payload is
    // byte-identical — the local-merge case, where nothing about the vendor record
    // changed but `resolveCanonicalEmail` now resolves it to a different contact.
    // Skipping it there would leave the new contact without the contributions AND the
    // mirror row pointing at the old one, so the re-point would re-detect, and
    // re-do-nothing, on every cycle forever.
    const staged: StagedRecord = {
      key,
      record,
      contact_id,
      canonical_email,
      changed: priorHashes.get(key) !== snapshot_hash || movedContact,
      snapshot_hash,
    };
    toMirror.push(staged);

    const incumbent = winners.get(contact_id);
    if (incumbent === undefined) {
      winners.set(contact_id, staged);
    } else if (beats(record, incumbent.record)) {
      winners.set(contact_id, staged);
      ambiguous += 1;
    } else {
      ambiguous += 1;
    }
  }

  // ── 6. DISCONNECTS — the vendor's record is gone (D-205 §1) ───
  // Absence proves a record is GONE only when the walk provably saw everything:
  // a POSITIVE completeness proof from the leaf AND zero unkeyable records.
  // Anything less ⇒ zero disconnects this cycle (the D-190 fail-closed rule).
  //
  // ⚠ WITHDRAW NOTHING. A vendor deleting *their* record is ONLY a disconnection of
  // the linkage. After import the Recued contact is one of the sources of truth, and
  // HubSpot deleting its copy is not a retraction of what Recued learned — `as_of`
  // already carries the historical truth ("HubSpot asserted, as of <date>, that Bob
  // works at Acme"). The two things that happen:
  //
  //   1. `unlinkPlatformId` — the link says "this person IS HubSpot record 47291",
  //      and that record no longer exists, so the cross-reference is now dangling.
  //      This is a fact that stopped being true, not a fact we are forgetting. (It
  //      re-materializes the contact's `platform_ids` JSON itself.)
  //   2. The blob is SOFT-MARKED, never dropped. It is the evidence behind claims
  //      that now stand on their own; hard-deleting it would keep the claim and
  //      destroy the receipt. The mark is also what stops this diff re-firing on the
  //      row every cycle — `listContactSourceBlobHashes` omits it thereafter.
  //
  // Aliases were never withdrawn here even before D-205, and the reasoning generalizes
  // to why nothing else is either: `contact_alias` is keyed on the VALUE per contact —
  // ONE row per address, stamped with whichever source currently outranks — so
  // `bob@work.com`, first derived from his mail and later PROMOTED to `vendor_meta`
  // when HubSpot asserted it too, is a single row now attributed to HubSpot.
  // Withdrawing "HubSpot's aliases" would delete the address the mail traffic
  // discovered, and Bob would stop resolving. An address that once reached Bob still
  // reaches Bob; identifiers are additive.
  //
  // The ONLY path that removes imported data is the explicit whole-Source teardown
  // ("also remove the imported data?") — a deliberate user act, never a vendor's.
  let disconnected = 0;
  if (outcome.complete && unkeyable === 0) {
    for (const gone of computeCompleteWalkDeletes({
      complete: outcome.complete,
      priorKeys: priorHashes.keys(),
      polledKeys,
    })) {
      // Which person was this record feeding? The mirror row knows; nothing else
      // does (a contribution is keyed by Source, not by remote record).
      const blob = store.getContactSourceBlob(source_id, gone);
      // Already gone (a contact deleted mid-cycle cascades its blobs) — nothing to
      // disconnect, so nothing to count.
      if (blob === null) continue;
      store.markContactSourceBlobDisconnected(source_id, gone, now());
      if (declaration.vendor_entity !== null) {
        store.unlinkPlatformId(declaration.vendor, gone);
      }
      // A sibling record of this Source may still feed this person — and it is now
      // this Source's best record for them, so it must re-assert. See `resettled`.
      resettled.add(blob.contact_id);
      disconnected += 1;
    }
  }

  // ── 7. Write — contribute, mirror, materialize once ───────────
  const rung = declaration.rung;
  /** Contacts whose PROJECTION must be recomputed. Only the ones actually written:
   *  a contact whose record merely disconnected had nothing withdrawn, so its
   *  contributions — and therefore its projection — are byte-identical, and
   *  `unlinkPlatformId` re-materialized its `platform_ids` JSON itself. */
  const touched = new Set<string>();
  /** Records whose write failed this cycle. Their blob must NOT be mirrored — the
   *  blob carries the snapshot_hash, and advancing it would make the next cycle
   *  hash-skip the record as `unchanged`, turning a transient failure into a
   *  permanent, invisible one. A stale hash is what buys the retry. */
  const failedKeys = new Set<string>();
  let hydrated = 0;
  let conflicted = 0;
  let mirror_failed = 0;
  let linked = 0;

  for (const staged of winners.values()) {
    // The hash-skip is an OPTIMISATION over a contact whose record set for this
    // Source did not move. If a sibling record just disconnected or re-pointed away,
    // this winner is the Source's NEW best record for that person — and the Source's
    // one contribution row for them still holds the departed record's value. So it
    // must re-assert even though its own payload is unchanged. See `resettled`.
    if (!staged.changed && !resettled.has(staged.contact_id)) {
      unchanged += 1;
      continue;
    }

    const { record, contact_id } = staged;
    let recordFailed = false;

    // Aliases — identifiers. An address the CRM knows that we do not is exactly the
    // multi-email case slice 4's address space exists to hold.
    for (const kind of declaration.supplies.aliases) {
      for (const value of record.aliases[kind] ?? []) {
        const alias_pattern = typeof value === 'string' ? value.trim() : '';
        if (alias_pattern.length === 0) continue; // "none found" — not a failure
        try {
          store.upsertContactAlias({
            contact_id,
            kind,
            alias_pattern,
            source: rung,
            source_id,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith('email_alias_already_attached')) {
            // The CRM says an address we hold for SOMEONE ELSE belongs to this
            // person. That is not an error — it is the strongest merge signal there
            // is, and D-138's queue is where it belongs (a named follow-on). Count
            // it; never let it fail the record, and never let it steal the address
            // from its current owner behind the user's back.
            conflicted += 1;
            continue;
          }
          recordFailed = true;
          if (failures.length < 3) failures.push(`${staged.key}: ${msg}`);
        }
      }
    }

    // Attributes — descriptive. `null` = "the leaf looked and found none", which is
    // a real answer, not a value to store.
    for (const kind of declaration.supplies.attributes) {
      const value = record.attributes[kind];
      if (value === null || value === undefined) continue;
      try {
        store.upsertContactAttribute({
          contact_id,
          kind,
          value,
          source_id,
          source: rung,
          as_of: record.as_of,
        });
      } catch (err) {
        recordFailed = true;
        if (failures.length < 3) {
          failures.push(`${staged.key}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (recordFailed) {
      failed_rows += 1;
      // 🔑 The RETRY GUARD. A record whose write failed must NOT have its blob
      // mirrored below, because the blob carries the snapshot_hash — advance it and
      // the next cycle sees the record as `unchanged`, hash-skips it, and the
      // failure becomes PERMANENT AND INVISIBLE (one degraded cycle, then a clean
      // `unchanged: 1` forever). Leaving the hash stale is what makes the next cycle
      // try again.
      failedKeys.add(staged.key);
    } else {
      hydrated += 1;
    }
    touched.add(contact_id);
  }

  // ── 9. The CRM LINK — the half that has never existed ──────────────────────────
  // The taxonomy said CRM contacts "link but never hydrate". The truth was worse: they
  // did NEITHER. `PlatformIdEntry.linked_by` has documented `'auto:email_match'` since
  // D-138 and nothing has ever written it; `resolveCompanyForDomain` is fully built
  // with zero production callers, because nothing ever linked a contact to a CRM record
  // for it to resolve FROM. This is that write.
  //
  // ⚠ **NOT a `contact_alias` of kind `platform_id`.** That kind is the SOCIAL axis —
  // `CONTACT_ALIAS_PLATFORMS` is a closed list (facebook / x / instagram / linkedin /
  // github / substack) with no CRM vendors in it, and the alias store would reject one.
  // The CRM record link is a different substrate entirely. Two mechanisms, one
  // confusingly-shared word.
  //
  // Over EVERY matched record, not just the dedupe winner: a link is a
  // cross-reference, not a contribution, so it cannot conflict. A duplicate CRM record
  // for one person (Salesforce permits them) genuinely IS that person, and the D-138
  // surfaces that reconcile the two need to be able to find it.
  //
  // The `platform_id` is the mirror's connection-qualified target_id
  // (`<vendor>_<entity>_<connection>_<native>`), so two portals of one vendor cannot
  // collide on the link's `(vendor, platform_id)` key — the same de-collision D-190
  // made for its mirror, inherited for free. `state: 'auto'` because this IS the
  // deterministic email match the enum's `'auto'` was defined for; the user promotes it
  // to `'confirmed'` by acting on it. `connection_name` is stamped so a per-connection
  // retract can cut precisely. Gated on a `vendor_entity` — an address book has no
  // platform record to link to.
  if (declaration.vendor_entity !== null) {
    for (const staged of toMirror) {
      if (!staged.changed && !resettled.has(staged.contact_id)) continue;
      if (failedKeys.has(staged.key)) continue;
      try {
        store.linkPlatformId({
          canonical_email: staged.canonical_email,
          vendor: declaration.vendor,
          platform_id: staged.key,
          state: 'auto',
          linked_at: now(),
          linked_by: 'auto:email_match',
          connection_name,
        });
        linked += 1;
      } catch (err) {
        // Same retry guard: a failed link must not advance the hash either, or it is
        // never attempted again.
        failedKeys.add(staged.key);
        failed_rows += 1;
        if (failures.length < 3) {
          failures.push(`${staged.key}: link ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // Mirror every matched record — including a dedupe loser (we DID see it, and it
  // becomes the winner the moment its fresher sibling is deleted) and a record whose
  // contributions failed (the raw payload is the audit trail, and the input to a
  // re-derive after a mapping fix — no re-fetch needed).
  for (const staged of toMirror) {
    if (!staged.changed && !resettled.has(staged.contact_id)) continue;
    // 🔑 The retry guard (see `failedKeys`). Mirroring a record whose write failed
    // would advance its snapshot_hash, and the next cycle would hash-skip it forever.
    if (failedKeys.has(staged.key)) continue;
    try {
      store.upsertContactSourceBlob(
        {
          contact_id: staged.contact_id,
          source_id,
          vendor: declaration.vendor,
          remote_id: staged.key,
          blob: staged.record.raw,
          snapshot_hash: staged.snapshot_hash,
          as_of: staged.record.as_of,
        },
        now(),
      );
    } catch (err) {
      // A mirror failure must not lose the contributions already written — the blob
      // is the audit trail, not the data. It re-mirrors next cycle (its hash is
      // still absent, so it never looks unchanged).
      //
      // But it is COUNTED, never merely swallowed: the mirror is what the hash-skip
      // and the delete diff both read, so a systematically failing upsert would make
      // every cycle re-hydrate from scratch, forever, while still reporting success.
      // A silent catch here would hide exactly that.
      mirror_failed += 1;
      if (failures.length < 3) {
        failures.push(`${staged.key}: mirror ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ONE materialize per touched contact, after every contribution for them has
  // landed. Materializing per-write would re-project the same person N times and,
  // worse, briefly project them from a HALF-written contribution set.
  for (const contact_id of touched) store.materializeContactProjection(contact_id, now());

  // ── 8. RECORD the cycle (D-205 item #1) ───────────────────────
  // Everything above this line was already true; the outcome simply had nowhere to
  // go. `await runContactSourceSync(...)` in the housekeeping step discarded it
  // whole, so a leaf that forgot a promised field failed every record, every cycle,
  // and the only trace was contacts quietly not gaining addresses. The counts ARE
  // the failure report — they are counted rather than thrown precisely so one bad
  // payload cannot abort the walk — and a report nobody keeps is not a report.
  const counts: ContactSourceCycleCounts = {
    hydrated,
    unchanged,
    skipped,
    created,
    promoted,
    disconnected,
    failed_rows,
    unkeyable,
    ambiguous,
    conflicted,
    repointed,
    mirror_failed,
    linked,
    complete: outcome.complete,
  };
  // A DEGRADED cycle still landed its good rows — but it does not bump
  // `last_success_at`, so the freshness reader treats the Source as stale however
  // recently it ran, and the next cycle re-attempts the same walk.
  syncState.markCompleted(source_id, {
    now: now(),
    error: degradationOf(counts, failures),
    counts,
  });

  return { ok: true, ...counts, failures };
};

// ────────────────────────────────────────────────────────────────
// Housekeeping task + wire
// ────────────────────────────────────────────────────────────────

export const contactSourceSyncTaskId = (source_id: string): string =>
  `contact-source-sync.${source_id}`;

const buildContactSourceSyncTask = (
  deps: ContactSourceSyncDeps,
  input: ContactSourceSyncInput,
): HousekeepingTaskInstance => ({
  meta: {
    id: contactSourceSyncTaskId(input.source_id),
    description:
      `Sync contact Source '${input.source_id}' from connection '${input.connection_name}'`,
    // One list walk per cycle — no mid-walk checkpoint.
    interruptible: false,
    kind: 'core',
    idle_eligible: true,
  },
  async step(ctx, _cursor, _budget_ms) {
    // A failed / degraded cycle is a RECORDED outcome, not a task error: an
    // operational failure — a missing credential, a transient vendor error, a
    // record that failed its supplies promise — is retried next idle window. We
    // never throw; the scheduler's error/disable machinery is reserved for
    // programming errors.
    //
    // ⚠ The result is STILL discarded here, and that is now correct: the runner
    // records its own outcome onto `contact_source_sync_state` (D-205 item #1). It
    // did not, for the whole of slices 6–7 — this comment claimed a "RECORDED
    // outcome" over a runner whose every count was dropped on the floor, which is
    // how a leaf that forgot a promised field could fail every record, every cycle,
    // in silence. The claim is now backed.
    await runContactSourceSync({ ...deps, now: deps.now ?? ctx.now }, input);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});

interface DesiredContactSource {
  id: string;
  connection_name: string;
  declaration: ContactSourceDeclaration;
  listContacts: ContactSourceListFn;
}

/** The contact Source (if any) one connection row syncs: its vendor must carry a
 *  `ContactSourceDeclaration` AND a resolved adapter leaf. Zero or one per
 *  connection (a connection is one vendor). */
const desiredContactSourcesFor = (
  row: ConnectionRow,
  resolveAdapter: ContactSourceAdapterResolver,
): DesiredContactSource[] => {
  const vendor = connectionVendorOf(row);
  if (vendor === null) return [];
  const declaration = getContactSourceDeclaration(vendor);
  if (declaration === null) return [];
  const listContacts = resolveAdapter(vendor);
  if (listContacts === undefined) return []; // no adapter leaf yet (slice 6)
  return [{
    // The SAME id `wireContactSourceBoot` mints — `(vendor, name, 'contact')`.
    id: CONNECTION_SOURCE_ID(vendor, row.name, 'contact'),
    connection_name: row.name,
    declaration,
    listContacts,
  }];
};

export interface WireContactSourceSyncInput {
  connectionStore: ConnectionStoreSqlite;
  store: ContactStore;
  /** D-205 item #1 — the per-Source health row the runner records onto, and the
   *  `source_freshness_degradation` producer reads back. */
  syncState: ContactSourceSyncStateStore;
  /** Resolve the per-vendor list leaf. Absent (slice 6) → no Source gets a sync
   *  task; the wire still attaches its connection observers, so slice 7's leaves
   *  light the tasks up with no wiring change. */
  resolveAdapter?: ContactSourceAdapterResolver;
  now?: () => number;
}

/** Wire one housekeeping sync task per contact Source (a connection whose vendor
 *  has a declaration + an adapter leaf). Idempotent boot scan + upsert/delete
 *  observers on the connection store, mirroring `wireFileSourceSync`. */
export const wireContactSourceSync = (input: WireContactSourceSyncInput): void => {
  const { connectionStore, store, syncState, resolveAdapter } = input;

  // Task ids this wire registered, per connection name → the task's source_id —
  // exact deregistration on vendor flips / deletes without re-deriving from the
  // (gone) row.
  const registered = new Map<string, Map<string, string>>();

  const reconcile = (row: ConnectionRow | null, connection_name: string): void => {
    const desired = row === null || resolveAdapter === undefined
      ? []
      : desiredContactSourcesFor(row, resolveAdapter);
    const desiredByTaskId = new Map(
      desired.map((d) => [contactSourceSyncTaskId(d.id), d] as const),
    );
    const current = registered.get(connection_name) ?? new Map<string, string>();
    for (const [taskId, source_id] of [...current]) {
      if (!desiredByTaskId.has(taskId)) {
        unregisterHousekeepingTask(taskId);
        // The health row is RUNTIME state — it dies with the task. (The mirrored
        // blobs and the contributions do NOT: removing those is the explicit
        // whole-Source teardown, a user decision, never a vendor flip's — D-205 §1.)
        syncState.deleteForSource(source_id);
        current.delete(taskId);
      }
    }
    for (const [taskId, d] of desiredByTaskId) {
      // 🔑 SKIP-IF-EXISTS IS CORRECT HERE — AND IT IS NOT IN THE WORK-ENTITY
      // SIBLING. The three source-sync reconcilers read identically, so the
      // shape is not the discriminator; WHERE THE DECLARATION COMES FROM is.
      //
      // `work-entity-source-sync` derives its declaration from the CATALOG
      // MANIFEST, which a pack reinstall rewrites under a stable `source_id`.
      // Skipping an already-registered task there left the previous
      // declaration captured in a live closure, so that site compares a
      // contract hash and re-registers on change (D-192 follow-on #2,
      // `d-192-sync-reconcile-stale-closure.test.ts`).
      //
      // A contact Source's declaration is `CONTACT_SOURCE_DECLARATIONS` — compiled in, keyed by
      // vendor, and the vendor is part of the `source_id`. It cannot change
      // under a stable id: a different vendor is a different Source, which the
      // deregister pass above and the register below already handle. A hash
      // here would compare a constant against itself.
      //
      // ⚠ Reviewed 2026-09-22 and left deliberately. This loop LOOKS like the
      // pre-fix work-entity code, which is exactly why it keeps attracting a
      // "missing hash" fix; adding one buys nothing and costs a hash per
      // reconcile.
      if (getHousekeepingTask(taskId) === undefined) {
        // Seed the health row at registration — seed-IF-ABSENT, so health survives a
        // boot re-scan and a fresh Source starts honestly never-synced (rather than
        // looking clean because nothing has run yet).
        if (syncState.get(d.id) === null) {
          syncState.upsert(initialContactSourceSyncState(d.id));
        }
        registerHousekeepingTask(buildContactSourceSyncTask(
          {
            store,
            syncState,
            listContacts: d.listContacts,
            ...(input.now ? { now: input.now } : {}),
          },
          { source_id: d.id, connection_name, declaration: d.declaration },
        ));
      }
      current.set(taskId, d.id);
    }
    if (current.size > 0) registered.set(connection_name, current);
    else registered.delete(connection_name);
  };

  // Boot scan — every already-enrolled api connection.
  for (const row of connectionStore.list({ kind: 'api' })) reconcile(row, row.name);

  // Future enrollments + vendor flips. Non-api upserts are ignored (a non-api row
  // may coexist with an api row under the same name).
  connectionStore.addOnUpsert((row) => {
    if (row.kind === 'api') reconcile(row, row.name);
  });

  // Deletions — the desired set is empty; every task this wire registered for the
  // name deregisters.
  connectionStore.addOnDelete((kind, name) => {
    if (kind === 'api') reconcile(null, name);
  });
};
