/** D-210 slice 3 — the booking minted when a reservation is approved.
 *
 *  The reservation's resolved pointer (`resolved_booking_id`, né
 *  `resolved_commitment_id`, and since D-210 A.8 slice 4b-ii the generic
 *  `resolved_target_kind` / `resolved_target_id` pair) was declared and never
 *  written. This suite drives its producer: the mint seam fired from the
 *  calendar seam's I-4 branch, over the REAL work-entity / contact / booking
 *  stores (only the calendar create is faked — it is the IO).
 *
 *  The three assertions that are not about the happy path:
 *
 *    - ⛔ THE SEALED ADDRESS NEVER REACHES THE ROW. `counterparty_contact_id`
 *      carries the opaque D-138 contact id; the whole `data_booking` row is
 *      scanned for the address, because `data.booking` is a grantable
 *      collection and `projectContact`'s `contact.contact_id ?? email` fallback
 *      would be a leak if it were copied here.
 *    - ⛔ THE TITLE IS NOT THE DRAIN'S. The drain stamps
 *      `Booking with <name> — <topic>`; the mint uses the endpoint's
 *      owner-authored `display_name`, so the visitor's NAME does not widen into
 *      a second collection.
 *    - ⛔ A MINT FAILURE MUST NOT STRAND THE I-4 ANCHOR. If it did, the retry
 *      would create a SECOND calendar event — the visitor's slot double-booked.
 *      That is why the anchor is written before the mint, not with it. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECUED_BUILTIN_SOURCE_ID, type EndpointSummary } from '@recued/contracts';

import { ensureReceptionSchema } from '../storage/reception-store.js';
// D-210 A.8 slice 4b-ii — a reservation is a `reception_form_submission` row
// with a slot; `reception_booking_request` has no writer any more.
import {
  createReceptionFormSubmissionStore,
  type FormSubmissionStore,
} from '../storage/reception-form-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import { createReceptionBookingMintSeam } from '../ports/reception/projection/reception-booking-mint.js';
import { mintReceptionBookingBinding } from '../ports/reception/projection/reception-booking-binding.js';
// ⚠ The FORM key, not the booking one, and ONE blob instead of four columns —
// the row's readers open with `openFormSubmissionField` (`booking-blob.ts`).
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  sealFormSubmissionField,
} from '../ports/reception/form-pii.js';
import { sealBookingSubmissionBlob } from '../ports/reception/booking-blob.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ENDPOINT_ID = 'ep-1';
const VISITOR_EMAIL = 'alex@example.com';
const VISITOR_NAME = 'Alex Visitor';
/** What the drain would have put on the calendar event — name AND free text. */
const DRAIN_SUMMARY = `Booking with ${VISITOR_NAME} — Design review`;
const SERVICE_NAME = '30-minute intro call';

const SUB_DEK = new Uint8Array(32).fill(7);
const piiKey = (): Uint8Array => deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);

let dir: string;
let db: Database.Database;
let bookingStore: FormSubmissionStore;
let workStore: WorkEntityStore;
let contactStore: ContactStore;
let calendarCreates: number;

interface EnvOptions {
  /** Omit the contact path (or the PII key) → no counterparty resolvable. */
  readonly withContact?: boolean;
  /** Omit the endpoint registry → the fallback title. */
  readonly withEndpoint?: boolean;
  /** Force the booking write to throw, to prove the anchor survives it. */
  readonly writeBookingThrows?: boolean;
  /** D-210 A.8 slice 3d — omit the send path / the sender designation / the
   *  liveness of the designated sender, independently. Each must refuse a
   *  ticked `notify_visitor` BEFORE anything is written. */
  readonly withNotifyPath?: boolean;
  readonly notifySender?: string | null;
  readonly senderIsLive?: boolean;
  /** Make the send itself fail — either outcome. Unlike the three above, these
   *  happen AFTER the row exists and must NOT cost the booking. */
  readonly notifyThrows?: boolean;
  readonly notifyReturnsUnsent?: string;
}

/** Every visitor notification the seam attempted, in order. */
let notifyCalls: {
  booking_id: string;
  sender_mail_instance: string;
  subject: string;
  body: string;
}[] = [];

const SENDER = 'work-mail';

