import type {
  ChatCatalogDeliveryMode,
  ChatModelSourceId,
  ModelHint,
  WebChatTab,
} from '@recued/contracts';

/** Provider identifier. `openai-compatible` covers any OpenAI-compatible endpoint
 *  (Together, Groq, Ollama, vLLM, etc.) via a custom base_url. */
export type LLMProvider = 'anthropic' | 'openai' | 'openai-compatible' | 'google';

/** Adapter registry key. The executor picks an adapter by this key after the
 *  match resolver runs — no transport branching downstream of the registry lookup. */
export type AdapterKey = LLMProvider;

/** D-172 P5 / A.10 — a media payload reference inside a `ContentPart`.
 *  Provider-neutral: `kind` distinguishes inline base64 bytes (the only
 *  shape our `file.read` pipeline produces — N.5) from a remote URL (web
 *  images; reserved for non-CAS sources). `data` carries the base64 string
 *  (`kind: 'base64'`) OR the URL (`kind: 'url'`); `media_type` is the
 *  detected MIME (`image/png`, `audio/wav`, `application/pdf`). */
export interface ContentSource {
  kind: 'base64' | 'url';
  media_type: string;
  data: string;
}

/** D-172 P5 / A.10 — one provider-neutral content block. Adapters render
 *  these into provider-native shapes (Anthropic image/document blocks,
 *  Gemini `inlineData`, OpenAI `image_url` / `input_audio` / `file`). The
 *  modality is the block `type`; `requiredModalities` derives the
 *  capability demand from a message's parts so the match resolver can
 *  prefer a modality-capable source (N.8). Audio + document are base64-only
 *  in practice; images may also be a URL.
 *
 *  D-164 prompt-cache restructure — a text part may carry `cache_breakpoint`.
 *  When set, an adapter whose provider supports explicit prompt caching
 *  (Anthropic) places ONE cache breakpoint after this block (`cache_control:
 *  {type:'ephemeral'}`), so the stable prefix up to here is cached and reused
 *  across turns/rounds. Providers without explicit caching (OpenAI / Gemini /
 *  openai-compatible free-pool / local) IGNORE the marker and send the plain
 *  string `content` — their automatic prefix caching (where present) still
 *  applies, and nothing breaks where it isn't. The marker is meaningless on a
 *  non-text part. */
export type ContentPart =
  | { type: 'text'; text: string; cache_breakpoint?: boolean }
  | { type: 'image'; source: ContentSource }
  | { type: 'audio'; source: ContentSource }
  | { type: 'document'; source: ContentSource };

/** The modality flavour of a non-text `ContentPart`. */
export type Modality = 'image' | 'audio' | 'document';

/** D-172 P5 / Q4 — a model's declared modality capabilities. Each BYOK
 *  slot + free-pool API entry carries this so the match resolver routes
 *  media to a model that can see it, and the executor warns (never
 *  silently drops / auto-reroutes) when none is capable. Absent flags
 *  read as `false` (text-only) — the conservative default. */
export interface Modalities {
  image?: boolean;
  audio?: boolean;
  document?: boolean;
}

/** A single chat message in provider-neutral shape.
 *
 *  D-172 P5 — `content_parts` is **additive**: text-only callers keep
 *  setting `content` (a string) and every existing consumer is unchanged.
 *  When `content_parts` is present and non-empty, adapters render it
 *  instead of `content` (a multimodal turn carries its instruction text as
 *  a leading `{ type: 'text' }` part). Keeping `content` a string — rather
 *  than unioning it to `string | ContentPart[]` — means no `.content`
 *  string consumer (chat-orchestrator / chat-store / parse) breaks. */
/** The wire roles a message can carry. THE closed list — the config
 *  validator and the Settings role picker both derive from this const rather
 *  than restating the union, so a member added here cannot be silently missed
 *  by one of them (a subset would still typecheck). */
export const LLM_MESSAGE_ROLES = ['system', 'user', 'assistant'] as const;

