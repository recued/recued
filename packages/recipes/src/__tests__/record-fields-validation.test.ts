/** Install-time shape of the `record_fields` block.
 *
 *  Same reasoning as the filter's validation: a misspelled `entity` or field
 *  key must be caught while the author is looking at the recipe, not surface at
 *  run time as a block that renders one fewer row than intended. What this
 *  CANNOT check is whether the entity exists — that needs the installed catalog
 *  manifest, which a recipe-body validator has no access to; the resolver
 *  reports that as `unresolved: 'no_schema'`.
 */
import { describe, expect, it } from 'vitest';
import { parseRecipe } from '../index.js';

const recipe = (section: Record<string, unknown>) => ({
  recipe_id: 'detail',
  version: 1,
  ttl: 0,
  metadata: { name: 'Detail', description: 'x', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'job', transform: 'coalesce', values: ['{{meta.recipe_id}}'] }],
  output: { render: [section] },
});

const issuesFor = (section: Record<string, unknown>): string[] => {
  const parsed = parseRecipe(recipe(section));
  return (parsed.issues ?? [])
    .filter((i) => i.severity === 'error')
    .map((i) => i.code);
};

const VALID = { type: 'record_fields', source: 'step.job', entity: 'job' };

describe('record_fields output section', () => {
  it('accepts the minimal form — `fields` omitted means every declared field', () => {
    expect(issuesFor(VALID)).toEqual([]);
  });

  it('accepts an explicit field selection', () => {
    expect(issuesFor({ ...VALID, fields: ['title', 'status'], label: 'Job' })).toEqual([]);
  });

  it('requires a non-empty entity', () => {
    expect(issuesFor({ type: 'record_fields', source: 'step.job' }))
      .toContain('record_fields_entity_invalid');
    expect(issuesFor({ ...VALID, entity: '   ' }))
      .toContain('record_fields_entity_invalid');
    expect(issuesFor({ ...VALID, entity: 7 }))
      .toContain('record_fields_entity_invalid');
  });

  it('rejects a malformed fields list', () => {
    expect(issuesFor({ ...VALID, fields: 'title' })).toContain('record_fields_shape');
    expect(issuesFor({ ...VALID, fields: ['title', ''] })).toContain('record_fields_shape');
    expect(issuesFor({ ...VALID, fields: ['title', 9] })).toContain('record_fields_shape');
  });

  it('rejects a duplicated field key', () => {
    expect(issuesFor({ ...VALID, fields: ['title', 'title'] }))
      .toContain('record_fields_duplicate');
  });

  it('still fences unknown section keys — `entity`/`fields` widen only this kind', () => {
    // The output_unknown_key fence is why `title` and `copy_button` never
    // shipped as silent no-ops; adding two keys to one kind must not open it.
    expect(issuesFor({ ...VALID, submit: 'Go' })).toContain('output_section_unknown_key');
    expect(issuesFor({ ...VALID, hidden: ['x'] })).toContain('output_section_unknown_key');
    // …and the filter's own keys stay fenced off the other kinds.
    expect(issuesFor({ type: 'summary', source: 'step.job', entity: 'job' }))
      .toContain('output_section_unknown_key');
  });

  it('requires a source that names a declared step, like every other kind', () => {
    expect(issuesFor({ type: 'record_fields', entity: 'job' }))
      .toContain('output_section_source_required');
    expect(issuesFor({ ...VALID, source: 'step.nope' }))
      .toContain('output_source_not_a_step');
  });
});

describe('table output section — the optional entity binding', () => {
  const TABLE = { type: 'table', source: 'step.job' };

  it('leaves a hand-written table alone — no entity, no new rules', () => {
    expect(issuesFor(TABLE)).toEqual([]);
    expect(issuesFor({ ...TABLE, label: 'Rows' })).toEqual([]);
  });

  it('accepts an entity, with or without a field selection', () => {
    expect(issuesFor({ ...TABLE, entity: 'job' })).toEqual([]);
    expect(issuesFor({ ...TABLE, entity: 'job', fields: ['title', 'status'] })).toEqual([]);
  });

  it('refuses `fields` without `entity` — columns of nothing', () => {
    // ⛔ Otherwise it renders an empty table rather than saying so: `fields`
    // names keys of an entity schema, and without `entity` there is no schema
    // to name them in. A hand-written table carries its columns on the
    // `to_table` step, never here.
    expect(issuesFor({ ...TABLE, fields: ['title'] }))
      .toContain('table_fields_without_entity');
  });

  it('refuses an empty entity and a malformed field list', () => {
    expect(issuesFor({ ...TABLE, entity: '   ' })).toContain('table_entity_invalid');
    expect(issuesFor({ ...TABLE, entity: 'job', fields: 'title' })).toContain('table_shape');
    expect(issuesFor({ ...TABLE, entity: 'job', fields: [''] })).toContain('table_shape');
  });

  it('refuses one field listed twice — a column cannot sit at two positions', () => {
    expect(issuesFor({ ...TABLE, entity: 'job', fields: ['title', 'title'] }))
      .toContain('table_duplicate');
  });

  it('still fences an unknown key on a table', () => {
    expect(issuesFor({ ...TABLE, entity: 'job', columns: [] }))
      .toContain('output_section_unknown_key');
  });
});

