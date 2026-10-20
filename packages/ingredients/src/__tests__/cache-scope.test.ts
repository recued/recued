import { describe, expect, it, vi } from 'vitest';
import { cacheKey, createInMemoryStore } from '@recued/cache';
import type { IngredientManifest } from '@recued/contracts';
import { withIngredientCache, type IngredientCacheOptions } from '../cache.js';

const manifest: IngredientManifest = { slug: 'read-account', version: 1, name: 'Read', description: '', author: 'fixture',
  kind: 'connection', category: 'data', risk_tier: 'read',
  input: { connection_kind: 'api', connection: 'sales', method: 'GET', path: '/contacts' }, output: {} };
const fixture = () => {
  const store = createInMemoryStore();
  let account = 'a';
  const raw = vi.fn(async () => ({ account }));
  const opts: IngredientCacheOptions = { store, recipe_id: 'fixture', recipe_ttl: 300,
    manifestLoader: async () => manifest, cacheScope: () => {
      const captured = account;
      return { key: captured, validate: () => { if (account !== captured) throw new Error('account changed'); } };
    } };
  return { store, raw, opts, execute: withIngredientCache(raw, opts), change: (next = 'b') => { account = next; } };
};

describe('host-scoped ingredient cache', () => {
  it('misses for a replacement account, reuses unchanged accounts, and never reads legacy keys', async () => {
    const f = fixture();
    const key = await cacheKey({ ingredient_slug: manifest.slug, manifest_version: '1', inputs: manifest.input! });
    await f.store.set({ key, value: { account: 'legacy' }, recipe_id: 'fixture', ingredient_slug: manifest.slug,
      category: 'data', risk_tier: 'read', created_at: 1, last_accessed_at: 1, expires_at: Date.now() + 1_000_000, size_bytes: 1 });
    expect(await f.execute(manifest.slug, {})).toEqual({ account: 'a' });
    expect(await f.execute(manifest.slug, {})).toEqual({ account: 'a' });
    f.change();
    expect(await f.execute(manifest.slug, {})).toEqual({ account: 'b' });
    expect(f.raw).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'failed'])('bypasses caching when host identity is %s', async mode => {
    const f = fixture();
    f.opts.cacheScope = () => { if (mode === 'failed') throw new Error('unavailable'); return null; };
    const get = vi.spyOn(f.store, 'get'); const set = vi.spyOn(f.store, 'set');
    await f.execute(manifest.slug, {}); await f.execute(manifest.slug, {});
    expect(f.raw).toHaveBeenCalledTimes(2); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });

  it.each(['get', 'touch', 'set', 'evictLRU'] as const)('refuses a changed identity across asynchronous %s', async method => {
    const f = fixture();
    if (method === 'get' || method === 'touch') await f.execute(manifest.slug, {});
    if (method === 'evictLRU') f.opts.max_bytes = 10_000;
    const original = f.store[method]!.bind(f.store);
    vi.spyOn(f.store, method).mockImplementationOnce((async (...args: never[]) => {
      const result = await (original as (...args: never[]) => Promise<unknown>)(...args);
      f.change(); return result;
    }) as never);
    await expect(f.execute(manifest.slug, {})).rejects.toThrow('account changed');
    expect(f.raw).toHaveBeenCalledOnce();
  });

  it('does not publish a result obtained after its binding changed', async () => {
    const f = fixture(); const set = vi.spyOn(f.store, 'set');
    f.raw.mockImplementationOnce(async () => { f.change(); return { account: 'b' }; });
    await expect(f.execute(manifest.slug, {})).rejects.toThrow('account changed');
    expect(set).not.toHaveBeenCalled();
  });

  it('rejects a store response carrying another account key', async () => {
    const f = fixture(); const set = vi.spyOn(f.store, 'set');
    await f.execute(manifest.slug, {});
    const old = set.mock.calls[0]![0]; f.change();
    vi.spyOn(f.store, 'get').mockResolvedValueOnce(old);
    expect(await f.execute(manifest.slug, {})).toEqual({ account: 'b' });
    expect(f.raw).toHaveBeenCalledTimes(2);
  });

  it('derives the host scope from the same locked defaults and resolved references as dispatch', async () => {
    const f = fixture(); const scope = vi.fn(f.opts.cacheScope!); f.opts.cacheScope = scope;
    f.opts.resolveRefs = input => Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v === '{{config.account}}' ? 'sales' : v]));
    f.opts.manifestLoader = async () => ({ ...manifest, input: { ...manifest.input, connection: '{{config.account}}' } });
    await f.execute(manifest.slug, { method: 'DELETE', connection_kind: 'mcp' });
    expect(scope.mock.calls[0]![0].input).toMatchObject({ method: 'GET', connection_kind: 'mcp', connection: 'sales' });
  });
});
