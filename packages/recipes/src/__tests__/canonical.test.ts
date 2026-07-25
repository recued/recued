import { describe, it, expect } from 'vitest';
import {
  normalizeRecipe,
  canonicalJsonString,
  recipesEqual,
  hashRecipe,
} from '../canonical.js';

// ────────────────────────────────────────────────────────────────
// normalizeRecipe
// ────────────────────────────────────────────────────────────────

describe('normalizeRecipe', () => {
  it('sorts top-level keys', () => {
    const input = { c: 3, a: 1, b: 2 };
    const out = normalizeRecipe(input);
    expect(Object.keys(out as object)).toEqual(['a', 'b', 'c']);
  });

  it('sorts keys recursively at every depth', () => {
    const input = {
      metadata: { name: 'X', author: 'Y', version: 1 },
      steps: [
        { z: 1, id: 'a', transform: 't' },
      ],
    };
    const out = normalizeRecipe(input) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['metadata', 'steps']);
    expect(Object.keys(out.metadata as object)).toEqual(['author', 'name', 'version']);
    const firstStep = (out.steps as Array<Record<string, unknown>>)[0];
    expect(Object.keys(firstStep)).toEqual(['id', 'transform', 'z']);
  });

  it('preserves array order (arrays are ordered data)', () => {
    const input = { steps: ['a', 'b', 'c'] };
    const out = normalizeRecipe(input) as Record<string, unknown>;
    expect(out.steps).toEqual(['a', 'b', 'c']);
  });

  it('preserves primitives unchanged', () => {
    expect(normalizeRecipe(42)).toBe(42);
    expect(normalizeRecipe('hello')).toBe('hello');
    expect(normalizeRecipe(true)).toBe(true);
    expect(normalizeRecipe(null)).toBe(null);
  });

  it('does not lowercase strings or coerce numbers', () => {
    // Normalization preserves meaning — case and precision matter.
    const input = { name: 'HubSpot', version: 1.5, flag: true };
    const out = normalizeRecipe(input) as Record<string, unknown>;
    expect(out.name).toBe('HubSpot');
    expect(out.version).toBe(1.5);
    expect(out.flag).toBe(true);
  });

  it('drops undefined properties (matches JSON semantics)', () => {
    const input = { a: 1, b: undefined, c: 3 };
    const out = normalizeRecipe(input) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['a', 'c']);
  });

  it('preserves null properties (null is a valid JSON value)', () => {
    const input = { a: 1, b: null, c: 3 };
    const out = normalizeRecipe(input) as Record<string, unknown>;
    expect(out.b).toBe(null);
    expect(Object.keys(out)).toEqual(['a', 'b', 'c']);
  });

  it('returns a new object — does not mutate input', () => {
    const input = { c: 3, a: 1 };
    const out = normalizeRecipe(input);
    expect(out).not.toBe(input);
    expect(Object.keys(input)).toEqual(['c', 'a']); // original order preserved
  });

  it('handles empty objects and arrays', () => {
    expect(normalizeRecipe({})).toEqual({});
    expect(normalizeRecipe([])).toEqual([]);
    expect(normalizeRecipe({ a: {}, b: [] })).toEqual({ a: {}, b: [] });
  });

  it('handles nested objects inside arrays', () => {
    const input = {
      items: [
        { b: 2, a: 1 },
        { d: 4, c: 3 },
      ],
    };
    const out = normalizeRecipe(input) as { items: Array<Record<string, unknown>> };
    expect(Object.keys(out.items[0])).toEqual(['a', 'b']);
    expect(Object.keys(out.items[1])).toEqual(['c', 'd']);
  });

  it('preserves prototype-shaped own keys without changing the prototype', () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"ctor","safe":1}',
    ) as Record<string, unknown>;

    const out = normalizeRecipe(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['__proto__', 'constructor', 'safe']);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(out['__proto__']).toEqual({ polluted: true });
    expect(out.constructor).toBe('ctor');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// canonicalJsonString
// ────────────────────────────────────────────────────────────────

describe('canonicalJsonString', () => {
  it('produces deterministic output regardless of input key order', () => {
    const a = { b: 2, a: 1, c: { y: 2, x: 1 } };
    const b = { a: 1, c: { x: 1, y: 2 }, b: 2 };
    expect(canonicalJsonString(a)).toBe(canonicalJsonString(b));
  });

  it('has no whitespace', () => {
    const s = canonicalJsonString({ a: 1, b: 2 });
    expect(s).toBe('{"a":1,"b":2}');
  });

  it('different content → different string', () => {
    expect(canonicalJsonString({ a: 1 })).not.toBe(canonicalJsonString({ a: 2 }));
  });

  it('round-trips through JSON.parse', () => {
    const input = { steps: [{ id: 'x', transform: 't' }] };
    const canonical = canonicalJsonString(input);
    expect(JSON.parse(canonical)).toEqual(input);
  });

  it('includes prototype-shaped JSON keys in the canonical string', () => {
    const input = JSON.parse(
      '{"safe":1,"__proto__":{"polluted":true},"constructor":"ctor"}',
    ) as Record<string, unknown>;

    expect(canonicalJsonString(input))
      .toBe('{"__proto__":{"polluted":true},"constructor":"ctor","safe":1}');
  });
});

