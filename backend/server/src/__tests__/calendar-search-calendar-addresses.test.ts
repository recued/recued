/** `calendar.search` tells the model which account each calendar is.
 *
 *  ⛔ A calendar's slug is whatever it was connected under, and the owner says
 *  "my Outlook calendar" or an address. Mail search gave each mailbox's address
 *  (2026-10-18); calendar search named calendars by slug alone. Each result now
 *  names, by the `collection_slug` its matches carry, the calendar's provider
 *  and the address its account signed in as.
 *
 *  Through a real Microsoft calendar provider, which learns the address from
 *  the calendar list it reads at a sync, and real calendar collections. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { CalendarCollectionCaps } from '@recued/contracts';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createCalendarCollection } from '../collections/calendar/calendar-collection.js';
import { createGraphCalProvider } from '../collections/calendar/graph-provider.js';
import { createLocalCalendarProvider } from '../collections/calendar/local-provider.js';
import { calendarAddressOf, type CalendarProvider } from '../collections/calendar/provider.js';
import { createInstanceStore } from '../collections/instance-store.js';
import type { HttpFetcher } from '../collections/mail/oauth.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createBlobStore } from '../storage/blob-store.js';

const QUOTA = 1024 * 1024 * 1024;
const CAPS = { read: 'yes', search: 'local' } as CalendarCollectionCaps;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const done of cleanups.splice(0).reverse()) await done(); });

/** Microsoft Graph as the provider reads it: the calendar list, with the
 *  default calendar's owner, and empty calendars. */
const graphFetcher: HttpFetcher = async (url) => {
  const body = url.includes('/me/calendars?') || url.endsWith('/me/calendars')
    ? { value: [
      { id: 'cal-shared', name: 'Team', owner: { name: 'Bob', address: 'bob@contoso.test' } },
      { id: 'cal-1', name: 'Calendar', isDefaultCalendar: true, owner: { name: 'Me', address: 'recued.dev@outlook.com' } },
    ] }
    : url.includes('/delta')
      ? { value: [], '@odata.deltaLink': `${url.split('?')[0]}?$deltatoken=t` }
      : { value: [] };
  return { status: 200, ok: true, json: async () => body, text: async () => JSON.stringify(body) };
};

const world = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-addresses-'));
  const db = new Database(':memory:');
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const instances = createInstanceStore({ db });
  const registry = createCollectionRegistry();
  const tokens = new Map<string, string>([
    ['graph.outlook.access_token', 'at'], ['graph.outlook.expires_at', String(Date.now() + 3_600_000)],
    ['graph.outlook.refresh_token', 'rt'],
  ]);
  const outlook = createGraphCalProvider({
    slug: 'outlook',
    config: { account_slug: 'outlook', expansion_future_days: 30, expansion_past_days: 7, poll_seconds: 60 },
    accountStore: {
      get: async (k) => tokens.get(k) ?? null, set: async (k, v) => { tokens.set(k, v); }, delete: async (k) => { tokens.delete(k); },
    },
    providerConfig: { tokenUrl: 'https://login.example/token', clientId: 'cid', clientSecret: 'cs' },
    fetcher: graphFetcher,
    scheduler: () => () => undefined,
  });
  // A sync reads the calendar list.
  await outlook.initialScan({ backfill_days: 7, expansion_future_days: 30, expansion_past_days: 7, onEvent: async () => true });
  const own = createLocalCalendarProvider({ slug: 'default', now: () => Date.now(), readEvent: () => null });
  const add = (provider: CalendarProvider) => {
    instances.upsert({
      platform: 'calendar', slug: provider.slug, adapter_type: provider.kind, config: {}, caps: CAPS,
      auth_state: 'healthy', last_synced_at: null,
    });
    const collection = createCalendarCollection({
      db, blobs: createBlobStore(join(dir, provider.slug)),
      gate: createStorageGate({ quota: QUOTA, reservePct: 10, surface: `collection:calendar:${provider.slug}` }),
      bus: createWarehouseEventBus(), slug: provider.slug, provider,
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: QUOTA, expansion_past_days: 30, expansion_future_days: 90 }),
      instances,
    });
    cleanups.push(() => collection.close());
    registry.register(collection as never);
  };
  add(outlook);
  add(own);
  const handlers = buildChatTier1Handlers({
    getContactStore: () => undefined,
    getCollectionRegistry: () => registry,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
  } as never);
  const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T' } as never;
  return async (args: Record<string, unknown>) => {
    const h = (handlers as Record<string, (a: unknown, c: unknown) => Promise<unknown>>)['calendar.search'];
    const r = await h(args, ctx) as { ok: boolean; result: Record<string, unknown> };
    expect(r.ok).toBe(true);
    return r.result;
  };
};

describe('calendar.search names each calendar by its account', () => {
  it('each calendar: its provider, and the address its account signed in as when it has one', async () => {
    const search = await world();
    for (const args of [{}, { query: 'standup' }]) {
      const result = await search(args);
      expect(result.collections).toEqual(['outlook', 'default']);
      expect(result.calendar_addresses).toEqual([
        // The default calendar's owner, never the shared calendar's.
        { collection_slug: 'outlook', address: 'recued.dev@outlook.com', provider: 'Outlook' },
        // Recued's own calendar has no account.
        { collection_slug: 'default', address: '', provider: 'Recued, on this server' },
      ]);
    }
  });

  it('what is not known of a calendar is empty, never a guess', () => {
    expect(calendarAddressOf({})).toEqual({ address: '', provider: '' });
    expect(calendarAddressOf({ provider: null })).toEqual({ address: '', provider: '' });
    expect(calendarAddressOf({ provider: { kind: 'gcal', accountEmail: ' me@gmail.test ' } }))
      .toEqual({ address: 'me@gmail.test', provider: 'Google Calendar' });
    expect(calendarAddressOf({ provider: { kind: 'caldav', accountEmail: 7 } })).toEqual({ address: '', provider: 'CalDAV' });
    // An inherited key is not a provider.
    expect(calendarAddressOf({ provider: { kind: 'toString' } }).provider).toBe('');
  });
});
