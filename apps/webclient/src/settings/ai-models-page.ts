/** D-174 D14 — Settings -> AI / Models consolidated LLM config page.
 *
 * Frontend-only assembly over existing RPCs. The page wires the controls whose
 * server seams already exist and renders honest pending rows for controls whose
 * backend write path is not present in this checkout.
 */

import { totalRecord } from '@recued/contracts';
import type { ServerLlmUsageResponse } from '@recued/contracts';
import { resolveFreePoolDataUse, freePoolDataUseNotice } from '@recued/contracts';
import {
  CHAT_CATALOG_DELIVERY_MODES,
  CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE,
  isChatCatalogDeliveryMode,
  isChatModelSourceId,
  type ChatCatalogDeliveryMode,
  type ChatModelSourceId,
  type HousekeepingConfigRow,
  type ServerConfigField,
  type ServerConfigValue,
  type ServerLlmCallerSystemPolicy,
  type ServerLlmMessageRole,
  type ServerLlmPrompt,
  type ServerLlmProbeResult,
  type ServerLlmPromptSurface,
} from '@recued/contracts';
import {
  formatClientDateTime,
  wireFocusTrap,
  type FocusTrapHandle,
} from '@recued/ui-shared';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import {
  buildChatModelDefaultModel,
  reduceChatDefaultModelPrefChanged,
  type ChatModelDefaultRenderModel,
} from './chat-model-default.js';
import {
  buildChatBehaviourModel,
  CHAT_CATALOG_MODE_LABELS,
  type ChatBehaviourRenderModel,
} from './chat-behaviour.js';
import {
  buildChatModelSourceOptions,
} from '../chat/model-routing.js';
import {
  mountLlmResultCacheCard,
  type LlmResultCacheCardMount,
  type LlmResultCacheClearCaller,
  type LlmResultCacheStatsCaller,
} from './llm-result-cache-card-mount.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { serializeShellRoute } from '../shell/route.js';
import { isAnyAiSourceConfigured } from './llm-availability.js';

export const AI_MODELS_PAGE_ATTR = 'data-recued-ai-models-page';
export const AI_MODELS_PAGE_STATE_ATTR = 'data-recued-ai-models-page-state';
export const AI_MODELS_CONTROL_ATTR = 'data-recued-ai-models-control';
export const AI_MODELS_PENDING_CONTROL_ATTR =
  'data-recued-ai-models-pending-control';
export const AI_MODELS_FAIL_LOUD_ATTR = 'data-recued-ai-models-fail-loud';
// D-174 R28 — a transient banner for a FAILED write action (save slot,
// add/remove/toggle pool entry, save budget). Distinct from FAIL_LOUD
// (an unmatched stored default) and the load-error list (read failures).
export const AI_MODELS_ACTION_ERROR_ATTR = 'data-recued-ai-models-action-error';
export const AI_MODELS_POOL_REMOVE_ATTR = 'data-recued-ai-models-pool-remove';
export const AI_MODELS_POOL_REMOVE_DIALOG_ATTR =
  'data-recued-ai-models-pool-remove-dialog';
export const AI_MODELS_POOL_REMOVE_CANCEL_ATTR =
  'data-recued-ai-models-pool-remove-cancel';
export const AI_MODELS_POOL_REMOVE_CONFIRM_ATTR =
  'data-recued-ai-models-pool-remove-confirm';
export const AI_MODELS_MODEL_PREF_BUTTON_ATTR =
  'data-recued-ai-models-model-pref';
/** Global chat behaviour — the rolling-brief toggle and the projected global
 *  catalog mode. Both are SERVER-WIDE, which is why they live in their own
 *  section rather than beside a slot. */
export const AI_MODELS_ROLLING_BRIEF_ATTR =
  'data-recued-ai-models-rolling-brief';
export const AI_MODELS_CATALOG_GLOBAL_ATTR =
  'data-recued-ai-models-catalog-global';
/** D-174 R28 Slice A — the empty-state "add a source" jump button (Preference
 *  tab with zero configured sources → Providers). */
export const AI_MODELS_MODEL_PREF_EMPTY_JUMP_ATTR =
  'data-recued-ai-models-model-pref-empty-jump';
export const AI_MODELS_SLOT_SAVE_ATTR = 'data-recued-ai-models-slot-save';
export const AI_MODELS_SLOT_CLEAR_ATTR = 'data-recued-ai-models-slot-clear';
export const AI_MODELS_SLOT_CLEAR_DIALOG_ATTR =
  'data-recued-ai-models-slot-clear-dialog';
export const AI_MODELS_SLOT_CLEAR_CANCEL_ATTR =
  'data-recued-ai-models-slot-clear-cancel';
export const AI_MODELS_SLOT_CLEAR_CONFIRM_ATTR =
  'data-recued-ai-models-slot-clear-confirm';
export const AI_MODELS_SLOT_FIELD_ATTR = 'data-recued-ai-models-slot-field';
/** Test connection — one real request against the slot, reported in the form.
 *  Nothing else in the save path leaves the process, so this is the only place
 *  a wrong key / model / base_url can be caught at the moment it is typed. */
export const AI_MODELS_SLOT_TEST_ATTR = 'data-recued-ai-models-slot-test';
export const AI_MODELS_SLOT_TEST_RESULT_ATTR =
  'data-recued-ai-models-slot-test-result';
/** D-262 § B7 — the transcription probe's heard/expected pair. Named so a test
 *  can assert the transcript REACHES the page: the server has always returned
 *  it and the renderer dropped it, which is invisible to any test that only
 *  checks the verdict. */
export const AI_MODELS_PROBE_TRANSCRIPT_ATTR =
  'data-recued-ai-models-probe-transcript';
export const AI_MODELS_EMBEDDINGS_FIELD_ATTR =
  'data-recued-ai-models-embeddings-field';
/** D-262 § B1 — the transcription slot's fields, plus its language input. */
export const AI_MODELS_TRANSCRIPTION_FIELD_ATTR =
  'data-recued-ai-models-transcription-field';
/** D-262 follow-on — today's spend, rendered beside the cap that governs it. */
export const AI_MODELS_USAGE_ATTR = 'data-recued-ai-models-usage';
/** Per-source model context-window input. Values are `slot_1`, `slot_2`, or
 *  `free_pool:new` for the API-entry creation form. */
export const AI_MODELS_CONTEXT_WINDOW_INPUT_ATTR =
  'data-recued-ai-models-context-window-input';
export const AI_MODELS_POOL_TOGGLE_ATTR = 'data-recued-ai-models-pool-toggle';
export const AI_MODELS_POOL_ADD_ATTR = 'data-recued-ai-models-pool-add';
export const AI_MODELS_POOL_ADD_FIELD_ATTR =
  'data-recued-ai-models-pool-add-field';
export const AI_MODELS_BUDGET_SAVE_ATTR = 'data-recued-ai-models-budget-save';
export const AI_MODELS_BUDGET_INPUT_ATTR = 'data-recued-ai-models-budget-input';
export const AI_MODELS_ALLOW_BYOK_TOGGLE_ATTR =
  'data-recued-ai-models-allow-byok-toggle';
export const AI_MODELS_PAUSE_BUTTON_ATTR = 'data-recued-ai-models-pause';
// Lever-2 per-slot (Phase 3) — the per-source chat-catalog delivery-mode
// `<select>`. Its value is the source id (`slot_1` / `slot_2` / `free_pool`)
// so a test / host can locate the control for a given source.
export const AI_MODELS_CATALOG_MODE_SELECT_ATTR =
  'data-recued-ai-models-catalog-mode';
// Internal sub-view tab strip — splits the dense page into Preference /
// Providers / Usage so each surface gets a focused view rather than one
// long scroll (mirrors the Housekeeping panel's tab strip). Tab state is
// mount-local; all panels stay in the DOM and CSS toggles visibility off
// `data-active`.
export const AI_MODELS_TAB_ATTR = 'data-recued-ai-models-tab';
export const AI_MODELS_TAB_PANEL_ATTR = 'data-recued-ai-models-tab-panel';
export const AI_MODELS_PROMPT_SECTION_ATTR = 'data-recued-ai-models-prompt';
export const AI_MODELS_PROMPT_TEXT_ATTR = 'data-recued-ai-models-prompt-text';
export const AI_MODELS_PROMPT_SAVE_ATTR = 'data-recued-ai-models-prompt-save';
/** Client-only — drops the built-in into the editor as an UNSAVED draft. It is
 *  not the old server-side reset: `Load default` + `Save` is, because a save
 *  whose text equals the built-in sends `null` (see `saveLlmPrompt`). */
export const AI_MODELS_PROMPT_LOAD_DEFAULT_ATTR =
  'data-recued-ai-models-prompt-load-default';
/** Answers "is this box showing what is saved?" — the question the old card
 *  left the owner to guess at. */
export const AI_MODELS_PROMPT_STATUS_ATTR =
  'data-recued-ai-models-prompt-status';
/** Rendered ONLY when the wire role is off its default. The picker is gone from
 *  the card (it is a provider-compatibility hatch, not an authoring choice), and
 *  a setting with no control is stuck unless its non-default state announces
 *  itself and offers the way back. */
export const AI_MODELS_PROMPT_TRANSPORT_ATTR =
  'data-recued-ai-models-prompt-transport';
export const AI_MODELS_PROMPT_TRANSPORT_RESET_ATTR =
  'data-recued-ai-models-prompt-transport-reset';
export const AI_MODELS_PROMPT_BADGE_ATTR = 'data-recued-ai-models-prompt-badge';
export const AI_MODELS_PROMPT_POLICY_ATTR = 'data-recued-ai-models-prompt-policy';
export const AI_MODELS_PROMPT_POLICY_HINT_ATTR = 'data-recued-ai-models-prompt-policy-hint';
export const AI_MODELS_PROMPT_ALWAYS_ATTR = 'data-recued-ai-models-prompt-always';
/** Intent-specific first-run path reached from Chat when no source is
 * configured. It deliberately omits the dense four-tab manager. */
export const AI_MODELS_CHAT_SETUP_ATTR = 'data-recued-ai-models-chat-setup';
export const AI_MODELS_CHAT_SETUP_PROVIDER_ATTR =
  'data-recued-ai-models-chat-setup-provider';
export const AI_MODELS_CHAT_SETUP_MODEL_ATTR =
  'data-recued-ai-models-chat-setup-model';
export const AI_MODELS_CHAT_SETUP_KEY_ATTR =
  'data-recued-ai-models-chat-setup-key';
export const AI_MODELS_CHAT_SETUP_BASE_URL_ATTR =
  'data-recued-ai-models-chat-setup-base-url';
export const AI_MODELS_CHAT_SETUP_SOURCE_ATTR =
  'data-recued-ai-models-chat-setup-source';
export const AI_MODELS_CHAT_SETUP_SUBMIT_ATTR =
  'data-recued-ai-models-chat-setup-submit';
export const AI_MODELS_CHAT_SETUP_STATUS_ATTR =
  'data-recued-ai-models-chat-setup-status';
export const AI_MODELS_CHAT_SETUP_ERROR_ATTR =
  'data-recued-ai-models-chat-setup-error';
export const AI_MODELS_CHAT_SETUP_ADVANCED_ATTR =
  'data-recued-ai-models-chat-setup-advanced';

/** The AI / Models page's internal sub-views. */
/** ⚠ The tab ids are the SOURCE of the union, not a parallel list — so
 *  `totalRecord(AI_MODELS_TAB_IDS, …)` is total by construction. */
const AI_MODELS_TAB_IDS = ['preference', 'providers', 'prompts', 'usage'] as const;
type AiModelsTab = (typeof AI_MODELS_TAB_IDS)[number];
const AI_MODELS_TABS: ReadonlyArray<{ id: AiModelsTab; label: string }> = [
  { id: 'preference', label: 'Preference' },
  { id: 'providers', label: 'Providers' },
  { id: 'prompts', label: 'System prompts' },
  { id: 'usage', label: 'Usage & budget' },
];

const isAiModelsTab = (value: string | null): value is AiModelsTab =>
  AI_MODELS_TABS.some((tab) => tab.id === value);

type LlmConfigRecord = Record<string, unknown>;
type LlmSlotKey = 'slot_1' | 'slot_2';
type ClearableSlotKey = LlmSlotKey | 'embeddings_slot' | 'transcription_slot';
type LlmSlotRecord = Record<string, unknown>;
type FreePoolEntryRecord = Record<string, unknown>;

const MODEL_SOURCE_DISPLAY_NAME: Record<ChatModelSourceId, string> = {
  slot_1: 'Slot 1: fast',
  slot_2: 'Slot 2: quality / thinking',
  free_pool: 'Free pool',
};

const CLEARABLE_SLOT_DISPLAY_NAME: Record<ClearableSlotKey, string> = {
  slot_1: MODEL_SOURCE_DISPLAY_NAME.slot_1,
  slot_2: MODEL_SOURCE_DISPLAY_NAME.slot_2,
  embeddings_slot: 'Embeddings slot',
  transcription_slot: 'Transcription slot',
};

interface ByokSlotDraft {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  budget: string;
  contextWindow: string;
}

interface FreePoolAddDraft {
  id: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  contextWindow: string;
}

interface EmbeddingsSlotDraft {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

interface PoolFocusTarget {
  attr: typeof AI_MODELS_POOL_REMOVE_ATTR | typeof AI_MODELS_POOL_ADD_ATTR;
  value: string;
}

export type AiModelsInitialView = 'manage' | 'chat-setup';

type ChatSetupProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openai-compatible';

const CHAT_SETUP_PROVIDERS: ReadonlyArray<{
  id: ChatSetupProvider;
  label: string;
  suggestedModel: string;
  keyPlaceholder: string;
}> = [
  {
    id: 'openai',
    label: 'OpenAI',
    suggestedModel: 'gpt-4.1-mini',
    keyPlaceholder: 'sk-…',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    suggestedModel: 'claude-sonnet-4-6',
    keyPlaceholder: 'sk-ant-…',
  },
  {
    id: 'google',
    label: 'Google',
    suggestedModel: 'gemini-2.5-flash',
    keyPlaceholder: 'API key',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    suggestedModel: '',
    keyPlaceholder: 'API key',
  },
];

const isChatSetupProvider = (value: string): value is ChatSetupProvider =>
  CHAT_SETUP_PROVIDERS.some((provider) => provider.id === value);

const isChatSetupEndpointUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
};

export type AiModelsPageState = 'loading' | 'ready' | 'error';

export type ChatDefaultModelPrefGetCaller = () => Promise<{
  source_id: ChatModelSourceId | null;
  updated_at: number;
}>;

export type ChatDefaultModelPrefSetCaller = (args: {
  source_id: ChatModelSourceId;
}) => Promise<{
  source_id: ChatModelSourceId;
  updated_at: number;
}>;

export type AiModelsLlmConfigGetCaller = () => Promise<{
  config: LlmConfigRecord;
}>;

/** D-174 R28 — field-level write callers. Each edits ONE slot / pool
 *  entry server-side, so two surfaces editing different slots no longer
 *  clobber via the whole-config `setLLMConfig` blob (last-write-wins). */
export type AiModelsLlmSlotSetCaller = (args: {
  slot_key: LlmSlotKey;
  slot: LlmSlotRecord | null;
}) => Promise<{ ok: true }>;

/** D-174 R28 Slice C — write the dedicated embeddings slot. No `slot_key`
 *  (there is exactly one); a recipe/housekeeping source kept off the chat
 *  model-select surface. */
export type AiModelsEmbeddingsSlotSetCaller = (args: {
  slot: LlmSlotRecord | null;
}) => Promise<{ ok: true }>;

export type AiModelsFreePoolEntryUpsertCaller = (args: {
  entry: FreePoolEntryRecord;
}) => Promise<{ ok: true }>;

export type AiModelsFreePoolEntryRemoveCaller = (args: {
  id: string;
}) => Promise<{ ok: true; removed: boolean }>;

export type AiModelsFreePoolEntryEnabledCaller = (args: {
  id: string;
  enabled: boolean;
}) => Promise<{ ok: true; found: boolean }>;

/** Lever-2 per-slot (Phase 3) — set ONE LLM source's chat-catalog delivery
 *  mode (`full` | `index` | `lean-core`), or `null` to clear that source's
 *  override (falling back to the server's resolved default). Field-level
 *  read-modify-write server-side — never clobbers the other sources. */
export type AiModelsSetChatCatalogModeCaller = (args: {
  source_id: ChatModelSourceId;
  mode: ChatCatalogDeliveryMode | null;
}) => Promise<{ ok: true }>;

/** Read every surface's system prompt — the effective text + role AND the
 *  built-in default, so the editor can pre-fill with real text and offer a
 *  reset. */
export type AiModelsLlmPromptsGetCaller = () => Promise<{
  prompts: ReadonlyArray<ServerLlmPrompt>;
}>;

/** Test connection — send ONE real completion to a configured slot and report
 *  what came back. `slot` omitted probes what is saved; `slot` present probes
 *  the unsaved draft, which is the case that matters while you are typing.
 *
 *  ⚠ The draft carries the api_key ONLY when the owner just typed one — the
 *  stored key never reaches the client (redacted to `has_key`), so a blank key
 *  means "use the stored one" and the SERVER resolves it. */
export type AiModelsProbeTarget =
  | { kind: 'slot'; slot_key: ClearableSlotKey }
  | { kind: 'pool_entry'; entry_id: string };

export type AiModelsProbeSourceCaller = (args: {
  target: AiModelsProbeTarget;
  draft?: {
    provider: string;
    model: string;
    api_key?: string;
    base_url?: string;
    supports_json?: boolean;
  } | null;
}) => Promise<ServerLlmProbeResult>;

/** Replace one surface's system prompt + wire role. `null` on either clears it
 *  — that IS the reset-to-default, and the server restores the built-in
 *  byte-for-byte by deleting the row. */
export type AiModelsLlmPromptSetCaller = (args: {
  surface: ServerLlmPromptSurface;
  role_instructions: string | null;
  role: ServerLlmMessageRole | null;
  caller_system_policy?: ServerLlmCallerSystemPolicy | null;
}) => Promise<{ ok: true }>;

export type AiModelsConfigSchemaGetCaller = () => Promise<{
  schema: ReadonlyArray<ServerConfigField>;
}>;

export type AiModelsConfigFieldSetCaller = (args: {
  key: string;
  value: ServerConfigValue;
}) => Promise<{ ok: true }>;

export type AiModelsHousekeepingConfigReadCaller =
  () => Promise<HousekeepingConfigRow>;

export type AiModelsHousekeepingConfigWriteCaller = (args: {
  preset: HousekeepingConfigRow['preset'];
  allow_byok_background?: boolean;
  pause_background_ai_until?: number | null;
}) => Promise<{ ok: true; effective: HousekeepingConfigRow }>;

export interface MountAiModelsPageOptions {
  host: HTMLElement;
  document?: Document;
  /** Full settings manager by default. `chat-setup` is the focused first-run
   * journey reached from Chat's no-model affordances. */
  initialView?: AiModelsInitialView;
  /** Called only after the slot write AND default-source write have both been
   * confirmed. The shell uses it to return to Chat with a starter draft. */
  onChatSetupComplete?: () => void;
  /** Optional exact Chat destination for setup entered from an existing
   * thread. When absent, first-run setup keeps its normal Chat/start exits. */
  chatSetupReturnHref?: string;
  runGetDefaultModelPref?: ChatDefaultModelPrefGetCaller;
  runSetDefaultModelPref?: ChatDefaultModelPrefSetCaller;
  runGetLLMConfig?: AiModelsLlmConfigGetCaller;
  runSetLLMSlot?: AiModelsLlmSlotSetCaller;
  runSetEmbeddingsSlot?: AiModelsEmbeddingsSlotSetCaller;
  runSetTranscriptionSlot?: AiModelsEmbeddingsSlotSetCaller;
  runSetTranscriptionLanguage?: (args: { language: string | null }) => Promise<unknown>;
  runSetTranscriptionDailyRequests?: (args: { limit: number | null }) => Promise<unknown>;
  /** D-262 follow-on — today's spend per source. Absent ⇒ no usage lines
   *  render at all, rather than zeros that would read as "nothing spent". */
  runGetLLMUsage?: () => Promise<ServerLlmUsageResponse>;
  runUpsertFreePoolEntry?: AiModelsFreePoolEntryUpsertCaller;
  runRemoveFreePoolEntry?: AiModelsFreePoolEntryRemoveCaller;
  runSetFreePoolEntryEnabled?: AiModelsFreePoolEntryEnabledCaller;
  runSetChatCatalogMode?: AiModelsSetChatCatalogModeCaller;
  /** Global chat behaviour — the server-scoped rolling-brief enable.
   *  ⛔ SERVER-SCOPED, not per-source: `runChatTurn` holds no peer identity,
   *  so this changes what EVERY chat turn carries, on every model, including
   *  turns that arrive with no paired client at all. Absent ⇒ the control
   *  renders as loading rather than inventing a value. */
  runGetRollingBrief?: () => Promise<{ enabled: boolean }>;
  runSetRollingBrief?: (args: { enabled: boolean }) => Promise<{ enabled: boolean }>;
  runProbeLlmSource?: AiModelsProbeSourceCaller;
  runGetLlmPrompts?: AiModelsLlmPromptsGetCaller;
  runSetLlmPrompt?: AiModelsLlmPromptSetCaller;
  runGetConfigSchema?: AiModelsConfigSchemaGetCaller;
  runSetConfigField?: AiModelsConfigFieldSetCaller;
  runReadHousekeepingConfig?: AiModelsHousekeepingConfigReadCaller;
  runWriteHousekeepingConfig?: AiModelsHousekeepingConfigWriteCaller;
  runCacheStats?: LlmResultCacheStatsCaller;
  runCacheClear?: LlmResultCacheClearCaller;
  now?: () => number;
  subscribe?: BroadcastSubscriber['on'];
}

export interface AiModelsResolvedState {
  state: AiModelsPageState;
  modelPreference: ChatModelDefaultRenderModel;
  chatBehaviour: ChatBehaviourRenderModel;
  llmConfig: LlmConfigRecord | null;
  configSchema: ReadonlyArray<ServerConfigField>;
  housekeepingConfig: HousekeepingConfigRow | null;
  llmPrompts: ReadonlyArray<ServerLlmPrompt>;
  loadErrors: ReadonlyArray<string>;
  failLoud: string | null;
}

