/** OS-conventional config-file path. Kept separate from the TOML parser so
 *  tests can stub a fake environment.
 *
 *  The data folder is not here: it is the folder that holds the database,
 *  resolved by `backend/server/src/realm-db-path.ts` from `--db` / `DB_PATH`.
 *  A `data_path` default lived here until 2026-10-09, and it disagreed with
 *  where the server really keeps its data on Windows (Roaming vs Local
 *  AppData) and for root on Linux — harmless only because nothing read it. */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export type Os = 'darwin' | 'linux' | 'windows';

/** Normalise `os.platform()` to our three buckets. Any non-darwin / non-
 *  windows platform (Linux, BSD, etc.) follows XDG. */
export const detectOs = (p: string = platform()): Os =>
  p === 'darwin' ? 'darwin' : p === 'win32' ? 'windows' : 'linux';

export interface PathEnv {
  os?: Os;
  home?: string;
  xdgConfigHome?: string;
  appData?: string;
}

/** Resolve the default config-file path for the current OS. Honors XDG
 *  on Linux and the Windows %APPDATA% convention. */
export const defaultConfigPath = (env: PathEnv = {}): string => {
  const os = env.os ?? detectOs();
  const home = env.home ?? homedir();
  switch (os) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Recued', 'config.toml');
    case 'windows': {
      const appData = env.appData ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      return join(appData, 'Recued', 'config.toml');
    }
    case 'linux':
    default: {
      const xdg = env.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
      const base = xdg && xdg.length > 0 ? xdg : join(home, '.config');
      return join(base, 'recued', 'config.toml');
    }
  }
};

/** Expand `~` at the start of a path. Safe no-op when absent. */
export const expandHome = (p: string, home: string = homedir()): string =>
  p.startsWith('~/') || p === '~' ? join(home, p.slice(1)) : p;