export type LLMMessageRole = (typeof LLM_MESSAGE_ROLES)[number];

export const isLLMMessageRole = (value: unknown): value is LLMMessageRole =>
  typeof value === 'string'
  && (LLM_MESSAGE_ROLES as readonly string[]).includes(value);

export interface LLMMessage {
  role: LLMMessageRole;
  content: string;
  /** D-172 P5 — provider-neutral multimodal blocks. When present + non-empty,
   *  adapters render these and ignore `content`. */
  content_parts?: ContentPart[];
}

/** Options passed to the adapter's complete() call. */
export interface LLMCompletionOptions {
  /** Provider-specific model identifier (e.g. "claude-opus-4-6", "gpt-4.1", "gemini-2.5-pro"). */
  model: string;
  /** Upper bound for output tokens. */
  max_tokens: number;
  /** Enable extended reasoning when the slot supports it. Ignored otherwise. */
  thinking?: boolean;
  /** Enable provider's built-in web search tool when supported. */
  search?: boolean;
  /** Request the provider's native JSON-object response mode
   *  (OpenAI/openai-compatible `response_format:{type:'json_object'}`, Gemini
   *  `generationConfig.responseMimeType:'application/json'`). The executor sets
   *  this when the call wants JSON AND the slot declares `supports_json`.
   *  Adapters without a JSON mode (Anthropic) ignore it; the post-hoc tolerant
   *  parser remains the net regardless. */
  json?: boolean;
  /** Per-call timeout in milliseconds, or `null` to skip the timer entirely.
   *  The default is `null` — LLM calls run unbounded because the user has
   *  already paid for the compute. See ./timeout.ts for the full rationale. */
  timeout_ms: number | null;
}

/** A single user-configured LLM slot — the resolved model + credentials + capabilities.
 *  Free users have only slot_1. Pro users can configure slot_2 for quality/thinking.
 *
 *  `speed` is the user-declared capability tier (fast/quality/thinking). Required
 *  in new code; legacy configs without `speed` are filled by `normalizeLLMSlot`
 *  (slot_1 → 'fast', slot_2 → 'quality') on load so nothing breaks.
 *  `supports_thinking` is deprecated — the match resolver derives it from
 *  `speed === 'thinking'`. The field is retained so existing callers and
 *  persisted configs keep compiling.
 *
 *  `provider` is typed as `AdapterKey` so resolved slots and user-configured
 *  slots share one adapter-key surface. */
