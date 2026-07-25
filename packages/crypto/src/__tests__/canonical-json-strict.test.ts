/** D-148 — `canonicalJSONStringifyStrict` semantics tests.
 *
 *  Pins the strict-mode behavior that diverges from the lenient
 *  `canonicalJSONStringify`. Strict mode is consumed by Server
 *  Passport signing (via `@recued/contracts`); any silent change
 *  to its semantics would change passport signatures.
 *
 *  Byte parity for JSON-clean inputs is covered by
 *  `test/d-148-canonical-json-parity.test.ts`. This file ONLY
 *  exercises the strict-vs-lenient delta. */

import { describe, it, expect } from 'vitest';
import {
  canonicalJSONStringify,
  canonicalJSONStringifyStrict,
} from '../canonical-json.js';

describe('canonicalJSONStringifyStrict — non-finite numbers throw', () => {
  it('throws on top-level NaN', () => {
    expect(() => canonicalJSONStringifyStrict(Number.NaN)).toThrow(
      /non-finite/,
    );
  });

  it('throws on +Infinity', () => {
    expect(() =>
      canonicalJSONStringifyStrict(Number.POSITIVE_INFINITY),
    ).toThrow(/non-finite/);
  });

  it('throws on -Infinity', () => {
    expect(() =>
      canonicalJSONStringifyStrict(Number.NEGATIVE_INFINITY),
    ).toThrow(/non-finite/);
  });

  it('throws on non-finite number inside an object value', () => {
    expect(() =>
      canonicalJSONStringifyStrict({ a: 1, x: Number.NaN }),
    ).toThrow(/non-finite/);
  });

  it('throws on non-finite number inside an array element', () => {
    expect(() =>
      canonicalJSONStringifyStrict([1, Number.POSITIVE_INFINITY, 3]),
    ).toThrow(/non-finite/);
  });

  it('lenient still returns null for the same inputs', () => {
    expect(canonicalJSONStringify(Number.NaN)).toBe('null');
    expect(canonicalJSONStringify({ x: Number.NaN })).toBe('{"x":null}');
    expect(canonicalJSONStringify([1, Number.NaN, 3])).toBe('[1,null,3]');
  });
});

describe('canonicalJSONStringifyStrict — function / symbol values throw', () => {
  it('throws on function as object value', () => {
    expect(() =>
      canonicalJSONStringifyStrict({ a: 1, fn: () => 0 }),
    ).toThrow(/non-JSON value at key 'fn'/);
  });

  it('throws on symbol as object value', () => {
    expect(() =>
      canonicalJSONStringifyStrict({ a: 1, s: Symbol('x') }),
    ).toThrow(/non-JSON value at key 's'/);
  });

  it('throws on function as array element', () => {
    expect(() =>
      canonicalJSONStringifyStrict([1, () => 0, 3]),
    ).toThrow(/non-JSON value at array index 1/);
  });

  it('throws on symbol as array element', () => {
    expect(() =>
      canonicalJSONStringifyStrict([1, Symbol('x'), 3]),
    ).toThrow(/non-JSON value at array index 1/);
  });

  it('lenient still drops (objects) / nulls (arrays)', () => {
    expect(canonicalJSONStringify({ a: 1, fn: () => 0 })).toBe('{"a":1}');
    expect(canonicalJSONStringify([1, () => 0, 3])).toBe('[1,null,3]');
  });
});

describe('canonicalJSONStringifyStrict — BigInt throws', () => {
  it('throws on top-level BigInt', () => {
    expect(() => canonicalJSONStringifyStrict(42n)).toThrow(/bigint/);
  });

  it('throws on BigInt inside an object value', () => {
    expect(() =>
      canonicalJSONStringifyStrict({ x: 42n }),
    ).toThrow(/bigint/);
  });
});

describe('canonicalJSONStringifyStrict — JSON-clean inputs are byte-identical to lenient', () => {
  // Smoke check — full parity coverage lives in
  // `test/d-148-canonical-json-parity.test.ts`. This is a tripwire
  // so any future strict-mode behavior drift on JSON-clean inputs
  // breaks here too.
  it('plain nested object', () => {
    const value = {
      z: 1,
      a: { c: 1, b: { y: 'q', x: 'p' } },
      m: [{ n: 1, k: 2 }, { d: 'x', a: 'y' }],
    };
    expect(canonicalJSONStringifyStrict(value)).toBe(
      canonicalJSONStringify(value),
    );
  });

  it('undefined object values still omitted on both modes', () => {
    const value = { a: 1, b: undefined, c: 3 };
    expect(canonicalJSONStringifyStrict(value)).toBe('{"a":1,"c":3}');
    expect(canonicalJSONStringify(value)).toBe('{"a":1,"c":3}');
  });
});

describe('canonicalJSONStringifyStrict — top-level undefined throws (same as lenient)', () => {
  it('throws TypeError', () => {
    expect(() => canonicalJSONStringifyStrict(undefined)).toThrow(TypeError);
  });
});
