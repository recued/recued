/** D-148 FU2 — Reachability Doctor per-domain TLS health.
 *
 *  Coverage:
 *    1. `buildPerDomainTlsHealth` pure assembly: entries + per-row
 *       recommendation feed (expiry windows / chain broken / row-
 *       tamper detection). Uses stubbed health bits so the test never
 *       depends on the system trust store.
 *    2. `verifyDomainHealth` helper applies the verifier seam +
 *       fingerprint helper. Stubbed deps so the helper is testable
 *       without real certs.
 *    3. `SqliteTlsDomainStore.listForHealthCheck()` round-trip:
 *       returns rows with `cert_pem` + `chain_pem` columns; private
 *       key NEVER on the row.
 *    4. `buildReachabilityReport` integration: when
 *       `per_domain_tls` is supplied, the report carries the entries
 *       + recommendations get merged into the main feed.
 *    5. Closed-list ratchet: `tls_chain_invalid_for_domain` lives in
 *       both `REACHABILITY_RECOMMENDATION_CODES` (contracts) +
 *       `REACHABILITY_RECOMMENDATION_CODES_USED` (server diagnostics).
 *    6. Source pins: reachability.ts merges per_domain_tls; domain-
 *       store.ts factory returns `listForHealthCheck`; substrate
 *       module exports the expected symbols. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  REACHABILITY_RECOMMENDATION_CODES,
  type PathResolution,
  type PathRole,
  type ReachabilityBridgeEntry,
  type ReachabilityDnsBlock,
  type ReachabilityNetworkBlock,
  type ReachabilityPerDomainTlsEntry,
  type ReachabilityRecommendationCode,
  type ReachabilityTlsBlock,
  type ReachabilityWebclientEntry,
  type TLSDomainCertSource,
} from '@recued/contracts';
import type { PathListenerStatus } from '@recued/server-tls';
import {
  buildPerDomainTlsHealth,
  PER_DOMAIN_TLS_RENEWAL_IMMINENT_WINDOW_DAYS,
  PER_DOMAIN_TLS_RENEWAL_OVERDUE_WINDOW_DAYS,
  verifyDomainHealth,
  type PerDomainTlsHealthInput,
  type SqliteTlsDomainHealthRow,
  type VerifyDomainHealthDeps,
} from '../diagnostics/per-domain-tls-health.js';
import {
  buildReachabilityReport,
  REACHABILITY_RECOMMENDATION_CODES_USED,
  type ReachabilityInputs,
} from '../diagnostics/reachability.js';
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

const healthyInput = (overrides: Partial<PerDomainTlsHealthInput> = {}): PerDomainTlsHealthInput => ({
  domain: 'alpha.example',
  fingerprint: FP_A,
  expires_at: NOW + 60 * MS_PER_DAY,
  issuer: "Let's Encrypt",
  source: 'pro_acme',
  chain_valid: true,
  fingerprint_matches: true,
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// buildPerDomainTlsHealth — substrate
// ────────────────────────────────────────────────────────────────

describe('buildPerDomainTlsHealth — empty + healthy', () => {
  it('returns empty entries + recommendations when no inputs are supplied', () => {
    const result = buildPerDomainTlsHealth([], { now_ms: NOW });
    expect(result.entries).toEqual([]);
    expect(result.recommendations).toEqual([]);
  });

  it('emits one entry + zero recommendations for a healthy domain', () => {
    const result = buildPerDomainTlsHealth([healthyInput()], { now_ms: NOW });
    expect(result.entries).toHaveLength(1);
    expect(result.recommendations).toEqual([]);
    const entry = result.entries[0];
    expect(entry.domain).toBe('alpha.example');
    expect(entry.fingerprint).toBe(FP_A);
    expect(entry.days_until_expiry).toBe(60);
    expect(entry.chain_valid).toBe(true);
    expect(entry.fingerprint_matches).toBe(true);
    expect(entry.source).toBe('pro_acme');
  });

  it('preserves last_renewed_at when supplied', () => {
    const lastRenewed = NOW - 30 * MS_PER_DAY;
    const result = buildPerDomainTlsHealth(
      [healthyInput({ last_renewed_at: lastRenewed })],
      { now_ms: NOW },
    );
    expect(result.entries[0].last_renewed_at).toBe(lastRenewed);
  });

  it('omits last_renewed_at when undefined (does not leak the key)', () => {
    const result = buildPerDomainTlsHealth([healthyInput()], { now_ms: NOW });
    expect('last_renewed_at' in result.entries[0]).toBe(false);
  });
});

describe('buildPerDomainTlsHealth — expiry windows', () => {
  it('emits tls_renewal_overdue when expiry <= 7 days', () => {
    const result = buildPerDomainTlsHealth(
      [healthyInput({
        expires_at: NOW + (PER_DOMAIN_TLS_RENEWAL_OVERDUE_WINDOW_DAYS - 1) * MS_PER_DAY,
      })],
      { now_ms: NOW },
    );
    const overdue = result.recommendations.find((r) => r.code === 'tls_renewal_overdue');
    expect(overdue?.severity).toBe('error');
    expect(overdue?.message).toContain('alpha.example');
    expect(overdue?.message).toContain('day(s)');
  });

  it('emits tls_renewal_imminent when 7d < expiry <= 14 days', () => {
    const result = buildPerDomainTlsHealth(
      [healthyInput({
        expires_at: NOW + (PER_DOMAIN_TLS_RENEWAL_IMMINENT_WINDOW_DAYS - 1) * MS_PER_DAY,
      })],
      { now_ms: NOW },
    );
    const codes = result.recommendations.map((r) => r.code);
    expect(codes).toContain('tls_renewal_imminent');
    expect(codes).not.toContain('tls_renewal_overdue');
    const imminent = result.recommendations.find((r) => r.code === 'tls_renewal_imminent');
    expect(imminent?.severity).toBe('warning');
    expect(imminent?.message).toContain('alpha.example');
  });

  it('emits tls_renewal_overdue for already-expired certs (negative days)', () => {
    const result = buildPerDomainTlsHealth(
      [healthyInput({ expires_at: NOW - 3 * MS_PER_DAY })],
      { now_ms: NOW },
    );
    const overdue = result.recommendations.find((r) => r.code === 'tls_renewal_overdue');
    expect(overdue).toBeDefined();
    expect(result.entries[0].days_until_expiry).toBeLessThan(0);
  });

  it('does NOT emit expiry recommendations when expiry is >= 15 days out', () => {
    const result = buildPerDomainTlsHealth(
      [healthyInput({ expires_at: NOW + 30 * MS_PER_DAY })],
      { now_ms: NOW },
    );
    const codes = result.recommendations.map((r) => r.code);
    expect(codes).not.toContain('tls_renewal_overdue');
    expect(codes).not.toContain('tls_renewal_imminent');
  });

  it('pro_acme remediation says "Trigger an ACME renewal"', () => {
    const result = buildPerDomainTlsHealth(
      [healthyInput({
        source: 'pro_acme',
        expires_at: NOW + 3 * MS_PER_DAY,
      })],
      { now_ms: NOW },
    );
    const overdue = result.recommendations.find((r) => r.code === 'tls_renewal_overdue');
    expect(overdue?.remediation).toContain('ACME');
  });

  it('byo_upload remediation says "Upload a renewed cert"', () => {
    const result = buildPerDomainTlsHealth(
      [healthyInput({
        source: 'byo_upload',
        expires_at: NOW + 3 * MS_PER_DAY,
      })],
      { now_ms: NOW },
    );
    const overdue = result.recommendations.find((r) => r.code === 'tls_renewal_overdue');
    expect(overdue?.remediation).toContain('Upload');
  });

  // Codex FU2 P2 #3 fold — imminent (warning-band) remediation must
  // distinguish auto-managed certs from BYO so the webclient never
  // shows "auto-renewal" copy for a user-managed cert.
  it('pro_acme imminent remediation says "Auto-renewal will run"', () => {
    const result = buildPerDomainTlsHealth(
      [healthyInput({
        source: 'pro_acme',
        expires_at: NOW + 10 * MS_PER_DAY,
      })],
      { now_ms: NOW },
    );
    const imminent = result.recommendations.find((r) => r.code === 'tls_renewal_imminent');
    expect(imminent?.remediation).toContain('Auto-renewal');
  });

  it('byo_upload imminent remediation says "Upload a renewed cert" (not auto-renewal)', () => {
    const result = buildPerDomainTlsHealth(
      [healthyInput({
        source: 'byo_upload',
        expires_at: NOW + 10 * MS_PER_DAY,
      })],
      { now_ms: NOW },
    );
    const imminent = result.recommendations.find((r) => r.code === 'tls_renewal_imminent');
    expect(imminent?.remediation).toBeDefined();
    expect(imminent?.remediation).toContain('Upload');
    expect(imminent?.remediation).not.toContain('Auto-renewal');
  });
});

describe('buildPerDomainTlsHealth — chain + fingerprint failures', () => {
  it('emits tls_chain_invalid_for_domain when chain_valid is false', () => {
    const result = buildPerDomainTlsHealth(
      [healthyInput({ chain_valid: false })],
      { now_ms: NOW },
    );
    const rec = result.recommendations.find((r) => r.code === 'tls_chain_invalid_for_domain');
    expect(rec?.severity).toBe('error');
    expect(rec?.message).toContain('alpha.example');
    expect(rec?.remediation).toContain('intermediate chain');
  });

  it('emits cert_fingerprint_mismatch when fingerprint_matches is false', () => {
    const result = buildPerDomainTlsHealth(
      [healthyInput({ fingerprint_matches: false })],
      { now_ms: NOW },
    );
    const rec = result.recommendations.find((r) => r.code === 'cert_fingerprint_mismatch');
    expect(rec?.severity).toBe('error');
    expect(rec?.message).toContain('alpha.example');
    expect(rec?.message).toContain('row tampering');
  });

  it('emits both failures when both bits are false on the same row', () => {
    const result = buildPerDomainTlsHealth(
      [healthyInput({ chain_valid: false, fingerprint_matches: false })],
      { now_ms: NOW },
    );
    const codes = result.recommendations.map((r) => r.code);
    expect(codes).toContain('tls_chain_invalid_for_domain');
    expect(codes).toContain('cert_fingerprint_mismatch');
  });
});

describe('buildPerDomainTlsHealth — multi-row', () => {
  it('emits per-domain recommendations independently for each row', () => {
    const rows: PerDomainTlsHealthInput[] = [
      healthyInput({ domain: 'alpha.example' }),
      healthyInput({
        domain: 'beta.example',
        fingerprint: FP_B,
        expires_at: NOW + 3 * MS_PER_DAY,
      }),
      healthyInput({
        domain: 'gamma.example',
        chain_valid: false,
      }),
    ];
    const result = buildPerDomainTlsHealth(rows, { now_ms: NOW });
    expect(result.entries).toHaveLength(3);
    const overdue = result.recommendations.find((r) => r.code === 'tls_renewal_overdue');
    expect(overdue?.message).toContain('beta.example');
    const chain = result.recommendations.find((r) => r.code === 'tls_chain_invalid_for_domain');
    expect(chain?.message).toContain('gamma.example');
  });
});

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

// ────────────────────────────────────────────────────────────────
// buildReachabilityReport integration
// ────────────────────────────────────────────────────────────────

const NETWORK_HEALTHY: ReachabilityNetworkBlock = {
  public_ipv4: '203.0.113.5',
  detected_via: 'cloud_probe',
  behind_nat: false,
  upnp_status: 'enabled',
};

const DNS_HEALTHY: ReachabilityDnsBlock = {
  handle: 'alice',
  ddns_resolves: true,
  resolved_to_expected_ip: true,
  resolution_ms: 50,
  last_ddns_update: NOW,
};

const TLS_HEALTHY: ReachabilityTlsBlock = {
  cert_fingerprint: FP_A,
  expires_at: NOW + 60 * MS_PER_DAY,
  days_until_expiry: 60,
  issuer: "Let's Encrypt",
  san: ['alice.recued.cloud'],
  valid_for_handle: true,
  renewal_overdue: false,
};

const PUBLIC_RESOLUTION: Record<PathRole, PathResolution> = {
  health: { lan: true, public: true },
  ws: { lan: true, public: true },
  mcp: { lan: true, public: false },
  llm_gateway: { lan: true, public: true },
  webhooks: { lan: true, public: true },
  reception: { lan: true, public: true },
  oauth: { lan: false, public: false },
  ask: { lan: false, public: false },
  webclient: { lan: true, public: false },
};

const LISTENERS_HEALTHY: PathListenerStatus[] = [
  { listener: 'lan', port: 80, listening: true, bind_address: '192.168.1.42', tls: false },
  { listener: 'public', port: 443, listening: true, bind_address: '0.0.0.0', tls: true },
];

const buildInputs = (overrides: Partial<ReachabilityInputs> = {}): ReachabilityInputs => ({
  report_id: 'r-1',
  generated_at: NOW,
  server_passport_fingerprint: 'fp',
  network: NETWORK_HEALTHY,
  dns: DNS_HEALTHY,
  tls: TLS_HEALTHY,
  listeners: LISTENERS_HEALTHY,
  path_resolution: PUBLIC_RESOLUTION,
  webhooks: [],
  bridges: [],
  webclients: [],
  ...overrides,
});

describe('buildReachabilityReport — per_domain_tls integration', () => {
  it('omits per_domain_tls from the report when the input is undefined', () => {
    const report = buildReachabilityReport(buildInputs());
    expect(report.per_domain_tls).toBeUndefined();
  });

  it('omits per_domain_tls from the report when the input is an empty array', () => {
    const report = buildReachabilityReport(buildInputs({ per_domain_tls: [] }));
    expect(report.per_domain_tls).toBeUndefined();
  });

  it('emits a per_domain_tls block when inputs are present', () => {
    const report = buildReachabilityReport(buildInputs({
      per_domain_tls: [healthyInput()],
    }));
    expect(report.per_domain_tls).toHaveLength(1);
    expect(report.per_domain_tls?.[0].domain).toBe('alpha.example');
  });

  it('merges per-domain recommendations into the main feed', () => {
    const report = buildReachabilityReport(buildInputs({
      per_domain_tls: [
        healthyInput({
          domain: 'expired.example',
          expires_at: NOW - 2 * MS_PER_DAY,
        }),
      ],
    }));
    const overdue = report.recommendations.find(
      (r) => r.code === 'tls_renewal_overdue' && r.message.includes('expired.example'),
    );
    expect(overdue).toBeDefined();
  });

  it('keeps the single-cert tls block independent from per_domain_tls', () => {
    // The single-cert tls block already triggers tls_renewal_overdue on
    // the main path. With per_domain_tls also expiring, BOTH should
    // emit (per-cert keyed) without one swallowing the other.
    const report = buildReachabilityReport(buildInputs({
      tls: { ...TLS_HEALTHY, days_until_expiry: 3, renewal_overdue: true },
      per_domain_tls: [
        healthyInput({
          domain: 'expired.example',
          expires_at: NOW - 1 * MS_PER_DAY,
        }),
      ],
    }));
    const overdueRecs = report.recommendations.filter((r) => r.code === 'tls_renewal_overdue');
    expect(overdueRecs.length).toBeGreaterThanOrEqual(2);
    expect(overdueRecs.some((r) => r.message.includes('expired.example'))).toBe(true);
    expect(overdueRecs.some((r) => !r.message.includes('expired.example'))).toBe(true);
  });

  it('does NOT emit per-domain recommendations for a healthy multi-cert config', () => {
    const report = buildReachabilityReport(buildInputs({
      per_domain_tls: [
        healthyInput({ domain: 'alpha.example' }),
        healthyInput({ domain: 'beta.example', fingerprint: FP_B }),
      ],
    }));
    // The main feed should be empty (no DDNS / webhook / bridge issues).
    expect(report.recommendations).toEqual([]);
    // Per-domain entries still surface.
    expect(report.per_domain_tls).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────
// Closed-list ratchet + source pins
// ────────────────────────────────────────────────────────────────

describe('closed-list ratchet — tls_chain_invalid_for_domain', () => {
  it('is in REACHABILITY_RECOMMENDATION_CODES (contracts)', () => {
    const codes: ReadonlyArray<ReachabilityRecommendationCode> = REACHABILITY_RECOMMENDATION_CODES;
    expect(codes).toContain('tls_chain_invalid_for_domain');
  });

  it('is in REACHABILITY_RECOMMENDATION_CODES_USED (server diagnostics)', () => {
    expect(REACHABILITY_RECOMMENDATION_CODES_USED).toContain('tls_chain_invalid_for_domain');
  });

  it('REACHABILITY_RECOMMENDATION_CODES preserves the D-148 + D-149 prefix', () => {
    const required: ReadonlyArray<ReachabilityRecommendationCode> = [
      'tls_renewal_overdue',
      'tls_renewal_imminent',
      'ddns_ip_mismatch',
      'webhook_inbound_silent',
      'webhook_hmac_failure',
      'bridge_offline',
      'cert_fingerprint_mismatch',
      'path_unreachable_from_cloud',
      'nat_traversal_required',
      'exposure_resolution_inconsistent',
      'reception_listener_silent',
      'reception_endpoint_unreachable',
      'reception_cert_san_missing_hostname',
    ];
    for (const code of required) {
      expect(REACHABILITY_RECOMMENDATION_CODES).toContain(code);
    }
  });
});

describe('source pins — FU2 substrate is wired correctly', () => {
  const repoRoot = resolve(__dirname, '../..');

  const readSrc = (rel: string): string => readFileSync(resolve(repoRoot, rel), 'utf8');

  it('reachability.ts imports buildPerDomainTlsHealth from the FU2 module', () => {
    const src = readSrc('src/diagnostics/reachability.ts');
    expect(src).toMatch(/from\s+['"]\.\/per-domain-tls-health\.js['"]/);
    expect(src).toMatch(/buildPerDomainTlsHealth/);
  });

  it('reachability.ts merges per_domain_tls entries into the report', () => {
    const src = readSrc('src/diagnostics/reachability.ts');
    expect(src).toMatch(/report\.per_domain_tls\s*=\s*perDomainResult\.entries/);
  });

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

describe('FU2 entry shape — ReachabilityPerDomainTlsEntry compiles + carries expected fields', () => {
  it('accepts a fully-typed entry without unknown-field complaints', () => {
    const entry: ReachabilityPerDomainTlsEntry = {
      domain: 'alpha.example',
      fingerprint: FP_A,
      expires_at: NOW + 30 * MS_PER_DAY,
      days_until_expiry: 30,
      issuer: "Let's Encrypt",
      source: 'pro_acme' satisfies TLSDomainCertSource,
      chain_valid: true,
      fingerprint_matches: true,
      last_renewed_at: NOW - 7 * MS_PER_DAY,
    };
    expect(entry.domain).toBe('alpha.example');
  });
});
