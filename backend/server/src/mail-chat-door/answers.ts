/** D-318 step 5 — the answer goes back by email (§4.6).
 *
 *  Chat's answer to an email request is sent from the chat mailbox to the
 *  address the request came from — that address only: never a Reply-To, never
 *  anyone else, never reply-all. It goes in the request's thread: In-Reply-To
 *  and References name the request, the subject is kept (`Re: …`), and a Gmail
 *  chat mailbox is given the request's thread so its own view stays one thread.
 *  Plain text, as Slack and Telegram get it, ending with D-323's install offers
 *  as plain lines. Marked automatic, so auto-responders stay quiet, and with its
 *  reconciliation id, so every Recued sync knows it as Recued's own and the
 *  owner's mail features leave it out (`conversation-mail.ts`).
 *
 *  ⛔ OWED FROM THE ANSWER'S OWN COMMIT. A trigger on the chat message writes
 *  the obligation in the same transaction (as D-265's messenger deliveries are
 *  written), so an answer stored is an answer owed, whatever stops in between. A
 *  loop of its own sends it, never holding the chat queue.
 *
 *  ⛔ NEVER TWICE. Every attempt carries the answer's one reconciliation id, so
 *  the mail collection's send claim (D-207) refuses to send again an answer
 *  that may already have gone. An attempt whose outcome is unknown — a timeout,
 *  a stop mid-send — is settled by the chat mailbox's own Sent record
 *  (`lookupSentByReconciliationId`). Until it is, nothing is sent again: the
 *  owner is asked "Did this email go out?", as for any fenced send, and their
 *  answer lets the next attempt send or settles it as sent.
 *
 *  The answer's Message-ID, as the chat mailbox's Sent copy shows it (Gmail
 *  assigns its own on send), is recorded in the conversation (§4.13): a reply
 *  to the answer continues the conversation even from a mail app that writes
 *  only In-Reply-To.
 *
 *  An answer not sent within a day is given up, with one notice (at most one an
 *  hour). It stays in the conversation, in the web app.
 *
 *  Part 2 — the result of a run that waited for the owner's approval follows in
 *  the thread: written into the conversation as an answer of the turn that
 *  asked (`follow-ups.ts`), it is owed and sent here like any other.
 *
 *  Spec: D-318 §4.5, §4.6, §4.13, §8 step 5. */

import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';
import { IngredientError } from '@recued/ingredients';
import type { NotificationMessage } from '@recued/notification';
import type { AuditLogStore } from '@recued/storage';

import type { MailCollection } from '../collections/mail/mail-collection.js';
import { normalizeRfcMessageId } from '../collections/mail/provider.js';
import { messengerInstallOfferLines } from '../install-offers/messenger-lines.js';
import type { PreflightRunSettled } from '../preflight-resumer.js';
import type { ChatStore } from '../storage/chat-store.js';
import type { MailSendClaimStore } from '../storage/mail-send-claim-store.js';
import type { MailChatDoorStore } from '../storage/mail-chat-door-store.js';
import { mailChatAnswerReconciliationId } from './conversation-mail.js';
import type { MailChatConversations } from './conversations.js';
import { createMailChatFollowUps, mailChatRunFromTheEmailDoor } from './follow-ups.js';
import type { MailChatProofNotify, MailChatSentProof } from './sent-proof.js';

/** The wait before each attempt after a failed one; the last repeats. */
export const MAIL_CHAT_ANSWER_RETRY_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];
/** An answer not sent within this long of being written is given up. */
export const MAIL_CHAT_ANSWER_GIVE_UP_MS = 24 * 3_600_000;
/** How long the Sent copy is looked for, to record the answer's Message-ID. */
export const MAIL_CHAT_ANSWER_RECORD_WAIT_MS = 10 * 60_000;
/** The wait before each look for the Sent copy; the last repeats. */
export const MAIL_CHAT_ANSWER_RECORD_RETRY_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000];
/** A look at the Sent record starts this long before the first attempt: a
 *  provider's clock is not the server's. */
export const MAIL_CHAT_ANSWER_LOOKUP_SKEW_MS = 5 * 60_000;
/** At most one notice in this long. */
export const MAIL_CHAT_ANSWER_NOTICE_INTERVAL_MS = 3_600_000;
/** Settled answers are kept this long, then removed. */
export const MAIL_CHAT_ANSWER_KEEP_MS = 7 * 86_400_000;
/** A request's envelope is kept this long, for every answer to it: a run can
 *  wait for the owner's approval up to `preflight.stale_after_days` (30 by
 *  default), and its follow-up is an answer to the same request. */
