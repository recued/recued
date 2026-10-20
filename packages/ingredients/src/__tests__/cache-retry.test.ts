import { describe, expect, it, vi } from 'vitest';
import { createInMemoryStore } from '@recued/cache';
import type { IngredientManifest, StepMeta, StepOptions } from '@recued/contracts';
import { withIngredientCache, type IngredientCacheCall, type IngredientCacheOptions, type IngredientCacheScope } from '../cache.js';

const manifest: IngredientManifest = { slug: 'read', version: 1, name: 'Read', description: '', author: 'fixture',
  kind: 'connection', category: 'data', risk_tier: 'read', input: { method: 'GET', id: '{{config.id}}' }, output: {} };
const fixture = () => {
  const store = createInMemoryStore(); let generation = 0;
  const invalidation = new Error('Host read generation changed');
  const scope = (): IngredientCacheScope => {
    const captured = generation;
    return { key: `generation-${captured}`, validate: () => {
      if (captured !== generation) throw invalidation;
    }, retry };
  };
  const rebind = vi.fn(async (_call: IngredientCacheCall) => scope());
  const retry = vi.fn((error: unknown) => error === invalidation ? rebind : undefined);
  const raw = vi.fn(async () => ({ generation }));
  const cached = vi.fn(); const stored = vi.fn();
  const evidence = vi.fn(() => ({ cached, stored }));
  const current = { id: '42' };
  const options: IngredientCacheOptions = { store, recipe_id: 'fixture', recipe_ttl: 300,
    manifestLoader: async () => manifest, cacheScope: vi.fn(async () => scope()), resultEvidence: evidence,
    resolveRefs: input => ({ ...input, id: current.id }) };
  return { store, raw, options, execute: withIngredientCache(raw, options), cached, stored, evidence,
    retry, rebind, invalidation, current, invalidate: () => { generation += 1; } };
};

