/** Table-only business-context readers for the standalone stdio MCP profile.
 *
 * The MCP and serve processes share one WAL-backed database. Query recipes need
 * the same contact/work/calendar facts as event recipes, but the MCP process
 * must never start a second provider loop. These readers reuse the canonical
 * stores and expose calendar tables dynamically, without credentials, network
 * activity, sync, retention, or a mutation path through the context operation.
 */

import type Database from 'better-sqlite3';

import { createCalendarTable } from './collections/calendar/calendar-table.js';
import { createInstanceStore } from './collections/instance-store.js';
import type {
  ContactBusinessContextCalendarReader,
  ContactBusinessContextDeps,
} from './contact-business-context.js';
import { createContactStore } from './storage/contact-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
} from './storage/work-entity-store.js';

export interface McpReadonlyBusinessContextReaders {
  contacts: ContactBusinessContextDeps['contacts'];
  workEntities: NonNullable<ContactBusinessContextDeps['workEntities']>;
  calendars: ContactBusinessContextCalendarReader;
}

export const createMcpReadonlyBusinessContextReaders = (
  db: Database.Database,
): McpReadonlyBusinessContextReaders => {
  const contacts = createContactStore(db);
  ensureWorkEntitySchema(db);
  const workEntities = createWorkEntityStore(db);
  const instances = createInstanceStore({ db });
  const tables = new Map<string, ReturnType<typeof createCalendarTable>>();
  const tableFor = (slug: string): ReturnType<typeof createCalendarTable> => {
    const existing = tables.get(slug);
    if (existing) return existing;
    const table = createCalendarTable({ db, slug });
    tables.set(slug, table);
    return table;
  };
  const calendars: ContactBusinessContextCalendarReader = {
    instances,
    // Resolve the enrolled set on every pull. A long-lived MCP process therefore
    // sees a calendar enrolled later by the serve process without restarting or
    // owning that collection's provider lifecycle.
    listLive: () => instances.list('calendar').map((instance) => ({
      slug: instance.slug,
      table: tableFor(instance.slug),
    })),
  };
  return { contacts, workEntities, calendars };
};
