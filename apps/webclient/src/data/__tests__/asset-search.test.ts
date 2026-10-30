import { describe, expect, it, vi } from 'vitest';
import type { Asset, AssetClassPreset } from '@recued/contracts';
import { createAssetSearch, type AssetSearchCaller } from '../asset-search.js';

const asset = (id: string): Asset => ({ id, name: `Passport ${id}`, class_id: 'passport', source_id: 'recued.asset',
  status: 'active', sync_state: 'live', last_seen_at: 1, conflict_policy: 'recued_wins',
  dates: {}, readings: {}, observations: {}, values: [], anchors: [], attributes: { private_fact: 'do not retain' },
  settings: {}, rules: [], field_sources: {}, retirement: 'part', created_at: 1, updated_at: 1 });
const preset: AssetClassPreset = { id: 'passport', name: 'Passport', version: 1, origin: 'builtin',
  fields: { dates: {}, readings: {}, observations: {}, settings: {} }, rules: [], audience: 'owner', retirement: 'part' };
const page = (ids: string[], total = ids.length) => ({ assets: ids.map(asset), classes: [preset], total_assets: total });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe('asset search owner reader', () => {
  it('uses literal Yours search, reads pages without marking shown, and retains only result labels', async () => {
    const rows = Array.from({ length: 17 }, (_, i) => String(i));
    const caller = vi.fn<AssetSearchCaller>(async input => page(rows.slice(input.offset, (input.offset ?? 0) + (input.limit ?? 5)), rows.length));
    const search = createAssetSearch(caller, () => {});
    await search.load('  Ana / passport  ');
    expect(caller).toHaveBeenLastCalledWith({ search: 'Ana / passport', offset: 0, limit: 5,
      include_derived: false, include_asset_summaries: false, mark_shown: false });
    expect(search.state()).toMatchObject({ total: 17, offset: 5, more: true, loading: false });
    expect(search.state().matches[0]).toEqual({ id: '0', name: 'Passport 0', class_name: 'Passport', status: 'active', stale: false, pending_write: false });
    await search.load('Ana / passport', true);
    expect(search.state().matches).toHaveLength(15);
    await search.load('Ana / passport', true);
    expect(search.state()).toMatchObject({ offset: 17, more: false });
  });

  it('retains the confirmed prefix and offset when append fails, then retries that page', async () => {
    let fail = true;
    const caller = vi.fn<AssetSearchCaller>(async input => {
      if (input.offset && fail) throw new Error('temporarily offline');
      return page(input.offset ? ['5', '6'] : ['0', '1', '2', '3', '4'], 7);
    });
    const search = createAssetSearch(caller, () => {});
    await search.load('passport'); await search.load('passport', true);
    expect(search.state()).toMatchObject({ offset: 5, more: true, retry_append: true, error: expect.any(String) });
    expect(search.state().matches).toHaveLength(5);
    fail = false; await search.load('passport', true);
    expect(search.state()).toMatchObject({ offset: 7, more: false });
    expect(search.state().matches).toHaveLength(7);
    expect(search.state().error).toBeUndefined();
  });

  it('retires old query responses and suppresses responses after disposal', async () => {
    const first = deferred<Awaited<ReturnType<AssetSearchCaller>>>();
    const last = deferred<Awaited<ReturnType<AssetSearchCaller>>>();
    const changed = vi.fn();
    const search = createAssetSearch(async input => input.search === 'old' ? first.promise : input.search === 'last' ? last.promise : page(['new']), changed);
    const old = search.load('old'); await search.load('new');
    first.resolve(page(['old'])); await old;
    expect(search.state().matches.map(row => row.id)).toEqual(['new']);
    const pending = search.load('last'); search.dispose(); changed.mockClear();
    last.resolve(page(['last'])); await pending;
    await search.load('');
    expect(changed).not.toHaveBeenCalled();
  });

  it('refreshes the prefix when a changing total would retain a removed asset and skip an unseen match', async () => {
    const rows = ['0', '1', '2', '3', '4', '5', '6'];
    const search = createAssetSearch(async input => page(rows.slice(input.offset, (input.offset ?? 0) + (input.limit ?? 5)), rows.length), () => {});
    await search.load('passport');
    rows.shift();
    await search.load('passport', true);
    expect(search.state().matches.map(row => row.id)).toEqual(rows);
    expect(search.state()).toMatchObject({ offset: 6, total: 6, more: false });
  });

  it('revalidates a restored loaded prefix without shrinking it, retaining it on failure', async () => {
    const rows = Array.from({ length: 16 }, (_, i) => String(i));
    const original = createAssetSearch(async input => page(rows.slice(input.offset, (input.offset ?? 0) + (input.limit ?? 5)), rows.length), () => {});
    await original.load('passport'); await original.load('passport', true);
    const caller = vi.fn<AssetSearchCaller>(async () => { throw new Error('offline'); });
    const resumed = createAssetSearch(caller, () => {});
    resumed.restore(original.snapshot()); await resumed.load('passport');
    expect(caller.mock.calls[0]?.[0]).toMatchObject({ offset: 0, limit: 15 });
    expect(resumed.state().matches).toHaveLength(15);
    expect(resumed.state()).toMatchObject({ offset: 15, more: true, retry_append: false, error: expect.any(String) });
    caller.mockImplementation(async () => page(rows.slice(0, 15), 16));
    await resumed.load('passport');
    expect(resumed.state().matches).toHaveLength(15);
    expect(resumed.state().error).toBeUndefined();
  });

  it('rejects a nonadvancing page and distinguishes an unsupported reader from a confirmed empty result', async () => {
    const search = createAssetSearch(async () => page(['same'], 12), () => {});
    await search.load('passport');
    expect(search.state()).toMatchObject({ offset: 0, matches: [], error: expect.any(String), loading: false });
    const oldServer = createAssetSearch(async () => { throw { code: 'unknown_method', message: 'unknown method' }; }, () => {});
    await oldServer.load('passport');
    expect(oldServer.state()).toMatchObject({ unsupported: true, loading: false, error: undefined });
  });
});