export interface AiModelsPageMount {
  getState(): AiModelsResolvedState;
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  /** True while any user-started AI configuration write is unresolved. */
  hasInFlightWork(): boolean;
  /** Set the global default to a configured source (slot id or `'free_pool'`,
   *  from the resolved model's options). Persists the source's layer + § A.14
   *  slot hint. */
  setModelPreference(sourceId: ChatModelSourceId): Promise<void>;
  saveByokSlot(slotKey: LlmSlotKey, patch: {
    provider: string;
    model: string;
    api_key?: string;
    base_url?: string;
    speed?: 'fast' | 'quality' | 'thinking';
    supports_json?: boolean;
    /** Per-slot daily token budget. 0 (or omitted) = unlimited; a
     *  positive value caps the slot's daily consumption. */
    daily_budget_tokens?: number;
    /** Provider/model context-window capacity. Persisted only when supplied as
     *  a positive safe integer; omission preserves the current slot value. */
    context_window_tokens?: number;
  }): Promise<void>;
  clearByokSlot(slotKey: LlmSlotKey): Promise<void>;
  /** D-174 R28 Slice C — save the dedicated embeddings slot (provider /
   *  model / key / base_url). Its `model` field is the embeddings model.
   *  A recipe/housekeeping source only — never a chat model-select option. */
  saveEmbeddingsSlot(patch: {
    provider: string;
    model: string;
    api_key?: string;
    base_url?: string;
  }): Promise<void>;
  clearEmbeddingsSlot(): Promise<void>;
  /** D-262 § B1 — the dedicated transcription source. Its `model` field is the
   *  TRANSCRIPTION model (`whisper-1`, `whisper-large-v3`, or a Gemini chat
   *  model, which transcribes itself). Never a chat model-select option. */
  saveTranscriptionSlot(patch: {
    provider: string;
    model: string;
    api_key?: string;
    base_url?: string;
  }): Promise<void>;
  clearTranscriptionSlot(): Promise<void>;
  /** D-262 § B6 — `null` clears back to auto-detect, which is the default and
   *  a meaningful state, not an unset one. */
  saveTranscriptionLanguage(language: string | null): Promise<void>;
  /** D-262 § B12.3 — daily cap in REQUESTS. `null` clears to unlimited. */
  saveTranscriptionDailyRequests(limit: number | null): Promise<void>;
  addFreePoolApiEntry(entry: {
    id: string;
    provider: string;
    model: string;
    api_key: string;
    base_url?: string;
    speed?: 'fast' | 'quality' | 'thinking';
    supports_json?: boolean;
    enabled?: boolean;
    /** Provider/model context-window capacity. Omitted unless supplied as a
     *  positive safe integer; there is no guessed provider default. */
    context_window_tokens?: number;
  }): Promise<void>;
  setFreePoolEntryEnabled(id: string, enabled: boolean): Promise<void>;
  /** D-174 R28 — remove a free-pool entry by id (the prior gap: pool was
   *  add + toggle only). */
  removeFreePoolEntry(id: string): Promise<void>;
  /** Lever-2 per-slot (Phase 3) — set a source's chat-catalog delivery mode,
   *  or `null` to clear the override (fall back to the server default). */
  setChatCatalogMode(
    source: ChatModelSourceId,
    mode: ChatCatalogDeliveryMode | null,
  ): Promise<void>;
  /** Write one surface's ROLE + INSTRUCTIONS (block 1) and — on the gateway —
   *  the caller-system policy. Block 1 only: Recued's core and feature text are
   *  composed around it and are not writable from here.
   *
   *  A blank box is read as a reset, AND SO IS ONE HOLDING THE BUILT-IN: both
   *  send `null`, because `null` is the only way the server expresses "default"
   *  and a byte-identical copy would badge as Customised and pin the text
   *  against future releases. The wire role rides through unchanged — the card
   *  has no editor for it, so a save must never re-assert one. */
  saveLlmPrompt(
    surface: ServerLlmPromptSurface,
    draft: PromptDraft,
  ): Promise<void>;
  /** Clear the override. The built-in comes back byte-for-byte — the server
   *  deletes the row, and absence IS the default. */
  resetLlmPrompt(surface: ServerLlmPromptSurface): Promise<void>;
  /** Put the wire role back to `system`, KEEPING the owner's instructions.
   *  The card's only remaining transport control, shown only when the role is
   *  already off-default — see {@link describeTransportRole}. */
  setPromptDeliveryRoleToDefault(
    surface: ServerLlmPromptSurface,
  ): Promise<void>;
  setBudget(tokens: number): Promise<void>;
  setAllowByokBackground(allow: boolean): Promise<void>;
  setPauseBackgroundAiUntil(until: number | null): Promise<void>;
  cacheCard(): LlmResultCacheCardMount | null;
  dispose(): void;
}

const CONTROL_COPY: Readonly<Record<string, { title: string; body: string }>> = {
  prompts: {
    title: 'System prompts',
    body: 'Pending backend support.',
  },
  byok: {
    title: 'BYOK slots',
    body: 'Fast and quality/thinking provider slots used when chat or runtime work selects BYOK.',
  },
  free_pool: {
    title: 'Free pool',
    body: 'Free-tier provider entries used before paid BYOK when policy allows it.',
  },
  model_pref: {
    title: 'Model preference',
    body: 'Global source every non-overridden chat session inherits.',
  },
  chat_behaviour: {
    title: 'Chat behaviour',
    body: 'Applies to every chat on this server, on every model — including chats started from Slack, Telegram or an external agent.',
  },
  embeddings: {
    title: 'Embeddings model',
    body: 'A dedicated provider + model for embeddings (semantic search / clustering), used by recipes and housekeeping — never chat. OpenAI-compatible is the common case (e.g. text-embedding-3-small, or a self-hosted endpoint via Base URL); Google works too. Anthropic publishes no embeddings model.',
  },
  cache: {
    title: 'LLM result cache',
    body: 'Deterministic short-circuit cache for repeated LLM results.',
  },
  ai_policy: {
    title: 'AI usage policy',
    body: 'Background BYOK permission and Pause-AI window.',
  },
  budget: {
    title: 'Instance token budget',
    body: 'Daily LLM token ceiling for this server instance.',
  },
} as const;

/** Lever-2 per-slot (Phase 3) — the catalog-mode `<select>` option labels
 *  (kept short; the full "what does this mean" copy lives in
 *  {@link CATALOG_MODE_LEGEND}). Keyed off the contracts enum so a new mode is a
 *  compile error here until it gets a label. */
const CATALOG_MODE_LABELS: Readonly<
  Record<ChatCatalogDeliveryMode, string>
> = {
  full: 'Full catalog',
  index: 'Index (lean list)',
  'lean-core': 'Lean core (search)',
};

/** One-word mode names for inline sentences (the "Automatic" hint). */
const CATALOG_MODE_SHORT: Readonly<Record<ChatCatalogDeliveryMode, string>> = {
  full: 'Full',
  index: 'Index',
  'lean-core': 'Lean core',
};

/** The plain-language "how to choose" explanation per mode, shown in the
 *  collapsible legend under the control. This is the answer to "what does each
 *  mode do and when do I want it". */
const CATALOG_MODE_LEGEND: Readonly<Record<ChatCatalogDeliveryMode, string>> = {
  full: 'Every tool is listed with its full input schema. Most reliable, largest prompt. Best for BYOK slots, where the prompt is cached and nearly free after the first call.',
  index: 'Tools are listed by name and summary; the model fetches a tool’s schema on demand. Big token savings with routing intact. Best for the free pool, which has no prompt cache.',
  'lean-core': 'Only the core tools are listed; the model searches to discover recipes. Biggest savings, best on capable models. Advanced.',
};

/** Test connection — what each verdict means, in the owner's terms.
 *
 *  🔑 Each line names the FIELD TO LOOK AT, not the HTTP status. "401
 *  Unauthorized" is the provider's framing of the problem; "the API key" is the
 *  owner's. The raw provider text is still shown underneath — someone debugging
 *  a self-hosted endpoint needs it, and paraphrasing hides the one detail that
 *  identifies the problem. */
const PROBE_VERDICT: Readonly<Record<ServerLlmProbeResult['diagnosis'], string>> = {
  ok: 'Connected.',
  auth: 'The API key was rejected. Check the key.',
  unreachable: 'Could not reach the endpoint. Check the Base URL, and that the server is running.',
  model_missing: 'The endpoint answered, but does not have that model. Check the Model.',
  rate_limited: 'The key works — the provider is rate-limiting it right now. Try again shortly.',
  // D-262 § B7 — ⛔ NOT a verdict about the slot. Nothing was sent, so nothing
  // was learned, and saying "connected" here would be a badge for a request
  // that never left the process.
  no_sample: 'This build has no sample audio, so the connection could not be tested. Your settings may still be correct.',
  provider_error: 'The key works — the provider is having trouble. Not your configuration.',
  rejected: 'The endpoint refused the request. See the detail below.',
};

/** Per-surface framing for the System prompts tab. The copy's job is to say WHO
 *  reads each block — the gateway one is read by strangers, and that single fact
 *  is what changes how you write it. */
const PROMPT_SURFACE_COPY: Readonly<Record<ServerLlmPromptSurface, {
  title: string;
  body: string;
}>> = {
  chat: {
    title: 'Chat',
    body: 'Read by your own chat and by messenger turns (Slack / Telegram). Set who the assistant is and what to check before it answers — "you are a lawyer", "always look at the calendar first".',
  },
  llm_gateway: {
    title: 'LLM gateway',
    body: 'Read on every request to your OpenAI-compatible gateway — by whoever holds a token, not by you. One block for the whole door. This is where you say what the door is FOR: Recued only fences the caller, it never tells the model what job it is doing.',
  },
};

/** The wire role is a TRANSPORT knob — it exists because some
 *  OpenAI-compatible endpoints (parts of the free pool, some reasoning models)
 *  reject a `system` role outright. It has NO picker on the card.
 *
 *  🔑 WHY IT LOST ITS `<select>`: its three options are spelled with the same
 *  three words as chat message roles, so a dropdown reading
 *  `system / user / assistant` beside a prompt box and a Save button says
 *  "choose which prompt you are writing" when it means "choose the envelope
 *  this one string ships in". The vocabulary lied about the job, and every
 *  richer presentation of it (tabs, one box per role) makes the misread
 *  stronger: there is ONE stored string per surface
 *  (`chat_role_instructions` / `llm_gateway_role_instructions`) delivered as
 *  ONE message (`chat-turn-executor.ts` / the gateway handler), never three.
 *
 *  ⚠ It is also under-designed WHERE IT SITS: the provider that rejects
 *  `system` is a property of the SLOT, but the role is stored per SURFACE — one
 *  chat surface can route to a slot that accepts `system` and a free-pool entry
 *  that does not, and a single surface-level value cannot be right for both. It
 *  belongs on the slot if it is ever re-exposed. */
const describeTransportRole = (role: ServerLlmMessageRole): string =>
  `Delivered to the model as a ${role} message, not a system message.`;

const CALLER_SYSTEM_POLICIES: ReadonlyArray<ServerLlmCallerSystemPolicy> = [
  'context',
  'append',
  'replace',
  'ignore',
];

const DEFAULT_CALLER_SYSTEM_POLICY: ServerLlmCallerSystemPolicy = 'context';

/** One surface's unsaved edits. `role_instructions` is BLOCK 1 — never the whole
 *  prompt; there is no client-side path to Recued's core or feature text. */
export interface PromptDraft {
  role_instructions: string;
  role: ServerLlmMessageRole;
  caller_system_policy: ServerLlmCallerSystemPolicy;
}

const CALLER_SYSTEM_POLICY_LABELS: Readonly<
  Record<ServerLlmCallerSystemPolicy, string>
> = {
  context: 'As context (default)',
  append: 'Add to yours',
  replace: 'Use instead of yours',
  ignore: 'Ignore it',
};

/** What each policy actually does, in the owner's terms. The trade the owner is
 *  really making on `replace` is their BEHAVIOURAL guardrails inside capability
 *  they already granted — say that plainly rather than leaving them to find out. */
const CALLER_SYSTEM_POLICY_HINTS: Readonly<
  Record<ServerLlmCallerSystemPolicy, string>
> = {
  context: "The customer's system prompt reaches the model as context. Your instructions win a conflict. Their app keeps working.",
  append: "The customer's system prompt is added to yours as real instructions. They can shape tone and task; they cannot remove your text.",
  replace: "The customer's system prompt is used instead of yours. They steer the model however they like within the tools you granted — your wording no longer applies.",
  ignore: "The customer's system prompt is dropped. The model never sees it, so anything their app configured there stops working.",
};

const stringifyError = (err: unknown): string =>
  humanizeRpcError(err);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const asPositiveSafeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;

const parsePositiveSafeInteger = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return asPositiveSafeInteger(Number(trimmed));
};

const cloneConfig = (config: LlmConfigRecord | null): LlmConfigRecord => {
  const source = config ?? {};
  const next: LlmConfigRecord = { ...source };
  for (const key of ['slot_1', 'slot_2', 'embeddings_slot', 'transcription_slot'] as const) {
    const slot = asRecord(source[key]);
    if (slot) next[key] = { ...slot };
  }
  const pool = Array.isArray(source.free_pool) ? source.free_pool : [];
  next.free_pool = pool.map((entry) => {
    const record = asRecord(entry);
    return record ? { ...record } : entry;
  });
  // Lever-2 per-slot (Phase 3) — the per-source catalog-mode map is a flat
  // `{source: mode}` object; copy it so a local edit (setChatCatalogMode)
  // never mutates a shared snapshot returned by getState().
  const catalogModes = asRecord(source.catalog_modes);
  if (catalogModes) next.catalog_modes = { ...catalogModes };
  return next;
};

const getSlot = (
  config: LlmConfigRecord | null,
  key: LlmSlotKey,
): LlmSlotRecord | null => asRecord(config?.[key]);

/** D-174 R28 Slice C — read the dedicated embeddings slot (a separate
 *  config key from slot_1 / slot_2). */
const getEmbeddingsSlot = (
  config: LlmConfigRecord | null,
): LlmSlotRecord | null => asRecord(config?.embeddings_slot);

const getPoolEntries = (
  config: LlmConfigRecord | null,
): FreePoolEntryRecord[] =>
  (Array.isArray(config?.free_pool) ? config!.free_pool : [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is FreePoolEntryRecord => entry !== null);

/** Lever-2 per-slot (Phase 3) — read a source's EXPLICIT catalog-mode
 *  override from the persisted `catalog_modes` map. Absent / malformed → the
 *  source has no override (the `<select>` shows "Automatic"). */
const getCatalogMode = (
  config: LlmConfigRecord | null,
  source: ChatModelSourceId,
): ChatCatalogDeliveryMode | undefined => {
  const modes = asRecord(config?.catalog_modes);
  const value = modes?.[source];
  return isChatCatalogDeliveryMode(value) ? value : undefined;
};

const findConfigField = (
  schema: ReadonlyArray<ServerConfigField>,
  key: string,
): ServerConfigField | null => schema.find((field) => field.key === key) ?? null;

const computeFailLoud = (
  pref: ChatModelDefaultRenderModel,
): string | null => {
  if (pref.kind !== 'resolved') return null;
  // The options ARE the configured sources, so an unmatched stored default
  // means the saved source was removed / is unavailable. Fail loud + prompt
  // the user to pick one (rather than silently routing somewhere else).
  return pref.matched
    ? null
    : 'No AI model is available for your current default. Choose a configured source above.';
};

const removeChildren = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

const appendText = (doc: Document, parent: HTMLElement, text: string): HTMLElement => {
  const span = doc.createElement('span');
  span.textContent = text;
  parent.appendChild(span);
  return span;
};

const appendHeading = (
  doc: Document,
  parent: HTMLElement,
  level: 'h3' | 'h4',
  text: string,
): HTMLElement => {
  const heading = doc.createElement(level);
  heading.textContent = text;
  parent.appendChild(heading);
  return heading;
};

const appendButton = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  onClick: () => void,
  attrs: ReadonlyArray<readonly [string, string]> = [],
): HTMLButtonElement => {
  const button = doc.createElement('button') as HTMLButtonElement;
  button.type = 'button';
  button.textContent = label;
  for (const [k, v] of attrs) button.setAttribute(k, v);
  button.addEventListener('click', onClick);
  parent.appendChild(button);
  return button;
};

const appendLink = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  href: string,
  attrs: ReadonlyArray<readonly [string, string]> = [],
): HTMLAnchorElement => {
  const link = doc.createElement('a') as HTMLAnchorElement;
  link.textContent = label;
  link.setAttribute('href', href);
  for (const [k, v] of attrs) link.setAttribute(k, v);
  parent.appendChild(link);
  return link;
};

const appendInput = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  value: string,
  attrs: ReadonlyArray<readonly [string, string]> = [],
): HTMLInputElement => {
  const wrap = doc.createElement('label');
  wrap.className = 'ai-models-field';
  appendText(doc, wrap, label);
  const input = doc.createElement('input') as HTMLInputElement;
  input.value = value;
  for (const [k, v] of attrs) input.setAttribute(k, v);
  wrap.appendChild(input);
  parent.appendChild(wrap);
  return input;
};

const markControl = (el: HTMLElement, id: string): void => {
  el.setAttribute(AI_MODELS_CONTROL_ATTR, id);
};

