/** D-172 P5 / A.9 — voice→text transcription orchestrator.
 *
 *  The distinct (c) voice-only path (N.7): a voice note IS the user's
 *  utterance, so it is transcribed eagerly and the transcript becomes the
 *  turn's text. This module resolves an audio-capable source (the same
 *  modality machinery the multimodal chat path uses — `modalities.audio`),
 *  then dispatches to that provider's transcription adapter.
 *
 *  Wiring (messenger voice-only intake → transcribe → turn text) lives in
 *  the messenger channel (Lane A territory) and is deferred — this is the
 *  CAPABILITY the eventual one-line wiring calls. */

import type { AvailabilitySnapshot, CoordinationStrategy, LLMConfig } from './types.js';
import { LLMError } from './types.js';
import { buildAvailability } from './availability.js';
import { matchLLM } from './match.js';
import { resolveLLMTimeoutMs } from './timeout.js';
import type { QuotaTracker } from './quota.js';
import {
  defaultTranscriptionModel,
  type TranscriptionAdapterRegistry,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './adapters/transcription.js';
import type { WebChatTab } from '@recued/contracts';

export interface TranscribeDeps {
  config: LLMConfig;
  /** Transcription adapter registry (`createDefaultTranscriptionRegistry`). */
  adapters: TranscriptionAdapterRegistry;
  quota: QuotaTracker;
  tabProbe: () => Promise<Set<WebChatTab>>;
  webChatSupported?: boolean;
  preBuiltAvailability?: AvailabilitySnapshot;
  budgetStatus?: (slotKey: 'slot_1' | 'slot_2') => { over_cutoff: boolean } | null;
  strategy?: CoordinationStrategy;
  rng?: () => number;
  timeout_ms?: number;
}

/** Resolve an audio-capable source + transcribe.
 *
 *  Routing reuses `matchLLM` with `requireModalities: { audio: true }` so the
 *  free-before-BYOK ranking, availability + reject machinery all apply. The
 *  speed tier is irrelevant for transcription, so the request asks `fast`
 *  with `allowUpgrade` — the upgrade ladder (`fast → quality → thinking`)
 *  makes any audio-capable source at any tier eligible. No audio-capable
 *  source → `AI_MODALITY_UNSUPPORTED` (the N.8 warn), never a silent failure
 *  (I-6). */
export const transcribe = async (
  request: TranscriptionRequest,
  deps: TranscribeDeps,
): Promise<TranscriptionResult> => {
  const availability = deps.preBuiltAvailability ?? await buildAvailability({
    config: deps.config,
    quota: deps.quota,
    tabProbe: deps.tabProbe,
    budgetStatus: deps.budgetStatus,
    webChatSupported: deps.webChatSupported,
  });
  const strategy: CoordinationStrategy = deps.strategy ?? deps.config.free_pool_strategy ?? 'round_robin';

  // Cascade over audio-capable sources on a retryable failure (429 / 5xx /
  // auth), mirroring executeLLM: reject the failing source + cool it down +
  // rematch. A transient failure in the first source must not block the call
  // when another audio source could serve it.
  const rejectSet = new Set<string>();
  const MAX_WALKS = 3;
  let lastError: LLMError | null = null;

  for (let walk = 0; walk < MAX_WALKS; walk++) {
    let match;
    try {
      match = matchLLM(
        {
          requires: { speed: 'fast', output_format: 'text', allow_downgrade: false },
          allowUpgrade: true,
          requireModalities: { audio: true },
        },
        { config: deps.config, availability, quota: deps.quota, strategy, rejectSet, rng: deps.rng },
      );
    } catch (e) {
      // First walk, empty rejectSet → no audio-capable source at all → the
      // N.8 warn. Later walks → every audio source was rejected by the
      // cascade; surface the actual last adapter failure.
      if (e instanceof LLMError && e.code === 'AI_LLM_UNAVAILABLE') {
        if (rejectSet.size === 0) {
          throw new LLMError(
            'AI_MODALITY_UNSUPPORTED',
            'No audio-capable LLM is configured for transcription. Add an OpenAI/Groq/Gemini audio source.',
            { modality: 'audio' },
          );
        }
        throw lastError ?? e;
      }
      throw e;
    }

    // Model resolution: an explicit `transcription_model` wins; else the
    // provider default (OpenAI → whisper-1, Groq → whisper-large-v3); else
    // the chat `model` — correct for Gemini, whose `generateContent`
    // transcription path uses the chat model itself (A.9).
    const model = match.slot.transcription_model
      ?? defaultTranscriptionModel(match.adapterKey)
      ?? match.slot.model;

    const sourceId = match.source.kind === 'slot' ? match.source.slot_key : match.source.entry.id;
    deps.quota.registerRequest(sourceId);

    try {
      const adapter = deps.adapters(match.adapterKey);
      const result = await adapter.transcribe(match.slot, request, {
        model,
        timeout_ms: resolveLLMTimeoutMs(deps.timeout_ms),
      });
      deps.quota.advanceCursor(
        match.source.kind === 'slot' ? `byok:${match.resolved_hint}` : `free:${match.resolved_hint}`,
      );
      return result;
    } catch (e) {
      if (e instanceof LLMError && e.retryable) {
        rejectSet.add(sourceId);
        const retryAfterMs = typeof e.details?.retry_after_ms === 'number' ? e.details.retry_after_ms : undefined;
        deps.quota.markRateLimited(sourceId, retryAfterMs);
        lastError = e;
        continue;
      }
      throw e;
    }
  }

  throw lastError ?? new LLMError('AI_LLM_UNAVAILABLE', `Transcription cascade exhausted after ${MAX_WALKS} walks`, { walks: MAX_WALKS });
};
