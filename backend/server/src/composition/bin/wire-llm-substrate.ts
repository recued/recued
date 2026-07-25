/** D-070 / D-131 — LLM substrate composer.
 *
 *  Two composers in one file. Both consume the same `@recued/llm`
 *  surface (chat + embeddings) so colocating them keeps the LLM-related
 *  boot wiring in one place.
 *
 *  1. `composeLlmSubstrate` — module-level boot. Builds the long-lived
 *     handles that EVERY downstream LLM caller needs:
 *       - `llmManager` (per-DB encrypted config store, gated on `db`)
 *       - `llmConfig` (resolved env-default + db-stored merge; falls
 *         back to env on lock state)
 *       - `llmQuota` (shared `QuotaTracker` — recipe executor +
 *         housekeeping AI producers route through one instance so
 *         per-source cooldowns + free-pool round-robin state stay
 *         coherent across surfaces)
 *       - `llmAdapterRegistry` (chat-style `complete()` adapters —
 *         Anthropic / OpenAI / Google / Groq / OpenRouter / Cerebras /
 *         Gemini / Mistral / GitHub Models / `openai-compatible`)
 *       - `llmEmbeddingsAdapterRegistry` (D-131 A.2 — `embed()` adapter
 *         registry; separate from chat because the adapter-method shape
 *         differs but shares the same `LLMConfig` + `QuotaTracker`)
 *       - `emptyTabProbe` (server has no web-chat path; the closure
 *         returns an empty Set so the resolver short-circuits the
 *         web-chat branch). Exposed in the bundle so the same constant
 *         is reused everywhere the executor wires a tab probe.
 *
 *     Absent `db` → `llmManager` stays undefined and `llmConfig` keeps
 *     its env-resolved value. The substrate is otherwise complete; the
 *     dispatcher / closures that read `llmConfig` throw
 *     `AI_LLM_UNAVAILABLE` at use-site so misconfiguration surfaces
 *     cleanly rather than silently.
 *
 *  2. `composeHousekeepingLlmCallables` — inside-cmdServe. Builds the
 *     five `HousekeepingContext` LLM callables (`llm`, `llmWithMeta`,
 *     `resolveLLMModelId`, `embed`, `transcribe`) closed over a substrate bundle.
 *     Returned with field names matching `HousekeepingContext` so the
 *     caller spreads the bundle directly into the scheduler ctx.
 *
 *  `llmConfig` is the BOOT snapshot — the chat housekeeping closures
 *  capture the value (chat live-config threading is deferred). D-174 R28
 *  Slice C adds `resolveLlmConfig`, a per-use LIVE getter the EMBEDDINGS
 *  executor + probe call instead, so a saved embeddings slot applies
 *  without a restart. */

import type Database from 'better-sqlite3';
import {
  createDefaultRegistry as createLLMAdapterRegistry,
  createDefaultEmbeddingsRegistry,
  createQuotaTracker,
  createDefaultTranscriptionRegistry,
  executeLLM,
  executeEmbedding,
  resolveLLMModelId,
  transcribe as transcribeAudio,
  LLMError,
  type ForceLayer,
  type LLMConfig,
  type QuotaTracker,
  type TranscribeDeps,
} from '@recued/llm';
import type { WebChatTab } from '@recued/contracts';
import { createLLMConfigManager, type LLMConfigManager } from '../../llm-config.js';
import type { KeyManager } from '../../key-manager.js';
import type {
  HousekeepingEmbedExecute,
  HousekeepingLlmExecute,
  HousekeepingLlmExecuteWithMeta,
  HousekeepingResolveModelId,
  HousekeepingTranscribe,
} from '../../housekeeping/index.js';

export interface ComposeLlmSubstrateDeps {
  /** Server SQLite handle. Absent in dbless harnesses → `llmManager`
   *  stays undefined and `llmConfig` keeps its env-resolved value. */
  db: Database.Database | undefined;
  /** `KeyManager` for the 'server-data' sub-DEK that encrypts the
   *  config-store at rest. Absent / uninitialized → the manager runs
   *  in plaintext mode (legacy + fresh installs). */
  keys: KeyManager | undefined;
  /** Env-resolved `LLMConfig` (from `resolveLLMConfigFromEnv()`). Used
   *  as the seed config when no db is present + as the fallback when
   *  the db-stored config can't decrypt (locked encryption substrate). */
  envLlmConfig: LLMConfig | undefined;
}

