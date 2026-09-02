/** Side-effect-light guards shared by both halves of `recued update`.
 *
 * The staged-rollback preflight has to run before the ordinary update profile is
 * imported, because that profile owns SQLite-backed checking/apply composition.
 * Keeping the realm liveness rule in this leaf avoids giving the recovery path a
 * second, subtly different definition of "the server is stopped". */
import { dirname, join, resolve } from 'node:path';

import { createInstanceLock, type LockInfo } from '../lifecycle/instance-lock.js';

/** Is a live server holding this realm?
 *
 * The serve path writes this lock beside the resolved database. A daemon pidfile
 * would miss foreground/supervised servers, while a process-name scan would mix
 * together different realms and is unavailable on Windows. */
export const liveServerHolding = (dbPath: string): LockInfo | null => {
  const lockPath = join(dirname(resolve(dbPath)), 'recued-server.lock');
  const info = createInstanceLock({ lockPath }).inspect();
  if (!info) return null;
  return pidAlive(info.pid) ? info : null;
};

/** `process.kill(pid, 0)` liveness. EPERM means the process is alive but owned
 * by somebody else; only ESRCH is an absent holder. */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Refuse, and say which restart path this install actually has.
 *
 * Windows Startup launches `recued start`; it is login persistence, not a
 * respawning supervisor. Advertising the webclient there sends the owner to an
 * apply that correctly refuses before download, so name the stopped-daemon
 * recovery path directly. */
export const runningServerUpdateRemedy = (
  sub: string,
  platform: NodeJS.Platform = process.platform,
): string => platform === 'win32'
  ? 'Windows Startup cannot respawn this daemon after an in-server update restart.\n' +
    '\n' +
    `  Stop it with \`recued stop\`, run \`recued update ${sub}\` again, then start Recued again.`
  : 'Either:\n' +
    '  · let the supervised server do it — webclient → Settings → Updates, or\n' +
    '  · stop the server, run this again, then start it the same way you started it.';

export const refuseWhileRunning = (
  holder: LockInfo,
  sub: string,
  platform: NodeJS.Platform = process.platform,
): void => {
  console.error(
    `A Recued server is running on this realm (pid ${holder.pid}, port ${holder.bind_port}).\n` +
      `\`recued update ${sub}\` swaps the binary on disk and cannot restart a live daemon, so it\n` +
      'refuses rather than leaving you on the old process believing it applied.\n' +
      '\n' +
      runningServerUpdateRemedy(sub, platform),
  );
  process.exitCode = 2;
};

/** Refuse before a source/npm invocation can treat the owner's Node runtime as
 * the binary to replace. Shared because staged recovery runs before the ordinary
 * profile reaches its copy of this boundary. */
export const refuseUnpackagedBinaryUpdate = (): void => {
  console.error(
    'This is not the packaged Recued binary — it is running under Node (a source\n' +
      'checkout or an npm install), where the update target would be the node\n' +
      'executable itself. Refusing.\n' +
      '\n' +
      '  source checkout: git pull && npm ci && npm run build:server\n' +
      '  npm install:     npm i -g @recued/server@latest',
  );
  process.exitCode = 2;
};
