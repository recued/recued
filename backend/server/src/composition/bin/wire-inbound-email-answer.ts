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
 *    (c) one address (D-158 amendment 2026-10-18): the notification mailbox's
 *        own Sent record, addressed to itself, when the connection names no
 *        other recipient — the owner reads the mailbox Recued sends from, so
 *        they answer from it. (a)'s footing: only someone holding the account
 *        adds to its Sent record. Recued's own sends land in that same Sent
 *        record, and each carries a reconciliation id, so none is read as a
 *        reply (below). The copy delivered to the inbox (Graph, IMAP) is not
 *        the proof; Gmail keeps one message carrying both labels.
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

import { isMailReconciliationId, type ConnectionRow } from '@recued/contracts';
import {
  extractAskId,
  emailReplyText,
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
  readonly connection_name?: string;
  readonly connection_enrolled_at?: number;
  /** The mailbox asks are sent from, and replies arrive in. */
  readonly sender_slug: string;
  /** That mailbox's own address. */
  readonly sender_address: string;
  /** The owner's notification address — where asks are sent. */
  readonly recipient_address: string;
}

export type EmailAnswerProof = 'own_sent_record' | 'dmarc_pass' | 'self_sent_record';

/** The accounts an email notification connection names: the mailbox asks go
 *  from, its address, and the recipient — `default_recipient`, or, when the
 *  connection names none, that mailbox itself (D-158 amendment 2026-10-18:
 *  one address, the owner answers from the mailbox they read). Null for
 *  another subtype, a malformed config, several recipients, or a part whose
 *  address is unknown. */
