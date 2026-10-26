import type Database from 'better-sqlite3';
import { ASSET_SEARCH_TERMS, assetSearchTerms } from '@recued/contracts';

/** A fresh metadata snapshot, including owner/pack edits and removals. A store
 * may be opened before Yours has registered its classes. No persistent cache. */
export const readAssetTypeSearchTerms = (db: Database.Database, classId?: string): Map<string, string[]> => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='asset_class_presets'").get()) return new Map();
  const rows = db.prepare(`SELECT id,json_quote(json_extract(value,'$.fields.settings.${ASSET_SEARCH_TERMS}')) AS terms
    FROM asset_class_presets${classId === undefined ? '' : ' WHERE id=?'}`).all(...(classId === undefined ? [] : [classId])) as Array<{ id: string; terms: string }>;
  return new Map(rows.map(row => [row.id, assetSearchTermsFromJson(row.terms)]));
};

export const assetSearchTermsFromJson = (value: string): string[] => {
  try { return assetSearchTerms(JSON.parse(value)); } catch { return []; }
};
