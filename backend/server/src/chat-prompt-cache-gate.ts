/** Prompt-cache gate wiring for the deterministic short-circuit (D-164 § 3).
 *
 *  Builds the real `GateDeps` the shipped binary registers in place of the
 *  no-op defaults, so a chat turn whose answer is already in the warehouse
 *  resolves with ZERO LLM calls. Four short-circuit FAMILIES are composed
 *  (the gate tries each matcher in order; the probe routes by template):
 *    - **contact has-email** (FIRST) — "do I have `<Name>`'s email?" /
 *      "is there an email for `<Name>`?" → the affirmative "Yes, …" when the
 *      warehouse holds a real email; the negative "No, there's no email
 *      address on file for …" when it doesn't AND `createHasCrmContactSource`
 *      proves no CRM contact source could contradict it (otherwise the "no"
 *      defers to the LLM, which can check CRM).
 *    - **contact-attribute** — "what is `<Name>`'s email / phone /
 *      company?" (company also as "where does `<Name>` work?") → the
 *      per-pair contact warehouse (`ContactStore.list({ name_contains })`).
 *    - **calendar next-meeting** — "when's my next meeting with `<Name>`?"
 *      → resolve the contact (same store), then scan the calendar
 *      collections for the soonest FUTURE event that lists ANY address
 *      linked to that contact (canonical + D-138 merged-away — "next" is
 *      a superlative, so the minimum ranges over the complete set) as an
 *      attendee.
 *    - **mail from-count** — "how many emails from `<Name>`?" → resolve the
 *      contact (same store), then exact-`COUNT(*)` the mail collections for
 *      records whose sender (`from`) is ANY address linked to that contact
 *      (canonical + D-138 merged-away tombstone addresses — the complete
 *      set that makes the person-scoped answer honest).
 *
 *  Boundary (D-159 N.7 / D-160 I-1): `@recued/middleware-prompt-cache`
 *  stays IO-free — every warehouse read is an INJECTED port resolved at
 *  boot here, mirroring the prefetch's `EntitySearchPort`
 *  (`chat-prefetch-search.ts`). The package never imports `backend/`. The
 *  calendar port owns the `now`-relative future filter + the
 *  timezone-aware date formatting; the package only interpolates strings.
 *
 *  Read scope (D-157 / D-164 P10): the probes read only the per-pair
 *  warehouse the server already holds locally, and the SURFACE scope is
 *  the read-permission boundary — `createShortCircuitReadAuthorization`
 *  (injected as `GateDeps.authorizeShortCircuitRead`) admits a surface
 *  only when its `(channel × actor)` policy cell would admit the
 *  equivalent storage-read dispatch, evaluated with the same primitives
 *  the execute-handler's gate uses. Today that is `chat` + the two
 *  `messenger-*` surfaces (both mint `actor: 'user_self'` by
 *  construction; the `(messenger, user_self)` baseline cell mirrors
 *  chat's). PII (D-167): the short-circuit answer is rendered straight
 *  to the OWNER (no model-provider egress on a resolved turn), so the
 *  contact's real data reaches the user exactly as a normal restored
 *  turn would. On a `messenger-*` surface the delivery transits the BYO
 *  Slack / Telegram transport — exactly like every LLM-path answer the
 *  owner already receives on that surface, so the gate adds no new
 *  egress class.
 */

import {
  CALENDAR_NEXT_MEETING_TEMPLATE,
  CONTACT_ATTRIBUTE_TEMPLATES,
  CONTACT_HAS_EMAIL_TEMPLATE,
  CONTACT_HAS_NO_EMAIL_TEMPLATE,
  MAIL_FROM_COUNT_TEMPLATE,
  composeShortCircuitFamilies,
  createCalendarNextMeetingProbe,
  createContactAttributePresenceProbe,
  createContactHasEmailProbe,
  createMailFromCountProbe,
  createTemplateRenderer,
  matchCalendarNextMeetingTemplate,
  matchContactAttributeTemplate,
  matchContactHasEmailTemplate,
  matchMailFromCountTemplate,
  type CalendarNextMeeting,
  type CalendarNextMeetingLookup,
  type ContactAttributeLookup,
  type ContactAttributeRow,
  type GateDeps,
  type HasCrmContactSource,
  type MailFromCountLookup,
  type ShortCircuitFamily,
} from '@recued/middleware-prompt-cache';
import {
  CONNECTION_VENDOR_ENTITIES,
  admitByOpRisk,
  executionSourceHasContract,
  isDeclaredMessengerVendor,
  resolveTrustCeiling,
  type CanonicalEvent,
  type ExecutionSource,
  type ScanFn,
  type ToolUnderEvaluation,
} from '@recued/contracts';
import { surfaceMessengerVendor, type SurfaceTag } from '@recued/chat';

import type { CalendarCollection } from './collections/calendar/calendar-collection.js';
import type { MailCollection } from './collections/mail/mail-collection.js';
import type { CollectionRegistry } from './collections/registry.js';
import type { Collection } from './collections/types.js';
import {
  resolveConnectionVendor,
  type ConnectionStoreSqlite,
} from './storage/connection-store.js';
import { isMentionOnlyEmail, type ContactStore } from './storage/contact-store.js';
import type { EnrichmentStore } from './storage/enrichment-store.js';

