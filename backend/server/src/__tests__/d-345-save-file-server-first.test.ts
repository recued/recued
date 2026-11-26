/** D-345 slice E — Save a file from a web page, server first. The owner: "go ahead with Save a file
 *  from a web page server first". A file a step saves whose address is known (given, or its link's in
 *  the page's kept read) is fetched by the server: no Bridge command and no tab, up to 25 MB. What the
 *  server cannot fetch (not public, an answer that is no success, a page where a file was linked, most
 *  often a sign-in) the Bridge fetches as the page would, as before.
 *
 *  Through the real DOM adapter, the real file handoff and the real file fetch (`createPublicFileFetch`)
 *  with a local server standing in for the site; the Bridge is a stub answering by action. */

import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';

import { createBrowserFiles, type BrowserFilesCollection } from '../bridges/browser-files.js';
import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore, outlinePage } from '../bridges/page-outline.js';
import { createPublicFileFetch } from '../http-toolkit/http-actions.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
  attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.8', idempotency_key_seen: false, status: 'ok',
    outputs } as BridgeResult });
const REPORT = Buffer.from('%PDF-1.4 The annual report.');
const ACCOUNT_PDF = Buffer.from('%PDF-1.4 Your statement, from the page signed in.');

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => { s.closeAllConnections(); s.close(done); })));
});

/** The site: `/report.pdf` public, `/statement.pdf` a sign-in page to a stranger, `/private.pdf` 401. */
const site = async (): Promise<string> => {
  const server = http.createServer((req, res) => {
    if (req.url === '/report.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Annual report.pdf"' });
      res.end(REPORT);
      return;
    }
    if (req.url === '/statement.pdf') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<form>Sign in</form>'); return; }
    res.writeHead(401); res.end();
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://files.test:${String((server.address() as AddressInfo).port)}`;
};
const fetchFile = createPublicFileFetch({ resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  treatAsPublic: (address) => address === '127.0.0.1' });

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

/** The adapter; its Bridge reads a page linking to `links` (shown as `labels` names them, else by
 *  ref) and fetches any file as the page would. */
const adapterFor = (base: string, links: Record<string, string> = {}, labels: Record<string, string> = {},
  fetch: typeof fetchFile = fetchFile, download?: (request: DispatchRequest) => DispatchOutcome | undefined) => {
  const requests: DispatchRequest[] = [];
  const page = { page: '7:DOC', url: `${base}/files`, title: 'Files' };
  const html = `<body>${Object.entries(links).map(([ref, href]) => `<a ref="${ref}" href="${href}">${labels[ref] ?? ref}</a>`).join('')}</body>`;
  const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
    requests.push(request);
    if (request.action === 'inspect') return ok({ url: page.url, title: page.title, html, truncated: false });
    if (request.action === 'download_file') {
      const answered = download?.(request);
      if (answered !== undefined) return answered;
      return ok({ ...page, address: String(request.args.address ?? `${base}/statement.pdf`), filename: 'statement.pdf',
        mime_type: 'application/pdf', size: ACCOUNT_PDF.length, data: ACCOUNT_PDF.toString('base64') });
    }
    return ok({ ...page });
  });
  const owner = ownerFiles();
  const adapter = createBridgeDomAdapter({
    manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
    pageReads: createPageReadStore(),
    files: owner.files,
    fetchFile: fetch,
  });
  return { adapter, requests, kept: owner.kept };
};
const call = (slug: string, input: Record<string, unknown>): ResolvedCall => {
  const manifest = KERNEL_MANIFESTS.find((m) => m.slug === slug)!;
  return { slug, risk_tier: manifest.risk_tier ?? 'read', output: manifest.output, input: { target: '*://*/*', ...input },
    stepMeta: { recipe_id: 'save-web-file', step_id: 'saved', run_id: 'run-1' } };
};
const actions = (requests: DispatchRequest[]) => requests.map((r) => r.action);

