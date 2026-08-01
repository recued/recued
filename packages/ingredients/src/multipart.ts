/** D-216 slice 1 — `multipart/form-data` body construction.
 *
 *  Pure: (fields, files, boundary) → bytes. No connection, no record store,
 *  no socket. Separated from the handler on purpose — this is the piece most
 *  likely to be subtly wrong (CRLF discipline, boundary choice, filename
 *  quoting), and every one of those failures produces a body a server
 *  ACCEPTS and stores as something subtly different from what was sent.
 *
 *  RFC 7578 / RFC 2046 in the shape this codebase needs:
 *
 *    --boundary CRLF
 *    Content-Disposition: form-data; name="caption" CRLF
 *    CRLF
 *    <text> CRLF
 *    --boundary CRLF
 *    Content-Disposition: form-data; name="file"; filename="poster.png" CRLF
 *    Content-Type: image/png CRLF
 *    CRLF
 *    <bytes> CRLF
 *    --boundary-- CRLF
 *
 *  ⚠ Line endings are CRLF everywhere and are NOT negotiable — a bare LF is
 *  the classic multipart bug: many servers accept it, some parse the first
 *  header into the body, and the failure is a corrupt asset rather than an
 *  error.
 */

/** A text part — a scalar `body.<k>` riding along with the file. */
export interface MultipartField {
  name: string;
  value: string;
}

/** A file part. `filename` and `mime_type` come from the resolved
 *  `data.file` record, never from the caller — the caller supplies a
 *  `file_ref`, and letting it also name the file would let a recipe
 *  misrepresent what it is sending. */
export interface MultipartFile {
  /** The form field name the target expects (`file`, `media`, `source`…). */
  name: string;
  filename: string;
  mime_type: string;
  bytes: Uint8Array;
}

/** Thrown for input this module refuses to encode. The handler maps it to
 *  `bad_request` — every case here is a caller/authoring error, never a
 *  runtime condition. */
export class MultipartEncodeError extends Error {}

/** Characters that may not appear in a part name or filename.
 *
 *  CR and LF are the load-bearing ones: either would let a value inject its
 *  own headers or terminate the part early (a header-injection hole, not a
 *  formatting nit). `"` is excluded because the value is emitted inside a
 *  quoted-string and RFC 7578 §5.1 prefers rejecting over escaping. */
const FORBIDDEN_IN_TOKEN = /[\r\n"]/;

const assertToken = (value: string, what: string): void => {
  if (value.length === 0) {
    throw new MultipartEncodeError(`multipart: ${what} must not be empty`);
  }
  if (FORBIDDEN_IN_TOKEN.test(value)) {
    throw new MultipartEncodeError(
      `multipart: ${what} must not contain CR, LF or a double quote — `
        + `such a value could inject part headers`,
    );
  }
};

/** A `Content-Type` value is emitted unquoted, so it may not carry CR/LF
 *  either. Quotes are legal in a media-type parameter, so they are allowed. */
const assertMimeType = (value: string): void => {
  if (value.length === 0) {
    throw new MultipartEncodeError('multipart: mime_type must not be empty');
  }
  if (/[\r\n]/.test(value)) {
    throw new MultipartEncodeError(
      'multipart: mime_type must not contain CR or LF',
    );
  }
};

/** Boundary charset per RFC 2046 §5.1.1 (the safe subset — no space, which is
 *  legal but only in the middle and is a needless hazard). */
const BOUNDARY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const BOUNDARY_PREFIX = 'recued-';
const BOUNDARY_RANDOM_LEN = 24;

/** Mint a boundary. Injectable randomness so a test can pin the bytes — the
 *  encoder is otherwise fully deterministic, which is the point of having it
 *  as a pure function at all. */
export const makeBoundary = (
  random: () => number = Math.random,
): string => {
  let out = BOUNDARY_PREFIX;
  for (let i = 0; i < BOUNDARY_RANDOM_LEN; i += 1) {
    out += BOUNDARY_ALPHABET[Math.floor(random() * BOUNDARY_ALPHABET.length)];
  }
  return out;
};

/** True when `boundary` appears anywhere in a part's bytes — which would let
 *  the body terminate early at the receiver. Astronomically unlikely with a
 *  minted boundary, and checked anyway: the cost is one scan and the failure
 *  mode is a silently truncated upload. */
const bytesContain = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
};

const concat = (chunks: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

export interface MultipartBody {
  /** The exact `Content-Type` header value, boundary included. The caller
   *  MUST use this and must not set its own — a mismatched boundary is
   *  unparseable at the far end. */
  content_type: string;
  body: Uint8Array;
  boundary: string;
}

/** Encode one `multipart/form-data` body.
 *
 *  Order is preserved: fields first in the order given, then files in the
 *  order given. Some targets are order-sensitive (a few read the first part
 *  as the payload), and a stable order also makes the bytes reproducible for
 *  tests. */
export const encodeMultipart = (
  fields: readonly MultipartField[],
  files: readonly MultipartFile[],
  boundary: string,
): MultipartBody => {
  if (files.length === 0 && fields.length === 0) {
    throw new MultipartEncodeError('multipart: refusing to encode an empty body');
  }
  assertToken(boundary, 'boundary');

  const enc = new TextEncoder();
  const CRLF = enc.encode('\r\n');
  const chunks: Uint8Array[] = [];
  const dashBoundary = enc.encode(`--${boundary}`);
  const boundaryBytes = enc.encode(boundary);

  for (const f of fields) {
    assertToken(f.name, `field name '${f.name}'`);
    chunks.push(dashBoundary, CRLF);
    chunks.push(enc.encode(`Content-Disposition: form-data; name="${f.name}"`), CRLF);
    chunks.push(CRLF);
    chunks.push(enc.encode(f.value), CRLF);
  }

  for (const f of files) {
    assertToken(f.name, `file part name '${f.name}'`);
    assertToken(f.filename, `filename '${f.filename}'`);
    assertMimeType(f.mime_type);
    if (bytesContain(f.bytes, boundaryBytes)) {
      throw new MultipartEncodeError(
        `multipart: part '${f.name}' contains the boundary — the body would `
          + 'terminate early at the receiver',
      );
    }
    chunks.push(dashBoundary, CRLF);
    chunks.push(
      enc.encode(
        `Content-Disposition: form-data; name="${f.name}"; filename="${f.filename}"`,
      ),
      CRLF,
    );
    chunks.push(enc.encode(`Content-Type: ${f.mime_type}`), CRLF);
    chunks.push(CRLF);
    chunks.push(f.bytes, CRLF);
  }

  chunks.push(enc.encode(`--${boundary}--`), CRLF);

  return {
    content_type: `multipart/form-data; boundary=${boundary}`,
    body: concat(chunks),
    boundary,
  };
};
