import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setRole, ROLE } from '@recued/contracts';
import type { RecipeDefinition, IngredientManifest } from '@recued/contracts';
import { executeRecipe } from '../execute.js';
import { findRoleRestrictions } from '../preflight.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const httpManifest: IngredientManifest = {
  slug: 'deal-reader-hubspot',
  name: 'Deal Reader', description: '', author: 'recued-core',
  kind: 'http',
  category: 'data', risk_tier: 'read',
  input: { url: 'https://api.hubapi.com/deals', method: 'GET' },
  output: {},
};

const domManifest: IngredientManifest = {
  slug: 'email-composer-hubspot',
  name: 'Email Composer', description: '', author: 'recued-core',
  kind: 'dom',
  category: 'action', risk_tier: 'write',
  input: { subject: null, body: null },
  output: { '[data-test-id="email-subject"]': 'dom.subject' },
};

const chatManifest: IngredientManifest = {
  slug: 'web-chat-gemini',
  name: 'Gemini Chat', description: '', author: 'recued-core',
  kind: 'chat',
  category: 'action', risk_tier: 'write',
  input: { 'chat.prompt': null },
  output: { 'gemini.google.com/*': 'chat.target' },
};

const manifests = new Map<string, IngredientManifest>([
  ['deal-reader-hubspot', httpManifest],
  ['email-composer-hubspot', domManifest],
  ['web-chat-gemini', chatManifest],
]);
const getManifest = (slug: string) => manifests.get(slug) ?? null;

const httpOnlyRecipe: RecipeDefinition = {
  recipe_id: 'http-only', version: 1, ttl: 60,
  metadata: { name: 'HTTP', description: '', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [{ id: 'deal', ingredient: 'deal-reader-hubspot', input: {} }],
  steps: [{ id: 'x', transform: 'template', template: 'ok' }],
  output: { sidebar: [] },
};

const domRecipe: RecipeDefinition = {
  recipe_id: 'uses-dom', version: 1, ttl: 60,
  metadata: { name: 'DOM', description: '', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'compose', ingredient: 'email-composer-hubspot', input: { subject: 'hi', body: 'hello' } }],
  output: { sidebar: [] },
};

const chatRecipe: RecipeDefinition = {
  recipe_id: 'uses-chat', version: 1, ttl: 60,
  metadata: { name: 'Chat', description: '', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'ask', ingredient: 'web-chat-gemini', input: { 'chat.prompt': 'hello' } }],
  output: { sidebar: [] },
};

// ────────────────────────────────────────────────────────────────
// findRoleRestrictions (pure, no ROLE state needed)
// ────────────────────────────────────────────────────────────────

describe('findRoleRestrictions', () => {
  it('returns empty for http-only recipe on server', () => {
    const r = findRoleRestrictions(httpOnlyRecipe, getManifest, 'server');
    expect(r).toEqual([]);
  });

  it('flags DOM ingredients on server', () => {
    const r = findRoleRestrictions(domRecipe, getManifest, 'server');
    expect(r).toHaveLength(1);
    expect(r[0].slug).toBe('email-composer-hubspot');
    expect(r[0].adapter).toBe('dom');
  });

  it('allows Chat ingredients on server (delegatable to extension)', () => {
    const r = findRoleRestrictions(chatRecipe, getManifest, 'server');
    expect(r).toEqual([]);
  });

  it('returns empty on extension role', () => {
    const r = findRoleRestrictions(domRecipe, getManifest, 'extension');
    expect(r).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// executeRecipe with manifestGetter (integration)
// ────────────────────────────────────────────────────────────────

describe('executeRecipe role restriction', () => {
  beforeAll(() => { setRole('server'); });

  it('rejects DOM recipe on server with ROLE_RESTRICTION error', async () => {
    const result = await executeRecipe({
      recipe: domRecipe,
      stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
      ingredientExecutor: async () => ({}),
      manifestGetter: getManifest,
    });
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('ROLE_RESTRICTION');
    expect(result.errors[0].message).toContain('email-composer-hubspot');
    expect(result.errors[0].message).toContain('dom');
  });

  it('allows HTTP-only recipe on server', async () => {
    const result = await executeRecipe({
      recipe: httpOnlyRecipe,
      stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
      ingredientExecutor: async () => ({ amount: 1000 }),
      manifestGetter: getManifest,
    });
    // May fail on actual execution (no real API) but should NOT fail on role restriction
    expect(result.errors.every(e => e.code !== 'ROLE_RESTRICTION')).toBe(true);
  });

  it('skips check when manifestGetter is not provided', async () => {
    const result = await executeRecipe({
      recipe: domRecipe,
      stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
      ingredientExecutor: async () => ({}),
      // No manifestGetter — check is skipped
    });
    // Should not fail with ROLE_RESTRICTION (may fail for other reasons)
    expect(result.errors.every(e => e.code !== 'ROLE_RESTRICTION')).toBe(true);
  });
});
