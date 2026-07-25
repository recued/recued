/** D-145 PB15 — partial-coverage helpers tests. */

import { describe, it, expect } from 'vitest';
import {
  PARTIAL_COVERAGE_REASONS,
  buildCoverageContextItem,
  composePartialCoverage,
  decidePartialCoverageHalt,
} from '../partial-coverage.js';

describe('D-145 PB15 — partial coverage', () => {
  it('PARTIAL_COVERAGE_REASONS is the closed list per spec', () => {
    expect(PARTIAL_COVERAGE_REASONS.length).toBeGreaterThanOrEqual(6);
    expect(PARTIAL_COVERAGE_REASONS).toContain('quota_suspended');
    expect(PARTIAL_COVERAGE_REASONS).toContain('rate_limited');
    expect(PARTIAL_COVERAGE_REASONS).toContain('source_unavailable');
  });

  it('composePartialCoverage wraps degraded sources in immutable envelope', () => {
    const env = composePartialCoverage([
      { source: 'gmail:primary', reason: 'quota_suspended', since: 1000 },
    ]);
    expect(env.partial_coverage).toBe(true);
    expect(env.sources_degraded.length).toBe(1);
    expect(env.sources_degraded[0]!.source).toBe('gmail:primary');
    // Outer envelope + array are frozen; the array can't be reassigned
    // on the envelope, nor entries appended to it.
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.sources_degraded)).toBe(true);
  });

  it('composePartialCoverage throws on off-list reason', () => {
    expect(() =>
      composePartialCoverage([
        // @ts-expect-error — testing closed-list guard
        { source: 's', reason: 'bogus_reason', since: 1 },
      ]),
    ).toThrow(/PARTIAL_COVERAGE_REASONS/);
  });

  it('decidePartialCoverageHalt continues when no critical sources', () => {
    const result = decidePartialCoverageHalt({
      succeeded_sources: ['a', 'b'],
      degraded_sources: ['c'],
      critical_sources: [],
    });
    expect(result.kind).toBe('continue');
  });

  it('decidePartialCoverageHalt continues when degraded sources are not critical', () => {
    const result = decidePartialCoverageHalt({
      succeeded_sources: ['a'],
      degraded_sources: ['c'],
      critical_sources: ['a'],
    });
    expect(result.kind).toBe('continue');
  });

  it('decidePartialCoverageHalt halts with cancelled_capacity_gap when critical is degraded', () => {
    const result = decidePartialCoverageHalt({
      succeeded_sources: ['a'],
      degraded_sources: ['critical_source'],
      critical_sources: ['critical_source', 'a'],
    });
    expect(result.kind).toBe('halt');
    if (result.kind === 'halt') {
      expect(result.halt_status).toBe('cancelled_capacity_gap');
      expect(result.critical_missing).toContain('critical_source');
    }
  });

  it('buildCoverageContextItem produces a system_provenance + persist ContextItem', () => {
    const env = composePartialCoverage([
      { source: 's1', reason: 'rate_limited', since: 1 },
    ]);
    const item = buildCoverageContextItem({
      source_ref: 'system.coverage.fetch_call_001',
      envelope: env,
    });
    expect(item.content_class).toBe('system_provenance');
    expect(item.persist_policy).toBe('persist');
    expect(item.redacted_payload).toBeDefined();
    // Round-trip JSON parse should yield the envelope back.
    const parsed = JSON.parse(item.redacted_payload!);
    expect(parsed.partial_coverage).toBe(true);
    expect(parsed.sources_degraded.length).toBe(1);
  });

  it('decidePartialCoverageHalt returns critical_missing in stable order', () => {
    const result = decidePartialCoverageHalt({
      succeeded_sources: [],
      degraded_sources: ['x', 'y', 'z'],
      critical_sources: ['z', 'x', 'y'],
    });
    if (result.kind === 'halt') {
      expect(result.critical_missing).toEqual(['z', 'x', 'y']);
    }
  });
});
