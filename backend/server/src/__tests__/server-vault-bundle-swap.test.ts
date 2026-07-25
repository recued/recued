import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveServerBundlePath } from '../server-bundle-store.js';
import {
  commitPreparedServerBundleSwap,
  prepareServerBundleSwap,
  reconcileServerBundleSwap,
  resolveServerBundleSwapMarkerPath,
} from '../archive/server-bundle-swap.js';

const STAMP = '2023-11-14T22-13-20-000Z-deadbeef';
const dirs: string[] = [];

/** Records every park-reclaim the journal asks for, and — the point of the
 *  whole arrangement — whether the marker still existed at that moment. A
 *  reclaim that runs after the marker is gone is indistinguishable on disk from
 *  a restore that never committed. */
const parkRecorder = (markerPath: string) => {
  const calls: { committed: boolean; markerStillPresent: boolean }[] = [];
  let resolveFully = true;
  return {
    calls,
    reclaim: (committed: boolean): boolean => {
      calls.push({ committed, markerStillPresent: existsSync(markerPath) });
      return resolveFully;
    },
    /** Simulate a park the reclaim could NOT resolve. */
    strand: (): void => { resolveFully = false; },
  };
};

/** The journal's own park-free callers. Explicit rather than defaulted: a
 *  caller that forgets to resolve its parks is the bug this signature exists to
 *  make unwritable. */
const noParks = (): boolean => true;

const setupPair = (): {
  dbPath: string;
  stagingPath: string;
  bundlePath: string;
} => {
  const dir = mkdtempSync(join(tmpdir(), 'server-bundle-swap-'));
  dirs.push(dir);
  const dbPath = join(dir, 'recued.db');
  const stagingPath = `${dbPath}.staging-${'a'.repeat(16)}`;
  const bundlePath = resolveServerBundlePath(dbPath);
  writeFileSync(dbPath, 'old-db');
  writeFileSync(bundlePath, 'old-bundle');
  writeFileSync(stagingPath, 'new-db');
  return { dbPath, stagingPath, bundlePath };
};

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('server bundle restore swap journal', () => {
  it('commits the db and bundle as one recoverable pair', () => {
    const { dbPath, stagingPath, bundlePath } = setupPair();
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: STAMP,
      nextBundle: Buffer.from('new-bundle'),
    });

    const result = commitPreparedServerBundleSwap(prepared, noParks);

    expect(readFileSync(dbPath, 'utf8')).toBe('new-db');
    expect(readFileSync(bundlePath, 'utf8')).toBe('new-bundle');
    expect(readFileSync(prepared.dbBackupPath, 'utf8')).toBe('old-db');
    expect(readFileSync(prepared.bundleBackupPath, 'utf8')).toBe('old-bundle');
    expect(result.dbBackupPath).toBe(prepared.dbBackupPath);
    expect(result.backups).toEqual([
      prepared.dbBackupPath,
      prepared.bundleBackupPath,
    ]);
    expect(existsSync(prepared.markerPath)).toBe(false);
  });

  it('rolls the old pair back when a crash happens before the db commit point', () => {
    const { dbPath, stagingPath, bundlePath } = setupPair();
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: STAMP,
      nextBundle: Buffer.from('new-bundle'),
    });

    // Simulate a process death after both old artifacts moved aside but before
    // the staged db reached the live path.
    renameSync(dbPath, prepared.dbBackupPath);
    renameSync(bundlePath, prepared.bundleBackupPath);

    expect(reconcileServerBundleSwap(dbPath, noParks).recovery).toBe('rolled_back');
    expect(readFileSync(dbPath, 'utf8')).toBe('old-db');
    expect(readFileSync(bundlePath, 'utf8')).toBe('old-bundle');
    expect(existsSync(stagingPath)).toBe(false);
    expect(existsSync(prepared.stagedBundlePath)).toBe(false);
    expect(existsSync(prepared.markerPath)).toBe(false);
  });

  it('finishes the new pair when a crash happens after the db commit point', () => {
    const { dbPath, stagingPath, bundlePath } = setupPair();
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: STAMP,
      nextBundle: Buffer.from('new-bundle'),
    });

    // Simulate a process death in the only dangerous window: new db is live,
    // but its matching bundle is still staged and the marker remains.
    renameSync(dbPath, prepared.dbBackupPath);
    renameSync(bundlePath, prepared.bundleBackupPath);
    renameSync(stagingPath, dbPath);

    expect(reconcileServerBundleSwap(dbPath, noParks).recovery).toBe('completed');
    expect(readFileSync(dbPath, 'utf8')).toBe('new-db');
    expect(readFileSync(bundlePath, 'utf8')).toBe('new-bundle');
    expect(readFileSync(prepared.dbBackupPath, 'utf8')).toBe('old-db');
    expect(readFileSync(prepared.bundleBackupPath, 'utf8')).toBe('old-bundle');
    expect(existsSync(prepared.markerPath)).toBe(false);
  });

  it('fails closed on a marker that tries to escape the db directory', () => {
    const { dbPath, stagingPath } = setupPair();
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: STAMP,
      nextBundle: Buffer.from('new-bundle'),
    });
    const marker = JSON.parse(readFileSync(prepared.markerPath, 'utf8'));
    marker.staging_name = '../../victim.db';
    writeFileSync(prepared.markerPath, JSON.stringify(marker));

    expect(() => reconcileServerBundleSwap(dbPath, noParks)).toThrow(
      /ARCHIVE_RESTORE_BUNDLE_SWAP_INVALID/,
    );
    expect(readFileSync(dbPath, 'utf8')).toBe('old-db');
    expect(readFileSync(stagingPath, 'utf8')).toBe('new-db');
    expect(existsSync(resolveServerBundleSwapMarkerPath(dbPath))).toBe(true);
  });
});

