import { describe, expect, it } from 'vitest';
import type { CompositionIngredient } from '@recued/contracts';
import { decomposeComposition } from '../decomposer.js';
import { validateComposition } from '../validators.js';

const composition = (): CompositionIngredient => ({
  schema_version: 1,
  slug: 'webhook-operation-fixture',
  catalog_kind: 'private_byo',
  ingredients: [{
    slug: 'webhook-operation-fixture',
    kind: 'http',
    http: {
      base: 'https://fixture.invalid',
      connection: 'fixture-provider',
    },
  }],
  operations: [{
    op: 'resource.create',
    ingredient: 'webhook-operation-fixture',
    risk: 'write',
    approval: 'never',
    bind: {
      kind: 'rest',
      method: 'POST',
      path_template: '/resources',
    },
    operation_bound_webhook: {
      binding: 'fixture_events',
      intent: 'attach',
    },
    cache_ttl_ms: 0,
  }],
});

describe('D-201 Slice 6B3 operation-bound pack lowering', () => {
  it('keeps a one-operation composition on the catalog path and preserves the declaration', () => {
    const authored = composition();
    const validation = validateComposition(authored);
    expect(validation.issues.filter((issue) => issue.severity === 'error')).toEqual([]);

    const decomposed = decomposeComposition[1]!(authored);
    expect(decomposed.ingredient).toBeUndefined();
    expect(decomposed.catalog?.operations?.['resource.create']?.operation_bound_webhook)
      .toEqual({ binding: 'fixture_events', intent: 'attach' });
    expect(decomposed.catalog?.surfaces?.api?.executes?.['resource.create'])
      .toMatchObject({ kind: 'rest', method: 'POST', path_template: '/resources' });
  });
});
