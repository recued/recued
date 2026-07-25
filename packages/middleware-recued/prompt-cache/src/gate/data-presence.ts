/** D-164 P4e — entity.query "did we get data?" probe contract.
 *
 *  The gate orchestrator (`./index.ts`) calls a `DataPresenceProbe`
 *  after a template matches the NER slots — the probe queries the
 *  warehouse for whatever records the template needs to render, and
 *  returns a frozen snapshot or `null` for "no data, pass through to
 *  the LLM."
 *
 *  Why a separate file: the probe is the cleanest seam between the
 *  gate orchestrator (pure, no IO) and the warehouse (per-pair SQLite
 *  + AEAD). Keeping the probe as an injected callback lets the gate
 *  remain testable with synthetic snapshots, and lets P5/P6 wire the
 *  real `entity.query` probe at boot without reaching into the gate's
 *  control flow.
 *
 *  Snapshot freeze (design § 3 Invariant 6): the probe is responsible
 *  for capturing the warehouse rows at call time. Subsequent writes
 *  must not race the renderer — the snapshot lives in the returned
 *  object's `data` field, and the renderer reads from there. The gate
 *  itself does not freeze the snapshot; that's the probe's contract.
 *
 *  No-op default: `noopDataPresenceProbe` returns `null` unconditionally.
 *  The gate falls through to pass-through whenever the production
 *  probe isn't wired (P4e ships the orchestration shape; the real
 *  warehouse probe lands with P4f / P5).
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 gate / § 3 the deterministic gate (Invariant 6). */

import type { SlotValue } from '../ner/index.js';
import type { RenderTemplate, Template } from '../types.js';

/** Frozen warehouse snapshot the gate hands to the renderer. `data`
 *  is opaque to the orchestrator — the template knows what fields it
 *  needs. Producers SHOULD treat the field as immutable once
 *  populated; runtime freeze is the probe implementation's call.
 *
 *  `render_template_override` is the DATA-DEPENDENT variant-selection
 *  seam: the matcher is purely lexical, so when a single question shape
 *  has two truthful answers split by what the warehouse holds (the
 *  has-email family's "Yes, …" vs "No, …"), the PROBE — the only step
 *  that sees the data — picks the sibling body by returning it here and
 *  the gate renders it INSTEAD of the matched template. Typed
 *  `RenderTemplate` (never `Template`) so an override is render-only by
 *  construction — a probe cannot smuggle a structural plan past the
 *  gate's eligibility check, which runs on the MATCHED template before
 *  the probe is consulted (and `runGate` re-verifies the override's
 *  shape at runtime). Absent → the matched template renders, as before.
 *  Family containment is ENFORCED in `composeShortCircuitFamilies`: the
 *  owning family must declare the override in `overrideTemplates`, and
 *  the declared CANONICAL object is what renders — an undeclared hash
 *  drops the snapshot to pass-through, a declared hash never renders a
 *  probe-supplied body. (Probe routing already happened by the time the
 *  field is read, so an override only changes which body renders, never
 *  which family probes.) */
export interface DataSnapshot {
  readonly data: Readonly<Record<string, unknown>>;
  readonly render_template_override?: RenderTemplate;
}

/** Inputs the probe sees: the matched template plus the certainty-
 *  gated slots NER extracted. The probe maps slots to warehouse keys
 *  (e.g., `entity.email` → `data.contact.<email>`) per the template's
 *  declared `slot_grammar` and queries the relevant collection. */
export interface DataPresenceQuery {
  readonly template: Template;
  readonly slots: ReadonlyArray<SlotValue>;
}

/** The probe signature. Sync OR async — the gate awaits either form
 *  uniformly. `null` is the pass-through signal: either the warehouse
 *  returned no matching record(s), or the probe declined to handle
 *  this template / slot combination. */
export type DataPresenceProbe = (
  query: DataPresenceQuery,
) => Promise<DataSnapshot | null> | DataSnapshot | null;

