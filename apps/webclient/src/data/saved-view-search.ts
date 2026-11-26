import { parseSavedDataViewDefinition, sameSavedDataViewDefinition, savedDataViewSupportsAlerts,
  type SavedDataViewDefinition } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';
import { readSearchNavigationReturn } from '../shell/search-navigation-return.js';
import { classifyRpcError } from '../shell/rpc-error-copy.js';
import { savedViewSettingsSummary, savedViewAlertSummary } from './saved-view-summary.js';

export const SEARCH_SAVED_VIEW_ID = 'data-search-saved-view-id';
export const SEARCH_OPEN_SAVED_VIEW = 'universal-search-open-saved-view';
export const savedViewSearchHref = (id: string): string => serializeShellRoute('views', id);
export interface SavedViewSearchRow {
  id: string; name: string; revision: number; definition: SavedDataViewDefinition;
  summary: string; alert?: string; pack?: { publisher: string; slug: string };
}
export interface SavedViewSearchState {
  query: string; rows: readonly SavedViewSearchRow[]; matches: readonly SavedViewSearchRow[];
  loaded: boolean; loading: boolean; stale: boolean; error?: string; unsupported?: boolean;
}
export interface SavedViewSearchCallers {
  list(): Promise<unknown>;
  get(args: { id: string }): Promise<unknown>;
  observe?: (changed: () => void) => () => void;
}
const empty = (): SavedViewSearchState => ({ query: '', rows: [], matches: [], loaded: false, loading: false, stale: false });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, limit = 100): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= limit && !/[\u0000-\u001f\u007f]/u.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^view_[a-f0-9-]{36}$/.test(v);
const at = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 8.64e15;
const fold = (v: string): string => v.normalize('NFKC').toLowerCase().replace(/ς/gu, 'σ');
const invalid = (): never => { throw Error('Saved view metadata could not be confirmed. Refresh saved views and try again.'); };

/** Keep only named view settings and display metadata. Record results, review
 * cursors, retirement details and arbitrary extra response fields stay out. */
