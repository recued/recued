/** D-157 Part C - held-action idempotency execute-handler guard. */

import type {
  Checkpoint,
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';
import type { ExecutionContext, ExecutionResult } from '@recued/engine';
import { deriveChannelSessionId } from '@recued/gateway';
import { hashRecipe } from '@recued/recipes';
import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
  type CommitStore,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeRecipeMock = vi.hoisted(() => vi.fn());

vi.mock('@recued/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/engine')>();
  return {
    ...actual,
    executeRecipe: executeRecipeMock,
  };
});

import {
  _testing as executeHandlerTesting,
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';
import {
  awaitInflightHold,
  buildHeldConfigSnapshot,
  computeHeldActionKey,
} from '../held-action-idempotency.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import type { ExecuteResponse } from '../types.js';

const TOOL_SLUG = 'held-idempotency-storage-read';
const STEP_ID = 'gated_step';
const FIXED_NOW = 1_750_100_000_000;

const chatSource: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-held-session',
  user_id: 'user-1',
};

const reactiveSource: ExecutionSource = {
  channel: 'reactive',
  actor: 'system',
  event_kind: 'mail.created',
  source_recipe: 'inbox-reactive-recipe',
};

const MATCHING_CONFIG = {
  mode: 'request-override',
  nested: { two: 2, one: 1 },
};

const DIFFERENT_CONFIG = {
  mode: 'different-intent',
  nested: { two: 2, one: 1 },
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = async (turns = 5): Promise<void> => {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
};

const buildManifest = (
  overrides: Partial<IngredientManifest> = {},
): IngredientManifest =>
  ({
    slug: TOOL_SLUG,
    name: 'Held Idempotency Storage Read',
    description: 'Read-risk fixture for D-157 held idempotency guard tests.',
    author: 'test',
    kind: 'storage',
    category: 'data',
    risk_tier: 'read',
    version: 1,
    input: {},
    output: { ok: 'ok' },
    ...overrides,
  }) as IngredientManifest;

const buildRecipe = (
  recipe_id = 'd-157-held-idempotency',
  overrides: Partial<RecipeDefinition> = {},
): RecipeDefinition =>
  ({
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id,
      description: 'Minimal recipe fixture for held idempotency guard tests.',
      author: 'test',
      supported_platforms: ['test'],
      tags: ['test', 'd-157'],
    },
    variables: {
      mode: 'recipe-default',
      recipe_only: 'kept',
    },
    prefetch_steps: [],
    steps: [
      {
        id: STEP_ID,
        ingredient: TOOL_SLUG,
        input: { key: '{{config.mode}}' },
      } as unknown as RecipeStep,
    ],
    output: { sidebar: [] },
    ...overrides,
  }) as RecipeDefinition;

const pausedResult = (recipe_id: string): ExecutionResult => ({
  recipe_id,
  recipe_hash: `engine-${recipe_id}`,
  success: false,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 7,
  validation_issues: [],
  awaiting_approval: {
    gated_step_id: STEP_ID,
    step_state: { prepared: true },
    tool_slug: TOOL_SLUG,
    risk_tier: 'read',
    reason: 'read fixture paused for approval',
  },
});

const commitStore = (): CommitStore & {
  writePending: ReturnType<typeof vi.fn>;
  recordOutcome: ReturnType<typeof vi.fn>;
} => ({
  writePending: vi.fn().mockResolvedValue(undefined),
  recordOutcome: vi.fn().mockResolvedValue(undefined),
}) as unknown as CommitStore & {
  writePending: ReturnType<typeof vi.fn>;
  recordOutcome: ReturnType<typeof vi.fn>;
};

const checkpointStore = (): CheckpointStore & {
  written: Map<string, Checkpoint>;
  write: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  listByRun: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  size: ReturnType<typeof vi.fn>;
} => {
  const written = new Map<string, Checkpoint>();
  const store = {
    written,
    write: vi.fn(async (checkpoint: Checkpoint) => {
      written.set(checkpoint.checkpoint_id, checkpoint);
    }),
    get: vi.fn(async (checkpoint_id: string) => written.get(checkpoint_id) ?? null),
    delete: vi.fn(async (checkpoint_id: string) => {
      written.delete(checkpoint_id);
    }),
    listByRun: vi.fn(async (run_id: string) =>
      [...written.values()].filter((checkpoint) => checkpoint.run_id === run_id),
    ),
    list: vi.fn(async () => [...written.values()]),
    size: vi.fn(async () => written.size),
  };
  return store as unknown as CheckpointStore & typeof store;
};

const auditLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const makeDeps = (
  recipe: RecipeDefinition,
  overrides: Partial<ExecuteHandlerDeps> = {},
): ExecuteHandlerDeps => {
  const registry: ManifestRegistry = createManifestRegistry('/nonexistent');
  registry.register(buildManifest());
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  return {
    recipeStore,
    executorConfig: { manifests: registry },
    baseVault: {},
    instanceId: 'server-test-1',
    commitStore: commitStore(),
    ...overrides,
  };
};

const buildCheckpoint = (
  recipe: RecipeDefinition,
  overrides: Partial<Checkpoint> = {},
): Checkpoint => ({
  checkpoint_id: 'checkpoint-seeded-live',
  run_id: 'run-seeded-live',
  recipe_id: recipe.recipe_id,
  gated_step_id: STEP_ID,
  step_state: {},
  created_at: FIXED_NOW,
  ...overrides,
});

const effectiveConfigSnapshot = (
  recipe: RecipeDefinition,
  config: Record<string, unknown>,
): Record<string, unknown> => ({
  ...(recipe.variables ?? {}),
  ...config,
});

const heldActionKeyFor = (
  recipe: RecipeDefinition,
  config: Record<string, unknown> = MATCHING_CONFIG,
  source: ExecutionSource = chatSource,
): string => {
  const key = computeHeldActionKey({
    channel_session_id: deriveChannelSessionId(source),
    recipe_id: recipe.recipe_id,
    recipe_hash: hashRecipe(recipe),
    config_snapshot: buildHeldConfigSnapshot(
      recipe.variables as Record<string, unknown> | undefined,
      config,
    ),
  });
  // Test fixtures are JSON-clean by construction — a null key here is a
  // broken fixture, not a scenario under test (D-177 N.7 degradation has
  // its own unit coverage in held-action-idempotency.test.ts).
  if (key === null) throw new Error('heldActionKeyFor: fixture identity not canonicalizable');
  return key;
};

const seedLiveHeldTwin = async (args: {
  log: AuditLogStore;
  checkpoints: ReturnType<typeof checkpointStore>;
  recipe: RecipeDefinition;
  source: ExecutionSource;
  config?: Record<string, unknown>;
  config_snapshot?: Record<string, unknown>;
  run_id?: string;
  checkpoint_id?: string;
  now?: number;
}): Promise<AuditEntry> => {
  const {
    log,
    checkpoints,
    recipe,
    source,
    config = MATCHING_CONFIG,
    config_snapshot,
    run_id = 'run-seeded-live',
    checkpoint_id = 'checkpoint-seeded-live',
    now = FIXED_NOW,
  } = args;

  await checkpoints.write(buildCheckpoint(recipe, { checkpoint_id, run_id }));
  const entry = buildAuditEntry({
    recipe_id: recipe.recipe_id,
    recipe_hash: hashRecipe(recipe),
    commit_status: 'awaiting_approval',
    duration_ms: 0,
    errors: [],
    config_snapshot: config_snapshot ?? effectiveConfigSnapshot(recipe, config),
    channel_session_id: deriveChannelSessionId(source),
    execution_source: source,
    checkpoint_id,
    run_id,
    now,
  });
  await log.append(entry);
  checkpoints.write.mockClear();
  return entry;
};

const awaitingAnchors = async (
  log: AuditLogStore,
  source: ExecutionSource,
  recipe: RecipeDefinition,
): Promise<AuditEntry[]> =>
  (await log.listByChannelSession(deriveChannelSessionId(source), 20))
    .filter((entry) =>
      entry.recipe_id === recipe.recipe_id
      && entry.commit_status === 'awaiting_approval'
    );

