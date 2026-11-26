import { describe, expect, it, vi } from 'vitest';
import { createConnectionSearch, readConnectionSearchSource, connectionSearchUncertain, type ConnectionSearchCallers } from '../connections/connection-search.js';
import { renderConnectionSearch } from '../connections/connection-search-view.js';
import { renderUniversalSearch } from '../data/universal-search.js';
import { filterUniversalSearch, searchTypeCounts } from '../data/universal-search-filter.js';
const account = (patch: Record<string, unknown> = {}) => ({ slug: 'work', adapter_type: 'gmail', account_email: 'owner@example.org', auth_state: 'expired', last_synced_at: null,
  sync_status: { access_verified: false, initial_sync_complete: false }, ...patch });
const api = (patch: Record<string, unknown> = {}) => ({ kind: 'api', name: 'crm', display_name: 'Café ﬁle <img.*>', vendor: 'hubspot', updated_at: 100,
  health: { status: 'auth_failed', last_error: 'private-error' }, config: { secret: 'private-config' }, base_url: 'https://private-url', headers: { authorization: 'private-header' }, ...patch });
const inventories = (): ConnectionSearchCallers => ({ mail: async () => ({ instances: [account()] }), calendar: async () => ({ instances: [account({ adapter_type: 'gcal' })] }),
  file: async () => ({ instances: [account({ adapter_type: 'fs' })] }), cloud: async () => ({ sources: [{ source_id: 'folder/one', label: 'Project files', provider: 'sharepoint', stale: true, last_synced_at: 500, authentication_connection: 'private-auth' }] }),
  api: async () => ({ connections: [api(), { kind: 'mcp', name: 'private-mcp' }] }) });

