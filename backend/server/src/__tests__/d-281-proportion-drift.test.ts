/** D-281 — the deciding statistic moves from PSI to a two-proportion test
 *  on the low-confidence rate.
 *
 *  🔑 WHY. PSI answers "did the shape of a 10-bin histogram move", a question
 *  nobody asked and which cannot be read off the number. The rate answers
 *  "are we declining more often than we were" — statable in one sentence with
 *  its own sample size and p-value. D-278's anchoring is what made the switch
 *  possible: it turned the narrated confidences near-binary, so the cut at 0.5
 *  separates a refusal from a confident answer exactly.
 *
 *  ⚠ AND IT IS A COMPOSITE, NOT A REPLACEMENT. A rate test at any cut is blind
 *  to movement that stays on one side of it — a confidence sliding 0.85 → 0.55
 *  changed a great deal and refused nothing either time. That never happens to
 *  an anchored narrated confidence but is the NORMAL case for the
 *  deterministic `clamp(sample_count / 100, 0, 1)` producers. So the rate test
 *  decides when the cut partitions the data and PSI decides when it does not.
 *
 *  Every rate below is measured against the real exported functions, on a
 *  fixed-seed generator — never `Math.random`. */

import { describe, expect, it } from 'vitest';

import {
  DRIFT_MODERATE_DELTA,
  DRIFT_SIGNIFICANT_DELTA,
  LOW_CONFIDENCE_CUT,
  compareLowConfidenceRates,
  computeConfidenceHistogram,
  computePSI,
  lowConfidenceRate,
  proportionDriftSeverity,
  psiSeverity,
  shiftIsMeasurable,
} from '@recued/contracts';

import {
  MIN_SAMPLE_COUNT_BASELINE,
  MIN_SAMPLE_COUNT_RECENT,
} from '../housekeeping/index.js';

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const HIGH_MODE = [0.9, 0.95, 1.0];
const draw = (rng: () => number, n: number, zeroRate: number): number[] =>
  Array.from({ length: n }, () =>
    (rng() < zeroRate ? 0 : HIGH_MODE[Math.floor(rng() * HIGH_MODE.length)]!));

/** Fires-per-trial for BOTH statistics over the same drawn windows, so the
 *  comparison is paired rather than two separate experiments. */
const compare = (from: number, to: number, seed: number, trials = 4000) => {
  const rng = mulberry32(seed);
  let rateSig = 0; let rateMod = 0; let psiSig = 0; let psiMod = 0;
  for (let i = 0; i < trials; i += 1) {
    const b = draw(rng, MIN_SAMPLE_COUNT_BASELINE, from);
    const r = draw(rng, MIN_SAMPLE_COUNT_RECENT, to);
    const rs = proportionDriftSeverity(compareLowConfidenceRates(b, r));
    if (rs === 'significant') rateSig += 1;
    if (rs !== 'none') rateMod += 1;
    const ps = psiSeverity(computePSI(computeConfidenceHistogram(b), computeConfidenceHistogram(r)));
    if (ps === 'significant') psiSig += 1;
    if (ps !== 'none') psiMod += 1;
  }
  return {
    rate: { moderate: rateMod / trials, significant: rateSig / trials },
    psi: { moderate: psiMod / trials, significant: psiSig / trials },
  };
};

describe('D-281 — false positives, both windows from one population', () => {
  it.each([
    { label: 'a typical 15% refusal rate', zeroRate: 0.15, seed: 11 },
    { label: 'a rare 5% refusal rate', zeroRate: 0.05, seed: 12 },
  ])('$label stays under 2% moderate and 0.5% significant', ({ zeroRate, seed }) => {
    const r = compare(zeroRate, zeroRate, seed).rate;
    expect(r.moderate, `false moderate ${(r.moderate * 100).toFixed(1)}%`).toBeLessThan(0.02);
    expect(r.significant, `false significant ${(r.significant * 100).toFixed(1)}%`).toBeLessThan(0.005);
  });
});

