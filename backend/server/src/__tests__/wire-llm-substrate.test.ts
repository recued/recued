import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LLMConfig } from '@recued/llm';
import { LLMError } from '@recued/llm';
import type { KeyManager } from '../key-manager.js';
import {
  composeHousekeepingLlmCallables,
  composeLlmSubstrate,
  type LlmSubstrate,
} from '../composition/bin/wire-llm-substrate.js';

const llmMocks = vi.hoisted(() => {
  class MockLLMError extends Error {
    code: string;
    meta: unknown;

    constructor(code: string, message: string, meta: unknown) {
      super(message);
      this.name = 'LLMError';
      this.code = code;
      this.meta = meta;
    }
  }

  return {
    createDefaultRegistry: vi.fn(),
    createDefaultEmbeddingsRegistry: vi.fn(),
    createDefaultTranscriptionRegistry: vi.fn(),
    createQuotaTracker: vi.fn(),
    executeLLM: vi.fn(),
    executeEmbedding: vi.fn(),
    resolveLLMModelId: vi.fn(),
    transcribe: vi.fn(),
    LLMError: MockLLMError,
  };
});

const llmConfigMocks = vi.hoisted(() => ({
  createLLMConfigManager: vi.fn(),
}));

vi.mock('@recued/llm', () => llmMocks);

vi.mock('../llm-config.js', () => llmConfigMocks);

type LlmManagerStub = {
  getConfig: ReturnType<typeof vi.fn>;
};

type ExecuteLLMOptions = {
  config: unknown;
  adapters: unknown;
  quota: unknown;
  tabProbe: unknown;
  webChatSupported: boolean;
  onMatchResolved?: (evt: {
    winner:
      | { source: { kind: 'slot' }; slot: { provider: string; model: string } }
      | { source: { kind: 'pool' }; slot: { provider: string; model: string } };
  }) => void;
};

const envConfig = { slot_1: { provider: 'openai', model: 'gpt-4.1-mini' } } as unknown as LLMConfig;
const managerConfig = { slot_1: { provider: 'anthropic', model: 'claude-3-5-sonnet' } } as unknown as LLMConfig;
const secondConfig = { slot_1: { provider: 'google', model: 'gemini-2.0-flash' } } as unknown as LLMConfig;

const quota = { kind: 'quota' };
const chatRegistry = { kind: 'chat-registry' };
const embeddingsRegistry = { kind: 'embeddings-registry' };
const transcriptionRegistry = { kind: 'transcription-registry' };
const llmResult = { text: 'llm-result' };
const embeddingResult = { vector: [0.1, 0.2], dimensions: 2, model: 'text-embedding-3-small' };
const transcriptionResult = { text: 'voice transcript', model_id: 'whisper-1' };
const resolvedModelId = 'openai:gpt-4.1-mini';
const manifest = { id: 'manifest' };
const input = { prompt: 'summarize' };
const transcribeRequest = {
  audio: new Uint8Array([1, 2, 3]),
  mime_type: 'audio/wav',
  filename: 'note.wav',
};
const emptyTabProbe = async () => new Set();

let managerStub: LlmManagerStub;

const makeDb = (): Database.Database => ({ name: 'db' }) as unknown as Database.Database;

const makeKeys = (state: 'uninitialized' | 'locked' | 'unlocked') => {
  const getKey = vi.fn(() => new Uint8Array([1, 2, 3]));
  const keyProvider = vi.fn(() => getKey);
  const keys = {
    state: vi.fn(() => state),
    keyProvider,
  } as unknown as KeyManager;

  return { keys, keyProvider, getKey };
};

const makeSubstrate = (overrides: Partial<LlmSubstrate> = {}): LlmSubstrate => {
  const base = {
    llmManager: undefined,
    llmConfig: envConfig,
    llmQuota: quota,
    llmAdapterRegistry: chatRegistry,
    llmEmbeddingsAdapterRegistry: embeddingsRegistry,
    emptyTabProbe,
    ...overrides,
  };
  return {
    ...base,
    // D-174 R28 Slice C — the per-use resolver defaults to returning the
    // (possibly overridden) boot llmConfig, so the embed closure picks up the
    // same config the assertions expect — unless a test overrides it to
    // exercise the live re-read path.
    resolveLlmConfig: overrides.resolveLlmConfig ?? (() => base.llmConfig),
  } as unknown as LlmSubstrate;
};

