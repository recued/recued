/** `calendar.search` writes when each event happens on the turn's clock.
 *
 *  ⛔ The result gave a time only as epoch ms (`start_at: 1787838000000`), so the
 *  model converted it itself and named the wrong day: bench 175 (2026-10-24)
 *  answered "Aug 26" for a meeting at 13:40 UTC on Aug 27 in 8 of its 60
 *  conversations.
 *  Each match now carries `when`, in the zone the turn's `current_date` is
 *  stamped in, written by the same logic as the `event_when` transform.
 *
 *  Through real calendar collections and the handler's own wrapper; the
 *  second block runs a chat turn and reads the zone its dispatches carry. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { CalendarCollectionCaps } from '@recued/contracts';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { runChatTurn } from '../chat-turn-executor.js';
import { createCalendarCollection } from '../collections/calendar/calendar-collection.js';
import { createLocalCalendarProvider } from '../collections/calendar/local-provider.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createBlobStore } from '../storage/blob-store.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const done of cleanups.splice(0).reverse()) await done(); });

const NOW = Date.UTC(2026, 9, 24, 10, 0);
const QUOTA = 1 << 26;
const HOUR = 3_600_000;

interface Ev { summary: string; start_at: number; end_at: number; is_all_day?: boolean }

/** Bench 175's meeting: 13:40–14:40 UTC on Thursday 2026-08-27. */
const BUDGET_REVIEW: Ev = { summary: 'Q3 budget review', start_at: 1_787_838_000_000, end_at: 1_787_838_000_000 + HOUR };
/** An all-day event, stored as the UTC midnight of its day. */
const HOLIDAY: Ev = { summary: 'Office holiday', start_at: Date.UTC(2026, 11, 24), end_at: Date.UTC(2026, 11, 25), is_all_day: true };
/** In December, after the clocks change. */
const WINTER_PLANNING: Ev = { summary: 'Winter planning', start_at: Date.UTC(2026, 11, 3, 18), end_at: Date.UTC(2026, 11, 3, 19) };

