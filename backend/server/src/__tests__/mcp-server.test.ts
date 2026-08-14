import Database from 'better-sqlite3';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createInternalToolRegistry } from '@recued/middleware/internal-tool-registry/index.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import type {
  ChatDispatchContext,
  ExecutionSource,
  IngredientManifest,
  InternalToolRegistry,
  RecipeDefinition,
  ScanFn,
  ToolEntry,
} from '@recued/contracts';
import { RpcError } from '@recued/contracts';

/** The MCP server uses handleExecute + recipe/manifest registries
 *  internally. This test exercises those components the same way
 *  the MCP tool call handlers do. Stdio transport is not tested
 *  here — it's thin JSON-RPC plumbing. */

const SIMPLE_RECIPE: RecipeDefinition = {
  recipe_id: 'mcp-test-recipe',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'MCP Test',
    description: 'Simple recipe for MCP testing',
    author: 'test',
    supported_platforms: ['test'],
  },
  variables: { greeting: 'hello' },
  prefetch_steps: [],
  steps: [
    { id: 'msg', transform: 'template', template: '{{config.greeting}} world' },
  ],
  output: { sidebar: [{ type: 'text', source: 'step.msg' }] },
};

/** ⛔⛔ D-228 slice 6 — the permissive checklist is a DEFAULT, and every test
 *  whose subject IS the gate overrides it. An absent checklist now DENIES at
 *  both `handleToolsList` and `handleToolCall`, so without a default here the
 *  metering / overlay / recipe-save tests below would all go green for the wrong
 *  reason — refused by the gate before ever reaching what they assert.
 *
 *  ⚠ SAFE ONLY BECAUSE OF ORDERING, which is checked: every gate test writes
 *  `{...makeDeps(), inboundTokenAuthorize: vi.fn(() => false)}` — the spread
 *  comes FIRST, so an explicit authorizer always shadows this one. A default
 *  that could silently disable a refusal assertion would be the exact hazard
 *  this comment exists to rule out.
 *
 *  ⚠ And it is production-faithful: `inboundTokenAuthorize: undefined` means NO
 *  TOKEN AT ALL, which is not the same as `boundContractId: undefined` (an
 *  UNBOUND token — a real caller that presented a bearer carrying no contract,
 *  and which therefore DOES have a checklist). Tests that mean "unbound owner"
 *  want this default, not its absence. */
const makeDeps = (): ExecuteHandlerDeps & Pick<McpDeps, 'inboundTokenAuthorize'> => {
  const manifests = createManifestRegistry('/nonexistent');
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(SIMPLE_RECIPE);
  return {
    recipeStore,
    executorConfig: { manifests },
    baseVault: {},
    inboundTokenAuthorize: () => true,
  };
};

