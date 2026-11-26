import { describe, expect, it } from 'vitest';
import { SETTINGS_FINDER_TARGETS, settingsFinderHash } from '../settings/settings-finder-targets.js';
import { settingsSearchResults, readSettingsSearchVisit, SEARCH_OPEN_SETTING, SEARCH_SETTING_ID } from '../settings/settings-search.js';
import { renderSettingsSearch } from '../settings/settings-search-view.js';
import { filterUniversalSearch, searchTypeCounts } from '../data/universal-search-filter.js';
import { renderUniversalSearch } from '../data/universal-search.js';
import { saveSearchNavigationReturn } from '../shell/search-navigation-return.js';

describe('Settings in Universal Search', () => {
  it('reuses names, aliases, ranking and exact destinations, including empty-query browsing and a restricted client inventory', () => {
    for (const [query, expected] of [['DND', 'quiet-hours'], ['time zone', 'timezone'], ['daily budget', 'ai-budget'], ['défault model', 'default-model']] as const) {
      const row = settingsSearchResults(SETTINGS_FINDER_TARGETS, query).matches[0]!;
      expect(row.id).toBe(expected); expect(settingsFinderHash(row)).toBe(`#settings/${row.section}/find/${expected}`);
    }
    const allowed = SETTINGS_FINDER_TARGETS.filter(row => row.section === 'privacy');
    expect(settingsSearchResults(allowed, 'DND').matches).toEqual([]);
    expect(settingsSearchResults(allowed, '').matches.map(row => row.id)).toEqual(allowed.map(row => row.id));
    expect(settingsSearchResults(allowed, '.*unknown').matches).toEqual([]);
  });
  it('projects display metadata only, never current values, internal selectors or arbitrary extra fields', () => {
    const entry = { ...SETTINGS_FINDER_TARGETS.find(row => row.id === 'timezone')!, current_value: 'private-zone-value', token: 'private-token' };
    expect(settingsSearchResults([entry], 'private').matches).toEqual([]);
    const result = settingsSearchResults([entry], 'timezone'); const snapshot = JSON.stringify(result);
    expect(snapshot).not.toContain('private-'); expect(snapshot).not.toContain('selector'); expect(snapshot).not.toContain('keywords');
    const html = renderSettingsSearch(result, '<img.*>', 'data-action'); expect(html).not.toContain('<img');
    expect(html).toContain('#settings/server/find/timezone'); expect(html).toContain('Open setting: Server timezone');
  });
  it('counts settings, hides them under other types, and keeps a local match out of empty-result and spelling-correction flows', () => {
    const settingsSearch = settingsSearchResults(SETTINGS_FINDER_TARGETS, 'DND');
    const props = { query: 'DND', actionAttr: 'data-action', settingsSearch, groups: [] };
    expect(searchTypeCounts(props).setting).toEqual({ loaded: 1, more: false, pending: false, unavailable: false });
    expect(filterUniversalSearch(props, 'mail').settingsSearch).toBeUndefined(); expect(filterUniversalSearch(props, 'setting').settingsSearch).toBe(settingsSearch);
    const html = renderUniversalSearch(props); expect(html).toContain('Quiet hours'); expect(html).not.toContain('No matches in the searched sources');
    expect(renderUniversalSearch({ ...props, query: '', resultType: 'setting', settingsSearch: settingsSearchResults(SETTINGS_FINDER_TARGETS, '') })).toContain('Server timezone');
    expect(renderSettingsSearch(settingsSearch, 'DND', 'data-action', true)).toContain('aria-disabled="true"');
  });
  it('binds return context to the originating owner, selected setting and exact panel address', () => {
    const doc = {} as Document, owner = {}, row = SETTINGS_FINDER_TARGETS.find(row => row.id === 'quiet-hours')!;
    const visit = { destinationHash: settingsFinderHash(row), returnHash: '#views/view_example', state: { query: 'DND' },
      focus: { action: SEARCH_OPEN_SETTING, attribute: SEARCH_SETTING_ID, id: row.id }, scrollTop: 100 };
    saveSearchNavigationReturn(doc, owner, visit);
    expect(readSettingsSearchVisit(doc, owner, visit.destinationHash)).toEqual({ hash: visit.returnHash, destinationHash: visit.destinationHash });
    expect(readSettingsSearchVisit(doc, {}, visit.destinationHash)).toBeUndefined(); expect(readSettingsSearchVisit(doc, owner, '#settings/notifications')).toBeUndefined();
    saveSearchNavigationReturn(doc, owner, { ...visit, focus: { ...visit.focus, id: 'timezone' } }); expect(readSettingsSearchVisit(doc, owner, visit.destinationHash)).toBeUndefined();
    saveSearchNavigationReturn(doc, owner, { ...visit, focus: { ...visit.focus, action: 'other-action' } }); expect(readSettingsSearchVisit(doc, owner, visit.destinationHash)).toBeUndefined();
  });
});
