/** D-210 A.8 slice 4b-ii — a booking round-trips through the MERGED table.
 *
 *  ## Why this exists as an integration test
 *
 *  The switch moved two things at once, and the type system can only see one of
 *  them. It sees the table change. It does NOT see the KEY change: a booking's
 *  fields used to seal under `booking-pii.ts` and now seal under
 *  `form-pii.ts`, and a seal/open key mismatch typechecks perfectly and fails
 *  only when a real visitor's real booking will not open. So the round trip is
 *  asserted end to end — seal, store, read back, open — rather than per unit.
 *
 *  The second case is the one that would otherwise rot silently: it proves the
 *  OLD key can no longer open a booking, and that it REFUSES rather than
 *  yielding blanks. A blank-yielding failure is the dangerous one — a recipe
 *  would read the blanks and write them as fact. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';
import {
  sealBookingSubmissionBlob,
  openBookingSubmissionBlob,
} from '../ports/reception/booking-blob.js';
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  sealFormSubmissionField,
  openFormSubmissionField,
} from '../ports/reception/form-pii.js';
import { buildPairedBookingRecord } from '../ports/reception/booking-record.js';

const NOW = 1_700_000_000_000;
const SUB_DEK = new Uint8Array(32).fill(7);

describe('D-210 A.8 slice 4b-ii — a booking round-trips through the merged table', () => {
  it('seals, stores, reads back, and opens with the FORM key', async () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const store = createReceptionFormSubmissionStore(db);
    const key = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);

    const blob = await sealBookingSubmissionBlob({
      key,
      endpoint_id: 'ep-1',
      submission_id: 'bk-1',
      fields: {
        name: 'Ada',
        email: 'ada@example.test',
        phone: null,
        topic: 'a consultation',
        notes: 'ground floor please',
      },
    });
    const email = await sealFormSubmissionField({
      key,
      endpoint_id: 'ep-1',
      submission_id: 'bk-1',
      field: 'visitor_email',
      plaintext: 'ada@example.test',
    });

    const row = store.insert({
      submission_id: 'bk-1',
      endpoint_id: 'ep-1',
      form_definition_id: null,
      submitted_at: NOW,
      source_ip_hash: null,
      visitor_email_encrypted: email,
      submission_blob_encrypted: blob,
      schema_version: 1,
      processing_outcome: 'pending',
      slot: { start_at: NOW + 86_400_000, end_at: NOW + 88_200_000, duration_minutes: 30 },
    });

    expect(row.record_kind).toBe('booking');
    expect(row.slot).toEqual({
      start_at: NOW + 86_400_000,
      end_at: NOW + 88_200_000,
      duration_minutes: 30,
    });

    // The blob opens back to exactly what went in.
    const stored = store.findById('bk-1')!;
    const fields = await openBookingSubmissionBlob({
      key,
      endpoint_id: 'ep-1',
      submission_id: 'bk-1',
      ciphertext: stored.submission_blob_encrypted,
    });
    expect(fields).toEqual({
      name: 'Ada',
      email: 'ada@example.test',
      phone: null,
      topic: 'a consultation',
      notes: 'ground floor please',
    });

    // The email column opens independently — the property that lets the notify
    // path read an address without unsealing the whole submission.
    expect(await openFormSubmissionField({
      key,
      endpoint_id: 'ep-1',
      submission_id: 'bk-1',
      field: 'visitor_email',
      ciphertext: stored.visitor_email_encrypted,
    })).toBe('ada@example.test');

    // The drain's booking page finds it.
    expect(store.listPendingBookingsForEndpoint('ep-1').map((r) => r.submission_id))
      .toEqual(['bk-1']);

    // And the paired record builder produces the recipe-facing shape, with
    // `omit` honoured as ABSENT rather than null.
    const built = await buildPairedBookingRecord({
      key,
      endpoint_id: 'ep-1',
      row: stored,
      required_visitor_fields: {
        name: 'required',
        email: 'required',
        topic: 'optional',
        phone: 'omit',
        notes: 'optional',
      },
      timezone: 'Europe/Paris',
    });
    expect(built.kind).toBe('ready');
    if (built.kind !== 'ready') throw new Error('unreachable');
    expect(Object.hasOwn(built.record, 'phone')).toBe(false);
    expect(built.record.name).toBe('Ada');
    expect(built.record.notes).toBe('ground floor please');
    expect(built.record.slot_start_at).toBe(NOW + 86_400_000);
    expect(built.record.timezone).toBe('Europe/Paris');
  });

  // D-210 A.8 slice 4c — this was 'the BOOKING key can no longer open a booking
  // — proving the stream moved', and it proved it by deriving the booking key
  // and failing to open with it. 4c DELETED `booking-pii.ts`, so that mutation
  // is now impossible by construction rather than merely caught — strictly
  // stronger, and the comparand is gone.
  //
  // 🔑 What did NOT go away is the property underneath: a wrong key must REFUSE.
  // A booking blob carries the visitor's name and free text, and an AEAD that
  // returned blanks under the wrong key would let a mis-keyed reader render an
  // empty booking as a real one. The DROP key stands in as the wrong key —
  // a live sibling stream, so this doubles as cross-stream separation.
  it('a booking blob refuses to open under a sibling stream’s key', async () => {
    const { deriveDropBlobPiiKeyFromSubDek } =
      await import('../ports/reception/drop-pii.js');
    const formKey = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    const dropKey = deriveDropBlobPiiKeyFromSubDek(SUB_DEK);
    expect(Buffer.from(formKey).equals(Buffer.from(dropKey))).toBe(false);

    const blob = await sealBookingSubmissionBlob({
      key: formKey,
      endpoint_id: 'ep-1',
      submission_id: 'bk-1',
      fields: { name: 'Ada' },
    });
    // Wrong key ⇒ refusal, not silent blanks.
    await expect(openBookingSubmissionBlob({
      key: dropKey,
      endpoint_id: 'ep-1',
      submission_id: 'bk-1',
      ciphertext: blob,
    })).rejects.toThrow();
  });
});
