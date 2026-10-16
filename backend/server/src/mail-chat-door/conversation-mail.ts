/** D-318 step 5 — the conversation stays out of the owner's mail (§4.10, P19).
 *
 *  The chat mailbox's own mail is the conversation, and nothing of the owner's
 *  reads it (step 1). Two kinds of the conversation's mail also land in the
 *  owner's OTHER mailboxes:
 *  - **Recued's answers**, in the owner's inbox: from the chat mailbox, with an
 *    answer's reconciliation id (`mailChatAnswerReconciliationId`).
 *  - **The owner's requests**, as their own Sent copy: a Gmail mailbox syncs
 *    every label, so each request is synced as the owner's sent mail too. It is
 *    addressed to the chat mailbox alone.
 *
 *  Neither is the owner's mail. No mail recipe starts on it, no mail fact is
 *  made of it, no contact is drawn from it, and no housekeeping producer reads
 *  it.
 *
 *  ⚠ AN EMAIL TO THE CHAT MAILBOX AND SOMEONE ELSE IS MAIL TO THAT SOMEONE.
 *  With another recipient, or a CC, it stays the owner's mail, as it was.
 *
 *  ⛔ ONLY WHAT A SENDER CANNOT WRITE DECIDES IT (the audit). Taken at their
 *  word, a header or a From line would let a stranger hide an email from every
 *  mail recipe, fact and contact:
 *  - an answer is mail whose reconciliation id Recued's own send claims hold —
 *    never the header alone, nor the chat mailbox in a From line;
 *  - ⛔ or, sent by ANOTHER copy of this server (one restored from a backup
 *    holds no claim for the answers sent since it was taken; a second copy none
 *    for the first's), mail from the chat mailbox's address that the RECEIVING
 *    provider's own stamp shows passing for it, on Gmail and Microsoft mailboxes
 *    (`isStampedAnswer`);
 *  - a request's Sent copy is mail the PROVIDER filed as sent (Gmail's `SENT`,
 *    the IMAP Sent folder, Graph's `sentitems`: `CanonicalMessage.direction`) —
 *    never a stored row's direction, which reads `outbound` for any From equal
 *    to the account (`resolveMailMessageDirection`): the owner's From, the chat
 *    mailbox as its only To, and the owner Bcc'd would pass for one.
 *
 *  So the decision is made ONCE, as a message is stored, where the provider's
 *  record is in hand (`isConversationMessage`), and kept on the row
 *  (`MAIL_CHAT_CONVERSATION_FIELD`). A stored row is read by its mark
 *  (`isConversationMail`), and every reader that lists the mail tables reads
 *  them without the marked rows (`MAIL_CHAT_OWNER_ROWS_SQL`, applied by
 *  `listCollectionDataTables`). An answer stored before the mark is still known
 *  by its claim; a Sent copy stored before it is not.
 *
 *  ⛔ THE CHAT MAILBOX'S ADDRESS IS THE DOOR'S, kept when it was named: the
 *  chat mailbox is not running at every moment the owner's mail is read — at
 *  boot the mailboxes start one by one, and a mailbox signing in again stops.
 *
 *  Spec: D-318 §4.10, §8 step 5, §8.9, §8.10. */

import { createHash } from 'node:crypto';

import { parseAddress, splitAddressList } from '@recued/contracts';

import { senderCheckFor } from '../collections/mail/authentication-results.js';
import {
  MAIL_CHAT_CONVERSATION_FIELD,
  type MailCollection,
  type MailReceiver,
} from '../collections/mail/mail-collection.js';
import type { MailChatDoorStore } from '../storage/mail-chat-door-store.js';
import { mailChatCheckerFits } from './enrolment.js';

/** Every answer's reconciliation id starts so. */
export const MAIL_CHAT_ANSWER_RECONCILIATION_PREFIX = 'mail-chat-answer:';

/** The reconciliation id an answer is sent with: the same on every attempt, so
 *  the send claim (D-207) never lets one answer go out twice. */
export const mailChatAnswerReconciliationId = (answer_id: string): string =>
  `${MAIL_CHAT_ANSWER_RECONCILIATION_PREFIX}${createHash('sha256').update(answer_id).digest('hex').slice(0, 32)}`;

export const isMailChatAnswerReconciliationId = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith(MAIL_CHAT_ANSWER_RECONCILIATION_PREFIX);

/** A stored row of the owner's own mail, as SQL: not marked as the
 *  conversation (the mark is JSON `true`, which SQLite reads as 1). The readers
 *  that list the mail tables read through it. */
export const MAIL_CHAT_OWNER_ROWS_SQL = `json_extract(hot_fields, '$.${MAIL_CHAT_CONVERSATION_FIELD}') IS NOT 1`;

/** A message as it syncs, its provider's record in hand. */
export interface MailChatConversationMessage {
  readonly from?: unknown;
  readonly to?: unknown;
  readonly cc?: unknown;
  /** ⛔ The PROVIDER's (`CanonicalMessage.direction`), never a stored row's. */
  readonly direction?: unknown;
  readonly reconciliation_id?: unknown;
  /** Each header's FIRST value (`mailHeaderMap`): the receiver's stamp is on top. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Each address a field names, bare and lower case. */
const addressesOf = (field: unknown): string[] => {
  const entries = typeof field === 'string' ? [field] : Array.isArray(field) ? field : [];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    for (const part of splitAddressList(entry)) {
      const parsed = parseAddress(part);
      if (parsed !== null) out.push(parsed.email);
    }
  }
  return out;
};

