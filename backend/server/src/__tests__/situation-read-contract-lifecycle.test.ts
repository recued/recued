import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigStore } from '@recued/config';
import { CONTRACT_DEFINITION_SCOPE, D165_CONTRACT_SCHEMA, type ExecutionSource, type RecipeDefinition, type ServerExecuteResponse } from '@recued/contracts';
import { createBootTrace } from '../cli/boot-trace.js';
import { createMcpHttpDispatch, type McpDeps } from '../mcp-server.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeExecutionContext, createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';
import { withContractDispatchReservation } from '../contract-dispatch-reservation.js';

const MARKER = 'Permitted situation lifecycle marker';
const HIDDEN = 'Private related asset marker';
type Mode = 'query' | 'context';
const handles: Database.Database[] = [];
const drains: Array<() => Promise<unknown>> = [];
const dirs: string[] = [];
type Reply = { error?: unknown; result: { isError?: boolean; content: Array<{ text: string }> } };
const fixture = async (mode: Mode, granted = true, maxUses: number | null = 1, scoped = false) => {
  const dir = mkdtempSync(join(tmpdir(), 'situation-read-life-')); dirs.push(dir);
  const dbPath = join(dir, 'realm.sqlite'), runtimeConfig = createRuntimeConfigStore({});
  const storage = await composeStorageContext({ dbPath,
    bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
    runtimeConfig, vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 } });
  handles.push(storage.db); drains.push(() => storage.drainAuditWrites!());
  const lateBound = createExecutionLateBoundRefs();
  const app = composeAppContext({ db: storage.db, dbPath, envLlmConfig: storage.envLlmConfig,
    gateRegistry: storage.gateRegistry, auditLog: storage.auditLog, eventBus: storage.eventBus,
    serverInstanceId: storage.serverInstanceId, recipeStore: storage.recipeStore,
    pairedInstances: storage.pairedInstances, workEntityStore: storage.workEntityStoreRef, chatLateBound: lateBound });
  await unlockServerVault(app.keys!);
  const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig,
    manifests: storage.manifests, baseVault: storage.baseVault, auditLog: storage.auditLog,
    cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus, contactStore: app.contactStoreRef,
    mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry, accountStore: storage.accountStore,
    eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
    workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef });
  const context = await composeExecutionContext({ storage, app, collection, baseVault: storage.baseVault,
    lateBound, env: { RECUED_SERVER_NAME: 'Situation read fixture' } });
  const peerDb = new Database(dbPath); handles.push(peerDb); peerDb.pragma('journal_mode = WAL');
  const peerStore = createContractStore(peerDb); peerStore.seedSchema(D165_CONTRACT_SCHEMA);
  const definitions = context.contractDefinitionStore!, grants = createContractGrantEntryStore(app.contractStoreRef!);
  const peer = { store: peerStore, definitions: createContractDefinitionStore(peerStore), grants: createContractGrantEntryStore(peerStore) };
  const contract = definitions.mint({ minted_by: 'owner', display_name: 'Situation read door', door_types: ['mcp'],
    scope: { channels: ['mcp'] }, ...(maxUses === null ? {} : { max_uses: maxUses }) });
  grants.set(contract.contract_id, 'core.situation.read', true, Date.now());
  grants.set(contract.contract_id, 'core.work-entity.read', true, Date.now());
  grants.set(contract.contract_id, 'data.asset', granted, Date.now());
  const work = storage.workEntityStoreRef!;
  const source = { kind: 'owner' as const, ref: 'fixture-owner' };
  const now = Date.now(), day = 86_400_000;
  const expires = new Date(now + 2 * day).toISOString().slice(0, 10);
  const rule = { id: 'review', title: 'Review', enabled: true, muted: false, pinned: false,
    consequence: 'routine' as const, expiry_policy: 'strict_expire' as const,
    when: { kind: 'expiry' as const, field: 'expires_on' },
    reaction: { notify: true, occurrence: 'notice' as const, emit: false }, schedule: { before: [], on_day: true } };
  work.writeAsset({ id: 'allowed-asset', name: MARKER, source_id: 'recued.asset', source, sphere: 'professional',
    dates: { expires_on: expires }, rules: [rule], attributes: { proof: MARKER } });
  if (scoped) {
    definitions.setReadSpheres(contract.contract_id, ['professional']);
    work.writeAsset({ id: 'private-asset', name: HIDDEN, source_id: 'recued.asset', source, sphere: 'personal',
      dates: { expires_on: expires }, rules: [rule], attributes: { proof: HIDDEN } });
  }
  const nativePrepare = storage.db.prepare.bind(storage.db);
  const prepare = vi.spyOn(storage.db, 'prepare');
  const assetQueries = () => prepare.mock.calls.filter(([sql]) => /FROM\s+data_asset\b/i.test(sql));
  const input = mode === 'query' ? { time: { from: now, to: now + 7 * day } }
    : { context: { root: { kind: 'field', asset_id: 'allowed-asset', group: 'attributes', field: 'proof' } } };
  const recipe: RecipeDefinition = { recipe_id: 'situation-read-' + mode, version: 1, ttl: 60,
    metadata: { name: 'Situation read', description: 'Reads through the situation kernel.', author: 'test', supported_platforms: ['test'] },
    variables: {}, prefetch_steps: [], steps: [{ id: 'read', ingredient: 'situation-query', input }],
    output: { render: [{ type: 'summary', source: 'step.read' }], sidebar: [] } };
  storage.recipeStore.register(recipe);
  const overlay = context.executeDeps.contractOverlay!;
  const nativeTake = overlay.takeDispatchUse!.bind(overlay);
  const take = vi.spyOn(overlay, 'takeDispatchUse');
  const deps: McpDeps = { ...context.executeDeps, mcpTokenId: 'situation-read-token', agentId: 'situation-read-agent',
    boundContractId: contract.contract_id, boundContractActive: overlay.isContractLive(contract.contract_id),
    inboundTokenAuthorize: () => true, mcpPrincipalActive: () => true };
  const call = async (owner = false) => {
    const { boundContractId, boundContractActive, ...unbound } = deps;
    const actual = owner ? { ...unbound, ownerAdmitAll: true } : deps;
    return await createMcpHttpDispatch(actual)({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'recued_runRecipe', arguments: { recipe_id: recipe.recipe_id } } }) as Reply;
  };
  const run = async (owner = false) => {
    const reply = await call(owner);
    expect(reply.error, JSON.stringify(reply)).toBeUndefined();
    expect(reply.result.isError, JSON.stringify(reply)).not.toBe(true);
    return reply.result.content[0]!.text;
  };
  const afterTake = (change: () => void) => take.mockImplementation((...args) => {
    const result = nativeTake(...args); change(); return result;
  });
  return { storage, app, context, peer, contract, definitions, grants, overlay, take, run, call, afterTake, assetQueries, recipe, input,
    observeAssetQuery: (observe: () => void) => {
      let observed = false;
      prepare.mockImplementation((...args) => {
        const statement = nativePrepare(...args);
        if (!observed && /FROM\s+data_asset\b/i.test(args[0])) { observed = true; observe(); }
        return statement;
      });
    }, row: () => definitions.get(contract.contract_id), replaceInput: (input: Record<string, unknown>) =>
      storage.recipeStore.register({ ...recipe, steps: [{ ...recipe.steps[0]!, input }] }) };
};
afterEach(async () => {
  for (const drain of drains.splice(0)) await drain();
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each(['query', 'context'] as const)('situation %s through the production gateway', mode => {
  it('allows its final granted read without lending authority to storage or a subsequent read', async () => {
    const f = await fixture(mode); let observed = false;
    f.observeAssetQuery(() => { observed = true; expect(f.row()?.uses_remaining).toBe(0);
      expect(f.overlay.isContractLive(f.contract.contract_id)).toBe(false); });
    const text = await f.run();
    expect(text).toContain(MARKER); expect(observed).toBe(true);
    expect((JSON.parse(text) as ServerExecuteResponse).success).toBe(true);
    expect(f.take).toHaveBeenCalledTimes(1);
    expect(f.take.mock.results[0]!.value).toMatchObject({ kind: 'taken', contract_id: f.contract.contract_id });
    expect(f.row()?.uses_remaining).toBe(0);
    const count = f.assetQueries().length, reply = await f.call();
    expect(reply.error !== undefined || reply.result.isError === true).toBe(true);
    expect(f.take).toHaveBeenCalledTimes(1); expect(f.assetQueries()).toHaveLength(count);
  });

  it('allows a granted read with budget remaining', async () => {
    const f = await fixture(mode, true, 2);
    expect(await f.run()).toContain(MARKER); expect(f.row()?.uses_remaining).toBe(1);
  });

  it('allows an uncapped granted read', async () => {
    const f = await fixture(mode, true, null), before = f.row();
    expect(await f.run()).toContain(MARKER); expect(f.row()).toEqual(before);
  });

  it('keeps unbound owner reads admitted without charging a contract', async () => {
    const f = await fixture(mode, false), before = f.row();
    expect(await f.run(true)).toContain(MARKER); expect(f.row()).toEqual(before);
    expect(f.take.mock.results[0]!.value).toEqual({ kind: 'unmetered' });
  });

  it.each(['revoked', 'expired', 'missing'] as const)('refuses asset storage with a %s contract', async state => {
    const f = await fixture(mode); let changed: ReturnType<typeof f.row>;
    f.afterTake(() => {
      if (state === 'revoked') f.peer.definitions.revoke(f.contract.contract_id, 'Owner ended this situation door');
      if (state === 'expired') f.peer.definitions.setLimits(f.contract.contract_id,
        { max_uses: 1, use_period: 'total', expiry_at: Date.now() - 1 });
      if (state === 'missing') f.peer.store.delete(CONTRACT_DEFINITION_SCOPE, [f.contract.contract_id]);
      changed = f.row();
    });
    expect(await f.run()).not.toContain(MARKER);
    expect(f.assetQueries()).toEqual([]); expect(f.row()).toEqual(changed!);
    if (state === 'revoked') expect(f.row()).toMatchObject({ uses_remaining: 0, revocation_reason: 'Owner ended this situation door' });
  });

  it('honors revocation of an uncapped contract', async () => {
    const f = await fixture(mode, true, null); let changed: ReturnType<typeof f.row>;
    f.afterTake(() => { f.peer.definitions.revoke(f.contract.contract_id, 'Uncapped situation door ended'); changed = f.row(); });
    expect(await f.run()).not.toContain(MARKER);
    expect(f.assetQueries()).toEqual([]); expect(f.row()).toEqual(changed!);
  });

  it('keeps the asset collection denial with budget remaining', async () => {
    const f = await fixture(mode, false, 2);
    expect(await f.run()).not.toContain(MARKER); expect(f.assetQueries()).toEqual([]);
    expect(f.grants.get(f.contract.contract_id, 'data.asset')).toBe(false);
  });

  it('keeps the underlying asset verb denial with budget remaining', async () => {
    const f = await fixture(mode, true, 2);
    f.grants.set(f.contract.contract_id, 'core.work-entity.read', false, Date.now());
    expect(await f.run()).not.toContain(MARKER); expect(f.assetQueries()).toEqual([]);
  });

  it.each(['core.situation.read', 'core.work-entity.read', 'data.asset'])('honors the current %s denial on its final use', async entry => {
    const f = await fixture(mode);
    f.afterTake(() => f.peer.grants.set(f.contract.contract_id, entry, false, Date.now()));
    expect(await f.run()).not.toContain(MARKER); expect(f.assetQueries()).toEqual([]);
    expect(f.grants.get(f.contract.contract_id, entry)).toBe(false);
    expect(f.row()?.uses_remaining).toBe(0);
  });

  it('keeps sphere privacy on the final permitted read', async () => {
    const f = await fixture(mode, true, 1, true), text = await f.run();
    expect(text).toContain(MARKER); expect(text).not.toContain(HIDDEN);
    expect(f.row()?.uses_remaining).toBe(0);
  });

  it('refuses a new kernel read carrying only ambient authority from a completed dispatch', async () => {
    const f = await fixture(mode);
    const source: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'situation-read-agent',
      tool_call_id: 'completed-dispatch', mcp_token_id: 'situation-read-token', contract_id: f.contract.contract_id };
    const take = f.overlay.takeDispatchUse!(source, 'situation-query');
    expect(take.kind).toBe('taken'); if (take.kind !== 'taken') throw new Error('Fixture did not take its final use');
    f.overlay.settleDispatchUse!(take, true); const before = f.row();
    const read = withContractDispatchReservation(take.token, () => f.context.executorConfig.kernelDispatchers!.situationQuery!(f.input, source));
    await expect(read).rejects.toThrow(/live governing contract/);
    expect(f.assetQueries()).toEqual([]); expect(f.row()).toEqual(before);
  });

  it('keeps the authority recheck after a real asset read', async () => {
    const f = await fixture(mode, true, 2); let changed: ReturnType<typeof f.row> | undefined;
    f.observeAssetQuery(() => { f.peer.definitions.revoke(f.contract.contract_id, 'Owner ended this read');
      changed = f.peer.definitions.get(f.contract.contract_id); });
    const text = await f.run();
    expect(changed).toBeDefined(); expect(f.assetQueries().length).toBeGreaterThan(0);
    expect(text).not.toContain(MARKER); expect(f.row()).toEqual(changed!);
    expect(text).toContain('live governing contract');
  });
});

describe('scoped situation results through the production gateway', () => {
  it('keeps hidden assets out of both items and omission counts', async () => {
    const f = await fixture('query', true, 1, true), result = JSON.parse(await f.run()) as ServerExecuteResponse;
    expect(result.success).toBe(true);
    const data = result.output.render[0]!.data as import('@recued/contracts').SituationResult;
    expect(data.clusters.flatMap(cluster => cluster.items).map(item => item.ref.id)).toEqual(['allowed-asset']);
    expect(data.omitted).toBe(0);
  });

  it('refuses fact context for an asset outside the contract spheres', async () => {
    const f = await fixture('context', true, 1, true);
    f.replaceInput({ context: { root: { kind: 'field', asset_id: 'private-asset', group: 'attributes', field: 'proof' } } });
    const text = await f.run();
    expect(text).not.toContain(HIDDEN); expect(text).toContain('not available with the current read permissions');
    expect(f.row()?.uses_remaining).toBe(0);
  });
});

