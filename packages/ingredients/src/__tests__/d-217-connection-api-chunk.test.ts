/** D-217 slice 2b-ii — the chunk wire piece on `connection.api`.
 *
 *  Drives the REAL handler, so every assertion is about what reaches `fetch`.
 *
 *  🔑 **The property under test is mostly a NEGATIVE one: the chunk's bytes are
 *  not in the dispatch input.** That is not stylistic. The commit gateway
 *  persists a dispatch's input as the commit's `args` (`pending.args = input`,
 *  then `writePending`) and hashes it for the action identity — so literal
 *  bytes on the wire would write the owner's file into the durable commit log
 *  once per APPEND. The input carries a staging TOKEN plus a range; the bytes
 *  are resolved on this side. A test that only checked "the right bytes were
 *  sent" would pass just as happily with the bytes in the input, which is why
 *  the input itself is asserted.
 *
 *  Spec: D-217 § 9.4, § 9.
 */

import { describe, expect, it } from 'vitest';
import {
  CHUNKED_UPLOAD_WIRE_LENGTH_KEY,
  CHUNKED_UPLOAD_WIRE_OFFSET_KEY,
  CHUNKED_UPLOAD_WIRE_TOKEN_KEY,
  CHUNKED_UPLOAD_WIRE_FIELD_KEY,
  HTTP_UPLOAD_MAX_BYTES_CEILING,
  HTTP_UPLOAD_WIRE_KIND_KEY,
  type ConnectionAuth,
  type ConnectionRow,
} from '@recued/contracts';
import {
  createConnectionApiHandler,
  type ConnectionApiHandlerDeps,
} from '../connection-api.js';
import { IngredientError } from '../types.js';

const row: ConnectionRow = {
  pk: 'api:x-media',
  kind: 'api',
  name: 'x-media',
  display_name: 'X media',
  config_json: '{"base_url":"https://upload.example.com"}',
  auth_ciphertext: 'opaque',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

const auth: ConnectionAuth = { type: 'bearer', token: 't0ken' } as unknown as ConnectionAuth;

/** The staged file the fake registry serves ranges out of. */
const STAGED = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));
const TOKEN = 'a1b2c3d4e5f6';

interface Captured { headers: Record<string, string>; body: unknown }

interface Reads { token: string; offset: number; length: number }

const mk = (
  opts: {
    omitReader?: boolean;
    /** Return this many bytes regardless of the range asked for — the
     *  short-read case a real staging handle refuses but a wired dep might
     *  not. */
    returnBytes?: number;
  } = {},
): {
  deps: ConnectionApiHandlerDeps;
  captured: Captured[];
  reads: Reads[];
} => {
  const captured: Captured[] = [];
  const reads: Reads[] = [];
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    captured.push({ headers, body: init?.body });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const deps: ConnectionApiHandlerDeps = {
    decodeAuth: async () => auth,
    persistAuth: async () => {},
    fetchImpl,
    ...(opts.omitReader === true ? {} : {
      readUploadChunk: async (token: string, offset: number, length: number) => {
        reads.push({ token, offset, length });
        if (token !== TOKEN) throw new Error('upload-staging: unknown or disposed staging token');
        const take = opts.returnBytes ?? length;
        return { bytes: STAGED.slice(offset, offset + take), mime_type: 'video/mp4' };
      },
    }),
    // Present so an exclusivity test can reach the refusal rather than the
    // fail-closed branch of the OTHER upload shape.
    readFileBytes: async () => ({
      bytes: new Uint8Array([1, 2, 3]), mime_type: 'image/png', filename: 'p.png',
    }),
  };
  return { deps, captured, reads };
};

const call = async (
  deps: ConnectionApiHandlerDeps,
  params: Record<string, unknown>,
): Promise<void> => {
  const handler = createConnectionApiHandler(deps);
  await handler(
    row,
    { method: 'POST', path: '/1.1/media/upload.json', ...params },
    { slug: 'x-media', output: {}, input: {} } as never,
  );
};

const chunk = (offset: number, length: number): Record<string, unknown> => ({
  [CHUNKED_UPLOAD_WIRE_TOKEN_KEY]: TOKEN,
  [CHUNKED_UPLOAD_WIRE_OFFSET_KEY]: offset,
  [CHUNKED_UPLOAD_WIRE_LENGTH_KEY]: length,
});

const failure = async (
  deps: ConnectionApiHandlerDeps,
  params: Record<string, unknown>,
): Promise<IngredientError> => {
  try {
    await call(deps, params);
  } catch (e) {
    if (e instanceof IngredientError) return e;
    throw e;
  }
  throw new Error('expected the dispatch to be refused');
};

