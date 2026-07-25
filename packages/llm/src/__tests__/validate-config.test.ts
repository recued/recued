import { describe, it, expect } from 'vitest';
import { parseLLMConfig, LLMConfigValidationError } from '../validate-config.js';

const expectThrowsField = (fn: () => unknown, fieldPrefix: string): void => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LLMConfigValidationError);
    expect((e as LLMConfigValidationError).field).toMatch(new RegExp(`^${fieldPrefix}`));
    return;
  }
  throw new Error('expected throw');
};

describe('parseLLMConfig — top-level', () => {
  it('rejects non-objects', () => {
    expect(() => parseLLMConfig(42)).toThrow(LLMConfigValidationError);
    expect(() => parseLLMConfig('str')).toThrow(LLMConfigValidationError);
    expect(() => parseLLMConfig(null)).toThrow(LLMConfigValidationError);
    expect(() => parseLLMConfig([])).toThrow(LLMConfigValidationError);
  });

  it('accepts an empty object (partial-update semantics)', () => {
    expect(parseLLMConfig({})).toEqual({});
  });

  it('preserves absent fields as absent', () => {
    const out = parseLLMConfig({ slot_1: null });
    // slot_1 null is preserved; other fields absent
    expect(out.slot_1).toBeNull();
    expect('slot_2' in out).toBe(false);
    expect('free_pool' in out).toBe(false);
  });
});

describe('parseLLMConfig — slot validation', () => {
  it('accepts a minimal valid slot', () => {
    const out = parseLLMConfig({
      slot_1: { provider: 'openai', model: 'gpt-4', api_key: 'sk-x' },
    });
    expect(out.slot_1).toEqual({ provider: 'openai', model: 'gpt-4', api_key: 'sk-x' });
  });

  it('preserves capability fields', () => {
    const out = parseLLMConfig({
      slot_1: {
        provider: 'openai', model: 'gpt-4', api_key: 'sk-x',
        speed: 'quality', supports_json: true, supports_search: true,
        base_url: 'https://example.com/v1',
      },
    });
    expect(out.slot_1?.speed).toBe('quality');
    expect(out.slot_1?.supports_json).toBe(true);
    expect(out.slot_1?.supports_search).toBe(true);
    expect(out.slot_1?.base_url).toBe('https://example.com/v1');
  });

  it('preserves daily_budget_tokens (per-slot budget round-trips)', () => {
    const out = parseLLMConfig({
      slot_1: { provider: 'openai', model: 'gpt-4', api_key: 'sk-x', daily_budget_tokens: 50000 },
    });
    expect(out.slot_1?.daily_budget_tokens).toBe(50000);
  });

  it('rejects a negative daily_budget_tokens with field path', () => {
    expectThrowsField(
      () => parseLLMConfig({
        slot_1: { provider: 'openai', model: 'x', api_key: 'k', daily_budget_tokens: -1 },
      }),
      'slot_1.daily_budget_tokens',
    );
  });

  it('rejects unknown provider with field path', () => {
    expectThrowsField(
      () => parseLLMConfig({ slot_1: { provider: 'groq', model: 'x', api_key: 'k' } }),
      'slot_1.provider',
    );
  });

  it('rejects invalid speed', () => {
    expectThrowsField(
      () => parseLLMConfig({ slot_1: { provider: 'openai', model: 'x', api_key: 'k', speed: 'turbo' } }),
      'slot_1.speed',
    );
  });

  it('rejects non-string model/api_key', () => {
    expectThrowsField(
      () => parseLLMConfig({ slot_1: { provider: 'openai', model: 42, api_key: 'k' } }),
      'slot_1.model',
    );
    expectThrowsField(
      () => parseLLMConfig({ slot_2: { provider: 'openai', model: 'x', api_key: true } }),
      'slot_2.api_key',
    );
  });

  it('rejects wrong-type supports_json on a slot', () => {
    expectThrowsField(
      () => parseLLMConfig({
        slot_1: { provider: 'openai', model: 'x', api_key: 'k', supports_json: 'yes' },
      }),
      'slot_1.supports_json',
    );
  });
});

