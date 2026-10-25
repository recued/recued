/** D-175 — the server's Disconnect, told to recued.com (server → auth Worker,
 *  `POST /v1/account/binding/release`).
 *
 *  ⛔ `account.unbind` used to clear only the server's own copy of its
 *  binding. recued.com still listed the server under the account, kept its Pro
 *  authority and kept the handle anchored to it — and with the credential
 *  gone, the server could never tell it otherwise. The manager now releases
 *  with the credential BEFORE it forgets it.
 *
 *  Failure discipline — like the exchange client, this NEVER throws: every
 *  failure (no endpoint, a network error, a timeout, a non-2xx, an older
 *  Worker without the route, a malformed body) resolves `not_told`, and the
 *  manager forgets its copy anyway. Disconnect is the owner's call, not the
 *  cloud's. */

import type { AccountUnbindCloudOutcome } from '@recued/contracts';
import { makeBoundedOriginHttpFetcher } from '../bounded-origin-http-fetcher.js';
import type { FetchLike } from './exchange-client.js';

export interface AccountBindingReleaseRequest {
  server_scoped_credential: string;
  server_fingerprint: string;
}

/** The release boundary the binding manager depends on (HTTP in production;
 *  a stub in tests). */
export interface AccountBindingReleaseClient {
  release(request: AccountBindingReleaseRequest): Promise<AccountUnbindCloudOutcome>;
}

export interface HttpAccountBindingReleaseClientOptions {
  /** Resolve the Worker release endpoint per call (see `exchange-url.ts`).
   *  Undefined, empty or throwing resolves `not_told`. */
  getEndpointUrl: () => string | undefined;
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Request timeout (ms). Default 10s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Build the production HTTP-backed release client. */
export const createHttpAccountBindingReleaseClient = (
  options: HttpAccountBindingReleaseClientOptions,
): AccountBindingReleaseClient => {
  const fetchImpl: FetchLike =
    options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const fetchRelease = makeBoundedOriginHttpFetcher({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // The body carries the credential: never re-send it to wherever a
    // redirect points.
    redirectPolicy: 'error',
  });

  return {
    async release(request) {
      try {
        const url = options.getEndpointUrl();
        if (!url || !fetchImpl) return 'not_told';
        const res = await fetchRelease(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
        if (res.status < 200 || res.status >= 300) return 'not_told';
        const body = (await res.json()) as { ok?: unknown; outcome?: unknown } | null;
        if (body?.ok !== true) return 'not_told';
        if (body.outcome === 'unbound') return 'released';
        if (body.outcome === 'not_bound') return 'not_listed';
        return 'not_told';
      } catch {
        return 'not_told';
      }
    },
  };
};
