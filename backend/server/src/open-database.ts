/** D-212 encrypted database-open chokepoint.
 *
 * Every production SQLite connection is constructed here. Connection-specific
 * policy (read-only mode, WAL, foreign keys, busy timeout) remains at the call
 * site. Enrolled realms resolve a domain-separated key from the sidecar +
 * keyfile and apply it before the first schema read.
 */

import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import CipherDatabase from 'better-sqlite3-multiple-ciphers';
import type Database from 'better-sqlite3';
import {
  databaseEnrollmentInProgress,
  finishDatabaseEnrollment,
  resolveDatabaseKeyFromServerFiles,
} from './database-encryption.js';
import { resolveServerBundleSwapMarkerPath } from './archive/server-bundle-swap.js';

type CipherDatabaseHandle = Database.Database & {
  key(key: Buffer): number;
  rekey(key: Buffer): number;
};

export interface OpenDatabaseOptions extends Database.Options {
  /** Explicit key for recovery/staging paths. `null` explicitly selects a
   * keyless open; omission resolves the canonical sidecar + keyfile. */
  databaseKey?: Uint8Array | null;
  /** Environment used for an optionally passphrase-sealed identity keyfile. */
  keyEnvironment?: Record<string, string | undefined>;
  /** Internal serve-boot handoff: the restore journal was reconciled in this
   *  process before this open. Needed only when unresolved CAS parks keep an
   *  otherwise-settled marker for a later retry. Standalone callers omit it. */
  restoreJournalReconciled?: boolean;
}

const asCipherHandle = (db: Database.Database): CipherDatabaseHandle =>
  db as CipherDatabaseHandle;

const assertReadable = (db: Database.Database): void => {
  db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
};

const checkpointIsBusy = (result: unknown): boolean => {
  const row = Array.isArray(result) ? result[0] : result;
  return !!row && typeof row === 'object' && (row as { busy?: unknown }).busy !== 0;
};

/** Rekey an already-open plaintext realm during first recovery-key enrollment.
 * WAL must be fully folded and disabled first; the cipher fork rejects rekey in
 * WAL mode. The prior journal mode is restored before returning. */
export const rekeyDatabase = (
  database: Database.Database,
  databaseKey: Uint8Array,
): void => {
  const db = asCipherHandle(database);
  const previousJournalMode = String(
    db.pragma('journal_mode', { simple: true }),
  ).toLowerCase();
  const key = Buffer.from(databaseKey);
  let rekeyed = false;
  // Let this ONE operation spill to disk. The cipher fork implements the
  // plaintext-to-encrypted rekey as a vacuum into an `ATTACH ''`, and the
  // realm-wide `temp_store = MEMORY` turns that attachment into a memdb — so
  // the whole database materializes in RAM. Measured at +228 MB RSS to rekey a
  // 191 MB realm against +19 MB on disk, and it scales with the file, so a
  // grown warehouse OOM-kills the process. The enrollment marker survives that
  // kill, so every later boot retries the same allocation: a boot loop.
  //
  // Spilling is safe here and nowhere else: this is the plaintext-to-encrypted
  // transition, so the pages the vacuum stages are already sitting in the clear
  // in the source file. SQLite unlinks its temp immediately, so the only way
  // one outlives the call is a hard kill — which also means the rekey did not
  // finish and the source is still plaintext regardless.
  const previousTempStore = Number(db.pragma('temp_store', { simple: true }));
  try {
    db.pragma('temp_store = FILE');
    if (previousJournalMode === 'wal') {
      const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)');
      if (checkpointIsBusy(checkpoint)) {
        throw new Error('D212_DATABASE_REKEY_BUSY: WAL checkpoint could not complete');
      }
      db.pragma('journal_mode = DELETE');
    }
    db.rekey(key);
    rekeyed = true;
    assertReadable(db);
  } finally {
    key.fill(0);
    // Back to the realm policy before anything else can run a query on this
    // handle — an encrypted realm must not spill plaintext from here on.
    try {
      db.pragma(`temp_store = ${previousTempStore === 2 ? 'MEMORY' : previousTempStore === 1 ? 'FILE' : 'DEFAULT'}`);
    } catch { /* best effort; the reopen path applies the policy again */ }
    if (previousJournalMode === 'wal') {
      try {
        db.pragma('journal_mode = WAL');
      } catch (err) {
        if (rekeyed) throw err;
      }
    }
  }
};

