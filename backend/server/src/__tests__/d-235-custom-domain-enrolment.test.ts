/** D-235 P1 — custom-domain enrolment: registry rules, the CHECK migration,
 *  the ownership gate, and the DNS preflight engine. */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import {
  createHostnameRegistryStore,
  ensureHostnameRegistrySchema,
  HostnameRegistryError,
} from '../storage/hostname-registry.js';
import { applyHostnameOwnershipProof } from '../hostname/ownership-proof.js';
import {
  flattenNodeCaaRecords,
  isDnsNameNotFound,
  observeCustomDomainDns,
  resolveRelevantCaaRrset,
  runCustomDomainPreflight,
  type CustomDomainDnsResolver,
} from '../hostname/custom-domain-preflight.js';
import {
  handleHostnameAdd,
  handleHostnamePreflight,
  type HostnameRpcDeps,
} from '../hostname-handler.js';
import type { CaaRecord } from '@recued/contracts';

const SERVER_ID = 'server-identity-1';
const CUSTOM = 'recued.their-domain.com';
const DDNS = 'alice.recued.net';
const DELEGATION_TARGET = '_acme-challenge.alice.recued.net';

const newStore = () => {
  const db = new Database(':memory:');
  return { db, store: createHostnameRegistryStore(db) };
};

// ── registry ────────────────────────────────────────────────────────────

describe('D-235 — the hostname registry accepts recued_acme_custom', () => {
  it('parks a custom row at `pending`, NOT verified', () => {
    // The whole security question of § 2.6 in one assertion. `recued_acme`
    // skips straight to `verified` because the fleet owns the zone; a custom
    // hostname must not inherit that, and it does not — it falls into the else
    // branch and gets the safe default for free.
    const { store } = newStore();
    const row = store.upsert({
      server_identity_id: SERVER_ID,
      hostname: CUSTOM,
      cert_source: 'recued_acme_custom',
    });
    expect(row.cert_source).toBe('recued_acme_custom');
    expect(row.ownership_status).toBe('pending');
    expect(row.tls_topology).toBe('server_terminated');
  });

  it('still auto-verifies a fleet-zone recued_acme row', () => {
    const { store } = newStore();
    const row = store.upsert({
      server_identity_id: SERVER_ID,
      hostname: DDNS,
      cert_source: 'recued_acme',
    });
    expect(row.ownership_status).toBe('verified');
  });

  it('refuses a fleet-zone hostname under the custom source', () => {
    const { store } = newStore();
    expect(() =>
      store.upsert({
        server_identity_id: SERVER_ID,
        hostname: DDNS,
        cert_source: 'recued_acme_custom',
      }),
    ).toThrow(HostnameRegistryError);
    try {
      store.upsert({
        server_identity_id: SERVER_ID,
        hostname: DDNS,
        cert_source: 'recued_acme_custom',
      });
    } catch (err) {
      expect((err as HostnameRegistryError).code).toBe('invalid_custom_acme_hostname');
    }
  });

  it('still refuses a custom hostname under the fleet-zone source', () => {
    const { store } = newStore();
    try {
      store.upsert({
        server_identity_id: SERVER_ID,
        hostname: CUSTOM,
        cert_source: 'recued_acme',
      });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as HostnameRegistryError).code).toBe('invalid_recued_acme_hostname');
    }
  });

  it('refuses to mark a custom hostname ddns_managed', () => {
    // The fleet writes no A record for a domain it does not own.
    const { store } = newStore();
    try {
      store.upsert({
        server_identity_id: SERVER_ID,
        hostname: CUSTOM,
        cert_source: 'recued_acme_custom',
        ddns_managed: true,
      });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as HostnameRegistryError).code).toBe('invalid_ddns_managed_hostname');
    }
  });
});

