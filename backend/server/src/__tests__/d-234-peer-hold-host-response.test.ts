/** D-234 § 234.4 — WHAT THE HOST SAYS ABOUT A PEER HOLD, to its callers and to the bus.
 *
 *  ⛔⛔ THE HOLE: `isDurablyPaused` in `execute-handler.ts` read `awaiting_approval` ALONE.
 *  A peer hold is durable, checkpointed and resumable — the run anchor said `awaiting_peer`
 *  the whole time — but that one expression gates four things, and all four fired as though
 *  the run had FAILED:
 *
 *    1. `emitExecution({ op: 'error' })` — paired clients render "your recipe failed".
 *    2. `emitRunOutcome({ outcome: 'failed' })` — a run-outcome TRIGGER, so recipes
 *       watching for failure fire on a run that is merely waiting.
 *    3. the torn-saga detector runs over a run that has not finished.
 *    4. the response carries a bare `success: false` with EMPTY errors and no marker —
 *       indistinguishable, to every caller, from a silent failure.
 *
 *  🔑 WHY NOTHING CAUGHT IT. `d-234-peer-hold-anchor.test.ts` proves the anchor rule by
 *  MIRRORING the host's status expression rather than driving it — it says so in as many
 *  words. So the sweep `commits.ts` warned `awaiting_peer` would oblige (*"adding it obliges
 *  a sweep of every `awaiting_approval` consumer; that is the intended cost"*) reached the
 *  anchor and stopped one expression short, and the mirror could not see the difference.
 *  ⇒ This file DRIVES `handleExecute`, so the anchor, the bus and the response are read from
 *  the same real run.
 *
 *  ⚠ THE ENGINE IS MOCKED AND NOTHING ELSE IS. `core.peer.ask` is in
 *  `OUTBOUND_SEND_INGREDIENT_SLUGS`, so a real peer-ask step lifts to an OWNER APPROVAL
 *  first and pauses `awaiting_approval` — the `awaiting_peer` pause only appears on the
 *  RESUME after that approval. Standing up that whole dance would test the gate, not this.
 *  The engine's own production of `awaiting_peer` is covered by `d-234-peer-ask-pause`; what
 *  is under test here is the HOST's handling of the result it hands back. */
import type { Checkpoint, ExecutionSource, RecipeDefinition } from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
  type CommitStore,
} from '@recued/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

const RECIPE_ID = 'd-234-peer-hold-host-response';

/** The engine result this run returns. Mutable so each test names its own pause. */
let engineResult: Record<string, unknown>;

vi.mock('@recued/engine', async (orig) => {
  const actual = await orig<typeof import('@recued/engine')>();
  return { ...actual, executeRecipe: async () => engineResult };
});

const baseEngineResult = (over: Record<string, unknown>): Record<string, unknown> => ({
  recipe_id: RECIPE_ID,
  recipe_hash: 'h',
  success: false,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 1,
  validation_issues: [],
  ...over,
});

const PEER_PAUSE = {
  gated_step_id: 'verdict',
  step_state: {},
  exchange_ref: 'a'.repeat(64),
  spec: {
    connection: 'peer-bob',
    label: 'review:contract',
    question: 'Approve this request?',
    options: [{ id: 'approved', label: 'Approve' }],
    on_timeout: 'wait',
    via: 'direct',
  },
};

const chatSource: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-1',
  user_id: 'user-1',
};

const recipe = (): RecipeDefinition =>
  ({
    recipe_id: RECIPE_ID,
    version: 1,
    ttl: 60,
    metadata: {
      name: RECIPE_ID,
      description: 'Fixture for the host-side peer-hold response.',
      author: 'test',
      supported_platforms: ['test'],
      tags: ['test'],
    },
    variables: {},
    prefetch_steps: [],
    steps: [{ id: 'verdict', transform: 'template', template: 'x' }],
    output: { sidebar: [] },
  }) as unknown as RecipeDefinition;

const checkpointStore = (): CheckpointStore => {
  const written = new Map<string, Checkpoint>();
  return {
    write: vi.fn(async (cp: Checkpoint) => { written.set(cp.checkpoint_id, cp); }),
    get: vi.fn(async (id: string) => written.get(id) ?? null),
    delete: vi.fn(async (id: string) => { written.delete(id); }),
    listByRun: vi.fn(async (run_id: string) =>
      [...written.values()].filter((cp) => cp.run_id === run_id)),
    list: vi.fn(async () => [...written.values()]),
    size: vi.fn(async () => written.size),
  } as unknown as CheckpointStore;
};

interface Harness {
  readonly deps: ExecuteHandlerDeps;
  readonly auditLog: AuditLogStore;
  readonly emitted: Array<{ kind: string; op?: string }>;
  readonly dishSnapshotSet: ReturnType<typeof vi.fn>;
}

const DISH_ID = 'dish-1';

const harness = (): Harness => {
  const registry = createManifestRegistry('/nonexistent');
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe());
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );
  const emitted: Array<{ kind: string; op?: string }> = [];
  const dishSnapshotSet = vi.fn();
  return {
    auditLog,
    emitted,
    dishSnapshotSet,
    deps: {
      recipeStore,
      executorConfig: { manifests: registry },
      baseVault: {},
      instanceId: 'server-test-1',
      dishStore: {
        // ⚠ Empty on purpose: a `is_default` install dish here would overlay config onto
        // every dishless run in this file and make the two drives differ by more than the
        // dish binding under test.
        listByRecipe: () => [],
        get: (id: string) => (id === DISH_ID
          ? {
              dish_id: DISH_ID,
              recipe_id: RECIPE_ID,
              enabled: true,
              is_default: false,
              config_overlay: {},
            }
          : undefined),
      },
      dishContextStore: {
        get: () => null,
        set: dishSnapshotSet,
        clear: vi.fn(),
      },
      commitStore: {
        writePending: vi.fn().mockResolvedValue(undefined),
        recordOutcome: vi.fn().mockResolvedValue(undefined),
      } as unknown as CommitStore,
      auditLog,
      checkpointStore: checkpointStore(),
      eventBus: {
        emit: (e: { kind: string; op?: string }) => { emitted.push(e); },
      },
    } as unknown as ExecuteHandlerDeps,
  };
};

