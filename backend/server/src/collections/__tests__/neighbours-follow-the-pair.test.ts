import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createMailCollection } from '../mail/mail-collection.js';
import { createBlobStore } from '../../storage/blob-store.js';

const ME = 'me@e.com';
const THEM = 'sales@kestrel.test';
const OTHER = 'bob@unrelated.test';

/** ⛔⛔ ADJACENCY IS THE PARTICIPANT PAIR, NOT THE SENDER — and the difference is
 *  not academic. The clause was `from = <anchor's from>`, described in the tool
 *  schema as "follows the correspondents". It follows ONE ENDPOINT, which is
 *  wrong in BOTH directions:
 *
 *   · anchored on THEIR message it matches their other mail and never the
 *     owner's — so a reply the owner typed OUTSIDE the thread (a forward, or a
 *     fresh mail because replying was inconvenient) falls out entirely. That is
 *     the ordinary case, not an edge one: people break threads constantly.
 *   · anchored on the OWNER'S message, `from = me@` matches EVERY message the
 *     owner ever sent, to anyone — on a real mailbox, the whole sent folder,
 *     bounded only by the next/prev cursor.
 *
 *  A conversation is the unordered pair {A, B}: `[me,him] + [him,me]`. */
const world = () => {
  const db = new Database(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'pair-'));
  const mail = createMailCollection({
    db, blobs: createBlobStore(dir),
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(), slug: 'inbox',
    provider: { start: async () => {}, stop: async () => {} } as never,
    config: () => ({ backfill_days: 3650, retention_days: 3650, quota_bytes: 1 << 26 }),
  });
  const put = (id: string, from: string, to: string, thread: string, at: number): void => {
    mail.upsert({
      record_id: id,
      hot_fields: { subject: 's', from, to: [to], cc: [], thread_id: thread },
      received_at: at, modified_at: at, body_inline: 'b', size_bytes: 1, source_id: 'inbox',
    } as never);
  };
  put('mail:t1', THEM, ME, 'TH', 100);
  put('mail:t2', ME, THEM, 'TH', 200);
  // The owner answers OUTSIDE the thread, and so do they.
  put('mail:loose', ME, THEM, 'OTHERTH', 300);
  put('mail:loose2', THEM, ME, 'OTHERTH2', 320);
  // Unrelated mail the owner sent elsewhere in the same window.
  put('mail:noise', ME, OTHER, 'NOISE', 310);
  const near = (anchor: string): string[] =>
    (mail as unknown as {
      neighbours: (q: { anchor_id: string; next?: number; prev?: number }) => Array<{ record_id: string }>;
    }).neighbours({ anchor_id: anchor, next: 5, prev: 5 }).map((r) => r.record_id);
  return { db, near };
};

describe('neighbour adjacency follows the participant pair', () => {
  it('reaches an out-of-thread reply from EITHER end of the pair', () => {
    const { db, near } = world();
    try {
      for (const anchor of ['mail:t1', 'mail:t2']) {
        const got = near(anchor);
        expect(
          got.some((id) => id === 'mail:loose' || id === 'mail:loose2'),
          `${anchor}: a broken thread between the same two people must still be adjacent`,
        ).toBe(true);
      }
    } finally { db.close(); }
  });

  it('does NOT leak unrelated mail the owner sent to a third party', () => {
    // The regression that made the old scope dangerous rather than merely
    // incomplete: anchoring on one's own message matched the entire sent folder.
    const { db, near } = world();
    try {
      for (const anchor of ['mail:t1', 'mail:t2']) {
        expect(near(anchor), `${anchor} must not pull in mail to a third party`)
          .not.toContain('mail:noise');
      }
    } finally { db.close(); }
  });

  it('still follows the THREAD when one exists — it is a hint, not a replacement', () => {
    const { db, near } = world();
    try {
      expect(near('mail:t1'), 'the in-thread reply is still adjacent').toContain('mail:t2');
    } finally { db.close(); }
  });
});