const expectRanNewHeldExecution = async (args: {
  response: ExecuteResponse;
  log: AuditLogStore;
  checkpoints: ReturnType<typeof checkpointStore>;
  recipe: RecipeDefinition;
  source: ExecutionSource;
  expectedAwaitingAnchors: number;
}): Promise<void> => {
  const { response, log, checkpoints, recipe, source, expectedAwaitingAnchors } = args;

  expect(executeRecipeMock).toHaveBeenCalledTimes(1);
  expect(response.awaiting_approval).toBe(true);
  expect(response.recipe_id).toBe(recipe.recipe_id);
  expect(response.recipe_hash).toBe(`engine-${recipe.recipe_id}`);
  expect(response.recipe_hash).not.toBe(hashRecipe(recipe));
  expect(response.success).toBe(false);
  expect(checkpoints.written.size).toBe(2);
  expect(checkpoints.write).toHaveBeenCalledTimes(1);
  expect(await awaitingAnchors(log, source, recipe)).toHaveLength(
    expectedAwaitingAnchors,
  );
};

beforeEach(() => {
  executeRecipeMock.mockReset();
  executeHandlerTesting.correlationTracker.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleExecute D-157 held-action idempotency guard', () => {
  it('collapses an identical chat resend onto the seeded live held twin', async () => {
    const recipe = buildRecipe('held-idempotency-chat-collapse');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const seeded = await seedLiveHeldTwin({
      log,
      checkpoints,
      recipe,
      source: chatSource,
    });

    const response = await handleExecute(
      makeDeps(recipe, { auditLog: log, checkpointStore: checkpoints }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'chat',
        execution_source: chatSource,
        config: MATCHING_CONFIG,
      },
    );

    expect(executeRecipeMock).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      recipe_id: seeded.recipe_id,
      recipe_hash: seeded.recipe_hash,
      success: false,
      steps: [],
      errors: [],
      awaiting_approval: true,
    });
    expect(response.output.render).toEqual([]);
    expect(response.output.sidebar).toEqual([]);
    expect(checkpoints.written.size).toBe(1);
    expect(checkpoints.write).not.toHaveBeenCalled();
    expect(await log.size()).toBe(1);
    expect(await awaitingAnchors(log, chatSource, recipe)).toHaveLength(1);
  });

  it('collapses an identical chat resend when the recipe uses schema-form variable defaults', async () => {
    const config = MATCHING_CONFIG;
    const recipe = buildRecipe('held-idempotency-schema-default-collapse', {
      variables: {
        subject: {
          label: 'Subject',
          type: 'string',
          default: 'Canary subject',
        },
        body: {
          label: 'Body',
          type: 'string',
          default: 'Canary body',
        },
        mode: 'recipe-default',
      } as unknown as RecipeDefinition['variables'],
    });
    const log = auditLog();
    const checkpoints = checkpointStore();
    const seeded = await seedLiveHeldTwin({
      log,
      checkpoints,
      recipe,
      source: chatSource,
      config,
      config_snapshot: buildHeldConfigSnapshot(
        recipe.variables as Record<string, unknown>,
        config,
      ),
    });

    const response = await handleExecute(
      makeDeps(recipe, { auditLog: log, checkpointStore: checkpoints }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'chat',
        execution_source: chatSource,
        config,
      },
    );

    expect(executeRecipeMock).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      recipe_id: seeded.recipe_id,
      recipe_hash: seeded.recipe_hash,
      success: false,
      steps: [],
      errors: [],
      awaiting_approval: true,
    });
    expect(response.output.sidebar).toEqual([]);
    expect(checkpoints.written.size).toBe(1);
    expect(checkpoints.write).not.toHaveBeenCalled();
    expect(await log.size()).toBe(1);
    expect(await awaitingAnchors(log, chatSource, recipe)).toHaveLength(1);
  });

  it('does not collapse a reactive reception-workflow shaped dispatch', async () => {
    const recipe = buildRecipe('held-idempotency-reactive-no-collapse');
    const log = auditLog();
    const checkpoints = checkpointStore();
    await seedLiveHeldTwin({
      log,
      checkpoints,
      recipe,
      source: reactiveSource,
    });
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id));

    const response = await handleExecute(
      makeDeps(recipe, { auditLog: log, checkpointStore: checkpoints }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'auto_run',
        execution_source: reactiveSource,
        config: MATCHING_CONFIG,
        context: { event: { payload: { id: 'evt-2' } } },
      },
      { run_id: 'run-reactive-second-fire' },
    );

    await expectRanNewHeldExecution({
      response,
      log,
      checkpoints,
      recipe,
      source: reactiveSource,
      expectedAwaitingAnchors: 2,
    });
  });

  it('does not collapse a resume re-entry onto its own awaiting anchor', async () => {
    const recipe = buildRecipe('held-idempotency-resume-no-collapse');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const seeded = await seedLiveHeldTwin({
      log,
      checkpoints,
      recipe,
      source: chatSource,
      run_id: 'run-resume-anchor',
      checkpoint_id: 'checkpoint-resume-anchor',
    });
    executeRecipeMock.mockImplementationOnce(async (ctx: ExecutionContext) => {
      expect(ctx.resumeFrom).toEqual({ gated_step_id: STEP_ID });
      return pausedResult(recipe.recipe_id);
    });

    const response = await handleExecute(
      makeDeps(recipe, { auditLog: log, checkpointStore: checkpoints }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'chat',
        execution_source: chatSource,
        config: MATCHING_CONFIG,
      },
      {
        run_id: seeded.run_id,
        resume_from: {
          gated_step_id: STEP_ID,
          step_state: { prepared: true },
        },
      },
    );

    await expectRanNewHeldExecution({
      response,
      log,
      checkpoints,
      recipe,
      source: chatSource,
      expectedAwaitingAnchors: 1,
    });
    const [anchor] = await awaitingAnchors(log, chatSource, recipe);
    expect(anchor?.run_id).toBe(seeded.run_id);
    expect(anchor?.checkpoint_id).not.toBe(seeded.checkpoint_id);
  });

  it('does not collapse when request.context is present on a chat dispatch', async () => {
    const recipe = buildRecipe('held-idempotency-context-no-collapse');
    const log = auditLog();
    const checkpoints = checkpointStore();
    await seedLiveHeldTwin({
      log,
      checkpoints,
      recipe,
      source: chatSource,
    });
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id));

    const response = await handleExecute(
      makeDeps(recipe, { auditLog: log, checkpointStore: checkpoints }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'chat',
        execution_source: chatSource,
        config: MATCHING_CONFIG,
        context: { event: { payload: { id: 'ctx-1' } } },
      },
    );

    await expectRanNewHeldExecution({
      response,
      log,
      checkpoints,
      recipe,
      source: chatSource,
      expectedAwaitingAnchors: 2,
    });
  });

  it('does not collapse when request.vault is present on a chat dispatch', async () => {
    const recipe = buildRecipe('held-idempotency-vault-no-collapse');
    const log = auditLog();
    const checkpoints = checkpointStore();
    await seedLiveHeldTwin({
      log,
      checkpoints,
      recipe,
      source: chatSource,
    });
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id));

    const response = await handleExecute(
      makeDeps(recipe, { auditLog: log, checkpointStore: checkpoints }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'chat',
        execution_source: chatSource,
        config: MATCHING_CONFIG,
        vault: { api_key: 'present' },
      },
    );

    await expectRanNewHeldExecution({
      response,
      log,
      checkpoints,
      recipe,
      source: chatSource,
      expectedAwaitingAnchors: 2,
    });
  });

  it('does not collapse a chat dispatch with a different config snapshot', async () => {
    const recipe = buildRecipe('held-idempotency-config-no-collapse');
    const log = auditLog();
    const checkpoints = checkpointStore();
    await seedLiveHeldTwin({
      log,
      checkpoints,
      recipe,
      source: chatSource,
      config: MATCHING_CONFIG,
    });
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id));

    const response = await handleExecute(
      makeDeps(recipe, { auditLog: log, checkpointStore: checkpoints }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'chat',
        execution_source: chatSource,
        config: DIFFERENT_CONFIG,
      },
    );

    await expectRanNewHeldExecution({
      response,
      log,
      checkpoints,
      recipe,
      source: chatSource,
      expectedAwaitingAnchors: 2,
    });
  });

  it('collapses a concurrent identical chat send onto the in-flight leader', async () => {
    const recipe = buildRecipe('held-idempotency-concurrent-collapse');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const deps = makeDeps(recipe, { auditLog: log, checkpointStore: checkpoints });
    const heldActionKey = heldActionKeyFor(recipe);
    const firstWriteStarted = deferred<Checkpoint>();
    const firstWriteRelease = deferred<void>();
    const secondExecutionAtGate = deferred<void>();
    let engineCalls = 0;

    checkpoints.write.mockImplementationOnce(async (checkpoint: Checkpoint) => {
      firstWriteStarted.resolve(checkpoint);
      await firstWriteRelease.promise;
      checkpoints.written.set(checkpoint.checkpoint_id, checkpoint);
    });
    executeRecipeMock.mockImplementation(async () => {
      engineCalls += 1;
      if (engineCalls === 2) secondExecutionAtGate.resolve(undefined);
      return pausedResult(recipe.recipe_id);
    });

    const request = () => ({
      recipe_id: recipe.recipe_id,
      trigger_source: 'chat' as const,
      execution_source: chatSource,
      config: MATCHING_CONFIG,
    });

    const leaderCall = handleExecute(deps, request());
    await firstWriteStarted.promise;

    let followerSettled = false;
    const followerCall = handleExecute(deps, request()).finally(() => {
      followerSettled = true;
    });
    await secondExecutionAtGate.promise;
    await flushMicrotasks();
    expect(followerSettled).toBe(false);

    firstWriteRelease.resolve(undefined);
    const [leaderResponse, followerResponse] = await Promise.all([
      leaderCall,
      followerCall,
    ]);

    expect(executeRecipeMock).toHaveBeenCalledTimes(2);
    expect(checkpoints.written.size).toBe(1);
    expect(checkpoints.write).toHaveBeenCalledTimes(1);
    expect(await awaitingAnchors(log, chatSource, recipe)).toHaveLength(1);
    expect(leaderResponse.awaiting_approval).toBe(true);
    expect(followerResponse.awaiting_approval).toBe(true);
    expect(awaitInflightHold(heldActionKey)).toBeNull();
  });

  it('a follower does not collapse onto a leader whose hold-creation failed (no false queued)', async () => {
    const recipe = buildRecipe('held-idempotency-concurrent-failed-leader');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const deps = makeDeps(recipe, { auditLog: log, checkpointStore: checkpoints });
    const heldActionKey = heldActionKeyFor(recipe);
    const firstWriteStarted = deferred<Checkpoint>();
    const firstWriteFailure = deferred<void>();
    const secondExecutionAtGate = deferred<void>();
    let engineCalls = 0;

    checkpoints.write.mockImplementationOnce(async (checkpoint: Checkpoint) => {
      firstWriteStarted.resolve(checkpoint);
      await firstWriteFailure.promise;
    });
    executeRecipeMock.mockImplementation(async () => {
      engineCalls += 1;
      if (engineCalls === 2) secondExecutionAtGate.resolve(undefined);
      return pausedResult(recipe.recipe_id);
    });

    const request = () => ({
      recipe_id: recipe.recipe_id,
      trigger_source: 'chat' as const,
      execution_source: chatSource,
      config: MATCHING_CONFIG,
    });

    const leaderCall = handleExecute(deps, request());
    await firstWriteStarted.promise;

    let followerSettled = false;
    const followerCall = handleExecute(deps, request()).finally(() => {
      followerSettled = true;
    });
    await secondExecutionAtGate.promise;
    await flushMicrotasks();
    expect(followerSettled).toBe(false);

    firstWriteFailure.reject(new Error('checkpoint write failed'));
    const [leaderResponse, followerResponse] = await Promise.all([
      leaderCall,
      followerCall,
    ]);

    const channelEntries = await log.listByChannelSession(
      deriveChannelSessionId(chatSource),
      20,
    );
    const awaiting = await awaitingAnchors(log, chatSource, recipe);
    const [writtenCheckpoint] = [...checkpoints.written.values()];

    expect(executeRecipeMock).toHaveBeenCalledTimes(2);
    expect(checkpoints.write).toHaveBeenCalledTimes(2);
    expect(checkpoints.written.size).toBe(1);
    expect(leaderResponse.awaiting_approval).toBeUndefined();
    expect(followerResponse.awaiting_approval).toBe(true);
    expect(
      channelEntries.filter((entry) => entry.commit_status === 'failed'),
    ).toHaveLength(1);
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]?.checkpoint_id).toBe(writtenCheckpoint?.checkpoint_id);
    expect(awaitInflightHold(heldActionKey)).toBeNull();
  });
});
