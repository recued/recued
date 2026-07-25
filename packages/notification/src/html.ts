/** D-158 P2b-ii — HTML rendering-safety helpers for the notification
 *  block's server-rendered surfaces.
 *
 *  Two surfaces interpolate untrusted-shaped strings into HTML: the
 *  `ask` landing page (`channels/ask-landing.ts`) and the email
 *  channel's optional `body_html` (`channels/email.ts`). Both escape
 *  every interpolation through `htmlEscape`, and pass any URL bound for
 *  an `<a href>` through `safeHttpUrl` first.
 *
 *  The leaf is self-contained — `packages/` cannot import
 *  `backend/server`, so the reception port's `htmlEscape`
 *  (`reception-page-render.ts`) is out of reach. This is a block-local
 *  copy, byte-identical in behaviour: it substitutes the five XML
 *  predeclared entities, which is sufficient for both HTML text content
 *  and single/double-quoted attribute values.
 */

const HTML_ESCAPE_TABLE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const HTML_ESCAPE_RE = /[&<>"']/g;

/** Escape a string for safe interpolation into HTML text or a quoted
 *  attribute value. The single escape boundary for the block's rendered
 *  HTML — every interpolation passes through it. */
export const htmlEscape = (raw: string): string =>
  raw.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_TABLE[ch] ?? ch);

/** Return `url` iff it is a plain `http(s)` URL — otherwise `null`. The
 *  guard for any URL bound for an `<a href>`: `htmlEscape` does NOT
 *  neutralise a `javascript:` (or `data:`) scheme — the colon and the
 *  payload survive escaping — so a clickable link needs a scheme
 *  allowlist on top. A `NotificationMessage.link_url` comes from a
 *  trusted flow controller, but rendering it as a link is defense in
 *  depth (and the email `body_html` has no CSP backstop at all). A
 *  non-`http(s)` value is dropped rather than rendered. */
export const safeHttpUrl = (url: string): string | null =>
  /^https?:\/\//i.test(url) ? url : null;
