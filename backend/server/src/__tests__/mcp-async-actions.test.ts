import { describe, expect, it } from 'vitest';
import { createInMemoryCollection } from '@recued/storage';
import type {
  ChatDispatchContext,
  ChatDispatchResult,
  InternalToolRegistry,
  ToolEntry,
} from '@recued/contracts';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import {
  MCP_ACTION_NOTIFICATION_METHOD,
  MCP_ACTION_STATUS_TOOL_NAME,
  createMcpActionStore,
  type McpActionRecord,
} from '../mcp-action-store.js';
import {
  MCP_RECIPE_CALLBACK_CAPABILITY,
  MCP_RECIPE_CALLBACK_NOTIFICATION_METHOD,
} from '../mcp-recipe-callback.js';
import {
  _testing,
  createMcpHttpDispatch,
  type McpDeps,
} from '../mcp-server.js';

const heldTool: ToolEntry = {
  name: 'seller/send-and-continue',
  tier: 2,
  description: 'send then continue',
  arg_schema: { type: 'object', properties: {} },
  topic_tags: ['mail'],
  classification: 'write',
  concurrency_safe: false,
};

const registry = (
  dispatch: (
    name: string,
    args: unknown,
    ctx: ChatDispatchContext,
  ) => Promise<ChatDispatchResult>,
): InternalToolRegistry => ({
  list: () => [heldTool],
  listByTier: (tier) => tier === 2 ? [heldTool] : [],
  getByName: (name) => name === heldTool.name ? heldTool : null,
  dispatch,
  subscribeRefresh: () => () => undefined,
});

const deps = (
  actionStore: ReturnType<typeof createMcpActionStore>,
  overrides: Partial<McpDeps> = {},
): McpDeps => ({
  recipeStore: createRecipeStore('/nonexistent'),
  executorConfig: { manifests: createManifestRegistry('/nonexistent') },
  baseVault: {},
  ownerAdmitAll: true,
  mcpTokenId: 'token-a',
  mcpActionStore: actionStore,
  checkpointStore: {
    listByRun: async (runId: string) => [{
      checkpoint_id: `cp-${runId}`,
      run_id: runId,
      recipe_id: 'r',
      gated_step_id: 'send',
      step_state: {},
      created_at: 1,
    }],
  } as McpDeps['checkpointStore'],
  ...overrides,
} as McpDeps);

