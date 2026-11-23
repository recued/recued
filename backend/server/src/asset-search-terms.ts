import type Database from 'better-sqlite3';
import { ASSET_SEARCH_TERMS, assetSearchTerms } from '@recued/contracts';

/** A fresh metadata snapshot, including owner/pack edits and removals. A store
 * may be opened before Yours has registered its classes. No persistent cache. */
/** Each type's keywords, as search reads them: its name first, then its search terms.
 *
 *  2026-11-18 (D-404, the owner): *"name is just part of the keyword"*. A type's name is one of its
 *  keywords, so a Passport called "Blue travel book" is found by "passport" in `work.search` and in
 *  a chat's prefetch, as "travel" (one of Passport's terms) already found it. Read by the search
 *  index and the prefetch matcher only; a type's own `search_terms` are unchanged and no surface
 *  shows the name as one. */
export const readAssetTypeSearchTerms = (db: Database.Database, classId?: string): Map<string, string[]> => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='asset_class_presets'").get()) return new Map();
  const rows = db.prepare(`SELECT id,json_extract(value,'$.name') AS name,json_quote(json_extract(value,'$.fields.settings.${ASSET_SEARCH_TERMS}')) AS terms
    FROM asset_class_presets${classId === undefined ? '' : ' WHERE id=?'}`).all(...(classId === undefined ? [] : [classId])) as Array<{ id: string; name: unknown; terms: string }>;
  return new Map(rows.map(row => [row.id, withTypeName(row.name, assetSearchTermsFromJson(row.terms))]));
};

const withTypeName = (name: unknown, terms: string[]): string[] => {
  const own = typeof name === 'string' ? name.trim() : '';
  return own.length === 0 || terms.some(term => term.toLocaleLowerCase('en') === own.toLocaleLowerCase('en')) ? terms : [own, ...terms];
};

export const assetSearchTermsFromJson = (value: string): string[] => {
  try { return assetSearchTerms(JSON.parse(value)); } catch { return []; }
};
