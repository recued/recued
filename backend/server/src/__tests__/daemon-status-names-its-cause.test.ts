/** ⛔⛔ `Status: stopped` IS A CLAIM ABOUT THE PIDFILE, NOT ABOUT THE PORT.
 *
 *  `recued status` reads a pidfile written only by `recued start`. A server
 *  started by a D-178 autostart unit — or by a foreground `recued serve` in
 *  another shell — leaves no pidfile, so the owner reads `Status: stopped` right
 *  next to `EADDRINUSE` from their own `recued serve`, with no way to tell which
 *  one is lying. Neither is: they answer different questions. Reported from a
 *  live droplet 2026-08-30, where an autostart unit held 7717 and both `status`
 *  and `stop` insisted nothing was running.
 *
 *  🔑 A negative must name its cause, so there are THREE outcomes, not one. This
 *  drives real sockets rather than asserting on source text, because the whole
 *  defect was that the reported state and the actual port state disagreed — and
 *  only a real listener can reproduce that. */

import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { daemonStatus } from '../daemon.js';

/** A fresh dir per arm: `status` derives the pidfile from the db path, so an
 *  unused directory is what puts us on the no-pidfile branch. */
const freshDb = () => join(mkdtempSync(join(tmpdir(), 'recued-status-')), 'r.db');

/** Linux by default, so the hint assertions below mean the same thing on every
 *  host that runs this file; the macOS arm passes 'darwin' explicitly. */
const capture = async (
  port: number,
  dbPath: string = freshDb(),
  platform: NodeJS.Platform = 'linux',
): Promise<string> => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
  try {
    await daemonStatus({ dbPath, port }, platform);
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
};

/** A realm whose instance lock names a live holder — what `recued serve` leaves
 *  and `recued start` does not. Scoped to the realm, unlike a port probe. */
const realmHeldBy = (pid: number, bindPort: number): string => {
  const dbPath = freshDb();
  writeFileSync(
    join(dirname(dbPath), 'recued-server.lock'),
    JSON.stringify({ pid, boot_at: Date.now(), bind_port: bindPort }),
  );
  return dbPath;
};

/** A pidfile left by a `recued start` whose process is gone. */
const withStalePidfile = (dbPath: string, pid = 2_147_483_645): string => {
  writeFileSync(join(dirname(dbPath), 'recued-server.pid'), String(pid));
  return dbPath;
};

/** Ask the OS for a port, then hand it back — the number is free at return. */
const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });

/** ⚠ `close()` WAITS FOR OPEN CONNECTIONS, and `pingHealth` leaves one: Node's
 *  fetch keeps the socket alive. The first version of this file hung its
 *  afterEach for the full 30s hook timeout and reported the ARM as failed, when
 *  the assertion had already passed — a cleanup defect wearing a test failure's
 *  clothes. Destroy the sockets, then close. */
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

/** A listener that answers /health like a recued server — i.e. a recued server
 *  this realm does not own. */
const serveHealth = async (port: number): Promise<void> => {
  const srv = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', now: 1 }));
  });
  await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => {
    srv.closeAllConnections();
    srv.close(() => r());
  }));
};

