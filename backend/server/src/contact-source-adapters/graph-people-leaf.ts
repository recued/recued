/** The Microsoft Graph contacts leaf — the SECOND contact book.
 *
 *  ⛔ **It does NOT share the mail/calendar grant, and an earlier draft of this
 *  header said it did.** Mail and calendar are COLLECTIONS: they enroll through
 *  `collection.{mail,calendar}.enrollOAuth` and share credentials at
 *  `account.graph.<slug>.*`. A contact Source is driven by a **connection row**
 *  (`contact-source-sync.ts:1246` — `connection_name: row.name` off
 *  `ConnectionStoreSqlite`), i.e. a `connection.api` record enrolled in
 *  Settings → Connections. Two different credential stores for the same vendor.
 *
 *  🔑 That is good news operationally: enrolling contacts cannot clobber the
 *  mailbox grant, so nothing here needs the guard `calendar/enroll.ts:259` exists
 *  for. What contacts CAN share is another **pack's** Microsoft connection —
 *  `findEndpointCandidates` offers an existing row by `api_base` HOST, so an
 *  `outlook` / `onedrive` / `teams` connection is adoptable, and adopting it
 *  re-consents to add `Contacts.Read`.
 *
 *  ── It dispatches the PACK's own operation, exactly as `google-people-leaf` does ─
 *  `community/packs/microsoft-contacts.json` declares the whole surface: the D-194
 *  `connection_requirements` (vendor `microsoft`, base `graph.microsoft.com/v1.0`,
 *  oauth2_refresh + PKCE), the `Contacts.Read` scope (UNIONed into the enroll
 *  request per installed pack, so a OneDrive-only user is never asked for their
 *  contacts), and the operation this leaf wants: **`contact.list`** — GET
 *  `/me/contacts`, `result_path: "value"`.
 *
 *  So the leaf dispatches THAT through `runSourceMirrorFetch` → the catalog
 *  gateway. Every call is admitted against the connection's grant and lands in the
 *  `connection_gateway` audit log. Zero HTTP here.
 *
 *  ── Pagination: `@odata.nextLink`, and the page size is NOT decoration ────────
 *  The delete diff is absence-based, so it is only ever as safe as its completeness
 *  proof, and only the gateway's follower can build one. The pack declares
 *  `style: 'next_path', path: '@odata.nextLink'` — the D-192 CORE #8f case that
 *  names Graph explicitly: an absolute same-origin URL, resolved through
 *  `safeSameOriginPathFromLink` (origin pinned against the connection base), so a
 *  cross-origin link is blocked rather than followed.
 *
 *  ⚠ **The pack also declares `$top: 100`, and omitting it would silently cap the
 *  import.** Graph's default page for `/me/contacts` is 10 items;
 *  `PAGINATION_MAX_PAGES` is 25. Ten-per-page × 25 pages = **250 contacts**, after
 *  which the walk truncates, `complete` goes false, and — correctly, fail-closed —
 *  zero disconnects happen. But the contact book would import to 250 and stop. At
 *  `$top: 100` the walk reaches `PAGINATION_MAX_RECORDS` (1000) in ten pages,
 *  comfortably inside the page ceiling.
 *
 *  ⚠ The pack declares no `page_size.max`, deliberately: Microsoft's published
 *  OpenAPI documents `$top` with `minimum: 0` and NO maximum, and `max` is the
 *  *provider's documented* maximum. Inventing one would be a fabricated contract.
 *
 *  ── `/me/contacts`, and the item-level read does not exist to declare ────────
 *  Microsoft's published Graph v1.0 OpenAPI carries **282 `/me/*` paths and ZERO
 *  item-level `/me/<collection>/{id}` paths** — verified against both the
 *  `openapi.yaml` and `default.yaml` variants at the pinned SHA. `/me/contacts/{id}`
 *  is a real API route but is absent from the contract, so the pack cannot declare
 *  a `contact.read` op that the publish op-prover could admit. This leaf needs only
 *  the list, so nothing is lost here — but it is why the pack ships two ops.
 *
 *  ── The shape-wrangling lives HERE, and only here ───────────────────────────
 *  Graph's contact is not flat either: `emailAddresses[]` are `{address, name}`
 *  objects, phones arrive across THREE separate fields, and an address is five
 *  vendor fields composed into one object — across three address slots.
 *
 *  Twin of `google-people-leaf.ts`. Spec: D-205 §2. */

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

/** The pack operation this leaf dispatches. */
const LIST_OP = 'contact.list';

/** Minimal recipe identity for the scoped gateway ctx — audit rows attribute these
 *  fetches to the contact-source sync rather than to a recipe nobody ran. Never
 *  installed, never executed. Twin of the Google leaf's. */
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