describe('MCP tool: recued_runRecipe', () => {
  it('runs a recipe by id (simulating MCP tool call)', async () => {
    const deps = makeDeps();
    const result = await handleExecute(deps, { recipe_id: 'mcp-test-recipe' });
    expect(result.success).toBe(true);
    expect(result.recipe_id).toBe('mcp-test-recipe');
  });

  it('runs an inline recipe (simulating MCP tool call)', async () => {
    const deps = makeDeps();
    const result = await handleExecute(deps, { recipe: SIMPLE_RECIPE });
    expect(result.success).toBe(true);
  });

  it('throws recipe_not_found for unknown recipe', async () => {
    const deps = makeDeps();
    await expect(handleExecute(deps, { recipe_id: 'does-not-exist' }))
      .rejects.toMatchObject({ code: 'recipe_not_found', status: 404 });
  });

  it('throws bad_request for missing recipe_id and recipe', async () => {
    const deps = makeDeps();
    await expect(handleExecute(deps, {})).rejects.toBeInstanceOf(RpcError);
  });

  it('applies config overrides', async () => {
    const deps = makeDeps();
    const result = await handleExecute(deps, {
      recipe_id: 'mcp-test-recipe',
      config: { greeting: 'hi' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an inline recipe carrying an unresolved op-step (bad_request, before the engine throw)', async () => {
    // slice 3 / A3 — inline execution (recued_runRecipe { recipe }) bypasses the
    // save guard + installBulkPack safety net, so handleExecute itself rejects an
    // op-step recipe cleanly rather than letting the engine throw raw.
    const deps = makeDeps();
    const inlineOpStep = {
      recipe_id: 'inline-op-step',
      version: 1,
      ttl: 60,
      metadata: { name: 'x', description: 'inline op-step recipe', author: 'mcp', supported_platforms: [] },
      variables: {},
      prefetch_steps: [],
      steps: [{ id: 'deals', op: 'deal.search', args: { limit: 5 } }],
      output: { sidebar: [] },
    };
    await expect(
      handleExecute(deps, { recipe: inlineOpStep } as unknown as Parameters<typeof handleExecute>[1]),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('MCP tool: recued_listRecipes', () => {
  it('lists registered recipes', () => {
    const deps = makeDeps();
    const ids = deps.recipeStore.ids();
    expect(ids).toContain('mcp-test-recipe');
    const recipe = deps.recipeStore.get('mcp-test-recipe');
    expect(recipe).not.toBeNull();
    expect(recipe!.metadata.name).toBe('MCP Test');
  });
});

describe('MCP tool: recued_listIngredients', () => {
  it('lists registered ingredients', () => {
    const deps = makeDeps();
    const slugs = deps.executorConfig.manifests.slugs();
    // Empty since we didn't register any — which is valid
    expect(Array.isArray(slugs)).toBe(true);
  });

  it('includes registered ingredients', () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register({
      slug: 'test-ing',
      name: 'Test',
      description: 'Test ingredient',
      author: 'test',
      kind: 'http',
      category: 'data',
      risk_tier: 'read',
      input: { url: 'https://example.com' },
      output: { data: 'data' },
    });
    expect(manifests.slugs()).toContain('test-ing');
    expect(manifests.get('test-ing')?.name).toBe('Test');
  });
});

// ────────────────────────────────────────────────────────────────
// Per-ingredient tool catalog — one MCP tool per installed ingredient
// ────────────────────────────────────────────────────────────────

import {
  buildIngredientTool,
  buildMcpGrantCatalogLegacyEntries,
  createMcpHttpDispatch,
  type McpCustomerUsageAdmission,
  type McpDeps,
} from '../mcp-server.js';

describe('D-196 MCP customer usage metering', () => {
  const makeCustomerUsage = (
    reserveImpl: () => McpCustomerUsageAdmission = () => ({ admitted: true }),
  ) => {
    const reserve = vi.fn(reserveImpl);
    let hasReservation = false;
    const reserveOnce = vi.fn(() => {
      const admission = reserveImpl();
      if (admission.admitted) hasReservation = true;
      return admission;
    });
    const markZeroUnitReservation = vi.fn(() => {
      const admission = reserveImpl();
      if (admission.admitted) hasReservation = true;
      return admission;
    });
    return {
      reserve,
      reserveOnce,
      markZeroUnitReservation,
      hasReservationKey: vi.fn(() => hasReservation),
      commit: vi.fn(),
      release: vi.fn(),
      denialMessage: vi.fn(() => undefined),
    };
  };

  const customerStatusGrantOverlay = (
    granted: boolean,
  ): ExecuteHandlerDeps['contractOverlay'] => ({
    resolveReadGrantChecker: () => ({
      isTopicReadGranted: () => true,
      isCollectionReadGranted: () => true,
      isVerbOpGranted: (op: string) => op === 'core.customer.status' && granted,
    }),
  }) as unknown as ExecuteHandlerDeps['contractOverlay'];

  it('records one tool_call unit after a successful tools/call', async () => {
    const customerUsage = makeCustomerUsage();
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      auditLog: { listRecent: vi.fn(() => []) },
      customerUsage,
    } as unknown as McpDeps);

    const response = await dispatch(
      {
        jsonrpc: '2.0',
        id: 'usage-ok',
        method: 'tools/call',
        params: { name: 'recued_getAudit', arguments: {} },
      },
      'bearer-usage',
    ) as { result: { isError?: boolean } };

    expect(response.result.isError).toBeUndefined();
    expect(customerUsage.reserveOnce).toHaveBeenCalledWith(
      expect.any(String),
      {
        tool_name: 'recued_getAudit',
        usage_kind: 'tool_call',
        units: 1,
      },
    );
    expect(customerUsage.commit).toHaveBeenCalledTimes(1);
    expect(customerUsage.release).not.toHaveBeenCalled();
  });

  it('returns a tool error before dispatch when customer usage admission denies', async () => {
    const customerUsage = makeCustomerUsage(() => ({
        admitted: false,
        message: 'tool_call usage limit exceeded',
      }));
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      auditLog: { listRecent: vi.fn(() => []) },
      customerUsage,
    } as unknown as McpDeps);

    const response = await dispatch(
      {
        jsonrpc: '2.0',
        id: 'usage-denied',
        method: 'tools/call',
        params: { name: 'recued_getAudit', arguments: {} },
      },
      'bearer-usage',
    ) as { result: { isError?: boolean; content: Array<{ text: string }> } };

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toContain('tool_call usage limit exceeded');
    expect(customerUsage.commit).not.toHaveBeenCalled();
    expect(customerUsage.release).not.toHaveBeenCalled();
  });

  it('does not record usage when the tool returns an MCP error result', async () => {
    const customerUsage = makeCustomerUsage();
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      customerUsage,
    } as unknown as McpDeps);

    const response = await dispatch(
      {
        jsonrpc: '2.0',
        id: 'usage-error',
        method: 'tools/call',
        params: { name: 'recued_getAudit', arguments: {} },
      },
      'bearer-usage',
    ) as { result: { isError?: boolean } };

    expect(response.result.isError).toBe(true);
    expect(customerUsage.reserveOnce).toHaveBeenCalledTimes(1);
    expect(customerUsage.commit).not.toHaveBeenCalled();
    expect(customerUsage.release).toHaveBeenCalledTimes(1);
  });

  it('leaves tools/list free', async () => {
    const customerUsage = makeCustomerUsage();
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      customerUsage,
    } as unknown as McpDeps);

    await dispatch(
      { jsonrpc: '2.0', id: 'usage-list', method: 'tools/list' },
      'bearer-usage',
    );

    expect(customerUsage.reserve).not.toHaveBeenCalled();
    expect(customerUsage.commit).not.toHaveBeenCalled();
    expect(customerUsage.release).not.toHaveBeenCalled();
  });

  it('keeps the direct-MCP free classifier closed to setup/status/catalog affordances', () => {
    expect([..._testing.MCP_FREE_CUSTOMER_TOOL_NAMES].sort()).toEqual([
      'catalog.list',
      'recued_actionStatus',
      'recued_customerStatus',
      'recued_getRecipe',
      'recued_listIngredients',
      'recued_listRecipes',
      'recued_registryDescribe',
      'setup.status',
      'tools.search',
    ]);
  });

  it.each([
    'recued_listRecipes',
    'recued_listIngredients',
    'recued_registryDescribe',
  ])('free-classifies the %s catalog tools/call affordance', async (name) => {
    const customerUsage = makeCustomerUsage();
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      customerUsage,
    } as unknown as McpDeps);

    const response = await dispatch({
      jsonrpc: '2.0',
      id: `free-${name}`,
      method: 'tools/call',
      params: { name, arguments: {} },
    }, 'bearer-usage') as { result: { isError?: boolean } };

    expect(response.result.isError).toBeUndefined();
    expect(customerUsage.reserve).not.toHaveBeenCalled();
    expect(customerUsage.commit).not.toHaveBeenCalled();
  });

  it('free-classifies recipe detail after validating its required id', async () => {
    const customerUsage = makeCustomerUsage();
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      customerUsage,
    } as unknown as McpDeps);

    const response = await dispatch({
      jsonrpc: '2.0',
      id: 'free-recipe-detail',
      method: 'tools/call',
      params: {
        name: 'recued_getRecipe',
        arguments: { recipe_id: SIMPLE_RECIPE.recipe_id },
      },
    }, 'bearer-usage') as { result: { isError?: boolean } };

    expect(response.result.isError).toBeUndefined();
    expect(customerUsage.reserve).not.toHaveBeenCalled();
    expect(customerUsage.reserveOnce).not.toHaveBeenCalled();
    expect(customerUsage.commit).not.toHaveBeenCalled();
  });

  it('rejects an ungranted business tool before usage reservation', async () => {
    const customerUsage = makeCustomerUsage();
    const auditLog = { listRecent: vi.fn(() => []) };
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      auditLog,
      inboundTokenAuthorize: vi.fn(() => false),
      customerUsage,
    } as unknown as McpDeps);

    const response = await dispatch({
      jsonrpc: '2.0',
      id: 'usage-ungranted',
      method: 'tools/call',
      params: { name: 'recued_getAudit', arguments: {} },
    }, 'bearer-usage') as { result: { isError?: boolean } };

    expect(response.result.isError).toBe(true);
    expect(auditLog.listRecent).not.toHaveBeenCalled();
    expect(customerUsage.reserve).not.toHaveBeenCalled();
  });

  it('rejects malformed business arguments before usage reservation', async () => {
    const customerUsage = makeCustomerUsage();
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      auditLog: { listRecent: vi.fn(() => []) },
      customerUsage,
    } as unknown as McpDeps);

    const response = await dispatch({
      jsonrpc: '2.0',
      id: 'usage-malformed',
      method: 'tools/call',
      params: { name: 'recued_getAudit', arguments: { limit: 'twenty' } },
    }, 'bearer-usage') as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toContain('arguments.limit must be a finite number');
    expect(customerUsage.reserve).not.toHaveBeenCalled();
  });

  it('rejects a direct-return approval ask before usage reservation', async () => {
    const customerUsage = makeCustomerUsage();
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      boundContractId: 'customer-contract',
      boundContractActive: true,
      inboundTokenAuthorize: vi.fn(() => true),
      customerUsage,
    } as unknown as McpDeps);

    const response = await dispatch({
      jsonrpc: '2.0',
      id: 'usage-approval',
      method: 'tools/call',
      params: {
        name: 'recued_saveRecipe',
        arguments: { recipe: SIMPLE_RECIPE },
      },
    }, 'bearer-usage') as { result: { isError?: boolean } };

    expect(response.result.isError).toBe(true);
    expect(customerUsage.reserve).not.toHaveBeenCalled();
  });

  it('releases usage for a recipe call that returns success:false', async () => {
    const customerUsage = makeCustomerUsage();
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      commitStore: {
        writePending: vi.fn().mockResolvedValue(undefined),
        recordOutcome: vi.fn().mockResolvedValue(undefined),
      } as unknown as ExecuteHandlerDeps['commitStore'],
      customerUsage,
    } as unknown as McpDeps);
    const failingRecipe: RecipeDefinition = {
      ...SIMPLE_RECIPE,
      recipe_id: 'mcp-meter-failure',
      steps: [{ id: 'missing', ingredient: 'ingredient-that-does-not-exist', input: {} }],
    };

    const response = await dispatch({
      jsonrpc: '2.0',
      id: 'usage-run-failed',
      method: 'tools/call',
      params: {
        name: 'recued_runRecipe',
        arguments: { recipe: failingRecipe },
      },
    }, 'bearer-usage') as { result: { isError?: boolean; content: Array<{ text: string }> } };

    expect(response.result.isError).toBeUndefined();
    expect(JSON.parse(response.result.content[0]!.text)).toMatchObject({ success: false });
    expect(customerUsage.reserve).not.toHaveBeenCalled();
    expect(customerUsage.reserveOnce).not.toHaveBeenCalled();
    expect(customerUsage.commit).not.toHaveBeenCalled();
    expect(customerUsage.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'awaiting_approval', awaiting_approval: true },
    { status: 'requires_approval' },
    { status: 'cancelled', cancelled: true },
    { success: false },
    { success: true, run_failed: { detail: 'failed after dispatch' } },
  ])('does not trust business payload fields to self-classify usage: %j', (payload) => {
    expect(_testing.isBillableMcpToolResult({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    })).toBe(true);
  });

  it('releases from trusted registry run_failed metadata, regardless of payload shape', async () => {
    const customerUsage = makeCustomerUsage();
    const toolName = 'seller/run-failed';
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      internalRegistry: registryStub(
        [registryTool(toolName, 2)],
        async () => ({
          ok: true,
          result: { success: true, detail: 'protocol envelope succeeded' },
          run_failed: { detail: 'recipe execution failed' },
        }),
      ),
      customerUsage,
    } as unknown as McpDeps);

    const response = await dispatch({
      jsonrpc: '2.0',
      id: 'usage-registry-run-failed',
      method: 'tools/call',
      params: { name: toolName, arguments: {} },
    }, 'bearer-usage') as { result: { isError?: boolean } };

    expect(response.result.isError).toBeUndefined();
    // This registry stub returns the trusted failed carrier without invoking
    // the real execute boundary, so the uniformly deferred meter never needs
    // to reserve. A production Tier-2 execution reserves inside handleExecute
    // and releases through the same carrier branch.
    expect(customerUsage.reserveOnce).not.toHaveBeenCalled();
    expect(customerUsage.commit).not.toHaveBeenCalled();
    expect(customerUsage.release).toHaveBeenCalledTimes(1);
  });

  it('charges a successful registry result whose business data says success:false', async () => {
    const customerUsage = makeCustomerUsage();
    const toolName = 'seller/business-status';
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      internalRegistry: registryStub(
        [registryTool(toolName, 2)],
        async () => ({
          ok: true,
          result: { success: false, status: 'cancelled', available: false },
        }),
      ),
      customerUsage,
    } as unknown as McpDeps);

    const response = await dispatch({
      jsonrpc: '2.0',
      id: 'usage-registry-business-data',
      method: 'tools/call',
      params: { name: toolName, arguments: {} },
    }, 'bearer-usage') as { result: { isError?: boolean } };

    expect(response.result.isError).toBeUndefined();
    expect(customerUsage.reserveOnce).toHaveBeenCalledTimes(1);
    expect(customerUsage.commit).toHaveBeenCalledTimes(1);
    expect(customerUsage.release).not.toHaveBeenCalled();
  });

  it('meters an extension-only ingredient at the delegation seam', async () => {
    const customerUsage = makeCustomerUsage();
    const runKernelRecipeOnExtension = vi.fn(async () => ({
      success: true,
      output: { text: 'hello' },
    }));
    const extensionManifest = {
      slug: 'extension-only-metered',
      name: 'Extension only metered',
      description: 'Exists only on the paired extension',
      author: 'recued-core',
      kind: 'dom',
      version: 1,
      category: 'data',
      risk_tier: 'read',
      tags: [],
      input: { selector: null },
      output: { text: 'text' },
    } as unknown as IngredientManifest;
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      wsServer: {
        listExtensionIngredients: vi.fn(async () => [{
          slug: extensionManifest.slug,
          manifest: extensionManifest,
        }]),
        runKernelRecipeOnExtension,
      },
      customerUsage,
    } as unknown as McpDeps);

    const response = await dispatch({
      jsonrpc: '2.0',
      id: 'usage-extension-only',
      method: 'tools/call',
      params: {
        name: 'recued_ingredient_extension-only-metered',
        arguments: { selector: 'h1' },
      },
    }, 'bearer-usage') as { result: { isError?: boolean } };

    expect(response.result.isError).toBeUndefined();
    expect(runKernelRecipeOnExtension).toHaveBeenCalledTimes(1);
    expect(customerUsage.reserveOnce).toHaveBeenCalledTimes(1);
    expect(customerUsage.commit).toHaveBeenCalledTimes(1);
  });

  it('serves customer.status without inbound business-tool grant or usage metering', async () => {
    const customerUsage = makeCustomerUsage();
    const customerStatus = {
      getStatus: vi.fn(() => ({
        usage: {
          period_start: Date.UTC(2026, 6, 1),
          period_granularity: 'month',
          tool_call: { consumed: 2, period_limit: 10, rate_limit_per_min: 1 },
          chat_turn: { consumed: 0, period_limit: null, rate_limit_per_min: null },
        },
        status: {
          lifecycle_source: 'manual',
          tier: 'pro',
          source_status: 'active',
          access_state: 'active',
          current_period_end: null,
          grace_until: null,
        },
      })),
    };
    const inboundTokenAuthorize = vi.fn(() => false);
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      boundContractId: 'ct_customer_1',
      boundContractActive: true,
      inboundTokenAuthorize,
      customerUsage,
      customerStatus,
      contractOverlay: customerStatusGrantOverlay(true),
    } as unknown as McpDeps);

    const response = await dispatch(
      {
        jsonrpc: '2.0',
        id: 'customer-status',
        method: 'tools/call',
        params: { name: 'recued_customerStatus', arguments: {} },
      },
      'bearer-usage',
    ) as { result: { isError?: boolean; content: Array<{ text: string }> } };

    expect(response.result.isError).toBeUndefined();
    expect(JSON.parse(response.result.content[0]!.text)).toMatchObject({
      usage: { tool_call: { consumed: 2 } },
      status: { lifecycle_source: 'manual', tier: 'pro' },
    });
    expect(inboundTokenAuthorize).not.toHaveBeenCalled();
    expect(customerUsage.reserve).not.toHaveBeenCalled();
    expect(customerUsage.commit).not.toHaveBeenCalled();
    expect(customerUsage.release).not.toHaveBeenCalled();
    expect(customerStatus.getStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects customer.status arguments instead of accepting model-supplied customer ids', async () => {
    const customerUsage = makeCustomerUsage();
    const customerStatus = { getStatus: vi.fn() };
    const inboundTokenAuthorize = vi.fn(() => false);
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      boundContractId: 'ct_customer_1',
      boundContractActive: true,
      inboundTokenAuthorize,
      customerUsage,
      customerStatus,
      contractOverlay: customerStatusGrantOverlay(true),
    } as unknown as McpDeps);

    const response = await dispatch(
      {
        jsonrpc: '2.0',
        id: 'customer-status-args',
        method: 'tools/call',
        params: {
          name: 'recued_customerStatus',
          arguments: { customer_id: 'seller_customer_other' },
        },
      },
      'bearer-usage',
    ) as { result: { isError?: boolean; content: Array<{ text: string }> } };

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('does not accept arguments');
    expect(inboundTokenAuthorize).not.toHaveBeenCalled();
    expect(customerUsage.reserve).not.toHaveBeenCalled();
    expect(customerUsage.commit).not.toHaveBeenCalled();
    expect(customerUsage.release).not.toHaveBeenCalled();
    expect(customerStatus.getStatus).not.toHaveBeenCalled();
  });

  it('lists customer.status by contract verb grant, not by inbound business-tool grants', async () => {
    const customerStatus = { getStatus: vi.fn() };
    const inboundTokenAuthorize = vi.fn(() => false);
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      boundContractId: 'ct_customer_1',
      boundContractActive: true,
      inboundTokenAuthorize,
      customerStatus,
      contractOverlay: customerStatusGrantOverlay(true),
    } as unknown as McpDeps);

    const response = await dispatch(
      { jsonrpc: '2.0', id: 'customer-status-list', method: 'tools/list' },
      'bearer-usage',
    ) as { result: { tools: Array<{ name: string }> } };

    expect(response.result.tools.map((tool) => tool.name)).toEqual([
      'recued_customerStatus',
    ]);
    expect(inboundTokenAuthorize).not.toHaveBeenCalledWith('recued_customerStatus');
  });

  it('hides customer.status when the customer contract does not grant the verb op', async () => {
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      boundContractId: 'ct_customer_1',
      boundContractActive: true,
      customerStatus: { getStatus: vi.fn() },
      contractOverlay: customerStatusGrantOverlay(false),
    } as unknown as McpDeps);

    const response = await dispatch(
      { jsonrpc: '2.0', id: 'customer-status-hidden', method: 'tools/list' },
      'bearer-usage',
    ) as { result: { tools: Array<{ name: string }> } };

    expect(response.result.tools.map((tool) => tool.name)).not.toContain(
      'recued_customerStatus',
    );
  });

  it('fails closed when customer.status has no live customer contract grant checker', async () => {
    const customerStatus = { getStatus: vi.fn() };
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      customerStatus,
    } as unknown as McpDeps);

    const listResponse = await dispatch(
      { jsonrpc: '2.0', id: 'customer-status-no-overlay-list', method: 'tools/list' },
      'bearer-usage',
    ) as { result: { tools: Array<{ name: string }> } };
    expect(listResponse.result.tools.map((tool) => tool.name)).not.toContain(
      'recued_customerStatus',
    );

    const callResponse = await dispatch(
      {
        jsonrpc: '2.0',
        id: 'customer-status-no-overlay-call',
        method: 'tools/call',
        params: { name: 'recued_customerStatus', arguments: {} },
      },
      'bearer-usage',
    ) as { result: { isError?: boolean } };

    expect(callResponse.result.isError).toBe(true);
    expect(customerStatus.getStatus).not.toHaveBeenCalled();
  });

  it('gates seller-customer raw op calls by the bound contract, not the token checklist', async () => {
    const inboundTokenAuthorize = vi.fn(() => false);
    const opAdmissionGate = {
      isFrozenByPause: () => false,
      isOpGranted: vi.fn((_source: unknown, opId: string | undefined) =>
        opId === 'recued-core.crm-pack.deal.search'),
    };
    const dispatch = createMcpHttpDispatch({
      ...makeDeps(),
      boundContractId: 'ct_customer_1',
      boundContractActive: true,
      customerContractGrants: true,
      inboundTokenAuthorize,
      opAdmissionGate,
    } as unknown as McpDeps);

    const granted = await dispatch(
      {
        jsonrpc: '2.0',
        id: 'customer-raw-granted',
        method: 'tools/call',
        params: {
          name: 'recued_op_recued-core.crm-pack.deal.search',
          arguments: {},
        },
      },
      'bearer-usage',
    ) as { result: { content: Array<{ text: string }> } };
    expect(granted.result.content[0]!.text).not.toContain('per-token checklist');
    expect(inboundTokenAuthorize).not.toHaveBeenCalled();
    expect(opAdmissionGate.isOpGranted).toHaveBeenCalledWith(
      expect.objectContaining({ contract_id: 'ct_customer_1' }),
      'recued-core.crm-pack.deal.search',
    );

    const denied = await dispatch(
      {
        jsonrpc: '2.0',
        id: 'customer-raw-denied',
        method: 'tools/call',
        params: {
          name: 'recued_op_recued-core.crm-pack.deal.create',
          arguments: {},
        },
      },
      'bearer-usage',
    ) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]!.text).toContain(
      'not granted by this customer contract',
    );
    expect(inboundTokenAuthorize).not.toHaveBeenCalled();
  });
});

