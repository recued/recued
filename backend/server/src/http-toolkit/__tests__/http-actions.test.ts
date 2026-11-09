/** D-345 slice B — Get, Read and Download a web address: what each answers, and what each refuses.
 *
 *  A local server stands in for a site through the fetch's resolver; the download is kept by the
 *  real handoff over a stand-in for the owner's files that records what it was given. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createBrowserFiles, type BrowserFilesCollection } from '../../bridges/browser-files.js';
import { filenameFor, httpDownload, httpGet, httpRead, HttpActionError, READ_PART_CHARS } from '../http-actions.js';
import { readableText } from '../readable-text.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => { s.closeAllConnections(); s.close(done); })));
});

const PAGES: Record<string, { type: string; body: string | Buffer; status?: number; headers?: Record<string, string> }> = {
  '/api': { type: 'application/json', body: JSON.stringify({ plan: 'pro', seats: 3 }) },
  '/notes.txt': { type: 'text/plain; charset=utf-8', body: 'Line one\nLine two' },
  '/big.txt': { type: 'text/plain', body: 'y'.repeat(60_000) },
  '/report.pdf': { type: 'application/pdf', body: Buffer.from('%PDF-1.4 a report\n%%EOF\n'),
    headers: { 'content-disposition': 'attachment; filename="Q3 report.pdf"' } },
  '/gone': { type: 'text/html', body: '<h1>Not here</h1>', status: 404 },
  '/page': { type: 'text/html; charset=utf-8', body: `<!doctype html><html><head><title>Plans &amp; prices</title>
    <style>.x{color:red}</style><script>var secret = 1;</script></head><body><nav><a href="/">Home</a></nav>
    <main><h1>Plans</h1><p>Pick the plan that fits.  It costs <b>less</b> than you&rsquo;d think.</p>
    <ul><li>Free</li><li>Pro, <a href="/pro">see Pro</a></li></ul>
    <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$5.99</td></tr></table>
    <pre>  indented
    code &lt;b&gt;</pre></main><footer>Fine print</footer></body></html>` },
  // About 60,000 characters of text: two parts.
  '/long': { type: 'text/html', body: `<main><p>${'word '.repeat(12_000)}</p></main>` },
};

/** The stand-in site, and options under which `site.test` is it. */
const site = async () => {
  const server = http.createServer((req, res) => {
    const page = PAGES[req.url ?? ''];
    if (!page) { res.writeHead(404); res.end(); return; }
    res.writeHead(page.status ?? 200, { 'content-type': page.type, ...page.headers });
    res.end(page.body);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://site.test:${String((server.address() as AddressInfo).port)}`;
  const fetchOptions = { resolve: async () => [{ address: '127.0.0.1', family: 4 as const }],
    treatAsPublic: (address: string) => address === '127.0.0.1' };
  return { base, deps: { fetchOptions } };
};

const refusal = async (promise: Promise<unknown>): Promise<HttpActionError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpActionError) return error;
    throw error;
  }
  throw new Error('the action answered');
};

describe('D-345 slice B — Get a web address', () => {
  it('answers JSON parsed, text as text, and a file by what it is', async () => {
    const { base, deps } = await site();
    expect(await httpGet(deps, { address: `${base}/api` })).toMatchObject({ status: 200, type: 'application/json',
      json: { plan: 'pro', seats: 3 }, url: `${base}/api` });
    expect(await httpGet(deps, { address: `${base}/notes.txt` })).toMatchObject({ type: 'text/plain', text: 'Line one\nLine two' });
    const pdf = await httpGet(deps, { address: `${base}/report.pdf` }) as { note?: string };
    expect(pdf).not.toHaveProperty('text');
    expect(pdf.note).toContain('Download a file from a web address');
  });

  it('cuts a long text and says where to read on, and answers headers alone when asked', async () => {
    const { base, deps } = await site();
    const big = await httpGet(deps, { address: `${base}/big.txt` });
    expect(big).toMatchObject({ truncated: true });
    expect((big as { text: string }).text.length).toBe(40_000);
    const head = await httpGet(deps, { address: `${base}/report.pdf`, headers_only: true });
    expect(head).toMatchObject({ status: 200, type: 'application/pdf' });
    expect(head).not.toHaveProperty('note');
    expect(head.headers['content-disposition']).toContain('Q3 report.pdf');
  });

  it('refuses an address that is not public, saying the browser reads the owner\'s own pages', async () => {
    const error = await refusal(httpGet({}, { address: 'http://192.168.1.1/admin' }));
    expect(error.code).toBe('NOT_PUBLIC');
    expect(error.message).toContain('Browser Toolkit');
    expect((await refusal(httpGet({}, {}))).code).toBe('BAD_INPUT');
  });
});

