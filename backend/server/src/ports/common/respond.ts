/** D-148 § A.6 — JSON response helper shared across ports. */

import type { ServerResponse } from 'node:http';

/** Write a JSON-shaped response with the given status code. The
 *  helper is single-purpose: every port emits JSON, so we don't
 *  pay the matrix of negotiation. */
export const writeJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (headers) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  }
  res.end(JSON.stringify(body));
};
