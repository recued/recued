/** D-212 — a cross-process reservation over the keyfile's DIRECTORY.
 *
 *  ── The hole this closes ────────────────────────────────────────────
 *  The server keyfile is directory-scoped: every realm whose database sits
 *  in a directory shares the one keyfile there, and enrollment's guard
 *  scans for a sibling realm's bundle before performing a destructive write
 *  over it. That is a check-then-act, and it was serialized only by a
 *  per-process promise chain — so two SEPARATE server processes sharing a
 *  directory could both scan (each seeing no sibling), both write, and leave
 *  the loser's realm with a database intact and unreadable.
 *
 *  Node has no portable advisory file lock, but `link(2)` is atomic and fails
 *  `EEXIST` when the target exists: the record is written to a temp file
 *  first and then LINKED into place, so exactly one caller publishes it and
 *  the reservation is never observed half-written. That is the whole
 *  mechanism, and the "never half-written" half is not decoration — see
 *  `tryCreate`.
 *
 *  ── Why it refuses instead of waiting ───────────────────────────────
 *  A holder means another process is mid-enrollment on this directory, and
 *  the honest answer is "not now" — enrollment already has a `busy` outcome
 *  for exactly this shape (a WAL checkpoint blocked by an open reader), and
 *  it surfaces to a user as "your server is busy finishing encryption setup,
 *  try again in a moment". Blocking would instead hold an rpc open on a lock
 *  whose holder may be seconds or minutes away.
 *
 *  ── Two things that would make it worse than nothing ────────────────
 *  ⛔ **A stale reservation must not wedge the directory forever.** A
 *  process killed mid-enrollment leaves the file behind, and a lock nobody
 *  can clear turns a crash into a permanent refusal to pair. So the holder
 *  is recorded and reclaimed when its pid is gone — the same liveness
 *  discipline `instance-lock.ts` uses.
 *
 *  ⛔ **A release must not delete someone else's reservation.** After a
 *  reclaim, the file on disk belongs to a different holder, and unlinking it
 *  on the way out would hand the directory to a third caller while the
 *  second is still writing. Each reservation carries a nonce and releases
 *  only what it still owns. */

import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Lives beside the keyfile it protects. Dot-prefixed: it is machinery, not
 *  an artifact an operator should have to reason about. */
export const KEYFILE_RESERVATION_FILE = '.recued-keyfile.lock';

export class DirectoryReservationHeldError extends Error {
  readonly code = 'D212_KEYFILE_DIRECTORY_RESERVED';
  constructor(readonly holderPid: number, message: string) {
    super(message);
    this.name = 'DirectoryReservationHeldError';
  }
}

interface ReservationRecord {
  pid: number;
  /** Distinguishes THIS reservation from a later one at the same path, so a
   *  release cannot remove a successor's file. */
  nonce: string;
  at: number;
}

const defaultIsAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readRecord = (path: string): ReservationRecord | null => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null; // vanished between EEXIST and this read — the holder released
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReservationRecord>;
    if (typeof parsed?.pid === 'number' && typeof parsed?.nonce === 'string') {
      return parsed as ReservationRecord;
    }
  } catch { /* malformed */ }
  return null;
};

