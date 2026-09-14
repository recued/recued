/** D-127 wire-up — `collection.mail.*` enroll rpc handlers.
 *
 *  Three methods wire into `collection-handler.ts`:
 *    - enrollImap   → IMAP+SMTP basic-auth enrollment from
 *                     `imap-form.ts` payload. Persists IMAP password
 *                     (and SMTP password when supplied) under the
 *                     `imap.<slug>.<key>` key prefix on the shared
 *                     `OAuthAccountStore`; non-secret config lands in
 *                     `collection_instances.config_json`.
 *    - enrollOAuth  → gmail / graph: exchange the auth code for
 *                     refresh + access + granted_scopes; capture the
 *                     account email via the provider's profile
 *                     endpoint; write the instance row.
 *    - list         → enumerate every enrolled `data.mail.<slug>`
 *                     instance with `send_capable` + `account_email`
 *                     surfaced for the picker. Drives the
 *                     `data.mail.send_capable_instances` dynamic-
 *                     options source on the email connection
 *                     enrollment dialog (D-127 P4.3).
 *
 *  Mirrors the calendar `enroll.ts` shape:
 *    - The handlers do NOT spin up / tear down adapters on the
 *      `CollectionRegistry`. That's the composition root's concern
 *      (`mail/compose.ts`'s `onEnrolled` / `onDeleted` hooks). Enroll
 *      writes a row + persists credentials; the composition root
 *      reads the instance store and builds a `MailCollection` per row.
 *    - Probe / cap shape: mail rows carry the placeholder `URI_CAPS`
 *      shape today (matches what D-111's mail rows ride on); a richer
 *      `MailCollectionCaps` lands when the rest of mail's caps surface
 *      catches up with calendar's. The handler still performs a
 *      lightweight credential probe (OAuth: token exchange success;
 *      IMAP: provider acceptance via `createImapProvider` construction)
 *      so an obvious credential error surfaces at enroll time rather
 *      than at first sync.
 */

import {
  GMAIL_SEND_SCOPE,
  GRAPH_CALENDAR_SCOPE,
  GRAPH_MAIL_SEND_SCOPE,
  RpcError,
} from '@recued/contracts';
import type {
  CollectionAuthState,
  CollectionInstanceRow,
  FileCollectionCaps,
} from '@recued/contracts';
import type { CollectionInstanceStore } from '../instance-store.js';
import {
  defaultHttpFetcher,
  describeGraphGrantIdentity,
  grantedScopesInclude,
  exchangeCodeForTokens,
  fetchGraphGrantIdentity,
  graphGrantIdentitiesMatch,
  keyPrefix as oauthKeyPrefix,
  OAuthError,
  readGraphGrantIdentity,
  restoreGraphGrant,
  snapshotGraphGrant,
  writeGraphGrantIdentity,
  type GraphGrantSnapshot,
  type HttpFetcher,
  type OAuthAccountStore,
  type OAuthProvider,
  type OAuthProviderConfig,
} from './oauth.js';

/** Slug grammar — matches calendar/file enroll. Lowercase alphanumeric
 *  + `-` + `_`, 1–64 chars. The IMAP form's `IMAP_NAME_REGEX` is a
 *  narrower subset (no underscore); both shapes are accepted here so
 *  OAuth slugs that pre-existed under the looser convention keep
 *  working. */
const SLUG_RE = /^[a-z0-9][a-z0-9\-_]{0,63}$/;

/** Placeholder caps shape mail rows ride on until the per-platform
 *  `MailCollectionCaps` lands. Reuses `FileCollectionCaps` because
 *  D-111's autopromote stamped the same shape onto mail rows; values
 *  reflect the conservative read-only contract every mail provider
 *  honors today. The `auth` field is per-row in spirit (imap → keys,
 *  gmail/graph → oauth) but the wire shape is one literal — the
 *  recipe layer narrows on `adapter_type` before reading caps fields
 *  so the placeholder doesn't lie to anyone. */
