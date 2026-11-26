import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, matchesMailFollowUp, readMailFollowUpTaskRef, type MailFollowUpTaskRef, type MailDraftContent, type MailFollowUp, type MailFollowUpCursor, type MailFollowUpList } from '@recued/contracts';
import type { PreapprovalCodec } from './preapproval-codec.js';

export interface StoredMailFollowUp {
  watch: MailFollowUp;
  thread_key: string;
  thread_id: string;
  seed_hash: string;
  creation_hash: string;
  mailbox_address: string;
  recipients: string[];
  draft_content: MailDraftContent;
  owner_token_id: string;
  reply_notification_owner_token_id?: string;
  replacement?: { request_id: string; failure_hash: string; content: MailDraftContent; draft_id?: string };
  reschedule?: { request_id: string; request_hash: string };
  task_link_request?: { request_id: string; request_hash: string };
  task_creations?: Array<{ request_id: string; request_hash: string; task_ref: MailFollowUpTaskRef }>;
}
export const followUpHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const taskKey = (ref: MailFollowUpTaskRef) => followUpHash([ref.id, ref.source_id, ref.source_record_id ?? null, ref.created_at]);
export const followUpConflict = (): never => {
  throw new RpcError('conflict', 'This reply watch changed. Check it again before continuing.', 409);
};
const active = "'waiting','needs_attention','draft_ready'";
interface Row {
  id: string; revision: number; thread_key: string; state: string;
  check_at: number; ciphertext: string; updated_at: number; schedule_version: number; notify_on_reply: number;
  task_key: string | null; task_link_version: number;
}

/** Scheduling metadata is indexable; email identity, recipients, subject,
 * draft content and the initiating credential remain encrypted. */
