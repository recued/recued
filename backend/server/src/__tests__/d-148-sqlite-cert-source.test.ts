/** D-148 § A.6.5 — `createSqliteBackedCertSource` adapter tests.
 *
 *  Verifies the production cert-source adapter that bridges
 *  `SqliteTlsDomainStore` to the `CertSource` interface consumed by the
 *  passport-fetch first-pin path + `tls-cert-renewal` housekeeping.
 *
 *  The defining invariant is the alignment with the webclient's
 *  `selectServerUrl` pick rule — the adapter MUST return the cert bound
 *  to whichever address the receiving client will actually connect to,
 *  or null when nothing in the store matches. A mismatch would seed a
 *  fingerprint the client rejects with `cert_pin_mismatch` on first
 *  handshake.
 *
 *  Spec: D-148 § A.6.5. */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type {
  TLSDomainCertListEntry,
  TLSDomainUploadVerifiers,
} from '@recued/contracts';

import {
  createSqliteBackedCertSource,
  type ServerAddressHintsSnapshot,
} from '../pairing/sqlite-cert-source.js';
import {
  createSqliteTlsDomainStore,
  ensureTlsDomainSchema,
  type SqliteTlsDomainStore,
  type TlsDomainKeyProvider,
} from '../tls/domain-store.js';

// ────────────────────────────────────────────────────────────────
// Scaffolding
// ────────────────────────────────────────────────────────────────

/** Deterministic 32-byte sub-DEK for AEAD round-trips. */
const STUB_KEY: TlsDomainKeyProvider = () => {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = (i * 7 + 13) & 0xff;
  return key;
};

const stubCertFor = (domain: string): string =>
  `-----BEGIN CERTIFICATE-----\n;DOMAIN=${domain};\nCERT_BODY\n-----END CERTIFICATE-----`;

const stubKeyPem = '-----BEGIN PRIVATE KEY-----\nKEY_BODY\n-----END PRIVATE KEY-----';

const stubVerifiers: TLSDomainUploadVerifiers = {
  extractSANs: (cert: string) => {
    const m = cert.match(/;DOMAIN=([^;]+);/);
    return m ? [m[1]!] : ['stub.example'];
  },
  verifyKeyPair: () => true,
  verifyChain: () => true,
  readExpiresAt: () => Date.now() + 90 * 86_400_000,
};

const buildRealStore = (): SqliteTlsDomainStore => {
  const db = new Database(':memory:');
  ensureTlsDomainSchema(db);
  return createSqliteTlsDomainStore({
    db,
    getKey: STUB_KEY,
    verifiers: stubVerifiers,
  });
};

/** Fixed-list stub store — bypasses upload validation so tests can
 *  pin exact fingerprint format / case / edge values. The adapter
 *  only reads `list()`. */
const stubStore = (
  entries: TLSDomainCertListEntry[],
): Pick<SqliteTlsDomainStore, 'list'> => ({
  list: () => entries,
});

const entry = (
  domain: string,
  fingerprint: string,
  expires_at: number,
  source: 'byo_upload' | 'pro_acme' = 'byo_upload',
): TLSDomainCertListEntry => ({
  domain,
  fingerprint,
  expires_at,
  issuer: 'CN=Stub CA',
  source,
});

// ────────────────────────────────────────────────────────────────
// Shape
// ────────────────────────────────────────────────────────────────

describe('createSqliteBackedCertSource — shape', () => {
  it('returns a CertSource-shaped object', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: [] }),
      store: stubStore([]),
    });
    expect(typeof source.getCurrentCert).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────
// Empty / unparseable hint paths
// ────────────────────────────────────────────────────────────────

