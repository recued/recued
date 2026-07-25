/** D-157 P1 slice 4 - execute-handler preflight pause audit tests. */

import type {
  Checkpoint,
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';
import type { PreflightNotifier } from '@recued/gateway';
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

import {
  _testing as executeHandlerTesting,
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

const TOOL_SLUG = 'slice4-admin-tool';
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
    name: 'Slice 4 Held Tool',
    // D-187 slice 4 — `destructive` is an op-risk ALWAYS-ASK (the floor trust can't
    // relax), so this step holds for preflight approval regardless of the cell ceiling.
    // (The prior `admin` relied on the matrix's `(chat, user_self)` write-ceiling to ask;
    // under op-risk a contract-less chat dispatch has the owner `admin` ceiling, which
    // would admit an `admin` op — so the fixture uses `destructive` to exercise the ask.)
    description: 'Preflight always-ask (destructive) fixture for execute-handler tests.',
    author: 'test',
    kind: 'http',
    category: 'action',
    risk_tier: 'destructive',
    version: 1,
    input: {
      method: 'POST',
      url: 'https://example.test/preflight',
    },
    output: { ok: 'ok' },
    ...overrides,
  }) as IngredientManifest;

const buildRecipe = (
  recipe_id = 'd-157-p1-slice4-execute-handler',
): RecipeDefinition =>
  ({
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id,
      description: 'Minimal recipe fixture for D-157 slice 4 preflight tests.',
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
      },
    ],
    output: { sidebar: [] },
  }) as RecipeDefinition;

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

const failingCheckpointStore = (
  error: Error,
): ReturnType<typeof checkpointStore> => {
  const store = checkpointStore();
  store.write.mockRejectedValueOnce(error);
  return store;
};

const notifier = (
  askImpl: PreflightNotifier['ask'] = vi.fn().mockResolvedValue({
    ask_id: 'ask-test-1',
  }) as unknown as PreflightNotifier['ask'],
): PreflightNotifier & {
  ask: ReturnType<typeof vi.fn>;
  registerAskHandler: ReturnType<typeof vi.fn>;
} => ({
  ask: askImpl as unknown as ReturnType<typeof vi.fn>,
  registerAskHandler: vi.fn(),
}) as unknown as PreflightNotifier & {
  ask: ReturnType<typeof vi.fn>;
  registerAskHandler: ReturnType<typeof vi.fn>;
};

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

const executePreflightRecipe = (
  deps: ExecuteHandlerDeps,
  recipe: RecipeDefinition,
) => handleExecute(deps, {
  recipe_id: recipe.recipe_id,
  trigger_source: 'manual',
  execution_source: chatSource,
});

let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  executeHandlerTesting.correlationTracker.reset();
});

afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = undefined;
});

describe('handleExecute D-157 slice 4 audit anchor invariant', () => {
  it('records awaiting_approval with checkpoint_id when the checkpoint write succeeds', async () => {
    const recipe = buildRecipe('slice4-checkpoint-success');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const deps = makeDeps(recipe, { auditLog: log, checkpointStore: checkpoints });

    const result = await executePreflightRecipe(deps, recipe);
    const entry = await latestAuditEntry(log);
    const written = checkpoints.write.mock.calls[0]?.[0] as Checkpoint | undefined;

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(entry.commit_status).toBe('awaiting_approval');
    expect(entry.checkpoint_id).toEqual(expect.any(String));
    expect(entry.checkpoint_id).toBe(written?.checkpoint_id);
    expect(entry.ask_id).toBeUndefined();
    expect(written).toMatchObject({
      run_id: entry.run_id,
      recipe_id: recipe.recipe_id,
      gated_step_id: STEP_ID,
      step_state: {},
    });
  });

  it('persists the caller context on the awaiting anchor (targeting-guard fold)', async () => {
    // Design § 8 / codex HIGH fold — the resumer replays this snapshot so
    // a gated step resolving `{{context.entity_id}}` re-dispatches against
    // the approved values instead of undefined. Paused anchors only.
    const recipe = buildRecipe('slice4-context-snapshot');
    const log = auditLog();
    const deps = makeDeps(recipe, { auditLog: log, checkpointStore: checkpointStore() });

    await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
      execution_source: chatSource,
      context: { entity_id: 'deal-9' },
    });
    const entry = await latestAuditEntry(log);

    expect(entry.commit_status).toBe('awaiting_approval');
    expect(entry.context_snapshot).toMatchObject({ entity_id: 'deal-9' });
  });

  it('downgrades to failed with CHECKPOINT_WRITE_FAILED when checkpoint write throws', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recipe = buildRecipe('slice4-checkpoint-write-failed');
    const log = auditLog();
    const checkpoints = failingCheckpointStore(new Error('disk full'));
    const deps = makeDeps(recipe, { auditLog: log, checkpointStore: checkpoints });

    const result = await executePreflightRecipe(deps, recipe);
    const entry = await latestAuditEntry(log);

    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatchObject({ code: 'CHECKPOINT_WRITE_FAILED' });
    expect(entry.commit_status).toBe('failed');
    expect(entry.errors[0]).toMatchObject({ code: 'CHECKPOINT_WRITE_FAILED' });
    expect(entry.checkpoint_id).toBeUndefined();
    expect(entry.ask_id).toBeUndefined();
    expect(checkpoints.write).toHaveBeenCalledTimes(1);
  });

  it('downgrades to failed with CHECKPOINT_STORE_UNAVAILABLE when checkpointStore is absent', async () => {
    const recipe = buildRecipe('slice4-checkpoint-store-absent');
    const log = auditLog();
    const deps = makeDeps(recipe, { auditLog: log, checkpointStore: undefined });

    const result = await executePreflightRecipe(deps, recipe);
    const entry = await latestAuditEntry(log);

    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: 'CHECKPOINT_STORE_UNAVAILABLE',
    });
    expect(entry.commit_status).toBe('failed');
    expect(entry.errors[0]).toMatchObject({
      code: 'CHECKPOINT_STORE_UNAVAILABLE',
    });
    expect(entry.checkpoint_id).toBeUndefined();
    expect(entry.ask_id).toBeUndefined();
  });
});

