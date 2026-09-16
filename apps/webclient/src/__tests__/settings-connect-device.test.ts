/** Settings — Server — Connect a device.
 *
 *  Three places, because that is the question the reader has. The assertions that
 *  matter are about what is NOT said: no card may hand over an address that opens
 *  and then refuses to run, and nothing may assert a certificate state that was
 *  never read. Readability is held separately, in
 *  `settings-connect-device-readability.test.ts`. */
import { describe, expect, it } from 'vitest';

import {
  CERTIFICATE_ROUTES,
  PRO_CERTIFICATE_NOTE,
  buildConnectDevicePlaces,
  hostedAppNote,
  type ConnectDeviceFacts,
} from '../settings/connect-device.js';

const facts = (over: Partial<ConnectDeviceFacts> = {}): ConnectDeviceFacts => ({
  lan_port: 7717,
  public_port: 443,
  certified_hostnames: [],
  ...over,
});

describe('a fresh server', () => {
  const [here, home, away] = buildConnectDevicePlaces(facts());

  it('answers all three places, easiest first', () => {
    expect([here!.place, home!.place, away!.place])
      .toEqual(['this_computer', 'at_home', 'away']);
  });

  it('this computer is ready with no setup, and carries the link', () => {
    expect(here!.state).toBe('ready');
    expect(here!.status).toBe('Ready');
    expect(here!.url).toBe('http://127.0.0.1:7717/webclient/');
    expect(here!.portNote).toContain('7717');
    expect(here!.portNote).toContain('Nothing leaves your computer');
  });

  it('⛔ a place that is not ready offers NO address', () => {
    // The failure this page exists to prevent: an address that opens a page and
    // then stops is worse than no address.
    expect(home!.url).toBeUndefined();
    expect(away!.url).toBeUndefined();
    expect([home!.state, away!.state]).toEqual(['one_step', 'one_step']);
  });

  it('home says what is missing without naming the machinery', () => {
    expect(home!.body).toContain('needs a safe one');
    expect(home!.body).toContain('certificate');
    expect(home!.portNote).toContain('only one to set up');
  });

  it('⚠ away is SEPARATE because it can need a router step that home does not', () => {
    // Folding away into home would hide the one difference between them, and it
    // is the difference that costs a reader an afternoon.
    expect(away!.body).toContain('Tailscale covers both');
    expect(away!.body).toContain('router');
  });
});

describe('the ways to get a certificate', () => {
  it('⚠ all free, ordered by what the reader already has', () => {
    expect(CERTIFICATE_ROUTES.map((r) => r.title)).toEqual([
      'Tailscale', 'Caddy', 'A certificate you already have',
    ]);
    // ⛔ Pro is NOT one of them — a paid row among free ones reads as the free
    // ones being second-best. It is a footnote instead.
    expect(CERTIFICATE_ROUTES.some((r) => r.title.includes('Pro'))).toBe(false);
    expect(PRO_CERTIFICATE_NOTE).toContain('nothing to set up');
  });

  it('⛔ a route that needs a command CARRIES it — a name is not an answer', () => {
    const [tailscale, caddy, byo] = CERTIFICATE_ROUTES;
    expect(tailscale!.command).toContain('tailscale cert');
    expect(tailscale!.command).toContain('tailscale serve');
    expect(caddy!.command).toContain('reverse_proxy 127.0.0.1:7717');
    // Uploading is a place in the UI, not a shell step.
    expect(byo!.command).toBeUndefined();
    expect(byo!.detail).toContain('Certificates');
  });

  it('only Tailscale claims to cover away-from-home', () => {
    // The badge is a promise. Caddy needs a router change for away, so it must
    // not carry one — and the away card says the same thing in words.
    expect(CERTIFICATE_ROUTES.filter((r) => r.coversAway).map((r) => r.title))
      .toEqual(['Tailscale']);
  });
});

describe('⚠ a certificate state that was never READ', () => {
  const [, home] = buildConnectDevicePlaces(facts({ certified_hostnames: null }));

  it('gives the same guidance without claiming what nothing looked for', () => {
    expect(home!.state).toBe('one_step');
    expect(home!.url).toBeUndefined();
    expect(home!.body).toContain('needs a safe one');
  });
});

describe('once a certificate exists', () => {
  const certified = facts({ certified_hostnames: ['home.example.com'] });

  it('home and away both turn ready, on the same address', () => {
    const [, home, away] = buildConnectDevicePlaces(certified);
    expect([home!.state, away!.state]).toEqual(['ready', 'ready']);
    expect(home!.url).toBe('https://home.example.com/webclient/');
    expect(away!.url).toBe('https://home.example.com/webclient/');
  });

  it('⚠ away still warns that the router may not be letting traffic in', () => {
    // A certificate makes the address SAFE, not REACHABLE. Saying "ready" without
    // this would promise something the certificate cannot deliver.
    const [, , away] = buildConnectDevicePlaces(certified);
    expect(away!.body).toContain('router may still need');
    expect(away!.body).toContain('Reachability');
  });

  it('carries a non-default public port into the address', () => {
    const [, home] = buildConnectDevicePlaces({ ...certified, public_port: 8446 });
    expect(home!.url).toBe('https://home.example.com:8446/webclient/');
  });

  it('carries a non-default bind port everywhere 7717 was named', () => {
    const [here] = buildConnectDevicePlaces({ ...certified, lan_port: 9100 });
    expect(here!.url).toBe('http://127.0.0.1:9100/webclient/');
    expect(here!.portNote).toContain('9100');
  });

  it('the hosted app becomes a real option, described as equivalent', () => {
    expect(hostedAppNote(certified)).toContain('same app');
    expect(hostedAppNote(certified)).not.toContain('cannot reach');
  });
});
