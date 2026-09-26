/** Fixture replies for the production Kitchen -> paired RPC browser path. */
import type { LocalRecipeWebhookStatus, RecipeDefinition, RecipeSimulationRequest, RecipeSimulationResult } from '@recued/contracts';

const recipe: RecipeDefinition = {
  recipe_id: 'sample-test', version: 1, ttl: 0,
  metadata: { name: 'Sample test', description: 'Testing a sample.', author: 'owner', supported_platforms: [] },
  variables: { items: [] }, prefetch_steps: [],
  steps: [{ id: 'count', transform: 'count', input: '{{config.items}}' }], output: { render: [] },
};
export const recipeSimulationDemoReply = (method: string, args: unknown): { result: unknown } | null => {
  if (new URLSearchParams(location.search).get('recipe_simulation') !== '1') return null;
  const entry = { recipe_id: recipe.recipe_id, publisher_id: 'owner', version: 1, source: 'inline', recipe };
  if (method === 'recipe.list') return { result: { recipes: [entry] } };
  // The editor's FIRST read since the list lost its step bodies (f95faec10);
  // unanswered, it never settled and the editor sat on "Loading recipe…".
  if (method === 'recipe.get') {
    return { result: { recipe: (args as { recipe_id?: unknown }).recipe_id === recipe.recipe_id ? entry : null } };
  }
  if (method === 'webhook.ingress.list') return { result: { ingresses: [] } };
  if (method === 'recipe.webhook.status') {
    const webhook: LocalRecipeWebhookStatus = { declared: false, configured: false, armed: false, bindings: [] };
    return { result: { webhook } };
  }
  if (method === 'recipe.simulate.cancel') return { result: { cancelled: true } };
  if (method !== 'recipe.simulate') return null;
  const request = args as RecipeSimulationRequest;
  const items = request.sample.config?.items;
  const result: RecipeSimulationResult = { status: 'passed', steps: [{
    id: request.recipe.steps[0]!.id, phase: 'sequential', operation: 'count', mocked: false,
    status: 'passed', input: items, output: Array.isArray(items) ? items.length : 0,
  }] };
  return { result };
};