export interface LlmSubstrate {
  llmManager: LLMConfigManager | undefined;
  llmConfig: LLMConfig | undefined;
  /** D-174 R28 Slice C — per-use LIVE config resolver (prefers the
   *  manager's SQLite read, falls back to the boot `llmConfig` when
   *  db-less / locked). The embeddings executor + probe call this so a
   *  saved embeddings slot applies without a restart. */
  resolveLlmConfig: () => LLMConfig | undefined;
  llmQuota: QuotaTracker;
  llmAdapterRegistry: ReturnType<typeof createLLMAdapterRegistry>;
  llmEmbeddingsAdapterRegistry: ReturnType<typeof createDefaultEmbeddingsRegistry>;
  emptyTabProbe: () => Promise<Set<WebChatTab>>;
}

export const composeLlmSubstrate = (deps: ComposeLlmSubstrateDeps): LlmSubstrate => {
  const { db, keys, envLlmConfig } = deps;

  const llmQuota: QuotaTracker = createQuotaTracker();
  const llmAdapterRegistry = createLLMAdapterRegistry();
  const llmEmbeddingsAdapterRegistry = createDefaultEmbeddingsRegistry();
  const emptyTabProbe = async (): Promise<Set<WebChatTab>> => new Set();

  let llmManager: LLMConfigManager | undefined;
  let llmConfig: LLMConfig | undefined = envLlmConfig;

  // With `keys` in scope, build the LLM config manager wired to the same
  // 'server-data' sub-DEK other storage surfaces use. When encryption is
  // uninitialized (fresh install, no bundle), getEncryptionKey returns
  // null and the manager falls back to plaintext — preserves existing
  // behavior.
  if (db) {
    const getKey = keys && keys.state() !== 'uninitialized'
      ? keys.keyProvider('server-data')
      : undefined;
    llmManager = createLLMConfigManager(db, { envConfig: envLlmConfig, getEncryptionKey: getKey });
    try {
      llmConfig = llmManager.getConfig();
    } catch {
      // Encrypted values but server still locked — leave llmConfig at
      // env default. Rpc callers will see empty config until unlock.
      llmConfig = envLlmConfig;
    }
  }

  // D-174 R28 Slice C — per-use LIVE config resolver. Mirrors the chat
  // store's `getLlmConfig` (compose-app-context): prefer the manager's live
  // SQLite read so a field-level slot edit (e.g. saving the embeddings slot)
  // takes effect WITHOUT a restart; fall back to the boot snapshot when the
  // manager is absent (db-less) or locked (getConfig throws). Only the
  // embeddings surface reads live here — the chat executor still reads the
  // boot `llmConfig` (deferred).
  const resolveLlmConfig = (): LLMConfig | undefined => {
    try {
      return llmManager?.getConfig() ?? llmConfig;
    } catch {
      return llmConfig;
    }
  };

  return {
    llmManager,
    llmConfig,
    resolveLlmConfig,
    llmQuota,
    llmAdapterRegistry,
    llmEmbeddingsAdapterRegistry,
    emptyTabProbe,
  };
};

export interface ComposeHousekeepingLlmCallablesDeps {
  substrate: LlmSubstrate;
}

export interface HousekeepingLlmCallables {
  llm: HousekeepingLlmExecute;
  llmWithMeta: HousekeepingLlmExecuteWithMeta;
  resolveLLMModelId: HousekeepingResolveModelId;
  embed: HousekeepingEmbedExecute;
  transcribe: HousekeepingTranscribe;
}

const configForTranscriptionForceLayer = (
  config: LLMConfig,
  forceLayer: ForceLayer | undefined,
): LLMConfig => {
  switch (forceLayer ?? 'any') {
    case 'byok': {
      const { free_pool: _freePool, ...rest } = config;
      return rest;
    }
    case 'free':
    {
      const { slot_1: _slot1, slot_2: _slot2, ...rest } = config;
      return rest;
    }
    case 'any':
      return config;
  }
};

