/** D-178 I-10 — the anti-replay floor that belongs to the INSTALL, not a realm.
 *
 *  ⛔⛔ WHAT WAS WRONG. The floor was described as "a property of the HOST" and
 *  was not one. Server acceptance persisted only in the realm's own SQLite
 *  (`release-state-store.ts`), so realm A accepting sequence 300 did nothing to
 *  stop realm B — same executable, same machine, its own database — from later
 *  accepting a replayed, still-validly-signed sequence 250. Running two realms
 *  on one host is a supported configuration; `update-lease.ts` says so in as
 *  many words, which is why the lease is keyed on the binary rather than held
 *  for a server's lifetime. The floor was keyed on neither.
 *
 *  🔑 AND THE REASON GIVEN FOR READ-ONLY WAS FALSE. `release-check.ts` explained
 *  that the server does not write this file because it "sits beside the binary,
 *  which on a normal install is root-owned while the server is not" — but the
 *  server already writes `boot-failures.json` into that very directory
 *  (`release-config.ts` builds the counter there), and an apply RENAMES the
 *  binary itself in it. On the two channels that can self-apply, that directory
 *  is writable by definition: `SELF_APPLY_CHANNELS` is documented as the
 *  channels "whose binary lives on a writable volume". A stated obstacle nobody
 *  re-checked kept a real gap looking deliberate.
 *
 *  ⚠ SO THE WRITE IS BEST-EFFORT, NOT FAIL-CLOSED. `update.check` runs on every
 *  channel, including ones that never self-apply and may genuinely sit on a
 *  read-only or root-owned prefix. Failing a check because its floor file could
 *  not be advanced would break update NOTIFICATION on exactly the installs that
 *  cannot self-apply anyway. An unwritable floor leaves behaviour precisely as
 *  it was — per-realm — and says so in the outcome rather than throwing.
 *
 *  ⛔ THE ONE-INTEGER FORMAT IS A SHIPPED CONTRACT. install.sh reads this file
 *  with `tr -cd '0-9'`, which CONCATENATES the digits of every line it finds —
 *  so a two-line file reading "100\n300" is not "the max is 300", it is the
 *  floor 100300, and every future release is refused as a replay forever. Any
 *  richer encoding (a log, JSON, a max-of-lines) has to change install.sh in
 *  the same commit or it bricks updates. It stays one decimal integer and a
 *  newline, byte-for-byte what `printf '%s\n'` writes.
 *
 *  ⛔⛔ AND THE "BOUNDED" RACE THIS COMMENT ONCE CLAIMED WAS NOT BOUNDED. It said
 *  install.sh writing without the lock was survivable because "both writers only
 *  ever RAISE, each write is atomic, so the file never moves backwards". That is
 *  false, and the counter-example is two lines long:
 *
 *      floor 100 · the shell reads 100 and decides 200 · we take the lock and
 *      write 300 · the shell renames 200 into place  ->  the floor is 200
 *
 *  It never goes below what THAT WRITER read, which is a different and much
 *  weaker claim than the one made. An atomic rename prevents a TORN file, never a
 *  lost update. ⇒ install.sh now advances through `recued release-floor raise`,
 *  so both writers take this lock.
 *
 *  🔑 SELF-HEALING STILL MATTERS, for the writer that cannot reach the verb (a
 *  binary too old to know it) and for a floor left behind by an unwritable
 *  prefix. The caller advances on every non-replay resolution rather than only
 *  when the realm's own value moves, so the next check re-converges it from
 *  SQLite.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireUpdateLease, UpdateLeaseHeldError } from './update-lease.js';

/** Beside the binary, and named by install.sh — this is its file too. */
export const HOST_SEQUENCE_FLOOR_FILE = '.release-sequence';

export const hostSequenceFloorPathFor = (binaryDir: string): string =>
  join(binaryDir, HOST_SEQUENCE_FLOOR_FILE);

/** The floor on disk, or 0 when absent, unreadable or malformed.
 *
 *  ⚠ 0, NEVER A THROW. A missing file is the normal state of a host that has
 *  never run a new-enough installer, and an unreadable one must not be able to
 *  abort a check — it contributes nothing and the realm's own floor still
 *  applies. Mirrors install.sh's own "floor file unreadable: nothing to compare
 *  against". */
export const readHostSequenceFloor = (floorPath: string): number => {
  try {
    const n = Number(readFileSync(floorPath, 'utf8').trim());
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
};

export type AdvanceFloorOutcome =
  /** The file now holds `sequence`. */
  | 'advanced'
  /** Already at or above it — including a sequence that is not a candidate. */
  | 'unchanged'
  /** Another process holds the floor lock; it is advancing the same file. */
  | 'contended'
  /** The directory or file cannot be written. Behaviour stays per-realm. */
  | 'unwritable';

export interface AdvanceFloorOptions {
  now?: () => number;
  currentPid?: () => number;
  isAlive?: (pid: number) => boolean;
}

/** Raise the install-wide floor to `sequence`, never lower it.
 *
 *  ⛔ READ-MODIFY-WRITE UNDER A LOCK, AND NOT THE UPDATE LEASE. Taking
 *  `recued-update.lock` here would make a routine scheduled check contend with —
 *  and briefly block — an in-flight apply, turning a read-only question into a
 *  denial of the actuation path. This is its own short-lived mutex at a
 *  different path, reusing the same `link()`-based claim because that primitive
 *  is already proven atomic (`update-lease-concurrency.test.ts`) and reclaims a
 *  dead holder.
 *
 *  ⚠ THE UNLOCKED PRE-READ IS AN OPTIMISATION ONLY. It keeps the overwhelmingly
 *  common case — nothing to do — off the lock entirely; the decision is re-made
 *  under the lock, which is the one that counts. */
export const advanceHostSequenceFloor = (
  floorPath: string,
  sequence: number,
  opts: AdvanceFloorOptions = {},
): AdvanceFloorOutcome => {
  if (!Number.isInteger(sequence) || sequence < 0) return 'unchanged';
  if (readHostSequenceFloor(floorPath) >= sequence) return 'unchanged';

  let lease;
  try {
    lease = acquireUpdateLease({
      leasePath: `${floorPath}.lock`,
      operation: `advance replay floor to ${sequence}`,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.currentPid ? { currentPid: opts.currentPid } : {}),
      ...(opts.isAlive ? { isAlive: opts.isAlive } : {}),
    });
  } catch (err) {
    // A live holder is doing this same job; anything else is a directory we
    // cannot write, which is the documented per-realm fallback.
    return err instanceof UpdateLeaseHeldError ? 'contended' : 'unwritable';
  }

  const staging = `${floorPath}.next.${process.pid}`;
  try {
    if (readHostSequenceFloor(floorPath) >= sequence) return 'unchanged';
    // Byte-identical to install.sh's `printf '%s\n'`, then renamed into place so
    // no reader — the server, install.sh, or the launcher — can observe a
    // half-written floor and read it as "unreadable, nothing to compare".
    writeFileSync(staging, `${sequence}\n`, 'utf8');
    renameSync(staging, floorPath);
    return 'advanced';
  } catch {
    try { rmSync(staging, { force: true }); } catch { /* nothing staged */ }
    return 'unwritable';
  } finally {
    lease.release();
  }
};
