/** D-318 step 3 — an email request, proven the owner's, becomes a chat turn.
 *
 *  The request runs in D-265's queue as a messenger message does, in the queue
 *  family `mail`, with `{ channel: 'messenger', actor: 'user_self', vendor:
 *  'email', from }`: the same grants and policy as a Slack or Telegram turn
 *  (§4.5, ruling 4). Approvals are raised as for any chat turn.
 *
 *  Its conversation is Recued's own (§4.13, `conversations.ts`): the session
 *  `mail:<chat mailbox>:<conversation>`, found through the Message-IDs the
 *  request refers to, or new.
 *
 *  ⛔ THE DOOR IS CHECKED AGAIN AT RUN TIME. A request queued before the owner
 *  changed or cleared the chat mailbox does not run, as a Slack turn queued
 *  before a rebind does not.
 *
 *  The text is the owner's own lines (step 4, `message-text.ts`): no quoted
 *  history, signature or mail-app footer. Mail the email forwards — or, starting
 *  a conversation, the email it replies to — is not the owner's words: the turn
 *  points the model at the email, to read with the mail tool, as mail.
 *
 *  ⛔ A FORWARD WHOSE MAIL WAS NOT FOUND GIVES NONE OF ITS TEXT AS THE OWNER'S.
 *  A mail app that marks its forward no way the door reads would otherwise hand
 *  the forwarded email to the model as the owner's own message. Its text goes
 *  as mail instead; only an email forwarded as a file leaves its text the
 *  owner's, since the mail it forwards is that file (§8.12).
 *
 *  Its attachments are the turn's files (step 4, `attachments.ts`), the
 *  signature's images left out; a request that is only a photo is still one.
 *
 *  Step 6 — ⛔ A REQUEST REACHED TOO LATE IS ANSWERED IN ONE LINE AND NOT RUN
 *  (§4.8, ruling 7, P16, P22): one older than the owner's setting
 *  (`stale_after_minutes`, from when the chat mailbox's provider received it),
 *  or one a recovery scan found. Decided as the turn runs, since a turn can
 *  wait in the queue and across a restart. The line is the turn's answer,
 *  without the model (`fixed_answer`): stored in the conversation and sent by
 *  email like any answer, so the owner is not left waiting, and a reply to it
 *  continues the conversation with the request in it.
 *
 *  The answer is stored in the conversation, where the web app shows it, and
 *  that commit owes it by email (step 5, `answers.ts`): sent from the chat
 *  mailbox, in the request's thread.
 *
 *  Spec: D-318 §4.5, §4.8, §4.13, §8 steps 3 and 6. */

import { createHash, randomUUID } from 'node:crypto';

import type { Channel, ChannelInbound, SurfaceTag } from '@recued/chat';
import {
  MAIL_CHAT_DOOR_VENDOR,
  mailChatSessionId,
  type ChatMessageAttachment,
  type CollectionRecord,
  type ExecutionSource,
} from '@recued/contracts';

import type { NotificationMessage } from '@recued/notification';

import type { ChatOrchestrator } from '../chat-orchestrator.js';
import type { MailCollection } from '../collections/mail/mail-collection.js';
import type { MailChatDoorStore } from '../storage/mail-chat-door-store.js';
import { isMailChatAnswerReconciliationId } from './conversation-mail.js';
import type { MailChatConversations } from './conversations.js';
import { subjectForwards, subjectIsForward, subjectReplies, subjectWithoutAsk } from './filters.js';
import { mailChatOwnLines } from './message-text.js';
import type { MailChatAdmit, MailChatAdmitOutcome } from './sent-proof.js';

/** The D-265 queue family the door's turns run in. */
export const MAIL_CHAT_QUEUE_FAMILY = 'mail';
/** The surface the door's turns carry, as a Slack turn carries `messenger-slack`. */
export const MAIL_CHAT_SURFACE: SurfaceTag = `messenger-${MAIL_CHAT_DOOR_VENDOR}`;
/** A conversation's title is the subject of its first request, cut to this. */
const TITLE_MAX = 120;
/** The same words this many times in a row in a conversation are not run: the
 *  loop backstop (§4.7), now that a repeat replying to another message runs. */
