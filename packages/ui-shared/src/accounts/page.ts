/** Connections ▸ foundational account lanes (Mail · Calendar · Files).
 *
 *  The FOUNDATIONAL half of the restructured Connections surface
 *  (treemap §6, review-log R13–R16). Unlike the generic `connection.*`
 *  REACH lane (api / mcp / notification — `connections/page.ts`), these
 *  lanes bind first-class warehouse collections through the coded
 *  `collection.{mail,calendar,file}.*` adapters: mail / calendar / file
 *  → `data.mail` / `data.calendar` / `data.file`.
 *
 *  This module is PURE: the lane/provider schemas, the form validator,
 *  the value→rpc projection, and a string renderer. The webclient mount
 *  (`apps/webclient/src/connections/accounts-lane-panel.ts`) owns the
 *  state machine, the rpc callers, and the dispatchers — mirroring the
 *  `connections/page.ts` (renderer) ↔ `connections-enroll-panel.ts`
 *  (mount) split.
 *
 *  ── Slice 1 scope (non-OAuth enrollment) ───────────────────────────
 *  Mail  → IMAP / SMTP (`collection.mail.enrollImap`)
 *  Files → Local folder `fs` + S3 bucket `s3` (`collection.file.enroll`)
 *  Calendar carries NO enrollable provider in the UI yet. Its non-OAuth
 *  path (CalDAV) is now wire-drivable after the 2a backend fix —
 *  `enrollBasic` takes `password` + `calendar_home_url` directly and
 *  stores the password server-side under `caldav.<slug>.password` (the
 *  `vault_key` indirection is gone). Wiring the CalDAV form + the
 *  Google / Microsoft OAuth providers into this lane is the remaining
 *  Slice-2 work; until then the lane renders an honest `pending` note
 *  rather than a broken form.
 *  (`ext-downloads` is the Bridge download-stream receiver, not a
 *  user-typed enroll target, so it is deliberately absent.) */

import {
  buildOpenerRelayRedirectUri,
  oauthAppIssuerForProvider,
  type CollectionAuthState,
  type OAuthAppConfigSnapshot,
  type OAuthAppIssuer,
} from '@recued/contracts';
import { e } from '../template.js';
import { button } from '../primitives/button.js';
import { textInput, select as selectField, formRow } from '../primitives/field.js';
import { inlineError, inlineHint, inlineMessage } from '../primitives/message.js';

// ════════════════════════════════════════════════════════════════
// Schema model
// ════════════════════════════════════════════════════════════════

/** The three foundational lanes. `'others'` (generic REACH) is NOT one
 *  of these — it is the separate `connection.*` substrate the route
 *  hosts beside this panel. */
export type AccountLaneId = 'mail' | 'calendar' | 'file';

/** Closed field-type set the renderer understands. `boolean` renders as
 *  a Yes / No `<select>` (one `.value` read path for the delegator);
 *  `string-list` is a comma-separated text input the projection splits. */
export type AccountFieldType =
  | 'identifier'
  | 'text'
  | 'secret'
  | 'url'
  | 'number'
  | 'boolean'
  | 'string-list';

/** Form values keyed by their flat field key — all strings, coerced at
 *  projection time (mirrors `ConnectionFormValues`). */
export type AccountFormValues = Record<string, string>;

export interface AccountField {
  key: string;
  label: string;
  type: AccountFieldType;
  help?: string;
  placeholder?: string;
  /** Empty allowed without blocking submit. */
  optional?: boolean;
  /** Seed value (string form) used when the form value is absent. */
  default?: string;
}

/** How the mount routes this provider's projected payload to an rpc.
 *  `*-oauth` providers don't field-submit — they drive a consent popup
 *  (`accounts-oauth-connect`); `*-caldav` is a field-form (basic auth). */
export type AccountEnrollTransport =
  | 'mail-imap'
  | 'file-enroll'
  | 'mail-oauth'
  | 'calendar-oauth'
  | 'calendar-caldav';

/** True for providers that authenticate via the OAuth consent popup
 *  rather than a field-form submit. */
export const isOAuthAccountTransport = (
  transport: AccountEnrollTransport,
): boolean => transport === 'mail-oauth' || transport === 'calendar-oauth';

export interface AccountProvider {
  /** Stable id, unique within the lane (`'imap'` / `'fs'` / `'s3'`). */
  id: string;
  label: string;
  description: string;
  transport: AccountEnrollTransport;
  fields: readonly AccountField[];
  /** Pure value→rpc-args projection. The mount casts to the transport's
   *  caller arg type. */
  project: (values: AccountFormValues) => Record<string, unknown>;
  /** Optional cross-field rule run after the per-field checks — returns
   *  the first error or null. Used where one field's requiredness depends
   *  on another (IMAP: any SMTP sibling implies SMTP Host). */
  crossFieldValidate?: (values: AccountFormValues) => string | null;
}

export interface AccountLane {
  id: AccountLaneId;
  label: string;
  /** Visible section title when this lane already has connected accounts. */
  listTitle: string;
  blurb: string;
  /** Outcome-led first-run copy and action. Kept on the lane so the empty
   *  state stays truthful as provider support changes. */
  emptyTitle: string;
  emptyDescription: string;
  addLabel: string;
  providers: readonly AccountProvider[];
  /** Optional informational note beneath the lane heading. Plain text,
   *  escaped by the renderer. */
  pending?: string;
}

// ════════════════════════════════════════════════════════════════
// Validation helpers
// ════════════════════════════════════════════════════════════════

/** Server slug grammar shared by `collection.{mail,calendar,file}` —
 *  `requireSlug` in each enroll handler. Lowercase, digit, `-`, `_`;
 *  starts `[a-z0-9]`; length 1–64. */
export const ACCOUNT_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const isBlank = (v: string | undefined): boolean =>
  v === undefined || v.trim().length === 0;

/** Split a `string-list` field value (comma or newline separated) into
 *  trimmed, non-empty entries. */
export const splitAccountList = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** Validate a provider form. Returns the first error message, or null
 *  when the form may submit. Cheap client-side mirror of the server
 *  rules (slug grammar, port range, folders ≥ 1, required non-empties);
 *  the enroll rpc remains authoritative. */
export const validateAccountForm = (
  provider: AccountProvider,
  values: AccountFormValues,
): string | null => {
  for (const field of provider.fields) {
    const raw = values[field.key];
    if (isBlank(raw)) {
      if (field.optional) continue;
      return `${field.label} is required.`;
    }
    const value = (raw ?? '').trim();
    if (field.type === 'identifier' && !ACCOUNT_SLUG_REGEX.test(value)) {
      return `${field.label} must be lowercase letters, digits, hyphen or underscore (max 64).`;
    }
    if (field.type === 'number') {
      const n = Number(value);
      if (!Number.isInteger(n)) {
        return `${field.label} must be a whole number.`;
      }
      if (field.key === 'port' || field.key === 'smtp_port') {
        if (n < 1 || n > 65535) {
          return `${field.label} must be between 1 and 65535.`;
        }
      }
    }
    if (field.type === 'string-list' && splitAccountList(value).length === 0) {
      return `${field.label} needs at least one entry.`;
    }
  }
  return provider.crossFieldValidate?.(values) ?? null;
};

// ════════════════════════════════════════════════════════════════
// Lane + provider definitions (Slice 1)
// ════════════════════════════════════════════════════════════════

const IMAP_PROVIDER: AccountProvider = {
  id: 'imap',
  label: 'IMAP / SMTP',
  description:
    'Any mailbox reachable over IMAP, signed in with a username and password (or app password). Add SMTP to send.',
  transport: 'mail-imap',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      placeholder: 'fastmail',
      help: 'Lowercase identifier for this account (used in recipes).',
    },
    { key: 'host', label: 'IMAP Host', type: 'text', placeholder: 'imap.fastmail.com' },
    { key: 'port', label: 'IMAP Port', type: 'number', default: '993', placeholder: '993' },
    {
      key: 'secure',
      label: 'Use TLS',
      type: 'boolean',
      default: 'true',
      help: 'On for port 993 (implicit TLS). Off for STARTTLS on 143.',
    },
    { key: 'username', label: 'Username', type: 'text', placeholder: 'you@fastmail.com' },
    { key: 'password', label: 'Password', type: 'secret', help: 'Use an app password if your provider requires one.' },
    {
      key: 'folders',
      label: 'Folders',
      type: 'string-list',
      default: 'INBOX',
      help: 'Comma-separated mailbox names to sync (e.g. INBOX, Sent).',
    },
    {
      key: 'smtp_host',
      label: 'SMTP Host',
      type: 'text',
      optional: true,
      placeholder: 'smtp.fastmail.com',
      help: 'Optional. Fill the SMTP fields to make this account send-capable.',
    },
    { key: 'smtp_port', label: 'SMTP Port', type: 'number', optional: true, placeholder: '465' },
    { key: 'smtp_secure', label: 'SMTP TLS', type: 'boolean', optional: true, default: 'true' },
    { key: 'smtp_username', label: 'SMTP Username', type: 'text', optional: true, help: 'Defaults to the IMAP username if blank.' },
    { key: 'smtp_password', label: 'SMTP Password', type: 'secret', optional: true },
    { key: 'smtp_from', label: 'From Address', type: 'text', optional: true, placeholder: 'you@fastmail.com' },
  ],
  // SMTP is opt-in (it's what makes the account send-capable), but a sibling
  // SMTP field with no host would be silently dropped by the projection — so
  // require the host the moment any SMTP field is filled. `smtp_secure` is a
  // seeded Yes/No toggle (never blank), so it doesn't count as "filled".
  crossFieldValidate: (v) => {
    const siblings = ['smtp_port', 'smtp_username', 'smtp_password', 'smtp_from'];
    const anyFilled = siblings.some((k) => !isBlank(v[k]));
    if (anyFilled && isBlank(v['smtp_host'])) {
      return 'SMTP Host is required when any SMTP field is set.';
    }
    return null;
  },
  project: (v) => {
    const out: Record<string, unknown> = {
      name: (v['name'] ?? '').trim(),
      host: (v['host'] ?? '').trim(),
      port: Number((v['port'] ?? '').trim()),
      secure: (v['secure'] ?? 'true') === 'true',
      username: (v['username'] ?? '').trim(),
      password: v['password'] ?? '',
      folders: splitAccountList(v['folders']),
    };
    const smtpHost = (v['smtp_host'] ?? '').trim();
    if (smtpHost.length > 0) {
      const smtp: Record<string, unknown> = { host: smtpHost };
      const smtpPort = (v['smtp_port'] ?? '').trim();
      if (smtpPort.length > 0) smtp['port'] = Number(smtpPort);
      if (!isBlank(v['smtp_secure'])) smtp['secure'] = v['smtp_secure'] === 'true';
      const smtpUser = (v['smtp_username'] ?? '').trim();
      if (smtpUser.length > 0) smtp['username'] = smtpUser;
      if (!isBlank(v['smtp_password'])) smtp['password'] = v['smtp_password'];
      const smtpFrom = (v['smtp_from'] ?? '').trim();
      if (smtpFrom.length > 0) smtp['from'] = smtpFrom;
      out['smtp'] = smtp;
    }
    return out;
  },
};

