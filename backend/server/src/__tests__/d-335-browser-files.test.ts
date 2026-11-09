/** D-335 slice AP — a file a page links to, kept among the owner's files. The owner: "for #4 and #5 it
 *  should be generic so a downlod file & table->csv file can be into the game later". Through the real
 *  DOM adapter and the real file handoff (`browser-files.ts`); the Bridge is a stub answering by action,
 *  and the owner's files a stand-in for `data.file.received` that records what it is given. */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_ACTIONS, BRIDGE_FILE_MAX_BYTES, bridgeRunsCommand, type BridgeResult } from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';

import { createBrowserFiles, type BrowserFilesCollection } from '../bridges/browser-files.js';
import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
  attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.8', idempotency_key_seen: false, status: 'ok',
    outputs } as BridgeResult });
const failed = (message: string): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
  result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.8', idempotency_key_seen: false, status: 'error',
    error: { code: 'unknown', message } } as BridgeResult });

const PAGE = { page: '7:DOC1', url: 'https://bank.example.com/statements', title: 'Statements' };
const PDF = Buffer.from('%PDF-1.4 A statement for October.');
const answered = (bytes: Buffer = PDF, extra: Record<string, unknown> = {}) => ok({ ...PAGE,
  address: 'https://bank.example.com/statements/october.pdf', filename: 'october.pdf', mime_type: 'application/pdf',
  size: bytes.length, data: bytes.toString('base64'), ...extra });

/** The owner's files, as `data.file.received` takes them: each file kept, by the ref it answered. */
const ownerFiles = () => {
  const kept: Array<Parameters<BrowserFilesCollection['ingest']>[0]> = [];
  const collection: BrowserFilesCollection = {
    ingest: vi.fn(async (input) => {
      kept.push(input);
      return { record_id: `file:${createHash('sha256').update(`${input.origin}:${input.source_id}`).digest('hex').slice(0, 32)}`,
        hot_fields: { filename: input.filename.replace(/[^\w. -]/g, '_') } };
    }),
    readBytes: vi.fn(async () => ({ bytes: PDF, mime_type: 'application/pdf', filename: 'october.pdf' })),
    get: vi.fn(() => ({ hot_fields: { filename: 'october.pdf', mime_type: 'application/pdf', size: PDF.length } })),
  };
  return { kept, files: createBrowserFiles(() => collection) };
};

const adapterFor = (respond: (request: DispatchRequest) => DispatchOutcome, files?: ReturnType<typeof ownerFiles>['files']) => {
  const requests: DispatchRequest[] = [];
  const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
    requests.push(request);
    return respond(request);
  });
  const adapter = createBridgeDomAdapter({
    manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
    pageReads: createPageReadStore(),
    ...(files !== undefined ? { files } : {}),
  });
  return { adapter, requests };
};
const call = (slug: string, input: Record<string, unknown>): ResolvedCall => {
  const manifest = KERNEL_MANIFESTS.find((m) => m.slug === slug)!;
  return { slug, risk_tier: manifest.risk_tier ?? 'read', output: manifest.output, input: { target: '*://*/*', ...input },
    stepMeta: { recipe_id: 'save-web-file', step_id: 'saved', run_id: 'run-1' } };
};

describe('D-335 slice AP — the handoff', () => {
  it('keeps a file among the owner\'s files as saved from a web page, by the step it came from and what it holds', async () => {
    const { kept, files } = ownerFiles();
    const saved = await files.keep({ bytes: PDF, filename: 'october/statement.pdf', mime_type: 'application/pdf',
      run_id: 'run-1', step_id: 'saved' });
    const sha256 = createHash('sha256').update(PDF).digest('hex');
    expect(kept).toEqual([{ bytes: PDF, filename: 'october/statement.pdf', mime_type: 'application/pdf', content_hash: sha256,
      origin: 'browser_download', source_id: `run-1:saved:${sha256}` }]);
    // The name as the owner's files keep it.
    expect(saved).toEqual({ file_ref: expect.stringMatching(/^file:[0-9a-f]{32}$/), filename: 'october_statement.pdf',
      mime_type: 'application/pdf', size_bytes: PDF.length, sha256 });
  });
});