/** How many `name_contains` candidates to fetch before the probe's
 *  exact-name + uniqueness filter. The probe infers GLOBAL exact-name
 *  uniqueness from the rows it sees, so this page must contain EVERY exact
 *  match — otherwise a second same-named contact past the cap would let the
 *  probe answer from the wrong contact (a false-unique). `list({ name_contains })`
 *  is a recency-ordered substring page, so we fail closed on a FULL page (see
 *  the lookup): a full page may be truncated, and we can't guarantee uniqueness
 *  over it. The cap is set well above any realistic personal warehouse — having
 *  50 contacts whose names all contain one query string is pathological (and
 *  D-138 merges true duplicates), so the fail-closed only bites adversarial
 *  input, never a real lookup. */
const CONTACT_NAME_LOOKUP_LIMIT = 50;

/** Sanity ceiling on a contact's ADDRESS SET enumeration
 *  (`ContactStore.addressSet` — D-205 #3.5b). Merges are user-confirmed one at
 *  a time and an import attaches a handful of addresses, so a real contact
 *  carries a few; a set at/over this cap means pathological or corrupt data,
 *  and the lookup OMITS `emails` for that row. Every consumer of the
 *  completeness claim then defers: the mail from-count probe (a person-scoped
 *  total over a possibly-truncated set would be the exact false-total hole the
 *  set exists to close), the calendar next-meeting probe (a "next" minimum over
 *  a truncated set could miss a sooner meeting under an unenumerated address),
 *  and the has-email negative (which needs the set present-and-EMPTY). The P5
 *  attribute family is unaffected.
 *
 *  ⚠ It bounds the WHOLE set now, not just its merge half — the quantity we are
 *  actually claiming completeness over. That is stricter by the anchor address,
 *  and deliberately: a cap that guards a subset of the claim guards nothing. */
const MERGED_SOURCE_EMAIL_LIMIT = 64;

/** How many of the SOONEST future events (per calendar collection,
 *  ascending by `start_at`) the next-meeting lookup scans for the
 *  attendee. Attendees are not a denormalized hot-field column, so the
 *  filter is a JS scan over the page rather than a SQL predicate — the cap
 *  bounds that scan. Set to the table's own `CALENDAR_MAX_LIST_LIMIT` (500)
 *  so the scan is as deep as one page allows. The cap NEVER yields a wrong
 *  answer: when a calendar's page is FULL and contained no attendee match, a
 *  match could sit just past the cap at a time earlier than another
 *  calendar's match, so the lookup FAILS CLOSED (returns null → the gate
 *  passes through to the LLM) rather than risk presenting a later meeting as
 *  the soonest. For a personal calendar (well under 500 future events) the
 *  page is never full and this never bites. */
const CALENDAR_FUTURE_SCAN_LIMIT = 500;

/** Type guard mirroring `chat-tool-handlers.ts`: a `CalendarCollection`
 *  exposes the dedicated `CalendarCollectionTable` via `.table` (the
 *  generic `Collection.list / search` paths don't reach the calendar
 *  warehouse). Kept local so this file doesn't depend on the chat-handler
 *  module. */
const isCalendarCollection = (c: Collection): c is CalendarCollection =>
  'table' in c && (c as Partial<CalendarCollection>).table !== undefined;

/** Narrow a registered `Collection` to a `MailCollection` — the mail
 *  platform plus the D-164 P7 `countFrom` count method (mirrors housekeeping's
 *  `c.platform === 'mail'` mail-collection filter, with the method-presence
 *  check the narrow needs). The generic `Collection` surface has no
 *  `countFrom`, so a non-mail or stub collection is skipped by the count
 *  lookup. Kept local so this file doesn't depend on the chat-handler
 *  module. */
const isMailCollection = (c: Collection): c is MailCollection =>
  c.platform === 'mail'
  && typeof (c as Partial<MailCollection>).countFrom === 'function';

/** Trim + lower-case an email for the attendee compare. Email addresses
 *  are case-insensitive in practice (and the contact store keys
 *  `COLLATE NOCASE`), while a calendar attendee's `email` is whatever the
 *  provider extracted — so both sides are normalised before compare to
 *  avoid a case-only miss. */
const normaliseEmail = (raw: string): string => raw.trim().toLowerCase();

/** Render an event's start as a human-readable "when" string for the
 *  next-meeting answer. Formatting happens HERE (not in the package)
 *  because the backend owns the locale + the event's IANA timezone; the
 *  package stays free of `Intl` / `Date`.
 *
 *  Timezone handling splits on `is_all_day`:
 *    - **Timed events** — formatted in the event's IANA timezone (the
 *      `start_at` instant is a real wall-clock moment), with the zone
 *      abbreviation so the time is unambiguous.
 *    - **All-day events** — formatted in UTC, NOT the event timezone. An
 *      all-day `start_at` is a calendar DATE conventionally stored as
 *      UTC-midnight; zone-converting that midnight instant to a zone west
 *      of UTC would shift the displayed date back a day (May 1 → Apr 30).
 *      UTC preserves the calendar date. The time component is dropped.
 *
 *  Returns `null` on a missing/invalid IANA timezone — `Intl.DateTimeFormat`
 *  throws a `RangeError` on a bad `timeZone`, and a garbled time is worse
 *  than no answer, so the gate passes through to the LLM instead (design
 *  § 3 Invariant 7 — safe small gains). A blank timezone falls back to UTC
 *  (a valid zone) rather than the non-deterministic host-local zone. */
