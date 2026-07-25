/** D-129 Phase 2 — HubSpot search wrapper.
 *
 *  Shared helper across the deal/contact/company reconcilers. Wraps
 *  `POST /crm/v3/objects/<type>/search` with:
 *
 *    - Pagination via `after` cursor on `paging.next.after` until the
 *      response stops returning one. Each page yields its results
 *      eagerly so the harness can interrupt on budget exhaustion.
 *    - `hs_lastmodifieddate >= cursor_ms` filter when `modifiedSince`
 *      is non-zero — first run skips the filter to walk every record.
 *    - `properties` projection — caller passes the canonical property
 *      list (`HUBSPOT_DEAL_PROPERTIES` / contact / company at P3-P4).
 *    - 429 retry-with-backoff up to a small bounded count, honoring
 *      the HubSpot `Retry-After` header (seconds). Exhausted retries
 *      surface as `HUBSPOT_RATE_LIMITED` so the harness yields cleanly.
 *    - 401 single-shot refresh: on the first 401 within a cycle,
 *      `refreshAuth(connection)` runs through the connection adapter's
 *      existing single-flight refresh path, the helper retries with
 *      the new access token, and then surfaces 401 if it persists.
 *
 *  The helper is pure plumbing: no SQLite, no enrichment-store
 *  interaction. The reconciler's `listUpdatedSince` consumes the
 *  yielded records and runs `hashOf` / `toMeta` against them.
 *
 *  Spec: D-129 § A.3. */

import {
  HUBSPOT_API_BASE,
  resolveBearerAccessToken,
  type ConnectionAuth,
  type ConnectionRecord,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** HubSpot object types this helper supports. The set widens with the
 *  P3 contact reconciler (`'contacts'`) and P4 company reconciler
 *  (`'companies'`). D-139 P1a.1 widens to `'emails'` for the
 *  HubSpot email engagement reconciler — the search helper's
 *  `hs_lastmodifieddate` cursor + 429 backoff + 401 refresh logic
 *  apply uniformly. */
export type HubSpotObjectType =
  | 'deals'
  | 'contacts'
  | 'companies'
  | 'emails'
  | 'meetings'
  | 'notes'
  | 'calls'
  | 'tasks';

/** A raw record from the HubSpot search response. The reconciler
 *  reads `id` + `properties.<field>` to project meta + compute the
 *  canonical-field hash. The shape matches what HubSpot returns —
 *  property values are always strings (HubSpot serialises numbers /
 *  dates as strings; the reconciler's `toMeta` parses where needed). */
export interface RawHubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
}

/** Caller-controlled search options. */
export interface SearchHubSpotObjectsOptions {
  objectType: HubSpotObjectType;
  /** Property names to request — projected into the HubSpot search
   *  response's `properties` object. The reconciler's canonical field
   *  set lives in `@recued/contracts` (`HUBSPOT_DEAL_PROPERTIES`, etc.). */
  properties: ReadonlyArray<string>;
  /** Unix-ms — only records with `hs_lastmodifieddate >= modifiedSince`
   *  are returned. `0` walks every record (first run). */
  modifiedSince: number;
  /** Per-page limit. HubSpot caps at 100; the helper passes through
   *  the caller's value but never exceeds 100. The harness uses
   *  `PLATFORM_REFERENCE_BATCH_SIZE` (200) — the helper splits across
   *  multiple pages when that's higher than 100. */
  limit: number;
}

/** Injected dependencies. Tests pass stubs; the boot wire passes the
 *  real fetcher + a refresh hook bound to the connection adapter's
 *  single-flight refresh path. */
export interface HubSpotSearchDeps {
  /** HTTP fetcher. Defaults to `globalThis.fetch` when omitted. */
  fetcher?: typeof fetch;
  /** OAuth2 refresh hook — fired on 401. Returns the new
   *  `ConnectionAuth` carrying a fresh `current_access_token`. The
   *  boot wire wires this to the connection adapter's existing
   *  refresh + persist single-flight (D-125 P4.1). */
  refreshAuth: (connection: ConnectionRecord) => Promise<ConnectionAuth>;
  /** Wall-clock for backoff math + Retry-After arithmetic. Defaults
   *  to `Date.now`. */
  now?: () => number;
  /** Sleep — used between 429 retries. Defaults to a `setTimeout`
   *  promise. Tests pass a deterministic stub. */
  sleep?: (ms: number) => Promise<void>;
  /** Max 429 retries within one page fetch. Defaults to 3. After the
   *  cap, the helper throws `HubSpotRateLimitedError` and the harness
   *  yields the task with `'budget_exhausted'`. */
  rateLimitMaxRetries?: number;
}