describe('D-235 — the cert_source CHECK migration', () => {
  /** The pre-D-235 table, verbatim, so the migration is exercised against the
   *  shape a real server is running rather than a shape written to pass. */
  const LEGACY_DDL = `
    CREATE TABLE hostname_registry (
      hostname_id TEXT PRIMARY KEY,
      server_identity_id TEXT NOT NULL,
      hostname_normalized TEXT NOT NULL UNIQUE,
      cert_source TEXT NOT NULL CHECK (cert_source IN ('recued_acme', 'byo_uploaded', 'byo_external')),
      cert_blob_id TEXT,
      cert_fingerprint TEXT,
      cert_expires_at INTEGER,
      cert_chain_metadata_json TEXT,
      ownership_status TEXT NOT NULL DEFAULT 'pending' CHECK (ownership_status IN ('pending', 'verified', 'failed')),
      verification_method TEXT CHECK (verification_method IN ('cert_proof', 'http_token', 'dns_txt')),
      verification_token_hash TEXT,
      verified_at INTEGER,
      listener_ports_json TEXT NOT NULL,
      ddns_managed INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      tls_topology TEXT NOT NULL CHECK (tls_topology IN ('server_terminated', 'upstream_terminated')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX hostname_registry_by_server ON hostname_registry(server_identity_id);
  `;

  const legacyDb = (): Database.Database => {
    const db = new Database(':memory:');
    db.exec(LEGACY_DDL);
    db.prepare(
      `INSERT INTO hostname_registry (
         hostname_id, server_identity_id, hostname_normalized, cert_source,
         ownership_status, verification_method, verification_token_hash,
         listener_ports_json, ddns_managed, enabled, tls_topology,
         created_at, updated_at
       ) VALUES (
         'h1', @sid, @host, 'byo_uploaded', 'verified', 'cert_proof', 'hash-1',
         '[443]', 0, 1, 'server_terminated', 100, 200
       )`,
    ).run({ sid: SERVER_ID, host: 'legacy.example.com' });
    return db;
  };

  it('widens the constraint and keeps every existing row', () => {
    const db = legacyDb();
    // A legacy DB genuinely refuses the new value before the migration.
    expect(() =>
      db
        .prepare(
          `UPDATE hostname_registry SET cert_source = 'recued_acme_custom' WHERE hostname_id = 'h1'`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);

    const store = createHostnameRegistryStore(db);
    const legacy = store.get('legacy.example.com');
    expect(legacy).not.toBeNull();
    expect(legacy?.cert_source).toBe('byo_uploaded');
    expect(legacy?.ownership_status).toBe('verified');
    expect(legacy?.verification_token_hash).toBe('hash-1');
    expect(legacy?.created_at).toBe(100);

    // …and now accepts one.
    const row = store.upsert({
      server_identity_id: SERVER_ID,
      hostname: CUSTOM,
      cert_source: 'recued_acme_custom',
    });
    expect(row.cert_source).toBe('recued_acme_custom');
  });

  it('restores the indexes the rebuild dropped', () => {
    // ⛔ DROP TABLE takes its indexes with it. Without re-creating them AFTER
    //    the rebuild, the server runs the rest of that boot unindexed and
    //    nothing says so.
    const db = legacyDb();
    createHostnameRegistryStore(db);
    const indexes = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'hostname_registry'`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain('hostname_registry_by_server');
    expect(indexes).toContain('hostname_registry_by_status');
  });

  it('is idempotent — a second boot does not rebuild again', () => {
    const db = legacyDb();
    createHostnameRegistryStore(db);
    const afterFirst = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hostname_registry'`,
      )
      .get() as { sql: string };
    ensureHostnameRegistrySchema(db);
    ensureHostnameRegistrySchema(db);
    const afterThird = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hostname_registry'`,
      )
      .get() as { sql: string };
    expect(afterThird.sql).toBe(afterFirst.sql);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM hostname_registry`).get() as { n: number },
    ).toEqual({ n: 1 });
    // No rebuild scratch table survives.
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE name = 'hostname_registry_rebuild'`,
        )
        .get(),
    ).toBeUndefined();
  });
});

// ── ownership proof ─────────────────────────────────────────────────────

