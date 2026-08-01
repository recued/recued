/** D-216 slice 1 — the multipart encoder.
 *
 *  Every failure this guards against produces a body the far end ACCEPTS and
 *  stores as something subtly different from what was sent — a corrupt asset,
 *  not an error. So the assertions are on exact bytes, not on "it looks about
 *  right".
 *
 *  Spec: D-216 § 3.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeMultipart,
  makeBoundary,
  MultipartEncodeError,
  BOUNDARY_PREFIX,
} from '../multipart.js';

const text = (u: Uint8Array): string => new TextDecoder().decode(u);
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const B = 'recued-TESTBOUNDARY';

describe('D-216 — encodeMultipart byte shape', () => {
  it('emits a field then a file with CRLF everywhere and a closing boundary', () => {
    const out = encodeMultipart(
      [{ name: 'status', value: 'hello world' }],
      [{ name: 'file', filename: 'poster.png', mime_type: 'image/png', bytes: bytes('PNGDATA') }],
      B,
    );
    expect(text(out.body)).toBe(
      `--${B}\r\n`
      + 'Content-Disposition: form-data; name="status"\r\n'
      + '\r\n'
      + 'hello world\r\n'
      + `--${B}\r\n`
      + 'Content-Disposition: form-data; name="file"; filename="poster.png"\r\n'
      + 'Content-Type: image/png\r\n'
      + '\r\n'
      + 'PNGDATA\r\n'
      + `--${B}--\r\n`,
    );
  });

  it('⚠ uses CRLF, never a bare LF', () => {
    // The classic multipart bug: many servers accept bare LF, some parse the
    // first header into the body, and the result is a corrupt asset.
    const out = encodeMultipart([{ name: 'a', value: 'b' }], [], B);
    const s = text(out.body);
    expect(s.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('reports the exact Content-Type the caller must send', () => {
    const out = encodeMultipart([{ name: 'a', value: 'b' }], [], B);
    expect(out.content_type).toBe(`multipart/form-data; boundary=${B}`);
    expect(out.boundary).toBe(B);
  });

  it('preserves order: fields as given, then files as given', () => {
    const out = encodeMultipart(
      [{ name: 'one', value: '1' }, { name: 'two', value: '2' }],
      [
        { name: 'fa', filename: 'a.bin', mime_type: 'application/octet-stream', bytes: bytes('A') },
        { name: 'fb', filename: 'b.bin', mime_type: 'application/octet-stream', bytes: bytes('B') },
      ],
      B,
    );
    const s = text(out.body);
    expect(s.indexOf('name="one"')).toBeLessThan(s.indexOf('name="two"'));
    expect(s.indexOf('name="two"')).toBeLessThan(s.indexOf('name="fa"'));
    expect(s.indexOf('name="fa"')).toBeLessThan(s.indexOf('name="fb"'));
  });

  it('passes binary bytes through untouched', () => {
    // A NUL and a high byte survive — the encoder must never stringify.
    const raw = new Uint8Array([0x00, 0xff, 0x1b, 0x0a, 0x0d, 0x42]);
    const out = encodeMultipart(
      [],
      [{ name: 'f', filename: 'x.bin', mime_type: 'application/octet-stream', bytes: raw }],
      B,
    );
    const marker = bytes('\r\n\r\n');
    let at = -1;
    for (let i = 0; i + marker.length <= out.body.length; i += 1) {
      if (marker.every((b, j) => out.body[i + j] === b)) { at = i + marker.length; break; }
    }
    expect(at).toBeGreaterThan(0);
    expect([...out.body.slice(at, at + raw.length)]).toEqual([...raw]);
  });
});

describe('D-216 — refusals (each one is a header-injection or truncation hole)', () => {
  it.each([
    ['field name', () => encodeMultipart([{ name: 'a\r\nX: y', value: 'v' }], [], B)],
    ['field name quote', () => encodeMultipart([{ name: 'a"b', value: 'v' }], [], B)],
    ['file part name', () => encodeMultipart([], [
      { name: 'f\ni', filename: 'a', mime_type: 'text/plain', bytes: bytes('x') }], B)],
    ['filename', () => encodeMultipart([], [
      { name: 'f', filename: 'a"; name="evil', mime_type: 'text/plain', bytes: bytes('x') }], B)],
    ['mime type', () => encodeMultipart([], [
      { name: 'f', filename: 'a', mime_type: 'text/plain\r\nX: y', bytes: bytes('x') }], B)],
    ['boundary', () => encodeMultipart([{ name: 'a', value: 'v' }], [], 'bad\r\nboundary')],
  ] as const)('refuses CR/LF/quote in the %s', (_what, fn) => {
    expect(fn).toThrow(MultipartEncodeError);
  });

  it('⛔ refuses a part whose BYTES contain the boundary', () => {
    // Otherwise the body terminates early at the receiver and the upload is
    // silently truncated — accepted, stored, wrong.
    expect(() => encodeMultipart([], [{
      name: 'f', filename: 'a.bin', mime_type: 'application/octet-stream',
      bytes: bytes(`padding--${B}--more`),
    }], B)).toThrow(/terminate early/);
  });

  it('refuses an entirely empty body', () => {
    expect(() => encodeMultipart([], [], B)).toThrow(/empty body/);
  });

  it('refuses an empty field name, filename or mime type', () => {
    expect(() => encodeMultipart([{ name: '', value: 'v' }], [], B)).toThrow(/must not be empty/);
    expect(() => encodeMultipart([], [
      { name: 'f', filename: '', mime_type: 't/p', bytes: bytes('x') }], B))
      .toThrow(/must not be empty/);
    expect(() => encodeMultipart([], [
      { name: 'f', filename: 'a', mime_type: '', bytes: bytes('x') }], B))
      .toThrow(/must not be empty/);
  });
});

describe('D-216 — makeBoundary', () => {
  it('is prefixed, long, and drawn from the RFC-safe alphabet', () => {
    const b = makeBoundary();
    expect(b.startsWith(BOUNDARY_PREFIX)).toBe(true);
    expect(b.length).toBeGreaterThan(BOUNDARY_PREFIX.length + 16);
    expect(/^[A-Za-z0-9-]+$/.test(b)).toBe(true);
  });

  it('takes injectable randomness so a body can be pinned byte-for-byte', () => {
    const fixed = makeBoundary(() => 0);
    expect(fixed).toBe(makeBoundary(() => 0));
    expect(fixed).not.toBe(makeBoundary(() => 0.5));
  });

  it('produces a boundary that survives its own encoder', () => {
    expect(() => encodeMultipart([{ name: 'a', value: 'v' }], [], makeBoundary())).not.toThrow();
  });
});