/** Default no-op probe: never finds data, the gate always passes
 *  through. P4e ships this as the registered default; P4f / P5 swap
 *  in the real `entity.query` probe at boot. */
export const noopDataPresenceProbe: DataPresenceProbe = () => null;

// ── Contact-attribute probe (the first real `entity.query` probe) ───

/** One warehouse contact candidate the injected lookup surfaces. The
 *  shape is the read-only subset the contact-attribute templates render
 *  from — display name + the renderable attributes. Every field is
 *  optional because the warehouse row may carry only some of them; the
 *  probe builds the snapshot from whichever are present.
 *
 *  Kept deliberately narrow (no `_id` / provenance / merge facets): the
 *  probe is a render-source, not a record reader, so it never carries
 *  more PII than the template can emit. */
export interface ContactAttributeRow {
  readonly name?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly company?: string;
  /** EVERY canonical address Recued links to this contact — the row's
   *  own canonical email first, then addresses merged away into it
   *  (D-138 tombstone emails whose `merged_into` chain terminates at
   *  this row). Population is a COMPLETENESS claim: a port sets this
   *  only when the list provably covers the contact's whole linked
   *  address set — INCLUDING the empty set for a live contact with no
   *  real address (a mention-only stub), which is `emails: []`, not an
   *  omitted field. A port that cannot enumerate completeness (or is
   *  surfacing a non-contact sentinel row, e.g. a tombstone kept only
   *  to break name uniqueness) omits the field. Consumers that render
   *  a data-dependent answer over the set require it and defer when
   *  absent: the mail from-count family needs a NON-EMPTY complete set
   *  (a person-scoped total over one resolved address is exactly the
   *  false-total hole the field closes), the calendar next-meeting
   *  family needs the same NON-EMPTY set (the "next" superlative is a
   *  minimum over EVERY address the person could be invited under — a
   *  sooner meeting under an unenumerated merged-away address would
   *  falsify it), and the has-email family's deterministic "no" needs a
   *  present-and-EMPTY one ("no email on file" is the claim that the
   *  complete linked set is empty). `email` alone never stands in for
   *  any of them. */
  readonly emails?: readonly string[];
}

/** The warehouse read seam — injected at boot, mirroring the prefetch's
 *  `EntitySearchPort`. Given a display-name query it returns the candidate
 *  contacts whose name *contains* the query (the backend wires
 *  `ContactStore.list({ name_contains })`); the probe applies the
 *  exact-name + uniqueness filter itself so the port stays a dumb
 *  substring fetch. Sync OR async — the probe awaits either form.
 *
 *  The package stays IO-free per the import boundary (D-159 N.7): the
 *  backend owns the warehouse read + the per-pair read scope (D-157),
 *  this port is the only channel through which a warehouse row reaches
 *  the gate. The no-op default (`() => []`) makes the probe a faithful
 *  pass-through until a real port is wired. */
export type ContactAttributeLookup = (
  name: string,
) => Promise<readonly ContactAttributeRow[]> | readonly ContactAttributeRow[];

/** Normalise a display name for the exact-match compare: trim + collapse
 *  internal whitespace + lower-case. The lookup is a substring fetch
 *  (`name LIKE %x%`), so `"Alice  Bond"` (double space) and `"alice bond"`
 *  must compare equal to the NER slot value `"Alice Bond"`. Matches the
 *  contact store's `COLLATE NOCASE` keying without importing it. */
const normaliseName = (raw: string): string =>
  raw.trim().replace(/\s+/g, ' ').toLowerCase();

