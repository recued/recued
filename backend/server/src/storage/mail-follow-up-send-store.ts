import type Database from 'better-sqlite3';
import { RpcError, type MailDraftContent, type MailFollowUpSendIntent, type ServerExecuteResponse, type MailFollowUpTaskContinuation } from '@recued/contracts';
import type { MailSendResult } from '../collections/mail/mail-collection.js';
import type { PreapprovalCodec } from './preapproval-codec.js';

export interface StoredFollowUpSend {
  intent: MailFollowUpSendIntent; content: MailDraftContent; request_hash: string;
  owner_token_id: string; incarnation: string; account: string;
  dispatch_started?: boolean; receipt?: MailSendResult; response?: ServerExecuteResponse;
  continue_task?: MailFollowUpTaskContinuation; task_continuation_blocked?: boolean;
}
const conflict = (): never => { throw new RpcError('conflict', 'This pending reply watch changed. Refresh it before continuing.', 409); };
interface Row { id: string; revision: number; state: string; run_id: string | null; ciphertext: string }
export const createMailFollowUpSendStore = (db: Database.Database, codec: PreapprovalCodec) => {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_follow_up_sends (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, run_id TEXT,
    ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS mail_follow_up_send_run ON mail_follow_up_sends(run_id) WHERE run_id IS NOT NULL;`);
  const row = (id: string) => db.prepare('SELECT * FROM mail_follow_up_sends WHERE id=?').get(id) as Row | undefined;
  const get = async (id: string): Promise<StoredFollowUpSend | null> => {
    codec.assertUnlocked(); const r = row(id); if (!r) return null;
    const value = await codec.open(r.ciphertext) as StoredFollowUpSend; codec.assertUnlocked();
    if (value?.intent?.id !== r.id || value.intent.revision !== r.revision || value.intent.state !== r.state || (value.intent.run_id ?? null) !== r.run_id)
      throw new RpcError('storage_corrupt', 'This pending reply watch could not be read.', 500);
    if (row(id)?.revision !== r.revision) conflict(); return value;
  };
  /** A prepared write may join the watch store's transaction on this same DB. */
  const prepare = async (value: StoredFollowUpSend, expected: number | null, current: () => void = () => {}, replaceUndispatchedRun?: string) => {
    const ciphertext = await codec.seal(value);
    return () => {
      codec.assertUnlocked(); current(); const prior = row(value.intent.id);
      if ((expected === null ? !!prior : prior?.revision !== expected) || value.intent.revision !== (expected ?? 0) + 1
        || prior?.run_id && value.intent.run_id !== prior.run_id && replaceUndispatchedRun !== prior.run_id) conflict();
      if (!prior && (db.prepare("SELECT count(*) AS n FROM mail_follow_up_sends WHERE state NOT IN ('armed','cancelled')").get() as { n: number }).n >= 64)
        throw new RpcError('limit_exceeded', 'Cancel a pending reply watch before starting another.', 409);
      const other = value.intent.run_id && db.prepare('SELECT id FROM mail_follow_up_sends WHERE run_id=? AND id<>?').get(value.intent.run_id, value.intent.id);
      if (other) throw new RpcError('conflict', 'This send already has a reply watch request. Open Reply watches to review it.', 409);
      db.prepare(`INSERT INTO mail_follow_up_sends(id,revision,state,run_id,ciphertext,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state,run_id=excluded.run_id,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`)
        .run(value.intent.id, value.intent.revision, value.intent.state, value.intent.run_id ?? null, ciphertext, value.intent.updated_at);
    };
  };
  return {
    get, prepare,
    isCurrent(id: string, revision: number) { codec.assertUnlocked(); return row(id)?.revision === revision; },
    async byRun(runId: string) { codec.assertUnlocked(); const r = db.prepare('SELECT id FROM mail_follow_up_sends WHERE run_id=?').get(runId) as { id: string } | undefined; return r ? get(r.id) : null; },
    activeIds(): string[] { codec.assertUnlocked(); return (db.prepare("SELECT id FROM mail_follow_up_sends WHERE state NOT IN ('armed','cancelled') ORDER BY updated_at DESC,id LIMIT 64").all() as { id: string }[]).map(r => r.id); },
    async put(value: StoredFollowUpSend, expected: number | null, current: () => void = () => {}, replaceUndispatchedRun?: string) {
      const write = await prepare(value, expected, current, replaceUndispatchedRun); db.transaction(write).immediate();
    },
  };
};
export type MailFollowUpSendStore = ReturnType<typeof createMailFollowUpSendStore>;
