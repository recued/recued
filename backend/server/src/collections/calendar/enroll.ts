/** D-117 Phase 7 — collection.calendar.* enroll rpc handlers.
 *
 *  Seven methods wire into `collection-handler.ts`:
 *    - enrollOAuth    → gcal / graph: exchange code for tokens, probe
 *                       caps, write instance row.
 *    - enrollBasic    → caldav: dry-run PROPFIND against the server,
 *                       probe caps, write instance row (password stored
 *                       server-side under `caldav.<slug>.password`, the
 *                       same account-store model IMAP uses).
 *    - list           → enumerate calendar instances.
 *    - update         → patch config (backfill / retention / poll)
 *                       with optional re-probe.
 *    - delete         → drop the row (adapter lifecycle owned by
 *                       composition root — Phase 9 wires stop-on-
 *                       delete).
 *    - resync         → re-probe caps + flip `auth_state` based on
 *                       the outcome.
 *    - reauth         → kicks an OAuth re-consent flow; caldav rows
 *                       respond with `not_implemented` — reauth for
 *                       basic auth is "re-enroll with a fresh
 *                       password" from the UI.
 *
 *  Two crucial differences from `file/enroll.ts`:
 *
 *  1. **Three adapter kinds across two credential styles.** `gcal` +
 *     `graph` use OAuth (enrollOAuth); `caldav` uses basic /
 *     app-password (enrollBasic). Two distinct rpc methods so the
 *     extension UI doesn't need to disambiguate via optional fields.
 *  2. **Token storage lives under `account.{adapter}.{slug}.*`** —
 *     mail's `gmail.{slug}.*` and calendar's `gcal.{slug}.*` /
 *     `graph.{slug}.*` share the Microsoft Graph grant when both
 *     platforms target the same account, by design (scopes differ at
 *     consent time only). The enroll handler writes the tokens
 *     through the same `OAuthAccountStore` abstraction mail uses.
 *
 *  The handler deliberately does NOT spin up / tear down adapters on
 *  the calendar registry — that's bin.ts's concern (Phase 9). Enroll
 *  writes a row + optional credentials; the composition root reads
 *  the instance store at boot / after enroll and builds a
 *  `CalendarCollection` per row.
 */

import { RpcError } from '@recued/contracts';
import type {
  CalendarCollectionCaps,
  CollectionAuthState,
  CollectionInstanceRow,
} from '@recued/contracts';
import type { CollectionInstanceStore } from '../instance-store.js';
import type { CalendarAdapterRegistry } from './adapter-registry.js';
import { probeCalendarAdapter } from './adapter-registry.js';
import {
  exchangeCodeForTokens,
  keyPrefix as oauthKeyPrefix,
  OAuthError,
  type HttpFetcher,
  type OAuthAccountStore,
  type OAuthProvider,
  type OAuthProviderConfig,
} from '../mail/oauth.js';
import type { CalendarProviderKind } from './provider.js';

/** Slug grammar — matches file-adapter's `SLUG_RE`. */
const SLUG_RE = /^[a-z0-9][a-z0-9\-_]{0,63}$/;

/** Account-store key for a caldav instance's password. Mirrors mail's
 *  `imap.<slug>.password` model — the secret is stored server-side and
 *  the config row stays credential-free. The composition root scopes
 *  the adapter's `getAccountValue` to `caldav.<slug>.<key>`, so the
 *  adapter reads it back through `getAccountValue('password')`. */
const caldavPasswordKey = (slug: string): string => `caldav.${slug}.password`;

/** Purge every shared-account-store key under `prefix`. Returns `true` when it
 *  enumerated (the store exposed `getAll` — the production ServerAccountStore),
 *  `false` for a narrow store double, so the caller can fall back to deleting
 *  the known exact key. The caller passes a dot-terminated prefix
 *  (`caldav.<slug>.`) so `work` never matches `work2`'s keys. */
const purgeAccountStorePrefix = async (
  store: OAuthAccountStore,
  prefix: string,
): Promise<boolean> => {
  if (typeof store.getAll !== 'function') return false;
  const all = await store.getAll();
  for (const key of Object.keys(all)) {
    if (key.startsWith(prefix)) await store.delete(key);
  }
  return true;
};

