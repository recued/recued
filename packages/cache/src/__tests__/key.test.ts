import { describe, it, expect } from 'vitest';
import { computeCacheKey, estimateSize } from '../key.js';

describe('computeCacheKey', () => {
  it('produces stable key for same input', async () => {
    const k1 = await computeCacheKey('deal-reader-hubspot', { deal_id: '42' });
    const k2 = await computeCacheKey('deal-reader-hubspot', { deal_id: '42' });
    expect(k1).toBe(k2);
  });

  it('produces same key regardless of input key order', async () => {
    const k1 = await computeCacheKey('slug', { a: 1, b: 2, c: 3 });
    const k2 = await computeCacheKey('slug', { c: 3, a: 1, b: 2 });
    expect(k1).toBe(k2);
  });

  it('different slug → different key', async () => {
    const k1 = await computeCacheKey('slug-a', { x: 1 });
    const k2 = await computeCacheKey('slug-b', { x: 1 });
    expect(k1).not.toBe(k2);
  });

  it('different input → different key', async () => {
    const k1 = await computeCacheKey('slug', { x: 1 });
    const k2 = await computeCacheKey('slug', { x: 2 });
    expect(k1).not.toBe(k2);
  });

  it('returns 64 hex chars (SHA-256)', async () => {
    const k = await computeCacheKey('s', { a: 1 });
    expect(k).toHaveLength(64);
    expect(k).toMatch(/^[0-9a-f]+$/);
  });

  it('handles empty input', async () => {
    const k = await computeCacheKey('slug', {});
    expect(k).toHaveLength(64);
  });

  it('handles nested objects', async () => {
    const k1 = await computeCacheKey('s', { obj: { nested: 'value' } });
    const k2 = await computeCacheKey('s', { obj: { nested: 'value' } });
    expect(k1).toBe(k2);
  });

  it('keeps own __proto__ input fields in the key material', async () => {
    const unsafe = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const empty = await computeCacheKey('s', {});
    const withProtoField = await computeCacheKey('s', unsafe);
    expect(withProtoField).not.toBe(empty);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('estimateSize', () => {
  it('returns char count × 2 for objects', () => {
    expect(estimateSize({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length * 2);
  });

  it('returns 0 for unserializable values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(estimateSize(circular)).toBe(0);
  });

  it('counts strings', () => {
    expect(estimateSize('hello')).toBe('"hello"'.length * 2);
  });
});
