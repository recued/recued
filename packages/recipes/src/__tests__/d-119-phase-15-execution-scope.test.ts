/** D-119 Phase 15 — execution scope (validator + bundle parser + install gate).
 *
 *  Covers:
 *    - `validateIngredient` rejects an ingredient whose declared
 *      scope is wider than its derived shape (`EXECUTION_SCOPE_TOO_WIDE`).
 *    - `validateIngredient` rejects malformed `execution_scope` shapes.
 *    - `parseBundle` rejects a recipe whose declared scope is wider
 *      than the bundle's derived intersection.
 *    - `parseBundle` skips the recipe-level check when no
 *      `ingredients[]` are bundled.
 *    - `planBundleInstall` returns `kind: 'incompatible'` when the
 *      device's role isn't in the derived scope.
 *    - `planBundleInstall` returns `kind: 'ready'` when the role
 *      matches.
 *    - The install gate is a no-op without `installRole` or without
 *      bundled ingredients (marketplace install path responsibility).
 */

import { describe, it, expect } from 'vitest';

import type {
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';
import { validateIngredient } from '@recued/ingredients';
import { parseBundle } from '../parse-bundle.js';
import { planBundleInstall } from '../install-plan.js';

// ────────────────────────────────────────────────────────────────
// Shared fixtures
// ────────────────────────────────────────────────────────────────

const baseRecipe: RecipeDefinition = {
  recipe_id: 'detect-deal-risk-hubspot',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Detect Deal Risk',
    description: 'Flag deals at risk of slipping.',
    author: 'recued-core',
    supported_platforms: ['hubspot'],
    tags: ['hubspot', 'sales', 'crm'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'noop', transform: 'to_list', input: 'x' } as unknown as RecipeDefinition['steps'][number],
  ],
  output: { sidebar: [] },
};

const httpIngredient: IngredientManifest = {
  slug: 'deal-reader-hubspot',
  name: 'Deal Reader (HubSpot)',
  description: 'Reads deals from HubSpot.',
  author: 'recued-core',
  kind: 'http',
  category: 'data',
  risk_tier: 'read',
  input: { url: 'https://api.hubapi.com/crm/v3/objects/deals' },
  output: { deals: 'results' },
};

const domWriteIngredient: IngredientManifest = {
  slug: 'email-composer-hubspot',
  name: 'Email Composer (HubSpot)',
  description: 'Drafts an email in the HubSpot composer DOM.',
  author: 'recued-core',
  kind: 'dom',
  category: 'action',
  risk_tier: 'write',
  input: { subject: null, body: null },
  output: {
    'app.hubspot.com/contacts/*/email*': 'trigger',
    '[data-test-id="email-subject"]': 'dom.subject',
  },
};

const serviceTemplate: IngredientManifest = {
  slug: 'cloudflared-linux',
  kind: 'service',
  name: 'cloudflared (Linux)',
  description: 'Long-running Cloudflare Tunnel daemon.',
  author: 'recued-core',
  category: 'data',
  risk_tier: 'admin',
  tags: ['service', 'tunnel'],
  input: { service: { platform: 'linux' } },
  output: {},
};

const noopLookup = async (_k: string) => null;

// ────────────────────────────────────────────────────────────────
// validateIngredient — per-manifest gate
// ────────────────────────────────────────────────────────────────