export interface LLMSlot {
  provider: AdapterKey;
  model: string;
  /** BYOK: API key for this slot. Stored in the vault, injected at execute time. */
  api_key: string;
  /** Override endpoint (required for `openai-compatible`). */
  base_url?: string;
  /** Max output tokens this model can produce. Used to clamp `max_tokens`. */
  max_output_tokens?: number;
  /** Total model context window, in tokens (input + reserved output).
   *  Optional for backward compatibility; surfaces that promise proactive
   *  context fitting (currently `llm_gateway`) must fail closed when the
   *  selected source does not declare it rather than guessing from a mutable
   *  provider model name. */
  context_window_tokens?: number;
  /** Per-slot daily token budget (D-079 / D-094 — reinstated). When set
   *  to a positive value, the slot stops matching once its tokens-consumed-
   *  today (tracked by the `QuotaTracker` under the slot key) reaches the
   *  budget; it resumes at the next UTC daily reset. Absent / 0 = unlimited.
   *  Enforcement is "everywhere" — over budget excludes the slot from ALL
   *  matching (chat + background) until reset (see `buildAvailability`'s
   *  `slot_budget.over_cutoff` + `matchLLM`). */
  daily_budget_tokens?: number;
  /** Declarative tier. Required going forward. Legacy configs fill via normalize. */
  speed?: ModelHint;
  /** Whether this model supports structured JSON output. Required going forward. */
  supports_json?: boolean;
  /** @deprecated Derived from `speed === 'thinking'`. Kept for backward compat. */
  supports_thinking?: boolean;
  /** DETECTED, never declared — does this endpoint accept a `system` message?
   *
   *  `prompt -> system` when true or absent; `prompt -> first user turn` when
   *  false. Learned from an actual refusal (`endpoint-capabilities.ts`) and
   *  written back so a restart does not re-pay the rejection on every
   *  configured source. Absent means "not yet known", which reads as yes — the
   *  optimistic default, so a lost value costs one probe rather than
   *  permanently demoting an endpoint that was fine.
   *
   *  ⛔ NOT a routing input, and no filter may read it. `match.ts` gates on
   *  `supports_json`; a capability that merely changes how a prompt is PACKED
   *  must never be able to make a source unroutable. Cleared by the save path
   *  when provider / base_url / model change — that edit is what makes the
   *  observation stale. */
  system_role_ok?: boolean;
  /** DETECTED — does this endpoint accept the native JSON-mode param?
   *
   *  ⚠ NOT `supports_json`, which sits nearby and means something else:
   *  `supports_json` is OWNER-DECLARED and is a MATCH input (`match.ts:121`
   *  excludes a false one from every json call). This one is machine-observed
   *  and inert to routing — an endpoint that cannot take `response_format`
   *  still serves json calls fine via the post-hoc parser. Conflating the two
   *  turns a graceful degradation into an unroutable source. */
  native_json_ok?: boolean;
  /** Whether this model supports the provider's built-in web search. */
  supports_search?: boolean;
  /** D-172 P5 / Q4 — declared modality capabilities. When a turn carries a
   *  non-text `ContentPart`, the match resolver prefers a slot whose
   *  `modalities` cover the needed kinds; if none is capable the executor
   *  surfaces `AI_MODALITY_UNSUPPORTED` (the N.8 warn) rather than silently
   *  dropping the media or auto-rerouting. Absent → text-only. */
  modalities?: Modalities;
  // ⛔ D-262 § B4 — `transcription_model` RETIRED here. It existed so a CHAT
  // slot could name a second model for `transcribe` to use, which only made
  // sense while transcription routed through the chat pool. It reads the
  // dedicated `transcription_slot` now, whose own `model` IS the transcription
  // model — so a second field on a chat slot could only ever disagree with the
  // thing actually in use. The one-time derivation still reads the persisted
  // VALUE (a migration reads the old shape); nothing writes one again.
}

/** Coordination strategy applied *within* a group of tied candidates (free
 *  pool or BYOK slots) when the match algorithm has more than one equally
 *  eligible source. Per-group ranking (free before BYOK) is the engine's
 *  job; the strategy only decides ties.
 *
 *  - `round_robin` — rotate a cursor, persisted across service-worker restarts
 *  - `weighted`    — reservoir-sample among eligible entries by `weight` */
export type CoordinationStrategy = 'round_robin' | 'weighted';

/** An API entry in the free LLM pool. Each entry carries its own declarative
 *  capability record (speed + supports_json + supports_search) so matching is
 *  strict comparison — no heuristic detection. `model` is required free text
 *  because most free providers (OpenRouter, Groq, Mistral)
 *  demand an explicit model string. */
export interface FreePoolApiEntry {
  id: string;
  type: 'api';
  provider: LLMProvider;
  model: string;
  api_key: string;
  base_url?: string;
  speed: ModelHint;
  supports_json: boolean;
  /** DETECTED — see {@link LLMSlot.system_role_ok}. Same semantics, same
   *  prohibition on reaching the matcher. */
  system_role_ok?: boolean;
  /** DETECTED — see {@link LLMSlot.native_json_ok}. */
  native_json_ok?: boolean;
  supports_search?: boolean;
  enabled: boolean;
  weight?: number;
  daily_cap_tokens?: number;
  rpm_cap?: number;
  /** Total model context window, in tokens (input + reserved output). */
  context_window_tokens?: number;
  /** D-172 P5 / Q4 — declared modality capabilities for this free-pool
   *  entry. Same semantics as `LLMSlot.modalities`: routes media to a
   *  capable entry, warns (never drops/reroutes) when none is. Absent →
   *  text-only. A free Gemini entry is the typical multimodal free source. */
  modalities?: Modalities;
  // ⛔ D-262 § B4 — `transcription_model` RETIRED here too, and for the same
  // reason: a pool entry named a transcription model only because the pool was
  // a transcription source. It is not one any more.
}