export const mountAiModelsPage = (
  opts: MountAiModelsPageOptions,
): AiModelsPageMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountAiModelsPage: no document available — pass `opts.document` for non-browser environments',
    );
  }

  let disposed = false;
  const chatSetupMode = opts.initialView === 'chat-setup';
  let state: AiModelsPageState = 'loading';
  // Mount-local active sub-view (the Preference / Providers / Usage tab).
  let aiTab: AiModelsTab = 'preference';
  // The raw global-default snapshot (a `source_id`); the rendered
  // `modelPreference` is DERIVED from it + the LLM config (the picker options
  // are the configured sources), recomputed whenever either changes.
  let modelPrefSnapshot:
    | { source_id: ChatModelSourceId | null; updated_at: number }
    | null = null;
  let llmConfig: LlmConfigRecord | null = null;
  let modelPreference: ChatModelDefaultRenderModel = buildChatModelDefaultModel(
    modelPrefSnapshot,
    llmConfig,
  );
  const recomputeModelPreference = (): void => {
    modelPreference = buildChatModelDefaultModel(modelPrefSnapshot, llmConfig);
  };
  // Global chat behaviour. The brief snapshot is its own read; the catalog
  // half is PROJECTED from `llmConfig`, so both recompute together whenever
  // either input moves.
  let rollingBriefSnapshot: { enabled: boolean } | null = null;
  let chatBehaviour: ChatBehaviourRenderModel = buildChatBehaviourModel(
    rollingBriefSnapshot,
    llmConfig,
  );
  const recomputeChatBehaviour = (): void => {
    chatBehaviour = buildChatBehaviourModel(rollingBriefSnapshot, llmConfig);
  };
  let configSchema: ServerConfigField[] = [];
  let housekeepingConfig: HousekeepingConfigRow | null = null;
  let llmPrompts: ServerLlmPrompt[] = [];
  /** In-flight edits, per surface, before Save. Kept out of `llmPrompts` (the
   *  server's truth) so a re-render never silently discards what the owner is
   *  mid-way through typing. */
  const promptDrafts = new Map<ServerLlmPromptSurface, PromptDraft>();
  const promptMutationPending = new Map<
    ServerLlmPromptSurface,
    'save' | 'reset' | 'transport'
  >();
  const byokSlotDrafts = new Map<LlmSlotKey, ByokSlotDraft>();
  // Test connection costs a real request against the owner's credential, so
  // it is single-flight per slot and never fires on its own.
  let slotProbePendingKey: string | null = null;
  const slotProbeResults = new Map<string, ServerLlmProbeResult>();
  let embeddingsSlotDraft: EmbeddingsSlotDraft | null = null;
  let transcriptionSlotDraft: EmbeddingsSlotDraft | null = null;
  let transcriptionLanguageDraft: string | null = null;
  let transcriptionCapDraft: string | null = null;
  /** D-262 follow-on — `null` until the read lands or if it fails. ⛔ A failed
   *  read renders NOTHING rather than zeros: "0 tokens today" and "we could
   *  not ask" look identical on screen and mean opposite things. */
  let llmUsage: ServerLlmUsageResponse | null = null;
  const freePoolAddDraft: FreePoolAddDraft = {
    id: '',
    provider: 'openai-compatible',
    model: '',
    apiKey: '',
    baseUrl: '',
    contextWindow: '',
  };
  const resetFreePoolAddDraft = (): void => {
    Object.assign(freePoolAddDraft, {
      id: '',
      provider: 'openai-compatible',
      model: '',
      apiKey: '',
      baseUrl: '',
      contextWindow: '',
    });
  };
  const poolTogglePendingTargets = new Map<string, boolean>();
  let freePoolAddPending = false;
  let poolRemoveDialogId: string | null = null;
  let poolRemovePending = false;
  let poolRemoveNeedsInitialFocus = false;
  let poolRemoveNeedsConfirmFocus = false;
  let poolFocusAfterRender: PoolFocusTarget | null = null;
  let poolRemoveFocusTrap: FocusTrapHandle | null = null;
  let renderedPoolRemovePanel: HTMLElement | null = null;
  let renderedPoolRemoveCancel: HTMLButtonElement | null = null;
  let renderedPoolRemoveConfirm: HTMLButtonElement | null = null;
  let slotClearDialogKey: ClearableSlotKey | null = null;
  let slotClearPendingKey: ClearableSlotKey | null = null;
  let slotClearNeedsInitialFocus = false;
  let slotClearNeedsConfirmFocus = false;
  let slotClearFocusAfterRender: ClearableSlotKey | null = null;
  let slotClearFocusTrap: FocusTrapHandle | null = null;
  let renderedSlotClearPanel: HTMLElement | null = null;
  let renderedSlotClearCancel: HTMLButtonElement | null = null;
  let renderedSlotClearConfirm: HTMLButtonElement | null = null;
  const focusRenderedPoolRemoveCancel = (): boolean => {
    const cancel = renderedPoolRemoveCancel as {
      focus?: (options?: FocusOptions) => void;
    } | null;
    if (cancel === null || typeof cancel.focus !== 'function') return false;
    cancel.focus({ preventScroll: true });
    return true;
  };
  const focusRenderedPoolRemoveConfirm = (): boolean => {
    const confirm = renderedPoolRemoveConfirm as {
      focus?: (options?: FocusOptions) => void;
    } | null;
    if (confirm === null || typeof confirm.focus !== 'function') return false;
    confirm.focus({ preventScroll: true });
    return true;
  };
  const focusRenderedSlotClearCancel = (): boolean => {
    const cancel = renderedSlotClearCancel as {
      focus?: (options?: FocusOptions) => void;
    } | null;
    if (cancel === null || typeof cancel.focus !== 'function') return false;
    cancel.focus({ preventScroll: true });
    return true;
  };
  const focusRenderedSlotClearConfirm = (): boolean => {
    const confirm = renderedSlotClearConfirm as {
      focus?: (options?: FocusOptions) => void;
    } | null;
    if (confirm === null || typeof confirm.focus !== 'function') return false;
    confirm.focus({ preventScroll: true });
    return true;
  };
  let budgetDraft: string | null = null;
  let budgetSavePending = false;
  let aiPolicyPendingAction: 'allow' | 'pause' | 'resume' | null = null;
  let catalogModePending: {
    source: ChatModelSourceId;
    mode: ChatCatalogDeliveryMode | null;
  } | null = null;
  let loadErrors: string[] = [];
  // D-174 R28 — last failed write action (cleared on the next success).
  // Most render-layer button handlers fire actions through `surface(...)`
  // so an unwired caller / rejected rpc shows as a banner instead of an
  // unhandled promise rejection.
  let actionError: string | null = null;
  let modelPreferencePendingId: ChatModelSourceId | null = null;
  let byokSlotSavePendingKey: LlmSlotKey | null = null;
  let embeddingsSlotSavePending = false;
  let transcriptionSlotSavePending = false;
  let chatSetupError: string | null = null;
  let chatSetupSubmitting = false;
  let chatSetupCompleted = false;
  let chatSetupExistingSourceId: ChatModelSourceId | null = null;
  let chatSetupFocusOwner: { attr: string; value: string } | null = null;
  const chatSetupDraft: {
    provider: ChatSetupProvider;
    model: string;
    apiKey: string;
    baseUrl: string;
  } = {
    provider: 'openai',
    model: CHAT_SETUP_PROVIDERS[0]!.suggestedModel,
    apiKey: '',
    baseUrl: '',
  };
  let pendingLoad: Promise<void> = Promise.resolve();

  const captureChatSetupFocusOwner = (): {
    attr: string;
    value: string;
  } | null => {
    const active = (doc as Partial<Document>).activeElement as
      | HTMLElement
      | null
      | undefined;
    if (active === null || active === undefined) return null;
    for (const attr of [
      AI_MODELS_CHAT_SETUP_PROVIDER_ATTR,
      AI_MODELS_CHAT_SETUP_MODEL_ATTR,
      AI_MODELS_CHAT_SETUP_KEY_ATTR,
      AI_MODELS_CHAT_SETUP_BASE_URL_ATTR,
      AI_MODELS_CHAT_SETUP_SOURCE_ATTR,
      AI_MODELS_CHAT_SETUP_SUBMIT_ATTR,
    ]) {
      const value = active.getAttribute?.(attr);
      if (value !== null && value !== undefined) return { attr, value };
    }
    return null;
  };

  const restoreChatSetupFocus = (
    element: HTMLElement,
    attr: string,
  ): void => {
    if (
      chatSetupFocusOwner?.attr !== attr
      || chatSetupFocusOwner.value !== element.getAttribute(attr)
    ) return;
    element.focus?.({ preventScroll: true });
  };

  const focusChatSetupProgress = (element: HTMLElement): void => {
    if (chatSetupFocusOwner === null) return;
    element.focus?.({ preventScroll: true });
  };

  /** Run a write action, surfacing failures as the action-error banner
   *  (and clearing a stale banner on success). */
  const surface = (p: Promise<unknown>): void => {
    void p.then(
      () => {
        if (disposed || actionError === null) return;
        actionError = null;
        render();
      },
      (err) => {
        if (disposed) return;
        actionError = stringifyError(err);
        render();
      },
    );
  };

  const wrapper = doc.createElement('div');
  wrapper.setAttribute(AI_MODELS_PAGE_ATTR, '');
  wrapper.setAttribute(AI_MODELS_PAGE_STATE_ATTR, state);
  wrapper.className = 'ai-models-page';
  const dynamicHost = doc.createElement('div');
  wrapper.appendChild(dynamicHost);
  opts.host.appendChild(wrapper);

  let cacheCard: LlmResultCacheCardMount | null = null;
  // Hoisted so `render()` can re-parent the persistent cache-card host
  // into the Usage tab panel each render (re-parent, not recreate — the
  // sub-mount's subscription + state survive). Left detached here; render
  // places it.
  let cacheHost: HTMLElement | null = null;
  if (!chatSetupMode && opts.runCacheStats !== undefined) {
    cacheHost = doc.createElement('div');
    cacheHost.setAttribute(AI_MODELS_CONTROL_ATTR, 'cache');
    cacheCard = mountLlmResultCacheCard({
      host: cacheHost,
      runStats: opts.runCacheStats,
      ...(opts.runCacheClear !== undefined ? { runClear: opts.runCacheClear } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
    });
  }

  const hasAiModelsInFlightWork = (): boolean =>
    !disposed
    && (
      promptMutationPending.size > 0
      || poolTogglePendingTargets.size > 0
      || freePoolAddPending
      || poolRemovePending
      || slotClearPendingKey !== null
      || budgetSavePending
      || aiPolicyPendingAction !== null
      || catalogModePending !== null
      || modelPreferencePendingId !== null
      || byokSlotSavePendingKey !== null
      || embeddingsSlotSavePending
      || chatSetupSubmitting
      || cacheCard?.hasInFlightWork() === true
    );

  const renderPending = (parent: HTMLElement, id: string): void => {
    const row = doc.createElement('div');
    row.className = 'ai-models-pending';
    row.setAttribute(AI_MODELS_PENDING_CONTROL_ATTR, id);
    appendHeading(doc, row, 'h4', CONTROL_COPY[id]?.title ?? id);
    appendText(doc, row, CONTROL_COPY[id]?.body ?? 'Pending backend support.');
    parent.appendChild(row);
  };

  const submitModelPreference = async (
    sourceId: ChatModelSourceId,
  ): Promise<void> => {
    if (disposed || modelPreferencePendingId !== null) return;
    modelPreferencePendingId = sourceId;
    actionError = null;
    render();
    try {
      await api.setModelPreference(sourceId);
      if (disposed) return;
      modelPreferencePendingId = null;
      render();
    } catch (err) {
      if (disposed) return;
      modelPreferencePendingId = null;
      actionError = stringifyError(err);
      render();
    }
  };

  const submitByokSlotSave = async (
    slotKey: LlmSlotKey,
    patch: Parameters<AiModelsPageMount['saveByokSlot']>[1],
  ): Promise<void> => {
    if (
      disposed
      || byokSlotSavePendingKey !== null
      || slotClearPendingKey !== null
    ) return;
    byokSlotSavePendingKey = slotKey;
    actionError = null;
    render();
    try {
      await api.saveByokSlot(slotKey, patch);
      if (disposed) return;
      byokSlotSavePendingKey = null;
      render();
    } catch (err) {
      if (disposed) return;
      byokSlotSavePendingKey = null;
      actionError = stringifyError(err);
      render();
    }
  };

  const submitEmbeddingsSlotSave = async (
    patch: Parameters<AiModelsPageMount['saveEmbeddingsSlot']>[0],
  ): Promise<void> => {
    if (
      disposed
      || embeddingsSlotSavePending
      || slotClearPendingKey !== null
    ) return;
    embeddingsSlotSavePending = true;
    actionError = null;
    render();
    try {
      await api.saveEmbeddingsSlot(patch);
      if (disposed) return;
      embeddingsSlotSavePending = false;
      render();
    } catch (err) {
      if (disposed) return;
      embeddingsSlotSavePending = false;
      actionError = stringifyError(err);
      render();
    }
  };

  const submitTranscriptionSlotSave = async (
    patch: Parameters<AiModelsPageMount['saveTranscriptionSlot']>[0],
  ): Promise<void> => {
    if (
      disposed
      || transcriptionSlotSavePending
      || slotClearPendingKey !== null
    ) return;
    transcriptionSlotSavePending = true;
    actionError = null;
    render();
    try {
      await api.saveTranscriptionSlot(patch);
      // ⚠ The siblings ride the SAME press. They are not fields on the slot,
      // but a person filling in one card should not have to find a second
      // button to make part of it take effect.
      if (transcriptionLanguageDraft !== null) {
        const trimmed = transcriptionLanguageDraft.trim();
        await api.saveTranscriptionLanguage(trimmed.length > 0 ? trimmed : null);
        transcriptionLanguageDraft = null;
      }
      if (transcriptionCapDraft !== null) {
        const trimmed = transcriptionCapDraft.trim();
        const parsed = trimmed.length > 0 ? Number(trimmed) : null;
        // ⛔ A non-numeric entry clears to unlimited rather than throwing: the
        // field is optional, and refusing the whole save because a cap was
        // mistyped would lose the slot edit the person actually came for.
        await api.saveTranscriptionDailyRequests(
          parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : null,
        );
        transcriptionCapDraft = null;
      }
      if (disposed) return;
      transcriptionSlotSavePending = false;
      render();
    } catch (err) {
      if (disposed) return;
      transcriptionSlotSavePending = false;
      actionError = stringifyError(err);
      render();
    }
  };

  const submitBudgetSave = async (tokens: number): Promise<void> => {
    if (disposed || budgetSavePending) return;
    budgetSavePending = true;
    actionError = null;
    render();
    try {
      await api.setBudget(tokens);
      if (disposed) return;
      budgetSavePending = false;
      render();
    } catch (err) {
      if (disposed) return;
      budgetSavePending = false;
      actionError = stringifyError(err);
      render();
    }
  };

  const submitPromptMutation = async (
    surface: ServerLlmPromptSurface,
    kind: 'save' | 'reset' | 'transport',
    run: () => Promise<void>,
  ): Promise<void> => {
    if (disposed || promptMutationPending.has(surface)) return;
    promptMutationPending.set(surface, kind);
    actionError = null;
    render();
    try {
      await run();
      if (disposed) return;
      promptMutationPending.delete(surface);
      render();
    } catch (err) {
      if (disposed) return;
      promptMutationPending.delete(surface);
      actionError = stringifyError(err);
      render();
    }
  };

  const submitAiPolicyMutation = async (
    action: 'allow' | 'pause' | 'resume',
    run: () => Promise<void>,
  ): Promise<void> => {
    if (disposed || aiPolicyPendingAction !== null) return;
    aiPolicyPendingAction = action;
    actionError = null;
    render();
    try {
      await run();
      if (disposed) return;
      aiPolicyPendingAction = null;
      render();
    } catch (err) {
      if (disposed) return;
      aiPolicyPendingAction = null;
      actionError = stringifyError(err);
      render();
    }
  };

  const submitCatalogMode = async (
    source: ChatModelSourceId,
    mode: ChatCatalogDeliveryMode | null,
  ): Promise<void> => {
    if (disposed || catalogModePending !== null) return;
    catalogModePending = { source, mode };
    actionError = null;
    render();
    try {
      await api.setChatCatalogMode(source, mode);
      if (disposed) return;
      catalogModePending = null;
      render();
    } catch (err) {
      if (disposed) return;
      catalogModePending = null;
      actionError = stringifyError(err);
      render();
    }
  };

  /** Global chat behaviour. ⛔ ITS OWN SECTION, NOT A PER-SLOT CONTROL. Both
   *  settings change what EVERY turn carries on EVERY model, including turns
   *  with no paired client at all; rendering them beside one slot invites an
   *  owner to set one and believe they have set all. */
  const renderChatBehaviour = (parent: HTMLElement): void => {
    const section = doc.createElement('section');
    markControl(section, 'chat_behaviour');
    appendHeading(doc, section, 'h3', CONTROL_COPY.chat_behaviour.title);
    appendText(doc, section, CONTROL_COPY.chat_behaviour.body);

    if (chatBehaviour.kind === 'loading') {
      // ⛔ NOT a default-off render: the read may simply not have landed, and
      //   showing "off" for "unknown" misreports the server.
      appendText(doc, section, ' Loading chat behaviour.');
      parent.appendChild(section);
      return;
    }

    const brief = chatBehaviour.rolling_brief;
    appendText(
      doc,
      section,
      brief
        ? ' Carrying a running brief across turns. Only the last few messages stay in view otherwise, so anything you said that no tool can look up would be lost.'
        : ' Not carrying a brief. Anything you said that no tool can look up is lost once it scrolls out of the last few messages.',
    );
    const briefButton = appendButton(
      doc,
      section,
      rollingBriefPending
        ? 'Saving…'
        : brief
          ? 'Turn off running brief'
          : 'Turn on running brief',
      () => {
        void submitRollingBrief(!brief);
      },
      [
        [AI_MODELS_ROLLING_BRIEF_ATTR, brief ? 'on' : 'off'],
        ['aria-pressed', brief ? 'true' : 'false'],
      ],
    );
    if (rollingBriefPending) briefButton.setAttribute('aria-busy', 'true');

    const catalog = doc.createElement('p');
    catalog.setAttribute(AI_MODELS_CATALOG_GLOBAL_ATTR, chatBehaviour.catalog_mode);
    catalog.textContent = `Tool catalog: ${CHAT_CATALOG_MODE_LABELS[chatBehaviour.catalog_mode]}`;
    section.appendChild(catalog);
    if (chatBehaviour.catalog_mode === 'mixed') {
      // A 'mixed' value is not an error, but it IS the one state an owner
      // cannot act on without knowing which source differs.
      appendText(
        doc,
        section,
        ` Per-model overrides differ: ${chatBehaviour.catalog_by_source
          .map((b) => `${b.source_id} → ${b.mode}`)
          .join(', ')}. Clear them on Providers to return to one setting.`,
      );
    }
    parent.appendChild(section);
  };

  const renderModelPreference = (parent: HTMLElement): void => {
    const section = doc.createElement('section');
    markControl(section, 'model_pref');
    appendHeading(doc, section, 'h3', CONTROL_COPY.model_pref.title);
    appendText(doc, section, CONTROL_COPY.model_pref.body);

    if (modelPreference.kind === 'loading') {
      appendText(doc, section, ' Loading current preference.');
    } else if (modelPreference.kind === 'empty') {
      // D-174 R28 Slice A defect fix — resolved-EMPTY (no configured source) is
      // NOT a transient load. Tell the user + jump to Providers (the Preference
      // tab is inert until a source exists there).
      appendText(
        doc,
        section,
        ' No model sources yet — add a BYOK slot or a free-pool entry.',
      );
      appendButton(
        doc,
        section,
        'Add a model source',
        () => {
          setAiTab('providers');
        },
        [[AI_MODELS_MODEL_PREF_EMPTY_JUMP_ATTR, '']],
      );
    } else {
      const optionsWrap = doc.createElement('div');
      optionsWrap.className = 'ai-models-choice-row';
      for (const option of modelPreference.options) {
        const pendingThis = modelPreferencePendingId === option.id;
        const button = appendButton(
          doc,
          optionsWrap,
          pendingThis
            ? `Selecting ${option.label}…`
            : `${option.selected ? 'Selected: ' : ''}${option.label}`,
          () => {
            void submitModelPreference(option.id);
          },
          [
            [AI_MODELS_MODEL_PREF_BUTTON_ATTR, option.id],
            ['aria-pressed', option.selected ? 'true' : 'false'],
          ],
        );
        if (modelPreferencePendingId !== null) {
          button.setAttribute('aria-disabled', 'true');
        }
        if (pendingThis) button.setAttribute('aria-busy', 'true');
      }
      section.appendChild(optionsWrap);
    }

    const fail = computeFailLoud(modelPreference);
    if (fail !== null) {
      const alert = doc.createElement('div');
      alert.setAttribute(AI_MODELS_FAIL_LOUD_ATTR, '');
      alert.textContent = fail;
      section.appendChild(alert);
    }
    parent.appendChild(section);
  };

  // Lever-2 per-slot (Phase 3) — the per-source chat-catalog delivery-mode
  // control. Gated on `runSetChatCatalogMode`: with no setter wired the
  // control is omitted (the mode stays the server default). Renders an
  // instant-apply `<select>` whose selection is the source's EXPLICIT
  // override, or "Automatic" when unset. The Automatic hint states the SHIPPED
  // default (CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE — the same map the server
  // resolver reads, so the two can't drift); it says "uses", not "always",
  // because an operator CAN override it server-side (`=0` opt-out or an
  // env-global mode), which the webclient can't read.
  const renderCatalogModeControl = (
    parent: HTMLElement,
    source: ChatModelSourceId,
  ): void => {
    if (!opts.runSetChatCatalogMode) return;
    const current = getCatalogMode(llmConfig, source);
    const wrap = doc.createElement('label');
    wrap.className = 'ai-models-field';
    appendText(doc, wrap, 'Chat tool catalog');
    const select = doc.createElement('select') as HTMLSelectElement;
    select.setAttribute(AI_MODELS_CATALOG_MODE_SELECT_ATTR, source);
    select.setAttribute(
      'aria-label',
      `${MODEL_SOURCE_DISPLAY_NAME[source]} chat tool catalog`,
    );
    const autoOption = doc.createElement('option') as HTMLOptionElement;
    autoOption.value = '';
    autoOption.textContent = 'Automatic (recommended)';
    select.appendChild(autoOption);
    for (const mode of CHAT_CATALOG_DELIVERY_MODES) {
      const option = doc.createElement('option') as HTMLOptionElement;
      option.value = mode;
      option.textContent = CATALOG_MODE_LABELS[mode];
      select.appendChild(option);
    }
    // Setting `.value` selects the matching <option> in a real browser (and
    // is a plain field in the test's fake DOM). An unset override → the
    // empty-valued Automatic option.
    const renderedValue = catalogModePending?.source === source
      ? catalogModePending.mode
      : current;
    select.value = renderedValue ?? '';
    if (catalogModePending !== null) {
      select.setAttribute('aria-disabled', 'true');
      if (catalogModePending.source === source) {
        select.setAttribute('aria-busy', 'true');
      }
    }
    select.addEventListener('change', () => {
      if (catalogModePending !== null) {
        const ownedValue = catalogModePending.source === source
          ? catalogModePending.mode
          : current;
        select.value = ownedValue ?? '';
        return;
      }
      // Empty value → clear the override (Automatic, `null`); a known mode
      // sets it. A stray non-mode value falls back to a clear, never a throw.
      const mode = isChatCatalogDeliveryMode(select.value) ? select.value : null;
      void submitCatalogMode(source, mode);
    });
    wrap.appendChild(select);
    parent.appendChild(wrap);
    // Per-source hint: what "Automatic" resolves to HERE (the shipped default),
    // so the recommended choice is legible without opening the legend.
    const autoMode = CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE[source];
    const sourceWord = source === 'free_pool' ? 'the free pool' : 'a BYOK slot';
    const hint = doc.createElement('span');
    hint.className = 'ai-models-hint';
    hint.textContent =
      `Applies immediately. Automatic uses ${CATALOG_MODE_SHORT[autoMode]} for ${sourceWord}.`;
    parent.appendChild(hint);
    // A collapsed "how to choose" legend explaining each mode. Native
    // <details> — no JS, low visual noise closed, full copy on demand.
    const legend = doc.createElement('details');
    legend.className = 'ai-models-mode-legend';
    const summary = doc.createElement('summary');
    summary.textContent = 'What do these modes mean?';
    legend.appendChild(summary);
    const dl = doc.createElement('dl');
    for (const mode of CHAT_CATALOG_DELIVERY_MODES) {
      const dt = doc.createElement('dt');
      dt.textContent = CATALOG_MODE_LABELS[mode];
      dl.appendChild(dt);
      const dd = doc.createElement('dd');
      dd.textContent = CATALOG_MODE_LEGEND[mode];
      dl.appendChild(dd);
    }
    legend.appendChild(dl);
    parent.appendChild(legend);
  };

  const renderSlot = (parent: HTMLElement, slotKey: LlmSlotKey): void => {
    const slot = getSlot(llmConfig, slotKey);
    const savingThis = byokSlotSavePendingKey === slotKey;
    const clearingThis = slotClearPendingKey === slotKey;
    const budgetRaw = slot?.daily_budget_tokens;
    const draft = byokSlotDrafts.get(slotKey) ?? {
      provider: asString(slot?.provider),
      model: asString(slot?.model),
      baseUrl: asString(slot?.base_url),
      apiKey: '',
      budget:
        typeof budgetRaw === 'number' && budgetRaw > 0 ? String(budgetRaw) : '',
      contextWindow:
        asPositiveSafeInteger(slot?.context_window_tokens)?.toString() ?? '',
    };
    const fieldId = (field: string): string => `${slotKey}:${field}`;
    const title = MODEL_SOURCE_DISPLAY_NAME[slotKey];
    const card = doc.createElement('div');
    card.className = 'ai-models-slot';
    card.setAttribute(AI_MODELS_CONTROL_ATTR, slotKey);
    appendHeading(doc, card, 'h4', title);
    renderUsageLine(card, slotKey);
    appendText(
      doc,
      card,
      slot
        ? ` ${asString(slot.provider) || 'provider?'} / ${asString(slot.model) || 'model?'}`
        : ' Not configured.',
    );
    const provider = appendInput(doc, card, 'Provider', draft.provider, [
      [AI_MODELS_SLOT_FIELD_ATTR, fieldId('provider')],
      ['aria-label', `${title} provider`],
    ]);
    const model = appendInput(doc, card, 'Model', draft.model, [
      [AI_MODELS_SLOT_FIELD_ATTR, fieldId('model')],
      ['aria-label', `${title} model`],
    ]);
    const baseUrl = appendInput(doc, card, 'Base URL', draft.baseUrl, [
      [AI_MODELS_SLOT_FIELD_ATTR, fieldId('base-url')],
      ['aria-label', `${title} base URL`],
    ]);
    const apiKey = appendInput(
      doc,
      card,
      'API key',
      draft.apiKey,
      [
        ['placeholder', slot?.has_key === true ? 'Leave blank to keep existing key' : 'Required'],
        [AI_MODELS_SLOT_FIELD_ATTR, fieldId('api-key')],
        ['aria-label', `${title} API key`],
      ],
    );
    // The key never round-trips to the browser (the server redacts it to
    // `has_key`); mask the field so a typed-but-unsaved key isn't shoulder-
    // surfed, and leaving it blank preserves the stored key server-side.
    apiKey.type = 'password';
    // Per-slot daily token budget (D-079/D-094, reinstated). Blank / 0 =
    // unlimited; over budget, the slot stops matching until the next daily
    // reset (enforced in the LLM match layer).
    const budget = appendInput(
      doc,
      card,
      'Daily token budget',
      draft.budget,
      [
        ['placeholder', 'Blank = unlimited'],
        ['inputmode', 'numeric'],
        [AI_MODELS_SLOT_FIELD_ATTR, fieldId('daily-budget')],
        ['aria-label', `${title} daily token budget`],
      ],
    );
    budget.type = 'number';
    const contextWindow = appendInput(
      doc,
      card,
      'Context window (tokens)',
      draft.contextWindow,
      [
        [AI_MODELS_CONTEXT_WINDOW_INPUT_ATTR, slotKey],
        [AI_MODELS_SLOT_FIELD_ATTR, fieldId('context-window')],
        ['placeholder', 'e.g. 128000'],
        ['inputmode', 'numeric'],
        ['min', '1'],
        ['step', '1'],
        ['aria-label', `${title} context window (tokens)`],
      ],
    );
    contextWindow.type = 'number';
    const syncDraft = (): void => {
      byokSlotDrafts.set(slotKey, {
        provider: provider.value,
        model: model.value,
        baseUrl: baseUrl.value,
        apiKey: apiKey.value,
        budget: budget.value,
        contextWindow: contextWindow.value,
      });
    };
    for (const input of [
      provider,
      model,
      baseUrl,
      apiKey,
      budget,
      contextWindow,
    ]) {
      input.addEventListener('input', syncDraft);
      if (savingThis || clearingThis) input.readOnly = true;
    }
    const save = appendButton(
      doc,
      card,
      savingThis ? 'Saving slot…' : 'Save slot',
      () => {
        const budgetNum = Number(budget.value);
        const contextWindowTokens = parsePositiveSafeInteger(contextWindow.value);
        void submitByokSlotSave(slotKey, {
          provider: provider.value,
          model: model.value,
          ...(apiKey.value.trim().length > 0 ? { api_key: apiKey.value } : {}),
          base_url: baseUrl.value,
          daily_budget_tokens:
            budget.value.trim().length > 0 && Number.isFinite(budgetNum) && budgetNum > 0
              ? budgetNum
              : 0,
          ...(contextWindowTokens !== undefined
            ? { context_window_tokens: contextWindowTokens }
            : {}),
        });
      },
      [
        [AI_MODELS_SLOT_SAVE_ATTR, slotKey],
        ['aria-label', `Save ${title}`],
      ],
    );
    if (
      byokSlotSavePendingKey !== null
      || slotClearPendingKey !== null
    ) {
      save.setAttribute('aria-disabled', 'true');
    }
    if (savingThis) save.setAttribute('aria-busy', 'true');
    const clear = appendButton(
      doc,
      card,
      'Clear slot',
      () => {
        if (
          byokSlotSavePendingKey !== null
          || slotClearPendingKey !== null
        ) return;
        actionError = null;
        slotClearDialogKey = slotKey;
        slotClearNeedsInitialFocus = true;
        slotClearNeedsConfirmFocus = false;
        render();
      },
      [
        [AI_MODELS_SLOT_CLEAR_ATTR, slotKey],
        ['aria-label', `Clear ${title}`],
      ],
    );
    if (
      byokSlotSavePendingKey !== null
      || slotClearPendingKey !== null
    ) {
      clear.setAttribute('aria-disabled', 'true');
    }
    renderProbeControls(
      card,
      slotKey,
      title,
      { kind: 'slot', slot_key: slotKey },
      () => ({
        provider: provider.value,
        model: model.value,
        // Blank = "use the stored key". The client never HAD the stored key to
        // send, so the server resolves it — see the caller doc.
        ...(apiKey.value.length > 0 ? { api_key: apiKey.value } : {}),
        ...(baseUrl.value.length > 0 ? { base_url: baseUrl.value } : {}),
      }),
    );
    // Instant-apply per-source catalog-mode control (distinct from the
    // Save-gated slot fields above), placed after the buttons so it reads
    // as its own control.
    renderCatalogModeControl(card, slotKey);
    parent.appendChild(card);
  };

  /** Run one probe and land its verdict in the card.
   *
   *  ⚠ Never throws to the caller. A failed connection is the RESULT the owner
   *  asked for — routing it to the page's `actionError` banner would file it
   *  next to "couldn't save your settings", which is a different kind of
   *  problem with a different fix. Only a transport failure (the rpc itself
   *  could not be made) belongs in the banner. */
  const submitSlotProbe = async (
    resultKey: string,
    target: AiModelsProbeTarget,
    draft?: {
      provider: string;
      model: string;
      api_key?: string;
      base_url?: string;
    },
  ): Promise<void> => {
    if (disposed || slotProbePendingKey !== null || !opts.runProbeLlmSource) return;
    slotProbePendingKey = resultKey;
    actionError = null;
    slotProbeResults.delete(resultKey);
    render();
    try {
      const result = await opts.runProbeLlmSource({
        target,
        // A pool row has no editable fields (add/remove, not edit), so it sends
        // no draft and the server probes exactly what is stored.
        ...(draft !== undefined ? { draft } : {}),
      });
      if (disposed) return;
      slotProbeResults.set(resultKey, result);
    } catch (err) {
      if (disposed) return;
      actionError = stringifyError(err);
    } finally {
      if (!disposed) {
        slotProbePendingKey = null;
        render();
      }
    }
  };

  const closeSlotClearDialog = (): void => {
    const slotKey = slotClearDialogKey;
    if (slotKey === null || slotClearPendingKey !== null) return;
    slotClearDialogKey = null;
    slotClearNeedsInitialFocus = false;
    slotClearNeedsConfirmFocus = false;
    slotClearFocusAfterRender = slotKey;
    render();
  };

  const submitSlotClear = async (): Promise<void> => {
    const slotKey = slotClearDialogKey;
    if (
      disposed
      || slotKey === null
      || slotClearPendingKey !== null
      || (slotKey === 'embeddings_slot'
        ? embeddingsSlotSavePending
        : slotKey === 'transcription_slot'
          ? transcriptionSlotSavePending
          : byokSlotSavePendingKey !== null)
    ) return;
    slotClearPendingKey = slotKey;
    actionError = null;
    render();
    try {
      if (slotKey === 'embeddings_slot') {
        await api.clearEmbeddingsSlot();
      } else if (slotKey === 'transcription_slot') {
        await api.clearTranscriptionSlot();
      } else {
        await api.clearByokSlot(slotKey);
      }
      if (disposed) return;
      slotClearPendingKey = null;
      slotClearDialogKey = null;
      slotClearNeedsInitialFocus = false;
      slotClearNeedsConfirmFocus = false;
      slotClearFocusAfterRender = slotKey;
      render();
    } catch (err) {
      if (disposed) return;
      slotClearPendingKey = null;
      actionError = stringifyError(err);
      slotClearNeedsConfirmFocus = true;
      render();
    }
  };

  const renderSlotClearDialog = (parent: HTMLElement): void => {
    const slotKey = slotClearDialogKey;
    if (slotKey === null) return;
    const clearingThis = slotClearPendingKey === slotKey;
    const slotLabel = CLEARABLE_SLOT_DISPLAY_NAME[slotKey];
    const titleId = `recued-ai-models-${slotKey}-clear-title`;
    const bodyId = `recued-ai-models-${slotKey}-clear-body`;

    const overlay = doc.createElement('div');
    overlay.className = 'ai-models-confirm-overlay';
    const panel = doc.createElement('div');
    panel.className = 'ai-models-confirm-dialog';
    panel.setAttribute(AI_MODELS_SLOT_CLEAR_DIALOG_ATTR, slotKey);
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', titleId);
    panel.setAttribute('aria-describedby', bodyId);
    panel.setAttribute('tabindex', '-1');
    if (clearingThis) panel.setAttribute('aria-busy', 'true');

    const title = appendHeading(doc, panel, 'h4', `Clear ${slotLabel}?`);
    title.setAttribute('id', titleId);
    const body = doc.createElement('p');
    body.setAttribute('id', bodyId);
    body.textContent =
      'This removes the saved provider settings and API key from this Recued server. '
      + 'You will need to enter them again to restore this slot.';
    panel.appendChild(body);
    if (actionError !== null) {
      const error = doc.createElement('p');
      error.className = 'ai-models-confirm-error';
      error.setAttribute('role', 'alert');
      error.textContent = actionError;
      panel.appendChild(error);
    }

    const actions = doc.createElement('div');
    actions.className = 'ai-models-confirm-actions';
    const cancel = appendButton(
      doc,
      actions,
      'Cancel',
      closeSlotClearDialog,
      [[AI_MODELS_SLOT_CLEAR_CANCEL_ATTR, slotKey]],
    );
    const confirm = appendButton(
      doc,
      actions,
      clearingThis ? 'Clearing slot…' : 'Clear slot',
      () => {
        void submitSlotClear();
      },
      [[AI_MODELS_SLOT_CLEAR_CONFIRM_ATTR, slotKey]],
    );
    if (clearingThis) {
      cancel.setAttribute('aria-disabled', 'true');
      confirm.setAttribute('aria-disabled', 'true');
      confirm.setAttribute('aria-busy', 'true');
    }
    panel.appendChild(actions);
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || clearingThis) return;
      event.preventDefault();
      event.stopPropagation();
      closeSlotClearDialog();
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeSlotClearDialog();
    });
    overlay.appendChild(panel);
    parent.appendChild(overlay);
    renderedSlotClearPanel = panel;
    renderedSlotClearCancel = cancel;
    renderedSlotClearConfirm = confirm;
  };

  // D-174 R28 Slice C — the dedicated embeddings slot card. Mirrors a BYOK
  // slot card (provider / model / key / base_url) but with NO daily-budget
  // or speed fields (embeddings has no tier ladder / budget cutoff), and it
  // routes to the embeddings-only setter. Lives in the Providers tab — it is
  // NOT a chat model-select option (embeddings is recipe/housekeeping-only).
  const renderEmbeddingsSlot = (parent: HTMLElement): void => {
    const section = doc.createElement('section');
    markControl(section, 'embeddings');
    appendHeading(doc, section, 'h3', CONTROL_COPY.embeddings.title);
    appendText(doc, section, CONTROL_COPY.embeddings.body);
    if (!opts.runGetLLMConfig || !opts.runSetEmbeddingsSlot) {
      renderPending(section, 'embeddings');
      parent.appendChild(section);
      return;
    }
    const slot = getEmbeddingsSlot(llmConfig);
    const clearingThis = slotClearPendingKey === 'embeddings_slot';
    const draft = embeddingsSlotDraft ?? {
      provider: asString(slot?.provider),
      model: asString(slot?.model),
      baseUrl: asString(slot?.base_url),
      apiKey: '',
    };
    const card = doc.createElement('div');
    card.className = 'ai-models-slot';
    card.setAttribute(AI_MODELS_CONTROL_ATTR, 'embeddings_slot');
    appendHeading(doc, card, 'h4', 'Embeddings slot');
    renderUsageLine(card, 'embeddings_slot');
    appendText(
      doc,
      card,
      slot
        ? ` ${asString(slot.provider) || 'provider?'} / ${asString(slot.model) || 'model?'}`
        : ' Not configured.',
    );
    const provider = appendInput(doc, card, 'Provider', draft.provider, [
      [AI_MODELS_EMBEDDINGS_FIELD_ATTR, 'provider'],
      ['aria-label', 'Embeddings slot provider'],
    ]);
    const model = appendInput(
      doc,
      card,
      'Model',
      draft.model,
      [
        ['placeholder', 'e.g. text-embedding-3-small'],
        [AI_MODELS_EMBEDDINGS_FIELD_ATTR, 'model'],
        ['aria-label', 'Embeddings slot model'],
      ],
    );
    const baseUrl = appendInput(doc, card, 'Base URL', draft.baseUrl, [
      [AI_MODELS_EMBEDDINGS_FIELD_ATTR, 'base-url'],
      ['aria-label', 'Embeddings slot base URL'],
    ]);
    const apiKey = appendInput(
      doc,
      card,
      'API key',
      draft.apiKey,
      [
        ['placeholder', slot?.has_key === true ? 'Leave blank to keep existing key' : 'Required'],
        [AI_MODELS_EMBEDDINGS_FIELD_ATTR, 'api-key'],
        ['aria-label', 'Embeddings slot API key'],
      ],
    );
    // Same handling as the BYOK card: the key never round-trips (server
    // redacts to `has_key`), so mask it; leaving it blank keeps the stored key.
    apiKey.type = 'password';
    const syncDraft = (): void => {
      embeddingsSlotDraft = {
        provider: provider.value,
        model: model.value,
        baseUrl: baseUrl.value,
        apiKey: apiKey.value,
      };
    };
    for (const input of [provider, model, baseUrl, apiKey]) {
      input.addEventListener('input', syncDraft);
      if (embeddingsSlotSavePending || clearingThis) input.readOnly = true;
    }
    const save = appendButton(
      doc,
      card,
      embeddingsSlotSavePending ? 'Saving slot…' : 'Save slot',
      () => {
        void submitEmbeddingsSlotSave({
          provider: provider.value,
          model: model.value,
          ...(apiKey.value.trim().length > 0 ? { api_key: apiKey.value } : {}),
          base_url: baseUrl.value,
        });
      },
      [
        [AI_MODELS_SLOT_SAVE_ATTR, 'embeddings_slot'],
        ['aria-label', 'Save Embeddings slot'],
      ],
    );
    const clear = appendButton(
      doc,
      card,
      'Clear slot',
      () => {
        if (embeddingsSlotSavePending || slotClearPendingKey !== null) return;
        actionError = null;
        slotClearDialogKey = 'embeddings_slot';
        slotClearNeedsInitialFocus = true;
        slotClearNeedsConfirmFocus = false;
        render();
      },
      [
        [AI_MODELS_SLOT_CLEAR_ATTR, 'embeddings_slot'],
        ['aria-label', 'Clear Embeddings slot'],
      ],
    );
    if (embeddingsSlotSavePending || slotClearPendingKey !== null) {
      save.setAttribute('aria-disabled', 'true');
      clear.setAttribute('aria-disabled', 'true');
    }
    if (embeddingsSlotSavePending) save.setAttribute('aria-busy', 'true');
    // ⚠ Same button, DIFFERENT probe on the far side: the server sends an
    // `embed` call through the embeddings registry, not a chat completion.
    // What comes back is the vector width, not the chat capability facts.
    renderProbeControls(
      card,
      'embeddings_slot',
      'Embeddings slot',
      { kind: 'slot', slot_key: 'embeddings_slot' },
      () => ({
        provider: provider.value,
        model: model.value,
        ...(apiKey.value.trim().length > 0 ? { api_key: apiKey.value } : {}),
        ...(baseUrl.value.length > 0 ? { base_url: baseUrl.value } : {}),
      }),
    );
    parent.appendChild(card);
  };

  /** D-262 § B1 — the transcription card. Mirrors the embeddings card because
   *  it IS the same shape: one dedicated source, its `model` field carrying the
   *  domain model, never a chat model-select option.
   *
   *  ⚠ `Base URL` is the load-bearing field here, not an advanced extra: it is
   *  what lets a server on a Pi point at a remote endpoint and a server with a
   *  GPU point at a local `whisper.cpp`. */
  const renderTranscriptionSlot = (parent: HTMLElement): void => {
    if (!opts.runGetLLMConfig || !opts.runSetTranscriptionSlot) return;
    const slot = asRecord(llmConfig?.transcription_slot);
    const clearingThis = slotClearPendingKey === 'transcription_slot';
    const draft = transcriptionSlotDraft ?? {
      provider: asString(slot?.provider),
      model: asString(slot?.model),
      baseUrl: asString(slot?.base_url),
      apiKey: '',
    };
    const card = doc.createElement('div');
    card.className = 'ai-models-slot';
    card.setAttribute(AI_MODELS_CONTROL_ATTR, 'transcription_slot');
    appendHeading(doc, card, 'h4', 'Transcription slot');
    renderUsageLine(card, 'transcription_slot');
    appendText(
      doc,
      card,
      slot
        ? ` ${asString(slot.provider) || 'provider?'} / ${asString(slot.model) || 'model?'}`
        : ' Not configured. Voice notes need this — the microphone stays hidden until it is set.',
    );
    const provider = appendInput(doc, card, 'Provider', draft.provider, [
      [AI_MODELS_TRANSCRIPTION_FIELD_ATTR, 'provider'],
      ['aria-label', 'Transcription slot provider'],
    ]);
    const model = appendInput(doc, card, 'Model', draft.model, [
      ['placeholder', 'e.g. whisper-1, whisper-large-v3'],
      [AI_MODELS_TRANSCRIPTION_FIELD_ATTR, 'model'],
      ['aria-label', 'Transcription slot model'],
    ]);
    const baseUrl = appendInput(doc, card, 'Base URL', draft.baseUrl, [
      ['placeholder', 'A local or remote endpoint — both work'],
      [AI_MODELS_TRANSCRIPTION_FIELD_ATTR, 'base-url'],
      ['aria-label', 'Transcription slot base URL'],
    ]);
    const apiKey = appendInput(doc, card, 'API key', draft.apiKey, [
      ['placeholder', slot?.has_key === true ? 'Leave blank to keep existing key' : 'Required'],
      [AI_MODELS_TRANSCRIPTION_FIELD_ATTR, 'api-key'],
      ['aria-label', 'Transcription slot API key'],
    ]);
    apiKey.type = 'password';
    // D-262 § B6 — ⛔ THE PLACEHOLDER SAYS WHAT EMPTY MEANS rather than filling
    // in a guess. Defaulting this from the browser locale would be a guess
    // wearing the costume of a default: a pinned language makes the provider
    // render speech INTO it, so a wrong value returns fluent nonsense instead
    // of an error, and it would fail exactly the multilingual owner it claims
    // to serve.
    const language = appendInput(
      doc,
      card,
      'Spoken language',
      transcriptionLanguageDraft ?? asString(llmConfig?.transcription_language),
      [
        ['placeholder', 'Leave empty to detect automatically'],
        [AI_MODELS_TRANSCRIPTION_FIELD_ATTR, 'language'],
        ['aria-label', 'Transcription spoken language'],
      ],
    );
    // D-262 § B12.3 — the daily cap, in REQUESTS.
    //
    // ⛔ The label says "calls a day", not "minutes" or "tokens", because that
    // is what is counted. Providers bill by audio seconds, but the multipart
    // endpoints report a duration only in their verbose format and Gemini
    // reports none — a seconds cap would stop counting for one provider and
    // read as generous when it was blind. ⚠ Empty means unlimited, and the
    // placeholder says so rather than showing a number nobody chose.
    const cap = appendInput(
      doc,
      card,
      'Daily limit (calls a day)',
      transcriptionCapDraft ?? (
        typeof llmConfig?.transcription_daily_requests === 'number'
          ? String(llmConfig.transcription_daily_requests)
          : ''
      ),
      [
        ['placeholder', 'Leave empty for no limit'],
        [AI_MODELS_TRANSCRIPTION_FIELD_ATTR, 'daily-requests'],
        ['aria-label', 'Transcription daily call limit'],
      ],
    );
    const syncDraft = (): void => {
      transcriptionSlotDraft = {
        provider: provider.value,
        model: model.value,
        baseUrl: baseUrl.value,
        apiKey: apiKey.value,
      };
      transcriptionLanguageDraft = language.value;
      transcriptionCapDraft = cap.value;
    };
    for (const input of [provider, model, baseUrl, apiKey, language, cap]) {
      input.addEventListener('input', syncDraft);
      if (transcriptionSlotSavePending || clearingThis) input.readOnly = true;
    }
    const save = appendButton(
      doc,
      card,
      transcriptionSlotSavePending ? 'Saving slot…' : 'Save slot',
      () => {
        void submitTranscriptionSlotSave({
          provider: provider.value,
          model: model.value,
          ...(apiKey.value.trim().length > 0 ? { api_key: apiKey.value } : {}),
          base_url: baseUrl.value,
        });
      },
      [
        [AI_MODELS_SLOT_SAVE_ATTR, 'transcription_slot'],
        ['aria-label', 'Save Transcription slot'],
      ],
    );
    const clear = appendButton(
      doc,
      card,
      'Clear slot',
      () => {
        if (transcriptionSlotSavePending || slotClearPendingKey !== null) return;
        actionError = null;
        slotClearDialogKey = 'transcription_slot';
        slotClearNeedsInitialFocus = true;
        slotClearNeedsConfirmFocus = false;
        render();
      },
      [
        [AI_MODELS_SLOT_CLEAR_ATTR, 'transcription_slot'],
        ['aria-label', 'Clear Transcription slot'],
      ],
    );
    if (transcriptionSlotSavePending || slotClearPendingKey !== null) {
      save.setAttribute('aria-disabled', 'true');
      clear.setAttribute('aria-disabled', 'true');
    }
    if (transcriptionSlotSavePending) save.setAttribute('aria-busy', 'true');
    // ⚠ Same button, a THIRD probe on the far side: the server transcribes a
    // bundled clip through the transcription registry. A chat completion sent
    // to a Whisper endpoint reports its 404 as a missing model — true, and
    // useless.
    renderProbeControls(
      card,
      'transcription_slot',
      'Transcription slot',
      { kind: 'slot', slot_key: 'transcription_slot' },
      () => ({
        provider: provider.value,
        model: model.value,
        ...(apiKey.value.trim().length > 0 ? { api_key: apiKey.value } : {}),
        ...(baseUrl.value.length > 0 ? { base_url: baseUrl.value } : {}),
      }),
    );
    parent.appendChild(card);
  };

  /** D-262 follow-on — one source's spend today, beside the cap that governs
   *  it.
   *
   *  🔑 BESIDE THE KNOB, NOT ON A SEPARATE PAGE. The number and the limit
   *  answer one question together — "have I got room" — and splitting them puts
   *  the feedback on a screen nobody visits while setting the value.
   *
   *  ⛔ UNITS ARE NEVER MERGED. Chat spends tokens, transcription spends calls;
   *  a single "usage" figure would be publishing a conversion nobody performed.
   *  ⚠ And a COOLDOWN is reported separately from being over budget: the
   *  provider said no versus the owner's own limit said no, which resolve
   *  differently — minutes versus midnight. */
  const renderUsageLine = (parent: HTMLElement, sourceId: string): void => {
    const row = llmUsage?.sources.find((entry) => entry.id === sourceId);
    if (!row) return;
    const parts: string[] = [];
    if (row.tokens_today !== undefined) {
      parts.push(row.limit !== undefined
        ? `${row.tokens_today.toLocaleString()} of ${row.limit.toLocaleString()} tokens today`
        : `${row.tokens_today.toLocaleString()} tokens today`);
    }
    if (row.transcription_requests_today !== undefined) {
      parts.push(row.limit !== undefined
        ? `${row.transcription_requests_today} of ${row.limit} calls today`
        : `${row.transcription_requests_today} calls today`);
      const seconds = row.transcription_seconds_today ?? 0;
      // ⚠ "at least" is not hedging — the count is an UNDER-count by
      // construction, because only providers that report a duration
      // contribute. Presenting it as a measurement would be a number the
      // owner could not reconcile with their bill.
      if (seconds > 0) parts.push(`at least ${Math.round(seconds)}s of audio heard`);
    }
    if (row.over_limit) parts.push('limit reached — resets at 00:00 UTC');
    if (row.in_cooldown) parts.push('the provider is rate-limiting this right now');
    if (parts.length === 0) return;
    const line = doc.createElement('p');
    line.className = 'ai-models-usage';
    line.setAttribute(AI_MODELS_USAGE_ATTR, sourceId);
    line.textContent = ` ${parts.join(' · ')}`;
    parent.appendChild(line);
  };

  const renderByok = (parent: HTMLElement): void => {
    const section = doc.createElement('section');
    markControl(section, 'byok');
    appendHeading(doc, section, 'h3', CONTROL_COPY.byok.title);
    appendText(doc, section, CONTROL_COPY.byok.body);
    if (!opts.runGetLLMConfig || !opts.runSetLLMSlot) {
      renderPending(section, 'byok');
    } else {
      renderSlot(section, 'slot_1');
      renderSlot(section, 'slot_2');
    }
    parent.appendChild(section);
  };

  const closePoolRemoveDialog = (): void => {
    if (poolRemoveDialogId === null || poolRemovePending) return;
    const id = poolRemoveDialogId;
    poolRemoveDialogId = null;
    poolRemoveNeedsInitialFocus = false;
    poolRemoveNeedsConfirmFocus = false;
    poolFocusAfterRender = { attr: AI_MODELS_POOL_REMOVE_ATTR, value: id };
    render();
  };

  const openPoolRemoveDialog = (id: string): void => {
    if (poolRemovePending) return;
    actionError = null;
    poolRemoveDialogId = id;
    poolRemoveNeedsInitialFocus = true;
    poolRemoveNeedsConfirmFocus = false;
    render();
  };

  const submitPoolRemove = async (id: string): Promise<void> => {
    if (
      disposed
      || poolRemovePending
      || poolRemoveDialogId !== id
    ) return;
    poolRemovePending = true;
    poolRemoveNeedsConfirmFocus = false;
    actionError = null;
    render();
    try {
      await api.removeFreePoolEntry(id);
    } catch (err) {
      if (disposed || poolRemoveDialogId !== id) return;
      poolRemovePending = false;
      poolRemoveNeedsConfirmFocus = true;
      actionError = stringifyError(err);
      render();
    }
  };

  /** Test connection — the button plus its verdict, for any probeable source.
   *
   *  One helper for BYOK slots, the embeddings slot, and free-pool rows: they
   *  ask the same question and the answer has the same shape, so three copies
   *  would be three places for the "what does a failure look like" copy to
   *  drift. `readDraft` is absent for a pool row — those have no editable
   *  fields (add/remove, not edit), so there is nothing to probe but what is
   *  already stored.
   *
   *  ⚠ Single-flight across the WHOLE page, not per source: each probe is a
   *  real request against the owner's credential, and a row of Test buttons is
   *  an invitation to fire five at once. */
  const renderProbeControls = (
    parent: HTMLElement,
    resultKey: string,
    label: string,
    target: AiModelsProbeTarget,
    readDraft?: () => {
      provider: string;
      model: string;
      api_key?: string;
      base_url?: string;
    },
  ): void => {
    if (!opts.runProbeLlmSource) return;
    const probing = slotProbePendingKey === resultKey;
    const test = appendButton(
      doc,
      parent,
      probing ? 'Testing…' : 'Test connection',
      () => {
        if (slotProbePendingKey !== null) return;
        void submitSlotProbe(resultKey, target, readDraft?.());
      },
      [
        [AI_MODELS_SLOT_TEST_ATTR, resultKey],
        ['aria-label', `Test the ${label} connection`],
      ],
    );
    if (slotProbePendingKey !== null) {
      test.setAttribute('aria-disabled', 'true');
      if (probing) test.setAttribute('aria-busy', 'true');
    }
    const probeResult = slotProbeResults.get(resultKey);
    if (probeResult === undefined) return;
    const box = doc.createElement('div');
    box.className = 'ai-models-probe';
    box.setAttribute(AI_MODELS_SLOT_TEST_RESULT_ATTR, resultKey);
    box.setAttribute('data-probe-ok', probeResult.ok ? 'true' : 'false');
    // Announced: the verdict arrives after an async round trip with no focus
    // change, so a screen-reader user would otherwise never learn it.
    box.setAttribute('role', 'status');
    const verdict = doc.createElement('p');
    verdict.className = 'ai-models-probe-verdict';
    verdict.textContent = PROBE_VERDICT[probeResult.diagnosis];
    box.appendChild(verdict);
    if (probeResult.ok) {
      // ⚠ Facts are reported ONLY on success — a failed probe learned nothing
      // about them, and a default shown as though it were observed is how a
      // "verified" badge starts lying.
      const facts = doc.createElement('p');
      facts.className = 'ai-models-probe-facts';
      const parts = [`answered in ${probeResult.elapsed_ms} ms`];
      if (probeResult.dimensions !== undefined) {
        parts.push(`${probeResult.dimensions}-dimension vectors`);
      }
      if (probeResult.supports_json === false) {
        // The owner DECLARED this and nothing has ever checked it.
        parts.push('JSON mode not supported — Recued will parse the text instead');
      }
      if (probeResult.accepts_system_role === false) {
        parts.push('no system-message support — instructions ride in the first user turn');
      }
      facts.textContent = parts.join(' · ');
      box.appendChild(facts);

      // ⛔⛔ D-262 § B7 — SHOW WHAT IT HEARD. The server returns `transcript`
      // for one stated reason: a `transcription_language` the owner did not
      // mean returns fluent NONSENSE rather than an error, and this is the only
      // surface that can reveal it. Rendering the verdict and the elapsed time
      // and dropping the transcript defeated the whole check — a probe that
      // says "ok, 900 ms" over a slot mis-set to Turkish looks exactly like one
      // that works.
      //
      // ⚠ Shown as a PAIR, never compared. Models, accents and punctuation
      // differ, so an equality check would fail on working slots — and the
      // owner cannot judge a language they do not read on its own, which is
      // precisely the failing case. Side by side, a mismatch is obvious
      // without reading either line.
      if (probeResult.transcript !== undefined) {
        const heard = doc.createElement('dl');
        heard.className = 'ai-models-probe-transcript';
        heard.setAttribute(AI_MODELS_PROBE_TRANSCRIPT_ATTR, 'true');
        const rows: [string, string][] = [];
        if (probeResult.expected_transcript !== undefined) {
          rows.push(['Clip says', probeResult.expected_transcript]);
        }
        rows.push(['Heard', probeResult.transcript]);
        rows.push([
          'Language',
          probeResult.probe_language !== undefined
            ? probeResult.probe_language
            // Absent is a real answer, not a missing one.
            : 'auto-detect',
        ]);
        for (const [label, value] of rows) {
          const dt = doc.createElement('dt');
          dt.textContent = label;
          const dd = doc.createElement('dd');
          dd.textContent = value;
          heard.appendChild(dt);
          heard.appendChild(dd);
        }
        box.appendChild(heard);
      }
    } else if (probeResult.detail !== undefined) {
      const detail = doc.createElement('pre');
      detail.className = 'ai-models-probe-detail';
      detail.textContent = probeResult.detail;
      box.appendChild(detail);
    }
    parent.appendChild(box);
  };

  const renderPoolRemoveDialog = (parent: HTMLElement): void => {
    const id = poolRemoveDialogId;
    if (id === null) return;

    const overlay = doc.createElement('div');
    overlay.className = 'ai-models-confirm-overlay';
    const panel = doc.createElement('div');
    panel.className = 'ai-models-confirm-dialog';
    panel.setAttribute(AI_MODELS_POOL_REMOVE_DIALOG_ATTR, id);
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'recued-ai-models-remove-title');
    panel.setAttribute('aria-describedby', 'recued-ai-models-remove-body');
    panel.setAttribute('tabindex', '-1');
    if (poolRemovePending) panel.setAttribute('aria-busy', 'true');

    const title = appendHeading(
      doc,
      panel,
      'h4',
      `Remove ${id} from the free pool?`,
    );
    title.setAttribute('id', 'recued-ai-models-remove-title');
    const body = doc.createElement('p');
    body.setAttribute('id', 'recued-ai-models-remove-body');
    body.textContent =
      'This deletes the saved entry and API key from this Recued server. '
      + 'You will need to add both again to restore it.';
    panel.appendChild(body);
    if (actionError !== null) {
      const error = doc.createElement('p');
      error.className = 'ai-models-confirm-error';
      error.setAttribute('role', 'alert');
      error.textContent = actionError;
      panel.appendChild(error);
    }

    const actions = doc.createElement('div');
    actions.className = 'ai-models-confirm-actions';
    const cancel = appendButton(
      doc,
      actions,
      'Cancel',
      () => {
        closePoolRemoveDialog();
      },
      [[AI_MODELS_POOL_REMOVE_CANCEL_ATTR, id]],
    );
    const confirm = appendButton(
      doc,
      actions,
      poolRemovePending ? 'Removing…' : 'Remove entry',
      () => {
        void submitPoolRemove(id);
      },
      [[AI_MODELS_POOL_REMOVE_CONFIRM_ATTR, id]],
    );
    if (poolRemovePending) {
      cancel.setAttribute('aria-disabled', 'true');
      confirm.setAttribute('aria-disabled', 'true');
      confirm.setAttribute('aria-busy', 'true');
    }
    panel.appendChild(actions);
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || poolRemovePending) return;
      event.preventDefault();
      event.stopPropagation();
      closePoolRemoveDialog();
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closePoolRemoveDialog();
    });
    overlay.appendChild(panel);
    parent.appendChild(overlay);
    renderedPoolRemovePanel = panel;
    renderedPoolRemoveCancel = cancel;
    renderedPoolRemoveConfirm = confirm;
  };

  const submitFreePoolToggle = async (
    id: string,
    enabled: boolean,
  ): Promise<void> => {
    if (disposed || poolTogglePendingTargets.has(id)) return;
    poolTogglePendingTargets.set(id, enabled);
    actionError = null;
    render();
    try {
      await api.setFreePoolEntryEnabled(id, enabled);
      if (disposed) return;
      poolTogglePendingTargets.delete(id);
      render();
    } catch (err) {
      if (disposed) return;
      poolTogglePendingTargets.delete(id);
      actionError = stringifyError(err);
      render();
    }
  };

  const submitFreePoolAdd = async (
    entry: Parameters<AiModelsPageMount['addFreePoolApiEntry']>[0],
  ): Promise<void> => {
    if (disposed || freePoolAddPending) return;
    freePoolAddPending = true;
    actionError = null;
    render();
    try {
      await api.addFreePoolApiEntry(entry);
      if (disposed) return;
      freePoolAddPending = false;
      render();
    } catch (err) {
      if (disposed) return;
      freePoolAddPending = false;
      actionError = stringifyError(err);
      render();
    }
  };

  const renderFreePool = (parent: HTMLElement): void => {
    const section = doc.createElement('section');
    markControl(section, 'free_pool');
    appendHeading(doc, section, 'h3', CONTROL_COPY.free_pool.title);
    appendText(doc, section, CONTROL_COPY.free_pool.body);
    if (!opts.runGetLLMConfig || !opts.runUpsertFreePoolEntry) {
      renderPending(section, 'free_pool');
      parent.appendChild(section);
      return;
    }
    // Pool-wide catalog-mode control (one `free_pool` source, not per-entry),
    // at the top of the live section.
    renderCatalogModeControl(section, 'free_pool');
    const entries = getPoolEntries(llmConfig);
    if (entries.length === 0) {
      appendText(doc, section, ' No free-pool entries configured.');
    }
    for (const entry of entries) {
      const id = asString(entry.id);
      const togglePending = poolTogglePendingTargets.has(id);
      const pendingTarget = poolTogglePendingTargets.get(id);
      const enabling = entry.enabled === false;
      const row = doc.createElement('div');
      row.className = 'ai-models-pool-row';
      row.setAttribute(AI_MODELS_CONTROL_ATTR, `free_pool:${id}`);
      appendText(
        doc,
        row,
        `${id || 'entry'}: ${asString(entry.provider) || asString(entry.type)} / ${asString(entry.model) || asString(entry.tab)} (${entry.enabled === false ? 'disabled' : 'enabled'})`,
      );
      // D-262 follow-on — a pool entry's `daily_cap_tokens` is enforced by the
      // match resolver; until now nothing showed the number it enforced on.
      renderUsageLine(row, id);
      // T3-AUD-1 — what this provider's FREE tier does with the owner's data,
      // stated where they choose it rather than left in a vendor's terms page
      // they never opened. Renders for a known provider AND for an unreviewed
      // one ("we have not checked" is information); silent only for a local
      // endpoint, where nothing leaves the machine and a warning would be the
      // noise that makes real warnings ignorable.
      const dataUse = freePoolDataUseNotice(
        resolveFreePoolDataUse({
          provider: asString(entry.provider),
          base_url: asString(entry.base_url),
        }),
      );
      if (dataUse !== undefined) {
        const note = doc.createElement('p');
        note.className = 'ai-models-pool-data-use';
        note.setAttribute(AI_MODELS_CONTROL_ATTR, `free_pool:${id}:data_use`);
        note.textContent = dataUse;
        row.appendChild(note);
      }
      if (id.length > 0) {
        const toggle = appendButton(
          doc,
          row,
          togglePending
            ? pendingTarget === true ? 'Enabling…' : 'Disabling…'
            : enabling ? 'Enable' : 'Disable',
          () => {
            void submitFreePoolToggle(id, enabling);
          },
          [[AI_MODELS_POOL_TOGGLE_ATTR, id]],
        );
        toggle.setAttribute(
          'aria-label',
          `${enabling ? 'Enable' : 'Disable'} free-pool entry ${id}`,
        );
        const remove = appendButton(
          doc,
          row,
          'Remove',
          () => {
            if (poolTogglePendingTargets.has(id)) return;
            openPoolRemoveDialog(id);
          },
          [[AI_MODELS_POOL_REMOVE_ATTR, id]],
        );
        remove.setAttribute('aria-label', `Remove free-pool entry ${id}`);
        // No draft: a pool row has no editable fields (add/remove, not edit),
        // so there is nothing to probe but what is already stored.
        renderProbeControls(
          row,
          `pool:${id}`,
          `free-pool entry ${id}`,
          { kind: 'pool_entry', entry_id: id },
        );
        if (togglePending) {
          toggle.setAttribute('aria-disabled', 'true');
          toggle.setAttribute('aria-busy', 'true');
          remove.setAttribute('aria-disabled', 'true');
        }
      }
      section.appendChild(row);
    }
    const add = doc.createElement('div');
    add.className = 'ai-models-add-pool';
    const id = appendInput(doc, add, 'ID', freePoolAddDraft.id, [
      [AI_MODELS_POOL_ADD_FIELD_ATTR, 'id'],
      ['aria-label', 'New free-pool entry ID'],
    ]);
    const provider = appendInput(
      doc,
      add,
      'Provider',
      freePoolAddDraft.provider,
      [
        [AI_MODELS_POOL_ADD_FIELD_ATTR, 'provider'],
        ['aria-label', 'New free-pool entry provider'],
      ],
    );
    const model = appendInput(doc, add, 'Model', freePoolAddDraft.model, [
      [AI_MODELS_POOL_ADD_FIELD_ATTR, 'model'],
      ['aria-label', 'New free-pool entry model'],
    ]);
    const key = appendInput(doc, add, 'API key', freePoolAddDraft.apiKey, [
      [AI_MODELS_POOL_ADD_FIELD_ATTR, 'api-key'],
      ['aria-label', 'New free-pool entry API key'],
    ]);
    key.type = 'password';
    const baseUrl = appendInput(doc, add, 'Base URL', freePoolAddDraft.baseUrl, [
      [AI_MODELS_POOL_ADD_FIELD_ATTR, 'base-url'],
      ['aria-label', 'New free-pool entry base URL'],
    ]);
    const contextWindow = appendInput(
      doc,
      add,
      'Context window (tokens)',
      freePoolAddDraft.contextWindow,
      [
        [AI_MODELS_CONTEXT_WINDOW_INPUT_ATTR, 'free_pool:new'],
        [AI_MODELS_POOL_ADD_FIELD_ATTR, 'context-window'],
        ['placeholder', 'e.g. 128000'],
        ['inputmode', 'numeric'],
        ['min', '1'],
        ['step', '1'],
        ['aria-label', 'New free-pool entry context window (tokens)'],
      ],
    );
    contextWindow.type = 'number';
    const syncAddDraft = (): void => {
      Object.assign(freePoolAddDraft, {
        id: id.value,
        provider: provider.value,
        model: model.value,
        apiKey: key.value,
        baseUrl: baseUrl.value,
        contextWindow: contextWindow.value,
      });
    };
    for (const input of [id, provider, model, key, baseUrl, contextWindow]) {
      input.addEventListener('input', syncAddDraft);
      if (freePoolAddPending) input.readOnly = true;
    }
    const addEntry = appendButton(
      doc,
      add,
      freePoolAddPending ? 'Adding entry…' : 'Add API entry',
      () => {
        const contextWindowTokens = parsePositiveSafeInteger(contextWindow.value);
        void submitFreePoolAdd({
          id: id.value,
          provider: provider.value,
          model: model.value,
          api_key: key.value,
          ...(baseUrl.value.trim().length > 0 ? { base_url: baseUrl.value } : {}),
          ...(contextWindowTokens !== undefined
            ? { context_window_tokens: contextWindowTokens }
            : {}),
        });
      },
      [
        [AI_MODELS_POOL_ADD_ATTR, ''],
        ['aria-label', 'Add free-pool API entry'],
      ],
    );
    if (freePoolAddPending) {
      addEntry.setAttribute('aria-disabled', 'true');
      addEntry.setAttribute('aria-busy', 'true');
    }
    section.appendChild(add);
    parent.appendChild(section);
    renderPoolRemoveDialog(parent);
  };

  const renderAiPolicy = (parent: HTMLElement): void => {
    const section = doc.createElement('section');
    markControl(section, 'ai_policy');
    appendHeading(doc, section, 'h3', CONTROL_COPY.ai_policy.title);
    appendText(doc, section, CONTROL_COPY.ai_policy.body);
    if (!opts.runReadHousekeepingConfig || !opts.runWriteHousekeepingConfig) {
      renderPending(section, 'ai_policy');
      parent.appendChild(section);
      return;
    }
    const allow = housekeepingConfig?.allow_byok_background === true;
    appendText(doc, section, ` Background BYOK: ${allow ? 'allowed' : 'free pool only'}.`);
    const allowButton = appendButton(
      doc,
      section,
      aiPolicyPendingAction === 'allow'
        ? 'Updating background BYOK…'
        : allow ? 'Disable background BYOK' : 'Allow background BYOK',
      () => {
        void submitAiPolicyMutation(
          'allow',
          () => api.setAllowByokBackground(!allow),
        );
      },
      [[AI_MODELS_ALLOW_BYOK_TOGGLE_ATTR, 'background']],
    );
    const pause = housekeepingConfig?.pause_background_ai_until ?? null;
    appendText(
      doc,
      section,
      pause === null
        ? ' Pause-AI: not active.'
        : ` Pause-AI until ${formatClientDateTime(pause, { invalidText: 'unknown time' })}.`,
    );
    const pauseButton = appendButton(
      doc,
      section,
      aiPolicyPendingAction === 'pause' ? 'Pausing AI…' : 'Pause 1h',
      () => {
        void submitAiPolicyMutation(
          'pause',
          () => api.setPauseBackgroundAiUntil(
            (opts.now ?? Date.now)() + 60 * 60 * 1000,
          ),
        );
      },
      [[AI_MODELS_PAUSE_BUTTON_ATTR, '1h']],
    );
    const resumeButton = appendButton(
      doc,
      section,
      aiPolicyPendingAction === 'resume' ? 'Resuming AI…' : 'Resume AI',
      () => {
        void submitAiPolicyMutation(
          'resume',
          () => api.setPauseBackgroundAiUntil(null),
        );
      },
      [[AI_MODELS_PAUSE_BUTTON_ATTR, 'resume']],
    );
    if (aiPolicyPendingAction !== null) {
      allowButton.setAttribute('aria-disabled', 'true');
      pauseButton.setAttribute('aria-disabled', 'true');
      resumeButton.setAttribute('aria-disabled', 'true');
      const activeButton = aiPolicyPendingAction === 'allow'
        ? allowButton
        : aiPolicyPendingAction === 'pause'
          ? pauseButton
          : resumeButton;
      activeButton.setAttribute('aria-busy', 'true');
    }
    parent.appendChild(section);
  };

  /** The System prompts tab — one card per surface.
   *
   *  THE EDITABLE BOX IS BLOCK 1 ONLY: who the model is and what to weigh
   *  ("You are a dental assistant for Dr. Chen. Check the calendar before
   *  answering about appointments."). Recued's core text (the AIOutput wire
   *  contract) and its feature text (tool mechanics, the approvals posture, the
   *  gateway's contract-scoping lines) are composed AROUND it and are not
   *  reachable from here — so the card renders them READ-ONLY underneath. An
   *  owner should be able to SEE everything else the model is told: a fence you
   *  cannot read is indistinguishable from a fence that is not there.
   *
   *  ── The shape, and why it is this one ──────────────────────────────
   *  ONE textarea, `[ Save ] [ Load default ]`, and a status line. Nothing
   *  else sits between the box and its buttons, because everything that used
   *  to made the card read as "load a prompt, save it INTO something":
   *
   *  DD#1 — The wire-role `<select>` is GONE (see {@link describeTransportRole}).
   *  A picker offering `system / user / assistant` next to Save reads as a
   *  destination for the text; it is a provider-compatibility hatch. Saving now
   *  carries the STORED role through untouched, so hiding the control cannot
   *  change anyone's delivery. A role that is already off-default announces
   *  itself in one line and offers the way back — hidden must not mean stuck.
   *
   *  DD#2 — `Load default` is CLIENT-ONLY, and it replaces the old
   *  server-side "Reset to default". The reset is not lost: a save whose text
   *  equals the built-in sends `null` (`saveLlmPrompt`), which is how the
   *  server expresses default, so `Load default` + `Save` IS the reset — with
   *  the built-in visible in the box before it is committed. The old button
   *  wrote to the server on first click with nothing shown and no confirm.
   *
   *  DD#3 — The status line answers "is this what is saved?". The badge says
   *  Default/Customised, which is a property of the ROW; the owner's question
   *  is about the BOX, and the two diverge the moment they type. It is mutated
   *  in place on input rather than re-rendered — see DD#4.
   *
   *  DD#4 — Typing NEVER re-renders (pre-existing invariant, kept): the input
   *  listener writes the draft map and pokes `syncStatus`, both of which touch
   *  live nodes only. A `render()` here would rebuild the textarea and drop the
   *  caret mid-word. */
  const renderPrompts = (parent: HTMLElement): void => {
    if (!opts.runGetLlmPrompts || !opts.runSetLlmPrompt) {
      renderPending(parent, 'prompts');
      return;
    }
    for (const record of llmPrompts) {
      const pendingMutation = promptMutationPending.get(record.surface);
      const copy = PROMPT_SURFACE_COPY[record.surface];
      const draft = promptDrafts.get(record.surface) ?? {
        role_instructions: record.role_instructions,
        role: record.role,
        caller_system_policy:
          record.caller_system_policy ?? DEFAULT_CALLER_SYSTEM_POLICY,
      };
      const currentDraft = (): PromptDraft =>
        promptDrafts.get(record.surface) ?? draft;
      const updateDraft = (patch: Partial<PromptDraft>): PromptDraft => {
        const next = { ...currentDraft(), ...patch };
        promptDrafts.set(record.surface, next);
        return next;
      };
      const section = doc.createElement('section');
      section.className = 'ai-models-prompt';
      section.setAttribute(AI_MODELS_PROMPT_SECTION_ATTR, record.surface);
      const titleId = `recued-ai-models-prompt-${record.surface}-title`;
      section.setAttribute('aria-labelledby', titleId);

      const head = doc.createElement('div');
      head.className = 'ai-models-prompt-head';
      const title = appendHeading(doc, head, 'h3', copy.title);
      title.setAttribute('id', titleId);
      const badge = doc.createElement('span');
      badge.className = 'ai-models-prompt-badge';
      badge.setAttribute(
        AI_MODELS_PROMPT_BADGE_ATTR,
        record.is_default ? 'default' : 'custom',
      );
      badge.textContent = record.is_default ? 'Default' : 'Customised';
      head.appendChild(badge);
      section.appendChild(head);

      const body = doc.createElement('p');
      body.className = 'ai-models-prompt-body';
      body.textContent = copy.body;
      section.appendChild(body);

      const area = doc.createElement('textarea');
      area.className = 'ai-models-prompt-text';
      area.setAttribute(AI_MODELS_PROMPT_TEXT_ATTR, record.surface);
      area.setAttribute('aria-label', `${copy.title} system prompt`);
      area.rows = 8;
      area.spellcheck = false;
      area.value = draft.role_instructions;
      if (pendingMutation !== undefined) area.readOnly = true;
      section.appendChild(area);

      // DD#3 — about the BOX, not the row. The badge above reports whether the
      // SERVER holds an override; this reports whether what you are looking at
      // is that saved text, and the two part company on the first keystroke.
      const status = doc.createElement('p');
      status.className = 'ai-models-prompt-status';
      status.setAttribute(AI_MODELS_PROMPT_STATUS_ATTR, record.surface);
      const syncStatus = (): void => {
        const text = currentDraft().role_instructions;
        status.textContent = text !== record.role_instructions
          ? 'Unsaved changes — Save to put this in force.'
          : record.is_default
            ? 'Showing the built-in default, in force now.'
            : 'Showing your saved prompt, in force now.';
      };
      syncStatus();
      section.appendChild(status);

      // DD#4 — mutate, never render: a rebuilt textarea loses the caret.
      area.addEventListener('input', () => {
        updateDraft({ role_instructions: area.value });
        syncStatus();
      });

      const controls = doc.createElement('div');
      controls.className = 'ai-models-prompt-controls';

      const save = appendButton(
        doc,
        controls,
        pendingMutation === 'save' ? 'Saving…' : 'Save',
        () => {
          const nextDraft = currentDraft();
          void submitPromptMutation(
            record.surface,
            'save',
            () => api.saveLlmPrompt(record.surface, nextDraft),
          );
        },
        [
          [AI_MODELS_PROMPT_SAVE_ATTR, record.surface],
          ['aria-label', `Save ${copy.title} system prompt`],
        ],
      );
      // DD#2 — puts the built-in in the box and stops. Nothing is written until
      // the owner reads it and presses Save, and Save then sends `null`, so the
      // row is genuinely deleted rather than overwritten with a copy.
      const loadDefault = appendButton(
        doc,
        controls,
        'Load default',
        () => {
          if (promptMutationPending.has(record.surface)) return;
          updateDraft({ role_instructions: record.default_role_instructions });
          area.value = record.default_role_instructions;
          syncStatus();
        },
        [
          [AI_MODELS_PROMPT_LOAD_DEFAULT_ATTR, record.surface],
          [
            'aria-label',
            `Load the built-in ${copy.title} system prompt into the editor`,
          ],
        ],
      );
      if (pendingMutation !== undefined) {
        save.setAttribute('aria-disabled', 'true');
        loadDefault.setAttribute('aria-disabled', 'true');
        if (pendingMutation === 'save') save.setAttribute('aria-busy', 'true');
      }
      section.appendChild(controls);

      // DD#1 — only when it is off-default, because only then is there anything
      // to tell or undo. A server that never touched it renders nothing here.
      if (record.role !== record.default_role) {
        const transport = doc.createElement('p');
        transport.className = 'ai-models-prompt-transport';
        transport.setAttribute(AI_MODELS_PROMPT_TRANSPORT_ATTR, record.surface);
        appendText(doc, transport, describeTransportRole(record.role));
        const revert = appendButton(
          doc,
          transport,
          pendingMutation === 'transport' ? 'Switching…' : 'Deliver as system',
          () => {
            void submitPromptMutation(
              record.surface,
              'transport',
              () => api.setPromptDeliveryRoleToDefault(record.surface),
            );
          },
          [
            [AI_MODELS_PROMPT_TRANSPORT_RESET_ATTR, record.surface],
            [
              'aria-label',
              `Deliver the ${copy.title} system prompt as a system message`,
            ],
          ],
        );
        if (pendingMutation !== undefined) {
          revert.setAttribute('aria-disabled', 'true');
          if (pendingMutation === 'transport') {
            revert.setAttribute('aria-busy', 'true');
          }
        }
        section.appendChild(transport);
      }

      // llm_gateway only — what a CALLER's own system message may do. NOT a
      // transport knob and not part of the save form above: it decides whether
      // a stranger's text can sit beside the owner's instructions or replace
      // them outright. It keeps its own heading below the editor's buttons so
      // nothing reads as "save the prompt INTO this".
      if (record.caller_system_policy !== undefined) {
        const policySection = doc.createElement('div');
        policySection.className = 'ai-models-prompt-policy';
        appendHeading(doc, policySection, 'h4', "Customer's own system prompt");
        const policyLabel = doc.createElement('label');
        policyLabel.className = 'ai-models-field';
        const policySelect = doc.createElement('select');
        policySelect.setAttribute(AI_MODELS_PROMPT_POLICY_ATTR, record.surface);
        policySelect.setAttribute(
          'aria-label',
          `${copy.title} customer system prompt policy`,
        );
        for (const policy of CALLER_SYSTEM_POLICIES) {
          const option = doc.createElement('option');
          option.value = policy;
          option.textContent = CALLER_SYSTEM_POLICY_LABELS[policy];
          policySelect.appendChild(option);
        }
        policySelect.value = draft.caller_system_policy;
        if (pendingMutation !== undefined) policySelect.disabled = true;
        policySelect.addEventListener('change', () => {
          const next = CALLER_SYSTEM_POLICIES.includes(
            policySelect.value as ServerLlmCallerSystemPolicy,
          )
            ? policySelect.value as ServerLlmCallerSystemPolicy
            : DEFAULT_CALLER_SYSTEM_POLICY;
          updateDraft({ caller_system_policy: next });
          policyHint.textContent = CALLER_SYSTEM_POLICY_HINTS[next];
        });
        policyLabel.appendChild(policySelect);
        const policyHint = doc.createElement('small');
        policyHint.setAttribute(AI_MODELS_PROMPT_POLICY_HINT_ATTR, record.surface);
        policyHint.textContent =
          CALLER_SYSTEM_POLICY_HINTS[draft.caller_system_policy];
        policyLabel.appendChild(policyHint);
        policySection.appendChild(policyLabel);
        section.appendChild(policySection);
      }

      // Everything the owner CANNOT edit, shown so they know it is there. This
      // is what makes the fence legible instead of merely present.
      const always = doc.createElement('details');
      always.className = 'ai-models-prompt-always';
      always.setAttribute(AI_MODELS_PROMPT_ALWAYS_ATTR, record.surface);
      always.setAttribute(
        'aria-label',
        `${copy.title} always-on prompt text`,
      );
      const summary = doc.createElement('summary');
      summary.textContent =
        'Recued always adds this (not editable — it is how the engine works)';
      summary.setAttribute(
        'aria-label',
        `Show ${copy.title} always-on prompt text`,
      );
      always.appendChild(summary);
      const pre = doc.createElement('pre');
      pre.className = 'ai-models-prompt-always-text';
      pre.textContent = record.always_on_text.join('\n\n');
      always.appendChild(pre);
      section.appendChild(always);

      parent.appendChild(section);
    }
  };

  const renderBudget = (parent: HTMLElement): void => {
    const section = doc.createElement('section');
    markControl(section, 'budget');
    appendHeading(doc, section, 'h3', CONTROL_COPY.budget.title);
    appendText(doc, section, CONTROL_COPY.budget.body);
    const budget = findConfigField(configSchema, 'llm.budget');
    if (!budget || !opts.runGetConfigSchema || !opts.runSetConfigField) {
      renderPending(section, 'budget');
    } else {
      const input = appendInput(
        doc,
        section,
        'Daily tokens',
        budgetDraft ?? String(budget.value),
        [[AI_MODELS_BUDGET_INPUT_ATTR, 'llm.budget']],
      );
      input.type = 'number';
      input.addEventListener('input', () => {
        budgetDraft = input.value;
      });
      if (budgetSavePending) input.readOnly = true;
      const save = appendButton(
        doc,
        section,
        budgetSavePending ? 'Saving budget…' : 'Save budget',
        () => {
          void submitBudgetSave(Number(input.value));
        },
        [[AI_MODELS_BUDGET_SAVE_ATTR, 'llm.budget']],
      );
      if (budgetSavePending) {
        save.setAttribute('aria-disabled', 'true');
        save.setAttribute('aria-busy', 'true');
      }
    }
    parent.appendChild(section);
  };

  /** Persist a known source as Chat's global default. The setup journey calls
   * this immediately after creating slot_1, so it must not depend on a prior
   * preference read having succeeded. The public picker still applies its own
   * configured-option guard below. */
  const persistModelPreference = async (
    sourceId: ChatModelSourceId,
  ): Promise<void> => {
    if (!opts.runSetDefaultModelPref) {
      throw new Error(
        'AI / Models: chat.default_model_pref.set caller is not wired',
      );
    }
    const next = await opts.runSetDefaultModelPref({ source_id: sourceId });
    if (disposed) return;
    modelPrefSnapshot = next;
    recomputeModelPreference();
    render();
  };

  /** Global chat behaviour — write the rolling-brief enable.
   *
   *  ⚠ MIRRORS THE CONFIRMED SERVER RESULT, never the optimistic input: the
   *  server is the authority on the stored value, and echoing the request would
   *  show a toggle as flipped even if the write were coerced or rejected.
   *  Same discipline as `persistModelPreference` above. */
  let rollingBriefPending = false;
  /** ⚠ Single-flight + surfaces the failure. A toggle that silently swallowed a
   *  rejected write would leave the UI showing a state the server never took. */
  const submitRollingBrief = async (enabled: boolean): Promise<void> => {
    if (rollingBriefPending || !opts.runSetRollingBrief) return;
    rollingBriefPending = true;
    actionError = null;
    render();
    try {
      await persistRollingBrief(enabled);
    } catch (err) {
      actionError = stringifyError(err);
    } finally {
      if (!disposed) {
        rollingBriefPending = false;
        render();
      }
    }
  };

  const persistRollingBrief = async (enabled: boolean): Promise<void> => {
    if (!opts.runSetRollingBrief) {
      throw new Error('AI / Models: chat.rolling_brief.set caller is not wired');
    }
    const next = await opts.runSetRollingBrief({ enabled });
    if (disposed) return;
    rollingBriefSnapshot = next;
    recomputeChatBehaviour();
    render();
  };

  const finishChatSetup = (): void => {
    if (disposed) return;
    chatSetupSubmitting = false;
    chatSetupCompleted = true;
    chatSetupError = null;
    chatSetupDraft.apiKey = '';
    render();
    opts.onChatSetupComplete?.();
    chatSetupFocusOwner = null;
  };

  const useExistingChatSource = async (
    sourceId: ChatModelSourceId,
  ): Promise<void> => {
    if (chatSetupSubmitting) return;
    chatSetupFocusOwner = captureChatSetupFocusOwner();
    chatSetupSubmitting = true;
    chatSetupError = null;
    render();
    try {
      await persistModelPreference(sourceId);
      finishChatSetup();
    } catch (err) {
      if (disposed) return;
      chatSetupSubmitting = false;
      chatSetupError = stringifyError(err);
      render();
    }
  };

  const saveNewChatSource = async (): Promise<void> => {
    if (chatSetupSubmitting) return;
    chatSetupFocusOwner = captureChatSetupFocusOwner();
    const provider = chatSetupDraft.provider;
    const model = chatSetupDraft.model.trim();
    const apiKey = chatSetupDraft.apiKey.trim();
    const baseUrl = chatSetupDraft.baseUrl.trim();
    if (model.length === 0) {
      chatSetupError = 'Enter the model name supplied by your provider.';
      render();
      return;
    }
    if (apiKey.length === 0) {
      chatSetupError = 'Enter an API key to connect this model.';
      render();
      return;
    }
    if (provider === 'openai-compatible' && baseUrl.length === 0) {
      chatSetupError = 'Enter the base URL for this compatible endpoint.';
      render();
      return;
    }
    if (
      provider === 'openai-compatible'
      && !isChatSetupEndpointUrl(baseUrl)
    ) {
      chatSetupError =
        'Enter a full Base URL beginning with http:// or https://.';
      render();
      return;
    }

    chatSetupSubmitting = true;
    chatSetupError = null;
    render();
    try {
      await api.saveByokSlot('slot_1', {
        provider,
        model,
        api_key: apiKey,
        // An explicit blank clears a stale custom endpoint. Omitting this
        // field would make saveByokSlot carry slot_1's previous base_url onto
        // a newly selected OpenAI/Anthropic/Google credential.
        base_url: provider === 'openai-compatible' ? baseUrl : '',
        speed: 'fast',
      });
      if (chatSetupFocusOwner !== null) {
        chatSetupFocusOwner = {
          attr: AI_MODELS_CHAT_SETUP_SUBMIT_ATTR,
          value: 'existing',
        };
      }
      // The field-level slot write updates the live manager. Pinning slot_1 as
      // the default is the second and final confirmed write before navigation.
      await persistModelPreference('slot_1');
      finishChatSetup();
    } catch (err) {
      if (disposed) return;
      chatSetupSubmitting = false;
      chatSetupError = stringifyError(err);
      render();
    }
  };

  const appendChatSetupExits = (
    parent: HTMLElement,
    includeStartChat: boolean,
  ): void => {
    const actions = doc.createElement('div');
    actions.className = 'ai-models-chat-setup-actions';
    if (includeStartChat) {
      const start = appendLink(
        doc,
        actions,
        'Start chatting',
        opts.chatSetupReturnHref ?? serializeShellRoute('chat', 'start'),
      );
      start.className = 'rx-btn rx-btn-primary';
    }
    const advanced = appendLink(
      doc,
      actions,
      'Advanced settings',
      serializeShellRoute('settings', 'ai-models'),
      [[AI_MODELS_CHAT_SETUP_ADVANCED_ATTR, '']],
    );
    advanced.className = 'rx-btn rx-btn-secondary';
    if (!includeStartChat) {
      const back = appendLink(
        doc,
        actions,
        'Back to Chat',
        opts.chatSetupReturnHref ?? serializeShellRoute('chat'),
      );
      back.className = 'ai-models-chat-setup-back';
    }
    parent.appendChild(actions);
  };

  const renderChatSetup = (parent: HTMLElement): void => {
    const section = doc.createElement('section');
    section.setAttribute(AI_MODELS_CHAT_SETUP_ATTR, '');
    section.className = 'ai-models-chat-setup';
    section.setAttribute('aria-labelledby', 'recued-chat-setup-title');

    const eyebrow = doc.createElement('p');
    eyebrow.className = 'ai-models-chat-setup-eyebrow';
    eyebrow.textContent = 'CHAT SETUP';
    section.appendChild(eyebrow);
    const setupHeading = appendHeading(
      doc,
      section,
      'h3',
      'Connect a model to start chatting',
    );
    setupHeading.id = 'recued-chat-setup-title';
    const intro = doc.createElement('p');
    intro.className = 'ai-models-chat-setup-intro';
    intro.textContent =
      'Choose your provider, confirm its model name, and add your API key. You can tune everything else later.';
    section.appendChild(intro);

    if (state === 'loading') {
      const status = doc.createElement('div');
      status.setAttribute(AI_MODELS_CHAT_SETUP_STATUS_ATTR, 'loading');
      status.setAttribute('role', 'status');
      status.textContent = 'Checking your current Chat setup…';
      section.appendChild(status);
      parent.appendChild(section);
      return;
    }

    if (loadErrors.length > 0) {
      const alert = doc.createElement('div');
      alert.setAttribute(AI_MODELS_CHAT_SETUP_ERROR_ATTR, 'load');
      alert.setAttribute('role', 'alert');
      alert.textContent = `Could not read all current settings: ${loadErrors.join(' ')}`;
      section.appendChild(alert);
    }
    if (chatSetupError !== null) {
      const alert = doc.createElement('div');
      alert.setAttribute(AI_MODELS_CHAT_SETUP_ERROR_ATTR, 'save');
      alert.setAttribute('role', 'alert');
      alert.textContent = chatSetupError;
      section.appendChild(alert);
    }

    // Never treat an unread config as an empty config: saving slot_1 from that
    // assumption could overwrite a provider the owner cannot currently see.
    const configReadFailed = loadErrors.some(
      (error) => error.startsWith('LLM config:'),
    );
    if (opts.runGetLLMConfig === undefined || configReadFailed) {
      if (opts.runGetLLMConfig === undefined) {
        const alert = doc.createElement('div');
        alert.setAttribute(AI_MODELS_CHAT_SETUP_ERROR_ATTR, 'unavailable');
        alert.setAttribute('role', 'alert');
        alert.textContent =
          'This server cannot read the current model setup, so Recued will not overwrite it.';
        section.appendChild(alert);
      } else {
        const retry = appendButton(
          doc,
          section,
          'Try again',
          () => {
            void api.refresh();
          },
        );
        retry.className = 'rx-btn rx-btn-primary ai-models-chat-setup-submit';
      }
      appendChatSetupExits(section, false);
      parent.appendChild(section);
      return;
    }

    const hasConfiguredSource = isAnyAiSourceConfigured(llmConfig);
    const sources = buildChatModelSourceOptions(llmConfig ?? {});
    const selectedSourceId =
      modelPreference.kind === 'resolved' && modelPreference.matched
        ? modelPreference.source_id
        : null;
    const selectedSource = selectedSourceId === null
      ? null
      : sources.find((source) => source.id === selectedSourceId) ?? null;

    if (chatSetupCompleted || selectedSource !== null) {
      const ready = doc.createElement('div');
      ready.className = 'ai-models-chat-setup-ready';
      ready.setAttribute(AI_MODELS_CHAT_SETUP_STATUS_ATTR, 'ready');
      ready.setAttribute('role', 'status');
      ready.setAttribute('tabindex', '-1');
      appendHeading(doc, ready, 'h4', 'Model selected for Chat');
      const detail = doc.createElement('p');
      detail.textContent = selectedSource === null
        ? 'Your model is selected for new chats.'
        : `${selectedSource.label} is selected for Chat.`;
      ready.appendChild(detail);
      section.appendChild(ready);
      appendChatSetupExits(section, true);
      parent.appendChild(section);
      focusChatSetupProgress(ready);
      return;
    }

    if (hasConfiguredSource && sources.length > 0 && chatSetupSubmitting) {
      const finishing = doc.createElement('div');
      finishing.setAttribute(AI_MODELS_CHAT_SETUP_STATUS_ATTR, 'saving');
      finishing.setAttribute('role', 'status');
      finishing.setAttribute('tabindex', '-1');
      finishing.textContent = 'Finishing Chat setup…';
      section.appendChild(finishing);
      parent.appendChild(section);
      focusChatSetupProgress(finishing);
      return;
    }

    if (hasConfiguredSource && sources.length > 0 && !chatSetupSubmitting) {
      appendHeading(doc, section, 'h4', 'Use a model that is already connected');
      const copy = doc.createElement('p');
      copy.className = 'ai-models-chat-setup-helper';
      copy.textContent =
        'Your provider is connected, but Chat still needs a default model.';
      section.appendChild(copy);
      if (
        chatSetupExistingSourceId === null
        || !sources.some((source) => source.id === chatSetupExistingSourceId)
      ) {
        chatSetupExistingSourceId = sources[0]!.id;
      }
      const sourceLabel = doc.createElement('label');
      sourceLabel.className = 'ai-models-field';
      appendText(doc, sourceLabel, 'Chat model');
      const sourceSelect = doc.createElement('select') as HTMLSelectElement;
      sourceSelect.setAttribute(AI_MODELS_CHAT_SETUP_SOURCE_ATTR, '');
      for (const source of sources) {
        const option = doc.createElement('option') as HTMLOptionElement;
        option.value = source.id;
        option.textContent = source.label;
        if (source.id === chatSetupExistingSourceId) {
          option.setAttribute('selected', '');
        }
        sourceSelect.appendChild(option);
      }
      sourceSelect.value = chatSetupExistingSourceId;
      sourceSelect.addEventListener('change', () => {
        if (isChatModelSourceId(sourceSelect.value)) {
          chatSetupExistingSourceId = sourceSelect.value;
        }
      });
      sourceLabel.appendChild(sourceSelect);
      section.appendChild(sourceLabel);
      const useButton = appendButton(
        doc,
        section,
        'Use this model and start chatting',
        () => {
          if (chatSetupExistingSourceId !== null) {
            void useExistingChatSource(chatSetupExistingSourceId);
          }
        },
        [[AI_MODELS_CHAT_SETUP_SUBMIT_ATTR, 'existing']],
      );
      useButton.className = 'rx-btn rx-btn-primary ai-models-chat-setup-submit';
      if (!opts.runSetDefaultModelPref) useButton.disabled = true;
      appendChatSetupExits(section, false);
      parent.appendChild(section);
      restoreChatSetupFocus(sourceSelect, AI_MODELS_CHAT_SETUP_SOURCE_ATTR);
      restoreChatSetupFocus(useButton, AI_MODELS_CHAT_SETUP_SUBMIT_ATTR);
      return;
    }

    const providerLabel = doc.createElement('label');
    providerLabel.className = 'ai-models-field';
    appendText(doc, providerLabel, 'Provider');
    const providerSelect = doc.createElement('select') as HTMLSelectElement;
    providerSelect.setAttribute(AI_MODELS_CHAT_SETUP_PROVIDER_ATTR, '');
    for (const provider of CHAT_SETUP_PROVIDERS) {
      const option = doc.createElement('option') as HTMLOptionElement;
      option.value = provider.id;
      option.textContent = provider.label;
      if (provider.id === chatSetupDraft.provider) {
        option.setAttribute('selected', '');
      }
      providerSelect.appendChild(option);
    }
    providerSelect.value = chatSetupDraft.provider;
    providerSelect.disabled = chatSetupSubmitting;
    providerLabel.appendChild(providerSelect);
    section.appendChild(providerLabel);

    const modelInput = appendInput(
      doc,
      section,
      'Model',
      chatSetupDraft.model,
      [
        [AI_MODELS_CHAT_SETUP_MODEL_ATTR, ''],
        ['autocomplete', 'off'],
        ['spellcheck', 'false'],
      ],
    );
    modelInput.addEventListener('input', () => {
      chatSetupDraft.model = modelInput.value;
    });
    if (chatSetupSubmitting) modelInput.readOnly = true;
    const modelHint = doc.createElement('span');
    modelHint.className = 'ai-models-chat-setup-helper';
    modelHint.textContent = 'This suggestion is editable if your provider gave you a different model ID.';
    section.appendChild(modelHint);

    const keyInput = appendInput(
      doc,
      section,
      'API key',
      chatSetupDraft.apiKey,
      [
        [AI_MODELS_CHAT_SETUP_KEY_ATTR, ''],
        ['autocomplete', 'off'],
      ],
    );
    keyInput.type = 'password';
    keyInput.addEventListener('input', () => {
      chatSetupDraft.apiKey = keyInput.value;
    });
    if (chatSetupSubmitting) keyInput.readOnly = true;
    const keyHint = doc.createElement('span');
    keyHint.className = 'ai-models-chat-setup-helper';
    keyHint.textContent =
      'The key is stored server-side; Recued never sends it back to this browser.';
    section.appendChild(keyHint);

    const baseUrlWrap = doc.createElement('div');
    baseUrlWrap.className = 'ai-models-chat-setup-custom';
    baseUrlWrap.setAttribute(
      'data-active',
      chatSetupDraft.provider === 'openai-compatible' ? 'true' : 'false',
    );
    const baseUrlInput = appendInput(
      doc,
      baseUrlWrap,
      'Base URL',
      chatSetupDraft.baseUrl,
      [
        [AI_MODELS_CHAT_SETUP_BASE_URL_ATTR, ''],
        ['placeholder', 'https://example.com/v1'],
        ['autocomplete', 'url'],
      ],
    );
    baseUrlInput.addEventListener('input', () => {
      chatSetupDraft.baseUrl = baseUrlInput.value;
    });
    if (chatSetupSubmitting) baseUrlInput.readOnly = true;
    section.appendChild(baseUrlWrap);

    const submitOnEnter = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter') return;
      if (event.isComposing) return;
      event.preventDefault();
      void saveNewChatSource();
    };
    modelInput.addEventListener('keydown', submitOnEnter);
    keyInput.addEventListener('keydown', submitOnEnter);
    baseUrlInput.addEventListener('keydown', submitOnEnter);

    providerSelect.addEventListener('change', () => {
      if (!isChatSetupProvider(providerSelect.value)) return;
      const previous = CHAT_SETUP_PROVIDERS.find(
        (provider) => provider.id === chatSetupDraft.provider,
      )!;
      const next = CHAT_SETUP_PROVIDERS.find(
        (provider) => provider.id === providerSelect.value,
      )!;
      const mayReplaceModel =
        chatSetupDraft.model.trim().length === 0
        || chatSetupDraft.model === previous.suggestedModel;
      // A masked credential is easy to overlook. Never carry one across a
      // provider change where it would be bound to a different API host.
      chatSetupDraft.apiKey = '';
      keyInput.value = '';
      chatSetupDraft.provider = next.id;
      if (mayReplaceModel) {
        chatSetupDraft.model = next.suggestedModel;
        modelInput.value = next.suggestedModel;
      }
      keyInput.setAttribute('placeholder', next.keyPlaceholder);
      baseUrlWrap.setAttribute(
        'data-active',
        next.id === 'openai-compatible' ? 'true' : 'false',
      );
    });
    const provider = CHAT_SETUP_PROVIDERS.find(
      (candidate) => candidate.id === chatSetupDraft.provider,
    )!;
    keyInput.setAttribute('placeholder', provider.keyPlaceholder);

    const save = appendButton(
      doc,
      section,
      chatSetupSubmitting ? 'Saving setup…' : 'Save and start chatting',
      () => {
        void saveNewChatSource();
      },
      [[AI_MODELS_CHAT_SETUP_SUBMIT_ATTR, 'new']],
    );
    save.className = 'rx-btn rx-btn-primary ai-models-chat-setup-submit';
    save.disabled =
      !opts.runSetLLMSlot
      || !opts.runSetDefaultModelPref;
    if (chatSetupSubmitting) {
      save.setAttribute('aria-disabled', 'true');
      save.setAttribute('aria-busy', 'true');
    }
    if (!opts.runSetLLMSlot || !opts.runSetDefaultModelPref) {
      const unavailable = doc.createElement('p');
      unavailable.className = 'ai-models-chat-setup-helper';
      unavailable.textContent =
        'This server does not expose the settings needed to finish Chat setup.';
      section.appendChild(unavailable);
    }
    appendChatSetupExits(section, false);
    parent.appendChild(section);
    restoreChatSetupFocus(providerSelect, AI_MODELS_CHAT_SETUP_PROVIDER_ATTR);
    restoreChatSetupFocus(modelInput, AI_MODELS_CHAT_SETUP_MODEL_ATTR);
    restoreChatSetupFocus(keyInput, AI_MODELS_CHAT_SETUP_KEY_ATTR);
    restoreChatSetupFocus(baseUrlInput, AI_MODELS_CHAT_SETUP_BASE_URL_ATTR);
    restoreChatSetupFocus(save, AI_MODELS_CHAT_SETUP_SUBMIT_ATTR);
  };

  /** Switch the internal sub-view without rebuilding its unsaved form DOM. */
  interface AiTabItem {
    id: AiModelsTab;
    btn: HTMLButtonElement;
    panel: HTMLElement;
  }
  let aiTabItems: AiTabItem[] = [];

  const ownedFocusAttrs = [
    AI_MODELS_PROMPT_TEXT_ATTR,
    AI_MODELS_PROMPT_POLICY_ATTR,
    AI_MODELS_PROMPT_SAVE_ATTR,
    AI_MODELS_PROMPT_LOAD_DEFAULT_ATTR,
    AI_MODELS_PROMPT_TRANSPORT_RESET_ATTR,
    AI_MODELS_SLOT_FIELD_ATTR,
    AI_MODELS_EMBEDDINGS_FIELD_ATTR,
    AI_MODELS_SLOT_SAVE_ATTR,
    AI_MODELS_SLOT_TEST_ATTR,
    AI_MODELS_SLOT_CLEAR_ATTR,
    AI_MODELS_SLOT_CLEAR_CANCEL_ATTR,
    AI_MODELS_SLOT_CLEAR_CONFIRM_ATTR,
    AI_MODELS_POOL_ADD_FIELD_ATTR,
    AI_MODELS_POOL_ADD_ATTR,
    AI_MODELS_POOL_TOGGLE_ATTR,
    AI_MODELS_POOL_REMOVE_ATTR,
    AI_MODELS_POOL_REMOVE_CANCEL_ATTR,
    AI_MODELS_POOL_REMOVE_CONFIRM_ATTR,
    AI_MODELS_CATALOG_MODE_SELECT_ATTR,
    AI_MODELS_MODEL_PREF_BUTTON_ATTR,
    AI_MODELS_BUDGET_INPUT_ATTR,
    AI_MODELS_BUDGET_SAVE_ATTR,
    AI_MODELS_ALLOW_BYOK_TOGGLE_ATTR,
    AI_MODELS_PAUSE_BUTTON_ATTR,
  ] as const;
  interface OwnedFocusSnapshot {
    attr: (typeof ownedFocusAttrs)[number];
    value: string;
    selection: {
      start: number;
      end: number;
      direction: 'forward' | 'backward' | 'none';
    } | null;
  }

  const captureOwnedFocus = (): OwnedFocusSnapshot | null => {
    const active = (doc as Partial<Document>).activeElement as
      | (HTMLElement & {
          selectionStart?: number | null;
          selectionEnd?: number | null;
          selectionDirection?: 'forward' | 'backward' | 'none' | null;
        })
      | null
      | undefined;
    if (active === undefined || active === null) return null;
    for (const attr of ownedFocusAttrs) {
      const value = active.getAttribute?.(attr);
      if (value === null || value === undefined) continue;
      const selection = typeof active.selectionStart === 'number'
        && typeof active.selectionEnd === 'number'
        ? {
            start: active.selectionStart,
            end: active.selectionEnd,
            direction: active.selectionDirection ?? 'none' as const,
          }
        : null;
      return { attr, value, selection };
    }
    return null;
  };

  const restoreOwnedFocus = (snapshot: OwnedFocusSnapshot | null): boolean => {
    if (snapshot === null || typeof dynamicHost.querySelectorAll !== 'function') {
      return false;
    }
    const candidates = dynamicHost.querySelectorAll(`[${snapshot.attr}]`);
    for (const candidate of Array.from(candidates)) {
      const element = candidate as HTMLElement & {
        setSelectionRange?: (
          start: number,
          end: number,
          direction?: 'forward' | 'backward' | 'none',
        ) => void;
      };
      if (element.getAttribute(snapshot.attr) !== snapshot.value) continue;
      element.focus?.({ preventScroll: true });
      if (
        snapshot.selection !== null
        && typeof element.setSelectionRange === 'function'
      ) {
        const { start, end, direction } = snapshot.selection;
        element.setSelectionRange(start, end, direction);
      }
      return true;
    }
    return false;
  };

  const activateAiTab = (tab: AiModelsTab, focus = false): void => {
    aiTab = tab;
    for (const item of aiTabItems) {
      const active = item.id === tab;
      item.btn.setAttribute('aria-selected', active ? 'true' : 'false');
      item.btn.setAttribute('tabindex', active ? '0' : '-1');
      item.btn.setAttribute('data-active', active ? 'true' : 'false');
      item.panel.setAttribute('data-active', active ? 'true' : 'false');
    }
    if (focus) {
      aiTabItems.find((item) => item.id === tab)?.btn.focus?.({
        preventScroll: true,
      });
    }
  };

  const setAiTab = (tab: AiModelsTab): void => {
    if (disposed) return;
    activateAiTab(tab, true);
  };

  const render = (): void => {
    if (disposed) return;
    const ownedFocus = captureOwnedFocus();
    poolRemoveFocusTrap?.release();
    poolRemoveFocusTrap = null;
    renderedPoolRemovePanel = null;
    renderedPoolRemoveCancel = null;
    renderedPoolRemoveConfirm = null;
    slotClearFocusTrap?.release();
    slotClearFocusTrap = null;
    renderedSlotClearPanel = null;
    renderedSlotClearCancel = null;
    renderedSlotClearConfirm = null;
    const active = (doc as Partial<Document>).activeElement as
      HTMLElement | null | undefined;
    const focusedTab = active !== undefined && active !== null
      ? active.getAttribute?.(AI_MODELS_TAB_ATTR) ?? null
      : null;
    wrapper.setAttribute(AI_MODELS_PAGE_STATE_ATTR, state);
    removeChildren(dynamicHost);
    if (chatSetupMode) {
      renderChatSetup(dynamicHost);
      return;
    }
    // The settings route already renders the section's "AI / Models"
    // heading (<h2>); the page no longer repeats it as an <h3> (the
    // duplicate-header review finding).
    if (state === 'loading') {
      appendText(doc, dynamicHost, 'Loading AI configuration.');
    }
    if (loadErrors.length > 0) {
      const list = doc.createElement('ul');
      for (const err of loadErrors) {
        const item = doc.createElement('li');
        item.textContent = err;
        list.appendChild(item);
      }
      dynamicHost.appendChild(list);
    }
    if (actionError !== null) {
      const alert = doc.createElement('div');
      alert.setAttribute(AI_MODELS_ACTION_ERROR_ATTR, '');
      alert.setAttribute('role', 'alert');
      alert.textContent = actionError;
      dynamicHost.appendChild(alert);
    }

    // ── Internal sub-view tab strip + one panel per tab ─────────────
    // All panels stay in the DOM; CSS hides the inactive ones off
    // `data-active`, so the page reads as a focused view instead of a
    // long scroll. Mirrors the Housekeeping panel's tab pattern.
    const tabStrip = doc.createElement('nav');
    tabStrip.className = 'ai-models-tabs';
    tabStrip.setAttribute('role', 'tablist');
    tabStrip.setAttribute('aria-label', 'AI / Models sections');
    tabStrip.setAttribute('aria-orientation', 'horizontal');
    aiTabItems = [];
    for (const tab of AI_MODELS_TABS) {
      const tabDomId = `recued-ai-models-${tab.id}-tab`;
      const panelDomId = `recued-ai-models-${tab.id}-panel`;
      const btn = appendButton(
        doc,
        tabStrip,
        tab.label,
        () => {
          setAiTab(tab.id);
        },
        [
          [AI_MODELS_TAB_ATTR, tab.id],
          ['role', 'tab'],
          ['id', tabDomId],
          ['aria-controls', panelDomId],
          ['aria-selected', aiTab === tab.id ? 'true' : 'false'],
          ['tabindex', aiTab === tab.id ? '0' : '-1'],
          ['data-active', aiTab === tab.id ? 'true' : 'false'],
        ],
      );
      btn.className = 'ai-models-tab';
      btn.addEventListener('keydown', (event) => {
        const currentIndex = aiTabItems.findIndex((item) => item.id === tab.id);
        if (currentIndex < 0) return;
        let nextIndex: number | null = null;
        if (event.key === 'ArrowRight') {
          nextIndex = (currentIndex + 1) % aiTabItems.length;
        } else if (event.key === 'ArrowLeft') {
          nextIndex = (currentIndex - 1 + aiTabItems.length) % aiTabItems.length;
        } else if (event.key === 'Home') {
          nextIndex = 0;
        } else if (event.key === 'End') {
          nextIndex = aiTabItems.length - 1;
        }
        if (nextIndex === null) return;
        event.preventDefault();
        setAiTab(aiTabItems[nextIndex]!.id);
      });

      const panel = doc.createElement('div');
      panel.className = 'ai-models-tabpanel';
      panel.setAttribute(AI_MODELS_TAB_PANEL_ATTR, tab.id);
      panel.setAttribute('id', panelDomId);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tabDomId);
      aiTabItems.push({ id: tab.id, btn, panel });
    }
    dynamicHost.appendChild(tabStrip);

    // ⛔ Built by LOOKUP against the declared tab list, not by accumulating
    // whatever the loop happened to produce. The map used to be
    // `{} as Record<AiModelsTab, HTMLElement>`, which asserted every tab had a
    // panel — a declared tab with no panel became `undefined` typed as an
    // element, and the failure would surface as a blank tab far from here.
    const panelById = new Map(aiTabItems.map((item) => [item.id, item.panel]));
    const panels = totalRecord(AI_MODELS_TAB_IDS, (id) => {
      const panel = panelById.get(id);
      if (panel === undefined) {
        throw new Error(`ai-models: no panel built for declared tab '${id}'`);
      }
      return panel;
    });
    for (const item of aiTabItems) dynamicHost.appendChild(item.panel);
    activateAiTab(aiTab);

    renderModelPreference(panels.preference);
    renderChatBehaviour(panels.preference);
    renderByok(panels.providers);
    renderFreePool(panels.providers);
    renderEmbeddingsSlot(panels.providers);
    renderTranscriptionSlot(panels.providers);
    renderSlotClearDialog(panels.providers);
    renderPrompts(panels.prompts);
    renderAiPolicy(panels.usage);
    renderBudget(panels.usage);
    // The LLM result cache card is a persistent sub-mount — re-parent its
    // host into the Usage panel each render (the sub-mount keeps working).
    if (cacheHost !== null) panels.usage.appendChild(cacheHost);
    if (renderedPoolRemovePanel !== null) {
      poolRemoveFocusTrap = wireFocusTrap({
        document: doc,
        getContainer: () => renderedPoolRemovePanel,
        initialFocus: false,
        restoreFocus: false,
      });
    }
    if (renderedSlotClearPanel !== null) {
      slotClearFocusTrap = wireFocusTrap({
        document: doc,
        getContainer: () => renderedSlotClearPanel,
        initialFocus: false,
        restoreFocus: false,
      });
    }
    let focusRestored = false;
    if (slotClearNeedsInitialFocus) {
      slotClearNeedsInitialFocus = false;
      focusRestored = focusRenderedSlotClearCancel();
    }
    if (!focusRestored && slotClearNeedsConfirmFocus) {
      slotClearNeedsConfirmFocus = false;
      focusRestored = focusRenderedSlotClearConfirm();
    }
    if (poolRemoveNeedsInitialFocus) {
      poolRemoveNeedsInitialFocus = false;
      focusRestored = focusRenderedPoolRemoveCancel();
    }
    if (!focusRestored && poolRemoveNeedsConfirmFocus) {
      poolRemoveNeedsConfirmFocus = false;
      focusRestored = focusRenderedPoolRemoveConfirm();
    }
    if (!focusRestored) focusRestored = restoreOwnedFocus(ownedFocus);
    const slotClearFocusKey = slotClearFocusAfterRender;
    slotClearFocusAfterRender = null;
    if (slotClearFocusKey !== null && !focusRestored) {
      focusRestored = restoreOwnedFocus({
        attr: AI_MODELS_SLOT_CLEAR_ATTR,
        value: slotClearFocusKey,
        selection: null,
      });
    }
    const poolFocus = poolFocusAfterRender;
    poolFocusAfterRender = null;
    if (poolFocus !== null && !focusRestored) {
      focusRestored = restoreOwnedFocus({ ...poolFocus, selection: null });
      if (!focusRestored && poolFocus.attr === AI_MODELS_POOL_REMOVE_ATTR) {
        focusRestored = restoreOwnedFocus({
          attr: AI_MODELS_POOL_ADD_ATTR,
          value: '',
          selection: null,
        });
      }
    }
    if (!focusRestored && isAiModelsTab(focusedTab)) {
      aiTabItems.find((item) => item.id === focusedTab)?.btn.focus?.({
        preventScroll: true,
      });
    }
  };

  /** Re-read the prompt state from the server. Called after every write —
   *  `is_default` and the effective prompt are both server-derived, so the
   *  client never guesses them. */
  const reloadLlmPrompts = async (): Promise<void> => {
    if (!opts.runGetLlmPrompts) return;
    const snapshot = await opts.runGetLlmPrompts();
    if (disposed) return;
    llmPrompts = [...snapshot.prompts];
    render();
  };

  const refresh = async (): Promise<void> => {
    state = 'loading';
    loadErrors = [];
    render();
    const tasks: Array<Promise<void>> = [];
    if (!chatSetupMode && opts.runGetLlmPrompts) {
      tasks.push(
        opts.runGetLlmPrompts()
          .then((snapshot) => {
            llmPrompts = [...snapshot.prompts];
          })
          .catch((err) => {
            loadErrors.push(`system prompts: ${stringifyError(err)}`);
          }),
      );
    }
    if (opts.runGetDefaultModelPref) {
      tasks.push(
        opts.runGetDefaultModelPref()
          .then((snapshot) => {
            modelPrefSnapshot = snapshot;
          })
          .catch((err) => {
            loadErrors.push(`model preference: ${stringifyError(err)}`);
          }),
      );
    }
    if (opts.runGetRollingBrief) {
      tasks.push(
        opts.runGetRollingBrief()
          .then((snapshot) => {
            rollingBriefSnapshot = snapshot;
          })
          .catch((err) => {
            // ⛔ A FAILED READ LEAVES THE SNAPSHOT NULL, so the projection stays
            //   'loading' and the control renders as unknown. Defaulting to
            //   `false` here would show the brief as OFF on a server where it is
            //   ON — the same "0 tokens vs we could not ask" confusion the usage
            //   read avoids one block below.
            loadErrors.push(`chat behaviour: ${stringifyError(err)}`);
          }),
      );
    }
    if (opts.runGetLLMConfig) {
      tasks.push(
        opts.runGetLLMConfig()
          .then((snapshot) => {
            llmConfig = cloneConfig(snapshot.config);
          })
          .catch((err) => {
            loadErrors.push(`LLM config: ${stringifyError(err)}`);
          }),
      );
    }
    if (opts.runGetLLMUsage) {
      tasks.push(
        opts.runGetLLMUsage()
          .then((usage) => { llmUsage = usage; })
          // ⛔ SOFT, unlike the config read above. A server too old to answer,
          // or one with no tracker wired, must not put an error banner on a
          // page that is otherwise working — the usage lines simply do not
          // render, which is honest: nothing was learned, so nothing is shown.
          .catch(() => { llmUsage = null; }),
      );
    }
    if (!chatSetupMode && opts.runGetConfigSchema) {
      tasks.push(
        opts.runGetConfigSchema()
          .then((snapshot) => {
            configSchema = [...snapshot.schema];
          })
          .catch((err) => {
            loadErrors.push(`config schema: ${stringifyError(err)}`);
          }),
      );
    }
    if (!chatSetupMode && opts.runReadHousekeepingConfig) {
      tasks.push(
        opts.runReadHousekeepingConfig()
          .then((snapshot) => {
            housekeepingConfig = snapshot;
          })
          .catch((err) => {
            loadErrors.push(`AI usage policy: ${stringifyError(err)}`);
          }),
      );
    }
    await Promise.all(tasks);
    if (disposed) return;
    // Both the default snapshot + the LLM config have settled — derive the
    // picker model from BOTH (the options are the configured sources).
    recomputeModelPreference();
    // Same for global chat behaviour: the brief snapshot AND the LLM config
    // (whose `catalog_modes` is the catalog half) have both landed by here.
    recomputeChatBehaviour();
    state = loadErrors.length > 0 ? 'error' : 'ready';
    render();
  };

  // D-174 R28 — apply a just-written config locally AFTER the server
  // confirmed the field-level write. Re-derives the default picker since a
  // source may have appeared / disappeared, changing the selection match.
  // (Writes go through the field-level `runSetLLMSlot` / `runUpsert…` /
  // `runRemove…` callers; this only mirrors the confirmed result in the UI.)
  const commitLocal = (next: LlmConfigRecord): void => {
    llmConfig = cloneConfig(next);
    recomputeModelPreference();
    recomputeChatBehaviour();
    render();
  };

  const api: AiModelsPageMount = {
    getState: () => ({
      state,
      modelPreference,
      chatBehaviour,
      llmConfig: llmConfig === null ? null : cloneConfig(llmConfig),
      configSchema: [...configSchema],
      housekeepingConfig,
      llmPrompts: [...llmPrompts],
      loadErrors: [...loadErrors],
      failLoud: computeFailLoud(modelPreference),
    }),
    refresh: () => {
      pendingLoad = refresh();
      return pendingLoad;
    },
    whenLoaded: () => pendingLoad,
    hasInFlightWork: hasAiModelsInFlightWork,
    setModelPreference: async (sourceId) => {
      // D-174 R28 Slice A — the picker and the rpc both speak `source_id`, so
      // we persist the chosen id directly (no layer/hint round-trip; the server
      // resolves source_id → {layer, model_hint} live). Guard against a stale id
      // (the source vanished between render + click).
      const known =
        modelPreference.kind === 'resolved'
        && modelPreference.options.some((o) => o.id === sourceId);
      if (!known) return;
      await persistModelPreference(sourceId);
    },
    saveByokSlot: async (slotKey, patch) => {
      if (!opts.runSetLLMSlot) {
        throw new Error('AI / Models: server.setLLMSlot caller is not wired');
      }
      const current = getSlot(llmConfig, slotKey) ?? {};
      // `current` is the REDACTED slot (carries `has_key`, never `api_key`).
      // Strip the wire-only fields so they don't ride back to the server.
      const carry = { ...current };
      delete carry.has_key;
      delete carry.api_key;
      const nextSlot: LlmSlotRecord = {
        ...carry,
        provider: patch.provider.trim(),
        model: patch.model.trim(),
        // Blank => empty string: the server PRESERVES the existing key (the
        // secret never crossed the wire so we can't echo it). A typed value
        // sets the new key.
        api_key:
          patch.api_key !== undefined && patch.api_key.trim().length > 0
            ? patch.api_key
            : '',
        speed: patch.speed ?? (slotKey === 'slot_1' ? 'fast' : 'thinking'),
        supports_json: patch.supports_json ?? asBoolean(current.supports_json, true),
      };
      if (patch.base_url !== undefined) {
        if (patch.base_url.trim().length > 0) {
          nextSlot.base_url = patch.base_url.trim();
        } else {
          delete nextSlot.base_url;
        }
      }
      if (patch.daily_budget_tokens !== undefined) {
        // 0 / non-positive clears the cap (unlimited); a positive value sets it.
        if (patch.daily_budget_tokens > 0) {
          nextSlot.daily_budget_tokens = patch.daily_budget_tokens;
        } else {
          delete nextSlot.daily_budget_tokens;
        }
      }
      const contextWindowTokens = asPositiveSafeInteger(
        patch.context_window_tokens,
      );
      if (contextWindowTokens !== undefined) {
        nextSlot.context_window_tokens = contextWindowTokens;
      } else {
        const sameModelCapability =
          asString(current.provider) === nextSlot.provider
          && asString(current.model) === nextSlot.model
          && asString(current.base_url) === asString(nextSlot.base_url);
        if (!sameModelCapability) {
          // Context capacity belongs to the concrete provider/model/endpoint,
          // not the slot key. Never carry a large-model claim onto a changed
          // model; leaving it absent makes llm_gateway fail closed until the
          // new capability is entered.
          delete nextSlot.context_window_tokens;
        }
      }
      // Field-level write: only this slot crosses the wire, so a concurrent
      // edit to the OTHER slot can't clobber it (vs the old whole-blob save).
      await opts.runSetLLMSlot({ slot_key: slotKey, slot: nextSlot });
      // Mirror the server's redacted shape locally: drop the api_key marker
      // and carry `has_key`, computed the same way the server resolves the
      // blank-preserve (key typed => set; blank + unchanged provider+base_url
      // => the stored key is preserved; otherwise it is dropped). Without
      // this the slot would flip to "keyless" after a metadata-only save.
      const keyProvided =
        patch.api_key !== undefined && patch.api_key.trim().length > 0;
      const sameContext =
        asString(current.provider) === nextSlot.provider
        && asString(current.base_url) === asString(nextSlot.base_url);
      const localHasKey = keyProvided || (current.has_key === true && sameContext);
      const next = cloneConfig(llmConfig);
      if (localHasKey) {
        const localSlot: LlmSlotRecord = { ...nextSlot };
        delete localSlot.api_key;
        localSlot.has_key = true;
        next[slotKey] = localSlot;
      } else {
        // A blank key with a CHANGED provider/base_url leaves the slot with no
        // key; the server requires one for EVERY slot (loadSlot drops a keyless
        // one, local or remote), so mirror that as unconfigured rather than
        // showing a slot the server just dropped.
        next[slotKey] = null;
      }
      byokSlotDrafts.delete(slotKey);
      commitLocal(next);
    },
    clearByokSlot: async (slotKey) => {
      if (!opts.runSetLLMSlot) {
        throw new Error('AI / Models: server.setLLMSlot caller is not wired');
      }
      await opts.runSetLLMSlot({ slot_key: slotKey, slot: null });
      const next = cloneConfig(llmConfig);
      next[slotKey] = null;
      byokSlotDrafts.delete(slotKey);
      commitLocal(next);
    },
    saveEmbeddingsSlot: async (patch) => {
      if (!opts.runSetEmbeddingsSlot) {
        throw new Error('AI / Models: server.setEmbeddingsSlot caller is not wired');
      }
      const current = getEmbeddingsSlot(llmConfig) ?? {};
      // `current` is the REDACTED slot (carries `has_key`, never `api_key`).
      const carry = { ...current };
      delete carry.has_key;
      delete carry.api_key;
      const nextSlot: LlmSlotRecord = {
        ...carry,
        provider: patch.provider.trim(),
        model: patch.model.trim(),
        // Blank => empty string: the server PRESERVES the existing key (the
        // secret never crossed the wire). A typed value sets the new key.
        api_key:
          patch.api_key !== undefined && patch.api_key.trim().length > 0
            ? patch.api_key
            : '',
      };
      if (patch.base_url !== undefined) {
        if (patch.base_url.trim().length > 0) {
          nextSlot.base_url = patch.base_url.trim();
        } else {
          delete nextSlot.base_url;
        }
      }
      await opts.runSetEmbeddingsSlot({ slot: nextSlot });
      // Mirror the server's redacted shape locally (same blank-preserve
      // resolution as saveByokSlot): key typed => set; blank + unchanged
      // provider+base_url => stored key preserved; otherwise dropped.
      const keyProvided =
        patch.api_key !== undefined && patch.api_key.trim().length > 0;
      const sameContext =
        asString(current.provider) === nextSlot.provider
        && asString(current.base_url) === asString(nextSlot.base_url);
      const localHasKey = keyProvided || (current.has_key === true && sameContext);
      const next = cloneConfig(llmConfig);
      if (localHasKey) {
        const localSlot: LlmSlotRecord = { ...nextSlot };
        delete localSlot.api_key;
        localSlot.has_key = true;
        next.embeddings_slot = localSlot;
      } else {
        // A blank key with a CHANGED provider/base_url leaves the slot keyless;
        // the server's loadSlot drops a keyless slot, so mirror it as cleared.
        next.embeddings_slot = null;
      }
      embeddingsSlotDraft = null;
      commitLocal(next);
    },
    saveTranscriptionSlot: async (patch) => {
      if (!opts.runSetTranscriptionSlot) {
        throw new Error('AI / Models: server.setTranscriptionSlot caller is not wired');
      }
      const current = asRecord(llmConfig?.transcription_slot) ?? {};
      const carry = { ...current };
      delete carry.has_key;
      delete carry.api_key;
      const nextSlot: LlmSlotRecord = {
        ...carry,
        provider: patch.provider.trim(),
        model: patch.model.trim(),
        // Blank ⇒ empty string: the server PRESERVES the stored key, which
        // never crossed the wire in the first place.
        api_key:
          patch.api_key !== undefined && patch.api_key.trim().length > 0
            ? patch.api_key
            : '',
      };
      if (patch.base_url !== undefined) {
        if (patch.base_url.trim().length > 0) nextSlot.base_url = patch.base_url.trim();
        else delete nextSlot.base_url;
      }
      await opts.runSetTranscriptionSlot({ slot: nextSlot });
      const keyProvided =
        patch.api_key !== undefined && patch.api_key.trim().length > 0;
      const sameContext =
        asString(current.provider) === nextSlot.provider
        && asString(current.base_url) === asString(nextSlot.base_url);
      const localHasKey = keyProvided || (current.has_key === true && sameContext);
      const next = cloneConfig(llmConfig);
      if (localHasKey) {
        const localSlot: LlmSlotRecord = { ...nextSlot };
        delete localSlot.api_key;
        localSlot.has_key = true;
        next.transcription_slot = localSlot;
      } else {
        // A blank key with a CHANGED provider/base_url leaves it keyless, and
        // the server's `loadSlot` drops a keyless slot — so mirror it cleared
        // rather than showing a card the server does not have.
        next.transcription_slot = null;
      }
      transcriptionSlotDraft = null;
      commitLocal(next);
    },
    clearTranscriptionSlot: async () => {
      if (!opts.runSetTranscriptionSlot) {
        throw new Error('AI / Models: server.setTranscriptionSlot caller is not wired');
      }
      await opts.runSetTranscriptionSlot({ slot: null });
      const next = cloneConfig(llmConfig);
      next.transcription_slot = null;
      transcriptionSlotDraft = null;
      commitLocal(next);
    },
    saveTranscriptionDailyRequests: async (limit) => {
      if (!opts.runSetTranscriptionDailyRequests) {
        throw new Error('AI / Models: server.setTranscriptionDailyRequests caller is not wired');
      }
      await opts.runSetTranscriptionDailyRequests({ limit });
      const next = cloneConfig(llmConfig);
      if (limit === null || limit <= 0) delete next.transcription_daily_requests;
      else next.transcription_daily_requests = limit;
      commitLocal(next);
    },
    saveTranscriptionLanguage: async (language) => {
      if (!opts.runSetTranscriptionLanguage) {
        throw new Error('AI / Models: server.setTranscriptionLanguage caller is not wired');
      }
      await opts.runSetTranscriptionLanguage({ language });
      const next = cloneConfig(llmConfig);
      // ⛔ Absent, not empty-string: auto-detect is the ABSENCE of a pin, and an
      // empty string is a value the provider would try to honour.
      if (language === null) delete next.transcription_language;
      else next.transcription_language = language;
      commitLocal(next);
    },
    clearEmbeddingsSlot: async () => {
      if (!opts.runSetEmbeddingsSlot) {
        throw new Error('AI / Models: server.setEmbeddingsSlot caller is not wired');
      }
      await opts.runSetEmbeddingsSlot({ slot: null });
      const next = cloneConfig(llmConfig);
      next.embeddings_slot = null;
      embeddingsSlotDraft = null;
      commitLocal(next);
    },
    addFreePoolApiEntry: async (entry) => {
      if (!opts.runUpsertFreePoolEntry) {
        throw new Error('AI / Models: server.upsertFreePoolEntry caller is not wired');
      }
      const record: FreePoolEntryRecord = {
        id: entry.id,
        type: 'api',
        provider: entry.provider,
        model: entry.model,
        api_key: entry.api_key,
        speed: entry.speed ?? 'fast',
        supports_json: entry.supports_json ?? true,
        enabled: entry.enabled ?? true,
        ...(entry.base_url !== undefined && entry.base_url.trim().length > 0
          ? { base_url: entry.base_url.trim() }
          : {}),
        ...(asPositiveSafeInteger(entry.context_window_tokens) !== undefined
          ? { context_window_tokens: entry.context_window_tokens }
          : {}),
      };
      await opts.runUpsertFreePoolEntry({ entry: record });
      // Mirror the redacted server shape locally — drop the plaintext key and
      // carry `has_key`, so page state matches what a re-read returns and the
      // typed secret doesn't linger in the local config clone.
      const localEntry: FreePoolEntryRecord = { ...record, has_key: true };
      delete localEntry.api_key;
      const next = cloneConfig(llmConfig);
      const pool = getPoolEntries(next).filter((row) => asString(row.id) !== entry.id);
      pool.push(localEntry);
      next.free_pool = pool;
      resetFreePoolAddDraft();
      commitLocal(next);
    },
    setFreePoolEntryEnabled: async (id, enabled) => {
      if (!opts.runSetFreePoolEntryEnabled) {
        throw new Error('AI / Models: server.setFreePoolEntryEnabled caller is not wired');
      }
      await opts.runSetFreePoolEntryEnabled({ id, enabled });
      const next = cloneConfig(llmConfig);
      next.free_pool = getPoolEntries(next).map((entry) =>
        asString(entry.id) === id ? { ...entry, enabled } : entry,
      );
      commitLocal(next);
    },
    removeFreePoolEntry: async (id) => {
      if (!opts.runRemoveFreePoolEntry) {
        throw new Error('AI / Models: server.removeFreePoolEntry caller is not wired');
      }
      await opts.runRemoveFreePoolEntry({ id });
      const currentPool = getPoolEntries(llmConfig);
      const removedIndex = currentPool.findIndex((entry) => asString(entry.id) === id);
      const remainingPool = currentPool.filter((entry) => asString(entry.id) !== id);
      if (poolRemoveDialogId === id) {
        const fallbackEntry = remainingPool.length > 0
          ? remainingPool[Math.min(Math.max(removedIndex, 0), remainingPool.length - 1)]
          : null;
        poolRemoveDialogId = null;
        poolRemovePending = false;
        poolRemoveNeedsInitialFocus = false;
        poolRemoveNeedsConfirmFocus = false;
        poolFocusAfterRender = fallbackEntry === null
          ? { attr: AI_MODELS_POOL_ADD_ATTR, value: '' }
          : {
              attr: AI_MODELS_POOL_REMOVE_ATTR,
              value: asString(fallbackEntry.id),
            };
      }
      const next = cloneConfig(llmConfig);
      next.free_pool = remainingPool;
      commitLocal(next);
    },
    setChatCatalogMode: async (source, mode) => {
      if (!opts.runSetChatCatalogMode) {
        throw new Error('AI / Models: server.setChatCatalogMode caller is not wired');
      }
      // Field-level write: only this source's mode crosses the wire, so a
      // concurrent edit to another source can't clobber it (the server does
      // a read-modify-write over the persisted `catalog_modes` map).
      await opts.runSetChatCatalogMode({ source_id: source, mode });
      // Mirror the server's map locally after it confirms: `null` clears the
      // source's override; a mode sets it. Drop the map entirely once empty
      // so getState() byte-matches an unconfigured re-read.
      const next = cloneConfig(llmConfig);
      const modes = { ...(asRecord(next.catalog_modes) ?? {}) };
      if (mode === null) {
        delete modes[source];
      } else {
        modes[source] = mode;
      }
      if (Object.keys(modes).length > 0) {
        next.catalog_modes = modes;
      } else {
        delete next.catalog_modes;
      }
      commitLocal(next);
    },
    saveLlmPrompt: async (surfaceId, draft) => {
      if (!opts.runSetLlmPrompt) {
        throw new Error('AI / Models: server.setLlmPrompt caller is not wired');
      }
      // A blank box means "reset", not "ship a model with no role at all" — the
      // server reads null and blank identically, and this keeps the local mirror
      // agreeing with it.
      //
      // 🔑 …AND SO DOES A BOX HOLDING THE BUILT-IN, which is what makes
      // `Load default` + `Save` a true reset rather than a copy. `null` is the
      // ONLY way the server expresses "default" (it deletes the row —
      // `config-schema.ts`, "absence is how the default is expressed"), so
      // storing byte-identical text instead would leave `is_default` false and
      // the badge reading "Customised" over text nobody customised. It would
      // also PIN that text: a later release changing the built-in would not
      // reach this server, silently, because the row still wins.
      const record = llmPrompts.find((p) => p.surface === surfaceId);
      const trimmed = draft.role_instructions.trim();
      const isBuiltIn = record !== undefined
        && trimmed === record.default_role_instructions.trim();
      const next = trimmed.length > 0 && !isBuiltIn ? trimmed : null;
      await opts.runSetLlmPrompt({
        surface: surfaceId,
        role_instructions: next,
        // ⚠ The wire role has no editor on the card, so a save must CARRY THE
        // STORED VALUE, never re-assert a client guess: `draft.role` is seeded
        // from the record and nothing mutates it. Sending the default here
        // would silently undo an owner whose provider rejects `system`.
        role: next === null ? null : (record?.role ?? draft.role),
        ...(surfaceId === 'llm_gateway'
          ? { caller_system_policy: draft.caller_system_policy }
          : {}),
      });
      // Re-read rather than mirror locally: `is_default` and the composed
      // preview are both server-derived (a cleared row falls back to the
      // built-in), and guessing either here is how the badge starts lying.
      promptDrafts.delete(surfaceId);
      await reloadLlmPrompts();
    },
    resetLlmPrompt: async (surfaceId) => {
      if (!opts.runSetLlmPrompt) {
        throw new Error('AI / Models: server.setLlmPrompt caller is not wired');
      }
      await opts.runSetLlmPrompt({
        surface: surfaceId,
        role_instructions: null,
        role: null,
        ...(surfaceId === 'llm_gateway' ? { caller_system_policy: null } : {}),
      });
      promptDrafts.delete(surfaceId);
      await reloadLlmPrompts();
    },
    setPromptDeliveryRoleToDefault: async (surfaceId) => {
      if (!opts.runSetLlmPrompt) {
        throw new Error('AI / Models: server.setLlmPrompt caller is not wired');
      }
      // ⚠ ROLE ONLY. `role_instructions: null` here would take the owner's text
      // with it — `null` is a delete on both fields independently, and this is
      // the escape hatch for a stuck transport role, not a reset of the prompt.
      // Re-send the text IN FORCE (the record, never the draft): the button is
      // beneath an editor that may hold unsaved edits, and a control labelled
      // "Deliver as system" must not commit them as a side effect.
      const record = llmPrompts.find((p) => p.surface === surfaceId);
      const inForce = record?.is_default === false
        ? record.role_instructions
        : null;
      await opts.runSetLlmPrompt({
        surface: surfaceId,
        role_instructions: inForce,
        role: null,
      });
      await reloadLlmPrompts();
    },
    setBudget: async (tokens) => {
      if (!opts.runSetConfigField) {
        throw new Error('AI / Models: server.setConfigField caller is not wired');
      }
      await opts.runSetConfigField({ key: 'llm.budget', value: tokens });
      configSchema = configSchema.map((field) =>
        field.key === 'llm.budget' ? { ...field, value: tokens } : field,
      );
      budgetDraft = null;
      render();
    },
    setAllowByokBackground: async (allow) => {
      if (!opts.runWriteHousekeepingConfig || housekeepingConfig === null) {
        throw new Error('AI / Models: housekeeping.config.write caller is not wired');
      }
      const result = await opts.runWriteHousekeepingConfig({
        preset: housekeepingConfig.preset,
        allow_byok_background: allow,
      });
      housekeepingConfig = result.effective;
      render();
    },
    setPauseBackgroundAiUntil: async (until) => {
      if (!opts.runWriteHousekeepingConfig || housekeepingConfig === null) {
        throw new Error('AI / Models: housekeeping.config.write caller is not wired');
      }
      const result = await opts.runWriteHousekeepingConfig({
        preset: housekeepingConfig.preset,
        pause_background_ai_until: until,
      });
      housekeepingConfig = result.effective;
      render();
    },
    cacheCard: () => cacheCard,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (cacheCard !== null) cacheCard.dispose();
      poolRemoveFocusTrap?.release();
      poolRemoveFocusTrap = null;
      slotClearFocusTrap?.release();
      slotClearFocusTrap = null;
      wrapper.remove();
    },
  };

  const unsubscribers: Array<() => void> = [];
  if (
    opts.subscribe !== undefined
    && (
      opts.runGetDefaultModelPref !== undefined
      || opts.runSetDefaultModelPref !== undefined
    )
  ) {
    unsubscribers.push(
      opts.subscribe('chat.default_model_pref_changed', (event) => {
        const maybe = event as {
          kind?: unknown;
          source_id?: unknown;
          updated_at?: unknown;
        };
        if (
          maybe.kind !== 'chat.default_model_pref_changed'
          || typeof maybe.updated_at !== 'number'
        ) {
          return;
        }
        // D-174 R28 Slice A — the Settings picker keys on `source_id` (the
        // event's transient `{layer, model_hint}` snapshot is for the chat-
        // thread reducer, not here). An off-list / absent id reads as `null`
        // (no selection) via `isChatModelSourceId` inside the builder.
        modelPrefSnapshot = {
          source_id: isChatModelSourceId(maybe.source_id)
            ? maybe.source_id
            : null,
          updated_at: maybe.updated_at,
        };
        modelPreference = reduceChatDefaultModelPrefChanged(
          modelPreference,
          modelPrefSnapshot,
          llmConfig,
        );
        render();
      }),
    );
  }

  render();
  pendingLoad = refresh();
  return api;
};

