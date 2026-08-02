/** Durable, vendor-neutral cursor/session state for outbound-established
 * messenger ingress. One table serves Telegram polling and Discord Gateway;
 * Slack Socket Mode has no resumable cursor but shares the same lifecycle. */

import type Database from 'better-sqlite3';
import type { MessengerIngressMode } from '@recued/contracts';

const TABLE = 'messenger_ingress_state';
const MAX_STATE_JSON_BYTES = 32 * 1024;

export interface MessengerIngressStateRow {
  vendor: string;
  connection_name: string;
  mode: MessengerIngressMode;
  /** SHA-256 of the persisted encrypted auth envelope. Cursor/session state
   *  must never cross a credential replacement. */
  credential_fingerprint: string;
  state: Readonly<Record<string, unknown>>;
  updated_at: number;
}

export interface MessengerIngressStateStore {
  get(vendor: string, connectionName: string): MessengerIngressStateRow | null;
  put(input: Omit<MessengerIngressStateRow, 'updated_at'> & { updated_at?: number }): void;
  delete(vendor: string, connectionName: string): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const createMessengerIngressStateStore = (
  db: Database.Database,
  now: () => number = Date.now,
): MessengerIngressStateStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      vendor         TEXT NOT NULL,
      connection_name TEXT NOT NULL,
      mode           TEXT NOT NULL,
      credential_fingerprint TEXT NOT NULL,
      state_json     TEXT NOT NULL,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (vendor, connection_name)
    );
  `);

  const getStmt = db.prepare(
    `SELECT vendor, connection_name, mode, credential_fingerprint, state_json, updated_at
       FROM ${TABLE}
      WHERE vendor = ? AND connection_name = ?`,
  );
  const putStmt = db.prepare(`
    INSERT INTO ${TABLE} (
      vendor, connection_name, mode, credential_fingerprint, state_json, updated_at
    )
    VALUES (
      @vendor, @connection_name, @mode, @credential_fingerprint, @state_json, @updated_at
    )
    ON CONFLICT(vendor, connection_name) DO UPDATE SET
      mode = excluded.mode,
      credential_fingerprint = excluded.credential_fingerprint,
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `);
  const deleteStmt = db.prepare(
    `DELETE FROM ${TABLE} WHERE vendor = ? AND connection_name = ?`,
  );

  return {
    get(vendor, connectionName) {
      const row = getStmt.get(vendor, connectionName) as {
        vendor: string;
        connection_name: string;
        mode: MessengerIngressMode;
        credential_fingerprint: string;
        state_json: string;
        updated_at: number;
      } | undefined;
      if (row === undefined) return null;
      try {
        const state = JSON.parse(row.state_json) as unknown;
        if (!isRecord(state)) return null;
        return {
          vendor: row.vendor,
          connection_name: row.connection_name,
          mode: row.mode,
          credential_fingerprint: row.credential_fingerprint,
          state,
          updated_at: row.updated_at,
        };
      } catch {
        return null;
      }
    },

    put(input) {
      const state_json = JSON.stringify(input.state);
      if (Buffer.byteLength(state_json, 'utf8') > MAX_STATE_JSON_BYTES) {
        throw new Error('messenger ingress state exceeds 32 KiB');
      }
      putStmt.run({
        vendor: input.vendor,
        connection_name: input.connection_name,
        mode: input.mode,
        credential_fingerprint: input.credential_fingerprint,
        state_json,
        updated_at: input.updated_at ?? now(),
      });
    },

    delete(vendor, connectionName) {
      deleteStmt.run(vendor, connectionName);
    },
  };
};
