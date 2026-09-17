/** D-148 — pre-auth server-identity probe.
 *
 *  Answers one question, before any bearer is presented: *is the server at
 *  this address the one I already trust?* It exists because the Account &
 *  Servers URL edit saves a new address only when that address is alive AND
 *  presents the pinned `server_public_key` — and every other way to obtain
 *  that proof (`passport.fetch`) runs over an authenticated WebSocket, so
 *  asking would have meant handing the bearer to an unverified candidate and
 *  checking afterwards.
 *
 *  Both ends import THIS module — the path, the shapes, and above all
 *  `buildIdentityProbePayload` — so the signed bytes cannot drift between the
 *  Node server that produces them and the browser that verifies them.
 *
 *  ⛔⛔ THE SERVER SIGNS A PAYLOAD IT BUILDS, NEVER THE BYTES IT IS HANDED.
 *  `server_identity_key` is not a dedicated identity key: it also signs DDNS
 *  record updates, ACME requests, metrics-board submissions and connection
 *  OAuth payloads, and `ServerIdentity.signWithServerIdentity` states the gap
 *  in its own words — *"The caller is responsible for canonicalization."* An
 *  endpoint here that signed a caller-supplied string would be a DNS-takeover
 *  oracle needing nothing secret: the handle IS `<handle>.recued.net` and
 *  `publisher_id` is the fingerprint the passport publishes, so anyone could
 *  post `canonicalJSONStringify({publisher_id, handle, ip_v4: <theirs>,
 *  ip_v6: null, timestamp})` as the "nonce" and replay the signature to the
 *  cloud DDNS route. ⇒ The nonce is a FIELD INSIDE a payload this module
 *  builds, shape-checked so it cannot contribute structure, under a `domain`
 *  tag that separates these bytes from every other protocol's.
 *
 *  ⚠ The `domain` tag is the load-bearing separator, NOT the fact that this
 *  key set differs from DDNS's. Key-set disjointness is what keeps the
 *  existing signers apart today, and it is an accident rather than a rule —
 *  see the 2026-09-17 decisions-log entry.
 */

import { canonicalJSONStringifyStrict } from '@recued/crypto/canonical-json';

/** Pre-auth route, served on the `ws` PATH ROLE beside `/auth/pair`.
 *
 *  ⛔ NOT the `health` role, though `/health/...` sub-paths would route there.
 *  Every exposure preset happens to give `health` and `ws` identical
 *  `{lan, public}` bits, so it would work — by coincidence. A `custom`
 *  exposure can switch `health` off while `ws` stays on, and the probe would
 *  then 404 for exactly the address the user is trying to save. Living on the
 *  `ws` role makes "reachable iff the `wss://…/ws` URL being saved is
 *  reachable" structural rather than a preset accident. */
export const IDENTITY_PROBE_PATH = '/auth/identity-probe';

/** Domain separator inside the signed payload. Version it rather than the
 *  path: a future payload shape ships as `…v2` and an old client's `…v1`
 *  request stays unambiguous instead of colliding. */
export const IDENTITY_PROBE_DOMAIN = 'recued.identity.probe.v1';

/** Bytes of entropy a client SHOULD draw for the nonce. Not enforced on the
 *  wire — the server cannot audit a client's randomness, it can only bound
 *  the field — but a client with less than this is fooling only itself: the
 *  nonce is what makes a reply a LIVENESS proof rather than a replayable
 *  assertion that the server existed once. */
export const IDENTITY_PROBE_NONCE_BYTES = 32;

/** Base64url, no padding, and bounded. The lower bound rejects a degenerate
 *  nonce; the upper bound keeps an unauthenticated caller from steering the
 *  size of what we sign. 32 random bytes encode to 43 characters. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

/** `sha256:<64 lowercase hex>` — the encoding the server
 *  (`ed25519PublicKeyFingerprint`), the auth Worker (`fingerprintOfSpki`) and
 *  the webclient (`auth/server-fingerprint.ts`) all already agree on. */
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface IdentityProbeRequest {
  /** Fresh client nonce, base64url. */
  nonce: string;
  /** The identity fingerprint the client expects to find at this address.
   *
   *  🔑 THE CLIENT NAMES IT, AND THAT INVERTS THE DISCLOSURE PROBLEM. A public
   *  endpoint that announced *"I am server X"* would tell any scanner who
   *  lives at an address. Here the caller states what it expects and the
   *  server merely PROVES it, so a caller with no fingerprint learns nothing.
   *
   *  ⚠⚠ BUT THE FINGERPRINT IS NOT ALWAYS SECRET, AND AN EARLIER VERSION OF
   *  THIS COMMENT WAS WRONG TO IMPLY IT. It said a stranger "would have to
   *  guess a 256-bit value". True for a private self-hoster — but this value
   *  IS `publisher_id` (`wire-passport-fetch-substrate.ts` sets
   *  `publisher_id: serverKey.public_key_fingerprint`), and the marketplace
   *  returns `publisher_id` in every listing and accepts it as a query filter.
   *
   *  ⇒ For anyone who has PUBLISHED, this endpoint confirms "the server at
   *  this address is publisher X" to a caller who already holds a candidate
   *  address. It cannot DISCOVER an address — it confirms a guess — and for
   *  Pro users the handle's DNS record already maps a name to an address. The
   *  residual is that a publisher's self-hosted address can be confirmed by
   *  someone who suspects it. That is inherent: any design that proves "key X
   *  is here" to a holder of X is a confirmation oracle when X is public.
   *
   *  ⛔ SO DO NOT "FIX" THIS BY MAKING THE SERVER ANNOUNCE ITS KEY UNPROMPTED —
   *  that is strictly worse, and is the option § A.15's disclosure objection
   *  already ruled out. */
  expect_fingerprint: string;
}

export interface IdentityProbeResponse {
  /** Base64 Ed25519 signature over `buildIdentityProbePayload(...)`. */
  signature: string;
}

/** ⛔ DELIBERATELY NOT ECHOED BACK: the server's public key.
 *
 *  The client reconstructs the signed payload from the key IT pinned, so it
 *  verifies against its own belief rather than the candidate's claim. Echoing
 *  the key would let a server steer what the client checks — and would add
 *  nothing, since a client that reaches a successful reply already holds the
 *  key (it had to name the matching fingerprint to get one). */
export const buildIdentityProbePayload = (args: {
  readonly nonce: string;
  /** The server's Ed25519 public key, base64 SPKI — as pinned by the client
   *  in `server_public_key`, and as held by the server. */
  readonly server_public_key: string;
}): string =>
  canonicalJSONStringifyStrict({
    domain: IDENTITY_PROBE_DOMAIN,
    nonce: args.nonce,
    server_public_key: args.server_public_key,
  });

export const isValidIdentityProbeNonce = (value: unknown): value is string =>
  typeof value === 'string' && NONCE_PATTERN.test(value);

export const isValidIdentityFingerprint = (value: unknown): value is string =>
  typeof value === 'string' && FINGERPRINT_PATTERN.test(value);

export const isIdentityProbeRequest = (value: unknown): value is IdentityProbeRequest => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isValidIdentityProbeNonce(v.nonce) && isValidIdentityFingerprint(v.expect_fingerprint);
};