const endpointRow = (sender: string | null = SENDER): EndpointSummary =>
  ({
    endpoint_id: ENDPOINT_ID,
    kind: 'scheduling_link',
    enabled: true,
    packet_declaration: { fields: [] },
    created_at: NOW - DAY,
    created_by_client_id: 'client-1',
    expires_at: null,
    long_lived_acknowledged_at: null,
    revoked_at: null,
    revocation_reason: null,
    audit_count: 0,
    last_accessed_at: null,
    // A COMPLETE scheduling config — `parseSchedulingLinkConfig` VALIDATES
    // before returning, so a partial blob silently yields `null` and the title
    // assertions would pass against the fallback for the wrong reason. (This
    // fixture was hand-rolled wrong the first time and did exactly that; the
    // shape below is the validated one from the D-149 P10 integration suite.)
    metadata: {
      display_name: SERVICE_NAME,
      duration_options_minutes: [30],
      available_window_definition: {
        tz: 'UTC',
        explicit_windows: [
          { day_of_week: 1, start_minute: 540, end_minute: 1020 },
        ],
      },
      required_visitor_fields: {
        name: 'required',
        email: 'required',
        topic: 'optional',
        phone: 'omit',
        notes: 'optional',
      },
      min_advance_notice_hours: 1,
      max_lead_time_days: 30,
      max_bookings_per_day: 0,
      on_booking: {
        create_calendar_event: true,
        create_commitment_entity: true,
        ...(sender !== null ? { notify_visitor_sender: sender } : {}),
      },
    },
  }) as unknown as EndpointSummary;

const buildSeam = (opts: EnvOptions = {}) =>
  createReceptionBookingMintSeam({
    writeBooking: (input, now) => {
      if (opts.writeBookingThrows === true) throw new Error('disk on fire');
      return workStore.writeBooking(input, now);
    },
    readBooking: (id) => workStore.readBooking(id),
    findBooking: (request_id) => bookingStore.findById(request_id),
    markProcessed: (input) => bookingStore.markProcessed(input),
    ...(opts.withEndpoint !== false
      ? {
          findEndpoint: (id) =>
            id === ENDPOINT_ID
              ? endpointRow(opts.notifySender === undefined ? SENDER : opts.notifySender)
              : null,
        }
      : {}),
    getFormSubmissionPiiKey: piiKey,
    ...(opts.withContact !== false ? { contactDeps: { store: contactStore } } : {}),
    ...(opts.withNotifyPath !== false
      ? {
          notifyVisitor: async (input) => {
            notifyCalls.push(input);
            if (opts.notifyThrows === true) throw new Error('smtp refused');
            return opts.notifyReturnsUnsent !== undefined
              ? { notified: false, reason: opts.notifyReturnsUnsent }
              : { notified: true };
          },
        }
      : {}),
    isLiveSendCapableMailInstance: () => opts.senderIsLive !== false,
    now: () => NOW,
  });

/** Insert a reservation whose visitor PII is SEALED exactly as the public
 *  booking handler seals it — the mint must open it itself. */
const insertReservation = async (request_id: string): Promise<void> => {
  const key = piiKey();
  // D-210 A.8 slice 4b-ii — the four sealed columns became ONE
  // `submission_blob_encrypted`; the email KEEPS its own column, which is the
  // one the mint opens to resolve the counterparty (it never unseals the blob).
  const submission_blob_encrypted = await sealBookingSubmissionBlob({
    key,
    endpoint_id: ENDPOINT_ID,
    submission_id: request_id,
    fields: {
      name: VISITOR_NAME,
      email: VISITOR_EMAIL,
      phone: null,
      topic: null,
      notes: null,
    },
  });
  bookingStore.insert({
    submission_id: request_id,
    endpoint_id: ENDPOINT_ID,
    form_definition_id: null,
    submitted_at: NOW - 500,
    source_ip_hash: null,
    visitor_email_encrypted: await sealFormSubmissionField({
      key,
      endpoint_id: ENDPOINT_ID,
      submission_id: request_id,
      field: 'visitor_email',
      plaintext: VISITOR_EMAIL,
    }),
    submission_blob_encrypted,
    schema_version: 1,
    processing_outcome: 'pending',
    // `slot` present is what MAKES the row a booking — the store derives the
    // kind from it, and with it the outcome vocabulary the row may carry.
    slot: {
      start_at: NOW + DAY,
      end_at: NOW + DAY + 30 * 60_000,
      duration_minutes: 30,
    },
  });
};

/** The deterministic booking id the drain derives and the projection passes
 *  through — `receptionIdForBooking`. Spelled here rather than imported so a
 *  silent change to the derivation shows up as a failure, not a moved goalpost:
 *  it is the I-4 anchor, and re-deriving it differently would mint a SECOND
 *  booking for one slot. */
