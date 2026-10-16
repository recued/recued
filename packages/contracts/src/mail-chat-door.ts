/** D-318 — the email chat door's settings.
 *
 *  The owner writes from their own mailbox to a dedicated **chat mailbox**,
 *  and Recued answers from it in the same thread (D-318 ruling 1). Step 1
 *  names that mailbox: one per server, a connected mailbox that can send.
 *  Its mail is the conversation, not the owner's mail, so it makes no mail
 *  facts, no contacts, and starts no mail recipe (D-318 §4.10, P19).
 *
 *  ⚠ The door's later settings (the proof, the `ask:` filter, stale requests,
 *  the burst guard, enrolled senders — D-318 §4.12) join this record as their
 *  steps are built. A mailbox carries no role of its own: its config is
 *  rebuilt when it is enrolled again, which would drop a mark kept there.
 *
 *  Spec: D-318 §4.1, §4.2, §8 steps 1, 6, 7 and 8. */

export interface MailChatDoorSettings {
  /** The chat mailbox's slug (`data.mail.<slug>`), or `null` when none is set. */
  readonly chat_mailbox: string | null;
  /** D-318 step 4 — the `ask:` filter (§4.3, P14): a NEW conversation starts only
   *  with a subject that begins with this (after any `Re:`), case aside; a reply in
   *  a conversation continues without it. `null` switches the filter off. It keeps
   *  old mail between the two mailboxes, and a rule forwarding mail to the chat
   *  mailbox, from starting turns. */
  readonly ask_prefix: string | null;
  /** D-318 audit — the owner's own mailboxes (slugs): proof (a) reads THEIR Sent
   *  record, and only an email from one of their addresses can be a request
   *  (§4.12's "the owner's mailboxes it reads"). Not every connected mailbox: a
   *  shared support@ box, or an assistant's, connected for recipes, is not the
   *  owner, and whoever sends from it must not start a turn under the owner's
   *  authority. Empty until the owner names them: no request is proven. */
  readonly owner_mailboxes: readonly string[];
  /** D-318 audit — the chat mailbox's own address, kept when it is named: the
   *  door knows it while the chat mailbox is not running (at boot, while it
   *  signs in again), when what is the conversation must still be told apart. */
  readonly chat_address: string | null;
  /** D-318 step 6 — stale requests (§4.8, ruling 7, P16): a request Recued
   *  could not get to within this many minutes of when the chat mailbox's
   *  provider received it — the server off, the vault locked, the sync down —
   *  is answered with one line and not run. */
  readonly stale_after_minutes: number;
  /** D-318 step 6 — when the burst guard paused the door (§4.9, ruling 3, P15),
   *  else `null`. While it is paused, a request is neither run nor answered; it
   *  resumes on the owner's word. */
  readonly paused_at: number | null;
  /** D-318 step 8 — proof (b): the addresses Recued does not read that the
   *  owner writes from (§4.2, P13), each enrolled once with a code. */
  readonly enrolled_senders: readonly MailChatEnrolledSender[];
}

/** D-318 step 8 — proof (b): an address Recued does not read (a personal Yahoo,
 *  say), enrolled once (§4.2, P13). The owner adds it in Settings, Recued shows
 *  a code, and the owner sends that code FROM the address TO the chat mailbox.
 *  That one email shows two things. The address sends as the owner: only the
 *  owner sees the code. And it shows who checks mail from it where it lands:
 *  the chat mailbox provider's stamp on it (RFC 8601's authserv-id). Every
 *  later request from the address must carry a passing check by that same
 *  provider, on any of its hosts (`mailChatCheckerOrg`).
 *
 *  ⚠ THE CODE LEAVES BY THE OWNER'S EMAIL, NOT RECUED'S. The spec had Recued
 *  send a code to the address. A code mailed to a mistyped address reaches a
 *  stranger, who could send it back. And nothing Recued sends shows whose stamp
 *  the chat mailbox's provider puts on mail from the address. Without that
 *  checker known, a server that stamps nothing leaves a sender's planted stamp
 *  on top. */
