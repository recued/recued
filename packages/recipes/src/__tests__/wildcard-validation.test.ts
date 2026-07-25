/** D-112 C2 — parseRecipe wildcard + lock validation tests. */

import { describe, expect, it } from 'vitest';
import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';
import {
  validateIngredientRefs,
  type IngredientIssue,
} from '../validate-ingredients.js';

const manifest = (overrides: Partial<IngredientManifest> = {}): IngredientManifest => ({
  slug: 'update-deal-hubspot',
  author: 'recued-core',
  name: 'Update deal',
  description: 'Patch a HubSpot deal',
  version: 1,
  kind: 'http',
  category: 'action',
  risk_tier: 'write',
  input: {},
  output: { ok: '$.ok' },
  ...overrides,
});

const recipe = (
  stepInput: Record<string, unknown>,
  slug = 'update-deal-hubspot',
): RecipeDefinition => ({
  recipe_id: 't',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'test',
    description: '',
    author: 'test',
    supported_platforms: [],
    tags: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'upd',
      ingredient: slug,
      input: stepInput,
    } as never,
  ],
  output: { sidebar: [] },
});

const codes = (issues: IngredientIssue[]): string[] => issues.map((i) => i.code).sort();

describe('D-112 C2 — engine lock enforcement', () => {
  it('errors on locked keys regardless of manifest declarations', async () => {
    const m = manifest({ input: { method: 'PATCH', url: 'https://api.hubapi.com/x', body: null } });
    const r = recipe({
      method: 'DELETE', // locked
      url: 'https://evil.example/x', // locked
      body: { id: 1 },
    });
    const issues = await validateIngredientRefs(r, async () => m);
    const locked = issues.filter((i) => i.code === 'locked_input_key');
    expect(locked.map((i) => i.field).sort()).toEqual(['method', 'url']);
    for (const i of locked) expect(i.severity).toBe('error');
  });

  it('errors on header.authorization + header.cookie + header.host overrides', async () => {
    const m = manifest({ input: { 'header.authorization': 'Bearer X', 'body.id': null } });
    const r = recipe({
      'header.authorization': 'Bearer pwned',
      'header.cookie': 'session=attacker',
      'header.host': 'evil.example',
      'body.id': 1,
    });
    const issues = await validateIngredientRefs(r, async () => m);
    const locked = issues.filter((i) => i.code === 'locked_input_key');
    expect(locked.map((i) => i.field).sort()).toEqual([
      'header.authorization',
      'header.cookie',
      'header.host',
    ]);
  });

  it('still allows non-locked header overrides (x-api-key stays open)', async () => {
    const m = manifest({
      input: { 'header.x-api-key': null },
    });
    const r = recipe({ 'header.x-api-key': 'user-token' });
    const issues = await validateIngredientRefs(r, async () => m);
    expect(codes(issues)).not.toContain('locked_input_key');
  });

  it('does not emit required-field error for missing locked keys in manifest', async () => {
    // Ingredient authors might type `url: null` in a manifest — the engine
    // provides it. The required-field check must skip locked keys or it
    // fires a spurious "url not provided" error.
    const m = manifest({ input: { url: null as unknown as string, 'body.x': null } });
    const r = recipe({ 'body.x': 1 });
    const issues = await validateIngredientRefs(r, async () => m);
    expect(
      issues.find((i) => i.code === 'input_required' && i.field === 'url'),
    ).toBeUndefined();
  });
});

