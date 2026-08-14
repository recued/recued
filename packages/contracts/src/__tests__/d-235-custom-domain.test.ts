/** D-235 P1 — bring-your-own-domain preflight contracts. */

import { describe, it, expect } from 'vitest';
import {
  ACME_ROTATION_CAS,
  CAA_ISSUER_CRITICAL_FLAG,
  HOSTNAME_CERT_SOURCES,
  SERVER_RPC_METHODS,
  acmeChallengeName,
  caaClimbNames,
  caaIssuerDomain,
  customDomainDelegationTarget,
  evaluateCaaForRotation,
  evaluateCustomDomainPreflight,
  isFleetIssuedCertSource,
  isLikelyZoneApex,
  normalizeDnsName,
  tlsTopologyForHostnameCertSource,
  type CaaRecord,
  type CustomDomainDnsObservation,
} from '../index.js';

const HANDLE = 'alice';
const DDNS = 'alice.recued.net';
const HOST = 'recued.their-domain.com';
const DELEGATION_NAME = '_acme-challenge.recued.their-domain.com';
const DELEGATION_TARGET = '_acme-challenge.alice.recued.net';

const caa = (tag: string, value: string, flags = 0): CaaRecord => ({
  flags,
  tag,
  value,
});

const observation = (
  overrides: Partial<CustomDomainDnsObservation> = {},
): CustomDomainDnsObservation => ({
  host_cnames: [],
  host_addresses: [],
  ddns_addresses: [],
  delegation_cnames: [],
  caa_records: [],
  ...overrides,
});

const evaluate = (obs: CustomDomainDnsObservation) =>
  evaluateCustomDomainPreflight({
    hostname: HOST,
    handle: HANDLE,
    observation: obs,
  });

const checkFor = (
  result: ReturnType<typeof evaluate>,
  check: 'host_route' | 'acme_delegation' | 'caa',
) => result.checks.find((c) => c.check === check)!;

describe('D-235 — the custom ACME cert source', () => {
  it('is a distinct member, not a relaxation of recued_acme', () => {
    expect(HOSTNAME_CERT_SOURCES).toContain('recued_acme');
    expect(HOSTNAME_CERT_SOURCES).toContain('recued_acme_custom');
    expect(new Set(HOSTNAME_CERT_SOURCES).size).toBe(HOSTNAME_CERT_SOURCES.length);
  });

  it('terminates TLS on the server, like every non-external source', () => {
    expect(tlsTopologyForHostnameCertSource('recued_acme_custom')).toBe(
      'server_terminated',
    );
  });

  it('counts as fleet-issued alongside recued_acme', () => {
    expect(isFleetIssuedCertSource('recued_acme_custom')).toBe(true);
    expect(isFleetIssuedCertSource('recued_acme')).toBe(true);
    expect(isFleetIssuedCertSource('byo_uploaded')).toBe(false);
    expect(isFleetIssuedCertSource('byo_external')).toBe(false);
  });

  it('registers the preflight rpc in the server method list', () => {
    expect(SERVER_RPC_METHODS).toContain('collection.hostname.preflight');
  });
});

describe('D-235 § 3.1 — the two record names', () => {
  it('derives the challenge name the CA will read', () => {
    expect(acmeChallengeName(HOST)).toBe(DELEGATION_NAME);
  });

  it('points the delegation at the name the fleet ALREADY writes TXT to', () => {
    // § 2.4 / § 3.3 — the load-bearing coincidence. If this ever stops matching
    // `_acme-challenge.<hostnameForHandle(handle)>`, the DNS write side would
    // have to change, which is the one thing D-235 promises it does not.
    expect(customDomainDelegationTarget(HANDLE)).toBe(DELEGATION_TARGET);
    expect(customDomainDelegationTarget(HANDLE)).toBe(acmeChallengeName(DDNS));
  });

  it('folds trailing dots and case, so one name never reads as two', () => {
    expect(normalizeDnsName('Recued.Their-Domain.COM.')).toBe(HOST);
    expect(acmeChallengeName('RECUED.their-domain.com.')).toBe(DELEGATION_NAME);
  });

  it('flags a two-label hostname as an apex CNAME risk', () => {
    expect(isLikelyZoneApex('their-domain.com')).toBe(true);
    expect(isLikelyZoneApex(HOST)).toBe(false);
  });
});

