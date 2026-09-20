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
  resolveProDdnsHostIn,
  type DdnsZone,
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

describe('\u26d4 D-176 \u2014 a NESTED zone suffix must not blacklist itself', () => {
  // The registry invites this: "additional zones are pure config \u2014 add an
  // entry \u2026 no code change". A sub-zone of a domain already listed
  // (`.eu.recued.net` for residency, `.stg.recued.net` to stop staging sharing
  // the production zone) is the CHEAPER expansion than a new registrable
  // domain \u2014 no purchase, no delegation, no extra cert.
  const PARENT: DdnsZone =
    { suffix: '.recued.net', label: 'net', default: true, enabled: true };
  const NESTED: DdnsZone =
    { suffix: '.eu.recued.net', label: 'eu', default: false, enabled: true };

  // \u26d4\u26d4 ORDER IS THE WHOLE POINT, so both orders are driven. The loop used to
  // `return null` on a multi-label prefix: with the parent FIRST \u2014 what you
  // get by APPENDING \u2014 `alice.eu.recued.net` matched `.recued.net`, yielded
  // `alice.eu`, and returned before the nested zone was tried. The entire
  // sub-zone went dark, and silently: null \u2192 `isProDdnsHost` false \u2192 the
  // redirect handler treats the host as not-Pro-DDNS, with no error anywhere.
  for (const [name, zones] of [
    ['parent listed first (the append order)', [PARENT, NESTED]],
    ['nested listed first', [NESTED, PARENT]],
  ] as ReadonlyArray<readonly [string, readonly DdnsZone[]]>) {
    it(`resolves both zones \u2014 ${name}`, () => {
      expect(resolveProDdnsHostIn(zones, 'alice.recued.net'))
        .toMatchObject({ handle: 'alice', zone: { label: 'net' } });
      expect(resolveProDdnsHostIn(zones, 'alice.eu.recued.net'))
        .toMatchObject({ handle: 'alice', zone: { label: 'eu' } });
      expect(resolveProDdnsHostIn(zones, 'bob.eu.recued.net'))
        .toMatchObject({ handle: 'bob', zone: { label: 'eu' } });
    });
  }

  it('still refuses what a multi-label prefix is SUPPOSED to refuse', () => {
    // \u26a0 The mirror failure of this fix: `continue` must not turn into
    // "try harder until something matches". With only the parent enabled,
    // a two-label prefix has no other zone to fall through to and stays null.
    expect(resolveProDdnsHostIn([PARENT], 'a.b.recued.net')).toBeNull();
    expect(resolveProDdnsHostIn([PARENT, NESTED], 'a.b.c.recued.net')).toBeNull();
    expect(resolveProDdnsHostIn([PARENT, NESTED], 'recued.net')).toBeNull();
  });

  it('\u26a0 a nested zone COLLIDES with an existing handle of the same name', () => {
    // I first asserted this was null and was wrong. To the PARENT zone,
    // `eu.recued.net` is simply the handle `eu`, and returning it is correct
    // here \u2014 this function decides Pro-DDNS SHAPE, and its own doc puts
    // handle validity at registration time, not redirect time.
    //
    // \ud83d\udd11 But it names a real prerequisite for ever adding a nested zone: if the
    // handle `eu` is already reserved under `.recued.net`, `.eu.recued.net`
    // gives one name two owners. That gate belongs at handle RESERVATION
    // (reject a handle equal to any zone's first label, and refuse a zone
    // whose first label is a live handle) \u2014 not here, which is why this pins
    // the shape answer rather than asking the resolver to arbitrate.
    expect(resolveProDdnsHostIn([PARENT, NESTED], 'eu.recued.net'))
      .toMatchObject({ handle: 'eu', zone: { label: 'net' } });
  });

  it('the leading dot keeps a match on a LABEL boundary', () => {
    // `.recued.net` must not match `alice.xrecued.net`. This is what makes
    // "at most one zone yields a single-label prefix" true, which is in turn
    // why `continue` is order-independent rather than merely luckier.
    expect(resolveProDdnsHostIn([PARENT], 'alice.xrecued.net')).toBeNull();
  });

  it('the live binding passes the ENABLED registry, not the whole one', () => {
    // `resolveProDdnsHost` is a one-line binding over the core; pin that it
    // filters, so a disabled zone cannot start resolving via the new seam.
    expect(resolveProDdnsHost('alice.recued.cloud')).toBeNull();
    expect(resolveProDdnsHost('alice.recued.net')?.zone.label).toBe('net');
  });
});
