/** D-235 P3 — the `pro_acme_custom` source and the ordering path.
 *
 *  The theme of this file is that the new source member had to land in every
 *  reader AT ONCE. `TLSDomainCertSource` is a closed vocabulary whose misses are
 *  silent: an unrecognized source made a row invisible to `lookup()` (handshake
 *  serves nothing) AND excluded from the renewal filter (nothing renews it),
 *  while `rowToListEntry` cheerfully reported it as `byo_upload` — a certificate
 *  that is present, valid, unreachable, and labelled "you renew this".
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import {
  ACME_ISSUE_CERT_RATE_LIMIT_PER_DAY,
  CUSTOM_DOMAIN_MAX_PER_SERVER,
  TLS_DOMAIN_CERT_SOURCES,
  isFleetIssuedTlsDomainSource,
  isTLSDomainCertSource,
  type TLSDomainUploadVerifiers,
} from '@recued/contracts';
import { tlsDomainSourceForHostnameCertSource } from '@recued/server-tls';
import {
  createSqliteTlsDomainStore,
  ensureTlsDomainSchema,
} from '../tls/domain-store.js';
import { createAcmeDomainRenewer } from '../keys/rotation/acme-domain-renewer.js';
import {
  composeCustomDomainEnrollment,
  selectUnprovisionedCustomDomains,
} from '../composition/bin/wire-custom-domain-enrollment.js';
import { createHostnameRegistryStore } from '../storage/hostname-registry.js';
import { evaluateCustomDomainPreflight, type CustomDomainPreflightResult } from '@recued/contracts';

const CUSTOM = 'recued.their-domain.com';
const DDNS = 'alice.recued.net';
const SERVER_ID = 'server-identity-1';

// ── the vocabulary ──────────────────────────────────────────────────────

describe('D-235 — pro_acme_custom is a first-class TLS source', () => {
  it('is in the closed list and recognized by the contract predicate', () => {
    expect(TLS_DOMAIN_CERT_SOURCES).toEqual(['pro_acme', 'pro_acme_custom', 'byo_upload']);
    expect(isTLSDomainCertSource('pro_acme_custom')).toBe(true);
    expect(isTLSDomainCertSource('nonsense')).toBe(false);
  });

  it('counts as fleet-issued, which is what every renewal branch must ask', () => {
    expect(isFleetIssuedTlsDomainSource('pro_acme')).toBe(true);
    expect(isFleetIssuedTlsDomainSource('pro_acme_custom')).toBe(true);
    expect(isFleetIssuedTlsDomainSource('byo_upload')).toBe(false);
  });

  it('maps from the registry cert source onto the tls_domains source', () => {
    expect(tlsDomainSourceForHostnameCertSource('recued_acme')).toBe('pro_acme');
    expect(tlsDomainSourceForHostnameCertSource('recued_acme_custom')).toBe('pro_acme_custom');
    expect(tlsDomainSourceForHostnameCertSource('byo_uploaded')).toBe('byo_upload');
    expect(tlsDomainSourceForHostnameCertSource('byo_external')).toBeNull();
  });
});

// ── the store ───────────────────────────────────────────────────────────

/** Verifier seam stubs, matching the fixture the D-148 suites already use —
 *  what is under test here is source handling, not X.509 parsing. The cert
 *  carries its own domain so `extractSANs` can answer without a parser. */
const stubCertFor = (domain: string): string =>
  `-----BEGIN CERTIFICATE-----\n;DOMAIN=${domain};\nCERT_BODY\n-----END CERTIFICATE-----`;

const KEY_PEM = '-----BEGIN PRIVATE KEY-----\nKEY_BODY\n-----END PRIVATE KEY-----';

const stubVerifiers = (): TLSDomainUploadVerifiers => ({
  extractSANs: (cert: string) => {
    const m = cert.match(/;DOMAIN=([^;]+);/);
    return m ? [m[1]!] : ['stub.example'];
  },
  verifyKeyPair: () => true,
  verifyChain: () => true,
  readExpiresAt: () => Date.now() + 90 * 86_400_000,
});

const newDomainStore = () => {
  const db = new Database(':memory:');
  ensureTlsDomainSchema(db);
  const store = createSqliteTlsDomainStore({ db, verifiers: stubVerifiers() });
  return { db, store };
};