const drive = (h: Harness) => handleExecute(h.deps, {
  recipe_id: RECIPE_ID,
  trigger_source: 'manual',
  execution_source: chatSource,
});

/** A DISH-bound drive — `context.recipe.*` continuity only exists for one. */
const driveDish = (h: Harness) => handleExecute(h.deps, {
  recipe_id: RECIPE_ID,
  dish_id: DISH_ID,
  trigger_source: 'manual',
  execution_source: chatSource,
} as Parameters<typeof handleExecute>[1]);

/** The lifecycle op a paired client would render. `error` is the one that says
 *  "your recipe failed" — the claim a held run must never make. */
const executionOps = (h: Harness): string[] =>
  h.emitted.filter((e) => e.kind === 'execution').map((e) => e.op ?? '');

const anchor = async (h: Harness): Promise<AuditEntry> => {
  const [entry] = await h.auditLog.listRecent(10);
  if (!entry) throw new Error('no run anchor was written');
  return entry;
};

beforeEach(() => {
  engineResult = baseEngineResult({});
});

describe('§ 234.4 — a durable PEER hold is a hold, to every consumer', () => {
  it('marks the response `awaiting_peer` — and NOT `awaiting_approval`', async () => {
    // ⛔ Both halves matter. The marker must appear (before this it was absent entirely, so a
    // caller saw `success: false` with no errors and could only read it as a silent failure);
    // and it must NOT arrive as `awaiting_approval`, which would offer an approve affordance
    // for a hold no approval resolves — the failure direction `commits.ts` names.
    engineResult = baseEngineResult({ awaiting_peer: PEER_PAUSE });
    const h = harness();
    const res = await drive(h);

    expect(res.awaiting_peer).toBe(true);
    expect(res.awaiting_approval).toBeUndefined();
    expect(res.success).toBe(false);
  });

  it('⛔⛔ does NOT tell paired clients the run FAILED', async () => {
    engineResult = baseEngineResult({ awaiting_peer: PEER_PAUSE });
    const h = harness();
    await drive(h);

    expect(executionOps(h)).not.toContain('error');
  });

  it('writes the held anchor, so the response and the audit row agree', async () => {
    // They disagreed: the anchor said `awaiting_peer` while the bus said the run errored and
    // the response said nothing at all. One run, three stories.
    engineResult = baseEngineResult({ awaiting_peer: PEER_PAUSE });
    const h = harness();
    await drive(h);

    const entry = await anchor(h);
    expect(entry.commit_status).toBe('awaiting_peer');
    expect(entry.checkpoint_id).toBeDefined();
  });
});

describe('§ 234.4 — and the other two outcomes are untouched', () => {
  it('an APPROVAL hold still marks `awaiting_approval`, and not the peer field', async () => {
    // The regression direction: merging the two into one predicate must not merge the two
    // MARKERS. An owner-approval hold that started reporting `awaiting_peer` would strand the
    // local ask this one has.
    engineResult = baseEngineResult({
      awaiting_approval: { gated_step_id: 'verdict', step_state: {} },
    });
    const h = harness();
    const res = await drive(h);

    expect(res.awaiting_approval).toBe(true);
    expect(res.awaiting_peer).toBeUndefined();
    expect((await anchor(h)).commit_status).toBe('awaiting_approval');
  });

  it('D-179 P1 — neither hold writes a NEXT-RUN continuity snapshot', async () => {
    // ⚠ THE APPROVAL HALF WAS UNTESTED, which is how the peer half went missing beside it:
    // `!result.awaiting_approval` READ as "not paused" and covered one WAY of being paused.
    // A snapshot taken mid-hold holds only the work done BEFORE the gate, and the next run
    // of this dish would read that half-finished picture as its prior-run state.
    for (const pause of [
      { awaiting_peer: PEER_PAUSE },
      { awaiting_approval: { gated_step_id: 'verdict', step_state: {} } },
    ]) {
      engineResult = baseEngineResult(pause);
      const h = harness();
      await driveDish(h);
      expect(h.dishSnapshotSet).not.toHaveBeenCalled();
    }
  });

  it('⚠ and a FINISHED dish run still snapshots — the skip is not always-on', async () => {
    // The permitting case: without it the assertion above passes on a handler that stopped
    // snapshotting entirely, which would silently retire `context.recipe.*`.
    engineResult = baseEngineResult({ success: true });
    const h = harness();
    await driveDish(h);
    expect(h.dishSnapshotSet).toHaveBeenCalledTimes(1);
  });

  it('⚠ a REAL failure still emits `error` and marks neither — the guard is not always-true', async () => {
    // Without this the three assertions above pass on a handler that silently stopped
    // emitting lifecycle events at all, which is the vacuous-green shape.
    engineResult = baseEngineResult({ errors: [{ message: 'boom' }] });
    const h = harness();
    const res = await drive(h);

    expect(executionOps(h)).toContain('error');
    expect(res.awaiting_peer).toBeUndefined();
    expect(res.awaiting_approval).toBeUndefined();
  });
});