/** Resolve the certainty-gated slots to a SINGLE, UNIQUE, exact-name
 *  contact, or `null` to pass through. This is the shared identity step
 *  every contact-anchored short-circuit class runs first (contact
 *  attribute, calendar next-meeting, …) — "we only short-circuit about a
 *  contact we can resolve UNAMBIGUOUSLY." Holding it in one audited place
 *  keeps the two-way-100% identity rule (design § 3 Invariant 5) from
 *  drifting between classes. The steps:
 *
 *    1. Require EXACTLY ONE `entity.name` slot. Zero (nothing to resolve)
 *       or two-plus (ambiguous) → `null`.
 *    2. Fetch candidates via the injected `lookup`, then keep only the
 *       rows whose display name EXACTLY equals the slot value (case- /
 *       whitespace-insensitive). A substring fetch can surface near-misses
 *       (`"Alice Bondsmith"` for `"Alice Bond"`); the exact filter drops them.
 *    3. Fire ONLY on a UNIQUE exact match (`exact.length === 1`). Two
 *       contacts sharing the exact name → `null` (ambiguous → the LLM
 *       disambiguates).
 *
 *  The returned row's `name` is guaranteed a non-empty string (the exact
 *  filter compares its normalised form to a non-empty `wanted`). A
 *  warehouse read failure is a pass-through, never a turn failure — the
 *  LLM path is the safety net (design § 3 Invariant 7). READ-ONLY. */
export const resolveUniqueExactContact = async (
  lookup: ContactAttributeLookup,
  slots: ReadonlyArray<SlotValue>,
): Promise<ContactAttributeRow | null> => {
  const names = slots.filter((s) => s.kind === 'entity.name');
  if (names.length !== 1) return null;
  const wanted = normaliseName(names[0]!.value);
  if (wanted.length === 0) return null;

  let rows: readonly ContactAttributeRow[];
  try {
    rows = await lookup(names[0]!.value);
  } catch {
    return null;
  }

  const exact = rows.filter(
    (r) => typeof r.name === 'string' && normaliseName(r.name) === wanted,
  );
  if (exact.length !== 1) return null; // 0 = absent, 2+ = ambiguous
  return exact[0]!;
};

/** Build the data-presence probe for the single-slot contact-attribute
 *  class ("what is `<Name>`'s email / phone?"). Given the certainty-gated
 *  NER slots, it:
 *
 *    1. Requires EXACTLY ONE `entity.name` slot (the matcher enforces the
 *       same, but the probe is independently injected, so it re-checks).
 *       Zero / two-plus names → `null` (nothing, or ambiguous, to resolve).
 *    2. Fetches candidates via the injected `lookup`, then keeps only the
 *       rows whose display name EXACTLY equals the slot value (case- /
 *       whitespace-insensitive). A substring fetch can return near-misses
 *       (`"Alice Bondsmith"` for `"Alice Bond"`); the exact filter drops them.
 *    3. Fires ONLY on a UNIQUE exact match (`exact.length === 1`) — the
 *       "100% data presence" half of the two-way rule (design § 3
 *       Invariant 5). Two contacts sharing the exact name → `null`
 *       (ambiguous → pass through; the LLM disambiguates).
 *    4. Returns a FROZEN by-value snapshot (Invariant 6 — render-snapshot
 *       freeze) carrying the contact's present, non-empty fields. A row
 *       with no usable display name → `null` (no template can render
 *       without `{{name}}`).
 *
 *  The probe is attribute-agnostic: it resolves the entity and snapshots
 *  every renderable field. WHICH attribute the answer uses is the
 *  template's job — the renderer reads `{{email}}` / `{{phone}}` off this
 *  snapshot and declines (empty render → pass through) when the requested
 *  field is absent. So a phone question on a contact with no phone
 *  resolves the entity here, then falls through at render. READ-ONLY by
 *  construction (design § 3, NER-templates are render-only). */
