/** D-157 server-wiring - PreflightResumer host-side callbacks. */

import type {
  Checkpoint,
  ContractSnapshot,
  ExecutionSource,
  RecipeDefinition,
} from '@recued/contracts';
import { hashRecipe } from '@recued/recipes';
import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import type { PreflightAskContext } from '@recued/gateway';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecuteHandlerDeps } from '../execute-handler.js';
import {
  createMcpActionStore,
  type McpActionRecord,
} from '../mcp-action-store.js';
import { RUN_INGREDIENT_RECIPE } from '../run-ingredient-recipe.js';

const handleExecuteMock = vi.hoisted(() => vi.fn());

vi.mock('../execute-handler.js', () => ({
  handleExecute: handleExecuteMock,
}));

import { computeArgEditsDiff, createPreflightResumer } from '../preflight-resumer.js';

const NOW = Date.parse('2026-05-22T18:00:00.000Z');
const STARTED_AT = NOW - 4_000;

const chatSource: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
};

const contractSnapshot: ContractSnapshot = {
  contract_id: 'contract-1',
  contract_version: 'v1',
  allowed_tools: ['admin-tool'],
  approval_required: ['admin'],
  scope_restrictions: ['data.*'],
  resolved_at: NOW,
};

const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: 'gated_step',
  step_state: { lookup: { id: 'deal-1' } },
  created_at: NOW,
  ...overrides,
});

const askContext = (
  overrides: Partial<PreflightAskContext> = {},
): PreflightAskContext => ({
  recipe_id: 'recipe-1',
  gated_step_id: 'gated_step',
  tool_slug: 'admin-tool',
  risk_tier: 'admin',
  reason: 'admin tier needs approval',
  ...overrides,
});

const auditLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const pausedAnchor = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  ...buildAuditEntry({
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
    commit_status: 'awaiting_approval',
    duration_ms: NOW - STARTED_AT,
    errors: [],
    config_snapshot: { mode: 'original', threshold: 3 },
    trigger_url: 'https://example.test/deal/1',
    trigger_source: 'chat',
    instance_id: 'server-1',
    process_id: 'process-1',
    run_id: 'run-1',
    now: NOW,
    execution_source: chatSource,
    contract_snapshot: contractSnapshot,
    checkpoint_id: 'checkpoint-1',
  }),
  ...overrides,
});

const append = async (
  log: AuditLogStore,
  entry: AuditEntry,
): Promise<AuditEntry> => {
  await log.append(entry);
  return entry;
};

const executeDeps = (): ExecuteHandlerDeps => ({
  recipeStore: {
    get: vi.fn(() => null),
    list: vi.fn(() => []),
    register: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
    load: vi.fn(),
  } as unknown as ExecuteHandlerDeps['recipeStore'],
  executorConfig: {
    manifests: { get: vi.fn(() => undefined) },
  } as unknown as ExecuteHandlerDeps['executorConfig'],
  baseVault: {},
});

let warnSpy: ReturnType<typeof vi.spyOn>;
let dateNowSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  handleExecuteMock.mockReset();
  handleExecuteMock.mockResolvedValue({
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
    success: true,
    output: { sidebar: [] },
    steps: [],
    errors: [],
    duration_ms: 1,
  });
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  dateNowSpy?.mockRestore();
  dateNowSpy = undefined;
});