export type FreePoolEntry = FreePoolApiEntry;

/** D-196 S2c — OpenAI-compatible gateway routing knob.
 *
 *  The public OpenAI `model` field is compatibility-only in v1; the server-side
 *  Settings -> LLM route decides which configured source serves the request. */
export type LlmGatewayDefaultRoute = 'pool' | 'slot:slot_1' | 'slot:slot_2';

/** The user's two-slot LLM configuration plus optional free pool. slot_2 is
 *  optional (Pro convenience). `free_pool` is a flat list of free-tier API
 *  keys. The match resolver auto-ranks
 *  every eligible candidate (free before BYOK, exact-tier match before
 *  downgrade/upgrade); `free_pool_strategy` only breaks ties *within* the
 *  winning group. */
export interface LLMConfig {
  slot_1?: LLMSlot;
  slot_2?: LLMSlot;
  /** D-174 R28 Slice C — dedicated embeddings source. A full LLMSlot
   *  shape (provider / api_key / base_url), but its `model` field carries
   *  the EMBEDDINGS model string (e.g. `text-embedding-3-small`), and this
   *  is the ONLY source the embeddings executor reads. Deliberately
   *  separate from slot_1 / slot_2 / free_pool: embeddings is a recipe +
   *  housekeeping capability, never a chat model-select option, so the
   *  chat match resolver never sees it. Anthropic publishes no embeddings
   *  model — an Anthropic embeddings_slot surfaces unavailable at execute
   *  time via the adapter stub. */
  embeddings_slot?: LLMSlot;
  /** D-262 § B1 — dedicated transcription source. Same shape and same reasons
   *  as `embeddings_slot`: a full `LLMSlot` whose `model` field carries the
   *  TRANSCRIPTION model (`whisper-1`, `whisper-large-v3`, or a Gemini chat
   *  model, which is its own transcriber), and the ONLY source `transcribe`
   *  reads.
   *
   *  ⛔ Deliberately invisible to the chat match resolver. Transcription is
   *  never a chat model-select option, and routing a voice turn to a different
   *  chat model because that one happens to have ears would silently replace
   *  the model the owner pinned. Fall back on the HEARING, never on the
   *  ANSWERING — which this shape enforces by construction, since the resolver
   *  cannot see this slot.
   *
   *  ⚠ `base_url` is the whole remote-vs-local answer: a server on a Pi points
   *  at a remote endpoint, one with a GPU points at a local
   *  `whisper.cpp` / `faster-whisper`, and both are the same field.
   *
   *  Anthropic publishes no transcription endpoint — an Anthropic
   *  transcription_slot surfaces `AI_MODALITY_UNSUPPORTED` at execute time via
   *  the adapter stub, exactly as an Anthropic embeddings slot does. */
  transcription_slot?: LLMSlot;
  /** D-262 § B6 — the owner's spoken language as an ISO-639-1 code, passed to
   *  the transcription provider.
   *
   *  ⛔ ABSENT MEANS AUTO-DETECT, AND NOTHING SUGGESTS A DEFAULT. Multi-language
   *  needs differ and there is no standard to recommend, so this is the owner's
   *  to set or leave empty.
   *
   *  ⛔⛔ NEVER DEFAULT IT FROM A LOCALE. A pinned language does not merely hint
   *  — the provider renders speech INTO that language, so a wrong pin returns
   *  fluent nonsense rather than an error. A browser locale or the server's
   *  `LANG` is a guess wearing the costume of a default, and it would degrade
   *  exactly the multilingual owner it claims to serve.
   *
   *  ⚠ A config-level sibling of the slot (like `free_pool_strategy` beside
   *  `free_pool`), NOT a field on `LLMSlot`: that type is shared with chat, and
   *  this is a property of how the OWNER SPEAKS rather than of the provider, so
   *  it must survive swapping providers. */
  transcription_language?: string;
  /** D-262 § B12.3 — the most transcription calls allowed in a UTC day.
   *
   *  ⛔ REQUESTS, NOT SECONDS OR TOKENS, and the name says so. Providers bill
   *  by audio seconds — but the multipart endpoints report a duration only in
   *  their verbose response format and Gemini reports none at all, so a
   *  seconds cap would silently stop counting for one provider and read as
   *  generous when it was blind. Requests is the only quantity that is always
   *  exact, and combined with the upload size cap it bounds spend honestly.
   *
   *  ⚠ Absent or non-positive means UNLIMITED, matching `daily_budget_tokens`.
   *  Recording continues either way: usage is visible before it is capped, and
   *  a number nobody can see is not a control. */
  transcription_daily_requests?: number;
  free_pool?: FreePoolEntry[];
  free_pool_strategy?: CoordinationStrategy;
  /** Global user-level fallback for allow_upgrade, used when the recipe omits
   *  the `allow_llm_upgrade` variable. Default false. */
  allow_upgrade_default?: boolean;
  /** Lever-2 per-slot — the chat catalog delivery mode PER LLM source
   *  (`slot_1` | `slot_2` | `free_pool`). Co-located here so a user's choice in
   *  Settings → AI/Models is carried by the existing save path + the per-use
   *  `getLlmConfig()` read, so the chat orchestrator routes a saved mode WITHOUT
   *  a restart (matches the D-174 R28 "resolve config per-use" behaviour). A
   *  source absent from the map (or the whole field absent) resolves to the
   *  orchestrator's fallback: the smart default when the wire flag is on, else
   *  the env-global mode, else `full`. See {@link ChatCatalogDeliveryMode}. */
  catalog_modes?: Partial<Record<ChatModelSourceId, ChatCatalogDeliveryMode>>;
  /** D-196 S2c — route used by the OpenAI-compatible `llm_gateway` door.
   *  Missing means the gateway fails closed before any model call or seller
   *  `chat_turn` usage consumption. */
  llm_gateway_default_route?: LlmGatewayDefaultRoute;
  /** Optional public model alias returned by `/v1/models` and echoed in
   *  `/v1/chat/completions`. The underlying provider model stays private. */
  llm_gateway_model_alias?: string;
  /** Owner-authored ROLE + INSTRUCTIONS for the CHAT surface (owner chat +
   *  messenger) — block 1 of the system prompt, and the ONLY editable block.
   *  "You are a dental assistant for Dr. Chen. Check the calendar before
   *  answering anything about appointments."
   *
   *  ABSENT ⇒ the built-in (`DEFAULT_CHAT_ROLE_INSTRUCTIONS`). Clearing it
   *  (`null` over the rpc) restores that byte-for-byte — absence IS how the
   *  default is expressed, so reset has no restore step to get wrong.
   *
   *  ⚠ It sets the model's FOCUS. It can never reach a Recued feature: the
   *  AIOutput wire contract (block 2) and the feature text (block 3 — tool
   *  mechanics, the approvals posture, the gateway's contract-scoping lines,
   *  the catalog-mode guidance) are composed around it on every turn and are
   *  not editable by anyone. See `backend/server/src/llm-system-prompt.ts`. */
  chat_role_instructions?: string;
  /** Wire role the CHAT system prompt is delivered under. Absent ⇒ `'system'`.
   *  Exists because some OpenAI-compatible endpoints (several free-pool
   *  providers, some reasoning models) reject a `system` role outright. A
   *  transport knob — unrelated to the ROLE the owner writes in block 1. */
  chat_system_role?: LLMMessageRole;
  /** Owner-authored ROLE + INSTRUCTIONS for the `llm_gateway` door — GLOBAL,
   *  one block for every caller. Same semantics as {@link chat_role_instructions}.
   *
   *  Deliberately NOT derived from `chat_role_instructions`: `runChatTurn` is
   *  shared by chat, messenger AND the gateway, so deriving one from the other
   *  is the one seam where an owner's private persona would reach paying
   *  external customers. */
  llm_gateway_role_instructions?: string;
  /** Wire role the gateway system prompt is delivered under. Absent ⇒ `'system'`. */
  llm_gateway_system_role?: LLMMessageRole;
  /** What the gateway does with a CALLER's OpenAI `system` message.
   *
   *  `'context'` (default, and the pre-existing behaviour) — it reaches the
   *  model as `customer_application_instructions`: contract-scoped data it
   *  follows, below the owner's authority. `'append'` / `'replace'` promote it
   *  to real system instructions, beside or instead of the owner's block 1.
   *  `'ignore'` drops it.
   *
   *  ⚠ EVERY value operates on block 1 alone — a caller on `replace` still
   *  cannot touch the AIOutput contract, the approvals posture, or the
   *  contract-scoping lines, and no value can widen the contract (capability is
   *  enforced in code at the Gateway, never by prompt text). What `replace`
   *  costs the owner is their BEHAVIOURAL guardrails inside already-granted
   *  capability — which is why it is a deliberate choice, not the default. */
  llm_gateway_caller_system_policy?: LlmGatewayCallerSystemPolicy;
}

