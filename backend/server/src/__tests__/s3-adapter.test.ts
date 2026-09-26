/** Phase 7 (D-110) — S3 adapter + notifications tests.
 *
 *  Uses a stub S3Fetch that pretends to be a minimal S3 endpoint,
 *  so we cover SigV4 signing + client verbs + factory lifecycle +
 *  notification parsing without touching the network. */

import { describe, expect, it, vi } from 'vitest';
import {
  createS3AdapterFactory,
  parseS3Notification,
  type S3Fetch,
} from '../collections/file/adapters/s3/index.js';
import { probeAdapter } from '../collections/file/adapter-registry.js';
import { canonicalQuery, encodeRfc3986, signRequest } from '../collections/file/adapters/s3/sig.js';
import {
  S3_CONTROL_RESPONSE_MAX_BYTES,
  S3_REQUEST_TIMEOUT_MS,
  createS3Client,
} from '../collections/file/adapters/s3/client.js';

interface FakeObject {
  body: Uint8Array;
  mime?: string;
}

const sharedFixedNow = (): Date => new Date('2026-04-22T12:00:00Z');

/** Fake in-memory S3 endpoint supporting HEAD (bucket) + PUT/GET/DELETE
 *  + LIST. Matches AWS virtual-host-style URLs
 *  (`{bucket}.s3.{region}.amazonaws.com/{key}`) by reading the host
 *  rather than the path. All other requests → 400. */
