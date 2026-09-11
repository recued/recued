/** Test connection — one real call against a configured source, reported back
 *  in terms the owner can act on.
 *
 *  ── The gap it closes ──────────────────────────────────────────────
 *  `server.setLLMSlot` is parse-and-persist: it makes no network call, and
 *  nothing else in the save path does either. So a wrong API key, a model id
 *  that does not exist, or a `base_url` with a typo is accepted silently and
 *  surfaces hours later as a failed recipe, attributed to whatever ran at the
 *  time. This is the affordance that asks the endpoint instead of guessing.
 *
 *  ── Why it goes through the adapter ────────────────────────────────
 *  Each provider wants a different request (Anthropic takes `system`
 *  separately and requires `max_tokens`; Google uses `system_instruction` +
 *  `contents`). Probing over raw HTTP would be a FOURTH implementation of the
 *  request builder, free to drift from the three that serve real traffic — and
 *  a probe that drifts reports on a request nobody makes. Going through
 *  `completeWithFallbacks` means the probe exercises the exact path a real call
 *  takes, which is also the only way it can answer the capability questions
 *  truthfully.
 *
 *  🔑 THE CAPABILITY ANSWERS ARE READ BACK, NOT RE-DETECTED. A single request
 *  that sets both a system role and `response_format` cannot tell you WHICH one
 *  a 400 was about. The isolation logic for that already exists in
 *  `completeWithFallbacks`; the probe runs one call through it and then asks
 *  `endpoint-capabilities` what it learned. A second detector here would be a
 *  copy of two regexes, free to disagree with the ones serving real traffic. */

import {
  forgetEndpoint,
  jsonModeUnsupported,
  systemRoleUnsupported,
} from './endpoint-capabilities.js';
import { completeWithFallbacks } from './executor.js';
import type { EmbeddingsAdapterRegistry } from './embeddings/types.js';
import type { TranscriptionAdapterRegistry } from './adapters/transcription.js';
import type { LLMAdapter, LLMSlot } from './types.js';
import { LLMError } from './types.js';

/** What went wrong, in the owner's terms rather than the provider's.
 *
 *  `unreachable` and `auth` are deliberately separate even though both mean
 *  "no answer": one is a network/URL problem and the other is a credential
 *  problem, and the fix is in a different field of the form. */
export type LlmProbeDiagnosis =
  | 'ok'
  | 'auth'
  | 'unreachable'
  | 'model_missing'
  | 'rate_limited'
  | 'provider_error'
  | 'rejected'
  /** D-262 § B7 — a transcription probe ran with no sample clip bundled, so
   *  nothing was sent. ⛔ NOT a failure of the owner's configuration, and
   *  deliberately not `ok`: reporting success for a request that never left the
   *  process is how a "verified" badge starts lying. */
  | 'no_sample';

export interface LlmProbeResult {
  ok: boolean;
  diagnosis: LlmProbeDiagnosis;
  /** The provider's own words, already truncated by `classifyProviderError`.
   *  Shown under the verdict — an owner debugging a self-hosted endpoint needs
   *  the raw text, and paraphrasing it hides the one detail that identifies the
   *  problem. */
  detail?: string;
  /** Only meaningful when `ok`. A failed probe learns nothing about
   *  capabilities, and reporting a default as though it were observed is how a
   *  "verified" badge starts lying. */
  accepts_system_role?: boolean;
  supports_json?: boolean;
  /** Embeddings only, and only on success — the vector width the endpoint
   *  actually returned. The analogue of the chat capability facts: a model
   *  quietly serving 768-d where the owner expected 1536-d is a working
   *  connection that produces unusable neighbours. */
  dimensions?: number;
  /** D-262 § B7 — transcription only, and only on success: what the endpoint
   *  actually heard. Shown rather than asserted, because it is the one signal
   *  that reveals a `transcription_language` set to something the owner did not
   *  mean — which returns fluent nonsense, not an error. */
  transcript?: string;
  /** D-262 § B7 — what the bundled clip says, echoed so the surface can show
   *  it beside `transcript`. A wrong-language transcript is fluent nonsense the
   *  owner may not read; the pair is what makes the mismatch visible. */
  expected_transcript?: string;
  /** D-262 § B7 — the language pin actually sent. Absent ⇒ auto-detect. */
  probe_language?: string;
  /** Round-trip in ms, including any capability retry. Useful on its own — a
   *  local model answering in 40s is a working configuration that will still
   *  make chat feel broken. */
  elapsed_ms: number;
}

/** ⚠ A probe MUST be time-boxed even though a real call is not.
 *  `LLMCompletionOptions.timeout_ms` defaults to `null` — unbounded, on purpose,
 *  because a real call is compute the owner has already paid for. Behind a
 *  button that reasoning inverts: an unbounded probe is a spinner with no end
 *  and no cancel, and "my endpoint is wedged" is exactly the case this feature
 *  exists to report. */
export const LLM_PROBE_TIMEOUT_MS = 20_000;

