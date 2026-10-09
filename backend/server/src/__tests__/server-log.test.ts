/** The server log — capped, timestamped `recued-server.log` beside the database.
 *
 *  ⛔ WHY THIS EXISTS. The macOS LaunchAgent hands the server /dev/null for
 *  both streams, so a Mac installed the normal way kept no log at all; and
 *  `recued start` — Windows autostart — hands it the log file itself, which
 *  nothing ever bounded (`cli/server-log.ts`). The unit half drives the file
 *  and the routing; the end-to-end half runs the real CLI with its output on
 *  /dev/null as launchd starts it, under `recued start`, and on a pipe, which
 *  must be left alone — and follows the log with `recued logs -f`. */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type StdioOptions } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SERVER_LOG_FILE,
  isFdTheFile,
  keepServerLog,
  openRotatingLog,
  previousServerLogPath,
  serverLogPath,
} from '../cli/server-log.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const binPath = join(repoRoot, 'backend/server/src/bin.ts');
const serverTsconfigPath = join(repoRoot, 'backend/server/tsconfig.json');
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

let dir: string | undefined;
const openFds: number[] = [];
const makeTmp = (): string => (dir = mkdtempSync(join(tmpdir(), 'recued-server-log-')));
/** An append handle on `path`, as `recued start` opens the log for its server. */
const appendHandle = (path: string): number => {
  const fd = openSync(path, 'a');
  openFds.push(fd);
  return fd;
};