export const MAIL_CHAT_ENVELOPE_KEEP_MS = 90 * 86_400_000;
/** A subject the send claim takes: RFC 5322 caps a header line at 998. */
const SUBJECT_MAX = 900;
/** An answer names the thread's first message and its nearest ones, at most
 *  this many: a References line is one header line, kept short. */
export const MAIL_CHAT_ANSWER_MAX_REFERENCES = 10;
/** With nothing due, the loop still looks this often. Answers are written by a
 *  trigger, so a turn that ends without its `kick` is found by this. */
const IDLE_POLL_MS = 15_000;
/** The longest the timer sleeps, so a clock change cannot strand an answer. */
const MAX_SLEEP_MS = 60_000;

export type MailChatAnswerState = 'pending' | 'sending' | 'unknown' | 'sent' | 'failed' | 'dropped';

export interface MailChatAnswer {
  /** The chat message it sends. */
  readonly answer_id: string;
  readonly session_id: string;
  readonly turn_id: string;
  readonly chat_slug: string;
  /** The request it answers: its RFC Message-ID, bracketless. */
  readonly request_message_id: string;
  readonly state: MailChatAnswerState;
  readonly attempts: number;
  readonly reason: string | null;
  /** The answer's own Message-ID, once its Sent copy shows it (or the send
   *  returned it): recorded in the conversation. */
  readonly message_id: string | null;
  readonly reconciliation_id: string;
}

/** The part of a mailbox the answers use. */
export type MailChatAnswersMailbox = Pick<
  MailCollection, 'platform' | 'slug' | 'accountEmail' | 'get' | 'send' | 'lookupSentByReconciliationId'
> & { readonly provider?: { readonly kind: string } };

export interface ComposeMailChatAnswersDeps {
  readonly db: Database.Database;
  /** Where the answers are read, and a follow-up written: the chat's own store. */
  readonly chatStore: Pick<ChatStore, 'listMessagePage' | 'getSession' | 'appendMessage'>;
  readonly door: Pick<MailChatDoorStore, 'isChatMailbox'>;
  /** Every connected mailbox, read at each attempt. */
  readonly mailboxes: () => readonly MailChatAnswersMailbox[];
  /** The proof's record of each request: who sent it, what it refers to. */
  readonly requests: Pick<MailChatSentProof, 'get'>;
  readonly conversations: Pick<MailChatConversations, 'conversationOf' | 'record'>;
  /** The send claims, to settle one the Sent record proves. Absent ⇒ left as
   *  the send left them. */
  readonly claims?: Pick<MailSendClaimStore, 'get' | 'settle'>;
  /** "Did this email go out?" for an answer whose attempt ended unknown. */
  readonly askOwner?: (reconciliation_id: string) => Promise<void>;
  /** Close that question once the answer is given up: nothing sends it after. */
  readonly closeOwnerQuestion?: (reconciliation_id: string) => Promise<void>;
  /** D-323 — the server's public web app address, read at send time. */
  readonly publicBaseUrl?: () => string | null;
  /** Answers are read and sent only while the vault is open. */
  readonly isUnlocked?: () => boolean;
  /** The notice's history row. Absent ⇒ the push alone. */
  readonly auditLog?: Pick<AuditLogStore, 'logActivity'>;
  readonly now?: () => number;
  readonly log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
}

export interface MailChatAnswers {
  /** Send what is due. */
  tick(): Promise<void>;
  /** A turn ended: an answer may be owed. */
  kick(): void;
  /** Part 2 — a run settled after the turn that asked for it (the server's
   *  settled-run report): one an email turn started gets its follow-up. */
  onRunSettled(settled: PreflightRunSettled): void;
  /** How the owner is told of an answer given up. Until bound, a notice waits. */
  bindNotify(fn: MailChatProofNotify): void;
  start(): void;
  /** Stop, and wait for an attempt in progress. Idempotent. */
  dispose(): Promise<void>;
  /** One answer, for the tests and diagnostics. */
  get(answer_id: string): MailChatAnswer | null;
  /** Step 7 — a request's first answer by email: where it is, and when it was
   *  sent. `null` until chat answered. */
  ofRequest(chat_slug: string, request_message_id: string): { state: MailChatAnswerState; sent_at: number | null } | null;
}

/** What the answer is sent as: fixed at the first attempt, because the send
 *  claim refuses the same reconciliation id for a different message. */
interface Envelope {
  readonly to: string;
  readonly subject: string;
  readonly in_reply_to: string;
  readonly references: readonly string[];
  readonly thread_id?: string;
}

