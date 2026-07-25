/** D-192 remote byte-fetch (follow-on B) — SLICE 3: the S3 vendor resolver
 *  (`collections/file/remote-byte-resolvers/s3.ts`). Drives the resolver through
 *  a stubbed S3 `GetObject` fetch: happy-path bytes + authoritative mime, config
 *  fail-closed, S3Error → remote_fetch_failed, oversized → remote_too_large. */

import { describe, expect, it } from 'vitest';
import { RpcError, type FileMetaProjection } from '@recued/contracts';

import { buildS3RemoteByteResolver } from '../collections/file/remote-byte-resolvers/s3.js';
import { REMOTE_FILE_READ_MAX_BYTES, type RemoteFileByteRequest } from '../collections/file/remote-file-byte-resolver.js';
import type { FileConnectionCredential, FileFetch } from '../file-source-adapters/index.js';

const stub = (
  responses: Array<{ ok?: boolean; status?: number; bytes?: Uint8Array; contentType?: string; contentLength?: string; errorXml?: string; arrayBufferThrows?: boolean }>,
): { fetchImpl: FileFetch; calls: Array<{ url: string; method: string; headers: Record<string, string> }> } => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  let i = 0;
  const fetchImpl: FileFetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: (init.headers ?? {}) as Record<string, string> });
    const r = responses[i++] ?? { ok: false, status: 500 };
    const ok = r.ok ?? true;
    const bytes = r.bytes ?? new Uint8Array();
    const headers = new Headers();
    if (r.contentType !== undefined) headers.set('content-type', r.contentType);
    if (r.contentLength !== undefined) headers.set('content-length', r.contentLength);
    return {
      ok,
      status: r.status ?? (ok ? 200 : 500),
      headers,
      text: async () => r.errorXml ?? '',
      json: async () => ({}),
      arrayBuffer: async () => {
        if (r.arrayBufferThrows) throw new Error('must not buffer the body when the Content-Length preflight should reject');
        const ab = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(ab).set(bytes);
        return ab;
      },
    };
  };
  return { fetchImpl, calls };
};

const cred = (over: Partial<FileConnectionCredential> = {}): FileConnectionCredential => ({
  auth: { type: 'basic', username: 'AKIA', password: 'secret' } as never,
  config: { region: 'us-east-1', bucket: 'my-bucket' },
  ...over,
});
const meta: FileMetaProjection = { filename: 'report.pdf', provider: 's3', remote_id: 'Work/report.pdf', size: 5 };
const req = (over: Partial<RemoteFileByteRequest> = {}): RemoteFileByteRequest => ({
  cred: cred(), remote_id: 'Work/report.pdf', meta, maxBytes: REMOTE_FILE_READ_MAX_BYTES, ...over,
});

const catchCode = async (p: Promise<unknown>): Promise<string> => {
  try { await p; throw new Error('expected a throw'); }
  catch (err) { if (err instanceof RpcError) return err.code; throw err; }
};

describe('buildS3RemoteByteResolver', () => {
  it('SigV4 GetObjects the key and returns bytes + the authoritative Content-Type mime', async () => {
    const { fetchImpl, calls } = stub([{ bytes: Buffer.from('hello pdf'), contentType: 'application/pdf' }]);
    const out = await buildS3RemoteByteResolver({ fetchImpl })(req());
    expect(out).toEqual({ bytes: Buffer.from('hello pdf'), mime_type: 'application/pdf' });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('my-bucket');       // the bucket
    expect(calls[0].url).toContain('report.pdf');       // the key
    // SigV4 signs via the Authorization HEADER (header-based, not a presigned URL).
    expect(calls[0].headers.Authorization ?? calls[0].headers.authorization).toContain('AWS4-HMAC-SHA256');
  });

  it('omits mime_type when S3 returns no Content-Type (orchestrator defaults it)', async () => {
    const { fetchImpl } = stub([{ bytes: Buffer.from('x') }]);
    const out = await buildS3RemoteByteResolver({ fetchImpl })(req());
    expect(out.bytes).toEqual(Buffer.from('x'));
    expect(out.mime_type).toBeUndefined();
  });

  it('a non-basic auth or missing region/bucket fails closed → file_storage_missing', async () => {
    const { fetchImpl } = stub([]);
    const resolver = buildS3RemoteByteResolver({ fetchImpl });
    expect(await catchCode(resolver(req({ cred: cred({ auth: { type: 'bearer', token: 't' } as never }) })))).toBe('file_storage_missing');
    expect(await catchCode(resolver(req({ cred: cred({ config: { bucket: 'b' } }) })))).toBe('file_storage_missing'); // no region
  });

  it('an S3Error (e.g. 404 NoSuchKey) → remote_fetch_failed', async () => {
    const { fetchImpl } = stub([{ ok: false, status: 404, errorXml: '<Error><Code>NoSuchKey</Code></Error>' }]);
    expect(await catchCode(buildS3RemoteByteResolver({ fetchImpl })(req()))).toBe('remote_fetch_failed');
  });

  it('an object larger than maxBytes → remote_too_large (post-fetch backstop)', async () => {
    const { fetchImpl } = stub([{ bytes: new Uint8Array(11) }]);
    expect(await catchCode(buildS3RemoteByteResolver({ fetchImpl })(req({ maxBytes: 10 })))).toBe('remote_too_large');
  });

  it('rejects an oversize object on its Content-Length BEFORE buffering it (M2 preflight)', async () => {
    // A huge declared size with a body read that THROWS — proving the preflight
    // rejects on the fresh header, never reaching `arrayBuffer` (which on a real
    // multi-GB object would OOM). The mirror's stored size is stale (5 bytes).
    const { fetchImpl } = stub([{ contentLength: String(2_000_000_000), arrayBufferThrows: true }]);
    expect(await catchCode(buildS3RemoteByteResolver({ fetchImpl })(req({ maxBytes: 25 })))).toBe('remote_too_large');
  });
});
