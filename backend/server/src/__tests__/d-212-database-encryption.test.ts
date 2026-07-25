import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import PlainDatabase from 'better-sqlite3';
import {
  createServerBundle,
  generateRecoveryKey,
  generateServerKey,
  recoveryKeyToEntropy,
} from '@recued/crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  beginDatabaseEnrollment,
  databaseEnrollmentInProgress,
  deriveDatabaseKey,
  deriveDatabaseKeyFromRecoveryEntropy,
  resolveDatabaseEnrollmentMarkerPath,
} from '../database-encryption.js';
import { bootServerIdentity } from '../identity/boot.js';
import { createKeyManager } from '../key-manager.js';
import {
  copyDatabaseForSnapshot,
  openDatabase,
  rekeyDatabase,
  sweepSnapshotStaging,
} from '../open-database.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { enrollServerVaultFromRecoveryKey } from '../server-vault-enrollment.js';

const dirs: string[] = [];

const makeRealm = (): { dir: string; dbPath: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'd212-db-encryption-'));
  dirs.push(dir);
  return { dir, dbPath: join(dir, 'realm.db') };
};

const assertPlainDriverCannotRead = (dbPath: string): void => {
  const plain = new PlainDatabase(dbPath, { readonly: true, fileMustExist: true });
  try {
    expect(() => plain.prepare('SELECT * FROM secrets').all()).toThrow(/not a database/i);
  } finally {
    plain.close();
  }
};