interface AnswerRow {
  answer_id: string;
  session_id: string;
  turn_id: string;
  chat_slug: string;
  request_message_id: string;
  created_at: number;
  state: MailChatAnswerState;
  attempts: number;
  next_attempt_at: number;
  first_attempt_at: number | null;
  reason: string | null;
  envelope_json: string | null;
  thread_dropped: number;
  sent_at: number | null;
  sent_message_id: string | null;
  recorded_message_id: string | null;
  record_state: 'waiting' | 'recorded' | 'gave_up' | null;
  record_attempts: number;
  record_next_at: number | null;
  notice_state: 'none' | 'due' | 'sent' | 'suppressed';
  notice_at: number | null;
  notice_json: string | null;
  settled_at: number | null;
}

/** `Re:` in front of the request's subject, unless a reply prefix is there
 *  (`filters.ts`'s, without `VS:`, which is a forward in Danish and Norwegian). */
const REPLY_PREFIX = /^\s*(?:re|aw|sv|antw|res)\s*(?:\[\d+\])?\s*:/i;

/** The subject an answer is sent with: the request's, as a reply. */
export const mailChatAnswerSubject = (subject: string): string => {
  const kept = subject.replace(/\s+/g, ' ').trim();
  return (REPLY_PREFIX.test(kept) ? kept : `Re: ${kept}`.trim()).slice(0, SUBJECT_MAX).trim();
};

/** The answer's References: the request's own, in their order, then the
 *  request. A long chain keeps its first message (the thread's root) and its
 *  nearest ones. Each in brackets, as the header writes them. */
export const mailChatAnswerReferences = (
  requestReferences: readonly string[],
  requestMessageId: string,
): string[] => {
  // The proof keeps them nearest first.
  const chain = [...new Set([...[...requestReferences].reverse(), requestMessageId])];
  const kept = chain.length <= MAIL_CHAT_ANSWER_MAX_REFERENCES
    ? chain
    : [chain[0]!, ...chain.slice(-(MAIL_CHAT_ANSWER_MAX_REFERENCES - 1))];
  return kept.map((id) => `<${id}>`);
};

/** What the owner is told when an answer was given up. ⚠ Never the answer's
 *  text: it is in the conversation, behind the web app's login. */
export const mailChatAnswerNotice = (chat: string, unknown: boolean): NotificationMessage => ({
  title: 'An answer to your email was not sent',
  text: unknown
    ? `Recued answered an email you sent to your chat mailbox, ${chat}, but could not tell whether the `
      + 'answer went out, so it did not send it again. The answer is in the conversation in Recued.'
    : `Recued answered an email you sent to your chat mailbox, ${chat}, but could not send the answer `
      + 'by email. Check the chat mailbox\'s connection in Settings. The answer is in the conversation in '
      + 'Recued.',
});

/** The text an answer is sent with: the chat message, a line naming any files
 *  (they stay in Recued), and D-323's install offers. */
export const mailChatAnswerBody = (
  message: { content: string; attachments?: ReadonlyArray<{ filename?: string }>; install_offers?: unknown },
  publicBaseUrl: string | null,
): string => {
  const files = message.attachments ?? [];
  const names = files.map((file) => file.filename).filter((name): name is string => typeof name === 'string' && name !== '');
  const filesLine = files.length === 0 ? ''
    : names.length === files.length
      ? `\n\n(In Recued with this answer: ${names.join(', ')}.)`
      : `\n\n(${files.length === 1 ? 'A file comes' : `${files.length} files come`} with this answer. Open the conversation in Recued to see ${files.length === 1 ? 'it' : 'them'}.)`;
  const text = message.content.trim();
  if (text.length === 0 && files.length === 0) return '';
  return `${text}${filesLine}${messengerInstallOfferLines(message.install_offers, publicBaseUrl)}`.trim();
};

/** A send result's id that is already a Message-ID (IMAP's, Graph's); Gmail's
 *  is its own message id, and the Sent copy is asked for the Message-ID. */
const rfcMessageIdOf = (id: string | undefined): string | undefined => {
  const normalized = normalizeRfcMessageId(id);
  return normalized !== undefined && normalized.includes('@') ? normalized : undefined;
};

/** The door changed between the attempt's start and its send. */
class DoorChangedError extends Error {}

const after = (schedule: readonly number[], attempt: number): number =>
  schedule[Math.min(Math.max(attempt, 1), schedule.length) - 1]!;

/** Create the answers' table and the trigger that owes one. `false` when the
 *  chat's tables are not there: no chat, no answers. */
