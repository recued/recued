import { beforeEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ExecutionContext, ExecutionResult } from '@recued/engine';
import {
  executionSourceContractId,
  type ContractSnapshot,
  type ExecutionSource,
  type RecipeDefinition,
  type RecipeStep,
} from '@recued/contracts';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { InFlightRegistry } from '../execution/in-flight-registry.js';
import { LaneSemaphore } from '../execution/lane-semaphore.js';
import { withChatToolCallContext } from '../chat-tool-call-context.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatToolCallStore } from '../storage/chat-tool-call-store.js';
import { createChatRunSettledSink } from '../chat-run-settled-sink.js';

/** D-166 Slice 4d.3 — the engine `ExecutionContext` gained an `actor`
 *  carrier field, threaded by `handleExecute` from
 *  `ExecuteRequest.execution_source.actor`. There is no consumer of
 *  `ctx.actor` yet (the `contract.override` resolver that reads it is
 *  wired in 4d.4), so the only observable behaviour of this slice is the
 *  thread itself: the actor the host supplies on `execution_source` must
 *  land on the `ctx` handed to the engine, and absence must surface as
 *  `undefined` — NOT a default actor. An absent actor matches no
 *  `contract.override` row, so the connection-keyed profile floor stands
 *  unchanged.
 *
 *  We observe the thread by mocking the `@recued/engine` boundary:
 *  `executeRecipe(ctx)` is replaced with a spy that captures `ctx` and
 *  returns a synthetic success. Everything else in `@recued/engine` is
 *  preserved via `importOriginal` (same pattern as the sibling
 *  `d-157-server-wiring-execute-handler.test.ts`).
 *
 *  D-209 now policy-gates `webhook`, `reception`, and `schedule`. This
 *  harness therefore supplies a matching snapshot whenever the source is
 *  contract-bearing; the recipe itself stays transform-only, so the gate
 *  has no ingredient call to deny. The `capturedActorFor` helper throws if
 *  dispatch was never reached, so a future gate change that swallows these
 *  channels fails loudly instead of making the `undefined` assertion pass
 *  vacuously. */

const executeRecipeMock = vi.hoisted(() => vi.fn());

vi.mock('@recued/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/engine')>();
  return {
    ...actual,
    executeRecipe: executeRecipeMock,
  };
});

// Imported AFTER the hoisted `vi.mock` so `execute-handler` binds the
// mocked `executeRecipe`.
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const RECIPE_ID = 'd-166-4d3-actor-thread';

// Transform-only recipe — no ingredient step, so no manifest lookup and
// nothing for the policy gate to deny even on a gated channel.
const buildRecipe = (): RecipeDefinition =>
  ({
    recipe_id: RECIPE_ID,
    version: 1,
    ttl: 60,
    metadata: {
      name: RECIPE_ID,
      description: 'Transform-only fixture for the D-166 4d.3 actor-thread test.',
      author: 'test',
      supported_platforms: ['test'],
      tags: ['test'],
    },
    variables: {},
    prefetch_steps: [],
    steps: [
      { id: 'noop', transform: 'concat', values: ['a', 'b'] } as unknown as RecipeStep,
    ],
    output: { sidebar: [] },
  }) as RecipeDefinition;

const makeDeps = (): ExecuteHandlerDeps => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(buildRecipe());
  return {
    recipeStore,
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    instanceId: 'actor-thread-test',
  };
};

const successResult = (): ExecutionResult => ({
  recipe_id: RECIPE_ID,
  recipe_hash: 'hash-actor',
  success: true,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 0,
  validation_issues: [],
});

const contractSnapshotFor = (
  source: ExecutionSource,
): ContractSnapshot | undefined => {
  const contract_id = executionSourceContractId(source);
  if (contract_id === undefined) return undefined;
  return {
    contract_id,
    contract_version: 'v1',
    allowed_tools: [],
    approval_required: [],
    scope_restrictions: [],
    resolved_at: 1_000,
  };
};

/** Run `handleExecute` with the given source and return whatever `actor`
 *  the host threaded onto the engine ctx. Throws if `executeRecipe` was
 *  never reached (e.g. a future policy-gate denial), so the `undefined`
 *  assertion can never pass vacuously. */
const capturedActorFor = async (
  execution_source?: ExecutionSource,
): Promise<unknown> => {
  let captured: ExecutionContext | undefined;
  executeRecipeMock.mockImplementationOnce(async (ctx: ExecutionContext) => {
    captured = ctx;
    return successResult();
  });
  const contract_snapshot = execution_source === undefined
    ? undefined
    : contractSnapshotFor(execution_source);
  await handleExecute(makeDeps(), {
    recipe_id: RECIPE_ID,
    ...(execution_source ? { execution_source } : {}),
    // The actor-thread test is a producer harness. Satisfy the canonical
    // contract-source invariant so it reaches the engine boundary it observes.
    ...(contract_snapshot === undefined ? {} : { contract_snapshot }),
  });
  if (!captured) {
    throw new Error(
      'executeRecipe was not reached — handleExecute returned before dispatch '
        + '(unexpected policy-gate denial for a non-gated channel?)',
    );
  }
  return captured.actor;
};

beforeEach(() => {
  executeRecipeMock.mockReset();
});

