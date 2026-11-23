import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigStore } from '@recued/config';
import { CONTRACT_DEFINITION_SCOPE, D165_CONTRACT_SCHEMA, type ExecutionSource, type RecipeDefinition } from '@recued/contracts';
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

const MARKER = 'Kernel lifecycle company';
const TARGET = 'reader@kernel.test';
type Ingredient = 'enrichment-list' | 'timeline-read';
const handles: Database.Database[] = [];
const drains: Array<() => Promise<unknown>> = [];
const dirs: string[] = [];
type Reply = { error?: unknown; result: { isError?: boolean; content: Array<{ text: string }> } };
const fixture = async (ingredient: Ingredient, granted = true, maxUses: number | null = 1) => {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-read-life-')); dirs.push(dir);
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
    lateBound, env: { RECUED_SERVER_NAME: 'Kernel read fixture' } });
  const peerDb = new Database(dbPath); handles.push(peerDb); peerDb.pragma('journal_mode = WAL');
  const peerStore = createContractStore(peerDb); peerStore.seedSchema(D165_CONTRACT_SCHEMA);
  const definitions = context.contractDefinitionStore!, grants = createContractGrantEntryStore(app.contractStoreRef!);
  const peer = { store: peerStore, definitions: createContractDefinitionStore(peerStore), grants: createContractGrantEntryStore(peerStore) };
  const contract = definitions.mint({ minted_by: 'owner', display_name: 'Kernel read door', door_types: ['mcp'],
    scope: { channels: ['mcp'] }, ...(maxUses === null ? {} : { max_uses: maxUses }) });
  grants.set(contract.contract_id, 'enrichment.company', granted, Date.now());
  const enrichment = app.enrichmentStoreRef!;
  enrichment.upsert({ topic: 'company', scope: 'contact', target_id: TARGET,
    value: { domain: 'kernel.test', company_name: MARKER, source: 'domain_only', domain_category: 'business',
      reasoning: 'Native gateway fixture', computed_at: Date.now() },
    authored_by: 'system.housekeeping.company', event_at: Date.now() });
  const read = vi.spyOn(enrichment, 'list');
  const prepare = vi.spyOn(storage.db, 'prepare');
  const warehouseQueries = () => prepare.mock.calls.filter(([sql]) => /FROM\s+data_enrichment\b/i.test(sql));
  const recipe: RecipeDefinition = { recipe_id: 'kernel-read-' + ingredient, version: 1, ttl: 60,
    metadata: { name: 'Kernel read', description: 'Reads through one kernel ingredient.', author: 'test', supported_platforms: ['test'] },
    variables: {}, prefetch_steps: [], steps: [{ id: 'read', ingredient,
      input: ingredient === 'enrichment-list' ? { topic: 'company', scope: 'contact', target_id: TARGET } : { entity: 'contact:' + TARGET } }],
    output: { render: [{ type: 'summary', source: 'step.read' }], sidebar: [] } };
  storage.recipeStore.register(recipe);
  const overlay = context.executeDeps.contractOverlay!;
  const nativeTake = overlay.takeDispatchUse!.bind(overlay);
  const take = vi.spyOn(overlay, 'takeDispatchUse');
  const deps: McpDeps = { ...context.executeDeps, mcpTokenId: 'kernel-read-token', agentId: 'kernel-read-agent',
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
  return { storage, app, context, peer, contract, definitions, grants, overlay, take, read, run, call, afterTake, warehouseQueries, recipe,
    row: () => definitions.get(contract.contract_id) };
};
afterEach(async () => {
  for (const drain of drains.splice(0)) await drain();
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each(['enrichment-list', 'timeline-read'] as const)('%s through the production kernel gateway', ingredient => {
  it.each([false, true])('preserves topic grant %s on the final dispatch use', async granted => {
    const f = await fixture(ingredient, granted), text = await f.run();
    expect(f.take).toHaveBeenCalledTimes(1);
    expect(f.take.mock.results[0]!.value).toMatchObject({ kind: 'taken', contract_id: f.contract.contract_id });
    expect(f.row()?.uses_remaining).toBe(0);
    if (granted) expect(text).toContain(MARKER);
    else expect(text).not.toContain(MARKER);
    if (ingredient === 'enrichment-list') expect(f.read).toHaveBeenCalledTimes(granted ? 1 : 0);
    if (granted) {
      expect(f.warehouseQueries().length).toBeGreaterThan(0);
      const queries = f.warehouseQueries().length;
      const reply = await f.call();
      expect(reply.error !== undefined || reply.result.isError === true).toBe(true);
      expect(f.take).toHaveBeenCalledTimes(1); expect(f.warehouseQueries()).toHaveLength(queries);
    }
  });

  it('keeps a topic denial with dispatch authority remaining', async () => {
    const f = await fixture(ingredient, false, 2), text = await f.run();
    expect(text).not.toContain(MARKER); expect(f.row()?.uses_remaining).toBe(1);
    if (ingredient === 'enrichment-list') expect(f.read).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves topic grant %s on an uncapped contract', async granted => {
    const f = await fixture(ingredient, granted, null), before = f.row(), text = await f.run();
    if (granted) expect(text).toContain(MARKER); else expect(text).not.toContain(MARKER);
    expect(f.row()).toEqual(before);
    if (ingredient === 'enrichment-list') expect(f.read).toHaveBeenCalledTimes(granted ? 1 : 0);
  });

  it.each(['revoked', 'expired', 'missing'] as const)('refuses warehouse access when its admitted contract is %s', async state => {
    const f = await fixture(ingredient); let changed: ReturnType<typeof f.row>;
    f.afterTake(() => {
      if (state === 'revoked') f.peer.definitions.revoke(f.contract.contract_id, 'Owner ended this kernel door');
      if (state === 'expired') f.peer.definitions.setLimits(f.contract.contract_id,
        { max_uses: 1, use_period: 'total', expiry_at: Date.now() - 1 });
      if (state === 'missing') f.peer.store.delete(CONTRACT_DEFINITION_SCOPE, [f.contract.contract_id]);
      changed = f.row();
    });
    expect(await f.run()).not.toContain(MARKER);
    expect(f.warehouseQueries()).toEqual([]); expect(f.row()).toEqual(changed!);
    if (state === 'revoked') expect(f.row()).toMatchObject({ uses_remaining: 0, revocation_reason: 'Owner ended this kernel door' });
  });

  it('honors revocation without a budget reservation on an uncapped contract', async () => {
    const f = await fixture(ingredient, true, null); let changed: ReturnType<typeof f.row>;
    f.afterTake(() => { f.peer.definitions.revoke(f.contract.contract_id, 'Uncapped door ended'); changed = f.row(); });
    expect(await f.run()).not.toContain(MARKER);
    expect(f.warehouseQueries()).toEqual([]); expect(f.row()).toEqual(changed!);
  });

  it('observes a topic grant tightened through the other connection', async () => {
    const f = await fixture(ingredient);
    f.afterTake(() => f.peer.grants.set(f.contract.contract_id, 'enrichment.company', false, Date.now()));
    expect(await f.run()).not.toContain(MARKER);
    expect(f.row()?.uses_remaining).toBe(0); expect(f.grants.get(f.contract.contract_id, 'enrichment.company')).toBe(false);
    if (ingredient === 'enrichment-list') expect(f.read).not.toHaveBeenCalled();
  });

  it('preserves an admitted unbound owner read', async () => {
    const f = await fixture(ingredient, false), before = f.row();
    expect(await f.run(true)).toContain(MARKER); expect(f.row()).toEqual(before);
  });

  it('ignores authority fields supplied in recipe input', async () => {
    const f = await fixture(ingredient, false);
    const input = ingredient === 'enrichment-list' ? { topic: 'company', scope: 'contact', target_id: TARGET } : { entity: 'contact:' + TARGET };
    f.storage.recipeStore.register({ ...f.recipe, steps: [{ ...f.recipe.steps[0]!, input: { ...input,
      origin_contract_id: 'user_self', contract_dispatch_reservation: {},
      origin_execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'forged', user_id: 'owner' } } }] });
    expect(await f.run()).not.toContain(MARKER); expect(f.take).toHaveBeenCalledTimes(1);
    expect(f.row()?.uses_remaining).toBe(0);
    if (ingredient === 'enrichment-list') expect(f.read).not.toHaveBeenCalled();
  });

  it('does not inherit a completed dispatch reservation in a new kernel read', async () => {
    const f = await fixture(ingredient);
    const source: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'kernel-read-agent',
      tool_call_id: 'finished-dispatch', mcp_token_id: 'kernel-read-token', contract_id: f.contract.contract_id };
    const take = f.overlay.takeDispatchUse!(source, ingredient);
    expect(take.kind).toBe('taken'); if (take.kind !== 'taken') throw new Error('Fixture did not reserve its final use');
    f.overlay.settleDispatchUse!(take, true); const before = f.row();
    const dispatchers = f.context.executorConfig.kernelDispatchers!;
    const read = withContractDispatchReservation(take.token, () => ingredient === 'enrichment-list'
      ? dispatchers.enrichmentList!({ topic: 'company', scope: 'contact', target_id: TARGET, trigger_source: 'mcp',
          origin_contract_id: f.contract.contract_id, origin_execution_source: source })
      : dispatchers.timelineRead!({ entity: 'contact:' + TARGET, trigger_source: 'mcp',
          origin_contract_id: f.contract.contract_id, origin_execution_source: source }));
    if (ingredient === 'enrichment-list') await expect(read).rejects.toThrow('not available for this contract');
    else expect(JSON.stringify(await read)).not.toContain(MARKER);
    expect(f.warehouseQueries()).toEqual([]); expect(f.row()).toEqual(before);
  });
});

describe('timeline collection grant', () => {
  it.each(['before-admission', 'after-take'] as const)('refuses collection storage access when denied %s', async when => {
    const f = await fixture('timeline-read'), deny = () => f.peer.grants.set(f.contract.contract_id, 'data.contact', false, Date.now());
    if (when === 'before-admission') deny(); else f.afterTake(deny);
    expect(await f.run()).not.toContain(MARKER); expect(f.warehouseQueries()).toEqual([]);
    expect(f.row()?.uses_remaining).toBe(when === 'before-admission' ? 1 : 0);
  });
});