describe('D-235 — the tls_domains store round-trips the new source', () => {
  it('stores, looks up and lists a pro_acme_custom row', async () => {
    const { store } = newDomainStore();
    await store.upload({
      domain: CUSTOM,
      source: 'pro_acme_custom',
      cert_pem: stubCertFor(CUSTOM),
      private_key_pem: KEY_PEM,
    });
    // ⛔ `lookup()` returning null for an unrecognized source is why the
    //    vocabulary had to move atomically: a row the store cannot classify is
    //    a hostname the handshake serves nothing for.
    expect(store.lookup(CUSTOM)?.source).toBe('pro_acme_custom');
    expect(store.list().map((e) => e.source)).toEqual(['pro_acme_custom']);
  });

  it('stamps last_renewed_at for BOTH fleet sources, not just pro_acme', async () => {
    // The field the Doctor and the UI read to answer "is anything renewing
    // this?". Keyed on `=== 'pro_acme'` an auto-renewed custom cert reports as
    // never renewed.
    const { store } = newDomainStore();
    await store.upload({
      domain: CUSTOM, source: 'pro_acme_custom',
      cert_pem: stubCertFor(CUSTOM), private_key_pem: KEY_PEM,
    });
    await store.upload({
      domain: DDNS, source: 'pro_acme',
      cert_pem: stubCertFor(DDNS), private_key_pem: KEY_PEM,
    });
    await store.upload({
      domain: 'byo.example.com', source: 'byo_upload',
      cert_pem: stubCertFor('byo.example.com'), private_key_pem: KEY_PEM,
    });
    const bySource = new Map(store.list().map((e) => [e.source, e.last_renewed_at]));
    expect(bySource.get('pro_acme_custom')).toEqual(expect.any(Number));
    expect(bySource.get('pro_acme')).toEqual(expect.any(Number));
    expect(bySource.get('byo_upload')).toBeUndefined();
  });

  it('⛔⛔ DROPS an unknown-source row rather than reporting it as byo_upload', async () => {
    // The fallback used to be `: 'byo_upload'`, which is a silent MIS-LABEL:
    // a row written by a newer build the operator rolled back would be reported
    // as user-managed, excluded from every ACME renewal filter, and expire ~90
    // days later with nothing having said a word. Absent is loud; mislabelled
    // is not.
    const { db, store } = newDomainStore();
    await store.upload({
      domain: CUSTOM, source: 'pro_acme_custom',
      cert_pem: stubCertFor(CUSTOM), private_key_pem: KEY_PEM,
    });
    db.prepare(`UPDATE tls_domains SET source = 'from_the_future' WHERE domain = ?`).run(CUSTOM);
    expect(store.list()).toEqual([]);
    expect(store.listForHealthCheck()).toEqual([]);
    expect(store.lookup(CUSTOM)).toBeNull();
  });
});

// ── the renewer ─────────────────────────────────────────────────────────

const mkRenewer = (opts: {
  store: ReturnType<typeof newDomainStore>['store'];
  ownHandle?: string | null;
  onIssue?: (args: { handle: string; domain: string }) => void;
}) =>
  createAcmeDomainRenewer({
    acme: {
      async issueCert(args) {
        opts.onIssue?.({ handle: args.handle, domain: args.domain });
        return {
          // The issued cert must carry the ordered domain — the store's SAN
          // gate re-checks it on the way in, which is what would catch a
          // renewer that ordered one name and stored it under another.
          cert_pem: stubCertFor(args.domain),
          issuer_chain_pem: stubCertFor(args.domain),
          expires_at: Date.now() + 90 * 86_400_000,
          renewal_recommended_at: Date.now() + 60 * 86_400_000,
        };
      },
    },
    store: opts.store,
    generateCsr: () => '-----BEGIN CERTIFICATE REQUEST-----\nCSR\n-----END CERTIFICATE REQUEST-----',
    generatePrivateKeyPem: () => KEY_PEM,
    ...(opts.ownHandle !== undefined
      ? { resolveOwnHandle: () => opts.ownHandle ?? null }
      : {}),
  });

