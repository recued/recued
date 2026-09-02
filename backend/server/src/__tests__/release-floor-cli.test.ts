/** `recued release-floor raise` — the installer's route into the LOCKED advance.
 *
 *  ⛔ THE DEFECT THIS CLOSES. `install.sh` had its own read-compare-rename, and I
 *  documented that as bounded: "both writers only ever RAISE, each write is
 *  atomic, so the file never moves backwards." It never goes below what THAT
 *  WRITER read — a much weaker claim. floor 100 · shell reads 100 and decides
 *  200 · the server takes the lock and writes 300 · the shell renames 200 into
 *  place. The floor moved BACKWARDS and a replayed manifest at 250 is live again.
 *  An atomic rename prevents a torn file, never a lost update.
 *
 *  ⚠ WHAT IS ASSERTED HERE is that this verb performs the advance UNDER THE LOCK
 *  and refuses to write while somebody else holds it. That the shell routes
 *  through it rather than writing directly is asserted in
 *  `installer-shell-functions.test.ts`; the two together are the chain. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runReleaseFloorProfile, FLOOR_RAISED, FLOOR_UNAVAILABLE } from '../cli-context/release-floor.js';
import { advanceHostSequenceFloor, readHostSequenceFloor, hostSequenceFloorPathFor } from '../update/host-sequence-floor.js';

const trace = { mark: () => {}, markImport: () => {} } as never;
/** Alive, and not us — same-pid would be re-entrant and take the lock. */
const FOREIGN_LIVE_PID = process.ppid;

const run = async (args: string[]): Promise<{ code: number; err: string[] }> => {
  const r = { code: -1, err: [] as string[] };
  await runReleaseFloorProfile({
    args,
    bootTrace: trace,
    exit: (c) => { if (r.code === -1) r.code = c; },
    log: (m) => { r.err.push(m); },
    sleep: async () => {},   // the retry is bounded; don't pay for it in tests
  });
  return r;
};
const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-floor-cli-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('release-floor raise', () => {
  it('raises an absent floor, in the format install.sh reads', async () => {
    await withDir(async (dir) => {
      expect((await run(['release-floor', 'raise', '--bin-dir', dir, '--sequence', '200'])).code)
        .toBe(FLOOR_RAISED);
      expect(readFileSync(hostSequenceFloorPathFor(dir), 'utf-8')).toBe('200\n');
    });
  });

  it('⛔ REFUSES to lower one, and still reports success', async () => {
    // Success is "the floor is at or above what I asked for", not "I wrote it" —
    // a caller that treated a higher floor as a failure would retry forever.
    await withDir(async (dir) => {
      advanceHostSequenceFloor(hostSequenceFloorPathFor(dir), 300);
      expect((await run(['release-floor', 'raise', '--bin-dir', dir, '--sequence', '200'])).code)
        .toBe(FLOOR_RAISED);
      expect(readHostSequenceFloor(hostSequenceFloorPathFor(dir))).toBe(300);
    });
  });

  it('⛔ WRITES NOTHING while another live process holds the floor lock', async () => {
    // ⛔⛔ THE PROPERTY THAT CLOSES THE LOST UPDATE. The shell's own write had no
    // idea this lock existed and would have renamed straight over the holder's
    // value. Here the advance stands down and the floor keeps whatever the
    // holder is in the middle of putting there.
    await withDir(async (dir) => {
      const floorPath = hostSequenceFloorPathFor(dir);
      // ⚠ THE REQUEST MUST BE HIGHER THAN THE FLOOR, or the advance answers
      // `unchanged` from the unlocked pre-read and never reaches the lock at all
      // — which is correct behaviour, and made the first version of this arm
      // pass without ever testing contention.
      advanceHostSequenceFloor(floorPath, 100);
      writeFileSync(`${floorPath}.lock`, JSON.stringify(
        { pid: FOREIGN_LIVE_PID, operation: 'advance replay floor to 400', at: Date.now(), token: 't' },
      ));
      const r = await run(['release-floor', 'raise', '--bin-dir', dir, '--sequence', '200']);
      expect(r.code).toBe(FLOOR_UNAVAILABLE);
      expect(readHostSequenceFloor(floorPath), 'the holder owns the write').toBe(100);
      // ⚠ AND IT SAYS WHERE THE FLOOR ACTUALLY IS, because "could not raise it to
      // 200" reads as unprotected when the holder may be putting 400 there.
      expect(r.err.join(' ')).toContain('currently reads 100');
    });
  });

  it('takes it once the holder is gone — the refusal above is exclusion, not breakage', async () => {
    await withDir(async (dir) => {
      const floorPath = hostSequenceFloorPathFor(dir);
      writeFileSync(`${floorPath}.lock`, JSON.stringify(
        { pid: FOREIGN_LIVE_PID, operation: 'x', at: Date.now(), token: 't' },
      ));
      expect((await run(['release-floor', 'raise', '--bin-dir', dir, '--sequence', '200'])).code)
        .toBe(FLOOR_UNAVAILABLE);
      rmSync(`${floorPath}.lock`);
      expect((await run(['release-floor', 'raise', '--bin-dir', dir, '--sequence', '200'])).code)
        .toBe(FLOOR_RAISED);
      expect(readHostSequenceFloor(floorPath)).toBe(200);
    });
  });

  it('refuses bad arguments rather than writing a floor nobody meant', async () => {
    await withDir(async (dir) => {
      expect((await run(['release-floor', 'raise', '--bin-dir', dir])).code).toBe(FLOOR_UNAVAILABLE);
      expect((await run(['release-floor', 'raise', '--bin-dir', dir, '--sequence', '1.5'])).code)
        .toBe(FLOOR_UNAVAILABLE);
      expect((await run(['release-floor', 'raise', '--bin-dir', dir, '--sequence', '-1'])).code)
        .toBe(FLOOR_UNAVAILABLE);
      expect((await run(['release-floor', 'raise', '--sequence', '200'])).code).toBe(FLOOR_UNAVAILABLE);
      expect((await run(['release-floor', 'lower', '--bin-dir', dir, '--sequence', '1'])).code)
        .toBe(FLOOR_UNAVAILABLE);
      expect(readHostSequenceFloor(hostSequenceFloorPathFor(dir))).toBe(0);
    });
  });
});
