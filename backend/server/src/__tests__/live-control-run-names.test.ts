/** Live control names a running recipe as the owner knows it: "Weekly digest · Read the feed", where
 *  it read "weekly-digest · read" (owner, 2026-11-13: "do naming Live control's running recipes
 *  properly"). An installed recipe by its name, read only off one loaded by id; a recipe passed in
 *  with the run is a one-off, never named as an installed one, whatever its id; a step by its
 *  action, from its ingredient's manifest. Display only: the agent turn reads none of it. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeEntryTitle, type IngredientManifest, type RecipeDefinition } from '@recued/contracts';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { InFlightRegistry, type RunRegistration } from '../execution/in-flight-registry.js';
import { LaneSemaphore } from '../execution/lane-semaphore.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { RUN_INGREDIENT_RECIPE } from '../run-ingredient-recipe.js';

afterEach(() => { vi.unstubAllGlobals(); });

const owner = { channel: 'user' as const, actor: 'user_self' as const, user_id: 'owner', client_token_id: 'fixture' };
const DIGEST: RecipeDefinition = {
  recipe_id: 'weekly-digest', version: 1, ttl: 0,
  metadata: { name: 'Weekly digest', description: 'A digest.', author: 'fixture', supported_platforms: [] },
  variables: {}, prefetch_steps: [], steps: [{ id: 'read', ingredient: 'fixture-read', input: {} }],
  output: { render: [] },
} as RecipeDefinition;

const runAndCapture = async (
  request: { recipe_id: string } | { recipe: RecipeDefinition; config?: Record<string, unknown> },
) => {
  const registry = new InFlightRegistry(new LaneSemaphore());
  const registered: RunRegistration[] = [];
  const register = registry.registerRun.bind(registry);
  vi.spyOn(registry, 'registerRun').mockImplementation((reg) => { registered.push(reg); register(reg); });
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register({ slug: 'fixture-read', version: 1, name: 'Read the feed', description: '', author: 'fixture',
    kind: 'http', category: 'data', risk_tier: 'read', input: { method: 'GET', url: 'https://fixture.invalid/read' }, output: {} } as IngredientManifest);
  const recipes = createRecipeStore('/nonexistent');
  recipes.register(DIGEST);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })));
  const deps: ExecuteHandlerDeps = { recipeStore: recipes, baseVault: {}, executorConfig: { manifests },
    laneGovernor: new LaneSemaphore(), inFlightRegistry: registry, cliReachabilityResolver: () => true };
  await handleExecute(deps, { ...request, execution_source: owner });
  return registered;
};

describe('a running recipe, as Live control names it', () => {
  it('an installed recipe, loaded by id, by its name, and its step by what it does', async () => {
    const [run] = await runAndCapture({ recipe_id: 'weekly-digest' });
    expect(run).toMatchObject({ recipe_id: 'weekly-digest', recipe_name: 'Weekly digest', step_names: { read: 'Read the feed' } });
    expect(run).not.toHaveProperty('recipe_inline');
  });

  it('one passed in with the run is a one-off: its name is its caller\'s, though it copies an installed one', async () => {
    const [run] = await runAndCapture({ recipe: DIGEST });
    expect(run).toMatchObject({ recipe_id: 'weekly-digest', recipe_inline: true, step_names: { read: 'Read the feed' } });
    expect(run).not.toHaveProperty('recipe_name');
  });

  it('the kernel run-ingredient recipe (MCP tools, the chat\'s actions) is named by the action it runs, never "One-off recipe “Run Ingredient”"', async () => {
    const [run] = await runAndCapture({ recipe: RUN_INGREDIENT_RECIPE,
      config: { ingredient_slug: 'fixture-read', input: {} } });
    expect(run).toMatchObject({ recipe_id: 'run-ingredient', recipe_name: 'Read the feed' });
    expect(run).not.toHaveProperty('recipe_inline');
    expect(run).not.toHaveProperty('step_names');
    expect(activeEntryTitle({ ...run!, step_id: 'call' })).toBe('Read the feed');
  });

  it('its entries carry the names, running and queued; the agent turn reads none of them', async () => {
    const sem = new LaneSemaphore({ local_heavy_n: 1 });
    const registry = new InFlightRegistry(sem);
    const base = { source: owner, origin: 'attended' as const, session_id: 'sess1', started_at: 1, abort: () => {} };
    registry.registerRun({ ...base, run_id: 'runA', recipe_id: 'weekly-digest', intent: 'Weekly digest',
      recipe_name: 'Weekly digest', step_names: { step1: 'Read the feed' } });
    registry.registerRun({ ...base, run_id: 'runB', recipe_id: 'weekly-digest', intent: 'Weekly digest',
      recipe_inline: true, step_names: { step1: 'Read the feed' } });
    const slot = (run_id: string) => ({ call_class: 'local-heavy' as const,
      descriptor: { recipe_id: 'weekly-digest', slug: 'fixture-read', run_id, step_id: 'step1' } });
    const held = await sem.acquire(slot('runA'));
    void sem.acquire(slot('runB'));
    await new Promise<void>((done) => setTimeout(done, 0));
    const entries = registry.snapshot().entries;
    const running = entries.find((e) => e.entry_kind === 'run' && e.run_id === 'runA')!;
    const queued = entries.find((e) => e.entry_kind === 'queued-call')!;
    expect(running).toMatchObject({ recipe_name: 'Weekly digest', step_name: 'Read the feed' });
    expect(queued).toMatchObject({ recipe_inline: true, step_name: 'Read the feed' });
    expect(activeEntryTitle(running)).toBe('Weekly digest · Read the feed');
    expect(activeEntryTitle(queued)).toBe('One-off recipe “Weekly digest” · Read the feed');
    const told = registry.promptContext('sess1')!;
    expect(told).toContain('recipe=weekly-digest');
    expect(told).not.toContain('Read the feed');
    expect(told).not.toContain('One-off');
    held.release('succeeded');
  });
});
