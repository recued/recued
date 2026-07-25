/** D-210 A.2 / slice 3b — mint the BOOKING when a reservation is approved.
 *  This seam IS the materialization; there is no second artifact.
 *
 *  ## What 3b changed, and why it is not a refactor
 *
 *  Through 3a an approved reservation produced TWO artifacts: a local calendar
 *  event (the WHEN) and a `data_booking` row beside it (the WHO / the money /
 *  the lifecycle), joined by `calendar_event_source_id`. A.2 struck that:
 *  **booking ⟂ calendar** — if it is a booking it does not go in the calendar.
 *  So the event is gone from this path and the booking, which since 3a owns
 *  `slot_start_at` / `slot_end_at`, is now the whole record.
 *
 *  ⇒ This seam moved OUT of `createReceptionCalendarEventSeam` (where it hung
 *  as `mintBooking`, after the event) and became the `booking` projection
 *  branch's own write path, injected into `runReceptionProjection` as
 *  `deps.createBooking` — the same shape `createCalendarEvent` has for the
 *  intake→calendar branch, which is the ONLY branch that still writes an event.
 *
 *  ## 🔴 The failure posture INVERTED with the move — read this before touching it
 *
 *  Until 3b this seam was BEST-EFFORT: it swallowed every error and returned
 *  `null`. That was correct THEN and is a bug NOW, and the reason is worth
 *  stating because the old rationale reads like it still applies.
 *
 *  The old argument: the calendar event and its I-4 anchor
 *  (`resolved_calendar_event_id`) were already committed before this ran, so a
 *  throw could not be retried — a re-release short-circuited at that anchor and
 *  returned the existing event WITHOUT reaching the mint. Propagating therefore
 *  converted "no booking, loudly" into "no booking, silently, reported as done".
 *  Swallowing was the lesser evil.
 *
 *  Every premise of that argument is now false. There is no calendar event, no
 *  `resolved_calendar_event_id` write, and nothing that short-circuits ahead of
 *  this seam. The anchor is the BOOKING ROW ITSELF, pre-checked below, so a
 *  retry re-attempts the mint instead of skipping it. And the consequence
 *  reversed: swallowing here would report a successful approve that materialized
 *  NOTHING AT ALL — the visitor holds a slot that exists nowhere.
 *
 *  ⇒ **A mint failure THROWS**, the approve fails loudly, and the retry works.
 *  ⇒ [[feedback_a_reversed_rulings_reasoning_outlives_its_location]]
 *
 *  Two things are still deliberately best-effort, and they are not the row:
 *  the counterparty (a locked vault costs the booking its customer, never its
 *  existence) and the `resolved_booking_id` back-pointer (the booking carries
 *  `reception_record_id`, so the pair stays joinable and a retry repairs it).
 *
 *  ## Idempotency — the booking row is its own anchor (I-4)
 *
 *  The id is DETERMINISTIC (`reception_<request_id>`, derived by the drain and
 *  passed through the projection), so the pre-check is a plain read of the row
 *  this seam would write. Present ⇒ return it and write NOTHING — which is the
 *  point: `writeBooking` upserts on `id`, so a blind re-write would reset
 *  `lifecycle_state` to `'confirmed'` and silently un-do an owner who had marked
 *  the booking `no_show`. `data_booking`'s UNIQUE partial index on
 *  `reception_record_id` sits beneath as the belt-and-braces backstop.
 *
 *  ⚠ This replaces the cross-table anchor 3a used. Reading the row you are about
 *  to write is strictly stronger than reading a pointer on a DIFFERENT table
 *  that a second write had to keep in step — there is no two-record consistency
 *  window left to lose.
 *
 *  ## Why the write is SERVER-SIDE, not through the kernel op
 *
 *  `core.work-entity.booking.create` STRIPS `reception_record_id` at its arm — a
 *  recipe, chat turn or MCP door cannot claim a booking came from a visitor
 *  request, because that is an unverifiable authority claim (the engine does not
 *  filter `call.input` by the manifest's declared keys, so the strip is at the
 *  arm, not the manifest). Provenance is exactly what this seam is asserting, so
 *  it calls `writeBooking` directly — the same way the calendar seam calls
 *  `calendarCreate` rather than a `calendar-create` recipe step.
 *
 *  ## Two fields the payload must NOT carry, resolved here instead
 *
 *  1. `counterparty_contact_id`. The visitor's email is SEALED
 *     (`visitor_email_encrypted`, AEAD-bound to the row). It is opened HERE, at
 *     mint time, handed straight to the D-138 contact upsert, and what lands on
 *     the booking is the resulting OPAQUE `contact_id` — never the address.
 *     ⛔ Note the deliberate divergence from `projectContact`, which falls back
 *     to `contact.contact_id ?? email`: that fallback is safe for a contact
 *     record (email-keyed by definition) and would be a LEAK here, because
 *     `data.booking` is a `READABLE_COLLECTIONS` member a door can be granted.
 *     No contact id ⇒ the field is OMITTED. An unidentified booking is a
 *     smaller problem than a sealed address in a grantable collection.
 *
 *  2. `title`. NOT the drain's inbox title: `buildBookingStatement` stamps
 *     `Booking with <name> — <topic>`, which carries the visitor's NAME and
 *     free text. Copying that into `data.booking` would widen the visitor's
 *     identity into a second grantable collection for free — and the booking
 *     already has a governed home for who (`counterparty_contact_id`). The
 *     title is the endpoint's `display_name` instead: owner-authored, already
 *     public (the visitor reads it on the booking page), and the honest answer
 *     to "what was booked".
 *
 *  ⚠ `monetary_value` is deliberately ABSENT. A `scheduling_link` config has no
 *  price field (D-200's paid intake does; scheduling does not), so there is
 *  nothing to source it from. Writing 0 would be inventing the money.
 *
 *  Spec: docs/d-210-spec.md § A.2 (booking ⟂ calendar) + § A.8 slice 3. */