export const AI_MODELS_PAGE_STYLES = `
[${AI_MODELS_PAGE_ATTR}] {
  display: grid;
  gap: 14px;
}
[${AI_MODELS_CHAT_SETUP_ATTR}] {
  width: min(100%, 680px);
  box-sizing: border-box;
  padding: clamp(18px, 4vw, 30px) !important;
  border-radius: 12px !important;
  background: var(--surface);
}
[${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-eyebrow {
  margin: 0 0 8px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.09em;
}
[${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-intro {
  max-width: 58ch;
  margin: 0 0 18px;
  color: var(--fg-muted);
  line-height: 1.55;
}
[${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-field {
  max-width: 520px;
  margin-top: 14px;
  font-weight: 600;
}
[${AI_MODELS_CHAT_SETUP_ATTR}] input,
[${AI_MODELS_CHAT_SETUP_ATTR}] select {
  width: 100%;
  max-width: none;
  min-height: 42px;
  box-sizing: border-box;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
}
[${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-helper {
  display: block;
  max-width: 58ch;
  margin: 5px 0 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.45;
}
[${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-custom[data-active="false"] {
  display: none;
}
[${AI_MODELS_CHAT_SETUP_STATUS_ATTR}="loading"],
[${AI_MODELS_CHAT_SETUP_STATUS_ATTR}="saving"] {
  padding: 16px 0;
  color: var(--fg-muted);
}
[${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-ready {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--accent);
  border-radius: 9px;
  background: var(--surface-subtle);
}
[${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-ready p {
  margin: 0;
  color: var(--fg-muted);
}
[${AI_MODELS_CHAT_SETUP_ERROR_ATTR}] {
  max-width: 58ch;
  margin: 12px 0;
  padding: 10px 12px;
  border-left: 3px solid var(--danger);
  background: var(--surface-subtle);
  color: var(--fg);
}
[${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-submit.rx-btn {
  margin-top: 18px;
}
[${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
}
[${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-actions .rx-btn {
  margin: 0;
  text-decoration: none;
}
[${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-back {
  color: var(--fg-muted);
  font-size: 13px;
}
[${AI_MODELS_PAGE_ATTR}] section,
[${AI_MODELS_PAGE_ATTR}] .ai-models-slot,
[${AI_MODELS_PAGE_ATTR}] .ai-models-pool-row,
[${AI_MODELS_PAGE_ATTR}] .ai-models-pending {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
[${AI_MODELS_PAGE_ATTR}] h3,
[${AI_MODELS_PAGE_ATTR}] h4 {
  margin: 0 0 8px;
}
[${AI_MODELS_PAGE_ATTR}] button {
  margin: 8px 8px 0 0;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  padding: 16px;
  background: rgba(0, 0, 0, 0.52);
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-confirm-dialog {
  width: min(100%, 440px);
  box-sizing: border-box;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 18px;
  background: var(--surface);
  color: var(--fg);
  box-shadow: 0 18px 54px rgba(0, 0, 0, 0.28);
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-confirm-dialog p {
  margin: 0;
  color: var(--fg-muted);
  line-height: 1.5;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-confirm-dialog .ai-models-confirm-error {
  margin-top: 12px;
  color: var(--danger);
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-confirm-actions button {
  margin: 0;
}
[${AI_MODELS_POOL_REMOVE_CONFIRM_ATTR}],
[${AI_MODELS_SLOT_CLEAR_CONFIRM_ATTR}] {
  border-color: var(--danger);
  background: var(--danger);
  color: var(--on-danger, #fff);
}
/* Test connection — a verdict the owner can act on, not a status code. */
[${AI_MODELS_PAGE_ATTR}] .ai-models-probe {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: 6px;
  background: var(--bg-elevated, transparent);
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-probe[data-probe-ok='true'] {
  border-left-color: var(--accent);
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-probe[data-probe-ok='false'] {
  border-left-color: var(--danger);
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-probe-verdict {
  margin: 0;
  font-size: 13px;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-probe-facts {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-dim);
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-probe-detail {
  margin: 8px 0 0;
  padding: 8px;
  border-radius: 4px;
  border: 1px dashed var(--border);
  color: var(--text-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-x: auto;
}
/* System prompts — the textarea is the surface, so give it real room. */
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-badge {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-dim);
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-badge[${AI_MODELS_PROMPT_BADGE_ATTR}='custom'] {
  border-color: var(--accent);
  color: var(--accent);
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-body {
  margin: 0 0 10px;
  color: var(--text-dim);
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-text {
  display: block;
  width: 100%;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated, transparent);
  color: inherit;
  resize: vertical;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-always {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-always > summary {
  cursor: pointer;
  color: var(--text-dim);
  font-size: 12px;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-always-text {
  margin: 10px 0 0;
  padding: 10px;
  border-radius: 6px;
  border: 1px dashed var(--border);
  color: var(--text-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-x: auto;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
/* Sits between the box and its buttons — the one thing that belongs there,
   because it describes the box. */
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-status {
  margin: 6px 0 10px;
  font-size: 12px;
  color: var(--text-dim);
}
/* Off-default wire role. Not an error — a fact plus its undo. */
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-transport {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--text-dim);
}
/* The caller policy is its own decision, below the save row and fenced off it,
   so nothing reads as a destination for the prompt above. */
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-policy {
  margin-top: 14px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-prompt-policy > h4 {
  margin: 0 0 6px;
  font-size: 13px;
}
/* Internal sub-view tab strip — Preference / Providers / System prompts / Usage. */
[${AI_MODELS_PAGE_ATTR}] .ai-models-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
[${AI_MODELS_PAGE_ATTR}] button.ai-models-tab {
  box-sizing: border-box;
  min-height: 36px;
  margin: 0 0 -1px;
  appearance: none;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  font: inherit;
  font-size: 13px;
  color: var(--fg-muted);
  padding: 7px 10px;
  cursor: pointer;
}
[${AI_MODELS_PAGE_ATTR}] button.ai-models-tab:hover { color: var(--fg); }
[${AI_MODELS_PAGE_ATTR}] button.ai-models-tab[data-active="true"] {
  color: var(--fg);
  font-weight: 600;
  border-bottom-color: var(--accent);
}
[${AI_MODELS_PAGE_ATTR}] button.ai-models-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-tabpanel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-tabpanel[data-active="false"] { display: none; }
/* Model-preference picker reads as a real segmented control: the
   aria-pressed option carries the accent so the current source is
   obvious at a glance (review: the choices looked like three identical
   bare buttons). */
[${AI_MODELS_PAGE_ATTR}] .ai-models-choice-row {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-choice-row button {
  margin: 0;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-choice-row button[aria-pressed="true"] {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-field {
  display: grid;
  gap: 4px;
  margin-top: 8px;
  font-size: 13px;
}
[${AI_MODELS_PAGE_ATTR}] input {
  max-width: 420px;
  padding: 6px 8px;
}
[${AI_MODELS_PAGE_ATTR}] select {
  max-width: 420px;
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
}
/* Lever-2 per-slot (Phase 3) — the catalog-mode control's helper line. */
[${AI_MODELS_PAGE_ATTR}] .ai-models-hint {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--fg-muted);
}
/* Lever-2 per-slot (Phase 3) — the collapsible "how to choose" mode legend. */
[${AI_MODELS_PAGE_ATTR}] .ai-models-mode-legend {
  margin-top: 6px;
  font-size: 12px;
  color: var(--fg-muted);
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-mode-legend > summary {
  cursor: pointer;
  color: var(--fg);
  user-select: none;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-mode-legend dl {
  margin: 6px 0 0;
  display: grid;
  gap: 4px 10px;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-mode-legend dt {
  font-weight: 600;
  color: var(--fg);
  margin-top: 4px;
}
[${AI_MODELS_PAGE_ATTR}] .ai-models-mode-legend dd {
  margin: 0;
  line-height: 1.45;
}
[${AI_MODELS_FAIL_LOUD_ATTR}] {
  margin-top: 10px;
  border-left: 3px solid var(--danger);
  padding: 8px 10px;
  font-weight: 600;
}
[${AI_MODELS_PENDING_CONTROL_ATTR}] {
  color: var(--fg-muted);
}
@media (max-width: 640px) {
  [${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-actions {
    align-items: stretch;
    flex-direction: column;
  }
  [${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-actions .rx-btn,
  [${AI_MODELS_CHAT_SETUP_ATTR}] .ai-models-chat-setup-back {
    justify-content: center;
    text-align: center;
    width: 100%;
  }
}
`;
