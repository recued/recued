/** D-335 slice AP — a file a page links to, fetched as the page fetches it, as the executor runs it.
 *
 *  What `pageFileAddress` finds on a real page is pinned in real Chrome (`browser-toolkit-browser.test.ts`).
 *  These pin `fetchFile` (the name and type its site gives a file, base64, and the cap, before more than it
 *  is read) and the executor's side: the page's own fetch first, the Bridge's for a file on another site
 *  the page may not fetch from, and a file on a site the owner listed refused. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_DOWNLOAD_OUTPUT_KEYS, BRIDGE_FILE_MAX_BYTES, BRIDGE_UPLOAD_OUTPUT_KEYS, type BridgeAction, type BridgeCommand }
  from '@recued/contracts';

import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { describePageElement } from '../actions/page-inspect.js';
import { rebindPageRef } from '../actions/page-rebind.js';
import { attachPageFile, fetchFile, fileTooLarge, pageFileAddress, type AttachedFile, type FetchedFile, type PageFileAddress }
  from '../actions/page-files.js';

afterEach(() => vi.unstubAllGlobals());

const SITE = '*://*/*';
const command = (args: Record<string, unknown>): BridgeCommand => ({
  command_id: 'cmd-1', recipe_run_id: 'run-1', step_id: 'step-1',
  ingredient: { publisher_id: 'recued', slug: 'dom-download', version: '1', surface_kind: 'reading',
    domain_allowlist: [SITE], domain_allowlist_signature: 'PUB' },
  action: 'download_file' as BridgeAction, target_domain_pattern: SITE, args, expects_output_keys: [...BRIDGE_DOWNLOAD_OUTPUT_KEYS],
  timeout_ms: 60_000, idempotency_key: 'idem-1',
});
const PDF = Buffer.from('%PDF-1.4 A statement for October.');
const respond = (body: Uint8Array | string, headers: Record<string, string> = {}, status = 200) =>
  new Response(body as BodyInit, { status, headers });

describe('D-335 slice AP — fetchFile', () => {
  it('answers the file in base64, with the name and type its site gives it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(PDF, { 'content-type': 'application/pdf; charset=binary',
      'content-disposition': 'attachment; filename="October statement.pdf"' })));
    expect(await fetchFile('https://bank.example.com/files/9', 1_000)).toEqual({ address: 'https://bank.example.com/files/9',
      filename: 'October statement.pdf', mime_type: 'application/pdf', size: PDF.length, data: PDF.toString('base64') });
  });

  it('names a file by its encoded name, else the last part of its address, and makes the name safe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(PDF, { 'content-disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf" })));
    expect(await fetchFile('https://example.com/a/b.pdf', 1_000)).toMatchObject({ filename: 'résumé.pdf', mime_type: 'application/octet-stream' });
    vi.stubGlobal('fetch', vi.fn(async () => respond(PDF)));
    expect(await fetchFile('https://example.com/reports/annual%20report.pdf?x=1', 1_000)).toMatchObject({ filename: 'annual report.pdf' });
    vi.stubGlobal('fetch', vi.fn(async () => respond(PDF, { 'content-disposition': 'attachment; filename="../../etc/passwd"' })));
    expect(await fetchFile('https://example.com/x', 1_000)).toMatchObject({ filename: '.._.._etc_passwd' });
  });

  it('refuses a file over the cap before reading it, by its declared size or as it reads, and says what the site answered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(PDF, { 'content-length': String(5_000_000) })));
    expect(await fetchFile('https://example.com/big.pdf', 1_000)).toEqual({ too_large: 5_000_000 });
    const parts = new ReadableStream<Uint8Array>({ start(controller) {
      for (let part = 0; part < 5; part += 1) controller.enqueue(new Uint8Array(400));
      controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(parts)));
    expect(await fetchFile('https://example.com/streamed', 1_000)).toEqual({ too_large: 1_200, at_least: true });
    vi.stubGlobal('fetch', vi.fn(async () => respond('Not here', {}, 404)));
    expect(await fetchFile('https://example.com/gone.pdf', 1_000)).toEqual({ failed: 'the site answered 404' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await fetchFile('https://other.example.net/a.pdf', 1_000)).toEqual({ failed: 'Failed to fetch' });
    expect(fileTooLarge(5_000_000, false, BRIDGE_FILE_MAX_BYTES)).toBe('The file is 5.0 MB, and the Browser Bridge hands over files of at most 2.5 MB.');
    expect(fileTooLarge(1_200, true, 1_000)).toBe('The file is more than 0.0 MB, and the Browser Bridge hands over files of at most 0.0 MB.');
  });
});