/** Realm-wide pragmas every connection needs, applied at the open itself.
 *
 *  `temp_store = MEMORY` — the cipher covers the main db, its journal,
 *  subjournals and the WAL, and nothing else. SQLite3MultipleCiphers leaves
 *  the TEMP_DB / TRANSIENT_DB / TEMP_JOURNAL branches of its VFS shim
 *  compiled out ("Could/Should a temporary file be encrypted?"), and this
 *  build reports `TEMP_STORE=1`, so a spilling sorter lands PLAINTEXT rows
 *  in an `etilqs_*` file — verified by reading a live sorter fd mid-sort.
 *  `cache_size` raises the spill threshold but cannot remove it: the D-120
 *  timeline's `ORDER BY COALESCE(event_at, ingested_at)` can never be served
 *  by an index, so it always drives the sorter.
 *
 *  ⚠ It is not free. Anything SQLite implements as a vacuum into an
 *  `ATTACH ''` — notably the cipher fork's own rekey — materializes in RAM
 *  instead of on disk under this setting. `rekeyDatabase` scopes itself back
 *  to `FILE` for that reason; a future caller adding a VACUUM-shaped
 *  operation should measure before assuming otherwise.
 *
 *  `cache_size = -64000` — a 64 MB ceiling, not a reservation; the page
 *  cache grows lazily, so a small realm never allocates it. This is what
 *  makes encryption's read cost vanish: at SQLite's ~2 MB default the same
 *  bench measures +131% on a timeline scan and +212% on a warm point read,
 *  and at 20 MB both are noise. It belonged here rather than at one call
 *  site — every CLI profile, the MCP host and the archive probe were paying
 *  the 2 MB penalty because only the serve connection set it.
 *
 *  Both are properties of the cipher, not of any one connection's policy,
 *  which is why they live at the chokepoint. Connection-specific choices
 *  (journal mode, foreign keys, busy timeout, readonly) stay at call sites. */
const applyRealmPragmas = (database: Database.Database): void => {
  for (const pragma of ['temp_store = MEMORY', 'cache_size = -64000']) {
    try {
      database.pragma(pragma);
    } catch {
      /* best effort — a driver without the pragma still opens. */
    }
  }
};

/** Narrow a realm file to owner-only.
 *
 *  SQLite creates the database and its `-wal` / `-shm` sidecars itself, with no
 *  mode we can pass, so they land `0666 & ~umask` — typically 0644, the one
 *  remaining exception to the 0600 discipline the keyfile, the bundle sidecar,
 *  the enrollment marker and every scratch path already keep.
 *
 *  For an enrolled realm the content is ciphertext and this is metadata
 *  exposure. The window that matters is BEFORE enrollment: a self-hoster who
 *  has not paired yet has a fully plaintext warehouse readable by every local
 *  account. Best-effort — a filesystem without POSIX modes (or a file another
 *  user owns) must not fail the open it was protecting. */
const restrictToOwner = (path: string): void => {
  try {
    chmodSync(path, 0o600);
  } catch { /* best-effort: no POSIX modes, or not ours to narrow */ }
};

/** D-178 S1 rev 2 item 2 — locate the native addon when we ARE the binary.
 *
 *  Running from source, the driver finds `better_sqlite3.node` itself via the
 *  `bindings` package, which searches `build/Release/` relative to the package
 *  in node_modules. Inside a single-file binary there is no node_modules and no
 *  package directory, so that search finds nothing — and `bindings` throws a
 *  path list rather than anything an operator can act on.
 *
 *  The driver's `nativeBinding` option bypasses the search and `require`s an
 *  absolute path directly. That is what lets the D-178 sidecar be ONE FILE
 *  (`lib/better_sqlite3.node` beside the executable) instead of a node_modules
 *  tree: the 60 KB JS wrapper is bundled, only the addon ships.
 *
 *  ⚠ Returns undefined when not running as a SEA, so the from-source and test
 *  paths keep the `bindings` search they have always used — this must not
 *  become a second way to find the addon in development.
 *
 *  ⛔ ABI COUPLING: the addon must match the Node ABI embedded in the binary.
 *  Both come out of the same build container by construction
 *  (`build-binary-docker.mjs`); building them separately at different Node
 *  majors yields a binary that starts and then fails at the first database
 *  open. */
