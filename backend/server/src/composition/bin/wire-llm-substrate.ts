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
 *         Gemini / Mistral / `openai-compatible`; GitHub Models was retired
 *         by GitHub 2026-07-30 and is no longer reachable)
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
 *     four `HousekeepingContext` LLM callables (`llm`, `llmWithMeta`,
 *     `embed`, `transcribe`) closed over a substrate bundle.
 *     Returned with field names matching `HousekeepingContext` so the
 *     caller spreads the bundle directly into the scheduler ctx.
 *
 *  `llmConfig` is the BOOT snapshot — the chat housekeeping closures
 *  capture the value (chat live-config threading is deferred). D-174 R28
 *  Slice C adds `resolveLlmConfig`, a per-use LIVE getter the EMBEDDINGS
 *  executor + probe call instead, so a saved embeddings slot applies
 *  without a restart. */

import {
  probeAiPathAvailability,
  type AiPathAvailability,
} from '../../housekeeping/ai-availability.js';
import type Database from 'better-sqlite3';
import {
  type TokenUsage,
  createDefaultRegistry as createLLMAdapterRegistry,
  endpointFingerprint,
  hydrateEndpointCapabilities,
  onEndpointCapabilityLearned,
  createDefaultEmbeddingsRegistry,
  createQuotaTracker,
  createDefaultTranscriptionRegistry,
  executeLLM,
  executeEmbedding,
  transcribe as transcribeAudio,
  LLMError,
  type ForceLayer,
  type LLMConfig,
  type LLMSlot,
  type QuotaTracker,
  type TranscribeDeps,
} from '@recued/llm';
import type { WebChatTab } from '@recued/contracts';
import { createLLMConfigManager, type LLMConfigManager } from '../../llm-config.js';
import { tokenUsageToReport } from '../../chat-token-usage.js';
import {
  createHousekeepingTaskTokenMeter,
  type HousekeepingTaskTokenMeter,
} from '../../housekeeping/task-token-meter.js';
import type { KeyManager } from '../../key-manager.js';
import type {
  HousekeepingEmbedExecute,
  HousekeepingLlmExecute,
  HousekeepingLlmExecuteWithMeta,
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
  /** D-262 § B7 — the `transcribe()` adapter registry, hoisted onto the
   *  substrate so the Settings probe reaches the SAME registry the housekeeping
   *  and chat paths call. Two registries would test one and run the other. */
  llmTranscriptionAdapterRegistry: ReturnType<typeof createDefaultTranscriptionRegistry>;
  emptyTabProbe: () => Promise<Set<WebChatTab>>;
}

