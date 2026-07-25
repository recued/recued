/** D-148 P6 — webhook HMAC primitives + Slack signature verifier. */

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  hmacSha256Hex,
  constantTimeEqualHex,
  verifySlackSignature,
} from '../ports/webhook/hmac.js';

describe('hmacSha256Hex', () => {
  it('returns a 64-char hex string', () => {
    const out = hmacSha256Hex('s', 'm');
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the node crypto reference', () => {
    const ref = createHmac('sha256', 'secret').update('payload').digest('hex');
    expect(hmacSha256Hex('secret', 'payload')).toBe(ref);
  });

  it('handles Buffer payloads', () => {
    const out = hmacSha256Hex('s', Buffer.from('m', 'utf-8'));
    expect(out).toBe(hmacSha256Hex('s', 'm'));
  });
});

describe('constantTimeEqualHex', () => {
  it('returns true on equal hex digests', () => {
    const ref = hmacSha256Hex('s', 'm');
    expect(constantTimeEqualHex(ref, ref)).toBe(true);
  });

  it('returns false on differing digests of same length', () => {
    const a = hmacSha256Hex('s', 'a');
    const b = hmacSha256Hex('s', 'b');
    expect(constantTimeEqualHex(a, b)).toBe(false);
  });

  it('returns false on different lengths (no leak via length)', () => {
    expect(constantTimeEqualHex('abcd', 'abcdef')).toBe(false);
  });

  it('returns false on non-hex input', () => {
    expect(constantTimeEqualHex('xx', 'yy')).toBe(false);
  });
});

describe('verifySlackSignature', () => {
  const secret = 'slack-signing-secret';
  const buildSig = (ts: string, body: string): string => {
    const h = createHmac('sha256', secret);
    h.update(`v0:${ts}:${body}`);
    return `v0=${h.digest('hex')}`;
  };

  it('accepts a well-formed Slack signature', () => {
    const ts = '1700000000';
    const body = '{"event":"message"}';
    const sig = buildSig(ts, body);
    expect(
      verifySlackSignature({
        signing_secret: secret,
        timestamp: ts,
        body: Buffer.from(body, 'utf-8'),
        signature: sig,
      }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const ts = '1700000000';
    const sig = buildSig(ts, '{"event":"message"}');
    expect(
      verifySlackSignature({
        signing_secret: secret,
        timestamp: ts,
        body: Buffer.from('{"event":"tampered"}', 'utf-8'),
        signature: sig,
      }),
    ).toBe(false);
  });

  it('rejects a wrong-secret signature', () => {
    const ts = '1700000000';
    const body = '{"event":"message"}';
    const sig = buildSig(ts, body);
    expect(
      verifySlackSignature({
        signing_secret: 'different-secret',
        timestamp: ts,
        body: Buffer.from(body, 'utf-8'),
        signature: sig,
      }),
    ).toBe(false);
  });

  it('rejects a signature missing the v0= prefix', () => {
    const ts = '1700000000';
    const body = '{}';
    const sig = buildSig(ts, body).slice(3); // strip v0=
    expect(
      verifySlackSignature({
        signing_secret: secret,
        timestamp: ts,
        body: Buffer.from(body, 'utf-8'),
        signature: sig,
      }),
    ).toBe(false);
  });
});
