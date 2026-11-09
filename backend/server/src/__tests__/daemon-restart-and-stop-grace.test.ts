/** `recued stop` and `recued restart` against a server that a supervisor runs.
 *
 *  ⛔ `stop` SIGKILLed after 5 s while the server's own drain may take ~40. The
 *  kill lost the drain's tail (audit flush, database close, lock release), and
 *  under the start-at-login units `recued-supervise` read it as a crash and
 *  started the server again: `stop` restarted it.
 *
 *  ⛔ `restart` was stop-then-start. The supervised server stopped cleanly (so its
 *  unit did not bring it back) and a fresh one started as a plain child of the
 *  CLI: unsupervised, without the unit's environment, in `dev` mode. A server
 *  whose lock names a relaunching supervisor is now asked to restart ITSELF
 *  (SIGUSR2 → drain → its restart code → the supervisor relaunches it).
 *
 *  ⚠ REAL PROCESSES AND SIGNALS; `start`/`stop` are injected only where the old
 *  path would spawn a real server. Windows has no SIGUSR2, so the signal arms
 *  are skipped there. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { daemonRestart, daemonStop } from '../daemon.js';
import { processStartIdentity } from '../lifecycle/process-identity.js';

const unsupported = process.platform !== 'darwin' && process.platform !== 'linux';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

const spawnNode = (source: string): number => {
  const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
};

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** A realm whose lock names `pid`, as the server holding it writes it. */
const realmHeldBy = (dir: string, pid: number, supervisor?: string): string => {
  writeFileSync(join(dir, 'recued-server.lock'), JSON.stringify({
    pid, boot_at: Date.now(), bind_port: 7717, proc_start: processStartIdentity(pid),
    ...(supervisor !== undefined ? { supervisor } : {}),
  }));
  return join(dir, 'r.db');
};

const captured = async (run: () => Promise<void>): Promise<string> => {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.join(' ')); });
  try { await run(); } finally { log.mockRestore(); err.mockRestore(); }
  return lines.join('\n');
};

/** Starts that would spawn a real server are recorded instead. */
const fakeRun = () => {
  const calls: string[] = [];
  return {
    calls,
    run: {
      stop: async () => { calls.push('stop'); },
      start: async () => { calls.push('start'); },
      waitMs: 1_500,
    },
  };
};

describe.skipIf(unsupported)('`recued stop` waits out the drain', () => {
  it('⛔ a server that takes 6 s to drain is let finish, not SIGKILLed at 5 s', async () => {
    // Exits on its own 6 s after SIGTERM — a drain longer than the old 5 s.
    const pid = spawnNode("process.on('SIGTERM', () => setTimeout(() => process.exit(0), 6000)); setInterval(() => {}, 1000);");
    await new Promise((r) => setTimeout(r, 300));          // let it install its handler
    const dir = mkdtempSync(join(tmpdir(), 'recued-stop-grace-'));
    const out = await captured(() => daemonStop({ dbPath: realmHeldBy(dir, pid) }, 'linux'));
    expect(out).toMatch(/Waiting for the server/);
    expect(out).toMatch(/Server stopped/);
    expect(out).not.toMatch(/SIGKILL/);
    expect(alive(pid)).toBe(false);
  }, 20_000);
});

describe.skipIf(unsupported)('`recued restart` under a supervisor', () => {
  const opts = (dbPath: string) => ({ dbPath, port: 7717 });

  it('⛔ asks a supervised server to restart itself, and starts nothing of its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-restart-'));
    const marker = join(dir, 'got-sigusr2');
    const pid = spawnNode(`process.on('SIGUSR2', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); }); setInterval(() => {}, 1000);`);
    await new Promise((r) => setTimeout(r, 300));
    const { calls, run } = fakeRun();
    const out = await captured(() => daemonRestart(opts(realmHeldBy(dir, pid, 'launchd')), process.platform, run));
    expect(existsSync(marker)).toBe(true);
    expect(calls).toEqual([]);
    expect(out).toMatch(/restart under its launchd supervisor/);
  }, 20_000);

  it('reports the server its supervisor brought back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-restart-back-'));
    const marker = join(dir, 'got-sigusr2');
    const first = spawnNode(`process.on('SIGUSR2', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); }); setInterval(() => {}, 1000);`);
    await new Promise((r) => setTimeout(r, 300));
    const dbPath = realmHeldBy(dir, first, 'systemd');
    const { run } = fakeRun();
    const restarting = captured(() => daemonRestart(opts(dbPath), process.platform, { ...run, waitMs: 10_000 }));
    // The supervisor relaunches: a new server claims the realm.
    for (let i = 0; i < 100 && !existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 50));
    const second = spawnNode('setInterval(() => {}, 1000);');
    await new Promise((r) => setTimeout(r, 200));
    realmHeldBy(dir, second, 'systemd');
    expect(await restarting).toMatch(new RegExp(`Server restarted \\(pid ${first} → ${second}`));
  }, 20_000);

  it('a server no supervisor relaunches is stopped and started, as before — not signalled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-restart-dev-'));
    const pid = spawnNode('setInterval(() => {}, 1000);');   // SIGUSR2 would kill it
    await new Promise((r) => setTimeout(r, 300));
    const { calls, run } = fakeRun();
    await captured(() => daemonRestart(opts(realmHeldBy(dir, pid, 'dev')), process.platform, run));
    expect(calls).toEqual(['stop', 'start']);
    expect(alive(pid)).toBe(true);
  });

  it('a lock that names no supervisor (an older server) is stopped and started, not signalled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-restart-old-'));
    const pid = spawnNode('setInterval(() => {}, 1000);');
    await new Promise((r) => setTimeout(r, 300));
    const { calls, run } = fakeRun();
    await captured(() => daemonRestart(opts(realmHeldBy(dir, pid)), process.platform, run));
    expect(calls).toEqual(['stop', 'start']);
    expect(alive(pid)).toBe(true);
  });

  it('Windows has no SIGUSR2: stop and start, whatever the lock says', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-restart-win-'));
    const pid = spawnNode('setInterval(() => {}, 1000);');
    await new Promise((r) => setTimeout(r, 300));
    const { calls, run } = fakeRun();
    await captured(() => daemonRestart(opts(realmHeldBy(dir, pid, 'launchd')), 'win32', run));
    expect(calls).toEqual(['stop', 'start']);
    expect(alive(pid)).toBe(true);
  });
});

describe('the serving path records its supervisor in the lock', () => {
  // `recued restart` reads the supervisor from the lock the server claims; a
  // claim that leaves it out makes every server look unsupervised, and restart
  // is stop-then-start again.
  it('passes the lifecycle supervisor mode to the claim', () => {
    const source = readFileSync(join(import.meta.dirname, '../serve/compose-lifecycle.ts'), 'utf8');
    expect(source).toMatch(/lock\.claim\(\{[^}]*supervisor: lifecycle\.supervisor\.mode/s);
  });
});