afterEach(() => {
  for (const fd of openFds.splice(0)) closeSync(fd);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const fixedClock = (iso = '2026-10-08T12:00:00.000Z') => () => new Date(iso);
const at = '2026-10-08T12:00:00.000Z';

describe('the server log file', () => {
  it('stamps every line once, across writes that split a line, and leaves blank lines bare', () => {
    const path = join(makeTmp(), SERVER_LOG_FILE);
    const log = openRotatingLog({ path, now: fixedClock() });
    log.write('first ');
    log.write('line\n\nsecond line\nthird');
    log.write(' line\n');
    expect(readFileSync(path, 'utf8')).toBe([
      `${at} first line`,
      '',
      `${at} second line`,
      `${at} third line`,
      '',
    ].join('\n'));
  });

  it('rolls over past the cap into .1, keeping ONE older copy', () => {
    const path = join(makeTmp(), SERVER_LOG_FILE);
    const log = openRotatingLog({ path, maxBytes: 100, now: fixedClock() });
    const line = (n: number) => `line ${String(n).padStart(3, '0')}\n`; // 34 bytes stamped
    for (let n = 1; n <= 9; n += 1) log.write(line(n));
    // 34-byte lines into 100 bytes: two lines per file, then a rollover.
    expect(readFileSync(path, 'utf8')).toBe(`${at} line 009\n`);
    expect(readFileSync(`${path}.1`, 'utf8')).toBe(`${at} line 007\n${at} line 008\n`);
    expect(existsSync(`${path}.2`)).toBe(false);
  });

  it('starts over at open when the file left behind is already at the cap', () => {
    const path = join(makeTmp(), SERVER_LOG_FILE);
    writeFileSync(path, 'x'.repeat(150));
    const log = openRotatingLog({ path, maxBytes: 100, now: fixedClock() });
    log.write('after\n');
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('x'.repeat(150));
    expect(readFileSync(path, 'utf8')).toBe(`${at} after\n`);
  });

  it('counts what other handles append, and leaves them appending to the live file after a roll-over', () => {
    // `recued start` keeps its own handle on the file, and so does anything
    // the server spawns with its output inherited. A rename would leave those
    // writing into the copy; copy-and-empty leaves them on the live file.
    const path = join(makeTmp(), SERVER_LOG_FILE);
    const log = openRotatingLog({ path, maxBytes: 100, now: fixedClock() });
    const inherited = appendHandle(path);
    writeSync(inherited, `${'i'.repeat(79)}\n`); // 80 bytes the writer did not write
    log.write('ours\n'); // 25 + 5 = 30 bytes: 80 + 30 > 100, so it rolls over first
    writeSync(inherited, 'inherited, after the roll-over\n');
    expect(readFileSync(`${path}.1`, 'utf8')).toBe(`${'i'.repeat(79)}\n`);
    expect(readFileSync(path, 'utf8')).toBe(`${at} ours\ninherited, after the roll-over\n`);
  });

  it('keeps writing when the roll-over cannot happen, losing nothing', () => {
    const path = join(makeTmp(), SERVER_LOG_FILE);
    mkdirSync(`${path}.1`); // a directory where the copy would go
    const log = openRotatingLog({ path, maxBytes: 100, now: fixedClock() });
    for (let n = 1; n <= 5; n += 1) log.write(`line ${n}\n`);
    const kept = readFileSync(path, 'utf8');
    for (let n = 1; n <= 5; n += 1) expect(kept).toContain(`line ${n}\n`);
  });

  it('sits beside the database, with the older copy beside it', () => {
    const dbPath = join(makeTmp(), 'recued-server.db');
    expect(serverLogPath(dbPath)).toBe(join(dir!, 'recued-server.log'));
    expect(previousServerLogPath(dbPath)).toBe(join(dir!, 'recued-server.log.1'));
  });
});

describe('recognising the log file as a stream', () => {
  it('is the same file only for a handle on that very file', () => {
    const tmp = makeTmp();
    const log = join(tmp, SERVER_LOG_FILE);
    const other = join(tmp, 'mine.log');
    writeFileSync(log, '');
    writeFileSync(other, '');
    expect(isFdTheFile(appendHandle(log), log)).toBe(true);
    expect(isFdTheFile(appendHandle(other), log)).toBe(false);
    expect(isFdTheFile(appendHandle(log), join(tmp, 'absent.log'))).toBe(false);
  });
});

const fakeStream = () => {
  const written: string[] = [];
  return {
    written,
    stream: { write: (chunk: string): boolean => { written.push(chunk); return true; } },
  };
};
const notTheLog = () => false;

describe('keeping the server log', () => {
  it('takes only the stream that goes to /dev/null', () => {
    const dbPath = join(makeTmp(), 'recued-server.db');
    const out = fakeStream();
    const err = fakeStream();
    const kept = keepServerLog(dbPath, {
      streams: [
        { name: 'stdout', fd: 1, stream: out.stream as never },
        { name: 'stderr', fd: 2, stream: err.stream as never },
      ],
      isDiscarded: (fd) => fd === 2,
      isTheLog: notTheLog,
      now: fixedClock(),
    });
    expect(kept).toEqual({ path: serverLogPath(dbPath), streams: ['stderr'] });
    out.stream.write('to the terminal\n');
    err.stream.write('an error\n');
    expect(out.written).toEqual(['to the terminal\n']);
    expect(err.written).toEqual([]);
    expect(readFileSync(serverLogPath(dbPath), 'utf8')).toBe(`${at} an error\n`);
  });

  it('takes a stream that already IS the log file, as `recued start` hands it over, and caps it', () => {
    const dbPath = join(makeTmp(), 'recued-server.db');
    const handedOver = appendHandle(serverLogPath(dbPath));
    const out = fakeStream();
    const kept = keepServerLog(dbPath, {
      streams: [{ name: 'stdout', fd: handedOver, stream: out.stream as never }],
      isDiscarded: () => false,
      maxBytes: 100,
      now: fixedClock(),
    });
    expect(kept?.streams).toEqual(['stdout']);
    for (let n = 1; n <= 4; n += 1) out.stream.write(`line ${String(n).padStart(3, '0')}\n`);
    expect(out.written).toEqual([]);
    expect(readFileSync(serverLogPath(dbPath), 'utf8')).toBe(`${at} line 003\n${at} line 004\n`);
    expect(readFileSync(previousServerLogPath(dbPath), 'utf8')).toBe(`${at} line 001\n${at} line 002\n`);
  });

  it('never takes a file of the operator\'s own choosing', () => {
    const tmp = makeTmp();
    const dbPath = join(tmp, 'recued-server.db');
    const theirs = appendHandle(join(tmp, 'my-own.log'));
    const out = fakeStream();
    expect(keepServerLog(dbPath, {
      streams: [{ name: 'stdout', fd: theirs, stream: out.stream as never }],
      isDiscarded: () => false,
    })).toBeNull();
    out.stream.write('hello\n');
    expect(out.written).toEqual(['hello\n']);
    expect(existsSync(serverLogPath(dbPath))).toBe(false);
  });

  it('touches nothing when no stream is discarded or the log — not even the file', () => {
    const dbPath = join(makeTmp(), 'recued-server.db');
    const out = fakeStream();
    const kept = keepServerLog(dbPath, {
      streams: [{ name: 'stdout', fd: 1, stream: out.stream as never }],
      isDiscarded: () => false,
      isTheLog: notTheLog,
    });
    expect(kept).toBeNull();
    out.stream.write('hello\n');
    expect(out.written).toEqual(['hello\n']);
    expect(existsSync(serverLogPath(dbPath))).toBe(false);
  });

  it('leaves the stream alone when the file cannot be opened', () => {
    const blocker = join(makeTmp(), 'not-a-directory');
    writeFileSync(blocker, '');
    const out = fakeStream();
    const original = out.stream.write;
    expect(keepServerLog(join(blocker, 'recued-server.db'), {
      streams: [{ name: 'stdout', fd: 1, stream: out.stream as never }],
      isDiscarded: () => true,
      isTheLog: notTheLog,
    })).toBeNull();
    expect(out.stream.write).toBe(original);
  });

  it('calls a write callback, as console does', async () => {
    const dbPath = join(makeTmp(), 'recued-server.db');
    const out = fakeStream();
    keepServerLog(dbPath, {
      streams: [{ name: 'stdout', fd: 1, stream: out.stream as never }],
      isDiscarded: () => true,
      isTheLog: notTheLog,
    });
    const write = out.stream.write as unknown as (chunk: string, cb: () => void) => boolean;
    await new Promise<void>((done) => { write('with a callback\n', done); });
    expect(readFileSync(serverLogPath(dbPath), 'utf8')).toMatch(/with a callback\n$/);
  });
});

const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
};

// The `source` channel: on the default channel `serve` claims a host-wide update
// lease keyed on the Node runtime the whole suite shares, and concurrent boots
// exit 4. Not claiming it is enough here, because these boots stop at the
// database probe, before `serve` checks the lease; `last-start-error.test.ts`
// boots further, so it owns its install instead.
const runBin = (args: string[], stdio: StdioOptions = 'pipe') => spawnSync(
  process.execPath,
  ['--import', 'tsx', binPath, ...args],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: serverTsconfigPath,
      RECUED_DISTRIBUTION_CHANNEL: 'source',
    },
    timeout: 60_000,
  },
);