const formatEventWhen = (event: CanonicalEvent): string | null => {
  const tz =
    typeof event.timezone === 'string' && event.timezone.trim().length > 0
      ? event.timezone
      : 'UTC';
  try {
    const opts: Intl.DateTimeFormatOptions = event.is_all_day
      ? { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }
      : {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
          timeZone: tz,
        };
    const out = new Intl.DateTimeFormat('en-US', opts).format(new Date(event.start_at));
    return out.trim().length > 0 ? out : null;
  } catch {
    return null;
  }
};

/** Build the calendar `CalendarNextMeetingLookup` over the registered
 *  calendar collections. Given a contact's COMPLETE linked address set
 *  (canonical + merged-away — the probe's `ContactAttributeRow.emails`
 *  requirement) it returns the soonest FUTURE event listing ANY of those
 *  addresses as an attendee, reduced to `{ summary, when }`, or `null`
 *  when there is none. "Next" is a superlative, so the minimum must range
 *  over every address the person could be invited under — an invite sent
 *  to a merged-away former address is still a meeting with them.
 *
 *  Attendee matching is a JS-side compare (`normaliseEmail` on BOTH the
 *  contact's addresses and each attendee's), so — deliberately unlike the
 *  mail count's SQL-`LOWER` path — a non-ASCII address needs no deferral:
 *  both sides fold through the same Unicode-aware `toLowerCase`, making
 *  the equality self-consistent.
 *
 *  Per-address response CONFLICT defers: when the contact appears under
 *  MULTIPLE linked addresses on one candidate event with a response split
 *  (declined under one, not under another), whether that meeting is
 *  "with" them is genuinely ambiguous — rendering it risks presenting a
 *  meeting they declined, skipping it risks presenting a LATER meeting as
 *  "next". The event's start is recorded as an inconclusive horizon: if
 *  it is earlier than the best clean match, the lookup fails closed and
 *  the LLM (which sees the full attendee data) reasons it out.
 *
 *  `now` is injectable for deterministic tests; production uses the wall
 *  clock. The lookup fails closed (`null`) on any read error, an absent
 *  registry, a cancelled-only match, a blank summary (the body's
 *  `{{summary}}` would render empty — an untitled "next" meeting passes
 *  through rather than rendering `is "" on …`), or an unformattable time. */
const createCalendarNextMeetingLookup = (
  getCollectionRegistry: () => CollectionRegistry | undefined,
  now: () => number = () => Date.now(),
): CalendarNextMeetingLookup => (emails): CalendarNextMeeting | null => {
  const registry = getCollectionRegistry();
  if (registry === undefined) return null;
  const wanted = new Set(emails.map(normaliseEmail).filter((e) => e.length > 0));
  if (wanted.size === 0) return null;

  const cutoff = now();
  let best: CanonicalEvent | null = null;
  // `start_at` horizons at/past which a meeting with the contact MIGHT exist
  // but couldn't be adjudicated: a FULL match-less page (a hidden match could
  // sit just past it, at >= its last event's start) or a response-conflicted
  // event (the meeting itself, at its own start). If any horizon is earlier
  // than `best`, a sooner meeting can't be ruled out → can't prove "earliest".
  const inconclusiveHorizons: number[] = [];
  try {
    const calendars = registry.list().filter(isCalendarCollection);
    for (const c of calendars) {
      const snaps = c.table.listSnapshots({
        start_since: cutoff,
        order_by: 'start_at',
        direction: 'asc',
        limit: CALENDAR_FUTURE_SCAN_LIMIT,
      });
      let matched: CanonicalEvent | null = null;
      for (const snap of snaps) {
        const event = snap.event;
        if (event.status === 'cancelled') continue;
        const attendees = event.attendees ?? [];
        // Skip a meeting the OWNER declined (a self attendee that said "no") —
        // a declined invite still in the warehouse is not "your next meeting".
        if (attendees.some((a) => a.is_self === true && a.response_status === 'declined')) {
          continue;
        }
        // The contact's attendee entries across ALL linked addresses. A
        // meeting is "with" them when at least one entry is non-declined —
        // a meeting they said "no" to everywhere is not. A response SPLIT
        // (declined under one address, not under another) is ambiguous:
        // record the event as an inconclusive horizon and keep scanning (a
        // later clean match still stands when nothing ambiguous precedes it).
        const entries = attendees.filter((a) => wanted.has(normaliseEmail(a.email)));
        if (entries.length === 0) continue;
        const declinedCount = entries.filter((a) => a.response_status === 'declined').length;
        if (declinedCount === entries.length) continue;
        if (declinedCount > 0) {
          inconclusiveHorizons.push(event.start_at);
          continue;
        }
        // `listSnapshots` is start_at-ascending, so the FIRST clean attendee
        // match in this collection is its earliest future meeting with the
        // contact.
        matched = event;
        break;
      }
      if (matched !== null) {
        if (best === null || matched.start_at < best.start_at) best = matched;
      } else if (snaps.length >= CALENDAR_FUTURE_SCAN_LIMIT) {
        // Full page, no match → record the horizon for the fail-closed check.
        inconclusiveHorizons.push(snaps[snaps.length - 1]!.event.start_at);
      }
    }
  } catch {
    // A warehouse read failure is a pass-through, never a turn failure.
    return null;
  }
  if (best === null) return null;
  // Fail closed if a capped match-less scan, or a response-conflicted event,
  // could hide a meeting EARLIER than the one we chose.
  if (inconclusiveHorizons.some((h) => h < best!.start_at)) return null;

  const summary = typeof best.summary === 'string' ? best.summary.trim() : '';
  if (summary.length === 0) return null;
  const when = formatEventWhen(best);
  if (when === null) return null;
  return { summary, when };
};

