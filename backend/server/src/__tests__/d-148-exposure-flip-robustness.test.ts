/** D-148 exposure-flip robustness — the production `PathListenerCoordinator`
 *  must reconfigure exposure WITHOUT wedging on a live control WS.
 *
 *  Repro of the reported bug: `exposure.set_path_resolution(reception, …)`
 *  on a server whose LAN listener carries the operator's live WS hung the
 *  server — the old coordinator path closed + rebuilt the whole listener
 *  set on every transition, and `server.close()` on a listener holding an
 *  upgraded (never-draining) WS blocks forever, so the LAN socket died
 *  (new connects refused) and never came back.
 *
 *  These tests drive the coordinator directly (the state machine just
 *  awaits `listener.apply`, so the coordinator is the integration point)
 *  with a holding WS upgrade handler, avoiding the full server.ts wiring. */

import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { createCertChainHolder, type PortRequestHandler, type PortUpgradeHandler } from '@recued/server-tls';
import type { PathResolution, PathRole } from '@recued/contracts';
import {
  createProductionPathListenerCoordinator,
  type ProductionPathListenerCoordinator,
} from '../network/path-listener-coordinator.js';

const ok: PortRequestHandler = (_req, res) => { res.statusCode = 200; res.end('ok'); };

/** WS upgrade handler that completes the 101 and HOLDS the socket open. */
const buildHoldingUpgrade = (): {
  handler: PortUpgradeHandler;
  serverSockets: net.Socket[];
} => {
  const serverSockets: net.Socket[] = [];
  const handler: PortUpgradeHandler = (_req, socket) => {
    serverSockets.push(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  };
  return { handler, serverSockets };
};

const lanResolution = (reception: boolean): Record<PathRole, PathResolution> => ({
  health: { lan: true, public: false },
  ws: { lan: true, public: false },
  mcp: { lan: true, public: false },
  llm_gateway: { lan: true, public: false },
  webhooks: { lan: false, public: false },
  reception: { lan: reception, public: false },
  oauth: { lan: false, public: false },
  ask: { lan: false, public: false },
  webclient: { lan: true, public: false },
});

const openHeldWs = (port: number): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1', () => {
      client.write(
        [
          'GET /ws HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      );
    });
    client.on('data', (chunk) => { if (chunk.toString('utf8').includes('101')) resolve(client); });
    client.on('error', reject);
    setTimeout(() => reject(new Error('openHeldWs timeout')), 2000).unref();
  });

const rawGetStatus = (port: number, path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1', () => {
      client.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    client.on('data', (chunk) => { buf += chunk.toString('utf8'); });
    client.on('close', () => {
      const m = buf.match(/^HTTP\/1\.1 (\d+)/);
      resolve(m ? Number(m[1]) : 0);
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('rawGetStatus timeout')), 2000).unref();
  });

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | 'TIMED_OUT'> =>
  Promise.race([p, new Promise<'TIMED_OUT'>((r) => setTimeout(() => r('TIMED_OUT'), ms).unref())]);

describe('D-148 exposure-flip robustness — production coordinator', () => {
  let coordinator: ProductionPathListenerCoordinator | null = null;
  let cleanup: Array<() => void> = [];

  afterEach(async () => {
    for (const fn of cleanup) fn();
    cleanup = [];
    if (coordinator) {
      await coordinator.stop().catch(() => {});
      coordinator = null;
    }
  });

  it('flips reception ON with a held WS — no hang, port stable, WS survives', async () => {
    const { handler, serverSockets } = buildHoldingUpgrade();
    coordinator = createProductionPathListenerCoordinator({
      handlers: { health: ok, reception: ok },
      upgradeHandlers: { ws: handler },
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
    });
    // Initial bind (what the state machine's reapply() does at boot).
    const initial = await coordinator.apply({
      resolution: lanResolution(false),
      bind_addresses: { lan: '127.0.0.1', public: '127.0.0.1' },
    });
    expect(initial.lan.listening).toBe(true);
    const port = coordinator.status().find((s) => s.listener === 'lan')!.port;
    expect(await rawGetStatus(port, '/reception/_health')).toBe(404);

    // Operator's live control WS on the LAN listener — the wedge premise.
    const held = await openHeldWs(port);
    cleanup.push(() => held.destroy(), () => { for (const s of serverSockets) s.destroy(); });
    expect(held.destroyed).toBe(false);

    // The flip. The OLD path hung here forever on server.close().
    const outcome = await withTimeout(
      coordinator.apply({
        resolution: lanResolution(true),
        bind_addresses: { lan: '127.0.0.1', public: '127.0.0.1' },
      }),
      4000,
    );
    expect(outcome).not.toBe('TIMED_OUT');

    const lan = coordinator.status().find((s) => s.listener === 'lan')!;
    expect(lan.port).toBe(port); // listener NOT rebuilt
    expect(lan.listening).toBe(true);
    expect(held.destroyed).toBe(false); // WS NOT dropped — seamless toggle
    expect(await rawGetStatus(port, '/reception/_health')).toBe(200);
  });
});