describe('the journal owns the restore CAS parks', () => {
  // The bug this closes: parks were reaped by the CALLER, after the commit had
  // already released the marker. A kill in that gap leaves "parks present, no
  // marker" — which boot reads as an uncommitted restore and rolls the
  // PRE-restore bytes back over the objects the NEW database references.
  // Reproduced end-to-end as: live_db = "new-db", live_blob = "pre-restore".
  it('reaps parks BEFORE the commit releases the marker', () => {
    const { dbPath, stagingPath } = setupPair();
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: STAMP,
      nextBundle: Buffer.from('new-bundle'),
    });
    const parks = parkRecorder(prepared.markerPath);

    commitPreparedServerBundleSwap(prepared, parks.reclaim);

    // `committed: true` is the verdict; `markerStillPresent: true` is the whole
    // property — the reclaim ran while the journal could still justify it.
    expect(parks.calls).toEqual([{ committed: true, markerStillPresent: true }]);
    expect(existsSync(prepared.markerPath)).toBe(false);
  });

  it('puts parks back BEFORE a rollback releases the marker', () => {
    const { dbPath, stagingPath, bundlePath } = setupPair();
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: STAMP,
      nextBundle: Buffer.from('new-bundle'),
    });
    const parks = parkRecorder(prepared.markerPath);
    renameSync(dbPath, prepared.dbBackupPath);
    renameSync(bundlePath, prepared.bundleBackupPath);

    expect(reconcileServerBundleSwap(dbPath, parks.reclaim).recovery).toBe('rolled_back');

    expect(parks.calls).toEqual([{ committed: false, markerStillPresent: true }]);
  });

  it('finishes parks forward BEFORE a post-commit recovery releases the marker', () => {
    const { dbPath, stagingPath, bundlePath } = setupPair();
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: STAMP,
      nextBundle: Buffer.from('new-bundle'),
    });
    const parks = parkRecorder(prepared.markerPath);
    renameSync(dbPath, prepared.dbBackupPath);
    renameSync(bundlePath, prepared.bundleBackupPath);
    renameSync(stagingPath, dbPath);

    expect(reconcileServerBundleSwap(dbPath, parks.reclaim).recovery).toBe('completed');

    expect(parks.calls).toEqual([{ committed: true, markerStillPresent: true }]);
  });

  // ⛔ The park helpers are best-effort — they must never fail a boot over a
  // file they cannot move. Without a completeness REPORT that politeness turns
  // into "release the marker anyway", stranding a park with no journal left to
  // interpret it: the original defect, through a rarer door.
  it('KEEPS the marker when a park could not be reaped at commit', () => {
    const { dbPath, stagingPath } = setupPair();
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: STAMP,
      nextBundle: Buffer.from('new-bundle'),
    });
    const parks = parkRecorder(prepared.markerPath);
    parks.strand();

    commitPreparedServerBundleSwap(prepared, parks.reclaim);

    // The swap itself committed — that is not in question.
    expect(readFileSync(dbPath, 'utf8')).toBe('new-db');
    // …but the journal stays, so the next boot reconciles forward and reaps the
    // straggler with the verdict still attached.
    expect(existsSync(prepared.markerPath)).toBe(true);
    const retry = reconcileServerBundleSwap(dbPath, noParks);
    expect(retry).toEqual({ recovery: 'completed', retired: true });
    expect(existsSync(prepared.markerPath)).toBe(false);
  });

  it('KEEPS the marker AND the staged db when a park could not be put back', () => {
    const { dbPath, stagingPath, bundlePath } = setupPair();
    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: STAMP,
      nextBundle: Buffer.from('new-bundle'),
    });
    const parks = parkRecorder(prepared.markerPath);
    parks.strand();
    renameSync(dbPath, prepared.dbBackupPath);
    renameSync(bundlePath, prepared.bundleBackupPath);

    // ⛔ `retired: false` is the load-bearing half — the pair WAS repaired, so
    // the verdict alone reads as "settled" and callers about to start new work
    // acted on it. They must gate on `retired`.
    expect(reconcileServerBundleSwap(dbPath, parks.reclaim))
      .toEqual({ recovery: 'rolled_back', retired: false });

    // ⛔ Both, together. This branch is SELECTED by the staged db existing, so
    // keeping the marker while dropping the staging would send the next
    // reconcile down the COMMITTED branch — reaping the very parks still owed a
    // restore. Proven by re-reconciling: it must roll back again, not complete.
    expect(existsSync(prepared.markerPath)).toBe(true);
    expect(existsSync(stagingPath)).toBe(true);
    expect(reconcileServerBundleSwap(dbPath, noParks).recovery).toBe('rolled_back');
  });

  it('never asks for a verdict when there is no journal to give one', () => {
    const { dbPath } = setupPair();
    const parks = parkRecorder(resolveServerBundleSwapMarkerPath(dbPath));

    expect(reconcileServerBundleSwap(dbPath, parks.reclaim).recovery).toBe('none');

    // No marker means no swap ever reached the point of having one, so the
    // journal has nothing to say about any park. That call belongs to boot,
    // which knows the answer is "the old database survived".
    expect(parks.calls).toEqual([]);
  });
});

