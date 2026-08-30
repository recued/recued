/** D-153 / D-187 — admission-decision primitives contract tests.
 *
 *  After the policy-matrix retirement (D-187) the matrix merge + tool gate
 *  (`mergePolicyWithContract` / `evaluateToolAdmissibility` / `requiresApproval` /
 *  `evaluateScopeAdmissibility`) are gone — approval is op-risk x stage-trust now
 *  (pinned in d-187-slice3/4). What survives in `policy-enforcement.ts` is the
 *  decision substrate: the closed `AdmissionDenyCode` list + the scope fence
 *  (`evaluateScopeRestrictions` + `matchScopePattern`). This file pins those.
 */

import { describe, expect, it } from 'vitest';

import {
  ADMISSION_DENY_CODES,
  evaluateScopeRestrictions,
  isAdmissionDenyCode,
  matchScopePattern,
  type AdmissionDecision,
  type AdmissionDenyCode,
} from '@recued/contracts';

const EXPECTED_DENY_CODES: readonly AdmissionDenyCode[] = [
  'kind_not_allowed',
  'tool_not_in_contract',
  'scope_not_in_restrictions',
  // D-187 slice 6 — `op_risk_denied` (renamed from `policy_matrix_denied`).
  'op_risk_denied',
  // D-187 AMENDMENT 3b — added by the backend op-admission grant gate.
  'op_not_granted',
  // D-253 follow-on — the governing contract's `scope.connection_names` axis did
  // not admit the connection this dispatch would authenticate with. ⛔ Deliberately
  // NOT `scope_not_in_restrictions`: `connection.*` is unconditionally KEPT in
  // `SCOPE_FENCE_KEEP_PATTERNS`, so anyone sent to inspect the path patterns would
  // find the connection admitted and conclude the denial was a bug. Two fences,
  // two codes.
  'connection_not_in_scope',
  // D-188 — the master "Pause server" circuit-breaker denies at admission.
  'server_paused',
  // D-234 § 234.1 — the owner's per-peer CEILING declined to answer this peer
  // with this recipe. ⛔ Deliberately NOT `tool_not_in_contract`: the tool IS in
  // the contract and the peer IS admitted and granted, so reusing that code
  // would send whoever diagnoses it to inspect a contract that is correct. Also
  // distinct from `server_paused` — that is a whole-server condition that clears
  // itself; this is a durable, per-peer, per-recipe decision.
  'peer_admission_refused',
] as const;

const expectDeny = (
  decision: AdmissionDecision,
  code: AdmissionDenyCode,
): Extract<AdmissionDecision, { readonly verdict: 'deny' }> => {
  expect(decision.verdict).toBe('deny');
  if (decision.verdict !== 'deny') throw new Error('Expected deny code ' + code);
  expect(decision.code).toBe(code);
  return decision;
};

describe('D-153 / D-187 — closed-list invariants', () => {
  it('ADMISSION_DENY_CODES is the ordered eight-code closed list', () => {
    expect(ADMISSION_DENY_CODES).toEqual(EXPECTED_DENY_CODES);
  });

  it('isAdmissionDenyCode accepts every closed-list code', () => {
    for (const code of ADMISSION_DENY_CODES) expect(isAdmissionDenyCode(code)).toBe(true);
  });

  it('isAdmissionDenyCode rejects unknown strings and non-strings', () => {
    for (const value of ['unknown', 'rate_limit_hourly', '', 42, null, undefined, {}]) {
      expect(isAdmissionDenyCode(value)).toBe(false);
    }
  });
});

describe('D-187 — evaluateScopeRestrictions empty restrictions', () => {
  it('admits all paths when the restriction list is empty', () => {
    for (const scopePath of ['data.mail.123', 'connection.api.hubspot.contact', 'anything']) {
      expect(evaluateScopeRestrictions([], scopePath)).toEqual({ verdict: 'admit' });
    }
  });
});

describe('D-187 — evaluateScopeRestrictions pattern matching', () => {
  const restrictions = ['data.enrichment.*', 'connection.api.*'];

  it('admits paths matched by configured prefix restrictions', () => {
    for (const scopePath of [
      'data.enrichment.mail.123',
      'data.enrichment',
      'connection.api.hubspot.contact',
    ]) {
      expect(evaluateScopeRestrictions(restrictions, scopePath)).toEqual({ verdict: 'admit' });
    }
  });

  it('denies unmatched paths with the restriction list in detail', () => {
    const decision = expectDeny(
      evaluateScopeRestrictions(restrictions, 'data.audit.X'),
      'scope_not_in_restrictions',
    );

    expect(decision.detail).toContain('data.enrichment.*');
    expect(decision.detail).toContain('connection.api.*');
  });
});

describe('D-153 P2.B — matchScopePattern exhaustive grammar', () => {
  it("matches '*' against every sample path", () => {
    for (const scopePath of ['', 'data.mail.1', 'connection.api.hubspot.contact']) {
      expect(matchScopePattern('*', scopePath)).toBe(true);
    }
  });

  it("matches 'a.*' against the bare prefix and dotted descendants only", () => {
    expect(matchScopePattern('a.*', 'a')).toBe(true);
    expect(matchScopePattern('a.*', 'a.b')).toBe(true);
    expect(matchScopePattern('a.*', 'a.b.c')).toBe(true);
    expect(matchScopePattern('a.*', 'afoo')).toBe(false);
    expect(matchScopePattern('a.*', 'aa')).toBe(false);
  });

  it('matches a literal pattern only by exact equality', () => {
    expect(matchScopePattern('a.b.c', 'a.b.c')).toBe(true);
    expect(matchScopePattern('a.b.c', 'a.b')).toBe(false);
    expect(matchScopePattern('a.b.c', 'a.b.c.d')).toBe(false);
  });

  it('handles empty-pattern and empty-prefix edge cases', () => {
    expect(matchScopePattern('', '')).toBe(true);
    expect(matchScopePattern('', 'a')).toBe(false);
    for (const scopePath of ['', 'a', 'a.b.c']) {
      expect(matchScopePattern('.*', scopePath)).toBe(true);
    }
  });
});

describe('D-187 — AdmissionDecision discriminator', () => {
  it('freezes deny decisions', () => {
    const decision = expectDeny(
      evaluateScopeRestrictions(['data.mail.*'], 'data.audit.X'),
      'scope_not_in_restrictions',
    );

    expect(Object.isFrozen(decision)).toBe(true);
  });

  it('returns the shared admit sentinel by reference across separate admit calls', () => {
    const a = evaluateScopeRestrictions([], 'data.mail.1');
    const b = evaluateScopeRestrictions([], 'anything');

    expect(a).toEqual({ verdict: 'admit' });
    expect(b).toEqual({ verdict: 'admit' });
    expect(a).toBe(b);
  });
});
