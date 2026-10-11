/** D-321 slice 3 — `packs.tool_status`: whether each installed pack's programs
 *  are ready on this server, for the pack list's badge and the pack page's
 *  Programs block.
 *
 *  Against the REAL contract store (installed-pack rows, the owner's choices)
 *  and the REAL readiness service, with stub tools that count their runs, so
 *  "never run" is a fact about the folder. The last block goes through the real
 *  `createServerHandlerSet` → WebSocket dispatch, because a deps family the
 *  server config does not forward answers `not_configured` in production while
 *  every direct handler test passes (`server.ts` records seven such). POSIX only
 *  (the stubs are shell scripts). */

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  D165_CONTRACT_SCHEMA,
  OWNER_TOOL_VERSION_SCOPE,
  RpcError,
  cliToolVersionHash,
  type CliInstallHint,
  type CliToolVersionPolicy,
  type IngredientManifest,
} from '@recued/contracts';

import { createCliToolStatus, type CliToolStatus } from '../cli-tool-status.js';
import { handlePacksToolStatus, type PackToolStatusRpcDeps } from '../pack-tool-status-handler.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { createServerHandlerSet, type ServerConfig } from '../index.js';

const NOW = 1_760_000_000_000;
const RANGE = { from: '1.18.35', before: '2.0.0' };
const REFUSE: CliToolVersionPolicy = { tested: RANGE, outside: 'refuse' };
const HINTS: CliInstallHint[] = [
  { manager: 'brew', package: 'opencode' },
  { manager: 'npm', package: 'opencode-ai' },
  { manager: 'winget', package: 'SST.opencode' },
  { docs: 'https://opencode.ai/docs' },
];

const dbs: Database.Database[] = [];
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const makeStore = (): ContractStore => {
  const db = new Database(':memory:');
  dbs.push(db);
  const store = createContractStore(db, { now: () => NOW });
  store.seedSchema(D165_CONTRACT_SCHEMA);
  return store;
};

const install = (store: ContractStore, slug: string, catalogs: string[], authored?: string): void => {
  store.put('installed_pack', [slug], {
    pack_slug: slug,
    version: '1',
    installed_at: NOW,
    ingredient_ids: catalogs,
    ...(authored !== undefined ? { authored_pack_slug: authored } : {}),
  });
};

/** A stub tool answering `--version` with `reply`, counting each run in `runs`. */
const stub = (reply: string): { path: string; dir: string } => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'recued-d321-ts-')));
  dirs.push(dir);
  const path = join(dir, 'opencode');
  writeFileSync(path, `#!/bin/sh\necho run >> "${dir}/runs"\n${reply}\n`);
  chmodSync(path, 0o755);
  return { path, dir };
};
const runs = (dir: string): number =>
  existsSync(join(dir, 'runs')) ? readFileSync(join(dir, 'runs'), 'utf8').split('\n').filter(Boolean).length : 0;

const lifecycle = {
  auth: { method: 'none' },
  connect: { idempotent: true, startup_timeout_ms: 30_000 },
  invoke: { default_method_timeout_ms: 30_000 },
  disconnect: { graceful_shutdown_timeout_ms: 30_000 },
  reconnect_policy: 'manual_only',
  persistent_connection: false,
  idle_disconnect_ms: 0,
};

/** A cli catalog running `binary`, with a range and hints when given. */
const cliCatalog = (
  slug: string,
  binary: string,
  extra: { version?: CliToolVersionPolicy; install?: unknown[]; probe?: string[] } = {},
): IngredientManifest => ({
  slug,
  name: slug,
  description: '',
  author: 'recued-core',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { task: { operation_id: `${slug}.task`, risk_tier: 'read', groups: ['g'] } },
  surfaces: {
    connector: {
      runtime: {
        transport: 'stdio',
        wire_protocol: 'cli_invocation',
        package_ref: `system_binary:${binary}`,
        entry_point: binary,
        expected_protocol_version: 1,
        ...(extra.version !== undefined
          ? { cli_probe: extra.probe ?? [binary, '--version'], cli_version: extra.version }
          : {}),
        ...(extra.install !== undefined ? { cli_install: extra.install } : {}),
      },
      lifecycle,
      executes: {
        task: { kind: 'cli_invocation', argv_template: [binary, 'run'], stdin_handling: 'none', shape: 'text', exit_code_handling: 'zero_is_success' },
      },
    },
  },
} as unknown as IngredientManifest);

