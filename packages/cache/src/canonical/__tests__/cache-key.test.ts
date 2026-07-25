import { describe, it, expect } from 'vitest';
import { cacheKey } from '../cache-key.js';

const base = {
  ingredient_slug: 'deal-reader-hubspot',
  manifest_version: '1.0.0',
  inputs: { deal_id: '42' },
};

describe('cacheKey — format', () => {
  it('produces v1:slug@version:hash (no instance_id — D-103)', async () => {
    const k = await cacheKey(base);
    expect(k).toMatch(/^v1:deal-reader-hubspot@1\.0\.0:[0-9a-f]{64}$/);
  });
});

describe('cacheKey — determinism', () => {
  it('same input → same key', async () => {
    const a = await cacheKey(base);
    const b = await cacheKey(base);
    expect(a).toBe(b);
  });

  it('input key order irrelevant', async () => {
    const a = await cacheKey({ ...base, inputs: { a: 1, b: 2 } });
    const b = await cacheKey({ ...base, inputs: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });
});

describe('cacheKey — isolation', () => {
  it('different slug → different key', async () => {
    const a = await cacheKey(base);
    const b = await cacheKey({ ...base, ingredient_slug: 'contact-reader-hubspot' });
    expect(a).not.toBe(b);
  });

  it('different manifest_version → different key', async () => {
    const a = await cacheKey(base);
    const b = await cacheKey({ ...base, manifest_version: '2.0.0' });
    expect(a).not.toBe(b);
  });

  it('different inputs → different key', async () => {
    const a = await cacheKey(base);
    const b = await cacheKey({ ...base, inputs: { deal_id: '99' } });
    expect(a).not.toBe(b);
  });
});

describe('cacheKey — validation', () => {
  it('rejects slug with uppercase', async () => {
    await expect(cacheKey({ ...base, ingredient_slug: 'Deal-Reader' })).rejects.toThrow('ingredient_slug');
  });

  it('rejects slug with underscore (pattern mismatch)', async () => {
    await expect(cacheKey({ ...base, ingredient_slug: 'deal_reader' })).rejects.toThrow('ingredient_slug');
  });

  it('rejects slug starting with dash', async () => {
    await expect(cacheKey({ ...base, ingredient_slug: '-deal-reader' })).rejects.toThrow('ingredient_slug');
  });

  it('rejects manifest_version with disallowed chars', async () => {
    await expect(cacheKey({ ...base, manifest_version: '1.0 beta' })).rejects.toThrow('manifest_version');
  });

  it('accepts semver-like versions', async () => {
    await expect(cacheKey({ ...base, manifest_version: '1.0.0-beta.2' })).resolves.toBeDefined();
  });

  it('two different callers producing identical input converge on identical key (D-103)', async () => {
    const extKey = await cacheKey({ ...base });
    const serverKey = await cacheKey({ ...base });
    // Without instance_id in the hash, ext + server compute the same
    // key from the same inputs — which is what makes peer cache
    // sharing actually work.
    expect(extKey).toBe(serverKey);
  });
});
