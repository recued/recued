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
import { emptyHint } from '../primitives/empty-hint.js';

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
  blurb: string;
  providers: readonly AccountProvider[];
  /** Honest one-liner shown when the lane has providers that are not yet
   *  buildable (OAuth / CalDAV — later slices). Plain text, escaped. */
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

/** Shared field set for the mail OAuth providers — a slug for the mailbox
 *  instance + an opt-in send toggle (widens the OAuth scopes). The `code`
 *  comes from the consent popup, not the form. */
const mailOAuthFields = (sendHelp: string): readonly AccountField[] => [
  {
    key: 'name',
    label: 'Account name',
    type: 'identifier',
    placeholder: 'work',
    help: 'A short id for this mailbox (lowercase letters, digits, - and _).',
  },
  {
    key: 'send_enabled',
    label: 'Allow sending mail',
    type: 'boolean',
    optional: true,
    default: 'false',
    help: sendHelp,
  },
];

/** OAuth providers carry slug + send toggle as form values; the mount reads
 *  them to build the authorize URL + the enrollOAuth call. */
const projectMailOAuth = (v: AccountFormValues): Record<string, unknown> => ({
  account_slug: (v['name'] ?? '').trim(),
  send_enabled: v['send_enabled'] === 'true',
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
      default: 'false',
      help: 'On for MinIO and some S3-compatible stores.',
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
    label: 'Calendar account name',
    type: 'identifier',
    placeholder: 'work',
    help: 'A short id for this calendar (lowercase letters, digits, - and _).',
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
    blurb: 'Mailboxes Recued reads and (optionally) sends from.',
    providers: [IMAP_PROVIDER, GMAIL_PROVIDER, MICROSOFT_MAIL_PROVIDER],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    blurb: 'Calendars Recued reads events from.',
    providers: [
      GOOGLE_CALENDAR_PROVIDER,
      MICROSOFT_CALENDAR_PROVIDER,
      CALDAV_PROVIDER,
    ],
  },
  {
    id: 'file',
    label: 'Files',
    blurb: 'Folders and buckets Recued reads files from.',
    providers: [FS_PROVIDER, S3_PROVIDER],
    pending: 'Google Drive sign-in arrives in a later update.',
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
  /** Unix-ms of last successful sync, or null before the first tick. */
  lastSyncedAt?: number | null;
}

export type AccountsPanelStage =
  | 'list'
  | 'provider-picker'
  | 'form'
  | 'detail';

/** The BYO OAuth-app credential fields (client_id + client_secret) rendered
 *  INLINE on the OAuth provider form, alongside the account name / send
 *  toggle. Held separately from the account-form `values` so the secret never
 *  mixes with the enroll args; saved via `setOAuthAppConfig` as part of
 *  Connect when entered. */
export interface OAuthCredValues {
  client_id: string;
  client_secret: string;
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
  /** OAuth flow — true during the post-consent code-exchange (the consent
   *  popup has closed; the server is exchanging the code + the list hasn't
   *  refreshed yet). Renders a "Finishing sign-in…" card with an immediate
   *  "Back to accounts" escape so the brief wait never feels stuck. */
  oauthFinishing: boolean;
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

/** Resolve the OAuth-app issuer for an OAuth provider (id is one of
 *  `gmail` / `gcal` / `graph`). Returns null for non-OAuth providers. */
const issuerForProvider = (provider: AccountProvider): OAuthAppIssuer | null =>
  isOAuthAccountTransport(provider.transport)
    ? oauthAppIssuerForProvider(provider.id as 'gmail' | 'gcal' | 'graph')
    : null;

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

/** Operator setup note on the OAuth forms: the EXACT callback URL that must
 *  be registered as an authorized redirect URI in the provider's OAuth app.
 *  Built from the same `buildOpenerRelayRedirectUri` the flow embeds in the
 *  authorize URL and passes to `enrollOAuth`, so the shown value byte-matches
 *  what the provider receives — the fix for a `redirect_uri_mismatch`. */
const renderOAuthRedirectHint = (appOrigin: string, noQueryMarker = false): string => {
  const redirectUri = buildOpenerRelayRedirectUri(appOrigin, noQueryMarker);
  return inlineMessage({
    tone: 'hint',
    htmlMessage:
      'Your OAuth app must allow this exact authorized redirect URI: '
      + `<code class="accounts-oauth-redirect">${e(redirectUri)}</code>`,
  });
};

/** Inline "Your {Google/Microsoft} sign-in app" section on the OAuth provider
 *  form — the BYO client_id + client_secret fields (rendered alongside the
 *  account name / send toggle, NOT a separate stage), with the exact redirect
 *  URI to register and a collapsible per-issuer guide. The credentials are
 *  saved (`setOAuthAppConfig`) as part of Connect when entered; when an app is
 *  already configured the fields can be left blank to reuse it. */
const renderOAuthAppSection = (
  issuer: OAuthAppIssuer,
  state: AccountsPanelState,
): string => {
  const label = OAUTH_ISSUER_LABEL[issuer];
  const status = state.oauthAppConfig?.[issuer] ?? null;
  // "Reusable without a secret" needs an actual saved/env secret — an env
  // client_id with no secret (`has_secret: false`) still requires one entered.
  const reusable = status !== null && status.source !== null && status.has_secret === true;
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
      ? 'Saved on your server — leave blank to reuse, or re-enter to change it.'
      : 'From your OAuth app. Stored encrypted on your server; never shown again.',
  });

  const savedNote = reusable
    ? inlineMessage({
        tone: 'ok',
        message:
          status?.source === 'env'
            ? `${label} sign-in is configured on this server. Leave the fields blank to use it.`
            : `Your ${label} app is saved. Leave the fields blank to reuse it, or re-enter to change it.`,
      })
    : '';
  // Microsoft Entra rejects query strings in redirect URIs, so the Microsoft
  // redirect URI (and the value shown here to register) drops the marker.
  const redirectHint =
    state.appOrigin !== undefined
      ? renderOAuthRedirectHint(state.appOrigin, issuer === 'microsoft')
      : '';

  return `
    <div class="accounts-oauth-app">
      <p class="accounts-oauth-app-title">Your ${e(label)} sign-in app</p>
      ${inlineHint(OAUTH_ISSUER_COVERS[issuer])}
      <div class="accounts-form-fields">
        ${clientIdField}
        ${clientSecretField}
      </div>
      ${savedNote}
      ${redirectHint}
      ${oauthAppGuide(issuer)}
    </div>
  `;
};

