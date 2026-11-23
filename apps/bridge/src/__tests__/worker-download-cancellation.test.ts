import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_DOWNLOAD_OUTPUT_KEYS, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { fetchFile, pageFileAddress } from '../actions/page-files.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

const within = async <T>(promise: Promise<T>, label: string, ms = 3000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture deadline: ${label}`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
};

const first = Buffer.from('first-part-');
const second = Buffer.from('second-part');
const payload = Buffer.concat([first, second]);

const executeDownload = (address: string, cancel: { signalled: boolean }, pageArgumentCounts: number[],
  beforeFallback?: () => void) => {
  const page = 'https://portal.example.com/files';
  vi.stubGlobal('document', { title: 'Files', documentElement: { hasAttribute: () => false } });
  vi.stubGlobal('location', { href: page, origin: new URL(page).origin });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; },
    async executeScript() { return null; },
    async captureVisibleTab() { return null; },
    async showNotification(id) { return id; },
    async executeInDocument(_target, func, args) {
      if (func === pageFileAddress) return { document_id: 'DOC7', result: await func(...args) };
      if (func !== fetchFile) throw new Error(`unexpected script ${func.name}`);
      pageArgumentCounts.push(args.length);
      beforeFallback?.();
      return { document_id: 'DOC7', result: { failed: 'controlled page-side CORS refusal' } };
    },
  };
  const command: BridgeCommand = {
    command_id: 'file', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
      domain_allowlist: ['https://portal.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'download_file', target_domain_pattern: 'https://portal.example.com/*',
    args: { page: '7:DOC7', address, max_bytes: 1024 },
    expects_output_keys: [...BRIDGE_DOWNLOAD_OUTPUT_KEYS], timeout_ms: 5000, idempotency_key: 'file',
  };
  return buildActionExecutor(api).execute({ action: 'download_file', command, cancel });
};

type Mode = 'cancel-before-headers' | 'cancel-during-body' | 'normal' | 'cancel-at-eof' | 'cancel-before-fallback';

// Only the page-side CORS refusal is an adapter. The worker uses native fetch,
// native response streams, and a test-owned HTTP connection.
const runHttpDownload = async (mode: Mode) => {
  const cancel = { signalled: false };
  const requestArrived = deferred();
  const firstRead = deferred();
  const responseClosed = deferred();
  const state = { requests: 0, bytesRead: 0, released: 0, pageArgumentCounts: [] as number[] };
  let response: ServerResponse | undefined;
  const server = createServer((_request, res) => {
    state.requests += 1;
    response = res;
    res.on('close', responseClosed.resolve);
    requestArrived.resolve();
    if (mode !== 'cancel-before-headers') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', connection: 'close' });
      res.write(first);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('no fixture port');
  const address = `http://127.0.0.1:${bound.port}/fixture.bin`;
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await nativeFetch(input, init);
    const body = answer.body!;
    const getReader = body.getReader.bind(body);
    vi.spyOn(body, 'getReader').mockImplementation(() => {
      const reader = getReader();
      const read = reader.read.bind(reader);
      const release = reader.releaseLock.bind(reader);
      vi.spyOn(reader, 'read').mockImplementation(async () => {
        const result = await read();
        if (result.done) {
          if (mode === 'cancel-at-eof') cancel.signalled = true;
        } else {
          state.bytesRead += result.value.byteLength;
          if (state.bytesRead >= first.length) firstRead.resolve();
        }
        return result;
      });
      vi.spyOn(reader, 'releaseLock').mockImplementation(() => { state.released += 1; release(); });
      return reader;
    });
    return answer;
  }));
  const execution = executeDownload(address, cancel, state.pageArgumentCounts, () => {
    if (mode === 'cancel-before-fallback') cancel.signalled = true;
  });
  // Capture rejection immediately so fixture deadlines never leave an unhandled promise.
  const tracked = execution.then(outcome => ({ outcome }), error => ({ error }));
  let closedBeforeFixtureEOF: boolean | undefined;
  try {
    if (mode !== 'cancel-before-fallback') {
      await within(requestArrived.promise, 'worker HTTP request');
      if (mode !== 'cancel-before-headers') await within(firstRead.promise, 'first native body read');
      if (mode === 'cancel-before-headers' || mode === 'cancel-during-body') {
        cancel.signalled = true;
        closedBeforeFixtureEOF = await within(responseClosed.promise, 'cancelled connection closes')
          .then(() => true, () => false);
      }
      // On the old implementation the deadline expires; supply EOF so the
      // regression fails cleanly rather than leaving its request running.
      if (!closedBeforeFixtureEOF) {
        if (mode === 'cancel-before-headers') {
          response!.writeHead(200, { 'content-type': 'application/octet-stream', connection: 'close' });
          response!.end(payload);
        } else {
          response!.end(second);
        }
      }
    }
    const result = await within(tracked, 'executor settlement');
    if ('error' in result) throw result.error;
    return { outcome: result.outcome, state, address, cancelled: cancel.signalled, closedBeforeFixtureEOF };
  } finally {
    response?.end();
    server.closeAllConnections();
    await new Promise<void>(resolve => { server.close(() => resolve()); });
    await within(tracked, 'cleanup settlement', 1000);
  }
};