/** The Microsoft-only "connect calendar too" opt-in.
 *
 *  Offered here and NOT on Gmail because Microsoft is the one issuer where mail
 *  and calendar genuinely share a grant: both adapters are named `graph`, so one
 *  consent's tokens live at the one prefix both lanes read. Google's `gmail` and
 *  `gcal` prefixes differ, so the same box there would need a second consent or a
 *  token fan-out — a separate change, deliberately not faked with a checkbox
 *  that behaves differently per provider.
 *
 *  ⚠ Unchecked by default, and the help text NAMES the write authority. Mail is
 *  read-only by default with send as its own opt-in; `Calendars.ReadWrite` is a
 *  strictly larger ask, so it must be a decision the owner makes rather than a
 *  default they discover on the consent screen. */
const CALENDAR_TOO_FIELD: AccountField = {
  key: 'calendar_enabled',
  label: 'Also connect Calendar',
  type: 'boolean',
  optional: true,
  default: 'false',
  help:
    'Adds the Calendars.ReadWrite scope to this one sign-in, so no second consent '
    + 'is needed. It grants read AND write access to your calendar. Also improves '
    + 'your contact graph, which is built from mail and calendar together. You can '
    + 'still decline it on the Microsoft consent screen.',
};

/** Shared field set for the mail OAuth providers — a slug for the mailbox
 *  instance + an opt-in send toggle (widens the OAuth scopes). The `code`
 *  comes from the consent popup, not the form. */
const mailOAuthFields = (
  sendHelp: string,
  extra: readonly AccountField[] = [],
): readonly AccountField[] => [
  {
    key: 'name',
    label: 'Mailbox name',
    type: 'identifier',
    placeholder: 'work',
    help: 'A short name used inside Recued, such as work or personal. Use lowercase letters, numbers, - or _.',
  },
  {
    key: 'send_enabled',
    label: 'Allow sending mail',
    type: 'boolean',
    optional: true,
    default: 'false',
    help: sendHelp,
  },
  ...extra,
];

/** OAuth providers carry slug + send toggle as form values; the mount reads
 *  them to build the authorize URL + the enrollOAuth call.
 *
 *  `calendar_enabled` is present for every mail provider but only ever TRUE for
 *  Microsoft, whose form is the only one carrying the field. The authorize-URL
 *  builder ignores it for Google rather than widening that consent. */
const projectMailOAuth = (v: AccountFormValues): Record<string, unknown> => ({
  account_slug: (v['name'] ?? '').trim(),
  send_enabled: v['send_enabled'] === 'true',
  calendar_enabled: v['calendar_enabled'] === 'true',
});

const GMAIL_PROVIDER: AccountProvider = {
  id: 'gmail',
  label: 'Gmail',
  description: 'Sign in with Google to read — and optionally send — Gmail.',
  transport: 'mail-oauth',
  fields: mailOAuthFields(
    'Requests the Gmail send scope so recipes can send on your behalf. You can still decline it on the Google consent screen.',
  ),
  project: projectMailOAuth,
};

const MICROSOFT_MAIL_PROVIDER: AccountProvider = {
  id: 'graph',
  label: 'Microsoft',
  description:
    'Sign in with Microsoft to read — and optionally send — Outlook / Microsoft 365 mail.',
  transport: 'mail-oauth',
  fields: mailOAuthFields(
    'Requests the Mail.Send scope so recipes can send on your behalf. You can still decline it on the Microsoft consent screen.',
    [CALENDAR_TOO_FIELD],
  ),
  project: projectMailOAuth,
};

const FS_PROVIDER: AccountProvider = {
  id: 'fs',
  label: 'Local folder',
  description:
    'A directory on the machine running your server. Recued reads files from this path.',
  transport: 'file-enroll',
  fields: [
    { key: 'slug', label: 'Name', type: 'identifier', placeholder: 'documents', help: 'Lowercase identifier for this source.' },
    {
      key: 'path',
      label: 'Folder path',
      type: 'text',
      placeholder: '/home/me/documents',
      help: 'Absolute path to an existing directory on the server host.',
    },
  ],
  project: (v) => ({
    slug: (v['slug'] ?? '').trim(),
    adapter_type: 'fs',
    config: { path: (v['path'] ?? '').trim() },
  }),
};

const S3_PROVIDER: AccountProvider = {
  id: 's3',
  label: 'S3 bucket',
  description:
    'An S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO). Bring your own access keys.',
  transport: 'file-enroll',
  fields: [
    { key: 'slug', label: 'Name', type: 'identifier', placeholder: 'archive', help: 'Lowercase identifier for this source.' },
    { key: 'bucket', label: 'Bucket', type: 'text', placeholder: 'my-bucket' },
    { key: 'region', label: 'Region', type: 'text', placeholder: 'us-east-1' },
    { key: 'access_key', label: 'Access Key ID', type: 'text' },
    { key: 'secret_key', label: 'Secret Access Key', type: 'secret' },
    {
      key: 'endpoint',
      label: 'Endpoint',
      type: 'url',
      optional: true,
      placeholder: 'https://<account>.r2.cloudflarestorage.com',
      help: 'Optional. Set for R2 / B2 / MinIO; leave blank for AWS S3.',
    },
    {
      key: 'use_path_style',
      label: 'Path-style URLs',
      type: 'boolean',
      optional: true,
      default: 'true',
      help:
        'On by default for R2 / B2 / MinIO and most custom endpoints. '
        + 'Turn off only when your endpoint explicitly requires virtual-host-style bucket names.',
    },
  ],
  project: (v) => {
    const config: Record<string, unknown> = {
      access_key: (v['access_key'] ?? '').trim(),
      secret_key: v['secret_key'] ?? '',
      region: (v['region'] ?? '').trim(),
      bucket: (v['bucket'] ?? '').trim(),
    };
    const endpoint = (v['endpoint'] ?? '').trim();
    if (endpoint.length > 0) config['endpoint'] = endpoint;
    if (!isBlank(v['use_path_style'])) config['use_path_style'] = v['use_path_style'] === 'true';
    return { slug: (v['slug'] ?? '').trim(), adapter_type: 's3', config };
  },
};

/** The lanes, in the locked top-split order. Mail + Files carry their
 *  Slice-1 non-OAuth providers; Calendar is enroll-pending. */
/** Slug-only field for the calendar OAuth providers — the consent popup
 *  supplies the code; calendar scopes are fixed (read/write, no toggle). */
const calendarOAuthFields: readonly AccountField[] = [
  {
    key: 'name',
    label: 'Calendar name',
    type: 'identifier',
    placeholder: 'work',
    help: 'A short name used inside Recued, such as work or personal. Use lowercase letters, numbers, - or _.',
  },
];

const projectCalendarOAuth = (v: AccountFormValues): Record<string, unknown> => ({
  slug: (v['name'] ?? '').trim(),
});

const GOOGLE_CALENDAR_PROVIDER: AccountProvider = {
  id: 'gcal',
  label: 'Google',
  description: 'Sign in with Google to read and write Google Calendar events.',
  transport: 'calendar-oauth',
  fields: calendarOAuthFields,
  project: projectCalendarOAuth,
};

const MICROSOFT_CALENDAR_PROVIDER: AccountProvider = {
  id: 'graph',
  label: 'Microsoft',
  description:
    'Sign in with Microsoft to read and write Outlook / Microsoft 365 calendar events.',
  transport: 'calendar-oauth',
  fields: calendarOAuthFields,
  project: projectCalendarOAuth,
};

/** CalDAV (Fastmail / iCloud / Nextcloud / …) — basic / app-password. The
 *  password is stored server-side under `caldav.<slug>.password` (Slice 2a),
 *  never on the config row. */
const CALDAV_PROVIDER: AccountProvider = {
  id: 'caldav',
  label: 'CalDAV',
  description:
    'Any CalDAV server (Fastmail, iCloud, Nextcloud, SOGo, …) with a username and app password.',
  transport: 'calendar-caldav',
  fields: [
    {
      key: 'name',
      label: 'Calendar account name',
      type: 'identifier',
      placeholder: 'fastmail',
      help: 'A short id for this calendar (lowercase letters, digits, - and _).',
    },
    {
      key: 'server_url',
      label: 'Server URL',
      type: 'url',
      placeholder: 'https://caldav.fastmail.com',
      help: 'The CalDAV server base URL.',
    },
    { key: 'username', label: 'Username', type: 'text', placeholder: 'me@fastmail.com' },
    {
      key: 'password',
      label: 'Password / app password',
      type: 'secret',
      help: 'Stored on your server, never on the calendar config.',
    },
    {
      key: 'calendar_home_url',
      label: 'Calendar home URL',
      type: 'url',
      placeholder: 'https://caldav.fastmail.com/dav/calendars/user/me/',
      help: 'Your calendar-home collection URL (provider docs call this the principal / calendar URL).',
    },
    {
      key: 'scheduling_outbox_url',
      label: 'Scheduling outbox URL',
      type: 'url',
      optional: true,
      help: 'Optional — enables RSVP when your server supports iTIP scheduling.',
    },
  ],
  project: (v) => {
    const out: Record<string, unknown> = {
      slug: (v['name'] ?? '').trim(),
      server_url: (v['server_url'] ?? '').trim(),
      username: (v['username'] ?? '').trim(),
      password: v['password'] ?? '',
      calendar_home_url: (v['calendar_home_url'] ?? '').trim(),
    };
    const outbox = (v['scheduling_outbox_url'] ?? '').trim();
    if (outbox.length > 0) out['scheduling_outbox_url'] = outbox;
    return out;
  },
};