describe('D-217 — a chunk is sent by REF, and the bytes never enter the input', () => {
  it('sends exactly the requested range, with the staged record\'s Content-Type', async () => {
    const { deps, captured, reads } = mk();
    await call(deps, chunk(16, 8));

    expect(reads).toEqual([{ token: TOKEN, offset: 16, length: 8 }]);
    expect(captured).toHaveLength(1);
    // The body is the RANGE, not the whole staged file — the entire point of
    // staging (slice 0) is that a 512 MB file never becomes a 512 MB body.
    expect(new Uint8Array(captured[0]!.body as Uint8Array)).toEqual(STAGED.slice(16, 24));
    expect(captured[0]!.headers['content-type']).toBe('video/mp4');
  });

  it('⛔ the request body carries the bytes and the INPUT never does', async () => {
    // The load-bearing assertion of this slice. `pending.args = input` is
    // persisted durably by the commit gateway, so a chunk visible in the input
    // is the owner's file in the commit log — once per APPEND.
    const { deps, captured } = mk();
    const params = chunk(0, 32);
    await call(deps, params);

    const sentBody = new Uint8Array(captured[0]!.body as Uint8Array);
    expect(sentBody).toEqual(STAGED.slice(0, 32));
    // Nothing in the dispatch input resembles the payload: only a token and
    // two integers crossed.
    for (const value of Object.values(params)) {
      expect(value instanceof Uint8Array).toBe(false);
      expect(ArrayBuffer.isView(value)).toBe(false);
    }
    expect(JSON.stringify(params)).not.toContain('31');
    expect(Object.keys(params).sort()).toEqual([
      CHUNKED_UPLOAD_WIRE_LENGTH_KEY,
      CHUNKED_UPLOAD_WIRE_OFFSET_KEY,
      CHUNKED_UPLOAD_WIRE_TOKEN_KEY,
    ].sort());
  });

  it('reads the range ONCE per dispatch — a re-read would double the AES cost slice 0 exists to avoid', async () => {
    const { deps, reads } = mk();
    await call(deps, chunk(8, 4));
    expect(reads).toHaveLength(1);
  });
});