/** `$select` bounds what Graph returns. It must cover exactly what the declaration
 *  `supplies` — no more (we do not fetch what we will not use) and no less (a
 *  missing field fails the supplies promise on every record).
 *
 *  ⚠ `lastModifiedDateTime` is not decoration — it is the record's own
 *  last-modified and therefore its `as_of`. Without it the C-2a recency tiebreak
 *  would compare ingestion times and freshest-wins would silently become
 *  last-synced-wins.
 *
 *  ⛔ No `photo`: Graph's is a navigation property returning BYTES, never a URL.
 *  See the declaration's note in `contact-sources.ts`. */
const SELECT_FIELDS = [
  'id',
  'displayName',
  'givenName',
  'surname',
  'emailAddresses',
  'businessPhones',
  'homePhones',
  'mobilePhone',
  'companyName',
  'businessAddress',
  'homeAddress',
  'otherAddress',
  'lastModifiedDateTime',
].join(',');

/** Every field the SUPPLIES promise covers must appear on EVERY record — an
 *  explicit `[]` / `null` says "I looked and this person has none"; a MISSING key
 *  says the leaf never looked, and the runner fails the record for it. */
const SUPPLIED_ALIASES: readonly ContactAliasKind[] = ['email_alias', 'phone_alias'];
const SUPPLIED_ATTRIBUTES: readonly ContactAttributeKind[] = ['name', 'org', 'address'];

// ────────────────────────────────────────────────────────────────
// Graph's shape → the canonical one
// ────────────────────────────────────────────────────────────────

const asArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

const asObjectArray = (v: unknown): readonly Record<string, unknown>[] =>
  asArray(v).filter(
    (x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x),
  );

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

/** Every email on the record, in Graph's own order.
 *
 *  ⚠ Graph has NO primary flag on `emailAddresses` — unlike People's
 *  `metadata.primary`. The array order IS the user's ordering in Outlook, so it is
 *  preserved as-is rather than invented. Deduped after canonicalization because a
 *  contact legitimately carries the same address twice under different labels. */
