import { collectionOAuthBinding } from '../../collection-oauth-sources.js';
import { managedOAuthFetcherFor, type ManagedOAuthConsumers } from '../../managed-oauth-consumers.js';
/** D-117 Phase 3 — Google Calendar adapter.
 *
 *  Implements `CalendarProvider` against the Google Calendar API v3
 *  directly — no `googleapis` SDK, matching the dep-bloat stance from
 *  `mail/gmail-provider.ts`.
 *
 *  Endpoints used:
 *    POST https://oauth2.googleapis.com/token           — via mail/oauth.ts
 *    GET  /calendar/v3/users/me/calendarList            — list calendars
 *    GET  /calendar/v3/calendars/{id}/events            — events (list + sync)
 *    POST /calendar/v3/calendars/{id}/events            — create
 *    PATCH /calendar/v3/calendars/{id}/events/{eventId} — update / rsvp
 *    DELETE /calendar/v3/calendars/{id}/events/{eventId} — delete
 *
 *  Incremental sync uses `events.list` with `syncToken`. Expired tokens
 *  surface as HTTP 410 Gone — the adapter drops the cached token and
 *  lists the whole window again in the same tick. That listing reports no
 *  deletion, so a row in the window it does not hold is removed
 *  (`CalendarSnapshot`).
 *
 *  Recurrence expansion is server-side (`singleEvents=true`); every
 *  emitted instance carries the raw RRULE via `recurrence_rule` and
 *  its parent series via `recurring_event_id`.
 *
 *  Mutation methods return a verified `ProviderEventPayload` on 2xx
 *  success or throw `CalendarAdapterError`. No middle state — per
 *  D-117's "warehouse never holds a version the provider hasn't
 *  acknowledged" invariant.
 */

import { createHash } from 'node:crypto';

import {
  CalendarAdapterError,
  GOOGLE_TOKEN_URL,
  type CanonicalEvent,
} from '@recued/contracts';
import {
  ProviderPaginationGuard,
  readProviderStringContinuation,
} from '../../provider-pagination-guard.js';

import { calendarSyncFailureOf, listedWindow } from './provider.js';
import type {
  CalendarProvider,
  CalendarProviderHealth,
  CalendarSyncCallback,
  CalendarSyncOutcome,
  CalendarSyncEvent,
  CreateEventInput,
  DeleteEventInput,
  InitialScanOptions,
  ProbedCalendarCaps,
  ProviderEventPayload,
  RsvpEventInput,
  UpdateEventInput,
} from './provider.js';
import type {
  CalendarAdapterContext,
  CalendarAdapterFactory,
} from './adapter-registry.js';
import {
  defaultHttpFetcher,
  getAccessToken,
  keyPrefix,
  OAuthError,
  requireProviderConfig,
  bindOAuthProviderConfig,
  type HttpFetcher,
  type OAuthAccountStore,
  type OAuthProviderConfigSource,
} from '../mail/oauth.js';
import { oauthAuthorizationHeaders } from '../mail/oauth.js';
import {
  startDrainingInterval,
  type ProviderPollScheduler,
  type ProviderPollStop,
} from '../draining-interval.js';
import { CollectionStoppedError, throwIfStopped } from '../stop-signal.js';

// ────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────

export interface GcalProviderConfig {
  /** Matches the `account.gcal.{slug}.*` namespace entry. Typically
   *  equal to the calendar-instance slug; kept distinct so a single
   *  OAuth grant can fan out to multiple instance enrollments in the
   *  future. */
  account_slug: string;
  /** Forward expansion window for ongoing sync ticks. */
  expansion_future_days: number;
  /** Backward expansion window for ongoing sync ticks. */
  expansion_past_days: number;
  /** Poll cadence for the ongoing sync loop. */
  poll_seconds: number;
  /** Calendars to sync. Empty = every entry in `calendarList.list`. */
  calendar_filter?: string[];
}

export interface CreateGcalProviderOptions {
  slug: string;
  config: GcalProviderConfig;
  accountStore: OAuthAccountStore;
  providerConfig: OAuthProviderConfigSource;
  fetcher?: HttpFetcher;
  /** D-322: broker-owned OAuth; no local access token or 401 replay. */
  managedFetcher?: HttpFetcher;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** Test hook — override the poll scheduler so suites don't wait
   *  for real timers. Production uses `setInterval`. */
  scheduler?: ProviderPollScheduler;
}

const GCAL_API_BASE = 'https://www.googleapis.com/calendar/v3';

// ────────────────────────────────────────────────────────────────
// Google Calendar JSON shapes (narrow; only fields we canonicalize)
// ────────────────────────────────────────────────────────────────

export interface GcalEventDateTime {
  /** Date-only variant for all-day events (`YYYY-MM-DD`). */
  date?: string;
  /** RFC-3339 datetime with offset for timed events. */
  dateTime?: string;
  /** IANA timezone — present on timed events, sometimes on all-day. */
  timeZone?: string;
}

export interface GcalEventAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
  self?: boolean;
  organizer?: boolean;
  /** Free-form note attached to the attendee entry — surfaced by
   *  gcal clients when the user RSVPs with a comment. */
  comment?: string;
}

export interface GcalEventReminderOverride {
  method?: string;
  minutes?: number;
}

export interface GcalEventConferenceEntryPoint {
  entryPointType?: string;
  uri?: string;
}

export interface GcalEvent {
  etag?: string;
  id: string;
  iCalUID?: string;
  status?: 'confirmed' | 'cancelled' | 'tentative';
  summary?: string;
  description?: string;
  location?: string;
  start?: GcalEventDateTime;
  end?: GcalEventDateTime;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: GcalEventAttendee[];
  recurrence?: string[];
  recurringEventId?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: GcalEventConferenceEntryPoint[] };
  reminders?: { useDefault?: boolean; overrides?: GcalEventReminderOverride[] };
  created?: string;
  updated?: string;
}

