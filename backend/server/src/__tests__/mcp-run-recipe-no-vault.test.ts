/** 2026-11-22 (the owner: "go ahead") — `recued_runRecipe` takes no vault from its caller.
 *
 *  It offered `vault` as "Vault entries (API keys, tokens) for this execution", and its description said "Optionally
 *  pass vault (API credentials)". The vault is server-owned (the Tier-2 path and `recipe.run` refuse one too), and
 *  credentials are the owner's connections: an agent that took the offer sent the owner's keys in its own arguments,
 *  which no shipped ingredient reads, and the run lost what a caller's vault switches off in `handleExecute`. */
import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { _testing } from '../mcp-server.js';

const RECIPE: RecipeDefinition = {
  recipe_id: 'mcp-vault-test', version: 1, ttl: 60,
  metadata: { name: 'Vault test', description: 'a recipe', author: 'test', supported_platforms: ['test'] },
  variables: {}, prefetch_steps: [], steps: [{ id: 'msg', transform: 'template', template: 'hello' }],
  output: { sidebar: [{ type: 'text', source: 'step.msg' }] },
} as RecipeDefinition;

const deps = () => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(RECIPE);
  return {
    inboundTokenAuthorize: () => true,
    recipeStore,
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
  } as unknown as Parameters<typeof _testing.handleToolCall>[1];
};
const isError = (result: unknown): boolean => (result as { isError?: boolean }).isError === true;
const textOf = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]!.text;

describe('recued_runRecipe takes no vault from its caller', () => {
  it('refuses a vault before the recipe runs, saying credentials are the owner\'s connections', async () => {
    const result = await _testing.handleToolCall(
      { name: 'recued_runRecipe', arguments: { recipe_id: 'mcp-vault-test', vault: { api_key: 'not-a-real-key' } } },
      deps(),
    );
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('recued_runRecipe takes no vault');
    expect(textOf(result)).toContain("credentials are the owner's connections");
    expect(textOf(result)).not.toContain('not-a-real-key');
  });

  it('offers no vault argument, and asks for no credentials', () => {
    const tool = (_testing.STATIC_TOOLS as Array<{ name: string; description: string; inputSchema: { properties: object } }>)
      .find((entry) => entry.name === 'recued_runRecipe')!;
    expect(Object.keys(tool.inputSchema.properties)).not.toContain('vault');
    expect(tool.description).not.toMatch(/vault|API credentials/i);
    expect(tool.description).toContain('Credentials are never arguments');
  });
});