// ────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────

/** Thrown when the HubSpot search returns 401 even after a refresh
 *  retry. The harness catches this + yields the task with
 *  `'auth_failed'`; the user surface points to "reconnect HubSpot". */
export class HubSpotAuthExpiredError extends Error {
  readonly code = 'HUBSPOT_AUTH_EXPIRED';
  constructor(connectionName: string) {
    super(`HubSpot auth expired for connection '${connectionName}' — refresh single-flight did not produce a working access token`);
    this.name = 'HubSpotAuthExpiredError';
  }
}

/** Thrown when 429 retries exhaust. */
export class HubSpotRateLimitedError extends Error {
  readonly code = 'HUBSPOT_RATE_LIMITED';
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`HubSpot search rate-limited after retry budget — last Retry-After ${retryAfterMs}ms`);
    this.name = 'HubSpotRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown when HubSpot returns an unexpected non-OK status that isn't
 *  401 / 429. Includes the status + body for triage. */
export class HubSpotSearchError extends Error {
  readonly code = 'HUBSPOT_SEARCH_ERROR';
  readonly status: number;
  constructor(status: number, body: string) {
    super(`HubSpot search failed: ${status} ${truncateForError(body, 200)}`);
    this.name = 'HubSpotSearchError';
    this.status = status;
  }
}

// ────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────

/** Walk every record matching `modifiedSince` across paginated search
 *  responses. Yields slim raw records — the reconciler is responsible
 *  for hashing + meta projection. */
export async function* searchHubSpotObjects(
  connection: ConnectionRecord,
  options: SearchHubSpotObjectsOptions,
  deps: HubSpotSearchDeps,
): AsyncGenerator<RawHubSpotRecord, void, unknown> {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const rateLimitMaxRetries = deps.rateLimitMaxRetries ?? 3;

  let auth = connection.auth;
  let cursor: string | undefined;
  let authRefreshed = false;

  for (;;) {
    const body = buildSearchBody(options, cursor);
    let attempt = 0;
    let page: HubSpotSearchPage | null = null;

    while (page === null) {
      const accessToken = readAccessToken(auth, connection.name);
      const response = await fetcher(searchUrl(options.objectType), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        page = (await response.json()) as HubSpotSearchPage;
        break;
      }

      // 401 → single refresh attempt within this cycle.
      if (response.status === 401) {
        if (authRefreshed) {
          throw new HubSpotAuthExpiredError(connection.name);
        }
        authRefreshed = true;
        auth = await deps.refreshAuth(connection);
        continue;
      }

      // 429 → backoff per Retry-After (seconds).
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response, now);
        if (attempt >= rateLimitMaxRetries) {
          throw new HubSpotRateLimitedError(retryAfterMs);
        }
        attempt += 1;
        await sleep(retryAfterMs);
        continue;
      }

      const errBody = await safeReadText(response);
      throw new HubSpotSearchError(response.status, errBody);
    }

    for (const record of page.results ?? []) {
      yield record;
    }

    const next = page.paging?.next?.after;
    if (next === undefined || next === null || next === '') return;
    cursor = next;
  }
}

// ────────────────────────────────────────────────────────────────
// HubSpot wire shapes
// ────────────────────────────────────────────────────────────────

interface HubSpotSearchPage {
  results?: ReadonlyArray<RawHubSpotRecord>;
  paging?: {
    next?: {
      after?: string;
    };
  };
}

const searchUrl = (objectType: HubSpotObjectType): string =>
  `${HUBSPOT_API_BASE}/crm/v3/objects/${objectType}/search`;

const buildSearchBody = (
  options: SearchHubSpotObjectsOptions,
  cursor: string | undefined,
): Record<string, unknown> => {
  const limit = Math.min(options.limit, 100);
  const body: Record<string, unknown> = {
    properties: [...options.properties],
    limit,
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
  };
  if (options.modifiedSince > 0) {
    body.filterGroups = [
      {
        filters: [
          {
            propertyName: 'hs_lastmodifieddate',
            operator: 'GTE',
            value: String(options.modifiedSince),
          },
        ],
      },
    ];
  }
  if (cursor !== undefined) body.after = cursor;
  return body;
};

