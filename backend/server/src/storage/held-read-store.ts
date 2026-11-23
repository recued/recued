/** D-339 slice 12a (D-339 §5.6) — who the owner lets make a read held at `always`
 *  without asking: one row per caller and action, as the owner set it. Slice 12a keeps the owner's
 *  chats' "Allow" for a Body's numbers (`body-numbers.ts`); a caller with no row asks.
 *
 *  ⛔ NOT THE OWNER'S OVERRIDE OF THE HOLD (`contract.override`), which is one row for every caller,
 *  AI apps included. A row here answers for its caller alone, so an app keeps asking whatever the
 *  owner lets their own chats do.
 *
 *  Who is the caller as write rules name it (`writeRulePrincipalOf`): the owner's chats, or one AI app
 *  by its contract. */
import type Database from 'better-sqlite3';
import type { WriteRulePrincipal } from '@recued/contracts';

export interface HeldReadStore {
  /** Does the owner let this caller make this read without asking? */
  allows(principal: WriteRulePrincipal, operation_id: string): boolean;
  setAllows(principal: WriteRulePrincipal, operation_id: string, allow: boolean, now: number): void;
}

/** The caller as a row's key: `owner_chat`, or `ai_app:<contract_id>`. */
export const heldReadPrincipalKey = (principal: WriteRulePrincipal): string =>
  principal.kind === 'owner_chat' ? 'owner_chat' : `ai_app:${principal.contract_id}`;

export const ensureHeldReadSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS held_read_allows (
      principal     TEXT NOT NULL,
      operation_id  TEXT NOT NULL,
      allow         INTEGER NOT NULL CHECK (allow IN (0, 1)),
      set_at        INTEGER NOT NULL,
      PRIMARY KEY (principal, operation_id)
    );
  `);
};

export const createHeldReadStore = (db: Database.Database): HeldReadStore => {
  ensureHeldReadSchema(db);
  const read = db.prepare<[string, string]>('SELECT allow FROM held_read_allows WHERE principal = ? AND operation_id = ?');
  const write = db.prepare(`INSERT INTO held_read_allows (principal, operation_id, allow, set_at)
    VALUES (@principal, @operation_id, @allow, @set_at)
    ON CONFLICT (principal, operation_id) DO UPDATE SET allow = excluded.allow, set_at = excluded.set_at`);
  return {
    allows: (principal, operation_id) =>
      (read.get(heldReadPrincipalKey(principal), operation_id) as { allow: number } | undefined)?.allow === 1,
    setAllows: (principal, operation_id, allow, now) => {
      write.run({ principal: heldReadPrincipalKey(principal), operation_id, allow: allow ? 1 : 0, set_at: now });
    },
  };
};
