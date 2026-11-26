import { CONNECTION_NAME_REGEX } from '@recued/contracts';
import { findAccountLane, findAccountProvider } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';
import { connectionsAccountAddress, connectionsReviewAccessAddress } from './connections-navigation.js';

export const CONNECTION_SEARCH_KINDS = ['mail', 'calendar', 'file', 'cloud', 'api'] as const;
export type ConnectionSearchKind = typeof CONNECTION_SEARCH_KINDS[number];
export const CONNECTION_SEARCH_LABELS: Record<ConnectionSearchKind, string> = {
  mail: 'Mail accounts', calendar: 'Calendar accounts', file: 'File accounts', cloud: 'Cloud file sources', api: 'API connections',
};
export const SEARCH_OPEN_CONNECTION = 'universal-search-open-connection';
export interface ConnectionSearchRow {
  key: string; kind: ConnectionSearchKind; id: string; name: string; provider: string; providerLabel: string;
  email?: string; revision?: number; status: string; lastSyncedAt?: number | null; href: string;
}
export interface ConnectionSearchSource {
  kind: ConnectionSearchKind; rows: readonly ConnectionSearchRow[]; loaded: boolean; loading: boolean; unavailable?: boolean; error?: string;
}
export interface ConnectionSearchState {
  query: string; sources: readonly ConnectionSearchSource[]; matches: readonly ConnectionSearchRow[];
  loaded: boolean; loading: boolean; stale: boolean;
}
/** Only saved inventories are read. No probes, authentication, or connection writes. */
export type ConnectionSearchCallers = Partial<Record<ConnectionSearchKind, () => Promise<unknown>>> & {
  observe?: (changed: () => void) => () => void;
};
const empty = (): ConnectionSearchState => ({ query: '', sources: CONNECTION_SEARCH_KINDS.map(kind => ({ kind, rows: [], loaded: false, loading: false })),
  matches: [], loaded: false, loading: false, stale: false });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 2000 && !/[\u0000-\u001f\u007f]/u.test(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 8.64e15;
const fold = (v: string): string => v.normalize('NFKC').toLowerCase().replace(/ς/gu, 'σ');
const authLabels: Record<string, string> = { healthy: 'Sign-in healthy', expired: 'Sign-in expired', unauthorized: 'Sign-in required', degraded: 'Connection degraded' };
const healthLabels: Record<string, string> = { ok: 'Recorded health: OK', auth_failed: 'Recorded health: sign-in failed', unreachable: 'Recorded health: unreachable', unknown: 'Health not checked' };
const invalid = (): never => { throw Error('Saved connection metadata could not be confirmed. Refresh connections and try again.'); };

/** Explicit projection: flattened API configuration, URLs, headers, grants,
 * credentials and raw provider errors never enter search state or snapshots. */
export const readConnectionSearchSource = (kind: ConnectionSearchKind, input: unknown): ConnectionSearchRow[] => {
  if (!record(input)) return invalid();
  const list = input[kind === 'api' ? 'connections' : kind === 'cloud' ? 'sources' : 'instances'];
  if (!Array.isArray(list)) return invalid();
  const seen = new Set<string>();
  const rows: ConnectionSearchRow[] = [];
  for (const value of list) {
    if (!record(value)) return invalid();
    if (kind === 'api' && (value.kind === 'mcp' || value.kind === 'notification')) continue;
    const id = kind === 'api' ? value.name : kind === 'cloud' ? value.source_id : value.slug;
    if (!text(id) || seen.has(id) || kind === 'api' && (value.kind !== 'api' || !CONNECTION_NAME_REGEX.test(id))) return invalid();
    seen.add(id);
    const provider = kind === 'api' ? typeof value.vendor === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.vendor) ? value.vendor : ''
      : kind === 'cloud' ? value.provider : value.adapter_type;
    if (kind !== 'api' && !text(provider)) return invalid();
    const providerId = provider as string;
    const lane = findAccountLane(kind === 'cloud' ? 'file' : kind);
    const providerLabel = lane ? findAccountProvider(lane, providerId)?.label ?? providerId : providerId;
    const name = kind === 'api' ? text(value.display_name) ? value.display_name : id
      : kind === 'cloud' ? text(value.label) ? value.label : invalid() : id;
    let status = 'Status not recorded';
    let lastSyncedAt: number | null | undefined;
    let email: string | undefined;
    let revision: number | undefined;
    if (kind === 'api') {
      if (value.updated_at !== undefined && !time(value.updated_at)) return invalid();
      revision = value.updated_at as number | undefined;
      if (record(value.health) && typeof value.health.status === 'string') status = healthLabels[value.health.status] ?? 'Status not recorded';
    } else {
      if (value.last_synced_at !== null && !time(value.last_synced_at)) return invalid();
      lastSyncedAt = value.last_synced_at as number | null;
      if (kind === 'cloud') {
        if (typeof value.stale !== 'boolean') return invalid();
        status = value.stale ? 'Sync needs refresh' : 'No sync warning recorded';
      } else {
        status = typeof value.auth_state === 'string' ? authLabels[value.auth_state] ?? 'Sign-in status unknown' : 'Sign-in status unknown';
        if (kind === 'mail') {
          if (value.account_email !== undefined && value.account_email !== '' && !text(value.account_email)) return invalid();
          email = text(value.account_email) ? value.account_email : undefined;
          if (record(value.sync_status) && typeof value.sync_status.initial_sync_complete === 'boolean')
            status += value.sync_status.initial_sync_complete ? ' · Initial import complete' : ' · Initial import pending';
        }
      }
    }
    let href: string;
    try { href = kind === 'api' ? connectionsReviewAccessAddress(id).hash : connectionsAccountAddress(kind === 'cloud' ? 'file' : kind, kind === 'cloud' ? 'remote:' + id : id).hash; }
    catch { return invalid(); }
    rows.push({ key: JSON.stringify([kind, id]), kind, id, name, provider: providerId, providerLabel, status, href,
      ...(email ? { email } : {}), ...(revision === undefined ? {} : { revision }), ...(lastSyncedAt === undefined ? {} : { lastSyncedAt }) });
  }
  return rows;
};
const matches = (state: ConnectionSearchState): ConnectionSearchRow[] => {
  const words = fold(state.query).trim().split(/\s+/u).filter(Boolean);
  return state.sources.flatMap(source => source.rows).filter(row => {
    const haystack = fold([row.name, row.id, row.email, row.provider, row.providerLabel, CONNECTION_SEARCH_LABELS[row.kind]].filter(Boolean).join(' '));
    return words.every(word => haystack.includes(word));
  }).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
};
export const connectionSearchUncertain = (state: ConnectionSearchState | undefined): boolean => !!state
  && (!state.loaded || state.loading || state.stale || state.sources.some(source => !!source.error || source.unavailable === true));
