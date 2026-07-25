import { describe, it, expect } from 'vitest';
import {
  resolveTimeoutMs,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from '../timeout.js';

describe('resolveTimeoutMs', () => {
  it('undefined → default', () => {
    expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('null → default', () => {
    expect(resolveTimeoutMs(null)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('string → default (clamp-to-default)', () => {
    expect(resolveTimeoutMs('30000')).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs('forever')).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('NaN → default', () => {
    expect(resolveTimeoutMs(NaN)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('Infinity → default', () => {
    expect(resolveTimeoutMs(Infinity)).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs(-Infinity)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('object → default', () => {
    expect(resolveTimeoutMs({})).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs([])).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('0 → MIN_TIMEOUT_MS (clamp up)', () => {
    expect(resolveTimeoutMs(0)).toBe(MIN_TIMEOUT_MS);
  });

  it('negative → MIN_TIMEOUT_MS (clamp up)', () => {
    expect(resolveTimeoutMs(-1)).toBe(MIN_TIMEOUT_MS);
    expect(resolveTimeoutMs(-999_999)).toBe(MIN_TIMEOUT_MS);
  });

  it('below MIN → MIN_TIMEOUT_MS (clamp up)', () => {
    expect(resolveTimeoutMs(50)).toBe(MIN_TIMEOUT_MS);
    expect(resolveTimeoutMs(MIN_TIMEOUT_MS - 1)).toBe(MIN_TIMEOUT_MS);
  });

  it('exactly MIN → MIN unchanged', () => {
    expect(resolveTimeoutMs(MIN_TIMEOUT_MS)).toBe(MIN_TIMEOUT_MS);
  });

  it('in range → unchanged', () => {
    expect(resolveTimeoutMs(1_000)).toBe(1_000);
    expect(resolveTimeoutMs(30_000)).toBe(30_000);
    expect(resolveTimeoutMs(90_000)).toBe(90_000);
  });

  it('exactly MAX → MAX unchanged', () => {
    expect(resolveTimeoutMs(MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS);
  });

  it('above MAX → MAX (clamp down)', () => {
    expect(resolveTimeoutMs(MAX_TIMEOUT_MS + 1)).toBe(MAX_TIMEOUT_MS);
    expect(resolveTimeoutMs(999_999)).toBe(MAX_TIMEOUT_MS);
    expect(resolveTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMEOUT_MS);
  });

  it('never throws on any input', () => {
    const junk = [Symbol('x'), () => 1, new Date(), BigInt(42) as unknown];
    for (const v of junk) {
      expect(() => resolveTimeoutMs(v)).not.toThrow();
      expect(resolveTimeoutMs(v)).toBe(DEFAULT_TIMEOUT_MS);
    }
  });
});
