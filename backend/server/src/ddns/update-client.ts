/** D-148 § A.5.2 — server-side cloud client for `POST /v1/ddns/update`.
 *
 *  Signs a canonical-JSON payload (`{ publisher_id, handle, ip_v4,
 *  ip_v6?, timestamp }`) with the `server_identity_key` and POSTs to
 *  the cloud DDNS update API. The cloud verifies the signature
 *  against the publisher's pinned public key (registered at Pro
 *  subscription start), checks a 5-minute replay window, and updates
 *  the DNS record for `<handle>.recued.cloud`. The post itself is
 *  the heartbeat side-effect that records `last_seen_at` per
 *  publisher (D-088 Go heartbeat retired per § A.14).
 *
 *  Errors map onto the closed `DdnsErrorCode` union when the cloud
 *  responds with the documented envelope. Network / parse failures
 *  collapse to `'network_error'` with the raw message so the poller's
 *  retry loop can log + continue.
 *
 *  No internal retry — the caller (the DDNS update poller) decides
 *  the retry cadence. */

import {
  type DdnsUpdateRequest,
  type DdnsUpdateResponse,
  type DdnsErrorCode,
  type DdnsPauseRequest,
  type DdnsPauseResponse,
  type DdnsPauseErrorCode,
} from '@recued/contracts';
import { canonicalJSONStringify } from '@recued/crypto';
import {
  makeBoundedOriginHttpFetcher,
  type BoundedHttpFetcher,
} from '../bounded-origin-http-fetcher.js';

export type DdnsUpdateResult =
  | { ok: true; data: DdnsUpdateResponse }
  | { ok: false; error: DdnsErrorCode | 'network_error'; message?: string };

/** R27 delta-B — result of the signed `POST /v1/ddns/pause` call. */
export type DdnsPauseResult =
  | { ok: true; data: DdnsPauseResponse }
  | { ok: false; error: DdnsPauseErrorCode | 'network_error'; message?: string };

export interface DdnsUpdateClient {
  update(args: DdnsUpdateClientArgs): Promise<DdnsUpdateResult>;
  /** R27 delta-B — pause (`paused: true`) or resume (`false`) the handle's
   *  DDNS publication. Same signing identity + cloud as `update`. */
  pause(args: DdnsPauseClientArgs): Promise<DdnsPauseResult>;
}

export interface DdnsUpdateClientArgs {
  publisher_id: string;
  handle: string;
  ip_v4: string;
  ip_v6?: string;
  /** Unix-ms timestamp; defaults to `Date.now()` if absent. The cloud
   *  rejects timestamps outside `DDNS_UPDATE_REPLAY_WINDOW_MS`. */
  timestamp?: number;
}

export interface DdnsPauseClientArgs {
  publisher_id: string;
  handle: string;
  /** `true` = pause (pull records); `false` = resume (republish if active). */
  paused: boolean;
  /** Unix-ms timestamp; defaults to `Date.now()`. */
  timestamp?: number;
}

export interface DdnsUpdateClientOptions {
  /** Cloud base URL — production `https://api.recued.cloud`. Test /
   *  staging via the `cloud.base_url` runtime-config knob. */
  cloud_base_url: string;
  /** Ed25519 signer (typically `serverIdentity.signWithServerIdentity`).
   *  Returns the base64-encoded signature over the bytes of the
   *  canonical-JSON payload. */
  signPayload: (canonical: string) => string;
  /** Fetch override (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** One deadline spanning headers and body consumption. */
  timeoutMs?: number;
  /** Response ceiling (bytes). Defaults to the shared provider API limit. */
  maxResponseBytes?: number;
}

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

