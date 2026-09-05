// Types
export type {
  LLMProvider, AdapterKey, LLMMessage, LLMMessageRole,
  LlmGatewayCallerSystemPolicy,
  LLMCompletionOptions, LLMSlot, LLMConfig,
  LlmGatewayDefaultRoute,
  LLMAdapter, LLMCompletionResult, LLMFinishReason, AdapterRegistry, ModelHint, TokenUsage,
  TokenUsageAttribution, WebChatTab,
  FreePoolApiEntry, FreePoolEntry, CoordinationStrategy,
  AvailabilityReason, AvailabilityStatus, AvailabilitySnapshot,
  Match, MatchSource,
  ContentPart, ContentSource, Modality, Modalities,
} from './types.js';
export {
  LLMError, normalizeLLMSlot,
  isLLMMessageRole, LLM_MESSAGE_ROLES,
  isLlmGatewayCallerSystemPolicy, LLM_GATEWAY_CALLER_SYSTEM_POLICIES,
  requiredModalities, supportsModalities, hasModalityDemand,
} from './types.js';

// Provider-neutral, conservative context-window accounting for text prompts.
export {
  DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS,
  LLM_TEXT_MESSAGE_OVERHEAD_TOKENS,
  computeContextInputTokenBudget,
  ESTIMATED_BYTES_PER_TOKEN,
  estimateConservativeTextTokens,
  estimateConservativeMessageTokens,
  estimateConservativeMessagesTokens,
} from './context-budget.js';

// D-172 P5 — provider-native ContentPart renderers (multimodal).
export { toAnthropicContent, toGoogleParts, toOpenAIContent } from './adapters/index.js';

// D-172 P5 / A.9 — voice→text transcription (distinct capability).
export { transcribe } from './transcribe.js';
export type { TranscribeDeps } from './transcribe.js';
export {
  createDefaultTranscriptionRegistry,
  createOpenAITranscriptionAdapter,
  createGoogleTranscriptionAdapter,
  createAnthropicTranscriptionAdapter,
  defaultTranscriptionModel,
} from './adapters/index.js';
export type {
  TranscriptionAdapter,
  TranscriptionAdapterRegistry,
  TranscriptionRequest,
  TranscriptionOptions,
  TranscriptionResult,
} from './adapters/index.js';

// Router
export { resolveSlot, computeMaxTokens, shouldEnableThinking } from './router.js';
export type { ResolvedSlot } from './router.js';

// Prompts
export { CONTRACTED_SLUGS, isContractedSlug, buildContractedPrompt, buildUncontractedPrompt } from './prompts.js';

// Parse
export {
  extractJSON, extractJSONArray, parseJSONObject, parseJSONArray,
  parseContractedOutput, parseContractedBatch,
} from './parse.js';

// Adapters
export {
  createDefaultRegistry,
  createAnthropicAdapter, createOpenAIAdapter, createGoogleAdapter,
} from './adapters/index.js';

// Provider registry — pluggable per-provider entries tying chat +
// embeddings adapters together. `createDefaultRegistry` and
// `createDefaultEmbeddingsRegistry` iterate this list.
export { LLM_PROVIDER_REGISTRY } from './providers/registry.js';
export type { LlmProviderEntry, ChatAdapterBuildDeps } from './providers/registry.js';

// Availability / match / preflight
export { buildAvailability } from './availability.js';
export type { BuildAvailabilityDeps } from './availability.js';
export { matchLLM, SPEED_RANK, candidateSlotsForLayer } from './match.js';
export type { MatchRequest, MatchDeps, MatchFailureDetails, ForceLayer, PinnedSlot } from './match.js';
export { preflightMatch } from './preflight.js';
export type { PreflightResult, PreflightStepMeta, PreflightIssue, PreflightDeps } from './preflight.js';

// Executor
export { executeLLM, deriveRequires, resolveLLMModelId, BATCH_ELEMENT_MEDIA_KEY } from './executor.js';
// The provider-error classifier. Public because a caller that reacts to a
// provider failure (the gateway, and any test asserting on one) must be able to
// produce and recognise the SAME wrapped/truncated message shape the adapters
// raise — hand-copying that format is how a detector passes its unit test and
// misses every live rejection.
export { classifyProviderError } from './adapters/anthropic.js';
export { completeWithFallbacks } from './executor.js';
// D-208 follow-on — the wire role is DETECTED, never configured. The gateway's
// raw direct path calls the adapter itself, so it needs the same seam.
export {
  demoteSystemMessages,
  endpointFingerprint,
  isJsonModeRejection,
  isSystemRoleRejection,
  jsonModeUnsupported,
  forgetEndpoint,
  hydrateEndpointCapabilities,
  onEndpointCapabilityLearned,
  resetEndpointCapabilities,
  snapshotEndpointCapabilities,
  systemRoleUnsupported,
  isContextOverflowRejection,
  noteContextAccepted,
  noteContextRefused,
  learnedContextWindow,
  provenAcceptedInput,
  minLearnedContextWindow,
  maxProvenAcceptedInput,
} from './endpoint-capabilities.js';
export type { EndpointCapabilityNote } from './endpoint-capabilities.js';
// Test connection — one real call, reported in terms the owner can act on.
export {
  probeLlmSource,
  probeEmbeddingsSource,
  diagnoseProbeFailure,
  LLM_PROBE_TIMEOUT_MS,
} from './probe.js';
export type { LlmProbeResult, LlmProbeDiagnosis, ProbeLlmSourceDeps } from './probe.js';

export type { LLMExecutorDeps, MatchContextHook, LLMMatchResolved } from './executor.js';

// Timeout policy
export {
  LLM_MIN_TIMEOUT_MS,
  LLM_HARD_CAP_MS,
  resolveLLMTimeoutMs,
} from './timeout.js';

// Quota tracking (per-entry daily + RPM for the free pool)
export { createQuotaTracker } from './quota.js';
export type { QuotaTracker, QuotaSnapshot } from './quota.js';

// Config validation (trust boundaries — server.setLLMConfig, CLI import, etc.)
export { parseLLMConfig, LLMConfigValidationError } from './validate-config.js';

// D-131 — Embeddings substrate. Parallel surface to executeLLM for the
// `ai-embed` ingredient family. Adapters (P2), availability widening (P3),
// quota integration (P4), and kernel ai-embed manifest (P5) ride on top
// of the P1 driver interface re-exported here.
export {
  executeEmbedding, isEmbeddingsManifest,
  createDefaultEmbeddingsRegistry,
  createOpenAIEmbeddingsAdapter,
  createGoogleEmbeddingsAdapter,
  createAnthropicEmbeddingsAdapter,
  buildEmbeddingsAvailability,
} from './embeddings/index.js';
export type {
  EmbeddingsRequest, EmbeddingsOptions, EmbeddingsResult,
  EmbeddingsAdapter, EmbeddingsAdapterRegistry, EmbeddingsOutput,
  EmbeddingsExecutorDeps,
  EmbeddingsAvailabilitySnapshot, BuildEmbeddingsAvailabilityDeps,
} from './embeddings/index.js';