export interface MailChatEnrolledSender {
  /** The address, bare and lower case. */
  readonly address: string;
  /** `pending` until the email with the code arrives. `confirmed` once it
   *  arrived and passed. `failed` once it arrived and did not pass (the code is
   *  spent), or the code ran out first. */
  readonly state: 'pending' | 'confirmed' | 'failed';
  /** The chat mailbox it was enrolled through (its slug). Its provider is the
   *  checker. */
  readonly chat_mailbox: string;
  /** The code to send while it is pending, else `null`. */
  readonly code: string | null;
  /** When the code stops working, while it is pending. */
  readonly expires_at: number | null;
  /** Wrong codes that arrived from the address while it was pending. */
  readonly attempts: number;
  /** When its latest code was made. */
  readonly added_at: number;
  /** When the code's email arrived and passed. */
  readonly confirmed_at: number | null;
  /** Who checks mail from it: the authserv-id on the chat mailbox provider's
   *  stamp on the code's email (`mx.zohomail.com`), or `''` for Microsoft's,
   *  which names none. `null` until confirmed. */
  readonly checked_by: string | null;
  /** Why it was not confirmed, once `failed`. */
  readonly failure: MailChatEnrolFailure | null;
}

export type MailChatEnrolFailure =
  /** The chat mailbox's provider put no sender check on it. */
  | 'no_check'
  /** The check on top is not the chat mailbox's provider's: the address's own
   *  mail server made it (a provider that checks nothing leaves that one on
   *  top), or it is not the stamp that provider is known to write. */
  | 'foreign_check'
  /** The provider found it was not sent by the address's domain's servers (a
   *  DMARC fail). */
  | 'failed_check'
  /** The check neither passed nor failed: no SPF or DKIM pass for exactly that
   *  domain, or the provider could not tell. */
  | 'no_pass'
  /** The code ran out before its email arrived. */
  | 'expired'
  /** Too many emails with a wrong code arrived from the address. */
  | 'too_many_attempts';

/** A country's second level, under which an organisation takes three labels
 *  (`example.co.uk`). Without the public suffix list, the common ones. */
const SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'gob', 'go', 'gov', 'mil', 'ne', 'net', 'or', 'org']);

/** D-318 step 8 — the organisation a checker's name belongs to: its last two
 *  labels, or three under a country's second level. A provider names each of
 *  its receiving hosts (`mx1.messagingengine.com`, `mx2.…`), so a request from
 *  an enrolled address is held to the provider, not to one host:
 *  `mx3.messagingengine.com` → `messagingengine.com`, `mail.example.co.uk` →
 *  `example.co.uk`. `''` (Microsoft's checker, which names none) stays `''`.
 *  ⚠ A heuristic: an organisation under a suffix this list does not know
 *  (`example.github.io`) reads as the suffix's. */
export const mailChatCheckerOrg = (name: string): string => {
  const labels = name.toLowerCase().split('.').filter((label) => label !== '');
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  return labels.slice(tld.length === 2 && SECOND_LEVEL.has(second) ? -3 : -2).join('.');
};

/** How many addresses the owner may enrol. */
export const MAIL_CHAT_ENROLLED_SENDERS_MAX = 5;
/** How long a code works. */
export const MAIL_CHAT_ENROL_CODE_TTL_MS = 30 * 60_000;
/** Wrong codes from the address before its enrolment fails. */
export const MAIL_CHAT_ENROL_ATTEMPTS_MAX = 5;
/** A code is this many digits: easy to type in a subject on a phone. */
export const MAIL_CHAT_ENROL_CODE_LENGTH = 6;

/** An address the owner may enrol: `local@domain.tld`, bare, at most 254
 *  characters, no spaces, quotes or brackets. */
