/** D-153 P1 — commit-substrate engine-wiring (D-145 engine-wiring).
 *
 *  D-153 P1 + P1.B shipped the storage substrate (the `AuditEntry`
 *  commit fields, the `json_extract` session-ID indexes) but the
 *  engine never populated the fields — every audit row left them
 *  undefined. This suite covers the write-path wiring: `handleExecute`
 *  derives the three-tier session IDs from a typed `ExecutionSource`
 *  and stamps `channel_session_id` + `correlation_id`
 *  (+ `contract_snapshot`) onto every audit/commit row — the success
 *  path and the policy-gate-denial path alike.
 *
 *  The pure derivation primitives are covered by the gateway's
 *  `commit-identity` unit suite.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { deriveChannelSessionId } from '@recued/gateway';
import type {
  ContractSnapshot,
  Dish,
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';

import {
  _testing as executeHandlerTesting,
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import Database from 'better-sqlite3';
import { createDishStore } from '../dish-store.js';

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

// ────────────────────────────────────────────────────────────────
// Fixtures — mirror the d-153-phase-2c harness shape
// ────────────────────────────────────────────────────────────────

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

const userSource: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'local',
  client_token_id: 'tok-test',
};

const mcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'stdio_local',
  tool_call_id: 'mcp-test-abc',
  mcp_token_id: 'tok1',
  contract_id: 'tok1',
};

const buildManifest = (
  slug: string,
  kind: IngredientManifest['kind'],
  risk_tier: IngredientManifest['risk_tier'],
): IngredientManifest =>
  ({
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

const buildContractSnapshot = (
  allowed_tools: readonly string[] = [],
  overrides: Partial<ContractSnapshot> = {},
): ContractSnapshot => ({
  contract_id: 'tok1',
  contract_version: '1',
  allowed_tools,
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_700_000_000_000,
  ...overrides,
});

const buildRecipe = (
  overrides: Partial<RecipeDefinition> = {},
): RecipeDefinition =>
  ({
    recipe_id: 'd-153-engine-wiring-test',
    version: 1,
    ttl: 60,
    metadata: {
      name: 'D-153 engine-wiring test',
      description: 'Minimal recipe fixture for D-153 P1 engine-wiring coverage.',
      author: 'test',
      supported_platforms: ['test'],
      tags: ['test', 'commit', 'substrate'],
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
): RecipeDefinition['steps'][number] =>
  ({ id, ingredient, input: {} }) as RecipeDefinition['steps'][number];

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

// The `read_storage` ingredient step fails at execution (the test
// harness wires no storage adapter) but the recipe-runner still
// writes one audit/commit row either way — which is exactly the row
// the commit-substrate fields land on. Assertions target the
// session-ID fields, not the step outcome.
const storageRecipe = (recipe_id: string): RecipeDefinition =>
  buildRecipe({ recipe_id, steps: [ingredientStep('read_storage', 'safe-storage')] });

const safeStorageManifest = (): IngredientManifest =>
  buildManifest('safe-storage', 'storage', 'read');

// ────────────────────────────────────────────────────────────────

const installConfigEchoRecipe = (recipe_id: string): RecipeDefinition =>
  buildRecipe({
    recipe_id,
    variables: {
      threshold: 10,
      topic: 'recipe-default',
    },
    steps: [
      {
        id: 'echo_threshold',
        transform: 'coalesce',
        values: ['{{config.threshold}}', 0],
      },
      {
        id: 'echo_topic',
        transform: 'coalesce',
        values: ['{{config.topic}}', 'missing'],
      },
    ] as unknown as RecipeDefinition['steps'],
    output: {
      sidebar: [
        { type: 'summary', label: 'threshold', source: 'step.echo_threshold' },
        { type: 'summary', label: 'topic', source: 'step.echo_topic' },
      ],
    },
  });

const makeDish = (
  recipe_id: string,
  overrides: Pick<Dish, 'dish_id' | 'is_default' | 'config_overlay'>,
): Dish => ({
  recipe_id,
  publisher_id: 'local',
  name: overrides.is_default ? '' : 'named',
  enabled: true,
  created_at: 1,
  ...overrides,
});

const sidebarData = (
  result: Awaited<ReturnType<typeof handleExecute>>,
  label: string,
): unknown => result.output.sidebar.find((section) => section.label === label)?.data;

const runInstallConfigEcho = async (
  recipe_id: string,
  options: {
    defaultOverlay: Record<string, unknown>;
    requestConfig?: Record<string, unknown>;
    dishId?: string;
    namedDishOverlay?: Record<string, unknown>;
    internal?: Parameters<typeof handleExecute>[2];
  },
): Promise<{ threshold: unknown; topic: unknown }> => {
  const recipe = installConfigEchoRecipe(recipe_id);
  const db = new Database(':memory:');
  try {
    const dishStore = createDishStore(db);
    dishStore.set(makeDish(recipe_id, {
      dish_id: 'dsh_default',
      is_default: true,
      config_overlay: options.defaultOverlay,
    }));
    if (options.namedDishOverlay !== undefined) {
      dishStore.set(makeDish(recipe_id, {
        dish_id: 'dsh_named',
        is_default: false,
        config_overlay: options.namedDishOverlay,
      }));
    }

    const request: Parameters<typeof handleExecute>[1] = {
      recipe_id,
      execution_source: userSource,
      ...(options.requestConfig !== undefined ? { config: options.requestConfig } : {}),
      ...(options.dishId !== undefined ? { dish_id: options.dishId } : {}),
    };
    const deps = makeDeps(recipe, [], { dishStore });
    const result = options.internal === undefined
      ? await handleExecute(deps, request)
      : await handleExecute(deps, request, options.internal);

    expect(result.success).toBe(true);
    // ExecuteResponse.steps intentionally omits StepLog.result; output.sidebar
    // observes the pure transform's resolved value without needing an adapter.
    return {
      threshold: sidebarData(result, 'threshold'),
      topic: sidebarData(result, 'topic'),
    };
  } finally {
    db.close();
  }
};

// ────────────────────────────────────────────────────────────────

describe('D-153 P1 engine-wiring — commit-substrate session IDs', () => {
  beforeEach(() => {
    // The correlation tracker is process-lived; reset it so intent-burst
    // grouping doesn't bleed across tests.
    executeHandlerTesting.correlationTracker.reset();
  });

  it('stamps channel_session_id + correlation_id on a successful run', async () => {
    const recipe = storageRecipe('p1-success');
    const auditLog = mkAuditLog();
    const deps = makeDeps(recipe, [safeStorageManifest()], { auditLog });

    await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'schedule',
      execution_source: scheduleSource,
    });

    const [entry] = await auditLog.listRecent(10);
    expect(entry?.channel_session_id).toBe('schedule:daily-briefing');
    expect(entry?.channel_session_id).toBe(deriveChannelSessionId(scheduleSource));
    expect(entry?.correlation_id).toMatch(/^corr-/);
    // Cognition is pluggable + DEFAULT DISABLED — no cognition window
    // opens for a recipe run, so the field stays undefined.
    expect(entry?.cognition_session_id).toBeUndefined();
  });

  it('omits the commit-substrate fields when the request carries no execution_source', async () => {
    const recipe = storageRecipe('p1-legacy');
    const auditLog = mkAuditLog();
    const deps = makeDeps(recipe, [safeStorageManifest()], { auditLog });

    await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
    });

    const [entry] = await auditLog.listRecent(10);
    expect(entry).toBeDefined();
    expect(entry?.channel_session_id).toBeUndefined();
    expect(entry?.correlation_id).toBeUndefined();
    expect(entry?.contract_snapshot).toBeUndefined();
  });

  it('stamps the commit-substrate fields on a policy-gate-denied run', async () => {
    // A denied dispatch is a confirmed `failed` commit — it carries the
    // same session IDs as a normal run so the channel-session
    // tier-query surfaces the denial too.
    const recipe = buildRecipe({
      recipe_id: 'p1-denied',
      steps: [ingredientStep('destroy', 'danger-storage')],
    });
    const auditLog = mkAuditLog();
    const deps = makeDeps(
      recipe,
      [buildManifest('danger-storage', 'storage', 'destructive')],
      { auditLog },
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'schedule',
      execution_source: scheduleSource,
    });

    expect(result.success).toBe(false);
    const [entry] = await auditLog.listRecent(10);
    expect(entry?.commit_status).toBe('failed');
    expect(entry?.channel_session_id).toBe('schedule:daily-briefing');
    expect(entry?.correlation_id).toMatch(/^corr-/);
  });

  it('threads contract_snapshot onto the audit row for a contract-scoped run', async () => {
    const recipe = storageRecipe('p1-mcp-snapshot');
    const auditLog = mkAuditLog();
    const deps = makeDeps(recipe, [safeStorageManifest()], { auditLog });
    const snapshot = buildContractSnapshot(['safe-storage']);

    await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: snapshot,
    });

    const [entry] = await auditLog.listRecent(10);
    expect(entry?.channel_session_id).toBe('mcp:tok1');
    expect(entry?.contract_snapshot).toEqual(snapshot);
  });

  it('groups dispatches in one channel session under a shared correlation_id', async () => {
    const recipe = storageRecipe('p1-burst');
    const auditLog = mkAuditLog();
    const deps = makeDeps(recipe, [safeStorageManifest()], { auditLog });

    // Two dispatches from the same client, milliseconds apart — well
    // inside the ~1-min intent-burst window.
    await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'extension_ws',
      execution_source: userSource,
    });
    await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'extension_ws',
      execution_source: userSource,
    });

    const entries = await auditLog.listRecent(10);
    expect(entries).toHaveLength(2);
    const correlations = new Set(entries.map((e) => e.correlation_id));
    expect(correlations.size).toBe(1);

    // The dormant P1.B tier-query indexes now resolve against
    // engine-written rows: both runs scope to one channel session...
    const channelSession = deriveChannelSessionId(userSource);
    const byChannel = await auditLog.listByChannelSession(channelSession);
    expect(byChannel).toHaveLength(2);
    // ...and one correlation burst (the unit save-as-Recipe operates on).
    const [correlation] = [...correlations];
    const byCorrelation = await auditLog.listByCorrelation(correlation as string);
    expect(byCorrelation).toHaveLength(2);
  });

  it('assigns distinct correlation ids + channel sessions to different channels', async () => {
    // `schedule` and `reactive` share the same `source_recipe`
    // (`daily-briefing`) — the channel-name prefix keeps their
    // channel sessions, and therefore their correlation bursts, apart.
    const recipe = storageRecipe('p1-distinct');
    const auditLog = mkAuditLog();
    const deps = makeDeps(recipe, [safeStorageManifest()], { auditLog });

    await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'schedule',
      execution_source: scheduleSource,
    });
    await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'auto_run',
      execution_source: reactiveSource,
    });

    const entries = await auditLog.listRecent(10);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.channel_session_id))).toEqual(
      new Set(['schedule:daily-briefing', 'reactive:daily-briefing']),
    );
    expect(new Set(entries.map((e) => e.correlation_id)).size).toBe(2);
  });
});

describe('D-145 engine-wiring slice 2 — execution_source persistence', () => {
  beforeEach(() => {
    executeHandlerTesting.correlationTracker.reset();
  });

  it('stamps execution_source on a success-path audit row', async () => {
    const recipe = buildRecipe({ recipe_id: 'slice2-execution-source-success' });
    const auditLog = mkAuditLog();
    const deps = makeDeps(recipe, [], { auditLog });

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'schedule',
      execution_source: scheduleSource,
    });

    expect(result.success).toBe(true);
    const [entry] = await auditLog.listRecent(10);
    if (!entry) throw new Error('missing audit entry');
    expect(entry.execution_source).toEqual(scheduleSource);
    expect(hasOwn(entry, 'execution_source')).toBe(true);
  });

  it('stamps execution_source on a policy-gate-denial audit row', async () => {
    const recipe = buildRecipe({
      recipe_id: 'slice2-execution-source-denied',
      steps: [ingredientStep('destroy', 'danger-storage')],
    });
    const auditLog = mkAuditLog();
    const deps = makeDeps(
      recipe,
      [buildManifest('danger-storage', 'storage', 'destructive')],
      { auditLog },
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'schedule',
      execution_source: scheduleSource,
    });

    expect(result.success).toBe(false);
    const [entry] = await auditLog.listRecent(10);
    if (!entry) throw new Error('missing audit entry');
    expect(entry.commit_status).toBe('failed');
    expect(entry.execution_source).toEqual(scheduleSource);
    expect(hasOwn(entry, 'execution_source')).toBe(true);
  });

  it('omits execution_source on a success-path audit row when the request has none', async () => {
    const recipe = buildRecipe({ recipe_id: 'slice2-execution-source-legacy' });
    const auditLog = mkAuditLog();
    const deps = makeDeps(recipe, [], { auditLog });

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
    });

    expect(result.success).toBe(true);
    const [entry] = await auditLog.listRecent(10);
    if (!entry) throw new Error('missing audit entry');
    expect(entry.execution_source).toBeUndefined();
    expect(hasOwn(entry, 'execution_source')).toBe(false);
  });
});

describe('D-179 — install config: the default dish is a source, not a dispatch identity', () => {
  it('D-319 — a run AS the main dish takes its settings (it is a dish like any other)', async () => {
    await expect(runInstallConfigEcho('rc-main-dish', {
      defaultOverlay: { threshold: 30, topic: 'x' },
      dishId: 'dsh_default',
    })).resolves.toEqual({ threshold: 30, topic: 'x' });
  });

  it('D-319 — a run as a dish may change a value for that run alone', async () => {
    await expect(runInstallConfigEcho('rc-dish-run-override', {
      defaultOverlay: {},
      namedDishOverlay: { threshold: 77, topic: 'dish' },
      dishId: 'dsh_named',
      requestConfig: { threshold: 99 },
    })).resolves.toEqual({ threshold: 99, topic: 'dish' });
  });

  it('D-319 — the switch governs what runs on its own: by hand as a dish switched off runs, a schedule of it is refused', async () => {
    const recipe = installConfigEchoRecipe('rc-dish-off');
    const db = new Database(':memory:');
    try {
      const dishStore = createDishStore(db);
      dishStore.set({ ...makeDish('rc-dish-off', { dish_id: 'dsh_off', is_default: true, config_overlay: { threshold: 5 } }), enabled: false });
      const deps = makeDeps(recipe, [], { dishStore });
      const byHand = await handleExecute(deps, { recipe_id: 'rc-dish-off', dish_id: 'dsh_off', execution_source: userSource });
      expect(byHand.success).toBe(true);
      expect(sidebarData(byHand, 'threshold')).toBe(5);
      await expect(handleExecute(deps, {
        recipe_id: 'rc-dish-off', dish_id: 'dsh_off', trigger_source: 'schedule', execution_source: userSource,
      })).rejects.toMatchObject({ code: 'dish_disabled' });
    } finally {
      db.close();
    }
  });

  it('applies a non-empty default overlay to a dishless fresh run with no request config', async () => {
    await expect(runInstallConfigEcho('rc-install-base', {
      defaultOverlay: { threshold: 30 },
    })).resolves.toEqual({
      threshold: 30,
      topic: 'recipe-default',
    });
  });

  it('lets per-run config override the install overlay on a dishless fresh run', async () => {
    await expect(runInstallConfigEcho('rc-install-request-override', {
      defaultOverlay: { threshold: 30 },
      requestConfig: { threshold: 99 },
    })).resolves.toEqual({
      threshold: 99,
      topic: 'recipe-default',
    });
  });

  it('keeps install-only keys while per-run config overrides a shared key', async () => {
    await expect(runInstallConfigEcho('rc-install-partial-override', {
      defaultOverlay: { threshold: 30, topic: 'x' },
      requestConfig: { threshold: 99 },
    })).resolves.toEqual({
      threshold: 99,
      topic: 'x',
    });
  });

  it('treats an empty default overlay as a no-op', async () => {
    await expect(runInstallConfigEcho('rc-install-empty-overlay', {
      defaultOverlay: {},
    })).resolves.toEqual({
      threshold: 10,
      topic: 'recipe-default',
    });
  });

  it('does not apply the main dish’s settings when another dish is bound', async () => {
    await expect(runInstallConfigEcho('rc-install-explicit-non-default', {
      defaultOverlay: { threshold: 30, topic: 'x' },
      namedDishOverlay: { threshold: 77 },
      dishId: 'dsh_named',
    })).resolves.toEqual({
      threshold: 77,
      topic: 'recipe-default',
    });
  });

  it('does not apply install config on resume re-entry', async () => {
    await expect(runInstallConfigEcho('rc-install-resume', {
      defaultOverlay: { threshold: 30, topic: 'x' },
      internal: { run_id: 'run-resume-install-skip' },
    })).resolves.toEqual({
      threshold: 10,
      topic: 'recipe-default',
    });
  });
});
