/** The live `public_port` rebind, driven through the coordinator.
 *
 *  ⛔ NO TEST DROVE A PORT CHANGE HERE. Four suites import this coordinator and
 *  every one of them exercises exposure flips or boot smoke; mutation found the
 *  port-move path completely uncovered — applying a change WITHOUT the new
 *  ports, and forgetting the port it had just bound, both survived.
 *
 *  ⚠ THIS IS THE PATH THE OWNER SAID WAS REPEATEDLY GOT WRONG. Changing the
 *  public port is the reason the address is editable at all, and it is the one
 *  operation that can strand a connected client: rebinding the WRONG listener
 *  drops the LAN socket the owner may be watching from.
 *
 *  Driven against real listeners on OS-picked ports — a port move is about
 *  sockets, and a fake set would prove only that a number was passed along.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createProductionPathListenerCoordinator } from '../network/path-listener-coordinator.js';
import { PATH_ROLES, totalRecord, type PathRole, type PathResolution } from '@recued/contracts';

const ALL_ON: Record<PathRole, PathResolution> =
  totalRecord(PATH_ROLES, () => ({ lan: true, public: true }));

const ok = (_req: IncomingMessage, res: ServerResponse): void => {
  res.statusCode = 200;
  res.end('ok');
};

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of running.splice(0).reverse()) await stop();
});

const coordinator = () => {
  const c = createProductionPathListenerCoordinator({
    handlers: totalRecord(PATH_ROLES, () => ok),
    upgradeHandlers: {},
    cert_chain: { current: () => null, replace: () => {}, onRotate: () => () => {} } as never,
    lan_port: 0,
    public_port: 0,
  });
  running.push(() => c.stop());
  return c;
};

/** The RESOLVED bound port — `port: 0` is a request, the status row carries what
 *  the OS actually gave. */
const portOf = (c: ReturnType<typeof coordinator>, listener: 'lan' | 'public'): number | null => {
  const row = c.status().find((r) => r.listener === listener);
  return row?.listening === true ? row.port : null;
};

/** A port that is free right now: bind, read, release.
 *
 *  ⛔ NOT `0`. A first version of this file asked for port 0 and could not tell
 *  a rebind from no rebind — the OS picks a fresh port either way, so "it is
 *  bound to something" holds in both worlds. That is the same port-0 trap this
 *  arc hit in the listener set itself, where `lan_port: 0` never equals the
 *  resolved port and made a guard fire on every apply. A move is only
 *  observable against a port someone NAMED. */
const freePort = async (): Promise<number> => {
  const { createServer } = await import('node:http');
  const srv = createServer();
  await new Promise<void>((done) => srv.listen(0, '127.0.0.1', done));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((done) => srv.close(() => done()));
  return port;
};

describe('D-273 / D-148 — moving the public port at runtime', () => {
  it('⛔ the public listener MOVES to the requested port', async () => {
    const c = coordinator();
    await c.apply({ resolution: ALL_ON, bind_addresses: { lan: '127.0.0.1', public: '127.0.0.1' } });
    const before = portOf(c, 'public');
    expect(before).not.toBeNull();

    const wanted = await freePort();
    await c.apply({
      resolution: ALL_ON,
      bind_addresses: { lan: '127.0.0.1', public: '127.0.0.1' },
      ports: { public: wanted },
    } as never);

    expect(portOf(c, 'public'), 'the public listener did not move to the requested port')
      .toBe(wanted);
    expect(portOf(c, 'public')).not.toBe(before);
  });

  it('⛔⛔ moving the PUBLIC port leaves the LAN listener untouched', async () => {
    // The property the owner cares about: the socket they are connected
    // through must survive a change to the other one.
    const c = coordinator();
    await c.apply({ resolution: ALL_ON, bind_addresses: { lan: '127.0.0.1', public: '127.0.0.1' } });
    const lanBefore = portOf(c, 'lan');
    expect(lanBefore).not.toBeNull();

    const wanted = await freePort();
    await c.apply({
      resolution: ALL_ON,
      bind_addresses: { lan: '127.0.0.1', public: '127.0.0.1' },
      ports: { public: wanted },
    } as never);

    // The public one really moved…
    expect(portOf(c, 'public')).toBe(wanted);
    // …and the LAN one did not.
    expect(portOf(c, 'lan'), 'the LAN listener was rebound by a PUBLIC port change')
      .toBe(lanBefore);
  });

  it('⚠ a resolution-only apply moves NEITHER port', async () => {
    // The control: proves the cases above move a port because a port was
    // ASKED FOR, not because every apply rebinds.
    const c = coordinator();
    await c.apply({ resolution: ALL_ON, bind_addresses: { lan: '127.0.0.1', public: '127.0.0.1' } });
    const lan = portOf(c, 'lan');
    const pub = portOf(c, 'public');

    await c.apply({ resolution: ALL_ON, bind_addresses: { lan: '127.0.0.1', public: '127.0.0.1' } });

    expect(portOf(c, 'lan')).toBe(lan);
    expect(portOf(c, 'public')).toBe(pub);
  });
});
