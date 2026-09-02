/** `recued update-lease` — the host-wide mutex, taken by a caller that is not a
 *  Node process (audit round 4, finding 1).
 *
 *  ⛔ WHAT THIS COVERS THAT THE MUTEX TESTS DO NOT. `update-lease-concurrency`
 *  already proves the claim is atomic across real processes. What is new here is
 *  the PLUMBING — that the lease ends up naming the CALLER's pid rather than
 *  this short-lived process's, that a held lease answers with a status the shell
 *  can branch on, and that a token issued in one process still releases in
 *  another. Those are argument-passing properties, and the real module plus real
 *  files is what proves them.
 *
 *  ⚠ THE EXCLUSION ARM RUNS BOTH ACTUATORS IN ONE OS PROCESS, deliberately and
 *  with the limit stated: it drives the REAL verb and the REAL `acquireUpdateLease`
 *  against one real file, with a LIVE foreign pid as the holder. What it proves is
 *  that the two actuators contend for the same lease — the cross-process atomicity
 *  underneath is proven where it belongs, in the concurrency suite, and is not
 *  re-litigated here. */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runUpdateLeaseProfile, LEASE_HELD, LEASE_TAKEN, LEASE_UNAVAILABLE } from '../cli-context/update-lease.js';
import { acquireUpdateLease, UpdateLeaseHeldError } from '../update/update-lease.js';

const trace = { mark: () => {}, markImport: () => {} } as never;

interface Run { code: number; out: string; err: string[] }
const run = async (args: string[]): Promise<Run> => {
  const r: Run = { code: -1, out: '', err: [] };
  await runUpdateLeaseProfile({
    args,
    bootTrace: trace,
    exit: (c) => { if (r.code === -1) r.code = c; },
    out: (t) => { r.out += t; },
    log: (m) => { r.err.push(m); },
  });
  return r;
};

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-lease-cli-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const leaseFile = (dir: string): string => join(dir, 'recued-update.lock');
/** A pid that is alive and is NOT us — same-pid would be re-entrant. */
const FOREIGN_LIVE_PID = process.ppid;

describe('update-lease claim', () => {
  it('writes the CALLER\'s pid, not this process\'s', async () => {
    // ⛔ THE WHOLE POINT. A lease claimed under our own pid would be stale the
    // instant this command exited, and every later actor would reclaim it — an
    // exclusion that evaporates exactly when the caller starts working.
    await withDir(async (dir) => {
      const r = await run(['update-lease', 'claim', '--bin-dir', dir, '--pid', String(FOREIGN_LIVE_PID)]);
      expect(r.code).toBe(LEASE_TAKEN);
      const holder = JSON.parse(readFileSync(leaseFile(dir), 'utf-8')) as { pid: number; operation: string };
      expect(holder.pid).toBe(FOREIGN_LIVE_PID);
      expect(holder.pid).not.toBe(process.pid);
    });
  });

  it('prints a token and leaves the lease in place when it exits', async () => {
    await withDir(async (dir) => {
      const r = await run(['update-lease', 'claim', '--bin-dir', dir, '--pid', String(FOREIGN_LIVE_PID)]);
      expect(r.out, 'the caller captures this with $(…) and quotes it back on release').toMatch(/^[0-9a-f]{8,}$/);
      expect(existsSync(leaseFile(dir)), 'the lease must outlive the claiming process').toBe(true);
    });
  });

  it('answers HELD, distinctly from unavailable, when a live process holds it', async () => {
    await withDir(async (dir) => {
      await run(['update-lease', 'claim', '--bin-dir', dir, '--pid', String(FOREIGN_LIVE_PID)]);
      const second = await run(['update-lease', 'claim', '--bin-dir', dir, '--pid', String(FOREIGN_LIVE_PID + 1)]);
      expect(second.code, 'the shell branches on this: 10 stand down, 20 carry on degraded').toBe(LEASE_HELD);
      expect(second.err.join(' ')).toContain(`pid ${FOREIGN_LIVE_PID}`);
    });
  });

  it('refuses a missing or nonsense --pid rather than claiming under a wrong one', async () => {
    await withDir(async (dir) => {
      expect((await run(['update-lease', 'claim', '--bin-dir', dir])).code).toBe(LEASE_UNAVAILABLE);
      expect((await run(['update-lease', 'claim', '--bin-dir', dir, '--pid', 'x'])).code).toBe(LEASE_UNAVAILABLE);
      expect(existsSync(leaseFile(dir)), 'and writes nothing').toBe(false);
    });
  });

  it('refuses without --bin-dir instead of guessing from execPath', async () => {
    // The trap `revert-release` documents: `process.execPath` is wrong the moment
    // the binary is reached through a wrapper, and a lease at the wrong path is
    // an exclusion of nothing.
    expect((await run(['update-lease', 'claim', '--pid', '123'])).code).toBe(LEASE_UNAVAILABLE);
  });
});