export const ACCOUNT_LANES: readonly AccountLane[] = [
  {
    id: 'mail',
    label: 'Mail',
    listTitle: 'Mailboxes',
    blurb: 'Recued can search and use these mailboxes in your work. Sending stays optional.',
    emptyTitle: 'Connect your first mailbox',
    emptyDescription:
      'Find messages in Chat and let Recued help with inbox work. You choose whether Recued can send.',
    addLabel: 'Connect mailbox',
    providers: [IMAP_PROVIDER, GMAIL_PROVIDER, MICROSOFT_MAIL_PROVIDER],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    listTitle: 'Calendars',
    blurb: 'Recued can use these calendars to understand your schedule and help with events.',
    emptyTitle: 'Connect your first calendar',
    emptyDescription:
      'Bring upcoming work into context and let Recued help with calendar tasks.',
    addLabel: 'Connect calendar',
    providers: [
      GOOGLE_CALENDAR_PROVIDER,
      MICROSOFT_CALENDAR_PROVIDER,
      CALDAV_PROVIDER,
    ],
  },
  {
    id: 'file',
    label: 'Files',
    listTitle: 'File sources',
    blurb: 'Recued can search approved folders and buckets for file tasks.',
    emptyTitle: 'Add your first file source',
    emptyDescription:
      'Make a local folder or S3-compatible bucket available to Recued when you need it.',
    addLabel: 'Add file source',
    providers: [FS_PROVIDER, S3_PROVIDER],
    pending: 'Using Dropbox, Google Drive, Box, or OneDrive? Connect those from Data → Files. Installed packs can add more provider actions.',
  },
];

export const findAccountLane = (id: string): AccountLane | undefined =>
  ACCOUNT_LANES.find((l) => l.id === id);

export const findAccountProvider = (
  lane: AccountLane,
  providerId: string,
): AccountProvider | undefined =>
  lane.providers.find((p) => p.id === providerId);

// ════════════════════════════════════════════════════════════════
// Render model (state shape owned by the mount; rendered here)
// ════════════════════════════════════════════════════════════════

/** A normalized list row — the mount maps each lane's raw rpc rows
 *  (`collection.mail.list` / `collection.calendar.list` /
 *  `collection.listInstances`) onto this shape. */
export interface AccountRow {
  slug: string;
  /** Adapter / provider key (`'imap'` / `'gmail'` / `'fs'` / `'s3'` …)
   *  for the provider badge. */
  adapterType: string;
  authState: CollectionAuthState;
  /** Secondary line — account email, S3 bucket, etc. */
  sublabel?: string;
  /** True for send-capable mail rows (a small "can send" hint). */
  sendCapable?: boolean;
  /** True only when this lane owns an executable reauthorization action. */
  reauthAvailable?: boolean;
  /** Unix-ms of last successful sync, or null before the first tick. */
  lastSyncedAt?: number | null;
}

export type AccountsPanelStage =
  | 'list'
  | 'provider-picker'
  | 'form'
  | 'detail';

export type AccountsOAuthProgressStage =
  | 'preparing'
  | 'waiting_for_consent'
  | 'finishing';

/** The BYO OAuth-app credential fields (client_id + client_secret) rendered
 *  INLINE on the OAuth provider form, alongside the account name / send
 *  toggle. Held separately from the account-form `values` so the secret never
 *  mixes with the enroll args; saved via `setOAuthAppConfig` as part of
 *  Connect when entered. */
export interface OAuthCredValues {
  client_id: string;
  client_secret: string;
}

/** The most recent OAuth account saved by this mounted panel. Kept separate
 *  from the list row because enrollment can succeed before the follow-up list
 *  can prove that account's first sync state. */
export interface AccountConnectionSuccess {
  slug: string;
  providerId: string;
  /** A partial-outcome note for a connect that mostly worked.
   *
   *  Today: the Microsoft "Also connect Calendar" opt-in, whose calendar half
   *  can fail after the mail half has already succeeded. The mailbox IS
   *  connected, so this must not render as a failure — but it must not be
   *  swallowed into a plain "connected" card either, because the owner ticked a
   *  box that did not happen. */
  note?: string;
}

/** An open "really remove this account?" prompt.
 *
 *  Account removal was INSTANT: one click on a row's Remove button and the
 *  account was gone. It is not catastrophic — already-synced mail/events stay in
 *  the warehouse, the server only stops syncing and drops the sign-in — but it
 *  is irreversible without re-running the whole OAuth consent, and the button
 *  sits inline in a list where a mis-click is easy.
 *
 *  The generic `connection.*` lane has confirmed deletes since D-192; this is the
 *  foundational Mail / Calendar / Files lanes catching up, with the same shape so
 *  the two surfaces do not teach different habits. */
export interface AccountsDeleteConfirm {
  slug: string;
  /** Provider label for the prompt title, resolved when the prompt opens (the
   *  row may leave `rows` while a delete is in flight). */
  providerLabel: string;
  /** True once Remove is pressed — disables both buttons so a double-click
   *  cannot fire two deletes. */
  deleting: boolean;
}

/** Recovery for a reload that landed after the OAuth provider returned but
 * before the browser observed the enrollment result. The account list is the
 * authority: never label this connected, or offer another consent, until that
 * read resolves. Repeated clean misses plus a short grace make an explicit
 * restart available. */
export interface AccountsOAuthReloadRecovery {
  providerLabel: string;
  slug: string;
  status: 'checking' | 'check_again' | 'ready_to_retry';
  /** A failed verification read, kept inside the recovery card so the stale
   * account list is not presented as an authoritative empty result. */
  error?: string;
  /** Rounded wait remaining before a fresh consent can be offered. */
  retryAfterSeconds?: number;
}

export interface AccountsPanelState {
  /** Selected lane tab. */
  lane: AccountLaneId;
  /** App origin (e.g. `https://app.recued.com`), seeded by the mount from
   *  the same env the OAuth flow uses. Drives the OAuth forms' "register
   *  this exact redirect URI" operator hint. Absent in renders that don't
   *  seed it (non-browser / unit tests) — the hint is simply omitted. */
  appOrigin?: string;
  stage: AccountsPanelStage;
  /** Rows for the selected lane (mount-hydrated). */
  rows: readonly AccountRow[];
  loading: boolean;
  /** Lane-level error (list load). */
  error: string | null;
  /** Add flow — chosen provider id (form stage). */
  providerId: string | null;
  /** Add-form values. */
  values: AccountFormValues;
  /** Add-form submit error. */
  formError: string | null;
  /** Add-form submit in flight. */
  saving: boolean;
  /** OAuth flow — true from popup-open through the server exchange. The
   *  boot-scoped transaction can outlive this route presentation. */
  oauthFinishing: boolean;
  /** Truthful phase within the visible OAuth progress card. `null` outside the
   *  flow. Preparing covers credential/config work before popup navigation;
   *  finishing begins once the server owns the authorization code. */
  oauthProgressStage: AccountsOAuthProgressStage | null;
  /** Ambiguous post-reload exchange outcome, verified before retry. */
  oauthReloadRecovery: AccountsOAuthReloadRecovery | null;
  /** Post-connect confirmation. Persists while the refreshed list moves from
   *  "saved" to a first successful sync, or until the user dismisses it. */
  connectionSuccess: AccountConnectionSuccess | null;
  /** Open removal prompt, or null. */
  deleteConfirm: AccountsDeleteConfirm | null;
  /** BYO OAuth-app status per issuer (`server.getOAuthAppConfig`), mount-
   *  hydrated on the Mail / Calendar lanes. `null` = not loaded (or the
   *  caller is absent on this mount) → the OAuth form falls back to the
   *  legacy Connect button + operator env-var error. When loaded, an issuer
   *  with `source === null` is gated behind a "Set up … sign-in" step. */
  oauthAppConfig: OAuthAppConfigSnapshot | null;
  /** Inline OAuth-app credential field values (client_id pre-filled from the
   *  effective id; client_secret always starts blank — it is write-only).
   *  Saved via `setOAuthAppConfig` as part of Connect when entered. */
  oauthCredValues: OAuthCredValues;
  /** Detail stage — selected account slug. */
  detailSlug: string | null;
  /** Per-row in-flight action keys (delete / resync / reauth). */
  rowBusy: ReadonlySet<string>;
  /** Most-recent per-row action error keyed by slug. */
  rowError: Readonly<Record<string, string>>;
}

export const initialAccountsPanelState = (
  lane: AccountLaneId = 'mail',
): AccountsPanelState => ({
  lane,
  stage: 'list',
  rows: [],
  loading: true,
  error: null,
  providerId: null,
  values: {},
  formError: null,
  saving: false,
  oauthFinishing: false,
  oauthProgressStage: null,
  oauthReloadRecovery: null,
  connectionSuccess: null,
  deleteConfirm: null,
  oauthAppConfig: null,
  oauthCredValues: { client_id: '', client_secret: '' },
  detailSlug: null,
  rowBusy: new Set(),
  rowError: {},
});

/** Seed a provider's form with field defaults so an untouched boolean /
 *  port projects the intended value rather than an empty string. */
export const seedAccountFormValues = (
  provider: AccountProvider,
): AccountFormValues => {
  const values: AccountFormValues = {};
  for (const field of provider.fields) {
    if (field.default !== undefined) values[field.key] = field.default;
  }
  return values;
};

// ════════════════════════════════════════════════════════════════
// Renderers
// ════════════════════════════════════════════════════════════════

const AUTH_STATE_LABEL: Record<CollectionAuthState, string> = {
  healthy: 'Connected',
  expired: 'Needs re-auth',
  unauthorized: 'Unauthorized',
  degraded: 'Degraded',
};

/** Display name for an OAuth-app issuer. */
const OAUTH_ISSUER_LABEL: Record<OAuthAppIssuer, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
};

/** One line stating that the issuer's single app covers both the mail and
 *  the calendar lane (the per-issuer model — one Google app for Gmail +
 *  Google Calendar, one Microsoft app for Outlook mail + calendar). */
const OAUTH_ISSUER_COVERS: Record<OAuthAppIssuer, string> = {
  google: 'One Google app covers both Gmail and Google Calendar sign-in.',
  microsoft: 'One Microsoft app covers both Outlook mail and calendar sign-in.',
};