export const composeLlmSubstrate = (deps: ComposeLlmSubstrateDeps): LlmSubstrate => {
  const { db, keys, envLlmConfig } = deps;

  const llmAdapterRegistry = createLLMAdapterRegistry();
  const llmEmbeddingsAdapterRegistry = createDefaultEmbeddingsRegistry();
  const llmTranscriptionAdapterRegistry = createDefaultTranscriptionRegistry();
  const emptyTabProbe = async (): Promise<Set<WebChatTab>> => new Set();

  let llmManager: LLMConfigManager | undefined;
  let llmConfig: LLMConfig | undefined = envLlmConfig;

  // With `keys` in scope, build the LLM config manager wired to the same
  // 'server-data' sub-DEK other storage surfaces use — whenever a key
  // manager exists. ⛔ Never gated on its state here: a new server composes
  // 'uninitialized' and its first pairing unlocks the vault in-process, so
  // a gate wrote that session's API keys as plaintext. Until the vault is
  // unlocked the closure returns null and a secret write throws; a plaintext
  // value already stored still reads.
  if (db) {
    const getKey = keys ? keys.keyProvider('server-data') : undefined;
    llmManager = createLLMConfigManager(db, { envConfig: envLlmConfig, getEncryptionKey: getKey });
    // D-262 § B5 — the one-time upgrade step, before the first config read so
    // this boot already sees a derived slot. ⚠ Best-effort: a locked or
    // read-only store must not stop the server booting, and the marker means a
    // failed attempt simply retries on the next boot rather than half-applying.
    try {
      llmManager.deriveTranscriptionSlotOnce();
    } catch {
      /* never block boot on a migration; the marker keeps it retryable */
    }
    try {
      llmConfig = llmManager.getConfig();
    } catch {
      // Encrypted values but server still locked — leave llmConfig at
      // env default. Rpc callers will see empty config until unlock.
      llmConfig = envLlmConfig;
    }
  }

  // D-262 follow-on — the quota tracker, built AFTER the config manager so it
  // can be hydrated from the persisted snapshot and write back through it.
  //
  // ⛔ EVERY PER-SOURCE BUDGET USED TO RESET ON RESTART. `statusFor` compares a
  // pool entry's `daily_cap_tokens`, `slotOverCutoff` compares a slot's
  // `daily_budget_tokens`, and the embeddings and transcription caps read the
  // same counters — all of them in memory, seeded empty, with `snapshot()`
  // called by nobody. A self-hoster restarts on every update, so a daily cap
  // was clearable by turning it off and on again. That is not a cap.
  //
  // ⚠ WRITE-THROUGH ON EVERY CHANGE, deliberately. LLM calls arrive seconds
  // apart, so a debounce would buy nothing measurable and would lose the last
  // window on a crash — which is exactly when the counters matter. If it ever
  // does become hot, the cadence lives here, not in `packages/llm`.
  const llmQuota: QuotaTracker = createQuotaTracker(
    (llmManager?.getQuotaSnapshot() ?? undefined) as Parameters<typeof createQuotaTracker>[0],
    llmManager
      ? {
          onChange: (snapshot) => {
            // Best-effort: a locked or read-only store degrades to the old
            // reset-on-restart behaviour rather than throwing into a chat turn.
            try { llmManager?.setQuotaSnapshot(snapshot); } catch { /* degrade */ }
          },
        }
      : {},
  );

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

  // ── D-208 follow-on — durable endpoint capabilities ────────────────
  //
  // What a previous process learned about each endpoint (no `system` role, no
  // `response_format`) is stored ON THE SOURCE — `slot.system_role_ok`,
  // `entry.native_json_ok` — so the first call after a restart does not re-pay
  // a rejection the server already knows about.
  //
  // 🔑 IT USED TO BE A SIDE BLOB keyed by a content fingerprint
  // (provider+base_url+model), on the reasoning that the fingerprint
  // auto-invalidates when any of those change. But a SOURCE EDIT is exactly
  // that moment and the save path already runs then, so the whole
  // content-addressing layer — plus its pruning, its orphan rows, and its
  // resurrect-on-restart failure mode — was buying something the write path
  // already knew. Storing on the source deletes all of it: a removed source
  // takes its observations with it.
  //
  // ⛔ These fields are inert to routing. `match.ts` gates on `supports_json`;
  // a capability that only changes how a prompt is PACKED must never be able to
  // make a source unroutable.
  if (llmManager) {
    const manager = llmManager;
    // Pure: the caller decides WHICH config to read against. Boot passes the
    // snapshot it already has (no second read); the learn-listener passes the
    // live one, so a source configured after boot is still findable.
    const sources = (config: LLMConfig | undefined): Array<{
      slot: LLMSlot;
      source: Parameters<typeof manager.setSourceCapability>[0];
    }> => {
      if (!config) return [];
      const out: Array<{ slot: LLMSlot; source: Parameters<typeof manager.setSourceCapability>[0] }> = [];
      // ⛔ D-262 § B1 — `transcription_slot` is DELIBERATELY ABSENT from this
      // walk, not forgotten. This drives endpoint-capability detection
      // (`system_role_ok` / `native_json_ok`), which are questions about a CHAT
      // completion. Asking them of a Whisper endpoint would probe a surface it
      // does not have and record the 404 as a capability fact.
      for (const slot_key of ['slot_1', 'slot_2', 'embeddings_slot'] as const) {
        const slot = config[slot_key];
        if (slot) out.push({ slot, source: { kind: 'slot', slot_key } });
      }
      for (const entry of config.free_pool ?? []) {
        out.push({
          slot: {
            provider: entry.provider,
            model: entry.model,
            api_key: entry.api_key,
            ...(entry.base_url !== undefined ? { base_url: entry.base_url } : {}),
            ...(entry.system_role_ok !== undefined
              ? { system_role_ok: entry.system_role_ok } : {}),
            ...(entry.native_json_ok !== undefined
              ? { native_json_ok: entry.native_json_ok } : {}),
            ...(entry.image_input_ok === true ? { image_input_ok: true } : {}),
          },
          source: { kind: 'pool', entry_id: entry.id },
        });
      }
      return out;
    };

    hydrateEndpointCapabilities(sources(llmConfig).map(({ slot }) => ({
      fingerprint: endpointFingerprint(slot),
      ...(slot.system_role_ok === false ? { system_role_unsupported: true } : {}),
      ...(slot.native_json_ok === false ? { json_mode_unsupported: true } : {}),
      ...(slot.image_input_ok === true ? { image_input_seen: true } : {}),
    })));

    onEndpointCapabilityLearned((note) => {
      try {
        // The in-memory cache is keyed by endpoint so two sources on the same
        // model share one answer; storage is keyed by SOURCE so it invalidates
        // with the source. This is the one place the two meet.
        for (const { slot, source } of sources(resolveLlmConfig())) {
          if (endpointFingerprint(slot) !== note.fingerprint) continue;
          manager.setSourceCapability(source, {
            system_role_ok: note.system_role_unsupported !== true,
            native_json_ok: note.json_mode_unsupported !== true,
            // ⛔ Only a picture check's own announcement carries this, and only
            // that may move the stored proof (`EndpointCapabilityNote
            // .image_input_seen`): every other announcement leaves it alone.
            ...(note.image_input_seen !== undefined
              ? { image_input_ok: note.image_input_seen }
              : {}),
          });
        }
      } catch {
        // A failed capability WRITE must never fail the call that discovered
        // it — the call already succeeded, and this is a latency cache.
      }
    });
  }

  return {
    llmManager,
    llmConfig,
    resolveLlmConfig,
    llmQuota,
    llmAdapterRegistry,
    llmEmbeddingsAdapterRegistry,
    llmTranscriptionAdapterRegistry,
    emptyTabProbe,
  };
};

