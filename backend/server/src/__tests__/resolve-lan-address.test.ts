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

/** D-272 — every classifier at its EDGES.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-17): 26 mutations of `resolve-lan-address.ts`,
 *  14 survived — the worst ratio of the sweep, and all of one kind. Every test
 *  above picks a mid-range representative (`100.96.3.4`, `169.254.10.1`,
 *  `2001:db8::5`), so not one boundary was pinned: all FOUR CGNAT edges, the
 *  172.16/12 top and bottom, the IPv6 global-unicast range, and both of
 *  `parseIpv4`'s validations could be moved or deleted with the suite green.
 *
 *  ⛔ THIS CLASSIFICATION IS A SECURITY WARNING IN BOTH DIRECTIONS, which is
 *  why the edges matter more here than the middles:
 *    - too WIDE and a carrier-NAT'd home is told its listener is on the
 *      internet — the module's own comment says a false "you are exposed"
 *      costs the reader a hunt for a problem they do not have;
 *    - too NARROW and an unencrypted LAN listener carrying /ws and /mcp sits
 *      on a routable address with no warning at all, which is the entire
 *      reason D-272 added this.
 *
 *  ⚠ ADDRESSES ARE ONE OFF THE BOUNDARY ON BOTH SIDES, deliberately. A table
 *  of in-range values cannot tell a correct bound from one that is too wide,
 *  and that is exactly how these survived. */
describe('D-272 — publicly-routable classification, at the boundaries', () => {
  // A non-wildcard bind is judged on its own address and reads no interfaces,
  // so this drives the classifier directly.
  const isPublic = (addr: string): boolean =>
    describeLanBindExposure(addr, {
      readInterfaces: (): never => { throw new Error('must not read interfaces'); },
    }).publicly_routable;

  const table: ReadonlyArray<[string, boolean, string]> = [
    // ── 127.0.0.0/8 loopback ──
    ['127.0.0.1', false, 'loopback'],
    ['127.255.255.254', false, 'loopback is the whole /8, not just 127.0.0.1'],
    ['126.255.255.254', true, 'one below the loopback block'],
    ['128.0.0.1', true, 'one above the loopback block'],
    // ── 10.0.0.0/8 ──
    ['10.0.0.0', false, 'bottom of 10/8'],
    ['10.255.255.254', false, 'top of 10/8'],
    ['9.255.255.254', true, 'one below 10/8'],
    ['11.0.0.1', true, 'one above 10/8'],
    // ── 172.16.0.0/12 — the range with an arithmetic edge at each end ──
    ['172.15.255.254', true, 'one below 172.16/12'],
    ['172.16.0.1', false, 'bottom of 172.16/12'],
    ['172.31.255.254', false, 'top of 172.16/12'],
    ['172.32.0.1', true, 'one above 172.16/12'],
    ['172.20.0.1', false, 'middle of 172.16/12'],
    // ── 192.168.0.0/16 ──
    ['192.168.0.1', false, 'bottom of 192.168/16'],
    ['192.168.255.254', false, 'top of 192.168/16'],
    ['192.167.255.254', true, 'one below 192.168/16'],
    ['192.169.0.1', true, 'one above 192.168/16'],
    ['192.16.0.1', true, '192.16 is PUBLIC — a prefix of "192.168" is not a match'],
    // ── 169.254.0.0/16 link-local ──
    ['169.254.0.1', false, 'bottom of link-local'],
    ['169.254.255.254', false, 'top of link-local'],
    ['169.253.255.254', true, 'one below link-local'],
    ['169.255.0.1', true, 'one above link-local'],
    ['169.25.0.1', true, '169.25 is PUBLIC — a prefix of "169.254" is not a match'],
    // ── 100.64.0.0/10 CGNAT ──
    ['100.63.255.254', true, 'one below CGNAT'],
    ['100.64.0.1', false, 'bottom of CGNAT'],
    ['100.127.255.254', false, 'top of CGNAT'],
    ['100.128.0.1', true, 'one above CGNAT'],
    // ── malformed: never reported as public ──
    ['999.1.1.1', false, 'an octet above 255 is not an address'],
    ['1.2.3.4.5', false, 'five parts is not an address'],
    ['1.2.3', false, 'three parts is not an address'],
    ['-1.2.3.4', false, 'a negative octet is not an address'],
    ['abc', false, 'not an address at all'],
    ['', false, 'the empty string'],
    // ── IPv6: global unicast is 2000::/3 and nothing else ──
    ['2000::1', true, 'bottom of IPv6 global unicast'],
    ['3fff::1', true, 'top of IPv6 global unicast'],
    ['1fff::1', false, 'one below global unicast'],
    ['4000::1', false, 'one above global unicast'],
    ['fe80::1', false, 'IPv6 link-local'],
    ['fc00::1', false, 'IPv6 unique-local'],
    ['::1', false, 'IPv6 loopback'],
    ['zzzz::1', false, 'an unparseable IPv6 head must not read as public'],
  ];

  for (const [addr, expected, why] of table) {
    it(`${JSON.stringify(addr)} is ${expected ? 'PUBLIC' : 'not public'} — ${why}`, () => {
      expect(isPublic(addr)).toBe(expected);
    });
  }

  it('⛔ an INTERNAL interface never counts toward exposure', () => {
    // ⚠ `internal` is the OS saying this is not a real network interface.
    // Counting one would report an exposure the bind did not create — and the
    // guard was unpinned because every fixture's internal row is a loopback
    // address, which the classifier already rejects on its own. Two rules
    // agreeing; this one carries a PUBLIC address so only `internal` can decide.
    const out = describeLanBindExposure('0.0.0.0', {
      readInterfaces: () => mkInterfaces([
        { name: 'en0', address: '192.168.1.42' },
        { name: 'lo0', address: '203.0.113.9', internal: true },
      ]),
    });
    expect(
      out.publicly_routable,
      'an internal interface was counted as an internet-facing address',
    ).toBe(false);
    expect(out.public_addresses).toEqual([]);
  });
});

