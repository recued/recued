/** D-196 S2c — OpenAI-compatible llm_gateway door. */

import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type {
  McpInboundTokenRecord,
  IngredientManifest,
  RecipeDefinition,
  SellerCustomer,
  SellerSettings,
  SellerTier,
  ToolEntry,
} from '@recued/contracts';
import { LLM_GATEWAY_PAID_ACK_VERSION } from '@recued/contracts';
import {
  createQuotaTracker,
  estimateConservativeMessagesTokens,
  LLMError,
  type LLMConfig,
} from '@recued/llm';

import {
  createLlmGatewayDirectCompletionProvider,
  createLlmGatewayPortHandler,
  createLlmGatewaySharedChatCompletionProvider,
  listLlmGatewayCallableRecipeNames,
  resolveLlmGatewayRoute,
  type LlmGatewayCompletionProvider,
  type LlmGatewayHandlerDeps,
} from '../ports/llm-gateway/handler.js';
import { SERVER_LEGACY_PATH_ALIASES } from '../server.js';
import type { LlmGatewayTurnInput } from '../chat-orchestrator.js';
import { ChatContextLengthError } from '../chat-turn-executor.js';
import { resolveLlmSystemPrompt } from '../llm-system-prompt.js';

const NOW = 1_720_000_000_000;
const TOKEN_ID = 'inbound-token-1';
const CONTRACT_ID = 'ct_customer_1';

/** Recued's own gateway prompt, in the estimator's own units. The budget tests
 *  below size their caps against THIS rather than a literal, so a prompt reword
 *  cannot quietly turn a compaction test into an overflow test (or vice versa). */
const DEFAULT_LLM_GATEWAY_SYSTEM_PROMPT =
  resolveLlmSystemPrompt('llm_gateway', {}).prompt;

const GATEWAY_SYSTEM_PROMPT_TOKENS = estimateConservativeMessagesTokens([
  { role: 'system', content: DEFAULT_LLM_GATEWAY_SYSTEM_PROMPT },
]);

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body: string | null = null;

  setHeader(key: string, value: string): void {
    this.headers[key.toLowerCase()] = value;
  }

  getHeader(key: string): string | undefined {
    return this.headers[key.toLowerCase()];
  }

  end(body?: string): void {
    this.body = body ?? '';
  }
}

interface BuildReqOptions {
  readonly url?: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

const buildReq = ({
  url = '/v1/chat/completions',
  method = 'POST',
  headers = { authorization: 'Bearer bearer-1' },
  body = '',
}: BuildReqOptions = {}): IncomingMessage => {
  const stream = Readable.from([Buffer.from(body, 'utf8')]) as unknown as IncomingMessage;
  (stream as unknown as { url: string }).url = url;
  (stream as unknown as { method: string }).method = method;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  return stream;
};

const json = <T = Record<string, unknown>>(res: FakeRes): T =>
  JSON.parse(res.body ?? 'null') as T;

const makeToken = (
  overrides: Partial<McpInboundTokenRecord> = {},
): McpInboundTokenRecord => ({
  token_id: TOKEN_ID,
  bearer_hash: 'hash',
  label: 'External door',
  created_at: 1_000,
  expires_at: 0,
  revoked_at: null,
  grants: {},
  concurrency_tier: 3,
  chat_mode: null,
  contract_id: CONTRACT_ID,
  updated_at: 1_000,
  ...overrides,
});

const baseConfig = (
  overrides: Partial<LLMConfig> = {},
): LLMConfig => ({
  llm_gateway_default_route: 'slot:slot_1',
  llm_gateway_model_alias: 'seller-primary',
  slot_1: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    api_key: 'sk-test',
    speed: 'fast',
    supports_json: true,
    context_window_tokens: 128_000,
  },
  ...overrides,
});

const makeProvider = (
  impl?: LlmGatewayCompletionProvider['complete'],
): LlmGatewayCompletionProvider => ({
  complete: vi.fn(impl ?? (async () => ({
    id: 'chatcmpl_test',
    content: 'hello from seller model',
    usage: {
      prompt_tokens: 4,
      completion_tokens: 5,
      total_tokens: 9,
    },
  }))),
});

type ProviderInput = Parameters<LlmGatewayCompletionProvider['complete']>[0];

const firstProviderInput = (provider: LlmGatewayCompletionProvider): ProviderInput =>
  (provider.complete as unknown as { mock: { calls: Array<[ProviderInput]> } })
    .mock.calls[0]![0];

const makeDeps = (
  overrides: Partial<LlmGatewayHandlerDeps> & {
    readonly token?: McpInboundTokenRecord | null;
    readonly provider?: LlmGatewayCompletionProvider;
    readonly config?: LLMConfig | undefined;
  } = {},
): LlmGatewayHandlerDeps => {
  const provider = overrides.provider ?? makeProvider();
  const token = overrides.token ?? makeToken();
  return {
    inboundTokenStore: {
      verifyBearer: vi.fn(() => token),
    },
    contractOverlay: {
      isContractLive: vi.fn(() => true),
      permitsDoorType: vi.fn(() => true),
    },
    getLlmConfig: vi.fn(() => (
      'config' in overrides ? overrides.config : baseConfig()
    )),
    completionProvider: provider,
    now: () => NOW,
    ...overrides,
  };
};

const makeBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    model: 'client-requested-model-is-ignored',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  });

const makeSellerSettings = (
  overrides: Partial<SellerSettings> = {},
): SellerSettings => ({
  default_grace_hours: 72,
  sender_mail_instance_id: null,
  status_policy_json: {},
  email_policy_json: {},
  // D-196 §4.9 / I-7 — default to ACKNOWLEDGED so the existing paid-turn suite
  // exercises the metering path; the paid-ack gate's own tests override this.
  llm_gateway_paid_ack_at: 1_000,
  llm_gateway_paid_ack_version: LLM_GATEWAY_PAID_ACK_VERSION,
  created_at: 1_000,
  updated_at: 1_000,
  ...overrides,
});

const makeSellerTier = (
  overrides: Partial<SellerTier> = {},
): SellerTier => ({
  tier_id: 'tier_basic',
  door_id: 'door_llm',
  lifecycle_source: 'manual',
  entitlement_key: 'basic',
  display_name: 'Basic',
  template_contract_id: 'ct_template_basic',
  external_entitlement_id: null,
  usage_policy_json: {
    chat_turn: {
      period_granularity: 'day',
      period_limit: 5,
    },
  },
  pass_duration_seconds: null,
  customer_status_enabled_default: false,
  active: true,
  created_at: 1_000,
  updated_at: 1_000,
  ...overrides,
});

const makeSellerCustomer = (
  overrides: Partial<SellerCustomer> = {},
): SellerCustomer => ({
  customer_id: 'seller_customer_1',
  lifecycle_source: 'manual',
  source_customer_id: 'manual-customer-1',
  door_id: 'door_llm',
  email: 'buyer@example.com',
  tier_id: 'tier_basic',
  contract_id: CONTRACT_ID,
  inbound_token_id: TOKEN_ID,
  mcp_token_id: null,
  external_subscription_id: null,
  source_status: null,
  current_period_end: NOW + 60_000,
  grace_until: null,
  access_state: 'active',
  claim_email_sent_at: null,
  claim_email_marker: null,
  status_email_sent_at: null,
  status_email_marker: null,
  created_at: 1_000,
  updated_at: 1_000,
  ...overrides,
});

