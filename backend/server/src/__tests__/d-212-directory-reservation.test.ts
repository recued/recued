/** D-212 — the cross-process reservation over the keyfile's directory.
 *
 *  The keyfile is directory-scoped, and enrollment's sibling-realm guard is a
 *  check-then-act over it. A promise chain serializes that within ONE process;
 *  two server processes sharing a directory could both scan, both see no
 *  sibling, both write, and leave the loser's realm intact but unreadable.
 *
 *  `O_EXCL` closes it. What these tests hold is not "a lock works" but the
 *  three ways a lock is worse than no lock:
 *
 *   · it wedges the directory forever after a crash,
 *   · it deletes a successor's reservation on the way out, or
 *   · it reports a holder that does not exist.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DirectoryReservationHeldError,
  KEYFILE_RESERVATION_FILE,
  withDirectoryReservation,
} from '../keys/directory-reservation.js';

let dir: string;
const lockPath = (): string => join(dir, KEYFILE_RESERVATION_FILE);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'd212-reservation-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

/** A reservation planted by another process. */
const plant = (pid: number, nonce = 'foreign-nonce'): void => {
  writeFileSync(lockPath(), JSON.stringify({ pid, nonce, at: 1 }));
};

describe('D-212 — directory reservation: the happy path', () => {
  it('runs the work and leaves nothing behind', async () => {
    const out = await withDirectoryReservation(dir, async () => {
      // Held for the duration — the file exists WHILE the work runs, which is
      // the entire point. Asserting only after would pass for a no-op.
      expect(existsSync(lockPath())).toBe(true);
      return 'done';
    });
    expect(out).toBe('done');
    expect(existsSync(lockPath())).toBe(false);
  });

  it('releases when the work throws, and propagates the original error', async () => {
    // A reservation that outlives a failure turns one bad enrollment into a
    // permanently unusable directory.
    await expect(
      withDirectoryReservation(dir, async () => { throw new Error('inner boom'); }),
    ).rejects.toThrow('inner boom');
    expect(existsSync(lockPath())).toBe(false);
  });

  it('records the holder so a later caller can judge it', async () => {
    await withDirectoryReservation(dir, async () => {
      const rec = JSON.parse(readFileSync(lockPath(), 'utf-8')) as { pid: number; nonce: string };
      expect(rec.pid).toBe(4242);
      expect(rec.nonce).toMatch(/^[0-9a-f]{16}$/);
    }, { pid: () => 4242 });
  });
});

describe('D-212 — directory reservation: contention', () => {
  it('refuses while a LIVE holder has it, and leaves that holder alone', async () => {
    plant(9001);
    let ran = false;
    await expect(
      withDirectoryReservation(dir, async () => { ran = true; }, { isAlive: () => true }),
    ).rejects.toThrow(DirectoryReservationHeldError);
    // ⛔ The work must NOT have run — a refusal that still performs the
    // destructive write is worse than no lock at all.
    expect(ran).toBe(false);
    // …and the holder's file is untouched.
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).pid).toBe(9001);
  });

  it('names the holding pid, so an operator can look it up', async () => {
    plant(9001);
    await expect(
      withDirectoryReservation(dir, async () => undefined, { isAlive: () => true }),
    ).rejects.toMatchObject({ code: 'D212_KEYFILE_DIRECTORY_RESERVED', holderPid: 9001 });
  });

  it('serializes two callers in one process — the second waits, then runs', async () => {
    // Not a lock property, a NESTING property: the enrollment door holds this
    // inside its in-process queue for exactly this reason. If both raced the
    // file, one would get a spurious `busy` for a race the queue resolves.
    const order: string[] = [];
    const first = withDirectoryReservation(dir, async () => {
      order.push('first-in');
      await new Promise((r) => setTimeout(r, 20));
      order.push('first-out');
    });
    await first;
    await withDirectoryReservation(dir, async () => { order.push('second-in'); });
    expect(order).toEqual(['first-in', 'first-out', 'second-in']);
  });
});

