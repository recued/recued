/** D-342 ruling 11 — an AI app over MCP keeps a pursuit's Where I am, as the owner's chat does,
 *  when the app's contract grants the tool. The owner: "yes to allow mcp to update given if the
 *  tool is granted for that contract, so frontier AI like claude/codex can be primary and recued
 *  stays behind". D-343 ruling 16 (2026-11-06) widened it to every fact: a write the owner
 *  approves is theirs, at their rank, under the app's token.
 *
 *  Driven through the REAL MCP door (`handleToolCall`), its hold and the owner's approval
 *  (`createPreflightResumer`), with the REAL `work.update` handler, its check and the store. Only
 *  the tool registry (one entry, forwarding to the real handler) and the grant gate are doubles,
 *  and the gate is one predicate for the door's grant and the handler's, as the server wires it. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PURSUIT_CLASS_ID,
  RECUED_BUILTIN_SOURCE_ID,
  primitiveGrantEntry,
  type Asset,
  type ChatDispatchContext,
  type Checkpoint,
  type ExecutionSource,
  type InternalToolRegistry,
  type ToolEntry,
} from '@recued/contracts';
import type { PreflightNotifier } from '@recued/gateway';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry, type CheckpointStore } from '@recued/storage';
import { _testing } from '../mcp-server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';
import { createMcpActionStore, type McpActionRecord } from '../mcp-action-store.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { ASSET_UPDATE_OP_ID, buildChatTier1Handlers, checkWorkUpdate, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { assetTypes } from '../situations/asset-types.js';

const NOW = Date.parse('2026-11-06T18:00:00Z');
const DAY = 86_400_000;
const TOKEN = 'tok-owner-cli';
const UPDATE: ToolEntry = { name: 'work.update', tier: 1, description: 'work.update', arg_schema: { type: 'object' }, topic_tags: [],
  classification: 'write', concurrency_safe: false };

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

/** `granted` answers for both grants an app's change to an asset needs: the door's
 *  (`primitive.work.update`) and the write's (`core.work-entity.asset.update`). */
const harness = (granted: (op: string) => boolean = () => true) => {
  const db = new Database(':memory:'); dbs.push(db);
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const dispatchers = createWorkEntityDispatchers({ store, resolver: createWorkEntityResolver(store), now: () => NOW, assetTypes: assetTypes(db) });
  const gate = { isFrozenByPause: () => false, isOpGranted: (_source: ExecutionSource, op?: string) => op === undefined || granted(op) };
  const chatDeps = { getWorkEntityCrudDeps: () => ({ store, resolver: createWorkEntityResolver(store), dispatchers }),
    getOpAdmissionGate: () => gate, getAssetTypes: () => assetTypes(db), now: () => NOW } as unknown as ChatToolHandlerDeps;
  const update = buildChatTier1Handlers(chatDeps)['work.update']!;
  const registry: InternalToolRegistry = {
    list: () => [UPDATE], listByTier: (tier) => (tier === 1 ? [UPDATE] : []), getByName: (name) => (name === UPDATE.name ? UPDATE : null),
    dispatch: async (_name, args, ctx) => update(args, ctx),
    checkBeforeAsking: async (_name, args, ctx) => checkWorkUpdate(chatDeps, args, ctx as ChatDispatchContext),
    subscribeRefresh: () => () => undefined,
  };
  const checkpoints = new Map<string, Checkpoint>();
  const checkpointStore = {
    write: async (cp: Checkpoint) => { checkpoints.set(cp.checkpoint_id, cp); },
    get: async (id: string) => checkpoints.get(id) ?? null,
    delete: async (id: string) => { checkpoints.delete(id); },
    listByRun: async (run_id: string) => [...checkpoints.values()].filter((c) => c.run_id === run_id),
    list: async () => [...checkpoints.values()],
    size: async () => checkpoints.size,
  } as unknown as CheckpointStore;
  const asks: Array<{ title: string; text: string }> = [];
  const preflightNotifier = {
    ask: async (message: { title: string; text: string }) => { asks.push(message); return { ask_id: `ask-${asks.length}` }; },
    notify: async () => undefined,
    registerAskHandler: () => {},
  } as unknown as PreflightNotifier;
  const gatedActionStore = createGatedActionStore(createInMemoryCollection<GatedActionRecord>());
  const mcpActionStore = createMcpActionStore(createInMemoryCollection<McpActionRecord>());
  let seq = 0;
  const deps = {
    recipeStore: createRecipeStore('/nonexistent'), executorConfig: { manifests: createManifestRegistry('/nonexistent') }, baseVault: {},
    internalRegistry: registry, tier1Registry: () => registry, ownerAdmitAll: true, mcpTokenId: TOKEN,
    checkpointStore, preflightNotifier, gatedActionStore, mcpActionStore,
    approvalResumeAuthority: { resolve: ({ execution_source }: { execution_source: ExecutionSource }) => ({ admitted: true, execution_source }) },
    opAdmissionGate: gate, newId: () => `id-${(seq += 1)}`, now: () => NOW, approvalAskChannels: async () => ['ui'],
  };
  const resumer = createPreflightResumer({
    auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
    gatedActionStore, mcpActionStore, getExecuteDeps: () => deps as unknown as ExecuteHandlerDeps,
  });
  const call = (args: Record<string, unknown>) =>
    _testing.handleToolCall({ name: 'work.update', arguments: args } as never, deps as unknown as Parameters<typeof _testing.handleToolCall>[1]) as Promise<{
      structuredContent?: Record<string, unknown>; isError?: boolean; content: Array<{ text: string }>;
    }>;
  // A pursuit as the owner keeps it in Yours: every fact at their own rank.
  const spanish: Asset = store.writeAsset({ source_id: RECUED_BUILTIN_SOURCE_ID('asset'), source: { kind: 'owner', ref: 'owner:user-1' },
    name: 'Learn Spanish', class_id: PURSUIT_CLASS_ID, dates: { target_on: '2026-12-31' },
    attributes: { horizon: 'ongoing', why: 'To talk with Ana’s family', where_i_am: 'Finished unit 4' } }, NOW - DAY);
  return { store, spanish, checkpoints, asks, resumer, call };
};
const finishedUnit5 = (id: string) => ({ kind: 'asset', id, attributes: { where_i_am: 'Finished unit 5' } });