const composeWithDb = (overrides: {
  db?: Database.Database;
  keys?: KeyManager;
  envLlmConfig?: LLMConfig | undefined;
} = {}) => composeLlmSubstrate({
  db: overrides.db ?? makeDb(),
  keys: overrides.keys,
  envLlmConfig: 'envLlmConfig' in overrides ? overrides.envLlmConfig : envConfig,
});

beforeEach(() => {
  vi.clearAllMocks();

  managerStub = {
    getConfig: vi.fn(() => managerConfig),
  };

  llmMocks.createQuotaTracker.mockReturnValue(quota);
  llmMocks.createDefaultRegistry.mockReturnValue(chatRegistry);
  llmMocks.createDefaultEmbeddingsRegistry.mockReturnValue(embeddingsRegistry);
  llmMocks.createDefaultTranscriptionRegistry.mockReturnValue(transcriptionRegistry);
  llmMocks.executeLLM.mockResolvedValue(llmResult);
  llmMocks.executeEmbedding.mockResolvedValue(embeddingResult);
  llmMocks.resolveLLMModelId.mockResolvedValue(resolvedModelId);
  llmMocks.transcribe.mockResolvedValue(transcriptionResult);
  llmConfigMocks.createLLMConfigManager.mockReturnValue(managerStub);
});

describe('composeLlmSubstrate unconditional handles', () => {
  it('returns exactly the seven substrate fields', () => {
    const substrate = composeLlmSubstrate({ db: undefined, keys: undefined, envLlmConfig: envConfig });

    expect(Object.keys(substrate).sort()).toEqual([
      'emptyTabProbe',
      'llmAdapterRegistry',
      'llmConfig',
      'llmEmbeddingsAdapterRegistry',
      'llmManager',
      'llmQuota',
      'resolveLlmConfig',
    ].sort());
  });

  it('uses the quota tracker from createQuotaTracker', () => {
    const substrate = composeLlmSubstrate({ db: undefined, keys: undefined, envLlmConfig: envConfig });

    expect(llmMocks.createQuotaTracker).toHaveBeenCalledTimes(1);
    expect(substrate.llmQuota).toBe(quota);
  });

  it('uses the chat adapter registry from createDefaultRegistry', () => {
    const substrate = composeLlmSubstrate({ db: undefined, keys: undefined, envLlmConfig: envConfig });

    expect(llmMocks.createDefaultRegistry).toHaveBeenCalledTimes(1);
    expect(substrate.llmAdapterRegistry).toBe(chatRegistry);
  });

  it('uses the embeddings adapter registry from createDefaultEmbeddingsRegistry', () => {
    const substrate = composeLlmSubstrate({ db: undefined, keys: undefined, envLlmConfig: envConfig });

    expect(llmMocks.createDefaultEmbeddingsRegistry).toHaveBeenCalledTimes(1);
    expect(substrate.llmEmbeddingsAdapterRegistry).toBe(embeddingsRegistry);
  });

  it('builds an empty tab probe that resolves to an empty Set', async () => {
    const substrate = composeLlmSubstrate({ db: undefined, keys: undefined, envLlmConfig: envConfig });

    const tabs = await substrate.emptyTabProbe();
    expect(tabs).toBeInstanceOf(Set);
    expect(tabs.size).toBe(0);
  });
});