describe('record_ref variable — the picker must know what it searches', () => {
  const withVars = (variables: Record<string, unknown>) => {
    const parsed = parseRecipe({
      recipe_id: 'form', version: 1, ttl: 0,
      metadata: { name: 'Form', description: 'x', author: 'test', supported_platforms: [] },
      variables,
      prefetch_steps: [],
      steps: [{ id: 'x', transform: 'coalesce', values: ['{{meta.recipe_id}}'] }],
      output: { render: [{ type: 'summary', source: 'step.x' }] },
    });
    return (parsed.issues ?? []).filter((i) => i.severity === 'error').map((i) => i.code);
  };

  it('accepts a record_ref that names its entity', () => {
    expect(withVars({ customer_id: { label: 'Customer', type: 'record_ref', entity: 'customer' } }))
      .toEqual([]);
  });

  it('refuses a record_ref with no entity — a picker over nothing', () => {
    // ⛔ It would render as the raw-id text box the type exists to replace, and
    // look like it worked. Same reasoning as the unknown-key fence: silence is
    // the worst failure available.
    expect(withVars({ customer_id: { label: 'Customer', type: 'record_ref' } }))
      .toContain('variable_hint_invalid');
    expect(withVars({ customer_id: { label: 'Customer', type: 'record_ref', entity: '  ' } }))
      .toContain('variable_hint_invalid');
  });

  it('refuses an entity on any other type — a binding nothing honours', () => {
    expect(withVars({ name: { label: 'Name', type: 'text', entity: 'customer' } }))
      .toContain('variable_hint_invalid');
  });

  it('still fences a key that is not on ValueHint at all', () => {
    expect(withVars({ customer_id: { label: 'C', type: 'record_ref', entity: 'customer', kind: 'x' } }))
      .toContain('variable_hint_unknown_key');
  });
});

