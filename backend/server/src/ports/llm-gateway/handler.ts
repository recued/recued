/** D-196 S2c — OpenAI-compatible LLM gateway door.
 *
 *  This port is deliberately narrow: OpenAI chat-completions compatibility,
 *  existing inbound bearer rows, live contract + door-type admission, and
 *  seller `chat_turn` metering. The actual model call sits behind an injected
 *  provider so the HTTP/auth/metering contract is testable apart from chat
 *  orchestration internals.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  computeContextInputTokenBudget,
  computeMaxTokens,
  executeLLM,
  estimateConservativeMessageTokens,
  estimateConservativeMessagesTokens,
  LLMError,
  normalizeLLMSlot,
  completeWithFallbacks,
  type AdapterKey,
  type AdapterRegistry,
  type FreePoolApiEntry,
  type LLMConfig,
  type LLMMessage,
  type LLMMessageRole,
  type LLMFinishReason,
  type LLMSlot,
  type LlmGatewayDefaultRoute,
  type ModelHint,
  type QuotaTracker,
  type TokenUsage,
} from '@recued/llm';
import {
  isLlmGatewayPaidAcknowledged,
  isMcpInboundConcurrencyTier,
  isMcpInboundTokenToolAuthorized,
  type ContractSnapshot,
  type McpInboundTokenRecord,
  type RecipeDefinition,
  type ToolEntry,
} from '@recued/contracts';
import { buildVersionedContractSnapshot } from '../../contract-snapshot-version.js';
import {
  isLlmGatewayContractSafeToolEntry,
  type ChatOrchestrator,
  type ExecuteChatAiCall,
  type LlmGatewayPostEffectOutcome,
  type LlmGatewayTurnInput,
  type LlmGatewayToolUsageMeter,
} from '../../chat-orchestrator.js';
import { ChatContextLengthError } from '../../chat-turn-executor.js';
import {
  policyEmitsApplicationInstructions,
  policyInjectsCallerInstructions,
  resolveCallerSystemPolicy,
  resolveLlmSystemPrompt,
} from '../../llm-system-prompt.js';
import { tokenUsageToReport } from '../../chat-token-usage.js';
import type { ContractOverlayResolver } from '../../policy-contract-overlay.js';
import type { ChatInboundTokenStore } from '../../storage/chat-inbound-token-store.js';
import {
  evaluateSellerCustomerAccessAdmission,
  type SellerCustomerAccessAdmissionResult,
  type SellerCustomerAccessAdmissionStore,
} from '../../seller/customer-access-admission.js';
import {
  createSellerCustomerUsageGate,
  resolveSellerCustomerUsagePolicy,
  sellerCustomerUsagePeriodStart,
  type SellerCustomerUsageAdmissionResult,
  type SellerCustomerUsageInput,
  type SellerCustomerUsageRateReservation,
  type SellerCustomerUsageStore,
} from '../../seller/customer-usage-policy.js';
import { extractBearerToken } from '../common/bearer.js';
import { writeJson } from '../common/respond.js';

const DEFAULT_MODEL_ALIAS = 'recued-seller';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_PROMPT_CHARS = 120_000;
/** LLM calls intentionally have no default timer because aborting a billed
 *  provider turn can discard a result the owner already paid for. Bound the
 *  retained HTTP/provider work instead: each token also carries its authored
 *  D-137 3 / 5 / 10 concurrent-call tier. */
export const LLM_GATEWAY_MAX_IN_FLIGHT_GLOBAL = 32;
const POOL_CURSOR_KEY = 'llm_gateway:pool';
const CONTEXT_OMISSION_NOTICE =
  '[llm_gateway context notice] Older conversation messages were omitted from this request because it exceeded the gateway prompt budget. Continue from the preserved recent context; ask the caller for missing details if needed.';

type SlotKey = 'slot_1' | 'slot_2';

export type LlmGatewayResolvedRoute =
  | {
      readonly kind: 'slot';
      readonly configured_route: Extract<LlmGatewayDefaultRoute, `slot:${string}`>;
      readonly source_id: SlotKey;
      readonly slot: LLMSlot;
      readonly adapter_key: AdapterKey;
      readonly resolved_hint: ModelHint;
    }
  | {
      readonly kind: 'pool';
      readonly configured_route: 'pool';
      readonly source_id: string;
      readonly entry: FreePoolApiEntry;
      readonly slot: LLMSlot;
      readonly adapter_key: AdapterKey;
      readonly resolved_hint: ModelHint;
    };

export interface LlmGatewayUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export interface LlmGatewayCompletionInput {
  readonly route: LlmGatewayResolvedRoute;
  /** The CALLER's OpenAI messages, budget-fitted. Recued's own system prompt is
   *  NOT in here — it rides `system_prompt` below, and each provider injects it
   *  the way its transport needs.
   *
   *  ⚠ It used to be prepended into this array, and that was a real bug: the
   *  shared provider (the ONLY one production composes) filters every `system`
   *  message in this array into the `customer_application_instructions` field of
   *  the turn's user message — so Recued's own contract-scoping posture was
   *  handed to the model LABELLED AS THE CUSTOMER'S INSTRUCTIONS, including the
   *  line telling it that caller instructions are not owner-level. Anything
   *  Recued authors must stay out of this array. */
  readonly messages: ReadonlyArray<LLMMessage>;
  /** Recued's fully-composed system prompt for this request: the owner's role
   *  block, plus Recued's core + feature text, plus — when the owner's policy
   *  says so — the caller's own instructions inside a nonce-delimited block.
   *  Resolved ONCE here (the only place `system_tools_allowed` is
   *  authoritative) so the two providers cannot disagree about what the model
   *  was told. */
  readonly system_prompt: string;
  /** The SAME prompt composed for a RAW PASS-THROUGH: role block + posture, and
   *  deliberately NO AIOutput contract.
   *
   *  ⚠ The two are not interchangeable, which is why both are carried rather
   *  than one being derived. The shared provider runs the caller through
   *  Recued's chat decoder, so it MUST be told the AIOutput shape or the reply
   *  cannot be read back. The direct provider hands `result.text` straight to
   *  the OpenAI client, so the same instruction would make every response come
   *  back as Recued's internal JSON envelope instead of an answer. Each provider
   *  reads its own field; neither may read the other's. */
  readonly system_prompt_direct: string;
  /** Wire role the prompt is delivered under (owner-set; `'system'` default). */
  readonly system_role: LLMMessageRole;
  /** Whether the caller's `system` messages should ALSO be handed to the model
   *  as `customer_application_instructions`. True only under the `context`
   *  policy — under append/replace they are already inside `system_prompt`, and
   *  under `ignore` they are dropped. */
  readonly emit_caller_application_instructions: boolean;
  readonly requested_model: string | undefined;
  readonly model_alias: string;
  readonly config: LLMConfig;
  readonly now: number;
  readonly system_tools_allowed: boolean;
  readonly token: McpInboundTokenRecord;
  readonly contract_id: string;
  /** Exact top-level Tier-2 recipe names proven callable under the current
   * token dependency grants. This is narrower than the raw token grant map. */
  readonly allowed_tool_names: ReadonlyArray<string>;
  readonly input_token_budget: number;
  readonly resolve_contract_snapshot: (call: {
    readonly tool_name: string;
    readonly arg_values: unknown;
  }) => ContractSnapshot | null | Promise<ContractSnapshot | null>;
  /** Re-read bearer, seller, contract, route, and callable-catalog authority
   * immediately before each real provider invocation. Preflight sentinels do
   * not call this seam. */
  readonly assert_live_authority?: () => void | Promise<void>;
  readonly llm_gateway_tool_usage?: LlmGatewayToolUsageMeter;
}

export interface LlmGatewayCompletionResult {
  readonly id?: string;
  readonly content: string;
  readonly finish_reason?: 'stop' | 'length' | 'content_filter';
  readonly usage?: LlmGatewayUsage;
  readonly post_effect_outcome?: LlmGatewayPostEffectOutcome;
}

export interface LlmGatewayCompletionProvider {
  /** Optional exact provider-specific prompt preflight. The shared chat
   * provider uses it to assemble and fit Recued's system/catalog framing
   * before seller chat-turn admission consumes rate capacity. */
  preflight?(input: LlmGatewayCompletionInput): void | Promise<void>;
  complete(input: LlmGatewayCompletionInput): Promise<LlmGatewayCompletionResult>;
}

export interface LlmGatewayHandlerDeps {
  /** Presented-bearer verification is the sole token authority seam. Dispatch
   * must never refresh by token id and let an invalidated bearer inherit a
   * replacement row. */
  readonly inboundTokenStore: Pick<ChatInboundTokenStore, 'verifyBearer'>;
  readonly contractOverlay?: Pick<
    ContractOverlayResolver,
    | 'isContractLive'
    | 'permitsDoorType'
    | 'resolveBoundContractKind'
    | 'resolveContractScopeRestrictions'
  >;
  readonly sellerStore?: SellerCustomerAccessAdmissionStore & SellerCustomerUsageStore;
  readonly getLlmConfig: () => LLMConfig | undefined;
  readonly completionProvider: LlmGatewayCompletionProvider;
  readonly quota?: Pick<
    QuotaTracker,
    | 'statusFor'
    | 'tokensToday'
    | 'isInCooldown'
    | 'currentCursor'
  >;
  readonly now?: () => number;
  readonly rng?: () => number;
  readonly max_body_bytes?: number;
  readonly max_prompt_chars?: number;
  /** Process-wide completion ceiling. Invalid values fall back to the
   *  exported production default; per-token ceilings come from the verified
   *  token's authored `concurrency_tier`. */
  readonly max_in_flight_global?: number;
  /** V1 direct-provider gateway exposes no tool catalog. Future chat-layer
   *  providers must keep owner-durable tools default-off and enable them only
   *  from an explicit contract-scoped grant/configuration. */
  readonly systemToolsAllowed?: (input: {
    readonly token: McpInboundTokenRecord;
    readonly contract_id: string;
    readonly now: number;
  }) => boolean;
  /** Resolve raw ingredient slugs admitted by the current token. This remains
   * separate from the top-level chat-tool grant: the snapshot is consumed by
   * nested engine policy gates whose namespace is ingredient slugs. */
  readonly listContractAllowedToolSlugs?: (
    token: McpInboundTokenRecord,
  ) => ReadonlyArray<string>;
  /** Project the top-level chat recipe names whose own token grant AND every
   * statically resolvable ingredient dependency are authorized. Production
   * supplies this from the live registry/recipe store; absent test harnesses
   * conservatively fall back to exact true token keys. */
  readonly listContractCallableChatToolNames?: (
    token: McpInboundTokenRecord,
  ) => ReadonlyArray<string>;
}