/** Small enough to be free, large enough to be a real completion. `max_tokens`
 *  of 1 is deliberate: the probe is asking whether the endpoint ANSWERS, not
 *  what it says, and a one-token cap keeps a mistyped model that happens to
 *  exist from generating a paragraph on the owner's key. */
const PROBE_PROMPT = 'Reply with the single word: ok';

const statusOf = (e: LLMError): number | undefined =>
  typeof e.details?.status === 'number' ? e.details.status : undefined;

/** Map a failure onto the field of the form the owner should look at.
 *
 *  ⚠ Reads `details.status`, never the message text. The message is truncated
 *  at 200 chars by `classifyProviderError`, so a status parsed out of it is
 *  lossy — and a provider that prefixes its body with a long preamble would
 *  push the code out of range and silently land in the wrong bucket. */
export const diagnoseProbeFailure = (e: unknown): {
  diagnosis: LlmProbeDiagnosis;
  detail: string;
} => {
  if (!(e instanceof LLMError)) {
    return {
      diagnosis: 'unreachable',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  if (e.code === 'AI_TIMEOUT') {
    return { diagnosis: 'unreachable', detail: e.message };
  }
  const status = statusOf(e);
  if (status === 401 || status === 403) {
    return { diagnosis: 'auth', detail: e.message };
  }
  if (status === 429) return { diagnosis: 'rate_limited', detail: e.message };
  if (status === 404) return { diagnosis: 'model_missing', detail: e.message };
  if (status !== undefined && status >= 500) {
    return { diagnosis: 'provider_error', detail: e.message };
  }
  // A 400 naming the model is the common "model id does not exist" shape on
  // endpoints that do not use 404 for it (several openai-compatible servers).
  //
  // ⚠ The bounded `[^.]{0,40}?` gap is load-bearing: the real message carries
  // the model ID BETWEEN the word and the verdict — "model 'llama-9' does not
  // exist" — so a pattern demanding they be adjacent matches none of the
  // strings it was written for. Bounded rather than greedy so it cannot reach
  // across a sentence and pair "model" with an unrelated later clause.
  if (
    status === 400
    && /model[_ -]?not[_ -]?found|(?:unknown|invalid|unsupported)[_ -]model|model[^.]{0,40}?(?:does not exist|not found|is not (?:a )?valid|is invalid)/i
      .test(e.message)
  ) {
    return { diagnosis: 'model_missing', detail: e.message };
  }
  // A network failure never reached a status at all.
  if (status === undefined && /LLM call failed/i.test(e.message)) {
    return { diagnosis: 'unreachable', detail: e.message };
  }
  return { diagnosis: 'rejected', detail: e.message };
};

export interface ProbeLlmSourceDeps {
  adapter: LLMAdapter;
  slot: LLMSlot;
  /** Injected so the caller can meter the probe like any other call — a probe
   *  that skips the quota tracker is an unmetered hole in the daily budget. */
  onUsage?: (totalTokens: number) => void;
  now?: () => number;
  timeout_ms?: number;
}

/** Run one minimal completion and report what the endpoint is.
 *
 *  Never throws for a provider failure — a failed probe is a RESULT, and the
 *  whole point is to put that result in front of the owner. It still rejects on
 *  a programming error (a missing adapter), which is not the owner's problem to
 *  read. */
export const probeLlmSource = async (
  deps: ProbeLlmSourceDeps,
): Promise<LlmProbeResult> => {
  const clock = deps.now ?? (() => Date.now());
  const started = clock();
  // ⛔ FORGET FIRST, OR THE PROBE CONFIRMS ITSELF. `completeWithFallbacks`
  // reads the capability memory and sends the degraded request up front, so a
  // probe run against a warm cache never re-tests anything — it reports back
  // exactly what was already cached, with the authority of a fresh
  // measurement. That makes "Test connection" the re-detection the owner
  // thinks they are asking for, and the only way to overturn a stale verdict.
  forgetEndpoint(deps.slot);
  // Ask for JSON only when the slot CLAIMS to support it — that is precisely
  // the declaration this probe exists to check, and asking a slot that never
  // claimed it would report a failure the owner did not configure.
  const wantsJson = deps.slot.supports_json !== false;
  try {
    const result = await completeWithFallbacks(
      deps.adapter,
      deps.slot,
      [
        { role: 'system', content: 'You are a connection test.' },
        { role: 'user', content: PROBE_PROMPT },
      ],
      {
        model: deps.slot.model,
        max_tokens: 1,
        json: wantsJson,
        timeout_ms: deps.timeout_ms ?? LLM_PROBE_TIMEOUT_MS,
      },
    );
    deps.onUsage?.(result.usage.total_tokens);
    return {
      ok: true,
      diagnosis: 'ok',
      // Read back from the shared detectors — see the module header on why the
      // probe does not classify these itself.
      accepts_system_role: !systemRoleUnsupported(deps.slot),
      supports_json: wantsJson ? !jsonModeUnsupported(deps.slot) : false,
      elapsed_ms: clock() - started,
    };
  } catch (e) {
    const { diagnosis, detail } = diagnoseProbeFailure(e);
    return { ok: false, diagnosis, detail, elapsed_ms: clock() - started };
  }
};

/** Test connection for the EMBEDDINGS slot.
 *
 *  ⚠ NOT the chat probe pointed at a different slot. Embeddings is a different
 *  provider call — `embed` vs `complete`, single text in / single vector out,
 *  a different adapter registry, and none of the chat capability questions
 *  apply (there is no system message and no JSON mode to negotiate). Reusing
 *  the chat probe here would send a chat completion to an embeddings model and
 *  report its 404 as a missing model, which is true but useless.
 *
 *  ⚠ The embeddings registry THROWS for an unregistered provider where the
 *  chat one returns undefined, and Anthropic's factory is a registered stub
 *  that throws at call time (there is no public Anthropic embeddings model).
 *  Both land in the same catch and become a readable verdict rather than an
 *  unhandled rejection. */
export const probeEmbeddingsSource = async (deps: {
  adapters: EmbeddingsAdapterRegistry;
  slot: LLMSlot;
  onUsage?: (totalTokens: number) => void;
  now?: () => number;
  timeout_ms?: number;
}): Promise<LlmProbeResult> => {
  const clock = deps.now ?? (() => Date.now());
  const started = clock();
  try {
    const adapter = deps.adapters(deps.slot.provider);
    const result = await adapter.embed(
      deps.slot,
      { input: PROBE_PROMPT },
      {
        model: deps.slot.model,
        timeout_ms: deps.timeout_ms ?? LLM_PROBE_TIMEOUT_MS,
      },
    );
    deps.onUsage?.(result.usage.total_tokens);
    return {
      ok: true,
      diagnosis: 'ok',
      dimensions: result.vector.length,
      elapsed_ms: clock() - started,
    };
  } catch (e) {
    const { diagnosis, detail } = diagnoseProbeFailure(e);
    return { ok: false, diagnosis, detail, elapsed_ms: clock() - started };
  }
};

/** D-262 § B7 — probe the dedicated transcription source.
 *
 *  ⛔ A CHAT COMPLETION CANNOT TEST THIS, for exactly the reason the embeddings
 *  probe above exists: sending one to a Whisper endpoint reports its 404 as a
 *  missing model — true, and useless. This drives the real transcription
 *  adapter over a real request.
 *
 *  ⚠ THE SAMPLE MUST CONTAIN SPEECH, and the reason is provider-specific
 *  rather than aesthetic. Silence would still prove auth, URL and model through
 *  the transport layer for the multipart endpoints — but the Gemini adapter
 *  raises `AI_RESPONSE_PARSE_FAILED` on an empty transcript, so a silent clip
 *  reports a working Gemini slot as broken. One provider of three is enough to
 *  settle it.
 *
 *  🔑 The transcript is RETURNED, not asserted. Models, accents and punctuation
 *  differ, so an exact comparison fails on working slots; and showing it is
 *  what makes a mis-set `transcription_language` visible — a pinned language
 *  the owner did not mean produces fluent nonsense that no assertion would
 *  catch but a person recognises instantly. */
export const probeTranscriptionSource = async (deps: {
  adapters: TranscriptionAdapterRegistry;
  slot: LLMSlot;
  /** The bundled speech clip. Absent ⇒ `no_sample`, never a synthetic pass.
   *  `text` is what it says, echoed back on success so the surface can show
   *  the expected line beside what was heard. */
  sample?: { bytes: Uint8Array; mime_type: string; filename: string; text?: string };
  /** The owner's pinned language, so the probe exercises the real path. */
  language?: string;
  now?: () => number;
  timeout_ms?: number;
}): Promise<LlmProbeResult> => {
  const clock = deps.now ?? (() => Date.now());
  const started = clock();
  if (!deps.sample || deps.sample.bytes.length === 0) {
    return {
      ok: false,
      diagnosis: 'no_sample',
      detail: 'No sample audio is bundled with this build, so the transcription '
        + 'source could not be tested. The slot may still be correct.',
      elapsed_ms: clock() - started,
    };
  }
  try {
    const adapter = deps.adapters(deps.slot.provider);
    const result = await adapter.transcribe(
      deps.slot,
      {
        audio: deps.sample.bytes,
        mime_type: deps.sample.mime_type,
        filename: deps.sample.filename,
        ...(deps.language !== undefined && deps.language.length > 0
          ? { language: deps.language }
          : {}),
      },
      {
        model: deps.slot.model,
        timeout_ms: deps.timeout_ms ?? LLM_PROBE_TIMEOUT_MS,
      },
    );
    return {
      ok: true,
      diagnosis: 'ok',
      transcript: result.text,
      // Echoed so the surface can render the pair. ⛔ Never compared here — an
      // equality check would fail on working slots over punctuation alone.
      ...(deps.sample.text !== undefined ? { expected_transcript: deps.sample.text } : {}),
      ...(deps.language !== undefined && deps.language.length > 0
        ? { probe_language: deps.language }
        : {}),
      elapsed_ms: clock() - started,
    };
  } catch (e) {
    const { diagnosis, detail } = diagnoseProbeFailure(e);
    return { ok: false, diagnosis, detail, elapsed_ms: clock() - started };
  }
};