/** A realm whose database cannot be opened: `serve` fails at once, saying so. */
const brokenRealm = (): string => {
  const dbPath = join(makeTmp(), 'recued-server.db');
  writeFileSync(dbPath, 'this is not a sqlite database at all, it is garbage');
  return dbPath;
};
const FAILURE = 'cannot open the realm database';
const failureLine = (dbPath: string): string | undefined => {
  try {
    return readFileSync(serverLogPath(dbPath), 'utf8').split('\n').find((line) => line.includes(FAILURE));
  } catch {
    return undefined;
  }
};

describe('the server log — end to end through the real CLI', () => {
  it('a serve whose output goes to /dev/null, as under launchd, keeps it — and `recued logs` reads it', async () => {
    const dbPath = brokenRealm();
    const port = String(await freePort());

    const served = runBin(['serve', '--db', dbPath, '--port', port, '--require-enrolled'], 'ignore');
    expect(served.status).toBe(1);
    const failure = failureLine(dbPath);
    expect(failure, readFileSync(serverLogPath(dbPath), 'utf8')).toBeDefined();
    expect(failure).toMatch(STAMP);

    const logs = runBin(['logs', '--db', dbPath]);
    expect(logs.status, logs.stderr).toBe(0);
    expect(logs.stdout).toContain(FAILURE);
  }, 120_000);

  it('a server under `recued start`, as Windows autostart runs it, writes the log through the cap', async () => {
    // The server's lines arrive stamped only if they went through the capped
    // writer — straight down `recued start`'s handle, they would not be.
    const dbPath = brokenRealm();
    const port = String(await freePort());

    const started = runBin(['start', '--db', dbPath, '--port', port, '--require-enrolled']);
    expect(started.stdout + started.stderr).toContain(serverLogPath(dbPath));
    let failure = failureLine(dbPath);
    for (let i = 0; i < 120 && failure === undefined; i += 1) {
      await new Promise((done) => setTimeout(done, 500));
      failure = failureLine(dbPath);
    }
    expect(failure, existsSync(serverLogPath(dbPath)) ? readFileSync(serverLogPath(dbPath), 'utf8') : 'no log').toBeDefined();
    expect(failure).toMatch(STAMP);
  }, 120_000);

  it('a serve whose output goes to a pipe leaves it there and writes no file', async () => {
    const dbPath = brokenRealm();
    const port = String(await freePort());

    const served = runBin(['serve', '--db', dbPath, '--port', port, '--require-enrolled']);
    expect(served.status).toBe(1);
    expect(served.stderr).toContain(FAILURE);
    expect(existsSync(serverLogPath(dbPath))).toBe(false);
  }, 120_000);

  /** `recued logs -f` on a realm whose log holds one line. PATH is emptied, so
   *  following cannot lean on any program — Windows has no `tail`. */
  const followTheLog = () => {
    const dbPath = join(makeTmp(), 'recued-server.db');
    writeFileSync(serverLogPath(dbPath), 'already there\n');
    // ⛔ `node --import tsx`, NOT tsx's CLI wrapper. The wrapper is a second process: it
    // relays Ctrl+C to the real one and gives it 30 ms to say so over IPC, then 30 ms more,
    // then SIGKILLs it and exits 128 + 2. Under a sweep's load that budget is missed by a
    // process handling the signal correctly: 130 instead of 0 (`3aeeaa5f7`, 2026-10-09).
    // Direct, the signal reaches the process holding the handler, as with the shipped binary.
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', binPath, 'logs', '-f', '--db', dbPath],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: '', TSX_TSCONFIG_PATH: serverTsconfigPath, RECUED_DISTRIBUTION_CHANNEL: 'source' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    const exited = new Promise<number | null>((done) => { child.on('exit', (code) => { done(code); }); });
    const until = async (printed: string): Promise<void> => {
      for (let i = 0; i < 240 && !out.includes(printed); i += 1) await new Promise((done) => setTimeout(done, 250));
      expect(out, err).toContain(printed);
    };
    return { child, exited, until, log: serverLogPath(dbPath), stderr: () => err };
  };

  it('`recued logs -f` follows the log with no program to run, and Ctrl+C ends it cleanly', async () => {
    const follow = followTheLog();
    try {
      await follow.until('already there');
      appendFileSync(follow.log, 'written after it started\n');
      await follow.until('written after it started');
      follow.child.kill('SIGINT');
      expect(await follow.exited, follow.stderr()).toBe(0);
    } finally {
      follow.child.kill('SIGKILL');
    }
  }, 120_000);

  it('`recued logs -f` ends quietly when whatever reads it goes away, as `| head` does', async () => {
    const follow = followTheLog();
    try {
      await follow.until('already there');
      follow.child.stdout.destroy();
      // The next line it writes finds no reader. Keep writing until it notices.
      const writing = setInterval(() => { appendFileSync(follow.log, 'one more\n'); }, 300);
      try {
        expect(await follow.exited, follow.stderr()).toBe(0);
      } finally {
        clearInterval(writing);
      }
      expect(follow.stderr()).toBe('');
    } finally {
      follow.child.kill('SIGKILL');
    }
  }, 120_000);
});