export interface GcalCalendarListEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  selected?: boolean;
  accessRole?: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
}

interface GcalCalendarListResponse {
  items?: GcalCalendarListEntry[];
  nextPageToken?: unknown;
}

interface GcalEventsResponse {
  items?: GcalEvent[];
  nextPageToken?: unknown;
  nextSyncToken?: unknown;
}

// ────────────────────────────────────────────────────────────────
// Canonicalization
// ────────────────────────────────────────────────────────────────

const parseGcalDate = (value?: string): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseGcalStartEnd = (
  dt: GcalEventDateTime | undefined,
): { at: number; timezone: string; allDay: boolean } => {
  if (!dt) return { at: 0, timezone: 'UTC', allDay: false };
  if (dt.dateTime) {
    return {
      at: parseGcalDate(dt.dateTime),
      timezone: dt.timeZone ?? 'UTC',
      allDay: false,
    };
  }
  if (dt.date) {
    // Interpret YYYY-MM-DD as midnight UTC for determinism — timezone
    // hint (if provided) is preserved for display.
    return {
      at: parseGcalDate(`${dt.date}T00:00:00Z`),
      timezone: dt.timeZone ?? 'UTC',
      allDay: true,
    };
  }
  return { at: 0, timezone: dt.timeZone ?? 'UTC', allDay: false };
};

const mapAttendeeResponse = (
  v: GcalEventAttendee['responseStatus'],
): 'accepted' | 'declined' | 'tentative' | 'needs_action' => {
  switch (v) {
    case 'accepted':
      return 'accepted';
    case 'declined':
      return 'declined';
    case 'tentative':
      return 'tentative';
    default:
      return 'needs_action';
  }
};

const pickConferenceUrl = (event: GcalEvent): string | undefined => {
  if (event.hangoutLink) return event.hangoutLink;
  const entry = event.conferenceData?.entryPoints?.find(
    (e) => typeof e.uri === 'string' && e.uri.length > 0,
  );
  return entry?.uri;
};

const mapReminders = (
  event: GcalEvent,
): CanonicalEvent['reminders'] | undefined => {
  const overrides = event.reminders?.overrides ?? [];
  if (overrides.length === 0) return undefined;
  const out: Array<{ method: 'popup' | 'email'; minutes: number }> = [];
  for (const o of overrides) {
    const m = o.method === 'email' ? 'email' : 'popup';
    if (typeof o.minutes === 'number' && Number.isFinite(o.minutes)) {
      out.push({ method: m, minutes: o.minutes });
    }
  }
  return out.length > 0 ? out : undefined;
};

/** Convert a gcal event + its hosting calendar id into the canonical
 *  shape the warehouse stores. Pure — adapters test this directly. */
export const canonicalizeGcalEvent = (
  event: GcalEvent,
  calendarId: string,
  calendarName?: string,
): CanonicalEvent => {
  const start = parseGcalStartEnd(event.start);
  const end = parseGcalStartEnd(event.end);
  const status: CanonicalEvent['status'] =
    event.status === 'cancelled'
      ? 'cancelled'
      : event.status === 'tentative'
        ? 'tentative'
        : 'confirmed';
  const organizer = event.organizer?.email
    ? {
        email: event.organizer.email,
        ...(event.organizer.displayName
          ? { display_name: event.organizer.displayName }
          : {}),
      }
    : undefined;
  const attendees = event.attendees
    ?.filter((a) => typeof a.email === 'string' && a.email.length > 0)
    .map((a) => ({
      email: a.email as string,
      ...(a.displayName ? { display_name: a.displayName } : {}),
      response_status: mapAttendeeResponse(a.responseStatus),
      ...(a.self ? { is_self: true as const } : {}),
    }));

  const canonical: CanonicalEvent = {
    source_id: event.id,
    ical_uid: event.iCalUID ?? event.id,
    calendar_id: calendarId,
    ...(calendarName ? { calendar_name: calendarName } : {}),
    summary: event.summary ?? '',
    ...(event.description ? { description: event.description } : {}),
    ...(event.location ? { location: event.location } : {}),
    start_at: start.at,
    end_at: end.at,
    timezone: start.timezone || end.timezone || 'UTC',
    is_all_day: start.allDay,
    ...(organizer ? { organizer } : {}),
    ...(attendees && attendees.length > 0 ? { attendees } : {}),
    status,
    ...(event.recurrence && event.recurrence.length > 0
      ? { recurrence_rule: event.recurrence[0] }
      : {}),
    ...(event.recurringEventId
      ? { recurring_event_id: event.recurringEventId }
      : {}),
    ...(pickConferenceUrl(event) ? { conference_url: pickConferenceUrl(event) } : {}),
    ...(mapReminders(event) ? { reminders: mapReminders(event) } : {}),
    created_at: parseGcalDate(event.created),
    updated_at: parseGcalDate(event.updated),
  };
  return canonical;
};

const buildPayload = (
  event: GcalEvent,
  calendarId: string,
  calendarName?: string,
  seriesRule?: string,
): ProviderEventPayload => {
  const own = canonicalizeGcalEvent(event, calendarId, calendarName);
  const canonical = seriesRule && !own.recurrence_rule ? { ...own, recurrence_rule: seriesRule } : own;
  const descriptionBytes = canonical.description
    ? Buffer.byteLength(canonical.description, 'utf8')
    : 0;
  return { event: canonical, description_bytes: descriptionBytes, ...(event.etag ? { etag: event.etag } : {}) };
};

