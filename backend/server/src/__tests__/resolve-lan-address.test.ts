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
  it('explicit override always wins', () => {
    const r = resolveLanAddress({
      override: '192.168.1.42',
      readInterfaces: () => mkInterfaces([{ name: 'en0', address: '10.0.0.1' }]),
    });
    expect(r.source).toBe('override');
    expect(r.address).toBe('192.168.1.42');
    expect(r.candidates).toEqual([]);
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
