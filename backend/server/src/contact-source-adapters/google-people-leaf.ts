/** D-205 #4c — the Google Contacts leaf. The first `full_import` source, and the
 *  first contact Source that is not a CRM.
 *
 *  ── It dispatches the PACK's own operation ───────────────────────────────────
 *  The obvious leaf would hand-roll a People API client: an HTTP call, an auth
 *  header, a paginator, a rate-limit budget, a completeness proof. All of it would
 *  duplicate machinery that already exists and is already GATED and AUDITED.
 *
 *  `community/packs/google-contacts.json` declares the whole surface — the D-194
 *  `connection_requirements` (vendor `google`, base `people.googleapis.com`,
 *  oauth2_refresh), the `contacts.readonly` scope (UNIONed into the enroll request
 *  per installed pack, so a Drive-only user is never asked for their contacts), and
 *  the operation this leaf wants: **`contact.connections.list`** — GET
 *  `/v1/people/me/connections`, `result_path: "connections"`.
 *
 *  So the leaf dispatches THAT, through `runSourceMirrorFetch` → the catalog
 *  gateway. Every call is admitted against the connection's grant and lands in the
 *  `connection_gateway` audit log, exactly like a recipe's would. Zero HTTP here.
 *
 *  ── The gateway does the WALK, and that is why it can prove completeness ────
 *  The delete diff is absence-based, so it is only ever as safe as its completeness
 *  proof — and the leaf CANNOT build one itself: People's `nextPageToken` lives at
 *  the response ROOT, outside `result_path`, so a leaf reading records never sees
 *  the cursor. Only the gateway's follower does.
 *
 *  Which is why the pack now declares its pagination (`style: 'query_token'`,
 *  `nextPageToken` → `?pageToken=`) — the D-192 #8g generic contract whose own
 *  docstring names Google as the canonical example. The gateway walks every page,
 *  bounded by `PAGINATION_MAX_RECORDS` / `PAGINATION_MAX_PAGES`, and reports
 *  `complete` — TRUE only when it PROVABLY reached the end. We pass that straight
 *  through. A truncated walk yields `complete: false` ⇒ **zero disconnects**, which
 *  is the D-190 fail-closed rule: absence from a partial list proves nothing.
 *
 *  ⚠ Before that declaration existed the gateway returned the FIRST PAGE with
 *  `truncated: false` — indistinguishable from a complete walk by `!truncated`
 *  alone. A contact book imported to page one, silently.
 *
 *  ── `myContacts`, never `otherContacts` ─────────────────────────────────────
 *  `people/me/connections` is the user's SAVED contacts — the people they chose to
 *  keep. The pack also declares `other_contact.*`, and this leaf must NEVER read it:
 *  Google auto-collects an "other contact" for every address you have ever emailed.
 *  That is junk, it is not a list anyone curated, and it is a duplicate of what mail
 *  traffic already gave the warehouse for free.
 *
 *  ── The shape-wrangling lives HERE, and only here ───────────────────────────
 *  This is the §0 "only what can't generalize" half. A contact is not FLAT: People
 *  returns `emailAddresses[]`, `phoneNumbers[]`, `addresses[]`, `organizations[]`,
 *  each multi-valued with primary flags, and an address is six vendor fields
 *  composed into one object. No path-map expresses "the primary email of N" — which
 *  is the argument `contact-sources.ts`'s header makes at length, using this exact
 *  API as its worked example.
 *
 *  Spec: D-205 §2 + working-order #4. */

import {
  canonicalizeEmail,
  canonicalizeMailingAddress,
  type ContactAliasKind,
  type ContactAttributeKind,
  type RecipeDefinition,
} from '@recued/contracts';

import {
  runSourceMirrorFetch,
  type SourceMirrorFetchDeps,
} from '../source-mirror/fetch.js';
import type {
  ContactSourceListFn,
  ContactSourceListOutcome,
  ContactSourceRecord,
} from '../contact-source-sync.js';

/** The pack operation this leaf dispatches. `people/me/connections` = the user's
 *  SAVED contacts. ⛔ NOT `other_contact.list` — see the header. */
