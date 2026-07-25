/** D-145 engine-wiring slice 3b.3 — handleExecute commit Gateway wiring. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Commit,
  ContractSnapshot,
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createCommitStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CommitStore,
} from '@recued/storage';

import {
  _testing as executeHandlerTesting,
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createRecipeStore } from '../recipe-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import {
  createContractScanFn,
  createContractStore,
} from '../storage/contract-store.js';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;
const NOW = 1_700_000_000_000;

const scheduleSource: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '*/5 * * * *',
  source_recipe: 'commit-gateway-http-recipe',
};

// D-209 §1.4 — the owner acting DIRECTLY (HID) takes the `admin` stage-trust
// ceiling, so an action WRITE relaxes to a silent admit and EXECUTES → a real
// succeeded/failed commit is persisted. (A background `schedule`/`reactive` WRITE
// now HOLDS for review under D-209; that hold is covered by d-192-baseline-admission
// + saga-write-seal. These commit-persistence cases need the action to RUN, so they
// model the owner's own interactive dispatch — a scheduled READ still admits and is
// exercised by the `query`-kind test below.)
const ownerSource: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'owner-1',
  client_token_id: 'client-token-1',
};

const mcpSource = (contract_id: string): ExecutionSource => ({
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'stdio-local',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id,
});

const contractSnapshot = (
  contract_id: string,
  allowed_tools: readonly string[],
): ContractSnapshot => ({
  contract_id,
  contract_version: 'v1',
  allowed_tools,
  approval_required: [],
  scope_restrictions: [],
  resolved_at: NOW,
});

const jsonResponse = (
  body: unknown,
  status = 200,
): Response => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : `Error ${status}`,
  headers: { get: () => 'application/json' },
  json: async () => body,
  text: async () => JSON.stringify(body),
} as unknown as Response);

const buildManifest = (
  overrides: Partial<IngredientManifest> = {},
): IngredientManifest =>
  ({
    slug: 'commit-http-action',
    name: 'Commit HTTP Action',
    description: 'HTTP action fixture for commit Gateway wiring tests.',
    author: 'test',
    kind: 'http',
    category: 'action',
    risk_tier: 'write',
    version: 1,
    input: {
      method: 'POST',
      url: 'https://example.test/commit',
    },
    output: { ok: 'ok' },
    ...overrides,
  }) as IngredientManifest;

const ingredientStep = (
  input: Record<string, unknown>,
): RecipeDefinition['steps'][number] =>
  ({
    id: 'send_http',
    ingredient: 'commit-http-action',
    input,
  }) as RecipeDefinition['steps'][number];

const buildRecipe = (
  recipe_id: string,
  input: Record<string, unknown>,
): RecipeDefinition =>
  ({
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id,
      description: 'Minimal recipe fixture for commit Gateway wiring.',
      author: 'test',
      supported_platforms: ['test'],
      tags: ['test', 'commit', 'gateway'],
    },
    variables: {},
    prefetch_steps: [],
    steps: [ingredientStep(input)],
    output: { sidebar: [] },
  }) as RecipeDefinition;

const makeDeps = (
  recipe: RecipeDefinition,
  manifests: readonly IngredientManifest[],
  overrides: Partial<ExecuteHandlerDeps> = {},
): ExecuteHandlerDeps => {
  const registry: ManifestRegistry = createManifestRegistry('/nonexistent');
  for (const manifest of manifests) registry.register(manifest);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  return {
    recipeStore,
    executorConfig: { manifests: registry },
    baseVault: {},
    instanceId: 'server-test-1',
    ...overrides,
  };
};

const mkAuditLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const mkCommitStore = (): CommitStore =>
  createCommitStore(createInMemoryCollection<Commit>());

const latestAuditEntry = async (auditLog: AuditLogStore): Promise<AuditEntry> => {
  const [entry] = await auditLog.listRecent(10);
  if (!entry) throw new Error('missing audit entry');
  return entry;
};