/** Direct entry points for the one-time provider work. Keeping these beside
 *  the issuer copy makes the checklist actionable without asking the owner to
 *  search for the right console first. */
const OAUTH_ISSUER_CONSOLE: Readonly<Record<OAuthAppIssuer, {
  readonly href: string;
  readonly label: string;
}>> = {
  google: {
    href: 'https://console.cloud.google.com/apis/credentials',
    label: 'Open Google Cloud Console',
  },
  microsoft: {
    href: 'https://entra.microsoft.com/',
    label: 'Open Microsoft Entra',
  },
};

/** Resolve the OAuth-app issuer for an OAuth provider (id is one of
 *  `gmail` / `gcal` / `graph`). Returns null for non-OAuth providers. */
const issuerForProvider = (provider: AccountProvider): OAuthAppIssuer | null =>
  isOAuthAccountTransport(provider.transport)
    ? oauthAppIssuerForProvider(provider.id as 'gmail' | 'gcal' | 'graph')
    : null;

const isReusableOAuthApp = (
  status: OAuthAppConfigSnapshot[OAuthAppIssuer] | null,
): boolean => status !== null && status.source !== null && status.has_secret;

/** Whether the active provider form has everything needed to submit.
 *  OAuth forms additionally require either a reusable server-side app or a
 *  complete replacement Client ID + secret. A null app snapshot is the legacy
 *  unknown state: blank fields may still reuse operator-provided config, but a
 *  newly typed secret must always have a Client ID beside it. */
export const canSubmitAccountForm = (
  provider: AccountProvider,
  state: AccountsPanelState,
): boolean => {
  if (validateAccountForm(provider, state.values) !== null) return false;
  const issuer = issuerForProvider(provider);
  if (issuer === null) return true;

  const clientId = state.oauthCredValues.client_id.trim();
  const clientSecret = state.oauthCredValues.client_secret.trim();
  if (clientSecret.length > 0) return clientId.length > 0;
  if (state.oauthAppConfig === null) return clientId.length === 0;

  const status = state.oauthAppConfig[issuer];
  if (!isReusableOAuthApp(status)) return false;
  // The configured Client ID is prefilled as reference. Leaving it alone (or
  // clearing the optional replacement draft) reuses the server app; changing
  // it starts a replacement and therefore also requires its matching secret.
  const configuredClientId = status.client_id?.trim() ?? '';
  return clientId.length === 0 || clientId === configuredClientId;
};

const fieldDomId = (key: string): string => `acct-field-${key.replace(/_/g, '-')}`;

const renderField = (field: AccountField, values: AccountFormValues): string => {
  const id = fieldDomId(field.key);
  const value = values[field.key] ?? field.default ?? '';
  let control: string;
  if (field.type === 'boolean') {
    control = selectField({
      id,
      options: [
        { value: 'true', label: 'Yes', selected: value !== 'false' },
        { value: 'false', label: 'No', selected: value === 'false' },
      ],
      data: { 'acct-field': field.key },
    });
  } else {
    const inputType =
      field.type === 'secret'
        ? 'password'
        : field.type === 'number'
          ? 'number'
          : field.type === 'url'
            ? 'url'
            : 'text';
    control = textInput({
      id,
      type: inputType,
      value,
      ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
      ...(field.type === 'secret' ? { autocomplete: 'off' as const } : {}),
      spellcheck: false,
      data: { 'acct-field': field.key },
    });
  }
  return formRow({
    label: field.optional ? `${field.label} (optional)` : field.label,
    htmlFor: id,
    control,
    ...(field.help !== undefined ? { hint: field.help } : {}),
  });
};

/** Exact callback control for provider-console setup. The URI comes from the
 *  same builder used by the authorize + enroll paths, and stays visible for
 *  manual selection if clipboard access is unavailable. */
const renderOAuthRedirectControl = (
  appOrigin: string,
  issuer: OAuthAppIssuer,
  numbered: boolean,
): string => {
  const redirectUri = buildOpenerRelayRedirectUri(
    appOrigin,
    issuer === 'microsoft',
  );
  return `
    <div class="accounts-oauth-callback">
      <p class="accounts-oauth-step-title">
        ${numbered ? '2. ' : ''}Register this callback URL
      </p>
      <p class="accounts-oauth-step-desc">
        Add this exact value to the app's authorized redirect URIs.
      </p>
      <div class="accounts-oauth-callback-row">
        <code class="accounts-oauth-redirect">${e(redirectUri)}</code>
        ${button({
          label: 'Copy',
          size: 'xs',
          action: 'accounts-copy-oauth-redirect',
          data: { 'copy-value': redirectUri },
          ariaLabel: 'Copy authorized redirect URI',
        })}
      </div>
    </div>
  `;
};

/** Progressive server OAuth-app setup. A reusable app renders as one compact
 *  ready row; replacement credentials live behind native disclosure. Missing
 *  config renders the one-time provider checklist in the order users need it. */
const renderOAuthAppSection = (
  issuer: OAuthAppIssuer,
  state: AccountsPanelState,
): string => {
  const label = OAUTH_ISSUER_LABEL[issuer];
  const status = state.oauthAppConfig?.[issuer] ?? null;
  const configKnown = state.oauthAppConfig !== null;
  const reusable = isReusableOAuthApp(status);
  const clientId = state.oauthCredValues.client_id ?? '';
  const clientSecret = state.oauthCredValues.client_secret ?? '';

  const clientIdField = formRow({
    label: `${label} Client ID`,
    htmlFor: 'oauth-app-client-id',
    control: textInput({
      id: 'oauth-app-client-id',
      type: 'text',
      value: clientId,
      spellcheck: false,
      placeholder:
        issuer === 'google'
          ? '1234567890-abc.apps.googleusercontent.com'
          : '00000000-0000-0000-0000-000000000000',
      data: { 'oauth-cred-field': 'client_id' },
    }),
    hint:
      issuer === 'google'
        ? 'The "Client ID" from your OAuth client.'
        : 'The Application (client) ID from the app registration Overview.',
  });
  const clientSecretField = formRow({
    label: `${label} Client secret`,
    htmlFor: 'oauth-app-client-secret',
    control: textInput({
      id: 'oauth-app-client-secret',
      type: 'password',
      value: clientSecret,
      autocomplete: 'off',
      spellcheck: false,
      data: { 'oauth-cred-field': 'client_secret' },
    }),
    hint: status?.has_secret
      ? 'A secret is already saved. Enter a new one only when replacing this app.'
      : 'From your OAuth app. Stored encrypted on your server; never shown again.',
  });

  const callback = (numbered: boolean): string =>
    state.appOrigin === undefined
      ? ''
      : renderOAuthRedirectControl(state.appOrigin, issuer, numbered);

  const credentials = (title: string): string => `
    <div class="accounts-oauth-credentials">
      <p class="accounts-oauth-step-title">${e(title)}</p>
      <p class="accounts-oauth-step-desc">
        These credentials are encrypted and stored only on your Recued server.
      </p>
      <div class="accounts-form-fields">
        ${clientIdField}
        ${clientSecretField}
      </div>
    </div>
  `;

  if (reusable) {
    // One source since the `RECUED_*` OAuth env vars were deleted (2026-07-28):
    // `reusable` implies `source === 'stored'`, so there is no longer an
    // "provided by this server" (env) variant of this line.
    const sourceCopy = 'Saved securely on this server. No app credentials are needed here.';
    return `
      <section class="accounts-oauth-app accounts-oauth-app--ready"
        data-oauth-app-state="ready" aria-label="${e(label)} sign-in status">
        <div class="accounts-oauth-app-header">
          <span class="accounts-oauth-state-icon" aria-hidden="true">✓</span>
          <div>
            <p class="accounts-oauth-app-title">${e(label)} sign-in is ready</p>
            <p class="accounts-oauth-app-desc">${e(sourceCopy)}</p>
          </div>
        </div>
        <details class="accounts-oauth-manage">
          <summary>Change ${e(label)} sign-in app</summary>
          <div class="accounts-oauth-manage-body">
            ${inlineHint(OAUTH_ISSUER_COVERS[issuer])}
            ${oauthAppGuide(issuer)}
            ${callback(false)}
            ${credentials(`Replacement ${label} app credentials`)}
          </div>
        </details>
      </section>
    `;
  }

  if (configKnown) {
    // The old `source === 'env'` arm read "only partly configured — add the
    // matching secret", covering an env client_id whose secret was unset. With
    // the six `RECUED_*` OAuth vars deleted (2026-07-28) `configKnown &&
    // !reusable` means `source === null` — genuinely unconfigured. (`hasSecret`
    // is presence-only, so a LOCKED server holding stored creds still reports
    // `has_secret: true` and takes the `reusable` branch above, not this one.)
    const setupCopy = `This server needs a ${label} OAuth app before it can connect ${label} accounts.`;
    return `
      <section class="accounts-oauth-app accounts-oauth-app--setup"
        data-oauth-app-state="setup" aria-labelledby="accounts-${e(issuer)}-setup-title">
        <div class="accounts-oauth-app-header">
          <span class="accounts-oauth-setup-badge">One-time server setup</span>
          <div>
            <h3 class="accounts-oauth-app-title" id="accounts-${e(issuer)}-setup-title">
              Set up ${e(label)} sign-in
            </h3>
            <p class="accounts-oauth-app-desc">${e(setupCopy)}</p>
          </div>
        </div>
        <p class="accounts-oauth-shared-note">${e(OAUTH_ISSUER_COVERS[issuer])}</p>
        ${oauthAppGuide(issuer, true)}
        ${callback(true)}
        ${credentials('3. Paste the app credentials')}
      </section>
    `;
  }

  return `
    <section class="accounts-oauth-app accounts-oauth-app--unknown"
      data-oauth-app-state="unknown">
      <div class="accounts-oauth-app-header">
        <div>
          <p class="accounts-oauth-app-title">${e(label)} sign-in settings</p>
          <p class="accounts-oauth-app-desc">
            If this server already provides ${e(label)} sign-in, leave these blank.
            Otherwise enter an OAuth app below.
          </p>
        </div>
      </div>
      ${oauthAppGuide(issuer)}
      ${callback(false)}
      ${credentials(`${label} app credentials`)}
    </section>
  `;
};

