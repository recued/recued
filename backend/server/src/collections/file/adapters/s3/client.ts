/** Phase 7 (D-110) — thin fetch-based S3 client.
 *
 *  Supports the five verbs the adapter needs:
 *    - HeadBucket
 *    - PutObject    (body + optional mime)
 *    - GetObject    (returns bytes + mime)
 *    - DeleteObject
 *    - ListObjectsV2
 *
 *  Endpoint shape:
 *    - AWS: `https://{bucket}.s3.{region}.amazonaws.com/{key}`
 *    - Cloudflare R2: `https://{account}.r2.cloudflarestorage.com/{bucket}/{key}`
 *    - MinIO / B2: `https://{endpoint}/{bucket}/{key}`
 *  Caller picks via the `endpoint` + `use_path_style` config knobs.
 *
 *  Parse notes:
 *    - We accept pre-stringified XML responses (MinIO differs from
 *      AWS in minor element ordering; the fields we care about —
 *      `Contents/Key`, `KeyCount` — are stable).
 *    - `ListObjectsV2` parse is intentionally minimal: only extracts
 *      `Contents > Key`. The adapter only needs the keys to feed the
 *      fs-style event stream. */

import { createHash } from 'node:crypto';
import { discardResponseBody } from '@recued/ingredients';
import { encodeRfc3986, signRequest, type SignedRequest } from './sig.js';

export const S3_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
export const S3_CONTROL_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const S3_ERROR_RESPONSE_MAX_BYTES = 4 * 1024;

export interface S3ClientConfig {
  access_key: string;
  secret_key: string;
  region: string;
  bucket: string;
  /** Optional endpoint override. When set, the client uses
   *  `{endpoint}/{bucket}/...` path-style URLs. Leave unset for
   *  AWS's virtual-host-style (`{bucket}.s3.{region}.amazonaws.com`). */
  endpoint?: string;
  /** Force path-style even when endpoint is set. MinIO / some R2
   *  configurations require this. */
  use_path_style?: boolean;
}

export type S3Fetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    // `Uint8Array<ArrayBufferLike>` (the post-TS 5.7 generic form) matches
    // what `fetch`'s `BodyInit` accepts; bare `Uint8Array` resolves to
    // `Uint8Array<ArrayBuffer>` which is narrower than what callers pass.
    body?: Uint8Array<ArrayBufferLike> | string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}>;

export class S3Error extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

const defaultFetch: S3Fetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    // Cast: Uint8Array<ArrayBufferLike> isn't in the narrowed BodyInit
    // union under lib.dom's stricter generics, but Node 20+ + the
    // browser runtime both accept it. String variant passes through as-is.
    body: init.body as BodyInit | undefined,
    ...(init.signal !== undefined ? { signal: init.signal } : {}),
  });
  return res;
};

const buildUrl = (cfg: S3ClientConfig, key?: string, query?: Record<string, string>): URL => {
  const base =
    cfg.endpoint ??
    `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  const pathBucket = cfg.endpoint && cfg.use_path_style !== false;
  const pathPrefix = pathBucket ? `/${encodeURIComponent(cfg.bucket)}` : '';
  const encodedKey = key ? `/${key.split('/').map(encodeURIComponent).join('/')}` : '/';
  const url = new URL(`${base}${pathPrefix}${encodedKey === '/' ? '' : encodedKey}`);
  if (!url.pathname) url.pathname = '/';
  if (query) {
    // Serialize the query with the SAME RFC-3986 encoder the SigV4 signer uses for
    // the canonical query (`encodeRfc3986`), assigned via `url.search` so
    // `url.toString()` (the wire URL) emits it VERBATIM. NOT `searchParams.set`,
    // whose form-encoding (space→`+`, `!'()`→`%21…`) diverges from the signed
    // bytes → `SignatureDoesNotMatch`. The signer still reads `url.searchParams`
    // (which decodes correctly); only searchParams MUTATORS re-serialize the
    // query with form-encoding, and we deliberately avoid them here.
    url.search = Object.entries(query)
      .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
      .join('&');
  }
  return url;
};

/** ⛔⛔ An OBJECT operation needs a key. `buildUrl` turns an empty key into the
 *  bucket's own URL, because listing needs that. So before this, a file step with
 *  no path addressed the bucket itself:
 *  - `file-delete` sent DELETE to the bucket, which is S3's DeleteBucket;
 *  - `file-read` returned the bucket listing as the file's bytes;
 *  - `file-stat` reported the bucket as an existing file.
 *  Found by the 2026-09-24 audit. The fs adapter already refuses an empty path
 *  ("path escapes root"); this is the same posture here.
 *
 *  ⛔⛔ And the key must reach the URL as written. `new URL()` resolves `.` and `..`
 *  path segments, so `.`, `./`, `..` and `a/..` went to the bucket too (a delete was
 *  DeleteBucket, a read returned the listing), `..` in path style went to the
 *  service root, and `./b` or `a/../b` addressed `b` instead of the object named.
 *  `encodeURIComponent` encodes `%` and `\`, so a literal `.` or `..` segment is
 *  the only part of a key the URL parser rewrites: refusing those closes it. Dots
 *  inside a segment (`.hidden`, `a..b`, `...`) are ordinary characters. */