describe('D-112 C2 — wildcard admission', () => {
  it('admits single-level children of prefix.* wildcards', async () => {
    const m = manifest({
      input: {
        'body.properties.*': null,
        'body.properties.dealname': null, // explicit required field
      },
    });
    const r = recipe({
      'body.properties.dealname': 'Acme',
      'body.properties.amount': 5000,
      'body.properties.tenant_custom_field': 'foo',
    });
    const issues = await validateIngredientRefs(r, async () => m);
    expect(codes(issues)).not.toContain('undeclared_input_key');
    expect(codes(issues)).not.toContain('undeclared_input_key_deprecated');
  });

  it('rejects nested keys (prefix.X.Y) — single level only', async () => {
    const m = manifest({ input: { 'body.*': null } });
    const r = recipe({ 'body.nested.deep': 'no' });
    const issues = await validateIngredientRefs(r, async () => m, { strict: true });
    expect(codes(issues)).toContain('undeclared_input_key');
  });

  it('explicit declaration still wins over wildcard (required semantics)', async () => {
    const m = manifest({
      input: { 'body.properties.dealname': null, 'body.properties.*': null },
    });
    // Omitting dealname should still trigger the required-field error
    // because the explicit declaration's null-value semantics apply first.
    const r = recipe({ 'body.properties.amount': 5000 });
    const issues = await validateIngredientRefs(r, async () => m);
    const missing = issues.find((i) => i.code === 'input_required');
    expect(missing).toBeDefined();
    expect(missing!.field).toBe('body.properties.dealname');
  });

  it('multiple wildcards in one manifest admit different prefixes', async () => {
    const m = manifest({
      input: { 'body.properties.*': null, 'body.metadata.*': null },
    });
    const r = recipe({
      'body.properties.amount': 1,
      'body.metadata.source': 'kitchen',
    });
    const issues = await validateIngredientRefs(r, async () => m);
    expect(codes(issues).filter((c) => c.startsWith('undeclared'))).toEqual([]);
  });

  it('wildcard cannot admit locked keys', async () => {
    const m = manifest({ input: { 'header.*': null } });
    const r = recipe({
      'header.authorization': 'pwned',
      'header.x-custom': 'ok',
    });
    const issues = await validateIngredientRefs(r, async () => m);
    const locked = issues.find((i) => i.code === 'locked_input_key');
    expect(locked).toBeDefined();
    expect(locked!.field).toBe('header.authorization');
    // The custom one passes via the wildcard.
    expect(
      issues.find((i) => i.field === 'header.x-custom' && i.code.startsWith('undeclared')),
    ).toBeUndefined();
  });
});

describe('D-112 C2 — strict mode flag', () => {
  it('permissive default warns on undeclared keys', async () => {
    const m = manifest({ input: { 'body.x': null } });
    const r = recipe({ 'body.x': 1, 'body.mystery': 'z' });
    const issues = await validateIngredientRefs(r, async () => m);
    const deprecated = issues.filter((i) => i.code === 'undeclared_input_key_deprecated');
    expect(deprecated).toHaveLength(1);
    expect(deprecated[0].severity).toBe('warning');
  });

  it('strict mode errors on undeclared keys', async () => {
    const m = manifest({ input: { 'body.x': null } });
    const r = recipe({ 'body.x': 1, 'body.mystery': 'z' });
    const issues = await validateIngredientRefs(r, async () => m, { strict: true });
    const undeclared = issues.filter((i) => i.code === 'undeclared_input_key');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0].severity).toBe('error');
  });

  it('strict mode does NOT flag wildcard-admitted keys', async () => {
    const m = manifest({ input: { 'body.properties.*': null } });
    const r = recipe({ 'body.properties.x': 1, 'body.properties.y': 2 });
    const issues = await validateIngredientRefs(r, async () => m, { strict: true });
    expect(codes(issues)).not.toContain('undeclared_input_key');
  });
});

describe('D-112 C2 — existing behaviour preserved', () => {
  it('still errors on missing ingredients with warning severity', async () => {
    const r = recipe({ x: 1 }, 'unknown-slug');
    const issues = await validateIngredientRefs(r, async () => null);
    expect(issues.some((i) => i.code === 'ingredient_not_found')).toBe(true);
  });

  it('still produces input_required for omitted required fields', async () => {
    const m = manifest({ input: { 'body.id': null } });
    const r = recipe({});
    const issues = await validateIngredientRefs(r, async () => m);
    expect(
      issues.some((i) => i.code === 'input_required' && i.field === 'body.id'),
    ).toBe(true);
  });
});
