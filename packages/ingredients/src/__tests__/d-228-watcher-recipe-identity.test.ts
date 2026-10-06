/** D-228 — a watcher's per-recipe state is keyed by an ENGINE-OWNED identity,
 *  never an authored one.
 *
 *  ⛔⛔ THE DEFECT THAT FOUND THIS (2026-07-31). The webhook watcher drained a
 *  per-`(recipe_id, slug)` queue, deleting what it returned, and `recipe_id`
 *  arrived as ordinary authored input: any recipe could name ANOTHER recipe's
 *  queue, read its deliveries (headers, body, source IP) and destroy them, so
 *  the owner's recipe silently never fired. The fix bound the identity: the
 *  kernel adapter injects the trusted `stepMeta.recipe_id` for every watcher in
 *  `RECIPE_KEYED_WATCHER_SLUGS`, and engine metadata wins over authored input.
 *  The webhook (and calendar) watchers were retired 2026-10-05; the rule stays
 *  for the two that key state today: `time-relative-watcher` (its firing
 *  ledger) and `http-watcher` (the page it remembers with `once_per_change`).
 *
 *  🔑 Why not raise `risk_tier` instead: `risk` at the trigger position feeds
 *  the approval gate, and a trigger predicate is evaluated every tick — an
 *  asking tier makes it nonfunctional (`core.watch.time-relative` alone backs
 *  5 shipped recipes). That was tried and reverted. `risk_tier` cannot express
 *  "keys another recipe's state"; binding the identity can. */

import { describe, expect, it } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
import type { ResolvedCall } from '../types.js';

const mkCall = (
  slug: string,
  input: Record<string, unknown>,
  stepMeta?: ResolvedCall['stepMeta'],
): ResolvedCall => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  ...(stepMeta ? { stepMeta } : {}),
});

/** Captures what the watcher slot actually received. */
const harness = () => {
  let seen: { slug: string; args: Record<string, unknown> } | null = null;
  const adapter = createKernelAdapter({
    watcher: async (input: { slug: string; args: Record<string, unknown> }) => {
      seen = input as { slug: string; args: Record<string, unknown> };
      return { should_run: false } as never;
    },
  } as never);
  return { adapter, seenArgs: () => seen?.args ?? null };
};

describe('time-relative-watcher identity', () => {
  /** Its durable firing ledger is per recipe: an authored id naming another
   *  recipe would record that recipe's boundaries as fired, and it would miss
   *  them. */
  it('the ENGINE recipe id overrides an authored one', async () => {
    const { adapter, seenArgs } = harness();
    await adapter(mkCall(
      'time-relative-watcher',
      { recipe_id: 'victim-recipe', anchor_field: 'due_at' },
      { step_id: 'gate', recipe_id: 'calling-recipe' },
    ));
    expect(seenArgs()?.recipe_id).toBe('calling-recipe');
  });

  /** ⚠ THE ADAPTER STILL PASSES AN AUTHORED ID THROUGH when there is no engine
   *  context — it has nothing to override with. A caller with no engine
   *  context is refused one layer up: `runtime.testTrigger` refuses every slug
   *  in `RECIPE_KEYED_WATCHER_SLUGS` (`backend/server/src/trigger-test-rpc-
   *  handler.ts`). ⛔ So this pins the adapter's honest behaviour, NOT a
   *  reachable hole. Do not "fix" it by inventing an id here: a fabricated
   *  recipe identity is worse than an absent one, and the in-process kernel
   *  path always has real `stepMeta`. */
  it('without engine context the authored id survives (adapter has nothing to override with)', async () => {
    const { adapter, seenArgs } = harness();
    await adapter(mkCall('time-relative-watcher', { recipe_id: 'anything', anchor_field: 'due_at' }));
    expect(seenArgs()?.recipe_id).toBe('anything');
  });
});

describe('http-watcher identity (2026-10-05)', () => {
  /** With `once_per_change` the server keeps the page a recipe last reported
   *  and hands it back as `previous_body`, and holds the newly reported page
   *  until that RUN settles. An authored recipe id would read another recipe's
   *  stored page; an authored run id would let another run's outcome settle it. */
  it('the ENGINE recipe and run ids override authored ones', async () => {
    const { adapter, seenArgs } = harness();
    await adapter(mkCall(
      'http-watcher',
      { target_url: 'https://example.com', once_per_change: true, recipe_id: 'victim-recipe', run_id: 'victim-run' },
      { step_id: 'page', recipe_id: 'calling-recipe', run_id: 'calling-run' },
    ));
    expect(seenArgs()).toMatchObject({ recipe_id: 'calling-recipe', run_id: 'calling-run' });
  });

  it('⛔ an authored run id never reaches the watcher, even with no run to replace it', async () => {
    const { adapter, seenArgs } = harness();
    await adapter(mkCall(
      'http-watcher',
      { target_url: 'https://example.com', once_per_change: true, run_id: 'victim-run' },
      { step_id: 'page', recipe_id: 'calling-recipe' },
    ));
    expect(seenArgs()).not.toHaveProperty('run_id');
  });

  it('no other watcher is handed a run id', async () => {
    const { adapter, seenArgs } = harness();
    await adapter(mkCall(
      'time-relative-watcher',
      { anchor_field: 'due_at' },
      { step_id: 'gate', recipe_id: 'engine', run_id: 'run-1' },
    ));
    expect(seenArgs()).not.toHaveProperty('run_id');
  });
});

describe('the injection is slug-scoped, not blanket', () => {
  /** ⛔ THE DISCRIMINATOR. Without this the suite could not tell a slug-scoped
   *  rule from "the adapter rewrites recipe_id for every watcher" — which would
   *  silently change the semantics of a watcher that keys nothing. */
  it('a watcher outside the set keeps its authored recipe_id', async () => {
    const { adapter, seenArgs } = harness();
    await adapter(mkCall(
      'time-watcher',
      { recipe_id: 'authored', start_hour: 8, end_hour: 9 },
      { step_id: 'gate', recipe_id: 'engine' },
    ));
    expect(seenArgs()?.recipe_id).toBe('authored');
  });
});
