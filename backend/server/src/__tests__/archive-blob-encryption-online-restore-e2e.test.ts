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
 * sibling online-runtime suite does. See internal design notes
 * (deferred #2). No mocks below the runtime — real sqlite, crypto, blob-store. */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createBundle, createServerBundle, generateRecoveryKey, generateServerKey } from '@recued/crypto';

import { createKeyManager, type KeyManager } from '../key-manager.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { createBundleStore } from '../bundle-store.js';
import { createArchiveRuntime, composeArchiveRpcDeps } from '../archive/archive-runtime.js';
import { createEncryptedBlobStore } from '../storage/blob-store.js';
import { openDatabase, rekeyDatabase } from '../open-database.js';
import type { Lifecycle } from '../lifecycle/index.js';

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
  databaseKey: Buffer;
  mnemonic: string;
  runtime: ReturnType<typeof createArchiveRuntime>;
  cachePlaintext: Buffer; cacheHash: string;
  memoryPlaintext: Buffer; memoryHash: string;
  sharedPlaintext: Buffer; sharedHash: string;
  restartCount(): number;
  takeOnDrained(): (drainOk: boolean) => Promise<void>;
}

/** A running ENCRYPTED server: db-adjacent sidecar enrolled with a server vault
 *  bundle via a real KeyManager, encrypted
 *  cache/memory/shared blobs on disk, and the concrete archive
 *  runtime wired with `getKeys` (live decrypt-on-export) + a spied restart. */
const newEncryptedServer = async (): Promise<Harness> => {
  const { mnemonic } = generateRecoveryKey();
  const dir = newDir('online-enc-');
  const dbPath = join(dir, 'recued-server.db');
  const db = await openDatabase(dbPath, { databaseKey: null });
  db.pragma('journal_mode = WAL');

  // Real KeyManager enrolled first-boot; its server bundle persists in the
  // D-212 sidecar (which the archive carries as its own record). blobKey =
  // keyProvider('blob-store') = the at-rest key.
  const bundleStore = createServerBundleStore(dbPath);
  const km = createKeyManager({
    loadBundle: () => null,
    saveBundle: () => { /* password bundle unused on a server-vault realm */ },
    loadServerBundle: () => bundleStore.load(),
    saveServerBundle: (b) => bundleStore.save(b),
  });
  await km.initServerVault({ recoveryKey: mnemonic, serverKey: generateServerKey() });
  const databaseKey = Buffer.from(km.getSubDEK('database'));
  rekeyDatabase(db, databaseKey);
  const rawBlobKey = km.keyProvider('blob-store')();
  if (!rawBlobKey) throw new Error('blob-store key unexpectedly null after enrollment');
  const blobKey = Buffer.from(rawBlobKey); // stable copy for on-disk enc + verify

  // A marker table to prove the db SWAP, plus the blob-ref tables the export
  // scans (cache_entries → cache_blobs, user_memory → memory_blobs, shared_store
  // → the encrypted shared blobs root).
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
  const cacheHash = await createEncryptedBlobStore(join(dir, 'cache_blobs'), () => blobKey).put(cachePlaintext);
  const memoryHash = await createEncryptedBlobStore(join(dir, 'memory_blobs'), () => blobKey).put(memoryPlaintext);
  const sharedHash = await createEncryptedBlobStore(join(dir, 'blobs'), () => blobKey).put(sharedPlaintext);
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
    dir, dbPath, db, km, blobKey, databaseKey, mnemonic, runtime,
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
    const restored = await openDatabase(s.dbPath, {
      readonly: true,
      fileMustExist: true,
      keyEnvironment: {},
    });
    try {
      expect((restored.prepare('SELECT COUNT(*) AS n FROM example').get() as { n: number }).n).toBe(1);
      expect((restored.prepare("SELECT v FROM example WHERE k = 'hello'").get() as { v: string }).v).toBe('world');
      expect(restored.prepare("SELECT v FROM example WHERE k = 'foo'").get()).toBeUndefined();
    } finally { restored.close(); }

    // The re-encrypted cache + memory blobs decrypt (under the restored realm's
    // blob key) back to the originals AND are genuinely ciphertext at rest.
    const tgtCache = createEncryptedBlobStore(join(s.dir, 'cache_blobs'), () => s.blobKey);
    expect((await tgtCache.get(s.cacheHash))!.equals(s.cachePlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(s.dir, 'cache_blobs'), s.cacheHash)).equals(s.cachePlaintext)).toBe(false);

    const tgtMemory = createEncryptedBlobStore(join(s.dir, 'memory_blobs'), () => s.blobKey);
    expect((await tgtMemory.get(s.memoryHash))!.equals(s.memoryPlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(s.dir, 'memory_blobs'), s.memoryHash)).equals(s.memoryPlaintext)).toBe(false);
    expect(await tgtCache.has(s.memoryHash)).toBe(false); // routed to memory_blobs, not cache_blobs

    // The shared blob round-trips encrypted in the historical `blobs` root.
    const tgtShared = createEncryptedBlobStore(join(s.dir, 'blobs'), () => s.blobKey);
    expect((await tgtShared.get(s.sharedHash))!.equals(s.sharedPlaintext)).toBe(true);
    expect(readFileSync(pathFor(join(s.dir, 'blobs'), s.sharedHash)).equals(s.sharedPlaintext)).toBe(false);

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
    const liveCache = createEncryptedBlobStore(join(s.dir, 'cache_blobs'), () => s.blobKey);
    expect((await liveCache.get(s.cacheHash))!.equals(s.cachePlaintext)).toBe(true);
    s.db.close();
  });
});

