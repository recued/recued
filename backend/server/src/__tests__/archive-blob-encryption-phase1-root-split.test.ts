/* Archive blob-encryption fix — Phase 1 (posture-split CAS roots).
 *
 * Proves the two storage bugs Phase 1 closes, through the REAL blob-store +
 * eviction-cascade (not mocks — the sweep either deletes a file or it doesn't):
 *
 *   Bug 2 [data loss]: the eviction sweep must keep EVERY writer of a root, not
 *     just cache/shared. Collections share the encrypted `cache_blobs` root and
 *     annotations share the keyless `blobs` root, so their live refs now join
 *     the respective keepsets — a sweep can no longer reap a live collection or
 *     annotation body.
 *   Bug 3 [collision]: identical plaintext written by an ENCRYPTED store
 *     (cache/collection) and a KEYLESS store (shared/annotation) used to collide
 *     on one path (hash-on-plaintext) so the second reader got the wrong on-disk
 *     format. Split roots → two independent files, each read in its own posture.
 *
 * See internal design notes. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createRuntimeConfigStore,
  runtimeDefaults,
} from '@recued/config';
import {
  createInMemoryStore,
  type CacheStore,
} from '@recued/cache';
import {
  createAuditLogStore,
  type AuditEntry,
  type ActivityEntry,
  type AuditLogStore,
} from '@recued/storage';

import { createSQLiteCollection } from '../sqlite-collection.js';
import { createGateRegistry, type GateRegistry } from '../storage-gates.js';
import { createPressureStateStore, type PressureStateStore } from '../pressure-state.js';
import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import {
  createEvictionCascade,
  DEFAULT_CASCADE_CONFIG,
  type EvictionCascade,
  type EvictionCascadeDeps,
} from '../eviction-cascade.js';

describe('blob-encryption Phase 1 — posture-split CAS roots', () => {
  let dir: string;
  let db: Database.Database;
  let registry: GateRegistry;
  let state: PressureStateStore;
  let auditLog: AuditLogStore;
  let cache: CacheStore;
  let cacheBlobs: BlobStore; // ENCRYPTED — cache + collection bodies
  let sharedBlobs: BlobStore; // KEYLESS — shared + annotation bodies
  const key = randomBytes(32);
  const open: EvictionCascade[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'blob-split-'));
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS server_vault (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_store (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_store (key TEXT PRIMARY KEY, value_inline TEXT, blob_hash TEXT, size_bytes INTEGER NOT NULL, author_id TEXT NOT NULL, recipe_id TEXT, written_at INTEGER NOT NULL, last_read_at INTEGER);
      CREATE TABLE IF NOT EXISTS cache_entries (key TEXT PRIMARY KEY, inline_value TEXT, blob_hash TEXT, expires_at INTEGER NOT NULL, recipe_id TEXT NOT NULL, ingredient_slug TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL, category TEXT, risk_tier TEXT);
      CREATE TABLE IF NOT EXISTS schedules (schedule_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, data TEXT NOT NULL);
    `);
    state = createPressureStateStore(db);
    auditLog = createAuditLogStore(
      createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
      createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
    );
    registry = createGateRegistry({
      config: createRuntimeConfigStore(runtimeDefaults()),
      initialUsage: {
        vault: 0, account_store: 0, shared_store: 0,
        cache: 0, audit: 0, schedules: 0,
      },
    });
    cache = createInMemoryStore({
      onBytesChanged: (d) => registry.cache.addUsed(d),
    });
    // The two posture-split roots — the encryption key provider MUST be
    // synchronous (an async provider yields a Promise → "key must be 32 bytes").
    cacheBlobs = createBlobStore(join(dir, 'cache_blobs'), {
      getEncryptionKey: () => key,
    });
    sharedBlobs = createBlobStore(join(dir, 'blobs'));
  });

  afterEach(() => {
    for (const c of open) c.close();
    open.length = 0;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const mkCascade = (extra: Partial<EvictionCascadeDeps>): EvictionCascade => {
    const cascade = createEvictionCascade({
      registry,
      state,
      auditLog,
      cache,
      config: () => DEFAULT_CASCADE_CONFIG,
      db,
      ...extra,
    });
    open.push(cascade);
    return cascade;
  };

  const pressure = (surface: 'cache' | 'shared_store'): void => {
    const gate = registry.get(surface)!;
    gate.setUsed(gate.info().pressureAt + 1);
  };

  it('bug 2 — a cache-root sweep KEEPS live collection blobs (keepset = cache ∪ collection)', async () => {
    const cacheHash = await cacheBlobs.put(randomBytes(2048));
    const collectionHash = await cacheBlobs.put(randomBytes(2048));
    const orphanHash = await cacheBlobs.put(randomBytes(2048));

    const cascade = mkCascade({
      cacheBlobs,
      cacheBlobRefs: () => new Set([cacheHash]),
      collectionBlobRefs: () => new Set([collectionHash]),
    });
    pressure('cache');
    const r = await cascade.reclaim('cache', { force: true });

    expect(r.ran).toBe(true);
    expect(await cacheBlobs.has(cacheHash)).toBe(true); // referenced cache row — kept
    expect(await cacheBlobs.has(collectionHash)).toBe(true); // live collection body — kept (the fix)
    expect(await cacheBlobs.has(orphanHash)).toBe(false); // truly unreferenced — swept
  });

  it('bug 2 — the collection ref reader is LOAD-BEARING (omitting it reaps the live body)', async () => {
    // Counterfactual: the SAME collection blob, but no collectionBlobRefs wired
    // (the pre-fix keepset). It must be reaped — proving the reader is what
    // protects live collection bodies, not some other guard.
    const cacheHash = await cacheBlobs.put(randomBytes(2048));
    const collectionHash = await cacheBlobs.put(randomBytes(2048));

    const cascade = mkCascade({
      cacheBlobs,
      cacheBlobRefs: () => new Set([cacheHash]),
      // collectionBlobRefs deliberately absent
    });
    pressure('cache');
    await cascade.reclaim('cache', { force: true });

    expect(await cacheBlobs.has(cacheHash)).toBe(true);
    expect(await cacheBlobs.has(collectionHash)).toBe(false); // reaped without the reader
  });

  it('bug 2 — a shared_store sweep KEEPS live annotation blobs (keepset = shared ∪ annotation)', async () => {
    const sharedHash = await sharedBlobs.put(randomBytes(2048));
    const annotationHash = await sharedBlobs.put(randomBytes(2048));
    const orphanHash = await sharedBlobs.put(randomBytes(2048));

    const cascade = mkCascade({
      sharedBlobs,
      sharedBlobRefs: () => new Set([sharedHash]),
      annotationBlobRefs: () => new Set([annotationHash]),
    });
    pressure('shared_store');
    const r = await cascade.reclaim('shared_store', { force: true });

    expect(r.ran).toBe(true);
    expect(await sharedBlobs.has(sharedHash)).toBe(true);
    expect(await sharedBlobs.has(annotationHash)).toBe(true); // live annotation body — kept (the fix)
    expect(await sharedBlobs.has(orphanHash)).toBe(false); // unreferenced — swept
  });

  it('cross-root isolation — a cache sweep never touches the keyless blobs root', async () => {
    // A keyless-root blob referenced by NOTHING in the cache keepset must still
    // survive a cache sweep: the cache surface sweeps only the cache_blobs root.
    const keylessHash = await sharedBlobs.put(randomBytes(2048));
    const cacheHash = await cacheBlobs.put(randomBytes(2048));

    const cascade = mkCascade({
      cacheBlobs,
      sharedBlobs,
      cacheBlobRefs: () => new Set([cacheHash]),
      collectionBlobRefs: () => new Set(),
      // sharedBlobRefs/annotationBlobRefs intentionally not consulted by a cache sweep
    });
    pressure('cache');
    await cascade.reclaim('cache', { force: true });

    expect(await sharedBlobs.has(keylessHash)).toBe(true); // untouched — different root
    expect(await cacheBlobs.has(cacheHash)).toBe(true);
  });

  it('bug 3 — identical plaintext coexists across the two roots, each read in its own posture', async () => {
    const plaintext = randomBytes(4096);
    const hEnc = await cacheBlobs.put(plaintext); // ciphertext at cache_blobs
    const hKeyless = await sharedBlobs.put(plaintext); // plaintext at blobs

    // Same content-address (hash is over plaintext in BOTH stores)…
    expect(hEnc).toBe(hKeyless);
    // …but two independent files, each decoded in its own posture.
    expect((await cacheBlobs.get(hEnc))!.equals(plaintext)).toBe(true); // decrypts
    expect((await sharedBlobs.get(hKeyless))!.equals(plaintext)).toBe(true); // raw

    // Independence: deleting one leaves the other intact (pre-split they shared
    // a single backing file, so the second reader got the wrong format).
    await cacheBlobs.delete(hEnc);
    expect(await cacheBlobs.has(hEnc)).toBe(false);
    expect(await sharedBlobs.has(hKeyless)).toBe(true);
    expect((await sharedBlobs.get(hKeyless))!.equals(plaintext)).toBe(true);
  });
});