export const MAIL_CHAT_REPEATS_MAX = 3;

/** The part of a mailbox the turns read. */
export type MailChatTurnsMailbox = Pick<MailCollection, 'platform' | 'slug' | 'accountEmail' | 'get' | 'lookupSentReplies'>;

export interface ComposeMailChatTurnsDeps {
  /** The queued chat orchestrator: its `turnQueue`, `runMessengerTurn` and the
   *  session store chat shares. Without a queue the door has nowhere to go. */
  readonly orchestrator: Pick<ChatOrchestrator, 'turnQueue' | 'runMessengerTurn' | 'sessionStore'>;
  readonly door: Pick<MailChatDoorStore, 'isChatMailbox' | 'get'>;
  /** Every connected mailbox, read at each hand-over. */
  readonly mailboxes: () => readonly MailChatTurnsMailbox[];
  /** A stored email's body, inline or from the blob store. */
  readonly readBody: (record: CollectionRecord) => Promise<string | null>;
  readonly conversations: MailChatConversations;
  /** Whether a chat conversation still exists: a reply to one the owner
   *  deleted starts a new one. Absent ⇒ every recorded conversation exists. */
  readonly sessionExists?: (session_id: string) => boolean;
  /** Step 5 — a turn ended: the answer it stored is owed by email. */
  readonly afterTurn?: () => void;
  /** Step 6 — the owner's IANA zone, read per turn, for the time a late
   *  request arrived. Absent ⇒ the host's. */
  readonly timeZone?: () => string;
  readonly newConversationId?: () => string;
  readonly now?: () => number;
  readonly log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
}

export interface MailChatTurns {
  /** The proof's hand-over (`MailChatSentProof.bindAdmit`): queue the turn. */
  readonly admit: MailChatAdmit;
}

/** `Re: Fwd: ask: Lunch` → `Lunch`: the subject without its reply and forward
 *  prefixes, and without the `ask:` prefix (step 4). */
export const mailChatTitle = (subject: string, ask_prefix: string | null = null): string => {
  let title = subject.trim();
  for (let previous = ''; previous !== title;) {
    previous = title;
    title = title.replace(/^(re|fwd?|fw)\s*:\s*/i, '');
  }
  title = subjectWithoutAsk(title, ask_prefix).replace(/\s+/g, ' ').trim();
  return title.length === 0 ? 'Email' : title.slice(0, TITLE_MAX);
};

/** What an email that starts a conversation asks in its subject, in front of
 *  its body (`body`, the owner's own lines): the subject past the `ask:`
 *  prefix, or `null`. Not a reply's or a forward's subject, which is someone's
 *  mail, and not one the body already begins with. */
export const mailChatSubjectLead = (
  subject: string,
  ask_prefix: string | null,
  body: string,
): string | null => {
  const rest = subjectWithoutAsk(subject, ask_prefix);
  if (rest.length === 0 || subjectReplies(subject) || subjectIsForward(subject, ask_prefix)) return null;
  if (subjectReplies(rest) || subjectForwards(rest)) return null;
  const words = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
  return words(body).startsWith(words(rest)) ? null : rest;
};

const bareAddress = (address: string): string => {
  const angled = /<([^<>]+)>/.exec(address);
  return (angled?.[1] ?? address).trim().toLowerCase();
};

const dropped = (reason: string): MailChatAdmitOutcome => ({ outcome: 'dropped', reason });

/** What an owner who forwarded mail with no word of their own is taken to say. */
const FORWARDED_ONLY = '(forwarded email)';

/** What the owner is told when the loop backstop holds an email back: it may
 *  be theirs, and it would otherwise wait for an answer in vain. Never the
 *  email's words. */
export const mailChatRepeatNotice = (chat: string): NotificationMessage => ({
  title: 'An email to your chat mailbox was not answered',
  text: `An email to your chat mailbox, ${chat}, said the same as the two before it in its conversation, `
    + 'so Recued did not answer it: that is what an automatic reply sent again and again looks like. '
    + 'If you sent it, write it a little differently.',
});

/** Step 6 — why a request is not run: a recovery scan found it, or it was
 *  reached later than the owner's setting allows; `null` when it runs. */
