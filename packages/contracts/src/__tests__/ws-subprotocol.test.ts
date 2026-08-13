/** The WS bearer's `Sec-WebSocket-Protocol` carrier.
 *
 *  Three surfaces encode/decode this — the webclient, the Bridge, the server —
 *  and a disagreement fails CLOSED: the server sees no bearer, the handshake
 *  401s, and every client of that surface stops connecting. So the round-trip is
 *  proven here rather than assumed, over the REAL bearer shape.
 *
 *  The token-safety assertion is the one that matters most. A subprotocol value
 *  must be an RFC 7230 `token`; the structured bearer is standard base64, whose
 *  `/` and `=` are not token characters. Sent raw, a browser rejects it at the
 *  `WebSocket` constructor with a SyntaxError — before a byte reaches the
 *  server, and with no server-side evidence that anything happened. */

import { describe, expect, it } from 'vitest';

import {
  WS_BEARER_SUBPROTOCOL_PREFIX,
  WS_VERSION_SUBPROTOCOL,
  decodeBearerSubprotocol,
  encodeBearerSubprotocol,
} from '../ws-subprotocol.js';

/** RFC 7230 token characters — the complete set a subprotocol value may use. */
const TOKEN_CHARS = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** The real shape: `<token_id>.<bearer>` — 16-char base64 (padding stripped) and
 *  44-char standard base64 (padding kept), per `STRUCTURED_BEARER_TOKEN_ID_LEN`
 *  and `STRUCTURED_BEARER_LEN` in `ws-server.ts`. Deliberately built to contain
 *  the characters that break a naive encoding: `+`, `/`, `=`. */
const realisticBearer = (): string => {
  const tokenId = 'ab+/cdEF12345678'.slice(0, 16);
  const bearer = `${'xy+/z'.repeat(8)}abc=`.slice(0, 43) + '=';
  return `${tokenId}.${bearer}`;
};

describe('WS bearer subprotocol codec', () => {
  it('round-trips the real structured bearer shape', () => {
    const bearer = realisticBearer();
    expect(decodeBearerSubprotocol([WS_VERSION_SUBPROTOCOL, encodeBearerSubprotocol(bearer)]))
      .toBe(bearer);
  });

  it('encodes to something a WebSocket constructor will actually accept', () => {
    // The failure this prevents is invisible server-side: an invalid
    // subprotocol throws in the browser before the handshake is sent.
    const encoded = encodeBearerSubprotocol(realisticBearer());
    expect(encoded.startsWith(WS_BEARER_SUBPROTOCOL_PREFIX)).toBe(true);
    expect(encoded, `"${encoded}" contains a non-token character`).toMatch(TOKEN_CHARS);
    // And specifically none of the base64 characters that are NOT token-safe.
    expect(encoded).not.toMatch(/[/=]/);
  });

  it('round-trips bearers containing every base64 character', () => {
    for (const bearer of [
      'a/b+c=',
      '////++++====',
      'AAAA.BBBB//CC++DD==',
      'x'.repeat(61),
      'unicode-≈-∆-safe',
    ]) {
      const encoded = encodeBearerSubprotocol(bearer);
      expect(encoded, bearer).toMatch(TOKEN_CHARS);
      expect(decodeBearerSubprotocol([encoded]), bearer).toBe(bearer);
    }
  });

  it('accepts the raw comma-separated header form the wire delivers', () => {
    const bearer = realisticBearer();
    const header = `${WS_VERSION_SUBPROTOCOL}, ${encodeBearerSubprotocol(bearer)}`;
    expect(decodeBearerSubprotocol(header)).toBe(bearer);
  });

  it('returns null — never a partial value — for anything malformed', () => {
    for (const bad of [
      undefined,
      '',
      WS_VERSION_SUBPROTOCOL,                    // no bearer offered at all
      'bearer.',                                 // prefix, no payload
      'bearer.!!!not-base64url!!!',              // outside the alphabet
      'Bearer.YWJj',                             // case-sensitive prefix
      'notbearer.YWJj',
    ]) {
      expect(decodeBearerSubprotocol(bad as never), String(bad)).toBeNull();
    }
  });

  it('ignores a non-bearer subprotocol sitting alongside', () => {
    const bearer = realisticBearer();
    expect(decodeBearerSubprotocol(['some.other.protocol', encodeBearerSubprotocol(bearer)]))
      .toBe(bearer);
  });

  it('does not treat the version marker as a bearer', () => {
    // If it did, the server would try to authenticate 'recued.v1' as a token on
    // every connection — a guaranteed Argon2id call per handshake.
    expect(decodeBearerSubprotocol([WS_VERSION_SUBPROTOCOL])).toBeNull();
  });
});
