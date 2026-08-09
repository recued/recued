/** D-152 § A.16 — LAN-only webclient bundle handler tests.
 *
 *  Tests `createWebclientBundleHandler` in
 *  `backend/server/src/webclient-handler.ts`. Pure handler scope — no
 *  listener-set, no path-router, no http server. The factory's
 *  responsibilities:
 *
 *  1. Manifest verification at factory time (throws on mismatch).
 *  2. Methods other than GET / HEAD → 405 with `Allow: GET, HEAD`.
 *  3. `/webclient` and `/webclient/` → `index.html` from bundle.
 *  4. `/webclient/<path>` → exact bundle entry; 404 if not present.
 *  5. Path safety rejects (path traversal, backslashes, etc.) → 404.
 *  6. Response carries strict CSP + nosniff + no-referrer + correct
 *     MIME + cache headers based on path. */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { get as httpGet, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  WEBCLIENT_PATH_PREFIX,
  type WebclientBundleFile,
  type WebclientBundleManifest,
} from '@recued/contracts';
import {
  createWebclientBundleHandler,
  WebclientBundleVerificationError,
} from '../webclient-handler.js';

const WRONG_HASH = 'c'.repeat(64);

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body: Buffer | string | null = null;
  writableEnded = false;
  readonly headersSent = false;
  setHeader(k: string, v: string): void {
    this.headers[k.toLowerCase()] = v;
  }
  end(body?: Buffer | Uint8Array | string): void {
    if (body !== undefined) {
      this.body = body instanceof Uint8Array ? Buffer.from(body) : body;
    } else {
      this.body = '';
    }
    this.writableEnded = true;
  }
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Build a bundle file from path + bytes; computes the canonical
 *  sha256. Test helper — production callers may use stale/wrong
 *  hashes, but the handler re-hashes at factory time so the input
 *  hash is metadata only. */
const file = (path: string, bytes: Uint8Array | string): WebclientBundleFile => {
  const buf = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return { path, sha256: sha256Hex(buf), bytes: buf };
};

/** Build a bundle file with an EXPLICITLY WRONG sha256 metadata claim.
 *  Used by Codex W3.FU8 P2 #1 fold tests to assert the handler
 *  re-hashes the bytes + ignores the caller's claim. */
const fileWithWrongHash = (path: string, bytes: Uint8Array | string): WebclientBundleFile => {
  const buf = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return { path, sha256: WRONG_HASH, bytes: buf };
};

const buildReq = (args: { method?: string; url: string }): IncomingMessage =>
  ({
    method: args.method ?? 'GET',
    url: args.url,
    headers: {},
  } as unknown as IncomingMessage);

const run = (handler: ReturnType<typeof createWebclientBundleHandler>, args: { method?: string; url: string }): FakeRes => {
  const res = new FakeRes();
  handler(buildReq(args), res as unknown as ServerResponse);
  return res;
};

const INDEX = file('index.html', '<html><body>webclient</body></html>');
const SW = file('sw.js', 'self.addEventListener("install",e=>{})');
const ICON = file('icons/icon-192.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

const baseFiles = [INDEX, SW, ICON];

describe('D-152 § A.16 — manifest verification at factory time', () => {
  it('returns a handler when manifest + bundle match', () => {
    const manifest: WebclientBundleManifest = {
      files: [
        { path: INDEX.path, sha256: INDEX.sha256 },
        { path: SW.path, sha256: SW.sha256 },
        { path: ICON.path, sha256: ICON.sha256 },
      ],
    };
    expect(() =>
      createWebclientBundleHandler({ files: baseFiles, manifest }),
    ).not.toThrow();
  });

  it('throws WebclientBundleVerificationError when manifest hash does not match actual bytes', () => {
    const manifest: WebclientBundleManifest = {
      files: [{ path: INDEX.path, sha256: WRONG_HASH }],
    };
    try {
      createWebclientBundleHandler({ files: [INDEX], manifest });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WebclientBundleVerificationError);
      if (err instanceof WebclientBundleVerificationError) {
        expect(err.issues[0].code).toBe('bundle_sha256_mismatch');
        expect(err.issues[0].path).toBe(INDEX.path);
        // Re-hash discipline — verifier sees ACTUAL hash of bytes, not
        // the caller-supplied metadata claim.
        expect(err.issues[0].actual_sha256).toBe(INDEX.sha256);
        expect(err.issues[0].expected_sha256).toBe(WRONG_HASH);
      }
    }
  });

  it('throws when manifest is empty', () => {
    expect(() =>
      createWebclientBundleHandler({ files: [], manifest: { files: [] } }),
    ).toThrow(WebclientBundleVerificationError);
  });

  it('omitting manifest skips verification (substrate-test ergonomics)', () => {
    expect(() => createWebclientBundleHandler({ files: baseFiles })).not.toThrow();
  });
});