beforeEach(() => {
  executeHandlerTesting.correlationTracker.reset();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('handleExecute D-145 slice 3b.3 commit writes', () => {
  it('writes one succeeded commit for an HTTP ingredient when commitStore and execution_source are present', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const stepInput = { body: { message: 'ship it' }, 'query.trace': 'commit-a' };
    const recipe = buildRecipe('commit-gateway-success', stepInput);
    const auditLog = mkAuditLog();
    const commitStore = mkCommitStore();
    const deps = makeDeps(recipe, [buildManifest()], { auditLog, commitStore });

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
      execution_source: ownerSource,
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const auditEntry = await latestAuditEntry(auditLog);
    expect(await commitStore.size()).toBe(1);

    const commits = await commitStore.listByCorrelation(auditEntry.correlation_id!);
    expect(commits).toHaveLength(1);
    const [commit] = commits;
    expect(commit).toBeDefined();
    expect(commit!.request_id).toBe(auditEntry.run_id);
    expect(commit!.kind).toBe('action');
    expect(commit!.status).toBe('succeeded');
    expect(commit!.args).toEqual(stepInput);
    expect(commit!.source).toEqual(ownerSource);
    expect(commit!.channel_session_id).toBe(auditEntry.channel_session_id);
    expect(commit!.correlation_id).toBe(auditEntry.correlation_id);
  });

  it('does not write a commit when commitStore is absent from deps', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const unpassedCommitStore = mkCommitStore();
    const recipe = buildRecipe('commit-gateway-no-store', { body: { message: 'no store' } });
    const auditLog = mkAuditLog();
    const deps = makeDeps(recipe, [buildManifest()], { auditLog });

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
      execution_source: ownerSource,
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await unpassedCommitStore.size()).toBe(0);
    const auditEntry = await latestAuditEntry(auditLog);
    expect(auditEntry.execution_source).toEqual(ownerSource);
  });

  it('does not write a commit when execution_source is absent even with a commitStore present', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const recipe = buildRecipe('commit-gateway-no-source', { body: { message: 'legacy' } });
    const auditLog = mkAuditLog();
    const commitStore = mkCommitStore();
    const deps = makeDeps(recipe, [buildManifest()], { auditLog, commitStore });

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await commitStore.size()).toBe(0);
    const auditEntry = await latestAuditEntry(auditLog);
    expect(auditEntry.execution_source).toBeUndefined();
  });

  it('records a failed commit when the ingredient call fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));
    const stepInput = { body: { message: 'bad' } };
    const recipe = buildRecipe('commit-gateway-failed', stepInput);
    const auditLog = mkAuditLog();
    const commitStore = mkCommitStore();
    const deps = makeDeps(recipe, [buildManifest()], { auditLog, commitStore });

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
      execution_source: ownerSource,
    });

    expect(result.success).toBe(false);
    const auditEntry = await latestAuditEntry(auditLog);
    expect(auditEntry.commit_status).toBe('failed');
    expect(await commitStore.size()).toBe(1);

    const commits = await commitStore.listByCorrelation(auditEntry.correlation_id!);
    expect(commits).toHaveLength(1);
    const [commit] = commits;
    expect(commit).toMatchObject({
      request_id: auditEntry.run_id,
      kind: 'action',
      status: 'failed',
      args: stepInput,
    });
    expect(commit).not.toHaveProperty('output');
  });

  it('derives the commit kind from the ingredient category — a data ingredient yields kind "query"', async () => {
    // The other tests all use `action` ingredients, which cannot
    // discriminate the `getIngredientCategory` wiring: `deriveCommitKind`
    // also falls back to `'action'` for an unknown / unresolved
    // category. A `data` ingredient → `'query'` proves the manifest
    // category genuinely reaches the Gateway.
    fetchMock.mockResolvedValue(jsonResponse({ rows: [] }));
    const stepInput = { body: { query: 'recent' } };
    const recipe = buildRecipe('commit-gateway-query', stepInput);
    const auditLog = mkAuditLog();
    const commitStore = mkCommitStore();
    const deps = makeDeps(
      recipe,
      [buildManifest({ category: 'data', risk_tier: 'read' })],
      { auditLog, commitStore },
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'schedule',
      execution_source: scheduleSource,
    });

    expect(result.success).toBe(true);
    const auditEntry = await latestAuditEntry(auditLog);
    const commits = await commitStore.listByCorrelation(auditEntry.correlation_id!);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.kind).toBe('query');
  });

  it('decrements bounded contract uses exactly once per successful gated MCP dispatch', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const db = new Database(':memory:');
    try {
      const contractStore = createContractStore(db, { now: () => NOW });
      const definitionStore = createContractDefinitionStore(contractStore, {
        now: () => NOW,
        newId: () => 'ct_gateway_uses',
      });
      const def = definitionStore.mint({
        minted_by: 'user:1',
        display_name: 'Gateway use counter contract',
        scope: { ingredient_ids: ['commit-http-action'] },
        max_uses: 3,
      });
      const scan = createContractScanFn(contractStore);
      const contractOverlay = createContractOverlayResolver({
        definitionStore,
        now: () => NOW,
      });
      const recipe = buildRecipe('commit-gateway-contract-use', {
        body: { message: 'spend one use' },
      });
      const auditLog = mkAuditLog();
      const commitStore = mkCommitStore();
      // D-187 slice 4 — the use-counter decrements per SUCCESSFUL gated dispatch. A
      // contracted (mcp) WRITE now HOLDS for approval (the LOW ceiling surfaces AI writes),
      // so it never reaches the success/metering point. A READ dispatch admits + succeeds,
      // exercising the decrement exactly as before (the use-counter is risk-agnostic).
      const deps = makeDeps(recipe, [buildManifest({ category: 'data', risk_tier: 'read' })], {
        auditLog,
        commitStore,
        contractOverlay,
        contractScan: scan,
      });
      const request = {
        recipe_id: recipe.recipe_id,
        trigger_source: 'mcp' as const,
        execution_source: mcpSource(def.contract_id),
        contract_snapshot: contractSnapshot(def.contract_id, ['commit-http-action']),
      };

      await expect(handleExecute(deps, request)).resolves.toMatchObject({
        success: true,
      });
      await expect(handleExecute(deps, request)).resolves.toMatchObject({
        success: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await commitStore.size()).toBe(2);
      expect(definitionStore.get(def.contract_id)).toEqual(
        expect.objectContaining({
          max_uses: 3,
          uses_remaining: 1,
        }),
      );
    } finally {
      db.close();
    }
  });
});
