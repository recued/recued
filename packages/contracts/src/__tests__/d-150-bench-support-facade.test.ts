/** D-150 — internal benchmarks extraction support facade ratchet.
 *
 *  The facade intentionally duplicates a tiny support subset from
 *  `recued-plan.ts` + `contact-identity.ts` so the standalone benchmark
 *  wrapper does not import the full Plan IR or contact alias substrate.
 *  These tests keep the duplicated closed lists in lockstep with the
 *  canonical source contracts. */

import { describe, expect, it } from 'vitest';

import * as BenchSupport from '../d-150-bench-support.js';
import {
  CLASSIFICATION_INTENT_KINDS,
  CONTEXT_BREADTHS,
  MODEL_TIERS,
  NARROWING_REASON_CODES,
  OMISSION_REASON_CODES,
} from '../recued-plan.js';
import {
  CONTACT_IDENTITY_STATUSES,
  NETWORK_DOMAINS,
} from '../contact-identity.js';

describe('D-150 bench support facade runtime surface', () => {
  it('exports only the benchmark-safe runtime constants', () => {
    expect(Object.keys(BenchSupport).sort()).toEqual([
      'BENCH_TOKEN_RATE_KEYS',
      'BENCH_TOKEN_RATE_KEY_SET',
      'CLASSIFICATION_INTENT_KINDS',
      'CLASSIFICATION_INTENT_KIND_SET',
      'CONTACT_IDENTITY_STATUSES',
      'CONTACT_IDENTITY_STATUS_SET',
      'CONTEXT_BREADTHS',
      'D150_BENCH_SUPPORT_CONTRACT_VERSION',
      'MODEL_TIERS',
      'MODEL_TIER_SET',
      'NARROWING_REASON_CODES',
      'NARROWING_REASON_CODE_SET',
      'NETWORK_DOMAINS',
      'NETWORK_DOMAIN_SET',
      'OMISSION_REASON_CODES',
      'OMISSION_REASON_CODE_SET',
      'computeBenchTokenCost',
    ]);
  });

  it('does not expose contact alias or full RecuedPlan substrate', () => {
    const keys = Object.keys(BenchSupport);
    expect(keys.some((key) => key.includes('ALIAS'))).toBe(false);
    expect(keys.some((key) => key.includes('RECUED_PLAN'))).toBe(false);
    expect(keys.some((key) => key.includes('PRIMITIVE'))).toBe(false);
    expect(keys.some((key) => key.includes('AUDIT'))).toBe(false);
  });
});

describe('D-150 bench support facade lockstep with source contracts', () => {
  it('matches contact-property closed lists', () => {
    expect(BenchSupport.CONTACT_IDENTITY_STATUSES).toEqual(CONTACT_IDENTITY_STATUSES);
    expect(BenchSupport.NETWORK_DOMAINS).toEqual(NETWORK_DOMAINS);
  });

  it('matches PB17 routing and trace closed lists', () => {
    expect(BenchSupport.CLASSIFICATION_INTENT_KINDS).toEqual(CLASSIFICATION_INTENT_KINDS);
    expect(BenchSupport.CONTEXT_BREADTHS).toEqual(CONTEXT_BREADTHS);
    expect(BenchSupport.MODEL_TIERS).toEqual(MODEL_TIERS);
    expect(BenchSupport.NARROWING_REASON_CODES).toEqual(NARROWING_REASON_CODES);
    expect(BenchSupport.OMISSION_REASON_CODES).toEqual(OMISSION_REASON_CODES);
  });

  it('set exports match array exports', () => {
    expect([...BenchSupport.CONTACT_IDENTITY_STATUS_SET]).toEqual(
      BenchSupport.CONTACT_IDENTITY_STATUSES,
    );
    expect([...BenchSupport.NETWORK_DOMAIN_SET]).toEqual(BenchSupport.NETWORK_DOMAINS);
    expect([...BenchSupport.CLASSIFICATION_INTENT_KIND_SET]).toEqual(
      BenchSupport.CLASSIFICATION_INTENT_KINDS,
    );
    expect([...BenchSupport.MODEL_TIER_SET]).toEqual(BenchSupport.MODEL_TIERS);
    expect([...BenchSupport.NARROWING_REASON_CODE_SET]).toEqual(
      BenchSupport.NARROWING_REASON_CODES,
    );
    expect([...BenchSupport.OMISSION_REASON_CODE_SET]).toEqual(
      BenchSupport.OMISSION_REASON_CODES,
    );
  });
});
