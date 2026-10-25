/** `mail.search` and `mail.read` write a message's date on the turn's clock.
 *
 *  ⛔ `received_at_iso` was always UTC (`2026-08-26T03:30:00.000Z`). For an owner
 *  in Los Angeles that mail arrived on the evening of the 25th, and the model
 *  reports the date it reads. With the turn's zone (`ChatDispatchContext.time_zone`)
 *  it now reads `2026-08-25T20:30:00-07:00`: the same instant, the owner's date.
 *  Without one (an MCP caller, a direct call) it stays UTC.
 *
 *  Through a real mail collection and the handlers' own wrappers. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import { createCollectionRegistry } from '../collections/registry.js';
import type { Collection } from '../collections/types.js';
import { createBlobStore } from '../storage/blob-store.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const done of cleanups.splice(0).reverse()) await done(); });

/** 03:30 UTC on Wednesday 2026-08-26: 20:30 on the 25th in Los Angeles. */
const LATE_EVENING = Date.UTC(2026, 7, 26, 3, 30);

const tools = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-date-'));
  const db = new Database(':memory:');
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const mail = createMailCollection({
    db, blobs: createBlobStore(dir),
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(), slug: 'inbox',
    provider: { start: async () => {}, stop: async () => {} } as never,
    config: () => ({ backfill_days: 3650, retention_days: 3650, quota_bytes: 1 << 26 }),
  });
  mail.upsert({
    record_id: 'mail:inbox-budget',
    hot_fields: { subject: 'Q3 budget figures', from: 'sender@e.com', to: ['me@e.com'], cc: [], thread_id: 'T-1' },
    received_at: LATE_EVENING, modified_at: LATE_EVENING,
    body_inline: 'Here are the Q3 budget figures.', size_bytes: 31, source_id: 'inbox',
  } as never);
  const registry = createCollectionRegistry();
  registry.register(mail as unknown as Collection as never);
  const handlers = buildChatTier1Handlers({
    getContactStore: () => undefined,
    getCollectionRegistry: () => registry,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
  } as never) as Record<string, (a: unknown, c: unknown) => Promise<unknown>>;
  const call = async (tool: string, args: Record<string, unknown>, time_zone?: string) => {
    const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T', ...(time_zone ? { time_zone } : {}) };
    const r = await handlers[tool]!(args, ctx) as { ok: boolean; result: Record<string, unknown> };
    expect(r.ok).toBe(true);
    return r.result;
  };
  return {
    searchDate: async (args: Record<string, unknown>, time_zone?: string) => {
      const result = await call('mail.search', { limit: 5, ...args }, time_zone) as { matches: Array<{ received_at_iso: string }> };
      expect(result.matches).toHaveLength(1);
      return result.matches[0]!.received_at_iso;
    },
    readDate: async (time_zone?: string) =>
      (await call('mail.read', { slug: 'inbox', record_id: 'mail:inbox-budget' }, time_zone))['received_at_iso'],
  };
};

describe('a mail\'s date, on the turn\'s clock', () => {
  it('⛔ a search gives the owner\'s date for a mail that arrived late in their evening', async () => {
    const { searchDate } = tools();
    // Both the search and the listing write it.
    for (const args of [{ query: 'budget' }, {}]) {
      expect(await searchDate(args, 'America/Los_Angeles')).toBe('2026-08-25T20:30:00-07:00');
    }
    expect(await searchDate({ query: 'budget' }, 'Asia/Kolkata')).toBe('2026-08-26T09:00:00+05:30');
  });

  it('a read gives the same date the search did', async () => {
    const { readDate } = tools();
    expect(await readDate('America/Los_Angeles')).toBe('2026-08-25T20:30:00-07:00');
  });

  it('stays UTC when the dispatch names no clock (an MCP caller keeps its own)', async () => {
    const { searchDate, readDate } = tools();
    expect(await searchDate({ query: 'budget' })).toBe('2026-08-26T03:30:00.000Z');
    expect(await readDate()).toBe('2026-08-26T03:30:00.000Z');
  });
});
