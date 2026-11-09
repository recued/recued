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

/** The ports asked for are the ports bound, whoever applies next (found by D-341's live drive,
 *  2026-11-08). An exposure flip names no port, and it used the port the set was BUILT with: a
 *  moved public listener went back to its boot port while the server advertised the moved one.
 *
 *  ⚠ Built on a NAMED port, never 0: from port 0 a move back to the boot port is a fresh OS pick
 *  either way, which is how the control above ("a resolution-only apply moves NEITHER port") stayed
 *  green through it. */
describe('D-273 — the port asked for outlives the apply that asked for it', () => {
  const BIND = { lan: '127.0.0.1', public: '127.0.0.1' };
  // ⚠ A fresh table each apply: the listener set keeps the first one it is given as its live table
  // and rewrites it in place on every later apply, so a shared constant becomes whatever was
  // applied last. (The tests above apply one resolution only, so they never see it.)
  const allOn = (): Record<PathRole, PathResolution> => totalRecord(PATH_ROLES, () => ({ lan: true, public: true }));
  const lanOnly = (): Record<PathRole, PathResolution> => totalRecord(PATH_ROLES, () => ({ lan: true, public: false }));
  /** An exposure flip that keeps some path public: one path's public bit off. */
  const flip = (): Record<PathRole, PathResolution> => ({ ...allOn(), reception: { lan: true, public: false } });

  const named = (public_port: number, on_applied?: (statuses: unknown) => void) => {
    const c = createProductionPathListenerCoordinator({
      handlers: totalRecord(PATH_ROLES, () => ok),
      upgradeHandlers: {},
      cert_chain: { current: () => null, replace: () => {}, onRotate: () => () => {} } as never,
      lan_port: 0,
      public_port,
      ...(on_applied !== undefined ? { on_applied } : {}),
    });
    running.push(() => c.stop());
    return c;
  };
  const twoFreePorts = async (): Promise<[number, number]> => {
    const a = await freePort();
    let b = await freePort();
    while (b === a) b = await freePort();
    return [a, b];
  };

  it('⛔⛔ an exposure flip after a live move keeps the moved port', async () => {
    const [boot, moved] = await twoFreePorts();
    const c = named(boot);
    await c.apply({ resolution: allOn(), bind_addresses: BIND });
    expect(portOf(c, 'public')).toBe(boot);
    await c.apply({ resolution: allOn(), bind_addresses: BIND, ports: { public: moved } } as never);
    expect(portOf(c, 'public')).toBe(moved);

    await c.apply({ resolution: flip(), bind_addresses: BIND });
    expect(portOf(c, 'public'), 'an exposure flip put the public listener back on its boot port').toBe(moved);
    await c.apply({ resolution: allOn(), bind_addresses: BIND });
    expect(portOf(c, 'public')).toBe(moved);
  });

  it('the moved port survives the public listener going off and on again', async () => {
    const [boot, moved] = await twoFreePorts();
    const c = named(boot);
    await c.apply({ resolution: allOn(), bind_addresses: BIND });
    await c.apply({ resolution: allOn(), bind_addresses: BIND, ports: { public: moved } } as never);
    await c.apply({ resolution: lanOnly(), bind_addresses: BIND });
    expect(portOf(c, 'public')).toBeNull();
    await c.apply({ resolution: allOn(), bind_addresses: BIND });
    expect(portOf(c, 'public'), 'off and on again, it came back on its boot port').toBe(moved);
  });

  it('a port asked for while no path is public is the one bound when a path is', async () => {
    const [boot, wanted] = await twoFreePorts();
    const c = named(boot);
    await c.apply({ resolution: lanOnly(), bind_addresses: BIND });
    await c.apply({ resolution: lanOnly(), bind_addresses: BIND, ports: { public: wanted } } as never);
    expect(portOf(c, 'public')).toBeNull();
    await c.apply({ resolution: allOn(), bind_addresses: BIND });
    expect(portOf(c, 'public'), 'the port asked for while it was off was dropped').toBe(wanted);
  });

  it('a move that failed is asked for again, and never falls back to the old port', async () => {
    const [boot, taken] = await twoFreePorts();
    const { createServer } = await import('node:http');
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(taken, '127.0.0.1', done));
    const c = named(boot);
    await c.apply({ resolution: allOn(), bind_addresses: BIND });
    const failed = await c.apply({ resolution: allOn(), bind_addresses: BIND, ports: { public: taken } } as never);
    expect(failed.public.listening).toBe(false);
    await c.apply({ resolution: flip(), bind_addresses: BIND });
    expect(portOf(c, 'public'), 'a flip after a failed move served the old port').toBeNull();
    await new Promise<void>((done) => holder.close(() => done()));
    await c.apply({ resolution: flip(), bind_addresses: BIND });
    expect(portOf(c, 'public'), 'freed, the port asked for was not bound').toBe(taken);
  });

  it('a first apply that names a port binds it: the set is built with it, not with the boot port', async () => {
    const [boot, wanted] = await twoFreePorts();
    const c = named(boot);
    await c.apply({ resolution: allOn(), bind_addresses: BIND, ports: { public: wanted } } as never);
    expect(portOf(c, 'public'), 'the set was built on the boot port, ignoring the port asked for').toBe(wanted);
  });

  it('tells its observer what every apply bound, an exposure flip\'s included', async () => {
    const [boot, moved] = await twoFreePorts();
    const seen: number[] = [];
    const c = named(boot, (statuses) => {
      const pub = (statuses as Array<{ listener: string; listening: boolean; port: number }>).find((s) => s.listener === 'public');
      if (pub?.listening === true) seen.push(pub.port);
    });
    await c.apply({ resolution: allOn(), bind_addresses: BIND });
    await c.apply({ resolution: allOn(), bind_addresses: BIND, ports: { public: moved } } as never);
    await c.apply({ resolution: flip(), bind_addresses: BIND });
    expect(seen).toEqual([boot, moved, moved]);
  });

  it('an observer that throws does not fail the apply', async () => {
    const [boot] = await twoFreePorts();
    const c = named(boot, () => { throw new Error('observer down'); });
    const statuses = await c.apply({ resolution: allOn(), bind_addresses: BIND });
    expect(statuses.public.listening).toBe(true);
  });
});