const PLACEHOLDER_MAIL_CAPS: FileCollectionCaps = {
  read: 'yes',
  write: 'no',
  delete: 'no',
  watch: 'realtime',
  mirror: 'required',
  auth: 'oauth',
  path_style: 'uri',
};

/** Adapter-type discriminator for mail rows. `imap` covers IMAP+SMTP
 *  basic auth (caldav-style — vault-backed creds, no OAuth); `gmail`
 *  / `graph` are the two OAuth adapters. */
export type MailAdapterType = 'imap' | 'gmail' | 'graph';

const OAUTH_ADAPTERS: readonly MailAdapterType[] = ['gmail', 'graph'];

/** Storage key shape for IMAP credentials. Mirrors the OAuth
 *  `${provider}.${slug}.${field}` convention so a future "mail
 *  credentials" admin view can enumerate every secret with one prefix
 *  scan. */
const imapPasswordKey = (slug: string): string => `imap.${slug}.password`;
const imapSmtpPasswordKey = (slug: string): string => `imap.${slug}.smtp_password`;

export interface MailEnrollDeps {
  instances: CollectionInstanceStore;
  /** Account-namespace reader / writer. Used to persist OAuth tokens
   *  (gmail / graph) and IMAP passwords (imap). Composition root wraps
   *  the live `ServerAccountStore` here. */
  accountStore: OAuthAccountStore;
  /** OAuth client config per provider. Returning `null` for a
   *  provider surfaces `not_configured` on the rpc. Absent → every
   *  OAuth enroll surfaces `not_configured`. */
  oauthConfig?: (provider: 'gmail' | 'graph') => OAuthProviderConfig | null;
  /** Injected HTTP fetcher for OAuth exchange + post-OAuth profile
   *  fetches. Tests mock; production uses the default inside
   *  `oauth.ts`. */
  fetcher?: HttpFetcher;
  /** Called after a successful enroll so the composition root can
   *  spin up a live `MailCollection` against the new row. Optional so
   *  unit tests don't need live wiring. */
  onEnrolled?: (row: CollectionInstanceRow) => Promise<void> | void;
  /** Called before a row is deleted so the composition root can stop
   *  the adapter cleanly. Optional. */
  onDeleted?: (slug: string) => Promise<void> | void;
  /** D-264 — draft capability of the LIVE provider for `slug`, or `undefined`
   *  when no collection is running for it.
   *
   *  ⚠ A seam rather than a second scope computation here, deliberately. The
   *  `send_capable` path derives the same fact twice — once in the provider,
   *  once at this layer — and `computeSendCapable` below warns in its own
   *  words that the two "could disagree about the same account". Repeating
   *  that shape for a second axis would double a known hazard, so the
   *  provider stays the only place that decides, and this rpc reports what it
   *  says. Unwired or not-running ⇒ `false`: a mailbox we cannot ask is a
   *  mailbox we do not advertise. */
  draftCapable?: (slug: string) => boolean | undefined;
  now?: () => number;
}

// ────────────────────────────────────────────────────────────────
// Input validators
// ────────────────────────────────────────────────────────────────

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('bad_request', `${field} must be a non-empty string`, 400);
  }
  return value;
};

const requireSlug = (value: unknown): string => {
  const slug = requireString(value, 'slug');
  if (!SLUG_RE.test(slug)) {
    throw new RpcError(
      'bad_request',
      `slug must match ${SLUG_RE.source} — lowercase letters, digits, - and _`,
      400,
    );
  }
  return slug;
};

const requireOAuthAdapter = (value: unknown): 'gmail' | 'graph' => {
  if (value !== 'gmail' && value !== 'graph') {
    throw new RpcError('bad_request', 'adapter must be "gmail" or "graph"', 400);
  }
  return value;
};

const requireBoundedInt = (
  value: unknown,
  field: string,
  min: number,
  max: number,
): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RpcError('bad_request', `${field} must be an integer in [${min}, ${max}]`, 400);
  }
  return value;
};

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new RpcError('bad_request', `${field} must be a boolean`, 400);
  }
  return value;
};

const requireFolderArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    throw new RpcError('bad_request', 'folders must be an array of strings', 400);
  }
  if (value.length === 0) {
    throw new RpcError('bad_request', 'folders must contain at least one entry', 400);
  }
  const out: string[] = [];
  for (const f of value) {
    if (typeof f !== 'string' || f.length === 0) {
      throw new RpcError('bad_request', 'folders entries must be non-empty strings', 400);
    }
    out.push(f);
  }
  return out;
};

const toRow = (
  adapter_type: MailAdapterType,
  auth_state: CollectionAuthState,
  slug: string,
  last_synced_at: number | null,
): CollectionInstanceRow => ({
  slug,
  platform: 'mail',
  adapter_type,
  caps: PLACEHOLDER_MAIL_CAPS,
  auth_state,
  last_synced_at,
});

// ────────────────────────────────────────────────────────────────
// enrollImap (D-127 P4.1 form payload)
// ────────────────────────────────────────────────────────────────

/** Server-side IMAP enrollment payload accepted via the WS rpc
 *  `collection.mail.imap.enroll`. Field shape matches the form the
 *  webclient surface fills out and forwards verbatim. */
export interface EnrollImapInput {
  name?: unknown;
  host?: unknown;
  port?: unknown;
  secure?: unknown;
  username?: unknown;
  password?: unknown;
  folders?: unknown;
  smtp?: unknown;
  /** Optional config knobs that mirror the gmail / graph enroll shape.
   *  Surface for parity — IMAP rows treat them as opaque pass-through
   *  values stored on `config_json`. */
  backfill_days?: unknown;
  retention_days?: unknown;
  quota_bytes?: unknown;
}

interface ParsedSmtpBlock {
  host: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  from?: string;
}

const parseSmtpBlock = (raw: unknown): ParsedSmtpBlock | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcError('bad_request', 'smtp must be an object when supplied', 400);
  }
  const o = raw as Record<string, unknown>;
  const host = requireString(o.host, 'smtp.host');
  const out: ParsedSmtpBlock = { host };
  if (o.port !== undefined) {
    out.port = requireBoundedInt(o.port, 'smtp.port', 1, 65535);
  }
  if (o.secure !== undefined) out.secure = requireBoolean(o.secure, 'smtp.secure');
  if (o.username !== undefined) {
    out.username = requireString(o.username, 'smtp.username');
  }
  if (o.password !== undefined) {
    out.password = requireString(o.password, 'smtp.password');
  }
  if (o.from !== undefined) out.from = requireString(o.from, 'smtp.from');
  return out;
};

const optionalPositiveInt = (
  value: unknown,
  field: string,
): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RpcError('bad_request', `${field} must be a non-negative integer`, 400);
  }
  return value;
};

