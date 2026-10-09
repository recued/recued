/** `recued logs` — the last lines across a rollover, following without
 *  `tail`, and the journal on a systemd machine instead of a bare "No log file".
 *
 *  Printing is driven with an in-memory file system; following, with real
 *  files and looks the test makes, so a roll-over can land exactly between
 *  two of them. The end-to-end runs of the real CLI are in `server-log.test.ts`. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRotatingLog } from '../cli/server-log.js';
import { cmdLogs, followLog, journalCommandFor } from '../commands/logs.js';

const DB = '/realm/recued-server.db';
const LOG = '/realm/recued-server.log';
const OLDER = '/realm/recued-server.log.1';

const run = async (opts: {
  files?: Record<string, string>;
  platform?: NodeJS.Platform;
  follow?: boolean;
}) => {
  const files = opts.files ?? {};
  const printed: string[] = [];
  const read: string[] = [];
  const followed: string[][] = [];
  await cmdLogs({
    dbPath: DB,
    follow: opts.follow ?? false,
    platform: opts.platform ?? 'darwin',
    homedir: () => '/home/owner',
    exists: (path) => path in files,
    readFile: (path) => { read.push(path); return files[path]!; },
    print: (line) => { printed.push(line); },
    followFile: (path, olderPath) => { followed.push([path, olderPath]); },
  });
  return { printed, read, followed };
};

const numbered = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join('\n') + '\n';

describe('recued logs', () => {
  it('prints the last 50 lines, reaching into the older copy when the current file is short', async () => {
    const { printed } = await run({ files: { [LOG]: numbered(61, 63), [OLDER]: numbered(1, 60) } });
    const lines = printed.join('\n').split('\n');
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe('line 14');
    expect(lines.at(-1)).toBe('line 63');
  });

  it('does not read the older copy when the current file has 50 lines', async () => {
    const { printed, read } = await run({ files: { [LOG]: numbered(1, 80), [OLDER]: numbered(1, 9) } });
    expect(read).toEqual([LOG]);
    expect(printed.join('\n').split('\n')[0]).toBe('line 31');
  });

  it('keeps a last line that has no newline yet', async () => {
    const { printed } = await run({ files: { [LOG]: 'one\ntwo\nthree, still being written' } });
    expect(printed).toEqual(['one\ntwo\nthree, still being written']);
  });

  it('says where the log would be, and nothing more, on a Mac with none yet', async () => {
    const { printed } = await run({ files: {} });
    expect(printed).toEqual([`No log file at ${LOG}`]);
  });

  it('on a systemd machine, gives the journal command for its unit', async () => {
    const system = await run({ platform: 'linux', files: { '/etc/systemd/system/recued.service': '' } });
    expect(system.printed).toEqual([
      `No log file at ${LOG}`,
      'This server runs under systemd, which keeps its output in the journal:',
      '  journalctl -u recued -n 50',
      'Add -f to follow it.',
    ]);
    const user = await run({
      platform: 'linux',
      files: { '/home/owner/.config/systemd/user/recued.service': '', [LOG]: 'from a recued start\n' },
    });
    expect(user.printed).toEqual([
      'from a recued start',
      'This server runs under systemd, which keeps its output in the journal:',
      '  journalctl --user -u recued -n 50',
      'Add -f to follow it.',
    ]);
  });

  it('names no journal on a Linux machine without the unit, or on a Mac', () => {
    expect(journalCommandFor({ platform: 'linux', homedir: () => '/h', exists: () => false })).toBeNull();
    expect(journalCommandFor({ platform: 'darwin', homedir: () => '/h', exists: () => true })).toBeNull();
  });

  it('follows the log file, with its older copy, and only one that exists', async () => {
    expect((await run({ follow: true, files: { [LOG]: 'x\n' } })).followed).toEqual([[LOG, OLDER]]);
    const none = await run({ follow: true, files: {} });
    expect(none.followed).toEqual([]);
    expect(none.printed).toEqual([`No log file at ${LOG}`]);
  });
});

describe('following the log', () => {
  let dir = '';
  let path = '';
  let older = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recued-logs-follow-'));
    path = join(dir, 'recued-server.log');
    older = `${path}.1`;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A follow whose looks the test makes, collecting what it prints. */
  const follow = () => {
    let look = (): void => {};
    let stopped = false;
    const out: Buffer[] = [];
    const handle = followLog(path, older, {
      write: (chunk) => { out.push(chunk); },
      schedule: (fn) => { look = fn; return () => { stopped = true; }; },
    });
    return {
      look: () => { look(); },
      printed: () => Buffer.concat(out).toString('utf8'),
      stop: () => { handle.stop(); return stopped; },
    };
  };

  const AT = '2026-10-08T12:00:00.000Z';
  /** The log's writer, with a fixed clock: each `line N` takes 32 bytes. */
  const writer = (maxBytes: number) => openRotatingLog({ path, maxBytes, now: () => new Date(AT) });
  const stamped = (...ns: number[]): string => ns.map((n) => `${AT} line ${n}\n`).join('');

  it('prints the last 50 lines, then each line as it is written, and nothing when nothing is', () => {
    writeFileSync(older, numbered(1, 60));
    writeFileSync(path, numbered(61, 63));
    const f = follow();
    expect(f.printed()).toBe(numbered(14, 63));
    appendFileSync(path, 'line 64\nline 65\n');
    f.look();
    expect(f.printed()).toBe(numbered(14, 65));
    f.look();
    expect(f.printed()).toBe(numbered(14, 65));
    expect(f.stop()).toBe(true);
  });

  it('lets a line still being written carry on, rather than breaking it', () => {
    writeFileSync(path, 'one\ntwo, half');
    const f = follow();
    expect(f.printed()).toBe('one\ntwo, half');
    appendFileSync(path, ' and the rest\n');
    f.look();
    expect(f.printed()).toBe('one\ntwo, half and the rest\n');
  });

  it('starts from an empty log and prints its first lines when they come', () => {
    writeFileSync(path, '');
    const f = follow();
    expect(f.printed()).toBe('');
    appendFileSync(path, 'first\n');
    f.look();
    expect(f.printed()).toBe('first\n');
  });

  it('shows the lines written just before a roll-over, from the older copy', () => {
    // Line 4 rolls the file over, so lines 2 and 3 are only in .1 by the next
    // look — and the emptied file has grown back to the size already read, so
    // its size alone would not show that it started over.
    const log = writer(100);
    const f = follow();
    log.write('line 1\n');
    f.look();
    log.write('line 2\n');
    log.write('line 3\n');
    log.write('line 4\n');
    expect(readFileSync(older, 'utf8')).toBe(stamped(1, 2, 3));
    expect(readFileSync(path, 'utf8')).toBe(stamped(4));
    f.look();
    expect(f.printed()).toBe(stamped(1, 2, 3, 4));
  });

  it('shows every line once, in order, across many roll-overs', () => {
    const log = writer(300);
    const f = follow();
    let n = 0;
    let copies = 0;
    let lastCopy = '';
    // Bursts of one to four lines between looks, so a roll-over lands at every
    // point in a burst, but never twice in one.
    for (const burst of [1, 3, 4, 2, 4, 1, 4, 3, 2, 4, 4, 1, 3, 4, 2, 4, 3, 1, 4, 2]) {
      for (let i = 0; i < burst; i += 1) log.write(`line ${++n}\n`);
      f.look();
      const copy = existsSync(older) ? readFileSync(older, 'utf8') : '';
      if (copy !== lastCopy) copies += 1;
      lastCopy = copy;
    }
    expect(copies).toBeGreaterThanOrEqual(5);
    expect(f.printed()).toBe(stamped(...Array.from({ length: n }, (_, i) => i + 1)));
  });

  it('after two roll-overs between looks, skips the lines in between but never shows part of one', () => {
    const log = writer(100);
    const f = follow();
    log.write('line 1\n');
    f.look();
    // Lines 4 and 7 each roll the file over: .1 now holds 4–6, and 2–3 are gone.
    for (let i = 2; i <= 9; i += 1) log.write(`line ${i}\n`);
    expect(readFileSync(older, 'utf8')).toBe(stamped(4, 5, 6));
    f.look();
    expect(f.printed()).toBe(stamped(1, 7, 8, 9));
  });

  it('waits while the file is gone, and reads a new one from its top', () => {
    writeFileSync(path, 'old 1\nold 2\n');
    const f = follow();
    rmSync(path);
    f.look();
    writeFileSync(path, 'new and longer than the old file was\n');
    f.look();
    expect(f.printed()).toBe('old 1\nold 2\nnew and longer than the old file was\n');
  });
});
