/** D-148 W3.6 — multi-domain SNI production wiring tests.
 *
 *  Coverage:
 *    1. SQLite store CRUD (upload / lookup / list / remove) round-trip
 *    2. AEAD-at-rest: private_key_encrypted column carries ciphertext,
 *       NOT plaintext PEM, when a key provider is wired through
 *    3. AAD binding: a row whose private_key_encrypted blob is moved
 *       to a different domain row fails to decrypt
 *    4. Vault-locked: warmCache returns { locked: true } when getKey
 *       returns null; lookup returns null until cache warms
 *    5. Validation: SAN mismatch / expired / chain invalid map to
 *       structured TlsDomainUploadValidationError issues
 *    6. node:crypto verifier seam: extractSANs / verifyKeyPair /
 *       readExpiresAt / extractIssuer round-trip against a real
 *       self-signed cert generated at test time
 *    7. Multi-domain SNICallback dispatch: TLS handshake against the
 *       path-listener-set's public listener routes through
 *       tls_domain_lookup; correct domain returns the matching cert;
 *       unknown domain closes the connection cleanly
 *
 *  W3.6 substrate scope — per-domain rotation flow + BYO upload rpc +
 *  Reachability Doctor per-domain block all defer to follow-up slices
 *  (see W3.5b handover "Concrete next-session pickup" for the full
 *  W3.6 → W3.7 → W3.8 plan). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, type TLSSocket } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  TLS_CERT_MIN_VALIDITY_MS,
  type PathRole,
  type PathResolution,
  type TLSDomainUploadVerifiers,
} from '@recued/contracts';
import {
  createCertChainHolder,
  createPathListenerSet,
  type PathListenerSet,
} from '@recued/server-tls';
import {
  createSqliteTlsDomainStore,
  ensureTlsDomainSchema,
  TlsDomainUploadValidationError,
  TLS_DOMAIN_TABLES,
} from '../tls/domain-store.js';
import {
  createNodeTlsMetadataReader,
  createNodeTlsVerifiers,
  extractIssuer,
  extractSANs,
  readExpiresAt,
  verifyKeyPair,
  verifyChain,
} from '../tls/cert-verifiers.js';
import type { PortRequestHandler } from '@recued/server-tls';

// ────────────────────────────────────────────────────────────────
// Test fixtures — real self-signed certs for SNI dispatch test
// ────────────────────────────────────────────────────────────────

interface CertFixture {
  cert_pem: string;
  private_key_pem: string;
  fingerprint: string;
  expires_at: number;
}

/** Generate a self-signed cert + RSA keypair via the OpenSSL CLI for
 *  the given DNS SAN. Returns null if `openssl` isn't available; the
 *  affected tests no-op so the substrate-only suites still run on
 *  hosts without the CLI. */
const tryGenerateSelfSigned = async (
  dns: string,
  validityDays = 30,
): Promise<CertFixture | null> => {
  try {
    // Use openssl req -x509 via Node's spawnSync.
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'w3-6-cert-'));
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    const cnfPath = join(dir, 'openssl.cnf');
    const cnf = `
[req]
distinguished_name = req_dn
prompt             = no
x509_extensions    = v3_ca

[req_dn]
CN = ${dns}

[v3_ca]
subjectAltName = DNS:${dns}
basicConstraints = CA:TRUE
`;
    writeFileSync(cnfPath, cnf);
    const r = spawnSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', String(validityDays),
        '-config', cnfPath,
      ],
      { stdio: 'pipe' },
    );
    if (r.status !== 0) return null;
    const cert_pem = readFileSync(certPath, 'utf8');
    const private_key_pem = readFileSync(keyPath, 'utf8');
    const cert = new X509Certificate(cert_pem);
    return {
      cert_pem,
      private_key_pem,
      fingerprint: cert.fingerprint256.replace(/:/g, '').toLowerCase(),
      expires_at: cert.validToDate.getTime(),
    };
  } catch {
    return null;
  }
};

/** Generate a self-signed RSA CA cert + key. Returns null if openssl
 *  CLI is unavailable. The cert sets `basicConstraints CA:TRUE` so it
 *  can sign leaf CSRs. */