describe('D-217 — fail closed before a socket opens', () => {
  it('refuses when the host wired no chunk reader', async () => {
    const { deps, captured } = mk({ omitReader: true });
    const err = await failure(deps, chunk(0, 8));
    expect(err.code).toBe('SERVER_NOT_REACHABLE');
    // Fail CLOSED means no request at all, not an empty body the target
    // would accept and store.
    expect(captured).toHaveLength(0);
  });

  it('refuses an unknown / disposed staging token', async () => {
    const { deps, captured } = mk();
    await expect(call(deps, {
      ...chunk(0, 8),
      [CHUNKED_UPLOAD_WIRE_TOKEN_KEY]: 'not-a-live-token',
    })).rejects.toThrow(/unknown or disposed staging token/);
    expect(captured).toHaveLength(0);
  });

  it.each([
    ['an empty token', { [CHUNKED_UPLOAD_WIRE_TOKEN_KEY]: '' }],
    ['a non-string token', { [CHUNKED_UPLOAD_WIRE_TOKEN_KEY]: 42 }],
    ['a negative offset', { [CHUNKED_UPLOAD_WIRE_OFFSET_KEY]: -1 }],
    ['a fractional offset', { [CHUNKED_UPLOAD_WIRE_OFFSET_KEY]: 1.5 }],
    ['a string offset', { [CHUNKED_UPLOAD_WIRE_OFFSET_KEY]: '0' }],
    ['a zero length', { [CHUNKED_UPLOAD_WIRE_LENGTH_KEY]: 0 }],
    ['a negative length', { [CHUNKED_UPLOAD_WIRE_LENGTH_KEY]: -8 }],
    ['a fractional length', { [CHUNKED_UPLOAD_WIRE_LENGTH_KEY]: 8.5 }],
    ['a string length', { [CHUNKED_UPLOAD_WIRE_LENGTH_KEY]: '8' }],
  ])('refuses %s', async (_name, override) => {
    const { deps, captured, reads } = mk();
    const err = await failure(deps, { ...chunk(0, 8), ...override });
    expect(err.code).toBe('BAD_INPUT');
    // Refused BEFORE the staged file is even touched.
    expect(reads).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  it('refuses a chunk over the per-REQUEST ceiling — the 512 MB bound is on the WALK', async () => {
    // One chunk is one body held in memory, so it inherits the one-shot
    // ceiling for exactly the reason D-216 § 4 set it.
    const { deps, captured, reads } = mk();
    const err = await failure(deps, chunk(0, HTTP_UPLOAD_MAX_BYTES_CEILING + 1));
    expect(err.code).toBe('BAD_INPUT');
    expect(err.message).toContain('per-request ceiling');
    expect(reads).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  it('refuses a SHORT read rather than sending a truncated chunk', async () => {
    // The staging handle refuses this itself (slice 0), but it is a dep here
    // and a dep is whatever the host wired. Most targets accept and store a
    // truncated chunk, so the corrupt asset would be indistinguishable from a
    // good one.
    const { deps, captured } = mk({ returnBytes: 3 });
    const err = await failure(deps, chunk(0, 8));
    expect(err.code).toBe('BAD_INPUT');
    expect(err.message).toContain('3 bytes for a 8-byte range');
    expect(captured).toHaveLength(0);
  });
});

describe('D-217 — the chunk body is exclusive against every other body shape', () => {
  it.each([
    ['body_file.*', { 'body_file.file': 'file:abc' }],
    ['body_binary', { body_binary: 'file:abc' }],
  ])('refuses a chunk combined with %s', async (_name, other) => {
    const { deps, captured } = mk();
    const err = await failure(deps, { ...chunk(0, 8), ...other });
    expect(err.code).toBe('BAD_INPUT');
    expect(err.message).toContain('exclusive');
    expect(captured).toHaveLength(0);
  });

  it('refuses a chunk combined with body_raw', async () => {
    const { deps, captured } = mk();
    const err = await failure(deps, { ...chunk(0, 8), body_raw: '{"a":1}' });
    expect(err.code).toBe('BAD_INPUT');
    expect(err.message).toContain('exclusive');
    expect(captured).toHaveLength(0);
  });

  it('refuses body.* beside a RAW chunk — the chunk is the whole body', async () => {
    // ⚠ **This rule NARROWED in slice 4, deliberately.** It used to refuse
    // `body.*` beside ANY chunk. The asymmetry is the ENCODING, not a policy: a
    // raw chunk IS the request body, so a sibling field has nowhere to go and
    // accepting one would mean silently dropping it. A MULTIPART chunk is one
    // part among several and can carry them — see the test below, and § 9.12.
    const { deps, captured } = mk();
    const err = await failure(deps, { ...chunk(0, 8), 'body.caption': 'hi' });
    expect(err.code).toBe('BAD_INPUT');
    expect(err.message).toContain('nowhere to go');
    expect(captured).toHaveLength(0);
  });

  it('⛔ sends body.* as TEXT PARTS beside a MULTIPART chunk — X\'s APPEND needs it', async () => {
    // 🔑 **The one protocol this D exists to unblock was inexpressible without
    // this.** X's v2 APPEND is `POST /2/media/upload/{id}/append` carrying
    // `media` (the chunk) AND `segment_index` as a sibling form field. A
    // blanket `body.*` refusal made that impossible to declare — found, as § 9.6
    // said it would be, by asking what the real pack needs.
    const { deps, captured } = mk();
    await call(deps, {
      ...chunk(16, 8),
      [CHUNKED_UPLOAD_WIRE_FIELD_KEY]: 'media',
      'body.segment_index': '3',
    });

    expect(captured).toHaveLength(1);
    const body = new TextDecoder().decode(captured[0]!.body as Uint8Array);
    // The chunk part, named as declared…
    expect(body).toContain('name="media"');
    expect(body).toContain('filename="chunk"');
    // …and the sibling field beside it, in the SAME request.
    expect(body).toContain('name="segment_index"');
    expect(body).toContain('3');
    expect(captured[0]!.headers['content-type']).toContain('multipart/form-data');
  });

  it('coerces a non-string sibling field rather than dropping it', async () => {
    // The engine substitutes `{segment_index}` as text, but a phase's own args
    // can be numeric. Same coercion the one-shot path uses — the alternative is
    // a field that vanishes.
    const { deps, captured } = mk();
    await call(deps, {
      ...chunk(0, 8),
      [CHUNKED_UPLOAD_WIRE_FIELD_KEY]: 'media',
      'body.segment_index': 0,
    });
    const body = new TextDecoder().decode(captured[0]!.body as Uint8Array);
    expect(body).toContain('name="segment_index"');
    expect(body).toMatch(/name="segment_index"[\s\S]*?\r\n\r\n0\r\n/);
  });

  it('refuses a pinned Content-Type — the chunk brings the staged record\'s own', async () => {
    const { deps, captured } = mk();
    const err = await failure(deps, {
      ...chunk(0, 8),
      'header.content-type': 'application/octet-stream',
    });
    expect(err.code).toBe('BAD_INPUT');
    expect(captured).toHaveLength(0);
  });
});

describe('D-217 — the ordinary paths are untouched', () => {
  it('a request with no chunk key still builds its JSON body', async () => {
    const { deps, captured, reads } = mk();
    await call(deps, { 'body.status': 'hello' });
    expect(reads).toHaveLength(0);
    expect(captured[0]!.headers['content-type']).toContain('application/json');
    expect(String(captured[0]!.body)).toContain('hello');
  });

  it('a one-shot body_binary upload still resolves through readFileBytes', async () => {
    const { deps, captured, reads } = mk();
    await call(deps, {
      [HTTP_UPLOAD_WIRE_KIND_KEY]: 'binary',
      body_binary: 'file:abc',
    });
    expect(reads).toHaveLength(0);
    expect(new Uint8Array(captured[0]!.body as Uint8Array)).toEqual(new Uint8Array([1, 2, 3]));
    expect(captured[0]!.headers['content-type']).toBe('image/png');
  });
});

describe('D-217 — a chunk can go as a named multipart part, not only raw', () => {
  // 🔑 `chunked` is ORTHOGONAL to `multipart` / `binary`: the first answers how
  //  many requests, the second how the bytes sit in each one. The first cut of
  //  this slice collapsed them and made every chunked protocol raw-only.

  const bodyText = (b: unknown): string =>
    typeof b === 'string' ? b : new TextDecoder().decode(b as Uint8Array);

  it('sends the chunk as a form part under the declared field name', async () => {
    const { deps, captured } = mk();
    await call(deps, { ...chunk(16, 8), [CHUNKED_UPLOAD_WIRE_FIELD_KEY]: 'media' });

    const ct = captured[0]!.headers['content-type'] ?? '';
    expect(ct).toMatch(/^multipart\/form-data; boundary=recued-/);
    const sent = bodyText(captured[0]!.body);
    expect(sent).toContain('name="media"');
    // The boundary in the header must be the one in the body, or the far end
    // cannot parse it at all.
    expect(sent).toContain(`--${ct.split('boundary=')[1]!}`);
  });

  it('the part carries the EXACT chunk bytes, not the whole staged file', async () => {
    const { deps, captured } = mk();
    await call(deps, { ...chunk(0, 4), [CHUNKED_UPLOAD_WIRE_FIELD_KEY]: 'media' });
    const body = captured[0]!.body as Uint8Array;
    // The raw bytes 0x00-0x03 must appear verbatim inside the encoded part.
    const hay = Buffer.from(body);
    expect(hay.includes(Buffer.from(STAGED.slice(0, 4)))).toBe(true);
    // …and the range must still be a RANGE: byte 8 belongs to no other chunk.
    expect(hay.includes(Buffer.from(STAGED.slice(0, 12)))).toBe(false);
  });

  it("⚠ the part filename is the literal 'chunk', never the owner's filename", async () => {
    // A chunk is one slice of a multi-request upload, not a file in its own
    // right. Repeating the record's filename on every APPEND would disclose it
    // N times for no protocol benefit.
    const { deps, captured } = mk();
    await call(deps, { ...chunk(0, 8), [CHUNKED_UPLOAD_WIRE_FIELD_KEY]: 'media' });
    expect(bodyText(captured[0]!.body)).toContain('filename="chunk"');
  });

  it('ABSENCE of the field key still means a raw body — presence IS the encoding', async () => {
    const { deps, captured } = mk();
    await call(deps, chunk(0, 8));
    expect(captured[0]!.headers['content-type']).toBe('video/mp4');
    expect(new Uint8Array(captured[0]!.body as Uint8Array)).toEqual(STAGED.slice(0, 8));
  });

  it.each([
    ['an empty field name', ''],
    ['a whitespace-only field name', '  '],
    ['a non-string field name', 7],
  ])('refuses %s rather than building a nameless part', async (_n, field) => {
    // A nameless form part is accepted and then ignored by most targets — a
    // chunk silently dropped.
    const { deps, captured } = mk();
    const err = await failure(deps, { ...chunk(0, 8), [CHUNKED_UPLOAD_WIRE_FIELD_KEY]: field });
    expect(err.code).toBe('BAD_INPUT');
    expect(captured).toHaveLength(0);
  });
});