describe('update-lease release', () => {
  it('drops a lease when the token matches', async () => {
    await withDir(async (dir) => {
      const claim = await run(['update-lease', 'claim', '--bin-dir', dir, '--pid', String(FOREIGN_LIVE_PID)]);
      const r = await run(['update-lease', 'release', '--bin-dir', dir, '--token', claim.out]);
      expect(r.code).toBe(LEASE_TAKEN);
      expect(existsSync(leaseFile(dir))).toBe(false);
    });
  });

  it('⛔ will NOT drop a lease whose token differs — including an empty one', async () => {
    // The identity check is what stops a releaser removing a claim that was
    // reclaimed out from under it as stale. An empty token is the shape a caller
    // sends when it never actually claimed.
    await withDir(async (dir) => {
      await run(['update-lease', 'claim', '--bin-dir', dir, '--pid', String(FOREIGN_LIVE_PID)]);
      await run(['update-lease', 'release', '--bin-dir', dir, '--token', 'deadbeefdeadbeef']);
      expect(existsSync(leaseFile(dir)), 'somebody else\'s lease is not ours to drop').toBe(true);
      await run(['update-lease', 'release', '--bin-dir', dir, '--token', '']);
      expect(existsSync(leaseFile(dir))).toBe(true);
    });
  });

  it('exits 0 even when there is nothing to release', async () => {
    // A failing releaser must never fail the caller's install; a leaked lease is
    // reclaimed as stale once its pid dies.
    await withDir(async (dir) => {
      expect((await run(['update-lease', 'release', '--bin-dir', dir, '--token', 'x'])).code).toBe(LEASE_TAKEN);
    });
  });
});

describe('the installer\'s claim and the server\'s claim are the SAME mutex', () => {
  it('a lease taken through the CLI verb refuses the server\'s direct claim', async () => {
    await withDir(async (dir) => {
      const claim = await run(['update-lease', 'claim', '--bin-dir', dir, '--pid', String(FOREIGN_LIVE_PID)]);
      expect(claim.code).toBe(LEASE_TAKEN);
      // The server path, verbatim — this is what `runApply` and the auto-revert call.
      expect(() => acquireUpdateLease({ leasePath: leaseFile(dir), operation: 'apply' }))
        .toThrow(UpdateLeaseHeldError);
    });
  });

  it('and the reverse: the verb stands down for a lease the server holds', async () => {
    await withDir(async (dir) => {
      const held = acquireUpdateLease({ leasePath: leaseFile(dir), operation: 'apply' });
      try {
        const r = await run(['update-lease', 'claim', '--bin-dir', dir, '--pid', String(FOREIGN_LIVE_PID)]);
        expect(r.code).toBe(LEASE_HELD);
      } finally {
        held.release();
      }
    });
  });

  it('and once the server releases, the installer can take it', async () => {
    // The arm that proves the two above are exclusion rather than a verb that
    // always refuses.
    await withDir(async (dir) => {
      acquireUpdateLease({ leasePath: leaseFile(dir), operation: 'apply' }).release();
      expect((await run(['update-lease', 'claim', '--bin-dir', dir, '--pid', String(FOREIGN_LIVE_PID)])).code)
        .toBe(LEASE_TAKEN);
    });
  });
});