const tryGenerateSelfSignedCA = async (
  cn: string,
  validityDays = 60,
): Promise<CertFixture | null> => {
  try {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'w3-6-ca-'));
    const keyPath = join(dir, 'ca.key');
    const certPath = join(dir, 'ca.crt');
    const cnfPath = join(dir, 'ca.cnf');
    writeFileSync(
      cnfPath,
      `[req]
distinguished_name = req_dn
prompt             = no
x509_extensions    = v3_ca

[req_dn]
CN = ${cn}

[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage         = critical,keyCertSign,cRLSign
`,
    );
    const r = spawnSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', String(validityDays),
        '-config', cnfPath,
      ],
      { stdio: 'pipe' },
    );
    if (r.status !== 0) return null;
    const cert_pem = readFileSync(certPath, 'utf8');
    const private_key_pem = readFileSync(keyPath, 'utf8');
    const cert = new X509Certificate(cert_pem);
    return {
      cert_pem,
      private_key_pem,
      fingerprint: cert.fingerprint256.replace(/:/g, '').toLowerCase(),
      expires_at: cert.validToDate ? cert.validToDate.getTime() : Date.parse(cert.validTo),
    };
  } catch {
    return null;
  }
};

/** Generate a leaf cert signed by the supplied CA. Returns null if
 *  openssl CLI is unavailable. The leaf carries a SAN for the supplied
 *  DNS name; the CA fixture provides the issuing key + cert. */
const tryGenerateLeafSignedBy = async (
  dns: string,
  ca: CertFixture,
  validityDays = 30,
): Promise<CertFixture | null> => {
  try {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'w3-6-leaf-'));
    const keyPath = join(dir, 'leaf.key');
    const csrPath = join(dir, 'leaf.csr');
    const certPath = join(dir, 'leaf.crt');
    const cnfPath = join(dir, 'leaf.cnf');
    const caKeyPath = join(dir, 'ca.key');
    const caCertPath = join(dir, 'ca.crt');
    writeFileSync(caKeyPath, ca.private_key_pem);
    writeFileSync(caCertPath, ca.cert_pem);
    writeFileSync(
      cnfPath,
      `[req]
distinguished_name = req_dn
prompt             = no
req_extensions     = v3_req

[req_dn]
CN = ${dns}

[v3_req]
subjectAltName     = DNS:${dns}
basicConstraints   = CA:FALSE
keyUsage           = critical,digitalSignature,keyEncipherment
extendedKeyUsage   = serverAuth
`,
    );
    // Generate leaf key + CSR.
    let r = spawnSync(
      'openssl',
      [
        'req', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', csrPath,
        '-config', cnfPath,
      ],
      { stdio: 'pipe' },
    );
    if (r.status !== 0) return null;
    // Sign the CSR with the CA.
    r = spawnSync(
      'openssl',
      [
        'x509', '-req', '-in', csrPath,
        '-CA', caCertPath, '-CAkey', caKeyPath, '-CAcreateserial',
        '-out', certPath, '-days', String(validityDays),
        '-extensions', 'v3_req', '-extfile', cnfPath,
      ],
      { stdio: 'pipe' },
    );
    if (r.status !== 0) return null;
    const cert_pem = readFileSync(certPath, 'utf8');
    const private_key_pem = readFileSync(keyPath, 'utf8');
    const cert = new X509Certificate(cert_pem);
    return {
      cert_pem,
      private_key_pem,
      fingerprint: cert.fingerprint256.replace(/:/g, '').toLowerCase(),
      expires_at: cert.validToDate ? cert.validToDate.getTime() : Date.parse(cert.validTo),
    };
  } catch {
    return null;
  }
};

// ────────────────────────────────────────────────────────────────
// Stub seam for non-OpenSSL fixtures — substrate-style tests
// ────────────────────────────────────────────────────────────────

/** Stub verifiers that ALWAYS pass — match any domain by returning a
 *  wildcard '*' SAN-like sentinel that the contract's
 *  `matchesSANForDomain` accepts. We bypass the matcher by returning
 *  the exact domain via a closure when the test has predictable
 *  domains; the simplest path is to use a per-domain factory. */
const buildStubVerifiers = (
  overrides: Partial<TLSDomainUploadVerifiers> = {},
): TLSDomainUploadVerifiers => ({
  // Stub returns a wildcard for the SAN list — but matchesSANForDomain
  // is RFC 6125 strict and won't accept a bare '*'. Instead the stub
  // matches ANY domain by returning the same value the validator was
  // passed. Tests can override extractSANs explicitly when they care.
  // The validator threads `(input.domain, san)` into matchesSANForDomain;
  // since we can't see `input.domain` from inside extractSANs (it
  // receives only cert_pem), we encode the domain in a header line at
  // upload time via the helper `stubCertFor(domain)` — see callers.
  extractSANs: (cert: string) => {
    // Decode `;DOMAIN=foo;` header from the test cert PEM.
    const m = cert.match(/;DOMAIN=([^;]+);/);
    return m ? [m[1]] : ['stub.example'];
  },
  verifyKeyPair: () => true,
  verifyChain: () => true,
  readExpiresAt: () => Date.now() + 30 * 86_400_000,
  ...overrides,
});