describe('composeLlmSubstrate dbless path', () => {
  it('leaves llmManager undefined when db is undefined', () => {
    const substrate = composeLlmSubstrate({ db: undefined, keys: undefined, envLlmConfig: envConfig });

    expect(substrate.llmManager).toBeUndefined();
  });

  it('keeps llmConfig equal to the passed env config, including undefined', () => {
    const configured = composeLlmSubstrate({ db: undefined, keys: undefined, envLlmConfig: envConfig });
    const unconfigured = composeLlmSubstrate({ db: undefined, keys: undefined, envLlmConfig: undefined });

    expect(configured.llmConfig).toBe(envConfig);
    expect(unconfigured.llmConfig).toBeUndefined();
  });

  it('does not construct an LLM config manager without db', () => {
    composeLlmSubstrate({ db: undefined, keys: undefined, envLlmConfig: envConfig });

    expect(llmConfigMocks.createLLMConfigManager).not.toHaveBeenCalled();
  });
});

describe('composeLlmSubstrate db-with-keys path', () => {
  it("asks unlocked keys for the 'server-data' provider once", () => {
    const { keys, keyProvider } = makeKeys('unlocked');

    composeWithDb({ keys });

    expect(keyProvider).toHaveBeenCalledTimes(1);
    expect(keyProvider).toHaveBeenCalledWith('server-data');
  });

  it("asks locked keys for the 'server-data' provider once", () => {
    const { keys, keyProvider } = makeKeys('locked');

    composeWithDb({ keys });

    expect(keyProvider).toHaveBeenCalledTimes(1);
    expect(keyProvider).toHaveBeenCalledWith('server-data');
  });

  it('does not ask uninitialized keys for a provider and passes undefined getEncryptionKey', () => {
    const { keys, keyProvider } = makeKeys('uninitialized');

    composeWithDb({ keys });

    expect(keyProvider).not.toHaveBeenCalled();
    const options = llmConfigMocks.createLLMConfigManager.mock.calls[0]?.[1];
    expect(options?.getEncryptionKey).toBeUndefined();
  });

  it('passes undefined getEncryptionKey when keys are absent', () => {
    composeWithDb({ keys: undefined });

    const options = llmConfigMocks.createLLMConfigManager.mock.calls[0]?.[1];
    expect(options?.getEncryptionKey).toBeUndefined();
  });

  it('calls createLLMConfigManager with db, env config, and selected key provider', () => {
    const db = makeDb();
    const { keys, getKey } = makeKeys('unlocked');

    composeWithDb({ db, keys, envLlmConfig: envConfig });

    expect(llmConfigMocks.createLLMConfigManager).toHaveBeenCalledTimes(1);
    expect(llmConfigMocks.createLLMConfigManager).toHaveBeenCalledWith(db, {
      envConfig,
      getEncryptionKey: getKey,
    });
  });

  it('returns the LLM manager produced by the mocked factory', () => {
    const substrate = composeWithDb();

    expect(substrate.llmManager).toBe(managerStub);
  });
});

describe('composeLlmSubstrate getConfig success and fallback', () => {
  it('uses the manager getConfig result instead of envLlmConfig on success', () => {
    managerStub.getConfig.mockReturnValue(secondConfig);

    const substrate = composeWithDb({ envLlmConfig: envConfig });

    expect(managerStub.getConfig).toHaveBeenCalledTimes(1);
    expect(substrate.llmConfig).toBe(secondConfig);
    expect(substrate.llmConfig).not.toBe(envConfig);
  });

  it('falls back to envLlmConfig when manager getConfig throws', () => {
    managerStub.getConfig.mockImplementation(() => {
      throw new Error('locked');
    });

    const substrate = composeWithDb({ envLlmConfig: envConfig });

    expect(substrate.llmConfig).toBe(envConfig);
  });

  it('does not rethrow manager getConfig failures', () => {
    managerStub.getConfig.mockImplementation(() => {
      throw new Error('decrypt failed');
    });

    expect(() => composeWithDb({ envLlmConfig: envConfig })).not.toThrow();
  });
});

