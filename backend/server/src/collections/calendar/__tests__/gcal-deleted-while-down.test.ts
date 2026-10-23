/** An event deleted from Google Calendar while the server was down is gone
 *  after the restart.
 *
 *  Every start scans the calendar again, and the scan's fresh sync token
 *  replaced the one the last poll had left. That old token is what reports the
 *  events deleted in between; the scan lists none of them (`showDeleted:
 *  false`), so their rows stayed in the warehouse for good. And when Google had
 *  expired that token (410), the listing that replaced it reports no deletion
 *  either. The real Google provider and the real collection run here against a
 *  fake Google that keeps a change log, as the Calendar API does.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';
import type { HttpFetcher, OAuthAccountStore } from '../../mail/oauth.js';
import { createBlobStore } from '../../../storage/blob-store.js';
import { createCalendarCollection, type CalendarCollection } from '../calendar-collection.js';
import { createGcalProvider, type GcalEvent } from '../gcal-provider.js';

const BIG_QUOTA = 1024 * 1024 * 1024;
const HOUR = 3_600_000;

/** One calendar with a change log: every change bumps the version, a sync
 *  token names the version it was issued at, and a request with a token
 *  returns every event changed since, cancelled ones included. A token issued
 *  before `expireTokens()` gets a 410, as an expired one does. */
const fakeGoogle = () => {
  let version = 0;
  let validFrom = 0;
  let gone = 0;
  const events = new Map<string, { event: GcalEvent; changedAt: number }>();
  const put = (event: GcalEvent): void => { version += 1; events.set(event.id, { event, changedAt: version }); };
  const fetcher: HttpFetcher = async (url) => {
    const parsed = new URL(url);
    const ok = (body: unknown) => ({
      status: 200, ok: true, async json() { return body; }, async text() { return JSON.stringify(body); },
    });
    if (parsed.pathname.endsWith('/users/me/calendarList')) {
      return ok({ items: [{ id: 'primary', summary: 'Primary' }] });
    }
    if (parsed.pathname.endsWith('/calendars/primary/events')) {
      const token = parsed.searchParams.get('syncToken');
      const since = token === null ? null : Number(token.replace('v', ''));
      if (since !== null && since < validFrom) {
        gone += 1;
        const body = { error: { code: 410, message: 'Sync token is no longer valid, a full sync is required.' } };
        return { status: 410, ok: false, async json() { return body; }, async text() { return JSON.stringify(body); } };
      }
      const items = [...events.values()]
        .filter(({ event, changedAt }) => since === null ? event.status !== 'cancelled' : changedAt > since)
        .map(({ event }) => event);
      return ok({ items, nextSyncToken: `v${version}` });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return {
    fetcher,
    put,
    expireTokens(): void { validFrom = version; },
    /** How many requests got a 410. */
    gone: (): number => gone,
  };
};

const timed = (id: string, summary: string, startsIn: number): GcalEvent => ({
  id,
  iCalUID: `${id}@google.com`,
  status: 'confirmed',
  summary,
  start: { dateTime: new Date(Date.now() + startsIn).toISOString() },
  end: { dateTime: new Date(Date.now() + startsIn + HOUR).toISOString() },
  created: new Date(Date.now() - 24 * HOUR).toISOString(),
  updated: new Date(Date.now() - 24 * HOUR).toISOString(),
});

interface Harness {
  google: ReturnType<typeof fakeGoogle>;
  collection: CalendarCollection;
  events: WarehouseEvent[];
  close(): Promise<void>;
}

const newHarness = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'gcal-deleted-while-down-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 't.db'));
  const google = fakeGoogle();
  const store = new Map<string, string>([
    ['gcal.work.access_token', 'at-seed'],
    ['gcal.work.expires_at', String(Date.now() + HOUR)],
    ['gcal.work.refresh_token', 'rt-seed'],
  ]);
  const accountStore: OAuthAccountStore = {
    async get(key) { return store.get(key) ?? null; },
    async set(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
  const provider = createGcalProvider({
    slug: 'work',
    config: { account_slug: 'work', expansion_future_days: 90, expansion_past_days: 30, poll_seconds: 60 },
    accountStore,
    providerConfig: { tokenUrl: 'https://oauth2.googleapis.com/token', clientId: 'cid', clientSecret: 'csecret' },
    fetcher: google.fetcher,
    scheduler: () => () => undefined,
  });
  const bus = createWarehouseEventBus();
  const events: WarehouseEvent[] = [];
  bus.subscribe('**', (event) => { events.push(event); });
  const collection = createCalendarCollection({
    db,
    blobs: createBlobStore(join(dataDir, 'blobs')),
    gate: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:calendar:work' }),
    bus,
    slug: 'work',
    provider,
    config: () => ({
      backfill_days: 30,
      retention_days: 365,
      quota_bytes: BIG_QUOTA,
      expansion_past_days: 30,
      expansion_future_days: 90,
    }),
  });
  return {
    google,
    collection,
    events,
    async close() {
      await collection.close();
      bus.dispose();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('Google Calendar: an event deleted while the server was down', () => {
  it('is gone after the restart, and an event changed meanwhile is updated', async () => {
    h = newHarness();
    h.google.put(timed('standup', 'Standup', 24 * HOUR));
    h.google.put(timed('dentist', 'Dentist', 48 * HOUR));
    await h.collection.sync.start();
    expect(h.collection.table.get('standup')).not.toBeNull();
    expect(h.collection.table.get('dentist')).not.toBeNull();
    await h.collection.sync.stop();

    // While the server is down: the dentist is cancelled, the standup renamed.
    h.google.put({ ...timed('dentist', 'Dentist', 48 * HOUR), status: 'cancelled' });
    h.google.put(timed('standup', 'Team standup', 24 * HOUR));
    h.events.length = 0;

    await h.collection.sync.start();
    expect(h.collection.table.get('dentist')).toBeNull();
    expect(h.collection.table.get('standup')?.event.summary).toBe('Team standup');
    expect(h.collection.table.eventCount()).toBe(1);
    expect(h.events.map((event) => event.event_kind).sort()).toEqual(['deleted', 'updated']);
  });

  it('is gone after the restart when Google had expired the sync token, and the rest stay', async () => {
    h = newHarness();
    h.google.put(timed('standup', 'Standup', 24 * HOUR));
    h.google.put(timed('dentist', 'Dentist', 48 * HOUR));
    h.google.put(timed('retro', 'Retro', -72 * HOUR));
    await h.collection.sync.start();
    expect(h.collection.table.eventCount()).toBe(3);
    await h.collection.sync.stop();

    // While the server is down: the dentist is cancelled, and Google expires
    // every token it had issued.
    h.google.put({ ...timed('dentist', 'Dentist', 48 * HOUR), status: 'cancelled' });
    h.google.expireTokens();
    h.events.length = 0;

    await h.collection.sync.start();
    expect(h.google.gone()).toBe(1);
    expect(h.collection.table.get('dentist')).toBeNull();
    expect(h.collection.table.get('standup')).not.toBeNull();
    expect(h.collection.table.get('retro')).not.toBeNull();
    expect(h.collection.table.eventCount()).toBe(2);
    expect(h.events.filter((event) => event.event_kind === 'deleted')).toHaveLength(1);
  });
});