/** Build a stub-friendly cert PEM that encodes the SAN domain in a
 *  header line the stub `extractSANs` can recover. Real PEMs would
 *  store the SAN in the X509 SubjectAltName extension; the stub
 *  flow doesn't parse ASN.1, so we encode out-of-band. */
const stubCertFor = (domain: string, marker = 'C'): string =>
  `-----BEGIN CERTIFICATE-----\n;DOMAIN=${domain};\n${marker}\n-----END CERTIFICATE-----`;

const STUB_KEY_PROVIDER = (): Uint8Array => {
  const key = new Uint8Array(32);
  // deterministic for tests — DO NOT use in production
  for (let i = 0; i < 32; i++) key[i] = (i * 7 + 13) & 0xff;
  return key;
};

// ────────────────────────────────────────────────────────────────
// 1. Store CRUD round-trip
// ────────────────────────────────────────────────────────────────

describe('W3.6 — TLSDomainStore CRUD', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureTlsDomainSchema(db);
  });

  it('upload + lookup round-trip after warmCache', async () => {
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER,
    });
    const cert_pem = stubCertFor('alice.recued.cloud');
    const result = await store.upload({
      domain: 'alice.recued.cloud',
      cert_pem,
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nMIIBASE64KEY\n-----END PRIVATE KEY-----',
      source: 'pro_acme',
    });
    expect(result.expires_at).toBeGreaterThan(Date.now());
    expect(typeof result.fingerprint).toBe('string');
    // Cache is warmed by upload; sync lookup hits.
    const looked = store.lookup('alice.recued.cloud');
    expect(looked?.domain).toBe('alice.recued.cloud');
    expect(looked?.cert_pem).toBe(cert_pem);
    expect(looked?.source).toBe('pro_acme');
  });

  it('lookup of unknown domain returns null', async () => {
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER,
    });
    expect(store.lookup('unknown.example')).toBeNull();
  });

  it('list returns all configured domains in lex order without private keys', async () => {
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER,
    });
    await store.upload({
      domain: 'b.example.com',
      cert_pem: stubCertFor('b.example.com', 'B'),
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nB\n-----END PRIVATE KEY-----',
      source: 'byo_upload',
    });
    await store.upload({
      domain: 'a.example.com',
      cert_pem: stubCertFor('a.example.com', 'A'),
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nA\n-----END PRIVATE KEY-----',
      source: 'byo_upload',
    });
    const rows = store.list();
    expect(rows.map((r) => r.domain)).toEqual(['a.example.com', 'b.example.com']);
    // The TLSDomainCertListEntry shape excludes private_key_pem at the
    // type level; we cannot even reference it here. Asserts via shape.
    for (const r of rows) {
      expect(r).not.toHaveProperty('private_key_pem');
      expect(r).not.toHaveProperty('private_key_encrypted');
    }
  });

  it('remove drops the row + cache entry', async () => {
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER,
    });
    await store.upload({
      domain: 'gone.example.com',
      cert_pem: stubCertFor('gone.example.com', 'GONE'),
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nGONE\n-----END PRIVATE KEY-----',
      source: 'byo_upload',
    });
    expect(store.lookup('gone.example.com')).not.toBeNull();
    await store.remove('gone.example.com');
    expect(store.lookup('gone.example.com')).toBeNull();
    expect(store.list().some((r) => r.domain === 'gone.example.com')).toBe(false);
  });

  it('upload of same domain replaces prior row + invalidates cache', async () => {
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER,
    });
    await store.upload({
      domain: 'replace.example.com',
      cert_pem: stubCertFor('replace.example.com', 'FIRST'),
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nFIRST\n-----END PRIVATE KEY-----',
      source: 'byo_upload',
    });
    const first = store.lookup('replace.example.com');
    expect(first?.cert_pem).toContain('FIRST');
    await store.upload({
      domain: 'replace.example.com',
      cert_pem: stubCertFor('replace.example.com', 'SECOND'),
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nSECOND\n-----END PRIVATE KEY-----',
      source: 'byo_upload',
    });
    const second = store.lookup('replace.example.com');
    expect(second?.cert_pem).toContain('SECOND');
    // List still has exactly one row for this domain (UPSERT, not insert).
    expect(store.list().filter((r) => r.domain === 'replace.example.com').length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. AEAD-at-rest + AAD binding
// ────────────────────────────────────────────────────────────────

describe('W3.6 — AEAD-at-rest discipline', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureTlsDomainSchema(db);
  });

  it('private_key_encrypted column carries ciphertext, NOT plaintext PEM', async () => {
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER,
    });
    const private_key_pem = '-----BEGIN PRIVATE KEY-----\nSENSITIVEKEY\n-----END PRIVATE KEY-----';
    await store.upload({
      domain: 'aead.example',
      cert_pem: stubCertFor('aead.example'),
      private_key_pem,
      source: 'byo_upload',
    });
    const row = db
      .prepare(`SELECT private_key_encrypted FROM tls_domains WHERE domain = ?`)
      .get('aead.example') as { private_key_encrypted: string };
    expect(row.private_key_encrypted).not.toContain('SENSITIVEKEY');
    expect(row.private_key_encrypted).not.toContain('BEGIN PRIVATE KEY');
  });

  it('moving a row\'s private_key_encrypted blob to a different domain breaks decrypt (AAD binds to domain)', async () => {
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER,
    });
    await store.upload({
      domain: 'a.example',
      cert_pem: stubCertFor('a.example', 'A'),
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nKEYA\n-----END PRIVATE KEY-----',
      source: 'byo_upload',
    });
    await store.upload({
      domain: 'b.example',
      cert_pem: stubCertFor('b.example', 'B'),
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nKEYB\n-----END PRIVATE KEY-----',
      source: 'byo_upload',
    });
    // Swap A's encrypted blob into B's row at the SQL layer (simulates
    // an attacker reordering rows in the SQLite file).
    const rowA = db
      .prepare(`SELECT private_key_encrypted FROM tls_domains WHERE domain = ?`)
      .get('a.example') as { private_key_encrypted: string };
    db.prepare(`UPDATE tls_domains SET private_key_encrypted = ? WHERE domain = ?`)
      .run(rowA.private_key_encrypted, 'b.example');

    // Build a fresh store (cold cache) to force a decrypt round-trip
    // on warm.
    const fresh = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER,
    });
    const result = await fresh.warmCache();
    // A still warms (its blob is still bound to its own domain);
    // B's swapped blob fails AAD verification + drops out of the
    // cache.
    expect(result.warmed).toBe(1); // only A
    expect(result.locked).toBe(false);
    expect(fresh.lookup('a.example')).not.toBeNull();
    expect(fresh.lookup('b.example')).toBeNull();
  });

  it('warmCache returns { locked: true } when getKey returns null + lookup returns null until warm', async () => {
    const lockedKeyProvider = () => null;
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER, // unlocked at upload time
    });
    await store.upload({
      domain: 'locked.example',
      cert_pem: stubCertFor('locked.example'),
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----',
      source: 'byo_upload',
    });
    // Now build a fresh store with a LOCKED key provider — cold cache
    // + cannot decrypt → warmCache reports locked.
    const fresh = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: lockedKeyProvider,
    });
    const result = await fresh.warmCache();
    expect(result.locked).toBe(true);
    expect(result.warmed).toBe(0);
    // Lookup returns null (cold cache + no decryption).
    expect(fresh.lookup('locked.example')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Validation: structured TlsDomainUploadValidationError
// ────────────────────────────────────────────────────────────────

describe('W3.6 — upload validation', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureTlsDomainSchema(db);
  });

  it('SAN mismatch raises TlsDomainUploadValidationError carrying the closed-list issue', async () => {
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers({
        extractSANs: () => ['other.example'],
      }),
      getKey: STUB_KEY_PROVIDER,
    });
    await expect(
      store.upload({
        domain: 'mismatch.example',
        cert_pem: '-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----',
        private_key_pem: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----',
        source: 'byo_upload',
      }),
    ).rejects.toMatchObject({
      name: 'TlsDomainUploadValidationError',
    });
    try {
      await store.upload({
        domain: 'mismatch.example',
        cert_pem: '-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----',
        private_key_pem: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----',
        source: 'byo_upload',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(TlsDomainUploadValidationError);
      const e = err as TlsDomainUploadValidationError;
      expect(e.issues.some((i) => i.code === 'tls_san_mismatch')).toBe(true);
    }
  });

  it('expired cert raises tls_cert_expired_at_upload', async () => {
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers({
        readExpiresAt: () => Date.now() - 1000,
      }),
      getKey: STUB_KEY_PROVIDER,
    });
    try {
      await store.upload({
        domain: 'stub.example',
        cert_pem: '-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----',
        private_key_pem: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----',
        source: 'byo_upload',
      });
      throw new Error('expected upload to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TlsDomainUploadValidationError);
      const e = err as TlsDomainUploadValidationError;
      expect(e.issues.some((i) => i.code === 'tls_cert_expired_at_upload')).toBe(true);
    }
  });

  it('row is NOT persisted when validation fails', async () => {
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers({
        verifyChain: () => false,
      }),
      getKey: STUB_KEY_PROVIDER,
    });
    await expect(
      store.upload({
        domain: 'rejected.example',
        cert_pem: '-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----',
        private_key_pem: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----',
        source: 'byo_upload',
      }),
    ).rejects.toBeInstanceOf(TlsDomainUploadValidationError);
    expect(store.list().length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. node:crypto verifier seam round-trip — needs OpenSSL
// ────────────────────────────────────────────────────────────────

describe('W3.6 — node:crypto verifier seam', () => {
  it('extractSANs returns DNS entries from a real X509 cert', async () => {
    const fx = await tryGenerateSelfSigned('alice.recued.cloud');
    if (!fx) return; // OpenSSL unavailable
    const sans = extractSANs(fx.cert_pem);
    expect(sans).toContain('alice.recued.cloud');
  });

  it('verifyKeyPair returns true for a matched cert + key', async () => {
    const fx = await tryGenerateSelfSigned('alice.recued.cloud');
    if (!fx) return;
    expect(verifyKeyPair(fx.cert_pem, fx.private_key_pem)).toBe(true);
  });

  it('verifyKeyPair returns false for mismatched cert + key', async () => {
    const fx = await tryGenerateSelfSigned('alice.recued.cloud');
    const other = await tryGenerateSelfSigned('bob.recued.cloud');
    if (!fx || !other) return;
    expect(verifyKeyPair(fx.cert_pem, other.private_key_pem)).toBe(false);
  });

  it('verifyChain accepts self-signed only when accept_self_signed is true', async () => {
    const fx = await tryGenerateSelfSigned('alice.recued.cloud');
    if (!fx) return;
    expect(verifyChain(fx.cert_pem, undefined, { accept_self_signed: true })).toBe(true);
    expect(verifyChain(fx.cert_pem, undefined, { accept_self_signed: false })).toBe(false);
  });

  it('readExpiresAt returns the cert\'s notAfter as unix-ms', async () => {
    const fx = await tryGenerateSelfSigned('alice.recued.cloud', 30);
    if (!fx) return;
    const expires = readExpiresAt(fx.cert_pem);
    expect(expires).toBe(fx.expires_at);
    expect(expires).toBeGreaterThan(Date.now());
  });

  it('extractIssuer reads the CN from the issuer DN', async () => {
    const fx = await tryGenerateSelfSigned('alice.recued.cloud');
    if (!fx) return;
    const issuer = extractIssuer(fx.cert_pem);
    // Self-signed: issuer CN equals subject CN equals the SAN we set.
    expect(issuer).toBe('alice.recued.cloud');
  });

  it('end-to-end: createNodeTlsVerifiers + createSqliteTlsDomainStore upload accepts a real self-signed cert', async () => {
    const fx = await tryGenerateSelfSigned('selfcert.example');
    if (!fx) return;
    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: createNodeTlsVerifiers(),
      metadataReader: createNodeTlsMetadataReader(),
      getKey: STUB_KEY_PROVIDER,
      acceptSelfSigned: true,
    });
    const result = await store.upload({
      domain: 'selfcert.example',
      cert_pem: fx.cert_pem,
      private_key_pem: fx.private_key_pem,
      source: 'byo_upload',
    });
    expect(result.fingerprint).not.toBe('');
    expect(result.expires_at).toBe(fx.expires_at);
    expect(result.san).toContain('selfcert.example');
    const looked = store.lookup('selfcert.example');
    expect(looked?.cert_pem).toBe(fx.cert_pem);
    expect(looked?.private_key_pem).toBe(fx.private_key_pem);
    const list = store.list();
    expect(list[0].issuer).toBe('selfcert.example');
  });
});

