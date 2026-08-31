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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { daemonStatus } from '../daemon.js';

/** A fresh dir per arm: `status` derives the pidfile from the db path, so an
 *  unused directory is what puts us on the no-pidfile branch. */
const freshDb = () => join(mkdtempSync(join(tmpdir(), 'recued-status-')), 'r.db');

const capture = async (port: number): Promise<string> => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
  try {
    await daemonStatus({ dbPath: freshDb(), port });
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
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

describe('daemon status distinguishes "stopped" from "not ours to stop"', () => {
  it('a recued server we did not start reads as RUNNING, not stopped', async () => {
    const port = await freePort();
    const srv = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', now: 1 }));
    });
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => {
      srv.closeAllConnections();
      srv.close(() => r());
    }));

    const out = await capture(port);
    expect(out).toContain('running');
    expect(out).toContain('NOT under `recued start`');
    // The owner's next move must be in the message, not inferred.
    expect(out).toContain(`grep ${port}`);
    expect(out).toMatch(/systemctl status recued/);
    // The regression is this line reappearing on a port that is serving.
    expect(out).not.toMatch(/^Status: stopped$/m);
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