/** Supported adapter kinds in the OAuth path. */
const OAUTH_ADAPTERS: readonly CalendarProviderKind[] = ['gcal', 'graph'];

/** Complete first-wave adapter set. */
const ADAPTER_KINDS: readonly CalendarProviderKind[] = ['gcal', 'graph', 'caldav'];

export interface CalendarEnrollDeps {
  instances: CollectionInstanceStore;
  adapters: CalendarAdapterRegistry;
  /** Account-namespace reader / writer. Used to look up vault-scoped
   *  caldav credentials + to persist OAuth tokens. Composition root
   *  wraps the live `ServerAccountStore` here. */
  accountStore: OAuthAccountStore;
  /** OAuth client config per provider. `gcal` uses the same shape as
   *  gmail; `graph` is shared across mail + calendar. Returning `null`
   *  for a provider surfaces `not_configured` on the rpc. */
  oauthConfig?: (adapter: 'gcal' | 'graph') => OAuthProviderConfig | null;
  /** Injected HTTP fetcher for OAuth exchange. Tests mock; production
   *  uses the default inside `oauth.ts`. */
  fetcher?: HttpFetcher;
  /** Called after a successful enroll so the composition root can
   *  spin up a live `CalendarCollection` against the new row.
   *  Optional so unit tests don't need live wiring. */
  onEnrolled?: (row: CollectionInstanceRow) => Promise<void> | void;
  /** Called before a row is deleted so the composition root can stop
   *  the adapter cleanly. Optional. */
  onDeleted?: (slug: string) => Promise<void> | void;
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

/** D-173 P4.3 — slugs reserved for built-in calendars. `'local'` is the
 *  auto-created credential-free local calendar (`wire-calendar-stack.ts`).
 *  External enroll (OAuth / basic) must refuse these so a gcal / caldav
 *  instance can never claim the local slug — the warehouse table is keyed
 *  on the slug alone (`calendar-table.ts`), so a collision would let an
 *  external calendar reuse the local calendar's events. */
const RESERVED_CALENDAR_SLUGS: ReadonlySet<string> = new Set(['local']);

const refuseReservedSlug = (method: string, slug: string): void => {
  if (RESERVED_CALENDAR_SLUGS.has(slug)) {
    throw new RpcError(
      'conflict',
      `${method}: slug '${slug}' is reserved for the built-in local calendar — choose another`,
      409,
    );
  }
};

const requireAdapterKind = (
  value: unknown,
  allowed: readonly CalendarProviderKind[] = ADAPTER_KINDS,
): CalendarProviderKind => {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new RpcError(
      'bad_request',
      `adapter must be one of: ${allowed.join(', ')}`,
      400,
    );
  }
  return value as CalendarProviderKind;
};

const optionalPositiveNumber = (
  value: unknown,
  field: string,
): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RpcError('bad_request', `${field} must be a non-negative number`, 400);
  }
  return value;
};

const classifyProbeError = (err: unknown): RpcError => {
  const msg = err instanceof Error ? err.message : String(err);
  if (/required|must be|invalid/i.test(msg)) {
    return new RpcError('bad_request', msg, 400);
  }
  return new RpcError('probe_failed', msg, 422);
};

const toRow = (
  adapter_type: CalendarProviderKind,
  caps: CalendarCollectionCaps,
  auth_state: CollectionAuthState,
  slug: string,
  last_synced_at: number | null,
): CollectionInstanceRow => ({
  slug,
  platform: 'calendar',
  adapter_type,
  caps,
  auth_state,
  last_synced_at,
});

// ────────────────────────────────────────────────────────────────
// enrollOAuth
// ────────────────────────────────────────────────────────────────

export interface EnrollOAuthInput {
  slug?: unknown;
  adapter?: unknown;
  oauth_code?: unknown;
  oauth_redirect_uri?: unknown;
  backfill_days?: unknown;
  expansion_future_days?: unknown;
  expansion_past_days?: unknown;
  retention_days?: unknown;
  quota_bytes?: unknown;
  poll_seconds?: unknown;
  calendar_filter?: unknown;
}

