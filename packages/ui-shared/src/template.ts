/** Shared HTML utilities — originally the popup's template module, now
 *  kept as the home for cross-UI helpers after the popup was retired in
 *  favor of side-panel-on-action-click.
 *
 *  Every function here is pure: given inputs, return a string. Imported
 *  by sidebar, options, install, audit, kitchen — anywhere that needs
 *  XSS-safe interpolation, relative timestamps, platform detection, or
 *  URL shortening.
 *
 *  XSS DEFENSE: every user-supplied string (recipe names, URLs,
 *  descriptions) flows through `escapeHtml` before interpolation.
 *  Template literals do NOT escape by default — forget this and a
 *  malicious recipe name becomes script execution. This is the most
 *  important rule in this file.
 */

// ────────────────────────────────────────────────────────────────
// XSS-safe interpolation helpers
// ────────────────────────────────────────────────────────────────

/** Escape HTML special characters. Use for ANY user-supplied string
 *  that ends up inside a template literal. */
export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });

/** Tagged template alias — lets `escapeHtml` act as a marker at the
 *  call site without requiring callers to import a separate function
 *  for every interpolation. */
export const e = escapeHtml;

// ────────────────────────────────────────────────────────────────
// Time formatting
// ────────────────────────────────────────────────────────────────

/** Human-friendly relative time. Buckets: "just now" → "{N}m/h/d ago". */
export const timeAgo = (timestamp: number, now: number = Date.now()): string => {
  const diffMs = Math.max(0, now - timestamp);
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
};

// ────────────────────────────────────────────────────────────────
// Platform detection (cosmetic badge on the current tab)
// ────────────────────────────────────────────────────────────────

/** Best-effort platform detection from URL. Returns the display name
 *  or null if no known platform matches. */
export const detectPlatform = (url: string): string | null => {
  if (!url) return null;
  if (url.includes('hubspot.com')) return 'HubSpot';
  if (url.includes('lightning.force.com') || url.includes('salesforce.com')) return 'Salesforce';
  if (url.includes('pipedrive.com')) return 'Pipedrive';
  if (url.includes('zendesk.com')) return 'Zendesk';
  if (url.includes('intercom.com')) return 'Intercom';
  if (url.includes('mail.google.com')) return 'Gmail';
  if (url.includes('outlook.')) return 'Outlook';
  if (url.includes('slack.com')) return 'Slack';
  return null;
};

/** Shorten a URL to host + first path segment, dropping query/hash. */
export const shortenUrl = (url: string): string => {
  try {
    const u = new URL(url);
    const firstSegment = u.pathname.split('/').filter(Boolean)[0];
    return firstSegment ? `${u.host}/${firstSegment}/…` : u.host;
  } catch {
    return url.length > 60 ? `${url.slice(0, 57)}…` : url;
  }
};
