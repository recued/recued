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
 *  ONE MAILBOX (2026-10-18, §8.18) — the chat mailbox is one of the owner's own
 *  too (`isMailChatOneMailbox`). Its address is then the owner's, and email to
 *  it alone is their own mail — a note to themselves, a renewal forwarded,
 *  Recued's notification, their answer to one — so being addressed there no
 *  longer makes an email the conversation. Only one that ASKS does: its subject
 *  begins with the `ask:` prefix (always on with one mailbox) or it continues a
 *  conversation, and it is neither an approval answer (`[#ask-…]`, D-158's),
 *  automatic mail, nor mail Recued sent under another reconciliation id. Who
 *  wrote it is still decided by what a sender cannot write:
 *  - filed as SENT by its provider (Gmail keeps a message to oneself as one
 *    message labelled `SENT` and `INBOX`; the IMAP Sent folder; Graph's
 *    `sentitems`), in any of the owner's mailboxes: they sent it. An answer's
 *    reconciliation id there is Recued's answer, whichever copy sent it;
 *  - delivered to the chat mailbox (the copy Outlook or an IMAP server files in
 *    the inbox, or one from another of the owner's addresses): From one of the
 *    owner's addresses, ON THE PROVIDER'S WORD (the owner, 2026-10-18: *"the
 *    providers will block any non-valid senders"*) — a provider junks or
 *    refuses mail that fails its sender checks for the owner's address, and
 *    Recued syncs the inbox. Never when the chat mailbox's provider stamped the
 *    check as failed. ⛔ And it comes off again when the door does not prove
 *    the email the owner's (`unmark`, `refuted`): a forgery that got past the
 *    provider is hidden from the owner's recipes only until its proof fails —
 *    never acted on, and the owner is told (`sent-proof.ts`).
 *
 *  Spec: D-318 §4.10, §8 step 5, §8.9, §8.10, §8.18. */

import { createHash } from 'node:crypto';

import {
  isMailChatOneMailbox,
  isMailReconciliationId,
  MAIL_CHAT_ASK_PREFIX_DEFAULT,
  parseAddress,
  splitAddressList,
} from '@recued/contracts';
import { extractAskId } from '@recued/notification';

import { senderCheckFor } from '../collections/mail/authentication-results.js';
import {
  MAIL_CHAT_CONVERSATION_FIELD,
  type MailCollection,
  type MailReceiver,
} from '../collections/mail/mail-collection.js';
import { normalizeRfcMessageId } from '../collections/mail/provider.js';
import type { MailChatDoorStore } from '../storage/mail-chat-door-store.js';
import { mailChatReferences } from './conversations.js';
import { mailChatCheckerFits } from './enrolment.js';
import { automaticMailSign, subjectAsks } from './filters.js';

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
  /** One mailbox — whether an email the owner wrote to themselves asks. */
  readonly subject?: unknown;
  /** One mailbox — its RFC Message-ID, to ask whether the door refuted it. */
  readonly rfc_message_id?: unknown;
  /** Each header's FIRST value (`mailHeaderMap`): the receiver's stamp is on top. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** One mailbox (§8.18): what tells the conversation from the owner's own mail
 *  when the chat mailbox is one of theirs. */
export interface MailChatOneMailbox {
  /** The `ask:` prefix, always on with one mailbox. */
  readonly ask_prefix: string;
  /** Does an email referring to these Message-IDs (nearest first) continue a
   *  conversation — one chat has, or a request still on its way to it? */
  readonly continues: (references: readonly string[]) => boolean;
  /** The owner's own addresses, bare: their mailboxes', the chat mailbox's
   *  among them, and the addresses they added (confirmed). */
  readonly owner_addresses: ReadonlySet<string>;
  /** Did the door settle the email with this Message-ID (bracketless) as not
   *  the owner's? Then it is not the conversation. */
  readonly refuted: (rfc_message_id: string) => boolean;
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

/** One mailbox — does an email to the chat mailbox alone ask? It begins with
 *  the prefix or continues a conversation, and is no approval answer, no
 *  automatic mail, and no other mail Recued sent (a notification). */
const asks = (msg: MailChatConversationMessage, oneMailbox: MailChatOneMailbox): boolean => {
  if (isMailReconciliationId(msg.reconciliation_id)) return false;
  const subject = typeof msg.subject === 'string' ? msg.subject : '';
  if (extractAskId(subject) !== null || automaticMailSign(msg.headers) !== null) return false;
  return subjectAsks(subject, oneMailbox.ask_prefix) || oneMailbox.continues(mailChatReferences(msg.headers));
};

/** ⛔ One mailbox — a request DELIVERED to the chat mailbox (not filed as sent:
 *  Outlook's and an IMAP server's inbox copy of an email to oneself, or one
 *  from another of the owner's addresses). From one of the owner's addresses,
 *  on the provider's word (the header above): never one whose sender check the
 *  provider stamped as failed — a stamp a sender planted can only say less —
 *  and never one the door refuted. */
const isDeliveredRequest = (
  msg: MailChatConversationMessage,
  chatAddress: string,
  receiver: MailReceiver | undefined,
  oneMailbox: MailChatOneMailbox,
): boolean => {
  if (receiver === undefined || addressesOf(receiver.account_email)[0] !== chatAddress) return false;
  const from = addressesOf(msg.from);
  if (from.length !== 1 || !oneMailbox.owner_addresses.has(from[0]!)) return false;
  const domain = from[0]!.slice(from[0]!.lastIndexOf('@') + 1);
  if (senderCheckFor(msg.headers?.['authentication-results'], domain).result === 'fail') return false;
  const id = normalizeRfcMessageId(typeof msg.rfc_message_id === 'string' ? msg.rfc_message_id : undefined);
  return id === undefined || !oneMailbox.refuted(id);
};

/** Is this message, as it syncs, the conversation with the chat mailbox at
 *  `chatAddress`? An answer by its claim (even with no chat mailbox set), or by
 *  the stamp of the mailbox it landed in (`receiver`), or a Sent copy: filed as
 *  sent by its provider, to the chat mailbox alone. With one mailbox
 *  (`oneMailbox`, §8.18) an email to the chat mailbox alone is the owner's own
 *  mail unless it asks, and a delivered copy counts from one of the owner's
 *  addresses, on its provider's word, until the door refutes it. */
export const isMailChatConversationMessage = (
  msg: MailChatConversationMessage,
  chatAddress: string | null,
  isOwnAnswer?: (reconciliation_id: string) => boolean,
  receiver?: MailReceiver,
  oneMailbox?: MailChatOneMailbox,
): boolean => {
  if (isOwnAnswerOf(msg.reconciliation_id, isOwnAnswer)) return true;
  if (isStampedAnswer(msg, chatAddress, receiver)) return true;
  if (chatAddress === null) return false;
  const to = addressesOf(msg.to);
  if (to.length !== 1 || to[0] !== chatAddress || addressesOf(msg.cc).length > 0) return false;
  if (oneMailbox === undefined) return msg.direction === 'outbound';
  if (msg.direction === 'outbound') {
    // Only the account adds to its Sent record: Recued's answer, sent by any
    // copy of this server, or the owner's own email.
    return isMailChatAnswerReconciliationId(msg.reconciliation_id) || asks(msg, oneMailbox);
  }
  return asks(msg, oneMailbox) && isDeliveredRequest(msg, chatAddress, receiver, oneMailbox);
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
  /** One mailbox — the door did not prove this stored email the owner's: it is
   *  their mail again. Its mark comes off the row (every reader sees it), and
   *  the next sync of it does not put it back (`refuted`). A row without the
   *  mark, or a mailbox not running, is left as it is. */
  unmark(slug: string, record_id: string): void;
}

export const createMailChatConversationMail = (deps: {
  readonly door: Pick<MailChatDoorStore, 'get'>;
  /** A connected mailbox by slug; `upsert` to take a mark off (`unmark`). */
  readonly mailbox: (slug: string) =>
    (Pick<MailCollection, 'accountEmail' | 'get'> & Partial<Pick<MailCollection, 'upsert'>>) | undefined;
  /** Did Recued send mail under this reconciliation id (its send claims)? */
  readonly isOwnAnswer?: (reconciliation_id: string) => boolean;
  /** One mailbox — does an email referring to these Message-IDs continue a
   *  conversation of this chat mailbox (`MailChatSentProof.continuesConversation`)?
   *  Absent ⇒ only an email with the prefix asks. */
  readonly continues?: (chat_slug: string, references: readonly string[]) => boolean;
  /** One mailbox — did the door settle this email of the chat mailbox as not
   *  the owner's (`MailChatSentProof.refuted`)? Absent ⇒ none is. */
  readonly refuted?: (chat_slug: string, rfc_message_id: string) => boolean;
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
  /** One mailbox, read each time: the owner can turn it on and off. */
  const oneMailbox = (): MailChatOneMailbox | undefined => {
    const settings = deps.door.get();
    const chat = settings.chat_mailbox;
    if (chat === null || !isMailChatOneMailbox(settings)) return undefined;
    const owner_addresses = new Set<string>();
    for (const slug of settings.owner_mailboxes) {
      const address = slug === chat ? chatAddress() : addressesOf(deps.mailbox(slug)?.accountEmail)[0];
      if (address !== undefined && address !== null) owner_addresses.add(address);
    }
    for (const sender of settings.enrolled_senders) {
      if (sender.state === 'confirmed' && sender.chat_mailbox === chat) owner_addresses.add(sender.address);
    }
    return {
      ask_prefix: settings.ask_prefix ?? MAIL_CHAT_ASK_PREFIX_DEFAULT,
      continues: (references) => references.length > 0 && deps.continues?.(chat, references) === true,
      owner_addresses,
      refuted: (rfc_message_id) => deps.refuted?.(chat, rfc_message_id) === true,
    };
  };
  const isConversationMail = (fields: Readonly<Record<string, unknown>>): boolean =>
    isMailChatConversationRecord(fields, deps.isOwnAnswer);
  return {
    isConversationMessage: (msg, receiver) =>
      isMailChatConversationMessage(msg, chatAddress(), deps.isOwnAnswer, receiver, oneMailbox()),
    isConversationMail,
    isConversationRecord(slug, record_id) {
      const record = deps.mailbox(slug)?.get(record_id);
      return record !== null && record !== undefined && isConversationMail(record.hot_fields);
    },
    unmark(slug, record_id) {
      const mailbox = deps.mailbox(slug);
      const record = mailbox?.get(record_id);
      if (mailbox?.upsert === undefined || record === null || record === undefined
        || record.hot_fields[MAIL_CHAT_CONVERSATION_FIELD] !== true) return;
      const { [MAIL_CHAT_CONVERSATION_FIELD]: _mark, ...hot_fields } = record.hot_fields;
      mailbox.upsert({ ...record, hot_fields });
    },
  };
};
