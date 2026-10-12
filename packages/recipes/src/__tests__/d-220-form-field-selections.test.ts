import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { validateRecipe } from '../validate.js';

const list = { id: 'pending', op: 'core.data.form-response.list', args: { endpoint_id: 'door' } };
const get = { id: 'accepted', op: 'core.data.form-response.get', args: { submission_id: 's' } };
const declaration = [{ name: 'full_name', type: 'text', required: false }];
const recipe = (steps: unknown[], fields: unknown = declaration): RecipeDefinition => ({
  recipe_id: 'form-field-selection', version: 1, ttl: 60,
  metadata: {
    name: 'Form field selection', description: 'Exports only the fields selected by the owner.',
    author: 'recued-core', supported_platforms: [], tags: ['test'],
    ...(fields === undefined ? {} : { requires_form_fields: fields }),
  },
  variables: {}, prefetch_steps: [], steps, output: { render: [] },
} as unknown as RecipeDefinition);
const findings = (value: RecipeDefinition) => validateRecipe(value).issues.filter((issue) => issue.code.startsWith('requires_form_fields'));
const csv = (columns: unknown) => [list, { id: 'csv', transform: 'to_csv', array: '{{step.pending.records}}', columns }];
const pick = (fields: unknown) => [get,
  { id: 'picked', transform: 'pick', source: '{{step.accepted.record.values}}', fields },
  { id: 'body', transform: 'json_stringify', input: '{{step.picked}}' },
];

describe('selected form fields at recipe admission', () => {
  it.each([
    csv(['values.full_name']),
    csv([{ field: 'values.full_name', label: 'Name' }]),
    pick(['full_name']),
  ].map((steps) => [steps]))('admits a declared selection without unread warnings: %j', (steps) => {
    const value = recipe(steps);
    expect(validateRecipe(value).valid).toBe(true);
    expect(findings(value)).toEqual([]);
    const missing = recipe(steps, []);
    expect(validateRecipe(missing).valid).toBe(false);
    expect(findings(missing)).toEqual([expect.objectContaining({ code: 'requires_form_fields_undeclared', severity: 'error', message: expect.stringContaining('full_name') })]);
  });

  it.each([undefined, [], [null, {}, { field: '' }], ['values'], ['{{config.field}}']].map((columns) => [columns]))(
    'rejects automatic, whole-cell, and unresolved CSV selections: %j', (columns) => {
      const value = recipe(csv(columns));
      expect(validateRecipe(value).valid).toBe(false);
      expect(findings(value)).toContainEqual(expect.objectContaining({ code: 'requires_form_fields_whole_object_read', severity: 'error' }));
    },
  );

  it.each([undefined, '{{config.fields}}', ['{{config.field}}']].map((fields) => [fields]))(
    'rejects passthrough and unresolved picks: %j', (fields) => {
      expect(findings(recipe(pick(fields)))).toContainEqual(expect.objectContaining({ code: 'requires_form_fields_whole_object_read', severity: 'error' }));
    },
  );

  it('admits metadata-only exports and empty answer projections with an empty declaration', () => {
    for (const steps of [csv(['submission_id', '_id']), pick([]), [get, {
      id: 'picked', transform: 'pick', source: '{{step.accepted.record}}', fields: ['submission_id'],
    }]]) {
      const value = recipe(steps, []);
      expect(validateRecipe(value).valid).toBe(true);
      expect(findings(value)).toEqual([]);
    }
  });

  it('refuses a pick of values even with every known field declared', () => {
    const value = recipe([get,
      { id: 'picked', transform: 'pick', source: '{{step.accepted.record}}', fields: ['values'] },
      { id: 'csv', transform: 'to_csv', array: ['{{step.picked}}'], columns: ['values.full_name'] },
    ]);
    expect(findings(value)).toEqual([expect.objectContaining({ code: 'requires_form_fields_whole_object_read', severity: 'error' })]);
  });

  it('preserves advisory behavior for recipes without a field declaration', () => {
    // Explicit undefined cannot use the helper's default declaration.
    const undeclared = (steps: unknown[]) => {
      const value = recipe(steps);
      delete (value.metadata as unknown as Record<string, unknown>).requires_form_fields;
      return value;
    };
    expect(findings(undeclared(csv(['values.full_name'])))).toEqual([
      expect.objectContaining({ code: 'requires_form_fields_absent', severity: 'info' }),
    ]);
    expect(findings(undeclared(csv([])))).toEqual([
      expect.objectContaining({ code: 'requires_form_fields_absent', severity: 'warn' }),
    ]);
  });
});
