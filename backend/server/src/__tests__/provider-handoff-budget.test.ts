import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Commit, IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { IngredientError, type ConnectionApiHandlerDeps, type ConnectionMcpHandlerDeps, type McpStreamHandle } from '@recued/ingredients';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createServerExecutor } from '../server-executor.js';
import { withRunAbortContext } from '../execution/run-abort-context.js';
import { callCalendarAdapter } from '../collections/calendar/errors.js';
import type { MailProvider } from '../collections/mail/provider.js';
import { resourceFixture, resourceFixtureDisposers } from './preapproval-resources-fixture.js';
import { createMailSendClaimStore } from '../storage/mail-send-claim-store.js';
import type { LLMConfig } from '@recued/llm';
import { withPreapprovalOrdinaryGuard } from '../preapproval-io-context.js';

const cleanups: Array<() => void> = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
  for (const close of cleanups.splice(0).reverse()) close();
});

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const reached = <T>(entered: Promise<void>, execution: Promise<T>) => Promise.race([
  entered, execution.then(result => { throw new Error('Run settled before preparation: ' + JSON.stringify(result)); }),
]);
type Mode = 'api' | 'mcp' | 'http' | 'legacy-mcp' | 'ai';
let serial = 0;
const fixture = (mode: Mode) => {
  const db = new Database(':memory:'); cleanups.push(() => db.close());
  const connections = createConnectionStore(db);
  for (const kind of ['api', 'mcp'] as const) connections.upsert({ kind, name: 'fixture', display_name: 'Fixture',
    config_json: JSON.stringify(kind === 'api' ? { base_url: 'https://provider.fixture.invalid' }
      : { transport: 'sse', endpoint: 'https://provider.fixture.invalid/mcp' }),
    auth_ciphertext: 'fixture', enrolled_at: 1, updated_at: 1,
    health_json: JSON.stringify({ tools: ['lookup'], mcp_tool_schemas: { lookup: { type: 'object', properties: {} } } }) });
  const manifests = createManifestRegistry('/nonexistent');
  const manifest: IngredientManifest = { slug: mode === 'ai' ? 'ai-classify' : 'fixture-' + mode,
    version: 1, name: 'Provider handoff', description: '', author: 'fixture',
    kind: mode === 'api' || mode === 'mcp' ? 'connection' : mode === 'legacy-mcp' ? 'mcp' : mode,
    category: mode === 'ai' ? 'ai' : 'data', risk_tier: 'read', output: {},
    input: mode === 'api' ? { connection_kind: 'api', connection: 'fixture', method: 'GET', path: '/read' }
      : mode === 'mcp' ? { connection_kind: 'mcp', connection: 'fixture', tool: 'lookup', args: {} }
      : mode === 'legacy-mcp' ? { 'mcp.server_url': 'https://provider.fixture.invalid/mcp', 'mcp.tool': 'lookup' }
      : mode === 'ai' ? { 'llm.data': 'hello', 'llm.categories': ['greeting', 'other'], 'llm.model_hint': 'fast' }
      : { method: 'GET', url: 'https://provider.fixture.invalid/read' } };
  manifests.register(manifest);
  if (mode === 'ai') manifests.register(KERNEL_MANIFESTS.find(row => row.slug === 'data-file-read')!);
  const recipes = createRecipeStore('/nonexistent');
  const step = { id: 'call', ingredient: manifest.slug, input: mode === 'ai' ? (manifest.input ?? {}) : {} };
  const recipe: RecipeDefinition = { recipe_id: 'provider-handoff', version: 1, ttl: 0,
    metadata: { name: 'Provider handoff', description: 'Provider handoff fixture.', author: 'fixture', supported_platforms: [], budget_ms: 1_000 },
    variables: {}, prefetch_steps: [], steps: [step], output: { render: [] } };
  recipes.register(recipe);
  const api: ConnectionApiHandlerDeps = { decodeAuth: vi.fn(async () => ({ type: 'none' as const })), persistAuth: async () => {} };
  const mcp: ConnectionMcpHandlerDeps = { decodeAuth: vi.fn(async () => ({ type: 'none' as const })), persistAuth: async () => {} };
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (mode === 'ai') return new Response(JSON.stringify({ choices: [{ message: {
      content: '{"category":"greeting","confidence":0.9,"reasoning":"hi"}',
    } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }), { headers: { 'content-type': 'application/json' } });
    if (mode === 'mcp' || mode === 'legacy-mcp') {
      const frame = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (frame.id === undefined) return new Response(null, { status: 202 });
      const result = frame.method === 'server/discover'
        ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} } }
        : frame.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
          : { value: 'ok' };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"value":"ok"}', { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch); api.fetchImpl = fetch; mcp.fetchImpl = fetch;
  const store = createCommitStore(createInMemoryCollection<Commit>()); const usage = vi.fn();
  const deps: ExecuteHandlerDeps = { recipeStore: recipes, baseVault: {}, connectionStore: connections, commitStore: store,
    executorConfig: { manifests, connectionStore: connections, connectionApi: api, connectionMcp: mcp,
      llmConfig: { slot_1: { provider: 'openai', model: 'gpt-fast', api_key: 'fixture', base_url: 'https://model-' + ++serial + '.fixture.invalid' } },
      onTokenUsage: usage } };
  let id = '';
  return { db, api, mcp, deps, connections, manifest, recipe, recipes, step, fetch, usage,
    commits: () => store.listByRun(id),
    run: () => handleExecute(deps, { recipe_id: recipe.recipe_id,
      execution_source: { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'fixture' } },
    { onRunMinted: value => { id = value; } }),
  };
};

