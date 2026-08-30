/** D-255 (post-retraction) — the transient recipe a canonical op invocation becomes.
 *
 *  ⛔ THE ASSERTIONS THAT MATTER RUN THE REAL CONSUMERS, not a shape check. A
 *  hand-written `toEqual` over the built object would pass while the recipe was
 *  unusable: what decides whether R2 can dispatch it is whether
 *  `opStepConnectionSlots` binds a slot and whether `isCanonicalOpStep` recognises
 *  the step — both of which depend on details (`type: 'connection'` as an OBJECT,
 *  a pure `{{config.<var>}}` ref) that a literal can get wrong while looking right.
 */

import { describe, expect, it } from 'vitest';
import { isCanonicalOpStep } from '@recued/contracts';

import {
  buildCanonicalOpRecipe,
  CANONICAL_OP_CONNECTION_VAR,
  CANONICAL_OP_STEP_ID,
} from '../canonical-op-invocation.js';
import { opStepConnectionSlots } from '../connection-agnostic.js';
import { validateRecipe } from '../validate.js';

const ok = (alias: string, verb: string, args?: Record<string, unknown>) => {
  const built = buildCanonicalOpRecipe({ alias, verb, ...(args ? { args } : {}) });
  expect(built.ok, built.ok ? '' : (built as { reason: string }).reason).toBe(true);
  if (!built.ok) throw new Error('unreachable');
  return built.recipe;
};

describe('buildCanonicalOpRecipe — the real consumers accept it', () => {
  it("⛔ the step is recognised as a canonical op-step", () => {
    const recipe = ok('contact', 'update', { id: 'c-1', jobtitle: 'CTO' });
    expect(recipe.steps).toHaveLength(1);
    expect(isCanonicalOpStep(recipe.steps[0]!)).toBe(true);
  });

  it("⛔ R2's slot derivation binds the connection slot", () => {
    // The composition check. `connectionVariableNames` reads `type: 'connection'`
    // off the OBJECT form only, and the step's ref must be a pure
    // `{{config.<var>}}` naming it — two details a literal can get wrong
    // independently while each half looks correct.
    const slots = opStepConnectionSlots(ok('deal', 'search', { limit: 10 }));
    expect(slots.ok, slots.ok ? '' : (slots as { reason: string }).reason).toBe(true);
    if (!slots.ok) throw new Error('unreachable');
    expect(slots.slotByStepId.get(CANONICAL_OP_STEP_ID)).toBe(CANONICAL_OP_CONNECTION_VAR);
    expect(slots.variables).toEqual([CANONICAL_OP_CONNECTION_VAR]);
  });

  it('passes the recipe validator with no errors', () => {
    for (const [alias, verb] of [
      ['contact', 'read'], ['deal', 'search'], ['account', 'update'],
      ['contact', 'create'], ['deal', 'delete'],
    ] as const) {
      const issues = validateRecipe(ok(alias, verb, { id: 'x' })).issues
        .filter((i) => i.severity === 'error');
      expect(issues, `${alias}.${verb}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it('carries the args through verbatim — the resolver owns their translation', () => {
    const args = { id: 'c-1', jobtitle: 'CTO', nested: { a: 1 } };
    const step = ok('contact', 'update', args).steps[0] as unknown as {
      args: Record<string, unknown>;
    };
    expect(step.args).toEqual(args);
  });

  it('omits `args` entirely when none are supplied', () => {
    const step = ok('deal', 'search').steps[0] as unknown as Record<string, unknown>;
    expect('args' in step).toBe(false);
  });

  it('keeps the step id stable — it is what the projection preserves', () => {
    // The resolver's projection step KEEPS the op-step id, so this is the name a
    // caller reads the canonical record back from. Changing it is a wire break.
    expect(CANONICAL_OP_STEP_ID).toBe('result');
    expect((ok('deal', 'read', { id: '1' }).steps[0] as { id: string }).id).toBe('result');
  });
});

describe('buildCanonicalOpRecipe — fails closed', () => {
  it('rejects an unknown alias, naming what was expected', () => {
    const built = buildCanonicalOpRecipe({ alias: 'ticket', verb: 'update' });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error('unreachable');
    expect(built.reason).toContain("unknown canonical alias 'ticket'");
    expect(built.reason).toContain('contact');
  });

  it('rejects an unknown verb', () => {
    const built = buildCanonicalOpRecipe({ alias: 'contact', verb: 'upsert' });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error('unreachable');
    expect(built.reason).toContain("unknown canonical verb 'upsert'");
  });

  it('⛔ rejects BEFORE emitting a recipe, not after', () => {
    // R2 would refuse an unknown alias too, and safely — but it reports "this
    // recipe did not resolve", which sends a reader to the connection and the
    // catalog rather than to the two characters that were wrong.
    const built = buildCanonicalOpRecipe({ alias: 'nope', verb: 'read' });
    expect(built).not.toHaveProperty('recipe');
  });

  it('admits every shipped alias and verb', () => {
    for (const alias of ['deal', 'contact', 'account']) {
      for (const verb of ['read', 'search', 'create', 'update', 'delete']) {
        expect(buildCanonicalOpRecipe({ alias, verb }).ok, `${alias}.${verb}`).toBe(true);
      }
    }
    // The accounting family rides the same builder — `KernelConnectionFamily` is
    // generic over conventions, so forgetting it here would be a second arc.
    expect(buildCanonicalOpRecipe({ alias: 'invoice', verb: 'search' }).ok).toBe(true);
  });
});
