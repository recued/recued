/** D-125 P7.2 — schemas for `connection.notification` enrollment.
 *
 *  Four subtypes share the notification handler:
 *    slack | telegram | email | in-app
 *
 *  In-app routes through the D-121 P6 broadcast bus and carries no
 *  external creds — the form is the smallest of the four.
 *
 *  D-127 P4.3 — email schema rewrites per spec § A.7.3. SMTP creds
 *  no longer live on the connection record (the prior shape was a
 *  pre-D-127 placeholder); they live on a `data.mail.<name>`
 *  instance enrolled via the IMAP / Gmail / Graph forms (P4.1,
 *  P4.2). The email connection record is now a thin "send via"
 *  pointer: a `sender_mail_instance` picker (filtered by
 *  `send_capable: true` via the new `data.mail.send_capable_instances`
 *  dynamic-options source) plus an optional default recipient.
 *  The record still carries `auth.type: 'none'` per architectural
 *  decision 6 (creds live elsewhere — on the picked mail account), but it
 *  is NOT a form field: a single-option select is dead UI. The payload
 *  builder defaults `auth` to `{ type: 'none' }` when no `auth.*` field is
 *  present (`connections/payload.ts`), so the projected shape is unchanged.
 *  Same for the in-app subtype below. */

import type { NotificationSubtype } from '@recued/contracts';

import type { ConnectionSchema } from './types.js';

/** D-127 P4.3 / D-165 P3 — stable id of the email-notification
 *  `sender_mail_instance` picker's dynamic-options source. A connections-page
 *  host fills `state.dynamicOptions[this]` with the send-capable
 *  `data.mail.<slug>` instance slugs (from `collection.mail.list` filtered by
 *  `send_capable: true`). Exported so the schema declaration below and the
 *  hydrating host share ONE literal — the value is a cross-package contract
 *  (also named in `contracts` rpc docs + `connections/state.ts`), so a magic
 *  string in two places would silently break the picker if either drifted. */
export const MAIL_SEND_CAPABLE_INSTANCES_SOURCE = 'data.mail.send_capable_instances';

const slack: ConnectionSchema = {
  kind: 'notification',
  subtype: 'slack',
  label: 'Slack',
  description: 'Post messages to a Slack channel via a workspace bot token.',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      placeholder: 'team-slack',
    },
    { key: 'display_name', label: 'Display Name', type: 'text', placeholder: 'Engineering Slack' },
    {
      key: 'config.channel_id',
      label: 'Channel ID',
      type: 'text',
      placeholder: 'C0123456789',
      help: 'Slack channel id (starts with `C`). Right-click the channel in Slack → "View channel details" → "Copy link"; the id sits at the end.',
    },
    {
      key: 'auth.type',
      label: 'Auth',
      type: 'select',
      options: ['bearer'],
    },
    {
      key: 'auth.token',
      label: 'Bot Token',
      type: 'secret',
      placeholder: 'xoxb-…',
    },
    {
      // D-192 M4c-UI — inbound message→commitment triggers. Saved via the
      // dedicated `setMatchPatterns` merge-write (not this form's config), so
      // it survives independently of a channel_id / token edit.
      key: 'config.match_patterns',
      label: 'Message triggers',
      type: 'match-pattern-list',
      optional: true,
      help: 'Optional. An inbound Slack message matching any trigger — a #tag, an @mention, or keyword text — is captured as a commitment proposal for your review. Leave empty for none.',
    },
  ],
  probe: { description: 'auth.test — verifies the token before recipes call chat.postMessage.' },
};

const telegram: ConnectionSchema = {
  kind: 'notification',
  subtype: 'telegram',
  label: 'Telegram',
  description: 'Post messages to a Telegram chat via a bot token.',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      placeholder: 'me-telegram',
    },
    { key: 'display_name', label: 'Display Name', type: 'text', placeholder: '@recued_bot' },
    {
      key: 'config.chat_id',
      label: 'Chat ID',
      type: 'text',
      placeholder: '123456789',
      help: 'Numeric chat id. Use @userinfobot in Telegram to fetch yours.',
    },
    {
      key: 'auth.type',
      label: 'Auth',
      type: 'select',
      options: ['bearer'],
    },
    {
      key: 'auth.token',
      label: 'Bot Token',
      type: 'secret',
      placeholder: '123456789:ABC-…',
    },
    {
      // D-192 M4c-UI — see the slack schema. Saved via `setMatchPatterns`.
      key: 'config.match_patterns',
      label: 'Message triggers',
      type: 'match-pattern-list',
      optional: true,
      help: 'Optional. An inbound Telegram message matching any trigger — a #tag, an @mention, or keyword text — is captured as a commitment proposal for your review. Leave empty for none.',
    },
  ],
  probe: { description: 'getMe — verifies the bot token.' },
};

