/** D-173 P4 § D7 / N.3 / I-1 / I-7 — scheduling_link booking drain.
 *
 *  The booking front-door's review-then-approve dispatch step: a pending
 *  `reception_booking_request` → a HELD review op (never an ambient
 *  materialize — I-1; scheduling never auto-books — I-7). Asserts:
 *    - a future booking dispatches the compiled review workflow with the
 *      projection-shaped CALENDAR-EVENT payload (slot → start_at + duration +
 *      tz, D7 amended),
 *    - a PAST-slot booking is rejected + NEVER dispatched (I-7),
 *    - the visitor EMAIL never enters the dispatched payload (sealed, D-138),
 *    - the seam-absent / dispatched:false paths leave the row pending (no
 *      fallback materialize — I-1 / I-7),
 *    - a locked vault leaves rows pending; a decrypt failure rejects the row,
 *    - the booking_request_id rides the payload (the calendar idempotency
 *      anchor — I-4). */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchedulingLinkConfig } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
// D-210 A.8 slice 4b-ii — a booking is a `reception_form_submission` row with a
// slot; `reception_booking_request` has no writer any more.
import {
  createReceptionFormSubmissionStore,
  type FormSubmissionStore,
} from '../storage/reception-form-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
// ⚠ The FORM key, not the booking one, and ONE blob instead of four columns —
// the row's readers open with `openFormSubmissionField` (`booking-blob.ts`).
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  sealFormSubmissionField,
} from '../ports/reception/form-pii.js';
import { sealBookingSubmissionBlob } from '../ports/reception/booking-blob.js';
import { computeBearerHmac, deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import { createSchedulingLinkSubmissionProcessor } from '../ports/reception/processors/scheduling-link-processor.js';
import type {
  FireReceptionWorkflow,
  ReceptionWorkflowDispatch,
} from '../ports/reception/reception-drain.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xc4));
const BOOKING_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x5a));
const WRONG_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x77));

interface Env {
  registry: PublicEndpointRegistryStore;
  booking: FormSubmissionStore;
}

const buildEnv = (): Env => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  return {
    registry: createPublicEndpointRegistryStore(db),
    booking: createReceptionFormSubmissionStore(db),
  };
};

const minimalConfig = (over: Partial<SchedulingLinkConfig> = {}): SchedulingLinkConfig => ({
  display_name: 'Mary Smith',
  duration_options_minutes: [30],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [{ day_of_week: 1, start_minute: 0, end_minute: 1440 }],
  },
  required_visitor_fields: {
    name: 'required',
    email: 'required',
    topic: 'optional',
    phone: 'omit',
    notes: 'omit',
  },
  min_advance_notice_hours: 1,
  max_lead_time_days: 30,
  max_bookings_per_day: 0,
  on_booking: {
    create_calendar_event: true,
    create_commitment_entity: true,
  },
  ...over,
});

const seedEndpoint = (
  env: Env,
  endpoint_id: string,
  metadata: SchedulingLinkConfig | Readonly<Record<string, unknown>> = minimalConfig(),
  opts: { enabled?: boolean } = {},
): void => {
  env.registry.create({
    endpoint_id,
    kind: 'scheduling_link',
    packet_declaration: {
      packet_kind: 'scheduling_link_packet',
      source_query_ref: { kind: 'data.calendar.combined' },
    },
    bearer_secret_hmac: computeBearerHmac('tok', PEPPER),
    created_at: NOW - 1000,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: NOW - 1000,
    metadata: metadata as Readonly<Record<string, unknown>>,
  });
  if (opts.enabled ?? true) env.registry.enable(endpoint_id, NOW);
};

const insertBooking = async (
  env: Env,
  input: {
    request_id: string;
    endpoint_id: string;
    slot_start_at: number;
    visitor_name?: string | null;
    visitor_email?: string | null;
    visitor_topic?: string | null;
    duration_minutes?: number;
    key?: Uint8Array;
  },
): Promise<void> => {
  const key = input.key ?? BOOKING_KEY;
  const duration = input.duration_minutes ?? 30;
  // D-210 A.8 slice 4b-ii — the four sealed columns became ONE
  // `submission_blob_encrypted` carrying every declared visitor field, plus the
  // email KEPT in its own column so the notify path can read an address without
  // unsealing the whole submission.
  const submission_blob_encrypted = await sealBookingSubmissionBlob({
    key,
    endpoint_id: input.endpoint_id,
    submission_id: input.request_id,
    fields: {
      name: input.visitor_name,
      email: input.visitor_email,
      phone: null,
      topic: input.visitor_topic,
      notes: null,
    },
  });
  env.booking.insert({
    submission_id: input.request_id,
    endpoint_id: input.endpoint_id,
    form_definition_id: null,
    submitted_at: NOW - 500,
    source_ip_hash: 'ip-hash',
    visitor_email_encrypted: await sealFormSubmissionField({
      key,
      endpoint_id: input.endpoint_id,
      submission_id: input.request_id,
      field: 'visitor_email',
      plaintext: input.visitor_email ?? null,
    }),
    submission_blob_encrypted,
    schema_version: 1,
    processing_outcome: 'pending',
    // `slot` present is what MAKES the row a booking — the store derives the
    // kind from it, and with it the outcome vocabulary the row may carry.
    slot: {
      start_at: input.slot_start_at,
      end_at: input.slot_start_at + duration * 60_000,
      duration_minutes: duration,
    },
  });
};

