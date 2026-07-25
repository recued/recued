import { describe, it, expect } from 'vitest';
import { validateIngredientRefs, type IngredientIssue } from '../validate-ingredients.js';
import type { RecipeDefinition, IngredientManifest } from '@recued/contracts';

// ── Helpers ──

const mkManifest = (slug: string, overrides: Partial<IngredientManifest> = {}): IngredientManifest => ({
  slug,
  name: slug,
  description: 'test',
  author: 'test',
  kind: 'http',
  category: 'data',
  risk_tier: 'read',
  input: { entity_id: null, method: 'GET', url: 'https://api.example.com/{{entity_id}}' },
  output: { name: 'properties.name', amount: 'properties.amount', status: 'properties.status' },
  ...overrides,
});

const mkRecipe = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'test-recipe',
  version: 1,
  ttl: 300,
  metadata: { name: 'Test', author: 'test', supported_platforms: [], tags: [] },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  ...overrides,
} as RecipeDefinition);

const mkLookup = (manifests: Record<string, IngredientManifest>) =>
  async (slug: string) => manifests[slug] ?? null;

const codes = (issues: IngredientIssue[]) => issues.map((i) => i.code);
const errors = (issues: IngredientIssue[]) => issues.filter((i) => i.severity === 'error');
const warnings = (issues: IngredientIssue[]) => issues.filter((i) => i.severity === 'warning');

// ── Tests ──

describe('validateIngredientRefs — input validation', () => {
  it('no issues when inputs match manifest', async () => {
    const manifest = mkManifest('reader', { input: { entity_id: null, method: 'GET', url: 'x' } });
    const recipe = mkRecipe({
      prefetch_steps: [{ id: 'data', ingredient: 'reader', input: { entity_id: '123' } }],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ reader: manifest }));
    expect(errors(issues)).toHaveLength(0);
  });

  it('error when required input missing', async () => {
    const manifest = mkManifest('reader', { input: { entity_id: null } });
    const recipe = mkRecipe({
      prefetch_steps: [{ id: 'data', ingredient: 'reader', input: {} }],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ reader: manifest }));
    expect(codes(issues)).toContain('input_required');
    expect(errors(issues)[0].field).toBe('entity_id');
  });

  it('does not let inherited input fields satisfy required manifest keys', async () => {
    const manifest = mkManifest('reader', { input: { entity_id: null } });
    const inheritedInput = Object.create({ entity_id: '123' });
    const recipe = mkRecipe({
      prefetch_steps: [{ id: 'data', ingredient: 'reader', input: inheritedInput }],
    });

    const issues = await validateIngredientRefs(recipe, mkLookup({ reader: manifest }));

    expect(codes(issues)).toContain('input_required');
    expect(errors(issues)[0].field).toBe('entity_id');
  });

  it('warns (deprecation) when extra input supplied — undeclared_input_key_deprecated (D-112 C2 migration)', async () => {
    const manifest = mkManifest('reader', { input: { entity_id: null } });
    const recipe = mkRecipe({
      prefetch_steps: [{ id: 'data', ingredient: 'reader', input: { entity_id: '123', extra_field: 'ignored' } }],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ reader: manifest }));
    expect(codes(issues)).toContain('undeclared_input_key_deprecated');
    expect(
      issues.find((i) => i.code === 'undeclared_input_key_deprecated')?.field,
    ).toBe('extra_field');
  });

  it('skips framework fields (method, url, header.*)', async () => {
    const manifest = mkManifest('reader', { input: { method: 'GET', url: 'x', 'header.authorization': 'Bearer X' } });
    const recipe = mkRecipe({
      prefetch_steps: [{ id: 'data', ingredient: 'reader', input: {} }],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ reader: manifest }));
    // Framework fields should not produce input_required errors
    expect(errors(issues)).toHaveLength(0);
  });
});

describe('validateIngredientRefs — output validation', () => {
  it('no issues when referenced fields exist in output', async () => {
    const manifest = mkManifest('reader');
    const recipe = mkRecipe({
      prefetch_steps: [{ id: 'data', ingredient: 'reader', input: { entity_id: '1' } }],
      steps: [{ id: 'show', transform: 'template', text: '{{step.data.name}} has {{step.data.amount}}' }],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ reader: manifest }));
    expect(warnings(issues).filter((i) => i.code === 'output_field_unknown')).toHaveLength(0);
  });

  it('warning when referenced field not in output', async () => {
    const manifest = mkManifest('reader', { output: { name: 'properties.name' } });
    const recipe = mkRecipe({
      prefetch_steps: [{ id: 'data', ingredient: 'reader', input: { entity_id: '1' } }],
      steps: [{ id: 'show', transform: 'template', text: '{{step.data.nonexistent_field}}' }],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ reader: manifest }));
    expect(codes(issues)).toContain('output_field_unknown');
    expect(issues.find((i) => i.code === 'output_field_unknown')?.field).toBe('nonexistent_field');
  });

  it('no warning for nested paths when top-level exists', async () => {
    const manifest = mkManifest('reader', { output: { custom_fields: 'properties' } });
    const recipe = mkRecipe({
      prefetch_steps: [{ id: 'data', ingredient: 'reader', input: { entity_id: '1' } }],
      steps: [{ id: 'show', transform: 'template', text: '{{step.data.custom_fields.priority}}' }],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ reader: manifest }));
    expect(warnings(issues).filter((i) => i.code === 'output_field_unknown')).toHaveLength(0);
  });
});

