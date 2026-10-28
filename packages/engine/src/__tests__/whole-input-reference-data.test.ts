import { describe, expect, it } from 'vitest';
import { resolveDeep, type IngredientManifest, type RecipeDefinition } from '@recued/contracts';
import { createIngredientExecutor } from '@recued/ingredients';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext } from '../types.js';

describe('whole-input references carry data through manifest resolution', () => {
  it.each(['sequential', 'prefetch'])('preserves literal source in the %s lane while resolving defaults and filtering locked keys', async phase => {
    const source = '{"recipe":"{{config.secret}}","secret":"{{vault.api_key}}"}\r\n';
    const forwarded = { source, nested: { value: '{{vault.api_key}}' }, url: 'https://untrusted.test' };
    const stores = { config: { input: forwarded, secret: 'CONFIG-SECRET', trusted_url: 'https://trusted.test' }, vault: { api_key: 'VAULT-SECRET' },
      context: {}, meta: {}, step: {} };
    const manifest: IngredientManifest = { slug: 'capture', author: 'recued', name: 'Capture', description: 'Capture input',
      version: 1, kind: 'storage', risk_tier: 'read', category: 'data',
      input: { source: null, default_control: '{{config.secret}}', url: '{{config.trusted_url}}' }, output: {} };
    const received: Record<string, unknown>[] = [];
    const ingredientExecutor = createIngredientExecutor({ manifestLoader: async () => manifest, adapterRegistry: {},
      resolveRefs: input => resolveDeep(input, stores) as Record<string, unknown>,
      kernelAdapter: async call => { received.push(call.input); return call.input; } });
    const call = { id: 'capture', ingredient: 'capture', input: '{{config.input}}' };
    const recipe = { recipe_id: 'forward-source', version: 1, ttl: 0, variables: {},
      metadata: { name: 'Forward source', description: 'Forward source', author: 'test', supported_platforms: [] },
      prefetch_steps: phase === 'prefetch' ? [call] : [], steps: phase === 'sequential' ? [call] : [],
      output: { render: [] } } as unknown as RecipeDefinition;
    const result = await executeRecipe({ recipe, stores, ingredientExecutor } as ExecutionContext);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(received).toEqual([{ source, nested: forwarded.nested, default_control: 'CONFIG-SECRET', url: 'https://trusted.test' }]);
  });
});
