/** D-345 slice A — a fetch of a public web address: what it reaches, what it refuses, what it keeps.
 *
 *  Local servers stand in for sites through an injected resolver and `treatAsPublic` (a real fetch
 *  refuses them, as it must: the last case shows it). */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isPublicAddress, publicFetch, PublicFetchError, type PublicFetchOptions } from '../public-fetch.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => { s.closeAllConnections(); s.close(done); })));
});

/** A local server answering with `handler`; its port. */
const serve = async (handler: http.RequestListener): Promise<number> => {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
};

/** Options under which `site.test` is the local server, and only it. */
const asSite = (extra: Partial<PublicFetchOptions> = {}): PublicFetchOptions => ({
  maxBytes: 1_000_000, overflow: 'fail', timeoutMs: 5_000,
  resolve: async (host) => (host === 'site.test' ? [{ address: '127.0.0.1', family: 4 }] : []),
  treatAsPublic: (address) => address === '127.0.0.1',
  ...extra,
});

const failure = async (promise: Promise<unknown>): Promise<PublicFetchError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PublicFetchError) return error;
    throw error;
  }
  throw new Error('the fetch answered');
};

describe('D-345 slice A — which addresses are public', () => {
  it.each([
    ['8.8.8.8', true], ['1.1.1.1', true], ['93.184.215.14', true],
    ['127.0.0.1', false], ['10.1.2.3', false], ['172.16.5.4', false], ['192.168.1.1', false], ['100.64.0.1', false],
    ['169.254.169.254', false], ['0.0.0.0', false], ['224.0.0.1', false], ['255.255.255.255', false],
    // A fake-IP proxy's answer for a public name (www.w3.org on the owner's Mac): the proxy connects on.
    ['198.18.13.163', true],
    ['2606:4700:4700::1111', true], ['::1', false], ['::', false], ['fe80::1', false], ['fd00:ec2::254', false],
    ['ff02::1', false], ['2001:db8::1', false], ['2002::1', false],
    ['::ffff:127.0.0.1', false], ['::ffff:7f00:1', false], ['::ffff:8.8.8.8', true], ['64:ff9b::7f00:1', false],
    ['64:ff9b::808:808', true], ['[::1]', false], ['not an address', false],
  ] as const)('%s → %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe('D-345 slice A — a fetch of a public address', () => {
  it('answers the body, its status and headers, and sends nothing of the owner', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const port = await serve((req, res) => {
      seen = req.headers;
      res.setHeader('set-cookie', 'session=1');
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('hello');
    });
    const got = await publicFetch(`http://site.test:${String(port)}/a`, asSite());
    expect(got).toMatchObject({ status: 200, url: `http://site.test:${String(port)}/a`, truncated: false, redirects: [] });
    expect(got.body.toString()).toBe('hello');
    expect(got.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(got.headers).not.toHaveProperty('set-cookie');
    expect(seen.host).toBe(`site.test:${String(port)}`);
    expect(seen).not.toHaveProperty('cookie');
    expect(seen).not.toHaveProperty('authorization');
  });

  it('refuses a name that leads to an address that is not public, any of them', async () => {
    for (const addresses of [[{ address: '10.0.0.7', family: 4 as const }],
      [{ address: '8.8.8.8', family: 4 as const }, { address: '127.0.0.1', family: 4 as const }]]) {
      const error = await failure(publicFetch('http://inside.example.com/', { maxBytes: 10, overflow: 'fail', timeoutMs: 2_000,
        resolve: async () => addresses }));
      expect(error.code).toBe('not_public');
    }
  });

  it('refuses localhost, an address that is not public, another scheme and a name and password', async () => {
    const plain = { maxBytes: 10, overflow: 'fail' as const, timeoutMs: 2_000 };
    for (const address of ['http://localhost:7886/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data',
      'http://intranet/']) {
      expect((await failure(publicFetch(address, plain))).code, address).toBe('not_public');
    }
    for (const address of ['file:///etc/passwd', 'ftp://example.com/', 'https://me:secret@example.com/', 'not an address']) {
      expect((await failure(publicFetch(address, plain))).code, address).toBe('bad_address');
    }
  });

  it('connects to the address it checked: the name is resolved once a hop', async () => {
    const port = await serve((_req, res) => res.end('ok'));
    const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }]);
    await publicFetch(`http://site.test:${String(port)}/`, asSite({ resolve }));
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect after checking where it leads, and refuses one into the server\'s network', async () => {
    const port = await serve((req, res) => {
      if (req.url === '/moved') { res.writeHead(302, { location: '/here' }); res.end(); return; }
      if (req.url === '/inside') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); res.end(); return; }
      if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
      res.end('here');
    });
    const got = await publicFetch(`http://site.test:${String(port)}/moved`, asSite());
    expect(got.body.toString()).toBe('here');
    expect(got.redirects).toEqual([`http://site.test:${String(port)}/here`]);
    expect((await failure(publicFetch(`http://site.test:${String(port)}/inside`, asSite()))).code).toBe('not_public');
    expect((await failure(publicFetch(`http://site.test:${String(port)}/loop`, asSite()))).code).toBe('too_many_redirects');
  });

  it('keeps at most maxBytes of the decompressed body: cut and said, or refused', async () => {
    const big = 'x'.repeat(50_000);
    const port = await serve((_req, res) => {
      res.setHeader('content-encoding', 'gzip');
      res.end(gzipSync(big));
    });
    const cut = await publicFetch(`http://site.test:${String(port)}/`, asSite({ maxBytes: 1_000, overflow: 'truncate' }));
    expect(cut.body.length).toBe(1_000);
    expect(cut.truncated).toBe(true);
    expect((await failure(publicFetch(`http://site.test:${String(port)}/`, asSite({ maxBytes: 1_000 })))).code).toBe('too_large');
    const whole = await publicFetch(`http://site.test:${String(port)}/`, asSite());
    expect(whole.body.toString()).toBe(big);
  });

  it('answers headers only to HEAD, and gives up on a site that does not answer in time', async () => {
    const port = await serve((req, res) => {
      if (req.url === '/slow') return;
      res.setHeader('content-length', '5');
      res.end(req.method === 'HEAD' ? undefined : 'hello');
    });
    const head = await publicFetch(`http://site.test:${String(port)}/`, asSite({ method: 'HEAD' }));
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBe('5');
    expect((await failure(publicFetch(`http://site.test:${String(port)}/slow`, asSite({ timeoutMs: 300 })))).code).toBe('timeout');
  });

  // 2026-11-23 (task L; the owner: "go ahead with L download fix too") — nothing new for `idleTimeoutMs` ends a fetch,
  // said as a stall; an answer still arriving goes on, past the idle limit in all.
  it('goes on while the answer keeps arriving, and lets go of one that stalls or never answers, saying so', async () => {
    const port = await serve((req, res) => {
      if (req.url === '/silent') return;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      if (req.url === '/stall') { res.write('a'); return; }
      let sent = 0;
      const tick = setInterval(() => {
        sent += 1;
        res.write('x'.repeat(100));
        if (sent === 8) { clearInterval(tick); res.end(); }
      }, 60);
    });
    const at = (path: string) => `http://site.test:${String(port)}${path}`;
    const options = asSite({ timeoutMs: 5_000, idleTimeoutMs: 300 });
    const steady = await publicFetch(at('/steady'), options);
    expect(steady.body.length).toBe(800);
    for (const path of ['/stall', '/silent']) {
      const stalled = await failure(publicFetch(at(path), options));
      expect(stalled.code, path).toBe('timeout');
      expect(stalled.message, path).toBe(`site.test:${String(port)} sent nothing for 0.3 seconds.`);
    }
    // Its whole limit still holds: without an idle limit, a stall is said as before.
    expect((await failure(publicFetch(at('/stall'), asSite({ timeoutMs: 300 })))).message)
      .toBe(`site.test:${String(port)} did not finish answering in time.`);
  });

  it('refuses the same local server when nothing stands it in for a site', async () => {
    const port = await serve((_req, res) => res.end('ok'));
    const error = await failure(publicFetch(`http://site.test:${String(port)}/`, { maxBytes: 10, overflow: 'fail', timeoutMs: 2_000,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }] }));
    expect(error.code).toBe('not_public');
  });
});
