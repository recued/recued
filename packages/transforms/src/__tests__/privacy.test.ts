import { describe, it, expect, beforeEach } from 'vitest';
import { hash_replace, hash_restore, redact } from '../privacy.js';
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
