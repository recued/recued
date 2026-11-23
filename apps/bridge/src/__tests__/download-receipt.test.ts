import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_DOWNLOAD_OUTPUT_KEYS, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { fetchFile, pageFileAddress } from '../actions/page-files.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const pageUrl = 'https://portal.example.com/statements';
const address = 'https://cdn.example.net/statement.txt';
const payload = new TextEncoder().encode('fixture-file');
const data = Buffer.from(payload).toString('base64');
type Mode = 'foreign-file' | 'foreign-failure' | 'empty-reply' | 'mixed-reply' | 'wrong-size' | 'oversized-reply'
  | 'malformed-data' | 'page' | 'worker' | 'same-origin-failure' | 'empty-file';

// Real location and fetch functions with native response streams. Only DOM,
// network and transport are adapters; no external requests or live Chrome.
const runDownload = async (mode: Mode) => {
  const requested = mode === 'same-origin-failure' ? 'https://portal.example.com/statement.txt' : address;
  let inPage = false;
  const requests: Array<{ world: string; address: string }> = [];
  const fetched = vi.fn(async (input: string) => {
    requests.push({ world: inPage ? 'page' : 'worker', address: input });
    if (inPage && ['worker', 'foreign-failure', 'same-origin-failure'].includes(mode)) throw new Error('page fetch failed');
    const body = mode === 'empty-file' ? new Uint8Array(0) : payload;
    const response = new Response(body, { headers: { 'content-type': 'text/plain', 'content-length': String(body.length) } });
    Object.defineProperty(response, 'url', { value: requested });
    return response;
  });
  vi.stubGlobal('fetch', fetched);
  vi.stubGlobal('document', { title: 'Statements', documentElement: { hasAttribute: () => false } });
  vi.stubGlobal('location', { href: pageUrl, origin: new URL(pageUrl).origin });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    async executeInDocument(_target, func, args) {
      if (func === pageFileAddress) return { document_id: 'DOC7', result: await func(...args) };
      if (func !== fetchFile) throw new Error(`unexpected script ${func.name}`);
      let result: unknown;
      try { inPage = true; result = await func(...args); } finally { inPage = false; }
      if (mode === 'foreign-file' || mode === 'foreign-failure') return { document_id: 'OTHER', result };
      if (mode === 'empty-reply') result = {};
      if (mode === 'mixed-reply') result = { ...result as object, failed: 'inconsistent acknowledgement' };
      if (mode === 'wrong-size') result = { ...result as object, size: payload.length + 1 };
      if (mode === 'oversized-reply') result = { ...result as object, size: 1_001, data: Buffer.alloc(1_001).toString('base64') };
      if (mode === 'malformed-data') result = { ...result as object, data: 'not base64!' };
      return { document_id: 'DOC7', result };
    },
  };
  const command: BridgeCommand = {
    command_id: 'file', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
      domain_allowlist: ['https://portal.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'download_file', target_domain_pattern: 'https://portal.example.com/*',
    args: { page: '7:DOC7', address: requested, max_bytes: 1_000 }, expects_output_keys: [...BRIDGE_DOWNLOAD_OUTPUT_KEYS],
    timeout_ms: 5_000, idempotency_key: 'file',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'download_file', command, cancel: { signalled: false } });
  return { outcome, requests, requested };
};

describe('download receipt integrity', () => {
  it.each(['foreign-file', 'foreign-failure'] as const)('rejects %s without another fetch', async mode => {
    const t = await runDownload(mode);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
    expect(t.outcome.outputs).toBeUndefined();
    expect(t.requests).toEqual([{ world: 'page', address }]);
  });

  it.each(['empty-reply', 'mixed-reply', 'wrong-size', 'oversized-reply', 'malformed-data'] as const)(
    'rejects %s without accepting bytes or trying the worker', async mode => {
      const t = await runDownload(mode);
      expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'unknown' } });
      expect(t.outcome.outputs).toBeUndefined();
      expect(t.requests).toEqual([{ world: 'page', address }]);
    });

  it.each(['page', 'worker'] as const)('preserves a valid %s download with its bytes and metadata', async mode => {
    const t = await runDownload(mode);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC7', url: pageUrl, title: 'Statements',
      address, filename: 'statement.txt', mime_type: 'text/plain', size: payload.length, data } });
    expect(t.requests).toEqual(mode === 'page' ? [{ world: 'page', address }]
      : [{ world: 'page', address }, { world: 'worker', address }]);
  });

  it('keeps a same-origin fetch failure from starting a worker request', async () => {
    const t = await runDownload('same-origin-failure');
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'unknown' } });
    expect(t.requests).toEqual([{ world: 'page', address: t.requested }]);
  });

  it('accepts an empty file without inventing bytes', async () => {
    const t = await runDownload('empty-file');
    expect(t.outcome).toMatchObject({ status: 'ok', outputs: { address, size: 0, data: '' } });
    expect(t.requests).toEqual([{ world: 'page', address }]);
  });
});