describe('D-335 slice AP — Save a file from a web page (`core.dom.download`)', () => {
  it('asks the Bridge for the link\'s file, keeps it, and answers its ref and what it is, never its bytes', async () => {
    const { kept, files } = ownerFiles();
    const { adapter, requests } = adapterFor(() => answered(), files);
    const out = await adapter(call('dom-download', { page: PAGE.page, ref: 'e12' })) as Record<string, unknown>;
    expect(requests.map((r) => [r.action, r.args])).toEqual([['download_file', { page: PAGE.page, ref: 'e12',
      max_bytes: BRIDGE_FILE_MAX_BYTES }]]);
    expect(kept.map((file) => file.bytes.toString())).toEqual([PDF.toString()]);
    expect(out).toEqual({ ...PAGE, address: 'https://bank.example.com/statements/october.pdf',
      file_ref: expect.stringMatching(/^file:[0-9a-f]{32}$/), record_id: out.file_ref, filename: 'october.pdf',
      mime_type: 'application/pdf', size_bytes: PDF.length, sha256: createHash('sha256').update(PDF).digest('hex') });
    expect(JSON.stringify(out)).not.toContain(PDF.toString('base64'));
  });

  it('takes the file\'s own address in place of a link, and refuses both, neither, or no page', async () => {
    const { files } = ownerFiles();
    const { adapter, requests } = adapterFor(() => answered(), files);
    await adapter(call('dom-download', { page: PAGE.page, address: 'https://bank.example.com/statements/october.pdf' }));
    expect(requests[0]!.args).toEqual({ page: PAGE.page, address: 'https://bank.example.com/statements/october.pdf',
      max_bytes: BRIDGE_FILE_MAX_BYTES });
    await expect(adapter(call('dom-download', { page: PAGE.page, ref: 'e12', address: 'https://bank.example.com/a.pdf' })))
      .rejects.toThrow(/name the link by ref or by selector, or give the file's address, one of them/);
    await expect(adapter(call('dom-download', { page: PAGE.page }))).rejects.toThrow(/one of them/);
    await expect(adapter(call('dom-download', { ref: 'e12' }))).rejects.toThrow(/pass the page handle/);
  });

  it('a file too large for the Bridge fails with its words; an answer that is not a file, or past the cap, fails', async () => {
    const { kept, files } = ownerFiles();
    const tooLarge = adapterFor(() => failed('The file is 7.2 MB, and the Browser Bridge hands over files of at most 2.5 MB.'), files);
    await expect(tooLarge.adapter(call('dom-download', { page: PAGE.page, ref: 'e12' }))).rejects.toThrow(/7\.2 MB.*at most 2\.5 MB/);
    const garbled = adapterFor(() => answered(PDF, { data: 'not base64!' }), files);
    await expect(garbled.adapter(call('dom-download', { page: PAGE.page, ref: 'e12' }))).rejects.toThrow(/no file that could be read/);
    const big = Buffer.alloc(BRIDGE_FILE_MAX_BYTES + 3);
    const past = adapterFor(() => answered(big), files);
    await expect(past.adapter(call('dom-download', { page: PAGE.page, ref: 'e12' }))).rejects.toThrow(/no file that could be read|incomplete/);
    const short = adapterFor(() => answered(PDF, { size: PDF.length + 10 }), files);
    await expect(short.adapter(call('dom-download', { page: PAGE.page, ref: 'e12' }))).rejects.toThrow(/came incomplete/);
    expect(kept).toEqual([]);
  });

  it('a server that keeps no files from the browser says so', async () => {
    const { adapter } = adapterFor(() => answered());
    await expect(adapter(call('dom-download', { page: PAGE.page, ref: 'e12' }))).rejects.toThrow(/keeps no files from the browser/);
  });

  it('a Bridge that does not run it is told to update before anything is sent', () => {
    expect(bridgeRunsCommand({ supported_actions: [...BRIDGE_ACTIONS] }, 'download_file', {})).toBe(true);
    expect(bridgeRunsCommand({ supported_actions: BRIDGE_ACTIONS.filter((action) => action !== 'download_file') },
      'download_file', {})).toBe(false);
  });
});

describe('D-335 slice AP — a download step in Act on web pages', () => {
  it('keeps the file and lists it under its tab, by its ref, beside the step that saved it', async () => {
    const { kept, files } = ownerFiles();
    const { adapter, requests } = adapterFor((request) => (request.action === 'download_file' ? answered()
      : ok({ ...PAGE, html: '<main><a href="/statements/october.pdf">October</a></main>', truncated: false })), files);
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-act')!;
    const out = await adapter({ slug: 'dom-act', risk_tier: 'write', output: manifest.output,
      input: { target: '*://*/*', page: PAGE.page, steps: [{ do: 'download', ref: 'e12' }] },
      stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id: 'run-1' } }) as Record<string, unknown>;
    expect(requests.filter((r) => r.action === 'download_file').map((r) => r.args)).toEqual([{ page: PAGE.page, ref: 'e12',
      max_bytes: BRIDGE_FILE_MAX_BYTES }]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.source_id).toMatch(/^run-1:act#download1:[0-9a-f]{64}$/);
    const tab = (out.tabs as Array<Record<string, unknown>>)[0]!;
    expect(tab.files).toEqual([{ step: 1, file_ref: expect.stringMatching(/^file:[0-9a-f]{32}$/), filename: 'october.pdf',
      mime_type: 'application/pdf', size_bytes: PDF.length }]);
    expect(tab.steps).toEqual([expect.stringMatching(/^1\. on .+: saved the file e12 links to among your files as october\.pdf$/)]);
  });
});

// D-335 slice AQ — one of the owner's files into a page's file field, by its ref.
describe('D-335 slice AQ — an upload step in Act on web pages', () => {
  const act = (steps: unknown[]): ResolvedCall => {
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-act')!;
    return { slug: 'dom-act', risk_tier: 'write', output: manifest.output, input: { target: '*://*/*', page: PAGE.page, steps },
      stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id: 'run-1' } };
  };
  const REF = `file:${'b'.repeat(32)}`;

  it('reads the owner\'s file by its ref and hands the field its bytes, the step naming the file', async () => {
    const { files } = ownerFiles();
    const { adapter, requests } = adapterFor((request) => (request.action === 'upload_file'
      ? ok({ attached: 'october.pdf', ...PAGE }) : ok({ ...PAGE, html: '<main></main>', truncated: false })), files);
    const out = await adapter(act([{ do: 'upload', ref: 'e7', file: REF }])) as Record<string, unknown>;
    const sent = requests.find((r) => r.action === 'upload_file')!;
    expect(sent.args).toEqual({ page: PAGE.page, ref: 'e7', file: REF, filename: 'october.pdf', mime_type: 'application/pdf',
      data: PDF.toString('base64') });
    // The bytes ride in the command alone: the answer the model and the run's history get holds none.
    expect(JSON.stringify(out)).not.toContain(PDF.toString('base64'));
    expect(out.steps).toEqual(['put your file october.pdf into e7']);
  });

  it('a file over the cap stops the step before anything is sent; a ref to no file of the owner\'s says so', async () => {
    const big = Buffer.alloc(BRIDGE_FILE_MAX_BYTES + 1);
    const tooBig = createBrowserFiles(() => ({ ingest: vi.fn(), get: () => null,
      readBytes: async () => ({ bytes: big, mime_type: 'application/pdf', filename: 'big.pdf' }) }) as unknown as BrowserFilesCollection);
    const large = adapterFor(() => ok({ ...PAGE }), tooBig);
    await expect(large.adapter(act([{ do: 'upload', ref: 'e7', file: REF }]))).rejects.toThrow(/the file is 2\.5 MB, and the Browser Bridge hands a page files of at most 2\.5 MB/);
    expect(large.requests.map((r) => r.action)).not.toContain('upload_file');
    const none = createBrowserFiles(() => ({ ingest: vi.fn(), get: () => null,
      readBytes: async () => { throw new Error('No such file'); } }) as unknown as BrowserFilesCollection);
    const missing = adapterFor(() => ok({ ...PAGE }), none);
    await expect(missing.adapter(act([{ do: 'upload', ref: 'e7', file: REF }]))).rejects.toThrow(/is none of the user's files that can be read: No such file/);
    const nowhere = adapterFor(() => ok({ ...PAGE }));
    await expect(nowhere.adapter(act([{ do: 'upload', ref: 'e7', file: REF }]))).rejects.toThrow(/hands no files to the browser/);
  });
});

