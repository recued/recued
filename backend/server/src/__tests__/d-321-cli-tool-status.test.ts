/** D-321 slice 2 — `CliToolStatus`: finding a pack's tool, running its version
 *  probe, reading the version, and caching a good read.
 *
 *  Every case runs a REAL stub tool: a small `sh` script in a folder of its own,
 *  which also appends a line to `count` each time it runs, so a test can tell a
 *  cached answer from a fresh probe. POSIX only (the stubs are shell scripts). */

import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliToolStatus, isVersionManagerShim, type CliToolStatusOptions } from '../cli-tool-status.js';
import { envForOthers } from '../supervision/env-for-others.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const folder = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'recued-d321-status-')));
  dirs.push(dir);
  return dir;
};

/** Write an executable stub `name` into `dir` that counts its runs, then runs `body`. */
const stub = (dir: string, name: string, body: string, shebang = '#!/bin/sh'): string => {
  const path = join(dir, name);
  writeFileSync(path, `${shebang}\necho run >> "${dir}/count"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

const runs = (dir: string): number =>
  existsSync(join(dir, 'count')) ? readFileSync(join(dir, 'count'), 'utf8').split('\n').filter(Boolean).length : 0;

/** The system folders a stub's own commands (`sleep`, `head`) come from. */
const SYSTEM_PATH = '/usr/bin:/bin';

/** A status service whose PATH is `path` then the system folders, everything else
 *  the action environment. */
const statusOn = (path: string, over: CliToolStatusOptions = {}) =>
  createCliToolStatus({ env: () => ({ ...envForOthers(), PATH: `${path}:${SYSTEM_PATH}` }), ...over });

const OPENCODE = { from: '1.18.35', before: '2.0.0' };

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const eventually = async (check: () => boolean, ms = 3_000): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
};

describe.skipIf(process.platform === 'win32')('D-321 — CliToolStatus', () => {
  describe('the state a probe puts a tool in', () => {
    it('a version in the range is ready', async () => {
      const dir = folder();
      const path = stub(dir, 'opencode', 'echo 1.18.35');
      const report = await statusOn(dir).check({ probe: ['opencode', '--version'], tested: OPENCODE });
      expect(report).toMatchObject({
        state: 'ready',
        binary: 'opencode',
        path,
        probe_result: { kind: 'version', version: '1.18.35' },
      });
      expect(typeof report.checked_at).toBe('number');
    });

    it('the same read is untested against a range it is outside', async () => {
      const dir = folder();
      stub(dir, 'opencode', 'echo 2.0.1');
      const status = statusOn(dir);
      expect((await status.check({ probe: ['opencode', '--version'], tested: OPENCODE })).state).toBe('untested');
      expect((await status.check({ probe: ['opencode', '--version'], tested: { from: '2.0.0' } })).state).toBe('ready');
      expect(runs(dir)).toBe(1);
    });

    it('a version printed on stderr is read', async () => {
      const dir = folder();
      stub(dir, 'codex', 'echo "codex-cli 0.161.0" >&2');
      const report = await statusOn(dir).check({ probe: ['codex', '--version'], tested: { from: '0.161.0' } });
      expect(report).toMatchObject({ state: 'ready', probe_result: { kind: 'version', version: '0.161.0' } });
    });

    it('a non-zero exit is unreadable, even when a version was printed', async () => {
      const dir = folder();
      stub(dir, 'tool', 'echo 1.18.35; echo "no config" >&2; exit 1');
      const report = await statusOn(dir).check({ probe: ['tool', '--version'], tested: OPENCODE });
      expect(report).toMatchObject({ state: 'unreadable', probe_result: { kind: 'unreadable', exit_code: 1, line: 'no config' } });
    });

    it('a clean exit with no version number is unreadable', async () => {
      const dir = folder();
      stub(dir, 'tool', 'echo "tool, the friendly one"');
      const report = await statusOn(dir).check({ probe: ['tool', '--version'], tested: OPENCODE });
      expect(report).toMatchObject({
        state: 'unreadable',
        probe_result: { kind: 'unreadable', exit_code: 0, line: 'tool, the friendly one' },
      });
    });

    it('killed by a signal is broken, carrying the line it printed (the ffmpeg that does not start)', async () => {
      const dir = folder();
      stub(dir, 'ffmpeg', 'echo "dyld: Library not loaded: /opt/homebrew/opt/x265/lib/libx265.216.dylib" >&2\nkill -ABRT $$');
      const report = await statusOn(dir).check({ probe: ['ffmpeg', '-version'], tested: { from: '7.0' } });
      expect(report).toMatchObject({
        state: 'broken',
        probe_result: {
          kind: 'broken',
          cause: 'signal',
          signal: 'SIGABRT',
          line: 'dyld: Library not loaded: /opt/homebrew/opt/x265/lib/libx265.216.dylib',
        },
      });
    });

    it('a probe that does not finish is broken, and nothing it started is left running', async () => {
      const dir = folder();
      stub(dir, 'hang', `sleep 30 &\necho $! > "${dir}/bg"\nsleep 30`);
      const started = Date.now();
      const report = await statusOn(dir, { timeoutMs: 300 }).check({ probe: ['hang', '--version'], tested: OPENCODE });
      expect(report).toMatchObject({ state: 'broken', probe_result: { kind: 'broken', cause: 'timeout', timeout_ms: 300 } });
      expect(Date.now() - started).toBeLessThan(5_000);
      const bg = Number(readFileSync(join(dir, 'bg'), 'utf8').trim());
      expect(await eventually(() => !alive(bg))).toBe(true);
    });

    it('a probe that leaves a process behind is read at once, and the process is stopped', async () => {
      // The process inherits the probe's stdout, so its output stays open while
      // it lives: waiting for that read this tool as broken after the timeout.
      const dir = folder();
      stub(dir, 'leaky', `sleep 30 &\necho $! > "${dir}/bg"\necho 1.18.35`);
      const started = Date.now();
      const report = await statusOn(dir).check({ probe: ['leaky', '--version'], tested: OPENCODE });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(report.state).toBe('ready');
      const bg = Number(readFileSync(join(dir, 'bg'), 'utf8').trim());
      expect(await eventually(() => !alive(bg))).toBe(true);
    });

    // ⛔ D-321 audit — a process that left the probe's group (`setsid`, as a daemon
    // does) holds the output open, out of reach of the group kill. The answer
    // waited for it: a 10-second limit took as long as that process lived.
    // ⚠ The holder writes its pid only once it has left the group, and the tool
    // waits for that: a tool that exits first gets its group reaped while the
    // holder is still in it, and then nothing holds the output (the first version
    // of these tests passed with the fix removed, for exactly that reason).
    const detachedHolder = (dir: string): string =>
      `perl -e 'use POSIX qw(setsid); setsid(); open(my $f, ">", $ARGV[0]); print $f $$; close($f); sleep 20' "${dir}/bg" &\n`
      + `while [ ! -s "${dir}/bg" ]; do sleep 0.05; done`;
    const stopHolder = (dir: string): void => {
      try { process.kill(Number(readFileSync(join(dir, 'bg'), 'utf8').trim()), 'SIGKILL'); } catch { /* gone */ }
    };

    it('a process outside the group cannot hold the answer once the tool has exited', async () => {
      const dir = folder();
      stub(dir, 'detaching', `${detachedHolder(dir)}\necho 1.18.35`);
      try {
        const started = Date.now();
        const report = await statusOn(dir, { timeoutMs: 8_000 }).check({ probe: ['detaching', '--version'], tested: OPENCODE });
        expect(report.state).toBe('ready');
        expect(Date.now() - started).toBeLessThan(3_000);
      } finally {
        stopHolder(dir);
      }
    });

    it('nor past the limit when the tool does not exit either', async () => {
      const dir = folder();
      stub(dir, 'stuck', `${detachedHolder(dir)}\nsleep 20`);
      try {
        const started = Date.now();
        const report = await statusOn(dir, { timeoutMs: 500 }).check({ probe: ['stuck', '--version'], tested: OPENCODE });
        expect(report).toMatchObject({ state: 'broken', probe_result: { kind: 'broken', cause: 'timeout', timeout_ms: 500 } });
        expect(Date.now() - started).toBeLessThan(3_000);
      } finally {
        stopHolder(dir);
      }
    });

    it('and the limit holds for a tool that does not even die when killed', async () => {
      // A process stuck in uninterruptible I/O takes its kill only when the call
      // returns, so it neither exits nor closes its output: only the limit ends it.
      const unkillable = (() => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          pid: undefined,
          kill: () => true,
        });
        return child;
      }) as unknown as NonNullable<CliToolStatusOptions['spawn']>;
      const dir = folder();
      stub(dir, 'frozen', 'echo 1.18.35');
      const started = Date.now();
      const report = await statusOn(dir, { spawn: unkillable, timeoutMs: 200 })
        .check({ probe: ['frozen', '--version'], tested: OPENCODE });
      expect(report).toMatchObject({ state: 'broken', probe_result: { kind: 'broken', cause: 'timeout', timeout_ms: 200 } });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('a tool that cannot start is broken (its interpreter is missing)', async () => {
      const dir = folder();
      stub(dir, 'orphan', 'echo 1.18.35', '#!/nonexistent/recued-d321-interpreter');
      const report = await statusOn(dir).check({ probe: ['orphan', '--version'], tested: OPENCODE });
      expect(report).toMatchObject({ state: 'broken', probe_result: { kind: 'broken', cause: 'start' } });
    });

    it('a tool not on PATH is missing, and nothing runs', async () => {
      const dir = folder();
      const report = await statusOn(dir).check({ probe: ['opencode', '--version'], tested: OPENCODE });
      expect(report).toEqual({ state: 'missing', binary: 'opencode' });
    });

    it('stdin is closed: a probe that reads it still answers', async () => {
      const dir = folder();
      stub(dir, 'reader', 'read -r line\necho 1.18.35');
      const report = await statusOn(dir, { timeoutMs: 3_000 }).check({ probe: ['reader', '--version'], tested: OPENCODE });
      expect(report.state).toBe('ready');
    });

    it('output past the cap is drained, not kept, so the probe does not stall', async () => {
      const dir = folder();
      stub(dir, 'chatty', 'echo 1.18.35\nhead -c 2000000 /dev/zero');
      const report = await statusOn(dir, { timeoutMs: 5_000 }).check({ probe: ['chatty', '--version'], tested: OPENCODE });
      expect(report.state).toBe('ready');
    });

    it('it starts in the folder it is given; by default in a private folder of its own, removed after', async () => {
      const dir = folder();
      const elsewhere = folder();
      stub(dir, 'where', `pwd -P > "${dir}/cwd"\nls -A > "${dir}/listing"\necho 1.18.35`);
      await statusOn(dir, { cwd: elsewhere }).check({ probe: ['where', '--version'], tested: OPENCODE });
      expect(readFileSync(join(dir, 'cwd'), 'utf8').trim()).toBe(elsewhere);
      await statusOn(dir).check({ probe: ['where', '--version'], tested: OPENCODE });
      const used = readFileSync(join(dir, 'cwd'), 'utf8').trim();
      // ⛔ Never the shared temp folder itself (D-321 audit): any local user can
      // write there, and `node version` runs a file named `version` from it.
      expect(used).not.toBe(realpathSync(tmpdir()));
      expect(dirname(used)).toBe(realpathSync(tmpdir()));
      expect(basename(used)).toMatch(/^recued-probe-/u);
      expect(readFileSync(join(dir, 'listing'), 'utf8')).toBe('');
      expect(existsSync(used)).toBe(false);
    });

    it.each([
      ['an action', ['opencode', 'run', 'delete everything']],
      ['a flag that is not a version flag', ['opencode', '--help']],
      ['no flag', ['opencode']],
      ['a shell', ['sh', '-c', 'echo 1.18.35']],
      ['no binary', ['', '--version']],
    ])('a probe that asks for more than the version (%s) is never run: the version is unreadable', async (_label, probe) => {
      // A catalog an older server stored was never checked for its probe, so the
      // run-time check is the only one it meets.
      const dir = folder();
      stub(dir, 'opencode', 'echo 1.18.35');
      stub(dir, 'sh', 'echo 1.18.35');
      const report = await statusOn(dir).check({ probe, tested: OPENCODE });
      expect(report).toEqual({ state: 'unreadable', binary: probe[0], probe_result: { kind: 'not_run' } });
      expect(runs(dir)).toBe(0);
    });

    it('a path-bearing binary is run as given, with no PATH walk', async () => {
      const dir = folder();
      const path = stub(dir, 'opencode', 'echo 1.18.35');
      const report = await statusOn('/nonexistent').check({ probe: [path, '--version'], tested: OPENCODE });
      expect(report).toMatchObject({ state: 'ready', path });
    });
  });

  describe('the cache', () => {
    const probe = ['opencode', '--version'];

    it('keeps a version read: a second check does not run the probe', async () => {
      const dir = folder();
      stub(dir, 'opencode', 'echo 1.18.35');
      const status = statusOn(dir);
      const first = await status.check({ probe, tested: OPENCODE });
      const second = await status.check({ probe, tested: OPENCODE });
      expect(runs(dir)).toBe(1);
      expect(second.checked_at).toBe(first.checked_at);
    });

    it('reads again when the file changes: its mtime', async () => {
      const dir = folder();
      const path = stub(dir, 'opencode', 'echo 1.18.35');
      const status = statusOn(dir);
      await status.check({ probe, tested: OPENCODE });
      const later = new Date(statSync(path).mtimeMs + 60_000);
      utimesSync(path, later, later);
      await status.check({ probe, tested: OPENCODE });
      expect(runs(dir)).toBe(2);
    });

    it('reads again when the file is rewritten in place (an upgrade), even with its old mtime', async () => {
      // The mtime is pinned to a whole second on both sides: a restored mtime
      // loses the file system's sub-millisecond part, which would change the key
      // by itself and hide whether the size is in it (a mutation found that).
      const dir = folder();
      const path = stub(dir, 'opencode', 'echo 1.18.35');
      const SECONDS = 1_700_000_000;
      utimesSync(path, SECONDS, SECONDS);
      const status = statusOn(dir);
      expect((await status.check({ probe, tested: OPENCODE })).state).toBe('ready');
      const before = statSync(path);
      stub(dir, 'opencode', 'echo 2.0.1 # upgraded');
      utimesSync(path, SECONDS, SECONDS);
      const after = statSync(path);
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
      expect(after.size).not.toBe(before.size);
      expect((await status.check({ probe, tested: OPENCODE })).state).toBe('untested');
    });

    it('reads again when PATH changes', async () => {
      const dir = folder();
      const other = folder();
      stub(dir, 'opencode', 'echo 1.18.35');
      let PATH = `${dir}:${SYSTEM_PATH}`;
      const status = createCliToolStatus({ env: () => ({ ...envForOthers(), PATH }) });
      await status.check({ probe, tested: OPENCODE });
      PATH = `${dir}:${other}:${SYSTEM_PATH}`;
      await status.check({ probe, tested: OPENCODE });
      expect(runs(dir)).toBe(2);
    });

    it('reads again when PATH finds the tool somewhere else first', async () => {
      const a = folder();
      const b = folder();
      stub(a, 'opencode', 'echo 1.18.35');
      const inB = stub(b, 'opencode', 'echo 2.0.1');
      let PATH = `${a}:${b}:${SYSTEM_PATH}`;
      const status = createCliToolStatus({ env: () => ({ ...envForOthers(), PATH }) });
      expect((await status.check({ probe, tested: OPENCODE })).state).toBe('ready');
      PATH = `${b}:${a}:${SYSTEM_PATH}`;
      const report = await status.check({ probe, tested: OPENCODE });
      expect(report).toMatchObject({ state: 'untested', path: inB });
    });

    it('reads again after an hour (a shim keeps its file across upgrades)', async () => {
      const dir = folder();
      stub(dir, 'opencode', 'echo 1.18.35');
      let clock = 1_000_000;
      const status = statusOn(dir, { now: () => clock });
      await status.check({ probe, tested: OPENCODE });
      clock += 60 * 60 * 1000 - 1;
      await status.check({ probe, tested: OPENCODE });
      expect(runs(dir)).toBe(1);
      clock += 1;
      await status.check({ probe, tested: OPENCODE });
      expect(runs(dir)).toBe(2);
    });

    it('forgets on request ("Check again")', async () => {
      const dir = folder();
      stub(dir, 'opencode', 'echo 1.18.35');
      const status = statusOn(dir);
      await status.check({ probe, tested: OPENCODE });
      status.forget('codex');
      await status.check({ probe, tested: OPENCODE });
      expect(runs(dir)).toBe(1);
      status.forget('opencode');
      await status.check({ probe, tested: OPENCODE });
      expect(runs(dir)).toBe(2);
    });

    it('keeps no failed read: the next check probes again', async () => {
      const dir = folder();
      stub(dir, 'opencode', 'echo "config missing" >&2; exit 1');
      const status = statusOn(dir);
      await status.check({ probe, tested: OPENCODE });
      await status.check({ probe, tested: OPENCODE });
      expect(runs(dir)).toBe(2);
    });

    it('two checks at once share one probe', async () => {
      const dir = folder();
      stub(dir, 'opencode', 'sleep 0.3; echo 1.18.35');
      const status = statusOn(dir);
      const [a, b] = await Promise.all([
        status.check({ probe, tested: OPENCODE }),
        status.check({ probe, tested: { from: '2.0.0' } }),
      ]);
      expect([a.state, b.state]).toEqual(['ready', 'untested']);
      expect(runs(dir)).toBe(1);
    });

    it('keys on the probe, so another flag reads separately', async () => {
      const dir = folder();
      stub(dir, 'opencode', 'echo 1.18.35');
      const status = statusOn(dir);
      await status.check({ probe, tested: OPENCODE });
      await status.check({ probe: ['opencode', '-v'], tested: OPENCODE });
      expect(runs(dir)).toBe(2);
    });
  });

  // D-321 § 8 — a version manager's shim starts the version the folder it starts
  // in names. The stand-in reads `.tool-version` from its folder, else prints the
  // manager's global 1.18.35, and records the environment it got.
  describe('a version manager\'s shim', () => {
    const SHIM = 'if [ -f .tool-version ]; then cat .tool-version; else echo 1.18.35; fi\n'
      + 'printf %s "$OPENCODE_DISABLE_PROJECT_CONFIG" > "$(dirname "$0")/env"';
    const shimIn = (folderName: string): string => {
      const dir = join(folder(), folderName);
      mkdirSync(dir, { recursive: true });
      stub(dir, 'opencode', SHIM);
      return dir;
    };
    const repo = (version?: string): string => {
      const dir = folder();
      if (version !== undefined) writeFileSync(join(dir, '.tool-version'), `${version}\n`);
      return dir;
    };
    const actionEnv = (path: string) => ({
      ...envForOthers(), PATH: `${path}:${SYSTEM_PATH}`, OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    });
    const probe = ['opencode', '--version'];

    it('is read where the action starts, with its environment', async () => {
      const dir = shimIn('shims');
      const pinned = repo('2.0.1');
      const report = await statusOn(dir).check({
        probe, tested: OPENCODE, where: { cwd: pinned, env: actionEnv(dir) },
      });
      expect(report).toMatchObject({
        state: 'untested', probe_result: { kind: 'version', version: '2.0.1' }, folder: pinned,
      });
      // The pack's pinned settings reach the probe, as they reach the action.
      expect(readFileSync(join(dir, 'env'), 'utf8')).toBe('true');
    });

    it('is read in the private folder when no action waits (the pack page)', async () => {
      const dir = shimIn('shims');
      const report = await statusOn(dir).check({ probe, tested: OPENCODE });
      expect(report).toMatchObject({ state: 'ready', probe_result: { kind: 'version', version: '1.18.35' } });
      expect(report).not.toHaveProperty('folder');
    });

    it('is read again for every action, each in its own folder: never cached', async () => {
      const dir = shimIn('shims');
      const status = statusOn(dir);
      const pinned = repo('2.0.1');
      const plain = repo();
      const a = await status.check({ probe, tested: OPENCODE, where: { cwd: pinned, env: actionEnv(dir) } });
      const b = await status.check({ probe, tested: OPENCODE, where: { cwd: plain, env: actionEnv(dir) } });
      const c = await status.check({ probe, tested: OPENCODE, where: { cwd: pinned, env: actionEnv(dir) } });
      expect([a.state, b.state, c.state]).toEqual(['untested', 'ready', 'untested']);
      expect(runs(dir)).toBe(3);
    });

    it('is a link to Volta\'s volta-shim too', async () => {
      const dir = join(folder(), 'volta', 'bin');
      mkdirSync(dir, { recursive: true });
      stub(dir, 'volta-shim', SHIM);
      symlinkSync(join(dir, 'volta-shim'), join(dir, 'opencode'));
      const report = await statusOn(dir).check({
        probe, tested: OPENCODE, where: { cwd: repo('2.0.1'), env: actionEnv(dir) },
      });
      expect(report).toMatchObject({ state: 'untested', probe_result: { kind: 'version', version: '2.0.1' } });
    });

    it('a tool that is not a shim is read in the private folder, even for an action', async () => {
      // Its version is its file's, whatever the folder holds, and the repository
      // holds files the probe has no business near.
      const dir = shimIn('bin');
      const report = await statusOn(dir).check({
        probe, tested: OPENCODE, where: { cwd: repo('2.0.1'), env: actionEnv(dir) },
      });
      expect(report).toMatchObject({ state: 'ready', probe_result: { kind: 'version', version: '1.18.35' } });
      expect(report).not.toHaveProperty('folder');
    });

    it('a bare `version` keeps even a shim in the private folder', async () => {
      // `node version` runs a file named `version` from the folder it starts in.
      const dir = shimIn('shims');
      const report = await statusOn(dir).check({
        probe: ['opencode', 'version'], tested: OPENCODE, where: { cwd: repo('2.0.1'), env: actionEnv(dir) },
      });
      expect(report).toMatchObject({ state: 'ready', probe_result: { kind: 'version', version: '1.18.35' } });
    });

    it.each([
      ['/Users/o/.asdf/shims/opencode', 'darwin', true],
      ['/home/o/.local/share/mise/shims/codex', 'linux', true],
      ['C:\\Users\\o\\AppData\\Local\\mise\\Shims\\pi.exe', 'win32', true],
      ['/opt/homebrew/bin/opencode', 'darwin', false],
      ['/Users/o/shims-old/opencode', 'darwin', false],
    ] as const)('names %s a shim on %s: %s', (path, platform, expected) => {
      expect(isVersionManagerShim(path, platform)).toBe(expected);
    });
  });
});
