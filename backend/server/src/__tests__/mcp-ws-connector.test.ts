/** D-125 P4.2 (B3a) — `mcp-ws-connector` real-socket tests.
 *
 *  The handler suite (`d-125-phase-4-2-connection-mcp`) drives the WS
 *  transport through a MOCK `wsConnect`; it cannot prove the two things
 *  the REAL connector exists to guarantee:
 *    1. §920/§339 — the bearer / custom-auth headers actually ride in the
 *       upgrade handshake (a real `ws` server reads them off `req`). The
 *       WHATWG `WebSocket` global can't set them; this is the whole reason
 *       the connector is injected.
 *    2. SSRF — `followRedirects: false`: a non-101 upgrade response (incl.
 *       a 3xx) is REFUSED, never followed to its `Location`.
 *  These spin up real servers on ephemeral ports. */

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createWsConnect } from '../mcp-ws-connector.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Start a ws server on an ephemeral port; resolve with the port. */
const listenWss = (
  onConnection: (socket: WsSocket, req: http.IncomingMessage) => void,
): Promise<number> =>
  new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', onConnection);
    wss.on('listening', () => {
      cleanups.push(() => new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }));
      resolve((wss.address() as AddressInfo).port);
    });
  });

/** Start a fixture on IPv4 loopback, matching the connector's enrolled URL. */
const listenHttp = (server: http.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
      resolve((server.address() as AddressInfo).port);
    });
  });

describe('mcp-ws-connector — real socket', () => {
  it('puts the bearer in the upgrade handshake header + round-trips a frame', async () => {
    let seenAuth: string | undefined;
    const port = await listenWss((socket, req) => {
      seenAuth = req.headers.authorization;
      socket.on('message', (raw) => socket.send(raw.toString())); // echo
    });
    const handle = await createWsConnect()(`ws://127.0.0.1:${port}/mcp`, {
      headers: { Authorization: 'Bearer secret-tok' },
    });
    const echoed = await new Promise<string>((resolve) => {
      handle.onMessage(resolve);
      handle.send('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    });
    handle.close();
    expect(seenAuth).toBe('Bearer secret-tok');
    expect(JSON.parse(echoed)).toMatchObject({ id: 1, method: 'ping' });
  });

  it('fires onClose when the server closes the socket', async () => {
    const port = await listenWss((socket) => {
      socket.close(1000, 'bye');
    });
    const handle = await createWsConnect()(`ws://127.0.0.1:${port}/`, {});
    const info = await new Promise<{ code?: number }>((resolve) => {
      handle.onClose(resolve);
    });
    expect(info.code).toBe(1000);
  });

  it('refuses a non-101 upgrade response (3xx not followed — SSRF)', async () => {
    // Handle the upgrade explicitly, rather than depending on HTTP request
    // fallback. The local target records any accidental redirect without ever
    // sending a request to a real internal/metadata host.
    let targetRequests = 0;
    const target = http.createServer((_req, res) => {
      targetRequests += 1;
      res.writeHead(401);
      res.end();
    });
    target.on('upgrade', (_req, socket) => {
      targetRequests += 1;
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    const targetPort = await listenHttp(target);
    let upgradeRequests = 0;
    const redirect = http.createServer();
    redirect.on('upgrade', (_req, socket) => {
      upgradeRequests += 1;
      socket.end('HTTP/1.1 302 Found\r\n'
        + `Location: ws://127.0.0.1:${targetPort}/\r\n`
        + 'Connection: close\r\nContent-Length: 0\r\n\r\n');
    });
    const port = await listenHttp(redirect);
    await expect(
      createWsConnect()(`ws://127.0.0.1:${port}/`, {}),
    ).rejects.toThrow(/handshake rejected: HTTP 302/);
    expect(upgradeRequests).toBe(1);
    expect(targetRequests).toBe(0);
  });

  it('rejects with an AbortError when the connect signal fires', async () => {
    // A server that accepts the upgrade socket but never completes the
    // handshake — the connect hangs until the signal aborts it.
    const held: Duplex[] = [];
    const server = http.createServer();
    server.on('upgrade', (_req, socket) => { held.push(socket); /* never respond */ });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as AddressInfo).port));
    });
    cleanups.push(() => new Promise<void>((r) => {
      held.forEach((s) => s.destroy());
      server.close(() => r());
    }));
    const controller = new AbortController();
    const connecting = createWsConnect()(`ws://127.0.0.1:${port}/`, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
  });
});