describe('validateIngredient — execution_scope shape', () => {
  it('accepts a manifest without execution_scope', () => {
    const result = validateIngredient(httpIngredient);
    expect(result.valid).toBe(true);
  });

  it('accepts a declaration that matches derived scope', () => {
    const result = validateIngredient({ ...httpIngredient, execution_scope: ['device', 'server'] });
    expect(result.valid).toBe(true);
  });

  it('accepts a narrower declaration (subset of derived)', () => {
    const result = validateIngredient({ ...httpIngredient, execution_scope: ['device'] });
    expect(result.valid).toBe(true);
  });

  it('rejects an empty execution_scope array', () => {
    const result = validateIngredient({ ...httpIngredient, execution_scope: [] as unknown as IngredientManifest['execution_scope'] });
    expect(result.valid).toBe(false);
    expect(result.issues.find((i) => i.code === 'execution_scope_shape')).toBeDefined();
  });

  it('rejects an execution_scope with unknown values', () => {
    const result = validateIngredient({
      ...httpIngredient,
      execution_scope: ['device', 'cloud'] as unknown as IngredientManifest['execution_scope'],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.find((i) => i.code === 'execution_scope_shape')).toBeDefined();
  });

  it('rejects an execution_scope with duplicate members', () => {
    const result = validateIngredient({
      ...httpIngredient,
      execution_scope: ['device', 'device'] as unknown as IngredientManifest['execution_scope'],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.find((i) => i.code === 'execution_scope_shape')).toBeDefined();
  });
});

describe('validateIngredient — execution_scope subset rule', () => {
  it('rejects a too-wide scope on a DOM ingredient', () => {
    // DOM ingredient → derived ['device']. Declaring ['device','server'] is wider.
    const result = validateIngredient({ ...domWriteIngredient, execution_scope: ['device', 'server'] });
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.code === 'EXECUTION_SCOPE_TOO_WIDE');
    expect(issue).toBeDefined();
    expect(issue?.path).toBe('execution_scope');
  });

  it('rejects a too-wide scope on a service-template ingredient', () => {
    // kind:service → derived ['server']. Declaring ['device','server'] is wider.
    const result = validateIngredient({ ...serviceTemplate, execution_scope: ['device', 'server'] });
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.code === 'EXECUTION_SCOPE_TOO_WIDE');
    expect(issue).toBeDefined();
  });

  it('accepts a matching narrow scope on a DOM ingredient', () => {
    const result = validateIngredient({ ...domWriteIngredient, execution_scope: ['device'] });
    expect(result.valid).toBe(true);
  });

  it('accepts a matching narrow scope on a service template', () => {
    const result = validateIngredient({ ...serviceTemplate, execution_scope: ['server'] });
    expect(result.valid).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// parseBundle — recipe-level gate (uses bundled ingredients to derive)
// ────────────────────────────────────────────────────────────────

describe('parseBundle — recipe.metadata.execution_scope', () => {
  it('accepts a bundle without recipe.execution_scope', () => {
    const r = parseBundle({ recipe: baseRecipe, ingredients: [httpIngredient] });
    expect(r.ok).toBe(true);
  });

  it('accepts a bundle whose declared scope matches derived', () => {
    const recipe: RecipeDefinition = {
      ...baseRecipe,
      metadata: { ...baseRecipe.metadata, execution_scope: ['device', 'server'] },
    };
    const r = parseBundle({ recipe, ingredients: [httpIngredient] });
    expect(r.ok).toBe(true);
  });

  it('accepts a bundle whose declared scope narrows derived', () => {
    const recipe: RecipeDefinition = {
      ...baseRecipe,
      metadata: { ...baseRecipe.metadata, execution_scope: ['server'] },
    };
    const r = parseBundle({ recipe, ingredients: [httpIngredient] });
    expect(r.ok).toBe(true);
  });

  it('rejects a too-wide recipe scope (declared device+server, ingredients narrow to device)', () => {
    const recipe: RecipeDefinition = {
      ...baseRecipe,
      metadata: { ...baseRecipe.metadata, execution_scope: ['device', 'server'] },
    };
    const r = parseBundle({ recipe, ingredients: [domWriteIngredient] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.find((i) => i.code === 'EXECUTION_SCOPE_TOO_WIDE')).toBeDefined();
    }
  });

  it('rejects a recipe scope outside the derived (declared server, ingredients device-only)', () => {
    const recipe: RecipeDefinition = {
      ...baseRecipe,
      metadata: { ...baseRecipe.metadata, execution_scope: ['server'] },
    };
    const r = parseBundle({ recipe, ingredients: [domWriteIngredient] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.issues.find((i) => i.code === 'EXECUTION_SCOPE_TOO_WIDE');
      expect(issue).toBeDefined();
      expect(issue?.path).toBe('recipe.metadata.execution_scope');
    }
  });

  it('skips the recipe-level check when ingredients[] is absent (deferred to install gate)', () => {
    const recipe: RecipeDefinition = {
      ...baseRecipe,
      metadata: { ...baseRecipe.metadata, execution_scope: ['device', 'server'] },
    };
    const r = parseBundle({ recipe });
    expect(r.ok).toBe(true);
  });

  it('rejects a malformed recipe.execution_scope shape', () => {
    const recipe = {
      ...baseRecipe,
      metadata: { ...baseRecipe.metadata, execution_scope: ['device', 'cloud'] },
    } as unknown as RecipeDefinition;
    const r = parseBundle({ recipe });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.find((i) => i.code === 'execution_scope_shape')).toBeDefined();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// planBundleInstall — install gate
// ────────────────────────────────────────────────────────────────

describe('planBundleInstall — execution scope install gate', () => {
  it('returns kind:ready when installRole is in derived scope (device + http ingredient)', async () => {
    const out = await planBundleInstall({
      input: { recipe: baseRecipe, ingredients: [httpIngredient] },
      source: { kind: 'bundle-file', slug: 'detect-deal-risk-hubspot' },
      contentHash: 'h1',
      lookupExisting: noopLookup,
      installRole: 'device',
    });
    expect(out.kind).toBe('ready');
  });

  it('returns kind:ready when installRole is in derived scope (server + http ingredient)', async () => {
    const out = await planBundleInstall({
      input: { recipe: baseRecipe, ingredients: [httpIngredient] },
      source: { kind: 'bundle-file', slug: 'detect-deal-risk-hubspot' },
      contentHash: 'h1',
      lookupExisting: noopLookup,
      installRole: 'server',
    });
    expect(out.kind).toBe('ready');
  });

  it('returns kind:incompatible when installRole=server but a DOM ingredient pins device-only', async () => {
    const out = await planBundleInstall({
      input: { recipe: baseRecipe, ingredients: [domWriteIngredient] },
      source: { kind: 'bundle-file', slug: 'detect-deal-risk-hubspot' },
      contentHash: 'h1',
      lookupExisting: noopLookup,
      installRole: 'server',
    });
    expect(out.kind).toBe('incompatible');
    if (out.kind === 'incompatible') {
      expect(out.derivedScope).toEqual(['device']);
      expect(out.installRole).toBe('server');
    }
  });

  it('returns kind:incompatible when installRole=device but a service template pins server-only', async () => {
    const out = await planBundleInstall({
      input: { recipe: baseRecipe, ingredients: [serviceTemplate] },
      source: { kind: 'bundle-file', slug: 'detect-deal-risk-hubspot' },
      contentHash: 'h1',
      lookupExisting: noopLookup,
      installRole: 'device',
    });
    expect(out.kind).toBe('incompatible');
    if (out.kind === 'incompatible') {
      expect(out.derivedScope).toEqual(['server']);
      expect(out.installRole).toBe('device');
    }
  });

  it('skips the gate when installRole is omitted', async () => {
    const out = await planBundleInstall({
      input: { recipe: baseRecipe, ingredients: [domWriteIngredient] },
      source: { kind: 'bundle-file', slug: 'detect-deal-risk-hubspot' },
      contentHash: 'h1',
      lookupExisting: noopLookup,
    });
    expect(out.kind).toBe('ready');
  });

  it('skips the gate when no ingredients[] are bundled (marketplace path)', async () => {
    const out = await planBundleInstall({
      input: { recipe: baseRecipe },
      source: { kind: 'bundle-file', slug: 'detect-deal-risk-hubspot' },
      contentHash: 'h1',
      lookupExisting: noopLookup,
      installRole: 'server',
    });
    expect(out.kind).toBe('ready');
  });
});
