/** "Watch this element" — URL → Chrome match-pattern derivation (brick 3).
 *
 *  The picker reports the picked page's `location.href`; the SW turns it
 *  into the dom-watch's first half — a Chrome match pattern naming the
 *  tab/origin (`triggers.createElementWatch`'s `url`). Fork-4 resolution:
 *  keep the path up to the leaf and wildcard the leaf (the leaf is usually
 *  a per-record id), e.g. `https://app.hubspot.com/contacts/123` →
 *  `https://app.hubspot.com/contacts/*`. A path with 0/1 segments collapses
 *  to the whole origin (`/*`).
 *
 *  Owner decision #1 ("one gesture → working watch") + #3 (the watch lands
 *  DISARMED, enabled in the webclient) ⇒ the SW auto-derives this; the user
 *  adjusts/enables it in the webclient's #automation surface. The selector
 *  was already user-editable in the in-page overlay (brick 2), so no
 *  in-panel edit form is added (thin/stateless).
 *
 *  Pure (no chrome/DOM); imports only the contracts validity grammar so the
 *  derived pattern fails closed the same way the rpc validates it. */

import { isValidChromeMatchPattern } from '@recued/contracts';

/** Derive a whitespace-free Chrome match pattern from a picked page URL.
 *  `http`/`https` only (a dom watch can't poll `chrome://` / `file://` /
 *  extension pages). Returns `null` when the URL is unparseable, not a web
 *  URL, or can't yield a valid pattern even after the whole-origin fallback. */
export const deriveWatchUrlPattern = (page_url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(page_url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // `host` keeps an explicit port if present; `isValidChromeMatchPattern`
  // (and the rpc that re-validates) accept it.
  const origin = `${parsed.protocol}//${parsed.host}`;
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  const kept = segments.slice(0, -1);
  const path = kept.length > 0 ? `/${kept.join('/')}/*` : '/*';
  const pattern = `${origin}${path}`;
  if (!pattern.includes(' ') && isValidChromeMatchPattern(pattern)) {
    return pattern;
  }
  // Fall back to the whole origin before giving up.
  const wholeOrigin = `${origin}/*`;
  return !wholeOrigin.includes(' ') && isValidChromeMatchPattern(wholeOrigin)
    ? wholeOrigin
    : null;
};