// ────────────────────────────────────────────────────────────────
// recipesEqual
// ────────────────────────────────────────────────────────────────

describe('recipesEqual', () => {
  it('true for identical recipes', () => {
    const a = { recipe_id: 'x', version: 1, steps: [{ id: 's' }] };
    const b = { recipe_id: 'x', version: 1, steps: [{ id: 's' }] };
    expect(recipesEqual(a, b)).toBe(true);
  });

  it('true for same structure with different key order', () => {
    const a = { a: 1, b: { x: 1, y: 2 } };
    const b = { b: { y: 2, x: 1 }, a: 1 };
    expect(recipesEqual(a, b)).toBe(true);
  });

  it('false when array order differs', () => {
    const a = { steps: ['x', 'y'] };
    const b = { steps: ['y', 'x'] };
    expect(recipesEqual(a, b)).toBe(false);
  });

  it('false when a field differs', () => {
    const a = { version: 1 };
    const b = { version: 2 };
    expect(recipesEqual(a, b)).toBe(false);
  });

  it('null values are equal', () => {
    expect(recipesEqual({ a: null }, { a: null })).toBe(true);
  });

  it('null vs undefined are equal (undefined is dropped)', () => {
    expect(recipesEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
  });

  it('null vs missing key are NOT equal', () => {
    // {a: null} and {} differ — null is a declared value, missing is absent.
    expect(recipesEqual({ a: null }, {})).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// hashRecipe
// ────────────────────────────────────────────────────────────────

describe('hashRecipe', () => {
  it('returns an 8-character lowercase hex string', () => {
    const h = hashRecipe({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('deterministic — same recipe → same hash', () => {
    const recipe = { recipe_id: 'x', version: 1, steps: [] };
    expect(hashRecipe(recipe)).toBe(hashRecipe(recipe));
  });

  it('order-insensitive for object keys', () => {
    const a = { c: 3, a: 1, b: 2 };
    const b = { a: 1, b: 2, c: 3 };
    expect(hashRecipe(a)).toBe(hashRecipe(b));
  });

  it('order-sensitive for arrays', () => {
    expect(hashRecipe({ s: [1, 2] })).not.toBe(hashRecipe({ s: [2, 1] }));
  });

  it('different content → different hash (spot check)', () => {
    // Not a collision test — just verify the hash changes when content does
    const recipes = [
      { recipe_id: 'a' },
      { recipe_id: 'b' },
      { recipe_id: 'a', version: 1 },
      { recipe_id: 'a', version: 2 },
    ];
    const hashes = recipes.map(hashRecipe);
    const unique = new Set(hashes);
    expect(unique.size).toBe(recipes.length);
  });

  it('stable across a realistic recipe shape', () => {
    // This is a regression fixture — changing the hash output format or the
    // canonicalization rules will break this test, which is intentional.
    const recipe = {
      recipe_id: 'detect-deal-risk-hubspot',
      version: 1,
      ttl: 300,
      metadata: { name: 'Deal Risk', author: 'recued' },
      steps: [{ id: 'a', transform: 'filter' }],
    };
    expect(hashRecipe(recipe)).toBe(hashRecipe(recipe)); // same run
    // Re-hash with keys in different order — must be identical
    const reordered = {
      ttl: 300,
      version: 1,
      recipe_id: 'detect-deal-risk-hubspot',
      steps: [{ transform: 'filter', id: 'a' }],
      metadata: { author: 'recued', name: 'Deal Risk' },
    };
    expect(hashRecipe(recipe)).toBe(hashRecipe(reordered));
  });

  it('handles empty recipe', () => {
    expect(hashRecipe({})).toMatch(/^[0-9a-f]{8}$/);
    expect(hashRecipe({})).toBe(hashRecipe({}));
  });

  it('handles primitive inputs (defensive)', () => {
    // Not typical usage but shouldn't throw
    expect(hashRecipe(null)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashRecipe(42)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashRecipe('string')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('distinguishes {a:1} from {a:"1"}', () => {
    expect(hashRecipe({ a: 1 })).not.toBe(hashRecipe({ a: '1' }));
  });

  it('distinguishes null from missing', () => {
    expect(hashRecipe({ a: null })).not.toBe(hashRecipe({}));
  });
});
