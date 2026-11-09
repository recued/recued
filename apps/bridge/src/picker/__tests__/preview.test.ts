/** Brick 2 — selector preview helpers. */

import { describe, it, expect } from 'vitest';
import {
  formatMatchSummary,
  previewSelector,
  truncateSample,
  type PreviewProbes,
} from '../preview.js';

describe('formatMatchSummary', () => {
  it('covers invalid / none / one / many', () => {
    expect(formatMatchSummary(-1)).toBe('invalid selector');
    expect(formatMatchSummary(0)).toBe('no match');
    expect(formatMatchSummary(1)).toBe('1 match');
    expect(formatMatchSummary(5)).toBe('5 matches');
  });
});

describe('truncateSample', () => {
  it('passes null through', () => {
    expect(truncateSample(null)).toBeNull();
  });
  it('collapses whitespace and trims', () => {
    expect(truncateSample('  hello \n  world  ')).toBe('hello world');
  });
  it('truncates with an ellipsis past the cap', () => {
    const out = truncateSample('abcdef', 4);
    expect(out).toBe('abc…');
    expect(out?.length).toBe(4);
  });
  it('keeps text at or under the cap intact', () => {
    expect(truncateSample('abcd', 4)).toBe('abcd');
  });
});

describe('previewSelector', () => {
  const probes = (
    count: number,
    text: string | null = 'Sample text',
  ): PreviewProbes => ({
    count: () => count,
    readText: () => text,
  });

  it('short-circuits an empty selector without probing', () => {
    let probed = false;
    const out = previewSelector(
      { count: () => { probed = true; return 1; }, readText: () => null },
      '   ',
    );
    expect(probed).toBe(false);
    expect(out).toEqual({ count: 0, sample: null, summary: 'empty selector', ok: false });
  });

  it('reports a unique match with a sample', () => {
    const out = previewSelector(probes(1, 'Deal: Acme'), '#deal');
    expect(out.ok).toBe(true);
    expect(out.count).toBe(1);
    expect(out.sample).toBe('Deal: Acme');
    expect(out.summary).toBe('1 match');
  });

  it('reports multiple matches (not ok) and still samples the first', () => {
    const out = previewSelector(probes(3, 'first'), 'li');
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('3 matches');
    expect(out.sample).toBe('first');
  });

  it('omits the sample when nothing matches', () => {
    const out = previewSelector(probes(0), '.nope');
    expect(out.sample).toBeNull();
    expect(out.ok).toBe(false);
  });

  it('surfaces an invalid selector (probe returns -1)', () => {
    const out = previewSelector(probes(-1), '::bad::');
    expect(out.count).toBe(-1);
    expect(out.summary).toBe('invalid selector');
    expect(out.sample).toBeNull();
    expect(out.ok).toBe(false);
  });

  it('trims the selector before probing', () => {
    let seen = '';
    previewSelector({ count: (s) => { seen = s; return 1; }, readText: () => null }, '  #x  ');
    expect(seen).toBe('#x');
  });
});
