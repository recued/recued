/** D-117 Phase 4 — Microsoft Graph calendar adapter.
 *
 *  Implements `CalendarProvider` against the Graph REST API directly —
 *  no SDK, matching the dep-bloat stance from `mail/graph-provider.ts`.
 *
 *  Endpoints used:
 *    POST https://login.microsoftonline.com/.../token   — via mail/oauth.ts
 *    GET  /me/calendars                                 — list calendars
 *    GET  /me/calendars/{id}/calendarView              — initial scan
 *    GET  /me/calendars/{id}/calendarView/delta         — incremental sync
 *    POST /me/calendars/{id}/events                     — create
 *    PATCH /me/events/{id}                              — update
 *    DELETE /me/events/{id}                             — delete
 *    POST /me/events/{id}/accept|decline|tentativelyAccept — rsvp
 *    GET  /me/events/{id}                               — post-rsvp refresh
 *
 *  Incremental sync uses `calendarView/delta` with `@odata.deltaLink`.
 *  Like gcal, an expired deltaLink surfaces as 410 Gone → the adapter
 *  drops the cached link and re-runs a full-window scan on the next
 *  tick. Recurrence expansion is server-side (calendarView returns
 *  pre-expanded instances); seriesMaster / occurrence distinction is
 *  preserved via `seriesMasterId` → `recurring_event_id`.
 *
 *  Every request sets `Prefer: outlook.timezone="UTC"` so datetimes
 *  arrive normalised; the canonical `timezone` field is populated
 *  from `originalStartTimeZone` (IANA on modern tenants, Windows-style
 *  on older tenants — preserved verbatim).
 *
 *  Mutation methods return a verified `ProviderEventPayload` on 2xx
 *  success or throw `CalendarAdapterError`. RSVP calls Graph's
 *  accept/decline/tentativelyAccept (202 Accepted, empty body) and
 *  refetches the event to shape the verified response.
 */

import { createHash } from 'node:crypto';

import {
  CalendarAdapterError,
  MICROSOFT_TOKEN_URL,
  type CanonicalEvent,
} from '@recued/contracts';
import {
  assertProviderPageUrl,
  ProviderPaginationGuard,
  readProviderStringContinuation,
} from '../../provider-pagination-guard.js';

import type {
  CalendarProvider,
  CalendarProviderHealth,
  CalendarSyncCallback,
  CalendarSyncEvent,
  CreateEventInput,
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
  type HttpFetcher,
  type OAuthAccountStore,
  type OAuthProviderConfigSource,
} from '../mail/oauth.js';
import {
  startDrainingInterval,
  type ProviderPollScheduler,
  type ProviderPollStop,
} from '../draining-interval.js';

// ────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────

export interface GraphCalProviderConfig {
  account_slug: string;
  expansion_future_days: number;
  expansion_past_days: number;
  poll_seconds: number;
  /** Calendars to sync. Empty = every entry in `/me/calendars`. */
  calendar_filter?: string[];
}

export interface CreateGraphCalProviderOptions {
  slug: string;
  config: GraphCalProviderConfig;
  accountStore: OAuthAccountStore;
  providerConfig: OAuthProviderConfigSource;
  fetcher?: HttpFetcher;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** Test hook — override the poll scheduler. Production uses
   *  `setInterval`. */
  scheduler?: ProviderPollScheduler;
}

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

// ────────────────────────────────────────────────────────────────
// Graph event shape (narrow — only fields we canonicalize)
// ────────────────────────────────────────────────────────────────

export interface GraphCalDateTime {
  dateTime: string;
  /** Usually "UTC" because we send `Prefer: outlook.timezone="UTC"`. */
  timeZone?: string;
}

export interface GraphCalEmailAddress {
  address?: string;
  name?: string;
}

export interface GraphCalAttendee {
  emailAddress?: GraphCalEmailAddress;
  type?: 'required' | 'optional' | 'resource';
  status?: {
    response?:
      | 'none'
      | 'organizer'
      | 'tentativelyAccepted'
      | 'accepted'
      | 'declined'
      | 'notResponded';
    time?: string;
  };
}

export interface GraphCalRecurrence {
  pattern?: { type?: string; interval?: number };
  range?: { startDate?: string; endDate?: string; type?: string };
}

