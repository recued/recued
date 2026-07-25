import { describe, it, expect } from 'vitest';
import { resolveSlot, computeMaxTokens, shouldEnableThinking } from '../router.js';
import { LLMError } from '../types.js';
import type { LLMConfig, LLMSlot } from '../types.js';

const slot1: LLMSlot = {
  provider: 'openai',
  model: 'gpt-4.1-mini',
  api_key: 'sk-slot1',
};
const slot2: LLMSlot = {
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  api_key: 'sk-slot2',
  supports_thinking: true,
  max_output_tokens: 16000,
};

describe('resolveSlot', () => {
  it('throws when no slots are configured', () => {
    expect(() => resolveSlot('quality', {})).toThrow(LLMError);
  });

  it('defaults hint to "quality" when undefined', () => {
    const result = resolveSlot(undefined, { slot_1: slot1, slot_2: slot2 });
    expect(result.resolved_hint).toBe('quality');
    expect(result.slot).toBe(slot2);
    expect(result.used_fallback).toBe(false);
  });

  it('routes "fast" to slot_1', () => {
    const result = resolveSlot('fast', { slot_1: slot1, slot_2: slot2 });
    expect(result.slot).toBe(slot1);
    expect(result.used_fallback).toBe(false);
  });

  it('routes "quality" to slot_2 when available', () => {
    const result = resolveSlot('quality', { slot_1: slot1, slot_2: slot2 });
    expect(result.slot).toBe(slot2);
    expect(result.used_fallback).toBe(false);
  });

  it('routes "thinking" to slot_2 when available', () => {
    const result = resolveSlot('thinking', { slot_1: slot1, slot_2: slot2 });
    expect(result.slot).toBe(slot2);
  });

  it('falls back to slot_1 when slot_2 is missing (quality)', () => {
    const result = resolveSlot('quality', { slot_1: slot1 });
    expect(result.slot).toBe(slot1);
    expect(result.used_fallback).toBe(true);
  });

  it('falls back to slot_2 when slot_1 is missing (fast)', () => {
    const result = resolveSlot('fast', { slot_2: slot2 });
    expect(result.slot).toBe(slot2);
    expect(result.used_fallback).toBe(true);
  });

  it('free/anonymous with only slot_1 gets slot_1 regardless of hint', () => {
    const free: LLMConfig = { slot_1: slot1 };
    expect(resolveSlot('fast', free).slot).toBe(slot1);
    expect(resolveSlot('quality', free).slot).toBe(slot1);
    expect(resolveSlot('thinking', free).slot).toBe(slot1);
    expect(resolveSlot(undefined, free).slot).toBe(slot1);
  });
});

describe('computeMaxTokens', () => {
  it('fast uses 4000 as base budget', () => {
    expect(computeMaxTokens('fast', slot1)).toBe(4000);
  });

  it('quality uses 8000 as base budget', () => {
    expect(computeMaxTokens('quality', slot1)).toBe(8000);
  });

  it('clamps to slot max_output_tokens when declared', () => {
    const tight: LLMSlot = { ...slot1, max_output_tokens: 2000 };
    expect(computeMaxTokens('quality', tight)).toBe(2000);
  });

  it('does not clamp when slot ceiling is higher than requested', () => {
    expect(computeMaxTokens('quality', slot2)).toBe(8000);
  });
});

describe('shouldEnableThinking', () => {
  it('true only when hint=thinking AND slot supports it', () => {
    expect(shouldEnableThinking('thinking', slot2)).toBe(true);
    expect(shouldEnableThinking('thinking', slot1)).toBe(false);
    expect(shouldEnableThinking('quality', slot2)).toBe(false);
    expect(shouldEnableThinking('fast', slot2)).toBe(false);
  });
});
