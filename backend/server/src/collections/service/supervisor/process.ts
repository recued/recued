/** D-118 Phase 5 — default spawn seam for the supervisor.
 *
 *  Production wrapper around `node:child_process.spawn` that
 *  matches decision #9's child stdio shape (`['ignore', 'pipe',
 *  'pipe']`) plus `shell: false` (decision #6). Both pipes are
 *  drained with no-op listeners so long-running services don't
 *  wedge on a full stdout buffer — log capture is a Phase 7+
 *  concern (invoke ops + dashboard streaming).
 */
import { spawn as nodeSpawn } from 'node:child_process';

import type { SpawnProcessFn } from './types.js';

export const defaultSpawnProcess: SpawnProcessFn = (argv, opts) => {
  if (argv.length === 0) {
    // Surface the bad input as a failed handle — supervisor's spawn
    // wrapper catches this and routes it through the crash-audit
    // path so the operator sees a clear error rather than a silent
    // no-op.
    throw new Error('supervisor spawn: argv must be non-empty');
  }
  const [cmd, ...rest] = argv;
  const child = nodeSpawn(cmd, rest, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    cwd: opts.cwd,
    detached: opts.detached ?? false,
  });
  // Drain — keep the OS pipe buffer from filling and blocking the
  // child. We don't persist output; that comes in Phase 7.
  child.stdout?.on('data', () => { /* drain */ });
  child.stderr?.on('data', () => { /* drain */ });
  // Let the parent exit cleanly even when a detached service is
  // still running — matches the spec's "detach: true for typical
  // services" guidance. Supervisor shutdown still stops tracked
  // services explicitly.
  if (opts.detached === true) {
    child.unref();
  }
  return {
    pid: child.pid ?? null,
    kill(signal): boolean {
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    },
    onExit(handler): void {
      child.once('exit', (code, signal) => {
        handler(code, signal);
      });
    },
  };
};