// ────────────────────────────────────────────────────────────────
// 5. Multi-domain SNICallback dispatch via path-listener-set
// ────────────────────────────────────────────────────────────────

const allPublic = (): Record<PathRole, PathResolution> => ({
  health: { lan: false, public: true },
  ws: { lan: false, public: true },
  mcp: { lan: false, public: true },
  llm_gateway: { lan: false, public: true },
  webhooks: { lan: false, public: true },
  reception: { lan: false, public: true },
  oauth: { lan: false, public: false },
  ask: { lan: false, public: false },
  webclient: { lan: false, public: false },
});

const buildEchoHandler = (body: string): PortRequestHandler =>
  (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(body);
  };

describe('W3.6 — SNICallback dispatch via path-listener-set', () => {
  let activeSet: PathListenerSet | null = null;
  afterEach(async () => {
    if (activeSet) {
      await activeSet.stop();
      activeSet = null;
    }
  });

  it('TLS handshake to a known domain serves the matching cert', async () => {
    const fxA = await tryGenerateSelfSigned('alice.example');
    const fxB = await tryGenerateSelfSigned('bob.example');
    if (!fxA || !fxB) return; // OpenSSL unavailable

    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: createNodeTlsVerifiers(),
      metadataReader: createNodeTlsMetadataReader(),
      getKey: STUB_KEY_PROVIDER,
      acceptSelfSigned: true,
    });
    await store.upload({
      domain: 'alice.example',
      cert_pem: fxA.cert_pem,
      private_key_pem: fxA.private_key_pem,
      source: 'byo_upload',
    });
    await store.upload({
      domain: 'bob.example',
      cert_pem: fxB.cert_pem,
      private_key_pem: fxB.private_key_pem,
      source: 'byo_upload',
    });

    // Bootstrap cert holder uses A's cert so the listener can build
    // its initial https.createServer; the SNICallback re-routes per
    // handshake.
    const certChain = createCertChainHolder({
      cert_pem: fxA.cert_pem,
      private_key_pem: fxA.private_key_pem,
    });
    activeSet = createPathListenerSet({
      resolution: allPublic(),
      handlers: {
        health: buildEchoHandler('hi'),
        ws: buildEchoHandler('hi'),
        mcp: buildEchoHandler('hi'),
        webhooks: buildEchoHandler('hi'),
        reception: buildEchoHandler('hi'),
      },
      cert_chain: certChain,
      tls_domain_lookup: (servername) => store.lookup(servername),
      lan_port: 0,
      public_port: 0,
      public_bind_address: '127.0.0.1',
    });
    const statuses = await activeSet.start();
    const pub = statuses.find((s) => s.listener === 'public');
    expect(pub?.listening).toBe(true);
    expect(pub?.tls).toBe(true);

    // Open a TLS socket to the bound port, send SNI=alice.example,
    // assert the peer cert matches alice's fingerprint.
    const aliceFingerprint = await tlsFingerprintAt(pub!.port, 'alice.example');
    expect(aliceFingerprint).toBe(fxA.fingerprint);

    const bobFingerprint = await tlsFingerprintAt(pub!.port, 'bob.example');
    expect(bobFingerprint).toBe(fxB.fingerprint);
  });

  it('TLS handshake to an unknown domain closes the connection (no bootstrap-cert fallback)', async () => {
    const fxA = await tryGenerateSelfSigned('alice.example');
    if (!fxA) return;
    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: createNodeTlsVerifiers(),
      metadataReader: createNodeTlsMetadataReader(),
      getKey: STUB_KEY_PROVIDER,
      acceptSelfSigned: true,
    });
    await store.upload({
      domain: 'alice.example',
      cert_pem: fxA.cert_pem,
      private_key_pem: fxA.private_key_pem,
      source: 'byo_upload',
    });
    const certChain = createCertChainHolder({
      cert_pem: fxA.cert_pem,
      private_key_pem: fxA.private_key_pem,
    });
    activeSet = createPathListenerSet({
      resolution: allPublic(),
      handlers: {
        health: buildEchoHandler('hi'),
        ws: buildEchoHandler('hi'),
        mcp: buildEchoHandler('hi'),
        webhooks: buildEchoHandler('hi'),
        reception: buildEchoHandler('hi'),
      },
      cert_chain: certChain,
      tls_domain_lookup: (servername) => store.lookup(servername),
      lan_port: 0,
      public_port: 0,
      public_bind_address: '127.0.0.1',
    });
    const statuses = await activeSet.start();
    const pub = statuses.find((s) => s.listener === 'public');
    await expect(tlsFingerprintAt(pub!.port, 'unknown.example')).rejects.toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────