/** Build the mail `MailFromCountLookup` over the registered mail collections.
 *  Given a contact's COMPLETE linked address set (canonical + merged-away —
 *  the probe's `ContactAttributeRow.emails` requirement) it returns the
 *  PRECISE count of mail records whose sender (`from`) is ANY of those
 *  addresses, SUMMED across every mail collection (a user with two accounts
 *  → both counted), or `null` when there is no mail collection to count over,
 *  the set is unusable, or a read failed.
 *
 *  Each collection's `countFrom` is an exact `COUNT(*)` over its whole table
 *  (`countByAddress('from', …)`), so — unlike the calendar scan — there is NO
 *  page cap to fail closed around: a sender's mail can't hide past a recency
 *  window, the count is exact regardless of mailbox size. `from` is stored as
 *  a bare provider-normalised address, so the lower-trim equality is precise
 *  (no `xalice@…` / `alice@….evil` substring near-miss) — and summing across
 *  DISTINCT normalised addresses is itself exact, because one scalar `from`
 *  can equal at most one of them. Returns `null` (NOT `0`) when no mail
 *  collection is registered: "you have no emails from `<Name>`" must not be
 *  answered when nothing was synced to count (the probe also defers a real
 *  `0`, see `createMailFromCountProbe`). */
const createMailFromCountLookup = (
  getCollectionRegistry: () => CollectionRegistry | undefined,
): MailFromCountLookup => (emails): number | null => {
  const registry = getCollectionRegistry();
  if (registry === undefined) return null;
  const wanted = [...new Set(emails.map(normaliseEmail).filter((e) => e.length > 0))];
  if (wanted.length === 0) return null;
  // `countFrom` → `countByAddress` folds case via SQLite `LOWER`, which is
  // ASCII-only. For a non-ASCII (SMTPUTF8 / EAI) sender address the contact's
  // canonical casing could differ from a stored `from`'s casing on those
  // characters, silently UNDERCOUNTING — a deterministic wrong total the model
  // can't repair. ANY non-ASCII address in the set defers the WHOLE count to
  // the LLM (a pass-through is always safe): counting only the ASCII members
  // would silently undercount the person total the same way. ASCII sets — the
  // overwhelming majority — count exactly.
  if (wanted.some((e) => /[^\x00-\x7F]/.test(e))) return null;
  try {
    const mailCollections = registry.list().filter(isMailCollection);
    if (mailCollections.length === 0) return null;
    let total = 0;
    for (const c of mailCollections) {
      for (const e of wanted) total += c.countFrom(e);
    }
    return total;
  } catch {
    // A warehouse read failure is a pass-through, never a turn failure.
    return null;
  }
};

/** Build the has-email family's `HasCrmContactSource` port: could a CRM
 *  contact source the model's `contact.search` consults hold a contact email
 *  the LOCAL store lacks? The deterministic "no" fires only on a provable
 *  `false`; everything else fails CLOSED (`true` → defer to the LLM).
 *
 *  TWO coverage checks, both required, because they fail independently:
 *    1. **Enrolled CRM-contact connection** — any `kind: 'api'` connection
 *       row whose resolved vendor (`resolveConnectionVendor` — config_json
 *       first, subtype fallback; the same resolver the grant + profile paths
 *       share) declares a `crm_alias: 'contact'` entity in
 *       `CONNECTION_VENDOR_ENTITIES` (HubSpot + Salesforce today; a future
 *       registered CRM vendor joins automatically). A live connection means
 *       the model could reach vendor contacts BEYOND the mirror (Tier 2/3
 *       calls), so mirror emptiness alone wouldn't clear it.
 *    2. **Platform contact-mirror rows** — `contact.search`'s vendor sources
 *       read the enrichment store's `connection.api.<vendor>.contact` scopes
 *       DIRECTLY, with no connection check, and mirror rows OUTLIVE a
 *       disconnected connection. One surviving row could carry the email →
 *       `true`.
 *  Absent wiring or stores (pre-boot / dbless harness), and any read error,
 *  are `true` — can't verify coverage, can't assert the negative. */
