/** D-333 — the source a pack was installed from in Kitchen, so the owner can edit it again.
 *
 *  An install keeps only the pieces the gateway runs (the local manifest store); the
 *  composition the pack builder edits is not among them. This store keeps the manifest that
 *  `ingredient.install` was given, stamped with the time of that install.
 *
 *  ⛔ STALENESS IS DECIDED BY THE INSTALL, NOT BY HOOKS. A pack can be removed, or replaced
 *  by a marketplace pack of the same slug, through paths that never call this store. So the
 *  kept source counts only while the installed pack's own row still carries the install time
 *  stamped here: any later install of that slug, or none, and there is nothing to edit — an
 *  old Kitchen source can never be offered over a pack that came from somewhere else. */
import type Database from 'better-sqlite3';
import type { BulkPackManifest } from '@recued/contracts';

const TABLE = 'kitchen_pack_source';

export interface KitchenPackSourceStore {
  /** The manifest a pack was just installed from in Kitchen, at that install's time, and the
   *  pack it is a copy of (`<publisher>.<slug>`) when it is one. */
  keep(packSlug: string, manifest: unknown, installedAt: number, copyOf?: string): void;
  /** The source, while the pack installed from it is still the installed one. */
  current(packSlug: string): BulkPackManifest | null;
  /** Each copy whose install is still the installed one, with the pack it copies. */
  copies(): Array<{ pack_ref: string; copy_of: string }>;
  remove(packSlug: string): void;
}

export const createKitchenPackSourceStore = (
  db: Database.Database,
  /** When the pack's installed row was last written; null when it is not installed. */
  installedAt: (packSlug: string) => number | null,
): KitchenPackSourceStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    pack_slug TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, installed_at INTEGER NOT NULL
  )`);
  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'copy_of')) db.exec(`ALTER TABLE ${TABLE} ADD COLUMN copy_of TEXT`);
  const keepStmt = db.prepare(`INSERT INTO ${TABLE} (pack_slug, manifest_json, installed_at, copy_of)
    VALUES (?, ?, ?, ?) ON CONFLICT (pack_slug) DO UPDATE SET
      manifest_json = excluded.manifest_json, installed_at = excluded.installed_at, copy_of = excluded.copy_of`);
  const getStmt = db.prepare(`SELECT manifest_json, installed_at FROM ${TABLE} WHERE pack_slug = ?`);
  const copiesStmt = db.prepare(`SELECT pack_slug, manifest_json, installed_at, copy_of FROM ${TABLE}
    WHERE copy_of IS NOT NULL ORDER BY pack_slug`);
  const removeStmt = db.prepare(`DELETE FROM ${TABLE} WHERE pack_slug = ?`);
  return {
    keep(packSlug, manifest, at, copyOf) {
      keepStmt.run(packSlug, JSON.stringify(manifest), at, copyOf ?? null);
    },
    copies() {
      const rows = copiesStmt.all() as Array<{ pack_slug: string; manifest_json: string; installed_at: number; copy_of: string }>;
      return rows.flatMap((row) => {
        if (installedAt(row.pack_slug) !== row.installed_at) return [];
        try {
          const publisher = (JSON.parse(row.manifest_json) as { publisher?: unknown }).publisher;
          return typeof publisher === 'string' ? [{ pack_ref: `${publisher}.${row.pack_slug}`, copy_of: row.copy_of }] : [];
        } catch {
          return [];
        }
      });
    },
    current(packSlug) {
      const row = getStmt.get(packSlug) as { manifest_json: string; installed_at: number } | undefined;
      if (row === undefined || installedAt(packSlug) !== row.installed_at) return null;
      try {
        return JSON.parse(row.manifest_json) as BulkPackManifest;
      } catch {
        return null;
      }
    },
    remove(packSlug) {
      removeStmt.run(packSlug);
    },
  };
};