export const createContactAttributePresenceProbe = (
  lookup: ContactAttributeLookup,
): DataPresenceProbe => async ({ slots }): Promise<DataSnapshot | null> => {
  const row = await resolveUniqueExactContact(lookup, slots);
  if (row === null) return null;

  const data: Record<string, string> = {};
  const put = (key: 'name' | 'email' | 'phone' | 'company', v: unknown): void => {
    if (typeof v === 'string' && v.trim().length > 0) data[key] = v;
  };
  put('name', row.name);
  put('email', row.email);
  put('phone', row.phone);
  put('company', row.company);
  // Every template needs the display name to render; without it there's
  // nothing to short-circuit on.
  if (data.name === undefined) return null;

  return { data: Object.freeze(data) };
};

// ── Calendar next-meeting probe ─────────────────────────────────────

/** The already-resolved "next meeting" the backend lookup surfaces: the
 *  meeting's title + a human-rendered, timezone-resolved "when" string.
 *  Both are pre-formatted by the backend (which owns the future-filter
 *  clock + the locale + the IANA timezone), so the package stays free of
 *  `Date` / `Intl` and the renderer only interpolates strings. */
export interface CalendarNextMeeting {
  readonly summary: string;
  readonly when: string;
}

/** The calendar read seam — injected at boot, mirroring
 *  `ContactAttributeLookup`. Given a contact's COMPLETE linked address set
 *  (see `ContactAttributeRow.emails`) it returns the soonest FUTURE event
 *  that lists ANY of those addresses as an attendee, already reduced to
 *  `{ summary, when }`, or `null` when there is none (no future meeting,
 *  an unusable set, a warehouse / date-format failure) — or when the
 *  contact's per-address responses CONFLICT on a candidate event that
 *  could be the soonest (declined under one linked address, not under
 *  another: whether that meeting is "with" them is genuinely ambiguous,
 *  and both rendering it and skipping it risk a wrong answer, so the
 *  lookup defers).
 *
 *  The package stays IO-free per the import boundary (D-159 N.7): the
 *  backend owns the warehouse scan, the `now`-relative future filter, and
 *  the timezone-aware formatting; this port is the only channel through
 *  which a calendar fact reaches the gate. Sync OR async. The no-op
 *  default (`() => null`) makes the probe a faithful pass-through until a
 *  real port is wired. */
export type CalendarNextMeetingLookup = (
  emails: readonly string[],
) => Promise<CalendarNextMeeting | null> | CalendarNextMeeting | null;

/** Build the data-presence probe for the calendar next-meeting class
 *  ("when's my next meeting with `<Name>`?"). It:
 *
 *    1. Resolves the slots to a UNIQUE exact-name contact via the shared
 *       `resolveUniqueExactContact` — the SAME identity rule as the
 *       contact-attribute class. We short-circuit only about a known,
 *       unambiguous contact; an over-extracted or ambiguous name passes
 *       through.
 *    2. Requires that contact to carry a non-empty email (the canonical
 *       cross-collection identity, same as the mail from-count class) AND
 *       a non-empty `emails` set — the port's COMPLETENESS claim that the
 *       listed addresses are EVERY address Recued links to the contact.
 *       The rendered answer is a SUPERLATIVE ("Your NEXT meeting with
 *       `<Name>` …"), which is only honest as a minimum over the complete
 *       set — a sooner meeting the contact was invited to under a
 *       merged-away address would falsify it. A port that did not (or
 *       could not) enumerate the set omits `emails` and the probe defers;
 *       `email` alone NEVER stands in.
 *    3. Calls the injected `nextMeetingLookup(emails)`; `null` (no future
 *       meeting with that attendee, an ambiguous per-address response
 *       split, or a read / format failure) → `null`.
 *    4. Returns a FROZEN by-value snapshot (Invariant 6) carrying the
 *       contact display name + the meeting summary + the "when" string. A
 *       meeting with a blank summary or "when" is dropped — the body's
 *       `{{summary}}` / `{{when}}` would render empty; the backend lookup
 *       is expected to return non-empty fields, this is defence in depth.
 *
 *  READ-ONLY by construction (design § 3, NER-templates are render-only). */
