/** A real calendar stack for tests: the table, collection, registry and kernel
 *  dispatchers the server composes, over named calendars, with a provider that
 *  never syncs. Events are seeded straight into each calendar's table.
 *
 *  ⚠ Prefer this to a fake registry whose `list()` ignores the query: a
 *  window, a page or a calendar name cannot be tested through one. */

import Database from 'better-sqlite3';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { CalendarCollectionCaps, CanonicalEvent } from '@recued/contracts';

import { composeCalendarStack, registerCalendarCollections } from '../../collections/calendar/compose.js';
import { createInstanceStore } from '../../collections/instance-store.js';
import { createCollectionRegistry } from '../../collections/registry.js';

const CAPS = {
  read: 'yes', list_calendars: 'yes', create_event: 'yes', update_event: 'yes', delete_event: 'yes',
  rsvp: 'yes', search: 'remote', watch: 'poll', auth: 'oauth', recurrence: 'server',
} as CalendarCollectionCaps;

export interface SeedEvent {
  source_id: string;
  start_at: number;
  /** Defaults to the source id. */
  summary?: string;
  minutes?: number;
  /** Defaults to the first calendar. */
  calendar?: string;
  attendees?: CanonicalEvent['attendees'];
  location?: string;
  /** Stored as days: `start_at` a UTC midnight, `minutes` whole days. */
  is_all_day?: boolean;
}

export const createTestCalendarStack = async (opts: {
  now: () => number;
  calendars?: readonly string[];
  /** The owner's zone, as the server reads it: `calendar-list` windows meet
   *  an all-day event at its local midnight there. */
  timeZone?: string;
}) => {
  const calendars = opts.calendars ?? ['work'];
  const db = new Database(':memory:');
  const bus = createWarehouseEventBus();
  const stack = composeCalendarStack(db, {
    blobs: { async put() { return 'blob'; }, async get() { return null; }, async delete() {} } as never,
    bus,
    getGate: () => ({
      addUsed() {}, setUsed() {},
      info: () => ({ surface: 'test', used: 0, quota: 1e12, reservePct: 0, state: 'healthy' }),
    }) as never,
  }, {
    factories: [{
      kind: 'gcal',
      async probeCaps() { return CAPS; },
      create: (ctx: { slug: string }) => ({
        kind: 'gcal', slug: ctx.slug,
        async connect() {}, async initialScan() {}, async startSync() { return async () => {}; }, async close() {},
        health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0, pending_series_expansions: 0 }),
        async createEvent() { throw new Error('unused'); }, async updateEvent() { throw new Error('unused'); },
        async deleteEvent() {}, async rsvpEvent() { throw new Error('unused'); },
      }),
    }] as never,
    now: opts.now,
    ...(opts.timeZone === undefined ? {} : { ownerTimeZone: () => opts.timeZone! }),
  });
  for (const slug of calendars) {
    createInstanceStore({ db }).upsert({
      platform: 'calendar', slug, adapter_type: 'gcal', config: {}, caps: CAPS, auth_state: 'healthy', last_synced_at: null,
    });
  }
  await stack.startAll();
  const registry = createCollectionRegistry();
  registerCalendarCollections(stack, registry);
  const seed = (event: SeedEvent): void => {
    const calendar = stack.listLive().find((collection) => collection.slug === (event.calendar ?? calendars[0]))!;
    calendar.table.upsert({
      event: {
        source_id: event.source_id, ical_uid: `${event.source_id}@x`, calendar_id: 'primary',
        summary: event.summary ?? event.source_id, start_at: event.start_at,
        end_at: event.start_at + (event.minutes ?? 30) * 60_000, timezone: 'UTC', is_all_day: event.is_all_day === true,
        status: 'confirmed', created_at: 1, updated_at: 1,
        ...(event.attendees ? { attendees: event.attendees } : {}),
        ...(event.location ? { location: event.location } : {}),
      } as CanonicalEvent,
      size_bytes: 0,
    });
  };
  return { db, stack, registry, seed, close: () => { bus.dispose(); db.close(); } };
};