export interface LlmGatewayDirectCompletionProviderDeps {
  readonly adapters: AdapterRegistry;
  readonly quota?: Pick<
    QuotaTracker,
    'registerRequest' | 'recordUsage' | 'advanceCursor'
  >;
  readonly timeout_ms?: number | null;
}

export interface LlmGatewaySharedChatCompletionProviderDeps {
  readonly orchestrator: Required<Pick<ChatOrchestrator, 'runLlmGatewayTurn'>>;
  readonly adapters: AdapterRegistry;
  readonly quota: QuotaTracker;
  readonly tabProbe: () => Promise<Set<import('@recued/contracts').WebChatTab>>;
  readonly timeout_ms?: number;
}

type OpenAiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'rate_limit_error'
  | 'server_error';

class LlmGatewayLiveAuthorityError extends Error {
  readonly code = 'llm_gateway_authority_changed';

  constructor(
    readonly status: number,
    readonly public_code: string,
    message: string,
    readonly type: OpenAiErrorType,
  ) {
    super(message);
    this.name = 'LlmGatewayLiveAuthorityError';
  }
}

interface LlmGatewayStaticIngredientDependency {
  readonly slug: string;
  readonly operation_id?: string;
}

const staticRecipeIngredientDependencies = (
  recipe: RecipeDefinition,
): ReadonlyArray<LlmGatewayStaticIngredientDependency> | null => {
  const dependencies = new Map<string, LlmGatewayStaticIngredientDependency>();
  const record = recipe as unknown as Record<string, unknown>;
  for (const phase of ['trigger_steps', 'prefetch_steps', 'steps'] as const) {
    const steps = record[phase];
    if (!Array.isArray(steps)) continue;
    for (const value of steps) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const step = value as Record<string, unknown>;
      // Op steps lower against live binding/profile state. Until that exact
      // lowering result is available at catalog projection, it cannot be
      // proven against the snapshot and the recipe stays hidden.
      if (typeof step.op === 'string' && step.op.length > 0) return null;
      if (typeof step.ingredient !== 'string' || step.ingredient.length === 0) continue;
      // A dynamic ingredient ref can select a different slug from caller input;
      // never prove it from the authored template.
      if (step.ingredient.includes('{{')) return null;
      const stepInput = step.input;
      const operation_id =
        stepInput !== null
        && typeof stepInput === 'object'
        && !Array.isArray(stepInput)
        && typeof (stepInput as Record<string, unknown>).operation === 'string'
          ? (stepInput as Record<string, unknown>).operation as string
          : undefined;
      const dependency = {
        slug: step.ingredient,
        ...(operation_id !== undefined ? { operation_id } : {}),
      };
      dependencies.set(`${dependency.slug}\u0000${operation_id ?? ''}`, dependency);
    }
  }
  return [...dependencies.values()];
};

/** Fail-closed projection for the gateway's current Tier-2-only catalog.
 * A top-level recipe grant is presentation authority, not transitive ingredient
 * authority: every concrete dependency must also be present in the token's raw
 * or MCP-prefixed ingredient grants (or its separately-authorized CLI set). */
export const listLlmGatewayCallableRecipeNames = (input: {
  readonly entries: ReadonlyArray<ToolEntry>;
  readonly token: McpInboundTokenRecord;
  readonly getRecipe: (recipeId: string) => RecipeDefinition | null | undefined;
  /** Production classifies against the loaded manifest registry. A missing
   * manifest is not statically executable and therefore denies presentation. */
  readonly resolveIngredientKind: (slug: string) => 'cli' | 'other' | null;
  /** Exact operation-qualified CLI authority, matching the engine catalog
   * gateway's `(principal, ingredient, operation)` resolver. */
  readonly isCliOperationReachable: (slug: string, operationId: string) => boolean;
}): string[] => {
  const dependencyAuthorized = (
    dependency: LlmGatewayStaticIngredientDependency,
  ): boolean => {
    let kind: 'cli' | 'other' | null;
    try {
      kind = input.resolveIngredientKind(dependency.slug);
    } catch {
      return false;
    }
    if (kind === null) return false;
    if (kind === 'cli') {
      const operationId = dependency.operation_id;
      if (
        operationId === undefined
        || operationId.trim().length === 0
        || operationId.includes('{{')
      ) return false;
      try {
        return input.isCliOperationReachable(dependency.slug, operationId) === true;
      } catch {
        return false;
      }
    }
    return input.token.grants[dependency.slug] === true
      || input.token.grants[`recued_ingredient_${dependency.slug}`] === true;
  };

  const callable: string[] = [];
  for (const entry of input.entries) {
    if (
      !isLlmGatewayContractSafeToolEntry(entry)
      || input.token.grants[entry.name] !== true
    ) {
      continue;
    }
    const slash = entry.name.indexOf('/');
    if (slash <= 0 || slash === entry.name.length - 1) continue;
    const recipe = input.getRecipe(entry.name.slice(slash + 1));
    if (!recipe) continue;
    const dependencies = staticRecipeIngredientDependencies(recipe);
    if (
      dependencies !== null
      && dependencies.every(dependencyAuthorized)
    ) {
      callable.push(entry.name);
    }
  }
  return callable;
};

const writeOpenAiError = (
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  type: OpenAiErrorType,
  headers?: Record<string, string>,
): void => {
  writeJson(
    res,
    status,
    {
      error: {
        message,
        type,
        code,
      },
    },
    headers,
  );
};

const readJsonBody = async (
  req: IncomingMessage,
  maxBytes: number,
): Promise<unknown> =>
  new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        cleanup();
        req.pause();
        reject(new Error('payload_too_large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid_json'));
      }
    };
    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onAborted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('request_aborted'));
    };
    const onClose = () => {
      // A normal completed request reaches `end` first and removes this
      // listener. `close` before `end` is a disconnected/aborted body and must
      // settle the reader rather than retaining a concurrency slot forever.
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('request_aborted'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });

const pathname = (req: IncomingMessage): string => {
  const raw = req.url ?? '';
  const q = raw.indexOf('?');
  const h = raw.indexOf('#');
  let end = raw.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  return raw.slice(0, end);
};

const cleanAlias = (value: string | undefined): string =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : DEFAULT_MODEL_ALIAS;

const normalizePositiveInt = (
  value: number | undefined,
  fallback: number,
): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const messageCharCost = (message: LLMMessage): number =>
  message.role.length + message.content.length + 16;

const messagesCharCost = (messages: ReadonlyArray<LLMMessage>): number =>
  messages.reduce((sum, message) => sum + messageCharCost(message), 0);

interface LlmGatewayMessageCost {
  readonly tokens: number;
  readonly chars: number;
}

type LlmGatewayMessagePlan =
  | { readonly ok: true; readonly messages: LLMMessage[] }
  | {
      readonly ok: false;
      readonly required_tokens: number;
      readonly input_token_budget: number;
    };

const messageCost = (message: LLMMessage): LlmGatewayMessageCost => ({
  tokens: estimateConservativeMessageTokens(message),
  chars: messageCharCost(message),
});

const addMessageCost = (
  left: LlmGatewayMessageCost,
  right: LlmGatewayMessageCost,
): LlmGatewayMessageCost => ({
  tokens: left.tokens + right.tokens,
  chars: left.chars + right.chars,
});

const fitsMessageBudget = (
  cost: LlmGatewayMessageCost,
  inputTokenBudget: number,
  maxPromptChars: number,
): boolean => cost.tokens <= inputTokenBudget && cost.chars <= maxPromptChars;

const latestUserMessageIndex = (messages: ReadonlyArray<LLMMessage>): number => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
};

/** Group non-system conversation messages by user turn so compaction never
 *  leaves an orphan assistant message. Caller system/developer messages are
 *  separately mandatory regardless of where they occur. */
const conversationGroups = (
  messages: ReadonlyArray<LLMMessage>,
): number[][] => {
  const groups: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || message.role === 'system') continue;
    if (message.role === 'user' && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(i);
  }
  if (current.length > 0) groups.push(current);
  return groups;
};

/** Budget-fit the CALLER's messages.
 *
 *  `recuedSystemPrompt` is counted in every budget here — it occupies the same
 *  context window as everything else — but it is deliberately NOT part of the
 *  returned array. Each provider injects it the way its transport needs
 *  (direct prepends it; shared threads it into the turn as the real system
 *  prompt). Putting it in this array is what caused the shared provider to
 *  demote Recued's own posture into `customer_application_instructions`.
 *
 *  The compaction `notice` DOES stay in the array as a system message: it is a
 *  statement about the caller's own conversation and belongs in the
 *  conversation stream, and the direct pass-through needs it there. In shared
 *  mode it is still surfaced among the customer's application instructions —
 *  truthful there, and harmless in a way a security frame was not. */