const apiCatalog = (slug: string): IngredientManifest => ({
  slug,
  name: slug,
  description: '',
  author: 'recued-core',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { list: { operation_id: `${slug}.list`, risk_tier: 'read', groups: ['g'] } },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.example.com',
      auth: { kind: 'none' },
      executes: { list: { kind: 'rest', method: 'GET', path_template: '/x' } },
    },
  },
} as unknown as IngredientManifest);

const depsFor = (
  store: ContractStore,
  manifests: IngredientManifest[],
  over: Partial<PackToolStatusRpcDeps> = {},
): PackToolStatusRpcDeps => {
  const bySlug = new Map(manifests.map((m) => [m.slug, m]));
  return {
    getContractStore: () => store,
    getManifest: (slug) => bySlug.get(slug) ?? null,
    toolStatus: createCliToolStatus(),
    platform: 'darwin',
    ...over,
  };
};

describe.skipIf(process.platform === 'win32')('D-321 — packs.tool_status', () => {
  it('a tool in its tested range is ready, with its version, the range, the setting and the install commands', async () => {
    const { path } = stub('echo 1.18.35');
    const store = makeStore();
    install(store, 'opencode-pack', ['recued-core/opencode']);
    const result = await handlePacksToolStatus(
      depsFor(store, [cliCatalog('recued-core/opencode', path, { version: REFUSE, install: HINTS })]),
      undefined,
    );
    expect(result.system).toBe('macos');
    expect(result.packs).toHaveLength(1);
    const [tool] = result.packs[0]!.tools;
    expect(result.packs[0]!.slug).toBe('opencode-pack');
    expect(tool).toEqual({
      catalog: 'recued-core/opencode',
      binary: path,
      state: 'ready',
      version: '1.18.35',
      checked_at: expect.any(Number),
      tested: RANGE,
      outside: 'refuse',
      pack_outside: 'refuse',
      // macOS: brew and npm (asking for the tested major), never winget.
      install: ['brew install opencode', 'npm install -g opencode-ai@1'],
      docs: ['https://opencode.ai/docs'],
    });
  });

  it("a version outside the range is untested; the owner's choice applies only while its stamp matches", async () => {
    const { path } = stub('echo 2.0.1');
    const store = makeStore();
    install(store, 'opencode-pack', ['recued-core/opencode']);
    const deps = depsFor(store, [cliCatalog('recued-core/opencode', path, { version: REFUSE })]);
    const tool = async () => (await handlePacksToolStatus(deps, { pack_slug: 'opencode-pack' })).packs[0]!.tools[0]!;

    expect(await tool()).toMatchObject({ state: 'untested', version: '2.0.1', outside: 'refuse' });
    expect((await tool()).owner_outside).toBeUndefined();

    store.put(OWNER_TOOL_VERSION_SCOPE, ['recued-core/opencode'], { outside: 'warn', version_hash: cliToolVersionHash(REFUSE) });
    expect(await tool()).toMatchObject({ outside: 'warn', pack_outside: 'refuse', owner_outside: 'warn' });
    expect((await tool()).stale_owner_choice).toBeUndefined();

    const older: CliToolVersionPolicy = { tested: { from: '1.15.13', before: '2.0.0' }, outside: 'refuse' };
    store.put(OWNER_TOOL_VERSION_SCOPE, ['recued-core/opencode'], { outside: 'warn', version_hash: cliToolVersionHash(older) });
    expect(await tool()).toMatchObject({ outside: 'refuse', owner_outside: 'warn', stale_owner_choice: true });
  });

  it('a broken tool says why: the line it printed when a signal stopped it', async () => {
    const { path } = stub('echo "dyld: Library not loaded: /opt/x.dylib" >&2\nkill -ABRT $$');
    const store = makeStore();
    install(store, 'ffmpeg-pack', ['recued-core/ffmpeg']);
    const result = await handlePacksToolStatus(
      depsFor(store, [cliCatalog('recued-core/ffmpeg', path, { version: { tested: { from: '7.0' }, outside: 'warn' } })]),
      undefined,
    );
    expect(result.packs[0]!.tools[0]).toMatchObject({ state: 'broken', detail: 'dyld: Library not loaded: /opt/x.dylib' });
  });

  it('an unreadable version says what the probe did', async () => {
    const { path } = stub('echo "no config file" >&2; exit 1');
    const store = makeStore();
    install(store, 'opencode-pack', ['recued-core/opencode']);
    const result = await handlePacksToolStatus(
      depsFor(store, [cliCatalog('recued-core/opencode', path, { version: REFUSE })]),
      undefined,
    );
    expect(result.packs[0]!.tools[0]).toMatchObject({
      state: 'unreadable',
      detail: `'${path} --version' exited with code 1 (no config file)`,
    });
  });

  it('a tool whose pack declares no range is looked up on PATH and never run', async () => {
    const present = stub('echo 9.9.9');
    const store = makeStore();
    install(store, 'tools-pack', ['recued-core/present', 'recued-core/absent']);
    const absent = join(present.dir, 'not-there');
    const result = await handlePacksToolStatus(
      depsFor(store, [
        cliCatalog('recued-core/present', present.path, { install: [{ manager: 'npm', package: 'present-tool' }] }),
        cliCatalog('recued-core/absent', absent),
      ]),
      undefined,
    );
    expect(result.packs[0]!.tools).toEqual([
      { catalog: 'recued-core/present', binary: present.path, state: 'ready', install: ['npm install -g present-tool'], docs: [] },
      { catalog: 'recued-core/absent', binary: absent, state: 'missing', install: [], docs: [] },
    ]);
    expect(runs(present.dir)).toBe(0);
  });

  it('"Check again" probes again; without it the cached read answers', async () => {
    const { path, dir } = stub('echo 1.18.35');
    const store = makeStore();
    install(store, 'opencode-pack', ['recued-core/opencode']);
    const deps = depsFor(store, [cliCatalog('recued-core/opencode', path, { version: REFUSE })]);
    await handlePacksToolStatus(deps, {});
    await handlePacksToolStatus(deps, { pack_slug: 'opencode-pack' });
    expect(runs(dir)).toBe(1);
    await handlePacksToolStatus(deps, { pack_slug: 'opencode-pack', recheck: true });
    expect(runs(dir)).toBe(2);
  });

  it('the install commands are written for the server, and a hint that does not pass is never shown', async () => {
    const store = makeStore();
    install(store, 'opencode-pack', ['recued-core/opencode']);
    const hints = [
      ...HINTS,
      { manager: 'apt', package: 'opencode' },
      // A catalog an older server stored was never checked: none of these may reach the owner.
      { manager: 'curl', package: 'https://example.com/install.sh' },
      { manager: 'npm', package: '; rm -rf ~' },
      { manager: 'npm', package: '--global-style' },
      { docs: 'http://example.com/not-https' },
      { docs: 'https://user:secret@example.com/docs' },
    ];
    const toolOn = async (platform: NodeJS.Platform) => (await handlePacksToolStatus(
      depsFor(store, [cliCatalog('recued-core/opencode', '/nonexistent/opencode', { install: hints })], { platform }),
      undefined,
    )).packs[0]!.tools[0]!;
    expect((await toolOn('linux')).install).toEqual(['brew install opencode', 'npm install -g opencode-ai', 'sudo apt install opencode']);
    // npm's Windows install is a `.cmd` script no action can start (D-321 audit).
    expect((await toolOn('win32')).install).toEqual(['winget install SST.opencode']);
    expect((await toolOn('darwin')).docs).toEqual(['https://opencode.ai/docs']);
  });

  it('one tool that cannot be read leaves the other packs whole (D-321 audit)', async () => {
    const store = makeStore();
    install(store, 'broken-pack', ['recued-core/broken']);
    install(store, 'opencode-pack', ['recued-core/opencode']);
    const real = createCliToolStatus();
    const toolStatus: CliToolStatus = {
      check: async (request) => {
        if (request.probe[0] === '/nonexistent/broken') throw new Error('store went away');
        return real.check(request);
      },
      forget: (binary) => real.forget(binary),
    };
    const result = await handlePacksToolStatus(depsFor(store, [
      cliCatalog('recued-core/broken', '/nonexistent/broken', { version: REFUSE }),
      cliCatalog('recued-core/opencode', '/nonexistent/opencode', { version: REFUSE }),
    ], { toolStatus }), undefined);
    expect(result.packs.map((p) => p.slug)).toEqual(['opencode-pack']);
  });

  it('a stored catalog whose values are not what they should be is read as declaring none', async () => {
    const store = makeStore();
    install(store, 'odd-pack', ['recued-core/odd']);
    const odd = cliCatalog('recued-core/odd', '/nonexistent/odd');
    Object.assign((odd.surfaces!.connector as unknown as { runtime: Record<string, unknown> }).runtime, {
      cli_version: { tested: {} },
      cli_probe: '/nonexistent/odd --version',
      cli_install: 'npm install -g evil',
    });
    const result = await handlePacksToolStatus(depsFor(store, [odd]), undefined);
    expect(result.packs[0]!.tools[0]).toMatchObject({ state: 'missing', install: [], docs: [] });
    expect(result.packs[0]!.tools[0]).not.toHaveProperty('tested');
  });

  it('reads every pack at once, not one after another', async () => {
    const store = makeStore();
    const slugs = ['a', 'b', 'c'];
    for (const slug of slugs) install(store, `${slug}-pack`, [`recued-core/${slug}`]);
    const toolStatus: CliToolStatus = {
      check: async (request) => {
        await new Promise((done) => setTimeout(done, 300));
        return { state: 'ready', binary: request.probe[0]!, probe_result: { kind: 'version', version: '1.18.35' }, checked_at: NOW };
      },
      forget: () => undefined,
    };
    const started = Date.now();
    const result = await handlePacksToolStatus(depsFor(store, slugs.map((slug) =>
      cliCatalog(`recued-core/${slug}`, `/nonexistent/${slug}`, { version: REFUSE })), { toolStatus }), undefined);
    expect(result.packs).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(800);
  });

  it('one pack by its page slug (the authored one, for a pack keyed by another)', async () => {
    const { path } = stub('echo 1.18.35');
    const store = makeStore();
    install(store, 'opencode-pack', ['recued-core/opencode']);
    install(store, 'records-abc123', ['recued-core/booktool'], 'invoice-book');
    const deps = depsFor(store, [
      cliCatalog('recued-core/opencode', path, { version: REFUSE }),
      cliCatalog('recued-core/booktool', '/nonexistent/booktool'),
    ]);
    expect((await handlePacksToolStatus(deps, {})).packs.map((p) => p.slug)).toEqual(['opencode-pack', 'invoice-book']);
    expect((await handlePacksToolStatus(deps, { pack_slug: 'invoice-book' })).packs.map((p) => p.slug)).toEqual(['invoice-book']);
    expect((await handlePacksToolStatus(deps, { pack_slug: 'nothing-like-it' })).packs).toEqual([]);
  });

  it('a pack that runs no program is left out, and so is one whose catalog is gone', async () => {
    const store = makeStore();
    install(store, 'github', ['recued-core/github']);
    install(store, 'gone-pack', ['recued-core/gone']);
    const result = await handlePacksToolStatus(depsFor(store, [apiCatalog('recued-core/github')]), undefined);
    expect(result.packs).toEqual([]);
  });

  it('a probe naming another program than the pack runs is never run', async () => {
    const tool = stub('echo 1.18.35');
    const other = stub('echo 1.18.35');
    const store = makeStore();
    install(store, 'opencode-pack', ['recued-core/opencode']);
    const result = await handlePacksToolStatus(
      depsFor(store, [cliCatalog('recued-core/opencode', tool.path, { version: REFUSE, probe: [other.path, '--version'] })]),
      undefined,
    );
    expect(result.packs[0]!.tools[0]).toMatchObject({
      state: 'unreadable',
      detail: `its pack's version check '${other.path} --version' is not one Recued runs, because it may only ask ${tool.path} for its version`,
    });
    expect(runs(other.dir)).toBe(0);
  });

  it('no contract store: no packs, never an error', async () => {
    const result = await handlePacksToolStatus(
      { getContractStore: () => undefined, getManifest: () => null, toolStatus: createCliToolStatus(), platform: 'linux' },
      undefined,
    );
    expect(result).toEqual({ system: 'linux', packs: [] });
  });

  it.each([
    ['args that are not an object', 'opencode-pack'],
    ['an empty pack slug', { pack_slug: '' }],
    ['a recheck that is not true or false', { recheck: 'yes' }],
  ])('refuses %s', async (_label, args) => {
    const outcome = await handlePacksToolStatus(depsFor(makeStore(), []), args).then(() => 'answered', (e: unknown) => e);
    expect(outcome).toBeInstanceOf(RpcError);
    expect((outcome as RpcError).code).toBe('bad_request');
  });
});