describe('table.edit — the repeating group', () => {
  const recipeWith = (section: Record<string, unknown>, variables: Record<string, unknown>) => {
    const parsed = parseRecipe({
      recipe_id: 'lines', version: 1, ttl: 0,
      metadata: { name: 'Lines', description: 'x', author: 'test', supported_platforms: [] },
      variables,
      prefetch_steps: [],
      steps: [{ id: 'rows', transform: 'coalesce', values: ['{{meta.recipe_id}}'] }],
      output: { render: [section] },
    });
    return (parsed.issues ?? []).filter((i) => i.severity === 'error').map((i) => i.code);
  };
  const EDIT = { type: 'table', source: 'step.rows', entity: 'order_item',
                 edit: { into: 'lines', submit: 'Save lines' } };
  const VARS = { lines: { label: 'Lines', type: 'array', default: [] } };

  it('accepts an editable grid whose target variable is declared', () => {
    expect(recipeWith(EDIT, VARS)).toEqual([]);
    expect(recipeWith({ ...EDIT, edit: { ...EDIT.edit, rows: 'fixed' } }, VARS)).toEqual([]);
  });

  it('refuses `into` naming a variable the recipe does not declare', () => {
    // ⛔ The declaration IS the argument boundary — the server bounds the
    // submission to exactly that key, so an undeclared one could never be
    // accepted. Refusing at authoring time beats a grid that submits and 400s.
    expect(recipeWith(EDIT, {})).toContain('table_edit_into_undeclared');
  });

  it('ACCEPTS an editable grid with no entity, when it names its columns', () => {
    // ⛔ An entity is a convenience, not a requirement. The grid collects
    // values and the receiving recipe decides what they mean — its rows need
    // not be one entity's shape. A collection sheet's row is a JOIN plus a
    // blank column for a human, which is exactly what someone types into.
    const { entity, ...noEntity } = EDIT;
    expect(recipeWith({ ...noEntity, edit: { into: 'lines', submit: 'Go', columns: ['amount'] } }, VARS))
      .toEqual([]);
  });

  it('refuses a grid with neither an entity nor named columns', () => {
    // Nothing could derive which cells are typeable, so it would render
    // read-only and look broken rather than say so.
    const { entity, ...noEntity } = EDIT;
    expect(recipeWith(noEntity, VARS)).toContain('table_edit_columns_required');
    expect(recipeWith({ ...noEntity, edit: { into: 'lines', submit: 'Go', columns: [] } }, VARS))
      .toContain('table_edit_columns_required');
  });

  it('refuses a malformed edit spec', () => {
    expect(recipeWith({ ...EDIT, edit: { submit: 'Go' } }, VARS)).toContain('table_edit_shape');
    expect(recipeWith({ ...EDIT, edit: { into: 'lines' } }, VARS)).toContain('table_edit_shape');
    expect(recipeWith({ ...EDIT, edit: { into: 'lines', submit: 'Go', rows: 'maybe' } }, VARS))
      .toContain('table_edit_shape');
    expect(recipeWith({ ...EDIT, edit: { into: 'lines', submit: 'Go', extra: 1 } }, VARS))
      .toContain('table_edit_shape');
  });

  it("refuses a 'fixed' grid with no entity — it could never name its rows", () => {
    // ⛔⛔ The one combination that cannot work, refused at authoring time
    // because its runtime failure is silent: with no entity nothing resolves
    // the shown columns, so nothing carries a row's identity, and the writes
    // land inside a `foreach` where a per-item refusal never fails the run.
    // The recipe reports success having written nothing.
    const noEntity2 = { type: 'table', source: 'step.rows' };
    expect(recipeWith({
      ...noEntity2,
      edit: { into: 'lines', submit: 'Go', rows: 'fixed', columns: ['amount'] },
    }, VARS)).toContain('table_edit_fixed_without_entity');
  });

  it('still allows a no-entity grid that COMPOSES new rows', () => {
    // ⛔ The permitted case — without it the rule is a blanket refusal rather
    // than a guard. A new row has no identity to carry yet, so an ad-hoc
    // composition grid needs no entity.
    expect(recipeWith({
      type: 'table', source: 'step.rows',
      edit: { into: 'lines', submit: 'Go', rows: 'add_remove', columns: ['amount'] },
    }, VARS)).toEqual([]);
  });

  it('accepts an AUTHORED column beside the schema ones', () => {
    // The jsf shape: build on the assigned model, extend it with fields that
    // carry their own label and type. A rent sheet's row is the entity plus a
    // join or two, and before this the whole table had to give up its entity —
    // and every derived label and alignment — to show them.
    expect(recipeWith({
      ...EDIT,
      fields: ['description', { field: 'rent_due', label: 'Rent due', kind: 'decimal' }],
      edit: { into: 'lines', submit: 'Go', columns: ['description'] },
    }, VARS)).toEqual([]);
  });

  it('counts an authored column as SHOWN, so it may be typed into', () => {
    // ⛔ The collection-sheet case: the blank column a human fills is exactly
    // the appended one. Fencing it out of `edit.columns` would make the whole
    // extension useless for the surface that needed it.
    expect(recipeWith({
      ...EDIT,
      fields: ['description', { field: 'amount_received', label: 'Received', kind: 'decimal' }],
      edit: { into: 'lines', submit: 'Go', columns: ['amount_received'] },
    }, VARS)).toEqual([]);
  });

  it('refuses an authored column with no label', () => {
    // ⛔ Required, and not derived. There is no schema to take one from, and
    // title-casing the key silently is how a joined column ends up captioned by
    // its variable name.
    expect(recipeWith({ ...EDIT, fields: [{ field: 'rent_due' }] }, VARS))
      .toContain('table_shape');
  });

  it('refuses a picker with nothing to pick, and options with no picker', () => {
    // Each renders a control the owner cannot use, or values nothing reads.
    expect(recipeWith({
      ...EDIT, fields: [{ field: 'method', label: 'Paid how?', control: 'select' }],
    }, VARS)).toContain('table_shape');
    expect(recipeWith({
      ...EDIT, fields: [{ field: 'method', label: 'Paid how?', options: ['bank'] }],
    }, VARS)).toContain('table_shape');
  });

  it('refuses an unknown control and an unknown key on an authored column', () => {
    expect(recipeWith({
      ...EDIT, fields: [{ field: 'method', label: 'M', control: 'slider', options: ['a'] }],
    }, VARS)).toContain('table_shape');
    expect(recipeWith({
      ...EDIT, fields: [{ field: 'method', label: 'M', placeholder: 'type here' }],
    }, VARS)).toContain('table_shape');
  });

  it('still catches a column listed twice, however it is spelled', () => {
    // ⛔ An override and the string it overrides are ONE column — listing both
    // would draw the field at two positions, which is the duplicate this rule
    // has always refused.
    expect(recipeWith({
      ...EDIT, fields: ['amount', { field: 'amount', label: 'Received' }],
    }, VARS)).toContain('table_duplicate');
  });

  it('accepts hidden run settings that the recipe declares', () => {
    // ⛔ A submit is a fresh run with only what the grid sends, so without this
    // every other variable falls to its DEFAULT — the recipe re-reads its data
    // under settings the owner never chose.
    expect(recipeWith({ ...EDIT, edit: { ...EDIT.edit, hidden: ['limit'] } },
      { ...VARS, limit: { label: 'Max', type: 'number', default: 200 } })).toEqual([]);
  });

  it('refuses a hidden name the recipe does not declare', () => {
    // Same rule `into` gets, for the same reason: the declaration IS the
    // argument boundary the server bounds the submission against, so an
    // undeclared key could only ever be rejected at submit time.
    expect(recipeWith({ ...EDIT, edit: { ...EDIT.edit, hidden: ['nope'] } }, VARS))
      .toContain('table_edit_hidden_undeclared');
  });

  it('refuses hidden naming the ROWS variable, or naming one twice', () => {
    // ⛔ The rows key is not a run setting. Listing it would send a snapshot of
    // the rows beside the rows themselves, and which one wins is an ordering
    // accident.
    expect(recipeWith({ ...EDIT, edit: { ...EDIT.edit, hidden: ['lines'] } }, VARS))
      .toContain('table_edit_shape');
    expect(recipeWith({ ...EDIT, edit: { ...EDIT.edit, hidden: ['limit', 'limit'] } },
      { ...VARS, limit: { label: 'Max', type: 'number', default: 1 } }))
      .toContain('table_edit_shape');
  });

  it('refuses a malformed hidden list', () => {
    expect(recipeWith({ ...EDIT, edit: { ...EDIT.edit, hidden: 'limit' } }, VARS))
      .toContain('table_edit_shape');
    expect(recipeWith({ ...EDIT, edit: { ...EDIT.edit, hidden: [''] } }, VARS))
      .toContain('table_edit_shape');
  });

  it('refuses a typeable column the table never shows', () => {
    // ⛔ A cell with nowhere to appear. An author widening the grid would see
    // nothing happen and have no idea why — the silent case the key fences in
    // this file exist for.
    expect(recipeWith({
      ...EDIT, fields: ['description'],
      edit: { into: 'lines', submit: 'Go', columns: ['description', 'quantity'] },
    }, VARS)).toContain('table_edit_column_unshown');
  });

  it('accepts an editable subset drawn from the shown columns', () => {
    expect(recipeWith({
      ...EDIT, fields: ['description', 'quantity'],
      edit: { into: 'lines', submit: 'Go', columns: ['quantity'] },
    }, VARS)).toEqual([]);
  });

  it('leaves a read-only table alone', () => {
    expect(recipeWith({ type: 'table', source: 'step.rows', entity: 'order_item' }, VARS))
      .toEqual([]);
  });
});

