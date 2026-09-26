/** D-282 — the two questions a surface must answer before running a recipe
 *  that nobody asked for.
 *
 *  ⛔⛔ THE HOLE THESE PIN. `recipeDeclaredOps` skips every op whose tier is not
 *  `pack` — correct for ITS job, since the D-221 disclosure is about pack ops —
 *  and `isProvablyReadOnly` was built on top of it, so the predicate that
 *  decides a recipe may AUTO-RUN as a pack view was blind to the entire kernel
 *  tier. Measured with the real classifier before the fix: of 396 views, 49
 *  contained a kernel op the registry itself calls `write` (`core.mail.send`
 *  among them, in `overdue-invoice-chase`) and 114 called `core.ai.*`.
 *  `mail-estimate-quickbooks` — two reads and a `core.mail.send` — answered
 *  `isProvablyReadOnly → true`.
 *
 *  ⚠ NOT ONE EXISTING TEST WENT RED WHEN THE FIX MOVED 173 RECIPES BETWEEN
 *  BUCKETS. The suite had no coverage of the kernel axis at all, which is the
 *  same absence that let the hole ship. These are that coverage.
 *
 *  🔑 TWO AXES, NOT ONE STRICTER TIER. An effect question (`isProvablyReadOnly`)
 *  and a cost question (`recipeSpendsPerRun`) — because `core.ai.summarize` is
 *  `risk: 'read'` and that is CORRECT: it changes nothing, reverses nothing, and
 *  has nothing to undo. It is simply not free, and risk has no word for that. */
import { describe, expect, it } from 'vitest';

import {
  buildPackOperationIndex,
  isProvablyReadOnly,
  kernelOpBackingSlug,
  kernelOpRiskTier,
  kernelOpSpendsPerRun,
  recipeDeclaredOps,
  recipeSpendsPerRun,
} from '../index.js';

/** One installed pack declaring a single read op, so the Tier-P half of the
 *  proof passes and every assertion below is about the kernel half. */
const roster = buildPackOperationIndex([{
  slug: 'demo',
  publisher: 'recued-core',
  manifest: {
    contents: [{
      type: 'composition',
      composition: {
        schema_version: 1,
        slug: 'demo',
        operations: [{
          op: 'thing.search',
          ingredient: 'demo',
          risk: 'read',
          bind: { kind: 'core.records', action: 'search', entity: 'thing' },
        }],
      },
    }],
  },
} as never]);

const withSteps = (...ops: string[]): never => ({
  recipe_id: 'probe',
  steps: [
    { id: 'shape', transform: 'default', value: '{{config.x}}', fallback: null },
    ...ops.map((op, i) => ({ id: `op${i}`, op, args: {} })),
  ],
} as never);

describe('kernelOpRiskTier — the risk the proof used to skip', () => {
  it('reads a REGISTERED op straight off its registry row', () => {
    expect(kernelOpRiskTier('core.mail.get')).toBe('read');
    expect(kernelOpRiskTier('core.mail.send')).toBe('write');
    expect(kernelOpRiskTier('core.mail.delete')).toBe('destructive');
  });

  /** ⚠ `core.crm.*` / `core.acct.*` are DELIBERATELY unregistered — they
   *  run-resolve to whichever vendor is bound — so their risk comes from the
   *  verb, exactly as `kernelOpRunnability` derives unbound behaviour from it. */
  it('derives a CANONICAL CONVENTION op from its verb', () => {
    expect(kernelOpRiskTier('core.crm.deal.search')).toBe('read');
    expect(kernelOpRiskTier('core.crm.contact.update')).toBe('write');
    expect(kernelOpRiskTier('core.crm.contact.delete')).toBe('destructive');
  });

  /** ⛔ Every one of these is a `null`, and `null` is what makes the caller fail
   *  closed. An unknown shape is not evidence of innocence. */
  it('refuses to classify anything it does not recognise', () => {
    // An extra remainder segment — the runtime refuses this shape, so reading
    // its last segment as the verb would classify something that cannot run.
    expect(kernelOpRiskTier('core.crm.deal.extra.search')).toBeNull();
    // A closed-kind domain's ops are ALL registered, so an unregistered one is
    // a typo or a retired id, not a tier to guess at.
    expect(kernelOpRiskTier('core.mail.definitely-not-an-op')).toBeNull();
    expect(kernelOpRiskTier('core.nope.thing')).toBeNull();
    // Not a kernel op at all.
    expect(kernelOpRiskTier('recued-core.pack.op')).toBeNull();
    expect(kernelOpRiskTier('garbage')).toBeNull();
  });

  /** ⚠ The ALIAS is not checked, unlike `kernelOpRunnability`, and that is a
   *  decision rather than an oversight: the verb alone decides EFFECT. Being
   *  lenient here can only render an error (the op fails closed at dispatch);
   *  being lenient about the verb would let a write auto-run. */
  it('classifies an unregistered alias by its verb rather than refusing', () => {
    expect(kernelOpRiskTier('core.crm.invoice.search')).toBe('read');
  });
});

