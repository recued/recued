import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_DOWNLOAD_OUTPUT_KEYS, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { fetchFile, pageFileAddress, type FetchedFile } from '../actions/page-files.js';
import { isOnBlockedSite } from '../permissions/site-grants.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const page = 'https://portal.example.com/statements';
const requested = 'https://cdn.allowed.example.net/file';
const blocked = ['blocked.example'];
const payload = new TextEncoder().encode('fixture-file');
const data = Buffer.from(payload).toString('base64');
type Path = 'page' | 'worker';
const responseAt = (url: string, declaresSize = true, status = 200) => {
  const response = new Response(payload, { status, headers: {
    'content-type': 'text/plain', ...(declaresSize ? { 'content-length': String(payload.length) } : {}),
  } });
  Object.defineProperty(response, 'url', { value: url });
  return { response, reader: vi.spyOn(response.body!, 'getReader'), cancel: vi.spyOn(response.body!, 'cancel') };
};

// The real executor and fetchFile read real response streams. Scripting and
// response URLs are adapters; these tests make no network requests or live redirects.
const runDownload = async (path: Path, response: Response, options: { maxBytes?: number; returned?: FetchedFile } = {}) => {
  const fetched = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetched);
  const scripts: string[] = [];
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; },
    async executeScript() { return null; },
    async captureVisibleTab() { return null; },
    async showNotification(id) { return id; },
    async blockedSites() { return blocked; },
    async tabUrl() { return page; },
    async executeInDocument(_target, func, args) {
      scripts.push(func.name);
      if (func === pageFileAddress) return { document_id: 'DOC7', result: {
        address: requested, cross_origin: true, url: page, title: 'Statements',
      } };
      if (func !== fetchFile) throw new Error(`unexpected script ${func.name}`);
      return { document_id: 'DOC7', result: options.returned ?? (path === 'page'
        ? await func(...args) : { failed: 'controlled page-side CORS refusal' }) };
    },
  };
  const command: BridgeCommand = {
    command_id: 'destination', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
      domain_allowlist: ['https://portal.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'download_file', target_domain_pattern: 'https://portal.example.com/*',
    args: { page: '7:DOC7', address: requested, max_bytes: options.maxBytes ?? 1_000 },
    expects_output_keys: [...BRIDGE_DOWNLOAD_OUTPUT_KEYS], timeout_ms: 5_000, idempotency_key: 'destination',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'download_file', command, cancel: { signalled: false } });
  return { outcome, fetched, scripts };
};

describe('download destination policy', () => {
  it.each([
    { path: 'page' as const, url: 'https://blocked.example/statement.txt', refused: true },
    { path: 'page' as const, url: 'https://blocked.example/denied', refused: true, status: 403 },
    { path: 'worker' as const, url: 'https://FILES.BLOCKED.EXAMPLE./statement.txt', refused: true },
    { path: 'page' as const, url: 'https://blocked.example.evil.test/statement.txt', refused: false },
    { path: 'worker' as const, url: 'https://notblocked.example/statement.txt', refused: false },
  ])('$path: enforces the final destination $url before opening the body', async ({ path, url, refused, status }) => {
    const t = responseAt(url, true, status);
    // Cleanup failure must not turn a policy refusal into a retryable fetch failure.
    if (path === 'page' && refused) t.cancel.mockRejectedValueOnce(new Error('body already closed'));
    const result = await runDownload(path, t.response);
    expect(isOnBlockedSite(url, blocked)).toBe(refused);
    expect(result.fetched).toHaveBeenCalledTimes(1);
    expect(result.scripts.filter(name => name === 'fetchFile')).toHaveLength(1);
    if (refused) {
      expect(result.outcome).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
      expect(result.outcome.outputs).toBeUndefined();
      expect(t.reader).not.toHaveBeenCalled();
      expect(t.cancel).toHaveBeenCalledTimes(1);
    } else {
      expect(result.outcome).toMatchObject({ status: 'ok', outputs: {
        address: url, filename: 'statement.txt', mime_type: 'text/plain', size: payload.length, data,
      } });
      expect(t.reader).toHaveBeenCalledTimes(1);
      expect(t.cancel).not.toHaveBeenCalled();
    }
  });

  it('rejects a blocked address in the returned file without accepting bytes or fetching again', async () => {
    const t = responseAt('https://cdn.allowed.example.net/statement.txt');
    const result = await runDownload('page', t.response, { returned: {
      address: 'https://files.blocked.example/statement.txt', filename: 'statement.txt', mime_type: 'text/plain',
      size: payload.length, data,
    } });
    expect(result.outcome).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
    expect(result.outcome.outputs).toBeUndefined();
    expect(result.fetched).not.toHaveBeenCalled();
    expect(t.reader).not.toHaveBeenCalled();
  });

  it('preserves the requested address when a synthetic response has no URL', async () => {
    const t = responseAt('');
    const result = await runDownload('page', t.response);
    expect(result.outcome).toMatchObject({ status: 'ok', outputs: { address: requested, data } });
    expect(t.reader).toHaveBeenCalledTimes(1);
  });

  it.each(['declared', 'streamed'] as const)('keeps the %s size cap after an allowed worker destination', async size => {
    const t = responseAt('https://cdn.allowed.example.net/statement.txt', size === 'declared');
    const result = await runDownload('worker', t.response, { maxBytes: 5 });
    expect(result.outcome).toMatchObject({ status: 'error', error: { code: 'unknown',
      message: expect.stringContaining('at most') } });
    expect(result.outcome.outputs).toBeUndefined();
    expect(result.fetched).toHaveBeenCalledTimes(1);
    expect(t.reader).toHaveBeenCalledTimes(size === 'declared' ? 0 : 1);
    if (size === 'declared') expect(t.cancel).toHaveBeenCalledTimes(1);
  });
});