describe('online export refuses a key that cannot restore the backup', () => {
  /** The rpc layer validates BIP39 well-formedness only, and this path —
   *  unlike the CLI, which must derive the database key to open the db at
   *  all — reuses the already-open boot handle. A different-but-valid
   *  mnemonic therefore sealed the outer archive under key B while the
   *  embedded database and bundle still needed key A. Every restore route
   *  fails closed on it, so no data was lost; what was lost is the truth of
   *  the success message, and the only signal arrived at disaster-recovery
   *  time. */
  it('a valid mnemonic that is not THIS realm\'s is rejected at export', async () => {
    const s = await newEncryptedServer();
    let stranger = generateRecoveryKey().mnemonic;
    while (stranger === s.mnemonic) stranger = generateRecoveryKey().mnemonic;

    await expect(
      s.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: stranger }),
    ).rejects.toThrow(/does not open this server's vault/);

    // …and nothing was written: a refused export leaves no half-archive.
    expect(readdirSync(s.dir).filter((f) => f.endsWith('.recued-archive'))).toEqual([]);
  });

  it('the realm\'s own key still exports', async () => {
    const s = await newEncryptedServer();
    const { path } = await s.runtime.runExport({
      includeBlobs: false, includePassport: false, recoveryKey: s.mnemonic,
    });
    expect(existsSync(path)).toBe(true);
  });

  it('an encrypted realm whose bundle sidecar vanished refuses to export', async () => {
    const s = await newEncryptedServer();
    // Keys stay in RAM, so the server keeps running — but the archive would
    // carry an encrypted database and nothing able to open it.
    unlinkSync(createServerBundleStore(s.dbPath).path);

    await expect(
      s.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: s.mnemonic }),
    ).rejects.toThrow(/vault bundle sidecar is\s+missing/);
  });

  // ⛔ The mnemonic→sidecar check alone is not enough. The live db was opened at
  // boot under bundle A; a sidecar that has DRIFTED to a different valid bundle
  // B (same mnemonic, different Master DEK) still unwraps under the mnemonic, so
  // the old check passes — but its derived key cannot open the database bytes
  // the export snapshots, and restore (which derives from the embedded sidecar)
  // gets an unrestorable archive. Export must prove the sidecar opens the LIVE
  // DB, not just itself.
  it('refuses to export when the sidecar has drifted from the live database', async () => {
    const s = await newEncryptedServer();
    // A different valid bundle under the SAME recovery phrase: `createServerBundle`
    // mints a fresh Master DEK, so B unwraps under s.mnemonic yet keys a
    // different database than the running one (still under A).
    const driftedB = await createServerBundle({
      recoveryKey: s.mnemonic,
      serverKey: generateServerKey(),
    });
    driftedB.masterDEK.fill(0);
    createServerBundleStore(s.dbPath).save(driftedB.bundle);

    await expect(
      s.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: s.mnemonic }),
    ).rejects.toThrow(/no longer opens the running database/);

    // Refused before writing: no half-archive left behind.
    expect(readdirSync(s.dir).filter((f) => f.endsWith('.recued-archive'))).toEqual([]);
  });

  /** The refusal above must read the DATABASE, not the vault. A realm carrying
   *  only the legacy D-081 password bundle — a row inside SQLite, a different
   *  artifact from the D-212 sidecar — puts the KeyManager in `locked`, and
   *  keying the refusal off that state refused every export on a realm whose
   *  database is plain and whose backup would have restored perfectly, telling
   *  the operator to go find a sidecar that had never existed. The offline CLI
   *  exports the same realm without complaint; the two doors have to agree. */
  it('a plaintext realm with only a legacy password bundle still exports', async () => {
    const { mnemonic } = generateRecoveryKey();
    const dir = newDir('online-legacy-');
    const dbPath = join(dir, 'recued-server.db');
    const db = await openDatabase(dbPath, { databaseKey: null });
    db.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO example VALUES (?, ?)').run('hello', 'world');

    // The legacy bundle lives in `server_config`; no D-212 sidecar is written,
    // so the database on disk stays plain. Cheap Argon2 — this is about which
    // signal the probe reads, not about the KDF.
    const { bundle } = await createBundle({ password: 'pw', argon2: { t: 1, m: 8, p: 1 } });
    createBundleStore(db).save(bundle);
    const km = createKeyManager({
      loadBundle: () => createBundleStore(db).load(),
      saveBundle: (b) => createBundleStore(db).save(b),
    });
    expect(km.state()).toBe('locked'); // the signal the old probe trusted
    expect(createServerBundleStore(dbPath).exists()).toBe(false);

    const runtime = createArchiveRuntime({
      db, dbPath, dataPath: dir, configPath: null,
      serverVersion: SERVER_VERSION, now: () => FIXED_NOW,
      getKeys: () => km,
      requestRestart: () => { /* no restart in an export test */ },
    });

    const res = await runtime.runExport({
      includeBlobs: false, includePassport: false, recoveryKey: mnemonic,
    });
    expect(existsSync(res.path)).toBe(true);
    expect(res.bytes_written).toBeGreaterThan(0);
    db.close();
  });
});