const bookingIdFor = (request_id: string): string => `reception_${request_id}`;

/** Approve with NO owner edit — the agreed slot is the requested slot, which is
 *  what the projection resolves in the common case. ⚠ The pair is supplied by
 *  the CALLER (the projection), never read off the sealed row inside the mint:
 *  the two diverge the moment an owner edits the start at the gate, and
 *  `d-173-i5-slot-edit-row-staleness` is what pins that. */
const approve = async (
  mint: ReturnType<typeof createReceptionBookingMintSeam>,
  request_id: string,
  slot?: { start: number; end: number },
  notify_visitor = false,
): Promise<string> =>
  mint({
    booking_request_id: request_id,
    booking_id: bookingIdFor(request_id),
    booking_binding: mintReceptionBookingBinding(piiKey(), {
      booking_request_id: request_id,
      booking_id: bookingIdFor(request_id),
    }),
    slot_start_at: slot?.start ?? NOW + DAY,
    slot_end_at: slot?.end ?? NOW + DAY + 30 * 60_000,
    // Defaults OFF here for the same reason it defaults off in the pack: every
    // pre-3d test in this file asserts a mint that tells NOBODY, and a fixture
    // default of `true` would silently turn all of them into send tests.
    notify_visitor,
  });

/** Every value on the raw booking row, as one lowercase haystack. Raw SQL, not
 *  the typed read: a leak into a column the projection happens to drop would
 *  still be a leak on disk. */
