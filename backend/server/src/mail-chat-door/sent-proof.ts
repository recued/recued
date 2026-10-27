/** D-318 step 2 — proof (a): a message in the chat mailbox is the owner's only
 *  when the owner's own mailbox SENT it.
 *
 *  Anyone can write to the chat mailbox and put the owner's address in a From
 *  line, so arriving there proves nothing (§4.2). What proves it is the owner's
 *  own Sent record: the same message (its RFC Message-ID) in the Sent record of
 *  a mailbox Recued reads, which only something holding that account can add
 *  to. Each mailbox is ASKED at its provider (`lookupSentByMessageId`: Gmail's
 *  `SENT` label, the IMAP Sent folder, Graph's `sentitems`).
 *
 *  ⛔ A LOOKUP, NOT A SYNCED SENT FOLDER. The spec first said switching the
 *  door on adds Sent to an IMAP or Graph mailbox's synced folders. A mailbox's
 *  "first backfill done" mark is the MAILBOX's, not the folder's
 *  (`collection_instances.backfill_complete`), so a folder added later brings
 *  its whole backfill window in as first sightings after the backfill — news:
 *  every mail recipe and mail fact would fire on months of old sent mail. A
 *  lookup reads one message and stores nothing.
 *
 *  A request is proven when a Sent message with exactly its Message-ID was
 *  sent To the chat mailbox, within a day of when the chat mailbox's provider
 *  received it. The time is what refuses a replay: a copy of an old request
 *  under its old Message-ID finds an old Sent record. The first copy of a
 *  Message-ID to land is the request, whatever became of it; any later copy is
 *  not looked at, and two copies before the check refuse both (the audit).
 *
 *  ⛔ ONLY THE MAILBOXES THE OWNER NAMED (`owner_mailboxes`, the audit). A
 *  shared support@ box or an assistant's, connected for recipes, is not the
 *  owner: whoever sends from it must not start a turn with the owner's
 *  authority. None named ⇒ nothing is proven.
 *
 *  ⛔ AND THE COPY ITSELF MUST COME FROM THE OWNER'S SERVERS (the audit). The
 *  Sent record proves the owner sent a message with this Message-ID, not that
 *  this copy is it: whoever reads the request on its way (an app with read
 *  access to the owner's mail, a relay) can deliver another copy under the same
 *  id first. The chat mailbox's provider's DMARC verdict for the From domain is
 *  read as the copy lands, and a `fail` is refused (`unauthenticated`). A domain
 *  that publishes no DMARC policy, or a chat mailbox whose server stamps
 *  nothing, gives no verdict, and the Sent record alone decides.
 *
 *  ⚠ THE SENT COPY CAN LAG. A mail app saves it a moment after sending, so a
 *  request not found is asked again — for ten minutes from its arrival — and
 *  only then given up, with one notice to the owner (at most one an hour, so
 *  forged mail cannot flood them). A mailbox that cannot be asked is asked
 *  again in the same way; neither ever reads as "not sent".
 *
 *  ⚠ WHOSE A MESSAGE IS, IS DECIDED WHEN IT IS CHECKED, not when it lands: at
 *  boot the chat mailbox can sync before the owner's mailbox is registered, and
 *  a request sent while the server was off would then look like a stranger's.
 *  So every candidate is recorded, and a stranger's is set aside at its check,
 *  silently.
 *
 *  Nothing is checked or handed over while the vault is locked, and every wait
 *  starts again when it opens.
 *
 *  Durable: a request survives a restart (`mail_chat_requests`), and a notice
 *  decided but not yet delivered is delivered at the next start — the history
 *  row first, under a fixed id, then the push (D-308's order).
 *
 *  Step 3 — a proven request is HANDED OVER to chat (`bindAdmit`), and the
 *  hand-over is durable too: recorded (`admit_state`), tried again after a
 *  failure or a restart, and given up an hour after the proof, with one notice.
 *  Chat's admission is idempotent (the request names its own submission), so a
 *  hand-over repeated after a crash adds nothing. The request carries the
 *  Message-IDs it refers to, read from its headers as it lands: they are gone
 *  from memory by the time it is proven, and they decide its conversation.
 *
 *  Step 6 — ⛔ THE BURST GUARD (§4.9, P15). More than `MAIL_CHAT_BURST_MAX`
 *  proven requests reaching the chat mailbox within `MAIL_CHAT_BURST_WINDOW_MS`
 *  pause the door: a mail rule, a script, a mail app sending its outbox again —
 *  never a person writing. Nothing more is handed over until the owner resumes
 *  it, and they are told once. Only PROVEN requests count, so a stranger who
 *  knows the address cannot pause it; so the first of a burst may have run by
 *  the time it pauses. A request found by a recovery scan is recorded as such
 *  (`recovered`), and its turn answers it in one line (`turns.ts`).
 *
 *  ONE MAILBOX (2026-10-18, §8.18) — the chat mailbox is one of the owner's
 *  own too, and they write to it from itself. Proof (a) is unchanged: its own
 *  Sent record, asked at its provider, proves the email theirs. What changes is
 *  which copy is the request, since the provider files an email to oneself as
 *  sent:
 *  - ⛔ Gmail keeps it as ONE message, labelled `SENT` and `INBOX` — outbound.
 *    Skipped as "what the chat mailbox itself sent", every request would be lost;
 *    so with one mailbox a Gmail chat mailbox's outbound email to itself is
 *    the request.
 *  - Outlook and an IMAP server deliver a copy to the inbox, and the Sent copy
 *    is another message under the same Message-ID. Where the Sent folder is
 *    synced too (one-address notifications need it, D-158), the two copies
 *    would refuse each other as `duplicate`. The Sent copy is the owner's own
 *    record — only the account adds to it — so it is noted as it lands
 *    (`mail_chat_sent_copies`), never a request, and left out of the copies
 *    counted.
 *  - Only an email to the chat mailbox ALONE can be a request: its address is
 *    the owner's own, and mail to them and someone else is mail to that
 *    someone. The `ask:` filter is always on (the store keeps it so).
 *  - An email the proof does not prove the owner's is their mail again: the
 *    composition takes the conversation's mark off its row (`onNotProven`),
 *    which an email delivered to the chat mailbox carried on its provider's
 *    word (`conversation-mail.ts`), and the next sync does not put it back
 *    (`refuted`).
 *
 *  Spec: D-318 §4.2, §4.9, §4.13, §8 steps 2, 3 and 6, §8.18. */

import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';
import {
  isMailChatOneMailbox,
  isMailReconciliationId,
  MAIL_CHAT_BURST_MAX,
  MAIL_CHAT_BURST_WINDOW_MS,
  type MailSentByMessageIdResult,
} from '@recued/contracts';
import { extractAskId, type NotificationMessage } from '@recued/notification';
import type { AuditLogStore } from '@recued/storage';

import type { MailCollection, MailStoredContext, MailUpsertContext } from '../collections/mail/mail-collection.js';
import { senderCheckFor } from '../collections/mail/authentication-results.js';
import { normalizeRfcMessageId, type CanonicalMessage } from '../collections/mail/provider.js';
import { collectionTableName } from '../collections/table.js';
import { PUSH_GRACE_MS, settleWithin, STOP_GRACE_MS } from '../lifecycle/settle-within.js';
import type { MailChatDoorStore } from '../storage/mail-chat-door-store.js';
import { mailChatReferences, type MailChatConversations } from './conversations.js';
import { automaticMailSign, subjectAsks, subjectIsForward } from './filters.js';
import { isAttachedEmail, mailChatTurnFiles, type MailChatTurnFile } from './attachments.js';
import { mailChatHtmlOwnText, type MailChatHtmlCut } from './html-text.js';
import { mailChatEnrolOutcome, mailChatSameChecker } from './enrolment.js';

