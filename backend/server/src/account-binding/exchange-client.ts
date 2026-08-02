/** D-175 P5 — account-binding exchange client (server → auth Worker).
 *
 *  The server half of the binding protocol exchanges the relayed
 *  binding token with the auth Worker's binding-exchange endpoint. The
 *  Worker verifies the token + account session + nonce + expiry + the
 *  server-identity proof, records account↔server ownership, and returns
 *  the server-scoped account credential.
 *
 *  The Worker endpoint itself is a SEPARATE, later cloud slice
 *  (`apps/auth-worker`, codex-2's). This module is the server-side
 *  CLIENT + the wire contract it speaks; tests inject a mock that
 *  honours the same `AccountBindingExchangeClient` interface (and
 *  really verifies the Ed25519 server-identity proof, so the proof
 *  path is exercised end-to-end without a live Worker).
 *
 *  Failure discipline — every failure mode resolves as a discriminated
 *  `{ ok: false, code }` outcome; the client NEVER throws. A missing
 *  endpoint, a network error, a timeout, and a non-2xx all map onto the
 *  closed `AccountBindingExchangeErrorCode` list so the manager can
 *  audit a single typed reason.
 */

import type {
  AccountBindingExchangeErrorCode,
  AccountBindingExchangeOutcome,
  AccountBindingExchangeRequest,
} from '@recued/contracts';
import { makeBoundedOriginHttpFetcher } from '../bounded-origin-http-fetcher.js';

/** The exchange boundary the binding manager depends on. One method;
 *  the manager builds the request (incl. the server-identity proof) and
 *  branches on the discriminated outcome. */
export interface AccountBindingExchangeClient {
  exchange(
    request: AccountBindingExchangeRequest,
  ): Promise<AccountBindingExchangeOutcome>;
}

/** `fetch`-compatible signature so callers can inject a stub. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface HttpAccountBindingExchangeClientOptions {
  /** Resolve the Worker binding-exchange endpoint URL at call time
   *  (read per-call so a config / env change takes effect without a
   *  reconstruct). Returns undefined / empty when no endpoint is
   *  configured yet — the exchange then resolves `exchange_unavailable`
   *  rather than throwing. The Worker endpoint is a later cloud slice,
   *  so production boots ship this client ahead of the endpoint. */
  getEndpointUrl: () => string | undefined;
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Request timeout (ms). Default 10s. */
  timeoutMs?: number;
  /** Response ceiling (bytes). Defaults to the shared provider API limit. */
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** True iff `v` is a shape-valid exchange success — defends the manager
 *  against a malformed Worker response masquerading as a success
 *  (e.g. a credential-less 200). The OPTIONAL fields are validated too:
 *  a present-but-wrong-typed `publisher_handle` / `credential_expires_at`
 *  fails the guard (→ `internal`) rather than being stored + surfaced
 *  through `account.bindingStatus` with the wrong type, which would
 *  break the published contract for clients. */
const isShapeValidSuccess = (v: Record<string, unknown>): boolean =>
  v.ok === true &&
  typeof v.account_id === 'string' &&
  v.account_id.length > 0 &&
  typeof v.server_scoped_credential === 'string' &&
  v.server_scoped_credential.length > 0 &&
  typeof v.credential_issued_at === 'number' &&
  (v.publisher_handle === undefined || typeof v.publisher_handle === 'string') &&
  (v.credential_expires_at === undefined ||
    typeof v.credential_expires_at === 'number');

/** True iff `v` is a shape-valid rebind-conflict outcome — the Worker's
 *  "this would displace a different owner; confirm to proceed" response,
 *  which carries no credential and must NOT be mistaken for a hard
 *  failure (the manager surfaces it as an rpc `conflict`). */
const isShapeValidConflict = (v: Record<string, unknown>): boolean => {
  if (v.conflict !== true) return false;
  const owner = v.current_owner as Record<string, unknown> | undefined;
  const incoming = v.incoming as Record<string, unknown> | undefined;
  return (
    !!owner &&
    typeof owner.account_id === 'string' &&
    !!incoming &&
    typeof incoming.account_id === 'string'
  );
};

const CLOSED_ERROR_CODES = new Set([
  'token_expired',
  'token_invalid',
  'nonce_reused',
  'proof_invalid',
  'server_identity_mismatch',
  'account_not_authenticated',
  'exchange_unavailable',
  'internal',
]);

/** Coerce an arbitrary Worker error body into the closed error-code
 *  set; anything off-list collapses to `internal`. */
const normalizeErrorCode = (
  v: Record<string, unknown>,
): AccountBindingExchangeOutcome => {
  const code: AccountBindingExchangeErrorCode =
    typeof v.code === 'string' && CLOSED_ERROR_CODES.has(v.code)
      ? (v.code as AccountBindingExchangeErrorCode)
      : 'internal';
  return {
    ok: false,
    code,
    ...(typeof v.message === 'string' ? { message: v.message } : {}),
  };
};

/** Build the production HTTP-backed exchange client. */
export const createHttpAccountBindingExchangeClient = (
  options: HttpAccountBindingExchangeClientOptions,
): AccountBindingExchangeClient => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: FetchLike =
    options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const fetchExchange = makeBoundedOriginHttpFetcher({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    timeoutMs,
    ...(options.maxResponseBytes !== undefined
      ? { maxResponseBytes: options.maxResponseBytes }
      : {}),
  });

  return {
    async exchange(request) {
      const url = options.getEndpointUrl();
      if (!url) {
        return {
          ok: false,
          code: 'exchange_unavailable',
          message: 'no account-binding exchange endpoint configured',
        };
      }
      if (!fetchImpl) {
        return {
          ok: false,
          code: 'exchange_unavailable',
          message: 'no fetch implementation available',
        };
      }

      let status: number;
      let body: unknown;
      try {
        const res = await fetchExchange(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
        status = res.status;
        try {
          body = await res.json();
        } catch {
          // Unparseable body — treat per status below.
          body = undefined;
        }
      } catch (err) {
        const e = err as { name?: string; message?: string };
        return {
          ok: false,
          code: 'exchange_unavailable',
          message:
            e?.name === 'AbortError'
              ? `binding exchange timed out after ${timeoutMs}ms`
              : `binding exchange request failed: ${e?.message ?? 'network error'}`,
        };
      }

      const obj =
        body && typeof body === 'object'
          ? (body as Record<string, unknown>)
          : undefined;

      if (status >= 200 && status < 300 && obj && isShapeValidSuccess(obj)) {
        return obj as unknown as AccountBindingExchangeOutcome;
      }
      // The rebind-conflict outcome rides `ok: false` + `conflict: true`;
      // pass it through verbatim (it carries no credential + is not a
      // hard failure) once shape-validated.
      if (obj && obj.ok === false && obj.conflict === true && isShapeValidConflict(obj)) {
        return obj as unknown as AccountBindingExchangeOutcome;
      }
      // A `{ ok: false, code }` error body (any status) maps through the
      // closed-code normalizer; a 2xx that isn't a shape-valid success /
      // conflict is treated as a malformed Worker response (`internal`).
      if (obj && obj.ok === false) {
        return normalizeErrorCode(obj);
      }
      return {
        ok: false,
        code: 'internal',
        message: `unexpected binding exchange response (status ${status})`,
      };
    },
  };
};
