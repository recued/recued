/** `recued self-test` — the installer's post-swap probe.
 *
 *  ⛔ THE SUCCESS PATH USES THE REAL DRIVER, deliberately. The whole point of this
 *  verb is that `--version` proves the EXECUTABLE runs while the addon is a second
 *  file loaded lazily at the first database open; a probe that stubbed the open
 *  would prove exactly as little as the check it replaces. Only the FAILURE path
 *  is injected, because what is under test there is the exit-code mapping.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BootTrace } from '../cli/boot-trace.js';
import { probeDatabaseRoundTrip, runSelfTestProfile } from '../cli-context/self-test.js';

const marks: Array<[string, string | undefined]> = [];
const trace = {
  mark: (name: string, detail?: string) => { marks.push([name, detail]); },
  markImport: () => {},
  markDbOpenAttempted: () => {},
} as unknown as BootTrace;

const run = async (probe?: (dbPath: string) => Promise<void> | void) => {
  let code = -1;
  const lines: string[] = [];
  await runSelfTestProfile({
    args: ['self-test'],
    bootTrace: trace,
    exit: (c) => { code = c; },
    log: (m) => lines.push(m),
    ...(probe === undefined ? {} : { probe }),
  });
  return { code, out: lines.join('\n') };
};

describe('probeDatabaseRoundTrip', () => {
  // ⛔⛔ THE REAL DRIVER, AND A FILE ON DISK TO PROVE IT RAN. Asserting only that
  // the profile exits 0 was VACUOUS: a probe that did nothing at all exits 0 too,
  // and a mutation removing the call stayed green until this arm existed.
  it('loads the addon, opens a database and round-trips a row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-probe-'));
    const dbPath = join(dir, 'probe.db');
    try {
      await probeDatabaseRoundTrip(dbPath);
      expect(existsSync(dbPath), 'no database file — the driver never ran').toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ⚠ A ROUND TRIP, NOT JUST AN OPEN: an ABI mismatch can survive `require` and
  // fail at first USE, which is the shape this repo has hit before.
  it('prepares, writes and reads back rather than trusting a constructor', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'cli-context', 'self-test.ts'),
      'utf-8',
    );
    expect(src).toMatch(/db\.prepare\(/);
    expect(src).toMatch(/INSERT INTO probe/);
    expect(src).toMatch(/SELECT v FROM probe/);
  });
});

describe('runSelfTestProfile', () => {
  it('opens a real database with the installed addon and exits 0', async () => {
    const { code, out } = await run();
    expect(code, `self-test failed on this build: ${out}`).toBe(0);
  });

  // ⛔ AND IT ACTUALLY CALLS ITS PROBE. The exit code cannot show this — a profile
  // that skipped the probe entirely would also exit 0 — so the wiring is pinned
  // where the behaviour cannot reach it.
  it('defaults to the real probe and runs it unconditionally', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'cli-context', 'self-test.ts'),
      'utf-8',
    );
    expect(src).toMatch(/const probe = options\.probe \?\? probeDatabaseRoundTrip;/);
    expect(src).toMatch(/await probe\(join\(dir, 'probe\.db'\)\);/);
  });

  // ⛔⛔ THE CASE THE OLD SMOKE PASSED. A signed but mispackaged or ABI-wrong addon
  // lets `--version` succeed and dies at the first database open — after the
  // installer had already cleared its unwind window and dropped the previous pair.
  it('exits non-zero when the database cannot be opened', async () => {
    const { code, out } = await run(() => {
      throw new Error('dlopen failed: wrong ELF class');
    });
    expect(code).toBe(1);
    expect(out).toMatch(/cannot open a database/);
    // The diagnosis has to name the likely cause, or an owner reads it as "the
    // download is corrupt" and re-runs the same install forever.
    expect(out).toMatch(/native addon|better_sqlite3/);
  });

  // ⛔⛔ `process.exit` ENDS THE PROCESS WHERE IT STANDS, and a `finally` still
  // pending never runs. The profile used to exit inside its `try`, so every REAL
  // run left `recued-self-test-*/probe.db` behind (eight on one machine, one per
  // install), while this file stayed green: its `exit` RETURNED, the `finally`
  // ran, and the folder was gone before anything looked. So this stub records the
  // folder at the moment of the call, which is all `process.exit` leaves. The
  // success path still runs the real driver; the probe is wrapped only to learn
  // the folder.
  it('removes its probe folder BEFORE it exits, on either path', async () => {
    for (const path of ['success', 'failure'] as const) {
      let folder = '';
      let presentAtExit: boolean | undefined;
      await runSelfTestProfile({
        args: ['self-test'],
        bootTrace: trace,
        exit: () => { presentAtExit = existsSync(folder); },
        log: () => {},
        probe: async (dbPath) => {
          folder = dirname(dbPath);
          if (path === 'failure') throw new Error('boom');
          await probeDatabaseRoundTrip(dbPath);
        },
      });
      expect(folder, path).toContain('recued-self-test-');
      expect(presentAtExit, `the ${path} path exited with its probe folder on disk`).toBe(false);
    }
  });

  // ⛔ AND THE REAL `process.exit`, THROUGH THE REAL ENTRY POINT. `bin.ts` passes
  // no `exit`, so production gets the one thing every stub above replaces. The
  // child gets a temp dir of its own, so nothing else on the machine can make
  // this pass or fail.
  it('leaves nothing in the temp dir when run as `recued self-test`', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'recued-selftest-tmpdir-'));
    try {
      const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
      const r = spawnSync(
        'npx',
        ['--no-install', 'tsx', join(repoRoot, 'backend/server/src/bin.ts'), 'self-test'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            TSX_TSCONFIG_PATH: join(repoRoot, 'backend/server/tsconfig.json'),
            TMPDIR: tmp,
            TEMP: tmp,
            TMP: tmp,
          },
          timeout: 30_000,
        },
      );
      expect(r.status, `recued self-test failed: ${r.stderr}`).toBe(0);
      expect(readdirSync(tmp).filter((n) => n.startsWith('recued-self-test-'))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 45_000);

  it('never touches a real realm — the probe path is a fresh temp dir', async () => {
    let seen = '';
    await run((dbPath) => { seen = dbPath; });
    expect(seen).toContain('recued-self-test-');
    expect(existsSync(seen), 'the probe db must not survive the run').toBe(false);
  });
});
