import { describe, it, expect } from 'vitest';
import { createDryRunExecutor, generateMockData } from '../dry-run.js';
import type { IngredientManifest } from '@recued/contracts';

const mkManifest = (
  overrides: Partial<IngredientManifest> = {},
): IngredientManifest => ({
  slug: 'deal-reader-hubspot',
  name: 'Deal Reader',
  description: 'test',
  author: 'recued-core',
  kind: 'http',
  category: 'data',
  risk_tier: 'read',
  input: { deal_id: null },
  output: {
    deal_id: 'deal_id',
    deal_name: 'deal_name',
    amount: 'amount',
    stage: 'stage',
    close_date: 'close_date',
    owner_id: 'owner_id',
  },
  ...overrides,
});

const mkLoader = (table: Record<string, IngredientManifest>) =>
  async (slug: string) => table[slug] ?? null;

// ────────────────────────────────────────────────────────────────
// generateMockData
// ────────────────────────────────────────────────────────────────

describe('generateMockData', () => {
  it('generates one field per output entry', () => {
    const mock = generateMockData(mkManifest());
    expect(Object.keys(mock)).toEqual([
      'deal_id', 'deal_name', 'amount', 'stage', 'close_date', 'owner_id',
    ]);
  });

  it('produces a string for id fields', () => {
    const mock = generateMockData(mkManifest());
    expect(typeof mock.deal_id).toBe('string');
    expect(typeof mock.owner_id).toBe('string');
  });

  it('produces a number for amount fields', () => {
    const mock = generateMockData(mkManifest());
    expect(typeof mock.amount).toBe('number');
  });

  it('produces a date string for date fields', () => {
    const mock = generateMockData(mkManifest());
    expect(typeof mock.close_date).toBe('string');
    expect(mock.close_date).toMatch(/^\d{4}-/);
  });

  it('produces a string for name fields', () => {
    const mock = generateMockData(mkManifest());
    expect(typeof mock.deal_name).toBe('string');
    expect((mock.deal_name as string).length).toBeGreaterThan(0);
  });

  it('returns empty object when manifest has no output', () => {
    const mock = generateMockData(mkManifest({ output: {} }));
    expect(mock).toEqual({});
  });

  it('generates AI-specific fields for AI manifests', () => {
    const mock = generateMockData(mkManifest({
      slug: 'ai-classify',
      category: 'ai',
      output: {
        category: 'category',
        confidence: 'confidence',
        reasoning: 'reasoning',
      },
    }));
    expect(mock.category).toBe('medium');
    expect(typeof mock.confidence).toBe('number');
    expect(typeof mock.reasoning).toBe('string');
  });

  it('generates array fields for breakdown/signals', () => {
    const mock = generateMockData(mkManifest({
      slug: 'ai-score',
      category: 'ai',
      output: {
        score: 'score',
        breakdown: 'breakdown',
        reasoning: 'reasoning',
      },
    }));
    expect(Array.isArray(mock.breakdown)).toBe(true);
    expect((mock.breakdown as unknown[]).length).toBeGreaterThan(0);
  });

  it('is deterministic (same input → same output)', () => {
    const manifest = mkManifest();
    const a = generateMockData(manifest);
    const b = generateMockData(manifest);
    expect(a).toEqual(b);
  });

  it('drops prototype-sensitive output field names', () => {
    const mock = generateMockData(mkManifest({
      output: {
        id: 'safe_id',
        payload: '__proto__',
        shadow: 'constructor',
        proto: 'prototype',
      },
    }));
    expect(mock.safe_id).toBe('mock-safe_id-001');
    expect(Object.getPrototypeOf(mock)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(mock, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mock, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mock, 'prototype')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// createDryRunExecutor
// ────────────────────────────────────────────────────────────────

describe('createDryRunExecutor', () => {
  it('returns mock data for a known ingredient slug', async () => {
    const executor = createDryRunExecutor(mkLoader({
      'deal-reader-hubspot': mkManifest(),
    }));
    const result = await executor('deal-reader-hubspot', { deal_id: '42' });
    expect(result).toEqual(expect.objectContaining({
      deal_id: expect.any(String),
      amount: expect.any(Number),
    }));
  });

  it('throws INGREDIENT_NOT_FOUND for unknown slugs', async () => {
    const executor = createDryRunExecutor(mkLoader({}));
    await expect(
      executor('nonexistent-ingredient', {}),
    ).rejects.toThrow(/no manifest found/);
  });

  it('uses caller-supplied fixtures when provided', async () => {
    const fixtures = {
      'deal-reader-hubspot': { deal_name: 'Custom Fixture', amount: 99 },
    };
    const executor = createDryRunExecutor(
      mkLoader({ 'deal-reader-hubspot': mkManifest() }),
      fixtures,
    );
    const result = await executor('deal-reader-hubspot', {});
    expect(result).toEqual({ deal_name: 'Custom Fixture', amount: 99 });
  });

  it('falls back to manifest-generated data when fixture is absent', async () => {
    const fixtures = {
      'other-ingredient': { data: 'custom' },
    };
    const executor = createDryRunExecutor(
      mkLoader({ 'deal-reader-hubspot': mkManifest() }),
      fixtures,
    );
    const result = await executor('deal-reader-hubspot', {});
    // Should be generated from manifest, not the fixture
    expect(result).toEqual(expect.objectContaining({ deal_id: expect.any(String) }));
  });

  it('ignores the input parameter (mock data is manifest-driven)', async () => {
    const executor = createDryRunExecutor(mkLoader({
      'deal-reader-hubspot': mkManifest(),
    }));
    const a = await executor('deal-reader-hubspot', { deal_id: '1' });
    const b = await executor('deal-reader-hubspot', { deal_id: '999' });
    expect(a).toEqual(b);
  });

  it('attaches INGREDIENT_NOT_FOUND code on the error', async () => {
    const executor = createDryRunExecutor(mkLoader({}));
    try {
      await executor('missing', {});
    } catch (e) {
      expect((e as { code: string }).code).toBe('INGREDIENT_NOT_FOUND');
      return;
    }
    throw new Error('expected throw');
  });
});

// ────────────────────────────────────────────────────────────────
// Field-name heuristics — exhaustive branch coverage
// ────────────────────────────────────────────────────────────────

describe('generateMockData — field heuristics', () => {
  const mockForField = (field: string, manifestOverrides: Partial<IngredientManifest> = {}) => {
    const m = generateMockData(mkManifest({
      output: { [field]: field },
      ...manifestOverrides,
    }));
    return m[field];
  };

  it('returns mock-id strings for id-like field names', () => {
    expect(mockForField('id')).toBe('mock-id-001');
    expect(mockForField('contact_id')).toBe('mock-contact_id-001');
    // endsWith('id') without underscore — e.g. "userid"
    expect(mockForField('userid')).toBe('mock-userid-001');
  });

  it('returns 42000 for money/count keywords', () => {
    expect(mockForField('price')).toBe(42000);
    expect(mockForField('revenue')).toBe(42000);
    expect(mockForField('cost')).toBe(42000);
    expect(mockForField('total_value')).toBe(42000);
    expect(mockForField('item_count')).toBe(42000);
  });

  it('returns 0.85 for score/confidence/percentage keywords', () => {
    expect(mockForField('score')).toBe(0.85);
    expect(mockForField('confidence')).toBe(0.85);
    expect(mockForField('match_percentage')).toBe(0.85);
  });

  it('returns a date string for date/timestamp/_at fields', () => {
    expect(mockForField('close_date')).toBe('2025-01-15T10:30:00Z');
    expect(mockForField('timestamp')).toBe('2025-01-15T10:30:00Z');
    expect(mockForField('created_at')).toBe('2025-01-15T10:30:00Z');
  });

  it('returns true for is_/has_ booleans', () => {
    expect(mockForField('is_active')).toBe(true);
    expect(mockForField('has_access')).toBe(true);
  });

  it('returns an object array for breakdown/signals/key_points', () => {
    const r = mockForField('breakdown') as unknown[];
    expect(Array.isArray(r)).toBe(true);
    expect(r[0]).toMatchObject({ label: expect.any(String), value: 'placeholder' });

    expect(Array.isArray(mockForField('signals'))).toBe(true);
    expect(Array.isArray(mockForField('key_points'))).toBe(true);
  });

  it('returns a string array for differences/similarities', () => {
    const r = mockForField('differences') as string[];
    expect(Array.isArray(r)).toBe(true);
    expect(typeof r[0]).toBe('string');
    expect(Array.isArray(mockForField('similarities'))).toBe(true);
  });

  it('returns exact AI-specific values for category/sentiment/source_language', () => {
    expect(mockForField('category')).toBe('medium');
    expect(mockForField('sentiment')).toBe('positive');
    expect(mockForField('source_language')).toBe('en');
  });

  it('returns slug-templated strings for reasoning/recommendation', () => {
    const manifest = mkManifest({ slug: 'ai-compare', output: { reasoning: 'reasoning', recommendation: 'recommendation' } });
    const mock = generateMockData(manifest);
    expect(mock.reasoning).toMatch(/ai-compare/);
    expect(mock.recommendation).toMatch(/ai-compare/);
  });

  it('returns slug+field-templated strings for summary/content/rewritten/translated', () => {
    for (const f of ['summary', 'content', 'rewritten', 'translated']) {
      expect(typeof mockForField(f, { slug: 'any' })).toBe('string');
      expect(mockForField(f, { slug: 'any' })).toMatch(/any/);
    }
  });

  it('returns a slug-templated string for result', () => {
    expect(mockForField('result', { slug: 'ai-prompt' })).toBe('Mock result from ai-prompt.');
  });

  it('returns Mock-prefixed strings for name/title/label', () => {
    expect(mockForField('deal_name')).toBe('Mock deal_name');
    expect(mockForField('title')).toBe('Mock title');
    expect(mockForField('label')).toBe('Mock label');
  });

  it('returns domain-formatted values for contact/business strings', () => {
    expect(mockForField('contact_email')).toBe('mock@example.com');
    expect(mockForField('phone_number')).toBe('+1-555-0100');
    expect(mockForField('profile_url')).toBe('https://mock.example.com');
    expect(mockForField('domain')).toBe('https://mock.example.com');
    expect(mockForField('stage')).toBe('open');
    expect(mockForField('pipeline')).toBe('default');
    expect(mockForField('industry')).toBe('Technology');
    // 'company' alone — `includes('name')` branch above would intercept 'company_name'.
    expect(mockForField('company')).toBe('Mock Corp');
  });

  it('returns descriptive strings for body/subject/description', () => {
    expect(mockForField('body')).toMatch(/dry-run/);
    expect(mockForField('subject')).toMatch(/dry-run/);
    expect(mockForField('description')).toMatch(/dry-run/);
  });

  it('returns an empty object for custom_fields', () => {
    expect(mockForField('custom_fields')).toEqual({});
  });

  it('falls back to mock-{field} for unknown names', () => {
    expect(mockForField('mystery_thing')).toBe('mock-mystery_thing');
  });

  it('skips output entries whose value is not a string', () => {
    const manifest = mkManifest({
      output: {
        deal_id: 'deal_id',
        weird: 123 as unknown as string,
        nested: {} as unknown as string,
      },
    });
    const mock = generateMockData(manifest);
    expect(mock).toEqual({ deal_id: 'mock-deal_id-001' });
  });

  it('returns {} when manifest.output is missing or not an object', () => {
    expect(generateMockData(mkManifest({ output: undefined as unknown as Record<string, string> })))
      .toEqual({});
    expect(generateMockData(mkManifest({ output: null as unknown as Record<string, string> })))
      .toEqual({});
  });
});
