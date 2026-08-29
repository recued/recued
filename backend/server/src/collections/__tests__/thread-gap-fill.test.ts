import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createMailCollection } from '../mail/mail-collection.js';
import { createBlobStore } from '../../storage/blob-store.js';

/** ⛔⛔ A REPLY DOES NOT RESTATE THE SUBJECT IT REPLIES TO, so the connective
 *  tissue of a thread carries the conditions and counter-offers while matching
 *  NONE of the search terms. A keyword index structurally cannot reach it —
 *  position is the only thing that identifies it.
 *
 *  Measured on bench 276: `kestrel` matched records {0,1,3,6} and the unmatched
 *  2, 4, 5 were the buyer's own messages — "54 is above our budget", "split 250
 *  now and 150 in Q3", "that rate holds only against the full 400". Every one is
 *  load-bearing for the answer. */
describe('search fills the gap between two matches of a thread', () => {
  const world = () => {
    const db = new Database(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'gap-'));
    return createMailCollection({
      db, blobs: createBlobStore(dir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(), slug: 'inbox',
      provider: { start: async () => {}, stop: async () => {} } as never,
      config: () => ({ backfill_days: 3650, retention_days: 3650, quota_bytes: 1 << 26 }),
    });
  };
  const put = (mail: ReturnType<typeof world>, id: string, body: string, i: number, thread = 't1') =>
    mail.upsert({
      record_id: id,
      hot_fields: { subject: 'Acme terms', from: 'a@e.com', to: ['me@e.com'], cc: [], thread_id: thread },
      received_at: 1_788_000_000_000 + i * 86_400_000,
      modified_at: 1_788_000_000_000 + i * 86_400_000,
      body_inline: body, size_bytes: body.length, source_id: 'inbox',
    } as never);

  it('returns the un-matching reply that sits between two matches', () => {
    const mail = world();
    put(mail, 'm0', 'Zephyr unit price is 50 a piece', 0);
    put(mail, 'm1', 'that is above our budget, what about 400 units', 1);   // no "zephyr"
    put(mail, 'm2', 'Zephyr can do 6% off at that volume', 2);
    const ids = mail.search({ platform: 'mail', slug: 'inbox', query: 'zephyr', limit: 10 } as never)
      .map((h: { record_id: string }) => h.record_id);
    // m1 matches NO term; it is reached only because it lies between m0 and m2.
    expect(ids).toContain('m1');
    expect(ids).toContain('m0');
    expect(ids).toContain('m2');
  });

  it('does NOT wander outside the matched span', () => {
    const mail = world();
    put(mail, 'before', 'unrelated chatter', 0);
    put(mail, 'm1', 'Zephyr price', 1);
    put(mail, 'mid', 'sure, sounds fine', 2);
    put(mail, 'm2', 'Zephyr confirmed', 3);
    put(mail, 'after', 'more unrelated chatter', 4);
    const ids = mail.search({ platform: 'mail', slug: 'inbox', query: 'zephyr', limit: 10 } as never)
      .map((h: { record_id: string }) => h.record_id);
    expect(ids).toContain('mid');
    // ⛔ The bound is what separates this from the speculative neighbour lane.
    expect(ids).not.toContain('before');
    expect(ids).not.toContain('after');
  });

  it('a single match spans nothing, so nothing is pulled in', () => {
    const mail = world();
    put(mail, 'only', 'Zephyr price is 50', 0);
    put(mail, 'other', 'unrelated', 1);
    const ids = mail.search({ platform: 'mail', slug: 'inbox', query: 'zephyr', limit: 10 } as never)
      .map((h: { record_id: string }) => h.record_id);
    expect(ids).toEqual(['only']);
  });
});
