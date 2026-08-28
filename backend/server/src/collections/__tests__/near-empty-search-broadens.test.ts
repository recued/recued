import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createMailCollection } from '../mail/mail-collection.js';
import { createBlobStore } from '../../storage/blob-store.js';
import { relaxToPresentPrefixTokens } from '../table.js';

/** ⛔⛔ AN `AND` THAT MATCHES ALMOST NOTHING IS A FAILED SEARCH THAT LOOKS LIKE A
 *  SUCCESSFUL ONE. Only the ZERO case used to be treated as failure.
 *
 *  The measured shape (bench 276): a seven-message negotiation, opened with
 *  `"Kestrel invoice first release item A"`. FTS5 ANDs bare terms and "invoice"
 *  appears in exactly ONE of the seven, so the search returned that one row and
 *  the model answered from it — 10 of 11 runs opened with a query of this shape,
 *  and the ones that never broadened could not reach the numbers at all. */
describe('a near-empty AND result broadens instead of passing for an answer', () => {
  const THREAD = [
    ['n0', 'me@e.com',      'we would take 200 units of item A at 50 USD a piece'],
    ['n1', 'sales@k.test',  'Kestrel cannot hold 50 USD at 200 units; best is 54 a piece'],
    ['n2', 'me@e.com',      'what if we commit to 400 units across two quarters'],
    ['n3', 'sales@k.test',  'at 400 I can take 6% off the price you originally asked for'],
    ['n4', 'me@e.com',      'do the 400 commitment but split shipping 250 now and 150 in Q3'],
    ['n5', 'sales@k.test',  'agreed, that rate holds against the full 400 commitment'],
    // The ONLY message carrying "invoice" — the term that collapses the AND.
    ['n6', 'sales@k.test',  'Kestrel will send the invoice for the first release shortly'],
  ] as const;

  const world = () => {
    const db = new Database(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'near-'));
    const mail = createMailCollection({
      db, blobs: createBlobStore(dir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(), slug: 'inbox',
      provider: { start: async () => {}, stop: async () => {} } as never,
      config: () => ({ backfill_days: 3650, retention_days: 3650, quota_bytes: 1 << 26 }),
    });
    THREAD.forEach(([id, from, body], i) => {
      mail.upsert({
        record_id: id,
        hot_fields: {
          subject: 'Kestrel item A pricing', from,
          to: [from === 'me@e.com' ? 'sales@k.test' : 'me@e.com'],
          cc: [], thread_id: 'th-1',
        },
        received_at: 1_788_000_000_000 + i * 86_400_000,
        modified_at: 1_788_000_000_000 + i * 86_400_000,
        body_inline: body, size_bytes: body.length, source_id: 'inbox',
      } as never);
    });
    return { db, mail };
  };

  const QUERY = 'Kestrel invoice first release item A';

  it('reaches the whole conversation from the query that used to return one row', () => {
    const { mail } = world();
    const hits = mail.search({ platform: 'mail', slug: 'inbox', query: QUERY, limit: 20 } as never);
    // The point is REACH: the derivation needs n0 (the 50 ask) and n3 (the 6%),
    // neither of which contains "invoice" and so neither of which the AND
    // could ever have returned.
    const ids = hits.map((h: { record_id: string }) => h.record_id);
    expect(ids).toContain('n0');
    expect(ids).toContain('n3');
    expect(ids.length).toBeGreaterThan(NEAR_EMPTY_CEILING);
  });

  it('labels the broadened rows so they are never read as what was asked for', () => {
    const { mail } = world();
    const hits = mail.search(
      { platform: 'mail', slug: 'inbox', query: QUERY, limit: 20 } as never,
    ) as Array<{ record_id: string; partial_match?: boolean }>;
    // n6 is the only true full match; everything else got here by matching SOME
    // terms. Unlabelled, a partial row is indistinguishable from evidence the
    // caller actually asked for — which is the whole reason to disclose.
    expect(hits.find((h) => h.record_id === 'n6')?.partial_match).toBeUndefined();
    expect(hits.find((h) => h.record_id === 'n0')?.partial_match).toBe(true);
    expect(hits.find((h) => h.record_id === 'n3')?.partial_match).toBe(true);
  });

  it('does NOT broaden a search that already returned a real page', () => {
    const { mail } = world();
    // "Kestrel" alone is a healthy AND — it matches on subject across the
    // thread. Broadening here would add noise to a page that has none.
    const hits = mail.search(
      { platform: 'mail', slug: 'inbox', query: 'Kestrel', limit: 20 } as never,
    ) as Array<{ partial_match?: boolean }>;
    expect(hits.length).toBeGreaterThan(NEAR_EMPTY_CEILING);
    expect(hits.some((h) => h.partial_match === true)).toBe(false);
  });

  it('proves relaxation alone could not have done it — every term IS in the index', () => {
    // ⛔ THE NEGATIVE THAT MAKES THE FIX NON-OBVIOUS. `relaxToPresentPrefixTokens`
    // drops tokens absent from the whole index and re-ANDs the rest. Here every
    // term exists somewhere, so it returns a full-width AND — the same query,
    // the same one row. Lowering the relaxation THRESHOLD without changing the
    // MECHANISM would have shipped a no-op that read as a fix.
    const { db } = world();
    const ftsName = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collection_mail_%_fts'`,
    ).get() as { name: string };
    const relaxed = relaxToPresentPrefixTokens(db, ftsName.name, QUERY);
    expect(relaxed).not.toBeNull();
    for (const term of ['kestrel', 'invoice', 'first', 'release', 'item']) {
      expect(relaxed!.toLowerCase()).toContain(term);
    }
    // No OR anywhere: it is still a conjunction.
    expect(relaxed).not.toContain(' OR ');
  });
});

/** Mirrors `NEAR_EMPTY_MATCH_CEILING` in `collections/table.ts`. Kept local on
 *  purpose — the constant is internal, and a test that imported it would pass
 *  for any value it happened to hold. */
const NEAR_EMPTY_CEILING = 2;
