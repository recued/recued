/** D-235 P2 — the server-side issuance eligibility gate, the per-server cap,
 *  and the `collection.hostname.issuanceReadiness` rpc.
 *
 *  ⛔ Local policy, not authority. The boundary is cloud-side and lives in
 *  `backend/api/src/__tests__/d-235-custom-domain-authority.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import {
  CUSTOM_DOMAIN_MAX_PER_SERVER,
  evaluateCustomDomainIssuanceEligibility,
  evaluateCustomDomainPreflight,
  type CustomDomainDnsObservation,
  type CustomDomainIssuanceBlocker,
  type CustomDomainPreflightResult,
} from '@recued/contracts';
import {
  createHostnameRegistryStore,
  HostnameRegistryError,
} from '../storage/hostname-registry.js';
import {
  handleHostnameIssuanceReadiness,
  type HostnameRpcDeps,
} from '../hostname-handler.js';
import type { CustomDomainDnsResolver } from '../hostname/custom-domain-preflight.js';

const SERVER_ID = 'server-identity-1';
const CUSTOM = 'recued.their-domain.com';
const DDNS = 'alice.recued.net';
const DELEGATION_TARGET = '_acme-challenge.alice.recued.net';

const newStore = () => createHostnameRegistryStore(new Database(':memory:'));

const preflightWith = (
  overrides: Partial<CustomDomainDnsObservation> = {},
): CustomDomainPreflightResult =>
  evaluateCustomDomainPreflight({
    hostname: CUSTOM,
    handle: 'alice',
    observation: {
      host_cnames: [DDNS],
      host_addresses: [],
      ddns_addresses: [],
      delegation_cnames: [DELEGATION_TARGET],
      caa_records: [],
      ...overrides,
    },
  });

const READY_ROW = {
  cert_source: 'recued_acme_custom',
  ownership_status: 'verified',
  verification_method: 'dns_txt',
  enabled: true,
};

const gate = (
  overrides: Partial<Parameters<typeof evaluateCustomDomainIssuanceEligibility>[0]> = {},
) =>
  evaluateCustomDomainIssuanceEligibility({
    row: READY_ROW,
    preflight: preflightWith(),
    subscription_active: true,
    enrolled_custom_count: 1,
    ...overrides,
  });

const blockers = (
  overrides: Parameters<typeof gate>[0] = {},
): CustomDomainIssuanceBlocker[] => gate(overrides).blockers;

describe('D-235 § 3.2 — the composed issuance gate', () => {
  it('passes a fully configured custom hostname', () => {
    const decision = gate();
    expect(decision.eligible).toBe(true);
    expect(decision.blockers).toEqual([]);
    expect(decision.missing_caa_identifiers).toEqual([]);
  });

  it('declines any source other than recued_acme_custom, and alone', () => {
    // Nothing else is meaningful about a row the fleet will not issue for.
    for (const cert_source of ['recued_acme', 'byo_uploaded', 'byo_external']) {
      expect(
        blockers({ row: { ...READY_ROW, cert_source, enabled: false } }),
      ).toEqual(['not_a_custom_acme_hostname']);
    }
  });

  it('gate 1 — refuses an unverified hostname', () => {
    expect(
      blockers({ row: { ...READY_ROW, ownership_status: 'pending' } }),
    ).toContain('ownership_unverified');
  });

  it('⛔ gate 1 — a `verified` earned by cert_proof does NOT count', () => {
    // A row that was byo_uploaded, proved by cert, then switched source carries
    // a `verified` status earned by the one method § 3.2 excludes. Reading
    // ownership_status alone would let that stale proof through.
    const decision = gate({
      row: { ...READY_ROW, verification_method: 'cert_proof' },
    });
    expect(decision.blockers).toContain('ownership_proof_method_insufficient');
    expect(decision.blockers).not.toContain('ownership_unverified');
    expect(decision.eligible).toBe(false);
  });

  it('⛔ gate 2 — a MISSING preflight blocks; unknown fails CLOSED here', () => {
    // The inverse of the preflight's own rule, and deliberately so: a diagnosis
    // must not accuse, but a decision must not proceed on what it never checked.
    // Ordering against an unconfirmed delegation burns CA quota on a validation
    // that cannot pass.
    const decision = gate({ preflight: null });
    expect(decision.blockers).toEqual(['delegation_unchecked']);
    expect(decision.eligible).toBe(false);
  });

  it('gate 2 — refuses a missing delegation', () => {
    expect(blockers({ preflight: preflightWith({ delegation_cnames: [] }) })).toContain(
      'delegation_unverified',
    );
  });

  it('gate 2 — an UNRESOLVED delegation also blocks', () => {
    // `unknown` is not `pass`. The preflight rightly refuses to call it broken;
    // the gate rightly refuses to act on it.
    expect(
      blockers({
        preflight: preflightWith({
          delegation_cnames: [],
          delegation_resolver_error: true,
        }),
      }),
    ).toContain('delegation_unverified');
  });

  it('⚠ gate 3 — a PARTIAL CAA pass blocks, and names the records to add', () => {
    // § 5.2. `issue letsencrypt.org` alone is a common, deliberate config that
    // WOULD work today — and would then fail the first time the rotation picked
    // ZeroSSL, months later, with nothing to connect the outage to. Two CAA
    // records is a two-minute fix; refusing with the list is the kinder answer.
    const decision = gate({
      preflight: preflightWith({
        caa_records: [{ flags: 0, tag: 'issue', value: 'letsencrypt.org' }],
      }),
    });
    expect(decision.blockers).toContain('caa_blocks_rotation');
    expect(decision.missing_caa_identifiers).toEqual(['sectigo.com', 'pki.goog']);
    expect(decision.eligible).toBe(false);
  });

  it('gate 3 — a total CAA refusal lists the WHOLE rotation to add', () => {
    const decision = gate({
      preflight: preflightWith({
        caa_records: [{ flags: 0, tag: 'issue', value: 'digicert.com' }],
      }),
    });
    expect(decision.blockers).toContain('caa_blocks_rotation');
    expect(decision.missing_caa_identifiers).toEqual([
      'sectigo.com',
      'pki.goog',
      'letsencrypt.org',
    ]);
  });

  it('gate 3 — an UNRESOLVED CAA lookup blocks and lists the whole rotation', () => {
    const decision = gate({
      preflight: preflightWith({ caa_resolver_error: true }),
    });
    expect(decision.blockers).toContain('caa_blocks_rotation');
    expect(decision.missing_caa_identifiers).toHaveLength(3);
  });

  it('gate 3 — an absent CAA RRset passes', () => {
    expect(blockers()).not.toContain('caa_blocks_rotation');
  });

  it('gate 4 — refuses without an active subscription', () => {
    expect(blockers({ subscription_active: false })).toContain('subscription_inactive');
  });

  it('refuses a disabled hostname', () => {
    expect(blockers({ row: { ...READY_ROW, enabled: false } })).toContain(
      'hostname_disabled',
    );
  });

  it('refuses past the per-server cap', () => {
    expect(
      blockers({ enrolled_custom_count: CUSTOM_DOMAIN_MAX_PER_SERVER + 1 }),
    ).toContain('custom_hostname_cap_reached');
    expect(
      blockers({ enrolled_custom_count: CUSTOM_DOMAIN_MAX_PER_SERVER }),
    ).not.toContain('custom_hostname_cap_reached');
  });

  it('⚠ reports EVERY blocker at once, not the first', () => {
    // A gate that reports one reason at a time makes the user fix-and-retry N
    // times — and the CAA record and the delegation CNAME live in the same zone
    // editor, so they should be added in one visit.
    const decision = gate({
      row: { ...READY_ROW, ownership_status: 'pending', enabled: false },
      preflight: preflightWith({
        delegation_cnames: [],
        caa_records: [{ flags: 0, tag: 'issue', value: 'digicert.com' }],
      }),
      subscription_active: false,
      enrolled_custom_count: 99,
    });
    expect(decision.blockers).toEqual([
      'ownership_unverified',
      'delegation_unverified',
      'caa_blocks_rotation',
      'subscription_inactive',
      'hostname_disabled',
      'custom_hostname_cap_reached',
    ]);
  });
});

describe('D-235 § 7 — the per-server custom-hostname cap', () => {
  const enrol = (
    store: ReturnType<typeof newStore>,
    n: number,
  ): void => {
    for (let i = 0; i < n; i += 1) {
      store.upsert({
        server_identity_id: SERVER_ID,
        hostname: `host-${i}.their-domain.com`,
        cert_source: 'recued_acme_custom',
      });
    }
  };

  it(`admits ${CUSTOM_DOMAIN_MAX_PER_SERVER} and refuses the next`, () => {
    const store = newStore();
    enrol(store, CUSTOM_DOMAIN_MAX_PER_SERVER);
    try {
      store.upsert({
        server_identity_id: SERVER_ID,
        hostname: 'one-too-many.their-domain.com',
        cert_source: 'recued_acme_custom',
      });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as HostnameRegistryError).code).toBe('custom_hostname_cap_reached');
    }
  });

  it('⚠ lets an EXISTING custom row be re-saved at the cap', () => {
    // Keyed on the row not already BEING custom, not on the row not existing —
    // otherwise every update to an at-cap row would fail.
    const store = newStore();
    enrol(store, CUSTOM_DOMAIN_MAX_PER_SERVER);
    const updated = store.upsert({
      server_identity_id: SERVER_ID,
      hostname: 'host-0.their-domain.com',
      cert_source: 'recued_acme_custom',
      enabled: true,
    });
    expect(updated.enabled).toBe(true);
  });

  it('⚠ counts a source SWITCH against the cap', () => {
    // An existing byo row flipping to custom is a new claim on the fleet's ACME
    // budget; "it already exists" must not be a way around the limit.
    const store = newStore();
    enrol(store, CUSTOM_DOMAIN_MAX_PER_SERVER);
    store.upsert({
      server_identity_id: SERVER_ID,
      hostname: 'byo.their-domain.com',
      cert_source: 'byo_uploaded',
    });
    try {
      store.upsert({
        server_identity_id: SERVER_ID,
        hostname: 'byo.their-domain.com',
        cert_source: 'recued_acme_custom',
      });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as HostnameRegistryError).code).toBe('custom_hostname_cap_reached');
    }
  });

  it('does not count fleet-zone or BYO rows toward the cap', () => {
    const store = newStore();
    store.upsert({
      server_identity_id: SERVER_ID,
      hostname: DDNS,
      cert_source: 'recued_acme',
    });
    for (let i = 0; i < 10; i += 1) {
      store.upsert({
        server_identity_id: SERVER_ID,
        hostname: `byo-${i}.example.com`,
        cert_source: 'byo_uploaded',
      });
    }
    expect(
      store.upsert({
        server_identity_id: SERVER_ID,
        hostname: CUSTOM,
        cert_source: 'recued_acme_custom',
      }).cert_source,
    ).toBe('recued_acme_custom');
  });

  it('frees a slot when a custom row is removed', () => {
    const store = newStore();
    enrol(store, CUSTOM_DOMAIN_MAX_PER_SERVER);
    expect(store.remove('host-0.their-domain.com')).toBe(true);
    expect(
      store.upsert({
        server_identity_id: SERVER_ID,
        hostname: CUSTOM,
        cert_source: 'recued_acme_custom',
      }).hostname,
    ).toBe(CUSTOM);
  });
});

describe('D-235 — collection.hostname.issuanceReadiness', () => {
  const caller = { instance_id: 'client-1' };

  const stubResolver = (delegated: boolean): CustomDomainDnsResolver => {
    const notFound = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const cname: Record<string, string[]> = {
      [CUSTOM]: [DDNS],
      ...(delegated ? { [`_acme-challenge.${CUSTOM}`]: [DELEGATION_TARGET] } : {}),
    };
    return {
      resolveCname: async (name) => {
        const hit = cname[name];
        if (!hit) throw notFound;
        return hit;
      },
      resolve4: async () => {
        throw notFound;
      },
      resolve6: async () => {
        throw notFound;
      },
      resolveCaa: async () => {
        throw notFound;
      },
    };
  };

  const mkDeps = (opts: {
    delegated?: boolean;
    subscription_active?: boolean;
    enrol?: boolean;
    verified?: boolean;
  } = {}): HostnameRpcDeps => {
    const store = newStore();
    if (opts.enrol !== false) {
      store.upsert({
        server_identity_id: SERVER_ID,
        hostname: CUSTOM,
        cert_source: 'recued_acme_custom',
        enabled: true,
        ...(opts.verified !== false
          ? { ownership_status: 'verified' as const, verification_method: 'dns_txt' as const }
          : {}),
      });
    }
    return {
      store,
      serverIdentityId: SERVER_ID,
      proDdnsBinding: async () => ({
        handle: 'alice',
        subscription_active: opts.subscription_active !== false,
      }),
      dnsResolver: stubResolver(opts.delegated !== false),
    };
  };

  it('reports ready for a fully configured hostname', async () => {
    const res = await handleHostnameIssuanceReadiness(mkDeps(), { hostname: CUSTOM }, caller);
    expect(res.decision.eligible).toBe(true);
    expect(res.decision.blockers).toEqual([]);
    // The preflight the decision was made on rides along, so the panel renders
    // one view rather than asking twice and getting two answers.
    expect(res.preflight.hostname).toBe(CUSTOM);
  });

  it('declines an un-enrolled hostname as not-a-custom-row', async () => {
    const res = await handleHostnameIssuanceReadiness(
      mkDeps({ enrol: false }),
      { hostname: CUSTOM },
      caller,
    );
    expect(res.decision.blockers).toEqual(['not_a_custom_acme_hostname']);
  });

  it('surfaces a broken delegation and a lapsed subscription together', async () => {
    const res = await handleHostnameIssuanceReadiness(
      mkDeps({ delegated: false, subscription_active: false, verified: false }),
      { hostname: CUSTOM },
      caller,
    );
    expect(res.decision.blockers).toEqual([
      'ownership_unverified',
      'delegation_unverified',
      'subscription_inactive',
    ]);
  });

  it('requires a paired client', async () => {
    await expect(
      handleHostnameIssuanceReadiness(mkDeps(), { hostname: CUSTOM }, undefined),
    ).rejects.toThrow(/requires a paired client/);
  });

  it('mutates nothing', async () => {
    const deps = mkDeps();
    const before = deps.store.get(CUSTOM);
    await handleHostnameIssuanceReadiness(deps, { hostname: CUSTOM }, caller);
    expect(deps.store.get(CUSTOM)).toEqual(before);
  });
});
