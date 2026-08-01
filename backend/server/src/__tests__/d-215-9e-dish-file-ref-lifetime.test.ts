/** D-215 § 9e item (e) — what actually keeps a dish-held `file_ref` alive.
 *
 *  The item reads: *"Deleting the underlying `data.file` silently breaks every
 *  dish pointing at it, and the orphan sweep eventually reclaims the bytes."*
 *  It names three possible fixes and defers the choice, because it "reaches past
 *  dishes and deserves its own evidence".
 *
 *  ⛔ **The evidence says that chain is already broken at every link.** Nothing
 *  automatic removes a `data.file` record, so a dish-held ref cannot dangle on
 *  its own — and the CAS keepset covers file bodies, so the bytes are not
 *  reclaimed either.
 *
 *  ⚠⚠ **But that safety is ACCIDENTAL, and this file is what makes it stated.**
 *  It rests on three unrelated choices — a retention constant, an evictability
 *  predicate, and one wiring line — and **not one of them mentions dishes**.
 *  Any of the three could be changed for a good local reason by someone who has
 *  never heard of `config_overlay`, and the hole re-opens silently. D-215 s5c
 *  widened the blast radius from one ref per dish to N.
 *
 *  🔑 So these are not shape checks. Each pins one link of the chain, and each
 *  failure message says what a dish loses if that link is changed. The
 *  CAS-lifecycle decision stays open — this makes it unavoidable rather than
 *  making it for someone.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import type { InboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { listCollectionReferencedBlobHashes } from '../storage/collection-blob-refs.js';
import { createGateRegistry } from '../storage-gates.js';
import { createRuntimeConfigStore, runtimeDefaults } from '@recued/config';
import { createBlobStore } from '../storage/blob-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: Database.Database;
let dir: string;
let files: InboundFileCollection;

beforeEach(async () => {
  db = new Database(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'd215-9e-'));
  const registry = createGateRegistry({
    config: createRuntimeConfigStore(runtimeDefaults()),
    initialUsage: {
      vault: 0, account_store: 0, shared_store: 0, cache: 0, audit: 0, schedules: 0,
    },
  });
  const gate = registry.register('collection:file:received', {
    quota: 512 * 1024 * 1024, reservePct: 10, initialUsage: 0,
  });
  files = createInboundFileCollection({
    db,
    blobs: createBlobStore(join(dir, 'blobs')),
    gate,
    bus: { emit: () => {} } as never,
    slug: 'received',
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ingest = async (): Promise<string> => {
  const rec = await files.ingest({
    bytes: Buffer.from('a dish points at these bytes'),
    filename: 'poster.png',
    mime_type: 'image/png',
    origin: 'reception_drop',
    source_id: 'dish-held-1',
  });
  return rec.record_id;
};

describe('D-215 § 9e (e) — link 1: age retention never prunes a file record', () => {
  it('⛔ file retention is DISABLED, and a dish depends on that', () => {
    // A dish scheduled for next month holds a file uploaded today. Turning on
    // age retention here — a reasonable-looking reclaim for a full disk —
    // deletes that file out from under every dish pointing at it, and the dish
    // only discovers it at fire time.
    const result = files.runRetention();
    return Promise.resolve(result).then((r) => {
      expect(
        r.skipped_reason,
        'file retention is what keeps a dish-held file_ref resolvable — enabling it needs the dish-holder question answered first (D-215 § 9e item (e))',
      ).toBe('retention_disabled');
    });
  });
});

describe('D-215 § 9e (e) — link 2: pressure never evicts a file surface', () => {
  it('⛔ a file collection reports not_evictable under pressure', async () => {
    // The comment in `eviction-cascade.ts` justifies this as "the user owns the
    // filesystem". True — and it is ALSO the only thing stopping a full-disk
    // cascade from reclaiming the file a queued post is waiting to publish.
    const { createEvictionCascade } = await import('../eviction-cascade.js');
    const registry = createGateRegistry({
      config: createRuntimeConfigStore(runtimeDefaults()),
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0, cache: 0, audit: 0, schedules: 0,
      },
    });
    registry.register('collection:file:received', {
      quota: 1024, reservePct: 10, initialUsage: 0,
    });
    const cascade = createEvictionCascade({
      registry,
      state: { get: () => null, set: () => {} } as never,
      auditLog: { logActivity: async () => {} } as never,
      config: () => ({
        debounce_window_s: 0, growth_bypass_pct: 10,
        cache_evict_max_entries: 10, orphan_sweep_max_blobs: 10,
      }),
    } as never);

    const r = await cascade.reclaim('collection:file:received');
    expect(
      r.reason_if_skipped,
      'if a file surface becomes evictable, every dish-held file_ref becomes reclaimable — see D-215 § 9e item (e)',
    ).toBe('not_evictable');
    cascade.close();
  });
});

describe('D-215 § 9e (e) — link 3: the CAS keepset covers file bodies', () => {
  it('⛔ a live file record keeps its blob out of every orphan sweep', async () => {
    // The dish holds a record id; the record holds a blob hash. Both have to
    // survive. This is the half that keeps the BYTES — and it works by scanning
    // every `collection_*` table with a `blob_hash` column, so it covers file
    // records without naming them.
    const record_id = await ingest();
    const rec = files.get(record_id)!;
    const hash = (rec.storage_ref as { blob_hash?: string }).blob_hash;
    expect(hash, 'a CAS-backed file record must carry a blob hash').toBeTruthy();

    const keep = listCollectionReferencedBlobHashes(db);
    expect(
      keep.has(hash!),
      'the cascade keepset is what stops an orphan sweep reclaiming the bytes a dish is holding (D-215 § 9e item (e))',
    ).toBe(true);
  });
});

describe('D-215 § 9e (e) — the record itself survives', () => {
  it('⛔ nothing in the collection removes a record on its own', async () => {
    // The three links above are about automatic reclaim. This is the direct
    // statement: a record ingested today is still resolvable after retention
    // has run, which is what makes "render it honestly" (the shipped half of
    // item (e)) sufficient rather than a fig leaf.
    const record_id = await ingest();
    await files.runRetention();
    expect(
      files.get(record_id),
      'a dish-held file_ref must still resolve after a retention pass',
    ).not.toBeNull();
  });
});
