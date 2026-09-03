/** Supervision feature (D-179 detached-job keep-alive) — the cross-OS
 *  process-group kill primitive.
 *
 *  This is the first real implementation of the detached `cancel.kind:
 *  'process_group'` surface declared in `CliDetachedCancelSpec`: until now the
 *  detached launcher only WROTE the `.pid` marker — nothing killed the group.
 *
 *  A detached cli job is spawned `detached: true` (`cli-invocation-executor.ts`
 *  `runDetached`), which makes the child a process-group leader. Killing the
 *  whole group (not just the launched pid) reaches any grandchildren the daemon
 *  forked (e.g. `ollama serve` workers) — a bare `pid` kill would orphan them.
 *
 *  OS split:
 *   - POSIX (`darwin` / `linux`): `process.kill(-pid, signal)` signals the
 *     entire group whose id equals the leader's pid. If the group is already
 *     gone (ESRCH) we fall back to the bare pid — the leader may have outlived
 *     its children, or the pid was adopted from a `.pid` marker after a restart.
 *   - Windows: there is no negative-pid group signalling. `taskkill /PID <pid>
 *     /T /F` terminates the pid AND its child tree (`/T`), forcefully (`/F`).
 *
 *  Kept side-effect-only + platform-injectable so the supervisor's stop path is
 *  unit-testable without spawning real processes.
 */
import { spawn } from 'node:child_process';

const isSafeLeaderPid = (pid: number): boolean =>
  Number.isInteger(pid) && pid > 1;

const taskkillTree = (pid: number): void => {
  try {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    child.on('error', () => { /* taskkill unavailable — best-effort */ });
  } catch {
    /* synchronous spawn failure / process already gone — best-effort */
  }
};

/** Terminate a detached job's whole process group by its leader pid.
 *
 *  Best-effort + never throws: a process that already exited (ESRCH / a stale
 *  pid from a `.pid` marker) is a no-op, not an error — the caller's intent
 *  ("this daemon should not be running") is satisfied either way.
 *
 *  `signal` applies to the POSIX path only (Windows `taskkill /F` is always a
 *  hard terminate). The supervisor sends `SIGTERM` first (graceful) and may
 *  escalate to `SIGKILL` after a grace window. */
export const killProcessGroup = (
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  platform: NodeJS.Platform = process.platform,
): void => {
  if (!isSafeLeaderPid(pid)) {
    // Guard: pid 0 signals the CALLER's own group, pid 1 is init, negatives are
    // already group-form. A malformed pid (e.g. from a corrupt `.pid` marker)
    // must never be turned into a self- or init-kill.
    return;
  }

  if (platform === 'win32') {
    // Fire-and-forget — the caller observes its own lifecycle signal. `/T`
    // kills the child tree and `/F` forces it. Async spawn errors are swallowed.
    taskkillTree(pid);
    return;
  }

  // POSIX — signal the whole group (negative pid). Fall back to the bare pid if
  // the group is already gone but the leader lingers.
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already exited — nothing to signal */
    }
  }
};

/** Reap descendants after a finite process-group leader has already exited.
 *
 * POSIX deliberately has NO bare-pid fallback here: after the leader exits its
 * numeric pid can be reused, while the negative group id still identifies any
 * surviving descendants. Windows has no group-id primitive, so the best
 * available tree cleanup remains `taskkill /T /F` against the just-exited
 * leader. Best-effort and never throws. */
export const reapProcessGroupAfterLeaderExit = (
  pid: number,
  signal: NodeJS.Signals = 'SIGKILL',
  platform: NodeJS.Platform = process.platform,
): void => {
  if (!isSafeLeaderPid(pid)) return;
  if (platform === 'win32') {
    taskkillTree(pid);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    /* group already gone — do not target a potentially reused bare pid */
  }
};