const buildLlmGatewayMessages = (
  messages: ReadonlyArray<LLMMessage>,
  inputTokenBudget: number,
  maxPromptChars: number,
  recuedSystemPrompt: LLMMessage,
): LlmGatewayMessagePlan => {
  const full = [recuedSystemPrompt, ...messages];
  if (
    estimateConservativeMessagesTokens(full) <= inputTokenBudget
    && messagesCharCost(full) <= maxPromptChars
  ) {
    return { ok: true, messages: [...messages] };
  }

  const notice: LLMMessage = {
    role: 'system',
    content: CONTEXT_OMISSION_NOTICE,
  };
  const retainedIndexes = new Set<number>();
  // Every caller system/developer instruction is mandatory. `parseMessages`
  // canonicalizes developer -> system before this point.
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'system') retainedIndexes.add(i);
  }
  const latestUser = latestUserMessageIndex(messages);
  if (latestUser >= 0) {
    // Preserve the latest complete user group, including any assistant prefill
    // after it. System messages in the range are already retained above.
    for (let i = latestUser; i < messages.length; i++) retainedIndexes.add(i);
  } else {
    // The compatibility parser permits system/assistant-only prompts. Preserve
    // the most recent non-system message when there is no user turn.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== 'system') {
        retainedIndexes.add(i);
        break;
      }
    }
  }

  let used = messageCost(recuedSystemPrompt);
  for (const index of retainedIndexes) {
    const message = messages[index];
    if (message) used = addMessageCost(used, messageCost(message));
  }
  if (!fitsMessageBudget(used, inputTokenBudget, maxPromptChars)) {
    return {
      ok: false,
      required_tokens: used.tokens,
      input_token_budget: inputTokenBudget,
    };
  }

  const noticeCost = messageCost(notice);
  const hasOptionalHistory = messages.length > retainedIndexes.size;
  const usedWithNotice = addMessageCost(used, noticeCost);
  if (
    hasOptionalHistory
    && !fitsMessageBudget(usedWithNotice, inputTokenBudget, maxPromptChars)
  ) {
    // Never alter caller history silently. Once compaction is necessary, its
    // explicit omission marker is mandatory too.
    return {
      ok: false,
      required_tokens: usedWithNotice.tokens,
      input_token_budget: inputTokenBudget,
    };
  }
  if (hasOptionalHistory) used = usedWithNotice;

  let omitted = false;
  const groups = conversationGroups(messages);
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i] ?? [];
    const optionalIndexes = group.filter((index) => !retainedIndexes.has(index));
    if (optionalIndexes.length === 0) continue;
    const groupCost = optionalIndexes.reduce(
      (cost, index) => addMessageCost(cost, messageCost(messages[index]!)),
      { tokens: 0, chars: 0 },
    );
    if (fitsMessageBudget(
      addMessageCost(used, groupCost),
      inputTokenBudget,
      maxPromptChars,
    )) {
      for (const index of optionalIndexes) retainedIndexes.add(index);
      used = addMessageCost(used, groupCost);
    } else {
      omitted = true;
      // Keep a contiguous suffix of whole turns. Once one recent group does
      // not fit, no still-older group may leapfrog it into the prompt.
      break;
    }
  }

  const assembled: LLMMessage[] = [];
  if (omitted) assembled.push(notice);
  for (let i = 0; i < messages.length; i++) {
    if (retainedIndexes.has(i)) assembled.push(messages[i]!);
  }
  return { ok: true, messages: assembled };
};

const slotRouteKey = (route: LlmGatewayDefaultRoute): SlotKey | null => {
  if (route === 'slot:slot_1') return 'slot_1';
  if (route === 'slot:slot_2') return 'slot_2';
  return null;
};

const slotHint = (slot: LLMSlot, key: SlotKey): ModelHint =>
  slot.speed ?? (key === 'slot_1' ? 'fast' : 'quality');

const quotaSlotAvailable = (
  slot: LLMSlot,
  key: SlotKey,
  quota: LlmGatewayHandlerDeps['quota'] | undefined,
): boolean => {
  if (!quota) return true;
  if (quota.isInCooldown(key)) return false;
  const cap = slot.daily_budget_tokens;
  if (cap !== undefined && cap > 0 && quota.tokensToday(key) >= cap) return false;
  return true;
};

const poolEntryToSlot = (entry: FreePoolApiEntry): LLMSlot => ({
  provider: entry.provider,
  model: entry.model,
  api_key: entry.api_key,
  ...(entry.base_url ? { base_url: entry.base_url } : {}),
  speed: entry.speed,
  supports_json: entry.supports_json,
  ...(entry.supports_search !== undefined ? { supports_search: entry.supports_search } : {}),
  ...(entry.context_window_tokens !== undefined
    ? { context_window_tokens: entry.context_window_tokens }
    : {}),
  ...(entry.modalities !== undefined ? { modalities: entry.modalities } : {}),
  ...(entry.transcription_model ? { transcription_model: entry.transcription_model } : {}),
});

const availablePoolEntries = (
  config: LLMConfig,
  quota: LlmGatewayHandlerDeps['quota'] | undefined,
): FreePoolApiEntry[] =>
  (config.free_pool ?? []).filter((entry): entry is FreePoolApiEntry => {
    if (entry.type !== 'api') return false;
    if (!entry.enabled) return false;
    if (!entry.api_key || !entry.model) return false;
    if (quota && !quota.statusFor(entry).available) return false;
    return true;
  });

const pickPoolEntry = (
  entries: ReadonlyArray<FreePoolApiEntry>,
  config: LLMConfig,
  quota: LlmGatewayHandlerDeps['quota'] | undefined,
  rng: () => number,
): FreePoolApiEntry => {
  if (entries.length === 1) return entries[0]!;
  if (config.free_pool_strategy === 'weighted') {
    const total = entries.reduce((sum, entry) => sum + (entry.weight ?? 1), 0);
    let needle = rng() * total;
    for (const entry of entries) {
      needle -= entry.weight ?? 1;
      if (needle <= 0) return entry;
    }
    return entries[entries.length - 1]!;
  }
  const cursor = quota?.currentCursor(POOL_CURSOR_KEY) ?? 0;
  return entries[cursor % entries.length]!;
};

export const resolveLlmGatewayRoute = (
  config: LLMConfig,
  deps: Pick<LlmGatewayHandlerDeps, 'quota' | 'rng'> = {},
): { ok: true; route: LlmGatewayResolvedRoute } | { ok: false; code: string; message: string } => {
  const configured = config.llm_gateway_default_route;
  if (!configured) {
    return {
      ok: false,
      code: 'llm_gateway_route_not_configured',
      message: 'llm_gateway_default_route is not configured.',
    };
  }

  const slotKey = slotRouteKey(configured);
  if (slotKey) {
    const configuredRoute = configured as Extract<LlmGatewayDefaultRoute, `slot:${string}`>;
    const slot = normalizeLLMSlot(config[slotKey], slotKey);
    if (!slot || !quotaSlotAvailable(slot, slotKey, deps.quota)) {
      return {
        ok: false,
        code: 'llm_gateway_route_unavailable',
        message: `${configured} is not currently available.`,
      };
    }
    return {
      ok: true,
      route: {
        kind: 'slot',
        configured_route: configuredRoute,
        source_id: slotKey,
        slot,
        adapter_key: slot.provider,
        resolved_hint: slotHint(slot, slotKey),
      },
    };
  }
  if (configured !== 'pool') {
    return {
      ok: false,
      code: 'llm_gateway_route_invalid',
      message: 'llm_gateway_default_route must be pool, slot:slot_1, or slot:slot_2.',
    };
  }

  const pool = availablePoolEntries(config, deps.quota);
  if (pool.length === 0) {
    return {
      ok: false,
      code: 'llm_gateway_route_unavailable',
      message: 'No enabled free-pool entry is currently available.',
    };
  }
  const entry = pickPoolEntry(pool, config, deps.quota, deps.rng ?? Math.random);
  return {
    ok: true,
    route: {
      kind: 'pool',
      configured_route: 'pool',
      source_id: entry.id,
      entry,
      slot: poolEntryToSlot(entry),
      adapter_key: entry.provider,
      resolved_hint: entry.speed,
    },
  };
};

const responseUsage = (usage: LlmGatewayUsage | undefined): LlmGatewayUsage =>
  usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

const usageFromTokenUsage = (usage: TokenUsage): LlmGatewayUsage => ({
  prompt_tokens: usage.input_tokens,
  completion_tokens: usage.output_tokens,
  total_tokens: usage.total_tokens,
});

