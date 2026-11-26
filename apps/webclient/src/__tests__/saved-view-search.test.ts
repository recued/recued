import { describe, expect, it, vi } from 'vitest';
import { createSavedViewSearch, readSavedViewSearchRow, readSavedViewSearchList, readSavedViewSearchVisit,
  savedViewSearchHref, savedViewSearchAliases, sameSavedViewSearchSelection, savedViewSearchUncertain,
  SEARCH_OPEN_SAVED_VIEW, SEARCH_SAVED_VIEW_ID } from '../data/saved-view-search.js';
import { renderSavedViewSearch } from '../data/saved-view-search-view.js';
import { savedViewSettingsSummary } from '../data/saved-view-summary.js';
import { renderUniversalSearch } from '../data/universal-search.js';
import { filterUniversalSearch, searchTypeCounts } from '../data/universal-search-filter.js';
import { saveSearchNavigationReturn } from '../shell/search-navigation-return.js';
const id = (n = 1) => `view_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const view = (patch: Record<string, unknown> = {}) => ({ id: id(), name: 'Work queue', revision: 1, created_at: 1, updated_at: 1,
  definition: { tab: 'task', query: '', source_id: null, booking_lifecycle: 'all', task_filters: { completion: 'open', due: 'overdue', sort: 'due_asc' } }, ...patch });

describe('Saved Views in universal search', () => {
  it('finds names, saved filters, data types and pack identities literally, and excludes hidden, retired and arbitrary metadata', async () => {
    const list = vi.fn(async () => ({ views: [view({ raw_results: 'private-results', review: { token: 'private-review' } }),
      view({ id: id(2), name: 'Café ﬁle <img.*>', definition: { tab: 'contact', query: 'customer' }, pack: { publisher: 'recued-core', slug: 'client-desk', private_key: 'private-pack' } }),
      view({ id: id(3), name: 'private-hidden', hidden: true }), view({ id: id(4), name: 'private-retired', retired: { at: 1 } })],
      retired: [view({ id: id(5), name: 'private-retirement' })] }));
    const source = createSavedViewSearch({ list, get: async () => ({ view: view() }) }, () => {});
    await source.load(''); expect(source.state().matches).toHaveLength(2);
    for (const [query, expected] of [['overdue tasks', 1], ['CAFÉ FILE <img.*>', 1], ['client-desk Contacts', 1], ['recued-core', 1], ['private-', 0], ['.*missing', 0]] as const) {
      await source.load(query); expect(source.state().matches).toHaveLength(expected);
    }
    await source.load(''); expect(list).toHaveBeenCalledOnce(); expect(JSON.stringify(source.snapshot())).not.toContain('private-');
    const html = renderSavedViewSearch(source.state(), 'data-action'); expect(html).not.toContain('<img'); expect(html).toContain('Alerts off');
    expect(html).toContain('From recued-core/client-desk'); source.dispose();
  });
  it('shares filter and recorded alert wording with the Saved Views owner and treats unusable alert metadata as unknown', () => {
    const row = readSavedViewSearchRow(view({ alert: { enabled: true, status: 'unavailable', time_zone: 'UTC', last_checked_at: 100 } }))!;
    expect(row.summary).toContain('Overdue'); expect(row.summary).toContain('Due date — earliest first'); expect(row.alert).toContain('Alerts waiting for your tasks');
    expect(readSavedViewSearchRow(view({ alert: { enabled: false, status: 'paused', time_zone: 'UTC', last_checked_at: null } }))?.alert).toBe('Alerts paused');
    expect(readSavedViewSearchRow(view({ alert: { enabled: true, status: 'private-error' } }))?.alert).toBe('Alert status unavailable');
    expect(savedViewSettingsSummary({ tab: 'commitment', query: '', source_id: null, booking_lifecycle: 'all', commitment_filters: { direction: 'inbound', status: 'overdue' } })).toContain('Promises to you · Overdue');
    expect(savedViewSettingsSummary({ tab: 'search', query: '', reminder_dates: { range: 'week', time_zone: 'UTC' } })).toContain('Next seven days (UTC)');
    expect(savedViewSettingsSummary({ tab: 'search', query: 'renewal', result_type: 'run', run_filters: { outcome: 'failed', time_range: '7d' } })).toContain('Runs:');
    expect(savedViewSettingsSummary({ tab: 'records', owner: { publisher: 'example', pack_slug: 'customers' }, entity: 'invoice', filters: { status: { op: 'eq', value: 'open' } }, sort: '-created_at' })).toContain('status = "open"');
  });
  it('refuses deleted, hidden, retired, changed or substituted selections, while an alert check alone does not change their identity', async () => {
    let current: unknown = view(); const source = createSavedViewSearch({ list: async () => ({ views: [view({ alert: { enabled: true, status: 'watching', time_zone: 'UTC', last_checked_at: 100 } })] }), get: async () => ({ view: current }) }, () => {});
    await source.load(''); const selected = source.state().matches[0]!;
    for (const next of [null, view({ hidden: true }), view({ retired: { at: 1 } }), view({ revision: 2 }), view({ id: id(2) }), view({ definition: { tab: 'contact', query: 'other' } })]) {
      current = next; await expect(source.resolve(selected)).rejects.toThrow('changed or is no longer available');
    }
    current = view({ alert: { enabled: true, status: 'watching', time_zone: 'UTC', last_checked_at: 200 } }); expect(await source.resolve(selected)).toBe(true);
    expect(sameSavedViewSearchSelection(selected, readSavedViewSearchRow(current))).toBe(true); source.dispose();
  });
  it('retains confirmed rows on a failed refresh and refuses ambiguous inventories without claiming a complete empty search', async () => {
    let fail = false; const source = createSavedViewSearch({ list: async () => { if (fail) throw { code: 'unknown_method', message: 'private-error' }; return { views: [view()] }; }, get: async () => ({ view: null }) }, () => {});
    await source.load('overdue'); fail = true; await source.load('overdue', true);
    expect(source.state().matches).toHaveLength(1); expect(source.state().unsupported).toBe(true); expect(savedViewSearchUncertain(source.state())).toBe(true);
    const props = { query: 'overdue', actionAttr: 'data-action', savedViewSearch: source.state(), savedViewOpening: id() };
    expect(searchTypeCounts(props).saved_view).toMatchObject({ loaded: 1, unavailable: true });
    expect(filterUniversalSearch(props, 'contact').savedViewSearch).toBeUndefined(); expect(filterUniversalSearch(props, 'saved_view').savedViewSearch).toBe(source.state());
    const html = renderUniversalSearch({ ...props, savedViewSearch: { ...source.state(), matches: [] }, groups: [], marketplaceOffered: true });
    expect(html).not.toContain('No matches in the searched sources'); expect(html).not.toContain('Search the Marketplace'); expect(html).not.toContain('private-error');
    for (const input of [{ views: [view(), view()] }, { views: [view({ revision: 0 })] }, { views: [view({ definition: { tab: 'search', query: '', result_rows: [] } })] }, { views: null }])
      expect(() => readSavedViewSearchList(input)).toThrow('could not be confirmed'); source.dispose();
  });
  it('retires held list and exact replies, restores snapshots without reads and only marks live activity stale', async () => {
    let release!: (value: unknown) => void, activity!: () => void; const off = vi.fn();
    const list = vi.fn(() => new Promise<unknown>(resolve => { release = resolve; }));
    const source = createSavedViewSearch({ list, get: () => new Promise(resolve => { release = resolve; }), observe: listener => { activity = listener; return off; } }, () => {});
    const old = source.load('old'); source.reset(); release({ views: [view()] }); await old; expect(source.state().matches).toEqual([]);
    const next = source.load('queue'); release({ views: [view()] }); await next;
    const snapshot = source.snapshot(); source.reset(); source.restore(snapshot); await source.load('queue'); expect(list).toHaveBeenCalledTimes(2);
    activity(); expect(source.state().stale).toBe(true); expect(source.state().matches).toHaveLength(1);
    const selection = source.resolve(source.state().matches[0]!); source.reset(); release({ view: view() }); expect(await selection).toBe(false);
    const last = source.load('later'); source.dispose(); release({ views: [view()] }); await last; expect(source.state().matches).toEqual([]); expect(off).toHaveBeenCalledOnce();
  });
  it('binds return context to the owner, selected row and addressed view or its legacy destination, and identifies the already open view', async () => {
    const source = createSavedViewSearch({ list: async () => ({ views: [view()] }), get: async () => ({ view: view() }) }, () => {}); await source.load('');
    const selected = source.state().matches[0]!, doc = {} as Document, owner = {};
    saveSearchNavigationReturn(doc, owner, { destinationHash: savedViewSearchHref(selected.id), destinationAliases: ['#today'], returnHash: '#data/search',
      state: { savedViewsSearch: source.snapshot() }, focus: { action: SEARCH_OPEN_SAVED_VIEW, attribute: SEARCH_SAVED_VIEW_ID, id: selected.id }, scrollTop: 100 });
    expect(readSavedViewSearchVisit(doc, owner, savedViewSearchHref(selected.id))?.selection.id).toBe(selected.id);
    expect(readSavedViewSearchVisit(doc, owner, '#today')?.hash).toBe('#data/search'); expect(readSavedViewSearchVisit(doc, {}, '#today')).toBeUndefined();
    expect(readSavedViewSearchVisit(doc, owner, '#views')).toBeUndefined(); expect(readSavedViewSearchVisit(doc, owner, '#data/search')).toBeUndefined();
    const html = renderSavedViewSearch(source.state(), 'data-action', undefined, undefined, false, false, selected.id);
    expect(html).toContain('Current view'); expect(html).not.toContain(`href="${savedViewSearchHref(selected.id)}"`);
    expect(savedViewSearchAliases(readSavedViewSearchRow(view({ definition: { tab: 'webhook', collection_slug: null } }))!)).toEqual(['#connections/webhooks']); source.dispose();
  });
});
