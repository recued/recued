import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DAY_MS, type CanonicalEvent, type CalendarOverlapRequest } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createBlobStore } from '../../../storage/blob-store.js';
import { createInstanceStore } from '../../instance-store.js';
import { createCalendarCollection, type CalendarCollection } from '../calendar-collection.js';
import { createLocalCalendarProvider, LOCAL_CALENDAR_CAPS } from '../local-provider.js';
import { readCalendarOverlaps } from '../event-overlaps.js';

const NOW = Date.parse('2026-11-01T09:00:00Z');
const input: CalendarOverlapRequest = { start_at: NOW, end_at: NOW + 3_600_000, timezone: 'America/Los_Angeles', is_all_day: false };
let db: Database.Database, dir: string;
let instances: ReturnType<typeof createInstanceStore>;
let collections: Map<string, CalendarCollection>;
const deps = () => ({ instances, getCollection: (slug: string) => collections.get(slug), now: () => NOW });
const add = (slug: string, remote = false, backfill = true) => {
  instances.upsert({ platform: 'calendar', slug, adapter_type: remote ? 'gcal' : 'local', config: {},
    caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: remote ? NOW : null });
  if (backfill) instances.markBackfillComplete('calendar', slug);
  const provider = createLocalCalendarProvider({ slug, now: () => NOW,
    readEvent: id => collections.get(slug)?.table.get(id)?.event ?? null });
  const collection = createCalendarCollection({ db, slug, provider, bus: createWarehouseEventBus(),
    blobs: createBlobStore(join(dir, slug)), gate: createStorageGate({ quota: 8_000_000, reservePct: 10, surface: `collection:calendar:${slug}` }),
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 8_000_000, expansion_past_days: 30, expansion_future_days: 90 }) });
  collections.set(slug, collection);
  const health = collection.health();
  vi.spyOn(collection, 'health').mockReturnValue({ ...health, last_indexed_at: NOW, state: 'idle' });
  return collection;
};
const seed = (slug: string, id: string, patch: Partial<CanonicalEvent> = {}) => collections.get(slug)!.applyVerifiedUpsert({
  event: { source_id: id, ical_uid: id, calendar_id: slug, summary: id, start_at: NOW, end_at: NOW + 3_600_000,
    timezone: input.timezone, is_all_day: false, status: 'confirmed', created_at: NOW, updated_at: NOW, ...patch }, description_bytes: 0,
});
beforeEach(() => { db = new Database(':memory:'); dir = mkdtempSync(join(tmpdir(), 'overlaps-')); instances = createInstanceStore({ db }); collections = new Map(); add('local'); });
afterEach(async () => { for (const collection of collections.values()) await collection.close(); vi.restoreAllMocks(); db.close(); rmSync(dir, { recursive: true, force: true }); });

it('reads projected overlaps with exclusive boundaries, including events spanning the whole window', async () => {
  await seed('local', 'inside');
  await seed('local', 'spanning', { start_at: NOW - DAY_MS, end_at: NOW + DAY_MS });
  await seed('local', 'ends-at-start', { start_at: NOW - 3_600_000, end_at: NOW });
  await seed('local', 'starts-at-end', { start_at: input.end_at, end_at: input.end_at + 1000 });
  await seed('local', 'cancelled', { status: 'cancelled' });
  const collection = collections.get('local')!;
  const full = vi.spyOn(collection.table, 'get');
  const reads = vi.spyOn(collection.table, 'list');
  const result = readCalendarOverlaps(deps(), input);
  expect(result.events.map(event => event.summary)).toEqual(['spanning', 'inside']);
  expect(result.sources).toEqual([{ slug: 'local', name: 'On this server', status: 'local', last_synced_at: null }]);
  expect(result.truncated).toBe(false); expect(reads).toHaveBeenCalledTimes(2); expect(full).not.toHaveBeenCalled();
});

