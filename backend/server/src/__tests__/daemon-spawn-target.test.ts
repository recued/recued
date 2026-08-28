import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';

import { buildDaemonSpawn } from '../daemon.js';

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
});