const makeSellerStore = (
  overrides: {
    readonly customer?: SellerCustomer;
    readonly customers?: SellerCustomer[];
    readonly tier?: SellerTier | null;
    readonly used?: number;
  } = {},
) => {
  const tier = overrides.tier === undefined ? makeSellerTier() : overrides.tier;
  return {
    getSettings: vi.fn(() => makeSellerSettings()),
    getTier: vi.fn(() => tier),
    listCustomers: vi.fn(({ contract_id }: { contract_id: string }) =>
      contract_id === CONTRACT_ID
        ? overrides.customers ?? [overrides.customer ?? makeSellerCustomer()]
        : []),
    getUsageRollup: vi.fn((input: {
      contract_id: string;
      usage_kind: 'tool_call' | 'chat_turn';
      period_granularity: 'day' | 'month';
      period_start: number;
    }) => (
      overrides.used === undefined
        ? null
        : {
            contract_id: input.contract_id,
            usage_kind: input.usage_kind,
            period_granularity: input.period_granularity,
            period_start: input.period_start,
            units: overrides.used,
            created_at: 1_000,
            updated_at: 1_000,
          }
    )),
    recordUsage: vi.fn((input: {
      contract_id: string;
      usage_kind: 'tool_call' | 'chat_turn';
      period_granularity: 'day' | 'month';
      period_start: number;
      units: number;
      now: number;
    }) => ({
      contract_id: input.contract_id,
      usage_kind: input.usage_kind,
      period_granularity: input.period_granularity,
      period_start: input.period_start,
      units: input.units,
      created_at: input.now,
      updated_at: input.now,
    })),
  };
};

describe('listLlmGatewayCallableRecipeNames', () => {
  it('shows only granted Tier-2 recipes whose concrete dependencies are authorized', () => {
    const entry = (name: string, tier: 1 | 2 = 2): ToolEntry => ({
      name,
      tier,
      description: `call ${name}`,
      arg_schema: { type: 'object', properties: {}, additionalProperties: false },
      classification: 'read',
      topic_tags: [],
      concurrency_safe: false,
    });
    const recipe = (body: Record<string, unknown>): RecipeDefinition => ({
      recipe_id: 'placeholder',
      version: 1,
      steps: [],
      ...body,
    } as unknown as RecipeDefinition);
    const recipes = new Map<string, RecipeDefinition>([
      ['ok', recipe({ steps: [{ id: 's', ingredient: 'mail-read', input: {} }] })],
      ['missing', recipe({ steps: [{ id: 's', ingredient: 'owner-only', input: {} }] })],
      ['dynamic', recipe({ steps: [{ id: 's', ingredient: '{{config.tool}}', input: {} }] })],
      ['op', recipe({ steps: [{ id: 's', op: 'core.crm.deal.search', input: {} }] })],
      ['cli', recipe({
        steps: [{
          id: 's',
          ingredient: 'document-cli',
          input: { operation: 'document.convert' },
        }],
      })],
      ['cli-wrong-op', recipe({
        steps: [{
          id: 's',
          ingredient: 'document-cli',
          input: { operation: 'document.delete' },
        }],
      })],
      ['cli-missing-op', recipe({
        steps: [{ id: 's', ingredient: 'document-cli', input: {} }],
      })],
    ]);
    const token = makeToken({
      grants: {
        'seller/ok': true,
        'seller/missing': true,
        'seller/dynamic': true,
        'seller/op': true,
        'seller/cli': true,
        'seller/cli-wrong-op': true,
        'seller/cli-missing-op': true,
        'mail.search': true,
        'recued_ingredient_mail-read': true,
      },
    });
    const isCliOperationReachable = vi.fn((slug: string, operationId: string) =>
      slug === 'document-cli' && operationId === 'document.convert');

    expect(listLlmGatewayCallableRecipeNames({
      entries: [
        entry('seller/ok'),
        entry('seller/missing'),
        entry('seller/dynamic'),
        entry('seller/op'),
        entry('seller/cli'),
        entry('seller/cli-wrong-op'),
        entry('seller/cli-missing-op'),
        entry('mail.search', 1),
      ],
      token,
      getRecipe: (id) => recipes.get(id),
      resolveIngredientKind: (slug) => slug === 'document-cli' ? 'cli' : 'other',
      isCliOperationReachable,
    })).toEqual(['seller/ok', 'seller/cli']);
    expect(isCliOperationReachable.mock.calls).toEqual([
      ['document-cli', 'document.convert'],
      ['document-cli', 'document.delete'],
    ]);
  });
});

