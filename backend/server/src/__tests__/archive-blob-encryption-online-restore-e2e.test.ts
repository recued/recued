/* Archive blob-encryption fix — ONLINE restore E2E (encrypted blobs).
 *
 * The offline `applyRestore` path was proven with encrypted blobs (Phase 3);
 * the ONLINE `server.archive.import` restart-swap path (`stageRestore` →
 * drain → `commitStagedRestore`) was only ever driven with db-ONLY archives
 * (`archive-rpc-import.test.ts`, every case `includeBlobs:false`). This closes
 * that gap: it drives the REAL `createArchiveRuntime` + a REAL enrolled
 * `KeyManager` through the full online cycle on an ENCRYPTED (D-197) server —
 *   runExport(includeBlobs) [decrypts cache/memory blobs via the live keys]
 *     → runImport [stages beside, overlays + re-encrypts]
 *     → captured onDrained(true) [commitStagedRestore rename-swap]
 * — and proves the rebooted db + its re-encrypted cache/memory blobs are
 * intact under the restored realm's key. The restart drain + supervisor exit
 * are injected as a spy (nothing drains/exits the process), exactly as the
 * sibling online-runtime suite does. See docs/archive-blob-encryption-fix.md
 * (deferred #2). No mocks below the runtime — real sqlite, crypto, blob-store. */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { generateRecoveryKey, generateServerKey } from '@recued/crypto';

import { createKeyManager, type KeyManager } from '../key-manager.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { createArchiveRuntime } from '../archive/archive-runtime.js';
import { createBlobStore } from '../storage/blob-store.js';

const SERVER_VERSION = '0.2.0';
const FIXED_NOW = 1_700_000_000_000;

const dirs: string[] = [];
const newDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

const pathFor = (root: string, hash: string): string =>
  join(root, 'objects', hash.slice(0, 2), `${hash.slice(2)}.bin`);

const stagedFiles = (dir: string): string[] =>
  readdirSync(dir).filter(
    (f) => f.startsWith('recued-server.db.staging') && !f.endsWith('-wal') && !f.endsWith('-shm'),
  );

interface Harness {
  dir: string;
  dbPath: string;
  db: Database.Database;
  km: KeyManager;
  blobKey: Buffer;
  mnemonic: string;
  runtime: ReturnType<typeof createArchiveRuntime>;
  cachePlaintext: Buffer; cacheHash: string;
  memoryPlaintext: Buffer; memoryHash: string;
  sharedPlaintext: Buffer; sharedHash: string;
  restartCount(): number;
  takeOnDrained(): (drainOk: boolean) => Promise<void>;
}

/** A running ENCRYPTED server: db enrolled with a server vault bundle (via a
 *  real KeyManager persisting into the db's server_config), encrypted
 *  cache/memory blobs + a keyless shared blob on disk, and the concrete archive
 *  runtime wired with `getKeys` (live decrypt-on-export) + a spied restart. */
