/** A realm's own pre-migration snapshot, taken at the boot where it first runs
 *  under a release it has not seen before.
 *
 *  WHY THIS EXISTS. The update takes ONE snapshot — of the database belonging to
 *  the realm that ran the apply. Schema migrations, by contrast, are LAZY and
 *  PER-REALM: each database is brought forward on its own first boot under the
 *  new binary (`memory-schema.ts`: "migration idempotent — second boot doesn't
 *  ALTER TABLE again"). So any realm that was not the one applying migrated with
 *  nothing to restore from — and those migrations are not all additive: the
 *  store setup runs real `DROP COLUMN`s (`enabled`, `recipe_hash`, `model_used`,
 *  `stale`). A rollback afterwards could not put those columns back.
 *
 *  🔑 IT IS NOT ABOUT CONCURRENCY. Several realms on one host are not a feature —
 *  they are the price of allowing a custom `--db` path, and nothing supports
 *  running them at once. The case this actually covers is a realm meeting a
 *  binary generation it has never run, which is equally:
 *
 *    · a second database someone points the server at, and
 *    · stop the server, back up the db + keyfile, update, restore
 *
 *  Both are the same event, and the second one is an ordinary supported
 *  workflow. That is the invariant: a realm about to migrate under an unfamiliar
 *  release snapshots itself first.
 *
 *  ⛔⛔ AND THE APPLYING REALM MUST NOT DO IT. It boots under a changed release
 *  too, and it ALREADY has a pre-migration snapshot at this exact path — taken
 *  before the swap, which is the only moment it could be taken. Re-snapshotting
 *  here would overwrite that with a POST-migration copy and silently destroy the
 *  rollback target the update depends on. The realm that applied is the one with
 *  an in-flight entry in its own ledger; that is how the two are told apart.
 *
 *  Retention is deliberately identical to the applying realm's: same path, same
 *  overwrite by the next transition, same consumption by a rollback. One
 *  generation, never a chain.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compareVersions } from '@recued/release';
import { writeFileAtomicSync } from '../durable-fs.js';

/** Stable, filesystem-safe identity for one database path. The sidecars used to
 * be keyed only by dirname(dbPath), so `a.db` and `b.db` in the same directory
 * shared a marker and one snapshot. The second realm therefore skipped its own
 * snapshot and a later downgrade restored A's bytes over B. Keep the readable
 * filenames short while binding every sidecar to the complete resolved path. */
const realmStorageId = (dbPath: string): string => {
  const path = resolve(dbPath);
  // Windows paths are case-insensitive. Hash the identity the filesystem uses,
  // not two spellings that can name the same database.
  const canonical = process.platform === 'win32' ? path.toLowerCase() : path;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
};

const realmId = (dbPath: string): string => {
  const path = resolve(dbPath);
  return process.platform === 'win32' ? path.toLowerCase() : path;
};

/** Records the release identity this realm last booted under. A FILE, not a
 *  `server_config` row: this has to be read BEFORE any store is constructed,
 *  and store construction is what creates the tables. */
export const realmReleaseMarkerPath = (dbPath: string): string =>
  join(dirname(resolve(dbPath)), `.last-boot-release.${realmStorageId(dbPath)}`);

export const realmSnapshotPath = (dbPath: string): string =>
  join(dirname(resolve(dbPath)), `update-snapshot.${realmStorageId(dbPath)}.db`);

export const realmSnapshotMetadataPath = (dbPath: string): string =>
  join(dirname(resolve(dbPath)), `update-snapshot.${realmStorageId(dbPath)}.meta.json`);

/** Pre-scoped releases used this one directory-wide slot. It is consumed only
 * by the realm whose still-open apply ledger proves it is booting immediately
 * after that legacy apply; ordinary realms never consult it. */
export const legacyRealmSnapshotPath = (dbPath: string): string =>
  join(dirname(resolve(dbPath)), 'update-snapshot.db');

export const releaseGenerationTransitionPath = (binaryPath: string): string =>
  `${binaryPath}.generation.json`;

export interface ReleaseGenerationTransition {
  schema: 1;
  from_version: string;
  to_version: string;
  migration: boolean;
}

interface RealmSnapshotMetadata {
  schema: 2;
  realm_id: string;
  snapshot_sha256: string;
  from_version: string;
  to_version: string;
  migration: boolean;
}