/** How long a request waits for its Sent copy, from when Recued stored it. */
export const MAIL_CHAT_PROOF_WAIT_MS = 10 * 60_000;
/** The wait before each look after the first; the last repeats. */
export const MAIL_CHAT_PROOF_RETRY_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 180_000];
/** A Sent record further than this from the request's arrival is another message. */
export const MAIL_CHAT_PROOF_MAX_SEND_GAP_MS = 24 * 3_600_000;
/** At most one notice in this long. */
export const MAIL_CHAT_PROOF_NOTICE_INTERVAL_MS = 3_600_000;
/** Settled requests are kept this long, then removed. */
export const MAIL_CHAT_PROOF_KEEP_MS = 7 * 86_400_000;
/** Requests looked at in one round. */
export const MAIL_CHAT_PROOF_BATCH = 10;
/** The wait before each hand-over to chat after a failed one; the last repeats. */
export const MAIL_CHAT_ADMIT_RETRY_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 300_000];
/** A proven request chat could not take within this long is given up, with a notice. */
export const MAIL_CHAT_ADMIT_GIVE_UP_MS = 3_600_000;
/** Step 4 — how long a hand-over waits for the email's attachments to be
 *  stored. Past it, the request goes on without them, and the log says so. */
export const MAIL_CHAT_ATTACHMENTS_WAIT_MS = 5 * 60_000;
/** The longest the timer sleeps, so a clock change cannot strand a request. */
const MAX_SLEEP_MS = 60_000;
/** A reply waits this long between looks for the request it answers to reach
 *  chat first. */
const EARLIER_REQUEST_WAIT_MS = 5_000;
/** The owner's own text kept from an email's HTML, at most. */
const HTML_TEXT_MAX = 64 * 1024;

export type MailChatRequestState = 'pending' | 'proven' | 'not_proven' | 'ignored';

/** Why a request was not proven. Each gets a notice (within the cap). */
export type MailChatNotProvenReason =
  /** The owner's mailbox never showed it as sent within the wait. */
  | 'not_in_sent'
  /** A Sent message has its Message-ID, but was not sent to the chat mailbox,
   *  or not at the time it arrived: a copy of something the owner sent. */
  | 'mismatch'
  /** The owner's mailbox could not be asked within the wait. */
  | 'unreachable'
  /** The owner's mailbox's provider cannot be asked. */
  | 'unsupported'
  /** The chat mailbox holds more than one email with this Message-ID: a copy
   *  may be forged, and which one the owner sent cannot be told. */
  | 'duplicate'
  /** The chat mailbox's provider says it failed its DMARC check for the
   *  owner's domain: not the copy the owner's mail server sent. */
  | 'unauthenticated'
  /** Step 8 — from an enrolled address, without a passing check by the
   *  checker its code's email showed (`enrolment.ts`). */
  | 'unverified';

/** The chat mailbox's provider's word on an email's sender (its DMARC check for
 *  the From domain, as the email landed; where its stamp gives none, an SPF or
 *  DKIM pass for exactly that domain, step 8): `fail` refuses it; `unknown` —
 *  no stamp, a lookup error, nothing for that domain — proves nothing either
 *  way. A pass proves it only under (b), by the checker the address was
 *  enrolled with. */
export type MailChatSenderAuth = 'pass' | 'fail' | 'unknown';

/** Why a message was set aside without a check. Never a notice. */
export type MailChatIgnoredReason =
  /** From is not one of the owner's connected mailboxes: a stranger's. */
  | 'not_owner'
  /** The chat mailbox is not in To: a copy (P17). */
  | 'not_addressed'
  /** The door no longer names this chat mailbox. */
  | 'door_changed'
  /** The chat mailbox is not connected. */
  | 'no_chat_mailbox';

/** Where a proven request is with chat: `waiting` to be handed over,
 *  `admitted` (a turn is queued), `dropped` (chat refused it for good — the door
 *  changed, the email is gone), or `gave_up` (an hour of failures). */
export type MailChatAdmitState = 'waiting' | 'admitted' | 'dropped' | 'gave_up';

/** What chat did with a proven request. A failure that may pass is a throw. A
 *  request dropped with a `notice` is one the owner sent and would otherwise
 *  wait for in vain: they are told (at most one notice an hour, as ever). */
export type MailChatAdmitOutcome =
  | { readonly outcome: 'admitted' }
  | { readonly outcome: 'dropped'; readonly reason: string; readonly notice?: NotificationMessage };

export type MailChatAdmit = (request: MailChatRequest) => Promise<MailChatAdmitOutcome>;

export interface MailChatRequest {
  readonly chat_slug: string;
  readonly rfc_message_id: string;
  readonly record_id: string;
  /** The From address, bare and lower case. */
  readonly from_address: string;
  /** The Message-IDs it refers to, nearest first (`mailChatReferences`). */
  readonly references: readonly string[];
  readonly state: MailChatRequestState;
  readonly reason: MailChatNotProvenReason | MailChatIgnoredReason | null;
  /** The owner's mailbox whose Sent record proved it. */
  readonly proven_by: string | null;
  /** Step 8 — how it was proven: the owner's Sent record (a), or an enrolled
   *  address's passing check (b). `null` until proven. */
  readonly proof: 'sent_record' | 'enrolled' | null;
  readonly attempts: number;
  /** When Recued stored it. */
  readonly arrived_at: number;
  /** When the chat mailbox's provider received it, else `arrived_at`. */
  readonly received_at: number;
  /** `null` until it is proven. */
  readonly admit_state: MailChatAdmitState | null;
  /** Step 4 — the turn's files: its attachments and the inline images the
   *  owner's own text shows (`attachments.ts`). Empty until they are stored. */
  readonly files: readonly MailChatTurnFile[];
  /** The audit — the owner's own part of the email's HTML, as text, read as it
   *  landed (`html-text.ts`); `null` for an email without HTML. The HTML is
   *  gone by the hand-over: the sync keeps none. */
  readonly html_text: string | null;
  /** What the HTML's own part left out: quoted history, a signature, an
   *  attached email the parser wrote into it, or nothing. */
  readonly html_cut: MailChatHtmlCut;
  /** §8.12 — the email carries an email as a file: forwarded as an attachment. */
  readonly attached_email: boolean;
  /** Step 6 — the provider found it by a recovery scan, not as it arrived: it
   *  is answered in one line and never run (§4.8, P22). */
  readonly recovered: boolean;
  /** The audit — its DMARC check at the chat mailbox's provider. */
  readonly sender_auth: MailChatSenderAuth;
  /** Step 8 — who made that check: the stamp's authserv-id, `''` for one naming
   *  none (Microsoft's), `null` without a stamp. */
  readonly stamped_by: string | null;
}

/** Step 7 — a request as the proof holds it, with why chat did not take it:
 *  the test round trip shows how far it got (`collection.mail.chat_door.recent`). */
export interface MailChatRequestProgress extends MailChatRequest {
  readonly admit_reason: string | null;
}

/** The part of a mailbox the proof reads. */
export type MailChatProofMailbox = Pick<MailCollection, 'platform' | 'slug' | 'accountEmail' | 'lookupSentByMessageId'>;

/** The owner's notice. `extras` names its history row when the proof wrote
 *  one; without it the notifier writes the row itself. */
export type MailChatProofNotify = (
  message: NotificationMessage,
  extras?: { readonly persisted_activity_id: string },
) => Promise<void>;

export interface MailChatSentProofDeps {
  readonly db: Database.Database;
  /** Step 6 — the burst guard pauses it. Step 8 — an enrolment's code email
   *  settles it. */
  readonly door: Pick<MailChatDoorStore, 'isChatMailbox' | 'get' | 'pause' | 'settleEnrolment'>;
  /** Step 4 — the conversations a reply may continue without the `ask:`
   *  prefix. Absent ⇒ only a request still being checked counts. */
  readonly conversations?: Pick<MailChatConversations, 'find'>;
  /** Every connected mailbox, read at each check. */
  readonly mailboxes: () => readonly MailChatProofMailbox[];
  /** The notice's history row. Absent ⇒ the push alone. */
  readonly auditLog?: Pick<AuditLogStore, 'logActivity'>;
  /** The audit — checks pause while the vault is locked (the mailboxes' keys are
   *  in it), and the waits start again when it opens. Absent ⇒ never locked. */
  readonly isUnlocked?: () => boolean;
  /** One mailbox (§8.18) — an email of the chat mailbox settled as not the
   *  owner's request (not proven, or set aside), by its stored row. Called once,
   *  best-effort. Absent ⇒ nobody is told. */
  readonly onNotProven?: (chat_slug: string, record_id: string) => void;
  readonly now?: () => number;
  readonly log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
}