describe('MCP per-ingredient tool catalog', () => {
  const aiClassify: IngredientManifest = {
    slug: 'ai-classify',
    name: 'AI Classifier',
    description: 'Pick one category from a closed list.',
    author: 'recued-core',
    kind: 'ai',
    version: 1,
    category: 'ai',
    risk_tier: 'read',
    tags: ['ai'],
    input: {
      'llm.data': null,
      'llm.categories': null,
      'llm.context': null,
      'llm.model_hint': 'quality',
    },
    output: {},
  };

  const kernelIngredient: IngredientManifest = {
    slug: 'kernel-only',
    name: 'Internal',
    description: 'x',
    author: 'recued',
    kind: 'storage',
    version: 1,
    category: 'data',
    risk_tier: 'read',
    tags: [],
    input: { x: null },
    output: {},
  };
  const dataFileReadIngredient: IngredientManifest = {
    ...kernelIngredient,
    slug: 'data-file-read',
    // D-228 slice 2 — exposure is an AUTHORED field now, so the fixture has to
    // carry it exactly as the shipped manifest does. Its absence is what
    // fences every OTHER kernel ingredient in these tests.
    mcp_exposed: true,
    name: 'Read inbound file content',
    input: { record_id: null },
  };

  it('buildIngredientTool generates a namespaced tool with the ingredient description', () => {
    const tool = buildIngredientTool(aiClassify);
    expect(tool.name).toBe('recued_ingredient_ai-classify');
    expect(tool.description).toMatch(/ai\/read/);
    expect(tool.description).toMatch(/Pick one category/);
  });

  it('schema marks null-default keys as required and types non-nulls by JS runtime type', () => {
    const tool = buildIngredientTool(aiClassify);
    const schema = tool.inputSchema;
    expect(schema.required).toContain('llm.data');
    expect(schema.required).toContain('llm.categories');
    expect(schema.required).not.toContain('llm.model_hint'); // has a default
    expect(schema.properties['llm.model_hint']?.type).toBe('string');
  });

  it('types an empty-object default as an OPTIONAL object, not a required string (D-192 6c.2c container_names {} gotcha)', () => {
    // The task/note/project-create manifests ship `container_names: {}` — a `{}`
    // default must infer `type: object` and stay OUT of required. A `null`
    // default would (wrongly) infer a required string; that regression is what
    // this guards.
    const manifest = { ...aiClassify, slug: 'obj-default-ing', input: { needed: null, container_names: {} } };
    const tool = buildIngredientTool(manifest);
    expect(tool.inputSchema.properties.container_names?.type).toBe('object');
    expect(tool.inputSchema.required).not.toContain('container_names');
    expect(tool.inputSchema.required).toContain('needed');
  });

  it('heuristic infers array-of-string for null defaults on *_categories keys', () => {
    const tool = buildIngredientTool(aiClassify);
    const prop = tool.inputSchema.properties['llm.categories'];
    expect(prop?.type).toBe('array');
  });

  it('additionalProperties is true — agents can pass ingredient-specific extras', () => {
    const tool = buildIngredientTool(aiClassify);
    expect(tool.inputSchema.additionalProperties).toBe(true);
  });

  it('omits prototype-sensitive manifest input keys from the tool schema', () => {
    const manifest = {
      ...aiClassify,
      input: JSON.parse(
        '{"safe":null,"__proto__":null,"constructor":null,"prototype":null}',
      ) as Record<string, unknown>,
    };

    const tool = buildIngredientTool(manifest);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['safe']);
    expect(tool.inputSchema.required).toEqual(['safe']);
    expect(Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, '__proto__')).toBe(false);
  });

  /** ⛔⛔ RESTORED — D-228 slice 2 moved this test's contract, and slice 2 was
   *  REVERTED. `kernel-only` is a kernel READ, and the assertion that it stays
   *  HIDDEN is the regression guard: it fails the moment kernel exposure is
   *  re-derived from `risk_tier`, which is exactly the change that must not
   *  re-land while `http-watcher` (SSRF) and `webhook-watcher` (destructive,
   *  labelled `read`) are still authored `read`. See the fence's own comment in
   *  `mcp-server.ts` for the two preconditions. */
  it('kernel-authored ingredients stay hidden except the D-172 file content read surface', async () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(aiClassify);
    manifests.register(kernelIngredient);
    manifests.register(dataFileReadIngredient);
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests },
      baseVault: {},
    } as unknown as Parameters<typeof _testing.handleToolsList>[0];

    const res = await _testing.handleToolsList(deps) as {
      tools: Array<{ name: string }>;
    };
    const names = res.tools.map((tool) => tool.name);
    expect(names).toContain('recued_ingredient_ai-classify');
    expect(names).toContain('recued_ingredient_data-file-read');
    // ⛔ `kernel-only` is author `recued`, risk_tier `read`, and NOT on the
    // whitelist — so it stays hidden. A kernel READ being hidden is the whole
    // point: `risk_tier` is a presentation hint, not an authorization input.
    expect(names).not.toContain('recued_ingredient_kernel-only');
  });

  it('a dead bound contract advertises an EMPTY catalog (D-187 enumeration kill-switch); unbound + live see the full catalog', async () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(aiClassify);
    const base = {
      // ⚠ D-228 slice 6 — UNBOUND IS NOT UNGATED, and this fixture is where the
      // two used to be conflated. `boundContractId: undefined` means a token
      // carrying no CONTRACT; `inboundTokenAuthorize: undefined` means no token
      // at all. Production only ever produces the first here (a bearer resolves
      // to a record, hence a checklist), so the checklist belongs in the base
      // fixture — and this suite's subject is LIVENESS, which must be shown to
      // empty the catalog independently of the checklist.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests },
      baseVault: {},
    } as unknown as Parameters<typeof _testing.handleToolsList>[0];

    // Unbound but token-carrying (no boundContractId) → full catalog.
    const unbound = (await _testing.handleToolsList(base)) as {
      tools: Array<{ name: string }>;
    };
    expect(unbound.tools.map((t) => t.name)).toContain('recued_ingredient_ai-classify');

    // SAME deps, bound to a DEAD contract → empty catalog. The enumeration mirror
    // of the handleToolCall dispatch guard: a defunct door's tool names /
    // descriptions / schemas are not advertised. Short-circuits before the
    // per-token checklist filter, so liveness — not the checklist — is the reason.
    const dead = (await _testing.handleToolsList({
      ...base,
      boundContractId: 'ct_dead',
      boundContractActive: false,
    })) as { tools: unknown[] };
    expect(dead.tools).toEqual([]);

    // A LIVE bound contract is NOT emptied by the liveness guard (it only flips
    // the catalog when the contract is dead — the per-token checklist governs
    // WHICH tools a live door sees, elsewhere).
    const live = (await _testing.handleToolsList({
      ...base,
      boundContractId: 'ct_live',
      boundContractActive: true,
    })) as { tools: Array<{ name: string }> };
    expect(live.tools.map((t) => t.name)).toContain('recued_ingredient_ai-classify');
  });
});