import {
  BOOKING_TITLE_MAX,
  RECUED_BUILTIN_SOURCE_ID,
  type EndpointSummary,
} from '@recued/contracts';

import { openFormSubmissionField } from '../form-pii.js';
import { parseSchedulingLinkConfig } from '../transformations/scheduling-link.js';
import { handleContactUpsert, type ContactRpcDeps } from '../../../contact-handler.js';
import type { FormSubmissionSummary } from '../../../storage/reception-form-store.js';
import type { WorkEntityStore } from '../../../storage/work-entity-store.js';

/** Fallback title when the endpoint's `display_name` is unreachable (the
 *  endpoint row is gone, or its metadata does not parse as a scheduling
 *  config). Generic on purpose — the alternative sources all carry visitor
 *  free-text. */
const FALLBACK_BOOKING_TITLE = 'Booking';

const clamp = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/** The `booking` projection branch's write path for a SCHEDULING reservation.
 *  Returns the materialized booking's id.
 *
 *  🔴 THROWS on failure — it is the whole materialization, so a swallowed error
 *  would be an approve that reports success having written nothing (see the
 *  header). The pre-check makes the retry safe. */
export type ReceptionBookingMintEffect = (input: {
  readonly booking_request_id: string;
  /** The DETERMINISTIC booking id (`reception_<request_id>`) — derived by the
   *  drain, carried through the projection as `input.id`. Both the idempotency
   *  anchor (the pre-check reads it) and the row's primary key, so the two can
   *  never disagree. */
  readonly booking_id: string;
  /** 🔴 The AGREED slot, resolved by the projection — NOT the reservation row's
   *  `selected_slot_*`, which is the visitor's original ASK and is write-once
   *  provenance. The owner may edit the start at the approval gate, and this is
   *  the edited value (already I-7-guarded). Reading the sealed row here instead
   *  would mint the booking at a time nobody agreed to, at success. */
  readonly slot_start_at: number;
  readonly slot_end_at: number;
  /** D-210 A.8 slice 3d — the owner ticked "tell the visitor" on THIS approval.
   *  Off unless they turned it on; see `ReceptionProjectionInput.notify_visitor`
   *  for why it is a per-approval choice and not a policy. */
  readonly notify_visitor: boolean;
}) => Promise<string>;