export interface GraphCalEvent {
  id: string;
  /** Graph spells this `iCalUId` (capital U, lower d). */
  iCalUId?: string;
  /** Present on `@removed` delta entries only — absent on live events. */
  '@removed'?: { reason: string };
  subject?: string;
  body?: { contentType?: 'html' | 'text'; content?: string };
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: GraphCalDateTime;
  end?: GraphCalDateTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  organizer?: { emailAddress?: GraphCalEmailAddress };
  attendees?: GraphCalAttendee[];
  recurrence?: GraphCalRecurrence | null;
  seriesMasterId?: string | null;
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  showAs?:
    | 'free'
    | 'tentative'
    | 'busy'
    | 'oof'
    | 'workingElsewhere'
    | 'unknown';
  onlineMeeting?: { joinUrl?: string };
  originalStartTimeZone?: string;
  reminderMinutesBeforeStart?: number;
  isReminderOn?: boolean;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

export interface GraphCalListEntry {
  id: string;
  name?: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
}

interface GraphListResponse<T> {
  value?: T[];
  '@odata.nextLink'?: unknown;
  '@odata.deltaLink'?: unknown;
}

// ────────────────────────────────────────────────────────────────
// Canonicalization
// ────────────────────────────────────────────────────────────────

const parseGraphDate = (value?: string): number => {
  if (!value) return 0;
  // Graph returns dateTime without a trailing 'Z' when `Prefer:
  // outlook.timezone="UTC"` is set; append it so Date.parse treats it
  // as UTC rather than local.
  const normalised = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const parsed = Date.parse(normalised);
  return Number.isFinite(parsed) ? parsed : 0;
};

const mapAttendeeResponse = (
  v: GraphCalAttendee['status'],
): 'accepted' | 'declined' | 'tentative' | 'needs_action' => {
  const r = v?.response;
  if (r === 'accepted' || r === 'organizer') return 'accepted';
  if (r === 'declined') return 'declined';
  if (r === 'tentativelyAccepted') return 'tentative';
  return 'needs_action';
};

const mapStatus = (event: GraphCalEvent): CanonicalEvent['status'] => {
  if (event.isCancelled) return 'cancelled';
  if (event.showAs === 'tentative') return 'tentative';
  return 'confirmed';
};

const mapReminders = (
  event: GraphCalEvent,
): CanonicalEvent['reminders'] | undefined => {
  if (
    event.isReminderOn === false ||
    typeof event.reminderMinutesBeforeStart !== 'number'
  ) {
    return undefined;
  }
  return [{ method: 'popup', minutes: event.reminderMinutesBeforeStart }];
};

const stripHtml = (html: string): string =>
  html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const extractDescription = (event: GraphCalEvent): string | undefined => {
  const body = event.body;
  if (body?.content) {
    if (body.contentType === 'html') {
      const stripped = stripHtml(body.content);
      return stripped.length > 0 ? stripped : undefined;
    }
    return body.content;
  }
  return event.bodyPreview && event.bodyPreview.length > 0
    ? event.bodyPreview
    : undefined;
};

/** Convert a Graph event + its hosting calendar id into the canonical
 *  shape. Pure — adapters test this directly. */
export const canonicalizeGraphEvent = (
  event: GraphCalEvent,
  calendarId: string,
  calendarName?: string,
): CanonicalEvent => {
  const startAt = parseGraphDate(event.start?.dateTime);
  const endAt = parseGraphDate(event.end?.dateTime);
  const isAllDay = event.isAllDay ?? false;
  const timezone =
    event.originalStartTimeZone && event.originalStartTimeZone.length > 0
      ? event.originalStartTimeZone
      : (event.start?.timeZone ?? 'UTC');

  const organizer = event.organizer?.emailAddress?.address
    ? {
        email: event.organizer.emailAddress.address,
        ...(event.organizer.emailAddress.name
          ? { display_name: event.organizer.emailAddress.name }
          : {}),
      }
    : undefined;

  const attendees = event.attendees
    ?.filter(
      (a): a is GraphCalAttendee & { emailAddress: { address: string } } =>
        typeof a.emailAddress?.address === 'string' &&
        a.emailAddress.address.length > 0,
    )
    .map((a) => ({
      email: a.emailAddress.address,
      ...(a.emailAddress.name ? { display_name: a.emailAddress.name } : {}),
      response_status: mapAttendeeResponse(a.status),
      ...(a.type === 'resource' ? {} : {}),
    }));

  const description = extractDescription(event);
  const location = event.location?.displayName;
  const conferenceUrl = event.onlineMeeting?.joinUrl;
  const reminders = mapReminders(event);

  const recurrenceRule =
    event.recurrence && event.recurrence.pattern?.type
      ? `GRAPH:${event.recurrence.pattern.type}`
      : undefined;

  const canonical: CanonicalEvent = {
    source_id: event.id,
    ical_uid: event.iCalUId ?? event.id,
    calendar_id: calendarId,
    ...(calendarName ? { calendar_name: calendarName } : {}),
    summary: event.subject ?? '',
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    start_at: startAt,
    end_at: endAt,
    timezone,
    is_all_day: isAllDay,
    ...(organizer ? { organizer } : {}),
    ...(attendees && attendees.length > 0 ? { attendees } : {}),
    status: mapStatus(event),
    ...(recurrenceRule ? { recurrence_rule: recurrenceRule } : {}),
    ...(event.seriesMasterId
      ? { recurring_event_id: event.seriesMasterId }
      : {}),
    ...(conferenceUrl ? { conference_url: conferenceUrl } : {}),
    ...(reminders ? { reminders } : {}),
    created_at: parseGraphDate(event.createdDateTime),
    updated_at: parseGraphDate(event.lastModifiedDateTime),
  };
  return canonical;
};

const buildPayload = (
  event: GraphCalEvent,
  calendarId: string,
  calendarName?: string,
): ProviderEventPayload => {
  const canonical = canonicalizeGraphEvent(event, calendarId, calendarName);
  const descriptionBytes = canonical.description
    ? Buffer.byteLength(canonical.description, 'utf8')
    : 0;
  return { event: canonical, description_bytes: descriptionBytes };
};

// ────────────────────────────────────────────────────────────────
// Error mapping
// ────────────────────────────────────────────────────────────────

const toAdapterError = (
  status: number,
  body: string,
  operation: string,
): CalendarAdapterError => {
  if (status === 401 || status === 403) {
    return new CalendarAdapterError(
      'auth_expired',
      `graph ${operation}: ${status} — credentials rejected`,
      body,
    );
  }
  if (status === 404) {
    return new CalendarAdapterError(
      'event_not_found',
      `graph ${operation}: 404 — event or calendar not found`,
      body,
    );
  }
  if (status === 410) {
    return new CalendarAdapterError(
      'io_error',
      `graph ${operation}: 410 Gone (deltaLink expired)`,
      body,
    );
  }
  if (status === 429) {
    return new CalendarAdapterError(
      'quota_exceeded',
      `graph ${operation}: 429 — rate limit / quota exceeded`,
      body,
    );
  }
  return new CalendarAdapterError(
    'io_error',
    `graph ${operation}: ${status}`,
    body,
  );
};

// ────────────────────────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────────────────────────

const calendarIdKeySuffix = (calendarId: string): string =>
  createHash('sha1').update(calendarId).digest('hex').slice(0, 16);

export const createGraphCalProvider = (
  opts: CreateGraphCalProviderOptions,
): CalendarProvider => {
  const fetcher: HttpFetcher =
    opts.fetcher ?? defaultHttpFetcher;
  const nowOf = (): number => opts.now?.() ?? Date.now();

  let lastSuccessfulSyncAt = 0;
  let errorCount24h = 0;
  let pendingQueueSize = 0;
  let accessToken = '';
  let pollStop: ProviderPollStop | null = null;

  const deltaLinkKey = (calendarId: string): string =>
    `${keyPrefix('graph', opts.config.account_slug)}.cal_delta_link.${calendarIdKeySuffix(calendarId)}`;

  const ensureToken = async (force: boolean): Promise<string> => {
    if (accessToken && !force) return accessToken;
    accessToken = await getAccessToken({
      provider: 'graph',
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

  /** Shared headers: bearer + UTC-normalised datetimes. */
  const graphHeaders = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    Prefer: 'outlook.timezone="UTC"',
  });

  const graphGet = async <T>(url: string, operation: string): Promise<T> => {
    const safeUrl = assertProviderPageUrl(url, GRAPH_API_BASE, 'graph calendar');
    let token = await ensureToken(false);
    let res = await fetcher(safeUrl, { method: 'GET', headers: graphHeaders(token) });
    if (res.status === 401) {
      token = await ensureToken(true);
      res = await fetcher(safeUrl, {
        method: 'GET',
        headers: graphHeaders(token),
      });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw toAdapterError(res.status, body, operation);
    }
    return (await res.json()) as T;
  };

  const graphMutate = async <T>(
    url: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    operation: string,
    returnsBody = true,
  ): Promise<T | null> => {
    let token = await ensureToken(false);
    const headers: Record<string, string> = graphHeaders(token);
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res = await fetcher(url, { method, headers, body: payload });
    if (res.status === 401) {
      token = await ensureToken(true);
      const retryHeaders: Record<string, string> = graphHeaders(token);
      if (payload) retryHeaders['Content-Type'] = 'application/json';
      res = await fetcher(url, {
        method,
        headers: retryHeaders,
        body: payload,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw toAdapterError(res.status, text, operation);
    }
    if (!returnsBody) return null;
    if (method === 'DELETE') return null;
    return (await res.json()) as T;
  };

  const listCalendars = async (): Promise<GraphCalListEntry[]> => {
    const out: GraphCalListEntry[] = [];
    let url: string | undefined = `${GRAPH_API_BASE}/me/calendars?$top=250`;
    const pagination = new ProviderPaginationGuard('graph calendar list', {
      trustedBaseUrl: GRAPH_API_BASE,
    });
    while (url) {
      const page: GraphListResponse<GraphCalListEntry> = await graphGet(
        pagination.claim(url),
        'calendars.list',
      );
      for (const entry of page.value ?? []) out.push(entry);
      url = readProviderStringContinuation(
        page['@odata.nextLink'],
        'graph calendar list',
      );
    }
    return out;
  };

  const selectedCalendars = async (): Promise<GraphCalListEntry[]> => {
    const all = await listCalendars();
    const filter = opts.config.calendar_filter ?? [];
    if (filter.length === 0) return all;
    const allow = new Set(filter);
    return all.filter((c) => allow.has(c.id));
  };

  // ── initial scan ────────────────────────────────────────────
  const runInitialScan = async (
    scanOpts: InitialScanOptions,
  ): Promise<void> => {
    const calendars = await selectedCalendars();
    const now = nowOf();
    const startDateTime = new Date(now - scanOpts.backfill_days * 86_400_000)
      .toISOString();
    const endDateTime = new Date(
      now + scanOpts.expansion_future_days * 86_400_000,
    ).toISOString();

    let aborted = false;
    for (const cal of calendars) {
      if (aborted) break;
      const base = new URL(
        `${GRAPH_API_BASE}/me/calendars/${encodeURIComponent(cal.id)}/calendarView`,
      );
      base.searchParams.set('startDateTime', startDateTime);
      base.searchParams.set('endDateTime', endDateTime);
      base.searchParams.set('$top', '250');
      let url: string | undefined = base.toString();
      const pagination = new ProviderPaginationGuard('graph calendar initial scan', {
        trustedBaseUrl: GRAPH_API_BASE,
      });
      while (url && !aborted) {
        const page: GraphListResponse<GraphCalEvent> = await graphGet(
          pagination.claim(url),
          'calendarView',
        );
        for (const event of page.value ?? []) {
          if (event['@removed'] || event.isCancelled) continue;
          try {
            const payload = buildPayload(event, cal.id, cal.name);
            const cont = await scanOpts.onEvent(payload);
            lastSuccessfulSyncAt = nowOf();
            if (!cont) {
              aborted = true;
              break;
            }
          } catch (err) {
            markError(`graph canonicalize failed id=${event.id}`, err);
          }
        }
        url = readProviderStringContinuation(
          page['@odata.nextLink'],
          'graph calendar initial scan',
        );
      }
    }
  };

  // ── incremental sync tick ───────────────────────────────────
  const seedDeltaLink = async (
    calendarId: string,
    startDateTime: string,
    endDateTime: string,
  ): Promise<string | null> => {
    const base = new URL(
      `${GRAPH_API_BASE}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta`,
    );
    base.searchParams.set('startDateTime', startDateTime);
    base.searchParams.set('endDateTime', endDateTime);
    let url: string | undefined = base.toString();
    const pagination = new ProviderPaginationGuard('graph calendar delta seed', {
      trustedBaseUrl: GRAPH_API_BASE,
    });
    while (url) {
      const page: GraphListResponse<GraphCalEvent> = await graphGet(
        pagination.claim(url),
        'calendarView.delta (seed)',
      );
      const rawDeltaLink = readProviderStringContinuation(
        page['@odata.deltaLink'],
        'graph calendar delta watermark',
      );
      if (rawDeltaLink !== undefined) {
        const deltaLink = assertProviderPageUrl(
          rawDeltaLink,
          GRAPH_API_BASE,
          'graph calendar delta watermark',
        );
        await opts.accountStore.set(deltaLinkKey(calendarId), deltaLink);
        return deltaLink;
      }
      url = readProviderStringContinuation(
        page['@odata.nextLink'],
        'graph calendar delta seed',
      );
    }
    return null;
  };

  const runSyncTick = async (cb: CalendarSyncCallback): Promise<void> => {
    const calendars = await selectedCalendars();
    const now = nowOf();
    const startDateTime = new Date(
      now - opts.config.expansion_past_days * 86_400_000,
    ).toISOString();
    const endDateTime = new Date(
      now + opts.config.expansion_future_days * 86_400_000,
    ).toISOString();

    for (const cal of calendars) {
      let link = await opts.accountStore.get(deltaLinkKey(cal.id));
      // Up to two passes: the first with the cached link, the second
      // after a 410 Gone forces a fresh seed + scan.
      for (let attempt = 0; attempt < 2; attempt++) {
        let retry = false;
        let url: string | undefined;
        if (link) {
          url = link;
        } else {
          // No cached link — seed from the current window without
          // emitting (same as mail graph's seed behaviour).
          const seeded = await seedDeltaLink(cal.id, startDateTime, endDateTime);
          if (!seeded) break;
          link = seeded;
          break;
        }

        const pagination = new ProviderPaginationGuard('graph calendar delta', {
          trustedBaseUrl: GRAPH_API_BASE,
        });
        while (url) {
          let page: GraphListResponse<GraphCalEvent>;
          try {
            page = await graphGet<GraphListResponse<GraphCalEvent>>(
              pagination.claim(url),
              'calendarView.delta',
            );
          } catch (err) {
            if (
              err instanceof CalendarAdapterError &&
              err.code === 'io_error' &&
              typeof err.message === 'string' &&
              err.message.includes('410') &&
              attempt === 0
            ) {
              await opts.accountStore.delete(deltaLinkKey(cal.id));
              link = null;
              retry = true;
              break;
            }
            throw err;
          }
          for (const event of page.value ?? []) {
            pendingQueueSize++;
            try {
              if (event['@removed']) {
                const sync: CalendarSyncEvent = {
                  kind: 'deleted',
                  source_id: event.id,
                };
                await cb(sync);
              } else if (event.isCancelled) {
                const sync: CalendarSyncEvent = {
                  kind: 'deleted',
                  source_id: event.id,
                };
                await cb(sync);
              } else {
                const payload = buildPayload(event, cal.id, cal.name);
                const sync: CalendarSyncEvent = {
                  kind: 'updated',
                  source_id: event.id,
                  payload,
                };
                await cb(sync);
              }
              lastSuccessfulSyncAt = nowOf();
            } catch (err) {
              markError(`graph dispatch failed id=${event.id}`, err);
            } finally {
              pendingQueueSize = Math.max(0, pendingQueueSize - 1);
            }
          }
          const rawDeltaLink = readProviderStringContinuation(
            page['@odata.deltaLink'],
            'graph calendar delta watermark',
          );
          if (rawDeltaLink !== undefined) {
            const deltaLink = assertProviderPageUrl(
              rawDeltaLink,
              GRAPH_API_BASE,
              'graph calendar delta watermark',
            );
            await opts.accountStore.set(deltaLinkKey(cal.id), deltaLink);
            link = deltaLink;
          }
          url = readProviderStringContinuation(
            page['@odata.nextLink'],
            'graph calendar delta',
          );
        }

        if (retry) continue;
        break;
      }
    }
  };

  const defaultScheduler: ProviderPollScheduler = (cb, intervalMs) =>
    startDrainingInterval({
      tick: cb,
      intervalMs,
      onError: (err) => markError('graph poll tick failed', err),
    });

  // ── write-back ──────────────────────────────────────────────
  const requireCalendarId = (calendarId: string, operation: string): void => {
    if (!calendarId || calendarId.length === 0) {
      throw new CalendarAdapterError(
        'calendar_not_found',
        `graph ${operation}: missing calendar_id`,
      );
    }
  };

  const toGraphDateTime = (
    at: number,
    timezone: string,
  ): GraphCalDateTime => ({
    dateTime: new Date(at).toISOString().replace(/\.\d{3}Z$/, ''),
    timeZone: timezone || 'UTC',
  });

  const fromCreateInput = (input: CreateEventInput): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      subject: input.summary,
      start: toGraphDateTime(input.start_at, input.timezone),
      end: toGraphDateTime(input.end_at, input.timezone),
      isAllDay: input.is_all_day,
    };
    if (input.description !== undefined) {
      body.body = { contentType: 'text', content: input.description };
    }
    if (input.location !== undefined) {
      body.location = { displayName: input.location };
    }
    if (input.attendees && input.attendees.length > 0) {
      body.attendees = input.attendees.map((a) => ({
        emailAddress: {
          address: a.email,
          ...(a.display_name ? { name: a.display_name } : {}),
        },
        type: 'required',
      }));
    }
    if (input.reminders && input.reminders.length > 0) {
      body.isReminderOn = true;
      body.reminderMinutesBeforeStart = input.reminders[0].minutes;
    }
    return body;
  };

  const fromUpdatePatch = (
    patch: UpdateEventInput['patch'],
  ): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    if (patch.summary !== undefined) body.subject = patch.summary;
    if (patch.description !== undefined) {
      body.body = { contentType: 'text', content: patch.description };
    }
    if (patch.location !== undefined) {
      body.location = { displayName: patch.location };
    }
    if (patch.timezone && patch.start_at !== undefined) {
      body.start = toGraphDateTime(patch.start_at, patch.timezone);
    }
    if (patch.timezone && patch.end_at !== undefined) {
      body.end = toGraphDateTime(patch.end_at, patch.timezone);
    }
    if (patch.is_all_day !== undefined) body.isAllDay = patch.is_all_day;
    if (patch.attendees) {
      body.attendees = patch.attendees.map((a) => ({
        emailAddress: {
          address: a.email,
          ...(a.display_name ? { name: a.display_name } : {}),
        },
        type: 'required',
      }));
    }
    return body;
  };

  const eventUrl = (eventId: string): string =>
    `${GRAPH_API_BASE}/me/events/${encodeURIComponent(eventId)}`;

  const fetchEvent = async (eventId: string): Promise<GraphCalEvent> =>
    graphGet<GraphCalEvent>(eventUrl(eventId), 'events.get');

  return {
    kind: 'graph',
    slug: opts.slug,

    async connect() {
      try {
        await ensureToken(false);
      } catch (err) {
        if (err instanceof OAuthError) {
          throw new CalendarAdapterError(
            err.code === 'token_refresh_failed' ? 'auth_expired' : 'io_error',
            `graph connect failed: ${err.message}`,
            err,
          );
        }
        throw err;
      }
    },

    async initialScan(scanOpts) {
      await runInitialScan(scanOpts);
    },

    async startSync(cb) {
      const scheduler = opts.scheduler ?? defaultScheduler;
      const intervalMs = Math.max(1, opts.config.poll_seconds) * 1000;
      // Fire an immediate tick so downstream consumers don't wait on
      // the first interval.
      await runSyncTick(cb);
      pollStop = scheduler(() => runSyncTick(cb), intervalMs);
      return async () => {
        const stop = pollStop;
        pollStop = null;
        await stop?.();
      };
    },

    async close() {
      const stop = pollStop;
      pollStop = null;
      await stop?.();
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
      const url = `${GRAPH_API_BASE}/me/calendars/${encodeURIComponent(calendarId)}/events`;
      const data = await graphMutate<GraphCalEvent>(
        url,
        'POST',
        fromCreateInput(event),
        'events.insert',
      );
      if (!data) {
        throw new CalendarAdapterError(
          'io_error',
          'graph events.insert: empty response',
        );
      }
      return buildPayload(data, calendarId);
    },

    async updateEvent(input) {
      requireCalendarId(input.calendar_id, 'events.patch');
      if (input.scope === 'this_and_future') {
        throw new CalendarAdapterError(
          'rrule_unsupported',
          "graph update: scope='this_and_future' must be expanded by the dispatcher into series-truncate + new-series-create",
        );
      }
      const data = await graphMutate<GraphCalEvent>(
        eventUrl(input.source_id),
        'PATCH',
        fromUpdatePatch(input.patch),
        'events.patch',
      );
      if (!data) {
        throw new CalendarAdapterError(
          'io_error',
          'graph events.patch: empty response',
        );
      }
      return buildPayload(data, input.calendar_id);
    },

    async deleteEvent(input) {
      requireCalendarId(input.calendar_id, 'events.delete');
      if (input.scope === 'this_and_future') {
        throw new CalendarAdapterError(
          'rrule_unsupported',
          "graph delete: scope='this_and_future' must be expanded by the dispatcher into series-truncate",
        );
      }
      await graphMutate<void>(
        eventUrl(input.source_id),
        'DELETE',
        undefined,
        'events.delete',
        false,
      );
    },

    async rsvpEvent(input: RsvpEventInput): Promise<ProviderEventPayload> {
      requireCalendarId(input.calendar_id, 'events.rsvp');
      const endpoint =
        input.response === 'accepted'
          ? 'accept'
          : input.response === 'declined'
            ? 'decline'
            : 'tentativelyAccept';
      const body: Record<string, unknown> = { sendResponse: true };
      if (input.comment) body.comment = input.comment;
      await graphMutate<void>(
        `${eventUrl(input.source_id)}/${endpoint}`,
        'POST',
        body,
        `events.${endpoint}`,
        false,
      );
      // Graph's accept/decline/tentativelyAccept returns 202 with no
      // body — fetch the event back so the dispatcher gets a verified
      // canonical payload to write into the warehouse.
      const refreshed = await fetchEvent(input.source_id);
      return buildPayload(refreshed, input.calendar_id);
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Adapter factory
// ────────────────────────────────────────────────────────────────

export interface CreateGraphCalAdapterFactoryOptions {
  accountStore: OAuthAccountStore;
  providerConfig: OAuthProviderConfigSource;
  fetcher?: HttpFetcher;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  scheduler?: ProviderPollScheduler;
}

const parseGraphCalConfig = (
  input: Record<string, unknown>,
): GraphCalProviderConfig => {
  const accountSlug =
    typeof input.account_slug === 'string' ? input.account_slug : undefined;
  if (!accountSlug) {
    throw new Error('graph adapter: config.account_slug is required');
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

const probeGraphCalCaps = async (
  cfg: GraphCalProviderConfig,
  opts: CreateGraphCalAdapterFactoryOptions,
): Promise<ProbedCalendarCaps> => {
  const fetcher: HttpFetcher =
    opts.fetcher ?? defaultHttpFetcher;
  const token = await getAccessToken({
    provider: 'graph',
    slug: cfg.account_slug,
    providerConfig: requireProviderConfig(opts.providerConfig),
    accountStore: opts.accountStore,
    fetcher,
    now: opts.now,
  });
  const res = await fetcher(`${GRAPH_API_BASE}/me/calendars?$top=1`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw toAdapterError(res.status, body, 'calendars.list (probe)');
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

export const createGraphCalAdapterFactory = (
  opts: CreateGraphCalAdapterFactoryOptions,
): CalendarAdapterFactory => ({
  kind: 'graph',
  async probeCaps(ctx: CalendarAdapterContext) {
    const cfg = parseGraphCalConfig(ctx.config);
    return probeGraphCalCaps(cfg, opts);
  },
  create(ctx: CalendarAdapterContext): CalendarProvider {
    const cfg = parseGraphCalConfig(ctx.config);
    return createGraphCalProvider({
      slug: ctx.slug,
      config: cfg,
      accountStore: opts.accountStore,
      providerConfig: opts.providerConfig,
      fetcher: opts.fetcher,
      now: opts.now,
      log: opts.log ?? ctx.log,
      scheduler: opts.scheduler,
    });
  },
});

// ────────────────────────────────────────────────────────────────
// Shipped OAuth client config
// ────────────────────────────────────────────────────────────────

/** Graph calendar's token endpoint — a PROTOCOL constant, not a credential.
 *
 *  This used to be `GRAPH_CAL_OAUTH_CONFIG`, which deliberately SHARED the
 *  `RECUED_GRAPH_*` env pair with the mail adapter so one Graph registration
 *  covered both surfaces via scope-differentiated consents. That sharing now
 *  happens properly: both read the same `OAuthAppConfigStore` record under
 *  issuer `microsoft`. The env pair was DELETED (2026-07-28). */
export const GRAPH_CAL_TOKEN_URL = MICROSOFT_TOKEN_URL;
