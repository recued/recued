/** D-148 follow-up #7 + D-176 — bare-302 root redirect substrate + multi-domain
 *  DDNS zone registry (contract).
 *
 *  Tests the DDNS zone registry, the `resolveProDdnsHost` / `isProDdnsHost`
 *  boundary predicates, and the closed `ROOT_REDIRECT_TARGET` that the handler
 *  factory (in `backend/server/`) and the path-router's bare-`/` carve-out
 *  depend on. */

import { describe, expect, it } from 'vitest';
import {
  DDNS_ZONES,
  defaultDdnsZone,
  ROOT_REDIRECT_TARGET,
  isProDdnsHost,
  resolveProDdnsHost,
} from '../network.js';

describe('D-176 — DDNS zone registry', () => {
  it('declares exactly one default zone, and it is `.recued.net`', () => {
    expect(DDNS_ZONES.filter((z) => z.default)).toHaveLength(1);
    expect(defaultDdnsZone().suffix).toBe('.recued.net');
    expect(defaultDdnsZone().label).toBe('net');
  });

  it('the default zone is enabled', () => {
    expect(defaultDdnsZone().enabled).toBe(true);
  });
});

describe('D-148 FU#7 — closed-list constants', () => {
  it('ROOT_REDIRECT_TARGET is the bare app.recued.com root with no path/query/fragment', () => {
    expect(ROOT_REDIRECT_TARGET).toBe('https://app.recued.com/');
    // Explicit no-leak ratchet: target string must NOT contain a query
    // string, fragment, or any handle-bearing parameter. Catches future
    // accidental edits that would re-introduce the leak.
    expect(ROOT_REDIRECT_TARGET).not.toContain('?');
    expect(ROOT_REDIRECT_TARGET).not.toContain('#');
    expect(ROOT_REDIRECT_TARGET).not.toContain('handle');
    expect(ROOT_REDIRECT_TARGET).not.toContain('pair');
  });

  it('target is HTTPS — never falls back to a cleartext scheme', () => {
    expect(ROOT_REDIRECT_TARGET.startsWith('https://')).toBe(true);
  });
});

describe('D-176 — isProDdnsHost predicate (enabled-zone aware)', () => {
  it('matches a canonical single-label handle subdomain of the default zone', () => {
    expect(isProDdnsHost('alice.recued.net')).toBe(true);
  });

  it('matches with an explicit :port suffix', () => {
    expect(isProDdnsHost('alice.recued.net:443')).toBe(true);
    expect(isProDdnsHost('alice.recued.net:8443')).toBe(true);
  });

  it('is case-insensitive on the hostname (DNS RFC 1035)', () => {
    expect(isProDdnsHost('Alice.Recued.Net')).toBe(true);
    expect(isProDdnsHost('ALICE.RECUED.NET:443')).toBe(true);
  });

  it('rejects a DISABLED zone suffix — `.recued.cloud` is registered-but-off', () => {
    // D-176: only ENABLED zones match. recued.cloud is reserved for a future
    // re-enable; until then a handle under it is NOT a Pro DDNS host.
    expect(isProDdnsHost('alice.recued.cloud')).toBe(false);
  });

  it('rejects the bare apex `recued.net` (no handle prefix)', () => {
    expect(isProDdnsHost('recued.net')).toBe(false);
    expect(isProDdnsHost('recued.net:443')).toBe(false);
  });

  it('rejects multi-label subdomains under the zone', () => {
    expect(isProDdnsHost('a.b.recued.net')).toBe(false);
    expect(isProDdnsHost('admin.alice.recued.net')).toBe(false);
  });

  it('rejects BYO custom domains', () => {
    expect(isProDdnsHost('recued.example.com')).toBe(false);
    expect(isProDdnsHost('mary.example.org')).toBe(false);
  });

  it('rejects app.recued.com (different TLD)', () => {
    expect(isProDdnsHost('app.recued.com')).toBe(false);
  });

  it('rejects bare IPv4 / IPv6 / localhost', () => {
    expect(isProDdnsHost('127.0.0.1')).toBe(false);
    expect(isProDdnsHost('127.0.0.1:8443')).toBe(false);
    expect(isProDdnsHost('localhost')).toBe(false);
    expect(isProDdnsHost('localhost:8443')).toBe(false);
    expect(isProDdnsHost('[::1]:443')).toBe(false);
  });

  it('rejects nullish / empty / whitespace-only inputs', () => {
    expect(isProDdnsHost(undefined)).toBe(false);
    expect(isProDdnsHost(null)).toBe(false);
    expect(isProDdnsHost('')).toBe(false);
    expect(isProDdnsHost('   ')).toBe(false);
  });

  it('rejects substring spoofs that contain the suffix but do not end with it', () => {
    expect(isProDdnsHost('alice.recued.net.evil.com')).toBe(false);
    expect(isProDdnsHost('alice.recued.net.evil.com:443')).toBe(false);
  });

  it('rejects names that look like the suffix without the leading label', () => {
    expect(isProDdnsHost('.recued.net')).toBe(false);
  });

  it('accepts handle with embedded hyphens (structural shape only)', () => {
    // Predicate itself doesn't validate handle format — only the
    // "single-label subdomain of an enabled zone" structural shape.
    expect(isProDdnsHost('mary-team.recued.net')).toBe(true);
    expect(isProDdnsHost('m9.recued.net')).toBe(true);
  });

  it('trims surrounding whitespace before matching', () => {
    // Defensive — production node `req.headers.host` rarely has padding,
    // but some upstream reverse proxies / WAFs may pass odd values.
    expect(isProDdnsHost('  alice.recued.net  ')).toBe(true);
  });
});

describe('D-176 — resolveProDdnsHost returns { handle, zone }', () => {
  it('extracts the handle + matched zone for an enabled-zone host', () => {
    const resolved = resolveProDdnsHost('alice.recued.net:443');
    expect(resolved?.handle).toBe('alice');
    expect(resolved?.zone.suffix).toBe('.recued.net');
  });

  it('returns null for a disabled zone, apex, multi-label, and BYO', () => {
    expect(resolveProDdnsHost('alice.recued.cloud')).toBeNull();
    expect(resolveProDdnsHost('recued.net')).toBeNull();
    expect(resolveProDdnsHost('a.b.recued.net')).toBeNull();
    expect(resolveProDdnsHost('mary.example.org')).toBeNull();
  });
});
