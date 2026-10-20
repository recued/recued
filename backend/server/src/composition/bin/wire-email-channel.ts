/** D-158 P2b / D-163 — email notification `Channel` composer.
 *
 *  The server-wiring slice for the `channels/email.ts` leaf
 *  (`@recued/notification`). The leaf ships the `Channel` adapter + the
 *  inbound parse functions but leaves two seams for the server: the real
 *  `EmailSender`, and (a separate follow-on) the inbound
 *  `data.mail`-watcher → `parseEmailReply` → `block.submitAnswer` funnel.
 *  This file wires the OUTBOUND seam — `deliverNotify` / `deliverAsk`
 *  send through the user's BYO mail account.
 *
 *  Unlike Slack / Telegram (`composeSlackChannel` / `composeTelegramChannel`),
 *  email is NOT a `@recued/transport` `RemoteChannel`: email is not raw
 *  HTTP send/poll plumbing, it rides the user's mail account. So the
 *  composer builds a plain `Channel` via `createEmailChannel` and injects
 *  an `EmailSender` that:
 *    1. resolves the `connection.notification.email` record at SEND time
 *       (so a re-enrollment is picked up without a restart — mirrors the
 *       D-125 connection-notification handler's per-dispatch resolve),
 *    2. reads `sender_mail_instance` (the BYO send-capable mail account)
 *       + `default_recipient` (the notification delivery address) from its
 *       config. D-158 amendment 2026-10-18: with no `default_recipient` the
 *       notification goes to the sending mailbox itself — the owner's
 *       one-address setup — through `mailRpc.sendToOwner`, the one seam that
 *       may address it, which stamps the send so its copy in the mailbox is
 *       Recued's own,
 *    3. hands the composed mail to `mailRpc.sendToOwner` (or `send` on a
 *       seam without it) — the SAME `handleCollectionMailSend` path the
 *       D-127 P3.1 `connection.notification.email` subhandler uses, so
 *       capability gating / self-loop guard / `mail_send` audit all live
 *       in one place (`MailCollection.send`).
 *
 *  Scope: this is the OUTBOUND-only slice. The one-click `answerLink`
 *  affordance (D-158 P2b-ii) needs the public ask-landing HTTP route,
 *  which is a separate follow-on, so `answerLink` is left unwired here;
 *  email asks deliver text-only and stay answerable on the always-on
 *  `ui` channel (and, once the inbound funnel lands, by reply). The
 *  readiness probe in `composeNotificationBlock` flips the email Settings
 *  row live the moment this channel is present in `allChannels` AND a
 *  `connection.notification.email` record is enrolled.
 *
 *  Spec: D-158 § P2b / N.4; leaf: `channels/email.ts`;
 *  outbound mail seam: D-127 P3.1 (`handleCollectionMailSend`). */

import {
  createEmailChannel,
  type Channel,
  type EmailSender,
  type EmailChannelDeps,
  type AskDeliveryOutcome,
} from '@recued/notification';
import type { ConnectionRow } from '@recued/contracts';
import type { MailRpcDep } from '@recued/ingredients';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';

/** The `connection.notification` record name the email channel binds to —
 *  the same `(kind: 'notification', name: 'email')` key the readiness
 *  probe consults (`wire-notification-block.ts`). */
const EMAIL_NOTIFICATION_NAME = 'email';

export interface ComposeEmailChannelDeps {
  /** Connection store — the email record (`sender_mail_instance` +
   *  `default_recipient`) is resolved through it at every send. */
  connectionStore: ConnectionStoreSqlite;
  /** Mail-send seam. The boot site closes over
   *  `handleCollectionMailSend({ registry })` — the same seam the D-127
   *  connection-notification email subhandler uses. */
  mailRpc: MailRpcDep;
  /** A mailbox's own address, by its slug: where a connection with no
   *  `default_recipient` sends (D-158 amendment 2026-10-18). Absent ⇒ such a
   *  connection's pinned reminder delivery fails closed. */
  mailboxAddress?: (slug: string) => string | undefined;
  /** The connection a plain notify or ask goes through: the owner's choice for
   *  email, else the only one, else the one named `email`, or why there is none.
   *  Absent ⇒ the record named `email` (D-158 amendment 2026-10-19). */
  ownerConnection?: () => Promise<ConnectionRow | { reason: string }>;
  /** What the owner sees for `ownerConnection`'s reason. */
  ownerConnectionProblem?: (reason: string) => string;
  /** Exact claim/provider lookup. Must never call send. */
  reconcileEmailAttempt?: (reconciliation_id: string) => Promise<AskDeliveryOutcome>;
  /** D-158 P2b-ii — public ask-landing URL builder, answering nothing while
   *  the server has no public address for `/ask`. Absent or unanswered →
   *  text-only asks, answerable on the always-on `ui` channel. */
  answerLink?: (ask_id: string) => string | undefined;
}

/** The two config fields the email channel reads off the
 *  `connection.notification.email` record. Both are non-secret (config,
 *  not auth) — the email channel never decodes the record's auth blob. */
interface EmailNotificationConfig {
  sender_mail_instance?: unknown;
  default_recipient?: unknown;
}

const parseConfig = (config_json: string, name: string): EmailNotificationConfig => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(config_json);
  } catch {
    throw new Error(
      `connection.notification.email ('${name}') has malformed config_json — re-enroll in Settings → Connections.`,
    );
  }
  return parsed !== null && typeof parsed === 'object'
    ? (parsed as EmailNotificationConfig)
    : {};
};

