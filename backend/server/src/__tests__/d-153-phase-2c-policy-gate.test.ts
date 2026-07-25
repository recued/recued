/** D-153 P2.C — schedule-channel policy gate wiring.
 *
 *  Pure coverage pins `gateRecipeAgainstPolicy`'s step-walk,
 *  fail-closed, aggregation, phase-tagging, and summary-formatting
 *  invariants. Handler coverage verifies `handleExecute` runs the gate
 *  for the closed system-channel set (`schedule`, `reactive`).
 */

import { describe, expect, it, vi } from 'vitest';
import { createInternalToolRegistry } from '@recued/middleware/internal-tool-registry/index.js';

import {
  type ContractSnapshot,
  type ExecutionSource,
  type IngredientManifest,
  type RecipeDefinition,
  type RecipeError,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';

import { createEventBus } from '../events/bus.js';
import { buildChatToolRegistryInputs } from '../chat-tool-handlers.js';
import {
  _testing as executeHandlerTesting,
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { _testing } from '../mcp-server.js';
import {
  gateRecipeAgainstPolicy,
  POLICY_GATE_STEP_PHASES,
  renderPolicyGateDenialSummary,
  type PolicyGateDenial,
  type PolicyGateResult,
} from '../policy-gate.js';
import { createRecipeStore } from '../recipe-store.js';
import type { ExecuteRequest, ExecuteResponse } from '../types.js';
import type { WsClient } from '../ws-server.js';

const scheduleSource: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 9 * * *',
  source_recipe: 'daily-briefing',
};

const reactiveSource: ExecutionSource = {
  channel: 'reactive',
  actor: 'system',
  event_kind: 'auto_run_tick',
  source_recipe: 'daily-briefing',
};

// D-209 #1 W3 — webhook is an ANONYMOUS door source (door-less here: this file
// exercises the ungated-channel passthrough, not the door).
const webhookSource: ExecutionSource = {
  channel: 'webhook',
  actor: 'anonymous',
  vendor: 'test-vendor',
  webhook_secret_id: 'whsec-test',
};

const housekeepingSource: ExecutionSource = {
  channel: 'housekeeping',
  actor: 'system',
  cycle_id: 'cycle-1',
  task: 'audit-compaction',
  visible_to_user: false,
};

const mcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'stdio_local',
  tool_call_id: 'mcp-test-abc',
  mcp_token_id: 'tok1',
  contract_id: 'tok1',
};

const chatSource: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'sess-1',
  user_id: 'local',
};

const userSource: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'local',
  client_token_id: 'tok-test',
};

const buildManifest = (
  slug: string,
  kind: IngredientManifest['kind'],
  risk_tier: IngredientManifest['risk_tier'],
): IngredientManifest => ({
  slug,
  name: slug,
  description: `Test manifest for ${slug}`,
  author: 'test',
  kind,
  risk_tier,
  version: 1,
  category: 'data',
  input: {},
  output: { data: 'data' },
}) as unknown as IngredientManifest;

const buildHttpManifest = (slug: string): IngredientManifest => ({
  ...buildManifest(slug, 'http', 'read'),
  input: { url: 'https://example.com/fixture', method: 'GET' },
  output: { body: 'body' },
}) as IngredientManifest;

const buildContractSnapshot = (
  allowed_tools: readonly string[],
  overrides: Partial<ContractSnapshot> = {},
): ContractSnapshot => ({
  contract_id: 'tok1',
  contract_version: '1',
  allowed_tools,
  approval_required: [],
  scope_restrictions: [],
  resolved_at: Date.now(),
  ...overrides,
});

const buildRecipe = (
  overrides: Partial<RecipeDefinition> = {},
): RecipeDefinition => ({
  recipe_id: 'd-153-policy-gate-test',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-153 policy gate test',
    description: 'Minimal recipe fixture for D-153 policy gate coverage.',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test', 'policy', 'gate'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  ...overrides,
}) as RecipeDefinition;

const ingredientStep = (
  id: string,
  ingredient: string,
): RecipeDefinition['steps'][number] => ({ id, ingredient, input: {} });

const manifestGetter = (
  ...manifests: IngredientManifest[]
): ((slug: string) => IngredientManifest | undefined) => {
  const bySlug = new Map(manifests.map((m) => [m.slug, m]));
  return (slug) => bySlug.get(slug);
};

const registerManifests = (
  registry: ManifestRegistry,
  manifests: readonly IngredientManifest[],
): void => {
  for (const manifest of manifests) registry.register(manifest);
};

