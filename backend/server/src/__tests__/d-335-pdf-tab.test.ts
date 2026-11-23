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
import { IngredientError, type ResolvedCall } from '@recued/ingredients';

import { createBrowserFiles, type BrowserFilesCollection } from '../bridges/browser-files.js';
import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import { createBridgeDomAdapter, isPdfAddress, PDF_NOT_KEPT_NOTE, pdfKeptNote } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { createPublicFileFetch } from '../http-toolkit/http-actions.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { keptTabPdfs } from '../chat-tab-pdf-read.js';
import { readBrowserFailure } from '@recued/contracts';
import { withRunAbortContext } from '../execution/run-abort-context.js';
import { withPreapprovalIo, type PreapprovalIoContext } from '../preapproval-io-context.js';

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

describe('a clicked PDF handed to the existing document reader', () => {
  const parent = { page: '7:PARENT', url: 'https://example.com/guide', title: 'Guide' };
  const address = 'https://example.com/report.pdf';
  const destination = { page: '9:PDF', url: address, title: '' };
  const setup = (options: { tabs?: unknown[]; truncated?: boolean; sameTab?: boolean; clicked?: boolean; rewrite?: boolean; onList?: () => void } = {}) => {
    const { kept, files } = ownerFiles();
    const store = createPageReadStore();
    const markup = (href: string) => `<main><a ref="e14" href="${href}">Example PDF</a>`
      + '<a ref="e15" href="https://example.com/other.pdf">Other PDF</a></main>';
    store.outline(parent.page, { ...parent, html: markup(address), truncated: false, whole: true });
    const requests: DispatchRequest[] = [], fetched: string[] = [];
    const adapter = createBridgeDomAdapter({ files, pageReads: store,
      manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      fetchFile: async url => { fetched.push(url); return { kind: 'file', url, bytes: PDF, mime_type: 'application/pdf', filename: 'report.pdf' }; },
      getDispatcher: () => ({ cancel: vi.fn(), canResolve: vi.fn(() => true), dispatch: async request => {
        requests.push(request);
        if (request.action === 'click') {
          if (options.rewrite) store.outline(parent.page, { ...parent, html: markup('https://example.com/other.pdf'), truncated: false, whole: true });
          return ok({ clicked: options.clicked !== false, ...(options.sameTab ? destination : parent) });
        }
        if (request.action === 'list_tabs') {
          options.onList?.();
          return ok({ tabs: options.tabs ?? [parent, destination], truncated: options.truncated === true });
        }
        return ok({ ...parent, html: markup(address), truncated: false });
      } }),
    });
    const run = (batch = false, steps = [{ do: 'click', ref: 'e14' }]) => adapter({ slug: batch ? 'dom-act' : 'dom-click', risk_tier: 'write', output: {},
      input: { target: '*://*/*', page: parent.page, ...(batch ? { steps } : { ref: 'e14' }) },
      stepMeta: { recipe_id: batch ? 'act-on-web-page' : 'click-web-element', step_id: 'click', run_id: 'pdf-click' } });
    return { run, fetched, kept, requests };
  };

  it('keeps the confirmed new-tab PDF while preserving the original action tab and reader receipt', async () => {
    const t = setup(); const answer = await t.run() as Record<string, unknown>;
    expect(answer).toMatchObject({ ...parent, pdf: { source_page: destination.page, source_url: address, filename: 'report.pdf' } });
    expect(t.fetched).toEqual([address]); expect(t.kept).toHaveLength(1);
    expect(t.requests.map(r => r.action)).toEqual(['click', 'list_tabs', 'reread']);
    expect(keptTabPdfs({ ok: true, result: answer })).toHaveLength(1);
  });

  it('carries that PDF out of a batch too, and a same-tab PDF needs no tab inventory', async () => {
    const batch = setup();
    expect(keptTabPdfs({ ok: true, result: await batch.run(true) })).toHaveLength(1);
    expect(batch.fetched).toEqual([address]);
    const same = setup({ sameTab: true });
    expect(keptTabPdfs({ ok: true, result: await same.run() })).toHaveLength(1);
    expect(same.requests.some(r => r.action === 'list_tabs')).toBe(false);
  });

  it('preserves a kept PDF and the observed target when a later predicate fails, without replaying the click', async () => {
    const t = setup({ sameTab: true });
    const error = await t.run(true, [{ do: 'click', ref: 'e14' }, { do: 'wait', selector: '#main', seconds: 0.1 }] as any).catch(error => error);
    if (!(error instanceof IngredientError)) throw new Error('Expected a structured browser failure');
    const failure = readBrowserFailure(error)!;
    expect(failure.details.completed_files).toMatchObject([{ step: 1, filename: 'report.pdf', mime_type: 'application/pdf' }]);
    expect(failure.details.batch_progress).toMatchObject({ failed_step: 2, completed_steps: [1] });
    expect(failure.details.post_action).toMatchObject({ check_status: 'failed', target: { ref: 'e14', tag: 'a', label: 'Example PDF', href: address } });
    expect(t.kept).toHaveLength(1);
    expect(t.requests.filter(request => request.action === 'click')).toHaveLength(1);
    const result = { ok: true as const, result: { success: false, errors: [{ code: error.code,
      source: { ingredient_slug: 'dom-act' }, details: failure.details }] } };
    expect(keptTabPdfs(result)).toEqual([{ file_ref: failure.details.completed_files![0]!.file_ref, filename: 'report.pdf' }]);
    expect(keptTabPdfs({ ...result, result: { ...result.result, errors: [{ ...result.result.errors[0], details: { ...failure.details, raw_bytes: 'forged' } }] } })).toEqual([]);
  });

  it('does not fetch an absent, ambiguous, truncated or unclicked destination', async () => {
    for (const options of [{ tabs: [parent] }, { tabs: [destination, { ...destination, page: '10:OTHER' }] },
      { truncated: true }, { clicked: false }]) {
      const t = setup(options);
      expect(keptTabPdfs({ ok: true, result: await t.run() })).toEqual([]);
      expect(t.fetched).toEqual([]); expect(t.kept).toHaveLength(0);
    }
  });
  it('preserves every confirmed PDF receipt when one batch clicks several links', async () => {
    const t = setup({ tabs: [parent, destination, { ...destination, page: '10:OTHER', url: 'https://example.com/other.pdf' }] });
    const answer = await t.run(true, [{ do: 'click', ref: 'e14' }, { do: 'click', ref: 'e15' }]);
    expect(t.fetched).toEqual([address, 'https://example.com/other.pdf']);
    expect(keptTabPdfs({ ok: true, result: answer })).toHaveLength(2);
  });

  it('binds the PDF address before the click, even if the page changes its link afterward', async () => {
    const t = setup({ rewrite: true }); await t.run();
    expect(t.fetched).toEqual([address]);
  });
  it('does not fetch after cancellation arrives during destination discovery', async () => {
    const controller = new AbortController();
    const t = setup({ onList: () => controller.abort(new Error('cancelled during discovery')) });
    await expect(withRunAbortContext({ signal: controller.signal }, () => t.run())).rejects.toMatchObject({ code: 'run_killed' });
    expect(t.fetched).toEqual([]); expect(t.kept).toHaveLength(0);
    expect(t.requests.filter(r => r.action === 'click')).toHaveLength(1);
  });
  it('a reviewed click does not discover or read a document outside its prepared commands', async () => {
    const t = setup();
    const scope = { prepareDomCommand: async () => ({}) } as unknown as PreapprovalIoContext;
    const answer = await withPreapprovalIo(scope, () => t.run());
    expect(keptTabPdfs({ ok: true, result: answer })).toEqual([]);
    expect(t.requests.map(r => r.action)).toEqual(['click']);
    expect(t.fetched).toEqual([]);
  });
});

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