it('compares floating all-day dates on the draft clock across a 25-hour day', async () => {
  const first = Date.parse('2026-11-01T00:00:00Z');
  await seed('local', 'all-day', { is_all_day: true, start_at: first, end_at: first + DAY_MS });
  await seed('local', 'previous', { is_all_day: true, start_at: first - DAY_MS, end_at: first });
  await seed('local', 'last-minute', { start_at: Date.parse('2026-11-02T07:59:00Z'), end_at: Date.parse('2026-11-02T08:00:00Z') });
  await seed('local', 'next-day', { start_at: Date.parse('2026-11-02T08:00:00Z'), end_at: Date.parse('2026-11-02T09:00:00Z') });
  const result = readCalendarOverlaps(deps(), { ...input, is_all_day: true, start_at: first, end_at: first + DAY_MS });
  expect(result.events.map(event => event.summary)).toEqual(['all-day', 'last-minute']);
  // The same floating date starts on October 31 in UTC for this clock.
  expect(readCalendarOverlaps(deps(), { ...input, timezone: 'Pacific/Kiritimati',
    start_at: Date.parse('2026-10-31T10:00:00Z'), end_at: Date.parse('2026-10-31T11:00:00Z') }).events.map(event => event.summary)).toContain('all-day');
});

it('merges duplicate copies, preserves different occurrences, and excludes every copy of the edited event', async () => {
  add('work', true);
  await seed('local', 'self', { ical_uid: 'shared' });
  await seed('work', 'copy', { ical_uid: 'shared' });
  await seed('work', 'next-occurrence', { ical_uid: 'shared', start_at: NOW + 1000, end_at: NOW + 2000 });
  const before = readCalendarOverlaps(deps(), input);
  expect(before.events).toHaveLength(2);
  expect(before.events[0]!.calendars).toEqual(['On this server', 'work']);
  const exclude = { slug: 'local', source_id: 'self', expected_incarnation: instances.getIncarnation!('calendar', 'local')! };
  expect(readCalendarOverlaps(deps(), { ...input, exclude }).events.map(event => event.summary)).toEqual(['next-occurrence']);
  expect(() => readCalendarOverlaps(deps(), { ...input, exclude: { ...exclude, expected_incarnation: 'replaced' } })).toThrow(/changed/);
  await seed('work', 'no-uid-1', { ical_uid: '' }); await seed('work', 'no-uid-2', { ical_uid: '' });
  expect(readCalendarOverlaps(deps(), { ...input, exclude }).events.map(event => event.summary)).toEqual(['no-uid-1', 'no-uid-2', 'next-occurrence']);
});

it('reports unreadable, pending and incomplete sources instead of claiming the range is clear', () => {
  const work = add('work', true), health = work.health();
  const missing = add('missing', true); collections.delete('missing');
  const pending = add('pending', true);
  vi.mocked(pending.health).mockReturnValue({ ...health, slug: 'pending', pending_queue_size: 1 });
  add('backfill', true, false);
  const result = readCalendarOverlaps(deps(), input);
  expect(result.sources.map(source => [source.slug, source.status])).toEqual([
    ['local', 'local'], ['work', 'synced'], ['missing', 'unavailable'], ['pending', 'stale'], ['backfill', 'stale'],
  ]);
  vi.mocked(work.health).mockImplementation(() => { throw new Error('offline'); });
  expect(readCalendarOverlaps(deps(), input).sources.find(source => source.slug === 'work')?.status).toBe('stale');
  vi.spyOn(pending.table, 'list').mockImplementation(() => { throw new Error('unreadable'); });
  expect(readCalendarOverlaps(deps(), input).sources.find(source => source.slug === 'pending')?.status).toBe('unavailable');
  collections.set('missing', missing);
});

it('bounds dense calendars and declares that the displayed preview is incomplete', async () => {
  for (let i = 0; i < 202; i++) await seed('local', `event-${i}`, { start_at: NOW + i });
  const result = readCalendarOverlaps(deps(), input);
  expect(result.events).toHaveLength(12); expect(result.truncated).toBe(true);
});

it('rejects invalid, excessively broad, off-midnight and unknown-zone requests', () => {
  for (const patch of [{ end_at: NOW }, { start_at: NaN }, { end_at: NOW + 367 * DAY_MS },
    { timezone: 'Invalid/Zone' }, { is_all_day: true }]) {
    expect(() => readCalendarOverlaps(deps(), { ...input, ...patch })).toThrow(/valid time range/);
  }
});
