/** D-405 slice 3 — the hints under chat answers the owner said "Not now" to (ruling P3), each until it
 *  comes back (`CHAT_HINT_NOT_NOW_DAYS`). One row per hint key (`chatHintKeyOfFix` / `chatHintKeyOfOffer`),
 *  with what the owner saw, so a list of hidden hints can name it. The shape follows the Today view's
 *  dismissals (`situation-dismissal-store.ts`): a "Not now" that lapses is simply not read any more.
 *
 *  The owner's own setting, on this server only: it shapes what Recued offers, never what an AI may read. */
import type Database from 'better-sqlite3';
import type { ChatHintNotNow } from '@recued/contracts';

export const createChatHintStore = (db: Database.Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_hint_not_now (
    key TEXT PRIMARY KEY, label TEXT NOT NULL, until INTEGER NOT NULL, at INTEGER NOT NULL)`);
  const upsert = db.prepare(`INSERT INTO chat_hint_not_now(key,label,until,at) VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET label=excluded.label, until=excluded.until, at=excluded.at`);
  const remove = db.prepare('DELETE FROM chat_hint_not_now WHERE key=?');
  const live = db.prepare('SELECT key, label, until FROM chat_hint_not_now WHERE until>? ORDER BY at DESC, key LIMIT ?');
  const one = db.prepare('SELECT 1 FROM chat_hint_not_now WHERE key=? AND until>?');
  return {
    /** Set a hint aside until `until`; again, the later "Not now" holds. */
    notNow(row: ChatHintNotNow & { readonly at: number }): void {
      upsert.run(row.key, row.label, row.until, row.at);
    },
    /** Bring a hint back now. True when it was set aside. */
    restore(key: string): boolean {
      return remove.run(key).changes > 0;
    },
    /** The hints set aside at `at`, the latest first; one that has come back is not among them. */
    list(at: number, limit: number): ChatHintNotNow[] {
      return live.all(at, limit) as ChatHintNotNow[];
    },
    /** Whether this hint is set aside at `at`. */
    hides(key: string, at: number): boolean {
      return one.get(key, at) !== undefined;
    },
  };
};
export type ChatHintStore = ReturnType<typeof createChatHintStore>;
