/** D-343 — closing the day by replying to its email.
 *
 *  The daily stream, the Agenda and the evening notice can go to the owner by email. A reply that
 *  says how the day went closed nothing: the notification mailbox read a reply only as an option
 *  for an ask ("1 done"), and the email chat door never sees mail to the notification mailbox (the
 *  owner, 2026-11-14: "do the email reply close the day"; they chose the notification reply over the
 *  door).
 *
 *  A reply proven the owner's (`wire-inbound-email-answer.ts`), to a notice whose subject names an
 *  Agenda, an evening notice or a stream, and that is no option's answer, adds that notice to the
 *  app's "Your day" conversation (2026-11-15; before, a new conversation per email), as Today's
 *  "Close the day" opens it (`openNoticeConversation`), and runs the
 *  owner's own lines in it as a reply to the notice. The turn is the owner's app chat turn
 *  (the normal `chat` queue family), so the closing note, the day's items and the approval are the
 *  app's (D-343 slice 3): the records are asked for, in the app and on the owner's channels, before
 *  any is written. The answer stays in the app; nothing is sent by email.
 *
 *  A durable receipt owns the reply until queue admission commits. Its mailbox reference is saved
 *  synchronously, before encryption or opening: recovery never depends on a second first-seen mail
 *  event. Conversation, notice and submission identities are reserved once; admitted work belongs
 *  to the ordinary chat queue and is never replayed by this worker. */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EmailClosingReplyStatus } from '@recued/contracts';
import { APP_DAY_SESSION_ID, type NoticeConversationOpener } from './chat-notices.js';
import type { ChatTurnQueue } from './chat-turn-queue.js';
import { decodeChatContentFromStorage, encodeChatContentForStorage, type ChatKeyProvider } from './storage/chat-store.js';
import { settleWithin, STOP_GRACE_MS } from './lifecycle/settle-within.js';
import type { VaultStateBus } from './vault-state-bus.js';

/** The notice text kept from a reply's quote: enough to show what the owner answered. */
const QUOTE_MAX_LINES = 60;
const QUOTE_MAX_CHARS = 4000;

/** What a reply quotes of the email it answers: its `>` lines, one level unquoted, blank ends cut.
 *  Empty when the mail app quoted nothing (the notice then holds its title alone). */
export const emailQuotedLines = (body: string): string => {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
    .filter((line) => /^\s*>/.test(line))
    .map((line) => line.replace(/^\s*> ?/, '').trimEnd());
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  const text = lines.slice(0, QUOTE_MAX_LINES).join('\n');
  return text.length > QUOTE_MAX_CHARS ? `${text.slice(0, QUOTE_MAX_CHARS - 1)}…` : text;
};

export interface EmailClosingReply {
  /** The notice's title, read off the reply's subject (`repliedClosingTitle`). */
  readonly title: string;
  /** The owner's own lines (`emailReplyText`). */
  readonly text: string;
  /** What the reply quotes of the notice (`emailQuotedLines`). */
  readonly quoted: string;
  /** The reply's own RFC Message-ID: one conversation per email. */
  readonly rfc_message_id: string;
  /** The already-proven mail, retained if a stop cuts short its encrypted snapshot. */
  readonly source: { slug: string; record_id: string };
}

export type EmailCloseDayOutcome = 'opened' | 'seen' | 'pending' | 'unavailable';

export interface EmailCloseDayDeps {
  /** The Chat database, after its session and turn queue schemas are installed. */
  readonly db: Database.Database;
  readonly openNoticeConversation: () => NoticeConversationOpener | undefined;
  readonly queue: () => Pick<ChatTurnQueue, 'submit' | 'routing'> | undefined;
  readonly readReply: (source: EmailClosingReply['source'], rfc_message_id: string) => Promise<Pick<EmailClosingReply, 'title' | 'text' | 'quoted'> | null>;
  readonly getKey?: ChatKeyProvider;
  readonly canRun?: () => boolean;
  readonly subscribeVault?: VaultStateBus['subscribe'];
  readonly now?: () => number;
  readonly log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
}

interface ReplyRow {
  rfc_message_id: string;
  session_id: string | null;
  created_at: number;
  message_id: string | null;
  submission_id: string | null;
  mail_slug: string | null;
  mail_record_id: string | null;
  payload: string | null;
  snapshot_sha256: string | null;
  state: 'legacy' | 'pending' | 'accepted' | 'removed' | 'reviewed';
  reason: EmailClosingReplyStatus['reason'] | null;
  retry_at: number;
}

const RETRY_MS = 30_000;
const snapshotOf = (reply: Pick<EmailClosingReply, 'title' | 'text' | 'quoted'>) =>
  ({ title: reply.title, text: reply.text, quoted: reply.quoted });
const snapshotHash = (reply: Pick<EmailClosingReply, 'title' | 'text' | 'quoted'>) =>
  createHash('sha256').update(JSON.stringify(snapshotOf(reply))).digest('hex');