export const handleCalendarEnrollOAuth = async (
  deps: CalendarEnrollDeps,
  args: EnrollOAuthInput,
): Promise<{ slug: string; caps: CalendarCollectionCaps }> => {
  const slug = requireSlug(args.slug);
  refuseReservedSlug('collection.calendar.enrollOAuth', slug);
  const adapter = requireAdapterKind(args.adapter, OAUTH_ADAPTERS) as 'gcal' | 'graph';
  const code = requireString(args.oauth_code, 'oauth_code');
  const redirectUri = requireString(args.oauth_redirect_uri, 'oauth_redirect_uri');

  if (deps.instances.get('calendar', slug)) {
    throw new RpcError(
      'conflict',
      `collection.calendar.enrollOAuth: instance '${slug}' already exists — use collection.calendar.update`,
      409,
    );
  }
  if (!deps.oauthConfig) {
    throw new RpcError(
      'not_configured',
      `collection.calendar.enrollOAuth: server has no OAuth client configured — set RECUED_GCAL_CLIENT_ID / RECUED_GRAPH_CLIENT_ID`,
      503,
    );
  }
  const providerConfig = deps.oauthConfig(adapter);
  if (!providerConfig || !providerConfig.clientId) {
    throw new RpcError(
      'not_configured',
      `collection.calendar.enrollOAuth: no ${adapter} OAuth client id configured`,
      503,
    );
  }

  // Exchange the code for refresh + access tokens. Writes under
  // `account.<adapter>.<slug>.*`. `gcal` uses `gcal` prefix (distinct
  // from `gmail` which uses `gmail`). `graph` shares the prefix with
  // mail — deliberate per D-117 adapter-name decision.
  try {
    await exchangeCodeForTokens({
      provider: adapter as OAuthProvider,
      slug,
      code,
      redirectUri,
      providerConfig,
      accountStore: deps.accountStore,
      fetcher: deps.fetcher,
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

  const factory = deps.adapters.get(adapter);
  if (!factory) {
    throw new RpcError(
      'bad_request',
      `unknown calendar adapter '${adapter}'`,
      400,
    );
  }

  // Probe caps — the factory's context delegates `getAccountValue` to
  // the same account store so the just-persisted tokens are live.
  const config: Record<string, unknown> = buildOAuthConfig(slug, args);
  let caps: CalendarCollectionCaps;
  try {
    caps = await probeCalendarAdapter(factory, {
      slug,
      config,
      getAccountValue: async (key) => deps.accountStore.get(`${oauthKeyPrefix(adapter as OAuthProvider, slug)}.${key}`),
    });
  } catch (err) {
    throw classifyProbeError(err);
  }

  const stored = deps.instances.upsert({
    platform: 'calendar',
    slug,
    adapter_type: adapter,
    config,
    caps,
    auth_state: 'healthy',
    last_synced_at: null,
  });

  const row = toRow(
    stored.adapter_type as CalendarProviderKind,
    caps,
    stored.auth_state,
    stored.slug,
    stored.last_synced_at,
  );

  try {
    await deps.onEnrolled?.(row);
  } catch (err) {
    throw new RpcError(
      'adapter_start_failed',
      (err as Error).message ?? 'calendar adapter failed to start',
      500,
    );
  }

  return { slug: row.slug, caps };
};

const buildOAuthConfig = (
  slug: string,
  args: EnrollOAuthInput,
): Record<string, unknown> => {
  // `account_slug` is REQUIRED by the gcal / graph adapter config parsers
  // (`parseGcalConfig` / `parseGraphConfig`) — it keys their token + cursor
  // storage. Mail's enroll sets it the same way (`account_slug: slug`).
  // Without it the enroll-time probe throws
  // "gcal adapter: config.account_slug is required" and Connect fails.
  const cfg: Record<string, unknown> = { account_slug: slug };
  const backfill = optionalPositiveNumber(args.backfill_days, 'backfill_days');
  if (backfill !== undefined) cfg.backfill_days = backfill;
  const past = optionalPositiveNumber(args.expansion_past_days, 'expansion_past_days');
  if (past !== undefined) cfg.expansion_past_days = past;
  const future = optionalPositiveNumber(args.expansion_future_days, 'expansion_future_days');
  if (future !== undefined) cfg.expansion_future_days = future;
  const retention = optionalPositiveNumber(args.retention_days, 'retention_days');
  if (retention !== undefined) cfg.retention_days = retention;
  const quota = optionalPositiveNumber(args.quota_bytes, 'quota_bytes');
  if (quota !== undefined) cfg.quota_bytes = quota;
  const poll = optionalPositiveNumber(args.poll_seconds, 'poll_seconds');
  if (poll !== undefined) cfg.poll_seconds = poll;
  if (Array.isArray(args.calendar_filter)) {
    cfg.calendar_filter = args.calendar_filter.filter((x) => typeof x === 'string');
  }
  return cfg;
};

// ────────────────────────────────────────────────────────────────
// enrollBasic (caldav)
// ────────────────────────────────────────────────────────────────

export interface EnrollBasicInput {
  slug?: unknown;
  server_url?: unknown;
  username?: unknown;
  password?: unknown;
  calendar_home_url?: unknown;
  scheduling_outbox_url?: unknown;
  calendar_filter?: unknown;
  probe_rsvp?: unknown;
  backfill_days?: unknown;
  expansion_future_days?: unknown;
  expansion_past_days?: unknown;
  retention_days?: unknown;
  quota_bytes?: unknown;
  poll_seconds?: unknown;
  discover_timeout_ms?: unknown;
}

export const handleCalendarEnrollBasic = async (
  deps: CalendarEnrollDeps,
  args: EnrollBasicInput,
): Promise<{ slug: string; caps: CalendarCollectionCaps }> => {
  const slug = requireSlug(args.slug);
  refuseReservedSlug('collection.calendar.enrollBasic', slug);
  const server_url = requireString(args.server_url, 'server_url');
  const username = requireString(args.username, 'username');
  const password = requireString(args.password, 'password');
  const calendar_home_url = requireString(
    args.calendar_home_url,
    'calendar_home_url',
  );

  if (deps.instances.get('calendar', slug)) {
    throw new RpcError(
      'conflict',
      `collection.calendar.enrollBasic: instance '${slug}' already exists — use collection.calendar.update`,
      409,
    );
  }

  const factory = deps.adapters.get('caldav');
  if (!factory) {
    throw new RpcError('bad_request', `caldav adapter not registered`, 400);
  }

  // Config carries the non-secret connection fields only. The password
  // lives in the account store under `caldav.<slug>.password` (mirrors
  // IMAP) — a config dump never reveals the credential.
  const config: Record<string, unknown> = {
    server_url,
    username,
    calendar_home_url,
  };
  if (args.scheduling_outbox_url !== undefined) {
    config.scheduling_outbox_url = requireString(
      args.scheduling_outbox_url,
      'scheduling_outbox_url',
    );
  }
  if (Array.isArray(args.calendar_filter)) {
    config.calendar_filter = args.calendar_filter.filter(
      (x) => typeof x === 'string',
    );
  }
  if (typeof args.probe_rsvp === 'boolean') {
    config.probe_rsvp = args.probe_rsvp;
  }
  const backfill = optionalPositiveNumber(args.backfill_days, 'backfill_days');
  if (backfill !== undefined) config.backfill_days = backfill;
  const past = optionalPositiveNumber(args.expansion_past_days, 'expansion_past_days');
  if (past !== undefined) config.expansion_past_days = past;
  const future = optionalPositiveNumber(args.expansion_future_days, 'expansion_future_days');
  if (future !== undefined) config.expansion_future_days = future;
  const retention = optionalPositiveNumber(args.retention_days, 'retention_days');
  if (retention !== undefined) config.retention_days = retention;
  const quota = optionalPositiveNumber(args.quota_bytes, 'quota_bytes');
  if (quota !== undefined) config.quota_bytes = quota;
  const poll = optionalPositiveNumber(args.poll_seconds, 'poll_seconds');
  if (poll !== undefined) config.poll_seconds = poll;
  const discover = optionalPositiveNumber(args.discover_timeout_ms, 'discover_timeout_ms');
  if (discover !== undefined) config.discover_timeout_ms = discover;

  // Stash the password BEFORE the probe so the adapter can authenticate
  // its dry-run PROPFIND. The adapter reads it back via
  // `getAccountValue('password')` → `caldav.<slug>.password`.
  await deps.accountStore.set(caldavPasswordKey(slug), password);

  let caps: CalendarCollectionCaps;
  try {
    caps = await probeCalendarAdapter(factory, {
      slug,
      config,
      getAccountValue: async (key) =>
        deps.accountStore.get(`caldav.${slug}.${key}`),
    });
  } catch (err) {
    // Probe failed (bad credentials / unreachable). Best-effort cleanup of
    // the just-stored password so it isn't orphaned — never let a cleanup
    // failure mask the actionable probe error.
    try {
      await deps.accountStore.delete(caldavPasswordKey(slug));
    } catch {
      /* swallow — surfacing the probe error matters more */
    }
    throw classifyProbeError(err);
  }

  const stored = deps.instances.upsert({
    platform: 'calendar',
    slug,
    adapter_type: 'caldav',
    config,
    caps,
    auth_state: 'healthy',
    last_synced_at: null,
  });

  const row = toRow(
    'caldav',
    caps,
    stored.auth_state,
    stored.slug,
    stored.last_synced_at,
  );

  try {
    await deps.onEnrolled?.(row);
  } catch (err) {
    throw new RpcError(
      'adapter_start_failed',
      (err as Error).message ?? 'caldav adapter failed to start',
      500,
    );
  }

  return { slug: row.slug, caps };
};

// ────────────────────────────────────────────────────────────────
// list
// ────────────────────────────────────────────────────────────────

export const handleCalendarList = async (
  deps: CalendarEnrollDeps,
): Promise<{ instances: CollectionInstanceRow[] }> => {
  const rows = deps.instances.list('calendar');
  return {
    instances: rows.map((r) => toRow(
      r.adapter_type as CalendarProviderKind,
      r.caps as CalendarCollectionCaps,
      r.auth_state,
      r.slug,
      r.last_synced_at,
    )),
  };
};

// ────────────────────────────────────────────────────────────────
// update
// ────────────────────────────────────────────────────────────────

export interface UpdateInput {
  slug?: unknown;
  config_patch?: unknown;
  reprobe?: unknown;
}

export const handleCalendarUpdate = async (
  deps: CalendarEnrollDeps,
  args: UpdateInput,
): Promise<{ instance: CollectionInstanceRow; re_probed: boolean }> => {
  const slug = requireSlug(args.slug);
  if (!args.config_patch || typeof args.config_patch !== 'object' || Array.isArray(args.config_patch)) {
    throw new RpcError('bad_request', 'config_patch must be an object', 400);
  }
  // Strip credential keys so an update can never write a secret onto the
  // config row — secrets live in the account store (`caldav.<slug>.password`),
  // never on config. `vault_key` is the retired indirection; drop it too so
  // a stale client can't resurrect it.
  const patch = Object.fromEntries(
    Object.entries(args.config_patch as Record<string, unknown>).filter(
      ([k]) => k !== 'password' && k !== 'vault_key',
    ),
  );
  const reprobe = Boolean(args.reprobe);

  const existing = deps.instances.get('calendar', slug);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.calendar.update: instance '${slug}' not found`,
      404,
    );
  }

  const nextConfig = { ...existing.config, ...patch };
  let caps = existing.caps as CalendarCollectionCaps;
  let re_probed = false;

  if (reprobe) {
    const factory = deps.adapters.get(existing.adapter_type);
    if (!factory) {
      throw new RpcError('bad_request', `unknown adapter '${existing.adapter_type}'`, 400);
    }
    try {
      caps = await probeCalendarAdapter(factory, {
        slug,
        config: nextConfig,
        getAccountValue: async (key) =>
          deps.accountStore.get(`${existing.adapter_type}.${slug}.${key}`),
      });
      re_probed = true;
    } catch (err) {
      throw classifyProbeError(err);
    }
  }

  const stored = deps.instances.upsert({
    platform: 'calendar',
    slug,
    adapter_type: existing.adapter_type,
    config: nextConfig,
    caps,
    auth_state: existing.auth_state,
    last_synced_at: existing.last_synced_at,
  });
  return {
    instance: toRow(
      stored.adapter_type as CalendarProviderKind,
      caps,
      stored.auth_state,
      stored.slug,
      stored.last_synced_at,
    ),
    re_probed,
  };
};

// ────────────────────────────────────────────────────────────────
// delete
// ────────────────────────────────────────────────────────────────

export const handleCalendarDelete = async (
  deps: CalendarEnrollDeps,
  args: { slug?: unknown },
): Promise<{ ok: true }> => {
  const slug = requireSlug(args.slug);
  const existing = deps.instances.get('calendar', slug);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.calendar.delete: instance '${slug}' not found`,
      404,
    );
  }
  await deps.onDeleted?.(slug);
  // caldav keeps its password (enrollBasic) AND its etag sync-cursors
  // (`caldav.<slug>.etag.*`, written by the adapter) under `caldav.<slug>.*` on
  // the shared account store. Purge the whole prefix so a same-slug re-enroll
  // starts from a clean sync — stale etags would otherwise make the new instance
  // skip re-fetching events. Falls back to the exact password key for narrow
  // store doubles that can't enumerate. (gcal/graph OAuth-token cleanup on
  // delete is a separate pre-existing gap — same helper, `<adapter>.<slug>.`.)
  if (existing.adapter_type === 'caldav') {
    const swept = await purgeAccountStorePrefix(deps.accountStore, `caldav.${slug}.`);
    if (!swept) await deps.accountStore.delete(caldavPasswordKey(slug));
  }
  deps.instances.delete('calendar', slug);
  return { ok: true };
};

// ────────────────────────────────────────────────────────────────
// resync
// ────────────────────────────────────────────────────────────────

export const handleCalendarResync = async (
  deps: CalendarEnrollDeps,
  args: { slug?: unknown },
): Promise<{
  ok: true;
  caps: CalendarCollectionCaps;
  auth_state: CollectionAuthState;
}> => {
  const slug = requireSlug(args.slug);
  const existing = deps.instances.get('calendar', slug);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.calendar.resync: instance '${slug}' not found`,
      404,
    );
  }
  const factory = deps.adapters.get(existing.adapter_type);
  if (!factory) {
    throw new RpcError('bad_request', `unknown adapter '${existing.adapter_type}'`, 400);
  }
  let caps: CalendarCollectionCaps = existing.caps as CalendarCollectionCaps;
  let auth_state: CollectionAuthState = existing.auth_state;
  try {
    caps = await probeCalendarAdapter(factory, {
      slug,
      config: existing.config,
      getAccountValue: async (key) =>
        deps.accountStore.get(`${existing.adapter_type}.${slug}.${key}`),
    });
    auth_state = 'healthy';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/auth|credential|token|401|403/i.test(msg)) {
      auth_state = 'expired';
    } else {
      auth_state = 'degraded';
    }
  }

  deps.instances.upsert({
    platform: 'calendar',
    slug,
    adapter_type: existing.adapter_type,
    config: existing.config,
    caps,
    auth_state,
    last_synced_at: (deps.now ?? Date.now)(),
  });
  return { ok: true, caps, auth_state };
};

// ────────────────────────────────────────────────────────────────
// reauth
// ────────────────────────────────────────────────────────────────

export const handleCalendarReauth = async (
  deps: CalendarEnrollDeps,
  args: { slug?: unknown },
): Promise<{ oauth_url: string } | { ok: true }> => {
  const slug = requireSlug(args.slug);
  const existing = deps.instances.get('calendar', slug);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.calendar.reauth: instance '${slug}' not found`,
      404,
    );
  }
  if (existing.adapter_type === 'local') {
    // D-173 P4.3 — the local calendar is credential-free (`auth: 'none'`);
    // there is nothing to re-authorize.
    throw new RpcError(
      'not_implemented',
      `reauth not applicable for the local calendar — it has no credentials`,
      501,
    );
  }
  if (existing.adapter_type === 'caldav') {
    // Basic-auth reauth is "re-enroll with a fresh password" from the UI
    // (delete + enrollBasic) — there's no OAuth consent to re-run.
    throw new RpcError(
      'not_implemented',
      `oauth reauth not applicable for caldav — re-enroll with a fresh password`,
      501,
    );
  }
  // OAuth URL construction per-adapter lives on the ext side (same as
  // collection.mail.enrollOAuth) — the server returns `{ ok: true }`
  // and the UI opens the authorize URL itself so the captured code
  // lands back on `collection.calendar.enrollOAuth` via the usual
  // flow. Distinct shape from file's reauth which is kinds-without-
  // oauth — here the distinction is more informational.
  return { ok: true };
};
