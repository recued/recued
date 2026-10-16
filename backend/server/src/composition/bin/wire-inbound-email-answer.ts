/** D-158 P2b inbound-email-answer funnel — the reply-by-email path, with the
 *  sender proven (D-318 P23, 2026-10-14).
 *
 *  An ask goes out by email from the notification account's send-capable
 *  mailbox (`sender_mail_instance`) to the owner's notification address
 *  (`default_recipient`), with `[#ask-…]` in its subject. The owner replies
 *  with an option. Until P23 a reply was trusted because it *"arrived in the
 *  user's own mirrored inbox"* — and the sync authenticates nothing (D-315
 *  ruling 3), so any message in that mailbox with an open ask's tag and an
 *  option's text answered it, whoever sent it.
 *
 *  ⛔ A REPLY ANSWERS AN ASK ONLY WHEN IT IS PROVEN THE OWNER'S, one of two
 *  ways — the same two D-318 §4.2 sets for its chat door:
 *
 *    (a) the owner's own Sent record. The reply is the Sent copy in a mailbox
 *        Recued reads, by the provider's own record (Gmail's `SENT`, the IMAP
 *        Sent folder, Graph's `sentitems` — `CanonicalMessage.direction`),
 *        addressed to the notification mailbox. Only something holding that
 *        account can add to its Sent record. The STORED direction will not do:
 *        it reads `outbound` whenever From equals the account
 *        (`resolveMailMessageDirection`), and From is anyone's to write. That
 *        is why this runs as a mail upsert hook, where the provider's record is
 *        still in hand, instead of re-reading the stored row as it used to.
 *    (b) a DMARC pass for the owner's notification address. The reply arrives
 *        in the notification mailbox, its From is `default_recipient`, and the
 *        receiving provider's `Authentication-Results` stamp says `dmarc=pass`
 *        for that address's domain. The header map keeps a header's FIRST
 *        value (`mailHeaderMap`), and a receiver prepends its stamp, so a
 *        sender's planted stamp further down is never the one read. No stamp,
 *        no pass. And (D-318 step 8) a pass is read only from a stamp that
 *        parses cleanly, so a sender's address written into the receiver's own
 *        stamp cannot read as one (`authentication-results.ts`).
 *
 *  Everything else is ignored, and the ask stays open, answerable in the web
 *  app (the always-on `ui` channel).
 *
 *  ⛔ NEWS ONLY. A mailbox's first backfill, a restart's re-list, or mail older
 *  than its window answers nothing (`mailMayTrigger`), as no mail fact fires
 *  from them. Recued's own mail (a reconciliation id) and drafts never count.
 *
 *  ⚠ The hook is bound by the listeners' composition (it needs the
 *  notification block), after the mailboxes have started. `createLateEmailAnswerHook`
 *  keeps the approval-tagged messages a boot scan reads before then and hands
 *  them over when it is bound, so a reply sent while the server was off is
 *  still checked.
 *
 *  Per message: the `[#ask-…]` tag → a proof → the open ask's options →
 *  `parseEmailReply` exact-matches one ("do not approve" never matches
 *  `approve`) → `block.submitAnswer`, whose first-answer-wins dedup (I-6) makes
 *  a second sighting a no-op.
 *
 *  Spec: D-158 § P2 / A.4 / I-9; D-318 §2.4, P23;
 *  leaf: `channels/email.ts` (`extractAskId` / `parseEmailReply`); outbound
 *  peer: `wire-email-channel.ts`. */

import { isMailReconciliationId } from '@recued/contracts';
import {
  extractAskId,
  parseEmailReply,
  type NotificationBlock,
} from '@recued/notification';

import { dmarcPassFor } from '../../collections/mail/authentication-results.js';
import type { MailUpsertContext } from '../../collections/mail/mail-collection.js';
import type { CanonicalMessage } from '../../collections/mail/provider.js';
import { mailMayTrigger } from '../../mail-facts/mail-ingest.js';

/** Who sends asks and who answers them, read from the
 *  `connection.notification.email` record at each message. */
export interface EmailAnswerAccounts {
  /** The mailbox asks are sent from, and replies arrive in. */
  readonly sender_slug: string;
  /** That mailbox's own address. */
  readonly sender_address: string;
  /** The owner's notification address — where asks are sent. */
  readonly recipient_address: string;
}

export type EmailAnswerProof = 'own_sent_record' | 'dmarc_pass';

/** `"Ann" <Ann@Example.com>` → `ann@example.com`. */
const bareAddress = (address: string): string => {
  const angled = /<([^<>]+)>/.exec(address);
  return (angled?.[1] ?? address).trim().toLowerCase();
};

const domainOf = (address: string): string => {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1);
};

/** Does an `Authentication-Results` value (RFC 8601) report a DMARC pass for
 *  `domain`? Shared with the email chat door (`authentication-results.ts`). */
export { dmarcPassFor } from '../../collections/mail/authentication-results.js';

