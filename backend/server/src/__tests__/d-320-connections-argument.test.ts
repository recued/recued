/** D-320 slice 2d — the `connections` argument from chat and MCP reaches the run
 *  as its own choice of connection (`ExecuteRequest.connections`), never as a
 *  setting (D-320 §3.5, ruling 12).
 *
 *  A recipe tool's flat arguments ARE the recipe's settings, so `connections` has
 *  to be lifted out of them: left in, it is an undeclared setting the run refuses
 *  (`undeclared_config_argument`), and the choice is lost. `recipe.run` takes it
 *  beside `config`. */

import { describe, expect, it, vi } from 'vitest';

import type { ChatDispatchContext, RecipeDefinition } from '@recued/contracts';

import {
  buildChatTier1Handlers,
  createChatTier2Dispatch,
  createChatTier2Source,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';
import type { ExecuteRequest, ExecuteResponse } from '../types.js';

const recipe = (recipe_id: string, variables: Record<string, unknown>): RecipeDefinition => ({
  recipe_id,
  version: 1,
  metadata: { name: recipe_id, description: 'Test', author: 'recued-core', tags: [] },
  chat_exposed: true,
  variables,
  steps: [],
} as unknown as RecipeDefinition);

const DEALER = recipe('dealer', {
  deal_id: { label: 'Deal', type: 'string' },
  hubspot: { label: 'HubSpot', type: 'connection', default: '' },
});
/** A recipe with a setting that happens to be called `connections`: it keeps it. */
const OWN_SETTING = recipe('own-setting', { connections: { label: 'Connections', type: 'number' } });

const depsWith = (extra: Partial<ChatToolHandlerDeps> = {}) => {
  const execute = vi.fn(async (req: ExecuteRequest) => ({
    success: true, recipe_id: req.recipe_id, steps: [], output: { render: [] },
  }) as unknown as ExecuteResponse);
  const recipes = new Map([[DEALER.recipe_id, DEALER], [OWN_SETTING.recipe_id, OWN_SETTING]]);
  const deps = {
    getExecuteRecipe: () => execute,
    getRecipeStore: () => ({
      ids: () => [...recipes.keys()],
      get: (id: string) => recipes.get(id) ?? null,
      getStored: () => null,
      listStored: () => [],
    }),
    ...extra,
  } as unknown as ChatToolHandlerDeps;
  return { deps, execute };
};

const chat: ChatDispatchContext = { channel: 'internal_function_call', session_id: 's', turn_id: 't' };
const mcp: ChatDispatchContext = { channel: 'mcp_wire', mcp_token_id: 'stdio_local' };

describe("D-320 slice 2d — a recipe tool's `connections` is the run's choice", () => {
  it.each([['owner chat', chat], ['MCP', mcp]])('%s: lifted out of the settings', async (_door, ctx) => {
    const { deps, execute } = depsWith();
    const result = await createChatTier2Dispatch(deps)(
      'recued-core/dealer',
      { deal_id: '9001', connections: { hubspot: 'hubspot-app' } },
      ctx,
    );
    expect(result.ok).toBe(true);
    const req = execute.mock.calls[0]![0];
    expect(req.config).toEqual({ deal_id: '9001' });
    expect(req.connections).toEqual({ hubspot: 'hubspot-app' });
  });

  it('a call without it carries none', async () => {
    const { deps, execute } = depsWith();
    await createChatTier2Dispatch(deps)('recued-core/dealer', { deal_id: '9001' }, chat);
    expect(execute.mock.calls[0]![0]).not.toHaveProperty('connections');
  });

  it('a recipe whose own setting is called `connections` keeps it as that setting', async () => {
    const { deps, execute } = depsWith();
    await createChatTier2Dispatch(deps)('recued-core/own-setting', { connections: 3 }, chat);
    const req = execute.mock.calls[0]![0];
    expect(req.config).toEqual({ connections: 3 });
    expect(req).not.toHaveProperty('connections');
  });

  it('`recipe.run` takes it beside `config`', async () => {
    const { deps, execute } = depsWith();
    const handler = buildChatTier1Handlers(deps)['recipe.run']!;
    const result = await handler(
      { recipe_id: 'recued-core/dealer', config: { deal_id: '9001' }, connections: { hubspot: 'hubspot-app' } },
      chat,
    );
    expect(result.ok).toBe(true);
    const req = execute.mock.calls[0]![0];
    expect(req.config).toEqual({ deal_id: '9001' });
    expect(req.connections).toEqual({ hubspot: 'hubspot-app' });
  });
});

describe('D-320 slice 2d — the recipe tools list their slots', () => {
  it("attach each recipe's choices, read once per listing", () => {
    const listings: string[] = [];
    const { deps } = depsWith({
      connectionChoices: () => {
        listings.push('listing');
        return (r: RecipeDefinition) => (r.recipe_id === 'dealer'
          ? [{ slot: 'hubspot', connections: [
              { connection_name: 'hubspot-app', display_name: 'Sales app', is_default: false },
              { connection_name: 'hubspot-key', display_name: 'Service Key', is_default: true },
            ] }]
          : []);
      },
    });
    const entries = createChatTier2Source(deps).listRecipes();
    expect(listings).toEqual(['listing']);
    expect(entries.find((e) => e.recipe_id === 'dealer')?.connection_slots?.map((s) => s.slot)).toEqual(['hubspot']);
    expect(entries.find((e) => e.recipe_id === 'own-setting')).not.toHaveProperty('connection_slots');
  });
});
