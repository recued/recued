/** R2 step 6 - preflight resumer inline snapshot/provenance guards. */

import type {
  Checkpoint,
  ExecutionSource,
  RecipeDefinition,
} from '@recued/contracts';
import type { PreflightAskContext } from '@recued/gateway';
import {
  COMPENSATION_RECIPE_ID_PREFIX,
  hashRecipe,
} from '@recued/recipes';
import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecuteHandlerDeps } from '../execute-handler.js';

const handleExecuteMock = vi.hoisted(() => vi.fn());

vi.mock('../execute-handler.js', () => ({
  handleExecute: handleExecuteMock,
}));

import { createPreflightResumer } from '../preflight-resumer.js';

const NOW = Date.parse('2026-06-01T10:00:00.000Z');
const STARTED_AT = NOW - 3_000;

const chatSource: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
};

const recipeSnapshot = (
  overrides: Partial<RecipeDefinition> = {},
): RecipeDefinition => ({
  recipe_id: 'inline-recipe-1',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Inline recipe',
    description: 'Inline recipe snapshot fixture',
    author: 'test',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  ...overrides,
});

const snapshotRecord = (recipe: RecipeDefinition): Record<string, unknown> =>
  recipe as unknown as Record<string, unknown>;

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
  tool_slug: 'hubspot-catalog',
  risk_tier: 'destructive',
  reason: 'destructive tier needs approval',
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
    config_snapshot: { target_connection: 'hubspot1' },
    trigger_url: null,
    trigger_source: 'manual',
    instance_id: 'server-1',
    process_id: 'process-1',
    run_id: 'run-1',
    now: NOW,
    execution_source: chatSource,
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
  },
  executorConfig: {
    manifests: { get: vi.fn(() => undefined) },
  },
  baseVault: {},
} as unknown as ExecuteHandlerDeps);

const expectResumeRefused = async (
  cp: Checkpoint,
  anchor: AuditEntry = pausedAnchor(),
  reason: 'checkpoint_integrity_failed' | 'checkpoint_provenance_failed' =
    'checkpoint_provenance_failed',
): Promise<void> => {
  const log = auditLog();
  const writtenAnchor = await append(log, anchor);
  let getExecuteDepsCount = 0;
  const getExecuteDeps = vi.fn(() => {
    getExecuteDepsCount += 1;
    return executeDeps();
  });
  const resumer = createPreflightResumer({
    auditLog: log,
    getExecuteDeps,
  });

  await resumer.resumeRun(cp, askContext());

  expect(getExecuteDepsCount).toBe(1);
  expect(getExecuteDeps).toHaveBeenCalledTimes(1);
  expect(handleExecuteMock).not.toHaveBeenCalled();
  const terminal = await log.get('run-1');
  expect(terminal).toMatchObject({
    run_id: writtenAnchor.run_id,
    recipe_id: writtenAnchor.recipe_id,
    recipe_hash: writtenAnchor.recipe_hash,
    commit_status: 'failed',
    errors: [{
      code: 'RECIPE_VALIDATION_FAILED',
      details: { reason },
    }],
  });
  expect(terminal?.started_at).toBe(writtenAnchor.started_at);
  expect(terminal?.checkpoint_id).toBeUndefined();
};

let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

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
  warnSpy?.mockRestore();
  warnSpy = undefined;
});

