import { describe, it, expect, beforeEach } from 'vitest';
import { hash_replace, hash_restore, hashStepPiiFields, redact, restoreHashTokens } from '../privacy.js';
import { _resetHashCounter } from '../privacy.js';
import { ctx } from './helpers.js';

const c = ctx();

beforeEach(() => _resetHashCounter());

describe('hash_replace', () => {
  it('hashes specified fields', () => {
    const r = hash_replace({ data: { name: 'Alice', age: 30 }, fields: ['name'] }, c) as { data: Record<string, unknown>; mapping: Record<string, string> };
    expect(r.data.name).toMatch(/^HASH_/);
    expect(r.data.age).toBe(30);
    expect(Object.keys(r.mapping)).toHaveLength(1);
  });

  it('hashes nested in arrays', () => {
    const r = hash_replace({
      data: [{ name: 'Alice' }, { name: 'Bob' }],
      fields: ['name'],
    }, c) as { data: { name: string }[]; mapping: Record<string, string> };
    expect(r.data[0].name).toMatch(/^HASH_/);
    expect(r.data[1].name).toMatch(/^HASH_/);
    expect(Object.keys(r.mapping)).toHaveLength(2);
  });

  it('hashes every item of a list under a named field', () => {
    const r = hash_replace({ data: { to: ['lee@acme.example', 'kim@acme.example'], from: 'x' }, fields: ['to'] }, c) as { data: { to: string[]; from: string }; mapping: Record<string, string> };
    expect(r.data.to.every((t) => /^HASH_/.test(t))).toBe(true);
    expect(r.data.from).toBe('x');
    expect(Object.values(r.mapping).sort()).toEqual(['kim@acme.example', 'lee@acme.example']);
  });

  it('ignores missing fields', () => {
    const r = hash_replace({ data: { age: 30 }, fields: ['name'] }, c) as { data: Record<string, unknown>; mapping: Record<string, string> };
    expect(r.data.age).toBe(30);
    expect(Object.keys(r.mapping)).toHaveLength(0);
  });

  it('drops prototype-sensitive object keys while hashing', () => {
    const data = JSON.parse('{"__proto__":{"polluted":true},"constructor":"bad","prototype":"bad","name":"Alice"}');
    const r = hash_replace({ data, fields: ['name'] }, c) as { data: Record<string, unknown>; mapping: Record<string, string> };
    expect(r.data.name).toMatch(/^HASH_/);
    expect(Object.getPrototypeOf(r.data)).toBe(Object.prototype);
    expect((r.data as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(r.data, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(r.data, 'prototype')).toBe(false);
  });
});

describe('hash_restore', () => {
  it('restores hashed values', () => {
    const hashed = hash_replace({ data: { name: 'Alice', role: 'admin' }, fields: ['name'] }, c) as { data: unknown; mapping: Record<string, string> };
    const r = hash_restore({ data: hashed.data, mapping: hashed.mapping }, c) as Record<string, unknown>;
    expect(r.name).toBe('Alice');
    expect(r.role).toBe('admin');
  });

  it('restores hashes in string values', () => {
    _resetHashCounter();
    const hashed = hash_replace({ data: { name: 'Alice' }, fields: ['name'] }, c) as { data: unknown; mapping: Record<string, string> };
    const token = Object.keys(hashed.mapping)[0];
    const textWithHash = `Report for ${token}: excellent work`;
    const r = hash_restore({ data: textWithHash, mapping: hashed.mapping }, c);
    expect(r).toBe('Report for Alice: excellent work');
  });

  // ⛔ It rewrote the value's JSON text and parsed it back: a restored value with a
  // quote, a backslash or a newline left text that did not parse, and the step got
  // one raw string where it read an object.
  it('a restored value with a quote, a backslash or a newline keeps the object an object', () => {
    const hashed = hash_replace({ data: { name: 'Dana "DJ" O\\Brien\nSales' }, fields: ['name'] }, c) as { data: unknown; mapping: Record<string, string> };
    const token = Object.keys(hashed.mapping)[0]!;
    const r = hash_restore({ data: { summary: `Call ${token} today`, owners: [token] }, mapping: hashed.mapping }, c);
    expect(r).toEqual({ summary: 'Call Dana "DJ" O\\Brien\nSales today', owners: ['Dana "DJ" O\\Brien\nSales'] });
  });
});

describe('hashStepPiiFields — a step\'s pii_fields at dispatch', () => {
  it('numbers tokens per call, so the same input always hashes to the same request', () => {
    const input = { 'llm.prompt': { deal_name: 'Acme Expansion', contacts: [{ name: 'Dana' }, { name: 'Lee' }] } };
    const first = hashStepPiiFields(input, ['deal_name', 'name']);
    hash_replace({ data: { name: 'unrelated' }, fields: ['name'] }, c);
    const second = hashStepPiiFields(input, ['deal_name', 'name']);
    expect(second).toEqual(first);
    expect(first.data).toEqual({ 'llm.prompt': {
      deal_name: 'HASH_STEP_00000001', contacts: [{ name: 'HASH_STEP_00000002' }, { name: 'HASH_STEP_00000003' }],
    } });
    expect(first.mapping).toEqual({
      HASH_STEP_00000001: 'Acme Expansion', HASH_STEP_00000002: 'Dana', HASH_STEP_00000003: 'Lee',
    });
  });

  // ⛔ A named key used to hash only a single value and walk a list or object, so
  // `["to"]` sent every address of a mail's `to` list in clear while the PII trace
  // counted it covered.
  it('hides everything under a named key — a list\'s items, an object\'s values — and leaves the input untouched', () => {
    const input = {
      from: 'dana@northwind.example',
      to: ['lee@acme.example', 'kim@acme.example'],
      cc: [],
      deal: { name: 'Acme', amount: 5, owners: [{ email: 'o@acme.example' }], closed: null },
      note: 'kept',
    };
    const r = hashStepPiiFields(input, ['to', 'cc', 'deal']);
    expect(r.data).toEqual({
      from: 'dana@northwind.example',
      to: ['HASH_STEP_00000001', 'HASH_STEP_00000002'],
      cc: [],
      deal: { name: 'HASH_STEP_00000003', amount: 'HASH_STEP_00000004', owners: [{ email: 'HASH_STEP_00000005' }], closed: null },
      note: 'kept',
    });
    expect(r.mapping).toEqual({
      HASH_STEP_00000001: 'lee@acme.example', HASH_STEP_00000002: 'kim@acme.example',
      HASH_STEP_00000003: 'Acme', HASH_STEP_00000004: '5', HASH_STEP_00000005: 'o@acme.example',
    });
    expect(input.to).toEqual(['lee@acme.example', 'kim@acme.example']);
    expect(restoreHashTokens(r.data, r.mapping)).toEqual({ ...input, deal: { ...input.deal, amount: '5' } });
  });
});

describe('restoreHashTokens', () => {
  it('restores string leaves and object keys, and returns non-strings as they are', () => {
    const mapping = { HASH_STEP_00000001: 'Acme Expansion' };
    expect(restoreHashTokens({ HASH_STEP_00000001: { note: 'HASH_STEP_00000001 is late', n: 3, ok: true, none: null } }, mapping))
      .toEqual({ 'Acme Expansion': { note: 'Acme Expansion is late', n: 3, ok: true, none: null } });
  });

  it('makes one pass: a restored value carrying token text is not rewritten by a later token', () => {
    const mapping = { HASH_STEP_00000001: 'see HASH_STEP_00000002', HASH_STEP_00000002: 'Lee' };
    expect(restoreHashTokens('HASH_STEP_00000001 and HASH_STEP_00000002', mapping)).toBe('see HASH_STEP_00000002 and Lee');
  });

  it('drops a key that restores to a prototype-sensitive name', () => {
    const r = restoreHashTokens({ HASH_STEP_00000001: 'x', keep: 'y' }, { HASH_STEP_00000001: '__proto__' }) as Record<string, unknown>;
    expect(r).toEqual({ keep: 'y' });
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
  });

  it('returns the value as it is when there is nothing to restore', () => {
    const value = { a: 'HASH_STEP_00000001' };
    expect(restoreHashTokens(value, {})).toBe(value);
  });
});

describe('redact', () => {
  it('redacts fields', () => {
    const r = redact({ data: { name: 'Alice', age: 30 }, fields: ['name'] }, c) as Record<string, unknown>;
    expect(r.name).toBe('[REDACTED]');
    expect(r.age).toBe(30);
  });

  it('custom marker', () => {
    const r = redact({ data: { ssn: '123' }, fields: ['ssn'], marker: '***' }, c) as Record<string, unknown>;
    expect(r.ssn).toBe('***');
  });

  it('redacts nested in arrays', () => {
    const r = redact({
      data: [{ email: 'a@b.com' }, { email: 'c@d.com' }],
      fields: ['email'],
    }, c) as { email: string }[];
    expect(r[0].email).toBe('[REDACTED]');
    expect(r[1].email).toBe('[REDACTED]');
  });

  it('drops prototype-sensitive object keys while redacting', () => {
    const data = JSON.parse('{"__proto__":{"polluted":true},"constructor":"bad","prototype":"bad","safe":"ok"}');
    const r = redact({ data, fields: ['safe'] }, c) as Record<string, unknown>;
    expect(r.safe).toBe('[REDACTED]');
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect((r as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(r, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(r, 'prototype')).toBe(false);
  });
});
