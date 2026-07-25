/** D-148 § A.6.5 — `createAcmeDomainRenewer` production renewer tests.
 *
 *  Verifies the production `DomainRenewer` that backs
 *  `createDomainBackedTlsRenewalHook({ renewer })`. The renewer plugs
 *  `RecuedAcmeClient.issueCert(...)` + `SqliteTlsDomainStore.upload(...)`
 *  + the caller-supplied CSR generator into a single per-domain renewal
 *  call.
 *
 *  Key invariants:
 *    - `store.lookup(domain) === null` → `helper_unavailable` (no ACME
 *      call; vault locked / cache cold).
 *    - CSR generator output containing a PRIVATE KEY block → defensive
 *      `helper_unavailable` (never let the privkey leave the server).
 *    - ACME HTTP 401 / 402 / 403 failures → `subscription_required`.
 *    - All other ACME failures (network, 5xx, contract throw) →
 *      `helper_unavailable`.
 *    - `store.upload` throw → `storage_io_error`.
 *    - Success path: `acme.issueCert` invoked with `{ handle: domain,
 *      csr_pem }`; `store.upload` invoked with `{ domain, source:
 *      'pro_acme', cert_pem, private_key_pem (reused), chain_pem }`;
 *      returns `{ ok: true, new_fingerprint }`.
 *    - Renewal reuses the existing private key (standard ACME practice).
 *
 *  Spec: `docs/d-148-spec.md` § A.6.5. */

import { describe, expect, it, vi } from 'vitest';
import type { TLSDomainCertChain, TLSDomainUploadResult } from '@recued/contracts';

import {
  createAcmeDomainRenewer,
  type AcmeCertIssuer,
  type AcmeDomainRenewerOptions,
} from '../keys/rotation/acme-domain-renewer.js';
import type { SqliteTlsDomainStore } from '../tls/domain-store.js';

// ────────────────────────────────────────────────────────────────
// Scaffolding
// ────────────────────────────────────────────────────────────────

const validCsr =
  '-----BEGIN CERTIFICATE REQUEST-----\nFOO\n-----END CERTIFICATE REQUEST-----';

const chain = (
  domain: string,
  fingerprint: string,
  private_key_pem = 'PRIVKEY',
): TLSDomainCertChain => ({
  domain,
  cert_pem: 'OLD_CERT',
  private_key_pem,
  fingerprint,
  expires_at: 1_700_000_000_000,
  source: 'pro_acme',
});

interface StubStoreCalls {
  lookups: string[];
  uploads: Parameters<SqliteTlsDomainStore['upload']>[0][];
}

const stubStore = (
  init: {
    chains: Map<string, TLSDomainCertChain>;
    /** Optional post-upload fingerprint override; defaults to `'NEWFP'`. */
    postUploadFingerprint?: string;
    /** When true, upload rejects (simulates store validation throw). */
    uploadThrows?: boolean;
    /** When true, the post-upload lookup returns null (simulates the
     *  "should never happen" pathological case). */
    postUploadLookupNull?: boolean;
  },
): {
  store: Pick<SqliteTlsDomainStore, 'lookup' | 'upload'>;
  calls: StubStoreCalls;
} => {
  const calls: StubStoreCalls = { lookups: [], uploads: [] };
  const chains = new Map(init.chains);
  const postFp = init.postUploadFingerprint ?? 'NEWFP';
  const store: Pick<SqliteTlsDomainStore, 'lookup' | 'upload'> = {
    lookup: (domain: string): TLSDomainCertChain | null => {
      calls.lookups.push(domain);
      return chains.get(domain) ?? null;
    },
    upload: async (args): Promise<TLSDomainUploadResult> => {
      calls.uploads.push(args);
      if (init.uploadThrows) {
        throw new Error('sqlite_disk_full');
      }
      // Simulate the post-upload row swap.
      const existing = chains.get(args.domain);
      const updated: TLSDomainCertChain = {
        domain: args.domain,
        cert_pem: args.cert_pem,
        private_key_pem: args.private_key_pem,
        fingerprint: postFp,
        expires_at: 2_700_000_000_000,
        source: args.source,
      };
      if (args.chain_pem !== undefined) {
        updated.chain_pem = args.chain_pem;
      }
      if (init.postUploadLookupNull) {
        chains.delete(args.domain);
      } else {
        chains.set(args.domain, updated);
      }
      return {
        fingerprint: postFp,
        expires_at: 2_700_000_000_000,
        san: [args.domain],
      };
    },
  };
  return { store, calls };
};

