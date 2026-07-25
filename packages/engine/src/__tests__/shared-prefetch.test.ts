import { describe, expect, it, vi } from 'vitest';

import { resolveValue, type NamespaceStores, type RecipeStep } from '@recued/contracts';

import { prefetchSharedRefs, type SharedKeyResolver } from '../shared-prefetch.js';

const mkResolver = (entries: Record<string, unknown>): SharedKeyResolver => ({
  async lookup(key: string) {
    return key in entries ? entries[key] : null;
  },
});

const mkStores = (overrides: Partial<NamespaceStores> = {}): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
  ...overrides,
});

describe('prefetchSharedRefs', () => {
  it('populates stores.shared with exact-key hits', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { value: '{{shared.counter}}' },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {
      shared: mkResolver({ counter: 42 }),
    });
    expect(resolveValue('{{shared.counter}}', stores)).toBe(42);
  });

  it('longest-match resolves flat-leaf storage', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { stage: '{{shared.deal.123.stage}}' },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {
      shared: mkResolver({ 'deal.123.stage': 'closed_won' }),
    });
    expect(resolveValue('{{shared.deal.123.stage}}', stores)).toBe('closed_won');
  });

  it('longest-match walks into blob storage', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { stage: '{{shared.deal.123.stage}}' },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {
      shared: mkResolver({ 'deal.123': { stage: 'open', amount: 9000 } }),
    });
    expect(resolveValue('{{shared.deal.123.stage}}', stores)).toBe('open');
    expect(resolveValue('{{shared.deal.123.amount}}', stores)).toBe(9000);
  });

  it('skips prototype-sensitive shared path segments', async () => {
    const stores = mkStores();
    const lookup = vi.fn().mockImplementation(async (key: string) => {
      if (key === 'safe') return 'kept';
      return { polluted: true };
    });
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: {
        safe: '{{shared.safe}}',
        unsafe: '{{shared.constructor.polluted}}',
      },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {
      shared: { lookup },
    });
    expect(resolveValue('{{shared.safe}}', stores)).toBe('kept');
    expect(resolveValue('{{shared.constructor.polluted}}', stores)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalledWith('constructor.polluted');
    expect(lookup).not.toHaveBeenCalledWith('constructor');
  });

  it('populates stores.data.shared for data.shared.* refs', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { dv: '{{data.shared.deal.123.value}}' },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {
      dataShared: mkResolver({ 'deal.123': { value: 5000 } }),
    });
    expect(resolveValue('{{data.shared.deal.123.value}}', stores)).toBe(5000);
  });

  it('falls back across shorter prefixes when a longer key is missing', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { x: '{{shared.a.b.c}}' },
    } as RecipeStep;
    const lookup = vi.fn().mockImplementation(async (key: string) => {
      if (key === 'a.b.c') return null;
      if (key === 'a.b') return null;
      if (key === 'a') return { b: { c: 'got-it' } };
      return null;
    });
    await prefetchSharedRefs(step, stores, { shared: { lookup } });
    expect(lookup).toHaveBeenCalledWith('a.b.c');
    expect(lookup).toHaveBeenCalledWith('a.b');
    expect(lookup).toHaveBeenCalledWith('a');
    expect(resolveValue('{{shared.a.b.c}}', stores)).toBe('got-it');
  });

  it('no-ops when neither resolver is configured', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { v: '{{shared.whatever}}' },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {});
    expect(stores.shared).toBeUndefined();
  });

  it('leaves shared store undefined on full miss', async () => {
    const stores = mkStores();
    const step: RecipeStep = {
      id: 's',
      ingredient: 'noop',
      input: { v: '{{shared.missing}}' },
    } as RecipeStep;
    await prefetchSharedRefs(step, stores, {
      shared: mkResolver({}),
    });
    // No key matched — store stays empty (but may be initialized).
    expect(resolveValue('{{shared.missing}}', stores)).toBeUndefined();
  });
});
