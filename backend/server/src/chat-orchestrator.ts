/** D-137 / D-164 P6.3 — Server-side chat orchestrator: single AI main
 *  turn + tool dispatch loop.
 *
 *  The orchestrator runs the chat agent loop **server-side** per the
 *  D-148 architecture (server is the engine; webclient + Bridge are
 *  display + HID with no model calls + no tool dispatch). For a single
 *  user turn:
 *
 *    1. Build the chat tail snapshot from prior conversational rows.
 *    2. Persist the user message to `chat_messages` (encrypted via
 *       `chat` sub-DEK).
 *    3. Project the catalog the AI sees:
 *         - Self-target: union of `InternalToolRegistry.list()`,
 *           minus per-kind-disabled Tier 2 entries (Mary's Settings
 *           scope) and per-MCP-disabled Tier 3 entries.
 *         (⛔ D-228 slice 5 — the peer-target arm is retired; `picker_target`
 *         can only be `'self'`.)
 *       The catalog passed to the AI is the post-capability-filter
 *       union — no intent-driven narrowing happens here. The prompt-
 *       cache middleware (D-164 P4) takes over catalog assembly via
 *       `TurnContext.state` in a later slice; for now the inline
 *       projection here is the seam.
 *    4. Compose the AI packet inline (per D-164 P6.0 (b) decision —
 *       chat-orchestrator owns inline composition, no framework seam):
 *         - synthetic kernel manifest (`CHAT_MAIN_TURN_INGREDIENT_SLUG`)
 *         - system prompt (AIOutput shape framing)
 *         - prompt body (available_tools + commitment_context + assembled
 *           content parts (`chat_tail` + `user_message`) + prior_tool_calls)
 *         - per-turn force_layer + model_hint derived from session +
 *           channel default `'fast'` (D-164 P6.2 / P6.3 channel default)
 *       Calls the injected `executeAiCall` (the `@recued/llm`
 *       `executeLLM` closure pre-bound in `wire-chat-orchestrator.ts`)
 *       directly.
 *    5. Validate the AI body via `validateAIOutput`. On the INITIAL
 *       call: failure / executor throw / no-executor → ship empty-
 *       assistant; emit `engine.budget_exceeded` only when an
 *       executor was wired (no-executor stays silent — substrate-
 *       reachable test-harness / pre-LLM-config boot path). On a
 *       MID-LOOP reinvoke: the loop preserves the LAST valid AI
 *       response as the assistant content (the planning blurb from
 *       the prior successful round) + emits
 *       `recued.multi_turn.round_completed` (`aborted`) +
 *       `engine.budget_exceeded` to surface the failure (D-137
 *       Trio #B abort semantics preserved).
 *    6. Drive the cooperative tool loop (D-137 Trio #B):
 *         - dispatch every `tool_call` via `dispatch.dispatchTool`
 *           (existing P1.2 seam — broadcast + audit + tier derivation
 *           per dispatch),
 *         - reinvoke the AI with the accumulated `prior_tool_calls`
 *           threaded into a fresh packet body,
 *         - cap by `CHAT_MAIN_TURN_TOOL_LOOP_CAP`; emit
 *           `recued.multi_turn.round_*` + `loop_terminated`
 *           transparency events on the chat broadcast bus,
 *         - stream the FINAL synthesised response as one
 *           `chat.token_streamed` delta.
 *    7. Persist the assistant message + `tool_calls` provenance +
 *       emit `chat.message_complete` + `recued.token_usage`.
 *
 *  Per § A.2 amendment (2026-05-11) — the chat agent is internal-
 *  channel per the MCP-as-Agent-Channel invariant. The orchestrator
 *  MUST dispatch via `InternalToolRegistry.dispatch()` with
 *  `channel: 'internal_function_call'` + session_id; it MUST NOT loop
 *  back through the MCP wire (which would conflate channels — firing
 *  the wire-only audit trigger on Mary's own queries; see the
 *  `project_mcp_channel_invariant.md` rationale + the channel-isolation
 *  ratchet for the load-bearing token list).
 *
 *  Per § Wire A — every per-turn event lands on the D-121 broadcast
 *  bus so paired clients render the live conversation without
 *  polling. Multi-client coherence: a turn that lands on Mary's laptop
 *  also surfaces on her phone PWA.
 *
 *  No new audit kinds — re-uses the closed `chat_session_created` /
 *  `chat_message_sent` / `chat_tool_call` set from D-137 P1.
 */

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  computeKindGatedTier2Names,
  aggregateTokenUsageReports,
  INGREDIENT_KINDS,
  SAFE_DEFAULT_CHAT_CATALOG_KINDS,
  type ChatBroadcastEventKind,
  type ChatDispatchChannel,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ChatDataDiagnosisContext,
  type ChatMessage,
  type ChatModelHint,
  type ChatModelRoutingLayer,
  type ChatPlanExecutionReceipt,
  type ChatPickerTarget,
  type ChatSession,
  type ChatTailMessage,
  type ChatToolCall,
  type ChatToolCatalogScopeState,
  type ConnectionMcpAnnotationState,
  type ChatMessageAttachment,
  type ContractSnapshot,
  type ExecutionSource,
  type IngredientKind,
  type IngredientManifest,
  type InternalToolRegistry,
  type ModelTier,
  type RecuedServerSignature,
  type ServerEvent,
  type TransparencyEvent,
  type Tier1ToolName,
  type TokenUsageReport,
  type ToolEntry,
  type ToolTier,
  type ChatModelSourceId,
  type ChatCatalogDeliveryMode,
  CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE,
  isChatModelHint,
  isChatModelRoutingLayer,
  isChatModelSourceId,
  isTier1ToolName,
  executionSourceHasContract,
  executionSourceContractId,
} from '@recued/contracts';
import { planApproval as planApprovalModule, piiEgress } from '@recued/gateway';
import {
  runWithExecutionCaseVerificationContext,
} from './execution-case-verification-context.js';
import {
  createMiddlewareRegistry,
  runStream,
  type ContentPromptPart,
  type EntityPromptPart,
  type MiddlewareRegistry,
  type TextPromptPart,
  type TurnContext,
  type TurnExecutor,
  type TurnOutput,
} from '@recued/middleware';
import {
  PERSONAL_RECIPES_MATCHES_STATE_KEY,
  type DispatchPersonalRecipesResult,
  type PersonalRecipeMatch,
} from '@recued/middleware-recued';
import type { Channel, ChannelInbound, SessionStateStore } from '@recued/chat';
import {
  estimateConservativeMessagesTokens,
  transcribe,
  type LLMFinishReason,
  type LLMMessageRole,
  type TranscribeDeps,
} from '@recued/llm';
import type {
  LlmPromptSurface,
  ResolvedLlmSystemPrompt,
} from './llm-system-prompt.js';
import type { AuditLogStore } from '@recued/storage';
import {
  ChatVaultLockedError,
  type ChatStore,
  type RetainedAliasCandidate,
} from './storage/chat-store.js';
import type { EventBus } from './events/bus.js';
import {
  handleFileRead,
  type FileReadDeps,
  type FileReadResponse,
} from './collections/file/file-read-handler.js';
// D-160 spec-O-5 — the chat turn MECHANICS (per-round AI call +
// cooperative tool loop + in-turn enforcement + rich emits) live in
// `runChatTurn`; the orchestrator drives it through the framework
// `runStream` loop and ENACTs the registered hooks' before/after-turn
// decisions off the shared `state` (Stage 3, N.9) + finalize.
import {
  ChatContextLengthError,
  runChatTurn,
  type RunChatTurnPromptContent,
  type RunChatTurnResult,
} from './chat-turn-executor.js';
import { createChatPiiSlotOrderingSeeder } from './chat-pii-slot-ordering.js';
import {
  RECALL_SEARCH_TOOL_NAME,
  recallJoinedPieces,
  hasRegisteredRecallResult,
  registerRecallTurnSource,
  registerVisibleInteractionItemIds,
  registerVisibleRecallToolResult,
} from './chat-recall-search-tool.js';
import { chatCapacity, createServerChatChannel } from './chat-channel-factory.js';
// D-160 spec-O-5 Stage 3 — the turn concerns are REGISTERED HOOKS over the
// shared `state` (N.9): source-binding adapters wrap the real
// `standing-instructions` / `correction-learning` / `personal-recipes`
// D-160 middleware objects (see module doc). The orchestrator registers
// them into its per-turn stream registry; `runStream` drives them.
import {
  createChatStreamMiddlewares,
  CHAT_CATALOG_INPUTS_STATE_KEY,
  CHAT_CATALOG_RESULT_STATE_KEY,
  CHAT_TURN_AFTER_INPUTS_STATE_KEY,
  CORRECTION_LEARNING_MIDDLEWARE_ID,
  type ChatCatalogBuilder,
  type ChatCatalogInputs,
  type ChatScopeSearchInput,
  type ChatTurnAfterInputs,
} from './chat-stream-middleware.js';
import { TOOLS_SEARCH_TOOL_NAME } from './chat-tools-search-name.js';
import { PROMPT_CACHE_MIDDLEWARE_ID } from '@recued/middleware-prompt-cache';
// D-167 P5 S4 — the always-on PII bookend hooks + the wire-seam enactment.
// `pii-protect` (first `prompt`) / `pii-restore` (last `update`) bracket the
// source adapters; the executor closure WRAPS `executeAiCall` to alias every
// outbound packet + restore every returned body (N.9 ENACT).
import {
  createPiiEgressPlanForSession,
  readPiiEgressPlan,
  readPiiRedactionSummary,
  readPiiRestoredText,
  wrapExecuteAiCallForPii,
  type PiiEgressHookDeps,
} from './chat-pii-egress.js';
import type { RecallResolver } from './chat-recall-index.js';
import {
  createRetainablePromptPartValidator,
  projectEntityPromptPartCandidates,
} from './chat-pii-source.js';
import { createCandidateContributor } from './chat-pii-candidate-contributor.js';
import type { SessionForwardedSenderIndex } from './chat-forwarded-sender-index.js';
import type { ScopedGrantParseDeps } from './chat-scoped-grant-middleware.js';
import {
  SPAN_ANCHOR_EXPLICIT_CONTINUATION_STATE_KEY,
  type SpanAnchorDeps,
} from './chat-span-anchor-middleware.js';
import {
  readExecutionCaseContext,
  type RequestAugmentationDeps,
} from './execution-case-retrieval.js';
import {
  type ExecutionCasePrecedentDeps,
} from './execution-case-precedent.js';
import type {
  ExecutionCaseLifecycle,
} from './chat-execution-case-tools.js';
import type {
  ExecutionCaseOfferLifecycle,
} from './execution-case-offer-lifecycle.js';
import type {
  ExecutionCaseProposalCritic,
} from './execution-case-critic.js';
import type { ContactStore } from './storage/contact-store.js';
import type { CorrectionEventsStore } from './storage/correction-events-store.js';

/** D-164 P6.3 — per-tool projection the main-turn packet carries. The
 *  schema stays opaque to the composer (consumers pre-resolve from the
 *  slug); the AI sees the slug + `args_schema` + optional
 *  `description`.
 *
 *  D-160 spec-O-5 Stage 1b — exported so `chat-turn-executor.ts`'s
 *  `composeChatMainTurnPromptParts` (which moved with the turn) can type
 *  the `available_tools` it receives. D-160 A.8 step 4 — the orchestrator
 *  PRODUCES this via the `buildCatalog` projection bound to the `catalog`
 *  before-turn hook; `chat-stream-middleware.ts` imports the type to shape
 *  the hook's `state` handoff.
 *
 *  Lever-2 (2026-07-02) — `args_schema` is OPTIONAL: the index-mode
 *  projection (`catalogProjection.mode === 'index'`) omits it for Tier-2
 *  recipe entries, rendering them as `{recipe_slug, description}` only.
 *  The model then pulls the full invocable definition on demand via the
 *  `tools.search` Tier-1 meta-tool. Full mode (the launch baseline) always
 *  sets it. */
export interface ChatMainTurnTool {
  readonly recipe_slug: string;
  readonly args_schema?: unknown;
  readonly description?: string;
}

const LLM_GATEWAY_FORBIDDEN_ARG_KEYS: ReadonlySet<string> = new Set([
  'vault',
  'context',
  'execution_context',
  'executioncontext',
  'credential',
  'credentials',
  'oauth',
  'secret',
  'secrets',
  'password',
  'passphrase',
  'api_key',
  'apikey',
  'client_secret',
  'clientsecret',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'authorization',
  'bearer_token',
  'bearertoken',
  'private_key',
  'privatekey',
]);

const LLM_GATEWAY_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

const normalizedGatewayArgKey = (key: string): string =>
  key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const isGatewayForbiddenArgKey = (key: string): boolean => {
  const raw = key.trim().toLowerCase();
  const normalized = normalizedGatewayArgKey(key);
  return LLM_GATEWAY_PROTOTYPE_KEYS.has(raw)
    || LLM_GATEWAY_FORBIDDEN_ARG_KEYS.has(normalized);
};

const asSchemaRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const schemaDeclaresForbiddenGatewayCarrier = (
  schema: unknown,
  seen = new Set<unknown>(),
): boolean => {
  const record = asSchemaRecord(schema);
  if (!record || seen.has(record)) return false;
  seen.add(record);
  const properties = asSchemaRecord(record.properties);
  if (properties) {
    for (const [key, child] of Object.entries(properties)) {
      if (isGatewayForbiddenArgKey(key)) return true;
      if (schemaDeclaresForbiddenGatewayCarrier(child, seen)) return true;
    }
  }
  const items = record.items;
  return items !== undefined
    && schemaDeclaresForbiddenGatewayCarrier(items, seen);
};

const closedLlmGatewayArgSchema = (
  schema: unknown,
): Record<string, unknown> | null => {
  const record = asSchemaRecord(schema);
  if (!record || record.type !== 'object') return null;
  const properties = record.properties === undefined
    ? {}
    : asSchemaRecord(record.properties);
  if (!properties || schemaDeclaresForbiddenGatewayCarrier(record)) return null;
  const required = record.required;
  if (
    required !== undefined
    && (
      !Array.isArray(required)
      || required.some(
        (key) => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(properties, key),
      )
    )
  ) return null;
  return {
    ...record,
    type: 'object',
    properties: { ...properties },
    additionalProperties: false,
  };
};

const forbiddenGatewayCarrierPath = (
  value: unknown,
  path = '$',
  seen = new Set<unknown>(),
): string | null => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const nested = forbiddenGatewayCarrierPath(value[i], `${path}[${i}]`, seen);
      if (nested) return nested;
    }
    return null;
  }
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (isGatewayForbiddenArgKey(key)) return `${path}.${key}`;
    const nested = forbiddenGatewayCarrierPath(nestedValue, `${path}.${key}`, seen);
    if (nested) return nested;
  }
  return null;
};

