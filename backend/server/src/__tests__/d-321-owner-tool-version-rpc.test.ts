/** D-321 slice 2 — the owner's per-tool choice: the rpc that writes it, the row
 *  it writes, and that row deciding a real run.
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
  OWNER_TOOL_VERSION_SCOPE,
  RpcError,
  cliToolVersionHash,
  isReservedLocalRpc,
  type CliToolVersionPolicy,
  type IngredientManifest,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import { makeContractHandlers, type ContractRpcDeps } from '../contract-handler.js';
import { createCliInvocationExecutor } from '../cli-invocation-executor.js';
import { createCliToolStatus } from '../cli-tool-status.js';
import { composeExecuteDeps, type ComposeExecuteDepsDeps } from '../composition/bin/wire-execute-deps.js';
import { ContractWriteInvalidError, createContractStore, type ContractStore } from '../storage/contract-store.js';

const NOW = 1_760_000_000_000;
const RPC_CTX = undefined as unknown as never;
const OPENCODE = 'recued-core/opencode';
const NO_RANGE = 'recued-core/ffmpeg';
const API = 'recued-core/github';
const REFUSE: CliToolVersionPolicy = { tested: { from: '1.18.35', before: '2.0.0' }, outside: 'refuse' };

const lifecycle = {
  auth: { method: 'none' },
  connect: { idempotent: true, startup_timeout_ms: 30_000 },
  invoke: { default_method_timeout_ms: 30_000 },
  disconnect: { graceful_shutdown_timeout_ms: 30_000 },
  reconnect_policy: 'manual_only',
  persistent_connection: false,
  idle_disconnect_ms: 0,
};

/** A cli catalog, with a tested range when `version` is given. */
const cliCatalog = (slug: string, binary: string, version?: CliToolVersionPolicy): IngredientManifest => ({
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
        ...(version !== undefined ? { cli_probe: [binary, '--version'], cli_version: version } : {}),
      },
      lifecycle,
      executes: {
        task: { kind: 'cli_invocation', argv_template: [binary, 'run'], stdin_handling: 'none', shape: 'text', exit_code_handling: 'zero_is_success' },
      },
    },
  },
} as unknown as IngredientManifest);

const apiCatalog: IngredientManifest = {
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
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.example.com',
      auth: { kind: 'none' },
      executes: { list: { kind: 'rest', method: 'GET', path_template: '/x' } },
    },
  },
} as unknown as IngredientManifest;

