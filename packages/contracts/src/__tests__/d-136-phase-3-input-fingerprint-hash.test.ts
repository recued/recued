/** D-136 Phase 3 — `computeInputFingerprintHash` helper.
 *
 *  Locks the four-kind discriminator (`per_record_source_hash` /
 *  `aggregate_window_fold` / `perspective_fan_in` / `upstream_chain`)
 *  per spec §A.3. Per-record kind degenerates to `source_record_hash`;
 *  the other three FNV-1a a canonical composed string. Tests cover:
 *    - per-record degenerate returns input verbatim (no `'fnv1a:'` prefix)
 *    - aggregate_window_fold + perspective_fan_in are sort-invariant
 *      on their list inputs
 *    - any single field change flips the hash (window_ms, as_of, config,
 *      individual hash entries)
 *    - upstream_chain composes single-contributor chain
 *
 *  Spec: D-136 §A.3 + P3 phase plan. */

import { describe, expect, it } from 'vitest';

import {
  computeInputFingerprintHash,
  type InputFingerprintHashInput,
} from '../index.js';

describe('D-136 §A.3 — per_record_source_hash degenerate', () => {
  it('returns the source_record_hash verbatim (no FNV-1a wrap)', () => {
    const out = computeInputFingerprintHash({
      kind: 'per_record_source_hash',
      source_record_hash: 'abcdef01',
    });
    expect(out).toBe('abcdef01');
  });

  it('preserves callers passing pre-FNV-prefixed hashes verbatim', () => {
    // Walker hashOf() outputs are 8-hex by convention but the composer
    // is byte-stable so any string round-trips.
    const out = computeInputFingerprintHash({
      kind: 'per_record_source_hash',
      source_record_hash: 'fnv1a:01020304',
    });
    expect(out).toBe('fnv1a:01020304');
  });
});

