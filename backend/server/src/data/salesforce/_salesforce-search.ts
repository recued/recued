/** D-130 Phase 2 — Salesforce SOQL search wrapper.
 *
 *  Shared helper across the opportunity / contact / account
 *  reconcilers (P3 + P4 land later). Wraps
 *  `GET <instance_url>/services/data/<API_VERSION>/query?q=<SOQL>`
 *  with:
 *
 *    - Pagination via the response's `nextRecordsUrl` field (Salesforce
 *      returns relative paths; the helper resolves them against
 *      `connection.config.base_url`). Each page yields its records
 *      eagerly so the harness can interrupt on budget exhaustion.
 *    - Caller-built SOQL string. Reconcilers compose `WHERE
 *      LastModifiedDate >= <iso>` filters + `ORDER BY LastModifiedDate
 *      ASC LIMIT <n>` themselves; this helper is pure transport.
 *    - 503 (Salesforce's "Service Unavailable" — emitted under org
 *      concurrency limits) + 429 (less common on Query API but used
 *      under daily-limit pressure) backoff up to a small bounded count,
 *      honoring the `Retry-After` header. Exhausted retries surface as
 *      `SALESFORCE_RATE_LIMITED` so the harness yields cleanly.
 *    - 401 single-shot refresh: on the first 401 within a cycle,
 *      `refreshAuth(connection)` runs through the connection adapter's
 *      existing single-flight refresh path, the helper retries with
 *      the new access token, and then surfaces 401 if it persists.
 *
 *  The helper is pure plumbing: no SQLite, no enrichment-store
 *  interaction. The reconciler's `listUpdatedSince` consumes the
 *  yielded records and runs `hashOf` / `toMeta` against them.
 *
 *  Spec: D-130 § A.3. */

import {
  SALESFORCE_API_VERSION,
  resolveBearerAccessToken,
  type ConnectionAuth,
  type ConnectionRecord,
} from '@recued/contracts';

import { defaultProviderApiFetch } from '../provider-api-fetch.js';
import {
  ProviderPaginationError,
  ProviderPaginationGuard,
  readProviderStringContinuation,
} from '../../provider-pagination-guard.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** A raw Salesforce SObject record from a query response. The
 *  reconciler reads `Id` + per-field values to project meta + compute
 *  the canonical-field hash. Salesforce SOQL returns native types
 *  (strings, numbers, booleans) directly — no string-only convention
 *  like HubSpot's; the helper preserves the shape verbatim. */
export interface RawSalesforceRecord {
  /** Always present — the SObject id (15 or 18 char alphanumeric).
   *  Other fields land per the SELECT list the caller composed. */
  Id: string;
  /** Salesforce stamps an `attributes` envelope on every record (type +
   *  url). The reconciler ignores it. */
  attributes?: { type?: string; url?: string };
  /** Open-ended — caller's SELECT list determines which keys appear. */
  [field: string]: unknown;
}

/** Caller-controlled search options. */
export interface SearchSalesforceObjectsOptions {
  /** Fully-formed SOQL string. The reconciler composes the SELECT
   *  list, the FROM clause, the optional `WHERE LastModifiedDate >=
   *  <iso>` filter, and the `ORDER BY LastModifiedDate ASC LIMIT <n>`
   *  trailer. URL-encoding happens inside the helper. */
  soql: string;
}

/** Injected dependencies. Tests pass stubs; the boot wire passes the
 *  real fetcher + a refresh hook bound to the connection adapter's
 *  single-flight refresh path. */
export interface SalesforceSearchDeps {
  /** HTTP fetcher. Defaults to the server's bounded provider fetch. */
  fetcher?: typeof fetch;
  /** OAuth2 refresh hook — fired on 401. Returns the new
   *  `ConnectionAuth` carrying a fresh `current_access_token`. The
   *  boot wire wires this to the connection adapter's existing
   *  refresh + persist single-flight (D-125 P4.1). */
  refreshAuth: (connection: ConnectionRecord) => Promise<ConnectionAuth>;
  /** Wall-clock for backoff math + Retry-After arithmetic. Defaults
   *  to `Date.now`. */
  now?: () => number;
  /** Sleep — used between rate-limit retries. Defaults to a
   *  `setTimeout` promise. Tests pass a deterministic stub. */
  sleep?: (ms: number) => Promise<void>;
  /** Max rate-limit retries within one page fetch. Defaults to 3.
   *  After the cap, the helper throws `SalesforceRateLimitedError` and
   *  the harness yields the task with `'budget_exhausted'`. */
  rateLimitMaxRetries?: number;
}

// ────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────

/** Thrown when the Salesforce query returns 401 even after a refresh
 *  retry. The harness catches this + yields the task with
 *  `'auth_failed'`; the user surface points to "reconnect Salesforce". */
export class SalesforceAuthExpiredError extends Error {
  readonly code = 'SALESFORCE_AUTH_EXPIRED';
  constructor(connectionName: string) {
    super(`Salesforce auth expired for connection '${connectionName}' — refresh single-flight did not produce a working access token`);
    this.name = 'SalesforceAuthExpiredError';
  }
}