export const handleMailEnrollImap = async (
  deps: MailEnrollDeps,
  args: EnrollImapInput,
): Promise<{ slug: string; send_capable: boolean }> => {
  const slug = requireSlug(args.name);
  const host = requireString(args.host, 'host');
  const port = requireBoundedInt(args.port, 'port', 1, 65535);
  const secure = requireBoolean(args.secure, 'secure');
  const username = requireString(args.username, 'username');
  const password = requireString(args.password, 'password');
  const folders = requireFolderArray(args.folders);
  const smtp = parseSmtpBlock(args.smtp);

  if (deps.instances.get('mail', slug)) {
    throw new RpcError(
      'conflict',
      `collection.mail.enrollImap: instance '${slug}' already exists — delete it via the Connections UI to re-enroll`,
      409,
    );
  }

  // Stash the IMAP password (and the optional SMTP password) in the
  // pair-local account store. Config_json carries the non-secret
  // fields only — a config dump never reveals credentials. Compose
  // root reads these back at startLive time to materialise a complete
  // `ImapProviderConfig`.
  await deps.accountStore.set(imapPasswordKey(slug), password);
  if (smtp?.password !== undefined) {
    await deps.accountStore.set(imapSmtpPasswordKey(slug), smtp.password);
  } else {
    // Defensive — clear any prior SMTP password under the same slug
    // (re-enrollment after delete shouldn't carry creds forward).
    await deps.accountStore.delete(imapSmtpPasswordKey(slug));
  }

  const config: Record<string, unknown> = {
    host,
    port,
    secure,
    username,
    folders,
  };
  // Only emit the SMTP block on config when send was enabled. The
  // password field is intentionally stripped — it lives in the account
  // store; the provider reads it back via the compose root.
  if (smtp) {
    const smtpConfig: Record<string, unknown> = { host: smtp.host };
    if (smtp.port !== undefined) smtpConfig.port = smtp.port;
    if (smtp.secure !== undefined) smtpConfig.secure = smtp.secure;
    if (smtp.username !== undefined) smtpConfig.username = smtp.username;
    if (smtp.from !== undefined) smtpConfig.from = smtp.from;
    config.smtp = smtpConfig;
  }
  const backfill = optionalPositiveInt(args.backfill_days, 'backfill_days');
  if (backfill !== undefined) config.backfill_days = backfill;
  const retention = optionalPositiveInt(args.retention_days, 'retention_days');
  if (retention !== undefined) config.retention_days = retention;
  const quota = optionalPositiveInt(args.quota_bytes, 'quota_bytes');
  if (quota !== undefined) config.quota_bytes = quota;

  const stored = deps.instances.upsert({
    platform: 'mail',
    slug,
    adapter_type: 'imap',
    config,
    caps: PLACEHOLDER_MAIL_CAPS,
    auth_state: 'healthy',
    last_synced_at: null,
  });

  const row = toRow(
    'imap',
    stored.auth_state,
    stored.slug,
    stored.last_synced_at,
  );

  try {
    await deps.onEnrolled?.(row);
  } catch (err) {
    // Compose root failed to start the live provider. The row is
    // committed; user can hit "Resync" later. Surface the failure so
    // the UI knows the credentials were accepted but the live mirror
    // didn't come up.
    throw new RpcError(
      'adapter_start_failed',
      (err as Error).message ?? 'imap adapter failed to start',
      500,
    );
  }

  return { slug, send_capable: smtp !== undefined };
};

// ────────────────────────────────────────────────────────────────
// enrollOAuth (gmail / graph) — relocated from collection-handler.ts
// so it sits alongside enrollImap + the rest of the mail enroll
// family. The handler also captures `account_email` via a one-off
// profile fetch so the rpc-layer self-loop guard has a sender
// address from the very first send onward.
// ────────────────────────────────────────────────────────────────

export interface EnrollOAuthInput {
  adapter?: unknown;
  account_slug?: unknown;
  code?: unknown;
  redirect_uri?: unknown;
  /** Optional config knobs surfaced for parity with the IMAP path. */
  backfill_days?: unknown;
  retention_days?: unknown;
  quota_bytes?: unknown;
  poll_seconds?: unknown;
  label_filter?: unknown;
  folder_filter?: unknown;
}

const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me';

/** Best-effort post-OAuth profile fetch — pulls the account email so
 *  the self-loop guard has a sender address from the first send.
 *  Failures are non-fatal: the row still commits with empty
 *  `account_email`; the rpc layer skips the guard rather than
 *  rejecting every send. */