/** Coerce a config recipient value into a non-empty `string[]`, or null
 *  when absent/empty. Accepts a single address or an array. */
const coerceRecipients = (value: unknown): string[] | null => {
  if (Array.isArray(value)) {
    const filtered = value.filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    return filtered.length > 0 ? filtered : null;
  }
  if (typeof value === 'string' && value.length > 0) return [value];
  return null;
};

/** Build the email notification `Channel` for the D-158 block's fan-out
 *  set. See module header for the outbound-seam contract. */
export const composeEmailChannel = (deps: ComposeEmailChannelDeps): Channel => {
  const sendEmail: EmailSender = async (email) => {
    // Resolve the record at send time — a re-enrollment between sends is
    // picked up immediately (mirrors the connection-notification handler's
    // per-dispatch resolve). The readiness probe already gates toggling
    // the channel on a present record, but the record can be deleted
    // after toggling, so the guard is real.
    const chosen = deps.ownerConnection ? await deps.ownerConnection() : deps.connectionStore.get('notification', EMAIL_NOTIFICATION_NAME);
    if (chosen !== null && 'reason' in chosen) throw new Error(deps.ownerConnectionProblem?.(chosen.reason) ?? chosen.reason);
    const record = chosen;
    if (record === null) {
      throw new Error(
        'connection.notification.email is not enrolled — add a notification email connection in Settings → Connections.',
      );
    }
    const config = parseConfig(record.config_json, record.name);

    const instance = config.sender_mail_instance;
    if (typeof instance !== 'string' || instance.length === 0) {
      throw new Error(
        `connection.notification.email ('${record.name}') is missing 'sender_mail_instance' — re-enroll selecting a send-capable mail account.`,
      );
    }
    const to = coerceRecipients(config.default_recipient);
    const mail = {
      instance,
      subject: email.subject,
      body_text: email.body_text,
      ...(email.body_html !== undefined ? { body_html: email.body_html } : {}),
    };
    // `MailCollection.send` (via `mailRpc`) owns capability gating, the
    // sender != to self-loop guard, and the `mail_send` audit row. No
    // recipient ⇒ the sending mailbox itself, which only `sendToOwner` may
    // address.
    if (deps.mailRpc.sendToOwner) {
      await deps.mailRpc.sendToOwner({ ...mail, ...(to ? { to } : {}) });
      return;
    }
    if (to === null) {
      throw new Error(
        `connection.notification.email ('${record.name}') is missing 'default_recipient' — set a delivery address in Settings → Connections.`,
      );
    }
    await deps.mailRpc.send({ ...mail, to });
  };

  /** Where a connection's notifications go: its `default_recipient`, or the
   *  sending mailbox's own address when it names none. */
  const recipientsOf = (config: EmailNotificationConfig, instance: string): string[] | null => {
    const configured = coerceRecipients(config.default_recipient);
    if (configured) return configured;
    const own = deps.mailboxAddress?.(instance)?.trim().toLowerCase();
    return own ? [own] : null;
  };

  const sendEmailDelivery: NonNullable<EmailChannelDeps['sendEmailDelivery']> = async (email, destination) => {
    const record = destination.connection_name ? deps.connectionStore.get('notification', destination.connection_name) : null;
    if (!record || destination.channel !== 'email' || record.enrolled_at !== destination.connection_enrolled_at
      || (record.subtype !== undefined && record.subtype !== 'email')) {
      return { outcome: 'not_delivered', error: 'The pinned email connection is unavailable' };
    }
    let config: EmailNotificationConfig;
    try { config = parseConfig(record.config_json, record.name); }
    catch { return { outcome: 'not_delivered', error: 'The pinned email connection has invalid configuration' }; }
    const instance = config.sender_mail_instance;
    const to = typeof instance === 'string' && instance ? recipientsOf(config, instance) : null;
    if (typeof instance !== 'string' || !instance || !to || to.length !== 1
      || destination.sender_source !== instance
      || to[0]!.toLowerCase() !== destination.recipient?.toLowerCase()
      || destination.expected_sender?.toLowerCase() !== destination.recipient?.toLowerCase()) {
      return { outcome: 'not_delivered', error: 'The pinned email recipient changed' };
    }
    const mail = { instance, to, subject: email.subject, body_text: email.body_text,
      ...(email.body_html !== undefined ? { body_html: email.body_html } : {}),
      reconciliation_id: email.reconciliation_id };
    try {
      const result = deps.mailRpc.sendToOwner ? await deps.mailRpc.sendToOwner(mail) : await deps.mailRpc.send(mail);
      return { outcome: 'delivered', provider_message_id: result.message_id };
    } catch {
      // The mail collection's reconciliation fence retains the exact attempt.
      // A thrown send is not proof that SMTP/provider did not accept it.
      return { outcome: 'unknown', error: 'The email send has no confirmed result' };
    }
  };

  return createEmailChannel({
    sendEmail,
    sendEmailDelivery,
    ...(deps.reconcileEmailAttempt ? { reconcileEmailDelivery: email => email.reconciliation_id
      ? deps.reconcileEmailAttempt!(email.reconciliation_id) : Promise.resolve({ outcome: 'unknown' as const }) } : {}),
    ...(deps.answerLink ? { answerLink: deps.answerLink } : {}),
  });
};
