/** `calendar-list` with no calendar named reads every calendar (2026-10-05).
 *
 *  The rows of all calendars in start order, each naming its calendar
 *  (`collection_slug`), cut to the limit one calendar's read is; the source
 *  verdict is the least current calendar's. A named calendar reads as before. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarCollectionCaps, CalendarRecordHotFields, CollectionHealth } from '@recued/contracts';

import { createInstanceStore } from '../../instance-store.js';
import { handleCalendarList, type CalendarDispatcherDeps } from '../calendar-dispatcher.js';
import type { CalendarCollection } from '../calendar-collection.js';
import type { CalendarListQuery } from '../calendar-table.js';

const NOW = 1_800_000_000_000;
const CAPS = { read: 'yes', search: 'local' } as CalendarCollectionCaps;

const row = (summary: string, start_at: number): CalendarRecordHotFields => ({
  calendar_id: 'primary', summary, start_at, end_at: start_at + 1_800_000, status: 'confirmed',
  ical_uid: `${summary}@x`, is_all_day: false, is_recurring: false,
});

const health = (over: Partial<CollectionHealth>): CollectionHealth => ({
  platform: 'calendar', slug: 'x', last_indexed_at: NOW - 60_000, pending_queue_size: 0, error_count_24h: 0,
  state: 'idle', auth_state: 'healthy', ...over,
});

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

/** Calendars named in `calendars`; one not running when its value is null. */
const deps = (calendars: Record<string, { rows: CalendarRecordHotFields[]; health: CollectionHealth } | null>) => {
  const db = new Database(':memory:');
  dbs.push(db);
  const instances = createInstanceStore({ db });
  const queries: Array<{ slug: string; query: CalendarListQuery }> = [];
  for (const slug of Object.keys(calendars)) {
    instances.upsert({ platform: 'calendar', slug, adapter_type: 'local', config: {}, caps: CAPS, auth_state: 'healthy', last_synced_at: null });
  }
  const d: CalendarDispatcherDeps = {
    instances,
    now: () => NOW,
    getCollection: (slug) => {
      const calendar = calendars[slug];
      if (!calendar) return undefined;
      return {
        table: {
          // The filters a windowed read varies: timed and all-day are asked
          // for apart (`listOnOwnerClock`).
          list: (query: CalendarListQuery) => {
            queries.push({ slug, query });
            return calendar.rows
              .filter((r) => query.is_all_day === undefined || r.is_all_day === query.is_all_day)
              .filter((r) => query.start_since === undefined || r.start_at >= query.start_since)
              .slice(0, query.limit ?? 100);
          },
        },
        health: () => calendar.health,
      } as unknown as CalendarCollection;
    },
  };
  return { d, queries };
};

describe('calendar-list naming no calendar', () => {
  it('reads every calendar, in start order, each row naming its calendar', async () => {
    const { d, queries } = deps({
      work: { rows: [row('Standup', NOW + 1000), row('Review', NOW + 3000)], health: health({}) },
      local: { rows: [row('Dentist', NOW + 2000)], health: health({}) },
    });
    for (const slug of ['', undefined]) {
      const out = await handleCalendarList(d, { slug, since: NOW, status: 'confirmed' });
      expect(out.records.map((r) => [r.summary, r.collection_slug])).toEqual([
        ['Standup', 'work'], ['Dentist', 'local'], ['Review', 'work'],
      ]);
    }
    // Each calendar is asked with the same filters: its timed events from
    // `since`, its all-day events from the first day that begins after it.
    expect(queries[0]!.query).toEqual({ start_since: NOW, status: 'confirmed', is_all_day: false });
    expect(queries[1]!.query).toEqual({ start_since: Math.ceil(NOW / 86_400_000) * 86_400_000, status: 'confirmed', is_all_day: true });
  });

  it('cuts the merged rows to the limit, after ordering them', async () => {
    const { d } = deps({
      work: { rows: [row('Standup', NOW + 1000), row('Review', NOW + 3000)], health: health({}) },
      local: { rows: [row('Dentist', NOW + 2000), row('Gym', NOW + 4000)], health: health({}) },
    });
    const out = await handleCalendarList(d, { slug: '', limit: 2 });
    expect(out.records.map((r) => r.summary)).toEqual(['Standup', 'Dentist']);
  });

  it('is as current as the least current calendar', async () => {
    const { d } = deps({
      work: { rows: [], health: health({ last_indexed_at: NOW - 60_000 }) },
      local: { rows: [], health: health({ last_indexed_at: NOW - 600_000, pending_queue_size: 3 }) },
    });
    expect((await handleCalendarList(d, { slug: '' })).source_freshness).toEqual({
      last_success_at: NOW - 600_000, age_ms: 600_000, degraded: false, pending: 3, stale: true,
    });
  });

  it('a calendar that is not running reads as never synced, and the others still read', async () => {
    const { d } = deps({ work: { rows: [row('Standup', NOW)], health: health({}) }, local: null });
    const out = await handleCalendarList(d, { slug: '' });
    expect(out.records.map((r) => r.summary)).toEqual(['Standup']);
    expect(out.source_freshness).toMatchObject({ last_success_at: null, age_ms: null, stale: true });
  });

  it('a named calendar reads as before: its rows only, unmarked', async () => {
    const { d } = deps({
      work: { rows: [row('Standup', NOW)], health: health({}) },
      local: { rows: [row('Dentist', NOW)], health: health({}) },
    });
    const out = await handleCalendarList(d, { slug: 'local' });
    expect(out.records).toEqual([row('Dentist', NOW)]);
    await expect(handleCalendarList(d, { slug: 'primary' })).rejects.toThrow(/CALENDAR_INSTANCE_NOT_FOUND/);
  });
});