// ────────────────────────────────────────────────────────────────
// Extension-first tool-list merge
// ────────────────────────────────────────────────────────────────

import { _testing } from '../mcp-server.js';

describe('MCP protocol version negotiation', () => {
  const modernMeta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };

  it('advertises newest-first multi-version support through server/discover', async () => {
    const response = await _testing.dispatch({
      jsonrpc: '2.0',
      id: 'discover',
      method: 'server/discover',
      params: { _meta: modernMeta },
    }, makeDeps() as McpDeps) as {
      result: {
        supportedVersions: string[];
        ttlMs: number;
        cacheScope: string;
        _meta: Record<string, unknown>;
      };
    };

    expect(response.result.supportedVersions).toEqual([
      '2026-07-28',
      '2024-11-05',
    ]);
    expect(response.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 300_000,
      cacheScope: 'private',
    });
    expect(response.result._meta).toMatchObject({
      'io.modelcontextprotocol/serverInfo': { name: 'recued', version: '0.1.0' },
    });
  });

  it('stamps ordinary modern results with server identity', async () => {
    const response = await _testing.dispatch({
      jsonrpc: '2.0',
      id: 'list',
      method: 'tools/list',
      params: { _meta: modernMeta },
    }, makeDeps() as McpDeps) as {
      result: { tools: unknown[]; _meta: Record<string, unknown> };
    };

    expect(response.result.tools.length).toBeGreaterThan(0);
    expect(response.result).toMatchObject({ resultType: 'complete' });
    expect(response.result._meta).toMatchObject({
      'io.modelcontextprotocol/serverInfo': { name: 'recued', version: '0.1.0' },
    });
  });

  it('selects the implemented legacy fallback during initialize', async () => {
    const response = await _testing.dispatch({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'legacy-test', version: '1' },
      },
    }, makeDeps() as McpDeps) as { result: { protocolVersion: string } };

    expect(response.result.protocolVersion).toBe('2024-11-05');
  });

  it('rejects undeclared modern revisions instead of silently serving them', async () => {
    const response = await _testing.dispatch({
      jsonrpc: '2.0',
      id: 'future',
      method: 'tools/list',
      params: {
        _meta: {
          ...modernMeta,
          'io.modelcontextprotocol/protocolVersion': '2099-01-01',
        },
      },
    }, makeDeps() as McpDeps) as {
      error: { code: number; data: { supported: string[]; requested: string } };
    };

    expect(response.error).toEqual({
      code: -32022,
      message: 'Unsupported MCP protocol version: 2099-01-01',
      data: {
        supported: ['2026-07-28', '2024-11-05'],
        requested: '2099-01-01',
      },
    });
  });

  it('rejects incomplete modern request metadata as invalid params', async () => {
    const response = await _testing.dispatch({
      jsonrpc: '2.0',
      id: 'missing-capability',
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1' },
        },
      },
    }, makeDeps() as McpDeps) as { error: { code: number } };

    expect(response.error.code).toBe(-32602);
  });
});

describe('MCP tool: recued_runRecipe held projection', () => {
  it('projects a held recued_runRecipe result to the clean awaiting_approval shape', async () => {
    const tool: IngredientManifest = {
      slug: 'held-tool',
      name: 'Held Tool',
      description: 'Held approval tool',
      author: 'test',
      kind: 'http',
      category: 'action',
      // D-187 slice 4 — the hold now comes from op-risk: a `destructive` op is an
      // ALWAYS-ASK (the floor trust can't relax), so the recipe holds for approval
      // regardless of the door ceiling. The prior `admin` + overlay `approval_tier: 'ask'`
      // hold path is retired (the overlay cell is no longer consulted, and an `admin` op
      // relaxes under the MCP door's admin ceiling).
      risk_tier: 'destructive',
      version: 1,
      input: {
        method: 'POST',
        url: 'https://example.test/held',
      },
      output: {
        ok: 'ok',
      },
    };
    const recipe: RecipeDefinition = {
      recipe_id: 'held-recipe',
      version: 1,
      ttl: 60,
      metadata: {
        name: 'Held Recipe',
        description: 'Requires user approval',
        author: 'test',
        supported_platforms: ['test'],
      },
      variables: {},
      prefetch_steps: [],
      steps: [
        {
          id: 'approval_step',
          ingredient: 'held-tool',
          input: {
            body: {
              value: 'needs approval',
            },
          },
        },
      ],
      output: {
        sidebar: [],
      },
    };
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(tool);
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(recipe);
    const checkpointStore = {
      write: vi.fn(async () => undefined),
    };
    const commitStore = {
      writePending: vi.fn().mockResolvedValue(undefined),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
    };
    const contractOverlay: ExecuteHandlerDeps['contractOverlay'] = {
      shouldMeterUse: vi.fn(() => true),
      recordUse: vi.fn(),
      isContractLive: vi.fn(() => true),
    };

    const customerUsage = {
      reserve: vi.fn(() => ({ admitted: true as const })),
      reserveOnce: vi.fn(() => ({ admitted: true as const })),
      commit: vi.fn(),
      release: vi.fn(),
      denialMessage: vi.fn(() => undefined),
    };
    const dispatch = createMcpHttpDispatch({
      recipeStore,
      executorConfig: { manifests },
      baseVault: {},
      commitStore: commitStore as unknown as ExecuteHandlerDeps['commitStore'],
      checkpointStore: checkpointStore as unknown as ExecuteHandlerDeps['checkpointStore'],
      auditLog: {
        append: vi.fn(async () => undefined),
      } as unknown as ExecuteHandlerDeps['auditLog'],
      contractOverlay,
      customerUsage,
      // ⚠ D-228 slice 1 — this harness passes deps inline rather than through a
      // `const deps` literal, so it needs the authorizer of its own. Grants
      // everything: the subject is the HELD PROJECTION, not catalog derivation.
      inboundTokenAuthorize: () => true,
    } as unknown as McpDeps);
    const envelope = await dispatch({
      jsonrpc: '2.0',
      id: 'held-metering',
      method: 'tools/call',
      params: {
        name: 'recued_runRecipe',
        arguments: { recipe_id: 'held-recipe' },
      },
    }, 'held-bearer') as { result: unknown };
    const response = envelope.result;

    expect((response as { isError?: boolean }).isError).toBeUndefined();
    const text = (response as { content: Array<{ text?: string }> }).content[0]?.text;
    expect(text).toBeTruthy();
    const parsed = JSON.parse(text ?? '{}') as Record<string, unknown>;
    expect(parsed.status).toBe('awaiting_approval');
    expect(parsed.awaiting_approval).toBe(true);
    expect(parsed.recipe_id).toBe('held-recipe');
    expect(typeof parsed.message).toBe('string');
    expect(parsed.message).toContain('queued for the user');
    expect(parsed.success).toBeUndefined();
    expect(parsed.steps).toBeUndefined();
    expect(parsed.errors).toBeUndefined();
    expect(parsed.output).toBeUndefined();
    expect(checkpointStore.write).toHaveBeenCalledTimes(1);
    expect(customerUsage.reserve).not.toHaveBeenCalled();
    expect(customerUsage.reserveOnce).not.toHaveBeenCalled();
    expect(customerUsage.commit).not.toHaveBeenCalled();
    expect(customerUsage.release).toHaveBeenCalledTimes(1);
  });
});

const registryHttpManifest = (slug: string): IngredientManifest => ({
  slug,
  name: slug,
  description: `Registry MCP fixture ${slug}`,
  author: 'recued-core',
  kind: 'http',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  tags: ['test'],
  input: { url: 'https://example.com/fixture', method: 'GET' },
  output: { body: 'body' },
});

const registryTool = (name: string, tier: ToolEntry['tier']): ToolEntry => ({
  name,
  tier,
  description: `Registry tool ${name}`,
  arg_schema: { type: 'object' },
  topic_tags: [],
  classification: 'read',
  concurrency_safe: tier === 1,
});

const registryStub = (
  catalog: ReadonlyArray<ToolEntry>,
  dispatch: InternalToolRegistry['dispatch'] = async () => {
    throw new Error('registry dispatch should not fire');
  },
): InternalToolRegistry => ({
  list: () => catalog,
  listByTier: (tier) => catalog.filter((entry) => entry.tier === tier),
  getByName: (name) => catalog.find((entry) => entry.name === name) ?? null,
  dispatch,
  subscribeRefresh: () => () => undefined,
});