describe('D-152 § A.16 — Codex P2 #1 fold: re-hash bytes at serving boundary', () => {
  it('ignores caller-supplied wrong sha256 when bytes actually match the manifest', () => {
    // Caller-side metadata `sha256` is stale / wrong, but the bytes
    // are correct + match what the manifest expects. The factory
    // re-hashes the bytes, sees they match the manifest, and accepts
    // the bundle. This is the "caller bug protection" angle — wrong
    // metadata cannot get a good bundle rejected.
    const bytes = '<html><body>webclient</body></html>';
    const fileBad = fileWithWrongHash('index.html', bytes);
    const manifest: WebclientBundleManifest = {
      files: [{ path: 'index.html', sha256: sha256Hex(new TextEncoder().encode(bytes)) }],
    };
    expect(() =>
      createWebclientBundleHandler({ files: [fileBad], manifest }),
    ).not.toThrow();
  });

  it('rejects bundle when caller pairs correct sha256 with TAMPERED bytes (manifest sees actual content)', () => {
    // Caller pairs the manifest's correct hash with WRONG bytes
    // (representing an attacker swap of disk contents while the
    // metadata still matches the manifest). Re-hashing catches the
    // tampered bytes: actual hash of tampered bytes does not match
    // the manifest claim → reject.
    const manifestBytes = '<html><body>original</body></html>';
    const tamperedBytes = '<html><body>TAMPERED</body></html>';
    const manifest: WebclientBundleManifest = {
      files: [{ path: 'index.html', sha256: sha256Hex(new TextEncoder().encode(manifestBytes)) }],
    };
    // Caller-side metadata claims the manifest's hash but the actual
    // bytes are tampered. Without re-hashing, this would mount + serve
    // the tampered bytes.
    const tampered: WebclientBundleFile = {
      path: 'index.html',
      sha256: manifest.files[0].sha256, // matches manifest
      bytes: new TextEncoder().encode(tamperedBytes), // doesn't match
    };
    try {
      createWebclientBundleHandler({ files: [tampered], manifest });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WebclientBundleVerificationError);
      if (err instanceof WebclientBundleVerificationError) {
        expect(err.issues[0].code).toBe('bundle_sha256_mismatch');
      }
    }
  });
});

