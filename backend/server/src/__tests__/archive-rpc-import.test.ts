/** Scope-B (D-108/D-109) — online `server.archive.*` runtime tests.
 *
 *  Exercises the concrete `createArchiveRuntime` against REAL sqlite +
 *  REAL export/import crypto (no mocks): the recovery-key-derived
 *  round-trip, the wire-manifest mapping, and the stage-beside-then-
 *  atomic-swap restore — staged live, then the captured restart `commit`
 *  performs the rename-swap (the drain's `close_db` is simulated by
 *  closing the live handle before the commit). Abort-safety + the
 *  `force` → allow-future-version mapping are covered too.
 *
 *  The restart drain + supervisor handoff are injected as a spy
 *  (`requestRestart`) so nothing actually drains or exits the process. */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { generateRecoveryKey } from '@recued/crypto';

import { createArchiveRuntime } from '../archive/archive-runtime.js';
import { exportArchive } from '../archive/archive-export.js';
import { EXPORT_TTL_MS } from '../archive/export-store.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { processRecoveryKey } from '../recovery-key-processor.js';

const SERVER_VERSION = '0.2.0';
const FIXED_NOW = 1_700_000_000_000;

interface Harness {
  dir: string;
  dbPath: string;
  db: Database.Database;
  mnemonic: string;
  entropy: Buffer;
  runtime: ReturnType<typeof createArchiveRuntime>;
  /** The most recent `onDrained(drainOk)` callback the runtime handed to
   *  `requestRestart`, plus how many times a restart was requested. Call
   *  it with `true` to simulate a clean drain (commit the swap) or `false`
   *  to simulate an aborted/timed-out drain (abandon the staged restore). */
  restartCount(): number;
  takeOnDrained(): (drainOk: boolean) => Promise<void>;
  close(): void;
}

const rowCount = (db: Database.Database): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM example').get() as { n: number }).n;

/** Staged DB files for the harness db. The staging path now carries a
 *  per-import nonce (`test.db.staging-<hex>`), so assert on the directory
 *  rather than a fixed name; sidecars (`-wal`/`-shm`) are excluded so this
 *  mirrors the prior "does the staged db file exist" checks. */
const stagedFiles = (dir: string): string[] =>
  readdirSync(dir).filter(
    (f) =>
      f.startsWith('test.db.staging') &&
      !f.endsWith('-wal') &&
      !f.endsWith('-shm'),
  );

