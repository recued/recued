/** D-232 — the cycle guard for gateway-routed local recipe invocation.
 *
 * The owner asked for two rules: no routing back to itself, no routing back to
 * the sender. They are one rule at two depths — the target must not already be
 * on the stack — and the tests below exist to prove the DIFFERENCE that framing
 * makes, because a guard written to the letter of the two named cases passes
 * every test a careless author would write for it and still admits every cycle
 * longer than two hops.
 */
import { describe, expect, it } from 'vitest';

import {
  RecipeCycleError,
  assertNoRecipeCycle,
  extendHeldRecipes,
  seedHeldRecipes,
  wouldCycle,
} from '../local-recipe-cycle.js';

/** Walk a chain the way the gateway does — seed at the root, extend per hop —
 *  and report where it refuses. Returns `null` when the whole chain dispatches.
 *  Driving the REAL threading rather than asserting on a hand-built set is the
 *  point: the guard is only as good as the set that reaches it. */
const walk = (chain: readonly string[]): string | null => {
  let held = seedHeldRecipes(chain[0]);
  for (const next of chain.slice(1)) {
    if (wouldCycle(next, held)) return next;
    held = extendHeldRecipes(held, next);
  }
  return null;
};

describe('D-232 — local recipe cycle guard', () => {
  it('refuses A → A (the self case, depth 1)', () => {
    expect(walk(['a', 'a'])).toBe('a');
  });

  it('refuses A → B → A (the sender case, depth 2)', () => {
    expect(walk(['a', 'b', 'a'])).toBe('a');
  });

  it('⛔ refuses A → B → C → A — the case enumerating the two named rules MISSES', () => {
    // This is the whole reason the guard is a stack and not two comparisons.
    // `c` is neither `self` nor `sender`; a guard checking only those two
    // dispatches happily and loops until MAX_DISPATCH_DEPTH, having written 32
    // commits with real side effects on the way.
    expect(walk(['a', 'b', 'c', 'a'])).toBe('a');
  });

  it('⛔ refuses a repeat in the MIDDLE of a chain, not just a return to the root', () => {
    expect(walk(['a', 'b', 'c', 'b'])).toBe('b');
  });

  it('admits a chain with no repeat, however long', () => {
    expect(walk(['a', 'b', 'c', 'd', 'e'])).toBeNull();
  });

  it('admits a DIAMOND — the same recipe twice in one tree is not a cycle', () => {
    // A → B → D and A → C → D is legal: D is on neither branch's own stack.
    // A guard keyed on "has this recipe run in this tree" instead of "is it on
    // MY stack" would refuse this, and refusing it would make shared leaf
    // recipes uncomposable — the common case, broken to catch the rare one.
    expect(walk(['a', 'b', 'd'])).toBeNull();
    expect(walk(['a', 'c', 'd'])).toBeNull();
  });

  it('⛔ an UNSEEDED root admits A → A — which is why seeding has its own name', () => {
    // The failure mode the API shape is guarding against. If a host starts a run
    // without putting the running recipe in the set, the guard silently degrades
    // to sender-only and the self case walks through. Nothing downstream can
    // tell the difference, so it is pinned here.
    expect(wouldCycle('a', new Set())).toBe(false);
    expect(wouldCycle('a', seedHeldRecipes('a'))).toBe(true);
  });

  it('extends PURELY — a sibling branch cannot poison its parent\'s set', () => {
    // If `extendHeldRecipes` mutated, one branch's descendants would leak into
    // the other's stack and refuse calls that are legal (the diamond above would
    // start failing intermittently, depending on branch order).
    const parent = seedHeldRecipes('a');
    const left = extendHeldRecipes(parent, 'b');
    const right = extendHeldRecipes(parent, 'c');
    expect([...parent]).toEqual(['a']);
    expect(right.has('b')).toBe(false);
    expect(left.has('c')).toBe(false);
  });

  it('names BOTH ends when it refuses, so an operator can find the loop', () => {
    let raised: unknown;
    try {
      assertNoRecipeCycle('a', extendHeldRecipes(seedHeldRecipes('a'), 'b'));
    } catch (e) { raised = e; }
    expect(raised).toBeInstanceOf(RecipeCycleError);
    const err = raised as RecipeCycleError;
    expect(err.code).toBe('recipe_cycle');
    expect(err.target_recipe_id).toBe('a');
    expect(err.held_recipes).toEqual(['a', 'b']);
    // The message has to carry the stack — "cycle detected" with no pair is a
    // bug report nobody can act on.
    expect(err.message).toContain('a → b');
  });

  it('does not throw on the happy path', () => {
    expect(() => assertNoRecipeCycle('b', seedHeldRecipes('a'))).not.toThrow();
    expect(() => assertNoRecipeCycle('b', undefined)).not.toThrow();
  });
});
