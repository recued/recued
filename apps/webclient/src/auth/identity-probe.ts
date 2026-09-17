/** D-148 — client half of the pre-auth server-identity probe.
 *
 *  Asks a CANDIDATE address to prove it holds the key this client already
 *  pinned, without presenting the bearer. That ordering is the whole point:
 *  it is what lets the Account & Servers URL edit be safe by default rather
 *  than safe-after-exposure.
 *
 *  ⛔ THIS MODULE NEVER SENDS A CREDENTIAL. It sends a random nonce and a
 *  fingerprint the client already holds. A caller that reaches for it as a
 *  general "is the server up" check is using the wrong tool — `/health`
 *  answers that and costs nothing.
 */

import { verifyEd25519 } from './ed25519-verifier.js';
import {
  isInsecureSocketFromSecurePage,
  readPageProtocol,
} from '../net/insecure-origin.js';
import { serverKeyFingerprint } from './server-fingerprint.js';
import {
  IDENTITY_PROBE_PATH,
  IDENTITY_PROBE_NONCE_BYTES,
  buildIdentityProbePayload,
} from '@recued/contracts';

export type IdentityProbeOutcome =
  /** The address answered AND proved it holds the pinned key. */
  | { readonly kind: 'verified' }
  /** Nothing answered — DNS failure, refused connection, TLS failure. */
  | { readonly kind: 'unreachable' }
  /** ⛔ THE BROWSER REFUSED, NOT THE SERVER. A page served from `https://`
   *  cannot fetch `http://`, and a LAN server IS `ws://` → `http://`, so this
   *  is the ordinary case for "move me to my LAN address", not an edge one.
   *
   *  ⚠ IT MUST NOT BE FOLDED INTO `unreachable`. `net/insecure-origin.ts`
   *  exists because "every surface said 'can't reach your server' about a
   *  server that was running, answering, and one origin away" — and a probe
   *  that blamed the server here would send the owner to restart a machine
   *  that is working. The fixes are the owner's and are different ones: reach
   *  the server from its own origin, or give it a certificate. */
  | { readonly kind: 'blocked_by_browser' }
  /** Something answered but did not prove the pinned identity. ⚠ ONE outcome
   *  on purpose: a server that is not ours, a server too old to have the
   *  route, and a bad signature all return the same 404-or-mismatch, and the
   *  caller's decision is identical in every case — do not save. */
  | { readonly kind: 'not_the_same_server' };

/** `wss://host[:port]<prefix>/ws` → `https://host[:port]<prefix>/auth/identity-probe`
 *  (and `ws:` → `http:`). Query and fragment are dropped: the probe takes its
 *  input in the body, and a URL is the one place a secret must never ride.
 *
 *  ⛔⛔ THE MOUNT PREFIX IS PRESERVED, AND AN EARLIER VERSION DROPPED IT. It
 *  assigned `url.pathname = IDENTITY_PROBE_PATH`, so a Recued behind nginx or
 *  Caddy at `https://example.com/recued/` — stored as
 *  `wss://example.com/recued/ws` — probed `https://example.com/auth/identity-probe`
 *  and hit THE OWNER'S OWN WEBSITE instead of their server. That is the
 *  reverse-proxy shape D-148 § A.17 documents (TLS terminated upstream), and
 *  running behind existing hosting is the reason the address is editable at all.
 *
 *  🔑 `normaliseServerUrlToWs` deliberately keeps a prefix (`path.endsWith('/ws')`
 *  → kept), and the three sibling-URL builders in `webclient-bootstrap.ts` all
 *  use `serverUrl.replace(/\/ws(?=$|\?)/, '/ws/download')` — prefix-preserving.
 *  This was the one builder that was not, which is the tell: a lone
 *  disagreement with three siblings is a bug, not a design. */
