/** D-321 — where the owner set a cli pack's program: the rpc that writes it,
 *  the row it writes, and that row deciding a real run (`owner-tool-path.ts`;
 *  internal design notes § 2.1). A server started at login has a short
 *  PATH, and a clone or a hand-written service never ran the installer that
 *  would give it the owner's; a location set per program is the fix that works
 *  however Recued was installed.
 *
 *  Against the REAL contract store (SQLite in memory, seeded with the shipped
 *  schema), so the row's shape is held by the store's own write validation. */

import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  D165_CONTRACT_SCHEMA,
  OWNER_TOOL_PATH_SCOPE,
  RpcError,
  isReservedLocalRpc,
  type IngredientManifest,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import { makeContractHandlers, type ContractRpcDeps } from '../contract-handler.js';
import { composeExecuteDeps, type ComposeExecuteDepsDeps } from '../composition/bin/wire-execute-deps.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';

const NOW = 1_760_000_000_000;
const RPC_CTX = undefined as unknown as never;
const PROGRAM = 'recued-d321-located';
const CATALOG = 'recued-core/located';
const API = 'recued-core/github';

const lifecycle = {
  auth: { method: 'none' },
  connect: { idempotent: true, startup_timeout_ms: 30_000 },
  invoke: { default_method_timeout_ms: 30_000 },
  disconnect: { graceful_shutdown_timeout_ms: 30_000 },
  reconnect_policy: 'manual_only',
  persistent_connection: false,
  idle_disconnect_ms: 0,
};

const cliCatalog = (slug: string, binary: string): IngredientManifest => ({
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
      },
      lifecycle,
      executes: {
        task: { kind: 'cli_invocation', argv_template: [binary, 'run'], stdin_handling: 'none', shape: 'text', exit_code_handling: 'zero_is_success' },
      },
    },
  },
} as unknown as IngredientManifest);

const apiCatalog = {
  slug: API,
  name: API,
  description: '',
  author: 'recued-core',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { list: { operation_id: `${API}.list`, risk_tier: 'read', groups: ['g'] } },
  surfaces: { api: { transport: 'rest', default_base_url: 'https://api.example.com', auth: { kind: 'none' }, executes: {} } },
} as unknown as IngredientManifest;

const MANIFESTS = new Map<string, IngredientManifest>([
  [CATALOG, cliCatalog(CATALOG, PROGRAM)],
  [API, apiCatalog],
]);

const dbs: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
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

interface LoggedActivity { action: string; target: string; timestamp: number; detail: string }

const harness = (manifests: Map<string, IngredientManifest>) => {
  const store = makeStore();
  const audits: LoggedActivity[] = [];
  const auditLog = { logActivity: async (entry: LoggedActivity) => { audits.push(entry); } } as unknown as AuditLogStore;
  const deps: ContractRpcDeps = {
    store,
    getManifest: (slug) => manifests.get(slug) ?? null,
    listManifests: () => [...manifests.values()],
    auditLog,
    now: () => NOW,
  };
  const slice = makeContractHandlers(deps);
  if (!slice) throw new Error('no contract handler slice');
  const upsert = (args: unknown) => slice.handlers['collection.operation.upsertOwnerToolPath'](
    args as Parameters<typeof slice.handlers['collection.operation.upsertOwnerToolPath']>[0], RPC_CTX);
  const remove = (args: unknown) => slice.handlers['collection.operation.deleteOwnerToolPath'](
    args as Parameters<typeof slice.handlers['collection.operation.deleteOwnerToolPath']>[0], RPC_CTX);
  return { store, audits, upsert, remove, methods: slice.methods };
};

/** A folder outside every PATH holding the program, which acts by leaving `ran`.
 *  Its first line names an interpreter by name that sits beside it, as nvm puts
 *  `node` beside an npm tool, so it starts only if its folder is on the PATH. */
const programFolder = (): { dir: string; path: string } => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'recued-d321-located-')));
  dirs.push(dir);
  const interpreter = join(dir, 'recued-d321-interp');
  writeFileSync(interpreter, '#!/bin/sh\nexec /bin/sh "$@"\n');
  chmodSync(interpreter, 0o755);
  const path = join(dir, PROGRAM);
  writeFileSync(path, `#!/usr/bin/env recued-d321-interp\ntouch "${dir}/ran"\n`);
  chmodSync(path, 0o755);
  return { dir, path };
};