export interface ReceptionBookingMintSeamDeps {
  /** The booking business row writer. Called DIRECTLY (not via the kernel op)
   *  so `reception_record_id` — server-asserted provenance — can be set; see
   *  the header. */
  readonly writeBooking: WorkEntityStore['writeBooking'];
  /** I-4 — read the row this seam would write. A hit means an earlier approve
   *  already materialized this reservation; the seam returns it untouched
   *  rather than upserting over the owner's `lifecycle_state`. */
  readonly readBooking: WorkEntityStore['readBooking'];
  /** Load the sealed reservation row by `request_id`. Server-side store only. */
  readonly findBooking: (request_id: string) => FormSubmissionSummary | null;
  /** Write the resolved pointer back onto the reception row. Best-effort — the
   *  booking carries `reception_record_id`, so the pair stays joinable without
   *  it and a retry repairs it. Absent → no back-pointer.
   *
   *  ⚠ D-210 A.8 slice 4b-ii — the frozen `resolved_booking_id` became the
   *  generic `resolved` pair, and `markProcessed` became PARTIAL. Both matter
   *  here: this seam is the ONE caller that knows the pointer, and it used to be
   *  a full SET whose value any later outcome-only call silently nulled. */
  readonly markProcessed?: (input: {
    submission_id: string;
    outcome: 'processed';
    resolved: { readonly kind: string; readonly id: string };
  }) => unknown;
  /** Load the endpoint the reservation came through, for its owner-authored
   *  `display_name`. Absent → the fallback title. */
  readonly findEndpoint?: (endpoint_id: string) => EndpointSummary | null;
  /** Derive the booking-PII AEAD key. THROWS on a locked FileVault — caught
   *  here, since a locked vault must cost the booking its counterparty, not
   *  the booking itself. */
  readonly getFormSubmissionPiiKey?: () => Uint8Array;
  /** The live `contact.upsert` path (D-138). Absent → no counterparty. */
  readonly contactDeps?: ContactRpcDeps;
  /** D-210 A.8 slice 3d — send the visitor their confirmation. The recipient is
   *  NOT an argument by construction: the op opens the sealed address itself
   *  from the booking's `reception_record_id`, so this seam composes a message
   *  for someone whose address it never holds. Absent → a ticked
   *  `notify_visitor` REFUSES (see `assertCanNotifyVisitor`). */
  readonly notifyVisitor?: (input: {
    booking_id: string;
    sender_mail_instance: string;
    subject: string;
    body: string;
  }) => Promise<{ notified: boolean; reason?: string }>;
  /** D-196 precedent (`isSellerSenderMailInstanceReady`) — is this a LIVE
   *  send-capable `data.mail.<name>`? A configured-but-dead sender must fail
   *  the same way an absent one does, at the same moment: before the mint. */
  readonly isLiveSendCapableMailInstance?: (instance_id: string) => boolean;
  readonly now?: () => number;
}

/** Resolve the reservation's counterparty to an OPAQUE contact id, opening the
 *  sealed visitor fields server-side. Returns `null` on ANY shortfall — a
 *  locked vault, an absent contact path, a visitor who gave no email, or a
 *  contact row without an id. ⛔ Never returns the address: `null` is the only
 *  alternative to a real contact id. */