describe('D-345 slice B — Read a web address', () => {
  it('answers the page as readable text: its main part, headings, lists, rows, links made whole', async () => {
    const { base, deps } = await site();
    const read = await httpRead(deps, { address: `${base}/page` });
    expect(read).toMatchObject({ status: 200, title: 'Plans & prices', from: 0, next: null });
    const text = (read as { text: string }).text;
    expect(text).toContain('# Plans');
    expect(text).toContain('Pick the plan that fits. It costs less than you’d think.');
    expect(text).toContain('- Free');
    expect(text).toContain(`- Pro, [see Pro](${base}/pro)`);
    expect(text).toContain('Plan | Price');
    expect(text).toContain('Pro | $5.99');
    expect(text).toContain('  indented');
    expect(text).toContain('code <b>');
    for (const left of ['secret', 'color:red', 'Home', 'Fine print']) expect(text, left).not.toContain(left);
  });

  it('reads a long page a part at a time, and refuses a file that is not a page', async () => {
    const { base, deps } = await site();
    const first = await httpRead(deps, { address: `${base}/long` }) as { text: string; next: number | null; of: number };
    expect(first.text.length).toBe(READ_PART_CHARS);
    expect(first.next).toBe(READ_PART_CHARS);
    const second = await httpRead(deps, { address: `${base}/long`, from: first.next }) as { from: number; next: number | null };
    expect(second).toMatchObject({ from: READ_PART_CHARS, next: null });
    expect((await refusal(httpRead(deps, { address: `${base}/long`, from: first.of + 1 }))).code).toBe('BAD_INPUT');
    const pdf = await refusal(httpRead(deps, { address: `${base}/report.pdf` }));
    expect(pdf.code).toBe('NOT_TEXT');
    expect(pdf.message).toContain('Download a file from a web address');
  });
});

describe('D-345 slice B — Download a file from a web address', () => {
  /** The owner's files: a stand-in that keeps what it is given. */
  const ownerFiles = () => {
    const ingested: Array<Parameters<BrowserFilesCollection['ingest']>[0]> = [];
    const collection: BrowserFilesCollection = {
      ingest: async (input) => { ingested.push(input); return { record_id: 'file:0123456789abcdef0123456789abcdef', hot_fields: { filename: input.filename } }; },
      readBytes: async () => { throw new Error('unused'); },
      get: () => null,
    };
    return { ingested, files: createBrowserFiles(() => collection) };
  };

  it('keeps the file among the owner\'s files, named as its site sends it, and answers its ref', async () => {
    const { base, deps } = await site();
    const owner = ownerFiles();
    const kept = await httpDownload({ ...deps, files: owner.files }, { address: `${base}/report.pdf` }, { run_id: 'r1', step_id: 'downloaded' });
    expect(kept).toMatchObject({ file_ref: 'file:0123456789abcdef0123456789abcdef', filename: 'Q3 report.pdf',
      mime_type: 'application/pdf', size_bytes: 24, url: `${base}/report.pdf` });
    expect(kept).not.toHaveProperty('bytes');
    expect(owner.ingested).toHaveLength(1);
    expect(owner.ingested[0]).toMatchObject({ origin: 'http_download', filename: 'Q3 report.pdf' });
    expect(owner.ingested[0]!.source_id).toMatch(/^r1:downloaded:[0-9a-f]{64}$/);
  });

  it('keeps nothing from an answer that is not a success', async () => {
    const { base, deps } = await site();
    const owner = ownerFiles();
    const error = await refusal(httpDownload({ ...deps, files: owner.files }, { address: `${base}/gone` }));
    expect(error.code).toBe('FETCH_FAILED');
    expect(error.message).toContain('404');
    expect(owner.ingested).toHaveLength(0);
  });

  it('names a file by its address when its site gives no name', () => {
    expect(filenameFor({ url: 'https://example.com/files/annual%20plan.xlsx?x=1', headers: {} })).toBe('annual plan.xlsx');
    expect(filenameFor({ url: 'https://example.com/', headers: {} })).toBe('download');
    expect(filenameFor({ url: 'https://example.com/a', headers: { 'content-disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf" } }))
      .toBe('résumé.pdf');
    expect(filenameFor({ url: 'https://example.com/a', headers: { 'content-disposition': 'attachment; filename="../../etc/passwd"' } }))
      .toBe('.._.._etc_passwd');
  });
});

describe('D-345 slice B — a page as readable text', () => {
  it('reads its one article when it has no main, and leaves out forms\' buttons and lists of options', () => {
    const { title, text } = readableText('<title>T</title><body><header>Site</header><article><h2>Story</h2><p>Body text.</p>'
      + '<button>Share</button><select><option>A</option></select></article></body>', 'https://example.com/');
    expect(title).toBe('T');
    expect(text).toBe('## Story\n\nBody text.');
  });
});
