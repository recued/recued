import { describe, expect, it } from 'vitest';
import type { ServerRecipeListEntry, VariableDefault } from '@recued/contracts';
import { runPaletteRecipeOptions } from '../chat/run-palette.js';
import { runPageObject } from '../shell/run-page-context.js';

const recipe = (id: string, variables: Record<string, VariableDefault>): ServerRecipeListEntry => ({
  recipe_id: id, version: 1, publisher_id: 'owner', recipe_hash: id, source: 'pair-sync', installed_at: 0,
  recipe: { recipe_id: id, version: 1, ttl: 0, variables,
    metadata: { name: id, description: '', author: 'owner', supported_platforms: [] }, output: { sidebar: [] } },
});
const context = { label: 'Ana', objects: [runPageObject('contact', 'ana', { email: 'ana@example.test', name: 'Ana' })] };
const bound = { label: 'Recipient', type: 'text' as const, page_binding: { kind: 'contact', field: 'email' } };

describe('Run palette page matching order', () => {
  it('ranks actual supplied arguments first, preserves ties, and retains every recipe', () => {
    const recipes = [recipe('unrelated', {}), recipe('one', { recipient: bound }),
      recipe('two', { recipient: bound, name: null }), recipe('also-one', { recipient: bound })];
    const options = runPaletteRecipeOptions(recipes, context);
    expect(options.map(option => option.id)).toEqual(['two', 'one', 'also-one', 'unrelated']);
    expect(options[0]!.sublabel).toBe('Prefills 2 arguments from this page');
    expect(options[1]!.sublabel).toBe('Prefills 1 argument from this page');
    expect(recipes[0]!.recipe_id).toBe('unrelated');
  });

  it('keeps ordinary inventory order without a selection or a unique type-compatible value', () => {
    const recipes = [recipe('first', {}), recipe('last', { recipient: bound })];
    expect(runPaletteRecipeOptions(recipes, null).map(option => option.id)).toEqual(['first', 'last']);
    const ambiguous = { ...context, objects: [...context.objects, runPageObject('contact', 'bea', { email: 'bea@example.test' })] };
    expect(runPaletteRecipeOptions(recipes, ambiguous).map(option => option.id)).toEqual(['first', 'last']);
    expect(runPaletteRecipeOptions([recipe('saved', { recipient: { ...bound, default: 'saved' } })], context)[0]!.sublabel).toBeUndefined();
  });

  it('ranks projected context arguments without fetching bodies and leaves reactive recipes alone', () => {
    const projected = { ...recipe('targeted', {}), run_context_targets: ['contact_id'] };
    const reactive = recipe('reactive', { recipient: bound });
    reactive.recipe.event_triggers = [{ on: 'contact.changed' }];
    expect(runPaletteRecipeOptions([reactive, projected], context).map(option => option.id)).toEqual(['targeted', 'reactive']);
    expect(runPaletteRecipeOptions([reactive], context)[0]!.sublabel).toBeUndefined();
  });
});
