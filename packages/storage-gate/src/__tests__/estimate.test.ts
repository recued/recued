import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  estimateSize,
  estimateTotalSize,
  utf8ByteLength,
} from '../estimate.js';

describe('canonicalJson', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 1 })).toBe('{"a":1,"z":{"x":2,"y":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('stringifies primitives like JSON.stringify', () => {
    expect(canonicalJson('hello')).toBe('"hello"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('drops undefined properties (JSON-compatible)', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
  });

  it('coerces NaN / Infinity to null (JSON-compatible)', () => {
    expect(canonicalJson(NaN)).toBe('null');
    expect(canonicalJson(Infinity)).toBe('null');
    expect(canonicalJson(-Infinity)).toBe('null');
  });

  it('detects cycles and substitutes null (never throws)', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(() => canonicalJson(o)).not.toThrow();
    // "self" replaced with null on the cycle
    expect(canonicalJson(o)).toBe('{"a":1,"self":null}');
  });

  it('detects array cycles', () => {
    const a: unknown[] = [1];
    a.push(a);
    expect(canonicalJson(a)).toBe('[1,null]');
  });

  it('two structurally identical objects produce identical output', () => {
    const a = { foo: 1, bar: { baz: [1, 2] } };
    const b = { bar: { baz: [1, 2] }, foo: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('coerces BigInt to a string (JSON would throw)', () => {
    expect(canonicalJson(BigInt(42))).toBe('"42"');
  });

  it('coerces functions + symbols to null (JSON would drop them)', () => {
    expect(canonicalJson(() => 1)).toBe('null');
    expect(canonicalJson(Symbol('x'))).toBe('null');
  });
});

describe('utf8ByteLength', () => {
  it('returns 0 for empty string', () => {
    expect(utf8ByteLength('')).toBe(0);
  });

  it('matches TextEncoder byte count for ASCII', () => {
    expect(utf8ByteLength('hello')).toBe(5);
  });

  it('counts multi-byte characters correctly', () => {
    // é = 2 bytes (U+00E9), 中 = 3 bytes (U+4E2D), 😀 = 4 bytes (U+1F600)
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('中')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('hé中😀')).toBe(1 + 2 + 3 + 4);
  });

  it('returns 0 for non-string input (defensive)', () => {
    expect(utf8ByteLength(undefined as unknown as string)).toBe(0);
    expect(utf8ByteLength(null as unknown as string)).toBe(0);
  });
});

describe('estimateSize', () => {
  it('null / undefined → 4 bytes (the string "null")', () => {
    expect(estimateSize(null)).toBe(4);
    expect(estimateSize(undefined)).toBe(4);
  });

  it('strings → their UTF-8 byte count (not JSON-wrapped)', () => {
    // Strings are stored as-is in string-valued collections, so no JSON
    // quote overhead.
    expect(estimateSize('hello')).toBe(5);
    expect(estimateSize('😀')).toBe(4);
  });

  it('Uint8Array → its byteLength directly', () => {
    const buf = new Uint8Array(1024);
    expect(estimateSize(buf)).toBe(1024);
  });

  it('ArrayBuffer → its byteLength directly', () => {
    const buf = new ArrayBuffer(2048);
    expect(estimateSize(buf)).toBe(2048);
  });

  it('Buffer (Uint8Array subclass) → its byteLength', () => {
    const buf = Buffer.from('hello world', 'utf8');
    expect(estimateSize(buf)).toBe(11);
  });

  it('objects → canonical JSON byte length', () => {
    // canonical JSON of { a: 1 } is '{"a":1}' = 7 bytes
    expect(estimateSize({ a: 1 })).toBe(7);
  });

  it('arrays → canonical JSON byte length', () => {
    expect(estimateSize([1, 2, 3])).toBe(7); // '[1,2,3]'
  });

  it('numbers → canonical JSON byte length', () => {
    expect(estimateSize(42)).toBe(2);
    expect(estimateSize(3.14)).toBe(4);
  });

  it('booleans → canonical JSON byte length', () => {
    expect(estimateSize(true)).toBe(4); // 'true'
    expect(estimateSize(false)).toBe(5); // 'false'
  });

  it('is deterministic — same input, same size', () => {
    const a = { b: 2, a: 1, deep: { z: 3, y: [1, 2] } };
    const size1 = estimateSize(a);
    const size2 = estimateSize(a);
    const equivalent = { a: 1, deep: { y: [1, 2], z: 3 }, b: 2 };
    expect(size1).toBe(size2);
    expect(size1).toBe(estimateSize(equivalent));
  });

  it('never returns NaN, never negative', () => {
    for (const v of [null, undefined, 0, '', {}, [], NaN, Infinity]) {
      const size = estimateSize(v);
      expect(Number.isFinite(size)).toBe(true);
      expect(size).toBeGreaterThanOrEqual(0);
    }
  });

  it('scales roughly linearly with payload size', () => {
    const small = { s: 'x'.repeat(100) };
    const large = { s: 'x'.repeat(1000) };
    // canonical form of small = '{"s":"<100x>"}' = 100 + ~8 chars
    // canonical form of large = '{"s":"<1000x>"}' = 1000 + ~8 chars
    expect(estimateSize(large) - estimateSize(small)).toBe(900);
  });

  it('a 64 KB threshold payload crosses the CAS split correctly', () => {
    // The shared-store splits at 64 KB (value body). Make sure the
    // estimator sees values at that threshold accurately.
    const boundary = 'x'.repeat(64 * 1024);
    expect(estimateSize(boundary)).toBe(64 * 1024);
  });
});

describe('estimateTotalSize', () => {
  it('sums sizes across an iterable', () => {
    expect(estimateTotalSize(['a', 'bb', 'ccc'])).toBe(1 + 2 + 3);
  });

  it('accepts a generator', () => {
    function* gen() { yield 'a'; yield 'b'; }
    expect(estimateTotalSize(gen())).toBe(2);
  });

  it('empty iterable → 0', () => {
    expect(estimateTotalSize([])).toBe(0);
  });

  it('mixed types', () => {
    expect(estimateTotalSize(['x', 42, null, { a: 1 }])).toBe(
      1 + // 'x'
      2 + // '42'
      4 + // 'null'
      7,  // '{"a":1}'
    );
  });
});