export const isMailChatEnrollableAddress = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length <= 254
  && /^[^\s@"<>(),;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(value);

/** How many mailboxes the owner may name as theirs. */
export const MAIL_CHAT_OWNER_MAILBOXES_MAX = 10;

/** The `ask:` filter is on by default (P14). */
export const MAIL_CHAT_ASK_PREFIX_DEFAULT = 'ask:';
export const MAIL_CHAT_ASK_PREFIX_MAX_LENGTH = 32;

/** A prefix the owner may choose: 1–32 characters, on one line, without spaces at
 *  either end. */
export const isMailChatAskPrefix = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= MAIL_CHAT_ASK_PREFIX_MAX_LENGTH
  && value === value.trim()
  && !/[\r\n\t]/.test(value);

/** Stale requests: an hour by default (P16), from five minutes to a day. A
 *  day is the most there is: the proof refuses a Sent record more than a day
 *  from the request's arrival, so nothing older is run anyway. */
export const MAIL_CHAT_STALE_AFTER_MINUTES_DEFAULT = 60;
export const MAIL_CHAT_STALE_AFTER_MINUTES_MIN = 5;
export const MAIL_CHAT_STALE_AFTER_MINUTES_MAX = 24 * 60;

export const isMailChatStaleAfterMinutes = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isInteger(value)
  && value >= MAIL_CHAT_STALE_AFTER_MINUTES_MIN
  && value <= MAIL_CHAT_STALE_AFTER_MINUTES_MAX;

/** The burst guard (§4.9, P15): more than this many of the owner's requests
 *  reaching the chat mailbox within `MAIL_CHAT_BURST_WINDOW_MS` pause the door.
 *  A person writing does not get there; a mail rule, a script, or a mail app
 *  sending its outbox again does. */
export const MAIL_CHAT_BURST_MAX = 10;
export const MAIL_CHAT_BURST_WINDOW_MS = 60_000;

export const MAIL_CHAT_DOOR_DEFAULTS: MailChatDoorSettings = {
  chat_mailbox: null,
  ask_prefix: MAIL_CHAT_ASK_PREFIX_DEFAULT,
  owner_mailboxes: [],
  chat_address: null,
  stale_after_minutes: MAIL_CHAT_STALE_AFTER_MINUTES_DEFAULT,
  paused_at: null,
  enrolled_senders: [],
};

/** D-318 step 7 — one check before the door is switched on (§4.12): the chat
 *  mailbox can send and is synced, and each of the owner's mailboxes can be
 *  asked for its Sent record. `unknown` is a check that could not be made just
 *  now (a mailbox signing in again, its first sync still running): try again. */
export interface MailChatDoorCheck {
  readonly kind: 'chat_mailbox' | 'owner_mailbox';
  /** The mailbox's slug. */
  readonly slug: string;
  readonly status: 'pass' | 'fail' | 'unknown';
  /** What Recued found, in words the owner reads. */
  readonly text: string;
}

export interface MailChatDoorCheckResult {
  readonly checks: readonly MailChatDoorCheck[];
  /** Every check passed: the door can be switched on. */
  readonly ready: boolean;
}

/** D-318 step 7 — a request as the door saw it, newest first, for the test
 *  round trip (§4.12): where it got to, and why it stopped. ⛔ Never its
 *  subject or text: a forger writes those. */
export interface MailChatDoorRecentRequest {
  /** When Recued stored it. */
  readonly arrived_at: number;
  /** Its From address, bare. */
  readonly from: string;
  /** The proof: being checked, the owner's, not proven theirs, or set aside. */
  readonly state: 'pending' | 'proven' | 'not_proven' | 'ignored';
  /** Step 8 — how it was proven the owner's, once proven: their Sent record
   *  (a), or an enrolled address's passing sender check (b). */
  readonly proof: 'sent_record' | 'enrolled' | null;
  /** Why it was not proven or set aside (the proof's code), else `null`. */
  readonly reason: string | null;
  /** The hand-over to chat, once proven. */
  readonly chat: 'waiting' | 'admitted' | 'dropped' | 'gave_up' | null;
  /** Why chat did not take it, else `null`. */
  readonly chat_reason: string | null;
  /** Its sender check where it landed (§8.10): DMARC's verdict, or, where the
   *  stamp gives none (Zoho), an SPF or DKIM pass for exactly the From domain
   *  (step 8). */
  readonly sender_auth: 'pass' | 'fail' | 'unknown';
  /** Its first answer by email, once chat answered. */
  readonly answer: 'pending' | 'sending' | 'unknown' | 'sent' | 'failed' | 'dropped' | null;
  /** When that answer was sent. */
  readonly answered_at: number | null;
}

/** How many recent requests `collection.mail.chat_door.recent` answers with. */
export const MAIL_CHAT_RECENT_REQUESTS_MAX = 10;

/** D-318 step 3 — the vendor an email request's turn carries:
 *  `{ channel: 'messenger', actor: 'user_self', vendor: 'email', from }`, with the
 *  same grants and policy as a Slack or Telegram turn (§4.5, ruling 4).
 *
 *  ⚠ A CHAT DOOR, NOT A CHAT TRANSPORT. D-192 took `email` out of the transport
 *  vocabulary (`MESSENGER_VENDOR_SLUGS`): email has no `Transport`, and the
 *  notification channel `email` is a different thing that stays as it was. The
 *  door is a messenger vendor only on a turn's source
 *  (`MESSENGER_DOOR_VENDORS`, `isMessengerSourceVendor`). */
export const MAIL_CHAT_DOOR_VENDOR = 'email';

/** The chat session one conversation of the door runs in. The conversation id is
 *  Recued's own (§4.13), so a provider splitting a thread never splits it. */
export const mailChatSessionId = (chat_mailbox: string, conversation_id: string): string =>
  `mail:${chat_mailbox}:${conversation_id}`;

/** D-318 step 2 — proof (a): is one exact message in a mailbox's Sent source?
 *
 *  The door asks the owner's own mailbox, at the provider, whether it SENT the
 *  message that arrived in the chat mailbox: Gmail's `SENT` label, the IMAP
 *  Sent folder, Graph's `sentitems`. Only something holding that account can
 *  add to it. It is a lookup, not a sync: no Sent folder is added to a
 *  mailbox's synced folders, so no old sent mail is ever read as new. */
export interface MailSentByMessageIdQuery {
  /** The RFC 5322 Message-ID, without its angle brackets. */
  readonly rfc_message_id: string;
}

/** One Sent message carrying that Message-ID, as the provider recorded it. */
export interface MailSentByMessageIdMatch {
  /** Bare recipient addresses from its To. */
  readonly to: readonly string[];
  readonly subject: string;
  /** Unix ms, the provider's own time for it. */
  readonly sent_at: number;
}

/** At most this many Sent messages are read for one Message-ID. */
export const MAIL_SENT_BY_MESSAGE_ID_MAX_MATCHES = 5;

/** `not_found` is an observation, never proof of absence for long: a mail app
 *  saves its Sent copy a moment after sending, so the door asks again. */
export type MailSentByMessageIdResult =
  | { readonly status: 'found'; readonly matches: readonly MailSentByMessageIdMatch[] }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable'; readonly reason: 'unsupported' | 'provider_error' };

/** D-318 — has the chat mailbox already answered one request? The messages in
 *  its Sent source that REPLY to it (`In-Reply-To` its Message-ID), looked up at
 *  the provider as proof (a) is.
 *
 *  ⛔ A server restored from a backup, or a second copy of one, remembers none
 *  of the requests answered since; the chat mailbox's Sent folder does. Without
 *  asking it, such a server ran a request again (a second reminder, a second
 *  send) or told the owner it "did not act" on one that was acted on. */
export interface MailSentRepliesQuery {
  /** The request's RFC 5322 Message-ID, without its angle brackets. */
  readonly rfc_message_id: string;
}

/** One Sent reply to the request, as the provider recorded it. */
export interface MailSentReplyMatch {
  /** Its `x-recued-reconciliation-id`, when it carries one: an email chat
   *  answer's begins `mail-chat-answer:`. */
  readonly reconciliation_id: string | null;
  /** Unix ms, the provider's own time for it. */
  readonly sent_at: number;
}

/** At most this many Sent replies are read for one request. */
export const MAIL_SENT_REPLIES_MAX_MATCHES = 10;

/** `not_found` says only that no reply is there now. */
export type MailSentRepliesResult =
  | { readonly status: 'found'; readonly matches: readonly MailSentReplyMatch[] }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable'; readonly reason: 'unsupported' | 'provider_error' };
