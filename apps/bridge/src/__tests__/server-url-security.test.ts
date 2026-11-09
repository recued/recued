/** D-169 bridge security hunt, F2 — regression coverage for the shared
 *  TLS-for-public-pairing gate (`pairing/server-url-security.ts`).
 *
 *  These tests LOCK IN the two invariants the security hunt established and
 *  that the module's comments call out as load-bearing:
 *    1. FAIL-CLOSED: only a host the public internet cannot route to (and any
 *       TLS URL) may carry plaintext; every public host over http/ws is
 *       refused. WIDENED — it was loopback + RFC1918 literals ONLY, which
 *       refused link-local, CGNAT/Tailscale and mDNS `.local` hosts whose
 *       traffic never touches the open internet, i.e. false refusals against
 *       the guard's own premise. Each admitted range cites an RFC; see the
 *       module header.
 *    2. NO PREFIX BYPASS: a public hostname that merely *looks* private
 *       (`127.0.0.1.evil.com`, `10.evil.com`) is matched on parsed IPv4
 *       octets, never a string prefix — so it is NOT treated as LAN-local
 *       and its plaintext form is refused. A future "simplification" back to
 *       `host.startsWith('127.')` must break here. */

import { describe, it, expect } from 'vitest';
import {
  ipv4Octets,
  isLanLocalHost,
  isInsecurePublicServerUrl,
} from '../pairing/server-url-security.js';

describe('ipv4Octets — dotted-quad literal parsing', () => {
  it('parses a real four-octet literal', () => {
    expect(ipv4Octets('127.0.0.1')).toEqual([127, 0, 0, 1]);
    expect(ipv4Octets('255.255.255.255')).toEqual([255, 255, 255, 255]);
    expect(ipv4Octets('0.0.0.0')).toEqual([0, 0, 0, 0]);
  });

  it('rejects an out-of-range octet', () => {
    expect(ipv4Octets('256.0.0.1')).toBeNull();
    expect(ipv4Octets('1.2.3.999')).toBeNull();
  });

  it('rejects the wrong number of parts', () => {
    expect(ipv4Octets('1.2.3')).toBeNull(); // 3 parts
    expect(ipv4Octets('1.2.3.4.5')).toBeNull(); // 5 parts
    expect(ipv4Octets('1.2.3.')).toBeNull(); // trailing-dot empty part
  });

  it('rejects non-numeric octets', () => {
    expect(ipv4Octets('a.b.c.d')).toBeNull();
    expect(ipv4Octets('1.2.x.4')).toBeNull();
  });

  it('SECURITY: a public host that looks private parses to null', () => {
    // The exact bypass strings from the module comment — extra labels past a
    // private-looking prefix must NOT parse as a 4-octet literal.
    expect(ipv4Octets('127.0.0.1.evil.com')).toBeNull();
    expect(ipv4Octets('10.evil.com')).toBeNull();
  });
});

