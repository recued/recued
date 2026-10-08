/** The approval card's rows for a held Recued built-in action.
 *
 *  ⛔ Found on a live drive of the Calendar Invites pack (2026-10-07): a kernel
 *  op is never installed, so D-270's two lookups (`editable_args`, the installed
 *  `request_schema`) both missed and the card scraped its own prose — a booking
 *  asked for approval as `SLOT START AT 1792256400000`, and a commitment's
 *  statement and an event's title were hidden under "The technical bits".
 *
 *  The fixtures are the ARGS THAT DRIVE CARRIED, so these pin the real shapes. */

import { describe, expect, it } from 'vitest';

import { createAskCardDetailResolver } from '../ask-card-held-op-details.js';
import { kernelReviewDetails } from '../ask-card-kernel-details.js';

const START = 1792256400000; // 2026-10-17T17:00:00Z
const END = 1792260000000;

const BOOKING = {
  title: 'Dental check-up — 1 Harbour Rd',
  idempotency_key: 'calendar-invite-booking:6a2e',
  lifecycle_state: 'pending',
  slot_start_at: START,
  slot_end_at: END,
  // NOT a declared booking-create input: a value reaches the card only because
  // the kernel declares it.
  source_extension_blob: { kind: 'calendar_invite', uid: 'appt-1@harbourdental.test' },
};

const COMMITMENT = {
  direction: 'outbound',
  statement: "Answer Harbour Dental's invite: Dental check-up, Sat 17 Oct 2026, 10:00–11:00",
  idempotency_key: 'calendar-invite-answer:6a2e',
  derivation: 'mail_extracted',
  promised_for_at: START,
  expiry_policy: 'strict_expire',
};

const EVENT = {
  slug: 'local',
  calendar_id: 'local',
  event: {
    calendar_id: 'local',
    summary: 'Dental check-up',
    description: "Added by Recued from Harbour Dental's invite.",
    location: '1 Harbour Rd',
    start_at: START,
    end_at: END,
    timezone: 'UTC',
    is_all_day: false,
    status: 'confirmed',
    ical_uid: 'appt-1@harbourdental.test',
  },
};

const labels = (r: ReturnType<typeof kernelReviewDetails>): string[] =>
  (r?.fields ?? []).map((f) => f.label!);