const createHasCrmContactSource = (
  getConnectionStore: (() => ConnectionStoreSqlite | undefined) | undefined,
  getEnrichmentStore: (() => EnrichmentStore | undefined) | undefined,
): HasCrmContactSource => {
  const crmContactEntities = CONNECTION_VENDOR_ENTITIES.filter(
    (e) => e.crm_alias === 'contact',
  );
  const crmContactVendors = new Set(crmContactEntities.map((e) => e.vendor));
  return (): boolean => {
    if (getConnectionStore === undefined || getEnrichmentStore === undefined) return true;
    try {
      const connections = getConnectionStore();
      const enrichments = getEnrichmentStore();
      if (connections === undefined || enrichments === undefined) return true;
      const hasCrmConnection = connections.list({ kind: 'api' }).some((row) => {
        const vendor = resolveConnectionVendor(row);
        return vendor !== undefined && crmContactVendors.has(vendor);
      });
      if (hasCrmConnection) return true;
      for (const entity of crmContactEntities) {
        if (enrichments.listScopeMeta(entity.scope, { limit: 1 }).length > 0) return true;
      }
      return false;
    } catch {
      // Can't verify coverage → can't assert the negative.
      return true;
    }
  };
};

/** Trim + collapse + lower-case a display name for the tombstone↔survivor
 *  compare — the same normalisation the probe's exact-name filter applies
 *  (`resolveUniqueExactContact`), so "same name as its survivor" here means
 *  exactly "the survivor row satisfies the same exact-name match". */
const normaliseName = (raw: string): string =>
  raw.trim().replace(/\s+/g, ' ').toLowerCase();

// ── Read-permission seam (D-164 P10) ───────────────────────────────

/** What the deterministic short-circuit IS, policy-wise: a warehouse read
 *  equivalent to a `kind: 'storage'`, `risk_tier: 'read'` ingredient
 *  dispatch. The probes read the contact store + the mail / calendar
 *  collections and render straight to the surface — no ingredient
 *  manifest exists, so this synthetic probe shape is what the policy
 *  evaluation judges. The slug is diagnostic-only (it appears in
 *  `AdmissionDecision.detail` strings); it is NOT in the outbound-send
 *  escalation set and never reaches a commit. */
const SHORT_CIRCUIT_READ_PROBE: ToolUnderEvaluation = {
  slug: 'recued/prompt-cache-short-circuit-read',
  kind: 'storage',
  risk_tier: 'read',
};

/** Map a D-160 surface to the `(channel × actor)` `ExecutionSource` its
 *  policy cell is keyed on — the P10 FALLBACK for callers that carry no
 *  per-turn source (bare harness contexts; `runStream` always threads
 *  one). Both live surfaces mint `actor: 'user_self'` BY CONSTRUCTION —
 *  `chat` is the owner's webclient (`buildChatExecutionSource`),
 *  `messenger-*` is the owner messaging their own server over a BYO
 *  Slack / Telegram transport (`createMessengerChannel` mints
 *  `{ channel: 'messenger', actor: 'user_self' }`; D-160 N.5 "one
 *  conversation, two windows"). The identity fields (`chat_session_id` /
 *  `from` / …) are POLICY-PROBE stand-ins: `lookupPolicy` keys cells on
 *  `(channel, actor)` only, and this source is never written to a
 *  commit — it exists to ask the matrix a question, not to attribute a
 *  dispatch. An unknown / future surface returns `null` → the
 *  authorization fails closed. A turn that DOES carry a real source is
 *  judged as itself (`sourceMatchesSurface` + the user_self requirement
 *  below) — the P12 threading that closes the P10 watch-out: a
 *  non-`user_self` turn can never ride this map's stand-in. */
const surfaceExecutionSource = (surface: SurfaceTag): ExecutionSource | null => {
  if (surface === 'chat') {
    return {
      channel: 'chat',
      actor: 'user_self',
      chat_session_id: 'prompt-cache-gate-probe',
      user_id: 'local',
    };
  }
  // A `messenger-<vendor>` surface mints the messenger probe for any DECLARED
  // transport vendor (D-192 CORE #6 — registry-validated at runtime, not a
  // closed `switch`); an undeclared / malformed surface returns null → the
  // authorization fails closed, exactly as the prior `default` arm did.
  const vendor = surfaceMessengerVendor(surface);
  if (vendor !== null && isDeclaredMessengerVendor(vendor)) {
    return { channel: 'messenger', actor: 'user_self', vendor, from: 'owner' };
  }
  return null;
};

/** Does a turn-threaded `ExecutionSource` BELONG on this surface? The
 *  seam refuses a mismatched pair fail-closed: the surface tag says
 *  where the render would go, the source says who is acting — a chat-
 *  tagged turn carrying an `mcp` source (or a slack-tagged turn carrying
 *  a telegram source) is a harness or wiring bug, and rendering
 *  warehouse data under a confused identity is the one outcome this
 *  seam exists to prevent. The pairs mirror the channels' own minting
 *  (`chat-channel.ts` / `messenger-channel.ts`), including the vendor:
 *  the surface tag IS `messenger-<vendor>` (D-160 N.5 closed list). */
const sourceMatchesSurface = (
  source: ExecutionSource,
  surface: SurfaceTag,
): boolean => {
  if (surface === 'chat') return source.channel === 'chat';
  // The surface tag IS `messenger-<vendor>` (D-160 N.5) — a messenger source
  // belongs here iff its channel is `messenger` and its vendor equals the
  // surface's declared vendor. An undeclared / malformed surface matches
  // nothing (fail closed), same as the prior `default` arm.
  const vendor = surfaceMessengerVendor(surface);
  if (vendor !== null && isDeclaredMessengerVendor(vendor)) {
    return source.channel === 'messenger' && source.vendor === vendor;
  }
  return false;
};

