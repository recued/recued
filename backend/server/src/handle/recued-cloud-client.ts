/** D-148 § A.5.6 — production HTTP `CloudHandleClient` binding.
 *
 *  Server-side counterpart to the four cloud handle endpoints
 *  registered on the sync-worker (`backend/api/src/sync-worker.ts`):
 *
 *    - `POST /v1/ddns/handle/reserve`
 *    - `POST /v1/ddns/handle/change`
 *    - `POST /v1/ddns/handle/transfer`
 *    - `POST /v1/ddns/handle/abuse-report`
 *
 *  All four requests are pre-signed by the state machine (the substrate
 *  in `./index.ts` covers payload shape + Ed25519 signing). This module
 *  is the thin HTTP layer: it POSTs the canonical JSON body, parses the
 *  shared `{ data | error, meta }` envelope (see
 *  `backend/api/src/shared/response.ts`), and re-projects into the
 *  `CloudHandleResult<T>` shape the state machine consumes.
 *
 *  Error mapping. The cloud helper emits the `HandleRpcErrorCode` value
 *  directly in `error.code` for the four authoritative failure surfaces
 *  (validation / replay / rate-limit / signature / lifecycle). Any code
 *  outside `HandleRpcErrorCode` (`SERVER_ERROR`, `METHOD_NOT_ALLOWED`,
 *  network failures) collapses to `handle_validation_error` with the
 *  raw server text in `message` — that bucket gets the most useful
 *  operator surface in Settings → Handle, and the state machine treats
 *  the call as failed without crashing.
 *
 *  No retries. The state machine is the caller; user-facing rpc handles
 *  surface the result directly. Background-cycle callers (housekeeping
 *  / Reachability Doctor) decide their own retry cadence. */

import {
  HANDLE_RPC_ERROR_CODES,
  type HandleAbuseReportRequest,
  type HandleAbuseReportResponse,
  type HandleChangeRequest,
  type HandleChangeResponse,
  type HandleReserveRequest,
  type HandleReserveResponse,
  type HandleRpcErrorCode,
  type HandleTransferRequest,
  type HandleTransferResponse,
} from '@recued/contracts';

import type { CloudHandleClient, CloudHandleResult } from './index.js';

/** Codex P3 fold — runtime guard at the HTTP boundary. Sources from
 *  the contracts closed-list (`HANDLE_RPC_ERROR_CODES`) so a new code
 *  added to the `HandleRpcErrorCode` union extends this set in lockstep
 *  via the contracts-side ratchet test, rather than silently collapsing
 *  to `handle_validation_error` here. */
const HANDLE_RPC_ERROR_CODE_SET: ReadonlySet<HandleRpcErrorCode> = new Set<HandleRpcErrorCode>(
  HANDLE_RPC_ERROR_CODES,
);

interface CloudErrorBody {
  error?: { code?: string; message?: string };
}

interface CloudDataBody<T> {
  data?: T;
}

export interface RecuedCloudHandleClientOptions {
  /** Cloud helper base URL — production `https://api.recued.cloud`,
   *  staging / dev via the `cloud.base_url` runtime config knob. */
  cloud_base_url: string;
  /** Optional fetch override (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

const isHandleRpcErrorCode = (code: unknown): code is HandleRpcErrorCode =>
  typeof code === 'string' &&
  (HANDLE_RPC_ERROR_CODE_SET as ReadonlySet<string>).has(code);

const networkFailureResult = <T>(message: string): CloudHandleResult<T> => ({
  ok: false,
  error: 'handle_validation_error',
  message,
});

/** POST one of the four signed handle envelopes + decode the typed
 *  response. Failure paths collapse network / shape / unknown-error
 *  into `handle_validation_error`; codex P8 closed-list correctness is
 *  preserved by the contracts source-of-truth Set. */
const postSignedHandleRequest = async <Req, Res>(
  fetchImpl: typeof fetch,
  url: string,
  body: Req,
): Promise<CloudHandleResult<Res>> => {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return networkFailureResult<Res>(`network: ${detail}`);
  }

  let parsed: CloudDataBody<Res> & CloudErrorBody;
  try {
    parsed = (await res.json()) as CloudDataBody<Res> & CloudErrorBody;
  } catch {
    const text = await res.text().catch(() => '');
    return networkFailureResult<Res>(`malformed response: HTTP ${res.status} ${text}`);
  }

  if (res.ok && parsed.data !== undefined) {
    return { ok: true, data: parsed.data };
  }

  const code = parsed.error?.code;
  const message = parsed.error?.message;
  if (isHandleRpcErrorCode(code)) {
    return { ok: false, error: code, ...(message ? { message } : {}) };
  }
  return networkFailureResult<Res>(
    `HTTP ${res.status} ${code ?? 'UNKNOWN'}: ${message ?? '(no message)'}`,
  );
};

/** Production `CloudHandleClient`. Wires the four handle rpc surfaces
 *  to the cloud helper at `cloud_base_url`. `checkAvailability` is
 *  intentionally omitted — there is no `/v1/ddns/handle/availability`
 *  endpoint today; the interface marks the method optional so callers
 *  fall back to the local validator's snapshot check. */
export const createRecuedCloudHandleClient = (
  options: RecuedCloudHandleClientOptions,
): CloudHandleClient => {
  const fetchImpl = options.fetch ?? fetch;
  const base = trimTrailingSlash(options.cloud_base_url);

  return {
    async reserveHandle(req: HandleReserveRequest) {
      return postSignedHandleRequest<HandleReserveRequest, HandleReserveResponse>(
        fetchImpl,
        `${base}/v1/ddns/handle/reserve`,
        req,
      );
    },
    async changeHandle(req: HandleChangeRequest) {
      return postSignedHandleRequest<HandleChangeRequest, HandleChangeResponse>(
        fetchImpl,
        `${base}/v1/ddns/handle/change`,
        req,
      );
    },
    async transferHandle(req: HandleTransferRequest) {
      return postSignedHandleRequest<HandleTransferRequest, HandleTransferResponse>(
        fetchImpl,
        `${base}/v1/ddns/handle/transfer`,
        req,
      );
    },
    async abuseReport(req: HandleAbuseReportRequest) {
      return postSignedHandleRequest<
        HandleAbuseReportRequest,
        HandleAbuseReportResponse
      >(fetchImpl, `${base}/v1/ddns/handle/abuse-report`, req);
    },
  };
};