const fetchAccountEmail = async (
  provider: 'gmail' | 'graph',
  accessToken: string,
  fetcher: HttpFetcher,
): Promise<string> => {
  try {
    const url = provider === 'gmail' ? GMAIL_PROFILE_URL : GRAPH_ME_URL;
    const res = await fetcher(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return '';
    const raw = (await res.json()) as Record<string, unknown>;
    const candidate = provider === 'gmail'
      ? raw.emailAddress
      : (raw.userPrincipalName ?? raw.mail);
    return typeof candidate === 'string' ? candidate : '';
  } catch {
    return '';
  }
};

export const handleMailEnrollOAuth = async (
  deps: MailEnrollDeps,
  args: EnrollOAuthInput,
): Promise<{ slug: string; send_capable: boolean; account_email: string }> => {
  const adapter = requireOAuthAdapter(args.adapter);
  const slug = requireSlug(args.account_slug);
  const code = requireString(args.code, 'code');
  const redirectUri = requireString(args.redirect_uri, 'redirect_uri');

  if (deps.instances.get('mail', slug)) {
    throw new RpcError(
      'conflict',
      `collection.mail.enrollOAuth: instance '${slug}' already exists — delete it via the Connections UI to re-enroll`,
      409,
    );
  }
  if (!deps.oauthConfig) {
    throw new RpcError(
      'not_configured',
      `collection.mail.enrollOAuth: server has no OAuth client configured — add your Google or Microsoft OAuth app under Connections → Mail`,
      503,
    );
  }
  const providerConfig = deps.oauthConfig(adapter);
  if (!providerConfig || !providerConfig.clientId) {
    throw new RpcError(
      'not_configured',
      `collection.mail.enrollOAuth: no ${adapter} OAuth client id configured`,
      503,
    );
  }

  // One normalized fetcher for every identity/profile read in this flow. Keep
  // it available before the token exchange: a legacy shared grant may need its
  // current account identity recovered before we decide whether replacing it is
  // safe, and that check must not consume the single-use OAuth code first.
  const httpFetcher: HttpFetcher = deps.fetcher ?? defaultHttpFetcher;

  // ── Shared-grant protection (Microsoft only) ──────────────────
  //
  // A `graph` calendar row at this slug reads the SAME
  // `account.graph.<slug>.*` grant this enroll is about to overwrite. Two things
  // can strand it: a DIFFERENT Microsoft account (the slug is a name, not an
  // identity) or the SAME account re-consenting WITHOUT the calendar scope.
  //
  // Neither is knowable until after the exchange — the identity comes from `/me`
  // and the scopes come from the token response — and the exchange has already
  // clobbered the old credential by then. So snapshot first and put it back if
  // the new grant turns out not to cover the calendar. Refusing without the
  // restore would be strictly worse than the bug: it would leave BOTH lanes
  // broken.
  const sharesGrantWithCalendar =
    adapter === 'graph'
    && deps.instances.get('calendar', slug)?.adapter_type === 'graph';
  const snapshot: GraphGrantSnapshot | null = sharesGrantWithCalendar
    ? await snapshotGraphGrant(deps.accountStore, slug)
    : null;
  let priorIdentity = sharesGrantWithCalendar
    ? await readGraphGrantIdentity(deps.accountStore, slug)
    : null;

  // Grants created before account-identity stamping can still be recovered
  // safely from their CURRENT authenticated access token. If that token is no
  // longer readable, we cannot prove a replacement OAuth code belongs to the
  // same Microsoft account. Refuse before exchanging (and therefore before
  // mutating the shared credential) instead of silently re-pointing Calendar.
  if (
    sharesGrantWithCalendar
    && priorIdentity === null
    && snapshot?.access_token
  ) {
    priorIdentity = await fetchGraphGrantIdentity(snapshot.access_token, httpFetcher);
  }
  if (sharesGrantWithCalendar && priorIdentity === null) {
    throw new RpcError(
      'conflict',
      `collection.mail.enrollOAuth: calendar '${slug}' shares this Microsoft sign-in, `
      + 'but the current account identity could not be verified. Retry after the '
      + 'existing sign-in is reachable, or delete that calendar and reconnect both '
      + 'accounts. The shared credential was not changed.',
      409,
    );
  }

  let exchange: { access_token: string; granted_scopes: string[] };
  try {
    exchange = await exchangeCodeForTokens({
      provider: adapter as OAuthProvider,
      slug,
      code,
      redirectUri,
      providerConfig,
      accountStore: deps.accountStore,
      ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch (err) {
    if (err instanceof OAuthError) {
      throw new RpcError(
        err.code === 'missing_refresh_token' ? 'bad_request' : 'upstream_error',
        err.message,
        err.status || 502,
      );
    }
    throw err;
  }

  // ── Verify the new grant still serves the calendar lane ────────
  if (adapter === 'graph') {
    const identity = await fetchGraphGrantIdentity(exchange.access_token, httpFetcher);

    const refuse = async (reason: string): Promise<never> => {
      const restored = snapshot === null
        ? true
        : await restoreGraphGrant(deps.accountStore, slug, snapshot);
      throw new RpcError(
        'conflict',
        `collection.mail.enrollOAuth: ${reason}`
        + (restored
          ? ' The previous sign-in was left in place, so the calendar keeps working.'
          : ' ⚠ The previous sign-in could NOT be fully restored — re-authorize both'
            + ' the mail and calendar accounts.'),
        409,
      );
    };

    if (sharesGrantWithCalendar) {
      // The exchange already replaced the shared credential, so an unreadable
      // NEW identity must restore the snapshot and refuse. Treating absence as
      // "no mismatch" is a fail-open: it lets a transient `/me` failure silently
      // re-point the live calendar to an unproven Microsoft account.
      if (identity === null) {
        return refuse(
          `Microsoft could not confirm the identity of the new sign-in while `
          + `calendar '${slug}' shares it. Retry, or delete that calendar first.`,
        );
      }
      // The pre-exchange recovery/refusal above makes this impossible, but keep
      // the dispatch boundary independently fail-closed if the flow is refactored.
      if (priorIdentity === null) {
        return refuse(
          `the current Microsoft account identity for calendar '${slug}' is unknown. `
          + 'Reconnect both accounts before replacing their shared sign-in.',
        );
      }
      // A DIFFERENT account would re-point the calendar at someone else's data.
      if (!graphGrantIdentitiesMatch(priorIdentity, identity)) {
        await refuse(
          `this sign-in is a different Microsoft account than the one calendar `
          + `'${slug}' uses (${describeGraphGrantIdentity(priorIdentity)} → `
          + `${describeGraphGrantIdentity(identity)}). Enroll it under another name, `
          + 'or delete that calendar first.',
        );
      }
      // The SAME account re-consenting WITHOUT the calendar scope silently
      // demotes the calendar to a dead row. Checked against what Microsoft
      // actually GRANTED, not what we asked for.
      if (!grantedScopesInclude(exchange.granted_scopes, GRAPH_CALENDAR_SCOPE)) {
        await refuse(
          `calendar '${slug}' shares this sign-in, but the new consent does not `
          + `include ${GRAPH_CALENDAR_SCOPE}. Re-run it with "Also connect Calendar" `
          + 'ticked, or delete that calendar first.',
        );
      }
    }

    // Record whose grant this is, so a later lane can check. Written for EVERY
    // graph enroll — the value of the check depends on the data existing before
    // the sharing starts.
    if (identity !== null) {
      await writeGraphGrantIdentity(deps.accountStore, slug, identity);
    }
  }

  // Best-effort profile fetch for the canonical account email.
  const accountEmail = await fetchAccountEmail(
    adapter,
    exchange.access_token,
    httpFetcher,
  );

  const config: Record<string, unknown> = {
    account_slug: slug,
    account_email: accountEmail,
  };
  const backfill = optionalPositiveInt(args.backfill_days, 'backfill_days');
  if (backfill !== undefined) config.backfill_days = backfill;
  const retention = optionalPositiveInt(args.retention_days, 'retention_days');
  if (retention !== undefined) config.retention_days = retention;
  const quota = optionalPositiveInt(args.quota_bytes, 'quota_bytes');
  if (quota !== undefined) config.quota_bytes = quota;
  const poll = optionalPositiveInt(args.poll_seconds, 'poll_seconds');
  if (poll !== undefined) config.poll_seconds = poll;
  if (Array.isArray(args.label_filter)) {
    config.label_filter = args.label_filter.filter((x) => typeof x === 'string');
  }
  if (Array.isArray(args.folder_filter)) {
    config.folder_filter = args.folder_filter.filter((x) => typeof x === 'string');
  }

  const stored = deps.instances.upsert({
    platform: 'mail',
    slug,
    adapter_type: adapter,
    config,
    caps: PLACEHOLDER_MAIL_CAPS,
    auth_state: 'healthy',
    last_synced_at: null,
  });

  const row = toRow(
    adapter,
    stored.auth_state,
    stored.slug,
    stored.last_synced_at,
  );

  try {
    await deps.onEnrolled?.(row);
  } catch (err) {
    throw new RpcError(
      'adapter_start_failed',
      (err as Error).message ?? `${adapter} adapter failed to start`,
      500,
    );
  }

  // Send capability lockstep — derived from the provider-specific
  // send-scope check via the granted scope list. P4.2 wired the same
  // computation in the provider config callback; this rpc-layer check
  // is the source of truth for the UI surfacing send_capable on the
  // listing.
  // Tolerant match, and against the CONSTANTS rather than inline literals — the
  // hand-typed strings here could drift from the ones the providers compare, so
  // the rpc's `send_capable` and the provider's `sendCapable` could disagree
  // about the same account.
  const sendCapable = grantedScopesInclude(
    exchange.granted_scopes,
    adapter === 'gmail' ? GMAIL_SEND_SCOPE : GRAPH_MAIL_SEND_SCOPE,
  );

  return {
    slug,
    send_capable: sendCapable,
    account_email: accountEmail,
  };
};

// ────────────────────────────────────────────────────────────────
// list — picker source for `data.mail.send_capable_instances`
// ────────────────────────────────────────────────────────────────

/** Per-row view returned by `collection.mail.list`. Wider than the
 *  generic `CollectionInstanceRow` because the picker / dynamicOptions
 *  resolver needs `send_capable` + `account_email` surfaced
 *  side-by-side without a second rpc round trip. */
export interface MailInstanceRow extends CollectionInstanceRow {
  /** True iff the underlying provider is configured to send. For OAuth
   *  rows: granted scopes contain the provider-specific send scope.
   *  For IMAP rows: enrollment supplied an SMTP block. */
  send_capable: boolean;
  /** Canonical address of the mail account. Populated on enroll
   *  (gmail: `users.getProfile.emailAddress`; graph:
   *  `me.userPrincipalName`; imap: SMTP `from` falling back to IMAP
   *  username). Empty string when not yet known — the picker still
   *  surfaces the row but the connection-form's display label will
   *  show the slug only. */
  account_email: string;
  /** D-264 — true iff the live provider can park a NEW message in the
   *  mailbox's Drafts folder. **Independent of `send_capable` in both
   *  directions**: IMAP-without-SMTP can APPEND, and a Gmail grant of
   *  `gmail.send` without `gmail.modify` can send and cannot draft. Reported
   *  `false` for any instance with no running collection. */
  draft_capable: boolean;
}

const computeSendCapable = async (
  deps: MailEnrollDeps,
  adapter: MailAdapterType,
  slug: string,
  config: Record<string, unknown>,
): Promise<boolean> => {
  if (adapter === 'imap') {
    return Boolean(config.smtp);
  }
  if (adapter === 'gmail' || adapter === 'graph') {
    const sendScope = adapter === 'gmail'
      ? 'https://www.googleapis.com/auth/gmail.send'
      : 'Mail.Send';
    const raw = await deps.accountStore.get(
      `${oauthKeyPrefix(adapter as OAuthProvider, slug)}.granted_scopes`,
    );
    if (!raw) return false;
    return raw.split(/[\s,]+/).filter((s) => s.length > 0).includes(sendScope);
  }
  return false;
};

const accountEmailFromConfig = (config: Record<string, unknown>): string => {
  const v = config.account_email;
  if (typeof v === 'string') return v;
  // IMAP fallback ladder: smtp.from → username.
  const smtp = config.smtp as Record<string, unknown> | undefined;
  if (smtp && typeof smtp === 'object') {
    const from = smtp.from;
    if (typeof from === 'string' && from.length > 0) return from;
  }
  const username = config.username;
  if (typeof username === 'string') return username;
  return '';
};

export const handleMailList = async (
  deps: MailEnrollDeps,
): Promise<{ instances: MailInstanceRow[] }> => {
  const rows = deps.instances.list('mail');
  const out: MailInstanceRow[] = [];
  for (const r of rows) {
    const adapter = r.adapter_type as MailAdapterType;
    const send_capable = await computeSendCapable(deps, adapter, r.slug, r.config);
    out.push({
      slug: r.slug,
      platform: 'mail',
      adapter_type: r.adapter_type,
      caps: r.caps,
      auth_state: r.auth_state,
      last_synced_at: r.last_synced_at,
      send_capable,
      draft_capable: deps.draftCapable?.(r.slug) ?? false,
      account_email: accountEmailFromConfig(r.config),
    });
  }
  return { instances: out };
};

// ────────────────────────────────────────────────────────────────
// delete — dropper used by the Connections UI to retire a row
// ────────────────────────────────────────────────────────────────

export const handleMailDelete = async (
  deps: MailEnrollDeps,
  args: { slug?: unknown },
): Promise<{ ok: true }> => {
  const slug = requireSlug(args.slug);
  const existing = deps.instances.get('mail', slug);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.mail.delete: instance '${slug}' not found`,
      404,
    );
  }
  await deps.onDeleted?.(slug);
  // Also wipe credentials so a future enroll under the same slug
  // doesn't inherit stale secrets.
  if (existing.adapter_type === 'imap') {
    const prefix = `imap.${slug}.`;
    if (deps.accountStore.getAll) {
      const all = await deps.accountStore.getAll();
      for (const key of Object.keys(all)) {
        if (key.startsWith(prefix)) await deps.accountStore.delete(key);
      }
    } else {
      await deps.accountStore.delete(imapPasswordKey(slug));
      await deps.accountStore.delete(imapSmtpPasswordKey(slug));
    }
  } else if (existing.adapter_type === 'gmail' || existing.adapter_type === 'graph') {
    // ⚠ A `graph` grant is SHARED with the calendar lane at the same slug —
    // Microsoft's mail and calendar adapters are both named `graph`, so both
    // read `account.graph.<slug>.*` (`collections/calendar/enroll.ts` § 2, and
    // the `attachGraphGrant` path that deliberately relies on it). Purging the
    // credential here while a calendar row still references it left that
    // calendar visible-but-dead the moment its cached access token expired:
    // deleting a MAILBOX silently broke a CALENDAR. So the credential is only
    // reclaimed when nothing else is using it.
    //
    // `gmail` needs no such check — its calendar sibling is `gcal`, a different
    // prefix, so nothing is shared to strand.
    const sharedWithCalendar =
      existing.adapter_type === 'graph'
      && deps.instances.get('calendar', slug)?.adapter_type === 'graph';
    if (!sharedWithCalendar) {
      const prefix = oauthKeyPrefix(existing.adapter_type as OAuthProvider, slug);
      await deps.accountStore.delete(`${prefix}.access_token`);
      await deps.accountStore.delete(`${prefix}.refresh_token`);
      await deps.accountStore.delete(`${prefix}.expires_at`);
      await deps.accountStore.delete(`${prefix}.granted_scopes`);
    }
  }
  deps.instances.delete('mail', slug);
  return { ok: true };
};

// ────────────────────────────────────────────────────────────────
// helpers exported for the compose root
// ────────────────────────────────────────────────────────────────

/** Read-side of `imapPasswordKey` so the compose root can hydrate the
 *  full `ImapProviderConfig` at startLive time. Returns `null` when
 *  the row exists but the password isn't in the store (broken state —
 *  composer logs + skips). */
export const readImapPassword = async (
  accountStore: OAuthAccountStore,
  slug: string,
): Promise<string | null> => accountStore.get(imapPasswordKey(slug));

/** Same for the SMTP password — null when the SMTP block was
 *  configured without a separate password (provider falls back to
 *  the IMAP password). */
export const readImapSmtpPassword = async (
  accountStore: OAuthAccountStore,
  slug: string,
): Promise<string | null> => accountStore.get(imapSmtpPasswordKey(slug));
