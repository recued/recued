/** D-273 COMPLETION GATE (2/2) — the PUBLIC PATH, served by the real router.
 *
 *  ⛔⛔ THE FINDING THIS CLOSES. Connect a device announced "Ready anywhere —
 *  both steps are done" whenever the PORT was reachable. The port is not the
 *  app: `deriveBootstrapDerivedExposureState` ships `webclient: { public: false }`,
 *  so on a STOCK INSTALL the address resolves, TLS completes, and `/webclient/`
 *  returns 404 from the internet. Two suites each passed — the exposure default
 *  has tests, the path router has tests, the projection has tests — and the JOIN
 *  between them was never run.
 *
 *  🔑 SO THIS ASSERTS THE JOIN, NOT THE PIECES. One `resolution` object is built
 *  by the real derive, handed to the real router, bound to a real socket, and
 *  hit with a real request — and the SAME boolean the webclient reads out of
 *  `exposure.get()` is shown to be the one the server obeys. If those two ever
 *  come apart again, a request here 404s while the fact says open.
 *
 *  ⚠ WHAT IS REAL: the exposure derive, `createPathRouter`, node's http server,
 *  and an actual socket round-trip. ⚠ WHAT IS NOT: TLS (the dispatcher is
 *  transport-agnostic by construction — `createPathRouter` never reaches into
 *  listener state — and terminating TLS here would test node, not us), and the
 *  webclient's projection, which cannot be imported from `backend/` and is
 *  covered against the same boolean in `settings-connect-device.test.ts`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PATH_ROLES, type PathResolution, type PathRole } from '@recued/contracts';
import { createPathRouter, type PortRequestHandler } from '@recued/server-tls';

import { deriveBootstrapDerivedExposureState } from '../exposure/bootstrap.js';

/** A handler that proves WHICH role answered, so a 200 cannot come from
 *  somewhere else in the chain. */
const handlerFor = (role: PathRole): PortRequestHandler => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`served:${role}`);
};

/** ⛔ THE CANONICAL LIST, IMPORTED — not retyped. The first draft wrote
 *  `'webhook'` for `'webhooks'`, and vitest could not see it: `Object.fromEntries`
 *  takes any key, so the map simply carried a role that does not exist and
 *  omitted one that does. `typecheck:tests` caught it. A hand-copied closed list
 *  is one edit behind exactly once, and here that edit would have made a real
 *  role 404 for the wrong reason. */
const ALL_ROLES: readonly PathRole[] = PATH_ROLES;

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => { s.close(() => { r(); }); })));
});

/** Bind the REAL dispatcher for one listener bit on loopback. */
const listen = async (
  resolution: Record<PathRole, PathResolution>,
  listener: 'lan' | 'public',
): Promise<string> => {
  const router = createPathRouter({
    resolution,
    handlers: Object.fromEntries(ALL_ROLES.map((r) => [r, handlerFor(r)])),
    listener,
  });
  const server = createServer((req, res) => { void router.request(req, res); });
  open.push(server);
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
};

const get = async (base: string, path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.text() };
};

/** The state a stock install actually boots with. */
const stockExposure = () => deriveBootstrapDerivedExposureState({
  webhook_port: 0,
  public_reachable: true,     // ⚠ the GENEROUS case: the port IS reachable
}).resolution;

describe('D-273 gate — the app path is a separate question from the port', () => {
  it('⛔⛔ a STOCK install serves NO /webclient/ to the internet', async () => {
    // The whole finding, through the real router over a real socket. Note
    // `public_reachable: true` above — this is not a server that failed to open
    // a port. The port is open; the app is not served on it.
    const resolution = stockExposure();
    expect(resolution.webclient.public).toBe(false);

    const publicBase = await listen(resolution, 'public');
    const { status } = await get(publicBase, '/webclient/');
    expect(status).toBe(404);
  });

  it('⚠ and serves it on the LAN, which is why the card can say "Ready at home"', async () => {
    const lanBase = await listen(stockExposure(), 'lan');
    const { status, body } = await get(lanBase, '/webclient/');
    expect(status).toBe(200);
    expect(body).toBe('served:webclient');
  });

  it('⛔⛔ THE JOIN: the boolean the page reads is the one the server obeys', async () => {
    // `exposure.get().state.resolution.webclient.public` is what the webclient
    // now gates "Ready anywhere" on. This proves the same field decides what the
    // public listener actually does — so the page and the server cannot disagree
    // without this test noticing.
    const resolution = stockExposure();
    const opened: Record<PathRole, PathResolution> = {
      ...resolution,
      webclient: { ...resolution.webclient, public: true },
    };

    const shut = await listen(resolution, 'public');
    const openBase = await listen(opened, 'public');

    expect((await get(shut, '/webclient/')).status).toBe(404);
    expect((await get(openBase, '/webclient/')).status).toBe(200);
  });

  it('⚠ a 404 for a DISABLED path is indistinguishable from an unknown one', async () => {
    // Deliberate: a different status or body for "exists but switched off" tells
    // a stranger what this server runs. The generic 404 is the whole point, and
    // it is also why the owner CANNOT diagnose this from outside — which is why
    // the page has to be told, rather than left to probe.
    const publicBase = await listen(stockExposure(), 'public');
    const disabled = await get(publicBase, '/webclient/');
    const unknown = await get(publicBase, '/no-such-surface/');
    expect(disabled.status).toBe(unknown.status);
    expect(disabled.body).toBe(unknown.body);
  });

  it('⚠ the ports the card advertises DO answer — health and ws are public here', async () => {
    // Guards the inverse mistake: over-correcting into "nothing is public" would
    // make the card refuse to hand over an address that works.
    const publicBase = await listen(stockExposure(), 'public');
    expect((await get(publicBase, '/health')).status).toBe(200);
    expect((await get(publicBase, '/ws')).status).toBe(200);
  });
});