export const createCalendarNextMeetingProbe = (
  contactLookup: ContactAttributeLookup,
  nextMeetingLookup: CalendarNextMeetingLookup,
): DataPresenceProbe => async ({ slots }): Promise<DataSnapshot | null> => {
  const row = await resolveUniqueExactContact(contactLookup, slots);
  if (row === null) return null;
  if (typeof row.name !== 'string' || row.name.trim().length === 0) return null;
  if (typeof row.email !== 'string' || row.email.trim().length === 0) return null;
  // The complete-set requirement (step 2 — mirrors the mail from-count
  // probe). Defensive shape checks mirror the name/email guards: a
  // malformed entry voids the completeness claim.
  if (!Array.isArray(row.emails) || row.emails.length === 0) return null;
  if (row.emails.some((e) => typeof e !== 'string' || e.trim().length === 0)) return null;

  let meeting: CalendarNextMeeting | null;
  try {
    meeting = await nextMeetingLookup(row.emails);
  } catch {
    // A warehouse read / format failure is a pass-through, never a turn
    // failure — the LLM path is the safety net (design § 3 Invariant 7).
    return null;
  }
  if (meeting === null) return null;
  if (typeof meeting.summary !== 'string' || meeting.summary.trim().length === 0) return null;
  if (typeof meeting.when !== 'string' || meeting.when.trim().length === 0) return null;

  return {
    data: Object.freeze({
      name: row.name,
      summary: meeting.summary,
      when: meeting.when,
    }),
  };
};

// ── Mail from-count probe ──────────────────────────────────────────

/** The mail read seam — injected at boot, mirroring `CalendarNextMeetingLookup`.
 *  Given a contact's COMPLETE linked address set (see
 *  `ContactAttributeRow.emails`) it returns the COUNT of mail records whose
 *  sender is ANY of those addresses (precise, case-insensitive, summed across
 *  every mail collection — distinct addresses can never claim the same scalar
 *  `from`, so the sum is exact), or `null` when there is no mail collection
 *  to count over, the set is unusable (empty / a non-ASCII address the exact
 *  SQL fold can't serve), or a warehouse read failed. A count of `0` (a
 *  mailbox is present but none came from any address) is a NUMBER, distinct
 *  from `null` — the probe owns the firing policy over the two.
 *
 *  The package stays IO-free per the import boundary (D-159 N.7): the backend
 *  owns the warehouse count + the per-pair read scope (D-157); this port is
 *  the only channel through which a mail count reaches the gate. Sync OR
 *  async. The no-op default (`() => null`) makes the probe a faithful
 *  pass-through until a real port is wired. */
export type MailFromCountLookup = (
  emails: readonly string[],
) => Promise<number | null> | number | null;

/** Pluralize the English mail-count phrase the body interpolates:
 *  `1 → "1 email"`, `n → "n emails"`, `0 → "no emails"`. Pure string logic —
 *  the only locale-bound piece is this one English noun, matching the English
 *  template body, so it lives here (the backend lookup stays a pure counter).
 *  Total over non-negative counts; the `0` case is currently UNREACHABLE via
 *  `createMailFromCountProbe` (which defers a zero count to the LLM, see
 *  below), but kept so a future fire-on-zero policy is a one-line probe edit. */
const formatMailCountPhrase = (count: number): string => {
  if (count === 1) return '1 email';
  if (count <= 0) return 'no emails';
  return `${count} emails`;
};