/** Hash without reading a potentially multi-gigabyte realm into one Buffer. */
const sha256File = (path: string): string | null => {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* best effort */ }
  }
};

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');

const isSqliteDatabase = (path: string): boolean | null => {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return readSync(fd, header, 0, header.length, 0) === header.length
      && header.equals(SQLITE_HEADER);
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* best effort */ }
  }
};

/** A legacy snapshot carries no database path. Adopt it only when its directory
 * contains exactly one live SQLite database, so boot order can never make a
 * sibling realm claim another realm's pre-migration bytes. */
const legacySnapshotOwnerIsUnambiguous = (dbPath: string): boolean => {
  const expected = realmId(dbPath);
  const directory = dirname(resolve(dbPath));
  const candidates: string[] = [];
  try {
    for (const name of readdirSync(directory)) {
      if (name === 'update-snapshot.db' || /^update-snapshot\.[0-9a-f]{24}\.db$/.test(name)) continue;
      const path = join(directory, name);
      if (!statSync(path).isFile()) continue;
      const sqlite = isSqliteDatabase(path);
      if (sqlite === null) return false;
      if (sqlite) candidates.push(realmId(path));
    }
  } catch {
    return false;
  }
  return candidates.length === 1 && candidates[0] === expected;
};

const parseTransition = (raw: string): ReleaseGenerationTransition | null => {
  try {
    const value = JSON.parse(raw) as Partial<ReleaseGenerationTransition>;
    if (
      value.schema !== 1
      || typeof value.from_version !== 'string'
      || typeof value.to_version !== 'string'
      || typeof value.migration !== 'boolean'
    ) return null;
    return value as ReleaseGenerationTransition;
  } catch {
    return null;
  }
};

/** Host-wide provenance for the one executable generation currently being
 * installed. Other realms use it to decide whether a later host downgrade must
 * restore their own snapshot before the old binary opens their database. */
export const writeReleaseGenerationTransition = (
  binaryPath: string,
  transition: ReleaseGenerationTransition,
): void => {
  writeFileAtomicSync(
    releaseGenerationTransitionPath(binaryPath),
    `${JSON.stringify(transition)}\n`,
  );
};

export const readReleaseGenerationTransition = (
  binaryPath: string,
): ReleaseGenerationTransition | null => {
  try {
    return parseTransition(readFileSync(releaseGenerationTransitionPath(binaryPath), 'utf8'));
  } catch {
    return null;
  }
};

/** Bind a realm's one retained snapshot to the host transition it can undo. */
export const writeRealmSnapshotMetadata = (
  dbPath: string,
  transition: ReleaseGenerationTransition,
): void => {
  const snapshot = realmSnapshotPath(dbPath);
  const snapshotSha256 = sha256File(snapshot);
  if (snapshotSha256 === null) {
    throw new Error(`cannot bind realm snapshot metadata: ${snapshot} is unreadable`);
  }
  writeFileAtomicSync(
    realmSnapshotMetadataPath(dbPath),
    `${JSON.stringify({
      schema: 2,
      realm_id: realmId(dbPath),
      snapshot_sha256: snapshotSha256,
      from_version: transition.from_version,
      to_version: transition.to_version,
      migration: transition.migration,
    } satisfies RealmSnapshotMetadata)}\n`,
  );
};

const readRealmSnapshotMetadata = (dbPath: string): RealmSnapshotMetadata | null => {
  try {
    const value = JSON.parse(
      readFileSync(realmSnapshotMetadataPath(dbPath), 'utf8'),
    ) as Partial<RealmSnapshotMetadata>;
    if (
      value.schema !== 2
      || value.realm_id !== realmId(dbPath)
      || !/^[0-9a-f]{64}$/.test(value.snapshot_sha256 ?? '')
      || typeof value.from_version !== 'string'
      || typeof value.to_version !== 'string'
      || typeof value.migration !== 'boolean'
    ) return null;
    return value as RealmSnapshotMetadata;
  } catch {
    return null;
  }
};

export const realmSnapshotMatchesTransition = (
  dbPath: string,
  transition: ReleaseGenerationTransition,
): boolean => {
  const metadata = readRealmSnapshotMetadata(dbPath);
  const snapshot = realmSnapshotPath(dbPath);
  return metadata !== null
    && metadata.from_version === transition.from_version
    && metadata.to_version === transition.to_version
    && metadata.migration === transition.migration
    && existsSync(snapshot)
    && sha256File(snapshot) === metadata.snapshot_sha256;
};