describe('isLanLocalHost — loopback + RFC1918 recognition', () => {
  it('recognises localhost (case-insensitive)', () => {
    expect(isLanLocalHost('localhost')).toBe(true);
    expect(isLanLocalHost('LOCALHOST')).toBe(true);
  });

  it('recognises the IPv4 private/loopback ranges', () => {
    expect(isLanLocalHost('127.0.0.1')).toBe(true); // 127/8
    expect(isLanLocalHost('127.255.255.255')).toBe(true);
    expect(isLanLocalHost('10.0.0.1')).toBe(true); // 10/8
    expect(isLanLocalHost('192.168.1.10')).toBe(true); // 192.168/16
    expect(isLanLocalHost('172.16.0.1')).toBe(true); // 172.16/12 low edge
    expect(isLanLocalHost('172.31.255.255')).toBe(true); // 172.16/12 high edge
  });

  it('rejects near-miss IPv4 ranges (boundary)', () => {
    expect(isLanLocalHost('172.15.0.1')).toBe(false); // just below 16
    expect(isLanLocalHost('172.32.0.1')).toBe(false); // just above 31
    expect(isLanLocalHost('192.169.0.1')).toBe(false); // not 192.168
    expect(isLanLocalHost('8.8.8.8')).toBe(false); // public
    expect(isLanLocalHost('0.0.0.0')).toBe(false);
  });

  it('recognises the IPv6 loopback/ULA/link-local literals (bracketed)', () => {
    expect(isLanLocalHost('[::1]')).toBe(true); // loopback
    expect(isLanLocalHost('[fc00::1]')).toBe(true); // ULA fc/7
    expect(isLanLocalHost('[fd12:3456::1]')).toBe(true); // ULA fd
    expect(isLanLocalHost('[fe80::1]')).toBe(true); // link-local low
    expect(isLanLocalHost('[febf::1]')).toBe(true); // link-local high
  });

  it('rejects public/near-miss IPv6 literals', () => {
    expect(isLanLocalHost('[2001:db8::1]')).toBe(false); // public
    expect(isLanLocalHost('[fe7f::1]')).toBe(false); // fe7 not in fe[89ab]
    expect(isLanLocalHost('[fec0::1]')).toBe(false); // fec not link-local
  });

  it('SECURITY: a public host that looks private is NOT LAN-local', () => {
    expect(isLanLocalHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLanLocalHost('10.evil.com')).toBe(false);
    // A DNS name can't be bracketed, so the IPv6 branch can't be tricked.
    expect(isLanLocalHost('evil.com')).toBe(false);
  });

  it('recognises 169.254.0.0/16 link-local (RFC 3927 — routers MUST NOT forward)', () => {
    expect(isLanLocalHost('169.254.0.1')).toBe(true);
    expect(isLanLocalHost('169.254.255.255')).toBe(true);
  });

  it('recognises 100.64.0.0/10 shared address space (RFC 6598 — CGNAT, Tailscale)', () => {
    expect(isLanLocalHost('100.64.0.1')).toBe(true); // low edge
    expect(isLanLocalHost('100.101.102.103')).toBe(true); // a tailnet peer
    expect(isLanLocalHost('100.127.255.255')).toBe(true); // high edge
  });

  it('rejects the octet either side of the two new ranges (boundary)', () => {
    // ⚠ A /10 IS NOT A /8. `100.x` is a REAL public range outside 64-127 —
    //   100.0.0.1 belongs to a public allocation, so a sloppy `o[0] === 100`
    //   would admit plaintext to the open internet. That is the only way this
    //   widening could have made the guard WRONG rather than merely wider.
    expect(isLanLocalHost('100.63.255.255')).toBe(false);
    expect(isLanLocalHost('100.128.0.1')).toBe(false);
    expect(isLanLocalHost('100.0.0.1')).toBe(false);
    expect(isLanLocalHost('169.253.0.1')).toBe(false);
    expect(isLanLocalHost('169.255.0.1')).toBe(false);
  });

  it('recognises an mDNS `.local` name, any case, with or without the FQDN dot', () => {
    expect(isLanLocalHost('myserver.local')).toBe(true);
    expect(isLanLocalHost('MyServer.LOCAL')).toBe(true);
    expect(isLanLocalHost('nas.local.')).toBe(true); // `new URL()` keeps the dot
  });

  it('SECURITY: `.local` matches only as a trailing LABEL', () => {
    // The prefix-bypass shape again, on the name arm this time: a public host
    // may contain `.local` anywhere but the end, and must stay refused.
    expect(isLanLocalHost('evil.local.attacker.com')).toBe(false);
    expect(isLanLocalHost('mylocal')).toBe(false);
    expect(isLanLocalHost('local')).toBe(false); // the bare label is not `.local`
    expect(isLanLocalHost('localdomain')).toBe(false);
  });

  it('DELIBERATE: a bare single-label name and a vendor suffix stay refused', () => {
    // Not an oversight — `nas` is not a public FQDN but a search domain can
    // expand it to one, and `*.ts.net` is a vendor claim rather than an RFC.
    // Tailscale issues real certs for MagicDNS, so those users have https://.
    expect(isLanLocalHost('nas')).toBe(false);
    expect(isLanLocalHost('server.tailnet-abc.ts.net')).toBe(false);
  });
});