const resolveCounterparty = async (
  deps: ReceptionBookingMintSeamDeps,
  row: FormSubmissionSummary,
  now: number,
): Promise<string | null> => {
  if (deps.contactDeps === undefined || deps.getFormSubmissionPiiKey === undefined) return null;
  const key = deps.getFormSubmissionPiiKey();
  // ⚠ D-210 A.8 slice 4b-ii — the FORM key + its own column. Reading the address
  // from the dedicated column (never the blob) is what keeps this from unsealing
  // the visitor's whole submission to derive one contact.
  const email = await openFormSubmissionField({
    key,
    endpoint_id: row.endpoint_id,
    submission_id: row.submission_id,
    field: 'visitor_email',
    ciphertext: row.visitor_email_encrypted,
  });
  if (email === null || email.trim().length === 0) return null;
  // ⛔ EMAIL ONLY — the visitor's NAME is deliberately NOT passed.
  //
  // `handleContactUpsert` → `upsertManual` records a supplied name as a
  // `source: 'manual'` contribution, and `'manual'` is index 0 of
  // `CONTACT_CONTRIBUTION_SOURCES` — the STRONGEST rung, above `user_confirmed`,
  // `vendor_meta` (CRM) and `contact_book`. The store's own comment at that site
  // warns about exactly this: a manual write "would LAUNDER its provenance to
  // the top of the ladder … and would then outrank every future correction,
  // forever."
  //
  // A name the VISITOR typed about themselves is not owner-hand-typed data. If
  // it went through here, a visitor booking a slot could overwrite the name the
  // owner typed for that contact — `"Jane Okafor"` becomes `"jane"` — and
  // outrank every later CRM correction. The owner approved a calendar event;
  // nothing in that approval says "and relabel my contact".
  //
  // Nothing is lost by omitting it: the visitor's name is already on the event
  // summary, which is where the owner reads who is coming. What the mint needs
  // from this call is an IDENTITY KEY, not a display name.
  // ⇒ [[a_preserve_merge_launders_provenance]] / [[trust_rung_is_not_source_identity]]
  const { contact } = await handleContactUpsert(deps.contactDeps, {
    email,
    last_interaction: now,
  });
  // ⛔ NO `?? email` fallback here — see the header. `contact_id` has been
  // NOT-NULL-enforced since D-192 C-2 slice 3, so this is a fail-closed guard
  // against a substrate regression, not an expected branch.
  return typeof contact.contact_id === 'string' && contact.contact_id.length > 0
    ? contact.contact_id
    : null;
};

/** The endpoint's owner-authored service name, clamped. Never visitor text.
 *
 *  TOTAL by construction: it runs inside the mint's write path, so a registry
 *  hiccup that threw here would cost the reservation its whole business record
 *  over a display string. Same principle as the counterparty — a partial
 *  substrate costs the booking a FIELD, never the row. (`== null` rather than
 *  `=== null` on purpose: the dep is a `Pick<>` of a store interface, and a
 *  fake or a future impl returning `undefined` would otherwise reach
 *  `undefined.metadata`.) */
const resolveTitle = (
  deps: ReceptionBookingMintSeamDeps,
  endpoint_id: string,
): string => {
  if (deps.findEndpoint === undefined) return FALLBACK_BOOKING_TITLE;
  try {
    const endpoint = deps.findEndpoint(endpoint_id);
    if (endpoint == null) return FALLBACK_BOOKING_TITLE;
    const config = parseSchedulingLinkConfig(endpoint.metadata);
    const name = config?.display_name?.trim();
    return name !== undefined && name.length > 0
      ? clamp(name, BOOKING_TITLE_MAX)
      : FALLBACK_BOOKING_TITLE;
  } catch {
    return FALLBACK_BOOKING_TITLE;
  }
};

/** Build the booking-mint effect bound to the live stores. THROWS on any
 *  failure that costs the booking its row (see the file header); the caller's
 *  approve fails loudly and the retry re-attempts through the pre-check. */
/** The endpoint's owner-designated sender, or `null`. Never throws — a
 *  malformed metadata blob is an absent sender, and the caller turns that into
 *  a refusal with a cause. */
