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
 *   3. Settle walk — one more walk `settleMs` after the watcher attaches,
 *      turning whatever changed in between into ordinary events.
 *
 *  ⛔ WHY THE SETTLE WALK. A watcher that has attached is not yet a watcher
 *  that delivers. On macOS a recursive `fs.watch` rides an FSEvents stream
 *  that starts asynchronously, and while the disk is busy a file written in
 *  its first milliseconds is never reported: measured 2026-10-09, a write at
 *  0 ms after attaching was lost in 19 of 20 trials under filesystem churn
 *  (0 of 20 at 20 ms or later, 0 of 20 on a quiet disk). The initial walk
 *  runs BEFORE the watcher attaches, so that gap was a file the collection
 *  never indexed until a restart or its next change — the "flaky"
 *  `file-collection` live test under every sweep's load was this, lost, not
 *  late.
 *
 *  Debounce: editor autosaves / chunked writes / macOS FSEvents
 *  redundancy all fire multiple events per change. We coalesce
 *  within a per-path window so each logical change becomes one
 *  `onEvent` callback.
 *
 *  Platform note: `fs.watch({ recursive: true })` is supported on
 *  macOS 10.5+, Windows, and Linux (with inotify) via Node 20+.
 *  On platforms without recursive support, callers can select one-shot
 *  mode: the initial scan runs, but no background polling is scheduled.
 *  An explicit `collection.file.resync` restarts that bounded scan.
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
  /** How long after the watcher attaches to walk the tree once more and turn
   *  what changed meanwhile into events (see the header). Defaults to
   *  `DEFAULT_SETTLE_MS`; a negative value skips the walk (tests). */
  settleMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** `realtime` attaches recursive `fs.watch` after the initial scan.
   *  `none` performs only the initial scan; it never starts a polling loop.
   *  Defaults to `realtime` for the legacy Phase D caller. */
  watchMode?: 'realtime' | 'none';
  /** Called if a watcher that attached successfully later emits `error`.
   *  This is a health signal only; no polling fallback is started. */
  onUnavailable?: (error: FsWatchUnavailableError) => Promise<void> | void;
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
  /** Directories the initial walk could not read — the root among them when
   *  it is gone. A walk with any is not a full list of what is on disk. */
  walkErrors(): number;
}

/** Raised when realtime was promised by the capability probe but the live
 *  watcher can no longer attach. Callers surface this as degraded health
 *  rather than silently leaving a stale collection marked healthy. */
export class FsWatchUnavailableError extends Error {
  readonly code = 'FS_WATCH_UNAVAILABLE';

  constructor(root: string, readonly cause: unknown) {
    super(`fs.watch failed to attach for ${root}`);
    this.name = 'FsWatchUnavailableError';
  }
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

/** About 50x the longest measured window in which a just-attached watcher
 *  missed a write (under 20 ms, on a churned disk). */
export const DEFAULT_SETTLE_MS = 1_000;

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
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const watchMode = opts.watchMode ?? 'realtime';
  const log = opts.log ?? (() => {});
  const watchFactory = opts.watchFactory ?? DEFAULT_WATCH_FACTORY;

  let started = false;
  let stopped = false;
  let walkErrorCount = 0;
  let watcher: FSWatcher | undefined;
  let watcherErrorListener: ((error: Error) => void) | undefined;
  let attaching = false;
  let attachmentFailed = false;
  let attachmentError: unknown;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<void>>();
  /** What the initial walk saw, kept current by every event processed until
   *  the settle walk compares against it; released after. */
  const known = new Map<string, { mtimeMs: number; size: number }>();
  let settled = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const track = (work: Promise<void>, label: string): void => {
    let tracked: Promise<void>;
    tracked = work
      .catch((err) => {
        log('warn', `fs watcher ${label} failed for ${root}`, { err });
      })
      .finally(() => {
        inFlight.delete(tracked);
      });
    inFlight.add(tracked);
  };

  const closeWatchHandle = (): void => {
    const active = watcher;
    watcher = undefined;
    if (!active) return;
    if (watcherErrorListener) {
      active.removeListener('error', watcherErrorListener);
      watcherErrorListener = undefined;
    }
    try { active.close(); } catch { /* best-effort */ }
  };

  const notifyUnavailable = async (error: FsWatchUnavailableError): Promise<void> => {
    try {
      await opts.onUnavailable?.(error);
    } catch (err) {
      log('warn', `fs watcher degradation callback failed for ${root}`, { err });
    }
  };

