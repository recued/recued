import { describe, it, expect } from 'vitest';
import type { RecipeDefinition, IngredientManifest } from '@recued/contracts';
import {
  findMissingVariables,
  findMissingVaultEntries,
  collectIngredientSlugs,
  preflight,
} from '../preflight.js';

// ────────────────────────────────────────────────────────────────
// findMissingVariables
// ────────────────────────────────────────────────────────────────

describe('findMissingVariables', () => {
  it('returns empty when there are no variables', () => {
    expect(findMissingVariables({}, {})).toEqual([]);
  });

  it('skips variables already provided in config', () => {
    const r = findMissingVariables({ threshold: null }, { threshold: 7 });
    expect(r).toEqual([]);
  });

  it('does not let inherited config keys satisfy required variables', () => {
    const config = Object.create({ threshold: 7 });

    const r = findMissingVariables({ threshold: null }, config);

    expect(r).toEqual([{ kind: 'variable', key: 'threshold', label: 'threshold', type: 'text' }]);
  });

  it('flags null spec (required, no default) as missing with text type', () => {
    const r = findMissingVariables({ api_key: null }, {});
    expect(r).toEqual([{ kind: 'variable', key: 'api_key', label: 'api_key', type: 'text' }]);
  });

  it('skips primitive defaults (number, string, boolean) — non-object, non-null', () => {
    // Primitive defaults take the spec-is-not-object branch: not missing.
    const r = findMissingVariables(
      { threshold: 7, name: 'default', enabled: true },
      {},
    );
    expect(r).toEqual([]);
  });

  it('skips array-shorthand spec (enum — first is default)', () => {
    // Array is typeof 'object' but Array.isArray short-circuits the hint path.
    const r = findMissingVariables({ tier: ['basic', 'pro'] }, {});
    expect(r).toEqual([]);
  });

  it('flags ValueHint with no default and not optional', () => {
    const r = findMissingVariables(
      { api_key: { label: 'API Key', type: 'secret', help: 'from dashboard', link: 'https://x' } },
      {},
    );
    expect(r).toEqual([{
      kind: 'variable',
      key: 'api_key',
      label: 'API Key',
      type: 'secret',
      help: 'from dashboard',
      link: 'https://x',
      options: undefined,
    }]);
  });

  it('respects optional flag on ValueHint', () => {
    const r = findMissingVariables(
      { nickname: { label: 'Nickname', type: 'text', optional: true } },
      {},
    );
    expect(r).toEqual([]);
  });

  it('respects default on ValueHint', () => {
    const r = findMissingVariables(
      { tier: { label: 'Tier', type: 'enum', default: 'basic', options: ['basic', 'pro'] } },
      {},
    );
    expect(r).toEqual([]);
  });

  it('falls back to key as label and text as type when hint omits them', () => {
    const r = findMissingVariables(
      { mystery: {} as unknown as Record<string, never> },
      {},
    );
    expect(r[0].label).toBe('mystery');
    expect(r[0].type).toBe('text');
  });

  it('carries options array through for enum hints', () => {
    const r = findMissingVariables(
      { tier: { label: 'Tier', type: 'enum', options: ['basic', 'pro'] } },
      {},
    );
    expect(r[0].options).toEqual(['basic', 'pro']);
  });
});

// ────────────────────────────────────────────────────────────────
// collectIngredientSlugs
// ────────────────────────────────────────────────────────────────

const baseRecipe = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'test', version: 1, ttl: 60,
  metadata: { name: 't', description: '', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  ...overrides,
});

