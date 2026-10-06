/** The public release proof (scripts/release-public-proof.mjs): after the purge,
 *  every consumer-facing URL is fetched through the public domain the way
 *  consumers fetch it, and compared with the candidate bytes. The publisher's
 *  wiring is driven end to end in d-178-release-publish-signing-gate.test.ts;
 *  this file pins the pieces, including one run of the REAL curl, because a fake
 *  proves the call and not what curl does with those flags. */

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  curlFetchExact,
  curlHeadExact,
  etagMd5,
  md5OfFile,
  provePublicRelease,
  publicProofSettings,
  publicProofTargets,
  sha256OfFile,
  type PublicProofExpectation,
  type PublicProofFetch,
  type PublicProofHead,
} from '../../scripts/release-public-proof.mjs';

const ORIGIN = 'https://releases.recued.com';
const SERVER_UA = 'recued/26.9.29 (linux-x64; binary)';
const installerUa = (channel: string) => `recued-install/1 (linux-x64; ${channel})`;
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const md5 = (bytes: string | Buffer) => createHash('md5').update(bytes).digest('hex');

let scratch: string;
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'public-proof-')); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

describe('publicProofTargets', () => {
  const targets = publicProofTargets({
    origin: ORIGIN,
    manifestPaths: [
      { channel: 'stable', keyPrefix: 'stable/' },
      { channel: 'edge', keyPrefix: 'edge/' },
      { channel: null, keyPrefix: '' },
    ],
    artifacts: [{ basename: 'recued-linux-x64', url: `${ORIGIN}/artifacts/7/recued-linux-x64` }],
    serverUserAgent: SERVER_UA,
    installerUserAgent: installerUa,
  });
  const asked = (url: string) => targets.filter((target) => target.url === url);

  it('asks for a channel manifest pair plainly, as a server, and as that channel\'s installer', () => {
    for (const channel of ['stable', 'edge']) {
      for (const file of ['manifest.json', 'manifest.json.minisig']) {
        expect(asked(`${ORIGIN}/${channel}/${file}`).map((target) => target.headers)).toEqual([
          [],
          [`User-Agent: ${SERVER_UA}`],
          [`User-Agent: ${installerUa(channel)}`],
        ]);
      }
    }
  });

  it('asks for the flat legacy pair only plainly and as a server — no installer reads it', () => {
    for (const file of ['manifest.json', 'manifest.json.minisig']) {
      expect(asked(`${ORIGIN}/${file}`).map((target) => target.headers))
        .toEqual([[], [`User-Agent: ${SERVER_UA}`]]);
    }
  });

  it('proves each artifact and its signature by a plain HEAD, downloading only as a fallback', () => {
    for (const file of ['recued-linux-x64', 'recued-linux-x64.minisig']) {
      expect(asked(`${ORIGIN}/artifacts/7/${file}`)).toEqual([expect.objectContaining({
        file, method: 'head', headers: [], timeoutSeconds: 20, fallbackTimeoutSeconds: 600,
      })]);
    }
  });

  it('downloads every manifest request in full: the only objects a stale cache can serve', () => {
    expect(targets.filter((target) => target.url.endsWith('.json') || target.url.endsWith('.json.minisig'))
      .every((target) => target.method === 'get')).toBe(true);
  });

  it('uses the exact URL — no cache-busting query — and nothing else', () => {
    expect(targets).toHaveLength(2 * 2 * 3 + 2 * 2 + 2);
    expect(targets.filter((target) => new URL(target.url).search !== '')).toEqual([]);
  });
});

