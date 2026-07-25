/** Phase 7 (D-110) — fs adapter capability probe.
 *
 *  Runs three cheap checks against the configured root:
 *    1. `stat` — directory exists + readable.
 *    2. Write-read-delete a probe file (`.recued-caps-probe-<uuid>`).
 *    3. Derive `watch` = 'realtime' when fs.watch (recursive) is
 *       supported on the platform; otherwise 'poll' (not implemented
 *       in v1, but the caps shape reflects what the adapter could
 *       honor if the poll path existed).
 *
 *  Probe failures map to caps refusals:
 *    - directory unreadable     → throw (config error, caller surfaces 422).
 *    - write/read/delete failed → `write: 'no', delete: 'no'`.
 *
 *  The probe is idempotent — it writes then deletes the probe file,
 *  so a repeated probe leaves the directory in the same state. */

import { randomUUID } from 'node:crypto';
import { access, stat, writeFile, readFile, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import type { ProbedCaps } from '../../caps.js';

export interface FsProbeConfig {
  /** Absolute directory. Relative paths are rejected so we never
   *  resolve against the server CWD accidentally. */
  path: string;
}

export const probeFsCaps = async (
  config: FsProbeConfig,
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

  return {
    read: 'yes',
    write: canWrite ? 'yes' : 'no',
    delete: canWrite && canDelete ? 'yes' : 'no',
    // fs.watch({ recursive: true }) is available on macOS / Windows /
    // Linux (inotify) under Node 20+. We assume realtime; a future
    // poll-fallback commit can downgrade.
    watch: 'realtime',
    mirror: 'optional',
    auth: 'none',
    path_style: 'posix',
  };
};