describe('D-342 ruling 11 — an AI app keeps a pursuit’s Where I am when its contract grants the tool', () => {
  it('puts the change to the owner, and their yes keeps it, the app as its source', async () => {
    const f = harness();
    const held = await f.call(finishedUnit5(f.spanish.id));
    expect(held.structuredContent).toMatchObject({ status: 'awaiting_approval', tool: 'work.update' });
    expect(f.asks.map((ask) => ask.title)).toEqual(['Approve: Change a thing you own']);
    // Nothing changes until the owner answers.
    expect(f.store.readAsset(f.spanish.id)).toEqual(f.spanish);
    await f.resumer.resumeRun([...f.checkpoints.values()][0]!, {});
    const after = f.store.readAsset(f.spanish.id)!;
    expect(after.attributes).toEqual({ horizon: 'ongoing', why: 'To talk with Ana’s family', where_i_am: 'Finished unit 5' });
    expect(after.field_sources['attributes.where_i_am']).toMatchObject({ kind: 'owner', ref: `mcp:${TOKEN}` });
    expect(after.field_sources['attributes.why']).toEqual(f.spanish.field_sources['attributes.why']);
  });
  it('refuses at the door when the contract does not grant the tool, and asks nobody', async () => {
    const f = harness((op) => op !== primitiveGrantEntry('work.update'));
    const refused = await f.call(finishedUnit5(f.spanish.id));
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("Tool 'work.update' is not available for this contract.");
    expect(f.checkpoints.size).toBe(0);
    expect(f.asks).toEqual([]);
    expect(f.store.readAsset(f.spanish.id)).toEqual(f.spanish);
  });
  it('refuses before asking when the contract grants the tool but not the change to an asset', async () => {
    const f = harness((op) => op !== ASSET_UPDATE_OP_ID);
    const refused = await f.call(finishedUnit5(f.spanish.id));
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("'work.update' is not available for this contract.");
    expect(f.checkpoints.size).toBe(0);
    expect(f.asks).toEqual([]);
    expect(f.store.readAsset(f.spanish.id)).toEqual(f.spanish);
  });
  it('puts the owner’s other facts to them too, and their yes changes each (D-343 ruling 16): why, horizon and target date', async () => {
    const f = harness();
    for (const change of [{ attributes: { why: 'For work' } }, { attributes: { horizon: 'by summer 2027' } }, { dates: { target_on: '2027-06-30' } }]) {
      const held = await f.call({ kind: 'asset', id: f.spanish.id, ...change });
      expect(held.structuredContent, JSON.stringify(change)).toMatchObject({ status: 'awaiting_approval', tool: 'work.update' });
    }
    expect(f.asks.map((ask) => ask.title)).toEqual(Array(3).fill('Approve: Change a thing you own'));
    expect(f.store.readAsset(f.spanish.id)).toEqual(f.spanish);
    for (const checkpoint of [...f.checkpoints.values()]) await f.resumer.resumeRun(checkpoint, {});
    const after = f.store.readAsset(f.spanish.id)!;
    expect(after).toMatchObject({ dates: { target_on: '2027-06-30' }, attributes: { why: 'For work', horizon: 'by summer 2027' } });
    for (const path of ['attributes.why', 'attributes.horizon', 'dates.target_on'])
      expect(after.field_sources[path], path).toMatchObject({ kind: 'owner', ref: `mcp:${TOKEN}` });
  });
});
