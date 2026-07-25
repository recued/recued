/** Phase D (D-106) — file-system watcher for the file collection.
 *
 *  Two jobs:
 *   1. Initial scan — recursive walk of `root`, emitting a `present`
 *      event per matching file. Runs once from `start()`.
 *   2. Live watch — `fs.watch(root, { recursive: true })` with a
 *      500 ms per-path debounce. Each fs.watch event stats the file;
 *      if it exists → `change`, else → `remove`.
 *
 *  Ignore matching is a gitignore subset (enough for the common
 *  `**\/node_modules/**`, `.DS_Store`, `*.log` patterns users write
 *  in TOML — no full gitignore semantics like negation). Patterns
 *  match paths relative to `root` using POSIX separators, so
 *  cross-platform.
 *
 *  Debounce: editor autosaves / chunked writes / macOS FSEvents
 *  redundancy all fire multiple events per change. We coalesce
 *  within a per-path window so each logical change becomes one
 *  `onEvent` callback.
 *
 *  Platform note: `fs.watch({ recursive: true })` is supported on
 *  macOS 10.5+, Windows, and Linux (with inotify) via Node 20+.
 *  On platforms without recursive support, callers fall back to a
 *  polled scan (out-of-scope for Phase D; the adapter still runs
 *  without fs.watch, just without live updates).
 */

import { stat, readdir } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type FsEventType = 'present' | 'change' | 'remove';

export interface FsEvent {
  type: FsEventType;
  /** Absolute path of the file. Callers that want a relative form
   *  compute it against `root` themselves. */
  path: string;
}

export interface FsWatcherOptions {
  /** Absolute directory to watch. Non-existent → `start` throws. */
  root: string;
  /** Gitignore-subset glob patterns. Empty list = match everything. */
  ignore: string[];
  /** Fires for every discovered + changed + removed file. Must not
   *  throw — failures are logged and swallowed so one bad event
   *  doesn't poison the watcher. */
  onEvent: (event: FsEvent) => Promise<void> | void;
  /** Coalesce successive events on the same path within this window.
   *  Defaults to 500 ms — matches the Phase C config watcher. */
  debounceMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** Test hook — swapping in a fake `watch` lets unit tests drive
   *  synthetic events without touching the real filesystem. The
   *  factory delegates to `fs.watch` by default. */
  watchFactory?: (root: string, listener: (eventType: string, filename: string | null) => void) => FSWatcher;
}

export interface FsWatcher {
  /** Runs initial scan then subscribes to fs.watch. Idempotent — a
   *  second call is a no-op (matches `CollectionSyncAdapter.start`
   *  contract). */
  start(): Promise<void>;
  /** Cancels debounce timers and closes the fs.watch handle.
   *  Idempotent. */
  stop(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────
// Gitignore-subset glob matcher
// ────────────────────────────────────────────────────────────────

/** Convert a glob pattern to a RegExp. Supports:
 *    `**\/` — zero or more path segments ('', 'a/', 'a/b/', ...).
 *    `**`   — any characters including `/`.
 *    `*`    — any character except `/`.
 *    `?`    — any single character except `/`.
 *  Other characters are literal. Leading `/` anchors to root.
 *  Trailing `/` is dropped (we match files, not directories).
 *
 *  Walks the pattern in a single pass rather than sequential
 *  string-replaces so `**\/node_modules/**` compiles to
 *  `(?:.*\/)?node_modules/.*` without the ordering traps of
 *  regex substitution. */
export const globToRegExp = (pattern: string): RegExp => {
  let p = pattern;
  if (p.endsWith('/')) p = p.slice(0, -1);
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);

  let re = '';
  const REGEX_META = '.+^$(){}|[]\\';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i++;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (REGEX_META.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}$`);
};

export const matchesAnyIgnore = (
  patterns: readonly RegExp[],
  relativePath: string,
): boolean => {
  const posixPath = relativePath.split(sep).join('/');
  for (const re of patterns) {
    if (re.test(posixPath)) return true;
  }
  return false;
};

// ────────────────────────────────────────────────────────────────
// Watcher factory
// ────────────────────────────────────────────────────────────────

const DEFAULT_DEBOUNCE_MS = 500;

const DEFAULT_WATCH_FACTORY: NonNullable<FsWatcherOptions['watchFactory']> = (
  root,
  listener,
) =>
  watch(root, { recursive: true }, (event, fname) => {
    listener(event as string, typeof fname === 'string' ? fname : null);
  });

export const createFsWatcher = (opts: FsWatcherOptions): FsWatcher => {
  const root = resolve(opts.root);
  const ignoreRegexes = opts.ignore.map(globToRegExp);
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const log = opts.log ?? (() => {});
  const watchFactory = opts.watchFactory ?? DEFAULT_WATCH_FACTORY;

  let started = false;
  let stopped = false;
  let watcher: FSWatcher | undefined;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const isIgnored = (absPath: string): boolean => {
    const rel = relative(root, absPath);
    if (rel === '' || rel.startsWith('..')) return true;
    return matchesAnyIgnore(ignoreRegexes, rel);
  };

  const safeFire = async (event: FsEvent): Promise<void> => {
    try {
      await opts.onEvent(event);
    } catch (err) {
      log('warn', `fs-watcher onEvent threw for ${event.path}`, { err });
    }
  };

  const scanDir = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      log('warn', `scanDir failed for ${dir}`, { err });
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (isIgnored(abs)) continue;
      if (entry.isDirectory()) {
        await scanDir(abs);
      } else if (entry.isFile()) {
        await safeFire({ type: 'present', path: abs });
      }
    }
  };

  const scheduleEvent = (absPath: string): void => {
    if (stopped) return;
    if (isIgnored(absPath)) return;
    const prior = pending.get(absPath);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      pending.delete(absPath);
      void (async (): Promise<void> => {
        try {
          await stat(absPath);
          await safeFire({ type: 'change', path: absPath });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            await safeFire({ type: 'remove', path: absPath });
          } else {
            log('warn', `stat failed for ${absPath}`, { err });
          }
        }
      })();
    }, debounceMs);
    pending.set(absPath, timer);
  };

  return {
    async start() {
      if (started || stopped) return;
      started = true;
      await scanDir(root);
      try {
        watcher = watchFactory(root, (_event, filename) => {
          if (!filename) return;
          const abs = resolve(root, filename);
          scheduleEvent(abs);
        });
      } catch (err) {
        log('error', `fs.watch failed to attach for ${root}`, { err });
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      if (watcher) {
        try { watcher.close(); } catch { /* best-effort */ }
        watcher = undefined;
      }
    },
  };
};