/** Build the gate's `authorizeShortCircuitRead` seam: may the
 *  deterministic short-circuit fire on `surface`? The answer is the SAME
 *  approval evaluation the execute-handler's admission gate runs for a dispatch
 *  under that surface's identity — D-187 slice 4: `admitByOpRisk` (op-risk ×
 *  stage-trust) over the synthetic storage-read probe, replacing the matrix's
 *  `lookupPolicy → mergePolicyWithContract → admitWithPolicyMatrix` chain. Only an
 *  unrestricted `user_self` is ever evaluated here (the structural refusals below
 *  guarantee it), so the ceiling is the contract-less owner `admin` and a `read`
 *  op resolves `'admit'` — an unrestricted owner always reads their own warehouse.
 *  Fires ONLY on verdict `'admit'`:
 *    - `'deny'` → pass through; the LLM path's tools face the same policy.
 *      (Op-risk never denies a read; an ACCESS-denied read is a Layer-1 / per-call
 *      concern the LLM path's dispatches still hit.)
 *    - `'ask'` → an approval-required read must NOT silently render; the
 *      gate cannot pause for approval (it answers inline), so it defers
 *      to the LLM path, which CAN run the D-157 preflight ask flow.
 *    - any throw / unknown surface → fail closed (`false`).
 *
 *  WHICH source is evaluated (P12 — the per-turn threading):
 *    - `turnSource` present (the middleware threads `TurnContext.source`,
 *      i.e. the channel-minted `ChannelInbound.source`) — judge THAT
 *      identity, after two structural refusals:
 *        1. it must BELONG on the surface (`sourceMatchesSurface` — a
 *           mismatched pair is a wiring bug; fail closed);
 *        2. it must be an UNRESTRICTED owner (`actor: 'user_self'`, no
 *           `contract_id`). The seam carries no `ContractSnapshot`
 *           plumbing, so a contract-scoped read policy cannot be
 *           evaluated here — a contracted or self-restricted turn
 *           defers to the LLM path, whose dispatches DO carry the
 *           snapshot through the execute-handler's gate. This is the
 *           structural closure of the P10 watch-out: a non-`user_self`
 *           messenger turn now defers as ITSELF instead of over-granting
 *           through the static `user_self` stand-in.
 *    - `turnSource` absent (bare harness `TurnContext`s) — the P10
 *      surface→source map answers, byte-identical to pre-P12.
 *  Today this admits `chat` + both `messenger-*` surfaces — the
 *  `(messenger, user_self)` baseline cell deliberately mirrors
 *  `(chat, user_self)` ("user sending themselves a command via Slack /
 *  Telegram", policy-matrix.ts) — and refuses everything else. */
export const createShortCircuitReadAuthorization = (
  getContractScan?: () => ScanFn | undefined,
): ((surface: SurfaceTag, turnSource?: ExecutionSource) => boolean) =>
  (surface, turnSource): boolean => {
    let source: ExecutionSource;
    if (turnSource !== undefined) {
      if (!sourceMatchesSurface(turnSource, surface)) return false;
      if (turnSource.actor !== 'user_self') return false;
      if (executionSourceHasContract(turnSource)) return false;
      source = turnSource;
    } else {
      const fallback = surfaceExecutionSource(surface);
      if (fallback === null) return false;
      source = fallback;
    }
    try {
      // D-187 slice 4 — the read-permission verdict is now `admitByOpRisk` (op-risk ×
      // stage-trust), not the matrix. `source` is always an UNRESTRICTED `user_self`
      // here (the structural refusals above guarantee it), so the ceiling is the
      // contract-less owner `admin` and a `read` op resolves `admit` regardless —
      // an unrestricted owner always reads their own warehouse. (`getContractScan` no
      // longer feeds this seam; it stays threaded until slice 6 retires the matrix.)
      const decision = admitByOpRisk({
        slug: SHORT_CIRCUIT_READ_PROBE.slug,
        risk_tier: SHORT_CIRCUIT_READ_PROBE.risk_tier,
        ceiling: resolveTrustCeiling(source),
        source,
      });
      return decision.verdict === 'admit';
    } catch {
      // Can't verify the read → can't justify the short-circuit. Pass through —
      // the LLM path is policy-gated on its own (design § 3 Invariant 7).
      return false;
    }
  };

/** Build the prompt-cache `GateDeps` from late-bound warehouse getters
 *  (the boot wiring threads `getContactStore` + `getCollectionRegistry` +
 *  `getConnectionStore` + `getEnrichmentStore`).
 *  The contact lookup returns `[]` whenever the store is absent (pre-boot /
 *  no warehouse) so the probes find nothing and the gate passes through
 *  (zero-harm); the calendar lookup is likewise null-safe on an absent
 *  registry. The trailing getters are optional, following one pattern:
 *  absent fails closed. `getConnectionStore` + `getEnrichmentStore` feed
 *  ONLY the has-email family's CRM-coverage check (absent → the
 *  deterministic "no" never fires). `getContractScan` feeds ONLY the
 *  P10 read-permission seam's `lookupPolicy` (absent → the seeded
 *  baseline matrix is the authority — still correct, just not
 *  store-override-aware); the seam itself is ALWAYS attached, so every
 *  caller of these deps gets the policy-evaluated surface scope rather
 *  than the middleware's chat-only fallback. */
