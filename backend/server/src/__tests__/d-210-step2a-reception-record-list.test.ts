/** D-210 step 2a — `reception.record.list`: the record stops being invisible.
 *
 *  A reception row was invisible for its entire life (Appendix A). Tolerable while every row
 *  MOVES — it becomes a held op, then an artifact. Not tolerable once a row can be HELD:
 *  since R-2 the scheduling drain deliberately leaves a booking `pending` on a stale pair,
 *  and a held row has no held op, so the inbox cannot show it however good its join is.
 *
 *  Drives the REAL stores over an in-memory DB; only the store getters are seams.
 *
 *  The properties, in the order they matter:
 *    - ⛔ REDACTED: no visitor values AND no ciphertext to recover them from,
 *    - a HELD booking is visible — the whole point,
 *    - each kind keeps its OWN outcome vocabulary (asking a booking for `spam` REFUSES
 *      rather than answering an empty list),
 *    - truncation is reported, never silent,
 *    - a partial boot answers with what it has rather than hiding the other kind.
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureReceptionSchema } from '../storage/reception-store.js';
// D-210 A.8 slice 4b-ii — ONE store for both kinds. A booking and an intake are
// rows in the same `reception_form_submission` table, told apart by the
// booking's slot; the handler asks for the kind it wants.
import {
  createReceptionFormSubmissionStore,
  type FormSubmissionStore,
} from '../storage/reception-form-store.js';
// ⚠ The FORM key, not the booking one, and ONE blob instead of four columns —
// the row's readers open with `openFormSubmissionField` (`booking-blob.ts`).
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  sealFormSubmissionField,
} from '../ports/reception/form-pii.js';
import { sealBookingSubmissionBlob } from '../ports/reception/booking-blob.js';
import {
  handleReceptionRecordList,
  makeReceptionRecordHandlers,
  type ReceptionRecordDeps,
} from '../reception-record-handler.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const BOOKING_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x5a));
const ADMIN = { instance_id: 'owner-client' };

interface Env {
  bookings: FormSubmissionStore;
  submissions: FormSubmissionStore;
  deps: ReceptionRecordDeps;
}

const buildEnv = (): Env => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  // D-210 A.8 slice 4b-ii — ONE store, two names. The two deps stay separate
  // because a partial boot may wire one and not the other, and this file's
  // partial-boot case depends on that; they simply point at the same table now.
  const submissions = createReceptionFormSubmissionStore(db);
  const bookings = submissions;
  return {
    bookings,
    submissions,
    deps: { getBookingStore: () => bookings, getSubmissionStore: () => submissions },
  };
};

const insertBooking = async (
  env: Env,
  input: {
    request_id: string;
    endpoint_id?: string;
    received_at?: number;
    visitor_name?: string;
    visitor_email?: string;
    outcome?: 'processed' | 'rejected';
  },
): Promise<void> => {
  const endpoint_id = input.endpoint_id ?? 'ep-book';
  // D-210 A.8 slice 4b-ii — the four sealed columns became ONE
  // `submission_blob_encrypted`; the email KEEPS its own column.
  env.bookings.insert({
    submission_id: input.request_id,
    endpoint_id,
    form_definition_id: null,
    submitted_at: input.received_at ?? NOW - 500,
    source_ip_hash: 'ip-hash',
    visitor_email_encrypted: await sealFormSubmissionField({
      key: BOOKING_KEY,
      endpoint_id,
      submission_id: input.request_id,
      field: 'visitor_email',
      plaintext: input.visitor_email ?? null,
    }),
    submission_blob_encrypted: await sealBookingSubmissionBlob({
      key: BOOKING_KEY,
      endpoint_id,
      submission_id: input.request_id,
      fields: { name: input.visitor_name, email: input.visitor_email },
    }),
    schema_version: 1,
    processing_outcome: 'pending',
    // `slot` present is what MAKES the row a booking — and it is what keeps this
    // row out of the intake arm's `record_kind: 'intake'` page.
    slot: {
      start_at: NOW + DAY,
      end_at: NOW + DAY + 30 * 60_000,
      duration_minutes: 30,
    },
  });
  if (input.outcome) {
    env.bookings.markProcessed({ submission_id: input.request_id, outcome: input.outcome });
  }
};

const insertSubmission = (
  env: Env,
  input: {
    submission_id: string;
    endpoint_id?: string;
    submitted_at?: number;
    outcome?: 'processed' | 'spam';
  },
): void => {
  env.submissions.insert({
    submission_id: input.submission_id,
    endpoint_id: input.endpoint_id ?? 'ep-form',
    form_definition_id: 'fd-1',
    submitted_at: input.submitted_at ?? NOW - 400,
    source_ip_hash: 'ip-hash',
    visitor_email_encrypted: 'CIPHERTEXT-EMAIL',
    submission_blob_encrypted: 'CIPHERTEXT-BLOB',
    schema_version: 1,
    // Required at insert — `spam` / `rejected_domain` are SUBMIT-time verdicts, so the store
    // does not default this.
    processing_outcome: input.outcome === 'spam' ? 'spam' : 'pending',
  });
  if (input.outcome === 'processed') {
    env.submissions.markProcessed({ submission_id: input.submission_id, outcome: 'processed' });
  }
};

let env: Env;
beforeEach(() => {
  env = buildEnv();
});

describe('D-210 step 2a — the record is REDACTED by construction', () => {
  it('carries no visitor values and no ciphertext to recover them from', async () => {
    await insertBooking(env, {
      request_id: 'req-1',
      visitor_name: 'Alex Visitor',
      visitor_email: 'alex@visitor.test',
    });
    insertSubmission(env, { submission_id: 'sub-1' });

    const res = await handleReceptionRecordList(env.deps, {}, ADMIN);
    const wire = JSON.stringify(res);

    // The plaintext never entered this path at all — nothing here holds the key.
    expect(wire).not.toContain('Alex Visitor');
    expect(wire).not.toContain('alex@visitor.test');
    // ⛔ And NOT the ciphertext either. Handing it back would move the decrypt decision to
    // the caller; D-149 § N.6 / D-173 I-3 put it on the server.
    expect(wire).not.toContain('CIPHERTEXT-EMAIL');
    expect(wire).not.toContain('CIPHERTEXT-BLOB');
    expect(wire).not.toContain('encrypted');
    // The sealed booking row's ciphertext is base64 of the AEAD output — assert on the
    // FIELD NAMES rather than the value, since the value is opaque.
    for (const record of res.records) {
      expect(Object.keys(record)).not.toContain('visitor_email_encrypted');
      expect(Object.keys(record)).not.toContain('submission_blob_encrypted');
      expect(Object.keys(record)).not.toContain('source_ip_hash');
      expect(Object.keys(record)).not.toContain('pair_binding');
      expect(Object.keys(record)).not.toContain('metadata');
    }
  });
});

describe('D-210 step 2a — a HELD record is visible (the point)', () => {
  it('surfaces a pending booking the drain is holding, with nothing resolved', async () => {
    // The R-2 case: the owner's paired recipe went stale, so the drain leaves the booking
    // pending forever rather than running a recipe they did not choose. Before this rpc the
    // owner had no way to see it at all.
    await insertBooking(env, { request_id: 'req-held' });

    const res = await handleReceptionRecordList(env.deps, { kind: 'scheduling_link' }, ADMIN);

    expect(res.records).toHaveLength(1);
    const record = res.records[0]!;
    expect(record.kind).toBe('scheduling_link');
    expect(record.record_id).toBe('req-held');
    expect(record.outcome).toBe('pending');
    // Nothing materialized — which is exactly how the owner sees that it is stuck.
    expect(record.resolved).toEqual([]);
    if (record.kind !== 'scheduling_link') throw new Error('expected a booking');
    expect(record.slot.start_at).toBe(NOW + DAY);
    expect(record.slot.duration_minutes).toBe(30);
  });

  it('surfaces a booking&apos;s resolved destination through the generic lens', async () => {
    await insertBooking(env, { request_id: 'req-1' });
    // ⚠ D-210 A.8 slice 4b-ii — the SETUP moved, the expectation did not. This
    // used to write `resolved_calendar_event_id`, one of the two destination
    // columns Appendix A froze into the booking schema, and prove the read
    // NORMALIZED it into the generic pair. 4b-ii deleted both columns, so there
    // is no longer a specialized shape to normalize FROM — the pair is the
    // storage. The write is spelled generically here; what it produces on the
    // wire is asserted unchanged.
    env.bookings.markProcessed({
      submission_id: 'req-1',
      outcome: 'processed',
      resolved: { kind: 'calendar.event', id: 'cal-evt-9' },
    });

    const res = await handleReceptionRecordList(env.deps, { kind: 'scheduling_link' }, ADMIN);
    expect(res.records[0]!.resolved).toEqual([{ kind: 'calendar.event', id: 'cal-evt-9' }]);
  });

  it('emits no resolution for a half-written generic pair', async () => {
    insertSubmission(env, { submission_id: 'sub-1' });
    const res = await handleReceptionRecordList(env.deps, { kind: 'intake_form' }, ADMIN);
    // `kind` without `id` is a pointer to nowhere, not a resolution.
    expect(res.records[0]!.resolved).toEqual([]);
  });
});

describe('D-210 step 2a — each kind keeps its OWN outcome vocabulary', () => {
  it('filters a booking by a booking outcome', async () => {
    await insertBooking(env, { request_id: 'req-1' });
    await insertBooking(env, { request_id: 'req-2', outcome: 'rejected' });

    const res = await handleReceptionRecordList(env.deps, {
      kind: 'scheduling_link',
      outcome: 'rejected',
    }, ADMIN);
    expect(res.records.map((r) => r.record_id)).toEqual(['req-2']);
  });

  it('REFUSES a booking asked for an intake-only outcome rather than answering empty', async () => {
    await insertBooking(env, { request_id: 'req-1' });
    // ⛔ The two vocabularies overlap only on pending/processed. Their union as a wire type
    // would let this through and answer `[]` — which reads as "no spam bookings" rather than
    // "bookings cannot be spam". An empty list is the wrong answer to a wrong question.
    await expect(handleReceptionRecordList(env.deps, {
      kind: 'scheduling_link',
      outcome: 'spam',
    }, ADMIN)).rejects.toMatchObject({ code: 'reception_record_invalid', status: 400 });
  });

  it('REFUSES an intake asked for a booking-only outcome', async () => {
    insertSubmission(env, { submission_id: 'sub-1' });
    await expect(handleReceptionRecordList(env.deps, {
      kind: 'intake_form',
      outcome: 'requires_review',
    }, ADMIN)).rejects.toMatchObject({ code: 'reception_record_invalid', status: 400 });
  });

  it('accepts the two outcomes both vocabularies share', async () => {
    await insertBooking(env, { request_id: 'req-1' });
    insertSubmission(env, { submission_id: 'sub-1' });
    const res = await handleReceptionRecordList(env.deps, { outcome: 'pending' }, ADMIN);
    expect(res.records.map((r) => r.record_id).sort()).toEqual(['req-1', 'sub-1']);
  });
});

describe('D-210 step 2a — the list never lies about completeness', () => {
  it('reports truncation rather than silently capping', async () => {
    for (let i = 0; i < 5; i += 1) {
      await insertBooking(env, { request_id: `req-${i}`, received_at: NOW - i });
    }
    const res = await handleReceptionRecordList(env.deps, { kind: 'scheduling_link', limit: 3 }, ADMIN);
    expect(res.records).toHaveLength(3);
    // ⛔ Silent truncation on a reception list reads as "you have received nothing else".
    expect(res.truncated).toBe(true);
  });

  it('does not claim truncation when the answer is complete', async () => {
    await insertBooking(env, { request_id: 'req-1' });
    const res = await handleReceptionRecordList(env.deps, { kind: 'scheduling_link', limit: 3 }, ADMIN);
    expect(res.truncated).toBe(false);
  });

  it('orders newest first across both kinds', async () => {
    await insertBooking(env, { request_id: 'old', received_at: NOW - 9_000 });
    insertSubmission(env, { submission_id: 'newest', submitted_at: NOW - 10 });
    await insertBooking(env, { request_id: 'mid', received_at: NOW - 5_000 });
    const res = await handleReceptionRecordList(env.deps, {}, ADMIN);
    expect(res.records.map((r) => r.record_id)).toEqual(['newest', 'mid', 'old']);
  });

  it('filters by endpoint across kinds', async () => {
    await insertBooking(env, { request_id: 'req-a', endpoint_id: 'ep-1' });
    await insertBooking(env, { request_id: 'req-b', endpoint_id: 'ep-2' });
    const res = await handleReceptionRecordList(env.deps, { endpoint_id: 'ep-1' }, ADMIN);
    expect(res.records.map((r) => r.record_id)).toEqual(['req-a']);
  });
});

describe('D-210 step 2a — the admin gate', () => {
  it('REFUSES an unregistered connection', async () => {
    await insertBooking(env, { request_id: 'req-1' });
    // ⛔ The `reception.` reserved prefix keeps this off MCP, but that is a CHANNEL fence,
    // not an ACTOR one — an unregistered connection on the paired transport is still a
    // caller, and this list is the visitor's data.
    await expect(handleReceptionRecordList(env.deps, {}, undefined))
      .rejects.toMatchObject({ code: 'permission_denied', status: 403 });
    await expect(handleReceptionRecordList(env.deps, {}, { instance_id: null }))
      .rejects.toMatchObject({ code: 'permission_denied', status: 403 });
  });

  it('refuses BEFORE reading a single row', async () => {
    let read = false;
    await expect(handleReceptionRecordList(
      { getBookingStore: () => { read = true; return env.bookings; } },
      {},
      undefined,
    )).rejects.toMatchObject({ status: 403 });
    // The gate is worth nothing if it runs after the query it exists to prevent.
    expect(read).toBe(false);
  });
});

describe('D-210 step 2a — the rpc slice', () => {
  it('is not registered at all when neither store is wired', () => {
    // ⛔ Not "registered and answers []". On this surface an empty list reads as "you have
    // received nothing", which is a lie a db-less boot must not tell.
    expect(makeReceptionRecordHandlers(undefined)).toBeUndefined();
  });

  it('claims exactly its own method and threads the caller through', async () => {
    await insertBooking(env, { request_id: 'req-1' });
    const slice = makeReceptionRecordHandlers<{ instance_id?: string | null }>(env.deps);
    expect(slice?.methods).toEqual(['reception.record.list']);
    const res = await slice!.handlers['reception.record.list']({}, ADMIN);
    expect(res.records.map((r) => r.record_id)).toEqual(['req-1']);
    // The binding must not drop the caller — a slice that passed `undefined` would make the
    // gate above unreachable in production while every direct-call test still passed.
    await expect(slice!.handlers['reception.record.list']({}, undefined))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe('D-210 step 2a — a partial boot', () => {
  it('answers with the kind it has rather than hiding both', async () => {
    insertSubmission(env, { submission_id: 'sub-1' });
    // A missing booking store must not make the submissions invisible too.
    const res = await handleReceptionRecordList(
      { getSubmissionStore: env.deps.getSubmissionStore },
      {},
      ADMIN,
    );
    expect(res.records.map((r) => r.record_id)).toEqual(['sub-1']);
  });

  it('answers empty rather than throwing when neither store is wired', async () => {
    const res = await handleReceptionRecordList({}, {}, ADMIN);
    expect(res).toEqual({ records: [], truncated: false });
  });
});
