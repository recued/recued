/** OS-conventional config + data paths. Kept separate from the TOML
 *  parser so tests can stub a fake environment. */

import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

export type Os = 'darwin' | 'linux' | 'windows';

/** Normalise `os.platform()` to our three buckets. Any non-darwin / non-
 *  windows platform (Linux, BSD, etc.) follows XDG. */
export const detectOs = (p: string = platform()): Os =>
  p === 'darwin' ? 'darwin' : p === 'win32' ? 'windows' : 'linux';

export interface PathEnv {
  os?: Os;
  home?: string;
  xdgConfigHome?: string;
  xdgDataHome?: string;
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

/** Default `data_path` for each OS — where SQLite, blobs, vault, and
 *  the server's pidfile all live. */
export const defaultDataPath = (env: PathEnv = {}): string => {
  const os = env.os ?? detectOs();
  const home = env.home ?? homedir();
  switch (os) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Recued');
    case 'windows': {
      const appData = env.appData ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      return join(appData, 'Recued');
    }
    case 'linux':
    default: {
      const xdg = env.xdgDataHome ?? process.env.XDG_DATA_HOME;
      const base = xdg && xdg.length > 0 ? xdg : join(home, '.local', 'share');
      return join(base, 'recued');
    }
  }
};

/** Expand `~` at the start of a path. Safe no-op when absent. */
export const expandHome = (p: string, home: string = homedir()): string =>
  p.startsWith('~/') || p === '~' ? join(home, p.slice(1)) : p;

/** Expand `{data_path}` placeholders inside bootstrap path values so
 *  users can keep the "logs next to data" default even when they move
 *  data_path. Intentionally minimal — only this one token. */
export const expandDataPath = (p: string, dataPath: string): string =>
  p.includes('{data_path}') ? p.split('{data_path}').join(dataPath) : p;

/** Resolve a user-supplied bootstrap path: expand `~` and `{data_path}`,
 *  then resolve to absolute. */
export const resolveBootstrapPath = (
  p: string,
  dataPath: string,
  home: string = homedir(),
): string => resolve(expandHome(expandDataPath(p, dataPath), home));
