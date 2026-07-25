/** D-158 P2b-ii — the email `answerLink` builder for the notification
 *  ask-landing page.
 *
 *  The email channel's `answerLink?: (ask_id) => string` is injected ONLY on
 *  a publicly-reachable server (the leaf header: "on a public-reachable
 *  server an `answerLink` builder is injected"). The leaf's contract is
 *  binary at construction — a PRESENT `answerLink` makes `deliverAsk` always
 *  carry the one-click link; an ABSENT one keeps asks text-only — so
 *  presence is a boot-time decision, resolved here from the public base URL.
 *
 *  Public base URL source: `RECUED_PUBLIC_BASE_URL` — the explicit, documented
 *  public-base-URL env (`docs/launch-prep/env-gate-inventory.md`), the same
 *  primary source reception's `getShareBaseUrl` reads first. A non-public
 *  deployment (env unset / local host) yields `null` → no `answerLink` → asks
 *  stay text-only, answerable on the always-on `ui` channel + by email reply.
 *
 *  Follow-on: reception's `getShareBaseUrl` additionally falls back to a
 *  verified DDNS hostname from the hostname registry when the env is unset.
 *  Mirroring that here needs the hostname-registry store threaded to the
 *  email-channel construction site; deferred so this slice stays focused. A
 *  deployment that wants the one-click link sets `RECUED_PUBLIC_BASE_URL`. */

import { PATH_FOR_ROLE } from '@recued/contracts';

/** True iff the host is loopback / RFC1918 private / link-local / IPv6 ULA /
 *  mDNS `.local` — i.e. NOT reachable from the public internet.
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
  const host = rawHost.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
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
    return false; // any other IPv4 = public
  }
  return false; // a public domain name
};

/** Validate + normalize a candidate public base URL: http/https scheme +
 *  a publicly-reachable host (not loopback / private / link-local / `.local`),
 *  trailing slashes stripped. Returns null when the value is absent /
 *  unparseable / non-http / private — in which case no `answerLink` is built
 *  and emailed asks stay text-only. */
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
): ((ask_id: string) => string) | null => {
  if (baseUrl === null) return null;
  const base = baseUrl;
  return (ask_id: string): string =>
    `${base}${PATH_FOR_ROLE.ask}/${encodeURIComponent(ask_id)}`;
};