describe('createLlmGatewayPortHandler', () => {
  it('serves GET /v1/models as a free classified authenticated read', async () => {
    const provider = makeProvider();
    const deps = makeDeps({ provider });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ url: '/v1/models', method: 'GET' }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(json<{ data: Array<{ id: string }> }>(res).data[0]?.id)
      .toBe('seller-primary');
    expect(deps.inboundTokenStore.verifyBearer).toHaveBeenCalledWith({
      bearer: 'bearer-1',
      now: NOW,
    });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('keeps model discovery available while completion context metadata needs setup', async () => {
    const provider = makeProvider();
    const config = baseConfig({
      slot_1: {
        ...baseConfig().slot_1!,
        context_window_tokens: undefined,
      },
    });
    const handler = createLlmGatewayPortHandler(makeDeps({ provider, config }));
    const res = new FakeRes();

    await handler(
      buildReq({ url: '/v1/models', method: 'GET' }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('returns an OpenAI chat completion and ignores request model for routing', async () => {
    const provider = makeProvider();
    const deps = makeDeps({ provider });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    const body = json<{
      model: string;
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    }>(res);
    expect(body.model).toBe('seller-primary');
    expect(body.choices[0]?.message.content).toBe('hello from seller model');
    expect(body.usage.total_tokens).toBe(9);
    expect(provider.complete).toHaveBeenCalledWith(expect.objectContaining({
      requested_model: 'client-requested-model-is-ignored',
      model_alias: 'seller-primary',
      route: expect.objectContaining({
        kind: 'slot',
        source_id: 'slot_1',
      }),
    }));
    const providerInput = firstProviderInput(provider);
    expect(providerInput.system_tools_allowed).toBe(false);
    // Recued's prompt rides its own field — NOT `messages`. Everything in
    // `messages` is the caller's, because the shared provider reads every
    // `system` entry there as a customer application instruction.
    expect(providerInput.system_role).toBe('system');
    expect(providerInput.system_prompt)
      .toContain('external contract-bound caller');
    expect(providerInput.system_prompt).toContain('memory.write');
    expect(providerInput.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('reauthorizes after a slow request body before any preflight or provider work', async () => {
    const token = makeToken();
    let liveToken: McpInboundTokenRecord | null = token;
    const provider: LlmGatewayCompletionProvider = {
      preflight: vi.fn(async () => undefined),
      complete: vi.fn(async () => ({ content: 'must not run' })),
    };
    const deps = makeDeps({
      provider,
      inboundTokenStore: {
        verifyBearer: vi.fn(() => liveToken),
      },
    });
    const handler = createLlmGatewayPortHandler(deps);
    const req = new PassThrough() as unknown as IncomingMessage;
    (req as unknown as { url: string }).url = '/v1/chat/completions';
    (req as unknown as { method: string }).method = 'POST';
    (req as unknown as { headers: Record<string, string> }).headers = {
      authorization: 'Bearer bearer-1',
    };
    const res = new FakeRes();
    const requestBody = makeBody();

    const pending = handler(req, res as unknown as ServerResponse);
    (req as unknown as PassThrough).write(requestBody.slice(0, 12));
    liveToken = null;
    (req as unknown as PassThrough).end(requestBody.slice(12));
    await pending;

    expect(res.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('invalid_bearer');
    expect(deps.inboundTokenStore.verifyBearer).toHaveBeenCalledTimes(2);
    expect(provider.preflight).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('re-resolves the configured route after a slow request body', async () => {
    let config = baseConfig();
    const provider = makeProvider();
    const deps = makeDeps({
      provider,
      getLlmConfig: vi.fn(() => config),
    });
    const handler = createLlmGatewayPortHandler(deps);
    const req = new PassThrough() as unknown as IncomingMessage;
    (req as unknown as { url: string }).url = '/v1/chat/completions';
    (req as unknown as { method: string }).method = 'POST';
    (req as unknown as { headers: Record<string, string> }).headers = {
      authorization: 'Bearer bearer-1',
    };
    const res = new FakeRes();
    const requestBody = makeBody();

    const pending = handler(req, res as unknown as ServerResponse);
    (req as unknown as PassThrough).write(requestBody.slice(0, 12));
    config = baseConfig({ llm_gateway_default_route: 'slot:slot_2' });
    (req as unknown as PassThrough).end(requestBody.slice(12));
    await pending;

    expect(res.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('llm_gateway_route_unavailable');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('detects an in-place selected pool-entry mutation during preflight', async () => {
    const poolEntry = {
      id: 'pool-a',
      type: 'api' as const,
      provider: 'openai-compatible' as const,
      model: 'pool-model',
      api_key: 'pool-key',
      speed: 'fast' as const,
      supports_json: true,
      enabled: true,
      context_window_tokens: 32_768,
    };
    const config = baseConfig({
      llm_gateway_default_route: 'pool',
      slot_1: undefined,
      free_pool: [poolEntry],
    });
    const provider: LlmGatewayCompletionProvider = {
      preflight: vi.fn(async () => {
        poolEntry.model = 'mutated-model';
      }),
      complete: vi.fn(async () => ({ content: 'must not run' })),
    };
    const handler = createLlmGatewayPortHandler(makeDeps({ provider, config }));
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('llm_gateway_route_changed');
    expect(provider.preflight).toHaveBeenCalledTimes(1);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('reauthorizes again after an awaited preflight before reserving usage', async () => {
    const token = makeToken();
    let liveToken: McpInboundTokenRecord | null = token;
    const sellerStore = makeSellerStore();
    const provider: LlmGatewayCompletionProvider = {
      preflight: vi.fn(async () => {
        liveToken = null;
      }),
      complete: vi.fn(async () => ({ content: 'must not run' })),
    };
    const deps = makeDeps({
      provider,
      sellerStore,
      inboundTokenStore: {
        verifyBearer: vi.fn(() => liveToken),
      },
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('invalid_bearer');
    expect(provider.preflight).toHaveBeenCalledTimes(1);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(sellerStore.getUsageRollup).not.toHaveBeenCalled();
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });

  it('rejects an in-place token contract re-home during preflight', async () => {
    const token = makeToken({ grants: { 'seller/recipe': true } });
    const provider: LlmGatewayCompletionProvider = {
      preflight: vi.fn(async () => {
        token.contract_id = 'ct_attacker_rehome';
      }),
      complete: vi.fn(async () => ({ content: 'must not run' })),
    };
    const deps = makeDeps({ provider, token });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('llm_gateway_authority_changed');
    expect(provider.preflight).toHaveBeenCalledTimes(1);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('runs a live-authority assertion immediately before a direct provider call', async () => {
    const token = makeToken();
    let authChecks = 0;
    const adapterComplete = vi.fn(async () => ({
      text: 'must not run',
      finish_reason: 'stop' as const,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }));
    const provider = createLlmGatewayDirectCompletionProvider({
      adapters: () => ({ provider: 'openai', complete: adapterComplete }),
    });
    const deps = makeDeps({
      provider,
      inboundTokenStore: {
        verifyBearer: vi.fn(() => (++authChecks < 4 ? token : null)),
      },
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('invalid_bearer');
    expect(authChecks).toBe(4);
    expect(adapterComplete).not.toHaveBeenCalled();
  });

  it('denies a tool snapshot when the exact configured route changes at dispatch time', async () => {
    let config = baseConfig();
    const provider = makeProvider(async (input) => {
      config = baseConfig({ llm_gateway_default_route: 'slot:slot_2' });
      expect(await input.resolve_contract_snapshot({
        tool_name: 'business.tool',
        arg_values: {},
      })).toBeNull();
      return { content: 'dispatch denied safely' };
    });
    const deps = makeDeps({
      provider,
      config,
      getLlmConfig: vi.fn(() => config),
      token: makeToken({ grants: { 'business.tool': true } }),
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('revalidates the presented bearer at tool dispatch after a bearer reissue', async () => {
    const token = makeToken({ grants: { 'business.tool': true } });
    let presentedBearerValid = true;
    const provider = makeProvider(async (input) => {
      await input.assert_live_authority?.();
      // Simulate a bearer-only reissue between the provider round and its
      // model-emitted tool dispatch. The token id still resolves to a live row,
      // but this request's old bearer must no longer inherit that row.
      presentedBearerValid = false;
      expect(await input.resolve_contract_snapshot({
        tool_name: 'business.tool',
        arg_values: {},
      })).toBeNull();
      return { content: 'dispatch denied safely' };
    });
    const getTokenById = vi.fn(() => token);
    const inboundTokenStore = {
      verifyBearer: vi.fn(() => presentedBearerValid ? token : null),
      // Deliberately remains live: the regression is trusting this row after
      // the presented bearer itself stopped verifying.
      getTokenById,
    };
    const deps = makeDeps({
      provider,
      token,
      inboundTokenStore,
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(getTokenById).not.toHaveBeenCalled();
  });

  it('returns the typed non-retryable post-effect outcome as a namespaced extension', async () => {
    const provider = makeProvider(async () => ({
      content: 'Tool work completed, but final synthesis failed.',
      post_effect_outcome: {
        status: 'completed',
        error_code: 'llm_gateway_provider_failed',
        message: 'Tool work completed, but final synthesis failed.',
        retryable: false,
        dispatched_tool_calls: 1,
      },
    }));
    const handler = createLlmGatewayPortHandler(makeDeps({ provider }));
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(json<{ recued_outcome: Record<string, unknown> }>(res).recued_outcome)
      .toEqual(expect.objectContaining({
        status: 'completed',
        retryable: false,
        dispatched_tool_calls: 1,
      }));
  });

  it('returns finish_reason length when the provider exhausts output capacity', async () => {
    const provider = makeProvider(async () => ({
      content: 'partial answer',
      finish_reason: 'length',
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
    const deps = makeDeps({ provider });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(json<{ choices: Array<{ finish_reason: string }> }>(res).choices[0]?.finish_reason)
      .toBe('length');
  });

  it('marks owner system tools available only from an explicit contract gate', async () => {
    const provider = makeProvider();
    const systemToolsAllowed = vi.fn(() => true);
    const deps = makeDeps({
      provider,
      systemToolsAllowed,
      token: makeToken({ grants: { 'seller/recipe': true } }),
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(systemToolsAllowed).toHaveBeenCalledWith(expect.objectContaining({
      contract_id: CONTRACT_ID,
      now: NOW,
    }));
    const providerInput = firstProviderInput(provider);
    expect(providerInput.system_tools_allowed).toBe(true);
    expect(providerInput.system_prompt)
      .toContain('runtime explicitly supplies them for this contract');
  });

  it('compacts old gateway messages before provider call while preserving the latest user turn', async () => {
    const provider = makeProvider();
    const deps = makeDeps({
      provider,
      // Leave the caller ~400 chars after Recued's own prompt — the same
      // headroom this test has always had. DERIVED from the constant, not a
      // literal: a reworded prompt would otherwise either blow the mandatory
      // set (400) or hand the caller so much room that nothing compacts and the
      // test passes vacuously.
      max_prompt_chars: DEFAULT_LLM_GATEWAY_SYSTEM_PROMPT.length + 400,
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();
    const oldTurns = Array.from({ length: 8 }, (_, i) => ([
      {
        role: 'user',
        content: `old-${i} ${'u'.repeat(90)}`,
      },
      {
        role: 'assistant',
        content: `old-assistant-${i} ${'a'.repeat(90)}`,
      },
    ])).flat();

    await handler(
      buildReq({
        body: makeBody({
          messages: [
            { role: 'system', content: 'client application instruction' },
            ...oldTurns,
            { role: 'user', content: 'latest question' },
          ],
        }),
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    const providerInput = firstProviderInput(provider);
    const joined = providerInput.messages.map((message) => message.content).join('\n');
    // The posture is on its own field; compaction still counts its tokens
    // against the budget, it just no longer rides in the caller's array.
    expect(providerInput.system_prompt)
      .toContain('external contract-bound caller');
    expect(joined).not.toContain('external contract-bound caller');
    expect(joined).toContain('Older conversation messages were omitted');
    expect(joined).toContain('client application instruction');
    expect(joined).not.toContain('old-0');
    expect(providerInput.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'latest question',
    });
  });

  it('uses the selected model context window, not only the legacy character cap', async () => {
    const provider = makeProvider();
    const config = baseConfig({
      slot_1: {
        ...baseConfig().slot_1!,
        // The input budget is `ctx − reserved output (4,000 for the fast hint)
        // − safety margin`. Size the window so ~1,900 input tokens survive
        // Recued's own prompt: enough for several of the 330-token history
        // groups but not all eight, so compaction MUST run. Derived from the
        // prompt for the same reason as the char cap above — at the old literal
        // 6,000 the budget is 1,744 and the prompt alone is 1,735, so the test
        // would silently stop testing compaction and start testing overflow.
        context_window_tokens:
          GATEWAY_SYSTEM_PROMPT_TOKENS + 4_000 + 256 + 1_900,
      },
    });
    const deps = makeDeps({ provider, config });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();
    const oldTurns = Array.from({ length: 8 }, (_, i) => ([
      { role: 'user', content: `model-window-user-${i} ${'u'.repeat(120)}` },
      { role: 'assistant', content: `model-window-assistant-${i} ${'a'.repeat(120)}` },
    ])).flat();

    await handler(
      buildReq({
        body: makeBody({
          messages: [
            { role: 'system', content: 'caller system remains mandatory' },
            ...oldTurns,
            { role: 'user', content: 'latest model-window question' },
          ],
        }),
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    const messages = firstProviderInput(provider).messages;
    const joined = messages.map((message) => message.content).join('\n');
    expect(joined).toContain('Older conversation messages were omitted');
    expect(joined).toContain('caller system remains mandatory');
    expect(joined).toContain('latest model-window question');
    expect(joined).not.toContain('model-window-user-0');
    // Whole user/assistant groups are retained or omitted together.
    for (let i = 0; i < 8; i++) {
      expect(joined.includes(`model-window-user-${i}`))
        .toBe(joined.includes(`model-window-assistant-${i}`));
    }
  });

  it('fails closed when the selected route lacks context-window metadata', async () => {
    const provider = makeProvider();
    const config = baseConfig({
      slot_1: {
        ...baseConfig().slot_1!,
        context_window_tokens: undefined,
      },
    });
    const deps = makeDeps({ provider, config });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('llm_gateway_context_window_not_configured');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('fails closed when output and safety reserves leave no input capacity', async () => {
    const provider = makeProvider();
    const config = baseConfig({
      slot_1: {
        ...baseConfig().slot_1!,
        context_window_tokens: 4_256,
      },
    });
    const deps = makeDeps({ provider, config });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('llm_gateway_context_window_invalid');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('rejects mandatory context before seller usage admission or provider work', async () => {
    const sellerStore = makeSellerStore();
    const provider = makeProvider();
    const config = baseConfig({
      slot_1: {
        ...baseConfig().slot_1!,
        context_window_tokens: 5_500,
      },
    });
    const deps = makeDeps({ provider, config, sellerStore });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({
        body: makeBody({
          messages: [
            { role: 'system', content: `mandatory ${'👩‍💻'.repeat(300)}` },
            { role: 'user', content: 'latest question must also remain' },
          ],
        }),
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('context_length_exceeded');
    expect(sellerStore.getUsageRollup).not.toHaveBeenCalled();
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('preflights shared chat framing before seller rate admission', async () => {
    const sellerStore = makeSellerStore({
      tier: makeSellerTier({
        usage_policy_json: {
          chat_turn: {
            period_granularity: 'day',
            period_limit: 5,
            rate_limit_per_minute: 1,
          },
        },
      }),
    });
    const provider: LlmGatewayCompletionProvider = {
      preflight: vi.fn(async () => {
        throw new ChatContextLengthError();
      }),
      complete: vi.fn(async () => ({ content: 'must not run' })),
    };
    const handler = createLlmGatewayPortHandler(makeDeps({ provider, sellerStore }));
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('context_length_exceeded');
    expect(provider.preflight).toHaveBeenCalledTimes(1);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(sellerStore.getUsageRollup).not.toHaveBeenCalled();
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });

  it('uses the selected pool entry context metadata', async () => {
    const provider = makeProvider();
    const config = baseConfig({
      llm_gateway_default_route: 'pool',
      slot_1: undefined,
      free_pool: [{
        id: 'pool-a',
        type: 'api',
        provider: 'openai-compatible',
        model: 'pool-model',
        api_key: 'pool-key',
        speed: 'fast',
        supports_json: true,
        enabled: true,
        context_window_tokens: 32_768,
      }],
    });
    const deps = makeDeps({ provider, config });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(firstProviderInput(provider).route.slot.context_window_tokens).toBe(32_768);
  });

  it('fails closed when llm_gateway_default_route is missing before auth or provider work', async () => {
    const provider = makeProvider();
    const deps = makeDeps({
      provider,
      config: {
        ...baseConfig(),
        llm_gateway_default_route: undefined,
      } as unknown as LLMConfig,
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('llm_gateway_route_not_configured');
    expect(deps.inboundTokenStore.verifyBearer).toHaveBeenCalledWith({
      bearer: 'bearer-1',
      now: NOW,
    });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('denies tokens whose live contract does not permit the llm_gateway door', async () => {
    const provider = makeProvider();
    const deps = makeDeps({
      provider,
      contractOverlay: {
        isContractLive: vi.fn(() => true),
        permitsDoorType: vi.fn(() => false),
      },
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('llm_gateway_door_not_permitted');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('denies a classified customer instance when Seller storage is missing before provider work', async () => {
    const provider: LlmGatewayCompletionProvider = {
      preflight: vi.fn(async () => undefined),
      complete: vi.fn(async () => ({ content: 'must not run' })),
    };
    const deps = makeDeps({
      provider,
      contractOverlay: {
        isContractLive: vi.fn(() => true),
        permitsDoorType: vi.fn(() => true),
        resolveBoundContractKind: vi.fn(() => 'customer_instance' as const),
      },
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('seller_customer_customer_missing');
    expect(provider.preflight).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('denies a classified customer instance with no exact Seller row before provider or usage work', async () => {
    const sellerStore = makeSellerStore({ customers: [] });
    const provider: LlmGatewayCompletionProvider = {
      preflight: vi.fn(async () => undefined),
      complete: vi.fn(async () => ({ content: 'must not run' })),
    };
    const deps = makeDeps({
      provider,
      sellerStore,
      contractOverlay: {
        isContractLive: vi.fn(() => true),
        permitsDoorType: vi.fn(() => true),
        resolveBoundContractKind: vi.fn(() => 'customer_instance' as const),
      },
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('seller_customer_customer_missing');
    expect(sellerStore.listCustomers).toHaveBeenCalledWith({ contract_id: CONTRACT_ID });
    expect(sellerStore.getUsageRollup).not.toHaveBeenCalled();
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
    expect(provider.preflight).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('rechecks customer-instance pairing at a later tool dispatch after the Seller row is removed', async () => {
    const customer = makeSellerCustomer();
    const sellerStore = makeSellerStore({ customers: [customer] });
    vi.mocked(sellerStore.listCustomers)
      .mockReturnValueOnce([customer])
      .mockReturnValueOnce([customer])
      .mockReturnValueOnce([customer])
      .mockReturnValueOnce([customer])
      .mockReturnValue([]);
    const toolDispatch = vi.fn(async () => undefined);
    const provider = makeProvider(async (input) => {
      await input.assert_live_authority?.();
      const snapshot = await input.resolve_contract_snapshot({
        tool_name: 'business.tool',
        arg_values: {},
      });
      if (snapshot !== null) {
        await toolDispatch();
        return { content: 'unexpected dispatch' };
      }
      throw new Error('fresh customer pairing denied');
    });
    const resolveBoundContractKind = vi.fn(() => 'customer_instance' as const);
    const handler = createLlmGatewayPortHandler(makeDeps({
      provider,
      sellerStore,
      token: makeToken({ grants: { 'business.tool': true } }),
      contractOverlay: {
        isContractLive: vi.fn(() => true),
        permitsDoorType: vi.fn(() => true),
        resolveBoundContractKind,
      },
    }));
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(502);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('llm_gateway_provider_failed');
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(resolveBoundContractKind).toHaveBeenCalledTimes(5);
    expect(sellerStore.listCustomers).toHaveBeenCalledTimes(5);
    expect(toolDispatch).not.toHaveBeenCalled();
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });

  it('records one seller chat_turn only after a successful completion', async () => {
    const sellerStore = makeSellerStore();
    const provider = makeProvider();
    const deps = makeDeps({
      provider,
      sellerStore,
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(sellerStore.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      contract_id: CONTRACT_ID,
      usage_kind: 'chat_turn',
      units: 1,
      now: NOW,
    }));
  });

  // D-196 §4.9 / I-7 — the paid-gateway route-rights acknowledgment gate. A paid
  // (seller-customer) chat turn is the monetization boundary; it must fail closed
  // until the owner acknowledges, and consume nothing when it does.
  it('D-196 I-7: denies a paid seller chat turn until the owner acknowledges, metering nothing', async () => {
    const sellerStore = makeSellerStore();
    sellerStore.getSettings = vi.fn(() => makeSellerSettings({
      llm_gateway_paid_ack_at: null,
      llm_gateway_paid_ack_version: null,
    }));
    const provider = makeProvider();
    const deps = makeDeps({ provider, sellerStore });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('llm_gateway_paid_unacknowledged');
    // No model call, no chat_turn: the gate is before the metering boundary.
    expect(provider.complete).not.toHaveBeenCalled();
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });

  it('D-196 I-7: a stale-version acknowledgment does not satisfy the current terms', async () => {
    const sellerStore = makeSellerStore();
    sellerStore.getSettings = vi.fn(() => makeSellerSettings({
      llm_gateway_paid_ack_at: 1_000,
      llm_gateway_paid_ack_version: 'route-rights-v0-superseded',
    }));
    const provider = makeProvider();
    const deps = makeDeps({ provider, sellerStore });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('llm_gateway_paid_unacknowledged');
    expect(provider.complete).not.toHaveBeenCalled();
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });

  it('D-196 I-6: a free/standing llm_gateway turn is never gated by the paid acknowledgment', async () => {
    // A standing (non-seller) contract resolves `applies: false` — no seller
    // pairing, no metering — so the paid-ack gate does not apply even with an
    // unacknowledged settings row present.
    const sellerStore = makeSellerStore();
    sellerStore.getSettings = vi.fn(() => makeSellerSettings({
      llm_gateway_paid_ack_at: null,
      llm_gateway_paid_ack_version: null,
    }));
    const provider = makeProvider();
    const deps = makeDeps({
      provider,
      sellerStore,
      contractOverlay: {
        isContractLive: vi.fn(() => true),
        permitsDoorType: vi.fn(() => true),
        resolveBoundContractKind: vi.fn((): 'standing' => 'standing'),
      },
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(provider.complete).toHaveBeenCalledTimes(1);
    // Standing contract => no seller usage recorded at all.
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });

  it('D-196 §4.9: /v1/models discovery stays free for a paid seller even without the acknowledgment', async () => {
    const sellerStore = makeSellerStore();
    sellerStore.getSettings = vi.fn(() => makeSellerSettings({
      llm_gateway_paid_ack_at: null,
      llm_gateway_paid_ack_version: null,
    }));
    const deps = makeDeps({ sellerStore });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ url: '/v1/models', method: 'GET' }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(json<{ object: string }>(res).object).toBe('list');
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });

  it('reserves the seller period unit across concurrent gateway completions', async () => {
    const sellerStore = makeSellerStore({
      tier: makeSellerTier({
        usage_policy_json: {
          chat_turn: { period_granularity: 'day', period_limit: 1 },
        },
      }),
    });
    let markStarted!: () => void;
    let unblock!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const provider = makeProvider(async () => {
      markStarted();
      await blocked;
      return { content: 'first complete' };
    });
    const handler = createLlmGatewayPortHandler(makeDeps({ provider, sellerStore }));
    const firstRes = new FakeRes();
    const first = handler(
      buildReq({ body: makeBody() }),
      firstRes as unknown as ServerResponse,
    );
    await started;

    const secondRes = new FakeRes();
    await handler(
      buildReq({ body: makeBody() }),
      secondRes as unknown as ServerResponse,
    );

    expect(secondRes.statusCode).toBe(429);
    expect(json<{ error: { code: string } }>(secondRes).error.code)
      .toBe('period_limit_exceeded');
    expect(provider.complete).toHaveBeenCalledTimes(1);

    unblock();
    await first;
    expect(firstRes.statusCode).toBe(200);
    expect(sellerStore.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('returns chat rate capacity when a provider turn fails', async () => {
    const sellerStore = makeSellerStore({
      tier: makeSellerTier({
        usage_policy_json: {
          chat_turn: {
            period_granularity: 'day',
            period_limit: 5,
            rate_limit_per_minute: 1,
          },
        },
      }),
    });
    const provider = makeProvider(vi.fn()
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce({ content: 'retry succeeds' }));
    const handler = createLlmGatewayPortHandler(makeDeps({ provider, sellerStore }));

    const failed = new FakeRes();
    await handler(
      buildReq({ body: makeBody() }),
      failed as unknown as ServerResponse,
    );
    expect(failed.statusCode).toBe(502);

    const retried = new FakeRes();
    await handler(
      buildReq({ body: makeBody() }),
      retried as unknown as ServerResponse,
    );
    expect(retried.statusCode).toBe(200);
    expect(sellerStore.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('injects a gateway-only tool meter with free-tool classification', async () => {
    const sellerStore = makeSellerStore({
      tier: makeSellerTier({
        usage_policy_json: {
          chat_turn: { period_granularity: 'day', period_limit: 5 },
          tool_call: { period_granularity: 'day', period_limit: 50 },
        },
      }),
    });
    const token = makeToken({
      grants: {
        'business.tool': true,
        'tools.search': true,
      },
    });
    const provider = makeProvider(async (input) => {
      expect(input.llm_gateway_tool_usage).toBeDefined();
      const snapshot = await input.resolve_contract_snapshot({
        tool_name: 'business.tool',
        arg_values: {},
      });
      expect(snapshot).toEqual(expect.objectContaining({
        contract_id: CONTRACT_ID,
        contract_version: expect.stringMatching(/^authority-sha256-v1:[0-9a-f]{64}$/),
        allowed_tools: ['ingredient.allowed'],
      }));
      const baseCall = {
        session_id: 'gateway-session',
        turn_id: 'gateway-turn',
        arg_values: {},
        picker_target: 'self' as const,
      };
      const businessCall = {
        ...baseCall,
        tool_name: 'business.tool',
      };
      expect(await input.llm_gateway_tool_usage!.admit(businessCall))
        .toEqual({ admitted: true });
      await input.llm_gateway_tool_usage!.record(businessCall);
      // Catalog/setup/status calls are explicitly free even on the gateway.
      const freeCall = {
        ...baseCall,
        tool_name: 'tools.search',
      };
      expect(await input.llm_gateway_tool_usage!.admit(freeCall))
        .toEqual({ admitted: true });
      await input.llm_gateway_tool_usage!.record(freeCall);
      return { content: 'done' };
    });
    const deps = makeDeps({
      provider,
      sellerStore,
      token,
      listContractAllowedToolSlugs: () => ['ingredient.allowed'],
      contractOverlay: {
        isContractLive: vi.fn(() => true),
        permitsDoorType: vi.fn(() => true),
        resolveContractScopeRestrictions: vi.fn(() => ['data.mail']),
      },
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    const recorded = vi.mocked(sellerStore.recordUsage).mock.calls
      .map(([call]) => call);
    expect(recorded.filter((call) => call.usage_kind === 'tool_call'))
      .toEqual([
        expect.objectContaining({ units: 1 }),
      ]);
    expect(recorded.filter((call) => call.usage_kind === 'chat_turn'))
      .toEqual([expect.objectContaining({ units: 1 })]);
  });

  it('keeps the accepted outer chat_turn while a run_failed tool reservation releases', async () => {
    const sellerStore = makeSellerStore({
      tier: makeSellerTier({
        usage_policy_json: {
          chat_turn: { period_granularity: 'day', period_limit: 5 },
          tool_call: { period_granularity: 'day', period_limit: 5 },
        },
      }),
    });
    const provider = makeProvider(async (input) => {
      const call = {
        session_id: 'gateway-session',
        turn_id: 'gateway-turn',
        tool_name: 'business.tool',
        arg_values: {},
        picker_target: 'self' as const,
      };
      expect(await input.llm_gateway_tool_usage!.admit(call))
        .toEqual({ admitted: true });
      // The shared orchestrator takes this release branch for run_failed.
      await input.llm_gateway_tool_usage!.release(call);
      return { content: 'The tool failed; no tool unit was charged.' };
    });
    const handler = createLlmGatewayPortHandler(makeDeps({
      provider,
      sellerStore,
      token: makeToken({ grants: { 'business.tool': true } }),
    }));
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    const recorded = vi.mocked(sellerStore.recordUsage).mock.calls.map(([call]) => call);
    expect(recorded.filter((call) => call.usage_kind === 'tool_call')).toEqual([]);
    expect(recorded.filter((call) => call.usage_kind === 'chat_turn'))
      .toEqual([expect.objectContaining({ units: 1 })]);
  });

  it('records a gateway tool reservation in the period it was admitted', async () => {
    let clock = Date.UTC(2032, 0, 1, 23, 59, 59);
    const admittedAt = clock;
    const sellerStore = makeSellerStore({
      customer: makeSellerCustomer({ current_period_end: clock + 60_000 }),
      tier: makeSellerTier({
        usage_policy_json: {
          chat_turn: { period_granularity: 'day', period_limit: 5 },
          tool_call: { period_granularity: 'day', period_limit: 5 },
        },
      }),
    });
    const provider = makeProvider(async (input) => {
      const call = {
        session_id: 'gateway-session',
        turn_id: 'gateway-turn',
        tool_name: 'business.tool',
        arg_values: {},
        picker_target: 'self' as const,
      };
      expect(await input.llm_gateway_tool_usage!.admit(call))
        .toEqual({ admitted: true });
      clock += 2_000;
      await input.llm_gateway_tool_usage!.record(call);
      return { content: 'done' };
    });
    const handler = createLlmGatewayPortHandler(makeDeps({
      provider,
      sellerStore,
      token: makeToken({ grants: { 'business.tool': true } }),
      now: () => clock,
    }));
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    const toolRecord = vi.mocked(sellerStore.recordUsage).mock.calls
      .map(([call]) => call)
      .find((call) => call.usage_kind === 'tool_call');
    expect(toolRecord).toMatchObject({
      period_start: Date.UTC(2032, 0, 1),
      now: admittedAt,
    });
  });

  it('does not record seller usage when the provider fails', async () => {
    const sellerStore = makeSellerStore();
    const provider = makeProvider(async () => {
      throw new Error('provider down');
    });
    const deps = makeDeps({
      provider,
      sellerStore,
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(502);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('llm_gateway_provider_failed');
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });

  it('maps a provider context overflow to OpenAI context_length_exceeded', async () => {
    const sellerStore = makeSellerStore();
    const provider = makeProvider(async () => {
      throw new LLMError(
        'AI_TOKEN_BUDGET_EXCEEDED',
        'provider rejected oversized input',
      );
    });
    const deps = makeDeps({ provider, sellerStore });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('context_length_exceeded');
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });

  it('denies seller customers at the chat_turn usage gate before provider work', async () => {
    const sellerStore = makeSellerStore({ used: 5 });
    const provider = makeProvider();
    const deps = makeDeps({
      provider,
      sellerStore,
    });
    const handler = createLlmGatewayPortHandler(deps);
    const res = new FakeRes();

    await handler(
      buildReq({ body: makeBody() }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(429);
    expect(json<{ error: { code: string } }>(res).error.code)
      .toBe('period_limit_exceeded');
    expect(provider.complete).not.toHaveBeenCalled();
    expect(sellerStore.recordUsage).not.toHaveBeenCalled();
  });
});

describe('createLlmGatewayDirectCompletionProvider', () => {
  it('propagates the adapter finish reason', async () => {
    const config = baseConfig();
    const resolved = resolveLlmGatewayRoute(config);
    if (!resolved.ok) throw new Error(resolved.message);
    const adapterComplete = vi.fn(async () => ({
      text: 'partial',
      finish_reason: 'length' as const,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
      },
    }));
    const provider = createLlmGatewayDirectCompletionProvider({
      adapters: () => ({ provider: 'openai', complete: adapterComplete }),
    });

    const result = await provider.complete({
      route: resolved.route,
      system_prompt: 'recued gateway system prompt',
      system_prompt_direct: 'recued gateway system prompt (raw)',
      system_role: 'system',
      emit_caller_application_instructions: true,
      messages: [{ role: 'user', content: 'hi' }],
      requested_model: 'ignored',
      model_alias: 'seller-primary',
      config,
      now: NOW,
      system_tools_allowed: false,
      token: makeToken(),
      contract_id: CONTRACT_ID,
      allowed_tool_names: [],
      input_token_budget: 100_000,
      resolve_contract_snapshot: () => null,
    });

    expect(result.finish_reason).toBe('length');
  });
});

describe('createLlmGatewaySharedChatCompletionProvider', () => {
  it('adapts the OpenAI request onto the shared contracted chat turn', async () => {
    const config = baseConfig();
    const resolved = resolveLlmGatewayRoute(config);
    if (!resolved.ok) throw new Error(resolved.message);
    const runLlmGatewayTurn = vi.fn(async (_input: LlmGatewayTurnInput) => ({
      turn_id: 'turn-shared',
      assistant_content: 'shared answer',
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        total_tokens: 10,
      },
    }));
    const provider = createLlmGatewaySharedChatCompletionProvider({
      orchestrator: { runLlmGatewayTurn },
      adapters: () => ({
        provider: 'openai',
        complete: vi.fn(),
      }),
      quota: createQuotaTracker(),
      tabProbe: async () => new Set(),
    });
    const token = makeToken({
      grants: { 'seller/invoice-search': true, 'mail.search': true },
    });
    const resolveContractSnapshot = vi.fn(() => null);

    const result = await provider.complete({
      route: resolved.route,
      system_prompt: 'recued gateway system prompt',
      system_prompt_direct: 'recued gateway system prompt (raw)',
      system_role: 'system',
      emit_caller_application_instructions: true,
      messages: [
        { role: 'system', content: 'customer application policy' },
        { role: 'user', content: 'find the invoice' },
      ],
      requested_model: 'ignored',
      model_alias: 'seller-primary',
      config,
      now: NOW,
      system_tools_allowed: true,
      token,
      contract_id: CONTRACT_ID,
      allowed_tool_names: ['seller/invoice-search'],
      input_token_budget: 100_000,
      resolve_contract_snapshot: resolveContractSnapshot,
    });

    expect(result).toEqual({
      id: 'chatcmpl_turn-shared',
      content: 'shared answer',
      usage: {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
      },
    });
    expect(runLlmGatewayTurn).toHaveBeenCalledWith(expect.objectContaining({
      contract_id: CONTRACT_ID,
      allowed_tool_names: ['seller/invoice-search'],
      resolve_contract_snapshot: resolveContractSnapshot,
      model_layer: 'byok',
      model_source_id: 'slot_1',
      input_token_budget: 100_000,
    }));
    const turnInput = vi.mocked(runLlmGatewayTurn).mock.calls[0]![0];
    expect(JSON.parse(turnInput.content.user_message)).toEqual({
      customer_application_instructions: ['customer application policy'],
      latest_customer_turn: [{ role: 'user', content: 'find the invoice' }],
    });
  });

  it('asserts live authority before every real shared-chat provider round', async () => {
    const config = baseConfig();
    const resolved = resolveLlmGatewayRoute(config);
    if (!resolved.ok) throw new Error(resolved.message);
    const manifest: IngredientManifest = {
      slug: 'gateway-round-test',
      name: 'Gateway round test',
      description: 'Gateway round test',
      author: 'recued',
      kind: 'ai',
      category: 'ai',
      risk_tier: 'read',
      input: {
        'llm.system_prompt': null,
        'llm.prompt': null,
        'llm.output_format': 'json',
      },
      output: { result: 'body' },
    };
    const adapterComplete = vi.fn(async () => ({
      text: JSON.stringify({ response: 'round', events: [], tool_calls: [] }),
      finish_reason: 'stop' as const,
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }));
    const runLlmGatewayTurn = vi.fn(async (turnInput: LlmGatewayTurnInput) => {
      const aiInput = {
        'llm.system_prompt': 'gateway system',
        'llm.prompt': 'gateway prompt',
        'llm.output_format': 'json',
        'llm.force_layer': 'byok',
        'llm.pin_slot': 'slot_1',
        'llm.model_hint': 'fast',
      };
      await turnInput.execute_ai_call(manifest, aiInput);
      await turnInput.execute_ai_call(manifest, aiInput);
      return { turn_id: 'turn-two-rounds', assistant_content: 'done' };
    });
    const provider = createLlmGatewaySharedChatCompletionProvider({
      orchestrator: { runLlmGatewayTurn },
      adapters: () => ({ provider: 'openai', complete: adapterComplete }),
      quota: createQuotaTracker(),
      tabProbe: async () => new Set(),
    });
    const assertLiveAuthority = vi.fn(async () => undefined);

    await provider.complete({
      route: resolved.route,
      system_prompt: 'recued gateway system prompt',
      system_prompt_direct: 'recued gateway system prompt (raw)',
      system_role: 'system',
      emit_caller_application_instructions: true,
      messages: [{ role: 'user', content: 'run two rounds' }],
      requested_model: 'ignored',
      model_alias: 'seller-primary',
      config,
      now: NOW,
      system_tools_allowed: false,
      token: makeToken(),
      contract_id: CONTRACT_ID,
      allowed_tool_names: [],
      input_token_budget: 100_000,
      resolve_contract_snapshot: () => null,
      assert_live_authority: assertLiveAuthority,
    });

    expect(adapterComplete).toHaveBeenCalledTimes(2);
    expect(assertLiveAuthority).toHaveBeenCalledTimes(2);
    expect(assertLiveAuthority.mock.invocationCallOrder[0])
      .toBeLessThan(adapterComplete.mock.invocationCallOrder[0]!);
    expect(assertLiveAuthority.mock.invocationCallOrder[1])
      .toBeLessThan(adapterComplete.mock.invocationCallOrder[1]!);
  });
});

describe('server llm_gateway legacy aliases', () => {
  it('adds only exact OpenAI-compatible aliases and leaves connection webhooks on webhooks', () => {
    expect(SERVER_LEGACY_PATH_ALIASES).toEqual(expect.arrayContaining([
      { kind: 'exact', path: '/v1/models', role: 'llm_gateway' },
      { kind: 'exact', path: '/v1/chat/completions', role: 'llm_gateway' },
      { kind: 'prefix', prefix: '/v1/connection/webhook/', role: 'webhooks' },
    ]));
  });
});

describe('llm_gateway system prompt reaches the model as a system prompt', () => {
  /** Drive the REAL handler with the REAL shared provider — the only one
   *  production composes (`serve/compose-ingress-rpc-context.ts`). Only the
   *  orchestrator is mocked, so `buildLlmGatewayMessages` and the whole
   *  policy/compose path run for real.
   *
   *  ⚠ The pre-existing coverage of the gateway prompt (`providerInput
   *  .messages[0]` above) asserts against a STUB provider, so it only proves
   *  what the handler hands the provider — and it stayed green while the shared
   *  provider swept that very message into `customer_application_instructions`
   *  and the model never read it as an instruction at all. These tests assert
   *  what the MODEL receives, which is the only thing that was ever the point. */
  const driveSharedTurn = async (
    config?: LLMConfig,
    messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: 'customer application policy' },
      { role: 'user', content: 'hi' },
    ],
  ): Promise<LlmGatewayTurnInput> => {
    const runLlmGatewayTurn = vi.fn(async (_input: LlmGatewayTurnInput) => ({
      turn_id: 'turn-1',
      assistant_content: 'ok',
    }));
    const provider = createLlmGatewaySharedChatCompletionProvider({
      orchestrator: { runLlmGatewayTurn },
      adapters: () => ({ provider: 'openai', complete: vi.fn() }),
      quota: createQuotaTracker(),
      tabProbe: async () => new Set(),
    });
    const handler = createLlmGatewayPortHandler(
      makeDeps(config ? { provider, config } : { provider }),
    );
    await handler(
      buildReq({ body: makeBody({ messages }) }),
      new FakeRes() as unknown as ServerResponse,
    );
    expect(runLlmGatewayTurn).toHaveBeenCalled();
    return runLlmGatewayTurn.mock.calls[0]![0];
  };

  const callerInstructions = (turn: LlmGatewayTurnInput): string[] =>
    (JSON.parse(turn.content.user_message) as {
      customer_application_instructions: string[];
    }).customer_application_instructions;

  it('carries the posture on the turn system prompt, NOT among customer instructions', async () => {
    const turn = await driveSharedTurn();

    expect(turn.system_prompt).toContain('external contract-bound caller');
    expect(turn.system_prompt).toContain('never assume user_self or owner authority');
    expect(turn.system_prompt).toContain('AIOutput');
    expect(turn.system_role).toBe('system');
    // The customer's field contains the CUSTOMER's instructions. Only those.
    expect(callerInstructions(turn)).toEqual(['customer application policy']);
  });

  it('lets the owner set the role block — and ships Recued feature text anyway', async () => {
    const turn = await driveSharedTurn(baseConfig({
      llm_gateway_role_instructions:
        'You are the Acme support agent. Cite order ids.',
      llm_gateway_system_role: 'user',
    }));

    expect(turn.system_prompt).toContain('You are the Acme support agent.');
    expect(turn.system_role).toBe('user');
    // ⛔ The owner rewrote block 1 and reached NOTHING else.
    expect(turn.system_prompt).toContain('AIOutput');
    expect(turn.system_prompt).toContain("can't bypass approvals");
    expect(turn.system_prompt).toContain('external contract-bound caller');
  });

  it('never lets the owner CHAT role block leak to an external gateway caller', async () => {
    const turn = await driveSharedTurn(baseConfig({
      chat_role_instructions: 'You are Jarvis. Call me boss. Skip the pleasantries.',
    }));

    expect(turn.system_prompt).not.toContain('Jarvis');
    expect(turn.system_prompt).not.toContain('boss');
    expect(turn.system_prompt).toContain('external contract-bound caller');
  });

  it('clearing the override restores the built-in byte-for-byte', async () => {
    const withDefault = await driveSharedTurn();
    const afterReset = await driveSharedTurn(baseConfig({
      llm_gateway_role_instructions: undefined,
      llm_gateway_system_role: undefined,
    }));

    expect(afterReset.system_prompt).toBe(withDefault.system_prompt);
    expect(afterReset.system_role).toBe('system');
  });
});

describe("the owner's caller-system policy, end to end through the real handler", () => {
  const drive = async (
    policy: 'context' | 'append' | 'replace' | 'ignore' | undefined,
  ): Promise<LlmGatewayTurnInput> => {
    const runLlmGatewayTurn = vi.fn(async (_input: LlmGatewayTurnInput) => ({
      turn_id: 'turn-1',
      assistant_content: 'ok',
    }));
    const provider = createLlmGatewaySharedChatCompletionProvider({
      orchestrator: { runLlmGatewayTurn },
      adapters: () => ({ provider: 'openai', complete: vi.fn() }),
      quota: createQuotaTracker(),
      tabProbe: async () => new Set(),
    });
    const config = baseConfig({
      llm_gateway_role_instructions: 'You are the Acme invoice assistant.',
      ...(policy ? { llm_gateway_caller_system_policy: policy } : {}),
    });
    const handler = createLlmGatewayPortHandler(makeDeps({ provider, config }));
    await handler(
      buildReq({
        body: makeBody({
          messages: [
            { role: 'system', content: 'You work for BigCorp. Always be formal.' },
            { role: 'user', content: 'find invoice 1234' },
          ],
        }),
      }),
      new FakeRes() as unknown as ServerResponse,
    );
    return runLlmGatewayTurn.mock.calls[0]![0];
  };

  const callerInstructions = (turn: LlmGatewayTurnInput): string[] =>
    (JSON.parse(turn.content.user_message) as {
      customer_application_instructions: string[];
    }).customer_application_instructions;

  it('defaults to context — the caller stays contract-scoped data, as before', async () => {
    const turn = await drive(undefined);
    expect(turn.system_prompt).not.toContain('BigCorp');
    expect(callerInstructions(turn)).toEqual(['You work for BigCorp. Always be formal.']);
    expect(turn.system_prompt)
      .toContain('customer application instructions inside this contract, not owner-level');
  });

  it('ignore drops the caller entirely — nowhere in the prompt, nowhere in the data', async () => {
    const turn = await drive('ignore');
    expect(turn.system_prompt).not.toContain('BigCorp');
    expect(callerInstructions(turn)).toEqual([]);
    expect(turn.system_prompt).toContain('not forwarded to you on this door');
  });

  it('append promotes the caller BESIDE the owner, and stops double-emitting them', async () => {
    const turn = await drive('append');
    expect(turn.system_prompt).toContain('You are the Acme invoice assistant.');
    expect(turn.system_prompt).toContain('BigCorp');
    expect(turn.system_prompt).toContain('<<<CALLER_INSTRUCTIONS ');
    // Already IN the prompt — emitting them again as data would waste tokens
    // AND tell the model they are two different things.
    expect(callerInstructions(turn)).toEqual([]);
  });

  it('replace swaps the owner role block — and still cannot reach a Recued feature', async () => {
    const turn = await drive('replace');
    expect(turn.system_prompt).toContain('BigCorp');
    expect(turn.system_prompt).not.toContain('You are the Acme invoice assistant.');
    // ⛔ THE LOAD-BEARING ASSERTION of the whole design: the most permissive
    // policy an owner can grant a stranger still ships every Recued block.
    expect(turn.system_prompt).toContain('AIOutput');
    expect(turn.system_prompt).toContain("can't bypass approvals");
    expect(turn.system_prompt).toContain('never assume user_self or owner authority');
    expect(callerInstructions(turn)).toEqual([]);
  });

  it('mints a fresh nonce per request, so the caller cannot forge the boundary', async () => {
    const a = await drive('append');
    const b = await drive('append');
    const nonceOf = (turn: LlmGatewayTurnInput): string =>
      /<<<CALLER_INSTRUCTIONS ([^>]+)>>>/.exec(turn.system_prompt ?? '')![1]!;
    expect(nonceOf(a)).not.toBe(nonceOf(b));
  });
});
