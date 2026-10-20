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
 *   4. Rescan — when the watch may have missed changes, ask the owner to walk
 *      again (`onRescanNeeded`, `rescan`). ⛔ On macOS every watch in a
 *      process shares one FSEvents stream, rebuilt "since now" whenever a
 *      watch is added or removed, and what changes meanwhile is lost without a
 *      word: measured 2026-10-19, 146-148 of 148 files written at 10 a second
 *      went unreported while another watch opened and closed every 400 ms (0 of
 *      148 without; 0 on Linux). The watch process says when it rebuilt the
 *      stream (`rescan`). A burst of writes can lose files too (19-42% at 200 a
 *      second); FSEvents then may report the folder itself, which also comes
 *      with no loss at all, so that asks for a walk only once it goes quiet.
 *   5. Folders — a folder the watch reports that no walk has shown (moved in,
 *      or renamed into place) is walked, its files reported as changes: the
 *      watch may name only the folder, never the files that came with it
 *      (measured 2026-10-20: macOS and Windows do for a folder moved in or
 *      out, Linux for one moved out). A folder reported gone is a `remove`
 *      like a file's, and the collection takes out the records under it. A
 *      folder a walk has shown is not walked again: Windows reports a file's
 *      folder, and that folder's own folder, on every write to the file.
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
 *  ⛔ ON MACOS THE WATCH ITSELF LIVES IN A PROCESS OF ITS OWN (`watch-host.ts`):
 *  closing a recursive watch there can block its event loop for seconds, and on
 *  the server's own loop that froze every chat, run and request with it. On
 *  Linux and Windows it stays here, where a close does not block
 *  (`watchesInOwnProcess`).
 *
 *  Platform note: `fs.watch({ recursive: true })` is supported on
 *  macOS 10.5+, Windows, and Linux (with inotify) via Node 20+.
 *  On platforms without recursive support, callers can select one-shot
 *  mode: the initial scan runs, but no background polling is scheduled.
 *  An explicit `collection.file.resync` restarts that bounded scan.
 */