describe('staging refuses to start on unsettled ground', () => {
  // `prepareServerBundleSwap` used to reconcile an older interrupted swap
  // itself. That ran AFTER the caller had streamed the archive — too late for
  // the encryption-posture gate, which had already asked "is this realm
  // encrypted?" while the realm's bundle sidecar sat parked under the older
  // swap's backup name, and been told no.
  it('refuses to stage while an unreconciled marker exists', () => {
    const { dbPath, stagingPath } = setupPair();
    prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: STAMP,
      nextBundle: Buffer.from('new-bundle'),
    });

    expect(() =>
      prepareServerBundleSwap({
        dbPath,
        stagingDbPath: stagingPath,
        stamp: '2023-11-14T22-13-20-000Z-cafebabe',
        nextBundle: Buffer.from('newer-bundle'),
      }),
    ).toThrow(/ARCHIVE_RESTORE_BUNDLE_SWAP_STATE_CHANGED/);
  });

  it('refuses a swap that would drop the realm bundle without a replacement', () => {
    // The act-site half of the downgrade refusal, re-derived from the exact
    // marker fields the commit consumes: park the sidecar, publish nothing.
    const { dbPath, stagingPath, bundlePath } = setupPair();
    expect(existsSync(bundlePath)).toBe(true);

    expect(() =>
      prepareServerBundleSwap({ dbPath, stagingDbPath: stagingPath, stamp: STAMP }),
    ).toThrow(/D212_REALM_DOWNGRADE_REFUSED/);

    // Refused before anything was staged — the realm is untouched.
    expect(existsSync(resolveServerBundleSwapMarkerPath(dbPath))).toBe(false);
    expect(readFileSync(bundlePath, 'utf8')).toBe('old-bundle');
    expect(readFileSync(dbPath, 'utf8')).toBe('old-db');
  });

  it('still allows a keyless swap on a realm that has no bundle', () => {
    // The neighbouring case the refusal must not catch: keyless → keyless.
    const { dbPath, stagingPath, bundlePath } = setupPair();
    rmSync(bundlePath);

    const prepared = prepareServerBundleSwap({
      dbPath,
      stagingDbPath: stagingPath,
      stamp: STAMP,
    });
    commitPreparedServerBundleSwap(prepared, noParks);

    expect(readFileSync(dbPath, 'utf8')).toBe('new-db');
    expect(existsSync(bundlePath)).toBe(false);
  });
});

