/** D-157 server-wiring - execute-handler internal resume wiring. */

import { readFileSync } from 'node:fs';
import type {
  Checkpoint,
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';
import type { ExecutionContext, ExecutionResult } from '@recued/engine';
import type { PreflightNotifier } from '@recued/gateway';
import { NEVER_ASK_OPERATION_OPTION_ID } from '@recued/gateway';
import {
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
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import type { InFlightRegistry } from '../execution/in-flight-registry.js';

const TOOL_SLUG = 'server-wiring-admin-tool';
const STEP_ID = 'gated_step';

const chatSource: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
};

const buildManifest = (
  overrides: Partial<IngredientManifest> = {},
): IngredientManifest =>
  ({
    slug: TOOL_SLUG,
    name: 'Server Wiring Admin Tool',
    description: 'Admin-tier fixture for D-157 server-wiring tests.',
    author: 'test',
    kind: 'http',
    category: 'action',
    risk_tier: 'admin',
    version: 1,
    input: {
      method: 'POST',
      url: 'https://example.test/preflight',
    },
    output: { ok: 'ok' },
    ...overrides,
  }) as IngredientManifest;

const buildRecipe = (
  recipe_id = 'd-157-server-wiring-execute-handler',
  overrides: Partial<RecipeDefinition> = {},
): RecipeDefinition =>
  ({
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id,
      description: 'Minimal recipe fixture for D-157 server-wiring tests.',
      author: 'test',
      supported_platforms: ['test'],
      tags: ['test', 'preflight'],
    },
    variables: {},
    prefetch_steps: [],
    steps: [
      {
        id: STEP_ID,
        ingredient: TOOL_SLUG,
        input: { body: { message: 'requires approval' } },
      } as unknown as RecipeStep,
    ],
    output: { sidebar: [] },
    ...overrides,
  }) as RecipeDefinition;

const successResult = (recipe_id: string): ExecutionResult => ({
  recipe_id,
  recipe_hash: `hash-${recipe_id}`,
  success: true,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 12,
  validation_issues: [],
});

