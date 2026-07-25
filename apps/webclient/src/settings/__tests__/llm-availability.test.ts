import { describe, expect, it } from 'vitest';

import {
  hasByokSlot,
  hasEnabledFreePool,
  hasLocalSlot,
  isAnyAiSourceConfigured,
} from '../llm-availability.js';

describe('llm-availability predicates', () => {
  it('treats null / empty / empty-pool config as no source configured', () => {
    expect(isAnyAiSourceConfigured(null)).toBe(false);
    expect(isAnyAiSourceConfigured({})).toBe(false);
    expect(isAnyAiSourceConfigured({ free_pool: [] })).toBe(false);
  });

  it('recognises a fully-specified BYOK slot', () => {
    // The wire redacts the secret to a boolean `has_key` (D-174 R28 Slice B),
    // so the availability gate reads that, not the (now absent) `api_key`.
    const config = {
      slot_1: { provider: 'anthropic', model: 'claude-opus', has_key: true },
    };
    expect(hasByokSlot(config)).toBe(true);
    expect(isAnyAiSourceConfigured(config)).toBe(true);
  });

  it('requires provider + model + has_key for a BYOK slot', () => {
    // provider + model but no key → not configured.
    expect(hasByokSlot({ slot_2: { provider: 'openai', model: 'gpt' } })).toBe(
      false,
    );
    // an explicit has_key:false (key cleared server-side) is also not configured.
    expect(
      hasByokSlot({ slot_2: { provider: 'openai', model: 'gpt', has_key: false } }),
    ).toBe(false);
    expect(isAnyAiSourceConfigured({ slot_2: { provider: 'openai' } })).toBe(
      false,
    );
  });

  it('recognises a local slot by base_url without a key', () => {
    const config = {
      slot_1: {
        provider: 'ollama',
        model: 'llama3',
        base_url: 'http://localhost:11434/v1',
      },
    };
    // no key → not a BYOK slot, but a valid local source.
    expect(hasByokSlot(config)).toBe(false);
    expect(hasLocalSlot(config)).toBe(true);
    expect(isAnyAiSourceConfigured(config)).toBe(true);
  });

  it('counts an enabled free-pool entry and ignores a disabled one', () => {
    expect(hasEnabledFreePool({ free_pool: [{ id: 'g', enabled: true }] })).toBe(
      true,
    );
    expect(
      hasEnabledFreePool({ free_pool: [{ id: 'g', enabled: false }] }),
    ).toBe(false);
    // entries default to enabled when the flag is absent.
    expect(hasEnabledFreePool({ free_pool: [{ id: 'g' }] })).toBe(true);
    expect(
      isAnyAiSourceConfigured({ free_pool: [{ id: 'g', enabled: true }] }),
    ).toBe(true);
  });

  it('ignores malformed entries (non-object slots / pool rows)', () => {
    expect(isAnyAiSourceConfigured({ slot_1: 'nope', free_pool: 'nope' })).toBe(
      false,
    );
    expect(isAnyAiSourceConfigured({ free_pool: [null, 42, 'x'] })).toBe(false);
  });
});