/** D-148 W3.5 — the ADVERTISED address and the BOUND address are two fields.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-17). The suite asserts `address` and `source`
 *  on every branch and `bind_address` on almost none, so three separate
 *  mutations of it survived: an accepted override binding the wildcard instead
 *  of itself, a single candidate binding itself instead of the wildcard, and
 *  ambiguity binding the wildcard instead of loopback.
 *
 *  ⛔ THE AMBIGUOUS ONE IS THE DANGEROUS ONE. "Ambiguous" means the resolver
 *  could not tell which interface is the real LAN — and the conservative answer
 *  is loopback. Binding `0.0.0.0` there puts a PLAINTEXT listener carrying /ws
 *  and /mcp on every interface the host has, including a public one, at exactly
 *  the moment the code admits it does not know what those interfaces are. It is
 *  also the field `describeLanBindExposure` reads, so a wrong `bind_address`
 *  makes the exposure warning describe a bind that never happened. */
describe('D-148 W3.5 — bind_address, per outcome', () => {
  const lan = (addr: string, name = 'en0') => ({ name, address: addr });

  it('⛔ an accepted override binds ITSELF, never the wildcard', () => {
    // The whole point of pinning an address is to serve only there. Widening it
    // to `0.0.0.0` would silently grant the opposite of what was asked.
    const out = resolveLanAddress({
      override: '127.0.0.1',
      readInterfaces: () => mkInterfaces([lan('192.168.1.42'), { name: 'lo0', address: '127.0.0.1', internal: true }]),
    });
    expect(out.source).toBe('override');
    expect(out.address).toBe('127.0.0.1');
    expect(out.bind_address, 'a pinned override was widened to the wildcard').toBe('127.0.0.1');
  });

  it('⛔ a single detected candidate ADVERTISES itself but BINDS the wildcard', () => {
    // Binding the LAN IP alone would stop serving loopback, so `127.0.0.1` on
    // the machine itself would refuse — while the advertised address stays the
    // LAN IP, which is what a peer needs.
    const out = resolveLanAddress({
      readInterfaces: () => mkInterfaces([lan('192.168.1.42')]),
    });
    expect(out.source).toBe('detected');
    expect(out.address).toBe('192.168.1.42');
    expect(out.bind_address, 'binding the LAN IP alone stops serving loopback').toBe('0.0.0.0');
  });

  it('⛔⛔ AMBIGUOUS binds loopback — never the wildcard', () => {
    const out = resolveLanAddress({
      readInterfaces: () => mkInterfaces([lan('192.168.1.42'), lan('172.17.0.1', 'docker0')]),
    });
    expect(out.source).toBe('ambiguous_lan_candidates');
    expect(
      out.bind_address,
      'a resolver that cannot tell which interface is the LAN bound ALL of them',
    ).toBe('127.0.0.1');
    expect(out.address).toBe('127.0.0.1');
  });

  it('a gateway-matched candidate binds the wildcard, like any detection', () => {
    const out = resolveLanAddress({
      defaultRouteGateway: '192.168.1.1',
      readInterfaces: () => mkInterfaces([lan('192.168.1.42'), lan('172.17.0.1', 'docker0')]),
    });
    expect(out.source).toBe('detected_via_default_route');
    expect(out.bind_address).toBe('0.0.0.0');
  });

  it('no candidates at all binds loopback', () => {
    const out = resolveLanAddress({
      readInterfaces: () => mkInterfaces([{ name: 'lo0', address: '127.0.0.1', internal: true }]),
    });
    expect(out.source).toBe('loopback_fallback');
    expect(out.bind_address).toBe('127.0.0.1');
  });
});