const fakeBucket = (bucket: string, writable = true): S3Fetch => {
  const store = new Map<string, FakeObject>();

  const makeResponse = (status: number, body?: string | Uint8Array, contentType?: string) => {
    const headers = new Headers();
    if (contentType) headers.set('content-type', contentType);
    const buf =
      typeof body === 'string'
        ? new TextEncoder().encode(body)
        : body ?? new Uint8Array();
    return {
      ok: status < 400,
      status,
      headers,
      async arrayBuffer(): Promise<ArrayBuffer> {
        // `buf.buffer` can be `ArrayBufferLike` under the generic
        // Uint8Array typing; stub backing buffers are always plain
        // `ArrayBuffer`, so the narrowing cast is safe here.
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      },
      async text() {
        return typeof body === 'string' ? body : '';
      },
    };
  };

  return async (url, init) => {
    const parsed = new URL(url);
    const method = init.method.toUpperCase();
    const hostBucket = parsed.host.split('.')[0];
    if (hostBucket !== bucket) {
      return makeResponse(404, '<Error><Code>NoSuchBucket</Code></Error>');
    }
    const keyPath = parsed.pathname.replace(/^\//, '');

    if (method === 'HEAD' && keyPath === '') {
      return makeResponse(200);
    }

    if (method === 'HEAD') {
      const obj = store.get(decodeURIComponent(keyPath));
      if (!obj) return makeResponse(404, '<Error><Code>NoSuchKey</Code></Error>');
      const resp = makeResponse(200, undefined, obj.mime);
      (resp.headers as Headers).set('content-length', String(obj.body.byteLength));
      (resp.headers as Headers).set('last-modified', 'Wed, 22 Apr 2026 12:00:00 GMT');
      return resp;
    }

    if (method === 'GET' && keyPath === '' && parsed.searchParams.get('list-type') === '2') {
      const keys = [...store.keys()].map((k) => `<Contents><Key>${k}</Key></Contents>`).join('');
      return makeResponse(
        200,
        `<ListBucketResult>${keys}</ListBucketResult>`,
      );
    }

    if (method === 'PUT') {
      if (!writable) {
        return makeResponse(403, '<Error><Code>AccessDenied</Code></Error>');
      }
      const body = init.body;
      const buf =
        typeof body === 'string' ? new TextEncoder().encode(body) : body ?? new Uint8Array();
      store.set(decodeURIComponent(keyPath), {
        body: buf,
        mime: init.headers['content-type'],
      });
      return makeResponse(200);
    }
    if (method === 'GET') {
      const obj = store.get(decodeURIComponent(keyPath));
      if (!obj) return makeResponse(404, '<Error><Code>NoSuchKey</Code></Error>');
      return makeResponse(200, obj.body, obj.mime);
    }
    if (method === 'DELETE') {
      if (!writable) {
        return makeResponse(403, '<Error><Code>AccessDenied</Code></Error>');
      }
      store.delete(decodeURIComponent(keyPath));
      return makeResponse(204);
    }
    return makeResponse(400);
  };
};

describe('S3 SigV4 signer', () => {
  it('produces an authorization header with the expected structure', () => {
    const signed = signRequest({
      access_key: 'AKIDEXAMPLE',
      secret_key: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 's3',
      url: new URL('https://bucket.s3.us-east-1.amazonaws.com/key'),
      method: 'GET',
      headers: {},
      payload: '',
      now: sharedFixedNow(),
    });
    expect(signed.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(signed.headers['x-amz-date']).toBe('20260422T120000Z');
    expect(signed.headers['x-amz-content-sha256']).toHaveLength(64);
  });

  it('different payloads produce different signatures', () => {
    const opts = {
      access_key: 'A',
      secret_key: 'S',
      region: 'us-east-1',
      service: 's3',
      url: new URL('https://bucket.s3.us-east-1.amazonaws.com/key'),
      method: 'PUT',
      headers: {},
      now: sharedFixedNow(),
    };
    const a = signRequest({ ...opts, payload: 'a' });
    const b = signRequest({ ...opts, payload: 'b' });
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
  });
});

describe('S3 SigV4 query encoding — RFC 3986 wire⟷signature parity (D-192 CORE #5d)', () => {
  const cfg = {
    access_key: 'AKID',
    secret_key: 'SEC',
    region: 'us-east-1',
    bucket: 'mybucket',
  };

  /** Simulate AWS's SERVER-SIDE canonicalization of a RECEIVED query string:
   *  split on `&`/`=`, RFC-3986 percent-DECODE each token (`decodeURIComponent`
   *  leaves `+` as a literal `+`, NOT space — the exact SigV4 semantics, unlike a
   *  form parser), re-encode each with the strict encoder, sort by key. The signed
   *  canonical query MUST equal this, or AWS returns `SignatureDoesNotMatch`. */
  const awsCanonicalize = (search: string): string => {
    const q = search.replace(/^\?/, '');
    if (q === '') return '';
    return q
      .split('&')
      .map((pair) => {
        const i = pair.indexOf('=');
        return [decodeURIComponent(pair.slice(0, i)), decodeURIComponent(pair.slice(i + 1))] as const;
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
      .join('&');
  };

  it('encodeRfc3986 encodes space + the five sub-delims encodeURIComponent spares; leaves the unreserved set', () => {
    expect(encodeRfc3986(' ')).toBe('%20');
    expect(encodeRfc3986('!')).toBe('%21');
    expect(encodeRfc3986("'")).toBe('%27');
    expect(encodeRfc3986('(')).toBe('%28');
    expect(encodeRfc3986(')')).toBe('%29');
    expect(encodeRfc3986('*')).toBe('%2A');
    // RFC 3986 unreserved — NEVER encoded.
    expect(encodeRfc3986("AZaz09-_.~")).toBe('AZaz09-_.~');
    // A realistic import_scope prefix carrying several failing chars.
    expect(encodeRfc3986("My Files!/a(b)'c*d")).toBe('My%20Files%21%2Fa%28b%29%27c%2Ad');
  });

  it('canonicalQuery emits strict RFC-3986, sorted by key', () => {
    const url = new URL('https://bucket.s3.us-east-1.amazonaws.com/');
    url.search = "list-type=2&prefix=My%20Files%21&fetch-owner=true";
    expect(canonicalQuery(url)).toBe('fetch-owner=true&list-type=2&prefix=My%20Files%21');
  });

  it('end-to-end: a listObjectsV2Page prefix with space/!/(/)/*/\' rides the wire RFC-3986 encoded (no `+`, no literal sub-delims) AND matches what AWS re-canonicalizes', async () => {
    let wire = '';
    const capturing: S3Fetch = async (url) => {
      wire = url;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
        async text() {
          return '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>';
        },
      };
    };
    const client = createS3Client({ config: cfg, fetcher: capturing, now: sharedFixedNow });
    await client.listObjectsV2Page({ prefix: "My Files!/a(b)'c*" });

    const wireSearch = new URL(wire).search;
    // The wire query is strict RFC-3986: space→%20, the sub-delims→%2X.
    expect(wireSearch).toContain('prefix=My%20Files%21%2Fa%28b%29%27c%2A');
    // Regression guards against the URLSearchParams form-encoding that caused the bug.
    expect(wireSearch).not.toContain('+'); // space would be `+`
    expect(wireSearch).not.toMatch(/prefix=[^&]*[!'()]/); // literal sub-delims
    // THE invariant: the query AWS re-canonicalizes off the wire equals the query
    // the client signed. `canonicalQuery(new URL(wire))` reconstructs the signed
    // side; `awsCanonicalize(wireSearch)` is the server side. With the old
    // URLSearchParams wire (`+` for space) these diverge → SignatureDoesNotMatch.
    expect(canonicalQuery(new URL(wire))).toBe(awsCanonicalize(wireSearch));
  });

  it('an opaque base64 continuation token (+ / =) round-trips identically on wire + signature (the common path stays intact)', async () => {
    let wire = '';
    const capturing: S3Fetch = async (url) => {
      wire = url;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
        async text() {
          return '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>';
        },
      };
    };
    const client = createS3Client({ config: cfg, fetcher: capturing, now: sharedFixedNow });
    await client.listObjectsV2Page({ continuationToken: 'AbC1+/9x==' });

    const wireSearch = new URL(wire).search;
    expect(wireSearch).toContain('continuation-token=AbC1%2B%2F9x%3D%3D');
    expect(canonicalQuery(new URL(wire))).toBe(awsCanonicalize(wireSearch));
  });
});

describe('S3 client response lifecycle', () => {
  const config = {
    access_key: 'AKID',
    secret_key: 'SEC',
    region: 'us-east-1',
    bucket: 'mybucket',
  };

  it('⛔ an object operation refuses an empty key: it would address the bucket itself', async () => {
    // Before, `file-delete` with no path sent DELETE to the bucket (DeleteBucket),
    // `file-read` returned the listing and `file-stat` called the bucket a file.
    const sent: string[] = [];
    const fetcher: S3Fetch = async (url, init) => {
      sent.push(`${init.method} ${url}`);
      return {
        ok: true, status: 204, headers: new Headers(), body: null,
        arrayBuffer: async () => new ArrayBuffer(0), text: async () => '',
      } as never;
    };
    const client = createS3Client({ config, fetcher, now: sharedFixedNow });
    for (const key of ['', undefined as unknown as string]) {
      await expect(client.deleteObject(key)).rejects.toMatchObject({ code: 'InvalidObjectKey', status: 400 });
      await expect(client.getObject(key, 10)).rejects.toMatchObject({ code: 'InvalidObjectKey' });
      await expect(client.headObject(key)).rejects.toMatchObject({ code: 'InvalidObjectKey' });
      await expect(client.putObject(key, new Uint8Array(1))).rejects.toMatchObject({ code: 'InvalidObjectKey' });
    }
    expect(sent).toEqual([]);
    // A real key still goes out, to the object's own URL.
    await client.deleteObject('reports/q3.pdf');
    expect(sent).toEqual(['DELETE https://mybucket.s3.us-east-1.amazonaws.com/reports/q3.pdf']);
  });

  it('⛔ an object operation refuses a "." or ".." segment: the URL would resolve it away', async () => {
    // `new URL()` resolves dot segments. Before, `.`, `./`, `..` and `a/..` sent DELETE
    // to the bucket (DeleteBucket), `..` in path style reached the service root, and
    // `./b` or `a/../b` addressed `b` rather than the object named.
    const sent: string[] = [];
    const fetcher: S3Fetch = async (url, init) => {
      sent.push(`${init.method} ${url}`);
      return {
        ok: true, status: 204, headers: new Headers(), body: null,
        arrayBuffer: async () => new ArrayBuffer(0), text: async () => '',
      } as never;
    };
    const virtualHosted = createS3Client({ config, fetcher, now: sharedFixedNow });
    const pathStyle = createS3Client({
      config: { ...config, endpoint: 'https://minio.local:9000' }, fetcher, now: sharedFixedNow,
    });
    for (const client of [virtualHosted, pathStyle]) {
      for (const key of ['.', './', '..', '../', 'a/..', 'a/.', './b', 'a/../b', 'a/./b']) {
        await expect(client.deleteObject(key), key).rejects.toMatchObject({ code: 'InvalidObjectKey', status: 400 });
        await expect(client.getObject(key, 10), key).rejects.toMatchObject({ code: 'InvalidObjectKey' });
        await expect(client.headObject(key), key).rejects.toMatchObject({ code: 'InvalidObjectKey' });
        await expect(client.putObject(key, new Uint8Array(1)), key).rejects.toMatchObject({ code: 'InvalidObjectKey' });
      }
    }
    expect(sent).toEqual([]);
    // Dots inside a segment are ordinary characters, and those keys go out as written.
    for (const key of ['.hidden', 'a..b', '...', 'v1.2/notes..txt']) await virtualHosted.deleteObject(key);
    await pathStyle.deleteObject('.hidden');
    expect(sent).toEqual([
      'DELETE https://mybucket.s3.us-east-1.amazonaws.com/.hidden',
      'DELETE https://mybucket.s3.us-east-1.amazonaws.com/a..b',
      'DELETE https://mybucket.s3.us-east-1.amazonaws.com/...',
      'DELETE https://mybucket.s3.us-east-1.amazonaws.com/v1.2/notes..txt',
      'DELETE https://minio.local:9000/mybucket/.hidden',
    ]);
  });

  it('enforces getObject maxBytes on a length-less response stream', async () => {
    let cancelled = false;
    const fetcher: S3Fetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(6));
        },
        cancel() {
          cancelled = true;
        },
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body,
        arrayBuffer: async () => { throw new Error('must not buffer the whole object'); },
        text: async () => '',
      };
    };
    const client = createS3Client({ config, fetcher, now: sharedFixedNow });

    await expect(client.getObject('large.bin', 10)).rejects.toMatchObject({
      code: 'EntityTooLarge',
      status: 413,
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('bounds and releases an oversized ListObjects response', async () => {
    let cancelled = false;
    let textCalled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetcher: S3Fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-length': String(S3_CONTROL_RESPONSE_MAX_BYTES + 1),
      }),
      body,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => {
        textCalled = true;
        return '';
      },
    });
    const client = createS3Client({ config, fetcher, now: sharedFixedNow });

    await expect(client.listObjects()).rejects.toMatchObject({
      code: 'EntityTooLarge',
      status: 413,
    });
    expect(textCalled).toBe(false);
    expect(cancelled).toBe(true);
  });

  it('keeps an abortable deadline active while getObject body stalls', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetcher: S3Fetch = async (_url, init) => {
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
          body,
          arrayBuffer: async () => new ArrayBuffer(0),
          text: async () => '',
        };
      };
      const client = createS3Client({ config, fetcher, now: sharedFixedNow });
      const pending = client.getObject('stalled.bin', 10);
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'RequestTimeout',
        status: 504,
      });

      await vi.advanceTimersByTimeAsync(S3_REQUEST_TIMEOUT_MS);
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('S3 adapter probe (Phase 7 / D-110)', () => {
  const baseConfig = {
    access_key: 'AKID',
    secret_key: 'SEC',
    region: 'us-east-1',
    bucket: 'mybucket',
  };

  it('reports full caps on a writable bucket', async () => {
    const fetcher = fakeBucket('mybucket', true);
    const factory = createS3AdapterFactory({ fetcher, now: sharedFixedNow });
    const caps = await probeAdapter(factory, { ...baseConfig });
    expect(caps.read).toBe('yes');
    expect(caps.write).toBe('yes');
    expect(caps.delete).toBe('yes');
    expect(caps.auth).toBe('keys');
    expect(caps.path_style).toBe('s3-key');
    expect(caps.watch).toBe('poll');
  });

  it('reports realtime watch when notifications_enabled=true', async () => {
    const fetcher = fakeBucket('mybucket', true);
    const factory = createS3AdapterFactory({ fetcher, now: sharedFixedNow });
    const caps = await probeAdapter(factory, {
      ...baseConfig,
      notifications_enabled: true,
    });
    expect(caps.watch).toBe('realtime');
  });

  it('reports write: no on a non-writable bucket', async () => {
    const fetcher = fakeBucket('mybucket', false);
    const factory = createS3AdapterFactory({ fetcher, now: sharedFixedNow });
    const caps = await probeAdapter(factory, baseConfig);
    expect(caps.write).toBe('no');
    expect(caps.delete).toBe('no');
  });

  it('surfaces missing-config as a useful error', async () => {
    const factory = createS3AdapterFactory({ now: sharedFixedNow });
    await expect(
      probeAdapter(factory, { bucket: 'b' }),
    ).rejects.toThrow(/access_key is required/);
  });

  it('propagates HeadBucket failure', async () => {
    const fetcher = fakeBucket('otherbucket', true);
    const factory = createS3AdapterFactory({ fetcher, now: sharedFixedNow });
    await expect(
      probeAdapter(factory, baseConfig),
    ).rejects.toThrow(/HeadBucket/);
  });
});