const validateGatewaySchemaValue = (
  schema: unknown,
  value: unknown,
  path: string,
): string | null => {
  const record = asSchemaRecord(schema);
  if (!record) return `${path} has an invalid argument schema`;
  if (Array.isArray(record.enum) && !record.enum.some((candidate) => Object.is(candidate, value))) {
    return `${path} must be one of the declared enum values`;
  }
  switch (record.type) {
    case 'string':
      if (typeof value !== 'string') return `${path} must be a string`;
      if (record.format === 'date-time' && Number.isNaN(Date.parse(value))) {
        return `${path} must be an ISO 8601 date-time string`;
      }
      return null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `${path} must be a finite number`;
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
        ? null
        : `${path} must be an integer`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be a boolean`;
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (record.items === undefined) return null;
      for (let i = 0; i < value.length; i += 1) {
        const issue = validateGatewaySchemaValue(record.items, value[i], `${path}[${i}]`);
        if (issue) return issue;
      }
      return null;
    }
    case 'object': {
      const object = asSchemaRecord(value);
      if (!object) return `${path} must be an object`;
      const properties = asSchemaRecord(record.properties) ?? {};
      const required = Array.isArray(record.required) ? record.required : [];
      for (const key of required) {
        if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(object, key)) {
          return `${path}.${key} is required`;
        }
      }
      for (const [key, child] of Object.entries(object)) {
        const childSchema = properties[key];
        if (childSchema === undefined) {
          if (record.additionalProperties === false) {
            return `${path}.${key} is not a declared argument`;
          }
          continue;
        }
        const issue = validateGatewaySchemaValue(childSchema, child, `${path}.${key}`);
        if (issue) return issue;
      }
      return null;
    }
    default:
      return `${path} uses an unsupported argument schema type`;
  }
};

const validateLlmGatewayToolArguments = (
  schema: unknown,
  value: unknown,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } => {
  const closed = closedLlmGatewayArgSchema(schema);
  if (!closed) {
    return { ok: false, detail: 'llm_gateway tool schema is not a safe closed object schema' };
  }
  const carrier = forbiddenGatewayCarrierPath(value);
  if (carrier) {
    return {
      ok: false,
      detail: `${carrier} is a server-owned vault, context, or credential carrier`,
    };
  }
  const issue = validateGatewaySchemaValue(closed, value, 'args');
  return issue ? { ok: false, detail: issue } : { ok: true };
};

/** D-196 — the contract-safe subset of the shared chat registry. Tier 2
 * entries are pinned installed recipes whose dispatch path threads the
 * contracted source + fresh snapshot through `handleExecute`. Their argument
 * schema must also be projectable as a closed object with no server-owned
 * vault/context/credential carriers. */
export const isLlmGatewayContractSafeToolEntry = (entry: ToolEntry): boolean =>
  entry.tier === 2 && closedLlmGatewayArgSchema(entry.arg_schema) !== null;

/** Lever-2 — the catalog delivery mode enum moved to `@recued/contracts`
 *  (`packages/contracts/src/chat.ts`) so `packages/llm` (the `LLMConfig` that
 *  persists per-source modes) and the webclient AI/Models page can reference
 *  it. Re-exported here so existing server importers (`chat-tools-search.ts`,
 *  `chat-turn-executor.ts`) resolve it unchanged. The server-only
 *  `ChatCatalogProjectionConfig` (with the index desc-cap) stays local. */
export type { ChatCatalogDeliveryMode };

/** Lever-2 — does this delivery mode THIN the catalog, and therefore inject
 *  the `tools.search` recall meta-tool AND emit its system-prompt guidance?
 *  True for every non-`full` mode (`index` leans Tier-2, `lean-core` drops
 *  it). The `tools.search` presentation gate (`buildChatMainTurnTools`) and the
 *  guidance composer (`chat-turn-executor.ts:composeChatMainTurnSystemPrompt`)
 *  MUST agree on this set: guidance that says "call tools.search" while the
 *  tool is absent would point the model at a tool it can't see, and a thinned
 *  catalog with no guidance would strand the model with recipes it can't
 *  discover. One predicate, both sites. */
export const catalogModeUsesToolsSearch = (mode: ChatCatalogDeliveryMode): boolean =>
  mode !== 'full';

/** Lever-2 per-slot — the smart auto-default catalog mode per LLM source
 *  (canonical definition in `@recued/contracts` so the webclient's "Automatic"
 *  hint reads the SAME map the resolver does). Applied when `opts.smartDefaults`
 *  is on (the wire defaults it ON as of 2026-07-03 — the "proven-safe" gate
 *  cleared; `RECUED_CHAT_CATALOG_SMART_DEFAULTS=0` opts out) and the turn's
 *  source is known; otherwise the resolver falls to the env-global mode /
 *  `full`. Re-exported for existing importers. */
export { CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE };

/** Lever-2 per-slot — resolve the catalog mode for a turn's LLM source.
 *  Precedence: explicit user per-source override → smart default (only for a
 *  KNOWN source, only when `smartDefaults` on) → env-global fallback → `'full'`.
 *  An undefined/unpinned source deliberately SKIPS the smart default (we can't
 *  predict at catalog-build time whether the matcher lands on a cache-harvesting
 *  BYOK slot or the pool, so the conservative choice never thins an
 *  unpredictable turn). Pure + exported for unit tests. */
export const resolveCatalogModeForSource = (
  source: ChatModelSourceId | undefined,
  perSource: Partial<Record<ChatModelSourceId, ChatCatalogDeliveryMode>> | undefined,
  opts: { smartDefaults: boolean; envGlobalMode?: ChatCatalogDeliveryMode },
): ChatCatalogDeliveryMode => {
  if (source !== undefined) {
    const override = perSource?.[source];
    if (override !== undefined) return override;
    if (opts.smartDefaults) return CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE[source];
  }
  return opts.envGlobalMode ?? 'full';
};

/** Lever-2 per-slot — true iff ANY of the given modes thins (so the wire's
 *  `tools.search` wrapper is enabled). The wrapper is applied ONCE at
 *  construction and cannot be per-turn; enabling it whenever any source could
 *  thin makes `tools.search` DISPATCHABLE on the chat path (a read-only,
 *  chat-only superset), while `buildChatMainTurnTools` drops it from
 *  PRESENTATION on `full` turns — so a full turn stays byte-identical and a
 *  live full→index override never yields a leaned catalog with an
 *  un-dispatchable tool. */
export const anyCatalogModeUsesToolsSearch = (
  modes: Iterable<ChatCatalogDeliveryMode>,
): boolean => {
  for (const mode of modes) if (catalogModeUsesToolsSearch(mode)) return true;
  return false;
};

/** Lever-2 per-slot — normalize the turn's routing (resolved LAYER + source_id)
 *  to the catalog source, MIRRORING the executor's slot-pin logic
 *  (`chat-turn-executor.ts`: `pinSlot = forceLayer === 'byok' && source_id ∈
 *  {slot_1,slot_2}`). A turn only routes to a BYOK slot when the resolved layer
 *  is `byok` AND the source_id is a slot; a `free_pool` layer routes to the pool
 *  regardless of a stale session slot pin, and a `byok` layer with a non-slot
 *  source_id routes byok-UNPINNED. Keying the catalog mode off a raw session
 *  `source_id` that DISAGREES with the turn's layer would thin (or fail to thin)
 *  the WRONG model — e.g. session `free_pool` + a `{current:'byok'}` override:
 *  the LLM routes BYOK unpinned but the raw source_id `free_pool` would thin to
 *  index. So: `free_pool` layer → `'free_pool'`; `byok` layer + slot → that
 *  slot; otherwise `undefined` (conservative → env/full, matching the
 *  unpredictable-source rule). */
export const resolveCatalogSource = (
  layer: ChatModelRoutingLayer | undefined,
  sourceId: ChatModelSourceId | undefined,
): ChatModelSourceId | undefined => {
  if (layer === 'free_pool') return 'free_pool';
  if (layer === 'byok' && (sourceId === 'slot_1' || sourceId === 'slot_2')) return sourceId;
  return undefined;
};

/** Lever-2 (2026-07-02) — the catalog projection knob. Read ONCE at
 *  orchestrator construction (never per-turn), so the projection it drives
 *  stays turn-invariant and safe inside the D-164 cacheable prefix. */
export interface ChatCatalogProjectionConfig {
  readonly mode: ChatCatalogDeliveryMode;
  /** Index mode only — cap Tier-2 descriptions at this many characters
   *  (word-safe, ellipsized). Undefined = full description. A fixed config
   *  value (turn-invariant → prefix-safe). The bench lane A/Bs full vs the
   *  ~120-char variant; this is the knob it toggles. */
  readonly indexDescriptionMaxChars?: number;
}

/** The default projection: the launch baseline (full arg_schema per
 *  entry). Callers that pass no `catalogProjection` dep get this. */
export const DEFAULT_CHAT_CATALOG_PROJECTION: ChatCatalogProjectionConfig = {
  mode: 'full',
};

/** Lever-2 — parse the prototype catalog-delivery knob from a process-env
 *  snapshot. `RECUED_CHAT_CATALOG_MODE=index` turns on the thin-index
 *  projection; `=lean-core` turns on the v2 core-only projection (drops the
 *  Tier-2 listing entirely); anything else (incl. absent) is the `'full'`
 *  baseline. `RECUED_CHAT_CATALOG_INDEX_DESC_MAX=<positive int>` (index mode
 *  ONLY — lean-core has no Tier-2 descriptions to cap) caps Tier-2
 *  descriptions; absent / non-positive / non-integer / unparseable → full
 *  descriptions. Parsed with `Number` (not `parseInt`), so malformed values
 *  like `12.5` / `12abc` / `1e309` are rejected whole rather than silently
 *  truncated to a partial cap. Pure over the passed snapshot so the wire file
 *  stays thin and the parse is unit-testable. */
export const parseChatCatalogProjectionEnv = (
  env: Record<string, string | undefined>,
): ChatCatalogProjectionConfig => {
  const mode = env.RECUED_CHAT_CATALOG_MODE;
  // lean-core drops Tier-2 wholesale → the desc cap is meaningless, ignored.
  if (mode === 'lean-core') return { mode: 'lean-core' };
  if (mode !== 'index') return DEFAULT_CHAT_CATALOG_PROJECTION;
  const rawMax = env.RECUED_CHAT_CATALOG_INDEX_DESC_MAX;
  const parsed = rawMax !== undefined ? Number(rawMax) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0
    ? { mode: 'index', indexDescriptionMaxChars: parsed }
    : { mode: 'index' };
};

/** Lever-2 per-slot — resolve the full per-turn projection for a turn's LLM
 *  source: the mode via {@link resolveCatalogModeForSource}, wrapped into a
 *  `ChatCatalogProjectionConfig` with the index desc-cap attached only for
 *  `index` (lean-core drops Tier-2 wholesale, full carries schemas — neither
 *  has descriptions to cap). The wire binds this as `catalogProjectionForSource`
 *  so the orchestrator resolves the projection per turn from the turn's fixed
 *  source (turn-invariant → D-164 prefix-safe). Pure + exported for tests. */
export const resolveCatalogProjectionForSource = (
  source: ChatModelSourceId | undefined,
  perSource: Partial<Record<ChatModelSourceId, ChatCatalogDeliveryMode>> | undefined,
  opts: {
    smartDefaults: boolean;
    envGlobalMode?: ChatCatalogDeliveryMode;
    indexDescriptionMaxChars?: number;
  },
): ChatCatalogProjectionConfig => {
  const mode = resolveCatalogModeForSource(source, perSource, opts);
  return mode === 'index' && opts.indexDescriptionMaxChars !== undefined
    ? { mode, indexDescriptionMaxChars: opts.indexDescriptionMaxChars }
    : { mode };
};

/** Lever-2 — word-safe truncation for the index-mode Tier-2 description.
 *  Caps at `maxChars`; if the cut lands mid-word it backs up to the last
 *  space (unless that would discard more than ~40% of the budget — then it
 *  hard-cuts a single long token), then appends a one-char ellipsis. A
 *  trailing lone high-surrogate (a non-BMP char split by the cut) is
 *  dropped so the prompt never carries a broken code point. Deterministic
 *  → safe inside the turn-invariant cacheable prefix. */
export const truncateForIndex = (text: string, maxChars: number): string => {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const hard = text.slice(0, maxChars);
  const lastSpace = hard.lastIndexOf(' ');
  let cut = lastSpace >= Math.floor(maxChars * 0.6) ? hard.slice(0, lastSpace) : hard;
  // Drop a dangling high-surrogate left by slicing through a surrogate pair.
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
};

/** Lever-2 — the index-mode Tier-2 projection: slug + (optionally
 *  truncated) description, NO `args_schema`. Empty descriptions stay
 *  omitted (matches full mode). */
const leanTier2Tool = (
  entry: ToolEntry,
  descriptionMaxChars: number | undefined,
): ChatMainTurnTool => {
  if (!entry.description) return { recipe_slug: entry.name };
  const description =
    descriptionMaxChars !== undefined
      ? truncateForIndex(entry.description, descriptionMaxChars)
      : entry.description;
  return { recipe_slug: entry.name, description };
};

/** D-164 P6.3 — pure projection of a catalog union to the AI-facing
 *  `available_tools` list. Mary's per-kind scope (Tier 2 only) and per-
 *  MCP-connection annotation (Tier 3 only) gate inclusion mechanically.
 *  Tier 1 entries always surface. Self vs peer-target catalogs flow
 *  through the same projection; peer catalogs surface every entry as
 *  Tier 3 from Mary's side per § A.1.1 (the peer-side projection has
 *  already classified internally).
 *
 *  Intent-driven topic narrowing + per-tier capacity caps + recently-
 *  used tie-break logic are NOT carried over at P6.3 — the prompt-cache
 *  catalog substrate (D-164 P3) is the salvage path for those
 *  semantics. */
const buildChatMainTurnTools = (
  catalog: ReadonlyArray<ToolEntry>,
  kindGatedTier2Names: ReadonlySet<string>,
  disabledTier3Names: ReadonlySet<string>,
  projection: ChatCatalogProjectionConfig,
): ReadonlyArray<ChatMainTurnTool> => {
  const out: ChatMainTurnTool[] = [];
  for (const entry of catalog) {
    if (entry.tier === 2 && kindGatedTier2Names.has(entry.name)) continue;
    if (entry.tier === 3 && disabledTier3Names.has(entry.name)) continue;
    // Lever-2 per-slot — the tools.search wrapper is enabled construction-wide
    // (enable-if-ANY-source-thins, since per-source modes are live), so it
    // appears in the registry on every chat turn. On a `full` turn present
    // nothing extra: drop it so the full-mode prefix stays BYTE-IDENTICAL to the
    // pre-lever-2 baseline. Thinning turns (index / lean-core) keep it — it's
    // their recall / discovery path — and its dispatch stays available in both.
    if (projection.mode === 'full' && entry.name === TOOLS_SEARCH_TOOL_NAME) continue;
    // Lever-2 lean-core (v2) mode DROPS every Tier-2 recipe entry — the
    // catalog carries only the always-present core tools (Tier-1) + MCP peer
    // tools (Tier-3). Recipes are discovered on demand via `tools.search`,
    // whose recall corpus is the full exposed Tier-2 set (`inner.listByTier(2)`
    // in the wire wrapper) independent of THIS projection, so dropping them
    // here loses no discoverability — only the turn-invariant prefix cost.
    if (projection.mode === 'lean-core' && entry.tier === 2) continue;
    // Lever-2 index mode leans ONLY Tier-2 recipe entries: Tier-1 (kernel
    // lean-core) and Tier-3 (MCP peer) stay full because `tools.search`'s
    // recall pool is the Tier-2 set — a leaned Tier-1/Tier-3 entry could
    // never be re-expanded to recover its arg_schema.
    if (projection.mode === 'index' && entry.tier === 2) {
      out.push(leanTier2Tool(entry, projection.indexDescriptionMaxChars));
      continue;
    }
    out.push({
      recipe_slug: entry.name,
      args_schema: entry.arg_schema,
      ...(entry.description ? { description: entry.description } : {}),
    });
  }
  return out;
};

const FRAMEWORK_PROMPT_SOURCE = 'framework';

const buildChatContentPromptParts = (input: {
  readonly user_message: string;
  readonly chat_tail: ReadonlyArray<ChatTailMessage>;
}): readonly ContentPromptPart[] => [
  ...input.chat_tail.map((message) => ({
    source: FRAMEWORK_PROMPT_SOURCE,
    role: 'content' as const,
    content_kind: 'chat_tail' as const,
    speaker: message.role,
    text: message.content,
    ...(message.turn !== undefined ? { turn: message.turn } : {}),
  })),
  {
    source: FRAMEWORK_PROMPT_SOURCE,
    role: 'content',
    content_kind: 'user_message',
    speaker: 'user',
    text: input.user_message,
  },
];

const assembleChatPromptContent = (
  parts: readonly ContentPromptPart[],
): RunChatTurnPromptContent => {
  const chat_tail: ChatTailMessage[] = [];
  let user_message = '';
  for (const part of parts) {
    if (part.content_kind === 'user_message') {
      user_message = part.text;
      continue;
    }
    const role = part.speaker;
    if (role !== 'user' && role !== 'assistant') continue;
    chat_tail.push({
      role,
      content: part.text,
      ...(part.turn !== undefined ? { turn: part.turn } : {}),
    });
  }
  return { chat_tail, user_message };
};

/** D-137 P4 § A.7 — pure helper: split a `connection.mcp.<name>` picker
 *  target into its bare peer name. Returns `null` for the `'self'`
 *  sentinel + for any malformed string (the rpc layer's
 *  `ensureValidPickerTarget` upstream already rejects malformed targets;
 *  this defensive guard keeps the orchestrator reachable even on a test
 *  harness path that bypasses validation). Module-level (D-160 A.8 step 4)
 *  so the `buildCatalog` projection and the per-turn `dispatch_peer_name`
 *  derivation share one definition. Pure; no closure state. */

/** D-164 P6.3 — what the bound executor returns: the raw parsed body
 *  from `executeLLM` + an optional `TokenUsageReport` captured via the
 *  `onTokenUsage` callback the composer wires around the executor. */
export interface ChatAiCallResult {
  readonly body: unknown;
  readonly usage?: TokenUsageReport;
  /** Provider-normalized stop reason. The gateway uses `length` to preserve a
   * truthful output-limit completion even when structured JSON was truncated. */
  readonly finish_reason?: LLMFinishReason;
}

/** D-164 P6.3 — the orchestrator's direct AI handle. The chat
 *  composer in `wire-chat-orchestrator.ts` pre-binds `executeLLM` (from
 *  `@recued/llm`) with `LLMConfig` / `AdapterRegistry` / `QuotaTracker`
 *  / `tabProbe` + token-usage capture. Per D-164 P6.0 (b) the orchestrator
 *  owns inline AI-packet composition + calls this closure directly — no
 *  framework seam. D-164 P4 (prompt-cache) registers a `before-turn` hook
 *  that may short-circuit AI dispatch entirely. */
export type ExecuteChatAiCall = (
  manifest: IngredientManifest,
  input: Record<string, unknown>,
) => Promise<ChatAiCallResult>;

/** Minimal broadcast surface the orchestrator needs from the D-121
 *  event bus. Narrowed to a single `emit(event)` so harness tests can
 *  pass a synthetic in-memory bus without spinning the whole D-121
 *  fan-out apparatus. */
export interface ChatBroadcastEmitter {
  emit(event: BroadcastChatEvent): void;
}

export interface MessengerVoiceTranscriptionDeps {
  getFileReadDeps?: () => FileReadDeps | undefined;
  readFile?: (
    record_id: string,
  ) => Promise<Pick<FileReadResponse, 'bytes_b64' | 'mime_type' | 'filename'>>;
  transcribeDeps: TranscribeDeps;
}

/** The closed-list chat event payloads (per `ChatBroadcastEventKind`
 *  in contracts) WITHOUT the bus-assigned `cursor` field. The bus
 *  stamps a monotonic cursor on its way out, so the orchestrator
 *  emits cursor-less variants. */
export type BroadcastChatEvent = Extract<ServerEvent, { kind: ChatBroadcastEventKind }> extends infer T
  ? T extends { cursor: number }
    ? Omit<T, 'cursor'>
    : never
  : never;

/** Bridge from `EventBus` (which stamps cursors itself) to the
 *  orchestrator's narrow emitter — drop in the bus's `emit` so the
 *  cursor field comes for free. Production wires through this; tests
 *  capture into an array. */
export const broadcastEmitterFromBus = (bus: EventBus): ChatBroadcastEmitter => ({
  emit: (event) => {
    bus.emit(event as Parameters<EventBus['emit']>[0]);
  },
});

export interface ChatOrchestratorDeps {
  /** Per-pair chat session/message store. */
  chatStore: ChatStore;
  /** D-172 P2 — resolve attached `data.file` ids to their CURRENT filenames for
   *  the chat tail's attachment marker. Optional: absent (dbless / partial
   *  harness) means the marker is simply omitted, which is the correct
   *  degradation — a marker naming files it could not resolve would be the
   *  shape-without-values case the bench measured at ~5.5x fabrication odds. */
  resolveFileNames?: ChatFileNameResolver;
  /** D-177 N.11 rule 5 (5.d hot-path) — the per-session forwarded-sender
   *  candidate index. The orchestrator RECORDS into it right after
   *  durably persisting a CHAT user turn (`contributor: 'user'`);
   *  messenger turns are deliberately not recorded until messenger's
   *  stamping audit (5.f). The gateway reads it via the slice-D seam.
   *  Optional — absent means scoped grants simply never match. */
  forwardedSenderIndex?: SessionForwardedSenderIndex;
  /** D-177 N.11 rule 5 (5.c, slice C) — the scoped-grant parse hook's
   *  late-bound deps. Threaded into `createChatStreamMiddlewares`; absent
   *  (or resolving undefined per turn) → the hook is a faithful no-op. */
  getScopedGrantParseDeps?: () => ScopedGrantParseDeps | undefined;
  /** Pre-seed INDEX builder. Given the owner's message, returns one line naming
   *  — per distinctive term — WHICH STORES hold it (`pelham: mail.search,
   *  memory.search`). Store names ONLY: no titles, no counts, no content. The
   *  bench measured that naming the stores IS the whole effect (bare stores tie
   *  titles at 9/10 on the two-referent case vs 1/10 with no index), and that
   *  describing content is actively harmful — a summary variant produced a
   *  confident `12% discount` present in NO packet and contradicting the store.
   *  Optional: absent → no line, which is the pre-index behaviour exactly. */
  buildIndexContext?: (
    userMessage: string,
    ctx: ChatDispatchContext,
  ) => Promise<string | undefined>;
  /** D-214 §4.2 — late-bound durable root-request/span anchor deps. */
  getSpanAnchorDeps?: () => SpanAnchorDeps | undefined;
  /** D-214 §10.1/§10.4 — optional experiment-gated request augmentation. */
  getExecutionCaseAugmentationDeps?:
    () => RequestAugmentationDeps | undefined;
  /** D-219 — the ordinary-path shape-only precedent surface. Composed only when
   *  the two dep above/below are NOT: an experiment's control arm that received
   *  precedent from a second source is not a control arm. */
  getExecutionCasePrecedentDeps?:
    () => ExecutionCasePrecedentDeps | undefined;
  /** D-214 §4.3 — report closure and strong-signal finalization. */
  getExecutionCaseLifecycle?:
    () => ExecutionCaseLifecycle | undefined;
  /** D-219 slice 9c — the owner-facing offer's lifecycle (raise after the turn
   *  that earned it, retire at the owner's next request). Late-bound: the
   *  notification block it needs is composed after the chat substrate. */
  getExecutionCaseOfferLifecycle?:
    () => ExecutionCaseOfferLifecycle | undefined;
  /** D-214 §10.2 — optional pre-dispatch experiment service. */
  getExecutionCaseProposalCritic?:
    () => ExecutionCaseProposalCritic | undefined;
  /** Tool-dispatch surface (Tier 1+2+3 via direct function call). */
  registry: InternalToolRegistry;
  /** D-228 slice 3 — which of a connection's upstream MCP tools a governed pack
   *  op already reaches. The Tier-3 entries for those stand down, so one tool
   *  stops being reachable through two surfaces with two different gates.
   *
   *  ⛔ Absent ⇒ NO suppression, and that direction is chosen: a host with no
   *  binding store keeps the Tier-3 surface exactly as it was. The failure of a
   *  missing coverage lookup must be "the old surface is still there", never
   *  "the tool is reachable by nothing". */
  connectionMcpPackCoverage?: (connection_name: string) => ReadonlySet<string> | undefined;
  /** D-225 § 9.8.1 — the raw catalog-op source, DERIVED from the turn's
   *  contract. Optional: absent ⇒ no raw ops, which is the behaviour before
   *  § 9.5.1 and keeps every partial harness working. */
  rawOpSource?: (source?: ExecutionSource) => ReadonlyArray<{
    name: string;
    tier: 2;
    description: string;
    arg_schema: unknown;
    topic_tags: readonly string[];
    classification: 'read' | 'write' | 'unknown';
    concurrency_safe: boolean;
  }>;
  /** D-247 D9 — is a Tier-2 recipe REACHABLE for this turn's source? Kept beside
   *  the registry for the same reason `rawOpSource` is: recipe visibility became
   *  contract-derived when D-247 gave it a grant kind.
   *
   *  ⚠ Absent ⇒ unfiltered, which is today's behaviour and keeps every partial
   *  harness working. The FILTER decides fail-closed on an absent source, not
   *  this optionality. */
  tier2GrantFilter?: (source?: ExecutionSource) => (toolName: string) => boolean;
  /** D-247 D8 — the OWNER's Tier-2 catalog, projected WITHOUT the `chat_exposed`
   *  filter and narrowed by the `recipe.*` grant instead.
   *
   *  ⛔ Returns `null` for anything not owner-governed, which leaves the
   *  registry's own filtered entries in place. Without this the grant could only
   *  narrow what `chat_exposed` already allowed, and an owner who granted a
   *  hidden recipe would get nothing — the flag would still be the gate. */
  tier2OwnerCatalog?: (source?: ExecutionSource) => ReadonlyArray<ToolEntry> | null;
  /** D-225 § 9.5.1 — dispatch for a raw catalog op emitted by
   *  `rawOpSource`. Kept beside (rather than inside) the ordinary registry
   *  because raw visibility is derived from the turn's contract. The raw
   *  dispatcher owns contract/catalog approval; the outer chat-plan gate must
   *  not add a second approval. */
  rawOpDispatch?: (
    toolName: string,
    args: unknown,
    ctx: ChatDispatchContext,
  ) => Promise<ChatDispatchResult>;
  /** Lever-2 (2026-07-02) — catalog delivery mode + index-desc cap. Absent
   *  → `DEFAULT_CHAT_CATALOG_PROJECTION` (`{ mode: 'full' }`, the launch
   *  baseline: full arg_schema per entry in the cacheable prefix).
   *  Turn-invariant by construction (resolved once at orchestrator build,
   *  never per-turn) so it stays safe inside the D-164 cacheable prefix.
   *  The server wires it from `RECUED_CHAT_CATALOG_MODE` via
   *  `parseChatCatalogProjectionEnv` for the prototype; per-layer default
   *  wiring (free pool on / BYOK off) follows the bench A/B. */
  catalogProjection?: ChatCatalogProjectionConfig;
  /** Lever-2 per-slot — resolve the catalog projection from the TURN's LLM
   *  source (`resolveModelPref` result), so each source (`free_pool` /
   *  `slot_1` / `slot_2`) gets its own mode. Called once per turn in
   *  `buildTurnDriver` from the turn-fixed source, so the projection stays
   *  turn-invariant (D-164 prefix-safe). Absent → the static
   *  `catalogProjection` (above) is used for every turn (the pre-per-slot
   *  behavior). The wire binds this from the live `LLMConfig.catalog_modes`
   *  via `resolveCatalogProjectionForSource`. */
  catalogProjectionForSource?: (
    source: ChatModelSourceId | undefined,
  ) => ChatCatalogProjectionConfig;
  /** Resolve the SURFACE's system prompt + wire role — the owner's Settings →
   *  AI/Models override when they authored one, else that surface's built-in
   *  default. Bound by the wire as a closure over the live `getLlmConfig()`
   *  (exactly like `catalogProjectionForSource` above), so a prompt saved in
   *  Settings takes effect on the NEXT turn without a server restart.
   *
   *  `systemToolsAllowed` is read only on the gateway default path (it selects
   *  the conditional posture line). Absent dep → the built-in defaults, which
   *  is what every test / harness caller gets. */
  resolveSystemPrompt?: (
    surface: LlmPromptSurface,
    options?: { readonly systemToolsAllowed?: boolean },
  ) => ResolvedLlmSystemPrompt;
  /** D-121 broadcast bus. */
  broadcast?: ChatBroadcastEmitter;
  /** Audit log — chat lifecycle codes (`chat_session_created`,
   *  `chat_message_sent`, `chat_tool_call`). Best-effort; failures
   *  never abort the turn. */
  auditLog?: AuditLogStore;
  /** Recued server signature snapshot, used in `picker_at_send` for
   *  Self-targeted turns. P1.3 wires per-peer signatures when picker
   *  is on a `connection.mcp.<name>` target. */
  selfSignature: RecuedServerSignature;
  /** Display name for `picker_at_send.display_name` on Self turns
   *  (e.g., "Mary's server"). Defaults to `'Self'`. */
  selfDisplayName?: string;
  /** D-164 P6.3 — direct AI handle. Per P6.0 (b) the chat orchestrator
   *  owns inline AI-packet composition + calls `@recued/llm`
   *  `executeLLM` directly via this closure. The composer in
   *  `wire-chat-orchestrator.ts` pre-binds `LLMConfig` / adapters /
   *  quota / tab probe + token-usage capture. Absent → the orchestrator
   *  persists an empty-
   *  assistant message (substrate stays reachable without an AI
   *  provider). When present, executor throws + validation failures
   *  map to `engine.budget_exceeded` transparency events + an empty-
   *  assistant message body. */
  executeAiCall?: ExecuteChatAiCall;
  /** D-137 W2.2 § A.1.1 — Mary's per-kind catalog scope provider.
   *  Read on every turn start; the orchestrator translates the
   *  returned scope into the `kindGatedTier2Names` set that gates the
   *  AI-facing available_tools projection (`buildChatMainTurnTools`).
   *  Returning `null` (no row written yet, store unavailable, dbless
   *  test harness) collapses to the substrate default
   *  (`SAFE_DEFAULT_CHAT_CATALOG_KINDS`); the orchestrator never
   *  invents a different set. The provider is invoked synchronously
   *  per turn so a toggle from Settings surfaces on the next message
   *  Mary sends without re-priming the orchestrator. */
  scopeProvider?: () => ChatToolCatalogScopeState | null;
  /** D-137 W2.3 § A.1.1 + § A.10 — Mary's per-connection MCP tool
   *  annotation provider. Read on every turn start; the orchestrator
   *  derives the `disabled_tier3_names` set for the inline
   *  `buildChatMainTurnTools` projection from the annotation snapshot.
   *  Returning `null` (no rows written yet, dbless test harness)
   *  collapses to an empty annotation list — `buildChatMainTurnTools`
   *  then sees an empty disabled set and treats Tier 3 entries (also
   *  empty without a wired source) as a no-op.
   *
   *  This is the *transparency-side* projection of Mary's per-tool
   *  classifications: the Tier 3 *catalog* is gated at the
   *  `InternalToolRegistry` factory level (the `tier3Source` option,
   *  which is plumbed alongside this provider in `bin.ts`). Both
   *  consume the same annotation snapshot but for different
   *  downstream concerns:
   *
   *    - **Registry tier3Source** — projects the catalog (only
   *      enabled + classified tools surface as `ToolEntry`).
   *    - **Orchestrator annotationProvider** — derives the disabled
   *      set so the renderer's transparency drawer can show "X
   *      Tier 3 tools were cached but not visible (Mary hasn't
   *      classified / disabled them)" without re-reading the
   *      annotation store. */
  annotationProvider?: () => ReadonlyArray<ConnectionMcpAnnotationState> | null;
  /** D-137 P3 § A.11 — plan-approval registry. The orchestrator's
   *  `dispatchTool` checks the store BEFORE invoking the registry
   *  for write tools (`requiresPlanApproval(entry)`):
   *
   *    - SAME-TURN cancelled plan → returns `plan_cancelled` without
   *      dispatching (cancel is turn-scoped; later turns re-propose).
   *    - Consumable approval for `(session, tool, args_hash)` —
   *      turn-AGNOSTIC, single-use, TTL-bounded — → consumes it
   *      (`consumed_at` stamp + `chat_plan_consumed` audit) and
   *      dispatch proceeds normally.
   *    - Otherwise → mints a proposal (or re-emits the same turn's
   *      still-proposed one), emits `chat.plan_proposed`, returns
   *      `awaiting_approval` so the main-turn loop sees the pause +
   *      surfaces an approval card to Mary.
   *
   *  Rpc handlers (`chat.plan.approve` / `chat.plan.cancel`) flip the
   *  status + emit `chat.plan_resolved`. The next main-turn re-issue
   *  of the tool call (Mary's follow-up message) consumes the
   *  approval + proceeds — the user-driven re-issue path, kept over
   *  automatic resumption so the substrate stays
   *  orchestrator-loop-oblivious (re-run over resume).
   *
   *  Omitting the dep collapses write-gating to a no-op (tests +
   *  dbless harness path); the orchestrator dispatches every tool
   *  through the registry as before. */
  planApprovalStore?: planApprovalModule.PlanApprovalStore;
  /** D-160 Stage 3 — the live first-party middleware registry (built in
   *  `wire-chat-orchestrator.ts`). The orchestrator builds the
   *  source-binding adapters (`chat-stream-middleware.ts`) from it +
   *  registers them into its per-turn stream registry; each adapter
   *  sources its real middleware from `registry.enabled()`, so the
   *  registry's per-middleware enabled-state gates whether it runs.
   *  Omitting the dep leaves the stream registry empty — the turn runs
   *  through `runStream` with no producers (the orchestrator owns the AI
   *  call regardless), exactly as before. */
  middlewareRegistry?: MiddlewareRegistry;
  /** D-160 Stage 3 — per-pair correction-event store: the source the
   *  `correction-learning` `before-turn` hook seeds from. Absent → that
   *  adapter no-ops. */
  getCorrectionEventsStore?: () => CorrectionEventsStore | undefined;
  /** D-160 Stage 3 — per-pair contact store: the source the
   *  `personal-recipes` `after-turn` hook seeds its per-contact lookup
   *  from. Absent → that adapter no-ops. */
  getContactStore?: () => ContactStore | undefined;
  /** D-172 A.9 — voice-only messenger notes are the user's utterance.
   *  When the optional file-read + audio-model deps are live, the
   *  orchestrator reads the just-ingested audio ref and transcribes it before
   *  appending the durable user row. Missing deps / read failures /
   *  transcription failures fall back to the P4 pending affordance. */
  messengerVoiceTranscription?: MessengerVoiceTranscriptionDeps;
  /** D-160 A.8 step 5 — per-turn scope-search fan-out producer: the
   *  `{ args, sources }` the registered `scope-search` `before-turn` hook
   *  seeds onto shared `state`, the dep that fires the scope-search →
   *  confidence-shape chain. This is the SEAM slot — left UNWIRED on the live
   *  chat path BY DESIGN, not merely "not yet landed" (investigated +
   *  confirmed 2026-06-02; D-160 O-5). The turn-level pipeline is a two-sided
   *  seam with both ends absent in single-stage: no pre-AI intent signal to
   *  derive the fan-out `args` from (a `before-turn` hook fires before the AI
   *  call + the whole tool loop; the Stage-1 classifier that would supply
   *  intent was deleted in D-164 P6.5/6.6) AND no consumer of the results
   *  (`confidence-shape:result` has no reader; `scope-search:result` only
   *  feeds the chain's own confidence-shape stage). The
   *  productive fan-out runs COMPLETE at TOOL-dispatch level in
   *  `chat-tool-handlers.ts` (`contact.search` / `deal.search`) — there the
   *  AI's tool args are the intent signal and the AI reading the envelope is
   *  the consumer. So absent this dep both hooks are faithful no-ops
   *  (behavior-preserving); lighting it up = the full D-137-chat refactor
   *  (turn-level pre-fetch + § A.5 confidence-pattern UX consumer + a new
   *  intent signal), a product decision, NOT a producer hand-off. The dep is
   *  kept as the proven plug-in point (the s5 e2e test pins that a wired
   *  producer fires the fan-out mid-turn). See `chat-stream-middleware.ts`'s
   *  file-header block for the full account. */
  getScopeSearchInput?: () => ChatScopeSearchInput | undefined;
  /** D-167 P5 S4 — the per-pair session alias-ledger store (one per chat
   *  substrate, RAM-only, never synced). When present, the always-on
   *  `pii-protect` / `pii-restore` bookend hooks are registered into the
   *  stream registry and the executor closure wraps `executeAiCall` to alias
   *  every outbound packet + restore every returned body. Absent → no PII
   *  bookends + the executor uses the raw `executeAiCall` (PII unwired). */
  piiLedgerStore?: piiEgress.SessionLedgerStore;
  /** D-213 Track B — RAM-only flat candidates owned by the current session and
   * keyed by an X1-authorized historical session. */
  /** D-167 P5 S4 — resolves which packet fields carry a `MetaField.privacy`
   *  tag. Defaults to `noopFieldPrivacyResolver` (inert until D-165 supplies
   *  a runtime schema source). */
  fieldPrivacyResolver?: piiEgress.FieldPrivacyResolver;
  /** D-167 (recall path) — builds the contact recall RESOLVER the PII egress aliases
   *  a `memory.*` result against (closing the cross-session memory-recall leak).
   *  Threaded into the `pii-protect` hook deps; called lazily per recalling turn.
   *  Absent → recall aliasing off (the ledger-only scan still runs). */
  getContactKnownValueIndex?: () => RecallResolver | undefined;
  /** Override the clock — tests pin to fixed instants. */
  now?: () => number;
  /** Override turn-id minting — tests inject deterministic ids. */
  mintId?: () => string;
}

export interface ChatTurnInput {
  session_id: string;
  message: string;
  /** D-172 P2 — `data.file` records the owner attached to THIS turn. Ids only;
   *  the bytes went up the binary upload socket and reading them back is the
   *  separately-gated `data-file-read`. Handled exactly as the messenger path
   *  handles `inbound.media`: persisted on the user row AND named on the
   *  model's copy of this turn, because `buildChatTail` runs before the append
   *  so the current message is never in the tail. */
  attachments?: readonly ChatMessageAttachment[];
  picker_state: { current: ChatPickerTarget };
  /** Explicit same-session conversational lineage. The RPC shell validates
   * this prior turn and the D-214 middleware resolves it to a durable root;
   * neither the caller nor the model supplies a root request id. */
  continuation_of_turn_id?: string;
  /** A user-reviewed verify-before-retry turn for this consumed action.
   * It is correlation only; any write call still mints a fresh proposal. */
  retry_of_plan_id?: string;
  /** Server-validated evidence grounding for a guided Data explanation.
   * Persisted on both turn rows; never dispatch or approval authority. */
  data_diagnosis?: ChatDataDiagnosisContext;
  model_pref?: {
    current: ChatModelRoutingLayer;
    model_hint?: ChatModelHint;
    source_id?: ChatModelSourceId;
  };
  /** D-193 — the requesting user's IANA timezone from the surface
   *  (webclient reads `Intl…resolvedOptions().timeZone`). Threads to the
   *  chat prompt's current-time anchor so the model resolves wall-clock
   *  times ("remind me at 3pm") in the user's zone. Absent ⇒ server-local. */
  time_zone?: string;
  /** Ack-before-run seam — fires ONCE at the turn's COMMIT POINT
   *  (session resolved + chat tail read + the user message durably
   *  appended), before the model-bound body runs. The rpc layer
   *  (`handleSend`) resolves the `chat.send` ack here so a slow model
   *  can no longer surface as a misleading rpc timeout; everything
   *  that can reject a turn for CALLER reasons (unknown session, a
   *  locked vault failing the tail read) still throws BEFORE this
   *  fires and rejects the rpc as before. `runTurn`'s own returned
   *  promise keeps its resolve-at-completion contract (full
   *  `ChatTurnAck` incl. `total_usage`) — direct callers (tests, the
   *  messenger reuse) are unaffected; a caller that omits this gets
   *  exactly the old ack-after-run behavior. */
  on_accepted?: (ack: { turn_id: string }) => void;
}

export interface ChatTurnAck {
  turn_id: string;
  /** D-137 Trio #E — per-turn aggregated token usage across the initial
   *  main turn + every main-turn re-invocation round in the tool loop.
   *  Pure sum via `aggregateTokenUsageReports`. Undefined on turns that
   *  never produced an AI usage report (no executor wired, or every
   *  call short-circuited before any provider call landed). Field is
   *  observability-only — the orchestrator never gates on it. */
  total_usage?: TokenUsageReport;
}

/** D-196 — one stateless OpenAI-compatible customer turn over the shared chat
 * orchestrator. The surface adapter owns HTTP/history/model-route details;
 * the orchestrator owns the same structured-output validation, recovery, and
 * cooperative tool loop used by normal chat. */
export interface LlmGatewayTurnInput {
  readonly session_id: string;
  readonly user_id: string;
  readonly contract_id: string;
  readonly content: RunChatTurnPromptContent;
  /** Exact inbound-token grants, expressed in the chat registry's tool-name
   * namespace. The gateway currently admits only pinned Tier-2 recipes. Tier-1
   * owner-local handlers remain excluded until individually source/read-fenced;
   * Tier-3 peers are excluded because they spend owner outbound credentials. */
  readonly allowed_tool_names: ReadonlyArray<string>;
  /** Re-resolve token + contract authority immediately before each actual
   * top-level dispatch. Returning null is a live kill switch. */
  readonly resolve_contract_snapshot: (call: {
    readonly tool_name: string;
    readonly arg_values: unknown;
  }) => ContractSnapshot | null | Promise<ContractSnapshot | null>;
  readonly execute_ai_call: ExecuteChatAiCall;
  readonly model_layer: ChatModelRoutingLayer;
  readonly model_hint?: ChatModelHint;
  readonly model_source_id?: ChatModelSourceId;
  readonly input_token_budget?: number;
  readonly llm_gateway_tool_usage?: LlmGatewayToolUsageMeter;
  /** The gateway's system prompt + wire role, resolved by the HTTP handler
   *  (`resolveLlmSystemPrompt('llm_gateway', …)`) — the owner's override when
   *  authored, else the built-in gateway default (chat base + contract-scoping
   *  posture). Resolved there rather than here because the handler is the only
   *  place `system_tools_allowed` is authoritative: it RE-DERIVES the flag after
   *  the post-body reauthorization, and both gateway providers must agree on
   *  one prompt.
   *
   *  Absent → `runChatTurn`'s built-in chat prompt (the pre-existing behavior,
   *  and what direct harness callers get). */
  readonly system_prompt?: string;
  readonly system_role?: LLMMessageRole;
}

export interface LlmGatewayTurnResult {
  readonly turn_id: string;
  readonly assistant_content: string;
  readonly tool_calls?: ChatToolCall[];
  readonly usage?: TokenUsageReport;
  readonly post_effect_outcome?: LlmGatewayPostEffectOutcome;
}

export type LlmGatewayPostEffectStatus = 'completed' | 'partial' | 'in_doubt';

/** OpenAI-compatible responses carry this namespaced extension when provider
 * synthesis fails after at least one actual tool dispatch. It is explicitly
 * non-retryable: the caller can inspect/reconcile without duplicating effects. */
export interface LlmGatewayPostEffectOutcome {
  readonly status: LlmGatewayPostEffectStatus;
  readonly error_code:
    | 'context_length_exceeded'
    | 'llm_gateway_provider_failed'
    | 'llm_gateway_authority_changed';
  readonly message: string;
  readonly retryable: false;
  readonly dispatched_tool_calls: number;
}

/** D-160 A.8 step 6 — the input a `messenger` turn runs over.
 *
 *  The caller — the downstream BYO Slack/Telegram transport + verified
 *  webhook-inbound wiring (DEFERRED; outside this chat-files lane, the same
 *  way the s5 `getScopeSearchInput` producer was a deferred seam) — builds
 *  the messenger `Channel` from `@recued/messenger` over a `connection.
 *  notification` token and registers `onInbound(runMessengerTurn)`. The
 *  channel's `ingest` produces the framework-shaped `inbound` (the
 *  `messenger-<vendor>` surface + the `(messenger × actor)` `ExecutionSource`
 *  + the I-7 `dispatch_depth` hop token) and records the user row into the
 *  shared session store; the orchestrator then drives the turn over the SAME
 *  `streamRegistry` (the s5 hooks) + the SAME `runChatTurn` mechanics as chat
 *  — that IS the step-6 reuse. The framework's post-`update` `out.message`
 *  delivers the final answer over the channel's transport. */
export interface MessengerTurnInput {
  /** The caller-built messenger `Channel` (over a BYO transport). The
   *  framework delivers the final assistant `message` over it (token /
   *  transparency / done events are dropped by the messenger surface). */
  channel: Channel;
  /** The session-state store the messenger channel was built with — the
   *  SAME instance chat uses, so the two surfaces are one conversation
   *  (N.5). The framework reads turn history from it; the channel records
   *  both turns into it. */
  sessionStore: SessionStateStore;
  /** The verified inbound the channel produced from `ingest` — carrying the
   *  surface, text, `from`, `(messenger × actor)` source, the I-7
   *  `dispatch_depth` hop token, and ts. */
  inbound: ChannelInbound;
  /** Optional model-routing override; absent → the shared session's routing
   *  (or `local` when no chat session exists for this conversation yet — a
   *  messenger turn never throws on a missing session, unlike chat). A
   *  messenger turn is always a Self turn (no peer picker). */
  model_pref?: {
    current: ChatModelRoutingLayer;
    model_hint?: ChatModelHint;
    source_id?: ChatModelSourceId;
  };
}

/** D-153 P2.C — local-owner identifier baked into every chat
 *  `ExecutionSource`. Recued's single-user-server invariant (one server
 *  == one human identity, per `project_single_user_warehouse_invariant`)
 *  means the channel's `user_id` is a constant for stdio / WS clients
 *  paired to this server. Multi-tenant deployments would replace this
 *  with the authenticated principal; today the field is shape-required
 *  by `ExecutionSource['chat']` but has no per-call variance. Mirrors
 *  the `STDIO_MCP_*` constants in `mcp-server.ts`. */
const LOCAL_CHAT_USER_ID = 'local';

/** D-153 P2.C — build the channel-shaped `ExecutionSource` for a chat
 *  dispatch. Today the orchestrator's only chat surface is the local
 *  owner driving their own server (`actor: 'user_self'`); the
 *  `contracted_user` chat variant (and a self-restricted `user_self`
 *  carrying a `contract_id` — D-161 N.3) land when the full contracts
 *  substrate (open question #21) does. No `ContractSnapshot` is paired
 *  because this unrestricted `'user_self'` carries no `contract_id`
 *  (spec line 408: "user_self is the default for
 *  user / chat / messenger when the user is acting through their own
 *  client"). */
/** D-177 P5a (N.10) — `turn_id`, when supplied, rides the chat
 *  `ExecutionSource` onto every commit the dispatch writes, so the
 *  batched-approval origin unit can group same-turn holds
 *  (`deriveOriginUnit`: chat ⇒ `turn`). Optional — a source minted
 *  outside a turn boundary falls back to the `correlation_id` stand-in. */
const buildChatExecutionSource = (
  session_id: string,
  turn_id?: string,
): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: session_id,
  user_id: LOCAL_CHAT_USER_ID,
  ...(turn_id !== undefined && turn_id.length > 0 ? { turn_id } : {}),
});

/** The reply to a file dropped with no words.
 *
 *  ⛔ THIS COSTS NO AI CALL, AND THAT IS THE DESIGN — not a limitation being
 *  worked around. A file arriving is not a question, so running a turn on it
 *  would spend a provider call to guess an intent the person has not stated
 *  yet, and someone dropping a receipt to file it away does not want an answer.
 *  So: store it, SAY SO, and ask. The next message carries the intent, and by
 *  then the file is already in the session — the row was appended with its
 *  attachments BEFORE this short-circuit, so the following turn's tail names it
 *  automatically. The model ends up with exactly `{file_refs, user_prompt}` on
 *  one call instead of two.
 *
 *  ⚠ "Attachment received." was the whole reply before, which is a dead end: it
 *  reports an event and invites nothing, so a person with something in mind has
 *  to guess that a follow-up would even be understood.
 *
 *  ⚠ Names come from the same live resolver the tail marker uses, but the
 *  REAL-FILENAMES-OR-NOTHING rule does NOT apply here: this string goes to a
 *  HUMAN, not to a model. A person reading "Stored 2 files" cannot hallucinate
 *  a filename from it; a model given the same shape would. Falling back to a
 *  count is therefore fine, and better than refusing to acknowledge the drop. */
/** D-172 P2 — the same words the messenger short-circuit uses, for the
 *  webclient. Shared deliberately: two surfaces phrasing "your file is stored,
 *  now tell me what to do" differently would read as two different features.
 *  ⚠ Human-facing, so a COUNT fallback is fine here — the real-filenames-or-
 *  nothing rule guards MODEL-facing copy, where a shape without values invites
 *  an invented name. */
export const wordlessDropAffordance = (
  attachments: readonly { file_id: string }[],
  names: ReadonlyMap<string, string>,
): string => {
  const named = attachments
    .map((a) => names.get(a.file_id))
    .filter((n): n is string => n !== undefined && n.length > 0);
  const subject = named.length === attachments.length && named.length > 0
    ? named.join(', ')
    : attachments.length === 1 ? 'your file' : `${attachments.length} files`;
  return `Stored ${subject}. What would you like me to do with ${
    attachments.length === 1 ? 'it' : 'them'}?`;
};

const mediaOnlyAffordance = (
  media: NonNullable<ChannelInbound['media']>,
  names: ReadonlyMap<string, string>,
): string => {
  if (isVoiceOnlyMedia(media)) {
    return 'Voice message received. Transcription is not configured yet.';
  }
  return wordlessDropAffordance(media, names);
};

const isVoiceOnlyMedia = (media: NonNullable<ChannelInbound['media']>): boolean =>
  media.length === 1 && media[0]?.media_class === 'voice';

const transcribeMessengerVoiceOnly = async (
  deps: MessengerVoiceTranscriptionDeps | undefined,
  media: NonNullable<ChannelInbound['media']>,
): Promise<string | null> => {
  if (!deps || !isVoiceOnlyMedia(media)) return null;
  const record_id = media[0]?.file_id;
  if (!record_id) return null;

  try {
    const fileReadDeps = deps.getFileReadDeps?.();
    const file = fileReadDeps
      ? await handleFileRead(fileReadDeps, { record_id })
      : deps.readFile
        ? await deps.readFile(record_id)
        : null;
    if (!file) return null;
    const result = await transcribe(
      {
        audio: Buffer.from(file.bytes_b64, 'base64'),
        mime_type: file.mime_type,
        filename: file.filename,
      },
      deps.transcribeDeps,
    );
    return result.text;
  } catch {
    return null;
  }
};

/** Internal-channel dispatch context builder. Strictly enforces the
 *  channel invariant: `internal_function_call` requires session_id +
 *  forbids mcp_token_id (asserted at the registry layer too).
 *
 *  D-153 P2.C — threads the turn's `ExecutionSource` onto the ctx so
 *  registry-routed Tier 1 `recipe.run` + Tier 2 dispatches arrive at
 *  the execute-handler with the per-cell policy gate primed. The source
 *  is the turn's REAL channel-minted identity when the caller threads
 *  one (the messenger turn passes its inbound's `(messenger ×
 *  user_self)` source, so messenger dispatches are gated under the
 *  MESSENGER cell + session-granted per Slack / Telegram thread —
 *  no longer disguised as chat); absent, the chat-shaped default
 *  stands (chat's own turns + the public `dispatch` seam's per-Tier-1
 *  callers). A contract-scoped shared-turn caller also threads its
 *  dispatch-time `ContractSnapshot`; owner chat/messenger omit it. */
const buildInternalDispatchCtx = (
  session_id: string,
  turn_id: string,
  execution_source?: ExecutionSource,
  contract_snapshot?: ContractSnapshot,
  dispatch_depth?: number,
  turn_state?: Map<string, unknown>,
): ChatDispatchContext => ({
  channel: 'internal_function_call' as ChatDispatchChannel,
  session_id,
  turn_id,
  ...(turn_state !== undefined ? { turn_state } : {}),
  // D-177 P5a — the chat turn rides the source (N.10 `turn_id` plumbing),
  // so every commit a Tier 1/2/3 dispatch writes carries its origin turn.
  // (The messenger variant carries no turn_id — its D-177 origin unit is
  // the run, per `deriveOriginUnit`'s N.10 table.)
  execution_source: execution_source ?? buildChatExecutionSource(session_id, turn_id),
  ...(contract_snapshot !== undefined ? { contract_snapshot } : {}),
  // D-160 P3 / I-7 — the turn's hop token rides beside the source so a
  // re-entrant messenger fire's tool dispatches run at their true depth.
  ...(dispatch_depth !== undefined ? { dispatch_depth } : {}),
});

/** D-196 llm_gateway-only customer usage seam. The HTTP gateway will inject one
 *  instance per admitted customer turn; owner chat, messenger, mcp_chat, and
 *  direct MCP omit it and therefore preserve their existing counting behavior.
 *
 *  This seam deliberately surrounds one top-level model-emitted tool dispatch,
 *  not registry/recipe internals. A seller-authored recipe may fan out to many
 *  ingredient calls while remaining one customer-visible `tool_call` unit. */
export interface LlmGatewayToolUsageCall {
  readonly session_id: string;
  readonly turn_id: string;
  readonly tool_name: string;
  readonly arg_values: unknown;
  readonly picker_target: ChatPickerTarget;
}

export type LlmGatewayToolUsageAdmission =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly result: Extract<ChatDispatchResult, { ok: false }>;
    };

export interface LlmGatewayToolUsageMeter {
  /** Check the gateway customer's `tool_call` allowance immediately before
   *  actual local/peer dispatch. A denial returns a model-facing tool result
   *  and must not cross the dispatch boundary. */
  admit(
    call: LlmGatewayToolUsageCall,
  ): LlmGatewayToolUsageAdmission | Promise<LlmGatewayToolUsageAdmission>;
  /** Record exactly one successfully-dispatched top-level tool call. Rollup
   *  failures are observability failures and do not rewrite the tool result. */
  record(call: LlmGatewayToolUsageCall): void | Promise<void>;
  /** Cancel the admission reservation when actual dispatch fails or throws. */
  release(call: LlmGatewayToolUsageCall): void | Promise<void>;
}

/** P1.2 scaffold dispatch helper. Public so future per-Tier-1 wiring
 *  (P1.3) can call through one seam that handles broadcast emission +
 *  audit + provenance + result_ref bookkeeping.
 *
 *  **Codex P2 fold (D-137 P1.2 review).** `tier` is no longer a
 *  caller-supplied parameter — it is derived from `registry.getByName
 *  (tool_name).tier` so provenance + audit rows can never be mislabeled
 *  by future tool-loop glue. Unknown tools resolve to tier 2 (recipe-
 *  engine layer; the registry's `dispatch` returns `unknown_tool` for
 *  those). */
export interface OrchestratorDispatch {
  /** Dispatch a tool call within a turn, broadcasting the start /
   *  complete events + emitting an audit row. Returns the result for
   *  the orchestrator's tool-loop bookkeeping.
   *
   *  D-137 P4 § A.7 — `picker_target` discriminates the dispatch path:
   *    - `'self'`             → InternalToolRegistry (Tier 1/2/3 union).
   *    - (⛔ D-228 slice 5 — the `connection.mcp.<n>` route is retired
   *      via the named connection). The seam stays open: when no
   *      peer dispatcher is wired (current test harnesses), peer-
   *      target dispatches return `connection_unavailable`. */
  dispatchTool(args: {
    session_id: string;
    turn_id: string;
    /** Correlates a write proposal with an explicit verify-before-retry turn.
     * Never used as approval or dispatch authority. */
    retry_of_plan_id?: string;
    /** Hard dispatch fence for explanation-only turns. Only tools explicitly
     * classified as reads may cross the registry/peer boundary. */
    read_only?: boolean;
    tool_name: string;
    arg_values: unknown;
    /** D-219 — which tool-loop ROUND emitted this call.
     *
     *  ⛔ THE ONE THING TIMESTAMPS CANNOT RECOVER. The compiler derives a
     *  flow's shape from audit rows ordered by timestamp, so two tools the
     *  model emitted TOGETHER in one round and two it emitted in sequence
     *  across two rounds are indistinguishable afterwards — both read as an
     *  ordered pair. Measured on a real llm run: the same prompt produced
     *  `mail.search+contact.search` in one round three times and
     *  `contact.search | mail.search` across two rounds once, and every one of
     *  those four turns compiled to the same kind of two-step chain.
     *
     *  That difference is the substance of what a procedure is worth learning
     *  FOR — a batched pair is one round-trip, a sequenced pair is two — so a
     *  card built without it cannot express the better shape even in principle.
     *  Absent ⇒ recorded as unknown, never guessed from proximity (§4.2 refuses
     *  structure inferred from timestamps, and this is that inference). */
    round_index?: number;
    picker_target: ChatPickerTarget;
    /** The turn's REAL channel-minted `ExecutionSource` — threaded by the
     *  turn driver so a messenger turn's dispatches are gated under the
     *  `(messenger × user_self)` cell (and session-granted per Slack /
     *  Telegram thread) rather than disguised as chat. Absent → the
     *  chat-shaped default (`buildChatExecutionSource`), preserving every
     *  pre-existing caller of this public seam. */
    execution_source?: ExecutionSource;
    /** Contract snapshot paired with a contract-bearing execution source.
     *  Gateway turns must thread both together; owner chat omits both. */
    contract_snapshot?: ContractSnapshot;
    /** D-196 gateway-only per-tool usage hook. Omitted by every other chat/MCP
     *  surface so sharing the turn engine cannot silently double-count them. */
    llm_gateway_tool_usage?: LlmGatewayToolUsageMeter;
    /** The turn's I-7 hop token (`ChannelInbound.dispatch_depth`),
     *  riding beside the source (D-160 P3) so the Gateway's
     *  `MAX_DISPATCH_DEPTH` ceiling bounds re-entrant messenger loops
     *  THROUGH tool dispatches. Absent → the execute path's depth-0
     *  default. */
    dispatch_depth?: number;
    /** Framework-owned process-local state for this cooperative turn. */
    turn_state?: Map<string, unknown>;
  }): Promise<ChatDispatchResult>;
}

/** ⛔⛔ D-228 slice 5 — `PeerDispatcher` REMOVED. It described the outbound half
 *  of the MCP scope-picker: list a peer's tools, dispatch one, read its probed
 *  signature. **It had ZERO implementors** — nothing in the tree ever
 *  constructed one — so every peer-scoped dispatch returned
 *  `connection_unavailable` in production. Specified, never built, and now
 *  unnecessary: a peer's tools are minted into a local pack and dispatch through
 *  the ordinary Self path as `recued_op_*` operations. */


export interface ChatOrchestrator {
  /** Start a turn — persists the user message, mints a turn_id, and
   *  emits a `chat.message_complete` placeholder once the turn loop
   *  completes (P1.2 ships an empty-assistant immediate ack; P1.3 fills
   *  in the main turn + the actual tool loop). */
  runTurn(input: ChatTurnInput): Promise<ChatTurnAck>;
  /** D-160 A.8 step 6 — run one `messenger` turn over the SAME
   *  `streamRegistry` (the s5 hooks) + the SAME `runChatTurn` mechanics as
   *  `runTurn`, via the framework `runStream` loop with a caller-injected
   *  messenger `Channel` (the BYO Slack/Telegram transport + webhook-inbound
   *  wiring is the deferred downstream consumer). The framework's
   *  post-`update` `out.message` delivers the final answer over the channel's
   *  transport. */
  runMessengerTurn(input: MessengerTurnInput): Promise<ChatTurnAck>;
  /** D-196 — stateless contracted-customer adapter over the SAME
   * `runChatTurn` mechanics as owner chat. It deliberately skips durable owner
   * history and owner-private middleware, projects a contract catalog, and
   * obtains a fresh snapshot for every tool dispatch. */
  runLlmGatewayTurn?(input: LlmGatewayTurnInput): Promise<LlmGatewayTurnResult>;
  /** D-160 N.5 — the ONE chat-history store both surfaces share. The
   *  orchestrator builds it once (the cache-only store over the durable
   *  ChatStore that warms `runStream`'s history reads); the messenger
   *  wiring builds its channel over THIS instance and passes it back
   *  through `MessengerTurnInput.sessionStore`, so chat and messenger
   *  are one conversation seen through two windows. */
  sessionStore: SessionStateStore;
  /** Expose the dispatch seam so per-Tier-1 wiring in P1.3 can
   *  invoke through the same audit + broadcast envelope. */
  dispatch: OrchestratorDispatch;
}

const safeLogActivity = async (
  auditLog: AuditLogStore | undefined,
  action: Parameters<AuditLogStore['logActivity']>[0]['action'],
  target: string,
  detail?: string,
): Promise<void> => {
  if (!auditLog) return;
  try {
    await auditLog.logActivity({
      activity_id: '',
      timestamp: Date.now(),
      action,
      target,
      ...(detail ? { detail } : {}),
    });
  } catch {
    // Audit failures are observability-only; never abort the turn.
  }
};

const safeBroadcast = (
  broadcast: ChatBroadcastEmitter | undefined,
  event: BroadcastChatEvent,
): void => {
  if (!broadcast) return;
  try {
    broadcast.emit(event);
  } catch {
    // Broadcast failures are observability-only; never abort the turn.
  }
};

/** Resolve the model-pref discriminator on a turn. Falls back to the
 *  bare comfort layer `'byok'` (D-191: "local" is no longer a routing
 *  layer); ignores garbage input. */
const resolveModelPref = (
  session: ChatSession | null,
  override?: { current: string },
): ChatModelRoutingLayer => {
  if (override && isChatModelRoutingLayer(override.current)) {
    return override.current;
  }
  if (session && isChatModelRoutingLayer(session.model_routing.current)) {
    return session.model_routing.current;
  }
  return 'byok';
};

/** § A.14 slot-aware chat routing — resolve the BYOK slot capability hint on
 *  a turn: a per-turn override wins, else the session's stored hint, else
 *  `undefined` (the turn uses its default tier). The hint selects WHICH BYOK
 *  slot resolves (D-191: routing is `slot_1`/`slot_2`/`free_pool` — there is
 *  no force-local layer). */
const resolveModelHint = (
  session: ChatSession | null,
  override?: { model_hint?: unknown },
): ChatModelHint | undefined => {
  if (override && isChatModelHint(override.model_hint)) {
    return override.model_hint;
  }
  if (session && isChatModelHint(session.model_routing.model_hint)) {
    return session.model_routing.model_hint;
  }
  return undefined;
};

/** D-191 Phase 6 — resolve the picked slot key on a turn: a per-turn override
 *  wins, else the session's stored `source_id`, else undefined. Only a valid
 *  `ChatModelSourceId`; the turn pins `slot_1`/`slot_2` at the matcher
 *  (`free_pool` / undefined → no pin, normal routing). */
const resolveModelSourceId = (
  session: ChatSession | null,
  override?: { source_id?: unknown },
): ChatModelSourceId | undefined => {
  if (override && isChatModelSourceId(override.source_id)) {
    return override.source_id;
  }
  if (session && isChatModelSourceId(session.model_routing.source_id)) {
    return session.model_routing.source_id;
  }
  return undefined;
};

/** Resolve the tier discriminator for a Self-picker tool dispatch.
 *  Tier 2 / Tier 3 enumeration lands in Wave 2; P1.2 maps all known
 *  Tier 1 names to tier 1 + everything else to tier 2 (recipe
 *  lookups) as a placeholder. P1.3 widens this against the registry's
 *  `getByName(name)?.tier` once Tier 2 + Tier 3 entries surface. */
const resolveTier = (
  registry: InternalToolRegistry,
  tool_name: string,
): 1 | 2 | 3 => {
  const entry = registry.getByName(tool_name);
  if (entry) {
    return entry.tier;
  }
  // Conservative fallback — names not in the registry surface a Tier 2
  // dispatch shape (the audit consumer treats unknown_tool below).
  return isTier1ToolName(tool_name as Tier1ToolName) ? 1 : 2;
};

/** D-137 P1.4 — Project recent chat history into the main-turn
 *  `chat_tail` shape. Tail length is the local `CHAT_TAIL_LIMIT` (=3);
 *  we pull the last N user/assistant pairs and drop tool/system rows
 *  (those carry provenance + state shifts, not conversational
 *  context).
 *
 *  Codex P1.4 review P2 fold — `ChatVaultLockedError` is a signal
 *  (the user's vault has been re-locked) NOT a transient storage
 *  error. Rethrow it so the orchestrator surface fails the turn
 *  cleanly instead of silently sending a degraded packet to the AI.
 *  Any other read failure (corrupt row, transient IO) still degrades
 *  to an empty tail — the substrate stays reachable on data-quality
 *  issues without losing the turn entirely. */
const CHAT_TAIL_LIMIT = 3;

interface BuiltChatTail {
  readonly messages: ReadonlyArray<ChatTailMessage>;
  /** Exact durable rows represented by `messages`, kept server-private. */
  readonly item_ids: readonly string[];
}

/** D-172 P2 — resolve attached `data.file` ids to their CURRENT filenames.
 *
 *  ⛔ RESOLVED LIVE, NEVER DENORMALIZED ONTO THE MESSAGE ROW. Storing the name
 *  beside the id at append time would be cheaper per turn and wrong in the one
 *  case that matters: a file the owner has since deleted would still be named
 *  in the tail, and the model would confidently offer to attach an id that
 *  resolves to nothing. Resolving live means a deleted file simply stops
 *  appearing — the model cannot name what is gone. */
export type ChatFileNameResolver = (
  file_ids: readonly string[],
) => ReadonlyMap<string, string>;

/** ⛔ REAL FILENAMES OR NOTHING. The substrate-bench measured that giving a
 *  model SHAPE WITHOUT VALUES multiplies fabrication odds ~5.5× — it fills the
 *  slot it can see. So a bare "[2 files attached]" marker would be worse than
 *  silence: it announces files and invites invented names. A file whose record
 *  does not resolve is therefore OMITTED from the marker rather than listed as
 *  a bare id.
 *
 *  The id rides alongside the name because naming is the whole point: the model
 *  can pass it straight to a recipe that takes files without a lookup round-trip.
 *  Reading the CONTENT still requires the Gateway-gated `data-file-read`. */
export const renderAttachmentMarker = (
  attachments: readonly { file_id: string }[],
  names: ReadonlyMap<string, string>,
): string => {
  const named = attachments
    .map((a) => ({ id: a.file_id, name: names.get(a.file_id) }))
    .filter((a): a is { id: string; name: string } => a.name !== undefined);
  if (named.length === 0) return '';
  const list = named.map((a) => `${a.name} (${a.id})`).join(', ');
  return `\n[files attached to this message: ${list}]`;
};

/** ⚠ EXPORTED FOR THE SEAM TEST, and that is not incidental. `renderAttachmentMarker`
 *  is a pure function with its own tests — and those tests pass whether or not
 *  anything CALLS it. A marker function nobody invokes is the same
 *  built-typed-tested-and-unreachable shape that has bitten this codebase
 *  repeatedly, so the join is covered here rather than assumed. */
export const buildChatTail = async (
  chatStore: ChatStore,
  session_id: string,
  resolveFileNames?: ChatFileNameResolver,
): Promise<BuiltChatTail> => {
  try {
    // Bounded read: the last CHAT_TAIL_LIMIT conversational rows, selected and
    // role-filtered in SQL. This used to be `listMessages` + a JS slice, which
    // read and DECRYPTED the whole session on every turn to use three rows —
    // so per-turn cost grew with conversation length (12.3ms at 2000 turns).
    //
    // ⚠ The role filter below is kept as defence in depth, NOT as the
    // guarantee: the SQL already restricts to user/assistant. It is here
    // because `ChatMessage.role` is the wide type and narrowing it with a cast
    // would silence exactly the check that would catch the query drifting.
    // Three rows — the filter costs nothing.
    const selected = (await chatStore.listRecentConversational(
      session_id,
      CHAT_TAIL_LIMIT,
    )).filter(
      (m): m is ChatMessage & { role: 'user' | 'assistant' } =>
        m.role === 'user' || m.role === 'assistant',
    );
    // D-172 P2 — name the files this window carries. Without it the model is
    // never told a dropped file exists at all: attachments are persisted on the
    // row and were dropped here, so the ONLY file that ever reached a model was
    // the voice-only transcript. ⚠ The tail is CHAT_TAIL_LIMIT rows, so this is
    // the recent window by construction — anything older is `file.search`'s job,
    // which is the same split on purpose.
    const attachedIds = [
      ...new Set(selected.flatMap((m) => (m.attachments ?? []).map((a) => a.file_id))),
    ];
    const names = attachedIds.length > 0 && resolveFileNames !== undefined
      ? resolveFileNames(attachedIds)
      : new Map<string, string>();

    return {
      messages: selected.map((m) => {
        const marker = m.attachments && m.attachments.length > 0
          ? renderAttachmentMarker(m.attachments, names)
          : '';
        return {
          role: m.role,
          // Appended to the model's COPY of the turn only — `selected` is
          // mapped, never mutated, so nothing is written back to the stored
          // message and chat history still renders what the person typed.
          content: marker.length > 0 ? `${m.content}${marker}` : m.content,
        };
      }),
      item_ids: selected.map((m) => m.id),
    };
  } catch (e) {
    if (e instanceof ChatVaultLockedError) {
      // Locked vault is a load-bearing user state, not a transient
      // read failure. Surface it to the orchestrator's runTurn caller
      // so the rpc handler can map to a clean 401/locked error envelope
      // rather than processing a turn against a vault the user has
      // since re-locked.
      throw e;
    }
    // ⛔ A PROGRAMMING ERROR MUST NOT DEGRADE TO "no recent context". The
    // degradation below is for DATA problems — a corrupt row, transient IO —
    // where losing the tail beats losing the turn. A `TypeError` here means the
    // store handed us something that is not the interface (a hand-rolled double
    // missing `listRecentConversational`, a mis-wired dep), and swallowing that
    // ships a chat where the model silently sees no history: every turn reads
    // like the first one, and nothing anywhere reports it.
    if (e instanceof TypeError) throw e;
    return { messages: [], item_ids: [] };
  }
};

/** D-137 W2.2 § A.1.1 — Project Mary's per-kind catalog scope state
 *  into the `Set<IngredientKind>` `buildChatMainTurnTools` consumes.
 *
 *  Two distinct cases:
 *    - **Missing snapshot** (`null` / `undefined` / non-array
 *      `enabled_kinds`) — the orchestrator has no idea what Mary
 *      wants (store-unavailable race, dbless test harness,
 *      pre-init boot window). Fall back to
 *      `SAFE_DEFAULT_CHAT_CATALOG_KINDS` so the substrate stays
 *      reachable.
 *    - **Explicit empty** (`enabled_kinds: []`) — Mary deliberately
 *      disabled every kind via the Settings page (the contracts
 *      validator + Settings UI explicitly support this as "disable
 *      every Tier 2 kind"). Respect it verbatim; promoting an empty
 *      scope back to defaults would silently override Mary's intent.
 *
 *  Codex W2.2 review P1 fold — the prior `out.size === 0 → fall back
 *  to safe defaults` branch conflated those two cases and let a
 *  saved-empty setting silently re-enable every safe-default kind.
 *
 *  Off-list values in the persisted blob are already caught upstream
 *  (contracts validator at write time + store-side `parseEnabledKinds-
 *  Json` at read time, which returns null on any non-IngredientKind
 *  member and triggers the missing-snapshot branch). The defensive
 *  filter below is belt-and-braces for hand-edited rows that slipped
 *  past both layers. Pure; no clock, no I/O. */
export const resolveEnabledKinds = (
  scope: ChatToolCatalogScopeState | null | undefined,
): ReadonlySet<IngredientKind> => {
  if (!scope || !Array.isArray(scope.enabled_kinds)) {
    return new Set<IngredientKind>(SAFE_DEFAULT_CHAT_CATALOG_KINDS);
  }
  const out = new Set<IngredientKind>();
  for (const k of scope.enabled_kinds) {
    if (typeof k === 'string' && INGREDIENT_KINDS.has(k as IngredientKind)) {
      out.add(k as IngredientKind);
    }
  }
  return out;
};

export const createChatOrchestrator = (
  deps: ChatOrchestratorDeps,
): ChatOrchestrator => {
  const now = deps.now ?? Date.now;
  const mintId = deps.mintId ?? randomUUID;
  const selfDisplayName = deps.selfDisplayName ?? 'Self';

  // D-160 — the framework substrate the chat turn runs THROUGH.
  // The channel carries the generic streaming delta (the `TurnExecutor`
  // closure's `ctx.out.token` → sink → bus) + the framework's out-stream
  // projection; its bus is the orchestrator's own broadcast emitter (the
  // sink emits exactly that shape), so token deltas land on the same
  // D-121 bus as the rich direct emits. `deliverFinalMessage: false`
  // keeps `chat.message_complete` owned by the RICH finalize below (it
  // carries the full ChatMessage row that the channel — holding only the
  // assistant text mid-stream — cannot). The cache-only session store
  // warms `runStream`'s history read; durable rows stay owned by the
  // finalize. Built once; `preload` per turn rebuilds the per-session cache.
  const streamChannelBus = deps.broadcast ?? { emit: () => {} };
  const { channel: streamChannel, sessionStore: streamSessionStore } =
    createServerChatChannel({
      bus: streamChannelBus,
      chatStore: deps.chatStore,
      userId: LOCAL_CHAT_USER_ID,
      deliverFinalMessage: false,
    });

  // D-160 Stage 3 (N.9 / A.8 step 3) — the turn concerns are REGISTERED
  // HOOKS over the shared `state`: build the source-binding adapters from
  // the live first-party registry + the existing per-pair stores, and
  // register them so `runStream` drives them at each lifecycle hook
  // (`standing-instructions` Checkpoint 1 + `scope-search` + `correction-
  // learning` in the before-turn phase; `standing-instructions` Checkpoint 2
  // + `confidence-shape` + `personal-recipes` in the after-turn phase). Each
  // adapter honours the first-party registry's enabled-state + no-ops without
  // its source getter; `scope-search` / `confidence-shape` (A.8 step 5) are
  // bound but FAITHFUL NO-OPS on the live chat path BY DESIGN — the turn-level
  // `getScopeSearchInput` producer is a two-sided seam (no pre-AI intent
  // signal in single-stage + no consumer of the results; the productive
  // fan-out runs at TOOL level in `chat-tool-handlers.ts`). See the
  // `getScopeSearchInput` dep doc above + `chat-stream-middleware.ts`'s
  // file-header block. The source adapters are built only when a `middlewareRegistry`
  // is wired — absent it (the dbless test harness / pre-LLM-config boot
  // path) the registry carries only the always-built `catalog` hook (A.8
  // step 4, below) + any PII bookends; `runStream` still drives them.
  // D-167 P5 S4 — the always-on PII bookends' source bindings. Built whenever
  // a session alias-ledger store is wired, INDEPENDENT of the first-party
  // registry (the bookends are never gated on a per-middleware enabled-state).
  // Aliasing is UNCONDITIONAL — there is no egress posture to resolve (D-191
  // retired force-local routing; the per-turn picker is the routing control,
  // and the reversible alias travels with the data whichever way the turn
  // routes).
  const piiHookDeps: PiiEgressHookDeps | undefined = deps.piiLedgerStore
    ? {
        ledgerStore: deps.piiLedgerStore,
        ...(deps.fieldPrivacyResolver
          ? { resolver: deps.fieldPrivacyResolver }
          : {}),
        ...(deps.getContactKnownValueIndex
          ? { getContactKnownValueIndex: deps.getContactKnownValueIndex }
          : {}),
        // D-213 §3.8 — the scoped-join contributor. No cache to wire: a joined
        // piece is bounded by construction, so the LRU/frontier substrate the
        // whole-session reharvest needed is gone.
        createCandidateContributor: (session_id: string) =>
          createCandidateContributor({
            owner_session_id: session_id,
            store: deps.chatStore,
            now,
          }),
        getRecallJoinedPieces: recallJoinedPieces,
        hasRegisteredRecall: hasRegisteredRecallResult,
        // D-167 — deterministic slot ordering. Wired off the SAME chat store,
        // independent of the candidate cache: the numbering must be stable on
        // every turn, not only on turns that recall.
        seedAliasSlotOrdering: createChatPiiSlotOrderingSeeder({
          store: deps.chatStore,
        }),
      }
    : undefined;

  // D-160 A.8 step 4 — the catalog projection the `catalog` before-turn
  // hook DECIDES. This is the FORMER inline before-turn catalog gather (the
  // post-capability-filter Tier 1/2/3 union → AI-facing `available_tools`),
  // lifted behind a closure the stream adapter calls so the catalog becomes
  // a registered hook (not an inline call). Pure over the per-pair deps
  // (`registry` / `scopeProvider` / `annotationProvider`)
  // + the per-turn picker target; the hook writes the result to shared
  // `state`, the executor ENACTs it. The D-164 P3 6-section catalog
  // substrate is the salvage path that replaces this projection's internals
  // later — this slice establishes the wiring (catalog source depends on the
  // picker target per D-137 P4 § A.7: self → local Tier 1/2/3 union; peer →
  // the peer's already-classified projection, NO self fallback / local
  // gates).
  // Lever-2 — the static fallback projection (absent dep → launch baseline,
  // full arg_schema per entry). Per-slot: `resolveTurnProjection` resolves the
  // projection from the TURN's source (turn-fixed → still turn-invariant /
  // D-164 prefix-safe); the `catalog` before-turn hook receives it per turn.
  const catalogProjection = deps.catalogProjection ?? DEFAULT_CHAT_CATALOG_PROJECTION;
  const resolveTurnProjection = (
    source: ChatModelSourceId | undefined,
  ): ChatCatalogProjectionConfig =>
    deps.catalogProjectionForSource
      ? deps.catalogProjectionForSource(source)
      : catalogProjection;
  // D-225 § 9.8.1 — the turn's `source` arrives per CALL (this closure is bound
  // at orchestrator construction, where no turn exists yet), so the raw-op half
  // of the catalog can be derived from the caller's contract.
  const buildCatalog: ChatCatalogBuilder = (picker_target, projection, source) => {
    // ⛔ D-228 slice 5 — no peer branch: `picker_target` can only be `'self'`
    // now, so the catalog is always this server's own registry.
    // D-247 D9 — Tier-2 membership reads the owner's `recipe.*` grant. Filtered
    // HERE because `buildCatalog` already holds the turn's source, one line above
    // where `rawOpSource(source)` uses it for the same reason. ⛔ This is one of
    // THREE exposure surfaces (chat catalog / `tools.search` / the MCP door's
    // `tools/list`) and they fail independently.
    // D-247 — for an OWNER-governed turn the Tier-2 half is REPLACED by the
    // grant-decided projection (which sees hidden recipes too, so a grant can
    // widen past `chat_exposed`). For anything else the registry's own entries
    // stand, still filtered by the flag, because a door has no `recipe.*` axis.
    const ownerTier2 = deps.tier2OwnerCatalog?.(source) ?? null;
    const tier2Reachable = deps.tier2GrantFilter?.(source);
    const registryEntries = deps.registry.list();
    const catalogEntries = ownerTier2 !== null
      ? [...registryEntries.filter((e) => e.tier !== 2), ...ownerTier2]
      : tier2Reachable
        ? registryEntries.filter((e) => e.tier !== 2 || tier2Reachable(e.name))
        : registryEntries;
    const enabledKinds = resolveEnabledKinds(
      deps.scopeProvider ? deps.scopeProvider() : null,
    );
    const kindGatedTier2Names =
      computeKindGatedTier2Names(catalogEntries, enabledKinds);
    // ⛔⛔ D-228 slice 4 — THERE IS NO TIER-3 CATALOG ANY MORE. Its entries were
    // projected from `tool_overrides`, the chat presentation store D-225 named
    // as the standing defect; slice 3 stood them down per tool as packs covered
    // them, and this slice deletes the store. An enrolled MCP tool now reaches
    // chat exactly once — as a `recued_op_*` pack operation governed by the
    // contract — instead of twice through two different gates.
    //
    // ⚠ The empty set is still THREADED rather than removed from
    // `buildChatMainTurnTools`: its parameter is a general "names to withhold"
    // seam, and emptying the only current producer is not a reason to delete a
    // seam the next one would have to re-add.
    const disabledTier3Names = new Set<string>();
    // D-225 § 9.8.1 — raw catalog ops are DERIVED from the turn's contract
    // rather than assembled and filtered at dispatch.
    const rawOps = deps.rawOpSource ? deps.rawOpSource(source) : [];
    return buildChatMainTurnTools(
      [...catalogEntries, ...(rawOps as typeof catalogEntries)],
      kindGatedTier2Names,
      disabledTier3Names,
      projection,
    );
  };

  // The stream registry is now ALWAYS populated: the `catalog` hook (A.8
  // step 4) is built from the always-present `buildCatalog`, so — unlike the
  // pre-step-4 path that stayed empty without a `middlewareRegistry` / PII —
  // there is always at least one producer (the inline catalog gather it
  // replaces ran on every turn, so the hook must too). The `middlewareRegistry`
  // / `piiHookDeps` arms inside `createChatStreamMiddlewares` still gate the
  // source adapters / PII bookends; absent both, the registry carries the lone
  // catalog hook.
  const streamRegistry = createMiddlewareRegistry();
  for (const middleware of createChatStreamMiddlewares({
    ...(deps.middlewareRegistry ? { registry: deps.middlewareRegistry } : {}),
    buildCatalog,
    ...(deps.getCorrectionEventsStore
      ? { getCorrectionEventsStore: deps.getCorrectionEventsStore }
      : {}),
    ...(deps.getContactStore ? { getContactStore: deps.getContactStore } : {}),
    ...(deps.getScopeSearchInput
      ? { getScopeSearchInput: deps.getScopeSearchInput }
      : {}),
    ...(deps.getScopedGrantParseDeps
      ? { getScopedGrantParseDeps: deps.getScopedGrantParseDeps }
      : {}),
    ...(deps.getSpanAnchorDeps
      ? { getSpanAnchorDeps: deps.getSpanAnchorDeps }
      : {}),
    ...(deps.getExecutionCaseAugmentationDeps
      ? {
          getExecutionCaseAugmentationDeps:
            deps.getExecutionCaseAugmentationDeps,
        }
      : {}),
    ...(deps.getExecutionCasePrecedentDeps
      ? {
          getExecutionCasePrecedentDeps:
            deps.getExecutionCasePrecedentDeps,
        }
      : {}),
    ...(deps.getExecutionCaseLifecycle
      ? { getExecutionCaseLifecycle: deps.getExecutionCaseLifecycle }
      : {}),
    ...(deps.getExecutionCaseOfferLifecycle
      ? {
          getExecutionCaseOfferLifecycle:
            deps.getExecutionCaseOfferLifecycle,
        }
      : {}),
    ...(piiHookDeps ? { pii: piiHookDeps } : {}),
    now,
  })) {
    streamRegistry.register(middleware);
  }

  /** D-137 P4 § A.7 — `picker_at_send` builder. Self turns carry the
   *  orchestrator's own signature; peer turns carry the peer's probed
   *  signature when the dispatcher knows it (falls back to Self so the
   *  message row always has a non-null shape — the absent-peer case
   *  surfaces as `connection_unavailable` at dispatch time, never as a
   *  malformed row). */
  const buildPickerAtSend = (_target: ChatPickerTarget): ChatMessage['picker_at_send'] => {
    // ⛔ D-228 slice 5 — ALWAYS THIS SERVER. The peer arm read the probed
    // signature off `PeerDispatcher`; peer scoping is retired and no peer target
    // can arrive.
    //
    // ⚠ THE FIELD STAYS, and that is deliberate: it is PERSISTED on every chat
    // message row, and rows written before this slice may name a peer. Dropping
    // it (or narrowing `ChatPickerTarget`) would make the store lie about
    // history it already holds. New rows simply always record self.
    return { display_name: selfDisplayName, signature: deps.selfSignature };
  };

  const persistPlanExecution = async (
    plan_id: string | undefined,
    execution: ChatPlanExecutionReceipt,
  ): Promise<void> => {
    if (
      plan_id === undefined
      || deps.planApprovalStore?.recordExecution === undefined
    ) return;
    try {
      const persisted = await deps.planApprovalStore.recordExecution(
        plan_id,
        execution,
      );
      if (persisted === undefined) {
        console.error(
          `[chat] approval execution receipt refused for ${plan_id}`,
        );
      }
    } catch (error) {
      console.error(
        `[chat] approval execution receipt persistence failed for ${plan_id}`,
        error,
      );
      // If terminal detail cannot be encrypted (for example the vault locked
      // during an external call), at least close the durable `running` claim
      // to conservative uncertainty. This fallback carries no sensitive body.
      if (execution.status !== 'unknown') {
        try {
          await deps.planApprovalStore.recordExecution(plan_id, {
            status: 'unknown',
            turn_id: execution.turn_id,
          });
        } catch (fallbackError) {
          console.error(
            `[chat] approval execution recovery fallback failed for ${plan_id}`,
            fallbackError,
          );
        }
      }
    }
  };


  /** ⛔⛔ D-228 slice 5 — `dispatchToolToPeer` REMOVED with the MCP scope-picker.
   *
   *  It dispatched a `connection.mcp.<name>`-scoped tool through
   *  `PeerDispatcher` — an interface with ZERO implementors, so this path always
   *  returned `connection_unavailable` in production. Its whole reason for
   *  existing was the per-conversation peer scope switch, which is retired: a
   *  peer's tools are minted into a LOCAL pack and reach chat as ordinary
   *  `recued_op_*` operations governed by the contract, dispatched by the same
   *  Self path as everything else. */

  const dispatchTool: OrchestratorDispatch['dispatchTool'] = async ({
    session_id,
    turn_id,
    retry_of_plan_id,
    read_only,
    tool_name,
    arg_values,
    round_index,
    picker_target,
    execution_source,
    contract_snapshot,
    llm_gateway_tool_usage,
    dispatch_depth,
    turn_state,
  }) => {
    // D-219 — ONE builder for every `chat_tool_call` detail on this path.
    //
    // ⛔ There are three write sites (mcp-wire, peer, internal) and they were
    // three hand-copied object literals. A field added to one of them is a
    // field silently missing from the other two, and the compiler reads all
    // three as the same kind of row — the enumerating-copier shape this
    // codebase has been bitten by before. Routing them through one function
    // makes a new field impossible to drop at a site.
    const toolCallDetail = (
      fields: Record<string, unknown>,
    ): string => JSON.stringify({
      ...fields,
      // Absent when the caller did not supply one (a non-tool-loop dispatch —
      // messenger, MCP wire, a resumed run). Recorded as absent rather than
      // defaulted to 0, because "round 0" is a claim and "unknown" is the truth.
      ...(round_index !== undefined ? { round_index } : {}),
    });
    // D-137 P4 § A.7 — peer-target detection. Peer-routed dispatches
    // go through the outbound MCP wire; Self-routed go through the
    // local registry. The plan-approval gate runs BEFORE the routing
    // split so write-classified peer tools pause behind the same
    // plan-approval card as local writes (Codex P4 review P1 fold
    // #1 — the gate keys off classification, not channel, and must
    // apply uniformly to both paths).
    // ⛔ D-228 slice 5 — the peer arm of this resolution is gone. It read the
    // entry from `peerDispatcher.listToolEntries(peerName)` and fell back to
    // tier 3; no peer target can arrive now, so every dispatch resolves against
    // the local registry (plus the contract-derived raw ops).
    let rawOpEntry: ToolEntry | null = null;
    const internalDispatchCtx = buildInternalDispatchCtx(
      session_id,
      turn_id,
      execution_source,
      contract_snapshot,
      dispatch_depth,
      turn_state,
    );
    const registryEntry = deps.registry.getByName(tool_name);
    if (registryEntry === null && deps.rawOpSource !== undefined) {
      rawOpEntry = (deps.rawOpSource(internalDispatchCtx.execution_source)
        .find((candidate) => candidate.name === tool_name) as ToolEntry | undefined)
        ?? null;
    }
    const entry: ToolEntry | null = registryEntry ?? rawOpEntry;
    let tier: ToolTier = resolveTier(deps.registry, tool_name);
    if (rawOpEntry !== null) tier = rawOpEntry.tier;

    // Guided Data diagnosis is an explanation-only turn. Enforce that at the
    // final tool boundary, before approval lookup/consumption: prompt wording
    // alone cannot prevent a model-emitted write from matching an unrelated
    // still-valid approval for the same arguments. Unknown classifications
    // fail closed; only an explicit `read` may run.
    if (read_only === true && entry?.classification !== 'read') {
      const result: ChatDispatchResult = {
        ok: false,
        reason: entry === null ? 'unknown_tool' : 'classification_blocked',
        detail:
          entry === null
            ? 'Guided diagnosis could not resolve this read-only tool.'
            : 'Guided diagnosis is read-only; this tool was not executed.',
      };
      safeBroadcast(deps.broadcast, {
        kind: 'chat.tool_call_completed',
        session_id,
        turn_id,
        tool_name,
        tier,
        status: 'error',
        reason: result.reason,
        detail: result.detail!,
      });
      await safeLogActivity(
        deps.auditLog,
        'chat_tool_call',
        `${session_id}:${turn_id}:${tool_name}`,
        toolCallDetail({
          // ⛔ D-228 slice 5 — always the internal channel now; the `mcp_wire`
          // arm belonged to peer-scoped dispatch, which is retired.
          channel: 'internal_function_call' satisfies ChatDispatchChannel,
          tier,
          status: 'error',
          reason: result.reason,
          read_only: true,
        }),
      );
      return result;
    }

    // D-196 shared-turn hardening — a gateway meter is valid only on a
    // known, contract-bound customer-chat dispatch. Resolve this structural
    // authority before usage admission or actual tool work. With no meter,
    // owner chat/messenger retain their exact existing behavior.
    if (llm_gateway_tool_usage !== undefined) {
      if (entry === null) {
        return { ok: false, reason: 'unknown_tool' };
      }
      if (!isLlmGatewayContractSafeToolEntry(entry)) {
        return {
          ok: false,
          reason: 'classification_blocked',
          detail: 'llm_gateway dispatch is limited to contract-safe Tier 2 recipes',
        };
      }
      const sourceContractId = execution_source
        ? executionSourceContractId(execution_source)
        : undefined;
      if (
        execution_source?.channel !== 'chat'
        || execution_source.actor !== 'contracted_user'
        || sourceContractId === undefined
        || contract_snapshot === undefined
        || contract_snapshot.contract_id !== sourceContractId
      ) {
        return {
          ok: false,
          reason: 'classification_blocked',
          detail:
            'llm_gateway tool dispatch requires a matching contracted chat source and contract snapshot',
        };
      }
    }

    // Set only when this dispatch consumes an exact reviewed approval. The
    // link rides every post-gate lifecycle event so clients can update the
    // original plan card from execution truth rather than `chat.send` ack.
    let consumedPlanId: string | undefined;

    // D-137 P3 § A.11 — plan-approval gate. When a write tool is
    // dispatched, check the plan registry FIRST. Outcomes, in
    // precedence order:
    //   - SAME-TURN cancelled plan exists → return `plan_cancelled`
    //     without dispatching + without re-proposing (cancel is
    //     turn-scoped per the `plan_cancelled` contract: a later
    //     turn's re-issue mints a fresh proposal).
    //   - A consumable approval exists for `(session, tool, args)` —
    //     turn-AGNOSTIC, since approval lands after the proposing
    //     turn ended and the re-issue carries a new turn_id —
    //     → CONSUME it (single-use `consumed_at` stamp, TTL-bounded,
    //     args-hash-bound) + fall through to normal dispatch.
    //   - Otherwise → mint a proposal (or re-emit the same turn's
    //     still-proposed one), broadcast `chat.plan_proposed`,
    //     return `awaiting_approval`. Mary approves the card; the
    //     main-turn re-issues on her next message; the gate consumes
    //     the approval + dispatches.
    //
    // Tier 1 reads bypass the gate entirely (classification check
    // collapses `'read'` to false in `requiresPlanApproval`); the
    // gate only runs for write-classified entries OR `'unknown'`
    // entries that carry a write-class `risk_tier` /
    // `destructive_hint: true` hint.
    //
    // D-137 P4 Codex review P1 fold #1 — peer dispatches MUST run
    // through the same gate. Peer tools classified `'write'` (e.g.
    // Mary classified `bob.mail.send` as write in Settings) pause
    // behind the same approval card as Self writes; the gate keys
    // off `entry.classification`, not the channel.
    const retryOrigin =
      retry_of_plan_id !== undefined && deps.planApprovalStore !== undefined
        ? await deps.planApprovalStore.get(retry_of_plan_id)
        : undefined;
    const retryTargetsOriginalTool =
      retryOrigin !== undefined
      && retryOrigin.session_id === session_id
      && retryOrigin.tool === tool_name;
    const argsHash = planApprovalModule.computePlanArgsHash(arg_values);
    // Normally only write-classified tools can have an approval. Querying
    // before the classification gate also preserves a freshly-reviewed write
    // if the catalog later drifts to `read`: the approved payload still has to
    // be consumed and linked before dispatch.
    const approvedForCurrentDispatch =
      retry_of_plan_id === undefined
      && deps.planApprovalStore !== undefined
      && entry !== null
        ? await deps.planApprovalStore.findApprovedForDispatch(
            session_id,
            tool_name,
            argsHash,
            now(),
          )
        : undefined;
    if (
      deps.planApprovalStore
      && entry
      // Raw catalog ops already cross the catalog Gateway's durable approval
      // boundary. Running the generic chat-plan gate too would ask twice and,
      // worse, would ask before qualified-id SOURCE_MISMATCH validation. The
      // raw dispatcher validates the Source first, then owns the one approval.
      && rawOpEntry === null
      && (
        planApprovalModule.requiresPlanApproval(entry)
        // Classification may drift after the uncertain execution. The exact
        // original tool must still stop for a fresh plan; a newly-labelled
        // "read" cannot turn verify-before-retry into an immediate resend.
        || retryTargetsOriginalTool
        || approvedForCurrentDispatch !== undefined
      )
    ) {
      // Codex P3 review P1 fold #2 — bind the gate lookup to the
      // exact dispatch args. Different args (the main-turn re-invokes
      // with a new recipient on the same tool) mint a fresh proposal
      // rather than silently inheriting the prior approval.
      const sameTurn = await deps.planApprovalStore.findLatest(
        session_id,
        turn_id,
        tool_name,
        argsHash,
      );
      if (sameTurn && sameTurn.status === 'cancelled') {
        const result: ChatDispatchResult = {
          ok: false,
          reason: 'plan_cancelled',
          detail: `plan_id=${sameTurn.plan_id}`,
        };
        safeBroadcast(deps.broadcast, {
          kind: 'chat.tool_call_completed',
          session_id,
          turn_id,
          tool_name,
          tier,
          status: 'error',
          reason: result.reason,
          detail: result.detail!,
        });
        return result;
      }
      // A verify-before-retry turn is deliberately ineligible for every
      // previously-approved grant, even an unrelated unconsumed card with the
      // same tool + args. Its first write attempt must stop at a brand-new
      // proposal so "fresh approval required" cannot race an older permission.
      const approved =
        retry_of_plan_id === undefined
          ? approvedForCurrentDispatch
          : undefined;
      if (approved) {
        // Spend the approval AT the dispatch decision — before the
        // dispatch runs, so a failed dispatch consumes it too and
        // the retry re-proposes loudly rather than silently
        // re-running on a stale grant. One approve = one execution.
        const consumedAt = now();
        const consumed = await deps.planApprovalStore.consumeForDispatch(
          approved.plan_id,
          consumedAt,
          turn_id,
        );
        if (
          consumed === undefined
          || consumed.plan_id !== approved.plan_id
          || consumed.consumed_at === undefined
        ) {
          const result: ChatDispatchResult = {
            ok: false,
            reason: 'execution_error',
            detail:
              'The one-time approval could not be confirmed as used; '
              + 'no tool call was started.',
          };
          safeBroadcast(deps.broadcast, {
            kind: 'chat.tool_call_completed',
            session_id,
            turn_id,
            tool_name,
            tier,
            status: 'error',
            reason: result.reason,
            detail: result.detail!,
          });
          return result;
        }
        consumedPlanId = consumed.plan_id;
        void safeLogActivity(
          deps.auditLog,
          'chat_plan_consumed',
          `${session_id}:${turn_id}:${tool_name}`,
          JSON.stringify({
            plan_id: approved.plan_id,
            tier,
            // Cross-turn provenance: approved against THIS turn's
            // proposal or an earlier turn's — the audit row is how
            // an operator traces which card authorized the dispatch.
            approved_turn_id: approved.turn_id,
          }),
        );
        // Fall through to normal dispatch below.
      } else {
        // No consumable approval — pause behind a card. Re-emit the
        // same turn's still-proposed plan for reconnect /
        // multi-client coherence (a late-surfacing client still sees
        // the pending card without re-issuing the rpc); mint a FRESH
        // proposal otherwise — including when the same turn holds a
        // spent (consumed / TTL-expired) approval: that grant is
        // used up, so this dispatch is a new ask, not a re-emit.
        const reEmit =
          sameTurn && sameTurn.status === 'proposed' ? sameTurn : undefined;
        const proposal =
          reEmit ??
          planApprovalModule.buildPlanProposal({
            session_id,
            turn_id,
            ...(retry_of_plan_id !== undefined
              ? { retry_of_plan_id }
              : {}),
            tool: tool_name,
            tier,
            classification:
              retryTargetsOriginalTool
                ? retryOrigin.classification
                : entry.classification,
            args: arg_values,
            mintId,
            now,
          });
        if (!reEmit) {
          await deps.planApprovalStore.put(proposal);
          void safeLogActivity(
            deps.auditLog,
            'chat_plan_proposed',
            `${session_id}:${turn_id}:${tool_name}`,
            JSON.stringify({
              plan_id: proposal.plan_id,
              tier,
              classification: proposal.classification,
              ...(proposal.retry_of_plan_id !== undefined
                ? { retry_of_plan_id: proposal.retry_of_plan_id }
                : {}),
            }),
          );
        }
        safeBroadcast(deps.broadcast, {
          kind: 'chat.plan_proposed',
          session_id,
          turn_id,
          plan_id: proposal.plan_id,
          ...(proposal.retry_of_plan_id !== undefined
            ? { retry_of_plan_id: proposal.retry_of_plan_id }
            : {}),
          tool: tool_name,
          tier,
          args: proposal.args,
          args_hash: proposal.args_hash,
          created_at: proposal.created_at,
        });
        const result: ChatDispatchResult = {
          ok: false,
          reason: 'awaiting_approval',
          detail: `plan_id=${proposal.plan_id}`,
        };
        safeBroadcast(deps.broadcast, {
          kind: 'chat.tool_call_completed',
          session_id,
          turn_id,
          tool_name,
          tier,
          status: 'error',
          reason: result.reason,
          detail: result.detail!,
        });
        return result;
      }
    }

    // D-196 — usage admission owns the last pre-dispatch boundary, after
    // known-tool, contract-carrier, and plan-approval checks. The optional
    // injection is the scope fence: normal chat/messenger and direct MCP never
    // provide it, so they cannot be charged by this hook.
    const llmGatewayUsageCall: LlmGatewayToolUsageCall = {
      session_id,
      turn_id,
      tool_name,
      arg_values,
      picker_target,
    };
    if (llm_gateway_tool_usage !== undefined) {
      let admission: LlmGatewayToolUsageAdmission;
      try {
        admission = await llm_gateway_tool_usage.admit(llmGatewayUsageCall);
      } catch (e) {
        admission = {
          admitted: false,
          result: {
            ok: false,
            reason: 'capacity_gap',
            detail:
              `llm_gateway tool usage admission failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
          },
        };
      }
      if (!admission.admitted) {
        await persistPlanExecution(
          consumedPlanId,
          {
            status: 'failed',
            turn_id,
            reason: admission.result.reason,
            ...(admission.result.detail !== undefined
              ? { detail: admission.result.detail }
              : {}),
          },
        );
        safeBroadcast(deps.broadcast, {
          kind: 'chat.tool_call_completed',
          session_id,
          turn_id,
          tool_name,
          tier,
          status: 'error',
          reason: admission.result.reason,
          ...(admission.result.detail !== undefined
            ? { detail: admission.result.detail }
            : {}),
          ...(consumedPlanId !== undefined ? { plan_id: consumedPlanId } : {}),
        });
        return admission.result;
      }
    }

    const recordLlmGatewayToolUsage = async (): Promise<void> => {
      if (llm_gateway_tool_usage === undefined) return;
      try {
        await llm_gateway_tool_usage.record(llmGatewayUsageCall);
      } catch (e) {
        console.warn(
          `[llm_gateway] seller customer tool_call rollup failed for ${tool_name}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    };
    const releaseLlmGatewayToolUsage = async (): Promise<void> => {
      if (llm_gateway_tool_usage === undefined) return;
      try {
        await llm_gateway_tool_usage.release(llmGatewayUsageCall);
      } catch (e) {
        console.warn(
          `[llm_gateway] seller customer tool_call reservation release failed for ${tool_name}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    };

    // ⛔ D-228 slice 5 — THE PEER-DISPATCH BRANCH IS GONE. It routed a
    // `connection.mcp.<name>` target through `dispatchToolToPeer` with its own
    // `channel: 'mcp_wire'` / `tier: 3` envelope. No such target can arrive any
    // more: `set_picker` refuses one, and the MCP scope-picker that produced them
    // is retired. Every dispatch is now a Self dispatch through the local
    // registry below.

    safeBroadcast(deps.broadcast, {
      kind: 'chat.tool_call_started',
      session_id,
      turn_id,
      tool_name,
      tier,
      args: arg_values,
      ...(consumedPlanId !== undefined ? { plan_id: consumedPlanId } : {}),
    });
    const startedAt = now();
    let result: ChatDispatchResult;
    try {
      result = await runWithExecutionCaseVerificationContext(
        { session_id, turn_id },
        () => rawOpEntry !== null
          ? deps.rawOpDispatch !== undefined
            ? deps.rawOpDispatch(tool_name, arg_values, internalDispatchCtx!)
            : Promise.resolve({
                ok: false as const,
                reason: 'execution_error' as const,
                detail: 'raw op dispatch unavailable',
              })
          : deps.registry.dispatch(
              tool_name,
              arg_values,
              internalDispatchCtx!,
            ),
      );
    } catch (e) {
      await releaseLlmGatewayToolUsage();
      if (consumedPlanId !== undefined) {
        await persistPlanExecution(consumedPlanId, {
          status: 'failed',
          turn_id,
          reason: 'execution_error',
        });
        safeBroadcast(deps.broadcast, {
          kind: 'chat.tool_call_completed',
          session_id,
          turn_id,
          tool_name,
          tier,
          status: 'error',
          reason: 'execution_error',
          plan_id: consumedPlanId,
        });
      }
      throw e;
    }
    const durationMs = now() - startedAt;
    registerVisibleRecallToolResult(turn_state, tool_name, result);
    // Only a SELF dispatch can deep-link into this client's Logs host. Peer
    // results may carry a run id from the remote executor, but that id is not
    // addressable through the local Logs route and is deliberately ignored in
    // `dispatchToolToPeer`.
    const runAddress =
      result.run_id !== undefined ? { run_id: result.run_id } : {};
    if (result.ok) {
      // D-182 — a recipe run that FAILED (not held for approval) reads as an ERROR
      // row in the user's activity, even though the model-facing result stays
      // `ok: true` (the tuned anti-loop posture — the model still gets the full
      // errors[] via `return result` below to narrate). Without this, a failed cli
      // run showed a misleading "used X ✓".
      if (result.run_failed) {
        await persistPlanExecution(consumedPlanId, {
          status: 'failed',
          turn_id,
          reason: 'execution_error',
          detail: result.run_failed.detail,
          ...runAddress,
        });
        safeBroadcast(deps.broadcast, {
          kind: 'chat.tool_call_completed',
          session_id,
          turn_id,
          tool_name,
          tier,
          status: 'error',
          reason: 'execution_error',
          detail: result.run_failed.detail,
          ...runAddress,
          ...(consumedPlanId !== undefined ? { plan_id: consumedPlanId } : {}),
        });
      } else {
        const result_ref = `${session_id}:${turn_id}:${tool_name}`;
        await persistPlanExecution(
          consumedPlanId,
          result.run_held
            ? {
                status: 'held',
                turn_id,
                result_ref,
                hold_kind: result.run_held.kind,
                ...runAddress,
              }
            : {
                status: 'completed',
                turn_id,
                result_ref,
                ...runAddress,
              },
        );
        safeBroadcast(deps.broadcast, {
          kind: 'chat.tool_call_completed',
          session_id,
          turn_id,
          tool_name,
          tier,
          status: 'ok',
          result_ref,
          ...runAddress,
          ...(result.run_held ? { run_held: result.run_held.kind } : {}),
          ...(consumedPlanId !== undefined ? { plan_id: consumedPlanId } : {}),
        });
      }
      await safeLogActivity(
        deps.auditLog,
        'chat_tool_call',
        `${session_id}:${turn_id}:${tool_name}`,
        toolCallDetail({
          channel: 'internal_function_call' satisfies ChatDispatchChannel,
          tier,
          status: result.run_failed ? 'error' : 'ok',
          duration_ms: durationMs,
        }),
      );
      if (result.run_held || result.run_failed) await releaseLlmGatewayToolUsage();
      else await recordLlmGatewayToolUsage();
      return result;
    }
    await persistPlanExecution(consumedPlanId, {
      status: 'failed',
      turn_id,
      reason: result.reason,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
      ...runAddress,
    });
    safeBroadcast(deps.broadcast, {
      kind: 'chat.tool_call_completed',
      session_id,
      turn_id,
      tool_name,
      tier,
      status: 'error',
      reason: result.reason,
      ...(result.detail ? { detail: result.detail } : {}),
      ...runAddress,
      ...(consumedPlanId !== undefined ? { plan_id: consumedPlanId } : {}),
    });
    await safeLogActivity(
      deps.auditLog,
      'chat_tool_call',
      `${session_id}:${turn_id}:${tool_name}`,
      toolCallDetail({
        channel: 'internal_function_call' satisfies ChatDispatchChannel,
        tier,
        status: 'error',
        reason: result.reason,
        duration_ms: durationMs,
      }),
    );
    await releaseLlmGatewayToolUsage();
    return result;
  };

  // D-160 A.8 step 6 — the channel-agnostic turn driver shared by the chat
  // `runTurn` and the messenger `runMessengerTurn` (N.9 inversion-of-control:
  // the framework owns the loop; the channel-specifics are injected). It
  // builds the per-turn shared `state` (seeded with the `catalog` hook's
  // inputs) + the `TurnExecutor` closure that READS the before-turn hooks'
  // decisions off the shared `state` + prompt draft, ENACTs the SI
  // Checkpoint 1 transparency + the PII egress plan, runs `runChatTurn` (the
  // surface-agnostic MECHANICS — per-round AI call + cooperative tool loop +
  // in-turn enforcement), stashes the after-turn inputs, and maps
  // `RunChatTurnResult` → the framework `TurnOutput`. BOTH surfaces run THIS
  // executor over the SAME constructor-built `streamRegistry` (the s5 hooks)
  // via `runStream` — that IS the step-6 reuse — differing only in the
  // injected `Channel` + inbound + finalize.
  //
  // The rich SI-transparency + `runChatTurn` tool-call / multi-turn events
  // route through the injected `emit`, so the messenger surface (whose
  // out-stream is a selective projection that renders neither — N.6) passes a
  // no-op while chat passes its D-121 bus emitter (the webclient renders the
  // live stream). The GENERIC final delta still flows through `ctx.out.token`
  // → the channel sink: chat streams it to the webclient, the messenger
  // channel drops `token` events and delivers only the final `message` via
  // its transport (the framework's post-`update` `out.message`).
  const buildTurnDriver = (params: {
    readonly session_id: string;
    readonly turn_id: string;
    readonly continuation_of_turn_id?: string;
    readonly retry_of_plan_id?: string;
    /** Explanation-only policy enforced again at dispatch. */
    readonly read_only?: boolean;
    readonly picker_target: ChatPickerTarget;
    readonly dispatch_peer_name: string | null;
    /** The turn's REAL channel-minted `ExecutionSource` — chat's
     *  `buildChatExecutionSource` or the messenger inbound's
     *  `(messenger × user_self)` source. Threaded through `runChatTurn`
     *  onto every tool dispatch so the execute-handler's policy gate +
     *  session-grant machinery key the TRUE `(channel × actor)` cell. */
    readonly execution_source: ExecutionSource;
    /** Snapshot paired with a contract-bearing shared-turn source. */
    readonly contract_snapshot?: ContractSnapshot;
    /** Per-request gateway counter. Omitted by normal chat/messenger. */
    readonly llm_gateway_tool_usage?: LlmGatewayToolUsageMeter;
    /** The turn's I-7 hop token (`ChannelInbound.dispatch_depth`) —
     *  rides beside the source through the same dispatch chain (D-160
     *  P3), so a re-entrant messenger fire's tool dispatches carry
     *  their true dispatch-tree depth into the Gateway ceiling. */
    readonly dispatch_depth: number;
    readonly content_parts: readonly ContentPromptPart[];
    /** D-213 — exact source rows already represented in the live prompt. */
    readonly visible_recall_item_ids?: readonly string[];
    readonly model_layer: ChatModelRoutingLayer;
    readonly model_hint?: ChatModelHint;
    /** D-191 Phase 6 — the picked slot key, threaded so the turn pins it. */
    readonly model_source_id?: ChatModelSourceId;
    /** D-193 — the requesting user's IANA timezone (surface-supplied);
     *  threads to `runChatTurn` → the current-time prompt anchor. */
    readonly time_zone?: string;
    readonly emit: (event: BroadcastChatEvent) => void;
  }): {
    streamState: Map<string, unknown>;
    turnExecutor: TurnExecutor;
    getCapturedResult: () => RunChatTurnResult | undefined;
    /** The turn's captured egress packets (aliased, per AI call) — read after
     *  the turn to persist as egress history against the assistant message. */
    getEgressPrompts: () => readonly string[];
    getPlannerRounds: () => number;
    getRetainedCandidates: () => readonly RetainedAliasCandidate[];
  } => {
    const { session_id, turn_id, picker_target, emit } = params;
    const streamState = new Map<string, unknown>();
    if (params.continuation_of_turn_id !== undefined) {
      streamState.set(SPAN_ANCHOR_EXPLICIT_CONTINUATION_STATE_KEY, {
        origin_turn_id: params.continuation_of_turn_id,
      });
    }
    // D-213 — the interaction lane admits on THIS source, not on the dispatch
    // ctx's (which defaults an absent source to the owner). Registered by the
    // two turn surfaces only: chat passes its own, messenger passes its
    // inbound's, and anything that never opened a turn registers nothing.
    registerRecallTurnSource(streamState, params.execution_source);
    registerVisibleInteractionItemIds(
      streamState,
      params.visible_recall_item_ids ?? [],
    );
    // Lever-2 per-slot — resolve the catalog projection ONCE for this turn from
    // the turn's ACTUAL routing (layer + source_id), normalized via
    // `resolveCatalogSource` so the catalog thins the SAME model the executor
    // routes to (a layer override without a matching source pin must not thin
    // the wrong source). The SAME object feeds the catalog build (via the seed
    // below) and the system-prompt `catalog_mode` (below) → presentation +
    // guidance agree; turn-fixed routing → turn-invariant (D-164 prefix-safe).
    const perTurnProjection = resolveTurnProjection(
      resolveCatalogSource(params.model_layer, params.model_source_id),
    );
    // DECIDE inputs → seed `state` for the `catalog` before-turn hook (A.8
    // step 4): it reads the per-turn picker target off the shared `state`,
    // assembles `available_tools` via the bound `buildCatalog`, and writes
    // them back for the executor to ENACT (N.9). Seeded pre-`runStream` so
    // the before-turn `prompt` hook sees it (the framework treats this
    // caller-provided map identically to its default; pre-seeding keys a
    // hook reads is the caller's responsibility — `pipeline.ts` § `state`).
    streamState.set(CHAT_CATALOG_INPUTS_STATE_KEY, {
      picker_target,
      projection: perTurnProjection,
    } satisfies ChatCatalogInputs);
    let capturedTurnResult: RunChatTurnResult | undefined;
    // Egress history (D-167 transparency): the aliased model-bound packets sent
    // this turn, one per AI call, collected by the PII wrapper's sink and
    // persisted against the assistant message after it's appended.
    const egressPrompts: string[] = [];
    let plannerRounds = 0;
    const retainedCandidates = new Map<string, RetainedAliasCandidate>();
    const turnExecutor: TurnExecutor = async (ctx): Promise<TurnOutput> => {
      // ENACT (N.9): read the before-turn hooks' decisions. The
      // `correction-learning` hook contributed its flat "recent
      // corrections — …" summary to the prompt draft (filter to its
      // source so the SI hook's own pre-synthesis prompt contribution
      // never leaks into the turn's correction context — preserving the
      // prior gather, which captured ONLY correction-learning's parts);
      // the `standing-instructions` Checkpoint 1 hook wrote its
      // pre-synthesis result to `state`.
      const correctionContext = ctx.prompt
        .parts()
        .filter(
          (part): part is TextPromptPart =>
            (part.role === 'system' || part.role === 'context')
            && part.source === CORRECTION_LEARNING_MIDDLEWARE_ID,
        )
        .map((part) => part.text);
      const executionCaseContext = readExecutionCaseContext(ctx.state);
      // ⛔ D-219's precedent card is REMOVED from this surface; nothing writes
      // this state any more, so the read is deleted with it rather than left to
      // resolve `undefined` forever. A reader with no writer is the shape that
      // makes a deleted feature look merely dormant.
      // Evidence + what survives: `wire-execution-cases.ts`.
      const content = assembleChatPromptContent([
        ...params.content_parts,
        ...ctx.prompt.parts().filter((part): part is ContentPromptPart => part.role === 'content'),
      ]);
      // ENACT (N.9) the PII egress plan `pii-protect` DECIDED in the before-turn
      // phase. Read it HERE (hoisted ahead of its wire-seam use below) so the
      // prefetch gather can alias its entity payload against the turn's SHARED
      // session ledger — the same ledger the wire seam later uses for tool
      // results + content text, so one contact renders to one alias everywhere.
      // Built from the RAW message; the PII egress aliases `index_context` at the
      // single boundary (it is enumerated in `uniformContentScanDataFields`), so
      // a term the ledger knows renders as the SAME alias here and in
      // `user_message` — the model can still join them, and no raw name ships.
      const indexContext = deps.buildIndexContext
        ? await deps.buildIndexContext(
            content.user_message,
            buildInternalDispatchCtx(
              params.session_id,
              params.turn_id,
              params.execution_source,
              params.contract_snapshot,
              params.dispatch_depth,
            ),
          ).catch(() => undefined)
        : undefined;
      const piiPlan = readPiiEgressPlan(ctx.state);
      // D-167 — collect the prompt-cache before-turn hook's STRUCTURED `entity`
      // parts (raw records + a `render`) but DON'T alias them here. They thread
      // through the executor wrapper into the SINGLE wire seam, where they alias
      // against the turn's shared session ledger alongside everything else — one
      // PII enforcement point, no eager second pass racing the seam over the
      // ledger. The wrapper drops them on an inactive / external-egress plan (it
      // returns the raw executor), so no unrequested raw warehouse PII egresses
      // and their raw records never enter the JSON packet. See `aliasChatAiInput`
      // + D-160.
      const prefetchEntityParts = ctx.prompt
        .parts()
        .filter(
          (part): part is EntityPromptPart =>
            part.role === 'entity'
            && part.source === PROMPT_CACHE_MIDDLEWARE_ID,
        );
      // ENACT (N.9): the `catalog` before-turn hook DECIDED `available_tools`
      // off the seeded picker target. Fall back to an empty list defensively
      // — in practice the hook always runs (always wired + seeded), so this
      // equals the former inline `availableTools`.
      const catalogTools =
        (ctx.state.get(CHAT_CATALOG_RESULT_STATE_KEY) as
          | ReadonlyArray<ChatMainTurnTool>
          | undefined) ?? [];
      // Diagnosis turns present only explicitly-read tools. The dispatch
      // boundary below remains the authority; this narrower prompt catalog
      // prevents the model from wasting a round attempting a blocked action.
      let readOnlyToolNames: ReadonlySet<string> | null = null;
      if (params.read_only === true) {
        // ⛔ D-228 slice 5 — always the local registry; the peer catalog arm
        // went with the scope-picker.
        readOnlyToolNames = new Set(
          deps.registry.list()
            .filter((entry) => entry.classification === 'read')
            .map((entry) => entry.name),
        );
      }
      const directOwnerRecallSurface =
        params.execution_source.channel === 'chat'
        && params.execution_source.actor === 'user_self'
        && !executionSourceHasContract(params.execution_source);
      const surfaceCatalogTools = directOwnerRecallSurface
        ? catalogTools
        : catalogTools.filter(
            (tool) => tool.recipe_slug !== RECALL_SEARCH_TOOL_NAME,
          );
      const availableTools =
        readOnlyToolNames === null
          ? surfaceCatalogTools
          : surfaceCatalogTools.filter(
              (tool) => readOnlyToolNames.has(tool.recipe_slug),
            );

      // ENACT (N.9) the PII egress plan (read above): wrap `executeAiCall` so
      // every outbound packet is aliased (incl. the tool loop's per-reinvoke
      // `prior_tool_calls`, which carry fresh warehouse PII) and every returned
      // body restored before `runChatTurn` sees it — only the cloud LLM sees
      // aliases. An absent plan (PII unwired) or an inactive plan (external-
      // egress surface) leaves the raw executor untouched (behavior-preserving).
      // D-191 — aliasing is the sole PII protection; the wrap is aliasing-only
      // (no cloud-egress posture / force-local injection).
      const trackedExecuteAiCall: ExecuteChatAiCall | undefined =
        deps.executeAiCall === undefined
          ? undefined
          : async (manifest, aiInput) => {
              plannerRounds += 1;
              // This is the transport-adjacent event: only advisory ids queued
              // by augmentation or critique for this exact next packet become
              // exposed. It is independent of whether PII capture is active.
              deps.getExecutionCaseLifecycle?.()?.markPlannerEgress(
                streamState,
                now(),
              );
              return deps.executeAiCall!(manifest, aiInput);
            };
      const executeAiCallForTurn =
        trackedExecuteAiCall !== undefined && piiPlan !== undefined
          ? wrapExecuteAiCallForPii(
              trackedExecuteAiCall,
              piiPlan,
              (p) => {
                egressPrompts.push(p);
              },
              prefetchEntityParts,
              undefined,
              (candidates) => {
                for (const candidate of candidates) {
                  retainedCandidates.set(
                    `${candidate.kind}\u0000${candidate.value}`,
                    candidate,
                  );
                }
              },
            )
          : trackedExecuteAiCall;

      // The OWNER surfaces (chat + messenger — `buildTurnDriver`'s only two
      // callers) resolve the `chat` prompt. Absent dep → the built-in default.
      // The gateway does NOT come through here; it resolves its own surface in
      // `runLlmGatewayTurn`, so an owner's chat persona can never reach an
      // external caller.
      const chatSystemPrompt = deps.resolveSystemPrompt?.('chat');

      const result = await runChatTurn(
        {
          session_id,
          turn_id,
          ...(params.retry_of_plan_id !== undefined
            ? { retry_of_plan_id: params.retry_of_plan_id }
            : {}),
          picker_target,
          dispatch_peer_name: params.dispatch_peer_name,
          execution_source: params.execution_source,
          ...(chatSystemPrompt !== undefined
            ? {
                system_prompt: chatSystemPrompt.prompt,
                system_role: chatSystemPrompt.role,
              }
            : {}),
          ...(params.contract_snapshot !== undefined
            ? { contract_snapshot: params.contract_snapshot }
            : {}),
          ...(params.llm_gateway_tool_usage !== undefined
            ? { llm_gateway_tool_usage: params.llm_gateway_tool_usage }
            : {}),
          dispatch_depth: params.dispatch_depth,
          available_tools: availableTools,
          content,
          correction_context: correctionContext,
          ...(indexContext ? { index_context: indexContext } : {}),
          ...(executionCaseContext
            ? { execution_case_context: executionCaseContext }
            : {}),

          // Lever-2 per-slot — the PER-TURN catalog delivery mode (resolved
          // from the turn's source) drives the system-prompt guidance. Same
          // `perTurnProjection` object that fed the catalog build → presentation
          // + guidance agree by construction. Thinning modes append their own
          // guidance; full leaves the baseline prompt byte-identical.
          catalog_mode: perTurnProjection.mode,
          model_layer: params.model_layer,
          ...(params.model_hint ? { model_hint: params.model_hint } : {}),
          ...(params.model_source_id
            ? { model_source_id: params.model_source_id }
            : {}),
          ...(params.time_zone ? { time_zone: params.time_zone } : {}),
        },
        {
          ...(executeAiCallForTurn ? { executeAiCall: executeAiCallForTurn } : {}),
          registry: deps.registry,
          dispatchTool: (call) =>
            dispatchTool({
              ...call,
              ...(params.read_only === true ? { read_only: true } : {}),
              turn_state: streamState,
            }),
          ...(deps.getExecutionCaseProposalCritic
            ? {
                critiqueProposal: (calls) =>
                  deps.getExecutionCaseProposalCritic?.()?.critique({
                    session_id,
                    turn_id,
                    prompt: content.user_message,
                    calls,
                    state: streamState,
                    source: params.execution_source,
                  }) ?? Promise.resolve(null),
              }
            : {}),
          emit,
          now,
        },
      );
      capturedTurnResult = result;

      // DECIDE → write `state`: stash the after-turn inputs the `update`
      // hooks consume — but ONLY when the turn produced an `AIOutput`. The
      // stash's PRESENCE is the gate the SI Checkpoint 2 + personal-recipes
      // adapters read; absent it (the conflict-halt / no-executor /
      // provider-failure paths) neither after-turn hook reads its store —
      // exactly the prior in-`else`-only after-turn placement.
      if (result.final_ai_output !== undefined) {
        ctx.state.set(CHAT_TURN_AFTER_INPUTS_STATE_KEY, {
          events: result.final_ai_output.events,
          tool_call_kinds: result.tool_calls?.map((tc) => tc.tool_name) ?? [],
        } satisfies ChatTurnAfterInputs);
      }

      // The GENERIC final delta moves to the framework path: produce it
      // via `ctx.out.token` (out-stream → channel sink → the single
      // `chat.token_streamed`). Gate it exactly as the prior in-function
      // emit was — only on a successful AI turn (`final_ai_output`
      // present) with non-empty content; the conflict / no-executor /
      // provider-failure paths emit no delta. `tool_calls` is NOT mapped
      // onto `TurnOutput.tool_calls` — the framework projects that into
      // channel-note transparency the chat turn does not emit; the rich
      // `chat.tool_call_*` events already emit directly above.
      // D-167 P5 S4 — `result.assistant_content` is already PII-restored: the
      // wrapped `executeAiCall` restores every returned body (response + args
      // + events) before `runChatTurn` assembles it, so this streamed delta —
      // like the persisted + broadcast message — carries real values. The
      // wrap seam is the single primary restore across all surfaces;
      // `pii-restore` re-verifies the durable text as the final backstop.
      if (result.final_ai_output !== undefined && result.assistant_content.length > 0) {
        await ctx.out.token(ctx.turn_id, result.assistant_content);
      }
      return {
        text: result.assistant_content,
        ...(result.usage !== undefined ? { tokens: result.usage.total_tokens } : {}),
      };
    };
    return {
      streamState,
      turnExecutor,
      getCapturedResult: () => capturedTurnResult,
      getEgressPrompts: () => egressPrompts,
      getPlannerRounds: () => plannerRounds,
      getRetainedCandidates: () => [...retainedCandidates.values()],
    };
  };

  const runTurn = async (input: ChatTurnInput): Promise<ChatTurnAck> => {
    const session = deps.chatStore.getSession(input.session_id);
    if (!session) {
      throw new Error(
        `chat-orchestrator: session ${input.session_id} not found (create a session first via chat.session.create)`,
      );
    }
    const turn_id = mintId();
    const executionSource = buildChatExecutionSource(input.session_id, turn_id);
    const picker_target = input.picker_state.current as ChatPickerTarget;
    const pickerAtSend = buildPickerAtSend(picker_target);
    const modelLayer = resolveModelPref(session, input.model_pref);
    const modelHint = resolveModelHint(session, input.model_pref);
    const modelSourceId = resolveModelSourceId(session, input.model_pref);
    const modelUsed = {
      provider:
        session.model_routing.provider
        ?? modelLayer,
      model_id: session.model_routing.model_id ?? 'unknown',
    };

    // 1a) Build the chat tail FIRST — the prompt content parts carry the
    //     prior conversation as `chat_tail` AND the current turn as
    //     `user_message`. If we appended the user row before reading the tail,
    //     the AI would see the current message twice (once as tail-last + once
    //     as user_message). Codex P1.4 review P2 fold — read tail before append.
    const builtChatTail = await buildChatTail(
      deps.chatStore,
      input.session_id,
      deps.resolveFileNames,
    );

    // 1b) Persist the user turn immediately so reconnect-replay sees
    //     it even if the orchestrator crashes mid-turn.
    const userMessageId = mintId();
    /** Held so a reply written in the SAME millisecond can order itself
     *  strictly after this row — see the wordless-drop short-circuit below. */
    const userTs = now();
    await deps.chatStore.appendMessage({
      id: userMessageId,
      session_id: input.session_id,
      role: 'user',
      content: input.message,
      target_server: picker_target,
      picker_at_send: pickerAtSend,
      model_used: modelUsed,
      execution_source: executionSource,
      ts: userTs,
      ...(input.data_diagnosis
        ? { data_diagnosis: input.data_diagnosis }
        : {}),
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: [...input.attachments] }
        : {}),
    });
    void safeLogActivity(
      deps.auditLog,
      'chat_message_sent',
      `${input.session_id}:${userMessageId}`,
      JSON.stringify({
        role: 'user',
        target_server: picker_target,
        model_used: modelUsed,
        tool_call_count: 0,
      }),
    );
    // D-177 5.d/5.f — feed the forwarded-sender index from the just-
    // persisted USER turn (chat channel only). Best-effort: a candidate
    // that fails to record only means a scoped grant degrades to asking.
    try {
      deps.forwardedSenderIndex?.recordUserTurn(
        input.session_id,
        input.message,
        now(),
      );
    } catch {
      /* degrade toward asking — never fail the committed turn */
    }

    // 1c) COMMIT POINT — the user message is durable; everything that
    //     rejects for caller reasons already threw above. Fire the
    //     ack-before-run seam so the rpc layer can resolve `chat.send`
    //     now; the model-bound body below streams its outcome over the
    //     broadcast bus (`message_complete` on success, the
    //     `engine.turn_failed` failure event from the rpc layer's
    //     completion watcher on a shell throw). A throwing callback
    //     must not kill the committed turn.
    try {
      input.on_accepted?.({ turn_id });
    } catch {
      /* observability-only seam — never fail the committed turn */
    }

    // D-172 P2 — a WORDLESS FILE DROP, mirroring the messenger short-circuit.
    //
    // ⛔ ZERO AI CALLS. A file arriving is not a question, so running a turn
    // would spend a provider call guessing an intent nobody has stated. Store
    // it, SAY SO, and ask. The person's next message carries the intent, and by
    // then the file is in the session — the user row above was appended WITH
    // its attachments, so the following turn's tail names it automatically and
    // the model gets `{file_refs, user_prompt}` on ONE call.
    //
    // ⚠ The reply is a real assistant ROW, not a transient banner: the webclient
    // renders the thread from stored messages, so a banner would vanish on the
    // next repaint and the person would be left with a file and no trace of
    // having been asked anything.
    if (
      input.message.trim().length === 0
      && input.attachments !== undefined
      && input.attachments.length > 0
    ) {
      const names = deps.resolveFileNames?.(
        input.attachments.map((a) => a.file_id),
      ) ?? new Map<string, string>();
      await deps.chatStore.appendMessage({
        id: mintId(),
        session_id: input.session_id,
        role: 'assistant',
        content: wordlessDropAffordance(input.attachments, names),
        target_server: picker_target,
        picker_at_send: pickerAtSend,
        model_used: modelUsed,
        execution_source: executionSource,
        // ⛔ NOT `now()`. This short-circuit spends no provider call, so the ack
        // lands in the SAME millisecond as the user row it answers — and the
        // read is `ORDER BY ts ASC, message_id ASC` over a randomUUID id, so a
        // tie is a COIN FLIP. Half of all wordless drops rendered the answer
        // ABOVE the question. Strictly-after keeps `ts` genuinely ordered, so
        // the display query AND the (ts, message_id) recall cursor both stay
        // right — fixing it in the ORDER BY would have had to break that cursor.
        ts: Math.max(now(), userTs + 1),
      });
      return { turn_id };
    }

    // 2) The AI-facing catalog (the post-capability-filter Tier 1/2/3
    //    union → `available_tools`) is now assembled by the `catalog`
    //    before-turn HOOK (A.8 step 4), not inline here: the shell seeds
    //    the per-turn picker target onto the shared `state` (below), the
    //    hook DECIDES `available_tools` via the bound `buildCatalog`
    //    projection + writes it back, and the executor ENACTs it off
    //    `state` (N.9).
    //
    // ⛔ D-228 slice 5 — `dispatch_peer_name` is now ALWAYS null: peer scoping
    // is retired and `set_picker` refuses a peer target. Threaded rather than
    // removed because it is part of `runChatTurn`'s input shape, which several
    // callers construct.
    const dispatchPeerName = null;

    // 3) Run the turn THROUGH the framework `runStream` loop (Stage 3).
    //    The turn CONCERNS are now registered hooks over the shared
    //    `state`: the before-turn `prompt` hooks (`standing-instructions`
    //    Checkpoint 1 + `correction-learning`) run BEFORE this executor,
    //    DECIDING and writing `state` / contributing to the prompt draft;
    //    the after-turn `update` hooks (`standing-instructions`
    //    Checkpoint 2 + `personal-recipes`) run AFTER it. The MECHANICS
    //    (per-round AI call + cooperative tool loop + in-turn enforcement
    //    — SI tier-bounds clamp, conflict-halt short-circuit, tag_response
    //    append — + the RICH tool-call / multi-turn transparency emits)
    //    stay in `runChatTurn`, adapted onto a `TurnExecutor` closure that
    //    READS the before-turn hooks' decisions off the shared `state` +
    //    prompt draft, ENACTs the SI Checkpoint 1 transparency, and maps
    //    `RunChatTurnResult` → `TurnOutput`. The packet shape stays owned
    //    inline (inside `runChatTurn`); the rich events emit directly onto
    //    the D-121 bus via the injected null-safe `emit`. The shell passes
    //    its own per-turn `streamState` so it can ENACT the after-turn
    //    hooks' decisions on finalize (below).
    // Build the channel-agnostic turn driver (the shared executor core +
    // per-turn `state`). Chat passes its D-121 bus emitter so the rich
    // SI-transparency + tool-call events stream to the webclient; the SAME
    // driver backs `runMessengerTurn` over the SAME `streamRegistry`.
    let userSourceClosed = false;
    const failPendingUserSource = (): void => {
      if (userSourceClosed) return;
      userSourceClosed = true;
      try {
        deps.chatStore.failMessageSource?.(input.session_id, userMessageId);
      } catch {
        // Preserve the originating turn failure. The store relinquishes its
        // process-local claim in a finally block so a later harvest can retry
        // reconciliation if the durable transition itself failed.
      }
    };
    let turnDriver: ReturnType<typeof buildTurnDriver>;
    try {
      turnDriver = buildTurnDriver({
        session_id: input.session_id,
        turn_id,
        ...(input.continuation_of_turn_id !== undefined
          ? { continuation_of_turn_id: input.continuation_of_turn_id }
          : {}),
        ...(input.retry_of_plan_id !== undefined
          ? { retry_of_plan_id: input.retry_of_plan_id }
          : {}),
        ...(input.data_diagnosis !== undefined ? { read_only: true } : {}),
        picker_target,
        dispatch_peer_name: dispatchPeerName,
        // The same chat source the stream's inbound carries (below) — the
        // turn's dispatches and its policy-consulting hooks see one identity.
        execution_source: executionSource,
        // A webclient HID turn is a genuine top-level user action (the chat
        // channel has no egress→ingress re-trigger path) — depth 0, matching
        // the stream inbound below.
        dispatch_depth: 0,
        content_parts: buildChatContentPromptParts({
          // D-172 P2 — same reason as the messenger path: the tail is built
          // BEFORE this message is appended, so a file attached to THIS turn
          // is not in it. Without this the marker would fire one turn late.
          user_message: input.attachments && input.attachments.length > 0
            ? `${input.message}${renderAttachmentMarker(
              input.attachments,
              deps.resolveFileNames?.(input.attachments.map((a) => a.file_id))
                ?? new Map<string, string>(),
            )}`
            : input.message,
          chat_tail: builtChatTail.messages,
        }),
        visible_recall_item_ids: [
          ...builtChatTail.item_ids,
          userMessageId,
        ],
        model_layer: modelLayer,
        ...(modelHint ? { model_hint: modelHint } : {}),
        ...(modelSourceId ? { model_source_id: modelSourceId } : {}),
        ...(input.time_zone ? { time_zone: input.time_zone } : {}),
        emit: (event) => safeBroadcast(deps.broadcast, event),
      });
    } catch (error) {
      failPendingUserSource();
      throw error;
    }
    const {
      streamState,
      turnExecutor,
      getCapturedResult,
      getEgressPrompts,
      getPlannerRounds,
      getRetainedCandidates,
    } = turnDriver;
    const finalizeUserSource = async (
      ctx: TurnContext,
      outcome: 'complete' | 'prompt_error',
    ): Promise<void> => {
      if (userSourceClosed) return;
      if (outcome === 'prompt_error') {
        failPendingUserSource();
        return;
      }
      userSourceClosed = true;
      try {
        const entityParts = ctx.prompt.parts().filter(
          (part): part is EntityPromptPart => part.role === 'entity',
        );
        const candidates = projectEntityPromptPartCandidates(
          entityParts,
          deps.fieldPrivacyResolver ?? piiEgress.noopFieldPrivacyResolver,
        );
        if (deps.chatStore.finalizeMessageSource === undefined) {
          throw new Error('source finalizer is not wired');
        }
        const finalized = await deps.chatStore.finalizeMessageSource({
          session_id: input.session_id,
          message_id: userMessageId,
          candidates,
        });
        if (!finalized) {
          throw new Error('pending source row was not finalizable');
        }
      } catch (error) {
        try {
          deps.chatStore.failMessageSource?.(input.session_id, userMessageId);
        } catch {
          // The content row is already durable. A later startup/first-harvest
          // reconciliation closes any still-pending source honestly.
        }
        console.error('[chat-orchestrator] D-213 source finalization failed', {
          session_id: input.session_id,
          message_id: userMessageId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    };

    // The channel records the triggering user message before the stream;
    // the shell already persisted it durably to the ChatStore (1b), and
    // `preload` here warms the cache-only session store so `runStream`'s
    // history read is consistent within the session.
    //
    // BEST-EFFORT: this preload MUST NOT fail the turn. The user row is
    // already committed (1b), so a throw here would strand it with no
    // assistant completion (and a retry would duplicate the user turn).
    // Most source-binding hooks read per-pair STORES + the shared `state`,
    // not the framework `history`, and the closure uses the shell's
    // already-gathered content parts — so the warm is inert for them. The ONE
    // history reader is the D-164 entity prefetch (`createPromptCacheSource` →
    // `contributePrefetch`); for it the warm matters, and the degrade-to-EMPTY
    // guarantee below keeps a FAILED warm a no-op (not a stale prior-turn read)
    // — `createChatStoreSessionStateStore` clears the session cache on a failed
    // `listMessages`. A locked vault at turn start was
    // already surfaced by `buildChatTail` BEFORE the user append (it
    // rethrows `ChatVaultLockedError`); the turn's real vault dependency
    // is the assistant append below, unchanged from the pre-flip path. On
    // any read failure, degrade to an unwarmed (empty) cache — exactly
    // what `runStream` would read without a preload at all.
    try {
      await streamSessionStore.preload(input.session_id);
    } catch {
      // Degrade to an unwarmed cache; never strand the committed turn.
    }
    const inbound: ChannelInbound = {
      session_id: input.session_id,
      surface: 'chat',
      text: input.message,
      from: LOCAL_CHAT_USER_ID,
      source: executionSource,
      // A webclient HID turn is a genuine top-level user action — the
      // chat channel has no egress→ingress re-trigger path (D-160 P3).
      dispatch_depth: 0,
      ts: now(),
    };
    let streamSummary;
    try {
      streamSummary = await runStream({
        registry: streamRegistry,
        channel: streamChannel,
        sessionStore: streamSessionStore,
        inbound,
        runTurn: turnExecutor,
        capacity: chatCapacity(),
        // The shell's own per-turn scratch — the registered hooks DECIDE
        // into it (the SI Checkpoint 1/2 results, the personal-recipe
        // matches), the executor reads the before-turn decisions out of it,
        // and the shell ENACTs the after-turn decisions off it on finalize
        // (below). Per-turn (never constructor-captured) so concurrent
        // turns never share scratch.
        state: streamState,
        validatePromptPart: createRetainablePromptPartValidator(),
        finalizePrompt: finalizeUserSource,
        // Pin the framework turn id to the shell's pre-minted id so every
        // event a turn emits — the rich direct emits AND the framework
        // out-stream delta — shares one `turn_id`.
        mintId: () => turn_id,
      });
    } catch (error) {
      failPendingUserSource();
      throw error;
    }

    // D-164 — the prompt-cache before-turn gate may resolve the turn
    // deterministically via `ctx.resolve` (the deterministic short-circuit),
    // skipping the LLM. On that path the executor never ran, so there is no
    // captured result; the framework surfaces the resolved answer as
    // `streamSummary.final_text`. On every normal turn `getCapturedResult()`
    // is defined and this is behaviour-preserving.
    const capturedResult = getCapturedResult();
    deps.getExecutionCaseLifecycle?.()?.recordPlannerRounds({
      session_id: input.session_id,
      turn_id,
      rounds: getPlannerRounds(),
    });
    const turnResult = capturedResult ?? { assistant_content: '' };
    // D-167 P5 S4 — prefer `pii-restore`'s verified-restored assistant text
    // for the durable + broadcast message (the zero-failure total-restore
    // guarantee enacted on the persisted surface). The wire seam already
    // restored the returned body, so this equals the turn's content on the
    // happy path; it falls back to the turn's own content when PII is unwired
    // / inactive (no `pii-restore` ran). On a gate short-circuit (no captured
    // result) the resolved `final_text` is the answer — no provider egress
    // ran, so it is the owner's own warehouse data going straight to the owner.
    const assistantContent =
      readPiiRestoredText(streamState)
      ?? (capturedResult === undefined ? streamSummary.final_text : undefined)
      ?? turnResult.assistant_content;
    const assistantToolCalls = turnResult.tool_calls;
    const assistantProvenance = turnResult.provenance;
    const totalUsage = turnResult.usage;
    // D-167 P5 S4 — the per-turn redaction summary the wire seam accumulated
    // across the tool loop's egress packets; stamped on the assistant audit
    // row below (omitted when nothing was redacted — the comfort / noop path).
    const piiRedactionSummary = readPiiRedactionSummary(
      readPiiEgressPlan(streamState),
    );

    // 4) ENACT the registered hooks' after-turn decisions (N.9): the
    //    `update` hooks wrote their results to the shared `streamState`
    //    during `runStream`; read them here to surface them. Each result
    //    is present iff its hook ran — which (via the after-turn-stash
    //    gate the executor wrote) is iff the turn produced an `AIOutput`
    //    AND its source + registry were wired + enabled — so the prior
    //    "after-turn gathers run iff `final_ai_output`, each a no-op
    //    without its registry / store" gating is preserved by construction.
    //
    // `personal-recipes` matches over the turn's `AIOutput.events[]`.
    // Surfaced on the assistant audit row below; firing them is a deferred
    // follow-on (no chat → recipe.invoke seam yet, and chat events rarely
    // carry `subject_contact_id` until contact-resolution is wired). `[]`
    // when the hook did not run / matched nothing.
    const personalRecipeMatches: readonly PersonalRecipeMatch[] =
      (streamState.get(PERSONAL_RECIPES_MATCHES_STATE_KEY) as
        | DispatchPersonalRecipesResult
        | undefined)?.matches ?? [];

    // D-137 Trio #E follow-on — emit the per-turn token aggregate as
    // a transparency event after the body / loop has resolved.
    // Summary-only redaction by default; the audit row carries the
    // same structured payload for the benchmark + future billing
    // surface. Emitted only when at least one provider call produced
    // usage (no event on no-adapter turns or pure-fallback paths).
    if (totalUsage !== undefined) {
      safeBroadcast(deps.broadcast, {
        kind: 'chat.transparency',
        session_id: input.session_id,
        turn_id,
        event: {
          kind: 'recued.token_usage',
          input_tokens: totalUsage.input_tokens,
          output_tokens: totalUsage.output_tokens,
          total_tokens: totalUsage.total_tokens,
          // ⚠ The count is what makes the totals READABLE. A consumer plotting
          // input_tokens per turn cannot otherwise tell a growing packet from a
          // turn that called the provider twice.
          ...(totalUsage.provider_calls !== undefined
            ? { provider_calls: totalUsage.provider_calls }
            : {}),
          ...(totalUsage.cache_read_input_tokens !== undefined
            ? { cache_read_input_tokens: totalUsage.cache_read_input_tokens }
            : {}),
          ...(totalUsage.cache_write_input_tokens !== undefined
            ? { cache_write_input_tokens: totalUsage.cache_write_input_tokens }
            : {}),
          ...(totalUsage.reasoning_tokens !== undefined
            ? { reasoning_tokens: totalUsage.reasoning_tokens }
            : {}),
        },
      });
    }

    const assistantMessageId = mintId();
    const assistantMessage = await deps.chatStore.appendMessage({
      id: assistantMessageId,
      session_id: input.session_id,
      role: 'assistant',
      content: assistantContent,
      target_server: picker_target,
      picker_at_send: pickerAtSend,
      model_used: modelUsed,
      execution_source: executionSource,
      ts: now(),
      ...(assistantToolCalls ? { tool_calls: assistantToolCalls } : {}),
      retained_alias_candidates: getRetainedCandidates(),
      ...(assistantProvenance ? { provenance: assistantProvenance } : {}),
      ...(input.data_diagnosis
        ? { data_diagnosis: input.data_diagnosis }
        : {}),
    });
    // Anchor any plan proposed by this turn to the durable assistant row before
    // broadcasting completion. Recovery may fail to link, but it must never
    // fail an otherwise-committed assistant message.
    if (deps.planApprovalStore?.linkTurnToMessage !== undefined) {
      try {
        await deps.planApprovalStore.linkTurnToMessage(
          input.session_id,
          turn_id,
          assistantMessageId,
        );
      } catch (error) {
        console.error(
          `[chat] approval card message linkage failed for ${input.session_id}:${turn_id}`,
          error,
        );
      }
    }
    // Persist this turn's egress history (the aliased packets the PII wrapper
    // captured) against the assistant message. Best-effort: the message is
    // already durable, so a capture-store failure must never fail the turn.
    const egressPrompts = getEgressPrompts();
    if (egressPrompts.length > 0) {
      try {
        await deps.chatStore.appendEgress(
          input.session_id,
          assistantMessageId,
          egressPrompts.map((prompt, call_index) => ({
            call_index,
            prompt,
            model_id: modelUsed.model_id,
            ts: now(),
          })),
        );
      } catch (err) {
        console.error('[chat] egress-history capture failed', err);
      }
    }
    void safeLogActivity(
      deps.auditLog,
      'chat_message_sent',
      `${input.session_id}:${assistantMessageId}`,
      JSON.stringify({
        role: 'assistant',
        target_server: picker_target,
        model_used: modelUsed,
        tool_call_count: assistantToolCalls?.length ?? 0,
        provenance_count: assistantProvenance?.length ?? 0,
        // D-137 Trio #E follow-on — durable per-turn token usage. The
        // benchmark + future billing surface read this row to compute
        // per-turn cost (tokens × rates at report time). Counts only;
        // never user content; safe to persist on every assistant
        // message. Omitted when the turn produced no AI usage report.
        ...(totalUsage !== undefined ? { total_usage: totalUsage } : {}),
        // D-160 O-5 (light slice) — personal recipes this turn's
        // extraction events matched. Surfaces the match on the durable
        // audit row (D-120 Memory reads it); firing is a deferred
        // follow-on. Substrate-stable ids only (recipe_id / contact_id /
        // verbatim topic) — no raw user content. Omitted when none matched.
        ...(personalRecipeMatches.length > 0
          ? {
              personal_recipe_matches: personalRecipeMatches.map((m) => ({
                recipe_id: m.recipe_id,
                contact_id: m.contact_id,
                topic: m.topic,
              })),
            }
          : {}),
        // D-167 P5 S4 — per-turn PII redaction summary (count by kind across
        // the turn's egress packets). The ledger itself never reaches audit —
        // only this count summary does (spec §"Gateway"). Omitted when
        // nothing was redacted (comfort / noop-resolver path).
        ...(piiRedactionSummary !== undefined
          ? { redaction_summary: piiRedactionSummary }
          : {}),
      }),
    );

    safeBroadcast(deps.broadcast, {
      kind: 'chat.message_complete',
      session_id: input.session_id,
      turn_id,
      final: assistantMessage,
    });

    return {
      turn_id,
      ...(totalUsage !== undefined ? { total_usage: totalUsage } : {}),
    };
  };

  // D-160 A.8 step 6 (N.9) — run one `messenger` turn over the SAME
  // `streamRegistry` (the s5 hooks) + the SAME `runChatTurn` mechanics as
  // chat, via the framework `runStream` loop with the caller-injected
  // messenger `Channel`. This IS the step-6 "reuse": the channel-specifics
  // (Channel + inbound + finalize) are injected; the turn concerns + the
  // mechanics are shared. The messenger surface renders a selective
  // projection (N.6) — only the final assistant `message`, delivered over
  // its transport by the framework's post-`update` `out.message`; token
  // deltas + transparency notes are dropped by the messenger channel.
  //
  // Slim finalize (user-confirmed seam scope): the framework + the messenger
  // channel own delivery (transport.send) + session-store recording; there is
  // NO chat rich finalize. The s5 hooks run unchanged over the same registry,
  // so their after-turn results simply are not surfaced here (the slim cut).
  //
  // Two boundaries the same-registry reuse inherits, documented honestly
  // (Codex review folds — neither is a regression this slice introduces):
  //  · PII: the always-on `pii-protect` / `pii-restore` bookends EXECUTE on a
  //    messenger turn but DECIDE inactive — D-163 `owns_llm_egress` classifies
  //    a `messenger-*` surface as external-egress (`shouldAliasForEgress` →
  //    false; `packages/gateway/.../egress-aliasing.ts`), so the turn passes
  //    real values to the LLM, the documented external-egress behavior (same
  //    as a raw MCP data-tool). A messenger turn is therefore NOT PII-aliased
  //    today. The one thing the prefetch wiring must respect: the SPECULATIVE
  //    entity prefetch (`createPromptCacheSource`) is gated OFF on an inactive
  //    plan (it renders only when `plan.active`), so a messenger turn never adds
  //    UNREQUESTED warehouse PII to the external-egress packet — only the user's
  //    own explicit content + tool results flow raw, as designed.
  //    The D-160 messenger channel DOES restore + deliver via Recued's
  //    own transport, so whether to flip `owns_llm_egress` true for it (alias
  //    the LLM yet still restore on delivery) is a deliberate D-163/D-167
  //    follow-on — NOT decided in this chat-files lane (the gate lives in
  //    `packages/gateway/`). No real PII leaks meanwhile: no live messenger
  //    transport is wired (the deferred downstream consumer).
  //  · Dispatch: tool / recipe dispatch reuses chat's `dispatchTool` — and
  //    (the D-160 P3 thread-through, landed with the messenger
  //    execution-source threading slice) carries the turn's REAL identity:
  //    the channel-minted `(messenger × user_self)` inbound source + the
  //    I-7 `dispatch_depth` hop token ride `buildTurnDriver` →
  //    `runChatTurn` → `dispatchTool` → `buildInternalDispatchCtx`, so a
  //    tool dispatched FROM a messenger turn is policy-evaluated on the
  //    MESSENGER cell (execute-handler `POLICY_GATED_USER_CHANNELS`),
  //    session-granted per `messenger:<vendor>:<from>` thread, and
  //    depth-bounded by the Gateway ceiling on re-entrant fires.
  //
  // Durable ChatStore persistence of messenger turns + the webclient "second
  // window" `chat.message_complete` (the full "one conversation, two windows"
  // UX) are likewise DEFERRED to the downstream transport wiring; this slice
  // proves the reuse.
  const runMessengerTurn = async (
    input: MessengerTurnInput,
  ): Promise<ChatTurnAck> => {
    const { inbound } = input;
    const session_id = inbound.session_id;
    const turn_id = mintId();
    // A messenger turn is always a Self turn — the user is messaging their
    // own server over an external app; there is no peer-server picker. The
    // catalog hook builds the Self Tier 1/2/3 union.
    const picker_target: ChatPickerTarget = 'self';
    // Model routing rides the SHARED chat session when one exists (one
    // conversation, two windows); a conversation only ever touched over
    // messenger has no chat session, so default to `local`
    // (`resolveModelPref(null)`) and NEVER throw — unlike chat's `runTurn`, a
    // messenger turn must not require a pre-created session.
    const session = deps.chatStore.getSession(session_id);
    const modelLayer = resolveModelPref(session, input.model_pref);
    const modelHint = resolveModelHint(session, input.model_pref);
    const modelSourceId = resolveModelSourceId(session, input.model_pref);
    const modelUsed = {
      provider:
        session?.model_routing.provider
        ?? modelLayer,
      model_id: session?.model_routing.model_id ?? 'unknown',
    };

    // One conversation: the turn reasons over the SAME durable tail chat
    // reads. Build the tail before appending the current messenger row so
    // the current user message does not appear twice in the AI packet.
    const builtChatTail = await buildChatTail(
      deps.chatStore,
      session_id,
      deps.resolveFileNames,
    );
    const pickerAtSend = buildPickerAtSend(picker_target);
    if (!session) {
      deps.chatStore.createSession({
        id: session_id,
        now: inbound.ts,
        picker_state: { current: picker_target },
      });
    }
    const userAttachments = inbound.media;
    let userText = inbound.text;
    let effectiveInbound = inbound;
    let voiceTranscribed = false;
    if (userText.trim().length === 0 && userAttachments && isVoiceOnlyMedia(userAttachments)) {
      const transcript = await transcribeMessengerVoiceOnly(
        deps.messengerVoiceTranscription,
        userAttachments,
      );
      if (transcript !== null) {
        userText = transcript;
        effectiveInbound = { ...inbound, text: transcript };
        voiceTranscribed = true;
      }
    }

    const userMessageId = mintId();
    await deps.chatStore.appendMessage({
      id: userMessageId,
      session_id,
      role: 'user',
      content: userText,
      target_server: picker_target,
      picker_at_send: pickerAtSend,
      model_used: modelUsed,
      execution_source: inbound.source,
      ts: inbound.ts,
      ...(userAttachments && userAttachments.length > 0
        ? { attachments: userAttachments }
        : {}),
    });
    void safeLogActivity(
      deps.auditLog,
      'chat_message_sent',
      `${session_id}:${userMessageId}`,
      JSON.stringify({
        role: 'user',
        surface: inbound.surface,
        model_used: modelUsed,
        attachment_count: userAttachments?.length ?? 0,
      }),
    );

    if (!voiceTranscribed && userText.trim().length === 0 && userAttachments && userAttachments.length > 0) {
      await input.channel.deliver({
        kind: 'message',
        session_id,
        turn_id,
        text: mediaOnlyAffordance(
          userAttachments,
          deps.resolveFileNames?.(userAttachments.map((a) => a.file_id))
            ?? new Map<string, string>(),
        ),
      });
      return { turn_id };
    }

    // Reuse the SAME executor core + `streamRegistry`. The messenger surface
    // renders neither token deltas nor transparency notes (N.6), so the rich
    // SI / tool-call emits route to a no-op `emit`; the final answer reaches
    // the user via the framework's `out.message` → the messenger transport.
    const {
      streamState,
      turnExecutor,
      getCapturedResult,
      getPlannerRounds,
    } = buildTurnDriver({
      session_id,
      turn_id,
      picker_target,
      dispatch_peer_name: null,
      // The channel-minted `(messenger × user_self)` source — the turn's
      // tool dispatches are gated under the MESSENGER policy cell and
      // session-granted per Slack / Telegram thread
      // (`deriveChannelSessionId` → `messenger:<vendor>:<from>`), no
      // longer disguised as chat dispatches. The I-7 hop token rides
      // beside it: a re-entrant fire's dispatches carry the ingest depth,
      // so the Gateway loop ceiling bounds messenger→trigger→messenger
      // THROUGH tool dispatches (codex fold).
      execution_source: inbound.source,
      dispatch_depth: inbound.dispatch_depth,
      content_parts: buildChatContentPromptParts({
        // ⛔⛔ THE MARKER MUST BE ON THE CURRENT TURN TOO, NOT ONLY THE TAIL.
        // `buildChatTail` runs BEFORE the user row is appended (deliberately —
        // otherwise the current message appears twice in the packet), so the
        // file the person JUST dropped is not in the tail. Marking only the
        // tail meant the motivating case — drop a PDF, say "send this to Bob"
        // — reached the model with no marker at all, and the file only became
        // visible one turn LATE. `file.search` would still have found it, but
        // the discovery guarantee was not being delivered where it matters.
        //
        // ⚠ Applied to the MODEL's copy only. `userText` is what was appended
        // to the store above, and it stays exactly what the person sent.
        user_message: userAttachments && userAttachments.length > 0
          ? `${userText}${renderAttachmentMarker(
            userAttachments,
            deps.resolveFileNames?.(userAttachments.map((a) => a.file_id))
              ?? new Map<string, string>(),
          )}`
          : userText,
        chat_tail: builtChatTail.messages,
      }),
      model_layer: modelLayer,
      ...(modelHint ? { model_hint: modelHint } : {}),
      ...(modelSourceId ? { model_source_id: modelSourceId } : {}),
      emit: () => {},
    });

    // Drive the turn through the framework loop over the INJECTED messenger
    // channel + the verified inbound (its `dispatch_depth` is the I-7 hop
    // token the channel stamped — the gateway bounds a
    // `messenger`→trigger→`messenger` loop on it, D-160 P3). The channel
    // already recorded the inbound user row on `ingest`, so the framework
    // reads a consistent history without a preload (the base session store
    // exposes no `preload`; durable hydration is the caller's concern).
    await runStream({
      registry: streamRegistry,
      channel: input.channel,
      sessionStore: input.sessionStore,
      inbound: effectiveInbound,
      runTurn: turnExecutor,
      capacity: chatCapacity(),
      // Per-turn scratch (never constructor-captured) so concurrent turns
      // across surfaces never share state.
      state: streamState,
      validatePromptPart: createRetainablePromptPartValidator(),
      // Pin the framework turn id to the pre-minted id so the streamed delta
      // + the final message share one `turn_id`.
      mintId: () => turn_id,
    });

    deps.getExecutionCaseLifecycle?.()?.recordPlannerRounds({
      session_id,
      turn_id,
      rounds: getPlannerRounds(),
    });
    const turnResult = getCapturedResult() ?? { assistant_content: '' };
    const totalUsage = turnResult.usage;
    // A minimal audit row keeps the messenger turn traceable (surface-tagged
    // so Memory / the benchmark tell the surfaces apart). Counts only; never
    // user content. Durable ChatStore persistence is the deferred follow-on.
    void safeLogActivity(
      deps.auditLog,
      'chat_message_sent',
      `${session_id}:${turn_id}`,
      JSON.stringify({
        role: 'assistant',
        surface: inbound.surface,
        model_used: modelUsed,
        tool_call_count: turnResult.tool_calls?.length ?? 0,
        ...(totalUsage !== undefined ? { total_usage: totalUsage } : {}),
      }),
    );

    return {
      turn_id,
      ...(totalUsage !== undefined ? { total_usage: totalUsage } : {}),
    };
  };

  const runLlmGatewayTurn = async (
    input: LlmGatewayTurnInput,
  ): Promise<LlmGatewayTurnResult> => {
    const turn_id = mintId();
    const executionSource: Extract<
      ExecutionSource,
      { channel: 'chat'; actor: 'contracted_user' }
    > = {
      channel: 'chat',
      actor: 'contracted_user',
      chat_session_id: input.session_id,
      user_id: input.user_id,
      contract_id: input.contract_id,
      turn_id,
    };
    const allowedNames = new Set(input.allowed_tool_names);
    const contractCatalog = deps.registry
      .list()
      .filter(
        (entry) =>
          entry.name !== RECALL_SEARCH_TOOL_NAME
          && isLlmGatewayContractSafeToolEntry(entry)
          && allowedNames.has(entry.name),
      )
      .map((entry) => ({
        ...entry,
        // The generic Tier-2 catalog may come from an older/test source whose
        // object schema omitted the closure keyword. The gateway projection is
        // always closed, and dispatch validates against the same normalized
        // schema below.
        arg_schema: closedLlmGatewayArgSchema(entry.arg_schema)!,
      }));
    // Contract turns use the full projection over the already-small granted
    // catalog. In particular, `tools.search` is not an authority-expansion
    // path: full mode omits it, and no ungranted recipe can be discovered.
    const availableTools = buildChatMainTurnTools(
      contractCatalog,
      new Set<string>(),
      new Set<string>(),
      { mode: 'full' },
    );

    // Stateless gateway completions share chat's exact per-call PII alias /
    // restore seam, but not its durable owner session ledger. A request-local
    // store retains stable aliases across tool-loop rounds and is collected
    // with the completion, avoiding both owner-ledger crossover and leaks from
    // the gateway's one-shot session ids.
    const gatewayPiiPlan = piiHookDeps
      ? createPiiEgressPlanForSession(
          {
            ...piiHookDeps,
            ledgerStore: piiEgress.createSessionLedgerStore(),
          },
          input.session_id,
          'chat',
        )
      : undefined;
    const validateGatewayEgress = input.input_token_budget !== undefined
      ? (aiInput: Record<string, unknown>): void => {
          const system = aiInput['llm.system_prompt'];
          const prompt = aiInput['llm.prompt'];
          if (
            typeof system === 'string'
            && typeof prompt === 'string'
            && estimateConservativeMessagesTokens([
              { role: 'system', content: system },
              { role: 'user', content: prompt },
            ]) > input.input_token_budget!
          ) {
            throw new ChatContextLengthError();
          }
        }
      : undefined;
    const executeAiCall = gatewayPiiPlan
      ? wrapExecuteAiCallForPii(
          input.execute_ai_call,
          gatewayPiiPlan,
          undefined,
          undefined,
          validateGatewayEgress,
        )
      : input.execute_ai_call;
    let observedGatewayUsage: TokenUsageReport | undefined;
    const executeGatewayAiCall: ExecuteChatAiCall = async (manifest, aiInput) => {
      const callResult = await executeAiCall(manifest, aiInput);
      observedGatewayUsage = aggregateTokenUsageReports(
        observedGatewayUsage,
        callResult.usage,
      );
      return callResult;
    };

    let completedDispatches = 0;
    let partialDispatches = 0;
    let inDoubtDispatches = 0;
    let nonEffectDispatches = 0;
    const dispatchedToolCalls = (): number =>
      completedDispatches + partialDispatches + inDoubtDispatches;
    const buildPostEffectOutcome = (
      error_code: LlmGatewayPostEffectOutcome['error_code'],
    ): LlmGatewayPostEffectOutcome | null => {
      const dispatched = dispatchedToolCalls();
      if (dispatched === 0) return null;
      const status: LlmGatewayPostEffectStatus = inDoubtDispatches > 0
        ? 'in_doubt'
        : partialDispatches > 0 || nonEffectDispatches > 0
          ? 'partial'
          : 'completed';
      const failure = error_code === 'context_length_exceeded'
        ? 'the remaining model context was exhausted'
        : error_code === 'llm_gateway_authority_changed'
          ? 'live gateway authority changed before final synthesis'
          : 'the model provider failed during final synthesis';
      const message = status === 'completed'
        ? `Tool work completed, but ${failure}. Do not retry automatically; the effect already ran.`
        : status === 'partial'
          ? `Some requested tool work did not complete before ${failure}. Do not retry automatically; inspect any affected state first.`
          : `Tool work may have taken effect before ${failure}. Do not retry automatically; reconcile the affected state first.`;
      return {
        status,
        error_code,
        message,
        retryable: false,
        dispatched_tool_calls: dispatched,
      };
    };

    let result: RunChatTurnResult;
    try {
      result = await runChatTurn(
        {
          session_id: input.session_id,
          turn_id,
          picker_target: 'self',
          dispatch_peer_name: null,
          execution_source: executionSource,
          // The GATEWAY's own prompt — never the owner's chat one. Handler-
          // resolved (it owns `system_tools_allowed`); absent only for direct
          // harness callers, who fall through to the built-in chat prompt.
          ...(input.system_prompt !== undefined
            ? { system_prompt: input.system_prompt }
            : {}),
          ...(input.system_role !== undefined
            ? { system_role: input.system_role }
            : {}),
          ...(input.llm_gateway_tool_usage !== undefined
            ? { llm_gateway_tool_usage: input.llm_gateway_tool_usage }
            : {}),
          dispatch_depth: 0,
          available_tools: availableTools,
          content: input.content,
          correction_context: [],
          catalog_mode: 'full',
          model_layer: input.model_layer,
          ...(input.model_hint !== undefined
            ? { model_hint: input.model_hint }
            : {}),
          ...(input.model_source_id !== undefined
            ? { model_source_id: input.model_source_id }
            : {}),
          ...(input.input_token_budget !== undefined
            ? { input_token_budget: input.input_token_budget }
            : {}),
        },
        {
          executeAiCall: executeGatewayAiCall,
          registry: deps.registry,
          dispatchTool: async (call) => {
            const entry = deps.registry.getByName(call.tool_name);
            if (
              entry === null
              || !isLlmGatewayContractSafeToolEntry(entry)
              || !allowedNames.has(call.tool_name)
            ) {
              nonEffectDispatches += 1;
              return {
                ok: false,
                reason: 'classification_blocked',
                detail: 'llm_gateway tool is not granted by this customer token',
              };
            }
            const argsValidation = validateLlmGatewayToolArguments(
              entry.arg_schema,
              call.arg_values,
            );
            if (!argsValidation.ok) {
              nonEffectDispatches += 1;
              return {
                ok: false,
                reason: 'invalid_args',
                detail: argsValidation.detail,
              };
            }
            let snapshot: ContractSnapshot | null;
            try {
              snapshot = await input.resolve_contract_snapshot({
                tool_name: call.tool_name,
                arg_values: call.arg_values,
              });
            } catch {
              snapshot = null;
            }
            if (snapshot === null || snapshot.contract_id !== input.contract_id) {
              nonEffectDispatches += 1;
              return {
                ok: false,
                reason: 'connection_unavailable',
                detail: 'llm_gateway token or contract is no longer active for this tool',
              };
            }
            try {
              const dispatchResult = await dispatchTool({
                ...call,
                execution_source: executionSource,
                contract_snapshot: snapshot,
                ...(input.llm_gateway_tool_usage !== undefined
                  ? { llm_gateway_tool_usage: input.llm_gateway_tool_usage }
                  : {}),
              });
              if (dispatchResult.ok) {
                if (dispatchResult.run_held) nonEffectDispatches += 1;
                else if (dispatchResult.run_failed) partialDispatches += 1;
                else completedDispatches += 1;
              } else if (
                dispatchResult.reason === 'execution_error'
                || dispatchResult.reason === 'run_cancelled'
              ) {
                // A cancelled run may have been killed after its operation
                // started (or before a queued call started). The result does not
                // distinguish those cases, so a later synthesis failure must be
                // in-doubt rather than represented as safely pre-effect.
                inDoubtDispatches += 1;
              } else {
                nonEffectDispatches += 1;
              }
              return dispatchResult;
            } catch (error) {
              // The registry crossed its dispatch boundary but did not return an
              // outcome. Treat it as in-doubt; retrying could duplicate an effect.
              inDoubtDispatches += 1;
              throw error;
            }
          },
          emit: () => {},
          now,
        },
      );
    } catch (error) {
      const rawCode = error !== null && typeof error === 'object'
        ? (error as { code?: unknown }).code
        : undefined;
      const errorCode: LlmGatewayPostEffectOutcome['error_code'] | null =
        error instanceof ChatContextLengthError || rawCode === 'AI_TOKEN_BUDGET_EXCEEDED'
          ? 'context_length_exceeded'
          : rawCode === 'llm_gateway_authority_changed'
            ? 'llm_gateway_authority_changed'
            : null;
      const outcome = errorCode ? buildPostEffectOutcome(errorCode) : null;
      if (outcome) {
        return {
          turn_id,
          assistant_content: outcome.message,
          ...(observedGatewayUsage !== undefined
            ? { usage: observedGatewayUsage }
            : {}),
          post_effect_outcome: outcome,
        };
      }
      throw error;
    }
    if (result.tool_loop_failure !== undefined) {
      const outcome = buildPostEffectOutcome('llm_gateway_provider_failed');
      if (outcome) {
        return {
          turn_id,
          assistant_content: outcome.message,
          ...(result.tool_calls !== undefined ? { tool_calls: result.tool_calls } : {}),
          ...(result.usage !== undefined ? { usage: result.usage } : {}),
          post_effect_outcome: outcome,
        };
      }
    }
    if (result.final_ai_output === undefined) {
      throw new Error('llm_gateway shared chat turn did not produce a valid AI output');
    }
    return {
      turn_id,
      assistant_content: result.assistant_content,
      ...(result.tool_calls !== undefined ? { tool_calls: result.tool_calls } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    };
  };

  return {
    runTurn,
    runMessengerTurn,
    runLlmGatewayTurn,
    sessionStore: streamSessionStore,
    dispatch: { dispatchTool },
  };
};