const okIssuer = (
  override?: Partial<Awaited<ReturnType<AcmeCertIssuer['issueCert']>>>,
): AcmeCertIssuer & { issueCert: ReturnType<typeof vi.fn> } => {
  const issueCert = vi.fn(async () => ({
    cert_pem: 'NEW_CERT',
    issuer_chain_pem: 'NEW_CHAIN',
    expires_at: 2_700_000_000_000,
    renewal_recommended_at: 2_650_000_000_000,
    ...override,
  }));
  return { issueCert };
};

const failingIssuer = (
  err: Error,
): AcmeCertIssuer & { issueCert: ReturnType<typeof vi.fn> } => {
  const issueCert = vi.fn(async () => {
    throw err;
  });
  return { issueCert };
};

const build = (
  opts: Partial<AcmeDomainRenewerOptions> & {
    acme: AcmeCertIssuer;
    store: Pick<SqliteTlsDomainStore, 'lookup' | 'upload'>;
  },
) => {
  return createAcmeDomainRenewer({
    generateCsr: () => validCsr,
    ...opts,
  });
};

// ────────────────────────────────────────────────────────────────
// Shape
// ────────────────────────────────────────────────────────────────

describe('createAcmeDomainRenewer — shape', () => {
  it('returns a DomainRenewer-shaped object', () => {
    const { store } = stubStore({ chains: new Map() });
    const renewer = build({ acme: okIssuer(), store });
    expect(typeof renewer.renewDomain).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────
// Pre-flight: store lookup
// ────────────────────────────────────────────────────────────────

describe('createAcmeDomainRenewer — store lookup', () => {
  it('returns helper_unavailable when row not in cache (vault locked / cache cold)', async () => {
    const acme = okIssuer();
    const { store, calls } = stubStore({ chains: new Map() });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(calls.lookups).toEqual(['alice.recued.net']);
    expect(acme.issueCert).not.toHaveBeenCalled();
    expect(calls.uploads).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Pre-flight: Pro DDNS handle stem extraction
// ────────────────────────────────────────────────────────────────

describe('createAcmeDomainRenewer — Pro DDNS handle stem', () => {
  it('rejects domains not under .recued.net (BYO custom domain)', async () => {
    // A BYO custom domain row (e.g. `home.alice.example`) shouldn't
    // reach the renewer in steady state — upstream
    // `sources: ['pro_acme']` filters it out. Defensive: if it does,
    // the renewer cannot derive a handle stem the cloud Worker would
    // accept, so it returns `helper_unavailable` ahead of a wasted
    // ACME round-trip (which the cloud would 400 with
    // `acme_csr_handle_mismatch`).
    const acme = okIssuer();
    const { store, calls } = stubStore({
      chains: new Map([
        ['home.alice.example', chain('home.alice.example', 'OLDFP')],
      ]),
    });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'home.alice.example' });
    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(acme.issueCert).not.toHaveBeenCalled();
    expect(calls.uploads).toHaveLength(0);
  });

  it('rejects multi-label .recued.net handles (a.b.recued.net)', async () => {
    // The cloud Worker's CN-match only accepts single-label handles
    // (`<handle>.recued.net` with no internal dots). A row with a
    // multi-label prefix is either an upstream registration bug or a
    // future shape we don't support yet — surface as
    // `helper_unavailable` rather than send a doomed CSR.
    const acme = okIssuer();
    const { store, calls } = stubStore({
      chains: new Map([
        ['a.b.recued.net', chain('a.b.recued.net', 'OLDFP')],
      ]),
    });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'a.b.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(acme.issueCert).not.toHaveBeenCalled();
    expect(calls.uploads).toHaveLength(0);
  });

  it('rejects the bare apex (recued.cloud with empty stem)', async () => {
    // Edge case: row stored as the bare apex `recued.cloud`. The
    // suffix-strip would leave an empty stem; the cloud Worker would
    // reject the CSR. Surface as `helper_unavailable` here.
    const acme = okIssuer();
    const { store, calls } = stubStore({
      chains: new Map([
        ['recued.cloud', chain('recued.cloud', 'OLDFP')],
      ]),
    });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'recued.cloud' });
    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(acme.issueCert).not.toHaveBeenCalled();
    expect(calls.uploads).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Pre-flight: CSR defense
// ────────────────────────────────────────────────────────────────

describe('createAcmeDomainRenewer — CSR defensive gate', () => {
  it('rejects CSR containing a PRIVATE KEY block (defensive)', async () => {
    const acme = okIssuer();
    const { store, calls } = stubStore({
      chains: new Map([['alice.recued.net', chain('alice.recued.net', 'OLDFP')]]),
    });
    const renewer = build({
      acme,
      store,
      generateCsr: () =>
        '-----BEGIN CERTIFICATE REQUEST-----\nFOO\n-----END CERTIFICATE REQUEST-----\n' +
        '-----BEGIN RSA PRIVATE KEY-----\nLEAK\n-----END RSA PRIVATE KEY-----',
    });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(acme.issueCert).not.toHaveBeenCalled();
    expect(calls.uploads).toHaveLength(0);
  });

  it('rejects bare PRIVATE KEY too (Ed25519 / EC variants)', async () => {
    const acme = okIssuer();
    const { store, calls } = stubStore({
      chains: new Map([['alice.recued.net', chain('alice.recued.net', 'OLDFP')]]),
    });
    const renewer = build({
      acme,
      store,
      generateCsr: () =>
        '-----BEGIN PRIVATE KEY-----\nLEAK\n-----END PRIVATE KEY-----',
    });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(acme.issueCert).not.toHaveBeenCalled();
    expect(calls.uploads).toHaveLength(0);
  });

  it('CSR generator throw → helper_unavailable (no rejection escape)', async () => {
    // The generator might throw on an unsupported / corrupt private
    // key, an OpenSSL FFI failure, or any other bug. Those must map
    // to the closed-list `helper_unavailable` rather than escape as a
    // rejection — TlsRenewalHook.renew() + RotationEngine.renewTls()
    // both contract on the discriminated return shape, and the
    // housekeeping task's audit / cooldown branch only triggers on
    // `{ ok: false, reason }`. Codex P2 fold from review pass 2.
    const acme = okIssuer();
    const { store, calls } = stubStore({
      chains: new Map([['alice.recued.net', chain('alice.recued.net', 'OLDFP')]]),
    });
    const renewer = build({
      acme,
      store,
      generateCsr: () => {
        throw new Error('csr_generator_corrupt_private_key');
      },
    });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(acme.issueCert).not.toHaveBeenCalled();
    expect(calls.uploads).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// ACME issuance failures
// ────────────────────────────────────────────────────────────────

describe('createAcmeDomainRenewer — ACME failure mapping', () => {
  it('HTTP 401 → subscription_required', async () => {
    const acme = failingIssuer(
      new Error('recued_acme_issue_failed: HTTP 401 unauthorized'),
    );
    const { store } = stubStore({
      chains: new Map([['alice.recued.net', chain('alice.recued.net', 'OLDFP')]]),
    });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'subscription_required' });
  });

  it('HTTP 402 → subscription_required', async () => {
    const acme = failingIssuer(
      new Error('recued_acme_issue_failed: HTTP 402 payment required'),
    );
    const { store } = stubStore({
      chains: new Map([['alice.recued.net', chain('alice.recued.net', 'OLDFP')]]),
    });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'subscription_required' });
  });

  it('HTTP 403 → subscription_required', async () => {
    const acme = failingIssuer(
      new Error('recued_acme_issue_failed: HTTP 403 forbidden'),
    );
    const { store } = stubStore({
      chains: new Map([['alice.recued.net', chain('alice.recued.net', 'OLDFP')]]),
    });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'subscription_required' });
  });

  it('HTTP 500 → helper_unavailable (not subscription)', async () => {
    const acme = failingIssuer(
      new Error('recued_acme_issue_failed: HTTP 500 internal server error'),
    );
    const { store } = stubStore({
      chains: new Map([['alice.recued.net', chain('alice.recued.net', 'OLDFP')]]),
    });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
  });

  it('network error (no HTTP code) → helper_unavailable', async () => {
    const acme = failingIssuer(new Error('fetch failed: ECONNREFUSED'));
    const { store } = stubStore({
      chains: new Map([['alice.recued.net', chain('alice.recued.net', 'OLDFP')]]),
    });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
  });

  it('non-Error throw → helper_unavailable', async () => {
    const acme: AcmeCertIssuer = {
      issueCert: vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string thrown';
      }),
    };
    const { store } = stubStore({
      chains: new Map([['alice.recued.net', chain('alice.recued.net', 'OLDFP')]]),
    });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
  });

  it('does NOT match HTTP 4011 / 4031 (boundary discipline)', async () => {
    // The status-code regex must not match 4-digit sequences starting
    // with 401 / 402 / 403. `\bHTTP 40[123]\b` is anchored with word
    // boundaries on both sides; a stray five-digit body that began
    // with `401…` wouldn't match `\bHTTP 401\b` (the next char is a
    // digit). This documents the discipline.
    const acme = failingIssuer(
      new Error('recued_acme_issue_failed: HTTP 4011 not a real code'),
    );
    const { store } = stubStore({
      chains: new Map([['alice.recued.net', chain('alice.recued.net', 'OLDFP')]]),
    });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
  });
});

// ────────────────────────────────────────────────────────────────
// Storage failures
// ────────────────────────────────────────────────────────────────

describe('createAcmeDomainRenewer — storage failures', () => {
  it('store.upload throws → storage_io_error', async () => {
    const acme = okIssuer();
    const { store } = stubStore({
      chains: new Map([['alice.recued.net', chain('alice.recued.net', 'OLDFP')]]),
      uploadThrows: true,
    });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'storage_io_error' });
  });

  it('post-upload lookup returns null (pathological) → storage_io_error', async () => {
    const acme = okIssuer();
    const { store } = stubStore({
      chains: new Map([['alice.recued.net', chain('alice.recued.net', 'OLDFP')]]),
      postUploadLookupNull: true,
    });
    const renewer = build({ acme, store });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'storage_io_error' });
  });
});