const renderProviderForm = (
  lane: AccountLane,
  provider: AccountProvider,
  state: AccountsPanelState,
): string => {
  const fields = provider.fields.map((f) => renderField(f, state.values)).join('');
  const backAction = lane.providers.length > 1 ? 'accounts-open-add' : 'accounts-back-to-list';

  const isOAuth = isOAuthAccountTransport(provider.transport);
  const issuer = issuerForProvider(provider);
  const canSubmit = canSubmitAccountForm(provider, state);
  const needsOAuthSetup = issuer !== null
    && state.oauthAppConfig !== null
    && !isReusableOAuthApp(state.oauthAppConfig[issuer]);
  const formVerb = lane.id === 'file' ? 'Add' : 'Connect';
  const submitLabel = state.saving
    ? lane.id === 'file' ? 'Adding…' : 'Connecting…'
    : lane.id === 'file' ? 'Add file source' : 'Connect account';
  // BYO OAuth-app credential fields render INLINE on the provider form.
  const oauthSection = isOAuth && issuer !== null ? renderOAuthAppSection(issuer, state) : '';

  const primary = isOAuth
    ? button({
        label: state.saving
          ? 'Connecting…'
          : needsOAuthSetup
            ? 'Save setup & connect ' + provider.label
            : 'Connect ' + provider.label,
        variant: 'primary',
        size: 'sm',
        action: 'accounts-oauth-connect',
        // A started write is handler-fenced but remains focusable. Replacing
        // the clicked button with a native-disabled node would strand keyboard
        // focus on <body> during the provider round trip.
        disabled: !canSubmit,
        ariaDisabled: state.saving,
        ariaBusy: state.saving,
      })
    : button({
        label: submitLabel,
        variant: 'primary',
        size: 'sm',
        action: 'accounts-submit-form',
        disabled: !canSubmit,
        ariaDisabled: state.saving,
        ariaBusy: state.saving,
      });

  return `
    <div class="accounts-form${isOAuth ? ' accounts-form--oauth' : ''}">
      <h2 class="accounts-form-title" data-accounts-form-heading tabindex="-1">${formVerb} ${e(provider.label)}</h2>
      <p class="accounts-form-desc">${e(provider.description)}</p>
      ${state.formError !== null ? inlineError(state.formError) : ''}
      ${isOAuth ? '<p class="accounts-form-section-title">Connection details</p>' : ''}
      <div class="accounts-form-fields">${fields}</div>
      ${oauthSection}
      <div class="accounts-form-actions">
        ${primary}
        ${button({
          label: 'Back',
          size: 'sm',
          action: backAction,
          disabled: state.saving,
        })}
      </div>
    </div>
  `;
};

const renderProviderPicker = (lane: AccountLane): string => {
  const title = lane.id === 'file'
    ? 'Choose a file source'
    : `Choose a ${lane.label.toLowerCase()} provider`;
  return `
  <div class="accounts-picker">
    <h2 class="accounts-picker-title" data-accounts-picker-heading tabindex="-1">${e(title)}</h2>
    <div class="accounts-picker-grid">
      ${lane.providers
        .map(
          (p) => `
        <button type="button" class="accounts-picker-card"
          data-action="accounts-pick-provider" data-provider="${e(p.id)}">
          <strong>${e(p.label)}</strong>
          <span class="accounts-picker-card-desc">${e(p.description)}</span>
        </button>`,
        )
        .join('')}
    </div>
    <div class="accounts-form-actions">
      ${button({ label: 'Cancel', size: 'sm', action: 'accounts-back-to-list' })}
    </div>
  </div>
`;
};

const providerLabelFor = (lane: AccountLane, adapterType: string): string => {
  const match = lane.providers.find((p) => p.id === adapterType);
  return match ? match.label : adapterType;
};

type AccountDisplayState = CollectionAuthState | 'syncing';

const displayStatusFor = (
  row: AccountRow,
): { state: AccountDisplayState; label: string } =>
  row.authState === 'healthy'
    && (row.lastSyncedAt === undefined || row.lastSyncedAt === null)
    ? { state: 'syncing', label: 'First sync pending' }
    : { state: row.authState, label: AUTH_STATE_LABEL[row.authState] };

const renderConnectionSuccess = (
  lane: AccountLane,
  state: AccountsPanelState,
): string => {
  const success = state.connectionSuccess;
  if (success === null) return '';

  const row = state.rows.find((candidate) => candidate.slug === success.slug);
  const provider = findAccountProvider(lane, success.providerId);
  const providerLabel = provider?.label
    ?? providerLabelFor(lane, row?.adapterType ?? success.providerId);
  const identity = row?.sublabel ?? success.slug;

  let syncState: 'checking' | 'pending' | 'ready' | 'attention' | 'unknown';
  let title: string;
  let badge: string;
  let description: string;
  let detail = '';

  if (state.loading) {
    syncState = 'checking';
    title = `${providerLabel} connected`;
    badge = 'Checking sync status';
    description = 'The connection is saved. Checking whether its first sync has finished…';
  } else if (state.error !== null || row === undefined) {
    syncState = 'unknown';
    title = 'Connection saved';
    badge = 'Sync status unavailable';
    description = state.error === null
      ? `Recued saved ${success.slug}, but it has not appeared in the account list yet.`
      : `Recued saved ${success.slug}, but could not refresh its sync status.`;
    detail = 'Try checking again. You do not need to repeat the sign-in flow.';
  } else if (row.authState !== 'healthy') {
    syncState = 'attention';
    title = `${providerLabel} connected, but needs attention`;
    badge = AUTH_STATE_LABEL[row.authState];
    description = 'The account is saved, but the server reports a connection problem that needs attention.';
    detail = 'Open the account details to review it. You do not need to repeat setup unless the issue persists.';
  } else if (row.lastSyncedAt === undefined || row.lastSyncedAt === null) {
    syncState = 'pending';
    title = `${providerLabel} connected`;
    badge = 'First sync pending';
    description = 'You can leave this page—syncing continues on your server.';
    detail = 'Continue to Chat now; Recued will prepare a first question when this account is searchable.';
  } else {
    syncState = 'ready';
    title = `${providerLabel} is ready`;
    badge = 'Ready for Chat';
    description = 'The first sync finished. This account is now available in Chat.';
    detail = `Last synced ${new Date(row.lastSyncedAt).toLocaleString()}.`;
  }

  const primary = syncState === 'unknown'
    ? button({
        label: 'Check sync status',
        variant: 'primary',
        size: 'sm',
        action: 'accounts-success-refresh',
      })
    : syncState === 'attention'
      ? button({
          label: 'View account',
          variant: 'primary',
          size: 'sm',
          action: 'accounts-open-detail',
          data: { slug: success.slug },
        })
      : button({
          label: syncState === 'ready' ? 'Ask about this account' : 'Continue to Chat',
          variant: 'primary',
          size: 'sm',
          action: 'accounts-success-go-chat',
        });
  const adjacentLane = lane.id === 'mail'
    ? { id: 'calendar', label: 'Connect a calendar' }
    : lane.id === 'calendar'
      ? { id: 'mail', label: 'Connect a mailbox' }
      : null;
  const adjacentAction = adjacentLane === null
    ? ''
    : button({
        label: adjacentLane.label,
        size: 'sm',
        action: 'accounts-success-open-lane',
        data: { lane: adjacentLane.id },
      });
  const checkAction = syncState === 'pending'
    ? button({
        label: 'Check status',
        variant: 'link',
        size: 'sm',
        action: 'accounts-success-refresh',
      })
    : '';

  return `
    <section class="accounts-success" data-accounts-connection-success
      data-sync-state="${e(syncState)}"
      tabindex="-1"
      aria-labelledby="accounts-success-${e(lane.id)}-${e(success.slug)}-title">
      <div class="accounts-success-icon" aria-hidden="true">✓</div>
      <div class="accounts-success-content">
        <div class="accounts-success-live" role="status" aria-live="polite" aria-atomic="true">
          <div class="accounts-success-heading">
            <p class="accounts-success-eyebrow">Account connected</p>
            <span class="accounts-success-badge" data-state="${e(syncState)}">${e(badge)}</span>
          </div>
          <h2 class="accounts-success-title"
            id="accounts-success-${e(lane.id)}-${e(success.slug)}-title">${e(title)}</h2>
          <p class="accounts-success-identity">${e(identity)}</p>
          <p class="accounts-success-desc">${e(description)}</p>
          ${detail ? `<p class="accounts-success-detail">${e(detail)}</p>` : ''}
          ${success.note
            ? `<p class="accounts-success-note" data-accounts-success-note>${e(success.note)}</p>`
            : ''}
        </div>
        <div class="accounts-success-actions">
          ${primary}
          ${adjacentAction}
          ${checkAction}
          ${button({
            label: 'Dismiss',
            variant: 'link',
            size: 'sm',
            action: 'accounts-dismiss-success',
          })}
        </div>
      </div>
    </section>
  `;
};

const renderOAuthReloadRecovery = (state: AccountsPanelState): string => {
  const recovery = state.oauthReloadRecovery;
  if (recovery === null) return '';
  const checking = recovery.status === 'checking';
  const ready = recovery.status === 'ready_to_retry';
  const title = checking
    ? `Checking ${recovery.providerLabel} connection`
    : ready
      ? 'Safe to restart sign-in'
      : 'Connection not confirmed yet';
  const description = checking
    ? `This tab reloaded while Recued may have been saving ${recovery.slug}. Checking the server before another sign-in…`
    : ready
      ? `Repeated checks did not find ${recovery.slug}. The interrupted code will not be reused; start a fresh sign-in when you are ready.`
      : recovery.error !== undefined
        ? 'Recued could not verify the server result. Do not repeat sign-in yet; check again when the connection is available.'
        : recovery.retryAfterSeconds !== undefined
          ? `Recued did not find ${recovery.slug} yet. Do not repeat sign-in yet; wait about ${recovery.retryAfterSeconds} seconds, then check again.`
          : `Recued did not find ${recovery.slug} yet. Do not repeat sign-in yet; give the server a moment, then check once more.`;

  return `
    <section class="accounts-oauth-recovery"
      data-accounts-oauth-recovery data-recovery-state="${e(recovery.status)}"
      aria-labelledby="accounts-oauth-recovery-title">
      <div class="accounts-oauth-recovery-icon" aria-hidden="true">↻</div>
      <div class="accounts-oauth-recovery-content">
        <div role="status" aria-live="polite" aria-atomic="true">
          <p class="accounts-oauth-recovery-eyebrow">Sign-in interrupted</p>
          <h2 class="accounts-oauth-recovery-title" id="accounts-oauth-recovery-title">${e(title)}</h2>
          <p class="accounts-oauth-recovery-desc">${e(description)}</p>
          ${recovery.error !== undefined
            ? `<p class="accounts-oauth-recovery-error">${e(recovery.error)}</p>`
            : ''}
        </div>
        ${checking ? '' : `<div class="accounts-oauth-recovery-actions">
          ${ready ? button({
            label: 'Restart sign-in',
            size: 'sm',
            variant: 'primary',
            action: 'accounts-oauth-recovery-restart',
          }) : ''}
          ${button({
            label: 'Check again',
            size: 'sm',
            variant: ready ? 'link' : 'primary',
            action: 'accounts-oauth-recovery-check',
          })}
        </div>`}
      </div>
    </section>
  `;
};

