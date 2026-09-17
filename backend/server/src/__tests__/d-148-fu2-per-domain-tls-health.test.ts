/** D-148 FU2 — per-domain TLS health: the verifier seam + the store read.
 *
 *  Coverage:
 *    1. `verifyDomainHealth` applies the verifier seam + fingerprint helper.
 *       Stubbed deps so the helper is testable without real certs.
 *    2. `SqliteTlsDomainStore.listForHealthCheck()` round-trip: returns rows
 *       with `cert_pem` + `chain_pem` columns; private key NEVER on the row.
 *    3. Source pins: the store's factory really returns `listForHealthCheck`,
 *       and its row type really has no private-key field.
 *
 *  ⛔ THE ROLLUP AND ITS VOCABULARY ARE GONE (2026-09-16). This file used to
 *  test `buildPerDomainTlsHealth` — entries, expiry windows, per-row
 *  recommendations — and to ratchet `REACHABILITY_RECOMMENDATION_CODES`. The
 *  rollup was shaped for `buildReachabilityReport` at every level (its severity
 *  bands, its web-UI copy register, its un-keyed recommendation list), that
 *  report was deleted, and the codes had no emitter once the rollup went. ⇒ The
 *  ratchet was removed WITH the vocabulary rather than left guarding a list
 *  nothing produces — a ratchet with nothing on the other end reads as a shipped
 *  contract.
 *
 *  🔑 WHAT IT PROTECTED SURVIVES SOMEWHERE REAL: the two verified facts
 *  (`chain_valid`, `fingerprint_matches`) are now READ by `recued doctor`,
 *  which computed and discarded them for as long as this file existed. See
 *  `cli-context/doctor.ts`. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  type PathResolution,
  type PathRole,
  type TLSDomainCertSource,
} from '@recued/contracts';
import type { PathListenerStatus } from '@recued/server-tls';
import {
  verifyDomainHealth,
  type SqliteTlsDomainHealthRow,
  type VerifyDomainHealthDeps,
} from '../diagnostics/per-domain-tls-health.js';
import {
  createSqliteTlsDomainStore,
  ensureTlsDomainSchema,
  type SqliteTlsDomainHealthCheckRow,
} from '../tls/domain-store.js';

// ────────────────────────────────────────────────────────────────
// Substrate fixtures + stubs (no IO, no real certs)
// ────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

// ────────────────────────────────────────────────────────────────
// verifyDomainHealth — bridges store rows to substrate inputs
// ────────────────────────────────────────────────────────────────

describe('verifyDomainHealth — applies verifier seam', () => {
  const baseRow = (overrides: Partial<SqliteTlsDomainHealthRow> = {}): SqliteTlsDomainHealthRow => ({
    domain: 'alpha.example',
    cert_pem: '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----',
    chain_pem: '-----BEGIN CERTIFICATE-----\nMOCKCHAIN\n-----END CERTIFICATE-----',
    fingerprint: FP_A,
    expires_at: NOW + 30 * MS_PER_DAY,
    issuer: "Let's Encrypt",
    source: 'pro_acme',
    ...overrides,
  });

  it('marks chain_valid true when verifyChain stub returns true', () => {
    const deps: VerifyDomainHealthDeps = {
      verifyChain: () => true,
      computeFingerprint: () => FP_A,
    };
    const input = verifyDomainHealth(baseRow(), deps);
    expect(input.chain_valid).toBe(true);
    expect(input.fingerprint_matches).toBe(true);
  });

  it('marks chain_valid false when verifyChain stub returns false', () => {
    const deps: VerifyDomainHealthDeps = {
      verifyChain: () => false,
      computeFingerprint: () => FP_A,
    };
    const input = verifyDomainHealth(baseRow(), deps);
    expect(input.chain_valid).toBe(false);
  });

  it('marks fingerprint_matches false when computed fp differs from stored', () => {
    const deps: VerifyDomainHealthDeps = {
      verifyChain: () => true,
      computeFingerprint: () => FP_B,
    };
    const input = verifyDomainHealth(baseRow(), deps);
    expect(input.fingerprint_matches).toBe(false);
  });

  it('marks fingerprint_matches false when computed fp is the empty string', () => {
    const deps: VerifyDomainHealthDeps = {
      verifyChain: () => true,
      computeFingerprint: () => '',
    };
    const input = verifyDomainHealth(baseRow(), deps);
    expect(input.fingerprint_matches).toBe(false);
  });

  it('forwards last_renewed_at when present, omits when undefined', () => {
    const deps: VerifyDomainHealthDeps = {
      verifyChain: () => true,
      computeFingerprint: () => FP_A,
    };
    const withTs = verifyDomainHealth(baseRow({ last_renewed_at: NOW - 5 * MS_PER_DAY }), deps);
    expect(withTs.last_renewed_at).toBe(NOW - 5 * MS_PER_DAY);
    const withoutTs = verifyDomainHealth(baseRow(), deps);
    expect('last_renewed_at' in withoutTs).toBe(false);
  });

  it('calls verifyChain with accept_self_signed: false (production discipline)', () => {
    const calls: Array<{ accept_self_signed: boolean }> = [];
    const deps: VerifyDomainHealthDeps = {
      verifyChain: (_cert, _chain, opts) => {
        calls.push(opts);
        return true;
      },
      computeFingerprint: () => FP_A,
    };
    verifyDomainHealth(baseRow(), deps);
    expect(calls[0].accept_self_signed).toBe(false);
  });

  it('forwards the chain_pem to verifyChain (or undefined when absent)', () => {
    let passedChain: string | undefined = 'sentinel-unset' as string | undefined;
    const deps: VerifyDomainHealthDeps = {
      verifyChain: (_cert, chain) => {
        passedChain = chain;
        return true;
      },
      computeFingerprint: () => FP_A,
    };
    verifyDomainHealth(baseRow({ chain_pem: undefined }), deps);
    expect(passedChain).toBeUndefined();
  });

  // Codex FU2 P2 #1 fold — accept_self_signed threads through.
  it('forwards deps.accept_self_signed: true to verifyChain', () => {
    let observedFlag: boolean | undefined;
    const deps: VerifyDomainHealthDeps = {
      verifyChain: (_cert, _chain, opts) => {
        observedFlag = opts.accept_self_signed;
        return true;
      },
      computeFingerprint: () => FP_A,
      accept_self_signed: true,
    };
    verifyDomainHealth(baseRow(), deps);
    expect(observedFlag).toBe(true);
  });

  it('forwards deps.accept_self_signed: false (default) to verifyChain', () => {
    let observedFlag: boolean | undefined;
    const deps: VerifyDomainHealthDeps = {
      verifyChain: (_cert, _chain, opts) => {
        observedFlag = opts.accept_self_signed;
        return true;
      },
      computeFingerprint: () => FP_A,
      // accept_self_signed omitted — must default to false (Codex FU2 P2 #1).
    };
    verifyDomainHealth(baseRow(), deps);
    expect(observedFlag).toBe(false);
  });

  it('preserves chain_valid: true for a self-signed row when accept_self_signed: true (no phantom error)', () => {
    // Simulates the on-prem / dev BYO flow: the store was created with
    // acceptSelfSigned: true; the upload validator passed a self-signed
    // cert; the health-check stub here returns true ONLY when the flag
    // is set. The fold ensures verifyDomainHealth passes the flag
    // through, so chain_valid stays true → no tls_chain_invalid_for_domain.
    const deps: VerifyDomainHealthDeps = {
      verifyChain: (_cert, _chain, opts) => opts.accept_self_signed === true,
      computeFingerprint: () => FP_A,
      accept_self_signed: true,
    };
    const input = verifyDomainHealth(baseRow({ source: 'byo_upload' }), deps);
    expect(input.chain_valid).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// SqliteTlsDomainStore.listForHealthCheck — store extension
// ────────────────────────────────────────────────────────────────

const CERT_PEM_FIXTURE = '-----BEGIN CERTIFICATE-----\nFAKE-CERT-BYTES\n-----END CERTIFICATE-----';
const CHAIN_PEM_FIXTURE = '-----BEGIN CERTIFICATE-----\nFAKE-CHAIN-BYTES\n-----END CERTIFICATE-----';
const PRIVATE_KEY_FIXTURE = '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----';

const stubVerifiers = (sans: string[], expires_at: number) => ({
  extractSANs: () => sans,
  verifyKeyPair: () => true,
  verifyChain: () => true,
  readExpiresAt: () => expires_at,
});

describe('SqliteTlsDomainStore.listForHealthCheck', () => {
  const buildStore = () => {
    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    const store = createSqliteTlsDomainStore({
      db,
      verifiers: stubVerifiers(['alpha.example'], NOW + 30 * MS_PER_DAY),
      metadataReader: { extractIssuer: () => "Let's Encrypt" },
      now: () => NOW,
    });
    return { db, store };
  };

  it('returns empty array when no rows exist', () => {
    const { store } = buildStore();
    expect(store.listForHealthCheck()).toEqual([]);
  });

  it('returns rows with cert_pem + chain_pem columns', async () => {
    const { store } = buildStore();
    await store.upload({
      domain: 'alpha.example',
      cert_pem: CERT_PEM_FIXTURE,
      private_key_pem: PRIVATE_KEY_FIXTURE,
      chain_pem: CHAIN_PEM_FIXTURE,
      source: 'pro_acme',
    });
    const rows = store.listForHealthCheck();
    expect(rows).toHaveLength(1);
    expect(rows[0].cert_pem).toBe(CERT_PEM_FIXTURE);
    expect(rows[0].chain_pem).toBe(CHAIN_PEM_FIXTURE);
  });

  it('NEVER carries private key material on the row', async () => {
    const { store } = buildStore();
    await store.upload({
      domain: 'alpha.example',
      cert_pem: CERT_PEM_FIXTURE,
      private_key_pem: PRIVATE_KEY_FIXTURE,
      chain_pem: CHAIN_PEM_FIXTURE,
      source: 'byo_upload',
    });
    const rows = store.listForHealthCheck();
    for (const row of rows) {
      const keys = Object.keys(row);
      expect(keys).not.toContain('private_key_pem');
      expect(keys).not.toContain('private_key_encrypted');
    }
  });

  it('omits chain_pem when the row has no chain stored', async () => {
    const store = createSqliteTlsDomainStore({
      db: (() => {
        const db = new Database(':memory:');
        ensureTlsDomainSchema(db);
        return db;
      })(),
      verifiers: stubVerifiers(['alpha.example'], NOW + 30 * MS_PER_DAY),
      metadataReader: { extractIssuer: () => "Let's Encrypt" },
      now: () => NOW,
      acceptSelfSigned: true,
    });
    await store.upload({
      domain: 'alpha.example',
      cert_pem: CERT_PEM_FIXTURE,
      private_key_pem: PRIVATE_KEY_FIXTURE,
      source: 'byo_upload',
    });
    const rows = store.listForHealthCheck();
    expect(rows[0].cert_pem).toBe(CERT_PEM_FIXTURE);
    expect('chain_pem' in rows[0]).toBe(false);
  });

  it('returns all standard list-entry fields alongside cert+chain', async () => {
    const { store } = buildStore();
    await store.upload({
      domain: 'alpha.example',
      cert_pem: CERT_PEM_FIXTURE,
      private_key_pem: PRIVATE_KEY_FIXTURE,
      chain_pem: CHAIN_PEM_FIXTURE,
      source: 'pro_acme',
    });
    const rows = store.listForHealthCheck();
    expect(rows[0].domain).toBe('alpha.example');
    expect(rows[0].issuer).toBe("Let's Encrypt");
    expect(rows[0].source).toBe('pro_acme');
    expect(rows[0].expires_at).toBe(NOW + 30 * MS_PER_DAY);
    expect(typeof rows[0].fingerprint).toBe('string');
  });

  it('returns rows in ascending domain order (same as list())', async () => {
    const { store } = buildStore();
    // Pre-stub the verifiers per-domain SAN list so each upload validates.
    const db = new Database(':memory:');
    ensureTlsDomainSchema(db);
    let nextSan = 'unused';
    const store2 = createSqliteTlsDomainStore({
      db,
      verifiers: {
        extractSANs: () => [nextSan],
        verifyKeyPair: () => true,
        verifyChain: () => true,
        readExpiresAt: () => NOW + 30 * MS_PER_DAY,
      },
      metadataReader: { extractIssuer: () => "Let's Encrypt" },
      now: () => NOW,
    });
    nextSan = 'zeta.example';
    await store2.upload({
      domain: 'zeta.example',
      cert_pem: CERT_PEM_FIXTURE,
      private_key_pem: PRIVATE_KEY_FIXTURE,
      chain_pem: CHAIN_PEM_FIXTURE,
      source: 'pro_acme',
    });
    nextSan = 'alpha.example';
    await store2.upload({
      domain: 'alpha.example',
      cert_pem: CERT_PEM_FIXTURE,
      private_key_pem: PRIVATE_KEY_FIXTURE,
      chain_pem: CHAIN_PEM_FIXTURE,
      source: 'byo_upload',
    });
    const rows = store2.listForHealthCheck();
    expect(rows.map((r) => r.domain)).toEqual(['alpha.example', 'zeta.example']);
  });
});

describe('source pins — FU2 substrate is wired correctly', () => {
  const repoRoot = resolve(__dirname, '../..');

  const readSrc = (rel: string): string => readFileSync(resolve(repoRoot, rel), 'utf8');

  it('domain-store.ts exposes listForHealthCheck on the SqliteTlsDomainStore interface', () => {
    const src = readSrc('src/tls/domain-store.ts');
    expect(src).toMatch(/listForHealthCheck\(\)/);
    expect(src).toMatch(/SqliteTlsDomainHealthCheckRow/);
  });

  it('domain-store.ts factory returns listForHealthCheck in its return literal', () => {
    const src = readSrc('src/tls/domain-store.ts');
    // The factory's return statement enumerates the public methods.
    expect(src).toMatch(/return\s*\{[\s\S]*listForHealthCheck[\s\S]*\}/);
  });

  it('SqliteTlsDomainHealthCheckRow does NOT mention private_key on its type definition', () => {
    const src = readSrc('src/tls/domain-store.ts');
    const interfaceBlock = src.match(/interface SqliteTlsDomainHealthCheckRow[\s\S]*?\}/)?.[0] ?? '';
    expect(interfaceBlock).toMatch(/cert_pem/);
    expect(interfaceBlock).not.toMatch(/private_key/);
  });
});