describe('PreflightResumer.resumeRun inline recipe_snapshot guards', () => {
  it('refuses a checkpoint whose recipe_snapshot hash mismatches the paused anchor recipe_hash', async () => {
    const snapshot = recipeSnapshot({ recipe_id: 'inline-recipe-1' });

    await expectResumeRefused(
      checkpoint({
        recipe_id: snapshot.recipe_id,
        recipe_snapshot: snapshotRecord(snapshot),
      }),
      pausedAnchor({ recipe_hash: 'different-hash' }),
      'checkpoint_integrity_failed',
    );
  });

  it('refuses predecessor_commit_id when the checkpoint has no recipe_snapshot', async () => {
    await expectResumeRefused(
      checkpoint({
        predecessor_commit_id: 'commit-create-1',
      }),
    );
  });

  it('refuses predecessor_commit_id when the snapshot recipe_id lacks the saga-undo prefix', async () => {
    const snapshot = recipeSnapshot({ recipe_id: 'ordinary-inline-recipe' });

    await expectResumeRefused(
      checkpoint({
        recipe_id: snapshot.recipe_id,
        recipe_snapshot: snapshotRecord(snapshot),
        predecessor_commit_id: 'commit-create-1',
      }),
      pausedAnchor({ recipe_hash: hashRecipe(snapshot) }),
    );
  });

  it('refuses predecessor_commit_id when it disagrees with the id embedded in saga-undo-<commit>', async () => {
    const snapshot = recipeSnapshot({
      recipe_id: `${COMPENSATION_RECIPE_ID_PREFIX}other-commit`,
    });
    let tickingNow = NOW;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      tickingNow += 1;
      return tickingNow;
    });

    try {
      await expectResumeRefused(
        checkpoint({
          recipe_id: snapshot.recipe_id,
          recipe_snapshot: snapshotRecord(snapshot),
          predecessor_commit_id: 'commit-create-1',
        }),
        pausedAnchor({ recipe_hash: hashRecipe(snapshot) }),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reaches handleExecute when predecessor_commit_id and recipe_snapshot hash both match', async () => {
    const snapshot = recipeSnapshot({
      recipe_id: `${COMPENSATION_RECIPE_ID_PREFIX}commit-create-1`,
    });
    const anchor = pausedAnchor({ recipe_hash: hashRecipe(snapshot) });
    const log = auditLog();
    await append(log, anchor);
    const deps = executeDeps();
    const getExecuteDeps = vi.fn(() => deps);
    handleExecuteMock.mockRejectedValueOnce(
      new Error('past snapshot/predecessor guard'),
    );
    const resumer = createPreflightResumer({
      auditLog: log,
      getExecuteDeps,
    });

    await expect(
      resumer.resumeRun(
        checkpoint({
          recipe_id: snapshot.recipe_id,
          recipe_snapshot: snapshotRecord(snapshot),
          predecessor_commit_id: 'commit-create-1',
        }),
        askContext(),
      ),
    ).rejects.toThrow('past snapshot/predecessor guard');

    expect(getExecuteDeps).toHaveBeenCalledTimes(1);
    expect(handleExecuteMock).toHaveBeenCalledTimes(1);
    const [calledDeps, request, internal] = handleExecuteMock.mock.calls[0]!;
    expect(calledDeps).toBe(deps);
    expect(request).toEqual({
      recipe: snapshot,
      config: anchor.config_snapshot,
      trigger_source: 'manual',
      instance_id: 'server-1',
      execution_source: chatSource,
      process_id: 'process-1',
    });
    expect(internal).toEqual({
      run_id: 'run-1',
      predecessor_commit_id: 'commit-create-1',
      resume_from: {
        gated_step_id: 'gated_step',
        step_state: { lookup: { id: 'deal-1' } },
      },
    });
  });

  it('resumes a PLAIN inline snapshot (no predecessor) with no predecessor stamp on internal', async () => {
    // The common inline case — an R2 transient dispatch, not a saga
    // compensation: matching hash → resume feeds the snapshot as the
    // inline recipe and threads NO compensation provenance.
    const snapshot = recipeSnapshot({ recipe_id: 'inline-recipe-1' });
    const anchor = pausedAnchor({ recipe_hash: hashRecipe(snapshot) });
    const log = auditLog();
    await append(log, anchor);
    const getExecuteDeps = vi.fn(() => executeDeps());
    handleExecuteMock.mockRejectedValueOnce(new Error('past snapshot guard'));
    const resumer = createPreflightResumer({ auditLog: log, getExecuteDeps });

    await expect(
      resumer.resumeRun(
        checkpoint({
          recipe_id: snapshot.recipe_id,
          recipe_snapshot: snapshotRecord(snapshot),
        }),
        askContext(),
      ),
    ).rejects.toThrow('past snapshot guard');

    expect(handleExecuteMock).toHaveBeenCalledTimes(1);
    const [, request, internal] = handleExecuteMock.mock.calls[0]!;
    expect((request as { recipe?: unknown }).recipe).toEqual(snapshot);
    expect(request).not.toHaveProperty('recipe_id');
    expect(internal).toEqual({
      run_id: 'run-1',
      resume_from: {
        gated_step_id: 'gated_step',
        step_state: { lookup: { id: 'deal-1' } },
      },
    });
  });
});
