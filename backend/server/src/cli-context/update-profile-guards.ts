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
// ⚠ RE-EXPORTED, NOT REDEFINED. It moved to `lifecycle/instance-lock`, beside
// the lock it reads, because `recued stop` needs the same answer and a
// cli-context module is not reachable from another profile — see the note there.
// Existing callers keep importing it from here.
export { liveServerHolding } from '../lifecycle/instance-lock.js';

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
  // ⚠ NAME THE COMMAND. This used to say "stop the server ... then start it the
  // same way you started it", which asked the owner for something the tool knows
  // and they often do not — and pointed at a `recued stop` that could not stop a
  // `serve`-started server at all, closing the loop. `stop` now falls back to
  // the instance lock, so the instruction is one the owner can actually follow.
  : 'Either:\n' +
    '  · let the supervised server do it — webclient → Settings → Updates, or\n' +
    `  · \`recued stop\`, run \`recued update ${sub}\` again, then start Recued again.`;

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
