/** D-196 llm_gateway shared-turn carriers + gateway-only tool metering. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  type AIOutput,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ContractSnapshot,
  type ExecutionSource,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';
import { piiEgress, planApproval } from '@recued/gateway';
import { ESTIMATED_BYTES_PER_TOKEN, estimateConservativeMessagesTokens } from '@recued/llm';

import {
  createChatOrchestrator,
  type ExecuteChatAiCall,
  type LlmGatewayToolUsageMeter,
} from '../chat-orchestrator.js';
import {
  ChatContextLengthError,
  runChatTurn,
} from '../chat-turn-executor.js';
import {
  createChatStore,
  ensureChatSchema,
} from '../storage/chat-store.js';
import {
  RECALL_SEARCH_TOOL_ENTRY,
  RECALL_SEARCH_TOOL_NAME,
} from '../chat-recall-search-tool.js';

const SELF_SIGNATURE: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'd196-shared-turn-test',
};

const SOURCE: Extract<
  ExecutionSource,
  { channel: 'chat'; actor: 'contracted_user' }
> = {
  channel: 'chat',
  actor: 'contracted_user',
  chat_session_id: 'gateway-session',
  user_id: 'customer-token',
  contract_id: 'customer-contract',
  turn_id: 'gateway-turn',
};

const SNAPSHOT: ContractSnapshot = {
  contract_id: SOURCE.contract_id,
  contract_version: '1',
  allowed_tools: ['mail-search'],
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_000,
};

const readEntry = (name = 'mail.search', tier: 1 | 2 | 3 = 1): ToolEntry => ({
  name,
  tier,
  description: `read via ${name}`,
  arg_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      email: { type: 'string' },
      to: { type: 'string' },
    },
    additionalProperties: false,
  },
  topic_tags: ['read'],
  classification: 'read',
  concurrency_safe: true,
});

const WRITE_ENTRY: ToolEntry = {
  ...readEntry('seller/mail-send', 2),
  description: 'send mail',
  classification: 'write',
  concurrency_safe: false,
};

const createMeter = (
  admitted = true,
): LlmGatewayToolUsageMeter & {
  admit: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} => ({
  admit: vi.fn(async () => (
    admitted
      ? { admitted: true as const }
      : {
          admitted: false as const,
          result: {
            ok: false as const,
            reason: 'capacity_gap' as const,
            detail: 'customer tool limit reached',
          },
        }
  )),
  record: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
});

const createHarness = (input: {
  entries?: readonly ToolEntry[];
  localResult?: ChatDispatchResult;
  withPlanApproval?: boolean;
  executeAiCall?: ExecuteChatAiCall;
  piiResolver?: piiEgress.FieldPrivacyResolver;
} = {}) => {
  const entries = input.entries ?? [readEntry('seller/mail-search', 2)];
  const localDispatch = vi.fn<InternalToolRegistry['dispatch']>(async () => (
    input.localResult ?? { ok: true as const, result: { source: 'local' } }
  ));
  const registry: InternalToolRegistry = {
    list: () => entries,
    listByTier: (tier) => entries.filter((entry) => entry.tier === tier),
    getByName: (name) => entries.find((entry) => entry.name === name) ?? null,
    dispatch: localDispatch,
    subscribeRefresh: () => () => undefined,
  };

  const db = new Database(':memory:');
  ensureChatSchema(db);
  const orchestrator = createChatOrchestrator({
    chatStore: createChatStore(db),
    registry,
    selfSignature: SELF_SIGNATURE,
    ...(input.withPlanApproval
      ? { planApprovalStore: planApproval.createPlanApprovalStore() }
      : {}),
    now: () => 5_000,
    mintId: () => 'gateway-plan',
    ...(input.executeAiCall ? { executeAiCall: input.executeAiCall } : {}),
    ...(input.piiResolver
      ? {
          piiLedgerStore: piiEgress.createSessionLedgerStore(),
          fieldPrivacyResolver: input.piiResolver,
        }
      : {}),
  });

  return { orchestrator, localDispatch };
};

const gatewayDispatchArgs = (meter: LlmGatewayToolUsageMeter) => ({
  session_id: SOURCE.chat_session_id,
  turn_id: SOURCE.turn_id ?? 'gateway-turn',
  tool_name: 'seller/mail-search',
  arg_values: { query: 'invoice' },
  picker_target: 'self' as const,
  execution_source: SOURCE,
  contract_snapshot: SNAPSHOT,
  llm_gateway_tool_usage: meter,
});

/** Rescale a budget literal that was calibrated when the estimator returned one
 *  token per UTF-8 BYTE.
 *
 *  ⛔ THE FIXTURE CONTENT IS UNCHANGED, so what these numbers have to preserve
 *  is their RATIO to it — a budget just under an oversized turn, so eviction
 *  fires. Fixing the estimator's divisor changed the scale of one side only:
 *  at the raw literals the 12,000-char turn now costs 4,000 against an 8,000
 *  budget, fits, and the test stops exercising compaction while still looking
 *  like it does. Dividing by the same constant restores the ratio exactly, and
 *  keeps these tied to the estimator if it is ever refined again.
 *
 *  ⚠ A budget literal is only safe as a literal when it is DERIVED from
 *  measured content (see `baseTokens` below, and `MODEL_WINDOW_HISTORY_HEADROOM`
 *  in `ports-llm-gateway-handler.test.ts`). Prefer that for new fixtures. */
