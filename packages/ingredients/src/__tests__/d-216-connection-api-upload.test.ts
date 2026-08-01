/** D-216 slice 2 — `connection.api` upload wire pieces.
 *
 *  Drives the REAL handler (not the encoder, which slice 1 covers) so the
 *  assertions are about dispatch: which bytes reach `fetch`, which
 *  Content-Type rides with them, and which combinations are refused before
 *  a socket ever opens.
 *
 *  🔑 Every refusal here is `bad_request` on purpose. `body_raw` already
 *  wins silently over `body.*`; adding a third silent winner is how a
 *  caller ships the wrong body and never finds out.
 *
 *  Spec: D-216 § 3, § 4.
 */

import { describe, expect, it } from 'vitest';
import {
  HTTP_UPLOAD_MAX_BYTES_CEILING,
  HTTP_UPLOAD_WIRE_FIELD_KEY,
  HTTP_UPLOAD_WIRE_KIND_KEY,
  HTTP_UPLOAD_WIRE_MAX_BYTES_KEY,
  type ConnectionAuth,
  type ConnectionRow,
} from '@recued/contracts';
import { sha256Hex } from '@recued/crypto/hash';
import {
  createConnectionApiHandler,
  resolveUploadMaxBytes,
  type ConnectionApiHandlerDeps,
} from '../connection-api.js';
import { IngredientError } from '../types.js';

const row: ConnectionRow = {
  pk: 'api:mastodon',
  kind: 'api',
  name: 'mastodon',
  display_name: 'Mastodon',
  config_json: '{"base_url":"https://example.social"}',
  auth_ciphertext: 'opaque',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

const auth: ConnectionAuth = { type: 'bearer', token: 't0ken' } as unknown as ConnectionAuth;

interface Captured { headers: Record<string, string>; body: unknown }

const mk = (
  files: Record<string, { bytes: Uint8Array; mime_type: string; filename: string }> = {},
  opts: { omitReader?: boolean } = {},
): { deps: ConnectionApiHandlerDeps; captured: Captured[] } => {
  const captured: Captured[] = [];
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
      readFileBytes: async (record_id: string) => {
        const hit = files[record_id];
        if (hit === undefined) throw new Error(`no such file: ${record_id}`);
        return hit;
      },
    }),
  };
  return { deps, captured };
};

const call = async (
  deps: ConnectionApiHandlerDeps,
  params: Record<string, unknown>,
  ctx?: {
    setBytes(i: number, o: number): void;
    setUploadContentSha256?(hash: string): void;
  },
): Promise<void> => {
  const handler = createConnectionApiHandler(deps);
  await handler(
    row,
    { method: 'POST', path: '/api/v2/media', ...params },
    { slug: 'mastodon-media', output: {}, input: {} } as never,
    ctx,
  );
};

const png = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]), mime_type: 'image/png', filename: 'poster.png' };
const txt = { bytes: new TextEncoder().encode('hello'), mime_type: 'text/plain', filename: 'a.txt' };

const bodyText = (b: unknown): string =>
  typeof b === 'string' ? b : new TextDecoder().decode(b as Uint8Array);

const multipart = (
  field: string,
  ref: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  [HTTP_UPLOAD_WIRE_KIND_KEY]: 'multipart',
  [HTTP_UPLOAD_WIRE_FIELD_KEY]: field,
  [`body_file.${field}`]: ref,
  ...extra,
});

const binary = (
  ref: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  [HTTP_UPLOAD_WIRE_KIND_KEY]: 'binary',
  body_binary: ref,
  ...extra,
});

describe('D-216 — body_file.* builds one multipart request', () => {
  it('sends the file bytes AND the text fields in a single request', async () => {
    const { deps, captured } = mk({ 'file:abc': png });
    await call(deps, multipart('file', 'file:abc', { 'body.description': 'a poster' }));

    expect(captured).toHaveLength(1);
    const sent = bodyText(captured[0]!.body);
    // The caption rides along as a text part — one request, not two.
    expect(sent).toContain('name="description"');
    expect(sent).toContain('a poster');
    expect(sent).toContain('name="file"; filename="poster.png"');
    expect(sent).toContain('Content-Type: image/png');
  });

  it('sets a multipart Content-Type carrying the generated boundary', async () => {
    const { deps, captured } = mk({ 'file:abc': png });
    await call(deps, multipart('file', 'file:abc'));
    const ct = captured[0]!.headers['content-type'] ?? '';
    expect(ct).toMatch(/^multipart\/form-data; boundary=recued-/);
    // The boundary in the header must be the one in the body, or the far
    // end cannot parse it at all.
    const boundary = ct.split('boundary=')[1]!;
    expect(bodyText(captured[0]!.body)).toContain(`--${boundary}`);
  });

  it('⚠ takes filename + mime from the RECORD, never from the caller', async () => {
    // A recipe naming the file could misrepresent what it is sending.
    const { deps, captured } = mk({ 'file:abc': png });
    await call(deps, multipart('file', 'file:abc', { 'body.filename': 'INNOCENT.txt' }));
    const sent = bodyText(captured[0]!.body);
    expect(sent).toContain('filename="poster.png"');
    expect(sent).toContain('Content-Type: image/png');
  });

  it('refuses an extra undeclared file part before dispatch', async () => {
    const { deps, captured } = mk({ 'file:a': png, 'file:b': txt });
    await expect(call(deps, multipart('one', 'file:a', {
      'body_file.two': 'file:b',
    }))).rejects.toThrow(/exactly its declared body_file field/);
    expect(captured).toHaveLength(0);
  });
});