describe('D-345 slice E — the server\'s fetch of a file', () => {
  it('a file; a page where a file was linked; nothing it could fetch', async () => {
    const base = await site();
    expect(await fetchFile(`${base}/report.pdf`)).toMatchObject({ kind: 'file', filename: 'Annual report.pdf',
      mime_type: 'application/pdf', bytes: REPORT });
    expect(await fetchFile(`${base}/statement.pdf`)).toMatchObject({ kind: 'page' });
    expect(await fetchFile(`${base}/private.pdf`)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('401') });
    expect((await createPublicFileFetch()('http://192.168.1.10/report.pdf')).kind).toBe('refused');
  });

  it('a link\'s address is kept with its ref, made whole against the page', () => {
    const outline = outlinePage('<body><a ref="e1" href="/report.pdf">Report</a><a ref="e2" href="mailto:a@b.c">Mail</a>'
      + '<a ref="e3" href="https://x.test/very/long/addr…">Cut</a></body>', { url: 'https://files.test/files' });
    expect(outline.controls.find((c) => c.ref === 'e1')?.href).toBe('https://files.test/report.pdf');
    expect(outline.controls.find((c) => c.ref === 'e2')).not.toHaveProperty('href');
    expect(outline.controls.find((c) => c.ref === 'e3')).not.toHaveProperty('href');
  });
});

describe('D-345 slice E — Save a file from a web page (`core.dom.download`), server first', () => {
  it('a public file by its address: fetched by the server, no Bridge command, kept as downloaded', async () => {
    const base = await site();
    const { adapter, requests, kept } = adapterFor(base);
    const saved = await adapter(call('dom-download', { page: '7:DOC', address: `${base}/report.pdf` }));
    expect(actions(requests)).toEqual([]);
    expect(kept[0]).toMatchObject({ origin: 'http_download', filename: 'Annual report.pdf', bytes: REPORT });
    expect(saved).toMatchObject({ page: '7:DOC', address: `${base}/report.pdf`, filename: 'Annual report.pdf',
      mime_type: 'application/pdf', size_bytes: REPORT.length, file_ref: expect.stringMatching(/^file:/) });
    expect(saved).not.toHaveProperty('data');
  });

  it('a public file by its link\'s ref: the address from the page as it was read', async () => {
    const base = await site();
    const { adapter, requests, kept } = adapterFor(base, { e4: '/report.pdf' });
    await adapter(call('dom-inspect', { page: '7:DOC', form: 'outline' }));
    await adapter(call('dom-download', { page: '7:DOC', ref: 'e4' }));
    expect(actions(requests)).toEqual(['inspect']);
    expect(kept[0]).toMatchObject({ origin: 'http_download', filename: 'Annual report.pdf' });
  });

  it('a file behind a sign-in (a page, or 401), and a ref the server knows no address for: the Bridge fetches it', async () => {
    const base = await site();
    for (const address of [`${base}/statement.pdf`, `${base}/private.pdf`]) {
      const { adapter, requests, kept } = adapterFor(base);
      await adapter(call('dom-download', { page: '7:DOC', address }));
      expect(actions(requests), address).toEqual(['download_file']);
      expect(kept[0], address).toMatchObject({ origin: 'browser_download', bytes: ACCOUNT_PDF });
    }
    const { adapter, requests } = adapterFor(base);
    await adapter(call('dom-download', { page: '7:DOC', ref: 'e9' }));
    expect(actions(requests)).toEqual(['download_file']);
  });
});