const identity = (row: ConnectionSearchRow): string => JSON.stringify([row.kind, row.id, row.name, row.provider, row.email, row.revision]);

export const createConnectionSearch = (callers: ConnectionSearchCallers | undefined, changed: () => void) => {
  let state = empty(), generation = 0, activity = 0, disposed = false, pending = Promise.resolve();
  const publish = () => {
    state = { ...state, matches: matches(state), loading: state.sources.some(source => source.loading), loaded: state.sources.every(source => source.loaded) };
    changed();
  };
  const load = (query: string, refresh = false): Promise<void> => {
    if (disposed || !callers) return pending;
    if (!refresh && (state.loaded || state.loading)) { state = { ...state, query, matches: matches({ ...state, query }) }; changed(); return pending; }
    const mine = ++generation, version = activity;
    const keep = state.query === query;
    state = { ...state, query, stale: false, sources: state.sources.map(source => ({ kind: source.kind, rows: keep ? source.rows : [], loaded: false, loading: !!callers[source.kind], unavailable: !callers[source.kind] })) };
    publish();
    pending = Promise.all(CONNECTION_SEARCH_KINDS.map(async kind => {
      const read = callers[kind];
      let source: ConnectionSearchSource = { kind, rows: [], loaded: true, loading: false, unavailable: !read };
      if (read) try { source = { ...source, rows: readConnectionSearchSource(kind, await read()) }; }
      catch (error) {
        const code = classifyRpcError(error).code;
        source = { ...source, unavailable: code === 'unknown_method' || code === 'not_configured',
          error: 'Saved connections could not be read. Refresh connections and try again.' };
      }
      if (disposed || mine !== generation) return;
      state = { ...state, stale: version !== activity, sources: state.sources.map(previous => previous.kind === kind ? source : previous) }; publish();
    })).then(() => {});
    return pending;
  };
  const unsubscribe = callers?.observe?.(() => {
    activity++;
    if (!disposed && (state.loaded || state.loading)) { state = { ...state, stale: true }; changed(); }
  });
  return {
    state: () => state, load, whenLoaded: () => pending,
    reset() { generation++; state = empty(); },
    snapshot: () => structuredClone({ ...state, loading: false, sources: state.sources.map(source => ({ ...source, loading: false })) }),
    restore(value: ConnectionSearchState) { generation++; state = structuredClone(value); },
    async resolve(selected: ConnectionSearchRow): Promise<boolean> {
      const read = callers?.[selected.kind]; if (!read || disposed) return false;
      const mine = generation;
      const response = await read();
      if (disposed || mine !== generation) return false;
      const current = readConnectionSearchSource(selected.kind, response).find(row => row.key === selected.key);
      // Account lists have no immutable lifetime ID. Confirm their available
      // identity metadata; API rows additionally carry the saved revision.
      if (!current || identity(selected) !== identity(current)) throw Error('This connection changed or is no longer saved. Refresh connections before opening it.');
      return true;
    },
    dispose() { disposed = true; generation++; unsubscribe?.(); },
  };
};