export const createEmailCloseDay = (deps: EmailCloseDayDeps) => {
  const now = deps.now ?? Date.now;
  const db = deps.db;
  db.exec(`CREATE TABLE IF NOT EXISTS email_close_day_replies (
    rfc_message_id TEXT PRIMARY KEY, session_id TEXT, created_at INTEGER NOT NULL)`);
  const columns = new Set((db.prepare('PRAGMA table_info(email_close_day_replies)').all() as Array<{ name: string }>).map(column => column.name));
  for (const [name, declaration] of Object.entries({ message_id: 'TEXT', submission_id: 'TEXT', mail_slug: 'TEXT', mail_record_id: 'TEXT',
    payload: 'TEXT', snapshot_sha256: 'TEXT', state: "TEXT NOT NULL DEFAULT 'legacy'", reason: 'TEXT', retry_at: 'INTEGER NOT NULL DEFAULT 0' })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE email_close_day_replies ADD COLUMN ${name} ${declaration}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS email_close_day_pending ON email_close_day_replies(state,retry_at,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS email_close_day_submission ON email_close_day_replies(submission_id);
    CREATE TRIGGER IF NOT EXISTS email_close_day_deleted BEFORE DELETE ON chat_sessions BEGIN
      UPDATE email_close_day_replies SET state='removed',payload=NULL,snapshot_sha256=NULL,mail_slug=NULL,mail_record_id=NULL
      WHERE session_id=OLD.session_id;
    END;`);
  // Old claims have no saved reply or stable queue identity. Expose their uncertainty without
  // guessing whether a later turn in the conversation was the email's own.
  db.prepare("UPDATE email_close_day_replies SET submission_id=lower(hex(randomblob(16))) WHERE state='legacy' AND submission_id IS NULL").run();
  const read = (id: string) => db.prepare('SELECT * FROM email_close_day_replies WHERE submission_id=?').get(id) as ReplyRow | undefined;
  const active = (id: string) => {
    if (stopped || read(id)?.state !== 'pending') throw new Error('This email reply is no longer waiting to open.');
  };
  const accepted = db.prepare(`UPDATE email_close_day_replies SET state='accepted',payload=NULL,snapshot_sha256=NULL,reason=NULL,mail_slug=NULL,mail_record_id=NULL
    WHERE submission_id=? AND state='pending'`);
  const inFlight = new Map<string, Promise<EmailCloseDayOutcome>>();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  const canRun = () => !stopped && db.open && (deps.canRun?.() ?? true) && (!deps.getKey || deps.getKey() !== null);
  const attempt = (id: string, fresh?: EmailClosingReply): Promise<EmailCloseDayOutcome> => {
    const previous = inFlight.get(id);
    if (previous) return previous;
    const work = (async (): Promise<EmailCloseDayOutcome> => {
      let row = read(id);
      if (!row || row.state !== 'pending') return row?.state === 'accepted' ? 'seen' : 'unavailable';
      if (!canRun()) return 'pending';
      const open = deps.openNoticeConversation(); const queue = deps.queue();
      if (!open || !queue) return 'pending';
      try {
        // A lost admission reply is already the queue's work, regardless of its current outcome.
        if (db.prepare('SELECT 1 FROM chat_turn_submissions WHERE session_id=? AND submission_id=?').get(row.session_id, id)) {
          accepted.run(id); return 'seen';
        }
        const identity = { session_id: row.session_id!, message_id: `email-reply:${id}` };
        let reply: Pick<EmailClosingReply, 'title' | 'text' | 'quoted'>;
        if (row.payload !== null) reply = JSON.parse(await decodeChatContentFromStorage(row.payload, identity, deps.getKey));
        else {
          const found = fresh ?? (row.mail_slug && row.mail_record_id
            ? await deps.readReply({ slug: row.mail_slug, record_id: row.mail_record_id }, row.rfc_message_id) : null);
          active(id);
          if (!found || snapshotHash(found) !== row.snapshot_sha256) {
            db.prepare("UPDATE email_close_day_replies SET reason='source_unavailable',retry_at=? WHERE submission_id=? AND state='pending'").run(now() + RETRY_MS, id);
            return 'pending';
          }
          reply = snapshotOf(found);
          const payload = await encodeChatContentForStorage(JSON.stringify(reply), identity, deps.getKey);
          active(id);
          db.prepare("UPDATE email_close_day_replies SET payload=? WHERE submission_id=? AND state='pending' AND payload IS NULL").run(payload, id);
        }
        if (!canRun()) return 'pending';
        active(id);
        const opened = await open({ title: reply.title, text: reply.quoted || reply.title },
          { session_id: row.session_id!, message_id: row.message_id!, assert_active: () => active(id) });
        if (opened.session_id !== row.session_id || opened.message_id !== row.message_id) throw new Error('The email reply opened in a different conversation.');
        if (!canRun()) return 'pending';
        active(id);
        await queue.submit({ family: 'chat', session_id: opened.session_id, message: reply.text,
          input: { session_id: opened.session_id, message: reply.text, reply_to_message_id: opened.message_id,
            picker_state: { current: 'self' }, model_routing_snapshot: queue.routing(opened.session_id) } }, id, false, () => {
          active(id);
          if (!canRun()) throw new Error('Email reply admission is paused.');
          accepted.run(id);
        });
        // A replayed queue submission does not call beforeInsert; its durable receipt still stands.
        accepted.run(id);
        return 'opened';
      } catch {
        if (!db.open) return 'pending';
        row = read(id);
        if (!stopped && row?.state === 'pending') {
          db.prepare("UPDATE email_close_day_replies SET reason='retry',retry_at=? WHERE submission_id=? AND state='pending'").run(now() + RETRY_MS, id);
          deps.log?.('warn', 'closing the day by email: waiting to open in Chat', { session_id: row.session_id });
        }
        return row?.state === 'accepted' ? 'opened' : row?.state === 'pending' ? 'pending' : 'unavailable';
      }
    })().finally(() => { inFlight.delete(id); });
    inFlight.set(id, work);
    return work;
  };
  const receive = async (reply: EmailClosingReply): Promise<EmailCloseDayOutcome> => {
    if (stopped || reply.rfc_message_id.trim() === '' || reply.text.trim() === '') return 'unavailable';
    const id = randomUUID();
    // No await before ownership: a restart can reconstruct the snapshot from this proven mail.
    const inserted = db.prepare(`INSERT OR IGNORE INTO email_close_day_replies
      (rfc_message_id,session_id,created_at,message_id,submission_id,mail_slug,mail_record_id,snapshot_sha256,state)
      VALUES(?,?,?,?,?,?,?,?,'pending')`).run(reply.rfc_message_id.trim(), APP_DAY_SESSION_ID, now(), `notice:${randomUUID()}`, id, reply.source.slug, reply.source.record_id, snapshotHash(reply));
    if (!inserted.changes) return 'seen';
    return attempt(id, reply);
  };
  const recover = async (immediate = false) => {
    if (!canRun()) return;
    const due = db.prepare("SELECT submission_id FROM email_close_day_replies WHERE state='pending' AND retry_at<=? ORDER BY retry_at,created_at LIMIT 50").all(immediate ? Number.MAX_SAFE_INTEGER : now()) as Array<{ submission_id: string }>;
    for (const row of due) { if (!canRun()) break; await attempt(row.submission_id); }
  };
  return Object.assign(receive, {
    recover,
    pending: (): EmailClosingReplyStatus[] => (db.prepare(`SELECT r.submission_id,r.created_at,r.state,r.reason,r.session_id,
      EXISTS(SELECT 1 FROM chat_sessions s WHERE s.session_id=r.session_id) AS has_session
      FROM email_close_day_replies r WHERE state IN ('pending','legacy') ORDER BY created_at DESC LIMIT 20`).all() as Array<Pick<ReplyRow,
        'submission_id' | 'created_at' | 'state' | 'reason' | 'session_id'> & { has_session: number }>).map(row => ({
      id: row.submission_id!, received_at: row.created_at, reason: row.state === 'legacy' ? 'unknown' : row.reason ?? 'waiting',
      ...(row.has_session ? { session_id: row.session_id! } : {}), retry_available: row.state === 'pending',
    })),
    retry: (id: string) => {
      const row = read(id);
      if (!row) throw new Error('This email reply is no longer available.');
      if (row.state === 'legacy') throw new Error('Check the earlier conversation before sending a new reply. Its original handoff could not be confirmed.');
      if (row.state === 'removed' || row.state === 'reviewed') throw new Error('This email reply is no longer waiting. It will not be repeated.');
      return attempt(id);
    },
    markReviewed(id: string) {
      const row = read(id);
      if (row?.state === 'reviewed') return;
      if (row?.state !== 'legacy') throw new Error('Only an earlier unconfirmed email reply can be marked reviewed.');
      db.prepare("UPDATE email_close_day_replies SET state='reviewed' WHERE submission_id=? AND state='legacy'").run(id);
    },
    start() {
      if (timer || stopped) return;
      const kick = (immediate = false) => { void recover(immediate).catch(() => { /* Durable pending rows remain for the next check. */ }); };
      unsubscribe = deps.subscribeVault?.(next => { if (next === 'unlocked') kick(true); });
      timer = setInterval(kick, RETRY_MS); timer.unref(); kick(true);
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      unsubscribe?.(); unsubscribe = undefined;
      await settleWithin(Promise.allSettled([...inFlight.values()]), STOP_GRACE_MS);
    },
  });
};

export type EmailCloseDay = ReturnType<typeof createEmailCloseDay>;
