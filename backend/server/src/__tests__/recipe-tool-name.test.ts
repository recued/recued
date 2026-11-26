/** A recipe as Chat names it, and the title the owner knows it by.
 *
 *  ⛔ "The action that waited for your approval (recued-core/send-composed-mail)
 *  is done." reached the owner by email (live, 2026-10-18): the follow-up after
 *  an approval named the tool, an id the owner never sees. The email door's
 *  follow-up now names the recipe's title, read here from a real recipe store. */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import { createRecipeStore } from '../recipe-store.js';
import { calledRecipeTitle, recipeToolTitle, resolveRecipeId } from '../recipe-tool-name.js';

const recipe = (recipe_id: string, name: unknown): RecipeDefinition =>
  ({
    recipe_id, version: 1, ttl: 60,
    metadata: { name, description: 'A recipe.', author: 'test', supported_platforms: [] },
    variables: {}, prefetch_steps: [], steps: [], output: { render: [] },
  }) as unknown as RecipeDefinition;

describe('a recipe tool\'s title', () => {
  it('the shipped send: "Send a composed email", by the tool name Chat calls it by', () => {
    const store = createRecipeStore('/nonexistent');
    const shipped = JSON.parse(readFileSync(
      new URL('../../../../community/recipes/send-composed-mail.json', import.meta.url), 'utf8',
    )) as RecipeDefinition;
    store.register(shipped);
    expect(recipeToolTitle(store, 'recued-core/send-composed-mail')).toBe('Send a composed email');
    expect(recipeToolTitle(store, 'send-composed-mail')).toBe('Send a composed email');
  });

  it('none for a tool no recipe answers to, or a recipe with no title', () => {
    const store = createRecipeStore('/nonexistent');
    store.register(recipe('untitled', '  '));
    store.register(recipe('odd', 7));
    expect(recipeToolTitle(store, 'recued-core/untitled')).toBeUndefined();
    expect(recipeToolTitle(store, 'recued-core/odd')).toBeUndefined();
    expect(recipeToolTitle(store, 'core.mail.send')).toBeUndefined();
    expect(recipeToolTitle(store, 'recued-core/missing')).toBeUndefined();
  });

  it('resolves as Chat\'s own dispatch does: the literal id first, then after the first slash', () => {
    const store = createRecipeStore('/nonexistent');
    store.register(recipe('notes', 'Notes'));
    store.register(recipe('team/notes', 'Team notes'));
    expect(resolveRecipeId('team/notes', store)).toBe('team/notes');
    expect(recipeToolTitle(store, 'team/notes')).toBe('Team notes');
    expect(resolveRecipeId('recued-core/notes', store)).toBe('notes');
    expect(resolveRecipeId('recued-core/', store)).toBe('recued-core/');
  });

  it('the server composes the email door\'s follow-up with it, over its own recipe store', () => {
    const source = readFileSync(new URL('../serve/compose-listeners.ts', import.meta.url), 'utf8');
    expect(source).toContain('toolTitle: (tool_name) => recipeToolTitle(storage.recipeStore, tool_name)');
  });
});

describe('the recipe a chat call ran, by its title, for its line', () => {
  const store = createRecipeStore('/nonexistent');
  store.register(recipe('weekly-digest', 'Weekly digest'));
  const title = (recipe_ref: string) => recipeToolTitle(store, recipe_ref);

  it('a recipe\'s own tool, and `recipe.run`, `recipe.schedule` or `recipe.stop` naming one', () => {
    expect(calledRecipeTitle(title, { tool_name: 'recued-core/weekly-digest', tier: 2, args: {} })).toBe('Weekly digest');
    for (const tool_name of ['recipe.run', 'recipe.schedule', 'recipe.stop', 'recipe.stop_allowing']) {
      expect(calledRecipeTitle(title, { tool_name, tier: 1, args: { recipe_id: 'recued-core/weekly-digest' } }))
        .toBe('Weekly digest');
    }
    // The bare id, as a schedule may name it.
    expect(calledRecipeTitle(title, { tool_name: 'recipe.schedule', tier: 1,
      args: { recipe_id: 'weekly-digest', mode: 'one_shot' } })).toBe('Weekly digest');
  });

  it('none for any other call, nor for a recipe the model wrote, nor when no recipe answers', () => {
    const none: Array<{ tool_name: string; tier: 1 | 2 | 3; args: unknown }> = [
      { tool_name: 'mail.search', tier: 1, args: { recipe_id: 'recued-core/weekly-digest' } },
      { tool_name: 'schedule.run_prompt', tier: 1, args: { recipe_id: 'recued-core/weekly-digest' } },
      // A stop by run names no recipe: an inline recipe's run keeps the id the model gave it, which
      // can be an installed recipe's, so the run's own id would name a recipe it did not run.
      { tool_name: 'recipe.stop', tier: 1, args: { run_id: 'run_1' } },
      { tool_name: 'recipe.schedule', tier: 1, args: { recipe_id: '' } },
      // An inline recipe's name is the model's; with both, the call names no installed recipe alone.
      { tool_name: 'recipe.run', tier: 1, args: { recipe: { metadata: { name: 'Weekly digest' } } } },
      { tool_name: 'recipe.run', tier: 1, args: { recipe_id: 'recued-core/weekly-digest', recipe: {} } },
      { tool_name: 'recipe.run', tier: 1, args: { recipe_id: ' ' } },
      { tool_name: 'recipe.run', tier: 1, args: ['recued-core/weekly-digest'] },
      { tool_name: 'recued_op_hubspot_deal_search', tier: 2, args: {} },
      { tool_name: 'recued-core/missing', tier: 2, args: {} },
      { tool_name: 'recued-core/weekly-digest', tier: 3, args: {} },
    ];
    for (const call of none) expect(calledRecipeTitle(title, call)).toBeUndefined();
    expect(calledRecipeTitle(undefined, { tool_name: 'recued-core/weekly-digest', tier: 2, args: {} })).toBeUndefined();
  });

  it('a lookup that fails names nothing, and fails no call', () => {
    expect(calledRecipeTitle(() => { throw new Error('locked'); },
      { tool_name: 'recued-core/weekly-digest', tier: 2, args: {} })).toBeUndefined();
  });

  it('on one line, and cut short past 120 characters', () => {
    const named = (name: string) => calledRecipeTitle(() => name, { tool_name: 'a/b', tier: 2, args: {} });
    expect(named('  Weekly\n\tdigest  ')).toBe('Weekly digest');
    expect(named(' \n ')).toBeUndefined();
    const long = named('x'.repeat(200))!;
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith('x…')).toBe(true);
    // Cut by character, never through one: a name in emoji keeps whole ones.
    const emoji = named('📅'.repeat(130))!;
    expect(Array.from(emoji)).toEqual([...Array.from('📅'.repeat(119)), '…']);
  });
});