describe('S3 adapter lifecycle (Phase 7 / D-110)', () => {
  it('applies the 5 MiB v1 ceiling to reads as well as writes', async () => {
    let arrayBufferCalled = false;
    const fetcher: S3Fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-length': String(5 * 1024 * 1024 + 1),
      }),
      async arrayBuffer() {
        arrayBufferCalled = true;
        return new ArrayBuffer(0);
      },
      async text() {
        return '';
      },
    });
    const factory = createS3AdapterFactory({ fetcher, now: sharedFixedNow });
    const adapter = factory.create({
      slug: 's3-test',
      config: {
        access_key: 'K',
        secret_key: 'S',
        region: 'us-east-1',
        bucket: 'mybucket',
        notifications_enabled: true,
      },
      onEvent: () => {},
    });

    await expect((adapter as never as {
      readRecord(k: string): Promise<Uint8Array>;
    }).readRecord('oversized.bin')).rejects.toMatchObject({ code: 'too_large' });
    expect(arrayBufferCalled).toBe(false);
  });

  it('write + read + delete + list cycle', async () => {
    const fetcher = fakeBucket('mybucket', true);
    const factory = createS3AdapterFactory({ fetcher, now: sharedFixedNow });
    const events: Array<{ type: string; path: string }> = [];
    const adapter = factory.create({
      slug: 's3-test',
      config: {
        access_key: 'K',
        secret_key: 'S',
        region: 'us-east-1',
        bucket: 'mybucket',
        notifications_enabled: true, // skip poll loop
      },
      onEvent: (e) => {
        events.push(e);
      },
    });
    await adapter.start();
    try {
      await (adapter as never as { writeRecord(k: string, b: Uint8Array): Promise<void> }).writeRecord(
        'notes/hello.txt',
        new TextEncoder().encode('hello'),
      );
      const read = await (adapter as never as {
        readRecord(k: string): Promise<Uint8Array>;
      }).readRecord('notes/hello.txt');
      expect(new TextDecoder().decode(read)).toBe('hello');
      await (adapter as never as { deleteRecord(k: string): Promise<void> }).deleteRecord(
        'notes/hello.txt',
      );
    } finally {
      await adapter.stop();
    }
  });

  it('refuses writes above the 5 MB v1 ceiling with TOO_LARGE', async () => {
    const fetcher = fakeBucket('mybucket', true);
    const factory = createS3AdapterFactory({ fetcher, now: sharedFixedNow });
    const adapter = factory.create({
      slug: 's3-test',
      config: {
        access_key: 'K',
        secret_key: 'S',
        region: 'us-east-1',
        bucket: 'mybucket',
        notifications_enabled: true,
      },
      onEvent: () => {},
    });
    await adapter.start();
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    try {
      await expect(
        (adapter as never as { writeRecord(k: string, b: Uint8Array): Promise<void> }).writeRecord(
          'big.bin',
          big,
        ),
      ).rejects.toThrow(/TOO_LARGE/);
    } finally {
      await adapter.stop();
    }
  });

  it('statRecord returns size + mtime + mime for an existing object', async () => {
    const fetcher = fakeBucket('mybucket', true);
    const factory = createS3AdapterFactory({ fetcher, now: sharedFixedNow });
    const adapter = factory.create({
      slug: 's3-test',
      config: {
        access_key: 'K',
        secret_key: 'S',
        region: 'us-east-1',
        bucket: 'mybucket',
        notifications_enabled: true,
      },
      onEvent: () => {},
    });
    await adapter.start();
    try {
      await (adapter as never as { writeRecord(k: string, b: Uint8Array, m?: string): Promise<void> }).writeRecord(
        'docs/report.pdf',
        new TextEncoder().encode('body-12345'),
        'application/pdf',
      );
      const stat = await (adapter as never as {
        statRecord(k: string): Promise<import('@recued/contracts').FileRecordStat>;
      }).statRecord('docs/report.pdf');
      expect(stat.exists).toBe(true);
      expect(stat.size_bytes).toBe(10);
      expect(stat.mime).toBe('application/pdf');
      expect(typeof stat.modified_at_ms).toBe('number');
    } finally {
      await adapter.stop();
    }
  });

  it('statRecord returns exists:false when the object is absent', async () => {
    const fetcher = fakeBucket('mybucket', true);
    const factory = createS3AdapterFactory({ fetcher, now: sharedFixedNow });
    const adapter = factory.create({
      slug: 's3-test',
      config: {
        access_key: 'K',
        secret_key: 'S',
        region: 'us-east-1',
        bucket: 'mybucket',
        notifications_enabled: true,
      },
      onEvent: () => {},
    });
    await adapter.start();
    try {
      const stat = await (adapter as never as {
        statRecord(k: string): Promise<import('@recued/contracts').FileRecordStat>;
      }).statRecord('ghost.pdf');
      expect(stat).toEqual({ exists: false });
    } finally {
      await adapter.stop();
    }
  });
});