const resolveNotifySender = (
  deps: ReceptionBookingMintSeamDeps,
  endpoint_id: string,
): string | null => {
  if (deps.findEndpoint === undefined) return null;
  try {
    const endpoint = deps.findEndpoint(endpoint_id);
    if (endpoint == null) return null;
    const sender = parseSchedulingLinkConfig(endpoint.metadata)?.on_booking
      ?.notify_visitor_sender?.trim();
    return sender !== undefined && sender.length > 0 ? sender : null;
  } catch {
    return null;
  }
};

/** 🔴 Runs BEFORE the mint, and throwing is the point.
 *
 *  The owner asked for a notification. The three ways it can fail here — no
 *  send path wired, no sender designated on the link, a sender that is not a
 *  live send-capable account — are all invisible to them AFTER the fact: the
 *  booking would exist, the approve would report success, and the only missing
 *  thing would be a message in someone else's inbox that they have no way to
 *  check. So it fails here, loudly, while the approve can still be retried with
 *  the box unticked or the sender fixed.
 *
 *  ⚠ This is deliberately NOT the posture of the counterparty resolution above,
 *  and the difference is which failure the OWNER can see. A missing
 *  counterparty is visible on the booking row the moment they look at it; an
 *  unsent notification is visible nowhere. [[feedback_a_tag_is_a_promise]] */
const assertCanNotifyVisitor = (
  deps: ReceptionBookingMintSeamDeps,
  endpoint_id: string,
  booking_request_id: string,
): string => {
  const refuse = (why: string): never => {
    throw new Error(
      `reception booking mint: reservation '${booking_request_id}' was approved with `
        + `"tell the visitor" ticked, but ${why}. Nothing was written — set a `
        + 'send-capable sender on the scheduling link (on_booking.notify_visitor_sender), '
        + 'or approve again with the box unticked.',
    );
  };
  if (deps.notifyVisitor === undefined) {
    refuse('this server has no visitor-notify path wired');
  }
  const sender = resolveNotifySender(deps, endpoint_id);
  if (sender === null) {
    refuse('the scheduling link designates no sender mail account');
  }
  if (deps.isLiveSendCapableMailInstance?.(sender!) !== true) {
    refuse(`'${sender!}' is not a live send-capable mail account`);
  }
  return sender!;
};

/** The endpoint's IANA zone, defaulting to UTC.
 *
 *  ⚠ Load-bearing for a message that LEAVES the building. Rendering a wall
 *  clock in the server's zone is already a known wrong-date hazard for the
 *  owner's own screens; posting one to a visitor who may be in another country
 *  turns it into a missed appointment. The zone is therefore both applied AND
 *  named in the text, so an ambiguous time cannot be read two ways.
 *  [[feedback_a_wall_clock_is_not_an_instant]] */
const resolveEndpointTimezone = (
  deps: ReceptionBookingMintSeamDeps,
  endpoint_id: string,
): string => {
  if (deps.findEndpoint === undefined) return 'UTC';
  try {
    const endpoint = deps.findEndpoint(endpoint_id);
    if (endpoint == null) return 'UTC';
    const tz = parseSchedulingLinkConfig(endpoint.metadata)
      ?.available_window_definition?.tz?.trim();
    return tz !== undefined && tz.length > 0 ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
};

const formatSlotForVisitor = (at: number, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(at));
  } catch {
    // An unparseable zone must not cost the visitor their message. Fall back to
    // UTC and say so, rather than emitting a time with no zone at all.
    return `${new Date(at).toISOString()} (UTC)`;
  }
};

/** The confirmation the visitor receives.
 *
 *  🔑 It names the ORIGINAL ask only when the owner actually moved it. A
 *  message that always recites "you asked for X" reads as a correction even
 *  when nothing changed; one that never does silently swaps the time under
 *  someone who wrote the first one in their diary. The reservation row keeps
 *  the ask and the booking keeps the agreement precisely so this comparison is
 *  possible. */
