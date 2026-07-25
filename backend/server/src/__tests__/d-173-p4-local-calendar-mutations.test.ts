/** D-173 P4.3 slice 2 — the local calendar can be edited and cancelled.
 *
 *  Slice 1 shipped create + read and declared `update_event` / `delete_event`
 *  `'no'`, so the dispatcher 403'd them. That left the calendar EVERY reception
 *  booking lands on append-only — a booking could never be moved or cancelled,
 *  which is most of running a day (BLOCKER-1 in
 *  `handovers/calendar-reservation-landing-zone-audit.md` § 3a).
 *
 *  ## Scope of this file — read this before trusting it
 *
 *  These exercise the PROVIDER (merge semantics, identity preservation, scope
 *  refusal) against a real SQLite warehouse table. They do **not** drive the
 *  dispatcher, and therefore **do not by themselves prove the 403 is gone** —
 *  the gate reads caps from the persisted `collection_instances` row, not from
 *  `LOCAL_CALENDAR_CAPS`. An earlier draft of this header claimed they drove the
 *  real gate; they never did, and the claim is the very failure this arc keeps
 *  finding ([[declared_is_not_backed]]). The gate half is pinned by
 *  `d-173-p4-local-calendar-caps-refresh.test.ts`, which drives the boot wiring
 *  that writes those caps. Both halves are needed; neither is sufficient. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CalendarAdapterError, type CanonicalEvent } from '@recued/contracts';
import {
  createCalendarTable,
  type CalendarCollectionTable,
} from '../collections/calendar/calendar-table.js';
import {
  createLocalCalendarProvider,
  LOCAL_CALENDAR_CAPS,
} from '../collections/calendar/local-provider.js';

const NOW = 1_700_000_000_000;
const LATER = NOW + 5_000;
const HOUR = 60 * 60 * 1000;
const SLUG = 'local';

let db: Database.Database;
let table: CalendarCollectionTable;

/** The provider, wired the way the composition root wires it: a narrow read
 *  seam over the same warehouse table. */
const provider = (nowFn: () => number = () => LATER) =>
  createLocalCalendarProvider({
    slug: SLUG,
    now: nowFn,
    readEvent: (source_id) => table.get(source_id)?.event ?? null,
  });