/** D-192 CORE #6 make-live. Longer than the Slack / Telegram cards because
 *  WhatsApp genuinely asks for more: a bot token is one secret, but the Cloud API
 *  splits into an access token (to send), an App Secret (to verify what arrives),
 *  a verify token (to prove you own the endpoint), a business phone-number id (it
 *  is the send URL) and the one user you talk to. Every field below is load-bearing
 *  — none is optional polish. */
const whatsapp: ConnectionSchema = {
  kind: 'notification',
  subtype: 'whatsapp',
  // ⚠ Not "WhatsApp" — this is the Meta Cloud API on a BUSINESS number. Someone
  // reading "WhatsApp" in a settings list will reasonably assume their personal
  // number works, and it does not.
  label: 'WhatsApp Business API',
  // ⚠ The 24-hour window is stated UP FRONT, in the description, because it is the
  // one thing that decides whether this channel suits what you want it for — and it
  // is invisible until the moment an approval fails to arrive. Meta only lets a
  // business message you freely within 24 hours of YOUR last message to it. Recued's
  // core job on a chat channel is the unprompted ping ("Approve this?"), which is
  // exactly what the window blocks. Slack and Telegram have no such limit: once the
  // bot is reachable, it stays reachable, indefinitely and free.
  description:
    'Talk to Recued on WhatsApp — message it first, and it can reply for the next 24 hours. '
    + '⚠ Conversation ONLY: Meta blocks a business from messaging you outside that window, so Recued '
    + 'cannot send you alerts or approvals here — they would simply never arrive. '
    + 'Use Slack, Telegram or Discord for anything that has to reach you unprompted.',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      placeholder: 'me-whatsapp',
    },
    { key: 'display_name', label: 'Display Name', type: 'text', placeholder: 'WhatsApp' },
    {
      key: 'config.phone_number_id',
      label: 'Phone number ID',
      type: 'text',
      placeholder: '123456789012345',
      help: 'Your BUSINESS number, from Meta → WhatsApp → API Setup. This is the numeric "Phone number ID", not the phone number itself.',
    },
    {
      key: 'config.wa_id',
      label: 'Your WhatsApp number',
      type: 'text',
      placeholder: '+1 650 555 1234',
      help: 'The number Recued messages and takes replies from. Any format — it is normalised to digits.',
    },
    {
      key: 'auth.type',
      label: 'Auth',
      type: 'select',
      options: ['bearer'],
    },
    {
      key: 'auth.token',
      label: 'Access token',
      type: 'secret',
      placeholder: 'EAAG…',
      help: 'The System User access token. Generate a PERMANENT one — the temporary token on the API Setup page expires in 24 hours and the channel goes quiet with no other warning.',
    },
    {
      key: 'config.app_secret',
      label: 'App secret',
      type: 'secret',
      placeholder: '32-character hex',
      help: 'Meta → App settings → Basic → App secret. Recued verifies every inbound message against this; without it, anyone who learns your webhook URL could forge messages from you.',
    },
    {
      key: 'config.verify_token',
      label: 'Verify token',
      type: 'secret',
      placeholder: 'a long random string you invent',
      help: 'Invent one, then paste the SAME string into Meta → WhatsApp → Configuration → Verify token. Meta sends it back once to confirm you own the endpoint; it will not deliver a single message until that check passes.',
    },
    {
      // D-192 M4c-UI — see the slack schema. Saved via `setMatchPatterns`.
      key: 'config.match_patterns',
      label: 'Message triggers',
      type: 'match-pattern-list',
      optional: true,
      help: 'Optional. An inbound WhatsApp message matching any trigger — a #tag, an @mention, or keyword text — is captured as a commitment proposal for your review. Leave empty for none.',
    },
  ],
  probe: { description: 'Graph /me — verifies the access token before recipes send.' },
};

/** D-192 — Discord. Like WhatsApp, the honest limitation is stated in the
 *  DESCRIPTION rather than buried: Discord's Interactions webhook carries button
 *  presses but no plain user messages (those live on the Gateway, a persistent
 *  WebSocket we do not run), so Recued can alert you and you can approve — but you
 *  cannot chat back. Better to say so here than to have someone type at the bot and
 *  wonder why nothing happens. */
