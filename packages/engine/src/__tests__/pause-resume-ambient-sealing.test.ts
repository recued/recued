/** Pause/resume — what a paused run seals, and what it re-reads when the world moves.
 *
 *  A run that gates at a preflight approval can stay paused indefinitely, and the
 *  world does not hold still while it waits. These tests pin which side of that
 *  boundary each value falls on, by mutating ambient state DURING the pause:
 *
 *    - a pre-gate step's output is SEALED — it survives the pause unchanged and the
 *      step never re-runs, even though the value it captured is now stale;
 *    - a post-gate step reads the world at RESUME time, not at pause time;
 *    - so the gate's position in the recipe determines the durable view, and each
 *      value in that view reflects its own execution instant.
 *
 *  ⚠ WHY THIS FILE EXISTS. Nothing else covers it. `d-157-p1-pause-resume` proves
 *  the resume mechanism against a static world; `d-165-op-identity-binding-drift`
 *  mutates `{{config.*}}` across a real pause but asserts fail-closed re-ask;
 *  `d-196-approval-resume-authority` re-reads authority; the D-182 raw-op door
 *  freezes its args by design. None asserts that a pre-gate OUTPUT is still the
 *  pre-gate value after the world has moved underneath it.
 *
 *  ⛔ AND THE CONTRACT COMMENT POINTS THE OTHER WAY. `packages/contracts/src/
 *  checkpoint.ts:167-179` says `config` / `meta` / `context` / `connection` "are
 *  re-seeded at re-instantiation exactly as for a fresh run". Production does the
 *  opposite: `backend/server/src/preflight-resumer.ts:486` and `:494-499` replay the
 *  anchor's frozen `config_snapshot` / `context_snapshot` verbatim so the resumed run
 *  is byte-identical to the paused one. `d-165-op-identity-binding-drift.test.ts:36-39`
 *  states it correctly. Read the resumer, not the comment.
 *
 *  Mechanism under test: `packages/engine/src/execute.ts:312-389` — resume skips
 *  trigger and prefetch phases and restarts at the gated step, with `step.*`
 *  pre-seeded by the host from `Checkpoint.step_state`.
 *
 *  Provenance: written as the rung-1 wedge for invention round 8's G04-K02
 *  ("Closure-Timed Data Rooms"), which it killed — the sealing is real but reduces
 *  to per-field versioning. See internal design notes.
 *  Kept because the invariants it pins are load-bearing regardless of that verdict.
 */

import { describe, it, expect } from 'vitest';
import {
  executeRecipe,
  type ExecutionContext,
  type IngredientExecutor,
} from '@recued/engine';
import { PreflightRequiredSignal } from '@recued/contracts';
import type { NamespaceStores, RecipeDefinition, RecipeStep } from '@recued/contracts';

const METADATA = {
  name: 'Pause/resume ambient sealing',
  description: 'what a paused run seals vs re-reads',
  author: 'test',
  supported_platforms: ['test'],
};

const asSteps = (s: Array<Record<string, unknown>>): RecipeStep[] =>
  s as unknown as RecipeStep[];

const makeRecipe = (steps: RecipeStep[]): RecipeDefinition => ({
  recipe_id: 'pause-resume-ambient-sealing',
  version: 1,
  ttl: 300,
  metadata: METADATA,
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
});

const baseStores = (): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
});

/** Ambient state every read observes AT CALL TIME. Mutating it between the pause
 *  and the resume is the whole point: it is how a stale sealed value becomes
 *  distinguishable from a fresh one. */
interface World { valuation: string; ledger: string[] }

/** `read-world` samples ambient state when it runs. `read-cursor` captures the last
 *  ledger entry visible at its own instant. `read-ledger-since` reads forward from a
 *  supplied cursor. `gated-action` raises the real preflight signal while armed. */
