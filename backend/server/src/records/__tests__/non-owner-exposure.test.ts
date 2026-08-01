import { describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import {
  handleInboundTokenUpdateGrants,
  type ChatRpcDeps,
} from '../../chat-handler.js';
import {
  buildChatToolRegistryInputs,
  createChatTier2Dispatch,
  type ChatToolHandlerDeps,
} from '../../chat-tool-handlers.js';
import { _testing as mcpTesting, type McpDeps } from '../../mcp-server.js';
import { reconcileWebhookDoors } from '../../webhook-door-enroll.js';
import {
  RECORDS_NON_OWNER_CONTRACT_REFUSAL,
  RecordsNonOwnerExposureError,
  assertRecordsNonOwnerRecipeExposure,
} from '../non-owner-exposure.js';

const RECORDS_OP = 'publisher.example.project-pack.task.update';

const recipe = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'receive-project-change',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Receive project change',
    description: 'D-221 receiving recipe fixture.',
    author: 'publisher.example',
    supported_platforms: ['server'],
    tags: ['records'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'require_contract',
      transform: 'template',
      template: 'contract required',
      fail_on: RECORDS_NON_OWNER_CONTRACT_REFUSAL,
    },
    { id: 'write', op: RECORDS_OP, args: { id: 'task-1' } },
  ],
  output: { sidebar: [] },
  ...overrides,
});

const recordsInventory = {
  isOperationId: (operationId: string): boolean => operationId === RECORDS_OP,
  isCatalogOperation: (catalogSlug: string, operationKey: string): boolean =>
    catalogSlug === 'records-test-catalog' && operationKey === 'task.update',
};

