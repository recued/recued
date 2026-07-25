/** D-192 remote byte-fetch (follow-on B) — SLICE 3: the S3 vendor resolver, the
 *  reference `RemoteFileByteResolver`.
 *
 *  An S3 mirror row's `remote_id` IS the object Key (the S3 vendor declaration
 *  maps `remote_id: 'Key'`), so a byte read is a single SigV4 `GetObject` by
 *  that key — reusing the SAME D-172 S3 client + `s3ConfigFromConnection` the
 *  metadata list walk used (one auth/endpoint resolution, no drift). Bytes are
 *  fetched LAZILY, only when a consumer opens the file (no sync, no caching —
 *  stream-through, v1). The 25 MiB ceiling is enforced by the orchestrator's
 *  preflight on the mirror's `Size` (S3 always reports it) before the fetch; the
 *  post-fetch length check here is a backstop.
 *
 *  Design: `docs/d-192-remote-byte-fetch-design.md`. */

import { RpcError } from '@recued/contracts';

import {
  createS3Client,
  S3Error,
  type S3Fetch,
} from '../adapters/s3/client.js';
import type { RemoteFileByteResolver } from '../remote-file-byte-resolver.js';
import type { FileFetch } from '../../../file-source-adapters/index.js';
import { s3ConfigFromConnection } from '../../../file-source-adapters/s3.js';

export interface S3RemoteByteResolverDeps {
  /** The injected fetch (platform `fetch` in prod, a stub in tests). */
  fetchImpl: FileFetch;
}

/** Build the `s3` `RemoteFileByteResolver`. Resolves the connection credential
 *  into an S3 client config (fail-closed → `file_storage_missing` on a bad/edited
 *  connection — the list already proved it, so this is a race), then SigV4
 *  `GetObject`s the mirror's Key. An `S3Error` → `remote_fetch_failed` (transient);
 *  an oversized body → `remote_too_large`. Filename rides the mirror `meta`; the
 *  S3 `Content-Type` (which ListObjectsV2 can't carry) becomes the authoritative
 *  mime. */
export const buildS3RemoteByteResolver = (deps: S3RemoteByteResolverDeps): RemoteFileByteResolver => {
  // Adapt the injected `FileFetch` to the S3 client's `S3Fetch` (a subset).
  const s3Fetcher: S3Fetch = (url, init) =>
    deps.fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body as string | Uint8Array } : {}),
    });

  return async (req) => {
    const built = s3ConfigFromConnection(req.cred);
    if (!built.ok) {
      throw new RpcError('file_storage_missing', `s3 remote read: ${built.reason}`, 500);
    }
    const client = createS3Client({ config: built.clientConfig, fetcher: s3Fetcher });
    let obj: { body: Uint8Array; mime?: string };
    try {
      // Pass the ceiling so the client rejects an oversize object on its
      // Content-Length BEFORE buffering it (the post-buffer check below is a
      // backstop for a length-less response).
      obj = await client.getObject(req.remote_id, req.maxBytes); // remote_id = the S3 Key
    } catch (err) {
      if (err instanceof S3Error) {
        if (err.code === 'EntityTooLarge') {
          throw new RpcError('remote_too_large', `s3 object '${req.remote_id}' ${err.message}`, 413);
        }
        throw new RpcError('remote_fetch_failed', `s3 GetObject failed: ${err.message}`, 502);
      }
      throw err; // orchestrator wraps any other throw as remote_fetch_failed
    }
    if (obj.body.byteLength > req.maxBytes) {
      throw new RpcError(
        'remote_too_large',
        `s3 object '${req.remote_id}' is ${obj.body.byteLength} bytes (> ${req.maxBytes} ceiling)`,
        413,
      );
    }
    return {
      bytes: Buffer.from(obj.body),
      ...(obj.mime !== undefined && obj.mime.length > 0 ? { mime_type: obj.mime } : {}),
    };
  };
};