/** THE closed list of caller-system-message policies. It lives HERE — not on
 *  the server beside the prompt composer — because `packages/` may never import
 *  `backend/`, and the config validator needs it. The server's composer imports
 *  this const rather than restating the union: a restated subset would
 *  typecheck happily while silently dropping a policy from validation.
 *
 *  `context` (default, the pre-existing behaviour) — the caller's system message
 *  reaches the model as `customer_application_instructions`: contract-scoped
 *  data it follows, below the owner's authority. `append` / `replace` promote it
 *  to real system instructions, beside or instead of the owner's role block.
 *  `ignore` drops it. */
export const LLM_GATEWAY_CALLER_SYSTEM_POLICIES = [
  'context',
  'append',
  'replace',
  'ignore',
] as const;

export type LlmGatewayCallerSystemPolicy =
  (typeof LLM_GATEWAY_CALLER_SYSTEM_POLICIES)[number];

export const isLlmGatewayCallerSystemPolicy = (
  value: unknown,
): value is LlmGatewayCallerSystemPolicy =>
  typeof value === 'string'
  && (LLM_GATEWAY_CALLER_SYSTEM_POLICIES as readonly string[]).includes(value);

/** Reason a source is unavailable at a given point in time. Emitted in the
 *  availability snapshot and in PreflightIssue so the UI can render specific
 *  guidance ("add a thinking-tier LLM" vs "open the Gemini tab"). */
