/** D-118 Phase 4 — default IO seam tests.
 *
 *  Exercises the real-Node helpers in `process.ts`. Scoped to the
 *  pure local-Node seams (stat, kill0, whichBinary) — exec_ok's
 *  spawnWithTimeout is covered by the per-kind kinds.test (via
 *  mocks) because spawning real binaries flakes in sandboxed CI;
 *  tcpConnect is exercised lazily through the same path.
 */
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultKill0,
  defaultStat,
  defaultWhichBinary,
} from '../process.js';

describe('defaultStat', () => {
  it('resolves true for an existing file', async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'checker-stat-'));
    const file = join(dir, 'x');
    await fsp.writeFile(file, '');
    try {
      expect(await defaultStat(file)).toBe(true);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves false for a missing path', async () => {
    expect(await defaultStat(join(tmpdir(), 'no-such-checker-file-xyz'))).toBe(false);
  });
});

describe('defaultKill0', () => {
  it('returns true for the current process pid', () => {
    expect(defaultKill0(process.pid)).toBe(true);
  });

  it('returns false for a bogus pid', () => {
    // pid 0x7fffffff is reliably absent on any real system.
    expect(defaultKill0(2_147_483_646)).toBe(false);
  });

  it('returns false for a non-integer pid (kill throws)', () => {
    // Not a typical input — the pid_file handler guards Number.isInteger
    // upstream — but the helper must be defensive in isolation.
    expect(defaultKill0(Number.NaN)).toBe(false);
  });
});

describe('defaultWhichBinary', () => {
  let stash: string | undefined;
  let dir: string;

  beforeEach(async () => {
    stash = process.env.PATH;
    dir = await fsp.mkdtemp(join(tmpdir(), 'checker-which-'));
  });

  afterEach(async () => {
    if (stash === undefined) delete process.env.PATH;
    else process.env.PATH = stash;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('resolves true when the binary is present on PATH', async () => {
    const binPath = join(dir, 'faketool');
    await fsp.writeFile(binPath, '');
    process.env.PATH = dir;
    expect(await defaultWhichBinary('faketool')).toBe(true);
  });

  it('resolves false when the binary is not on PATH', async () => {
    process.env.PATH = dir; // empty dir
    expect(await defaultWhichBinary('missingtool')).toBe(false);
  });

  it('resolves false when PATH is unset', async () => {
    delete process.env.PATH;
    expect(await defaultWhichBinary('anything')).toBe(false);
  });
});