const makeExec = (world: World, gate: { armed: boolean }): IngredientExecutor =>
  async (slug: string, input: Record<string, unknown>) => {
    if (slug === 'gated-action') {
      if (gate.armed) throw new PreflightRequiredSignal();
      return { dispatched: true };
    }
    if (slug === 'read-world') return { seen: world.valuation };
    if (slug === 'read-cursor') {
      return { mark: world.ledger[world.ledger.length - 1] ?? '' };
    }
    if (slug === 'read-ledger-since') {
      const since = String((input as { since?: unknown })?.since ?? '');
      const idx = world.ledger.indexOf(since);
      return { window: idx >= 0 ? world.ledger.slice(idx + 1) : [...world.ledger] };
    }
    return null;
  };

/** Drive one full pause → mutate-the-world → resume cycle and return the resumed
 *  run's `step.*` store. Mirrors what the host does: seed `step.*` from the
 *  checkpoint's `step_state`, then re-enter with `resumeFrom`. */
const driveAcrossPause = async (
  steps: RecipeStep[],
  gatedStepId: string,
  world: World,
  mutateDuringPause: (w: World) => void,
): Promise<Record<string, unknown>> => {
  const gate = { armed: true };
  const recipe = makeRecipe(steps);

  const paused = await executeRecipe({
    recipe,
    stores: baseStores(),
    ingredientExecutor: makeExec(world, gate),
  });
  expect(paused.awaiting_approval).toBeDefined();
  expect(paused.awaiting_approval!.gated_step_id).toBe(gatedStepId);
  const sealed = paused.awaiting_approval!.step_state as Record<string, unknown>;

  mutateDuringPause(world);

  gate.armed = false;
  const resumedStores = baseStores();
  Object.assign(resumedStores.step as Record<string, unknown>, sealed);
  const done = await executeRecipe({
    recipe,
    stores: resumedStores,
    ingredientExecutor: makeExec(world, gate),
    resumeFrom: { gated_step_id: gatedStepId },
  } as ExecutionContext);
  expect(done.success).toBe(true);
  return resumedStores.step as Record<string, unknown>;
};

const readEarly = { id: 'read_early', ingredient: 'read-world', input: 'x' };
const gatedCall = { id: 'gated_call', ingredient: 'gated-action', input: 'go' };
const readLate = { id: 'read_late', ingredient: 'read-world', input: 'x' };

const seenAt = (store: Record<string, unknown>, id: string): string =>
  (store[id] as { seen: string }).seen;

