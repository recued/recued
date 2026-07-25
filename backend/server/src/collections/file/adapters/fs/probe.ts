/** Phase 7 (D-110) — fs adapter capability probe.
 *
 *  Runs three cheap checks against the configured root:
 *    1. `stat` — directory exists + readable.
 *    2. Write-read-delete a probe file (`.recued-caps-probe-<uuid>`).
 *    3. Attempt a short-lived recursive `fs.watch` subscription.
 *       Report `realtime` only when it attaches; otherwise `none`.
 *       Filesystem polling is deliberately not an automatic fallback:
 *       the user can request a bounded one-shot rescan instead.
 *
 *  Probe failures map to caps refusals:
 *    - directory unreadable     → throw (config error, caller surfaces 422).
 *    - write/read/delete failed → `write: 'no', delete: 'no'`.
 *
 *  The probe is idempotent — it writes then deletes the probe file,
 *  so a repeated probe leaves the directory in the same state. */

import { randomUUID } from 'node:crypto';
import { access, stat, writeFile, readFile, unlink } from 'node:fs/promises';
import { constants as fsConstants, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { ProbedCaps } from '../../caps.js';

export interface FsProbeConfig {
  /** Absolute directory. Relative paths are rejected so we never
   *  resolve against the server CWD accidentally. */
  path: string;
}

export interface FsProbeDeps {
  /** Test seam for deterministic supported/unsupported coverage. Production
   *  performs a real short-lived recursive watcher attachment. */
  probeRealtimeWatch?: (path: string) => Promise<boolean>;
}

/** `fs.watch` can reject synchronously or emit an immediate error after the
 *  handle is created. Keep the probe alive for one event-loop turn to catch
 *  both shapes, then close it without retaining any process state. */
const probeRealtimeWatch = async (path: string): Promise<boolean> =>
  new Promise((resolveProbe) => {
    let watcher: FSWatcher | undefined;
    let settled = false;

    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      if (watcher) {
        try { watcher.close(); } catch { /* best-effort probe cleanup */ }
        watcher.removeListener('error', onError);
      }
      resolveProbe(supported);
    };
    const onError = (): void => finish(false);

    try {
      watcher = watch(path, { recursive: true }, () => {});
      watcher.once('error', onError);
      setImmediate(() => finish(true));
    } catch {
      finish(false);
    }
  });

export const probeFsCaps = async (
  config: FsProbeConfig,
  deps: FsProbeDeps = {},
): Promise<ProbedCaps> => {
  if (!config.path || typeof config.path !== 'string') {
    throw new Error('fs adapter: config.path is required');
  }

  const rootStat = await stat(config.path).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(`fs adapter: root is not a directory: ${config.path}`);
  }

  // Read access — throws if the process can't list the directory.
  await access(config.path, fsConstants.R_OK);

  // Write-read-delete probe.
  const probePath = join(config.path, `.recued-caps-probe-${randomUUID()}`);
  const probeBody = 'recued-caps-probe';
  let canWrite = true;
  let canDelete = true;
  try {
    await writeFile(probePath, probeBody, { encoding: 'utf8' });
    const readBack = await readFile(probePath, { encoding: 'utf8' });
    if (readBack !== probeBody) canWrite = false;
  } catch {
    canWrite = false;
  } finally {
    try {
      await unlink(probePath);
    } catch {
      // Probe file might have failed to create — that's fine. If it
      // did land but we can't remove it, surface as delete = no.
      const present = await stat(probePath).catch(() => null);
      if (present) canDelete = false;
    }
  }

  const realtimeWatch = await (
    deps.probeRealtimeWatch ?? probeRealtimeWatch
  )(config.path);

  return {
    read: 'yes',
    write: canWrite ? 'yes' : 'no',
    delete: canWrite && canDelete ? 'yes' : 'no',
    // Do not advertise a fallback that does not exist. A `none` instance is
    // still readable/writable and can be refreshed with an explicit resync.
    watch: realtimeWatch ? 'realtime' : 'none',
    mirror: 'optional',
    auth: 'none',
    path_style: 'posix',
  };
};
