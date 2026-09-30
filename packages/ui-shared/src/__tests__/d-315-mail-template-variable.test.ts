/** D-315 §5.2 — a recipe setting that is one of the owner's mail templates:
 *  the row the Settings editor draws, what its list offers, what its buttons
 *  may do, and that no run or dish is asked for one. The DOM wiring is checked
 *  in Chrome; what it decides is here. */

import { describe, expect, it } from 'vitest';

import type { ServerRecipeListEntry, VariableDefault } from '@recued/contracts';

import {
  mailTemplateActions,
  mailTemplateOptions,
  type MailTemplateChoice,
} from '../mail-template-variable.js';
import { initialRunModalState } from '../run-modal/model.js';
import { renderRunModal } from '../run-modal/render.js';
import {
  isInvocationVariable,
  isRecipeSetting,
  MAIL_TEMPLATE_TYPE_ATTR,
  MAIL_TEMPLATE_VARIABLE_ATTR,
  renderVariableWidget,
  toWidgetShape,
  validateWidgetValue,
} from '../variable-widgets.js';

const setting = {
  label: 'Template',
  type: 'mail_template',
  starter: { name: 'Shop parcels', type: 'shipment', entrance: { conditions: [], variables: [] }, rules: [], html: false, ai: { enabled: false } },
} as unknown as VariableDefault;

const choices: MailTemplateChoice[] = [
  { template_id: 'mtpl_b', name: 'UPS', type: 'shipment', active: false },
  { template_id: 'mtpl_a', name: 'Shop parcels', type: 'shipment', active: true, recipe: 'Shop parcels' },
  { template_id: 'mtpl_c', name: 'Receipts', type: 'purchase', active: true },
  { template_id: 'mtpl_d', name: 'Amazon', type: 'shipment', active: true },
];

describe('the Settings row', () => {
  it('is a list holding the saved id until the owner’s templates load — never a lost value', () => {
    const html = renderVariableWidget(toWidgetShape('template', setting, 'mtpl_a'), { mailTemplatePicker: true });
    expect(html).toContain(`${MAIL_TEMPLATE_VARIABLE_ATTR}="template"`);
    expect(html).toContain(`${MAIL_TEMPLATE_TYPE_ATTR}="shipment"`);
    expect(html).toMatch(/<select[^>]*data-var-key="template"[^>]*data-var-type="mail_template"/);
    expect(html).toContain('<option value="mtpl_a" selected>mtpl_a</option>');
    expect(html).toContain('Open it');
    expect(html).toContain('Duplicate to edit');
    // With nothing saved it asks.
    expect(renderVariableWidget(toWidgetShape('template', setting), { mailTemplatePicker: true }))
      .toContain('<option value="" selected>Choose a template</option>');
  });

  it('is a text box where the host has no templates to offer', () => {
    const html = renderVariableWidget(toWidgetShape('template', setting, 'mtpl_a'));
    expect(html).toMatch(/<input[^>]*data-var-type="mail_template"/);
    expect(html).not.toContain('<select');
  });

  it('is required to be chosen, unless optional', () => {
    const shape = toWidgetShape('template', setting);
    expect(validateWidgetValue(shape, '')).toBe('Choose a template');
    expect(validateWidgetValue(shape, 'mtpl_a')).toBeNull();
    expect(validateWidgetValue({ ...shape, optional: true }, '')).toBeNull();
  });
});

describe('what the list offers', () => {
  it('the owner’s templates of its kind, the ones on first, then by name, each saying where it came from', () => {
    expect(mailTemplateOptions(choices, { type: 'shipment', value: 'mtpl_a' })).toEqual([
      { value: 'mtpl_d', label: 'Amazon — yours', selected: false },
      { value: 'mtpl_a', label: 'Shop parcels — from the recipe Shop parcels', selected: true },
      { value: 'mtpl_b', label: 'UPS — yours (off)', selected: false },
    ]);
    // A setting whose recipe brings no starter names no kind: all of them.
    expect(mailTemplateOptions(choices, { type: '', value: '' }).map((option) => option.value))
      .toEqual(['', 'mtpl_d', 'mtpl_c', 'mtpl_a', 'mtpl_b']);
  });

  it('⛔ keeps a held template it would not offer, saying why — a save must not drop it', () => {
    expect(mailTemplateOptions(choices, { type: 'shipment', value: 'mtpl_gone' })[0])
      .toEqual({ value: 'mtpl_gone', label: 'Missing template — mtpl_gone', selected: true });
    expect(mailTemplateOptions(choices, { type: 'shipment', value: 'mtpl_c' })[0])
      .toEqual({ value: 'mtpl_c', label: 'Receipts — reads another kind of email', selected: true });
  });

  it('opens one that exists, and duplicates only one a recipe brought', () => {
    const both = { open: () => undefined, duplicate: async () => choices[1]! };
    expect(mailTemplateActions(choices, 'mtpl_a', both)).toEqual({ open: true, duplicate: true });
    expect(mailTemplateActions(choices, 'mtpl_d', both)).toEqual({ open: true, duplicate: false });
    expect(mailTemplateActions(choices, 'mtpl_gone', both)).toEqual({ open: false, duplicate: false });
    expect(mailTemplateActions(choices, 'mtpl_a', {})).toEqual({ open: false, duplicate: false });
  });
});

describe('a setting, never a question a run asks — and each dish’s (D-319)', () => {
  it('is not asked for on a run', () => {
    expect(isRecipeSetting(setting)).toBe(true);
    expect(isInvocationVariable(setting)).toBe(false);
    const note = { label: 'Note', type: 'text' } as VariableDefault;
    expect(isInvocationVariable(note)).toBe(true);
  });

  it('the run dialog asks a run its questions only; a schedule or a trigger has no settings of its own', () => {
    const entry = {
      recipe_id: 'shop-parcels',
      publisher_id: 'recued-core',
      version: 1,
      recipe_hash: 'h',
      recipe: {
        recipe_id: 'shop-parcels',
        version: 1,
        metadata: { name: 'Shop parcels', description: 'x', author: 'test', supported_platforms: [] },
        variables: { template: setting, note: { label: 'Note', type: 'text' } },
        steps: [],
        output: { sidebar: [] },
      },
      source: 'pair-sync',
      installed_at: 1,
    } as unknown as ServerRecipeListEntry;
    const caps = { canExecute: true, canSchedule: true, canTrigger: true };
    const run = renderRunModal({ ...initialRunModalState('run', '0 9 * * *'), schedules: [], triggers: [] } as never, entry, caps);
    expect(run).toContain('data-var-key="note"');
    expect(run).not.toContain('data-var-key="template"');
    for (const tab of ['schedule', 'trigger'] as const) {
      const state = { ...initialRunModalState(tab, '0 9 * * *'), schedules: [], triggers: [] };
      expect(renderRunModal(state as never, entry, caps), tab).not.toContain('data-var-key=');
    }
  });
});