export const createLlmGatewayDirectCompletionProvider = (
  deps: LlmGatewayDirectCompletionProviderDeps,
): LlmGatewayCompletionProvider => ({
  async complete(input) {
    await input.assert_live_authority?.();
    const sourceId = input.route.source_id;
    deps.quota?.registerRequest(sourceId, input.now);
    const adapter = deps.adapters(input.route.adapter_key);
    const options = {
      model: input.route.slot.model,
      max_tokens: computeMaxTokens(input.route.resolved_hint, input.route.slot),
      thinking: false,
      search: false,
      json: false,
      timeout_ms: deps.timeout_ms ?? null,
    };
    // Raw pass-through: Recued's prompt leads the wire messages verbatim. The
    // handler kept it out of `input.messages` (see the field doc) precisely so
    // the shared provider would not mistake it for caller data; this path is
    // the one that genuinely wants it as a message.
    //
    // ⚠ `system_prompt_direct`, NOT `system_prompt` — this path returns the
    // model's raw text to the OpenAI client, so it must never be told to emit
    // Recued's AIOutput envelope.
    // The RAW path calls the adapter itself, so it needs the same seam the
    // executor gives every other call: send `system`, and fold it into the user
    // turn only if this endpoint actually refuses the role. Without this the
    // shared path would auto-recover and the direct path would 400 on the same
    // slot — one door working and its neighbour not, for no reason the owner
    // could see. See `@recued/llm`'s `system-role-fallback.ts`.
    const result = await completeWithFallbacks(
      adapter,
      input.route.slot,
      [
        { role: input.system_role, content: input.system_prompt_direct },
        ...input.messages,
      ],
      options,
    );
    deps.quota?.recordUsage(sourceId, result.usage.total_tokens, input.now);
    if (input.route.kind === 'pool') deps.quota?.advanceCursor(POOL_CURSOR_KEY);
    return {
      content: result.text,
      usage: usageFromTokenUsage(result.usage),
      ...(result.finish_reason !== undefined
        ? { finish_reason: result.finish_reason }
        : {}),
    };
  },
});

const selectedRouteConfig = (
  input: LlmGatewayCompletionInput,
): LLMConfig => {
  const {
    slot_1: _slot1,
    slot_2: _slot2,
    free_pool: _freePool,
    ...shared
  } = input.config;
  if (input.route.kind === 'pool') {
    return { ...shared, free_pool: [input.route.entry] };
  }
  return input.route.source_id === 'slot_1'
    ? { ...shared, slot_1: input.route.slot }
    : { ...shared, slot_2: input.route.slot };
};

/** Extract the caller's own `system` / `developer` instructions. `parseMessages`
 *  has already canonicalized `developer` → `system` by this point.
 *
 *  ⚠ Nothing Recued authors is in this array — its system prompt rides
 *  `LlmGatewayCompletionInput.system_prompt`. So everything here is the
 *  caller's, which is exactly what makes the policy switch expressible. */
export const callerSystemInstructions = (
  messages: ReadonlyArray<LLMMessage>,
): string[] =>
  messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content);

/** Project the caller's OpenAI messages onto the shared chat turn's content.
 *
 *  `emitApplicationInstructions` is the caller-system-message POLICY, resolved
 *  by the owner. Only `context` emits them here — under `append`/`replace` they
 *  are already IN the system prompt (emitting them twice would waste tokens AND
 *  tell the model they are two different things), and under `ignore` they are
 *  dropped outright. */
const gatewayMessagesToChatContent = (
  messages: ReadonlyArray<LLMMessage>,
  emitApplicationInstructions: boolean,
): { readonly chat_tail: Array<{ role: 'user' | 'assistant'; content: string }>; readonly user_message: string } => {
  const applicationInstructions = emitApplicationInstructions
    ? callerSystemInstructions(messages)
    : [];
  const conversation = messages.filter(
    (message): message is LLMMessage & { role: 'user' | 'assistant' } =>
      message.role === 'user' || message.role === 'assistant',
  );
  let latestUser = -1;
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    if (conversation[i]?.role === 'user') {
      latestUser = i;
      break;
    }
  }
  if (latestUser < 0) {
    return {
      chat_tail: [],
      user_message: JSON.stringify({
        customer_application_instructions: applicationInstructions,
        customer_conversation: conversation,
      }),
    };
  }
  const chat_tail = conversation.slice(0, latestUser).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  return {
    chat_tail,
    // Under the default `context` policy these are data inside the customer's
    // contract — followed, but below the owner's authority, never a second
    // system-authority channel. Under append/replace the owner has deliberately
    // promoted them into the system prompt instead, so they are absent here.
    //
    // ⚠ This filter is why nothing Recued authors may sit in `messages`: it
    // sweeps EVERY `system` message in here into a field explicitly labelled as
    // the customer's. Recued's own prompt arrives out-of-band on
    // `LlmGatewayTurnInput.system_prompt`, so this array is what it claims to
    // be — caller instructions, and only caller instructions.
    user_message: JSON.stringify({
      customer_application_instructions: applicationInstructions,
      latest_customer_turn: conversation.slice(latestUser),
    }),
  };
};

const sharedGatewayTurnInput = (
  input: LlmGatewayCompletionInput,
  executeAiCall: ExecuteChatAiCall,
  toolUsage?: LlmGatewayToolUsageMeter,
): LlmGatewayTurnInput => ({
  session_id: `llm_gateway:${input.token.token_id}:${randomUUID()}`,
  user_id: input.token.peer_handle ?? `llm_gateway:${input.token.token_id}`,
  contract_id: input.contract_id,
  // Recued's prompt rides the turn's SYSTEM slot — the only channel on this
  // path the model reads as instruction rather than as customer data.
  system_prompt: input.system_prompt,
  system_role: input.system_role,
  content: gatewayMessagesToChatContent(
    input.messages,
    input.emit_caller_application_instructions,
  ),
  allowed_tool_names: input.allowed_tool_names,
  resolve_contract_snapshot: input.resolve_contract_snapshot,
  execute_ai_call: executeAiCall,
  model_layer: input.route.kind === 'pool' ? 'free_pool' : 'byok',
  model_hint: input.route.resolved_hint,
  model_source_id:
    input.route.kind === 'pool' ? 'free_pool' : input.route.source_id,
  input_token_budget: input.input_token_budget,
  ...(toolUsage !== undefined ? { llm_gateway_tool_usage: toolUsage } : {}),
});

/** D-196 — production provider that adapts OpenAI messages + an exact selected
 * route onto the existing chat cognition engine. */
export const createLlmGatewaySharedChatCompletionProvider = (
  deps: LlmGatewaySharedChatCompletionProviderDeps,
): LlmGatewayCompletionProvider => ({
  async preflight(input) {
    // Run the exact shared first-round assembly with a local sentinel result.
    // No provider, dispatch, usage meter, or durable chat surface is touched;
    // `ChatContextLengthError` therefore reaches the HTTP handler before its
    // seller rate/usage admission point.
    await deps.orchestrator.runLlmGatewayTurn(sharedGatewayTurnInput(
      input,
      async () => ({
        body: {
          response: 'llm_gateway context preflight',
          events: [],
          tool_calls: [],
        },
      }),
    ));
  },
  async complete(input) {
    let lastFinishReason: LLMFinishReason | undefined;
    const routeConfig = selectedRouteConfig(input);
    const turn = await deps.orchestrator.runLlmGatewayTurn(sharedGatewayTurnInput(
      input,
      async (manifest, aiInput) => {
        await input.assert_live_authority?.();
        let capturedUsage: TokenUsage | undefined;
        let callFinishReason: LLMFinishReason | undefined;
        const body = await executeLLM(manifest, aiInput, {
          config: routeConfig,
          adapters: deps.adapters,
          quota: deps.quota,
          tabProbe: deps.tabProbe,
          webChatSupported: false,
          ...(deps.timeout_ms !== undefined ? { timeout_ms: deps.timeout_ms } : {}),
          onTokenUsage: (usage) => {
            capturedUsage = usage;
          },
          onFinishReason: (reason) => {
            lastFinishReason = reason;
            callFinishReason = reason;
          },
        });
        return {
          body,
          ...(capturedUsage !== undefined
            ? { usage: tokenUsageToReport(capturedUsage) }
            : {}),
          ...(callFinishReason !== undefined
            ? { finish_reason: callFinishReason }
            : {}),
        };
      },
      input.llm_gateway_tool_usage,
    ));
    return {
      id: `chatcmpl_${turn.turn_id}`,
      content: turn.assistant_content,
      ...(turn.usage !== undefined
        ? {
            usage: {
              prompt_tokens: turn.usage.input_tokens,
              completion_tokens: turn.usage.output_tokens,
              total_tokens: turn.usage.total_tokens,
            },
          }
        : {}),
      ...(lastFinishReason !== undefined
        ? { finish_reason: lastFinishReason }
        : {}),
      ...(turn.post_effect_outcome !== undefined
        ? { post_effect_outcome: turn.post_effect_outcome }
        : {}),
    };
  },
});

type AuthResult =
  | {
      readonly ok: true;
      readonly token: McpInboundTokenRecord;
      readonly sellerAdmission: SellerCustomerAccessAdmissionResult;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly type: OpenAiErrorType;
    };

const authorize = (
  req: IncomingMessage,
  deps: LlmGatewayHandlerDeps,
  now: number,
): AuthResult => {
  const bearer = extractBearerToken(req);
  if (!bearer) {
    return {
      ok: false,
      status: 401,
      code: 'missing_bearer',
      message: 'Authorization: Bearer token is required.',
      type: 'authentication_error',
    };
  }
  const token = deps.inboundTokenStore.verifyBearer({ bearer, now });
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: 'invalid_bearer',
      message: 'Bearer token is invalid, expired, or revoked.',
      type: 'authentication_error',
    };
  }
  const contractId = token.contract_id;
  if (!contractId) {
    return {
      ok: false,
      status: 403,
      code: 'contract_required',
      message: 'llm_gateway requires a bearer token bound to a live contract.',
      type: 'permission_error',
    };
  }
  if (deps.contractOverlay?.isContractLive(contractId) !== true) {
    return {
      ok: false,
      status: 403,
      code: 'contract_not_live',
      message: 'The bound contract is not live.',
      type: 'permission_error',
    };
  }
  const permitsDoor = deps.contractOverlay?.permitsDoorType?.(contractId, 'llm_gateway') ?? true;
  if (!permitsDoor) {
    return {
      ok: false,
      status: 403,
      code: 'llm_gateway_door_not_permitted',
      message: 'The bound contract is not enabled for the llm_gateway door.',
      type: 'permission_error',
    };
  }

  let sellerAdmission: SellerCustomerAccessAdmissionResult = { applies: false };
  try {
    const resolveContractKind = deps.contractOverlay?.resolveBoundContractKind;
    sellerAdmission = evaluateSellerCustomerAccessAdmission({
      ...(deps.sellerStore ? { sellerStore: deps.sellerStore } : {}),
      token,
      now,
      contractKind: resolveContractKind
        ? resolveContractKind(contractId) ?? null
        : undefined,
    });
  } catch {
    sellerAdmission = {
      applies: true,
      admitted: false,
      reason: 'admission_error',
    };
  }
  if (sellerAdmission.applies === true && sellerAdmission.admitted !== true) {
    return {
      ok: false,
      status: 403,
      code: `seller_customer_${sellerAdmission.reason}`,
      message: 'Seller customer access is not currently admitted for this token.',
      type: 'permission_error',
    };
  }
  return { ok: true, token, sellerAdmission };
};

