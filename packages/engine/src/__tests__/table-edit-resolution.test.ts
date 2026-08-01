/** The engine's half of the editable table: which columns the owner may TYPE.
 *
 *  The resolution is where `edit.columns` becomes `editable`, and it is the
 *  only place the shown/typeable distinction is actually decided — the
 *  validator refuses a bad declaration, the state layer trusts the descriptor.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

const FIELDS = [
  { key: 'id', type: 'id', required: true },
  { key: 'contract_ref', type: 'string', required: true },
  { key: 'amount', type: 'decimal', required: false },
  { key: 'method', type: 'string', required: false },
];

const run = async (edit: Record<string, unknown>, config: Record<string, unknown> = {}) => {
  const recipe: RecipeDefinition = {
    recipe_id: 'grid', version: 1, ttl: 0,
    metadata: { name: 'Grid', description: 'x', author: 'test', supported_platforms: [] },
    variables: {
      rows_in: { label: 'Rows', type: 'array', default: [] } as never,
      limit: { label: 'Max', type: 'number', default: 200 } as never,
      tree: { label: 'Tree', type: 'string', default: '' } as never,
    },
    prefetch_steps: [],
    steps: [{ id: 'rows', ingredient: 'seed', input: {} }],
    output: {
      render: [{
        type: 'table', source: 'step.rows', entity: 'receipt',
        fields: ['contract_ref', 'amount', 'method'], edit,
      } as never],
    },
  };
  const ingredientExecutor: IngredientExecutor = async () => ({ records: [] });
  const ctx = {
    recipe,
    stores: { vault: {}, config, context: {}, meta: {}, step: {} },
    ingredientExecutor,
    entityFields: () => FIELDS,
  } as never as ExecutionContext;
  const result = await executeRecipe(ctx);
  const section = (result.output?.render ?? [])
    .find((s: Record<string, unknown>) => s.type === 'table') as Record<string, any>;
  return section?.table_edit;
};

describe('resolving which columns are typeable', () => {
  it('honours an authored subset', async () => {
    const edit = await run({ into: 'rows_in', submit: 'Save', columns: ['amount'] });
    expect(edit?.editable).toEqual(['amount']);
  });

  it('CARRIES every shown column the owner may not type', async () => {
    // ⛔⛔ The row's identity. Without this the submission was the editable set
    // alone: a rent sheet sent amounts and no tenancy, every receipt was written
    // against nothing, and the store's refusal happened inside a `foreach` —
    // where a per-item failure never fails the run — so the month reported
    // success having collected nothing.
    const edit = await run({ into: 'rows_in', submit: 'Save', columns: ['amount'] });
    expect(edit?.carry).toEqual(['contract_ref', 'method']);
  });

  it('carries the identity when the author names NO editable subset', async () => {
    // ⛔ The case that decides where carry is computed FROM. With `columns`
    // omitted the whole non-identity set is typeable and `id` is exactly what
    // is left — so deriving carry from the authored list (absent here) instead
    // of from the editable set would submit rows that cannot say what they are.
    const recipe: RecipeDefinition = {
      recipe_id: 'allcarry', version: 1, ttl: 0,
      metadata: { name: 'All', description: 'x', author: 'test', supported_platforms: [] },
      variables: { rows_in: { label: 'Rows', type: 'array', default: [] } as never },
      prefetch_steps: [],
      steps: [{ id: 'rows', ingredient: 'seed', input: {} }],
      output: {
        render: [{
          type: 'table', source: 'step.rows', entity: 'receipt',
          edit: { into: 'rows_in', submit: 'Save' },
        } as never],
      },
    };
    const ctx = {
      recipe,
      stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
      ingredientExecutor: (async () => ({ records: [] })) as IngredientExecutor,
      entityFields: () => FIELDS,
    } as never as ExecutionContext;
    const section = ((await executeRecipe(ctx)).output?.render ?? [])
      .find((s: Record<string, unknown>) => s.type === 'table') as Record<string, any>;
    expect(section?.table_edit?.carry).toEqual(['id']);
  });

  it('carries nothing a column is not SHOWN by', async () => {
    // Carry is the shown-minus-editable set, not "every field of the entity" —
    // a column the table does not draw has no cell the owner could have seen,
    // so submitting it would send a value nobody was shown.
    const edit = await run({ into: 'rows_in', submit: 'Save', columns: ['amount'] });
    expect(edit?.carry).not.toContain('id');
  });

  it('excludes the identity even when the table shows EVERY declared field', async () => {
    // ⛔ The isolating case, and a mutant survived without it: with `fields`
    // named, `id` was never a candidate, so removing the id filter changed
    // nothing. Omitting `fields` shows every declared field — which is when
    // the filter is the only thing standing between a correction and a
    // re-parent.
    const recipe: RecipeDefinition = {
      recipe_id: 'all', version: 1, ttl: 0,
      metadata: { name: 'All', description: 'x', author: 'test', supported_platforms: [] },
      variables: { rows_in: { label: 'Rows', type: 'array', default: [] } as never },
      prefetch_steps: [],
      steps: [{ id: 'rows', ingredient: 'seed', input: {} }],
      output: {
        render: [{
          type: 'table', source: 'step.rows', entity: 'receipt',
          edit: { into: 'rows_in', submit: 'Save' },
        } as never],
      },
    };
    const ctx = {
      recipe,
      stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
      ingredientExecutor: (async () => ({ records: [] })) as IngredientExecutor,
      entityFields: () => FIELDS,
    } as never as ExecutionContext;
    const result = await executeRecipe(ctx);
    const section = (result.output?.render ?? [])
      .find((s: Record<string, unknown>) => s.type === 'table') as Record<string, any>;
    expect(section?.record_columns?.columns.map((c: { field: string }) => c.field))
      .toContain('id');
    expect(section?.table_edit?.editable).toEqual(['contract_ref', 'amount', 'method']);
    expect(section?.table_edit?.editable).not.toContain('id');
  });

  it('defaults to every shown column but the identity', async () => {
    // ⛔ An `id` is what the row IS. Typing it would make a correction
    // indistinguishable from a re-parent, so it is never editable — even
    // though it is a declared field of the entity.
    const edit = await run({ into: 'rows_in', submit: 'Save' });
    expect(edit?.editable).toEqual(['contract_ref', 'amount', 'method']);
    expect(edit?.editable).not.toContain('id');
  });

  it('resolves the EFFECTIVE value of each hidden variable', async () => {
    // ⛔ From the executed run's config, not echoed from a client. A submit is a
    // fresh run of the whole recipe, so without this the resubmission reads its
    // data under DEFAULTS the owner never chose.
    const edit = await run(
      { into: 'rows_in', submit: 'Save', hidden: ['limit'] },
      { limit: 10 },
    );
    expect(edit?.hidden).toEqual({ limit: 10 });
  });

  it('carries the DECLARED DEFAULT when the owner chose nothing', async () => {
    // ⚠ Not an omission. The engine seeds declared defaults into config before
    // output resolution, so a hidden variable always has an effective value —
    // and carrying it is exactly right: the resubmitted run must read its data
    // under the settings THIS run used, whether the owner picked them or the
    // recipe did. (I expected an empty object here and the engine was right.)
    expect((await run({ into: 'rows_in', submit: 'Save', hidden: ['limit'] }))?.hidden)
      .toEqual({ limit: 200 });
  });

  it('drops a hidden name the recipe does not declare', async () => {
    // The validator refuses this at install; the resolver drops it so a stale
    // descriptor cannot build a submission the SERVER then rejects wholesale —
    // which would look like a broken grid rather than a broken recipe.
    const edit = await run(
      { into: 'rows_in', submit: 'Save', hidden: ['limit', 'not_declared'] },
      { limit: 5, not_declared: 'x' },
    );
    expect(edit?.hidden).toEqual({ limit: 5 });
  });

  it('is an empty object when the section declares no hidden', async () => {
    // Present even when empty — a host tests the KEYS, and an absent object
    // would make "no run settings" indistinguishable from an old descriptor.
    expect((await run({ into: 'rows_in', submit: 'Save' }))?.hidden).toEqual({});
  });

  it('resolves config placeholders inside a stored-ref picker scope', async () => {
    const edit = await run(
      {
        into: 'rows_in', submit: 'Save', columns: ['amount'],
        scopes: { amount: { root_ref: 'tag/{{config.tree}}' } },
      },
      { tree: 'department' },
    );
    expect(edit?.scopes).toEqual({
      amount: { root_ref: 'tag/department' },
    });
  });

  it('drops a scope field whose embedded config value is unavailable', async () => {
    const edit = await run({
      into: 'rows_in', submit: 'Save', columns: ['amount'],
      scopes: { amount: { root_ref: 'tag/{{config.tree}}', static: 'yes' } },
    });
    expect(edit?.scopes).toEqual({ amount: { static: 'yes' } });
  });

  it('carries the proof and the row mode', async () => {
    const edit = await run({ into: 'rows_in', submit: 'Save', rows: 'fixed' });
    expect(edit).toMatchObject({ into: 'rows_in', submit: 'Save', rows: 'fixed' });
    expect(typeof edit?.recipe_hash).toBe('string');
    expect(Number.isInteger(edit?.section_index)).toBe(true);
  });

  it('defaults the row mode to composing', async () => {
    expect((await run({ into: 'rows_in', submit: 'Save' }))?.rows).toBe('add_remove');
  });

  it('is absent on a table that declared no edit', async () => {
    const recipe: RecipeDefinition = {
      recipe_id: 'ro', version: 1, ttl: 0,
      metadata: { name: 'RO', description: 'x', author: 'test', supported_platforms: [] },
      variables: {}, prefetch_steps: [],
      steps: [{ id: 'rows', ingredient: 'seed', input: {} }],
      output: { render: [{ type: 'table', source: 'step.rows', entity: 'receipt' } as never] },
    };
    const ctx = {
      recipe,
      stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
      ingredientExecutor: (async () => ({ records: [] })) as IngredientExecutor,
      entityFields: () => FIELDS,
    } as never as ExecutionContext;
    const result = await executeRecipe(ctx);
    const section = (result.output?.render ?? [])
      .find((s: Record<string, unknown>) => s.type === 'table') as Record<string, any>;
    expect(section?.table_edit).toBeUndefined();
  });

  it('takes the editable set from the AUTHOR when there is no entity', async () => {
    // The flexible shape: a hand-written table whose rows are a JOIN, or
    // anything else the receiving recipe knows how to read. No schema to
    // derive from, so the author names the typeable cells outright.
    const recipe: RecipeDefinition = {
      recipe_id: 'joined', version: 1, ttl: 0,
      metadata: { name: 'Joined', description: 'x', author: 'test', supported_platforms: [] },
      variables: { rows_in: { label: 'Rows', type: 'array', default: [] } as never },
      prefetch_steps: [],
      steps: [{ id: 'rows', ingredient: 'seed', input: {} }],
      output: {
        render: [{
          type: 'table', source: 'step.rows',
          edit: { into: 'rows_in', submit: 'Save', rows: 'fixed', columns: ['amount_received'] },
        } as never],
      },
    };
    const ctx = {
      recipe,
      stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
      ingredientExecutor: (async () => ({ records: [] })) as IngredientExecutor,
      entityFields: () => FIELDS,
    } as never as ExecutionContext;
    const result = await executeRecipe(ctx);
    const section = (result.output?.render ?? [])
      .find((s: Record<string, unknown>) => s.type === 'table') as Record<string, any>;
    // no entity -> no derived columns…
    expect(section?.record_columns).toBeUndefined();
    // …but the grid is still editable, on exactly what the author named.
    expect(section?.table_edit?.editable).toEqual(['amount_received']);
    expect(section?.table_edit?.into).toBe('rows_in');
  });
});