/** The executor over a page whose link `pageFileAddress` finds at `found`, and whose own fetch answers `inPage`. */
const executor = (found: PageFileAddress, inPage: FetchedFile, blocked: string[] = []) => {
  const ran: string[] = [];
  const api = {
    findTabByUrlPattern: async () => { throw new Error('a page handle must not select a tab'); },
    executeScript: async () => { throw new Error('a page handle runs in its document'); },
    captureVisibleTab: async () => { throw new Error('no screenshot'); },
    showNotification: async (id: string) => id,
    blockedSites: async () => blocked,
    tabUrl: async () => 'https://bank.example.com/statements',
    executeInDocument: async (_target: unknown, func: (...args: unknown[]) => unknown) => {
      ran.push(func === pageFileAddress ? 'address' : func === fetchFile ? 'fetch in the page' : func === rebindPageRef ? 'rebind' : 'other');
      return { document_id: 'DOC1', result: func === rebindPageRef ? { kept: true } : func === pageFileAddress ? found : inPage };
    },
  } as unknown as BridgeBrowserApi;
  const built = buildActionExecutor(api);
  const run = (action: BridgeAction, cmd: BridgeCommand, cancel: { signalled: boolean }) =>
    built.execute({ action, cancel, command: cmd });
  return { run, ran };
};
const LINKED: PageFileAddress = { address: 'https://bank.example.com/files/october.pdf', cross_origin: false,
  url: 'https://bank.example.com/statements', title: 'Statements' };
const FILE: FetchedFile = { address: LINKED.address, filename: 'october.pdf', mime_type: 'application/pdf', size: PDF.length,
  data: PDF.toString('base64') };