interface LlmGatewayErrorDescriptor {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly type: OpenAiErrorType;
}

/** D-196 §4.9 / I-7 — the monetization-boundary gate. A PAID (admitted
 *  seller-customer) `llm_gateway` turn requires the owner's one-time route-rights
 *  acknowledgment on record; without it the paid door has not armed and the turn
 *  fails closed BEFORE any `chat_turn` is metered. Free/standing bearers
 *  (`applies === false`) and `/v1/models` discovery are never gated (I-6). The
 *  substrate decides only *is a current acknowledgment on record*; whether a
 *  chosen route may lawfully serve paying customers stays the owner's judgment,
 *  never a substrate refusal ([[feedback_substrate_enforces_humans_judge]]).
 *  Returns an OpenAI-compatible error to fail with, or null to proceed. */
const llmGatewayPaidAckError = (
  deps: Pick<LlmGatewayHandlerDeps, 'sellerStore'>,
  sellerAdmission: SellerCustomerAccessAdmissionResult,
): LlmGatewayErrorDescriptor | null => {
  if (!(sellerAdmission.applies === true && sellerAdmission.admitted === true)) {
    // Not a paid seller turn — free/standing bearers arm with no prompt (I-6).
    return null;
  }
  let acknowledged = false;
  try {
    const settings = deps.sellerStore?.getSettings();
    acknowledged = settings !== undefined && isLlmGatewayPaidAcknowledged(settings);
  } catch {
    // An unreadable settings store fails closed: a paid turn never rides an
    // acknowledgment the server cannot confirm.
    acknowledged = false;
  }
  if (acknowledged) return null;
  return {
    status: 503,
    code: 'llm_gateway_paid_unacknowledged',
    message:
      'Selling paid llm_gateway access requires a one-time route-rights '
      + 'acknowledgment. The server owner must confirm in Settings → Seller that '
      + 'they hold the rights to serve paying customers on every model route in '
      + 'use, the free pool included.',
    type: 'server_error',
  };
};

const coerceContent = (content: unknown): string | null => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
    const record = part as Record<string, unknown>;
    if (record.type !== 'text' || typeof record.text !== 'string') return null;
    parts.push(record.text);
  }
  return parts.join('\n');
};

const parseMessages = (
  value: unknown,
): { ok: true; messages: LLMMessage[] } | { ok: false; message: string } => {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, message: 'messages must be a non-empty array.' };
  }
  const messages: LLMMessage[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, message: `messages[${i}] must be an object.` };
    }
    const record = raw as Record<string, unknown>;
    const roleRaw = record.role;
    if (roleRaw !== 'system' && roleRaw !== 'developer' && roleRaw !== 'user' && roleRaw !== 'assistant') {
      return {
        ok: false,
        message: `messages[${i}].role must be system, developer, user, or assistant.`,
      };
    }
    const content = coerceContent(record.content);
    if (content === null) {
      return {
        ok: false,
        message: `messages[${i}].content must be text-only for this gateway version.`,
      };
    }
    messages.push({
      role: roleRaw === 'developer' ? 'system' : roleRaw,
      content,
    });
  }
  return { ok: true, messages };
};

interface ChatCompletionRequest {
  readonly messages: LLMMessage[];
  readonly requested_model?: string;
}

const parseChatCompletionRequest = (
  body: unknown,
): { ok: true; value: ChatCompletionRequest } | { ok: false; message: string } => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'request body must be a JSON object.' };
  }
  const record = body as Record<string, unknown>;
  if (record.stream === true) {
    return { ok: false, message: 'streaming chat completions are not supported by this gateway version.' };
  }
  const messages = parseMessages(record.messages);
  if (!messages.ok) return messages;
  const requestedModel =
    typeof record.model === 'string' && record.model.length > 0
      ? record.model
      : undefined;
  return {
    ok: true,
    value: {
      messages: messages.messages,
      ...(requestedModel ? { requested_model: requestedModel } : {}),
    },
  };
};

const loadConfigAndRoute = (
  deps: LlmGatewayHandlerDeps,
): { ok: true; config: LLMConfig; route: LlmGatewayResolvedRoute; alias: string }
  | { ok: false; status: number; code: string; message: string } => {
  let config: LLMConfig | undefined;
  try {
    config = deps.getLlmConfig();
  } catch {
    config = undefined;
  }
  if (!config) {
    return {
      ok: false,
      status: 503,
      code: 'llm_gateway_route_not_configured',
      message: 'No LLM configuration is available for llm_gateway.',
    };
  }
  const route = resolveLlmGatewayRoute(config, { quota: deps.quota, rng: deps.rng });
  if (!route.ok) {
    return {
      ok: false,
      status: 503,
      code: route.code,
      message: route.message,
    };
  }
  return {
    ok: true,
    config,
    route: route.route,
    alias: cleanAlias(config.llm_gateway_model_alias),
  };
};

const resolvedRouteAuthorityKey = (route: LlmGatewayResolvedRoute): string =>
  JSON.stringify(route);

/** Re-resolve the exact route chosen for this completion without advancing or
 * reselecting the pool cursor. A changed slot/entry, disabled route, cooldown,
 * or config removal is a live authority change and fails closed. */
const isResolvedRouteStillAvailable = (
  deps: LlmGatewayHandlerDeps,
  expected: LlmGatewayResolvedRoute,
  expectedAuthorityKey: string,
): boolean => {
  let config: LLMConfig | undefined;
  try {
    config = deps.getLlmConfig();
  } catch {
    return false;
  }
  if (!config || config.llm_gateway_default_route !== expected.configured_route) {
    return false;
  }
  if (expected.kind === 'slot') {
    const slot = normalizeLLMSlot(config[expected.source_id], expected.source_id);
    if (!slot || !quotaSlotAvailable(slot, expected.source_id, deps.quota)) return false;
    const current: LlmGatewayResolvedRoute = {
      kind: 'slot',
      configured_route: expected.configured_route,
      source_id: expected.source_id,
      slot,
      adapter_key: slot.provider,
      resolved_hint: slotHint(slot, expected.source_id),
    };
    return resolvedRouteAuthorityKey(current) === expectedAuthorityKey;
  }
  const entry = availablePoolEntries(config, deps.quota)
    .find((candidate) => candidate.id === expected.source_id);
  if (!entry) return false;
  const current: LlmGatewayResolvedRoute = {
    kind: 'pool',
    configured_route: 'pool',
    source_id: entry.id,
    entry,
    slot: poolEntryToSlot(entry),
    adapter_key: entry.provider,
    resolved_hint: entry.speed,
  };
  return resolvedRouteAuthorityKey(current) === expectedAuthorityKey;
};

const resolveAllowedToolNames = (
  deps: LlmGatewayHandlerDeps,
  token: McpInboundTokenRecord,
): ReadonlyArray<string> => {
  try {
    const names = deps.listContractCallableChatToolNames?.(token)
      ?? Object.entries(token.grants)
        .filter(([, allowed]) => allowed === true)
        .map(([name]) => name);
    return [...new Set(names)].sort();
  } catch {
    return [];
  }
};

const sellerAuthorityKey = (
  admission: SellerCustomerAccessAdmissionResult,
): string => {
  if (admission.applies !== true) return 'ordinary';
  if (admission.admitted !== true) return `denied:${admission.reason}`;
  return JSON.stringify({
    customer: {
      customer_id: admission.customer.customer_id,
      lifecycle_source: admission.customer.lifecycle_source,
      source_customer_id: admission.customer.source_customer_id,
      door_id: admission.customer.door_id,
      contract_id: admission.customer.contract_id,
      inbound_token_id: admission.customer.inbound_token_id,
      mcp_token_id: admission.customer.mcp_token_id,
      tier_id: admission.customer.tier_id,
      source_status: admission.customer.source_status,
      current_period_end: admission.customer.current_period_end,
      grace_until: admission.customer.grace_until,
      access_state: admission.customer.access_state,
    },
    tier: {
      tier_id: admission.tier.tier_id,
      lifecycle_source: admission.tier.lifecycle_source,
      door_id: admission.tier.door_id,
      entitlement_key: admission.tier.entitlement_key,
      template_contract_id: admission.tier.template_contract_id,
      active: admission.tier.active,
      usage_policy_json: admission.tier.usage_policy_json,
    },
  });
};