const newHarness = (opts: { serverVersion?: string } = {}): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-rpc-rt-'));
  const dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO example VALUES (?, ?)').run('hello', 'world');

  const { mnemonic, entropy } = generateRecoveryKey();

  let onDrained: ((drainOk: boolean) => Promise<void>) | null = null;
  let restarts = 0;
  const runtime = createArchiveRuntime({
    db,
    dbPath,
    dataPath: dir,
    configPath: null,
    serverVersion: opts.serverVersion ?? SERVER_VERSION,
    now: () => FIXED_NOW,
    requestRestart: (cb) => {
      restarts += 1;
      onDrained = cb;
    },
  });

  return {
    dir, dbPath, db, mnemonic, entropy: Buffer.from(entropy), runtime,
    restartCount: () => restarts,
    takeOnDrained: () => {
      if (!onDrained) throw new Error('no restart callback was captured');
      return onDrained;
    },
    close() {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let h: Harness;
afterEach(() => { h?.close(); });

describe('archive online runtime', () => {
  it('runExport writes a uniquely-stamped archive under exports/ + reports an expiry', async () => {
    h = newHarness();
    const res = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });
    expect(res.bytes_written).toBeGreaterThan(0);
    expect(existsSync(res.path)).toBe(true);
    expect(res.path.startsWith(join(h.dir, 'exports'))).toBe(true);
    expect(readdirSync(join(h.dir, 'exports'))).toHaveLength(1);
    // expires_at = write time (FIXED_NOW) + the 7-day export TTL.
    expect(res.expires_at).toBe(FIXED_NOW + EXPORT_TTL_MS);
  });

  it('a fresh export evicts the prior one (single-latest slot)', async () => {
    h = newHarness();
    const first = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });
    expect(existsSync(first.path)).toBe(true);
    const second = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });
    // Only the newest archive survives; the prior file is gone.
    expect(existsSync(second.path)).toBe(true);
    expect(existsSync(first.path)).toBe(false);
    expect(readdirSync(join(h.dir, 'exports'))).toHaveLength(1);
  });

  it('pruneExpiredExports deletes archives past the TTL', async () => {
    h = newHarness();
    const { path } = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });
    // Backdate the file past the TTL relative to the harness's FIXED_NOW.
    const old = (FIXED_NOW - EXPORT_TTL_MS - 60_000) / 1000;
    utimesSync(path, old, old);
    const { deleted } = h.runtime.pruneExpiredExports();
    expect(deleted).toEqual([path]);
    expect(existsSync(path)).toBe(false);
  });

  it('preflightExport passes when disk has room', async () => {
    h = newHarness();
    await expect(h.runtime.preflightExport({ includeBlobs: false })).resolves.toEqual({ ok: true });
    await expect(h.runtime.preflightExport({ includeBlobs: true })).resolves.toEqual({ ok: true });
  });

  describe('verifyRestoreRealm (Q2 ownership gate)', () => {
    it('an unenrolled but EMPTY warehouse reads as same + authorized (nothing to defend)', async () => {
      h = newHarness(); // harness db has no recovery_key_check
      h.db.exec('DELETE FROM example'); // M5 S3 — empty the warehouse
      await expect(
        h.runtime.verifyRestoreRealm({ recoveryKey: h.mnemonic }),
      ).resolves.toEqual({ realm: 'same', authorized: true });
    });

    it('M5 S3 — an unenrolled but NON-EMPTY warehouse is NOT authorized (target_not_empty)', async () => {
      h = newHarness(); // the harness seeds an `example` row → user data present
      await expect(
        h.runtime.verifyRestoreRealm({ recoveryKey: h.mnemonic }),
      ).resolves.toEqual({ realm: 'same', authorized: false, reason: 'target_not_empty' });
    });

    it('same-realm: the archive key matches the current realm → authorized with one key', async () => {
      h = newHarness();
      await processRecoveryKey(createRecoveryKeyCheckStore(h.db), h.mnemonic); // enroll THIS realm
      await expect(
        h.runtime.verifyRestoreRealm({ recoveryKey: h.mnemonic }),
      ).resolves.toEqual({ realm: 'same', authorized: true });
    });

    it('cross-realm: a foreign archive key needs the current-realm key', async () => {
      h = newHarness();
      await processRecoveryKey(createRecoveryKeyCheckStore(h.db), h.mnemonic); // realm bound to h.mnemonic
      const foreign = generateRecoveryKey().mnemonic; // a DIFFERENT identity's archive key

      // No current-realm key → not authorized.
      await expect(
        h.runtime.verifyRestoreRealm({ recoveryKey: foreign }),
      ).resolves.toEqual({ realm: 'cross', authorized: false, reason: 'realm_mismatch' });

      // Wrong current-realm key → still not authorized.
      await expect(
        h.runtime.verifyRestoreRealm({ recoveryKey: foreign, currentRealmKey: generateRecoveryKey().mnemonic }),
      ).resolves.toEqual({ realm: 'cross', authorized: false, reason: 'realm_mismatch' });

      // The actual current-realm key → authorized.
      await expect(
        h.runtime.verifyRestoreRealm({ recoveryKey: foreign, currentRealmKey: h.mnemonic }),
      ).resolves.toEqual({ realm: 'cross', authorized: true });
    });
  });

  it('readManifest maps the on-disk manifest to the wire shape + counts rows', async () => {
    h = newHarness();
    const { path } = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });
    const manifest = await h.runtime.readManifest(path, h.mnemonic);
    // Blob-encryption fix Phase 2 bumped the archive format version to 2.
    expect(manifest.format_version).toBe(2);
    expect(manifest.includes_blobs).toBe(false);
    expect(manifest.tables.example).toBe(1);
    expect(manifest.record_count).toBeGreaterThanOrEqual(1);
    expect(() => new Date(manifest.exported_at).toISOString()).not.toThrow();
  });

  it('readManifest with the wrong recovery key throws (validates before any preview)', async () => {
    h = newHarness();
    const { path } = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });
    const wrong = generateRecoveryKey().mnemonic;
    await expect(h.runtime.readManifest(path, wrong)).rejects.toThrow(/ARCHIVE_INVALID_SIGNATURE/);
  });

  it('runImport stages live, then the restart commit swaps the db in', async () => {
    h = newHarness();
    const { path } = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });

    // Mutate the LIVE db after the export so we can prove the restore
    // replaced it with the archived snapshot (1 row), not the live one.
    h.db.prepare('INSERT INTO example VALUES (?, ?)').run('foo', 'bar');
    expect(rowCount(h.db)).toBe(2);

    const res = await h.runtime.runImport({ path, force: false, recoveryKey: h.mnemonic });
    expect(res.restored_at).toBe(FIXED_NOW);
    expect(res.manifest.tables.example).toBe(1);
    expect(h.restartCount()).toBe(1);

    // Staged beside the live db; the live db is UNTOUCHED (still 2 rows).
    expect(stagedFiles(h.dir)).toHaveLength(1);
    expect(rowCount(h.db)).toBe(2);

    // Simulate the drain's close_db, then run the captured swap with a
    // clean drain result (drainOk = true) → commit.
    h.db.close();
    await h.takeOnDrained()(true);

    // dbPath is now the archived snapshot: 1 row, 'hello' present, 'foo' gone.
    const restored = new Database(h.dbPath, { readonly: true });
    try {
      expect(rowCount(restored)).toBe(1);
      expect((restored.prepare("SELECT v FROM example WHERE k = 'hello'").get() as { v: string }).v).toBe('world');
      expect(restored.prepare("SELECT v FROM example WHERE k = 'foo'").get()).toBeUndefined();
    } finally {
      restored.close();
    }

    // Staging consumed; the prior db was backed up (rollback safety net).
    expect(stagedFiles(h.dir)).toHaveLength(0);
    expect(readdirSync(h.dir).some((f) => f.startsWith('test.db.bak-'))).toBe(true);
  });

  it('mints a driving-client rebind bearer that SURVIVES the swap (M5 S2a)', async () => {
    h = newHarness();
    const { path } = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });

    const drivingClient = {
      instance_id: 'inst-e2e-1',
      client_kind: 'webclient' as const,
      client_label: 'Laptop',
      display_name: 'Laptop',
      user_id: 'self',
    };
    const res = await h.runtime.runImport({ path, force: false, recoveryKey: h.mnemonic, drivingClient });
    expect(res.rebind).toBeDefined();
    expect(res.rebind?.instance_id).toBe('inst-e2e-1');
    expect((res.rebind?.bearer ?? '').length).toBeGreaterThan(0);

    // Commit the swap (rename the staged MAIN file onto dbPath, discarding any
    // staging `-wal`). The bearer the client was handed must be in the live db.
    h.db.close();
    await h.takeOnDrained()(true);

    const live = new Database(h.dbPath);
    try {
      // The RETURNED cleartext bearer must actually authenticate against the
      // restored db (prod Argon params) — proves the full runImport→response
      // plumbing handed back a USABLE bearer, not just a real token_id with a
      // bogus bearer the client would stash and then fail to reconnect with.
      const verified = await createClientTokenStore(live).verify(
        res.rebind!.token_id,
        res.rebind!.bearer,
      );
      expect(verified.ok).toBe(true);
      expect(verified.record?.client_kind).toBe('webclient');
      expect(verified.record?.metadata?.instance_id).toBe('inst-e2e-1');
      const rosterRow = live
        .prepare('SELECT user_id FROM paired_instances WHERE instance_id = ?')
        .get('inst-e2e-1') as { user_id: string } | undefined;
      expect(rosterRow?.user_id).toBe('self');
    } finally {
      live.close();
    }
  });

  it('runImport without a drivingClient returns no rebind', async () => {
    h = newHarness();
    const { path } = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });
    const res = await h.runtime.runImport({ path, force: false, recoveryKey: h.mnemonic });
    expect(res.rebind).toBeUndefined();
  });

  it('abandons the staged restore when the drain did not quiesce (drainOk=false)', async () => {
    h = newHarness();
    const { path } = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });
    h.db.prepare('INSERT INTO example VALUES (?, ?)').run('foo', 'bar'); // mutate live db
    expect(rowCount(h.db)).toBe(2);

    const res = await h.runtime.runImport({ path, force: false, recoveryKey: h.mnemonic });
    expect(res.restored_at).toBe(FIXED_NOW);
    expect(stagedFiles(h.dir)).toHaveLength(1);
    expect(h.restartCount()).toBe(1);

    // Drain timed out / aborted → abandon the staged restore, reboot on the
    // ORIGINAL db. No swap, so no need to close the live handle.
    await h.takeOnDrained()(false);

    // Staging discarded; the live db is UNTOUCHED (still 2 rows, not the
    // archived snapshot), and no backup was taken (dbPath never moved).
    expect(stagedFiles(h.dir)).toHaveLength(0);
    expect(rowCount(h.db)).toBe(2);
    expect(readdirSync(h.dir).some((f) => f.startsWith('test.db.bak-'))).toBe(false);
  });

  it('two un-committed stages use DISTINCT staging paths (no fixed-path clobber)', async () => {
    // The import-latch race regression: the old code staged to a FIXED
    // `${dbPath}.staging`, so a second stage landing before the first committed
    // OVERWROTE it — the first drain would then swap in the WRONG db. With a
    // per-import nonce the two staged files coexist; nothing is clobbered.
    h = newHarness();
    const { path } = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });
    // Stage twice WITHOUT committing (don't run the captured onDrained).
    await h.runtime.runImport({ path, force: false, recoveryKey: h.mnemonic });
    await h.runtime.runImport({ path, force: false, recoveryKey: h.mnemonic });
    expect(stagedFiles(h.dir)).toHaveLength(2);
    expect(h.restartCount()).toBe(2);
  });

  it('runImport with the wrong key aborts before staging — no restart, db untouched', async () => {
    h = newHarness();
    const { path } = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });
    const wrong = generateRecoveryKey().mnemonic;

    await expect(h.runtime.runImport({ path, force: false, recoveryKey: wrong }))
      .rejects.toThrow(/ARCHIVE_INVALID_SIGNATURE/);

    expect(h.restartCount()).toBe(0);
    expect(stagedFiles(h.dir)).toHaveLength(0);
    expect(rowCount(h.db)).toBe(1); // live db intact
  });

  it('runImport with an invalid mnemonic throws a recovery-key error before staging', async () => {
    h = newHarness();
    const { path } = await h.runtime.runExport({ includeBlobs: false, includePassport: false, recoveryKey: h.mnemonic });
    await expect(h.runtime.runImport({ path, force: false, recoveryKey: 'not a real mnemonic' }))
      .rejects.toThrow(/recovery|mnemonic/i);
    expect(h.restartCount()).toBe(0);
    expect(stagedFiles(h.dir)).toHaveLength(0);
  });

  it('force maps to allow-future-version: a future-min-consumer archive needs force', async () => {
    // Export an archive whose min_consumer_version the runtime's
    // serverVersion (0.0.1) is BELOW, so the import compat check rejects
    // it unless `force` (→ allowFutureVersion) is passed.
    h = newHarness({ serverVersion: '0.0.1' });
    const archivePath = join(h.dir, 'future.recued.archive');
    await exportArchive({
      destPath: archivePath,
      recoveryKey: h.entropy, // raw 32-byte key == BIP39 entropy of the mnemonic
      db: h.db,
      producerVersion: '9.9.9',
      // MIN_CONSUMER_VERSION baked by exportArchive is 0.2.0 > 0.0.1.
    });

    await expect(h.runtime.readManifest(archivePath, h.mnemonic)).resolves.toBeTruthy();
    await expect(h.runtime.runImport({ path: archivePath, force: false, recoveryKey: h.mnemonic }))
      .rejects.toThrow(/ARCHIVE_FUTURE_VERSION/);
    expect(h.restartCount()).toBe(0);

    // With force the compat check is skipped → stages + requests restart.
    const res = await h.runtime.runImport({ path: archivePath, force: true, recoveryKey: h.mnemonic });
    expect(res.restored_at).toBe(FIXED_NOW);
    expect(h.restartCount()).toBe(1);
  });
});
