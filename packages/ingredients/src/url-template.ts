/** D-112 — URL-safe template interpolation.
 *
 *  Takes a URL template containing `{{ref}}` markers and resolves
 *  each ref through a caller-supplied function, percent-encoding
 *  the value based on the ref's structural position in the URL:
 *
 *    - scheme / host        → pass through (interpolation into host
 *                              is a rare multi-region pattern and
 *                              encoding would break the `.`).
 *    - path segment         → encodeURIComponent OR reject if the
 *                              value contains raw `/`.
 *    - query value          → encodeURIComponent.
 *    - fragment             → pass through (not used by any
 *                              ingredient today).
 *
 *  Rejection cases emit the `URL_REF_INVALID` error code that
 *  parseRecipe / HTTP executor callers surface up to the recipe
 *  layer. Rejected cases:
 *    - Path-segment ref containing `/` (raw or pre-encoded `%2F`
 *      patterns that could decode into traversal).
 *    - Path-segment ref whose resolved value starts with `//`
 *      (protocol-relative URL injection).
 *    - Ref value that itself contains `{{` (nested templating,
 *      likely a bug + potential confusion vector).
 *
 *  Scope note: this module does NOT handle the `{placeholder}`
 *  single-brace syntax buildUrl uses for per-call path params —
 *  that runs AFTER generic ref resolution. interpolateUrl is for
 *  the pre-resolve template pass, or for callers that want
 *  structural-aware interpolation themselves. The HTTP executor
 *  integrates both paths. */

export type UrlRefResolver = (ref: string) => unknown;

export class UrlRefInvalidError extends Error {
  constructor(
    public readonly ref: string,
    message: string,
  ) {
    super(message);
    this.name = 'UrlRefInvalidError';
  }
}

export type UrlRefPosition = 'scheme' | 'host' | 'path' | 'query' | 'fragment';

interface Segment {
  /** Literal fragment of the template (no encoding ever applied). */
  literal: string;
  /** When set, `literal` precedes a `{{ref}}` whose value is interpolated
   *  with `position`-aware encoding. `position` is derived by scanning
   *  `literal` + everything before it. */
  ref?: {
    name: string;
    position: UrlRefPosition;
  };
}

const REF_RE = /\{\{([^}]+)\}\}/g;

/** Scan through the portion of the URL before the ref and classify
 *  which part of the URL the ref lands in. The scan is deliberately
 *  coarse — we look for the `://`, `/`, `?`, `#` boundary markers,
 *  not a full URL parse. */
const classifyPosition = (before: string): UrlRefPosition => {
  const schemeIdx = before.indexOf('://');
  if (schemeIdx === -1) {
    // Relative URL. Presence of `?` / `#` classifies; otherwise path.
    if (before.includes('#')) return 'fragment';
    if (before.includes('?')) return 'query';
    return 'path';
  }
  const afterScheme = before.slice(schemeIdx + 3);
  if (afterScheme.includes('#')) return 'fragment';
  if (afterScheme.includes('?')) return 'query';
  if (afterScheme.includes('/')) return 'path';
  return 'host';
};

const parseSegments = (template: string): Segment[] => {
  const segments: Segment[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  // Reset because we're using a shared regex object.
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(template)) !== null) {
    const literal = template.slice(lastIndex, m.index);
    const beforeWithLiteral = template.slice(0, m.index);
    segments.push({
      literal,
      ref: {
        name: m[1].trim(),
        position: classifyPosition(beforeWithLiteral),
      },
    });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < template.length) {
    segments.push({ literal: template.slice(lastIndex) });
  } else if (segments.length === 0) {
    // No refs at all — return the template as a single literal.
    segments.push({ literal: template });
  }
  return segments;
};

const encodeForPosition = (
  value: string,
  position: UrlRefPosition,
  ref: string,
): string => {
  if (value.includes('{{')) {
    throw new UrlRefInvalidError(
      ref,
      `URL_REF_INVALID: ref '${ref}' value contains nested template syntax ({{...}})`,
    );
  }
  if (position === 'path') {
    if (value.startsWith('//')) {
      throw new UrlRefInvalidError(
        ref,
        `URL_REF_INVALID: ref '${ref}' would inject a protocol-relative URL into a path segment`,
      );
    }
    if (value.includes('/')) {
      throw new UrlRefInvalidError(
        ref,
        `URL_REF_INVALID: ref '${ref}' value contains '/' — path-segment refs must resolve to a single path segment`,
      );
    }
    return encodeURIComponent(value);
  }
  if (position === 'query') {
    return encodeURIComponent(value);
  }
  // scheme / host / fragment pass through — encoding would break
  // structural characters (`.` in hosts, etc.). Ingredients that
  // need those positions carefully choose trusted refs.
  return value;
};