// ────────────────────────────────────────────────────────────────
// Error mapping
// ────────────────────────────────────────────────────────────────

/** Turn Google's 403 body into an actionable hint. The two common causes have
 *  very different fixes, and a bare "credentials rejected" hides which one it is:
 *  - `accessNotConfigured` — the Google Calendar API isn't enabled for the
 *    project (enabling the Gmail API does NOT enable Calendar — each is separate).
 *  - `ACCESS_TOKEN_SCOPE_INSUFFICIENT` — the consent didn't grant calendar access.
 *  Anything else falls back to the generic phrasing. */
const describeGcal403 = (body: string): string => {
  const lower = body.toLowerCase();
  if (
    lower.includes('accessnotconfigured')
    || lower.includes('has not been used in project')
    || lower.includes('it is disabled')
  ) {
    return 'the Google Calendar API is not enabled for your Google Cloud project — enable it (APIs & Services → Library → Google Calendar API → Enable), wait a minute, then retry';
  }
  if (
    lower.includes('insufficient authentication scopes')
    || lower.includes('access_token_scope_insufficient')
  ) {
    return 'the sign-in did not grant calendar access — make sure your OAuth consent screen includes the calendar scope, then reconnect';
  }
  return 'credentials rejected';
};

const toAdapterError = (
  status: number,
  body: string,
  operation: string,
): CalendarAdapterError => {
  if (status === 401 || status === 403) {
    const hint = status === 403 ? describeGcal403(body) : 'credentials rejected';
    return new CalendarAdapterError(
      'auth_expired',
      `gcal ${operation}: ${status} — ${hint}`,
      body,
    );
  }
  if (status === 412) return new CalendarAdapterError('version_conflict',
    'The event changed after review. No change was applied. Refresh the calendar and request a new review.');
  if (status === 404) {
    return new CalendarAdapterError(
      'event_not_found',
      `gcal ${operation}: 404 — event or calendar not found`,
      body,
    );
  }
  if (status === 410) {
    // Expired syncToken surfaces as 410; the caller wipes state and
    // retries with a full window scan. Treat as io_error at the adapter
    // boundary so the outer collection decides on retry semantics.
    return new CalendarAdapterError(
      'io_error',
      `gcal ${operation}: 410 Gone (sync token expired)`,
      body,
    );
  }
  if (status === 429) {
    return new CalendarAdapterError(
      'quota_exceeded',
      `gcal ${operation}: 429 — rate limit / quota exceeded`,
      body,
    );
  }
  return new CalendarAdapterError(
    'io_error',
    `gcal ${operation}: ${status}`,
    body,
  );
};

// ────────────────────────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────────────────────────

const calendarIdKeySuffix = (calendarId: string): string =>
  createHash('sha1').update(calendarId).digest('hex').slice(0, 16);