export const emailAnswerAccountsOf = (
  record: Pick<ConnectionRow, 'name' | 'enrolled_at' | 'subtype' | 'config_json'>,
  mailboxAddress: (slug: string) => string | undefined,
): EmailAnswerAccounts | null => {
  if (record.subtype !== undefined && record.subtype !== 'email') return null;
  let cfg: { sender_mail_instance?: unknown; default_recipient?: unknown };
  try { cfg = JSON.parse(record.config_json) as typeof cfg; }
  catch { return null; }
  const sender_slug = typeof cfg.sender_mail_instance === 'string' ? cfg.sender_mail_instance : '';
  const sender_address = sender_slug ? mailboxAddress(sender_slug) ?? '' : '';
  const configured = cfg.default_recipient;
  const blank = configured === undefined || configured === null || configured === ''
    || Array.isArray(configured) && configured.length === 0;
  const recipient_address = blank ? sender_address
    : typeof configured === 'string' ? configured
      : Array.isArray(configured) && configured.length === 1 && typeof configured[0] === 'string' ? configured[0] : '';
  return !sender_address || !recipient_address ? null : { sender_slug, sender_address, recipient_address,
    connection_name: record.name, connection_enrolled_at: record.enrolled_at };
};

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
  // (c) One address: the notification mailbox is the owner's own, so their
  // reply is its Sent copy, addressed to itself. Recued's own sends there carry
  // a reconciliation id and were turned away above.
  if (msg.direction === 'outbound') {
    const toSender = msg.to.some((address) => bareAddress(address) === sender);
    if (ctx.slug === accounts.sender_slug) return sender === recipient && toSender ? 'self_sent_record' : null;
    return toSender ? 'own_sent_record' : null;
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
  resolveAccounts?: (connection_name?: string) => EmailAnswerAccounts | null;
  /** A reply to a plain ask is checked against the connection that ask went
   *  through: the owner's choice for email (`createOwnerEmailConnection`).
   *  Absent ⇒ `resolveAccounts()`, the record named `email`. */
  resolveOwnerAccounts?: () => Promise<EmailAnswerAccounts | null>;
  /** Authenticate against enrolled notification mailboxes before loading any
   * ask. Production supplies all named email rows; legacy embedders use one. */
  resolveAccountCandidates?: () => readonly EmailAnswerAccounts[];
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
    ctx: MailUpsertContext,
  ): Promise<void> => {
    await block!.restoreAskDeliveries();
    const ask = await block!.getAsk(ask_id);
    if (ask === null) return;
    if (!ask.delivery_group_id && ask.status !== 'open') return;
    const destinations = ask.delivery_group_id
      ? (await block!.getAskDeliveryDestinations(ask.delivery_group_id)).filter(item => item.channel === 'email') : [];
    const candidates = ask.delivery_group_id
      ? destinations.map(destination => ({ destination, accounts: resolveAccounts!(destination.connection_name) }))
      : [{ destination: undefined, accounts: deps.resolveOwnerAccounts ? await deps.resolveOwnerAccounts() : resolveAccounts!() }];
    const authorized = candidates.map(candidate => ({ ...candidate,
      proof: candidate.accounts ? emailAnswerProof(msg, ctx, candidate.accounts) : null,
    })).find(candidate => candidate.proof !== null && (!candidate.destination || (!!candidate.accounts
      && candidate.accounts.connection_name === candidate.destination.connection_name
      && candidate.accounts.connection_enrolled_at === candidate.destination.connection_enrolled_at
      && candidate.accounts.sender_slug === candidate.destination.sender_source
      && bareAddress(candidate.accounts.recipient_address) === candidate.destination.recipient
      && bareAddress(msg.from) === candidate.destination.expected_sender)));
    if (!authorized) {
      log?.('warn', 'inbound email reply ignored: not proven for this notification destination', { ask_id });
      return;
    }
    const { proof, destination } = authorized;
    const reply = ask.delivery_group_id
      ? await block!.parseAskBundleReply(ask.delivery_group_id, emailReplyText(msg.body_text), 'email')
      : parseEmailReply({ subject: msg.subject, body_text: msg.body_text }, ask.options);
    if (reply === null) return;
    const outcome = await block!.submitAnswer({ ...reply, via: 'email', ...(destination ? { origin: {
      connection_name: destination.connection_name!, connection_enrolled_at: destination.connection_enrolled_at!,
      recipient: destination.recipient!, sender: bareAddress(msg.from),
    } } : {}) });
    // D-325 §5.1 — a reminder answered after it closed changed nothing. Email
    // cannot say so in place, so the reply joins the unmatched ones in Today and Yours.
    if (outcome === 'closed') await block!.recordLateAskReply(reply.ask_id, 'email', emailReplyText(msg.body_text));
    log?.('info', 'inbound email reply recorded', { ask_id: reply.ask_id, option: reply.option, proof });
  };

  return {
    onMessageUpserted(msg, ctx): void {
      if (disposed || block === undefined || resolveAccounts === undefined) return;
      const ask_id = extractAskId(msg.subject);
      if (ask_id === null) return;
      if (!mailMayTrigger(msg, ctx, now())) return;
      const accounts = deps.resolveAccountCandidates?.()
        ?? [resolveAccounts()].filter((item): item is EmailAnswerAccounts => item !== null);
      if (accounts.length === 0) return;
      if (!accounts.some(account => emailAnswerProof(msg, ctx, account) !== null)) {
        // With one address the inbox holds Recued's own notification and the
        // delivered copy of the owner's reply, whose Sent copy is the proof:
        // neither is a reply worth a warning.
        const deliveredToItself = (account: EmailAnswerAccounts): boolean =>
          bareAddress(account.sender_address) === bareAddress(account.recipient_address)
          && bareAddress(msg.from) === bareAddress(account.sender_address);
        if (accounts.some(account => account.sender_slug === ctx.slug && !deliveredToItself(account))
          && msg.direction !== 'outbound') {
          log?.('warn', 'inbound email reply ignored: not proven to be from the owner', { ask_id });
        }
        return;
      }
      let tracked!: Promise<void>;
      tracked = answer(msg, ask_id, ctx).catch((error) => {
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
