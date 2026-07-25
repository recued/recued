import { describe, it, expect } from 'vitest';
import { withIngredientCache, type CacheStatus, type CacheStatusContext } from '../cache.js';
import { createInMemoryStore } from '@recued/cache';
import type { IngredientManifest } from '@recued/contracts';
import type { IngredientExecutor, ManifestLoader } from '../types.js';

const mkManifest = (slug: string, category: 'data' | 'ai' | 'action' = 'data'): IngredientManifest => ({
  slug,
  name: `Test ${slug}`,
  description: 'test',
  author: 'test',
  kind: 'http',
  category,
  risk_tier: category === 'action' ? 'write' : 'read',
  input: {},
  output: {},
});

const mkLoader = (table: Record<string, 'data' | 'ai' | 'action'>): ManifestLoader =>
  async (slug: string) => {
    const cat = table[slug];
    return cat ? mkManifest(slug, cat) : null;
  };

const mkExecutor = (values: unknown[]): { exec: IngredientExecutor; calls: number } => {
  let i = 0;
  const exec: IngredientExecutor = async () => {
    const v = values[i] ?? values[values.length - 1];
    i++;
    return v;
  };
  return {
    exec,
    get calls() { return i; },
  };
};

describe('freshness=fresh — bypass cache entirely', () => {
  it('never reads cache, never writes cache', async () => {
    const { exec } = mkExecutor(['v1', 'v2', 'v3']);
    const store = createInMemoryStore();
    const events: { status: CacheStatus; ctx: CacheStatusContext }[] = [];

    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'x': 'data' }),
      store,
      recipe_ttl: 300,
      recipe_id: 'r',
      onStatus: (status, ctx) => events.push({ status, ctx }),
    });

    const r1 = await cached('x', { id: '1' }, undefined, { cache: 'fresh' });
    const r2 = await cached('x', { id: '1' }, undefined, { cache: 'fresh' });

    expect(r1).toBe('v1');
    expect(r2).toBe('v2');
    expect(await store.size()).toBe(0);
    expect(events.every((e) => e.status === 'skipped')).toBe(true);
  });
});

describe('freshness=acceptable — default, TTL-gated', () => {
  it('hits when within TTL', async () => {
    let clock = 1_000_000;
    const { exec } = mkExecutor(['v1', 'v2']);
    const events: CacheStatus[] = [];

    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'x': 'data' }),
      store: createInMemoryStore(),
      recipe_ttl: 300,
      recipe_id: 'r',
      now: () => clock,
      onStatus: (s) => events.push(s),
    });

    await cached('x', { id: '1' });
    clock += 100 * 1000; // +100s < 300s TTL
    const r2 = await cached('x', { id: '1' });

    expect(r2).toBe('v1');
    expect(events).toEqual(['miss', 'hit']);
  });

  it('misses when past TTL (does not serve stale)', async () => {
    let clock = 1_000_000;
    const { exec } = mkExecutor(['v1', 'v2']);
    const events: CacheStatus[] = [];

    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'x': 'data' }),
      store: createInMemoryStore(),
      recipe_ttl: 60,
      recipe_id: 'r',
      now: () => clock,
      onStatus: (s) => events.push(s),
    });

    await cached('x', { id: '1' });
    clock += 1000 * 1000; // way past TTL
    const r2 = await cached('x', { id: '1' });

    expect(r2).toBe('v2');
    expect(events).toEqual(['miss', 'miss']);
  });
});

describe('freshness=any — serve stale', () => {
  it('serves expired entries with stale flag + age_ms', async () => {
    let clock = 1_000_000;
    const { exec } = mkExecutor(['v1', 'v2']);
    const events: CacheStatusContext[] = [];
    const statuses: CacheStatus[] = [];

    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'x': 'data' }),
      store: createInMemoryStore(),
      recipe_ttl: 60,
      recipe_id: 'r',
      now: () => clock,
      onStatus: (s, c) => { statuses.push(s); events.push(c); },
    });

    await cached('x', { id: '1' });
    clock += 1000 * 1000; // way past TTL
    const r2 = await cached('x', { id: '1' }, undefined, { cache: 'any' });

    expect(r2).toBe('v1');
    expect(statuses).toEqual(['miss', 'hit_stale']);
    expect(events[1].stale).toBe(true);
    expect(events[1].age_ms).toBe(1000 * 1000);
  });

  it('still prefers fresh entries when available', async () => {
    let clock = 1_000_000;
    const { exec } = mkExecutor(['v1', 'v2']);
    const statuses: CacheStatus[] = [];

    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'x': 'data' }),
      store: createInMemoryStore(),
      recipe_ttl: 300,
      recipe_id: 'r',
      now: () => clock,
      onStatus: (s) => statuses.push(s),
    });

    await cached('x', { id: '1' });
    clock += 100 * 1000; // within TTL
    const r2 = await cached('x', { id: '1' }, undefined, { cache: 'any' });

    expect(r2).toBe('v1');
    expect(statuses).toEqual(['miss', 'hit']); // fresh hit, not stale
  });
});

describe('age_ms observability on hits', () => {
  it('reports age from created_at to now', async () => {
    let clock = 2_000_000;
    const { exec } = mkExecutor(['cached-value']);
    const events: CacheStatusContext[] = [];

    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'x': 'data' }),
      store: createInMemoryStore(),
      recipe_ttl: 300,
      recipe_id: 'r',
      now: () => clock,
      onStatus: (_, c) => events.push(c),
    });

    await cached('x', { id: '1' }); // miss → write cache at clock=2_000_000
    clock += 45 * 1000;              // advance 45s
    await cached('x', { id: '1' }); // hit

    expect(events[1].age_ms).toBe(45 * 1000);
    expect(events[1].stale).toBe(false);
  });
});
