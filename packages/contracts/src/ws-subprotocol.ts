/** Carrying the WS bearer in `Sec-WebSocket-Protocol` instead of the URL.
 *
 *  ⛔ THE DEFECT THIS CLOSES. Browser clients cannot set request headers on
 *  `new WebSocket(url, protocols)`, so both the webclient and the Bridge put the
 *  bearer in the URL as `?token=<bearer>`. A URL is the worst place for a
 *  secret: it lands in reverse-proxy and access logs, crash reports, and browser
 *  URL telemetry, none of which are covered by TLS and none of which anyone
 *  audits.
 *
 *  The transports' own comment said the risk was "bounded by the TLS pin + the
 *  short bearer lifetime". ⚠ THERE IS NO SHORT BEARER LIFETIME. `client_tokens`
 *  (`backend/server/src/pairing/client-tokens.ts`) carries `issued_at`,
 *  `last_used_at`, `revoked_at` and `revocation_reason` — no expiry column and
 *  no expiry check anywhere. A paired bearer is valid until somebody revokes it,
 *  which for a device nobody revisits is forever. So a bearer that reached a log
 *  stayed live indefinitely.
 *
 *  `Sec-WebSocket-Protocol` is the one header a browser CAN set, via the second
 *  argument to the constructor. It is a request header rather than a URL, so it
 *  is not what gets written to an access log line.
 *
 *  ── WHY THIS LIVES IN CONTRACTS ──────────────────────────────────────
 *
 *  THREE surfaces have to agree byte for byte — the webclient encodes, the
 *  Bridge encodes, the server decodes — and a disagreement fails CLOSED: the
 *  server sees no bearer, the handshake 401s, and every client of that surface
 *  stops connecting. That is exactly the shape of thing that must not be
 *  reimplemented per surface.
 *
 *  ── WHY BASE64URL, NOT THE RAW BEARER ────────────────────────────────
 *
 *  A subprotocol value must be an RFC 6455 / RFC 7230 `token`:
 *
 *      ALPHA / DIGIT / "!" / "#" / "$" / "%" / "&" / "'" / "*"
 *                    / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~"
 *
 *  ⛔ The bearer is NOT token-safe. It is the structured form
 *  `<token_id>.<bearer>` where both halves are STANDARD base64 — whose alphabet
 *  includes `/` and the `=` padding, neither of which is a token character. Sent
 *  raw it would produce a malformed handshake, and browsers reject an invalid
 *  subprotocol at the constructor with a SyntaxError before a single byte is
 *  sent. base64url (`-` and `_`, padding stripped) is entirely token-safe, and
 *  `.` — the prefix separator below — is a token character too.
 *
 *  `ws-subprotocol.test.ts` asserts the round-trip AND that the encoded output
 *  contains only token characters, over the real 61-character bearer shape.
 */

/** Marks the subprotocol slot that carries the bearer. The value is
 *  `bearer.<base64url>`; anything without this prefix is an ordinary
 *  subprotocol (e.g. the `recued.v1` version marker) and is left alone. */
export const WS_BEARER_SUBPROTOCOL_PREFIX = 'bearer.' as const;

/** The version marker every Recued WS client offers first.
 *
 *  ⚠ ORDER IS LOAD-BEARING. `ws`'s default protocol selection is
 *  `protocols.values().next().value` — the client's FIRST offered value — and
 *  whatever it selects is echoed back in the `Sec-WebSocket-Protocol` RESPONSE
 *  header. Offer this one first so a server that has not set `handleProtocols`
 *  can never echo the bearer back into a response header, which would put the
 *  secret right back in a log. (Recued's server also pins the selection
 *  explicitly — belt and braces, because this ordering is a client-side
 *  guarantee and the server should not depend on a client to keep it.) */
export const WS_VERSION_SUBPROTOCOL = 'recued.v1' as const;

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  // `btoa` exists in browsers, workers and Node ≥16 — the three runtimes that
  // encode. Deliberately not `Buffer`: the webclient bundle has no Node globals.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): Uint8Array | null => {
  // Reject anything outside the base64url alphabet BEFORE decoding: `atob` is
  // lenient about some inputs, and a bearer is not a place to accept "close
  // enough". Padding is restored because `atob` requires it.
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

/** Encode a bearer into its `bearer.<base64url>` subprotocol value. */
export const encodeBearerSubprotocol = (bearer: string): string =>
  `${WS_BEARER_SUBPROTOCOL_PREFIX}${toBase64Url(new TextEncoder().encode(bearer))}`;

/** Recover the bearer from a client's offered subprotocol list, or `null` when
 *  none of them carries one.
 *
 *  Accepts the raw `Sec-WebSocket-Protocol` header value (comma-separated, as it
 *  arrives on the wire) or an already-split list. Returns `null` — never throws
 *  and never a partial value — on anything malformed, so the caller's existing
 *  "no bearer" path handles it and an attacker learns nothing from the shape of
 *  the failure. */
export const decodeBearerSubprotocol = (
  offered: string | ReadonlyArray<string> | undefined,
): string | null => {
  if (offered === undefined) return null;
  const values = (typeof offered === 'string' ? offered.split(',') : offered)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  for (const value of values) {
    if (!value.startsWith(WS_BEARER_SUBPROTOCOL_PREFIX)) continue;
    const bytes = fromBase64Url(value.slice(WS_BEARER_SUBPROTOCOL_PREFIX.length));
    if (bytes === null || bytes.length === 0) return null;
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
};
