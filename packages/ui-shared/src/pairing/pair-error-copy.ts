/** `/auth/pair` server-error presentation, shared by every pairing client.
 *
 *  ── Why this exists ─────────────────────────────────────────────────
 *  The webclient and the Bridge popup each carried their OWN hand-copied
 *  list of "known" `/auth/pair` error codes, each four codes behind the
 *  server, each pointing at a `server.ts` line number that had since moved.
 *  A copied vocabulary rots, and a SUBSET of it still typechecks — so the
 *  rot is silent. Both now read this one module.
 *
 *  ⛔⛔ **But the list is not what makes this safe.** A list can always fall
 *  behind; what must not happen is a client turning an unrecognised code
 *  into a WRONG instruction. Both clients used to render every unmapped
 *  code as *"The server returned an unexpected response. Check the URL and
 *  try again."* — and for `realm_directory_conflict`, `instance_revoked`,
 *  `encryption_enrollment_busy` and `database_encryption_not_configured`
 *  (all reachable from `/auth/pair` today) the URL is perfectly fine. The
 *  user was sent to re-check the one thing that was right, while the
 *  server's own explanation — already parsed, already in hand — was thrown
 *  away.
 *
 *  So the contract here is: tailored copy when we have it, and otherwise
 *  the SERVER'S OWN words, quoted and attributed. An unmapped code
 *  degrades to "less specific", never to "misleading". Precedent: the
 *  webclient's `rpc-error-copy` does the same for non-connection errors.
 *
 *  ── Why the server's message is ATTRIBUTED, not merged ──────────────
 *  ⚠ Pairing runs BEFORE any trust exists: the user has typed a URL (or
 *  followed a `?url=` deep link) and nothing has authenticated that host
 *  yet. Anything it returns is unverified text, so it must never appear to
 *  be Recued speaking — a hostile server could otherwise print
 *  instructions inside a trusted-looking UI. It is quoted under "Your
 *  server said:", kept in its own element, length-capped, and stripped of
 *  control characters. (Escaping is the host's job and both hosts already
 *  escape; this module never emits markup.) */

/** Longest server message a client will quote. Past this the text is
 *  truncated with an ellipsis — a wall of server prose in a pairing form
 *  is its own failure mode, and nothing legitimate needs more. */
export const PAIR_SERVER_MESSAGE_MAX_CHARS = 280;

/** Tailored copy for the `/auth/pair` codes we can say something better
 *  about than the server can.
 *
 *  ⚠ This map is deliberately NOT a closed list of what the endpoint can
 *  return — see the header. Adding a code here is an upgrade from
 *  "quoted server message" to "Recued's own words"; forgetting one costs
 *  specificity, not correctness. Every entry below was read off the
 *  handler in `backend/server/src/server.ts` (`POST /auth/pair`) plus
 *  `server-vault-enrollment.ts`'s outcome mapping. */
export const PAIR_SERVER_ERROR_COPY = {
  invalid_code:
    'That pairing code is invalid, expired, or already used. Refresh it from the server terminal.',
  recovery_key_invalid:
    "That recovery key doesn't match the one your server has on file. Re-check your written copy and re-enter.",
  bad_request: 'The server rejected the request. Re-check the fields and try again.',
  server_not_configured:
    'The server is missing its recovery-key check store. Ask your admin to run `recued-server pair` first.',
  // ── D-212-era codes the hand-copied lists never learned ──────────────
  instance_revoked:
    'This device was removed from your server, so it can’t re-use its old identity. Clear this browser from Settings (or use a different one) to pair again as a new device.',
  realm_directory_conflict:
    'Your server’s data directory already holds another realm, and one directory can hold only one. Point this server at its own data directory, then pair again.',
  encryption_enrollment_busy:
    'Your server is busy finishing encryption setup — usually a moment. Wait, then try again with a fresh pairing code.',
  database_encryption_not_configured:
    'Your server can’t turn on at-rest encryption. Check the server logs; this is a server-side setup problem, not something to fix from here.',
  // The one case where "check the URL" IS the right advice: something
  // answered, but it does not serve this endpoint.
  not_found:
    'Something answered at that address, but it isn’t a recued-server — or it’s too old to pair this way. Check the URL.',
  payload_too_large:
    'The server rejected the request as too large. Re-check the fields (a pasted recovery key should be 24 words) and try again.',
  internal_error:
    'Your server hit an internal error while pairing. Check its logs, then try again.',
} as const satisfies Readonly<Record<string, string>>;

/** The codes above, as a type. Clients DERIVE their server-error union
 *  from this instead of re-declaring one — a re-declared subset still
 *  typechecks, which is exactly how both clients silently fell four codes
 *  behind. */
export type PairServerErrorCode = keyof typeof PAIR_SERVER_ERROR_COPY;

export interface PairServerErrorPresentation {
  /** The raw server code — for `data-error` / telemetry, not for display. */
  code: string;
  /** What the client renders as its own words. Always present. */
  copy: string;
  /** The server's verbatim message, sanitized, when there is no tailored
   *  copy for this code. `null` whenever Recued has better words — the raw
   *  message is then noise, and the D-212 realm messages in particular
   *  carry internal markers (`D212_REALM_WOULD_ORPHAN_SIBLING`) no user
   *  should have to read.
   *
   *  ⚠ Render it ATTRIBUTED and separate from `copy`. It is unverified
   *  text from an unauthenticated host. */
  serverSaid: string | null;
  /** True when `copy` is the generic refusal rather than tailored words.
   *  Lets a host style / test the two apart without string-matching. */
  tailored: boolean;
}

/** Shown when the server refused with a code we have no words for. It
 *  says what actually happened (the server answered, and said no) and
 *  claims nothing about the URL, the code, or the key. */
export const PAIR_SERVER_REFUSED_COPY =
  'Your server refused the pairing request.';

/** The attribution label a host renders above `serverSaid`. Exported so
 *  every surface quotes with the same words. */
export const PAIR_SERVER_SAID_LABEL = 'Your server said:';

/** Collapse a server-supplied message into something safe to quote:
 *  control characters out (they can fake structure in a terminal or a
 *  screen reader), whitespace collapsed, length capped. Returns `null`
 *  for anything empty — a blank quote is worse than no quote. */
export const sanitizeServerMessage = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  // Escapes, never literal control bytes in the source — a file that
  // carries them reads as binary to grep and to a reviewer.
  const stripped = raw.replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= PAIR_SERVER_MESSAGE_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, PAIR_SERVER_MESSAGE_MAX_CHARS - 1).trimEnd()}…`;
};

/** True when this module holds tailored copy for a code. Hosts use it to
 *  decide whether to keep their own typed error code or fall through to
 *  the quoted-server-message path. */
export const hasPairServerErrorCopy = (code: string): code is PairServerErrorCode =>
  Object.prototype.hasOwnProperty.call(PAIR_SERVER_ERROR_COPY, code);

/** Project a `/auth/pair` error block into what a client should show. */
export const describePairServerError = (
  code: string,
  message?: unknown,
): PairServerErrorPresentation => {
  const tailored = hasPairServerErrorCopy(code);
  if (tailored) {
    return {
      code,
      copy: PAIR_SERVER_ERROR_COPY[code]!,
      serverSaid: null,
      tailored: true,
    };
  }
  return {
    code,
    copy: PAIR_SERVER_REFUSED_COPY,
    serverSaid: sanitizeServerMessage(message),
    tailored: false,
  };
};
