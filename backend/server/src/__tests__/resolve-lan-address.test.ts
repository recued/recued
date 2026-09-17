/** D-148 W3.5 — resolveLanAddress helper.
 *
 *  Pure projection tests; OS network interface read is injected via
 *  `readInterfaces` so the tests don't depend on host topology.
 *  Covers the Codex W3.5 P2 fold (default-route gateway hint + the
 *  `ambiguous_lan_candidates` surface that replaces the silent
 *  lexicographic pick).
 */

import { describe, it, expect } from 'vitest';
import {
  describeLanBindExposure,
  resolveLanAddress,
  LOOPBACK_FALLBACK,
} from '../network/resolve-lan-address.js';

type IfaceList = ReturnType<typeof import('node:os').networkInterfaces>;

const mkInterfaces = (
  rows: Array<{ name: string; address: string; family?: string | number; internal?: boolean }>,
): IfaceList => {
  const out: IfaceList = {};
  for (const r of rows) {
    out[r.name] = [
      {
        address: r.address,
        netmask: '255.255.255.0',
        family: (r.family ?? 'IPv4') as 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: r.internal ?? false,
        cidr: `${r.address}/24`,
      },
    ];
  }
  return out;
};

describe('D-148 W3.5 — resolveLanAddress', () => {
  // ── The override, and why it is verified rather than obeyed ──────────
  //
  // An unbindable LAN address is not a degraded boot: `assertLanListenerBound
  // OrExit` calls `process.exit(4)`, deliberately without a restart loop. The
  // override is hand-typed and names a HOST fact that goes stale by itself (a
  // new network, a new DHCP lease, an image moved to another machine), so
  // obeying it verbatim turns any of those into "the server will not start" —
  // with the setting that caused it reachable only through the server that
  // will not start. It is checked against the host's own addresses instead.

  it('explicit override wins when this host actually has that address', () => {
    const r = resolveLanAddress({
      override: '192.168.1.42',
      readInterfaces: () => mkInterfaces([
        { name: 'en0', address: '192.168.1.42' },
        { name: 'docker0', address: '172.17.0.1' },
      ]),
    });
    expect(r.source).toBe('override');
    expect(r.address).toBe('192.168.1.42');
    expect(r.override_ignored).toBeUndefined();
    // Reports what else was on offer — the Doctor renders the alternatives
    // beside the chosen address.
    expect(r.candidates).toEqual([
      { address: '172.17.0.1', iface: 'docker0' },
      { address: '192.168.1.42', iface: 'en0' },
    ]);
  });

  it('an override this host does NOT have is ignored, and detection proceeds', () => {
    const r = resolveLanAddress({
      override: '192.168.1.42', // stale: this machine moved networks
      readInterfaces: () => mkInterfaces([{ name: 'en0', address: '10.0.0.1' }]),
    });
    expect(r.address).toBe('10.0.0.1'); // booted, not bricked
    expect(r.source).toBe('detected');
    expect(r.override_ignored).toEqual({
      value: '192.168.1.42',
      reason: 'not_bindable_on_this_host',
    });
  });

  it('carries the ignored override through EVERY detection outcome', () => {
    // The annotation is orthogonal to which branch detection lands in — if it
    // were attached to only one, the loud boot warning would go missing on
    // exactly the hosts most likely to have a stale override.
    const ambiguous = resolveLanAddress({
      override: '10.99.99.99',
      readInterfaces: () => mkInterfaces([
        { name: 'en0', address: '192.168.1.42' },
        { name: 'docker0', address: '172.17.0.1' },
      ]),
    });
    expect(ambiguous.source).toBe('ambiguous_lan_candidates');
    expect(ambiguous.override_ignored?.value).toBe('10.99.99.99');

    const viaRoute = resolveLanAddress({
      override: '10.99.99.99',
      defaultRouteGateway: '192.168.1.1',
      readInterfaces: () => mkInterfaces([
        { name: 'en0', address: '192.168.1.42' },
        { name: 'docker0', address: '172.17.0.1' },
      ]),
    });
    expect(viaRoute.source).toBe('detected_via_default_route');
    expect(viaRoute.override_ignored?.value).toBe('10.99.99.99');

    const none = resolveLanAddress({
      override: '10.99.99.99',
      readInterfaces: () => mkInterfaces([]),
    });
    expect(none.source).toBe('loopback_fallback');
    expect(none.override_ignored?.value).toBe('10.99.99.99');
  });

  it('accepts overrides detection would never propose on its own', () => {
    const ifaces = () => mkInterfaces([{ name: 'en0', address: '192.168.1.42' }]);
    // Wildcard — never on an interface list, always bindable, a deliberate
    // "serve on everything" choice.
    expect(resolveLanAddress({ override: '0.0.0.0', readInterfaces: ifaces }).source).toBe('override');
    expect(resolveLanAddress({ override: '::', readInterfaces: ifaces }).source).toBe('override');
    // Forcing loopback-only: internal, so never a detection candidate, but
    // the host does have it.
    const loop = resolveLanAddress({
      override: '127.0.0.1',
      readInterfaces: () => mkInterfaces([
        { name: 'lo0', address: '127.0.0.1', internal: true },
        { name: 'en0', address: '192.168.1.42' },
      ]),
    });
    expect(loop.source).toBe('override');
    expect(loop.address).toBe('127.0.0.1');
    // A public (non-RFC1918) address on a VPS — also never a candidate.
    const vps = resolveLanAddress({
      override: '203.0.113.7',
      readInterfaces: () => mkInterfaces([{ name: 'eth0', address: '203.0.113.7' }]),
    });
    expect(vps.source).toBe('override');
    expect(vps.address).toBe('203.0.113.7');
  });

  it('matches an IPv6 override case-insensitively and ignoring the zone suffix', () => {
    const r = resolveLanAddress({
      override: 'FE80::1',
      // Distinct names — `mkInterfaces` keys by name, so same-name rows
      // would overwrite rather than stack.
      readInterfaces: () => mkInterfaces([
        { name: 'en0', address: 'fe80::1%en0', family: 'IPv6' },
        { name: 'en1', address: '192.168.1.42' },
      ]),
    });
    expect(r.source).toBe('override');
    expect(r.address).toBe('FE80::1');
  });

  it('blank override falls through to detection', () => {
    const r = resolveLanAddress({
      override: '   ',
      readInterfaces: () => mkInterfaces([{ name: 'en0', address: '10.0.0.1' }]),
    });
    expect(r.source).toBe('detected');
    expect(r.address).toBe('10.0.0.1');
  });

  it('detects single RFC1918 192.168.x interface', () => {
    const r = resolveLanAddress({
      readInterfaces: () => mkInterfaces([{ name: 'en0', address: '192.168.1.42' }]),
    });
    expect(r.source).toBe('detected');
    expect(r.address).toBe('192.168.1.42');
    expect(r.candidates).toEqual([{ address: '192.168.1.42', iface: 'en0' }]);
  });

  it('multiple RFC1918 candidates without default-route hint → ambiguous_lan_candidates (P2 fold)', () => {
    const r = resolveLanAddress({
      readInterfaces: () => mkInterfaces([
        { name: 'en0', address: '192.168.1.42' },
        { name: 'docker0', address: '172.17.0.1' },
        { name: 'utun0', address: '10.0.0.1' },
      ]),
    });
    expect(r.source).toBe('ambiguous_lan_candidates');
    // Loopback fallback for the chosen address — conservative scope
    // until the caller resolves the ambiguity via Settings override.
    expect(r.address).toBe(LOOPBACK_FALLBACK);
    expect(r.candidates.map((c) => c.address)).toEqual([
      '10.0.0.1',
      '172.17.0.1',
      '192.168.1.42',
    ]);
  });

  it('default-route gateway matching /24 picks the real LAN over docker/VPN', () => {
    const r = resolveLanAddress({
      defaultRouteGateway: '192.168.1.1',
      readInterfaces: () => mkInterfaces([
        { name: 'docker0', address: '172.17.0.1' },
        { name: 'en0', address: '192.168.1.42' },
      ]),
    });
    expect(r.source).toBe('detected_via_default_route');
    expect(r.address).toBe('192.168.1.42');
    expect(r.candidates.length).toBe(2);
  });

  it('default-route gateway matching /16 picks the larger LAN', () => {
    const r = resolveLanAddress({
      // Gateway on 10.0.x.x net; one candidate matches /16.
      defaultRouteGateway: '10.0.0.1',
      readInterfaces: () => mkInterfaces([
        { name: 'en0', address: '10.0.5.42' },
        { name: 'docker0', address: '172.17.0.1' },
      ]),
    });
    expect(r.source).toBe('detected_via_default_route');
    expect(r.address).toBe('10.0.5.42');
  });

  it('default-route gateway with no matching candidate falls through to ambiguous', () => {
    const r = resolveLanAddress({
      // Gateway routes via a public IP (e.g., direct VPS — no LAN).
      defaultRouteGateway: '203.0.113.1',
      readInterfaces: () => mkInterfaces([
        { name: 'en0', address: '192.168.1.42' },
        { name: 'docker0', address: '172.17.0.1' },
      ]),
    });
    expect(r.source).toBe('ambiguous_lan_candidates');
  });

  it('skips loopback (127.x)', () => {
    const r = resolveLanAddress({
      readInterfaces: () => mkInterfaces([
        { name: 'lo0', address: '127.0.0.1', internal: true },
      ]),
    });
    expect(r.source).toBe('loopback_fallback');
    expect(r.address).toBe(LOOPBACK_FALLBACK);
  });

  it('skips link-local (169.254.x)', () => {
    const r = resolveLanAddress({
      readInterfaces: () => mkInterfaces([{ name: 'en0', address: '169.254.1.5' }]),
    });
    expect(r.source).toBe('loopback_fallback');
  });

  it('skips public IPs (non-RFC1918)', () => {
    const r = resolveLanAddress({
      readInterfaces: () => mkInterfaces([{ name: 'en0', address: '203.0.113.5' }]),
    });
    expect(r.source).toBe('loopback_fallback');
  });

  it('skips IPv6', () => {
    const r = resolveLanAddress({
      readInterfaces: () => mkInterfaces([
        { name: 'en0', address: 'fe80::1', family: 'IPv6' },
      ]),
    });
    expect(r.source).toBe('loopback_fallback');
  });

  it('skips internal interfaces', () => {
    const r = resolveLanAddress({
      readInterfaces: () => mkInterfaces([
        { name: 'en0', address: '192.168.1.42', internal: true },
      ]),
    });
    expect(r.source).toBe('loopback_fallback');
  });

  it('LOOPBACK_FALLBACK matches the substrate default in server-tls', () => {
    // Sanity: the helper's fallback equals DEFAULT_LAN_BIND_ADDRESS
    // in @recued/server-tls. Mismatch here would mean a forgotten
    // override stops over-exposing in the helper layer but reverts
    // to wildcard in the substrate layer — defense-in-depth depends
    // on both being conservative.
    expect(LOOPBACK_FALLBACK).toBe('127.0.0.1');
  });

  it('handles all-RFC1918 ranges (10.x / 172.16-31.x / 192.168.x)', () => {
    const cases: Array<{ addr: string; isRfc1918: boolean }> = [
      { addr: '10.0.0.1', isRfc1918: true },
      { addr: '10.255.255.255', isRfc1918: true },
      { addr: '172.15.0.1', isRfc1918: false },
      { addr: '172.16.0.1', isRfc1918: true },
      { addr: '172.31.255.255', isRfc1918: true },
      { addr: '172.32.0.1', isRfc1918: false },
      { addr: '192.168.0.1', isRfc1918: true },
      { addr: '11.0.0.1', isRfc1918: false },
    ];
    for (const c of cases) {
      const r = resolveLanAddress({
        readInterfaces: () => mkInterfaces([{ name: 'en0', address: c.addr }]),
      });
      if (c.isRfc1918) {
        expect(r.source).toBe('detected');
        expect(r.address).toBe(c.addr);
      } else {
        expect(r.source).toBe('loopback_fallback');
      }
    }
  });

  it('candidate sort is by address, not by interface name', () => {
    const r = resolveLanAddress({
      readInterfaces: () => mkInterfaces([
        { name: 'zzz_late_iface', address: '10.0.0.1' },
        { name: 'aaa_early_iface', address: '192.168.1.42' },
      ]),
    });
    expect(r.source).toBe('ambiguous_lan_candidates');
    expect(r.candidates[0]!.address).toBe('10.0.0.1');
    expect(r.candidates[1]!.address).toBe('192.168.1.42');
  });
});

