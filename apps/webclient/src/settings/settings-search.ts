import { SETTINGS_FINDER_TARGETS, searchSettingsTargets, settingsFinderHash, type SettingsFinderTarget } from './settings-finder-targets.js';
import { readSearchNavigationReturn } from '../shell/search-navigation-return.js';

export const SEARCH_OPEN_SETTING = 'universal-search-open-setting';
export const SEARCH_SETTING_ID = 'data-search-setting-id';
export type SettingSearchResult = Pick<SettingsFinderTarget, 'id' | 'section' | 'title' | 'location' | 'description'>;
export interface SettingsSearchResults { matches: readonly SettingSearchResult[] }

/** Reuse the finder's names and aliases. Current values, editable fields and
 * server configuration are never read or retained by this local projection. */
export const settingsSearchResults = (entries: readonly SettingsFinderTarget[], query: string): SettingsSearchResults => ({
  matches: (query.trim() ? searchSettingsTargets(entries, query) : entries).map(({ id, section, title, location, description }) => ({ id, section, title, location, description })),
});

export const readSettingsSearchVisit = (doc: Document | undefined, owner: object, hash: string) => {
  if (!doc) return undefined;
  const visit = readSearchNavigationReturn(doc, owner);
  if (!visit || visit.focus.action !== SEARCH_OPEN_SETTING || visit.focus.attribute !== SEARCH_SETTING_ID || visit.destinationHash !== hash) return undefined;
  const entry = SETTINGS_FINDER_TARGETS.find(row => row.id === visit.focus.id && settingsFinderHash(row) === hash);
  return entry ? { hash: visit.returnHash, destinationHash: hash } : undefined;
};
