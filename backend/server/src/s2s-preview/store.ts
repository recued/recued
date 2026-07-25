/** D-145 PB12 — `S2SPreviewStore` SQLite-backed implementation.
 *
 *  Persists `RedactedPacket` envelopes built via the substrate
 *  `buildRedactedPacket` (`packages/contracts/src/redacted-packets.ts`).
 *  Token-keyed read; expiry filter at consume time; pruner sweeps
 *  expired rows on a periodic cadence.
 *
 *  Per-pair only — no cross-cloud sync (D-097 / D-168). The peer-MCP
 *  consumer (D-145 ships) and the D-149 reception consumer
 *  (downstream) both read this store; cross-server state survives
 *  via the access_token the publisher hands to the consumer.
 *
 *  Spec: D-145 § B.13.3 + § B.13.4. */

import type Database from 'better-sqlite3';
import {
  REDACTED_PACKET_KIND_SET,
  type RedactedPacket,
  type RedactedPacketKind,
} from '@recued/contracts';

/** Server-internal table name. Per-pair only. */
export const S2S_PREVIEW_TOKENS_TABLE = 's2s_preview_tokens';

/** Idempotent schema install — safe to call on every boot. */
export const ensureS2SPreviewSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${S2S_PREVIEW_TOKENS_TABLE} (
      access_token       TEXT PRIMARY KEY,
      packet_kind        TEXT NOT NULL,
      payload_blob       TEXT NOT NULL,
      fields_visible_blob TEXT NOT NULL,
      created_at         INTEGER NOT NULL,
      expires_at         INTEGER NOT NULL,
      audit_target_id    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_s2s_preview_expires_at
      ON ${S2S_PREVIEW_TOKENS_TABLE} (expires_at);
    CREATE INDEX IF NOT EXISTS idx_s2s_preview_kind
      ON ${S2S_PREVIEW_TOKENS_TABLE} (packet_kind);
  `);
};

interface RawRow {
  access_token: string;
  packet_kind: string;
  payload_blob: string;
  fields_visible_blob: string;
  created_at: number;
  expires_at: number;
  audit_target_id: string | null;
}

const rowToPacket = (raw: RawRow): RedactedPacket => {
  if (!REDACTED_PACKET_KIND_SET.has(raw.packet_kind as RedactedPacketKind)) {
    throw new Error(
      `s2s_preview_tokens: persisted packet_kind '${raw.packet_kind}' is not in REDACTED_PACKET_KINDS (token=${raw.access_token.slice(0, 8)}…)`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.payload_blob);
  } catch (e) {
    throw new Error(
      `s2s_preview_tokens: failed to parse payload_blob for token ${raw.access_token.slice(0, 8)}…: ${(e as Error).message}`,
    );
  }
  let fields_visible: ReadonlyArray<string>;
  try {
    fields_visible = JSON.parse(raw.fields_visible_blob);
    if (!Array.isArray(fields_visible) || !fields_visible.every((f) => typeof f === 'string')) {
      throw new Error('fields_visible_blob is not a string array');
    }
  } catch (e) {
    throw new Error(
      `s2s_preview_tokens: failed to parse fields_visible_blob for token ${raw.access_token.slice(0, 8)}…: ${(e as Error).message}`,
    );
  }
  return {
    packet_kind: raw.packet_kind as RedactedPacketKind,
    fields_visible,
    payload: payload as RedactedPacket['payload'],
    expires_at: raw.expires_at,
    created_at: raw.created_at,
    access_token: raw.access_token,
    ...(raw.audit_target_id !== null ? { audit_target_id: raw.audit_target_id } : {}),
  };
};

export interface S2SPreviewStore {
  /** Insert the persisted envelope. Throws on duplicate
   *  `access_token` — callers should generate fresh tokens or
   *  collision-recover. */
  put(packet: RedactedPacket): void;
  /** Look up by `access_token`. Returns `null` when not found OR
   *  when the row exists but has expired (`now ≥ expires_at`).
   *  Substrate-callers can disambiguate via `getRaw` when they
   *  need to return `'token_expired'` vs `'token_unknown'`. */
  get(access_token: string, now: number): RedactedPacket | null;
  /** Same as `get` but ignores expiry — returns the row even when
   *  expired. Used by the consumer rpc handler so the consumer can
   *  emit `token_expired` distinctly from `token_unknown`. */
  getRaw(access_token: string): RedactedPacket | null;
  /** Delete one row by access_token. Returns true iff a row was
   *  removed. */
  delete(access_token: string): boolean;
  /** Prune expired rows. Returns the number of rows removed.
   *  Substrate caller wires this into the housekeeping cadence (or
   *  a simpler periodic timer for v1). */
  pruneExpired(now: number): number;
  /** List every row (test + diagnostics surface). Returns rows
   *  ordered `created_at DESC`. */
  list(): RedactedPacket[];
}

/** Distinguishable error raised on duplicate-token insert. The
 *  builder is responsible for generating collision-resistant tokens
 *  (CSPRNG-backed); this surfaces the rare collision so the caller
 *  can retry with a fresh token. */
export class S2SPreviewTokenCollisionError extends Error {
  readonly code = 'S2S_PREVIEW_TOKEN_COLLISION' as const;
  constructor(public readonly access_token: string) {
    super(
      `s2s_preview: access_token '${access_token.slice(0, 8)}…' already in use; caller must generate a fresh token`,
    );
    this.name = 'S2SPreviewTokenCollisionError';
  }
}

export const createS2SPreviewStore = (db: Database.Database): S2SPreviewStore => {
  ensureS2SPreviewSchema(db);

  const insertStmt = db.prepare(
    `INSERT INTO ${S2S_PREVIEW_TOKENS_TABLE}
       (access_token, packet_kind, payload_blob, fields_visible_blob,
        created_at, expires_at, audit_target_id)
     VALUES
       (@access_token, @packet_kind, @payload_blob, @fields_visible_blob,
        @created_at, @expires_at, @audit_target_id)`,
  );

  const getStmt = db.prepare(
    `SELECT access_token, packet_kind, payload_blob, fields_visible_blob,
            created_at, expires_at, audit_target_id
       FROM ${S2S_PREVIEW_TOKENS_TABLE}
      WHERE access_token = @access_token`,
  );

  const deleteStmt = db.prepare(
    `DELETE FROM ${S2S_PREVIEW_TOKENS_TABLE} WHERE access_token = @access_token`,
  );

  const pruneStmt = db.prepare(
    `DELETE FROM ${S2S_PREVIEW_TOKENS_TABLE} WHERE expires_at <= @now`,
  );

  const listStmt = db.prepare(
    `SELECT access_token, packet_kind, payload_blob, fields_visible_blob,
            created_at, expires_at, audit_target_id
       FROM ${S2S_PREVIEW_TOKENS_TABLE}
      ORDER BY created_at DESC`,
  );

  return {
    put(packet) {
      try {
        insertStmt.run({
          access_token: packet.access_token,
          packet_kind: packet.packet_kind,
          payload_blob: JSON.stringify(packet.payload),
          fields_visible_blob: JSON.stringify(packet.fields_visible),
          created_at: packet.created_at,
          expires_at: packet.expires_at,
          audit_target_id: packet.audit_target_id ?? null,
        });
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
          throw new S2SPreviewTokenCollisionError(packet.access_token);
        }
        throw e;
      }
    },
    get(access_token, now) {
      const row = getStmt.get({ access_token }) as RawRow | undefined;
      if (!row) return null;
      if (Number.isFinite(now) && now >= row.expires_at) return null;
      return rowToPacket(row);
    },
    getRaw(access_token) {
      const row = getStmt.get({ access_token }) as RawRow | undefined;
      if (!row) return null;
      return rowToPacket(row);
    },
    delete(access_token) {
      const res = deleteStmt.run({ access_token });
      return res.changes > 0;
    },
    pruneExpired(now) {
      const res = pruneStmt.run({ now });
      return res.changes;
    },
    list() {
      const rows = listStmt.all() as RawRow[];
      return rows.map(rowToPacket);
    },
  };
};