const newEncryptedServer = async (): Promise<Harness> => {
  const { mnemonic } = generateRecoveryKey();
  const dir = newDir('online-enc-');
  const dbPath = join(dir, 'recued-server.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Real KeyManager enrolled first-boot; its server bundle persists into the
  // db's server_config (so the archived db carries it → restore re-derives the
  // same blob key). blobKey = keyProvider('blob-store') = the at-rest key.
  const bundleStore = createServerBundleStore(db);
  const km = createKeyManager({
    loadBundle: () => null,
    saveBundle: () => { /* password bundle unused on a server-vault realm */ },
    loadServerBundle: () => bundleStore.load(),
    saveServerBundle: (b) => bundleStore.save(b),
  });
  await km.initServerVault({ recoveryKey: mnemonic, serverKey: generateServerKey() });
  const rawBlobKey = km.keyProvider('blob-store')();
  if (!rawBlobKey) throw new Error('blob-store key unexpectedly null after enrollment');
  const blobKey = Buffer.from(rawBlobKey); // stable copy for on-disk enc + verify

  // A marker table to prove the db SWAP, plus the blob-ref tables the export
  // scans (cache_entries → cache_blobs, user_memory → memory_blobs, shared_store
  // → keyless blobs).
  db.exec(`
    CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE cache_entries (key TEXT PRIMARY KEY, blob_hash TEXT);
    CREATE TABLE user_memory (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE shared_store (key TEXT PRIMARY KEY, blob_hash TEXT);
  `);
  db.prepare('INSERT INTO example VALUES (?, ?)').run('hello', 'world');

  const cachePlaintext = randomBytes(80_000); // > 64 KB → multi-chunk stream
  const memoryPlaintext = randomBytes(70_000);
  const sharedPlaintext = randomBytes(3_000);
  const cacheHash = await createBlobStore(join(dir, 'cache_blobs'), { getEncryptionKey: () => blobKey }).put(cachePlaintext);
  const memoryHash = await createBlobStore(join(dir, 'memory_blobs'), { getEncryptionKey: () => blobKey }).put(memoryPlaintext);
  const sharedHash = await createBlobStore(join(dir, 'blobs')).put(sharedPlaintext);
  db.prepare('INSERT INTO cache_entries (key, blob_hash) VALUES (?, ?)').run('c1', cacheHash);
  db.prepare('INSERT INTO user_memory (key, data) VALUES (?, ?)').run('m1', JSON.stringify({ blob_hash: memoryHash }));
  db.prepare('INSERT INTO shared_store (key, blob_hash) VALUES (?, ?)').run('s1', sharedHash);

  let onDrained: ((drainOk: boolean) => Promise<void>) | null = null;
  let restarts = 0;
  const runtime = createArchiveRuntime({
    db,
    dbPath,
    dataPath: dir,
    configPath: null,
    serverVersion: SERVER_VERSION,
    now: () => FIXED_NOW,
    getKeys: () => km, // live decrypt-on-export
    requestRestart: (cb) => { restarts += 1; onDrained = cb; },
  });

  return {
    dir, dbPath, db, km, blobKey, mnemonic, runtime,
    cachePlaintext, cacheHash, memoryPlaintext, memoryHash, sharedPlaintext, sharedHash,
    restartCount: () => restarts,
    takeOnDrained: () => {
      if (!onDrained) throw new Error('no restart callback captured');
      return onDrained;
    },
  };
};

describe('online archive restore E2E — ENCRYPTED blobs through the restart-swap', () => {
  it('runExport(blobs) → runImport → drain-commit swap re-encrypts cache + memory blobs under the restored realm key', async () => {
    const s = await newEncryptedServer();

    // Export via the ONLINE runtime — decrypts the encrypted cache/memory blobs
    // to plaintext in the archive using the live KeyManager (getKeys).
    const { path } = await s.runtime.runExport({ includeBlobs: true, includePassport: false, recoveryKey: s.mnemonic });
    expect(existsSync(path)).toBe(true);

    // Prove the restore actually does the work: mutate the live db AND wipe the
    // on-disk blobs. The swap must bring back the archived db (1 row, no 'foo'),
    // and the overlay must re-create + re-encrypt the blobs.
    s.db.prepare('INSERT INTO example VALUES (?, ?)').run('foo', 'bar');
    for (const [root, hash] of [['cache_blobs', s.cacheHash], ['memory_blobs', s.memoryHash], ['blobs', s.sharedHash]] as const) {
      unlinkSync(pathFor(join(s.dir, root), hash));
    }
    expect(existsSync(pathFor(join(s.dir, 'cache_blobs'), s.cacheHash))).toBe(false);

    // Import: stages the db beside the live one + overlays (re-creates) the blobs
    // into the live CAS, re-encrypting the cache/memory ones under the key
    // re-derived from the archive's own server bundle + the recovery key.
    const res = await s.runtime.runImport({ path, force: false, recoveryKey: s.mnemonic });
    expect(res.restored_at).toBe(FIXED_NOW);
    expect(res.manifest.includes_blobs).toBe(true);
    expect(s.restartCount()).toBe(1);
    expect(stagedFiles(s.dir)).toHaveLength(1);

    // Blobs were overlaid into the LIVE CAS during staging (before the swap).
    expect(existsSync(pathFor(join(s.dir, 'cache_blobs'), s.cacheHash))).toBe(true);
    expect(existsSync(pathFor(join(s.dir, 'memory_blobs'), s.memoryHash))).toBe(true);

    // Commit: simulate the drain's close_db, then run the captured swap clean.
    s.km.lock();
    s.db.close();
    await s.takeOnDrained()(true);

    // The db is now the archived snapshot (1 row 'hello', no 'foo') → swap landed.
    const restored = new Database(s.dbPath, { readonly: true });
    try {
      expect((restored.prepare('SELECT COUNT(*) AS n FROM example').get() as { n: number }).n).toBe(1);
      expect((restored.prepare("SELECT v FROM example WHERE k = 'hello'").get() as { v: string }).v).toBe('world');
      expect(restored.prepare("SELECT v FROM example WHERE k = 'foo'").get()).toBeUndefined();
    } finally { restored.close(); }

    // The re-encrypted cache + memory blobs decrypt (under the restored realm's
    // blob key) back to the originals AND are genuinely ciphertext at rest.
    const tgtCache = createBlobStore(join(s.dir, 'cache_blobs'), { getEncryptionKey: () => s.blobKey });
    expect((await tgtCache.get(s.cacheHash))!.equals(s.cachePlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(s.dir, 'cache_blobs'), s.cacheHash)).equals(s.cachePlaintext)).toBe(false);

    const tgtMemory = createBlobStore(join(s.dir, 'memory_blobs'), { getEncryptionKey: () => s.blobKey });
    expect((await tgtMemory.get(s.memoryHash))!.equals(s.memoryPlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(s.dir, 'memory_blobs'), s.memoryHash)).equals(s.memoryPlaintext)).toBe(false);
    expect(await tgtCache.has(s.memoryHash)).toBe(false); // routed to memory_blobs, not cache_blobs

    // The keyless shared blob round-trips as plaintext in the keyless root.
    const tgtShared = createBlobStore(join(s.dir, 'blobs'));
    expect((await tgtShared.get(s.sharedHash))!.equals(s.sharedPlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(s.dir, 'blobs'), s.sharedHash)).equals(s.sharedPlaintext)).toBe(true);

    // Staging consumed; the prior db was backed up (rollback safety net).
    expect(stagedFiles(s.dir)).toHaveLength(0);
    expect(readdirSync(s.dir).some((f) => f.startsWith('recued-server.db.bak-'))).toBe(true);
  });

  it('an aborted drain (drainOk=false) abandons the staged restore — live db + blobs untouched', async () => {
    const s = await newEncryptedServer();
    const { path } = await s.runtime.runExport({ includeBlobs: true, includePassport: false, recoveryKey: s.mnemonic });
    s.db.prepare('INSERT INTO example VALUES (?, ?)').run('foo', 'bar'); // live db → 2 rows

    const res = await s.runtime.runImport({ path, force: false, recoveryKey: s.mnemonic });
    expect(res.restored_at).toBe(FIXED_NOW);
    expect(stagedFiles(s.dir)).toHaveLength(1);

    // Drain timed out / aborted → abandon the staged restore, keep the live db.
    await s.takeOnDrained()(false);

    expect(stagedFiles(s.dir)).toHaveLength(0);
    expect((s.db.prepare('SELECT COUNT(*) AS n FROM example').get() as { n: number }).n).toBe(2); // live db intact
    expect(readdirSync(s.dir).some((f) => f.startsWith('recued-server.db.bak-'))).toBe(false); // never swapped
    // The live encrypted cache blob is still readable (untouched by the abandon).
    const liveCache = createBlobStore(join(s.dir, 'cache_blobs'), { getEncryptionKey: () => s.blobKey });
    expect((await liveCache.get(s.cacheHash))!.equals(s.cachePlaintext)).toBe(true);
    s.db.close();
  });
});
