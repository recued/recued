/** `recued self-test` — the installer's post-swap probe.
 *
 *  ⛔ THE SUCCESS PATH USES THE REAL DRIVER, deliberately. The whole point of this
 *  verb is that `--version` proves the EXECUTABLE runs while the addon is a second
 *  file loaded lazily at the first database open; a probe that stubbed the open
 *  would prove exactly as little as the check it replaces. Only the FAILURE path
 *  is injected, because what is under test there is the exit-code mapping.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

  it('leaves no probe realm behind, on either path', async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('recued-self-test-'));
    await run();
    await run(() => { throw new Error('boom'); });
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('recued-self-test-'));
    // ⚠ Compared as a SET, not a count: a concurrent run of this suite would make
    // a bare count flake, and a flaky cleanup assertion gets deleted.
    expect(after.filter((n) => !before.includes(n))).toEqual([]);
  });

  it('never touches a real realm — the probe path is a fresh temp dir', async () => {
    let seen = '';
    await run((dbPath) => { seen = dbPath; });
    expect(seen).toContain('recued-self-test-');
    expect(existsSync(seen), 'the probe db must not survive the run').toBe(false);
  });
});
