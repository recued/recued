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

/** Shape gate for a row read back from disk.
 *
 *  ⛔ WITHOUT THIS, `get()` WAS A CAST, NOT A READ. `JSON.parse(row.data) as
 *  PortMappingRecord` makes the declared return type a promise the store does
 *  not keep: `{}`, `[]`, `123` and `"str"` all parse, and all were handed to
 *  `planPortMapping` as records. A `{}` whose gateway happens to match the
 *  desired one takes the `params_changed` branch with `releaseReachable: true`,
 *  so `undefined` ports reach `actuator.unmap()` and go on into a NAT-PMP
 *  packet or an IGD SOAP body.
 *
 *  ⚠ A FAILED SHAPE IS TREATED EXACTLY LIKE A FAILED PARSE, which is the policy
 *  this module already states for a corrupt row: unreadable reads as ABSENT, we
 *  map again, and the mapping we forgot expires on its own lease. A record we
 *  cannot trust is worth precisely as much as no record — and the whole reason
 *  this table exists is that only what we wrote down tells us a mapping is ours
 *  to take away. Half a record cannot say that.
 *
 *  ⚠ `gateway` is the one optional field; absent is meaningful (it is how a
 *  record predating a known gateway reads), so it is checked only when present. */
const isPortMappingRecord = (value: unknown): value is PortMappingRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (r.gateway !== undefined && typeof r.gateway !== 'string') return false;
  if (r.protocol !== 'tcp' && r.protocol !== 'udp') return false;
  if (typeof r.internalIp !== 'string') return false;
  for (const key of ['internalPort', 'externalPort', 'createdAt', 'lifetimeSeconds'] as const) {
    const n = r[key];
    // ⛔ `Number.isFinite`, not `typeof === 'number'`: NaN and Infinity are
    // numbers, and a NaN port encodes into a protocol packet as silently as a
    // real one. JSON cannot carry them, but a hand-edited row can say `1e999`.
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  }
  return true;
};

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
        const parsed: unknown = JSON.parse(row.data);
        return isPortMappingRecord(parsed) ? parsed : null;
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