describe('pause/resume — ambient sealing across the gate', () => {
  it('a pre-gate step never re-runs on resume, and keeps the value it sealed', async () => {
    // The load-bearing invariant, and the one nothing else covers: if the engine
    // re-ran pre-gate steps, the sealed value would silently refresh to the
    // post-pause world and every assertion below would be measuring nothing.
    const world: World = { valuation: 'v1', ledger: [] };
    let readWorldCalls = 0;
    const gate = { armed: true };
    const recipe = makeRecipe(asSteps([readEarly, gatedCall, readLate]));
    const countingExec: IngredientExecutor = async (slug, input) => {
      if (slug === 'read-world') readWorldCalls += 1;
      return makeExec(world, gate)(slug, input);
    };

    const paused = await executeRecipe({
      recipe, stores: baseStores(), ingredientExecutor: countingExec,
    });
    expect(readWorldCalls).toBe(1);                       // only read_early ran
    const callsBeforeResume = readWorldCalls;

    world.valuation = 'v2';                               // the world moves
    gate.armed = false;
    const stores2 = baseStores();
    Object.assign(
      stores2.step as Record<string, unknown>,
      paused.awaiting_approval!.step_state,
    );
    await executeRecipe({
      recipe, stores: stores2, ingredientExecutor: countingExec,
      resumeFrom: { gated_step_id: 'gated_call' },
    } as ExecutionContext);

    // Exactly one MORE read — the post-gate one. `read_early` did not re-run.
    expect(readWorldCalls).toBe(callsBeforeResume + 1);
    expect(stores2.step).toHaveProperty('read_early', { seen: 'v1' });
  });

  it('the gate position determines the durable view, from an identical world', async () => {
    // Gate BETWEEN the reads: one seals before the mutation, one runs after it.
    const worldA: World = { valuation: 'v1', ledger: [] };
    const roomA = await driveAcrossPause(
      asSteps([readEarly, gatedCall, readLate]),
      'gated_call', worldA, (w) => { w.valuation = 'v2'; },
    );

    // Gate AFTER both reads — same steps, same world, same mutation.
    const worldB: World = { valuation: 'v1', ledger: [] };
    const roomB = await driveAcrossPause(
      asSteps([readEarly, readLate, gatedCall]),
      'gated_call', worldB, (w) => { w.valuation = 'v2'; },
    );

    expect([seenAt(roomA, 'read_early'), seenAt(roomA, 'read_late')])
      .toEqual(['v1', 'v2']);                             // early sealed, late fresh
    expect([seenAt(roomB, 'read_early'), seenAt(roomB, 'read_late')])
      .toEqual(['v1', 'v1']);                             // both sealed pre-mutation
  });

  it('each value reflects its own execution instant, so the view spans two epochs', async () => {
    // A resumed run's output is NOT a snapshot of any single moment: the world held
    // v1 before the pause and v2 after, and the durable view carries both. Callers
    // reading a completed run must not assume its values are mutually consistent.
    const world: World = { valuation: 'v1', ledger: [] };
    const room = await driveAcrossPause(
      asSteps([readEarly, gatedCall, readLate]),
      'gated_call', world, (w) => { w.valuation = 'v2'; },
    );
    const view = [seenAt(room, 'read_early'), seenAt(room, 'read_late')];

    expect(view).not.toEqual(['v1', 'v1']);               // not the pre-pause world
    expect(view).not.toEqual(['v2', 'v2']);               // not the post-resume world
    expect({ read_early: view[0], read_late: view[1] })
      .toEqual({ read_early: 'v1', read_late: 'v2' });    // one instant per value
  });

  it('a post-gate read windowed by a sealed cursor still sees what arrived during the pause', async () => {
    // Incremental-sync shape across a hold: a pre-gate step seals a cursor, work
    // arrives while the owner is deciding, and the post-gate read resumes from that
    // cursor. The seal fixes where the window STARTS; it does not fence off anything
    // that arrived after it. A regression here would silently drop the backlog a
    // paused run accumulated.
    const world: World = { valuation: 'v1', ledger: ['e1', 'e2'] };
    const room = await driveAcrossPause(
      asSteps([
        { id: 'cursor', ingredient: 'read-cursor', input: 'x' },
        gatedCall,
        // Refs resolve inside transform values; whole-object ingredient inputs pass
        // through raw — same `set`-then-string-ref idiom as `d-157-p1-pause-resume`.
        {
          id: 'payload',
          transform: 'set',
          source: { since: '{{step.cursor.mark}}' },
          field: 'probe',
          value: '1',
        },
        { id: 'window', ingredient: 'read-ledger-since', input: '{{step.payload}}' },
      ]),
      'gated_call',
      world,
      (w) => { w.ledger.push('e3', 'e4'); w.valuation = 'v2'; },
    );

    expect(room).toHaveProperty('cursor', { mark: 'e2' });        // sealed at pause
    expect((room.window as { window: string[] }).window)
      .toEqual(['e3', 'e4']);                                     // the pause backlog
  });

  it('is deterministic — identical world and gate position give an identical view', async () => {
    const runOnce = async (): Promise<string[]> => {
      const w: World = { valuation: 'v1', ledger: [] };
      const room = await driveAcrossPause(
        asSteps([readEarly, gatedCall, readLate]),
        'gated_call', w, (x) => { x.valuation = 'v2'; },
      );
      return [seenAt(room, 'read_early'), seenAt(room, 'read_late')];
    };
    const runs = [await runOnce(), await runOnce(), await runOnce()];
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[1]).toEqual(runs[2]);
  });
});