const makeDeps = (
  recipe: RecipeDefinition,
  manifests: readonly IngredientManifest[],
  overrides: Partial<ExecuteHandlerDeps> = {},
): ExecuteHandlerDeps => {
  const registry = createManifestRegistry('/nonexistent');
  registerManifests(registry, manifests);
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

const makeRegistryMcpHarness = (
  recipe: RecipeDefinition,
  manifests: readonly IngredientManifest[],
  overrides: Partial<Parameters<typeof _testing.handleToolCall>[1]> = {},
): {
  deps: Parameters<typeof _testing.handleToolCall>[1];
  capturedRequests: ExecuteRequest[];
  registry: ReturnType<typeof createInternalToolRegistry>;
} => {
  const executeDeps = makeDeps(recipe, manifests, overrides);
  const capturedRequests: ExecuteRequest[] = [];
  const execute = async (request: ExecuteRequest): Promise<ExecuteResponse> => {
    capturedRequests.push(request);
    return handleExecute(executeDeps, request);
  };
  const registryInputs = buildChatToolRegistryInputs({
    getContactStore: () => undefined,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => executeDeps.recipeStore,
    getExecutorConfig: () => executeDeps.executorConfig,
    getExecuteRecipe: () => execute,
  });
  const registry = createInternalToolRegistry({
    tier1Handlers: registryInputs.tier1Handlers,
    tier2Source: registryInputs.tier2Source,
    manifestLookup: registryInputs.manifestLookup,
    tier2Dispatch: registryInputs.tier2Dispatch,
  });
  return {
    deps: {
      ...executeDeps,
      ...overrides,
      internalRegistry: registry,
    } as Parameters<typeof _testing.handleToolCall>[1],
    capturedRequests,
    registry,
  };
};

const buildWsClient = (overrides: Partial<WsClient> = {}): WsClient => ({
  ws: {},
  realm: 'test-realm',
  instance_id: 'inst-test',
  display_name: 'Test Client',
  connected_at: 0,
  ...overrides,
});

const withJsonFetch = async <T>(body: unknown, fn: () => Promise<T>): Promise<T> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const parseMcpText = (res: unknown): ExecuteResponse =>
  JSON.parse((res as { content: Array<{ text: string }> }).content[0].text) as ExecuteResponse;

const mkAuditLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const errorsContainCode = (
  errors: readonly unknown[],
  code: string,
): boolean =>
  errors.some((error) =>
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === code,
  );

const firstRecipeError = (errors: readonly unknown[]): RecipeError =>
  errors[0] as RecipeError;

const expectSingleDenial = (
  result: PolicyGateResult,
): PolicyGateDenial => {
  expect(result.admit).toBe(false);
  expect(result.denials).toHaveLength(1);
  const denial = result.denials[0];
  if (!denial) throw new Error('expected a policy-gate denial');
  return denial;
};

const sampleDenial = (
  step_id: string,
  phase: PolicyGateDenial['phase'],
  ingredient: string,
  detail = 'sample detail',
): PolicyGateDenial => ({
  step_id,
  phase,
  ingredient,
  decision: Object.freeze({
    verdict: 'deny',
    code: 'tool_not_in_contract',
    detail,
  }),
});

describe('D-153 P2.C gateRecipeAgainstPolicy — pure invariants', () => {
  it('exports the three recipe phases in engine declaration order', () => {
    expect(POLICY_GATE_STEP_PHASES).toEqual(['trigger', 'prefetch', 'sequential']);
  });

  it('admits a schedule recipe whose ingredient kind and risk tier are allowed', () => {
    const recipe = buildRecipe({
      steps: [ingredientStep('read_http', 'safe-http')],
    });
    const result = gateRecipeAgainstPolicy(
      recipe,
      scheduleSource,
      manifestGetter(buildManifest('safe-http', 'http', 'read')),
    );

    expect(result).toEqual({ admit: true, denials: [] });
  });

  it('D-187: no longer statically denies on ingredient KIND — the coarse kind gate is retired', () => {
    // The matrix denied a kind outside the cell's `allowed_kinds`. D-187 slice 4 retires
    // the coarse kind gate from the op-risk approval walk: kind is gated at install
    // validation + Layer-1 access (op-admission), not here. A read op admits regardless
    // of kind (op-risk reads at the manifest `risk_tier`, not the kind).
    const recipe = buildRecipe({
      steps: [ingredientStep('bad_kind', 'bad-kind')],
    });
    const result = gateRecipeAgainstPolicy(
      recipe,
      scheduleSource,
      manifestGetter(
        buildManifest(
          'bad-kind',
          'not-a-real-kind' as IngredientManifest['kind'],
          'read',
        ),
      ),
    );

    expect(result).toEqual({ admit: true, denials: [] });
  });

  it('D-187: no longer statically denies destructive on schedule — it becomes a per-call always-ask', () => {
    // The matrix hard-denied destructive under the schedule baseline (`allowed_risk_tiers`
    // = read/write). D-187 op-risk makes destructive an ALWAYS-ASK (the floor trust can't
    // cross) rather than a hard deny — so the static walk, which surfaces only `deny`,
    // lets it fall through (admit). The per-call gate raises the approval; on an unattended
    // schedule that pauses the run for owner approval instead of a clean pre-run reject.
    const recipe = buildRecipe({
      steps: [ingredientStep('destroy', 'danger-storage')],
    });
    const result = gateRecipeAgainstPolicy(
      recipe,
      scheduleSource,
      manifestGetter(buildManifest('danger-storage', 'storage', 'destructive')),
    );

    expect(result).toEqual({ admit: true, denials: [] });
  });

  it('fails closed when a step references a manifest missing from the registry', () => {
    const recipe = buildRecipe({
      steps: [ingredientStep('missing', 'not-registered')],
    });
    const result = gateRecipeAgainstPolicy(recipe, scheduleSource, () => undefined);

    const denial = expectSingleDenial(result);
    expect(denial.ingredient).toBe('not-registered');
    expect(denial.decision.code).toBe('kind_not_allowed');
    expect(denial.decision.detail).toContain('not found in registry');
    expect(denial.decision.detail).toContain('fail-closed');
  });

  it('aggregates all violating ingredient steps instead of short-circuiting', () => {
    // D-187 — the coarse risk-tier deny is retired, so the remaining static denial is
    // the manifest-miss fail-closed (`kind_not_allowed`). Two missing manifests exercise
    // the aggregation (collect all, don't short-circuit) the same way.
    const recipe = buildRecipe({
      steps: [
        ingredientStep('safe', 'safe-storage'),
        ingredientStep('deny_a', 'missing-a'),
        ingredientStep('deny_b', 'missing-b'),
      ],
    });
    const result = gateRecipeAgainstPolicy(
      recipe,
      scheduleSource,
      manifestGetter(buildManifest('safe-storage', 'storage', 'read')),
    );

    expect(result.admit).toBe(false);
    expect(result.denials.map((d) => d.step_id)).toEqual(['deny_a', 'deny_b']);
    expect(result.denials.map((d) => d.decision.code)).toEqual([
      'kind_not_allowed',
      'kind_not_allowed',
    ]);
  });

  it('tags denials with trigger, prefetch, and sequential phases', () => {
    // D-187 — manifest-miss (the remaining static deny) in each phase exercises the
    // phase tagging; the prior destructive-risk trigger no longer denies statically.
    const recipe = buildRecipe({
      trigger_steps: [ingredientStep('trigger_call', 'missing-x')],
      prefetch_steps: [{ id: 'prefetch_call', ingredient: 'missing-x', input: {} }],
      steps: [ingredientStep('sequential_call', 'missing-x')],
    });
    const result = gateRecipeAgainstPolicy(recipe, scheduleSource, manifestGetter());

    expect(result.denials.map((d) => [d.step_id, d.phase])).toEqual([
      ['trigger_call', 'trigger'],
      ['prefetch_call', 'prefetch'],
      ['sequential_call', 'sequential'],
    ]);
  });

  it('skips transform and guard steps and gates only ingredient steps', () => {
    // D-187 — manifest-miss on the ingredient step is the remaining static deny.
    const recipe = buildRecipe({
      steps: [
        { id: 'X', transform: 'filter', mode: 'all', conditions: [] },
        { id: 'Y', guard: 'recipe-foo' },
        ingredientStep('danger', 'missing-danger'),
      ],
    });
    const result = gateRecipeAgainstPolicy(recipe, scheduleSource, manifestGetter());

    const denial = expectSingleDenial(result);
    expect(denial.step_id).toBe('danger');
    expect(result.denials.map((d) => d.step_id)).not.toContain('X');
    expect(result.denials.map((d) => d.step_id)).not.toContain('Y');
  });

  it('admits an mcp contract-scoped recipe when the snapshot allowed_tools contains the ingredient slug', () => {
    const recipe = buildRecipe({
      steps: [ingredientStep('allowed', 'safe-storage')],
    });
    const permissiveSnapshot = buildContractSnapshot(['safe-storage']);

    const result = gateRecipeAgainstPolicy(
      recipe,
      mcpSource,
      manifestGetter(buildManifest('safe-storage', 'storage', 'read')),
      permissiveSnapshot,
    );

    expect(result).toEqual({ admit: true, denials: [] });
  });

  it('denies an mcp contract-scoped recipe when the snapshot allowed_tools omits the ingredient slug', () => {
    const recipe = buildRecipe({
      steps: [ingredientStep('blocked', 'safe-storage')],
    });
    const snapshotWithoutSlug = buildContractSnapshot(['different-storage']);

    const result = gateRecipeAgainstPolicy(
      recipe,
      mcpSource,
      manifestGetter(buildManifest('safe-storage', 'storage', 'read')),
      snapshotWithoutSlug,
    );

    const denial = expectSingleDenial(result);
    expect(denial.step_id).toBe('blocked');
    expect(denial.ingredient).toBe('safe-storage');
    expect(denial.decision.code).toBe('tool_not_in_contract');
  });

  it('resolves config ingredient refs before manifest lookup when a resolver returns a slug', () => {
    const recipe = buildRecipe({
      steps: [ingredientStep('templated', '{{config.ingredient_slug}}')],
    });
    const manifest = buildManifest('safe-storage', 'storage', 'read');
    const manifestLookup = vi.fn((slug: string) =>
      slug === 'safe-storage' ? manifest : undefined,
    );
    const resolveConfigRef = vi.fn(() => 'safe-storage');

    const result = gateRecipeAgainstPolicy(
      recipe,
      mcpSource,
      manifestLookup,
      buildContractSnapshot(['safe-storage']),
      resolveConfigRef,
    );

    expect(result).toEqual({ admit: true, denials: [] });
    expect(resolveConfigRef).toHaveBeenCalledWith('{{config.ingredient_slug}}');
    expect(manifestLookup).toHaveBeenCalledWith('safe-storage');
    expect(manifestLookup).not.toHaveBeenCalledWith('{{config.ingredient_slug}}');
  });

  it('fails closed on the literal config ingredient ref when the resolver cannot resolve it', () => {
    const recipe = buildRecipe({
      steps: [ingredientStep('templated', '{{config.ingredient_slug}}')],
    });
    const manifestLookup = vi.fn(() => undefined);
    const resolveConfigRef = vi.fn(() => undefined);

    const result = gateRecipeAgainstPolicy(
      recipe,
      mcpSource,
      manifestLookup,
      buildContractSnapshot(['safe-storage']),
      resolveConfigRef,
    );

    const denial = expectSingleDenial(result);
    expect(resolveConfigRef).toHaveBeenCalledWith('{{config.ingredient_slug}}');
    expect(manifestLookup).toHaveBeenCalledWith('{{config.ingredient_slug}}');
    expect(denial.ingredient).toBe('{{config.ingredient_slug}}');
    expect(denial.decision.code).toBe('kind_not_allowed');
    expect(denial.decision.detail).toContain("ingredient manifest '{{config.ingredient_slug}}'");
  });

  it('throws for contract-scoped actors when no ContractSnapshot is supplied', () => {
    const recipe = buildRecipe({
      steps: [ingredientStep('safe', 'safe-storage')],
    });

    expect(() =>
      gateRecipeAgainstPolicy(
        recipe,
        mcpSource,
        manifestGetter(buildManifest('safe-storage', 'storage', 'read')),
      ),
    ).toThrow(/ContractSnapshot/);
    expect(() =>
      gateRecipeAgainstPolicy(
        recipe,
        mcpSource,
        manifestGetter(buildManifest('safe-storage', 'storage', 'read')),
      ),
    ).toThrow(/producer must resolve it before dispatch/);
  });
});

describe('D-153 P2.C renderPolicyGateDenialSummary', () => {
  it('renders zero denials as the admit string', () => {
    expect(renderPolicyGateDenialSummary([])).toContain('admit (no denials)');
  });

  it('renders one denial with step id, phase, ingredient, code, and detail', () => {
    const summary = renderPolicyGateDenialSummary([
      sampleDenial('step-1', 'sequential', 'danger-storage', 'sample risk detail'),
    ]);

    expect(summary).toContain('step-1');
    expect(summary).toContain('sequential');
    expect(summary).toContain('danger-storage');
    expect(summary).toContain('tool_not_in_contract');
    expect(summary).toContain('sample risk detail');
  });

  it("joins multiple denials with '; '", () => {
    const summary = renderPolicyGateDenialSummary([
      sampleDenial('step-1', 'trigger', 'first-storage'),
      sampleDenial('step-2', 'prefetch', 'second-storage'),
    ]);

    expect(summary).toContain('; ');
    expect(summary).toContain('step-1/trigger');
    expect(summary).toContain('step-2/prefetch');
  });
});

describe('D-153 P2.C handleExecute — schedule policy gate wiring', () => {
  it('does not return RECIPE_POLICY_DENIED for an admissible scheduled ingredient recipe', async () => {
    const recipe = buildRecipe({
      recipe_id: 'schedule-admit',
      steps: [ingredientStep('read_storage', 'safe-storage')],
    });
    const deps = makeDeps(recipe, [
      buildManifest('safe-storage', 'storage', 'read'),
    ]);

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'schedule',
      execution_source: scheduleSource,
    });

    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });

  it('returns RECIPE_POLICY_DENIED, emits lifecycle error, and writes failed audit on schedule denial', async () => {
    // D-187 — the coarse risk-tier deny is retired, so the static gate denies a schedule
    // recipe on the remaining fail-closed path: a manifest missing from the registry
    // (`unregistered-storage` → `kind_not_allowed`). Exercises the same RECIPE_POLICY_DENIED
    // lifecycle (fatal error + failed audit + start/error events).
    const recipe = buildRecipe({
      recipe_id: 'schedule-deny',
      steps: [ingredientStep('destroy_storage', 'unregistered-storage')],
    });
    const auditLog = mkAuditLog();
    const eventBus = createEventBus();
    const deps = makeDeps(recipe, [], { auditLog, eventBus });

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'schedule',
      execution_source: scheduleSource,
    });

    expect(result.success).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.duration_ms).toBe(0);
    expect(result.output.sidebar).toEqual([]);

    const error = firstRecipeError(result.errors);
    expect(error.code).toBe('RECIPE_POLICY_DENIED');
    expect(error.severity).toBe('fatal');
    expect(error.message).toContain('D-153 policy gate denied');
    const details = error.details as { denials?: PolicyGateDenial[] };
    expect(details.denials).toHaveLength(1);
    expect(details.denials?.[0]?.step_id).toBe('destroy_storage');
    expect(details.denials?.[0]?.decision.code).toBe('kind_not_allowed');

    const entries = await auditLog.listRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recipe_id).toBe(recipe.recipe_id);
    expect(entries[0]?.commit_status).toBe('failed');
    expect(entries[0]?.duration_ms).toBe(0);
    expect(entries[0]?.errors[0]?.code).toBe('RECIPE_POLICY_DENIED');

    const executionEvents = eventBus
      .replay(0)
      .filter((event) => event.kind === 'execution')
      .map((event) => event.op);
    expect(executionEvents).toEqual(['start', 'error']);
  });

  it('does not run the schedule gate for non-schedule execution sources', async () => {
    const recipe = buildRecipe({
      recipe_id: 'webhook-passthrough',
      steps: [ingredientStep('destroy_storage', 'danger-storage')],
    });
    const deps = makeDeps(recipe, [
      buildManifest('danger-storage', 'storage', 'destructive'),
    ]);

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'webhook',
      execution_source: webhookSource,
    });

    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });
});

