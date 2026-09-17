/** `table.group_by` end to end — recipe declaration → engine → rendered markup.
 *
 *  ⛔⛔ WHY THIS FILE EXISTS, AND WHY IT IS HERE. `group_by` shipped with two
 *  suites either side of one boundary and nothing across it: the recipes suite
 *  proves the validator ACCEPTS the declaration, the renderer suite proves
 *  `renderTableBlock` GROUPS when handed a field — and neither runs the engine
 *  step between them, where `execute.ts` copies the section's `group_by` onto
 *  the block and `renderSection` threads it into the call. Both halves were
 *  green while the join had only a typecheck, which is the shape this codebase
 *  keeps finding in other people's code (a label assigned by nothing, a report
 *  builder called by nothing) and had just reproduced in its own.
 *
 *  ⇒ `backend/server` is the only package that depends on BOTH engine and
 *  renderer, so it is the only place the whole chain is reachable. A test that
 *  hand-built the section would prove the renderer again and the carry never.
 */
import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { executeRecipe } from '@recued/engine';
import type { ExecutionContext, IngredientExecutor } from '@recued/engine';
import { renderSection } from '@recued/renderer';

const ROWS = [
  { name: 'alpha', status: 'open' },
  { name: 'beta', status: 'done' },
  { name: 'gamma', status: 'open' },
];

/** Run a recipe whose ONLY output is a table, and hand back the assembled
 *  section exactly as the engine produced it. */
const assembleSection = async (
  extra: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> => {
  const recipe: RecipeDefinition = {
    recipe_id: 'grouped', version: 1, ttl: 0,
    metadata: { name: 'Grouped', description: 'x', author: 'test', supported_platforms: [] },
    variables: {},
    prefetch_steps: [],
    steps: [{ id: 'rows', ingredient: 'seed', input: {} }],
    output: {
      render: [{ type: 'table', source: 'step.rows', ...extra } as never],
    },
  };
  const ingredientExecutor: IngredientExecutor = async () => ({
    columns: [{ field: 'name', label: 'Name' }, { field: 'status', label: 'Status' }],
    rows: ROWS,
  });
  const ctx = {
    recipe,
    stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
    ingredientExecutor,
  } as never as ExecutionContext;
  const result = await executeRecipe(ctx);
  return (result.output?.render ?? [])
    .find((s: Record<string, unknown>) => s.type === 'table') as Record<string, unknown> | undefined;
};

describe('table.group_by — the join from recipe to markup', () => {
  it('carries the authored group_by onto the assembled section', async () => {
    // The half that had only a typecheck: `execute.ts` must COPY the field. A
    // narrowing mistake or a dropped spread here is invisible to both existing
    // suites and fatal to the feature.
    const section = await assembleSection({ group_by: 'status' });
    expect(section).toBeDefined();
    expect(section?.group_by).toBe('status');
  });

  it('omits group_by from the section when the recipe did not declare it', async () => {
    // A negative that names its cause: absent, not empty-string, not null — the
    // renderer's ungrouped path is chosen by `=== undefined`.
    const section = await assembleSection({});
    expect(section).toBeDefined();
    expect(section).not.toHaveProperty('group_by');
  });

  it('renders grouped markup from the assembled section, without hand-building it', async () => {
    // ⛔ THE ACTUAL JOIN. The section handed to `renderSection` is the engine's
    // own output, so this fails if the engine drops the field OR if the
    // renderer dispatch stops threading it — the two failures a hand-built
    // block cannot tell apart from success.
    const section = await assembleSection({ group_by: 'status' });
    const html = renderSection({
      kind: 'table',
      data: section?.data,
      group_by: section?.group_by as string | undefined,
    });
    expect(html).toContain('data-group-by="status"');
    expect(html).toContain('data-group="open"');
    expect(html).toContain('data-group="done"');
    expect((html.match(/class="group-row"/g) ?? []).length).toBe(2);
    // every row survived the trip
    for (const row of ROWS) expect(html).toContain(`>${row.name}<`);
  });

  it('renders an ordinary table when the recipe declared no grouping', async () => {
    const section = await assembleSection({});
    const html = renderSection({
      kind: 'table',
      data: section?.data,
      group_by: section?.group_by as string | undefined,
    });
    expect(html).not.toContain('group-row');
    expect(html).not.toContain('data-group-by');
    for (const row of ROWS) expect(html).toContain(`>${row.name}<`);
  });
});
