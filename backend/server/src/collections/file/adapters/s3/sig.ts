/** Phase 7 (D-110) — minimal AWS Signature Version 4 implementation
 *  for the S3 adapter.
 *
 *  Scope: only the pieces `PutObject` / `GetObject` / `DeleteObject`
 *  / `HeadBucket` / `ListObjectsV2` / notifications need. Supports
 *  the `s3` service across AWS + any S3-compatible endpoint
 *  (Cloudflare R2, Backblaze B2, MinIO) because the signing
 *  contract is independent of who answers the request.
 *
 *  Why not `@aws-sdk/client-s3`? The SDK pulls ~3 MB of runtime
 *  surface for a handful of verbs + breaks the "no per-adapter
 *  dependencies" rule from D-111 #5. Hand-rolled SigV4 is ~60 lines
 *  and all we need is fetch + this module.
 *
 *  Not supported v1: session-token-based auth (STS), payload
 *  streaming (we sign the full digest), IAM roles (user supplies
 *  access_key + secret_key), or regions with non-standard service
 *  discovery. These are all additions we can layer on without
 *  contract changes. */

import { createHash, createHmac } from 'node:crypto';

export interface SignV4Input {
  access_key: string;
  secret_key: string;
  region: string;
  service: string;
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** Raw request body (empty string for GETs). Passed in hex-encoded
   *  SHA-256 for PutObject-type calls where we've already hashed. */
  payload: string | { hashHex: string };
  /** Optional now injection for deterministic tests. */
  now?: Date;
}

const hex = (buf: Buffer): string => buf.toString('hex');
const sha256 = (data: string | Buffer): string =>
  hex(createHash('sha256').update(data).digest());
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

const pad2 = (n: number): string => String(n).padStart(2, '0');

const fmtAmzDate = (d: Date): { amzDate: string; datestamp: string } => {
  const y = d.getUTCFullYear();
  const mo = pad2(d.getUTCMonth() + 1);
  const da = pad2(d.getUTCDate());
  const hr = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  const se = pad2(d.getUTCSeconds());
  const datestamp = `${y}${mo}${da}`;
  const amzDate = `${datestamp}T${hr}${mi}${se}Z`;
  return { amzDate, datestamp };
};

/** RFC-3986 percent-encoding — AWS SigV4's canonical form: encode EVERY byte
 *  except the unreserved set `A-Za-z0-9-_.~`. `encodeURIComponent` already maps
 *  space→`%20` and leaves exactly `A-Za-z0-9-_.~` PLUS the five sub-delims
 *  `!*'()`, so we only additionally encode those five to reach the strict form.
 *
 *  This MUST be the encoder used for the query on BOTH sides — the signed
 *  canonical query ({@link canonicalQuery}) AND the wire URL the client sends (S3
 *  `buildUrl`). The pre-existing bug: the wire used `URLSearchParams`
 *  (form-encoding — space→`+`, `!'()`→`%21%27%28%29`) while the signature used
 *  `encodeURIComponent` (space→`%20`, `!'()` left literal), so the byte AWS
 *  re-canonicalized off the wire never matched the signed byte for space / `!` /
 *  `'` / `(` / `)` → `SignatureDoesNotMatch` on any query carrying one (e.g. an
 *  `import_scope` prefix). Opaque base64 continuation tokens were unaffected (their
 *  alphabet round-trips identically). One encoder on both sides closes the gap. */
export const encodeRfc3986 = (str: string): string =>
  encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** The SigV4 canonical query string: every param RFC-3986 encoded
 *  ({@link encodeRfc3986}) + sorted by key. Exported so the wire⟷signature parity
 *  is directly testable. */
export const canonicalQuery = (url: URL): string => {
  const params = [...url.searchParams.entries()]
    .map(([k, v]) => [k, v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return params.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&');
};

const canonicalHeaders = (
  headers: Record<string, string>,
): { canonical: string; signed: string } => {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = entries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signed = entries.map(([k]) => k).join(';');
  return { canonical, signed };
};

export interface SignedRequest {
  headers: Record<string, string>;
  url: string;
}

export const signRequest = (input: SignV4Input): SignedRequest => {
  const now = input.now ?? new Date();
  const { amzDate, datestamp } = fmtAmzDate(now);
  const payloadHash =
    typeof input.payload === 'string'
      ? sha256(input.payload)
      : input.payload.hashHex;

  const baseHeaders: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };

  const { canonical: canonHeaders, signed: signedHeaders } =
    canonicalHeaders(baseHeaders);

  const canonicalPath = input.url.pathname || '/';
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath,
    canonicalQuery(input.url),
    canonHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${datestamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${input.secret_key}`, datestamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hex(hmac(kSigning, stringToSign));

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${input.access_key}/${credentialScope},` +
    ` SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: input.url.toString(),
    headers: { ...baseHeaders, authorization: authHeader },
  };
};
