/** Memory-bounded S3 delivery of already encrypted archive files. ETags are
 * concurrency tokens, never integrity proof. Every delivery is read back and
 * SHA-256 checked before it can authorize retention. No redirects or raw
 * provider response bodies escape this module. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { s3ObjectUrl, type S3ClientConfig } from '../collections/file/adapters/s3/client.js';
import { encodeRfc3986, signRequest } from '../collections/file/adapters/s3/sig.js';

const MiB = 1024 * 1024;
const EMPTY_HASH = createHash('sha256').update('').digest('hex');
const MAX_CONTROL = 64 * 1024;
const DEFAULT_PART = 8 * MiB;
export interface RemoteObjectIdentity { etag?: string; version_id?: string }
export interface RemoteArchiveBytes { bytes: number; sha256: string }
export interface RemoteBackupTransport {
  upload(key: string, path: string, expected: RemoteArchiveBytes, onMultipart: (id: string | null) => void): Promise<void>;
  verify(key: string, expected: RemoteArchiveBytes, identity?: RemoteObjectIdentity, signal?: AbortSignal): Promise<RemoteObjectIdentity>;
  retrieve(key: string, path: string, expected: RemoteArchiveBytes, identity?: RemoteObjectIdentity, signal?: AbortSignal): Promise<void>;
  remove(key: string, identity: RemoteObjectIdentity, signal?: AbortSignal): Promise<void>;
  abort(key: string, uploadId: string, signal?: AbortSignal): Promise<void>;
}
export class RemoteBackupTransferError extends Error {
  constructor(readonly kind: 'transfer_unconfirmed' | 'verification_failed' | 'destination_unavailable') {
    super(kind); this.name = 'RemoteBackupTransferError';
  }
}
/** Classify cleanup access refusal without retaining a provider response. */
export class RemoteBackupCleanupDeniedError extends RemoteBackupTransferError {
  constructor() { super('transfer_unconfirmed'); this.name = 'RemoteBackupCleanupDeniedError'; }
}
const fail = (kind: RemoteBackupTransferError['kind'] = 'transfer_unconfirmed'): never => { throw new RemoteBackupTransferError(kind); };
const unescapeXml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const xmlValue = (xml: string, tag: string): string | undefined => {
  const value = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'u').exec(xml)?.[1];
  return value === undefined ? undefined : unescapeXml(value);
};
const opaque = (s: string | null): s is string => s !== null && s.length > 0 && s.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(s);
const strongEtag = (s: string | null): s is string => s !== null && /^"[^"\\\r\n]{1,512}"$/u.test(s);
const responseIdentity = (response: Response): RemoteObjectIdentity => {
  const etag = response.headers.get('etag'), version = response.headers.get('x-amz-version-id');
  return { ...(strongEtag(etag) ? { etag } : {}), ...(opaque(version) ? { version_id: version } : {}) };
};
const readControl = async (response: Response): Promise<string> => {
  if (!response.body) return '';
  const chunks: Uint8Array[] = []; let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.byteLength; if (bytes > MAX_CONTROL) fail(); chunks.push(result.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => { /* preserve the original result */ }); reader.releaseLock(); }
};
const discard = async (response: Response): Promise<void> => { try { await response.body?.cancel(); } catch { /* no provider body is needed */ } };

export const hashRemoteBackupFile = async (path: string): Promise<RemoteArchiveBytes> => {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  if (!Number.isSafeInteger(bytes) || bytes < 4) fail('verification_failed');
  return { bytes, sha256: hash.digest('hex') };
};