/** How a message proves it is the owner's reply, or `null` when it does not. */
export const emailAnswerProof = (
  msg: CanonicalMessage,
  ctx: Pick<MailUpsertContext, 'slug'>,
  accounts: EmailAnswerAccounts,
): EmailAnswerProof | null => {
  if (isMailReconciliationId(msg.reconciliation_id) || msg.direction === 'draft') return null;
  const sender = bareAddress(accounts.sender_address);
  const recipient = bareAddress(accounts.recipient_address);
  if (sender === '' || recipient === '') return null;

  // (a) The Sent copy in another mailbox Recued reads, by the provider's record.
  if (msg.direction === 'outbound') {
    if (ctx.slug === accounts.sender_slug) return null;
    return msg.to.some((address) => bareAddress(address) === sender) ? 'own_sent_record' : null;
  }

  // (b) In the notification mailbox, from the owner's address, DMARC-passed.
  if (ctx.slug !== accounts.sender_slug) return null;
  if (bareAddress(msg.from) !== recipient) return null;
  return dmarcPassFor(msg.headers?.['authentication-results'], domainOf(recipient)) ? 'dmarc_pass' : null;
};

export interface ComposeInboundEmailAnswerDeps {
  /** D-158 notification block — `getAsk(ask_id)` supplies the ask's options,
   *  `submitAnswer(reply)` is the funnel target. Absent ⇒ inert. */
  block?: NotificationBlock;
  /** The accounts, re-read per message so a re-enrollment is picked up
   *  without a restart. `null` ⇒ email asks are not set up ⇒ ignored.
   *  Absent ⇒ inert. */
  resolveAccounts?: () => EmailAnswerAccounts | null;
  now?: () => number;
  log?: (
    level: 'info' | 'warn',
    msg: string,
    data?: Record<string, unknown>,
  ) => void;
}

export interface InboundEmailAnswerFunnel {
  /** The mail upsert hook: a proven reply answers its open ask. Never throws;
   *  the answer is submitted in the background. */
  onMessageUpserted(msg: CanonicalMessage, ctx: MailUpsertContext): void;
  /** Close admission and await every answer already being submitted.
   *  Idempotent and coalesced. */
  dispose(): Promise<void>;
}

export const composeInboundEmailAnswer = (
  deps: ComposeInboundEmailAnswerDeps,
): InboundEmailAnswerFunnel => {
  const { block, resolveAccounts, log } = deps;
  const now = deps.now ?? Date.now;
  const inFlight = new Set<Promise<void>>();
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  if (block === undefined || resolveAccounts === undefined) {
    log?.('info', 'inbound email answer funnel inert — missing deps');
  }

  const answer = async (
    msg: CanonicalMessage,
    ask_id: string,
    proof: EmailAnswerProof,
  ): Promise<void> => {
    const ask = await block!.getAsk(ask_id);
    if (ask === null || ask.status !== 'open') return;
    const reply = parseEmailReply({ subject: msg.subject, body_text: msg.body_text }, ask.options);
    if (reply === null) return;
    await block!.submitAnswer(reply);
    log?.('info', 'inbound email reply recorded', { ask_id, option: reply.option, proof });
  };

  return {
    onMessageUpserted(msg, ctx): void {
      if (disposed || block === undefined || resolveAccounts === undefined) return;
      const ask_id = extractAskId(msg.subject);
      if (ask_id === null) return;
      if (!mailMayTrigger(msg, ctx, now())) return;
      const accounts = resolveAccounts();
      if (accounts === null) return;
      const proof = emailAnswerProof(msg, ctx, accounts);
      if (proof === null) {
        // Only a would-be reply in the notification mailbox is worth a line:
        // the same tag in another mailbox's inbox is the ask itself, delivered.
        if (ctx.slug === accounts.sender_slug && msg.direction !== 'outbound') {
          log?.('warn', 'inbound email reply ignored: not proven to be from the owner', { ask_id });
        }
        return;
      }
      let tracked!: Promise<void>;
      tracked = answer(msg, ask_id, proof).catch((error) => {
        log?.('warn', 'inbound email answer funnel — answer failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => {
        inFlight.delete(tracked);
      });
      inFlight.add(tracked);
    },
    dispose(): Promise<void> {
      if (disposePromise !== undefined) return disposePromise;
      disposed = true;
      disposePromise = Promise.all([...inFlight]).then(() => undefined);
      return disposePromise;
    },
  };
};

/** How many approval-tagged messages wait for the hook to be bound. A boot scan
 *  reads at most what came while the server was off; past this, the oldest
 *  wait is dropped and its ask stays open in the web app. */
const LATE_HOOK_PENDING_MAX = 50;

/** The holder the mail stack calls on every upsert, bound later by the
 *  listeners' composition. Until then it keeps only messages carrying an ask
 *  tag, and hands them to the hook when it is bound. */
export interface LateEmailAnswerHook {
  run(msg: CanonicalMessage, ctx: MailUpsertContext): void;
  bind(hook: (msg: CanonicalMessage, ctx: MailUpsertContext) => void): void;
}

export const createLateEmailAnswerHook = (): LateEmailAnswerHook => {
  let current: ((msg: CanonicalMessage, ctx: MailUpsertContext) => void) | undefined;
  let pending: Array<[CanonicalMessage, MailUpsertContext]> = [];
  return {
    run(msg, ctx) {
      if (current !== undefined) {
        current(msg, ctx);
        return;
      }
      if (extractAskId(msg.subject) === null) return;
      pending.push([msg, ctx]);
      if (pending.length > LATE_HOOK_PENDING_MAX) pending.shift();
    },
    bind(hook) {
      current = hook;
      const waiting = pending;
      pending = [];
      for (const [msg, ctx] of waiting) hook(msg, ctx);
    },
  };
};
