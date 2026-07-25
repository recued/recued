/** D-167 (recall path, off-cap) — the contact-derived recall RESOLVER.
 *
 *  Builds the memory-recall aliasing surface the chat egress uses to alias a
 *  `memory.*` tool result against the contact warehouse, closing the cross-session
 *  recall leak: today's egress aliases only ledger-known values, so a recalled
 *  artifact whose PII was never surfaced this session goes out RAW (see the
 *  `pii-memory-recall-leak-confirmed` note). Two paths, BOTH store-wide (no
 *  `PREFETCH_SCAN_MAX` cap — the off-cap follow-on):
 *    · NAME/ORG — a whole-warehouse Aho-Corasick automaton over EVERY contact
 *      name/company (`listAllNamesAndCompanies`, B4-filtered). The A-C build is flat
 *      to the value count + memoised once per recalling turn (measured ~180ms @ 50k),
 *      and matching a recalled artifact is ONE O(text) pass — the matcher was
 *      designed for 100k values. No cap → no name missed above 10k.
 *    · IDENTIFIER (email/phone) — TEXT-DRIVEN: extract the email/phone candidates
 *      PRESENT in the recalled text. Bounded by the (small) text, never the warehouse
 *      — this replaces the old pre-seed-EVERY-identifier behaviour, which ballooned
 *      the session ledger to ~2N rows and cost ~1s/turn already at the 10k cap
 *      (~12s @ 50k). The two kinds then diverge:
 *        - EMAIL — seeded UNCONDITIONALLY (2026-07-11). Every email present in the
 *          recalled text is aliased whether or not it resolves to a contact: an email
 *          is PII regardless of the address book, and the known-only filter used to
 *          DROP the misses and egress them RAW. That became the dominant hole when
 *          `memory.search` started returning up to 16 KB of FREE-TEXT memory bodies —
 *          a memory can name anyone, and such a value lives in NO warehouse entity, so
 *          widening the entity index provably cannot reach it. Free: the candidates are
 *          already extracted, the regex is unambiguous, and `aliasEmail` is value-keyed
 *          + store-free, so an unknown email restores like any other (the HARD invariant).
 *        - PHONE — still resolved store-wide + exact against the warehouse
 *          (`resolveRecallIdentifiers`). It CANNOT go unconditional: the candidate
 *          `forms` are bare DIGIT-STRINGS (an invoice number, a year, a quantity), so
 *          seeding them all would alias `2026` into a phone — corruption, not
 *          protection. The store lookup is what disambiguates a digit-run into a phone.
 *
 *  CRM (Tier 2, 2026-07-12) — BOTH legs also read the CRM record mirror, because a
 *  CRM contact IS NOT a warehouse contact. `ContactSource` is `email_from | email_to |
 *  calendar_attendee | manual` (no CRM member); nothing in the CRM ingest calls
 *  `observe`/`upsertManual`; `contact_platform_link` only LINKS a platform id onto an
 *  ALREADY-EXISTING contact. So a person who lives only in your CRM — never emailed
 *  you, never on an invite — has NO `contacts` row, was invisible to both legs above,
 *  and their name + phone egressed RAW out of a recalled memory body. The mirror
 *  (`crm_record_mirror`) is where that PII actually lives, so:
 *    · NAME/ORG — CRM person names + org names UNION into the same whole-warehouse
 *      A-C (same B4 gate). Which `meta` key means what is declared ONCE, keyed on the
 *      closed `crm_alias` enum, in `CRM_RECALL_SEED_FIELDS` — `meta.name` is a PERSON
 *      on a `contact`, an ORG on an `account`, and a DEAL TITLE on a `deal` (not
 *      seeded at all). Scopes are enumerated from the **LIVE merged** vendor registry
 *      (`liveVendorRegistry` — built-ins PLUS each installed pack's lifted entities),
 *      NOT the frozen module-level `CONNECTION_VENDOR_ENTITIES`: a 3rd-party CRM pack
 *      (Zoho / Dynamics / …) lifts into an "ephemeral per-install registry, never the
 *      module-level boot-validated one", yet the housekeeping reconciler walks the LIVE
 *      registry and so really does write `crm_record_mirror` rows for it. Enumerating
 *      the static array would leave those scopes unseen — rows present, never seeded,
 *      name + phone RAW to the model. (Pipedrive would have masked this: it is a pack
 *      AND a hardcoded built-in.)
 *    · PHONE — a form→phone map built from the mirror's phones once per turn (the
 *      in-memory twin of the contact store's trigger-maintained `contact_phone_forms`),
 *      derived through the SAME `phoneMatchDigits` the SQL `phone_match_forms_json`
 *      wraps — so a CRM form can never drift from a contact one, and a drifted form
 *      would be a MISS = a leak.
 *  Both read through `listMetaValues`, which is UNCAPPED on purpose: the mirror's
 *  `list()` clamps at 200 rows (it feeds a bounded chat surface), and seeding from a
 *  capped read would silently skip the 201st contact — under-returning here is not a
 *  smaller answer, it is a leak.
 *
 *  Returned as a `RecallResolver`: the per-turn-memoised name/org `RecallIndex` (the
 *  A-C, empty identifier seeds) + a `resolveIdentifiers(text)` the egress calls per
 *  recall result to get the text-bounded identifier seeds, which it composes onto the
 *  shared A-C before `aliasRecallArgsForEgress`. The gateway/transforms recall core is
 *  UNCHANGED — all the off-cap work is backend-side.
 *
 *  Fail-open (DELIBERATE, matches the prefetch + D-167's stance "aliasing is allowed
 *  to MISS; the HARD invariant is RESTORE"): a store read error → that leg returns
 *  nothing → the egress falls back to the ledger-only scan (no alias emitted, so none
 *  can fail to restore). An empty warehouse → undefined (recall skipped, byte-identity
 *  preserved).
 *
 *  Read scope (D-157): reads only the per-pair contact list the server holds locally —
 *  the same scope fence as the prefetch search.
 */