/** Durably revoke any older metadata before allowing this boot to construct
 * stores without a usable pre-migration snapshot. The snapshot file may still
 * exist (or `takeSnapshot` may have left a partial file), but rollback trusts
 * metadata first, so this tombstone makes those bytes unselectable. */
const writeRealmSnapshotUnavailable = (
  dbPath: string,
  releaseIdentity: string,
  reason: 'snapshot-failed' | 'transition-unknown',
): void => {
  writeFileAtomicSync(
    realmSnapshotMetadataPath(dbPath),
    `${JSON.stringify({
      schema: 2,
      realm_id: realmId(dbPath),
      snapshot_available: false,
      release_identity: releaseIdentity,
      reason,
    })}\n`,
  );
};

export type RealmReleasePreparation =
  | { action: 'none' }
  | { action: 'downgrade-prepared'; restoredSnapshot: boolean; from: string; to: string };

/** Reconcile a host-wide binary downgrade BEFORE opening this realm's database.
 *
 * A rollback initiated by realm A swaps the executable for every realm but can
 * restore only A's database. Realm B therefore has to consume its own snapshot
 * before the older binary constructs stores. If the transition cannot prove
 * that snapshot is the one this downgrade needs, fail closed and leave both the
 * database and snapshot untouched. */
export const prepareRealmForRelease = async (deps: {
  dbPath: string;
  releaseIdentity: string;
  transition: ReleaseGenerationTransition | null;
  restoreSnapshot: (snapshotPath: string) => void | Promise<void>;
}): Promise<RealmReleasePreparation> => {
  const marker = realmReleaseMarkerPath(deps.dbPath);
  let previous: string | null = null;
  try {
    if (existsSync(marker)) previous = readFileSync(marker, 'utf8').trim() || null;
  } catch {
    previous = null;
  }
  if (previous === null || previous === deps.releaseIdentity) return { action: 'none' };
  if (compareVersions(deps.releaseIdentity, previous) >= 0) return { action: 'none' };

  const transition = deps.transition;
  if (
    transition === null
    || transition.from_version !== deps.releaseIdentity
    || transition.to_version !== previous
  ) {
    throw new Error(
      `refusing to open this realm under downgraded release ${deps.releaseIdentity}: `
      + `it last ran ${previous}, but the host transition does not prove which snapshot can undo it`,
    );
  }

  let restoredSnapshot = false;
  if (transition.migration) {
    const snapshot = realmSnapshotPath(deps.dbPath);
    if (!realmSnapshotMatchesTransition(deps.dbPath, transition)) {
      throw new Error(
        `refusing to open this realm under downgraded release ${deps.releaseIdentity}: `
        + `the ${previous} transition migrated its schema and no matching pre-migration snapshot is available`,
      );
    }
    await deps.restoreSnapshot(snapshot);
    restoredSnapshot = true;
  }

  // Written last. A kill after the restore but before this write repeats the
  // same idempotent restore next boot; it never snapshots the newer DB over it.
  writeMarker(marker, deps.releaseIdentity);
  return {
    action: 'downgrade-prepared',
    restoredSnapshot,
    from: previous,
    to: deps.releaseIdentity,
  };
};