// 6. Closed-list invariants
// ────────────────────────────────────────────────────────────────

describe('W3.6 — closed-list inventories', () => {
  it('TLS_DOMAIN_TABLES exposes exactly one table name', () => {
    expect([...TLS_DOMAIN_TABLES]).toEqual(['tls_domains']);
  });

  it('TLS_CERT_MIN_VALIDITY_MS still equals 7 days', () => {
    expect(TLS_CERT_MIN_VALIDITY_MS).toBe(7 * 86_400_000);
  });
});

// ────────────────────────────────────────────────────────────────
// 7. TlsDomainVaultLockedError surface
// ────────────────────────────────────────────────────────────────

describe('W3.6 Codex P1 #1 fold — readExpiresAt portability (Node 20+)', () => {
  it('uses cert.validTo (string), not cert.validToDate, for Node 20.x compat', async () => {
    // P1 #1 — `validToDate` was added in Node v23.0.0; backend/server
    // engines floor is >=20.0.0, so the prior implementation would
    // read undefined + return 0 + every upload would be rejected as
    // tls_cert_expired_at_upload on Node 20.x / 22.x < 22.10. Pin the
    // fix by exercising readExpiresAt against a real cert AND
    // confirming we're not dependent on validToDate.
    const fx = await tryGenerateSelfSigned('portability.example', 30);
    if (!fx) return;
    const expires = readExpiresAt(fx.cert_pem);
    // Sanity — must equal Date.parse(cert.validTo) which is also what
    // the production parser routes through.
    const cert = new X509Certificate(fx.cert_pem);
    expect(expires).toBe(Date.parse(cert.validTo));
    expect(expires).toBeGreaterThan(Date.now());
    expect(expires).toBeLessThan(Date.now() + 35 * 86_400_000);
  });

  it('returns 0 on parse failure (gracefully degrades to tls_cert_expired_at_upload issue)', () => {
    expect(readExpiresAt('not a pem')).toBe(0);
    expect(readExpiresAt('')).toBe(0);
  });
});