describe('D-136 §A.3 — aggregate_window_fold composition', () => {
  const baseInput: InputFingerprintHashInput = {
    kind: 'aggregate_window_fold',
    source_record_hashes: ['hash_a', 'hash_b', 'hash_c'],
    window_ms: 30 * 24 * 60 * 60 * 1000,
    as_of: 1_700_000_000_000,
    effective_topic_config: '',
  };

  it('returns a self-describing fnv1a:<8-hex> string', () => {
    expect(computeInputFingerprintHash(baseInput)).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('is sort-invariant on source_record_hashes', () => {
    const reversed: InputFingerprintHashInput = {
      ...baseInput,
      source_record_hashes: [...baseInput.source_record_hashes].reverse(),
    };
    expect(computeInputFingerprintHash(reversed)).toBe(
      computeInputFingerprintHash(baseInput),
    );
  });

  it('flips hash when window_ms changes', () => {
    const widened: InputFingerprintHashInput = {
      ...baseInput,
      window_ms: 2 * 365 * 24 * 60 * 60 * 1000, // 30d → 2y (yacht-broker case)
    };
    expect(computeInputFingerprintHash(widened)).not.toBe(
      computeInputFingerprintHash(baseInput),
    );
  });

  it('flips hash when as_of changes', () => {
    const later: InputFingerprintHashInput = {
      ...baseInput,
      as_of: baseInput.as_of + 1,
    };
    expect(computeInputFingerprintHash(later)).not.toBe(
      computeInputFingerprintHash(baseInput),
    );
  });

  it('flips hash when effective_topic_config changes', () => {
    const overridden: InputFingerprintHashInput = {
      ...baseInput,
      effective_topic_config: '{"ttl_days":60}',
    };
    expect(computeInputFingerprintHash(overridden)).not.toBe(
      computeInputFingerprintHash(baseInput),
    );
  });

  it('flips hash when any single source_record_hash changes', () => {
    const swapped: InputFingerprintHashInput = {
      ...baseInput,
      source_record_hashes: ['hash_a', 'hash_b', 'hash_d'],
    };
    expect(computeInputFingerprintHash(swapped)).not.toBe(
      computeInputFingerprintHash(baseInput),
    );
  });
});

describe('D-136 §A.3 — perspective_fan_in composition', () => {
  const baseInput: InputFingerprintHashInput = {
    kind: 'perspective_fan_in',
    upstream: [
      { enrichment_row_id: 'enr_001', producer_version_hash: 'fnv1a:11111111' },
      { enrichment_row_id: 'enr_002', producer_version_hash: 'fnv1a:22222222' },
    ],
    as_of: 1_700_000_000_000,
    effective_topic_config: '',
  };

  it('returns a self-describing fnv1a:<8-hex> string', () => {
    expect(computeInputFingerprintHash(baseInput)).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('is sort-invariant on upstream order', () => {
    const reversed: InputFingerprintHashInput = {
      ...baseInput,
      upstream: [...baseInput.upstream].reverse(),
    };
    expect(computeInputFingerprintHash(reversed)).toBe(
      computeInputFingerprintHash(baseInput),
    );
  });

  it("flips hash when an upstream's producer_version_hash bumps (hash-of-hash chain)", () => {
    const upgraded: InputFingerprintHashInput = {
      ...baseInput,
      upstream: [
        { enrichment_row_id: 'enr_001', producer_version_hash: 'fnv1a:11111111' },
        // upstream producer code-bumped — its hash flips
        { enrichment_row_id: 'enr_002', producer_version_hash: 'fnv1a:33333333' },
      ],
    };
    expect(computeInputFingerprintHash(upgraded)).not.toBe(
      computeInputFingerprintHash(baseInput),
    );
  });

  it('flips hash when an upstream row id changes (different contributor set)', () => {
    const swapped: InputFingerprintHashInput = {
      ...baseInput,
      upstream: [
        { enrichment_row_id: 'enr_001', producer_version_hash: 'fnv1a:11111111' },
        { enrichment_row_id: 'enr_003', producer_version_hash: 'fnv1a:22222222' },
      ],
    };
    expect(computeInputFingerprintHash(swapped)).not.toBe(
      computeInputFingerprintHash(baseInput),
    );
  });
});

describe('D-136 §A.3 — upstream_chain composition', () => {
  const baseInput: InputFingerprintHashInput = {
    kind: 'upstream_chain',
    upstream: { enrichment_row_id: 'enr_999', producer_version_hash: 'fnv1a:abcdef01' },
    as_of: 1_700_000_000_000,
    effective_topic_config: '',
  };

  it('returns a self-describing fnv1a:<8-hex> string', () => {
    expect(computeInputFingerprintHash(baseInput)).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('flips hash when the upstream row id changes', () => {
    const swapped: InputFingerprintHashInput = {
      ...baseInput,
      upstream: { ...baseInput.upstream, enrichment_row_id: 'enr_888' },
    };
    expect(computeInputFingerprintHash(swapped)).not.toBe(
      computeInputFingerprintHash(baseInput),
    );
  });

  it("flips hash when the upstream's producer_version_hash bumps", () => {
    const bumped: InputFingerprintHashInput = {
      ...baseInput,
      upstream: { ...baseInput.upstream, producer_version_hash: 'fnv1a:fedcba98' },
    };
    expect(computeInputFingerprintHash(bumped)).not.toBe(
      computeInputFingerprintHash(baseInput),
    );
  });
});

describe('D-136 §A.3 — cross-kind disambiguation', () => {
  it('aggregate_window_fold and perspective_fan_in with overlapping shape do not collide', () => {
    // The kind discriminator is folded into the composed string so
    // identical-shape inputs across kinds produce different hashes.
    const aggHash = computeInputFingerprintHash({
      kind: 'aggregate_window_fold',
      source_record_hashes: ['h_a'],
      window_ms: 0,
      as_of: 0,
      effective_topic_config: '',
    });
    const persHash = computeInputFingerprintHash({
      kind: 'perspective_fan_in',
      upstream: [{ enrichment_row_id: 'h_a', producer_version_hash: '' }],
      as_of: 0,
      effective_topic_config: '',
    });
    expect(aggHash).not.toBe(persHash);
  });
});