describe('composeLlmSubstrate resolveLlmConfig (D-174 R28 Slice C per-use live resolver)', () => {
  it('re-reads the manager config live on EACH call (not a frozen boot snapshot)', () => {
    const substrate = composeWithDb();
    // Boot performed one getConfig read for the snapshot.
    expect(managerStub.getConfig).toHaveBeenCalledTimes(1);
    // Each resolveLlmConfig() is a fresh live read — so a slot saved after
    // boot is picked up without a restart.
    substrate.resolveLlmConfig();
    substrate.resolveLlmConfig();
    expect(managerStub.getConfig).toHaveBeenCalledTimes(3);
  });

  it('returns the live manager config value', () => {
    managerStub.getConfig.mockReturnValue(secondConfig);
    const substrate = composeWithDb();
    expect(substrate.resolveLlmConfig()).toBe(secondConfig);
  });

  it('falls back to the boot llmConfig when the live getConfig throws (locked vault)', () => {
    const substrate = composeWithDb({ envLlmConfig: envConfig });
    // Boot read succeeded (managerConfig); now the live read throws.
    managerStub.getConfig.mockImplementation(() => { throw new Error('locked'); });
    expect(substrate.resolveLlmConfig()).toBe(substrate.llmConfig);
  });

  it('returns envLlmConfig when there is no manager (db-less)', () => {
    const substrate = composeLlmSubstrate({ db: undefined, keys: undefined, envLlmConfig: envConfig });
    expect(substrate.resolveLlmConfig()).toBe(envConfig);
  });
});