export interface MailChatSentProof {
  /** The mail stack's hook for a message that just landed, in any mailbox:
   *  one in the chat mailbox is recorded to be checked. Never throws. */
  onMessageStored(msg: CanonicalMessage, ctx: MailStoredContext): void;
  /** Step 4 — the mail stack's hook once a message's attachments are stored:
   *  a request's files are recorded, and its hand-over may go on. Never throws. */
  onMessageUpserted(msg: CanonicalMessage, ctx: MailUpsertContext): void;
  /** Check every request that is due, and deliver any notice that is due. */
  tick(): Promise<void>;
  /** Where a proven request goes: chat, which queues it as a turn (step 3).
   *  Until it is bound, proven requests wait. */
  bindAdmit(fn: MailChatAdmit): void;
  /** How the owner is told. Until it is bound, a notice waits. */
  bindNotify(fn: MailChatProofNotify): void;
  /** Start checking: after the mailboxes are registered and the notice bound. */
  start(): void;
  /** Stop checking, and wait for the round in progress at most `STOP_GRACE_MS`
   *  — `PUSH_GRACE_MS` while a notice push is in flight. Idempotent. */
  dispose(): Promise<void>;
  /** One request, for the tests and diagnostics. */
  get(chat_slug: string, rfc_message_id: string): MailChatRequest | null;
  /** Step 7 — a chat mailbox's latest requests, newest first. */
  recent(chat_slug: string, limit: number): MailChatRequestProgress[];
  /** Does an email referring to these Message-IDs (nearest first) continue a
   *  conversation of this chat mailbox — one chat has, or a request of it still
   *  on its way? One mailbox reads it to tell a reply from the owner's own mail
   *  (`conversation-mail.ts`). */
  continuesConversation(chat_slug: string, references: readonly string[]): boolean;
  /** Was the email with this Message-ID (bracketless) in this chat mailbox
   *  settled as not the owner's request: not proven, or set aside? */
  refuted(chat_slug: string, rfc_message_id: string): boolean;
}

interface RequestRow {
  chat_slug: string;
  rfc_message_id: string;
  record_id: string;
  from_address: string;
  to_json: string;
  arrived_at: number;
  received_at: number;
  state: MailChatRequestState;
  attempts: number;
  next_attempt_at: number | null;
  reason: string | null;
  proven_by: string | null;
  resolved_at: number | null;
  notice_state: 'none' | 'due' | 'sent' | 'suppressed';
  notice_at: number | null;
  notice_json: string | null;
  references_json: string;
  admit_state: MailChatAdmitState | null;
  admit_attempts: number;
  next_admit_at: number | null;
  admit_settled_at: number | null;
  admit_reason: string | null;
  attachments_json: string | null;
  attachments_known_at: number | null;
  html_text: string | null;
  html_cut: number;
  attached_email: number;
  recovered: number;
  sender_auth: string;
  stamped_by: string | null;
  proof: string | null;
}

/** `"Ann" <Ann@Example.com>` → `ann@example.com`. */
const bareAddress = (address: string): string => {
  const angled = /<([^<>]+)>/.exec(address);
  return (angled?.[1] ?? address).trim().toLowerCase();
};

/** A Message-ID as a mail app writes one: printable, no spaces or brackets, an
 *  `@`. Anything else is not looked up — the id goes into each provider's
 *  search, and a forged message chooses it. */
const plausibleMessageId = (id: string): boolean =>
  id.length <= 500 && /^[\x21-\x7e]+$/.test(id) && !/[<>]/.test(id) && id.includes('@');

/** `html_cut` as stored: 0 nothing, 1 quoted history, 2 a signature, 3 an
 *  attached email. Before §8.12 any cut was a 1, so a row from then reads as
 *  quoted history, the more careful reading; so does a code this build does
 *  not know. */
const HTML_CUT_CODES: Readonly<Record<MailChatHtmlCut, number>> = { none: 0, quote: 1, signature: 2, mail: 3 };
const htmlCutOf = (code: number): MailChatHtmlCut =>
  code === 0 ? 'none' : code === 2 ? 'signature' : code === 3 ? 'mail' : 'quote';

const toRequest = (row: RequestRow): MailChatRequest => ({
  chat_slug: row.chat_slug,
  rfc_message_id: row.rfc_message_id,
  record_id: row.record_id,
  from_address: row.from_address,
  references: JSON.parse(row.references_json) as string[],
  state: row.state,
  reason: row.reason as MailChatRequest['reason'],
  proven_by: row.proven_by,
  // A request proven before step 8 was proven by a Sent record.
  proof: row.proof === 'enrolled' ? 'enrolled' : row.state === 'proven' ? 'sent_record' : null,
  attempts: row.attempts,
  arrived_at: row.arrived_at,
  received_at: row.received_at,
  admit_state: row.admit_state,
  files: row.attachments_json === null ? [] : JSON.parse(row.attachments_json) as MailChatTurnFile[],
  html_text: row.html_text,
  html_cut: htmlCutOf(row.html_cut),
  attached_email: row.attached_email === 1,
  recovered: row.recovered === 1,
  sender_auth: row.sender_auth === 'pass' || row.sender_auth === 'fail' ? row.sender_auth : 'unknown',
  stamped_by: row.stamped_by,
});

/** What the owner is told. ⛔ Never the message's subject or text: a forged
 *  message writes those, and a notice speaks with Recued's voice. */
export const mailChatProofNotice = (
  reason: MailChatNotProvenReason,
  owner: string,
  chat: string,
): NotificationMessage => {
  const opening = `An email to your chat mailbox, ${chat}, says it is from ${owner}`;
  const ignored = 'so it was not answered and nothing was done.';
  switch (reason) {
    case 'not_in_sent':
      return {
        title: 'An email to your chat mailbox was not answered',
        text: `${opening}, but Recued did not find it in that mailbox's Sent folder, ${ignored} `
          + 'If you sent it, check that your mail app keeps what you send in the Sent folder, then send it again. '
          + 'If you did not, someone else wrote it.',
      };
    case 'mismatch':
      return {
        title: 'An email to your chat mailbox was not answered',
        text: `${opening}, but what that mailbox's Sent folder holds under the same message ID was not sent `
          + `to your chat mailbox at that time, ${ignored} It may be a copy of something you sent before.`,
      };
    case 'unreachable':
      return {
        title: 'An email to your chat mailbox was not answered',
        text: `${opening}, but Recued could not reach that mailbox to check its Sent folder, ${ignored} `
          + 'Check its connection in Settings, then send it again.',
      };
    case 'unsupported':
      return {
        title: 'An email to your chat mailbox was not answered',
        text: `${opening}, but Recued cannot check that mailbox's Sent folder, ${ignored}`,
      };
    case 'duplicate':
      return {
        title: 'An email to your chat mailbox was not answered',
        text: `${opening}, but the chat mailbox holds more than one email with the same message ID, ${ignored} `
          + 'One of them may be a copy someone else made. If you sent it, send it again.',
      };
    case 'unauthenticated':
      return {
        title: 'An email to your chat mailbox was not answered',
        text: `${opening}, but it failed the sender check (DMARC) where it arrived, ${ignored} `
          + 'Someone else may have written it. If you sent it, your mail provider may not be set up to '
          + 'sign mail from your domain: check its SPF and DKIM settings, then send it again.',
      };
    case 'unverified':
      return {
        title: 'An email to your chat mailbox was not answered',
        text: `${opening}, but your chat mailbox's provider did not confirm it came from that address's mail `
          + `servers, ${ignored} Someone else may have written it. If you sent it, send it again. If it is not `
          + 'answered again, remove the address in Settings → Email chat and add it again.',
      };
  }
};

/** What the owner is told when a proven request never reached chat. */
export const mailChatAdmitNotice = (owner: string, chat: string): NotificationMessage => ({
  title: 'An email to your chat mailbox was not answered',
  text: `An email to your chat mailbox, ${chat}, from ${owner} was checked and is yours, but Recued could `
    + 'not start a chat for it within an hour, so it was not answered. Send it again.',
});

/** Step 6 — what the owner is told when the burst guard pauses the door. Once:
 *  the door stays paused until they resume it. */
