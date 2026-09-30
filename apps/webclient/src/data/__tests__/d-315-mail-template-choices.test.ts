/** D-315 §5.2 — the owner's templates as a recipe's Settings offer them. */

import { describe, expect, it, vi } from 'vitest';

import type { MailTemplate } from '@recued/contracts';

import { createMailTemplateVariableCallers, mailTemplateAddress } from '../mail-template-choices.js';

const template = (over: Partial<MailTemplate> = {}): MailTemplate => ({
  template_id: 'mtpl_1',
  name: 'Shop parcels',
  type: 'shipment',
  entrance: { conditions: [], variables: [] },
  rules: [],
  html: false,
  ai: { enabled: false },
  origin: { kind: 'recipe', publisher: 'recued-core', recipe: 'shop-parcels', variable: 'template', version: 1 },
  active: true,
  revision: 1,
  health: { matched: 0, entered: 0, not_entered: 0 },
  created_at: 1,
  updated_at: 1,
  ...over,
});

const recipes = async () => ({ recipes: [{ recipe_id: 'shop-parcels', recipe: { metadata: { name: 'Shop parcels desk' } } }] as never });

describe('the templates a recipe setting offers', () => {
  it('names a recipe’s template by its recipe, and the owner’s as theirs', async () => {
    const callers = createMailTemplateVariableCallers({
      listTemplates: async () => ({ templates: [template(), template({ template_id: 'mtpl_2', name: 'UPS', origin: { kind: 'owner' }, active: false })] }),
      listRecipes: recipes,
      duplicateTemplate: vi.fn(),
      navigate: vi.fn(),
    });
    expect(await callers.list()).toEqual([
      { template_id: 'mtpl_1', name: 'Shop parcels', type: 'shipment', active: true, recipe: 'Shop parcels desk' },
      { template_id: 'mtpl_2', name: 'UPS', type: 'shipment', active: false },
    ]);
  });

  it('still lists the templates when the recipes cannot be read, naming a recipe by its id', async () => {
    const callers = createMailTemplateVariableCallers({
      listTemplates: async () => ({ templates: [template()] }),
      listRecipes: async () => { throw new Error('offline'); },
      duplicateTemplate: vi.fn(),
      navigate: vi.fn(),
    });
    expect((await callers.list())[0]).toMatchObject({ recipe: 'shop-parcels' });
  });

  it('opens one where templates are edited, and duplicates through the server', async () => {
    const navigate = vi.fn();
    const duplicateTemplate = vi.fn(async () => ({ template: template({ template_id: 'mtpl_copy', name: 'Shop parcels (copy)', origin: { kind: 'owner' } }) }));
    const callers = createMailTemplateVariableCallers({ listTemplates: async () => ({ templates: [] }), listRecipes: recipes, duplicateTemplate, navigate });
    callers.open!('mtpl_1');
    expect(navigate).toHaveBeenCalledWith('#data/mail_fact/templates/mtpl_1');
    expect(mailTemplateAddress('a b')).toBe('#data/mail_fact/templates/a%20b');
    expect(await callers.duplicate!('mtpl_1')).toEqual({ template_id: 'mtpl_copy', name: 'Shop parcels (copy)', type: 'shipment', active: true });
    expect(duplicateTemplate).toHaveBeenCalledWith({ template_id: 'mtpl_1' });
  });
});
