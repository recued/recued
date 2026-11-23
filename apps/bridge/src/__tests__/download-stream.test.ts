import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_DOWNLOAD_OUTPUT_KEYS, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { fetchFile, pageFileAddress } from '../actions/page-files.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
type Mode = 'same-origin-read-error' | 'worker-read-error' | 'cross-origin-recovery' | 'http-error';

// Native response streams fail after yielding bytes; location and fetch use
// the real injected functions. No external requests or live Chrome.
const runDownload = async (mode: Mode) => {
  const page = 'https://portal.example.com/statements';
  const address = mode === 'same-origin-read-error' || mode === 'http-error'
    ? 'https://portal.example.com/file.txt' : 'https://cdn.example.net/file.txt';
  const complete = new TextEncoder().encode('complete file');
  const requests: string[] = []; const bodies: ReadableStream<Uint8Array>[] = [];
  let inPage = false; let cancelledBodies = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    requests.push(inPage ? 'page' : 'worker');
    if (inPage && mode === 'worker-read-error') throw new Error('page-side CORS refusal');
    const broken = inPage || mode === 'worker-read-error';
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelledBodies++; }, pull(controller) {
      if (!broken) { controller.enqueue(complete); controller.close(); }
      else if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('partial'));
      else controller.error(new Error('file stream interrupted'));
    } });
    bodies.push(stream);
    const response = new Response(stream, { status: mode === 'http-error' ? 403 : 200, headers: { 'content-type': 'text/plain' } });
    Object.defineProperty(response, 'url', { value: address });
    return response;
  }));
  vi.stubGlobal('document', { title: 'Statements', documentElement: { hasAttribute: () => false } });
  vi.stubGlobal('location', { href: page, origin: new URL(page).origin });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    async executeInDocument(_target, func, args) {
      if (func === pageFileAddress) return { document_id: 'DOC7', result: await func(...args) };
      if (func !== fetchFile) throw new Error(`unexpected script ${func.name}`);
      try { inPage = true; return { document_id: 'DOC7', result: await func(...args) }; }
      finally { inPage = false; }
    },
  };
  const command: BridgeCommand = {
    command_id: 'stream', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
      domain_allowlist: ['https://portal.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'download_file', target_domain_pattern: 'https://portal.example.com/*',
    args: { page: '7:DOC7', address, max_bytes: 1_000 }, expects_output_keys: [...BRIDGE_DOWNLOAD_OUTPUT_KEYS],
    timeout_ms: 5_000, idempotency_key: 'stream',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'download_file', command, cancel: { signalled: false } });
  return { outcome, requests, bodies, address, complete, cancelledBodies };
};

describe('download stream failures', () => {
  it.each(['same-origin-read-error', 'worker-read-error'] as const)('reports %s without accepting partial bytes', async mode => {
    const t = await runDownload(mode);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'unknown', message: expect.stringContaining('file stream interrupted') } });
    expect(t.outcome.outputs).toBeUndefined();
    expect(t.requests).toEqual(mode === 'same-origin-read-error' ? ['page'] : ['page', 'worker']);
    for (const body of t.bodies) expect(body.locked).toBe(false);
  });

  it('preserves cross-origin recovery with a complete worker file', async () => {
    const t = await runDownload('cross-origin-recovery');
    expect(t.outcome).toMatchObject({ status: 'ok', outputs: {
      address: t.address, size: t.complete.length, data: Buffer.from(t.complete).toString('base64') } });
    expect(t.requests).toEqual(['page', 'worker']);
  });

  it('cancels an HTTP error body without reading it or fetching again', async () => {
    const t = await runDownload('http-error');
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'unknown' } });
    expect(t.outcome.outputs).toBeUndefined();
    expect(t.requests).toEqual(['page']);
    expect(t.cancelledBodies).toBe(1);
  });
});