describe('provePublicRelease', () => {
  /** One candidate file per name, and a target expecting exactly its bytes. */
  const expectations = (dir: string, files: Record<string, string>): PublicProofExpectation[] =>
    Object.entries(files).map(([file, body]) => {
      writeFileSync(join(dir, file), body);
      return {
        label: file,
        url: `${ORIGIN}/${file}`,
        file,
        method: 'get',
        headers: [],
        timeoutSeconds: 20,
        expectedSize: Buffer.byteLength(body),
        expectedSha256: sha256(body),
      };
    });
  /** Serves `respond(url, attempt)`: a body (HTTP 200), or a full result. */
  const fakeFetch = (
    respond: (url: string, call: number) => string | { status: number; httpCode: string; detail?: string; body?: string },
  ): { fetch: PublicProofFetch; calls: string[] } => {
    const calls: string[] = [];
    const fetch: PublicProofFetch = ({ url, destination }) => {
      calls.push(url);
      const answer = respond(url, calls.filter((called) => called === url).length);
      if (typeof answer === 'string') {
        writeFileSync(destination, answer);
        return { status: 0, httpCode: '200', detail: '' };
      }
      if (answer.body !== undefined) writeFileSync(destination, answer.body);
      return { status: answer.status, httpCode: answer.httpCode, detail: answer.detail ?? '' };
    };
    return { fetch, calls };
  };
  const fresh = (dir: string) => mkdtempSync(join(dir, 'case-'));

  it('passes when every response is its candidate, in one round', async () => {
    const dir = fresh(scratch);
    const files = { 'manifest.json': '{"sequence":7}', 'recued-linux-x64': 'binary bytes' };
    const targets = expectations(dir, files);
    const { fetch, calls } = fakeFetch((url) => files[url.slice(ORIGIN.length + 1) as keyof typeof files]);
    const sleeps: number[] = [];
    const work = mkdtempSync(join(dir, 'work-'));
    const result = await provePublicRelease({
      targets, attempts: 3, delayMs: 50, scratchDir: work, fetchExact: fetch, sleep: (ms) => sleeps.push(ms),
    });
    expect(result).toEqual({ failures: [], attemptsUsed: 1, fullDownloads: 0 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([]);
    // Nothing downloaded is kept: a release is ~800 MB.
    expect(readdirSync(work)).toEqual([]);
  });

  it('refetches only what failed, and passes once the edge converges', async () => {
    const dir = fresh(scratch);
    const files = { 'manifest.json': '{"sequence":7}', 'recued-linux-x64': 'binary bytes' };
    const targets = expectations(dir, files);
    const { fetch, calls } = fakeFetch((url, call) => (url.endsWith('recued-linux-x64') && call === 1
      ? 'binarz bytes'
      : files[url.slice(ORIGIN.length + 1) as keyof typeof files]));
    const sleeps: number[] = [];
    const result = await provePublicRelease({
      targets, attempts: 3, delayMs: 50, scratchDir: mkdtempSync(join(dir, 'work-')),
      fetchExact: fetch, sleep: (ms) => sleeps.push(ms),
    });
    expect(result).toEqual({ failures: [], attemptsUsed: 2, fullDownloads: 0 });
    expect(calls).toEqual([
      `${ORIGIN}/manifest.json`, `${ORIGIN}/recued-linux-x64`, `${ORIGIN}/recued-linux-x64`,
    ]);
    expect(sleeps).toEqual([50]);
  });

  it('names every way a response can be wrong, after the last round', async () => {
    const dir = fresh(scratch);
    const targets = expectations(dir, {
      'same-size': 'abcdef',
      'other-size': 'abcdef',
      'http-error': 'abcdef',
      'no-response': 'abcdef',
      'no-body': 'abcdef',
    });
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith('same-size')) return 'abcdeg';
      if (url.endsWith('other-size')) return 'abcdefg';
      if (url.endsWith('http-error')) return { status: 0, httpCode: '503', body: 'unavailable' };
      if (url.endsWith('no-response')) return { status: 28, httpCode: '000', detail: 'curl: (28) timed out' };
      return { status: 0, httpCode: '200' };
    });
    const sleeps: number[] = [];
    const result = await provePublicRelease({
      targets, attempts: 2, delayMs: 0, scratchDir: mkdtempSync(join(dir, 'work-')),
      fetchExact: fetch, sleep: (ms) => sleeps.push(ms),
    });
    expect(result.attemptsUsed).toBe(2);
    expect(Object.fromEntries(result.failures.map(({ target, mismatch }) => [target.label, mismatch]))).toEqual({
      'same-size': `sha256 ${sha256('abcdeg')}, expected ${sha256('abcdef')}`,
      'other-size': '7 bytes, expected 6',
      'http-error': 'HTTP 503',
      'no-response': 'fetch failed: curl: (28) timed out',
      'no-body': 'no response body was written',
    });
    // A zero delay means no pause, not a zero-length one.
    expect(sleeps).toEqual([]);
  });

  it('checks up to `concurrency` targets at once, each reported against its own target', async () => {
    const dir = fresh(scratch);
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, `body ${i}`]));
    const targets = expectations(dir, files);
    let inFlight = 0;
    let peak = 0;
    const fetch: PublicProofFetch = async ({ url, destination }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((settle) => setTimeout(settle, 20));
      inFlight -= 1;
      const name = url.slice(ORIGIN.length + 1);
      writeFileSync(destination, name === 'f3' ? 'wrong!' : files[name]);
      return { status: 0, httpCode: '200', detail: '' };
    };
    const result = await provePublicRelease({
      targets, attempts: 1, delayMs: 0, scratchDir: mkdtempSync(join(dir, 'work-')),
      fetchExact: fetch, concurrency: 3,
    });
    expect(peak).toBe(3);
    expect(result.failures.map(({ target, mismatch }) => `${target.label}: ${mismatch}`))
      .toEqual([`f3: sha256 ${sha256('wrong!')}, expected ${sha256('body 3')}`]);
  });

  describe('a HEAD target', () => {
    const headTarget = (dir: string, file: string, body: string): PublicProofExpectation => {
      writeFileSync(join(dir, file), body);
      return {
        label: file,
        url: `${ORIGIN}/${file}`,
        file,
        method: 'head',
        headers: [],
        timeoutSeconds: 20,
        fallbackTimeoutSeconds: 600,
        expectedSize: Buffer.byteLength(body),
        expectedSha256: sha256(body),
        expectedMd5: md5(body),
      };
    };
    const head = (answer: Partial<ReturnType<PublicProofHead>>): { fn: PublicProofHead; calls: string[] } => {
      const calls: string[] = [];
      return {
        calls,
        fn: ({ url }) => {
          calls.push(url);
          return { status: 0, httpCode: '200', contentLength: null, etag: null, detail: '', ...answer };
        },
      };
    };
    const noDownload: PublicProofFetch = () => { throw new Error('a proven HEAD must not download'); };

    it('is proven by its exact length and an ETag equal to its MD5, with nothing downloaded', async () => {
      const dir = fresh(scratch);
      const target = headTarget(dir, 'recued-linux-x64', 'binary bytes');
      const { fn, calls } = head({ contentLength: 12, etag: `"${md5('binary bytes')}"` });
      const result = await provePublicRelease({
        targets: [target], attempts: 1, delayMs: 0, scratchDir: mkdtempSync(join(dir, 'work-')),
        fetchExact: noDownload, headExact: fn,
      });
      expect(result).toEqual({ failures: [], attemptsUsed: 1, fullDownloads: 0 });
      expect(calls).toEqual([`${ORIGIN}/recued-linux-x64`]);
    });

    it('fails on another object\'s ETag or length, without downloading either', async () => {
      const dir = fresh(scratch);
      const etagWrong = headTarget(dir, 'etag-wrong', 'binary bytes');
      const lengthWrong = headTarget(dir, 'length-wrong', 'binary bytes');
      const fn: PublicProofHead = ({ url }) => (url.endsWith('etag-wrong')
        ? { status: 0, httpCode: '200', contentLength: 12, etag: `"${md5('binarz bytes')}"`, detail: '' }
        : { status: 0, httpCode: '200', contentLength: 13, etag: `"${md5('binary bytes')}"`, detail: '' });
      const result = await provePublicRelease({
        targets: [etagWrong, lengthWrong], attempts: 1, delayMs: 0, scratchDir: mkdtempSync(join(dir, 'work-')),
        fetchExact: noDownload, headExact: fn,
      });
      expect(Object.fromEntries(result.failures.map(({ target, mismatch }) => [target.label, mismatch]))).toEqual({
        'etag-wrong': `etag ${md5('binarz bytes')}, expected md5 ${md5('binary bytes')}`,
        'length-wrong': '13 bytes, expected 12',
      });
      expect(result.fullDownloads).toBe(0);
    });

    it.each([
      ['a multipart upload\'s ETag', { contentLength: 12, etag: '"0123456789abcdef0123456789abcdef-2"' }],
      ['a weak ETag', { contentLength: 12, etag: `W/"${md5('binary bytes')}"` }],
      ['no ETag', { contentLength: 12, etag: null }],
      ['no length', { contentLength: null, etag: `"${md5('binary bytes')}"` }],
    ])('with %s proves nothing, so that object alone is downloaded and compared', async (_, answer) => {
      const dir = fresh(scratch);
      const target = headTarget(dir, 'recued-linux-x64', 'binary bytes');
      const downloads: string[] = [];
      const fetch: PublicProofFetch = ({ url, destination, timeoutSeconds }) => {
        downloads.push(`${url} ${timeoutSeconds}`);
        writeFileSync(destination, 'binary bytes');
        return { status: 0, httpCode: '200', detail: '' };
      };
      const result = await provePublicRelease({
        targets: [target], attempts: 1, delayMs: 0, scratchDir: mkdtempSync(join(dir, 'work-')),
        fetchExact: fetch, headExact: head(answer).fn,
      });
      expect(result).toEqual({ failures: [], attemptsUsed: 1, fullDownloads: 1 });
      // Bounded like a full artifact download, not like a HEAD.
      expect(downloads).toEqual([`${ORIGIN}/recued-linux-x64 600`]);
    });

    it('reports HTTP errors and failed requests without downloading', async () => {
      const dir = fresh(scratch);
      const missing = headTarget(dir, 'missing', 'x');
      const unreachable = headTarget(dir, 'unreachable', 'x');
      const fn: PublicProofHead = ({ url }) => (url.endsWith('missing')
        ? { status: 0, httpCode: '404', contentLength: 9, etag: null, detail: '' }
        : { status: 6, httpCode: '', contentLength: null, etag: null, detail: 'curl: (6) Could not resolve host' });
      const result = await provePublicRelease({
        targets: [missing, unreachable], attempts: 1, delayMs: 0, scratchDir: mkdtempSync(join(dir, 'work-')),
        fetchExact: noDownload, headExact: fn,
      });
      expect(Object.fromEntries(result.failures.map(({ target, mismatch }) => [target.label, mismatch]))).toEqual({
        missing: 'HTTP 404',
        unreachable: 'fetch failed: curl: (6) Could not resolve host',
      });
    });
  });
});