const renderRow = (lane: AccountLane, row: AccountRow): string => {
  const status = displayStatusFor(row);
  return `
    <li class="accounts-row" data-account-slug="${e(row.slug)}">
      <button type="button" class="accounts-row-main"
        data-action="accounts-open-detail" data-slug="${e(row.slug)}">
        <span class="accounts-row-name">${e(row.slug)}</span>
        <span class="accounts-row-meta">
          <span class="accounts-badge">${e(providerLabelFor(lane, row.adapterType))}</span>
          <span class="accounts-status" data-state="${e(status.state)}">${e(status.label)}</span>
          ${row.sendCapable ? '<span class="accounts-badge accounts-badge--send">can send</span>' : ''}
        </span>
        ${row.sublabel ? `<span class="accounts-row-sub">${e(row.sublabel)}</span>` : ''}
      </button>
    </li>
  `;
};

const renderEmptyState = (lane: AccountLane): string => `
  <section class="accounts-empty" data-accounts-empty
    aria-labelledby="accounts-empty-${e(lane.id)}-title">
    <div class="accounts-empty-copy">
      <h2 class="accounts-empty-title" id="accounts-empty-${e(lane.id)}-title">
        ${e(lane.emptyTitle)}
      </h2>
      <p class="accounts-empty-desc">${e(lane.emptyDescription)}</p>
      <div class="accounts-empty-providers">
        <p class="accounts-empty-providers-label"
          id="accounts-empty-${e(lane.id)}-providers-label">Available options</p>
        <ul class="accounts-empty-provider-list"
          aria-labelledby="accounts-empty-${e(lane.id)}-providers-label">
          ${lane.providers
            .map((provider) => `<li>${e(provider.label)}</li>`)
            .join('')}
        </ul>
      </div>
    </div>
    <div class="accounts-empty-action">
      ${button({
        label: lane.addLabel,
        variant: 'primary',
        size: 'sm',
        action: 'accounts-open-add',
      })}
    </div>
  </section>
`;

const renderList = (lane: AccountLane, state: AccountsPanelState): string => {
  const hasSuccess = state.connectionSuccess !== null;
  const hasRecovery = state.oauthReloadRecovery !== null;
  const isEmpty = !hasSuccess
    && !hasRecovery
    && !state.loading
    && state.error === null
    && state.rows.length === 0;
  let body: string;
  if (state.loading) {
    body = hasSuccess || hasRecovery ? '' : `
      <div class="accounts-loading-state" role="status" aria-live="polite">
        <span class="accounts-loading-dot" aria-hidden="true"></span>
        <span>Loading ${e(lane.label.toLowerCase())}…</span>
      </div>
    `;
  } else if (state.error !== null) {
    body = inlineError(state.error);
  } else if (isEmpty) {
    body = renderEmptyState(lane);
  } else if (state.rows.length === 0) {
    body = '';
  } else {
    body = `<ul class="accounts-rows">${state.rows.map((r) => renderRow(lane, r)).join('')}</ul>`;
  }
  const canAdd = lane.providers.length > 0;
  const addRow = canAdd
    && !state.loading
    && state.error === null
    && state.rows.length > 0
    ? `<div class="accounts-add-row">${button({
        label: `+ ${lane.addLabel}`,
        variant: 'primary',
        size: 'sm',
        action: 'accounts-open-add',
      })}</div>`
    : '';
  const pending = lane.pending ? inlineHint(lane.pending) : '';
  return `
    ${renderOAuthReloadRecovery(state)}
    ${renderConnectionSuccess(lane, state)}
    ${isEmpty || state.rows.length === 0
      ? ''
      : `<header class="accounts-list-header">
          <h2 class="accounts-list-title">${e(lane.listTitle)}</h2>
          <p class="accounts-blurb">${e(lane.blurb)}</p>
        </header>`}
    ${body}
    ${addRow}
    ${pending}
  `;
};

const renderDetail = (lane: AccountLane, state: AccountsPanelState): string => {
  const row = state.rows.find((r) => r.slug === state.detailSlug);
  if (row === undefined) {
    return `
      <div class="accounts-detail">
        ${
          state.loading
            ? '<p class="accounts-loading">Loading account…</p>'
            : inlineError('Account not found — it may have been removed.')
        }
        <div class="accounts-form-actions">
          ${button({ label: 'Back', size: 'sm', action: 'accounts-back-to-list' })}
        </div>
      </div>
    `;
  }
  const busyKey = (op: string): boolean => state.rowBusy.has(`${op}:${row.slug}`);
  const rowErr = state.rowError[row.slug];
  const status = displayStatusFor(row);
  const lastSyncedAt = row.lastSyncedAt;
  const hasSynced = lastSyncedAt !== undefined && lastSyncedAt !== null;
  const synced =
    !hasSynced
      ? row.authState === 'healthy' ? 'Waiting for first sync' : 'No successful sync yet'
      : new Date(lastSyncedAt).toLocaleString();
  // Re-sync exists on calendar + file lanes; reauthorization is calendar-only.
  const lifecycle = lane.id !== 'mail';
  return `
    <div class="accounts-detail">
      <h2 class="accounts-detail-title" data-accounts-detail-heading tabindex="-1">${e(row.slug)}</h2>
      <dl class="accounts-detail-grid">
        <dt>Provider</dt><dd>${e(providerLabelFor(lane, row.adapterType))}</dd>
        <dt>Status</dt><dd><span class="accounts-status" data-state="${e(status.state)}">${e(status.label)}</span></dd>
        ${row.sublabel ? `<dt>Account</dt><dd>${e(row.sublabel)}</dd>` : ''}
        <dt>${hasSynced ? 'Last synced' : 'Sync'}</dt><dd>${e(synced)}</dd>
      </dl>
      ${rowErr ? inlineError(rowErr) : ''}
      <div class="accounts-form-actions">
        ${
          lifecycle
            ? button({
                label: busyKey('resync') ? 'Re-syncing…' : 'Re-sync',
                size: 'sm',
                action: 'accounts-resync',
                data: { slug: row.slug },
                ariaDisabled: busyKey('resync'),
                ariaBusy: busyKey('resync'),
              })
            : ''
        }
        ${
          lane.id === 'calendar'
            && row.reauthAvailable === true
            && row.authState !== 'healthy'
            ? button({
                label: busyKey('reauth') ? 'Re-authorizing…' : 'Re-authorize',
                size: 'sm',
                action: 'accounts-reauth',
                data: { slug: row.slug },
                ariaDisabled: busyKey('reauth'),
                ariaBusy: busyKey('reauth'),
              })
            : ''
        }
        ${button({
          label: busyKey('delete') ? 'Removing…' : 'Remove',
          variant: 'danger',
          size: 'sm',
          action: 'accounts-delete',
          data: { slug: row.slug },
          disabled: busyKey('delete'),
        })}
        ${button({ label: 'Back', size: 'sm', action: 'accounts-back-to-list' })}
      </div>
    </div>
  `;
};

/** Route presentation for a boot-owned OAuth transaction. The owner may leave
 *  without interrupting it; explicit cancellation remains available only
 *  until the authorization code is accepted. */
const renderOAuthFinishing = (
  provider: AccountProvider | undefined,
  progress: AccountsOAuthProgressStage | null,
): string => {
  const who = provider ? `your ${provider.label} account` : 'your account';
  const stage = progress ?? 'finishing';
  const canCancel = stage !== 'finishing';
  const title = stage === 'preparing'
    ? 'Preparing sign-in…'
    : stage === 'waiting_for_consent'
      ? 'Waiting for sign-in…'
      : 'Finishing connection…';
  const description = stage === 'preparing'
    ? `Recued is getting sign-in for ${who} ready. Keep the popup open; you can work elsewhere.`
    : stage === 'waiting_for_consent'
      ? `Complete sign-in for ${who} in the popup. You can keep working elsewhere; Recued will keep this connection in progress.`
      : `Sign-in for ${who} is complete. Recued is saving the connection; you can keep working elsewhere.`;
  return `
    <div class="accounts-finishing">
      <div class="accounts-finishing-progress"
           role="status" aria-live="polite" aria-atomic="true">
        <div class="accounts-finishing-spinner" aria-hidden="true"></div>
        <h3 class="accounts-finishing-title">${title}</h3>
        <p class="accounts-finishing-desc">${e(description)}</p>
      </div>
      <div class="accounts-form-actions">
        ${button({ label: 'Keep working', size: 'sm', action: 'accounts-oauth-dismiss' })}
        ${canCancel
          ? button({ label: 'Cancel sign-in', size: 'sm', action: 'accounts-oauth-cancel' })
          : ''}
      </div>
    </div>
  `;
};

/** Per-issuer, step-by-step "create your own OAuth app" guide, in a native
 *  `<details>` so it stays collapsed until the user needs it. Static text
 *  (no interpolation of untrusted input) — it references the exact redirect
 *  URI rendered above it rather than repeating the value. */
