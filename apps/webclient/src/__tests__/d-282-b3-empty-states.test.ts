/** D-282 B3 — an empty list and a block that cannot be drawn are different things.
 *
 *  ⛔⛔ THEY USED TO PRODUCE THE SAME SENTENCE. The owner panel answered "No rows
 *  returned." both when a table had no COLUMNS — the recipe declared none and no entity
 *  schema supplied any, which is a broken block — and when it simply had no ROWS, which
 *  for a business app is a first-run moment. A reader cannot tell those apart, and
 *  neither can the author debugging it.
 *
 *  🔑 THE GOOD PHRASING WAS ALREADY IN THIS FILE, forty lines below, applied to exactly
 *  one case: a COMPOSING grid says "No rows yet. Add a row to get started." The empty
 *  state was not missing, it was unreached.
 *
 *  ⚠ THE ENTITY IS NOT PLURALISED. `building` → "buildings" is easy; `company` →
 *  "companys" and `person` → "persons" are wrong, and the keys belong to the pack author,
 *  not to a vocabulary this surface controls. "records" is the plural that works after
 *  any noun. */

import { describe, expect, it } from 'vitest';

import {
  createResultActionRegistry,
  renderRecipeResultPanel,
  type RecipesResultPanelSnapshot,
} from '../recipes/recipe-result-panel.js';

const registry = () =>
  createResultActionRegistry([], new Map(), false, new Set(), new Map(), new Set());

const panelWith = (section: Record<string, unknown>): RecipesResultPanelSnapshot => ({
  route_recipe_id: 'list-things',
  source_recipe_id: null,
  render_recipe_id: 'list-things',
  origin: 'run',
  result: {
    recipe_id: 'list-things', recipe_hash: 'h', success: true, duration_ms: 1,
    steps: [], errors: [],
    output: { render: [section], sidebar: [] },
  },
} as unknown as RecipesResultPanelSnapshot);

const render = (section: Record<string, unknown>): string =>
  renderRecipeResultPanel(panelWith(section), [], registry(), new Map(), new Map(), false);

describe('the owner panel tells empty apart from broken', () => {
  it('says a table has no columns to draw, rather than that it returned no rows', () => {
    const html = render({
      type: 'table', source: 'step.t', data: { columns: [], rows: [] },
    });
    expect(html).toContain('no columns to draw');
    expect(html).not.toContain('Nothing here yet');
    expect(html).not.toContain('records yet');
  });

  it('says a list is empty, and does not blame the block', () => {
    const html = render({
      type: 'table', source: 'step.t', data: { columns: [{ field: 'id', label: 'Id' }], rows: [] },
    });
    expect(html).toContain('Nothing here yet.');
    expect(html).not.toContain('no columns to draw');
  });

  /** The entity is what turns "Nothing here yet." into something a reader can act on. */
  it('names the entity when the block declared one', () => {
    const html = render({
      type: 'table',
      source: 'step.t',
      data: { columns: [], rows: [] },
      record_columns: {
        entity: 'item_price',
        columns: [{ field: 'id', label: 'Id', kind: 'string' }],
      },
    });
    expect(html).toContain('No item price records yet.');
    expect(html).not.toContain('no columns to draw');
  });

  /** D-292 — the third case that sat inside the first: the producing step was SKIPPED
   *  (`skip_when`), so the section arrives with `data: null`. The author asked for the
   *  block to be absent; it used to be drawn as a broken one on every clean import. */
  it('draws nothing for a table whose step was skipped — not a broken-block note', () => {
    const skipped = render({ type: 'table', source: 'step.refused', data: null });
    expect(skipped).not.toContain('no columns to draw');
    expect(skipped).not.toContain('recipes-result-card');
    // …while a skipped step feeding an ENTITY-derived table is still the empty
    // state that table owns (its columns come from the schema, not from the step).
    const entityTable = render({
      type: 'table', source: 'step.t', data: null,
      record_columns: { entity: 'building', columns: [{ field: 'id', label: 'Id', kind: 'string' }] },
    });
    expect(entityTable).toContain('No building records yet.');
  });

  /** ⚠ The negative control. Without it the two assertions above would both pass on a
   *  panel that rendered nothing at all. */
  it('still draws a table that has both columns and rows', () => {
    const html = render({
      type: 'table',
      source: 'step.t',
      data: { columns: [{ field: 'id', label: 'Id' }], rows: [{ id: 'A-1' }] },
    });
    expect(html).toContain('A-1');
    expect(html).not.toContain('Nothing here yet');
    expect(html).not.toContain('no columns to draw');
  });
});