export const createS3RemoteBackupTransport = (options: {
  config: S3ClientConfig;
  /** Synchronous, immediately before each request; a changed/locked credential
   * cannot start the next part, verification, or retention delete. */
  assertCurrent(): void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  requestTimeoutMs?: number;
  partBytes?: number;
}): RemoteBackupTransport => {
  const { config } = options, fetchImpl = options.fetchImpl ?? fetch;
  const request = async (method: string, key: string, args: {
    query?: Record<string, string>; headers?: Record<string, string>; body?: BodyInit; hash?: string; signal?: AbortSignal;
  } = {}): Promise<Response> => {
    options.assertCurrent();
    const url = s3ObjectUrl(config, key);
    if (args.query) url.search = Object.entries(args.query).map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&');
    const signed = signRequest({ access_key: config.access_key, secret_key: config.secret_key, region: config.region,
      service: 's3', method, url, payload: { hashHex: args.hash ?? EMPTY_HASH }, headers: args.headers ?? {}, now: options.now?.() });
    const deadline = AbortSignal.timeout(options.requestTimeoutMs ?? 30 * 60 * 1000);
    const init: RequestInit & { duplex?: 'half' } = { method, headers: signed.headers, redirect: 'manual',
      signal: args.signal ? AbortSignal.any([args.signal, deadline]) : deadline,
      ...(args.body === undefined ? {} : { body: args.body, duplex: 'half' }) };
    try { return await fetchImpl(signed.url, init); } catch { return fail(); }
  };
  const fileRequest = async (key: string, path: string, start: number, end: number, sha256: string,
    query?: Record<string, string>, extraHeaders?: Record<string, string>): Promise<Response> => {
    const source = createReadStream(path, { start, end, highWaterMark: 64 * 1024 });
    try {
      return await request('PUT', key, { query, hash: sha256,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(end - start + 1), ...extraHeaders },
        body: Readable.toWeb(source) as ReadableStream<Uint8Array> });
    } finally { source.destroy(); }
  };
  const abort = async (key: string, uploadId: string, signal?: AbortSignal): Promise<void> => {
    const response = await request('DELETE', key, { query: { uploadId }, ...(signal ? { signal } : {}) });
    const ok = response.ok || response.status === 404; await discard(response);
    if (response.status === 403) throw new RemoteBackupCleanupDeniedError();
    if (!ok) fail();
  };
  const readObject = async (key: string, expected: RemoteArchiveBytes, identity: RemoteObjectIdentity = {}, path?: string, signal?: AbortSignal): Promise<RemoteObjectIdentity> => {
    signal?.throwIfAborted();
    const response = await request('GET', key, { ...(identity.version_id ? { query: { versionId: identity.version_id } } : {}),
      ...(identity.etag ? { headers: { 'if-match': identity.etag } } : {}), ...(signal ? { signal } : {}) });
    if (response.status !== 200 || !response.body) { await discard(response); return fail('verification_failed'); }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== expected.bytes)) { await discard(response); return fail('verification_failed'); }
    const hash = createHash('sha256'), reader = response.body.getReader(); let bytes = 0;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (path) file = await open(path, 'wx', 0o600);
      for (;;) {
        const result = await reader.read(); if (result.done) break;
        bytes += result.value.byteLength; if (bytes > expected.bytes) fail('verification_failed');
        hash.update(result.value);
        if (file) {
          let written = 0;
          while (written < result.value.byteLength) {
            const part = await file.write(result.value.subarray(written));
            if (part.bytesWritten === 0) fail('verification_failed'); written += part.bytesWritten;
          }
        }
      }
      if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) fail('verification_failed');
      if (file) await file.sync();
      return responseIdentity(response);
    } finally {
      await reader.cancel().catch(() => { /* keep the original error */ }); reader.releaseLock(); await file?.close();
    }
  };
  return {
    async upload(key, path, expected, onMultipart) {
      const partBytes = Math.max(options.partBytes ?? DEFAULT_PART, Math.ceil(expected.bytes / 10000 / MiB) * MiB);
      if (!Number.isSafeInteger(partBytes) || partBytes < 5 * MiB || partBytes > 5 * 1024 * MiB) fail();
      if (expected.bytes <= partBytes) {
        const response = await fileRequest(key, path, 0, expected.bytes - 1, expected.sha256, undefined, { 'if-none-match': '*' });
        const ok = response.ok; await discard(response); if (!ok) fail(); return;
      }
      const init = await request('POST', key, { query: { uploads: '' }, headers: { 'content-type': 'application/octet-stream' } });
      if (!init.ok) { await discard(init); return fail(); }
      const id = xmlValue(await readControl(init), 'UploadId'); if (!opaque(id ?? null)) return fail();
      const uploadId = id!; let completed = false;
      try {
        onMultipart(uploadId);
        const parts: string[] = [];
        for (let start = 0, part = 1; start < expected.bytes; start += partBytes, part++) {
          const end = Math.min(expected.bytes, start + partBytes) - 1, hash = createHash('sha256');
          for await (const chunk of createReadStream(path, { start, end, highWaterMark: 64 * 1024 })) hash.update(chunk);
          const response = await fileRequest(key, path, start, end, hash.digest('hex'), { partNumber: String(part), uploadId });
          const etag = response.headers.get('etag'), ok = response.ok; await discard(response);
          if (!ok || !strongEtag(etag)) return fail();
          parts.push(`<Part><PartNumber>${part}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`);
        }
        const body = `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`;
        const response = await request('POST', key, { query: { uploadId }, headers: { 'content-type': 'application/xml', 'if-none-match': '*' },
          body, hash: createHash('sha256').update(body).digest('hex') });
        const ok = response.ok, xml = await readControl(response);
        // CompleteMultipartUpload can return an Error inside HTTP 200.
        if (!ok || !/<CompleteMultipartUploadResult(?:\s|>)/u.test(xml) || /<Error(?:\s|>)/u.test(xml)) fail();
        completed = true; onMultipart(null);
      } finally {
        if (!completed) { try { await abort(key, uploadId); onMultipart(null); } catch { /* durable id permits later cleanup */ } }
      }
    },
    verify: (key, expected, identity, signal) => readObject(key, expected, identity, undefined, signal),
    async retrieve(key, path, expected, identity, signal) { await readObject(key, expected, identity, path, signal); },
    async remove(key, identity, signal) {
      if (!strongEtag(identity.etag ?? null)) return fail();
      const response = await request('DELETE', key, { headers: { 'if-match': identity.etag! },
        ...(identity.version_id ? { query: { versionId: identity.version_id } } : {}), ...(signal ? { signal } : {}) });
      const ok = response.ok || response.status === 404; await discard(response); if (!ok) fail();
    },
    abort,
  };
};