describe('PreflightResumer.resumeRun', () => {
  it('replays the paused anchor through handleExecute with internal overrides', async () => {
    const log = auditLog();
    const anchor = await append(log, pausedAnchor());
    const deps = executeDeps();
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint(), askContext());

    expect(handleExecuteMock).toHaveBeenCalledTimes(1);
    const [calledDeps, request, internal] = handleExecuteMock.mock.calls[0]!;
    expect(calledDeps).toBe(deps);
    expect(request).toEqual({
      recipe_id: 'recipe-1',
      config: anchor.config_snapshot,
      trigger_source: 'chat',
      instance_id: 'server-1',
      execution_source: chatSource,
      contract_snapshot: contractSnapshot,
      process_id: 'process-1',
    });
    expect(internal).toEqual({
      run_id: 'run-1',
      resume_from: {
        gated_step_id: 'gated_step',
        step_state: { lookup: { id: 'deal-1' } },
      },
    });
  });

  it('settles the durable MCP action with the exact resumed result', async () => {
    const log = auditLog();
    await append(log, pausedAnchor());
    const actions = createMcpActionStore(
      createInMemoryCollection<McpActionRecord>(),
      { newActionRef: () => 'mcpact-resume' },
    );
    await actions.createHeld({
      run_id: 'run-1',
      principal_id: 'token-a',
      tool_name: 'seller/send',
      kind: 'recipe',
      checkpoint_id: 'checkpoint-1',
    });
    const deps = { ...executeDeps(), mcpActionStore: actions };
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint(), askContext());

    expect(await actions.getByRun('run-1')).toMatchObject({
      action_ref: 'mcpact-resume',
      status: 'completed',
      result: {
        recipe_id: 'recipe-1',
        success: true,
        output: { sidebar: [] },
      },
    });
  });

  it('keeps the same action_ref when a resumed recipe reaches another gate', async () => {
    const log = auditLog();
    await append(log, pausedAnchor());
    const actions = createMcpActionStore(
      createInMemoryCollection<McpActionRecord>(),
      { newActionRef: () => 'mcpact-multi-gate' },
    );
    await actions.createHeld({
      run_id: 'run-1',
      principal_id: 'token-a',
      tool_name: 'seller/onboard',
      kind: 'recipe',
      checkpoint_id: 'checkpoint-1',
    });
    handleExecuteMock.mockImplementationOnce(async () => {
      await append(log, pausedAnchor({ checkpoint_id: 'checkpoint-2' }));
      return {
        recipe_id: 'recipe-1',
        recipe_hash: 'recipe-hash-1',
        success: false,
        awaiting_approval: true,
        output: { sidebar: [] },
        steps: [],
        errors: [],
        duration_ms: 1,
      };
    });
    const deps = { ...executeDeps(), mcpActionStore: actions };
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint(), askContext());

    expect(await actions.getByRun('run-1')).toMatchObject({
      action_ref: 'mcpact-multi-gate',
      status: 'awaiting_approval',
      current_checkpoint_id: 'checkpoint-2',
      approval_round: 2,
    });
  });

  it('terminalizes both audit and action state for a tampered recipe checkpoint', async () => {
    const log = auditLog();
    await append(log, pausedAnchor());
    const actions = createMcpActionStore(
      createInMemoryCollection<McpActionRecord>(),
      { newActionRef: () => 'mcpact-integrity' },
    );
    await actions.createHeld({
      run_id: 'run-1',
      principal_id: 'token-a',
      tool_name: 'recipe.run',
      kind: 'recipe',
      checkpoint_id: 'checkpoint-1',
    });
    const deps = { ...executeDeps(), mcpActionStore: actions };
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint({
      recipe_snapshot: RUN_INGREDIENT_RECIPE as unknown as Record<string, unknown>,
    }), askContext());

    expect(handleExecuteMock).not.toHaveBeenCalled();
    expect(await log.get('run-1')).toMatchObject({
      commit_status: 'failed',
      errors: [{
        code: 'RECIPE_VALIDATION_FAILED',
        details: { reason: 'checkpoint_integrity_failed' },
      }],
    });
    expect(await actions.getByRun('run-1')).toMatchObject({
      status: 'failed',
      result: { code: 'checkpoint_integrity_failed' },
    });
  });

  it('terminalizes the audit anchor for forged compensation provenance', async () => {
    const log = auditLog();
    const compensation = {
      ...RUN_INGREDIENT_RECIPE,
      recipe_id: 'saga-undo-commit-approved',
    } as RecipeDefinition;
    await append(log, pausedAnchor({
      recipe_id: compensation.recipe_id,
      recipe_hash: hashRecipe(compensation),
    }));
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => executeDeps(),
    });

    await resumer.resumeRun(checkpoint({
      recipe_id: compensation.recipe_id,
      recipe_snapshot: compensation as unknown as Record<string, unknown>,
      predecessor_commit_id: 'commit-forged',
    }), askContext());

    expect(handleExecuteMock).not.toHaveBeenCalled();
    expect(await log.get('run-1')).toMatchObject({
      commit_status: 'failed',
      errors: [{
        code: 'RECIPE_VALIDATION_FAILED',
        details: { reason: 'checkpoint_provenance_failed' },
      }],
    });
  });

  it('D-196 R2 replaces the persisted source snapshot with freshly resolved authority', async () => {
    const log = auditLog();
    const llmSource: ExecutionSource = {
      channel: 'chat',
      actor: 'contracted_user',
      chat_session_id: 'llm_gateway:tok-1:request-1',
      user_id: 'customer-1',
      contract_id: 'contract-1',
      turn_id: 'turn-1',
    };
    const staleSnapshot: ContractSnapshot = {
      ...contractSnapshot,
      allowed_tools: ['stale-tool'],
      scope_restrictions: ['data.*'],
      resolved_at: NOW - 60_000,
    };
    const freshSnapshot: ContractSnapshot = {
      ...contractSnapshot,
      allowed_tools: ['fresh-tool'],
      scope_restrictions: ['data.contact.*'],
      resolved_at: NOW,
    };
    await append(log, pausedAnchor({
      execution_source: llmSource,
      contract_snapshot: staleSnapshot,
    }));
    const deps = executeDeps();
    vi.mocked(deps.recipeStore.get).mockReturnValue({
      recipe_id: 'recipe-1',
      version: 1,
      ttl: 60,
      metadata: {
        name: 'Seller recipe',
        description: 'held action',
        author: 'seller',
        supported_platforms: [],
      },
      variables: {},
      prefetch_steps: [],
      steps: [],
      output: { sidebar: [] },
    });
    const resolve = vi.fn(() => ({
      admitted: true as const,
      execution_source: llmSource,
      contract_snapshot: freshSnapshot,
    }));
    deps.approvalResumeAuthority = { resolve };
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint(), askContext());

    expect(resolve).toHaveBeenCalledWith({
      execution_source: llmSource,
      required_bearer_tool_names: ['seller/recipe-1'],
    });
    expect(handleExecuteMock).toHaveBeenCalledTimes(1);
    expect(handleExecuteMock.mock.calls[0]![1]).toMatchObject({
      execution_source: llmSource,
      contract_snapshot: freshSnapshot,
    });
    expect(handleExecuteMock.mock.calls[0]![1].contract_snapshot)
      .not.toEqual(staleSnapshot);
  });

  it('D-196 R2 terminalizes the anchor without dispatch when live authority denies', async () => {
    const log = auditLog();
    const source: ExecutionSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'call-1',
      mcp_token_id: 'tok-1',
      contract_id: 'contract-1',
    };
    await append(log, pausedAnchor({ execution_source: source }));
    const deps = executeDeps();
    const resolve = vi.fn(() => ({
      admitted: false as const,
      reason: 'bearer_inactive' as const,
      detail: 'bearer was revoked while held',
    }));
    deps.approvalResumeAuthority = {
      resolve,
    };
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint({
      approved_target: { ingredient_slug: 'admin-tool' },
    }), askContext());

    expect(handleExecuteMock).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({
      execution_source: source,
      // `admin-tool` is a dependency/approved target, not top-level recipe
      // authority, so it must not substitute for a revoked recipe-run grant.
      required_bearer_tool_names: ['recued_runRecipe', 'recipe.run'],
    });
    const updated = await log.get('run-1');
    expect(updated?.commit_status).toBe('failed');
    expect(updated?.errors?.[0]).toMatchObject({
      code: 'RECIPE_POLICY_DENIED',
      details: { authority_reason: 'bearer_inactive' },
    });
  });

  it('D-196 R2 fails closed when a bearer-backed resume has no live resolver', async () => {
    const log = auditLog();
    await append(log, pausedAnchor({
      execution_source: {
        channel: 'mcp',
        actor: 'contracted_user',
        agent_id: 'agent-1',
        tool_call_id: 'call-1',
        mcp_token_id: 'tok-1',
        contract_id: 'contract-1',
      },
    }));
    const deps = executeDeps();
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint(), askContext());

    expect(handleExecuteMock).not.toHaveBeenCalled();
    expect(await log.get('run-1')).toMatchObject({
      commit_status: 'failed',
      errors: [{
        details: { authority_reason: 'authority_resolution_failed' },
      }],
    });
  });

  it('D-196 R2 binds an inline run-ingredient resume to its exact wire grant', async () => {
    const log = auditLog();
    const source: ExecutionSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'call-1',
      mcp_token_id: 'tok-1',
      contract_id: 'contract-1',
    };
    await append(log, pausedAnchor({
      recipe_id: 'run-ingredient',
      recipe_hash: hashRecipe(RUN_INGREDIENT_RECIPE),
      execution_source: source,
    }));
    const deps = executeDeps();
    const resolve = vi.fn(() => ({
      admitted: false as const,
      reason: 'bearer_grant_revoked' as const,
      detail: 'direct ingredient grant removed',
    }));
    deps.approvalResumeAuthority = { resolve };
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint({
      recipe_id: 'run-ingredient',
      recipe_snapshot: RUN_INGREDIENT_RECIPE as unknown as Record<string, unknown>,
      approved_target: { ingredient_slug: 'mail-send' },
    }), askContext());

    expect(resolve).toHaveBeenCalledWith({
      execution_source: source,
      required_bearer_tool_names: ['recued_ingredient_mail-send'],
    });
    expect(handleExecuteMock).not.toHaveBeenCalled();
  });

  it('D-196 R2 does not let an inline recipe borrow a qualified or kernel grant', async () => {
    const log = auditLog();
    const source: ExecutionSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'call-1',
      mcp_token_id: 'tok-1',
      contract_id: 'contract-1',
    };
    const lookalike: RecipeDefinition = {
      ...RUN_INGREDIENT_RECIPE,
      metadata: {
        ...RUN_INGREDIENT_RECIPE.metadata,
        author: 'seller',
        description: 'not the kernel recipe',
      },
    };
    await append(log, pausedAnchor({
      recipe_id: 'run-ingredient',
      recipe_hash: hashRecipe(lookalike),
      execution_source: source,
    }));
    const deps = executeDeps();
    const resolve = vi.fn(() => ({
      admitted: false as const,
      reason: 'bearer_grant_revoked' as const,
      detail: 'no exact top-level grant',
    }));
    deps.approvalResumeAuthority = { resolve };
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint({
      recipe_id: 'run-ingredient',
      recipe_snapshot: lookalike as unknown as Record<string, unknown>,
      approved_target: { ingredient_slug: 'mail-send' },
    }), askContext());

    expect(resolve).toHaveBeenCalledWith({
      execution_source: source,
      required_bearer_tool_names: [],
    });
    expect(handleExecuteMock).not.toHaveBeenCalled();
  });

  it('D-196 R2 keeps ordinary inline recipes on generic recipe-run authority', async () => {
    const log = auditLog();
    const source: ExecutionSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-1',
      tool_call_id: 'call-1',
      mcp_token_id: 'tok-1',
      contract_id: 'contract-1',
    };
    const inlineRecipe: RecipeDefinition = {
      ...RUN_INGREDIENT_RECIPE,
      recipe_id: 'inline-recipe',
      metadata: {
        ...RUN_INGREDIENT_RECIPE.metadata,
        author: 'seller',
      },
    };
    await append(log, pausedAnchor({
      recipe_id: inlineRecipe.recipe_id,
      recipe_hash: hashRecipe(inlineRecipe),
      execution_source: source,
    }));
    const deps = executeDeps();
    const resolve = vi.fn(() => ({
      admitted: false as const,
      reason: 'bearer_grant_revoked' as const,
      detail: 'generic recipe-run grants removed',
    }));
    deps.approvalResumeAuthority = { resolve };
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint({
      recipe_id: inlineRecipe.recipe_id,
      recipe_snapshot: inlineRecipe as unknown as Record<string, unknown>,
    }), askContext());

    expect(resolve).toHaveBeenCalledWith({
      execution_source: source,
      required_bearer_tool_names: ['recued_runRecipe', 'recipe.run'],
    });
    expect(handleExecuteMock).not.toHaveBeenCalled();
  });

  it('replays the paused anchor context_snapshot as the resume context (targeting-guard fold)', async () => {
    // Design § 8 / codex HIGH fold — a gated step resolving
    // `{{context.entity_id}}` must re-dispatch against the approved
    // values, not undefined.
    const log = auditLog();
    await append(
      log,
      pausedAnchor({ context_snapshot: { entity_id: 'deal-9', tabs: [] } }),
    );
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => executeDeps(),
    });

    await resumer.resumeRun(checkpoint(), askContext());

    const [, request] = handleExecuteMock.mock.calls[0]!;
    expect((request as { context?: unknown }).context).toEqual({
      entity_id: 'deal-9',
      tabs: [],
    });
  });

  it('omits context on a pre-fold anchor with no snapshot (byte-identical resume)', async () => {
    const log = auditLog();
    await append(log, pausedAnchor());
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => executeDeps(),
    });

    await resumer.resumeRun(checkpoint(), askContext());

    const [, request] = handleExecuteMock.mock.calls[0]!;
    expect('context' in (request as Record<string, unknown>)).toBe(false);
  });

  it.each(['succeeded', 'failed', 'cancelled', 'in_doubt'] as const)(
    'no-ops for terminal commit_status %s',
    async (commit_status) => {
      const log = auditLog();
      await append(log, pausedAnchor({ commit_status }));
      const resumer = createPreflightResumer({
        auditLog: log,
        getExecuteDeps: () => executeDeps(),
      });

      await resumer.resumeRun(checkpoint(), askContext());

      expect(handleExecuteMock).not.toHaveBeenCalled();
    },
  );

  it('no-ops for a stale checkpoint id', async () => {
    const log = auditLog();
    await append(log, pausedAnchor({ checkpoint_id: 'newer-checkpoint' }));
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => executeDeps(),
    });

    await resumer.resumeRun(checkpoint(), askContext());

    expect(handleExecuteMock).not.toHaveBeenCalled();
  });

  it('no-ops when the paused anchor is missing', async () => {
    const log = auditLog();
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => executeDeps(),
    });

    await resumer.resumeRun(checkpoint(), askContext());

    expect(handleExecuteMock).not.toHaveBeenCalled();
  });

  it('throws when executeDeps is unavailable', async () => {
    const log = auditLog();
    await append(log, pausedAnchor());
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => undefined,
    });

    await expect(resumer.resumeRun(checkpoint(), askContext()))
      .rejects.toThrow(/executeDeps not yet published/);
    expect(handleExecuteMock).not.toHaveBeenCalled();
  });

  it('propagates handleExecute failures', async () => {
    const log = auditLog();
    await append(log, pausedAnchor());
    const actions = createMcpActionStore(
      createInMemoryCollection<McpActionRecord>(),
      { newActionRef: () => 'mcpact-retry' },
    );
    await actions.createHeld({
      run_id: 'run-1',
      principal_id: 'token-a',
      tool_name: 'seller/send',
      kind: 'recipe',
      checkpoint_id: 'checkpoint-1',
    });
    handleExecuteMock.mockRejectedValueOnce(new Error('resume failed'));
    const deps = { ...executeDeps(), mcpActionStore: actions };
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await expect(resumer.resumeRun(checkpoint(), askContext()))
      .rejects.toThrow('resume failed');
    expect(await actions.getByRun('run-1')).toMatchObject({
      action_ref: 'mcpact-retry',
      status: 'awaiting_approval',
      current_checkpoint_id: 'checkpoint-1',
      approval_round: 1,
    });
  });
});