describe('daemon status distinguishes "stopped" from "not ours to stop"', () => {
  it('a recued server we did not start reads as RUNNING, not stopped', async () => {
    const port = await freePort();
    await serveHealth(port);

    const out = await capture(port);
    expect(out).toContain('running');
    // ⚠ WORDING SHARPENED, PROPERTY UNCHANGED. This asserted `NOT under `recued
    // start``, which described how it was launched. With the realm lock now
    // consulted first, reaching this branch means something stronger and more
    // useful: a recued server answers the PORT while nothing holds this REALM,
    // so it is serving a different database and stop genuinely cannot help.
    expect(out).toContain('NOT on this realm');
    // The owner's next move must be in the message, not inferred.
    expect(out).toContain(`grep ${port}`);
    expect(out).toMatch(/systemctl status recued/);
    // The regression is this line reappearing on a port that is serving.
    expect(out).not.toMatch(/^Status: stopped$/m);
  });


  // ⛔⛔ THE PORT IS NOT THE REALM. `pingHealth` answers "is a recued server on
  // this PORT", and that misleads in both directions: another realm's server on
  // the same port reads as ours, and our own server bound elsewhere is missed.
  // The instance lock is scoped to the realm and records the port actually
  // bound — the same source `recued stop` and `recued update` read, so all three
  // now answer one machine the same way.
  it('names the holder from the REALM lock, not from whatever holds the port', async () => {
    const out = await capture(9, realmHeldBy(process.pid, 7717));

    expect(out).toMatch(/Status: running/);
    expect(out).toContain(String(process.pid));
    expect(out).toContain('7717');
    // ⚠ It reached this without any listener at all — port 9 is discard and
    // nothing is serving. A port probe could not have produced this answer.
    expect(out).not.toMatch(/Status: stopped/);
  });

  it('says the port it was given is not the port the server bound', async () => {
    const out = await capture(8123, realmHeldBy(process.pid, 7717));
    expect(out).toMatch(/bound to 7717, not the 8123/);
  });

  // ⚠ THE LINE THAT WENT STALE. `recued stop` grew an instance-lock fallback, so
  // "cannot stop it" became false for exactly the case the lock names — and a
  // stale remedy is what sent an owner round the installer → apply → stop loop.
  it('offers `recued stop` for a holder it can name, and withholds it otherwise', async () => {
    const ours = await capture(9, realmHeldBy(process.pid, 7717));
    expect(ours).toMatch(/`recued stop` can stop it/);

    const port = await freePort();
    await serveHealth(port);
    const foreign = await capture(port);
    expect(foreign).toMatch(/NOT on this realm/);
    expect(foreign).toMatch(/`recued stop` cannot stop it/);
  });

  it('a dead pid in the lock is not a running server', async () => {
    const out = await capture(9, realmHeldBy(2_147_483_646, 7717));
    expect(out).toMatch(/Status: stopped/);
  });

  it('a NON-recued listener reads as stopped-but-port-taken, naming EADDRINUSE', async () => {
    const port = await freePort();
    const srv = createServer();
    const open: import('node:net').Socket[] = [];
    srv.on('connection', (sock) => open.push(sock));
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => {
      for (const sock of open) sock.destroy();
      srv.close(() => r());
    }));

    const out = await capture(port);
    expect(out).toContain('already in use');
    expect(out).toContain('EADDRINUSE');
    expect(out).toContain(`grep ${port}`);
    // It must NOT claim a recued server is up — nothing answered /health.
    expect(out).not.toContain('NOT under `recued start`');
  });

  it('a free port still reads as a plain stopped', async () => {
    const out = await capture(await freePort());
    expect(out).toMatch(/^Status: stopped$/m);
    expect(out).not.toContain('already in use');
    expect(out).not.toContain('running');
  });
});

describe('a stale pidfile does not answer for the server', () => {
  /** ⛔ Reported 2026-09-28 from a Mac: `Status: stopped (stale pidfile for pid
   *  58752)` while its launchd job was serving, then `running` on the next run,
   *  because the first call had removed the file. The pidfile's process being
   *  gone says nothing about the realm or the port. */
  it('a stale pidfile beside a live realm holder reads as RUNNING, and the file is removed', async () => {
    const dbPath = withStalePidfile(realmHeldBy(process.pid, 7717));
    const out = await capture(9, dbPath);
    expect(out).toMatch(/Status: running/);
    expect(out).toContain(String(process.pid));
    expect(out).toMatch(/Removed a stale pidfile: pid 2147483645/);
    expect(out).not.toMatch(/Status: stopped/);
    expect(existsSync(join(dirname(dbPath), 'recued-server.pid'))).toBe(false);
  });

  it('a stale pidfile beside a foreign server on the port reads as running, not ours', async () => {
    const port = await freePort();
    await serveHealth(port);
    const out = await capture(port, withStalePidfile(freshDb()));
    expect(out).toMatch(/NOT on this realm/);
    expect(out).toMatch(/Removed a stale pidfile/);
  });

  it('a stale pidfile with nothing running still reads as stopped, naming the pid', async () => {
    const out = await capture(await freePort(), withStalePidfile(freshDb()));
    expect(out).toMatch(/^Status: stopped \(stale pidfile for pid 2147483645, removed\)$/m);
  });
});

describe('the owner hints name commands this platform has', () => {
  /** ⛔ `ss` and `systemctl` do not exist on macOS, whose autostart is the
   *  com.recued.server LaunchAgent. */
  it('on macOS: lsof and launchctl, never ss or systemctl', async () => {
    const port = await freePort();
    await serveHealth(port);
    const out = await capture(port, freshDb(), 'darwin');
    expect(out).toContain(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    expect(out).toContain('launchctl print gui/$(id -u)/com.recued.server');
    expect(out).not.toMatch(/\bss -ltnp\b|systemctl/);
  });

  it('on Linux: ss and systemctl, including the --user unit', async () => {
    const port = await freePort();
    await serveHealth(port);
    const out = await capture(port, freshDb(), 'linux');
    expect(out).toContain(`ss -ltnp | grep ${port}`);
    expect(out).toContain('systemctl status recued');
    expect(out).toContain('systemctl --user status recued');
    expect(out).not.toContain('launchctl');
  });

  it('on Windows: netstat, and no Unix tools', async () => {
    const port = await freePort();
    await serveHealth(port);
    const out = await capture(port, freshDb(), 'win32');
    expect(out).toContain(`netstat -ano | findstr :${port}`);
    expect(out).not.toMatch(/lsof|launchctl|systemctl|ss -ltnp/);
  });
});
