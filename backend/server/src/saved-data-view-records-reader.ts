/** Owner-only Records queries share the saved view's filters and full pack identity. */
import { RECORDS_MAX_PAGE_SIZE } from '@recued/contracts';
import type { RecordsStore } from './records/store.js';
import type { SavedDataViewMatchReader } from './saved-data-view-alert-store.js';

/** The saved-view store holds a SQLite transaction across the entire read.
 * A missing/changed schema, unavailable namespace or incomplete traversal throws;
 * none may replace the last successful membership with a partial result. */
export const createSavedRecordsViewReader = (
  store: Pick<RecordsStore, 'ownerSearch'>,
): SavedDataViewMatchReader => (definition) => {
  if (definition.tab !== 'records' || definition.owner === null || definition.entity === null) {
    throw new Error('Records alerts require a selected pack and kind.');
  }
  const matches: Array<{ id: string }> = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = store.ownerSearch({
      owner: definition.owner, entity: definition.entity,
      ...(definition.filters ? { filters: definition.filters } : {}),
      ...(definition.sort ? { sort: definition.sort } : {}),
      ...(cursor ? { cursor } : {}),
      limit: RECORDS_MAX_PAGE_SIZE, include_orphaned: false,
    });
    for (const record of page.records) {
      if (ids.has(record.id)) throw new Error('Records alert pagination repeated a row.');
      ids.add(record.id);
      // Pack fields may contain private data. The notification carries only a
      // count and a link to the owner view, never guessed titles or raw fields.
      matches.push({ id: record.id });
    }
    cursor = page.next_cursor;
    if (cursor !== undefined) {
      if (!cursor || cursors.has(cursor) || page.records.length === 0) {
        throw new Error('Records alert pagination did not advance.');
      }
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return matches;
};
