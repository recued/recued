/** D-315 §5.2 — a recipe variable that is one of the owner's mail-fact
 *  templates, and the starter template it may bring.
 *
 *  The starter is checked as its author's server checked it before storing it:
 *  the template check, a kind built in, and nothing of the author's mail. What
 *  only that server can see — its own addresses, its contacts — is checked
 *  there. */

import { describe, expect, it } from 'vitest';

import { parseRecipe } from '../index.js';

const issuesFor = (
  variables: Record<string, unknown>,
  event_triggers?: unknown[],
): Array<{ code: string; path: string; message: string }> => {
  const parsed = parseRecipe({
    recipe_id: 'parcels',
    version: 1,
    ttl: 0,
    metadata: { name: 'Parcels', description: 'x', author: 'test', supported_platforms: [] },
    variables,
    prefetch_steps: [],
    steps: [{ id: 'x', transform: 'coalesce', values: ['{{meta.recipe_id}}'] }],
    output: { render: [{ type: 'summary', source: 'step.x' }] },
    ...(event_triggers !== undefined ? { event_triggers } : {}),
  });
  return (parsed.issues ?? [])
    .filter((issue) => issue.severity === 'error')
    .map((issue) => ({ code: issue.code, path: issue.path ?? '', message: issue.message }));
};

const starter = {
  name: 'Shop shipments',
  type: 'shipment',
  entrance: {
    conditions: [{ field: 'from', op: 'is', value: 'ship@shop.example' }],
    variables: ['tracking_number'],
  },
  rules: [
    { target: { variable: 'carrier' }, source: 'body', find: { kind: 'after_label', label: 'Carrier:' } },
    { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking number:' } },
  ],
  html: false,
  ai: { enabled: false },
};

describe('a mail_template variable (§5.2)', () => {
  it('takes one with a starter, and one without — the owner then picks or makes one', () => {
    expect(issuesFor({ template: { label: 'Template', type: 'mail_template', starter } })).toEqual([]);
    expect(issuesFor({ template: { label: 'Template', type: 'mail_template' } })).toEqual([]);
  });

  it('⛔ refuses a default: a template id is minted on the owner’s server', () => {
    expect(issuesFor({ template: { label: 'Template', type: 'mail_template', default: 'mtpl_1' } }))
      .toEqual([expect.objectContaining({ code: 'variable_hint_invalid', path: 'variables.template.default' })]);
  });

  it('⛔ refuses a starter on any other type: nothing would create it', () => {
    expect(issuesFor({ note: { label: 'Note', type: 'text', starter } }))
      .toEqual([expect.objectContaining({ code: 'variable_hint_invalid', path: 'variables.note.starter' })]);
  });

  it('⛔ refuses a starter the template check refuses, or of a kind an owner made', () => {
    expect(issuesFor({ template: { label: 'Template', type: 'mail_template', starter: { ...starter, rules: [] } } })
      .map((issue) => issue.message).join()).toMatch(/entrance variable 'tracking_number'/);
    expect(issuesFor({ template: { label: 'Template', type: 'mail_template', starter: { ...starter, type: 'custom_ticket' } } }))
      .toEqual([expect.objectContaining({ path: 'variables.template.starter', message: expect.stringMatching(/must be built in/) })]);
  });

  it('⛔ refuses a starter that holds its author’s mail: an address or a number baked into a rule', () => {
    const baked = {
      ...starter,
      rules: [
        starter.rules[0],
        { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'pattern', pattern: 'for alex@example.com: (\\S+)' } },
      ],
    };
    expect(issuesFor({ template: { label: 'Template', type: 'mail_template', starter: baked } }).map((issue) => issue.message))
      .toEqual(['rules[1].find.pattern: holds an email address']);
  });
});

describe('a recipe that only brings a template (§5.2, rulings 31, 45)', () => {
  const warnings = (variables: Record<string, unknown>): string[] =>
    (parseRecipe({
      recipe_id: 'parcels',
      version: 1,
      ttl: 0,
      metadata: { name: 'Parcels', description: 'x', author: 'test', supported_platforms: [] },
      variables,
      prefetch_steps: [],
      steps: [{ id: 'x', transform: 'coalesce', values: ['{{meta.recipe_id}}'] }],
      output: { render: [{ type: 'summary', source: 'step.x' }] },
    }).issues ?? [])
      .filter((issue) => issue.code === 'unused_variable')
      .map((issue) => issue.path ?? '');

  it('is not told its starter variable is unused: installing it creates the template, whatever its steps read', () => {
    expect(warnings({ template: { label: 'Template', type: 'mail_template', starter } })).toEqual([]);
  });

  it('is still told about a template variable with no starter, or any other, that nothing reads', () => {
    expect(warnings({
      template: { label: 'Template', type: 'mail_template' },
      note: { label: 'Note', type: 'text' },
    }).sort()).toEqual(['variables.note', 'variables.template']);
  });
});

describe('a fact trigger narrowed to the recipe’s template (§5.1)', () => {
  const template = { label: 'Template', type: 'mail_template', starter };

  it('names one of the recipe’s mail_template variables', () => {
    expect(issuesFor({ template }, [{ on: 'mail_fact.shipment', fields: ['state'], template_variable: 'template' }])).toEqual([]);
    // Any kind: the template decides which.
    expect(issuesFor({ template }, [{ on: 'mail_fact', template_variable: 'template' }])).toEqual([]);
  });

  it('⛔ refuses a name that is no mail_template variable: no template would ever be given, so no row made', () => {
    for (const variables of [{}, { template: { label: 'Template', type: 'text' } }]) {
      expect(issuesFor(variables, [{ on: 'mail_fact.shipment', template_variable: 'template' }])).toEqual([
        expect.objectContaining({
          code: 'event_trigger_entry_invalid',
          path: 'event_triggers[0].template_variable',
          message: "'template' is not one of this recipe's mail_template variables",
        }),
      ]);
    }
  });

  it('⛔ refuses a starter of another kind than the trigger watches: it would never wake', () => {
    expect(issuesFor({ template }, [{ on: 'mail_fact.purchase', template_variable: 'template' }])).toEqual([
      expect.objectContaining({
        path: 'event_triggers[0].template_variable',
        message: "'template' brings a shipment template, and this trigger watches purchase facts — it would never wake",
      }),
    ]);
  });
});
