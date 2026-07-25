import { describe, it, expect } from 'vitest';
import { canonicalHash } from '../hash.js';
import { all, equivalenceGroups } from './fixtures.js';

describe('canonicalHash — shape', () => {
  it('returns 64 hex chars (SHA-256)', async () => {
    const h = await canonicalHash({ a: 1 });
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });
});

describe('canonicalHash — known SHA-256 vector', () => {
  it('hash of canonicalize("hello") matches spec SHA-256 of \'"hello"\'', async () => {
    const h = await canonicalHash('hello');
    expect(h).toBe('5aa762ae383fbb727af3c7a36d4940a5b8c40a989452d2304fc958ff3f354e7a');
  });
});

describe('canonicalHash — determinism across fixture corpus', () => {
  for (const fx of all) {
    it(`stable: ${fx.name}`, async () => {
      const a = await canonicalHash(fx.input);
      const b = await canonicalHash(fx.input);
      expect(a).toBe(b);
    });
  }
});

describe('canonicalHash — equivalence groups produce identical hash', () => {
  for (const group of equivalenceGroups) {
    it(group.name, async () => {
      const hashes = await Promise.all(group.inputs.map((i) => canonicalHash(i)));
      const first = hashes[0];
      for (const h of hashes) {
        expect(h).toBe(first);
      }
    });
  }
});

describe('canonicalHash — different inputs produce different hashes', () => {
  it('different primitives', async () => {
    const a = await canonicalHash('a');
    const b = await canonicalHash('b');
    expect(a).not.toBe(b);
  });

  it('different object values', async () => {
    const a = await canonicalHash({ x: 1 });
    const b = await canonicalHash({ x: 2 });
    expect(a).not.toBe(b);
  });

  it('structurally different but "similar" inputs', async () => {
    const a = await canonicalHash({ a: 1 });
    const b = await canonicalHash([{ a: 1 }]);
    expect(a).not.toBe(b);
  });
});
