import { ASSET_STATUSES, type Asset, type YoursReadRequest, type YoursSnapshot } from '@recued/contracts';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export type AssetSearchCaller = (input: YoursReadRequest) => Promise<Pick<YoursSnapshot, 'assets' | 'classes' | 'total_assets'>>;
export interface AssetSearchMatch {
  id: string;
  name: string;
  class_name: string;
  status: Asset['status'];
  stale: boolean;
  pending_write: boolean;
}
export interface AssetSearchState {
  query: string;
  matches: readonly AssetSearchMatch[];
  total: number;
  offset: number;
  more: boolean;
  loading: boolean;
  error?: string;
  unsupported?: boolean;
  retry_append?: boolean;
}
const empty = (): AssetSearchState => ({ query: '', matches: [], total: 0, offset: 0, more: false, loading: false });

/** Uses the same owner reader and search predicate as Yours. Retains only
 * result labels, never the full asset facts returned by the reader. */
export const createAssetSearch = (caller: AssetSearchCaller | undefined, changed: () => void) => {
  let state = empty(), generation = 0, disposed = false;
  let pending: Promise<void> = Promise.resolve();
  const reset = (): void => { generation += 1; state = empty(); };
  const read = async (query: string, append: boolean): Promise<void> => {
    if (!caller || disposed || append && (state.loading || !state.more || state.query !== query)) return;
    const token = ++generation, previous = state;
    const keep = previous.query === query;
    const found = new Map((append && keep ? previous.matches : []).map(row => [row.id, row]));
    let offset = append ? previous.offset : 0, total = previous.total;
    let expectedTotal = append ? previous.total : undefined, restarted = false;
    const goal = append ? previous.matches.length + 10 : Math.max(5, keep ? previous.matches.length : 0);
    state = { ...(keep ? previous : empty()), query, loading: true, error: undefined, retry_append: undefined };
    changed();
    try {
      for (let page = 0; page < 100; page++) {
        const out = await caller({ search: query, offset, limit: Math.min(100, goal - found.size),
          include_derived: false, include_asset_summaries: false, mark_shown: false });
        if (disposed || token !== generation) return;
        if (!Array.isArray(out.assets) || !Array.isArray(out.classes) || !Number.isSafeInteger(out.total_assets)
          || out.total_assets < 0 || out.total_assets > offset && out.assets.length === 0)
          throw new Error('The asset search page could not be confirmed. Try again.');
        // An offset into a changed result set can skip a match or retain one
        // that was removed. Rebuild the requested prefix once; keep the last
        // confirmed rows if the list keeps changing.
        if (expectedTotal !== undefined && out.total_assets !== expectedTotal) {
          if (restarted || page === 99) throw new Error('The asset list changed while loading. Try again.');
          found.clear(); offset = 0; expectedTotal = out.total_assets; restarted = true;
          continue;
        }
        expectedTotal = out.total_assets;
        const known = found.size;
        for (const asset of out.assets) {
          if (typeof asset.id !== 'string' || !asset.id || typeof asset.name !== 'string' || asset.deleted_at != null || !ASSET_STATUSES.includes(asset.status))
            throw new Error('The asset search page could not be confirmed. Try again.');
          found.set(asset.id, { id: asset.id, name: asset.name,
            class_name: out.classes.find(preset => preset.id === asset.class_id)?.name ?? asset.class_id ?? 'Unclassified',
            status: asset.status, stale: asset.sync_state !== 'live', pending_write: asset.pending_write !== undefined });
        }
        if (out.assets.length && found.size === known) throw new Error('The asset page did not advance. Refresh the search and try again.');
        offset += out.assets.length; total = out.total_assets;
        if (offset >= total || found.size >= goal) break;
        if (page === 99) throw new Error('The asset list changed while loading. Try again.');
      }
      state = { query, matches: [...found.values()], total, offset, more: offset < total, loading: false };
    } catch (error) {
      if (disposed || token !== generation) return;
      const unsupported = classifyRpcError(error).code === 'unknown_method';
      state = { ...state, loading: false, unsupported, retry_append: append,
        error: unsupported ? undefined : humanizeRpcError(error) };
    }
    changed();
  };
  return {
    state: (): AssetSearchState => state,
    snapshot: (): AssetSearchState => ({ ...state, matches: state.matches.map(row => ({ ...row })), loading: false }),
    restore(value: AssetSearchState) { generation += 1; state = { ...value, matches: value.matches.map(row => ({ ...row })), loading: false }; },
    load(query: string, append = false): Promise<void> {
      if (disposed) return Promise.resolve();
      const term = query.trim();
      if (!term) { reset(); changed(); return Promise.resolve(); }
      if (append && (state.loading || !state.more)) return pending;
      pending = read(term, append); return pending;
    },
    reset,
    whenLoaded: () => pending,
    dispose() { disposed = true; generation += 1; },
  };
};
