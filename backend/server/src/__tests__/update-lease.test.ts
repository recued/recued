/** The update lease (audit finding 5) — cross-process mutual exclusion.
 *
 *  ⛔ THE POINT OF EVERY ARM HERE IS THE SECOND CALLER. A lock that one process
 *  can take is not a lock; what matters is what the next one sees. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireUpdateLease,
  inspectUpdateLease,
  updateLeasePathFor,
  UpdateLeaseHeldError,
} from '../update/update-lease.js';

describe('acquireUpdateLease', () => {
  let dir: string;
  let leasePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'update-lease-'));
    leasePath = join(dir, 'recued-update.lock');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const take = (over: Partial<Parameters<typeof acquireUpdateLease>[0]> = {}) =>
    acquireUpdateLease({ identify: () => null, leasePath, operation: 'apply', now: () => 1, ...over });

  it('a SECOND process is refused while the first holds it', () => {
    take({ currentPid: () => 100 });
    expect(() => take({ currentPid: () => 200, isAlive: () => true }))
      .toThrow(UpdateLeaseHeldError);
  });

  it('names the holder, so the refusal can say who and what', () => {
    take({ currentPid: () => 100, operation: 'apply' });
    try {
      take({ currentPid: () => 200, isAlive: () => true });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(UpdateLeaseHeldError);
      expect((err as UpdateLeaseHeldError).holder).toMatchObject({ pid: 100, operation: 'apply' });
    }
  });

  it('releases, and the next caller then gets it', () => {
    const first = take({ currentPid: () => 100 });
    first.release();
    expect(existsSync(leasePath)).toBe(false);
    expect(() => take({ currentPid: () => 200, isAlive: () => true })).not.toThrow();
  });

  it('is RE-ENTRANT within one process, and the inner scope cannot free the outer', () => {
    // The CLI holds it across resolve → download → apply, and `runApply` asks
    // again underneath. Without this the process would deadlock against itself;
    // without the no-op release, the inner scope would drop the outer's lease
    // mid-download.
    const outer = take({ currentPid: () => 100 });
    const inner = take({ currentPid: () => 100 });
    expect(inner.reentrant).toBe(true);
    inner.release();
    expect(existsSync(leasePath), 'the inner release must not delete the file').toBe(true);
    outer.release();
    expect(existsSync(leasePath)).toBe(false);
  });

  it('reclaims a lease whose holder is DEAD', () => {
    take({ currentPid: () => 100 });
    const lease = take({ currentPid: () => 200, isAlive: () => false });
    expect(lease.reentrant).toBe(false);
    expect(JSON.parse(readFileSync(leasePath, 'utf-8')).pid).toBe(200);
  });

  it('⛔ EPERM COUNTS AS ALIVE — a holder owned by another user is respected', () => {
    // The signal was refused because the process belongs to someone else, which
    // is exactly a holder to respect. Reading it as "dead" would let a second
    // updater run under a live one.
    take({ currentPid: () => 100 });
    const epermIsAlive = (): boolean => {
      try {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    };
    expect(() => take({ currentPid: () => 200, isAlive: epermIsAlive }))
      .toThrow(UpdateLeaseHeldError);
  });

  it('⛔⛔ REFUSES an illegible lease — it must NEVER delete one on a guess', () => {
    // THIS ARM USED TO ASSERT THE OPPOSITE, and asserting the opposite is what
    // let the lease hand out two holders. The claim was `open(wx)` then write, so
    // a lease was briefly visible EMPTY; a second process arriving in that window
    // read it as corrupt, took this reclaim path, unlinked the WINNER'S file and
    // claimed its own. Reported from a machine whose timing differed: 3 winners
    // out of 8. Reproduced deterministically in the concurrency suite.
    //
    // With `link()` the lease is complete the instant it exists, so an unreadable
    // one is a foreign file or a pre-fix leftover — neither is something to
    // delete on a guess. Fail closed; a human can remove it.
    writeFileSync(leasePath, '{"pid":', 'utf-8');
    expect(() => take({ currentPid: () => 200, isAlive: () => true }))
      .toThrow(UpdateLeaseHeldError);
    expect(readFileSync(leasePath, 'utf-8'), 'the illegible file must be LEFT ALONE')
      .toBe('{"pid":');
  });

  it('the lease file is never observable in a partially-written state', () => {
    // The window itself, asserted directly: whatever exists at the path must
    // always parse. `link()` is what guarantees it.
    const lease = take({ currentPid: () => 100 });
    const raw = readFileSync(leasePath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toMatchObject({ pid: 100, operation: 'apply' });
    lease.release();
  });

  it('release does NOT delete a lease that was reclaimed away from us', () => {
    // Ownership is proven by a per-acquisition token, not by pid: after a stale
    // reclaim two holders can share a pid's worth of belief about one path.
    const mine = take({ currentPid: () => 100 });
    // Someone else legitimately took over (we were declared dead).
    rmSync(leasePath, { force: true });
    take({ currentPid: () => 300 });
    const theirs = readFileSync(leasePath, 'utf-8');
    mine.release();
    expect(readFileSync(leasePath, 'utf-8'), 'our release must not remove theirs')
      .toBe(theirs);
  });

  it('release is idempotent', () => {
    const lease = take({ currentPid: () => 100 });
    lease.release();
    expect(() => lease.release()).not.toThrow();
  });
});

describe('the lease guards the EXECUTABLE, not the realm', () => {
  let binDir: string;
  beforeEach(() => { binDir = mkdtempSync(join(tmpdir(), 'recued-bin-')); });
  afterEach(() => rmSync(binDir, { recursive: true, force: true }));

  /** ⛔⛔ IT USED TO SIT BESIDE EACH REALM DATABASE — one derivation keyed on
   *  `dataDir` in release-config, another keyed on the db path in the CLI. But
   *  a host can run SEVERAL realms against ONE installed binary, and the
   *  `.staged` / `.old` paths they race are derived from that binary. Two realms
   *  therefore took two DIFFERENT locks while mutating the same three files:
   *  two locks and no mutex. */
  it('two realms sharing one binary resolve to the SAME lease path', () => {
    const binary = '/usr/local/lib/recued/recued';
    expect(updateLeasePathFor(binary)).toBe('/usr/local/lib/recued/recued-update.lock');
    // The realm plays no part in it — that is the whole point.
    expect(updateLeasePathFor(binary)).toBe(updateLeasePathFor(binary));
  });

  it('different binaries are still independent', () => {
    // Two genuinely separate installs must not block each other.
    expect(updateLeasePathFor('/opt/a/recued'))
      .not.toBe(updateLeasePathFor('/opt/b/recued'));
  });

  it('⛔ and the second realm is then actually REFUSED', () => {
    // The property the path derivation exists for, driven rather than inferred.
    const binary = join(binDir, 'recued');
    const first = acquireUpdateLease({ identify: () => null,
      leasePath: updateLeasePathFor(binary), operation: 'apply', currentPid: () => 100,
    });
    expect(() => acquireUpdateLease({ identify: () => null,
      leasePath: updateLeasePathFor(binary),
      operation: 'apply',
      currentPid: () => 200,
      isAlive: () => true,
    })).toThrow(UpdateLeaseHeldError);
    first.release();
  });
});