describe('D-235 — the renewer classifies before it orders', () => {
  it('orders a custom domain under the SERVER\'S OWN handle', async () => {
    // A fleet-zone row carries its handle IN the domain, which is why
    // `extractHandleStem` sufficed until now. A custom domain carries nothing
    // of the sort, so the handle must come from the reservation — and the cloud
    // checks that the delegation points into THAT handle's zone.
    const { store } = newDomainStore();
    const seen: { handle: string; domain: string }[] = [];
    const renewer = mkRenewer({ store, ownHandle: 'alice', onIssue: (a) => seen.push(a) });
    const result = await renewer.issueInitialDomain({ domain: CUSTOM });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ handle: 'alice', domain: CUSTOM }]);
    expect(store.lookup(CUSTOM)?.source).toBe('pro_acme_custom');
  });

  it('still derives the handle from the domain for a fleet-zone host', async () => {
    const { store } = newDomainStore();
    const seen: { handle: string; domain: string }[] = [];
    const renewer = mkRenewer({ store, ownHandle: 'someone-else', onIssue: (a) => seen.push(a) });
    await renewer.issueInitialDomain({ domain: DDNS });
    // ⚠ The DOMAIN wins for a fleet-zone host — `resolveOwnHandle` is the
    //   custom-domain fallback, not an override. Otherwise a stale reservation
    //   snapshot could order `alice.recued.net` under a different handle.
    expect(seen).toEqual([{ handle: 'alice', domain: DDNS }]);
    expect(store.lookup(DDNS)?.source).toBe('pro_acme');
  });

  it('declines a custom domain when no handle is reserved', async () => {
    const { store } = newDomainStore();
    const renewer = mkRenewer({ store, ownHandle: null });
    const result = await renewer.issueInitialDomain({ domain: CUSTOM });
    expect(result).toEqual({ ok: false, reason: 'helper_unavailable' });
  });

  it('declines a custom domain when the renewer has no handle resolver at all', async () => {
    // The pre-D-235 wiring. A composer that forgets to pass `resolveOwnHandle`
    // must fail closed, not fall back to something guessed from the domain.
    const { store } = newDomainStore();
    const renewer = mkRenewer({ store });
    expect(await renewer.issueInitialDomain({ domain: CUSTOM })).toEqual({
      ok: false,
      reason: 'helper_unavailable',
    });
  });

  it('⛔ is idempotent for a custom domain that already holds a cert', async () => {
    // Keyed on `=== 'pro_acme'` this fell through and ordered again on EVERY
    // call — burning the publisher's daily ceiling on a cert already held.
    const { store } = newDomainStore();
    let issues = 0;
    const renewer = mkRenewer({ store, ownHandle: 'alice', onIssue: () => { issues += 1; } });
    await renewer.issueInitialDomain({ domain: CUSTOM });
    await renewer.issueInitialDomain({ domain: CUSTOM });
    await renewer.issueInitialDomain({ domain: CUSTOM });
    expect(issues).toBe(1);
  });

  it('renews a custom row under its own source, reusing the keypair', async () => {
    const { store } = newDomainStore();
    const renewer = mkRenewer({ store, ownHandle: 'alice' });
    await renewer.issueInitialDomain({ domain: CUSTOM });
    const renewed = await renewer.renewDomain({ domain: CUSTOM });
    expect(renewed.ok).toBe(true);
    expect(store.lookup(CUSTOM)?.source).toBe('pro_acme_custom');
  });
});

// ── the enrollment driver ───────────────────────────────────────────────

const preflightFor = (hostname: string, delegated: boolean): CustomDomainPreflightResult =>
  evaluateCustomDomainPreflight({
    hostname,
    handle: 'alice',
    observation: {
      host_cnames: [DDNS],
      host_addresses: [],
      ddns_addresses: [],
      delegation_cnames: delegated ? ['_acme-challenge.alice.recued.net'] : [],
      caa_records: [],
    },
  });

interface FakeInterval {
  name: string;
  tick: () => Promise<void>;
  fireImmediate?: boolean;
}

const mkRegistryStub = () => {
  const intervals: FakeInterval[] = [];
  return {
    intervals,
    registry: {
      registerInterval: (spec: FakeInterval) => intervals.push(spec),
    } as never,
  };
};

const seedCustomRows = (hostnames: string[]) => {
  const store = createHostnameRegistryStore(new Database(':memory:'));
  for (const hostname of hostnames) {
    store.upsert({
      server_identity_id: SERVER_ID,
      hostname,
      cert_source: 'recued_acme_custom',
      ownership_status: 'verified',
      verification_method: 'dns_txt',
      enabled: true,
    });
  }
  return store;
};