const objectUrl = (cfg: S3ClientConfig, key: unknown): URL => {
  if (typeof key !== 'string' || key.length === 0) {
    throw new S3Error(
      'InvalidObjectKey',
      'an object key is required: an empty key would address the bucket itself',
      400,
    );
  }
  if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new S3Error(
      'InvalidObjectKey',
      `an object key cannot have a "." or ".." segment: the URL would resolve it, so '${key}' would address another object or the bucket itself`,
      400,
    );
  }
  return buildUrl(cfg, key);
};

const sha256Buf = (buf: Uint8Array): string =>
  createHash('sha256').update(buf).digest('hex');

export interface S3Client {
  headBucket(): Promise<{ ok: true }>;
  putObject(key: string, body: Uint8Array, mime?: string): Promise<void>;
  /** GET an object's bytes + mime. `maxBytes`, when given, is enforced against
   *  both Content-Length and the live response stream. */
  getObject(key: string, maxBytes?: number): Promise<{ body: Uint8Array; mime?: string }>;
  deleteObject(key: string): Promise<void>;
  listObjects(prefix?: string): Promise<{ keys: string[] }>;
  /** ListObjectsV2 one page WITH full per-object metadata + the
   *  pagination continuation state. `fetch-owner=true` is always set so
   *  the D-192 file-source projection's `owner` field resolves. The caller
   *  loops on `isTruncated`, threading `nextContinuationToken`, to walk the
   *  bucket to exhaustion — distinct from `listObjects` (keys-only, single
   *  page) which feeds the inbound-file event stream. */
  listObjectsV2Page(opts?: {
    prefix?: string;
    continuationToken?: string;
  }): Promise<{
    objects: S3ObjectMeta[];
    isTruncated: boolean;
    nextContinuationToken?: string;
  }>;
  /** HEAD `/{key}` — returns object metadata without pulling the
   *  body. Used by the adapter's `statRecord` implementation. Throws
   *  with status 404 when the key is absent; callers catch + map
   *  to `{ exists: false }`. */
  headObject(key: string): Promise<{
    size_bytes: number;
    modified_at_ms: number | null;
    mime?: string;
  }>;
}

export interface CreateS3ClientOptions {
  config: S3ClientConfig;
  fetcher?: S3Fetch;
  now?: () => Date;
}

const signWithNow = (
  cfg: S3ClientConfig,
  url: URL,
  method: string,
  payload: string | { hashHex: string },
  now: Date,
  extraHeaders?: Record<string, string>,
): SignedRequest =>
  signRequest({
    access_key: cfg.access_key,
    secret_key: cfg.secret_key,
    region: cfg.region,
    service: 's3',
    url,
    method,
    headers: extraHeaders ?? {},
    payload,
    now,
  });

const parseListKeys = (xml: string): string[] => {
  const keys: string[] = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    keys.push(m[1]);
  }
  return keys;
};

/** One S3 object's list-page metadata (the D-192 file-source projection
 *  reads `Key` / `Size` / `LastModified` / `ETag` / `Owner.DisplayName`).
 *  Everything but `Key` is optional — a malformed / partial `<Contents>`
 *  entry still yields a keyed row (the projector fail-closes downstream if
 *  a required canonical field is missing). */
export interface S3ObjectMeta {
  Key: string;
  Size?: number;
  LastModified?: string;
  ETag?: string;
  Owner?: { DisplayName?: string };
}

/** Decode the handful of XML entities an S3 `<Key>` / `<ETag>` /
 *  `<DisplayName>` can carry (keys legitimately contain `&`, quotes wrap
 *  the ETag). `&amp;` is applied LAST so an already-decoded `<` from
 *  `&amp;lt;` does not double-decode. */
const decodeXmlEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Extract the first `<tag>…</tag>` text from an XML fragment (non-greedy,
 *  entity-decoded). Addresses fields by tag, never position, so AWS vs
 *  R2/MinIO element-ordering differences don't matter. */
const pickTag = (fragment: string, tag: string): string | undefined => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(fragment);
  return m ? decodeXmlEntities(m[1]) : undefined;
};