export const mailChatBurstNotice = (chat: string): NotificationMessage => ({
  title: 'Your email chat is paused',
  text: `More than ${MAIL_CHAT_BURST_MAX} of your emails reached your chat mailbox, ${chat}, within a minute, `
    + 'more than a person writes, so Recued paused the email chat. While it is paused, emails to it are not '
    + 'answered. A mail rule, a script, or a mail app sending its outbox again can do this. When it has '
    + 'stopped, resume it in Settings → Email chat.',
});

export const createMailChatSentProof = (deps: MailChatSentProofDeps): MailChatSentProof => {
  const { db, door, mailboxes, auditLog, log } = deps;
  const now = deps.now ?? Date.now;

  db.exec(`CREATE TABLE IF NOT EXISTS mail_chat_requests (
    chat_slug TEXT NOT NULL,
    rfc_message_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    from_address TEXT NOT NULL,
    to_json TEXT NOT NULL,
    arrived_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'proven', 'not_proven', 'ignored')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    reason TEXT,
    proven_by TEXT,
    resolved_at INTEGER,
    notice_state TEXT NOT NULL DEFAULT 'none' CHECK (notice_state IN ('none', 'due', 'sent', 'suppressed')),
    notice_at INTEGER,
    notice_json TEXT,
    references_json TEXT NOT NULL DEFAULT '[]',
    admit_state TEXT CHECK (admit_state IN ('waiting', 'admitted', 'dropped', 'gave_up')),
    admit_attempts INTEGER NOT NULL DEFAULT 0,
    next_admit_at INTEGER,
    admit_settled_at INTEGER,
    admit_reason TEXT,
    attachments_json TEXT,
    attachments_known_at INTEGER,
    html_text TEXT,
    html_cut INTEGER NOT NULL DEFAULT 0,
    attached_email INTEGER NOT NULL DEFAULT 0,
    recovered INTEGER NOT NULL DEFAULT 0,
    sender_auth TEXT NOT NULL DEFAULT 'unknown',
    stamped_by TEXT,
    proof TEXT,
    PRIMARY KEY (chat_slug, rfc_message_id)
  )`);
  // The table as step 2 made it: the hand-over's columns join it.
  const columns = new Set((db.prepare('PRAGMA table_info(mail_chat_requests)').all() as Array<{ name: string }>)
    .map((column) => column.name));
  for (const [name, type] of [
    ['references_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['admit_state', "TEXT CHECK (admit_state IN ('waiting', 'admitted', 'dropped', 'gave_up'))"],
    ['admit_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['next_admit_at', 'INTEGER'],
    ['admit_settled_at', 'INTEGER'],
    ['admit_reason', 'TEXT'],
    ['attachments_json', 'TEXT'],
    ['attachments_known_at', 'INTEGER'],
    ['html_text', 'TEXT'],
    ['html_cut', 'INTEGER NOT NULL DEFAULT 0'],
    ['attached_email', 'INTEGER NOT NULL DEFAULT 0'],
    ['recovered', 'INTEGER NOT NULL DEFAULT 0'],
    ['sender_auth', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['stamped_by', 'TEXT'],
    ['proof', 'TEXT'],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE mail_chat_requests ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS mail_chat_requests_due
    ON mail_chat_requests (state, next_attempt_at)`);
  // One mailbox (§8.18) — the owner's own Sent copies of an email to the chat
  // mailbox, as they landed in it (Outlook, IMAP): never a request, and not a
  // second copy of one.
  db.exec(`CREATE TABLE IF NOT EXISTS mail_chat_sent_copies (
    chat_slug TEXT NOT NULL,
    record_id TEXT NOT NULL,
    rfc_message_id TEXT NOT NULL,
    landed_at INTEGER NOT NULL,
    PRIMARY KEY (chat_slug, record_id)
  )`);

  const insert = db.prepare(`INSERT OR IGNORE INTO mail_chat_requests
    (chat_slug, rfc_message_id, record_id, from_address, to_json, references_json, arrived_at, received_at, state,
      next_attempt_at, html_text, html_cut, attached_email, recovered, sender_auth, stamped_by)
    VALUES (@chat_slug, @rfc_message_id, @record_id, @from_address, @to_json, @references_json, @arrived_at,
      @received_at, 'pending', @arrived_at, @html_text, @html_cut, @attached_email, @recovered, @sender_auth,
      @stamped_by)`);
  const selectOne = db.prepare('SELECT * FROM mail_chat_requests WHERE chat_slug = ? AND rfc_message_id = ?');
  const selectRecent = db.prepare(`SELECT * FROM mail_chat_requests WHERE chat_slug = ?
    ORDER BY arrived_at DESC, rowid DESC LIMIT ?`);
  const selectDue = db.prepare(`SELECT * FROM mail_chat_requests
    WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ${MAIL_CHAT_PROOF_BATCH}`);
  const selectNextDue = db.prepare(`SELECT MIN(next_attempt_at) AS at FROM mail_chat_requests WHERE state = 'pending'`);
  // A hand-over waits for the email's attachments to be stored, or for the
  // wait to pass.
  // The files wait counts from the later of its arrival and the start (or the
  // vault's opening): a restart's re-read stores them again.
  const selectAdmitDue = db.prepare(`SELECT * FROM mail_chat_requests
    WHERE state = 'proven' AND admit_state = 'waiting' AND next_admit_at <= @now
      AND (attachments_known_at IS NOT NULL OR MAX(arrived_at, @since) <= @now - ${MAIL_CHAT_ATTACHMENTS_WAIT_MS})
    ORDER BY arrived_at LIMIT ${MAIL_CHAT_PROOF_BATCH}`);
  const selectNextAdmit = db.prepare(`SELECT MIN(CASE WHEN attachments_known_at IS NULL
      THEN MAX(next_admit_at, MAX(arrived_at, @since) + ${MAIL_CHAT_ATTACHMENTS_WAIT_MS}) ELSE next_admit_at END) AS at
    FROM mail_chat_requests WHERE state = 'proven' AND admit_state = 'waiting'`);
  // A request's files come from its own email: another copy of its Message-ID
  // gives none.
  const selectFilesUnknown = db.prepare(`SELECT 1 FROM mail_chat_requests
    WHERE chat_slug = ? AND rfc_message_id = ? AND record_id = ? AND state IN ('pending', 'proven')
      AND attachments_known_at IS NULL`);
  const setFiles = db.prepare(`UPDATE mail_chat_requests SET attachments_json = @json,
      attachments_known_at = CASE WHEN @complete = 1 THEN @at ELSE NULL END
    WHERE chat_slug = @chat_slug AND rfc_message_id = @rfc_message_id AND record_id = @record_id
      AND attachments_known_at IS NULL`);
  // A reply waits while a request it refers to is still on its way to chat.
  const selectEarlierOnItsWay = db.prepare(`SELECT 1 FROM mail_chat_requests
    WHERE chat_slug = ? AND rfc_message_id = ? AND arrived_at <= ?
      AND (state = 'pending' OR (state = 'proven' AND admit_state = 'waiting'))`);
  const selectNoticesDue = db.prepare(`SELECT * FROM mail_chat_requests WHERE notice_state = 'due' ORDER BY notice_at`);
  const selectLastNotice = db.prepare(`SELECT MAX(notice_at) AS at FROM mail_chat_requests
    WHERE notice_state IN ('due', 'sent')`);
  const reschedule = db.prepare(`UPDATE mail_chat_requests SET attempts = @attempts, next_attempt_at = @next_attempt_at
    WHERE chat_slug = @chat_slug AND rfc_message_id = @rfc_message_id AND state = 'pending'`);
  const settle = db.prepare(`UPDATE mail_chat_requests
    SET state = @state, reason = @reason, proven_by = @proven_by, proof = @proof, attempts = @attempts,
        resolved_at = @resolved_at,
        next_attempt_at = NULL, notice_state = @notice_state, notice_at = @notice_at, notice_json = @notice_json,
        admit_state = @admit_state, next_admit_at = @next_admit_at
    WHERE chat_slug = @chat_slug AND rfc_message_id = @rfc_message_id AND state = 'pending'`);
  const admitRetry = db.prepare(`UPDATE mail_chat_requests SET admit_attempts = @attempts, next_admit_at = @at
    WHERE chat_slug = @chat_slug AND rfc_message_id = @rfc_message_id AND admit_state = 'waiting'`);
  const admitSettle = db.prepare(`UPDATE mail_chat_requests
    SET admit_state = @admit_state, admit_reason = @admit_reason, admit_attempts = @attempts, next_admit_at = NULL,
        admit_settled_at = @at, notice_state = @notice_state, notice_at = @notice_at, notice_json = @notice_json
    WHERE chat_slug = @chat_slug AND rfc_message_id = @rfc_message_id AND admit_state = 'waiting'`);
  const markNoticeSent = db.prepare(`UPDATE mail_chat_requests SET notice_state = 'sent'
    WHERE chat_slug = ? AND rfc_message_id = ? AND notice_state = 'due'`);
  const selectLiveRequest = db.prepare(`SELECT 1 FROM mail_chat_requests
    WHERE chat_slug = ? AND rfc_message_id = ? AND state IN ('pending', 'proven')`);
  // Step 6 — the burst guard counts proven requests only: a stranger's cannot
  // pause the door.
  const selectBurst = db.prepare(`SELECT COUNT(*) AS n FROM mail_chat_requests
    WHERE chat_slug = @chat_slug AND state = 'proven' AND arrived_at BETWEEN @from AND @to`);
  const prune = db.prepare(`DELETE FROM mail_chat_requests
    WHERE state != 'pending' AND notice_state != 'due' AND admit_state IS NOT 'waiting' AND resolved_at < ?`);
  const insertSentCopy = db.prepare(`INSERT OR IGNORE INTO mail_chat_sent_copies
    (chat_slug, record_id, rfc_message_id, landed_at) VALUES (?, ?, ?, ?)`);
  const selectSentCopies = db.prepare(`SELECT record_id FROM mail_chat_sent_copies
    WHERE chat_slug = ? AND rfc_message_id = ?`);
  const pruneSentCopies = db.prepare('DELETE FROM mail_chat_sent_copies WHERE landed_at < ?');

  let admit: MailChatAdmit | undefined;
  let notify: MailChatProofNotify | undefined;
  let started = false;
  /** When checking started: a request left waiting by the last run gets a
   *  full wait from here, not from when it arrived. */
  let startedAt: number | undefined;
  /** When the vault last opened after checks paused for it: waits count from
   *  here too, as they do from the start. */
  let resumedAt: number | undefined;
  let locked = false;
  /** The later of the start and the vault's opening. */
  const since = (): number => Math.max(startedAt ?? 0, resumedAt ?? 0);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  /** A notice push in flight, after its mark (`dispose`). */
  let pushing: Promise<void> | undefined;
  let again = false;

  const retry = (row: RequestRow, attempts: number, at: number): void => {
    reschedule.run({ chat_slug: row.chat_slug, rfc_message_id: row.rfc_message_id, attempts, next_attempt_at: at });
  };

  /** A notice now, or held back: at most one in `MAIL_CHAT_PROOF_NOTICE_INTERVAL_MS`
   *  — except one that must not wait (`always`): the door paused, which needs
   *  the owner's word, and comes from their own mail only. */
  const noticeColumns = (at: number, notice: NotificationMessage | undefined, always = false) => {
    let notice_state: RequestRow['notice_state'] = 'none';
    if (notice !== undefined) {
      const last = (selectLastNotice.get() as { at: number | null }).at;
      notice_state = !always && last !== null && at - last < MAIL_CHAT_PROOF_NOTICE_INTERVAL_MS ? 'suppressed' : 'due';
    }
    return {
      notice_state,
      notice_at: notice_state === 'none' ? null : at,
      notice_json: notice_state === 'due' && notice !== undefined ? JSON.stringify(notice) : null,
    };
  };

  const settleRow = (
    row: RequestRow,
    state: Exclude<MailChatRequestState, 'pending'>,
    reason: MailChatRequest['reason'],
    attempts: number,
    extra: { proven_by?: string; proof?: 'sent_record' | 'enrolled'; notice?: NotificationMessage } = {},
  ): boolean => {
    const at = now();
    const notice = noticeColumns(at, extra.notice);
    const { notice_state } = notice;
    const changed = settle.run({
      chat_slug: row.chat_slug,
      rfc_message_id: row.rfc_message_id,
      state,
      reason,
      proven_by: extra.proven_by ?? null,
      proof: state === 'proven' ? extra.proof ?? 'sent_record' : null,
      attempts,
      resolved_at: at,
      ...notice,
      // A proven request waits to be handed to chat, from now.
      admit_state: state === 'proven' ? 'waiting' : null,
      next_admit_at: state === 'proven' ? at : null,
    }).changes > 0;
    if (changed && state !== 'proven') {
      log?.(state === 'ignored' ? 'info' : 'warn', `chat mailbox message ${state === 'ignored' ? 'set aside' : 'not proven the owner\'s'}`, {
        chat_slug: row.chat_slug,
        reason,
        ...(notice_state === 'suppressed' ? { notice: 'held back: one was given within the hour' } : {}),
      });
      try {
        deps.onNotProven?.(row.chat_slug, row.record_id);
      } catch (error) {
        log?.('warn', 'chat mailbox: the email not proven could not be given back to the owner\'s mail', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return changed;
  };

  /** ⛔ THE STORED COPIES OF A MESSAGE-ID IN THE CHAT MAILBOX, in the order they
   *  landed (the table's rowid: an upsert keeps it). A request is the FIRST copy
   *  only, whatever else landed — the audit found the rule held only for copies
   *  that had been recorded: a copy the filters set aside (no `ask:`) recorded
   *  nothing, and a forged copy with the same Message-ID and an `ask:` subject
   *  was then proven by the owner's real Sent record. Never the Date line, which
   *  the sender writes. One mailbox: the owner's own Sent copy of it, noted as
   *  it landed, is not another copy. */
  const storedCopies = (chat_slug: string, rfc_message_id: string): string[] => {
    try {
      const sent = new Set((selectSentCopies.all(chat_slug, rfc_message_id) as Array<{ record_id: string }>)
        .map((row) => row.record_id));
      return (db.prepare(`SELECT record_id FROM "${collectionTableName('mail', chat_slug)}"
        WHERE json_extract(hot_fields, '$.rfc_message_id') = ? ORDER BY rowid`).all(rfc_message_id) as Array<{
        record_id: string;
      }>).map((row) => row.record_id).filter((record_id) => !sent.has(record_id));
    } catch {
      return [];
    }
  };

  /** Does an email continue a conversation — one chat has, or a request of it
   *  still being checked? A reply can then leave out the `ask:` prefix. */
  const continuesConversation = (chat_slug: string, references: readonly string[]): boolean =>
    references.length > 0 && (
      (deps.conversations?.find(chat_slug, references) ?? null) !== null
      || references.some((id) => selectLiveRequest.get(chat_slug, id) !== undefined)
    );

  /** Step 8 — proof (b). ⛔ A pass counts only from the provider the address
   *  was enrolled with (any of its hosts): a stamp by anyone else on top is a
   *  server that does not stamp, or mail that came another way, and a sender
   *  writes those. */
  const proveEnrolled = (row: RequestRow, checked_by: string | null, attempts: number, chatAddress: string): void => {
    if (row.sender_auth === 'fail') {
      settleRow(row, 'not_proven', 'unauthenticated', attempts,
        { notice: mailChatProofNotice('unauthenticated', row.from_address, chatAddress) });
      return;
    }
    if (!mailChatSameChecker(row.stamped_by, checked_by) || row.sender_auth !== 'pass') {
      settleRow(row, 'not_proven', 'unverified', attempts,
        { notice: mailChatProofNotice('unverified', row.from_address, chatAddress) });
      return;
    }
    if (settleRow(row, 'proven', null, attempts, { proof: 'enrolled' })) {
      log?.('info', 'chat mailbox request proven by an enrolled address\'s sender check', { chat_slug: row.chat_slug });
    }
  };

  /** One request: whose it is, then each of the owner's mailboxes asked. */
  const check = async (row: RequestRow): Promise<void> => {
    const attempts = row.attempts + 1;
    if (!door.isChatMailbox(row.chat_slug)) {
      settleRow(row, 'ignored', 'door_changed', row.attempts);
      return;
    }
    const all = mailboxes().filter((mailbox) => mailbox.platform === 'mail');
    const chat = all.find((mailbox) => mailbox.slug === row.chat_slug);
    const chatAddress = bareAddress(chat?.accountEmail ?? '');
    const deadline = Math.max(row.arrived_at, since()) + MAIL_CHAT_PROOF_WAIT_MS;
    if (chat === undefined) {
      // Not registered yet, or gone: asked again until the wait is over.
      if (now() >= deadline) settleRow(row, 'ignored', 'no_chat_mailbox', row.attempts);
      else retry(row, row.attempts, Math.min(now() + MAX_SLEEP_MS, deadline));
      return;
    }
    const to = JSON.parse(row.to_json) as string[];
    if (!chatAddress.includes('@') || !to.includes(chatAddress)) {
      settleRow(row, 'ignored', 'not_addressed', row.attempts);
      return;
    }
    // Another copy of its Message-ID landed meanwhile: which one the owner sent
    // cannot be told, and a forger can make one.
    if (storedCopies(row.chat_slug, row.rfc_message_id).length > 1) {
      settleRow(row, 'not_proven', 'duplicate', attempts,
        { notice: mailChatProofNotice('duplicate', row.from_address, chatAddress) });
      return;
    }
    // Only the mailboxes the owner named as theirs: whoever can send from
    // another connected mailbox (a shared support@, an assistant's) is not the
    // owner. With one mailbox (§8.18) the chat mailbox is among them, and its
    // own Sent record proves an email the owner wrote to themselves.
    const named = door.get().owner_mailboxes;
    const owners = all.filter((mailbox) =>
      named.includes(mailbox.slug) && bareAddress(mailbox.accountEmail) === row.from_address);
    if (!row.from_address.includes('@') || owners.length === 0) {
      // Step 8 — proof (b): an address the owner enrolled, held to the checker
      // its code's email showed.
      const enrolled = door.get().enrolled_senders.find((sender) => sender.state === 'confirmed'
        && sender.address === row.from_address && sender.chat_mailbox === row.chat_slug);
      if (enrolled !== undefined) {
        proveEnrolled(row, enrolled.checked_by, attempts, chatAddress);
        return;
      }
      // One of the owner's mailboxes not running (signing in again, failing):
      // it may be this one, so asked again until the wait is over.
      const absent = named.filter((slug) => !all.some((mailbox) => mailbox.slug === slug));
      if (row.from_address.includes('@') && absent.length > 0) {
        if (now() < deadline) {
          retry(row, attempts, Math.min(now() + MAX_SLEEP_MS, deadline));
          return;
        }
        settleRow(row, 'not_proven', 'unreachable', attempts,
          { notice: mailChatProofNotice('unreachable', row.from_address, chatAddress) });
        return;
      }
      if (named.length === 0) {
        log?.('warn', 'chat mailbox request set aside: no mailbox is named as the owner\'s (owner_mailboxes)', {
          chat_slug: row.chat_slug,
        });
      }
      settleRow(row, 'ignored', 'not_owner', row.attempts);
      return;
    }
    // ⛔ THE COPY ITSELF MUST BE THE OWNER'S MAIL SERVER'S (the audit). The Sent
    // record proves the owner sent a message with this Message-ID; whoever reads
    // it on its way (a connected app with read access, a relay) can deliver
    // another copy under the same id FIRST, and the first copy is the request.
    // A domain that publishes DMARC makes that copy fail at the chat mailbox's
    // provider, unless it came from the owner's own servers.
    if (row.sender_auth === 'fail') {
      settleRow(row, 'not_proven', 'unauthenticated', attempts,
        { notice: mailChatProofNotice('unauthenticated', row.from_address, chatAddress) });
      return;
    }

    const results: MailSentByMessageIdResult[] = [];
    for (const owner of owners) {
      let result: MailSentByMessageIdResult;
      try {
        result = await owner.lookupSentByMessageId({ rfc_message_id: row.rfc_message_id });
      } catch {
        result = { status: 'unavailable', reason: 'provider_error' };
      }
      if (disposed) return;
      if (result.status === 'found') {
        const match = result.matches.find((sent) =>
          sent.to.some((address) => bareAddress(address) === chatAddress)
          && Math.abs(sent.sent_at - row.received_at) <= MAIL_CHAT_PROOF_MAX_SEND_GAP_MS);
        if (match !== undefined) {
          if (settleRow(row, 'proven', null, attempts, { proven_by: owner.slug, proof: 'sent_record' })) {
            log?.('info', 'chat mailbox request proven by the owner\'s Sent record', {
              chat_slug: row.chat_slug, proven_by: owner.slug,
            });
          }
          return;
        }
      }
      results.push(result);
    }

    const owner = row.from_address;
    if (results.some((result) => result.status === 'found')) {
      settleRow(row, 'not_proven', 'mismatch', attempts, { notice: mailChatProofNotice('mismatch', owner, chatAddress) });
      return;
    }
    const askable = results.filter((result) => !(result.status === 'unavailable' && result.reason === 'unsupported'));
    if (askable.length === 0) {
      settleRow(row, 'not_proven', 'unsupported', attempts, { notice: mailChatProofNotice('unsupported', owner, chatAddress) });
      return;
    }
    if (now() >= deadline) {
      const reason = askable.every((result) => result.status === 'unavailable') ? 'unreachable' : 'not_in_sent';
      settleRow(row, 'not_proven', reason, attempts, { notice: mailChatProofNotice(reason, owner, chatAddress) });
      return;
    }
    const wait = MAIL_CHAT_PROOF_RETRY_MS[Math.min(attempts - 1, MAIL_CHAT_PROOF_RETRY_MS.length - 1)]!;
    retry(row, attempts, Math.min(now() + wait, deadline));
  };

  /** Step 6 — a proven request the door does not hand to chat: it is paused. */
  const setAside = (row: RequestRow, admit_reason: string, notice?: NotificationMessage): void => {
    const at = now();
    admitSettle.run({
      chat_slug: row.chat_slug, rfc_message_id: row.rfc_message_id, admit_state: 'dropped', admit_reason,
      attempts: row.admit_attempts, at, ...noticeColumns(at, notice, true),
    });
    log?.('info', 'chat mailbox request not handed to chat', { chat_slug: row.chat_slug, reason: admit_reason });
  };

  /** Step 6 — ⛔ the burst guard: is this request past the burst, counting it? */
  const pastBurst = (row: RequestRow): boolean =>
    (selectBurst.get({
      chat_slug: row.chat_slug, from: row.arrived_at - MAIL_CHAT_BURST_WINDOW_MS, to: row.arrived_at,
    }) as { n: number }).n > MAIL_CHAT_BURST_MAX;

  /** One proven request handed to chat. A throw is tried again later, until an
   *  hour after the proof; `dropped` and `admitted` are final. */
  const handOver = async (row: RequestRow, fn: MailChatAdmit): Promise<void> => {
    const attempts = row.admit_attempts + 1;
    const finish = (admit_state: Exclude<MailChatAdmitState, 'waiting'>, admit_reason: string | null,
      notice?: NotificationMessage): void => {
      const at = now();
      admitSettle.run({
        chat_slug: row.chat_slug, rfc_message_id: row.rfc_message_id, admit_state, admit_reason, attempts, at,
        ...noticeColumns(at, notice),
      });
    };
    let outcome: MailChatAdmitOutcome;
    try {
      outcome = await fn(toRequest(row));
    } catch (error) {
      if (!db.open) return;
      log?.('warn', 'chat mailbox request could not be handed to chat yet', {
        chat_slug: row.chat_slug, error: error instanceof Error ? error.message : String(error),
      });
      if (now() - Math.max(row.resolved_at ?? row.arrived_at, resumedAt ?? 0) >= MAIL_CHAT_ADMIT_GIVE_UP_MS) {
        const chat = mailboxes().find((mailbox) => mailbox.slug === row.chat_slug);
        finish('gave_up', 'chat did not take it within an hour',
          mailChatAdmitNotice(row.from_address, bareAddress(chat?.accountEmail ?? '') || row.chat_slug));
        return;
      }
      const wait = MAIL_CHAT_ADMIT_RETRY_MS[Math.min(attempts - 1, MAIL_CHAT_ADMIT_RETRY_MS.length - 1)]!;
      admitRetry.run({ chat_slug: row.chat_slug, rfc_message_id: row.rfc_message_id, attempts, at: now() + wait });
      return;
    }
    // Recorded even while stopping: chat has the turn, and a repeat would only
    // be answered with that same turn.
    if (!db.open) return;
    if (outcome.outcome === 'admitted') {
      finish('admitted', null);
      log?.('info', 'chat mailbox request handed to chat', { chat_slug: row.chat_slug });
    } else {
      finish('dropped', outcome.reason, outcome.notice);
      log?.('info', 'chat mailbox request not handed to chat', { chat_slug: row.chat_slug, reason: outcome.reason });
    }
  };

  /** D-308's order: the history row under a fixed id, then the mark, then the
   *  push, best-effort. A stop before the mark delivers it again at the next
   *  start, onto the same row. */
  const deliverNotices = async (): Promise<void> => {
    const send = notify;
    if (send === undefined) return;
    for (const row of selectNoticesDue.all() as RequestRow[]) {
      if (disposed) return;
      const message = JSON.parse(row.notice_json ?? 'null') as NotificationMessage | null;
      if (message === null) {
        markNoticeSent.run(row.chat_slug, row.rfc_message_id);
        continue;
      }
      const persisted_activity_id = `mail-chat-proof:${createHash('sha256')
        .update(`${row.chat_slug}\n${row.rfc_message_id}`).digest('hex').slice(0, 32)}`;
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
          // Not marked: the next round writes the row and pushes again.
          log?.('warn', 'chat mailbox notice: the history row failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      markNoticeSent.run(row.chat_slug, row.rfc_message_id);
      // Without a history row of ours, the notifier writes one.
      const push = (async () => auditLog !== undefined ? send(message, { persisted_activity_id }) : send(message))();
      pushing = push;
      try {
        await push;
      } catch { /* best-effort: the notice is marked given */ } finally {
        pushing = undefined;
      }
    }
  };

  const runRound = async (): Promise<void> => {
    do {
      again = false;
      // The mailboxes' keys and the chat queue are behind the vault: nothing is
      // checked or handed over while it is locked, and the waits start again
      // when it opens.
      if (deps.isUnlocked !== undefined && !deps.isUnlocked()) {
        locked = true;
        return;
      }
      if (locked) {
        locked = false;
        resumedAt = now();
      }
      for (const row of selectDue.all(now()) as RequestRow[]) {
        if (disposed) return;
        try {
          await check(row);
        } catch (error) {
          log?.('warn', 'chat mailbox request check failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          retry(row, row.attempts + 1, now() + MAX_SLEEP_MS);
        }
      }
      if (disposed) return;
      const fn = admit;
      if (fn !== undefined) {
        for (const row of selectAdmitDue.all({ now: now(), since: since() }) as RequestRow[]) {
          if (disposed) return;
          // Step 6 — paused, nothing is handed over until the owner resumes it.
          if (door.get().paused_at !== null) {
            setAside(row, 'the email chat is paused');
            continue;
          }
          if (pastBurst(row)) {
            const chat = mailboxes().find((mailbox) => mailbox.slug === row.chat_slug);
            const paused = door.pause(now());
            setAside(row, 'the burst guard paused the email chat',
              paused ? mailChatBurstNotice(bareAddress(chat?.accountEmail ?? '') || row.chat_slug) : undefined);
            log?.('warn', 'chat mailbox burst: the email chat is paused until the owner resumes it', {
              chat_slug: row.chat_slug,
            });
            continue;
          }
          // A reply ("oh, and also…") waits for the request it answers to reach
          // chat first: it then joins that conversation, after it.
          const references = JSON.parse(row.references_json) as string[];
          if (references.some((id) => id !== row.rfc_message_id
            && selectEarlierOnItsWay.get(row.chat_slug, id, row.arrived_at) !== undefined)) {
            admitRetry.run({
              chat_slug: row.chat_slug, rfc_message_id: row.rfc_message_id, attempts: row.admit_attempts,
              at: now() + EARLIER_REQUEST_WAIT_MS,
            });
            continue;
          }
          if (row.attachments_known_at === null) {
            log?.('warn', 'chat mailbox request handed to chat without its attachments: they were not stored in time', {
              chat_slug: row.chat_slug,
            });
          }
          await handOver(row, fn);
        }
      }
      if (disposed) return;
      await deliverNotices();
      prune.run(now() - MAIL_CHAT_PROOF_KEEP_MS);
      pruneSentCopies.run(now() - MAIL_CHAT_PROOF_KEEP_MS);
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
        log?.('warn', 'chat mailbox round failed', { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        running = undefined;
        try {
          schedule();
        } catch (error) {
          log?.('warn', 'chat mailbox round could not be scheduled', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return running;
  };

  /** Sleep until the next request is due, or a minute. */
  function schedule(): void {
    if (!started || disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    // A hand-over is due only once there is somewhere to hand it.
    const dues = [
      (selectNextDue.get() as { at: number | null }).at,
      admit !== undefined ? (selectNextAdmit.get({ since: since() }) as { at: number | null }).at : null,
    ].filter((at): at is number => at !== null);
    if (dues.length === 0) return;
    // Locked: look again in a while for the vault to open, never at once.
    const next = locked ? now() + MAX_SLEEP_MS : Math.min(...dues);
    timer = setTimeout(() => {
      timer = undefined;
      void tick();
    }, Math.max(0, Math.min(next - now(), MAX_SLEEP_MS)));
    timer.unref?.();
  }

  /** Step 8 — an email from a pending address that carries a code settles
   *  its enrolment. `true` when it did: it is not a request. */
  const settleEnrolmentEmail = (msg: CanonicalMessage, ctx: MailStoredContext, from_address: string): boolean => {
    const pending = door.get().enrolled_senders.find((sender) => sender.state === 'pending'
      && sender.address === from_address && sender.chat_mailbox === ctx.slug);
    if (pending === undefined) return false;
    const outcome = mailChatEnrolOutcome({
      subject: msg.subject,
      body_text: msg.body_text,
      ...(msg.body_html !== undefined ? { body_html: msg.body_html } : {}),
      from_address,
      authentication_results: msg.headers?.['authentication-results'],
    }, pending, {
      provider_kind: ctx.provider_kind,
      // The chat mailbox is running: it is syncing this email.
      address: bareAddress(mailboxes().find((mailbox) => mailbox.slug === ctx.slug)?.accountEmail
        ?? door.get().chat_address ?? ''),
    });
    if (outcome === null) return false;
    const settled = door.settleEnrolment(ctx.slug, from_address, outcome);
    if (settled === null) return false;
    log?.(settled.state === 'confirmed' ? 'info' : 'warn', 'chat mailbox enrolment email', {
      chat_slug: ctx.slug,
      outcome: outcome.kind,
      ...(settled.state === 'confirmed' ? { checked_by: settled.checked_by } : {}),
      ...(settled.failure !== null ? { failure: settled.failure } : {}),
    });
    if (settled.state !== 'pending' && auditLog !== undefined) {
      void Promise.resolve().then(() => auditLog.logActivity({
        activity_id: '',
        timestamp: now(),
        action: 'mail_chat_door_enrolment',
        target: 'mail_chat_door',
        detail: JSON.stringify({
          address: from_address,
          state: settled.state,
          ...(settled.state === 'confirmed' ? { checked_by: settled.checked_by } : { failure: settled.failure }),
        }),
      })).catch(() => undefined);
    }
    // A wrong code is still mail from the address: the door reads it on.
    return outcome.kind !== 'wrong_code';
  };

  return {
    onMessageStored(msg, ctx): void {
      try {
        if (disposed || !door.isChatMailbox(ctx.slug)) return;
        const rfc_message_id = normalizeRfcMessageId(msg.rfc_message_id);
        if (rfc_message_id === undefined || !plausibleMessageId(rfc_message_id)) return;
        const settings = door.get();
        const oneMailbox = isMailChatOneMailbox(settings);
        // One mailbox — addressed to the chat mailbox alone: its address is the
        // owner's own, and mail to them and someone else is not a request.
        const toItAlone = (): boolean => {
          const chatAddress = bareAddress(mailboxes().find((mailbox) => mailbox.slug === ctx.slug)?.accountEmail
            ?? settings.chat_address ?? '');
          return chatAddress.includes('@') && msg.to.length === 1 && bareAddress(msg.to[0]!) === chatAddress
            && msg.cc.length === 0;
        };
        if (oneMailbox) {
          // One mailbox — the owner's own Sent copy of an email to themselves,
          // filed apart from the copy delivered to the inbox (Outlook, IMAP):
          // their record, never a request, and not a second copy of one. Gmail
          // keeps both as one message, which is the request (below). ⚠ A
          // provider not named reads as Gmail: taken for a Sent copy, a request
          // would be lost without a word; taken for a request, a second copy
          // refuses it aloud.
          if (msg.direction === 'outbound' && (ctx.provider_kind === 'graph' || ctx.provider_kind === 'imap')) {
            if (toItAlone()) insertSentCopy.run(ctx.slug, ctx.record_id, rfc_message_id, now());
            return;
          }
          // Everything else the owner's mailbox holds is their mail, set aside
          // without a word: the log would otherwise name each email they get.
          if (!toItAlone()) return;
        }
        // Set aside: logged where the chat mailbox is only that, never for the
        // owner's own mail in one mailbox.
        const ignored = (why: string, data?: Record<string, unknown>): void => {
          if (!oneMailbox) log?.('info', why, { chat_slug: ctx.slug, ...data });
        };
        // ⛔ Before any other check: only the first copy of a Message-ID to land
        // in the chat mailbox can be a request, whatever became of it.
        const copies = storedCopies(ctx.slug, rfc_message_id);
        if (copies[0] !== ctx.record_id) {
          log?.('info', 'chat mailbox message ignored: a later copy of an email already there', { chat_slug: ctx.slug });
          return;
        }
        // The chat mailbox's first sync is a backfill: old mail, never a request.
        if (!ctx.backfill_complete) return;
        // Recued's own answers, drafts, and what the chat mailbox itself sent —
        // but with one mailbox, the owner's email to themselves, which Gmail
        // files as sent.
        if (isMailReconciliationId(msg.reconciliation_id)) return;
        if (msg.direction === 'draft' || (msg.direction === 'outbound' && !oneMailbox)) return;
        // Step 4 — what is not a request at all, before anything is looked up.
        const sign = automaticMailSign(msg.headers);
        if (sign !== null) {
          ignored('chat mailbox message ignored: automatic reply', { sign });
          return;
        }
        const from_address = bareAddress(msg.from);
        // Step 8 — the email with a pending address's code is the enrolment,
        // never a request.
        if (settleEnrolmentEmail(msg, ctx, from_address)) return;
        // An emailed approval answer is D-158's (P23), never a chat message.
        if (extractAskId(msg.subject) !== null) return;
        const references = mailChatReferences(msg.headers);
        const prefix = settings.ask_prefix;
        if (prefix !== null && !subjectAsks(msg.subject, prefix) && !continuesConversation(ctx.slug, references)) {
          ignored('chat mailbox message ignored: a new conversation starts with the ask prefix');
          return;
        }
        const arrived_at = now();
        // The owner's own part of the HTML, read now: the sync keeps no HTML. A
        // forward's ends where the mail it forwards begins.
        const html = typeof msg.body_html === 'string' && msg.body_html.length > 0
          ? mailChatHtmlOwnText(msg.body_html, { forwarded: subjectIsForward(msg.subject, prefix) })
          : undefined;
        // The chat mailbox's provider's sender check, from its own stamp, and
        // who made it: in memory only now, as the headers are.
        const sender = senderCheckFor(msg.headers?.['authentication-results'],
          from_address.slice(from_address.lastIndexOf('@') + 1));
        const added = insert.run({
          chat_slug: ctx.slug,
          rfc_message_id,
          record_id: ctx.record_id,
          from_address,
          to_json: JSON.stringify(msg.to.map(bareAddress)),
          references_json: JSON.stringify(references),
          arrived_at,
          received_at: msg.provider_received_at ?? arrived_at,
          html_text: html === undefined ? null : html.text.slice(0, HTML_TEXT_MAX),
          html_cut: HTML_CUT_CODES[html?.cut ?? 'none'],
          attached_email: (msg.attachments ?? []).some(isAttachedEmail) ? 1 : 0,
          recovered: ctx.recovered === true ? 1 : 0,
          sender_auth: sender.result,
          stamped_by: sender.stamped_by,
        }).changes > 0;
        if (added && started) void tick();
      } catch (error) {
        log?.('warn', 'chat mailbox request could not be recorded', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    onMessageUpserted(msg, ctx): void {
      try {
        if (disposed || !door.isChatMailbox(ctx.slug)) return;
        const rfc_message_id = normalizeRfcMessageId(msg.rfc_message_id);
        if (rfc_message_id === undefined) return;
        if (selectFilesUnknown.get(ctx.slug, rfc_message_id, ctx.record_id) === undefined) return;
        const files = mailChatTurnFiles(msg.body_html, ctx.attachments, {
          forwarded: subjectIsForward(msg.subject, door.get().ask_prefix),
        });
        // An attachment that failed to store is missing: its files are kept, not
        // yet known — a later read of the email may store it, and the wait for
        // them goes on.
        const complete = ctx.attachments.length >= (msg.attachments?.length ?? 0);
        const changed = setFiles.run({
          json: JSON.stringify(files), complete: complete ? 1 : 0, at: now(),
          chat_slug: ctx.slug, rfc_message_id, record_id: ctx.record_id,
        }).changes > 0;
        if (changed && complete && started) void tick();
      } catch (error) {
        log?.('warn', 'chat mailbox request files could not be recorded', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    tick,
    bindAdmit(fn): void {
      admit = fn;
      if (started) void tick();
    },
    bindNotify(fn): void {
      notify = fn;
      if (started) void tick();
    },
    start(): void {
      if (started || disposed) return;
      started = true;
      startedAt = now();
      void tick();
    },
    /** ⛔ A drain step awaits this, with 5 s, and the process exits right after
     *  the drain anyway, so a round is waited for at most `STOP_GRACE_MS`. A
     *  Sent-folder lookup can take far longer — over IMAP the library's own
     *  limits apply, 90 s to connect and minutes idle — and nothing a round
     *  leaves unfinished is lost: `disposed` starts no further check, hand-over
     *  or notice; a request whose lookup is cut short is still `pending`, so it
     *  is checked again after the restart, its wait counted from then; a
     *  hand-over still `waiting` is made again, and chat's admission names its
     *  own submission, so a repeat adds nothing; a notice not yet marked is
     *  given at the next start, onto the same history row.
     *
     *  The exception is a notice push in flight, given `PUSH_GRACE_MS`: it
     *  comes AFTER its mark (D-308's order), so a push cut short is never given
     *  again and only its history row remains. Waiting on would run out the
     *  drain step, which makes an update refuse to swap. */
    async dispose(): Promise<void> {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (running !== undefined) await settleWithin(running, pushing !== undefined ? PUSH_GRACE_MS : STOP_GRACE_MS);
    },
    get(chat_slug, rfc_message_id): MailChatRequest | null {
      const row = selectOne.get(chat_slug, rfc_message_id) as RequestRow | undefined;
      return row === undefined ? null : toRequest(row);
    },
    recent(chat_slug, limit): MailChatRequestProgress[] {
      return (selectRecent.all(chat_slug, Math.max(0, Math.floor(limit))) as RequestRow[])
        .map((row) => ({ ...toRequest(row), admit_reason: row.admit_reason }));
    },
    continuesConversation: (chat_slug, references) => {
      try {
        return continuesConversation(chat_slug, references);
      } catch {
        return false;
      }
    },
    refuted(chat_slug, rfc_message_id): boolean {
      try {
        const state = (selectOne.get(chat_slug, rfc_message_id) as RequestRow | undefined)?.state;
        return state === 'not_proven' || state === 'ignored';
      } catch {
        return false;
      }
    },
  };
};
