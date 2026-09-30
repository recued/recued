/** Encrypted owner workbooks. Revision checks also guard writes after an AI call. */
import type Database from 'better-sqlite3';
import { RpcError, type MailWork, type MailWorkCursor } from '@recued/contracts';
import type { PreapprovalCodec } from './preapproval-codec.js';

export interface StoredMailWork {
  work: MailWork;
  /** Kept out of the UI: hashes allow changed-message markers without retaining mail bodies. */
  reviewed_sources: Record<string, string>;
  creation_key: string;
}
interface Row { id: string; revision: number; ciphertext: string; updated_at: number }
export const mailWorkConflict = (): never => {
  throw new RpcError('conflict', 'This work or its mail changed. Reload it before trying again.', 409);
};
/** The shared codec's locked error names pre-approval; name the feature that is waiting instead. */
const lockedForWork = (error: unknown): never => {
  throw error instanceof RpcError && error.code === 'server_locked'
    ? new RpcError('server_locked', 'Unlock Recued to use followed work.', 423) : error;
};

export const createMailWorkStore = (db: Database.Database, codec: PreapprovalCodec) => {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_work (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS mail_work_updated ON mail_work(updated_at DESC, id);`);
  const assertUnlocked = (): void => { try { codec.assertUnlocked(); } catch (error) { lockedForWork(error); } };
  const row = (id: string): Row | undefined => db.prepare('SELECT * FROM mail_work WHERE id=?').get(id) as Row | undefined;
  const decode = async (value: Row): Promise<StoredMailWork> => {
    const result = await codec.open(value.ciphertext).catch(lockedForWork) as StoredMailWork | null;
    // The envelope carries no associated data, so bind the plaintext to its row:
    // a ciphertext copied from another row or replayed from an older revision
    // must not be read as this work, or let a write through this ID rewrite another.
    if (result?.work?.id !== value.id || result.work.revision !== value.revision) {
      throw new RpcError('storage_corrupt', 'This followed work could not be read because its saved copy is damaged.', 500);
    }
    // A later writer owns the row, even if this decryption began first.
    if (row(value.id)?.revision !== value.revision) mailWorkConflict();
    return result;
  };
  return {
    assertUnlocked,
    /** Guard a lookup followed by an asynchronous encrypted insert. */
    version: (): string => JSON.stringify(db.prepare('SELECT id,revision FROM mail_work ORDER BY id').all()),
    async get(id: string): Promise<StoredMailWork | null> {
      assertUnlocked();
      const value = row(id);
      return value ? decode(value) : null;
    },
    async list(before?: MailWorkCursor): Promise<{ rows: StoredMailWork[]; next_cursor: MailWorkCursor | null }> {
      assertUnlocked();
      const rows = (before
        ? db.prepare('SELECT * FROM mail_work WHERE updated_at < ? OR (updated_at = ? AND id > ?) ORDER BY updated_at DESC, id LIMIT 31')
          .all(before.updated_at, before.updated_at, before.id)
        : db.prepare('SELECT * FROM mail_work ORDER BY updated_at DESC, id LIMIT 31').all()) as Row[];
      const page = rows.slice(0, 30);
      const last = page.at(-1);
      return { rows: await Promise.all(page.map(decode)), next_cursor: rows.length > 30 && last ? { updated_at: last.updated_at, id: last.id } : null };
    },
    async put(value: StoredMailWork, expected: number | null, assertCurrent: () => void = () => {}): Promise<void> {
      const ciphertext = await codec.seal(value).catch(lockedForWork);
      db.transaction(() => {
        assertUnlocked();
        assertCurrent();
        const current = row(value.work.id);
        if (expected === null ? current !== undefined : current?.revision !== expected) mailWorkConflict();
        if (value.work.revision !== (expected ?? 0) + 1) mailWorkConflict();
        db.prepare('INSERT INTO mail_work(id,revision,ciphertext,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at')
          .run(value.work.id, value.work.revision, ciphertext, value.work.updated_at);
      }).immediate();
    },
    /** Removes the workbook with its reviewed-source hashes. A pending edit or
     * review expects a stored revision, so it cannot write the work back. */
    delete(id: string, expected: number): void {
      db.transaction(() => {
        assertUnlocked();
        if (row(id)?.revision !== expected) mailWorkConflict();
        db.prepare('DELETE FROM mail_work WHERE id=?').run(id);
      }).immediate();
    },
  };
};
export type MailWorkStore = ReturnType<typeof createMailWorkStore>;