import { lstat, realpath, stat, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

import { watch } from 'node:fs';
import { sharedWatchHost, watchesInOwnProcess } from './watch-host.js';

export type FsEventType = 'present' | 'change' | 'remove';

export interface FsEvent {
  type: FsEventType;
  /** Absolute path of the file — or, for a `remove`, possibly of a folder that
   *  went with its files (see the header, 5). Callers that want a relative
   *  form compute it against `root` themselves. */
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
  /** The watch may have missed changes: its watch process rebuilt the event
   *  stream, or a burst ended that FSEvents reported as the folder itself. The
   *  owner walks the folder again (`rescan`) and compares with what it stored. */
  onRescanNeeded?: () => void;
  /** Test hook — swapping in a fake `watch` lets unit tests drive
   *  synthetic events without touching the real filesystem. The
   *  factory delegates to `fs.watch` by default. */
  watchFactory?: (root: string, listener: (eventType: string, filename: string | null) => void) => FsWatchHandle;
}

/** What the watcher needs of a watch: `fs.watch`'s handle, or a `HostedWatch`.
 *  `ready`, when there is one, settles once the watch has attached. */
export interface FsWatchHandle {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  /** A hosted watch's word that it may have missed changes. */
  on(event: 'rescan', listener: () => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  readonly ready?: Promise<void>;
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
  /** Walk again, firing `present` for every file as the initial walk does.
   *  `complete` when it read every directory and the watcher did not stop. */
  rescan(): Promise<{ complete: boolean }>;
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

/** How long events naming the folder itself must stop before a walk. */
const ROOT_EVENT_QUIET_MS = 2_000;

/** The watch a folder's watcher opens when no test supplies one: in the watch
 *  process on macOS, in the server elsewhere (`watchesInOwnProcess`). */
export const defaultWatchFactory = (
  platform: NodeJS.Platform = process.platform,
): NonNullable<FsWatcherOptions['watchFactory']> => (watchesInOwnProcess(platform)
  ? (root, listener) => sharedWatchHost().watch(root, listener)
  : (root, listener) => watch(root, { recursive: true }, (event, fname) => {
    listener(event as string, typeof fname === 'string' ? fname : null);
  }));

export const createFsWatcher = (opts: FsWatcherOptions): FsWatcher => {
  const root = resolve(opts.root);
  const ignoreRegexes = opts.ignore.map(globToRegExp);
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const watchMode = opts.watchMode ?? 'realtime';
  const log = opts.log ?? (() => {});
  const watchFactory = opts.watchFactory ?? defaultWatchFactory();

  let started = false;
  let stopped = false;
  let walkErrorCount = 0;
  let watcher: FsWatchHandle | undefined;
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
  /** Every folder under the root a walk has shown (see the header, 5). */
  const knownDirs = new Set<string>();
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  /** How the watch names the folder itself: by its own name, as libuv does. */
  let rootName: string | undefined;

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

  /** Fires `present` for every file under `dir`; returns how many directories
   *  it could not read. */
  const scanDir = async (dir: string): Promise<number> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      log('warn', `scanDir failed for ${dir}`, { err });
      return 1;
    }
    let unread = 0;
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (isIgnored(abs)) continue;
      if (entry.isDirectory()) {
        knownDirs.add(abs);
        unread += await scanDir(abs);
      } else if (entry.isFile()) {
        try {
          const st = await stat(abs);
          known.set(abs, { mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* gone already: the settle walk or an event decides */ }
        await safeFire({ type: 'present', path: abs });
      }
    }
    return unread;
  };

  const requestRescan = (): void => {
    if (!stopped) opts.onRescanNeeded?.();
  };
  /** An event naming the folder itself: FSEvents' way of saying it dropped
   *  events under it, and also of saying nothing much. Ask for a walk once
   *  they stop coming, when the burst that dropped them is over. */
  const folderItselfReported = (): void => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => { quietTimer = undefined; requestRescan(); }, ROOT_EVENT_QUIET_MS);
  };

  /** A folder gone: so are the folders under it. */
  const forgetFolder = (absPath: string): void => {
    if (!knownDirs.delete(absPath)) return;
    const under = absPath + sep;
    for (const dir of knownDirs) if (dir.startsWith(under)) knownDirs.delete(dir);
  };

  /** A folder no walk has shown: report every file in it (see the header, 5). */
  const walkNewFolder = async (dir: string): Promise<void> => {
    knownDirs.add(dir);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;   // gone again, or unreadable: its own events or the next walk decide
    }
    for (const entry of entries) {
      if (stopped) return;
      const abs = join(dir, entry.name);
      if (isIgnored(abs)) continue;
      if (entry.isDirectory()) await walkNewFolder(abs);
      else if (entry.isFile()) await look(abs);
    }
  };

  /** What a path the watch reported is now: a file changed, a folder new to the
   *  watcher, or something gone. */
  const look = async (absPath: string): Promise<void> => {
    let st: import('node:fs').Stats;
    try {
      st = await stat(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!settled) known.delete(absPath);
        forgetFolder(absPath);
        await safeFire({ type: 'remove', path: absPath });
      } else {
        log('warn', `stat failed for ${absPath}`, { err });
      }
      return;
    }
    if (st.isDirectory()) {
      // `stat` follows a link to a folder; a walk never does.
      const link = await lstat(absPath).then((l) => l.isSymbolicLink(), () => true);
      if (!link && !knownDirs.has(absPath)) await walkNewFolder(absPath);
      return;
    }
    if (!settled) known.set(absPath, { mtimeMs: st.mtimeMs, size: st.size });
    await safeFire({ type: 'change', path: absPath });
  };

  const scheduleEvent = (absPath: string): void => {
    if (stopped) return;
    if (isIgnored(absPath)) return;
    const prior = pending.get(absPath);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      pending.delete(absPath);
      track(look(absPath), `event for ${absPath}`);
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
          knownDirs.add(abs);
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
      walkErrorCount = await scanDir(root);
      if (watchMode === 'none') {
        settled = true;
        known.clear();
        log('info', `fs watcher for ${root} is one-shot; realtime unavailable`);
        return;
      }
      try {
        attaching = true;
        rootName = basename(await realpath(root).catch(() => root));
        const handle = watchFactory(root, (_event, filename) => {
          if (!filename) return;
          if (filename === rootName) folderItselfReported();
          const abs = resolve(root, filename);
          scheduleEvent(abs);
        });
        watcher = handle;
        watcherErrorListener = onWatcherError;
        handle.on('error', watcherErrorListener);
        handle.on('rescan', requestRescan);
        // A hosted watch attaches in its process: wait for it, so a watch that
        // cannot attach still fails `start` rather than its health later.
        if (handle.ready !== undefined) await handle.ready;
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
    async rescan() {
      if (stopped) return { complete: false };
      const unread = await scanDir(root);
      // What the walk saw is only the settle walk's to keep.
      if (settled) known.clear();
      return { complete: unread === 0 && !stopped };
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (quietTimer) clearTimeout(quietTimer);
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