const seed = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => {
  const event: CanonicalEvent = {
    source_id: 'evt-1',
    ical_uid: 'evt-1@local.recued',
    calendar_id: 'local',
    summary: 'Ana — consultation',
    description: 'Original notes',
    start_at: NOW + 12 * HOUR,
    end_at: NOW + 13 * HOUR,
    timezone: 'America/New_York',
    is_all_day: false,
    status: 'confirmed',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
  table.upsert({ event, size_bytes: 0, now: NOW });
  return event;
};

beforeEach(() => {
  db = new Database(':memory:');
  table = createCalendarTable({ db, slug: SLUG });
});
afterEach(() => {
  db.close();
});

describe('D-173 P4.3 slice 2 — caps', () => {
  it('declares update + delete', () => {
    // ⚠ This asserts the CONSTANT only. The dispatcher gates on the persisted
    // instance row, so this passing does NOT mean a move is admitted — see the
    // caps-refresh suite. Kept because the constant is the source the boot
    // wiring copies from.
    expect(LOCAL_CALENDAR_CAPS.update_event).toBe('yes');
    expect(LOCAL_CALENDAR_CAPS.delete_event).toBe('yes');
    expect(LOCAL_CALENDAR_CAPS.create_event).toBe('yes');
  });

  it('still declares rsvp NO — on the merits, not as a deferral', () => {
    // A local calendar has no external invitations to respond to. This one is
    // correct, and should stay 'no' when someone later sweeps for leftovers.
    expect(LOCAL_CALENDAR_CAPS.rsvp).toBe('no');
  });
});

describe('D-173 P4.3 slice 2 — updateEvent merges against the warehouse', () => {
  it('moves an event: the patch wins, everything unpatched survives', () => {
    seed();
    const moved = NOW + 16 * HOUR;
    return provider()
      .updateEvent({
        calendar_id: 'local',
        source_id: 'evt-1',
        patch: { start_at: moved, end_at: moved + HOUR },
      })
      .then((payload) => {
        expect(payload.event.start_at).toBe(moved);
        expect(payload.event.end_at).toBe(moved + HOUR);
        // The merge base did its job — these were never in the patch.
        expect(payload.event.summary).toBe('Ana — consultation');
        expect(payload.event.description).toBe('Original notes');
        expect(payload.event.timezone).toBe('America/New_York');
      });
  });

  it('cancels by patching status — no row is dropped', async () => {
    seed();
    const payload = await provider().updateEvent({
      calendar_id: 'local',
      source_id: 'evt-1',
      patch: { status: 'cancelled' },
    });
    expect(payload.event.status).toBe('cancelled');
    // Matters downstream: the D7 overlap count excludes `cancelled`, so a
    // cancelled booking must stop occupying its slot in the count.
    expect(payload.event.start_at).toBe(NOW + 12 * HOUR);
  });

  it('🔑 NEVER lets a patch re-key identity — the booking anchor depends on it', async () => {
    // `reception_booking_request.resolved_calendar_event_id` points at
    // `source_id` and is the I-4 idempotency anchor. If an edit could move the
    // id, that pointer would dangle and a re-release would mint a DUPLICATE
    // booking. `ical_uid` is cross-provider identity; `created_at` is history.
    // A caller cannot patch any of them, whatever they send.
    seed();
    const payload = await provider().updateEvent({
      calendar_id: 'local',
      source_id: 'evt-1',
      patch: {
        source_id: 'evt-HIJACKED',
        ical_uid: 'hijacked@example.com',
        calendar_id: 'someone-elses-calendar',
        created_at: 1,
        summary: 'legitimate edit',
      } as Partial<CanonicalEvent>,
    });
    expect(payload.event.source_id).toBe('evt-1');
    expect(payload.event.ical_uid).toBe('evt-1@local.recued');
    expect(payload.event.calendar_id).toBe('local');
    expect(payload.event.created_at).toBe(NOW);
    // …while the legitimate part of the same patch still lands.
    expect(payload.event.summary).toBe('legitimate edit');
  });

  it('stamps updated_at — this adapter IS the provider deciding the write happened', async () => {
    seed();
    const payload = await provider(() => LATER).updateEvent({
      calendar_id: 'local',
      source_id: 'evt-1',
      patch: { summary: 'moved' },
    });
    expect(payload.event.updated_at).toBe(LATER);
  });

  it('refuses to invent a row when there is nothing to merge into', async () => {
    // An update that silently creates is worse than one that fails: the caller
    // asked to change a thing that does not exist.
    await expect(
      provider().updateEvent({
        calendar_id: 'local',
        source_id: 'ghost',
        patch: { summary: 'x' },
      }),
    ).rejects.toBeInstanceOf(CalendarAdapterError);
  });

  it('refuses series scopes rather than quietly doing less than asked', async () => {
    seed();
    for (const scope of ['this_and_future', 'series'] as const) {
      await expect(
        provider().updateEvent({
          calendar_id: 'local',
          source_id: 'evt-1',
          patch: { summary: 'x' },
          scope,
        }),
      ).rejects.toMatchObject({ code: 'rrule_unsupported' });
    }
  });

  it('accepts an explicit this_instance scope', async () => {
    seed();
    const payload = await provider().updateEvent({
      calendar_id: 'local',
      source_id: 'evt-1',
      patch: { summary: 'x' },
      scope: 'this_instance',
    });
    expect(payload.event.summary).toBe('x');
  });
});

describe('D-173 P4.3 slice 2 — deleteEvent verifies, the dispatcher drops', () => {
  it('resolves for an existing event, and writes nothing itself', async () => {
    seed();
    await expect(
      provider().deleteEvent({ calendar_id: 'local', source_id: 'evt-1' }),
    ).resolves.toBeUndefined();
    // The adapter is not the writer — `applyVerifiedDelete` is. The row is
    // still here because only the dispatcher removes it.
    expect(table.get('evt-1')).not.toBeNull();
  });

  it('refuses an unknown event', async () => {
    await expect(
      provider().deleteEvent({ calendar_id: 'local', source_id: 'ghost' }),
    ).rejects.toMatchObject({ code: 'event_not_found' });
  });

  it('refuses series scopes', async () => {
    seed();
    await expect(
      provider().deleteEvent({
        calendar_id: 'local',
        source_id: 'evt-1',
        scope: 'series',
      }),
    ).rejects.toMatchObject({ code: 'rrule_unsupported' });
  });
});
