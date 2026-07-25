/** D-207 slice 1b — the recipe capability derivation.
 *
 *  An ungranted op is a HARD DENY, so an UNDER-derived closure kills the visitor's
 *  submission mid-run AND makes the owner's consent list a lie. These pin the two
 *  properties that matter: COMPLETENESS (all three step lists) and HONESTY (refuse a
 *  recipe whose dispatch target isn't knowable at bind). */

import { describe, expect, it } from 'vitest';

import type { RecipeDefinition } from '@recued/contracts';

import { buildRecipeOpDependencyIndex, deriveRecipeCapability } from '../derive-recipe-capability.js';

const recipe = (partial: Record<string, unknown>): RecipeDefinition =>
  ({ prefetch_steps: [], steps: [], ...partial }) as unknown as RecipeDefinition;

const ok = (d: ReturnType<typeof deriveRecipeCapability>) => {
  if (!d.ok) throw new Error(`expected ok, got refusal: ${JSON.stringify(d.refusal)}`);
  return d.capability;
};

describe('D-207 — completeness: ALL THREE step lists, not just `steps`', () => {
  it('covers prefetch_steps, steps AND trigger_steps', () => {
    // buildRecipeOpCoverage walks only `steps`. An op reachable from prefetch or a
    // reactive trigger is just as dispatched — and would have had NO grant row.
    const cap = ok(deriveRecipeCapability(recipe({
      prefetch_steps: [{ id: 'p', op: 'core.mail.get' }],
      steps: [{ id: 's', op: 'core.storage.shared.read' }],
      trigger_steps: [{ id: 't', op: 'core.work-entity.task.create' }],
    })));
    expect(cap.operation_ids).toEqual([
      'core.mail.get', 'core.storage.shared.read', 'core.work-entity.task.create',
    ]);
  });

  it('a step reachable ONLY from prefetch is still granted', () => {
    const cap = ok(deriveRecipeCapability(recipe({
      prefetch_steps: [{ id: 'p', op: 'core.mail.send' }],
      steps: [{ id: 's', transform: 'trim' }],
    })));
    expect(cap.operation_ids).toContain('core.mail.send');
  });

  it('the closure is SORTED — an unstable order would look like a capability change', () => {
    const cap = ok(deriveRecipeCapability(recipe({
      steps: [{ id: 'b', op: 'z.op' }, { id: 'a', op: 'a.op' }],
    })));
    expect(cap.operation_ids).toEqual(['a.op', 'z.op']);
  });
});

describe('D-207 — honesty: refuse a recipe whose dispatch target is not knowable', () => {
  it('REFUSES a templated ingredient — the run-ingredient dynamic dispatcher', () => {
    // `run-ingredient` dispatches `{{config.ingredient_slug}}`. No static closure exists,
    // so no honest consent list exists. Refused at BIND, never at fire.
    const d = deriveRecipeCapability(recipe({
      steps: [{ id: 'dyn', ingredient: '{{config.ingredient_slug}}' }],
    }));
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.refusal.reason).toBe('dynamic_dispatch');
      expect(d.refusal.step_id).toBe('dyn');
    }
  });

  it('REFUSES a templated op', () => {
    const d = deriveRecipeCapability(recipe({ steps: [{ id: 'x', op: '{{config.o}}' }] }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.reason).toBe('dynamic_dispatch');
  });

  it('a dynamic target in PREFETCH is refused too — not just in `steps`', () => {
    const d = deriveRecipeCapability(recipe({
      prefetch_steps: [{ id: 'p', ingredient: '{{config.x}}' }],
      steps: [{ id: 's', op: 'core.mail.get' }],
    }));
    expect(d.ok).toBe(false);
  });
});