describe('saved connection search', () => {
  it('matches public names, IDs, account emails and provider labels literally, projects only safe metadata and distinguishes equal IDs by lane', async () => {
    const source = createConnectionSearch(inventories(), () => {});
    await source.load(''); expect(source.state().matches).toHaveLength(5);
    expect(new Set(source.state().matches.map(row => row.key)).size).toBe(5);
    for (const [query, count] of [['CAFÉ FILE <img.*>', 1], ['owner@example.org Gmail', 1], ['folder/one', 1], ['hubspot', 1], ['work', 3], ['private-', 0]]) {
      await source.load(query as string); expect(source.state().matches).toHaveLength(count as number);
    }
    await source.load(''); expect(JSON.stringify(source.snapshot())).not.toContain('private-');
     const html = renderConnectionSearch(source.state(), 'data-action');
    expect(html).toContain('Initial import pending'); expect(html).toContain('Sign-in expired'); expect(html).toContain('Sync needs refresh');
    expect(html).toContain('Recorded health: sign-in failed'); expect(html).not.toContain('<img');
    expect(source.state().matches.find(row => row.kind === 'cloud')?.href).toBe('#connections/file/remote%3Afolder%2Fone'); source.dispose();
  });
  it('keeps independent results visible during a held or failed inventory and never treats partial reads as an empty result or a cloud-search offer', async () => {
    let release!: (value: unknown) => void;
    const callers = inventories(); callers.mail = () => new Promise(resolve => { release = resolve; });
    callers.calendar = async () => { throw { code: 'unknown_method', message: 'private-error' }; };
    const source = createConnectionSearch(callers, () => {}); const pending = source.load('unmatched');
    await Promise.resolve(); expect(source.state().loading).toBe(true); expect(connectionSearchUncertain(source.state())).toBe(true);
    release({ instances: [] }); await pending; expect(source.state().loaded).toBe(true); expect(source.state().sources.find(row => row.kind === 'calendar')?.unavailable).toBe(true);
    const html = renderUniversalSearch({ query: 'unmatched', actionAttr: 'data-action', groups: [], connectionSearch: source.state(), marketplaceOffered: true });
    expect(html).not.toContain('No matches in the searched sources'); expect(html).not.toContain('Search the Marketplace');
    expect(html).toContain('Calendar accounts: unavailable'); expect(html).not.toContain('private-error');
    callers.calendar = async () => ({ instances: [account()] }); callers.mail = async () => ({ instances: [] });
    await source.load('work', true); expect(source.state().matches).toHaveLength(2); expect(connectionSearchUncertain(source.state())).toBe(false); source.dispose();
  });
  it('re-reads selected metadata, refuses removed or changed accounts and API revisions, and accepts status-only changes', async () => {
    let rows = [account()], apis = [api()]; const source = createConnectionSearch({ mail: async () => ({ instances: rows }), api: async () => ({ connections: apis }) }, () => {});
    await source.load(''); const mail = source.state().matches.find(row => row.kind === 'mail')!, saved = source.state().matches.find(row => row.kind === 'api')!;
    rows = [account({ auth_state: 'healthy' })]; expect(await source.resolve(mail)).toBe(true);
    rows = [account({ account_email: 'replacement@example.org' })]; await expect(source.resolve(mail)).rejects.toThrow('changed');
    rows = []; await expect(source.resolve(mail)).rejects.toThrow('no longer saved');
    apis = [api({ updated_at: 101 })]; await expect(source.resolve(saved)).rejects.toThrow('changed'); source.dispose();
  });
  it('retires delayed inventories and exact checks across reset, restore and disposal, and restores completed snapshots without re-reading', async () => {
    let release!: (value: unknown) => void, changed!: () => void; const off = vi.fn();
    const read = vi.fn(() => new Promise<unknown>(resolve => { release = resolve; }));
    const source = createConnectionSearch({ mail: read, observe: listener => { changed = listener; return off; } }, () => {});
    const pending = source.load('old'); source.reset(); release({ instances: [account()] }); await pending; expect(source.state().matches).toEqual([]);
    const next = source.load('work'); release({ instances: [account()] }); await next;
    const snapshot = source.snapshot(); const reads = read.mock.calls.length; source.reset(); source.restore(snapshot); await source.load('work'); expect(read.mock.calls).toHaveLength(reads);
    changed(); expect(source.state().stale).toBe(true); expect(source.state().matches).toHaveLength(1);
    const selection = source.resolve(source.state().matches[0]!); source.reset(); release({ instances: [account()] }); expect(await selection).toBe(false);
    const late = source.load('later'); source.dispose(); release({ instances: [account()] }); await late; expect(source.state().matches).toEqual([]); expect(off).toHaveBeenCalledOnce();
  });
  it('rejects malformed and ambiguous lists, omits unexpected API kinds, and describes missing status honestly', () => {
    for (const response of [{ instances: [account(), account()] }, { instances: [account({ last_synced_at: NaN })] }, { instances: null }])
      expect(() => readConnectionSearchSource('mail', response)).toThrow('could not be confirmed');
    expect(() => readConnectionSearchSource('api', { connections: [api({ kind: 'other' })] })).toThrow();
    const row = readConnectionSearchSource('api', { connections: [api({ health: undefined, vendor: 'https://private-url' })] })[0]!;
    expect(row.status).toBe('Status not recorded'); expect(row.provider).toBe('');
  });
  it('counts materialized connections and hides their rows and open status under other result types', async () => {
    const source = createConnectionSearch(inventories(), () => {}); await source.load('work');
    const props = { query: 'work', actionAttr: 'data-action', connectionSearch: source.state(), connectionOpening: 'selected' };
    expect(searchTypeCounts(props).connection).toEqual({ loaded: 3, more: false, pending: false, unavailable: false });
    expect(filterUniversalSearch(props, 'mail').connectionSearch).toBeUndefined();
    expect(filterUniversalSearch(props, 'mail').connectionOpening).toBeUndefined();
    expect(filterUniversalSearch(props, 'connection').connectionSearch).toBe(source.state()); source.dispose();
  });
});