/** PROTOTYPE (single-file) — materialise a SEA-embedded addon and return its
 *  path, or undefined when this binary carries none.
 *
 *  🔑 EXTRACTION IS NOT A DESIGN CHOICE. `dlopen` takes a filesystem path on
 *  every platform we ship; there is no portable load-from-memory. So embedding
 *  buys ONE DISTRIBUTED FILE, not zero files on disk — the win is the manifest
 *  `lib-<triple>` slots, the second signature per triple, the
 *  staged-without-sidecar guard, and the Windows failure where the binary starts
 *  and then cannot open its database.
 *
 *  ⛔ CONTENT-ADDRESSED, and that is load-bearing rather than tidy. The addon
 *  must match the Node ABI inside the binary; an upgrade that reused a stale
 *  extract would reproduce the exact failure the sidecar's ABI note describes —
 *  starts fine, dies at the first database open. Keying the directory on the
 *  bytes' own hash makes a stale hit impossible: different bytes, different path.
 *
 *  ⚠ Written to a temp name then RENAMED. Two servers starting together would
 *  otherwise race on a half-written file, and a partially-written .node fails
 *  `dlopen` in a way that reads like corruption rather than a race.
 *
 *  ⚠ Returns undefined — never throws — on any miss. A binary built without the
 *  asset MUST fall through to the sidecar, which is still the default layout. */
const extractEmbeddedAddon = (sea: { getRawAsset?(k: string): ArrayBuffer }): string | undefined => {
  try {
    if (typeof sea.getRawAsset !== 'function') return undefined;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(sea.getRawAsset('better_sqlite3.node'));
    } catch {
      return undefined; // no such asset — a sidecar build, which is fine
    }
    if (bytes.length === 0) return undefined;

    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);

    /** ⛔ NOT os.tmpdir(). Every platform reclaims temp on a schedule — Storage
     *  Sense and Disk Cleanup on Windows, the periodic purge over
     *  /var/folders on macOS, systemd-tmpfiles (10d by default) on Linux — and
     *  several distros clear /tmp at boot outright. Re-extracting is cheap and
     *  self-healing, so this was never a correctness bug; it just meant the
     *  cache silently evaporated and every N-th start paid the write again.
     *
     *  `~/.recued/` is where this server already keeps per-user state
     *  (`cli/url-enumerate.ts`), so it inherits a location the user's backups
     *  and their own expectations already cover. It is also a less
     *  antivirus-interesting place to write an executable than %TEMP%.
     *
     *  ⚠ NOT beside the database. The data dir is what export/import walks, and
     *  a 2 MB native object living there would ride into archives that have no
     *  use for it and cannot verify it. */
    const home = (() => {
      try { return homedir(); } catch { return ''; }
    })();
    const roots = [
      ...(home ? [join(home, '.recued', 'native')] : []),
      tmpdir(), // last resort: a read-only or absent HOME must still boot
    ];

    for (const root of roots) {
      try {
        const dir = join(root, `recued-addon-${digest}`);
        const target = join(dir, 'better_sqlite3.node');

        // ⛔ HASH THE CACHED COPY, do not trust its LENGTH. A same-length but
        // altered file — an antivirus that zeroed or quarantined-and-stubbed it,
        // a partial write from a killed process, bit rot — would otherwise be
        // handed to dlopen, which fails in a way that reads like a corrupt
        // BUILD rather than a corrupt CACHE. ~2 MB of sha256 is single-digit
        // milliseconds against a failure that costs a support round trip.
        if (existsSync(target) && statSync(target).size === bytes.length) {
          const cached = createHash('sha256').update(readFileSync(target)).digest('hex').slice(0, 16);
          if (cached === digest) return target;
          // Same length, wrong bytes. Fall through and rewrite it.
        }

        mkdirSync(dir, { recursive: true });
        const staging = join(dir, `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
        writeFileSync(staging, bytes, { mode: 0o700 });
        try {
          renameSync(staging, target);
        } catch (err) {
          // Lost the race: a sibling renamed first. Its bytes hash the same as
          // ours by construction, so its file is ours — take it, drop the copy.
          try { unlinkSync(staging); } catch { /* best-effort */ }
          if (!existsSync(target)) throw err;
        }
        return target;
      } catch {
        // This root is unusable (no HOME, read-only, quota). Try the next.
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const resolveNativeBinding = (): unknown | undefined => {
  try {
    // ⚠ `typeof require` is the portability guard, not decoration. This module
    // is ESM at source and in `dist/bin.js`, and CJS only inside the SEA
    // bundle. Bare `require` is undefined under vitest and under plain ESM, so
    // the guard is what keeps this from throwing on the from-source path; in
    // the ESM bundle the createRequire banner supplies a real one, which then
    // correctly answers `isSea() === false`.
    if (typeof require === 'undefined') return undefined;
    // ⚠ `getRawAsset` is OPTIONAL in this cast on purpose: it landed in Node
    // 20.12/21.7, and a binary built on an older base must read as "no asset"
    // rather than crash. `extractEmbeddedAddon` typeof-guards it for the same
    // reason — the type is a claim about the shape, not a guarantee it is there.
    const sea = require('node:sea') as {
      isSea(): boolean;
      getRawAsset?(k: string): ArrayBuffer;
    };
    if (!sea.isSea()) return undefined;

    // ⛔ RETURNS THE ADDON OBJECT, NOT A PATH — and that is forced, not chosen.
    // A SEA's own `require` resolves BUILT-IN MODULES ONLY: handed a path it
    // answers `No such built-in module`, which is exactly how this failed the
    // first time. `createRequire` anchored at the executable produces a real
    // filesystem require, and the driver accepts a pre-loaded addon object
    // (`nativeBinding` is documented as string OR object) so nothing downstream
    // has to resolve anything.
    const { createRequire } = require('node:module') as {
      createRequire(p: string): (id: string) => unknown;
    };
    const bindingPath =
      process.env.RECUED_NATIVE_BINDING
      ?? extractEmbeddedAddon(sea)
      ?? join(dirname(process.execPath), 'lib', 'better_sqlite3.node');
    return createRequire(process.execPath)(bindingPath);
  } catch (err) {
    // Fail LOUDLY. Returning undefined here would fall through to the
    // `bindings` search, which inside a SEA cannot succeed either — the
    // operator would get a path list from a package that is not on disk
    // instead of the one fact that helps: the sidecar is missing.
    // ⚠ NAME THE INSTALLER, not just the missing path. `recued` is TWO files by
    // design, and the artifacts sit next to each other in the bucket — so the
    // reachable failure is downloading the .exe alone from a browser, which
    // starts fine and dies here at the first database open. Someone in that
    // position does not need the path; they need to know a one-line installer
    // exists that fetches BOTH and verifies both signatures.
    throw new Error(
      `D178_SIDECAR_MISSING: could not load the native SQLite addon beside the binary `
        + `(${err instanceof Error ? err.message : String(err)}). Expected `
        + `lib/better_sqlite3.node next to ${process.execPath}, or RECUED_NATIVE_BINDING set.\n`
        + `  recued ships as TWO files. If you downloaded the executable on its own, use the\n`
        + `  installer instead — it fetches both and verifies both signatures:\n`
        + (process.platform === 'win32'
          ? '      irm https://recued.com/install.ps1 | iex'
          : '      curl -fsSL https://recued.com/install.sh | sh'),
    );
  }
};

const constructDatabase = (
  filename: string | Buffer,
  options?: Database.Options,
): Database.Database => {
  const nativeBinding = resolveNativeBinding();
  // ⚠ Cast: `@types/better-sqlite3` types `nativeBinding` as `string`, but the
  // multiple-ciphers driver also accepts a PRE-LOADED ADDON OBJECT
  // (`lib/database.js` — `else { addon = nativeBinding }`), which is the only
  // form usable inside a SEA. The types lag the implementation; the runtime
  // contract is the one that matters here.
  const database = new CipherDatabase(filename, {
    ...options,
    ...(nativeBinding ? { nativeBinding: nativeBinding as unknown as string } : {}),
  }) as unknown as Database.Database;
  applyRealmPragmas(database);
  if (typeof filename === 'string' && filename !== ':memory:') {
    // Narrowing the main file here is enough for all three: call sites enable
    // WAL after this returns, and SQLite's unix VFS creates `-wal` / `-shm`
    // with the database file's own mode. Verified — with the db at 0600 before
    // `journal_mode = WAL`, both sidecars land 0600 rather than 0644.
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${filename}${suffix}`)) restrictToOwner(`${filename}${suffix}`);
    }
  }
  return database;
};