import {
  CONNECTION_VENDOR_ENTITIES,
  type ConnectionVendorEntity,
} from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import {
  decomposeToTokens,
  extractEmailRuns,
  extractPhoneRuns,
  shouldSeedEntityValue,
} from '@recued/middleware-prompt-cache';
import { phoneMatchDigits } from '@recued/transforms';

import {
  crmRecallSeedScopes,
  isAllDigits,
  isSyntheticLocalPartName,
  CRM_NAME_PLACEHOLDER_SOURCE_KEY,
} from './canonical-pii-schemas.js';
import { buildQueryContext } from './chat-prefetch-score.js';
import type { ContactStore } from './storage/contact-store.js';
import type { CrmRecordMirrorStore } from './storage/crm-record-mirror-store.js';

/** D-167 (recall path, off-cap) — the store-wide recall aliasing surface: the
 *  per-turn-memoised whole-warehouse name/org A-C + a text-driven identifier
 *  resolver. The egress composes a per-result `RecallIndex` from these. */
export interface RecallResolver {
  /** The name/org Aho-Corasick automaton over the WHOLE warehouse (built once per
   *  recalling turn). `identifierSeeds` is empty — identifiers are text-driven. */
  readonly nameOrgIndex: piiEgress.RecallIndex;
  /** The identifier seeds PRESENT in `text`. Bounded by the text, never the
   *  warehouse. EMAILS are seeded unconditionally (an email is PII whether or not it
   *  is a known contact — see the module header); PHONES are resolved store-wide +
   *  exact, because a bare digit-run is ambiguous with an invoice number / year.
   *  Fail-open on the PHONE leg only — a store error must not drop the (store-free)
   *  email seeds. */
  readonly resolveIdentifiers: (
    text: string,
  ) => piiEgress.RecallIndex['identifierSeeds'];
  /** A seed source THREW while the index was being built, so the shield is INCOMPLETE and we
   *  do not know what it failed to cover. The egress must then WITHHOLD the recalled result
   *  rather than send it — see `RECALL_WITHHELD_MESSAGE`.
   *
   *  ABSENCE IS NOT FAILURE, and that distinction is the whole point. A warehouse with no
   *  contacts — or no contact store wired at all — legitimately has NOTHING to seed: that is a
   *  COMPLETE shield over an empty set, and the result egresses normally. A THROWN read is a
   *  different thing entirely: the values exist, we simply could not read them, so an empty
   *  seed set is a LIE. Failing open there would silently egress every name / phone / street in
   *  the recalled memory — a leak indistinguishable from "nothing to alias". Same shape as the
   *  `PII_UNALIASABLE` rule: fail closed on the VALUE, never on the turn.
   *
   *  A live GETTER, not a snapshot: some seed sources are read when the index is BUILT (the
   *  name/org automaton) and others PER RESULT (`resolveIdentifiers`'s phone lookup), so a
   *  boolean captured at build time would miss a per-result failure. The egress therefore
   *  checks this AFTER calling `resolveIdentifiers` and BEFORE writing the aliased value. */
  readonly isDegraded: () => boolean;
}