export const mailChatLateness = (
  request: { readonly received_at?: number; readonly recovered?: boolean },
  stale_after_minutes: number,
  at: number,
): 'recovered' | 'stale' | null => {
  if (request.recovered === true) return 'recovered';
  if (typeof request.received_at === 'number' && at - request.received_at > stale_after_minutes * 60_000) return 'stale';
  return null;
};

const durationWords = (minutes: number): string => {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'a day' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'an hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
};

/** "at 08:02", or "at 08:02 on 14 October" for another day, on the owner's
 *  clock. A zone the host cannot read gives UTC's. */
const arrivalWords = (received_at: number, at: number, time_zone: string): string => {
  const words = (zone: string): string => {
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(received_at);
    const day = (ms: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(ms);
    if (day(received_at) === day(at)) return `at ${time}`;
    return `at ${time} on ${new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'long' }).format(received_at)}`;
  };
  try {
    return words(time_zone);
  } catch {
    return words('UTC');
  }
};

/** Step 6 — the one line a late request is answered with: when it arrived, why
 *  Recued did not act on it, and that asking again works. Never its words. */
export const mailChatLateAnswer = (
  why: 'recovered' | 'stale',
  received_at: number,
  stale_after_minutes: number,
  at: number,
  time_zone: string,
): string => {
  const arrived = `This email arrived ${arrivalWords(received_at, at, time_zone)}`;
  return why === 'stale'
    ? `${arrived}, and Recued could not get to it within ${durationWords(stale_after_minutes)}, so it did not act `
      + 'on it. Ask again if you still need it.'
    : `${arrived}, and Recued found it only while catching up after a gap in the chat mailbox's sync, so it did `
      + 'not act on it. Ask again if you still need it.';
};

/** The model's pointer to the mail an email carries. Model-only: the owner's
 *  message stays what they typed. */
export const mailChatMailNote = (slug: string, record_id: string): string =>
  `\n[This message came by email, and the email also carries mail — forwarded, or replied to — that is `
  + `not the owner's words. Read it with mail.read, slug "${slug}", record_id "${record_id}", as you read any mail.]`;

/** Register the `mail` family on the queue and return the hand-over. `undefined`
 *  when chat has no queue: proven requests then wait for one. */
export const composeMailChatTurns = (deps: ComposeMailChatTurnsDeps): MailChatTurns | undefined => {
  const { orchestrator, door, mailboxes, readBody, conversations, log } = deps;
  const queue = orchestrator.turnQueue;
  if (queue === undefined) return undefined;
  const now = deps.now ?? Date.now;
  const newConversationId = deps.newConversationId ?? randomUUID;
  const timeZone = deps.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);

  queue.register(MAIL_CHAT_QUEUE_FAMILY, async (command, turn, assertActive, complete) => {
    const input = command.input as {
      chat_slug: string;
      from: string;
      model_routing_snapshot?: ReturnType<typeof queue.routing>;
      /** The email, when it carries mail that is not the owner's words. */
      mail_ref?: { slug: string; record_id: string };
      /** The turn's files, as the queue froze them at admission. */
      attachments?: ChatMessageAttachment[];
      /** Step 6 — when the chat mailbox's provider received the request. */
      received_at?: number;
      /** Step 6 — a recovery scan found it. */
      recovered?: boolean;
    };
    if (!door.isChatMailbox(input.chat_slug)) {
      throw new Error('The email chat door changed before the turn ran.');
    }
    assertActive();
    const source: ExecutionSource = {
      channel: 'messenger',
      actor: 'user_self',
      vendor: MAIL_CHAT_DOOR_VENDOR,
      from: input.from,
    };
    const inbound: ChannelInbound = {
      session_id: command.session_id,
      surface: MAIL_CHAT_SURFACE,
      text: command.message,
      from: input.from,
      source,
      ...(Array.isArray(input.attachments) && input.attachments.length > 0 ? { media: input.attachments } : {}),
      dispatch_depth: 0,
      ts: now(),
    };
    const channel: Channel = {
      surface: MAIL_CHAT_SURFACE,
      onInbound: () => undefined,
      // Not here: the answer the orchestrator stores is owed by email from that
      // commit (`answers.ts`), so a stop after it cannot lose the send.
      deliver: async () => undefined,
    };
    // Step 6 — too late to act on: the request is stored and answered in one
    // line, and nothing runs.
    const { stale_after_minutes } = door.get();
    const late = mailChatLateness(input, stale_after_minutes, now());
    await orchestrator.runMessengerTurn({
      channel,
      sessionStore: orchestrator.sessionStore,
      inbound,
      queue_turn_id: turn,
      assert_active: assertActive,
      complete_turn: complete,
      model_routing_snapshot: input.model_routing_snapshot,
      ...(late !== null
        ? { fixed_answer: mailChatLateAnswer(late, input.received_at ?? now(), stale_after_minutes, now(), timeZone()) }
        : input.mail_ref ? { model_note: mailChatMailNote(input.mail_ref.slug, input.mail_ref.record_id) } : {}),
    });
    deps.afterTurn?.();
    return { turn_id: turn };
  });

  const admit: MailChatAdmit = async (request) => {
    const { chat_slug, rfc_message_id } = request;
    if (!door.isChatMailbox(chat_slug)) return dropped('the door no longer names this chat mailbox');
    const chat = mailboxes().find((mailbox) => mailbox.platform === 'mail' && mailbox.slug === chat_slug);
    // At boot the chat mailbox may not be registered yet: asked again later.
    if (chat === undefined) throw new Error('The chat mailbox is not connected.');
    const record = chat.get(request.record_id);
    if (record === null) return dropped('the email is no longer in the chat mailbox');

    const native_receipt = {
      vendor: MAIL_CHAT_DOOR_VENDOR,
      recipient: chat_slug,
      message_id: rfc_message_id,
      account: bareAddress(chat.accountEmail),
    };
    // The owner deleted the conversation this very message started: it stays
    // gone — and nothing is recorded for it.
    const admittedBefore = queue.nativeSession(native_receipt);
    if (admittedBefore === null) return dropped('its conversation was deleted');

    // ⛔ Already answered from the chat mailbox, by a server this one does not
    // remember being: restored from a backup, or a second copy. Its answer is
    // in the chat mailbox's Sent folder, a reply to it carrying an answer's
    // reconciliation id; running it again would act twice, and answering it
    // "too late" would say Recued did not act when it did. Asked only the
    // first time this server sees the request: a hand-over repeated after a
    // crash is the queue's to dedupe.
    if (admittedBefore === undefined) {
      const replies = await chat.lookupSentReplies({ rfc_message_id });
      if (replies.status === 'found'
        && replies.matches.some((match) => isMailChatAnswerReconciliationId(match.reconciliation_id))) {
        return dropped('already answered: its answer is in the chat mailbox\'s Sent folder');
      }
      // A Sent folder that could not be read is asked again with the hand-over;
      // one that cannot be asked at all (IMAP without one) never could be.
      if (replies.status === 'unavailable' && replies.reason === 'provider_error') {
        throw new Error('The chat mailbox\'s Sent folder could not be read.');
      }
    }

    // Its conversation: the one it was already given (a repeated hand-over),
    // else the one a message it refers to is in — while that conversation still
    // exists — else a new one.
    const referred = conversations.find(chat_slug, request.references);
    const continued = referred !== null
      && (deps.sessionExists?.(mailChatSessionId(chat_slug, referred)) ?? true) ? referred : null;
    const conversation = conversations.record(
      chat_slug,
      rfc_message_id,
      conversations.conversationOf(chat_slug, rfc_message_id) ?? continued ?? newConversationId(),
      'request',
      now(),
    );
    const session_id = mailChatSessionId(chat_slug, conversation);

    const subject = typeof record.hot_fields.subject === 'string' ? record.hot_fields.subject : '';
    const { ask_prefix } = door.get();
    // The owner's own lines — from the HTML when the email had one (read as it
    // landed: it marks signatures and quotes, and Outlook's plain text is one
    // line), else from its text. Quoted text in a conversation that continues
    // is the conversation itself; anything else cut is mail, a forward's mail
    // is mail even in a conversation, and so is an attached email the parser
    // wrote into the text.
    const forwarded = subjectIsForward(subject, ask_prefix);
    const body = request.html_text ?? (await readBody(record)) ?? '';
    const own = mailChatOwnLines(body, { continuing: continued !== null, forwarded });
    const htmlCut = request.html_cut;
    let mailCut = own.mail_cut || htmlCut === 'mail'
      || (htmlCut !== 'none' && (forwarded || continued === null));
    // ⛔ A forward gives none of its text as the owner's unless the HTML or the
    // text showed where the forwarded mail begins. A signature alone does not:
    // it may be the forwarded email's. The exception is an email forwarded as
    // a file: the mail is that file.
    const found = own.mail_cut || htmlCut === 'quote' || htmlCut === 'mail';
    const unfound = forwarded && !found && !request.attached_email;
    if (unfound) mailCut = true;
    // An email may ask in its subject alone, which is then what was asked —
    // unless what follows the `ask:` prefix is a forwarded email's subject, or
    // (starting a conversation) the subject of the email replied to: that is
    // someone's mail, not the owner's words.
    let asked = unfound ? '' : own.text;
    if (asked.length === 0) {
      const rest = subjectWithoutAsk(subject, ask_prefix);
      if (subjectForwards(rest) || (continued === null && subjectReplies(rest))) mailCut = true;
      else asked = rest;
    } else if (continued === null) {
      // ⛔ An email that starts a conversation asks in its subject AND its
      // body: `ask: remind me in 2 minutes…` over "testing 2 for reminder"
      // asked for a reminder, and the model, given the body alone, asked what
      // was wanted (live, 2026-10-15, twice). A reply keeps to its body: its
      // subject is the conversation's.
      const lead = mailChatSubjectLead(subject, ask_prefix, asked);
      if (lead !== null) asked = `${lead}\n\n${asked}`;
    }
    const text = asked.length > 0 ? asked : mailCut ? FORWARDED_ONLY : '';
    // A photo with nothing written is still a request: chat asks what to do with it.
    if (text.length === 0 && request.files.length === 0) return dropped('the email has no text');
    // The loop backstop: the same words a third time in a row are not run — an
    // auto-responder that ignores every automatic-mail header looks like this.
    const sameWords = createHash('sha256').update(text)
      .update(JSON.stringify(request.files.map((file) => file.file_id))).digest('hex');
    if (conversations.repeats(chat_slug, conversation, rfc_message_id, sameWords, now()) >= MAIL_CHAT_REPEATS_MAX) {
      return {
        outcome: 'dropped',
        reason: 'the same words a third time in a row: not run, in case it is a loop',
        notice: mailChatRepeatNotice(bareAddress(chat.accountEmail)),
      };
    }

    queue.ensureSession(session_id, mailChatTitle(subject, ask_prefix));
    const model_routing_snapshot = queue.routing(session_id);
    const ack = await queue.submit({
      family: MAIL_CHAT_QUEUE_FAMILY,
      session_id,
      message: text,
      input: {
        chat_slug, rfc_message_id, record_id: request.record_id, from: request.from_address, model_routing_snapshot,
        ...(mailCut ? { mail_ref: { slug: chat_slug, record_id: request.record_id } } : {}),
        ...(request.files.length > 0 ? { attachments: request.files.map((file) => ({ ...file })) } : {}),
        received_at: request.received_at,
        ...(request.recovered ? { recovered: true } : {}),
      },
      // The same words twice in a row in a conversation run once (D-265) — the
      // same email sent twice. With other files, or replying to another
      // message ("yes" to one question, then "yes" to the next), they are
      // another request, as a Slack or Telegram reply is.
      comparison: {
        vendor: MAIL_CHAT_DOOR_VENDOR, from: request.from_address, text, model_routing_snapshot,
        files: request.files.map((file) => file.file_id),
        in_reply_to: request.references[0] ?? null,
      },
      native_receipt,
    }, `mail:${chat_slug}:${rfc_message_id}`);
    log?.('info', 'chat mailbox request queued as a chat turn', {
      chat_slug, session_id, turn_id: ack.turn_id, disposition: ack.disposition,
    });
    return { outcome: 'admitted' };
  };

  return { admit };
};
