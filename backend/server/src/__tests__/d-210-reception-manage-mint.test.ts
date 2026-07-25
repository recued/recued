/** D-210 Appendix B — `reception.manage.mint`: the owner mints an on-the-go
 *  reschedule link for one booking.
 *
 *  Drives the REAL credential store over an in-memory DB; the link walk + booking
 *  read are the seams. The properties, in the order they matter:
 *    - admin-gated (paired client) like every `reception.*` method,
 *    - only a visitor-originated BOOKING can be minted — a manual booking with
 *      no reception provenance refuses,
 *    - the credential is scoped to the BOOKING (endpoint + record), so the manage
 *      handler targets that booking and a link holder cannot retarget.
 *
 *  Spec: D-210 Appendix B. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  createReceptionManageCredentialStore,
  type ReceptionManageCredentialStore,
} from '../storage/reception-manage-credential-store.js';
// D-210 A.8 slice 4b-ii — the reservation is a `reception_form_submission` row
// with a slot; same id, same lookup, different table.
import type { FormSubmissionSummary } from '../storage/reception-form-store.js';
import type { Booking } from '@recued/contracts';
import {
  handleReceptionManageMint,
  type ReceptionManageMintDeps,
} from '../reception-manage-mint-handler.js';

const NOW = 1_700_000_000_000;
const ADMIN = { instance_id: 'owner-client' };
/** The `reception_form_submission` id (the sealed reservation). */
const BOOKING_ID = 'booking-1';
/** The `data_booking` row the owner is looking at — what the mint now names. */
const MINTED_BOOKING_ID = 'reception_booking-1';
const ENDPOINT_ID = 'ep-1';

const booking = (over: Partial<FormSubmissionSummary> = {}): FormSubmissionSummary => ({
  submission_id: BOOKING_ID,
  endpoint_id: ENDPOINT_ID,
  // D-210 A.8 slice 4b-ii — a booking has no form definition; the `slot` is what
  // tells it apart from an intake, and the sealed visitor fields are one blob.
  form_definition_id: null,
  submitted_at: NOW,
  source_ip_hash: null,
  visitor_email_encrypted: null,
  submission_blob_encrypted: 'AQID',
  schema_version: 1,
  record_kind: 'booking',
  slot: { start_at: NOW, end_at: NOW + 1_800_000, duration_minutes: 30 },
  processing_outcome: 'processed',
  resolved_target_kind: null,
  resolved_target_id: null,
  pair_binding: null,
  metadata: {},
  ...over,
});

/** The `data_booking` row the mint reads. `reception_record_id` present = it
 *  came from a visitor request; absent = the owner entered it by hand and there
 *  is no visitor to hand a manage link to. */
const entity = (over: Partial<Booking> = {}): Booking => ({
  id: MINTED_BOOKING_ID,
  title: 'Booking',
  lifecycle_state: 'confirmed',
  source_id: 'recued.booking',
  reception_record_id: BOOKING_ID,
  ...over,
} as Booking);

const buildDeps = (
  over: {
    bookingEntity?: Booking | null;
    bookingRow?: FormSubmissionSummary | null;
  } = {},
): { deps: ReceptionManageMintDeps; store: ReceptionManageCredentialStore } => {
  const db = new Database(':memory:');
  const store = createReceptionManageCredentialStore(db);
  const bookingEntity = over.bookingEntity === undefined ? entity() : over.bookingEntity;
  const bookingRow = over.bookingRow === undefined ? booking() : over.bookingRow;
  const deps: ReceptionManageMintDeps = {
    getCredentialStore: () => store,
    readBooking: () => bookingEntity,
    getBookingStore: () => ({ findById: () => bookingRow }),
    now: () => NOW,
  };
  return { deps, store };
};

describe('D-210 Appendix B — reception.manage.mint', () => {
  it('requires a paired admin client', async () => {
    const { deps } = buildDeps();
    await expect(
      handleReceptionManageMint(deps, { booking_id: MINTED_BOOKING_ID }, undefined),
    ).rejects.toMatchObject({ code: 'permission_denied', status: 403 });
  });

  it('rejects a missing booking_id', async () => {
    const { deps } = buildDeps();
    await expect(
      handleReceptionManageMint(deps, { booking_id: '' }, ADMIN),
    ).rejects.toMatchObject({ code: 'reception_manage_invalid', status: 400 });
  });

  it('refuses a booking the owner entered by hand (no visitor behind it)', async () => {
    // ⚠ The successor to the two link-walk cases this replaced (`links: []` and
    // a wrong-role edge). Both asked the same question — did this come from a
    // reservation? — of a `scheduled-from` edge that A.2 retired. The booking's
    // own `reception_record_id` answers it now, and a booking without one has
    // no sealed visitor, so a manage link would be a page nobody can use.
    const { deps } = buildDeps({ bookingEntity: entity({ reception_record_id: undefined }) });
    await expect(
      handleReceptionManageMint(deps, { booking_id: MINTED_BOOKING_ID }, ADMIN),
    ).rejects.toMatchObject({ code: 'no_booking', status: 404 });
  });

  it('refuses when the booking itself does not exist', async () => {
    const { deps } = buildDeps({ bookingEntity: null });
    await expect(
      handleReceptionManageMint(deps, { booking_id: MINTED_BOOKING_ID }, ADMIN),
    ).rejects.toMatchObject({ code: 'booking_not_found', status: 404 });
  });

  it('refuses when the reservation behind the booking is gone', async () => {
    const { deps } = buildDeps({ bookingRow: null });
    await expect(
      handleReceptionManageMint(deps, { booking_id: MINTED_BOOKING_ID }, ADMIN),
    ).rejects.toMatchObject({ code: 'booking_not_found', status: 404 });
  });

  it('mints a single-use link whose credential is scoped to the booking', async () => {
    const { deps, store } = buildDeps();
    const res = await handleReceptionManageMint(deps, { booking_id: MINTED_BOOKING_ID }, ADMIN);

    expect(res.manage_path).toMatch(/^\/reception\/manage\/recued_manage_[A-Za-z0-9_-]{43}$/);
    expect(res.expires_at).toBeGreaterThan(NOW);

    // The credential resolves to the BOOKING's scope — that is what makes the
    // manage handler target this booking's event, never a form-supplied one.
    const secret = res.manage_path.slice('/reception/manage/'.length);
    expect(store.peek(secret, NOW)).toMatchObject({
      status: 'ok',
      scope: { kind: 'scheduling_link', endpoint_id: ENDPOINT_ID, record_id: BOOKING_ID },
    });
  });
});
