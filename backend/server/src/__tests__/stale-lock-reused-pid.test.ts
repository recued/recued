/** ⛔⛔ A LOCK OR A PIDFILE NAMES A PID, AND A PID IS REUSED.
 *
 *  Reproduced on 26.11.3 with the published binary (2026-11-06): a realm lock
 *  naming a live, unrelated `sleep` on the same port.
 *    - `recued serve` exited 4 ("another recued is already running"), which
 *      every supervisor reads as "halt". A server whose lock outlived an
 *      unclean shutdown stayed down whenever its old number had been handed on.
 *    - `recued status` called the `sleep` the running server.
 *    - `recued stop` SIGTERMed it.
 *
 *  The lock and the pidfile now carry when their process started
 *  (`processStartIdentity`). A live PID that started at another time is not
 *  the holder.
 *
 *  ⚠ REAL PROCESSES, REAL SIGNALS, as in
 *  `daemon-stop-reaches-a-serve-started-server`. The decoy is a child of this
 *  test, and the lock says another process wrote it, which is exactly what a
 *  reused number looks like. Windows reports no start identity yet, so these
 *  arms are skipped there and the PID alone decides. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { daemonStatus, daemonStop } from '../daemon.js';
import { createInstanceLock, LockHeldError, liveServerHolding } from '../lifecycle/instance-lock.js';
import { pidWasReused, processStartIdentity } from '../lifecycle/process-identity.js';
import { acquireUpdateLease, inspectUpdateLease, UpdateLeaseHeldError } from '../update/update-lease.js';
import { mcpLeaseHolder } from '../update/mcp-step-aside.js';

const unsupported = process.platform !== 'darwin' && process.platform !== 'linux';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

/** An unrelated live process of this user, for a reused PID to land on. */
const decoy = (): number => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
};

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** `false` once the process has gone; polls for up to two seconds. */
const stillAliveAfter = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 40; i += 1) {
    if (!alive(pid)) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return alive(pid);
};

/** A stop SIGTERMs at once, and the decoy dies on it: 300 ms is plenty. */
const survives = async (pid: number): Promise<boolean> => {
  await new Promise((r) => setTimeout(r, 300));
  return alive(pid);
};

/** What the writer that has since died recorded: a real start identity, of
 *  another process than the one now holding its number. */
const anotherProcessStart = (): string => processStartIdentity(process.pid)!;

const realmDir = (): string => mkdtempSync(join(tmpdir(), 'recued-reused-pid-'));

const lockNaming = (dir: string, pid: number, procStart: string, bindPort = 7717): string => {
  writeFileSync(join(dir, 'recued-server.lock'), JSON.stringify({
    pid, boot_at: Date.now() - 86_400_000, bind_port: bindPort, proc_start: procStart,
  }));
  return join(dir, 'r.db');
};

const pidfileNaming = (dir: string, pid: number, procStart: string): string => {
  writeFileSync(join(dir, 'recued-server.pid'), `${pid}\n${procStart}\n`);
  return join(dir, 'r.db');
};

const captured = async (run: () => Promise<void>): Promise<string> => {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.join(' ')); });
  try { await run(); } finally { log.mockRestore(); err.mockRestore(); }
  return lines.join('\n');
};

/** Ask the OS for a port, then hand it back — the number is free at return. */
const freePort = (): Promise<number> => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number };
    s.close(() => res(port));
  });
});

describe.skipIf(unsupported)('processStartIdentity', () => {
  it('names a live process the same way every time, and two processes differently', () => {
    const pid = decoy();
    const first = processStartIdentity(pid);
    expect(first).not.toBeNull();
    expect(processStartIdentity(pid)).toBe(first);
    expect(first).not.toBe(processStartIdentity(process.pid));
  });

  it('knows nothing of a process that has gone: unknown, never "a different process"', async () => {
    const pid = decoy();
    process.kill(pid, 'SIGKILL');
    expect(await stillAliveAfter(pid)).toBe(false);
    expect(processStartIdentity(pid)).toBeNull();
    expect(pidWasReused(pid, anotherProcessStart())).toBe(false);
  });
});

