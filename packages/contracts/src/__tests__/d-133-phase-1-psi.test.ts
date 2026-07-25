/** D-133 P1 — PSI computation kernel.
 *
 *  Pure-math substrate for confidence drift detection. Tests cover
 *  the histogram + PSI + severity functions plus the constants the
 *  spec locks in. */

import { describe, it, expect } from 'vitest';
import {
  PSI_BIN_COUNT,
  PSI_THRESHOLD_MODERATE,
  PSI_THRESHOLD_SIGNIFICANT,
  PSI_LAPLACE_EPSILON,
  ALL_DRIFT_SEVERITIES,
  computeConfidenceHistogram,
  computePSI,
  psiSeverity,
} from '../psi.js';

describe('D-133 P1 — PSI constants', () => {
  it('PSI_BIN_COUNT is 10 (mining-standard granularity)', () => {
    expect(PSI_BIN_COUNT).toBe(10);
  });

  it('mining-standard thresholds', () => {
    expect(PSI_THRESHOLD_MODERATE).toBe(0.10);
    expect(PSI_THRESHOLD_SIGNIFICANT).toBe(0.25);
    expect(PSI_THRESHOLD_MODERATE).toBeLessThan(PSI_THRESHOLD_SIGNIFICANT);
  });

  it('Laplace epsilon stays well below the threshold cutoffs', () => {
    expect(PSI_LAPLACE_EPSILON).toBe(0.0001);
    expect(PSI_LAPLACE_EPSILON).toBeLessThan(PSI_THRESHOLD_MODERATE);
  });

  it('ALL_DRIFT_SEVERITIES is the closed set in escalation order', () => {
    expect(ALL_DRIFT_SEVERITIES).toEqual(['none', 'moderate', 'significant']);
  });
});