describe('D-281 — the reason to switch: power on a shift worth acting on', () => {
  it('⛔ beats PSI by more than 3x on a DOUBLING of the refusal rate', () => {
    // 🔑 Asserted as a RELATION over the same drawn windows. Two independent
    // numbers could both drift and still look fine against fixed bounds.
    const { rate, psi } = compare(0.15, 0.30, 13);
    expect(rate.significant, `rate ${(rate.significant * 100).toFixed(1)}% vs psi ${(psi.significant * 100).toFixed(1)}%`)
      .toBeGreaterThan(psi.significant * 3);
    expect(rate.significant).toBeGreaterThan(0.35);
  });

  it('catches a large shift almost always', () => {
    const { rate } = compare(0.15, 0.45, 14);
    expect(rate.significant).toBeGreaterThan(0.95);
  });

  it('⚠ and a 15% → 20% shift stays below the bar — the limit, recorded', () => {
    const { rate } = compare(0.15, 0.20, 15);
    expect(rate.significant).toBeLessThan(0.05);
  });
});

describe('D-281 — the cut, and when it has nothing to measure', () => {
  it('a refusal is exactly a sample below the cut', () => {
    expect(lowConfidenceRate([0, 0, 0.9, 1.0])).toBeCloseTo(0.5, 10);
    expect(LOW_CONFIDENCE_CUT).toBe(0.5);
  });

  it('is measurable when samples fall on BOTH sides', () => {
    expect(shiftIsMeasurable(compareLowConfidenceRates([0, 0.9, 0.9], [0, 0, 0.9]))).toBe(true);
  });

  it.each([
    { label: 'every sample confident in both windows', b: [0.9, 0.95], r: [0.55, 0.6] },
    { label: 'every sample declined in both windows', b: [0, 0.1], r: [0, 0.2] },
  ])('$label is NOT measurable — the cut partitions nothing', ({ b, r }) => {
    // ⛔ The 0.85 → 0.55 case: a real move, no refusal either side. This is
    // what hands the decision to PSI in the producer.
    expect(shiftIsMeasurable(compareLowConfidenceRates(b, r))).toBe(false);
  });

  it('an empty window is not measurable, and never a confident zero', () => {
    expect(shiftIsMeasurable(compareLowConfidenceRates([], [0, 0.9]))).toBe(false);
    expect(compareLowConfidenceRates([], []).p_value).toBe(1);
  });
});

describe('D-281 — the hand-rolled normal approximation is accurate enough', () => {
  it.each([
    // Textbook two-sided p-values for a pooled z of ~1.96 / ~2.58 / ~3.29.
    { z: 1.959964, p: 0.05 },
    { z: 2.575829, p: 0.01 },
    { z: 3.290527, p: 0.001 },
  ])('z ≈ $z → p ≈ $p', ({ z, p }) => {
    // Construct windows whose pooled z lands on the target, then read the
    // p-value back out. ⚠ `erfc` is not in the JS stdlib, so this is an
    // Abramowitz & Stegun approximation — the thresholds are 0.01 and 0.001,
    // so an error here would move real verdicts.
    const n = 100_000;
    const pooled = 0.5;
    const se = Math.sqrt(pooled * (1 - pooled) * (2 / n));
    const delta = z * se;
    const bCount = Math.round((pooled - delta / 2) * n);
    const rCount = Math.round((pooled + delta / 2) * n);
    const b = [...Array(bCount).fill(0), ...Array(n - bCount).fill(0.9)];
    const r = [...Array(rCount).fill(0), ...Array(n - rCount).fill(0.9)];
    expect(compareLowConfidenceRates(b, r).p_value).toBeCloseTo(p, 3);
  });
});

describe('D-281 — severity needs BOTH significance and an effect', () => {
  it('a tiny but hugely significant shift does NOT fire', () => {
    // 🔑 With n large enough, a 2-point move is p < 1e-9. Without the effect
    // floor this detector would scream at every mailbox that grew.
    const n = 200_000;
    const b = [...Array(0.15 * n).fill(0), ...Array(0.85 * n).fill(0.9)];
    const r = [...Array(0.17 * n).fill(0), ...Array(0.83 * n).fill(0.9)];
    const shift = compareLowConfidenceRates(b, r);
    expect(shift.p_value).toBeLessThan(1e-9);
    expect(Math.abs(shift.delta)).toBeLessThan(DRIFT_MODERATE_DELTA);
    expect(proportionDriftSeverity(shift)).toBe('none');
  });

  it('a large shift on a tiny sample does NOT fire either', () => {
    const shift = compareLowConfidenceRates([0, 0.9, 0.9, 0.9], [0, 0, 0.9, 0.9]);
    expect(Math.abs(shift.delta)).toBeGreaterThan(DRIFT_SIGNIFICANT_DELTA);
    expect(shift.p_value).toBeGreaterThan(DRIFT_MODERATE_DELTA);
    expect(proportionDriftSeverity(shift)).toBe('none');
  });
});