describe.skipIf(unsupported)('a realm lock whose PID now names another process', () => {
  it('⛔ boot reclaims it instead of refusing, and records its own start', () => {
    const dir = realmDir();
    lockNaming(dir, decoy(), anotherProcessStart());
    const lock = createInstanceLock({ lockPath: join(dir, 'recued-server.lock') });
    const claimed = lock.claim({ boot_at: Date.now(), bind_port: 7717 });
    expect(claimed.pid).toBe(process.pid);
    expect(claimed.proc_start).toBe(processStartIdentity(process.pid));
    lock.release();
  });

  it('boot still refuses when the PID is the process that wrote the lock', () => {
    const dir = realmDir();
    const pid = decoy();
    lockNaming(dir, pid, processStartIdentity(pid)!);
    const lock = createInstanceLock({ lockPath: join(dir, 'recued-server.lock') });
    expect(() => lock.claim({ boot_at: Date.now(), bind_port: 7717 })).toThrow(LockHeldError);
  });

  it('⛔ is no live server to `liveServerHolding`, which `stop`, `status` and `update` ask', () => {
    expect(liveServerHolding(lockNaming(realmDir(), decoy(), anotherProcessStart()))).toBeNull();
    const pid = decoy();
    expect(liveServerHolding(lockNaming(realmDir(), pid, processStartIdentity(pid)!))?.pid).toBe(pid);
  });

  it('⛔ `recued stop` leaves the process alone and says nothing holds the realm', async () => {
    const pid = decoy();
    const out = await captured(() => daemonStop({ dbPath: lockNaming(realmDir(), pid, anotherProcessStart()) }, 'linux'));
    expect(await survives(pid)).toBe(true);
    expect(out).toMatch(/nothing holds this realm/i);
  });

  it('`recued stop` still stops the server that did write it', async () => {
    const pid = decoy();
    const out = await captured(() => daemonStop({ dbPath: lockNaming(realmDir(), pid, processStartIdentity(pid)!) }, 'linux'));
    expect(await stillAliveAfter(pid)).toBe(false);
    expect(out).toMatch(/Server stopped/);
  });

  it('⛔ `recued status` does not call it the running server', async () => {
    const port = await freePort();
    const dbPath = lockNaming(realmDir(), decoy(), anotherProcessStart(), port);
    const out = await captured(() => daemonStatus({ dbPath, port }, 'linux'));
    expect(out).not.toMatch(/Status:\s+running/);
    expect(out).toMatch(/Status:\s+stopped/);
  });
});

describe.skipIf(unsupported)('a `recued start` pidfile whose PID now names another process', () => {
  it('⛔ `recued stop` leaves the process alone and clears the pidfile', async () => {
    const dir = realmDir();
    const pid = decoy();
    const out = await captured(() => daemonStop({ dbPath: pidfileNaming(dir, pid, anotherProcessStart()) }, 'linux'));
    expect(await survives(pid)).toBe(true);
    expect(out).toMatch(/now belongs to another process/);
    expect(existsSync(join(dir, 'recued-server.pid'))).toBe(false);
  });

  it('`recued stop` still stops the process `recued start` launched', async () => {
    const pid = decoy();
    const out = await captured(() => daemonStop({ dbPath: pidfileNaming(realmDir(), pid, processStartIdentity(pid)!) }, 'linux'));
    expect(await stillAliveAfter(pid)).toBe(false);
    expect(out).toMatch(/Server stopped/);
  });

  it('⛔ `recued status` clears it as stale instead of reporting it running', async () => {
    const port = await freePort();
    const dbPath = pidfileNaming(realmDir(), decoy(), anotherProcessStart());
    const out = await captured(() => daemonStatus({ dbPath, port }, 'linux'));
    expect(out).toMatch(/Status: stopped \(stale pidfile for pid \d+, removed\)/);
    expect(out).not.toMatch(/Status:\s+running/);
  });
});

describe.skipIf(unsupported)('an update lease whose PID now names another process', () => {
  /** What an update that died uncleanly leaves: its number, now the decoy's. */
  const leaseNaming = (pid: number, procStart: string): string => {
    const leasePath = join(realmDir(), 'recued-update.lock');
    writeFileSync(leasePath, JSON.stringify({ pid, operation: 'apply', at: 1, token: 'dead-update', proc_start: procStart }));
    return leasePath;
  };

  it('⛔ is nobody updating — to boot, and to `recued --mcp`', () => {
    const leasePath = leaseNaming(decoy(), anotherProcessStart());
    expect(inspectUpdateLease(leasePath, processStartIdentity)).toBeNull();
    expect(mcpLeaseHolder(leasePath)).toBeNull();
  });

  it('⛔ the next update claims it instead of being refused until someone deletes the file', () => {
    const leasePath = leaseNaming(decoy(), anotherProcessStart());
    const lease = acquireUpdateLease({ leasePath, operation: 'apply', identify: processStartIdentity });
    expect(lease.reentrant).toBe(false);
    lease.release();
  });

  it('a live update that did take it still holds it', () => {
    const pid = decoy();
    const leasePath = leaseNaming(pid, processStartIdentity(pid)!);
    expect(inspectUpdateLease(leasePath, processStartIdentity)?.pid).toBe(pid);
    expect(() => acquireUpdateLease({ leasePath, operation: 'apply', identify: processStartIdentity }))
      .toThrow(UpdateLeaseHeldError);
  });
});
