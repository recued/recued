/** D-348 slice 6b — Recued's own deletes a request's rule may let through, each by the record it
 *  deletes, and the reads that find such records: two closed lists.
 *
 *  A pack's delete declares its record (D-254 `record_id_arg`) and the catalog gate reads where a
 *  pack's read keeps its records. Recued's own stores declare neither, so they are named here, one
 *  by one, from each store's own ids: a task by its id, a message by its mailbox and record id, an
 *  event by its calendar and `source_id`, a file by its folder and path. A delete or a read not on
 *  these lists finds nothing and lets nothing through: the delete asks.
 *
 *  ⛔ NOT ON THE LISTS, ON PURPOSE:
 *  - `shared-delete-prefix` deletes every key under a prefix, never one found record;
 *  - `file-move` may overwrite its destination, which no read found;
 *  - a calendar delete of more than one occurrence (`this_and_future`, `series`);
 *  - a read that returns content other people write (a web page, an HTTP response, a CSV file, a
 *    message's text): an id taken from it is one they chose. Only a store's own listing of its own
 *    records finds one. */

import { stripCorePrefix } from '@recued/contracts';

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const rowsAt = (result: unknown, key: string): Record<string, unknown>[] => {
  const rows = recordOf(result)[key];
  return Array.isArray(rows) ? rows.map(recordOf) : [];
};

/** One record of one store, as both lists name it. */
const recordKey = (store: string, place: string, id: string): string => JSON.stringify([store, place, id]);

const WORK_DELETES: Readonly<Record<string, string>> = {
  'task-delete': 'task',
  'note-delete': 'note',
  'booking-delete': 'booking',
};

/** The record a delete on the list deletes, or undefined: a delete not on the list, one whose
 *  arguments do not name its one record, or a calendar delete of more than one occurrence. */
export const ownDeleteRecord = (slug: string, args: Readonly<Record<string, unknown>>): string | undefined => {
  const name = stripCorePrefix(slug);
  const kind = WORK_DELETES[name];
  if (kind !== undefined) {
    const id = text(args.id);
    return id === undefined ? undefined : recordKey('work', kind, id);
  }
  switch (name) {
    case 'mail-delete': {
      const mailbox = text(args.slug);
      const id = text(args.record_id);
      return mailbox === undefined || id === undefined ? undefined : recordKey('mail', mailbox, id);
    }
    case 'calendar-delete': {
      // An unset scope deletes the one occurrence named, as `this_instance` does.
      if (args.scope != null && args.scope !== 'this_instance') return undefined;
      const calendar = text(args.slug);
      const id = text(args.source_id);
      return calendar === undefined || id === undefined ? undefined : recordKey('calendar', calendar, id);
    }
    case 'file-delete': {
      const folder = text(args.slug);
      const path = text(args.path);
      return folder === undefined || path === undefined ? undefined : recordKey('file', folder, path);
    }
    default:
      return undefined;
  }
};

/** Every value a read's arguments hold, compared case-blind: a record they named, it did not find.
 *  The catalog gate's reads are judged the same way (`createChainFound`). */
export const namedIn = (args: unknown): Set<string> => {
  const named = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof node === 'string' || (typeof node === 'number' && Number.isFinite(node))) {
      named.add(String(node).trim().toLowerCase());
    } else if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
    } else if (node !== null && typeof node === 'object') {
      Object.values(node as Record<string, unknown>).forEach((value) => visit(value, depth + 1));
    }
  };
  visit(args, 0);
  return named;
};

/** The records a read on the list returned, less any its own arguments named; none for any other
 *  call. Read from each store's own listing, never from what a record says. */
export const ownReadRecords = (
  slug: string,
  args: Readonly<Record<string, unknown>>,
  result: unknown,
): string[] => {
  const name = stripCorePrefix(slug);
  const found: Array<[string, string, string | undefined]> = [];
  switch (name) {
    case 'work-entity-list': {
      const kind = text(args.kind);
      if (kind === undefined) return [];
      for (const entity of rowsAt(result, 'entities')) found.push(['work', kind, text(entity.id)]);
      break;
    }
    case 'email-list':
    case 'email-search': {
      const mailbox = text(args.slug);
      if (mailbox === undefined) return [];
      for (const row of rowsAt(result, name === 'email-list' ? 'records' : 'matches')) {
        found.push(['mail', mailbox, text(row.record_id)]);
      }
      break;
    }
    case 'calendar-list': {
      // A list of every calendar names each row's own (`collection_slug`).
      for (const row of rowsAt(result, 'records')) {
        const calendar = text(row.collection_slug) ?? text(args.slug);
        if (calendar !== undefined) found.push(['calendar', calendar, text(row.source_id)]);
      }
      break;
    }
    case 'file-list': {
      const folder = text(args.slug);
      if (folder === undefined) return [];
      for (const row of rowsAt(result, 'records')) found.push(['file', folder, text(recordOf(row.hot_fields).path)]);
      break;
    }
    default:
      return [];
  }
  const named = namedIn(args);
  return found
    .filter((entry): entry is [string, string, string] => entry[2] !== undefined && !named.has(entry[2].trim().toLowerCase()))
    .map(([store, place, id]) => recordKey(store, place, id));
};
