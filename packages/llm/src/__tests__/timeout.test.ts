import { describe, it, expect } from 'vitest';
import {
  resolveLLMTimeoutMs,
  LLM_MIN_TIMEOUT_MS,
  LLM_HARD_CAP_MS,
} from '../timeout.js';

describe('LLM timeout policy — no auto-timeout by default', () => {
  it('undefined → null (no timer)', () => {
    expect(resolveLLMTimeoutMs(undefined)).toBeNull();
  });

  it('null → null (no timer)', () => {
    expect(resolveLLMTimeoutMs(null)).toBeNull();
  });

  it('non-number → null (no timer)', () => {
    expect(resolveLLMTimeoutMs('60000')).toBeNull();
    expect(resolveLLMTimeoutMs({})).toBeNull();
    expect(resolveLLMTimeoutMs('forever')).toBeNull();
  });

  it('NaN / Infinity → null', () => {
    expect(resolveLLMTimeoutMs(NaN)).toBeNull();
    expect(resolveLLMTimeoutMs(Infinity)).toBeNull();
    expect(resolveLLMTimeoutMs(-Infinity)).toBeNull();
  });

  it('Symbol / BigInt / function → null', () => {
    const junk: unknown[] = [Symbol('x'), BigInt(42), () => 1, new Date()];
    for (const v of junk) {
      expect(resolveLLMTimeoutMs(v)).toBeNull();
    }
  });
});

describe('LLM timeout — explicit opt-in values', () => {
  it('MIN and HARD_CAP constants are sane', () => {
    expect(LLM_MIN_TIMEOUT_MS).toBe(1_000);
    expect(LLM_HARD_CAP_MS).toBe(7_200_000);
    expect(LLM_HARD_CAP_MS).toBeGreaterThan(LLM_MIN_TIMEOUT_MS * 1000);
  });

  it('0 → MIN (opted in but below floor)', () => {
    expect(resolveLLMTimeoutMs(0)).toBe(LLM_MIN_TIMEOUT_MS);
  });

  it('negative → MIN (opted in but below floor)', () => {
    expect(resolveLLMTimeoutMs(-500)).toBe(LLM_MIN_TIMEOUT_MS);
  });

  it('below MIN → MIN', () => {
    expect(resolveLLMTimeoutMs(500)).toBe(LLM_MIN_TIMEOUT_MS);
  });

  it('in range → unchanged', () => {
    expect(resolveLLMTimeoutMs(30_000)).toBe(30_000);     // 30s
    expect(resolveLLMTimeoutMs(600_000)).toBe(600_000);   // 10 min
    expect(resolveLLMTimeoutMs(3_600_000)).toBe(3_600_000); // 1 hour
  });

  it('exactly MIN → MIN unchanged', () => {
    expect(resolveLLMTimeoutMs(LLM_MIN_TIMEOUT_MS)).toBe(LLM_MIN_TIMEOUT_MS);
  });

  it('exactly HARD_CAP → HARD_CAP unchanged', () => {
    expect(resolveLLMTimeoutMs(LLM_HARD_CAP_MS)).toBe(LLM_HARD_CAP_MS);
  });

  it('above HARD_CAP → HARD_CAP (clamp down)', () => {
    expect(resolveLLMTimeoutMs(LLM_HARD_CAP_MS + 1)).toBe(LLM_HARD_CAP_MS);
    expect(resolveLLMTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(LLM_HARD_CAP_MS);
  });
});