export type AvailabilityReason =
  | 'no_key'
  | 'no_model'
  | 'no_embeddings_model'
  | 'budget_met'
  | 'quota_exhausted'
  | 'disabled'
  | 'capability_mismatch';

export type AvailabilityStatus =
  | { available: true }
  | { available: false; reason: AvailabilityReason };

/** One-shot snapshot of every configured source's live state. Built once per
 *  executeLLM call by buildAvailability(). Auditable: the full snapshot is
 *  included in AI_LLM_UNAVAILABLE error details and in the llm_match_resolved
 *  debug event, so the user can answer "why did it pick X?" without guessing.
 *
 *  `slot_budget` is separate from base `slot_1`/`slot_2` availability because
 *  the `under_budget_only` offer flag is a match-time decision, not a hard
 *  availability filter: a slot that's over its cutoff is still "available"
 *  to offers that don't have `under_budget_only`. */
export interface AvailabilitySnapshot {
  /** Retained as an empty compatibility field while older callers consume snapshots. */
  web_chat: Partial<Record<WebChatTab, AvailabilityStatus>>;
  free_pool: Array<{ id: string; status: AvailabilityStatus }>;
  slot_1: AvailabilityStatus;
  slot_2: AvailabilityStatus;
  slot_budget: {
    slot_1: { over_cutoff: boolean };
    slot_2: { over_cutoff: boolean };
  };
}

