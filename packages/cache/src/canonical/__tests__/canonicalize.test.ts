import { describe, it, expect } from 'vitest';
import { canonicalize, CanonicalizationError } from '../canonicalize.js';
import { all, equivalenceGroups, rejections } from './fixtures.js';

describe('canonicalize — fixture corpus', () => {
  for (const fx of all) {
    it(fx.name, () => {
      expect(canonicalize(fx.input)).toBe(fx.expected);
    });
  }
});

describe('canonicalize — equivalence groups (same canonical output)', () => {
  for (const group of equivalenceGroups) {
    it(group.name, () => {
      const outputs = group.inputs.map((i) => canonicalize(i));
      const first = outputs[0];
      for (const out of outputs) {
        expect(out).toBe(first);
      }
    });
  }
});

describe('canonicalize — rejections', () => {
  for (const fx of rejections) {
    it(`rejects ${fx.name}`, () => {
      try {
        canonicalize(fx.input());
        throw new Error(`expected ${fx.name} to throw, but it did not`);
      } catch (err) {
        expect(err).toBeInstanceOf(CanonicalizationError);
        expect((err as Error).message).toContain(fx.errorMatch);
      }
    });
  }
});

describe('canonicalize — error carries path', () => {
  it('deep-nested rejection reports path', () => {
    try {
      canonicalize({ a: { b: { c: NaN } } });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as CanonicalizationError;
      expect(e).toBeInstanceOf(CanonicalizationError);
      expect(e.path).toBe('$.a.b.c');
    }
  });

  it('array index rejection reports path', () => {
    try {
      canonicalize([1, 2, NaN]);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as CanonicalizationError;
      expect(e.path).toBe('$[2]');
    }
  });
});

describe('canonicalize — determinism', () => {
  it('produces identical output on repeated calls', () => {
    const input = { z: 3, a: [1, { q: 5, p: 4 }], m: 'hello' };
    const a = canonicalize(input);
    const b = canonicalize(input);
    const c = canonicalize(input);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('treats sparse array holes as null even when Array.prototype has that index', () => {
    const proto = Array.prototype as unknown as Record<string, unknown>;
    const hadPrior = Object.prototype.hasOwnProperty.call(proto, '0');
    const prior = proto[0];
    proto[0] = 'inherited';
    try {
      const value = new Array(1);
      expect(canonicalize(value)).toBe('[null]');
    } finally {
      if (hadPrior) proto[0] = prior;
      else delete proto[0];
    }
  });
});
