/** URL pattern matching for ingredient trigger URLs.
 *
 *  Used by both the DOM tab resolver (service worker) and the Chat
 *  adapter to find which open tab matches an ingredient's trigger
 *  pattern. Exported from @recued/ingredients as the single source
 *  of truth for this logic.
 *
 *  Pattern format: `hostname/path*`
 *    - `gemini.google.com/*`        matches any path on gemini.google.com
 *    - `*.salesforce.com/lightning*` matches sub.salesforce.com/lightning/...
 *    - `app.hubspot.com/contacts/*` matches app.hubspot.com/contacts/123
 */

/** Match an ingredient trigger pattern against a full URL.
 *  Returns true if the URL's host and path match the pattern. */
export const matchUrlPattern = (pattern: string, url: string): boolean => {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const path = u.pathname + u.search;

    // Split pattern into host and path parts
    const slashIdx = pattern.indexOf('/');
    const hostPattern = slashIdx >= 0 ? pattern.slice(0, slashIdx) : pattern;
    const pathPattern = slashIdx >= 0 ? pattern.slice(slashIdx) : '/*';

    // Host match: *.example.com matches sub.example.com and example.com
    const hostMatch = hostPattern.startsWith('*.')
      ? host === hostPattern.slice(2) || host.endsWith('.' + hostPattern.slice(2))
      : host === hostPattern;
    if (!hostMatch) return false;

    // Path match: /foo* matches /foo, /foobar, /foo/bar
    if (pathPattern === '/*' || pathPattern === '*') return true;
    const base = pathPattern.endsWith('*') ? pathPattern.slice(0, -1) : pathPattern;
    return path.startsWith(base);
  } catch {
    return false;
  }
};