// Auth-type-agnostic: the connection layer's `resolveBearerAccessToken`
// yields the bearer token for BOTH a refreshable `oauth2_refresh` access
// token AND a static `bearer` (a HubSpot Service Key — the recommended
// data-integration credential). Absent ⇒ this vendor authenticates only by
// bearer, so surface the expired/invalid-auth error.
const readAccessToken = (auth: ConnectionAuth, connectionName: string): string => {
  const token = resolveBearerAccessToken(auth);
  if (token === undefined) throw new HubSpotAuthExpiredError(connectionName);
  return token;
};

const parseRetryAfterMs = (
  response: Response,
  now: () => number,
): number => {
  const header = response.headers.get('Retry-After');
  if (header === null) return 1_000;
  const asInt = Number(header);
  if (Number.isFinite(asInt) && asInt >= 0) {
    // HubSpot uses seconds.
    return Math.min(asInt * 1_000, 60_000);
  }
  // RFC 7231: HTTP-date variant. Interpret as absolute time.
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    return Math.max(0, Math.min(asDate - now(), 60_000));
  }
  return 1_000;
};

const safeReadText = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return '';
  }
};

const truncateForError = (text: string, max: number): string => {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ────────────────────────────────────────────────────────────────
// Single-record GET — D-129 P5
// ────────────────────────────────────────────────────────────────

/** D-129 P5 — fetch one HubSpot object by platform-native id via
 *  `GET /crm/v3/objects/<type>/<objectId>?properties=<csv>`. The
 *  webhook processor uses this on `*.creation` / `*.propertyChange`
 *  events because HubSpot's webhook payload doesn't carry full
 *  record fields — one HTTP hit per delivery materializes the slim
 *  record so the funnel can run `hashOf` + `toMeta` against the
 *  result.
 *
 *  Returns null on HTTP 404 (record was deleted between webhook
 *  fire-time and follow-up GET). Other transient failures surface as
 *  the same typed errors the search helper throws (401 + `auth_-
 *  expired`, 429 + `rate_limited`, otherwise `search_error`) so
 *  callers can route to the harness's yield paths uniformly. */
export const getHubSpotObject = async (
  connection: ConnectionRecord,
  objectType: HubSpotObjectType,
  objectId: string,
  properties: ReadonlyArray<string>,
  deps: HubSpotSearchDeps,
): Promise<RawHubSpotRecord | null> => {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const rateLimitMaxRetries = deps.rateLimitMaxRetries ?? 3;

  let auth = connection.auth;
  let authRefreshed = false;
  let attempt = 0;

  for (;;) {
    const accessToken = readAccessToken(auth, connection.name);
    const url = `${HUBSPOT_API_BASE}/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}?properties=${properties.map(encodeURIComponent).join(',')}`;
    const response = await fetcher(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (response.ok) {
      return (await response.json()) as RawHubSpotRecord;
    }

    if (response.status === 404) return null;

    // 401 → single refresh attempt within this call.
    if (response.status === 401) {
      if (authRefreshed) throw new HubSpotAuthExpiredError(connection.name);
      authRefreshed = true;
      auth = await deps.refreshAuth(connection);
      continue;
    }

    // 429 → backoff per Retry-After (seconds).
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response, now);
      if (attempt >= rateLimitMaxRetries) {
        throw new HubSpotRateLimitedError(retryAfterMs);
      }
      attempt += 1;
      await sleep(retryAfterMs);
      continue;
    }

    const errBody = await safeReadText(response);
    throw new HubSpotSearchError(response.status, errBody);
  }
};

// ────────────────────────────────────────────────────────────────
// Single-record associations GET — D-139 P1a.1.1
// ────────────────────────────────────────────────────────────────

/** D-139 § A.4 — fetch the current association list for one
 *  engagement (or any other CRM record) keyed by `(fromObjectType,
 *  fromObjectId, toObjectType)` via
 *  `GET /crm/v3/objects/<from>/<id>/associations/<to>`.
 *
 *  Used by the engagement reconcilers + the per-cycle association-
 *  rescan sweep + the new edge-only webhook write path. Email-header
 *  participants tell us *who was on the email*; the CRM's own
 *  `/associations/` list tells us *what the user actually associated*
 *  — the latter is the source of truth for engagement→deal and
 *  engagement→account edges. Header-derived contact emails tend to
 *  over-count (a salesperson BCCing the HubSpot log address pulls in
 *  the rep + every prospect); the CRM-side associations list reflects
 *  the user's actual intent.
 *
 *  Returns the raw association ids verbatim — callers wrap them in
 *  the `<vendor>_<entity>_<id>` target_id shape per § A.4 (e.g.
 *  `hubspot_deal_47291`). The HubSpot v3 association response wraps
 *  ids on `results[].toObjectId` (typed as `number` in v3); the
 *  helper coerces to string for the substrate's string-keyed edge
 *  table.
 *
 *  Pagination: yes — `/associations/` returns paginated results with
 *  the same `paging.next.after` cursor shape as `/search`. The helper
 *  walks every page until exhausted. HubSpot's per-association limit
 *  ranges from 100 to 500 depending on `version=v3` vs `v4` + the
 *  endpoint variant; the v3 endpoint defaults to a server-side cap
 *  that the helper passes through.
 *
 *  Errors: same surface as the search helper (401 + refresh, 429 +
 *  backoff, 404 returns null, others throw `HubSpotSearchError`).
 *
 *  Spec: D-139 § A.4, § A.6.3. */
