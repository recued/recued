/** The server's word on what each step does to the owner's records — the host
 *  half of "read fresh before a write" (engine `step-seed.ts`). A catalog is
 *  judged by its OWN operation: the wrapper is read/data whatever it runs. */

import type { IngredientManifest, RecipeStep } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createStepEffect } from '../step-effect.js';

const CATALOG = {
  slug: 'crm-catalog', name: 'CRM Catalog', description: 'x', author: 'x', kind: 'connection', version: 1,
  category: 'data', risk_tier: 'read', input: { operation: null, args: null }, output: { result: 'result' },
  operations: {
    'deal.get': { risk_tier: 'read' },
    'deal.update': { risk_tier: 'write' },
  },
} as unknown as IngredientManifest;

const manifests = new Map<string, IngredientManifest>([
  ...KERNEL_MANIFESTS.map((m) => [m.slug, m] as const),
  [CATALOG.slug, CATALOG],
]);
const effect = createStepEffect((slug) => manifests.get(slug));
const step = (over: Record<string, unknown>) => ({ id: 's', ...over }) as unknown as RecipeStep;

describe('createStepEffect', () => {
  it('a kernel read of the owner’s records is an own read; a kernel write writes', () => {
    expect(effect(step({ ingredient: 'shared-read' }))).toBe('own_read');
    expect(effect(step({ ingredient: 'shared-write' }))).toBe('write');
    expect(effect(step({ ingredient: 'task-update' }))).toBe('write');
  });

  it('AI and transforms keep their cache', () => {
    expect(effect(step({ ingredient: 'ai-summarize' }))).toBe('other');
    expect(effect(step({ transform: 'trim', input: 'x' }))).toBe('other');
  });

  it('⛔ a catalog is judged by its own operation, and one it cannot name counts as a write', () => {
    expect(effect(step({ ingredient: 'crm-catalog', input: { operation: 'deal.get' } }))).toBe('other');
    expect(effect(step({ ingredient: 'crm-catalog', input: { operation: 'deal.update' } }))).toBe('write');
    expect(effect(step({ ingredient: 'crm-catalog', input: { operation: '{{config.op}}' } }))).toBe('write');
    expect(effect(step({ ingredient: 'crm-catalog', input: '{{config.call}}' }))).toBe('write');
    expect(effect(step({ ingredient: 'crm-catalog', input: { operation: 'deal.unknown' } }))).toBe('write');
  });

  it('an ingredient named at run time counts as a write; an unknown one as neither', () => {
    expect(effect(step({ ingredient: '{{config.ingredient_slug}}' }))).toBe('write');
    expect(effect(step({ ingredient: 'no-such-ingredient' }))).toBe('other');
  });
});
