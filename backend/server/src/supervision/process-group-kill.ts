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
  if (!Number.isInteger(pid) || pid <= 1) {
    // Guard: pid 0 signals the CALLER's own group, pid 1 is init, negatives are
    // already group-form. A malformed pid (e.g. from a corrupt `.pid` marker)
    // must never be turned into a self- or init-kill.
    return;
  }

  if (platform === 'win32') {
    try {
      // Fire-and-forget — we don't await taskkill's exit (the daemon's own
      // `.exit.<code>` marker is the authoritative death signal the supervisor
      // watches). `/T` kills the child tree, `/F` forces it.
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      // A spawn failure (e.g. taskkill not on PATH) is delivered via the async
      // 'error' event, NOT a thrown exception — without a listener Node crashes
      // the process on an unhandled 'error'. Swallow it to honour "never throws".
      child.on('error', () => { /* taskkill unavailable — best-effort */ });
    } catch {
      /* synchronous spawn failure / process already gone — best-effort */
    }
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
