/** The server log — `recued-server.log` beside the database, capped.
 *
 *  ⛔ WHY THIS EXISTS. Two ways a server started without a terminal lost or
 *  piled up its output:
 *  - **macOS autostart threw it away.** The installer's LaunchAgent sets no
 *    `StandardOutPath` / `StandardErrorPath`, so launchd hands the server
 *    `/dev/null` for both. Autostart is on by default, so a Mac installed the
 *    normal way kept no log at all, and `recued logs` answered "No log file".
 *  - **`recued start` kept it without limit.** It opens this file and hands it
 *    to the server as stdout and stderr — and that is how Windows autostart
 *    runs the server (a Startup shortcut to `recued start`). The server wrote
 *    straight to the file, so nothing ever bounded it.
 *
 *  `recued update` replaces only the payload — never the plist, never
 *  `recued-supervise`, never the shortcut — so the server fixes both itself: a
 *  stream that goes to `/dev/null`, or that already IS this realm's log file,
 *  is written through {@link openRotatingLog} instead.
 *
 *  - **Nothing else is taken.** A terminal, a pipe (Docker, a test harness),
 *    the systemd journal and a file of the operator's own choosing are left
 *    alone — each is somewhere the operator chose to keep the output.
 *  - **Bounded.** Past {@link SERVER_LOG_MAX_BYTES} the file is copied to
 *    `recued-server.log.1` (replacing the older copy) and emptied, so the log
 *    never holds much more than twice that. Copied and emptied, not renamed:
 *    `recued start` and anything the server spawns keep writing through their
 *    own handle on this file, which a rename would leave pointing at the copy;
 *    and Windows may refuse to rename a file another handle holds. Measured
 *    2026-10-08: a start and stop write ~2.2 KB, while ten idle minutes and 50
 *    rpc calls wrote nothing; what fills it is a failure that repeats (~1.1 KB
 *    per error with its stack).
 *  - **Timestamped** per line: nothing else in the output carries the time.
 *  - **Never the reason a server stops.** An unopenable file means the stream
 *    is left as it was; a failed write drops that output.
 *
 *  Node built-ins only: the router installs it before the boot's module graph. */

import {
  copyFileSync,
  fstatSync,
  mkdirSync,
  openSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const SERVER_LOG_FILE = 'recued-server.log';
export const SERVER_LOG_MAX_BYTES = 5 * 1024 * 1024;

export const serverLogPath = (dbPath: string): string =>
  join(dirname(resolve(dbPath)), SERVER_LOG_FILE);

/** The file the log rolls over into: one older copy, never more. */
export const previousServerLogPath = (dbPath: string): string => `${serverLogPath(dbPath)}.1`;

/** True when `fd` is `/dev/null` — output written there is gone. (On Windows
 *  there is no `/dev/null` to stat, so this is always false there.) */
export const isDiscardedFd = (fd: number): boolean => {
  try {
    const stream = fstatSync(fd);
    return stream.isCharacterDevice() && stream.rdev === statSync('/dev/null').rdev;
  } catch {
    return false;
  }
};

/** True when `fd` is the regular file at `path` — the same device and inode,
 *  as `recued start` hands its server the log. A zero inode (a filesystem
 *  that does not report one) never matches: every file would look the same. */
export const isFdTheFile = (fd: number, path: string): boolean => {
  try {
    const stream = fstatSync(fd, { bigint: true });
    if (!stream.isFile() || stream.ino === 0n) return false;
    const file = statSync(path, { bigint: true });
    return stream.dev === file.dev && stream.ino === file.ino;
  } catch {
    return false;
  }
};

export interface LogSink {
  write: (text: string) => void;
}

/** An append-only file that starts over past `maxBytes`, keeping one older copy.
 *  Throws only from the first open — the caller then leaves the stream alone. */
export const openRotatingLog = (opts: {
  path: string;
  maxBytes?: number;
  now?: () => Date;
}): LogSink => {
  const { path } = opts;
  const maxBytes = opts.maxBytes ?? SERVER_LOG_MAX_BYTES;
  const now = opts.now ?? (() => new Date());
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o600);
  let atLineStart = true;

  // Read from the file, not counted here: other handles append to it too.
  const sizeNow = (): number => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };

  // Raised past the cap after a failed roll-over, so a full disk costs one
  // attempt per maxBytes written rather than a 5 MB copy on every write.
  let rollOverAt = maxBytes;
  const rollOver = (size: number): void => {
    try {
      copyFileSync(path, `${path}.1`);
      // By path, not through `fd`: an append-only handle cannot truncate on
      // Windows. Every handle on the file appends, so each carries on at 0.
      truncateSync(path, 0);
      rollOverAt = maxBytes;
    } catch {
      rollOverAt = size + maxBytes;
    }
  };

  const stamp = (text: string): string => {
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (atLineStart && text[i] !== '\n') out += `${now().toISOString()} `;
      const nl = text.indexOf('\n', i);
      if (nl === -1) {
        out += text.slice(i);
        atLineStart = false;
        break;
      }
      out += text.slice(i, nl + 1);
      atLineStart = true;
      i = nl + 1;
    }
    return out;
  };

  const atOpen = sizeNow();
  if (atOpen >= maxBytes) rollOver(atOpen);

  return {
    write: (text: string): void => {
      if (text.length === 0) return;
      const data = Buffer.from(stamp(text), 'utf8');
      const size = sizeNow();
      if (size > 0 && size + data.length > rollOverAt) rollOver(size);
      try {
        writeSync(fd, data);
      } catch {
        // A full disk or a vanished directory drops this output, never the server.
      }
    },
  };
};