describe('D-153 P2.C handleExecute — reactive policy gate wiring', () => {
  it('does not return RECIPE_POLICY_DENIED for an admissible reactive ingredient recipe', async () => {
    const recipe = buildRecipe({
      recipe_id: 'reactive-admit',
      steps: [ingredientStep('read_storage', 'safe-storage')],
    });
    const deps = makeDeps(recipe, [
      buildManifest('safe-storage', 'storage', 'read'),
    ]);

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'auto_run',
      execution_source: reactiveSource,
    });

    expect(result.steps.map((step) => step.id)).toEqual(['read_storage']);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });

  it('returns RECIPE_POLICY_DENIED, emits lifecycle error, and writes failed audit on reactive denial', async () => {
    // D-187 — manifest-miss (`unregistered-storage` → `kind_not_allowed`) is the remaining
    // static deny after the coarse risk-tier gate is retired; same RECIPE_POLICY_DENIED path.
    const recipe = buildRecipe({
      recipe_id: 'reactive-deny',
      steps: [ingredientStep('destroy_storage', 'unregistered-storage')],
    });
    const auditLog = mkAuditLog();
    const eventBus = createEventBus();
    const deps = makeDeps(recipe, [], { auditLog, eventBus });

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'auto_run',
      execution_source: reactiveSource,
    });

    expect(result.success).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.duration_ms).toBe(0);
    expect(result.output.sidebar).toEqual([]);

    const error = firstRecipeError(result.errors);
    expect(error.code).toBe('RECIPE_POLICY_DENIED');
    expect(error.severity).toBe('fatal');
    expect(error.message).toContain('D-153 policy gate denied');
    const details = error.details as { denials?: PolicyGateDenial[] };
    expect(details.denials).toHaveLength(1);
    expect(details.denials?.[0]?.step_id).toBe('destroy_storage');
    expect(details.denials?.[0]?.decision.code).toBe('kind_not_allowed');

    const entries = await auditLog.listRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recipe_id).toBe(recipe.recipe_id);
    expect(entries[0]?.commit_status).toBe('failed');
    expect(entries[0]?.duration_ms).toBe(0);
    expect(entries[0]?.errors[0]?.code).toBe('RECIPE_POLICY_DENIED');

    const executionEvents = eventBus
      .replay(0)
      .filter((event) => event.kind === 'execution')
      .map((event) => event.op);
    expect(executionEvents).toEqual(['start', 'error']);
  });

  it('does not run the system-channel gate for webhook or housekeeping execution sources', async () => {
    const recipe = buildRecipe({
      recipe_id: 'system-channel-passthrough',
      steps: [ingredientStep('destroy_storage', 'danger-storage')],
    });
    const deps = makeDeps(recipe, [
      buildManifest('danger-storage', 'storage', 'destructive'),
    ]);

    for (const executionSource of [webhookSource, housekeepingSource]) {
      const result = await handleExecute(deps, {
        recipe_id: recipe.recipe_id,
        trigger_source: executionSource.channel,
        execution_source: executionSource,
      });

      expect(result.steps.map((step) => step.id)).toEqual(['destroy_storage']);
      expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    }
  });
});