describe('D-235 § 3.2 — the ownership gate for a fleet-issued custom domain', () => {
  const withCustomRow = () => {
    const { store } = newStore();
    store.upsert({
      server_identity_id: SERVER_ID,
      hostname: CUSTOM,
      cert_source: 'recued_acme_custom',
      verification_token_hash: 'token-hash',
    });
    return store;
  };

  it('accepts dns_txt', () => {
    const result = applyHostnameOwnershipProof(withCustomRow(), {
      hostname: CUSTOM,
      method: 'dns_txt',
      observed_token_hash: 'token-hash',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe('verified');
  });

  it('accepts http_token', () => {
    const store = newStore().store;
    store.upsert({
      server_identity_id: SERVER_ID,
      hostname: CUSTOM,
      cert_source: 'recued_acme_custom',
      verification_method: 'http_token',
      verification_token_hash: 'token-hash',
    });
    const result = applyHostnameOwnershipProof(store, {
      hostname: CUSTOM,
      method: 'http_token',
      observed_token_hash: 'token-hash',
    });
    expect(result.ok).toBe(true);
  });

  it('records `failed` when the observed token does not match', () => {
    const result = applyHostnameOwnershipProof(withCustomRow(), {
      hostname: CUSTOM,
      method: 'dns_txt',
      observed_token_hash: 'wrong',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe('failed');
  });

  it('⛔ REFUSES cert_proof — it is not authority to MINT', () => {
    // § 3.2's ⛔. Possession of a cert for the name proves someone once got
    // one; as authority to issue a new one it is circular, and a stale or
    // leaked chain carries it. The distinct code exists so the user is told
    // why rather than just "incompatible".
    const result = applyHostnameOwnershipProof(withCustomRow(), {
      hostname: CUSTOM,
      method: 'cert_proof',
      cert_matches_hostname: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('cert_proof_insufficient');
      expect(result.cert_source).toBe('recued_acme_custom');
    }
  });

  it('leaves the row unverified after a refused cert_proof', () => {
    const store = withCustomRow();
    applyHostnameOwnershipProof(store, {
      hostname: CUSTOM,
      method: 'cert_proof',
      cert_matches_hostname: true,
    });
    expect(store.get(CUSTOM)?.ownership_status).toBe('pending');
  });

  it('still pre-verifies a fleet-zone recued_acme row rather than taking a proof', () => {
    const { store } = newStore();
    store.upsert({
      server_identity_id: SERVER_ID,
      hostname: DDNS,
      cert_source: 'recued_acme',
    });
    const result = applyHostnameOwnershipProof(store, {
      hostname: DDNS,
      method: 'dns_txt',
      observed_token_hash: 'anything',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('recued_acme_preverified');
  });

  it('still accepts cert_proof for a byo_uploaded hostname', () => {
    // The refusal is scoped to fleet issuance, not to the method itself.
    const { store } = newStore();
    store.upsert({
      server_identity_id: SERVER_ID,
      hostname: 'byo.example.com',
      cert_source: 'byo_uploaded',
    });
    const result = applyHostnameOwnershipProof(store, {
      hostname: 'byo.example.com',
      method: 'cert_proof',
      cert_matches_hostname: true,
    });
    expect(result.ok).toBe(true);
  });
});

// ── preflight engine ────────────────────────────────────────────────────

class DnsError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const NXDOMAIN = new DnsError('ENOTFOUND');
const SERVFAIL = new DnsError('ESERVFAIL');

interface StubZone {
  cname?: Record<string, string[] | Error>;
  a?: Record<string, string[] | Error>;
  aaaa?: Record<string, string[] | Error>;
  caa?: Record<string, CaaRecord[] | Error>;
}

const stubResolver = (zone: StubZone): CustomDomainDnsResolver => {
  const answer = async <T>(
    table: Record<string, T[] | Error> | undefined,
    name: string,
  ): Promise<ReadonlyArray<T>> => {
    const hit = table?.[name];
    if (hit === undefined) throw NXDOMAIN;
    if (hit instanceof Error) throw hit;
    return hit;
  };
  return {
    resolveCname: (name) => answer(zone.cname, name),
    resolve4: (name) => answer(zone.a, name),
    resolve6: (name) => answer(zone.aaaa, name),
    resolveCaa: (name) => answer(zone.caa, name),
  };
};

const preflight = (zone: StubZone) =>
  runCustomDomainPreflight({
    hostname: CUSTOM,
    handle: 'alice',
    resolver: stubResolver(zone),
  });

describe('D-235 — preflight over DNS', () => {
  it('passes a correctly delegated domain', async () => {
    const result = await preflight({
      cname: {
        [CUSTOM]: [DDNS],
        [`_acme-challenge.${CUSTOM}`]: [DELEGATION_TARGET],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.ddns_hostname).toBe(DDNS);
  });

  it('reports a missing delegation as missing', async () => {
    const result = await preflight({ cname: { [CUSTOM]: [DDNS] } });
    const delegation = result.checks.find((c) => c.check === 'acme_delegation')!;
    expect(delegation.code).toBe('delegation_missing');
  });

  it('⛔ SERVFAIL on the delegation is `unknown`, not `missing`', async () => {
    const result = await preflight({
      cname: { [CUSTOM]: [DDNS], [`_acme-challenge.${CUSTOM}`]: SERVFAIL },
    });
    const delegation = result.checks.find((c) => c.check === 'acme_delegation')!;
    expect(delegation.status).toBe('unknown');
    expect(delegation.code).toBe('delegation_resolver_error');
    expect(result.blocking_failure).toBe(false);
  });

  it('trailing dots in resolver output still match', async () => {
    const result = await preflight({
      cname: {
        [CUSTOM]: [`${DDNS}.`],
        [`_acme-challenge.${CUSTOM}`]: [`${DELEGATION_TARGET}.`],
      },
    });
    expect(result.ok).toBe(true);
  });

  it('a flattened apex is compared against the DDNS name\'s own addresses', async () => {
    const result = await preflight({
      a: { [CUSTOM]: ['203.0.113.7'], [DDNS]: ['203.0.113.7'] },
      cname: { [`_acme-challenge.${CUSTOM}`]: [DELEGATION_TARGET] },
    });
    const host = result.checks.find((c) => c.check === 'host_route')!;
    expect(host.code).toBe('host_flattened_matches_ddns');
  });

  it('⛔ a SERVFAIL on the DDNS name does not condemn a correct flattened apex', async () => {
    const result = await preflight({
      a: { [CUSTOM]: ['203.0.113.7'], [DDNS]: SERVFAIL },
      cname: { [`_acme-challenge.${CUSTOM}`]: [DELEGATION_TARGET] },
    });
    const host = result.checks.find((c) => c.check === 'host_route')!;
    expect(host.status).toBe('unknown');
    expect(host.code).toBe('host_ddns_baseline_unavailable');
    expect(result.blocking_failure).toBe(false);
  });

  it('a failed AAAA alongside a good A is an answer, not an unknown', async () => {
    // Reporting `unknown` here would hide a perfectly good v4-only setup.
    const result = await preflight({
      a: { [CUSTOM]: ['203.0.113.7'], [DDNS]: ['203.0.113.7'] },
      aaaa: { [CUSTOM]: SERVFAIL },
      cname: { [`_acme-challenge.${CUSTOM}`]: [DELEGATION_TARGET] },
    });
    const host = result.checks.find((c) => c.check === 'host_route')!;
    expect(host.status).toBe('warn');
    expect(host.code).toBe('host_flattened_matches_ddns');
  });

  it('an unresolvable host is a failure, a SERVFAIL host is unknown', async () => {
    const missing = await preflight({
      cname: { [`_acme-challenge.${CUSTOM}`]: [DELEGATION_TARGET] },
    });
    expect(missing.checks.find((c) => c.check === 'host_route')!.code).toBe(
      'host_unresolved',
    );

    const broken = await preflight({
      cname: { [CUSTOM]: SERVFAIL, [`_acme-challenge.${CUSTOM}`]: [DELEGATION_TARGET] },
      a: { [CUSTOM]: SERVFAIL },
      aaaa: { [CUSTOM]: SERVFAIL },
    });
    expect(broken.checks.find((c) => c.check === 'host_route')!.status).toBe('unknown');
  });
});

describe('D-235 — the CAA climb', () => {
  it('stops at the first non-empty RRset', async () => {
    const found = await resolveRelevantCaaRrset(
      stubResolver({
        caa: {
          'their-domain.com': [{ flags: 0, tag: 'issue', value: 'letsencrypt.org' }],
        },
      }),
      CUSTOM,
    );
    expect(found.name).toBe('their-domain.com');
    expect(found.records).toHaveLength(1);
    expect(found.failed).toBe(false);
  });

  it('prefers the nearest RRset over an ancestor\'s', async () => {
    const found = await resolveRelevantCaaRrset(
      stubResolver({
        caa: {
          [CUSTOM]: [{ flags: 0, tag: 'issue', value: 'sectigo.com' }],
          'their-domain.com': [{ flags: 0, tag: 'issue', value: 'letsencrypt.org' }],
        },
      }),
      CUSTOM,
    );
    expect(found.name).toBe(CUSTOM);
    expect(found.records[0]?.value).toBe('sectigo.com');
  });

  it('⛔ a SERVFAIL mid-climb does NOT read as "unrestricted"', async () => {
    // Continuing the climb past a failure would reach `their-domain.com`, find
    // nothing, and report a false all-clear on the one check whose failure mode
    // is a renewal that dies months later.
    const found = await resolveRelevantCaaRrset(
      stubResolver({ caa: { [CUSTOM]: SERVFAIL } }),
      CUSTOM,
    );
    expect(found.failed).toBe(true);
    expect(found.records).toEqual([]);

    const result = await preflight({
      cname: {
        [CUSTOM]: [DDNS],
        [`_acme-challenge.${CUSTOM}`]: [DELEGATION_TARGET],
      },
      caa: { [CUSTOM]: SERVFAIL },
    });
    const caaCheck = result.checks.find((c) => c.check === 'caa')!;
    expect(caaCheck.status).toBe('unknown');
    expect(result.ok).toBe(false);
  });

  it('surfaces a blocking CAA as a blocking failure', async () => {
    const result = await preflight({
      cname: {
        [CUSTOM]: [DDNS],
        [`_acme-challenge.${CUSTOM}`]: [DELEGATION_TARGET],
      },
      caa: { 'their-domain.com': [{ flags: 0, tag: 'issue', value: 'digicert.com' }] },
    });
    expect(result.blocking_failure).toBe(true);
    expect(result.caa?.permitted_ca_ids).toEqual([]);
  });
});

describe('D-235 — resolver adapter helpers', () => {
  it('flattens node CAA objects into RFC 8659 triples', () => {
    expect(
      flattenNodeCaaRecords([
        { critical: 0, issue: 'letsencrypt.org' },
        { critical: 128, issue: 'sectigo.com' },
        { critical: 0, iodef: 'mailto:a@b.c' },
      ]),
    ).toEqual([
      { flags: 0, tag: 'issue', value: 'letsencrypt.org' },
      { flags: 128, tag: 'issue', value: 'sectigo.com' },
      { flags: 0, tag: 'iodef', value: 'mailto:a@b.c' },
    ]);
  });

  it('carries an UNKNOWN property through so the critical bit can be seen', () => {
    // Dropping it would turn "critical unknown tag forbids issuance" into a
    // silent pass — the record would be invisible to the evaluator.
    expect(flattenNodeCaaRecords([{ critical: 128, somethingnew: 'x' }])).toEqual([
      { flags: 128, tag: 'somethingnew', value: 'x' },
    ]);
  });

  it('separates "no such record" from "resolver failed"', () => {
    expect(isDnsNameNotFound(new DnsError('ENOTFOUND'))).toBe(true);
    expect(isDnsNameNotFound(new DnsError('ENODATA'))).toBe(true);
    expect(isDnsNameNotFound(new DnsError('ESERVFAIL'))).toBe(false);
    expect(isDnsNameNotFound(new DnsError('ETIMEOUT'))).toBe(false);
    expect(isDnsNameNotFound(new Error('boom'))).toBe(false);
  });

  it('observes against the DDNS host it was handed', async () => {
    const obs = await observeCustomDomainDns({
      hostname: CUSTOM,
      ddnsHostname: DDNS,
      resolver: stubResolver({ a: { [DDNS]: ['203.0.113.7'] } }),
    });
    expect(obs.ddns_addresses).toEqual(['203.0.113.7']);
  });
});

// ── rpc ─────────────────────────────────────────────────────────────────

describe('D-235 — collection.hostname.preflight', () => {
  const caller = { instance_id: 'client-1' };
  const baseDeps = (
    overrides: Partial<HostnameRpcDeps> = {},
  ): HostnameRpcDeps => ({
    store: newStore().store,
    serverIdentityId: SERVER_ID,
    proDdnsBinding: async () => ({ handle: 'alice', subscription_active: true }),
    dnsResolver: stubResolver({
      cname: {
        [CUSTOM]: [DDNS],
        [`_acme-challenge.${CUSTOM}`]: [DELEGATION_TARGET],
      },
    }),
    ...overrides,
  });

  it('preflights against THIS server\'s handle, not the caller\'s claim', async () => {
    const res = await handleHostnamePreflight(
      baseDeps(),
      { hostname: CUSTOM, handle: 'mallory' } as never,
      caller,
    );
    expect(res.preflight.ddns_hostname).toBe(DDNS);
    expect(res.preflight.required_records.delegation.value).toBe(DELEGATION_TARGET);
    expect(res.preflight.ok).toBe(true);
  });

  it('requires a paired client', async () => {
    await expect(
      handleHostnamePreflight(baseDeps(), { hostname: CUSTOM }, undefined),
    ).rejects.toThrow(/requires a paired client/);
  });

  it('declines when no Pro handle is reserved', async () => {
    await expect(
      handleHostnamePreflight(
        baseDeps({ proDdnsBinding: async () => null }),
        { hostname: CUSTOM },
        caller,
      ),
    ).rejects.toThrow(/no Pro DDNS handle is reserved/);
  });

  it('reports a broken delegation in the payload rather than throwing', async () => {
    const res = await handleHostnamePreflight(
      baseDeps({ dnsResolver: stubResolver({ cname: { [CUSTOM]: [DDNS] } }) }),
      { hostname: CUSTOM },
      caller,
    );
    expect(res.preflight.ok).toBe(false);
    expect(
      res.preflight.checks.find((c) => c.check === 'acme_delegation')!.code,
    ).toBe('delegation_missing');
  });

  it('does not create a registry row', async () => {
    const deps = baseDeps();
    await handleHostnamePreflight(deps, { hostname: CUSTOM }, caller);
    expect(deps.store.list()).toEqual([]);
  });
});

describe('D-235 P1 — enrolment issues NOTHING', () => {
  const caller = { instance_id: 'client-1' };

  it('adding a custom hostname does not reach the ACME issuer', async () => {
    // § 6 P1: "No issuance yet; the row parks at `pending`." The inline-issue
    // path in `withInitialRecuedAcmeCert` is gated on `cert_source ===
    // 'recued_acme'`, so a custom row returns before it — but that is exactly
    // the kind of guarantee that holds by accident until someone generalizes
    // the guard to `isFleetIssuedCertSource`, so it is asserted rather than
    // read.
    let issueCalls = 0;
    const deps: HostnameRpcDeps = {
      store: newStore().store,
      serverIdentityId: SERVER_ID,
      initialAcmeIssuer: () => ({
        issueInitialDomain: async () => {
          issueCalls += 1;
          return { ok: true as const, new_fingerprint: 'fp', cert_expires_at: 1 };
        },
      }),
    };
    const res = await handleHostnameAdd(
      deps,
      { hostname: CUSTOM, cert_source: 'recued_acme_custom' },
      caller,
    );
    expect(issueCalls).toBe(0);
    expect(res.hostname.ownership_status).toBe('pending');
    expect(res.hostname.cert_fingerprint).toBeUndefined();
  });

  it('still issues inline for a fresh fleet-zone recued_acme row', async () => {
    // The carve-out above must not have disabled the path it shares.
    let issueCalls = 0;
    const deps: HostnameRpcDeps = {
      store: newStore().store,
      serverIdentityId: SERVER_ID,
      initialAcmeIssuer: () => ({
        issueInitialDomain: async () => {
          issueCalls += 1;
          return { ok: true as const, new_fingerprint: 'fp', cert_expires_at: 1 };
        },
      }),
    };
    const res = await handleHostnameAdd(
      deps,
      { hostname: DDNS, cert_source: 'recued_acme' },
      caller,
    );
    expect(issueCalls).toBe(1);
    expect(res.hostname.cert_fingerprint).toBe('fp');
  });
});