describe('one host-authorized cache retry', () => {
  it('reports only the final stored result after discarding an invalidated response', async () => {
    const f = fixture(); const set = f.store.set.bind(f.store);
    vi.spyOn(f.store, 'set').mockImplementationOnce(async entry => { await set(entry); f.invalidate(); });
    expect(await f.execute(manifest.slug, {})).toEqual({ generation: 1 });
    expect(f.raw).toHaveBeenCalledTimes(2);
    expect(f.rebind).toHaveBeenCalledOnce();
    expect(f.evidence).toHaveBeenCalledOnce();
    expect(f.stored).toHaveBeenCalledOnce();
    expect(f.stored.mock.calls[0]?.[0].value).toEqual({ generation: 1 });
    expect(f.cached).not.toHaveBeenCalled();
  });

  it('does not attest an invalidated hit before retrying a fresh provider call', async () => {
    const f = fixture(); await f.execute(manifest.slug, {});
    f.stored.mockClear(); f.evidence.mockClear();
    const statuses: string[] = []; const retried: boolean[] = [];
    f.options.onStatus = (status, context) => {
      statuses.push(status); retried.push(context.retried === true); if (status === 'hit') f.invalidate();
    };
    expect(await f.execute(manifest.slug, {})).toEqual({ generation: 1 });
    expect(statuses).toEqual(['hit', 'miss']);
    expect(retried).toEqual([false, true]);
    expect(f.cached).not.toHaveBeenCalled();
    expect(f.stored).toHaveBeenCalledOnce();
    expect(f.evidence).toHaveBeenCalledOnce();
    expect(f.raw).toHaveBeenCalledTimes(2);
  });

  it('reuses an entry in the new generation without repeating the provider read', async () => {
    const f = fixture();
    const set = f.store.set.bind(f.store);
    vi.spyOn(f.store, 'set').mockImplementationOnce(async entry => {
      await set(entry); f.invalidate();
      // Another reader fills the current generation before this call recovers.
      await f.execute(manifest.slug, {});
    });
    expect(await f.execute(manifest.slug, {})).toEqual({ generation: 1 });
    expect(f.raw).toHaveBeenCalledTimes(2);
    expect(f.cached).toHaveBeenCalledOnce();
    expect(f.cached.mock.calls[0]?.[0].value).toEqual({ generation: 1 });
    expect(f.stored).toHaveBeenCalledOnce();
    expect(f.rebind).toHaveBeenCalledOnce();
  });

  it('does not request a third attempt even if its host would approve it', async () => {
    const f = fixture(); const set = f.store.set.bind(f.store);
    vi.spyOn(f.store, 'set').mockImplementation(async entry => { await set(entry); f.invalidate(); });
    await expect(f.execute(manifest.slug, {})).rejects.toBe(f.invalidation);
    expect(f.raw).toHaveBeenCalledTimes(2);
    expect(f.retry).toHaveBeenCalledOnce();
    expect(f.rebind).toHaveBeenCalledOnce();
    expect(f.stored).not.toHaveBeenCalled();
  });

  it('keeps provider errors intact when the host declines recovery', async () => {
    const f = fixture(); const error = new Error('Provider failed'); f.raw.mockRejectedValueOnce(error);
    await expect(f.execute(manifest.slug, {})).rejects.toBe(error);
    expect(f.raw).toHaveBeenCalledOnce(); expect(f.rebind).not.toHaveBeenCalled();
  });

  it('re-resolves current inputs and refuses a changed request before rebinding', async () => {
    const f = fixture(); const set = f.store.set.bind(f.store);
    vi.spyOn(f.store, 'set').mockImplementationOnce(async entry => {
      await set(entry); f.invalidate(); f.current.id = '99';
    });
    await expect(f.execute(manifest.slug, { method: 'DELETE' })).rejects.toMatchObject({
      details: { reason: 'cache_input_changed' },
    });
    expect(f.rebind).not.toHaveBeenCalled(); expect(f.raw).toHaveBeenCalledOnce();
  });

  it.each(['input', 'operation'] as const)('rechecks %s after rebinding before accepting a recovered hit', async change => {
    const f = fixture(); const set = f.store.set.bind(f.store);
    vi.spyOn(f.store, 'set').mockImplementationOnce(async entry => { await set(entry); f.invalidate(); });
    const rebind = f.rebind.getMockImplementation()!;
    f.rebind.mockImplementationOnce(async call => {
      const refreshed = await rebind(call);
      // Another reader fills exactly the key the recovering call would use.
      await f.execute(manifest.slug, {});
      if (change === 'input') f.current.id = '99';
      else f.options.manifestLoader = async () => ({ ...manifest, risk_tier: 'write' });
      return refreshed;
    });
    const result = f.execute(manifest.slug, {});
    if (change === 'input') await expect(result).rejects.toMatchObject({ details: { reason: 'cache_input_changed' } });
    else await expect(result).rejects.toBe(f.invalidation);
    expect(f.raw).toHaveBeenCalledTimes(2); expect(f.cached).not.toHaveBeenCalled();
    expect(f.rebind).toHaveBeenCalledOnce();
  });

  it('refuses inputs changed during the recovered cache lookup', async () => {
    const f = fixture(); const get = f.store.get.bind(f.store);
    vi.spyOn(f.store, 'get').mockImplementationOnce(async key => {
      const entry = await get(key); f.invalidate(); return entry;
    }).mockImplementationOnce(async key => {
      const entry = await get(key); f.current.id = '99'; return entry;
    });
    await expect(f.execute(manifest.slug, {})).rejects.toMatchObject({ details: { reason: 'cache_input_changed' } });
    expect(f.raw).not.toHaveBeenCalled(); expect(f.rebind).toHaveBeenCalledOnce();
  });

  it.each(['privacy', 'mapping'] as const)('refuses %s changes during asynchronous rebinding', async change => {
    const f = fixture(); const options = { pii_fields: [] as string[] }; const output = { generation: 'version' };
    const set = f.store.set.bind(f.store);
    vi.spyOn(f.store, 'set').mockImplementationOnce(async entry => { await set(entry); f.invalidate(); });
    const rebind = f.rebind.getMockImplementation()!;
    f.rebind.mockImplementationOnce(async call => {
      const scope = await rebind(call);
      if (change === 'privacy') options.pii_fields.push('id');
      else output.generation = 'other';
      return scope;
    });
    await expect(f.execute(manifest.slug, {}, output, options)).rejects.toMatchObject({
      details: { reason: 'cache_input_changed' },
    });
    expect(f.raw).toHaveBeenCalledOnce(); expect(f.rebind).toHaveBeenCalledOnce();
  });

  it('refuses a newly write-classified manifest before rebinding or invoking it', async () => {
    const f = fixture(); const set = f.store.set.bind(f.store);
    vi.spyOn(f.store, 'set').mockImplementationOnce(async entry => {
      await set(entry); f.invalidate();
      f.options.manifestLoader = async () => ({ ...manifest, risk_tier: 'write' });
    });
    await expect(f.execute(manifest.slug, {})).rejects.toBe(f.invalidation);
    expect(f.rebind).not.toHaveBeenCalled(); expect(f.raw).toHaveBeenCalledOnce();
  });

  it.each(['write', 'admin', 'destructive', 'fresh', 'sensitive', 'surface_write'] as const)(
    'never opts %s calls into recovery', async mode => {
      const f = fixture();
      if (mode === 'write' || mode === 'admin' || mode === 'destructive') {
        f.options.manifestLoader = async () => ({ ...manifest, risk_tier: mode });
      }
      const options: StepOptions | undefined = mode === 'fresh' ? { cache: 'fresh' } : undefined;
      const meta: StepMeta | undefined = mode === 'sensitive' || mode === 'surface_write'
        ? { recipe_id: 'fixture', step_id: 'write', surface_dispatch: true,
          ...(mode === 'sensitive' ? { surface_dispatch_sensitive: true } : { surface_risk_tier: 'write' }) } : undefined;
      f.raw.mockRejectedValue(f.invalidation);
      await expect(f.execute(manifest.slug, {}, undefined, options, meta)).rejects.toBe(f.invalidation);
      expect(f.raw).toHaveBeenCalledOnce(); expect(f.options.cacheScope).not.toHaveBeenCalled();
      expect(f.retry).not.toHaveBeenCalled();
    });

  it('keeps optional evidence failures out of retry decisions', async () => {
    const f = fixture(); f.stored.mockImplementation(() => { throw f.invalidation; });
    expect(await f.execute(manifest.slug, {})).toEqual({ generation: 0 });
    expect(f.raw).toHaveBeenCalledOnce(); expect(f.retry).not.toHaveBeenCalled();
  });
});
