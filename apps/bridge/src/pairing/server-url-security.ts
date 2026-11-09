/** D-169 bridge security hunt, F2 — TLS-for-public posture, shared by BOTH the
 *  `/auth/pair` POST (`pair-code-input-host`) and the long-lived WS connect
 *  (`pair-completion` `normaliseServerUrlToWs`).
 *
 *  Plaintext (`http://` / `ws://`) is permitted ONLY for hosts that are NOT
 *  reachable from the public internet. A genuinely public host must use TLS
 *  (`https://` / `wss://`), or the pairing code + the long-lived bearer it is
 *  exchanged for (POST) and every subsequent command frame (WS) would cross the
 *  open internet in the clear, with on-path injection possible. Centralised
 *  here so the POST and the WS dial can never drift (the review caught the POST
 *  being ungated while only the WS was).
 *
 *  ⛔ "NOT PUBLIC" IS WIDER THAN "RFC1918", AND THE GAP IS A FALSE REFUSAL.
 *  This originally admitted loopback + RFC1918 literals only, which refused
 *  five legitimate self-host topologies whose traffic never touches the open
 *  internet — so the guard's own stated premise was false for every one of
 *  them. Each admitted range below is non-routable BY SPECIFICATION, not by
 *  vendor trust:
 *    · 127/8, ::1                     loopback
 *    · 10/8, 172.16/12, 192.168/16    RFC 1918 private
 *    · fc00::/7                       RFC 4193 IPv6 unique-local
 *    · fe80::/10                      RFC 4291 IPv6 link-local
 *    · 169.254/16                     RFC 3927 — routers MUST NOT forward
 *    · 100.64/10                      RFC 6598 shared/CGNAT — not globally
 *                                     routable; also where a Tailscale tailnet
 *                                     addresses its peers, WireGuard-encrypted
 *                                     before the packet leaves the host
 *    · *.local                        RFC 6762 mDNS — resolved by link-local
 *                                     multicast, which is how a Mac or an
 *                                     Avahi box is addressed on a home LAN
 *    · localhost, *.localhost         RFC 6761 § 6.3 — reserved, resolves to
 *                                     loopback; the sibling copy in
 *                                     `ask-landing-answer-link.ts` already
 *                                     admitted these, so this is alignment
 *  Each name arm also accepts one trailing FQDN root dot (`nas.local.`), which
 *  `new URL()` preserves on a name and drops on an IPv4 literal.
 *
 *  ⚠ THE `.local` ARM IS NAME-BASED AND THEREFORE WEAKER THAN THE OTHERS, and
 *  it is worth being honest about why it is still fine. An IP literal needs no
 *  resolver, so admitting one trusts nobody; `.local` trusts whoever answers
 *  the mDNS query. But an attacker who can answer mDNS on your link can also
 *  ARP-spoof `192.168.1.50` — already admitted — so on-link they gain nothing.
 *  The only NEW attacker is one who makes `.local` resolve OFF-link, which
 *  takes control of the resolver, i.e. the network operator, who is the same
 *  party the RFC1918 arm already trusts. The residual case is a split-horizon
 *  DNS server pointing `.local` at a public address against RFC 6762 §3.
 *
 *  ⚠ A BARE SINGLE-LABEL NAME (`nas`, `recued-box`) IS STILL REFUSED, and that
 *  is deliberate rather than an oversight: it is not a public FQDN, but a
 *  search domain can expand it to one, and there is no specification that says
 *  otherwise. `*.ts.net` is refused for the matching reason — it is correct in
 *  practice, but trusting a vendor suffix is a different kind of claim than
 *  citing an RFC, and Tailscale issues real certificates for MagicDNS names, so
 *  those users have `https://` available.
 *
 *  ⛔⛔ THIS IS THE THIRD COPY OF THIS PREDICATE AND IT WAS THE NARROW ONE.
 *  `backend/server/src/network/resolve-lan-address.ts` (`isPubliclyRoutableIpv4`)
 *  and `backend/server/src/ask-landing-answer-link.ts` (`isPrivateOrLocalHost`)
 *  answer the same question under different names, and both already admitted
 *  ranges this refused — the first carrying the comment that names this exact
 *  bug: *"a check that only excluded RFC1918 would call a carrier-NAT'd home
 *  machine exposed."* Three names for one predicate is why no near-duplicate
 *  scan found the drift. `server-url-security.agreement.test.ts` now pins the
 *  three to one answer table; extend that table, not just this file. */

/** Parse `host` as a dotted-quad IPv4 LITERAL → its four octets, or null when
 *  it is not one. A real literal is exactly four 0–255 numeric octets — so a
 *  public hostname that merely LOOKS private (`127.0.0.1.evil.com`,
 *  `10.evil.com`) parses to null and is NOT treated as private (closes the
 *  `startsWith('127.')` prefix-bypass). */
export const ipv4Octets = (host: string): [number, number, number, number] | null => {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
  return octets as [number, number, number, number];
};

/** Is `host` unreachable from the public internet — loopback, a private /
 *  link-local / shared-address literal, or an mDNS `.local` name? `host` is a
 *  `URL.hostname` (IPv6 literals arrive bracketed, e.g. `[::1]`). IPv4 is
 *  matched on parsed OCTETS, never a string prefix. See the header for the
 *  range list and the RFC each one cites. */
export const isLanLocalHost = (host: string): boolean => {
  const h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) {
    // A bracketed host is always an IPv6 literal — a DNS name can't be
    // bracketed, so prefix checks are safe. ::1 loopback, fc00::/7 ULA (fc/fd),
    // fe80::/10 link-local (first hextet fe80–febf).
    const v6 = h.slice(1, -1);
    return v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || /^fe[89ab]/.test(v6);
  }
  const o = ipv4Octets(h);
  if (o === null) {
    // ⚠ A NAME, NOT A LITERAL — only the two RESERVED pseudo-TLDs qualify, and
    //   only as a whole trailing LABEL. `endsWith('.local')` rejects a bare
    //   `local` and cannot be prefix-tricked, because no public registry will
    //   ever delegate either name (RFC 6761 § 6.3, RFC 6762 § 22). One trailing
    //   FQDN root dot is stripped first: `new URL()` keeps it on a NAME
    //   (`nas.local.`) while dropping it on a literal (`192.168.1.1.` parses as
    //   IPv4 and never reaches here), so this adds no literal surface.
    const name = h.endsWith('.') ? h.slice(0, -1) : h;
    return name === 'localhost'
      || name.endsWith('.localhost') // RFC 6761 § 6.3 — resolves to loopback
      || name.endsWith('.local'); // RFC 6762 — mDNS, link-local by protocol
  }
  if (o[0] === 127) return true; // 127.0.0.0/8 loopback
  if (o[0] === 10) return true; // 10.0.0.0/8
  if (o[0] === 192 && o[1] === 168) return true; // 192.168.0.0/16
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16.0.0/12
  if (o[0] === 169 && o[1] === 254) return true; // 169.254.0.0/16 link-local
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
};

/** True iff `rawUrl` is a PUBLIC host over an INSECURE scheme (`http://` /
 *  `ws://`) — plaintext that must be refused. A LAN-local insecure URL, or any
 *  `https://` / `wss://` URL, returns false. A structurally-invalid URL returns
 *  false (the caller's own shape validation rejects it separately; a bad URL
 *  fails at fetch anyway). */
export const isInsecurePublicServerUrl = (rawUrl: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'ws:') return false;
  return !isLanLocalHost(parsed.hostname.toLowerCase());
};