interface FakeFire {
  fn: FireReceptionWorkflow;
  calls: ReceptionWorkflowDispatch[];
}

const fakeFire = (result: { dispatched: boolean } = { dispatched: true }): FakeFire => {
  const calls: ReceptionWorkflowDispatch[] = [];
  return {
    calls,
    fn: async (dispatch) => {
      calls.push(dispatch);
      return result;
    },
  };
};

const processorFor = (
  env: Env,
  extra: Partial<Parameters<typeof createSchedulingLinkSubmissionProcessor>[0]> = {},
) =>
  createSchedulingLinkSubmissionProcessor({
    registryStore: env.registry,
    bookingStore: env.booking,
    getFormSubmissionPiiKey: () => BOOKING_KEY,
    now: () => NOW,
    ...extra,
  });

let env: Env;
beforeEach(() => {
  env = buildEnv();
});

describe('D-173 P4 — scheduling drain: review dispatch (D7 / N.4)', () => {
  it('dispatches a future booking to the review workflow with the BOOKING payload', async () => {
    seedEndpoint(env, 'ep-1');
    const slot = NOW + DAY;
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: slot,
      visitor_name: 'Alex',
      visitor_email: 'alex@visitor.test',
      visitor_topic: 'Design review',
    });
    const fire = fakeFire();
    const res = await processorFor(env, { fireReceptionWorkflow: fire.fn }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 1, failed: 0 });
    expect(fire.calls).toHaveLength(1);
    const call = fire.calls[0]!;
    expect(call.kind).toBe('scheduling_link');
    expect(call.source_ref).toBe('req-1');
    expect(call.endpoint_id).toBe('ep-1');
    expect(call.payload).toMatchObject({
      // D-210 A.2 — a reservation materializes a data_booking row, NOT a
      // calendar event. Through 3a this was 'calendar.event' and the booking
      // was minted beside the event it created.
      top_tier_kind: 'booking',
      // ⚠ Since A.2 this is the I-4 ANCHOR, not just audit attribution: the
      // seam pre-reads exactly this id to decide whether an approve already
      // materialized. A changed derivation mints a SECOND booking per slot.
      id: 'reception_req-1',
      // These three still ride — the INBOX renders them so the owner sees the
      // time they are approving. The booking's own slot is read from the sealed
      // reservation row by the seam, not from here.
      start_at: slot,
      duration_minutes: 30,
      timezone: 'America/New_York', // from the endpoint's availability window
      booking_request_id: 'req-1', // the reservation the anchor pairs with
      reject_if_slot_past: true, // re-guards I-7 at approve-resume
      title: 'Booking with Alex — Design review',
    });
    // The summary is the title; the payload carries no `body` (Details is
    // left for the user to add at review — no description-duplication).
    expect(call.payload.body).toBeUndefined();
    // Handed off → booking marked processed (held op + inbox own it now).
    expect(env.booking.findById('req-1')!.processing_outcome).toBe('processed');
    // ⚠ D-210 A.8 slice 4b-ii — a `resolved_calendar_event_id` null-check stood
    // here. Its COLUMN is gone (dead since A.2, dropped by 4b-ii), so the old
    // spelling went with it — but the CLAIM it was making survives and is worth
    // more than the column was: dispatch hands the booking to review and
    // materializes NOTHING, so the row must still point at nothing. That is now
    // one assertion over the generic pair instead of one frozen column, and it
    // is the assertion that would fail if the drain ever started materializing.
    const dispatched = env.booking.findById('req-1')!;
    expect(dispatched.resolved_target_kind).toBeNull();
    expect(dispatched.resolved_target_id).toBeNull();
  });

  it('the dispatched payload never carries the visitor email (sealed, I-3)', async () => {
    seedEndpoint(env, 'ep-1');
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_name: 'Alex',
      visitor_email: 'secret-leak@visitor.test',
      visitor_topic: 'Quarterly sync',
    });
    const fire = fakeFire();
    await processorFor(env, { fireReceptionWorkflow: fire.fn }).drainOnce({ now: NOW, limit: 50 });
    const json = JSON.stringify(fire.calls[0]!.payload);
    expect(json).not.toContain('secret-leak@visitor.test');
  });

  it('builds a sensible statement when the visitor omitted name + topic', async () => {
    seedEndpoint(env, 'ep-1');
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_name: null,
      visitor_email: 'anon@visitor.test',
      visitor_topic: null,
    });
    const fire = fakeFire();
    await processorFor(env, { fireReceptionWorkflow: fire.fn }).drainOnce({ now: NOW, limit: 50 });
    expect(fire.calls[0]!.payload).toMatchObject({ title: 'Booking request' });
  });
});

