// D-181 §10 — the in-memory duration-threshold classifier (sticky-max).

import { describe, expect, it } from 'vitest';
import { createOpDurationClassifier } from '../execution/op-duration-classifier.js';

describe('createOpDurationClassifier', () => {
  it('returns undefined for an op that has never been recorded (→ stays gated)', () => {
    const c = createOpDurationClassifier();
    expect(c.recordedMaxMs('docling')).toBeUndefined();
  });

  it('records and reads back a duration', () => {
    const c = createOpDurationClassifier();
    c.record('docling', 3_000);
    expect(c.recordedMaxMs('docling')).toBe(3_000);
  });

  it('keeps the per-slug MAX — sticky: a later fast run does not lower it', () => {
    const c = createOpDurationClassifier();
    c.record('docling', 9_000); // once slow
    c.record('docling', 1_000); // later fast
    expect(c.recordedMaxMs('docling')).toBe(9_000); // stays gated-worthy
  });

  it('raises the max when a later run is slower', () => {
    const c = createOpDurationClassifier();
    c.record('docling', 1_000);
    c.record('docling', 8_000);
    expect(c.recordedMaxMs('docling')).toBe(8_000);
  });

  it('ignores a negative / non-finite sample (clock skew must not demote an op)', () => {
    const c = createOpDurationClassifier();
    c.record('docling', -5);
    c.record('docling', Number.NaN);
    c.record('docling', Number.POSITIVE_INFINITY);
    expect(c.recordedMaxMs('docling')).toBeUndefined();
  });

  it('tracks slugs independently', () => {
    const c = createOpDurationClassifier();
    c.record('docling', 9_000);
    c.record('fast-http', 200);
    expect(c.recordedMaxMs('docling')).toBe(9_000);
    expect(c.recordedMaxMs('fast-http')).toBe(200);
  });
});