const BYTE_ERA = (literal: number): number =>
  Math.ceil(literal / ESTIMATED_BYTES_PER_TOKEN);

describe('D-196 llm_gateway shared-turn carriers', () => {
  it('runs the contracted gateway through the shared chat tool loop with a grant-filtered catalog', async () => {
    const grantedRecipe = 'seller/invoice-search';
    let aiRound = 0;
    const aiInputs: Record<string, unknown>[] = [];
    const executeAiCall: ExecuteChatAiCall = vi.fn(async (_manifest, input) => {
      aiInputs.push(input);
      const body: AIOutput = aiRound++ === 0
        ? {
            response: '',
            events: [],
            tool_calls: [{ tool: grantedRecipe, args: { query: 'invoice' } }],
          }
        : { response: 'found it', events: [], tool_calls: [] };
      return { body };
    });
    const h = createHarness({
      entries: [readEntry(grantedRecipe, 2), readEntry('seller/mail-send', 2)],
      executeAiCall,
    });
    const resolver = vi.fn(async () => ({ ...SNAPSHOT, resolved_at: 5_000 }));
    const meter = createMeter();

    const result = await h.orchestrator.runLlmGatewayTurn!({
      session_id: 'gateway-session',
      user_id: 'customer-token',
      contract_id: 'customer-contract',
      content: { chat_tail: [], user_message: 'find the invoice' },
      allowed_tool_names: [grantedRecipe],
      resolve_contract_snapshot: resolver,
      execute_ai_call: executeAiCall,
      model_layer: 'byok',
      model_hint: 'fast',
      model_source_id: 'slot_1',
      llm_gateway_tool_usage: meter,
    });

    expect(result.assistant_content).toBe('found it');
    expect(executeAiCall).toHaveBeenCalledTimes(2);
    const firstPrompt = JSON.parse(String(aiInputs[0]?.['llm.prompt'])) as {
      available_tools: Array<{
        recipe_slug: string;
        args_schema: Record<string, unknown>;
      }>;
    };
    expect(firstPrompt.available_tools.map((tool) => tool.recipe_slug))
      .toEqual([grantedRecipe]);
    expect(firstPrompt.available_tools[0]?.args_schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(h.localDispatch).toHaveBeenCalledTimes(1);
    expect(h.localDispatch.mock.calls[0]?.[2]).toMatchObject({
      execution_source: {
        channel: 'chat',
        actor: 'contracted_user',
        contract_id: 'customer-contract',
      },
      contract_snapshot: { contract_id: 'customer-contract', resolved_at: 5_000 },
    });
    expect(meter.admit).toHaveBeenCalledTimes(1);
    expect(meter.record).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['vault carrier', { query: 'invoice', vault: { token: 'caller-secret' } }, '$.vault'],
    ['execution context carrier', { query: 'invoice', execution_context: { actor: 'owner' } }, '$.execution_context'],
    ['normalized execution context carrier', { query: 'invoice', 'execution context': { actor: 'owner' } }, '$.execution context'],
    ['credential carrier', { query: 'invoice', nested: { credentials: { api_key: 'caller-key' } } }, '$.nested.credentials'],
    ['normalized API key carrier', { query: 'invoice', nested: { 'API-Key': 'caller-key' } }, '$.nested.API-Key'],
    ['unknown argument', { query: 'invoice', surprise: true }, 'args.surprise'],
    ['wrong argument type', { query: 42 }, 'args.query'],
  ])('rejects model-supplied %s before snapshot resolution or dispatch', async (
    _label,
    args,
    expectedDetail,
  ) => {
    const recipe = 'seller/invoice-search';
    const aiInputs: Record<string, unknown>[] = [];
    let aiRound = 0;
    const executeAiCall: ExecuteChatAiCall = vi.fn(async (_manifest, input) => {
      aiInputs.push(input);
      return {
        body: aiRound++ === 0
          ? {
              response: '',
              events: [],
              tool_calls: [{ tool: recipe, args }],
            }
          : { response: 'rejected safely', events: [], tool_calls: [] },
      };
    });
    const h = createHarness({ entries: [readEntry(recipe, 2)], executeAiCall });
    const resolver = vi.fn(async () => SNAPSHOT);

    const result = await h.orchestrator.runLlmGatewayTurn!({
      session_id: 'gateway-invalid-args',
      user_id: 'customer-token',
      contract_id: 'customer-contract',
      content: { chat_tail: [], user_message: 'find the invoice' },
      allowed_tool_names: [recipe],
      resolve_contract_snapshot: resolver,
      execute_ai_call: executeAiCall,
      model_layer: 'byok',
    });

    expect(result.assistant_content).toBe('rejected safely');
    expect(resolver).not.toHaveBeenCalled();
    expect(h.localDispatch).not.toHaveBeenCalled();
    expect(String(aiInputs[1]?.['llm.prompt'])).toContain('invalid_args');
    expect(String(aiInputs[1]?.['llm.prompt'])).toContain(expectedDetail);
  });

  it('omits a Tier-2 recipe whose schema declares a server-owned carrier', async () => {
    const recipe = 'seller/unsafe-context';
    const unsafeEntry: ToolEntry = {
      ...readEntry(recipe, 2),
      arg_schema: {
        type: 'object',
        properties: { context: { type: 'object', properties: {} } },
        additionalProperties: false,
      },
    };
    const aiInputs: Record<string, unknown>[] = [];
    const executeAiCall: ExecuteChatAiCall = vi.fn(async (_manifest, input) => {
      aiInputs.push(input);
      return { body: { response: 'safe', events: [], tool_calls: [] } };
    });
    const h = createHarness({ entries: [unsafeEntry], executeAiCall });

    await h.orchestrator.runLlmGatewayTurn!({
      session_id: 'gateway-unsafe-schema',
      user_id: 'customer-token',
      contract_id: 'customer-contract',
      content: { chat_tail: [], user_message: 'do not expose unsafe tools' },
      allowed_tool_names: [recipe],
      resolve_contract_snapshot: async () => SNAPSHOT,
      execute_ai_call: executeAiCall,
      model_layer: 'byok',
    });

    const firstPrompt = JSON.parse(String(aiInputs[0]?.['llm.prompt'])) as {
      available_tools: unknown[];
    };
    expect(firstPrompt.available_tools).toEqual([]);
  });

  it('counts each real model-emitted top-level recipe once', async () => {
    const recipes = ['seller/lookup-a', 'seller/lookup-b'];
    let aiRound = 0;
    const executeAiCall: ExecuteChatAiCall = vi.fn(async () => ({
      body: aiRound++ === 0
        ? {
            response: '',
            events: [],
            tool_calls: recipes.map((tool) => ({ tool, args: {} })),
          }
        : { response: 'done', events: [], tool_calls: [] },
    }));
    const h = createHarness({
      entries: recipes.map((name) => readEntry(name, 2)),
      executeAiCall,
    });
    const meter = createMeter();

    await h.orchestrator.runLlmGatewayTurn!({
      session_id: 'gateway-two-tools',
      user_id: 'customer-token',
      contract_id: 'customer-contract',
      content: { chat_tail: [], user_message: 'run both lookups' },
      allowed_tool_names: recipes,
      resolve_contract_snapshot: async () => SNAPSHOT,
      execute_ai_call: executeAiCall,
      model_layer: 'byok',
      llm_gateway_tool_usage: meter,
    });

    expect(h.localDispatch).toHaveBeenCalledTimes(2);
    expect(meter.admit).toHaveBeenCalledTimes(2);
    expect(meter.record).toHaveBeenCalledTimes(2);
    expect(meter.release).not.toHaveBeenCalled();
  });

  it('keeps owner-local Tier 1 handlers out of both the contract catalog and dispatch', async () => {
    const aiInputs: Record<string, unknown>[] = [];
    let aiRound = 0;
    const executeAiCall: ExecuteChatAiCall = vi.fn(async (_manifest, input) => {
      aiInputs.push(input);
      const body: AIOutput = aiRound++ === 0
        ? {
            response: '',
            events: [],
            tool_calls: [{ tool: 'mail.search', args: { query: 'owner mail' } }],
          }
        : { response: 'unavailable', events: [], tool_calls: [] };
      return { body };
    });
    const h = createHarness({ entries: [readEntry('mail.search', 1)], executeAiCall });
    const resolver = vi.fn(async () => SNAPSHOT);

    const result = await h.orchestrator.runLlmGatewayTurn!({
      session_id: 'gateway-session',
      user_id: 'customer-token',
      contract_id: 'customer-contract',
      content: { chat_tail: [], user_message: 'search the mail' },
      allowed_tool_names: ['mail.search'],
      resolve_contract_snapshot: resolver,
      execute_ai_call: executeAiCall,
      model_layer: 'byok',
    });

    const firstPrompt = JSON.parse(String(aiInputs[0]?.['llm.prompt'])) as {
      available_tools: unknown[];
    };
    expect(firstPrompt.available_tools).toEqual([]);
    expect(result.assistant_content).toBe('unavailable');
    expect(resolver).not.toHaveBeenCalled();
    expect(h.localDispatch).not.toHaveBeenCalled();
  });

  it('keeps the synthetic interaction-recall broker out of the stateless gateway even if named by the caller', async () => {
    const aiInputs: Record<string, unknown>[] = [];
    const executeAiCall: ExecuteChatAiCall = vi.fn(async (_manifest, input) => {
      aiInputs.push(input);
      return {
        body: { response: 'unavailable', events: [], tool_calls: [] },
      };
    });
    const h = createHarness({
      entries: [RECALL_SEARCH_TOOL_ENTRY],
      executeAiCall,
    });

    await h.orchestrator.runLlmGatewayTurn!({
      session_id: 'gateway-recall',
      user_id: 'customer-token',
      contract_id: 'customer-contract',
      content: { chat_tail: [], user_message: 'recall the owner history' },
      allowed_tool_names: [RECALL_SEARCH_TOOL_NAME],
      resolve_contract_snapshot: async () => SNAPSHOT,
      execute_ai_call: executeAiCall,
      model_layer: 'byok',
    });

    const firstPrompt = JSON.parse(String(aiInputs[0]?.['llm.prompt'])) as {
      available_tools: unknown[];
    };
    expect(firstPrompt.available_tools).toEqual([]);
    expect(h.localDispatch).not.toHaveBeenCalled();
  });

  it('uses chat PII alias and restore on every contracted gateway model round', async () => {
    const recipe = 'seller/contact-lookup';
    const egressPackets: Record<string, unknown>[] = [];
    let aiRound = 0;
    const resolver: piiEgress.FieldPrivacyResolver = (packet) => {
      const value = packet as Record<string, unknown>;
      const tags: Array<{ path: string; kind: 'email' }> = [];
      if (typeof value.user_message === 'string') {
        tags.push({ path: 'user_message', kind: 'email' });
      }
      if (Array.isArray(value.prior_tool_calls) && value.prior_tool_calls.length > 0) {
        tags.push({ path: 'prior_tool_calls.0.args.email', kind: 'email' });
        tags.push({ path: 'prior_tool_calls.0.result.email', kind: 'email' });
      }
      return tags;
    };
    const executeAiCall: ExecuteChatAiCall = vi.fn(async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>;
      egressPackets.push(packet);
      if (aiRound++ === 0) {
        return {
          body: {
            response: '',
            events: [],
            tool_calls: [{ tool: recipe, args: { email: packet.user_message } }],
          } satisfies AIOutput,
        };
      }
      const prior = packet.prior_tool_calls as Array<{ result?: { email?: string } }>;
      return {
        body: {
          response: `found ${String(prior[0]?.result?.email)}`,
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    });
    const h = createHarness({
      entries: [readEntry(recipe, 2)],
      localResult: { ok: true, result: { email: 'bob@acme.com' } },
      executeAiCall,
      piiResolver: resolver,
    });

    const result = await h.orchestrator.runLlmGatewayTurn!({
      session_id: 'gateway-pii-session',
      user_id: 'customer-token',
      contract_id: 'customer-contract',
      content: { chat_tail: [], user_message: 'alice@acme.com' },
      allowed_tool_names: [recipe],
      resolve_contract_snapshot: async () => SNAPSHOT,
      execute_ai_call: executeAiCall,
      model_layer: 'byok',
    });

    expect(String(egressPackets[0]?.user_message)).toMatch(/^m\d+@d\d+\.invalid$/);
    expect(h.localDispatch.mock.calls[0]?.[1]).toEqual({ email: 'alice@acme.com' });
    const prior = egressPackets[1]?.prior_tool_calls as Array<{
      result?: { email?: string };
    }>;
    expect(prior[0]?.result?.email).not.toBe('bob@acme.com');
    expect(result.assistant_content).toBe('found bob@acme.com');
  });

  it('checks the final aliased provider packet against the selected context window', async () => {
    let rawTokens = 0;
    const rawExecutor: ExecuteChatAiCall = vi.fn(async (_manifest, input) => {
      rawTokens = estimateConservativeMessagesTokens([
        { role: 'system', content: String(input['llm.system_prompt']) },
        { role: 'user', content: String(input['llm.prompt']) },
      ]);
      return {
        body: { response: 'done', events: [], tool_calls: [] } satisfies AIOutput,
      };
    });
    const common = {
      session_id: 'gateway-pii-budget',
      user_id: 'customer-token',
      contract_id: 'customer-contract',
      content: { chat_tail: [], user_message: 'a@b.co' },
      allowed_tool_names: [] as string[],
      resolve_contract_snapshot: async () => SNAPSHOT,
      model_layer: 'byok' as const,
    };
    const raw = createHarness({ entries: [], executeAiCall: rawExecutor });
    await raw.orchestrator.runLlmGatewayTurn!({
      ...common,
      execute_ai_call: rawExecutor,
    });
    expect(rawTokens).toBeGreaterThan(0);

    const provider = vi.fn<ExecuteChatAiCall>(async () => ({
      body: { response: 'must not run', events: [], tool_calls: [] },
    }));
    const aliased = createHarness({
      entries: [],
      executeAiCall: provider,
      piiResolver: () => [{ path: 'user_message', kind: 'email' }],
    });

    await expect(aliased.orchestrator.runLlmGatewayTurn!({
      ...common,
      execute_ai_call: provider,
      input_token_budget: rawTokens,
    })).rejects.toBeInstanceOf(ChatContextLengthError);
    expect(provider).not.toHaveBeenCalled();
  });

  it('threads contract_snapshot from runChatTurn to dispatchTool', async () => {
    const meter = createMeter();
    const dispatchTool = vi.fn(async (): Promise<ChatDispatchResult> => ({
      ok: true,
      result: { hits: [] },
    }));
    let aiRound = 0;
    const executeAiCall = vi.fn(async () => {
      const body: AIOutput = aiRound++ === 0
        ? {
            response: '',
            events: [],
            tool_calls: [{ tool: 'mail.search', args: { query: 'invoice' } }],
          }
        : { response: 'done', events: [], tool_calls: [] };
      return { body };
    });
    const entry = readEntry();
    const registry: InternalToolRegistry = {
      list: () => [entry],
      listByTier: () => [entry],
      getByName: (name) => name === entry.name ? entry : null,
      dispatch: async () => ({ ok: true, result: {} }),
      subscribeRefresh: () => () => undefined,
    };

    await runChatTurn(
      {
        session_id: SOURCE.chat_session_id,
        turn_id: SOURCE.turn_id ?? 'gateway-turn',
        picker_target: 'self',
        dispatch_peer_name: null,
        execution_source: SOURCE,
        contract_snapshot: SNAPSHOT,
        llm_gateway_tool_usage: meter,
        available_tools: [],
        content: { chat_tail: [], user_message: 'find the invoice' },
        correction_context: [],
        model_layer: 'byok',
      },
      {
        executeAiCall,
        registry,
        dispatchTool,
        emit: () => undefined,
        now: () => 1_000,
      },
    );

    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool).toHaveBeenCalledWith(expect.objectContaining({
      execution_source: SOURCE,
      contract_snapshot: SNAPSHOT,
      llm_gateway_tool_usage: meter,
    }));
  });

  it('re-packs caller history and growing tool results before every model round', async () => {
    const aiInputs: Record<string, unknown>[] = [];
    let aiRound = 0;
    const executeAiCall = vi.fn(async (_manifest, input: Record<string, unknown>) => {
      aiInputs.push(input);
      const body: AIOutput = aiRound++ === 0
        ? {
            response: '',
            events: [],
            tool_calls: [{ tool: 'mail.search', args: { query: 'invoice' } }],
          }
        : { response: 'done', events: [], tool_calls: [] };
      return { body };
    });
    const entry = readEntry();
    const registry: InternalToolRegistry = {
      list: () => [entry],
      listByTier: () => [entry],
      getByName: (name) => name === entry.name ? entry : null,
      dispatch: async () => ({ ok: true, result: {} }),
      subscribeRefresh: () => () => undefined,
    };

    await runChatTurn(
      {
        session_id: SOURCE.chat_session_id,
        turn_id: SOURCE.turn_id ?? 'gateway-turn',
        picker_target: 'self',
        dispatch_peer_name: null,
        available_tools: [{
          recipe_slug: 'mail.search',
          args_schema: entry.arg_schema,
        }],
        content: {
          chat_tail: [
            { role: 'user', content: `old:${'x'.repeat(12_000)}` },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'recent complete turn' },
            { role: 'assistant', content: 'recent answer' },
          ],
          user_message: 'current request',
        },
        correction_context: [],
        model_layer: 'byok',
        input_token_budget: BYTE_ERA(8_000),
      },
      {
        executeAiCall,
        registry,
        dispatchTool: async () => ({
          ok: true,
          result: { payload: 'y'.repeat(20_000) },
        }),
        emit: () => undefined,
        now: () => 1_000,
      },
    );

    expect(aiInputs).toHaveLength(2);
    for (const input of aiInputs) {
      const system = String(input['llm.system_prompt']);
      const prompt = String(input['llm.prompt']);
      expect(estimateConservativeMessagesTokens([
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ])).toBeLessThanOrEqual(8_000);
    }
    expect(String(aiInputs[0]?.['llm.prompt']))
      .toContain('[llm_gateway context notice]');
    // ⚠ CONTRACT NARROWED DELIBERATELY, not weakened to fit a change. The
    //   evicted row is `old:` + 12,000 chars, and this asserted that NONE of it
    //   reappears — a proxy for "the bulk is gone". The eviction notice is now
    //   a BRIEFING that quotes a bounded anchor (<=96 chars) of what it dropped,
    //   because a notice naming nothing is what let a live model report
    //   "I don't have access to any data source" while its own history had been
    //   evicted. So the property is restated as what it was standing for: no
    //   BULK survives. The size guarantee itself is asserted independently
    //   above (<= 8,000 tokens), so nothing rests on this proxy alone.
    // ⚠ The quote exposes nothing new — that text was in this same packet,
    //   for this same model, one composition earlier.
    expect(String(aiInputs[0]?.['llm.prompt']), 'the evicted bulk is gone')
      .not.toMatch(/x{200,}/u);
    expect(String(aiInputs[0]?.['llm.prompt']), 'only a bounded anchor survives')
      .toMatch(/old:x{1,120}…/u);
    expect(String(aiInputs[1]?.['llm.prompt']))
      .toContain('llm_gateway_context_omitted');
  });

  it('shrinks the newest tool-result preview to the actual remaining token budget', async () => {
    const entry = readEntry();
    const registry: InternalToolRegistry = {
      list: () => [entry],
      listByTier: () => [entry],
      getByName: (name) => name === entry.name ? entry : null,
      dispatch: async () => ({ ok: true, result: {} }),
      subscribeRefresh: () => () => undefined,
    };
    const baseInput = {
      session_id: 'gateway-adaptive-preview',
      turn_id: 'gateway-adaptive-preview-turn',
      picker_target: 'self' as const,
      dispatch_peer_name: null,
      available_tools: [{
        recipe_slug: entry.name,
        args_schema: entry.arg_schema,
      }],
      content: { chat_tail: [], user_message: 'find the invoice' },
      correction_context: [] as string[],
      model_layer: 'byok' as const,
    };
    let baseTokens = 0;
    await runChatTurn(baseInput, {
      executeAiCall: async (_manifest, input) => {
        baseTokens = estimateConservativeMessagesTokens([
          { role: 'system', content: String(input['llm.system_prompt']) },
          { role: 'user', content: String(input['llm.prompt']) },
        ]);
        return { body: { response: 'calibrated', events: [], tool_calls: [] } };
      },
      registry,
      dispatchTool: async () => ({ ok: true, result: {} }),
      emit: () => undefined,
      now: () => 1_000,
    });

    const budget = baseTokens + BYTE_ERA(400);
    const aiInputs: Record<string, unknown>[] = [];
    let aiRound = 0;
    await runChatTurn(
      { ...baseInput, input_token_budget: budget },
      {
        executeAiCall: async (_manifest, input) => {
          aiInputs.push(input);
          return {
            body: aiRound++ === 0
              ? {
                  response: '',
                  events: [],
                  tool_calls: [{ tool: entry.name, args: { query: 'invoice' } }],
                }
              : { response: 'done', events: [], tool_calls: [] },
          };
        },
        registry,
        dispatchTool: async () => ({
          ok: true,
          result: { payload: 'z'.repeat(20_000) },
        }),
        emit: () => undefined,
        now: () => 1_000,
      },
    );

    expect(aiInputs).toHaveLength(2);
    const secondPrompt = String(aiInputs[1]?.['llm.prompt']);
    const secondPacket = JSON.parse(secondPrompt) as {
      prior_tool_calls: Array<{
        args: { llm_gateway_context_omitted?: boolean; preview?: string };
        result: { llm_gateway_context_omitted?: boolean; preview?: string };
      }>;
    };
    expect(estimateConservativeMessagesTokens([
      { role: 'system', content: String(aiInputs[1]?.['llm.system_prompt']) },
      { role: 'user', content: secondPrompt },
    ])).toBeLessThanOrEqual(budget);
    expect(secondPacket.prior_tool_calls[0]?.result.llm_gateway_context_omitted)
      .toBe(true);
    expect(secondPacket.prior_tool_calls[0]?.result.preview?.length ?? 0)
      .toBeLessThan(2_048);
    expect(secondPacket.prior_tool_calls[0]?.args.llm_gateway_context_omitted)
      .toBe(true);
  });

  it.each([
    ['completed', { ok: true, result: { changed: true } } satisfies ChatDispatchResult],
    ['partial', {
      ok: true,
      result: { changed: true },
      run_failed: { detail: 'provider operation failed after starting' },
    } satisfies ChatDispatchResult],
    ['in_doubt', { ok: false, reason: 'execution_error' } satisfies ChatDispatchResult],
    ['in_doubt', {
      ok: false,
      reason: 'run_cancelled',
      detail: 'owner cancelled a possibly running operation',
    } satisfies ChatDispatchResult],
  ] as const)(
    'returns a non-retryable %s outcome when context fails after dispatch',
    async (expectedStatus, localResult) => {
      const recipe = 'seller/effect';
      let aiRound = 0;
      const executeAiCall: ExecuteChatAiCall = vi.fn(async () => {
        if (aiRound++ === 0) {
          return {
            body: {
              response: '',
              events: [],
              tool_calls: [{ tool: recipe, args: {} }],
            },
            usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
          };
        }
        throw new ChatContextLengthError();
      });
      const h = createHarness({
        entries: [readEntry(recipe, 2)],
        localResult,
        executeAiCall,
      });

      const result = await h.orchestrator.runLlmGatewayTurn!({
        session_id: `gateway-post-effect-${expectedStatus}`,
        user_id: 'customer-token',
        contract_id: 'customer-contract',
        content: { chat_tail: [], user_message: 'run the effect' },
        allowed_tool_names: [recipe],
        resolve_contract_snapshot: async () => SNAPSHOT,
        execute_ai_call: executeAiCall,
        model_layer: 'byok',
        input_token_budget: 100_000,
      });

      expect(result.post_effect_outcome).toEqual(expect.objectContaining({
        status: expectedStatus,
        error_code: 'context_length_exceeded',
        retryable: false,
        dispatched_tool_calls: 1,
      }));
      expect(result.usage).toEqual({
        input_tokens: 7,
        output_tokens: 3,
        total_tokens: 10,
        // ⚠ ONE, checked against the fixture: round 0 returns usage and round 1
        // THROWS `ChatContextLengthError`. A call that threw produced no usage
        // report, so it contributes neither tokens nor a count — the count and
        // the sums describe the same set of calls.
        provider_calls: 1,
      });
      expect(result.assistant_content).toContain('Do not retry automatically');
    },
  );

  it('returns a completed post-effect outcome when final provider synthesis fails', async () => {
    const recipe = 'seller/effect';
    let aiRound = 0;
    const executeAiCall: ExecuteChatAiCall = vi.fn(async () => {
      if (aiRound++ === 0) {
        return {
          body: {
            response: '',
            events: [],
            tool_calls: [{ tool: recipe, args: {} }],
          },
        };
      }
      throw new Error('provider unavailable');
    });
    const h = createHarness({ entries: [readEntry(recipe, 2)], executeAiCall });

    const result = await h.orchestrator.runLlmGatewayTurn!({
      session_id: 'gateway-post-effect-provider',
      user_id: 'customer-token',
      contract_id: 'customer-contract',
      content: { chat_tail: [], user_message: 'run the effect' },
      allowed_tool_names: [recipe],
      resolve_contract_snapshot: async () => SNAPSHOT,
      execute_ai_call: executeAiCall,
      model_layer: 'byok',
      input_token_budget: 100_000,
    });

    expect(result.post_effect_outcome).toEqual(expect.objectContaining({
      status: 'completed',
      error_code: 'llm_gateway_provider_failed',
      retryable: false,
    }));
  });

  it('preserves a truthful length completion when structured output is truncated', async () => {
    const registry: InternalToolRegistry = {
      list: () => [],
      listByTier: () => [],
      getByName: () => null,
      dispatch: async () => ({ ok: false, reason: 'unknown_tool' }),
      subscribeRefresh: () => () => undefined,
    };

    const result = await runChatTurn(
      {
        session_id: 'gateway-length',
        turn_id: 'gateway-length-turn',
        picker_target: 'self',
        dispatch_peer_name: null,
        available_tools: [],
        content: { chat_tail: [], user_message: 'write a long answer' },
        correction_context: [],
        model_layer: 'byok',
      },
      {
        executeAiCall: async () => ({
          body: '{"response":"truncated',
          finish_reason: 'length',
        }),
        registry,
        dispatchTool: async () => ({ ok: false, reason: 'unknown_tool' }),
        emit: () => undefined,
        now: () => 1_000,
      },
    );

    expect(result.assistant_content).toContain('reached its output limit');
    expect(result.final_ai_output).toEqual(expect.objectContaining({
      response: expect.stringContaining('output limit'),
      tool_calls: [],
    }));
  });

  it('places the contract snapshot on the internal registry context', async () => {
    const ctxs: ChatDispatchContext[] = [];
    const h = createHarness();
    h.localDispatch.mockImplementation(async (
      _name: string,
      _args: unknown,
      ctx: ChatDispatchContext,
    ) => {
      ctxs.push(ctx);
      return { ok: true, result: {} };
    });

    await h.orchestrator.dispatch.dispatchTool({
      ...gatewayDispatchArgs(createMeter()),
      llm_gateway_tool_usage: undefined,
    });

    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]).toMatchObject({
      channel: 'internal_function_call',
      execution_source: SOURCE,
      contract_snapshot: SNAPSHOT,
    });
  });
});