describe('D-152 § A.16 — happy path GET', () => {
  const handler = createWebclientBundleHandler({ files: baseFiles });

  it('GET /webclient serves index.html', () => {
    const res = run(handler, { url: '/webclient' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache, must-revalidate');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-length']).toBe(String(INDEX.bytes.byteLength));
    expect((res.body as Buffer).toString()).toBe('<html><body>webclient</body></html>');
  });

  it('GET /webclient/ also serves index.html', () => {
    const res = run(handler, { url: '/webclient/' });
    expect(res.statusCode).toBe(200);
    expect((res.body as Buffer).toString()).toBe('<html><body>webclient</body></html>');
  });

  it('GET /webclient/index.html serves the same file', () => {
    const res = run(handler, { url: '/webclient/index.html' });
    expect(res.statusCode).toBe(200);
    expect((res.body as Buffer).toString()).toBe('<html><body>webclient</body></html>');
  });

  it('GET /webclient/sw.js serves with javascript MIME and REVALIDATES', () => {
    const res = run(handler, { url: '/webclient/sw.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/javascript; charset=utf-8');
    // ⛔ NOT `max-age=3600`, and the service worker is the worst possible file to
    // cache for an hour. `webclient-handler.ts` moved every shell entry point to
    // revalidation because NOTHING is content-hashed — the build emits a fixed
    // `webclient-main.js` — so a long cache runs an hour-old bundle against a
    // just-restarted server. This test still asserted the superseded value.
    expect(res.headers['cache-control']).toBe('no-cache, must-revalidate');
  });

  it('GET /webclient/icons/icon-192.png serves with image MIME', () => {
    const res = run(handler, { url: '/webclient/icons/icon-192.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('strips ?query and #fragment before lookup', () => {
    const res = run(handler, { url: '/webclient/sw.js?v=123#frag' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/javascript; charset=utf-8');
  });
});

describe('D-152 § A.16 — HEAD request semantics', () => {
  const handler = createWebclientBundleHandler({ files: baseFiles });

  it('HEAD /webclient returns 200 with same headers but no body', () => {
    const res = run(handler, { method: 'HEAD', url: '/webclient' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-length']).toBe(String(INDEX.bytes.byteLength));
    expect(res.body).toBe('');
  });

  it('HEAD method case-insensitively normalises to upper-case', () => {
    const res = run(handler, { method: 'head', url: '/webclient' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });
});

describe('D-152 § A.16 — method rejection', () => {
  const handler = createWebclientBundleHandler({ files: baseFiles });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])(
    '%s returns 405 with Allow: GET, HEAD',
    (method) => {
      const res = run(handler, { method, url: '/webclient' });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('GET, HEAD');
      const parsed = JSON.parse(res.body as string);
      expect(parsed).toEqual({ error: { code: 'method_not_allowed' } });
    },
  );

  it('method gate runs BEFORE path safety / bundle lookup', () => {
    // POST with a path-safety violator still returns 405, not 404.
    const res = run(handler, { method: 'POST', url: '/webclient/../etc/passwd' });
    expect(res.statusCode).toBe(405);
  });
});

describe('D-152 § A.16 — 404 path-miss (file not in bundle)', () => {
  const handler = createWebclientBundleHandler({ files: baseFiles });

  it('GET /webclient/missing.js returns 404', () => {
    const res = run(handler, { url: '/webclient/missing.js' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.body).toBe(JSON.stringify({ error: { code: 'not_found' } }));
  });

  it('GET /webclient/index.HTML (case-sensitive) returns 404', () => {
    // Bundle paths are case-sensitive (matches Linux fs convention).
    const res = run(handler, { url: '/webclient/index.HTML' });
    expect(res.statusCode).toBe(404);
  });
});

describe('D-152 § A.16 — path safety rejects', () => {
  const handler = createWebclientBundleHandler({ files: baseFiles });

  it.each([
    '/webclient/../etc/passwd',
    '/webclient/foo/../../escape.html',
    '/webclient/foo\\bar.js',
    '/webclient/foo//double-slash.js',
  ])('rejects %s with 404 (path-safety regex)', (url) => {
    const res = run(handler, { url });
    expect(res.statusCode).toBe(404);
    expect(res.headers.location).toBeUndefined();
  });

  it('rejects requests outside the /webclient prefix (defense-in-depth)', () => {
    // The path-router carve-out should already filter these out, but
    // the handler 404s defensively if invoked with a non-prefixed path.
    const res = run(handler, { url: '/health' });
    expect(res.statusCode).toBe(404);
  });
});

describe('D-152 § A.16 — fingerprint discipline', () => {
  const handler = createWebclientBundleHandler({ files: baseFiles });

  it('404 body shape matches the path-router unknown-path 404', () => {
    // Same generic body so a visitor probing the LAN listener cannot
    // tell whether a path missed the bundle or missed the router.
    const res = run(handler, { url: '/webclient/missing.js' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.body).toBe(JSON.stringify({ error: { code: 'not_found' } }));
  });

  it('response body NEVER includes a file path that missed (no leak)', () => {
    const res = run(handler, { url: '/webclient/extremely-specific-filename-abc123.js' });
    expect(res.statusCode).toBe(404);
    expect(String(res.body)).not.toContain('extremely-specific-filename-abc123');
  });
});

describe('D-152 § A.16 — CSP discipline', () => {
  const handler = createWebclientBundleHandler({ files: baseFiles });

  it('CSP includes all required directives', () => {
    const res = run(handler, { url: '/webclient' });
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('connect-src');
  });

  it('CSP allows ws/wss/http/https connect for user-typed server URL', () => {
    const res = run(handler, { url: '/webclient' });
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain('ws:');
    expect(csp).toContain('wss:');
  });
});

describe('D-152 § A.16 — bundle-only constants', () => {
  it('WEBCLIENT_PATH_PREFIX is `/webclient`', () => {
    // Ratchet from contracts so callers using `${WEBCLIENT_PATH_PREFIX}/<sub>` stay in sync.
    expect(WEBCLIENT_PATH_PREFIX).toBe('/webclient');
  });
});

describe('D-152 § A.16 — idempotency', () => {
  it('is a no-op when the response has already ended', () => {
    const handler = createWebclientBundleHandler({ files: baseFiles });
    const res = new FakeRes();
    res.writableEnded = true;
    res.statusCode = 200;
    handler(buildReq({ url: '/webclient' }), res as unknown as ServerResponse);
    // Status untouched — helper bailed at the writableEnded check.
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBeUndefined();
  });
});

describe('D-152 § A.16 — Codex P2 #2 fold: startServer forwards webclientHandler', () => {
  it('startServer wires webclientBundle through to the LAN listener', async () => {
    const { startServer } = await import('../server.js');
    const bytes = '<html>hello-startserver</html>';
    const indexFile = file('index.html', bytes);
    const manifest: WebclientBundleManifest = {
      files: [{ path: 'index.html', sha256: indexFile.sha256 }],
    };
    const server = await startServer(0, {
      webclientBundle: { files: [indexFile], manifest },
      rootRedirectDisabled: true,
    });
    try {
      const port = server.port;
      const response = await fetch(`http://127.0.0.1:${port}/webclient/`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
      const body = await response.text();
      expect(body).toBe(bytes);
    } finally {
      await server.close();
    }
  }, 30_000);   // boots a real server + listener; the 5s default is for in-process tests

  it('startServer without webclientBundle 404s /webclient/* on the LAN listener', async () => {
    const { startServer } = await import('../server.js');
    const server = await startServer(0, {
      rootRedirectDisabled: true,
    });
    try {
      const port = server.port;
      const response = await fetch(`http://127.0.0.1:${port}/webclient/`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe('not_found');
    } finally {
      await server.close();
    }
  });
});

describe('Offline-pairing convenience — LAN bare-`/` → embedded webclient (startServer)', () => {
  // Raw GET (no redirect-following) so the 302 status + Location are asserted
  // directly rather than transparently followed to `/webclient/`.
  const rawGet = (
    url: string,
  ): Promise<{ status: number; location?: string; cacheControl?: string }> =>
    new Promise((resolve, reject) => {
      const req = httpGet(url, (res) => {
        res.resume(); // drain the body so the socket frees
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location,
          cacheControl: res.headers['cache-control'],
        });
      });
      req.on('error', reject);
    });

  // The production `getWebclientServable` closure reads
  // `(await getMachine().current()).resolution.webclient.lan`. A minimal
  // stub drives that bit without standing up a full ExposureStateMachine.
  const exposureDepsWithLan = (lan: boolean) =>
    ({
      getMachine: () => ({
        current: async () => ({ resolution: { webclient: { lan, public: false } } }),
      }),
    }) as unknown as import('../server.js').ServerConfig['exposureDeps'];

  const bundle = (): { files: WebclientBundleFile[]; manifest: WebclientBundleManifest } => {
    const indexFile = file('index.html', '<html>pair-me</html>');
    return {
      files: [indexFile],
      manifest: { files: [{ path: 'index.html', sha256: indexFile.sha256 }] },
    };
  };

  it('bare `/` 302-redirects to /webclient/ when a bundle is present + webclient.lan is on', async () => {
    const { startServer } = await import('../server.js');
    const server = await startServer(0, {
      webclientBundle: bundle(),
      exposureDeps: exposureDepsWithLan(true),
      // Disables ONLY the public apex redirect — proves the LAN webclient root
      // is an independent surface, NOT gated by `rootRedirectDisabled`.
      rootRedirectDisabled: true,
    });
    try {
      const res = await rawGet(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(302);
      expect(res.location).toBe('/webclient/');
      expect(res.cacheControl).toBe('no-store');
    } finally {
      await server.close();
    }
  });

  it('bare `/` 404s when no webclient bundle is present (a source build is unaffected)', async () => {
    const { startServer } = await import('../server.js');
    const server = await startServer(0, {
      exposureDeps: exposureDepsWithLan(true),
      rootRedirectDisabled: true,
    });
    try {
      const res = await rawGet(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(404);
      expect(res.location).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('bare `/` 404s defensively when the webclient is disabled on the LAN grid bit', async () => {
    const { startServer } = await import('../server.js');
    const server = await startServer(0, {
      webclientBundle: bundle(),
      exposureDeps: exposureDepsWithLan(false),
      rootRedirectDisabled: true,
    });
    try {
      const res = await rawGet(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