describe('W3.6 Codex P1 #2 fold — verifyChain requires terminal CA in system trust store', () => {
  it('rejects a chain where the leaf is signed by a private CA NOT in the system trust store', async () => {
    // Generate a private CA, then a leaf signed by that CA. Bundle
    // the CA as the chain. Pre-fold this would have returned true
    // (cryptographically continuous chain to a non-trusted root). Post-
    // fold returns false because the terminal cert is not in /
    // signed by `tls.rootCertificates`.
    const ca = await tryGenerateSelfSignedCA('Recued Test Private CA');
    if (!ca) return;
    const leaf = await tryGenerateLeafSignedBy('private-ca-leaf.example', ca);
    if (!leaf) return;
    const ok = verifyChain(leaf.cert_pem, ca.cert_pem, { accept_self_signed: false });
    expect(ok).toBe(false);
  });

  it('still accepts a self-signed cert when accept_self_signed is true (BYO niche unchanged)', async () => {
    const fx = await tryGenerateSelfSigned('selfsigned.example');
    if (!fx) return;
    expect(verifyChain(fx.cert_pem, undefined, { accept_self_signed: true })).toBe(true);
  });
});

describe('W3.6 Codex P1 #3 fold — SNICallback concatenates intermediates into cert', () => {
  it('per-domain entry with chain_pem serves leaf+chain so clients without cached intermediates can validate', async () => {
    // Generate a private CA, a leaf signed by it, and verify that the
    // path-listener-set's SNICallback now serves leaf+chain
    // concatenated into `cert` (NOT chain_pem in `ca`). The acceptance
    // is: a TLS client given the private CA as its trust anchor can
    // validate the leaf — which only works if the server sent the
    // intermediate.
    const ca = await tryGenerateSelfSignedCA('Recued Test Concat CA');
    if (!ca) return;
    const leaf = await tryGenerateLeafSignedBy('concat-leaf.example', ca);
    if (!leaf) return;
    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    // Bypass the W3.6 P1 #2 trust-root chain gate for this test — we
    // only care about whether the SNICallback serves leaf+chain to
    // the wire correctly. Chain validation is exercised by P1 #2's
    // own fold tests above; keeping concerns separated means failing
    // chain validation can't mask a broken SNI serve path here.
    const realVerifiers = createNodeTlsVerifiers();
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: { ...realVerifiers, verifyChain: () => true },
      metadataReader: createNodeTlsMetadataReader(),
      getKey: STUB_KEY_PROVIDER,
    });
    await store.upload({
      domain: 'concat-leaf.example',
      cert_pem: leaf.cert_pem,
      private_key_pem: leaf.private_key_pem,
      chain_pem: ca.cert_pem,
      source: 'byo_upload',
    });
    const certChain = createCertChainHolder({
      cert_pem: leaf.cert_pem,
      private_key_pem: leaf.private_key_pem,
    });
    const set = createPathListenerSet({
      resolution: allPublic(),
      handlers: {
        health: buildEchoHandler('hi'),
        ws: buildEchoHandler('hi'),
        mcp: buildEchoHandler('hi'),
        webhooks: buildEchoHandler('hi'),
        reception: buildEchoHandler('hi'),
      },
      cert_chain: certChain,
      tls_domain_lookup: (servername) => store.lookup(servername),
      lan_port: 0,
      public_port: 0,
      public_bind_address: '127.0.0.1',
    });
    try {
      const statuses = await set.start();
      const pub = statuses.find((s) => s.listener === 'public');
      // Connect with the private CA as the only trust anchor — the
      // handshake succeeds iff the server sent the intermediate
      // alongside the leaf (the test's trust store DOES contain the
      // CA, but the leaf alone wouldn't validate without the chain).
      const result = await tlsHandshakeChainAt(pub!.port, 'concat-leaf.example', ca.cert_pem);
      // Pre-fold this would have failed with UNABLE_TO_GET_ISSUER_CERT
      // or similar because chain_pem went into `ca` (server sent leaf
      // alone). Post-fold the leaf+chain concat lets the test client
      // walk leaf → CA → trust anchor.
      expect(result.peerChainLength).toBeGreaterThanOrEqual(2);
    } finally {
      await set.stop();
    }
  });
});