export const composeHousekeepingLlmCallables = (
  deps: ComposeHousekeepingLlmCallablesDeps,
): HousekeepingLlmCallables => {
  const {
    llmConfig,
    resolveLlmConfig,
    llmQuota,
    llmAdapterRegistry,
    llmEmbeddingsAdapterRegistry,
    emptyTabProbe,
  } = deps.substrate;
  const llmTranscriptionAdapterRegistry = createDefaultTranscriptionRegistry();

  // Housekeeping `llm` callable — closes over the shared `llmConfig`
  // + `llmQuota` so AI-driven producers route through the same
  // adapters as recipe execution. Throws `LLMError('AI_LLM_UNAVAILABLE')`
  // when no slot / pool path resolves at call time; the cycle's
  // per-task error counter handles that the same way it handles any
  // other producer error. The pre-confirm probe in `getEnrichmentInfo`
  // is the primary UX gate; this throw is the race-window safety net.
  const llm: HousekeepingLlmExecute = async (manifest, input) => {
    if (!llmConfig) {
      throw new LLMError(
        'AI_LLM_UNAVAILABLE',
        'no LLM config configured',
        {},
      );
    }
    return executeLLM(manifest, input, {
      config: llmConfig,
      adapters: llmAdapterRegistry,
      quota: llmQuota,
      tabProbe: emptyTabProbe,
      webChatSupported: false,    });
  };

  // D-136 §A.3 / audit §20.2 — sibling that captures the resolved
  // provider model id off the executor's `onMatchResolved` callback.
  // The match winner carries `slot.provider + slot.model`; we compose
  // `'<provider>:<model>'` so cross-pool PSI invalidation (Groq free pool ↔
  // Anthropic BYOK) has a unique fingerprint per model.
  const llmWithMeta: HousekeepingLlmExecuteWithMeta = async (manifest, input) => {
    if (!llmConfig) {
      throw new LLMError(
        'AI_LLM_UNAVAILABLE',
        'no LLM config configured',
        {},
      );
    }
    let model_id = '';
    const result = await executeLLM(manifest, input, {
      config: llmConfig,
      adapters: llmAdapterRegistry,
      quota: llmQuota,
      tabProbe: emptyTabProbe,
      webChatSupported: false,      onMatchResolved: (evt) => {
        const winner = evt.winner;
        if (winner.source.kind === 'slot') {
          model_id = `${winner.slot.provider}:${winner.slot.model}`;
        } else if (winner.source.kind === 'pool') {
          model_id = `${winner.slot.provider}:${winner.slot.model}`;
        }
      },
    });
    return { result, model_id };
  };

  // D-136 P3 — pre-call probe for the resolved provider model id.
  // Producer wrappers fold the result into their dedup key BEFORE the
  // LLM call so cross-pool changes (free-pool ↔ BYOK) invalidate
  // cached rows authored by a different model. Returns empty string
  // when no LLM path is configured at all — wrapper falls back to the
  // static producer-version hash and the subsequent `executeLLM` call
  // throws AI_LLM_UNAVAILABLE if the call still can't resolve.
  const resolveLLMModelIdCallable: HousekeepingResolveModelId = async (manifest, input) => {
    if (!llmConfig) return '';
    return resolveLLMModelId(manifest, input, {
      config: llmConfig,
      quota: llmQuota,
      tabProbe: emptyTabProbe,
      webChatSupported: false,    });
  };

  // D-131 A.3 — embeddings sibling. Same shared `llmConfig` +
  // `llmQuota` (cooldowns cross-pollinate per the share-quota
  // decision) but a different adapter registry (`embed()` vs
  // `complete()`). Throws AI_LLM_UNAVAILABLE when no embeddings path
  // resolves — `probeEmbeddingsPathAvailability` is the primary UX
  // gate; this throw is the race-window safety net.
  const embed: HousekeepingEmbedExecute = async (manifest, input) => {
    // D-174 R28 Slice C — resolve config PER-USE so a freshly-saved
    // embeddings slot applies without a restart (the boot `llmConfig`
    // snapshot would be stale). The chat callables above keep the boot
    // snapshot (chat live-config threading is deferred).
    const config = resolveLlmConfig();
    if (!config) {
      throw new LLMError(
        'AI_LLM_UNAVAILABLE',
        'no LLM config configured',
        {},
      );
    }
    return executeEmbedding(manifest, input, {
      config,
      adapters: llmEmbeddingsAdapterRegistry,
      quota: llmQuota,
    });
  };

  // D-172 P6 — transcription is a distinct audio capability, not chat
  // content. The per-topic housekeeping pool policy still applies: the
  // harness threads `force_layer` through `ctx.transcribe`, and this wrapper
  // filters the captured config before calling the package-level transcriber
  // (which does not accept a forceLayer parameter directly).
  const transcribe: HousekeepingTranscribe = async (request, options) => {
    if (!llmConfig) {
      throw new LLMError(
        'AI_LLM_UNAVAILABLE',
        'no LLM config configured',
        {},
      );
    }
    return transcribeAudio(request, {
      config: configForTranscriptionForceLayer(llmConfig, options?.force_layer),
      adapters: llmTranscriptionAdapterRegistry,
      quota: llmQuota,
      tabProbe: emptyTabProbe,
      webChatSupported: false,
    } satisfies TranscribeDeps);
  };

  return {
    llm,
    llmWithMeta,
    resolveLLMModelId: resolveLLMModelIdCallable,
    embed,
    transcribe,
  };
};