// ────────────────────────────────────────────────────────────────
// Success path
// ────────────────────────────────────────────────────────────────

describe('createAcmeDomainRenewer — success path', () => {
  it('issues cert + uploads + returns new_fingerprint', async () => {
    const acme = okIssuer();
    const { store, calls } = stubStore({
      chains: new Map([
        ['alice.recued.net', chain('alice.recued.net', 'OLDFP', 'EXISTING_PK')],
      ]),
      postUploadFingerprint: 'FRESH_FP',
    });
    const generateCsr = vi.fn(() => validCsr);
    const renewer = createAcmeDomainRenewer({
      acme,
      store,
      generateCsr,
    });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: true, new_fingerprint: 'FRESH_FP' });

    // ACME invoked with the Pro DDNS handle STEM (for the cloud's
    // authority + issuer-affinity gates), the FULL domain (the host
    // the cert is ordered for, D-176), and the freshly-generated CSR.
    expect(acme.issueCert).toHaveBeenCalledTimes(1);
    expect(acme.issueCert).toHaveBeenCalledWith({
      handle: 'alice',
      domain: 'alice.recued.net',
      csr_pem: validCsr,
    });

    // CSR generator invoked with the lookup row's FULL domain (the
    // CSR's CN is the FQDN; the handle stem is only what the cloud
    // Worker uses to authenticate the request).
    expect(generateCsr).toHaveBeenCalledWith({
      domain: 'alice.recued.net',
      private_key_pem: 'EXISTING_PK',
    });

    // Upload invoked with `source: 'pro_acme'`, the existing privkey
    // (reuse), the new cert + chain from ACME, AND the FULL FQDN as
    // the domain key (the store rows are keyed on FQDN, not stem).
    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0]).toEqual({
      domain: 'alice.recued.net',
      source: 'pro_acme',
      cert_pem: 'NEW_CERT',
      private_key_pem: 'EXISTING_PK',
      chain_pem: 'NEW_CHAIN',
    });
  });

  it('uses the lookup row domain (not the input arg) for store ops', async () => {
    // The renewer canonicalises through `store.lookup` — the input
    // domain might come from `resolveCanonicalDomain` in mixed case,
    // but the store's lookup already lower-cases. Using the row's
    // canonical domain keeps the upload key aligned with whatever the
    // cache holds (defence-in-depth).
    const acme = okIssuer();
    const { store, calls } = stubStore({
      chains: new Map([
        // Stored canonical form is lower-case.
        [
          'alice.recued.net',
          chain('alice.recued.net', 'OLDFP', 'EXISTING_PK'),
        ],
      ]),
    });
    const renewer = build({ acme, store });
    await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(acme.issueCert).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'alice', domain: 'alice.recued.net' }),
    );
    expect(calls.uploads[0].domain).toBe('alice.recued.net');
  });

  it('does NOT mint a fresh private key (renewal reuses)', async () => {
    const acme = okIssuer();
    const { store, calls } = stubStore({
      chains: new Map([
        ['alice.recued.net', chain('alice.recued.net', 'OLDFP', 'OLDPK')],
      ]),
    });
    const renewer = build({ acme, store });
    await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(calls.uploads[0].private_key_pem).toBe('OLDPK');
  });
});

