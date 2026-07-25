import { describe, it, expect } from 'vitest';
import { createCacheMetrics } from '../metrics.js';

describe('createCacheMetrics — counting', () => {
  it('increments totals per status', () => {
    const m = createCacheMetrics();
    m.record('hit',      { slug: 'a', category: 'data' });
    m.record('hit',      { slug: 'a', category: 'data' });
    m.record('miss',     { slug: 'a', category: 'data' });
    m.record('hit_stale',{ slug: 'a', category: 'data' });
    m.record('skipped',  { slug: 'w', category: 'action' });

    const s = m.snapshot();
    expect(s.total.hit).toBe(2);
    expect(s.total.hit_stale).toBe(1);
    expect(s.total.miss).toBe(1);
    expect(s.total.skipped).toBe(1);
  });

  it('splits by category', () => {
    const m = createCacheMetrics();
    m.record('hit',  { slug: 'x', category: 'data' });
    m.record('miss', { slug: 'y', category: 'ai' });
    m.record('hit',  { slug: 'x', category: 'data' });

    const s = m.snapshot();
    expect(s.by_category['data'].hit).toBe(2);
    expect(s.by_category['ai'].miss).toBe(1);
  });

  it('splits by slug', () => {
    const m = createCacheMetrics();
    m.record('hit',  { slug: 'deal-reader', category: 'data' });
    m.record('miss', { slug: 'contact-reader', category: 'data' });

    const s = m.snapshot();
    expect(s.by_slug['deal-reader'].hit).toBe(1);
    expect(s.by_slug['contact-reader'].miss).toBe(1);
  });

  it('buckets entries without category under "unknown"', () => {
    const m = createCacheMetrics();
    m.record('hit', { slug: 'x' });
    const s = m.snapshot();
    expect(s.by_category['unknown'].hit).toBe(1);
  });
});

describe('createCacheMetrics — derived hit_rate', () => {
  it('hits / (hits + misses)', () => {
    const m = createCacheMetrics();
    m.record('hit',  { slug: 'x', category: 'data' });
    m.record('hit',  { slug: 'x', category: 'data' });
    m.record('miss', { slug: 'y', category: 'data' });
    // skipped/hit_stale factor in per the spec
    m.record('hit_stale', { slug: 'z', category: 'data' });
    // hits = 2 + 1 = 3, misses = 1, attempts = 4, rate = 0.75
    expect(m.snapshot().hit_rate).toBeCloseTo(0.75);
  });

  it('null when no cacheable activity observed', () => {
    const m = createCacheMetrics();
    m.record('skipped', { slug: 'x' });
    expect(m.snapshot().hit_rate).toBeNull();
  });
});

describe('createCacheMetrics — avg_hit_age_ms', () => {
  it('averages across hits + hit_stale', () => {
    const m = createCacheMetrics();
    m.record('hit',       { slug: 'x', category: 'data', age_ms: 100 });
    m.record('hit',       { slug: 'x', category: 'data', age_ms: 200 });
    m.record('hit_stale', { slug: 'y', category: 'ai',   age_ms: 900 });
    // avg = (100 + 200 + 900) / 3 = 400
    expect(m.snapshot().avg_hit_age_ms).toBeCloseTo(400);
  });

  it('misses do not contribute to age average', () => {
    const m = createCacheMetrics();
    m.record('hit',  { slug: 'x', category: 'data', age_ms: 100 });
    m.record('miss', { slug: 'x', category: 'data' });
    expect(m.snapshot().avg_hit_age_ms).toBeCloseTo(100);
  });

  it('null when no hits have age_ms', () => {
    const m = createCacheMetrics();
    m.record('miss', { slug: 'x' });
    expect(m.snapshot().avg_hit_age_ms).toBeNull();
  });
});

describe('createCacheMetrics — reset', () => {
  it('zeros all counters + buckets', () => {
    const m = createCacheMetrics();
    m.record('hit', { slug: 'x', category: 'data' });
    m.reset();
    const s = m.snapshot();
    expect(s.total.hit).toBe(0);
    expect(Object.keys(s.by_category).length).toBe(0);
    expect(Object.keys(s.by_slug).length).toBe(0);
  });
});

describe('createCacheMetrics — isolation', () => {
  it('snapshot returns a copy, not live state', () => {
    const m = createCacheMetrics();
    m.record('hit', { slug: 'x', category: 'data' });
    const s1 = m.snapshot();
    m.record('hit', { slug: 'x', category: 'data' });
    expect(s1.total.hit).toBe(1); // unchanged
    expect(m.snapshot().total.hit).toBe(2); // live
  });
});
