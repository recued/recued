/** D-336 slice Q — what each write made, by where its call came from, so a save can be linked to
 *  the contact the same place added under the same name (`createClaimLinker`).
 *
 *  A scope is a chat's turn (`turn:<session>:<turn>`, the owner's rule "the same turn, the same
 *  name") or an AI app (`app:<contract_id>`: an app's calls carry no turn, and the owner ruled
 *  "Same app, any time", 2026-11-01). A row is a contact a `contact.write` added, with its name
 *  as added, or a note a `memory.write` saved. Rows are kept: a contact or a note gone since is
 *  simply not found when it is looked for.
 *
 *  Plain columns, as the contact table's own names are: the database is encrypted at rest. */

import type Database from 'better-sqlite3';
import type { ChatPlanMade } from '@recued/contracts';

const TABLE = 'claim_link_made';

export const ensureClaimLinkLedgerSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      scope      TEXT NOT NULL,
      kind       TEXT NOT NULL,
      record_id  TEXT NOT NULL,
      name       TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (scope, kind, record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_claim_link_made_name ON ${TABLE} (scope, kind, name);
  `);
};

export interface ClaimLinkLedger {
  /** Record what a write made in a scope; the same record twice is one. `name` is the contact's
   *  name as the add gave it, already folded as a claim's end holds a name. */
  record(scope: string, made: ChatPlanMade, name: string | undefined, now: number): void;
  /** The `target_id`s of the contacts the scope added under this name. */
  contactsNamed(scope: string, name: string): string[];
  /** Whether the scope saved this note. */
  saved(scope: string, memory_id: string): boolean;
}

export const createClaimLinkLedger = (db: Database.Database): ClaimLinkLedger => {
  ensureClaimLinkLedgerSchema(db);
  const insert = db.prepare(
    `INSERT INTO ${TABLE} (scope, kind, record_id, name, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, kind, record_id) DO NOTHING`,
  );
  const named = db.prepare(`SELECT record_id FROM ${TABLE} WHERE scope = ? AND kind = 'contact' AND name = ?`);
  const savedStmt = db.prepare(`SELECT 1 FROM ${TABLE} WHERE scope = ? AND kind = 'memory' AND record_id = ?`);
  return {
    record(scope, made, name, now) {
      if (made.kind === 'contact') insert.run(scope, 'contact', made.target_id, name ?? null, now);
      else insert.run(scope, 'memory', made.memory_id, null, now);
    },
    contactsNamed(scope, name) {
      return (named.all(scope, name) as Array<{ record_id: string }>).map((row) => row.record_id);
    },
    saved(scope, memory_id) {
      return savedStmt.get(scope, memory_id) !== undefined;
    },
  };
};