export const interpolateUrl = (
  template: string,
  resolveRef: UrlRefResolver,
): string => {
  const segments = parseSegments(template);
  let out = '';
  for (const seg of segments) {
    out += seg.literal;
    if (!seg.ref) continue;
    const raw = resolveRef(seg.ref.name);
    if (raw == null) {
      // Missing / undefined ref — leave the placeholder in for error
      // reporting downstream. encodeForPosition is skipped so the
      // downstream caller can detect unresolved refs cleanly.
      out += `{{${seg.ref.name}}}`;
      continue;
    }
    const str = typeof raw === 'string' ? raw : String(raw);
    out += encodeForPosition(str, seg.ref.position, seg.ref.name);
  }
  return out;
};

/** Scan a fully-resolved URL string for known path-traversal or
 *  injection patterns. Used as belt-and-suspenders by the HTTP
 *  executor when the engine's generic resolver has already inlined
 *  refs before executeHTTP runs. Raises `URL_REF_INVALID` on the
 *  first hit.
 *
 *  We inspect the raw string — `new URL(...)` normalises `.` / `..`
 *  segments away so parsing-first would silently approve traversal
 *  attempts. Splitting the raw path after the scheme + host lets us
 *  catch the attacker-shaped segment before fetch() sees it. */
export const assertUrlSafe = (url: string): void => {
  // Locate the start of the path. For absolute URLs, skip past
  // `://<host>`; for relative URLs (`/...`), start at the beginning.
  let pathStart = 0;
  const schemeIdx = url.indexOf('://');
  if (schemeIdx !== -1) {
    const afterScheme = url.indexOf('/', schemeIdx + 3);
    if (afterScheme === -1) return; // no path to check
    pathStart = afterScheme;
  }

  // Restrict to the path portion — stop at `?` or `#`.
  let pathEnd = url.length;
  const qIdx = url.indexOf('?', pathStart);
  const hIdx = url.indexOf('#', pathStart);
  if (qIdx !== -1) pathEnd = Math.min(pathEnd, qIdx);
  if (hIdx !== -1) pathEnd = Math.min(pathEnd, hIdx);

  const path = url.slice(pathStart, pathEnd);
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new UrlRefInvalidError(
        'url',
        `URL_REF_INVALID: resolved URL contains path-traversal segment '${seg}'`,
      );
    }
  }
};

/** D-192 #8h — compose a connection.api request URL from the enrolled `base_url` and a
 *  resolved op path, PRESERVING the base_url's path prefix. `new URL(path, base_url)` alone
 *  REPLACES the base path for a leading-slash op path (a WHATWG absolute-path reference), so a
 *  versioned base segment is silently DROPPED (`https://graph.microsoft.com/v1.0` + `/me/…`
 *  resolves to `graph.microsoft.com/me/…`) and every request 404s. OpenAPI semantics
 *  CONCATENATE `server URL + path`, so a leading-slash op path that is RELATIVE to the base
 *  gets the base path prepended.
 *
 *  NOT prepended (each falls through to `new URL` unchanged so the caller's origin + traversal
 *  guards still see it):
 *   - a path already ROOTED at the base path — a vendor-returned continuation cursor
 *     (Graph `@odata.nextLink` → `/v1.0/items`) already carries the prefix, so prepending
 *     would DOUBLE it (`/v1.0/v1.0/items`);
 *   - an origin-only base (no base path to preserve) — behaves exactly as before this fix;
 *   - an absolute (`scheme://…`) or protocol-relative (`//host`) path — a would-be
 *     cross-origin escape the caller MUST still refuse (never silently re-homed onto the base).
 *
 *  Pure; performs no validation of its own — the caller keeps the cross-origin +
 *  path-traversal guards (`assertUrlSafe` on the raw path, origin check on the result). */
export const composeApiUrl = (baseUrl: string, resolvedPath: string): URL => {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  let effective = resolvedPath;
  if (basePath !== '' && resolvedPath.startsWith('/') && !resolvedPath.startsWith('//')) {
    const pathname = resolvedPath.split(/[?#]/, 1)[0];
    const rooted = pathname === basePath || pathname.startsWith(`${basePath}/`);
    if (!rooted) effective = `${basePath}${resolvedPath}`;
  }
  return new URL(effective, baseUrl);
};
