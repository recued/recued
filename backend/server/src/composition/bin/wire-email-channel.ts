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
 *       + `default_recipient` (the notification delivery address — the
 *       leaf's self-loop note: it must differ from the sender's own
 *       address; `MailCollection.send` enforces that) from its config,
 *    3. hands the composed mail to `mailRpc.send` — the SAME
 *       `handleCollectionMailSend` seam the D-127 P3.1
 *       `connection.notification.email` subhandler already uses, so
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
} from '@recued/notification';
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
  /** D-158 P2b-ii — public ask-landing URL builder. DEFERRED in this
   *  slice (the landing-page HTTP route is a separate follow-on); when a
   *  later slice serves the route, the boot site injects it here and
   *  email asks gain the one-click affordance. Absent → text-only asks,
   *  answerable on the always-on `ui` channel. */
  answerLink?: (ask_id: string) => string;
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
    const record = deps.connectionStore.get('notification', EMAIL_NOTIFICATION_NAME);
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
    if (to === null) {
      throw new Error(
        `connection.notification.email ('${record.name}') is missing 'default_recipient' — set a delivery address (distinct from the sender account's own address) in Settings → Connections.`,
      );
    }

    // `MailCollection.send` (via `mailRpc`) owns capability gating, the
    // sender != to self-loop guard, and the `mail_send` audit row.
    await deps.mailRpc.send({
      instance,
      to,
      subject: email.subject,
      body_text: email.body_text,
      ...(email.body_html !== undefined ? { body_html: email.body_html } : {}),
    });
  };

  return createEmailChannel({
    sendEmail,
    ...(deps.answerLink ? { answerLink: deps.answerLink } : {}),
  });
};