/** Closed list of cloud error codes documented in `cloud-api.ts`. Used as a
 *  runtime guard so an unexpected `error.code` collapses to `'network_error'`
 *  rather than silently propagating.
 *
 *  ⛔⛔⛔ THIS WAS A HAND-WRITTEN `new Set<DdnsErrorCode>([...])` AND IT SILENTLY
 *  DISABLED A FEATURE. Adding a member to the union does NOT force adding it to
 *  a Set literal — the literal is merely assignable — so `ddns_publisher_retired`
 *  was defined in contracts, returned by the cloud, branched on by the poller,
 *  and collapsed to `'network_error'` right here. The stand-down could never
 *  fire, and 8,587 tests were green, because every one of them stubbed the
 *  update client and handed the poller a value this parser can no longer produce.
 *  A stub proves the call, not the message.
 *
 *  🔑 THE `Record` IS THE FIX, NOT THE EXTRA STRING. Every member of the union is
 *  a required key, so the next code added to `DdnsErrorCode` is a compile error
 *  here instead of a quietly dead branch downstream. */
const DDNS_ERROR_CODE_MEMBERS: Record<DdnsErrorCode, true> = {
  ddns_signature_invalid: true,
  ddns_publisher_retired: true,
  ddns_handle_mismatch: true,
  ddns_replay_window_exceeded: true,
  ddns_replay_duplicate: true,
  ddns_subscription_lapsed: true,
  ddns_rate_limited: true,
  ddns_validation_error: true,
};

const DDNS_ERROR_CODES: ReadonlySet<DdnsErrorCode> = new Set(
  Object.keys(DDNS_ERROR_CODE_MEMBERS) as DdnsErrorCode[],
);

const isDdnsErrorCode = (code: unknown): code is DdnsErrorCode =>
  typeof code === 'string' &&
  (DDNS_ERROR_CODES as ReadonlySet<string>).has(code);

/** ⚠ SAME GUARD AS ITS SIBLING ABOVE, AND FOR THE SAME REASON. This list is
 *  currently complete — checked — but it was the identical hand-written Set, so
 *  it carried the identical latent failure: the next `DdnsPauseErrorCode` would
 *  have been defined, returned, branched on, and silently collapsed to
 *  `network_error`. Fixing one and leaving the other is leaving the landmine in
 *  the file you are already standing in. */
const DDNS_PAUSE_ERROR_CODE_MEMBERS: Record<DdnsPauseErrorCode, true> = {
  ddns_pause_validation_error: true,
  ddns_pause_signature_invalid: true,
  ddns_pause_handle_mismatch: true,
  ddns_pause_subscription_lapsed: true,
  ddns_pause_replay_window_exceeded: true,
  ddns_pause_replay_duplicate: true,
  ddns_pause_rate_limited: true,
  ddns_pause_conflict: true,
};

const DDNS_PAUSE_ERROR_CODES: ReadonlySet<DdnsPauseErrorCode> = new Set(
  Object.keys(DDNS_PAUSE_ERROR_CODE_MEMBERS) as DdnsPauseErrorCode[],
);

const isDdnsPauseErrorCode = (code: unknown): code is DdnsPauseErrorCode =>
  typeof code === 'string' &&
  (DDNS_PAUSE_ERROR_CODES as ReadonlySet<string>).has(code);

interface CloudEnvelopeError {
  error?: { code?: string; message?: string };
}

interface CloudEnvelopeData<T> {
  data?: T;
}