export const createPromptCacheGateDeps = (
  getContactStore: () => ContactStore | undefined,
  getCollectionRegistry: () => CollectionRegistry | undefined,
  getConnectionStore?: () => ConnectionStoreSqlite | undefined,
  getEnrichmentStore?: () => EnrichmentStore | undefined,
  getContractScan?: () => ScanFn | undefined,
): GateDeps => {
  const contactLookup: ContactAttributeLookup = (name) => {
    const store = getContactStore();
    if (store === undefined) return [];
    let rows;
    try {
      rows = store.list({ name_contains: name, limit: CONTACT_NAME_LOOKUP_LIMIT });
    } catch {
      // A warehouse read failure is a pass-through, never a turn failure.
      return [];
    }
    // Fail closed on a FULL page. The probe infers global exact-name uniqueness
    // from these rows; a full page may be TRUNCATED (a second exact-name
    // duplicate could sit just past the recency-ordered cap), so we can't
    // guarantee uniqueness and must not risk answering from the wrong contact.
    // Returning [] → the probe finds nothing → the gate passes through to the
    // LLM. Realistically unreachable for a personal warehouse (see the cap).
    if (rows.length >= CONTACT_NAME_LOOKUP_LIMIT) return [];
    try {
      const out: ContactAttributeRow[] = [];
      for (const r of rows) {
        // A D-138 TOMBSTONE (merged_into set) is not an independent contact —
        // it is a former identity of its survivor. `list` surfaces it because
        // tombstones keep their display name (only phone/company/address are
        // cleared), and before multi-address counting that made any merged
        // same-named pair permanently break the probe's uniqueness rule.
        //   - survivor carries the SAME normalised name → DROP the tombstone:
        //     the survivor row stands in for the person under this name, and
        //     the tombstone's address reaches it via `emails` below. (If the
        //     survivor's raw name eluded the substring page — whitespace
        //     variance — the person simply has no exact match → defer; safe.)
        //   - survivor named DIFFERENTLY (or unreadable) → KEEP the tombstone
        //     as a NAME-ONLY row: the queried name then genuinely denotes two
        //     candidates (the live one and a person formerly known by it), so
        //     it must still break uniqueness — but with no email/attributes it
        //     can never render if it ends up the sole match (every family
        //     defers an attribute-less contact), so a stale identity never
        //     reaches an answer.
        if (r.merged_into !== undefined) {
          let survivorName = '';
          try {
            const survivor = store.get(store.resolveCanonicalEmail(r.email).canonical_email);
            if (typeof survivor?.name === 'string') survivorName = normaliseName(survivor.name);
          } catch {
            // Cycle / corrupt redirect — treat as unreadable: keep name-only.
            survivorName = '';
          }
          const tombstoneName = typeof r.name === 'string' ? normaliseName(r.name) : '';
          if (survivorName.length > 0 && survivorName === tombstoneName) continue;
          out.push({ ...(r.name !== undefined ? { name: r.name } : {}) });
          continue;
        }
        // A `mention_only` contact (one Recued knows by name but has no real
        // email yet) carries a SYNTHETIC placeholder `mention-only-…@_recued.invalid`
        // in its `email` field (PA8 — the store keeps `email: string` and marks
        // identity via the placeholder). Surfacing it as a real address would
        // make a contact-attribute short-circuit answer "<Name>'s email is
        // mention-only-…@_recued.invalid." (a non-answer), and would let the
        // has-email probe falsely report a usable email. OMIT it so every
        // contact-anchored family treats a mention-only contact as having no
        // email (P5 → empty-render defer, calendar → no-email defer, mail →
        // no-set defer, has-email → the probe's no-email branch). A real
        // email passes through unchanged.
        const mentionOnly = isMentionOnlyEmail(r.email);
        // The contact's COMPLETE linked address set — canonical + merged-away
        // tombstone addresses (transitive) — populated ONLY when it provably
        // is complete (`ContactAttributeRow.emails` is a completeness claim;
        // the mail from-count + calendar next-meeting probes defer without
        // it, and the has-email "no" requires it present-and-EMPTY). A
        // mention-only row has no real anchor address, so its set is just
        // the merged-away real
        // addresses — usually `[]`, which is exactly the empty-complete-set
        // claim the deterministic "no" needs. Omitted only for a
        // pathological at-cap enumeration (possibly truncated → not
        // provably complete).
        let emails: readonly string[] | undefined;
        {
          // D-205 #3.5b — the COMPLETE set, from the one primitive.
          //
          // This built the set from `listMergedSourceEmails`, i.e. the anchor plus
          // the addresses MERGED away into it — and called the result complete. It
          // was not. An address also joins a person by being ATTACHED as an
          // `email_alias` (an import supplying a second address; vendor records are
          // multi-valued upstream) or RETIRED into one (a promotion re-keying the
          // `email` PK). Neither is a tombstone, so neither was enumerated — while
          // three probes downstream treat this set as a COMPLETENESS CLAIM. The
          // from-count then totalled a person's mail over only some of their
          // addresses and handed the model a number it states as fact; the
          // next-meeting minimum could miss a sooner meeting under an unenumerated
          // address; and the has-email "no" could deny an address the contact
          // demonstrably answers to. `addressSet` is the whole space.
          //
          // Synthetics are filtered here, not there: the placeholder is IN the set
          // on purpose (rows written while the contact was `mention_only` are still
          // keyed on it), but surfacing one to the model would answer "<Name>'s
          // email is mention-only-…@_recued.invalid" and let the has-email probe
          // report a usable address. A mention-only contact therefore still yields
          // its real linked addresses — usually `[]`, which is exactly the
          // empty-complete-set the deterministic "no" needs.
          const linked = store.addressSet(r.email);
          // The cap now bounds the set we are CLAIMING COMPLETENESS OVER rather
          // than the merge half of it — the honest quantity to guard, and stricter
          // by the anchor. Over the cap we claim nothing, which is the fail-safe
          // answer (every consumer defers without the set).
          if (linked.length < MERGED_SOURCE_EMAIL_LIMIT) {
            emails = [
              ...new Set(
                linked
                  .filter((e) => !isMentionOnlyEmail(e))
                  .map(normaliseEmail)
                  .filter((e) => e.length > 0),
              ),
            ];
          }
        }
        out.push({
          ...(mentionOnly ? {} : { email: r.email }),
          ...(emails !== undefined ? { emails } : {}),
          ...(r.name !== undefined ? { name: r.name } : {}),
          ...(r.phone !== undefined ? { phone: r.phone } : {}),
          ...(r.company !== undefined ? { company: r.company } : {}),
        });
      }
      return out;
    } catch {
      // A warehouse read failure is a pass-through, never a turn failure.
      return [];
    }
  };

  const nextMeetingLookup = createCalendarNextMeetingLookup(getCollectionRegistry);
  const mailFromCountLookup = createMailFromCountLookup(getCollectionRegistry);

  // Each family carries its matcher, its probe, and the template hashes its
  // matcher can return (the composed probe routes by hash). Order = match
  // priority; the hash sets are disjoint by construction.
  //
  // The has-email family is FIRST so a presence-framed "do I have <Name>'s
  // email?" wins here (the affirmative "Yes, …" answer + the non-possessive
  // "email for <Name>" phrasing P5 misses). Its matcher requires a presence
  // verb in the lead and excludes the content interrogatives, so "what is
  // <Name>'s email?" (and every non-presence framing) has no match here and
  // falls through to the contact-attribute family unchanged. Its BESPOKE
  // probe owns the yes/no split: a real email renders the matched "Yes, …";
  // an absent one renders the negative sibling via the snapshot's
  // `render_template_override` ONLY when `createHasCrmContactSource` proves
  // no CRM contact source could contradict it, and otherwise defers to the
  // LLM (which can check CRM) — the pre-gate behavior. The override never
  // enters `templateHashes`: only the matcher's hash routes the probe.
  const contactHasEmailFamily: ShortCircuitFamily = {
    match: matchContactHasEmailTemplate,
    probe: createContactHasEmailProbe(
      contactLookup,
      createHasCrmContactSource(getConnectionStore, getEnrichmentStore),
      CONTACT_HAS_NO_EMAIL_TEMPLATE,
    ),
    templateHashes: new Set([CONTACT_HAS_EMAIL_TEMPLATE.template_hash]),
    // The probe-selectable sibling body, authorized by CANONICAL OBJECT —
    // the composer renders this declared template for the declared hash and
    // rejects any other override fail-closed.
    overrideTemplates: [CONTACT_HAS_NO_EMAIL_TEMPLATE],
  };
  const contactAttributeFamily: ShortCircuitFamily = {
    match: matchContactAttributeTemplate,
    probe: createContactAttributePresenceProbe(contactLookup),
    templateHashes: new Set(
      Object.values(CONTACT_ATTRIBUTE_TEMPLATES).map((t) => t.template_hash),
    ),
  };
  const calendarNextMeetingFamily: ShortCircuitFamily = {
    match: matchCalendarNextMeetingTemplate,
    probe: createCalendarNextMeetingProbe(contactLookup, nextMeetingLookup),
    templateHashes: new Set([CALENDAR_NEXT_MEETING_TEMPLATE.template_hash]),
  };
  const mailFromCountFamily: ShortCircuitFamily = {
    match: matchMailFromCountTemplate,
    probe: createMailFromCountProbe(contactLookup, mailFromCountLookup),
    templateHashes: new Set([MAIL_FROM_COUNT_TEMPLATE.template_hash]),
  };

  const { matchTemplate, probeData } = composeShortCircuitFamilies([
    contactHasEmailFamily,
    contactAttributeFamily,
    calendarNextMeetingFamily,
    mailFromCountFamily,
  ]);

  return {
    matchTemplate,
    probeData,
    renderTemplate: createTemplateRenderer(),
    authorizeShortCircuitRead: createShortCircuitReadAuthorization(getContractScan),
  };
};
