/** D-172 P5 / A.9 + D-262 § B1 — voice→text transcription.
 *
 *  ⛔ ONE DEDICATED SOURCE, NOT THE CHAT POOL. Until D-262 this resolved an
 *  audio-capable model through `matchLLM` over slot_1 / slot_2 / free_pool,
 *  which meant a voice turn could be answered by a different model than the one
 *  the owner pinned — falling back on the ANSWERING rather than on the HEARING.
 *  It now reads `config.transcription_slot` and nothing else, so the chat match
 *  resolver can never be reached from here and the pinned model is structurally
 *  safe. Same shape and same reasoning as `embeddings_slot` (D-174 R28 Slice C).
 *
 *  ⚠ The cascade retired with the pool. One source has nothing to walk to: a
 *  429 is surfaced, not routed around. `quota.registerRequest` stays, because
 *  rpm bookkeeping is still meaningful for a single source.
 *
 *  ⚠ METERED IN ITS OWN UNITS (§ B12.3). Requests and audio bytes are always
 *  exact and are always recorded; audio seconds are recorded only when the
 *  provider reports a duration. ⛔ None of it touches `tokens_today` —
 *  transcription does not return tokens, and converting one into the other
 *  would put a fabricated number where every reader assumes a measured one. */

import type { LLMConfig } from './types.js';
import { LLMError } from './types.js';
import { resolveLLMTimeoutMs } from './timeout.js';
import type { QuotaTracker } from './quota.js';
import type {
  TranscriptionAdapterRegistry,
  TranscriptionRequest,
  TranscriptionResult,
} from './adapters/transcription.js';

/** The source id `QuotaTracker` books transcription requests against. A
 *  constant, because there is exactly one transcription source. */
export const TRANSCRIPTION_SOURCE_ID = 'transcription_slot';

export interface TranscribeDeps {
  /** Read for `transcription_slot` + `transcription_language` only. */
  config: LLMConfig;
  /** Transcription adapter registry (`createDefaultTranscriptionRegistry`). */
  adapters: TranscriptionAdapterRegistry;
  quota: QuotaTracker;
  timeout_ms?: number;
  /** ⛔ D-262 § B4 — THE SIX ROUTING DEPS ARE GONE (2026-09-06). `tabProbe`,
   *  `webChatSupported`, `preBuiltAvailability`, `budgetStatus`, `strategy`
   *  and `rng` all served the `matchLLM` walk the dedicated slot replaced;
   *  they were unread from the moment slice 3 landed and were held one release
   *  only because two composition roots pass this literal with `satisfies`,
   *  which excess-property-checks. ⇒ The type now states exactly what
   *  `transcribe` reads, so a caller cannot supply routing inputs that would
   *  silently do nothing. Do not re-add one to "keep a caller compiling" —
   *  the caller is what wants fixing. */
}

/** Transcribe through the owner's configured transcription source.
 *
 *  ⛔ NO SOURCE IS A DISTINCT FAILURE FROM A SOURCE THAT CANNOT HEAR.
 *  `AI_NO_TRANSCRIPTION_SOURCE` means nothing is configured (send the person to
 *  Settings); `AI_MODALITY_UNSUPPORTED` comes from the adapter and means the
 *  configured provider has no transcription endpoint — Anthropic. Collapsing
 *  the two would send half of each group to the wrong place.
 *
 *  ⚠ The language pin comes from CONFIG, not from the caller, because it
 *  describes the OWNER rather than the call. An explicit `request.language`
 *  still wins, which is what lets the Settings probe drive a deliberate value.
 *  Absent at both levels means auto-detect, and nothing defaults it. */
export const transcribe = async (
  request: TranscriptionRequest,
  deps: TranscribeDeps,
): Promise<TranscriptionResult> => {
  const slot = deps.config.transcription_slot;
  if (!slot) {
    throw new LLMError(
      'AI_NO_TRANSCRIPTION_SOURCE',
      'No transcription source is configured. Set one in Settings → AI/Models.',
      { slot: 'transcription_slot' },
    );
  }

  // The slot's own `model` IS the transcription model — that is what the
  // dedicated slot means. No provider default is consulted: an owner who typed
  // `whisper-1` gets `whisper-1`, and a Gemini slot's chat model transcribes
  // itself through `generateContent`.
  const language = request.language ?? deps.config.transcription_language;

  // ⛔ THE CAP IS CHECKED BEFORE THE CALL, not after recording it — a budget
  // enforced only on the way out lets the call it was meant to prevent happen
  // first. Absent / non-positive is unlimited, matching `daily_budget_tokens`.
  const dailyCap = deps.config.transcription_daily_requests;
  if (dailyCap !== undefined && dailyCap > 0) {
    const used = deps.quota.transcriptionRequestsToday(TRANSCRIPTION_SOURCE_ID);
    if (used >= dailyCap) {
      throw new LLMError(
        'AI_TOKEN_BUDGET_EXCEEDED',
        `Transcription is over its daily limit (${String(used)}/${String(dailyCap)} calls). `
        + 'It resets at 00:00 UTC, or raise the limit in Settings → AI/Models.',
        { source: TRANSCRIPTION_SOURCE_ID, used, limit: dailyCap },
      );
    }
  }

  deps.quota.registerRequest(TRANSCRIPTION_SOURCE_ID);

  const adapter = deps.adapters(slot.provider);
  const result = await adapter.transcribe(
    slot,
    {
      ...request,
      // ⚠ Only set when non-empty. An empty string is a VALUE to the provider,
      // not an absence, and it is not the same request as auto-detect.
      ...(language !== undefined && language.length > 0 ? { language } : {}),
    },
    {
      model: slot.model,
      timeout_ms: resolveLLMTimeoutMs(deps.timeout_ms),
    },
  );

  // ⚠ Recorded AFTER the call succeeds, so a failed request does not consume
  // the owner's daily allowance — the same posture `recordUsage` takes for
  // chat. `bytes` is exact because we are holding the buffer; `duration_s`
  // rides along only when the provider volunteered one.
  deps.quota.recordTranscriptionUsage(TRANSCRIPTION_SOURCE_ID, {
    bytes: request.audio.length,
    ...(result.duration_s !== undefined ? { seconds: result.duration_s } : {}),
  });

  return result;
};
