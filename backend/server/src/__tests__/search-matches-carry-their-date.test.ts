import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import { createBlobStore } from '../storage/blob-store.js';

/** A negotiation: no message states the deal, and the ORDER is the meaning. */
const THREAD = [
  '50 USD a piece for item A?',
  'I cannot buy at the previous volume.',
  '15% off with an MOQ as low as 10 pieces, if you agree to advance payment.',
  'what is the lead time?',
  'Seven days after payment is received.',
  'That I can accept. I will take 10.',
  'I will send you the invoice.',
];

const world = () => {
  const db = new Database(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'dates-'));
  const mail = createMailCollection({
    db, blobs: createBlobStore(dir),
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(), slug: 'inbox',
    provider: { start: async () => {}, stop: async () => {} } as never,
    config: () => ({ backfill_days: 3650, retention_days: 3650, quota_bytes: 1 << 26 }),
  });
  THREAD.forEach((body, i) => {
    mail.upsert({
      record_id: `mail:n${i}`,
      hot_fields: {
        subject: 'Item A pricing', from: i % 2 ? 's@k.test' : 'me@e.com',
        to: ['x@e.com'], cc: [], thread_id: 'TH',
      },
      received_at: 1000 + i * 3600, modified_at: 1000 + i * 3600,
      body_inline: body, size_bytes: body.length, source_id: 'inbox',
    } as never);
  });
  const registry = createCollectionRegistry();
  registry.register(mail as never);
  const handlers = buildChatTier1Handlers({
    getContactStore: () => undefined,
    getCollectionRegistry: () => registry,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({
      ids: () => [], get: () => null, getStored: () => null, listStored: () => [],
    }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
  } as never);
  const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T' } as never;
  const search = async (args: Record<string, unknown>) => {
    const h = (handlers as Record<string, (a: unknown, c: unknown) => Promise<unknown>>)['mail.search'];
    const r = await h({ limit: 20, ...args }, ctx) as {
      result?: { matches?: Array<{ record_id: string; received_at?: number }> };
    };
    return r.result?.matches ?? [];
  };
  return { db, search };
};

describe('a searched conversation can be put back in order', () => {
  it('⛔ every FTS match carries received_at — without it a thread is unorderable', async () => {
    // Search returns RELEVANCE order, which is the right retrieval contract. But
    // the match shape carried NO date, so a seven-message negotiation arrived
    // scrambled — measured, `n0 n4 n5 n3 n6 n1 n2` — with nothing to re-sort by.
    // For a negotiation the order IS the meaning: the discount applies to a price
    // stated earlier, the quantity clears an MOQ stated earlier, and message 2 is
    // a REFUSAL that reads as terms if you cannot see it came before the
    // counter-offer.
    const { db, search } = world();
    try {
      const got = await search({ query: 'item A pricing' });
      expect(got.length, 'the whole thread must come back').toBe(THREAD.length);
      expect(
        got.every((m) => typeof m.received_at === 'number'),
        'every row needs its date, or the sequence is unrecoverable',
      ).toBe(true);
      const order = [...got]
        .sort((a, b) => (a.received_at ?? 0) - (b.received_at ?? 0))
        .map((m) => m.record_id);
      expect(order, 'and sorting by it must reconstruct the conversation').toEqual(
        THREAD.map((_, i) => `mail:n${i}`),
      );
    } finally { db.close(); }
  });

  it('the LIST path still carries it too — the two paths must not disagree', async () => {
    // ⚠ THIS IS WHY THE GAP SURVIVED: the no-query path carried `received_at` the
    // whole time. Two paths of ONE tool answered with different shapes, and the
    // one a QUESTION reaches is the one that had lost the fact.
    const { db, search } = world();
    try {
      const listed = await search({});
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.every((m) => typeof m.received_at === 'number')).toBe(true);
    } finally { db.close(); }
  });
});