/** Is it an answer Recued sent: a reconciliation id Recued's own record holds? */
const isOwnAnswerOf = (reconciliation_id: unknown, isOwnAnswer?: (reconciliation_id: string) => boolean): boolean =>
  isMailChatAnswerReconciliationId(reconciliation_id) && isOwnAnswer?.(reconciliation_id as string) === true;

/** ⛔ Recued's answer, sent by ANOTHER copy of this server, which left no claim
 *  here (live, 2026-10-15: a copy holding none stored two answers in the
 *  owner's Gmail as the owner's mail, and counted the chat mailbox as someone
 *  the owner corresponds with). It is told by what the RECEIVING mailbox's
 *  provider wrote, never by what came with the mail: From the chat mailbox's
 *  address, and that provider's own stamp passing the address's domain
 *  (`senderCheckFor`, `mailChatCheckerFits`). This is proof (b)'s check, which
 *  is trusted to start a turn as the owner (step 8). The reconciliation id says
 *  only which of the chat mailbox's mail it is: an answer.
 *  ⚠ Gmail's and Microsoft's mailboxes only, which stamp on top of everything
 *  that lands. An IMAP server that stamps nothing leaves a sender's planted
 *  stamp first (`authentication-results.ts`), so there the claim alone decides. */
const isStampedAnswer = (
  msg: MailChatConversationMessage,
  chatAddress: string | null,
  receiver: MailReceiver | undefined,
): boolean => {
  if (chatAddress === null || receiver === undefined) return false;
  if (receiver.provider_kind !== 'gmail' && receiver.provider_kind !== 'graph') return false;
  if (!isMailChatAnswerReconciliationId(msg.reconciliation_id)) return false;
  const from = addressesOf(msg.from);
  if (from.length !== 1 || from[0] !== chatAddress) return false;
  const domain = chatAddress.slice(chatAddress.lastIndexOf('@') + 1);
  const check = senderCheckFor(msg.headers?.['authentication-results'], domain);
  return check.result === 'pass' && check.stamped_by !== null
    && mailChatCheckerFits(check.stamped_by, domain, { provider_kind: receiver.provider_kind, address: receiver.account_email });
};

/** Is this message, as it syncs, the conversation with the chat mailbox at
 *  `chatAddress`? An answer by its claim (even with no chat mailbox set), or by
 *  the stamp of the mailbox it landed in (`receiver`), or a Sent copy: filed as
 *  sent by its provider, to the chat mailbox alone. */
export const isMailChatConversationMessage = (
  msg: MailChatConversationMessage,
  chatAddress: string | null,
  isOwnAnswer?: (reconciliation_id: string) => boolean,
  receiver?: MailReceiver,
): boolean => {
  if (isOwnAnswerOf(msg.reconciliation_id, isOwnAnswer)) return true;
  if (isStampedAnswer(msg, chatAddress, receiver)) return true;
  if (chatAddress === null || msg.direction !== 'outbound') return false;
  const to = addressesOf(msg.to);
  return to.length === 1 && to[0] === chatAddress && addressesOf(msg.cc).length === 0;
};

/** Is this stored row the conversation? Marked as it was stored, or — stored
 *  before the mark — an answer by its claim. */
export const isMailChatConversationRecord = (
  fields: Readonly<Record<string, unknown>>,
  isOwnAnswer?: (reconciliation_id: string) => boolean,
): boolean => fields[MAIL_CHAT_CONVERSATION_FIELD] === true || isOwnAnswerOf(fields.reconciliation_id, isOwnAnswer);

export interface MailChatConversationMail {
  /** A message as it syncs, its provider's record in hand, and the mailbox it
   *  landed in when that is known. */
  isConversationMessage(msg: MailChatConversationMessage, receiver?: MailReceiver): boolean;
  /** A stored row's hot fields. */
  isConversationMail(fields: Readonly<Record<string, unknown>>): boolean;
  /** A stored message, by its mailbox and id. A message no longer stored is not. */
  isConversationRecord(slug: string, record_id: string): boolean;
}

export const createMailChatConversationMail = (deps: {
  readonly door: Pick<MailChatDoorStore, 'get'>;
  /** A connected mailbox by slug. */
  readonly mailbox: (slug: string) => Pick<MailCollection, 'accountEmail' | 'get'> | undefined;
  /** Did Recued send mail under this reconciliation id (its send claims)? */
  readonly isOwnAnswer?: (reconciliation_id: string) => boolean;
}): MailChatConversationMail => {
  /** The chat mailbox's address, read each time: the owner can change it. The
   *  door's own copy first; a door named before it kept one asks the mailbox. */
  const chatAddress = (): string | null => {
    const settings = deps.door.get();
    if (settings.chat_mailbox === null) return null;
    if (settings.chat_address !== null) return settings.chat_address;
    const address = deps.mailbox(settings.chat_mailbox)?.accountEmail;
    if (address === undefined) return null;
    return addressesOf(address)[0] ?? null;
  };
  const isConversationMail = (fields: Readonly<Record<string, unknown>>): boolean =>
    isMailChatConversationRecord(fields, deps.isOwnAnswer);
  return {
    isConversationMessage: (msg, receiver) => isMailChatConversationMessage(msg, chatAddress(), deps.isOwnAnswer, receiver),
    isConversationMail,
    isConversationRecord(slug, record_id) {
      const record = deps.mailbox(slug)?.get(record_id);
      return record !== null && record !== undefined && isConversationMail(record.hot_fields);
    },
  };
};