/** Thrown when 503 / 429 retries exhaust. */
export class SalesforceRateLimitedError extends Error {
  readonly code = 'SALESFORCE_RATE_LIMITED';
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Salesforce query rate-limited after retry budget — last Retry-After ${retryAfterMs}ms`);
    this.name = 'SalesforceRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown when Salesforce returns an unexpected non-OK status that
 *  isn't 401 / 429 / 503. Includes the status + body for triage.
 *  Salesforce error bodies are JSON arrays of
 *  `{ message, errorCode }` — preserved as-is in the message. */
export class SalesforceSearchError extends Error {
  readonly code = 'SALESFORCE_SEARCH_ERROR';
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Salesforce query failed: ${status} ${truncateForError(body, 200)}`);
    this.name = 'SalesforceSearchError';
    this.status = status;
  }
}

/** Thrown when `connection.config.base_url` is missing / malformed.
 *  The connection record's `base_url` is set at OAuth completion to
 *  the token-response `instance_url`; a missing base means enrollment
 *  hasn't completed (or the placeholder was never overwritten). */
export class SalesforceMissingBaseUrlError extends Error {
  readonly code = 'SALESFORCE_MISSING_BASE_URL';
  constructor(connectionName: string) {
    super(`Salesforce connection '${connectionName}' has no config.base_url — re-enroll to capture the instance_url`);
    this.name = 'SalesforceMissingBaseUrlError';
  }
}

// ────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────

/** Walk every record in the SOQL result set, following Salesforce's
 *  `nextRecordsUrl` chain across pages. Yields raw records — the
 *  reconciler is responsible for hashing + meta projection. */
export async function* searchSalesforceObjects(
  connection: ConnectionRecord,
  options: SearchSalesforceObjectsOptions,
  deps: SalesforceSearchDeps,
): AsyncGenerator<RawSalesforceRecord, void, unknown> {
  const fetcher = deps.fetcher ?? defaultProviderApiFetch;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const rateLimitMaxRetries = deps.rateLimitMaxRetries ?? 3;

  const baseUrl = readBaseUrl(connection);
  let auth = connection.auth;
  let nextPath: string | null = buildInitialQueryPath(options.soql);
  let authRefreshed = false;
  const pagination = new ProviderPaginationGuard('Salesforce query');

  while (nextPath !== null) {
    const url = `${baseUrl}${pagination.claim(nextPath)}`;
    let attempt = 0;
    let page: SalesforceQueryPage | null = null;

    while (page === null) {
      const accessToken = readAccessToken(auth, connection.name);
      const response = await fetcher(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });

      if (response.ok) {
        page = (await response.json()) as SalesforceQueryPage;
        break;
      }

      // 401 → single refresh attempt within this cycle.
      if (response.status === 401) {
        if (authRefreshed) {
          throw new SalesforceAuthExpiredError(connection.name);
        }
        authRefreshed = true;
        auth = await deps.refreshAuth(connection);
        continue;
      }

      // 429 + 503 → backoff per Retry-After. Salesforce favors 503 for
      // org concurrency limits + 429 for daily-quota pressure; treat
      // both as transient.
      if (response.status === 429 || response.status === 503) {
        const retryAfterMs = parseRetryAfterMs(response, now);
        if (attempt >= rateLimitMaxRetries) {
          throw new SalesforceRateLimitedError(retryAfterMs);
        }
        attempt += 1;
        await sleep(retryAfterMs);
        continue;
      }

      const errBody = await safeReadText(response);
      throw new SalesforceSearchError(response.status, errBody);
    }

    for (const record of page.records ?? []) {
      yield record;
    }

    if (page.done === true) return;
    const next = readProviderStringContinuation(
      page.nextRecordsUrl,
      'Salesforce query',
    );
    if (next !== undefined) {
      nextPath = next;
      continue;
    }
    if (page.done === false) {
      throw new ProviderPaginationError(
        'Salesforce query pagination reported done=false without a continuation',
      );
    }
    return;
  }
}

// ────────────────────────────────────────────────────────────────
// Salesforce wire shapes
// ────────────────────────────────────────────────────────────────

interface SalesforceQueryPage {
  totalSize?: number;
  done?: boolean;
  records?: ReadonlyArray<RawSalesforceRecord>;
  nextRecordsUrl?: unknown;
}

const buildInitialQueryPath = (soql: string): string =>
  `/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`;

const readBaseUrl = (connection: ConnectionRecord): string => {
  const base = connection.config.base_url;
  if (typeof base !== 'string' || base.length === 0) {
    throw new SalesforceMissingBaseUrlError(connection.name);
  }
  return base.endsWith('/') ? base.slice(0, -1) : base;
};

// Auth-type-agnostic: the connection layer's `resolveBearerAccessToken`
// yields the bearer token for an `oauth2_refresh` access token AND a static
// `bearer` (a long-lived session token / Connected-App bearer paired with
// `config.base_url`). The instance host stays a separate concern (base_url).
const readAccessToken = (auth: ConnectionAuth, connectionName: string): string => {
  const token = resolveBearerAccessToken(auth);
  if (token === undefined) throw new SalesforceAuthExpiredError(connectionName);
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
    // RFC 7231: delta-seconds variant.
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