const pausedResult = (recipe_id: string): ExecutionResult => ({
  recipe_id,
  recipe_hash: `hash-${recipe_id}`,
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
    risk_tier: 'admin',
    reason: 'admin tier requires approval',
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

const notifier = (): PreflightNotifier & {
  ask: ReturnType<typeof vi.fn>;
  registerAskHandler: ReturnType<typeof vi.fn>;
} => ({
  ask: vi.fn().mockResolvedValue({ ask_id: 'ask-test-1' }),
  registerAskHandler: vi.fn(),
}) as unknown as PreflightNotifier & {
  ask: ReturnType<typeof vi.fn>;
  registerAskHandler: ReturnType<typeof vi.fn>;
};

const killedRegistry = (): InFlightRegistry => ({
  runningTwin: () => null,
  claimRunningTwin: () => ({ leader: true }),
  settleRunningTwin: () => {},
  registerRun: () => {},
  completeRun: () => {},
  takeTermination: () => 'killed',
  isActive: () => false,
  attachSubprocess: () => 'child-0',
  detachSubprocess: () => {},
  markStalled: () => {},
}) as unknown as InFlightRegistry;

const auditLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const latestAuditEntry = async (log: AuditLogStore): Promise<AuditEntry> => {
  const [entry] = await log.listRecent(10);
  if (!entry) throw new Error('missing audit entry');
  return entry;
};

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

beforeEach(() => {
  executeRecipeMock.mockReset();
  executeHandlerTesting.correlationTracker.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleExecute D-157 server-wiring internal overrides', () => {
  it('uses internal.run_id for the resulting audit row', async () => {
    const recipe = buildRecipe('server-wiring-run-id');
    const log = auditLog();
    executeRecipeMock.mockResolvedValueOnce(successResult(recipe.recipe_id));

    await handleExecute(
      makeDeps(recipe, { auditLog: log }),
      { recipe_id: recipe.recipe_id },
      { run_id: 'run-resumed-1' },
    );

    expect((await latestAuditEntry(log)).run_id).toBe('run-resumed-1');
  });

  it('seeds resume_from.step_state through assignOwnSafe and threads resumeFrom', async () => {
    const recipe = buildRecipe('server-wiring-resume-seed');
    const unsafeStepState = JSON.parse(
      '{"seeded":{"value":"from-checkpoint"},"allowed":"ok","__proto__":{"polluted":true},"constructor":{"bad":true},"prototype":{"bad":true}}',
    ) as Record<string, unknown>;
    let captured: ExecutionContext | undefined;
    executeRecipeMock.mockImplementationOnce(async (ctx: ExecutionContext) => {
      captured = ctx;
      return successResult(recipe.recipe_id);
    });

    await handleExecute(
      makeDeps(recipe),
      { recipe_id: recipe.recipe_id },
      {
        resume_from: {
          gated_step_id: STEP_ID,
          step_state: unsafeStepState,
        },
      },
    );

    expect(captured).toBeDefined();
    expect(captured!.resumeFrom).toEqual({ gated_step_id: STEP_ID });
    expect(captured!.stores.step).toMatchObject({
      seeded: { value: 'from-checkpoint' },
      allowed: 'ok',
    });
    expect(Object.prototype.hasOwnProperty.call(captured!.stores.step, '__proto__'))
      .toBe(false);
    expect(Object.prototype.hasOwnProperty.call(captured!.stores.step, 'constructor'))
      .toBe(false);
    expect(Object.prototype.hasOwnProperty.call(captured!.stores.step, 'prototype'))
      .toBe(false);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('keeps run_id and resume_from off ExecuteRequest', () => {
    const source = readFileSync(new URL('../types.ts', import.meta.url), 'utf8');
    const body = source.match(/export interface ExecuteRequest \{([\s\S]*?)\n\}/)?.[1];

    expect(body).toBeDefined();
    expect(body).not.toMatch(/\brun_id\b/);
    expect(body).not.toMatch(/\bresume_from\b/);
    expect(source).toMatch(/export interface InternalExecuteOverrides/);
  });
});

describe('handleExecute D-157 server-wiring audit and ask fields', () => {
  it('captures merged config_snapshot with request config overriding defaults', async () => {
    const recipe = buildRecipe('server-wiring-config-snapshot', {
      variables: {
        mode: 'default',
        untouched: 'recipe-default',
        // D-222 Slice A — `request_only` used to be supplied with no
        // declaration, which asserted the pre-D-222 behaviour: an undeclared
        // caller key merged into the snapshot. That is now
        // `undeclared_config_argument`. Declaring it keeps this test's actual
        // subject — request config OVERRIDING defaults, per its name — and the
        // expected snapshot below is unchanged.
        request_only: false,
      },
    });
    const log = auditLog();
    executeRecipeMock.mockResolvedValueOnce(successResult(recipe.recipe_id));

    await handleExecute(
      makeDeps(recipe, { auditLog: log }),
      {
        recipe_id: recipe.recipe_id,
        config: {
          mode: 'request-override',
          request_only: true,
        },
      },
    );

    expect((await latestAuditEntry(log)).config_snapshot).toEqual({
      mode: 'request-override',
      untouched: 'recipe-default',
      request_only: true,
    });
  });

  it('returns awaiting_approval true for a durably held preflight run', async () => {
    const recipe = buildRecipe('server-wiring-held-response');
    const log = auditLog();
    const checkpoints = checkpointStore();
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id));

    const response = await handleExecute(
      makeDeps(recipe, { auditLog: log, checkpointStore: checkpoints }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
        execution_source: chatSource,
      },
    );

    expect(response.success).toBe(false);
    expect(response.steps).toEqual([]);
    expect(response.errors).toEqual([]);
    expect(response.awaiting_approval).toBe(true);
    expect(checkpoints.write).toHaveBeenCalledTimes(1);
  });

  it('treats owner kill as terminal when the engine concurrently reports a pause', async () => {
    const recipe = buildRecipe('server-wiring-kill-wins-over-pause');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const notes = notifier();
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id));

    const response = await handleExecute(
      makeDeps(recipe, {
        auditLog: log,
        checkpointStore: checkpoints,
        preflightNotifier: notes,
        inFlightRegistry: killedRegistry(),
      }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
        execution_source: chatSource,
      },
    );

    expect(response.success).toBe(false);
    expect(response.run_terminated).toBe('killed');
    expect(response.awaiting_approval).toBeUndefined();
    expect(checkpoints.write).not.toHaveBeenCalled();
    expect(checkpoints.written.size).toBe(0);
    expect(notes.ask).not.toHaveBeenCalled();
    expect(await latestAuditEntry(log)).toMatchObject({
      recipe_id: recipe.recipe_id,
      commit_status: 'killed',
    });
  });

  it.each([
    ['checkpoint store is absent', 'absent', 'CHECKPOINT_STORE_UNAVAILABLE'],
    ['checkpoint write throws', 'throws', 'CHECKPOINT_WRITE_FAILED'],
  ] as const)(
    'downgrades a held preflight run to terminal failure when %s',
    async (_label, mode, expectedCode) => {
      const recipe = buildRecipe(`server-wiring-held-downgrade-${mode}`);
      const overrides: Partial<ExecuteHandlerDeps> = { auditLog: auditLog() };
      if (mode === 'throws') {
        const checkpoints = checkpointStore();
        checkpoints.write.mockRejectedValueOnce(new Error('disk full'));
        overrides.checkpointStore = checkpoints;
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      }
      executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id));

      const response = await handleExecute(
        makeDeps(recipe, overrides),
        {
          recipe_id: recipe.recipe_id,
          trigger_source: 'manual',
          execution_source: chatSource,
        },
      );

      expect(response.success).toBe(false);
      expect(response.steps).toEqual([]);
      expect(response.awaiting_approval).toBeUndefined();
      expect(response.errors).toHaveLength(1);
      expect((response.errors[0] as { code?: unknown }).code).toBe(expectedCode);
    },
  );

  it('fails closed and removes the checkpoint when the awaiting audit anchor cannot be written', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recipe = buildRecipe('server-wiring-awaiting-anchor-write-failed');
    const log = auditLog();
    vi.spyOn(log, 'append').mockRejectedValue(new Error('audit disk full'));
    const checkpoints = checkpointStore();
    const notes = notifier();
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id));

    const response = await handleExecute(
      makeDeps(recipe, {
        auditLog: log,
        checkpointStore: checkpoints,
        preflightNotifier: notes,
      }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
        execution_source: chatSource,
      },
    );

    expect(response.success).toBe(false);
    expect(response.awaiting_approval).toBeUndefined();
    expect(response.errors).toHaveLength(1);
    expect(response.errors[0]).toMatchObject({ code: 'CHECKPOINT_WRITE_FAILED' });
    expect(checkpoints.write).toHaveBeenCalledTimes(1);
    expect(checkpoints.delete).toHaveBeenCalledTimes(1);
    expect(checkpoints.written.size).toBe(0);
    expect(notes.ask).not.toHaveBeenCalled();
  });

  it('does not create a checkpoint or ask when no audit anchor store is wired', async () => {
    const recipe = buildRecipe('server-wiring-awaiting-anchor-store-absent');
    const checkpoints = checkpointStore();
    const notes = notifier();
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id));

    const response = await handleExecute(
      makeDeps(recipe, {
        checkpointStore: checkpoints,
        preflightNotifier: notes,
      }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
        execution_source: chatSource,
      },
    );

    expect(response.success).toBe(false);
    expect(response.awaiting_approval).toBeUndefined();
    expect(response.errors[0]).toMatchObject({ code: 'CHECKPOINT_WRITE_FAILED' });
    expect(checkpoints.write).not.toHaveBeenCalled();
    expect(checkpoints.written.size).toBe(0);
    expect(notes.ask).not.toHaveBeenCalled();
  });

  it('keeps the checkpoint-only anchor resumable when the ask_id rewrite fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recipe = buildRecipe('server-wiring-ask-pointer-write-failed');
    const log = auditLog();
    const append = log.append.bind(log);
    vi.spyOn(log, 'append')
      .mockImplementationOnce((entry) => append(entry))
      .mockRejectedValueOnce(new Error('audit rewrite failed'));
    const checkpoints = checkpointStore();
    const notes = notifier();
    const deps = makeDeps(recipe, {
      auditLog: log,
      checkpointStore: checkpoints,
      preflightNotifier: notes,
    });
    executeRecipeMock.mockResolvedValueOnce(pausedResult(recipe.recipe_id));

    const response = await handleExecute(
      deps,
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
        execution_source: chatSource,
      },
    );

    expect(response.awaiting_approval).toBe(true);
    expect(notes.ask).toHaveBeenCalledTimes(1);
    const anchor = await latestAuditEntry(log);
    expect(anchor).toMatchObject({
      recipe_id: recipe.recipe_id,
      commit_status: 'awaiting_approval',
      checkpoint_id: expect.any(String),
    });
    expect(anchor.ask_id).toBeUndefined();
    const checkpoint = await checkpoints.get(anchor.checkpoint_id!);
    expect(checkpoint).not.toBeNull();

    // The approval-time idempotency decision keys only on the durable anchor +
    // matching checkpoint. Prove the missing ask pointer does not turn a real
    // approval into the old silent no-op.
    executeRecipeMock.mockResolvedValueOnce(successResult(recipe.recipe_id));
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps: () => deps,
    });
    await resumer.resumeRun(checkpoint!, {
      recipe_id: recipe.recipe_id,
      gated_step_id: STEP_ID,
    });

    expect((await latestAuditEntry(log)).commit_status).toBe('succeeded');
  });

  it('forwards awaiting_approval fields into PreflightAskContext', async () => {
    const recipe = buildRecipe('server-wiring-preflight-context');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const notes = notifier();
    const offer = {
      kind: 'never_ask' as const,
      ingredient_id: TOOL_SLUG,
      operation_id: TOOL_SLUG,
      op_hash: 'a'.repeat(64),
      approval: 'never' as const,
    };
    const paused = pausedResult(recipe.recipe_id);
    executeRecipeMock.mockResolvedValueOnce({
      ...paused,
      awaiting_approval: {
        ...paused.awaiting_approval!,
        risk_tier: 'read',
        owner_override_offer: offer,
        approval_clamped_from: 'never',
        authorization_provenance: { pre_lift_approval: 'always' },
      },
    });

    await handleExecute(
      makeDeps(recipe, {
        auditLog: log,
        checkpointStore: checkpoints,
        preflightNotifier: notes,
      }),
      {
        recipe_id: recipe.recipe_id,
        trigger_source: 'manual',
        execution_source: chatSource,
      },
    );

    const entry = await latestAuditEntry(log);
    expect(entry.commit_status).toBe('awaiting_approval');
    expect(entry.ask_id).toBe('ask-test-1');
    expect(notes.ask).toHaveBeenCalledTimes(1);
    expect(notes.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(TOOL_SLUG),
      }),
      expect.any(Array),
      {
        kind: 'gateway.preflight',
        payload: expect.objectContaining({
          checkpoint_id: entry.checkpoint_id,
          run_id: entry.run_id,
          recipe_id: recipe.recipe_id,
          gated_step_id: STEP_ID,
          tool_slug: TOOL_SLUG,
          risk_tier: 'read',
          reason: 'admin tier requires approval',
          owner_override_offer: offer,
          authorization_provenance: { pre_lift_approval: 'always' },
        }),
      },
    );
    expect(notes.ask.mock.calls[0]![1].map((option: { id: string }) => option.id)).toContain(
      NEVER_ASK_OPERATION_OPTION_ID,
    );
    const stored = await checkpoints.get(entry.checkpoint_id!);
    expect(stored?.preflight_context).toMatchObject({
      tool_slug: TOOL_SLUG,
      risk_tier: 'read',
      owner_override_offer: offer,
      approval_clamped_from: 'never',
      authorization_provenance: { pre_lift_approval: 'always' },
    });
  });
});