describe('D-173 P4 — scheduling drain: past-slot guard (I-7)', () => {
  it('rejects a past-slot booking and never dispatches it', async () => {
    seedEndpoint(env, 'ep-1');
    await insertBooking(env, {
      request_id: 'req-past',
      endpoint_id: 'ep-1',
      slot_start_at: NOW - 1, // already in the past at drain time
      visitor_name: 'Alex',
      visitor_topic: 'Too late',
    });
    const fire = fakeFire();
    const res = await processorFor(env, { fireReceptionWorkflow: fire.fn }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 1, failed: 0 });
    expect(fire.calls).toHaveLength(0); // never dispatched (I-7)
    expect(env.booking.findById('req-past')!.processing_outcome).toBe('rejected');
  });

  it('treats a slot exactly at now as past (<= guard)', async () => {
    seedEndpoint(env, 'ep-1');
    await insertBooking(env, {
      request_id: 'req-now',
      endpoint_id: 'ep-1',
      slot_start_at: NOW,
      visitor_topic: 'Right now',
    });
    const fire = fakeFire();
    await processorFor(env, { fireReceptionWorkflow: fire.fn }).drainOnce({ now: NOW, limit: 50 });
    expect(fire.calls).toHaveLength(0);
    expect(env.booking.findById('req-now')!.processing_outcome).toBe('rejected');
  });
});

describe('D-173 P4 — scheduling drain: never auto-books (I-1 / I-7)', () => {
  it('leaves a booking pending when no dispatch seam is wired (boot phase)', async () => {
    seedEndpoint(env, 'ep-1');
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_topic: 'Hi',
    });
    // No fireReceptionWorkflow seam.
    const res = await processorFor(env).drainOnce({ now: NOW, limit: 50 });
    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(env.booking.findById('req-1')!.processing_outcome).toBe('pending');
  });

  it('leaves a booking pending when the seam reports dispatched:false', async () => {
    seedEndpoint(env, 'ep-1');
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_topic: 'Hi',
    });
    const fire = fakeFire({ dispatched: false });
    const res = await processorFor(env, { fireReceptionWorkflow: fire.fn }).drainOnce({ now: NOW, limit: 50 });
    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(fire.calls).toHaveLength(1);
    expect(env.booking.findById('req-1')!.processing_outcome).toBe('pending');
  });
});

describe('D-173 P4 — scheduling drain: vault + crypto failure modes', () => {
  it('leaves bookings pending when the PII key is unavailable (vault locked)', async () => {
    seedEndpoint(env, 'ep-1');
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_topic: 'Hi',
    });
    const fire = fakeFire();
    const res = await processorFor(env, {
      fireReceptionWorkflow: fire.fn,
      getFormSubmissionPiiKey: () => {
        throw new Error('vault locked');
      },
    }).drainOnce({ now: NOW, limit: 50 });
    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(fire.calls).toHaveLength(0);
    expect(env.booking.findById('req-1')!.processing_outcome).toBe('pending');
  });

  it('rejects a booking whose PII will not decrypt (tampered / wrong key)', async () => {
    seedEndpoint(env, 'ep-1');
    // Seal under WRONG_KEY so the processor's BOOKING_KEY can't decrypt.
    await insertBooking(env, {
      request_id: 'req-bad',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_topic: 'Sealed under the wrong key',
      key: WRONG_KEY,
    });
    const fire = fakeFire();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await processorFor(env, { fireReceptionWorkflow: fire.fn }).drainOnce({ now: NOW, limit: 50 });
    warn.mockRestore();
    expect(res).toEqual({ processed: 0, failed: 1 });
    expect(fire.calls).toHaveLength(0);
    expect(env.booking.findById('req-bad')!.processing_outcome).toBe('rejected');
  });
});

describe('D-173 P4 — scheduling drain: idempotent re-drain', () => {
  it('does not re-dispatch a booking already handed off (only pending rows listed)', async () => {
    seedEndpoint(env, 'ep-1');
    await insertBooking(env, {
      request_id: 'req-1',
      endpoint_id: 'ep-1',
      slot_start_at: NOW + DAY,
      visitor_topic: 'Hi',
    });
    const fire = fakeFire();
    const proc = processorFor(env, { fireReceptionWorkflow: fire.fn });
    await proc.drainOnce({ now: NOW, limit: 50 });
    await proc.drainOnce({ now: NOW, limit: 50 });
    expect(fire.calls).toHaveLength(1); // second pass finds no pending row
  });
});
