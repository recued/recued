/** Where the realm database lives — resolved in ONE place.
 *
 *  ⛔⛔ THE REALM IS NOT THE WORKING DIRECTORY. The default was
 *  `./recued-server.db`, repeated verbatim at eleven call sites, so which realm
 *  a command opened depended on where the operator happened to be standing.
 *
 *  Measured on a live droplet 2026-08-31 — THREE realms on one machine, created
 *  inside twenty-five minutes, each by a `recued serve` run from a different
 *  directory:
 *
 *      /recued-server.db                       2.8M  05:00   (systemd, cwd=/)
 *      /root/recued-server.db                  3.5M  04:59
 *      /usr/local/lib/recued/recued-server.db  3.5M  04:46
 *
 *  The owner's realm looked lost: the unit came up on a database it had just
 *  created, printed a fresh pairing code, and reported success. `install.sh`
 *  had described this exact outcome in a comment — "the server would come up on
 *  a DIFFERENT database — unenrolled, printing a fresh pairing code, their realm
 *  apparently gone — and it would report success" — while the unit it generates
 *  pinned no realm at all.
 *
 *  ⛔ `--require-enrolled` DOES NOT CATCH IT, and cannot. It asks "is a realm
 *  enrolled here", never "is this the operator's realm", so it passed happily on
 *  a realm nobody had ever seen.
 *
 *  🔑 THE RULE. An explicit `--db` / `DB_PATH` is obeyed verbatim, always. With
 *  no explicit path there is exactly one default per platform, and nothing is
 *  derived from the working directory.
 *
 *  ⚠ AN ABSENT DESIGNATED PATH SIMPLY MEANS A NEW REALM. We do not refuse and
 *  we do not hunt for rival databases in other directories. A pure refusal is
 *  unshippable anyway — on a new machine the designated path is ALWAYS absent,
 *  so refusing would mean no realm could be created without being handed `--db`
 *  first — and refusing on an existing fleet would fail every server once on the
 *  first restart after update, trip `boot-failure-counter`, and AUTO-REVERT to
 *  `recued.old`, turning a loud failure into a silent rollback.
 *
 *  What went wrong on the droplet was not that a new realm was created — it is
 *  that NOBODY WAS TOLD. Saying it fixes that without breaking first boot or
 *  bricking a fleet. */

import { existsSync as fsExistsSync, mkdirSync as fsMkdirSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** The filename, unchanged — only the directory it defaults into moves. */
export const REALM_DB_FILENAME = 'recued-server.db';

export interface RealmPathDeps {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  homedir?: () => string;
  /** Effective uid; `0` selects the system-wide path on Linux. */
  uid?: () => number;
  exists?: (p: string) => boolean;
  mkdir?: (p: string) => void;
  /** Injected for tests; defaults to `console.log`. */
  note?: (message: string) => void;
}

/** The one default per platform. No CWD anywhere in it. */
export const standardRealmDbPath = (deps: RealmPathDeps = {}): string => {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = (deps.homedir ?? osHomedir)();
  const uid = (deps.uid ?? (() => (typeof process.getuid === 'function' ? process.getuid() : -1)))();

  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || env.APPDATA || join(home, 'AppData', 'Local');
    return join(base, 'recued', REALM_DB_FILENAME);
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'recued', REALM_DB_FILENAME);
  }
  // Linux and the rest. Root runs a machine-wide server — that is the case the
  // systemd unit hits, and the one that must not depend on a working directory.
  if (uid === 0) return join('/var', 'lib', 'recued', REALM_DB_FILENAME);
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share');
  return join(base, 'recued', REALM_DB_FILENAME);
};

/** Resolve the realm database path.
 *
 *  @param explicit `--db` or `DB_PATH`, already read by the caller. Obeyed
 *                  verbatim when present — an operator who names a path has
 *                  answered the question this module exists to ask.
 *  Never throws: an absent designated path simply means a new realm. */
export const resolveRealmDbPath = (
  explicit: string | undefined,
  deps: RealmPathDeps = {},
): string => {
  if (explicit !== undefined && explicit !== '') return explicit;

  const exists = deps.exists ?? fsExistsSync;
  const mkdir = deps.mkdir ?? ((p: string) => fsMkdirSync(p, { recursive: true }));
  const note = deps.note ?? ((m: string) => { console.log(m); });

  const standard = standardRealmDbPath(deps);
  if (exists(standard)) return standard;

  // Absent means new. Not an error, not a prompt — one line, because a realm
  // coming into existence is worth a log entry and nothing more.
  note(`[recued] creating a new realm database at ${standard}`);
  try { mkdir(dirname(standard)); } catch { /* surfaced by the open that follows */ }
  return standard;
};