const tokenAuthorityKey = (token: McpInboundTokenRecord): string => JSON.stringify({
  token_id: token.token_id,
  bearer_hash: token.bearer_hash,
  contract_id: token.contract_id,
  peer_handle: token.peer_handle,
  // ⚠ No `expires_at` — the token has none. Expiry is the CONTRACT's, and the
  // mid-flight guard re-runs the whole `authorize`, which re-checks
  // `isContractLive` (:1126). So a contract dying between admission and
  // provider work still aborts with 403; it just aborts there rather than here.
  revoked_at: token.revoked_at,
  grants: Object.fromEntries(
    Object.entries(token.grants).sort(([left], [right]) => left.localeCompare(right)),
  ),
});

type LlmGatewayContextBudget =
  | { readonly ok: true; readonly input_token_budget: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

const resolveRouteContextBudget = (
  route: LlmGatewayResolvedRoute,
): LlmGatewayContextBudget => {
  const contextWindowTokens = route.slot.context_window_tokens;
  if (contextWindowTokens === undefined) {
    return {
      ok: false,
      code: 'llm_gateway_context_window_not_configured',
      message: 'The selected llm_gateway source does not declare context_window_tokens.',
    };
  }
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) {
    return {
      ok: false,
      code: 'llm_gateway_context_window_invalid',
      message: 'The selected llm_gateway source has invalid context_window_tokens.',
    };
  }
  // Round upward defensively if a legacy/raw config supplied a fractional
  // output ceiling; parseLLMConfig normally prevents malformed context values.
  const reservedOutputTokens = Math.ceil(
    computeMaxTokens(route.resolved_hint, route.slot),
  );
  const inputTokenBudget = computeContextInputTokenBudget(
    contextWindowTokens,
    reservedOutputTokens,
  );
  if (inputTokenBudget === null) {
    return {
      ok: false,
      code: 'llm_gateway_context_window_invalid',
      message: 'The selected llm_gateway context window leaves no input capacity after output and safety reserves.',
    };
  }
  return { ok: true, input_token_budget: inputTokenBudget };
};

const resolveSystemToolsAllowed = (
  deps: LlmGatewayHandlerDeps,
  token: McpInboundTokenRecord,
  now: number,
): boolean => {
  const contractId = token.contract_id;
  if (!contractId || !deps.systemToolsAllowed) return false;
  try {
    return deps.systemToolsAllowed({
      token,
      contract_id: contractId,
      now,
    }) === true;
  } catch {
    return false;
  }
};

const createLiveProviderAuthorityAssertion = (input: {
  readonly req: IncomingMessage;
  readonly deps: LlmGatewayHandlerDeps;
  readonly token: McpInboundTokenRecord;
  readonly sellerAdmission: SellerCustomerAccessAdmissionResult;
  readonly route: LlmGatewayResolvedRoute;
  readonly routeAuthorityKey: string;
  readonly allowedToolNames: ReadonlyArray<string>;
  readonly systemToolsAllowed: boolean;
  readonly now: () => number;
}): (() => void) => {
  const expectedToken = tokenAuthorityKey(input.token);
  const expectedSeller = sellerAuthorityKey(input.sellerAdmission);
  const expectedAllowed = JSON.stringify([...input.allowedToolNames].sort());
  return () => {
    const current = input.now();
    const live = authorize(input.req, input.deps, current);
    if (!live.ok) {
      throw new LlmGatewayLiveAuthorityError(
        live.status,
        live.code,
        live.message,
        live.type,
      );
    }
    const liveAllowed = resolveAllowedToolNames(input.deps, live.token);
    const liveSystemToolsAllowed = liveAllowed.length > 0
      && resolveSystemToolsAllowed(input.deps, live.token, current);
    if (
      tokenAuthorityKey(live.token) !== expectedToken
      || sellerAuthorityKey(live.sellerAdmission) !== expectedSeller
      || JSON.stringify([...liveAllowed].sort()) !== expectedAllowed
      || liveSystemToolsAllowed !== input.systemToolsAllowed
    ) {
      throw new LlmGatewayLiveAuthorityError(
        403,
        'llm_gateway_authority_changed',
        'Bearer, Seller, contract, or callable-tool authority changed before provider work.',
        'permission_error',
      );
    }
    if (!isResolvedRouteStillAvailable(
      input.deps,
      input.route,
      input.routeAuthorityKey,
    )) {
      throw new LlmGatewayLiveAuthorityError(
        503,
        'llm_gateway_route_changed',
        'The configured llm_gateway route changed or became unavailable before provider work.',
        'server_error',
      );
    }
  };
};

const createDispatchSnapshotResolver = (
  req: IncomingMessage,
  deps: LlmGatewayHandlerDeps,
  initialTokenId: string,
  contractId: string,
  expectedRoute: LlmGatewayResolvedRoute,
  expectedRouteAuthorityKey: string,
  now: () => number,
): LlmGatewayCompletionInput['resolve_contract_snapshot'] =>
  ({ tool_name }) => {
    const current = now();
    const live = authorize(req, deps, current);
    if (!live.ok) return null;
    const fresh = live.token;
    if (
      fresh.token_id !== initialTokenId
      || fresh.contract_id !== contractId
      || !isMcpInboundTokenToolAuthorized(fresh, tool_name, current)
      || !isResolvedRouteStillAvailable(
        deps,
        expectedRoute,
        expectedRouteAuthorityKey,
      )
    ) {
      return null;
    }
    const source = {
      channel: 'chat' as const,
      actor: 'contracted_user' as const,
      chat_session_id: `llm_gateway:${fresh.token_id}`,
      user_id: fresh.peer_handle ?? `llm_gateway:${fresh.token_id}`,
      contract_id: contractId,
    };
    let allowedTools: ReadonlyArray<string> = [];
    try {
      allowedTools = deps.listContractAllowedToolSlugs?.(fresh) ?? [];
    } catch {
      return null;
    }
    let scopeRestrictions: ReadonlyArray<string> = [];
    try {
      scopeRestrictions =
        deps.contractOverlay?.resolveContractScopeRestrictions?.(source) ?? [];
    } catch {
      return null;
    }
    return buildVersionedContractSnapshot({
      contract_id: contractId,
      allowed_tools: allowedTools,
      approval_required: [],
      scope_restrictions: scopeRestrictions,
      resolved_at: current,
    });
  };

const LLM_GATEWAY_FREE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'tools.search',
  'recued_customerStatus',
  'customer.status',
  'setup.status',
  'catalog.list',
]);

const llmGatewayToolUnits = (toolName: string): number => {
  if (LLM_GATEWAY_FREE_TOOL_NAMES.has(toolName)) return 0;
  return 1;
};

interface GatewayUsageReservation {
  readonly key: string;
  readonly units: number;
  readonly admitted_at: number;
  readonly input: SellerCustomerUsageInput & { readonly units: number; readonly now: number };
  readonly rate_reservation: SellerCustomerUsageRateReservation | null;
}

/** Request-local callers share this handler-scoped reservation set. It closes
 * the read-then-record period-limit race across concurrent llm_gateway HTTP
 * requests while retaining the existing durable rollup as the committed
 * source of truth. Reservations are committed only after successful work and
 * cancelled on failure; their admission timestamp pins record to the same
 * day/month that was checked. */
const createGatewayUsageReservations = (input: {
  readonly sellerUsageGate: NonNullable<ReturnType<typeof createSellerCustomerUsageGate>>;
  readonly sellerStore: SellerCustomerUsageStore;
  readonly now: () => number;
}) => {
  const pendingByKey = new Map<string, number>();
  const live = new Set<GatewayUsageReservation>();

  const releasePending = (reservation: GatewayUsageReservation): void => {
    if (!live.delete(reservation)) return;
    const remaining = (pendingByKey.get(reservation.key) ?? 0) - reservation.units;
    if (remaining > 0) pendingByKey.set(reservation.key, remaining);
    else pendingByKey.delete(reservation.key);
  };

  return {
    admit(
      usageInput: SellerCustomerUsageInput & { readonly units: number; readonly now: number },
    ): {
      readonly admission: SellerCustomerUsageAdmissionResult;
      readonly reservation?: GatewayUsageReservation;
    } {
      if (!Number.isInteger(usageInput.units) || usageInput.units <= 0) {
        throw new Error('usage units must be a positive integer');
      }
      const admittedAt = usageInput.now;
      const parsed = resolveSellerCustomerUsagePolicy(
        usageInput.tier,
        usageInput.usage_kind,
      );
      if (!parsed.ok) {
        return { admission: input.sellerUsageGate.admit(usageInput) };
      }
      const periodStart = sellerCustomerUsagePeriodStart(
        admittedAt,
        parsed.policy.period_granularity,
      );
      const key = [
        usageInput.customer.contract_id,
        usageInput.usage_kind,
        parsed.policy.period_granularity,
        periodStart,
      ].join(':');
      const used = input.sellerStore.getUsageRollup({
        contract_id: usageInput.customer.contract_id,
        usage_kind: usageInput.usage_kind,
        period_granularity: parsed.policy.period_granularity,
        period_start: periodStart,
      })?.units ?? 0;
      const pending = pendingByKey.get(key) ?? 0;
      if (
        parsed.policy.period_limit !== null
        && used + pending + usageInput.units > parsed.policy.period_limit
      ) {
        const remaining = Math.max(parsed.policy.period_limit - used - pending, 0);
        return {
          admission: {
            admitted: false,
            reason: 'period_limit_exceeded',
            message:
              `${usageInput.usage_kind} usage limit exceeded: `
              + `${used + pending}/${parsed.policy.period_limit} used or reserved; `
              + `${usageInput.units} requested.`,
            usage_kind: usageInput.usage_kind,
            units: usageInput.units,
            period_granularity: parsed.policy.period_granularity,
            period_start: periodStart,
            period_limit: parsed.policy.period_limit,
            used: used + pending,
            remaining,
          },
        };
      }

      const { admission, reservation: rateReservation } =
        input.sellerUsageGate.reserveRate(usageInput);
      if (!admission.admitted) return { admission };
      const reservation: GatewayUsageReservation = {
        key,
        units: usageInput.units,
        admitted_at: admittedAt,
        input: usageInput,
        rate_reservation: rateReservation,
      };
      pendingByKey.set(key, pending + usageInput.units);
      live.add(reservation);
      return { admission, reservation };
    },
    commit(reservation: GatewayUsageReservation): void {
      try {
        input.sellerUsageGate.record({
          ...reservation.input,
          now: reservation.admitted_at,
        });
      } finally {
        if (reservation.rate_reservation) {
          input.sellerUsageGate.commitRate(reservation.rate_reservation, input.now());
        }
        releasePending(reservation);
      }
    },
    cancel(reservation: GatewayUsageReservation): void {
      if (!live.has(reservation)) return;
      if (reservation.rate_reservation) {
        input.sellerUsageGate.releaseRate(reservation.rate_reservation, input.now());
      }
      releasePending(reservation);
    },
  };
};

