/** 2026-11-22 (the owner) — a recipe `recued_saveRecipe` saves is the owner's own, as if made in Kitchen: publisher
 *  `kitchen`, listed on the owner's Recipes page and by `recued_listRecipes`. *"the recipe created from
 *  recued_saveRecipe should be /local and visible in the webclient for owner to manage, so there's no hidden recipes
 *  (other than recued kernel recipes)"*, then publisher `kitchen`, the one Kitchen edits in place.
 *
 *  Before, from the owner's local stdio client (the only caller this tool admits), the save took its publisher from
 *  the agent (`recued-core` was listed as Recued's own), stored a recipe marked `metadata.author: 'recued'` that no
 *  list showed while it still ran by id, and replaced whatever held the id. Each case below runs the real handler
 *  over a real recipe store. */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { listServerRecipes } from '../recipe-list-handler.js';
import { _testing } from '../mcp-server.js';

const recipe = (id: string, author = 'someone', template = 'hi'): RecipeDefinition => ({
  recipe_id: id, version: 1, ttl: 60,
  metadata: { name: `Recipe ${id}`, description: 'a recipe', author, supported_platforms: ['test'] },
  variables: {}, prefetch_steps: [], steps: [{ id: 'msg', transform: 'template', template }],
  output: { sidebar: [{ type: 'text', source: 'step.msg' }] },
} as RecipeDefinition);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** The owner's local stdio client when `token` is absent; a remote app's token otherwise. */
const server = (token?: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-save-owner-'));
  dirs.push(dir);
  const store = createRecipeStore(dir, new Database(':memory:'));
  const deps = {
    inboundTokenAuthorize: () => true,
    recipeStore: store,
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    ...(token !== undefined ? { mcpTokenId: token } : {}),
  } as unknown as Parameters<typeof _testing.handleToolCall>[1];
  const call = (name: string, args: Record<string, unknown>) => _testing.handleToolCall({ name, arguments: args }, deps);
  const ownerList = async () => (await listServerRecipes({ store } as Parameters<typeof listServerRecipes>[0])).recipes;
  return { store, call, ownerList };
};
const isError = (result: unknown): boolean => (result as { isError?: boolean }).isError === true;
const textOf = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]!.text;
const templateOf = (value: RecipeDefinition | null): unknown => (value?.steps[0] as { template?: unknown } | undefined)?.template;

describe("recued_saveRecipe saves the owner's own recipe, listed for them", () => {
  it('saves under kitchen whatever publisher the agent names, and both lists show it', async () => {
    const { store, call, ownerList } = server();
    const result = await call('recued_saveRecipe', { recipe: recipe('weekly-report'), publisher_id: 'recued-core' });
    expect(isError(result)).toBe(false);
    expect(JSON.parse(textOf(result))).toMatchObject({ saved: true, recipe_id: 'weekly-report', publisher_id: 'kitchen',
      note: expect.stringContaining("owner's own recipes: it is on their Recipes page now") });
    expect(store.getStored('weekly-report')?.publisher_id).toBe('kitchen');
    expect((await ownerList()).find((entry) => entry.recipe_id === 'weekly-report')).toMatchObject({ publisher_id: 'kitchen' });
    const listed = JSON.parse(textOf(await call('recued_listRecipes', {}))) as Array<{ recipe_id: string }>;
    expect(listed.map((entry) => entry.recipe_id)).toContain('weekly-report');
  });

  it("refuses metadata.author 'recued', which no list shows, and stores nothing", async () => {
    const { store, call, ownerList } = server();
    const result = await call('recued_saveRecipe', { recipe: recipe('quiet-one', 'recued') });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain("marks Recued's built-in recipes");
    expect(store.getStored('quiet-one')).toBeNull();
    expect((await ownerList()).some((entry) => entry.recipe_id === 'quiet-one')).toBe(false);
  });

  it("refuses an id another publisher's recipe holds, and leaves that recipe as it was", async () => {
    const { store, call } = server();
    store.save(recipe('invoice-intake', 'Recued', 'theirs'), 'recued-core', 'pair-sync');
    const result = await call('recued_saveRecipe', { recipe: recipe('invoice-intake', 'someone', 'mine') });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('(publisher "recued-core")');
    expect(store.getStored('invoice-intake')?.publisher_id).toBe('recued-core');
    expect(templateOf(store.get('invoice-intake'))).toBe('theirs');
  });

  it('refuses an id a recipe this process holds in memory has, and stores nothing', async () => {
    const { store, call } = server();
    store.register(recipe('held-in-memory', 'someone', 'held'));
    const result = await call('recued_saveRecipe', { recipe: recipe('held-in-memory', 'someone', 'mine') });
    expect(isError(result)).toBe(true);
    expect(store.getStored('held-in-memory')).toBeNull();
    expect(templateOf(store.get('held-in-memory'))).toBe('held');
  });

  it("changes the owner's own recipe in place, and restamps one this tool saved as mcp", async () => {
    const { store, call } = server();
    store.save(recipe('mine', 'owner', 'first'), 'kitchen', 'inline');
    store.save(recipe('older', 'owner', 'first'), 'mcp', 'inline');
    expect(isError(await call('recued_saveRecipe', { recipe: recipe('mine', 'owner', 'second') }))).toBe(false);
    expect(isError(await call('recued_saveRecipe', { recipe: recipe('older', 'owner', 'second') }))).toBe(false);
    expect(templateOf(store.get('mine'))).toBe('second');
    expect(templateOf(store.get('older'))).toBe('second');
    expect(store.getStored('mine')?.publisher_id).toBe('kitchen');
    expect(store.getStored('older')?.publisher_id).toBe('kitchen');
  });

  it("still refuses a remote app's token before anything is stored", async () => {
    const { store, call } = server('tok-remote-app');
    expect(isError(await call('recued_saveRecipe', { recipe: recipe('from-afar') }))).toBe(true);
    expect(store.getStored('from-afar')).toBeNull();
  });

  it('advertises no publisher argument, and no extension or pair-sync', () => {
    const tool = (_testing.STATIC_TOOLS as Array<{ name: string; description: string; inputSchema: { properties: object } }>)
      .find((entry) => entry.name === 'recued_saveRecipe')!;
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['recipe']);
    expect(tool.description).not.toMatch(/extension|pair-sync/);
  });
});