describe('⛔ a record_ref scope is validated where the author can see it', () => {
  const hint = (h: Record<string, unknown>) =>
    parseRecipe({
      recipe_id: 'p', version: 1, ttl: 0, metadata: { name: 'p' },
      variables: { tag: h }, prefetch_steps: [],
      steps: [{ id: 's', transform: 'trim', input: '{{config.tag}}' }],
      output: { render: [] },
    } as never).issues.filter(i => i.severity === 'error').map(i => i.code);

  it('accepts a scoped record_ref', () => {
    // ⚠ Scoped to the HINT code — the stub recipe is deliberately minimal and
    // carries unrelated metadata issues, which are not this test's subject.
    expect(hint({ label: 'Person', type: 'record_ref', entity: 'tag',
                  entity_filter: { root_ref: 'tag/org' } }))
      .not.toContain('variable_hint_invalid');
  });

  it('⛔ refuses a scope on anything that is not a record_ref', () => {
    // A filter nobody applies reads as a narrowed picker in the recipe and
    // offers everything at the keyboard.
    expect(hint({ label: 'X', type: 'string', entity_filter: { root_ref: 'tag/org' } }))
      .toContain('variable_hint_invalid');
  });

  it('⛔ refuses an empty scope, and a non-string value', () => {
    expect(hint({ label: 'P', type: 'record_ref', entity: 'tag', entity_filter: {} }))
      .toContain('variable_hint_invalid');
    // A number compared against a stored string is an equality that never
    // matches — a picker that silently offers NOTHING rather than everything.
    expect(hint({ label: 'P', type: 'record_ref', entity: 'tag',
                  entity_filter: { depth: 1 } as never })).toContain('variable_hint_invalid');
  });

  it('⚠ an unscoped record_ref is still fine — scope is optional', () => {
    expect(hint({ label: 'P', type: 'record_ref', entity: 'tag' }))
      .not.toContain('variable_hint_invalid');
  });
});