describe('PreflightResumer.denyRun', () => {
  it('writes a RECIPE_POLICY_DENIED failed row under the paused run_id', async () => {
    const log = auditLog();
    const anchor = await append(log, pausedAnchor());
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW + 3_000);
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => undefined,
    });

    await resumer.denyRun(checkpoint(), askContext());

    const updated = await log.get('run-1');
    expect(updated).toBeDefined();
    expect(updated!.run_id).toBe(anchor.run_id);
    expect(updated!.commit_status).toBe('failed');
    expect(updated!.errors).toHaveLength(1);
    expect(updated!.errors?.[0]).toMatchObject({
      code: 'RECIPE_POLICY_DENIED',
      source: {
        recipe_id: 'recipe-1',
        step_id: 'gated_step',
        ingredient_slug: 'admin-tool',
      },
    });
    expect(updated!.started_at).toBe(anchor.started_at);
    expect(updated!.duration_ms).toBe(Date.now() - anchor.started_at);
    expect(updated!.checkpoint_id).toBeUndefined();
    expect(updated!.ask_id).toBeUndefined();
  });

  it('settles the token-bound MCP action when the owner denies', async () => {
    const log = auditLog();
    await append(log, pausedAnchor());
    const actions = createMcpActionStore(
      createInMemoryCollection<McpActionRecord>(),
      { newActionRef: () => 'mcpact-denied' },
    );
    await actions.createHeld({
      run_id: 'run-1',
      principal_id: 'token-a',
      tool_name: 'seller/send',
      kind: 'recipe',
      checkpoint_id: 'checkpoint-1',
    });
    const resumer = createPreflightResumer({
      auditLog: log,
      mcpActionStore: actions,
      getExecuteDeps: () => undefined,
    });

    await resumer.denyRun(checkpoint(), askContext());

    expect(await actions.getByRun('run-1')).toMatchObject({
      action_ref: 'mcpact-denied',
      status: 'denied',
      result: { status: 'denied', denied: true },
    });
  });

  it.each(['succeeded', 'failed', 'cancelled', 'in_doubt'] as const)(
    'no-ops for terminal commit_status %s',
    async (commit_status) => {
      const log = auditLog();
      await append(log, pausedAnchor({ commit_status }));
      // Read the row back BEFORE the call rather than comparing against the
      // appended fixture: `errors` is optional since 2026-08-05 and the write
      // path omits it when empty, so a fixture carrying `errors: []` no longer
      // round-trips identically. The invariant under test is "denyRun changed
      // nothing", which is exactly a before/after comparison of the STORED row.
      const before = await log.get('run-1');
      const resumer = createPreflightResumer({
        auditLog: log,
        getExecuteDeps: () => undefined,
      });

      await resumer.denyRun(checkpoint(), askContext());

      expect(await log.get('run-1')).toEqual(before);
    },
  );

  it('no-ops for stale or missing anchors', async () => {
    const staleLog = auditLog();
    await append(
      staleLog,
      pausedAnchor({ checkpoint_id: 'newer-checkpoint' }),
    );
    // Same reason as the terminal-status cases above — compare the stored row
    // before and after, not the appended fixture.
    const stale = await staleLog.get('run-1');
    const staleResumer = createPreflightResumer({
      auditLog: staleLog,
      getExecuteDeps: () => undefined,
    });
    await staleResumer.denyRun(checkpoint(), askContext());
    expect(await staleLog.get('run-1')).toEqual(stale);

    const missingLog = auditLog();
    const missingResumer = createPreflightResumer({
      auditLog: missingLog,
      getExecuteDeps: () => undefined,
    });
    await missingResumer.denyRun(checkpoint(), askContext());
    expect(await missingLog.get('run-1')).toBeNull();
  });

  it('propagates audit append failures', async () => {
    const log = auditLog();
    await append(log, pausedAnchor());
    vi.spyOn(log, 'append').mockRejectedValueOnce(new Error('audit down'));
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => undefined,
    });

    await expect(resumer.denyRun(checkpoint(), askContext()))
      .rejects.toThrow('audit down');
  });

  it('uses the current recipe hash when the recipe is still installed', async () => {
    const log = auditLog();
    await append(log, pausedAnchor({ recipe_hash: 'old-hash' }));
    const recipe: RecipeDefinition = {
      recipe_id: 'recipe-1',
      version: 1,
      ttl: 60,
      metadata: {
        name: 'Installed recipe',
        description: 'Hash source for deny row',
        author: 'test',
        supported_platforms: ['test'],
      },
      variables: {},
      prefetch_steps: [],
      steps: [],
      output: { sidebar: [] },
    };
    const deps = executeDeps();
    vi.mocked(deps.recipeStore.get).mockReturnValue(recipe);
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.denyRun(checkpoint(), askContext());

    const updated = await log.get('run-1');
    expect(updated!.recipe_hash).not.toBe('old-hash');
  });
});