describe('D-196 gateway-only tool usage boundary', () => {
  it('does not count when the gateway meter is omitted', async () => {
    const meter = createMeter();
    const h = createHarness();

    const result = await h.orchestrator.dispatch.dispatchTool({
      ...gatewayDispatchArgs(meter),
      llm_gateway_tool_usage: undefined,
    });

    expect(result.ok).toBe(true);
    expect(h.localDispatch).toHaveBeenCalledTimes(1);
    expect(meter.admit).not.toHaveBeenCalled();
    expect(meter.record).not.toHaveBeenCalled();
    expect(meter.release).not.toHaveBeenCalled();
  });

  it('admits and records one successful local tool dispatch exactly once', async () => {
    const meter = createMeter();
    const h = createHarness();

    const result = await h.orchestrator.dispatch.dispatchTool(
      gatewayDispatchArgs(meter),
    );

    expect(result.ok).toBe(true);
    expect(h.localDispatch).toHaveBeenCalledTimes(1);
    expect(meter.admit).toHaveBeenCalledTimes(1);
    expect(meter.record).toHaveBeenCalledTimes(1);
    expect(meter.release).not.toHaveBeenCalled();
    expect(meter.record).toHaveBeenCalledWith(expect.objectContaining({
      tool_name: 'seller/mail-search',
      picker_target: 'self',
    }));
  });

  // ⛔ D-228 slice 5 — two peer-dispatch tests removed with their subject. They
  // asserted that a peer-routed tool was blocked before gateway usage admission,
  // and that an admitted reservation was released when the peer dispatcher threw.
  // Peer scoping is retired: `set_picker` refuses a peer target and
  // `PeerDispatcher` (which had zero implementors) is deleted, so neither
  // situation is reachable. The reservation-release property they shared with the
  // local path is still covered by the Self-dispatch tests above.

  it('returns a usage denial without dispatching or recording', async () => {
    const meter = createMeter(false);
    const h = createHarness();

    const result = await h.orchestrator.dispatch.dispatchTool(
      gatewayDispatchArgs(meter),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'capacity_gap',
      detail: 'customer tool limit reached',
    });
    expect(h.localDispatch).not.toHaveBeenCalled();
    expect(meter.admit).toHaveBeenCalledTimes(1);
    expect(meter.record).not.toHaveBeenCalled();
    expect(meter.release).not.toHaveBeenCalled();
  });

  it('does not meter a structurally mismatched contract authority', async () => {
    const meter = createMeter();
    const h = createHarness();

    const result = await h.orchestrator.dispatch.dispatchTool({
      ...gatewayDispatchArgs(meter),
      contract_snapshot: { ...SNAPSHOT, contract_id: 'other-contract' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('classification_blocked');
    expect(h.localDispatch).not.toHaveBeenCalled();
    expect(meter.admit).not.toHaveBeenCalled();
    expect(meter.record).not.toHaveBeenCalled();
    expect(meter.release).not.toHaveBeenCalled();
  });

  it('admits but does not record a failed actual dispatch', async () => {
    const meter = createMeter();
    const h = createHarness({
      localResult: { ok: false, reason: 'execution_error' },
    });

    const result = await h.orchestrator.dispatch.dispatchTool(
      gatewayDispatchArgs(meter),
    );

    expect(result).toEqual({ ok: false, reason: 'execution_error' });
    expect(h.localDispatch).toHaveBeenCalledTimes(1);
    expect(meter.admit).toHaveBeenCalledTimes(1);
    expect(meter.record).not.toHaveBeenCalled();
    expect(meter.release).toHaveBeenCalledTimes(1);
  });

  it('releases rather than records a recipe run held inside the shared engine', async () => {
    const meter = createMeter();
    const h = createHarness({
      localResult: {
        ok: true,
        result: { awaiting_approval: true },
        run_held: { kind: 'approval' },
      },
    });

    const result = await h.orchestrator.dispatch.dispatchTool(
      gatewayDispatchArgs(meter),
    );

    expect(result.ok).toBe(true);
    expect(h.localDispatch).toHaveBeenCalledTimes(1);
    expect(meter.admit).toHaveBeenCalledTimes(1);
    expect(meter.record).not.toHaveBeenCalled();
    expect(meter.release).toHaveBeenCalledTimes(1);
  });

  it('releases rather than records an ok-envelope recipe run_failed outcome', async () => {
    const meter = createMeter();
    const h = createHarness({
      localResult: {
        ok: true,
        result: { success: false, errors: [{ code: 'UPSTREAM_FAILED' }] },
        run_failed: { detail: 'provider operation failed after starting' },
      },
    });

    const result = await h.orchestrator.dispatch.dispatchTool(
      gatewayDispatchArgs(meter),
    );

    expect(result.ok).toBe(true);
    expect(h.localDispatch).toHaveBeenCalledTimes(1);
    expect(meter.admit).toHaveBeenCalledTimes(1);
    expect(meter.record).not.toHaveBeenCalled();
    expect(meter.release).toHaveBeenCalledTimes(1);
  });

  it('does not meter an approval-held write', async () => {
    const meter = createMeter();
    const h = createHarness({ entries: [WRITE_ENTRY], withPlanApproval: true });

    const result = await h.orchestrator.dispatch.dispatchTool({
      ...gatewayDispatchArgs(meter),
      tool_name: WRITE_ENTRY.name,
      arg_values: { to: 'buyer@example.com' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('awaiting_approval');
    expect(h.localDispatch).not.toHaveBeenCalled();
    expect(meter.admit).not.toHaveBeenCalled();
    expect(meter.record).not.toHaveBeenCalled();
    expect(meter.release).not.toHaveBeenCalled();
  });

  it('does not meter or dispatch an unknown tool', async () => {
    const meter = createMeter();
    const h = createHarness();

    const result = await h.orchestrator.dispatch.dispatchTool({
      ...gatewayDispatchArgs(meter),
      tool_name: 'unknown.tool',
    });

    expect(result).toEqual({ ok: false, reason: 'unknown_tool' });
    expect(h.localDispatch).not.toHaveBeenCalled();
    expect(meter.admit).not.toHaveBeenCalled();
    expect(meter.record).not.toHaveBeenCalled();
    expect(meter.release).not.toHaveBeenCalled();
  });
});