describe.skipIf(process.platform === 'win32')('D-321 — collection.operation.upsertOwnerToolPath', () => {
  it('stores the file stamped with the program the pack launches, and audits it', async () => {
    const { path } = programFolder();
    const { store, audits, upsert } = harness(MANIFESTS);
    expect(await upsert({ ingredient_id: CATALOG, path })).toEqual({
      ingredient_id: CATALOG, binary: PROGRAM, path, written_at: NOW,
    });
    expect(store.get(OWNER_TOOL_PATH_SCOPE, [CATALOG])?.value).toEqual({ binary: PROGRAM, path });
    expect(audits[0]).toMatchObject({ action: 'owner_tool_path_written', target: CATALOG, timestamp: NOW });
    expect(JSON.parse(audits[0]!.detail)).toEqual({ ingredient_id: CATALOG, binary: PROGRAM, path, prior: null });
  });

  it.each([
    ['a catalog that runs no program', () => ({ ingredient_id: API, path: '/usr/bin/true' }), `'${API}' runs no program`],
    ['a path that is not a full one', () => ({ ingredient_id: CATALOG, path: `bin/${PROGRAM}` }), 'must be a full path'],
    ['a file named for another program', () => ({ ingredient_id: CATALOG, path: '/bin/sh' }), `must be a file named ${PROGRAM}`],
    ['a file nothing can run', () => ({ ingredient_id: CATALOG, path: `/nonexistent-recued/${PROGRAM}` }), 'no program the server can run'],
    ['no path', () => ({ ingredient_id: CATALOG }), 'path is required'],
  ])('refuses %s, and writes nothing', async (_label, args, message) => {
    const { store, audits, upsert } = harness(MANIFESTS);
    const outcome = await upsert(args()).then(() => 'written', (e: unknown) => e);
    expect(outcome).toBeInstanceOf(RpcError);
    expect((outcome as RpcError).code).toBe('bad_request');
    expect((outcome as RpcError).message).toContain(message);
    expect(store.scan(OWNER_TOOL_PATH_SCOPE)).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe('D-321 — collection.operation.deleteOwnerToolPath', () => {
  it('clears a location, even one whose pack is gone; clearing nothing is not an error', async () => {
    const gone = harness(new Map());
    gone.store.put(OWNER_TOOL_PATH_SCOPE, [CATALOG], { binary: PROGRAM, path: `/opt/x/${PROGRAM}` });
    expect(await gone.remove({ ingredient_id: CATALOG })).toEqual({ deleted: true });
    expect(gone.store.get(OWNER_TOOL_PATH_SCOPE, [CATALOG])).toBeNull();
    expect(gone.audits[0]).toMatchObject({ action: 'owner_tool_path_deleted', target: CATALOG });
    expect(await gone.remove({ ingredient_id: CATALOG })).toEqual({ deleted: false });
    expect(gone.audits).toHaveLength(1);
  });

  it("both methods are the local owner's only: an MCP agent can neither set nor clear a location", () => {
    const { methods } = harness(MANIFESTS);
    for (const method of ['collection.operation.upsertOwnerToolPath', 'collection.operation.deleteOwnerToolPath'] as const) {
      expect(methods).toContain(method);
      expect(isReservedLocalRpc(method)).toBe(true);
    }
  });
});

describe.skipIf(process.platform === 'win32')('D-321 — the location decides a real run', () => {
  /** ⛔ THE JOIN, through the server's own composition (`composeExecuteDeps`)
   *  given the contract store the rpc writes: a test that handed the executor
   *  its owner read by hand would say nothing about whether the server wires it. */
  it("runs the set file, with its folder on the program's PATH, and names the location once it is gone", async () => {
    vi.stubEnv('PATH', '/usr/bin:/bin');
    const { dir, path } = programFolder();
    const { upsert, store } = harness(MANIFESTS);
    const bundle = composeExecuteDeps({
      recipeStore: { get: vi.fn(() => null), ids: vi.fn(() => []) },
      executorConfig: { manifests: {} },
      baseVault: {},
      serverInstanceId: 'server-1',
      serverDisplayName: 'Server One',
      eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn(), emit: vi.fn(), replay: vi.fn(() => []) },
      getExecuteDeps: vi.fn(() => undefined),
      contractStore: store,
    } as unknown as ComposeExecuteDepsDeps);
    const exec = bundle.executeDeps.cliInvocationExecutor;
    if (exec === undefined) throw new Error('composeExecuteDeps wired no cli executor');
    const call = {
      slug: CATALOG,
      operation_key: 'task',
      operation_id: `${CATALOG}.task`,
      args: {},
      timeout_ms: 5_000,
      binding: { kind: 'cli_invocation', argv_template: [PROGRAM, 'run'], shape: 'text', exit_code_handling: 'zero_is_success' },
    } as unknown as Parameters<typeof exec>[0];
    const failure = (): Promise<{ reason?: string; message: string }> => exec(call).then(
      () => ({ message: 'ran' }),
      (e: { cli_failure?: { reason: string }; message: string }) => ({ reason: e.cli_failure?.reason, message: e.message }),
    );

    expect((await failure()).reason).toBe('not_found');
    expect(existsSync(join(dir, 'ran'))).toBe(false);

    await upsert({ ingredient_id: CATALOG, path });
    await exec(call);
    expect(existsSync(join(dir, 'ran'))).toBe(true);

    rmSync(path);
    const gone = await failure();
    expect(gone.reason).toBe('not_found');
    expect(gone.message).toContain(`The owner set its location to ${path} on the pack's page`);
  });

  /** D-346 — a Kitchen copy (D-333) runs the original's program from a catalog of
   *  its own (`<catalog>-copy`). With no location of its own it runs from the one
   *  set for the original, and the run's check before any step reads the same. */
  it("a copy of the pack runs from the original's location, and its own wins once set", async () => {
    vi.stubEnv('PATH', '/usr/bin:/bin');
    const { dir, path } = programFolder();
    const { upsert, store } = harness(MANIFESTS);
    const bundle = composeExecuteDeps({
      recipeStore: { get: vi.fn(() => null), ids: vi.fn(() => []) },
      executorConfig: { manifests: {} },
      baseVault: {},
      serverInstanceId: 'server-1',
      serverDisplayName: 'Server One',
      eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn(), emit: vi.fn(), replay: vi.fn(() => []) },
      getExecuteDeps: vi.fn(() => undefined),
      contractStore: store,
    } as unknown as ComposeExecuteDepsDeps);
    const exec = bundle.executeDeps.cliInvocationExecutor;
    const present = bundle.executeDeps.programPresence;
    if (exec === undefined || present === undefined) throw new Error('composeExecuteDeps wired no cli executor or program check');
    const COPY = `${CATALOG}-copy`;
    const call = {
      slug: COPY,
      operation_key: 'task',
      operation_id: `${COPY}.task`,
      args: {},
      timeout_ms: 5_000,
      binding: { kind: 'cli_invocation', argv_template: [PROGRAM, 'run'], shape: 'text', exit_code_handling: 'zero_is_success' },
    } as unknown as Parameters<typeof exec>[0];

    expect(present(COPY, PROGRAM)).toBe(false);
    await expect(exec(call)).rejects.toMatchObject({ cli_failure: { reason: 'not_found' } });

    await upsert({ ingredient_id: CATALOG, path });
    expect(present(COPY, PROGRAM)).toBe(true);
    await exec(call);
    expect(existsSync(join(dir, 'ran'))).toBe(true);

    // The copy's own location wins over the original's.
    rmSync(join(dir, 'ran'));
    const mine = programFolder();
    store.put(OWNER_TOOL_PATH_SCOPE, [COPY], { binary: PROGRAM, path: mine.path });
    await exec(call);
    expect(existsSync(join(mine.dir, 'ran'))).toBe(true);
    expect(existsSync(join(dir, 'ran'))).toBe(false);
  });
});
