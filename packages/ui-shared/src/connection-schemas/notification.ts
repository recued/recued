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
  description: 'Talk to Recued through Slack. Socket Mode is local-first and needs no public webhook.',
  onboarding: {
    selectorKey: 'config.ingress_mode',
    guides: [
      {
        key: 'slack-socket',
        tone: 'recommended',
        badge: 'Recommended · no public port',
        title: 'Connect Slack from this machine',
        description:
          'Recued opens the Socket Mode connection outbound, so this works behind a normal office or home firewall.',
        portal: {
          label: 'Open Slack app settings',
          url: 'https://api.slack.com/apps',
        },
        steps: [
          {
            title: 'Create the Slack app',
            detail: 'Create New App → From scratch. Name it and pick the workspace Recued will use.',
          },
          {
            title: 'Enable Socket Mode and copy the app-level token',
            detail: 'Settings → Socket Mode → Enable Socket Mode. Slack asks for an app-level token: name it, add the connections:write scope, and copy the xapp- value now — it is shown only once.',
          },
          {
            title: 'Add the bot scopes',
            detail: 'Features → OAuth & Permissions → Bot Token Scopes: add chat:write, plus the history scope for where you will talk — channels:history for a public channel, groups:history for a private one, im:history for a DM.',
          },
          {
            title: 'Subscribe to messages',
            detail: 'Features → Event Subscriptions → on → Subscribe to bot events: add the event matching the scope above — message.channels, message.groups, or message.im. Socket Mode needs no Request URL.',
          },
          {
            title: 'Turn on Interactivity',
            detail: 'Features → Interactivity & Shortcuts → on. This is what carries approval button presses; in Socket Mode it needs no Request URL either.',
          },
          {
            title: 'Install and copy the bot token',
            detail: 'Settings → Install App → Install to Workspace, then copy the Bot User OAuth Token (xoxb-…).',
          },
          {
            title: 'Invite the bot to the conversation',
            detail: 'In Slack, run /invite @your-bot in the channel or DM Recued should use. Right-click it → Copy link; the channel ID is the last segment and starts with C.',
          },
          {
            title: 'Fill in the fields below',
            detail: 'Paste the channel ID, the bot token (xoxb-…), and the app-level token (xapp-…), then Save. Recued connects as soon as you save.',
          },
        ],
        verification:
          'Checks the bot token and opens a Socket Mode connection with the app-level token. It does not post a test message or confirm delivery or read status.',
        note:
          'Recued only reads the conversation you bind here. If you add the bot to other channels, their messages are not what Recued acts on.',
        showWhen: (values) => (values['config.ingress_mode'] ?? 'socket') === 'socket',
      },
      {
        key: 'slack-webhook',
        tone: 'advanced',
        badge: 'Advanced · public HTTPS required',
        title: 'Receive Slack events over a webhook',
        description:
          'Choose this only when Slack can reach this Recued server from the public internet. Socket Mode is the simpler local path.',
        portal: {
          label: 'Open Slack app settings',
          url: 'https://api.slack.com/apps',
        },
        steps: [
          {
            title: 'Publish this server over HTTPS',
            detail: 'Slack must be able to reach https://<public-host>/webhooks/slack/slack from the internet. If it cannot, use Socket Mode instead — nothing below will work.',
          },
          {
            title: 'Create the app and add scopes',
            detail: 'Create New App → From scratch. Then OAuth & Permissions → Bot Token Scopes: chat:write, plus channels:history, groups:history, or im:history to match where you will talk.',
          },
          {
            title: 'Point Event Subscriptions at the URL',
            detail: 'Features → Event Subscriptions → on → paste the URL above as the Request URL and wait for Slack to verify it. Subscribe to bot events: message.channels, message.groups, or message.im.',
          },
          {
            title: 'Point Interactivity at the same URL',
            detail: 'Features → Interactivity & Shortcuts → on → same Request URL. Approval button presses arrive here.',
          },
          {
            title: 'Install and collect three values',
            detail: 'Install App → Install to Workspace for the Bot User OAuth Token (xoxb-…); Settings → Basic Information → App Credentials for the Signing Secret.',
          },
          {
            title: 'Invite the bot and fill in the fields below',
            detail: 'Run /invite @your-bot in the target conversation, copy its link and take the final segment as the channel ID, then paste all three values and Save.',
          },
        ],
        verification:
          'Checks the bot token only. It does not test public webhook reachability, post a message, or confirm delivery or read status.',
        showWhen: (values) => values['config.ingress_mode'] === 'webhook',
      },
    ],
  },
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'select',
      options: ['slack'],
      hidden: true,
    },
    { key: 'display_name', label: 'Display Name', type: 'text', placeholder: 'Engineering Slack' },
    {
      key: 'config.ingress_mode',
      label: 'How Recued listens',
      type: 'select',
      options: ['socket', 'webhook'],
      optionLabels: {
        socket: 'Local — Socket Mode (recommended)',
        webhook: 'Public webhook (advanced)',
      },
      optional: true,
      help: 'Local mode opens an outbound connection. Webhook mode requires public inbound HTTPS.',
    },
    {
      key: 'config.channel_id',
      label: 'Channel ID',
      type: 'text',
      placeholder: 'C0123456789',
      help: 'Right-click the channel → View channel details → Copy link. The channel ID is the final segment of that link.',
    },
    {
      key: 'auth.type',
      label: 'Auth',
      type: 'select',
      options: ['bearer'],
      hidden: true,
    },
    {
      key: 'auth.token',
      label: 'Bot Token',
      type: 'secret',
      placeholder: 'xoxb-…',
      help: 'Slack → OAuth & Permissions → Bot User OAuth Token. It starts with xoxb-.',
    },
    {
      key: 'auth.app_token',
      label: 'App-level token',
      type: 'secret',
      placeholder: 'xapp-…',
      help: 'Slack app-level token with connections:write. Required only for Socket Mode and stored encrypted with the bot token.',
      showWhen: (v) => v['config.ingress_mode'] === 'socket',
    },
    {
      key: 'config.signing_secret',
      label: 'Signing secret',
      type: 'secret',
      help: 'Required when creating or switching to webhook mode. Leave blank on an existing webhook to preserve the saved secret. Slack → Basic Information → App Credentials.',
      showWhen: (v) => v['config.ingress_mode'] === 'webhook',
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
  probe: {
    description: 'Checks Slack bot identity and, in Socket Mode, app-level token access. No test message is sent.',
  },
};

