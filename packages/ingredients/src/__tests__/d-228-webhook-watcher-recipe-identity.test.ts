/** D-228 — `webhook-watcher`'s queue identity is ENGINE-OWNED, not authored.
 *
 *  ⛔⛔ THE DEFECT. `webhook-watcher` drains a per-`(recipe_id, slug)` queue, and
 *  `drain()` DELETES what it returns. `recipe_id` arrived as ordinary authored
 *  input and was never checked against the recipe actually running, so any
 *  recipe could name ANOTHER recipe's queue and:
 *    - READ its contents — full headers, body and source IP, which for a webhook
 *      means the authorization / signature headers the sender used; and
 *    - DESTROY them, so the owning recipe never sees those deliveries at all.
 *  A trigger silently eating another trigger's webhooks is close to
 *  undiagnosable from the outside: the victim simply never fires.
 *
 *  ⚠ THE DESTRUCTIVE DRAIN IS NOT THE BUG AND IS NOT REMOVED. It is the
 *  at-most-once consume that stops one webhook re-firing on every tick — the
 *  same shape whose ABSENCE elsewhere makes reactive recipes re-run forever. The
 *  bug was WHOSE queue a caller could name. Fix: the kernel adapter injects the
 *  trusted `stepMeta.recipe_id`, exactly as it already did for
 *  `time-relative-watcher`'s firing ledger, and engine metadata wins over
 *  authored input.
 *
 *  🔑 Why not raise `risk_tier` to `destructive` instead: `risk` at the trigger
 *  position feeds the approval gate, and a trigger predicate is evaluated every
 *  tick — an asking tier makes it nonfunctional (`core.watch.time-relative`
 *  alone backs 5 shipped recipes). That was tried and reverted. `risk_tier`
 *  cannot express "reads someone else's queue and empties it"; binding the
 *  identity can. */

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

describe('webhook-watcher queue identity', () => {
  /** ⛔⛔ THE FIX. Authored `recipe_id` names a victim; the engine's own recipe
   *  id must win, so the drain can only ever hit the caller's own queue. */
  it('the ENGINE recipe id overrides an authored one', async () => {
    const { adapter, seenArgs } = harness();
    await adapter(mkCall(
      'webhook-watcher',
      { recipe_id: 'victim-recipe', slug: 'inbound' },
      { step_id: 'gate', recipe_id: 'calling-recipe' },
    ));
    expect(seenArgs()?.recipe_id).toBe('calling-recipe');
  });

  /** `slug` stays authored on purpose — the hook path is
   *  `/hook/{recipe_id}/{slug}`, so once the recipe id is bound, every slug a
   *  caller can name is already inside its own namespace. Pinned so a later
   *  "harden everything" pass doesn't break legitimate multi-hook recipes. */
  it('leaves the authored `slug` alone', async () => {
    const { adapter, seenArgs } = harness();
    await adapter(mkCall(
      'webhook-watcher',
      { recipe_id: 'victim', slug: 'stripe-events' },
      { step_id: 'gate', recipe_id: 'mine' },
    ));
    expect(seenArgs()?.slug).toBe('stripe-events');
  });

  /** ⚠ THE ADAPTER ITSELF STILL PASSES AN AUTHORED ID THROUGH when there is no
   *  engine context — it has nothing to override with. That was the residual,
   *  and it is CLOSED one layer up: `runtime.runWatcher` now REFUSES every slug
   *  in `RECIPE_KEYED_WATCHER_SLUGS` outright, because a thin pass-through
   *  cannot supply the identity and must not pretend to
   *  (`backend/server/src/watcher-rpc-handler.ts`).
   *
   *  ⛔ So this test pins the adapter's honest behaviour, NOT a reachable hole.
   *  Do not "fix" it by inventing an id here: a fabricated recipe identity is
   *  worse than an absent one, and the in-process kernel path always has real
   *  `stepMeta`. */
  it('without engine context the authored id survives (adapter has nothing to override with)', async () => {
    const { adapter, seenArgs } = harness();
    await adapter(mkCall('webhook-watcher', { recipe_id: 'anything', slug: 's' }));
    expect(seenArgs()?.recipe_id).toBe('anything');
  });
});

describe('the injection is slug-scoped, not blanket', () => {
  /** ⛔ THE DISCRIMINATOR. Without this the suite could not tell a two-slug rule
   *  from "the adapter rewrites recipe_id for every watcher" — which would
   *  silently change mail/file/calendar watcher semantics. */
  it('a watcher outside the set keeps its authored recipe_id', async () => {
    const { adapter, seenArgs } = harness();
    await adapter(mkCall(
      'mail-watcher',
      { recipe_id: 'authored', since: 0 },
      { step_id: 'gate', recipe_id: 'engine' },
    ));
    expect(seenArgs()?.recipe_id).toBe('authored');
  });

  /** The precedent this fix follows, kept green so the shared condition can't be
   *  rewritten in a way that fixes webhook and drops time-relative. */
  it('time-relative-watcher still gets the engine id', async () => {
    const { adapter, seenArgs } = harness();
    await adapter(mkCall(
      'time-relative-watcher',
      { recipe_id: 'authored', anchor_field: 'due_at' },
      { step_id: 'gate', recipe_id: 'engine' },
    ));
    expect(seenArgs()?.recipe_id).toBe('engine');
  });
});
