/** D-273 P1 — the record of the port mapping WE created.
 *
 *  ⛔ THIS IS THE AUTHORITY, AND IT HAS TO BE, BECAUSE THE ROUTER CANNOT BE
 *  ASKED. NAT-PMP has no enumeration — assert or delete, never list. And once
 *  UPnP IGD lands (P2) enumeration exists but answers a different question:
 *  "port 443 is mapped to this machine" is not "we mapped it". The owner may
 *  have set a static forward by hand, and `DeletePortMapping` will remove one
 *  just as happily. ⇒ Only what we wrote down at creation time tells us a
 *  mapping is ours to take away.
 *
 *  ⚠ ONE ROW, BY CONSTRUCTION. A server maps one public port; a second row would
 *  mean two mappings and no way to say which is current, so the table is pinned
 *  to a single id rather than keyed by port. That also makes "no record" — the
 *  state after a first boot, a cleared toggle, or a gateway change — a plain
 *  absent row instead of a query that has to decide which row won.
 *
 *  Per-pair, never cloud-synced (D-097). */

import type Database from 'better-sqlite3';
import type { PortMappingRecord } from './port-mapping-plan.js';

export interface PortMappingStore {
  get(): PortMappingRecord | null;
  set(record: PortMappingRecord): void;
  clear(): void;
}

/** The single row's id. Not a port — see the note above on why this table holds
 *  exactly one record. */
const ROW_ID = 'current';

export const createPortMappingStore = (db: Database.Database): PortMappingStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS port_mapping (
      id   TEXT NOT NULL PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);

  return {
    get() {
      const row = db
        .prepare('SELECT data FROM port_mapping WHERE id = ?')
        .get(ROW_ID) as { data: string } | undefined;
      if (row === undefined) return null;
      try {
        return JSON.parse(row.data) as PortMappingRecord;
      } catch {
        // ⛔ UNREADABLE READS AS ABSENT, NEVER AS A THROW. A corrupt row would
        // otherwise take the server's boot with it — and the recovery for a lost
        // record is benign: we map again, and the mapping we forgot expires on
        // its own. Refusing to start over a port mapping is not a trade worth
        // making.
        return null;
      }
    },
    set(record) {
      db.prepare(
        'INSERT INTO port_mapping (id, data) VALUES (?, ?) '
        + 'ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      ).run(ROW_ID, JSON.stringify(record));
    },
    clear() {
      db.prepare('DELETE FROM port_mapping WHERE id = ?').run(ROW_ID);
    },
  };
};
