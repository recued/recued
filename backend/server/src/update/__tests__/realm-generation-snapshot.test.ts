import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  legacyRealmSnapshotPath,
  realmReleaseMarkerPath,
  realmSnapshotPath,
  realmSnapshotMetadataPath,
  prepareRealmForRelease,
  snapshotRealmOnNewRelease,
  type ReleaseGenerationTransition,
} from '../realm-generation-snapshot.js';

describe('realm generation snapshot', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-gen-'));
    dbPath = join(dir, 'recued-server.db');
    writeFileSync(dbPath, 'ORIGINAL DATABASE BYTES', 'utf8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Stands in for `copyDatabaseForSnapshot` — copies whatever the db file holds. */
  const realCopy = async (destination: string): Promise<void> => {
    writeFileSync(destination, readFileSync(dbPath, 'utf8'), 'utf8');
  };

  const run = (opts: {
    release: string;
    inFlight?: boolean;
    takeSnapshot?: (d: string) => Promise<void>;
    transition?: ReleaseGenerationTransition;
  }) =>
    snapshotRealmOnNewRelease({
      dbPath,
      releaseIdentity: opts.release,
      hasInFlightApply: () => opts.inFlight ?? false,
      takeSnapshot: opts.takeSnapshot ?? realCopy,
      transition: opts.transition,
    });

  it('snapshots an idle realm meeting a release it has never run', async () => {
    const outcome = await run({ release: '26.9.1' });
    expect(outcome).toEqual({ action: 'snapshot-taken', from: null, to: '26.9.1' });
    expect(readFileSync(realmSnapshotPath(dbPath), 'utf8')).toBe('ORIGINAL DATABASE BYTES');
    expect(readFileSync(realmReleaseMarkerPath(dbPath), 'utf8').trim()).toBe('26.9.1');
  });

  it('does not snapshot again on a later boot of the same release', async () => {
    await run({ release: '26.9.1' });
    rmSync(realmSnapshotPath(dbPath));            // prove the second call is a no-op
    const outcome = await run({ release: '26.9.1' });
    expect(outcome).toEqual({ action: 'skipped', reason: 'same-release' });
    expect(existsSync(realmSnapshotPath(dbPath))).toBe(false);
  });

  it('snapshots again when the release changes', async () => {
    await run({ release: '26.9.1' });
    writeFileSync(dbPath, 'MIGRATED ONCE', 'utf8');
    const outcome = await run({ release: '26.9.2' });
    expect(outcome).toEqual({ action: 'snapshot-taken', from: '26.9.1', to: '26.9.2' });
    // Retention matches the applying realm's: ONE generation, overwritten, never a chain.
    expect(readFileSync(realmSnapshotPath(dbPath), 'utf8')).toBe('MIGRATED ONCE');
  });

  it('binds a snapshot to the exact host transition it can roll back', async () => {
    const transition: ReleaseGenerationTransition = {
      schema: 1,
      from_version: '26.9.1',
      to_version: '26.9.2',
      migration: true,
    };
    await run({ release: '26.9.2', transition });
    expect(JSON.parse(readFileSync(realmSnapshotMetadataPath(dbPath), 'utf8')))
      .toMatchObject({
        schema: 2,
        realm_id: resolve(dbPath),
        from_version: transition.from_version,
        to_version: transition.to_version,
        migration: true,
        snapshot_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
  });

  it('restores a matching migrating snapshot before a host downgrade can open the db', async () => {
    const transition: ReleaseGenerationTransition = {
      schema: 1,
      from_version: '26.9.1',
      to_version: '26.9.2',
      migration: true,
    };
    await run({ release: '26.9.2', transition });
    writeFileSync(dbPath, 'POST-MIGRATION DATABASE', 'utf8');
    const restore = async (snapshot: string): Promise<void> => {
      writeFileSync(dbPath, readFileSync(snapshot));
    };

    const prepared = await prepareRealmForRelease({
      dbPath,
      releaseIdentity: '26.9.1',
      transition,
      restoreSnapshot: restore,
    });

    expect(prepared).toEqual({
      action: 'downgrade-prepared',
      restoredSnapshot: true,
      from: '26.9.2',
      to: '26.9.1',
    });
    expect(readFileSync(dbPath, 'utf8')).toBe('ORIGINAL DATABASE BYTES');
    expect(readFileSync(realmReleaseMarkerPath(dbPath), 'utf8').trim()).toBe('26.9.1');
    // The ordinary post-open snapshot hook now sees the updated marker and cannot
    // overwrite the pre-migration recovery copy with the newer-schema database.
    expect(await run({ release: '26.9.1', transition })).toEqual({
      action: 'skipped',
      reason: 'same-release',
    });
  });

  it('fails closed on a downgrade whose snapshot provenance is unknown', async () => {
    writeFileSync(realmReleaseMarkerPath(dbPath), '26.9.2\n');
    writeFileSync(realmSnapshotPath(dbPath), 'UNBOUND SNAPSHOT');
    await expect(prepareRealmForRelease({
      dbPath,
      releaseIdentity: '26.9.1',
      transition: {
        schema: 1,
        from_version: '26.9.1',
        to_version: '26.9.2',
        migration: true,
      },
      restoreSnapshot: () => { throw new Error('must not restore'); },
    })).rejects.toThrow(/no matching pre-migration snapshot/);
    expect(readFileSync(realmSnapshotPath(dbPath), 'utf8')).toBe('UNBOUND SNAPSHOT');
    expect(readFileSync(realmReleaseMarkerPath(dbPath), 'utf8').trim()).toBe('26.9.2');
  });

  it('fails closed when matching metadata names snapshot bytes that were replaced', async () => {
    const transition: ReleaseGenerationTransition = {
      schema: 1,
      from_version: '26.9.1',
      to_version: '26.9.2',
      migration: true,
    };
    await run({ release: '26.9.2', transition });
    writeFileSync(realmSnapshotPath(dbPath), 'DIFFERENT REALM BYTES');

    await expect(prepareRealmForRelease({
      dbPath,
      releaseIdentity: '26.9.1',
      transition,
      restoreSnapshot: () => { throw new Error('must not restore'); },
    })).rejects.toThrow(/no matching pre-migration snapshot/);
  });

  it('does not discard post-release writes for a proven non-migrating downgrade', async () => {
    const transition: ReleaseGenerationTransition = {
      schema: 1,
      from_version: '26.9.1',
      to_version: '26.9.2',
      migration: false,
    };
    writeFileSync(realmReleaseMarkerPath(dbPath), '26.9.2\n');
    writeFileSync(dbPath, 'WRITES MADE ON 26.9.2');
    let restored = false;
    const prepared = await prepareRealmForRelease({
      dbPath,
      releaseIdentity: '26.9.1',
      transition,
      restoreSnapshot: () => { restored = true; },
    });
    expect(prepared).toMatchObject({ action: 'downgrade-prepared', restoredSnapshot: false });
    expect(restored).toBe(false);
    expect(readFileSync(dbPath, 'utf8')).toBe('WRITES MADE ON 26.9.2');
  });

  // ⛔⛔ THE LOAD-BEARING CASE. The realm that ran the update also boots under a
  // changed release. Its snapshot is the PRE-migration one taken before the swap
  // — the only moment it could be taken — and re-taking it here would replace it
  // with a POST-migration copy, silently destroying the rollback target.
  it('leaves the applying realm’s pre-migration snapshot untouched', async () => {
    const snapshot = realmSnapshotPath(dbPath);
    writeFileSync(snapshot, 'PRE-MIGRATION SNAPSHOT', 'utf8');
    writeFileSync(dbPath, 'ALREADY MIGRATED BY THE APPLY', 'utf8');

    const outcome = await run({ release: '26.9.2', inFlight: true });

    expect(outcome).toEqual({ action: 'skipped', reason: 'applying-realm' });
    expect(readFileSync(snapshot, 'utf8')).toBe('PRE-MIGRATION SNAPSHOT');
    // The marker still advances, so the NEXT release change is judged against
    // this one rather than snapshotting a generation late.
    expect(readFileSync(realmReleaseMarkerPath(dbPath), 'utf8').trim()).toBe('26.9.2');
  });

  it('moves one deployed N-1 snapshot into the applying realm scoped slot', async () => {
    const transition: ReleaseGenerationTransition = {
      schema: 1,
      from_version: '26.8.31',
      to_version: '26.9.1',
      migration: true,
    };
    const realmBytes = Buffer.from('SQLite format 3\0N-1 PRE-MIGRATION SNAPSHOT');
    writeFileSync(dbPath, Buffer.from('SQLite format 3\0MIGRATED REALM'));
    writeFileSync(realmSnapshotPath(dbPath), 'STALE SCOPED SNAPSHOT');
    writeFileSync(legacyRealmSnapshotPath(dbPath), realmBytes);

    const outcome = await run({ release: '26.9.1', inFlight: true, transition });

    expect(outcome).toEqual({ action: 'skipped', reason: 'applying-realm' });
    expect(existsSync(legacyRealmSnapshotPath(dbPath))).toBe(false);
    expect(readFileSync(realmSnapshotPath(dbPath))).toEqual(realmBytes);
    expect(JSON.parse(readFileSync(realmSnapshotMetadataPath(dbPath), 'utf8')))
      .toMatchObject({ schema: 2, realm_id: resolve(dbPath), snapshot_sha256: expect.any(String) });
  });

  it('refuses to guess which sibling realm owns a deployed N-1 snapshot', async () => {
    const transition: ReleaseGenerationTransition = {
      schema: 1,
      from_version: '26.8.31',
      to_version: '26.9.1',
      migration: true,
    };
    writeFileSync(dbPath, Buffer.from('SQLite format 3\0REALM A'));
    writeFileSync(join(dir, 'second.db'), Buffer.from('SQLite format 3\0REALM B'));
    writeFileSync(
      legacyRealmSnapshotPath(dbPath),
      Buffer.from('SQLite format 3\0UNKNOWN OWNER'),
    );

    await expect(run({ release: '26.9.1', inFlight: true, transition }))
      .rejects.toThrow(/does not prove which SQLite realm owns it/);
    expect(existsSync(legacyRealmSnapshotPath(dbPath))).toBe(true);
    expect(existsSync(realmSnapshotPath(dbPath))).toBe(false);
    expect(existsSync(realmReleaseMarkerPath(dbPath))).toBe(false);
  });

  it('records an unavailable snapshot after failure so a later boot cannot launder migrated bytes', async () => {
    const transition: ReleaseGenerationTransition = {
      schema: 1,
      from_version: '26.9.1',
      to_version: '26.9.2',
      migration: true,
    };
    const outcome = await run({
      release: '26.9.2',
      takeSnapshot: () => Promise.reject(new Error('disk full')),
      transition,
    });
    expect(outcome).toEqual({ action: 'skipped', reason: 'snapshot-failed' });
    expect(readFileSync(realmReleaseMarkerPath(dbPath), 'utf8').trim()).toBe('26.9.2');
    expect(JSON.parse(readFileSync(realmSnapshotMetadataPath(dbPath), 'utf8')))
      .toMatchObject({ snapshot_available: false, release_identity: '26.9.2' });

    // What store construction on the first boot is now allowed to do. The
    // second boot must not bless these bytes as a pre-migration snapshot.
    writeFileSync(dbPath, 'POST-MIGRATION DATABASE', 'utf8');
    const retry = await run({ release: '26.9.2', transition });
    expect(retry).toEqual({ action: 'skipped', reason: 'same-release' });
    await expect(prepareRealmForRelease({
      dbPath,
      releaseIdentity: '26.9.1',
      transition,
      restoreSnapshot: () => { throw new Error('must not restore'); },
    })).rejects.toThrow(/no matching pre-migration snapshot/);
  });

  it('fails before migration when the generation marker cannot be published', async () => {
    // rename over a directory is a deterministic failure even when tests run as
    // root, unlike permission bits.
    const marker = realmReleaseMarkerPath(dbPath);
    rmSync(marker, { force: true });
    mkdirSync(marker);

    await expect(run({ release: '26.9.2' })).rejects.toThrow();
    expect(readFileSync(dbPath, 'utf8')).toBe('ORIGINAL DATABASE BYTES');
  });

  it('fails before migration when snapshot failure cannot be durably tombstoned', async () => {
    mkdirSync(realmSnapshotMetadataPath(dbPath));
    await expect(run({
      release: '26.9.2',
      takeSnapshot: () => Promise.reject(new Error('disk full')),
    })).rejects.toThrow();
    expect(existsSync(realmReleaseMarkerPath(dbPath))).toBe(false);
    expect(readFileSync(dbPath, 'utf8')).toBe('ORIGINAL DATABASE BYTES');
  });

  it('treats an unreadable marker as an unknown generation and snapshots', async () => {
    writeFileSync(realmReleaseMarkerPath(dbPath), '', 'utf8');
    const outcome = await run({ release: '26.9.2' });
    expect(outcome).toEqual({ action: 'snapshot-taken', from: null, to: '26.9.2' });
  });

  it('keys every sidecar on the full database identity, including sibling realms', async () => {
    const other = join(dir, 'nested');
    expect(realmReleaseMarkerPath(dbPath)).not.toBe(
      realmReleaseMarkerPath(join(other, 'other.db')),
    );
    expect(realmSnapshotPath(dbPath)).not.toBe(realmSnapshotPath(join(dir, 'other.db')));
    expect(realmSnapshotMetadataPath(dbPath)).not.toBe(
      realmSnapshotMetadataPath(join(dir, 'other.db')),
    );
  });

  it('never restores realm A into realm B when both databases share a directory', async () => {
    const a = dbPath;
    const b = join(dir, 'second.db');
    writeFileSync(a, 'REALM-A');
    writeFileSync(b, 'REALM-B');
    const transition: ReleaseGenerationTransition = {
      schema: 1,
      from_version: '26.9.1',
      to_version: '26.9.2',
      migration: true,
    };
    const snapshot = async (realm: string): Promise<void> => {
      await snapshotRealmOnNewRelease({
        dbPath: realm,
        releaseIdentity: '26.9.2',
        hasInFlightApply: () => false,
        transition,
        takeSnapshot: async (destination) => {
          writeFileSync(destination, readFileSync(realm));
        },
      });
    };
    await snapshot(a);
    await snapshot(b);
    writeFileSync(a, 'REALM-A-MIGRATED');
    writeFileSync(b, 'REALM-B-MIGRATED');

    await prepareRealmForRelease({
      dbPath: b,
      releaseIdentity: '26.9.1',
      transition,
      restoreSnapshot: (source) => writeFileSync(b, readFileSync(source)),
    });

    expect(readFileSync(b, 'utf8')).toBe('REALM-B');
    expect(readFileSync(a, 'utf8')).toBe('REALM-A-MIGRATED');
  });
});
