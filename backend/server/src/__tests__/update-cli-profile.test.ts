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
      env: {
        ...process.env,
        RECUED_DISTRIBUTION_CHANNEL: 'binary',
        // ⛔ MUST stay pointed at a dead local port. Before the release key was
        // pinned (2026-07-31) the empty key short-circuited every check, so this
        // profile could not reach the network no matter what. With a real key
        // pinned the check RUNS — and without this override these cases would
        // make live HTTPS calls to releases.recued.com on every suite run.
        RECUED_RELEASE_MANIFEST_URL: 'http://127.0.0.1:1/manifest.json',
      },
    });

  it('default subcommand runs the check and reports the failure honestly, never throwing', async () => {
    // ⚠ REWRITTEN 2026-07-31 with the key pin. This asserted
    // `not available on this build yet` — the pre-GA `not-configured`
    // short-circuit, which a pinned build no longer takes.
    //
    // The INTENT is unchanged and is the whole point of the profile: the check
    // runs on EVERY install, prints the version/channel head, and reports what
    // happened instead of throwing. An unreachable feed is the cleanest way to
    // prove the reporting path offline.
    await expect(run()).resolves.toBeUndefined();
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toMatch(/recued 1\.4\.0 \(stable channel\)/);
    expect(out).toMatch(/could not reach the release feed/);
    expect(process.exitCode).toBeUndefined();
  });

  it('`update check` is the explicit form of the default', async () => {
    await run('check');
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(
      /could not reach the release feed/,
    );
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