const telegram: ConnectionSchema = {
  kind: 'notification',
  subtype: 'telegram',
  label: 'Telegram',
  description: 'Talk to Recued through Telegram. Long polling is local-first and needs no public webhook.',
  onboarding: {
    selectorKey: 'config.ingress_mode',
    guides: [
      {
        key: 'telegram-poll',
        tone: 'recommended',
        badge: 'Recommended · no public port',
        title: 'Connect Telegram from this machine',
        description:
          'Recued receives updates over outbound HTTPS and reconnects automatically after ordinary network interruptions.',
        portal: {
          label: 'Open BotFather',
          url: 'https://t.me/BotFather',
        },
        steps: [
          {
            title: 'Create the bot',
            detail: 'Message @BotFather and send /newbot. Give it a display name and a username ending in "bot". Copy the Bot API token it replies with — it is the only credential Recued needs.',
          },
          {
            title: 'Open the chat yourself',
            detail: 'Find your new bot in Telegram and press Start. Telegram does not let a bot open a private chat first, so nothing can arrive until you do this.',
          },
          {
            title: 'Get the chat ID',
            detail: 'For a private chat, message @userinfobot and copy the numeric Id it replies with. For a group, add your bot to the group and use the group\'s id instead — it begins with a minus sign.',
          },
          {
            title: 'Fill in the fields below',
            detail: 'Paste the chat ID and the bot token, then Save. Recued starts polling immediately.',
          },
        ],
        verification:
          'Checks that the token belongs to a Telegram bot. It does not send a test message or confirm delivery or read status.',
        note:
          'Telegram permits one intake method per bot. When local polling starts, Recued removes that bot’s existing webhook without dropping queued updates — and while Recued is polling, calling getUpdates yourself will take updates away from it. In a group, BotFather privacy mode (on by default) means the bot only sees commands and replies addressed to it.',
        showWhen: (values) => (values['config.ingress_mode'] ?? 'poll') === 'poll',
      },
      {
        key: 'telegram-webhook',
        tone: 'advanced',
        badge: 'Advanced · public HTTPS required',
        title: 'Receive Telegram updates over a webhook',
        description:
          'Choose this only when Telegram can reach this Recued server from the public internet. Long polling is the simpler local path.',
        portal: {
          label: 'Open BotFather',
          url: 'https://t.me/BotFather',
        },
        steps: [
          {
            title: 'Publish this server over HTTPS',
            detail: 'Telegram must reach https://<public-host>/webhooks/telegram/telegram, and it only accepts ports 443, 80, 88, or 8443. If you cannot meet that, use long polling instead.',
          },
          {
            title: 'Create the bot and open the chat',
            detail: 'Message @BotFather, send /newbot, and copy the token. Then press Start on your new bot and get the numeric chat ID from @userinfobot.',
          },
          {
            title: 'Choose a webhook secret',
            detail: 'Generate a random string — this is yours to invent, not something Telegram gives you. Recued verifies every delivery against it.',
          },
          {
            title: 'Register the webhook',
            detail: 'Call setWebhook on your bot with that URL and the same secret as secret_token. Telegram allows one intake method per bot, so this replaces any polling.',
          },
          {
            title: 'Fill in the fields below',
            detail: 'Paste the chat ID, the bot token, and the same webhook secret, then Save.',
          },
        ],
        verification:
          'Checks the bot token only. It does not test public webhook delivery, send a message, or confirm delivery or read status.',
        note: 'Telegram cannot deliver through a webhook while the same bot is being polled elsewhere.',
        showWhen: (values) => values['config.ingress_mode'] === 'webhook',
      },
    ],
  },
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'select',
      options: ['telegram'],
      hidden: true,
    },
    { key: 'display_name', label: 'Display Name', type: 'text', placeholder: '@recued_bot' },
    {
      key: 'config.ingress_mode',
      label: 'How Recued listens',
      type: 'select',
      options: ['poll', 'webhook'],
      optionLabels: {
        poll: 'Local — long polling (recommended)',
        webhook: 'Public webhook (advanced)',
      },
      optional: true,
      help: 'Local mode uses outbound HTTPS. Webhook mode requires public inbound HTTPS.',
    },
    {
      key: 'config.chat_id',
      label: 'Chat ID',
      type: 'text',
      placeholder: '123456789',
      help: 'Send the bot /start first, then copy message.chat.id from an update or use a trusted Telegram ID helper.',
    },
    {
      key: 'auth.type',
      label: 'Auth',
      type: 'select',
      options: ['bearer'],
      hidden: true,
    },
    {
      key: 'auth.token',
      label: 'Bot Token',
      type: 'secret',
      placeholder: '123456789:ABC-…',
      help: 'BotFather shows this once the bot is created. Treat it like a password.',
    },
    {
      key: 'config.webhook_secret',
      label: 'Webhook secret',
      type: 'secret',
      help: 'Required when creating or switching to webhook mode. Leave blank on an existing webhook to preserve the saved secret. Use the same random secret when registering the Telegram webhook.',
      showWhen: (v) => v['config.ingress_mode'] === 'webhook',
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
  probe: { description: 'Checks that the token belongs to a Telegram bot. No test message is sent.' },
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

/** D-192 — Discord. Gateway mode is the local-first full-chat path; the
 *  Interactions webhook remains available as an advanced approvals-only mode. */
const discord: ConnectionSchema = {
  kind: 'notification',
  subtype: 'discord',
  label: 'Discord',
  description:
    'Talk to Recued, receive alerts, and approve with buttons. Gateway mode is local-first and needs no public webhook.',
  onboarding: {
    selectorKey: 'config.ingress_mode',
    guides: [
      {
        key: 'discord-gateway',
        tone: 'recommended',
        badge: 'Recommended · no public port',
        title: 'Connect Discord from this machine',
        description:
          'Recued opens the Discord Gateway connection outbound, so chat and approval buttons work behind a normal firewall.',
        portal: {
          label: 'Open Discord Developer Portal',
          url: 'https://discord.com/developers/applications',
        },
        steps: [
          {
            title: 'Create the application and bot',
            detail: 'New Application → name it. Open the Bot tab and copy the token (use Reset Token if none is shown — it is displayed only once).',
          },
          {
            title: 'Enable Message Content Intent',
            detail: 'Bot → Privileged Gateway Intents → turn on MESSAGE CONTENT INTENT. Without it Discord delivers your messages with the text stripped out.',
          },
          {
            title: 'Leave the Interactions Endpoint URL empty',
            detail: 'General Information → Interactions Endpoint URL must stay blank. Setting it tells Discord to send button presses to a public URL instead of over the Gateway.',
          },
          {
            title: 'Invite the bot to your server',
            detail: 'OAuth2 → URL Generator → scope: bot → permissions: View Channel, Send Messages, Read Message History. Open the generated URL and add it to your server.',
          },
          {
            title: 'Copy the channel ID',
            detail: 'User Settings → Advanced → turn on Developer Mode. Right-click the channel Recued should use → Copy Channel ID.',
          },
          {
            title: 'Fill in the fields below',
            detail: 'Paste the channel ID and the bot token, then Save. Recued connects to the Gateway immediately.',
          },
        ],
        verification:
          'Checks that the token belongs to a Discord bot. It does not test channel permissions, post a message, or confirm delivery or read status.',
        note:
          'Discord has no per-channel subscription — the Gateway hands Recued every channel the bot can read. Recued keeps only the channel you bind here and drops the rest as they arrive, so nothing from your other channels is stored or acted on.',
        showWhen: (values) => (values['config.ingress_mode'] ?? 'socket') === 'socket',
      },
      {
        key: 'discord-webhook',
        tone: 'advanced',
        badge: 'Advanced · approvals only',
        title: 'Receive Discord interactions over a webhook',
        description:
          'This public-HTTPS path receives button interactions, but not ordinary Discord messages. Gateway is the full-chat path.',
        portal: {
          label: 'Open Discord Developer Portal',
          url: 'https://discord.com/developers/applications',
        },
        steps: [
          {
            title: 'Publish this server over HTTPS',
            detail: 'Discord must reach https://<public-host>/webhooks/discord/discord and will reject the URL if it cannot verify it immediately. If you cannot expose a public host, use Gateway mode.',
          },
          {
            title: 'Create the application and bot',
            detail: 'New Application → name it. Open the Bot tab and copy the token (Reset Token if none is shown).',
          },
          {
            title: 'Invite the bot to your server',
            detail: 'OAuth2 → URL Generator → scope: bot → permissions: View Channel, Send Messages. Open the generated URL and add it to your server.',
          },
          {
            title: 'Set the Interactions Endpoint URL',
            detail: 'General Information → paste the URL above and save. Discord verifies it with a signed ping before accepting.',
          },
          {
            title: 'Fill in the fields below',
            detail: 'Copy the channel ID (Developer Mode → right-click the channel), the bot token, and General Information → Public Key, then Save.',
          },
        ],
        verification:
          'Checks the bot token only. It does not test the interactions endpoint, channel permissions, message delivery, or read status.',
        note: 'Message triggers are unavailable in webhook mode because Discord sends interactions, not ordinary chat messages, to this endpoint.',
        showWhen: (values) => values['config.ingress_mode'] === 'webhook',
      },
    ],
  },
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'select',
      options: ['discord'],
      hidden: true,
    },
    { key: 'display_name', label: 'Display Name', type: 'text', placeholder: 'Discord' },
    {
      key: 'config.ingress_mode',
      label: 'How Recued listens',
      type: 'select',
      options: ['socket', 'webhook'],
      optionLabels: {
        socket: 'Local — Gateway (recommended)',
        webhook: 'Public webhook — approvals only',
      },
      optional: true,
      help: 'Gateway uses one outbound connection. Webhook mode requires public inbound HTTPS and receives interactions only.',
    },
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
      hidden: true,
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
      help: 'Required when creating or switching to webhook mode. Leave blank on an existing webhook to preserve it. Developer Portal → your app → General Information → Public Key.',
      showWhen: (v) => v['config.ingress_mode'] === 'webhook',
    },
    {
      key: 'config.match_patterns',
      label: 'Message triggers',
      type: 'match-pattern-list',
      optional: true,
      help: 'Optional. In Gateway mode, a Discord message matching any trigger is captured as a commitment proposal for your review. Leave empty for none.',
      showWhen: (v) => v['config.ingress_mode'] === 'socket',
    },
  ],
  probe: { description: 'Checks that the token belongs to a Discord bot. No test message is sent.' },
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
