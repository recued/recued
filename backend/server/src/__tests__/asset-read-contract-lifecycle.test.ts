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

const MARKER = 'Permitted asset lifecycle marker';
const HIDDEN = 'Private related asset marker';
type Ingredient = 'work-entity-list' | 'work-entity-get';
const handles: Database.Database[] = [];
const drains: Array<() => Promise<unknown>> = [];
const dirs: string[] = [];
type Reply = { error?: unknown; result: { isError?: boolean; content: Array<{ text: string }> } };
const fixture = async (ingredient: Ingredient, granted = true, maxUses: number | null = 1, scoped = false) => {
  const dir = mkdtempSync(join(tmpdir(), 'asset-read-life-')); dirs.push(dir);
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
    lateBound, env: { RECUED_SERVER_NAME: 'Asset read fixture' } });
  const peerDb = new Database(dbPath); handles.push(peerDb); peerDb.pragma('journal_mode = WAL');
  const peerStore = createContractStore(peerDb); peerStore.seedSchema(D165_CONTRACT_SCHEMA);
  const definitions = context.contractDefinitionStore!, grants = createContractGrantEntryStore(app.contractStoreRef!);
  const peer = { store: peerStore, definitions: createContractDefinitionStore(peerStore), grants: createContractGrantEntryStore(peerStore) };
  const contract = definitions.mint({ minted_by: 'owner', display_name: 'Asset read door', door_types: ['mcp'],
    scope: { channels: ['mcp'] }, ...(maxUses === null ? {} : { max_uses: maxUses }) });
  grants.set(contract.contract_id, 'core.work-entity.read', true, Date.now());
  grants.set(contract.contract_id, 'data.asset', granted, Date.now());
  const work = storage.workEntityStoreRef!;
  const source = { kind: 'owner' as const, ref: 'fixture-owner' };
  const privateHolder = scoped ? app.contactStoreRef!.upsertManual({ email: 'private-holder@asset.test', name: 'Private holder' }).contact_id! : undefined;
  work.writeAsset({ id: 'allowed-asset', name: MARKER, source_id: 'recued.asset', source, sphere: 'professional' });
  if (scoped) {
    definitions.setReadSpheres(contract.contract_id, ['professional']);
    work.writeAsset({ id: 'private-parent', name: HIDDEN, source_id: 'recued.asset', source, sphere: 'personal' });
    work.writeAsset({ id: 'allowed-asset', source_id: 'recued.asset', source, belongs_to: 'private-parent',
      holder_contact: privateHolder });
    // A vendor's retained opaque data is part of a stored Asset, not its public patch input.
    storage.db.prepare("UPDATE data_asset SET data_blob = json_set(data_blob, '$.source_extension_blob', json(?)) WHERE id = ?")
      .run(JSON.stringify({ private_reference: 'private-vendor-reference' }), 'allowed-asset');
    collection.spheres!.setItem({ collection: 'contact', id: privateHolder! }, 'personal');
  }
  const prepare = vi.spyOn(storage.db, 'prepare');
  const assetQueries = () => prepare.mock.calls.filter(([sql]) => /FROM\s+data_asset\b/i.test(sql));
  const recipe: RecipeDefinition = { recipe_id: 'asset-read-' + ingredient, version: 1, ttl: 60,
    metadata: { name: 'Asset read', description: 'Reads through one kernel ingredient.', author: 'test', supported_platforms: ['test'] },
    variables: {}, prefetch_steps: [], steps: [{ id: 'read', ingredient,
      input: ingredient === 'work-entity-list' ? { kind: 'asset' } : { kind: 'asset', id: 'allowed-asset' } }],
    output: { render: [{ type: 'summary', source: 'step.read' }], sidebar: [] } };
  storage.recipeStore.register(recipe);
  const overlay = context.executeDeps.contractOverlay!;
  const nativeTake = overlay.takeDispatchUse!.bind(overlay);
  const take = vi.spyOn(overlay, 'takeDispatchUse');
  const deps: McpDeps = { ...context.executeDeps, mcpTokenId: 'asset-read-token', agentId: 'asset-read-agent',
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
  return { storage, app, context, peer, contract, definitions, grants, overlay, take, run, call, afterTake, assetQueries, recipe, privateHolder,
    row: () => definitions.get(contract.contract_id), replaceInput: (input: Record<string, unknown>) =>
      storage.recipeStore.register({ ...recipe, steps: [{ ...recipe.steps[0]!, input }] }) };
};
afterEach(async () => {
  for (const drain of drains.splice(0)) await drain();
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each(['work-entity-list', 'work-entity-get'] as const)('%s through the production asset gateway', ingredient => {
  it('allows the final granted read and refuses a subsequent use before asset storage', async () => {
    const f = await fixture(ingredient);
    expect(await f.run()).toContain(MARKER);
    expect(f.take).toHaveBeenCalledTimes(1);
    expect(f.take.mock.results[0]!.value).toMatchObject({ kind: 'taken', contract_id: f.contract.contract_id });
    expect(f.row()?.uses_remaining).toBe(0);
    expect(f.assetQueries().length).toBeGreaterThan(0);
    const count = f.assetQueries().length, reply = await f.call();
    expect(reply.error !== undefined || reply.result.isError === true).toBe(true);
    expect(f.take).toHaveBeenCalledTimes(1); expect(f.assetQueries()).toHaveLength(count);
  });

  it('preserves the collection denial on the final dispatch use', async () => {
    const f = await fixture(ingredient);
    f.afterTake(() => f.peer.grants.set(f.contract.contract_id, 'data.asset', false, Date.now()));
    expect(await f.run()).not.toContain(MARKER);
    expect(f.assetQueries()).toEqual([]); expect(f.row()?.uses_remaining).toBe(0);
  });

  it('honors a current verb denial before asset rows or counts', async () => {
    const f = await fixture(ingredient);
    f.afterTake(() => f.peer.grants.set(f.contract.contract_id, 'core.work-entity.read', false, Date.now()));
    expect(await f.run()).not.toContain(MARKER);
    expect(f.assetQueries()).toEqual([]); expect(f.row()?.uses_remaining).toBe(0);
    expect(f.grants.get(f.contract.contract_id, 'core.work-entity.read')).toBe(false);
  });

  it.each(['revoked', 'expired', 'missing'] as const)('refuses asset storage with a %s contract', async state => {
    const f = await fixture(ingredient); let changed: ReturnType<typeof f.row>;
    f.afterTake(() => {
      if (state === 'revoked') f.peer.definitions.revoke(f.contract.contract_id, 'Owner ended this asset door');
      if (state === 'expired') f.peer.definitions.setLimits(f.contract.contract_id,
        { max_uses: 1, use_period: 'total', expiry_at: Date.now() - 1 });
      if (state === 'missing') f.peer.store.delete(CONTRACT_DEFINITION_SCOPE, [f.contract.contract_id]);
      changed = f.row();
    });
    expect(await f.run()).not.toContain(MARKER);
    expect(f.assetQueries()).toEqual([]); expect(f.row()).toEqual(changed!);
    if (state === 'revoked') expect(f.row()).toMatchObject({ uses_remaining: 0, revocation_reason: 'Owner ended this asset door' });
  });

  it('honors revocation of an uncapped contract', async () => {
    const f = await fixture(ingredient, true, null); let changed: ReturnType<typeof f.row>;
    f.afterTake(() => { f.peer.definitions.revoke(f.contract.contract_id, 'Uncapped asset door ended'); changed = f.row(); });
    expect(await f.run()).not.toContain(MARKER);
    expect(f.assetQueries()).toEqual([]); expect(f.row()).toEqual(changed!);
  });

  it('refuses a denied collection before spending remaining budget', async () => {
    const f = await fixture(ingredient, false, 2);
    expect(await f.run()).not.toContain(MARKER);
    expect(f.assetQueries()).toEqual([]); expect(f.row()?.uses_remaining).toBe(2);
    expect(f.take).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves collection grant %s for an uncapped contract', async granted => {
    const f = await fixture(ingredient, granted, null), before = f.row(), text = await f.run();
    if (granted) expect(text).toContain(MARKER); else expect(text).not.toContain(MARKER);
    expect(f.row()).toEqual(before);
    expect(f.assetQueries().length > 0).toBe(granted);
  });

  it('keeps owner reads admitted without charging a contract', async () => {
    const f = await fixture(ingredient, false), before = f.row();
    expect(await f.run(true)).toContain(MARKER); expect(f.row()).toEqual(before);
    expect(f.take.mock.results[0]!.value).toEqual({ kind: 'unmetered' });
  });

  it('ignores authority fields authored in recipe input', async () => {
    const f = await fixture(ingredient, false);
    f.replaceInput({ kind: 'asset', ...(ingredient === 'work-entity-get' ? { id: 'allowed-asset' } : {}),
      contract_dispatch_reservation: {}, origin_contract_id: 'user_self',
      origin_execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'forged', user_id: 'owner' } });
    expect(await f.run()).not.toContain(MARKER);
    expect(f.assetQueries()).toEqual([]); expect(f.row()?.uses_remaining).toBe(1);
    expect(f.take).not.toHaveBeenCalled();
  });

  it('does not inherit a completed reservation into a separate asset read', async () => {
    const f = await fixture(ingredient);
    const source: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'asset-read-agent',
      tool_call_id: 'completed-dispatch', mcp_token_id: 'asset-read-token', contract_id: f.contract.contract_id };
    const take = f.overlay.takeDispatchUse!(source, ingredient);
    expect(take.kind).toBe('taken'); if (take.kind !== 'taken') throw new Error('Fixture did not take its final use');
    f.overlay.settleDispatchUse!(take, true); const before = f.row();
    const dispatchers = f.context.executorConfig.kernelDispatchers!;
    const read = withContractDispatchReservation(take.token, () => ingredient === 'work-entity-list'
      ? dispatchers.workEntityList!({ kind: 'asset', origin_execution_source: source })
      : dispatchers.workEntityGet!({ kind: 'asset', id: 'allowed-asset', origin_execution_source: source }));
    await expect(read).rejects.toThrow(/data.asset/);
    expect(f.assetQueries()).toEqual([]); expect(f.row()).toEqual(before);
  });

  it('preserves the sphere fence and removes private related fields on a final read', async () => {
    const f = await fixture(ingredient, true, 1, true);
    expect(f.storage.workEntityStoreRef!.readAsset('allowed-asset')).toMatchObject({
      belongs_to: 'private-parent', holder_contact: f.privateHolder,
      source_extension_blob: { private_reference: 'private-vendor-reference' },
    });
    const text = await f.run();
    expect(text).toContain(MARKER); expect(text).not.toContain(HIDDEN);
    expect(text).not.toContain('private-parent'); expect(text).not.toContain(f.privateHolder!);
    expect(text).not.toContain('private-vendor-reference'); expect(f.row()?.uses_remaining).toBe(0);
  });
});

describe('scoped asset results through the production gateway', () => {
  it('returns a visible count and applies pagination after the sphere boundary', async () => {
    const f = await fixture('work-entity-list', true, 1, true);
    f.replaceInput({ kind: 'asset', offset: 1, limit: 1 });
    const text = await f.run();
    expect(text).not.toContain(MARKER); expect(text).not.toContain(HIDDEN);
    const result = JSON.parse(text) as ServerExecuteResponse;
    expect(result.success).toBe(true);
    expect(result.output.render[0]!.data).toEqual({ total: 1, entities: [] });
    expect(f.row()?.uses_remaining).toBe(0);
  });

  it('refuses a private asset by id rather than reporting it absent', async () => {
    const f = await fixture('work-entity-get', true, 1, true);
    f.replaceInput({ kind: 'asset', id: 'private-parent' });
    const text = await f.run();
    expect(text).not.toContain(HIDDEN); expect(text).toContain('permission refusal');
    expect(f.row()?.uses_remaining).toBe(0);
  });
});