const rawBookingText = (id: string): string => {
  const row = db.prepare('SELECT * FROM data_booking WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  // ⚠ Without this, a MISSING row yields '{}' and every `not.toContain` on the
  // result passes VACUOUSLY — the leak detector would report "clean" precisely
  // when there is nothing to inspect.
  expect(row).toBeDefined();
  return JSON.stringify(row).toLowerCase();
};

beforeEach(() => {
  notifyCalls = [];
  dir = mkdtempSync(join(tmpdir(), 'd210-booking-mint-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  ensureReceptionSchema(db);
  ensureWorkEntitySchema(db);
  bookingStore = createReceptionFormSubmissionStore(db);
  workStore = createWorkEntityStore(db);
  contactStore = createContactStore(db);
  workStore.registerSource({
    id: RECUED_BUILTIN_SOURCE_ID('booking'),
    top_tier_kind: 'booking',
    source_kind: 'builtin',
    source_label: 'Recued built-in',
    write_capable: true,
    mcp_exposed: false,
  });
  calendarCreates = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('D-210 slice 3 — a reservation approve mints its booking', () => {
  it('mints the booking and fills the resolved pointer', async () => {
    await insertReservation('req-1');
    const booking_id = await approve(buildSeam(), 'req-1');

    const row = bookingStore.findById('req-1');
    // D-210 A.8 slice 4b-ii — the frozen `resolved_booking_id` became the generic
    // `(kind, id)` pair. BOTH halves: an id alone would pass for a row resolved
    // to some other kind entirely, and reading THAT id as a booking id is what
    // would move the wrong record.
    expect(row?.resolved_target_kind).toBe('booking');
    expect(row?.resolved_target_id).toBe(booking_id);

    const booking = workStore.readBooking(booking_id);
    expect(booking).not.toBeNull();
    // The provenance pointer that makes the pair joinable — and, since A.2, the
    // ONLY link between a booking and the request it came from.
    expect(booking!.reception_record_id).toBe('req-1');
    // The approval IS the confirmation (NOT the enum's first member).
    expect(booking!.lifecycle_state).toBe('confirmed');
    // No price to source from a scheduling_link config ⇒ absent, not zero.
    expect(booking!.monetary_value).toBeUndefined();
  });

  it('⛔ A.2 — mints NO calendar event and stores no pointer to one', async () => {
    // The whole point of 3b. A booking is a business record; the calendar is
    // personal. If this ever regresses, the visitor is double-booked across two
    // artifacts that can drift apart — which is the defect A.2 removed.
    await insertReservation('req-1');
    const booking_id = await approve(buildSeam(), 'req-1');

    expect(calendarCreates).toBe(0);
    // ⚠ D-210 A.8 slice 4b-ii — a `resolved_calendar_event_id` null-check stood
    // here; 4b-ii removed the column. ⛔ Do NOT re-point it at `resolved_target_id`
    // and assert null — this same approve WRITES that column, so the assertion
    // would invert and pass for the wrong reason.
    //
    // The claim "stores no pointer to a calendar event" is still assertable, and
    // this is its honest modern form: the one resolved pointer names a BOOKING.
    // It fails if a calendar event ever comes back, and unlike a null-check it
    // also proves the pointer was written at all.
    const resolved = bookingStore.findById('req-1')!;
    expect(resolved.resolved_target_kind).toBe('booking');
    expect(resolved.resolved_target_id).toBe(booking_id);
    // ⚠ A third assertion lived here — `Object.hasOwn(booking,
    // 'calendar_event_source_id') === false`. Slice 3c dropped the column, so
    // it became true for free and proved nothing. The guarantee did not go
    // away with it: it moved to where it can still FAIL, as a DDL ratchet in
    // `d-210-booking-work-entity-store.test.ts` ("has NO calendar column").
    expect(workStore.readBooking(booking_id)).not.toBeNull();
  });

  it('carries the AGREED slot onto the booking (A.2 — the booking owns its time)', async () => {
    // 🔑 This is the one that a `...spread` typo would have shipped green:
    // an object spread opts out of tsc's excess-property check, so a
    // misspelled slot key drops silently and the booking mints with no time
    // at all — at `success: true`, with the reservation still showing the
    // slot the visitor picked. Asserted against the FIXTURE's own values so
    // it cannot pass on a default.
    await insertReservation('req-1');
    await approve(buildSeam(), 'req-1');

    const reservation = bookingStore.findById('req-1')!;
    const booking = workStore.readBooking(reservation.resolved_target_id!)!;

    expect(booking.slot_start_at).toBe(NOW + DAY);
    expect(booking.slot_end_at).toBe(NOW + DAY + 30 * 60_000);
    // The booking's time IS the reservation's time — not merely non-null.
    expect(booking.slot_start_at).toBe(reservation.slot!.start_at);
    expect(booking.slot_end_at).toBe(reservation.slot!.end_at);
    // Duration is DERIVED, never stored: no such column, no such key.
    expect(Object.hasOwn(booking, 'duration_minutes')).toBe(false);
    expect(booking.slot_end_at! - booking.slot_start_at!).toBe(
      reservation.slot!.duration_minutes * 60_000,
    );
  });

  it('titles the booking from the endpoint display_name, never the drain summary', async () => {
    await insertReservation('req-1');
    await approve(buildSeam(), 'req-1');

    const booking = workStore.readBooking(bookingIdFor('req-1'));
    expect(booking!.title).toBe(SERVICE_NAME);
    // The drain's summary carries the visitor's NAME. It reached the seam (it
    // is the event's summary) and must not have reached the booking.
    expect(booking!.title).not.toBe(DRAIN_SUMMARY);
    expect(rawBookingText(booking!.id)).not.toContain('alex');
  });

  it('falls back to a generic title rather than visitor text when the endpoint is gone', async () => {
    await insertReservation('req-1');
    await approve(buildSeam({ withEndpoint: false }), 'req-1');

    const booking = workStore.readBooking(bookingIdFor('req-1'));
    expect(booking!.title).toBe('Booking');
    expect(rawBookingText(booking!.id)).not.toContain('alex');
  });

  it('still mints when the endpoint lookup THROWS — a title cannot sink the row', async () => {
    // `resolveTitle` runs inside the write path, so a registry hiccup that
    // propagated would cost the reservation its whole business record over a
    // display string.
    await insertReservation('req-1');
    const seam = createReceptionBookingMintSeam({
      writeBooking: (input, now) => workStore.writeBooking(input, now),
      readBooking: (id) => workStore.readBooking(id),
      findBooking: (request_id) => bookingStore.findById(request_id),
      markProcessed: (input) => bookingStore.markProcessed(input),
      getFormSubmissionPiiKey: piiKey,
      findEndpoint: () => {
        throw new Error('registry unavailable');
      },
      now: () => NOW,
    });
    await approve(seam, 'req-1');

    const booking = workStore.readBooking(bookingIdFor('req-1'));
    expect(booking).not.toBeNull();
    expect(booking!.title).toBe('Booking');
  });

  it('resolves the counterparty to an OPAQUE contact id — never the sealed address', async () => {
    await insertReservation('req-1');
    await approve(buildSeam(), 'req-1');

    const booking = workStore.readBooking(bookingIdFor('req-1'));
    const contact = contactStore.get(VISITOR_EMAIL);
    expect(contact?.contact_id).toBeTruthy();
    // The identity landed — on the contact, keyed by the id.
    expect(booking!.counterparty_contact_id).toBe(contact!.contact_id);
    // ⛔ The load-bearing assertion. `data.booking` is grantable; the sealed
    // address must not be anywhere on the row. Mutating the mint's
    // `contact_id ?? null` to `?? email` turns this red.
    expect(booking!.counterparty_contact_id).not.toBe(VISITOR_EMAIL);
    const haystack = rawBookingText(booking!.id);
    expect(haystack).not.toContain(VISITOR_EMAIL);
    expect(haystack).not.toContain('example.com');
  });

  it('⛔ omits the counterparty rather than falling back to the email when the contact has no id', async () => {
    // The guard this proves is fail-closed against a SUBSTRATE REGRESSION, so
    // it cannot be reached through the real store: `contact_id` has been
    // NOT-NULL-enforced since D-192 C-2 slice 3, which means the happy-path
    // test above passes whether the guard is `?? null` or `?? email` — it is
    // hollow on this point, and mutating the mint proved exactly that. Only an
    // id-less contact exercises the branch, so the store is faked HERE (and
    // only here) to produce one. `projectContact` legitimately does fall back
    // to the email; copying that into a grantable collection is the leak.
    await insertReservation('req-1');
    const idlessStore = {
      upsertManual: () => ({ email: VISITOR_EMAIL, contact_id: null }),
    } as unknown as ContactStore;
    const seam = createReceptionBookingMintSeam({
writeBooking: (input, now) => workStore.writeBooking(input, now),
      readBooking: (id) => workStore.readBooking(id),
      findBooking: (request_id) => bookingStore.findById(request_id),
      markProcessed: (input) => bookingStore.markProcessed(input),
      getFormSubmissionPiiKey: piiKey,
      contactDeps: { store: idlessStore },
      now: () => NOW,
    });
    await approve(seam, 'req-1');

    const booking = workStore.readBooking(bookingIdFor('req-1'));
    expect(booking).not.toBeNull();
    expect(booking!.counterparty_contact_id).toBeUndefined();
    const haystack = rawBookingText(booking!.id);
    expect(haystack).not.toContain(VISITOR_EMAIL);
    expect(haystack).not.toContain('example.com');
  });

  it("⛔ a visitor's self-declared name must not overwrite the owner's own", async () => {
    // `handleContactUpsert` records a supplied name as a `source: 'manual'`
    // contribution, and 'manual' is index 0 of CONTACT_CONTRIBUTION_SOURCES —
    // the STRONGEST rung, above user_confirmed / vendor_meta (CRM) /
    // contact_book. So passing the visitor's typed name would let a stranger
    // booking a slot relabel the owner's contact AND outrank every future CRM
    // correction. The mint passes the email ONLY; this is what proves it.
    const owner = contactStore.upsertManual(
      { email: VISITOR_EMAIL, name: 'Jane Okafor' },
      NOW - DAY,
    );
    expect(owner.name).toBe('Jane Okafor');

    // The visitor types 'jane' into the booking form (sealed as visitor_name).
    await insertReservation('req-1');
    await approve(buildSeam(), 'req-1');

    // The contact was still resolved (the booking has its counterparty)…
    const booking = workStore.readBooking(bookingIdFor('req-1'));
    expect(booking!.counterparty_contact_id).toBe(contactStore.get(VISITOR_EMAIL)!.contact_id);
    // …and the owner's own name survived the visitor's.
    expect(contactStore.get(VISITOR_EMAIL)!.name).toBe('Jane Okafor');
  });

  it('⛔ a contact-upsert failure must not log the sealed address', async () => {
    // The contact store throws `contact_invalid_email: <plaintext address>`
    // (contact-store.ts:2250) and `handleContactUpsert` re-throws it verbatim.
    // So the mint's inner catch logging `err.name` instead of `err.message` is
    // LOAD-BEARING, not stylistic — it is the only thing between a sealed
    // visitor address and a server log. Mutating it to `.message` turns this red.
    await insertReservation('req-1');
    const throwingStore = {
      upsertManual: () => {
        throw new Error(`contact_invalid_email: ${VISITOR_EMAIL}`);
      },
    } as unknown as ContactStore;
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seam = createReceptionBookingMintSeam({
writeBooking: (input, now) => workStore.writeBooking(input, now),
      readBooking: (id) => workStore.readBooking(id),
      findBooking: (request_id) => bookingStore.findById(request_id),
      markProcessed: (input) => bookingStore.markProcessed(input),
      getFormSubmissionPiiKey: piiKey,
      contactDeps: { store: throwingStore },
      now: () => NOW,
    });
    await approve(seam, 'req-1');

    // It still minted (a counterparty shortfall costs a FIELD, not the row)…
    const booking = workStore.readBooking(bookingIdFor('req-1'));
    expect(booking).not.toBeNull();
    expect(booking!.counterparty_contact_id).toBeUndefined();
    // …and it complained, without ever naming the visitor.
    expect(warns).toHaveBeenCalled();
    const logged = JSON.stringify(warns.mock.calls).toLowerCase();
    expect(logged).not.toContain(VISITOR_EMAIL);
    expect(logged).not.toContain('example.com');
  });

  it('still mints — without a counterparty — when the contact path is absent', async () => {
    await insertReservation('req-1');
    await approve(buildSeam({ withContact: false }), 'req-1');

    const booking = workStore.readBooking(bookingIdFor('req-1'));
    // A partial substrate costs the booking a FIELD, never the row.
    expect(booking).not.toBeNull();
    expect(booking!.counterparty_contact_id).toBeUndefined();
    expect(rawBookingText(booking!.id)).not.toContain(VISITOR_EMAIL);
  });

  it('refuses when the vault is locked because caller-selected ids cannot be authenticated', async () => {
    await insertReservation('req-1');
    const seam = createReceptionBookingMintSeam({
writeBooking: (input, now) => workStore.writeBooking(input, now),
      readBooking: (id) => workStore.readBooking(id),
      findBooking: (request_id) => bookingStore.findById(request_id),
      markProcessed: (input) => bookingStore.markProcessed(input),
      getFormSubmissionPiiKey: () => {
        throw new Error('FileVault is locked');
      },
      contactDeps: { store: contactStore },
      now: () => NOW,
    });
    await expect(approve(seam, 'req-1')).rejects.toThrow(/FileVault is locked/);
    expect(workStore.readBooking(bookingIdFor('req-1'))).toBeNull();
  });

  it('rejects missing, forged, and cross-pair bindings before either caller-selected id is read', async () => {
    const readBooking = vi.fn(() => null);
    const findBooking = vi.fn(() => null);
    const writeBooking = vi.fn(() => {
      throw new Error('must not write');
    });
    const seam = createReceptionBookingMintSeam({
      readBooking: readBooking as never,
      findBooking,
      writeBooking: writeBooking as never,
      getFormSubmissionPiiKey: piiKey,
      now: () => NOW,
    });
    const crossPair = mintReceptionBookingBinding(piiKey(), {
      booking_request_id: 'req-other',
      booking_id: bookingIdFor('req-other'),
    });
    for (const booking_binding of ['', 'a'.repeat(43), crossPair]) {
      await expect(seam({
        booking_request_id: 'req-1',
        booking_id: bookingIdFor('req-1'),
        booking_binding,
        slot_start_at: NOW + DAY,
        slot_end_at: NOW + DAY + 30 * 60_000,
        notify_visitor: false,
      })).rejects.toThrow(/invalid caller-bound booking provenance/);
    }
    expect(readBooking).not.toHaveBeenCalled();
    expect(findBooking).not.toHaveBeenCalled();
    expect(writeBooking).not.toHaveBeenCalled();
  });

  it('🔴 a mint failure THROWS — an approve must never report success with no record', async () => {
    // ⚠ This assertion is the INVERSE of the one it replaced, and the reversal
    // is the point of 3b. While the mint ran after a committed calendar event,
    // swallowing was right: a throw could not be retried (the retry
    // short-circuited at the event anchor without reaching the mint), so
    // propagating turned "no booking, loudly" into "no booking, silently,
    // reported as done".
    //
    // Nothing survives of that. There is no event, no anchor ahead of this
    // seam, and the booking IS the materialization — so a swallowed failure
    // would report a successful approve that created NOTHING, and the visitor
    // would hold a slot that exists nowhere.
    await insertReservation('req-1');

    await expect(approve(buildSeam({ writeBookingThrows: true }), 'req-1'))
      .rejects.toThrow(/disk on fire/);

    // Nothing was written and nothing was CLAIMED: a back-pointer here would be
    // provenance that lies.
    expect(workStore.listBookings({})).toHaveLength(0);
    expect(bookingStore.findById('req-1')?.resolved_target_id).toBeNull();
  });

  it('🔴 refuses a reservation that no longer exists rather than minting a timeless booking', async () => {
    // No row ⇒ no slot and no provenance. Continuing would mint a booking with
    // no time at all, at success.
    await expect(approve(buildSeam(), 'req-gone')).rejects.toThrow(/no reservation row/);
    expect(workStore.listBookings({})).toHaveLength(0);
  });

  it('🔴 a re-approve must NOT reset a lifecycle the owner already advanced', async () => {
    // The load-bearing half of the I-4 pre-check, and the one a "tidy" refactor
    // would drop as redundant. `writeBooking` upserts on `id`, so falling
    // through on a re-approve would re-write `lifecycle_state` to the store's
    // 'confirmed' default — silently un-marking a booking the owner had set to
    // `no_show`, at success:true, with the audit showing a normal approve.
    await insertReservation('req-1');
    const booking_id = await approve(buildSeam(), 'req-1');
    const minted = workStore.readBooking(booking_id)!;
    workStore.writeBooking(
      {
        id: booking_id,
        title: minted.title,
        source_id: minted.source_id,
        lifecycle_state: 'no_show',
        slot_start_at: minted.slot_start_at!,
        slot_end_at: minted.slot_end_at!,
      },
      NOW + 1000,
    );
    expect(workStore.readBooking(booking_id)!.lifecycle_state).toBe('no_show');

    await approve(buildSeam(), 'req-1');

    expect(workStore.readBooking(booking_id)!.lifecycle_state).toBe('no_show');
    expect(workStore.listBookings({})).toHaveLength(1);
  });

  it('⛔ a failing back-pointer write must not cost the approve its booking', async () => {
    // The back-pointer is the LAST write and it is wrapped, because the two
    // failure modes stay asymmetric even without the calendar: losing the row
    // loses the customer and the money, while losing the pointer leaves a
    // booking that still carries `reception_record_id` — joinable, and repaired
    // by the next retry, whose pre-check returns the same deterministic id.
    await insertReservation('req-1');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mint = createReceptionBookingMintSeam({
      writeBooking: (input, now) => workStore.writeBooking(input, now),
      readBooking: (id) => workStore.readBooking(id),
      findBooking: (request_id) => bookingStore.findById(request_id),
      markProcessed: () => {
        throw new Error('SQLITE_BUSY');
      },
      getFormSubmissionPiiKey: piiKey,
      now: () => NOW,
    });
    // The approve completes rather than throwing…
    await expect(approve(mint, 'req-1')).resolves.toBe(bookingIdFor('req-1'));
    // …the booking exists and is still joinable by reception_record_id…
    const minted = workStore.listBookings({});
    expect(minted).toHaveLength(1);
    expect(minted[0]?.reception_record_id).toBe('req-1');
    // …the pointer is genuinely absent (not quietly written anyway)…
    expect(bookingStore.findById('req-1')?.resolved_target_id).toBeNull();
    // …and the loss was reported.
    expect(errors).toHaveBeenCalled();
  });

  it('does not mint a second booking on a re-approve', async () => {
    await insertReservation('req-1');
    const first = await approve(buildSeam(), 'req-1');

    const second = await approve(buildSeam(), 'req-1');

    expect(second).toBe(first);
    expect(bookingStore.findById('req-1')!.resolved_target_id).toBe(first);
    expect(workStore.listBookings({}).length).toBe(1);
  });

  // ⚠ Titled for what it actually constrains. It does NOT exercise the UNIQUE
  // partial index on `reception_record_id` — two distinct record ids cannot
  // collide, so downgrading that index to a plain one leaves this GREEN. The
  // index is pinned where it can bite, in
  // `d-210-booking-work-entity-store.test.ts` (`toThrow(/UNIQUE constraint/)`).
  it('mints one booking PER reservation, not one per server', async () => {
    await insertReservation('req-1');
    await insertReservation('req-2');
    const seam = buildSeam();
    await approve(seam, 'req-1');
    await approve(seam, 'req-2');

    const a = bookingStore.findById('req-1')!.resolved_target_id;
    const b = bookingStore.findById('req-2')!.resolved_target_id;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(workStore.listBookings({}).length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// D-210 A.8 slice 3d — "tell the visitor" is a per-approval OWNER CHOICE
//
// Owner-ruled: a notification fires only when the owner turns it on for that
// approval. The reactive recipe this replaced fired on EVERY booking update
// with no opt-in at all (event-trigger rows install `enabled DEFAULT 1`).
// ────────────────────────────────────────────────────────────────

describe('visitor confirmation — the form option', () => {
  it('tells NOBODY when the owner did not tick it', async () => {
    // The default, and the reason the fixture helper defaults to false: every
    // other test in this file is an un-ticked approve, and they must all stay
    // silent. A default of `true` anywhere would turn the whole suite green
    // for the wrong reason.
    await insertReservation('req-1');
    await approve(buildSeam(), 'req-1');
    expect(notifyCalls).toEqual([]);
  });

  it('sends when the owner ticks it, from the link’s designated sender', async () => {
    await insertReservation('req-1');
    const booking_id = await approve(buildSeam(), 'req-1', undefined, true);

    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0]!.booking_id).toBe(booking_id);
    expect(notifyCalls[0]!.sender_mail_instance).toBe(SENDER);
    // ⛔ The recipient is NOT here and cannot be: the op opens the sealed
    // address itself. Asserted as an ABSENCE over the whole call, because the
    // failure this guards is the address arriving as an argument at all.
    const asText = JSON.stringify(notifyCalls[0]).toLowerCase();
    expect(asText).not.toContain(VISITOR_EMAIL.toLowerCase());
    expect(asText).not.toContain(VISITOR_NAME.toLowerCase());
  });

  it('names the ORIGINAL ask only when the owner actually moved the slot', async () => {
    // 🔑 The whole reason the reservation keeps the ask and the booking keeps
    // the agreement. A message that always recites "you asked for X" reads as a
    // correction when nothing changed; one that never does swaps the time
    // under someone who wrote the first one in their diary.
    await insertReservation('req-1');
    await approve(buildSeam(), 'req-1', undefined, true);
    const unmoved = notifyCalls[0]!;
    expect(unmoved.subject).not.toMatch(/new time/i);
    expect(unmoved.body).not.toMatch(/originally asked/i);

    notifyCalls = [];
    await insertReservation('req-2');
    // The reservation asked for NOW + DAY; the owner approves an hour later.
    await approve(
      buildSeam(),
      'req-2',
      { start: NOW + DAY + 3_600_000, end: NOW + DAY + 3_600_000 + 30 * 60_000 },
      true,
    );
    const moved = notifyCalls[0]!;
    expect(moved.subject).toMatch(/new time/i);
    expect(moved.body).toMatch(/originally asked/i);
    // Both times present — the visitor can see what changed, not just the new value.
    expect(moved.body).toMatch(/\d{2}:\d{2}/);
  });

  it.each([
    ['no send path is wired', { withNotifyPath: false }, /no visitor-notify path/i],
    ['the link designates no sender', { notifySender: null }, /designates no sender/i],
    ['the designated sender is not live', { senderIsLive: false }, /not a live send-capable/i],
  ])(
    '🔴 REFUSES the approve, writing NOTHING, when %s',
    async (_label, opts, expected) => {
      // The load-bearing half is `listBookings().length === 0`, not the throw.
      // If this ever mints and swallows the send instead, the owner sees a
      // confirmed booking and a visitor who was never told — and there is no
      // surface anywhere that would show them the difference. Refusing before
      // the write keeps the approve retryable with the box unticked.
      await insertReservation('req-1');
      await expect(approve(buildSeam(opts), 'req-1', undefined, true)).rejects.toThrow(expected);

      expect(workStore.listBookings({}).length).toBe(0);
      expect(workStore.readBooking(bookingIdFor('req-1'))).toBeNull();
      expect(bookingStore.findById('req-1')!.resolved_target_id).toBeNull();
      expect(notifyCalls).toEqual([]);
    },
  );

  it.each([
    ['the send throws', { notifyThrows: true }],
    ['the send reports not-sent', { notifyReturnsUnsent: 'no_visitor_email' }],
  ])('KEEPS the booking when %s — the approve is already spent', async (_label, opts) => {
    // The opposite posture to the refusals above, and the difference is WHEN.
    // These fail after the row exists, so throwing would hand the owner back an
    // inbox item whose booking already EXISTS — and a retry would short-circuit
    // on the I-4 pre-check and never re-attempt the send anyway.
    await insertReservation('req-1');
    const booking_id = await approve(buildSeam(opts), 'req-1', undefined, true);

    expect(workStore.readBooking(booking_id)).not.toBeNull();
    expect(workStore.readBooking(booking_id)!.lifecycle_state).toBe('confirmed');
    expect(notifyCalls.length).toBe(1);
  });

  it('does not re-notify on a re-approve — the I-4 pre-check returns first', async () => {
    // A replayed approve must not mail the visitor a second confirmation.
    await insertReservation('req-1');
    const first = await approve(buildSeam(), 'req-1', undefined, true);
    expect(notifyCalls.length).toBe(1);

    const second = await approve(buildSeam(), 'req-1', undefined, true);
    expect(second).toBe(first);
    expect(notifyCalls.length).toBe(1);
  });
});