describe('D-153 P2.C — MCP registry-routed source + snapshot dispatch', () => {
  it('resolves an mcp ExecutionSource + ContractSnapshot for each Tier 1 recipe.run call', async () => {
    const captured: ChatDispatchContext[] = [];
    const registry = createInternalToolRegistry({
      tier1Handlers: {
        'recipe.run': async (_raw, ctx) => {
          captured.push(ctx);
          return { ok: true, result: { received: true } };
        },
      },
    });
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(registryHttpManifest('alpha-http'));
    manifests.register(registryHttpManifest('beta-http'));
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests },
      baseVault: {},
      internalRegistry: registry,
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    await _testing.handleToolCall(
      { name: 'recipe.run', arguments: { recipe_id: 'alpha' } },
      deps,
    );
    await _testing.handleToolCall(
      { name: 'recipe.run', arguments: { recipe_id: 'beta' } },
      deps,
    );

    expect(captured).toHaveLength(2);
    expect(captured[0]?.execution_source).not.toBe(captured[1]?.execution_source);
    expect(captured[0]?.contract_snapshot).not.toBe(captured[1]?.contract_snapshot);
    for (const ctx of captured) {
      expect(ctx.channel).toBe('mcp_wire');
      expect(ctx.mcp_token_id).toBe(_testing.STDIO_MCP_TOKEN_ID);
      const source = ctx.execution_source as Extract<ExecutionSource, { channel: 'mcp' }>;
      expect(source.channel).toBe('mcp');
      expect(source.actor).toBe('contracted_user');
      expect(source.agent_id).toBe('stdio_local');
      expect(source.mcp_token_id).toBe('stdio_local');
      expect(source.contract_id).toBe('stdio_local');
      expect(source.tool_call_id).toMatch(/^mcp-[0-9a-z]+-[0-9a-z]+$/);

      const snapshot = ctx.contract_snapshot;
      expect(snapshot?.contract_id).toBe(source.contract_id);
      expect(snapshot?.contract_version).toMatch(/^authority-sha256-v1:[0-9a-f]{64}$/);
      expect(snapshot?.allowed_tools).toEqual(['alpha-http', 'beta-http']);
      expect(snapshot?.approval_required).toEqual([]);
      expect(snapshot?.scope_restrictions).toEqual([]);
      expect(typeof snapshot?.resolved_at).toBe('number');
    }
  });

  it('does not resolve mcp source/snapshot for unknown registry names', async () => {
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      internalRegistry: registryStub([]),
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    await expect(
      _testing.handleToolCall(
        { name: 'unknown.registry.tool', arguments: {} },
        deps,
      ),
    ).rejects.toThrow(/Unknown tool: unknown\.registry\.tool/);
  });

  it('short-circuits Tier 3 entries before mcp source/snapshot resolution', async () => {
    let dispatchCalls = 0;
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      internalRegistry: registryStub(
        [registryTool('exa.web_search', 3)],
        async () => {
          dispatchCalls += 1;
          return { ok: true, result: {} };
        },
      ),
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    const res = await _testing.handleToolCall(
      { name: 'exa.web_search', arguments: { q: 'recued' } },
      deps,
    );

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res as { content: Array<{ text: string }> }).content[0].text)
      .toMatch(/not exposed on the MCP wire/);
    expect(dispatchCalls).toBe(0);
  });
});

describe('MCP extension-first tool catalog', () => {
  const serverOnly: IngredientManifest = {
    slug: 'server-only-thing',
    name: 'Server Only',
    description: 'on the server',
    author: 'recued-core',
    kind: 'http',
    version: 1,
    category: 'data',
    risk_tier: 'read',
    tags: [],
    input: { x: null },
    output: {},
  };
  const extOnly: IngredientManifest = {
    slug: 'ext-only-thing',
    name: 'Ext Only',
    description: 'on the extension',
    author: 'recued-core',
    kind: 'http',
    version: 1,
    category: 'data',
    risk_tier: 'read',
    tags: [],
    input: { x: null },
    output: {},
  };
  const sharedServerView: IngredientManifest = {
    slug: 'shared-thing',
    name: 'Shared (server view)',
    description: 'server sees this too',
    author: 'recued-core',
    kind: 'http',
    version: 1,
    category: 'data',
    risk_tier: 'read',
    tags: [],
    input: { x: null },
    output: {},
  };
  const sharedExtView: IngredientManifest = {
    ...sharedServerView,
    name: 'Shared (ext view)',
    description: 'extension is authoritative when both have it',
  };

  const makeDepsWithExt = (
    extList: Array<{ slug: string; manifest: IngredientManifest }> | null,
  ): ExecuteHandlerDeps & { wsServer: { listExtensionIngredients: () => Promise<typeof extList>; runKernelRecipeOnExtension: unknown } } => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(serverOnly);
    manifests.register(sharedServerView);
    const recipeStore = createRecipeStore('/nonexistent');
    return {
      recipeStore,
      executorConfig: { manifests },
      baseVault: {},
      wsServer: {
        listExtensionIngredients: async () => extList,
        runKernelRecipeOnExtension: async () => ({ ok: true }),
      },
    };
  };

  it('when extension is offline (null list) returns the server-only catalog', async () => {
    const deps = makeDepsWithExt(null) as unknown as Parameters<typeof _testing.buildRouteMap>[0];
    const { routes } = await _testing.buildRouteMap(deps);
    const slugs = [...routes.entries()].filter(([, target]) => target === 'server').map(([s]) => s);
    expect(slugs.sort()).toEqual(['server-only-thing', 'shared-thing']);
  });

  it('when extension online, extension ingredients override server on shared slugs', async () => {
    const deps = makeDepsWithExt([
      { slug: 'ext-only-thing', manifest: extOnly },
      { slug: 'shared-thing', manifest: sharedExtView },
    ]) as unknown as Parameters<typeof _testing.buildRouteMap>[0];
    const { routes, extManifests } = await _testing.buildRouteMap(deps);
    expect(routes.get('ext-only-thing')).toBe('extension');
    expect(routes.get('shared-thing')).toBe('extension');         // ext wins on overlap
    expect(routes.get('server-only-thing')).toBe('server');        // server fills the gap
    expect(extManifests.get('shared-thing')?.description)
      .toBe('extension is authoritative when both have it');       // ext manifest wins
  });

  it('when wsServer is undefined, routes default to server-only', async () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(serverOnly);
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests },
      baseVault: {},
      // wsServer intentionally absent
    } as unknown as Parameters<typeof _testing.buildRouteMap>[0];
    const { routes } = await _testing.buildRouteMap(deps);
    expect([...routes.values()].every((t) => t === 'server')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Per-ingredient dispatch — server-route vs extension-route
// End-to-end through _testing.handleToolCall so the routing, the
// kernel-recipe dispatch envelope, and the thin audit receipt are all
// exercised without standing up a real stdio JSON-RPC transport.
// ────────────────────────────────────────────────────────────────

describe('MCP per-ingredient dispatch', () => {
  // D-112: `url` + `method` are engine-locked — recipes can't override
  // them. Manifest must declare the final URL; step input supplying `url`
  // is silently stripped at dispatch. Static values here let the HTTP
  // adapter route correctly; tests stub globalThis.fetch for the actual
  // response.
  const httpTool: IngredientManifest = {
    slug: 'fetch-thing',
    name: 'Fetch Thing',
    description: 'Server-resident HTTP ingredient.',
    author: 'recued-core',
    kind: 'http',
    version: 1,
    category: 'data',
    risk_tier: 'read',
    tags: [],
    input: { url: 'https://example.com/fixture', method: 'GET' },
    output: { body: 'body' },
  };

  const domTool: IngredientManifest = {
    slug: 'read-page',
    name: 'Read Page',
    description: 'Extension-side DOM ingredient.',
    author: 'recued-core',
    kind: 'dom',
    version: 1,
    category: 'data',
    risk_tier: 'read',
    tags: [],
    input: { selector: null },
    output: { text: 'text' },
  };

  const emptyAuditLog = () => {
    const activities: Array<{ action: string; target: string; detail?: string }> = [];
    return {
      activities,
      store: {
        append: async () => {},
        listRecent: async () => [],
        listByRecipe: async () => [],
        get: async () => null,
        clearOlderThan: async () => 0,
        clearByRecipe: async () => 0,
        exportAll: async () => [],
        size: async () => 0,
        clearAll: async () => {},
        logActivity: async (e: { action: string; target: string; detail?: string }) => {
          activities.push({ action: e.action, target: e.target, detail: e.detail });
        },
        listActivities: async () => [],
        exportActivities: async () => [],
      },
    };
  };

  it('routes an extension-held slug through wsServer.runKernelRecipeOnExtension + writes mcp_dispatch audit receipt', async () => {
    const manifests = createManifestRegistry('/nonexistent');
    const delegations: Array<{ recipe: string; config: unknown }> = [];
    const audit = emptyAuditLog();
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests },
      baseVault: {},
      auditLog: audit.store,
      wsServer: {
        listExtensionIngredients: async () => [{ slug: 'read-page', manifest: domTool }],
        runKernelRecipeOnExtension: async (recipe_id: string, config: unknown) => {
          delegations.push({ recipe: recipe_id, config });
          return { success: true, output: { text: 'hello' } };
        },
      },
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    const res = await _testing.handleToolCall(
      { name: 'recued_ingredient_read-page', arguments: { selector: 'h1' } },
      deps,
    );

    expect(delegations).toEqual([{
      recipe: 'run-ingredient',
      config: { ingredient_slug: 'read-page', input: { selector: 'h1' } },
    }]);
    expect((res as { isError?: boolean }).isError).toBeUndefined();
    expect(audit.activities).toHaveLength(1);
    expect(audit.activities[0].action).toBe('mcp_dispatch');
    expect(audit.activities[0].target).toBe('read-page');
    expect(audit.activities[0].detail).toMatch(/via=extension/);
    expect(audit.activities[0].detail).toMatch(/status=returned/);
  });

  it('writes a failed audit receipt when the extension delegation rejects', async () => {
    const manifests = createManifestRegistry('/nonexistent');
    const audit = emptyAuditLog();
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests },
      baseVault: {},
      auditLog: audit.store,
      wsServer: {
        listExtensionIngredients: async () => [{ slug: 'read-page', manifest: domTool }],
        runKernelRecipeOnExtension: async () => { throw new Error('pair-ws closed'); },
      },
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    const res = await _testing.handleToolCall(
      { name: 'recued_ingredient_read-page', arguments: {} },
      deps,
    );

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(audit.activities).toHaveLength(1);
    expect(audit.activities[0].detail).toMatch(/status=failed/);
  });

  it('server-resident slug dispatches via kernel run-ingredient recipe and returns the result', async () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(httpTool);
    const recipeStore = createRecipeStore('/nonexistent');
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      recipeStore,
      executorConfig: { manifests },
      baseVault: {},
      // wsServer undefined — server-only routing.
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    const executionSource = _testing.buildMcpExecutionSource(deps) as Extract<ExecutionSource, { channel: 'mcp' }>;
    expect(executionSource.agent_id).toBe('stdio_local');
    expect(executionSource.tool_call_id).toMatch(/^mcp-[a-z0-9]+-[a-z0-9]+$/);
    expect(executionSource.mcp_token_id).toBe(_testing.STDIO_MCP_TOKEN_ID);
    expect(executionSource.contract_id).toBe(executionSource.mcp_token_id);

    const contractSnapshot = _testing.buildMcpContractSnapshot(executionSource, deps);
    expect(contractSnapshot.contract_id).toBe(executionSource.contract_id);
    expect(contractSnapshot.allowed_tools).toContain('fetch-thing');
    expect(contractSnapshot.approval_required).toEqual([]);
    expect(contractSnapshot.contract_version).toMatch(/^authority-sha256-v1:[0-9a-f]{64}$/);
    expect(contractSnapshot.scope_restrictions).toEqual([]);
    expect(typeof contractSnapshot.resolved_at).toBe('number');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ body: 'stubbed' }), {
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response;
    try {
      const res = await _testing.handleToolCall(
        { name: 'recued_ingredient_fetch-thing', arguments: {} },
        deps,
      );

      const parsed = JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.recipe_id).toBe('run-ingredient');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('inboundTokenAuthorize filters allowed_tools and the per-tool grant gate rejects first', async () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register({ ...httpTool, slug: 'allowed-slug', name: 'Allowed Slug' });
    manifests.register({ ...httpTool, slug: 'forbidden-slug', name: 'Forbidden Slug' });
    const deps = {
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests },
      baseVault: {},
      inboundTokenAuthorize: (slug: string) => slug === 'allowed-slug',
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    const executionSource = _testing.buildMcpExecutionSource(deps) as Extract<ExecutionSource, { channel: 'mcp' }>;
    const contractSnapshot = _testing.buildMcpContractSnapshot(executionSource, deps);
    expect(contractSnapshot.allowed_tools).toEqual(['allowed-slug']);

    const res = await _testing.handleToolCall(
      { name: 'recued_ingredient_forbidden-slug', arguments: {} },
      deps,
    );

    expect((res as { isError?: boolean }).isError).toBe(true);
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toMatch(/not granted/);
    expect(text).toMatch(/forbidden-slug/);
  });

  it('unknown slug on server route surfaces a clear error', async () => {
    const manifests = createManifestRegistry('/nonexistent');
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests },
      baseVault: {},
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    const res = await _testing.handleToolCall(
      { name: 'recued_ingredient_nope', arguments: {} },
      deps,
    );

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res as { content: Array<{ text: string }> }).content[0].text).toMatch(/Unknown ingredient/);
  });

  it('when the extension is offline mid-flight, falls through to the server route', async () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(httpTool);
    const audit = emptyAuditLog();
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests },
      baseVault: {},
      auditLog: audit.store,
      wsServer: {
        listExtensionIngredients: async () => { throw new Error('extension offline'); },
        runKernelRecipeOnExtension: async () => { throw new Error('should not be called'); },
      },
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ body: 'server-served' }), {
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response;
    try {
      const res = await _testing.handleToolCall(
        { name: 'recued_ingredient_fetch-thing', arguments: {} },
        deps,
      );

      const parsed = JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
      expect(parsed.success).toBe(true);
      // No mcp_dispatch receipt when the call landed on the server — the
      // audit path only fires for extension-routed dispatches.
      expect(audit.activities).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // (removed) The inline RUN_INGREDIENT_RECIPE is now the sole source — community/recipes/run-ingredient.json
  // was deleted in the kernel/community separation. RUN_INGREDIENT_RECIPE is exercised by the dispatch
  // tests above (server-resident slug → kernel run-ingredient recipe).
});

