/** D-192 remote byte-fetch (follow-on B) — the vendor FAN-OUT resolvers
 *  (Dropbox / Google Drive / OneDrive / SharePoint / Box / Notion) over the
 *  shared `http-bytes` spine. Each resolver is driven through a stubbed fetch:
 *  the URL + auth it builds, the happy-path bytes + mime, the fail-closed token
 *  gap, the per-vendor unresolvable gaps (Google native doc, Notion prong-2), and
 *  the shared ceiling / mime handling. */

import { describe, expect, it, vi } from 'vitest';
import { RpcError, type FileMetaProjection } from '@recued/contracts';

import { buildBoxRemoteByteResolver } from '../collections/file/remote-byte-resolvers/box.js';
import { buildDropboxRemoteByteResolver } from '../collections/file/remote-byte-resolvers/dropbox.js';
import { buildGoogleRemoteByteResolver } from '../collections/file/remote-byte-resolvers/google.js';
import { buildNotionRemoteByteResolver } from '../collections/file/remote-byte-resolvers/notion.js';
import { buildOneDriveRemoteByteResolver } from '../collections/file/remote-byte-resolvers/onedrive.js';
import { buildRemoteFileByteResolvers } from '../collections/file/remote-byte-resolvers/index.js';
import {
  REMOTE_BYTE_FETCH_TIMEOUT_MS,
  fetchRemoteBytes,
} from '../collections/file/remote-byte-resolvers/http-bytes.js';
import {
  REMOTE_FILE_READ_MAX_BYTES,
  type RemoteFileByteRequest,
} from '../collections/file/remote-file-byte-resolver.js';
import type { FileConnectionCredential, FileFetch, FileFetchResponse } from '../file-source-adapters/index.js';

interface StubResponse {
  ok?: boolean;
  status?: number;
  bytes?: Uint8Array;
  contentType?: string;
  contentLength?: string;
  json?: unknown;
  text?: string;
}
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const stub = (responses: StubResponse[]): { fetchImpl: FileFetch; calls: Call[] } => {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: FileFetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
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
      text: async () => r.text ?? '',
      json: async () => r.json ?? {},
      arrayBuffer: async () => {
        const ab = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(ab).set(bytes);
        return ab;
      },
    };
  };
  return { fetchImpl, calls };
};

const bearerCred = (config: Record<string, unknown> = {}): FileConnectionCredential => ({
  auth: { type: 'bearer', token: 'tok' },
  config,
});
const meta = (over: Partial<FileMetaProjection> = {}): FileMetaProjection => ({
  filename: 'report.pdf',
  provider: 'x',
  remote_id: 'r',
  ...over,
});
const req = (over: Partial<RemoteFileByteRequest> = {}): RemoteFileByteRequest => ({
  cred: bearerCred(),
  remote_id: 'r',
  meta: meta(),
  maxBytes: REMOTE_FILE_READ_MAX_BYTES,
  ...over,
});

const catchCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    throw new Error('expected a throw');
  } catch (err) {
    if (err instanceof RpcError) return err.code;
    throw err;
  }
};

describe('buildDropboxRemoteByteResolver', () => {
  it('POSTs the content download with the Dropbox-API-Arg locator + bearer, no Content-Type', async () => {
    const { fetchImpl, calls } = stub([{ bytes: Buffer.from('pdf-bytes') }]);
    const out = await buildDropboxRemoteByteResolver({ fetchImpl })(req({ remote_id: 'id:abc123' }));
    expect(out.bytes).toEqual(Buffer.from('pdf-bytes'));
    expect(out.mime_type).toBeUndefined(); // Dropbox download responds octet-stream → orchestrator defaults
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://content.dropboxapi.com/2/files/download');
    expect(calls[0].headers.authorization).toBe('Bearer tok');
    expect(calls[0].headers['Dropbox-API-Arg']).toBe(JSON.stringify({ path: 'id:abc123' }));
    expect(calls[0].headers['content-type']).toBeUndefined();
    expect(calls[0].body).toBeUndefined();
  });

  it('a bearer-less connection fails closed → file_storage_missing (no fetch)', async () => {
    const { fetchImpl, calls } = stub([]);
    const r = req({ cred: { auth: { type: 'none' }, config: {} } });
    expect(await catchCode(buildDropboxRemoteByteResolver({ fetchImpl })(r))).toBe('file_storage_missing');
    expect(calls.length).toBe(0);
  });

  it('a non-ok download → remote_fetch_failed', async () => {
    const { fetchImpl } = stub([{ ok: false, status: 409, text: 'path/not_found' }]);
    expect(await catchCode(buildDropboxRemoteByteResolver({ fetchImpl })(req()))).toBe('remote_fetch_failed');
  });
});

