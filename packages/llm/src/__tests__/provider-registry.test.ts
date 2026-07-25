/** LLM provider registry substrate tests. */

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createDefaultEmbeddingsRegistry,
  createDefaultRegistry,
  LLMConfigValidationError,
  LLMError,
  LLM_PROVIDER_REGISTRY,
  parseLLMConfig,
  type AdapterKey,
  type ChatAdapterBuildDeps,
  type LLMAdapter,
  type LLMProvider,
  type LlmProviderEntry,
} from '../index.js';

type ChatProviderEntry = LlmProviderEntry & {
  buildChatAdapter: NonNullable<LlmProviderEntry['buildChatAdapter']>;
};

type EmbeddingsProviderEntry = LlmProviderEntry & {
  buildEmbeddingsAdapter: NonNullable<LlmProviderEntry['buildEmbeddingsAdapter']>;
};

const EXPECTED_PROVIDERS = [
  'anthropic',
  'openai',
  'openai-compatible',
  'google',
] as const satisfies readonly AdapterKey[];

const REAL_PROVIDERS = [
  'anthropic',
  'openai',
  'openai-compatible',
  'google',
] as const satisfies readonly LLMProvider[];

const PROVIDER_LIST_MSG = REAL_PROVIDERS.join(' | ');

const hasChatAdapter = (entry: LlmProviderEntry): entry is ChatProviderEntry =>
  typeof entry.buildChatAdapter === 'function';

const hasEmbeddingsAdapter = (
  entry: LlmProviderEntry,
): entry is EmbeddingsProviderEntry =>
  typeof entry.buildEmbeddingsAdapter === 'function';

const isRealProvider = (provider: AdapterKey): provider is LLMProvider =>
  (REAL_PROVIDERS as readonly string[]).includes(provider);

const ENTRY_CASES = LLM_PROVIDER_REGISTRY.map((entry) =>
  [entry.provider, entry] as const);

const CHAT_ENTRY_CASES = LLM_PROVIDER_REGISTRY
  .filter(hasChatAdapter)
  .map((entry) => [entry.provider, entry] as const);

const EMBEDDINGS_ENTRY_CASES = LLM_PROVIDER_REGISTRY
  .filter(hasEmbeddingsAdapter)
  .map((entry) => [entry.provider, entry] as const);

const REAL_CHAT_ENTRY_CASES = LLM_PROVIDER_REGISTRY
  .filter((entry): entry is ChatProviderEntry & { provider: LLMProvider } =>
    hasChatAdapter(entry) && isRealProvider(entry.provider))
  .map((entry) => [entry.provider, entry] as const);

const REAL_EMBEDDINGS_ENTRY_CASES = LLM_PROVIDER_REGISTRY
  .filter((entry): entry is EmbeddingsProviderEntry & { provider: LLMProvider } =>
    hasEmbeddingsAdapter(entry) && isRealProvider(entry.provider))
  .map((entry) => [entry.provider, entry] as const);

const mockedProviderModulePaths = [
  '../providers/anthropic.js',
  '../providers/openai.js',
  '../providers/openai-compatible.js',
  '../providers/google.js',
] as const;

const expectNotPromise = (value: unknown): void => {
  expect(value).not.toBeInstanceOf(Promise);
  const then = value !== null && value !== undefined
    ? (value as { then?: unknown }).then
    : undefined;
  expect(typeof then).not.toBe('function');
};

const minimalSlotConfig = (provider: unknown): unknown => ({
  slot_1: {
    provider,
    model: 'model',
    api_key: 'key',
  },
});

const buildChatRegistryFromEntries = (
  entries: ReadonlyArray<LlmProviderEntry>,
  deps: ChatAdapterBuildDeps,
) => {
  const map: Partial<Record<AdapterKey, LLMAdapter>> = {};
  for (const entry of entries) {
    if (!entry.buildChatAdapter) continue;
    const adapter = entry.buildChatAdapter(deps);
    if (adapter) {
      map[entry.provider] = adapter;
    }
  }

  return (key: AdapterKey): LLMAdapter => {
    const adapter = map[key];
    if (!adapter) {
      throw new LLMError('AI_LLM_UNAVAILABLE', `No adapter registered for: ${key}`);
    }
    return adapter;
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of mockedProviderModulePaths) {
    vi.doUnmock(path);
  }
  vi.resetModules();
});