export const openDatabase = (
  filename: string | Buffer,
  options: OpenDatabaseOptions = {},
): Promise<Database.Database> => {
  return (async () => {
    const {
      databaseKey: suppliedDatabaseKey,
      keyEnvironment,
      restoreJournalReconciled,
      ...driverOptions
    } = options;
    const hasSuppliedKey = Object.prototype.hasOwnProperty.call(options, 'databaseKey');
    const dbPath = typeof filename === 'string' && filename !== ':memory:'
      ? filename
      : null;
    // Every production SQLite door converges here, including standalone CLI
    // profiles that do not run the serve boot reconciler. If a hard exit left a
    // restore journal, opening the live path can observe a db/bundle/config mix;
    // worse, in the pre-commit window the live db is absent and SQLite would
    // create an empty replacement that makes deterministic rollback impossible.
    // Serve and archive-import reconcile before reaching this chokepoint. Every
    // other caller must fail closed and let a normal server boot settle it.
    if (
      dbPath
      && !restoreJournalReconciled
      && existsSync(resolveServerBundleSwapMarkerPath(dbPath))
    ) {
      throw new Error(
        `ARCHIVE_RESTORE_RECOVERY_REQUIRED: an interrupted restore journal exists for ${dbPath}; `
          + 'start the server once to reconcile it before opening the database',
      );
    }
    const databaseKey = hasSuppliedKey
      ? suppliedDatabaseKey ?? null
      : dbPath
        ? await resolveDatabaseKeyFromServerFiles(dbPath, { env: keyEnvironment })
        : null;

    try {
      if (!databaseKey) return constructDatabase(filename, driverOptions);

      let keyed = constructDatabase(filename, driverOptions);
      try {
        const key = Buffer.from(databaseKey);
        try {
          asCipherHandle(keyed).key(key);
        } finally {
          key.fill(0);
        }
        assertReadable(keyed);
        if (dbPath && databaseEnrollmentInProgress(dbPath)) {
          finishDatabaseEnrollment(dbPath);
        }
        return keyed;
      } catch (keyedError) {
        try { keyed.close(); } catch { /* best effort */ }

        // The only plaintext -> encrypted conversion slice 3 permits is recovery
        // from its own crash-marked first-enrollment window. A sidecar paired with
        // plaintext and no marker is the pre-launch/no-migration refusal case.
        if (!dbPath || !existsSync(dbPath)) throw keyedError;
        let plaintext: Database.Database | undefined;
        try {
          plaintext = constructDatabase(filename, driverOptions);
          assertReadable(plaintext);
        } catch {
          try { plaintext?.close(); } catch { /* best effort */ }
          throw keyedError;
        }
        if (!databaseEnrollmentInProgress(dbPath)) {
          try { plaintext.close(); } catch { /* best effort */ }
          throw new Error(
            'D212_DATABASE_PLAINTEXT_REJECTED: an enrolled server bundle is paired with a plaintext database and no enrollment marker; pre_launch_no_migration requires a fresh realm',
          );
        }
        if (driverOptions.readonly) {
          try { plaintext.close(); } catch { /* best effort */ }
          throw new Error(
            'D212_DATABASE_ENROLLMENT_INCOMPLETE: start the writable server once to finish the interrupted database rekey',
          );
        }
        try {
          rekeyDatabase(plaintext, databaseKey);
          finishDatabaseEnrollment(dbPath);
          return plaintext;
        } catch (err) {
          try { plaintext.close(); } catch { /* best effort */ }
          throw err;
        }
      }
    } finally {
      // Explicit keys remain caller-owned because recovery/archive paths may
      // reuse them across several opens. Keys resolved internally from the
      // sidecar + keyfile are ours and are wiped as soon as the driver copies
      // them into the connection.
      if (!hasSuppliedKey) databaseKey?.fill(0);
    }
  })();
};

