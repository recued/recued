/** D-137 P3 § A.5 — `classifyConfidenceShape` tests.
 *
 *  Covers each pattern's discriminator + the recency tiebreak +
 *  internal measures + threshold-override hatch. The threshold
 *  constants are owned by the dispatch function (per spec); tests
 *  pin them via the override hatch so future calibration doesn't
 *  break this suite. */

import { describe, expect, it } from 'vitest';
import {
  classifyConfidenceShape,
  sortByScoreWithRecency,
  CONFIDENCE_DOMINANT_SCORE,
  CONFIDENCE_DOMINANT_MARGIN,
  CONFIDENCE_LOW_FLOOR,
  CONFIDENCE_TIEBREAK_EPSILON,
} from '../classify.js';

interface TestRecord {
  id: string;
  recency?: number;
}

const r = (id: string, recency?: number): TestRecord =>
  recency === undefined ? { id } : { id, recency };

describe('D-137 P3 § A.5 — substrate constants', () => {
  it('publishes the four threshold knobs as exported constants', () => {
    expect(typeof CONFIDENCE_DOMINANT_SCORE).toBe('number');
    expect(typeof CONFIDENCE_DOMINANT_MARGIN).toBe('number');
    expect(typeof CONFIDENCE_LOW_FLOOR).toBe('number');
    expect(typeof CONFIDENCE_TIEBREAK_EPSILON).toBe('number');
    // Sanity floors — calibration may move these; the suite asserts
    // ordering invariants below rather than exact values.
    expect(CONFIDENCE_DOMINANT_SCORE).toBeGreaterThan(CONFIDENCE_LOW_FLOOR);
    expect(CONFIDENCE_DOMINANT_MARGIN).toBeGreaterThan(CONFIDENCE_TIEBREAK_EPSILON);
  });
});

describe('D-137 P3 § A.5 Pattern 1 — single high, others low', () => {
  it('returns pattern: 1 when top is dominant by margin', () => {
    const result = classifyConfidenceShape<TestRecord>([
      { record: r('top'), score: 0.95 },
      { record: r('alt1'), score: 0.4 },
      { record: r('alt2'), score: 0.3 },
    ]);
    expect(result.pattern).toBe(1);
    if (result.pattern === 1) {
      expect(result.top.id).toBe('top');
      expect(result.alternatives.map((a) => a.id)).toEqual(['alt1', 'alt2']);
      expect(result.measures.candidate_count).toBe(3);
      expect(result.measures.top_score).toBe(0.95);
      expect(result.measures.top_margin).toBeCloseTo(0.55);
    }
  });

  it('single high-scoring candidate collapses to pattern 1 (no alternatives)', () => {
    const result = classifyConfidenceShape<TestRecord>([
      { record: r('only'), score: 0.85 },
    ]);
    expect(result.pattern).toBe(1);
    if (result.pattern === 1) {
      expect(result.top.id).toBe('only');
      expect(result.alternatives).toEqual([]);
    }
  });
});

describe('D-137 P3 § A.5 Pattern 2 — single high, some close', () => {
  it('separates "close" alternatives from tail alternatives', () => {
    const result = classifyConfidenceShape<TestRecord>([
      { record: r('top'), score: 0.85 },
      { record: r('close1'), score: 0.75 },
      { record: r('close2'), score: 0.72 },
      { record: r('tail'), score: 0.4 },
    ]);
    expect(result.pattern).toBe(2);
    if (result.pattern === 2) {
      expect(result.top.id).toBe('top');
      expect(result.close.map((c) => c.id)).toEqual(['close1', 'close2']);
      expect(result.alternatives.map((c) => c.id)).toEqual(['tail']);
    }
  });
});

