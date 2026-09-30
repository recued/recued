/** D-158 P2b-ii — the email `answerLink` builder for the notification
 *  ask-landing page, and the deep-link builders beside it.
 *
 *  Each builder takes a resolved public base URL, or null when there is none
 *  (→ no link: the ask stays text-only, answerable on the always-on `ui`
 *  channel + by email reply). The base comes from `public-address.ts`, PER
 *  LINK: `RECUED_PUBLIC_BASE_URL` when set, else the server's own verified
 *  name that serves the path, ranked by the cloud probe. It used to be the
 *  variable alone, read once at boot, so a Pro server that never set it sent
 *  every ask without its link. */

import { PATH_FOR_ROLE } from '@recued/contracts';

/** True iff the host is loopback / RFC1918 private / link-local / CGNAT /
 *  IPv6 ULA / mDNS `.local` — i.e. NOT reachable from the public internet.
 *
 *  STRICTER than reception's `isPublicShareBaseUrl` (which rejects only the
 *  loopback literals). The divergence is intentional: a reception share link
 *  is clicked by a visitor the operator deliberately handed an (often intranet)
 *  URL, whereas the ask-landing `answerLink` is EMAILED — read on a phone, off
 *  the LAN, anywhere — so a private/LAN host would email an unreachable link.
 *  Filtering them yields no `answerLink` → text-only asks (answerable on `ui`
 *  + by reply) rather than a broken one (Codex P2 fold). */
const isPrivateOrLocalHost = (rawHost: string): boolean => {
  // url.hostname keeps the brackets for an IPv6 literal — strip them.
  const bracketless = rawHost.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  // ⚠ STRIP ONE TRAILING FQDN ROOT DOT BEFORE THE SUFFIX TESTS. `new URL()`
  //   KEEPS it on a name (`nas.local.`) and drops it on an IPv4 literal, so
  //   without this `nas.local` was recognised and `nas.local.` was not — and
  //   the unrecognised form got an emailed one-click link to an mDNS host no
  //   phone off the LAN can resolve. Found by the three-way agreement ratchet
  //   (`private-host-predicate-agreement.test.ts`), not by any test here.
  const host = bracketless.endsWith('.') ? bracketless.slice(0, -1) : bracketless;
  if (host.length === 0) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  if (host.includes(':')) {
    // IPv6 literal.
    if (host === '::1' || host === '::') return true; // loopback / unspecified
    if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(host)) return true; // fc00::/7 unique-local
    return false; // any other IPv6 = public
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127) return true; // unspecified / loopback 127/8
    if (a === 10) return true; // 10/8
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 169 && b === 254) return true; // 169.254/16 link-local
    // ⛔ 100.64/10 IS NOT REACHABLE FROM THE INTERNET — RFC 6598 shared address
    //   space, which is both carrier-grade NAT and where a Tailscale tailnet
    //   addresses its peers. Without this the builder called a CGNAT'd home
    //   server PUBLIC and emailed a one-click link to an address no inbound
    //   connection can reach, which is exactly the dead link the Codex P2 fold
    //   above exists to prevent. `network/resolve-lan-address.ts` already knew
    //   (`isCgnatIpv4`); this copy did not. ⚠ A /10, NOT A /8 — 100.0.0.1 is a
    //   genuinely public address.
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 RFC 6598
    return false; // any other IPv4 = public
  }
  return false; // a public domain name
};

/** Validate + normalize a candidate public base URL: http/https scheme +
 *  a publicly-reachable host (not loopback / private / link-local / `.local`),
 *  trailing slashes stripped. Returns null when the value is absent /
 *  unparseable / non-http / private. `public-address.ts` runs every candidate
 *  through it, the configured one and each hostname. */
export const resolvePublicBaseUrl = (raw: string | undefined | null): string | null => {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.length === 0) return null;
  const stripped = trimmed.replace(/\/+$/, '');
  try {
    const url = new URL(stripped);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname.length === 0 || isPrivateOrLocalHost(url.hostname)) return null;
    return stripped;
  } catch {
    return null;
  }
};

/** Build the `answerLink` for the email channel from a resolved public base
 *  URL, or null when none (→ the email channel is built without `answerLink`,
 *  i.e. text-only asks). The link points at the `ask` PathRole base
 *  (`/ask/<ask_id>`); the `ask_id` is URL-encoded. */
export const buildAskLandingAnswerLink = (
  baseUrl: string | null,
): ((ask_id: string, via?: string) => string) | null => {
  if (baseUrl === null) return null;
  const base = baseUrl;
  return (ask_id: string, via?: string): string => {
    const path = `${base}${PATH_FOR_ROLE.ask}/${encodeURIComponent(ask_id)}`;
    // D-238 — stamp the ORIGINATING channel so the answer can be attributed to
    // it. Without this every landing-page answer is recorded as `email` (the
    // D-210 finding 15 default), which was already wrong for Slack and becomes a
    // false approval TRAIL once a Teams ask carries the same link. Omitted for a
    // caller that has no channel identity; the page falls back to `email`.
    return via === undefined || via.length === 0
      ? path
      : `${path}?via=${encodeURIComponent(via)}`;
  };
};

