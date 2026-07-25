/** D-178 slice 3b — the boot-failure counter (spec § "Two-phase apply +
 *  boot-health auto-revert").
 *
 *  Signatures prove authenticity, not boot health — a signed-but-bad release
 *  must degrade to one noisy failed attempt, never an unattended crash loop.
 *  The counter records consecutive failed boots of an UNCOMMITTED binary; at
 *  the threshold (`shouldAutoRevert`, apply-state-machine.ts) the launcher /
 *  orchestrator reverts to `recued.old`.
 *
 *  It lives in a plain JSON sidecar NEXT TO THE BINARY, deliberately OUTSIDE
 *  the SQLite file: it must survive both crash loops (the process never reaches
 *  a clean DB write) AND snapshot restores (a rollback that restores the DB must
 *  not also reset the very counter that's deciding the rollback). A missing /
 *  corrupt file reads as zero — fail toward "give the binary a chance" rather
 *  than spuriously reverting.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export const BOOT_FAILURE_COUNTER_FILE = 'boot-failures.json';

interface CounterFile {
  /** Consecutive failed boots of the current uncommitted binary. */
  count: number;
  /** The release the counter is tracking — a new apply re-keys + zeroes it so
   *  a stale counter from a prior apply can't trip a fresh one. */
  release_identity?: string;
}

export interface BootFailureCounter {
  /** Current count. Pass `releaseIdentity` to get a RELEASE-AWARE read: a count
   *  recorded against a DIFFERENT release reads as 0 (a stale counter from a
   *  prior apply must never trip the current one's auto-revert). */
  read(releaseIdentity?: string): number;
  /** Bump the count for `releaseIdentity` (re-keying to 1 if it changed).
   *  Returns the new count. */
  increment(releaseIdentity: string): number;
  /** Clear the counter — call on a committed/healthy boot. */
  reset(): void;
}

export const createBootFailureCounter = (path: string): BootFailureCounter => {
  const load = (): CounterFile => {
    if (!existsSync(path)) return { count: 0 };
    try {
      const o = JSON.parse(readFileSync(path, 'utf8')) as Partial<CounterFile>;
      return { count: typeof o.count === 'number' && Number.isFinite(o.count) && o.count >= 0 ? o.count : 0, release_identity: o.release_identity };
    } catch {
      return { count: 0 };
    }
  };
  // Write-temp-then-rename so a crash mid-write can't leave a torn JSON file
  // (which would read as 0 and silently lose accumulated failures).
  const persist = (next: CounterFile): void => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), 'utf8');
    renameSync(tmp, path);
  };
  return {
    read(releaseIdentity) {
      const cur = load();
      if (releaseIdentity !== undefined && cur.release_identity !== releaseIdentity) return 0;
      return cur.count;
    },
    increment(releaseIdentity) {
      const cur = load();
      const next: CounterFile =
        cur.release_identity === releaseIdentity
          ? { count: cur.count + 1, release_identity: releaseIdentity }
          : { count: 1, release_identity: releaseIdentity };
      persist(next);
      return next.count;
    },
    reset() {
      if (existsSync(path)) rmSync(path);
    },
  };
};