describe('cross-realm restore does not corrupt the live realm on abort', () => {
  /** A CAS path is the PLAINTEXT hash, so identical content in two realms
   *  collides. Slice 4 made every production root keyed, which turned that
   *  collision destructive: the overlay rewrites the live object under the
   *  ARCHIVE's key, and if the drain then aborts, the OLD database survives
   *  still referencing an object only the foreign key opens.
   *
   *  The existing aborted-drain case cannot see this — it exports and imports
   *  with the SAME mnemonic, so the overwrite is same-key and harmless. Only a
   *  cross-realm pair exposes it. */
  it('an aborted drain leaves a collided blob readable under the LIVE realm key', async () => {
    const source = await newEncryptedServer();
    const target = await newEncryptedServer();

    // The same plaintext in both realms — the collision. Its CAS path is
    // identical; its ciphertext is not, because the realm keys differ.
    const shared = Buffer.from('the same bytes live in both realms');
    const hash = await createEncryptedBlobStore(join(source.dir, 'blobs'), () => source.blobKey).put(shared);
    const targetHash = await createEncryptedBlobStore(join(target.dir, 'blobs'), () => target.blobKey).put(shared);
    expect(targetHash).toBe(hash);
    source.db.prepare('INSERT INTO shared_store (key, blob_hash) VALUES (?, ?)').run('collide', hash);
    target.db.prepare('INSERT INTO shared_store (key, blob_hash) VALUES (?, ?)').run('collide', hash);

    const { path } = await source.runtime.runExport({
      includeBlobs: true, includePassport: false, recoveryKey: source.mnemonic,
    });

    // Restore the SOURCE realm's archive onto the TARGET server, then abort
    // the drain — the supported cross-realm flow, failing partway.
    await target.runtime.runImport({ path, force: false, recoveryKey: source.mnemonic });
    expect(target.restartCount()).toBe(1);
    await target.takeOnDrained()(false);

    // The target's database was never swapped, so it still references `hash`.
    // That object must still open under the TARGET's key, not the source's.
    const live = createEncryptedBlobStore(join(target.dir, 'blobs'), () => target.blobKey);
    expect((await live.get(hash))!.equals(shared)).toBe(true);

    // And no parked copy is left lying around once the discard has run.
    const objectsDir = join(target.dir, 'blobs', 'objects', hash.slice(0, 2));
    expect(readdirSync(objectsDir).filter((f) => f.includes('.pre-restore-'))).toEqual([]);
  });

  /** The same corruption, reached by the other door. `composeArchiveRpcDeps`
   *  wires the drain, and the abandon path hangs off the drain RESOLVING with
   *  a bad result — so a drain that REJECTS skipped it entirely and exited
   *  straight to the supervisor, which then rebooted on the original database
   *  over the archive realm's ciphertext. Not hypothetical: `requestDrain`
   *  writes its clean-shutdown marker around the drain, and doing that after
   *  `close_db` threw on the closed connection and aborted a restore commit. */
  it('a REJECTED drain still rolls the displaced blob back', async () => {
    const source = await newEncryptedServer();
    const target = await newEncryptedServer();

    const shared = Buffer.from('the same bytes live in both realms');
    const hash = await createEncryptedBlobStore(join(source.dir, 'blobs'), () => source.blobKey).put(shared);
    await createEncryptedBlobStore(join(target.dir, 'blobs'), () => target.blobKey).put(shared);
    source.db.prepare('INSERT INTO shared_store (key, blob_hash) VALUES (?, ?)').run('collide', hash);
    target.db.prepare('INSERT INTO shared_store (key, blob_hash) VALUES (?, ?)').run('collide', hash);

    const { path } = await source.runtime.runExport({
      includeBlobs: true, includePassport: false, recoveryKey: source.mnemonic,
    });

    // Compose the target's deps for real — the defect lives in the promise
    // chain that `composeArchiveRpcDeps` builds, not in the runtime it wraps.
    let exitCode: number | undefined;
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => { markExited = resolve; });
    const drainRejection = new Error('drain rejected: attempted a write on a closed database');
    const deps = composeArchiveRpcDeps({
      db: target.db,
      dbPath: target.dbPath,
      configPath: null,
      serverVersion: SERVER_VERSION,
      now: () => FIXED_NOW,
      getKeys: () => target.km,
      lifecycle: {
        requestDrain: () => Promise.reject(drainRejection),
        supervisor: { handoff: () => 0 },
      } as unknown as Lifecycle,
      exit: (code) => { exitCode = code; markExited(); },
    });
    if (!deps) throw new Error('archive deps did not compose');

    await deps.runtime.runImport({ path, force: false, recoveryKey: source.mnemonic });
    await exited;

    // The process still goes down — the point is what it leaves behind. The
    // target's database was never swapped, so it still references `hash`; that
    // object must open under the TARGET's key, not the source's.
    expect(exitCode).toBe(1);
    const live = createEncryptedBlobStore(join(target.dir, 'blobs'), () => target.blobKey);
    expect((await live.get(hash))!.equals(shared)).toBe(true);

    const objectsDir = join(target.dir, 'blobs', 'objects', hash.slice(0, 2));
    expect(readdirSync(objectsDir).filter((f) => f.includes('.pre-restore-'))).toEqual([]);
    expect(stagedFiles(target.dir)).toHaveLength(0);
  });
});
