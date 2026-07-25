/** D-149 P12 § A.20.5 — `reception_ip_block_list` store.
 *
 *  The Abuse Inbox's "Ban this IP" action appends a `(endpoint_id,
 *  source_ip_hash)` tuple to the per-server block list; the
 *  path-listener checks the list before the per-IP rate-limit consume
 *  (so a banned visitor is rejected before any further substrate work).
 *
 *  Keying discipline (§ Must Hold I-9): the block list is keyed on the
 *  ENDPOINT-SCOPED HKDF source-IP hash — exactly the value the
 *  operational access log stores + an `AbuseInboxRow` surfaces. There
 *  is deliberately NO server-wide raw-IP ban surface: a ban is
 *  intrinsically per-endpoint, so banning a visitor on endpoint A does
 *  not reveal (or block) the same visitor on endpoint B. That is the
 *  same no-cross-endpoint-correlation invariant the source-IP hashing
 *  enforces everywhere else in the substrate.
 *
 *  Server-internal table; no cross-cloud sync (D-097 / D-168 —
 *  reception substrate is per-pair only per § Must Hold I-15).
 *
 *  Spec: D-149 § A.20.5 + § A.16 + § Must Hold I-9. */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { abuseInboxBlockKey } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Row shape (mirrors reception-store CREATE TABLE)
// ────────────────────────────────────────────────────────────────

interface IpBlockRow {
  block_id: string;
  endpoint_id: string;
  source_ip_hash: string;
  blocked_at: number;
  blocked_by_client_id: string;
  reason: string | null;
}

// ────────────────────────────────────────────────────────────────
// Public projection + inputs
// ────────────────────────────────────────────────────────────────

export interface IpBlockEntry {
  readonly endpoint_id: string;
  readonly source_ip_hash: string;
  readonly blocked_at: number;
  readonly blocked_by_client_id: string;
  readonly reason: string | null;
}

export interface IpBlockCreateInput {
  readonly endpoint_id: string;
  /** Endpoint-scoped HKDF source-IP hash (the value the operational
   *  access log persists + an `AbuseInboxRow` surfaces). */
  readonly source_ip_hash: string;
  readonly blocked_at: number;
  readonly blocked_by_client_id: string;
  readonly reason: string | null;
}

export interface ReceptionIpBlockStore {
  /** Append a `(endpoint_id, source_ip_hash)` ban. Idempotent —
   *  returns `'already_blocked'` when the pair is already on the list
   *  (the UNIQUE constraint dedupes; `INSERT OR IGNORE` makes the
   *  re-ban a no-op). */
  block(input: IpBlockCreateInput): 'created' | 'already_blocked';

  /** Lift a ban. Returns `'not_found'` when the pair was not on the
   *  list (idempotent unban). */
  unblock(input: { endpoint_id: string; source_ip_hash: string }): 'removed' | 'not_found';

  /** Hot-path membership test — called per visitor request by the
   *  path-listener. Single point-lookup on the UNIQUE composite index. */
  isBlocked(endpoint_id: string, source_ip_hash: string): boolean;

  /** List the block list, optionally filtered to one endpoint. Newest
   *  ban first. */
  list(filter?: { endpoint_id?: string }): ReadonlyArray<IpBlockEntry>;

  /** Build the `abuseInboxBlockKey`-encoded membership Set
   *  `buildAbuseInbox` consumes to annotate each cluster's `ip_blocked`
   *  flag. */
  listBlockedKeys(): ReadonlySet<string>;
}

// ────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────

const rowToEntry = (row: IpBlockRow): IpBlockEntry => ({
  endpoint_id: row.endpoint_id,
  source_ip_hash: row.source_ip_hash,
  blocked_at: row.blocked_at,
  blocked_by_client_id: row.blocked_by_client_id,
  reason: row.reason,
});

export const createReceptionIpBlockStore = (
  db: Database.Database,
): ReceptionIpBlockStore => {
  // `INSERT OR IGNORE` — the UNIQUE(endpoint_id, source_ip_hash)
  // constraint makes a re-ban a no-op (changes === 0). The block_id is
  // a substrate-internal opaque id; visitors never see it.
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO reception_ip_block_list (
      block_id, endpoint_id, source_ip_hash,
      blocked_at, blocked_by_client_id, reason
    ) VALUES (
      @block_id, @endpoint_id, @source_ip_hash,
      @blocked_at, @blocked_by_client_id, @reason
    )
  `);

  const deleteStmt = db.prepare(`
    DELETE FROM reception_ip_block_list
     WHERE endpoint_id = @endpoint_id AND source_ip_hash = @source_ip_hash
  `);

  const existsStmt = db.prepare(`
    SELECT 1 FROM reception_ip_block_list
     WHERE endpoint_id = @endpoint_id AND source_ip_hash = @source_ip_hash
     LIMIT 1
  `);

  const listAllStmt = db.prepare(
    `SELECT * FROM reception_ip_block_list ORDER BY blocked_at DESC`,
  );
  const listByEndpointStmt = db.prepare(
    `SELECT * FROM reception_ip_block_list WHERE endpoint_id = @endpoint_id ORDER BY blocked_at DESC`,
  );
  const listKeysStmt = db.prepare(
    `SELECT endpoint_id, source_ip_hash FROM reception_ip_block_list`,
  );

  return {
    block(input) {
      const result = insertStmt.run({
        block_id: randomUUID(),
        endpoint_id: input.endpoint_id,
        source_ip_hash: input.source_ip_hash,
        blocked_at: input.blocked_at,
        blocked_by_client_id: input.blocked_by_client_id,
        reason: input.reason,
      });
      return result.changes > 0 ? 'created' : 'already_blocked';
    },

    unblock(input) {
      const result = deleteStmt.run({
        endpoint_id: input.endpoint_id,
        source_ip_hash: input.source_ip_hash,
      });
      return result.changes > 0 ? 'removed' : 'not_found';
    },

    isBlocked(endpoint_id, source_ip_hash) {
      const row = existsStmt.get({ endpoint_id, source_ip_hash });
      return row !== undefined;
    },

    list(filter) {
      const rows =
        filter?.endpoint_id !== undefined
          ? (listByEndpointStmt.all({ endpoint_id: filter.endpoint_id }) as IpBlockRow[])
          : (listAllStmt.all() as IpBlockRow[]);
      return rows.map(rowToEntry);
    },

    listBlockedKeys() {
      const rows = listKeysStmt.all() as Array<{
        endpoint_id: string;
        source_ip_hash: string;
      }>;
      const keys = new Set<string>();
      for (const r of rows) {
        keys.add(abuseInboxBlockKey(r.endpoint_id, r.source_ip_hash));
      }
      return keys;
    },
  };
};