/** Build the data-presence probe for the mail from-count class ("how many
 *  emails from `<Name>`?"). It:
 *
 *    1. Resolves the slots to a UNIQUE exact-name contact via the shared
 *       `resolveUniqueExactContact` — the SAME identity rule as the contact-
 *       attribute + calendar classes. An over-extracted or ambiguous name
 *       passes through.
 *    2. Requires that contact to carry a non-empty name + email (the
 *       canonical identity, same as the other mail/calendar classes) AND a
 *       non-empty `emails` set — the port's COMPLETENESS claim that the
 *       listed addresses are EVERY address Recued links to the contact.
 *       The rendered answer is PERSON-scoped ("You have N emails from
 *       `<Name>`."), which is only honest over the complete set; a port
 *       that did not (or could not) enumerate it omits `emails` and the
 *       probe defers. `email` alone NEVER stands in — a single resolved
 *       address is exactly the false-person-total hole the set closes.
 *    3. Calls the injected `countLookup(emails)`; `null` (no mail
 *       collection / unusable set / read failure) → `null`.
 *    4. FIRES ONLY on a POSITIVE count. A `0` count passes through (`null`):
 *       a confident "you have no emails from `<Name>`" is the LEAST safe
 *       answer — a single sender address the contact record doesn't carry
 *       would flip it from "none" to "some", and the LLM's broader (FTS)
 *       search can catch what our exact-address count can't. A positive count
 *       is a sound total over every address Recued links to the contact
 *       (design § 3 Invariant 7 — defer the uncertain case, answer the
 *       confident one).
 *    5. Returns a FROZEN by-value snapshot (Invariant 6 — render-snapshot
 *       freeze) carrying the contact display name and the pluralized count
 *       phrase for the person-scoped body — see `templates/mail-from-count.ts`.
 *
 *  READ-ONLY by construction (design § 3, NER-templates are render-only). */
export const createMailFromCountProbe = (
  contactLookup: ContactAttributeLookup,
  countLookup: MailFromCountLookup,
): DataPresenceProbe => async ({ slots }): Promise<DataSnapshot | null> => {
  const row = await resolveUniqueExactContact(contactLookup, slots);
  if (row === null) return null;
  if (typeof row.name !== 'string' || row.name.trim().length === 0) return null;
  if (typeof row.email !== 'string' || row.email.trim().length === 0) return null;
  // The complete-set requirement (step 2). Defensive shape checks mirror the
  // name/email guards: a malformed entry voids the completeness claim.
  if (!Array.isArray(row.emails) || row.emails.length === 0) return null;
  if (row.emails.some((e) => typeof e !== 'string' || e.trim().length === 0)) return null;

  let count: number | null;
  try {
    count = await countLookup(row.emails);
  } catch {
    // A warehouse read / count failure is a pass-through, never a turn
    // failure — the LLM path is the safety net (design § 3 Invariant 7).
    return null;
  }
  if (count === null) return null;
  // Fire only on a positive, well-formed count. `<= 0` defers the zero case
  // (see step 4); `!Number.isInteger` guards a lookup bug (NaN / float) from
  // rendering "You have NaN emails".
  if (!Number.isInteger(count) || count <= 0) return null;

  return {
    data: Object.freeze({
      name: row.name,
      count_phrase: formatMailCountPhrase(count),
    }),
  };
};

// ── Contact has-email probe ────────────────────────────────────────

/** The CRM-coverage seam for the has-email family's deterministic "no" —
 *  injected at boot, answering ONE question: could a CRM contact source the
 *  model's `contact.search` consults hold a contact email the LOCAL store
 *  lacks? `true` = yes / can't rule it out (a CRM-contact connection is
 *  enrolled, a platform contact mirror still holds rows, or the check
 *  itself couldn't run) → the "no" must DEFER to the LLM, which can consult
 *  those sources. `false` = provably none → the local store is the complete
 *  contact view and a "no email on file" is sound.
 *
 *  Fail-closed contract: implementations return `true` on ANY uncertainty,
 *  and the probe treats a THROW as `true`. The backend owns the actual
 *  predicate (connection records + contact-mirror scopes — see
 *  `chat-prompt-cache-gate.ts`); the package only consumes the boolean.
 *  Sync OR async. */
export type HasCrmContactSource = () => Promise<boolean> | boolean;

