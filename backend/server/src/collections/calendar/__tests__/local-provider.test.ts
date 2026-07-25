/** D-173 P4.3 — local calendar adapter unit tests.
 *
 *  The credential-free, warehouse-only calendar: factory shape, the
 *  create-mints-identity contract, and the no-op lifecycle. Boot-level
 *  default-instance wiring is exercised in the wire-calendar-stack suite.
 *
 *  Slice 2 (2026-07-16): `update_event` / `delete_event` moved from `'no'` +
 *  a throwing backstop to real implementations — an append-only calendar could
 *  never move or cancel a booking, and every reception booking lands here.
 *  Merge semantics + identity preservation live in
 *  `__tests__/d-173-p4-local-calendar-mutations.test.ts`; the end-to-end proof
 *  through the real dispatcher gate is in `calendar-dispatcher.test.ts`. */

import { describe, expect, it } from 'vitest';
import {
  createLocalCalendarAdapterFactory,
  createLocalCalendarProvider,
  LOCAL_CALENDAR_CAPS,
} from '../local-provider.js';
import { validateCalendarCaps } from '../caps.js';
import { isCalendarAdapterError } from '../errors.js';
import type { CalendarAdapterContext } from '../adapter-registry.js';
import type { CreateEventInput } from '../provider.js';

const FIXED_NOW = 1_765_000_000_000;

const makeEvent = (over: Partial<CreateEventInput> = {}): CreateEventInput => ({
  calendar_id: 'local',
  summary: 'Intro call with Bob',
  description: 'Booked via the reception scheduling link.',
  start_at: FIXED_NOW + 86_400_000,
  end_at: FIXED_NOW + 86_400_000 + 1_800_000,
  timezone: 'America/New_York',
  is_all_day: false,
  status: 'confirmed',
  ...over,
});

const ctx = (slug: string): CalendarAdapterContext => ({
  slug,
  config: {},
  getAccountValue: async () => null,
});

/** Slice 2 — the factory now needs the `updateEvent` merge-base reader. These
 *  tests never exercise a merge (that is the mutations suite), so an
 *  empty-warehouse reader is the honest stub. */
const factoryOpts = { now: () => FIXED_NOW, readEvent: () => null };

describe('D-173 P4.3 — local calendar adapter', () => {
  describe('factory', () => {
    it('declares kind "local" and probes the static local caps', async () => {
      const factory = createLocalCalendarAdapterFactory(factoryOpts);
      expect(factory.kind).toBe('local');
      await expect(factory.probeCaps(ctx('local'))).resolves.toEqual(
        LOCAL_CALENDAR_CAPS,
      );
    });

    it('creates a provider bound to the context slug', () => {
      const factory = createLocalCalendarAdapterFactory(factoryOpts);
      const provider = factory.create(ctx('my-local'));
      expect(provider.kind).toBe('local');
      expect(provider.slug).toBe('my-local');
    });
  });

  describe('caps', () => {
    it('validate (auth: none) — create + read + edit, no external sync', () => {
      const caps = validateCalendarCaps(LOCAL_CALENDAR_CAPS);
      expect(caps.auth).toBe('none');
      expect(caps.read).toBe('yes');
      expect(caps.create_event).toBe('yes');
      // Slice 2 — these were 'no', which made the calendar every booking lands
      // on append-only. The cap IS the dispatcher's gate.
      expect(caps.update_event).toBe('yes');
      expect(caps.delete_event).toBe('yes');
      // Correct on the merits: a local calendar has no external invitations.
      expect(caps.rsvp).toBe('no');
      expect(caps.watch).toBe('none');
    });
  });

  describe('createEvent', () => {
    it('mints the identity fields and preserves the input + calendar_id', async () => {
      const provider = createLocalCalendarProvider({ slug: 'local', now: () => FIXED_NOW, readEvent: () => null });
      const payload = await provider.createEvent('local', makeEvent());

      expect(payload.event.source_id).toMatch(/[0-9a-f-]{36}/);
      expect(payload.event.ical_uid).toBe(`${payload.event.source_id}@local.recued`);
      expect(payload.event.created_at).toBe(FIXED_NOW);
      expect(payload.event.updated_at).toBe(FIXED_NOW);
      expect(payload.event.calendar_id).toBe('local');
      expect(payload.event.summary).toBe('Intro call with Bob');
      expect(payload.event.start_at).toBe(FIXED_NOW + 86_400_000);
      expect(payload.event.end_at).toBe(FIXED_NOW + 86_400_000 + 1_800_000);
      expect(payload.event.status).toBe('confirmed');
      // description_bytes drives the inline-vs-CAS split downstream.
      expect(payload.description_bytes).toBe(
        Buffer.byteLength(makeEvent().description!, 'utf8'),
      );
    });

    it('is not idempotent — distinct source_ids per call (matches the provider contract)', async () => {
      const provider = createLocalCalendarProvider({ slug: 'local', now: () => FIXED_NOW, readEvent: () => null });
      const a = await provider.createEvent('local', makeEvent());
      const b = await provider.createEvent('local', makeEvent());
      expect(a.event.source_id).not.toBe(b.event.source_id);
    });

    it('zero description_bytes when the event has no description', async () => {
      const provider = createLocalCalendarProvider({ slug: 'local', now: () => FIXED_NOW, readEvent: () => null });
      const payload = await provider.createEvent(
        'local',
        makeEvent({ description: undefined }),
      );
      expect(payload.description_bytes).toBe(0);
    });
  });

  describe('lifecycle no-ops', () => {
    it('connect / initialScan / close resolve without effect; startSync returns a stop fn', async () => {
      const provider = createLocalCalendarProvider({ slug: 'local', now: () => FIXED_NOW, readEvent: () => null });
      await expect(provider.connect()).resolves.toBeUndefined();
      let scanned = 0;
      await provider.initialScan({
        backfill_days: 30,
        expansion_future_days: 90,
        expansion_past_days: 30,
        onEvent: async () => {
          scanned += 1;
          return true;
        },
      });
      expect(scanned).toBe(0); // nothing external to scan
      const stop = await provider.startSync(async () => {});
      expect(typeof stop).toBe('function');
      await expect(stop()).resolves.toBeUndefined();
      await expect(provider.close()).resolves.toBeUndefined();
      expect(provider.health().error_count_24h).toBe(0);
    });
  });

  describe('rsvp — still refused, on the merits', () => {
    it('rsvpEvent throws a typed adapter error (no external invitations to answer)', async () => {
      // Unlike update/delete this is NOT a deferral: there is nothing to RSVP
      // to on a calendar with no external attendees. Slice 2 deliberately left
      // it alone.
      const provider = createLocalCalendarProvider({
        slug: 'local',
        now: () => FIXED_NOW,
        readEvent: () => null,
      });
      const rsvp = await provider
        .rsvpEvent({ calendar_id: 'local', source_id: 'x', response: 'accepted' })
        .catch((e) => e);
      expect(isCalendarAdapterError(rsvp)).toBe(true);
    });
  });
});