describe('composeHousekeepingLlmCallables happy path', () => {
  it('returns exactly the five housekeeping callable fields', () => {
    const bundle = composeHousekeepingLlmCallables({ substrate: makeSubstrate() });

    expect(Object.keys(bundle).sort()).toEqual([
      'embed',
      'llm',
      'llmWithMeta',
      'resolveLLMModelId',
      'transcribe',
    ].sort());
  });

  it('llm invokes executeLLM with config, chat adapters, quota, tab probe, and webChatSupported=false', async () => {
    const substrate = makeSubstrate();
    const bundle = composeHousekeepingLlmCallables({ substrate });

    await bundle.llm(manifest as never, input as never);

    expect(llmMocks.executeLLM).toHaveBeenCalledTimes(1);
    expect(llmMocks.executeLLM).toHaveBeenCalledWith(manifest, input, {
      config: substrate.llmConfig,
      adapters: substrate.llmAdapterRegistry,
      quota: substrate.llmQuota,
      tabProbe: substrate.emptyTabProbe,
      webChatSupported: false,
    });
  });

  it('llm returns the executeLLM result', async () => {
    const bundle = composeHousekeepingLlmCallables({ substrate: makeSubstrate() });

    await expect(bundle.llm(manifest as never, input as never)).resolves.toBe(llmResult);
  });

  it('embed invokes executeEmbedding with config, embeddings adapters, and quota', async () => {
    const substrate = makeSubstrate();
    const bundle = composeHousekeepingLlmCallables({ substrate });

    await bundle.embed(manifest as never, input as never);

    expect(llmMocks.executeEmbedding).toHaveBeenCalledTimes(1);
    expect(llmMocks.executeEmbedding).toHaveBeenCalledWith(manifest, input, {
      config: substrate.llmConfig,
      adapters: substrate.llmEmbeddingsAdapterRegistry,
      quota: substrate.llmQuota,
    });
  });

  it('embed returns the executeEmbedding result', async () => {
    const bundle = composeHousekeepingLlmCallables({ substrate: makeSubstrate() });

    await expect(bundle.embed(manifest as never, input as never)).resolves.toBe(embeddingResult);
  });

  it('embed resolves config PER-USE via resolveLlmConfig (not the boot snapshot)', async () => {
    // D-174 R28 Slice C — the embed closure reads live config so a saved
    // embeddings slot applies without a restart.
    const liveConfig = {
      embeddings_slot: { provider: 'openai', model: 'text-embedding-3-small' },
    } as unknown as LLMConfig;
    const resolveLlmConfig = vi.fn(() => liveConfig);
    const substrate = makeSubstrate({ resolveLlmConfig } as Partial<LlmSubstrate>);
    const bundle = composeHousekeepingLlmCallables({ substrate });

    await bundle.embed(manifest as never, input as never);

    expect(resolveLlmConfig).toHaveBeenCalledTimes(1);
    expect(llmMocks.executeEmbedding).toHaveBeenCalledWith(manifest, input, {
      config: liveConfig,
      adapters: substrate.llmEmbeddingsAdapterRegistry,
      quota: substrate.llmQuota,
    });
  });

  it('transcribe invokes transcribe with config, transcription adapters, quota, tab probe, and webChatSupported=false', async () => {
    const substrate = makeSubstrate();
    const bundle = composeHousekeepingLlmCallables({ substrate });

    await bundle.transcribe(transcribeRequest);

    expect(llmMocks.transcribe).toHaveBeenCalledTimes(1);
    expect(llmMocks.transcribe).toHaveBeenCalledWith(transcribeRequest, {
      config: substrate.llmConfig,
      adapters: transcriptionRegistry,
      quota: substrate.llmQuota,
      tabProbe: substrate.emptyTabProbe,
      webChatSupported: false,
    });
  });

  it('transcribe honors housekeeping force_layer by filtering the captured config without touching packages/llm', async () => {
    const config = {
      slot_1: { provider: 'openai', model: 'gpt-4o-mini' },
      slot_2: { provider: 'google', model: 'gemini-2.0-flash' },
      free_pool: [{ id: 'free-audio', type: 'api', provider: 'openai-compatible', model: 'whisper', enabled: true }],
      free_pool_strategy: 'round_robin',
    } as unknown as LLMConfig;
    const substrate = makeSubstrate({ llmConfig: config });
    const bundle = composeHousekeepingLlmCallables({ substrate });

    await bundle.transcribe(transcribeRequest, { force_layer: 'free' });
    await bundle.transcribe(transcribeRequest, { force_layer: 'byok' });

    const freeConfig = llmMocks.transcribe.mock.calls[0]?.[1]?.config as Record<string, unknown>;
    expect(freeConfig.slot_1).toBeUndefined();
    expect(freeConfig.slot_2).toBeUndefined();
    expect(freeConfig.free_pool).toEqual(config.free_pool);

    const byokConfig = llmMocks.transcribe.mock.calls[1]?.[1]?.config as Record<string, unknown>;
    expect(byokConfig.slot_1).toBe(config.slot_1);
    expect(byokConfig.slot_2).toBe(config.slot_2);
    expect(byokConfig.free_pool).toBeUndefined();
  });

  it('transcribe returns the transcribe result', async () => {
    const bundle = composeHousekeepingLlmCallables({ substrate: makeSubstrate() });

    await expect(bundle.transcribe(transcribeRequest)).resolves.toBe(transcriptionResult);
  });

  it('resolveLLMModelId returns an empty string when llmConfig is undefined', async () => {
    const bundle = composeHousekeepingLlmCallables({
      substrate: makeSubstrate({ llmConfig: undefined }),
    });

    await expect(bundle.resolveLLMModelId(manifest as never, input as never)).resolves.toBe('');
    expect(llmMocks.resolveLLMModelId).not.toHaveBeenCalled();
  });

  it('resolveLLMModelId invokes the LLM resolver with config, quota, tab probe, and webChatSupported=false', async () => {
    const substrate = makeSubstrate();
    const bundle = composeHousekeepingLlmCallables({ substrate });

    await expect(bundle.resolveLLMModelId(manifest as never, input as never)).resolves.toBe(resolvedModelId);

    expect(llmMocks.resolveLLMModelId).toHaveBeenCalledTimes(1);
    expect(llmMocks.resolveLLMModelId).toHaveBeenCalledWith(manifest, input, {
      config: substrate.llmConfig,
      quota: substrate.llmQuota,
      tabProbe: substrate.emptyTabProbe,
      webChatSupported: false,
    });
  });

  it('llmWithMeta forwards the executeLLM result and exposes the unresolved default model_id', async () => {
    const bundle = composeHousekeepingLlmCallables({ substrate: makeSubstrate() });

    const result = await bundle.llmWithMeta(manifest as never, input as never);

    expect(result).toEqual({ result: llmResult, model_id: '' });
    expect(llmMocks.executeLLM).toHaveBeenCalledTimes(1);
    const options = llmMocks.executeLLM.mock.calls[0]?.[2] as ExecuteLLMOptions;
    expect(options.onMatchResolved).toEqual(expect.any(Function));
  });
});

