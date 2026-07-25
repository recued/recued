/** D-148 § A.6 — bearer-token extractor shared across ports.
 *
 *  `Authorization: Bearer <token>` is the canonical auth header for
 *  the WS / MCP / webclient surfaces. The extractor is intentionally
 *  permissive on whitespace (the client may use multiple spaces) but
 *  strict on the scheme name + presence of a non-empty token. */

import type { IncomingMessage } from 'node:http';

const BEARER_RE = /^Bearer\s+(.+)$/i;

/** Extract the bearer token from the `Authorization` header. Returns
 *  the trimmed token on success, null otherwise. The substrate
 *  caller is responsible for validating the token against the
 *  per-port store (realm token / MCP token / etc.). */
export const extractBearerToken = (req: IncomingMessage): string | null => {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const match = raw.match(BEARER_RE);
  if (!match) return null;
  const token = match[1]?.trim();
  if (!token || token.length === 0) return null;
  return token;
};