// ────────────────────────────────────────────────────────────────
// D-171 slice-2c follow-on #1 — legacy grant-catalog projection
// ────────────────────────────────────────────────────────────────

describe('D-171 slice-2c follow-on #1 — buildMcpGrantCatalogLegacyEntries', () => {
  const ingredient = (
    slug: string,
    risk_tier: IngredientManifest['risk_tier'],
    author = 'recued-core',
  ): IngredientManifest => ({
    slug,
    name: slug,
    description: `Fixture ${slug}`,
    author,
    kind: 'http',
    version: 1,
    category: 'data',
    risk_tier,
    tags: [],
    input: { url: 'https://example.com', method: 'GET' },
    output: { body: 'body' },
  });

  const buildManifests = () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(ingredient('reader-thing', 'read'));
    manifests.register(ingredient('writer-thing', 'write'));
    manifests.register(ingredient('admin-thing', 'admin'));
    // Kernel-authored ingredient — implementation detail, never a grantable tool.
    // ⛔ RESTORED to `read` (D-228 slice 2 made it `write`, and was reverted).
    // A kernel READ that is not whitelisted must classify as ungrantable; a
    // `write` fixture would pass under risk-derived exposure too, and so could
    // not witness the difference.
    manifests.register(ingredient('kernel-thing', 'read', 'recued'));
    // D-172 explicit exception — file content leaves through a Gateway-gated
    // run-ingredient MCP tool, so it must be grantable by door tokens.
    manifests.register({
      // D-228 slice 2 — the shipped manifest authors `mcp_exposed: true`; the
      // generic helper does not, and that asymmetry IS the policy: every other
      // kernel ingredient here is fenced by omitting it.
      ...ingredient('data-file-read', 'read', 'recued'),
      mcp_exposed: true,
    });
    return manifests;
  };

  const grantCatalogMetaToolNames = () =>
    _testing.STATIC_TOOLS
      .map((tool) => tool.name)
      .filter((name) => name !== 'recued_customerStatus');

  it('projects grant-cataloged recued_* meta tools with read/write/unknown classifications', () => {
    const entries = buildMcpGrantCatalogLegacyEntries(buildManifests());
    const byName = new Map(entries.map((e) => [e.name, e]));

    for (const name of grantCatalogMetaToolNames()) {
      expect(byName.has(name)).toBe(true);
    }
    expect(_testing.STATIC_TOOLS.map((tool) => tool.name)).toContain('recued_customerStatus');
    expect(byName.has('recued_customerStatus')).toBe(false);

    // Classifications: reads are read; saveRecipe writes; runRecipe is unknown
    // (runs an arbitrary recipe — mirrors Tier 1 `recipe.run`).
    expect(byName.get('recued_listRecipes')?.classification).toBe('read');
    expect(byName.get('recued_dataTimeline')?.classification).toBe('read');
    expect(byName.get('recued_contactEngagementsList')?.classification).toBe('read');
    expect(byName.get('recued_saveRecipe')?.classification).toBe('write');
    expect(byName.get('recued_runRecipe')?.classification).toBe('unknown');
  });

  it('does not project customer.status into inbound-token business-tool grants', () => {
    const entries = buildMcpGrantCatalogLegacyEntries(buildManifests());
    expect(entries.map((entry) => entry.name)).not.toContain('recued_customerStatus');
  });

  it('projects recued_ingredient_<slug> tools classified by risk_tier, skipping non-exposed kernel ingredients', () => {
    const entries = buildMcpGrantCatalogLegacyEntries(buildManifests());
    const byName = new Map(entries.map((e) => [e.name, e]));

    // read risk → read; write / admin risk → write (never under-stated as read).
    expect(byName.get('recued_ingredient_reader-thing')?.classification).toBe('read');
    expect(byName.get('recued_ingredient_writer-thing')?.classification).toBe('write');
    expect(byName.get('recued_ingredient_admin-thing')?.classification).toBe('write');

    // Generic kernel-authored ingredient is NOT exposed (mirrors handleToolsList).
    expect(byName.has('recued_ingredient_kernel-thing')).toBe(false);
    expect(byName.get('recued_ingredient_data-file-read')?.classification).toBe('read');
  });

  it('stamps every legacy entry tier:2 so buildDefaultMcpInboundTokenGrants defaults them off', () => {
    const entries = buildMcpGrantCatalogLegacyEntries(buildManifests());
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.tier === 2)).toBe(true);
  });

  it('returns only meta tools when no non-kernel ingredients are loaded', () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(ingredient('kernel-thing', 'read', 'recued'));
    const entries = buildMcpGrantCatalogLegacyEntries(manifests);
    expect(entries).toHaveLength(grantCatalogMetaToolNames().length);
    expect(entries.some((e) => e.name.startsWith('recued_ingredient_'))).toBe(false);
  });

  it('returns the data-file-read tool even when it is the only kernel-authored exposed ingredient', () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register({
      // D-228 slice 2 — the shipped manifest authors `mcp_exposed: true`; the
      // generic helper does not, and that asymmetry IS the policy: every other
      // kernel ingredient here is fenced by omitting it.
      ...ingredient('data-file-read', 'read', 'recued'),
      mcp_exposed: true,
    });
    const entries = buildMcpGrantCatalogLegacyEntries(manifests);
    expect(entries.map((entry) => entry.name)).toContain('recued_ingredient_data-file-read');
    expect(entries).toHaveLength(grantCatalogMetaToolNames().length + 1);
  });
});

describe('D-171 slice-2c follow-on #1 — allowed_tools admits recued_ingredient_<slug> grants', () => {
  const httpTool = (slug: string): IngredientManifest => ({
    slug,
    name: slug,
    description: `Fixture ${slug}`,
    author: 'recued-core',
    kind: 'http',
    version: 1,
    category: 'data',
    risk_tier: 'read',
    tags: [],
    input: { url: 'https://example.com', method: 'GET' },
    output: { body: 'body' },
  });

  it('admits the raw ingredient slug when only its recued_ingredient_ wire name is granted', () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(httpTool('gated-slug'));
    // The token grants the WIRE name the grant checklist exposes
    // (`recued_ingredient_gated-slug`), NOT the raw manifest slug. The wire
    // gate keys on wire names; the snapshot's allowed_tools keys on raw slugs.
    const deps = {
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests },
      baseVault: {},
      inboundTokenAuthorize: (name: string) =>
        name === 'recued_ingredient_gated-slug',
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    const source = _testing.buildMcpExecutionSource(deps);
    const snapshot = _testing.buildMcpContractSnapshot(source, deps);
    // Without the wire-name aliasing the raw slug would be excluded → the
    // run-ingredient step would die `tool_not_in_contract` at the policy gate.
    expect(snapshot.allowed_tools).toContain('gated-slug');
  });

  it('does NOT admit a slug whose wire name is not granted', () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(httpTool('granted-slug'));
    manifests.register(httpTool('denied-slug'));
    const deps = {
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests },
      baseVault: {},
      inboundTokenAuthorize: (name: string) =>
        name === 'recued_ingredient_granted-slug',
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    const source = _testing.buildMcpExecutionSource(deps);
    const snapshot = _testing.buildMcpContractSnapshot(source, deps);
    expect(snapshot.allowed_tools).toEqual(['granted-slug']);
  });
});