/** Which source the match resolver picked. Discriminator determines how the
 *  executor tags TokenUsage and how the round-robin cursor advances. */
export type MatchSource =
  | { kind: 'slot'; slot_key: 'slot_1' | 'slot_2' }
  | { kind: 'pool'; entry: FreePoolApiEntry };

/** Resolver output. `slot` is a provider-shaped object passed to the adapter
 *  (synthesized for pool entries from their entry fields). */
export interface Match {
  source: MatchSource;
  slot: LLMSlot;
  adapterKey: AdapterKey;
  resolved_hint: ModelHint;
  used_downgrade: boolean;
  used_upgrade: boolean;
}

/** Token usage reported by the provider for a single completion.
 *
 *  D-137 Trio #E — the optional `cache_read_input_tokens` /
 *  `cache_write_input_tokens` / `reasoning_tokens` / `model_id`
 *  fields mirror `TokenUsageReport` in `@recued/contracts`. The
 *  executor surfaces this internal shape via `onTokenUsage`; the
 *  chat adapter then translates to the public-facing
 *  `TokenUsageReport` at the engine boundary so engine code doesn't
 *  cross-import from `packages/llm`. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Input tokens served from prompt cache. Subset of `input_tokens`. */
  cache_read_input_tokens?: number;
  /** Input tokens spent CREATING a cache entry (Anthropic-specific). */
  cache_write_input_tokens?: number;
  /** Reasoning / thinking output tokens. Subset of `output_tokens`. */
  reasoning_tokens?: number;
  /** Resolved provider model id (`slot.model` at call time). */
  model_id?: string;
  /** @deprecated Populated only for slot attributions. New code should read `attribution`. */
  slot_key?: 'slot_1' | 'slot_2';
  /** Which configured source produced this call. Unified across slots and pool. */
  attribution?: TokenUsageAttribution;
  /** Which recipe triggered this call. Set by the runtime adapter wrapper. */
  recipe_id?: string;
}

export type TokenUsageAttribution =
  | { kind: 'slot'; slot_key: 'slot_1' | 'slot_2' }
  | { kind: 'pool'; entry_id: string };

/** Provider-normalized reason a completion stopped. */
export type LLMFinishReason = 'stop' | 'length' | 'content_filter';

/** Result from an adapter completion call. */
export interface LLMCompletionResult {
  text: string;
  usage: TokenUsage;
  /** Optional for compatibility with adapters/providers that do not expose a
   *  stop reason. Gateway surfaces must not rewrite a known output-limit stop
   *  as a normal `stop`. */
  finish_reason?: LLMFinishReason;
}

export interface LLMAdapter {
  /** The adapter-registry key this adapter handles. */
  readonly provider: AdapterKey;
  /** Call the provider and return the assistant's reply + token usage.
   *  Implementations should throw LLMError with appropriate codes:
   *    AI_TIMEOUT, AI_LLM_UNAVAILABLE, AI_TOKEN_BUDGET_EXCEEDED, AI_OUTPUT_INVALID.
   *  Set `retryable: true` on LLMError when the error is eligible for a
   *  cascade re-match (auth failure, quota exhausted, tab closed before response).
   *  The caller handles parsing and retries. */
  complete(slot: LLMSlot, messages: LLMMessage[], options: LLMCompletionOptions): Promise<LLMCompletionResult>;
}

/** Factory that returns an adapter for a given adapter key. Typically a registry. */
export type AdapterRegistry = (key: AdapterKey) => LLMAdapter;