describe('createAcmeDomainRenewer — initial issuance path', () => {
  it('mints a fresh private key, issues a cert, uploads it, and returns cert metadata', async () => {
    const acme = okIssuer();
    const { store, calls } = stubStore({
      chains: new Map(),
      postUploadFingerprint: 'FIRST_FP',
    });
    const generateCsr = vi.fn(() => validCsr);
    const generatePrivateKeyPem = vi.fn(() => 'FRESH_PK');
    const renewer = createAcmeDomainRenewer({
      acme,
      store,
      generateCsr,
      generatePrivateKeyPem,
    });

    const out = await renewer.issueInitialDomain({ domain: 'alice.recued.net' });

    expect(out).toEqual({
      ok: true,
      new_fingerprint: 'FIRST_FP',
      cert_expires_at: 2_700_000_000_000,
    });
    expect(generatePrivateKeyPem).toHaveBeenCalledTimes(1);
    expect(generateCsr).toHaveBeenCalledWith({
      domain: 'alice.recued.net',
      private_key_pem: 'FRESH_PK',
    });
    expect(acme.issueCert).toHaveBeenCalledWith({
      handle: 'alice',
      domain: 'alice.recued.net',
      csr_pem: validCsr,
    });
    expect(calls.uploads).toEqual([
      {
        domain: 'alice.recued.net',
        source: 'pro_acme',
        cert_pem: 'NEW_CERT',
        private_key_pem: 'FRESH_PK',
        chain_pem: 'NEW_CHAIN',
      },
    ]);
  });

  it('is idempotent when a pro_acme row already exists', async () => {
    const acme = okIssuer();
    const { store, calls } = stubStore({
      chains: new Map([
        ['alice.recued.net', chain('alice.recued.net', 'EXISTING_FP')],
      ]),
    });
    const generateCsr = vi.fn(() => validCsr);
    const generatePrivateKeyPem = vi.fn(() => 'FRESH_PK');
    const renewer = createAcmeDomainRenewer({
      acme,
      store,
      generateCsr,
      generatePrivateKeyPem,
    });

    const out = await renewer.issueInitialDomain({ domain: 'alice.recued.net' });

    expect(out).toEqual({
      ok: true,
      new_fingerprint: 'EXISTING_FP',
      cert_expires_at: 1_700_000_000_000,
    });
    expect(generatePrivateKeyPem).not.toHaveBeenCalled();
    expect(generateCsr).not.toHaveBeenCalled();
    expect(acme.issueCert).not.toHaveBeenCalled();
    expect(calls.uploads).toHaveLength(0);
  });

  it('maps first-issuance key generator failures to helper_unavailable', async () => {
    const acme = okIssuer();
    const { store, calls } = stubStore({ chains: new Map() });
    const renewer = createAcmeDomainRenewer({
      acme,
      store,
      generateCsr: vi.fn(() => validCsr),
      generatePrivateKeyPem: () => {
        throw new Error('openssl_unavailable');
      },
    });

    const out = await renewer.issueInitialDomain({ domain: 'alice.recued.net' });

    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(acme.issueCert).not.toHaveBeenCalled();
    expect(calls.uploads).toHaveLength(0);
  });
});
