/** Server injection contract for the host-owned `context.caller` recipe root. */

import { describe, expect, it } from 'vitest';
import type {
  ContractSnapshot,
  ExecutionSource,
  RecipeDefinition,
} from '@recued/contracts';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const RECIPE_ID = 'probe-context-caller';
const AUTHENTICATED_CONTRACT_ID = 'ct_authenticated_project_staff';
const FORGED_CONTRACT_ID = 'ct_forged_owner';

const PROBE_RECIPE: RecipeDefinition = {
  recipe_id: RECIPE_ID,
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Probe context.caller',
    description: 'Proves trusted caller projection and forged-context stripping.',
    author: 'test',
    supported_platforms: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'authenticated_contract',
      transform: 'template',
      template: 'ran',
      skip_when:
        `{{context.caller.contract_id}} not_equal ${AUTHENTICATED_CONTRACT_ID}`,
    },
    {
      id: 'forged_contract',
      transform: 'template',
      template: 'ran',
      skip_when: `{{context.caller.contract_id}} not_equal ${FORGED_CONTRACT_ID}`,
    },
    {
      id: 'mcp_channel',
      transform: 'template',
      template: 'ran',
      skip_when: '{{context.caller.channel}} not_equal mcp',
    },
    {
      id: 'contracted_actor',
      transform: 'template',
      template: 'ran',
      skip_when: '{{context.caller.actor}} not_equal contracted_user',
    },
    {
      id: 'user_channel',
      transform: 'template',
      template: 'ran',
      skip_when: '{{context.caller.channel}} not_equal user',
    },
    {
      id: 'owner_actor',
      transform: 'template',
      template: 'ran',
      skip_when: '{{context.caller.actor}} not_equal user_self',
    },
  ],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

const makeDeps = (): ExecuteHandlerDeps => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(PROBE_RECIPE);
  return {
    recipeStore,
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
  };
};

const MCP_SOURCE: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'call-1',
  mcp_token_id: 'token-1',
  contract_id: AUTHENTICATED_CONTRACT_ID,
};

const MCP_SNAPSHOT: ContractSnapshot = {
  contract_id: AUTHENTICATED_CONTRACT_ID,
  contract_version: 'v1',
  allowed_tools: [],
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_000,
};

const wasSkipped = (
  result: Awaited<ReturnType<typeof handleExecute>>,
  id: string,
): boolean | undefined => result.steps.find((step) => step.id === id)?.skipped;

describe('handleExecute — trusted context.caller injection', () => {
  it('injects the authenticated source without requiring caller context', async () => {
    const result = await handleExecute(makeDeps(), {
      recipe_id: RECIPE_ID,
      execution_source: MCP_SOURCE,
      contract_snapshot: MCP_SNAPSHOT,
    });

    expect(result.success).toBe(true);
    expect(wasSkipped(result, 'authenticated_contract')).toBe(false);
    expect(wasSkipped(result, 'mcp_channel')).toBe(false);
    expect(wasSkipped(result, 'contracted_actor')).toBe(false);
    expect(wasSkipped(result, 'forged_contract')).toBe(true);
  });

  it('overwrites a caller-supplied forged context.caller', async () => {
    const suppliedContext = {
      caller: {
        channel: 'user',
        actor: 'user_self',
        contract_id: FORGED_CONTRACT_ID,
      },
    };
    const result = await handleExecute(makeDeps(), {
      recipe_id: RECIPE_ID,
      context: suppliedContext,
      execution_source: MCP_SOURCE,
      contract_snapshot: MCP_SNAPSHOT,
    });

    expect(result.success).toBe(true);
    expect(wasSkipped(result, 'authenticated_contract')).toBe(false);
    expect(wasSkipped(result, 'forged_contract')).toBe(true);
    expect(wasSkipped(result, 'user_channel')).toBe(true);
    expect(wasSkipped(result, 'owner_actor')).toBe(true);
    // The handler projects into a fresh namespace store; it does not mutate the
    // request object that checkpoint/audit code may still inspect.
    expect(suppliedContext.caller.contract_id).toBe(FORGED_CONTRACT_ID);
  });

  it('removes a forged caller root when no execution source exists', async () => {
    const result = await handleExecute(makeDeps(), {
      recipe_id: RECIPE_ID,
      context: {
        caller: {
          channel: 'mcp',
          actor: 'contracted_user',
          contract_id: FORGED_CONTRACT_ID,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(wasSkipped(result, 'forged_contract')).toBe(true);
    expect(wasSkipped(result, 'mcp_channel')).toBe(true);
    expect(wasSkipped(result, 'contracted_actor')).toBe(true);
  });

  it('projects an unrestricted owner source without borrowing a contract id', async () => {
    const result = await handleExecute(makeDeps(), {
      recipe_id: RECIPE_ID,
      context: { caller: { contract_id: FORGED_CONTRACT_ID } },
      execution_source: {
        channel: 'user',
        actor: 'user_self',
        user_id: 'local',
        client_token_id: 'paired-client',
      },
    });

    expect(result.success).toBe(true);
    expect(wasSkipped(result, 'user_channel')).toBe(false);
    expect(wasSkipped(result, 'owner_actor')).toBe(false);
    expect(wasSkipped(result, 'forged_contract')).toBe(true);
    expect(wasSkipped(result, 'authenticated_contract')).toBe(true);
  });
});
