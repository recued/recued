import { describe, it, expect } from 'vitest';
import { merge, pick, omit, rename, set } from '../object.js';
import { ctx } from './helpers.js';

const c = ctx();

describe('merge', () => {
  it('merges two objects', () => expect(merge({ sources: [{ a: 1 }, { b: 2 }] }, c)).toEqual({ a: 1, b: 2 }));
  it('later values override', () => expect(merge({ sources: [{ a: 1 }, { a: 2 }] }, c)).toEqual({ a: 2 }));
  it('skips non-objects', () => expect(merge({ sources: [{ a: 1 }, null, { b: 2 }] }, c)).toEqual({ a: 1, b: 2 }));

  it('filters __proto__ keys (prototype pollution prevention)', () => {
    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
    const result = merge({ sources: [malicious] }, c);
    expect(result).toEqual({ safe: 1 });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('filters constructor and prototype keys', () => {
    const result = merge({ sources: [{ constructor: 'bad', prototype: 'bad', ok: 1 }] }, c);
    expect(result).toEqual({ ok: 1 });
  });
});

describe('pick', () => {
  it('picks fields', () => expect(pick({ source: { a: 1, b: 2, c: 3 }, fields: ['a', 'c'] }, c)).toEqual({ a: 1, c: 3 }));
  it('returns source when no fields', () => expect(pick({ source: { a: 1 } }, c)).toEqual({ a: 1 }));
  it('returns null for null', () => expect(pick({ source: null }, c)).toBeNull());
  it('drops prototype-sensitive field names', () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":"bad","prototype":"bad","safe":1}');
    const result = pick({ source, fields: ['__proto__', 'constructor', 'prototype', 'safe'] }, c) as Record<string, unknown>;
    expect(result).toEqual({ safe: 1 });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((result as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('omit', () => {
  it('omits fields', () => expect(omit({ source: { a: 1, b: 2, c: 3 }, fields: ['b'] }, c)).toEqual({ a: 1, c: 3 }));
  it('drops prototype-sensitive source keys', () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":"bad","prototype":"bad","safe":1}');
    const result = omit({ source, fields: [] }, c) as Record<string, unknown>;
    expect(result).toEqual({ safe: 1 });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((result as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('rename', () => {
  it('renames keys', () => expect(rename({ source: { a: 1, b: 2 }, mapping: { a: 'x' } }, c)).toEqual({ x: 1, b: 2 }));
  it('drops mappings to prototype-sensitive names', () => {
    const result = rename({
      source: { safe: 1, proto: { polluted: true }, ctor: 'bad' },
      mapping: { proto: '__proto__', ctor: 'constructor' },
    }, c) as Record<string, unknown>;
    expect(result).toEqual({ safe: 1 });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((result as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('set', () => {
  it('sets a field', () => expect(set({ source: { a: 1 }, field: 'b', value: 2 }, c)).toEqual({ a: 1, b: 2 }));
  it('overwrites existing', () => expect(set({ source: { a: 1 }, field: 'a', value: 99 }, c)).toEqual({ a: 99 }));
  it('creates from null', () => expect(set({ source: null, field: 'a', value: 1 }, c)).toEqual({ a: 1 }));
  it('ignores prototype-sensitive target fields and strips them from source copy', () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":"bad","safe":1}');
    const result = set({ source, field: '__proto__', value: { polluted: true } }, c) as Record<string, unknown>;
    expect(result).toEqual({ safe: 1 });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((result as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
  });
});