describe('isInsecurePublicServerUrl — the pairing/WS-dial gate', () => {
  it('refuses plaintext to a public host (http + ws)', () => {
    expect(isInsecurePublicServerUrl('http://server.example.com')).toBe(true);
    expect(isInsecurePublicServerUrl('http://server.example.com:3001/auth/pair')).toBe(true);
    expect(isInsecurePublicServerUrl('ws://server.example.com/rpc')).toBe(true);
  });

  it('allows TLS to any host (https + wss)', () => {
    expect(isInsecurePublicServerUrl('https://server.example.com')).toBe(false);
    expect(isInsecurePublicServerUrl('wss://server.example.com/rpc')).toBe(false);
    expect(isInsecurePublicServerUrl('https://localhost:3001')).toBe(false);
  });

  it('allows plaintext to LAN-local hosts (the supported no-TLS self-host case)', () => {
    expect(isInsecurePublicServerUrl('http://localhost:3001')).toBe(false);
    expect(isInsecurePublicServerUrl('http://127.0.0.1:3001')).toBe(false);
    expect(isInsecurePublicServerUrl('http://10.0.0.5:3001')).toBe(false);
    expect(isInsecurePublicServerUrl('http://192.168.1.10')).toBe(false);
    expect(isInsecurePublicServerUrl('ws://[::1]:3001/rpc')).toBe(false);
  });

  it('returns false for a structurally-invalid URL (caller validates shape)', () => {
    expect(isInsecurePublicServerUrl('not a url')).toBe(false);
    expect(isInsecurePublicServerUrl('')).toBe(false);
  });

  it('SECURITY: refuses plaintext to a public host wearing a private-looking name', () => {
    // The core F2 regression — the POST and the WS dial both route here, so
    // this one assertion guards the whole plaintext-injection surface.
    expect(isInsecurePublicServerUrl('http://127.0.0.1.evil.com')).toBe(true);
    expect(isInsecurePublicServerUrl('http://127.0.0.1.evil.com:3001/auth/pair')).toBe(true);
    expect(isInsecurePublicServerUrl('ws://10.evil.com/rpc')).toBe(true);
  });

  it('allows plaintext to the topologies the narrow guard used to refuse', () => {
    // ⛔ EVERY ONE OF THESE WAS A FALSE REFUSAL, and the first two are how a
    //   Mac / Avahi box and a Tailscale peer are ordinarily addressed. The
    //   bridge refused them while the webclient paired the same server fine.
    expect(isInsecurePublicServerUrl('http://myserver.local:7717')).toBe(false);
    expect(isInsecurePublicServerUrl('http://100.101.102.103:7717')).toBe(false);
    expect(isInsecurePublicServerUrl('http://169.254.10.5:7717')).toBe(false);
    expect(isInsecurePublicServerUrl('ws://nas.local:7717/ws')).toBe(false);
  });

  it('SECURITY: the widening did not admit the case the guard exists for', () => {
    // The one refusal that was always correct, plus the two near-misses the
    // new ranges could have leaked: a public 100.x and a `.local` infix.
    expect(isInsecurePublicServerUrl('http://recued.example.com:7717')).toBe(true);
    expect(isInsecurePublicServerUrl('http://100.0.0.1:7717')).toBe(true);
    expect(isInsecurePublicServerUrl('http://evil.local.attacker.com')).toBe(true);
    expect(isInsecurePublicServerUrl('https://recued.example.com')).toBe(false);
  });
});
