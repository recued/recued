/** D-280 — what PSI does when NOTHING has drifted.
 *
 *  ⛔⛔ THE FLOOR WAS NOT CONSERVATIVE, IT WAS NOISE. D-133 set
 *  `MIN_SAMPLE_COUNT_RECENT = 30` because "30 is the rule-of-thumb floor in
 *  mining literature" — which is a floor for estimating ONE proportion, not
 *  for comparing a 10-bin histogram against another 10-bin histogram. At n=30
 *  that is ~3 samples per bin, and PSI on sparse bins is decided by which bins
 *  happen to land empty and take the `PSI_LAPLACE_EPSILON` smoothing.
 *
 *  🔑 THIS SUITE DRAWS BOTH WINDOWS FROM THE SAME DISTRIBUTION, so every fire
 *  it counts is FALSE BY CONSTRUCTION. It drives the real
 *  `computeConfidenceHistogram` / `computePSI` / `psiSeverity` rather than a
 *  reimplementation — a restated formula would only test the restatement.
 *
 *  ⚠ DETERMINISTIC BY SEED, not by luck. An assertion over a random value
 *  flakes; the generator below is a fixed-seed mulberry32 so the counts are
 *  reproducible, and the bounds carry margin over the observed rates rather
 *  than pinning them exactly.
 *
 *  Why it matters that this is daily: the producer fires on severity
 *  TRANSITIONS, so a rate of 14% per evaluation is a spurious fire most weeks
 *  per topic — and D-136 P4 turns a `'significant'` one into a recompute of
 *  every row of the topic. A false positive here costs tokens. */

import { describe, expect, it } from 'vitest';

import {
  computeConfidenceHistogram,
  computePSI,
  psiSeverity,
} from '@recued/contracts';

import {
  MIN_SAMPLE_COUNT_BASELINE,
  MIN_SAMPLE_COUNT_RECENT,
} from '../housekeeping/index.js';

/** Fixed-seed PRNG — no `Math.random`, so a red here is a real change. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The post-anchor shape D-278 produced: a zero mode plus a high mode. The
 *  anchoring is what made these distributions near-binary, which is also what
 *  makes a 10-bin PSI a poor instrument for them. */
const HIGH_MODE = [0.9, 0.95, 1.0];
const draw = (rng: () => number, n: number, zeroRate: number): number[] =>
  Array.from({ length: n }, () =>
    (rng() < zeroRate ? 0 : HIGH_MODE[Math.floor(rng() * HIGH_MODE.length)]!));

interface Rates { moderate: number; significant: number }

/** Fraction of trials that fire when baseline and recent are the SAME
 *  population — i.e. the false-positive rate. */
const falsePositiveRate = (
  baselineN: number, recentN: number, zeroRate: number, seed: number, trials = 4000,
): Rates => {
  const rng = mulberry32(seed);
  let moderate = 0; let significant = 0;
  for (let i = 0; i < trials; i += 1) {
    const psi = computePSI(
      computeConfidenceHistogram(draw(rng, baselineN, zeroRate)),
      computeConfidenceHistogram(draw(rng, recentN, zeroRate)),
    );
    const sev = psiSeverity(psi);
    if (sev === 'significant') significant += 1;
    if (sev !== 'none') moderate += 1;
  }
  return { moderate: moderate / trials, significant: significant / trials };
};

/** Fraction that fire when the refusal rate GENUINELY moves. */
const detectionRate = (
  baselineN: number, recentN: number, from: number, to: number, seed: number, trials = 4000,
): Rates => {
  const rng = mulberry32(seed);
  let moderate = 0; let significant = 0;
  for (let i = 0; i < trials; i += 1) {
    const psi = computePSI(
      computeConfidenceHistogram(draw(rng, baselineN, from)),
      computeConfidenceHistogram(draw(rng, recentN, to)),
    );
    const sev = psiSeverity(psi);
    if (sev === 'significant') significant += 1;
    if (sev !== 'none') moderate += 1;
  }
  return { moderate: moderate / trials, significant: significant / trials };
};

const OLD_BASELINE = 100;
const OLD_RECENT = 30;

describe('D-280 — the shipped floors keep false positives rare', () => {
  it.each([
    { label: 'a typical 15% refusal rate', zeroRate: 0.15, seed: 1 },
    { label: 'a rare 5% refusal rate — the worst case for sparse bins', zeroRate: 0.05, seed: 2 },
  ])('$label: under 3% moderate and under 1% significant', ({ zeroRate, seed }) => {
    const r = falsePositiveRate(MIN_SAMPLE_COUNT_BASELINE, MIN_SAMPLE_COUNT_RECENT, zeroRate, seed);
    expect(r.moderate, `false moderate ${(r.moderate * 100).toFixed(1)}%`).toBeLessThan(0.03);
    expect(r.significant, `false significant ${(r.significant * 100).toFixed(1)}%`).toBeLessThan(0.01);
  });
});

describe('D-280 — the CONTROL: the old floors were an order of magnitude worse', () => {
  // ⛔ Without this arm the suite above could pass because the harness never
  // fires at all, rather than because the floors fixed anything.
  it.each([
    { label: '15% refusal rate', zeroRate: 0.15, seed: 3 },
    { label: '5% refusal rate', zeroRate: 0.05, seed: 4 },
  ])('$label at baseline 100 / recent 30 fires falsely over 8% of the time', ({ zeroRate, seed }) => {
    const old = falsePositiveRate(OLD_BASELINE, OLD_RECENT, zeroRate, seed);
    expect(old.moderate, `old false moderate ${(old.moderate * 100).toFixed(1)}%`).toBeGreaterThan(0.08);

    const now = falsePositiveRate(MIN_SAMPLE_COUNT_BASELINE, MIN_SAMPLE_COUNT_RECENT, zeroRate, seed);
    // The whole point of the change, asserted as a relation rather than two
    // independent numbers that could drift apart unnoticed.
    expect(now.moderate).toBeLessThan(old.moderate / 4);
  });
});

describe('D-280 — and power is retained for shifts worth acting on', () => {
  it('a refusal rate moving 15% → 45% still fires significant most of the time', () => {
    const d = detectionRate(MIN_SAMPLE_COUNT_BASELINE, MIN_SAMPLE_COUNT_RECENT, 0.15, 0.45, 5);
    expect(d.significant, `detected significant ${(d.significant * 100).toFixed(1)}%`).toBeGreaterThan(0.8);
  });

  it('a refusal rate moving 15% → 30% still fires moderate more often than not', () => {
    const d = detectionRate(MIN_SAMPLE_COUNT_BASELINE, MIN_SAMPLE_COUNT_RECENT, 0.15, 0.30, 6);
    expect(d.moderate, `detected moderate ${(d.moderate * 100).toFixed(1)}%`).toBeGreaterThan(0.5);
  });

  it('⚠ and a SMALL shift is below the noise — documented, not asserted away', () => {
    // 15% → 20% is real but indistinguishable at these window sizes. Recording
    // it here so the limit is visible rather than discovered later as a miss.
    const d = detectionRate(MIN_SAMPLE_COUNT_BASELINE, MIN_SAMPLE_COUNT_RECENT, 0.15, 0.20, 7);
    expect(d.significant).toBeLessThan(0.2);
  });
});