/** D-234 § 234.3 — resolve a recipe's `metadata.owner_surface` to an ABSOLUTE
 *  deep link at the webclient, or null when this server has no public base URL.
 *
 *  🔑 THE SPLIT THIS EXISTS TO KEEP: the RECIPE knows which surface reads its
 *  output (it names a `recipe_id`); the HOST knows where this server lives. A
 *  recipe that tried to author the URL itself would emit one that resolves for
 *  nobody — every channel carrying `link_url` needs an absolute url (email
 *  appends it raw, remote passes it through, the ask landing runs it through
 *  `safeHttpUrl`), and only the host knows its public address.
 *
 *  ⚠ Null on a non-public server, exactly like {@link buildAskLandingAnswerLink}
 *  — same resolver, same rule, so an owner never gets a link that cannot
 *  be opened from where the notification reached them.
 *
 *  ⚠ The hash route is the webclient's own (`serializeShellRoute('recipes', id)`
 *  → `#recipes/<id>`); the id is URL-encoded because a recipe id may carry a
 *  `publisher/name` slash. */
export const buildOwnerSurfaceLink = (
  baseUrl: string | null,
): ((recipe_id: string) => string) | null => {
  if (baseUrl === null) return null;
  const base = baseUrl;
  return (recipe_id: string): string =>
    `${base}/#recipes/${encodeURIComponent(recipe_id)}`;
};

/** D-259 — the same absolute-deep-link rule as {@link buildOwnerSurfaceLink},
 *  pointed at the Packs surface. One slug lands on that pack's detail page;
 *  no slug lands on the list, which is the honest target when a notice names
 *  several packs and no single one is "the" destination.
 *
 *  🔑 WHY THIS IS A HOST CONCERN AND NOT A CALLER ONE — the same reason its
 *  sibling exists: the CALLER knows which pack it means, the HOST knows where
 *  this server lives, and `link_url` is a MULTI-CHANNEL field. A bare
 *  `#packs/<slug>` resolves fine in the webclient that rendered the ask, but
 *  the identical field is appended raw into email, passed through to remote
 *  channels, and run through `safeHttpUrl` by the ask landing page — so a
 *  relative hash is a dead link on three of the four roads it travels. Absolute
 *  or nothing.
 *
 *  ⚠ Null on a non-public server, exactly like its sibling — an owner never
 *  gets a link that cannot be opened from where the notification reached them.
 *
 *  ⚠ The hash route is the webclient's own (`serializeShellRoute('packs', slug)`
 *  → `#packs/<slug>`, parsed back by `parsePacksAddress`); the slug is
 *  URL-encoded because a pack slug may carry a `publisher/name` slash. */
export const buildPacksSurfaceLink = (
  baseUrl: string | null,
): ((pack_slug?: string) => string) | null => {
  if (baseUrl === null) return null;
  const base = baseUrl;
  return (pack_slug?: string): string =>
    pack_slug === undefined || pack_slug.length === 0
      ? `${base}/#packs`
      : `${base}/#packs/${encodeURIComponent(pack_slug)}`;
};

/** The absolute Settings -> Updates destination used by owner notifications.
 * Unlike a recipe/pack link this route has no caller-authored identity, so the
 * host resolves one fixed URL. Null on a non-public server: `link_url` travels
 * over email and remote channels, where a bare `#settings/updates` fragment is
 * not actionable. */
export const buildUpdatesSurfaceLink = (baseUrl: string | null): string | null =>
  baseUrl === null ? null : `${baseUrl}/#settings/updates`;

/** D-234 § 234.3 — the whole "does this ask get a link?" decision, in one place.
 *
 *  ⛔ THREE WAYS TO HAVE NO LINK, AND A LINK IS RETURNED ONLY WHEN NONE HOLD:
 *    1. the recipe named no surface;
 *    2. this server has no public base URL (`resolveLink` is null);
 *    3. THE NAMED RECIPE IS NOT INSTALLED HERE.
 *
 *  The third is the one that needs code rather than a comment. The name travels
 *  in a recipe authored by the SENDER and is resolved on the RECEIVER, so it can
 *  perfectly well name something this server has never had — and a dead deep
 *  link in the only notification an owner receives reads as "nothing here" and
 *  as "could not find it" with the same pixels. No link is the honest version.
 *
 *  Extracted from the ceiling so it is provable without booting an executor:
 *  the failing input here is a name that resolves to nothing, which is exactly
 *  what no live drive can arrange (a drive ships both halves of its own pack).
 */
export const resolveOwnerSurfaceUrl = (
  owner_surface: unknown,
  isInstalled: (recipe_id: string) => boolean,
  resolveLink: ((recipe_id: string) => string | undefined) | undefined,
): string | undefined => {
  if (typeof owner_surface !== 'string' || owner_surface === '') return undefined;
  if (!isInstalled(owner_surface)) return undefined;
  return resolveLink?.(owner_surface);
};