type WriteCallback = (err?: Error | null) => void;

interface PatchableStream {
  write: (...args: never[]) => boolean;
}

/** Route a stream's writes to `sink`. Its own destination is `/dev/null` or
 *  the log file itself, so nothing is lost by no longer writing there. */
const routeTo = (stream: PatchableStream, sink: LogSink): void => {
  const write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8';
    sink.write(
      typeof chunk === 'string'
        ? Buffer.from(chunk, encoding).toString('utf8')
        : Buffer.from(chunk).toString('utf8'),
    );
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (done) process.nextTick(done);
    return true;
  };
  stream.write = write as unknown as PatchableStream['write'];
};

export interface KeepServerLogDeps {
  /** Defaults to this process's stdout (fd 1) and stderr (fd 2). */
  streams?: { name: 'stdout' | 'stderr'; fd: number; stream: PatchableStream }[];
  isDiscarded?: (fd: number) => boolean;
  /** Whether `fd` is already the log file. Defaults to {@link isFdTheFile}. */
  isTheLog?: (fd: number, path: string) => boolean;
  maxBytes?: number;
  now?: () => Date;
}

/** Keep this process's output in the capped server log when it would
 *  otherwise be discarded, or when it is already going to that file. Returns
 *  the log's path and the streams taken, or null when none were (neither
 *  case, or the file could not be opened). */
export const keepServerLog = (
  dbPath: string,
  deps: KeepServerLogDeps = {},
): { path: string; streams: ('stdout' | 'stderr')[] } | null => {
  const path = serverLogPath(dbPath);
  const isDiscarded = deps.isDiscarded ?? isDiscardedFd;
  const isTheLog = deps.isTheLog ?? isFdTheFile;
  const streams = (deps.streams ?? [
    { name: 'stdout' as const, fd: 1, stream: process.stdout as unknown as PatchableStream },
    { name: 'stderr' as const, fd: 2, stream: process.stderr as unknown as PatchableStream },
  ]).filter(({ fd }) => isDiscarded(fd) || isTheLog(fd, path));
  if (streams.length === 0) return null;

  let sink: LogSink;
  try {
    sink = openRotatingLog({
      path,
      ...(deps.maxBytes === undefined ? {} : { maxBytes: deps.maxBytes }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  } catch {
    return null;
  }
  for (const { stream } of streams) routeTo(stream, sink);
  return { path, streams: streams.map(({ name }) => name) };
};