describe('stale reclamation is a critical section', () => {
  /** ⛔⛔ THE RACE TEST DOES NOT CATCH THIS, AND I CHECKED. Eight processes
   *  racing a stale lease passed both with and without the fix on this machine —
   *  the interleave is too narrow to hit by scheduling. So it is CONSTRUCTED:
   *  `isAlive` is an injected callback, called with the stale holder at exactly
   *  the moment between observing it and acting on it, so a side effect there IS
   *  the other process finishing its reclaim.
   *
   *  The bug: the unlink was unconditional, based on that earlier observation, so
   *  it erased the fresh holder that had appeared in between. */
  let dir2: string;
  let lease2: string;
  beforeEach(() => {
    dir2 = mkdtempSync(join(tmpdir(), 'lease-reclaim-'));
    lease2 = join(dir2, 'recued-update.lock');
  });
  afterEach(() => rmSync(dir2, { recursive: true, force: true }));

  const seedStale = (): void => {
    writeFileSync(lease2, JSON.stringify({
      pid: 4_194_303, operation: 'apply', at: 1, token: 'stale-token',
    }));
  };

  it('⛔ does NOT erase a holder that appeared since the staleness was observed', () => {
    seedStale();
    let interleaved = false;
    expect(() => acquireUpdateLease({ identify: () => null,
      leasePath: lease2,
      operation: 'apply',
      currentPid: () => 200,
      isAlive: () => {
        // Another process completes its reclaim RIGHT HERE — after we read the
        // stale holder, before we act on it.
        if (!interleaved) {
          interleaved = true;
          writeFileSync(lease2, JSON.stringify({
            pid: 300, operation: 'apply', at: 2, token: 'fresh-token',
          }));
        }
        return false;   // we still believe the holder we READ is dead
      },
    }), 'the reclaim must abort once the file is no longer the lease we judged')
      .toThrow(UpdateLeaseHeldError);

    const onDisk = JSON.parse(readFileSync(lease2, 'utf-8'));
    expect(onDisk.token, "the fresh holder's lease must survive").toBe('fresh-token');
    expect(onDisk.pid).toBe(300);
  });

  it('refuses while another process is mid-reclaim, and leaves the lease alone', () => {
    // The serialisation half: a `.reclaim` file means someone else is in the
    // section. Deleting the stale lease from outside it is the same bug.
    seedStale();
    writeFileSync(`${lease2}.reclaim`, '');
    expect(() => acquireUpdateLease({ identify: () => null,
      leasePath: lease2, operation: 'apply', currentPid: () => 200, isAlive: () => false,
    })).toThrow(UpdateLeaseHeldError);
    expect(existsSync(lease2), 'the stale lease must not be removed from outside').toBe(true);
  });

  it('a successful reclaim releases the reclaim lock', () => {
    seedStale();
    const lease = acquireUpdateLease({ identify: () => null,
      leasePath: lease2, operation: 'apply', currentPid: () => 200, isAlive: () => false,
    });
    expect(existsSync(`${lease2}.reclaim`), 'the reclaim lock must not leak').toBe(false);
    expect(JSON.parse(readFileSync(lease2, 'utf-8')).pid).toBe(200);
    lease.release();
  });
});