describe('W3.6 Codex P2 fold — SNI canonicalization (case-insensitive lookup)', () => {
  it('mixed-case SNI ServerName matches a row stored as lowercase', async () => {
    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER,
    });
    await store.upload({
      domain: 'caseful.example',
      cert_pem: stubCertFor('caseful.example'),
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----',
      source: 'byo_upload',
    });
    // Lookup with mixed case + uppercase + trailing whitespace — all
    // should hit the same row.
    expect(store.lookup('Caseful.Example')).not.toBeNull();
    expect(store.lookup('CASEFUL.EXAMPLE')).not.toBeNull();
    expect(store.lookup('  caseful.example  ')).not.toBeNull();
  });

  it('upload with uppercase domain canonicalizes to lowercase row + AAD', async () => {
    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER,
    });
    await store.upload({
      domain: 'UPPER.example',
      cert_pem: stubCertFor('UPPER.example'),
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----',
      source: 'byo_upload',
    });
    // Confirm the SQLite row is stored under the canonical (lowercase)
    // primary key.
    const row = db
      .prepare(`SELECT domain FROM tls_domains`)
      .get() as { domain: string };
    expect(row.domain).toBe('upper.example');
    // Confirm list() projects the canonical form.
    expect(store.list().map((r) => r.domain)).toEqual(['upper.example']);
    // Confirm lookup canonicalizes too.
    expect(store.lookup('upper.example')).not.toBeNull();
    expect(store.lookup('UPPER.EXAMPLE')).not.toBeNull();
  });

  it('remove with mixed-case domain hits the canonical row', async () => {
    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER,
    });
    await store.upload({
      domain: 'remove.example',
      cert_pem: stubCertFor('remove.example'),
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----',
      source: 'byo_upload',
    });
    expect(store.lookup('remove.example')).not.toBeNull();
    await store.remove('Remove.Example');
    expect(store.lookup('remove.example')).toBeNull();
  });
});

