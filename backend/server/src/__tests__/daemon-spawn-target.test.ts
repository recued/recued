import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { buildDaemonSpawn, ensureSupervisorCopy } from '../daemon.js';

/** `recued start` in a published binary spawned `npx tsx <cwd>/bin.ts`, died on
 *  ERR_MODULE_NOT_FOUND, and left `recued status` reporting "stopped" —
 *  accurately, which is what made it read as a status bug. The daemon had one
 *  launch path and it was the source-checkout one.
 *
 *  ⚠ These assertions are NOT a substitute for the build's daemon smoke. A unit
 *  test runs from source, where `npx`, `tsx` and `bin.ts` all exist, so it can
 *  never prove the packaged path WORKS — only that we still ask the question.
 *  The proof that it works lives in `build-binary-macos.mjs`, against the
 *  artifact. What this pins is the rule someone could quietly delete by
 *  collapsing the branch again. */
describe('the daemon launches the right thing for the runtime it is', () => {
  const opts = { dbPath: '/srv/realm/recued-server.db', port: 7717 };

  it('re-executes ITSELF when packaged — never a toolchain off the PATH', () => {
    const spawn = buildDaemonSpawn(opts, true);

    expect(spawn.cmd).toBe(process.execPath);
    // The three things that cannot appear: they are all source-checkout
    // artifacts, and a machine that installed the binary has none of them.
    const flat = [spawn.cmd, ...spawn.args].join(' ');
    expect(flat).not.toContain('npx');
    expect(flat).not.toContain('tsx');
    expect(flat).not.toContain('bin.ts');
    // No subcommand: the bare binary IS foreground serve.
    expect(spawn.args[0]).toBe('--port');
    expect(spawn.args).toEqual(['--port', '7717', '--db', opts.dbPath]);
  });

  it('lands the packaged child in the realm directory, not wherever it was invoked', () => {
    // The db default is CWD-relative, so an inherited CWD can silently point a
    // restart at a different database.
    expect(buildDaemonSpawn(opts, true).cwd).toBe(dirname(resolve(opts.dbPath)));
  });

  it('still runs bin.ts through tsx from a source checkout', () => {
    const spawn = buildDaemonSpawn(opts, false);
    expect(spawn.args[0]).toBe('tsx');
    expect(spawn.args[1]).toMatch(/bin\.ts$/);
    expect(spawn.args.slice(2)).toEqual(['--port', '7717', '--db', opts.dbPath]);
  });

  it('forwards extra args in both runtimes', () => {
    for (const packaged of [true, false]) {
      const spawn = buildDaemonSpawn({ ...opts, extraArgs: ['--require-enrolled'] }, packaged);
      expect(spawn.args.at(-1)).toBe('--require-enrolled');
    }
  });

  it('on Windows starts the supervisor from its own copy, which runs the server with the same arguments', () => {
    // Nothing else starts a Windows server again after a restart, and the
    // supervisor must not run from `recued.exe` (`launcher/outer-supervisor.ts`).
    // The binary that ran `start` is named exactly: the build's smoke runs one
    // called `recued-windows-arm64.exe`, and a derived `recued.exe` beside it
    // was a file that did not exist (the supervisor halted at once).
    const exe = '/opt/recued/recued-windows-arm64.exe';
    const spawn = buildDaemonSpawn({ ...opts, extraArgs: ['--require-enrolled'] }, true, 'win32', exe);
    expect(spawn.cmd).toBe('/opt/recued/recued-supervise.exe');
    expect(spawn.args).toEqual([
      'supervise', '--payload', exe, '--',
      '--port', '7717', '--db', opts.dbPath, '--require-enrolled',
    ]);
    expect(spawn.cwd).toBe(dirname(resolve(opts.dbPath)));
  });

  it('elsewhere the packaged binary still runs the server itself', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(buildDaemonSpawn(opts, true, platform, '/opt/recued/recued').cmd).toBe('/opt/recued/recued');
    }
  });
});

describe('the copy the Windows supervisor runs from', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const binDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-supervisor-copy-'));
    dirs.push(dir);
    return dir;
  };

  it('is made from the running binary when there is none', () => {
    const dir = binDir();
    const exe = join(dir, 'recued.exe');
    writeFileSync(exe, 'BINARY-A');
    const copy = ensureSupervisorCopy(exe);
    expect(copy).toBe(join(dir, 'recued-supervise.exe'));
    expect(readFileSync(copy, 'utf8')).toBe('BINARY-A');
    expect(existsSync(`${copy}.staged`)).toBe(false);
  });

  it('is kept while it is this binary, and remade once an update has replaced it', () => {
    const dir = binDir();
    const exe = join(dir, 'recued.exe');
    writeFileSync(exe, 'BINARY-A');
    const copy = ensureSupervisorCopy(exe);
    // A remade copy is renamed into place, so it is a new file.
    const made = statSync(copy).ino;
    ensureSupervisorCopy(exe);
    expect(statSync(copy).ino).toBe(made);
    // An update renames a new file into place: its size and time are its own.
    writeFileSync(`${exe}.staged`, 'BINARY-B, LONGER');
    renameSync(`${exe}.staged`, exe);
    ensureSupervisorCopy(exe);
    expect(readFileSync(copy, 'utf8')).toBe('BINARY-B, LONGER');
  });

  it('notices a new binary of the same size by its modification time', () => {
    const dir = binDir();
    const exe = join(dir, 'recued.exe');
    writeFileSync(exe, 'BINARY-A');
    const copy = ensureSupervisorCopy(exe);
    writeFileSync(exe, 'BINARY-B');
    utimesSync(exe, new Date(2030, 0, 1), new Date(2030, 0, 1));
    ensureSupervisorCopy(exe);
    expect(readFileSync(copy, 'utf8')).toBe('BINARY-B');
  });
});