export const readSavedViewSearchRow = (input: unknown): SavedViewSearchRow | undefined => {
  if (!record(input) || !id(input.id)) return invalid();
  if (input.hidden === true || input.retired !== undefined) return undefined;
  if (input.hidden !== undefined && input.hidden !== false || !text(input.name) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1) return invalid();
  const definition = parseSavedDataViewDefinition(input.definition);
  if (!definition) return invalid();
  let pack: SavedViewSearchRow['pack'];
  if (input.pack !== undefined) {
    if (!record(input.pack) || !text(input.pack.publisher) || !text(input.pack.slug)) return invalid();
    pack = { publisher: input.pack.publisher, slug: input.pack.slug };
  }
  let alert: string | undefined;
  if (savedDataViewSupportsAlerts(definition)) {
    if (input.alert === undefined) alert = 'Alerts off';
    else if (record(input.alert) && typeof input.alert.enabled === 'boolean' && text(input.alert.time_zone)
      && (input.alert.last_checked_at === null || at(input.alert.last_checked_at))
      && (input.alert.enabled ? input.alert.status === 'watching' || input.alert.status === 'unavailable' : input.alert.status === 'paused')) {
      alert = savedViewAlertSummary({ definition, alert: { enabled: input.alert.enabled, time_zone: input.alert.time_zone,
        status: !input.alert.enabled ? 'paused' : input.alert.status === 'unavailable' ? 'unavailable' : 'watching',
        last_checked_at: input.alert.last_checked_at, last_notified_at: null } });
    } else alert = 'Alert status unavailable';
  }
  return { id: input.id, name: input.name, revision: Number(input.revision), definition: structuredClone(definition),
    summary: savedViewSettingsSummary(definition), ...(alert ? { alert } : {}), ...(pack ? { pack } : {}) };
};
export const readSavedViewSearchList = (input: unknown): SavedViewSearchRow[] => {
  if (!record(input) || !Array.isArray(input.views)) return invalid();
  const seen = new Set<string>(), rows: SavedViewSearchRow[] = [];
  for (const value of input.views) {
    if (!record(value) || !id(value.id) || seen.has(value.id)) return invalid();
    seen.add(value.id); const row = readSavedViewSearchRow(value); if (row) rows.push(row);
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
};
const matches = (query: string, rows: readonly SavedViewSearchRow[]): SavedViewSearchRow[] => {
  const words = fold(query).trim().split(/\s+/u).filter(Boolean);
  return rows.filter(row => {
    const haystack = fold([row.name, row.summary, row.pack?.publisher, row.pack?.slug].filter(Boolean).join(' '));
    return words.every(word => haystack.includes(word));
  });
};
export const savedViewSearchUncertain = (state: SavedViewSearchState | undefined): boolean => !!state
  && (!state.loaded || state.loading || state.stale || !!state.error || state.unsupported === true);
export const sameSavedViewSearchSelection = (selected: SavedViewSearchRow, current: SavedViewSearchRow | undefined): boolean => !!current
  && selected.id === current.id && selected.revision === current.revision && selected.name === current.name
  && selected.pack?.publisher === current.pack?.publisher && selected.pack?.slug === current.pack?.slug
  && sameSavedDataViewDefinition(selected.definition, current.definition);
export const readSavedViewSearchVisit = (doc: Document | undefined, owner: object, hash: string) => {
  if (!doc) return undefined;
  const visit = readSearchNavigationReturn<{ savedViewsSearch?: SavedViewSearchState }>(doc, owner);
  if (!visit || visit.focus.action !== SEARCH_OPEN_SAVED_VIEW || visit.focus.attribute !== SEARCH_SAVED_VIEW_ID
    || visit.returnHash === hash || visit.destinationHash !== hash && !visit.destinationAliases?.includes(hash)) return undefined;
  const selection = visit.state.savedViewsSearch?.matches.find(row => row.id === visit.focus.id);
  return selection ? { hash: visit.returnHash, destinationHash: hash, selection } : undefined;
};
export const savedViewSearchAliases = (row: SavedViewSearchRow): string[] | undefined => row.definition.tab === 'today' ? ['#today']
  : row.definition.tab === 'webhook' ? ['#connections/webhooks'] : undefined;

export const createSavedViewSearch = (callers: SavedViewSearchCallers | undefined, changed: () => void) => {
  let state = empty(), generation = 0, activity = 0, disposed = false, pending = Promise.resolve();
  const load = (query: string, refresh = false): Promise<void> => {
    if (!callers || disposed) return pending;
    if (!refresh && (state.loaded || state.loading)) { state = { ...state, query, matches: matches(query, state.rows) }; changed(); return pending; }
    const mine = ++generation, version = activity, previous = state;
    state = { ...(previous.query === query ? previous : empty()), query, loading: true, error: undefined, unsupported: false }; changed();
    pending = (async () => {
      try {
        const rows = readSavedViewSearchList(await callers.list());
        if (disposed || mine !== generation) return;
        state = { query: state.query, rows, matches: matches(state.query, rows), loaded: true, loading: false, stale: version !== activity };
      } catch (error) {
        if (disposed || mine !== generation) return;
        const code = classifyRpcError(error).code;
        state = { ...state, loading: false, error: 'Saved views could not be read. Refresh saved views and try again.',
          unsupported: code === 'unknown_method' || code === 'not_configured' };
      }
      changed();
    })();
    return pending;
  };
  const off = callers?.observe?.(() => {
    activity++;
    if (!disposed && (state.loaded || state.loading)) { state = { ...state, stale: true }; changed(); }
  });
  return {
    state: () => state, load, whenLoaded: () => pending,
    reset() { generation++; state = empty(); },
    snapshot: () => structuredClone({ ...state, loading: false }),
    restore(value: SavedViewSearchState) { generation++; state = structuredClone({ ...value, loading: false }); },
    async resolve(selected: SavedViewSearchRow): Promise<boolean> {
      if (!callers || disposed) return false;
      const mine = generation, response = await callers.get({ id: selected.id });
      if (disposed || mine !== generation) return false;
      const current = record(response) && response.view !== null ? readSavedViewSearchRow(response.view) : undefined;
      if (!sameSavedViewSearchSelection(selected, current)) throw Error('This saved view changed or is no longer available. Refresh saved views before opening it.');
      return true;
    },
    dispose() { disposed = true; generation++; off?.(); },
  };
};