describe('D-153 P2.C handleExecute — chat policy gate wiring', () => {
  it('does not return RECIPE_POLICY_DENIED for an admissible chat storage-read recipe', async () => {
    const recipe = buildRecipe({
      recipe_id: 'chat-storage-admit',
      steps: [ingredientStep('read_storage', 'safe-storage')],
    });
    const deps = makeDeps(recipe, [
      buildManifest('safe-storage', 'storage', 'read'),
    ]);

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'chat',
      execution_source: chatSource,
    });

    expect(result.steps.map((step) => step.id)).toEqual(['read_storage']);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });

  it('admits chat write risk_tier ingredients', async () => {
    const manifest = {
      ...buildHttpManifest('chat-write-http'),
      risk_tier: 'write',
    } as IngredientManifest;
    const recipe = buildRecipe({
      recipe_id: 'chat-write-admit',
      steps: [ingredientStep('write_http', manifest.slug)],
    });
    const deps = makeDeps(recipe, [manifest]);

    const result = await withJsonFetch({ body: 'chat-write-admit' }, () =>
      handleExecute(deps, {
        recipe_id: recipe.recipe_id,
        trigger_source: 'chat',
        execution_source: chatSource,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.steps.map((step) => step.id)).toEqual(['write_http']);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });

  it('does NOT deny a chat user_self destructive at the static gate (D-177 — approval-gated, not denied)', async () => {
    // D-177 read-gate follow-on (2026-06-11) — destructive on chat/user_self is
    // APPROVAL-gated, not hard-denied. The STATIC recipe gate
    // (gateRecipeAgainstPolicy) no longer refuses it with RECIPE_POLICY_DENIED
    // (destructive is now in allowed_risk_tiers); the per-call APPROVAL hold
    // fires at dispatch (covered by the D-157 preflight suite + the
    // `verdict === 'ask'` contracts test in d-153-phase-2b). The denial
    // machinery for tiers a cell genuinely refuses is covered by the schedule +
    // reactive denial tests above. (Here the admitted step runs to a harness
    // NETWORK_ERROR — no real backend — which is NOT a policy denial.)
    const recipe = buildRecipe({
      recipe_id: 'chat-destructive-not-denied',
      steps: [ingredientStep('destroy_storage', 'danger-storage')],
    });
    const deps = makeDeps(
      recipe,
      [buildManifest('danger-storage', 'storage', 'destructive')],
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'chat',
      execution_source: chatSource,
    });

    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });

  it('does not require contract_snapshot for chat user_self requests', async () => {
    const manifest = buildHttpManifest('chat-no-snapshot-http');
    const recipe = buildRecipe({
      recipe_id: 'chat-no-snapshot',
      steps: [ingredientStep('read_http', manifest.slug)],
    });
    const deps = makeDeps(recipe, [manifest]);

    const result = await withJsonFetch({ body: 'chat-no-snapshot' }, () =>
      handleExecute(deps, {
        recipe_id: recipe.recipe_id,
        trigger_source: 'chat',
        execution_source: chatSource,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.steps.map((step) => step.id)).toEqual(['read_http']);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });
});

describe('D-153 P2.C handleExecute — mcp policy gate wiring', () => {
  it('admits an mcp recipe with a slug present in ExecuteRequest.contract_snapshot', async () => {
    const recipe = buildRecipe({
      recipe_id: 'mcp-admit',
      steps: [ingredientStep('read_http', 'safe-http')],
    });
    const deps = makeDeps(recipe, [buildHttpManifest('safe-http')]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ body: 'admitted' }), {
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response;
    try {
      const result = await handleExecute(deps, {
        recipe_id: recipe.recipe_id,
        trigger_source: 'mcp',
        execution_source: mcpSource,
        contract_snapshot: buildContractSnapshot(['safe-http']),
      });

      expect(result.success).toBe(true);
      expect(result.steps.map((step) => step.id)).toEqual(['read_http']);
      expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns RECIPE_POLICY_DENIED, emits lifecycle error, and writes failed audit when mcp snapshot excludes the slug', async () => {
    const recipe = buildRecipe({
      recipe_id: 'mcp-deny',
      steps: [ingredientStep('blocked_http', 'forbidden-http')],
    });
    const auditLog = mkAuditLog();
    const eventBus = createEventBus();
    const deps = makeDeps(
      recipe,
      [buildHttpManifest('forbidden-http')],
      { auditLog, eventBus },
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildContractSnapshot(['different-http']),
    });

    expect(result.success).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.duration_ms).toBe(0);
    expect(result.output.sidebar).toEqual([]);

    const error = firstRecipeError(result.errors);
    expect(error.code).toBe('RECIPE_POLICY_DENIED');
    expect(error.severity).toBe('fatal');
    expect(error.message).toContain('D-153 policy gate denied');
    const details = error.details as { denials?: PolicyGateDenial[] };
    expect(details.denials).toHaveLength(1);
    expect(details.denials?.[0]?.step_id).toBe('blocked_http');
    expect(details.denials?.[0]?.ingredient).toBe('forbidden-http');
    expect(details.denials?.[0]?.decision.code).toBe('tool_not_in_contract');

    const entries = await auditLog.listRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recipe_id).toBe(recipe.recipe_id);
    expect(entries[0]?.commit_status).toBe('failed');
    expect(entries[0]?.duration_ms).toBe(0);
    expect(entries[0]?.errors[0]?.code).toBe('RECIPE_POLICY_DENIED');

    const executionEvents = eventBus
      .replay(0)
      .filter((event) => event.kind === 'execution')
      .map((event) => event.op);
    expect(executionEvents).toEqual(['start', 'error']);
  });

  it('throws outright for mcp execution_source without a contract_snapshot', async () => {
    const recipe = buildRecipe({
      recipe_id: 'mcp-missing-snapshot',
      steps: [ingredientStep('read_http', 'safe-http')],
    });
    const deps = makeDeps(recipe, [buildHttpManifest('safe-http')]);

    await expect(
      handleExecute(deps, {
        recipe_id: recipe.recipe_id,
        trigger_source: 'mcp',
        execution_source: mcpSource,
      }),
    ).rejects.toThrow(/producer must resolve it before dispatch/);
  });

  it('admits a run-ingredient-shaped mcp recipe by resolving the ingredient slug from config before snapshot evaluation', async () => {
    const recipe = buildRecipe({
      recipe_id: 'mcp-run-ingredient-inline',
      ttl: 0,
      variables: { ingredient_slug: null, input: {} } as unknown as RecipeDefinition['variables'],
      steps: [
        {
          id: 'call',
          ingredient: '{{config.ingredient_slug}}',
          input: '{{config.input}}',
        } as unknown as RecipeDefinition['steps'][number],
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.call' }] },
    });
    const deps = makeDeps(recipe, [buildHttpManifest('safe-http')]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ body: 'templated' }), {
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response;
    try {
      const result = await handleExecute(deps, {
        recipe,
        config: { ingredient_slug: 'safe-http', input: {} },
        trigger_source: 'mcp',
        execution_source: mcpSource,
        contract_snapshot: buildContractSnapshot(['safe-http']),
      });

      expect(result.success).toBe(true);
      expect(result.steps.map((step) => step.id)).toEqual(['call']);
      expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('D-153 P2.C registry MCP wire — Tier 1 recipe.run policy gate', () => {
  it('admits Tier 1 recipe.run when the per-call snapshot includes the recipe ingredient slug', async () => {
    const manifest = buildHttpManifest('registry-tier1-safe-http');
    const recipe = buildRecipe({
      recipe_id: 'registry-tier1-admit',
      steps: [ingredientStep('read_http', manifest.slug)],
    });
    const { deps } = makeRegistryMcpHarness(recipe, [manifest]);

    const res = await withJsonFetch({ body: 'registry-admit' }, () =>
      _testing.handleToolCall(
        { name: 'recipe.run', arguments: { recipe_id: recipe.recipe_id } },
        deps,
      ),
    );

    expect((res as { isError?: boolean }).isError).toBeUndefined();
    const parsed = parseMcpText(res);
    expect(parsed.success).toBe(true);
    expect(parsed.steps.map((step) => step.id)).toEqual(['read_http']);
    expect(errorsContainCode(parsed.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });

  it('denies Tier 1 recipe.run when inbound-token filtering removes the recipe ingredient slug from the snapshot', async () => {
    const manifest = buildHttpManifest('registry-tier1-forbidden-http');
    const recipe = buildRecipe({
      recipe_id: 'registry-tier1-deny',
      steps: [ingredientStep('blocked_http', manifest.slug)],
    });
    const { deps } = makeRegistryMcpHarness(recipe, [manifest], {
      inboundTokenAuthorize: (name: string) => name === 'recipe.run',
    });

    const res = await _testing.handleToolCall(
      { name: 'recipe.run', arguments: { recipe_id: recipe.recipe_id } },
      deps,
    );

    expect((res as { isError?: boolean }).isError).toBeUndefined();
    const parsed = parseMcpText(res);
    expect(parsed.success).toBe(false);
    const error = firstRecipeError(parsed.errors);
    expect(error.code).toBe('RECIPE_POLICY_DENIED');
    const details = error.details as { denials?: PolicyGateDenial[] };
    expect(details.denials?.[0]?.ingredient).toBe(manifest.slug);
    expect(details.denials?.[0]?.decision.code).toBe('tool_not_in_contract');
  });
});

describe('D-153 P2.C registry MCP wire — Tier 2 <publisher>/<recipe_id> policy gate', () => {
  it('admits Tier 2 dispatch when the per-call snapshot includes the recipe ingredient slug', async () => {
    const manifest = buildHttpManifest('registry-tier2-safe-http');
    const recipe = buildRecipe({
      recipe_id: 'some-recipe',
      // Explicit opt-in (293db4ebd, 2026-07-02): an ABSENT `chat_exposed`
      // now defaults HIDDEN for distributed content, and the harness
      // `register()`s the fixture with no stored row ⇒ `user_authored:
      // false`. Without this the Tier 2 entry never enters the catalog,
      // `getByName` misses, and the dispatch dies as `Unknown tool`
      // BEFORE the policy gate — i.e. the gate under test never runs.
      // Explicit true/false always wins, so this also pins the fixture
      // against any future default flip.
      chat_exposed: true,
      metadata: {
        name: 'Some Recipe',
        description: 'Tier 2 registry MCP admit fixture.',
        author: 'recued-core',
        supported_platforms: ['test'],
        tags: ['test', 'tier2'],
      },
      steps: [ingredientStep('read_http', manifest.slug)],
    });
    const { deps } = makeRegistryMcpHarness(recipe, [manifest]);

    const res = await withJsonFetch({ body: 'tier2-admit' }, () =>
      _testing.handleToolCall(
        { name: 'recued-core/some-recipe', arguments: {} },
        deps,
      ),
    );

    expect((res as { isError?: boolean }).isError).toBeUndefined();
    const parsed = parseMcpText(res);
    expect(parsed.success).toBe(true);
    expect(parsed.steps.map((step) => step.id)).toEqual(['read_http']);
    expect(errorsContainCode(parsed.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });

  it('denies Tier 2 dispatch when inbound-token filtering removes the recipe ingredient slug from the snapshot', async () => {
    const manifest = buildHttpManifest('registry-tier2-forbidden-http');
    const recipe = buildRecipe({
      recipe_id: 'some-denied-recipe',
      // Catalog opt-in — see the admit case above. Load-bearing for the
      // DENY assertion too: without it the call fails as `Unknown tool`,
      // which looks like a denial but is catalog absence, not the policy
      // gate. The fixture must REACH the gate for `tool_not_in_contract`
      // to mean anything.
      chat_exposed: true,
      metadata: {
        name: 'Some Denied Recipe',
        description: 'Tier 2 registry MCP deny fixture.',
        author: 'recued-core',
        supported_platforms: ['test'],
        tags: ['test', 'tier2'],
      },
      steps: [ingredientStep('blocked_http', manifest.slug)],
    });
    const toolName = 'recued-core/some-denied-recipe';
    const { deps } = makeRegistryMcpHarness(recipe, [manifest], {
      inboundTokenAuthorize: (name: string) => name === toolName,
    });

    const res = await _testing.handleToolCall(
      { name: toolName, arguments: {} },
      deps,
    );

    expect((res as { isError?: boolean }).isError).toBeUndefined();
    const parsed = parseMcpText(res);
    expect(parsed.success).toBe(false);
    const error = firstRecipeError(parsed.errors);
    expect(error.code).toBe('RECIPE_POLICY_DENIED');
    const details = error.details as { denials?: PolicyGateDenial[] };
    expect(details.denials?.[0]?.ingredient).toBe(manifest.slug);
    expect(details.denials?.[0]?.decision.code).toBe('tool_not_in_contract');
  });
});

describe('D-153 P2.C registry internal_function_call regression', () => {
  it('does not synthesize mcp contract fields for internal chat dispatch and executes normally', async () => {
    const manifest = buildHttpManifest('registry-internal-safe-http');
    const recipe = buildRecipe({
      recipe_id: 'registry-internal-chat',
      steps: [ingredientStep('read_http', manifest.slug)],
    });
    const { registry, capturedRequests } = makeRegistryMcpHarness(recipe, [manifest]);

    const result = await withJsonFetch({ body: 'internal-chat' }, () =>
      registry.dispatch(
        'recipe.run',
        { recipe_id: recipe.recipe_id },
        {
          channel: 'internal_function_call',
          session_id: 'sess-1',
          turn_id: 'turn-1',
        },
      ),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const response = result.result as ExecuteResponse;
      expect(response.success).toBe(true);
      expect(response.steps.map((step) => step.id)).toEqual(['read_http']);
      expect(errorsContainCode(response.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    }
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.trigger_source).toBe('chat');
    expect(capturedRequests[0]?.execution_source).toBeUndefined();
    expect(capturedRequests[0]?.contract_snapshot).toBeUndefined();
  });
});

describe('D-153 P2.C handleExecute — user policy gate wiring', () => {
  it('does not return RECIPE_POLICY_DENIED for an admissible user storage-read recipe', async () => {
    const recipe = buildRecipe({
      recipe_id: 'user-storage-admit',
      steps: [ingredientStep('read_storage', 'safe-storage')],
    });
    const deps = makeDeps(recipe, [
      buildManifest('safe-storage', 'storage', 'read'),
    ]);

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'extension_ws',
      execution_source: userSource,
    });

    expect(result.steps.map((step) => step.id)).toEqual(['read_storage']);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });

  it('admits destructive risk_tier ingredients for user_self rpc requests', async () => {
    const recipe = buildRecipe({
      recipe_id: 'user-destructive-admit',
      steps: [ingredientStep('destroy_storage', 'danger-storage')],
    });
    const deps = makeDeps(recipe, [
      buildManifest('danger-storage', 'storage', 'destructive'),
    ]);

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'extension_ws',
      execution_source: userSource,
    });

    expect(result.steps.map((step) => step.id)).toEqual(['destroy_storage']);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });

  it('fails closed with RECIPE_POLICY_DENIED when a user recipe references a missing manifest', async () => {
    const recipe = buildRecipe({
      recipe_id: 'user-missing-manifest-deny',
      steps: [ingredientStep('missing', 'not-registered-user')],
    });
    const deps = makeDeps(recipe, []);

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'extension_ws',
      execution_source: userSource,
    });

    expect(result.success).toBe(false);
    expect(result.steps).toEqual([]);
    const error = firstRecipeError(result.errors);
    expect(error.code).toBe('RECIPE_POLICY_DENIED');
    const details = error.details as { denials?: PolicyGateDenial[] };
    expect(details.denials).toHaveLength(1);
    expect(details.denials?.[0]?.ingredient).toBe('not-registered-user');
    expect(details.denials?.[0]?.decision.code).toBe('kind_not_allowed');
  });

  it('emits lifecycle events and writes failed audit when user-channel policy denies', async () => {
    const recipe = buildRecipe({
      recipe_id: 'user-audit-deny',
      steps: [ingredientStep('missing', 'not-registered-audit')],
    });
    const auditLog = mkAuditLog();
    const eventBus = createEventBus();
    const deps = makeDeps(recipe, [], { auditLog, eventBus });

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'extension_ws',
      execution_source: userSource,
    });

    expect(result.success).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.duration_ms).toBe(0);
    expect(result.output.sidebar).toEqual([]);

    const error = firstRecipeError(result.errors);
    expect(error.code).toBe('RECIPE_POLICY_DENIED');
    expect(error.severity).toBe('fatal');
    const details = error.details as { denials?: PolicyGateDenial[] };
    expect(details.denials).toHaveLength(1);
    expect(details.denials?.[0]?.step_id).toBe('missing');
    expect(details.denials?.[0]?.decision.code).toBe('kind_not_allowed');

    const entries = await auditLog.listRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recipe_id).toBe(recipe.recipe_id);
    expect(entries[0]?.commit_status).toBe('failed');
    expect(entries[0]?.duration_ms).toBe(0);
    expect(entries[0]?.errors[0]?.code).toBe('RECIPE_POLICY_DENIED');

    const executionEvents = eventBus
      .replay(0)
      .filter((event) => event.kind === 'execution')
      .map((event) => event.op);
    expect(executionEvents).toEqual(['start', 'error']);
  });
});