export const createMailFollowUpStore = (db: Database.Database, codec: PreapprovalCodec) => {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_follow_ups (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, thread_key TEXT NOT NULL,
    state TEXT NOT NULL, check_at INTEGER NOT NULL, ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS mail_follow_up_active_thread
    ON mail_follow_ups(thread_key) WHERE state IN (${active});
  CREATE INDEX IF NOT EXISTS mail_follow_up_updated ON mail_follow_ups(updated_at DESC,id);`);
  if (!(db.prepare('PRAGMA table_info(mail_follow_ups)').all() as { name: string }[]).some(column => column.name === 'schedule_version'))
    db.exec('ALTER TABLE mail_follow_ups ADD COLUMN schedule_version INTEGER NOT NULL DEFAULT 0');
  if (!(db.prepare('PRAGMA table_info(mail_follow_ups)').all() as { name: string }[]).some(column => column.name === 'notify_on_reply'))
    db.exec('ALTER TABLE mail_follow_ups ADD COLUMN notify_on_reply INTEGER NOT NULL DEFAULT 0 CHECK(notify_on_reply IN (0,1))');
  if (!(db.prepare('PRAGMA table_info(mail_follow_ups)').all() as { name: string }[]).some(column => column.name === 'task_key'))
    db.exec('ALTER TABLE mail_follow_ups ADD COLUMN task_key TEXT');
  if (!(db.prepare('PRAGMA table_info(mail_follow_ups)').all() as { name: string }[]).some(column => column.name === 'task_link_version'))
    db.exec('ALTER TABLE mail_follow_ups ADD COLUMN task_link_version INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS mail_follow_up_task ON mail_follow_ups(task_key) WHERE task_key IS NOT NULL');
  const row = (id: string) => db.prepare('SELECT * FROM mail_follow_ups WHERE id=?').get(id) as Row | undefined;
  const decode = async (r: Row): Promise<StoredMailFollowUp> => {
    codec.assertUnlocked();
    const value = await codec.open(r.ciphertext) as StoredMailFollowUp;
    if (value?.watch?.id !== r.id || value.watch.revision !== r.revision || value.watch.state !== r.state
      || value.watch.check_at !== r.check_at || value.watch.updated_at !== r.updated_at || value.thread_key !== r.thread_key
      || (value.watch.schedule_version ?? 0) !== r.schedule_version || Number(value.watch.notify_on_reply ?? false) !== r.notify_on_reply
      || (value.watch.task_link_version ?? 0) !== r.task_link_version
      || (value.watch.task_ref ? !readMailFollowUpTaskRef(value.watch.task_ref) || taskKey(value.watch.task_ref) !== r.task_key : r.task_key !== null)) {
      throw new RpcError('storage_corrupt', 'This reply watch could not be read.', 500);
    }
    if (row(r.id)?.revision !== r.revision) followUpConflict();
    return value;
  };
  const prepare = async (value: StoredMailFollowUp, expected: number | null) => {
    const linkedTaskKey = value.watch.task_ref ? taskKey(value.watch.task_ref) : null;
    const ciphertext = await codec.seal(value);
    return (writeRelated?: () => void) => {
      codec.assertUnlocked();
      const prior = row(value.watch.id);
      if (linkedTaskKey && db.prepare('SELECT id FROM mail_follow_ups WHERE task_key=? AND id<>?').get(linkedTaskKey, value.watch.id))
        throw new RpcError('conflict', 'This task already has a reply watch. Unlink it from that watch before choosing another.', 409);
      if ((expected === null ? !!prior : prior?.revision !== expected)
        || value.watch.revision !== (expected ?? 0) + 1 || prior && prior.thread_key !== value.thread_key) followUpConflict();
      const other = db.prepare(`SELECT id FROM mail_follow_ups WHERE thread_key=? AND id<>? AND state IN (${active})`).get(value.thread_key, value.watch.id);
      if (other && ['waiting', 'needs_attention', 'draft_ready'].includes(value.watch.state)) followUpConflict();
      if (expected === null && (db.prepare(`SELECT count(*) AS n FROM mail_follow_ups WHERE state IN (${active})`).get() as { n: number }).n >= 256)
        throw new RpcError('limit_exceeded', 'Cancel an existing reply watch before starting another.', 409);
      writeRelated?.();
      db.prepare(`INSERT INTO mail_follow_ups (id,revision,thread_key,state,check_at,ciphertext,updated_at,schedule_version,notify_on_reply,task_key,task_link_version)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state,
        check_at=excluded.check_at,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at,schedule_version=excluded.schedule_version,
        notify_on_reply=excluded.notify_on_reply,task_key=excluded.task_key,task_link_version=excluded.task_link_version`)
        .run(value.watch.id, value.watch.revision, value.thread_key, value.watch.state, value.watch.check_at, ciphertext, value.watch.updated_at,
          value.watch.schedule_version ?? 0, Number(value.watch.notify_on_reply ?? false), linkedTaskKey, value.watch.task_link_version ?? 0);
    };
  };
  return {
    isCurrent(id: string, revision: number): boolean {
      codec.assertUnlocked();
      return row(id)?.revision === revision;
    },
    hasTaskLink(id: string, ref: MailFollowUpTaskRef, version: number, replacement = false): boolean {
      codec.assertUnlocked(); const current = row(id);
      return current?.task_key === taskKey(ref) && current.task_link_version === version && current.state !== 'cancelled' && (replacement || current.state !== 'delivery_failed');
    },
    /** Both encrypted watch rows and the send receipt use this connection. */
    async putTaskContinuation(from: StoredMailFollowUp, expected: number, to: StoredMailFollowUp, current: () => void, commitSend?: () => void) {
      if (from.watch.id === to.watch.id || from.watch.task_ref || !to.watch.task_ref) followUpConflict();
      const clear = await prepare(from, expected), attach = await prepare(to, null);
      db.transaction(() => { codec.assertUnlocked(); current(); clear(); attach(); commitSend?.(); }).immediate();
    },
    async byTask(ref: MailFollowUpTaskRef) {
      codec.assertUnlocked(); const r = db.prepare('SELECT * FROM mail_follow_ups WHERE task_key=?').get(taskKey(ref)) as Row | undefined;
      return r ? decode(r) : null;
    },
    async get(id: string) {
      codec.assertUnlocked();
      const r = row(id);
      return r ? decode(r) : null;
    },
    async thread(key: string) {
      codec.assertUnlocked();
      const r = db.prepare(`SELECT * FROM mail_follow_ups WHERE thread_key=?
        ORDER BY CASE WHEN state IN (${active}) THEN 0 ELSE 1 END,updated_at DESC,id LIMIT 1`).get(key) as Row | undefined;
      return r ? decode(r) : null;
    },
    async list(cursor?: MailFollowUpCursor, options: Omit<MailFollowUpList, 'cursor'> = {}) {
      codec.assertUnlocked();
      const clauses: string[] = [], args: (string | number)[] = [];
      if (cursor) { clauses.push('(updated_at<? OR (updated_at=? AND id>?))'); args.push(cursor.updated_at, cursor.updated_at, cursor.id); }
      if (options.state) { clauses.push('state=?'); args.push(options.state); }
      if (options.attention_at !== undefined) {
        clauses.push("(state IN ('draft_ready','needs_attention','delivery_failed') OR (state='waiting' AND check_at<=?))"); args.push(options.attention_at);
      }
      const rows = db.prepare(`SELECT * FROM mail_follow_ups ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
        ORDER BY updated_at DESC,id LIMIT 51`).all(...args) as Row[];
      const page = rows.slice(0, 50);
      const values = await Promise.all(page.map(decode));
      codec.assertUnlocked();
      for (const r of page) if (row(r.id)?.revision !== r.revision) followUpConflict();
      const found: StoredMailFollowUp[] = [];
      let scanned = 0;
      // Subject and mailbox stay encrypted. A cursor advances over scanned rows,
      // including nonmatches; an empty advancing page is not an empty search.
      for (const value of values) {
        scanned++;
        if (matchesMailFollowUp(value.watch, options)) found.push(value);
        if (found.length >= (options.limit ?? 50)) break;
      }
      const last = page[scanned - 1];
      return { rows: found, next_cursor: scanned < rows.length && last ? { updated_at: last.updated_at, id: last.id } : null };
    },
    activeIds(): string[] {
      codec.assertUnlocked();
      // Decode each watch inside its own check, so one unreadable or concurrently
      // edited row cannot prevent every other watch from running.
      return (db.prepare(`SELECT id FROM mail_follow_ups WHERE state IN (${active})
        ORDER BY check_at,id LIMIT 256`).all() as { id: string }[]).map(r => r.id);
    },
    /** `writeRelated` must write through this same SQLite connection. It runs
     * after all watch guards, inside the watch transaction, without events. */
    async put(value: StoredMailFollowUp, expected: number | null, current: () => void = () => {}, writeRelated?: () => void) {
      const write = await prepare(value, expected);
      db.transaction(() => { codec.assertUnlocked(); current(); write(writeRelated); }).immediate();
    },
  };
};
export type MailFollowUpStore = ReturnType<typeof createMailFollowUpStore>;