describe('handleExecute D-157 slice 4 notifier paths', () => {
  it('raises gateway.preflight and records ask_id when notifier is wired', async () => {
    const recipe = buildRecipe('slice4-notifier-wired');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const notes = notifier();
    const deps = makeDeps(recipe, {
      auditLog: log,
      checkpointStore: checkpoints,
      preflightNotifier: notes,
    });

    const result = await executePreflightRecipe(deps, recipe);
    const entry = await latestAuditEntry(log);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(entry.commit_status).toBe('awaiting_approval');
    expect(entry.checkpoint_id).toEqual(expect.any(String));
    expect(entry.ask_id).toBe('ask-test-1');
    expect(notes.ask).toHaveBeenCalledTimes(1);
    expect(notes.ask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      {
        kind: 'gateway.preflight',
        payload: expect.objectContaining({
          checkpoint_id: entry.checkpoint_id,
          run_id: entry.run_id,
          recipe_id: recipe.recipe_id,
          gated_step_id: STEP_ID,
        }),
      },
    );
  });

  it('records checkpoint_id without ask_id when notifier is absent', async () => {
    const recipe = buildRecipe('slice4-notifier-absent');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const deps = makeDeps(recipe, {
      auditLog: log,
      checkpointStore: checkpoints,
      preflightNotifier: undefined,
    });

    const result = await executePreflightRecipe(deps, recipe);
    const entry = await latestAuditEntry(log);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(entry.commit_status).toBe('awaiting_approval');
    expect(entry.checkpoint_id).toEqual(expect.any(String));
    expect(entry.ask_id).toBeUndefined();
    expect(checkpoints.write).toHaveBeenCalledTimes(1);
  });

  it('keeps the checkpoint durable and omits ask_id when notifier.ask throws', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recipe = buildRecipe('slice4-notifier-throws');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const notes = notifier(vi.fn().mockRejectedValue(new Error('ask store down')));
    const deps = makeDeps(recipe, {
      auditLog: log,
      checkpointStore: checkpoints,
      preflightNotifier: notes,
    });

    const result = await executePreflightRecipe(deps, recipe);
    const entry = await latestAuditEntry(log);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(entry.commit_status).toBe('awaiting_approval');
    expect(entry.checkpoint_id).toEqual(expect.any(String));
    expect(entry.ask_id).toBeUndefined();
    expect(checkpoints.written.has(entry.checkpoint_id!)).toBe(true);
    expect(notes.ask).toHaveBeenCalledTimes(1);
  });
});

describe('handleExecute D-157 slice 4 per-call admission probe', () => {
  it('keeps the per-call probe in lockstep with the static walk ask verdict', async () => {
    const recipe = buildRecipe('slice4-static-and-runtime-ask');
    const log = auditLog();
    const checkpoints = checkpointStore();
    const commits = commitStore();
    const deps = makeDeps(recipe, {
      auditLog: log,
      checkpointStore: checkpoints,
      commitStore: commits,
    });

    const result = await executePreflightRecipe(deps, recipe);
    const entry = await latestAuditEntry(log);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(entry.commit_status).toBe('awaiting_approval');
    expect(entry.checkpoint_id).toEqual(expect.any(String));
    expect(commits.writePending).not.toHaveBeenCalled();
    expect(checkpoints.write).toHaveBeenCalledTimes(1);
  });
});