const renderProviderForm = (
  lane: AccountLane,
  provider: AccountProvider,
  state: AccountsPanelState,
): string => {
  const valid = validateAccountForm(provider, state.values) === null;
  const fields = provider.fields.map((f) => renderField(f, state.values)).join('');
  const backAction = lane.providers.length > 1 ? 'accounts-open-add' : 'accounts-back-to-list';

  const isOAuth = isOAuthAccountTransport(provider.transport);
  const issuer = issuerForProvider(provider);
  // BYO OAuth-app credential fields render INLINE on the provider form.
  const oauthSection = isOAuth && issuer !== null ? renderOAuthAppSection(issuer, state) : '';

  const primary = isOAuth
    ? button({
        label: state.saving ? 'Connecting…' : 'Connect ' + provider.label,
        variant: 'primary',
        size: 'sm',
        action: 'accounts-oauth-connect',
        disabled: state.saving || !valid,
      })
    : button({
        label: state.saving ? 'Adding…' : 'Add account',
        variant: 'primary',
        size: 'sm',
        action: 'accounts-submit-form',
        disabled: state.saving || !valid,
      });

  return `
    <div class="accounts-form">
      <h3 class="accounts-form-title">Add ${e(provider.label)}</h3>
      <p class="accounts-form-desc">${e(provider.description)}</p>
      ${state.formError !== null ? inlineError(state.formError) : ''}
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

const renderProviderPicker = (lane: AccountLane): string => `
  <div class="accounts-picker">
    <h3 class="accounts-picker-title">Add a ${e(lane.label.toLowerCase())} account</h3>
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

const providerLabelFor = (lane: AccountLane, adapterType: string): string => {
  const match = lane.providers.find((p) => p.id === adapterType);
  return match ? match.label : adapterType;
};

const renderRow = (lane: AccountLane, row: AccountRow): string => {
  return `
    <li class="accounts-row" data-account-slug="${e(row.slug)}">
      <button type="button" class="accounts-row-main"
        data-action="accounts-open-detail" data-slug="${e(row.slug)}">
        <span class="accounts-row-name">${e(row.slug)}</span>
        <span class="accounts-row-meta">
          <span class="accounts-badge">${e(providerLabelFor(lane, row.adapterType))}</span>
          <span class="accounts-status" data-state="${e(row.authState)}">${e(AUTH_STATE_LABEL[row.authState])}</span>
          ${row.sendCapable ? '<span class="accounts-badge accounts-badge--send">can send</span>' : ''}
        </span>
        ${row.sublabel ? `<span class="accounts-row-sub">${e(row.sublabel)}</span>` : ''}
      </button>
    </li>
  `;
};

const renderList = (lane: AccountLane, state: AccountsPanelState): string => {
  let body: string;
  if (state.loading) {
    body = '<p class="accounts-loading">Loading accounts…</p>';
  } else if (state.error !== null) {
    body = inlineError(state.error);
  } else if (state.rows.length === 0) {
    body = emptyHint({
      message: `No ${lane.label.toLowerCase()} accounts yet.`,
    });
  } else {
    body = `<ul class="accounts-rows">${state.rows.map((r) => renderRow(lane, r)).join('')}</ul>`;
  }
  const canAdd = lane.providers.length > 0;
  const addRow = canAdd
    ? `<div class="accounts-add-row">${button({
        label: '+ Add account',
        variant: 'primary',
        size: 'sm',
        action: 'accounts-open-add',
      })}</div>`
    : '';
  const pending = lane.pending ? inlineHint(lane.pending) : '';
  return `
    <p class="accounts-blurb">${e(lane.blurb)}</p>
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
  const synced =
    row.lastSyncedAt === undefined || row.lastSyncedAt === null
      ? 'never'
      : new Date(row.lastSyncedAt).toLocaleString();
  // resync / reauth exist on calendar + file lanes; mail has delete only.
  const lifecycle = lane.id !== 'mail';
  return `
    <div class="accounts-detail">
      <h3 class="accounts-detail-title">${e(row.slug)}</h3>
      <dl class="accounts-detail-grid">
        <dt>Provider</dt><dd>${e(providerLabelFor(lane, row.adapterType))}</dd>
        <dt>Status</dt><dd><span class="accounts-status" data-state="${e(row.authState)}">${e(AUTH_STATE_LABEL[row.authState])}</span></dd>
        ${row.sublabel ? `<dt>Account</dt><dd>${e(row.sublabel)}</dd>` : ''}
        <dt>Last synced</dt><dd>${e(synced)}</dd>
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
                disabled: busyKey('resync'),
              })
            : ''
        }
        ${
          lifecycle && row.authState !== 'healthy'
            ? button({
                label: busyKey('reauth') ? 'Re-authorizing…' : 'Re-authorize',
                size: 'sm',
                action: 'accounts-reauth',
                data: { slug: row.slug },
                disabled: busyKey('reauth'),
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

/** "Signing in…" waiting card. Shown for the WHOLE connect span — from the
 *  moment Connect is pressed (the consent popup is open) through the
 *  post-consent code exchange — so the wait never reads as a stuck form (the
 *  mount sets `oauthFinishing` at popup-open, not just post-consent). The
 *  "Back to accounts" escape is available immediately: the flow continues
 *  fire-and-forget (the account appears on success, an error surfaces on
 *  failure), so leaving never strands it. */
const renderOAuthFinishing = (provider: AccountProvider | undefined): string => {
  const who = provider ? `your ${provider.label} account` : 'your account';
  return `
    <div class="accounts-finishing" role="status" aria-live="polite">
      <div class="accounts-finishing-spinner" aria-hidden="true"></div>
      <h3 class="accounts-finishing-title">Signing in…</h3>
      <p class="accounts-finishing-desc">Connecting ${e(who)}. Complete the sign-in in the popup window.</p>
      <div class="accounts-form-actions">
        ${button({ label: 'Back to accounts', size: 'sm', action: 'accounts-oauth-dismiss' })}
      </div>
    </div>
  `;
};

/** Per-issuer, step-by-step "create your own OAuth app" guide, in a native
 *  `<details>` so it stays collapsed until the user needs it. Static text
 *  (no interpolation of untrusted input) — it references the exact redirect
 *  URI rendered above it rather than repeating the value. */
const oauthAppGuide = (issuer: OAuthAppIssuer): string => {
  const steps =
    issuer === 'google'
      ? [
          'Open the Google Cloud Console and create (or pick) a project.',
          'Under APIs &amp; Services → Library, enable the Gmail API (and the Google Calendar API if you will sync calendars).',
          'Configure the OAuth consent screen. If your account is Google Workspace, choose Internal — it needs no Google verification and issues long-lived refresh tokens. Otherwise choose External and add your own Google account under Test users (note: unverified External apps expire refresh tokens after 7 days, and gmail.readonly is a restricted scope that needs verification before going live).',
          'Go to Credentials → Create credentials → OAuth client ID → Web application.',
          'Under Authorized redirect URIs, add the exact URI shown above.',
          'Create it, then copy the Client ID and Client secret into the fields above.',
        ]
      : [
          'Open the Azure portal → Microsoft Entra ID → App registrations → New registration. Under "Supported account types" choose "Accounts in any organizational directory and personal Microsoft accounts" — Recued signs in via the /common endpoint, so a single-tenant or org-only app is rejected with "not enabled for consumers".',
          'Under "Redirect URI" pick the Web platform (NOT "Single-page application" — Web allows the ?recued_relay query in the URI and uses the client-secret flow Recued needs), paste the exact URI shown above, then Register.',
          'Open API permissions → Add a permission → Microsoft Graph → Delegated permissions, and add Mail.Read, offline_access, and User.Read (add Calendars.ReadWrite if you will sync calendars).',
          'Open Certificates &amp; secrets → New client secret, then copy its Value immediately (it is shown only once).',
          'From the Overview page copy the Application (client) ID, and paste it plus the secret Value into the fields above.',
        ];
  const provider = OAUTH_ISSUER_LABEL[issuer];
  return `
    <details class="accounts-oauth-guide">
      <summary>How to create a ${e(provider)} OAuth app</summary>
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
 *  `[Mail · Calendar · Files · Others]` tab bar lives in the webclient
 *  route (it spans this panel + the separate `connection.*` enroll
 *  panel), so this renderer draws lane content only. */
export const renderAccountsPanel = (props: AccountsPanelProps): string => {
  const { state } = props;
  const lane = findAccountLane(state.lane) ?? ACCOUNT_LANES[0]!;

  let stageHtml: string;
  if (state.oauthFinishing) {
    // Overlays the OAuth `form` for the whole connect span (popup-open through
    // the code-exchange) — see `renderOAuthFinishing`.
    const provider =
      state.providerId !== null ? findAccountProvider(lane, state.providerId) : undefined;
    stageHtml = renderOAuthFinishing(provider);
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
    </div>
  `;
};

// ════════════════════════════════════════════════════════════════
// Styles (scoped to [data-accounts-lane])
// ════════════════════════════════════════════════════════════════

export const ACCOUNTS_PANEL_STYLES = `
.accounts-panel { display: grid; gap: 14px; }
.accounts-blurb { margin: 0; color: var(--muted); font-size: 13px; }
.accounts-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.accounts-row { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.accounts-row-main {
  appearance: none; width: 100%; text-align: left; background: transparent;
  border: 0; padding: 12px 14px; font: inherit; color: var(--fg);
  cursor: pointer; display: grid; gap: 4px;
}
.accounts-row-main:hover { background: var(--surface-subtle); }
.accounts-row-name { font-weight: 650; font-size: 14px; }
.accounts-row-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.accounts-row-sub { color: var(--muted); font-size: 12px; }
.accounts-badge {
  font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px;
  background: var(--surface-sunk); color: var(--muted); border: 1px solid var(--border);
}
.accounts-badge--send { color: var(--accent); }
.accounts-status { font-size: 12px; font-weight: 600; color: var(--muted); }
.accounts-status[data-state='healthy'] { color: var(--ok, #2e7d32); }
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
.accounts-form-fields { display: grid; gap: 12px; }
.accounts-form-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.accounts-oauth-redirect {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px; word-break: break-all;
  padding: 1px 5px; border-radius: 4px;
  background: var(--surface-sunk); border: 1px solid var(--border);
}
.accounts-finishing { display: grid; gap: 12px; justify-items: center; text-align: center; padding: 28px 0; }
.accounts-finishing-spinner {
  width: 28px; height: 28px; border-radius: 50%;
  border: 3px solid var(--border); border-top-color: var(--accent);
  animation: accounts-spin 0.8s linear infinite;
}
@keyframes accounts-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .accounts-finishing-spinner { animation: none; } }
.accounts-finishing-title { margin: 0; font-size: 16px; font-weight: 650; }
.accounts-finishing-desc { margin: 0; color: var(--muted); font-size: 13px; }
.accounts-oauth-app {
  display: grid; gap: 10px; margin-top: 4px;
  padding: 12px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--surface-subtle, var(--surface));
}
.accounts-oauth-app-title { margin: 0; font-size: 13px; font-weight: 650; color: var(--fg); }
.accounts-oauth-app .accounts-form-fields { gap: 12px; }
.accounts-oauth-guide {
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--surface-subtle, var(--surface)); padding: 8px 12px;
}
.accounts-oauth-guide > summary {
  cursor: pointer; font-size: 13px; font-weight: 600; color: var(--fg);
}
.accounts-oauth-guide-steps {
  margin: 10px 0 2px; padding-left: 20px; display: grid; gap: 8px;
  color: var(--muted); font-size: 12px; line-height: 1.5;
}
.accounts-detail-title { margin: 0 0 10px; font-size: 16px; font-weight: 650; }
.accounts-detail-grid { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; font-size: 13px; }
.accounts-detail-grid dt { color: var(--muted); }
.accounts-detail-grid dd { margin: 0; }
.accounts-loading { color: var(--muted); font-size: 13px; }
`;