describe('D-148 W3.5 — gateway matching, candidate collection, override edges', () => {
  const lan = (addr: string, name = 'en0') => ({ name, address: addr });

  it('⛔⛔ /24 beats /8 — the Docker-bridge regression the P2 fold fixed', () => {
    // ⚠ BOTH CANDIDATES MATCH THE GATEWAY, at different specificities. Every
    // existing gateway test has exactly one matching candidate, so the ORDER of
    // [/24, /16, /8] never decided anything and reversing it was invisible.
    // Reversed, a 10.x Docker/VPN address matches the gateway's first octet and
    // wins over the real LAN — the exact silent mis-bind the fold exists for.
    // ⚠⚠ THE /8-ONLY CANDIDATE MUST SORT FIRST, or the test proves nothing.
    // Candidates are sorted by address before matching, so a first version
    // using gateway 10.1.2.1 with 10.1.2.42 + 10.99.99.9 passed under BOTH
    // orderings: 10.1.2.42 sorts first, so even a /8-first scan reaches the
    // right answer by accident. Here 10.1.1.1 sorts first and matches only /8,
    // so only the specificity order can pick 10.9.8.42.
    const out = resolveLanAddress({
      defaultRouteGateway: '10.9.8.1',
      readInterfaces: () => mkInterfaces([
        lan('10.1.1.1', 'docker0'),   // sorts FIRST, matches /8 only
        lan('10.9.8.42', 'en0'),      // sorts second, matches /24
      ]),
    });
    expect(out.source).toBe('detected_via_default_route');
    expect(out.address, 'a /8 match outranked a /24 match').toBe('10.9.8.42');
  });

  it('⚠ a /16 match is used when nothing matches /24', () => {
    const out = resolveLanAddress({
      defaultRouteGateway: '10.9.8.1',
      readInterfaces: () => mkInterfaces([
        lan('10.1.1.1', 'docker0'),   // sorts first, /8 only
        lan('10.9.77.42', 'en0'),     // /16 match, no /24 match anywhere
      ]),
    });
    expect(out.address).toBe('10.9.77.42');
  });

  it('⛔ a BLANK or whitespace gateway is not a hint — it stays ambiguous', () => {
    // A gateway that could not be read comes back empty. Treating "" as a hint
    // makes `sharesPrefix` compare against nothing and pick a candidate at
    // random, which is auto-binding by accident.
    for (const gw of ['', '   ']) {
      const out = resolveLanAddress({
        defaultRouteGateway: gw,
        readInterfaces: () => mkInterfaces([lan('192.168.1.42'), lan('172.17.0.1', 'docker0')]),
      });
      expect(out.source, `gateway ${JSON.stringify(gw)} was used as a hint`).toBe(
        'ambiguous_lan_candidates',
      );
    }
  });

  it('⛔ a MALFORMED gateway matches nothing', () => {
    // `sharesPrefix` returns false on an unparseable address. Returning true
    // would make any garbage read from the routing table select the first
    // candidate.
    const out = resolveLanAddress({
      defaultRouteGateway: 'not-an-address',
      readInterfaces: () => mkInterfaces([lan('192.168.1.42'), lan('172.17.0.1', 'docker0')]),
    });
    expect(out.source, 'an unparseable gateway selected a candidate').toBe(
      'ambiguous_lan_candidates',
    );
  });

  it('a gateway is trimmed before matching', () => {
    const out = resolveLanAddress({
      defaultRouteGateway: '  192.168.1.1  ',
      readInterfaces: () => mkInterfaces([lan('192.168.1.42'), lan('172.17.0.1', 'docker0')]),
    });
    expect(out.source).toBe('detected_via_default_route');
  });

  it('an override is trimmed before it is checked', () => {
    const out = resolveLanAddress({
      override: '  192.168.1.42  ',
      readInterfaces: () => mkInterfaces([lan('192.168.1.42')]),
    });
    expect(out.source, 'surrounding whitespace defeated a valid override').toBe('override');
    expect(out.bind_address).toBe('192.168.1.42');
  });

  it('⛔ a whitespace-only override is NOT an override, and is not reported as ignored', () => {
    // It is the "Settings cleared → re-detect" gesture. Reporting it as an
    // ignored override would put a complaint on the page about a field the
    // reader deliberately emptied.
    const out = resolveLanAddress({
      override: '   ',
      readInterfaces: () => mkInterfaces([lan('192.168.1.42')]),
    });
    expect(out.source).toBe('detected');
    expect(out.override_ignored).toBeUndefined();
  });

  it('⛔ the same address on two interfaces is ONE candidate', () => {
    // Listed twice it looks like two interfaces, which turns a single-candidate
    // host (auto-detect works) into an ambiguous one (loopback, and a prompt).
    const out = resolveLanAddress({
      readInterfaces: () => mkInterfaces([
        lan('192.168.1.42', 'en0'),
        lan('192.168.1.42', 'en1'),
      ]),
    });
    expect(out.candidates).toHaveLength(1);
    expect(out.source, 'a duplicated address was read as an ambiguous host').toBe('detected');
  });

  it('⚠ the NUMERIC family 4 is accepted — older Node runtimes report it', () => {
    // Newer typings say `'IPv4'`; the runtime used to return `4`. Dropping the
    // numeric arm makes every interface invisible on those hosts, and the
    // server silently falls back to loopback-only.
    const out = resolveLanAddress({
      readInterfaces: () => mkInterfaces([{ name: 'en0', address: '192.168.1.42', family: 4 }]),
    });
    expect(out.source, 'a host reporting the numeric family had no candidates').toBe('detected');
    expect(out.address).toBe('192.168.1.42');
  });
});