describe('LLM_PROVIDER_REGISTRY shape + entry coverage', () => {
  it('exports exactly four entries in deterministic provider order', () => {
    expect(Array.isArray(LLM_PROVIDER_REGISTRY)).toBe(true);
    expect(LLM_PROVIDER_REGISTRY).toHaveLength(4);
    expect(LLM_PROVIDER_REGISTRY.map((entry) => entry.provider)).toEqual([
      'anthropic',
      'openai',
      'openai-compatible',
      'google',
    ]);
  });

  it('keeps provider keys to the expected closed set', () => {
    expect(new Set(LLM_PROVIDER_REGISTRY.map((entry) => entry.provider))).toEqual(
      new Set(EXPECTED_PROVIDERS),
    );
  });

  it('gives every entry a provider field', () => {
    for (const [_provider, entry] of ENTRY_CASES) {
      expect(Object.prototype.hasOwnProperty.call(entry, 'provider')).toBe(true);
      expect(entry.provider).toEqual(expect.any(String));
    }
  });

  it('gives every entry at least one adapter builder', () => {
    for (const [_provider, entry] of ENTRY_CASES) {
      expect(
        typeof entry.buildChatAdapter === 'function' ||
          typeof entry.buildEmbeddingsAdapter === 'function',
      ).toBe(true);
    }
  });
});

describe('LLM_PROVIDER_REGISTRY static import discipline', () => {
  it('keeps all adapter builders synchronous and directly returning values', () => {
    for (const entry of LLM_PROVIDER_REGISTRY) {
      if (entry.buildChatAdapter) {
        expect(entry.buildChatAdapter.constructor.name).not.toBe('AsyncFunction');
        expectNotPromise(entry.buildChatAdapter({}));
      }
      if (entry.buildEmbeddingsAdapter) {
        expect(entry.buildEmbeddingsAdapter.constructor.name).not.toBe('AsyncFunction');
        expectNotPromise(entry.buildEmbeddingsAdapter());
      }
    }
  });

  it('imports all four provider modules when the registry module is imported', async () => {
    vi.resetModules();

    const anthropicModuleLoaded = vi.fn();
    const openaiModuleLoaded = vi.fn();
    const openaiCompatibleModuleLoaded = vi.fn();
    const googleModuleLoaded = vi.fn();
    const anthropicEntry: LlmProviderEntry = { provider: 'anthropic' };
    const openaiEntry: LlmProviderEntry = { provider: 'openai' };
    const openaiCompatibleEntry: LlmProviderEntry = { provider: 'openai-compatible' };
    const googleEntry: LlmProviderEntry = { provider: 'google' };

    vi.doMock('../providers/anthropic.js', () => {
      anthropicModuleLoaded();
      return { anthropicProviderEntry: anthropicEntry };
    });
    vi.doMock('../providers/openai.js', () => {
      openaiModuleLoaded();
      return { openaiProviderEntry: openaiEntry };
    });
    vi.doMock('../providers/openai-compatible.js', () => {
      openaiCompatibleModuleLoaded();
      return { openaiCompatibleProviderEntry: openaiCompatibleEntry };
    });
    vi.doMock('../providers/google.js', () => {
      googleModuleLoaded();
      return { googleProviderEntry: googleEntry };
    });
    const mod = await import('../providers/registry.js');

    expect(anthropicModuleLoaded).toHaveBeenCalledTimes(1);
    expect(openaiModuleLoaded).toHaveBeenCalledTimes(1);
    expect(openaiCompatibleModuleLoaded).toHaveBeenCalledTimes(1);
    expect(googleModuleLoaded).toHaveBeenCalledTimes(1);
    expect(mod.LLM_PROVIDER_REGISTRY).toEqual([
      anthropicEntry,
      openaiEntry,
      openaiCompatibleEntry,
      googleEntry,
    ]);
  });
});