describe('D-171 slice-2c follow-on #1 — direct-return native tools record a contract use', () => {
  // A bound, active, in-scope MCP-door contract: `shouldMeterUse(...)` is true
  // for every mcp dispatch (the door contract is scoped `{ channels: ['mcp'] }`).
  const activeOverlay = () => {
    const recordUse = vi.fn();
    return {
      recordUse,
      overlay: {
        shouldMeterUse: () => true,
        recordUse,
        isContractLive: () => true,
      },
    };
  };
  // An unbound token: the synthetic contract id names no contract → INERT.
  const inertOverlay = () => {
    const recordUse = vi.fn();
    return {
      recordUse,
      overlay: {
        shouldMeterUse: () => false,
        recordUse,
        isContractLive: () => false,
      },
    };
  };

  it('records exactly one use for a direct-return native tool (closes the cap bypass)', async () => {
    const { overlay, recordUse } = activeOverlay();
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
      contractOverlay: overlay,
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    await _testing.handleToolCall({ name: 'recued_listRecipes', arguments: {} }, deps);

    // Without this the bound usage cap would never decrement for the native
    // reads / saveRecipe the follow-on exposed.
    expect(recordUse).toHaveBeenCalledTimes(1);
  });

  it('does not record a use for an unbound token (overlay resolves INERT)', async () => {
    const { overlay, recordUse } = inertOverlay();
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
      contractOverlay: overlay,
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    await _testing.handleToolCall({ name: 'recued_listRecipes', arguments: {} }, deps);

    expect(recordUse).not.toHaveBeenCalled();
  });

  it('excludes recued_runRecipe from the direct-return recording (it records per dispatch in handleExecute)', async () => {
    const { overlay, recordUse } = activeOverlay();
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
      contractOverlay: overlay,
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];

    // Missing recipe → handleExecute errors before any ingredient dispatch, so
    // it records nothing; the pre-switch path excludes runRecipe → zero uses.
    // (Had runRecipe NOT been excluded, the pre-switch recording would fire once
    // → double-counting once a recipe with ingredient steps actually runs.)
    await _testing.handleToolCall(
      { name: 'recued_runRecipe', arguments: { recipe_id: 'does-not-exist' } },
      deps,
    );

    expect(recordUse).not.toHaveBeenCalled();
  });
});