describe('etagMd5', () => {
  it.each([
    ['"d78264788b2ab95a6e40cafad87552ee"', 'd78264788b2ab95a6e40cafad87552ee'],
    ['D78264788B2AB95A6E40CAFAD87552EE', 'd78264788b2ab95a6e40cafad87552ee'],
    ['"d78264788b2ab95a6e40cafad87552ee-3"', null],
    ['W/"d78264788b2ab95a6e40cafad87552ee"', null],
    ['"abc"', null],
    [null, null],
  ])('reads %j as %j', (etag, expected) => {
    expect(etagMd5(etag)).toBe(expected);
  });

  it('agrees with md5OfFile, which is what R2 reports for a single-part upload', () => {
    const file = join(scratch, 'md5-probe');
    writeFileSync(file, 'binary bytes');
    expect(md5OfFile(file)).toBe(md5('binary bytes'));
  });
});

describe('publicProofSettings', () => {
  it('defaults to 8 rounds 1 s apart', () => {
    expect(publicProofSettings({})).toEqual({ attempts: 8, delayMs: 1_000 });
    expect(publicProofSettings({
      RECUED_RELEASE_PUBLIC_PROOF_ATTEMPTS: '',
      RECUED_RELEASE_PUBLIC_PROOF_DELAY_MS: '',
    })).toEqual({ attempts: 8, delayMs: 1_000 });
  });

  it('takes any whole number in range', () => {
    expect(publicProofSettings({
      RECUED_RELEASE_PUBLIC_PROOF_ATTEMPTS: '30',
      RECUED_RELEASE_PUBLIC_PROOF_DELAY_MS: '0',
    })).toEqual({ attempts: 30, delayMs: 0 });
  });

  it.each([
    ['RECUED_RELEASE_PUBLIC_PROOF_ATTEMPTS', '0', /from 1 to 30/],
    ['RECUED_RELEASE_PUBLIC_PROOF_ATTEMPTS', '31', /from 1 to 30/],
    ['RECUED_RELEASE_PUBLIC_PROOF_ATTEMPTS', '-1', /from 1 to 30/],
    ['RECUED_RELEASE_PUBLIC_PROOF_ATTEMPTS', '1.5', /from 1 to 30/],
    ['RECUED_RELEASE_PUBLIC_PROOF_ATTEMPTS', 'eight', /from 1 to 30/],
    ['RECUED_RELEASE_PUBLIC_PROOF_DELAY_MS', '10001', /from 0 to 10000/],
    ['RECUED_RELEASE_PUBLIC_PROOF_DELAY_MS', '1e3', /from 0 to 10000/],
  ])('refuses %s=%j rather than defaulting it', (name, value, range) => {
    expect(() => publicProofSettings({ [name]: value })).toThrow(new RegExp(`^${name} must be a whole number`));
    expect(() => publicProofSettings({ [name]: value })).toThrow(range);
  });
});