describe('validateIngredientRefs — ingredient lookup', () => {
  it('warning when ingredient not found', async () => {
    const recipe = mkRecipe({
      prefetch_steps: [{ id: 'data', ingredient: 'missing-ingredient', input: {} }],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({}));
    expect(codes(issues)).toContain('ingredient_not_found');
  });

  it('handles sequential ingredient steps', async () => {
    const manifest = mkManifest('writer', { input: { deal_id: null, note: null }, output: {} });
    const recipe = mkRecipe({
      steps: [
        { id: 'write', ingredient: 'writer', input: { deal_id: '1' } } as any,
      ],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ writer: manifest }));
    expect(codes(issues)).toContain('input_required');
    expect(errors(issues)[0].field).toBe('note');
  });

  it('skips transform and guard steps', async () => {
    const recipe = mkRecipe({
      steps: [
        { id: 'calc', transform: 'math', op: 'add', a: 1, b: 2 } as any,
        { id: 'check', guard: '{{step.calc}} greater 0' } as any,
      ],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({}));
    expect(issues).toHaveLength(0);
  });

  it('ignores inherited ingredient discriminators', async () => {
    const inheritedStep = Object.create({
      id: 'write',
      ingredient: 'writer',
      input: { deal_id: '1' },
    });
    const manifest = mkManifest('writer', { input: { deal_id: null, note: null }, output: {} });
    const recipe = mkRecipe({
      steps: [inheritedStep] as never,
    });

    const issues = await validateIngredientRefs(recipe, mkLookup({ writer: manifest }));

    expect(issues).toHaveLength(0);
  });
});

describe('validateIngredientRefs — version compatibility', () => {
  it('error when pinned version is below manifest min_version (breaking change)', async () => {
    const manifest = mkManifest('reader', { version: 3, min_version: 2 });
    const recipe = mkRecipe({
      prefetch_steps: [
        { id: 'data', ingredient: 'reader', ingredient_version: 1, input: { entity_id: '1' } },
      ],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ reader: manifest }));
    expect(codes(issues)).toContain('ingredient_breaking_change');
    expect(errors(issues).find((i) => i.code === 'ingredient_breaking_change')).toBeDefined();
  });

  it('info when pinned version is behind manifest version (no min_version trip)', async () => {
    const manifest = mkManifest('reader', { version: 3 });
    const recipe = mkRecipe({
      prefetch_steps: [
        { id: 'data', ingredient: 'reader', ingredient_version: 1, input: { entity_id: '1' } },
      ],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ reader: manifest }));
    expect(codes(issues)).toContain('ingredient_version_behind');
  });

  it('no version issue when pinned matches current', async () => {
    const manifest = mkManifest('reader', { version: 2 });
    const recipe = mkRecipe({
      prefetch_steps: [
        { id: 'data', ingredient: 'reader', ingredient_version: 2, input: { entity_id: '1' } },
      ],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ reader: manifest }));
    expect(codes(issues)).not.toContain('ingredient_version_behind');
    expect(codes(issues)).not.toContain('ingredient_breaking_change');
  });

  it('handles service-kind manifests via the same integer comparison', async () => {
    // After the binary_version refactor, service manifests use the
    // same integer `manifest.version` as marketplace ingredients —
    // the binary release semver lives separately at
    // `input.service.binary_version`. Version pinning works the
    // same way for both kinds.
    const manifest = mkManifest('svc', { version: 2 });
    const recipe = mkRecipe({
      prefetch_steps: [
        { id: 'data', ingredient: 'svc', ingredient_version: 1, input: { entity_id: '1' } },
      ],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ svc: manifest }));
    expect(codes(issues)).toContain('ingredient_version_behind');
  });
});

describe('validateIngredientRefs — multiple steps', () => {
  it('validates all ingredient steps independently', async () => {
    const m1 = mkManifest('reader-a', { input: { id_a: null }, output: { field_a: 'x' } });
    const m2 = mkManifest('reader-b', { input: { id_b: null }, output: { field_b: 'y' } });
    const recipe = mkRecipe({
      prefetch_steps: [
        { id: 'a', ingredient: 'reader-a', input: {} },
        { id: 'b', ingredient: 'reader-b', input: { id_b: '1' } },
      ],
      steps: [
        { id: 'show', transform: 'template', text: '{{step.a.wrong}} {{step.b.field_b}}' },
      ],
    });
    const issues = await validateIngredientRefs(recipe, mkLookup({ 'reader-a': m1, 'reader-b': m2 }));
    expect(errors(issues).filter((i) => i.step_id === 'a' && i.code === 'input_required')).toHaveLength(1);
    expect(warnings(issues).filter((i) => i.step_id === 'a' && i.code === 'output_field_unknown')).toHaveLength(1);
    // b has no issues
    expect(issues.filter((i) => i.step_id === 'b' && i.severity === 'error')).toHaveLength(0);
  });
});