describe('kernelReviewDetails', () => {
  it('a booking: its declared inputs, times typed as times, plumbing and undeclared args left out', () => {
    const r = kernelReviewDetails('booking-create', BOOKING)!;
    expect(labels(r)).toEqual(['title', 'lifecycle_state', 'slot_start', 'slot_end']);
    expect(r.fields.find((f) => f.key === 'slot_start_at')?.type).toBe('datetime');
    expect(r.args.slot_start_at).toBe(START);
    expect(JSON.stringify(r)).not.toContain('idempotency');
    expect(JSON.stringify(r)).not.toContain('calendar_invite');
  });

  it('a commitment reads by its statement first', () => {
    const r = kernelReviewDetails('commitment-create', COMMITMENT)!;
    expect(labels(r)).toEqual(['statement', 'direction', 'derivation', 'promised_for', 'expiry_policy']);
    expect(r.fields.find((f) => f.key === 'promised_for_at')?.type).toBe('datetime');
  });

  it('an event: its own fields as rows, the summary first, the same calendar id once', () => {
    const r = kernelReviewDetails('calendar-create', EVENT)!;
    expect(labels(r)).toEqual([
      'summary', 'calendar', 'calendar_id', 'description', 'location', 'start', 'end',
      'timezone', 'is_all_day', 'status', 'ical_uid',
    ]);
    // Read by key: each row is the expanded leaf.
    expect(r.args['event.summary']).toBe('Dental check-up');
    expect(r.fields.find((f) => f.key === 'event.start_at')?.type).toBe('datetime');
  });

  it("an ALL-DAY event reads as the days it covers, the end as its last day (2026-10-07)", () => {
    // Stored as the UTC midnights of 24 Dec and of the day after 25 Dec. As
    // instants in the owner's zone they read "23 Dec 2026, 16:00 PST".
    const r = kernelReviewDetails('calendar-create', {
      ...EVENT,
      event: { ...EVENT.event, is_all_day: true, start_at: Date.UTC(2026, 11, 24), end_at: Date.UTC(2026, 11, 26) },
    })!;
    expect(r.args['event.start_at']).toBe('Thu 24 Dec 2026 (all day)');
    expect(r.args['event.end_at']).toBe('Fri 25 Dec 2026 (all day)');
    expect(r.fields.find((f) => f.key === 'event.start_at')).toMatchObject({ label: 'start', type: 'string' });
    // A timed event at 00:00 UTC is a time, not a day.
    const timed = kernelReviewDetails('calendar-create', {
      ...EVENT,
      event: { ...EVENT.event, is_all_day: false, start_at: Date.UTC(2026, 11, 24), end_at: Date.UTC(2026, 11, 24, 1) },
    })!;
    expect(timed.fields.find((f) => f.key === 'event.start_at')?.type).toBe('datetime');
  });

  it('an event naming a DIFFERENT calendar id keeps both, told apart', () => {
    const r = kernelReviewDetails('calendar-create', {
      ...EVENT, event: { ...EVENT.event, calendar_id: 'other' },
    })!;
    expect(labels(r)).toContain('calendar_id');
    expect(labels(r)).toContain('event.calendar_id');
  });

  it("an update's patch reads as what it will become", () => {
    const r = kernelReviewDetails('calendar-update', {
      slug: 'local', source_id: 'ev-1', patch: { status: 'cancelled', start_at: START },
    })!;
    expect(labels(r)).toEqual(['calendar', 'source_id', 'new_status', 'new_start']);
  });

  it('resolves the same rows from the op id as from the backing slug', () => {
    expect(kernelReviewDetails('core.work-entity.booking.create', BOOKING))
      .toEqual(kernelReviewDetails('booking-create', BOOKING));
  });

  it('a time in SECONDS stays a number; a millisecond digit string is a time', () => {
    const seconds = kernelReviewDetails('booking-create', { title: 't', slot_start_at: 1792256400 })!;
    expect(seconds.fields.find((f) => f.key === 'slot_start_at')).toMatchObject({
      type: 'number', label: 'slot_start_at',
    });
    const text = kernelReviewDetails('booking-create', { title: 't', slot_start_at: String(START) })!;
    expect(text.fields.find((f) => f.key === 'slot_start_at')?.type).toBe('datetime');
    expect(text.args.slot_start_at).toBe(START);
  });

  it('is not for an installed action, and gives up past a summary-sized set', () => {
    expect(kernelReviewDetails('acme/crm.deals.update', { title: 'x' })).toBeNull();
    expect(kernelReviewDetails('booking-create', { idempotency_key: 'k' })).toBeNull();
    const wide = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, i]));
    expect(kernelReviewDetails('calendar-create', { slug: 'local', event: wide })).toBeNull();
  });
});

describe('the card resolver reaches a held kernel op', () => {
  const PREFLIGHT = 'gateway.preflight';
  const resolver = (timeZone: string | (() => string)) => createAskCardDetailResolver({
    getCheckpoint: async () => ({
      checkpoint_id: 'cp1', run_id: 'run1', gated_step_id: 'created',
      step_state: { created: { input: BOOKING } },
      // A simple-form kernel op-step is held under its backing slug.
      approved_target: { ingredient_slug: 'booking-create' },
    } as never),
    getAnchor: async () => ({ commit_status: 'awaiting_approval', recipe_id: 'track-booking-from-invite' } as never),
    // A kernel op declares no reviewable fields — the case that showed nothing.
    resolveArgEditSchema: () => ({ fields: [] }),
    timeZone,
  });
  const ask = { ask_id: 'a1', handler_kind: PREFLIGHT, handler_payload: { checkpoint_id: 'cp1' } } as never;

  it('renders the slot in a NAMED zone', async () => {
    const rows = await resolver('America/Los_Angeles')(ask);
    expect(rows).toEqual([
      { label: 'title', value: 'Dental check-up — 1 Harbour Rd' },
      { label: 'lifecycle_state', value: 'pending' },
      { label: 'slot_start', value: '17 Oct 2026, 10:00 GMT-7' },
      { label: 'slot_end', value: '17 Oct 2026, 11:00 GMT-7' },
    ]);
  });

  it("reads the owner's zone per ask, so a changed setting applies without a restart", async () => {
    let zone = 'America/Los_Angeles';
    const resolve = resolver(() => zone);
    expect((await resolve(ask))?.[2]?.value).toBe('17 Oct 2026, 10:00 GMT-7');
    zone = 'Europe/London';
    expect((await resolve(ask))?.[2]?.value).toBe('17 Oct 2026, 18:00 BST');
  });
});