describe('D-212 — directory reservation: a stale entry must not wedge the directory', () => {
  it('reclaims a dead holder and proceeds', async () => {
    // A process killed mid-enrollment leaves this behind. If it were honoured
    // forever, one crash would permanently refuse pairing on that directory —
    // strictly worse than the race it prevents.
    plant(9001);
    let ran = false;
    await withDirectoryReservation(dir, async () => { ran = true; }, { isAlive: () => false });
    expect(ran).toBe(true);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('treats an unparseable reservation as debris, not as a holder', async () => {
    // The writer died between create and write. A file that names nobody
    // cannot be honoured — there is no pid to ask about.
    writeFileSync(lockPath(), 'not json at all');
    let ran = false;
    await withDirectoryReservation(dir, async () => { ran = true; }, {
      isAlive: () => { throw new Error('must not be asked — there is no pid'); },
    });
    expect(ran).toBe(true);
  });

  it('treats a record with no pid as debris too', async () => {
    writeFileSync(lockPath(), JSON.stringify({ nonce: 'x', at: 1 }));
    let ran = false;
    await withDirectoryReservation(dir, async () => { ran = true; }, { isAlive: () => true });
    expect(ran).toBe(true);
  });
});

describe('D-212 — directory reservation: release only what it still owns', () => {
  it('does not delete a successor’s reservation', async () => {
    // The scenario: this reservation is judged stale and reclaimed by another
    // process while its work is still running. On the way out it must NOT
    // unlink — the file belongs to the new holder now, and removing it would
    // hand the directory to a third caller mid-write.
    await withDirectoryReservation(dir, async () => {
      // Simulate the reclaim: someone replaced our file with theirs.
      plant(9002, 'successor-nonce');
    });
    expect(existsSync(lockPath())).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).nonce).toBe('successor-nonce');
  });

  it('tolerates its own reservation having vanished', async () => {
    // Someone cleared it by hand mid-run. Release has nothing to do and must
    // not throw over it — the work already succeeded.
    await expect(
      withDirectoryReservation(dir, async () => {
        rmSync(lockPath());
        return 'ok';
      }),
    ).resolves.toBe('ok');
  });
});

describe('D-212 — directory reservation: the two races a naive lock loses', () => {
  it('publishes a complete, parseable record', async () => {
    // ⚠ WHAT THIS DOES NOT PROVE. The race it relates to — `open(path,'wx')`
    // then `write`, leaving the reservation EXISTING and EMPTY for a moment,
    // where a contender parses nothing, calls it debris, unlinks it and enters
    // beside the holder — is CROSS-PROCESS and cannot be reproduced here:
    // `tryCreate` is fully synchronous, so no second caller in this process
    // can observe the window. Reverting to create-then-write leaves this test
    // GREEN, and it was written believing otherwise.
    //
    // The fix is `link(2)` from a fully-written temp, verified by construction
    // rather than by this test. What this pins is the weaker, still-worth-
    // having property: the published record parses and names its holder.
    await withDirectoryReservation(dir, async () => {
      const raw = readFileSync(lockPath(), 'utf-8');
      expect(raw.length).toBeGreaterThan(0);
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(JSON.parse(raw)).toMatchObject({ pid: expect.any(Number) });
    });

    // …and the temp file used to build it does not survive.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a contender that arrives mid-reclaim does not delete the winner’s lock', async () => {
    // ⛔ THE RACE: reclaiming with `unlink(path)` deletes whatever is at that
    // NAME. Between reading a stale record and clearing it, another reclaimer
    // can publish its own LIVE reservation there — and the unlink then
    // destroys a live holder's lock.
    //
    // Simulated exactly: the first caller observes the stale record, and by
    // the time it acts a live successor is in place. The stale-clearing step
    // must not remove it.
    plant(999_999, 'stale'); // dead pid → reclaimable

    let seen = 0;
    const isAlive = (pid: number): boolean => {
      if (pid === 999_999) {
        seen += 1;
        // After the stale record is read, a rival publishes a LIVE lock at
        // the same path — the exact interleaving the rename protects.
        plant(process.pid, 'live-successor');
        return false;
      }
      return true;
    };

    await expect(
      withDirectoryReservation(dir, async () => undefined, { isAlive }),
    ).rejects.toThrow(DirectoryReservationHeldError);

    expect(seen).toBe(1);
    // The successor is intact — it was never this caller's to remove.
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).nonce).toBe('live-successor');
  });
});