describe('D-207 — connections: static once resolved through the recipe\'s own config', () => {
  it('resolves `{{config.stripe}}` against the DISH config_overlay — the shipped idiom', () => {
    // Every real recipe pins its connection this way, so this MUST resolve rather than
    // refuse. A reception run\'s config comes from the saved recipe, never the visitor.
    const cap = ok(deriveRecipeCapability(
      recipe({ steps: [{ id: 'c', op: 'x.create', connection: '{{config.stripe}}' }] }),
      { config: { stripe: 'my-stripe-acct' } },   // the DISH's config_overlay
    ));
    expect(cap.connection_names).toEqual(['my-stripe-acct']);
  });

  it('REFUSES a LITERAL connection name — non-portable, and already fails closed at validate', () => {
    // `steps.ts`: "Never a literal connection name (non-portable in a published canonical
    // recipe — fails closed at validate/resolve)."
    const d = deriveRecipeCapability(recipe({
      steps: [{ id: 'c', op: 'x.create', connection: 'literal-conn' }],
    }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.reason).toBe('literal_connection');
  });

  it('an OMITTED connection rides THE PACK\'S BOUND CONNECTION — reported, never skipped', () => {
    // The connection genuinely lives in the pack (D-194 connection_requirements ->
    // enrollment). A step omitting the slot is the COMMON case (37 shipped op-steps do).
    // Silently skipping it would leave ContractScope.connection_names EMPTY — and an
    // empty scope axis is a WILDCARD, so the connection fence would not bite.
    const cap = ok(deriveRecipeCapability(recipe({
      steps: [{ id: 'c', op: 'recued-core.stripe.charge.create' }],
    })));
    expect(cap.connection_names).toEqual([]);
    expect(cap.pack_bound_connection_ops).toEqual(['recued-core.stripe.charge.create']);
  });

  it('REFUSES a `{{step.*}}` connection — which credential it reaches for is runtime-chosen', () => {
    const d = deriveRecipeCapability(recipe({
      steps: [{ id: 'c', op: 'x.create', connection: '{{step.pick.name}}' }],
    }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.reason).toBe('dynamic_connection');
  });

  it('REFUSES a config ref with no configured value — an unconfigured recipe cannot back a door', () => {
    const d = deriveRecipeCapability(
      recipe({ steps: [{ id: 'c', op: 'x.create', connection: '{{config.missing}}' }] }),
      { config: {} },
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.reason).toBe('dynamic_connection');
  });
});

describe('D-207 — ingredient steps resolve to op ids via the pack resolver', () => {
  it('maps (ingredient, input.operation) -> canonical op id', () => {
    const cap = ok(deriveRecipeCapability(
      recipe({ steps: [{ id: 'i', ingredient: 'stripe', input: { operation: 'charge.create' } }] }),
      { resolveOp: (slug, op) => (slug === 'stripe' ? [`recued-core.${slug}.${op}`] : []) },
    ));
    expect(cap.operation_ids).toEqual(['recued-core.stripe.charge.create']);
    expect(cap.ingredient_ids).toEqual(['stripe']);
  });

  it('a pure-transform recipe derives an EMPTY closure — and that is NOT a wildcard', () => {
    // The empty closure is legitimate. It must not read as "any op" — that is caught by
    // `usesExplicitOnlyGrantDefaults` (see d-207-slice1b-public-contract-floor.test.ts).
    const cap = ok(deriveRecipeCapability(recipe({ steps: [{ id: 't', transform: 'trim' }] })));
    expect(cap.operation_ids).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════
// The dependency index — the OFF-direction warning
// ════════════════════════════════════════════════════════════════

describe('D-207 §5.1f — the dependency index backs the two grant-consent warnings', () => {
  const R = (id: string, ops: string[]) => ({
    id,
    recipe: { prefetch_steps: [], steps: ops.map((op, i) => ({ id: `s${i}`, op })) } as unknown as RecipeDefinition,
  });

  it('OFF-direction: "turning this op off will break these recipes"', () => {
    const idx = buildRecipeOpDependencyIndex([
      R('list-txns', ['recued-core.stripe.transaction.list']),
      R('daily-digest', ['recued-core.stripe.transaction.list', 'core.mail.send']),
      R('unrelated', ['core.mail.get']),
    ]);
    expect(idx.byOp.get('recued-core.stripe.transaction.list')).toEqual(['daily-digest', 'list-txns']);
    expect(idx.byOp.get('core.mail.get')).toEqual(['unrelated']);
  });

  it('the impact list is SORTED — a warning that reorders between renders is not trustworthy', () => {
    const idx = buildRecipeOpDependencyIndex([R('zeta', ['x.op']), R('alpha', ['x.op'])]);
    expect(idx.byOp.get('x.op')).toEqual(['alpha', 'zeta']);
  });

  it('a recipe that cannot be derived is REPORTED, never silently dropped from the index', () => {
    // A silently-dropped recipe would make the OFF-warning UNDER-COUNT its own blast
    // radius — the owner would be told fewer things break than actually do.
    const dyn = {
      id: 'dynamic',
      recipe: { prefetch_steps: [], steps: [{ id: 'd', ingredient: '{{config.slug}}' }] } as unknown as RecipeDefinition,
    };
    const idx = buildRecipeOpDependencyIndex([dyn, R('ok', ['a.op'])]);
    expect(idx.underivable).toEqual(['dynamic']);
    expect(idx.byOp.get('a.op')).toEqual(['ok']);
  });

  it('ON-direction: the forward warning IS the derived closure — enabling a recipe grants exactly these', () => {
    const cap = ok(deriveRecipeCapability(recipe({
      steps: [
        { id: 'a', op: 'recued-core.stripe.transaction.list' },
        { id: 'b', op: 'core.mail.send' },
      ],
    })));
    // This is what the owner is shown before enabling the recipe on a public door.
    expect(cap.operation_ids).toEqual(['core.mail.send', 'recued-core.stripe.transaction.list']);
  });
});