export const identityProbeUrl = (serverUrl: string): string | null => {
  try {
    const url = new URL(serverUrl);
    if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // Drop the `/ws` leaf (or a bare trailing slash) and hang the probe off
    // whatever mount point remains.
    const mount = url.pathname.replace(/\/ws\/?$/, '').replace(/\/$/, '');
    url.pathname = `${mount}${IDENTITY_PROBE_PATH}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    // ⚠ `new URL` throws on a zoned IPv6 literal (`[fe80::1%25eth0]`) before
    // any of our own checks run, so a malformed address lands here rather than
    // in the protocol branch above.
    return null;
  }
};

const randomNonce = (): string => {
  const bytes = new Uint8Array(IDENTITY_PROBE_NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // base64url, unpadded — what `isValidIdentityProbeNonce` accepts.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export interface ProbeServerIdentityOptions {
  /** The candidate address, as it would be stored in `server_url`. */
  readonly serverUrl: string;
  /** The key this client pinned at pair time, base64 SPKI. */
  readonly pinnedPublicKey: string;
  /** Injected for tests; defaults to the page's `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Abort budget. A dead address must not hang the Save button. */
  readonly timeoutMs?: number;
  /** `location.protocol` of the page. Injected for tests; defaults to the
   *  real one. Needed to tell a browser refusal from a dead server. */
  readonly pageProtocol?: string | null;
}

/** Abort budget for a probe. ⚠ Module-private: it was exported and nothing —
 *  not even a test — imported it, which is the same dead-seam shape as the
 *  `onSaved` hook removed from the panel. A default is not an API. */
const PROBE_TIMEOUT_MS = 8_000;

/** Ask the candidate to prove it holds `pinnedPublicKey`. */
export const probeServerIdentity = async (
  options: ProbeServerIdentityOptions,
): Promise<IdentityProbeOutcome> => {
  const url = identityProbeUrl(options.serverUrl);
  if (!url) return { kind: 'unreachable' };

  let expectFingerprint: string;
  try {
    expectFingerprint = await serverKeyFingerprint(options.pinnedPublicKey);
  } catch {
    // An undecodable pin is a local defect, not a statement about the
    // candidate — but it still means we cannot prove anything, so it must
    // never read as success.
    return { kind: 'not_the_same_server' };
  }

  const nonce = randomNonce();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, expect_fingerprint: expectFingerprint }),
      signal: controller.signal,
      // ⛔ No cookies, no stored credentials. The probe is anonymous by
      // construction and must stay that way even against an attacker's host.
      credentials: 'omit',
    });
  } catch {
    // ⚠ DIAGNOSED ONLY AFTER A FAILURE, which is what lets loopback be
    // included. Chrome permits a loopback dial from a secure page, so warning
    // up front would nag a configuration that works — but once the request HAS
    // failed, the failure is the evidence and the scheme mismatch is the
    // likeliest cause. That split is `insecure-origin.ts`'s own.
    const protocol = options.pageProtocol !== undefined
      ? options.pageProtocol
      : readPageProtocol();
    if (isInsecureSocketFromSecurePage(options.serverUrl, protocol)) {
      return { kind: 'blocked_by_browser' };
    }
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }

  // A 404 is the server's ONE refusal — not ours, not configured, malformed.
  if (!res.ok) return { kind: 'not_the_same_server' };

  let signature: unknown;
  try {
    signature = ((await res.json()) as { signature?: unknown }).signature;
  } catch {
    return { kind: 'not_the_same_server' };
  }
  if (typeof signature !== 'string' || signature.length === 0) {
    return { kind: 'not_the_same_server' };
  }

  // 🔑 The payload is rebuilt from OUR pin and OUR nonce. Nothing the candidate
  // said contributes to it, so a hostile server cannot steer this check — and
  // because the nonce is fresh, a captured signature from the real server
  // proves nothing here.
  const payload = new TextEncoder().encode(
    buildIdentityProbePayload({ nonce, server_public_key: options.pinnedPublicKey }),
  );
  const ok = await verifyEd25519(options.pinnedPublicKey, payload, signature);
  return ok ? { kind: 'verified' } : { kind: 'not_the_same_server' };
};