describe('D-221 non-owner Records recipe exposure', () => {
  it('admits the exact host-owned first-step refusal and ignores non-Records recipes', () => {
    expect(() => assertRecordsNonOwnerRecipeExposure(recipe(), 'mcp', recordsInventory))
      .not.toThrow();
    const unrelated = recipe({
      steps: [{ id: 'unsafe_elsewhere', op: 'publisher.other.read' }],
    });
    expect(() => assertRecordsNonOwnerRecipeExposure(unrelated, 'mcp', recordsInventory))
      .not.toThrow();
    const lowered = recipe({
      steps: [
        recipe().steps[0]!,
        {
          id: 'lowered_write',
          ingredient: 'records-test-catalog',
          input: { operation: 'task.update', args: { id: 'task-1' } },
        },
      ],
    });
    expect(() => assertRecordsNonOwnerRecipeExposure(lowered, 'mcp', recordsInventory))
      .not.toThrow();
  });

  it.each([
    [
      'caller-supplied contract comparison',
      recipe({
        steps: [
          {
            id: 'wrong_authority',
            transform: 'template',
            template: 'wrong',
            fail_on: '{{config.contract_id}} is_null',
          },
          { id: 'write', op: RECORDS_OP },
        ],
      }),
    ],
    [
      'skip_when silent success',
      recipe({
        steps: [
          {
            id: 'skip',
            transform: 'template',
            template: 'wrong',
            skip_when: RECORDS_NON_OWNER_CONTRACT_REFUSAL,
          },
          { id: 'write', op: RECORDS_OP },
        ],
      }),
    ],
    [
      'missing refusal',
      recipe({
        steps: [
          { id: 'unguarded', transform: 'template', template: 'wrong' },
          { id: 'write', op: RECORDS_OP },
        ],
      }),
    ],
    [
      'prefetch before refusal',
      recipe({
        prefetch_steps: [{ id: 'leak', op: RECORDS_OP }],
      }),
    ],
    [
      'effectful refusal step',
      recipe({
        steps: [
          {
            id: 'too_late',
            op: RECORDS_OP,
            fail_on: RECORDS_NON_OWNER_CONTRACT_REFUSAL,
          },
        ],
      }),
    ],
  ])('refuses %s', (_case, subject) => {
    expect(() => assertRecordsNonOwnerRecipeExposure(subject, 'reception', recordsInventory))
      .toThrow(RecordsNonOwnerExposureError);
  });

  it('preflights an allowed MCP recipe grant before mutating the token', async () => {
    const updateTokenGrants = vi.fn();
    const deps = {
      inboundTokenStore: {
        getTokenById: () => ({ token_id: 'token-1', grants: {} }),
        updateTokenGrants,
      },
      preflightExternalToolGrant: () => {
        throw new RecordsNonOwnerExposureError(
          'unsafe-receiver',
          'mcp',
          'missing contract refusal',
        );
      },
    } as unknown as ChatRpcDeps;

    await expect(handleInboundTokenUpdateGrants(deps, {
      token_id: 'token-1',
      grants: { 'publisher.example/unsafe-receiver': true },
    })).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(updateTokenGrants).not.toHaveBeenCalled();
  });

  it('rechecks stale Tier 2 and generic recipe.run grants at MCP dispatch', async () => {
    const execute = vi.fn();
    const unsafe = recipe({
      steps: [
        { id: 'write', op: RECORDS_OP },
      ],
    });
    const deps = {
      getExecuteRecipe: () => execute,
      getRecipeStore: () => ({ get: () => unsafe }),
      preflightExternalRecipeDispatch: () => {
        throw new RecordsNonOwnerExposureError(
          unsafe.recipe_id,
          'mcp',
          'missing contract refusal',
        );
      },
    } as unknown as ChatToolHandlerDeps;
    const ctx = { channel: 'mcp_wire' } as const;

    const tier2 = await createChatTier2Dispatch(deps)(
      `publisher.example/${unsafe.recipe_id}`,
      {},
      ctx,
    );
    const recipeRun = buildChatToolRegistryInputs(deps)
      .tier1Handlers['recipe.run']!;
    const umbrella = await recipeRun({ recipe: unsafe }, ctx);

    expect(tier2).toMatchObject({
      ok: false,
      reason: 'execution_error',
      detail: expect.stringContaining('missing contract refusal'),
    });
    expect(umbrella).toMatchObject({
      ok: false,
      reason: 'execution_error',
      detail: expect.stringContaining('missing contract refusal'),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['inline', 'stored'] as const)(
    'rechecks an unsafe %s recipe at the legacy recued_runRecipe dispatch',
    async (kind) => {
      const unsafe = recipe({
        recipe_id: `unsafe-${kind}`,
        steps: [{ id: 'write', op: RECORDS_OP }],
      });
      const get = vi.fn((id: string) => id === unsafe.recipe_id ? unsafe : null);
      const result = await mcpTesting.handleToolCall({
        name: 'recued_runRecipe',
        arguments: kind === 'inline'
          ? { recipe: unsafe }
          : { recipe_id: unsafe.recipe_id },
      }, {
        // Present the permitting token witness so this test reaches the
        // Records recipe-policy fence instead of the earlier no-token fence.
        inboundTokenAuthorize: (name: string) => name === 'recued_runRecipe',
        recipeStore: { get },
        executorConfig: {
          manifests: {
            slugs: () => [],
          },
        },
        recordsStore: {
          isInstalledOperationId: recordsInventory.isOperationId,
          isInstalledCatalogOperation: recordsInventory.isCatalogOperation,
        },
      } as unknown as McpDeps) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        `first step must use fail_on: "${RECORDS_NON_OWNER_CONTRACT_REFUSAL}"`,
      );
      if (kind === 'stored') expect(get).toHaveBeenCalledWith(unsafe.recipe_id);
    },
  );

  it('adds the hidden Records catalog to an MCP snapshot only behind a granted receiving recipe', () => {
    const safe = recipe();
    const grant = { value: 'publisher.example/receive-project-change' };
    const manifests = {
      slugs: () => ['records-catalog', 'ordinary-catalog'],
      get: (slug: string) => slug === 'records-catalog'
        ? { slug, surfaces: { records: { executes: {}, schema: { entities: {} } } } }
        : { slug },
    };
    const deps = {
      recipeStore: { get: (id: string) => id === safe.recipe_id ? safe : null },
      executorConfig: { manifests },
      recordsStore: {
        isInstalledOperationId: recordsInventory.isOperationId,
        isInstalledCatalogOperation: recordsInventory.isCatalogOperation,
      },
      inboundTokenAuthorize: (name: string) => name === grant.value,
      internalRegistry: {
        listByTier: () => [{ name: grant.value }],
      },
    } as unknown as McpDeps;
    const source = {
      channel: 'mcp',
      actor: 'contracted_user',
      contract_id: 'contract-live',
      mcp_token_id: 'token-1',
      agent_id: 'agent-1',
      tool_call_id: 'call-1',
    } as const;

    expect(mcpTesting.buildMcpContractSnapshot(source, deps).allowed_tools)
      .toEqual(['records-catalog']);
    grant.value = 'unrelated/tool';
    expect(mcpTesting.buildMcpContractSnapshot(source, deps).allowed_tools)
      .toEqual([]);
  });

  it('leaves webhook trigger rows unstamped when exposure preflight refuses', () => {
    const outcome = reconcileWebhookDoors({
      consumer_kind: 'local_recipe',
      consumer_id: 'unsafe-receiver',
      prior: null,
      recipes: [{
        recipe_id: 'unsafe-receiver',
        publisher_id: 'publisher.example',
        recipe: recipe({ recipe_id: 'unsafe-receiver' }),
      }],
      mintedBy: 'user_self',
      retireReason: 'resaved',
    }, {
      preflightNonOwnerRecipeExposure: () => {
        throw new RecordsNonOwnerExposureError(
          'unsafe-receiver',
          'webhook',
          'missing contract refusal',
        );
      },
    } as never).get('unsafe-receiver');

    expect(outcome).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('cannot be exposed through webhook'),
    });
  });
});
