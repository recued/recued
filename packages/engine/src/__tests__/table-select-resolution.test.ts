/** The engine's half of the selectable table: WHICH ROW FIELD IS THE ID.
 *
 *  ⛔⛔ RESOLVED ONCE, HOST-SIDE, ON PURPOSE. Every renderer could re-derive
 *  "the identity column" from the entity schema, and two copies that disagree
 *  submit the WRONG RECORDS — silently, because one id is as plausible a string
 *  as another. The validator refuses a bad declaration and the state layer
 *  trusts the descriptor; this is the only place the question is answered.
 */
import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

const FIELDS = [
  { key: 'id', type: 'id', required: true },
  { key: 'label', type: 'string', required: true },
  { key: 'status', type: 'string', required: false },
];

const run = async (
  section: Record<string, unknown>,
  config: Record<string, unknown> = {},
  fields: Array<Record<string, unknown>> = FIELDS,
) => {
  const recipe: RecipeDefinition = {
    recipe_id: 'picks', version: 1, ttl: 0,
    metadata: { name: 'Picks', description: 'x', author: 'test', supported_platforms: [] },
    variables: {
      picked: { label: 'Picked', type: 'array', default: [] } as never,
      limit: { label: 'Max', type: 'number', default: 200 } as never,
    },
    prefetch_steps: [],
    steps: [{ id: 'rows', ingredient: 'seed', input: {} }],
    output: { render: [{ type: 'table', source: 'step.rows', ...section } as never] },
  };
  const ingredientExecutor: IngredientExecutor = async () => ({ records: [] });
  const ctx = {
    recipe,
    stores: { vault: {}, config, context: {}, meta: {}, step: {} },
    ingredientExecutor,
    entityFields: () => fields,
  } as never as ExecutionContext;
  const result = await executeRecipe(ctx);
  const resolved = (result.output?.render ?? [])
    .find((s: Record<string, unknown>) => s.type === 'table') as Record<string, any>;
  return resolved?.table_select;
};

const SELECT = { into: 'picked', submit: 'Accept selected' };

describe('resolving the row identity', () => {
  it('takes the schema’s id column when the table names an entity', async () => {
    const select = await run({ entity: 'required_doc', select: SELECT });
    expect(select).toMatchObject({
      into: 'picked', submit: 'Accept selected', id_field: 'id', section_index: 0,
    });
    expect(select.unresolved).toBeUndefined();
  });

  it('honours an authored id_field over the schema', async () => {
    const select = await run({
      entity: 'required_doc',
      select: { ...SELECT, id_field: 'label' },
    });
    expect(select.id_field).toBe('label');
  });

  it('takes the authored id_field when there is no entity at all', async () => {
    const select = await run({ select: { ...SELECT, id_field: 'row_key' } });
    expect(select.id_field).toBe('row_key');
    expect(select.unresolved).toBeUndefined();
  });

  /** ⛔ REPORTED, NEVER GUESSED. A schema with no single `kind: 'id'` column
   *  and no authored `id_field` leaves nothing that says which record a tick
   *  means — so the descriptor says so and the renderer draws no controls,
   *  rather than falling back to whichever column looked id-shaped. */
  it('reports no_identity when the entity declares no single id column', async () => {
    const select = await run({ entity: 'required_doc', select: SELECT }, {}, [
      { key: 'label', type: 'string', required: true },
      { key: 'status', type: 'string', required: false },
    ]);
    expect(select).toMatchObject({ id_field: '', unresolved: 'no_identity' });
  });

  it('reports no_identity when TWO columns claim the identity', async () => {
    const select = await run({ entity: 'required_doc', select: SELECT }, {}, [
      { key: 'id', type: 'id', required: true },
      { key: 'legacy_id', type: 'id', required: false },
    ]);
    expect(select.unresolved).toBe('no_identity');
  });
});

describe('the run-level values that ride back', () => {
  it('carries the effective value of a hidden variable', async () => {
    // ⛔ Same reason the grid has it: a submit is a fresh run with only what
    // the control sends, so a `limit` the owner narrowed to 10 would revert to
    // its default and the re-read would list rows the selection never covered.
    const select = await run(
      { entity: 'required_doc', select: { ...SELECT, hidden: ['limit'] } },
      { limit: 10 },
    );
    expect(select.hidden).toEqual({ limit: 10 });
  });

  /** ⚠ THE EFFECTIVE VALUE, WHICH INCLUDES THE DEFAULT. I first asserted `{}`
   *  here on the reasoning that an untouched variable has "no effective
   *  value" — it does: the run resolved `limit` to 200 and read its data under
   *  200, so that is the number the resubmission has to carry. Sending nothing
   *  would let the re-read silently use a different one. */
  it('carries the resolved default when the owner narrowed nothing', async () => {
    const select = await run(
      { entity: 'required_doc', select: { ...SELECT, hidden: ['limit'] } },
      {},
    );
    expect(select.hidden).toEqual({ limit: 200 });
  });

  /** ⛔ A name the recipe does not declare is DROPPED, not passed through. The
   *  server admits only declared keys for this section, so forwarding one
   *  would build a submission it then rejects wholesale — and the control would
   *  look broken rather than the recipe. (The validator refuses this at
   *  install; this is the engine refusing to rely on that.) */
  it('drops a hidden name the recipe does not declare', async () => {
    const select = await run(
      { entity: 'required_doc', select: { ...SELECT, hidden: ['not_a_variable'] } },
      { not_a_variable: 'smuggled' },
    );
    expect(select.hidden).toEqual({});
  });

  it('is absent entirely on a table that declares no selection', async () => {
    expect(await run({ entity: 'required_doc' })).toBeUndefined();
  });
});