export interface DirectoryReservationOptions {
  /** Injected for tests; production asks the OS. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  pid?: () => number;
}

/** Hold the directory for the duration of `fn`.
 *
 *  Throws `DirectoryReservationHeldError` when a LIVE holder has it — the
 *  caller decides what that means (enrollment reports `busy`). Any other
 *  error from `fn` propagates untouched, and the reservation is released
 *  either way. */
export const withDirectoryReservation = async <T>(
  dir: string,
  fn: () => Promise<T>,
  opts: DirectoryReservationOptions = {},
): Promise<T> => {
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const pid = (opts.pid ?? (() => process.pid))();
  const path = join(dir, KEYFILE_RESERVATION_FILE);
  const record: ReservationRecord = {
    pid,
    nonce: randomBytes(8).toString('hex'),
    at: (opts.now ?? Date.now)(),
  };

  const tryCreate = (): boolean => {
    // ⛔ Build the file COMPLETE, then publish it atomically.
    //
    // The obvious version — `openSync(path, 'wx')` then `writeSync` — is
    // wrong, and wrong in the direction that defeats the whole lock: between
    // the create and the write the reservation exists and is EMPTY. A
    // contender reading it in that window parses nothing, correctly concludes
    // the record names nobody, treats it as debris, unlinks it, and takes the
    // directory while the first holder is still writing. Both then enter the
    // protected section.
    //
    // `link(2)` closes it: the temp file already holds the record, and the
    // link either publishes it whole or fails EEXIST. There is no moment at
    // which `path` exists without its contents.
    const temp = `${path}.${record.nonce}.tmp`;
    writeFileSync(temp, JSON.stringify(record));
    try {
      linkSync(temp, path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    } finally {
      try { unlinkSync(temp); } catch { /* the link, if it landed, holds the inode */ }
    }
  };

  let held = tryCreate();
  if (!held) {
    const existing = readRecord(path);
    // A record we cannot parse is debris, not a holder: the writer died
    // between create and write, and treating it as live would wedge the
    // directory on a file that names nobody.
    if (existing !== null && isAlive(existing.pid)) {
      throw new DirectoryReservationHeldError(
        existing.pid,
        `Another process (pid ${existing.pid}) is writing the keyfile in ${dir}. `
          + 'Only one may do that at a time — retry in a moment.',
      );
    }
    // Stale. ⛔ Take it out of the way by RENAME, never by unlink.
    //
    // `unlinkSync(path)` here deletes whatever is at that name — and between
    // reading the stale record and acting on it, another reclaimer may have
    // already cleared it and published ITS OWN live reservation. Unlinking
    // then destroys a live holder's lock and lets this caller in beside it.
    // `rename(2)` is atomic and moves the inode we actually observed: two
    // reclaimers cannot both succeed, and the loser falls through to
    // `tryCreate`, where it meets the winner's lock and reports it held.
    const displaced = `${path}.stale-${record.nonce}`;
    try {
      renameSync(path, displaced);
    } catch { /* another reclaimer moved it first — fall through and contend */ }

    // ⛔ Now check WHAT WE TOOK. `rename(2)` is atomic, but it moves whatever
    // sits at that NAME — and between reading the stale record and this line,
    // another reclaimer can have cleared it and published its own LIVE
    // reservation there. Deleting blind would destroy a live holder's lock and
    // let this caller in beside it, which is the exact failure the reservation
    // exists to prevent. Atomicity was never the missing property; IDENTITY
    // was.
    const taken = readRecord(displaced);
    const isTheStaleOne = taken === null
      ? existing === null            // debris we judged, still debris
      : taken.nonce === existing?.nonce;
    if (!isTheStaleOne) {
      // A successor. Put it back and stand down — it is not ours to remove,
      // and its holder is the one to report.
      try { renameSync(displaced, path); } catch { /* best effort */ }
      throw new DirectoryReservationHeldError(
        taken?.pid ?? -1,
        `Another process took the keyfile reservation in ${dir} while this one was `
          + 'clearing a stale entry. Retry in a moment.',
      );
    }
    try { unlinkSync(displaced); } catch { /* best effort */ }
    held = tryCreate();
    if (!held) {
      const next = readRecord(path);
      throw new DirectoryReservationHeldError(
        next?.pid ?? -1,
        `Another process took the keyfile reservation in ${dir} while this one was `
          + 'clearing a stale entry. Retry in a moment.',
      );
    }
  }

  try {
    return await fn();
  } finally {
    // ⛔ Release only what we still own. If this reservation was judged stale
    // and reclaimed by someone else, the file now belongs to them, and
    // unlinking it would hand the directory to a third caller mid-write.
    const current = readRecord(path);
    if (current?.nonce === record.nonce) {
      try {
        unlinkSync(path);
      } catch { /* already gone — nothing to release */ }
    }
  }
};