const oauthAppGuide = (
  issuer: OAuthAppIssuer,
  open = false,
): string => {
  const steps =
    issuer === 'google'
      ? [
          'Open the Google Cloud Console and create (or pick) a project.',
          'Under APIs &amp; Services → Library, enable the Gmail API (and the Google Calendar API if you will sync calendars).',
          'Configure the OAuth consent screen. Google Workspace account: choose Internal — no verification needed, and refresh tokens are long-lived. Personal Google account: choose External.',
          'External only — set Publishing status to <strong>In production</strong> (OAuth consent screen → Publish app). Do NOT leave it in Testing: apps in Testing status issue refresh tokens that <strong>expire after 7 days</strong>, so your mail sync would stop every week. Publishing does not require Google verification for your own use — you will see a "Google hasn&rsquo;t verified this app" screen at sign-in, where Advanced → Go to (unsafe) proceeds. Unverified apps are capped at 100 users, which is ample for a personal server.',
          'Go to Credentials → Create credentials → OAuth client ID → Web application.',
          'Under Authorized redirect URIs, add the exact callback URL shown in step 2 below.',
          'Create it, then copy the Client ID and Client secret into step 3 below.',
        ]
      : [
          'Open the Azure portal → Microsoft Entra ID → App registrations → New registration. Under "Supported account types" choose "Accounts in any organizational directory and personal Microsoft accounts" — Recued signs in via the /common endpoint, so a single-tenant or org-only app is rejected with "not enabled for consumers".',
          'Under "Redirect URI" pick the Web platform (NOT "Single-page application" — Web uses the client-secret flow Recued needs), paste the exact callback URL shown in step 2 below, then Register.',
          'Open API permissions → Add a permission → Microsoft Graph → Delegated permissions. Add <strong>Mail.Read</strong>, <strong>offline_access</strong> and <strong>User.Read</strong> — all three are required, and without offline_access there is no refresh token, so syncing stops about an hour after you connect. Then add <strong>Mail.Send</strong> if you want Recued to send mail, and <strong>Calendars.ReadWrite</strong> if you tick "Also connect Calendar". Entra only issues a scope the app registration lists, so a permission missing here cannot be granted at sign-in no matter what you tick on the form.',
          'Open Certificates &amp; secrets → New client secret, then copy its Value immediately (it is shown only once).',
          'From the Overview page copy the Application (client) ID, and paste it plus the secret Value into step 3 below.',
        ];
  const provider = OAUTH_ISSUER_LABEL[issuer];
  const providerConsole = OAUTH_ISSUER_CONSOLE[issuer];
  return `
    <details class="accounts-oauth-guide"${open ? ' open' : ''}>
      <summary>${open ? '1. ' : ''}Create a ${e(provider)} OAuth app</summary>
      <a class="accounts-oauth-console-link" href="${e(providerConsole.href)}"
        target="_blank" rel="noopener noreferrer"
        aria-label="${e(providerConsole.label)} (opens in a new tab)">
        ${e(providerConsole.label)} <span aria-hidden="true">↗</span>
      </a>
      <ol class="accounts-oauth-guide-steps">
        ${steps.map((s) => `<li>${s}</li>`).join('')}
      </ol>
    </details>
  `;
};

export interface AccountsPanelProps {
  state: AccountsPanelState;
}

/** Pure renderer for ONE foundational-account lane — the active stage
 *  (list / provider-picker / form / detail). The unified
 *  `[Mail · Calendar · Files · Apps & APIs]` tab bar lives in the
 *  webclient route (it spans this panel + the separate `connection.*`
 *  enroll panel), so this renderer draws lane content only. */
/** Removal prompt. Mirrors the `connection.*` lane's dialog (same modal shape,
 *  same Cancel / danger-Remove pair) so the two Connections surfaces behave
 *  identically.
 *
 *  The copy states what removal ACTUALLY does, which is narrower than "delete":
 *  the server stops syncing and forgets the sign-in, but everything already
 *  pulled into the warehouse stays (`onDeleted` only stops the live collection —
 *  it does not drop the collection's table). Saying "this deletes your mail"
 *  would be a scarier lie; saying nothing leaves people guessing. */
const renderAccountsDeleteConfirm = (state: AccountsPanelState): string => {
  const dc = state.deleteConfirm;
  if (dc === null) return '';
  return `
    <div class="accounts-delete-backdrop" data-accounts-delete-backdrop>
      <div class="accounts-delete-confirm" role="dialog" aria-modal="true"
           aria-label="Remove account ${e(dc.slug)}"
           data-accounts-delete-dialog tabindex="-1">
        <h3 class="accounts-delete-title">Remove ${e(dc.slug)}?</h3>
        <p class="accounts-delete-body">
          Recued stops syncing this ${e(dc.providerLabel)} account and forgets its
          sign-in. Everything already synced stays in your warehouse. Reconnecting
          means signing in again.
        </p>
        <div class="accounts-delete-actions">
          ${button({
            label: 'Cancel',
            size: 'sm',
            action: 'accounts-delete-cancel',
            ariaDisabled: dc.deleting,
          })}
          ${button({
            label: dc.deleting ? 'Removing…' : 'Remove',
            size: 'sm',
            variant: 'danger',
            action: 'accounts-delete-confirm',
            data: { slug: dc.slug },
            ariaDisabled: dc.deleting,
            ariaBusy: dc.deleting,
          })}
        </div>
      </div>
    </div>
  `;
};

export const renderAccountsPanel = (props: AccountsPanelProps): string => {
  const { state } = props;
  const lane = findAccountLane(state.lane) ?? ACCOUNT_LANES[0]!;

  let stageHtml: string;
  if (state.oauthFinishing) {
    // Overlays the OAuth `form` for the whole connect span (popup-open through
    // the code-exchange) — see `renderOAuthFinishing`.
    const provider =
      state.providerId !== null ? findAccountProvider(lane, state.providerId) : undefined;
    stageHtml = renderOAuthFinishing(provider, state.oauthProgressStage);
  } else if (state.stage === 'provider-picker') {
    stageHtml = renderProviderPicker(lane);
  } else if (state.stage === 'form') {
    const provider =
      state.providerId !== null ? findAccountProvider(lane, state.providerId) : undefined;
    stageHtml =
      provider !== undefined
        ? renderProviderForm(lane, provider, state)
        : renderList(lane, state);
  } else if (state.stage === 'detail') {
    stageHtml = renderDetail(lane, state);
  } else {
    stageHtml = renderList(lane, state);
  }

  return `
    <div class="accounts-panel" data-accounts-lane="${e(state.lane)}">
      <div class="accounts-stage">${stageHtml}</div>
      ${renderAccountsDeleteConfirm(state)}
    </div>
  `;
};

// ════════════════════════════════════════════════════════════════
// Styles (scoped to [data-accounts-lane])
// ════════════════════════════════════════════════════════════════