describe('D-235 § 5.2 — CAA against the whole rotation', () => {
  const caIds = ACME_ROTATION_CAS.map((c) => c.id);

  it('permits everything when no CAA RRset exists', () => {
    const result = evaluateCaaForRotation([]);
    expect(result.status).toBe('pass');
    expect(result.code).toBe('caa_absent');
    expect(result.permitted_ca_ids).toEqual(caIds);
  });

  it('permits everything when the RRset carries no issue tag', () => {
    const result = evaluateCaaForRotation([caa('iodef', 'mailto:x@example.com')]);
    expect(result.status).toBe('pass');
    expect(result.code).toBe('caa_absent');
  });

  it('passes when every rotation CA is named', () => {
    const result = evaluateCaaForRotation([
      caa('issue', 'sectigo.com'),
      caa('issue', 'pki.goog'),
      caa('issue', 'letsencrypt.org'),
    ]);
    expect(result.status).toBe('pass');
    expect(result.code).toBe('caa_permits_all_rotation_cas');
    expect(result.blocked_ca_ids).toEqual([]);
  });

  it('reports a PARTIAL pass as partial — the intermittent-renewal shape', () => {
    // The whole point of § 5.2: with only Let's Encrypt authorized, issuance
    // succeeds whenever the rotation happens to land there and fails otherwise.
    // Collapsing this into `pass` is what produces "one renewal succeeds, the
    // next fails" months later with nothing to connect it to.
    const result = evaluateCaaForRotation([caa('issue', 'letsencrypt.org')]);
    expect(result.status).toBe('warn');
    expect(result.code).toBe('caa_permits_some_rotation_cas');
    expect(result.permitted_ca_ids).toEqual(['letsencrypt']);
    expect(result.blocked_ca_ids).toEqual(['zerossl', 'gts']);
  });

  it('fails when the RRset names only a CA outside the rotation', () => {
    const result = evaluateCaaForRotation([caa('issue', 'digicert.com')]);
    expect(result.status).toBe('fail');
    expect(result.code).toBe('caa_permits_no_rotation_cas');
    expect(result.permitted_ca_ids).toEqual([]);
  });

  it('fails on `issue ";"` — the forbid-all form', () => {
    const result = evaluateCaaForRotation([caa('issue', ';')]);
    expect(result.status).toBe('fail');
    expect(result.code).toBe('caa_permits_no_rotation_cas');
  });

  it('ignores issuewild, which governs wildcards D-235 defers', () => {
    const result = evaluateCaaForRotation([
      caa('issue', 'sectigo.com'),
      caa('issue', 'pki.goog'),
      caa('issue', 'letsencrypt.org'),
      caa('issuewild', ';'),
    ]);
    expect(result.status).toBe('pass');
  });

  it('a CRITICAL unknown tag forbids issuance even when our CA is named', () => {
    // RFC 8659 § 4.1. Checked before the `issue` scan on purpose — an RRset
    // that also authorizes us would otherwise read as a clean pass while every
    // conforming CA refuses.
    const result = evaluateCaaForRotation([
      caa('issue', 'sectigo.com'),
      caa('somethingnew', 'x', CAA_ISSUER_CRITICAL_FLAG),
    ]);
    expect(result.status).toBe('fail');
    expect(result.code).toBe('caa_critical_unknown_tag');
    expect(result.permitted_ca_ids).toEqual([]);
  });

  it('a NON-critical unknown tag does not block anything', () => {
    const result = evaluateCaaForRotation([
      caa('issue', 'sectigo.com'),
      caa('issue', 'pki.goog'),
      caa('issue', 'letsencrypt.org'),
      caa('somethingnew', 'x', 0),
    ]);
    expect(result.status).toBe('pass');
  });

  it('reads the issuer-domain half of a parameterized issue value', () => {
    expect(caaIssuerDomain('letsencrypt.org; validationmethods=dns-01')).toBe(
      'letsencrypt.org',
    );
    expect(caaIssuerDomain(' SECTIGO.COM ')).toBe('sectigo.com');
    expect(caaIssuerDomain(';')).toBe('');
  });

  it('climbs from the hostname to the registrable domain, not the TLD', () => {
    expect(caaClimbNames(HOST)).toEqual([
      'recued.their-domain.com',
      'their-domain.com',
    ]);
    expect(caaClimbNames('a.b.c.example.com')).toEqual([
      'a.b.c.example.com',
      'b.c.example.com',
      'c.example.com',
      'example.com',
    ]);
  });
});

