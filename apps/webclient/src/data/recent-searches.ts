/** Search words only, scoped to one pairing in this tab. Source results are read again. */
export interface RecentSearchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface RecentSearches {
  list(): readonly string[];
  remember(query: string): void;
  /** A failed storage update keeps the entry visible so removal can be retried. */
  remove(query: string): boolean;
  clear(): boolean;
}
const PREFIX = 'recued.search.recent.v1:';
const LIMIT = 5;
const clean = (query: unknown): string | null => typeof query === 'string' && query.trim().length > 0
  && query.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(query) ? query.trim() : null;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const entries = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const item of raw.slice(0, 100)) {
    const query = clean(item);
    if (query && !result.some(previous => same(previous, query))) result.push(query);
    if (result.length === LIMIT) break;
  }
  return result;
};

export const createRecentSearches = (opts: { scope: string; storage?: RecentSearchStorage | null }): RecentSearches => {
  const key = PREFIX + encodeURIComponent(opts.scope);
  let storage = opts.storage;
  if (storage === undefined) { try { storage = globalThis.sessionStorage; } catch { storage = null; } }
  let queries: string[] = [];
  try {
    const raw = storage?.getItem(key);
    if (raw && raw.length <= 65_536) queries = entries(JSON.parse(raw));
  } catch { /* Searching stays available when browser storage is unavailable. */ }
  const write = (next: string[]): boolean => {
    try {
      if (next.length) storage?.setItem(key, JSON.stringify(next));
      else storage?.removeItem(key);
      return true;
    } catch { return false; }
  };
  return {
    list: () => [...queries],
    remember(query) {
      const value = clean(query);
      if (!value) return;
      queries = [value, ...queries.filter(previous => !same(previous, value))].slice(0, LIMIT);
      write(queries);
    },
    remove(query) {
      const next = queries.filter(previous => !same(previous, query));
      if (!write(next)) return false;
      queries = next; return true;
    },
    clear() {
      if (!write([])) return false;
      queries = []; return true;
    },
  };
};