describe('isProvablyReadOnly — question 1: may I run it without being asked?', () => {
  it('a recipe that only transforms is read-only', () => {
    expect(isProvablyReadOnly(withSteps(), roster)).toBe(true);
  });

  it('a kernel READ does not disqualify it', () => {
    expect(isProvablyReadOnly(withSteps('core.mail.get'), roster)).toBe(true);
    expect(isProvablyReadOnly(withSteps('core.crm.deal.search'), roster)).toBe(true);
  });

  /** ⛔⛔ THE REGRESSION. This returned `true` until 2026-09-21, which is how
   *  `mail-estimate-quickbooks` and `overdue-invoice-chase` became auto-running
   *  view tabs. */
  it('a kernel WRITE disqualifies it', () => {
    expect(isProvablyReadOnly(withSteps('core.mail.send'), roster)).toBe(false);
    expect(isProvablyReadOnly(withSteps('core.storage.shared.delete'), roster)).toBe(false);
    expect(isProvablyReadOnly(withSteps('core.crm.contact.update'), roster)).toBe(false);
  });

  it('an op it cannot classify disqualifies it, on every unknown shape', () => {
    expect(isProvablyReadOnly(withSteps('core.mail.definitely-not-an-op'), roster)).toBe(false);
    expect(isProvablyReadOnly(withSteps('core.crm.deal.extra.search'), roster)).toBe(false);
    // ⚠ An op id that does not PARSE was skipped by the Tier-P loop too, so it
    // used to buy silence twice over.
    expect(isProvablyReadOnly(withSteps('garbage'), roster)).toBe(false);
  });

  /** 🔑 An AI call changes nothing, so it passes question 1 — and that is the
   *  whole reason question 2 has to exist separately. */
  it('an AI op is effect-free, so THIS predicate admits it', () => {
    expect(isProvablyReadOnly(withSteps('core.ai.summarize'), roster)).toBe(true);
  });

  /** ⛔⛔ A TRIMMED BODY PROVES NOTHING. A `recipe.list` row carries no steps, so
   *  every check below would pass over nothing: no op, nothing unresolved, no
   *  write. The webclient cast one past the parameter type and got `true` for a
   *  recipe that sends mail (2026-09-24 audit). */
  it('a body with no steps is not read-only, whatever it would have held', () => {
    const { steps: _steps, ...trimmed } = withSteps('core.mail.send') as unknown as Record<string, unknown>;
    expect(isProvablyReadOnly(trimmed as never, roster)).toBe(false);
    expect(isProvablyReadOnly({ recipe_id: 'probe', steps: null } as never, roster)).toBe(false);
    // An empty list is a body with nothing in it, which is a different thing.
    expect(isProvablyReadOnly({ recipe_id: 'probe', steps: [] } as never, roster)).toBe(true);
  });

  it('checks prefetch and trigger steps, not just sequential ones', () => {
    const prefetching = {
      recipe_id: 'probe',
      prefetch_steps: [{ id: 'p', op: 'core.mail.send', args: {} }],
      steps: [{ id: 's', transform: 'default', value: '1', fallback: null }],
    } as never;
    expect(isProvablyReadOnly(prefetching, roster)).toBe(false);
  });
});

/** 🔑 A VENDOR API THE VENDOR BILLS PER CALL IS `risk: 'read'`, so only its
 *  `spends_per_call` mark can say it spends. Eight shipped views called one on
 *  every tab switch (2026-09-24 audit); the kernel half alone could not see them. */
