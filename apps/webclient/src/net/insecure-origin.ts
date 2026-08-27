/** Whether THIS BROWSER — not the server — is what refused the connection.
 *
 *  ⛔ THE FAILURE THIS EXISTS TO NAME. A page served from `https://` opening a
 *  `ws://` socket is refused by the browser before a byte leaves it. What the
 *  client observes is close code 1006 with no status and no headers, which is
 *  byte-for-byte what an unplugged cable looks like — so every surface said
 *  "can't reach your server" about a server that was running, answering, and
 *  one origin away. Measured against a live 26.8.26 server (2026-08-27): the
 *  `/ws` upgrade answers `401`, and the cross-origin `/auth/pair` preflight
 *  answers `204` WITH CORS headers. That asymmetry is the whole story — pairing
 *  completes over `fetch`, then the socket dies, and nothing on either side
 *  reports a cause.
 *
 *  ⛔⛔ AND NO SERVER HEADER CAN FIX IT, which is why this is a DIAGNOSIS and
 *  not a patch. A WebSocket handshake is not subject to CORS, so no
 *  `Access-Control-*` response on `/ws` changes the outcome; the browser is
 *  objecting to the SCHEME. The only real fixes belong to the owner: reach the
 *  server from its own origin (the bundled webclient on loopback), or give it a
 *  certificate. Saying that plainly is the entire value here.
 *
 *  Shared by the boot triage card and the shell's rpc error copy so the two
 *  cannot drift into disagreeing about the same connection. */

/** Hosts a browser may treat as potentially trustworthy over plain `http:`.
 *  Chrome allows a `ws://` socket to these from an `https:` page; Safari and
 *  Firefox are stricter.
 *
 *  ⚠ DELIBERATELY NOT USED TO SUPPRESS THE DIAGNOSIS. A loopback socket that
 *  failed on Safari needs exactly the same explanation as a LAN one, and we
 *  cannot sniff the browser's policy — only observe that the socket died. It
 *  is exported for callers that want to RANK confidence, never to gate. */
export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

/** True when the page is secure and the address it was told to dial is not. */
export const isInsecureSocketFromSecurePage = (
  serverUrl: string | null | undefined,
  pageProtocol: string | null | undefined,
): boolean => {
  if (pageProtocol !== 'https:') return false;
  if (typeof serverUrl !== 'string' || serverUrl.trim().length === 0) return false;
  try {
    const parsed = new URL(serverUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'ws:';
  } catch {
    // An unparseable stored address is not evidence of anything; the generic
    // "can't reach your server" copy is the honest answer for it.
    return false;
  }
};

/** `location.protocol` for the page this code runs in. Takes an optional
 *  document so a test drives a stub instead of the real global. */
export const readPageProtocol = (doc?: Document): string | null => {
  const loc = doc?.defaultView?.location
    ?? (globalThis as { location?: Location }).location;
  return typeof loc?.protocol === 'string' ? loc.protocol : null;
};

/** The subset of `isInsecureSocketFromSecurePage` that is certain BEFORE any
 *  attempt: an `http://` address whose host is NOT loopback, entered on an
 *  `https:` page. Mixed content is unconditional there — no browser permits
 *  it — so a form may warn about this one proactively without ever being
 *  wrong.
 *
 *  ⚠ Loopback is excluded deliberately, and that is the whole reason this is a
 *  separate function rather than a flag on the one above. Chrome DOES allow a
 *  loopback dial from a secure page, so warning about it up front would nag the
 *  configuration that works. Loopback is diagnosed only after a failure, where
 *  the failure itself is the evidence. */
export const isCertainlyBlockedServerAddress = (
  serverUrl: string | null | undefined,
  pageProtocol: string | null | undefined,
): boolean => {
  if (!isInsecureSocketFromSecurePage(serverUrl, pageProtocol)) return false;
  try {
    const parsed = new URL(serverUrl as string);
    if (LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;
    // ⚠ MUST NOT FLASH MID-TYPING. This is consulted on every keystroke, so it
    // sees every PREFIX of the address on the way to the real one. Wait until
    // the authority looks settled — a dot or an explicit port.
    //
    // ⛔ MEASURED ON THE RAW TEXT, NOT ON `parsed.hostname`, and that is not a
    // style choice: WHATWG normalises an integer host, so `http://1` — typed on
    // the way to `http://192.168.1.42` — parses with hostname `0.0.0.1`, which
    // CONTAINS DOTS and passed a settled-ness check written against the parsed
    // value. The raw authority is what the owner actually typed.
    const authority = (serverUrl as string).trim().split('://')[1]?.split('/')[0] ?? '';
    return authority.includes('.') || authority.includes(':');
  } catch {
    return false;
  }
};

/** Whether a thrown value is the browser's own refusal of an insecure socket.
 *
 *  Matched on BOTH the DOMException name and the message text. The name is the
 *  spec-defined signal, but `SecurityError` is also thrown for other reasons,
 *  and engines word the message differently — so either piece of evidence is
 *  accepted and neither is required to stand alone. A miss here costs only the
 *  precision of a message; the address heuristic still covers it. */
export const isBrowserSocketRefusal = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  const message = (err as { message?: unknown }).message;
  const text = typeof message === 'string' ? message.toLowerCase() : '';
  return (
    name === 'SecurityError'
    || text.includes('insecure websocket')
    || (text.includes('insecure') && text.includes('https'))
  );
};

/** The address the transport most recently tried to dial.
 *
 *  Module-level because the alternative is threading a server URL through every
 *  `catch (err) => classifyRpcError(err)` site in the shell. It is safe to hold
 *  here precisely because it is NOT per-call state: a session dials one paired
 *  server, and both halves of the predicate are fixed for the page's lifetime.
 *  Recorded by the transport itself rather than passed in at boot, so it is
 *  always the URL actually used and cannot fall out of step with it. */
let dialled: string | null = null;

export const noteDialledServerUrl = (serverUrl: string | null): void => {
  dialled = serverUrl;
};

export const dialledServerUrl = (): string | null => dialled;

/** Set when the browser has PROVEN it refused a socket, rather than us
 *  inferring it from the address.
 *
 *  🔑 THE PROOF IS A SYNCHRONOUS THROW. Chrome rejects mixed content from
 *  `new WebSocket(...)` with a `SecurityError` — the constructor never returns.
 *  A network failure, a wrong port, and a Local-Network-Access block all do the
 *  opposite: the constructor SUCCEEDS and the failure arrives later as close
 *  1006. So a throw out of that one line is the browser saying, in its own
 *  voice, that it would not even try — and it is worth more than the
 *  page-protocol-versus-address guess above, which has to hedge on which
 *  browser policy applies.
 *
 *  Sticky for the page's lifetime: the address and the page origin do not
 *  change under it, so a second attempt would be refused identically. */
let browserRefusedSocket = false;

export const noteBrowserRefusedSocket = (): void => {
  browserRefusedSocket = true;
};

/** True when a WebSocket constructor threw the browser's refusal at us. */
export const isSocketRefusalProven = (): boolean => browserRefusedSocket;

/** The composed question every surface should ask before blaming the server. */
export const isConnectionBlockedByBrowserOrigin = (doc?: Document): boolean =>
  browserRefusedSocket
  || isInsecureSocketFromSecurePage(dialled, readPageProtocol(doc));

/** Reset for tests — production never calls this. */
export const resetInsecureOriginProbeForTest = (): void => {
  dialled = null;
  browserRefusedSocket = false;
};