export interface RealmGenerationSnapshotDeps {
  dbPath: string;
  /** `<channel>:<version>` of the binary doing the booting. */
  releaseIdentity: string;
  /** True when THIS realm has an apply in flight — i.e. it is the one that ran
   *  the update and already holds a pre-migration snapshot. */
  hasInFlightApply: () => boolean;
  takeSnapshot: (destination: string) => Promise<void>;
  /** Host transition that caused this unfamiliar binary generation. When it
   *  matches, bind the snapshot to the exact rollback it can satisfy. */
  transition?: ReleaseGenerationTransition | null;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export type RealmGenerationSnapshotOutcome =
  | { action: 'snapshot-taken'; from: string | null; to: string }
  | { action: 'skipped'; reason: 'same-release' | 'applying-realm' | 'snapshot-failed' };

/** Call AFTER opening the database and BEFORE constructing any store. */
export const snapshotRealmOnNewRelease = async (
  deps: RealmGenerationSnapshotDeps,
): Promise<RealmGenerationSnapshotOutcome> => {
  const marker = realmReleaseMarkerPath(deps.dbPath);
  let previous: string | null = null;
  try {
    if (existsSync(marker)) previous = readFileSync(marker, 'utf8').trim() || null;
  } catch {
    previous = null;   // unreadable reads as "unknown", which snapshots — the safe way round
  }
  // ⛔ See the header: the applying realm's snapshot is the PRE-migration one and
  // must not be replaced by a post-migration copy. This check precedes the
  // same-release shortcut because a scoped marker can survive a downgrade to a
  // deployed N-1 binary; its later re-apply still owns a fresh legacy snapshot.
  if (deps.hasInFlightApply()) {
    // Bridge exactly one deployed N-1 transition. That binary took the applying
    // realm's snapshot into the old directory-wide slot and could not name the
    // new scoped path. Only an in-flight apply may consume it; rename (do not
    // copy) so a sibling realm can never adopt the same bytes afterwards.
    if (deps.transition?.migration === true) {
      const scoped = realmSnapshotPath(deps.dbPath);
      const legacy = legacyRealmSnapshotPath(deps.dbPath);
      if (existsSync(legacy)) {
        if (!legacySnapshotOwnerIsUnambiguous(deps.dbPath)) {
          throw new Error(
            `refusing to bind deployed N-1 snapshot ${legacy} to ${resolve(deps.dbPath)}: `
              + 'its old directory-wide format does not prove which SQLite realm owns it',
          );
        }
        // A scoped slot can predate a later apply performed by the deployed N-1
        // binary. Its new legacy copy is authoritative. Remove the stale slot
        // first because Windows rename does not replace an existing file; a
        // crash between these operations leaves the legacy source intact for
        // the next boot rather than rebinding stale bytes to this transition.
        if (existsSync(scoped)) unlinkSync(scoped);
        renameSync(legacy, scoped);
        writeRealmSnapshotMetadata(deps.dbPath, deps.transition);
      }
    }
    writeMarker(marker, deps.releaseIdentity);
    return { action: 'skipped', reason: 'applying-realm' };
  }

  if (previous === deps.releaseIdentity) {
    return { action: 'skipped', reason: 'same-release' };
  }

  try {
    await deps.takeSnapshot(realmSnapshotPath(deps.dbPath));
    if (deps.transition?.to_version === deps.releaseIdentity) {
      writeRealmSnapshotMetadata(deps.dbPath, deps.transition);
    } else {
      // A retained metadata record describes the snapshot bytes it was written
      // with, not whichever bytes happen to occupy the one-slot path later.
      writeRealmSnapshotUnavailable(deps.dbPath, deps.releaseIdentity, 'transition-unknown');
    }
  } catch (err) {
    // ⛔ DO NOT RETRY THIS SNAPSHOT ON A LATER BOOT. This hook runs immediately
    // before store construction; after it returns, this release is allowed to
    // execute irreversible DDL. A retry on the next boot would therefore label
    // POST-migration bytes as the PRE-migration rollback target.
    //
    // Boot may continue only after two durable facts exist: no retained snapshot
    // metadata is trusted, and this realm has seen the generation. If either
    // write fails, throw now — before any store can migrate the database — so a
    // later retry is still honestly pre-migration.
    writeRealmSnapshotUnavailable(deps.dbPath, deps.releaseIdentity, 'snapshot-failed');
    writeMarker(marker, deps.releaseIdentity);
    deps.log?.('warn', `realm snapshot before migrating to ${deps.releaseIdentity} failed: `
      + `${err instanceof Error ? err.message : String(err)}`);
    return { action: 'skipped', reason: 'snapshot-failed' };
  }

  writeMarker(marker, deps.releaseIdentity);
  deps.log?.('info', `snapshotted this realm before migrating to ${deps.releaseIdentity}`);
  return { action: 'snapshot-taken', from: previous, to: deps.releaseIdentity };
};

/** A durable atomic marker. Failure is fatal to this pre-migration hook: silently
 * swallowing it lets the next boot snapshot a database this boot may migrate. */
const writeMarker = (marker: string, releaseIdentity: string): void => {
  writeFileAtomicSync(marker, `${releaseIdentity}\n`);
};