const ensureSchema = (db: Database.Database): boolean => {
  const has = (table: string): boolean =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
  if (!has('chat_messages') || !has('chat_native_receipts') || !has('chat_sessions')) return false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_chat_answers (
      answer_id TEXT PRIMARY KEY REFERENCES chat_messages(message_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      chat_slug TEXT NOT NULL,
      request_message_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'sending', 'unknown', 'sent', 'failed', 'dropped')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      first_attempt_at INTEGER,
      reason TEXT,
      envelope_json TEXT,
      thread_dropped INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER,
      sent_message_id TEXT,
      recorded_message_id TEXT,
      record_state TEXT CHECK (record_state IN ('waiting', 'recorded', 'gave_up')),
      record_attempts INTEGER NOT NULL DEFAULT 0,
      record_next_at INTEGER,
      notice_state TEXT NOT NULL DEFAULT 'none' CHECK (notice_state IN ('none', 'due', 'sent', 'suppressed')),
      notice_at INTEGER,
      notice_json TEXT,
      settled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mail_chat_answers_due ON mail_chat_answers (state, next_attempt_at);
    -- Every answer to a request goes in one envelope, the first answer's: kept
    -- here past the request's own record, for a follow-up weeks later.
    CREATE TABLE IF NOT EXISTS mail_chat_request_envelopes (
      chat_slug TEXT NOT NULL,
      request_message_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (chat_slug, request_message_id)
    );
    CREATE INDEX IF NOT EXISTS mail_chat_answers_record ON mail_chat_answers (record_state, record_next_at);
    -- An answer to a turn an email started is owed by email, from the moment it
    -- is stored. The turn's native receipt names the request and the chat mailbox.
    CREATE TRIGGER IF NOT EXISTS mail_chat_answer_owed AFTER INSERT ON chat_messages
      WHEN NEW.role = 'assistant' AND NEW.turn_id IS NOT NULL AND NEW.session_id LIKE 'mail:%'
      BEGIN
        INSERT OR IGNORE INTO mail_chat_answers
          (answer_id, session_id, turn_id, chat_slug, request_message_id, created_at, state)
          SELECT NEW.message_id, NEW.session_id, NEW.turn_id, r.recipient, r.message_id, NEW.ts, 'pending'
          FROM chat_native_receipts r
          WHERE r.session_id = NEW.session_id AND r.turn_id = NEW.turn_id AND r.vendor = 'email'
          LIMIT 1;
      END;
  `);
  return true;
};

/** Compose the answers over the chat's database. `undefined` when the chat's
 *  tables are not there. */
export const composeMailChatAnswers = (deps: ComposeMailChatAnswersDeps): MailChatAnswers | undefined => {
  const { db, chatStore, door, mailboxes, requests, conversations, claims, askOwner, auditLog, log } = deps;
  if (!ensureSchema(db)) return undefined;
  const now = deps.now ?? Date.now;
  const followUps = createMailChatFollowUps({ db, chatStore });

  const selectOne = db.prepare('SELECT * FROM mail_chat_answers WHERE answer_id = ?');
  const selectOfRequest = db.prepare(`SELECT state, sent_at FROM mail_chat_answers
    WHERE chat_slug = ? AND request_message_id = ? ORDER BY created_at LIMIT 1`);
  const selectDue = db.prepare(`SELECT * FROM mail_chat_answers
    WHERE state IN ('pending', 'unknown') AND next_attempt_at <= ? ORDER BY created_at LIMIT 10`);
  const selectRecordDue = db.prepare(`SELECT * FROM mail_chat_answers
    WHERE record_state = 'waiting' AND record_next_at <= ? ORDER BY created_at LIMIT 10`);
  const selectNextDue = db.prepare(`SELECT MIN(at) AS at FROM (
    SELECT next_attempt_at AS at FROM mail_chat_answers WHERE state IN ('pending', 'unknown')
    UNION ALL SELECT record_next_at AS at FROM mail_chat_answers WHERE record_state = 'waiting')`);
  const selectNoticesDue = db.prepare("SELECT * FROM mail_chat_answers WHERE notice_state = 'due' ORDER BY notice_at");
  const selectLastNotice = db.prepare(`SELECT MAX(notice_at) AS at FROM mail_chat_answers
    WHERE notice_state IN ('due', 'sent')`);
  const recoverSending = db.prepare(`UPDATE mail_chat_answers SET state = 'unknown', next_attempt_at = 0
    WHERE state = 'sending'`);
  const markNoticeSent = db.prepare(`UPDATE mail_chat_answers SET notice_state = 'sent'
    WHERE answer_id = ? AND notice_state = 'due'`);
  const prune = db.prepare(`DELETE FROM mail_chat_answers
    WHERE state IN ('sent', 'failed', 'dropped') AND notice_state != 'due'
      AND (record_state IS NULL OR record_state != 'waiting') AND settled_at < ?`);
  const selectEnvelope = db.prepare(`SELECT envelope_json FROM mail_chat_request_envelopes
    WHERE chat_slug = ? AND request_message_id = ?`);
  const insertEnvelope = db.prepare(`INSERT OR IGNORE INTO mail_chat_request_envelopes
    (chat_slug, request_message_id, envelope_json, created_at) VALUES (?, ?, ?, ?)`);
  const pruneEnvelopes = db.prepare('DELETE FROM mail_chat_request_envelopes WHERE created_at < ?');

  let notify: MailChatProofNotify | undefined;
  let started = false;
  let disposed = false;
  let running: Promise<void> | undefined;
  let again = false;
  let locked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const read = (answer_id: string): AnswerRow | undefined => selectOne.get(answer_id) as AnswerRow | undefined;
  const update = (answer_id: string, fields: Partial<AnswerRow>): void => {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    db.prepare(`UPDATE mail_chat_answers SET ${keys.map((key) => `${key} = @${key}`).join(', ')}
      WHERE answer_id = @answer_id`).run({ ...fields, answer_id });
  };

  /** Settle as not sent; a failure earns the owner a notice, within the cap. */
  const settleUnsent = (row: AnswerRow, state: 'failed' | 'dropped', reason: string): void => {
    const at = now();
    let notice: Pick<AnswerRow, 'notice_state' | 'notice_at' | 'notice_json'> = {
      notice_state: 'none', notice_at: null, notice_json: null,
    };
    if (state === 'failed') {
      const last = (selectLastNotice.get() as { at: number | null }).at;
      const held = last !== null && at - last < MAIL_CHAT_ANSWER_NOTICE_INTERVAL_MS;
      notice = held
        ? { notice_state: 'suppressed', notice_at: at, notice_json: null }
        : {
            notice_state: 'due',
            notice_at: at,
            notice_json: JSON.stringify(mailChatAnswerNotice(chatAddressOf(row.chat_slug), row.state === 'unknown')),
          };
    }
    update(row.answer_id, { state, reason, settled_at: at, ...notice });
    // Given up: the owner's open question about whether it went out would only
    // promise a send that no longer comes.
    if (state === 'failed' && row.state === 'unknown' && deps.closeOwnerQuestion !== undefined) {
      void deps.closeOwnerQuestion(mailChatAnswerReconciliationId(row.answer_id)).catch(() => undefined);
    }
    log?.(state === 'failed' ? 'warn' : 'info', `chat mailbox answer ${state === 'failed' ? 'not sent' : 'dropped'}`, {
      chat_slug: row.chat_slug, reason, attempts: row.attempts,
      ...(notice.notice_state === 'suppressed' ? { notice: 'held back: one was given within the hour' } : {}),
    });
  };

  const chatAddressOf = (slug: string): string =>
    mailboxes().find((entry) => entry.platform === 'mail' && entry.slug === slug)?.accountEmail || slug;

  /** Try again later, or give up a day after the answer was written. */
  const retryLater = (row: AnswerRow, reason: string, extra: Partial<AnswerRow> = {}): void => {
    if (now() - row.created_at >= MAIL_CHAT_ANSWER_GIVE_UP_MS) {
      settleUnsent({ ...row, ...extra } as AnswerRow, 'failed', reason);
      return;
    }
    update(row.answer_id, { reason, next_attempt_at: now() + after(MAIL_CHAT_ANSWER_RETRY_MS, row.attempts), ...extra });
  };

  const conversationOf = (row: AnswerRow): string =>
    conversations.conversationOf(row.chat_slug, row.request_message_id)
      ?? row.session_id.slice(`mail:${row.chat_slug}:`.length);

  /** Record the answer's Message-ID in its conversation. */
  const recordMessageId = (row: AnswerRow, message_id: string): void => {
    conversations.record(row.chat_slug, message_id, conversationOf(row), 'answer', now());
    update(row.answer_id, { recorded_message_id: message_id });
  };

  const markSent = (row: AnswerRow, provider_id: string | undefined, sent_at: number): void => {
    const rfc = rfcMessageIdOf(provider_id);
    update(row.answer_id, {
      state: 'sent',
      reason: null,
      sent_at,
      sent_message_id: provider_id ?? null,
      settled_at: now(),
      // Gmail's send returns its own id: the Sent copy is asked for the Message-ID.
      record_state: rfc === undefined ? 'waiting' : 'recorded',
      record_next_at: rfc === undefined ? now() : null,
    });
    if (rfc !== undefined) recordMessageId(row, rfc);
    log?.('info', 'chat mailbox answer sent', { chat_slug: row.chat_slug, attempts: row.attempts });
  };

  /** The answer's own envelope, fixed at its first attempt: its request's,
   *  shared by every answer to it. `null` when the request is no longer known. */
  const envelopeOf = (row: AnswerRow, chat: MailChatAnswersMailbox): Envelope | null => {
    if (row.envelope_json !== null) return JSON.parse(row.envelope_json) as Envelope;
    const kept = selectEnvelope.get(row.chat_slug, row.request_message_id) as { envelope_json: string } | undefined;
    if (kept !== undefined) {
      update(row.answer_id, { envelope_json: kept.envelope_json });
      return JSON.parse(kept.envelope_json) as Envelope;
    }
    const request = requests.get(row.chat_slug, row.request_message_id);
    if (request === null) return null;
    const email = chat.get(request.record_id);
    const subject = typeof email?.hot_fields.subject === 'string'
      ? email.hot_fields.subject
      : chatStore.getSession(row.session_id)?.title ?? '';
    const thread = email?.hot_fields.thread_id;
    const envelope: Envelope = {
      to: request.from_address,
      subject: mailChatAnswerSubject(subject),
      in_reply_to: `<${row.request_message_id}>`,
      references: mailChatAnswerReferences(request.references, row.request_message_id),
      // Gmail's thread alone: it is what the thread argument means, and other
      // providers' thread ids need not pass for one.
      ...(typeof thread === 'string' && thread !== '' && chat.provider?.kind === 'gmail' ? { thread_id: thread } : {}),
    };
    const json = JSON.stringify(envelope);
    insertEnvelope.run(row.chat_slug, row.request_message_id, json, now());
    update(row.answer_id, { envelope_json: json });
    return envelope;
  };

  /** The Sent record's word on an answer: its match, or `null`. */
  const lookUp = async (row: AnswerRow, chat: MailChatAnswersMailbox, envelope: Envelope) => {
    const sent_after = (row.first_attempt_at ?? row.created_at) - MAIL_CHAT_ANSWER_LOOKUP_SKEW_MS;
    const result = await chat.lookupSentByReconciliationId({
      proof_kind: 'envelope',
      reconciliation_id: mailChatAnswerReconciliationId(row.answer_id),
      recipient: envelope.to,
      subject: envelope.subject,
      sent_after,
      sent_before: sent_after + MAIL_CHAT_ANSWER_GIVE_UP_MS,
    });
    if (result.status !== 'matched') return null;
    // The claim takes the provider's word; a claim already settled stays so.
    if (claims !== undefined) {
      try {
        const claim = claims.get(mailChatAnswerReconciliationId(row.answer_id));
        if (claim !== null) {
          claims.settle({
            reconciliation_id: claim.reconciliation_id, expected_revision: claim.revision, result, now: now(),
          });
        }
      } catch { /* the answer is sent either way */ }
    }
    return result.match;
  };

  const readAnswer = async (row: AnswerRow) => {
    const page = await chatStore.listMessagePage(row.session_id, 1, undefined, { around_message_id: row.answer_id });
    return page.messages.find((message) => message.id === row.answer_id);
  };

  const attempt = async (row: AnswerRow): Promise<void> => {
    // Not sent within a day — the server off, the vault locked: given up, never
    // sent late.
    if (now() - row.created_at >= MAIL_CHAT_ANSWER_GIVE_UP_MS) {
      settleUnsent(row, 'failed', 'not sent within a day');
      return;
    }
    if (!door.isChatMailbox(row.chat_slug)) {
      settleUnsent(row, 'dropped', 'the door no longer names this chat mailbox');
      return;
    }
    const chat = mailboxes().find((entry) => entry.platform === 'mail' && entry.slug === row.chat_slug);
    // At boot the chat mailbox may not be registered yet.
    if (chat === undefined) {
      retryLater(row, 'the chat mailbox is not connected');
      return;
    }
    const envelope = envelopeOf(row, chat);
    if (envelope === null) {
      settleUnsent(row, 'failed', 'the request is no longer known');
      return;
    }
    // An attempt that may have gone: the Sent record decides first.
    if (row.state === 'unknown') {
      const match = await lookUp(row, chat, envelope);
      if (match !== null) {
        markSent(row, match.provider_message_id, match.sent_at);
        return;
      }
    }
    const message = await readAnswer(row);
    if (message === undefined) {
      settleUnsent(row, 'dropped', 'the answer was deleted');
      return;
    }
    // Part 2 — the runs it names, whose result may follow after an approval.
    followUps.watch(message, now());
    const body = mailChatAnswerBody(message, deps.publicBaseUrl?.() ?? null);
    if (body.length === 0) {
      settleUnsent(row, 'dropped', 'the answer is empty');
      return;
    }
    const attempts = row.attempts + 1;
    const first_attempt_at = row.first_attempt_at ?? now();
    const withThread = envelope.thread_id !== undefined && row.thread_dropped === 0;
    update(row.answer_id, { state: 'sending', attempts, first_attempt_at });
    const current: AnswerRow = { ...row, state: 'sending', attempts, first_attempt_at };
    const reconciliation_id = mailChatAnswerReconciliationId(row.answer_id);
    let result: Awaited<ReturnType<MailChatAnswersMailbox['send']>>;
    try {
      result = await chat.send({
        to: [envelope.to],
        subject: envelope.subject,
        body_text: body,
        in_reply_to: envelope.in_reply_to,
        references: [...envelope.references],
        reconciliation_id,
        ...(withThread ? { thread_id: envelope.thread_id } : {}),
        automatic: true,
        // The owner may change the chat mailbox while the send is prepared.
        before_dispatch: () => {
          if (!door.isChatMailbox(row.chat_slug)) throw new DoorChangedError('the door changed');
        },
      });
    } catch (error) {
      if (error instanceof DoorChangedError) {
        settleUnsent(current, 'dropped', 'the door no longer names this chat mailbox');
        return;
      }
      const code = error instanceof IngredientError ? error.code : 'UNKNOWN';
      // Refused for what it is, before anything was sent: trying again sends
      // the same envelope, refused the same way. The provider's own word for
      // it is `MAIL_SEND_MESSAGE_REFUSED` (live, 2026-10-15: Graph refused the
      // answers' In-Reply-To, and each was to be retried for a day).
      if (code === 'BAD_INPUT' || code === 'MAIL_SEND_MESSAGE_REFUSED') {
        settleUnsent(current, 'failed', `refused: ${error instanceof Error ? error.message : code}`);
        return;
      }
      const notSent = error instanceof IngredientError && error.details?.not_sent === true;
      if (notSent) {
        // The provider refused it: nothing went, and the next attempt may send.
        // A refusal of a send into a thread may be the thread's (deleted, say):
        // the next attempt goes without it.
        retryLater(current, code, { state: 'pending', ...(withThread ? { thread_dropped: 1 } : {}) });
        return;
      }
      // Refused before the claim, or the claim says nothing went: try again.
      const claim = claims?.get(reconciliation_id);
      if (claim === null || claim?.status === 'not_sent' || claim?.status === 'released') {
        retryLater(current, code, { state: 'pending' });
        return;
      }
      // It may have gone. The Sent record, or the owner, settles it; nothing is
      // sent again before then.
      retryLater(current, code, { state: 'unknown' });
      if (askOwner !== undefined) {
        try { await askOwner(reconciliation_id); } catch { /* asked again at the next attempt */ }
      }
      return;
    }
    markSent(current, result.message_id, result.sent_at);
  };

  /** Look for a sent answer's Sent copy, to record its Message-ID. */
  const record = async (row: AnswerRow): Promise<void> => {
    const chat = mailboxes().find((entry) => entry.platform === 'mail' && entry.slug === row.chat_slug);
    const envelope = row.envelope_json === null ? null : JSON.parse(row.envelope_json) as Envelope;
    const match = chat !== undefined && envelope !== null ? await lookUp(row, chat, envelope) : null;
    const message_id = match === null ? undefined : normalizeRfcMessageId(match.provider_message_id);
    if (message_id !== undefined) {
      recordMessageId(row, message_id);
      update(row.answer_id, { record_state: 'recorded', record_next_at: null });
      return;
    }
    const record_attempts = row.record_attempts + 1;
    if (now() - (row.sent_at ?? row.created_at) >= MAIL_CHAT_ANSWER_RECORD_WAIT_MS) {
      // A reply still names the request in its References, which continues the
      // conversation; only a mail app writing In-Reply-To alone would not.
      update(row.answer_id, { record_state: 'gave_up', record_attempts, record_next_at: null });
      log?.('warn', 'chat mailbox answer: its Sent copy was not found to record its Message-ID', {
        chat_slug: row.chat_slug,
      });
      return;
    }
    update(row.answer_id, {
      record_attempts,
      record_next_at: now() + after(MAIL_CHAT_ANSWER_RECORD_RETRY_MS, record_attempts),
    });
  };

  /** D-308's order: the history row under a fixed id, then the mark, then the push. */
  const deliverNotices = async (): Promise<void> => {
    if (notify === undefined) return;
    for (const row of selectNoticesDue.all() as AnswerRow[]) {
      if (disposed) return;
      const message = JSON.parse(row.notice_json ?? 'null') as NotificationMessage | null;
      if (message === null) {
        markNoticeSent.run(row.answer_id);
        continue;
      }
      const persisted_activity_id = `mail-chat-answer:${createHash('sha256').update(row.answer_id).digest('hex').slice(0, 32)}`;
      if (auditLog !== undefined) {
        try {
          await auditLog.logActivity({
            activity_id: persisted_activity_id,
            timestamp: row.notice_at ?? now(),
            action: 'notification_fired',
            target: 'mail_chat_door',
            detail: JSON.stringify(message),
          });
        } catch (error) {
          log?.('warn', 'chat mailbox answer notice: the history row failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      markNoticeSent.run(row.answer_id);
      try {
        await (auditLog !== undefined ? notify(message, { persisted_activity_id }) : notify(message));
      } catch { /* best-effort: the notice is marked given */ }
    }
  };

  const writeFollowUps = async (): Promise<number> => {
    try {
      return await followUps.writeDue(now());
    } catch (error) {
      log?.('warn', 'chat mailbox follow-up could not be written', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  };

  const runRound = async (): Promise<void> => {
    do {
      again = false;
      // The answers are encrypted, and the mailboxes' keys are in the vault.
      if (deps.isUnlocked !== undefined && !deps.isUnlocked()) {
        locked = true;
        return;
      }
      locked = false;
      for (const row of selectDue.all(now()) as AnswerRow[]) {
        if (disposed) return;
        try {
          await attempt(row);
        } catch (error) {
          // A read that failed (the store, a lookup): nothing was sent.
          log?.('warn', 'chat mailbox answer attempt failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          const fresh = read(row.answer_id);
          if (fresh !== undefined && (fresh.state === 'pending' || fresh.state === 'unknown')) {
            retryLater(fresh, 'unavailable');
          }
        }
      }
      for (const row of selectRecordDue.all(now()) as AnswerRow[]) {
        if (disposed) return;
        try {
          await record(row);
        } catch (error) {
          log?.('warn', 'chat mailbox answer: its Sent copy could not be looked up', {
            error: error instanceof Error ? error.message : String(error),
          });
          update(row.answer_id, { record_next_at: now() + MAX_SLEEP_MS });
        }
      }
      if (disposed) return;
      // Part 2 — each follow-up whose run has settled and is watched (an
      // answer read above may have just watched it): an answer owed, sent in
      // the next pass.
      if (await writeFollowUps() > 0) again = true;
      await deliverNotices();
      prune.run(now() - MAIL_CHAT_ANSWER_KEEP_MS);
      pruneEnvelopes.run(now() - MAIL_CHAT_ENVELOPE_KEEP_MS);
      followUps.prune(now());
    } while (again && !disposed);
  };

  const tick = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (running !== undefined) {
      again = true;
      return running;
    }
    // ⛔ A ROUND NEVER REJECTS: every caller leaves its promise unhandled, and
    // the server treats an unhandled rejection as fatal (the audit).
    running = runRound()
      .catch((error: unknown) => {
        log?.('warn', 'chat mailbox answers round failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = undefined;
        try {
          schedule();
        } catch (error) {
          log?.('warn', 'chat mailbox answers could not be scheduled', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return running;
  };

  /** Sleep until the next answer is due; with none, look again soon. Locked,
   *  never at once: the round would only find the vault locked again (the
   *  audit measured 389 wake-ups in half a second). */
  function schedule(): void {
    if (!started || disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    const next = (selectNextDue.get() as { at: number | null }).at;
    const wait = locked || next === null ? IDLE_POLL_MS : Math.max(0, Math.min(next - now(), MAX_SLEEP_MS));
    timer = setTimeout(() => {
      timer = undefined;
      void tick();
    }, wait);
    timer.unref?.();
  }

  return {
    tick,
    kick(): void {
      if (started && !disposed) void tick();
    },
    onRunSettled(settled): void {
      try {
        if (disposed) return;
        // Kept here, or already by the recorder the server listens with from
        // boot (`recordMailChatSettledRun`): either way, its follow-up is due.
        const kept = followUps.settled(settled, now());
        if ((kept || mailChatRunFromTheEmailDoor(settled)) && started) void tick();
      } catch (error) {
        log?.('warn', 'chat mailbox: a settled run could not be recorded', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    bindNotify(fn): void {
      notify = fn;
      if (started) void tick();
    },
    start(): void {
      if (started || disposed) return;
      started = true;
      // A stop mid-send: whether it went is for the Sent record to say.
      recoverSending.run();
      void tick();
    },
    async dispose(): Promise<void> {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
    get(answer_id): MailChatAnswer | null {
      const row = read(answer_id);
      if (row === undefined) return null;
      return {
        answer_id: row.answer_id,
        session_id: row.session_id,
        turn_id: row.turn_id,
        chat_slug: row.chat_slug,
        request_message_id: row.request_message_id,
        state: row.state,
        attempts: row.attempts,
        reason: row.reason,
        message_id: row.recorded_message_id,
        reconciliation_id: mailChatAnswerReconciliationId(row.answer_id),
      };
    },
    ofRequest(chat_slug, request_message_id) {
      const row = selectOfRequest.get(chat_slug, request_message_id) as Pick<AnswerRow, 'state' | 'sent_at'> | undefined;
      return row === undefined ? null : { state: row.state, sent_at: row.sent_at };
    },
  };
};