describe('D-153 P2.C rpc execute handler — user execution_source wiring', () => {
  it('threads client user_id and client_token_id into the ExecuteRequest execution_source', () => {
    const req = executeHandlerTesting.buildRpcExecuteRequest(
      { recipe_id: 'rpc-source' },
      buildWsClient({
        instance_id: null,
        user_id: 'user-1',
        client_token_id: 'tok-1',
      }),
    );

    expect(req.execution_source).toEqual({
      channel: 'user',
      actor: 'user_self',
      user_id: 'user-1',
      client_token_id: 'tok-1',
    });
  });

  it("falls back to 'local' when the rpc client has no user_id", () => {
    const req = executeHandlerTesting.buildRpcExecuteRequest(
      { recipe_id: 'rpc-local-user' },
      buildWsClient({
        user_id: undefined,
        client_token_id: 'tok-local',
      }),
    );

    expect(req.execution_source).toEqual({
      channel: 'user',
      actor: 'user_self',
      user_id: 'local',
      client_token_id: 'tok-local',
    });
  });

  it("falls back to 'unregistered' when the rpc client has no token or instance id", () => {
    const req = executeHandlerTesting.buildRpcExecuteRequest(
      { recipe_id: 'rpc-unregistered-client' },
      buildWsClient({
        instance_id: null,
        user_id: 'user-1',
        client_token_id: undefined,
      }),
    );

    expect(req.execution_source).toEqual({
      channel: 'user',
      actor: 'user_self',
      user_id: 'user-1',
      client_token_id: 'unregistered',
    });
  });

  it('falls back to instance_id when client_token_id is absent but instance_id is present', () => {
    const req = executeHandlerTesting.buildRpcExecuteRequest(
      { recipe_id: 'rpc-instance-fallback' },
      buildWsClient({
        instance_id: 'inst-fallback',
        user_id: 'user-1',
        client_token_id: undefined,
      }),
    );

    expect(req.execution_source).toEqual({
      channel: 'user',
      actor: 'user_self',
      user_id: 'user-1',
      client_token_id: 'inst-fallback',
    });
  });

  it('prefers client_token_id over instance_id when both identifiers are present', () => {
    const req = executeHandlerTesting.buildRpcExecuteRequest(
      { recipe_id: 'rpc-priority' },
      buildWsClient({
        instance_id: 'inst-loses',
        user_id: 'user-wins',
        client_token_id: 'tok-wins',
      }),
    );

    expect(req.execution_source).toEqual({
      channel: 'user',
      actor: 'user_self',
      user_id: 'user-wins',
      client_token_id: 'tok-wins',
    });
  });

  it("threads the rpc args' trigger_source and recipe_id onto the request", () => {
    const req = executeHandlerTesting.buildRpcExecuteRequest(
      { recipe_id: 'rpc-args-passthrough', trigger_source: 'kitchen-ui' },
      buildWsClient(),
    );

    expect(req.recipe_id).toBe('rpc-args-passthrough');
    expect(req.trigger_source).toBe('kitchen-ui');
  });

  it("defaults trigger_source to 'extension_ws' when omitted from the rpc args", () => {
    const req = executeHandlerTesting.buildRpcExecuteRequest(
      { recipe_id: 'rpc-default-trigger' },
      buildWsClient(),
    );

    expect(req.trigger_source).toBe('extension_ws');
  });
});

describe('D-153 P2.C registry chat channel — internal_function_call with execution_source', () => {
  it('passes chat execution_source through to ExecuteRequest without synthesizing contract_snapshot', async () => {
    const manifest = buildHttpManifest('registry-chat-safe-http');
    const recipe = buildRecipe({
      recipe_id: 'registry-chat-policy-gated',
      steps: [ingredientStep('read_http', manifest.slug)],
    });
    const { registry, capturedRequests } = makeRegistryMcpHarness(recipe, [manifest]);

    const result = await withJsonFetch({ body: 'registry-chat' }, () =>
      registry.dispatch(
        'recipe.run',
        { recipe_id: recipe.recipe_id },
        {
          channel: 'internal_function_call',
          session_id: 'sess-1',
          turn_id: 'turn-1',
          execution_source: chatSource,
        },
      ),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const response = result.result as ExecuteResponse;
      expect(response.success).toBe(true);
      expect(response.steps.map((step) => step.id)).toEqual(['read_http']);
      expect(errorsContainCode(response.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    }
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.trigger_source).toBe('chat');
    expect(capturedRequests[0]?.execution_source).toBe(chatSource);
    expect(capturedRequests[0]?.contract_snapshot).toBeUndefined();
  });
});
