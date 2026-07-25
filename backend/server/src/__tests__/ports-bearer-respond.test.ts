/** D-148 P6 — bearer extractor + JSON response helper. */

import { describe, expect, it } from 'vitest';
import { extractBearerToken } from '../ports/common/bearer.js';
import { writeJson } from '../ports/common/respond.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const fakeReq = (headers: Record<string, string | string[] | undefined>): IncomingMessage =>
  ({ headers } as unknown as IncomingMessage);

describe('extractBearerToken', () => {
  it('extracts the trimmed token from a well-formed header', () => {
    expect(extractBearerToken(fakeReq({ authorization: 'Bearer abc.def' }))).toBe('abc.def');
  });

  it('case-insensitive on the scheme name', () => {
    expect(extractBearerToken(fakeReq({ authorization: 'bearer x' }))).toBe('x');
    expect(extractBearerToken(fakeReq({ authorization: 'BEARER y' }))).toBe('y');
  });

  it('tolerates extra whitespace between scheme and token', () => {
    expect(extractBearerToken(fakeReq({ authorization: 'Bearer    z' }))).toBe('z');
  });

  it('returns null when the header is absent', () => {
    expect(extractBearerToken(fakeReq({}))).toBeNull();
  });

  it('returns null when the header is not bearer-shaped', () => {
    expect(extractBearerToken(fakeReq({ authorization: 'Basic abc' }))).toBeNull();
  });

  it('returns null when the token is empty', () => {
    expect(extractBearerToken(fakeReq({ authorization: 'Bearer ' }))).toBeNull();
  });
});

class FakeRes {
  statusCode = 0;
  body: string | null = null;
  ended = false;
  private headers: Record<string, string> = {};
  setHeader(key: string, value: string): void { this.headers[key.toLowerCase()] = value; }
  getHeader(key: string): string | undefined { return this.headers[key.toLowerCase()]; }
  end(body?: string): void { this.body = body ?? ''; this.ended = true; }
}

describe('writeJson', () => {
  it('writes the status + content-type + JSON body', () => {
    const res = new FakeRes();
    writeJson(res as unknown as ServerResponse, 200, { hello: 'world' });
    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('application/json');
    expect(res.body).toBe('{"hello":"world"}');
    expect(res.ended).toBe(true);
  });

  it('merges custom headers onto the response', () => {
    const res = new FakeRes();
    writeJson(res as unknown as ServerResponse, 429, { x: 1 }, { 'retry-after': '12' });
    expect(res.getHeader('retry-after')).toBe('12');
  });
});