describe('parseLLMConfig — free_pool validation', () => {
  it('accepts a valid api entry', () => {
    const out = parseLLMConfig({
      free_pool: [
        {
          id: 'a1', type: 'api', provider: 'openai-compatible',
          model: 'llama', api_key: 'k', speed: 'fast',
          supports_json: true, enabled: true,
        },
      ],
    });
    expect(out.free_pool?.length).toBe(1);
    expect(out.free_pool?.[0]?.type).toBe('api');
  });

  it('rejects retired web-chat entries', () => {
    expectThrowsField(
      () => parseLLMConfig({
        free_pool: [
          { id: 'w1', type: 'web_chat', tab: 'gemini', speed: 'quality',
            supports_json: false, enabled: true },
        ],
      }),
      'free_pool\\[0\\].type',
    );
  });

  it('rejects an unknown entry type', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ id: 'x', type: 'mystery' }] }),
      'free_pool\\[0\\].type',
    );
  });

  it('rejects a non-array free_pool', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool: {} }),
      'free_pool',
    );
  });

  it('rejects negative cap values', () => {
    expectThrowsField(
      () => parseLLMConfig({
        free_pool: [
          { id: 'a', type: 'api', provider: 'openai', model: 'x', api_key: 'k',
            speed: 'fast', supports_json: true, enabled: true, daily_cap_tokens: -1 },
        ],
      }),
      'free_pool\\[0\\].daily_cap_tokens',
    );
  });
});