export interface ComposeHousekeepingLlmCallablesDeps {
  substrate: LlmSubstrate;
}

export interface HousekeepingLlmCallables {
  /** D-250 § D — per-task provider spend for the cycle audit row. Rides the
   *  callables bundle because it is spread onto the housekeeping ctx, which is
   *  the one place the scheduler and these callables both reach. */
  taskTokenMeter: HousekeepingTaskTokenMeter;
  llm: HousekeepingLlmExecute;
  llmWithMeta: HousekeepingLlmExecuteWithMeta;
  embed: HousekeepingEmbedExecute;
  transcribe: HousekeepingTranscribe;
  /** D-262 follow-on — "is any AI path usable right now", for the scheduler's
   *  idle-cycle gate. Rides this bundle for the same reason `taskTokenMeter`
   *  does: it is the one place the scheduler and these callables both reach.
   *
   *  ⛔ AND IT MUST BE BUILT HERE, beside the executors, because it has to read
   *  the SAME config they do. A gate resolving live config while its executor
   *  read a boot snapshot would admit work the executor cannot serve, or refuse
   *  work it could — and neither failure names itself. Threading `(config,
   *  quota)` out to the composer instead would let those two drift apart in a
   *  file that has no other reason to know about either. */
  probeAiPath: () => Promise<AiPathAvailability>;
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
    // D-250 § D — the owner's daily token counter; see `reportOwnerUsage`.
    llmManager,
    llmTranscriptionAdapterRegistry,
  } = deps.substrate;

  // Housekeeping `llm` callable — closes over the shared `llmConfig`
  // + `llmQuota` so AI-driven producers route through the same
  // adapters as recipe execution. Throws `LLMError('AI_LLM_UNAVAILABLE')`
  // when no slot / pool path resolves at call time; the cycle's
  // per-task error counter handles that the same way it handles any
  // other producer error. The pre-confirm probe in `getEnrichmentInfo`
  // is the primary UX gate; this throw is the race-window safety net.
  /** D-250 § D — housekeeping AI spend reaches the owner's daily counter.
   *
   *  ⛔ IT REACHED NOTHING BEFORE. All four callables below omitted
   *  `onTokenUsage`, so every token an enrichment producer, a model-id probe or
   *  a transcription burned was discarded — and
   *  `housekeeping_state.tokens_consumed_today_*`, which looks like the
   *  backstop, is `estimate_per_record_tokens()` x pending rows: a BUDGET
   *  ESTIMATE the planner uses to decide whether to start a cycle, never a
   *  measurement. So the one execution mode designed to run unattended was also
   *  the one whose real cost nothing recorded.
   *
   *  ⚠ THE COUNTER, NOT AN AUDIT ROW, AND THAT IS THE HONEST HALF-STEP. This
   *  makes housekeeping spend visible in the owner's daily total and countable
   *  against their budget — where an owner's own provider spend belongs. It
   *  does NOT give housekeeping per-task attribution; the `housekeeping_cycle`
   *  audit row already carries `per_task` and is the right home for that, and
   *  it is not wired here. */
  const taskTokenMeter = createHousekeepingTaskTokenMeter();
  const reportOwnerUsage = (usage: TokenUsage): void => {
    llmManager?.addUsage(usage.total_tokens);
    // D-250 § D — the same provider result, attributed to the task in flight so
    // the `housekeeping_cycle` audit row can carry it. The counter above is the
    // owner's BUDGET; this is the RECORD. Different jobs, both fed here.
    taskTokenMeter.record(tokenUsageToReport(usage));
  };

    // ⛔ D-262 follow-on — LIVE, not the boot snapshot. This was deferred when
    // the embeddings surface moved (D-174 R28 Slice C) and again when
    // transcription did; it is closed here because the IDLE-CYCLE GATE now
    // consults `probeAiPathAvailability`, and a gate that reads live config
    // while its executor reads a boot snapshot disagrees with itself — the gate
    // would admit work the executor cannot serve, or refuse work it could.
    // ⚠ `resolveLlmConfig` falls back to the boot value when the manager is
    // absent or locked, so a db-less runtime behaves exactly as before.
  const llm: HousekeepingLlmExecute = async (manifest, input) => {
    const liveConfig = resolveLlmConfig();
    if (!liveConfig) {
      throw new LLMError(
        'AI_LLM_UNAVAILABLE',
        'no LLM config configured',
        {},
      );
    }
    return executeLLM(manifest, input, {
      config: liveConfig,
      adapters: llmAdapterRegistry,
      quota: llmQuota,
      tabProbe: emptyTabProbe,
      webChatSupported: false,
      onTokenUsage: reportOwnerUsage,
    });
  };

  // D-136 §A.3 / audit §20.2 — sibling that captures the resolved
  // provider model id off the executor's `onMatchResolved` callback.
  // The match winner carries `slot.provider + slot.model`; we compose
  // `'<provider>:<model>'` so cross-pool PSI invalidation (Groq free pool ↔
  // Anthropic BYOK) has a unique fingerprint per model.
  const llmWithMeta: HousekeepingLlmExecuteWithMeta = async (manifest, input) => {
    const liveConfig = resolveLlmConfig();
    if (!liveConfig) {
      throw new LLMError(
        'AI_LLM_UNAVAILABLE',
        'no LLM config configured',
        {},
      );
    }
    let model_id = '';
    const result = await executeLLM(manifest, input, {
      config: liveConfig,
      adapters: llmAdapterRegistry,
      quota: llmQuota,
      tabProbe: emptyTabProbe,
      webChatSupported: false,
      onTokenUsage: reportOwnerUsage,
      onMatchResolved: (evt) => {
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
      // D-250 § D — embeddings are billed tokens like any completion, and this
      // is the highest-VOLUME housekeeping path (one call per record indexed).
      // ⚠ Found by the reporting ratchet, not by reading: a by-file grep for
      // `executeLLM` missed every `executeEmbedding` site.
      onTokenUsage: reportOwnerUsage,
    });
  };

  // D-172 P6 — transcription is a distinct audio capability, not chat
  // content. The per-topic housekeeping pool policy still applies: the
  // harness threads `force_layer` through `ctx.transcribe`, and this wrapper
  // filters the captured config before calling the package-level transcriber
  // (which does not accept a forceLayer parameter directly).
  const transcribe: HousekeepingTranscribe = async (request, options) => {
    // ⛔ D-262 — LIVE, not the boot snapshot. `transcription_slot` is edited in
    // Settings and its whole point is being the owner's choice; reading the
    // captured `llmConfig` meant clearing the slot, rotating the key, changing
    // the language or lowering the cap had NO EFFECT on background
    // transcription until a restart — including a call succeeding against a
    // slot the owner had just deleted. The chat path already resolves per call
    // (`get config()` in wire-chat-orchestrator) and the embeddings surface
    // uses this same resolver; transcription was the one that did not.
    const live = resolveLlmConfig();
    if (!live) {
      throw new LLMError(
        'AI_LLM_UNAVAILABLE',
        'no LLM config configured',
        {},
      );
    }
    return transcribeAudio(request, {
      config: configForTranscriptionForceLayer(live, options?.force_layer),
      adapters: llmTranscriptionAdapterRegistry,
      quota: llmQuota,
    } satisfies TranscribeDeps);
  };

  return {
    taskTokenMeter,
    probeAiPath: () => probeAiPathAvailability(resolveLlmConfig(), llmQuota),
    llm,
    llmWithMeta,
    embed,
    transcribe,
  };
};