describe('parseS3Notification (Phase 7 / D-110)', () => {
  it('parses a direct S3 event payload', () => {
    const body = JSON.stringify({
      Records: [
        {
          eventName: 'ObjectCreated:Put',
          s3: { bucket: { name: 'mybucket' }, object: { key: 'files/a.txt' } },
        },
        {
          eventName: 'ObjectRemoved:Delete',
          s3: { bucket: { name: 'mybucket' }, object: { key: 'files/b.txt' } },
        },
      ],
    });
    expect(parseS3Notification(body)).toEqual([
      { type: 'change', path: 'files/a.txt' },
      { type: 'remove', path: 'files/b.txt' },
    ]);
  });

  it('unwraps an SNS envelope', () => {
    const inner = JSON.stringify({
      Records: [
        {
          eventName: 'ObjectCreated:Put',
          s3: { bucket: { name: 'mybucket' }, object: { key: 'k' } },
        },
      ],
    });
    const sns = JSON.stringify({ Type: 'Notification', Message: inner });
    expect(parseS3Notification(sns)).toEqual([{ type: 'change', path: 'k' }]);
  });

  it('filters by expectedBucket when provided', () => {
    const body = JSON.stringify({
      Records: [
        { eventName: 'ObjectCreated:Put', s3: { bucket: { name: 'other' }, object: { key: 'a' } } },
        { eventName: 'ObjectCreated:Put', s3: { bucket: { name: 'mine' }, object: { key: 'b' } } },
      ],
    });
    expect(parseS3Notification(body, 'mine')).toEqual([{ type: 'change', path: 'b' }]);
  });

  it('decodes URL-encoded keys', () => {
    const body = JSON.stringify({
      Records: [
        { eventName: 'ObjectCreated:Put', s3: { bucket: { name: 'b' }, object: { key: 'dir/has%20space.txt' } } },
      ],
    });
    expect(parseS3Notification(body)).toEqual([
      { type: 'change', path: 'dir/has space.txt' },
    ]);
  });

  it('ignores unknown event types + malformed records', () => {
    const body = JSON.stringify({
      Records: [
        { eventName: 'ObjectRestore:Post', s3: { bucket: { name: 'b' }, object: { key: 'r' } } },
        { eventName: 'ObjectCreated:Put' }, // no s3
      ],
    });
    expect(parseS3Notification(body)).toEqual([]);
  });
});