describe('recipeSpendsPerRun — a pack op marked spends_per_call', () => {
  const metered = buildPackOperationIndex([{
    slug: 'demo',
    publisher: 'recued-core',
    manifest: {
      contents: [{
        type: 'composition',
        composition: {
          schema_version: 1,
          slug: 'demo',
          operations: [
            { op: 'answer.ask', ingredient: 'demo', risk: 'read', approval: 'never', spends_per_call: true,
              bind: { kind: 'rest', method: 'POST', path_template: '/ask' } },
            { op: 'model.search', ingredient: 'demo', risk: 'read', approval: 'never',
              bind: { kind: 'rest', method: 'GET', path_template: '/models' } },
          ],
        },
      }],
    },
  } as never]);

  it('⛔ a recipe that calls a marked op spends', () => {
    expect(recipeSpendsPerRun(withSteps('recued-core.demo.answer.ask'), metered)).toBe(true);
  });

  it('an unmarked op of the same vendor does not', () => {
    expect(recipeSpendsPerRun(withSteps('recued-core.demo.model.search'), metered)).toBe(false);
  });

  it('it changes nothing, so it still passes question 1: the cost is the whole reason', () => {
    expect(isProvablyReadOnly(withSteps('recued-core.demo.answer.ask'), metered)).toBe(true);
  });

  it('without the roster the mark cannot be read, and the op cannot be proven read-only either', () => {
    // So a surface without the roster refuses the view on question 1 instead.
    expect(recipeSpendsPerRun(withSteps('recued-core.demo.answer.ask'))).toBe(false);
    expect(isProvablyReadOnly(withSteps('recued-core.demo.answer.ask'), buildPackOperationIndex([]))).toBe(false);
  });
});

describe('recipeSpendsPerRun — question 2: may I run it REPEATEDLY?', () => {
  it('every core.ai.* op spends', () => {
    expect(kernelOpSpendsPerRun('core.ai.summarize')).toBe(true);
    expect(kernelOpSpendsPerRun('core.ai.classify')).toBe(true);
    expect(recipeSpendsPerRun(withSteps('core.ai.extract'))).toBe(true);
  });

  it('reading, writing and unknown ops do not', () => {
    expect(kernelOpSpendsPerRun('core.mail.get')).toBe(false);
    expect(kernelOpSpendsPerRun('core.mail.send')).toBe(false);
    expect(kernelOpSpendsPerRun('core.nope.thing')).toBe(false);
    expect(recipeSpendsPerRun(withSteps('core.mail.get'))).toBe(false);
    expect(recipeSpendsPerRun(withSteps())).toBe(false);
  });

  /** ⛔ THE KERNEL HALF NEEDS NOTHING BUT THE RECIPE BODY, and that is
   *  load-bearing: the effect axis needs the installed pack index (so it rides
   *  the server's `provably_read_only` projection), but a kernel op id is visible
   *  in the recipe body alone. A client can always compute this half, so a server
   *  too old to project anything cannot silently restore an auto-run by staying
   *  quiet. This pinned the ARITY (one parameter) until the pack half arrived
   *  (2026-09-25), which reads `spends_per_call` off the roster, so the roster is
   *  an optional second parameter and the property is asserted directly. */
  it('the kernel half needs nothing but the recipe body', () => {
    expect(recipeSpendsPerRun(withSteps('core.ai.summarize'))).toBe(true);
    expect(recipeSpendsPerRun({
      recipe_id: 'probe',
      steps: [{ id: 'lowered', ingredient: kernelOpBackingSlug('core.ai.classify'), input: {} }],
    } as never)).toBe(true);
  });

  it('sees an AI call in a prefetch step too', () => {
    expect(recipeSpendsPerRun({
      recipe_id: 'probe',
      prefetch_steps: [{ id: 'p', op: 'core.ai.summarize', args: {} }],
      steps: [],
    } as never)).toBe(true);
  });
});

/** ⛔ The scoping that was NOT changed, pinned so a later tidy-up does not
 *  "finish the job" and move a shipped surface with it. `recipeDeclaredOps`
 *  feeds the D-221 stored-Records disclosure, which is about PACK ops; teaching
 *  it the kernel tier would silently re-label that panel. */
describe('recipeDeclaredOps stays Tier-P, deliberately', () => {
  it('reports no risk for a recipe whose only op is a kernel WRITE', () => {
    const declared = recipeDeclaredOps(withSteps('core.mail.send'), roster);
    expect(declared.risk).toBeNull();
    expect(declared.unresolved).toEqual([]);
  });
});
