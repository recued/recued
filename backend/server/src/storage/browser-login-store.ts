/** D-335 slice Z — the logins the owner chose to remember for browser steps: a secret by the origin
 *  it is typed on and the field it goes in, never anywhere else.
 *
 *  Sealed under the server's vault key (AES-GCM), with the origin and the field as the authenticated
 *  data, so a sealed value copied onto another row does not open. Saved only while a key is at
 *  hand: with none (a server not yet unlocked), a step still types what the owner gives, and nothing
 *  is remembered. Each key copy is wiped once used. */

import type Database from 'better-sqlite3';
import { decodeCiphertext, decrypt, encodeCiphertext, encrypt } from '@recued/crypto';
import { browserPassHostOf, type BrowserActSecret, type BrowserLoginRow } from '@recued/contracts';

export interface BrowserLoginStore {
  /** The remembered secret for this field on this origin, or undefined: none, or no key to open it. */
  get(origin: string, field: string): Promise<string | undefined>;
  /** Remember a secret, replacing one kept for the same field. False when no key is at hand to seal
   *  it with: nothing is kept then. */
  save(input: {
    readonly origin: string;
    readonly field: string;
    readonly label: string;
    readonly kind: BrowserActSecret;
    readonly value: string;
    readonly now: number;
  }): Promise<boolean>;
  /** Note that a remembered login was typed. */
  used(origin: string, field: string, now: number): void;
  /** The remembered logins, newest first, never the secrets. */
  list(): BrowserLoginRow[];
  /** Forget one. False when none was remembered for it. */
  forget(origin: string, field: string): boolean;
}

interface LoginRow {
  origin: string;
  field: string;
  label: string;
  kind: string;
  sealed: string;
  saved_at: number;
  used_at: number | null;
}

const aad = (origin: string, field: string): Uint8Array =>
  new TextEncoder().encode(`recued/v1/browser-login/${origin}/${field}`);

export const ensureBrowserLoginSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_logins (
      origin TEXT NOT NULL,
      field TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      sealed TEXT NOT NULL,
      saved_at INTEGER NOT NULL,
      used_at INTEGER,
      PRIMARY KEY (origin, field)
    );
  `);
};

export const createBrowserLoginStore = (
  db: Database.Database,
  options: {
    /** A caller-owned copy of the sealing key, or null while the server is locked. */
    readonly key?: () => Uint8Array | null;
  } = {},
): BrowserLoginStore => {
  ensureBrowserLoginSchema(db);
  const one = db.prepare('SELECT * FROM browser_logins WHERE origin = ? AND field = ?');
  const upsert = db.prepare(`INSERT INTO browser_logins (origin, field, label, kind, sealed, saved_at, used_at)
    VALUES (@origin, @field, @label, @kind, @sealed, @saved_at, NULL)
    ON CONFLICT(origin, field) DO UPDATE SET label = excluded.label, kind = excluded.kind, sealed = excluded.sealed,
      saved_at = excluded.saved_at, used_at = NULL`);
  const touch = db.prepare('UPDATE browser_logins SET used_at = ? WHERE origin = ? AND field = ?');
  const all = db.prepare('SELECT * FROM browser_logins ORDER BY saved_at DESC, origin, field');
  const remove = db.prepare('DELETE FROM browser_logins WHERE origin = ? AND field = ?');
  /** The key for one operation, wiped once it is over. */
  const withKey = async <T>(run: (key: Uint8Array) => Promise<T>): Promise<T | undefined> => {
    const key = options.key?.() ?? null;
    if (key === null) return undefined;
    try {
      return await run(key);
    } finally {
      key.fill(0);
    }
  };
  return {
    async get(origin, field) {
      const row = one.get(origin, field) as LoginRow | undefined;
      if (row === undefined) return undefined;
      try {
        return await withKey(async (key) =>
          new TextDecoder().decode(await decrypt(key, decodeCiphertext(row.sealed), aad(origin, field))));
      } catch {
        // A row that does not open (a key changed by a restore from another server) is as good as none.
        return undefined;
      }
    },
    async save(input) {
      const sealed = await withKey(async (key) =>
        encodeCiphertext(await encrypt(key, new TextEncoder().encode(input.value), aad(input.origin, input.field))));
      if (sealed === undefined) return false;
      upsert.run({ origin: input.origin, field: input.field, label: input.label, kind: input.kind, sealed, saved_at: input.now });
      return true;
    },
    used(origin, field, now) {
      touch.run(now, origin, field);
    },
    list() {
      return (all.all() as LoginRow[]).map((row) => ({
        origin: row.origin,
        site: browserPassHostOf(row.origin),
        field: row.field,
        label: row.label,
        kind: row.kind as BrowserActSecret,
        saved_at: row.saved_at,
        ...(row.used_at !== null ? { used_at: row.used_at } : {}),
      }));
    },
    forget(origin, field) {
      return remove.run(origin, field).changes > 0;
    },
  };
};
