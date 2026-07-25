/** Instance lock file (Phase C).
 *
 *  Complements `daemon.ts`'s CLI-wrapper pidfile. The daemon writes
 *  `recued-server.pid` only when started via `recued-server start`;
 *  users who launch the daemon directly (`tsx bin.ts`, IDE run button,
 *  supervisor unit) bypass that file. This in-process lock at
 *  `{data_path}/recued-server.lock` catches those cases:
 *
 *    - developer accidentally running the daemon twice on the same DB
 *    - a shared machine where two users both point at the same
 *      data_path
 *    - a supervisor respawning the daemon before the previous process
 *      finished exiting
 *
 *  Contract:
 *    - JSON content: `{ pid, boot_at, bind_port }`.
 *    - `claim()` throws `LockHeldError` iff the recorded PID is alive
 *      AND the recorded bind_port matches what we're about to bind.
 *      Mismatch (dead PID, different port) → reclaim by overwrite.
 *    - `release()` deletes the file. Idempotent.
 *    - A crashed process leaves the lock behind; the next boot reclaims
 *      it per the stale-detection rule.
 *
 *  We do NOT use `fcntl`/`flock`-style advisory locks because they
 *  don't survive a process crash on some platforms (macOS releases on
 *  any fd close, Linux releases on process exit but not on a forked
 *  child's exit in every config) and require native code. A
 *  JSON-pidfile-with-liveness-check is simple, portable, and the
 *  correctness window is identical to what we need here. */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface LockInfo {
  pid: number;
  /** Unix-ms boot time of the holder. */
  boot_at: number;
  /** Port the holder is bound to. Used to distinguish a crashed
   *  previous process (port mismatch → reclaim) from a live sibling
   *  on the same data_path (port match + PID alive → refuse). */
  bind_port: number;
}

export class LockHeldError extends Error {
  readonly code = 'LOCK_HELD';
  constructor(public readonly holder: LockInfo) {
    super(
      `instance lock held by pid ${holder.pid} on port ${holder.bind_port}`,
    );
    this.name = 'LockHeldError';
  }
}

export interface InstanceLock {
  /** Try to claim the lock. Writes the lock file with our PID +
   *  boot_at + bind_port. Throws `LockHeldError` when another live
   *  process holds the same port. Reclaims (overwrites) when the
   *  holder's PID is dead or its port differs. */
  claim(info: { boot_at: number; bind_port: number }): LockInfo;
  /** Release the lock (delete the file). Safe to call when already
   *  released — doesn't throw if the file is missing. */
  release(): void;
  /** Read the current lock file without modifying it. Returns null
   *  when absent or unparseable. */
  inspect(): LockInfo | null;
  /** Lock file path (for logging / test assertions). */
  readonly path: string;
}

export interface CreateInstanceLockOptions {
  lockPath: string;
  /** Liveness check — defaults to `process.kill(pid, 0)`. Injected for
   *  tests so we can simulate a live peer or a stale holder without
   *  spawning real processes. */
  isAlive?: (pid: number) => boolean;
  /** Current PID — defaults to `process.pid`. Injected for tests. */
  currentPid?: () => number;
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

const parseLockFile = (path: string): LockInfo | null => {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.boot_at === 'number' &&
      typeof parsed.bind_port === 'number'
    ) {
      return parsed as LockInfo;
    }
  } catch {
    /* malformed — treat as absent, will overwrite */
  }
  return null;
};

export const createInstanceLock = (
  opts: CreateInstanceLockOptions,
): InstanceLock => {
  const {
    lockPath,
    isAlive = defaultIsAlive,
    currentPid = () => process.pid,
  } = opts;

  // Track whether WE currently hold this lock. Prevents release()
  // from deleting a file the holder never claimed (e.g. double-call,
  // or release() on a pre-existing stale lock we haven't claimed yet).
  let held = false;

  const ensureDir = (): void => {
    const dir = dirname(lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  };

  return {
    path: lockPath,

    inspect: () => parseLockFile(lockPath),

    claim({ boot_at, bind_port }) {
      const existing = parseLockFile(lockPath);
      if (existing && existing.pid !== currentPid()) {
        // Another PID wrote this file. Alive + same port → refuse.
        // Alive + different port, or dead PID → reclaim.
        const alive = isAlive(existing.pid);
        if (alive && existing.bind_port === bind_port) {
          throw new LockHeldError(existing);
        }
        // Fall through: reclaim by overwrite.
      }
      const info: LockInfo = {
        pid: currentPid(),
        boot_at,
        bind_port,
      };
      ensureDir();
      writeFileSync(lockPath, JSON.stringify(info), 'utf-8');
      held = true;
      return info;
    },

    release() {
      // Only delete when WE own the lock. Prevents accidentally
      // removing a sibling process's lock if `release` is called on a
      // never-claimed instance.
      if (!held) return;
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone — best effort */
      }
      held = false;
    },
  };
};
