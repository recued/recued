import type Database from 'better-sqlite3';
import type { Collection } from '../collections/types.js';
import { collectionTableName, listCollectionDataTables } from '../collections/table.js';
import { CONTACT_TABLE } from '../storage/contact-merge-graph.js';
import { ASSET_TABLE, NOTE_TABLE, PROJECT_TABLE, TASK_TABLE } from '../storage/work-entity-store.js';

/** A full source population, not the number of AI calls the next cycle will
 * make. Use only row metadata; never hydrate bodies or run a producer here.
 * Missing schemas and unsupported scopes are unknown, rather than empty. */
export const countHousekeepingSourceRecords = (
  db: Database.Database,
  collectionRegistry: { list(): ReadonlyArray<Pick<Collection, 'platform' | 'slug' | 'countRecords'>> } | undefined,
  scope: string,
): number | undefined => {
  const source = scope.startsWith('data.') ? scope.slice(5) : scope;
  const countRows = (table: string, where = ''): number => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" ${where}`).get() as { n: number };
    return row.n;
  };
  try {
    switch (source) {
      case 'mail':
      case 'calendar':
      case 'file': {
        if (!collectionRegistry) return undefined;
        const collections = collectionRegistry.list().filter((c) => c.platform === source);
        if (collections.length === 0) return 0;
        const physical = new Set(listCollectionDataTables(db, source, { all: true }));
        const visible = listCollectionDataTables(db, source);
        let total = 0;
        for (const collection of collections) {
          // Inbound files exclude archived attachments from the walker's
          // default list. Let that collection count its visible metadata.
          if (source === 'file' && collection.countRecords !== undefined) {
            const count = collection.countRecords();
            if (!Number.isSafeInteger(count) || count < 0) return undefined;
            total += count;
            continue;
          }
          const table = collectionTableName(source, collection.slug);
          // A registered non-SQL collection cannot be counted from this DB.
          if (!physical.has(table)) return undefined;
          // The canonical reader may exclude a chat mailbox or return an
          // owner-only view. Preserve both whole-table and row exclusions.
          const reader = visible.find((name) => name === table
            || (name.startsWith(`${table}_owner_`) && /^[0-9a-f]{8}$/.test(name.slice(table.length + 7))));
          if (reader !== undefined) total += countRows(reader);
        }
        return total;
      }
      case 'contact':
        // Match walkByEmail, including merged rows the walker still visits.
        return countRows(CONTACT_TABLE, "WHERE email > ''");
      case 'note':
      case 'task':
      case 'project': {
        const table = { note: NOTE_TABLE, task: TASK_TABLE, project: PROJECT_TABLE }[source];
        return countRows(table, "WHERE id > '' AND sync_state IN ('live', 'stale_unreachable')");
      }
      case 'asset':
        return countRows(ASSET_TABLE, "WHERE id > '' AND deleted_at IS NULL AND sync_state IN ('live', 'stale_unreachable')");
      default:
        return undefined;
    }
  } catch {
    // A preview must not disable Run now when metadata is unavailable, nor
    // publish a partial total as though the uncountable source were empty.
    return undefined;
  }
};