// ────────────────────────────────────────────────────────────────────────
// D-272 — is the LAN listener somewhere the internet can route to?
// ────────────────────────────────────────────────────────────────────────

describe('D-272 — describeLanBindExposure', () => {
  // ⛔ THE WILDCARD ALONE IS NOT THE FINDING. `resolveLanAddress` returns
  // `0.0.0.0` for the ordinary home case (one RFC1918 address), so warning on
  // the wildcard would fire for nearly every install and teach the reader to
  // ignore it. What matters is the wildcard PLUS a publicly-routable address.
  it('⛔ the ordinary home shape — wildcard, private only — is NOT exposed', () => {
    const out = describeLanBindExposure('0.0.0.0', {
      readInterfaces: () => mkInterfaces([
        { name: 'en0', address: '192.168.1.42' },
        { name: 'lo0', address: '127.0.0.1', internal: true },
      ]),
    });
    expect(out.wildcard).toBe(true);
    expect(out.publicly_routable).toBe(false);
    expect(out.public_addresses).toEqual([]);
  });

  it('⛔⛔ the cloud-VM shape — a private NIC AND a public one — IS exposed', () => {
    // The case this exists for: `resolveLanAddress` sees one RFC1918 address,
    // returns `0.0.0.0`, and the same socket lands on the public address too.
    // Plaintext, carrying `/ws` and `/mcp`, with no source-address filter.
    const out = describeLanBindExposure('0.0.0.0', {
      readInterfaces: () => mkInterfaces([
        { name: 'ens5', address: '172.31.4.10' },
        { name: 'ens6', address: '203.0.113.7' },
      ]),
    });
    expect(out.publicly_routable).toBe(true);
    expect(out.public_addresses).toEqual(['203.0.113.7']);
  });

  it('⛔ CGNAT is NOT public — a carrier-NATd home is not reachable from outside', () => {
    // "not RFC1918" would have called this exposed. A false "you are exposed"
    // costs the reader a hunt for a problem they do not have.
    const out = describeLanBindExposure('0.0.0.0', {
      readInterfaces: () => mkInterfaces([{ name: 'wwan0', address: '100.96.3.4' }]),
    });
    expect(out.publicly_routable).toBe(false);
  });

  it('⚠ link-local and loopback are not public either', () => {
    const out = describeLanBindExposure('0.0.0.0', {
      readInterfaces: () => mkInterfaces([
        { name: 'en1', address: '169.254.10.1' },
        { name: 'lo0', address: '127.0.0.1', internal: true },
      ]),
    });
    expect(out.publicly_routable).toBe(false);
  });

  it('⚠ `0.0.0.0` is IPv4-only, so it cannot expose a global IPv6 address', () => {
    // Only the `::` wildcard reaches v6. Reporting a v6 address under an IPv4
    // wildcard would name an exposure the bind did not create.
    const rows = [
      { name: 'en0', address: '192.168.1.42' },
      { name: 'en0', address: '2001:db8::5', family: 'IPv6' },
    ];
    expect(describeLanBindExposure('0.0.0.0', {
      readInterfaces: () => mkInterfaces(rows),
    }).publicly_routable).toBe(false);
    expect(describeLanBindExposure('::', {
      readInterfaces: () => mkInterfaces(rows),
    }).public_addresses).toEqual(['2001:db8::5']);
  });

  it('a NON-wildcard bind is judged on its own address, with no interface read', () => {
    const boom = (): never => { throw new Error('must not read interfaces'); };
    expect(describeLanBindExposure('127.0.0.1', { readInterfaces: boom }).publicly_routable)
      .toBe(false);
    expect(describeLanBindExposure('192.168.1.42', { readInterfaces: boom }).publicly_routable)
      .toBe(false);
    // An operator who pinned the public address of a VPS gets told so.
    const pinned = describeLanBindExposure('203.0.113.7', { readInterfaces: boom });
    expect(pinned).toEqual({
      publicly_routable: true,
      wildcard: false,
      public_addresses: ['203.0.113.7'],
    });
  });
});