export const ACCOUNTS_PANEL_STYLES = `
.accounts-panel { min-width: 0; display: grid; gap: 14px; }
.accounts-delete-backdrop {
  box-sizing: border-box; min-width: 0; max-width: 100%;
  position: fixed; inset: 0; z-index: 40;
  display: grid; place-items: center;
  padding: 24px; background: rgba(24, 24, 27, 0.45);
}
.accounts-delete-confirm {
  box-sizing: border-box; min-width: 0; max-width: 100%;
  width: min(420px, 100%);
  display: grid; gap: 12px; padding: 20px;
  border: 1px solid var(--border); border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 12px 32px rgba(24, 24, 27, 0.18);
}
.accounts-delete-title {
  min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 15px;
}
.accounts-delete-body {
  min-width: 0; margin: 0; overflow-wrap: anywhere;
  color: var(--muted); font-size: 13px; line-height: 1.5;
}
.accounts-delete-actions {
  min-width: 0; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;
}
.accounts-stage { min-width: 0; }
.accounts-list-header { margin: 0 0 10px; }
.accounts-list-title {
  margin: 0 0 3px; color: var(--fg-strong, var(--fg));
  font-size: 16px; line-height: 1.3; font-weight: 680;
}
.accounts-blurb { margin: 0; color: var(--muted); font-size: 13px; }
.accounts-empty {
  position: relative; overflow: hidden;
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: center; gap: 24px;
  padding: 24px 24px 24px 27px;
  border: 1px solid var(--border); border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.04);
}
.accounts-empty::before {
  content: ''; position: absolute; inset: 0 auto 0 0; width: 3px;
  background: var(--accent);
}
.accounts-empty-copy { min-width: 0; }
.accounts-empty-title {
  margin: 0; color: var(--fg-strong, var(--fg));
  font-size: 18px; line-height: 1.3; font-weight: 680;
}
.accounts-empty-desc {
  max-width: 650px; margin: 6px 0 0;
  color: var(--muted); font-size: 13px; line-height: 1.55;
}
.accounts-empty-providers { margin-top: 14px; }
.accounts-empty-providers-label {
  display: block; margin-bottom: 7px;
  color: var(--muted); font-size: 11px; font-weight: 650;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.accounts-empty-provider-list {
  list-style: none; display: flex; flex-wrap: wrap; gap: 6px;
  margin: 0; padding: 0;
}
.accounts-empty-provider-list li {
  padding: 4px 9px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--surface-sunk); color: var(--fg); font-size: 11px;
  font-weight: 600; line-height: 1.3;
}
.accounts-empty-action { flex: 0 0 auto; }
.accounts-loading-state {
  display: flex; align-items: center; gap: 9px;
  min-height: 72px; padding: 0 2px;
  color: var(--muted); font-size: 13px;
}
.accounts-loading-dot {
  width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%;
  background: var(--accent); animation: accounts-loading-pulse 1.2s ease-in-out infinite;
}
@keyframes accounts-loading-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.86); }
  50% { opacity: 1; transform: scale(1); }
}
.accounts-oauth-recovery {
  position: relative; overflow: hidden;
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 14px;
  margin-bottom: 16px; padding: 18px 20px;
  border: 1px solid var(--border-strong); border-radius: 14px;
  background: var(--surface-sunk);
}
.accounts-oauth-recovery::before {
  content: ''; position: absolute; inset: 0 auto 0 0; width: 3px;
  background: var(--warn, #ef6c00);
}
.accounts-oauth-recovery-icon {
  display: grid; place-items: center; width: 34px; height: 34px;
  border-radius: 50%; background: var(--surface); color: var(--warn, #ef6c00);
  font-size: 20px; font-weight: 750; line-height: 1;
}
.accounts-oauth-recovery-content { min-width: 0; }
.accounts-oauth-recovery-eyebrow {
  margin: 0; color: var(--muted); font-size: 10px; line-height: 1.3;
  font-weight: 750; letter-spacing: 0.075em; text-transform: uppercase;
}
.accounts-oauth-recovery-title {
  margin: 4px 0 0; color: var(--fg-strong, var(--fg));
  font-size: 16px; line-height: 1.35; font-weight: 700;
}
.accounts-oauth-recovery-desc,
.accounts-oauth-recovery-error {
  margin: 7px 0 0; color: var(--fg); font-size: 13px; line-height: 1.5;
}
.accounts-oauth-recovery-error { color: var(--danger); }
.accounts-oauth-recovery-actions {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: 13px;
}
.accounts-success {
  position: relative; overflow: hidden;
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 14px;
  margin-bottom: 16px; padding: 19px 20px;
  border: 1px solid var(--border-strong); border-radius: 14px;
  background:
    linear-gradient(135deg, var(--accent-weak), transparent 58%),
    var(--surface);
  box-shadow: 0 4px 16px rgba(24, 24, 27, 0.06);
}
.accounts-success::before {
  content: ''; position: absolute; inset: 0 auto 0 0; width: 3px;
  background: var(--accent);
}
.accounts-success:focus {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
.accounts-success-icon {
  display: grid; place-items: center; width: 34px; height: 34px;
  border-radius: 50%; background: var(--accent); color: var(--on-accent);
  font-size: 17px; font-weight: 800; line-height: 1;
}
.accounts-success-content, .accounts-success-live { min-width: 0; }
.accounts-success-heading {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; flex-wrap: wrap;
}
.accounts-success-eyebrow {
  margin: 0; color: var(--muted); font-size: 10px; line-height: 1.3;
  font-weight: 750; letter-spacing: 0.075em; text-transform: uppercase;
}
.accounts-success-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 8px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--surface); color: var(--fg); font-size: 10px;
  line-height: 1.35; font-weight: 700;
}
.accounts-success-badge::before {
  content: ''; width: 6px; height: 6px; flex: 0 0 auto;
  border-radius: 50%; background: currentColor;
}
.accounts-success-badge[data-state='checking']::before,
.accounts-success-badge[data-state='pending']::before { background: var(--accent); }
.accounts-success-badge[data-state='ready'] { color: var(--ok, #2e7d32); }
.accounts-success-badge[data-state='attention'] { color: var(--danger); }
.accounts-success-badge[data-state='unknown'] { color: var(--warn); }
.accounts-success-title {
  margin: 4px 0 0; color: var(--fg-strong, var(--fg));
  font-size: 17px; line-height: 1.35; font-weight: 700;
}
.accounts-success-identity {
  margin: 3px 0 0; overflow-wrap: anywhere; color: var(--fg);
  font-size: 12px; line-height: 1.45; font-weight: 620;
}
.accounts-success-desc {
  margin: 9px 0 0; color: var(--fg); font-size: 13px; line-height: 1.5;
}
.accounts-success-detail {
  margin: 2px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5;
}
.accounts-success-actions {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: 14px;
}
.accounts-rows { min-width: 0; list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.accounts-row { min-width: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.accounts-row-main {
  box-sizing: border-box; min-width: 0; max-width: 100%;
  appearance: none; width: 100%; text-align: left; background: transparent;
  border: 0; padding: 12px 14px; font: inherit; color: var(--fg);
  cursor: pointer; display: grid; gap: 4px;
}
.accounts-row-main:hover { background: var(--surface-subtle); }
.accounts-row-name {
  min-width: 0; overflow-wrap: anywhere; font-weight: 650; font-size: 14px;
}
.accounts-row-meta { min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.accounts-row-sub {
  min-width: 0; overflow-wrap: anywhere; color: var(--muted); font-size: 12px;
}
.accounts-badge {
  min-width: 0; max-width: 100%; overflow-wrap: anywhere;
  font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px;
  background: var(--surface-sunk); color: var(--muted); border: 1px solid var(--border);
}
.accounts-badge--send { color: var(--accent); }
.accounts-status { font-size: 12px; font-weight: 600; color: var(--muted); }
.accounts-status[data-state='healthy'] { color: var(--ok, #2e7d32); }
.accounts-status[data-state='syncing'] { color: var(--accent); }
.accounts-status[data-state='expired'],
.accounts-status[data-state='unauthorized'] { color: var(--danger, #c62828); }
.accounts-status[data-state='degraded'] { color: var(--warn, #ef6c00); }
.accounts-add-row { margin-top: 4px; }
.accounts-picker-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.accounts-picker-card {
  appearance: none; text-align: left; cursor: pointer; display: grid; gap: 4px;
  padding: 14px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--surface); font: inherit; color: var(--fg);
}
.accounts-picker-card:hover { border-color: var(--accent); }
.accounts-picker-card-desc { color: var(--muted); font-size: 12px; }
.accounts-picker-title, .accounts-form-title { margin: 0 0 4px; font-size: 16px; font-weight: 650; }
.accounts-form-desc { margin: 0 0 12px; color: var(--muted); font-size: 13px; }
.accounts-form--oauth { max-width: 780px; }
.accounts-form-section-title {
  margin: 18px 0 9px; color: var(--fg); font-size: 12px; font-weight: 700;
  letter-spacing: 0.035em; text-transform: uppercase;
}
.accounts-form-fields { display: grid; gap: 12px; }
.accounts-form-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.accounts-finishing { display: grid; gap: 12px; justify-items: center; text-align: center; padding: 28px 0; }
.accounts-finishing-progress { display: grid; gap: 12px; justify-items: center; }
.accounts-finishing-spinner {
  width: 28px; height: 28px; border-radius: 50%;
  border: 3px solid var(--border); border-top-color: var(--accent);
  animation: accounts-spin 0.8s linear infinite;
}
@keyframes accounts-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .accounts-finishing-spinner, .accounts-loading-dot { animation: none; }
}
.accounts-finishing-title { margin: 0; font-size: 16px; font-weight: 650; }
.accounts-finishing-desc { margin: 0; color: var(--muted); font-size: 13px; }
.accounts-oauth-app {
  display: grid; gap: 14px; margin-top: 20px;
  padding: 16px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--surface);
}
.accounts-oauth-app--ready {
  border-color: var(--border-strong);
  background: var(--accent-weak);
}
.accounts-oauth-app--setup { background: var(--surface-sunk); }
.accounts-oauth-app-header {
  display: flex; align-items: flex-start; gap: 11px; min-width: 0;
}
.accounts-oauth-app-title {
  margin: 0; color: var(--fg-strong, var(--fg));
  font-size: 14px; line-height: 1.35; font-weight: 680;
}
.accounts-oauth-app-desc {
  margin: 3px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5;
}
.accounts-oauth-state-icon {
  display: grid; place-items: center; flex: 0 0 auto;
  width: 24px; height: 24px; border-radius: 50%;
  background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 800;
}
.accounts-oauth-setup-badge {
  flex: 0 0 auto; padding: 4px 8px; border-radius: 999px;
  background: var(--accent-weak); color: var(--accent);
  font-size: 10px; line-height: 1.3; font-weight: 750;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.accounts-oauth-shared-note {
  margin: -2px 0 0; padding: 9px 10px; border-radius: 8px;
  background: var(--surface); color: var(--muted); font-size: 12px; line-height: 1.45;
}
.accounts-oauth-manage {
  border-top: 1px solid var(--border); padding-top: 11px;
}
.accounts-oauth-manage > summary,
.accounts-oauth-guide > summary {
  cursor: pointer; color: var(--fg); font-size: 12px; font-weight: 650;
}
.accounts-oauth-manage-body {
  display: grid; gap: 14px; margin-top: 13px;
}
.accounts-oauth-credentials,
.accounts-oauth-callback { display: grid; gap: 7px; }
.accounts-oauth-step-title {
  margin: 0; color: var(--fg); font-size: 12px; line-height: 1.4; font-weight: 700;
}
.accounts-oauth-step-desc {
  margin: -3px 0 0; color: var(--muted); font-size: 11px; line-height: 1.45;
}
.accounts-oauth-callback-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: stretch; gap: 8px;
}
.accounts-oauth-redirect {
  display: block; min-width: 0; overflow-wrap: anywhere;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--surface-sunk);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px; line-height: 1.4;
}
.accounts-oauth-app .accounts-form-fields { gap: 12px; }
.accounts-oauth-guide {
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--surface); padding: 9px 11px;
}
.accounts-oauth-console-link {
  display: inline-flex; align-items: center; gap: 4px; margin-top: 10px;
  color: var(--accent); font-size: 12px; line-height: 1.4; font-weight: 650;
  text-decoration: none;
}
.accounts-oauth-console-link:hover { text-decoration: underline; }
.accounts-oauth-console-link:focus-visible {
  border-radius: 3px; outline: 2px solid var(--accent); outline-offset: 3px;
}
.accounts-oauth-guide-steps {
  margin: 10px 0 2px; padding-left: 20px; display: grid; gap: 8px;
  color: var(--muted); font-size: 12px; line-height: 1.5;
}
.accounts-detail { min-width: 0; }
.accounts-detail-title {
  min-width: 0; margin: 0 0 10px; overflow-wrap: anywhere;
  font-size: 16px; font-weight: 650;
}
.accounts-detail-grid {
  min-width: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 16px; margin: 0; font-size: 13px;
}
.accounts-detail-grid dt { color: var(--muted); }
.accounts-detail-grid dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.accounts-loading { color: var(--muted); font-size: 13px; }
@media (max-width: 640px) {
  .accounts-empty {
    grid-template-columns: minmax(0, 1fr); gap: 18px;
    padding: 21px 19px 21px 22px;
  }
  .accounts-empty-action .rx-btn { width: 100%; justify-content: center; }
  .accounts-success { padding: 17px 16px 17px 18px; }
  .accounts-success-actions .rx-btn-primary { flex: 1 1 100%; }
  .accounts-oauth-recovery { padding: 17px 16px 17px 18px; }
  .accounts-oauth-recovery-actions .rx-btn-primary { flex: 1 1 100%; }
  .accounts-oauth-app-header { flex-wrap: wrap; }
  .accounts-oauth-callback-row { grid-template-columns: minmax(0, 1fr); }
  .accounts-oauth-callback-row .rx-btn { width: 100%; }
}
`;