describe('D-187: direct-return native tools are op-risk gated — the retired policy_matrix overlay cell no longer governs them', () => {
  // A bound, active, in-scope MCP-door contract overlay for every mcp dispatch
  // (door contract scoped `{ channels: ['mcp'] }`). The `_cell` arg is retained
  // only to document the retired matrix-overlay cell shape these tests prove is
  // NO LONGER consulted — the overlay it returns ignores it entirely.
  const overlayWithCell = (_cell: unknown) => {
    const recordUse = vi.fn();
    return {
      recordUse,
      overlay: { shouldMeterUse: () => true, recordUse, isContractLive: () => true },
    };
  };
  // D-187 — a real inbound `mcpTokenId` (a delegated door bearer) is the "not the owner"
  // signal `resolveTrustCeiling` keys on: absent → the owner's own stdio client (the
  // STDIO_MCP_TOKEN_ID sentinel → admin ceiling); present → a delegated door (→ contracted
  // LOW, whether or not it also carries a bound contract).
  const depsWith = (overlay: unknown, mcpTokenId?: string, contractScan?: ScanFn) =>
    ({
      // D-228 slice 6 — an absent checklist denies, and this suite's subject is
      // the OVERLAY (what a door's policy matrix does to a native read/write),
      // which only has meaning once gate A has admitted. Without this the
      // overlay would never be consulted and every assertion here would pass
      // for the wrong reason.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
      contractOverlay: overlay,
      ...(mcpTokenId !== undefined ? { mcpTokenId } : {}),
      ...(contractScan !== undefined ? { contractScan } : {}),
    }) as unknown as Parameters<typeof _testing.handleToolCall>[1];
  const isError = (res: unknown): boolean => (res as { isError?: boolean }).isError === true;

  it('D-187: overlay denied_ingredient_ids no longer refuses a native read — ACCESS is gate A (per-token grant)', async () => {
    // The matrix overlay's `denied_ingredient_ids` is no longer consulted by
    // `admitMcpDirectDispatch` (op-risk governs approval; gate A — the per-token grant,
    // passed upstream — is the access authority). A native read is never-class → admits
    // under any door ceiling, so it proceeds + meters despite the cell naming it.
    const { overlay, recordUse } = overlayWithCell({
      denied_ingredient_ids: ['recued_listRecipes'],
    });
    const res = await _testing.handleToolCall(
      { name: 'recued_listRecipes', arguments: {} },
      depsWith(overlay),
    );
    expect(isError(res)).toBe(false);
    expect(recordUse).toHaveBeenCalledTimes(1);
  });

  it('D-187: an overlay approval_tier no longer escalates a native read — reads are never-class', async () => {
    // The overlay's `approval_tier` is retired; a native read (never-class) admits under
    // any door ceiling, so the direct path proceeds + meters (no approval refusal).
    const { overlay, recordUse } = overlayWithCell({ approval_tier: 'ask' });
    const res = await _testing.handleToolCall(
      { name: 'recued_listRecipes', arguments: {} },
      depsWith(overlay),
    );
    expect(isError(res)).toBe(false);
    expect(recordUse).toHaveBeenCalledTimes(1);
  });

  it('D-187: the UNBOUND owner admits recued_saveRecipe (write) — full owner trust, overlay ignored', async () => {
    // No `boundContractId` → the unbound owner's own token → the contract-LESS owner
    // ceiling (`admin`), under which a `write` (recued_saveRecipe) admits. The retired
    // overlay cell is ignored. (This preserves the prior no-overlay PROCEED for the owner;
    // the bound-door case below is where the write surfaces.)
    const { overlay, recordUse } = overlayWithCell({ max_risk_without_approval: 'read' });
    const res = await _testing.handleToolCall(
      { name: 'recued_saveRecipe', arguments: { recipe: {} } },
      depsWith(overlay),
    );
    // Admission passed + metered (the save body may still fail on the empty recipe /
    // nonexistent store — incidental, post-admission).
    expect(recordUse).toHaveBeenCalledTimes(1);
  });

  it('D-187: a DELEGATED door REFUSES recued_saveRecipe (write) on the direct path — the AI write surfaces', async () => {
    // A real inbound `mcpTokenId` (≠ the owner sentinel) → a delegated AI door → the
    // contracted LOW ceiling (`read`), so a `write` (recued_saveRecipe) exceeds it →
    // `ask`, which the synchronous direct-return path cannot approval-resume → REFUSE
    // (before metering). This is the "AI writes surface" posture for a door's direct MCP
    // path; the refusal is op-risk × stage-trust, not the retired overlay cell. (An
    // unbound delegated door — a real token with no bound contract — is LOW too, the
    // codex slice-4 HIGH#2 case.)
    const { overlay, recordUse } = overlayWithCell(null);
    const res = await _testing.handleToolCall(
      { name: 'recued_saveRecipe', arguments: { recipe: {} } },
      depsWith(overlay, 'tok-inbound-door'),
    );
    expect(isError(res)).toBe(true);
    expect(JSON.stringify(res)).toContain('approval');
    expect(recordUse).not.toHaveBeenCalled();
  });

  it('D-211: one global owner approval holds the same native read for owner and delegated MCP callers', async () => {
    const scan: ScanFn = (scope, prefix) =>
      scope === 'owner_operation'
        && prefix[0] === 'recued_listRecipes'
        && prefix[1] === 'recued_listRecipes'
        ? [{
            segments: ['recued_listRecipes', 'recued_listRecipes'],
            value: { approval: 'always' },
          }]
        : [];

    const owner = overlayWithCell(null);
    const ownerResult = await _testing.handleToolCall(
      { name: 'recued_listRecipes', arguments: {} },
      depsWith(owner.overlay, undefined, scan),
    );
    expect(isError(ownerResult)).toBe(true);
    expect(JSON.stringify(ownerResult)).toContain('approval');
    expect(owner.recordUse).not.toHaveBeenCalled();

    const delegated = overlayWithCell(null);
    const delegatedResult = await _testing.handleToolCall(
      { name: 'recued_listRecipes', arguments: {} },
      depsWith(delegated.overlay, 'tok-inbound-door', scan),
    );
    expect(isError(delegatedResult)).toBe(true);
    expect(JSON.stringify(delegatedResult)).toContain('approval');
    expect(delegated.recordUse).not.toHaveBeenCalled();
  });

  it('admits + meters a native tool the cell does not deny (per-tool deny is exact)', async () => {
    const { overlay, recordUse } = overlayWithCell({
      denied_ingredient_ids: ['recued_getRecipe'], // a DIFFERENT tool
    });
    const res = await _testing.handleToolCall(
      { name: 'recued_listRecipes', arguments: {} },
      depsWith(overlay),
    );
    // Not denied → the read proceeds (empty list) + records exactly one use.
    expect(isError(res)).toBe(false);
    expect(recordUse).toHaveBeenCalledTimes(1);
  });

  it('does not refuse (nor fail closed) when the overlay is out-of-scope / inert', async () => {
    const recordUse = vi.fn();
    const overlay = {
      shouldMeterUse: () => false,
      recordUse,
      isContractLive: () => false,
    };
    const res = await _testing.handleToolCall(
      { name: 'recued_listRecipes', arguments: {} },
      depsWith(overlay),
    );
    // Out-of-scope ⇒ only the per-token grant gate stands; the call proceeds (the
    // overlay TIGHTENS in-scope — failing closed would over-restrict direct-return).
    expect(isError(res)).toBe(false);
    expect(recordUse).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// recued_saveRecipe — op-step acceptance (D-182)
//
// The recipe validator ACCEPTS op-steps, and so does the save tool now: the
// dispatch path (resolveCanonicalRecipeForDispatch) lowers + runs an inline,
// never-installed op-step recipe, so persisting one is no longer storing "an
// unrunnable recipe". A runnable op-step recipe SAVES; only a definitively-
// unrunnable op-step (here a canonical op with no type:'connection' variable)
// is rejected — via the shared checkInlineOpSteps both seams call.
// ────────────────────────────────────────────────────────────────

describe('MCP tool: recued_saveRecipe — op-step acceptance (D-182)', () => {
  const errored = (res: unknown): boolean => (res as { isError?: boolean }).isError === true;
  const errText = (res: unknown): string =>
    ((res as { content?: Array<{ text?: string }> }).content?.[0]?.text) ?? '';

  // recued_saveRecipe persists via recipeStore.save, which needs a real db
  // (makeDeps() uses a db-less store). Build a db-backed deps per test + close it.
  let saveDb: Database.Database | undefined;
  afterEach(() => {
    saveDb?.close();
    saveDb = undefined;
  });
  const dbDeps = (): Parameters<typeof _testing.handleToolCall>[1] => {
    saveDb = new Database(':memory:');
    return {
      // D-228 slice 6 — an absent checklist denies. This suite's subject is
      // `recued_saveRecipe`'s VALIDATION (op-step slots, D-201 webhook ingress),
      // which runs only after the gate admits the call.
      inboundTokenAuthorize: () => true,
      recipeStore: createRecipeStore('/nonexistent', saveDb),
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];
  };

  // A RUNNABLE bare-canonical op-step recipe: declares its capability dep AND a
  // type:'connection' variable for the slot the op binds at dispatch.
  const runnableOpStepRecipe = {
    recipe_id: 'mcp-op-step-recipe',
    version: 1,
    ttl: 300,
    metadata: {
      name: 'Op step',
      description: 'A connection-agnostic op-step recipe authored via MCP.',
      author: 'mcp',
      supported_platforms: [],
    },
    variables: { crm: { label: 'CRM', type: 'connection', connection_kind: 'api', default: '' } },
    prefetch_steps: [],
    steps: [{ id: 'deals', op: 'deal.search', args: { limit: 10 } }],
    dependencies: [{ capability: 'deal', ops: ['search'] }],
    output: { sidebar: [] },
  };

  // The SAME op-step but with NO connection variable — definitively unrunnable
  // (opStepConnectionSlots fails closed at dispatch), so the save tool rejects it.
  const slotlessOpStepRecipe = {
    ...runnableOpStepRecipe,
    recipe_id: 'mcp-slotless-op-step',
    variables: {},
  };

  const concreteRecipe = {
    ...runnableOpStepRecipe,
    recipe_id: 'mcp-concrete-recipe',
    steps: [{ id: 'msg', transform: 'template', template: 'hi' }],
    variables: {},
    dependencies: undefined, // no op-step → no dependency declaration needed
    output: { sidebar: [{ type: 'text', source: 'step.msg' }] },
  };

  it('saves a runnable op-step recipe (D-182 — no longer rejected)', async () => {
    const deps = dbDeps();
    const res = await _testing.handleToolCall(
      { name: 'recued_saveRecipe', arguments: { recipe: runnableOpStepRecipe } },
      deps,
    );
    expect(errored(res)).toBe(false);
    expect(deps.recipeStore.get('mcp-op-step-recipe')).toBeTruthy();
  });

  it('rejects a slotless op-step recipe (no type:connection variable) and does NOT persist it', async () => {
    const deps = dbDeps();
    const res = await _testing.handleToolCall(
      { name: 'recued_saveRecipe', arguments: { recipe: slotlessOpStepRecipe } },
      deps,
    );
    expect(errored(res)).toBe(true);
    expect(errText(res)).toMatch(/type:'connection' variable/);
    expect(deps.recipeStore.get('mcp-slotless-op-step')).toBeFalsy();
  });

  it('still saves a concrete (non-op-step) recipe', async () => {
    const deps = dbDeps();
    const res = await _testing.handleToolCall(
      { name: 'recued_saveRecipe', arguments: { recipe: concreteRecipe } },
      deps,
    );
    expect(errored(res)).toBe(false);
    expect(deps.recipeStore.get('mcp-concrete-recipe')).toBeTruthy();
  });

  it('D-201 rejects a standalone webhook recipe without an owner ingress selection', async () => {
    const deps = dbDeps();
    const webhookRecipe = {
      ...concreteRecipe,
      recipe_id: 'mcp-webhook-recipe',
      webhook_requirements: [{
        binding: 'generic_delivery',
        profile_ids: ['generic.static-header-token.v1'],
        required_event_types: ['delivery'],
        registration_modes: ['manual'],
        environment_policy: 'any',
        decoded_payload_access: 'metadata_only',
        source_truth_policy: 'delivery_payload_allowed',
      }],
      webhook_triggers: [{ binding: 'generic_delivery', event_types: ['delivery'] }],
    };
    const res = await _testing.handleToolCall(
      { name: 'recued_saveRecipe', arguments: { recipe: webhookRecipe } },
      deps,
    );
    expect(errored(res)).toBe(true);
    expect(errText(res)).toContain('owner-selected ingress binding');
    expect(deps.recipeStore.get('mcp-webhook-recipe')).toBeFalsy();
  });

  it('D-201 cannot overwrite an existing armed-capable Kitchen recipe outside owner control', async () => {
    const deps = dbDeps();
    const kitchenWebhook = {
      ...concreteRecipe,
      recipe_id: 'mcp-cannot-shadow-webhook',
      webhook_requirements: [{
        binding: 'generic_delivery',
        profile_ids: ['generic.static-header-token.v1'],
        required_event_types: ['delivery'],
        decoded_payload_access: 'metadata_only',
        source_truth_policy: 'delivery_payload_allowed',
      }],
      webhook_triggers: [{ binding: 'generic_delivery', event_types: ['delivery'] }],
    } as RecipeDefinition;
    deps.recipeStore.save(kitchenWebhook, 'kitchen', 'inline');
    const replacement = {
      ...concreteRecipe,
      recipe_id: kitchenWebhook.recipe_id,
      webhook_requirements: undefined,
      webhook_triggers: undefined,
    };

    const res = await _testing.handleToolCall(
      { name: 'recued_saveRecipe', arguments: { recipe: replacement } },
      deps,
    );
    expect(errored(res)).toBe(true);
    expect(errText(res)).toContain('owner-selected ingress binding');
    expect(deps.recipeStore.get(kitchenWebhook.recipe_id)?.webhook_triggers)
      .toHaveLength(1);
  });
});

describe('D-220 — recued_saveRecipe is gated by the form-field contract', () => {
  // ⛔⛔ Codex 3.2. The MCP tool called `recipeStore.save` directly, so the whole
  // D-220 gate was bypassable: an authenticated caller could save a recipe
  // requiring a field the live form does not collect, trigger reconciliation
  // would arm it, and every accepted submission after that fired the recipe with
  // the declared answer absent. The tool's own comment claimed to mirror the
  // local `recipe.save` seam; it validated schema and op-steps and nothing else.
  const FORM_ID = 'form_intake_1';

  const recipeRequiring = (field: string): Record<string, unknown> => ({
    recipe_id: 'intake-pair',
    version: 1,
    ttl: 0,
    metadata: {
      name: 'Intake pair',
      description: 'Pairs with an intake form.',
      author: 'mcp',
      requires_form_fields: [{ name: field, type: 'text', required: true }],
      supported_platforms: [],
    },
    event_triggers: [
      { on: 'form_response.accepted', where: { form_definition_id: FORM_ID } },
    ],
    steps: [{ id: 'noop', transform: 'trim', input: 'x' }],
    output: { render: [] },
  });

  const formCollecting = (...names: string[]): unknown => ({
    form_definition_id: FORM_ID,
    fields: names.map((name) => ({ name, type: 'text', required: true })),
  });

  /** The UNBOUND owner path — a delegated door refuses a `write` before the gate
   *  is ever reached, so a door bearer here would test door trust, not D-220. */
  const saveAsOwner = async (
    recipe: Record<string, unknown>,
    reader: ((id: string) => unknown) | undefined,
  ): Promise<{ isError: boolean; text: string; saved: unknown[] }> => {
    const saved: unknown[] = [];
    const deps = {
      // ⚠ D-228 slice 1 — a caller carrying no contract is offered nothing,
      // so an MCP harness must carry an authorizer. Grants everything: these
      // tests are about DISPATCH, not about catalog derivation.
      inboundTokenAuthorize: () => true,
      recipeStore: {
        ids: () => [],
        get: () => null,
        getStored: () => null,
        save: (definition: unknown) => { saved.push(definition); },
      },
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
      contractOverlay: null,
      ...(reader === undefined ? {} : { formDefinitionReader: reader }),
    } as unknown as Parameters<typeof _testing.handleToolCall>[1];
    const res = await _testing.handleToolCall(
      { name: 'recued_saveRecipe', arguments: { recipe } },
      deps,
    );
    return {
      isError: (res as { isError?: boolean }).isError === true,
      text: JSON.stringify(res),
      saved,
    };
  };

  it('⛔ REFUSES a recipe whose declared field the live form does not collect', async () => {
    const result = await saveAsOwner(recipeRequiring('item'), () => formCollecting('email'));
    expect(result.isError, result.text).toBe(true);
    expect(result.text).toContain('does not collect');
    // ⛔ And nothing was persisted — a refusal that still saved would be worse
    // than none, because trigger reconciliation arms from the stored row.
    expect(result.saved).toEqual([]);
  });

  it('accepts the same recipe when the form DOES collect it — the permitting case', async () => {
    // Without this the gate could be a blanket refusal of every MCP save, and a
    // refusal-only test could not tell the two apart.
    const result = await saveAsOwner(
      recipeRequiring('item'),
      () => formCollecting('item', 'email'),
    );
    expect(result.isError, result.text).toBe(false);
    expect(result.saved).toHaveLength(1);
  });

  it('fails CLOSED when the live form cannot be read', async () => {
    const result = await saveAsOwner(recipeRequiring('item'), () => {
      throw new Error('registry unavailable');
    });
    expect(result.isError, result.text).toBe(true);
    expect(result.text).toContain('unverified');
    expect(result.saved).toEqual([]);
  });

  it('stays inert with no reader wired, rather than refusing every save', async () => {
    // The absent-reader posture must match the rpc's: inert, not fail-closed, or
    // a host without the endpoint registry could save nothing at all.
    const result = await saveAsOwner(recipeRequiring('item'), undefined);
    expect(result.isError, result.text).toBe(false);
    expect(result.saved).toHaveLength(1);
  });
});