describe('D-216 — body_binary sends the file AS the body', () => {
  it('sends the exact stored bytes with the record mime type', async () => {
    const { deps, captured } = mk({ 'file:abc': png });
    await call(deps, binary('file:abc'));
    expect(captured[0]!.headers['content-type']).toBe('image/png');
    expect([...(captured[0]!.body as Uint8Array)]).toEqual([...png.bytes]);
  });
});

describe('D-216 — refusals happen BEFORE any socket opens', () => {
  const rejects = async (params: Record<string, unknown>, re: RegExp, files = { 'file:abc': png }) => {
    const { deps, captured } = mk(files);
    await expect(call(deps, params)).rejects.toThrow(re);
    // The load-bearing half: nothing was dispatched.
    expect(captured).toHaveLength(0);
  };

  it('⛔ body_binary + body_file is exclusive, not a precedence rule', async () => {
    await rejects(binary('file:abc', { 'body_file.f': 'file:abc' }), /declared binary|exclusive/);
  });

  it('⛔ body_binary + body.* is exclusive', async () => {
    await rejects(binary('file:abc', { 'body.caption': 'hi' }), /exclusive/);
  });

  it('⛔ body_binary + body_raw is exclusive', async () => {
    await rejects(binary('file:abc', { body_raw: 'x' }), /exclusive/);
  });

  it('⛔ body_file + body_raw is refused', async () => {
    await rejects(multipart('f', 'file:abc', { body_raw: 'x' }), /body_raw/);
  });

  it('⛔ a hand-pinned Content-Type is refused, never silently overwritten', async () => {
    // multipart needs the generated boundary; binary takes the record type.
    await rejects(
      multipart('f', 'file:abc', { 'header.content-type': 'application/json' }),
      /Content-Type/,
    );
  });

  it('⛔ an oversize file is refused before dispatch, never truncated', async () => {
    // A truncated body is accepted and stored by most targets — worse than
    // an error, because it looks like it worked.
    const big = { bytes: new Uint8Array(64), mime_type: 'application/octet-stream', filename: 'b.bin' };
    await rejects(
      binary('file:big', { [HTTP_UPLOAD_WIRE_MAX_BYTES_KEY]: 16 }),
      /exceeds/,
      { 'file:big': big } as never,
    );
  });

  it('refuses a non-string ref', async () => {
    await rejects(binary(42), /file_ref string/);
  });

  it('fails CLOSED when the host cannot resolve refs at all', async () => {
    const { deps, captured } = mk({}, { omitReader: true });
    await expect(call(deps, binary('file:abc'))).rejects.toThrow(IngredientError);
    expect(captured).toHaveLength(0);
  });

  it.each([
    { body_binary: 'file:abc' },
    { 'body_file.file': 'file:abc' },
  ])('⛔ refuses upload wire args without a bind.upload marker (%j)', async (params) => {
    await rejects(params, /requires an engine-owned bind\.upload declaration/);
  });
});

describe('D-216 — the audit identifies the resolved content', () => {
  it('reports the file SHA-256 without logging the bytes', async () => {
    const hashes: string[] = [];
    const { deps } = mk({ 'file:abc': png });
    await call(deps, binary('file:abc'), {
      setBytes: () => {},
      setUploadContentSha256: (hash) => { hashes.push(hash); },
    });
    expect(hashes).toEqual([sha256Hex(png.bytes)]);
  });
});

describe('D-216 — the ordinary body path is untouched', () => {
  it('still sends JSON when no upload piece is present', async () => {
    const { deps, captured } = mk();
    await call(deps, { 'body.status': 'hello' });
    expect(captured[0]!.headers['content-type']).toContain('application/json');
    expect(bodyText(captured[0]!.body)).toBe('{"status":"hello"}');
  });

  it('still honours body_raw', async () => {
    const { deps, captured } = mk();
    await call(deps, { body_raw: 'raw-payload' });
    expect(bodyText(captured[0]!.body)).toBe('raw-payload');
  });
});

describe('D-216 — the per-op ceiling LOWERS only', () => {
  // ⚠ Tested directly rather than through a dispatch: proving "raising is
  // ignored" end-to-end needs a >25 MB buffer, and a test that allocates one
  // to assert a bound is a worse test than one that reads the rule. The
  // dispatch path's use of this function is covered by the size-cap refusal
  // above; this pins the DIRECTION.
  it('clamps a per-op value that tries to RAISE the handler ceiling', () => {
    expect(resolveUploadMaxBytes(HTTP_UPLOAD_MAX_BYTES_CEILING * 4))
      .toBe(HTTP_UPLOAD_MAX_BYTES_CEILING);
  });

  it('honours a per-op value that LOWERS it', () => {
    expect(resolveUploadMaxBytes(1024)).toBe(1024);
  });

  it.each([undefined, null, 'big', 0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the ceiling for a malformed value (%s)',
    (v) => {
      // The authoring validator is where a bad declaration is caught; the
      // handler's job is to stay bounded regardless of what reaches it.
      expect(resolveUploadMaxBytes(v)).toBe(HTTP_UPLOAD_MAX_BYTES_CEILING);
    },
  );
});
