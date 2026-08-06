/** Request signing — the auth shape that computes a value per request.
 *
 *  Every other `ConnectionAuth` member supplies a STATIC credential: a value
 *  stored at enrollment and sent unchanged on every call. A signing vendor
 *  requires a value that is a function of the request being made — method, path,
 *  query, body, clock — so no amount of `header` or `query` configuration can
 *  express it. That is the gap this closes, and it is the same "shape no other
 *  member can express" bar D-218 set for `atproto_session`.
 *
 *  ## ⛔⛔ A CLOSED REGISTRY, NOT A TEMPLATE — AND THIS IS THE WHOLE DESIGN
 *
 *  The obvious design, and the one this replaced, is an auth type carrying a
 *  canonical-string TEMPLATE naming which parts of the request get signed. Do
 *  not reintroduce it. A template is an instruction, authored by whoever wrote
 *  the pack, telling this code which bytes to sign with the owner's secret key.
 *  That makes Recued a **signing oracle**: the author chooses the message, and
 *  the resulting signature is a value they can read back and use elsewhere — it
 *  is not confined to the request that produced it.
 *
 *  D-218 already made this exact refusal for `atproto_session`, in that type's
 *  own doc comment: a configurable credential-only destination "would be the
 *  highest-value exfiltration primitive in the system". A configurable
 *  credential-only MESSAGE is the same class of mistake one step to the left.
 *
 *  So: the connection row names a scheme from the closed list below, and the
 *  canonical string is composed HERE, by this file, out of the request actually
 *  being sent. Adding a vendor is a registry entry plus a test vector, reviewed
 *  once — the shape `crm_alias` (D-130) and the enrichment registry (D-122)
 *  already use.
 *
 *  ⚠ **The cost, stated plainly:** every new signing vendor is a code change,
 *  not a connection-form entry. A vendor whose scheme nobody has implemented is
 *  unreachable. That is the trade — bounded, reviewable work in exchange for
 *  never handing a third party the pen that writes what we sign.
 *
 *  ## Where this runs
 *
 *  In contracts rather than in the adapter because there are TWO apply sites —
 *  `injectAuth` in `packages/ingredients/src/connection-api.ts` (real dispatch)
 *  and `applyAuth` in `backend/server/src/connection-handler.ts` (enrollment
 *  probes). D-218 § 8.1 records what happens when auth knowledge is copied
 *  rather than shared: three hand-kept copies, all typechecking while
 *  incomplete. One implementation, two callers.
 */

import { hmacSha256Hex } from '@recued/crypto/hmac';

/** Every signing scheme this build can produce. Closed on purpose — see the
 *  header. Adding a name here without implementing it in `applyRequestSignature`
 *  is a compile error, because that function's switch must stay exhaustive. */
export const CONNECTION_SIGNING_SCHEMES = [
  /** Binance SIGNED endpoints (`TRADE` / `USER_DATA`): `X-MBX-APIKEY` header
   *  plus HMAC-SHA256 over the query string concatenated with the body, sent
   *  back as a `signature` query parameter. Binance's public `NONE` endpoints
   *  need no credential at all and are already served by `auth: none`. */
  'binance_hmac_sha256',
] as const;

export type ConnectionSigningScheme = (typeof CONNECTION_SIGNING_SCHEMES)[number];

export const isConnectionSigningScheme = (v: unknown): v is ConnectionSigningScheme =>
  typeof v === 'string' && (CONNECTION_SIGNING_SCHEMES as readonly string[]).includes(v);

/** The auth member. Declared here so the scheme vocabulary and the shape that
 *  carries it cannot drift; `connection.ts` imports it into `ConnectionAuth`. */
export interface RequestSignatureAuth {
  type: 'request_signature';
  scheme: ConnectionSigningScheme;
  /** The public half — an account identifier sent as-is (Binance's
   *  `X-MBX-APIKEY`). Not a secret, but not useful alone. */
  api_key: string;
  /** ⛔ The signing secret. Never sent on the wire in any scheme here — it only
   *  ever keys a MAC. It must appear in the handler's secret-scrubber and must
   *  never reach a connection view, a probe receipt, or an audit row. */
  secret_key: string;
}

/** What a signing scheme contributes to the outbound request. Headers are
 *  returned rather than applied because the two call sites use different
 *  containers — a `Headers` in the adapter, a `Record<string,string>` in the
 *  handler probe. Query parameters are applied to the caller's own `URL`, which
 *  both sites already hold, because the signature has to be computed over the
 *  FINAL query string and returning it for someone else to assemble is how that
 *  ordering gets broken. */
export type SignatureHeaders = Readonly<Record<string, string>>;

export interface SignableRequest {
  method: string;
  /** ⚠ MUTATED — signing appends its own parameters. See the idempotence note. */
  url: URL;
  /** Serialized request body, when the scheme signs it. `undefined` for GET. */
  body?: string | undefined;
}

/** Sign one outbound request: mutate `req.url` with whatever query parameters
 *  the scheme requires, and return the headers to set.
 *
 *  ⛔ **IDEMPOTENT BY CONSTRUCTION, and that is load-bearing.** Signing material
 *  is stripped from the URL before anything is recomputed, so calling this twice
 *  on the same request produces a correctly signed request rather than one
 *  carrying two timestamps and a signature computed over the first signature.
 *  Two live paths make that reachable: the adapter's 401 re-auth retry calls
 *  `injectAuth` a second time on an already-mutated URL, and a probe may sign a
 *  candidate and then a negative control. Neither is hypothetical, and the
 *  failure would be a silently malformed request rather than an exception.
 *
 *  ⛔ **Ordering is inside this function for the same reason.** The signature
 *  must cover every other parameter, so it is computed after the timestamp is
 *  set and appended last. A caller cannot get this right from the outside, so
 *  it is not offered as a choice.
 *
 *  `nowMs` is injected — the callers have a clock convention (`deps.now`) and a
 *  signed request is rejected on clock skew, so the value must be testable.
 */
export const applyRequestSignature = (
  auth: RequestSignatureAuth,
  req: SignableRequest,
  nowMs: number,
): SignatureHeaders => {
  switch (auth.scheme) {
    case 'binance_hmac_sha256': {
      const params = req.url.searchParams;
      // Strip prior signing material FIRST — see the idempotence note above.
      params.delete('signature');
      params.delete('timestamp');
      params.set('timestamp', String(Math.trunc(nowMs)));
      // Binance signs `totalParams` = query string + request body, in that
      // order, with no separator. GET carries no body and signs the query only.
      const canonical = `${params.toString()}${req.body ?? ''}`;
      params.set('signature', hmacSha256Hex(auth.secret_key, canonical));
      return { 'X-MBX-APIKEY': auth.api_key };
    }
  }
};

/** Every secret string a signing auth holds, for the handler's error scrubber.
 *
 *  ⛔ Exported rather than open-coded at the scrubber because that switch has no
 *  `default` and no exhaustiveness guard: a member added without a case there
 *  collects NOTHING and its credentials go unredacted into probe output. D-218
 *  hit exactly that and recorded it as "the site that would have leaked". */
export const requestSignatureSecrets = (
  auth: RequestSignatureAuth,
): readonly string[] => [auth.secret_key, auth.api_key];