const persistManualBundle = async (dbPath: string): Promise<{
  databaseKey: Uint8Array;
  recoveryKey: string;
}> => {
  const recoveryKey = generateRecoveryKey().mnemonic;
  const serverKey = generateServerKey();
  const { bundle, masterDEK } = await createServerBundle({ recoveryKey, serverKey });
  const databaseKey = deriveDatabaseKey(masterDEK);
  masterDEK.fill(0);
  createServerBundleStore(dbPath).save(bundle);

  const identity = await bootServerIdentity({ dbPath, passphrase: null });
  identity.keyStore.saveServerVaultKey(serverKey);
  await identity.keyStore.flush?.();
  serverKey.fill(0);
  return { databaseKey, recoveryKey };
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('D-212 full-file database encryption', () => {
  it('first recovery enrollment rekeys the live WAL database and normal boot reopens it', async () => {
    const { dbPath } = makeRealm();
    const db = await openDatabase(dbPath, { databaseKey: null });
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE secrets (value TEXT NOT NULL)');
    db.prepare('INSERT INTO secrets VALUES (?)').run('D212_DISK_SECRET');

    const identity = await bootServerIdentity({ dbPath, passphrase: null });
    const serverBundleStore = createServerBundleStore(dbPath);
    const keys = createKeyManager({
      loadBundle: () => null,
      saveBundle: () => {},
      loadServerBundle: () => serverBundleStore.load(),
      saveServerBundle: (bundle) => serverBundleStore.save(bundle),
    });
    const recoveryKey = generateRecoveryKey().mnemonic;
    await enrollServerVaultFromRecoveryKey({
      keys,
      keyStore: identity.keyStore,
      recoveryKey,
      database: db,
    });

    expect(databaseEnrollmentInProgress(dbPath)).toBe(false);
    expect(db.prepare('SELECT value FROM secrets').pluck().get()).toBe('D212_DISK_SECRET');
    db.close();

    const bytes = readFileSync(dbPath);
    expect(bytes.subarray(0, 16).toString('utf8')).not.toBe('SQLite format 3\u0000');
    expect(bytes.includes(Buffer.from('D212_DISK_SECRET'))).toBe(false);
    assertPlainDriverCannotRead(dbPath);

    const reopened = await openDatabase(dbPath, { keyEnvironment: {} });
    try {
      expect(reopened.prepare('SELECT value FROM secrets').pluck().get()).toBe('D212_DISK_SECRET');
    } finally {
      reopened.close();
    }

    const bundle = serverBundleStore.load();
    expect(bundle).not.toBeNull();
    const recoveryDatabaseKey = await deriveDatabaseKeyFromRecoveryEntropy(
      bundle!,
      recoveryKeyToEntropy(recoveryKey),
    );
    const recovered = await openDatabase(dbPath, { databaseKey: recoveryDatabaseKey });
    try {
      expect(recovered.prepare('SELECT value FROM secrets').pluck().get()).toBe('D212_DISK_SECRET');
    } finally {
      recovered.close();
      recoveryDatabaseKey.fill(0);
    }
  });

  it('refuses a plaintext db paired with an enrolled bundle when no crash marker exists', async () => {
    const { dbPath } = makeRealm();
    const plaintext = await openDatabase(dbPath, { databaseKey: null });
    plaintext.exec('CREATE TABLE secrets (value TEXT NOT NULL)');
    plaintext.prepare('INSERT INTO secrets VALUES (?)').run('must-not-auto-migrate');
    plaintext.close();
    const { databaseKey } = await persistManualBundle(dbPath);

    await expect(openDatabase(dbPath, { keyEnvironment: {} })).rejects.toThrow(
      'D212_DATABASE_PLAINTEXT_REJECTED',
    );
    await expect(openDatabase(dbPath, { databaseKey })).rejects.toThrow(
      'D212_DATABASE_PLAINTEXT_REJECTED',
    );
    databaseKey.fill(0);
  });

  it('completes only a crash-marked interrupted enrollment on the next writable open', async () => {
    const { dbPath } = makeRealm();
    const plaintext = await openDatabase(dbPath, { databaseKey: null });
    plaintext.exec('CREATE TABLE secrets (value TEXT NOT NULL)');
    plaintext.prepare('INSERT INTO secrets VALUES (?)').run('crash-window-secret');
    plaintext.close();
    const { databaseKey } = await persistManualBundle(dbPath);
    beginDatabaseEnrollment(dbPath);

    await expect(openDatabase(dbPath, {
      readonly: true,
      fileMustExist: true,
      databaseKey,
    })).rejects.toThrow('D212_DATABASE_ENROLLMENT_INCOMPLETE');
    expect(databaseEnrollmentInProgress(dbPath)).toBe(true);

    const recovered = await openDatabase(dbPath, { databaseKey });
    try {
      expect(recovered.prepare('SELECT value FROM secrets').pluck().get()).toBe(
        'crash-window-secret',
      );
    } finally {
      recovered.close();
      databaseKey.fill(0);
    }
    expect(databaseEnrollmentInProgress(dbPath)).toBe(false);
    assertPlainDriverCannotRead(dbPath);
  });

  it('takes a consistent snapshot that stays encrypted and includes committed WAL data', async () => {
    const { dir, dbPath } = makeRealm();
    const databaseKey = Buffer.alloc(32, 0x5a);
    const db = await openDatabase(dbPath, { databaseKey });
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE secrets (value TEXT NOT NULL)');
    db.prepare('INSERT INTO secrets VALUES (?)').run('snapshot-wal-secret');
    const snapshotPath = join(dir, 'snapshot.db');

    await copyDatabaseForSnapshot(db, snapshotPath);
    db.close();

    expect(readFileSync(snapshotPath).includes(Buffer.from('snapshot-wal-secret'))).toBe(false);
    assertPlainDriverCannotRead(snapshotPath);
    const snapshot = await openDatabase(snapshotPath, { databaseKey });
    try {
      expect(snapshot.prepare('SELECT value FROM secrets').pluck().get()).toBe(
        'snapshot-wal-secret',
      );
    } finally {
      snapshot.close();
      databaseKey.fill(0);
    }
  });
});

describe('temp storage never leaves the cipher', () => {
  /** The cipher covers the main db, its journal, subjournals and the WAL —
   *  and nothing else. SQLite3MultipleCiphers leaves TEMP_DB /
   *  TRANSIENT_DB / TEMP_JOURNAL compiled out of its VFS shim, and this
   *  build reports TEMP_STORE=1, so a spilling sorter wrote PLAINTEXT user
   *  rows to an `etilqs_*` file beside the encrypted database (confirmed by
   *  reading a live sorter fd mid-sort).
   *
   *  `temp_store == 2` is the whole mechanism, not a proxy for it: with
   *  TEMP_STORE=1 compiled in, `sqlite3TempInMemory()` returns true iff the
   *  pragma is 2, and that single branch decides whether the sorter ever
   *  touches disk. Read back off a connection built by the production
   *  `openDatabase` — including the keyed path — so a refactor that opens a
   *  realm without going through the chokepoint fails here. */
  const TEMP_STORE_MEMORY = 2;

  it('an unkeyed realm opens with temp storage in memory', async () => {
    const { dbPath } = makeRealm();
    const db = await openDatabase(dbPath, { databaseKey: null });
    try {
      expect(db.pragma('temp_store', { simple: true })).toBe(TEMP_STORE_MEMORY);
    } finally {
      db.close();
    }
  });

  it('an ENCRYPTED realm opens with temp storage in memory', async () => {
    const { dbPath } = makeRealm();
    const recoveryKey = generateRecoveryKey().mnemonic;
    const serverKey = generateServerKey();
    const { bundle } = await createServerBundle({ recoveryKey, serverKey });
    createServerBundleStore(dbPath).save(bundle);
    const databaseKey = await deriveDatabaseKeyFromRecoveryEntropy(
      bundle,
      recoveryKeyToEntropy(recoveryKey),
    );
    try {
      const seed = await openDatabase(dbPath, { databaseKey });
      seed.exec('CREATE TABLE probe (v TEXT)');
      seed.close();

      const db = await openDatabase(dbPath, { databaseKey });
      try {
        expect(db.pragma('temp_store', { simple: true })).toBe(TEMP_STORE_MEMORY);
        // …and the connection really is the keyed one, not a plaintext fallback.
        expect(db.prepare('SELECT count(*) AS n FROM probe').get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    } finally {
      databaseKey.fill(0);
    }
  });
});

describe('the enrollment rekey does not materialize the realm in RAM', () => {
  /** `temp_store = MEMORY` protects the sorter, but the cipher fork implements
   *  the plaintext-to-encrypted rekey as a vacuum into an `ATTACH ''` — which
   *  that same setting turns into a memdb, so the whole database is allocated
   *  in RAM. Measured at +228 MB to rekey a 191 MB realm before `rekeyDatabase`
   *  scoped itself back to `FILE`. It scales with the file, and the enrollment
   *  marker survives an OOM kill, so a grown warehouse would boot-loop.
   *
   *  Spilling is safe for THIS operation only: it is the plaintext-to-encrypted
   *  transition, so the staged pages are already in the clear in the source. */
  it('spills the rekey to disk, then puts the realm policy back', async () => {
    const { dbPath } = makeRealm();
    const db = await openDatabase(dbPath, { databaseKey: null });
    try {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE bulk (id INTEGER PRIMARY KEY, body BLOB)');
      db.prepare('INSERT INTO bulk VALUES (?, ?)').run(1, randomBytes(64_000));

      // Assert on the pragma, not on RSS: the memdb reuses heap the insert
      // loop already grew, so a resident-size delta does not discriminate.
      // `temp_store` IS the mechanism — `sqlite3TempInMemory()` reads exactly
      // this value — so recording it is reading the switch, not a call.
      const pragmas: string[] = [];
      const recorder = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'pragma') {
            return (source: string, options?: unknown) => {
              pragmas.push(source);
              return (target.pragma as (s: string, o?: unknown) => unknown)(source, options);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      rekeyDatabase(recorder, deriveDatabaseKey(new Uint8Array(32).fill(7)));

      const wentToFile = pragmas.findIndex((p) => /temp_store\s*=\s*FILE/i.test(p));
      const cameBack = pragmas.findIndex((p) => /temp_store\s*=\s*MEMORY/i.test(p));
      expect(wentToFile).toBeGreaterThanOrEqual(0);
      expect(cameBack).toBeGreaterThan(wentToFile);

      // …and the realm policy really is back on the live handle, before any
      // query can run on it.
      expect(db.pragma('temp_store', { simple: true })).toBe(2);
      expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
      expect((db.prepare('SELECT count(*) AS n FROM bulk').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('the enrollment marker does not authorize forever', () => {
  /** The marker exists so a boot minutes after a crash can finish an
   *  interrupted rekey. Unbounded, a permanently-failed enrollment leaves it on
   *  disk and from then on ANY plaintext database at that path is silently
   *  adopted and encrypted — including one an operator restored from a
   *  pre-encryption filesystem backup, which should meet
   *  D212_DATABASE_PLAINTEXT_REJECTED instead. */
  it('stops authorizing once it is older than the window', async () => {
    const { dbPath } = makeRealm();
    beginDatabaseEnrollment(dbPath);

    expect(databaseEnrollmentInProgress(dbPath)).toBe(true);

    const day = 24 * 60 * 60 * 1000;
    expect(databaseEnrollmentInProgress(dbPath, () => Date.now() + day - 60_000)).toBe(true);
    expect(databaseEnrollmentInProgress(dbPath, () => Date.now() + day + 60_000)).toBe(false);
  });

  it('a restored pre-encryption backup is refused rather than silently adopted', async () => {
    const { dbPath } = makeRealm();
    const plaintext = await openDatabase(dbPath, { databaseKey: null });
    plaintext.exec('CREATE TABLE secrets (value TEXT NOT NULL)');
    plaintext.prepare('INSERT INTO secrets VALUES (?)').run('from-an-old-backup');
    plaintext.close();
    const { databaseKey } = await persistManualBundle(dbPath);
    beginDatabaseEnrollment(dbPath);

    // Age the marker past its window, the way a months-old failed enrollment
    // would be by the time someone restores a backup over the realm.
    const stale = Date.now() / 1000 - 40 * 24 * 60 * 60;
    utimesSync(resolveDatabaseEnrollmentMarkerPath(dbPath), stale, stale);

    await expect(openDatabase(dbPath, { databaseKey })).rejects.toThrow(
      'D212_DATABASE_PLAINTEXT_REJECTED',
    );
    databaseKey.fill(0);
  });
});

describe('sweepSnapshotStaging', () => {
  /** `copyDatabaseForSnapshot` unlinks its own staging on any failure it lives
   *  to see. A SIGKILL is the one it does not, and what it strands is a FULL
   *  COPY of the realm. Nothing else looks for these — the CAS sweep walks
   *  shard directories and the blob-scratch sweep matches other prefixes. */
  it('reclaims stranded staging copies and leaves everything else alone', async () => {
    const { dir, dbPath } = makeRealm();
    const databaseKey = Buffer.alloc(32, 0x11);
    const db = await openDatabase(dbPath, { databaseKey });
    db.exec('CREATE TABLE t (v TEXT)');
    const snapshot = join(dir, 'snapshot.db');
    await copyDatabaseForSnapshot(db, snapshot);
    db.close();

    // A kill mid-VACUUM leaves the staging name behind.
    const stranded = join(dir, 'snapshot.db.vacuum-999-deadbeef');
    writeFileSync(stranded, 'a full realm copy');

    expect(sweepSnapshotStaging(dir)).toBe(1);
    expect(existsSync(stranded)).toBe(false);
    // The realm and its committed snapshot survive.
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(snapshot)).toBe(true);
    databaseKey.fill(0);
  });
});

describe('realm files are owner-only', () => {
  /** SQLite creates the database and its sidecars itself with no mode we can
   *  pass, so they landed 0644 — the one exception to the 0600 discipline the
   *  keyfile, bundle sidecar, marker and scratch paths all keep. The window
   *  that matters is BEFORE enrollment, when the warehouse is still plaintext. */
  it('the database and its WAL sidecars land 0600', async () => {
    const { dbPath } = makeRealm();
    const db = await openDatabase(dbPath, { databaseKey: null });
    try {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE t (v TEXT)');
      db.prepare('INSERT INTO t VALUES (?)').run('x');

      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      // SQLite copies the database file's mode onto these, so narrowing the
      // main file before WAL is enabled covers all three.
      expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  });
});
