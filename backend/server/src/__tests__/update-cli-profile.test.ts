import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUpdateProfile } from '../cli-context/update.js';

describe('runUpdateProfile (recued update)', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recued-update-cli-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (sub?: string) =>
    runUpdateProfile({
      args: ['update', ...(sub ? [sub] : []), '--db', join(dir, 'recued.db')],
      serverVersion: '1.4.0',
      // No env override → default empty trusted key → not-configured (no fetch).
      env: { ...process.env, RECUED_DISTRIBUTION_CHANNEL: 'binary' },
    });

  it('default subcommand runs the check (pre-GA → not-configured, never throws/fetches)', async () => {
    await expect(run()).resolves.toBeUndefined();
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toMatch(/recued 1\.4\.0 \(stable channel\)/);
    expect(out).toMatch(/not available on this build yet/);
    expect(process.exitCode).toBeUndefined();
  });

  it('`update check` is the explicit form of the default', async () => {
    await run('check');
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(/not available on this build yet/);
  });

  it('`update apply` points at the server surface (does not apply from the CLI) + exit 2', async () => {
    await run('apply');
    const err = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(err).toMatch(/runs on the live server/);
    expect(err).toMatch(/Settings → Updates/);
    expect(process.exitCode).toBe(2);
  });

  it('`update rollback` is likewise server-owned', async () => {
    await run('rollback');
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(/runs on the live server/);
    expect(process.exitCode).toBe(2);
  });

  it('an unknown subcommand errors with guidance + exit 2', async () => {
    await run('frobnicate');
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(/Unknown subcommand/);
    expect(process.exitCode).toBe(2);
  });
});