describe('MCP held-action continuation surface', () => {
  it('advertises polling everywhere and notifications only on capable transports', async () => {
    const actions = createMcpActionStore(createInMemoryCollection<McpActionRecord>());
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    };
    const pollingOnly = await createMcpHttpDispatch(deps(actions))(initialize) as {
      result: { capabilities: { experimental: Record<string, Record<string, unknown>> } };
    };
    const capable = await createMcpHttpDispatch(deps(actions, {
      mcpActionNotifications: true,
    }))(initialize) as typeof pollingOnly;

    expect(pollingOnly.result.capabilities.experimental['com.recued/async-actions'])
      .toMatchObject({
        version: 1,
        queryTool: MCP_ACTION_STATUS_TOOL_NAME,
        notificationsAreHints: true,
      });
    expect(pollingOnly.result.capabilities.experimental['com.recued/async-actions'])
      .not.toHaveProperty('notificationMethod');
    expect(capable.result.capabilities.experimental['com.recued/async-actions'])
      .toMatchObject({ notificationMethod: MCP_ACTION_NOTIFICATION_METHOD });
  });

  it('advertises recipe callbacks only on an unsolicited transport with a bound authorizer', async () => {
    const actions = createMcpActionStore(createInMemoryCollection<McpActionRecord>());
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    };
    const pollingOnly = await createMcpHttpDispatch(deps(actions))(initialize) as {
      result: { capabilities: { experimental: Record<string, Record<string, unknown>> } };
    };
    const capable = await createMcpHttpDispatch(deps(actions, {
      mcpActionStore: undefined,
      sharedStore: {} as McpDeps['sharedStore'],
      mcpRecipeCallbackNotifications: true,
      mcpRecipeCallbackAuthorize: () => true,
    }))(initialize) as typeof pollingOnly;

    expect(pollingOnly.result.capabilities.experimental)
      .not.toHaveProperty(MCP_RECIPE_CALLBACK_CAPABILITY);
    expect(capable.result.capabilities.experimental[MCP_RECIPE_CALLBACK_CAPABILITY])
      .toMatchObject({
        version: 1,
        notificationMethod: MCP_RECIPE_CALLBACK_NOTIFICATION_METHOD,
        notificationsAreHints: true,
        delivery: 'at_least_once',
        callbackRefForDedupe: true,
      });
    expect(capable.result.capabilities.experimental)
      .not.toHaveProperty('com.recued/async-actions');
  });

  it('attaches one opaque action_ref and returns its eventual final result', async () => {
    const actions = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
      newActionRef: () => 'mcpact_e2e',
    });
    const d = deps(actions, {
      mcpActionNotifications: true,
      internalRegistry: registry(async () => ({
        ok: true,
        run_id: 'run-held',
        run_held: { kind: 'approval' },
        result: {
          status: 'awaiting_approval',
          awaiting_approval: true,
          message: 'waiting',
        },
      })),
    });

    const held = await _testing.handleToolCall(
      { name: heldTool.name, arguments: {} },
      d,
    ) as { structuredContent: Record<string, unknown> };

    expect(held.structuredContent).toMatchObject({
      status: 'awaiting_approval',
      action_ref: 'mcpact_e2e',
      action_query_tool: MCP_ACTION_STATUS_TOOL_NAME,
      action_notification_method: MCP_ACTION_NOTIFICATION_METHOD,
    });

    await actions.markRunning('run-held');
    await actions.finish('run-held', {
      status: 'completed',
      status_message: 'workflow finished',
      result: { invoice_id: 'inv-1', email_message_id: 'msg-1' },
    });

    const queried = await _testing.handleToolCall(
      { name: MCP_ACTION_STATUS_TOOL_NAME, arguments: { action_ref: 'mcpact_e2e' } },
      d,
    ) as { structuredContent: Record<string, unknown> };
    expect(queried.structuredContent).toMatchObject({
      action_ref: 'mcpact_e2e',
      status: 'completed',
      terminal: true,
      result: { invoice_id: 'inv-1', email_message_id: 'msg-1' },
    });
  });

  it('does not disclose an action to another valid MCP principal', async () => {
    const actions = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
      newActionRef: () => 'mcpact_private',
    });
    await actions.createHeld({
      run_id: 'run-private',
      principal_id: 'token-a',
      tool_name: 'mail.send',
      kind: 'recipe',
    });

    const response = await _testing.handleToolCall(
      { name: MCP_ACTION_STATUS_TOOL_NAME, arguments: { action_ref: 'mcpact_private' } },
      deps(actions, { mcpTokenId: 'token-b' }),
    ) as { isError?: boolean; content: Array<{ text: string }> };

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toBe('Async action not found for this MCP token.');
  });

  it('treats status as an active-token utility without widening business grants', async () => {
    const actions = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
      newActionRef: () => 'mcpact_door',
    });
    await actions.createHeld({
      run_id: 'run-door',
      principal_id: 'door-token',
      tool_name: heldTool.name,
      kind: 'recipe',
    });
    const d = deps(actions, {
      ownerAdmitAll: false,
      mcpTokenId: 'door-token',
      mcpPrincipalActive: () => true,
      inboundTokenAuthorize: (name) => name === heldTool.name,
    });

    const listed = await _testing.handleToolsList(d) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((tool) => tool.name)).toContain(MCP_ACTION_STATUS_TOOL_NAME);

    const queried = await _testing.handleToolCall(
      { name: MCP_ACTION_STATUS_TOOL_NAME, arguments: { action_ref: 'mcpact_door' } },
      d,
    ) as { structuredContent: Record<string, unknown> };
    expect(queried.structuredContent.status).toBe('awaiting_approval');
    expect(d.inboundTokenAuthorize?.(MCP_ACTION_STATUS_TOOL_NAME)).toBe(false);
  });

  it('hides and refuses the utility when the token liveness proof is gone', async () => {
    const actions = createMcpActionStore(createInMemoryCollection<McpActionRecord>());
    const d = deps(actions, {
      ownerAdmitAll: false,
      mcpPrincipalActive: () => false,
      inboundTokenAuthorize: () => true,
    });

    const listed = await _testing.handleToolsList(d) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((tool) => tool.name)).not.toContain(MCP_ACTION_STATUS_TOOL_NAME);
    const queried = await _testing.handleToolCall(
      { name: MCP_ACTION_STATUS_TOOL_NAME, arguments: { action_ref: 'anything' } },
      d,
    ) as { isError?: boolean; content: Array<{ text: string }> };
    expect(queried.isError).toBe(true);
    expect(queried.content[0]?.text).toMatch(/no longer active/);
  });

  it('keeps a prior action queryable after its business contract is revoked', async () => {
    const actions = createMcpActionStore(createInMemoryCollection<McpActionRecord>(), {
      newActionRef: () => 'mcpact_revoked_contract',
    });
    await actions.createHeld({
      run_id: 'run-revoked-contract',
      principal_id: 'door-token',
      tool_name: heldTool.name,
      kind: 'recipe',
      checkpoint_id: 'cp-revoked-contract',
    });
    await actions.finish('run-revoked-contract', {
      status: 'failed',
      status_message: 'Fresh authority denied the resume.',
      result: { status: 'failed', code: 'bound_contract_inactive' },
    });
    const d = deps(actions, {
      ownerAdmitAll: false,
      mcpTokenId: 'door-token',
      mcpPrincipalActive: () => true,
      boundContractId: 'contract-revoked',
      boundContractActive: false,
      inboundTokenAuthorize: () => false,
    });

    const listed = await _testing.handleToolsList(d) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((tool) => tool.name)).toEqual([MCP_ACTION_STATUS_TOOL_NAME]);
    const queried = await createMcpHttpDispatch(d)({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: MCP_ACTION_STATUS_TOOL_NAME,
        arguments: { action_ref: 'mcpact_revoked_contract' },
      },
    }) as { result: { structuredContent: Record<string, unknown> } };
    expect(queried.result.structuredContent).toMatchObject({
      status: 'failed',
      result: { code: 'bound_contract_inactive' },
    });
  });
});