describe('LLM_PROVIDER_REGISTRY per-provider entries — chat surface', () => {
  it.each(CHAT_ENTRY_CASES)(
    '%s builds the expected chat adapter surface',
    (_provider, entry) => {
      const withoutDeps = entry.buildChatAdapter({});

      expect(withoutDeps?.provider).toBe(entry.provider);
    },
  );
});

describe('LLM_PROVIDER_REGISTRY per-provider entries — embeddings surface', () => {
  it('offers embeddings builders for real providers only', () => {
    expect(EMBEDDINGS_ENTRY_CASES.map(([provider]) => provider)).toEqual(REAL_PROVIDERS);
  });

  it.each(EMBEDDINGS_ENTRY_CASES)(
    '%s builds the expected embeddings adapter surface',
    (_provider, entry) => {
      const adapter = entry.buildEmbeddingsAdapter();

      expect(adapter.provider).toBe(entry.provider);
    },
  );
});

describe('createDefaultRegistry iterates the registry', () => {
  it('registers the four real providers', () => {
    const registry = createDefaultRegistry();

    for (const provider of REAL_PROVIDERS) {
      expect(registry(provider).provider).toBe(provider);
    }
  });
});

describe('createDefaultEmbeddingsRegistry iterates the registry', () => {
  it('registers embeddings for real providers', () => {
    const registry = createDefaultEmbeddingsRegistry();

    for (const provider of REAL_PROVIDERS) {
      expect(registry(provider).provider).toBe(provider);
    }
  });
});

describe('registry-authoritative validator boundary', () => {
  it('accepts every real registry provider at the config boundary', () => {
    for (const provider of REAL_PROVIDERS) {
      const out = parseLLMConfig(minimalSlotConfig(provider));

      expect(out.slot_1?.provider).toBe(provider);
    }
  });

  it('rejects web_chat as a user-configured provider with the canonical allow-list', () => {
    try {
      parseLLMConfig(minimalSlotConfig('web_chat'));
    } catch (e) {
      expect(e).toBeInstanceOf(LLMConfigValidationError);
      const err = e as LLMConfigValidationError;
      expect(err.field).toBe('slot_1.provider');
      expect(err.message).toBe(
        `slot_1.provider: must be one of ${PROVIDER_LIST_MSG} (got "web_chat")`,
      );
      for (const provider of REAL_PROVIDERS) {
        expect(err.message).toContain(provider);
      }
      return;
    }
    throw new Error('expected web_chat provider validation failure');
  });
});

describe('pluggability seam', () => {
  it('can append a synthetic provider entry and pick it up with the same loop', () => {
    const provider = 'cohere' as AdapterKey;
    const syntheticAdapter: LLMAdapter = {
      provider,
      complete: vi.fn(async () => ({
        text: 'ok',
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      })),
    };
    const buildChatAdapter = vi.fn(
      (_deps: ChatAdapterBuildDeps): LLMAdapter => syntheticAdapter,
    );
    const syntheticEntry = {
      provider,
      buildChatAdapter,
    } satisfies LlmProviderEntry;

    const registry = buildChatRegistryFromEntries(
      [...LLM_PROVIDER_REGISTRY, syntheticEntry],
      {},
    );

    expect(registry(provider)).toBe(syntheticAdapter);
    expect(buildChatAdapter).toHaveBeenCalledTimes(1);
  });
});

describe('behavioral parity check', () => {
  it('maps default chat registry entries to the same provider keys as direct builders', () => {
    const registry = createDefaultRegistry();

    for (const [provider, entry] of REAL_CHAT_ENTRY_CASES) {
      const direct = entry.buildChatAdapter({});
      const fromDefaultRegistry = registry(provider);

      expect(direct?.provider).toBe(provider);
      expect(fromDefaultRegistry.provider).toBe(direct?.provider);
    }
  });

  it('maps default embeddings registry entries to the same provider keys as direct builders', () => {
    const registry = createDefaultEmbeddingsRegistry();

    for (const [provider, entry] of REAL_EMBEDDINGS_ENTRY_CASES) {
      const direct = entry.buildEmbeddingsAdapter();
      const fromDefaultRegistry = registry(provider);

      expect(direct.provider).toBe(provider);
      expect(fromDefaultRegistry.provider).toBe(direct.provider);
    }
  });
});