type GatewayUsageReservations = ReturnType<typeof createGatewayUsageReservations>;

const createGatewayToolUsageMeter = (input: {
  readonly reservations: GatewayUsageReservations;
  readonly seller: Extract<SellerCustomerAccessAdmissionResult, { applies: true; admitted: true }>;
  readonly now: () => number;
}): LlmGatewayToolUsageMeter => {
  const byCall = new WeakMap<object, GatewayUsageReservation>();
  return {
    admit(call) {
      const units = llmGatewayToolUnits(call.tool_name);
      if (units === 0) return { admitted: true };
      const { admission, reservation } = input.reservations.admit({
        customer: input.seller.customer,
        tier: input.seller.tier,
        usage_kind: 'tool_call',
        units,
        now: input.now(),
      });
      if (admission.admitted) {
        if (reservation) byCall.set(call, reservation);
        return { admitted: true };
      }
      return {
        admitted: false,
        result: {
          ok: false,
          reason: 'capacity_gap',
          detail: admission.message,
        },
      };
    },
    record(call) {
      const reservation = byCall.get(call);
      if (!reservation) return;
      byCall.delete(call);
      input.reservations.commit(reservation);
    },
    release(call) {
      const reservation = byCall.get(call);
      if (!reservation) return;
      byCall.delete(call);
      input.reservations.cancel(reservation);
    },
  };
};