const LIST_OP = 'contact.connections.list';

/** Minimal recipe identity for the scoped gateway ctx — audit rows attribute these
 *  fetches to the contact-source sync rather than to a recipe nobody ran. Never
 *  installed, never executed. Twin of `work-entity-source-sync`'s. */
const CONTACT_SOURCE_SYNC_RECIPE: RecipeDefinition = {
  recipe_id: 'contact-source-sync',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Contact Source sync',
    description:
      'Synthetic identity for declared contact Source sync fetches (D-205 #4). Not an installable recipe.',
    author: 'recued',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
};

/** `personFields` is REQUIRED by the People API and selects what comes back. It
 *  must cover exactly what the declaration `supplies` — no more (we do not fetch
 *  what we will not use) and no less (a missing field fails the supplies promise on
 *  every record).
 *
 *  ⚠ `metadata` is not a contribution — it carries `sources[].updateTime`, which is
 *  the record's own last-modified and therefore its `as_of`. Without it the C-2a
 *  recency tiebreak would compare ingestion times and the freshest-wins rule would
 *  silently become last-synced-wins. */
const PERSON_FIELDS = [
  'names',
  'emailAddresses',
  'phoneNumbers',
  'organizations',
  'addresses',
  'photos',
  'metadata',
].join(',');

/** Every field the SUPPLIES promise covers must appear on EVERY record — an
 *  explicit `[]` / `null` says "I looked and this person has none"; a MISSING key
 *  says the leaf never looked, and the runner fails the record for it. These are the
 *  key sets that must always be emitted. */
const SUPPLIED_ALIASES: readonly ContactAliasKind[] = ['email_alias', 'phone_alias'];
const SUPPLIED_ATTRIBUTES: readonly ContactAttributeKind[] = [
  'name',
  'org',
  'address',
  'photo',
];

// ────────────────────────────────────────────────────────────────
// People's shape → the canonical one
// ────────────────────────────────────────────────────────────────

