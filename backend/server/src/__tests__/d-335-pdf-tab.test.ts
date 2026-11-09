/** The owner's 3b (2026-11-07) — a tab showing a PDF can be read. Chrome shows a PDF in its own viewer,
 *  which no page read sees into: task K's runs that clicked a PDF link read nothing there, and one
 *  answered that it could not read PDFs. A read that finds nothing on a tab whose address is a PDF,
 *  and a sequence that ends on one, now keep the PDF among the owner's files and say how its text is
 *  read. Through the real DOM adapter and the real file handoff; the Bridge is a stub answering by
 *  action, and a local server stands in for the PDF's site. */

import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';

import { createBrowserFiles, type BrowserFilesCollection } from '../bridges/browser-files.js';
import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import { createBridgeDomAdapter, isPdfAddress, PDF_NOT_KEPT_NOTE, pdfKeptNote } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { createPublicFileFetch } from '../http-toolkit/http-actions.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
  attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.8', idempotency_key_seen: false, status: 'ok',
    outputs } as BridgeResult });
const PDF = Buffer.from('%PDF-1.4 The following image shows a happy looking dog lying in some grass:');

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => { s.closeAllConnections(); s.close(done); })));
});

/** The PDF's site: `/example.pdf` a PDF, `/page.pdf` an HTML page at a PDF's address, `/private.pdf` a sign-in. */
const site = async (): Promise<string> => {
  const server = http.createServer((req, res) => {
    if (req.url === '/example.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(PDF); return; }
    if (req.url === '/page.pdf') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>A page</p>'); return; }
    res.writeHead(401); res.end();
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://pdfs.test:${String((server.address() as AddressInfo).port)}`;
};

/** The owner's files, as `data.file.received` takes them. */
const ownerFiles = () => {
  const kept: Array<Parameters<BrowserFilesCollection['ingest']>[0]> = [];
  const collection: BrowserFilesCollection = {
    ingest: vi.fn(async (input) => {
      kept.push(input);
      return { record_id: `file:${createHash('sha256').update(input.source_id).digest('hex').slice(0, 32)}`,
        hot_fields: { filename: input.filename } };
    }),
    readBytes: vi.fn(async () => { throw new Error('unused'); }),
    get: vi.fn(() => null),
  };
  return { kept, files: createBrowserFiles(() => collection) };
};

/** The adapter, its Bridge answering an inspect of `url` with an empty page (Chrome's viewer), a click
 *  with that page, and a download with the PDF as the page fetched it. */
const adapterOn = (url: string, files: ReturnType<typeof ownerFiles>['files'], html = '<body></body>') => {
  const requests: DispatchRequest[] = [];
  const page = { page: '7:PDFDOC', url, title: '' };
  const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
    requests.push(request);
    if (request.action === 'inspect') return ok({ url, title: '', html, truncated: false });
    if (request.action === 'click') return ok({ clicked: 1, ...page });
    if (request.action === 'download_file') {
      return ok({ ...page, address: url, filename: 'private.pdf', mime_type: 'application/pdf', size: PDF.length,
        data: PDF.toString('base64') });
    }
    return ok({ ...page });
  });
  const adapter = createBridgeDomAdapter({
    manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
    pageReads: createPageReadStore(),
    files,
    fetchFile: createPublicFileFetch({ resolve: async () => [{ address: '127.0.0.1', family: 4 }], treatAsPublic: (a) => a === '127.0.0.1' }),
  });
  return { adapter, requests };
};
const inspect = (page: string, form: 'outline' | 'text' = 'text'): ResolvedCall => {
  const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-inspect')!;
  return { slug: 'dom-inspect', risk_tier: 'read', output: manifest.output, input: { target: '*://*/*', page, form },
    stepMeta: { recipe_id: 'read-web-text', step_id: 'read', run_id: 'run-1' } };
};

describe('the owner\'s 3b — a tab showing a PDF', () => {
  it('knows a PDF\'s address by its path', () => {
    expect(isPdfAddress('https://www.w3.org/WAI/x/alt-entry-to-an-image.pdf')).toBe(true);
    expect(isPdfAddress('https://example.com/Report.PDF?download=1')).toBe(true);
    expect(isPdfAddress('https://example.com/pdf/guide')).toBe(false);
    expect(isPdfAddress('not an address')).toBe(false);
  });

  it('a read that finds nothing on one keeps the PDF from the server and says first how to read it', async () => {
    const url = `${await site()}/example.pdf`;
    const { kept, files } = ownerFiles();
    const { adapter, requests } = adapterOn(url, files);
    const read = await adapter(inspect('7:PDFDOC')) as Record<string, unknown> & { pdf: Record<string, unknown>; text: string };
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ filename: 'example.pdf', mime_type: 'application/pdf', origin: 'http_download', bytes: PDF });
    expect(read.pdf).toMatchObject({ file_ref: expect.stringMatching(/^file:[0-9a-f]{32}$/), filename: 'example.pdf',
      mime_type: 'application/pdf', size_bytes: PDF.length });
    expect(read.text.startsWith(pdfKeptNote('example.pdf', String(read.pdf.file_ref)))).toBe(true);
    // The server fetched it: the Bridge was asked for the read alone.
    expect(requests.map((r) => r.action)).toEqual(['inspect']);
  });

  it('a PDF behind a sign-in is fetched as the page would fetch it, through the Bridge', async () => {
    const url = `${await site()}/private.pdf`;
    const { kept, files } = ownerFiles();
    const { adapter, requests } = adapterOn(url, files);
    const read = await adapter(inspect('7:PDFDOC', 'outline')) as Record<string, unknown> & { outline: string };
    expect(requests.map((r) => r.action)).toEqual(['inspect', 'download_file']);
    expect(requests[1]!.args).toMatchObject({ address: url });
    expect(kept[0]).toMatchObject({ origin: 'browser_download', mime_type: 'application/pdf' });
    expect(read.outline).toContain('read its text with document.read');
  });

  it('an address that is not a PDF after all, and a page that reads, are left as they are', async () => {
    const base = await site();
    const { kept, files } = ownerFiles();
    const html = adapterOn(`${base}/page.pdf`, files);
    const read = await html.adapter(inspect('7:PDFDOC')) as Record<string, unknown>;
    expect(read).not.toHaveProperty('pdf');
    expect(kept).toHaveLength(0);
    const { adapter } = adapterOn(`${base}/guide`, files);
    expect(await adapter(inspect('7:PDFDOC'))).not.toHaveProperty('pdf');
    // A PDF's address whose page the read does see into (a site's own viewer): nothing fetched.
    const shown = adapterOn(`${base}/example.pdf`, files, '<body><h1>Annual report</h1><p>Our year in numbers.</p></body>');
    expect(await shown.adapter(inspect('7:PDFDOC'))).not.toHaveProperty('pdf');
    expect(kept).toHaveLength(0);
  });

  it('a sequence that ends on one carries the kept PDF, so its text is one document.read away', async () => {
    const url = `${await site()}/example.pdf`;
    const { files } = ownerFiles();
    const { adapter } = adapterOn(url, files);
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-act')!;
    const done = await adapter({ slug: 'dom-act', risk_tier: 'write', output: manifest.output,
      input: { target: '*://*/*', page: '7:PDFDOC', steps: [{ do: 'click', selector: 'a.example' }] },
      stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id: 'run-1' } }) as Record<string, unknown> & { pdf?: Record<string, unknown> };
    expect(done.pdf).toMatchObject({ filename: 'example.pdf', note: expect.stringContaining('document.read') });
  });

  it('says how to save it when it cannot be kept', () => {
    expect(PDF_NOT_KEPT_NOTE).toContain('Download a file from a web address');
  });
});