describe('worker download cancellation', () => {
  it.each(['cancel-before-headers', 'cancel-during-body'] as const)(
    'aborts %s without accepting a partial file or waiting for server EOF', async mode => {
      const result = await runHttpDownload(mode);
      expect(result.closedBeforeFixtureEOF).toBe(true);
      expect(result.outcome.status).toBe('cancelled');
      expect(result.outcome.outputs).toBeUndefined();
      expect(result.state.requests).toBe(1);
      expect(result.state.bytesRead).toBe(mode === 'cancel-during-body' ? first.length : 0);
      expect(result.state.released).toBe(mode === 'cancel-during-body' ? 1 : 0);
      expect(result.state.pageArgumentCounts).toEqual([3]);
    }, 15_000);

  it.each(['normal', 'cancel-at-eof'] as const)('preserves the completed %s file and releases its reader', async mode => {
    const result = await runHttpDownload(mode);
    expect(result.outcome).toMatchObject({ status: 'ok', outputs: {
      address: result.address, filename: 'fixture.bin', mime_type: 'application/octet-stream',
      size: payload.length, data: payload.toString('base64'),
    } });
    expect(result.state.requests).toBe(1);
    expect(result.state.released).toBe(1);
    expect(result.cancelled).toBe(mode === 'cancel-at-eof');
    expect(result.state.pageArgumentCounts).toEqual([3]);
  });

  it('does not open a worker request when cancellation precedes fallback', async () => {
    const result = await runHttpDownload('cancel-before-fallback');
    expect(result.outcome.status).toBe('cancelled');
    expect(result.outcome.outputs).toBeUndefined();
    expect(result.state).toEqual({ requests: 0, bytesRead: 0, released: 0, pageArgumentCounts: [3] });
  });

  it.each(['success', 'network-failure'] as const)('stops observing cancellation after worker %s', async mode => {
    vi.useFakeTimers();
    let observations = 0;
    const cancel = { get signalled() { observations += 1; return false; } };
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (mode === 'network-failure') throw new Error('controlled worker network failure');
      return new Response(payload, { headers: { 'content-type': 'application/octet-stream' } });
    }));
    const pageArgumentCounts: number[] = [];
    const execution = executeDownload('https://files.example.com/fixture.bin', cancel, pageArgumentCounts);
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await execution;
    if (mode === 'success') {
      expect(outcome).toMatchObject({ status: 'ok', outputs: { size: payload.length, data: payload.toString('base64') } });
    } else {
      expect(outcome).toMatchObject({ status: 'error', error: { code: 'unknown' } });
      expect(outcome.error?.message).toContain('controlled worker network failure');
    }
    const completedObservations = observations;
    await vi.advanceTimersByTimeAsync(1000);
    expect(observations).toBe(completedObservations);
    expect(pageArgumentCounts).toEqual([3]);
  });
});
