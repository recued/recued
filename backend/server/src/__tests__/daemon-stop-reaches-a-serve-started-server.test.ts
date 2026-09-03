/** ⛔⛔⛔ THREE CORRECT REFUSALS COMPOSED INTO A LIVELOCK.
 *
 *  Reported from an owner trying to upgrade, 2026-09-03. Every route refused and
 *  pointed at a route that also refused:
 *
 *    curl | sh            → won't upgrade a healthy install; use apply, or the webclient
 *    recued stop          → no pidfile; `serve` never writes one
 *    recued update apply  → a server holds this realm (pid 4952, port 7717)
 *
 *  ⛔ AND `recued serve` IS THE DEFAULT SHAPE, not an exotic one: it is what the
 *  boot banner prints and what BOTH generated autostart units exec. So the
 *  configuration the product ships by default was the one with no way out. An
 *  owner with no paired webclient could not upgrade at all.
 *
 *  🔑 THE ANSWER WAS ALREADY ON DISK. The instance lock beside the database
 *  records the holder's pid AND bind_port — it is exactly what lets `update
 *  apply` name them in its refusal. `stop` read a pidfile instead and announced
 *  it could not know. One subsystem held the identity of the holder while the
 *  other said it was unknowable, which is why the sibling of this file
 *  (`daemon-status-names-its-cause`) could make the DIAGNOSIS honest in 26.8.31
 *  and still leave the owner stuck: honesty about a dead end is still a dead end.
 *
 *  ⚠ REAL PROCESSES, REAL SIGNALS. The defect was that the reported state and
 *  the actual process state disagreed, so an arm that stubs the signal proves
 *  nothing. Each arm spawns a child, records it in a real lock file, and asserts
 *  the child actually died.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { daemonStop } from '../daemon.js';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

/** A child that sits until signalled — a stand-in for `recued serve`, which is
 *  the case with no pidfile. */
const sleeper = (): ChildProcess => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
};

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const settle = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 40; i += 1) {
    if (!alive(pid)) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return alive(pid);
};

/** A realm whose instance lock names `pid` — i.e. what a `serve` leaves behind
 *  and a `start` does not. `writeLock: false` gives the empty-realm arm. */
const realm = (opts: { pid?: number } = {}): string => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'recued-stop-')), 'r.db');
  if (opts.pid !== undefined) {
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(
      join(dirname(dbPath), 'recued-server.lock'),
      JSON.stringify({ pid: opts.pid, boot_at: Date.now(), bind_port: 7717 }),
    );
  }
  return dbPath;
};

const runStop = async (dbPath: string): Promise<string> => {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.join(' ')); });
  try {
    await daemonStop({ dbPath });
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
  return lines.join('\n');
};

describe('`recued stop` reaches a server that wrote no pidfile', () => {
  it('⛔ THE LIVELOCK ARM — stops a `serve`-shaped holder named only by the instance lock', async () => {
    const child = sleeper();
    const out = await runStop(realm({ pid: child.pid! }));

    // The thing that was impossible before: the process is actually gone.
    expect(await settle(child.pid!)).toBe(false);
    expect(out).toMatch(/Server stopped/);
    // ⚠ It names the holder it found, so the owner can tell it stopped THEIR
    // server and not some other realm's.
    expect(out).toContain(String(child.pid));
    expect(out).toContain('7717');
  });

  it('says plainly that nothing holds the realm, rather than that it cannot know', async () => {
    const out = await runStop(realm());

    expect(out).toMatch(/nothing holds this realm/i);
    // ⛔ AND IT MUST NOT REGRESS TO THE OLD CLAIM. "server is not running" is
    // what 26.8.31 removed for being unknowable; the replacement must not
    // reintroduce it by another wording.
    expect(out).not.toMatch(/server is not running/i);
  });

  it('does not report a stop it did not perform when the recorded holder is already gone', async () => {
    const child = sleeper();
    const pid = child.pid!;
    child.kill('SIGKILL');
    await settle(pid);

    const out = await runStop(realm({ pid }));
    expect(out).not.toMatch(/Server stopped/);
    expect(out).toMatch(/nothing holds this realm|exited before/i);
  });

  it('leaves an unrelated process alone — the lock scopes the signal to ONE realm', async () => {
    const bystander = sleeper();
    const holder = sleeper();
    await runStop(realm({ pid: holder.pid! }));

    expect(await settle(holder.pid!)).toBe(false);
    expect(alive(bystander.pid!)).toBe(true);
  });
});