describe('parseLLMConfig — other fields', () => {
  it('accepts valid free_pool_strategy', () => {
    expect(parseLLMConfig({ free_pool_strategy: 'round_robin' }).free_pool_strategy).toBe('round_robin');
    expect(parseLLMConfig({ free_pool_strategy: 'weighted' }).free_pool_strategy).toBe('weighted');
  });

  it('rejects unknown strategy (including retired "priority")', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool_strategy: 'priority' }),
      'free_pool_strategy',
    );
    expectThrowsField(
      () => parseLLMConfig({ free_pool_strategy: 'magic' }),
      'free_pool_strategy',
    );
  });

  it('rejects non-boolean allow_upgrade_default', () => {
    expectThrowsField(
      () => parseLLMConfig({ allow_upgrade_default: 1 }),
      'allow_upgrade_default',
    );
  });

  it('accepts boolean allow_upgrade_default (both values)', () => {
    expect(parseLLMConfig({ allow_upgrade_default: true }).allow_upgrade_default).toBe(true);
    expect(parseLLMConfig({ allow_upgrade_default: false }).allow_upgrade_default).toBe(false);
  });

  it('accepts llm_gateway route controls and explicit null clears', () => {
    expect(parseLLMConfig({
      llm_gateway_default_route: 'slot:slot_1',
      llm_gateway_model_alias: 'seller-primary',
    })).toMatchObject({
      llm_gateway_default_route: 'slot:slot_1',
      llm_gateway_model_alias: 'seller-primary',
    });
    expect(parseLLMConfig({
      llm_gateway_default_route: 'slot:slot_2',
    }).llm_gateway_default_route).toBe('slot:slot_2');
    expect(parseLLMConfig({
      llm_gateway_default_route: 'pool',
    }).llm_gateway_default_route).toBe('pool');
    expect(parseLLMConfig({
      llm_gateway_default_route: null,
      llm_gateway_model_alias: null,
    })).toEqual({
      llm_gateway_default_route: null,
      llm_gateway_model_alias: null,
    });
  });

  it('rejects invalid llm_gateway route controls', () => {
    expectThrowsField(
      () => parseLLMConfig({ llm_gateway_default_route: 'slot:slot_3' }),
      'llm_gateway_default_route',
    );
    expectThrowsField(
      () => parseLLMConfig({ llm_gateway_default_route: false }),
      'llm_gateway_default_route',
    );
    expectThrowsField(
      () => parseLLMConfig({ llm_gateway_model_alias: 42 }),
      'llm_gateway_model_alias',
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Slot — capability-field error paths
// ────────────────────────────────────────────────────────────────

describe('parseLLMConfig — slot error paths', () => {
  it('rejects non-object, non-null slot value', () => {
    expectThrowsField(
      () => parseLLMConfig({ slot_1: 'not-an-object' }),
      'slot_1',
    );
    expectThrowsField(
      () => parseLLMConfig({ slot_2: 42 }),
      'slot_2',
    );
    // Arrays are non-null objects but must fall to `isObject` rejection.
    expectThrowsField(
      () => parseLLMConfig({ slot_1: ['a'] }),
      'slot_1',
    );
  });

  it('accepts explicit null for both slots (clear semantics)', () => {
    const out = parseLLMConfig({ slot_1: null, slot_2: null });
    expect(out.slot_1).toBeNull();
    expect(out.slot_2).toBeNull();
  });

  it('rejects non-string base_url on a slot', () => {
    expectThrowsField(
      () => parseLLMConfig({
        slot_1: { provider: 'openai', model: 'x', api_key: 'k', base_url: 123 },
      }),
      'slot_1.base_url',
    );
  });

  it('accepts base_url when present', () => {
    const out = parseLLMConfig({
      slot_1: { provider: 'openai-compatible', model: 'x', api_key: 'k', base_url: 'https://api.example.com' },
    });
    expect(out.slot_1?.base_url).toBe('https://api.example.com');
  });

  it('rejects non-numeric or negative max_output_tokens', () => {
    expectThrowsField(
      () => parseLLMConfig({
        slot_1: { provider: 'openai', model: 'x', api_key: 'k', max_output_tokens: 'big' },
      }),
      'slot_1.max_output_tokens',
    );
    expectThrowsField(
      () => parseLLMConfig({
        slot_1: { provider: 'openai', model: 'x', api_key: 'k', max_output_tokens: -1 },
      }),
      'slot_1.max_output_tokens',
    );
    expectThrowsField(
      () => parseLLMConfig({
        slot_1: { provider: 'openai', model: 'x', api_key: 'k', max_output_tokens: Number.POSITIVE_INFINITY },
      }),
      'slot_1.max_output_tokens',
    );
  });

  it('accepts zero and positive max_output_tokens', () => {
    const zero = parseLLMConfig({
      slot_1: { provider: 'openai', model: 'x', api_key: 'k', max_output_tokens: 0 },
    });
    expect(zero.slot_1?.max_output_tokens).toBe(0);
    const n = parseLLMConfig({
      slot_1: { provider: 'openai', model: 'x', api_key: 'k', max_output_tokens: 4096 },
    });
    expect(n.slot_1?.max_output_tokens).toBe(4096);
  });

  it('accepts a positive-integer context_window_tokens and rejects invalid values', () => {
    const out = parseLLMConfig({
      slot_1: {
        provider: 'openai', model: 'x', api_key: 'k', context_window_tokens: 128_000,
      },
    });
    expect(out.slot_1?.context_window_tokens).toBe(128_000);

    for (const value of [0, -1, 8_192.5, Number.POSITIVE_INFINITY]) {
      expectThrowsField(
        () => parseLLMConfig({
          slot_1: {
            provider: 'openai', model: 'x', api_key: 'k', context_window_tokens: value,
          },
        }),
        'slot_1.context_window_tokens',
      );
    }
  });

  it('rejects non-boolean supports_search on a slot', () => {
    expectThrowsField(
      () => parseLLMConfig({
        slot_1: { provider: 'openai', model: 'x', api_key: 'k', supports_search: 'yes' },
      }),
      'slot_1.supports_search',
    );
  });

  it('rejects non-boolean supports_thinking on a slot', () => {
    expectThrowsField(
      () => parseLLMConfig({
        slot_1: { provider: 'openai', model: 'x', api_key: 'k', supports_thinking: 1 },
      }),
      'slot_1.supports_thinking',
    );
  });

  it('preserves supports_thinking when explicitly set', () => {
    const out = parseLLMConfig({
      slot_2: { provider: 'anthropic', model: 'c', api_key: 'k', supports_thinking: true },
    });
    expect(out.slot_2?.supports_thinking).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Free pool — API entry error paths
// ────────────────────────────────────────────────────────────────

describe('parseLLMConfig — api entry error paths', () => {
  const base = {
    id: 'a', type: 'api', provider: 'openai', model: 'x', api_key: 'k',
    speed: 'fast', supports_json: true, enabled: true,
  };

  it('rejects missing / non-string id', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ ...base, id: 42 }] }),
      'free_pool\\[0\\].id',
    );
  });

  it('rejects unknown provider on an api entry', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ ...base, provider: 'groq' }] }),
      'free_pool\\[0\\].provider',
    );
  });

  it('rejects non-string model / api_key on an api entry', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ ...base, model: {} }] }),
      'free_pool\\[0\\].model',
    );
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ ...base, api_key: null }] }),
      'free_pool\\[0\\].api_key',
    );
  });

  it('rejects invalid speed on an api entry', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ ...base, speed: 'turbo' }] }),
      'free_pool\\[0\\].speed',
    );
  });

  it('rejects non-boolean supports_json on an api entry', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ ...base, supports_json: 'yes' }] }),
      'free_pool\\[0\\].supports_json',
    );
  });

  it('rejects non-boolean enabled on an api entry', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ ...base, enabled: 1 }] }),
      'free_pool\\[0\\].enabled',
    );
  });

  it('rejects non-string base_url on an api entry', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ ...base, base_url: 42 }] }),
      'free_pool\\[0\\].base_url',
    );
  });

  it('rejects non-boolean supports_search on an api entry', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ ...base, supports_search: 'yes' }] }),
      'free_pool\\[0\\].supports_search',
    );
  });

  it('rejects invalid weight / negative rpm_cap on an api entry', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ ...base, weight: -1 }] }),
      'free_pool\\[0\\].weight',
    );
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ ...base, weight: Number.NaN }] }),
      'free_pool\\[0\\].weight',
    );
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [{ ...base, rpm_cap: -5 }] }),
      'free_pool\\[0\\].rpm_cap',
    );
  });

  it('preserves optional api-entry fields when valid', () => {
    const out = parseLLMConfig({
      free_pool: [{
        ...base,
        base_url: 'https://api.example.com',
        supports_search: true,
        weight: 3,
        daily_cap_tokens: 1000,
        rpm_cap: 60,
        context_window_tokens: 32_768,
      }],
    });
    const entry = out.free_pool?.[0];
    if (entry?.type !== 'api') throw new Error('expected api entry');
    expect(entry.base_url).toBe('https://api.example.com');
    expect(entry.supports_search).toBe(true);
    expect(entry.weight).toBe(3);
    expect(entry.daily_cap_tokens).toBe(1000);
    expect(entry.rpm_cap).toBe(60);
    expect(entry.context_window_tokens).toBe(32_768);
  });

  it('rejects invalid context_window_tokens on an api entry', () => {
    for (const value of [0, -1, 4_096.5, Number.POSITIVE_INFINITY]) {
      expectThrowsField(
        () => parseLLMConfig({
          free_pool: [{ ...base, context_window_tokens: value }],
        }),
        'free_pool\\[0\\].context_window_tokens',
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────
// parsePoolEntry dispatch
// ────────────────────────────────────────────────────────────────

describe('parseLLMConfig — pool entry dispatch', () => {
  it('rejects a non-object pool entry', () => {
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [42] }),
      'free_pool\\[0\\]',
    );
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [null] }),
      'free_pool\\[0\\]',
    );
  });

  it('surfaces the index in the field path of a later bad entry', () => {
    const good = {
      id: 'a', type: 'api', provider: 'openai', model: 'x', api_key: 'k',
      speed: 'fast', supports_json: true, enabled: true,
    };
    expectThrowsField(
      () => parseLLMConfig({ free_pool: [good, { ...good, provider: 'invalid' }] }),
      'free_pool\\[1\\].provider',
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Lever-2 per-slot — catalog_modes validation
// ────────────────────────────────────────────────────────────────

describe('parseLLMConfig — catalog_modes', () => {
  it('accepts a full valid source→mode map', () => {
    const out = parseLLMConfig({
      catalog_modes: { slot_1: 'full', slot_2: 'index', free_pool: 'lean-core' },
    });
    expect(out.catalog_modes).toEqual({
      slot_1: 'full', slot_2: 'index', free_pool: 'lean-core',
    });
  });

  it('accepts an empty map', () => {
    const out = parseLLMConfig({ catalog_modes: {} });
    expect(out.catalog_modes).toEqual({});
  });

  it('accepts a partial map (one source)', () => {
    const out = parseLLMConfig({ catalog_modes: { free_pool: 'index' } });
    expect(out.catalog_modes).toEqual({ free_pool: 'index' });
  });

  it('preserves the field as absent when not provided', () => {
    const out = parseLLMConfig({ slot_1: null });
    expect('catalog_modes' in out).toBe(false);
  });

  it('rejects a non-object catalog_modes', () => {
    expectThrowsField(() => parseLLMConfig({ catalog_modes: 'index' }), 'catalog_modes');
    expectThrowsField(() => parseLLMConfig({ catalog_modes: 42 }), 'catalog_modes');
    expectThrowsField(() => parseLLMConfig({ catalog_modes: [] }), 'catalog_modes');
    expectThrowsField(() => parseLLMConfig({ catalog_modes: null }), 'catalog_modes');
  });

  it('rejects an unknown source key', () => {
    expectThrowsField(
      () => parseLLMConfig({ catalog_modes: { slot_3: 'index' } }),
      'catalog_modes.slot_3',
    );
    expectThrowsField(
      () => parseLLMConfig({ catalog_modes: { embeddings_slot: 'index' } }),
      'catalog_modes.embeddings_slot',
    );
  });

  it('rejects an invalid mode value', () => {
    expectThrowsField(
      () => parseLLMConfig({ catalog_modes: { slot_1: 'thin' } }),
      'catalog_modes.slot_1',
    );
    expectThrowsField(
      () => parseLLMConfig({ catalog_modes: { free_pool: 42 } }),
      'catalog_modes.free_pool',
    );
  });

  it('rejects a real __proto__ own-key from a JSON payload (pollution-safe)', () => {
    // JSON.parse creates a GENUINE own `__proto__` property (unlike the object-
    // literal syntax, which sets the prototype), so this is the realistic
    // over-the-wire attack vector. It is not a valid source id → rejected before
    // any assignment, so nothing is polluted.
    const payload = { catalog_modes: JSON.parse('{"__proto__":"index"}') as unknown };
    expectThrowsField(() => parseLLMConfig(payload), 'catalog_modes');
    // A valid map's output carries a clean Object prototype.
    const clean = parseLLMConfig({ catalog_modes: { slot_1: 'index' } });
    expect(Object.getPrototypeOf(clean.catalog_modes)).toBe(Object.prototype);
  });
});

// ────────────────────────────────────────────────────────────────
// LLMConfigValidationError shape
// ────────────────────────────────────────────────────────────────

describe('LLMConfigValidationError', () => {
  it('has a name, field, and formatted message', () => {
    try {
      parseLLMConfig({ slot_1: { provider: 'groq', model: 'x', api_key: 'k' } });
    } catch (e) {
      expect(e).toBeInstanceOf(LLMConfigValidationError);
      const err = e as LLMConfigValidationError;
      expect(err.name).toBe('LLMConfigValidationError');
      expect(err.field).toBe('slot_1.provider');
      expect(err.message.startsWith('slot_1.provider:')).toBe(true);
      return;
    }
    throw new Error('expected throw');
  });
});