describe('D-166 4d.3 — handleExecute threads execution_source.actor onto ctx', () => {
  it('threads an anonymous actor (webhook channel — D-209 #1 W3 door source) onto ctx.actor', async () => {
    const actor = await capturedActorFor({
      channel: 'webhook',
      actor: 'anonymous',
      vendor: 'test-vendor',
      webhook_secret_id: 'ws-1',
    });
    expect(actor).toBe('anonymous');
  });

  it('threads a system actor (schedule channel) onto ctx.actor', async () => {
    const actor = await capturedActorFor({
      channel: 'schedule',
      actor: 'system',
      cron: '0 9 * * *',
      source_recipe: 'daily-briefing',
    });
    expect(actor).toBe('system');
  });

  it('threads an anonymous actor (reception channel) onto ctx.actor', async () => {
    const actor = await capturedActorFor({
      channel: 'reception',
      actor: 'anonymous',
      reception_id: 'rcp-1',
    });
    expect(actor).toBe('anonymous');
  });

  it('threads a contracted_user actor (reception channel) onto ctx.actor', async () => {
    const actor = await capturedActorFor({
      channel: 'reception',
      actor: 'contracted_user',
      reception_id: 'rcp-1',
      contract_id: 'ctr-1',
    });
    expect(actor).toBe('contracted_user');
  });

  it('leaves ctx.actor undefined when the request carries no execution_source', async () => {
    const actor = await capturedActorFor(undefined);
    // Must be undefined — NOT coerced to a default actor. An absent actor
    // matches no `contract.override` row (4d.4), so the floor is untouched.
    expect(actor).toBeUndefined();
  });

  it('reports engine phase liveness to the D-259 in-flight context', async () => {
    const inFlightRegistry = new InFlightRegistry(new LaneSemaphore());
    const reportProgress = vi.spyOn(inFlightRegistry, 'reportProgress');
    let capturedRunId: string | undefined;
    executeRecipeMock.mockImplementationOnce(async (ctx: ExecutionContext) => {
      capturedRunId = ctx.run_id;
      ctx.onProgress?.({
        type: 'sequential_step_started',
        step_id: 'noop',
        index: 0,
        total: 1,
      });
      return successResult();
    });

    const bind = vi.fn();
    const durableProgress = vi.fn(() => true);
    await withChatToolCallContext({ bind, progress: durableProgress }, () => handleExecute({ ...makeDeps(), inFlightRegistry }, {
      recipe_id: RECIPE_ID,
      execution_source: {
        channel: 'user',
        actor: 'user_self',
        user_id: 'u1',
        client_token_id: 'client1',
      },
    }));

    expect(capturedRunId).toEqual(expect.any(String));
    expect(reportProgress).toHaveBeenCalledWith(capturedRunId, 'provider-event');
    expect(bind).toHaveBeenCalledExactlyOnceWith(capturedRunId, RECIPE_ID);
    expect(durableProgress).toHaveBeenCalledWith(capturedRunId, expect.any(Number), false);
  });

  it('tracks an authorized resume without the originating chat async context', async () => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const store = createChatStore(db);
      store.createSession({ id: 'resumed-chat' });
      const source = { channel: 'chat' as const, actor: 'user_self' as const,
        user_id: 'owner', chat_session_id: 'resumed-chat', turn_id: 'original-turn' };
      const signature = { server_kind: 'recued' as const, instance_id: 'test', version: '1' };
      const old = createChatToolCallStore(db, store.appendMessage, 'old-process');
      await old.start({ id: 'original-call', session_id: 'resumed-chat', turn_id: 'original-turn',
        role: 'tool', tool_name: 'recipe.run', content: 'original ask',
        target_server: 'self', picker_at_send: { display_name: 'self', signature },
        model_used: { provider: 'recued', model_id: 'tool-call' }, execution_source: source });
      old.bind('original-call', 'resumed-run');
      old.hold('original-call');
      executeRecipeMock.mockImplementationOnce(async (ctx: ExecutionContext) => {
        expect(ctx.run_id).toBe('resumed-run');
        expect(store.toolCalls!.get('original-call')?.state).toBe('running');
        ctx.onProgress?.({ type: 'sequential_step_started', step_id: 'noop', index: 0, total: 1 });
        expect(store.toolCalls!.get('original-call')?.last_signal_at).toEqual(expect.any(Number));
        const afterRestart = createChatToolCallStore(db, store.appendMessage, 'next-process');
        expect(afterRestart.get('original-call')?.state).toBe('interrupted');
        return successResult();
      });
      const response = await handleExecute({ ...makeDeps(), db,
        inFlightRegistry: new InFlightRegistry(new LaneSemaphore()) },
      { recipe_id: RECIPE_ID, execution_source: source },
      { run_id: 'resumed-run', resume_from: { gated_step_id: 'noop', step_state: {} } });
      expect(executeRecipeMock).toHaveBeenCalledTimes(1);
      expect(store.toolCalls!.get('original-call')?.state).toBe('interrupted');
      await createChatRunSettledSink(store, signature, { emit: vi.fn() })({
        execution_source: source, run_id: 'resumed-run', tool_name: 'recipe.run',
        result: response, ts: Date.now(),
      });
      expect(store.toolCalls!.get('original-call')?.state).toBe('succeeded');
    } finally { db.close(); }
  });
});