/** D-139 P1a.1.1 (Codex P2 #1 fold-back) — result of an associations
 *  list-walk. `ids` are the platform-native ids (without
 *  `<vendor>_<entity>_` prefix); `pages_fetched` is the actual page
 *  count consumed (counts against the daily token budget at
 *  § A.6.2); `next_cursor` carries the unwalked tail when the caller
 *  sets `page_cap` and the walk hits it. `null` on a 404 from the
 *  FROM record. */
export interface ListHubSpotAssociationsResult {
  ids: ReadonlyArray<string>;
  pages_fetched: number;
  next_cursor: string | null;
}

export const listHubSpotAssociations = async (
  connection: ConnectionRecord,
  fromObjectType: HubSpotObjectType,
  fromObjectId: string,
  toObjectType: HubSpotObjectType | 'companies' | 'contacts' | 'deals',
  deps: HubSpotSearchDeps,
  options: { page_cap?: number; cursor?: string } = {},
): Promise<ListHubSpotAssociationsResult | null> => {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const rateLimitMaxRetries = deps.rateLimitMaxRetries ?? 3;

  let auth = connection.auth;
  let authRefreshed = false;
  let cursor: string | undefined = options.cursor;
  const pageCap = options.page_cap ?? Infinity;
  const ids: string[] = [];
  let pages_fetched = 0;

  for (;;) {
    let attempt = 0;
    let page: HubSpotAssociationsPage | null = null;

    while (page === null) {
      const accessToken = readAccessToken(auth, connection.name);
      const url =
        `${HUBSPOT_API_BASE}/crm/v3/objects/${fromObjectType}/${encodeURIComponent(fromObjectId)}` +
        `/associations/${toObjectType}` +
        (cursor !== undefined ? `?after=${encodeURIComponent(cursor)}` : '');
      const response = await fetcher(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });

      if (response.ok) {
        page = (await response.json()) as HubSpotAssociationsPage;
        break;
      }

      // 404 on the FROM object — record was deleted between webhook
      // fire-time and follow-up GET. Surface as null so callers can
      // tombstone the engagement; same posture as `getHubSpotObject`.
      // 404 here is asymmetric with `searchHubSpotObjects` (which
      // doesn't 404) but matches `getHubSpotObject`'s contract.
      if (response.status === 404) return null;

      if (response.status === 401) {
        if (authRefreshed) throw new HubSpotAuthExpiredError(connection.name);
        authRefreshed = true;
        auth = await deps.refreshAuth(connection);
        continue;
      }

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response, now);
        if (attempt >= rateLimitMaxRetries) {
          throw new HubSpotRateLimitedError(retryAfterMs);
        }
        attempt += 1;
        await sleep(retryAfterMs);
        continue;
      }

      const errBody = await safeReadText(response);
      throw new HubSpotSearchError(response.status, errBody);
    }

    pages_fetched += 1;
    for (const result of page.results ?? []) {
      const raw = result.toObjectId ?? result.id;
      if (raw === undefined || raw === null) continue;
      ids.push(String(raw));
    }

    const next = page.paging?.next?.after;
    if (next === undefined || next === null || next === '') {
      return { ids, pages_fetched, next_cursor: null };
    }
    if (pages_fetched >= pageCap) {
      return { ids, pages_fetched, next_cursor: next };
    }
    cursor = next;
  }
};

interface HubSpotAssociationsPage {
  results?: ReadonlyArray<{
    /** Present in v3 association responses. */
    toObjectId?: string | number;
    /** Older portals + v4 nested shape — kept as a fallback. */
    id?: string | number;
  }>;
  paging?: {
    next?: {
      after?: string;
    };
  };
}