describe('buildGoogleRemoteByteResolver', () => {
  it('GETs alt=media (supportsAllDrives) with the bearer → bytes + mime', async () => {
    const { fetchImpl, calls } = stub([{ bytes: Buffer.from('img'), contentType: 'image/png' }]);
    const out = await buildGoogleRemoteByteResolver({ fetchImpl })(
      req({ remote_id: 'file123', meta: meta({ remote_id: 'file123', mime_type: 'image/png' }) }),
    );
    expect(out).toEqual({ bytes: Buffer.from('img'), mime_type: 'image/png' });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/files/file123?alt=media');
    expect(calls[0].url).toContain('supportsAllDrives=true');
    expect(calls[0].headers.authorization).toBe('Bearer tok');
  });

  it('an unsupported native Google type is remote_unresolvable BEFORE any fetch', async () => {
    const { fetchImpl, calls } = stub([]);
    const r = req({ meta: meta({ mime_type: 'application/vnd.google-apps.form' }) });
    expect(await catchCode(buildGoogleRemoteByteResolver({ fetchImpl })(r))).toBe('remote_unresolvable');
    expect(calls.length).toBe(0);
  });

  it.each([
    ['document', '.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['spreadsheet', '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['presentation', '.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ])('advertises and fetches the same %s export without a duplicate extension', async (kind, extension, mime) => {
    const { fetchImpl, calls } = stub([{ bytes: Buffer.from('office'), contentType: 'application/octet-stream' }]);
    const resolver = buildGoogleRemoteByteResolver({ fetchImpl });
    const m = meta({ filename: `Plan${extension!.toUpperCase()}`, mime_type: `application/vnd.google-apps.${kind}` });
    const descriptor = resolver.describe!(m);
    expect(descriptor.export_as).toEqual({ filename: m.filename, mime_type: mime });
    expect(calls).toHaveLength(0);
    expect(await resolver(req({ remote_id: 'id /?#', meta: m }))).toEqual({ bytes: Buffer.from('office'), ...descriptor.export_as });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/drive/v3/files/id%20%2F%3F%23/export');
    expect(url.searchParams.get('mimeType')).toBe(mime);
    expect(url.searchParams.has('alt')).toBe(false);
    expect(calls[0]!.headers.authorization).toBe('Bearer tok');
  });

  it('refuses wrong export types and caps exported bytes even when source size is unknown', async () => {
    const m = meta({ filename: 'Document', mime_type: 'application/vnd.google-apps.document' });
    const wrong = stub([{ bytes: Buffer.from('<html>'), contentType: 'text/html' }]);
    await expect(buildGoogleRemoteByteResolver(wrong)(req({ meta: m }))).rejects.toMatchObject({ code: 'remote_fetch_failed' });
    const large = stub([{ contentLength: String(11 * 1024 * 1024) }]);
    await expect(buildGoogleRemoteByteResolver(large)(req({ meta: m }))).rejects.toMatchObject({ code: 'remote_too_large' });
    const chunked = stub([{ bytes: Buffer.from('longer than cap') }]);
    await expect(buildGoogleRemoteByteResolver(chunked)(req({ meta: m, maxBytes: 5 }))).rejects.toMatchObject({ code: 'remote_too_large' });
  });

  it('an oversized Content-Length → remote_too_large before buffering', async () => {
    const { fetchImpl } = stub([{ contentLength: '999', bytes: new Uint8Array(1) }]);
    expect(await catchCode(buildGoogleRemoteByteResolver({ fetchImpl })(req({ maxBytes: 10 })))).toBe(
      'remote_too_large',
    );
  });
});

describe('buildOneDriveRemoteByteResolver (onedrive + sharepoint)', () => {
  it('GETs /me/drive/items/{id}/content when no drive_id', async () => {
    const { fetchImpl, calls } = stub([{ bytes: Buffer.from('x'), contentType: 'application/pdf' }]);
    const out = await buildOneDriveRemoteByteResolver({ fetchImpl })(req({ remote_id: 'AAA' }));
    expect(out.mime_type).toBe('application/pdf');
    expect(calls[0].url).toBe('https://graph.microsoft.com/v1.0/me/drive/items/AAA/content');
    expect(calls[0].headers.authorization).toBe('Bearer tok');
  });

  it('targets /drives/{drive_id}/items/{id}/content for a SharePoint library', async () => {
    const { fetchImpl, calls } = stub([{ bytes: Buffer.from('x') }]);
    const resolver = buildOneDriveRemoteByteResolver({ fetchImpl }, { vendorLabel: 'sharepoint' });
    await resolver(req({ remote_id: 'BBB', cred: bearerCred({ drive_id: 'drv-9' }) }));
    expect(calls[0].url).toBe('https://graph.microsoft.com/v1.0/drives/drv-9/items/BBB/content');
  });
});

describe('buildBoxRemoteByteResolver', () => {
  it('GETs /2.0/files/{id}/content with the bearer', async () => {
    const { fetchImpl, calls } = stub([{ bytes: Buffer.from('zip'), contentType: 'application/zip' }]);
    const out = await buildBoxRemoteByteResolver({ fetchImpl })(req({ remote_id: '778' }));
    expect(out.mime_type).toBe('application/zip');
    expect(calls[0].url).toBe('https://api.box.com/2.0/files/778/content');
    expect(calls[0].headers.authorization).toBe('Bearer tok');
  });
});

describe('buildNotionRemoteByteResolver', () => {
  it('a prong-2 property file (colon-joined id) is remote_unresolvable BEFORE any fetch', async () => {
    const { fetchImpl, calls } = stub([]);
    const r = req({ remote_id: 'row1:prop2:file:deadbeef' });
    expect(await catchCode(buildNotionRemoteByteResolver({ fetchImpl })(r))).toBe('remote_unresolvable');
    expect(calls.length).toBe(0);
  });

  it('a prong-1 block re-resolves a fresh signed url then downloads it UN-authed', async () => {
    const signed = 'https://prod-files-secure.s3.amazonaws.com/abc/report.pdf?X-Amz-Signature=xyz';
    const { fetchImpl, calls } = stub([
      { json: { object: 'block', id: 'blk1', type: 'pdf', pdf: { type: 'file', file: { url: signed } } } },
      { bytes: Buffer.from('pdf-bytes'), contentType: 'application/pdf' },
    ]);
    const out = await buildNotionRemoteByteResolver({ fetchImpl })(req({ remote_id: 'blk1' }));
    expect(out).toEqual({ bytes: Buffer.from('pdf-bytes'), mime_type: 'application/pdf' });
    expect(calls[0].url).toBe('https://api.notion.com/v1/blocks/blk1');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect(calls[0].headers['Notion-Version']).toBeTruthy();
    expect(calls[1].url).toBe(signed);
    expect(calls[1].headers.Authorization).toBeUndefined(); // the signed url takes no bearer
  });

  it('an external-url block downloads the permanent external url', async () => {
    const ext = 'https://example.com/photo.jpg';
    const { fetchImpl, calls } = stub([
      { json: { type: 'image', image: { type: 'external', external: { url: ext } } } },
      { bytes: Buffer.from('jpg'), contentType: 'image/jpeg' },
    ]);
    const out = await buildNotionRemoteByteResolver({ fetchImpl })(req({ remote_id: 'blk2' }));
    expect(out.mime_type).toBe('image/jpeg');
    expect(calls[1].url).toBe(ext);
  });

  it('a block that no longer carries a file url → remote_unresolvable', async () => {
    const { fetchImpl } = stub([{ json: { type: 'paragraph', paragraph: {} } }]);
    expect(await catchCode(buildNotionRemoteByteResolver({ fetchImpl })(req({ remote_id: 'blk3' })))).toBe(
      'remote_unresolvable',
    );
  });

  it('a non-ok block GET → remote_fetch_failed', async () => {
    const { fetchImpl } = stub([{ ok: false, status: 404, text: 'object_not_found' }]);
    expect(await catchCode(buildNotionRemoteByteResolver({ fetchImpl })(req({ remote_id: 'blk4' })))).toBe(
      'remote_fetch_failed',
    );
  });
});

describe('buildRemoteFileByteResolvers registry', () => {
  it('registers a resolver for every fan-out vendor + s3', () => {
    const reg = buildRemoteFileByteResolvers({ fetchImpl: stub([]).fetchImpl });
    for (const v of ['s3', 'dropbox', 'google', 'onedrive', 'sharepoint', 'box', 'notion']) {
      expect(typeof reg[v]).toBe('function');
    }
  });
});

describe('shared http-bytes handling (via the box resolver)', () => {
  it('strips Content-Type parameters and keeps a precise mime', async () => {
    const { fetchImpl } = stub([{ bytes: Buffer.from('x'), contentType: 'application/pdf; charset=binary' }]);
    const out = await buildBoxRemoteByteResolver({ fetchImpl })(req({ remote_id: '1' }));
    expect(out.mime_type).toBe('application/pdf');
  });

  it('omits a generic application/octet-stream mime so the mirror meta wins', async () => {
    const { fetchImpl } = stub([{ bytes: Buffer.from('y'), contentType: 'application/octet-stream' }]);
    const out = await buildBoxRemoteByteResolver({ fetchImpl })(req({ remote_id: '2' }));
    expect(out.mime_type).toBeUndefined();
  });

  it('a body past maxBytes → remote_too_large (post-fetch backstop, no Content-Length)', async () => {
    const { fetchImpl } = stub([{ bytes: new Uint8Array(11) }]);
    expect(await catchCode(buildBoxRemoteByteResolver({ fetchImpl })(req({ maxBytes: 10 })))).toBe(
      'remote_too_large',
    );
  });
});

describe('D-192 M2 — the byte ceiling is enforced on the STREAM, not after a full buffer', () => {
  // A response whose BODY is a chunked stream with NO content-length — the CDN
  // download-hop shape the preflight can't catch. `arrayBuffer` THROWS, so a test
  // that passes proves the streaming path (not the full-buffer fallback) ran.
  const streamRes = (chunks: Uint8Array[]): FileFetchResponse => {
    let idx = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (idx < chunks.length) controller.enqueue(chunks[idx++]);
        else controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      headers: new Headers(), // NO content-length → preflight cannot fire
      text: async () => '',
      json: async () => ({}),
      arrayBuffer: async () => { throw new Error('must not buffer the whole body when a stream is available'); },
      body,
    };
  };
  const fetchReturning = (res: FileFetchResponse): FileFetch => (async () => res) as unknown as FileFetch;

  it('aborts a chunked / length-less OVERSIZE download without buffering it', async () => {
    // 4×10 = 40 bytes over a 25-byte cap → must abort mid-stream (never arrayBuffer).
    const res = streamRes(Array.from({ length: 4 }, () => new Uint8Array(10)));
    await expect(
      fetchRemoteBytes({ fetchImpl: fetchReturning(res), url: 'https://cdn.example/x', headers: {}, maxBytes: 25, vendorLabel: 'Box', ref: 'r1' }),
    ).rejects.toMatchObject({ code: 'remote_too_large' });
  });

  it('returns the bytes for an under-cap stream', async () => {
    const res = streamRes([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    const out = await fetchRemoteBytes({ fetchImpl: fetchReturning(res), url: 'https://cdn.example/x', headers: {}, maxBytes: 25, vendorLabel: 'Box', ref: 'r1' });
    expect([...out.bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it('cancels an oversized declared body before reading it', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const res: FileFetchResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '26' }),
      text: async () => { throw new Error('must not read'); },
      json: async () => ({}),
      arrayBuffer: async () => { throw new Error('must not buffer'); },
      body,
    };

    await expect(fetchRemoteBytes({
      fetchImpl: fetchReturning(res),
      url: 'https://cdn.example/x',
      headers: {},
      maxBytes: 25,
      vendorLabel: 'Box',
      ref: 'r1',
    })).rejects.toMatchObject({ code: 'remote_too_large' });
    expect(cancelled).toBe(true);
  });

  it('caps and cancels a provider error body instead of calling unbounded text()', async () => {
    let cancelled = false;
    let textCalled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const res: FileFetchResponse = {
      ok: false,
      status: 502,
      headers: new Headers({ 'content-length': '5000' }),
      text: async () => {
        textCalled = true;
        throw new Error('must not buffer provider error body');
      },
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
      body,
    };

    await expect(fetchRemoteBytes({
      fetchImpl: fetchReturning(res),
      url: 'https://cdn.example/x',
      headers: {},
      maxBytes: 25,
      vendorLabel: 'Box',
      ref: 'r1',
    })).rejects.toMatchObject({ code: 'remote_fetch_failed', status: 502 });
    expect(textCalled).toBe(false);
    expect(cancelled).toBe(true);
  });

  it('keeps an abortable deadline active while the response body stalls', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl: FileFetch = async (_url, init) => {
        signal = init.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const abort = (): void => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              controller.error(error);
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          },
        });
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
          arrayBuffer: async () => new ArrayBuffer(0),
          body,
        };
      };
      const pending = fetchRemoteBytes({
        fetchImpl,
        url: 'https://cdn.example/x',
        headers: {},
        maxBytes: 25,
        vendorLabel: 'Box',
        ref: 'r1',
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'remote_fetch_failed',
        status: 504,
        message: expect.stringContaining('timed out'),
      });

      await vi.advanceTimersByTimeAsync(REMOTE_BYTE_FETCH_TIMEOUT_MS);
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
