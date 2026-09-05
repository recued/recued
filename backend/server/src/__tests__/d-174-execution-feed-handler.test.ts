/** D-174 Runs/Audit — `execution.list` + `execution.get` handler tests. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MCP_TOOL_CATALOG,
  SERVER_RPC_METHOD_SET,
  isMcpToolName,
  type Actor,
  type Checkpoint,
  type Commit,
  type ExecutionSource,
  type RecipeError,
  type RunAnchorStatus,
} from '@recued/contracts';
import {
  buildAuditEntry,
  createAuditLogStore,
  createCheckpointStore,
  createCommitStore,
  createInMemoryCollection,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
  type CommitStore,
} from '@recued/storage';

import { ensureMemorySchema, getOrCreateRecipeInsight } from '../memory-schema.js';
import { createRpcDispatcher } from '../rpc-dispatcher.js';
import type { WsClient } from '../ws-server.js';
import {
  handleExecutionGet,
  handleExecutionList,
  makeExecutionFeedHandlers,
  type ExecutionFeedRpcDeps,
} from '../execution-feed-handler.js';

let db: Database.Database;
let auditLog: AuditLogStore;
let checkpointStore: CheckpointStore;
let commitStore: CommitStore;
let deps: ExecutionFeedRpcDeps;

const userSource: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'user-1',
  client_token_id: 'client-secret-token-id',
};

const mcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-a',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-secret-token-id',
  contract_id: 'contract-a',
};

const receptionSource: ExecutionSource = {
  channel: 'reception',
  actor: 'anonymous',
  reception_id: 'drop-1',
};

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  ensureMemorySchema(db);
  auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection(),
  );
  checkpointStore = createCheckpointStore(createInMemoryCollection<Checkpoint>());
  commitStore = createCommitStore(createInMemoryCollection<Commit>());
  deps = { db, auditLog, checkpointStore, commitStore, serverInstanceId: 'srv-test' };
});

const entry = (
  run_id: string,
  started_at: number,
  patch: Partial<AuditEntry> = {},
): AuditEntry =>
  buildAuditEntry({
    run_id,
    recipe_id: patch.recipe_id ?? 'recipe-a',
    recipe_hash: patch.recipe_hash ?? 'hash-a',
    now: started_at + (patch.duration_ms ?? 10),
    duration_ms: patch.duration_ms ?? 10,
    commit_status: patch.commit_status ?? 'succeeded',
    config_snapshot: patch.config_snapshot ?? {},
    errors: patch.errors ?? [],
    ...(patch.degraded !== undefined ? { degraded: patch.degraded } : {}),
    trigger_url: patch.trigger_url ?? null,
    trigger_source: patch.trigger_source ?? 'manual',
    instance_id: patch.instance_id ?? 'srv-test',
    ...(patch.output_string !== undefined ? { output_string: patch.output_string } : {}),
    ...(patch.execution_source !== undefined ? { execution_source: patch.execution_source } : {}),
    ...(patch.contract_snapshot !== undefined ? { contract_snapshot: patch.contract_snapshot } : {}),
    ...(patch.checkpoint_id !== undefined ? { checkpoint_id: patch.checkpoint_id } : {}),
    ...(patch.ask_id !== undefined ? { ask_id: patch.ask_id } : {}),
    ...(patch.error_category !== undefined ? { error_category: patch.error_category } : {}),
  });

const append = async (
  run_id: string,
  started_at: number,
  patch: Partial<AuditEntry> = {},
): Promise<AuditEntry> => {
  const e = entry(run_id, started_at, patch);
  await auditLog.append(e);
  return e;
};

const addLink = (
  run_id: string,
  entity_id: string,
  ts: number,
  kind = 'execution.action',
): void => {
  const insightId = getOrCreateRecipeInsight(db, {
    hash: 'hash-a',
    slug: 'recipe-a',
    version: 1,
    flattened: '{}',
    created_at: 0,
  });
  db.prepare(
    `INSERT INTO links (memory_id, entity_id, recipe_insight_id, kind, ts)
       VALUES (?, ?, ?, ?, ?)`,
  ).run(run_id, entity_id, insightId, kind, ts);
};

const writeCommit = async (
  run_id: string,
  patch: {
    commit_id: string;
    ingredient?: string;
    tool?: string;
    args?: Record<string, unknown>;
    dispatched_at: number;
    completed_at?: number;
    status?: 'succeeded' | 'failed' | 'cancelled' | 'in_doubt';
    output?: unknown;
    cached?: true;
  },
): Promise<void> => {
  await commitStore.writePending({
    commit_id: patch.commit_id,
    kind: 'action',
    ingredient: patch.ingredient ?? 'mail',
    tool: patch.tool ?? 'send',
    args: patch.args ?? { to: 'ada@example.com' },
    source: userSource,
    channel_session_id: 'user:user-1',
    correlation_id: 'corr-1',
    request_id: run_id,
    dispatch_depth: 0,
    idempotency_key: `idem-${patch.commit_id}`,
    dispatched_at: patch.dispatched_at,
  });
  if (patch.status !== undefined && patch.completed_at !== undefined) {
    await commitStore.recordOutcome(patch.commit_id, {
      status: patch.status,
      completed_at: patch.completed_at,
      ...(patch.output !== undefined ? { output: patch.output } : {}),
      ...(patch.cached === true ? { cached: true } : {}),
    });
  }
};

const ctx = (instance_id: string | null = 'webclient-1'): WsClient =>
  ({
    ws: null,
    realm: 'recued',
    instance_id,
    display_name: 'client',
    connected_at: 0,
    user_id: 'user-1',
  }) as unknown as WsClient;

describe('D-174 execution.list', () => {
  it('filters by status, origin, recipe_id, trigger_source, and time range', async () => {
    await append('skip-status', 100, {
      commit_status: 'failed',
      recipe_id: 'recipe-a',
      execution_source: userSource,
      trigger_source: 'manual',
    });
    await append('match-user', 200, {
      commit_status: 'succeeded',
      recipe_id: 'recipe-a',
      execution_source: userSource,
      trigger_source: 'manual',
    });
    await append('skip-origin', 300, {
      commit_status: 'succeeded',
      recipe_id: 'recipe-a',
      execution_source: mcpSource,
      trigger_source: 'manual',
    });
    await append('skip-recipe', 400, {
      commit_status: 'succeeded',
      recipe_id: 'recipe-b',
      execution_source: userSource,
      trigger_source: 'manual',
    });
    await append('skip-trigger', 500, {
      commit_status: 'succeeded',
      recipe_id: 'recipe-a',
      execution_source: userSource,
      trigger_source: 'scheduled',
    });

    const out = await handleExecutionList(deps, {
      status: ['succeeded'],
      origin: ['user_self'],
      recipe_id: 'recipe-a',
      trigger_source: 'manual',
      since: 150,
      until: 450,
      limit: 10,
    });

    expect(out.runs.map((r) => r.run_id)).toEqual(['match-user']);
    expect(out.runs[0]!.origin).toMatchObject({
      actor: 'user_self',
      label: 'user_self',
      channel: 'user',
    });
  });

  it('paginates with the audit-export started_at + run_id tiebreak cursor', async () => {
    await append('run-c', 1_000, { execution_source: userSource });
    await append('run-b', 1_000, { execution_source: userSource });
    await append('run-a', 1_000, { execution_source: userSource });

    const page1 = await handleExecutionList(deps, { limit: 2 });
    expect(page1.runs.map((r) => r.run_id)).toEqual(['run-c', 'run-b']);
    expect(page1.next_cursor).toEqual({
      last_started_at: 1_000,
      last_run_id: 'run-b',
    });

    const page2 = await handleExecutionList(deps, {
      limit: 2,
      cursor: page1.next_cursor,
    });
    expect(page2.runs.map((r) => r.run_id)).toEqual(['run-a']);
    expect(page2.next_cursor).toBeUndefined();
  });

  it('derives policy_result for the Tier-1 four emitted cases and never emits blocked', async () => {
    await append('allowed', 100, { commit_status: 'succeeded' });
    await append('requested', 200, { commit_status: 'awaiting_approval' });
    await append('released', 300, {
      commit_status: 'succeeded',
      output_string: 'approval:allow released',
    });
    await append('denied', 400, {
      commit_status: 'failed',
      output_string: 'approval:deny rejected',
    });

    const out = await handleExecutionList(deps, { limit: 10 });
    const byRun = new Map(out.runs.map((r) => [r.run_id, r.policy_result]));
    expect(byRun.get('allowed')).toBe('allowed');
    expect(byRun.get('requested')).toBe('approval-requested');
    expect(byRun.get('released')).toBe('released-after-approval');
    expect(byRun.get('denied')).toBe('denied');
    expect([...byRun.values()]).not.toContain('blocked');
  });

  it('uses stored commit verdicts for policy_result and falls back only when a run has no commits', async () => {
    await append('commit-backed', 100, { commit_status: 'succeeded' });
    await writeCommit('commit-backed', {
      commit_id: 'commit-backed-failed',
      dispatched_at: 110,
      completed_at: 145,
      status: 'failed',
    });
    await append('legacy-no-commit', 200, {
      commit_status: 'failed',
      output_string: 'approval:deny rejected',
    });

    const out = await handleExecutionList(deps, { limit: 10 });
    const byRun = new Map(out.runs.map((r) => [r.run_id, r.policy_result]));

    expect(byRun.get('commit-backed')).toBe('blocked');
    expect(byRun.get('legacy-no-commit')).toBe('denied');
  });

  it('joins provenance links for feed rows', async () => {
    await append('linked-run', 100, { execution_source: receptionSource });
    addLink('linked-run', 'contact:c1', 101);

    const out = await handleExecutionList(deps, { limit: 1 });
    expect(out.runs[0]!.links).toEqual([
      { entity_id: 'contact:c1', kind: 'execution.action', ts: 101 },
    ]);
    expect(out.runs[0]!.origin.attribution).toMatchObject({
      kind: 'visitor',
      origin_actor: 'anonymous',
    });
  });

  it('projects the D-181 §12 error_category onto a killed feed row', async () => {
    await append('killed-run', 100, {
      commit_status: 'killed',
      execution_source: userSource,
      error_category: 'killed',
    });
    await append('plain-fail', 200, {
      commit_status: 'failed',
      execution_source: userSource,
    });
    const out = await handleExecutionList(deps, { limit: 10 });
    const byRun = new Map(out.runs.map((r) => [r.run_id, r.error_category]));
    expect(byRun.get('killed-run')).toBe('killed');
    // An ordinary failure carries no long-op category.
    expect(byRun.get('plain-fail')).toBeUndefined();
  });

  it('projects the D-182 cli_failure_reason onto a cli-failed feed row', async () => {
    const cliErr: RecipeError = {
      error_id: 'cli-e1',
      code: 'CLI_TOOL_NOT_FOUND',
      message: "cli tool 'whisper' was not found",
      severity: 'error',
      source: {
        recipe_id: 'recipe-a',
        step_id: 'transcribe',
        ingredient_slug: 'recued-core.whisper.audio.transcribe',
      },
      details: {
        cli_failure: {
          reason: 'not_found',
          tool: 'whisper',
          slug: 'recued-core.whisper.audio.transcribe',
        },
      },
      timestamp: '2026-06-27T00:00:00.000Z',
      retryable: false,
    };
    const plainErr: RecipeError = {
      error_id: 'plain-e1',
      code: 'RECIPE_VALIDATION_FAILED',
      message: 'nope',
      severity: 'error',
      source: { recipe_id: 'recipe-a', step_id: 's1', ingredient_slug: null },
      details: {},
      timestamp: '2026-06-27T00:00:00.000Z',
      retryable: false,
    };
    await append('cli-fail', 300, {
      commit_status: 'failed', execution_source: userSource, errors: [cliErr],
    });
    await append('plain-fail-2', 400, {
      commit_status: 'failed', execution_source: userSource, errors: [plainErr],
    });
    const out = await handleExecutionList(deps, { limit: 10 });
    const byRun = new Map(out.runs.map((r) => [r.run_id, r.cli_failure_reason]));
    expect(byRun.get('cli-fail')).toBe('not_found');
    // A non-cli failure carries no cli_failure_reason.
    expect(byRun.get('plain-fail-2')).toBeUndefined();
  });

  it('lets the long-op error_category win the chip — no cli_failure_reason beside a kill', async () => {
    const cliErr: RecipeError = {
      error_id: 'cli-killed',
      code: 'CLI_TOOL_FAILED',
      message: 'cli tool exited with code -1',
      severity: 'error',
      source: { recipe_id: 'recipe-a', step_id: 's1', ingredient_slug: 'p.docling.x' },
      details: { cli_failure: { reason: 'nonzero_exit', tool: 'docling', exit_code: -1 } },
      timestamp: '2026-06-27T00:00:00.000Z',
      retryable: false,
    };
    // An owner kill mid-cli-run: the SIGKILLed subprocess rejects with a cli_failure
    // AND the registry marks the run killed. The kill wins the single feed chip.
    await append('killed-with-cli', 600, {
      commit_status: 'killed', execution_source: userSource,
      error_category: 'killed', errors: [cliErr],
    });
    const out = await handleExecutionList(deps, { limit: 10 });
    const row = out.runs.find((r) => r.run_id === 'killed-with-cli');
    expect(row?.error_category).toBe('killed');
    expect(row?.cli_failure_reason).toBeUndefined();
  });
});

describe('D-174 execution.get', () => {
  it('joins audit summary, redacted checkpoint approvals, errors, links, real gateway trace, stored verdict, and degraded markers', async () => {
    const errors: RecipeError[] = [
      {
        error_id: 'err-1',
        code: 'RECIPE_VALIDATION_FAILED',
        message: 'safe diagnostic',
        severity: 'error',
        source: {
          recipe_id: 'recipe-a',
          step_id: 'step-1',
          ingredient_slug: null,
        },
        details: {},
        timestamp: '2026-06-05T00:00:00.000Z',
        retryable: false,
      },
    ];
    await append('detail-run', 500, {
      commit_status: 'failed',
      config_snapshot: { api_key: 'sk-secret-value' },
      output_string: 'approval:deny rejected',
      execution_source: mcpSource,
      contract_snapshot: {
        contract_id: 'contract-a',
        contract_version: 'v1',
        allowed_tools: [],
        approval_required: [],
        scope_restrictions: [],
        resolved_at: 1,
      },
      errors,
      checkpoint_id: 'cp-1',
      ask_id: 'ask-1',
      degraded: ['provenance_incomplete'],
    });
    await writeCommit('detail-run', {
      commit_id: 'commit-detail-real',
      ingredient: 'mail-send',
      tool: 'send',
      args: { token: 'commit-secret-arg' },
      dispatched_at: 503,
      completed_at: 531,
      status: 'succeeded',
      output: { token: 'commit-secret-output' },
      cached: true,
    });
    await checkpointStore.write({
      checkpoint_id: 'cp-1',
      run_id: 'detail-run',
      recipe_id: 'recipe-a',
      gated_step_id: 'send',
      approved_target: {
        ingredient_slug: 'mail-send',
        operation_id: 'send',
        connection_name: 'work',
      },
      step_state: { secret: 'do-not-return' },
      arg_overrides: { body: 'do-not-return' },
      created_at: 501,
    });
    addLink('detail-run', 'approval:ask-1', 502, 'execution.action');

    const out = await handleExecutionGet(deps, { run_id: 'detail-run' });

    expect(out.run.audit).toMatchObject({
      run_id: 'detail-run',
      recipe_id: 'recipe-a',
      status: 'failed',
      ask_id: 'ask-1',
      checkpoint_id: 'cp-1',
      degraded: ['provenance_incomplete'],
    });
    expect(out.run.approvals).toMatchObject({
      ask_id: 'ask-1',
      checkpoint_id: 'cp-1',
      outcome: 'deny',
      checkpoints: [
        {
          checkpoint_id: 'cp-1',
          run_id: 'detail-run',
          recipe_id: 'recipe-a',
          gated_step_id: 'send',
          created_at: 501,
        },
      ],
    });
    expect(out.run.errors).toEqual(errors);
    expect(out.run.links).toEqual([
      { entity_id: 'approval:ask-1', kind: 'execution.action', ts: 502 },
    ]);
    expect(out.run.gateway).toEqual({
      policy_result: 'allowed',
      per_call_trace: [
        {
          commit_id: 'commit-detail-real',
          kind: 'action',
          ingredient: 'mail-send',
          tool: 'send',
          decision: 'allowed',
          verdict: 'succeeded',
          dispatched_at: 503,
          completed_at: 531,
          duration_ms: 28,
          cached: true,
        },
      ],
    });
    expect(out.run.gateway.per_call_trace).not.toBe('pending-commit-log-read');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('config_snapshot');
    expect(serialized).not.toContain('sk-secret-value');
    expect(serialized).not.toContain('step_state');
    expect(serialized).not.toContain('arg_overrides');
    expect(serialized).not.toContain('do-not-return');
    expect(serialized).not.toContain('mcp-secret-token-id');
    expect(serialized).not.toContain('commit-secret-arg');
    expect(serialized).not.toContain('commit-secret-output');
  });

  it('carries the D-181 §12 error_category onto the run-detail audit summary', async () => {
    await append('stalled-run', 600, {
      commit_status: 'failed',
      execution_source: userSource,
      error_category: 'stalled',
    });
    const out = await handleExecutionGet(deps, { run_id: 'stalled-run' });
    expect(out.run.audit.error_category).toBe('stalled');
  });

  it('omits error_category from an ordinary failed run detail', async () => {
    await append('plain-detail', 700, {
      commit_status: 'failed',
      execution_source: userSource,
    });
    const out = await handleExecutionGet(deps, { run_id: 'plain-detail' });
    expect(out.run.audit.error_category).toBeUndefined();
  });

  it('returns not_found for an unknown run_id', async () => {
    await expect(handleExecutionGet(deps, { run_id: 'missing' }))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('D-174 execution.* slice posture', () => {
  it('registers the owner execution methods and keeps them out of MCP_TOOL_CATALOG', () => {
    expect(SERVER_RPC_METHOD_SET.has('execution.list')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('execution.get')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('execution.action.get')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('execution.action.list')).toBe(true);
    expect(MCP_TOOL_CATALOG).not.toContain('execution.list');
    expect(MCP_TOOL_CATALOG).not.toContain('execution.get');
    expect(MCP_TOOL_CATALOG).not.toContain('execution.action.get');
    expect(MCP_TOOL_CATALOG).not.toContain('execution.action.list');
    expect(isMcpToolName('execution.list')).toBe(false);
    expect(isMcpToolName('execution.get')).toBe(false);
    expect(isMcpToolName('execution.action.get')).toBe(false);
    expect(isMcpToolName('execution.action.list')).toBe(false);
  });

  it('rejects an unregistered caller before reading the stores', async () => {
    const slice = makeExecutionFeedHandlers(deps)!;
    const dispatch = createRpcDispatcher(slice.handlers as never, {});
    const r = await dispatch('execution.list', {}, ctx(null));
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('allows a registered caller and claims the run and action methods', async () => {
    await append('registered-run', 100);
    const slice = makeExecutionFeedHandlers(deps)!;
    expect(slice.methods).toEqual([
      'execution.list',
      'execution.get',
      'execution.action.get',
      'execution.action.list',
    ]);
    const dispatch = createRpcDispatcher(slice.handlers as never, {});
    const r = await dispatch('execution.list', {}, ctx('webclient-1'));
    expect(r.ok).toBe(true);
    expect((r as { body: { runs: Array<{ run_id: string }> } }).body.runs[0]!.run_id)
      .toBe('registered-run');
  });

  it('drops the slice when deps are absent', () => {
    expect(makeExecutionFeedHandlers(undefined)).toBeUndefined();
  });
});
