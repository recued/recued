/** `recued logs [-f]` — print (or follow) the server log.
 *
 *  The log is `recued-server.log` beside the database. `recued start` writes
 *  it, and so does a server whose output would otherwise be discarded — the
 *  macOS LaunchAgent's (`cli/server-log.ts`). It rolls over into
 *  `recued-server.log.1` by copying and emptying the file, so the last lines
 *  can span both files.
 *
 *  Following reads the file itself ({@link followLog}). It used to run
 *  `tail -F`, which Windows does not have — and on Windows, autostart runs the
 *  server under `recued start`, so this log is where its output goes.
 *
 *  ⚠ Under systemd the output is in the journal, not here — the unit's
 *  journalctl command is printed, rather than "No log file" alone.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { previousServerLogPath, serverLogPath } from '../cli/server-log.js';

const LINES = 50;
/** How often a follow looks for new output. */
const FOLLOW_EVERY_MS = 500;
/** Enough of a file's start to tell it from the next one: its first line's time and text. */
const HEAD_BYTES = 64;

export interface LogsCommandDeps {
  dbPath: string;
  follow: boolean;
  /** Injected for tests. */
  platform?: NodeJS.Platform;
  homedir?: () => string;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  print?: (line: string) => void;
  /** Follows the log at `path`, whose older copy is `olderPath`. Defaults to
   *  {@link followLog} on this terminal. */
  followFile?: (path: string, olderPath: string) => void;
}

/** The journalctl command for this machine's recued systemd unit, if it has one. */
export const journalCommandFor = (deps: {
  platform?: NodeJS.Platform;
  homedir?: () => string;
  exists?: (path: string) => boolean;
} = {}): string | null => {
  if ((deps.platform ?? process.platform) !== 'linux') return null;
  const exists = deps.exists ?? existsSync;
  if (exists('/etc/systemd/system/recued.service')) return `journalctl -u recued -n ${LINES}`;
  const userUnit = join((deps.homedir ?? homedir)(), '.config/systemd/user/recued.service');
  if (exists(userUnit)) return `journalctl --user -u recued -n ${LINES}`;
  return null;
};

const linesOf = (text: string): string[] => {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/** The last {@link LINES} lines, reaching into the older copy when the current
 *  file holds fewer. */
const lastLines = (current: string, older: () => string | null): string[] => {
  let lines = linesOf(current);
  if (lines.length < LINES) {
    const before = older();
    if (before !== null) lines = [...linesOf(before), ...lines];
  }
  return lines.slice(-LINES);
};

/** Up to `length` bytes of `path` from `from`; fewer when the file is shorter. */
const readAt = (path: string, from: number, length: number): Buffer => {
  const out = Buffer.alloc(Math.max(0, length));
  if (out.length === 0) return out;
  const fd = openSync(path, 'r');
  try {
    return out.subarray(0, readSync(fd, out, 0, out.length, from));
  } finally {
    closeSync(fd);
  }
};

export interface FollowLogOptions {
  /** Where the output goes. Defaults to stdout. */
  write?: (chunk: Buffer) => void;
  /** Calls `look` from now on and returns how to stop. Defaults to every
   *  {@link FOLLOW_EVERY_MS}. */
  schedule?: (look: () => void) => () => void;
}

/** Print the log's last lines, then each line as it is written, until stopped.
 *
 *  A roll-over copies the file to `olderPath` and empties it. Here that shows
 *  as the file's first bytes changing, or its size dropping below what was
 *  read. What was written since the last look is then in the older copy, and
 *  is read from there when that copy starts with the same bytes; following
 *  carries on from the top of the emptied file. So no line is skipped or
 *  shown twice, unless the log rolls over twice between two looks: the lines
 *  in between are then skipped, never shown in part. */
export const followLog = (
  path: string,
  olderPath: string,
  opts: FollowLogOptions = {},
): { stop: () => void } => {
  const write = opts.write ?? ((chunk: Buffer) => { process.stdout.write(chunk); });
  const schedule = opts.schedule ?? ((look: () => void) => {
    const timer = setInterval(look, FOLLOW_EVERY_MS);
    return () => { clearInterval(timer); };
  });

  // Read once, so where following starts is exactly what was shown.
  const current = readFileSync(path);
  let read = current.length;
  let head = Buffer.from(current.subarray(0, HEAD_BYTES));
  const text = current.toString('utf8');
  const shown = lastLines(text, () => (existsSync(olderPath) ? readFileSync(olderPath, 'utf8') : null)).join('\n');
  // A last line still being written is left open, so the rest of it joins it.
  if (shown !== '') write(Buffer.from(text === '' || text.endsWith('\n') ? `${shown}\n` : shown));

  const take = (chunk: Buffer): void => {
    if (chunk.length === 0) return;
    if (head.length < HEAD_BYTES) head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)]);
    read += chunk.length;
    write(chunk);
  };

  /** What the older copy holds past `read`, when it is the copy of the file
   *  being followed. */
  const restFromOlder = (): Buffer => {
    try {
      if (!readAt(olderPath, 0, head.length).equals(head)) return Buffer.alloc(0);
      return readAt(olderPath, read, statSync(olderPath).size - read);
    } catch {
      return Buffer.alloc(0);
    }
  };

  const look = (): void => {
    try {
      const size = statSync(path).size;
      const chunk = readAt(path, read, size - read);
      // Checked after reading, so a roll-over during the read is caught too:
      // the copy is made before the file is emptied, so it holds all of it.
      if (size >= read && (read === 0 || readAt(path, 0, head.length).equals(head))) {
        take(chunk);
        return;
      }
      const rest = restFromOlder();
      if (rest.length > 0) write(rest);
      read = 0;
      head = Buffer.alloc(0);
      take(readAt(path, 0, statSync(path).size));
    } catch {
      // The file is gone for the moment: look again next time.
    }
  };

  return { stop: schedule(look) };
};

/** Follow on this terminal until Ctrl+C, or until whatever reads the output
 *  goes away (`recued logs -f | head`). */
const followOnStdout = (path: string, olderPath: string): void => {
  const { stop } = followLog(path, olderPath);
  const end = (): void => {
    stop();
    process.exit(0);
  };
  process.on('SIGINT', end);
  process.stdout.on('error', end);
};

export async function cmdLogs(deps: LogsCommandDeps): Promise<void> {
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf-8'));
  const print = deps.print ?? ((line: string) => { console.log(line); });
  const logFile = serverLogPath(deps.dbPath);
  const previous = previousServerLogPath(deps.dbPath);
  const journal = journalCommandFor({
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    ...(deps.homedir === undefined ? {} : { homedir: deps.homedir }),
    exists,
  });
  const journalHint = (): void => {
    if (journal === null) return;
    print('This server runs under systemd, which keeps its output in the journal:');
    print(`  ${journal}`);
    print('Add -f to follow it.');
  };

  if (!exists(logFile)) {
    print(`No log file at ${logFile}`);
    journalHint();
    return;
  }

  if (deps.follow) {
    (deps.followFile ?? followOnStdout)(logFile, previous);
    return;
  }

  print(lastLines(readFile(logFile), () => (exists(previous) ? readFile(previous) : null)).join('\n'));
  journalHint();
}