describe('composeHousekeepingLlmCallables LLMError throws and model_id derivation', () => {
  it('llm throws AI_LLM_UNAVAILABLE when llmConfig is undefined', async () => {
    const bundle = composeHousekeepingLlmCallables({
      substrate: makeSubstrate({ llmConfig: undefined }),
    });

    await expect(bundle.llm(manifest as never, input as never)).rejects.toBeInstanceOf(LLMError);
    await expect(bundle.llm(manifest as never, input as never)).rejects.toMatchObject({
      code: 'AI_LLM_UNAVAILABLE',
      message: 'no LLM config configured',
      meta: {},
    });
    expect(llmMocks.executeLLM).not.toHaveBeenCalled();
  });

  it('llmWithMeta throws AI_LLM_UNAVAILABLE when llmConfig is undefined', async () => {
    const bundle = composeHousekeepingLlmCallables({
      substrate: makeSubstrate({ llmConfig: undefined }),
    });

    await expect(bundle.llmWithMeta(manifest as never, input as never)).rejects.toBeInstanceOf(LLMError);
    await expect(bundle.llmWithMeta(manifest as never, input as never)).rejects.toMatchObject({
      code: 'AI_LLM_UNAVAILABLE',
      message: 'no LLM config configured',
      meta: {},
    });
    expect(llmMocks.executeLLM).not.toHaveBeenCalled();
  });

  it('embed throws AI_LLM_UNAVAILABLE when llmConfig is undefined', async () => {
    const bundle = composeHousekeepingLlmCallables({
      substrate: makeSubstrate({ llmConfig: undefined }),
    });

    await expect(bundle.embed(manifest as never, input as never)).rejects.toBeInstanceOf(LLMError);
    await expect(bundle.embed(manifest as never, input as never)).rejects.toMatchObject({
      code: 'AI_LLM_UNAVAILABLE',
      message: 'no LLM config configured',
      meta: {},
    });
    expect(llmMocks.executeEmbedding).not.toHaveBeenCalled();
  });

  it('transcribe throws AI_LLM_UNAVAILABLE when llmConfig is undefined', async () => {
    const bundle = composeHousekeepingLlmCallables({
      substrate: makeSubstrate({ llmConfig: undefined }),
    });

    await expect(bundle.transcribe(transcribeRequest)).rejects.toBeInstanceOf(LLMError);
    await expect(bundle.transcribe(transcribeRequest)).rejects.toMatchObject({
      code: 'AI_LLM_UNAVAILABLE',
      message: 'no LLM config configured',
      meta: {},
    });
    expect(llmMocks.transcribe).not.toHaveBeenCalled();
  });

  it('llmWithMeta derives model_id from a slot-source winner', async () => {
    llmMocks.executeLLM.mockImplementation(async (_manifest, _input, options: ExecuteLLMOptions) => {
      options.onMatchResolved?.({
        winner: {
          source: { kind: 'slot' },
          slot: { provider: 'openai', model: 'gpt-4.1' },
        },
      });
      return llmResult;
    });
    const bundle = composeHousekeepingLlmCallables({ substrate: makeSubstrate() });

    await expect(bundle.llmWithMeta(manifest as never, input as never)).resolves.toEqual({
      result: llmResult,
      model_id: 'openai:gpt-4.1',
    });
  });

  it('llmWithMeta derives model_id from a pool-source winner using provider:model', async () => {
    llmMocks.executeLLM.mockImplementation(async (_manifest, _input, options: ExecuteLLMOptions) => {
      options.onMatchResolved?.({
        winner: {
          source: { kind: 'pool' },
          slot: { provider: 'groq', model: 'llama-3.3-70b' },
        },
      });
      return llmResult;
    });
    const bundle = composeHousekeepingLlmCallables({ substrate: makeSubstrate() });

    await expect(bundle.llmWithMeta(manifest as never, input as never)).resolves.toEqual({
      result: llmResult,
      model_id: 'groq:llama-3.3-70b',
    });
  });

});
