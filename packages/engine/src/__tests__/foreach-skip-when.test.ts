/** `skip_when` on a `foreach` step — which of the two things does it mean?
 *
 *  ⛔⛔ It dispatched to the loop BEFORE the skip check, and the inner step kept
 *  the condition — so a step-scoped skip did not skip the step, it skipped
 *  every ITERATION and left an ARRAY OF NULLS. That array is truthy, so a
 *  `coalesce` between two mutually-exclusive foreach steps picks the one that
 *  was meant to be skipped. Blanks on the page, no error anywhere.
 *
 *  ⚠ The fix could NOT be "hoist the check": 220 shipped recipes write a
 *  per-ITEM `skip_when` (`{{item.should_notify}} not_equal true`) as a filter
 *  inside the loop, and evaluating that at step level reads `item` unset and
 *  answers wrongly. So it discriminates on whether the condition mentions
 *  `{{item.*}}` — both readings are unambiguous, only the behaviour was. */
import { describe, expect, it } from 'vitest';
import { executeRecipe, type ExecutionContext } from '@recued/engine';

const run = async (steps: unknown[], config: Record<string, unknown> = {}) => {
  const ctx = {
    recipe: {
      recipe_id: 'probe', version: 1, ttl: 0, metadata: { name: 'p' },
      variables: {}, prefetch_steps: [], steps, output: { render: [] },
    },
    stores: { vault: {}, config, context: {}, meta: {}, step: {} },
    ingredientExecutor: async () => ({}),
  } as never as ExecutionContext;
  const r = await executeRecipe(ctx);
  return new Map(r.steps.map(s => [s.id, s.result]));
};

/** ⚠ A foreach step's result is an array of ENVELOPES — `{ok, result, item}` —
 *  not of raw values. Asserting the raw values is how a reader assumes
 *  otherwise, so the unwrapping is named here once. */
const values = (out: unknown) => (out as { result: unknown }[] | null)?.map(e => e.result);

const ROWS = { id: 'rows', transform: 'json_parse', input: '[{"n":1},{"n":2}]' };

describe('a STEP-scoped skip_when skips the step', () => {
  it('⛔⛔ yields null, NOT an array of nulls', async () => {
    const out = await run([
      ROWS,
      { id: 'gate', transform: 'compare', left: '{{config.on}}', operator: 'equal', right: 'no' },
      { id: 'mapped', foreach: '{{step.rows}}', transform: 'template',
        template: 'x{{item.n}}', skip_when: '{{step.gate}} equal true' },
    ], { on: 'no' });
    expect(out.get('mapped')).toBeNull();
  });

  it('⛔ and a coalesce between two of them picks the one that RAN', async () => {
    // The shape that made `combined-balance` show blanks.
    const out = await run([
      ROWS,
      { id: 'want_a', transform: 'compare', left: '{{config.mode}}', operator: 'equal', right: 'a' },
      { id: 'a', foreach: '{{step.rows}}', transform: 'template', template: 'A{{item.n}}',
        skip_when: '{{step.want_a}} equal false' },
      { id: 'b', foreach: '{{step.rows}}', transform: 'template', template: 'B{{item.n}}',
        skip_when: '{{step.want_a}} equal true' },
      { id: 'picked', transform: 'coalesce', values: ['{{step.a}}', '{{step.b}}'] },
    ], { mode: 'b' });
    expect(out.get('a')).toBeNull();
    expect(values(out.get('picked'))).toEqual(['B1', 'B2']);
  });

  it('the guard PERMITS the case it must — a false condition still runs', async () => {
    const out = await run([
      ROWS,
      { id: 'gate', transform: 'compare', left: '{{config.on}}', operator: 'equal', right: 'no' },
      { id: 'mapped', foreach: '{{step.rows}}', transform: 'template',
        template: 'x{{item.n}}', skip_when: '{{step.gate}} equal true' },
    ], { on: 'yes' });
    expect(values(out.get('mapped'))).toEqual(['x1', 'x2']);
  });
});

describe('⛔ an ITEM-scoped skip_when still filters INSIDE the loop', () => {
  it('skips only the iterations that match', async () => {
    // 220 shipped recipes depend on this. Hoisting the check would read `item`
    // unset and skip (or run) the whole step.
    const out = await run([
      { id: 'rows', transform: 'json_parse',
        input: '[{"n":1,"drop":true},{"n":2,"drop":false}]' },
      { id: 'mapped', foreach: '{{step.rows}}', transform: 'template',
        template: 'x{{item.n}}', skip_when: '{{item.drop}} equal true' },
    ]);
    expect(values(out.get('mapped'))).toEqual([null, 'x2']);
    expect((out.get('mapped') as Array<Record<string, unknown>>)[0]).toMatchObject({
      ok: true,
      skipped: true,
      result: null,
    });
  });

  it('⚠ a bare {{item}} counts as item-scoped too', async () => {
    const out = await run([
      { id: 'rows', transform: 'json_parse', input: '["", "keep"]' },
      { id: 'mapped', foreach: '{{step.rows}}', transform: 'template',
        template: 'x{{item}}', skip_when: '{{item}} is_empty' },
    ]);
    // ⚠ Asserting the SKIP, not the rendered value: a bare `{{item}}` in a
    // `template` does not interpolate a plain string, which is a separate
    // quirk and not what this case is about.
    expect(values(out.get('mapped'))?.[0]).toBeNull();
    expect(values(out.get('mapped'))?.[1]).not.toBeNull();
  });
});