describe('D-137 P3 § A.5 Pattern 3 — all low (refuse + show)', () => {
  it('returns pattern: 3 when no candidate clears DOMINANT_SCORE', () => {
    const result = classifyConfidenceShape<TestRecord>([
      { record: r('a'), score: 0.4 },
      { record: r('b'), score: 0.35 },
      { record: r('c'), score: 0.3 },
    ]);
    expect(result.pattern).toBe(3);
    if (result.pattern === 3) {
      expect(result.candidates.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    }
  });

  it('unscored candidates collapse to pattern 3 (substrate refuses to invent dominance)', () => {
    const result = classifyConfidenceShape<TestRecord>([
      { record: r('a') },
      { record: r('b') },
    ]);
    expect(result.pattern).toBe(3);
    if (result.pattern === 3) {
      expect(result.candidates).toHaveLength(2);
      expect(result.measures.top_score).toBeNull();
      expect(result.measures.mean_score).toBeNull();
    }
  });

  it('single weak candidate still collapses to pattern 3 (not pattern 1)', () => {
    const result = classifyConfidenceShape<TestRecord>([
      { record: r('weak'), score: 0.3 },
    ]);
    expect(result.pattern).toBe(3);
  });
});

describe('D-137 P3 § A.5 Pattern 4 — empty', () => {
  it('returns pattern: 4 on empty input', () => {
    const result = classifyConfidenceShape<TestRecord>([]);
    expect(result.pattern).toBe(4);
    if (result.pattern === 4) {
      expect(result.measures.candidate_count).toBe(0);
      expect(result.measures.top_score).toBeNull();
      expect(result.measures.top_margin).toBeNull();
      expect(result.measures.mean_score).toBeNull();
    }
  });
});

describe('D-137 P3 § A.5 — recency tiebreak', () => {
  it('within tiebreak epsilon + both high → pattern 2 with recency as top', () => {
    // Both 0.85 and 0.86 clear DOMINANT_SCORE (0.7) → pattern can be 1
    // or 2. Within epsilon they count as "close" → pattern 2 with the
    // recency-preferred candidate surfacing as top.
    const result = classifyConfidenceShape<TestRecord>(
      [
        { record: r('older', 100), score: 0.85 },
        { record: r('newer', 200), score: 0.86 },
      ],
      { recencyKey: (item) => item.recency ?? 0 },
    );
    expect(result.pattern).toBe(2);
    if (result.pattern === 2) {
      expect(result.top.id).toBe('newer');
      expect(result.close[0]?.id).toBe('older');
    }
  });

  it('outside tiebreak epsilon, raw score wins (recency ignored) → pattern 1', () => {
    const result = classifyConfidenceShape<TestRecord>(
      [
        { record: r('older', 100), score: 0.95 },
        { record: r('newer', 200), score: 0.7 },
      ],
      { recencyKey: (item) => item.recency ?? 0 },
    );
    expect(result.pattern).toBe(1);
    if (result.pattern === 1) {
      expect(result.top.id).toBe('older');
    }
  });

  it('omitted recencyKey preserves input order on ties → pattern 2 with first as top', () => {
    const result = classifyConfidenceShape<TestRecord>([
      { record: r('first'), score: 0.85 },
      { record: r('second'), score: 0.86 },
    ]);
    expect(result.pattern).toBe(2);
    if (result.pattern === 2) {
      // Within epsilon, no recencyKey — input order preserved
      // (first entry wins the tiebreak position).
      expect(result.top.id).toBe('first');
      expect(result.close[0]?.id).toBe('second');
    }
  });
});

describe('D-137 P3 § A.5 — threshold override hatch (for calibration)', () => {
  it('caller can pin thresholds for deterministic asserts', () => {
    // With strict thresholds, even a 0.8 top collapses to pattern 3.
    const strict = classifyConfidenceShape<TestRecord>(
      [{ record: r('a'), score: 0.8 }],
      { dominantScore: 0.9 },
    );
    expect(strict.pattern).toBe(3);
    // With loose thresholds, a 0.5 top promotes to pattern 1.
    const loose = classifyConfidenceShape<TestRecord>(
      [{ record: r('a'), score: 0.5 }],
      { dominantScore: 0.4 },
    );
    expect(loose.pattern).toBe(1);
  });
});

describe('D-137 P3 § A.5 — sortByScoreWithRecency export', () => {
  it('sorts highest score first, stable across ties', () => {
    const sorted = sortByScoreWithRecency<TestRecord>([
      { record: r('a'), score: 0.5 },
      { record: r('b'), score: 0.9 },
      { record: r('c'), score: 0.7 },
    ]);
    expect(sorted.map((c) => c.record.id)).toEqual(['b', 'c', 'a']);
  });

  it('honours recencyKey within tiebreak epsilon', () => {
    const sorted = sortByScoreWithRecency<TestRecord>(
      [
        { record: r('older', 100), score: 0.85 },
        { record: r('newer', 200), score: 0.86 },
      ],
      { recencyKey: (item) => item.recency ?? 0 },
    );
    expect(sorted.map((c) => c.record.id)).toEqual(['newer', 'older']);
  });
});

describe('D-137 P3 § A.5 — internal measures', () => {
  it('top_margin is null when only one candidate carries a score', () => {
    const result = classifyConfidenceShape<TestRecord>([
      { record: r('only'), score: 0.95 },
      { record: r('unscored') },
    ]);
    if (result.pattern === 1) {
      expect(result.measures.top_score).toBe(0.95);
      expect(result.measures.top_margin).toBeNull();
    }
  });

  it('mean_score averages only scored candidates', () => {
    const result = classifyConfidenceShape<TestRecord>([
      { record: r('a'), score: 0.4 },
      { record: r('b'), score: 0.6 },
      { record: r('unscored') },
    ]);
    if (result.pattern === 3) {
      expect(result.measures.mean_score).toBeCloseTo(0.5);
    }
  });
});