export const createLlmGatewayPortHandler = (
  deps: LlmGatewayHandlerDeps,
) => {
  const now = deps.now ?? (() => Date.now());
  const sellerUsageGate = deps.sellerStore
    ? createSellerCustomerUsageGate({ sellerStore: deps.sellerStore, now })
    : null;
  const gatewayUsageReservations = sellerUsageGate && deps.sellerStore
      ? createGatewayUsageReservations({
        sellerUsageGate,
        sellerStore: deps.sellerStore,
        now,
      })
    : null;
  const maxBodyBytes = deps.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxPromptChars = normalizePositiveInt(
    deps.max_prompt_chars,
    DEFAULT_MAX_PROMPT_CHARS,
  );
  const maxInFlightGlobal = normalizePositiveInt(
    deps.max_in_flight_global,
    LLM_GATEWAY_MAX_IN_FLIGHT_GLOBAL,
  );
  let activeCompletions = 0;
  const activeCompletionsByToken = new Map<string, number>();

  /** Reserve one chat-completion slot before body intake. The verified token's
   *  authored tier is the per-token contract; the process ceiling prevents a
   *  collection of distinct customer tokens from exhausting the server. */
  const admitCompletion = (
    token: McpInboundTokenRecord,
    res: ServerResponse,
  ): (() => void) | null => {
    // Store decoding already validates the closed ladder. Treat an injected or
    // corrupt off-ladder record as one slot rather than widening authority.
    const tokenLimit = isMcpInboundConcurrencyTier(token.concurrency_tier)
      ? token.concurrency_tier
      : 1;
    const tokenActive = activeCompletionsByToken.get(token.token_id) ?? 0;
    if (activeCompletions >= maxInFlightGlobal || tokenActive >= tokenLimit) {
      writeOpenAiError(
        res,
        503,
        'llm_gateway_overloaded',
        'Too many llm_gateway completions are already running; retry shortly.',
        'server_error',
        { 'retry-after': '1' },
      );
      return null;
    }
    activeCompletions += 1;
    activeCompletionsByToken.set(token.token_id, tokenActive + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeCompletions -= 1;
      const remaining = (activeCompletionsByToken.get(token.token_id) ?? 1) - 1;
      if (remaining > 0) activeCompletionsByToken.set(token.token_id, remaining);
      else activeCompletionsByToken.delete(token.token_id);
    };
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = pathname(req);
    const method = req.method ?? 'GET';
    const current = now();

    const isModelsPath = path === '/v1/models' || path === '/llm-gateway/v1/models';
    const isCompletionsPath =
      path === '/v1/chat/completions'
      || path === '/llm-gateway/v1/chat/completions';

    if (!isModelsPath && !isCompletionsPath) {
      writeOpenAiError(
        res,
        404,
        'not_found',
        'No llm_gateway endpoint matched this path.',
        'invalid_request_error',
      );
      return;
    }

    if ((isModelsPath && method !== 'GET') || (isCompletionsPath && method !== 'POST')) {
      writeOpenAiError(
        res,
        405,
        'method_not_allowed',
        isModelsPath ? 'GET only on /v1/models.' : 'POST only on /v1/chat/completions.',
        'invalid_request_error',
        { allow: isModelsPath ? 'GET' : 'POST' },
      );
      return;
    }

    const initialAuth = authorize(req, deps, current);
    if (!initialAuth.ok) {
      writeOpenAiError(
        res,
        initialAuth.status,
        initialAuth.code,
        initialAuth.message,
        initialAuth.type,
      );
      return;
    }

    const initialRoute = loadConfigAndRoute(deps);
    if (!initialRoute.ok) {
      writeOpenAiError(
        res,
        initialRoute.status,
        initialRoute.code,
        initialRoute.message,
        'server_error',
      );
      return;
    }
    if (isModelsPath) {
      writeJson(res, 200, {
        object: 'list',
        data: [
          {
            id: initialRoute.alias,
            object: 'model',
            created: 0,
            owned_by: 'recued',
          },
        ],
      });
      return;
    }

    // D-196 §4.9 / I-7 — cheap fail-fast on the chat path (never on the
    // free-classified `/v1/models` discovery above): a paid seller turn without
    // the owner's route-rights acknowledgment stops here, before body intake or
    // any packing work. The act-site re-check below the final authorize is the
    // authoritative gate; this only spares wasted work.
    const initialPaidAckError = llmGatewayPaidAckError(deps, initialAuth.sellerAdmission);
    if (initialPaidAckError) {
      writeOpenAiError(
        res,
        initialPaidAckError.status,
        initialPaidAckError.code,
        initialPaidAckError.message,
        initialPaidAckError.type,
      );
      return;
    }

    const releaseCompletion = admitCompletion(initialAuth.token, res);
    if (!releaseCompletion) return;
    try {

    let body: unknown;
    try {
      body = await readJsonBody(req, maxBodyBytes);
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      const tooLarge = code === 'payload_too_large';
      const aborted = code === 'request_aborted';
      writeOpenAiError(
        res,
        tooLarge ? 413 : 400,
        tooLarge ? 'payload_too_large' : aborted ? 'request_aborted' : 'invalid_json',
        tooLarge
          ? 'request body too large.'
          : aborted
            ? 'request body was aborted before completion.'
            : 'request body must be valid JSON.',
        'invalid_request_error',
      );
      return;
    }

    const parsed = parseChatCompletionRequest(body);
    if (!parsed.ok) {
      writeOpenAiError(res, 400, 'bad_request', parsed.message, 'invalid_request_error');
      return;
    }

    // D-196 R4 — body intake is an unbounded await relative to authority
    // mutation. Re-read bearer/Seller/contract and route state after the final
    // byte, before catalog projection, preflight, usage admission, or provider
    // work. The initial checks above remain a cheap fail-fast only.
    const postBodyCurrent = now();
    const postBodyAuth = authorize(req, deps, postBodyCurrent);
    if (!postBodyAuth.ok) {
      writeOpenAiError(
        res,
        postBodyAuth.status,
        postBodyAuth.code,
        postBodyAuth.message,
        postBodyAuth.type,
      );
      return;
    }
    const route = loadConfigAndRoute(deps);
    if (!route.ok) {
      writeOpenAiError(res, route.status, route.code, route.message, 'server_error');
      return;
    }
    const contextBudget = resolveRouteContextBudget(route.route);
    if (!contextBudget.ok) {
      writeOpenAiError(
        res,
        503,
        contextBudget.code,
        contextBudget.message,
        'server_error',
      );
      return;
    }
    // Pin before preflight: pool routes retain their selected config entry, and
    // a settings manager may mutate that object in place. Recomputing the
    // "expected" key later would otherwise bless the mutation on both sides.
    const routeAuthorityKey = resolvedRouteAuthorityKey(route.route);
    const allowedToolNames = resolveAllowedToolNames(deps, postBodyAuth.token);
    const systemToolsAllowed = allowedToolNames.length > 0
      && resolveSystemToolsAllowed(deps, postBodyAuth.token, postBodyCurrent);
    // Resolve the composed prompt HERE, once. This is the only place
    // `systemToolsAllowed` is authoritative (it is re-derived after the
    // post-body reauthorization below, and the request is rejected if it moved),
    // and the only place both providers can be guaranteed the same prompt.
    //
    // The owner's caller-system policy decides whether the CALLER's own system
    // messages become instructions here (append/replace), stay contract-scoped
    // context (`context`, the default), or are dropped (`ignore`).
    const callerPolicy = resolveCallerSystemPolicy(route.config);
    const callerInstructions = callerSystemInstructions(parsed.value.messages);
    // Minted per request, and ONLY when the caller's text is actually going into
    // the prompt. A fixed sentinel is public (AGPL) — a hostile caller could
    // write the closing marker and continue in what looks like Recued's own
    // feature text. A random one cannot be guessed. The default path never mints
    // one, so its prompt stays byte-stable and provider-cacheable.
    const callerNonce =
      policyInjectsCallerInstructions(callerPolicy) && callerInstructions.length > 0
        ? randomUUID()
        : undefined;
    const resolvedSystemPrompt = resolveLlmSystemPrompt(
      'llm_gateway',
      route.config,
      {
        systemToolsAllowed,
        caller_instructions: callerInstructions,
        ...(callerNonce !== undefined ? { caller_nonce: callerNonce } : {}),
      },
    );
    const recuedSystemPrompt: LLMMessage = {
      role: resolvedSystemPrompt.role,
      content: resolvedSystemPrompt.prompt,
    };
    const gatewayMessagePlan = buildLlmGatewayMessages(
      parsed.value.messages,
      contextBudget.input_token_budget,
      maxPromptChars,
      recuedSystemPrompt,
    );
    if (!gatewayMessagePlan.ok) {
      writeOpenAiError(
        res,
        400,
        'context_length_exceeded',
        'The required llm_gateway context cannot fit within the selected model context window.',
        'invalid_request_error',
      );
      return;
    }
    const gatewayMessages = gatewayMessagePlan.messages;
    const contractId = postBodyAuth.token.contract_id!;
    const postBodyTokenAuthorityKey = tokenAuthorityKey(postBodyAuth.token);
    const postBodySellerAuthorityKey = sellerAuthorityKey(
      postBodyAuth.sellerAdmission,
    );
    let completionInput: LlmGatewayCompletionInput = {
      route: route.route,
      messages: gatewayMessages,
      system_prompt: recuedSystemPrompt.content,
      system_prompt_direct: resolvedSystemPrompt.prompt_direct,
      system_role: recuedSystemPrompt.role,
      emit_caller_application_instructions:
        policyEmitsApplicationInstructions(callerPolicy),
      requested_model: parsed.value.requested_model,
      model_alias: route.alias,
      config: route.config,
      now: postBodyCurrent,
      system_tools_allowed: systemToolsAllowed,
      token: postBodyAuth.token,
      contract_id: contractId,
      allowed_tool_names: allowedToolNames,
      input_token_budget: contextBudget.input_token_budget,
      resolve_contract_snapshot: createDispatchSnapshotResolver(
        req,
        deps,
        postBodyAuth.token.token_id,
        contractId,
        route.route,
        routeAuthorityKey,
        now,
      ),
    };

    // The shared provider adds Recued's system prompt, structured-output
    // framing, and contract catalog after parsing the OpenAI messages. Fit that
    // exact first packet before seller admission so a mandatory-context 400
    // consumes neither rollup units nor rate-bucket capacity.
    try {
      await deps.completionProvider.preflight?.(completionInput);
    } catch (e) {
      if (
        e instanceof ChatContextLengthError
        || (e instanceof LLMError && e.code === 'AI_TOKEN_BUDGET_EXCEEDED')
      ) {
        writeOpenAiError(
          res,
          400,
          'context_length_exceeded',
          e.message,
          'invalid_request_error',
        );
        return;
      }
      writeOpenAiError(
        res,
        502,
        'llm_gateway_provider_failed',
        e instanceof Error ? e.message : 'LLM gateway preflight failed.',
        'server_error',
      );
      return;
    }

    // Preflight may itself await substantial catalog/packing work. Close that
    // final race before reserving usage or entering the first real model call.
    const providerCurrent = now();
    const providerAuth = authorize(req, deps, providerCurrent);
    if (!providerAuth.ok) {
      writeOpenAiError(
        res,
        providerAuth.status,
        providerAuth.code,
        providerAuth.message,
        providerAuth.type,
      );
      return;
    }
    const providerAllowedToolNames = resolveAllowedToolNames(deps, providerAuth.token);
    const providerSystemToolsAllowed = providerAllowedToolNames.length > 0
      && resolveSystemToolsAllowed(deps, providerAuth.token, providerCurrent);
    if (
      tokenAuthorityKey(providerAuth.token) !== postBodyTokenAuthorityKey
      || sellerAuthorityKey(providerAuth.sellerAdmission) !== postBodySellerAuthorityKey
      || JSON.stringify(providerAllowedToolNames) !== JSON.stringify(allowedToolNames)
      || providerSystemToolsAllowed !== systemToolsAllowed
    ) {
      writeOpenAiError(
        res,
        403,
        'llm_gateway_authority_changed',
        'Bearer, Seller, contract, or callable-tool authority changed before provider work.',
        'permission_error',
      );
      return;
    }
    if (!isResolvedRouteStillAvailable(deps, route.route, routeAuthorityKey)) {
      writeOpenAiError(
        res,
        503,
        'llm_gateway_route_changed',
        'The configured llm_gateway route changed or became unavailable before provider work.',
        'server_error',
      );
      return;
    }
    completionInput = {
      ...completionInput,
      now: providerCurrent,
      token: providerAuth.token,
      assert_live_authority: createLiveProviderAuthorityAssertion({
        req,
        deps,
        token: providerAuth.token,
        sellerAdmission: providerAuth.sellerAdmission,
        route: route.route,
        routeAuthorityKey,
        allowedToolNames: providerAllowedToolNames,
        systemToolsAllowed: providerSystemToolsAllowed,
        now,
      }),
    };

    const admittedSeller =
      providerAuth.sellerAdmission.applies === true
      && providerAuth.sellerAdmission.admitted === true
        ? providerAuth.sellerAdmission
        : null;
    // D-196 §4.9 / I-7 — the authoritative monetization-boundary gate, at the
    // act site: re-derived on the fresh `providerAuth` after every other
    // authority re-check, immediately before `chat_turn` is reserved. A paid
    // seller turn without the owner's route-rights acknowledgment fails closed
    // here and consumes no usage. (The fail-fast above already caught the common
    // case; this closes the body-intake race and cannot be skipped.)
    const providerPaidAckError = llmGatewayPaidAckError(deps, providerAuth.sellerAdmission);
    if (providerPaidAckError) {
      writeOpenAiError(
        res,
        providerPaidAckError.status,
        providerPaidAckError.code,
        providerPaidAckError.message,
        providerPaidAckError.type,
      );
      return;
    }
    let chatTurnReservation: GatewayUsageReservation | undefined;
    if (admittedSeller && gatewayUsageReservations) {
      const { admission, reservation } = gatewayUsageReservations.admit({
        customer: admittedSeller.customer,
        tier: admittedSeller.tier,
        usage_kind: 'chat_turn',
        units: 1,
        now: providerCurrent,
      });
      if (!admission.admitted) {
        writeOpenAiError(
          res,
          429,
          admission.reason,
          admission.message,
          'rate_limit_error',
          admission.retry_after_ms !== undefined
            ? { 'retry-after-ms': String(admission.retry_after_ms) }
            : undefined,
        );
        return;
      }
      chatTurnReservation = reservation;
    }
    const gatewayToolUsage =
      admittedSeller && gatewayUsageReservations
        ? createGatewayToolUsageMeter({
            reservations: gatewayUsageReservations,
            seller: admittedSeller,
            now,
          })
        : undefined;

    let completion: LlmGatewayCompletionResult;
    try {
      completion = await deps.completionProvider.complete({
        ...completionInput,
        ...(gatewayToolUsage !== undefined
          ? { llm_gateway_tool_usage: gatewayToolUsage }
          : {}),
      });
    } catch (e) {
      if (chatTurnReservation && gatewayUsageReservations) {
        gatewayUsageReservations.cancel(chatTurnReservation);
      }
      if (
        e instanceof ChatContextLengthError
        || (e instanceof LLMError && e.code === 'AI_TOKEN_BUDGET_EXCEEDED')
      ) {
        writeOpenAiError(
          res,
          400,
          'context_length_exceeded',
          e.message,
          'invalid_request_error',
        );
        return;
      }
      if (e instanceof LlmGatewayLiveAuthorityError) {
        writeOpenAiError(res, e.status, e.public_code, e.message, e.type);
        return;
      }
      writeOpenAiError(
        res,
        502,
        'llm_gateway_provider_failed',
        e instanceof Error ? e.message : 'LLM gateway provider failed.',
        'server_error',
      );
      return;
    }

    if (chatTurnReservation && gatewayUsageReservations) {
      try {
        gatewayUsageReservations.commit(chatTurnReservation);
      } catch (e) {
        console.warn(
          `[llm_gateway] seller customer chat_turn rollup failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    const created = Math.floor(completionInput.now / 1000);
    writeJson(res, 200, {
      id: completion.id ?? `chatcmpl_${randomUUID().replace(/-/g, '')}`,
      object: 'chat.completion',
      created,
      model: route.alias,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: completion.content,
          },
          finish_reason: completion.finish_reason ?? 'stop',
        },
      ],
      usage: responseUsage(completion.usage),
      ...(completion.post_effect_outcome !== undefined
        ? { recued_outcome: completion.post_effect_outcome }
        : {}),
    });
    } finally {
      releaseCompletion();
    }
  };
};