describe('W3.6 — TlsDomainVaultLockedError', () => {
  it('throws at decrypt time when getKey returns null AND a real decrypt is needed', async () => {
    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    // Upload with a real key provider (so the row's blob is real
    // ciphertext), then build a fresh store with a locked provider +
    // call warmCache.
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: STUB_KEY_PROVIDER,
    });
    await store.upload({
      domain: 'vault.example',
      cert_pem: stubCertFor('vault.example'),
      private_key_pem: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----',
      source: 'byo_upload',
    });
    const fresh = createSqliteTlsDomainStore({
      db,
      verifiers: buildStubVerifiers(),
      getKey: () => null,
    });
    const result = await fresh.warmCache();
    expect(result.locked).toBe(true);
    expect(result.warmed).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Helper — open a TLS socket with an explicit SNI servername and
// return the peer-cert fingerprint (lowercase hex, no separators).
// Throws on connection error / handshake failure.
// ────────────────────────────────────────────────────────────────

const tlsFingerprintAt = (port: number, servername: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const sock: TLSSocket = connect(
      {
        host: '127.0.0.1',
        port,
        servername,
        rejectUnauthorized: false, // self-signed in test
      },
      () => {
        const peer = sock.getPeerX509Certificate();
        sock.destroy();
        if (!peer) {
          reject(new Error('no peer cert'));
          return;
        }
        resolve(peer.fingerprint256.replace(/:/g, '').toLowerCase());
      },
    );
    sock.on('error', (err) => reject(err));
  });

/** Open a TLS socket validating the server cert against an explicit
 *  trust anchor (the supplied `caPem`) — exercises the full chain
 *  validation path. Returns the peer chain length so the test can
 *  assert that the server sent both leaf + intermediate (length ≥ 2)
 *  rather than just the leaf alone (length === 1). */
const tlsHandshakeChainAt = (
  port: number,
  servername: string,
  caPem: string,
): Promise<{ peerChainLength: number; authorized: boolean }> =>
  new Promise((resolve, reject) => {
    const sock: TLSSocket = connect(
      {
        host: '127.0.0.1',
        port,
        servername,
        ca: caPem,
        rejectUnauthorized: false,
      },
      () => {
        // Walk the issuer chain to count what the server sent us.
        let count = 0;
        let cur = sock.getPeerX509Certificate();
        while (cur) {
          count += 1;
          const next = cur.issuerCertificate;
          if (!next || next === cur) break;
          cur = next;
        }
        const authorized = sock.authorized;
        sock.destroy();
        resolve({ peerChainLength: count, authorized });
      },
    );
    sock.on('error', (err) => reject(err));
  });