/** Parse a ListObjectsV2 response into per-object metadata + the
 *  pagination follower's continuation state. Minimal regex parse in the
 *  house style (`parseListKeys` above). `fetch-owner=true` must be set on
 *  the request for the per-object `<Owner><DisplayName>` block to be
 *  present.
 *
 *  THROWS an `S3Error('MalformedResponse')` when the body carries no
 *  parseable `<IsTruncated>` — a well-formed ListObjectsV2 response always
 *  carries exactly one, and inferring `false` from its ABSENCE would let a
 *  malformed / partial 200 body masquerade as a proven COMPLETE walk, which
 *  the D-190 absence-delete diff would act on (false-deleting mirrored rows).
 *  Fail closed: the caller sees an error outcome + retries, never a silent
 *  complete walk. */
export const parseListObjectsV2 = (
  xml: string,
): { objects: S3ObjectMeta[]; isTruncated: boolean; nextContinuationToken?: string } => {
  const objects: S3ObjectMeta[] = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = contentsRe.exec(xml)) !== null) {
    const block = m[1];
    const key = pickTag(block, 'Key');
    if (key === undefined) continue; // a Contents entry with no Key is malformed
    const sizeStr = pickTag(block, 'Size');
    const size = sizeStr !== undefined ? Number(sizeStr) : undefined;
    const lastModified = pickTag(block, 'LastModified');
    const etag = pickTag(block, 'ETag');
    const displayName = pickTag(block, 'DisplayName');
    objects.push({
      Key: key,
      ...(size !== undefined && Number.isFinite(size) ? { Size: size } : {}),
      ...(lastModified !== undefined ? { LastModified: lastModified } : {}),
      ...(etag !== undefined ? { ETag: etag } : {}),
      ...(displayName !== undefined ? { Owner: { DisplayName: displayName } } : {}),
    });
  }
  // Require an EXPLICIT IsTruncated — the completeness proof must be positive,
  // never inferred from a missing marker.
  const truncatedTrue = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const truncatedFalse = /<IsTruncated>\s*false\s*<\/IsTruncated>/i.test(xml);
  if (!truncatedTrue && !truncatedFalse) {
    throw new S3Error(
      'MalformedResponse',
      'ListObjectsV2 response is missing <IsTruncated> — refusing to treat as a complete walk',
    );
  }
  const nextToken = pickTag(xml, 'NextContinuationToken');
  return {
    objects,
    isTruncated: truncatedTrue,
    ...(nextToken !== undefined && nextToken.length > 0
      ? { nextContinuationToken: nextToken }
      : {}),
  };
};