/** What the model sees in place of a recalled result whose PII shield could not be built.
 *
 *  Framed as an EXPECTED outcome, explicitly NOT a failure, and explicitly NOT retryable — the
 *  D-157 / D-177 lesson, learned the hard way: a result that reads as a silent failure makes a
 *  reasoning model RETRY, and qwen3.7-plus looped until the turn timed out. So this says what
 *  happened, says retrying will not help, and tells the model to surface it to the user. */
export const RECALL_WITHHELD_MESSAGE =
  'withheld: the privacy shield for this recalled memory could not be built (a warehouse read '
  + 'failed), so its contents were NOT sent to you. This is expected behaviour, NOT an error, '
  + 'and retrying the tool will not help. Tell the user the memory could not be shown right now.';

/** D-167 (recall path, off-cap) — extract the identifier candidates present in
 *  `text` the SAME way the prefetch parses a query (`buildQueryContext` over the
 *  prompt-cache extractors), so the digit-forms / canonical emails match EXACTLY what
 *  the store's `contact_phone_forms` / email PK hold — a drifted form would be a MISS
 *  = a leak. Names go through the A-C, not here, so the non-digit name tokens are
 *  dropped; only the digit-strings (forms) + canonical emails are kept. */
const extractIdentifierCandidates = (
  text: string,
): { emails: string[]; forms: string[] } => {
  const qctx = buildQueryContext({
    tokens: decomposeToTokens(text),
    phoneRuns: extractPhoneRuns(text),
    emailRuns: extractEmailRuns(text),
  });
  // Mirror `chat-prefetch-search.ts`: phone-form keys are the digit-strings among the
  // bare tokens ∪ reconstructed phone runs (a non-digit name token can't equal a
  // stored phone form), deduped.
  const forms = [
    ...new Set(
      [...qctx.queryTokens, ...qctx.phoneRunSet].filter((t) => /^\d+$/.test(t)),
    ),
  ];
  return { emails: [...qctx.emailRunSet], forms };
};

/** D-167 (recall path, Tier 2) — the CRM's in-memory twin of the contact store's
 *  trigger-maintained `contact_phone_forms` table: every match FORM a stored phone
 *  reduces to → the canonical phone(s) that produced it.
 *
 *  Derived through `phoneMatchDigits` — the SAME function the SQL
 *  `phone_match_forms_json` wraps to fill `contact_phone_forms` — so a CRM form and a
 *  contact form can never drift apart. That matters more than it looks: a drifted form
 *  is a MISS, and a miss in this index is a phone that egresses RAW.
 *
 *  A form maps to an ARRAY, not one phone: two people can share a national form (the
 *  same digits behind different country codes). Seeding both is correct — the egress's
 *  phone-variant pass is what decides an ambiguous run is safer left raw than
 *  coin-flipped onto the wrong person. Phones below `phoneMatchDigits`'s 7-digit floor
 *  yield no `full` form and are skipped entirely (nothing to match against). */