const emailsOf = (contact: Record<string, unknown>): string[] => {
  const out: string[] = [];
  for (const entry of asObjectArray(contact.emailAddresses)) {
    const canonical = canonicalizeEmail(str(entry.address) ?? '');
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
};

/** Phones across all THREE Graph fields.
 *
 *  ⚠ `mobilePhone` is a bare string; `businessPhones` / `homePhones` are arrays.
 *  Mobile goes first because it is the one a person actually answers, then business,
 *  then home — Graph itself expresses no precedence, so this ordering is ours and is
 *  stated rather than implied.
 *
 *  ⚠ Graph returns whatever the user typed — there is no E.164 canonical form on the
 *  contact resource (People has `canonicalForm`; Graph does not). The raw string is
 *  emitted as-is; `phone_alias` is not a join key, so no resolver depends on its
 *  shape. */
const phonesOf = (contact: Record<string, unknown>): string[] => {
  const out: string[] = [];
  const push = (v: unknown): void => {
    const phone = str(v);
    if (phone && !out.includes(phone)) out.push(phone);
  };
  push(contact.mobilePhone);
  for (const p of asArray(contact.businessPhones)) push(p);
  for (const p of asArray(contact.homePhones)) push(p);
  return out;
};

/** `displayName` is what Outlook shows and what the user curated. Fall back to
 *  composing the parts, because a contact with only a first name still HAS a name. */
const nameOf = (contact: Record<string, unknown>): string | null => {
  const display = str(contact.displayName);
  if (display) return display;
  const composed = [str(contact.givenName), str(contact.surname)]
    .filter((x): x is string => x !== null)
    .join(' ');
  return composed.length > 0 ? composed : null;
};

/** `companyName` — a genuine string on the contact itself, not a cross-entity link.
 *  That is what makes `org` safe to promise here when Salesforce and Pipedrive
 *  cannot. */
const orgOf = (contact: Record<string, unknown>): string | null =>
  str(contact.companyName);

/** The first address that CANONICALIZES, tried business → home → other.
 *
 *  🔑 `canonicalizeMailingAddress` returns null unless street + city + zip + country
 *  are all present, and that strictness is the point: this value feeds D-138's
 *  `address_zip_country_key` blocking key, and a HALF address would produce a
 *  blocking key that matches the wrong people.
 *
 *  ⚠ Business first is a deliberate choice for a work-oriented contact book, and it
 *  is the one place this leaf's ordering differs in KIND from Google's (which sorts
 *  by the vendor's own primary flag — Graph has none to sort by). */
const addressOf = (contact: Record<string, unknown>): unknown | null => {
  for (const key of ['businessAddress', 'homeAddress', 'otherAddress'] as const) {
    const raw = contact[key];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const a = raw as Record<string, unknown>;
    const canonical = canonicalizeMailingAddress({
      address1: str(a.street) ?? undefined,
      city: str(a.city) ?? undefined,
      state: str(a.state) ?? undefined,
      zip: str(a.postalCode) ?? undefined,
      country: str(a.countryOrRegion) ?? undefined,
    });
    if (canonical !== null) return canonical;
  }
  return null;
};

/** The record's OWN last-modified — EVENT time, never ingestion time (D-120
 *  bistemporal). Graph carries it as `lastModifiedDateTime` (ISO 8601, inherited
 *  from `outlookItem`). Absent or unparseable ⇒ fall back to `now`, the honest
 *  upper bound rather than a fabricated one. */
const asOfMs = (contact: Record<string, unknown>, now: number): number => {
  const raw = str(contact.lastModifiedDateTime);
  if (raw === null) return now;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : now;
};

/** One Graph `contact` → one canonical `ContactSourceRecord`. Null when the record
 *  carries no `id` — unkeyable, and the runner must count it (an unkeyable row also
 *  poisons the delete proof, so it must never be silently dropped). */
const toContactRecord = (
  contact: Record<string, unknown>,
  now: number,
): ContactSourceRecord | null => {
  const remote_id = str(contact.id);
  if (remote_id === null) return null;

  // EVERY supplied kind gets a key, always. `[]` / `null` = "I looked, and this
  // person has none"; a MISSING key = "I never looked", which is a hard record
  // failure. That distinction is the whole anti-silence device.
  const aliases: Partial<Record<ContactAliasKind, readonly string[]>> = {};
  for (const kind of SUPPLIED_ALIASES) aliases[kind] = [];
  aliases.email_alias = emailsOf(contact);
  aliases.phone_alias = phonesOf(contact);

  const attributes: Partial<Record<ContactAttributeKind, unknown>> = {};
  for (const kind of SUPPLIED_ATTRIBUTES) attributes[kind] = null;
  attributes.name = nameOf(contact);
  attributes.org = orgOf(contact);
  attributes.address = addressOf(contact);

  return {
    remote_id,
    as_of: asOfMs(contact, now),
    // The vendor payload verbatim — the audit trail behind every contribution this
    // record makes, and the evidence that outlives a claim.
    raw: contact,
    aliases,
    attributes,
  };
};

// ────────────────────────────────────────────────────────────────
// The leaf
// ────────────────────────────────────────────────────────────────

export interface GraphPeopleLeafDeps {
  /** The gated + audited catalog-op dispatcher's deps — the same bundle the
   *  work-entity source sync and the Google leaf use. */
  fetchDeps: SourceMirrorFetchDeps;
  now?: () => number;
}

export const createGraphPeopleLeaf = (deps: GraphPeopleLeafDeps): ContactSourceListFn => {
  const now = deps.now ?? ((): number => Date.now());

  return async (request): Promise<ContactSourceListOutcome> => {
    const { connection_name } = request;

    // The catalog binding, fail-closed at each hop. Each miss is a CONFIG fault the
    // user can act on — never a silent empty list, which the runner would read as
    // "you have no contacts" and, on a complete walk, as "they were all deleted".
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
        reason: `catalog manifest '${catalogSlug}' is not installed — install the microsoft-contacts pack`,
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
      // `$select` bounds the payload to exactly what `supplies` promises. `$top` and
      // the `@odata.nextLink` walk are the GATEWAY's to drive — the pack declares
      // the pagination contract and the follower runs it; setting them here would
      // fight it.
      args: { 'query.$select': SELECT_FIELDS },
      resultPath,
      // Raw mode: we want Graph's own shape, not a projection. The shape-wrangling
      // is this leaf's whole job.
      projectionTemplate: null,
      idField: 'id',
      auditRecipe: CONTACT_SOURCE_SYNC_RECIPE,
      stepId: 'contact_source_sync',
    });

    if (!outcome.ok) return { ok: false, kind: outcome.kind, reason: outcome.reason };

    const t = now();
    const records: ContactSourceRecord[] = [];
    for (const contact of outcome.records.values()) {
      const rec = toContactRecord(contact as Record<string, unknown>, t);
      // A record with no `id` is unkeyable. Emitting it with an empty remote_id lets
      // the RUNNER count it (`unkeyable`) — and an unkeyable row fail-closes the
      // delete proof for the cycle, which is exactly right: a record we cannot key
      // is a record we cannot prove absent. Dropping it here would hide that from
      // the health surface.
      records.push(rec ?? { remote_id: '', as_of: t, raw: contact, aliases: {}, attributes: {} });
    }

    return {
      ok: true,
      records,
      // 🔑 The gateway's own proof, passed through UNCHANGED. True only when the
      // pagination follower PROVABLY reached the end. `!truncated` is NOT the same
      // thing — reading that as complete would tear the linkage off every contact
      // past the first page. Fail-closed: no proof ⇒ no disconnects.
      complete: outcome.complete,
    };
  };
};
