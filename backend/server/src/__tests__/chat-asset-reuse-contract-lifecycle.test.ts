import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigStore } from '@recued/config';
import { D165_CONTRACT_SCHEMA, OWNER_CONTRACT_ID, isContractActive } from '@recued/contracts';
import { assetChatMessage } from '../../../../apps/webclient/src/chat/asset-context.js';
import { createBootTrace } from '../cli/boot-trace.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { composeExecutionContext, createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';

const ASSET = 'asset:reuse-native';
const MARKER = 'Native reuse asset';
const handles: Database.Database[] = [];
const drains: Array<() => Promise<unknown>> = [];
const dirs: string[] = [];
type Packet = { prior_tool_calls?: Array<{ tool_name: string; status?: string; args: Record<string, unknown>; result?: any }>; [key: string]: any };
const fixture = async (repeats = 2) => {
  const packets: Packet[] = [], control = { change: undefined as (() => void) | undefined,
    onPacket: undefined as ((round: number) => void) | undefined };
  const slot = { provider: 'openai' as const, model: 'fixture-chat', api_key: 'fixture-only', speed: 'fast' as const, supports_json: true };
  const dir = mkdtempSync(join(tmpdir(), 'chat-reuse-life-')); dirs.push(dir);
  const dbPath = join(dir, 'realm.sqlite'), runtimeConfig = createRuntimeConfigStore({});
  const storage = await composeStorageContext({ dbPath,
    bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
    runtimeConfig, vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 } });
  handles.push(storage.db); drains.push(() => storage.drainAuditWrites!());
  const lateBound = createExecutionLateBoundRefs();
  const app = composeAppContext({ db: storage.db, dbPath, envLlmConfig: { slot_1: slot },
    gateRegistry: storage.gateRegistry, auditLog: storage.auditLog, eventBus: storage.eventBus,
    serverInstanceId: storage.serverInstanceId, recipeStore: storage.recipeStore,
    pairedInstances: storage.pairedInstances, workEntityStore: storage.workEntityStoreRef, chatLateBound: lateBound });
  const complete = vi.spyOn(app.llmAdapterRegistry('openai'), 'complete').mockImplementation(async (_slot, messages) => {
    let packet: Packet | undefined;
    for (const message of messages) {
      try { const body = JSON.parse(message.content); if (body && typeof body === 'object' && ('user_request' in body || 'prior_tool_calls' in body)) packet = body; } catch { /* Not a chat packet. */ }
    }
    if (!packet) throw new Error('The scripted adapter received no chat packet');
    if ('tool_results_since' in packet) return { text: JSON.stringify({ intent: 'Read the selected asset', constraints: [], findings: [], pending: [], completed: [] }), usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
    packets.push(packet);
    if (packets.length === 1) control.change?.();
    control.onPacket?.(packets.length);
    const args = [...(packet.prior_tool_calls ?? [])].reverse().find(call => call.tool_name === 'work.read')?.args ?? { kind: 'asset', id: ASSET };
    const response = packets.length <= repeats ? { response: '', events: [], tool_calls: [{ tool: 'work.read', args }] }
      : { response: 'Done.', events: [], tool_calls: [] };
    return { text: JSON.stringify(response), usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
  });
  await unlockServerVault(app.keys!);
  app.llmManager!.setSlot1(slot);
  const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig,
    manifests: storage.manifests, baseVault: storage.baseVault, auditLog: storage.auditLog,
    cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus, contactStore: app.contactStoreRef,
    mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry, accountStore: storage.accountStore,
    eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
    workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef });
  const context = await composeExecutionContext({ storage, app, collection, baseVault: storage.baseVault,
    lateBound, env: { RECUED_SERVER_NAME: 'Chat reuse fixture' } });
  const peerDb = new Database(dbPath); handles.push(peerDb); peerDb.pragma('journal_mode = WAL');
  const peerStore = createContractStore(peerDb); peerStore.seedSchema(D165_CONTRACT_SCHEMA);
  const grants = createContractGrantEntryStore(app.contractStoreRef!);
  const peerGrants = createContractGrantEntryStore(peerStore);
  const work = storage.workEntityStoreRef!;
  work.writeAsset({ id: ASSET, name: MARKER, source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture-owner' },
    sphere: 'professional', attributes: { length: '25 meters' } });
  const audit = vi.spyOn(storage.auditLog!, 'logActivity');
  const reads = () => audit.mock.calls.filter(([entry]) => entry.action === 'chat_tool_call' && entry.target.endsWith(':work.read'));
  const chat = app.chatStoreRef!;
  chat.createSession({ id: 'reuse-session' }); chat.setRollingBriefEnabled(false);
  const run = async () => {
    const ack = await app.chatOrchestratorRef!.runTurn({ session_id: 'reuse-session', picker_state: { current: 'self' },
      model_pref: { current: 'byok', source_id: 'slot_1', model_hint: 'fast' },
      message: assetChatMessage('What length is saved?', { id: ASSET, name: MARKER, fileIds: [], omittedFiles: 0 }) });
    const answer = (await chat.listMessages('reuse-session')).find(row => row.role === 'assistant' && row.turn_id === ack.turn_id);
    expect(answer).toBeDefined(); expect(complete).toHaveBeenCalled();
    return answer!;
  };
  return { storage, app, context, work, grants, peerGrants, packets, control, reads, run };
};
afterEach(async () => {
  for (const drain of drains.splice(0)) await drain();
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('asset reuse through the composed owner chat', () => {
  it('keeps owner asset preparation out of a live bound gateway turn', async () => {
    const f = await fixture(0), definitions = f.context.contractDefinitionStore!;
    const contract = definitions.mint({ minted_by: 'owner', display_name: 'Bound chat reuse guard',
      scope: { channels: ['chat'] }, read_spheres: ['professional'] });
    f.grants.set(contract.contract_id, 'core.work-entity.read', true, Date.now());
    f.grants.set(contract.contract_id, 'data.asset', true, Date.now());
    expect(isContractActive(definitions.get(contract.contract_id)!, Date.now())).toBe(true);
    const resolve = vi.fn(() => { throw new Error('Owner asset preparation must not request dispatch authority in this bound turn'); });
    const result = await f.app.chatOrchestratorRef!.runLlmGatewayTurn!({
      session_id: 'bound-reuse-session', user_id: 'bound-reader', contract_id: contract.contract_id,
      content: { chat_tail: [], user_message: assetChatMessage('What length is saved?',
        { id: ASSET, name: MARKER, fileIds: [], omittedFiles: 0 }) },
      allowed_tool_names: ['work.read'], model_layer: 'byok', model_source_id: 'slot_1',
      execute_ai_call: async (_manifest, input) => {
        f.packets.push(JSON.parse(String(input['llm.prompt'])) as Packet);
        return { body: { response: 'Done.', events: [], tool_calls: [] } };
      },
      resolve_contract_snapshot: resolve,
    });
    expect(result.assistant_content).toBe('Done.'); expect(resolve).not.toHaveBeenCalled(); expect(f.packets).toHaveLength(1);
    expect(f.packets[0]!.prior_tool_calls ?? []).toHaveLength(0);
    expect(JSON.stringify(f.packets)).not.toContain('25 meters'); expect(f.reads()).toHaveLength(0);
  });

  it('revalidates unchanged native results without redispatching repeated reads', async () => {
    const f = await fixture(), answer = await f.run();
    expect(answer.content).toBe('Done.'); expect(f.packets).toHaveLength(3);
    expect(f.packets[0]!.prior_tool_calls).toHaveLength(1);
    expect(f.packets[0]!.prior_tool_calls![0]!.result.entity.attributes.length).toBe('25 meters');
    expect(f.reads()).toHaveLength(1);
  });

  it.each(['data.asset', 'core.work-entity.read'])('honors the owner %s withdrawal with unchanged asset data', async entry => {
    const f = await fixture(1);
    const before = f.work.readAsset(ASSET);
    f.control.change = () => f.peerGrants.set(OWNER_CONTRACT_ID, entry, false, Date.now());
    await f.run();
    expect(f.packets[0]!.prior_tool_calls![0]!.result.entity.attributes.length).toBe('25 meters');
    expect(f.work.readAsset(ASSET)).toEqual(before);
    expect(f.grants.get(OWNER_CONTRACT_ID, entry)).toBe(false);
    expect(f.reads()).toHaveLength(2);
    const last = f.packets.at(-1)!.prior_tool_calls!.at(-1)!;
    expect(last.result.entity).toBeNull(); expect(last.result.hint).toBeTruthy();
  });

  it('dispatches a fresh read when a native asset version changes', async () => {
    const f = await fixture(1);
    f.control.change = () => f.work.writeAsset({ id: ASSET, source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture-owner' }, attributes: { length: '31 meters' } });
    await f.run();
    expect(f.reads()).toHaveLength(2);
    expect(f.packets.at(-1)!.prior_tool_calls!.at(-1)!.result.entity.attributes.length).toBe('31 meters');
  });

  it('requires a fresh read after a withdrawn grant is restored', async () => {
    const f = await fixture(3);
    f.control.onPacket = round => {
      if (round === 1) f.peerGrants.set(OWNER_CONTRACT_ID, 'data.asset', false, Date.now());
      if (round === 2) f.peerGrants.set(OWNER_CONTRACT_ID, 'data.asset', true, Date.now());
    };
    await f.run();
    expect(f.packets).toHaveLength(4); expect(f.reads()).toHaveLength(3);
    expect(f.packets[1]!.prior_tool_calls!.at(-1)!.result.entity).toBeNull();
    expect(f.packets[2]!.prior_tool_calls!.at(-1)!.result.entity.attributes.length).toBe('25 meters');
    expect(f.grants.get(OWNER_CONTRACT_ID, 'data.asset')).toBe(true);
    expect(f.packets[3]!.prior_tool_calls).toHaveLength(3);
  });
});