/* ─── Mutation sweep of `network/resolve-lan-address.ts`, 2026-09-18 ────────
 *  51 mutations across two passes (26 classifier, 25 resolver); 47 caught.
 *  The 4 survivors are EQUIVALENT — recorded with their evidence so the next
 *  sweep does not re-derive them, and so nobody writes a test that passes
 *  either way:
 *
 *  1. `if (trimmed.length > 0)` → `>= 0` on the override. A blank override
 *     reaches `bindable.has('')`, and `bindable` is seeded from
 *     WILDCARD_BIND_ADDRESSES plus addresses with `length > 0`, so it can never
 *     hold `''`. The inner branch is not taken and the `ignored` annotation is
 *     gated on its own `> 0`. No path differs.
 *
 *  2. `if (family !== 'IPv4' && family !== 4) continue` deleted. A THIRD
 *     instance of the redundancy already recorded above for `isLoopbackIpv4` /
 *     `isLinkLocalIpv4`: the `!isRfc1918Ipv4(addr)` line two below already
 *     rejects every IPv6 form. Checked against 2001:db8::5, fe80::1, ::1,
 *     fc00::1, 10::1, 192:168::1, 172:16::1, ::ffff:192.168.1.1 and
 *     fe80::10.0.0.1 — none matches an RFC1918 pattern, because those anchor on
 *     a DOT after the octet and IPv6 uses colons. Keep the check (it says what
 *     it means, and is the guard a reader would look for), but no test can see
 *     it.
 *
 *  3. `if (gateway.length > 0)` → `if (true)`. An empty gateway reaches
 *     `sharesPrefix(addr, '', n)` → `parseIpv4('')` → `''.split('.')` is `['']`,
 *     length 1 ≠ 4 → null → false. Nothing matches, so it falls through to
 *     ambiguous exactly as the guard intends.
 *
 *  4. `opts.defaultRouteGateway.trim()` → untrimmed. `Number()` ALREADY trims:
 *     `Number('  192')` is 192 and `Number('1  ')` is 1, so
 *     `parseIpv4('  192.168.1.1  ')` returns [192,168,1,1] either way — and a
 *     whitespace-only gateway still parses to null (one part, not four). The
 *     `.trim()` is documentation, not behaviour.
 * ────────────────────────────────────────────────────────────────────────── */