describe('D-345 slice E — a sequence\'s download step, server first', () => {
  const act = (input: Record<string, unknown>): ResolvedCall => call('dom-act', input);

  it('a step by a public file\'s address is fetched by the server; its tab carries the file', async () => {
    const base = await site();
    const { adapter, requests } = adapterFor(base);
    const done = await adapter(act({ page: '7:DOC', steps: [{ do: 'download', address: `${base}/report.pdf` }] })) as {
      tabs: Array<{ files: Array<Record<string, unknown>>; steps: string[] }> };
    expect(actions(requests)).not.toContain('download_file');
    expect(done.tabs[0]!.files[0]).toMatchObject({ filename: 'Annual report.pdf', mime_type: 'application/pdf' });
    expect(done.tabs[0]!.steps.join(' ')).toContain('among your files as Annual report.pdf');
  });

  it('a step by its link\'s text (D-402 §4 rule 3, as a recipe made from a job names it): found on the page, '
    + 'and the address it leads to fetched by the server; one it cannot fetch, by the Bridge from the link found', async () => {
    const base = await site();
    const labels = { e4: 'Annual report', e5: 'Your statement' };
    const { adapter, requests } = adapterFor(base, { e4: '/report.pdf', e5: '/statement.pdf' }, labels);
    const done = await adapter(act({ page: '7:DOC', steps: [{ do: 'download', text: 'Annual report' }] })) as {
      tabs: Array<{ files: Array<Record<string, unknown>> }> };
    expect(actions(requests)).toEqual(['inspect']);
    expect(done.tabs[0]!.files[0]).toMatchObject({ filename: 'Annual report.pdf', mime_type: 'application/pdf' });
    const signedIn = adapterFor(base, { e4: '/report.pdf', e5: '/statement.pdf' }, labels);
    await signedIn.adapter(act({ page: '7:DOC', steps: [{ do: 'download', text: 'Your statement' }] }));
    expect(actions(signedIn.requests)).toEqual(['inspect', 'download_file']);
    expect(signedIn.requests[1]!.args).toMatchObject({ ref: 'e5' });
  });

  it('downloads by address alone need no tab; one the server cannot fetch says to name a tab', async () => {
    const base = await site();
    const { adapter, requests } = adapterFor(base);
    const done = await adapter(act({ steps: [{ do: 'download', address: `${base}/report.pdf` }] })) as {
      files: Array<Record<string, unknown>>; steps: string[]; done: number };
    expect(actions(requests)).toEqual([]);
    expect(done).toMatchObject({ done: 1, files: [{ filename: 'Annual report.pdf' }] });
    await expect(adapter(act({ steps: [{ do: 'download', address: `${base}/private.pdf` }] })))
      .rejects.toThrow(/could not fetch .*private\.pdf itself \(.*private\.pdf answered 401\): pass the page handle/);
  });
});

// 2026-11-23 (task L; the owner: "go ahead with L download fix too") — a file the server could not fetch itself, which the
// Bridge cannot hand over either: the step says both. The server's reason was dropped, so a fetch that timed out under a
// loaded machine read as the Bridge's 2.5 MB limit alone.
describe('D-345 slice E — a file neither the server nor the Bridge could save says why, both', () => {
  const TIMED_OUT = 'files.test did not finish answering in time.';
  const TOO_LARGE = 'The file is 12.5 MB, and the Browser Bridge hands over files of at most 2.5 MB.';
  const stalled: typeof fetchFile = async (address) => (address.endsWith('/big.zip')
    ? { kind: 'refused', reason: TIMED_OUT } : fetchFile(address));
  const refusesSize = (_request: DispatchRequest): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
    attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.14', idempotency_key_seen: false, status: 'error',
      error: { code: 'unknown', message: TOO_LARGE } } as unknown as BridgeResult });
  const BOTH = `The server could not download it itself (files.test did not finish answering in time), so the Browser Bridge was asked: `;

  it('Save a file from a web page', async () => {
    const base = await site();
    const { adapter, requests } = adapterFor(base, {}, {}, stalled, refusesSize);
    const error = await adapter(call('dom-download', { page: '7:DOC', address: `${base}/big.zip` })).then(() => undefined, (e: unknown) => e);
    expect(actions(requests)).toEqual(['download_file']);
    expect(String((error as Error).message)).toContain(BOTH);
    expect(String((error as Error).message)).toContain(TOO_LARGE);
  });

  it('a sequence\'s download step', async () => {
    const base = await site();
    const { adapter } = adapterFor(base, {}, {}, stalled, refusesSize);
    const error = await adapter(call('dom-act', { page: '7:DOC', steps: [{ do: 'download', address: `${base}/big.zip` }] }))
      .then(() => undefined, (e: unknown) => e);
    expect(String((error as Error).message)).toContain(`Stopped at step 1 of 1: ${BOTH}`);
    expect(String((error as Error).message)).toContain(TOO_LARGE);
  });
});