const composeVisitorConfirmation = (
  agreedAt: number,
  askedAt: number | null,
  timeZone: string,
): { subject: string; body: string } => {
  const agreed = formatSlotForVisitor(agreedAt, timeZone);
  const moved = askedAt !== null && askedAt !== agreedAt;
  const zoneNote = timeZone === 'UTC' ? '' : ` (${timeZone})`;
  return {
    subject: moved ? 'Your booking is confirmed — at a new time' : 'Your booking is confirmed',
    body: moved
      ? `Your booking is confirmed for ${agreed}${zoneNote}.\n\n`
        + `This is not the time you originally asked for `
        + `(${formatSlotForVisitor(askedAt, timeZone)}${zoneNote}) — it was moved when the `
        + `booking was confirmed. If the new time does not work for you, just reply to this `
        + `message.`
      : `Your booking is confirmed for ${agreed}${zoneNote}.\n\n`
        + `If you need to change it, just reply to this message.`,
  };
};

export const createReceptionBookingMintSeam = (
  deps: ReceptionBookingMintSeamDeps,
): ReceptionBookingMintEffect => async ({
  booking_request_id,
  booking_id,
  slot_start_at,
  slot_end_at,
  notify_visitor,
}) => {
  // I-4 — the row this seam would write IS the anchor. A hit means an earlier
  // approve already materialized this reservation: return it and write nothing.
  // ⚠ Returning early is the load-bearing half, not an optimization —
  // `writeBooking` upserts on `id`, so falling through would reset
  // `lifecycle_state` to the store's `'confirmed'` default and silently un-mark
  // a booking the owner had already set to `no_show` / `cancelled`.
  const existing = deps.readBooking(booking_id);
  if (existing != null) return existing.id;

  const row = deps.findBooking(booking_request_id);
  // `== null` (not `===`): the dep is a `Pick<>` of a store interface, so a
  // fake or a future impl returning `undefined` must take this branch rather
  // than reach `row.endpoint_id`.
  if (row == null) {
    // No reservation row ⇒ nothing to attribute the booking to, and no slot to
    // give it. THROWS (3b): this is the whole materialization, so continuing
    // would mint a timeless, unattributed booking and report success.
    throw new Error(
      `reception booking mint: no reservation row for '${booking_request_id}' — `
        + 'the booking has no slot and no provenance to materialize from',
    );
  }
  // 🔴 BEFORE the write, deliberately. See `assertCanNotifyVisitor`: an
  // un-sendable notification must cost the approve, not be discovered later by
  // a visitor who never turned up. Nothing has been written at this point, so
  // the refusal leaves a retry cleanly available.
  const notifySender = notify_visitor
    ? assertCanNotifyVisitor(deps, row.endpoint_id, booking_request_id)
    : null;
  const now = deps.now?.() ?? Date.now();
  // The counterparty is resolved SEPARATELY from the write: a shortfall here
  // (locked vault, no email) costs the booking its customer, never the row.
  let counterparty: string | null = null;
  try {
    counterparty = await resolveCounterparty(deps, row, now);
  } catch (err) {
    console.warn('[reception] booking counterparty resolution failed (booking still minted)', {
      booking_request_id,
      // ⛔ The error is NOT spread here: the contact/mail paths embed the
      // resolved address in some messages, and it must not reach a log.
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
  // ⚠ NOT wrapped. A write failure PROPAGATES (3b) — see the header: this row
  // is the entire materialization, so swallowing would report a successful
  // approve that created nothing, and the pre-check above makes the retry safe.
  const booking = deps.writeBooking(
    {
      id: booking_id,
      source_id: RECUED_BUILTIN_SOURCE_ID('booking'),
      title: resolveTitle(deps, row.endpoint_id),
      // `lifecycle_state` is OMITTED → defaults to 'confirmed'. The approval
      // IS the confirmation; 'pending' exists for owner-authored flows.
      //
      // D-210 A.2 — THE SLOT IS THE RECORD'S OWN TIME, and since 3b it is the
      // ONLY copy of it (there is no event to defer to).
      //
      // 🔴 It comes from the CALLER, not `row.selected_slot_*`. Those two
      // disagree whenever the owner edited the start at the approval gate, and
      // the row deliberately keeps the visitor's original ask (write-once
      // provenance). Minting from the row would confirm a time nobody agreed to.
      //
      // ⚠ Assigned as named keys, NOT merged via a spread: an object spread
      // opts out of tsc's excess-property check, so a misspelling would be
      // silently DROPPED and the booking would mint with no time at all,
      // green. [[a_spread_skips_excess_property_checks]]
      slot_start_at,
      slot_end_at,
      // ⚠ Duration is DERIVED from the pair above, never carried. Storing it
      // would hold one fact twice, the exact defect this row's design avoids.
      reception_record_id: booking_request_id,
      ...(counterparty !== null ? { counterparty_contact_id: counterparty } : {}),
    },
    now,
  );

  // The send, AFTER the row exists — the op resolves the sealed address from
  // the booking's own `reception_record_id`, so there is nothing to notify
  // about until it is written.
  //
  // ⚠ Guarded, unlike the pre-check. The two failures are not the same: an
  // un-SENDABLE notification (no sender) is a misconfiguration the owner can
  // fix and re-approve into, so it refuses before anything is written; a send
  // that was attempted and failed has already consumed the approve, and
  // throwing here would roll the owner back to an inbox item whose booking now
  // EXISTS — a retry would hit the I-4 pre-check, return early, and never
  // re-attempt the send anyway. Loud in the log, and the booking stands.
  if (notifySender !== null && deps.notifyVisitor !== undefined) {
    const askedAt = row.slot?.start_at ?? null;
    const { subject, body } = composeVisitorConfirmation(
      slot_start_at,
      askedAt,
      resolveEndpointTimezone(deps, row.endpoint_id),
    );
    try {
      const sent = await deps.notifyVisitor({
        booking_id: booking.id,
        sender_mail_instance: notifySender,
        subject,
        body,
      });
      if (sent.notified !== true) {
        console.error('[reception] booking minted but the visitor was NOT told', {
          booking_request_id,
          booking_id: booking.id,
          // A COARSE business reason (`no_visitor_email` / `booking_not_found` /
          // `not_a_reception_booking`) — never the address, which the op is
          // built so as never to hand back.
          reason: sent.reason ?? 'unknown',
        });
      }
    } catch (err) {
      console.error('[reception] booking minted but the visitor notification threw', {
        booking_request_id,
        booking_id: booking.id,
        // ⛔ Not spread — the mail path embeds the resolved recipient in some
        // messages, and it must not reach a log.
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  // The back-pointer, LAST and guarded. Genuinely best-effort: the booking
  // carries `reception_record_id`, so the pair is joinable without it, and a
  // retry's pre-check returns the SAME deterministic id and re-attempts this.
  // ⚠ D-210 A.8 slice 4b-ii — this used to note that NOT passing
  // `resolved_calendar_event_id` wrote NULL, because `markProcessed` was a full
  // SET. Both halves are gone: the frozen columns collapsed into the generic
  // pair (a reservation resolves to a BOOKING and, since A.2, to nothing else),
  // and the write is PARTIAL, so this names exactly what it knows and touches
  // nothing else. A later outcome-only call can no longer erase it.
  if (deps.markProcessed !== undefined) {
    try {
      deps.markProcessed({
        submission_id: booking_request_id,
        outcome: 'processed',
        resolved: { kind: 'booking', id: booking.id },
      });
    } catch (err) {
      console.error(
        '[reception] booking minted but the reception back-pointer did not land',
        {
          booking_request_id,
          booking_id: booking.id,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
  return booking.id;
};