/** A lease outlives an update that died uncleanly, and its PID can then name an
 *  unrelated live process. Judged by the PID alone, boot read that as an update
 *  in progress and exited 4, and every later update was refused until a human
 *  deleted the file. `proc_start` tells the writer from a process given its
 *  number later; unknown on either side keeps the PID's verdict. Real processes
 *  and the real identity: `stale-lock-reused-pid.test.ts`. */
describe('update lease — a PID reused after an update that died', () => {
  let dir: string;
  let leasePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'update-lease-reuse-'));
    leasePath = join(dir, 'recued-update.lock');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const heldBy100 = (procStart?: string): void => writeFileSync(leasePath, JSON.stringify({
    pid: 100, operation: 'apply', at: 1, token: 'old-token',
    ...(procStart !== undefined ? { proc_start: procStart } : {}),
  }));
  const claimAs200 = (starts: Record<number, string>) => acquireUpdateLease({
    leasePath, operation: 'install', currentPid: () => 200, isAlive: (pid) => pid === 100,
    identify: (pid) => starts[pid] ?? null,
  });

  it('⛔ a live PID that started at another time is not the holder: the next update claims it', () => {
    heldBy100('start-A');
    const lease = claimAs200({ 100: 'start-B', 200: 'start-mine' });
    expect(JSON.parse(readFileSync(leasePath, 'utf-8'))).toMatchObject({ pid: 200, proc_start: 'start-mine' });
    lease.release();
  });

  it('still refuses while the PID is the process that took it', () => {
    heldBy100('start-A');
    expect(() => claimAs200({ 100: 'start-A' })).toThrow(UpdateLeaseHeldError);
  });

  it('⚠ refuses on the PID alone when the start cannot be read — unknown is not proof', () => {
    heldBy100('start-A');
    expect(() => claimAs200({})).toThrow(UpdateLeaseHeldError);
  });

  it('judges a lease from before start identities were kept by its PID, as before', () => {
    heldBy100();
    expect(() => claimAs200({ 100: 'start-B' })).toThrow(UpdateLeaseHeldError);
  });

  it('⛔ boot asks the same: a reused PID is nobody updating, the writer is', () => {
    heldBy100('start-A');
    expect(inspectUpdateLease(leasePath, () => 'start-B', () => true)).toBeNull();
    expect(inspectUpdateLease(leasePath, () => 'start-A', () => true)?.pid).toBe(100);
    expect(inspectUpdateLease(leasePath, () => null, () => true)?.pid).toBe(100);
  });

  it('writes no start where the platform cannot say', () => {
    const lease = claimAs200({});
    expect(JSON.parse(readFileSync(leasePath, 'utf-8'))).not.toHaveProperty('proc_start');
    lease.release();
  });
});