const dbs: Database.Database[] = [];
const dirs: string[] = [];
afterEach(() => {
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
  const upsert = (args: unknown) => slice.handlers['collection.operation.upsertOwnerToolVersion'](
    args as Parameters<typeof slice.handlers['collection.operation.upsertOwnerToolVersion']>[0], RPC_CTX);
  const remove = (args: unknown) => slice.handlers['collection.operation.deleteOwnerToolVersion'](
    args as Parameters<typeof slice.handlers['collection.operation.deleteOwnerToolVersion']>[0], RPC_CTX);
  return { store, audits, upsert, remove, methods: slice.methods };
};

const MANIFESTS = new Map<string, IngredientManifest>([
  [OPENCODE, cliCatalog(OPENCODE, 'opencode', REFUSE)],
  [NO_RANGE, cliCatalog(NO_RANGE, 'ffmpeg')],
  [API, apiCatalog],
]);

describe('D-321 — collection.operation.upsertOwnerToolVersion', () => {
  it('writes the choice stamped with the pack\'s current version block, and audits it', async () => {
    const { store, audits, upsert } = harness(MANIFESTS);
    const view = await upsert({ ingredient_id: OPENCODE, outside: 'warn' });
    const version_hash = cliToolVersionHash(REFUSE);
    expect(view).toEqual({
      ingredient_id: OPENCODE,
      outside: 'warn',
      pack_outside: 'refuse',
      tested: REFUSE.tested,
      version_hash,
      written_at: NOW,
    });
    expect(store.get(OWNER_TOOL_VERSION_SCOPE, [OPENCODE])?.value).toEqual({ outside: 'warn', version_hash });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'owner_tool_version_written', target: OPENCODE, timestamp: NOW });
    expect(JSON.parse(audits[0]!.detail)).toEqual({
      ingredient_id: OPENCODE,
      outside: 'warn',
      prior: null,
      pack_outside: 'refuse',
      tested: REFUSE.tested,
      version_hash,
    });
  });

  it('a second write replaces the first, and the audit carries what it replaced', async () => {
    const { store, audits, upsert } = harness(MANIFESTS);
    await upsert({ ingredient_id: OPENCODE, outside: 'warn' });
    await upsert({ ingredient_id: OPENCODE, outside: 'refuse' });
    expect(store.get(OWNER_TOOL_VERSION_SCOPE, [OPENCODE])?.value).toMatchObject({ outside: 'refuse' });
    expect(JSON.parse(audits[1]!.detail).prior).toEqual({ outside: 'warn', version_hash: cliToolVersionHash(REFUSE) });
  });

  it.each([
    ['an unknown catalog', { ingredient_id: 'recued-core/nope', outside: 'warn' }, "'recued-core/nope' is not a known ingredient"],
    ['a cli catalog with no range', { ingredient_id: NO_RANGE, outside: 'warn' }, `'${NO_RANGE}' declares no tested versions for its tool`],
    ['a catalog that runs no tool', { ingredient_id: API, outside: 'warn' }, `'${API}' declares no tested versions for its tool`],
    ['a setting that is neither refuse nor warn', { ingredient_id: OPENCODE, outside: 'allow' }, 'outside must be refuse or warn'],
    ['no setting', { ingredient_id: OPENCODE }, 'outside must be refuse or warn'],
    ['no catalog', { outside: 'warn' }, 'ingredient_id is required'],
    ['args that are not an object', 'warn', 'args must be an object'],
  ])('refuses %s, and writes nothing', async (_label, args, message) => {
    const { store, audits, upsert } = harness(MANIFESTS);
    const outcome = await upsert(args).then(() => 'written', (e: unknown) => e);
    expect(outcome).toBeInstanceOf(RpcError);
    expect((outcome as RpcError).code).toBe('bad_request');
    expect((outcome as RpcError).message).toContain(message);
    expect(store.scan(OWNER_TOOL_VERSION_SCOPE)).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe('D-321 — collection.operation.deleteOwnerToolVersion', () => {
  it('removes the choice and audits it; removing nothing is not an error and audits nothing', async () => {
    const { store, audits, upsert, remove } = harness(MANIFESTS);
    await upsert({ ingredient_id: OPENCODE, outside: 'warn' });
    expect(await remove({ ingredient_id: OPENCODE })).toEqual({ deleted: true });
    expect(store.get(OWNER_TOOL_VERSION_SCOPE, [OPENCODE])).toBeNull();
    expect(audits[1]).toMatchObject({ action: 'owner_tool_version_deleted', target: OPENCODE });
    expect(JSON.parse(audits[1]!.detail)).toEqual({
      ingredient_id: OPENCODE,
      outside: null,
      prior: { outside: 'warn', version_hash: cliToolVersionHash(REFUSE) },
    });
    expect(await remove({ ingredient_id: OPENCODE })).toEqual({ deleted: false });
    expect(audits).toHaveLength(2);
  });

  it('clears a choice whose pack is gone', async () => {
    // No manifests: the pack was uninstalled, and its owner's choice stayed.
    const gone = harness(new Map());
    gone.store.put(OWNER_TOOL_VERSION_SCOPE, [OPENCODE], { outside: 'warn', version_hash: cliToolVersionHash(REFUSE) });
    expect(await gone.remove({ ingredient_id: OPENCODE })).toEqual({ deleted: true });
    expect(gone.store.get(OWNER_TOOL_VERSION_SCOPE, [OPENCODE])).toBeNull();
  });
});

describe('D-321 — the row', () => {
  it('the store refuses a row that is not a choice', () => {
    const store = makeStore();
    expect(() => store.put(OWNER_TOOL_VERSION_SCOPE, [OPENCODE], { outside: 'allow', version_hash: 'x' }))
      .toThrow(ContractWriteInvalidError);
    expect(() => store.put(OWNER_TOOL_VERSION_SCOPE, [OPENCODE], { outside: 'warn' }))
      .toThrow(ContractWriteInvalidError);
  });

  it('both methods are the local owner\'s only: an MCP agent can neither write nor clear a choice', () => {
    const { methods } = harness(MANIFESTS);
    for (const method of ['collection.operation.upsertOwnerToolVersion', 'collection.operation.deleteOwnerToolVersion'] as const) {
      expect(methods).toContain(method);
      expect(isReservedLocalRpc(method)).toBe(true);
    }
  });
});

describe.skipIf(process.platform === 'win32')('D-321 — the written choice decides a real run', () => {
  /** A stub tool answering `--version` with 2.0.1 and leaving `ran` when it acts. */
  const stub = (): { path: string; dir: string } => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'recued-d321-rpc-')));
    dirs.push(dir);
    const path = join(dir, 'opencode');
    writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.0.1; exit; fi\ntouch "${dir}/ran"\n`);
    chmodSync(path, 0o755);
    return { path, dir };
  };

  it('Warn written through the rpc lets 2.0.1 run; a pack update that moves the range refuses it again', async () => {
    const { path, dir } = stub();
    const manifests = new Map(MANIFESTS);
    manifests.set(OPENCODE, cliCatalog(OPENCODE, path, REFUSE));
    const { store, upsert } = harness(manifests);
    const exec = createCliInvocationExecutor({
      toolStatus: createCliToolStatus(),
      readOwnerToolVersion: (id) => store.get(OWNER_TOOL_VERSION_SCOPE, [id])?.value,
    });
    const call = (version: CliToolVersionPolicy) => ({
      slug: OPENCODE,
      operation_key: 'task',
      operation_id: `${OPENCODE}.task`,
      args: {},
      timeout_ms: 5_000,
      binding: { kind: 'cli_invocation', argv_template: [path, 'run'], shape: 'text', exit_code_handling: 'zero_is_success' },
      tool_version: { probe: [path, '--version'], version },
    }) as unknown as Parameters<typeof exec>[0];

    const before = await exec(call(REFUSE)).then(() => 'ran', (e: { cli_failure?: { reason: string } }) => e.cli_failure?.reason);
    expect(before).toBe('untested_version');
    expect(existsSync(join(dir, 'ran'))).toBe(false);

    await upsert({ ingredient_id: OPENCODE, outside: 'warn' });
    await exec(call(REFUSE));
    expect(existsSync(join(dir, 'ran'))).toBe(true);
    rmSync(join(dir, 'ran'));

    // The pack's next version tests from 1.20.0: the choice was made for other terms.
    const moved: CliToolVersionPolicy = { tested: { from: '1.20.0', before: '2.0.0' }, outside: 'refuse' };
    const after = await exec(call(moved)).then(() => 'ran', (e: { cli_failure?: { reason: string } }) => e.cli_failure?.reason);
    expect(after).toBe('untested_version');
    expect(existsSync(join(dir, 'ran'))).toBe(false);
  });

  /** ⛔ THE JOIN. The test above hands the executor its owner read by hand, so it
   *  proves the executor uses one and says nothing about whether the server
   *  wires it. This one takes the executor from the server's own composition
   *  (`composeExecuteDeps`), given the contract store the rpc writes. */
  it("through the server's own composition, the stored choice decides the run", async () => {
    const { path, dir } = stub();
    const manifests = new Map(MANIFESTS);
    manifests.set(OPENCODE, cliCatalog(OPENCODE, path, REFUSE));
    const { store, upsert } = harness(manifests);
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
      slug: OPENCODE,
      operation_key: 'task',
      operation_id: `${OPENCODE}.task`,
      args: {},
      timeout_ms: 5_000,
      binding: { kind: 'cli_invocation', argv_template: [path, 'run'], shape: 'text', exit_code_handling: 'zero_is_success' },
      tool_version: { probe: [path, '--version'], version: REFUSE },
    } as unknown as Parameters<typeof exec>[0];

    const before = await exec(call).then(() => 'ran', (e: { cli_failure?: { reason: string } }) => e.cli_failure?.reason);
    expect(before).toBe('untested_version');
    await upsert({ ingredient_id: OPENCODE, outside: 'warn' });
    await exec(call);
    expect(existsSync(join(dir, 'ran'))).toBe(true);
  });
});