/** Consistent logical copy that preserves the source connection's cipher.
 * The fork rejects `db.backup()` when its implicit target has no matching key;
 * `VACUUM INTO` inherits the keyed connection and includes committed WAL pages. */
export const copyDatabaseForSnapshot = async (
  db: Database.Database,
  destination: string,
): Promise<void> => {
  const staging = `${destination}.vacuum-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    db.prepare('VACUUM INTO ?').run(staging);
    // Rename straight over the destination. Unlinking it first opened a window
    // in which NEITHER the old snapshot nor the new one existed — POSIX
    // `rename` replaces atomically, so the window was pure downside.
    renameSync(staging, destination);
    restrictToOwner(destination);
  } catch (err) {
    try { unlinkSync(staging); } catch { /* absent — fine */ }
    throw err;
  }
};

/** Reclaim `VACUUM INTO` staging files a hard kill stranded.
 *
 *  The helper above unlinks its own staging on any failure it lives to see;
 *  SIGKILL, an OOM kill and power loss are the ones it does not, and each of
 *  those leaves a FULL COPY of the database behind. Nothing else looks for
 *  them — the CAS sweep walks shard directories and the blob-scratch sweep
 *  matches different prefixes — so without this they accumulate one per kill,
 *  at realm size each.
 *
 *  Name construction and matching live together on purpose: a sweep that
 *  rebuilt the pattern itself would keep passing while the writer drifted. */
export const sweepSnapshotStaging = (dir: string): number => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.includes('.vacuum-')) continue;
    try {
      unlinkSync(join(dir, name));
      removed += 1;
    } catch { /* already gone, or not ours to remove */ }
  }
  return removed;
};