/** Error thrown by the LLM layer. Uses RecipeErrorCodes so the engine can route properly.
 *  `retryable: true` signals the executor that a cascade re-match is appropriate —
 *  used for auth-fail, quota-exhausted, and tab-closed-before-response cases. */
export class LLMError extends Error {
  public readonly retryable: boolean;
  constructor(
    public code:
      | 'AI_LLM_UNAVAILABLE'
      | 'AI_MODEL_REFUSED'
      | 'AI_TIMEOUT'
      | 'AI_OUTPUT_INVALID'
      | 'AI_TOKEN_BUDGET_EXCEEDED'
      | 'AI_RESPONSE_PARSE_FAILED'
      | 'AI_RESPONSE_VALIDATION_FAILED'
      /** D-172 P5 / N.8 / Q4 — the chosen/configured model(s) cannot see the
       *  modality the turn carries (image / audio / document). The N.8 "warn,
       *  never silently drop, never auto-reroute" surface: NOT retryable (a
       *  cascade re-match would just hit another incapable model — the user
       *  must pick a modality-capable model or remove the media). */
      | 'AI_MODALITY_UNSUPPORTED'
      /** D-262 § B4 — no `transcription_slot` is configured, so there is no
       *  source to transcribe with.
       *
       *  ⚠ DELIBERATELY DISTINCT from `AI_MODALITY_UNSUPPORTED`, which means a
       *  source exists and cannot hear. "Nothing is set up" and "what you set
       *  up cannot do this" send a person to two different places, and one
       *  code for both would send them to the wrong one half the time. Not
       *  retryable: no cascade can invent a source. */
      | 'AI_NO_TRANSCRIPTION_SOURCE',
    message: string,
    public details?: Record<string, unknown>,
    retryable = false,
  ) {
    super(message);
    this.name = 'LLMError';
    this.retryable = retryable;
  }
}

/** Fill missing `speed` / `supports_json` on legacy slots so match-time code
 *  can assume both are set. Convention: slot_1 → 'fast', slot_2 → 'quality';
 *  supports_json defaults true (anthropic/openai/google/openai-compatible all
 *  emit JSON given the right prompt). Writes returned, never mutates input. */
export const normalizeLLMSlot = (slot: LLMSlot | undefined, slotKey: 'slot_1' | 'slot_2'): LLMSlot | undefined => {
  if (!slot) return slot;
  return {
    ...slot,
    speed: slot.speed ?? (slotKey === 'slot_1' ? 'fast' : 'quality'),
    supports_json: slot.supports_json ?? true,
  };
};

/** D-172 P5 — the set of modalities a list of content parts demands. Text
 *  parts contribute nothing; every non-text part flips its modality flag.
 *  Returns only the flags that are actually required (true), so an
 *  all-text part list yields `{}` (no modality demand → text path). */
export const requiredModalities = (parts: readonly ContentPart[]): Modalities => {
  const req: Modalities = {};
  for (const p of parts) {
    if (p.type === 'image') req.image = true;
    else if (p.type === 'audio') req.audio = true;
    else if (p.type === 'document') req.document = true;
  }
  return req;
};

/** D-172 P5 — true iff `caps` covers every modality `required` demands.
 *  An undefined/absent capability flag reads as `false` (text-only — the
 *  conservative default), so a slot that never declared `modalities` fails
 *  any media demand and the executor surfaces the N.8 warn. */
export const supportsModalities = (
  caps: Modalities | undefined,
  required: Modalities,
): boolean => {
  if (required.image && !caps?.image) return false;
  if (required.audio && !caps?.audio) return false;
  if (required.document && !caps?.document) return false;
  return true;
};

/** D-172 P5 — true iff `req` demands at least one modality. */
export const hasModalityDemand = (req: Modalities): boolean =>
  req.image === true || req.audio === true || req.document === true;

/** Re-export contract types the public surface needs. */
export type { ModelHint, WebChatTab };