export const createS3Client = (opts: CreateS3ClientOptions): S3Client => {
  const { config, fetcher = defaultFetch, now = () => new Date() } = opts;

  type S3Response = Awaited<ReturnType<S3Fetch>>;

  const contentLength = (res: S3Response): number | undefined => {
    const raw = res.headers.get('content-length');
    if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  };

  const streamBytes = async (
    res: S3Response,
    maxBytes: number,
    label: string,
  ): Promise<Uint8Array | undefined> => {
    const declared = contentLength(res);
    if (declared !== undefined && declared > maxBytes) {
      throw new S3Error(
        'EntityTooLarge',
        `${label}: ${declared} bytes exceeds the ${maxBytes} ceiling`,
        413,
      );
    }
    const reader = res.body?.getReader();
    if (reader === undefined) return undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let complete = false;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          complete = true;
          break;
        }
        total += next.value.byteLength;
        if (total > maxBytes) {
          throw new S3Error(
            'EntityTooLarge',
            `${label}: response exceeded the ${maxBytes}-byte ceiling`,
            413,
          );
        }
        chunks.push(next.value);
      }
    } finally {
      if (!complete) void reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // Abort/cancellation already owns stream cleanup.
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };

  const objectBytes = async (
    res: S3Response,
    maxBytes: number | undefined,
    label: string,
  ): Promise<Uint8Array> => {
    if (maxBytes !== undefined) {
      const streamed = await streamBytes(res, maxBytes, label);
      if (streamed !== undefined) return streamed;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
      throw new S3Error(
        'EntityTooLarge',
        `${label}: ${bytes.byteLength} bytes exceeds the ${maxBytes} ceiling`,
        413,
      );
    }
    return bytes;
  };

  const controlText = async (
    res: S3Response,
    maxBytes: number,
    label: string,
  ): Promise<string> => {
    const streamed = await streamBytes(res, maxBytes, label);
    if (streamed !== undefined) return new TextDecoder().decode(streamed);
    const text = await res.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > maxBytes) {
      throw new S3Error(
        'EntityTooLarge',
        `${label}: response exceeded the ${maxBytes}-byte ceiling`,
        413,
      );
    }
    return text;
  };

  const request = async <T>(
    url: string,
    init: Omit<Parameters<S3Fetch>[1], 'signal'>,
    consume: (res: S3Response) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, S3_REQUEST_TIMEOUT_MS);
    let res: S3Response | undefined;
    try {
      res = await fetcher(url, { ...init, signal: controller.signal });
      return await consume(res);
    } catch (err) {
      if (timedOut && !(err instanceof S3Error)) {
        throw new S3Error(
          'RequestTimeout',
          `S3 request timed out after ${S3_REQUEST_TIMEOUT_MS}ms`,
          504,
        );
      }
      throw err;
    } finally {
      if (res !== undefined) discardResponseBody(res as Response);
      clearTimeout(timer);
    }
  };

  const expectOk = async (
    res: S3Response,
    label: string,
  ): Promise<void> => {
    if (res.ok) return;
    const body = await controlText(
      res,
      S3_ERROR_RESPONSE_MAX_BYTES,
      `${label} error`,
    ).catch(() => '');
    const codeMatch = body.match(/<Code>([^<]+)<\/Code>/);
    throw new S3Error(
      codeMatch?.[1] ?? 'unknown',
      `${label} failed: ${res.status} ${body.slice(0, 200)}`,
      res.status,
    );
  };

  return {
    async headBucket() {
      const url = buildUrl(config);
      const signed = signWithNow(config, url, 'HEAD', '', now());
      return request(signed.url, {
        method: 'HEAD',
        headers: signed.headers,
      }, async (res) => {
        await expectOk(res, 'HeadBucket');
        return { ok: true as const };
      });
    },
    async putObject(key, body, mime) {
      const url = objectUrl(config, key);
      const payloadHash = sha256Buf(body);
      const signed = signWithNow(
        config,
        url,
        'PUT',
        { hashHex: payloadHash },
        now(),
        mime ? { 'content-type': mime } : undefined,
      );
      await request(signed.url, {
        method: 'PUT',
        headers: signed.headers,
        body,
      }, async (res) => {
        await expectOk(res, `PutObject ${key}`);
      });
    },
    async getObject(key, maxBytes) {
      const url = objectUrl(config, key);
      const signed = signWithNow(config, url, 'GET', '', now());
      return request(signed.url, {
        method: 'GET',
        headers: signed.headers,
      }, async (res) => {
        await expectOk(res, `GetObject ${key}`);
        const body = await objectBytes(res, maxBytes, `GetObject ${key}`);
        const mime = res.headers.get('content-type') ?? undefined;
        return { body, mime };
      });
    },
    async deleteObject(key) {
      const url = objectUrl(config, key);
      const signed = signWithNow(config, url, 'DELETE', '', now());
      await request(signed.url, {
        method: 'DELETE',
        headers: signed.headers,
      }, async (res) => {
        await expectOk(res, `DeleteObject ${key}`);
      });
    },
    async headObject(key) {
      const url = objectUrl(config, key);
      const signed = signWithNow(config, url, 'HEAD', '', now());
      return request(signed.url, {
        method: 'HEAD',
        headers: signed.headers,
      }, async (res) => {
        await expectOk(res, `HeadObject ${key}`);
        const sizeHeader = res.headers.get('content-length');
        const size = sizeHeader != null ? Number(sizeHeader) : 0;
        const lastMod = res.headers.get('last-modified');
        const modified = lastMod ? Date.parse(lastMod) : NaN;
        const mime = res.headers.get('content-type') ?? undefined;
        return {
          size_bytes: Number.isFinite(size) ? size : 0,
          modified_at_ms: Number.isFinite(modified) ? modified : null,
          mime,
        };
      });
    },
    async listObjects(prefix) {
      const url = buildUrl(config, undefined, {
        'list-type': '2',
        ...(prefix ? { prefix } : {}),
      });
      const signed = signWithNow(config, url, 'GET', '', now());
      return request(signed.url, {
        method: 'GET',
        headers: signed.headers,
      }, async (res) => {
        await expectOk(res, 'ListObjectsV2');
        const xml = await controlText(
          res,
          S3_CONTROL_RESPONSE_MAX_BYTES,
          'ListObjectsV2',
        );
        return { keys: parseListKeys(xml) };
      });
    },
    async listObjectsV2Page(opts) {
      const url = buildUrl(config, undefined, {
        'list-type': '2',
        'fetch-owner': 'true',
        ...(opts?.prefix ? { prefix: opts.prefix } : {}),
        ...(opts?.continuationToken
          ? { 'continuation-token': opts.continuationToken }
          : {}),
      });
      const signed = signWithNow(config, url, 'GET', '', now());
      return request(signed.url, {
        method: 'GET',
        headers: signed.headers,
      }, async (res) => {
        await expectOk(res, 'ListObjectsV2');
        const xml = await controlText(
          res,
          S3_CONTROL_RESPONSE_MAX_BYTES,
          'ListObjectsV2',
        );
        return parseListObjectsV2(xml);
      });
    },
  };
};
