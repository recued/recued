/** The owner's Re-sync on a calendar reads it again (`collection.calendar.resync`).
 *
 *  It used to check access and then mark the calendar synced, reading nothing:
 *  an event changed at Google stayed as it was until the next poll, while the
 *  page said the calendar had just synced. It answers once the calendar has
 *  caught up, so the page it reloads shows this read (`resync-wait.ts`). The
 *  real calendar stack, collection and Google provider run here against a fake
 *  Google; nothing polls on its own.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarCollectionCaps } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { HttpFetcher, OAuthAccountStore } from '../../mail/oauth.js';
import { createBlobStore } from '../../../storage/blob-store.js';
import { composeCalendarStack, type CalendarStack } from '../compose.js';
import { handleCalendarResync } from '../enroll.js';
import { createGcalProvider, type GcalEvent } from '../gcal-provider.js';

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
const CAPS: CalendarCollectionCaps = {
  read: 'yes', list_calendars: 'yes', create_event: 'yes', update_event: 'yes', delete_event: 'yes',
  rsvp: 'yes', search: 'remote', watch: 'poll', auth: 'oauth', recurrence: 'server',
};

/** One Google calendar; every listing returns what it holds now. */
const fakeGoogle = () => {
  const events = new Map<string, GcalEvent>();
  let failing = false;
  let listings = 0;
  const reply = (status: number, body: unknown) => ({
    status, ok: status < 300, async json() { return body; }, async text() { return JSON.stringify(body); },
  });
  const fetcher: HttpFetcher = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/users/me/calendarList')) {
      return reply(200, { items: [{ id: 'primary', summary: 'Primary' }] });
    }
    if (parsed.pathname.endsWith('/calendars/primary/events')) {
      listings += 1;
      if (failing) return reply(500, { error: { code: 500, message: 'Backend Error' } });
      return reply(200, { items: [...events.values()], nextSyncToken: 'v1' });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return {
    fetcher,
    put(event: GcalEvent) { events.set(event.id, event); },
    fail() { failing = true; },
    listings: () => listings,
  };
};

const timed = (id: string, summary: string, startsIn: number): GcalEvent => ({
  id,
  iCalUID: `${id}@google.com`,
  status: 'confirmed',
  summary,
  start: { dateTime: new Date(Date.now() + startsIn).toISOString() },
  end: { dateTime: new Date(Date.now() + startsIn + HOUR).toISOString() },
});

interface Harness {
  google: ReturnType<typeof fakeGoogle>;
  stack: CalendarStack;
  /** The clock the collection and the Re-sync read. */
  advance(ms: number): void;
  summaryOf(id: string): string | undefined;
  close(): Promise<void>;
}

const newHarness = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-resync-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  const db = new Database(join(dir, 'data', 't.db'));
  const bus = createWarehouseEventBus();
  const google = fakeGoogle();
  const secrets = new Map<string, string>([
    ['gcal.work.access_token', 'at-seed'],
    ['gcal.work.expires_at', String(Date.now() + HOUR)],
    ['gcal.work.refresh_token', 'rt-seed'],
  ]);
  const accountStore: OAuthAccountStore = {
    async get(key) { return secrets.get(key) ?? null; },
    async set(key, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); },
  };
  let now = T0;
  const stack = composeCalendarStack(db, {
    blobs: createBlobStore(join(dir, 'data', 'blobs')),
    bus,
    getGate: () => createStorageGate({ quota: 100 * 1024 * 1024, reservePct: 10, surface: 'collection:calendar:work' }),
  }, {
    factories: [{
      kind: 'gcal',
      async probeCaps() { return CAPS; },
      create: (ctx) => createGcalProvider({
        slug: ctx.slug,
        config: { account_slug: 'work', expansion_future_days: 90, expansion_past_days: 30, poll_seconds: 60 },
        accountStore,
        providerConfig: { tokenUrl: 'https://oauth2.googleapis.com/token', clientId: 'cid', clientSecret: 'csecret' },
        fetcher: google.fetcher,
        scheduler: () => () => undefined,
      }),
    }],
    accountStore,
    isVaultUnlocked: () => true,
    now: () => now,
  });
  stack.instances.upsert({
    platform: 'calendar', slug: 'work', adapter_type: 'gcal', config: {}, caps: CAPS, auth_state: 'healthy', last_synced_at: null,
  });
  return {
    google,
    stack,
    advance(ms) { now += ms; },
    summaryOf: (id) => stack.listLive()[0]?.table.get(id)?.event.summary,
    async close() {
      await stack.disposeAll();
      bus.dispose();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('Re-sync on a Google calendar', () => {
  it('reads the calendar again, and answers once it has: the page it reloads shows this read', async () => {
    h = newHarness();
    h.google.put(timed('standup', 'Standup', 24 * HOUR));
    await h.stack.startAll('wait');
    expect(h.summaryOf('standup')).toBe('Standup');

    // An hour on, the event changed at Google and another was added.
    h.advance(HOUR);
    h.google.put(timed('standup', 'Team standup', 24 * HOUR));
    h.google.put(timed('dentist', 'Dentist', 48 * HOUR));
    expect(h.summaryOf('standup')).toBe('Standup');

    await expect(handleCalendarResync(h.stack.enrollDeps, { slug: 'work' }))
      .resolves.toMatchObject({ ok: true, auth_state: 'healthy' });
    expect(h.summaryOf('standup')).toBe('Team standup');
    expect(h.summaryOf('dentist')).toBe('Dentist');
    expect(h.stack.instances.get('calendar', 'work')?.last_synced_at).toBe(T0 + HOUR);
  });

  it('leaves the sync time alone when it reads nothing, and answers once the read has failed', async () => {
    h = newHarness();
    h.google.put(timed('standup', 'Standup', 24 * HOUR));
    await h.stack.startAll('wait');
    const synced = h.stack.instances.get('calendar', 'work')?.last_synced_at;
    expect(synced).toBe(T0);

    // An hour on, Google fails every listing. A wait longer than the test: it
    // answers on the failed read, not on the timer.
    h.advance(HOUR);
    h.google.fail();
    const listings = h.google.listings();
    await expect(handleCalendarResync({ ...h.stack.enrollDeps, resyncWaitMs: 60_000 }, { slug: 'work' }))
      .resolves.toMatchObject({ ok: true });
    expect(h.google.listings()).toBeGreaterThan(listings);
    expect(h.stack.instances.get('calendar', 'work')?.last_synced_at).toBe(T0);
  });
});