describe('createSqliteBackedCertSource — null paths', () => {
  it('returns null when LAN is empty and DDNS is absent', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: [] }),
      store: stubStore([entry('alice.example', 'aabbcc', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toBeNull();
  });

  it('returns null when LAN entries are all empty strings and DDNS is absent', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['', ''] }),
      store: stubStore([entry('alice.example', 'aabbcc', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toBeNull();
  });

  it('returns null when DDNS is an empty string', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: [], ddns: '' }),
      store: stubStore([entry('alice.example', 'aabbcc', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toBeNull();
  });

  it('returns null when the chosen URL is malformed (cannot be parsed)', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['not a url'] }),
      store: stubStore([entry('not a url', 'aabbcc', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toBeNull();
  });

  it('returns null when the store is empty', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://alice.example:443/ws'] }),
      store: stubStore([]),
    });
    expect(source.getCurrentCert()).toBeNull();
  });

  it('returns null when no row matches the chosen hostname', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://192.168.1.42:8443/ws'] }),
      store: stubStore([entry('alice.example', 'aabbcc', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Hint precedence — `selectServerUrl` mirror
// ────────────────────────────────────────────────────────────────

describe('createSqliteBackedCertSource — LAN-first alignment', () => {
  it('uses lan[0] when populated, even when DDNS would also match', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({
        lan: ['wss://lan.example:8443/ws'],
        ddns: 'wss://ddns.example:443/ws',
      }),
      store: stubStore([
        entry('lan.example', 'fp-lan', 1_900_000_000_000),
        entry('ddns.example', 'fp-ddns', 2_000_000_000_000),
      ]),
    });
    const result = source.getCurrentCert();
    expect(result).toEqual({
      fingerprint: 'sha256:fp-lan',
      valid_until: 1_900_000_000_000,
    });
  });

  it('skips leading empty LAN entries and uses the first non-empty one', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({
        lan: ['', 'wss://lan2.example:8443/ws'],
        ddns: 'wss://ddns.example:443/ws',
      }),
      store: stubStore([
        entry('lan2.example', 'fp-lan2', 1_950_000_000_000),
        entry('ddns.example', 'fp-ddns', 2_000_000_000_000),
      ]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:fp-lan2',
      valid_until: 1_950_000_000_000,
    });
  });

  it('falls through to DDNS when every LAN entry is empty', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({
        lan: ['', ''],
        ddns: 'wss://ddns.example:443/ws',
      }),
      store: stubStore([
        entry('ddns.example', 'fp-ddns', 2_000_000_000_000),
      ]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:fp-ddns',
      valid_until: 2_000_000_000_000,
    });
  });

  it('returns null when LAN[0] picks an unbound hostname even though DDNS would match', () => {
    // This is the alignment trap the spec warns about — a naive
    // "return any cert in the store" adapter would emit `fp-ddns`,
    // which the receiving client (which connects to lan[0]) would
    // reject with `cert_pin_mismatch`.
    const source = createSqliteBackedCertSource({
      readHints: () => ({
        lan: ['wss://192.168.1.42:8443/ws'],
        ddns: 'wss://ddns.example:443/ws',
      }),
      store: stubStore([entry('ddns.example', 'fp-ddns', 2_000_000_000_000)]),
    });
    expect(source.getCurrentCert()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Hostname extraction edge cases
// ────────────────────────────────────────────────────────────────

describe('createSqliteBackedCertSource — hostname extraction', () => {
  it('lower-cases the SNI hostname to match the store canonicalisation', () => {
    // `SqliteTlsDomainStore` canonicalises domains to lowercase on
    // upload. The adapter must mirror that at lookup time so a hint
    // like `Alice.Example` finds the row stored as `alice.example`.
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://Alice.Example:443/ws'] }),
      store: stubStore([entry('alice.example', 'aa', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:aa',
      valid_until: 1_900_000_000_000,
    });
  });

  it('handles a bare-host URL without a port', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['https://alice.example'] }),
      store: stubStore([entry('alice.example', 'aa', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:aa',
      valid_until: 1_900_000_000_000,
    });
  });

  it('returns null for an IP-only LAN URL when no row covers that IP literal', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://192.168.1.42:8443/ws'] }),
      store: stubStore([entry('alice.example', 'aa', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toBeNull();
  });

  it('uses the IP literal directly when a row covers it (rare BYO setup)', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://192.168.1.42:8443/ws'] }),
      store: stubStore([entry('192.168.1.42', 'fp-ip', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:fp-ip',
      valid_until: 1_900_000_000_000,
    });
  });

  it('handles IPv6 literals (no match expected when row carries a different host)', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://[fe80::1]:8443/ws'] }),
      store: stubStore([entry('alice.example', 'aa', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toBeNull();
  });

  it('strips IPv6 brackets to match the bare-form domain in the store', () => {
    // `URL.hostname` returns `[fe80::1]`; cert SANs + `tls_domains.domain`
    // use the bare form `fe80::1`. The adapter strips one matched pair.
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://[fe80::1]:8443/ws'] }),
      store: stubStore([entry('fe80::1', 'fp-v6-url', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:fp-v6-url',
      valid_until: 1_900_000_000_000,
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Fingerprint format
// ────────────────────────────────────────────────────────────────

describe('createSqliteBackedCertSource — fingerprint format', () => {
  it('prepends `sha256:` when the stored fingerprint is bare hex', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://alice.example:443/ws'] }),
      store: stubStore([entry('alice.example', 'deadbeef', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:deadbeef',
      valid_until: 1_900_000_000_000,
    });
  });

  it('preserves the prefix when the stored fingerprint already carries it', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://alice.example:443/ws'] }),
      store: stubStore([entry('alice.example', 'sha256:abcd1234', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:abcd1234',
      valid_until: 1_900_000_000_000,
    });
  });

  it('returns null when the stored fingerprint is empty', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://alice.example:443/ws'] }),
      store: stubStore([entry('alice.example', '', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toBeNull();
  });

  it('returns null when expires_at is non-finite', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://alice.example:443/ws'] }),
      store: stubStore([entry('alice.example', 'aabbcc', Number.NaN)]),
    });
    expect(source.getCurrentCert()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Hint reader is re-evaluated per call
// ────────────────────────────────────────────────────────────────

describe('createSqliteBackedCertSource — readHints freshness', () => {
  it('observes hint changes between calls (no construction-time capture)', () => {
    let phase = 0;
    const hints: ServerAddressHintsSnapshot[] = [
      { lan: [] },
      { lan: ['wss://alice.example:443/ws'] },
    ];
    const source = createSqliteBackedCertSource({
      readHints: () => hints[phase]!,
      store: stubStore([entry('alice.example', 'aa', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toBeNull();
    phase = 1;
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:aa',
      valid_until: 1_900_000_000_000,
    });
  });
});

// ────────────────────────────────────────────────────────────────
// `selectServerUrl` alignment — cross-check
// ────────────────────────────────────────────────────────────────

describe('createSqliteBackedCertSource — selectServerUrl alignment', () => {
  /** Inline duplicate of `selectServerUrl` from
   *  `apps/webclient/src/auth/pair-input.ts:212` — backend can't import
   *  webclient code, so we mirror it here verbatim and assert the
   *  adapter agrees on every hint shape we care about. */
  const selectServerUrlMirror = (hints: {
    lan: string[];
    ddns?: string;
  }): string | null => {
    for (const lan of hints.lan) {
      if (typeof lan === 'string' && lan.length > 0) return lan;
    }
    if (typeof hints.ddns === 'string' && hints.ddns.length > 0) return hints.ddns;
    return null;
  };

  const cases: Array<{ name: string; hints: { lan: string[]; ddns?: string } }> = [
    { name: 'empty', hints: { lan: [] } },
    { name: 'empty + ddns', hints: { lan: [], ddns: 'wss://d.example' } },
    { name: 'lan only', hints: { lan: ['wss://l.example:443/ws'] } },
    {
      name: 'lan first',
      hints: { lan: ['wss://l.example:443/ws'], ddns: 'wss://d.example' },
    },
    {
      name: 'leading empty lan',
      hints: { lan: ['', 'wss://l2.example:443/ws'], ddns: 'wss://d.example' },
    },
    { name: 'all empty lan', hints: { lan: ['', ''], ddns: 'wss://d.example' } },
  ];

  for (const tc of cases) {
    it(`agrees with selectServerUrl for case: ${tc.name}`, () => {
      const expectedUrl = selectServerUrlMirror(tc.hints);
      const expectedHost = expectedUrl
        ? (() => {
            try {
              return new URL(expectedUrl).hostname.toLowerCase();
            } catch {
              return null;
            }
          })()
        : null;
      const rows: TLSDomainCertListEntry[] = [
        entry('l.example', 'fp-l', 100),
        entry('l2.example', 'fp-l2', 200),
        entry('d.example', 'fp-d', 300),
      ];
      const source = createSqliteBackedCertSource({
        readHints: () => tc.hints,
        store: stubStore(rows),
      });
      const result = source.getCurrentCert();
      if (expectedHost === null) {
        expect(result).toBeNull();
      } else {
        const row = rows.find((r) => r.domain === expectedHost);
        if (row) {
          expect(result).toEqual({
            fingerprint: `sha256:${row.fingerprint}`,
            valid_until: row.expires_at,
          });
        } else {
          expect(result).toBeNull();
        }
      }
    });
  }
});

// ────────────────────────────────────────────────────────────────
// Bare `host:port` parsing (Codex review P2 fold)
// ────────────────────────────────────────────────────────────────

describe('createSqliteBackedCertSource — bare host:port hints', () => {
  it('parses a bare `host:port` LAN hint per the spec example shape', () => {
    // The spec's address-hint examples + the 91st test fixture use
    // `alice.recued.cloud:8443` without a
    // scheme. `new URL()` alone treats `alice.recued.cloud:` as a
    // scheme + `8443` as a path; the adapter retries with a synthetic
    // `wss://` prefix to recover the hostname.
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['alice.recued.cloud:8443'] }),
      store: stubStore([
        entry('alice.recued.cloud', 'fp-bare', 1_900_000_000_000),
      ]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:fp-bare',
      valid_until: 1_900_000_000_000,
    });
  });

  it('parses a bare IPv4 `host:port` LAN hint', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['192.168.1.42:8443'] }),
      store: stubStore([entry('192.168.1.42', 'fp-ip', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:fp-ip',
      valid_until: 1_900_000_000_000,
    });
  });

  it('parses a bare bracketed IPv6 `[host]:port` hint', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['[fe80::1]:8443'] }),
      store: stubStore([entry('fe80::1', 'fp-v6', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:fp-v6',
      valid_until: 1_900_000_000_000,
    });
  });

  it('parses a bare `host:port` DDNS hint when LAN is empty', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: [], ddns: 'alice.recued.cloud:8443' }),
      store: stubStore([
        entry('alice.recued.cloud', 'fp-bare-ddns', 1_950_000_000_000),
      ]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:fp-bare-ddns',
      valid_until: 1_950_000_000_000,
    });
  });

  it('returns null for an unparseable hint (no fallback success)', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['totally not a url'] }),
      store: stubStore([entry('totally', 'fp', 1_900_000_000_000)]),
    });
    expect(source.getCurrentCert()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// `sources` filter (Codex review P2 fold — exclude BYO from auto-renew)
// ────────────────────────────────────────────────────────────────

describe('createSqliteBackedCertSource — sources filter', () => {
  it('omitting `sources` allows any source (pair-blob mint default)', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://alice.example:443/ws'] }),
      store: stubStore([
        entry('alice.example', 'fp-byo', 1_900_000_000_000, 'byo_upload'),
      ]),
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:fp-byo',
      valid_until: 1_900_000_000_000,
    });
  });

  it('`sources: ["pro_acme"]` returns null when matched row is byo_upload', () => {
    // Housekeeping's `tls-cert-renewal` task ships this filter so a
    // user-uploaded BYO cert near expiry doesn't get auto-renewed
    // against the user's hostname (BYO certs rotate via re-upload).
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://alice.example:443/ws'] }),
      store: stubStore([
        entry('alice.example', 'fp-byo', 1_900_000_000_000, 'byo_upload'),
      ]),
      sources: ['pro_acme'],
    });
    expect(source.getCurrentCert()).toBeNull();
  });

  it('`sources: ["pro_acme"]` returns the cert when matched row is pro_acme', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://alice.example:443/ws'] }),
      store: stubStore([
        entry('alice.example', 'fp-acme', 1_900_000_000_000, 'pro_acme'),
      ]),
      sources: ['pro_acme'],
    });
    expect(source.getCurrentCert()).toEqual({
      fingerprint: 'sha256:fp-acme',
      valid_until: 1_900_000_000_000,
    });
  });

  it('`sources: []` rejects every source', () => {
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://alice.example:443/ws'] }),
      store: stubStore([
        entry('alice.example', 'fp-acme', 1_900_000_000_000, 'pro_acme'),
      ]),
      sources: [],
    });
    expect(source.getCurrentCert()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Integration: real `SqliteTlsDomainStore` round-trip
// ────────────────────────────────────────────────────────────────

describe('createSqliteBackedCertSource — real store round-trip', () => {
  it('reads a freshly-uploaded ACME cert and returns the prefixed fingerprint', async () => {
    const store = buildRealStore();
    await store.upload({
      domain: 'alice.example',
      cert_pem: stubCertFor('alice.example'),
      private_key_pem: stubKeyPem,
      source: 'pro_acme',
    });
    const source = createSqliteBackedCertSource({
      readHints: () => ({ lan: ['wss://alice.example:443/ws'] }),
      store,
    });
    const result = source.getCurrentCert();
    expect(result).not.toBeNull();
    expect(result!.fingerprint.startsWith('sha256:')).toBe(true);
    expect(result!.fingerprint.length).toBeGreaterThan('sha256:'.length);
    expect(result!.valid_until).toBeGreaterThan(Date.now());
  });

  it('returns null when the LAN URL points at an IP literal not in the store', async () => {
    const store = buildRealStore();
    await store.upload({
      domain: 'alice.example',
      cert_pem: stubCertFor('alice.example'),
      private_key_pem: stubKeyPem,
      source: 'pro_acme',
    });
    const source = createSqliteBackedCertSource({
      readHints: () => ({
        lan: ['wss://192.168.1.42:8443/ws'],
        ddns: 'wss://alice.example:443/ws',
      }),
      store,
    });
    expect(source.getCurrentCert()).toBeNull();
  });
});