/** Build the data-presence probe for the contact has-email class ("do I
 *  have `<Name>`'s email?"). The first probe to use the snapshot's
 *  `render_template_override` seam — the presence question has TWO truthful
 *  answers split by what the warehouse holds, and only the probe sees the
 *  data. It:
 *
 *    1. Resolves the slots to a UNIQUE exact-name contact via the shared
 *       `resolveUniqueExactContact` (the identity rule every contact-
 *       anchored class shares). Absent, ambiguous, or over-extracted →
 *       `null`. NOTE the deliberate asymmetry: an entirely ABSENT contact
 *       also defers — the LLM's "I don't have a contact named `<Name>`"
 *       is the better answer there, and the resolver cannot tell absent
 *       from ambiguous (where a "no" could be flatly wrong).
 *    2. Requires a non-empty display name (nothing renders without
 *       `{{name}}`).
 *    3. Email PRESENT (real, non-empty — the backend lookup already strips
 *       mention-only placeholders to absent) → frozen `{name, email}`
 *       snapshot; the MATCHED template renders the affirmative
 *       "Yes, `<Name>`'s email address is `<email>`."
 *    4. Email ABSENT → the deterministic "no" fires ONLY when BOTH hold:
 *       - `row.emails` is present and EMPTY — the port's completeness
 *         claim that the contact's whole linked address set holds nothing
 *         (see `ContactAttributeRow.emails`). This is load-bearing against
 *         the stale-identity hole: a tombstone kept name-only to break
 *         uniqueness carries NO `emails` field, so even when it uniquely
 *         resolves it can never render "no" — the person behind that
 *         former name may well have an email on the survivor row. A
 *         NON-empty set with no canonical email (a merged-away real
 *         address on an otherwise email-less contact) also defers — the
 *         LLM can reason about a former address; a flat "no" can't.
 *       - `hasCrmContactSource()` returns `false` (no CRM contact source
 *         the LLM could find the email in — the local store is provably
 *         the complete view).
 *       Then the frozen `{name}` snapshot carries
 *       `render_template_override: noEmailTemplate` and the negative body
 *       renders. Any other combination → `null` (pass through; the LLM
 *       checks CRM) — the pre-CRM-gate behavior, unchanged.
 *
 *  `noEmailTemplate` is injected by the boot wiring (the family owns its
 *  sibling bodies; the gate layer stays template-free) and is typed
 *  `RenderTemplate` so the override is render-only by construction.
 *  READ-ONLY (design § 3, NER-templates are render-only). */
export const createContactHasEmailProbe = (
  contactLookup: ContactAttributeLookup,
  hasCrmContactSource: HasCrmContactSource,
  noEmailTemplate: RenderTemplate,
): DataPresenceProbe => async ({ slots }): Promise<DataSnapshot | null> => {
  const row = await resolveUniqueExactContact(contactLookup, slots);
  if (row === null) return null;
  if (typeof row.name !== 'string' || row.name.trim().length === 0) return null;

  if (typeof row.email === 'string' && row.email.trim().length > 0) {
    return { data: Object.freeze({ name: row.name, email: row.email }) };
  }

  // The negative requires the port's completeness claim to be PRESENT and
  // EMPTY (step 4 — the stale-identity guard). A sentinel row without
  // `emails`, or a contact whose linked set still holds a merged-away
  // address, defers.
  if (!Array.isArray(row.emails) || row.emails.length !== 0) return null;

  let crmCouldHoldIt: boolean;
  try {
    crmCouldHoldIt = await hasCrmContactSource();
  } catch {
    // Can't verify coverage → can't assert the negative. Pass through —
    // the LLM path is the safety net (design § 3 Invariant 7).
    return null;
  }
  if (crmCouldHoldIt) return null;

  return {
    data: Object.freeze({ name: row.name }),
    render_template_override: noEmailTemplate,
  };
};