// ── through the real server wiring ──────────────────────────────────────────

class MemorySocket extends Duplex {
  peer: MemorySocket | undefined;
  remoteAddress = '127.0.0.1';
  remotePort = 12345;
  localAddress = '127.0.0.1';
  localPort = 80;
  _read(): void {}
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.peer && !this.peer.destroyed) this.peer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
  _final(callback: (error?: Error | null) => void): void {
    if (this.peer && !this.peer.destroyed) this.peer.push(null);
    callback();
  }
  setTimeout(): this { return this; }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
}

const connectWs = (httpServer: HttpServer): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1/ws?token=test-realm', {
      createConnection: () => {
        const client = new MemorySocket();
        const server = new MemorySocket();
        client.peer = server;
        server.peer = client;
        process.nextTick(() => httpServer.emit('connection', server as unknown as Socket));
        return client as unknown as Socket;
      },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

const callRpc = (ws: WebSocket, method: string, args: unknown): Promise<{ result?: unknown; error?: { code: string } }> =>
  new Promise((resolve, reject) => {
    const request_id = `req-${randomUUID()}`;
    const timeout = setTimeout(() => reject(new Error('rpc timeout')), 5_000);
    const onMessage = (data: WebSocket.RawData): void => {
      const msg = JSON.parse(data.toString()) as { type?: string; request_id?: string; result?: unknown; error?: { code: string } };
      if (msg.type !== 'rpc_result' || msg.request_id !== request_id) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve({ ...(msg.result !== undefined ? { result: msg.result } : {}), ...(msg.error !== undefined ? { error: msg.error } : {}) });
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
  });

const rpcThroughServer = async (config: ServerConfig, method: string, args: unknown) => {
  const handlerSet = createServerHandlerSet(config);
  const httpServer = createHttpServer();
  const upgrade = handlerSet.upgradeHandlers.ws;
  if (upgrade === undefined) throw new Error('no ws upgrade handler');
  httpServer.on('upgrade', upgrade);
  handlerSet.wsHandle.maxInstances = 0;
  const ws = await connectWs(httpServer);
  closers.push(async () => {
    ws.terminate();
    handlerSet.close();
    httpServer.removeAllListeners();
  });
  return callRpc(ws, method, args);
};

describe.skipIf(process.platform === 'win32')('through createServerHandlerSet to real WebSocket dispatch', () => {
  it('packs.tool_status answers when its deps are composed', async () => {
    const { path } = stub('echo 1.18.35');
    const store = makeStore();
    install(store, 'opencode-pack', ['recued-core/opencode']);
    const reply = await rpcThroughServer(
      { packToolStatusDeps: depsFor(store, [cliCatalog('recued-core/opencode', path, { version: REFUSE })]) } as ServerConfig,
      'packs.tool_status',
      { pack_slug: 'opencode-pack' },
    );
    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({ packs: [{ slug: 'opencode-pack', tools: [{ state: 'ready', version: '1.18.35' }] }] });
  });

  it('packs.unrunnable answers too (D-259: its deps were composed and never forwarded)', async () => {
    const reply = await rpcThroughServer(
      { packUnrunnableDeps: { listManifests: () => [] } } as ServerConfig,
      'packs.unrunnable',
      undefined,
    );
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ findings: [], exact_pack_identities: true });
  });
});