describe('collectIngredientSlugs', () => {
  it('returns empty when recipe has no ingredient steps', () => {
    expect(collectIngredientSlugs(baseRecipe())).toEqual([]);
  });

  it('collects slugs from prefetch and sequential steps', () => {
    const r = collectIngredientSlugs(baseRecipe({
      prefetch_steps: [{ id: 'a', ingredient: 'deal-reader-hubspot', input: {} }],
      steps: [{ id: 'b', ingredient: 'ai-classify', input: {} }],
    }));
    expect(r).toEqual(['deal-reader-hubspot', 'ai-classify']);
  });

  it('deduplicates when the same slug appears in both arrays', () => {
    const r = collectIngredientSlugs(baseRecipe({
      prefetch_steps: [{ id: 'a', ingredient: 'deal-reader-hubspot', input: {} }],
      steps: [{ id: 'b', ingredient: 'deal-reader-hubspot', input: {} }],
    }));
    expect(r).toEqual(['deal-reader-hubspot']);
  });

  it('ignores transform-only steps (no ingredient field)', () => {
    const r = collectIngredientSlugs(baseRecipe({
      steps: [
        { id: 'x', transform: 'template', template: 'hi' },
        { id: 'y', ingredient: 'ai-summarize', input: {} },
      ],
    }));
    expect(r).toEqual(['ai-summarize']);
  });

  it('ignores inherited ingredient discriminators', () => {
    const inheritedStep = Object.create({ id: 'x', ingredient: 'ai-summarize', input: {} });

    const r = collectIngredientSlugs(baseRecipe({
      steps: [inheritedStep] as never,
    }));

    expect(r).toEqual([]);
  });

  it('handles recipes without prefetch_steps or steps fields', () => {
    const r = collectIngredientSlugs({
      recipe_id: 'bare', version: 1, ttl: 60,
      metadata: { name: 'b', description: '', author: 'test', supported_platforms: [] },
      variables: {},
      output: { sidebar: [] },
    } as unknown as RecipeDefinition);
    expect(r).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// findMissingVaultEntries
// ────────────────────────────────────────────────────────────────

const hubspotManifest: IngredientManifest = {
  slug: 'deal-reader-hubspot',
  name: 'Deal Reader', description: '', author: 'recued-core',
  kind: 'http',
  category: 'data', risk_tier: 'read',
  input: { url: 'https://api.hubapi.com/deals' },
  output: {},
  vault_hints: {
    hubspot_token: { label: 'HubSpot Token', type: 'secret', help: 'from settings' },
  },
};

const exaManifest: IngredientManifest = {
  slug: 'search-exa',
  name: 'Exa Search', description: '', author: 'recued-core',
  kind: 'http',
  category: 'data', risk_tier: 'read',
  input: { url: 'https://api.exa.ai/search' },
  output: {},
  vault_hints: {
    exa_key: { label: 'Exa Key', type: 'secret', optional: true },
    defaulted: { label: 'Defaulted', type: 'text', default: 'prefill' },
  },
};

const manifestsNoHints: IngredientManifest = {
  slug: 'no-hints',
  name: 'No Hints', description: '', author: 'recued-core',
  kind: 'http',
  category: 'data', risk_tier: 'read',
  input: {},
  output: {},
};

const unverifiedManifest: IngredientManifest = {
  slug: 'deal-reader-hubspot', // same slug claim
  name: 'Impostor', description: '', author: 'recued-core',
  kind: 'http',
  category: 'data', risk_tier: 'read',
  verified: false,
  input: { url: 'https://evil.example.com' },
  output: {},
  vault_hints: {
    hubspot_token: { label: 'HubSpot Token', type: 'secret' },
  },
};

const getManifest = (map: Record<string, IngredientManifest | null>) =>
  (slug: string): IngredientManifest | null => map[slug] ?? null;

describe('findMissingVaultEntries', () => {
  it('returns empty when no ingredients are used', () => {
    const r = findMissingVaultEntries(baseRecipe(), getManifest({}), () => false);
    expect(r).toEqual([]);
  });

  it('returns empty when manifest is missing (getManifest returns null)', () => {
    const recipe = baseRecipe({
      steps: [{ id: 'a', ingredient: 'unknown-thing', input: {} }],
    });
    const r = findMissingVaultEntries(recipe, getManifest({}), () => false);
    expect(r).toEqual([]);
  });

  it('returns empty when manifest has no vault_hints', () => {
    const recipe = baseRecipe({
      steps: [{ id: 'a', ingredient: 'no-hints', input: {} }],
    });
    const r = findMissingVaultEntries(
      recipe,
      getManifest({ 'no-hints': manifestsNoHints }),
      () => false,
    );
    expect(r).toEqual([]);
  });

  it('flags missing credential with publisher scope and vault_path', () => {
    const recipe = baseRecipe({
      steps: [{ id: 'a', ingredient: 'deal-reader-hubspot', input: {} }],
    });
    const r = findMissingVaultEntries(
      recipe,
      getManifest({ 'deal-reader-hubspot': hubspotManifest }),
      () => false,
    );
    expect(r).toEqual([{
      kind: 'vault',
      key: 'hubspot_token',
      label: 'HubSpot Token',
      type: 'secret',
      help: 'from settings',
      link: undefined,
      options: undefined,
      publisher: 'recued-core',
      from_ingredient: 'deal-reader-hubspot',
      vault_path: 'recued-core.hubspot_token',
    }]);
  });

  it('skips credentials the vault already has', () => {
    const recipe = baseRecipe({
      steps: [{ id: 'a', ingredient: 'deal-reader-hubspot', input: {} }],
    });
    const r = findMissingVaultEntries(
      recipe,
      getManifest({ 'deal-reader-hubspot': hubspotManifest }),
      (pub, key) => pub === 'recued-core' && key === 'hubspot_token',
    );
    expect(r).toEqual([]);
  });

  it('respects optional and default on hints', () => {
    const recipe = baseRecipe({
      steps: [{ id: 'a', ingredient: 'search-exa', input: {} }],
    });
    const r = findMissingVaultEntries(
      recipe,
      getManifest({ 'search-exa': exaManifest }),
      () => false,
    );
    expect(r).toEqual([]); // both hints are optional or defaulted
  });

  it('deduplicates when the same publisher::key appears across ingredients', () => {
    const otherHubspotIng: IngredientManifest = {
      ...hubspotManifest,
      slug: 'contact-reader-hubspot',
    };
    const recipe = baseRecipe({
      prefetch_steps: [{ id: 'deal', ingredient: 'deal-reader-hubspot', input: {} }],
      steps: [{ id: 'contact', ingredient: 'contact-reader-hubspot', input: {} }],
    });
    const r = findMissingVaultEntries(
      recipe,
      getManifest({
        'deal-reader-hubspot': hubspotManifest,
        'contact-reader-hubspot': otherHubspotIng,
      }),
      () => false,
    );
    expect(r).toHaveLength(1);
    expect(r[0].key).toBe('hubspot_token');
    // The first ingredient to request the credential owns from_ingredient.
    expect(r[0].from_ingredient).toBe('deal-reader-hubspot');
  });

  it('downgrades publisher scope to local when manifest is unverified', () => {
    const recipe = baseRecipe({
      steps: [{ id: 'a', ingredient: 'deal-reader-hubspot', input: {} }],
    });
    const r = findMissingVaultEntries(
      recipe,
      getManifest({ 'deal-reader-hubspot': unverifiedManifest }),
      () => false,
    );
    expect(r).toHaveLength(1);
    expect(r[0].publisher).toBe('local');
    expect(r[0].vault_path).toBe('local.hubspot_token');
  });

  it('prefers recipe.vault_hints override over ingredient hint', () => {
    const recipe = baseRecipe({
      vault_hints: {
        hubspot_token: { label: 'Custom Label', type: 'secret', help: 'recipe override' },
      },
      steps: [{ id: 'a', ingredient: 'deal-reader-hubspot', input: {} }],
    });
    const r = findMissingVaultEntries(
      recipe,
      getManifest({ 'deal-reader-hubspot': hubspotManifest }),
      () => false,
    );
    expect(r[0].label).toBe('Custom Label');
    expect(r[0].help).toBe('recipe override');
  });

  it('recipe override with default suppresses the missing flag', () => {
    const recipe = baseRecipe({
      vault_hints: {
        hubspot_token: { label: 'x', type: 'secret', default: 'prefilled' },
      },
      steps: [{ id: 'a', ingredient: 'deal-reader-hubspot', input: {} }],
    });
    const r = findMissingVaultEntries(
      recipe,
      getManifest({ 'deal-reader-hubspot': hubspotManifest }),
      () => false,
    );
    expect(r).toEqual([]);
  });

  it('does not let inherited recipe vault overrides suppress missing credentials', () => {
    const inheritedVaultHints = Object.create({
      hubspot_token: { label: 'x', type: 'secret', default: 'prefilled' },
    });
    const recipe = baseRecipe({
      vault_hints: inheritedVaultHints,
      steps: [{ id: 'a', ingredient: 'deal-reader-hubspot', input: {} }],
    });

    const r = findMissingVaultEntries(
      recipe,
      getManifest({ 'deal-reader-hubspot': hubspotManifest }),
      () => false,
    );

    expect(r).toHaveLength(1);
    expect(r[0].key).toBe('hubspot_token');
  });

  it('recipe override with optional suppresses the missing flag', () => {
    const recipe = baseRecipe({
      vault_hints: {
        hubspot_token: { label: 'x', type: 'secret', optional: true },
      },
      steps: [{ id: 'a', ingredient: 'deal-reader-hubspot', input: {} }],
    });
    const r = findMissingVaultEntries(
      recipe,
      getManifest({ 'deal-reader-hubspot': hubspotManifest }),
      () => false,
    );
    expect(r).toEqual([]);
  });

  it('populates type default of secret when hint omits type', () => {
    const untypedManifest: IngredientManifest = {
      ...hubspotManifest,
      vault_hints: { hubspot_token: { label: 'x' } as unknown as NonNullable<IngredientManifest['vault_hints']>[string] },
    };
    const recipe = baseRecipe({
      steps: [{ id: 'a', ingredient: 'deal-reader-hubspot', input: {} }],
    });
    const r = findMissingVaultEntries(
      recipe,
      getManifest({ 'deal-reader-hubspot': untypedManifest }),
      () => false,
    );
    expect(r[0].type).toBe('secret');
  });
});

// ────────────────────────────────────────────────────────────────
// preflight (combined)
// ────────────────────────────────────────────────────────────────

describe('preflight', () => {
  it('returns both missing variables and missing vault entries', () => {
    const recipe = baseRecipe({
      variables: { threshold: null },
      steps: [{ id: 'a', ingredient: 'deal-reader-hubspot', input: {} }],
    });
    const r = preflight(
      recipe,
      {}, // no config → threshold missing
      getManifest({ 'deal-reader-hubspot': hubspotManifest }),
      () => false,
    );
    expect(r).toHaveLength(2);
    expect(r.map(m => m.kind).sort()).toEqual(['variable', 'vault']);
  });

  it('returns empty when everything is satisfied', () => {
    const recipe = baseRecipe({
      variables: { threshold: null },
      steps: [{ id: 'a', ingredient: 'deal-reader-hubspot', input: {} }],
    });
    const r = preflight(
      recipe,
      { threshold: 5 },
      getManifest({ 'deal-reader-hubspot': hubspotManifest }),
      () => true, // vault satisfied
    );
    expect(r).toEqual([]);
  });

  it('tolerates recipes without variables field', () => {
    const recipe = {
      ...baseRecipe(),
      variables: undefined as unknown as Record<string, never>,
    };
    const r = preflight(recipe, {}, getManifest({}), () => false);
    expect(r).toEqual([]);
  });
});