  const onWatcherError = (cause: Error): void => {
    closeWatchHandle();
    if (attaching) {
      attachmentFailed = true;
      attachmentError = cause;
      return;
    }
    const error = new FsWatchUnavailableError(root, cause);
    log('error', `fs.watch became unavailable for ${root}`, { err: cause });
    track(notifyUnavailable(error), 'degradation callback');
  };

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
      walkErrorCount += 1;
      log('warn', `scanDir failed for ${dir}`, { err });
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (isIgnored(abs)) continue;
      if (entry.isDirectory()) {
        await scanDir(abs);
      } else if (entry.isFile()) {
        try {
          const st = await stat(abs);
          known.set(abs, { mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* gone already: the settle walk or an event decides */ }
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
      track((async (): Promise<void> => {
        try {
          const st = await stat(absPath);
          if (!settled) known.set(absPath, { mtimeMs: st.mtimeMs, size: st.size });
          await safeFire({ type: 'change', path: absPath });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            if (!settled) known.delete(absPath);
            await safeFire({ type: 'remove', path: absPath });
          } else {
            log('warn', `stat failed for ${absPath}`, { err });
          }
        }
      })(), `event for ${absPath}`);
    }, debounceMs);
    pending.set(absPath, timer);
  };

  /** Walk again once the watcher is surely live; anything new, changed or gone
   *  since the initial walk (and not already handled by an event) goes through
   *  `scheduleEvent` like a live event. */
  const settleWalk = async (): Promise<void> => {
    const seen = new Map<string, { mtimeMs: number; size: number }>();
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;   // its files are candidates below, and each is stat'ed before a removal
      }
      for (const entry of entries) {
        if (stopped) return;
        const abs = join(dir, entry.name);
        if (isIgnored(abs)) continue;
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile()) {
          try {
            const st = await stat(abs);
            seen.set(abs, { mtimeMs: st.mtimeMs, size: st.size });
          } catch { /* gone mid-walk: an event or the next start decides */ }
        }
      }
    };
    await walk(root);
    if (stopped) return;
    for (const [abs, now] of seen) {
      const was = known.get(abs);
      if (!was || was.mtimeMs !== now.mtimeMs || was.size !== now.size) scheduleEvent(abs);
    }
    // Not seen is only a CANDIDATE: `scheduleEvent` stats it and reports a
    // removal only on ENOENT. So a folder this walk could not read takes
    // nothing out (its files stat EACCES, or fine) — unlike the collection's
    // restart walk, which removes without a stat and so needs a clean walk.
    for (const abs of known.keys()) if (!seen.has(abs)) scheduleEvent(abs);
    settled = true;
    known.clear();
  };

  return {
    async start() {
      if (started || stopped) return;
      started = true;
      await scanDir(root);
      if (watchMode === 'none') {
        settled = true;
        known.clear();
        log('info', `fs watcher for ${root} is one-shot; realtime unavailable`);
        return;
      }
      try {
        attaching = true;
        watcher = watchFactory(root, (_event, filename) => {
          if (!filename) return;
          const abs = resolve(root, filename);
          scheduleEvent(abs);
        });
        watcherErrorListener = onWatcherError;
        watcher.on('error', watcherErrorListener);
        // Catch watchers that return a handle and then fail on their first
        // event-loop turn. Treat that as attachment failure, not healthy start.
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        attaching = false;
        if (attachmentFailed) {
          throw new FsWatchUnavailableError(root, attachmentError);
        }
        if (settleMs >= 0) {
          settleTimer = setTimeout(() => {
            settleTimer = undefined;
            if (!stopped) track(settleWalk(), 'settle walk');
          }, settleMs);
        } else {
          settled = true;
          known.clear();
        }
      } catch (err) {
        attaching = false;
        settled = true;
        known.clear();
        closeWatchHandle();
        log('error', `fs.watch failed to attach for ${root}`, { err });
        if (err instanceof FsWatchUnavailableError) throw err;
        throw new FsWatchUnavailableError(root, err);
      }
    },
    walkErrors: () => walkErrorCount,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (settleTimer) clearTimeout(settleTimer);
      settled = true;
      known.clear();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      closeWatchHandle();
      const active = [...inFlight];
      if (active.length > 0) await Promise.allSettled(active);
    },
  };
};
