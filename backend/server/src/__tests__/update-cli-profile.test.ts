import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  const run = (sub?: string, ...extra: string[]) =>
    runUpdateProfile({
      args: ['update', ...(sub ? [sub] : []), ...extra, '--db', join(dir, 'recued.db')],
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

  // ⚠ REWRITTEN 2026-08-27. These asserted that apply/rollback were NOT CLI
  // verbs and merely pointed at the webclient. They are verbs now, for the
  // stopped server only — `update.apply` is an rpc over `/ws`, so a socket-layer
  // defect took the updater with it, and one did. What the CLI must never do is
  // half-apply, so the cases below are the two refusals that keep it honest.
  const errText = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  it('`update apply` refuses when it is not the packaged binary + exit 2', async () => {
    // ⛔⛔ THE REFUSAL THAT PROTECTS THE OWNER'S NODE. The channel resolves
    // `binary` BY DEFAULT (including here), and on that channel the apply target
    // is `process.execPath` — which under vitest, a source checkout or an npm
    // install is the NODE RUNTIME. Without this the apply would preserve their
    // `node` as `node.old` and rename a Recued SEA over it.
    await run('apply');
    expect(errText()).toMatch(/not the packaged Recued binary/);
    // `\s+` because the message wraps between the two words.
    expect(errText()).toMatch(/node\s+executable itself/);
    // Tells them how to update the install they ACTUALLY have.
    expect(errText()).toMatch(/npm i -g @recued\/server@latest/);
    expect(process.exitCode).toBe(2);
  });

  it('`update rollback` is guarded by the same check', async () => {
    // Rollback swaps `.old` back over the same target, so it is exactly as
    // dangerous and must not be reachable when apply is not.
    await run('rollback');
    expect(errText()).toMatch(/not the packaged Recued binary/);
    expect(process.exitCode).toBe(2);
  });

  it('`--apply` is accepted as an alias for the subcommand', async () => {
    // The flag form is what people reach for after reading about it; silently
    // treating it as a plain `check` would report "up to date" and do nothing.
    await run(undefined, '--apply');
    expect(errText()).toMatch(/not the packaged Recued binary/);
    expect(process.exitCode).toBe(2);
  });

  it('refuses FIRST when a live server holds the realm, naming both restart routes', async () => {
    // The instance lock, not a pidfile: a foreground `recued serve` writes no
    // pidfile, which is the common case. `process.pid` is unambiguously alive.
    writeFileSync(
      join(dir, 'recued-server.lock'),
      JSON.stringify({ pid: process.pid, boot_at: 1, bind_port: 7717 }),
    );
    await run('apply');
    const err = errText();
    expect(err).toMatch(/server is running on this realm/i);
    expect(err).toContain(String(process.pid));
    // Both ways out — the one that restarts itself, and the one they control.
    expect(err).toMatch(/Settings → Updates/);
    expect(err).toMatch(/stop the server/i);
    // Ordering matters: this must beat the packaged-binary refusal, or an owner
    // with a live server is told the wrong thing about why it declined.
    expect(err).not.toMatch(/not the packaged Recued binary/);
    expect(process.exitCode).toBe(2);
  });

  it('a STALE lock does not block — a crashed server must not wedge recovery', async () => {
    // pid 0x7FFFFFFF is not a live process. If a stale lock refused, the one
    // path out of a crash-looping install would be closed.
    writeFileSync(
      join(dir, 'recued-server.lock'),
      JSON.stringify({ pid: 0x7fffffff, boot_at: 1, bind_port: 7717 }),
    );
    await run('apply');
    expect(errText()).toMatch(/not the packaged Recued binary/);
    expect(errText()).not.toMatch(/server is running on this realm/i);
  });

  it('an unknown subcommand errors with guidance + exit 2', async () => {
    await run('frobnicate');
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(/Unknown subcommand/);
    expect(process.exitCode).toBe(2);
  });
});