describe('provider handoffs use the effective run budget', () => {
  it.each(['api', 'mcp'] as const)('refuses %s requests after authentication crosses expiry', async mode => {
    vi.useFakeTimers(); const f = fixture(mode); const entered = gate(); const held = gate();
    f[mode].decodeAuth = vi.fn(async () => { entered.release(); await held.promise; return { type: 'none' as const }; });
    const execution = f.run();
    try {
      await reached(entered.promise, execution); await vi.advanceTimersByTimeAsync(1_000); held.release();
      expect(await execution).toMatchObject({ success: false, errors: [{ code: 'RECIPE_BUDGET_EXCEEDED' }] });
      expect(f.fetch).not.toHaveBeenCalled();
      expect(await f.commits()).toMatchObject([{ status: 'cancelled' }]);
    } finally { held.release(); await execution; }
  });

  it('refuses API requests after the final asynchronous admission check crosses expiry', async () => {
    vi.useFakeTimers(); const f = fixture('api'); const entered = gate(); const held = gate();
    f.api.beforeRequest = async () => { entered.release(); await held.promise; };
    const execution = f.run();
    try {
      await reached(entered.promise, execution); await vi.advanceTimersByTimeAsync(1_000); held.release();
      expect((await execution).success).toBe(false); expect(f.fetch).not.toHaveBeenCalled();
    } finally { held.release(); await execution; }
  });

  it('refuses an AI completion after file preparation crosses expiry', async () => {
    vi.useFakeTimers(); const f = fixture('ai'); const entered = gate(); const held = gate();
    f.step.input['llm.data'] = { file_ref: 'fixture-file' }; f.recipes.register(f.recipe);
    f.deps.executorConfig.fileRead = async () => {
      entered.release(); await held.promise; return { bytes_b64: Buffer.from('hello').toString('base64'), mime_type: 'text/plain', filename: 'fixture.txt' };
    };
    const execution = f.run();
    try {
      await reached(entered.promise, execution); await vi.advanceTimersByTimeAsync(1_000); held.release();
      expect(await execution).toMatchObject({ success: false, errors: [{ code: 'RECIPE_BUDGET_EXCEEDED' }] });
      expect(f.fetch).not.toHaveBeenCalled(); expect(f.usage).not.toHaveBeenCalled();
      expect(await f.commits()).toMatchObject([{ status: 'cancelled' }]);
    } finally { held.release(); await execution; }
  });

  it.each(['http', 'legacy-mcp'] as const)('refuses another %s request when a redirect arrives after expiry', async mode => {
    vi.useFakeTimers(); const f = fixture(mode); const entered = gate(); const held = gate();
    f.fetch.mockImplementationOnce(async () => {
      entered.release(); await held.promise; return new Response(null, { status: 307, headers: { location: '/redirected' } });
    });
    const execution = f.run();
    try {
      await reached(entered.promise, execution); await vi.advanceTimersByTimeAsync(1_000); held.release();
      expect((await execution).success).toBe(false); expect(f.fetch).toHaveBeenCalledOnce();
    } finally { held.release(); await execution; }
  });

  it.each(['http', 'ai'] as const)('drains an admitted %s request after expiry', async mode => {
    vi.useFakeTimers(); const f = fixture(mode); const entered = gate(); const held = gate();
    const respond = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementationOnce(async (...args) => { entered.release(); await held.promise; return respond(...args); });
    let settled = false; const execution = f.run().then(result => { settled = true; return result; });
    try {
      await reached(entered.promise, execution); await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false); expect(f.fetch.mock.calls[0]![1]?.signal?.aborted).not.toBe(true);
      held.release(); expect((await execution).success).toBe(false);
      expect(f.fetch).toHaveBeenCalledOnce(); expect(await f.commits()).toMatchObject([{ status: 'cancelled' }]);
      expect((await f.commits())[0]).not.toHaveProperty('output');
      if (mode === 'ai') expect(f.usage).toHaveBeenCalledWith(3);
    } finally { held.release(); await execution; }
  });

  it.each(['api', 'mcp', 'http', 'legacy-mcp', 'ai'] as const)('keeps timely %s requests working', async mode => {
    const f = fixture(mode); const result = await f.run();
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(f.fetch).toHaveBeenCalled(); expect(await f.commits()).toMatchObject([{ status: 'succeeded' }]);
  });

  it('does not start an AI protocol fallback after the first response crosses expiry', async () => {
    vi.useFakeTimers(); const f = fixture('ai'); const entered = gate(); const held = gate();
    f.deps.executorConfig.llmConfig!.slot_1!.supports_json = true;
    f.fetch.mockImplementationOnce(async () => {
      entered.release(); await held.promise; return new Response('response_format not supported', { status: 400 });
    });
    const execution = f.run();
    try {
      await reached(entered.promise, execution); await vi.advanceTimersByTimeAsync(1_000); held.release();
      expect((await execution).success).toBe(false); expect(f.fetch).toHaveBeenCalledOnce();
    } finally { held.release(); await execution; }
  });

  it.each(['websocket', 'stdio'] as const)('checks a warm MCP %s session using the dispatching run', async transport => {
    const f = fixture('mcp'); const connections = f.connections;
    connections.upsert({ ...connections.get('mcp', 'fixture')!, config_json: JSON.stringify(transport === 'stdio'
      ? { transport, command: process.execPath, args: [] } : { transport, endpoint: 'wss://provider.fixture.invalid/mcp' }) });
    const calls: string[] = []; let message: ((data: string) => void) | undefined;
    const stream: McpStreamHandle = {
      send: data => {
        const frame = JSON.parse(data) as { id?: number; method: string };
        if (frame.method === 'tools/call') calls.push(frame.method);
        if (frame.id === undefined) return;
        const result = frame.method === 'server/discover'
          ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} } }
          : frame.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
            : { value: 'ok' };
        queueMicrotask(() => message?.(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })));
      }, onMessage: listener => { message = listener; }, onClose: () => {}, onError: () => {}, close: () => {},
    };
    f.mcp.wsConnect = vi.fn(async () => stream); f.mcp.spawnStdioMcp = vi.fn(async () => stream);
    const executor = createServerExecutor(f.deps.executorConfig);
    const previous = new AbortController();
    await withRunAbortContext({ signal: previous.signal }, () => executor(f.manifest.slug, {}));
    previous.abort();
    await withRunAbortContext({ signal: new AbortController().signal }, () => executor(f.manifest.slug, {}));
    expect(calls).toHaveLength(2);
    const entered = gate(); const held = gate(); const current = new AbortController();
    f.mcp.beforeRequest = async () => { entered.release(); await held.promise; };
    const execution = withRunAbortContext({ signal: current.signal }, () => executor(f.manifest.slug, {}));
    const observed = execution.then(result => ({ result }), error => ({ error }));
    try {
      await reached(entered.promise, observed); current.abort(); held.release();
      expect(await observed).toMatchObject({ error: { code: 'run_killed' } });
      expect(calls).toHaveLength(2);
    } finally { held.release(); await observed; }
  });

  it('stops a Calendar provider chain between calls while draining the admitted call', async () => {
    const controller = new AbortController(); const entered = gate(); const held = gate();
    const first = vi.fn(async () => { entered.release(); await held.promise; return 'first receipt'; });
    const second = vi.fn(async () => 'second receipt');
    const execution = withRunAbortContext({ signal: controller.signal }, async () => {
      expect(await callCalendarAdapter('fixture', 'calendar-update', first)).toBe('first receipt');
      return callCalendarAdapter('fixture', 'calendar-create', second);
    });
    const observed = execution.then(result => ({ result }), error => ({ error }));
    try {
      await reached(entered.promise, observed); controller.abort(); held.release();
      expect(await observed).toMatchObject({ error: { code: 'run_killed' } });
      expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
    } finally { held.release(); await observed; }
  });

  it.each((['sse', 'websocket', 'stdio'] as const).flatMap(transport =>
    [false, true].map(waiterStopped => ({ transport, waiterStopped }))))(
    'keeps MCP $transport setup cancellation local (waiter stopped: $waiterStopped)', async ({ transport, waiterStopped }) => {
    const f = fixture('mcp'); const entered = gate(); const held = gate();
    f.connections.upsert({ ...f.connections.get('mcp', 'fixture')!, config_json: JSON.stringify(transport === 'stdio'
      ? { transport, command: process.execPath, args: [] }
      : { transport, endpoint: (transport === 'sse' ? 'https' : 'wss') + '://provider.fixture.invalid/mcp' }) });
    const streams: McpStreamHandle[] = []; const toolCalls = vi.fn();
    const open = vi.fn(async () => {
      let message: ((data: string) => void) | undefined;
      const stream: McpStreamHandle = {
        send: data => {
          const frame = JSON.parse(data) as { id?: number; method: string };
          if (frame.method === 'tools/call') toolCalls();
          if (frame.id === undefined) return;
          const result = frame.method === 'server/discover'
            ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } : { value: 'ok' };
          queueMicrotask(() => message?.(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })));
        }, onMessage: listener => { message = listener; }, onClose: () => {}, onError: () => {}, close: vi.fn(),
      };
      streams.push(stream);
      if (streams.length === 1) { entered.release(); await held.promise; }
      return stream;
    });
    f.mcp.wsConnect = open; f.mcp.spawnStdioMcp = open;
    if (transport === 'sse') f.fetch.mockImplementationOnce(async () => {
      entered.release(); await held.promise; return new Response('method not found', { status: 404 });
    });
    f.mcp.beforeConnect = vi.fn(async () => {});
    const executor = createServerExecutor(f.deps.executorConfig); const stopped = new AbortController(); const waiter = new AbortController();
    const observe = (promise: Promise<unknown>) => promise.then(result => ({ result }), error => ({ error }));
    const first = observe(withRunAbortContext({ signal: stopped.signal }, () => executor(f.manifest.slug, {})));
    let second: ReturnType<typeof observe> | undefined;
    try {
      await reached(entered.promise, first);
      second = observe(withRunAbortContext({ signal: waiter.signal }, () => executor(f.manifest.slug, {})));
      // Drain the admitted caller's setup microtasks until both calls await the shared opening flight.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.mcp.beforeConnect).toHaveBeenCalledTimes(2);
      if (transport !== 'sse') expect(open).toHaveBeenCalledOnce();
      stopped.abort(); if (waiterStopped) waiter.abort(); held.release();
      expect(await first).toMatchObject({ error: { code: 'run_killed' } });
      expect(await second).toMatchObject(waiterStopped ? { error: { code: 'run_killed' } } : { result: { status: 'ok' } });
      if (transport === 'sse') {
        expect(f.fetch).toHaveBeenCalledTimes(waiterStopped ? 1 : 3);
      } else {
        expect(open).toHaveBeenCalledTimes(waiterStopped ? 1 : 2); expect(toolCalls).toHaveBeenCalledTimes(waiterStopped ? 0 : 1);
        expect(streams[0]!.close).toHaveBeenCalledOnce();
        if (!waiterStopped) expect(streams[1]!.close).not.toHaveBeenCalled();
      }
    } finally { held.release(); await first; await second; }
  });

  it('keeps another legacy MCP SSE request draining when a stopped caller is refused at a redirect', async () => {
    const f = fixture('mcp'); const entered = gate(); const held = gate();
    let closeStream = () => {}; let liveSignal: AbortSignal | null | undefined;
    const response = (id: number, result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }),
      { headers: { 'content-type': 'application/json' } });
    const stopped = new AbortController();
    f.fetch.mockImplementation(async (url, init) => {
      if (init?.method === 'GET') {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          let closed = false;
          closeStream = () => { if (!closed) { closed = true; controller.close(); } };
          init.signal?.addEventListener('abort', closeStream, { once: true });
          controller.enqueue(new TextEncoder().encode('event: endpoint\ndata: /messages\n\n'));
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      const frame = JSON.parse(String(init?.body)) as { id: number; method: string; params?: { arguments?: { caller?: string } } };
      if (String(url).endsWith('/mcp')) return new Response('legacy endpoint', { status: 404 });
      if (frame.method === 'initialize') return response(frame.id, { protocolVersion: '2024-11-05', capabilities: {},
        serverInfo: { name: 'fixture', version: '1' } });
      if (frame.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (frame.params?.arguments?.caller === 'live') {
        liveSignal = init?.signal; entered.release(); await held.promise;
      }
      if (frame.params?.arguments?.caller === 'stopped') {
        stopped.abort(); return new Response(null, { status: 307, headers: { location: '/redirected' } });
      }
      return response(frame.id, { value: 'ok' });
    });
    const executor = createServerExecutor(f.deps.executorConfig);
    const observe = (promise: Promise<unknown>) => promise.then(result => ({ result }), error => ({ error }));
    const live = observe(withRunAbortContext({ signal: new AbortController().signal },
      () => executor(f.manifest.slug, { args: { caller: 'live' } })));
    try {
      await reached(entered.promise, live);
      const refused = await observe(withRunAbortContext({ signal: stopped.signal },
        () => executor(f.manifest.slug, { args: { caller: 'stopped' } })));
      expect(refused).toMatchObject({ error: { code: 'run_killed' } });
      expect(liveSignal?.aborted).toBe(false);
      held.release(); expect(await live).toMatchObject({ result: { status: 'ok' } });
      await expect(executor(f.manifest.slug, {})).resolves.toMatchObject({ status: 'ok' });
      expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1);
    } finally { held.release(); await live; closeStream(); }
  });

  it.each(['api', 'mcp'] as const)('preserves %s cancellation when an OAuth redirect arrives after stop', async mode => {
    const f = fixture(mode); const controller = new AbortController(); const observeAccess = vi.fn();
    f[mode].decodeAuth = async () => ({ type: 'oauth2_refresh', refresh_token: 'fixture', client_id: 'fixture',
      token_endpoint: 'https://provider.fixture.invalid/token', expires_at: 0 });
    f.fetch.mockImplementationOnce(async () => {
      controller.abort(); return new Response(null, { status: 307, headers: { location: '/renewed-token' } });
    });
    f.api.observeAccess = observeAccess;
    const executor = createServerExecutor(f.deps.executorConfig);
    await expect(withRunAbortContext({ signal: controller.signal }, () => executor(f.manifest.slug, {})))
      .rejects.toMatchObject({ code: 'run_killed' });
    expect(f.fetch).toHaveBeenCalledOnce(); expect(observeAccess).not.toHaveBeenCalled();
  });

  it('discards legacy initialization when cancellation prevents its required notification', async () => {
    const f = fixture('mcp'); const controller = new AbortController(); let stopInitialize = true;
    f.connections.upsert({ ...f.connections.get('mcp', 'fixture')!, config_json: JSON.stringify({
      transport: 'websocket', endpoint: 'wss://provider.fixture.invalid/mcp' }) });
    const streams: McpStreamHandle[] = [];
    f.mcp.wsConnect = vi.fn(async () => {
      let message: ((data: string) => void) | undefined; let initialized = false;
      const stream: McpStreamHandle = {
        send(data) {
          const frame = JSON.parse(data) as { id?: number; method: string };
          if (frame.method === 'notifications/initialized') { initialized = true; return; }
          const envelope = frame.method === 'server/discover'
            ? { error: { code: -32601, message: 'Method not found' } }
            : { result: frame.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {} }
              : initialized ? { value: 'ok' } : { isError: true } };
          queueMicrotask(() => {
            if (frame.method === 'initialize' && stopInitialize) { stopInitialize = false; controller.abort(); }
            message?.(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...envelope }));
          });
        }, onMessage: listener => { message = listener; }, onClose: () => {}, onError: () => {}, close: vi.fn(),
      };
      streams.push(stream); return stream;
    });
    const executor = createServerExecutor(f.deps.executorConfig);
    await expect(withRunAbortContext({ signal: controller.signal }, () => executor(f.manifest.slug, {})))
      .rejects.toMatchObject({ code: 'run_killed' });
    expect(streams).toHaveLength(2);
    for (const stream of streams) expect(stream.close).toHaveBeenCalledOnce();
    await expect(withRunAbortContext({ signal: new AbortController().signal }, () => executor(f.manifest.slug, {})))
      .resolves.toMatchObject({ status: 'ok' });
    expect(streams).toHaveLength(4);
  });

  it('refuses mail when its last host callback stops the run before send', async () => {
    const send = vi.fn(async () => ({ source_id: 'sent', message_id: '<sent@fixture.invalid>', sent_at: Date.now() }));
    const provider: MailProvider = { kind: 'imap', slug: 'work', sendCapable: true, mutationCapable: false, accountEmail: 'owner@fixture.invalid',
      connect: async () => {}, initialScan: async () => {}, startSync: async () => async () => {}, close: async () => {},
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }), send };
    const f = await resourceFixture(undefined, { mailProvider: provider }); const controller = new AbortController();
    await expect(withRunAbortContext({ signal: controller.signal }, () => f.mail!.collection.send({
      to: ['recipient@fixture.invalid'], subject: 'Fixture', body_text: 'Hello', reconciliation_id: 'handoff-fixture',
      before_dispatch: () => controller.abort(),
    }))).rejects.toMatchObject({ code: 'run_killed' });
    expect(send).not.toHaveBeenCalled();
    expect(createMailSendClaimStore(f.db).get('handoff-fixture')).toMatchObject({ status: 'not_sent' });
  });

  it('records mail as not sent when the ordinary run guard refuses after claiming', async () => {
    const send = vi.fn(async () => ({ source_id: 'sent', message_id: '<sent@fixture.invalid>', sent_at: Date.now() }));
    const provider: MailProvider = { kind: 'imap', slug: 'work', sendCapable: true, mutationCapable: false, accountEmail: 'owner@fixture.invalid',
      connect: async () => {}, initialScan: async () => {}, startSync: async () => async () => {}, close: async () => {},
      health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }), send };
    const f = await resourceFixture(undefined, { mailProvider: provider }); const controller = new AbortController();
    await expect(withRunAbortContext({ signal: controller.signal }, () => withPreapprovalOrdinaryGuard(() => {
      if (controller.signal.aborted) throw new IngredientError('run_killed', 'The enclosing run stopped.');
    }, () => f.mail!.collection.send({
      to: ['recipient@fixture.invalid'], subject: 'Fixture', body_text: 'Hello', reconciliation_id: 'ordinary-handoff-fixture',
      before_dispatch: () => controller.abort(),
    })))).rejects.toMatchObject({ code: 'run_killed' });
    expect(send).not.toHaveBeenCalled();
    expect(createMailSendClaimStore(f.db).get('ordinary-handoff-fixture')).toMatchObject({ status: 'not_sent' });
  });

  it.each([false, true])('fences the final embeddings handoff with cancellation during configuration %s', async stopped => {
    const f = fixture('ai'); const controller = new AbortController();
    f.deps.executorConfig.manifests.register({ ...f.manifest, slug: 'ai-embed', input: {}, output: { vector: 'vector' } });
    const config: LLMConfig = { embeddings_slot: { provider: 'openai', model: 'text-embedding-3-small', api_key: 'fixture' } };
    f.deps.executorConfig.resolveLlmConfig = () => { if (stopped) controller.abort(); return config; };
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [0.25, 0.5] }], model: 'text-embedding-3-small',
      usage: { prompt_tokens: 1, total_tokens: 1 } }), { headers: { 'content-type': 'application/json' } }));
    const executor = createServerExecutor(f.deps.executorConfig);
    const execution = withRunAbortContext({ signal: controller.signal }, () => executor('ai-embed', { 'llm.data': 'hello' }));
    if (stopped) {
      await expect(execution).rejects.toMatchObject({ code: 'run_killed' }); expect(f.fetch).not.toHaveBeenCalled();
    } else {
      await expect(execution).resolves.toMatchObject({ vector: [0.25, 0.5] }); expect(f.fetch).toHaveBeenCalledOnce();
    }
  });
});
