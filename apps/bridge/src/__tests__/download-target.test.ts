import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_DOWNLOAD_OUTPUT_KEYS, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { fetchFile, pageFileAddress } from '../actions/page-files.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const page = 'https://portal.example.com/statements';
const address = 'https://cdn.example.net/statement.txt';
const sameOrigin = 'https://portal.example.com/statement.txt';
const body = 'fixture-file';

type Options = {
  requested?: string;
  mutate?: (answer: unknown) => unknown;
  pageFailure?: boolean;
  owner?: boolean;
};

// Real locator, executor and fetch code; DOM, scripting transport and network
// are controlled adapters. Relative URLs resolve as in the page. No requests
// leave this process, and these tests do not establish a live Chrome anomaly.
const download = async (options: Options = {}) => {
  const requested = options.requested ?? address;
  vi.stubGlobal('document', { title: 'Statements', documentElement: { hasAttribute: () => options.owner === true } });
  vi.stubGlobal('location', { href: page, origin: new URL(page).origin });
  let inPage = false;
  const requests: Array<{ world: string; address: string }> = [];
  const scripts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    requests.push({ world: inPage ? 'page' : 'worker', address: input });
    if (inPage && options.pageFailure) throw new Error('controlled page fetch failure');
    const response = new Response(body, { headers: { 'content-type': 'text/plain' } });
    Object.defineProperty(response, 'url', { value: new URL(input, page).href });
    return response;
  }));
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    async executeInDocument(_target, func, args) {
      scripts.push(func.name);
      if (func === pageFileAddress) {
        const answer = await func(...args);
        return { document_id: 'DOC7', result: options.mutate ? options.mutate(answer) : answer };
      }
      if (func !== fetchFile) throw new Error(`unexpected script ${func.name}`);
      let result: unknown;
      try { inPage = true; result = await func(...args); } finally { inPage = false; }
      return { document_id: 'DOC7', result };
    },
  };
  const command: BridgeCommand = {
    command_id: 'target', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
      domain_allowlist: ['https://portal.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'download_file', target_domain_pattern: 'https://portal.example.com/*',
    args: { page: '7:DOC7', address: requested, max_bytes: 1_000 },
    expects_output_keys: [...BRIDGE_DOWNLOAD_OUTPUT_KEYS], timeout_ms: 5_000, idempotency_key: 'target',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'download_file', command, cancel: { signalled: false } });
  return { outcome, requests, scripts };
};

const invalid: Array<{ name: string; options: Options }> = [
  { name: 'relative address', options: { mutate: answer => ({ ...answer as object, address: '/different.txt' }) } },
  { name: 'non-web address', options: { mutate: answer => ({ ...answer as object, address: 'data:text/plain,fixture-file' }) } },
  // A scheme without // parses differently with a page base than without one.
  { name: 'ambiguous web address', options: { mutate: answer => ({ ...answer as object, address: 'https:cdn.example.net/statement.txt' }) } },
  { name: 'non-boolean origin flag', options: { requested: sameOrigin, pageFailure: true,
    mutate: answer => ({ ...answer as object, cross_origin: 'false' }) } },
  { name: 'inconsistent origin flag', options: { requested: sameOrigin, pageFailure: true,
    mutate: answer => ({ ...answer as object, cross_origin: true }) } },
  { name: 'incomplete page metadata', options: { mutate: answer => ({ ...answer as object, title: undefined }) } },
  { name: 'mixed success and refusal', options: { mutate: answer => ({ ...answer as object, missing: true }) } },
  { name: 'false refusal marker', options: { mutate: () => ({ no_address: false }) } },
];

describe('download target receipt integrity', () => {
  it.each(invalid)('refuses $name before starting a fetch', async ({ options }) => {
    const t = await download(options);
    expect(t.requests).toEqual([]);
    expect(t.scripts).toEqual(['pageFileAddress']);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'unknown' } });
    expect(t.outcome.outputs).toBeUndefined();
  });

  it.each(['page', 'worker'] as const)('preserves a valid cross-origin %s download', async world => {
    const t = await download({ pageFailure: world === 'worker' });
    expect(t.requests).toEqual(world === 'page' ? [{ world: 'page', address }]
      : [{ world: 'page', address }, { world: 'worker', address }]);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC7', url: page, title: 'Statements',
      address, filename: 'statement.txt', mime_type: 'text/plain', size: body.length, data: Buffer.from(body).toString('base64') } });
  });

  it('preserves a same-origin page failure without starting a worker request', async () => {
    const t = await download({ requested: sameOrigin, pageFailure: true });
    expect(t.requests).toEqual([{ world: 'page', address: sameOrigin }]);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'unknown' } });
    expect(t.outcome.outputs).toBeUndefined();
  });

  it.each([
    { name: 'owner page', options: { owner: true }, code: 'tab_navigation_blocked' },
    { name: 'no web address', options: { requested: 'file:///statement.txt' }, code: 'selector_not_found' },
  ])('preserves a canonical $name refusal without fetching', async ({ options, code }) => {
    const t = await download(options);
    expect(t.requests).toEqual([]);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code } });
    expect(t.outcome.outputs).toBeUndefined();
  });
});