const asArray = (v: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(v) ? (v.filter((x) => x !== null && typeof x === 'object') as Record<string, unknown>[]) : [];

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

/** Google marks at most one entry per multi-valued field `metadata.primary: true`.
 *  Prefer it; fall back to the first entry, because a contact whose email is not
 *  flagged primary still HAS an email. */
const primaryFirst = (
  entries: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] => {
  const primary = entries.filter(
    (e) => (e.metadata as Record<string, unknown> | undefined)?.primary === true,
  );
  const rest = entries.filter(
    (e) => (e.metadata as Record<string, unknown> | undefined)?.primary !== true,
  );
  return [...primary, ...rest];
};

/** EVERY address on the record, primary first.
 *
 *  ⚠ All of them, deliberately — People is genuinely multi-valued and a person's
 *  second address is still THEIR address. That is the slice-4 address space working
 *  as designed (and D-205 #3.5b is what makes those extra addresses readable in
 *  reverse, so the reads a producer runs for this contact actually span them). */
const emailsOf = (person: Record<string, unknown>): string[] => {
  const out: string[] = [];
  for (const e of primaryFirst(asArray(person.emailAddresses))) {
    const canonical = canonicalizeEmail(str(e.value) ?? '');
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
};

/** Phones, primary first. `canonicalForm` is People's own E.164 — prefer it over
 *  the raw `value` the user typed, which may be "(555) 010-0100". */
const phonesOf = (person: Record<string, unknown>): string[] => {
  const out: string[] = [];
  for (const p of primaryFirst(asArray(person.phoneNumbers))) {
    const phone = str(p.canonicalForm) ?? str(p.value);
    if (phone && !out.includes(phone)) out.push(phone);
  }
  return out;
};

const nameOf = (person: Record<string, unknown>): string | null => {
  for (const n of primaryFirst(asArray(person.names))) {
    const display = str(n.displayName);
    if (display) return display;
    const composed = [str(n.givenName), str(n.familyName)].filter((x) => x !== null).join(' ');
    if (composed.length > 0) return composed;
  }
  return null;
};

const orgOf = (person: Record<string, unknown>): string | null => {
  for (const o of primaryFirst(asArray(person.organizations))) {
    const name = str(o.name);
    if (name) return name;
  }
  return null;
};

/** The first address that CANONICALIZES.
 *
 *  🔑 `canonicalizeMailingAddress` returns null unless street + city + zip + country
 *  are all present — and that strictness is the point: this value feeds D-138's
 *  `address_zip_country_key` blocking key, and a HALF address would produce a
 *  blocking key that matches the wrong people. A partial address is worse than none,
 *  so an incomplete one contributes nothing and the record still lands. */
const addressOf = (person: Record<string, unknown>): unknown | null => {
  for (const a of primaryFirst(asArray(person.addresses))) {
    const canonical = canonicalizeMailingAddress({
      address1: str(a.streetAddress) ?? undefined,
      address2: str(a.extendedAddress) ?? undefined,
      city: str(a.city) ?? undefined,
      state: str(a.region) ?? undefined,
      zip: str(a.postalCode) ?? undefined,
      country: str(a.country) ?? str(a.countryCode) ?? undefined,
    });
    if (canonical !== null) return canonical;
  }
  return null;
};

/** The photo URL — never the bytes (C-2's North star: bytes are NEVER fetched).
 *
 *  ⛔ `default: true` is Google's generated placeholder avatar (the grey silhouette
 *  with an initial). It is not a photo OF anyone. Storing it would render a fake
 *  face on the contact detail page and, worse, make "has a photo" true for every
 *  contact Google has ever heard of. */
const photoOf = (person: Record<string, unknown>): string | null => {
  for (const p of primaryFirst(asArray(person.photos))) {
    if (p.default === true) continue;
    const url = str(p.url);
    if (url) return url;
  }
  return null;
};

/** The record's OWN last-modified — EVENT time, never ingestion time (D-120
 *  bistemporal). It drives the C-2a recency tiebreak between two same-rung sources,
 *  so reading the clock here instead would silently turn freshest-wins into
 *  last-synced-wins. People carries it at `metadata.sources[].updateTime` (RFC3339).
 *  Absent ⇒ fall back to `now`, and that fallback is the honest upper bound rather
 *  than a fabricated one. */
const asOfMs = (person: Record<string, unknown>, now: number): number => {
  const meta = person.metadata as Record<string, unknown> | undefined;
  let newest: number | null = null;
  for (const s of asArray(meta?.sources)) {
    const raw = str(s.updateTime);
    if (raw === null) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest ?? now;
};

/** One People `person` → one canonical `ContactSourceRecord`. Null when the record
 *  carries no `resourceName` — unkeyable, and the runner counts it (an unkeyable row
 *  also poisons the delete proof, so it must never be silently dropped). */
const toContactRecord = (
  person: Record<string, unknown>,
  now: number,
): ContactSourceRecord | null => {
  const remote_id = str(person.resourceName);
  if (remote_id === null) return null;

  // EVERY supplied kind gets a key, always. `[]` / `null` = "I looked, and this
  // person has none"; a MISSING key = "I never looked", which is a hard record
  // failure. That distinction is the whole anti-silence device.
  const aliases: Partial<Record<ContactAliasKind, readonly string[]>> = {};
  for (const kind of SUPPLIED_ALIASES) aliases[kind] = [];
  aliases.email_alias = emailsOf(person);
  aliases.phone_alias = phonesOf(person);

  const attributes: Partial<Record<ContactAttributeKind, unknown>> = {};
  for (const kind of SUPPLIED_ATTRIBUTES) attributes[kind] = null;
  attributes.name = nameOf(person);
  attributes.org = orgOf(person);
  attributes.address = addressOf(person);
  attributes.photo = photoOf(person);

  return {
    remote_id,
    as_of: asOfMs(person, now),
    // The vendor payload verbatim — the audit trail behind every contribution this
    // record makes, and the evidence that outlives a claim (D-205 §1: a vendor
    // delete destroys the mirror row's LINK, never the receipt).
    raw: person,
    aliases,
    attributes,
  };
};

// ────────────────────────────────────────────────────────────────
// The leaf
// ────────────────────────────────────────────────────────────────

export interface GooglePeopleLeafDeps {
  /** The gated + audited catalog-op dispatcher's deps — the same bundle the
   *  work-entity source sync uses. */
  fetchDeps: SourceMirrorFetchDeps;
  now?: () => number;
}

export const createGooglePeopleLeaf = (deps: GooglePeopleLeafDeps): ContactSourceListFn => {
  const now = deps.now ?? ((): number => Date.now());

  return async (request): Promise<ContactSourceListOutcome> => {
    const { connection_name } = request;

    // The catalog binding, fail-closed at each hop. A connection with no profile is
    // not enrolled; a profile with no catalog is bound to nothing; a manifest
    // without the op cannot serve it. Each is a CONFIG fault the user can act on —
    // never a silent empty list, which the runner would read as "you have no
    // contacts" and, on a complete walk, as "they were all deleted".
    const profile = deps.fetchDeps.profiles.get(connection_name);
    if (profile === null) {
      return {
        ok: false,
        kind: 'config',
        reason: `connection '${connection_name}' has no operation profile (not enrolled?)`,
      };
    }
    const catalogSlug = profile.catalog_slug;
    if (catalogSlug === undefined || catalogSlug.length === 0) {
      return {
        ok: false,
        kind: 'config',
        reason: `connection '${connection_name}' carries no catalog binding — cannot resolve '${LIST_OP}'`,
      };
    }
    const manifest = deps.fetchDeps.executorConfig.manifests.get(catalogSlug) ?? null;
    if (manifest === null) {
      return {
        ok: false,
        kind: 'config',
        reason: `catalog manifest '${catalogSlug}' is not installed — install the google-contacts pack`,
      };
    }
    const opRow = manifest.operations?.[LIST_OP];
    if (opRow === undefined) {
      return {
        ok: false,
        kind: 'config',
        reason: `catalog '${catalogSlug}' declares no '${LIST_OP}' operation — this connection is not a contact book`,
      };
    }
    const resultPath = opRow.result_path ?? manifest.surfaces?.api?.result_path;
    if (resultPath === undefined || resultPath.length === 0) {
      return {
        ok: false,
        kind: 'config',
        reason: `catalog '${catalogSlug}' declares no result_path for '${LIST_OP}' — cannot locate the record envelope`,
      };
    }

    const outcome = await runSourceMirrorFetch(deps.fetchDeps, {
      connection_name,
      manifest,
      catalogSlug,
      operationKey: LIST_OP,
      // `personFields` is required by the API. Page size + `pageToken` are the
      // GATEWAY's to write — the pack declares the pagination contract and the
      // follower drives it; setting them here would fight it.
      args: { 'query.personFields': PERSON_FIELDS },
      resultPath,
      // Raw mode: we want People's own shape, not a projection. The
      // shape-wrangling is this leaf's whole job.
      projectionTemplate: null,
      idField: 'resourceName',
      auditRecipe: CONTACT_SOURCE_SYNC_RECIPE,
      stepId: 'contact_source_sync',
    });

    if (!outcome.ok) return { ok: false, kind: outcome.kind, reason: outcome.reason };

    const t = now();
    const records: ContactSourceRecord[] = [];
    for (const person of outcome.records.values()) {
      const rec = toContactRecord(person as Record<string, unknown>, t);
      // A record with no `resourceName` is unkeyable. Emitting it with an empty
      // remote_id lets the RUNNER count it (`unkeyable`) — and an unkeyable row
      // fail-closes the delete proof for the cycle, which is exactly right: a record
      // we cannot key is a record we cannot prove absent. Dropping it here would
      // hide that from the health surface.
      records.push(rec ?? { remote_id: '', as_of: t, raw: person, aliases: {}, attributes: {} });
    }

    return {
      ok: true,
      records,
      // 🔑 The gateway's own proof, passed through UNCHANGED. True only when the
      // pagination follower PROVABLY reached the end. `!truncated` is NOT the same
      // thing — a catalog that declares no pagination returns page one with
      // `truncated: false`, and reading that as complete would tear the linkage off
      // every contact past the first page. Fail-closed: no proof ⇒ no disconnects.
      complete: outcome.complete,
    };
  };
};