const discord: ConnectionSchema = {
  kind: 'notification',
  subtype: 'discord',
  label: 'Discord',
  description:
    'Alerts and approvals. Recued can message you unprompted — indefinitely, and free — and you approve with buttons. '
    + '⚠ You cannot chat back: Recued cannot read Discord messages (that needs a Gateway connection it does not run), '
    + 'so this is a notification channel, not a conversation. Use Slack or Telegram to talk to Recued.',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      placeholder: 'my-discord',
    },
    { key: 'display_name', label: 'Display Name', type: 'text', placeholder: 'Discord' },
    {
      key: 'config.channel_id',
      label: 'Channel ID',
      type: 'text',
      placeholder: '123456789012345678',
      help: 'The channel Recued posts to. Turn on Discord → Settings → Advanced → Developer Mode, then right-click the channel → "Copy Channel ID".',
    },
    {
      key: 'auth.type',
      label: 'Auth',
      type: 'select',
      options: ['bearer'],
    },
    {
      key: 'auth.token',
      label: 'Bot token',
      type: 'secret',
      placeholder: 'MTIz…',
      help: 'Discord Developer Portal → your app → Bot → Reset Token. Invite the bot to your server and give it access to the channel above, or every send fails with "Missing Access".',
    },
    {
      key: 'config.public_key',
      label: 'Public key',
      type: 'text',
      placeholder: '64 hex characters',
      help: 'Developer Portal → your app → General Information → Public Key. Recued verifies every button press against it. It is public — it is not a secret you need to guard.',
    },
    // ⚠ NO "Message triggers" field, deliberately. It was here, labelled as inert —
    // which is a lie with a friendly tone. The funnel fires on inbound MESSAGES and
    // Discord delivers none (`roles.messenger: false`), so a trigger here could never
    // match anything. A field that cannot work does not belong on the form; the
    // declaration now says why, and the funnel refuses the vendor outright.
  ],
  probe: { description: 'users/@me — verifies the bot token before recipes send.' },
};

const email: ConnectionSchema = {
  kind: 'notification',
  subtype: 'email',
  label: 'Email',
  description: 'Send mail via one of your enrolled mail accounts (IMAP+SMTP / Gmail / Microsoft 365). The picker below lists every send-capable account.',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      placeholder: 'newsletter',
    },
    { key: 'display_name', label: 'Display Name', type: 'text', placeholder: 'Newsletter mail' },
    {
      key: 'config.sender_mail_instance',
      label: 'Send from',
      type: 'select',
      options_source: MAIL_SEND_CAPABLE_INSTANCES_SOURCE,
      help: 'The data.mail.<name> account this destination sends through. Configure SMTP for an IMAP account, or grant Send permission to Gmail / Microsoft, to populate this list.',
      emptyGuidance: 'No send-capable mail accounts. Configure SMTP for an IMAP account or grant Send permission to a Gmail / Microsoft account first.',
    },
    {
      key: 'config.default_recipient',
      label: 'Default recipient',
      type: 'text',
      optional: true,
      placeholder: 'me@example.com',
      help: 'Optional. Recipes can override per-call; this is the fallback when the recipe omits the recipient.',
    },
    // No `auth.type` field — creds live on the picked mail account, so a
    // single-option `none` select is dead UI. The payload builder defaults
    // `auth` to `{ type: 'none' }` (connections/payload.ts).
  ],
  probe: {
    kind: 'mail',
    op: 'verify_send_capable',
    description: 'After save, a probe runs (mail.verify_send_capable) to confirm the picked account is still send-capable.',
  },
};

const inApp: ConnectionSchema = {
  kind: 'notification',
  subtype: 'in-app',
  label: 'In-app',
  description: 'Surface alerts via the realtime broadcast bus to every paired Recued client. No external credentials.',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      placeholder: 'in-app-alerts',
    },
    { key: 'display_name', label: 'Display Name', type: 'text', placeholder: 'In-app alerts' },
    // No `auth.type` field — in-app carries no external creds; the payload
    // builder defaults `auth` to `{ type: 'none' }` (connections/payload.ts).
  ],
};

/** D-192 seam 10 — `satisfies Record<NotificationSubtype, …>` makes the enroll
 *  cards COMPLETE by construction: declare a new chat transport and this map
 *  fails to compile until it has a card. Previously the subtype type was
 *  reverse-derived from this map (`keyof typeof`), which meant a vendor could be
 *  enrollable over rpc while silently having no card at all — the enrollment half
 *  of the seam. `as const` is kept so each schema's literal shape survives for
 *  the per-key reads below. */
export const notificationSchemas = {
  slack,
  telegram,
  whatsapp,
  discord,
  email,
  'in-app': inApp,
} as const satisfies Record<NotificationSubtype, ConnectionSchema>;

export type { NotificationSubtype };
