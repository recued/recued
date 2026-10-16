/** D-318 step 5, part 2 — the result after an approval follows in the thread
 *  (§4.5, P18).
 *
 *  An email turn's answer can say that something waits for the owner's
 *  approval: a recipe run held at the approval gate. The owner approves (or
 *  declines) it in the web app, on Slack or Telegram, or by D-158's email
 *  reply, and the run settles later, long after the turn. Its outcome is then
 *  written into the conversation as an answer of that turn, and so it is owed
 *  by email like any answer (`answers.ts`): it goes to the owner in the same
 *  thread, as a reply to the request that asked for it.
 *
 *  Two facts meet here, in either order, and both are kept:
 *  - **The watch.** Each run an email turn's answer names (`tool_calls[].run_id`)
 *    is recorded when the answer is first read to be sent. The answer's tool
 *    calls are encrypted, so the trigger that owes the answer cannot read them.
 *  - **The settlement.** The server reports a run that settled after its turn
 *    (`PreflightRunSettled`); one that the email door started is recorded.
 *  An owner quick enough to approve before the answer is read only reverses
 *  the order: the follow-up waits for both.
 *
 *  ⚠ Words of Recued's, not the model's: a short line saying what became of the
 *  approved action. The run's detail is in the web app.
 *
 *  ⚠ A plan card (D-137's approval of a write chat tool) runs nothing when it is
 *  approved: the tool runs when the conversation's next message asks again, by
 *  email as in the web app. Only a held run settles on its own.
 *
 *  Spec: D-318 §4.5, §8 step 5. */

import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';
import { MAIL_CHAT_DOOR_VENDOR, type ChatMessage, type ExecutionSource } from '@recued/contracts';

import { isNonTerminalToolResult } from '../chat-tool-call-context.js';
import type { PreflightRunSettled } from '../preflight-resumer.js';
import type { ChatStore } from '../storage/chat-store.js';

/** Settlements, and watches already followed up, are kept this long. */
export const MAIL_CHAT_FOLLOW_UP_KEEP_MS = 7 * 86_400_000;
/** A watch not yet followed up is kept this long: a run can wait for the
 *  owner's approval up to `preflight.stale_after_days` (30 by default). */
export const MAIL_CHAT_FOLLOW_UP_WATCH_MS = 90 * 86_400_000;
/** A failure's own words, cut to this. */
const DETAIL_MAX = 300;

export type MailChatRunOutcome = 'succeeded' | 'failed' | 'denied' | 'interrupted';

/** The follow-up's id: one per run, so a settlement told twice writes once. */
export const mailChatFollowUpId = (run_id: string): string =>
  `mail-chat-follow-up:${createHash('sha256').update(run_id).digest('hex').slice(0, 32)}`;

export const ensureMailChatFollowUpSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_chat_watched_runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      -- The answer's picker and signature, which the follow-up carries too.
      picker_json TEXT NOT NULL,
      watched_at INTEGER NOT NULL,
      followed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mail_chat_settled_runs (
      run_id TEXT PRIMARY KEY,
      outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'denied', 'interrupted')),
      detail TEXT,
      source_json TEXT NOT NULL,
      settled_at INTEGER NOT NULL
    );
  `);
};

/** What became of a settled run, read as the chat's own settlement reads it. */
export const mailChatRunOutcome = (settled: PreflightRunSettled): { outcome: MailChatRunOutcome; detail?: string } => {
  const result = settled.result !== null && typeof settled.result === 'object'
    ? settled.result as Record<string, unknown>
    : {};
  if (result.denied === true) return { outcome: 'denied' };
  if (settled.state === 'interrupted') return { outcome: 'interrupted' };
  const succeeded = settled.state !== undefined ? settled.state === 'succeeded' : result.success === true;
  if (succeeded) return { outcome: 'succeeded' };
  const errors = Array.isArray(result.errors) ? result.errors as Array<{ message?: unknown }> : [];
  const failed = result.run_failed as { detail?: unknown } | undefined;
  const words = [failed?.detail, result.detail, errors[0]?.message, result.message]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const detail = words?.replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX);
  return detail === undefined ? { outcome: 'failed' } : { outcome: 'failed', detail };
};

/** The follow-up's words. */
export const mailChatFollowUpText = (outcome: MailChatRunOutcome, tool_name: string, detail?: string | null): string => {
  const action = `The action that waited for your approval (${tool_name})`;
  switch (outcome) {
    case 'succeeded':
      return `${action} is done.`;
    case 'denied':
      return `${action} was declined, so it was not done.`;
    case 'interrupted':
      return `${action} was interrupted. Open Recued to see how far it got.`;
    case 'failed':
      return detail
        ? `${action} did not complete: ${detail}`
        : `${action} did not complete. Open Recued to see why.`;
  }
};

/** Did the email door start this run? */
const fromTheEmailDoor = (source: unknown): source is ExecutionSource => {
  const s = source as { channel?: unknown; vendor?: unknown } | null | undefined;
  return s?.channel === 'messenger' && s.vendor === MAIL_CHAT_DOOR_VENDOR;
};

/** A settled run the email door started, and no longer held. */
export const mailChatRunFromTheEmailDoor = (settled: PreflightRunSettled): boolean =>
  fromTheEmailDoor(settled.execution_source) && settled.run_id.length > 0 && !isNonTerminalToolResult(settled.result);

/** ⛔ KEPT FROM BOOT. A run approved just before a restart settles while the
 *  server starts again, before the door's loop exists (the audit): the server
 *  listens with this from the moment chat's settled-run sink exists, and the
 *  loop writes the follow-up when it comes. `true` when it was kept. */
export const recordMailChatSettledRun = (db: Database.Database, settled: PreflightRunSettled, at: number): boolean => {
  if (!mailChatRunFromTheEmailDoor(settled)) return false;
  ensureMailChatFollowUpSchema(db);
  const { outcome, detail } = mailChatRunOutcome(settled);
  return db.prepare(`INSERT OR IGNORE INTO mail_chat_settled_runs
    (run_id, outcome, detail, source_json, settled_at) VALUES (?, ?, ?, ?, ?)`)
    .run(settled.run_id, outcome, detail ?? null, JSON.stringify(settled.execution_source), at).changes > 0;
};

export interface MailChatFollowUps {
  /** Watch the runs an email turn's answer names. */
  watch(answer: Pick<ChatMessage, 'session_id' | 'turn_id' | 'tool_calls' | 'picker_at_send'>, at: number): void;
  /** Keep a run that settled after its turn, if the email door started it.
   *  `true` when it was kept. */
  settled(settled: PreflightRunSettled, at: number): boolean;
  /** Write each follow-up whose run is both watched and settled, as an answer
   *  of the turn that asked: the trigger on the chat's messages then owes it by
   *  email. Returns how many were written. */
  writeDue(at: number): Promise<number>;
  /** Remove settlements and watches past their time. */
  prune(at: number): void;
}

export const createMailChatFollowUps = (deps: {
  readonly db: Database.Database;
  readonly chatStore: Pick<ChatStore, 'appendMessage'>;
}): MailChatFollowUps => {
  const { db, chatStore } = deps;
  ensureMailChatFollowUpSchema(db);
  const insertWatch = db.prepare(`INSERT OR IGNORE INTO mail_chat_watched_runs
    (run_id, session_id, turn_id, tool_name, picker_json, watched_at) VALUES (?, ?, ?, ?, ?, ?)`);
  // After its turn's answer has gone (or settled otherwise): a follow-up never
  // reaches the owner before the answer that says it is waiting.
  const selectDue = db.prepare(`SELECT w.run_id, w.session_id, w.turn_id, w.tool_name, w.picker_json,
      s.outcome, s.detail, s.source_json
    FROM mail_chat_watched_runs w JOIN mail_chat_settled_runs s ON s.run_id = w.run_id
    WHERE w.followed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM mail_chat_answers a WHERE a.session_id = w.session_id
        AND a.turn_id = w.turn_id AND a.state IN ('pending', 'sending', 'unknown'))
    ORDER BY s.settled_at LIMIT 10`);
  const markFollowed = db.prepare('UPDATE mail_chat_watched_runs SET followed_at = ? WHERE run_id = ?');
  const messageExists = db.prepare('SELECT 1 FROM chat_messages WHERE message_id = ?');
  const pruneWatched = db.prepare(`DELETE FROM mail_chat_watched_runs
    WHERE (followed_at IS NOT NULL AND followed_at < ?) OR watched_at < ?`);
  const pruneSettled = db.prepare('DELETE FROM mail_chat_settled_runs WHERE settled_at < ?');

  return {
    watch(answer, at) {
      if (answer.turn_id === undefined) return;
      for (const call of answer.tool_calls ?? []) {
        if (typeof call.run_id === 'string' && call.run_id.length > 0) {
          insertWatch.run(
            call.run_id, answer.session_id, answer.turn_id, call.tool_name, JSON.stringify(answer.picker_at_send), at,
          );
        }
      }
    },
    // Held again (a second approval): it has not settled.
    settled: (settled, at) => recordMailChatSettledRun(db, settled, at),
    async writeDue(at) {
      let written = 0;
      for (const row of selectDue.all() as Array<{
        run_id: string; session_id: string; turn_id: string; tool_name: string; picker_json: string;
        outcome: MailChatRunOutcome; detail: string | null; source_json: string;
      }>) {
        const id = mailChatFollowUpId(row.run_id);
        try {
          await chatStore.appendMessage({
            id,
            session_id: row.session_id,
            role: 'assistant',
            content: mailChatFollowUpText(row.outcome, row.tool_name, row.detail),
            target_server: 'self',
            picker_at_send: JSON.parse(row.picker_json) as ChatMessage['picker_at_send'],
            model_used: { provider: 'recued', model_id: 'approval-follow-up' },
            execution_source: JSON.parse(row.source_json) as ExecutionSource,
            turn_id: row.turn_id,
            ts: at,
          });
        } catch {
          // Written before a stop kept it from being marked: it is done. Not
          // written (the vault locked meanwhile, say): the next round tries
          // again, and the others go on.
          if (messageExists.get(id) === undefined) continue;
        }
        markFollowed.run(at, row.run_id);
        written += 1;
      }
      return written;
    },
    prune(at) {
      pruneWatched.run(at - MAIL_CHAT_FOLLOW_UP_KEEP_MS, at - MAIL_CHAT_FOLLOW_UP_WATCH_MS);
      pruneSettled.run(at - MAIL_CHAT_FOLLOW_UP_KEEP_MS);
    },
  };
};
