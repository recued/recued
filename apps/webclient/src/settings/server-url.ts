/** D-148 § A.4 + § A.6 + § A.6.5 — server URL editor.
 *
 *  When the user changes the server URL, the webclient:
 *
 *   1. Validates the URL shape (`wss://` for production; `ws://` only
 *      under a sentinel-allowed flag for local dev).
 *   2. Probes the server's TLS cert + computes its fingerprint.
 *   3. Compares against the pinned `WebclientCertPinState`. Match
 *      on `current_fingerprint` OR `next_fingerprint` (rotation
 *      overlap window) → accept; mismatch → reject + render
 *      `cert_pin_mismatch` error.
 *   4. Writes the new URL into `WebclientLocalStore.set('server_url',
 *      url)` + clears the broadcast cursor (since the new server is
 *      a different cursor space).
 *
 *  This module ships the validators + the fingerprint comparator. The
 *  actual TLS probing (TCP-handshake-level cert fetch) is the
 *  responsibility of the WS transport — the webclient has no raw TLS
 *  surface in-browser, but the server's WS handshake includes the
 *  fingerprint as a signed bundle the webclient can compare.
 */

import type { WebclientCertPinState } from '@recued/contracts';

export type ServerUrlValidation =
  | { ok: true; ws_url: string }
  | { ok: false; error: ServerUrlError };

export type ServerUrlError =
  | 'url_malformed'
  | 'scheme_unsupported'
  | 'host_missing'
  | 'port_invalid';

const MIN_PORT = 1;
const MAX_PORT = 65_535;

/** Validate a server URL submitted via Settings → Server. Returns
 *  the canonicalized `wss://` form on success or a typed error code
 *  the UI maps to a localized string. */
export const validateServerUrl = (
  raw: string,
  options: { allow_insecure_localhost?: boolean } = {},
): ServerUrlValidation => {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'url_malformed' };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'url_malformed' };
  }
  const allow_ws =
    options.allow_insecure_localhost === true &&
    (parsed.hostname === 'localhost' || parsed.hostname.startsWith('127.'));
  if (parsed.protocol === 'wss:' || (allow_ws && parsed.protocol === 'ws:')) {
    if (!parsed.hostname) return { ok: false, error: 'host_missing' };
    if (parsed.port) {
      const port_num = Number(parsed.port);
      if (!Number.isInteger(port_num) || port_num < MIN_PORT || port_num > MAX_PORT) {
        return { ok: false, error: 'port_invalid' };
      }
    }
    return { ok: true, ws_url: parsed.toString() };
  }
  return { ok: false, error: 'scheme_unsupported' };
};

/** Compare an observed cert fingerprint against the pinned state.
 *  Acceptance is a match on `current_fingerprint` OR (during the
 *  rotation overlap window) on `next_fingerprint`. The caller maps
 *  the result to a UI string + audit row. */
export const computeCertFingerprintMatch = (
  observed_fingerprint: string,
  pin_state: WebclientCertPinState | null,
):
  | { match: 'current' | 'next' }
  | { match: 'mismatch'; observed: string; pinned: string } => {
  if (!pin_state) {
    // No pin yet — first connect after pair, the pin is set from
    // the inbound passport. The caller short-circuits to "trust on
    // first use" only via the explicit pair-blob path; bare URL
    // edits without a prior pin are rejected upstream.
    return { match: 'mismatch', observed: observed_fingerprint, pinned: '' };
  }
  if (observed_fingerprint === pin_state.current_fingerprint) {
    return { match: 'current' };
  }
  if (
    pin_state.next_fingerprint &&
    observed_fingerprint === pin_state.next_fingerprint
  ) {
    return { match: 'next' };
  }
  return {
    match: 'mismatch',
    observed: observed_fingerprint,
    pinned: pin_state.current_fingerprint,
  };
};