describe('D-133 P1 — computeConfidenceHistogram', () => {
  it('returns ten bins of zero on empty input', () => {
    const h = computeConfidenceHistogram([]);
    expect(h).toHaveLength(PSI_BIN_COUNT);
    expect(h.every((p) => p === 0)).toBe(true);
  });

  it('proportions sum to 1.0 on non-empty input', () => {
    const h = computeConfidenceHistogram([0.1, 0.5, 0.9]);
    const sum = h.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it('each bin lands on its half-open interval', () => {
    // 0.0 → bin 0, 0.1 → bin 1, 0.55 → bin 5, 0.99 → bin 9, 1.0 → bin 9 (right-closed).
    const samples = [0.0, 0.1, 0.55, 0.99, 1.0];
    const h = computeConfidenceHistogram(samples);
    expect(h[0]).toBeCloseTo(1 / 5, 10);
    expect(h[1]).toBeCloseTo(1 / 5, 10);
    expect(h[5]).toBeCloseTo(1 / 5, 10);
    expect(h[9]).toBeCloseTo(2 / 5, 10);
  });

  it('values below 0 clip to bin 0', () => {
    const h = computeConfidenceHistogram([-0.5, -1.0, 0.05]);
    expect(h[0]).toBeCloseTo(1.0, 10);
    expect(h.slice(1).every((p) => p === 0)).toBe(true);
  });

  it('values above 1 clip to bin 9', () => {
    const h = computeConfidenceHistogram([1.5, 2.0, 0.95]);
    expect(h[9]).toBeCloseTo(1.0, 10);
    expect(h.slice(0, 9).every((p) => p === 0)).toBe(true);
  });

  it('NaN samples land in bin 0 (defensive — should not occur in practice)', () => {
    const h = computeConfidenceHistogram([Number.NaN, 0.95]);
    expect(h[0]).toBeCloseTo(0.5, 10);
    expect(h[9]).toBeCloseTo(0.5, 10);
  });

  it('uniform distribution → uniform bins', () => {
    const samples: number[] = [];
    for (let bin = 0; bin < PSI_BIN_COUNT; bin += 1) {
      // 100 samples per bin, centered on bin midpoint.
      for (let i = 0; i < 100; i += 1) samples.push(bin / 10 + 0.05);
    }
    const h = computeConfidenceHistogram(samples);
    for (const p of h) {
      expect(p).toBeCloseTo(0.1, 10);
    }
  });
});

describe('D-133 P1 — computePSI', () => {
  it('identical distributions → PSI = 0', () => {
    const dist = computeConfidenceHistogram([0.1, 0.3, 0.5, 0.7, 0.9]);
    const psi = computePSI(dist, dist);
    expect(psi).toBeCloseTo(0, 6);
  });

  it('uniform vs uniform → PSI = 0', () => {
    const dist = new Array(PSI_BIN_COUNT).fill(0.1);
    const psi = computePSI(dist, dist);
    expect(psi).toBeCloseTo(0, 6);
  });

  it('throws on bin-count mismatch', () => {
    expect(() => computePSI([0.5, 0.5], [0.3, 0.3, 0.4])).toThrow(/bin count mismatch/);
  });

  it('PSI is non-negative for valid inputs', () => {
    const baseline = computeConfidenceHistogram([0.7, 0.75, 0.8, 0.85]);
    const recent = computeConfidenceHistogram([0.2, 0.25, 0.3]);
    expect(computePSI(baseline, recent)).toBeGreaterThanOrEqual(0);
  });

  it('large mean shift produces significant PSI', () => {
    // Baseline centred ~0.85; recent centred ~0.55.
    const baselineSamples: number[] = [];
    for (let i = 0; i < 1000; i += 1) baselineSamples.push(0.85);
    const recentSamples: number[] = [];
    for (let i = 0; i < 1000; i += 1) recentSamples.push(0.55);
    const psi = computePSI(
      computeConfidenceHistogram(baselineSamples),
      computeConfidenceHistogram(recentSamples),
    );
    expect(psi).toBeGreaterThan(PSI_THRESHOLD_SIGNIFICANT);
  });

  it('moderate mass-shift between adjacent bins produces moderate PSI', () => {
    // Mass moves leftward within already-nonzero bins. The Laplace
    // floor only kicks in for bins that were 0 in both inputs.
    const baseline = [0, 0, 0, 0, 0.05, 0.25, 0.30, 0.25, 0.15, 0];
    const recent = [0, 0, 0, 0, 0.15, 0.30, 0.25, 0.20, 0.10, 0];
    const psi = computePSI(baseline, recent);
    expect(psi).toBeGreaterThan(PSI_THRESHOLD_MODERATE);
    expect(psi).toBeLessThan(PSI_THRESHOLD_SIGNIFICANT);
    expect(psiSeverity(psi)).toBe('moderate');
  });

  it('Laplace smoothing keeps math finite when one side has zero in a bin', () => {
    const baseline = [1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const recent = [0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0];
    const psi = computePSI(baseline, recent);
    expect(Number.isFinite(psi)).toBe(true);
    expect(psi).toBeGreaterThan(0);
  });

  it('PSI is symmetric to direction of shift (within numerical tolerance)', () => {
    const a = computeConfidenceHistogram([0.1, 0.15, 0.2]);
    const b = computeConfidenceHistogram([0.8, 0.85, 0.9]);
    const psiAB = computePSI(a, b);
    const psiBA = computePSI(b, a);
    expect(psiAB).toBeCloseTo(psiBA, 6);
  });
});

describe('D-133 P1 — psiSeverity', () => {
  it('PSI = 0 → none', () => {
    expect(psiSeverity(0)).toBe('none');
  });

  it('just below moderate threshold → none', () => {
    expect(psiSeverity(PSI_THRESHOLD_MODERATE - 0.0001)).toBe('none');
  });

  it('exactly at moderate threshold → moderate (>=)', () => {
    expect(psiSeverity(PSI_THRESHOLD_MODERATE)).toBe('moderate');
  });

  it('between thresholds → moderate', () => {
    expect(psiSeverity(0.18)).toBe('moderate');
  });

  it('exactly at significant threshold → significant (>=)', () => {
    expect(psiSeverity(PSI_THRESHOLD_SIGNIFICANT)).toBe('significant');
  });

  it('above significant threshold → significant', () => {
    expect(psiSeverity(0.5)).toBe('significant');
  });

  it('arbitrarily large PSI → significant', () => {
    expect(psiSeverity(999)).toBe('significant');
  });
});