const buildPhoneFormIndex = (phones: readonly string[]): Map<string, string[]> => {
  const byForm = new Map<string, string[]>();
  for (const phone of phones) {
    const { full, national } = phoneMatchDigits(phone);
    if (full === undefined) continue;
    for (const form of [full, ...national]) {
      const bucket = byForm.get(form);
      if (bucket === undefined) byForm.set(form, [phone]);
      else if (!bucket.includes(phone)) bucket.push(phone);
    }
  }
  return byForm;
};

/** Normalise a stored domain to the form the ledger keys on: lowercase, no scheme, no path,
 *  no leading `www.`. A CRM account's `domain` is free-form (`Website` on Salesforce), so it
 *  arrives as anything from `acme.com` to `https://www.acme.com/`. Returns undefined for a
 *  value that is not a dotted host — a bad row must not become a bogus anchor. */
const normalizeDomain = (raw: string): string | undefined => {
  let v = raw.trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip scheme
  v = v.split(/[/?#]/, 1)[0] ?? '';              // strip path / query / fragment
  v = v.replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : undefined;
};

/** The dotted HOSTS present in `text` — the candidate set the known-domain lookup filters.
 *  Bounded by the (small) text, never the warehouse, exactly like the email/phone legs. The
 *  regex deliberately matches a bare host as well as one inside a URL, because the content
 *  pass aliases BOTH once the domain row exists. An `@`-prefixed host (an email domain) is
 *  skipped — the email leg owns those, and it already seeds them unconditionally. */
const DOMAIN_RUN_RE = /(?<![\w@.-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?![\w-])/gi;
const extractDomainCandidates = (text: string): string[] => {
  const out = new Set<string>();
  for (const m of text.matchAll(DOMAIN_RUN_RE)) {
    const domain = normalizeDomain(m[1] ?? '');
    if (domain !== undefined) out.add(domain);
  }
  return [...out];
};

/** Build a lazy recall-resolver provider from a late-bound contact-store getter
 *  (the boot wiring already threads `getContactStore`). The PII egress plan wraps it
 *  in a per-turn memo, so the whole-warehouse A-C builds at most once per recalling
 *  turn; `resolveIdentifiers` runs a cheap exact store lookup per recall result.
 *  ALWAYS returns a resolver (2026-07-11). It used to return `undefined` when no store
 *  was wired, the warehouse was empty, or the scan threw — on the premise that "no
 *  contacts ⇒ nothing to alias". The store-free EMAIL leg makes that premise false, so
 *  those cases now degrade to an EMPTY name/org automaton with the email leg intact.
 *  The recall path is still lazily gated on a `recall_context` field, and with nothing
 *  to match the result is byte-identical — so the fast path is preserved either way. */
export const createContactKnownValueIndexBuilder =
  (
    getContactStore: () => ContactStore | undefined,
    getCrmRecordMirror: () => CrmRecordMirrorStore | undefined = () => undefined,
    // The LIVE merged vendor registry (built-ins + each installed pack's lifted
    // `crm_alias` entities — `liveVendorRegistry(localManifestStore)`), NOT the frozen
    // module-level `CONNECTION_VENDOR_ENTITIES`. **This is load-bearing, not a nicety.**
    // `vendorEntitiesFromComposition` lifts a 3rd-party CRM pack's entities into an
    // "ephemeral per-install registry, NEVER the module-level boot-validated one", and
    // the housekeeping reconciler enumerates vendors through the LIVE registry — so a
    // pack CRM (Zoho / Dynamics / any `crm_alias` pack) really does write
    // `crm_record_mirror` rows under `connection.api.<vendor>.contact`. Seeding off the
    // static array would leave those scopes UNENUMERATED: the rows exist, the seed set
    // never sees them, and that person's name + phone egress RAW. Built-ins-only is the
    // fail-safe default for callers with no manifest store.
    getVendorRegistry: () => ReadonlyArray<ConnectionVendorEntity> = () =>
      CONNECTION_VENDOR_ENTITIES,
  ): (() => RecallResolver | undefined) =>
  () => {
    const store = getContactStore();
    const mirror = getCrmRecordMirror();

    // ── NAME/ORG leg — the whole-warehouse A-C, built from BOTH the contact store and
    // the CRM mirror. DEGRADES to an empty automaton (matches nothing) when a source
    // is absent / empty / throwing, per source. It used to return `undefined` for the
    // whole resolver in those cases, on the premise that "no contacts ⇒ nothing to
    // alias". **That premise is false**: the EMAIL leg below is store-free, and the
    // CRM leg has its own store — killing the resolver would silently drop shielding
    // exactly where it matters most (a server with no personal contact graph but a
    // memory pool full of customer emails — the D-196 seller shape). The empty A-C is
    // trivially cheap, and the recall path is still lazily gated on a `recall_context`
    // field being present, so a non-recall turn pays nothing and the byte-identity
    // fast path is untouched.
    const names: string[] = [];
    const orgs: string[] = [];
    const streets: string[] = [];
    const crmPhones: string[] = [];
    const knownDomains = new Set<string>();
    // Set by ANY seed source that THROWS. Absence / an empty warehouse must NOT set it — that
    // is a complete shield over an empty set. A throw means the values exist and we could not
    // read them, so the shield is a lie and the recalled result must be WITHHELD, not sent raw.
    let degraded = false;

    if (store !== undefined) {
      try {
        const listed = store.listAllNamesAndCompanies();
        names.push(...listed.names);
        orgs.push(...listed.companies);
      } catch {
        // The read FAILED — the contacts exist but we could not see them, so the name/org
        // automaton is a lie. Mark the shield degraded; the egress will withhold rather than
        // egress a memory body full of unaliased names.
        degraded = true;
      }
      try {
        const seeds = store.listRecallAddressSeeds();
        streets.push(...seeds.streets);
        for (const domain of seeds.domains) knownDomains.add(domain);
      } catch {
        degraded = true;
      }
    }

    // ── CRM leg (Tier 2) — a CRM-only person has no `contacts` row, so without this
    // their name / org / phone egresses raw. `crmRecallSeedScopes()` is registry-
    // driven (every entity carrying a `crm_alias`), and `CRM_RECALL_SEED_FIELDS` says
    // which `meta` key is a person vs an org vs a phone — `deal` seeds nothing (its
    // `name` is a TITLE). Fail-open PER SCOPE: one vendor's bad row must not drop the
    // other vendors' seeds.
    if (mirror !== undefined) {
      for (const { scope, fields } of crmRecallSeedScopes(getVendorRegistry())) {
        try {
          // `email` rides along ONLY as the placeholder oracle for the name guard
          // below — it is never seeded from here (Tier 1 already seeds every email
          // present in the recalled text, unconditionally and store-free).
          const rows = mirror.listMetaRows(scope, [
            ...fields.names,
            ...fields.orgs,
            ...fields.phones,
            ...fields.addresses,
            ...fields.domains,
            CRM_NAME_PLACEHOLDER_SOURCE_KEY,
          ]);
          for (const row of rows) {
            const email = row[CRM_NAME_PLACEHOLDER_SOURCE_KEY];
            for (const key of fields.names) {
              const value = row[key];
              if (value === undefined) continue;
              // A name that is merely this row's own email local-part is a
              // reconciler PLACEHOLDER, not a person: `sales@acme.com` with no
              // first/last name projects `meta.name = 'sales'`. Seeding it would
              // alias the bare word "sales" throughout recalled prose — corruption,
              // and B4 does not catch it (see `isSyntheticLocalPartName`).
              if (isSyntheticLocalPartName(value, email)) continue;
              if (isAllDigits(value)) continue;
              names.push(value);
            }
            for (const key of fields.orgs) {
              const value = row[key];
              if (value === undefined) continue;
              if (isAllDigits(value)) continue;
              orgs.push(value);
            }
            for (const key of fields.phones) {
              const value = row[key];
              if (value !== undefined) crmPhones.push(value);
            }
            for (const key of fields.addresses) {
              const value = row[key];
              if (value === undefined) continue;
              if (isAllDigits(value)) continue; // a street line is never bare digits
              streets.push(value);
            }
            for (const key of fields.domains) {
              const value = row[key];
              if (value === undefined) continue;
              const domain = normalizeDomain(value);
              if (domain !== undefined) knownDomains.add(domain);
            }
          }
        } catch {
          // One vendor scope failed. Its CRM people are unshielded and we cannot know who they
          // were, so the shield is incomplete — withhold rather than leak them.
          degraded = true;
        }
      }
    }

    // B4 commonness filter — same gate the prefetch applies, so a contact literally
    // named "Will" / an org "Gap" never seeds and then over-aliases the bare word in
    // unrelated recalled prose. No emails/phones are baked in — identifiers are
    // text-driven (`resolveIdentifiers`).
    const nameOrgIndex: piiEgress.RecallIndex = piiEgress.buildRecallIndex({
      names: names.filter(shouldSeedEntityValue),
      orgs: orgs.filter(shouldSeedEntityValue),
      emails: [],
      phones: [],
      // Street lines ride the SAME automaton, under the same B4 gate — they are multi-token
      // and distinctive, which is exactly what an A-C is good at. A postcode never appears
      // here (all digits → it would collide with invoice numbers), and neither does a
      // city/state/country: those stay VISIBLE so the model is location-aware.
      addresses: streets.filter(shouldSeedEntityValue),
    });

    // The CRM's in-memory twin of the contact store's trigger-maintained
    // `contact_phone_forms`: form → the canonical phone(s) it reduces from. Built once
    // per recalling turn (this whole builder is memoised by the egress plan), so a
    // per-result `resolveIdentifiers` is an O(1) map hit, never a scan.
    const crmPhonesByForm = buildPhoneFormIndex(crmPhones);

    const resolveIdentifiers = (
      text: string,
    ): piiEgress.RecallIndex['identifierSeeds'] => {
      const { emails, forms } = extractIdentifierCandidates(text);
      // The KNOWN domains present in this text. Computed BEFORE the early-out — the guard
      // below must consider all THREE candidate kinds. (It originally checked only
      // emails/forms, which short-circuited the domain leg for any recalled body that
      // happened to contain no email and no digit-string. Found by a test whose text had
      // neither; the earlier probe only passed because its prose contained "1600".)
      const domains = extractDomainCandidates(text).filter((d) => knownDomains.has(d));
      if (emails.length === 0 && forms.length === 0 && domains.length === 0) return [];

      // ── EMAILS — seed EVERY email PRESENT in the recalled text, resolved or not.
      // An email address is PII whether or not it happens to be in the contact
      // store. The old known-only filter looked each candidate up and DROPPED the
      // misses, so `bob@randomcorp.com` — a real person, just not a contact —
      // egressed RAW. That is the dominant hole now that `memory.search` returns up
      // to 16 KB of FREE-TEXT memory bodies: a memory can name anyone, and by
      // construction the value is in no warehouse entity, so no amount of widening
      // the entity index can catch it.
      //
      // It costs nothing: the candidates are ALREADY extracted (no new read), the
      // email regex is unambiguous (no false-positive aliasing), and the seed set
      // stays bounded by the text, never the warehouse (no ledger blow-up). The
      // HARD invariant still holds — `aliasEmail` is value-keyed and store-free, so
      // an unknown email allocates a ledger row and restores like any other.
      const seeds: Array<{ kind: 'email' | 'phone' | 'url'; value: string }> = [];
      const seenEmail = new Set<string>();
      const seenPhone = new Set<string>();
      const seenDomain = new Set<string>();
      const seedEmail = (value: string): void => {
        if (seenEmail.has(value)) return;
        seenEmail.add(value);
        seeds.push({ kind: 'email', value });
      };
      const seedPhone = (value: string): void => {
        if (seenPhone.has(value)) return;
        seenPhone.add(value);
        seeds.push({ kind: 'phone', value });
      };

      for (const value of emails) seedEmail(value);

      // ── PHONES — deliberately STILL known-only, now known across BOTH the contact
      // warehouse AND the CRM mirror. `forms` is every bare DIGIT-STRING in the text
      // (an invoice number, a year, a quantity — the extractor keeps the digit tokens,
      // not just phone-shaped runs), so seeding them unconditionally would alias
      // `2026` into a phone: CORRUPTION, not protection. A lookup against a KNOWN
      // phone is what disambiguates a digit-run into a real one. Lifting this needs
      // the extracted form to carry a `pii_field` marker (owner-noted 2026-07-11).
      if (store !== undefined) {
        try {
          const matches = store.resolveRecallIdentifiers({ emails, forms });
          for (const value of matches.phones) seedPhone(value);
          // Union the store's CANONICAL email forms as well: the extractor is
          // contracted to emit the store's PK form, but if it ever normalises
          // differently the un-seeded form would egress raw. Deduped by value.
          for (const value of matches.emails) seedEmail(value);
        } catch {
          // The store read FAILED, so we do not know which phones we failed to resolve. The
          // (store-free) email seeds above still stand and the CRM phone map below is already
          // in memory — but the shield is INCOMPLETE, so mark it degraded and let the egress
          // withhold rather than send a memory body with unaliased phone numbers in it.
          degraded = true;
        }
      }

      // ── CRM phones (Tier 2) — the same exact form match, against the phones of
      // people who exist ONLY in the CRM. Already resident in memory (scanned once for
      // the A-C above), so there is no store call here to fail.
      for (const form of forms) {
        for (const value of crmPhonesByForm.get(form) ?? []) seedPhone(value);
      }

      // ── DOMAINS (URL leg) — KNOWN-ONLY, and deliberately so. Every domain PRESENT in the
      // recalled text is checked against the warehouse's known domains (contact email domains
      // + CRM account `domain`); only the matches are seeded. This is the PHONE posture, not
      // the EMAIL posture, and the asymmetry is the point: an email is PII whatever the
      // address book says, but a URL usually is NOT — seeding every URL would alias
      // `docs.python.org` and blind the model to public links.
      //
      // The seed value carries a SCHEME on purpose. `https://acme.com` makes the aliaser emit
      // the `domain` side-effect row (`acme.com` → `d1.invalid`), and THAT row is what lets
      // the content pass alias every layout of the host — `https://acme.com/login` →
      // `https://d1.invalid/login`, bare `acme.com/x` → `d1.invalid/x` — with scheme and path
      // intact. A BARE domain seeded here parses as a non-URL and collapses to a whole-value
      // `pii.UrlN`, destroying the path and never reaching the shared domain ledger. Measured.
      for (const domain of domains) {
        if (seenDomain.has(domain)) continue;
        seenDomain.add(domain);
        seeds.push({ kind: 'url', value: `https://${domain}` });
      }

      return seeds;
    };

    return { nameOrgIndex, resolveIdentifiers, isDegraded: () => degraded };
  };
