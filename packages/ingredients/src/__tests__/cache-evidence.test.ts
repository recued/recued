import { describe, expect, it, vi } from 'vitest';
import { createInMemoryStore } from '@recued/cache';
import type { CacheEntry, IngredientManifest, StepMeta } from '@recued/contracts';
import { withIngredientCache, type IngredientCacheOptions } from '../cache.js';

const manifest: IngredientManifest = { slug: 'test', name: 'Test', description: '', author: 'local',
  kind: 'http', category: 'data', risk_tier: 'read', input: {}, output: {} };
const meta: StepMeta = { recipe_id: 'r', step_id: 'fetch' };
const options = (): IngredientCacheOptions => ({ store: createInMemoryStore(),
  manifestLoader: async () => manifest, recipe_id: 'r', recipe_ttl: 300 });

describe('ingredient cache host result evidence', () => {
  it('captures before dispatch and reports stored/hit values without changing the payload', async () => {
    const events: string[] = [];
    const value = { id: '42', record_source: { forged: true } };
    const raw = vi.fn(async () => { events.push('provider'); return value; });
    const entries: CacheEntry[] = [];
    const opts = options();
    const executor = withIngredientCache(raw, { ...opts, resultEvidence: call => {
      expect(call).toEqual({ slug: 'test', input: { id: '42' }, stepMeta: meta });
      events.push('prepare');
      return { cached: entry => { events.push('hit'); entries.push(entry); },
        stored: entry => { events.push('stored'); entries.push(entry); } };
    } });
    expect(await executor('test', { id: '42' }, undefined, undefined, meta)).toEqual(value);
    expect(await executor('test', { id: '42' }, undefined, undefined, meta)).toEqual(value);
    expect(events).toEqual(['prepare', 'provider', 'stored', 'prepare', 'hit']);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(entries[0]?.key).toBe(entries[1]?.key);
    expect(entries[0]?.value).toEqual(value);
  });

  it.each([true, false])('updates LRU with native touch or a compatible fallback (native=%s)', async native => {
    const opts = options();
    if (!native) delete opts.store.touch;
    const set = vi.spyOn(opts.store, 'set');
    const touch = opts.store.touch ? vi.spyOn(opts.store, 'touch') : undefined;
    let clock = 1_000_000;
    const executor = withIngredientCache(async () => ({ id: '42' }), { ...opts, now: () => clock });
    await executor('test', {});
    const saved = set.mock.calls[0]![0];
    clock += 1_000;
    await executor('test', {});
    const hit = await opts.store.get(saved.key);
    expect(hit?.last_accessed_at).toBe(clock);
    expect(hit?.expires_at).toBe(saved.expires_at);
    expect(set).toHaveBeenCalledTimes(native ? 1 : 2);
    if (touch) expect(touch).toHaveBeenCalledWith(saved.key, { last_accessed_at: clock });
  });

  it('reports stale reuse while fresh and write dispatches never mint cached evidence', async () => {
    const opts = options();
    let clock = 1;
    const cached = vi.fn(); const stored = vi.fn();
    const executor = withIngredientCache(async () => ({ id: '42' }), { ...opts, now: () => clock,
      resultEvidence: () => ({ cached, stored }) });
    await executor('test', {});
    clock = 1_000_000;
    await executor('test', {}, undefined, { cache: 'any' });
    expect(cached).toHaveBeenCalledOnce();
    await executor('test', {}, undefined, { cache: 'fresh' });
    await executor('test', {}, undefined, undefined, { ...meta, surface_dispatch: true, surface_risk_tier: 'write' });
    expect(stored).toHaveBeenCalledOnce();
  });

  it.each(['prepare', 'cached', 'stored'] as const)('keeps %s evidence failures out of execution', async broken => {
    const opts = options();
    const raw = vi.fn(async () => ({ id: '42' }));
    const fail = () => { throw new Error('metadata unavailable'); };
    const executor = withIngredientCache(raw, { ...opts, resultEvidence: () => {
      if (broken === 'prepare') return fail();
      return { cached: broken === 'cached' ? fail : () => {}, stored: broken === 'stored' ? fail : () => {} };
    } });
    expect(await executor('test', {})).toEqual({ id: '42' });
    expect(await executor('test', {})).toEqual({ id: '42' });
    expect(raw).toHaveBeenCalledOnce();
  });

  it('never records failed provider calls as stored evidence', async () => {
    const stored = vi.fn();
    const executor = withIngredientCache(async () => { throw new Error('provider failed'); }, {
      ...options(), resultEvidence: () => ({ cached: vi.fn(), stored }),
    });
    await expect(executor('test', {})).rejects.toThrow('provider failed');
    expect(stored).not.toHaveBeenCalled();
  });
});