// ─────────────────────────────────────────────────────────────────────
// D-173 N.5 — editable args: checkpoint-sourced arg_overrides threading +
// the approve-with-edits audit breadcrumb. The resumer is the ONLY origin
// of `internal.resume_from.arg_overrides` — it reads them off the consumed
// checkpoint and never from any caller / channel input (N.5 MUST).
// ─────────────────────────────────────────────────────────────────────

const recipeWithGatedStep = (
  authoredInput: Record<string, unknown>,
): RecipeDefinition => ({
  recipe_id: 'recipe-1',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Reception recipe',
    description: 'gated projection op',
    author: 'test',
    supported_platforms: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'gated_step', ingredient: 'reception-op', input: authoredInput },
  ] as unknown as RecipeDefinition['steps'],
  output: { sidebar: [] },
});

describe('D-173 N.5 — PreflightResumer threads checkpoint arg_overrides', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('passes checkpoint.arg_overrides into internal.resume_from.arg_overrides (boundary origin)', async () => {
    const log = auditLog();
    await append(log, pausedAnchor());
    const deps = executeDeps();
    vi.mocked(deps.recipeStore.get).mockReturnValue(
      recipeWithGatedStep({ start_at: 0, calendar_id: 'authored-cal' }),
    );
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(
      checkpoint({ arg_overrides: { calendar_id: 'edited-cal', start_at: 999 } }),
      askContext(),
    );

    expect(handleExecuteMock).toHaveBeenCalledTimes(1);
    const [, , internal] = handleExecuteMock.mock.calls[0]!;
    expect(internal.resume_from.arg_overrides).toEqual({
      calendar_id: 'edited-cal',
      start_at: 999,
    });
  });

  it('omits arg_overrides on a plain binary-gate checkpoint (byte-identical to today)', async () => {
    const log = auditLog();
    await append(log, pausedAnchor());
    const deps = executeDeps();
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint(), askContext());

    const [, , internal] = handleExecuteMock.mock.calls[0]!;
    expect(internal.resume_from).not.toHaveProperty('arg_overrides');
  });

  it('emits the approved-with-edits diff breadcrumb (old→new) on an edited resume', async () => {
    const log = auditLog();
    await append(log, pausedAnchor());
    const deps = executeDeps();
    vi.mocked(deps.recipeStore.get).mockReturnValue(
      recipeWithGatedStep({ start_at: 0, calendar_id: 'authored-cal', title: 'Booking' }),
    );
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(
      checkpoint({ arg_overrides: { calendar_id: 'edited-cal', start_at: 999 } }),
      askContext(),
    );

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const msg = String(infoSpy.mock.calls[0]![0]);
    expect(msg).toContain('approved-with-edits');
    expect(msg).toContain("step='gated_step'");
    // The diff carries the old→new pairs for the edited keys only.
    const payload = JSON.parse(msg.slice(msg.indexOf('edits=') + 'edits='.length));
    expect(payload).toEqual(
      expect.arrayContaining([
        { key: 'calendar_id', old: 'authored-cal', new: 'edited-cal' },
        { key: 'start_at', old: 0, new: 999 },
      ]),
    );
    // The un-edited authored `title` is NOT in the diff.
    expect((payload as Array<{ key: string }>).map((d) => d.key)).not.toContain('title');
  });

  it('does NOT emit the breadcrumb on a plain binary-gate resume', async () => {
    const log = auditLog();
    await append(log, pausedAnchor());
    const deps = executeDeps();
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });

    await resumer.resumeRun(checkpoint(), askContext());

    expect(infoSpy).not.toHaveBeenCalled();
  });
});