const calendarSearch = (events: Ev[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-when-'));
  const db = new Database(':memory:');
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const instances = createInstanceStore({ db });
  instances.upsert({
    platform: 'calendar', slug: 'work', adapter_type: 'local', config: {},
    caps: { read: 'yes', search: 'local' } as CalendarCollectionCaps,
    auth_state: 'healthy', last_synced_at: null,
  });
  const collection = createCalendarCollection({
    db, blobs: createBlobStore(dir),
    gate: createStorageGate({ quota: QUOTA, reservePct: 10, surface: 'collection:calendar:work' }),
    bus: createWarehouseEventBus(), slug: 'work',
    provider: createLocalCalendarProvider({ slug: 'work', now: () => NOW, readEvent: () => null }),
    config: () => ({ backfill_days: 365, retention_days: 3650, quota_bytes: QUOTA, expansion_past_days: 365, expansion_future_days: 365 }),
    instances,
  });
  cleanups.push(() => collection.close());
  events.forEach((e, i) => {
    collection.table.upsert({
      event: {
        source_id: `ev${i}`, ical_uid: `ev${i}@x`, calendar_id: 'primary', summary: e.summary,
        start_at: e.start_at, end_at: e.end_at, timezone: 'UTC', is_all_day: e.is_all_day ?? false,
        status: 'confirmed', attendees: [], created_at: NOW, updated_at: NOW,
      },
      size_bytes: 20, body_inline: `${e.summary}.`, now: NOW,
    } as never);
  });
  const registry = createCollectionRegistry();
  registry.register(collection as never);
  const handlers = buildChatTier1Handlers({
    getContactStore: () => undefined,
    getCollectionRegistry: () => registry,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
  } as never) as Record<string, (a: unknown, c: unknown) => Promise<unknown>>;
  return async (args: Record<string, unknown>, time_zone?: string) => {
    const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T', ...(time_zone ? { time_zone } : {}) };
    const r = await handlers['calendar.search']!({ limit: 20, ...args }, ctx) as {
      ok: boolean; result: { matches: Array<{ hot_fields: { summary: string; start_at: number }; when?: string }> };
    };
    expect(r.ok).toBe(true);
    return Object.fromEntries(r.result.matches.map((m) => [m.hot_fields.summary, m]));
  };
};

describe('calendar.search — when each event happens, on the turn\'s clock', () => {
  it('⛔ the day the owner lives it, not the one epoch-ms arithmetic lands on', async () => {
    const search = calendarSearch([BUDGET_REVIEW]);
    // A search and a listing both write it.
    for (const args of [{ query: 'budget' }, {}]) {
      const m = (await search(args, 'America/Los_Angeles'))['Q3 budget review']!;
      expect(m.when).toBe('2026-08-27 06:40–07:40 (UTC-07:00)');
      // The instant it is read from stays as it was.
      expect(m.hot_fields.start_at).toBe(1_787_838_000_000);
    }
    // East of UTC the same instant is still the 27th, on a different clock.
    expect((await search({ query: 'budget' }, 'Asia/Kolkata'))['Q3 budget review']!.when)
      .toBe('2026-08-27 19:10–20:10 (UTC+05:30)');
  });

  it('⛔ an all-day event is its own day, never the evening before', async () => {
    const search = calendarSearch([HOLIDAY]);
    // Stored at UTC midnight, which is 16:00 on the 23rd in Los Angeles.
    expect((await search({ query: 'holiday' }, 'America/Los_Angeles'))['Office holiday']!.when)
      .toBe('2026-12-24, all day');
  });

  it('carries the offset of the event\'s own date, not today\'s', async () => {
    const search = calendarSearch([WINTER_PLANNING]);
    expect((await search({ query: 'planning' }, 'America/Los_Angeles'))['Winter planning']!.when)
      .toBe('2026-12-03 10:00–11:00 (UTC-08:00)');
  });

  it('writes nothing when the dispatch names no clock (an MCP caller keeps its own)', async () => {
    const search = calendarSearch([BUDGET_REVIEW]);
    const m = (await search({ query: 'budget' }))['Q3 budget review']!;
    expect('when' in m).toBe(false);
  });
});

/** A turn whose model asks for `calendar.search` once, then answers. Returns
 *  the zone each dispatch carried and the packet's `current_date`. */
const turnZones = async (opts: { time_zone?: string; serverTimeZone?: string }) => {
  const zones: Array<string | undefined> = [];
  const prompts: string[] = [];
  let round = 0;
  await runChatTurn(
    {
      session_id: 's', turn_id: 't', picker_target: 'self',
      dispatch_peer_name: null, available_tools: [],
      content: { chat_tail: [], user_message: 'when is the budget review?' },
      correction_context: [], model_layer: 'byok',
      ...(opts.time_zone !== undefined ? { time_zone: opts.time_zone } : {}),
    } as never,
    {
      executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
        prompts.push(String(input['llm.prompt']));
        round += 1;
        return round === 1
          ? { body: { response: '', events: [], tool_calls: [{ tool: 'calendar.search', args: { query: 'budget review' } }] } }
          : { body: { response: 'It is on Thursday.', events: [], tool_calls: [] } };
      },
      registry: {
        list: () => [], listByTier: () => [],
        getByName: () => undefined,
        dispatch: async () => ({ ok: true, result: {} }),
        subscribeRefresh: () => () => undefined,
      } as never,
      dispatchTool: async (args: { time_zone?: string }) => {
        zones.push(args.time_zone);
        return { ok: true as const, result: { matches: [] } };
      },
      ...(opts.serverTimeZone !== undefined ? { serverTimeZone: () => opts.serverTimeZone } : {}),
      emit: () => undefined,
      now: () => NOW,
    } as never,
  );
  const currentDate = /"current_date":"([^"]*)"/.exec(prompts[0] ?? '')?.[1];
  return { zones, currentDate };
};

describe('every dispatch in a turn carries the zone its current_date is stamped in', () => {
  it('the surface\'s zone', async () => {
    const { zones, currentDate } = await turnZones({ time_zone: 'Asia/Kolkata', serverTimeZone: 'Europe/Berlin' });
    expect(zones).toEqual(['Asia/Kolkata']);
    expect(currentDate).toBe('Saturday 2026-10-24 15:30 (UTC+05:30)');
  });

  it('the server\'s zone when the surface sent none, as on Slack or Telegram', async () => {
    const { zones, currentDate } = await turnZones({ serverTimeZone: 'America/New_York' });
    expect(zones).toEqual(['America/New_York']);
    expect(currentDate).toBe('Saturday 2026-10-24 06:00 (UTC-04:00)');
  });

  it('⛔ a zone the platform does not know falls back exactly as current_date does', async () => {
    const { zones, currentDate } = await turnZones({ time_zone: 'Not/AZone', serverTimeZone: 'Europe/Berlin' });
    expect(zones).toEqual(['Europe/Berlin']);
    expect(currentDate).toBe('Saturday 2026-10-24 12:00 (UTC+02:00)');
  });
});