describe('D-335 slice AP — download_file in the executor', () => {
  it('finds the link, fetches it in the page, and answers the file with the page it is on', async () => {
    const { run, ran } = executor(LINKED, FILE);
    const out = await run('download_file', command({ page: '7:DOC1', ref: 'e12', max_bytes: BRIDGE_FILE_MAX_BYTES }), { signalled: false });
    expect(ran).toEqual(['rebind', 'address', 'fetch in the page']);
    expect(out).toEqual({ status: 'ok', outputs: { page: '7:DOC1', url: LINKED.url, title: 'Statements', address: LINKED.address,
      filename: 'october.pdf', mime_type: 'application/pdf', size: PDF.length, data: PDF.toString('base64') } });
  });

  it('a file on another site the page may not fetch from is fetched by the Bridge itself', async () => {
    const elsewhere = { ...LINKED, address: 'https://cdn.example.net/october.pdf', cross_origin: true };
    const fetched = vi.fn(async () => respond(PDF, { 'content-type': 'application/pdf' }));
    vi.stubGlobal('fetch', fetched);
    const { run } = executor(elsewhere, { failed: 'Failed to fetch' });
    const out = await run('download_file', command({ page: '7:DOC1', ref: 'e12' }), { signalled: false }) as { outputs?: Record<string, unknown> };
    expect(fetched).toHaveBeenCalledWith('https://cdn.example.net/october.pdf', expect.objectContaining({ credentials: 'include' }));
    expect(out.outputs).toMatchObject({ address: 'https://cdn.example.net/october.pdf', data: PDF.toString('base64') });
  });

  it('refuses a link to no file, a file over the cap, one on a site the owner listed, and both a link and an address', async () => {
    const at = async (found: PageFileAddress, inPage: FetchedFile, args: Record<string, unknown>, blocked: string[] = []) =>
      (await executor(found, inPage, blocked).run('download_file', command({ page: '7:DOC1', ...args }), { signalled: false })) as
        { status: string; error?: { message: string } };
    expect((await at({ no_address: true }, FILE, { ref: 'e12' })).error?.message).toMatch(/^That element links to no file/);
    expect((await at(LINKED, { too_large: 7_200_000 }, { ref: 'e12' })).error?.message)
      .toBe('The file is 7.2 MB, and the Browser Bridge hands over files of at most 2.5 MB.');
    const listed = await at({ ...LINKED, address: 'https://files.listed.example.org/a.pdf' }, FILE, { ref: 'e12' }, ['listed.example.org']);
    expect(listed.status).toBe('error');
    expect((await at(LINKED, FILE, { ref: 'e12', address: LINKED.address })).error?.message)
      .toMatch(/takes the link by ref or selector, or the file's address/);
  });
});

// D-335 slice AQ — one of the owner's files into a file field: the element and its site read first.
describe('D-335 slice AQ — upload_file in the executor', () => {
  const uploader = (attached: AttachedFile, url = 'https://forms.example.com/apply', blocked: string[] = []) => {
    const ran: string[] = [];
    const api = {
      findTabByUrlPattern: async () => { throw new Error('a page handle must not select a tab'); },
      executeScript: async () => { throw new Error('a page handle runs in its document'); },
      captureVisibleTab: async () => { throw new Error('no screenshot'); },
      showNotification: async (id: string) => id,
      blockedSites: async () => blocked,
      tabUrl: async () => url,
      executeInDocument: async (_target: unknown, func: (...args: unknown[]) => unknown) => {
        ran.push(func === attachPageFile ? 'attach' : func === describePageElement ? 'describe' : func === rebindPageRef ? 'rebind' : 'other');
        return { document_id: 'DOC1', result: func === rebindPageRef ? { kept: true } : func === attachPageFile ? attached
          : { outputs: { url, title: 'Apply', role: 'file field', label: 'CV', protected: false } } };
      },
    } as unknown as BridgeBrowserApi;
    const built = buildActionExecutor(api);
    return { run: (args: Record<string, unknown>) => built.execute({ action: 'upload_file' as BridgeAction, cancel: { signalled: false },
      command: { ...command(args), action: 'upload_file' as BridgeAction, expects_output_keys: [...BRIDGE_UPLOAD_OUTPUT_KEYS] } }), ran };
  };
  const ARGS = { page: '7:DOC1', ref: 'e7', filename: 'cv.pdf', mime_type: 'application/pdf', data: PDF.toString('base64') };

  it('reads the field, then puts the file in it, answering the name it took', async () => {
    const { run, ran } = uploader({ attached: 'cv.pdf', url: 'https://forms.example.com/apply', title: 'Apply' });
    expect(await run(ARGS)).toEqual({ status: 'ok', outputs: { attached: 'cv.pdf', page: '7:DOC1',
      url: 'https://forms.example.com/apply', title: 'Apply' } });
    expect(ran).toEqual(['rebind', 'describe', 'attach']);
  });

  it('refuses a field that takes no file, bytes that are not base64, and puts nothing on a page the owner listed', async () => {
    expect(await uploader({ not_file_field: 'input' }).run(ARGS)).toMatchObject({ status: 'error',
      error: { message: expect.stringMatching(/^That element is not a file field/) } });
    expect(await uploader({ attached: 'cv.pdf', url: '', title: '' }).run({ ...ARGS, data: 'not base64!' })).toMatchObject({
      status: 'error', error: { message: 'bridge: upload_file takes a filename, a mime_type and the file in base64' } });
    const listed = uploader({ attached: 'cv.pdf', url: 'https://forms.example.com/apply', title: 'Apply' },
      'https://forms.example.com/apply', ['forms.example.com']);
    expect((await listed.run(ARGS)).status).toBe('error');
    expect(listed.ran).not.toContain('attach');
  });
});