/** ⛔ THE REAL CURL. The server runs on a worker thread because `curlFetchExact`
 *  is synchronous: on this thread, spawnSync would block the server it calls. */
describe('curlFetchExact', () => {
  const SERVER = `
    const { parentPort } = require('node:worker_threads');
    const http = require('node:http');
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, ua: req.headers['user-agent'] ?? null,
        cacheControl: req.headers['cache-control'] ?? null, pragma: req.headers['pragma'] ?? null });
      if (req.url === '/artifact') {
        res.writeHead(200, { 'content-length': '5', etag: '"4b3a6218bb3e3a7303e8a171a60fcf92"' });
        res.end('bytes');
        return;
      }
      if (req.url === '/moved') { res.writeHead(302, { location: '/artifact' }); res.end(); return; }
      if (req.url === '/large') { res.writeHead(200, { 'content-length': '64' }); res.end('x'.repeat(64)); return; }
      res.writeHead(404); res.end('missing');
    });
    server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
    parentPort.on('message', (message) => {
      if (message === 'seen') parentPort.postMessage({ seen: seen.splice(0) });
      if (message === 'close') server.close(() => parentPort.postMessage({ closed: true }));
    });
  `;
  let worker: Worker;
  let base: string;
  const next = <T>(): Promise<T> => new Promise((done) => worker.once('message', done));
  const seen = async () => {
    const reply = next<{ seen: Array<Record<string, string | null>> }>();
    worker.postMessage('seen');
    return (await reply).seen;
  };

  beforeAll(async () => {
    worker = new Worker(SERVER, { eval: true });
    base = `http://127.0.0.1:${(await next<{ port: number }>()).port}`;
  });
  afterAll(async () => {
    const closed = next();
    worker.postMessage('close');
    await closed;
    await worker.terminate();
  });

  const fetchTo = async (path: string, maxBytes: number, headers: string[] = []) => {
    const destination = join(scratch, `curl-${path.slice(1)}`);
    return {
      destination,
      result: await curlFetchExact({ url: `${base}${path}`, destination, maxBytes, timeoutSeconds: 10, headers }),
    };
  };

  it('streams the exact URL to disk with the consumer\'s User-Agent and no cache bypass', async () => {
    const { destination, result } = await fetchTo('/artifact', 5, [`User-Agent: ${installerUa('stable')}`]);
    expect(result).toMatchObject({ status: 0, httpCode: '200' });
    expect(readFileSync(destination, 'utf8')).toBe('bytes');
    expect(sha256OfFile(destination)).toBe(sha256('bytes'));
    expect(await seen()).toEqual([
      { url: '/artifact', ua: installerUa('stable'), cacheControl: null, pragma: null },
    ]);
  });

  it('reports an HTTP error by its status code', async () => {
    const { result } = await fetchTo('/nowhere', 100);
    expect(result).toMatchObject({ status: 0, httpCode: '404' });
    await seen();
  });

  it('follows a redirect, as the installers do', async () => {
    const { destination, result } = await fetchTo('/moved', 5);
    expect(result).toMatchObject({ status: 0, httpCode: '200' });
    expect(readFileSync(destination, 'utf8')).toBe('bytes');
    expect((await seen()).map((request) => request.url)).toEqual(['/moved', '/artifact']);
  });

  it('HEADs the exact URL and reads its status, length and ETag, after a redirect too', async () => {
    const direct = await curlHeadExact({ url: `${base}/artifact`, timeoutSeconds: 10, headers: [] });
    expect(direct).toMatchObject({ status: 0, httpCode: '200', contentLength: 5 });
    expect(etagMd5(direct.etag)).toBe(md5('bytes'));
    const moved = await curlHeadExact({ url: `${base}/moved`, timeoutSeconds: 10, headers: [] });
    expect(moved).toMatchObject({ status: 0, httpCode: '200', contentLength: 5 });
    expect(etagMd5(moved.etag)).toBe(md5('bytes'));
    const missing = await curlHeadExact({ url: `${base}/nowhere`, timeoutSeconds: 10, headers: [] });
    expect(missing).toMatchObject({ status: 0, httpCode: '404' });
    expect((await seen()).map((request) => request.url)).toEqual(['/artifact', '/moved', '/artifact', '/nowhere']);
  });

  it('refuses a declared body larger than the candidate before downloading it', async () => {
    const { result } = await fetchTo('/large', 5);
    expect(result.status).not.toBe(0);
    await seen();
  });
});