describe('D-235 — the custom-domain enrollment driver', () => {
  it('selects only enrolled custom rows with no certificate', () => {
    const store = seedCustomRows([CUSTOM, 'second.their-domain.com']);
    store.upsert({
      server_identity_id: SERVER_ID, hostname: DDNS, cert_source: 'recued_acme',
    });
    store.upsert({
      server_identity_id: SERVER_ID, hostname: 'byo.example.com', cert_source: 'byo_uploaded',
    });
    store.upsert({
      server_identity_id: SERVER_ID,
      hostname: CUSTOM,
      cert_source: 'recued_acme_custom',
      ownership_status: 'verified',
      verification_method: 'dns_txt',
      cert_fingerprint: 'already-done',
      enabled: true,
    });
    expect(
      selectUnprovisionedCustomDomains(store.list()).map((r) => r.hostname),
    ).toEqual(['second.their-domain.com']);
  });

  const drive = async (opts: {
    hostnames: string[];
    delegated?: boolean;
    subscription_active?: boolean;
    issuer?: boolean;
  }) => {
    const store = seedCustomRows(opts.hostnames);
    const { intervals, registry } = mkRegistryStub();
    const issued: string[] = [];
    const renewed: string[] = [];
    composeCustomDomainEnrollment({
      registry,
      hostnameRegistry: store,
      getInitialAcmeIssuer: () =>
        opts.issuer === false
          ? undefined
          : {
              async issueInitialDomain({ domain }) {
                issued.push(domain);
                return {
                  ok: true as const,
                  new_fingerprint: `fp-${domain}`,
                  cert_expires_at: Date.now() + 90 * 86_400_000,
                };
              },
              async renewDomain({ domain }) {
                renewed.push(domain);
                return {
                  ok: true as const,
                  new_fingerprint: `fp2-${domain}`,
                  cert_expires_at: Date.now() + 90 * 86_400_000,
                };
              },
            },
      runPreflight: async (hostname) => preflightFor(hostname, opts.delegated !== false),
      readProDdnsBinding: async () => ({
        subscription_active: opts.subscription_active !== false,
      }),
      serverIdentityId: () => SERVER_ID,
    });
    return { store, issued, renewed, tick: intervals[0]!.tick, spec: intervals[0]! };
  };

  it('orders an eligible custom domain and records it ready', async () => {
    const { store, issued, tick } = await drive({ hostnames: [CUSTOM] });
    await tick();
    expect(issued).toEqual([CUSTOM]);
    const row = store.get(CUSTOM);
    expect(row?.cert_fingerprint).toBe(`fp-${CUSTOM}`);
    expect(row?.cert_provisioning).toBe('ready');
  });

  it('⚠ orders ONE domain per tick, not all of them', async () => {
    // Each issuance is a CA round-trip plus the cloud's DNS-01 propagation
    // hold; five back to back inside one tick would hold the service busy for
    // minutes and could spend the publisher's whole daily ceiling before the
    // operator saw the first failure.
    const { issued, tick } = await drive({
      hostnames: [CUSTOM, 'b.their-domain.com', 'c.their-domain.com'],
    });
    await tick();
    expect(issued).toHaveLength(1);
    await tick();
    expect(issued).toHaveLength(2);
  });

  it('⛔ refuses to order when the gate says no, and does NOT mark it failed', async () => {
    // Nothing was attempted — the user has DNS to fix. A row reading "failed"
    // would say "Recued tried and the CA said no", which is a different and
    // wrong story.
    const { store, issued, tick } = await drive({ hostnames: [CUSTOM], delegated: false });
    await tick();
    expect(issued).toEqual([]);
    const row = store.get(CUSTOM);
    expect(row?.cert_provisioning).toBeUndefined();
    expect(row?.cert_fingerprint).toBeUndefined();
  });

  it('refuses to order without an active subscription', async () => {
    const { issued, tick } = await drive({ hostnames: [CUSTOM], subscription_active: false });
    await tick();
    expect(issued).toEqual([]);
  });

  it('does nothing at all when no custom rows are enrolled', async () => {
    const { issued, tick } = await drive({ hostnames: [] });
    await tick();
    expect(issued).toEqual([]);
  });

  it('does not order while the ACME issuer has not composed yet', async () => {
    const { issued, tick } = await drive({ hostnames: [CUSTOM], issuer: false });
    await tick();
    expect(issued).toEqual([]);
  });

  it('is not scheduled to fire inside the boot path', async () => {
    // Unlike the fleet-zone service there is nothing to race to, and an
    // immediate fire would spend a DNS preflight per enrolled domain at boot.
    const { spec } = await drive({ hostnames: [CUSTOM] });
    expect(spec.fireImmediate).toBe(false);
    expect(spec.name).toBe('custom-domain-enrollment');
  });

  it('re-ticking after success does not re-order', async () => {
    const { issued, tick } = await drive({ hostnames: [CUSTOM] });
    await tick();
    await tick();
    await tick();
    expect(issued).toEqual([CUSTOM]);
  });
});

// ── the rate limit ──────────────────────────────────────────────────────

describe('D-235 — the ACME daily ceiling', () => {
  it('is derived from the custom-domain cap, so the two cannot drift', () => {
    expect(ACME_ISSUE_CERT_RATE_LIMIT_PER_DAY).toBe(
      (1 + CUSTOM_DOMAIN_MAX_PER_SERVER) * 2,
    );
  });

  it('leaves room for a full first-day enrolment plus one complete retry', () => {
    // One Pro DDNS host + the cap of custom domains is the legitimate first-day
    // demand; the old flat 8 left two attempts for the rest of the day.
    const fullEnrolment = 1 + CUSTOM_DOMAIN_MAX_PER_SERVER;
    expect(ACME_ISSUE_CERT_RATE_LIMIT_PER_DAY).toBeGreaterThanOrEqual(fullEnrolment * 2);
  });
});