export const createGcalProvider = (
  opts: CreateGcalProviderOptions,
): CalendarProvider => {
  const fetcher: HttpFetcher =
    opts.managedFetcher ?? opts.fetcher ?? defaultHttpFetcher;
  const nowOf = (): number => opts.now?.() ?? Date.now();

  let lastSuccessfulSyncAt = 0;
  let errorCount24h = 0;
  let pendingQueueSize = 0;
  let accessToken = '';
  let pollStop: ProviderPollStop | null = null;
  /** Aborted by `close()`, armed again by `connect()`: the first scan and the
   *  poll `startSync` runs at once go by it, and each scheduled poll by its
   *  loop's own signal. A scan or poll captures the signal when it begins, so
   *  one begun before a close stays stopped across the next connect. */
  let lifecycle = new AbortController();
  /** `onSyncOutcome` listeners: told of each poll's outcome. */
  const outcomeListeners = new Set<(outcome: CalendarSyncOutcome) => void>();
  const reportOutcome = (outcome: CalendarSyncOutcome): void => {
    for (const listener of outcomeListeners) {
      try { listener(outcome); } catch { /* a listener never breaks a sync */ }
    }
  };
  const markSynced = (): void => {
    lastSuccessfulSyncAt = nowOf();
    reportOutcome({ ok: true, at: lastSuccessfulSyncAt });
  };

  const syncTokenKey = (calendarId: string): string =>
    `${keyPrefix('gcal', opts.config.account_slug)}.sync_token.${calendarIdKeySuffix(calendarId)}`;

  const ensureToken = async (force: boolean): Promise<string | undefined> => {
    if (opts.managedFetcher) return undefined;
    if (accessToken && !force) return accessToken;
    accessToken = await getAccessToken({
      provider: 'gcal',
      slug: opts.config.account_slug,
      providerConfig: requireProviderConfig(opts.providerConfig),
      accountStore: opts.accountStore,
      fetcher,
      now: opts.now,
      force,
    });
    return accessToken;
  };

  const markError = (msg: string, err: unknown): void => {
    errorCount24h++;
    opts.log?.('warn', msg, {
      err: err instanceof Error ? err.message : String(err),
    });
  };

  /** GET with one automatic 401-retry that forces a token refresh. `signal`:
   *  a sync's stop, which aborts the request; none starts once it fired. */
  const gcalGet = async <T>(
    url: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<T> => {
    throwIfStopped(signal);
    let token = await ensureToken(false);
    let res = await fetcher(url, {
      method: 'GET',
      headers: { ...oauthAuthorizationHeaders(token) },
      ...(signal ? { signal } : {}),
    });
    if (res.status === 401 && !opts.managedFetcher) {
      throwIfStopped(signal);
      token = await ensureToken(true);
      res = await fetcher(url, {
        method: 'GET',
        headers: { ...oauthAuthorizationHeaders(token) },
        ...(signal ? { signal } : {}),
      });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw toAdapterError(res.status, body, operation);
    }
    return (await res.json()) as T;
  };

  const gcalMutate = async <T>(
    url: string,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body: unknown,
    operation: string,
    expected_etag?: string,
  ): Promise<T | null> => {
    let token = await ensureToken(false);
    const headers: Record<string, string> = {
      ...oauthAuthorizationHeaders(token),
      ...(expected_etag ? { 'If-Match': expected_etag } : {}),
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res = await fetcher(url, { method, headers, body: payload });
    if (res.status === 401 && !opts.managedFetcher) {
      token = await ensureToken(true);
      const retryHeaders: Record<string, string> = {
        ...oauthAuthorizationHeaders(token),
        ...(expected_etag ? { 'If-Match': expected_etag } : {}),
      };
      if (payload) retryHeaders['Content-Type'] = 'application/json';
      res = await fetcher(url, { method, headers: retryHeaders, body: payload });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw toAdapterError(res.status, text, operation);
    }
    if (method === 'DELETE') return null;
    return (await res.json()) as T;
  };

  // The account's address: Google names the primary calendar by it, and the
  // list is read at every sync (`CalendarProvider.accountEmail`).
  let accountEmail = '';
  const listCalendars = async (signal?: AbortSignal): Promise<GcalCalendarListEntry[]> => {
    const out: GcalCalendarListEntry[] = [];
    let pageToken: string | undefined;
    const pagination = new ProviderPaginationGuard('Google calendar list');
    do {
      pagination.claim(pageToken ?? '');
      const url = new URL(`${GCAL_API_BASE}/users/me/calendarList`);
      url.searchParams.set('maxResults', '250');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await gcalGet<GcalCalendarListResponse>(
        url.toString(),
        'calendarList.list',
        signal,
      );
      for (const entry of page.items ?? []) {
        out.push(entry);
      }
      pageToken = readProviderStringContinuation(
        page.nextPageToken,
        'Google calendar list',
      );
    } while (pageToken);
    const primary = out.find((entry) => entry.primary === true)?.id;
    if (typeof primary === 'string' && primary.includes('@')) accountEmail = primary;
    return out;
  };

  const selectedCalendars = async (signal?: AbortSignal): Promise<GcalCalendarListEntry[]> => {
    const all = await listCalendars(signal);
    const filter = opts.config.calendar_filter ?? [];
    if (filter.length === 0) return all;
    const allow = new Set(filter);
    return all.filter((c) => allow.has(c.id));
  };

  const fetchEventsPage = async (
    calendarId: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GcalEventsResponse> => {
    const url = new URL(
      `${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    return gcalGet<GcalEventsResponse>(url.toString(), 'events.list', signal);
  };

  // `singleEvents=true` instances carry no recurrence; only the series master
  // does. One read per series per sync pass puts its RRULE on the instances, so
  // a yearly event can become an occasion (D-325 P16). A failed read leaves the
  // instance as listed.
  let seriesRules = new Map<string, Promise<string | undefined>>();
  const seriesRule = (calendarId: string, event: GcalEvent, signal?: AbortSignal): Promise<string | undefined> => {
    const master = event.recurringEventId;
    if (!master || event.recurrence?.length) return Promise.resolve(undefined);
    const key = JSON.stringify([calendarId, master]);
    let rule = seriesRules.get(key);
    if (!rule) {
      const url = new URL(`${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(master)}`);
      url.searchParams.set('fields', 'recurrence');
      rule = gcalGet<Pick<GcalEvent, 'recurrence'>>(url.toString(), 'events.get', signal)
        .then(found => found.recurrence?.find(line => /^RRULE:/iu.test(line)), () => undefined);
      seriesRules.set(key, rule);
    }
    return rule;
  };
  const payloadOf = async (
    event: GcalEvent, calendarId: string, calendarName?: string, signal?: AbortSignal,
  ): Promise<ProviderEventPayload> =>
    buildPayload(event, calendarId, calendarName, await seriesRule(calendarId, event, signal));

  // ── initial scan ────────────────────────────────────────────
  /** `signal` stops the scan between pages and events by THROWING: a normal
   *  return tells the collection the backfill is complete, and a calendar
   *  whose page chain ended normally gets its sync token stored. */
  const runInitialScan = async (
    scanOpts: InitialScanOptions,
    signal: AbortSignal,
  ): Promise<void> => {
    seriesRules = new Map();
    const calendars = await selectedCalendars(signal);
    const now = nowOf();
    const timeMin = new Date(now - scanOpts.backfill_days * 86_400_000)
      .toISOString();
    const timeMax = new Date(now + scanOpts.expansion_future_days * 86_400_000)
      .toISOString();
    let aborted = false;
    const failures: unknown[] = [];
    for (const cal of calendars) {
      if (aborted) break;
      let pageToken: string | undefined;
      let lastSyncToken: string | undefined;
      let calendarFailed = false;
      const pagination = new ProviderPaginationGuard('Google calendar initial scan');
      do {
        pagination.claim(pageToken ?? '');
        const params: Record<string, string> = {
          singleEvents: 'true',
          timeMin,
          timeMax,
          maxResults: '250',
          showDeleted: 'false',
        };
        if (pageToken) params.pageToken = pageToken;
        const page = await fetchEventsPage(cal.id, params, signal);
        for (const event of page.items ?? []) {
          if (event.status === 'cancelled') continue;
          // Outside the per-event catch, which would count a stop as one
          // failed event and read on.
          throwIfStopped(signal);
          try {
            const payload = await payloadOf(event, cal.id, cal.summary, signal);
            const cont = await scanOpts.onEvent(payload);
            lastSuccessfulSyncAt = nowOf();
            if (!cont) {
              aborted = true;
              break;
            }
          } catch (err) {
            if (signal.aborted) throw new CollectionStoppedError();
            markError(`gcal canonicalize failed id=${event.id}`, err);
            failures.push(err);
            calendarFailed = true;
          }
        }
        pageToken = readProviderStringContinuation(
          page.nextPageToken,
          'Google calendar initial scan',
        );
        if (!pageToken) {
          lastSyncToken = readProviderStringContinuation(
            page.nextSyncToken,
            'Google calendar sync watermark',
          );
        }
      } while (pageToken && !aborted);
      // Persist the sync token only when the full page chain completed
      // — a mid-page abort leaves the token unset so the next tick
      // re-scans the window and picks up the rest.
      // ⛔ And only for a calendar that has none. Every start scans again, and
      // the scan's fresh token replaced the one the last poll left, which is
      // the one that reports the events deleted while the server was down.
      // The scan lists no deleted event (`showDeleted: false`), so their rows
      // stayed for good. Kept, the first poll replays every change since that
      // token, deletions included, as Graph's calendar keeps its delta link. A
      // token Google no longer accepts gets its 410 there, and the window is
      // listed again.
      if (!aborted && !calendarFailed && lastSyncToken
        && !(await opts.accountStore.get(syncTokenKey(cal.id)))) {
        throwIfStopped(signal);
        await opts.accountStore.set(syncTokenKey(cal.id), lastSyncToken);
      }
    }
    if (!aborted && failures.length > 0) {
      throw new AggregateError(failures, 'Google calendar initial scan was incomplete');
    }
  };

  // ── incremental sync tick ───────────────────────────────────
  /** `signal` stops the poll between pages and events by throwing — never by
   *  breaking out: a token-less pass that ended early would reconcile the
   *  window against a partial listing and remove the rows it never reached,
   *  and a pass that ended normally stores its sync token. */
  const runSyncTick = async (cb: CalendarSyncCallback, signal: AbortSignal): Promise<void> => {
    // Clean until a failure is swallowed: only a tick that read every calendar
    // and delivered every change says the calendar is synced.
    let clean = true;
    seriesRules = new Map();
    const calendars = await selectedCalendars(signal);
    const now = nowOf();
    const windowFrom = now - opts.config.expansion_past_days * 86_400_000;
    const windowUntil = now + opts.config.expansion_future_days * 86_400_000;
    const timeMin = new Date(windowFrom).toISOString();
    const timeMax = new Date(windowUntil).toISOString();

    for (const cal of calendars) {
      let syncToken: string | undefined =
        (await opts.accountStore.get(syncTokenKey(cal.id))) ?? undefined;
      // Up to two passes: the first with the cached token, the second
      // without it after a 410 Gone. More than two would mean the full
      // window scan itself 410'd, which is a gcal bug, not ours.
      for (let attempt = 0; attempt < 2; attempt++) {
        let pageToken: string | undefined;
        let lastSyncToken: string | undefined;
        let retry = false;
        let deliveryFailed = false;
        // A pass without a token lists the whole window: the ids it lists.
        const listed: string[] | null = syncToken ? null : [];
        const pagination = new ProviderPaginationGuard('Google calendar sync');
        do {
          pagination.claim(pageToken ?? '');
          const params: Record<string, string> = {
            singleEvents: 'true',
            maxResults: '250',
            showDeleted: 'true',
          };
          if (syncToken) {
            params.syncToken = syncToken;
          } else {
            params.timeMin = timeMin;
            params.timeMax = timeMax;
            params.showDeleted = 'false';
          }
          if (pageToken) params.pageToken = pageToken;

          let page: GcalEventsResponse;
          try {
            page = await fetchEventsPage(cal.id, params, signal);
          } catch (err) {
            if (
              err instanceof CalendarAdapterError &&
              err.code === 'io_error' &&
              typeof err.message === 'string' &&
              err.message.includes('410') &&
              attempt === 0
            ) {
              await opts.accountStore.delete(syncTokenKey(cal.id));
              syncToken = undefined;
              retry = true;
              break;
            }
            throw err;
          }

          for (const event of page.items ?? []) {
            throwIfStopped(signal);
            if (listed && event.status !== 'cancelled') listed.push(event.id);
            pendingQueueSize++;
            try {
              if (event.status === 'cancelled') {
                const sync: CalendarSyncEvent = {
                  kind: 'deleted',
                  source_id: event.id,
                };
                await cb(sync);
              } else {
                const payload = await payloadOf(event, cal.id, cal.summary, signal);
                const sync: CalendarSyncEvent = {
                  kind: 'updated',
                  source_id: event.id,
                  payload,
                };
                await cb(sync);
              }
              lastSuccessfulSyncAt = nowOf();
            } catch (err) {
              if (signal.aborted) throw new CollectionStoppedError();
              markError(`gcal dispatch failed id=${event.id}`, err);
              deliveryFailed = true;
              clean = false;
            } finally {
              pendingQueueSize = Math.max(0, pendingQueueSize - 1);
            }
          }

          pageToken = readProviderStringContinuation(
            page.nextPageToken,
            'Google calendar sync',
          );
          if (!pageToken) {
            lastSyncToken = readProviderStringContinuation(
              page.nextSyncToken,
              'Google calendar sync watermark',
            );
          }
        } while (pageToken);

        if (retry) continue;
        throwIfStopped(signal);
        // That listing reports no deletion, and after a 410 it replaces a token
        // that would have: an event it did not list is gone, so its row is
        // removed (`CalendarSnapshot`). Not acknowledged, the token is not
        // stored, and the next tick lists the window again.
        if (listed && !deliveryFailed) {
          try {
            await cb({
              kind: 'calendar',
              source_id: cal.id,
              calendar: { calendar_id: cal.id, window: listedWindow(windowFrom, windowUntil), keep: listed },
            });
          } catch (err) {
            markError(`gcal reconcile failed calendar=${cal.id}`, err);
            deliveryFailed = true;
            clean = false;
          }
        }
        // A callback rejection means the collection did not durably ingest the
        // event. Retain the prior syncToken so Google replays this complete
        // range on the next tick; collection upserts/deletes are idempotent.
        if (!deliveryFailed && lastSyncToken) {
          throwIfStopped(signal);
          await opts.accountStore.set(syncTokenKey(cal.id), lastSyncToken);
        }
        break;
      }
    }
    if (clean) markSynced();
    else reportOutcome({ ok: false, failure: 'transient', at: nowOf() });
  };

  /** A poll tick that reports a thrown failure too: `auth` for a rejected
   *  credential, else `transient`. Rethrows, so it is logged as before. */
  const runReportedTick = async (cb: CalendarSyncCallback, signal: AbortSignal): Promise<void> => {
    try {
      await runSyncTick(cb, signal);
    } catch (err) {
      // A stopped poll did not fail: there is no outcome to report.
      if (!signal.aborted) reportOutcome({ ok: false, failure: calendarSyncFailureOf(err), at: nowOf() });
      throw err;
    }
  };

  const defaultScheduler: ProviderPollScheduler = (cb, intervalMs) =>
    startDrainingInterval({
      tick: cb,
      intervalMs,
      onError: (err) => markError('gcal poll tick failed', err),
    });

  // ── write-back ──────────────────────────────────────────────
  const requireCalendarId = (
    calendarId: string,
    operation: string,
  ): void => {
    if (!calendarId || calendarId.length === 0) {
      throw new CalendarAdapterError(
        'calendar_not_found',
        `gcal ${operation}: missing calendar_id`,
      );
    }
  };

  const toGcalDateTime = (
    at: number,
    timezone: string,
    isAllDay: boolean,
  ): GcalEventDateTime => {
    if (isAllDay) {
      return {
        date: new Date(at).toISOString().slice(0, 10),
        timeZone: timezone,
      };
    }
    return { dateTime: new Date(at).toISOString(), timeZone: timezone };
  };

  const fromCreateInput = (input: CreateEventInput): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      summary: input.summary,
      status: input.status,
      start: toGcalDateTime(input.start_at, input.timezone, input.is_all_day),
      end: toGcalDateTime(input.end_at, input.timezone, input.is_all_day),
    };
    if (input.description !== undefined) body.description = input.description;
    if (input.location !== undefined) body.location = input.location;
    if (input.attendees && input.attendees.length > 0) {
      body.attendees = input.attendees.map((a) => ({
        email: a.email,
        ...(a.display_name ? { displayName: a.display_name } : {}),
        responseStatus:
          a.response_status === 'needs_action'
            ? 'needsAction'
            : a.response_status,
      }));
    }
    if (input.recurrence_rule) body.recurrence = [input.recurrence_rule];
    if (input.reminders && input.reminders.length > 0) {
      body.reminders = {
        useDefault: false,
        overrides: input.reminders.map((r) => ({
          method: r.method,
          minutes: r.minutes,
        })),
      };
    }
    return body;
  };

  const fromUpdatePatch = (
    patch: UpdateEventInput['patch'],
  ): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    if (patch.summary !== undefined) body.summary = patch.summary;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.location !== undefined) body.location = patch.location;
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.timezone && patch.start_at !== undefined) {
      body.start = toGcalDateTime(
        patch.start_at,
        patch.timezone,
        patch.is_all_day ?? false,
      );
    }
    if (patch.timezone && patch.end_at !== undefined) {
      body.end = toGcalDateTime(
        patch.end_at,
        patch.timezone,
        patch.is_all_day ?? false,
      );
    }
    if (patch.attendees) {
      body.attendees = patch.attendees.map((a) => ({
        email: a.email,
        ...(a.display_name ? { displayName: a.display_name } : {}),
        responseStatus:
          a.response_status === 'needs_action'
            ? 'needsAction'
            : a.response_status,
      }));
    }
    if (patch.recurrence_rule !== undefined) {
      body.recurrence = patch.recurrence_rule ? [patch.recurrence_rule] : [];
    }
    return body;
  };

  const resolveTargetId = (
    input: UpdateEventInput | DeleteEventInput | RsvpEventInput,
  ): string => {
    const scope = 'scope' in input ? (input.scope ?? 'this_instance') : 'this_instance';
    // gcal `singleEvents=true` emits instance ids like
    // `<series>_<utc>` — patching that id mutates the instance (per
    // gcal doc); patching the bare series id mutates the master.
    if (scope === 'series' && input.source_id.includes('_')) {
      return input.source_id.split('_')[0];
    }
    return input.source_id;
  };

  const eventUrl = (calendarId: string, eventId: string): string =>
    `${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

  const fetchEvent = async (
    calendarId: string,
    eventId: string,
  ): Promise<GcalEvent> => {
    const data = await gcalGet<GcalEvent>(
      eventUrl(calendarId, eventId),
      'events.get',
    );
    return data;
  };

  // ── CalendarProvider surface ────────────────────────────────
  return {
    kind: 'gcal',
    slug: opts.slug,
    get accountEmail() { return accountEmail; },

    async connect() {
      // `sync.stop()` closes the provider and a later `sync.start()` reuses it
      // (the vault lock edge): a new connection gets a new signal.
      if (lifecycle.signal.aborted) lifecycle = new AbortController();
      try {
        await ensureToken(false);
      } catch (err) {
        if (err instanceof OAuthError) {
          throw new CalendarAdapterError(
            err.code === 'token_refresh_failed' ? 'auth_expired' : 'io_error',
            `gcal connect failed: ${err.message}`,
            err,
          );
        }
        throw err;
      }
    },

    async initialScan(scanOpts) {
      await runInitialScan(scanOpts, lifecycle.signal);
    },

    async startSync(cb) {
      const scheduler = opts.scheduler ?? defaultScheduler;
      const intervalMs = Math.max(1, opts.config.poll_seconds) * 1000;
      const session = lifecycle.signal;
      // Run an immediate tick so downstream consumers don't have to
      // wait for the first interval.
      await runReportedTick(cb, session);
      // Closed during that first poll: start no loop that nothing would stop.
      if (session.aborted) throw new CollectionStoppedError();
      // A scheduled poll gets its loop's signal; a test scheduler calls it bare.
      pollStop = scheduler((signal) => runReportedTick(cb, signal ?? session), intervalMs);
      return async () => {
        const stop = pollStop;
        pollStop = null;
        await stop?.();
      };
    },

    async close() {
      // Close admission and abort the scan or poll in flight; the poll loop's
      // stop then waits for its pass at most `STOP_GRACE_MS`.
      lifecycle.abort(new CollectionStoppedError('the gcal provider was closed'));
      const stop = pollStop;
      pollStop = null;
      await stop?.();
    },

    onSyncOutcome(listener) {
      outcomeListeners.add(listener);
      return () => { outcomeListeners.delete(listener); };
    },

    health(): CalendarProviderHealth {
      return {
        last_successful_sync_at: lastSuccessfulSyncAt,
        error_count_24h: errorCount24h,
        pending_queue_size: pendingQueueSize,
        pending_series_expansions: 0,
      };
    },

    async createEvent(calendarId, event) {
      requireCalendarId(calendarId, 'events.insert');
      // D-315 slice 7 — an event that keeps a given UID (an emailed invite's
      // own) is IMPORTED: `events.insert` always assigns its own iCalUID, and
      // `events.import` is Google's way to add a copy of someone else's event.
      const imported = event.ical_uid !== undefined && event.ical_uid.length > 0;
      const url = `${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events${imported ? '/import' : ''}`;
      const data = await gcalMutate<GcalEvent>(
        url,
        'POST',
        imported ? { ...fromCreateInput(event), iCalUID: event.ical_uid } : fromCreateInput(event),
        imported ? 'events.import' : 'events.insert',
      );
      if (!data) {
        throw new CalendarAdapterError(
          'io_error',
          'gcal events.insert: empty response',
        );
      }
      return payloadOf(data, calendarId);
    },

    async updateEvent(input) {
      requireCalendarId(input.calendar_id, 'events.patch');
      if (input.scope === 'this_and_future') {
        // gcal needs a two-step split for this scope: truncate the
        // master RRULE then create a new series from the instance
        // forward. That half-transactional dance (with a visible
        // error window if the second call fails) belongs in the
        // dispatcher, not here — adapter stays single-call.
        throw new CalendarAdapterError(
          'rrule_unsupported',
          "gcal update: scope='this_and_future' must be expanded by the dispatcher into series-truncate + new-series-create",
        );
      }
      const eventId = resolveTargetId(input);
      const data = await gcalMutate<GcalEvent>(
        eventUrl(input.calendar_id, eventId),
        'PATCH',
        fromUpdatePatch(input.patch),
        'events.patch',
        input.expected_etag,
      );
      if (!data) {
        throw new CalendarAdapterError(
          'io_error',
          'gcal events.patch: empty response',
        );
      }
      return payloadOf(data, input.calendar_id);
    },

    async deleteEvent(input) {
      requireCalendarId(input.calendar_id, 'events.delete');
      if (input.scope === 'this_and_future') {
        throw new CalendarAdapterError(
          'rrule_unsupported',
          "gcal delete: scope='this_and_future' must be expanded by the dispatcher into series-truncate",
        );
      }
      const eventId = resolveTargetId(input);
      await gcalMutate<void>(
        eventUrl(input.calendar_id, eventId),
        'DELETE',
        undefined,
        'events.delete',
        input.expected_etag,
      );
    },

    async rsvpEvent(input) {
      requireCalendarId(input.calendar_id, 'events.rsvp');
      const eventId = resolveTargetId(input);
      const current = await fetchEvent(input.calendar_id, eventId);
      const selfEmail = input.self_email?.toLowerCase() ?? '';
      const attendees = current.attendees ?? [];
      const selfIdx = attendees.findIndex((a) => {
        if (a.self) return true;
        if (selfEmail && a.email && a.email.toLowerCase() === selfEmail)
          return true;
        return false;
      });
      if (selfIdx === -1) {
        throw new CalendarAdapterError(
          'attendee_not_self',
          `gcal rsvp: signed-in user is not an attendee on event ${eventId}`,
        );
      }
      const gcalResponse =
        input.response === 'tentative'
          ? 'tentative'
          : input.response === 'declined'
            ? 'declined'
            : 'accepted';
      const nextAttendees = attendees.map((a, i) =>
        i === selfIdx
          ? {
              ...a,
              responseStatus: gcalResponse,
              ...(input.comment ? { comment: input.comment } : {}),
            }
          : a,
      );
      const data = await gcalMutate<GcalEvent>(
        eventUrl(input.calendar_id, eventId),
        'PATCH',
        { attendees: nextAttendees },
        'events.rsvp',
      );
      if (!data) {
        throw new CalendarAdapterError(
          'io_error',
          'gcal events.rsvp: empty response',
        );
      }
      return payloadOf(data, input.calendar_id);
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Adapter factory
// ────────────────────────────────────────────────────────────────

export interface CreateGcalAdapterFactoryOptions {
  managedOAuth?: ManagedOAuthConsumers;
  accountStore: OAuthAccountStore;
  providerConfig: OAuthProviderConfigSource;
  fetcher?: HttpFetcher;
  /** D-322: broker-owned OAuth; no local access token or 401 replay. */
  managedFetcher?: HttpFetcher;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  scheduler?: ProviderPollScheduler;
}

const parseGcalConfig = (
  input: Record<string, unknown>,
): GcalProviderConfig => {
  const accountSlug =
    typeof input.account_slug === 'string' ? input.account_slug : undefined;
  if (!accountSlug) {
    throw new Error("gcal adapter: config.account_slug is required");
  }
  const expansionFuture =
    typeof input.expansion_future_days === 'number'
      ? input.expansion_future_days
      : 90;
  const expansionPast =
    typeof input.expansion_past_days === 'number'
      ? input.expansion_past_days
      : 30;
  const pollSeconds =
    typeof input.poll_seconds === 'number' ? input.poll_seconds : 300;
  const filter = Array.isArray(input.calendar_filter)
    ? input.calendar_filter.filter((v): v is string => typeof v === 'string')
    : undefined;
  return {
    account_slug: accountSlug,
    expansion_future_days: expansionFuture,
    expansion_past_days: expansionPast,
    poll_seconds: pollSeconds,
    ...(filter ? { calendar_filter: filter } : {}),
  };
};

/** Run a lightweight probe to confirm credentials resolve and the
 *  account exposes a readable calendarList. Returns the cap sheet
 *  gcal ships with — uniform across gcal enrollments since the API
 *  surface is identical per user. */
const probeGcalCaps = async (
  cfg: GcalProviderConfig,
  opts: CreateGcalAdapterFactoryOptions,
): Promise<ProbedCalendarCaps> => {
  const fetcher: HttpFetcher =
    opts.managedFetcher ?? opts.fetcher ?? defaultHttpFetcher;
  // Resolve a usable access token (refreshing if needed) so auth bugs
  // surface at enroll time, not on the first sync tick. Cache hits are
  // fine — the subsequent calendarList.list call validates the token
  // end-to-end anyway.
  const token = opts.managedFetcher ? undefined : await getAccessToken({
    provider: 'gcal',
    slug: cfg.account_slug,
    providerConfig: requireProviderConfig(opts.providerConfig),
    accountStore: opts.accountStore,
    fetcher,
    now: opts.now,
  });
  const res = await fetcher(
    `${GCAL_API_BASE}/users/me/calendarList?maxResults=1`,
    {
      method: 'GET',
      headers: { ...oauthAuthorizationHeaders(token) },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw toAdapterError(res.status, body, 'calendarList.list (probe)');
  }
  return {
    read: 'yes',
    list_calendars: 'yes',
    create_event: 'yes',
    update_event: 'yes',
    delete_event: 'yes',
    rsvp: 'yes',
    search: 'remote',
    watch: 'poll',
    auth: 'oauth',
    recurrence: 'server',
  };
};

export const createGcalAdapterFactory = (
  opts: CreateGcalAdapterFactoryOptions,
): CalendarAdapterFactory => ({
  kind: 'gcal',
  async probeCaps(ctx: CalendarAdapterContext) {
    const cfg = parseGcalConfig(ctx.config);
    const managedFetcher = managedOAuthFetcherFor(opts.managedOAuth, 'gcal', collectionOAuthBinding(ctx.config));
    const providerConfig = bindOAuthProviderConfig(opts.providerConfig, ctx.config.oauth_app_id);
    const caps = await probeGcalCaps(cfg, { ...opts, providerConfig, ...(managedFetcher ? { managedFetcher } : {}) });
    if (ctx.config.native_write_enabled === false || managedFetcher && ctx.config.managed_write_enabled !== true) {
      return { ...caps, create_event: 'no', update_event: 'no', delete_event: 'no', rsvp: 'no' };
    }
    return caps;
  },
  create(ctx: CalendarAdapterContext): CalendarProvider {
    const cfg = parseGcalConfig(ctx.config);
    return createGcalProvider({
      slug: ctx.slug,
      config: cfg,
      accountStore: opts.accountStore,
      providerConfig: bindOAuthProviderConfig(opts.providerConfig, ctx.config.oauth_app_id),
      fetcher: opts.fetcher,
      managedFetcher: managedOAuthFetcherFor(opts.managedOAuth, 'gcal', collectionOAuthBinding(ctx.config)) ?? opts.managedFetcher,
      now: opts.now,
      log: opts.log ?? ctx.log,
      scheduler: opts.scheduler,
    });
  },
});

// ────────────────────────────────────────────────────────────────
// Shipped OAuth client config
// ────────────────────────────────────────────────────────────────

/** Google Calendar's token endpoint — a PROTOCOL constant, not a credential.
 *
 *  This used to be `GCAL_OAUTH_CONFIG`, an `OAuthProviderConfig` whose
 *  `clientId` / `clientSecret` were read from `RECUED_GCAL_CLIENT_ID` /
 *  `_SECRET`. Those two env vars were DELETED (2026-07-28). Credentials now
 *  come ONLY from the encrypted `OAuthAppConfigStore` — under issuer `google`,
 *  the SAME record gmail uses (one Google Cloud app covers both). */
export const GCAL_TOKEN_URL = GOOGLE_TOKEN_URL;