export const createDdnsUpdateClient = (
  options: DdnsUpdateClientOptions,
): DdnsUpdateClient => {
  const baseUrl = trimTrailingSlash(options.cloud_base_url);
  const fetchImpl = makeBoundedOriginHttpFetcher({
    ...(options.fetch !== undefined ? { fetchImpl: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxResponseBytes !== undefined
      ? { maxResponseBytes: options.maxResponseBytes }
      : {}),
  });

  const update = async (
    args: DdnsUpdateClientArgs,
  ): Promise<DdnsUpdateResult> => {
    const timestamp = args.timestamp ?? Date.now();

    // Build the signed bytes. **Field-shape contract with the cloud
    // verifier**: `backend/api/src/routes/ddns.ts:148` runs
    // `canonicalJsonBytes({ publisher_id, handle, ip_v4, ip_v6:
    // req.ip_v6 ?? null, timestamp })` — i.e., `ip_v6` is ALWAYS
    // present in the signed bytes (defaulted to `null` when absent
    // from the request body). The server signer must use the same
    // shape or every signature fails with `ddns_signature_invalid`.
    const signedFields = {
      publisher_id: args.publisher_id,
      handle: args.handle,
      ip_v4: args.ip_v4,
      ip_v6: args.ip_v6 ?? null,
      timestamp,
    };
    const canonical = canonicalJSONStringify(signedFields);
    const signature = options.signPayload(canonical);

    // POST body — `ip_v6` is omitted when absent (the cloud's body
    // validator at `isDdnsUpdateRequest` accepts `undefined` but
    // rejects `null` for `ip_v6`; the cloud rebuilds the signed
    // bytes itself via `req.ip_v6 ?? null`, so omitting from the
    // body still produces the matching signed-bytes shape).
    const request: DdnsUpdateRequest = {
      publisher_id: args.publisher_id,
      handle: args.handle,
      ip_v4: args.ip_v4,
      ...(args.ip_v6 !== undefined ? { ip_v6: args.ip_v6 } : {}),
      timestamp,
      signature,
    };

    let response: Awaited<ReturnType<BoundedHttpFetcher>>;
    try {
      response = await fetchImpl(`${baseUrl}/v1/ddns/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch (err) {
      return {
        ok: false,
        error: 'network_error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      return {
        ok: false,
        error: 'network_error',
        message: `parse_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (response.ok) {
      const data = (body as CloudEnvelopeData<DdnsUpdateResponse>).data;
      if (!data) {
        return {
          ok: false,
          error: 'network_error',
          message: 'cloud_envelope_missing_data',
        };
      }
      return { ok: true, data };
    }

    const errBody = body as CloudEnvelopeError;
    const code = errBody.error?.code;
    if (isDdnsErrorCode(code)) {
      return {
        ok: false,
        error: code,
        ...(errBody.error?.message !== undefined
          ? { message: errBody.error.message }
          : {}),
      };
    }

    return {
      ok: false,
      error: 'network_error',
      message: `http_${response.status}: ${errBody.error?.message ?? response.statusText}`,
    };
  };

  const pause = async (
    args: DdnsPauseClientArgs,
  ): Promise<DdnsPauseResult> => {
    const timestamp = args.timestamp ?? Date.now();

    // Signed-bytes shape MUST match the cloud verifier's
    // `computePauseSignedBytes` (`backend/api/src/routes/ddns.ts`):
    // `canonicalJsonBytes({ publisher_id, handle, paused, timestamp })`.
    const signedFields = {
      publisher_id: args.publisher_id,
      handle: args.handle,
      paused: args.paused,
      timestamp,
    };
    const canonical = canonicalJSONStringify(signedFields);
    const signature = options.signPayload(canonical);

    const request: DdnsPauseRequest = {
      publisher_id: args.publisher_id,
      handle: args.handle,
      paused: args.paused,
      timestamp,
      signature,
    };

    let response: Awaited<ReturnType<BoundedHttpFetcher>>;
    try {
      response = await fetchImpl(`${baseUrl}/v1/ddns/pause`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch (err) {
      return {
        ok: false,
        error: 'network_error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      return {
        ok: false,
        error: 'network_error',
        message: `parse_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (response.ok) {
      const data = (body as CloudEnvelopeData<DdnsPauseResponse>).data;
      if (!data) {
        return { ok: false, error: 'network_error', message: 'cloud_envelope_missing_data' };
      }
      return { ok: true, data };
    }

    const errBody = body as CloudEnvelopeError;
    const code = errBody.error?.code;
    if (isDdnsPauseErrorCode(code)) {
      return {
        ok: false,
        error: code,
        ...(errBody.error?.message !== undefined ? { message: errBody.error.message } : {}),
      };
    }

    return {
      ok: false,
      error: 'network_error',
      message: `http_${response.status}: ${errBody.error?.message ?? response.statusText}`,
    };
  };

  return { update, pause };
};