describe('D-235 — preflight judgement', () => {
  it('passes when both records are correct and CAA is silent', () => {
    const result = evaluate(
      observation({
        host_cnames: [DDNS],
        delegation_cnames: [DELEGATION_TARGET],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.blocking_failure).toBe(false);
    expect(checkFor(result, 'host_route').code).toBe('host_cname_matches_ddns');
    expect(checkFor(result, 'acme_delegation').code).toBe('delegation_target_matches');
    expect(checkFor(result, 'caa').code).toBe('caa_absent');
  });

  it('§ 2.5 — a correct HOST CNAME does not make the delegation pass', () => {
    // The falsified sketch: routing the host proves nothing about the
    // challenge name, which lives in a zone the fleet cannot write.
    const result = evaluate(observation({ host_cnames: [DDNS] }));
    expect(checkFor(result, 'host_route').status).toBe('pass');
    expect(checkFor(result, 'acme_delegation').status).toBe('fail');
    expect(checkFor(result, 'acme_delegation').code).toBe('delegation_missing');
    expect(result.ok).toBe(false);
    expect(result.blocking_failure).toBe(true);
  });

  it('⛔ a resolver failure is `unknown`, NEVER `delegation_missing`', () => {
    const result = evaluate(
      observation({ host_cnames: [DDNS], delegation_resolver_error: true }),
    );
    const delegation = checkFor(result, 'acme_delegation');
    expect(delegation.status).toBe('unknown');
    expect(delegation.code).toBe('delegation_resolver_error');
    // Not a failure — we learned nothing, so we must not send the user to
    // recreate a record that may already be correct.
    expect(result.blocking_failure).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('names the wrong delegation target rather than calling it missing', () => {
    const result = evaluate(
      observation({
        host_cnames: [DDNS],
        delegation_cnames: ['_acme-challenge.bob.recued.net'],
      }),
    );
    const delegation = checkFor(result, 'acme_delegation');
    expect(delegation.code).toBe('delegation_target_mismatch');
    expect(delegation.expected).toBe(DELEGATION_TARGET);
    expect(delegation.observed).toEqual(['_acme-challenge.bob.recued.net']);
  });

  it('accepts a flattened apex only as a WARN, with matching addresses', () => {
    const result = evaluate(
      observation({
        host_addresses: ['203.0.113.7'],
        ddns_addresses: ['203.0.113.7'],
        delegation_cnames: [DELEGATION_TARGET],
      }),
    );
    const host = checkFor(result, 'host_route');
    expect(host.status).toBe('warn');
    expect(host.code).toBe('host_flattened_matches_ddns');
    // Works today, but we cannot see whether it TRACKS the dynamic IP, so it
    // does not clear `ok`.
    expect(result.ok).toBe(false);
    expect(result.blocking_failure).toBe(false);
  });

  it('⛔ addresses with NO DDNS baseline are unknown, NOT stale', () => {
    // The comparison has no baseline, so it has no verdict. A correct flattened
    // apex would otherwise be reported as broken whenever the DDNS name's own
    // lookup failed — the same absence-is-not-failure mistake as the delegation
    // check, one branch over.
    const result = evaluate(
      observation({
        host_addresses: ['203.0.113.7'],
        ddns_addresses: [],
        delegation_cnames: [DELEGATION_TARGET],
      }),
    );
    const host = checkFor(result, 'host_route');
    expect(host.status).toBe('unknown');
    expect(host.code).toBe('host_ddns_baseline_unavailable');
    expect(result.blocking_failure).toBe(false);
  });

  it('fails a hardcoded A record that no longer matches the DDNS name', () => {
    const result = evaluate(
      observation({
        host_addresses: ['198.51.100.1'],
        ddns_addresses: ['203.0.113.7'],
        delegation_cnames: [DELEGATION_TARGET],
      }),
    );
    expect(checkFor(result, 'host_route').code).toBe('host_flattened_stale');
    expect(result.blocking_failure).toBe(true);
  });

  it('hands back both records to create, copy-paste exact', () => {
    const result = evaluate(observation());
    expect(result.required_records.host).toEqual({
      name: HOST,
      type: 'CNAME',
      value: DDNS,
    });
    expect(result.required_records.delegation).toEqual({
      name: DELEGATION_NAME,
      type: 'CNAME',
      value: DELEGATION_TARGET,
    });
  });

  it('a partial CAA pass blocks `ok` without being a blocking failure', () => {
    const result = evaluate(
      observation({
        host_cnames: [DDNS],
        delegation_cnames: [DELEGATION_TARGET],
        caa_records: [caa('issue', 'letsencrypt.org')],
        caa_relevant_name: 'their-domain.com',
      }),
    );
    expect(checkFor(result, 'caa').status).toBe('warn');
    expect(checkFor(result, 'caa').name).toBe('their-domain.com');
    expect(result.caa?.blocked_ca_ids).toEqual(['zerossl', 'gts']);
    expect(result.ok).toBe(false);
    expect(result.blocking_failure).toBe(false);
  });

  it('a CAA resolver failure is unknown, and carries no verdict', () => {
    const result = evaluate(
      observation({
        host_cnames: [DDNS],
        delegation_cnames: [DELEGATION_TARGET],
        caa_resolver_error: true,
      }),
    );
    expect(checkFor(result, 'caa').status).toBe('unknown');
    expect(checkFor(result, 'caa').code).toBe('caa_resolver_error');
    expect(result.caa).toBeNull();
    expect(result.blocking_failure).toBe(false);
  });
});