describe('D-173 N.5 — computeArgEditsDiff', () => {
  it('records old→new for an edited authored key', () => {
    expect(
      computeArgEditsDiff({ calendar_id: 'a', start_at: 0 }, { calendar_id: 'b' }),
    ).toEqual([{ key: 'calendar_id', old: 'a', new: 'b' }]);
  });

  it('records old=undefined for an override that ADDS a key', () => {
    expect(
      computeArgEditsDiff({ calendar_id: 'a' }, { attendee: 'x@y.z' }),
    ).toEqual([{ key: 'attendee', old: undefined, new: 'x@y.z' }]);
  });

  it('handles absent authored args (whole-object prefilled later)', () => {
    expect(computeArgEditsDiff(undefined, { calendar_id: 'b' })).toEqual([
      { key: 'calendar_id', old: undefined, new: 'b' },
    ]);
  });

  it('skips prototype-sensitive override keys (defense in depth)', () => {
    const hostile = JSON.parse(
      '{"calendar_id":"b","__proto__":{"x":1},"constructor":{"y":2}}',
    ) as Record<string, unknown>;
    expect(computeArgEditsDiff({ calendar_id: 'a' }, hostile)).toEqual([
      { key: 'calendar_id', old: 'a', new: 'b' },
    ]);
  });

  it('returns an empty diff for empty overrides', () => {
    expect(computeArgEditsDiff({ a: 1 }, {})).toEqual([]);
  });
});
